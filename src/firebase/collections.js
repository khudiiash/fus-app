import {
  collection, doc, getDoc, getDocs, setDoc, updateDoc, addDoc,
  deleteDoc, query, where, orderBy, limit, onSnapshot,
  serverTimestamp, increment, arrayUnion, arrayRemove,
  runTransaction, writeBatch, Timestamp, startAfter,
} from 'firebase/firestore'
import { ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage'
import app, { db, storage } from './config'
import { getFunctions, httpsCallable } from 'firebase/functions'
import {
  buildEligibleLootPool,
  rollMysteryBox,
  canGrantShopItemFromBox,
} from '@/game/mysteryBoxRng'

// ─── Collection refs ──────────────────────────────────────────────────────────
export const usersCol    = () => collection(db, 'users')
export const classesCol  = () => collection(db, 'classes')
export const itemsCol    = () => collection(db, 'items')
export const codesCol    = () => collection(db, 'accessCodes')
export const tradesCol   = () => collection(db, 'tradeOffers')
export const txCol       = () => collection(db, 'transactions')
export const achievementsCol = () => collection(db, 'achievements')
export const subjectsCol     = () => collection(db, 'subjects')

// ─── User helpers ─────────────────────────────────────────────────────────────
export async function getUser(uid) {
  const snap = await getDoc(doc(db, 'users', uid))
  return snap.exists() ? { id: snap.id, ...snap.data() } : null
}

const FUNCTIONS_REGION = import.meta.env.VITE_FUNCTIONS_REGION || 'europe-west1'

/** Store FCM token for the signed-in user only; removes the same token from other user docs (shared browser). */
export async function saveUserFcmToken(uid, token) {
  if (!uid || !token) return
  const functions = getFunctions(app, FUNCTIONS_REGION)
  const call = httpsCallable(functions, 'claimFcmToken')
  await call({ token })
}

/** Correct the stored level if it doesn't match the XP. Call on login for existing profiles. */
export async function syncLevel(uid, currentXp, currentLevel) {
  const correct = calcLevel(currentXp || 0)
  if (correct !== (currentLevel || 1)) {
    await updateDoc(doc(db, 'users', uid), { level: correct })
  }
}

export async function updateUser(uid, data) {
  await updateDoc(doc(db, 'users', uid), data)
}

export function watchUser(uid, cb) {
  return onSnapshot(doc(db, 'users', uid), snap => {
    if (snap.exists()) cb({ id: snap.id, ...snap.data() })
  })
}

export async function getUsersByClass(classId) {
  const q = query(usersCol(), where('classId', '==', classId), where('role', '==', 'student'))
  const snap = await getDocs(q)
  return snap.docs.map(d => ({ id: d.id, ...d.data() }))
}

export async function getAllStudents() {
  const q = query(usersCol(), where('role', '==', 'student'), orderBy('coins', 'desc'))
  const snap = await getDocs(q)
  return snap.docs.map(d => ({ id: d.id, ...d.data() }))
}

export async function getAllTeachers() {
  const q = query(usersCol(), where('role', '==', 'teacher'))
  const snap = await getDocs(q)
  return snap.docs.map(d => ({ id: d.id, ...d.data() }))
}

// ─── Access code helpers ──────────────────────────────────────────────────────
export async function getCodeData(code) {
  const snap = await getDoc(doc(db, 'accessCodes', code.toUpperCase()))
  return snap.exists() ? snap.data() : null
}

export async function createAccessCode(code, data) {
  await setDoc(doc(db, 'accessCodes', code.toUpperCase()), {
    ...data,
    createdAt: serverTimestamp(),
    isActive: true,
  })
}

export async function deleteAccessCode(code) {
  await deleteDoc(doc(db, 'accessCodes', code.toUpperCase()))
}

export async function getAllCodes() {
  const snap = await getDocs(codesCol())
  return snap.docs.map(d => ({ code: d.id, ...d.data() }))
}

// ─── Class helpers ────────────────────────────────────────────────────────────
export async function getClass(classId) {
  const snap = await getDoc(doc(db, 'classes', classId))
  return snap.exists() ? { id: snap.id, ...snap.data() } : null
}

export async function getAllClasses() {
  const snap = await getDocs(classesCol())
  return snap.docs.map(d => ({ id: d.id, ...d.data() }))
}

export async function createClass(data) {
  const ref = await addDoc(classesCol(), { ...data, createdAt: serverTimestamp(), studentIds: [], teacherIds: [] })
  return ref.id
}

export async function updateClass(classId, data) {
  await updateDoc(doc(db, 'classes', classId), data)
}

/**
 * Admin: предмети та класи вчителя + синхронізація teacherIds у документах класів.
 */
export async function adminUpdateTeacherAssignments(
  teacherId,
  { subjectIds, classIds },
  previousClassIds = [],
) {
  const prev = [...(previousClassIds || [])].filter(Boolean)
  const next = [...(classIds || [])].filter(Boolean)
  const toRemove = prev.filter((id) => !next.includes(id))
  const toAdd = next.filter((id) => !prev.includes(id))

  const batch = writeBatch(db)
  batch.update(doc(db, 'users', teacherId), {
    subjectIds: subjectIds || [],
    classIds: next,
  })
  for (const cid of toRemove) {
    batch.update(doc(db, 'classes', cid), { teacherIds: arrayRemove(teacherId) })
  }
  for (const cid of toAdd) {
    batch.update(doc(db, 'classes', cid), { teacherIds: arrayUnion(teacherId) })
  }
  await batch.commit()
}

/**
 * Admin: ім'я та клас учня + studentIds у класах і запис у accessCodes.
 */
export async function adminUpdateStudentProfile(
  studentId,
  { displayName, classId },
  { previousClassId, accessCode },
) {
  const name = String(displayName || '').trim()
  if (!name) throw new Error('Введіть імʼя')

  const prev = previousClassId || null
  const next = classId || null

  const batch = writeBatch(db)
  const userUpdates = { displayName: name }
  if (prev !== next) userUpdates.classId = next || null
  batch.update(doc(db, 'users', studentId), userUpdates)

  if (prev && prev !== next) {
    batch.update(doc(db, 'classes', prev), { studentIds: arrayRemove(studentId) })
  }
  if (next && next !== prev) {
    batch.update(doc(db, 'classes', next), { studentIds: arrayUnion(studentId) })
  }

  if (accessCode) {
    const codeUpdates = { displayName: name }
    if (prev !== next) codeUpdates.classId = next || null
    batch.update(doc(db, 'accessCodes', accessCode.toUpperCase()), codeUpdates)
  }

  await batch.commit()
}

// ─── Subject helpers ───────────────────────────────────────────────────────────
export async function getAllSubjects() {
  const snap = await getDocs(subjectsCol())
  return snap.docs.map(d => ({ id: d.id, ...d.data() }))
}

export async function createSubject(data) {
  const ref = await addDoc(subjectsCol(), { ...data, createdAt: serverTimestamp() })
  return ref.id
}

export async function updateSubject(subjectId, data) {
  await updateDoc(doc(db, 'subjects', subjectId), data)
}

export async function deleteSubject(subjectId) {
  await deleteDoc(doc(db, 'subjects', subjectId))
}

export async function deleteClass(classId) {
  await deleteDoc(doc(db, 'classes', classId))
}

export function watchClass(classId, cb) {
  return onSnapshot(doc(db, 'classes', classId), snap => {
    if (snap.exists()) cb({ id: snap.id, ...snap.data() })
  })
}

// ─── Item/shop helpers ────────────────────────────────────────────────────────

/** Returns ALL items including archived (active:false). Used for inventory resolution. */
export async function getAllItems() {
  const snap = await getDocs(itemsCol())
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }))
}

/** Returns only active (non-archived) items for the shop display. */
export async function getActiveItems() {
  const snap = await getDocs(itemsCol())
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((item) => item.active !== false)
}

export async function createItem(data) {
  const ref = await addDoc(itemsCol(), { ...data, active: true, createdAt: serverTimestamp() })
  return ref.id
}

export async function updateItem(itemId, data) {
  await updateDoc(doc(db, 'items', itemId), data)
}

/** Soft-delete: hides item from shop but keeps document so owned items keep working. */
export async function archiveItem(itemId) {
  await updateDoc(doc(db, 'items', itemId), { active: false, archivedAt: serverTimestamp() })
}

export async function restoreItem(itemId) {
  await updateDoc(doc(db, 'items', itemId), { active: true, archivedAt: null })
}

/** Hard-delete (admin only, use with care — breaks owned-item resolution). */
export async function deleteItem(itemId) {
  await deleteDoc(doc(db, 'items', itemId))
}

/** Max writes per Firestore batch (stay under 500). */
const SHOP_ITEMS_DELETE_CHUNK = 400

/**
 * Hard-delete every document in `items`. Admin-only.
 * Does not delete files in Firebase Storage — re-import uploads new objects / URLs.
 * Student profiles may still list old item IDs in inventory until you clean or they trade.
 */
export async function deleteAllShopItems() {
  const snap = await getDocs(itemsCol())
  if (snap.empty) return { deleted: 0 }
  const docs = snap.docs
  for (let i = 0; i < docs.length; i += SHOP_ITEMS_DELETE_CHUNK) {
    const batch = writeBatch(db)
    for (const d of docs.slice(i, i + SHOP_ITEMS_DELETE_CHUNK)) {
      batch.delete(doc(db, 'items', d.id))
    }
    await batch.commit()
  }
  return { deleted: docs.length }
}

// ─── Trade helpers ────────────────────────────────────────────────────────────
export async function createTrade(data) {
  const ref = await addDoc(tradesCol(), {
    ...data,
    status: 'pending',
    createdAt: serverTimestamp(),
    expiresAt: Timestamp.fromMillis(Date.now() + 48 * 60 * 60 * 1000),
  })
  return ref.id
}

export function watchIncomingTrades(uid, cb) {
  const q = query(tradesCol(), where('toUid', '==', uid), where('status', '==', 'pending'))
  return onSnapshot(q, snap => cb(snap.docs.map(d => ({ id: d.id, ...d.data() }))))
}

export function watchOutgoingTrades(uid, cb) {
  const q = query(tradesCol(), where('fromUid', '==', uid), where('status', '==', 'pending'))
  return onSnapshot(q, snap => cb(snap.docs.map(d => ({ id: d.id, ...d.data() }))))
}

/** Прийняті / відхилені, де ти одержувач (потрібен складний індекс toUid+status+createdAt). */
export function watchIncomingTradeHistory(uid, cb) {
  const q = query(
    tradesCol(),
    where('toUid', '==', uid),
    where('status', 'in', ['accepted', 'declined']),
    orderBy('createdAt', 'desc'),
    limit(50),
  )
  return onSnapshot(
    q,
    snap => cb(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
    err => console.warn('[watchIncomingTradeHistory]', err?.message),
  )
}

/** Прийняті / відхилені, де ти відправник. */
export function watchOutgoingTradeHistory(uid, cb) {
  const q = query(
    tradesCol(),
    where('fromUid', '==', uid),
    where('status', 'in', ['accepted', 'declined']),
    orderBy('createdAt', 'desc'),
    limit(50),
  )
  return onSnapshot(
    q,
    snap => cb(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
    err => console.warn('[watchOutgoingTradeHistory]', err?.message),
  )
}

export async function getTrade(tradeId) {
  const snap = await getDoc(doc(db, 'tradeOffers', tradeId))
  return snap.exists() ? { id: snap.id, ...snap.data() } : null
}

export async function updateTrade(tradeId, data) {
  await updateDoc(doc(db, 'tradeOffers', tradeId), data)
}

// ─── Transaction helpers ──────────────────────────────────────────────────────
const TX_LIMIT = 100

/** Keep only the latest TX_LIMIT transactions per recipient. Fire-and-forget. */
async function pruneTransactions(uid) {
  try {
    // Reuse the existing (toUid, timestamp DESC) composite index
    const topSnap = await getDocs(
      query(txCol(), where('toUid', '==', uid), orderBy('timestamp', 'desc'), limit(TX_LIMIT))
    )
    if (topSnap.docs.length < TX_LIMIT) return // not yet at the limit

    const cursor  = topSnap.docs[TX_LIMIT - 1] // 100th doc — oldest we keep
    const oldSnap = await getDocs(
      query(txCol(), where('toUid', '==', uid), orderBy('timestamp', 'desc'), startAfter(cursor))
    )
    if (oldSnap.empty) return

    const batch = writeBatch(db)
    oldSnap.docs.forEach(d => batch.delete(d.ref))
    await batch.commit()
  } catch { /* non-critical, swallow */ }
}

export async function logTransaction(data) {
  await addDoc(txCol(), { ...data, timestamp: serverTimestamp() })
  if (data.toUid) pruneTransactions(data.toUid) // async, no await intentional
}

export async function getTransactionHistory(uid, limitCount = 20) {
  const q = query(
    txCol(),
    where('toUid', '==', uid),
    orderBy('timestamp', 'desc'),
    limit(limitCount),
  )
  const snap = await getDocs(q)
  return snap.docs.map(d => ({ id: d.id, ...d.data() }))
}

export async function getAwardHistory(fromUid, limitCount = 50) {
  const q = query(
    txCol(),
    where('fromUid', '==', fromUid),
    where('type', '==', 'award'),
    orderBy('timestamp', 'desc'),
    limit(limitCount),
  )
  const snap = await getDocs(q)
  return snap.docs.map(d => ({ id: d.id, ...d.data() }))
}

// ─── Achievement helpers ──────────────────────────────────────────────────────
export async function getAllAchievements() {
  const snap = await getDocs(achievementsCol())
  return snap.docs.map(d => ({ id: d.id, ...d.data() }))
}

export async function createAchievement(data) {
  const ref = await addDoc(achievementsCol(), data)
  return ref.id
}

// ─── Teacher daily coin budget ────────────────────────────────────────────────
export const DEFAULT_DAILY_BUDGET = 200
/** @deprecated Alias — imports still work; value matches daily cap. */
export const DEFAULT_WEEKLY_BUDGET = DEFAULT_DAILY_BUDGET

/** Local calendar date YYYY-MM-DD (browser timezone). */
export function getCurrentBudgetDayDate() {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Returns { budget, used, remaining } for any teacher profile snapshot. */
export function getTeacherBudgetInfo(teacherData) {
  const today  = getCurrentBudgetDayDate()
  const budget = teacherData?.coinsBudgetDaily ?? teacherData?.coinsBudgetWeekly ?? DEFAULT_DAILY_BUDGET
  const used   = teacherData?.budgetDayStart === today ? (teacherData.coinsUsedToday || 0) : 0
  return { budget, used, remaining: Math.max(0, budget - used) }
}

export async function setTeacherDailyBudget(teacherUid, amount) {
  await updateDoc(doc(db, 'users', teacherUid), { coinsBudgetDaily: Number(amount) })
}

/** @deprecated Use setTeacherDailyBudget — still updates coinsBudgetDaily. */
export async function setTeacherWeeklyBudget(teacherUid, amount) {
  return setTeacherDailyBudget(teacherUid, amount)
}

// ─── Award coins (transactional) ──────────────────────────────────────────────
export async function awardCoins({ fromUid, toUid, amount, note = '', subjectName = '' }) {
  const today = getCurrentBudgetDayDate()

  await runTransaction(db, async tx => {
    const toRef   = doc(db, 'users', toUid)
    const fromRef = doc(db, 'users', fromUid)
    const [toSnap, fromSnap] = await Promise.all([tx.get(toRef), tx.get(fromRef)])

    if (!toSnap.exists()) throw new Error('Student not found')

    // Enforce daily budget for teachers
    if (fromSnap.exists() && fromSnap.data().role === 'teacher') {
      const t      = fromSnap.data()
      const used   = t.budgetDayStart === today ? (t.coinsUsedToday || 0) : 0
      const budget = t.coinsBudgetDaily ?? t.coinsBudgetWeekly ?? DEFAULT_DAILY_BUDGET
      if (used + amount > budget) {
        throw new Error(`Недостатньо денного бюджету. Залишок: ${budget - used} 🪙`)
      }
      tx.update(fromRef, { coinsUsedToday: used + amount, budgetDayStart: today })
    }

    const current  = toSnap.data()
    const newCoins = (current.coins || 0) + amount
    const xpGain   = Math.ceil(amount * 1.5)
    const newXp    = (current.xp || 0) + xpGain
    tx.update(toRef, { coins: newCoins, xp: newXp, level: calcLevel(newXp) })
  })

  const noteTrim = typeof note === 'string' ? note.trim() : ''
  const subTrim = typeof subjectName === 'string' ? subjectName.trim() : ''
  await logTransaction({
    type: 'award',
    fromUid,
    toUid,
    amount,
    note: noteTrim,
    ...(subTrim ? { subjectName: subTrim } : {}),
  })

  // Daily quest: отримати монети від вчителя (або адміна)
  if (toUid !== fromUid && amount > 0) {
    const fromSnap = await getDoc(doc(db, 'users', fromUid))
    const role = fromSnap.exists() ? fromSnap.data().role : null
    if (role === 'teacher' || role === 'admin') {
      await updateQuestProgress(toUid, 'receive', 1)
    }
  }
}

// ─── Purchase item (transactional) ───────────────────────────────────────────
export async function purchaseItem({ uid, itemId, price }) {
  await runTransaction(db, async tx => {
    const uRef = doc(db, 'users', uid)
    const iRef = doc(db, 'items', itemId)
    const [uSnap, iSnap] = await Promise.all([tx.get(uRef), tx.get(iRef)])
    if (!uSnap.exists()) throw new Error('User not found')
    if (!iSnap.exists()) throw new Error('Item not found')

    const user = uSnap.data()
    const item = iSnap.data()

    if (item.active === false) throw new Error('Item is no longer available')
    if ((user.coins || 0) < price) throw new Error('Not enough coins')

    // Магічна коробка: стек у mysteryBoxCounts, не в inventory
    if (item.category === 'mystery_box') {
      const hasStock = item.stock !== null && item.stock !== undefined
      if (hasStock && item.stock <= 0) throw new Error('Sold out')

      const counts = { ...(user.mysteryBoxCounts || {}) }
      counts[itemId] = (counts[itemId] || 0) + 1

      const newXp = (user.xp || 0) + Math.ceil(price * 0.5)
      tx.update(uRef, {
        coins: increment(-price),
        mysteryBoxCounts: counts,
        xp: newXp,
        level: calcLevel(newXp),
      })
      if (hasStock) {
        tx.update(iRef, { stock: increment(-1) })
      }
      return
    }

    // Кілька однакових предметів: inventory + inventoryCounts (стек)
    const inv = user.inventory || []
    const counts = { ...(user.inventoryCounts || {}) }
    const newXp = (user.xp || 0) + Math.ceil(price * 0.5)
    const lvl = calcLevel(newXp)

    // Stock check & decrement (stock: null / undefined = unlimited)
    const hasStock = item.stock !== null && item.stock !== undefined
    if (hasStock && item.stock <= 0) throw new Error('Sold out')

    if (inv.includes(itemId)) {
      counts[itemId] = (counts[itemId] || 1) + 1
      tx.update(uRef, {
        coins: increment(-price),
        inventoryCounts: counts,
        xp: newXp,
        level: lvl,
      })
    } else {
      tx.update(uRef, {
        coins: increment(-price),
        inventory: arrayUnion(itemId),
        inventoryCounts: { ...counts, [itemId]: 1 },
        xp: newXp,
        level: lvl,
      })
    }
    if (hasStock) {
      tx.update(iRef, { stock: increment(-1) })
    }
  })

  await logTransaction({ type: 'purchase', fromUid: uid, toUid: uid, amount: -price, itemIds: [itemId] })

  const spent = Number(price) || 0
  if (spent > 0) await updateQuestProgress(uid, 'spend', spent)
}

/** Зняти один екземпляр предмета з інвентарю (з урахуванням inventoryCounts). */
function consumeOneFromInventory(inv, counts, itemId) {
  const inventory = [...(inv || [])]
  const cMap = { ...(counts || {}) }
  if (!inventory.includes(itemId)) return null
  const n = cMap[itemId]
  const qty = n == null || n === 0 ? 1 : n
  if (qty > 1) {
    return { inventory, inventoryCounts: { ...cMap, [itemId]: qty - 1 } }
  }
  const nextC = { ...cMap }
  delete nextC[itemId]
  return { inventory: inventory.filter((x) => x !== itemId), inventoryCounts: nextC }
}

/** Додати один екземпляр предмета (стек у inventoryCounts, якщо id уже в inventory). */
function grantOneToInventory(inv, counts, itemId) {
  const inventory = [...(inv || [])]
  const cMap = { ...(counts || {}) }
  if (inventory.includes(itemId)) {
    const prev = cMap[itemId] || 1
    return { inventory, inventoryCounts: { ...cMap, [itemId]: prev + 1 } }
  }
  return { inventory: [...inventory, itemId], inventoryCounts: { ...cMap, [itemId]: 1 } }
}

/**
 * Відкрити магічну коробку: монети + 0–2 предмети з магазину за правилами rarity/price cap.
 * @returns {Promise<{ coins: number, itemIds: string[] }>}
 */
export async function openMysteryBox(uid, boxItemId) {
  const itemsSnap = await getDocs(itemsCol())
  const allItems = itemsSnap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((it) => it.active !== false)

  let result = { coins: 0, itemIds: [] }
  let boxLogName = ''
  let boxRarityForLog = 'common'

  await runTransaction(db, async (tx) => {
    const uRef = doc(db, 'users', uid)
    const bRef = doc(db, 'items', boxItemId)
    const [uSnap, bSnap] = await Promise.all([tx.get(uRef), tx.get(bRef)])
    if (!uSnap.exists()) throw new Error('Користувача не знайдено')
    if (!bSnap.exists()) throw new Error('Коробку не знайдено')

    const u = uSnap.data()
    const boxItem = { id: bSnap.id, ...bSnap.data() }
    if (boxItem.category !== 'mystery_box') throw new Error('Це не магічна коробка')
    boxLogName = boxItem.name || boxItemId
    boxRarityForLog = boxItem.rarity || 'common'

    const counts = { ...(u.mysteryBoxCounts || {}) }
    if ((counts[boxItemId] || 0) < 1) throw new Error('У вас немає цієї коробки')

    const inv = new Set(u.inventory || [])
    const pool = buildEligibleLootPool(allItems, inv, boxItem.rarity, boxItem.price)
    const outcome = rollMysteryBox(boxItem, pool)

    counts[boxItemId] = (counts[boxItemId] || 0) - 1
    if (counts[boxItemId] <= 0) delete counts[boxItemId]

    const granted = []
    for (const rid of outcome.itemIds) {
      if (inv.has(rid)) continue
      const iRef = doc(db, 'items', rid)
      const iSnap = await tx.get(iRef)
      if (!iSnap.exists()) continue
      const it = { id: iSnap.id, ...iSnap.data() }
      if (!canGrantShopItemFromBox(it, inv, boxItem.rarity, boxItem.price)) continue

      granted.push(rid)
      inv.add(rid)

      const hasStock = it.stock !== null && it.stock !== undefined
      if (hasStock) {
        tx.update(iRef, { stock: increment(-1) })
      }
    }

    const xpGain = Math.ceil(outcome.coins * 0.12) + granted.length * 6
    const newXp = (u.xp || 0) + xpGain
    const patch = {
      mysteryBoxCounts: counts,
      coins: increment(outcome.coins),
      xp: newXp,
      level: calcLevel(newXp),
    }
    if (granted.length) {
      patch.inventory = arrayUnion(...granted)
    }
    tx.update(uRef, patch)

    result = { coins: outcome.coins, itemIds: granted }
  })

  await logTransaction({
    type: 'box_open',
    fromUid: uid,
    toUid: uid,
    amount: result.coins,
    itemIds: result.itemIds,
    note: boxLogName,
    /** So journal can show box art + rarity when loot is coins-only or alongside items */
    boxItemId: boxItemId,
    boxRarity: boxRarityForLog,
  })

  return result
}

// ─── Fine student (transactional) ────────────────────────────────────────────
export async function fineStudent({ fromUid, toUid, amount, reason = '' }) {
  const today = getCurrentBudgetDayDate()

  await runTransaction(db, async tx => {
    const uRef = doc(db, 'users', toUid)
    const tRef = doc(db, 'users', fromUid)
    const [uSnap, tSnap] = await Promise.all([tx.get(uRef), tx.get(tRef)])

    if (!uSnap.exists()) throw new Error('Учня не знайдено')

    const student   = uSnap.data()
    const deduction = Math.min(amount, student.coins || 0)

    tx.update(uRef, { coins: increment(-deduction) })

    // Return the deducted coins to the teacher's daily spent budget
    if (tSnap.exists() && tSnap.data().role === 'teacher') {
      const teacher = tSnap.data()
      if (teacher.budgetDayStart === today) {
        const newUsed = Math.max(0, (teacher.coinsUsedToday || 0) - deduction)
        tx.update(tRef, { coinsUsedToday: newUsed })
      }
    }
  })

  await logTransaction({ type: 'fine', fromUid, toUid, amount: -amount, note: reason })
}

/** Unequip room/pet/accessory/skin that are no longer owned after a trade. */
function avatarAfterLosingTradedItems(avatar, lostItemIds, itemMeta) {
  const next = { ...(avatar || {}) }
  const lost = new Set(lostItemIds || [])

  if (next.roomId && lost.has(next.roomId)) next.roomId = null
  if (next.petId && lost.has(next.petId)) next.petId = null
  const prevAcc = next.accessories || []
  next.accessories = prevAcc.filter((id) => !lost.has(id))

  for (const rid of lost) {
    const item = itemMeta[rid]
    if (!item || item.category !== 'skin') continue
    const skinMatch =
      (next.skinUrl && item.skinUrl && next.skinUrl === item.skinUrl)
      || (!(next.skinUrl || item.skinUrl)
        && (next.skinId || 'default') === (item.skinId || 'default'))
    if (skinMatch) {
      next.skinId = 'default'
      next.skinUrl = null
      break
    }
  }
  return next
}

function avatarEquipVisualEquals(a, b) {
  a = a || {}
  b = b || {}
  return (
    (a.roomId ?? null) === (b.roomId ?? null)
    && (a.petId ?? null) === (b.petId ?? null)
    && JSON.stringify(a.accessories || []) === JSON.stringify(b.accessories || [])
    && (a.skinId || 'default') === (b.skinId || 'default')
    && (a.skinUrl ?? null) === (b.skinUrl ?? null)
  )
}

// ─── Execute trade (transactional) ───────────────────────────────────────────
export async function executeTrade(tradeId) {
  const tradeSnap = await getDoc(doc(db, 'tradeOffers', tradeId))
  if (!tradeSnap.exists()) throw new Error('Trade not found')
  const trade = tradeSnap.data()

  await runTransaction(db, async tx => {
    const fromRef = doc(db, 'users', trade.fromUid)
    const toRef   = doc(db, 'users', trade.toUid)
    const [fromSnap, toSnap] = await Promise.all([tx.get(fromRef), tx.get(toRef)])
    const from = fromSnap.data()
    const to   = toSnap.data()

    if ((from.coins || 0) < (trade.offeredCoins || 0)) throw new Error('Sender lacks coins')
    if ((to.coins   || 0) < (trade.requestedCoins || 0)) throw new Error('Receiver lacks coins')

    const tradeItemIds = [...new Set([...(trade.offeredItems || []), ...(trade.requestedItems || [])])]
    const itemMeta = {}
    for (const iid of tradeItemIds) {
      const isnap = await tx.get(doc(db, 'items', iid))
      if (isnap.exists()) itemMeta[iid] = { id: isnap.id, ...isnap.data() }
    }

    let fromInv = from.inventory || []
    let fromCounts = { ...(from.inventoryCounts || {}) }
    let toInv = to.inventory || []
    let toCounts = { ...(to.inventoryCounts || {}) }

    for (const itemId of trade.offeredItems || []) {
      const r = consumeOneFromInventory(fromInv, fromCounts, itemId)
      if (!r) throw new Error('Sender does not own item')
      fromInv = r.inventory
      fromCounts = r.inventoryCounts
    }
    for (const itemId of trade.requestedItems || []) {
      const r = consumeOneFromInventory(toInv, toCounts, itemId)
      if (!r) throw new Error('Receiver does not own item')
      toInv = r.inventory
      toCounts = r.inventoryCounts
    }

    for (const itemId of trade.requestedItems || []) {
      const r = grantOneToInventory(fromInv, fromCounts, itemId)
      fromInv = r.inventory
      fromCounts = r.inventoryCounts
    }
    for (const itemId of trade.offeredItems || []) {
      const r = grantOneToInventory(toInv, toCounts, itemId)
      toInv = r.inventory
      toCounts = r.inventoryCounts
    }

    const fromNewXp = (from.xp || 0) + 50
    const toNewXp   = (to.xp   || 0) + 50

    const fromAvatarNext = avatarAfterLosingTradedItems(from.avatar, trade.offeredItems || [], itemMeta)
    const toAvatarNext = avatarAfterLosingTradedItems(to.avatar, trade.requestedItems || [], itemMeta)

    const fromPatch = {
      coins: increment(-(trade.offeredCoins || 0) + (trade.requestedCoins || 0)),
      inventory: fromInv,
      inventoryCounts: fromCounts,
      xp: fromNewXp,
      level: calcLevel(fromNewXp),
    }
    if (!avatarEquipVisualEquals(from.avatar, fromAvatarNext)) {
      fromPatch.avatar = fromAvatarNext
    }

    const toPatch = {
      coins: increment(-(trade.requestedCoins || 0) + (trade.offeredCoins || 0)),
      inventory: toInv,
      inventoryCounts: toCounts,
      xp: toNewXp,
      level: calcLevel(toNewXp),
    }
    if (!avatarEquipVisualEquals(to.avatar, toAvatarNext)) {
      toPatch.avatar = toAvatarNext
    }

    tx.update(fromRef, fromPatch)
    tx.update(toRef, toPatch)
    tx.update(doc(db, 'tradeOffers', tradeId), { status: 'accepted' })
  })

  await logTransaction({
    type: 'trade', fromUid: trade.fromUid, toUid: trade.toUid,
    amount: trade.offeredCoins || 0,
    itemIds: [...(trade.offeredItems || []), ...(trade.requestedItems || [])],
  })
}

// ─── XP / Level helpers ───────────────────────────────────────────────────────
export function calcLevel(xp) {
  // XP needed per level grows: level n needs n*100 XP cumulative
  let level = 1
  let threshold = 0
  while (level < 50) {
    threshold += level * 100
    if (xp < threshold) break
    level++
  }
  return Math.min(level, 50)
}

export function xpForLevel(level) {
  let total = 0
  for (let i = 1; i < level; i++) total += i * 100
  return total
}

export function xpToNextLevel(level) {
  return level * 100
}

// ─── Leaderboard ─────────────────────────────────────────────────────────────
export async function getLeaderboard(classId = null, limitCount = 20) {
  let q
  if (classId) {
    q = query(usersCol(), where('classId', '==', classId), where('role', '==', 'student'), orderBy('coins', 'desc'), limit(limitCount))
  } else {
    q = query(usersCol(), where('role', '==', 'student'), orderBy('coins', 'desc'), limit(limitCount))
  }
  const snap = await getDocs(q)
  return snap.docs.map(d => ({ id: d.id, ...d.data() }))
}

// ─── Daily quests ─────────────────────────────────────────────────────────────
const QUEST_TYPES = [
  { type: 'login',      label: 'Увійти сьогодні',              target: 1,  rewardCoins: 10, rewardXp: 20 },
  { type: 'trade',      label: 'Завершити обмін',               target: 1,  rewardCoins: 25, rewardXp: 50 },
  { type: 'spend',      label: 'Витратити монети у магазині',    target: 50, rewardCoins: 15, rewardXp: 30 },
  { type: 'receive',    label: 'Отримати монети від вчителя',   target: 1,  rewardCoins: 5,  rewardXp: 15 },
  { type: 'send_trade', label: 'Надіслати пропозицію обміну',   target: 1,  rewardCoins: 10, rewardXp: 20 },
]

export function generateDailyQuests() {
  const shuffled = [...QUEST_TYPES].sort(() => Math.random() - 0.5)
  return shuffled.slice(0, 3).map(q => ({ ...q, progress: 0, completed: false }))
}

export async function getDailyQuests(uid) {
  const today = new Date().toISOString().split('T')[0]
  const ref = doc(db, 'dailyQuests', `${uid}_${today}`)
  const snap = await getDoc(ref)
  if (snap.exists()) {
    const d = snap.data()
    if (d.ownerUid == null || d.ownerUid !== uid) {
      await updateDoc(ref, { ownerUid: uid })
    }
    return d.quests
  }
  const quests = generateDailyQuests()
  await setDoc(ref, { ownerUid: uid, quests, createdAt: serverTimestamp() })
  return quests
}

export async function updateQuestProgress(uid, questType, amount = 1) {
  const today = new Date().toISOString().split('T')[0]
  const ref = doc(db, 'dailyQuests', `${uid}_${today}`)
  const snap = await getDoc(ref)
  if (!snap.exists()) return

  const quests = snap.data().quests.map(q => {
    if (q.type !== questType || q.completed) return q
    const newProgress = Math.min(q.progress + amount, q.target)
    return { ...q, progress: newProgress, completed: newProgress >= q.target }
  })
  await updateDoc(ref, { ownerUid: uid, quests })
  return quests
}

// ─── Streak helpers ───────────────────────────────────────────────────────────
export async function updateStreak(uid) {
  const userRef = doc(db, 'users', uid)
  const snap = await getDoc(userRef)
  if (!snap.exists()) return 0
  const user = snap.data()
  const today = new Date().toISOString().split('T')[0]
  const last = user.lastLoginDate || ''

  if (last === today) return user.streak || 0

  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0]
  const newStreak = last === yesterday ? (user.streak || 0) + 1 : 1

  const streakBonusCoins = [3, 7, 14, 30].includes(newStreak) ? newStreak * 5 : 0
  const newXpStreak = (user.xp || 0) + 10 + newStreak * 2

  await updateDoc(userRef, {
    streak: newStreak,
    lastLoginDate: today,
    coins: increment(streakBonusCoins),
    xp: newXpStreak,
    level: calcLevel(newXpStreak),
  })

  if (streakBonusCoins > 0) {
    await logTransaction({ type: 'streak_bonus', fromUid: uid, toUid: uid, amount: streakBonusCoins, note: `Бонус за серію ${newStreak} днів` })
  }

  return newStreak
}

// ─── Achievement checks ───────────────────────────────────────────────────────
export async function checkAndGrantAchievements(uid) {
  const [user, allAchievements] = await Promise.all([getUser(uid), getAllAchievements()])
  if (!user) return []
  const earned = new Set(user.badges || [])
  const grants = []

  for (const ach of allAchievements) {
    if (earned.has(ach.id)) continue
    const { type, threshold } = ach.condition
    let qualifies = false

    if (type === 'coins' && (user.coins || 0) >= threshold) qualifies = true
    if (type === 'level' && (user.level || 1) >= threshold) qualifies = true
    if (type === 'streak' && (user.streak || 0) >= threshold) qualifies = true

    if (qualifies) {
      grants.push(ach)
    }
  }

  if (grants.length > 0) {
    const batch = writeBatch(db)
    const uRef = doc(db, 'users', uid)
    const xpGrant = grants.reduce((s, a) => s + (a.rewardXp || 0), 0)
    const newXpAch = (user.xp || 0) + xpGrant
    batch.update(uRef, {
      badges: arrayUnion(...grants.map(a => a.id)),
      coins: increment(grants.reduce((s, a) => s + (a.rewardCoins || 0), 0)),
      xp: newXpAch,
      level: calcLevel(newXpAch),
    })
    await batch.commit()
  }

  return grants
}

// ─── Teacher quests ────────────────────────────────────────────────────────────
export const questsCol            = () => collection(db, 'quests')
export const questCompletionsCol  = () => collection(db, 'questCompletions')

export async function createQuest(data) {
  const ref = await addDoc(questsCol(), {
    ...data,
    status: 'active',
    firstCompletedBy: null,
    createdAt: serverTimestamp(),
  })
  return ref.id
}

export async function cancelQuest(questId) {
  await updateDoc(doc(db, 'quests', questId), { status: 'cancelled' })
}

export async function getQuestsByTeacher(teacherId) {
  const q = query(questsCol(), where('teacherId', '==', teacherId))
  const snap = await getDocs(q)
  return snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => {
    return (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0)
  })
}

export async function getActiveQuestsForStudent(studentId, classId) {
  const results = []

  const q1 = query(questsCol(), where('studentId', '==', studentId))
  const s1 = await getDocs(q1)
  results.push(...s1.docs.map(d => ({ id: d.id, ...d.data() })).filter(d => d.status === 'active'))

  if (classId) {
    const q2 = query(questsCol(), where('classId', '==', classId))
    const s2 = await getDocs(q2)
    results.push(...s2.docs.map(d => ({ id: d.id, ...d.data() })).filter(d => d.status === 'active'))
  }

  return results
}

/**
 * Активні завдання вчителя для учня: персональні (studentId) + для класу (classId).
 * Два snapshot-и зливаються по id (без дублікатів).
 */
export function watchMergedActiveQuests(studentId, classId, cb) {
  const fromStudent = new Map()
  const fromClass = new Map()

  function emit() {
    const merged = new Map()
    for (const [id, row] of fromStudent) merged.set(id, row)
    for (const [id, row] of fromClass) merged.set(id, row)
    const list = [...merged.values()].filter((q) => q.status === 'active')
    list.sort((a, b) => (b.createdAt?.seconds ?? 0) - (a.createdAt?.seconds ?? 0))
    cb(list)
  }

  const unsubStudent = onSnapshot(
    query(questsCol(), where('studentId', '==', studentId)),
    (snap) => {
      fromStudent.clear()
      for (const d of snap.docs) {
        fromStudent.set(d.id, { id: d.id, ...d.data() })
      }
      emit()
    },
    (err) => console.warn('[watchMergedActiveQuests studentId]', err?.message),
  )

  let unsubClass = () => {}
  if (classId) {
    unsubClass = onSnapshot(
      query(questsCol(), where('classId', '==', classId)),
      (snap) => {
        fromClass.clear()
        for (const d of snap.docs) {
          fromClass.set(d.id, { id: d.id, ...d.data() })
        }
        emit()
      },
      (err) => console.warn('[watchMergedActiveQuests classId]', err?.message),
    )
  }

  return () => {
    unsubStudent()
    unsubClass()
  }
}

/** Усі заявки учня на перевірку завдань (для UI + сповіщень про рішення вчителя). */
export function watchStudentQuestCompletions(studentId, cb) {
  const q = query(questCompletionsCol(), where('studentId', '==', studentId))
  return onSnapshot(
    q,
    (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (err) => console.warn('[watchStudentQuestCompletions]', err?.message),
  )
}

const TX_STUDENT_NOTIFY_LIMIT = 30

/** Вхідні транзакції (нагороди / штрафи від вчителя тощо) — вже є індекс (toUid, timestamp desc). */
export function watchIncomingTransactionsForStudent(toUid, cb) {
  const q = query(
    txCol(),
    where('toUid', '==', toUid),
    orderBy('timestamp', 'desc'),
    limit(TX_STUDENT_NOTIFY_LIMIT),
  )
  return onSnapshot(
    q,
    (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (err) => console.warn('[watchIncomingTransactionsForStudent]', err?.message),
  )
}

/**
 * Upload a single file as quest proof and return its metadata.
 * Path: questProofs/{uid}/{questId}/{timestamp}_{safeName}
 */
export async function uploadQuestProof(uid, questId, file, onProgress) {
  const safeName = file.name.replace(/[^\w.\-]/g, '_')
  const path = `questProofs/${uid}/${questId}/${Date.now()}_${safeName}`
  const ref = storageRef(storage, path)
  await uploadBytes(ref, file)
  if (onProgress) onProgress()
  const url = await getDownloadURL(ref)
  return { url, name: file.name, type: file.type || '', size: file.size, path }
}

export async function submitQuestCompletion(questId, studentId, studentName, proof, attachments = []) {
  const ref = await addDoc(questCompletionsCol(), {
    questId,
    studentId,
    studentName,
    proof,
    attachments,
    status: 'pending',
    submittedAt: serverTimestamp(),
    reviewedAt: null,
  })
  return ref.id
}

export async function getQuestCompletions(questId) {
  const q = query(questCompletionsCol(), where('questId', '==', questId))
  const snap = await getDocs(q)
  return snap.docs.map(d => ({ id: d.id, ...d.data() }))
}

export async function getStudentCompletions(studentId) {
  const q = query(questCompletionsCol(), where('studentId', '==', studentId))
  const snap = await getDocs(q)
  return snap.docs.map(d => ({ id: d.id, ...d.data() }))
}

export async function grantQuestReward({ teacherId, studentId, questId, questTitle, coins, xp }) {
  const today = getCurrentBudgetDayDate()

  await runTransaction(db, async tx => {
    const uRef = doc(db, 'users', studentId)
    const tRef = doc(db, 'users', teacherId)
    const [uSnap, tSnap] = await Promise.all([tx.get(uRef), tx.get(tRef)])

    if (!uSnap.exists()) throw new Error('Student not found')

    // Enforce daily budget for teachers
    if (tSnap.exists() && tSnap.data().role === 'teacher') {
      const t      = tSnap.data()
      const used   = t.budgetDayStart === today ? (t.coinsUsedToday || 0) : 0
      const budget = t.coinsBudgetDaily ?? t.coinsBudgetWeekly ?? DEFAULT_DAILY_BUDGET
      if (used + coins > budget) {
        throw new Error(`Недостатньо денного бюджету. Залишок: ${budget - used} 🪙`)
      }
      tx.update(tRef, { coinsUsedToday: used + coins, budgetDayStart: today })
    }

    const user     = uSnap.data()
    const newCoins = (user.coins || 0) + coins
    const newXp    = (user.xp    || 0) + xp
    tx.update(uRef, { coins: newCoins, xp: newXp, level: calcLevel(newXp) })
  })

  await logTransaction({
    type: 'quest_reward',
    fromUid: teacherId,
    toUid: studentId,
    amount: coins,
    note: `Завдання: ${questTitle}`,
    questId,
  })
}

export async function approveQuestCompletion(completionId, questId, { teacherId, studentId, questTitle, coins, xp }) {
  const questSnap = await getDoc(doc(db, 'quests', questId))

  await updateDoc(doc(db, 'questCompletions', completionId), {
    status: 'approved',
    reviewedAt: serverTimestamp(),
  })

  if (questSnap.exists() && !questSnap.data().firstCompletedBy) {
    await updateDoc(doc(db, 'quests', questId), { firstCompletedBy: studentId })
  }

  await grantQuestReward({ teacherId, studentId, questId, questTitle, coins, xp })
}

export async function rejectQuestCompletion(completionId) {
  await updateDoc(doc(db, 'questCompletions', completionId), {
    status: 'rejected',
    reviewedAt: serverTimestamp(),
  })
}

export { serverTimestamp, increment, arrayUnion, arrayRemove, doc, db, Timestamp }

// ─── Hard-delete user data ────────────────────────────────────────────────────
/**
 * Permanently removes the Firestore user profile and their access code.
 * The Firebase Auth account becomes orphaned (can't be deleted from client-side
 * without Admin SDK), but with no Firestore profile and no valid access code
 * the user can no longer log in through the app.
 */
export async function deleteUserData(uid, accessCode) {
  const batch = writeBatch(db)
  batch.delete(doc(db, 'users', uid))
  if (accessCode) batch.delete(doc(db, 'accessCodes', accessCode.toUpperCase()))
  await batch.commit()
}

// ─── Admin / DevTools helpers ─────────────────────────────────────────────────

export async function getAllUsers() {
  const snap = await getDocs(usersCol())
  return snap.docs.map(d => ({ id: d.id, ...d.data() }))
}

/** Delete all documents in a collection in batches of 400 */
async function batchDeleteAll(colRef) {
  let total = 0
  while (true) {
    const snap = await getDocs(query(colRef, limit(400)))
    if (snap.empty) break
    const batch = writeBatch(db)
    snap.docs.forEach(d => batch.delete(d.ref))
    await batch.commit()
    total += snap.docs.length
    if (snap.docs.length < 400) break
  }
  return total
}

export async function adminSetUserCoins(uid, coins) {
  await updateDoc(doc(db, 'users', uid), { coins: Math.max(0, Math.round(coins)) })
}

export async function adminSetUserXp(uid, xp) {
  const safeXp = Math.max(0, Math.round(xp))
  await updateDoc(doc(db, 'users', uid), { xp: safeXp, level: calcLevel(safeXp) })
}

export async function adminSetUserField(uid, field, value) {
  await updateDoc(doc(db, 'users', uid), { [field]: value })
}

/** Clear inventory, box stacks, and equipped cosmetics; keeps profile photo only. */
export async function adminClearUserInventoryAndCosmetics(uid) {
  const ref = doc(db, 'users', uid)
  const snap = await getDoc(ref)
  const prev = snap.exists() ? snap.data() : {}
  const av = prev.avatar || {}
  await updateDoc(ref, {
    inventory: [],
    inventoryCounts: {},
    mysteryBoxCounts: {},
    avatar: {
      photoUrl: av.photoUrl ?? null,
      skinId: 'default',
      skinUrl: null,
      accessories: [],
      roomId: null,
      petId: null,
    },
  })
}

export async function adminFlushTransactions() {
  return batchDeleteAll(txCol())
}

export async function adminFlushQuestCompletions() {
  return batchDeleteAll(questCompletionsCol())
}

export async function adminFlushQuests() {
  return batchDeleteAll(questsCol())
}

export async function adminFlushTrades() {
  return batchDeleteAll(tradesCol())
}

export async function adminResetStudentStats(fields = ['coins', 'xp', 'level', 'streak', 'inventory', 'badges']) {
  const snap = await getDocs(query(usersCol(), where('role', '==', 'student')))
  const resetData = {}
  if (fields.includes('coins'))     resetData.coins     = 0
  if (fields.includes('xp'))        resetData.xp        = 0
  if (fields.includes('level'))     resetData.level      = 1
  if (fields.includes('streak'))    resetData.streak     = 0
  if (fields.includes('inventory')) {
    resetData.inventory = []
    resetData.inventoryCounts = {}
  }
  if (fields.includes('badges'))    resetData.badges     = []

  const chunks = []
  let batch = writeBatch(db)
  let count = 0
  for (const d of snap.docs) {
    batch.update(d.ref, resetData)
    count++
    if (count === 400) { chunks.push(batch.commit()); batch = writeBatch(db); count = 0 }
  }
  if (count > 0) chunks.push(batch.commit())
  await Promise.all(chunks)
  return snap.docs.length
}
