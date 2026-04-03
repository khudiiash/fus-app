/**
 * Мультикаст FCM на усі токени користувача (users/{uid}.fcmTokens).
 * Лише data payload — сумісно з onBackgroundMessage у fcm-sw-compat.js.
 */
const { getFirestore, FieldValue } = require('firebase-admin/firestore')
const { getMessaging } = require('firebase-admin/messaging')

/**
 * @param {string} uid
 * @param {{ title: string, body: string, data?: Record<string, string> }} payload
 */
async function sendPushToUser(uid, { title, body, data = {} }) {
  if (!uid) return
  const db = getFirestore()
  const userRef = db.collection('users').doc(uid)
  const snap = await userRef.get()
  if (!snap.exists) return
  const raw = snap.data().fcmTokens || []
  const tokens = [...new Set(raw.filter(Boolean))]
  if (!tokens.length) return

  const stringData = {
    title: String(title),
    body: String(body),
    ...Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, v == null ? '' : String(v)]),
    ),
  }

  const messaging = getMessaging()
  const res = await messaging.sendEachForMulticast({
    tokens,
    data: stringData,
    android: { priority: 'high' },
    webpush: {
      headers: {
        Urgency: 'high',
        TTL: '86400',
      },
      fcmOptions: { link: '/' },
    },
  })

  const dead = []
  res.responses.forEach((r, i) => {
    if (r.success) return
    const c = r.error?.code || ''
    if (
      c.includes('registration-token-not-registered') ||
      c.includes('invalid-registration-token')
    ) {
      dead.push(tokens[i])
    }
  })
  if (dead.length) {
    try {
      await userRef.update({ fcmTokens: FieldValue.arrayRemove(...dead) })
    } catch (e) {
      console.warn('[fcmHelpers] prune tokens', e?.message || e)
    }
  }
}

module.exports = { sendPushToUser }
