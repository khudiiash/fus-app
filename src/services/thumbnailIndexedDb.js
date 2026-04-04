/**
 * Persists baked thumbnail PNGs (data URLs) in IndexedDB so WebGL renders
 * run once per device + asset, not on every shop/trade open (critical on mobile).
 */

const DB_NAME = 'fus-thumbnails-v1'
const STORE = 'png'
const DB_VER = 1

let dbPromise = null

export function isThumbnailIdbSupported() {
  return typeof indexedDB !== 'undefined'
}

function openDb() {
  if (!isThumbnailIdbSupported()) return Promise.reject(new Error('no idb'))
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, DB_VER)
      r.onerror = () => {
        dbPromise = null
        reject(r.error)
      }
      r.onupgradeneeded = (e) => {
        const db = e.target.result
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
      }
      r.onsuccess = () => resolve(r.result)
    })
  }
  return dbPromise
}

export async function hashThumbnailLogicalKey(logicalKey) {
  try {
    if (globalThis.crypto?.subtle?.digest) {
      const buf = new TextEncoder().encode(logicalKey)
      const digest = await globalThis.crypto.subtle.digest('SHA-256', buf)
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
    }
  } catch {
    /* non-secure context or unsupported */
  }
  let h = 5381
  for (let i = 0; i < logicalKey.length; i++) {
    h = ((h << 5) + h) ^ logicalKey.charCodeAt(i)
  }
  return `${(h >>> 0).toString(16)}:${logicalKey.length}`
}

/**
 * @param {'glb' | 'skin'} prefix
 * @param {string} logicalKey stable string (e.g. JSON from glbThumbnailRenderer cacheKey)
 */
export async function getPersistentThumbnail(prefix, logicalKey) {
  try {
    if (!logicalKey) return null
    const hash = await hashThumbnailLogicalKey(logicalKey)
    const idbKey = `${prefix}:${hash}`
    const db = await openDb()
    const val = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const g = tx.objectStore(STORE).get(idbKey)
      g.onsuccess = () => resolve(g.result)
      g.onerror = () => reject(g.error)
    })
    return typeof val === 'string' && val.startsWith('data:image') ? val : null
  } catch {
    return null
  }
}

export function setPersistentThumbnail(prefix, logicalKey, dataUrl) {
  if (!logicalKey || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image')) return
  void (async () => {
    try {
      const hash = await hashThumbnailLogicalKey(logicalKey)
      const idbKey = `${prefix}:${hash}`
      const db = await openDb()
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite')
        tx.objectStore(STORE).put(dataUrl, idbKey)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    } catch {
      /* quota / private mode */
    }
  })()
}
