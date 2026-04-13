import { initializeApp } from 'firebase/app'
import { getAuth } from 'firebase/auth'
import {
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from 'firebase/firestore'
import { getStorage } from 'firebase/storage'
import { getDatabase } from 'firebase/database'

// Replace with your Firebase project config from https://console.firebase.google.com
const databaseURL = import.meta.env.VITE_FIREBASE_DATABASE_URL
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  ...(databaseURL ? { databaseURL } : {}),
}

const app = initializeApp(firebaseConfig)

export const auth = getAuth(app)

/**
 * IndexedDB-backed Firestore cache so cold opens / PWA relaunch reuse local data
 * (shop catalog, etc.) instead of waiting for a full network round-trip every time.
 * Default getFirestore() is memory-only and is wiped on every tab reload.
 */
function createFirestore() {
  if (typeof window === 'undefined') {
    return getFirestore(app)
  }
  try {
    return initializeFirestore(app, {
      localCache: persistentLocalCache({
        tabManager: persistentMultipleTabManager(),
      }),
    })
  } catch (e) {
    const msg = e?.message || String(e)
    if (!/already been (called|started)/i.test(msg)) {
      console.warn('[firebase] Firestore persistence unavailable, using default:', msg)
    }
    return getFirestore(app)
  }
}

export const db = createFirestore()
export const storage = getStorage(app)
/**
 * Realtime Database (block-world presence). Create DB in Firebase Console → Build →
 * Realtime Database; set `VITE_FIREBASE_DATABASE_URL` (e.g. https://&lt;project&gt;-default-rtdb.europe-west1.firebasedatabase.app).
 */
export const rtdb = databaseURL ? getDatabase(app, databaseURL) : null
export default app
