/**
 * Web FCM: токен у Firestore + підписка на той самий SW, що й Workbox (`/sw.js`).
 * Фонові push обробляє `fcm-sw-compat.js` (перший importScripts у sw.js).
 * Foreground onMessage не реєструємо — потрібні лише системні push у фоні / закритому вигляді.
 *
 * Дозвіл: лише з кліку (банер). Після логіну — registerWebPushAndSave, якщо permission уже granted.
 */
import { getMessaging, getToken, isSupported } from 'firebase/messaging'
import app from './config'
import { saveUserFcmToken } from './collections'

const FB_CDN = '12.11.0'

/** Exposed for docs / debugging */
export { FB_CDN }

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
  return getMessaging(app)
}

/** Той самий SW, що реєструє vite-plugin-pwa (`/sw.js`). */
async function getPushServiceWorkerRegistration() {
  let reg = await navigator.serviceWorker.getRegistration('/')
  if (!reg) {
    reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' })
  }
  return reg
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
    const registration = await getPushServiceWorkerRegistration()
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
    const registration = await getPushServiceWorkerRegistration()
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
