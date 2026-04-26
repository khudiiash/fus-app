/**
 * Admin: reset the shared Laby world after a release (clear RTDB + optionally new Firestore seeds).
 *
 * Clears Realtime Database state under `fus-world-laby` (or `--world-id`) for:
 *   block edits, loot, mobs, presence, spawns, PvP karma, combat queues, etc.
 *
 * Firestore `sharedWorlds/{worldId}`:
 *   By default regenerates `seeds` (new terrain) and clears `labySpawn` / `customBlocks`.
 *   Use `--rtdb-only` to skip Firestore, or `--keep-seeds` to clear RTDB only but leave seeds.
 *
 * Credentials (same as `scripts/reverse-block-world-mob-coins.mjs`):
 *   • `scripts/firebase-admin.local.json` (gitignored), or
 *   • `GOOGLE_APPLICATION_CREDENTIALS`, or
 *   • `gcloud auth application-default login`
 *
 * If you see `getaddrinfo ENOTFOUND oauth2.googleapis.com` / `app/invalid-credential`, the
 * machine has no working DNS or route to Google (offline, broken VPN, WSL resolv, firewall).
 * The script is fine — fix network, then re-run.
 * A **404** in the browser for `https://oauth2.googleapis.com` is normal (API host, not a page).
 *
 * Database URL: `FIREBASE_DATABASE_URL` or `VITE_FIREBASE_DATABASE_URL` in `.env` / `.env.local`,
 * else `https://<projectId>-default-rtdb.firebaseio.com` (set env if your instance is regional).
 *
 * Usage:
 *   node scripts/reset-laby-shared-world.mjs --dry-run
 *   node scripts/reset-laby-shared-world.mjs
 *   node scripts/reset-laby-shared-world.mjs --world-id my-world --rtdb-only
 *
 * npm (note the `--` so flags reach the script):
 *   npm run laby:reset-world:dry
 *   npm run laby:reset-world -- --rtdb-only
 */
import dns from 'node:dns/promises'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')
const FIREBASE_ADMIN_LOCAL_SA = join(REPO_ROOT, 'scripts', 'firebase-admin.local.json')

const DEFAULT_WORLD_ID = 'fus-world-laby'
const FIRESTORE_COL = 'sharedWorlds'

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
const rtdbOnly = argv.has('--rtdb-only')
const keepSeeds = argv.has('--keep-seeds')
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
    console.log('[reset-laby-world] Using scripts/firebase-admin.local.json')
    return admin.credential.cert(JSON.parse(readFileSync(FIREBASE_ADMIN_LOCAL_SA, 'utf8')))
  }
  return admin.credential.applicationDefault()
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: resolveAdminCredential(),
    projectId,
    databaseURL,
  })
}

/** @param {string} w */
function rtdbPathsForWorld(w) {
  return [
    `worldBlockEdits/${w}`,
    `worldLootDrops/${w}`,
    `worldPlayerPvp/${w}`,
    `worldPresence/${w}`,
    `worldSpawnFlags/${w}`,
    `worldCombatHits/${w}`,
    `worldCombatDeaths/${w}`,
    `worldPickaxeHits/${w}`,
    `worldPkLootDrops/${w}`,
    `worldMobs/${w}`,
    `worldMobPlayerHits/${w}`,
    `worldMobHits/${w}`,
    `worldMobState/${w}`,
    `worldMobMeta/${w}`,
    `worldMobLease/${w}`,
    `worldMobDeathLoot/${w}`,
    `worldMobCoinDrops/${w}`,
  ]
}

function newSeeds() {
  return {
    noise: Math.random(),
    stone: Math.random(),
    tree: Math.random(),
    coal: Math.random(),
    leaf: Math.random(),
  }
}

/**
 * One {@code ref.remove()} on a huge subtree triggers {@code WRITE_TOO_BIG}. Delete depth-first
 * so each request is small (see Firebase RTDB limits).
 * @returns {Promise<number>} number of {@code remove()} calls
 */
/**
 * Fails early with a clear message when the host cannot reach Google OAuth (common on bad DNS/VPN).
 * Without this, firebase-admin only surfaces a vague "invalid-credential" after a long wait.
 */
async function assertOauth2Resolvable() {
  try {
    await dns.lookup('oauth2.googleapis.com')
  } catch (err) {
    const c = err && err.code
    if (c === 'ENOTFOUND' || c === 'EAI_AGAIN' || c === 'ESERVFAIL') {
      console.error(
        [
          `[reset-laby-world] DNS/network: cannot resolve oauth2.googleapis.com (${c}).`,
          '  The Admin SDK must reach Google to get an OAuth2 access token. Your credentials file is not the problem.',
          '  Check: internet connection, VPN, DNS, firewall, WSL / resolv.conf.',
          '  Quick test: nslookup oauth2.googleapis.com  or  curl -I https://oauth2.googleapis.com',
        ].join('\n'),
      )
    }
    throw err
  }
}

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

async function main() {
  await assertOauth2Resolvable()
  console.log(`[reset-laby-world] project=${projectId}`)
  console.log(`[reset-laby-world] databaseURL=${databaseURL}`)
  console.log(`[reset-laby-world] worldId=${worldId}`)
  console.log(
    `[reset-laby-world] dryRun=${dryRun} rtdbOnly=${rtdbOnly} keepSeeds=${keepSeeds}`,
  )

  const paths = rtdbPathsForWorld(worldId)
  const rtdb = admin.database()

  for (const p of paths) {
    if (dryRun) {
      const snap = await rtdb.ref(p).get()
      console.log(`[dry-run] RTDB ${p} exists=${snap.exists()}`)
      continue
    }
    const n = await removeRtdbPathChunked(rtdb, p)
    if (n === 0) {
      console.log(`[reset-laby-world] RTDB ${p} (already empty / missing)`)
    } else {
      console.log(`[reset-laby-world] RTDB ${p} removed (${n} node delete(s), chunked)`)
    }
  }

  if (rtdbOnly) {
    console.log('[reset-laby-world] done (--rtdb-only, Firestore untouched).')
    return
  }

  if (keepSeeds) {
    console.log('[reset-laby-world] Firestore seeds kept (--keep-seeds).')
    console.log('[reset-laby-world] done.')
    return
  }

  const fs = admin.firestore()
  const docRef = fs.collection(FIRESTORE_COL).doc(worldId)
  if (dryRun) {
    const snap = await docRef.get()
    console.log(`[dry-run] Firestore ${FIRESTORE_COL}/${worldId} exists=${snap.exists}`)
    return
  }

  await docRef.set(
    {
      seeds: newSeeds(),
      customBlocks: [],
      labySpawn: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  )
  console.log(`[reset-laby-world] Firestore ${FIRESTORE_COL}/${worldId} seeds regenerated (merge)`)
  console.log('[reset-laby-world] done.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
