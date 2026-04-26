/**
 * One-off admin: normalize every Firestore `items` row with `category === 'subject_badge'`.
 *
 * Sets (same as `src/firebase/seedData.js` — keep strings in sync when you change the product):
 *   • price: 100
 *   • description: canonical Ukrainian copy for students
 *   • coinKind: 'subject_earned'  (shop + `purchaseItem` bill per-subject earned coins only)
 *
 * Credentials (same as `scripts/reverse-block-world-mob-coins.mjs`):
 *   • `scripts/firebase-admin.local.json` (gitignored), or
 *   • `GOOGLE_APPLICATION_CREDENTIALS`, or
 *   • `gcloud auth application-default login`
 *
 * Usage:
 *   node scripts/update-subject-badges.mjs --dry-run
 *   node scripts/update-subject-badges.mjs
 *
 * npm:
 *   npm run shop:update-subject-badges:dry
 *   npm run shop:update-subject-badges
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import admin from 'firebase-admin'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')
const FIREBASE_ADMIN_LOCAL_SA = join(REPO_ROOT, 'scripts', 'firebase-admin.local.json')

/** @see src/firebase/seedData.js `SUBJECT_BADGE_PRICE` */
const TARGET_PRICE = 100
/** @see src/firebase/seedData.js `SUBJECT_BADGE_DESCRIPTION` */
const TARGET_DESCRIPTION =
  'Цей бейдж дає право на підвищення оцінки з цього предмету. Можна придбати лише за монети зароблені з цього предмету.'
/** @see src/firebase/seedData.js `SUBJECT_BADGE_COIN_KIND` */
const TARGET_COIN_KIND = 'subject_earned'

const BATCH_SIZE = 400

function tryReadFirebasercProjectId() {
  try {
    const raw = readFileSync(join(REPO_ROOT, '.firebaserc'), 'utf8')
    const j = JSON.parse(raw)
    const id = j?.projects?.default
    return typeof id === 'string' && id.trim() ? id.trim() : null
  } catch {
    return null
  }
}

function tryReadViteProjectIdFromEnvFiles() {
  for (const name of ['.env.local', '.env']) {
    const p = join(REPO_ROOT, name)
    if (!existsSync(p)) continue
    try {
      const raw = readFileSync(p, 'utf8')
      for (const line of raw.split(/\r?\n/)) {
        const m = line.match(
          /^\s*VITE_FIREBASE_PROJECT_ID\s*=\s*(?:'([^']*)'|"([^"]*)"|([^\s#]+))/,
        )
        if (m) {
          const v = (m[1] ?? m[2] ?? m[3] ?? '').trim()
          if (v) return v
        }
      }
    } catch {
      /* ignore */
    }
  }
  return null
}

const dryRun = process.argv.includes('--dry-run')

let projectId =
  process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || null
const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
if (!projectId && credPath) {
  try {
    projectId = JSON.parse(readFileSync(resolve(credPath), 'utf8')).project_id || null
  } catch {
    /* ignore */
  }
}
if (!projectId && existsSync(FIREBASE_ADMIN_LOCAL_SA)) {
  try {
    projectId = JSON.parse(readFileSync(FIREBASE_ADMIN_LOCAL_SA, 'utf8')).project_id || null
  } catch {
    /* ignore */
  }
}
if (!projectId) projectId = tryReadFirebasercProjectId()
if (!projectId) projectId = tryReadViteProjectIdFromEnvFiles()
if (!projectId) {
  console.error(
    'Could not determine Firebase project ID. Set FIREBASE_PROJECT_ID or use .firebaserc / .env (VITE_FIREBASE_PROJECT_ID).',
  )
  process.exit(1)
}

function resolveAdminCredential() {
  if (credPath) {
    const abs = resolve(credPath)
    if (!existsSync(abs)) {
      console.error(`GOOGLE_APPLICATION_CREDENTIALS not found: ${abs}`)
      process.exit(1)
    }
    return admin.credential.cert(JSON.parse(readFileSync(abs, 'utf8')))
  }
  if (existsSync(FIREBASE_ADMIN_LOCAL_SA)) {
    console.log('[update-subject-badges] Using scripts/firebase-admin.local.json')
    return admin.credential.cert(JSON.parse(readFileSync(FIREBASE_ADMIN_LOCAL_SA, 'utf8')))
  }
  return admin.credential.applicationDefault()
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: resolveAdminCredential(),
    projectId,
  })
}

const db = admin.firestore()

function needsUpdate(data) {
  const price = Number(data.price) || 0
  const desc = String(data.description || '').trim()
  const ck = data.coinKind
  return price !== TARGET_PRICE || desc !== TARGET_DESCRIPTION || ck !== TARGET_COIN_KIND
}

const snap = await db.collection('items').where('category', '==', 'subject_badge').get()

const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
const toPatch = rows.filter((r) => needsUpdate(r))

console.log(`[update-subject-badges] project=${projectId} dryRun=${dryRun}`)
console.log(`[update-subject-badges] subject_badge docs: ${rows.length}, need patch: ${toPatch.length}`)

if (toPatch.length === 0) {
  console.log('Nothing to do (already normalized).')
  process.exit(0)
}

for (const r of toPatch.slice(0, 40)) {
  console.log(
    `  • ${r.id}  name=${JSON.stringify(r.name)}  subjectName=${JSON.stringify(r.subjectName)}  price=${r.price}  coinKind=${r.coinKind ?? '(missing)'}`,
  )
}
if (toPatch.length > 40) {
  console.log(`  … and ${toPatch.length - 40} more`)
}

if (dryRun) {
  console.log('\nDry run only — no writes. Re-run without --dry-run to apply.')
  process.exit(0)
}

let updated = 0
for (let i = 0; i < toPatch.length; i += BATCH_SIZE) {
  const chunk = toPatch.slice(i, i + BATCH_SIZE)
  const batch = db.batch()
  for (const r of chunk) {
    const ref = db.collection('items').doc(r.id)
    batch.update(ref, {
      price: TARGET_PRICE,
      description: TARGET_DESCRIPTION,
      coinKind: TARGET_COIN_KIND,
    })
  }
  await batch.commit()
  updated += chunk.length
  console.log(`[update-subject-badges] committed ${updated} / ${toPatch.length}`)
}

console.log(`Done. Updated ${updated} item(s).`)
