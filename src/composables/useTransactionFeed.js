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
 * Other party for the viewer (student feed: query is always toUid === me).
 */
function peerForTransaction(tx, myUid) {
  if (!myUid) return null
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
