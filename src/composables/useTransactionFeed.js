import { doc, getDoc } from 'firebase/firestore'
import { db } from '@/firebase/config'

const profileCache = Object.create(null)

/**
 * @param {string} uid
 * @returns {Promise<{ displayName: string, avatar: object, role: string } | null>}
 */
export async function resolveUserProfile(uid) {
  if (!uid) return null
  if (profileCache[uid] !== undefined) return profileCache[uid]
  try {
    const snap = await getDoc(doc(db, 'users', uid))
    if (!snap.exists()) {
      profileCache[uid] = null
      return null
    }
    const d = snap.data()
    const row = {
      displayName: d.displayName || 'Невідомо',
      avatar: d.avatar || {},
      role: d.role || 'student',
    }
    profileCache[uid] = row
    return row
  } catch {
    profileCache[uid] = null
    return null
  }
}

/**
 * Other party for the viewer (вхідні події або надісланий значок вчителю).
 */
function peerForTransaction(tx, myUid) {
  if (!myUid) return null
  if (tx.type === 'badge_sent' && tx.fromUid === myUid && tx.toUid) {
    return profileCache[tx.toUid] || null
  }
  if (tx.toUid !== myUid) return null
  if (!tx.fromUid || tx.fromUid === myUid) return null
  return profileCache[tx.fromUid] || null
}

/**
 * @param {object[]} txs
 * @param {string} myUid
 */
export async function enrichStudentFeedTransactions(txs, myUid) {
  const uids = new Set()
  for (const t of txs) {
    if (t.fromUid) uids.add(t.fromUid)
    if (t.toUid) uids.add(t.toUid)
  }
  await Promise.all([...uids].map((uid) => resolveUserProfile(uid)))
  return txs.map((tx) => ({
    ...tx,
    peerProfile: peerForTransaction(tx, myUid),
  }))
}

/**
 * Teacher award list: enrich with student (toUid) profile.
 */
export async function enrichTeacherAwardRows(txs) {
  const uids = [...new Set(txs.map((t) => t.toUid).filter(Boolean))]
  await Promise.all(uids.map((uid) => resolveUserProfile(uid)))
  return txs.map((tx) => ({
    ...tx,
    studentProfile: tx.toUid ? profileCache[tx.toUid] : null,
  }))
}

/**
 * Журнал вчителя: для award — учень у toUid; для badge_sent — учень у fromUid.
 * peerProfile — для HistoryTransactionCard (аватар учня).
 */
export async function enrichTeacherJournalTransactions(txs, teacherUid) {
  const uids = new Set()
  for (const t of txs) {
    if (t.type === 'award' && t.fromUid === teacherUid && t.toUid) uids.add(t.toUid)
    if (t.type === 'badge_sent' && t.toUid === teacherUid && t.fromUid) uids.add(t.fromUid)
  }
  await Promise.all([...uids].map((uid) => resolveUserProfile(uid)))
  return txs.map((tx) => {
    let peerProfile = null
    let studentProfile = null
    if (tx.type === 'award' && tx.fromUid === teacherUid) {
      studentProfile = tx.toUid ? profileCache[tx.toUid] : null
      peerProfile = studentProfile
    } else if (tx.type === 'badge_sent' && tx.toUid === teacherUid) {
      studentProfile = tx.fromUid ? profileCache[tx.fromUid] : null
      peerProfile = studentProfile
    }
    return { ...tx, peerProfile, studentProfile }
  })
}
