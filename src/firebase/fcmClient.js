/**
 * Web FCM: token for push + foreground message handler.
 * Background payloads are handled by fb-msg-bg.js (Workbox importScripts).
 *
 * Дозвіл на сповіщення: викликайте лише з явного кліку (банер / кнопка).
 * Після логіну використовуйте registerWebPushAndSave лише якщо permission уже granted.
 */
import { getMessaging, getToken, isSupported, onMessage } from 'firebase/messaging'
import app from './config'
import { saveUserFcmToken } from './collections'
import { trySystemNotify } from '@/utils/systemNotify'

const FB_CDN = '12.11.0'

/** Exposed for docs / debugging */
export { FB_CDN }

let messagingInited = false

export function hasFcmVapidConfigured() {
  return !!import.meta.env.VITE_FCM_VAPID_KEY
}

/** Чи взагалі можливі web push у цьому браузері + збірка. */
export async function isFcmWebPushEnvironmentOk() {
  if (typeof window === 'undefined') return false
  if (!hasFcmVapidConfigured()) return false
  if (!('serviceWorker' in navigator) || !('Notification' in window)) return false
  try {
    return await isSupported()
  } catch {
    return false
  }
}

async function ensureMessaging() {
  if (typeof window === 'undefined') return null
  if (!hasFcmVapidConfigured()) return null
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
 * Оновити FCM-токен у Firestore, якщо користувач уже натиснув «Дозволити» раніше.
 * Без granted не викликає getToken (і не показує системний діалог у фоні).
 */
export async function registerWebPushAndSave(uid) {
  if (!uid) return null
  if (typeof window === 'undefined') return null
  if (!('Notification' in window) || Notification.permission !== 'granted') return null
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

/**
 * Запит дозволу + отримання токена. Викликати тільки з user gesture (кнопка).
 * @returns {{ ok: true, token: string } | { ok: false, reason: string }}
 */
export async function requestWebPushPermissionAndRegister(uid) {
  if (!uid) return { ok: false, reason: 'no_uid' }
  if (typeof window === 'undefined') return { ok: false, reason: 'unsupported' }
  if (!hasFcmVapidConfigured()) return { ok: false, reason: 'not_configured' }
  if (!(await isSupported())) return { ok: false, reason: 'unsupported' }
  if (!('Notification' in window)) return { ok: false, reason: 'unsupported' }

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return { ok: false, reason: permission }

  try {
    const messaging = await ensureMessaging()
    if (!messaging) return { ok: false, reason: 'not_configured' }
    const registration = await navigator.serviceWorker.ready
    const token = await getToken(messaging, {
      vapidKey: import.meta.env.VITE_FCM_VAPID_KEY,
      serviceWorkerRegistration: registration,
    })
    if (!token) return { ok: false, reason: 'no_token' }
    await saveUserFcmToken(uid, token)
    return { ok: true, token }
  } catch (e) {
    console.warn('[FCM] request+register failed:', e?.message || e)
    return { ok: false, reason: 'error' }
  }
}
