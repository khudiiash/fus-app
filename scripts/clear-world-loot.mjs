/**
 * Admin: remove every RTDB row under `worldLootDrops/{worldId}` (coins + item drops).
 * Fixes stuck / uncollectable piles without resetting the whole Laby world.
 *
 * Credentials + project ID: same as `scripts/reset-laby-shared-world.mjs`.
 * Database URL: `FIREBASE_DATABASE_URL` or `VITE_FIREBASE_DATABASE_URL` in `.env`, else default host.
 *
 * Usage:
 *   node scripts/clear-world-loot.mjs --dry-run
 *   node scripts/clear-world-loot.mjs
 *   node scripts/clear-world-loot.mjs --world-id my-custom-world
 *
 * npm:
 *   npm run laby:clear-loot:dry
 *   npm run laby:clear-loot
 */
import dns from 'node:dns/promises'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import admin from 'firebase-admin'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')
const FIREBASE_ADMIN_LOCAL_SA = join(REPO_ROOT, 'scripts', 'firebase-admin.local.json')

const DEFAULT_WORLD_ID = 'fus-world-laby'

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

function tryReadViteFromEnvFiles() {
  const out = { projectId: null, databaseURL: null }
  for (const name of ['.env.local', '.env']) {
    const p = join(REPO_ROOT, name)
    if (!existsSync(p)) continue
    try {
      const raw = readFileSync(p, 'utf8')
      for (const line of raw.split(/\r?\n/)) {
        const mProj = line.match(
          /^\s*VITE_FIREBASE_PROJECT_ID\s*=\s*(?:'([^']*)'|"([^"]*)"|([^\s#]+))/,
        )
        if (mProj && !out.projectId) {
          const v = (mProj[1] ?? mProj[2] ?? mProj[3] ?? '').trim()
          if (v) out.projectId = v
        }
        const mDb = line.match(
          /^\s*VITE_FIREBASE_DATABASE_URL\s*=\s*(?:'([^']*)'|"([^"]*)"|([^\s#]+))/,
        )
        if (mDb && !out.databaseURL) {
          const v = (mDb[1] ?? mDb[2] ?? mDb[3] ?? '').trim()
          if (v) out.databaseURL = v
        }
      }
    } catch {
      /* ignore */
    }
  }
  return out
}

const argv = new Set(process.argv.slice(2))
const dryRun = argv.has('--dry-run')
const worldIdIdx = process.argv.indexOf('--world-id')
const worldId =
  worldIdIdx >= 0 && process.argv[worldIdIdx + 1]
    ? String(process.argv[worldIdIdx + 1])
    : DEFAULT_WORLD_ID

const viteEnv = tryReadViteFromEnvFiles()

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
if (!projectId) projectId = viteEnv.projectId

if (!projectId) {
  console.error(
    'Could not determine Firebase project ID. Set FIREBASE_PROJECT_ID or add VITE_FIREBASE_PROJECT_ID to .env',
  )
  process.exit(1)
}

let databaseURL =
  process.env.FIREBASE_DATABASE_URL || viteEnv.databaseURL
if (!databaseURL) {
  databaseURL = `https://${projectId}-default-rtdb.firebaseio.com`
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
    console.log('[clear-world-loot] Using scripts/firebase-admin.local.json')
    return admin.credential.cert(JSON.parse(readFileSync(FIREBASE_ADMIN_LOCAL_SA, 'utf8')))
  }
  return admin.credential.applicationDefault()
}

async function assertOauth2Resolvable() {
  try {
    await dns.lookup('oauth2.googleapis.com')
  } catch (err) {
    const c = err && err.code
    if (c === 'ENOTFOUND' || c === 'EAI_AGAIN' || c === 'ESERVFAIL') {
      console.error(
        `[clear-world-loot] DNS: cannot resolve oauth2.googleapis.com (${c}). Check network/VPN/DNS.`,
      )
    }
    throw err
  }
}

/**
 * Chunked delete (same strategy as reset-laby) — avoids WRITE_TOO_BIG on huge subtrees.
 * @returns {Promise<number>} remove() call count
 */
async function removeRtdbPathChunked(rtdb, pathStr) {
  const ref = rtdb.ref(pathStr)
  const snap = await ref.get()
  if (!snap.exists()) return 0

  let removed = 0
  const val = snap.val()
  if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
    const keys = Object.keys(val)
    for (const key of keys) {
      removed += await removeRtdbPathChunked(rtdb, `${pathStr}/${key}`)
    }
  }
  await ref.remove()
  return removed + 1
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: resolveAdminCredential(),
    projectId,
    databaseURL,
  })
}

const pathStr = `worldLootDrops/${worldId}`

async function main() {
  await assertOauth2Resolvable()
  console.log(`[clear-world-loot] project=${projectId}`)
  console.log(`[clear-world-loot] databaseURL=${databaseURL}`)
  console.log(`[clear-world-loot] path=${pathStr} dryRun=${dryRun}`)

  const rtdb = admin.database()
  if (dryRun) {
    const snap = await rtdb.ref(pathStr).get()
    console.log(`[dry-run] RTDB ${pathStr} exists=${snap.exists()}`)
    if (snap.exists() && typeof snap.val() === 'object' && snap.val() !== null) {
      const keys = Object.keys(snap.val())
      console.log(`[dry-run] child count ≈ ${keys.length} (showing up to 15 keys)`)
      console.log(keys.slice(0, 15).join(', ') + (keys.length > 15 ? ' …' : ''))
    }
    return
  }

  const n = await removeRtdbPathChunked(rtdb, pathStr)
  if (n === 0) {
    console.log(`[clear-world-loot] ${pathStr} was already empty or missing.`)
  } else {
    console.log(`[clear-world-loot] removed ${pathStr} (${n} delete pass(es), chunked).`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
