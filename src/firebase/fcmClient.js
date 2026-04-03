/**
 * Web FCM: token for push + foreground message handler.
 * Background payloads are handled by fb-msg-bg.js (Workbox importScripts).
 */
import { getMessaging, getToken, isSupported, onMessage } from 'firebase/messaging'
import app from './config'
import { saveUserFcmToken } from './collections'
import { trySystemNotify } from '@/utils/systemNotify'

const FB_CDN = '12.11.0'

/** Exposed for docs / debugging */
export { FB_CDN }

let messagingInited = false

async function ensureMessaging() {
  if (typeof window === 'undefined') return null
  const vapidKey = import.meta.env.VITE_FCM_VAPID_KEY
  if (!vapidKey) return null
  const ok = await isSupported()
  if (!ok) return null
  const messaging = getMessaging(app)
  if (!messagingInited) {
    messagingInited = true
    onMessage(messaging, (payload) => {
      const n = payload.notification
      const title = n?.title || payload.data?.title || 'FUSAPP'
      const body = n?.body || payload.data?.body || ''
      void trySystemNotify(title, body, { tag: payload.data?.tag || 'fcm-foreground' })
    })
  }
  return messaging
}

/**
 * Registers device with FCM (shows notification permission if needed) and saves token to Firestore.
 */
export async function registerWebPushAndSave(uid) {
  if (!uid) return null
  try {
    const messaging = await ensureMessaging()
    if (!messaging) return null
    const registration = await navigator.serviceWorker.ready
    const token = await getToken(messaging, {
      vapidKey: import.meta.env.VITE_FCM_VAPID_KEY,
      serviceWorkerRegistration: registration,
    })
    if (token) await saveUserFcmToken(uid, token)
    return token
  } catch (e) {
    console.warn('[FCM] register failed:', e?.message || e)
    return null
  }
}
