/**
 * Cloud Function syncShopStorageClaim: виставляє JWT claim storageAdmin за профілем Firestore.
 * Регіон має збігатися з functions/index.js (europe-west1).
 */
import { getFunctions, httpsCallable } from 'firebase/functions'
import app from './config'

const FUNCTIONS_REGION = 'europe-west1'

export async function syncShopStorageClaim() {
  const functions = getFunctions(app, FUNCTIONS_REGION)
  const call = httpsCallable(functions, 'syncShopStorageClaim')
  const { data } = await call()
  return data
}
