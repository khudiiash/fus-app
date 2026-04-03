/**
 * OS-level notifications (tray / banner). Uses the service worker when available
 * (better on Android PWA). For alerts when the app is fully killed you still need
 * Firebase Cloud Messaging (or another Web Push backend).
 */
export async function trySystemNotify(title, body, options = {}) {
  if (typeof window === 'undefined') return
  if (!('Notification' in window)) return

  try {
    if (Notification.permission === 'default') {
      await Notification.requestPermission()
    }
    if (Notification.permission !== 'granted') return

    const icon = options.icon || '/icons/icon-192.png'
    const { tag = 'fusapp', ...rest } = options
    const payload = {
      body,
      icon,
      badge: icon,
      vibrate: [120, 60, 120],
      silent: false,
      tag,
      ...rest,
    }

    const reg = await navigator.serviceWorker?.getRegistration?.()
    if (reg?.showNotification) {
      await reg.showNotification(title, payload)
    } else {
      new Notification(title, { body, icon, tag, ...rest })
    }
  } catch (e) {
    console.warn('[systemNotify]', e)
  }
}
