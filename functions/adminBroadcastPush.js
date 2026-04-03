/**
 * Адмін: FCM лише за явним списком uid (userUids / teacherUids / studentUids).
 * Масив у callable інколи приходить як {0: id, 1: id} — нормалізуємо через coalesceUidList.
 */
const { onCall, HttpsError } = require('firebase-functions/v2/https')
const { getFirestore } = require('firebase-admin/firestore')
const { sendPushToUser } = require('./fcmHelpers')

/**
 * @param {unknown} v
 * @returns {string[]}
 */
function coalesceUidList(v) {
  if (v == null) return []
  if (Array.isArray(v)) {
    return [...new Set(v.map((u) => String(u).trim()).filter(Boolean))]
  }
  if (typeof v === 'object') {
    const keys = Object.keys(v).sort((a, b) => Number(a) - Number(b))
    const vals = keys.map((k) => v[k])
    return [...new Set(vals.map((u) => String(u).trim()).filter(Boolean))]
  }
  return []
}

/** @param {string} region @param {Record<string, unknown>} exportsObj */
function registerAdminBroadcastPush(region, exportsObj) {
  exportsObj.adminBroadcastPush = onCall({ region }, async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Потрібен вхід')
    }
    const db = getFirestore()
    const adminSnap = await db.collection('users').doc(request.auth.uid).get()
    if (!adminSnap.exists || adminSnap.data().role !== 'admin') {
      throw new HttpsError('permission-denied', 'Лише адміністратор')
    }

    const data = request.data || {}
    const title = String(data.title ?? '').trim()
    const body = String(data.body ?? '').trim()
    const targetRole = data.targetRole === 'student' ? 'student' : 'teacher'

    if (!title || !body) {
      throw new HttpsError('invalid-argument', 'Заповніть заголовок і текст')
    }

    const targets = coalesceUidList(
      data.userUids ?? data.teacherUids ?? data.studentUids,
    ).slice(0, 500)

    if (targets.length === 0) {
      throw new HttpsError(
        'invalid-argument',
        'Порожній список отримувачів — оберіть учнів/вчителів у модалці',
      )
    }

    const tag = `admin-${targetRole}-${Date.now()}`
    let sent = 0
    for (const uid of targets) {
      const u = await db.collection('users').doc(uid).get()
      if (!u.exists || u.data().role !== targetRole) continue
      await sendPushToUser(uid, {
        title,
        body,
        data: { type: 'admin_broadcast', tag, role: targetRole },
      })
      sent += 1
    }

    return { sent, total: targets.length, targetRole }
  })
}

module.exports = { registerAdminBroadcastPush }
