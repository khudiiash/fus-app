/**
 * Grants custom claim storageAdmin=true so Storage security rules allow shop uploads
 * without depending on firestore.get() from Storage (cross-service IAM).
 *
 * Prerequisites: Firebase Admin SDK credentials (service account JSON).
 *
 *   set GOOGLE_APPLICATION_CREDENTIALS=C:\path\to\serviceAccount.json
 *   set FIREBASE_PROJECT_ID=your-project-id
 *   node scripts/set-storage-admin-claim.mjs YOUR_AUTH_UID
 *
 * Then sign out and sign in again (or refresh the ID token).
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import admin from 'firebase-admin'

const uid = process.argv[2]
if (!uid) {
  console.error('Usage: node scripts/set-storage-admin-claim.mjs <Firebase Auth UID>')
  process.exit(1)
}

let projectId = process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT
const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
if (!projectId && credPath) {
  try {
    const raw = readFileSync(resolve(credPath), 'utf8')
    projectId = JSON.parse(raw).project_id
  } catch {
    // ignore
  }
}
if (!projectId) {
  console.error('Set FIREBASE_PROJECT_ID or use GOOGLE_APPLICATION_CREDENTIALS pointing to a service account JSON that contains project_id.')
  process.exit(1)
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    projectId,
  })
}

const user = await admin.auth().getUser(uid)
const next = { ...(user.customClaims || {}), storageAdmin: true }
await admin.auth().setCustomUserClaims(uid, next)
console.log(`OK: storageAdmin=true for uid=${uid}. Re-login or call getIdToken(true) so the new JWT is used.`)
