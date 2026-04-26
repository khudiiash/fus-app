/**
 * Admin: strip **player terrain edits** and **custom block definitions** for a Laby shared world,
 * without resetting seeds, spawns, mobs, loot, or presence.
 *
 * What it does:
 *   1. RTDB — recursively removes `worldBlockEdits/{worldId}` (pickaxe / block place deltas).
 *   2. Firestore — `sharedWorlds/{worldId}` merge: `customBlocks: []` (admin-placed catalog blocks).
 *      Does **not** change `seeds`, `labySpawn`, or other fields.
 *
 * Credentials + project + DB URL: same as `scripts/clear-world-loot.mjs` / `reset-laby-shared-world.mjs`.
 *
 * Usage:
 *   node scripts/clear-world-terrain-custom-blocks.mjs --dry-run
 *   node scripts/clear-world-terrain-custom-blocks.mjs
 *   node scripts/clear-world-terrain-custom-blocks.mjs --world-id my-world
 *   node scripts/clear-world-terrain-custom-blocks.mjs --rtdb-only
 *   node scripts/clear-world-terrain-custom-blocks.mjs --firestore-only
 *
 * Large `worldBlockEdits/.../cells` trees: the old “chunked” approach called `.get()` on the
 * root and pulled the entire subtree into Node (slow / OOM / timeouts). This script uses
 * **one `remove()`** first (no deep read), then **REST `?shallow=true` + batched PATCH**
 * (`cells/{key}: null` many keys per request, several PATCHes in parallel) if the root
 * `remove()` hits `write_too_big`. Tune with `RTDB_CELLS_PATCH_KEYS` (default 500) and
 * `RTDB_CELLS_PATCH_PARALLEL` (default 32). Shallow fallback needs a **service account JSON**
 * file (same as Admin init); ADC-only may not support token minting for REST here.
 * OAuth for RTDB REST needs **both** `userinfo.email` and `firebase.database` scopes
 * (Firebase “Authenticate REST Requests”); otherwise shallow GET returns 401.
 *
 * npm:
 *   npm run laby:clear-terrain:dry
 *   npm run laby:clear-terrain
 */
import crypto from 'node:crypto'
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
const firestoreOnly = argv.has('--firestore-only')
const worldIdIdx = process.argv.indexOf('--world-id')
const worldId =
  worldIdIdx >= 0 && process.argv[worldIdIdx + 1]
    ? String(process.argv[worldIdIdx + 1])
    : DEFAULT_WORLD_ID

if (rtdbOnly && firestoreOnly) {
  console.error('Use at most one of --rtdb-only / --firestore-only')
  process.exit(1)
}

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

function loadServiceAccountJson() {
  if (credPath) {
    const abs = resolve(credPath)
    if (existsSync(abs)) {
      try {
        return JSON.parse(readFileSync(abs, 'utf8'))
      } catch {
        return null
      }
    }
  }
  if (existsSync(FIREBASE_ADMIN_LOCAL_SA)) {
    try {
      return JSON.parse(readFileSync(FIREBASE_ADMIN_LOCAL_SA, 'utf8'))
    } catch {
      return null
    }
  }
  return null
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
    console.log('[clear-terrain] Using scripts/firebase-admin.local.json')
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
        [
          `[clear-terrain] DNS/network: cannot resolve oauth2.googleapis.com (${c}).`,
          '  The Admin SDK must reach Google for OAuth2. Fix VPN/DNS/firewall, then re-run.',
          '  Quick check: nslookup oauth2.googleapis.com',
        ].join('\n'),
      )
    }
    throw err
  }
}

/** Both scopes are required for RTDB REST admin access; missing `userinfo.email` → 401 Unauthorized. */
const RTDB_REST_SCOPES =
  'https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/firebase.database'

/** @param {Record<string, unknown>} sa */
async function getServiceAccountAccessToken(sa) {
  const email = sa.client_email
  const key = sa.private_key
  if (typeof email !== 'string' || typeof key !== 'string') {
    throw new Error('Service account JSON missing client_email / private_key')
  }
  const now = Math.floor(Date.now() / 1000)
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString(
    'base64url',
  )
  const payload = Buffer.from(
    JSON.stringify({
      iss: email,
      sub: email,
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
      scope: RTDB_REST_SCOPES,
    }),
  ).toString('base64url')
  const sign = crypto.createSign('RSA-SHA256')
  sign.update(`${header}.${payload}`)
  sign.end()
  const signature = sign.sign(key, 'base64url')
  const assertion = `${header}.${payload}.${signature}`

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  })
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`OAuth2 token request failed ${res.status}: ${text.slice(0, 500)}`)
  }
  const j = JSON.parse(text)
  if (!j.access_token) {
    throw new Error('OAuth2 response missing access_token')
  }
  return j.access_token
}

/** @param {string} baseUrl databaseURL without trailing slash */
function rtdbJsonUrl(baseUrl, pathStr) {
  const enc = pathStr
    .split('/')
    .filter(Boolean)
    .map((seg) => encodeURIComponent(seg))
    .join('/')
  return `${baseUrl.replace(/\/$/, '')}/${enc}.json`
}

/** @param {string} baseUrl @param {string} pathStr @param {string} accessToken */
async function rtdbShallowKeys(baseUrl, pathStr, accessToken) {
  const u = new URL(rtdbJsonUrl(baseUrl, pathStr))
  u.searchParams.set('shallow', 'true')
  u.searchParams.set('access_token', accessToken)
  const res = await fetch(u, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`RTDB shallow GET ${pathStr} failed ${res.status}: ${text.slice(0, 300)}`)
  }
  if (text === 'null' || text === '') return []
  const j = JSON.parse(text)
  if (j == null || typeof j !== 'object' || Array.isArray(j)) return []
  return Object.keys(j)
}

/** @param {string} baseUrl @param {string} pathStr @param {string} accessToken */
async function rtdbDeletePath(baseUrl, pathStr, accessToken) {
  const u = new URL(rtdbJsonUrl(baseUrl, pathStr))
  u.searchParams.set('access_token', accessToken)
  const res = await fetch(u, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const text = await res.text()
  if (res.ok || res.status === 404) return
  throw new Error(`RTDB DELETE ${pathStr} failed ${res.status}: ${text.slice(0, 400)}`)
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function rtdbCellsPatchConfig() {
  return {
    keysPerPatch: Math.max(50, Number(process.env.RTDB_CELLS_PATCH_KEYS || 500)),
    parallelPatches: Math.max(1, Number(process.env.RTDB_CELLS_PATCH_PARALLEL || 32)),
  }
}

function isRtdbPatchTooBigStatus(res, text) {
  const lower = `${text}`.toLowerCase()
  return (
    res.status === 413 ||
    lower.includes('write_too_big') ||
    lower.includes('too_big') ||
    lower.includes('payload') ||
    lower.includes('request too large')
  )
}

/**
 * PATCH `pathStr` with `{ key: null, ... }` (removes those children). Splits batch on
 * WRITE_TOO_BIG; retries 429/503 with backoff.
 * @param {string[]} keys
 */
async function rtdbPatchNullChildren(baseUrl, pathStr, keys, accessToken, retryAttempt = 0) {
  if (!keys.length) return
  const body = Object.fromEntries(keys.map((k) => [k, null]))
  const u = new URL(rtdbJsonUrl(baseUrl, pathStr))
  u.searchParams.set('access_token', accessToken)
  const res = await fetch(u, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (res.ok) return
  if ((res.status === 429 || res.status === 503) && retryAttempt < 10) {
    const backoff = Math.min(8000, 400 * 2 ** retryAttempt)
    await sleep(backoff)
    return rtdbPatchNullChildren(baseUrl, pathStr, keys, accessToken, retryAttempt + 1)
  }
  if (isRtdbPatchTooBigStatus(res, text) && keys.length > 1) {
    const mid = Math.floor(keys.length / 2)
    await rtdbPatchNullChildren(baseUrl, pathStr, keys.slice(0, mid), accessToken, 0)
    await rtdbPatchNullChildren(baseUrl, pathStr, keys.slice(mid), accessToken, 0)
    return
  }
  throw new Error(`RTDB PATCH ${pathStr} (${keys.length} keys) failed ${res.status}: ${text.slice(0, 500)}`)
}

/**
 * Remove many sibling keys under `cellsPath` using batched PATCH + parallel waves.
 * @param {string[]} cellKeys
 */
async function rtdbDeleteCellBucketsBatched(baseUrl, cellsPath, cellKeys, accessToken) {
  const { keysPerPatch, parallelPatches } = rtdbCellsPatchConfig()
  const totalPatches = Math.ceil(cellKeys.length / keysPerPatch)
  console.log(
    `[clear-terrain] RTDB: cells batch PATCH keysPerPatch=${keysPerPatch} parallel=${parallelPatches} (~${totalPatches} PATCHes total, parallel waves of ${parallelPatches})`,
  )

  const chunks = []
  for (let i = 0; i < cellKeys.length; i += keysPerPatch) {
    chunks.push(cellKeys.slice(i, i + keysPerPatch))
  }

  let done = 0
  for (let w = 0; w < chunks.length; w += parallelPatches) {
    const wave = chunks.slice(w, w + parallelPatches)
    await Promise.all(
      wave.map((batch) => rtdbPatchNullChildren(baseUrl, cellsPath, batch, accessToken)),
    )
    for (const batch of wave) done += batch.length
    console.log(`[clear-terrain] RTDB: cells PATCH progress ${done}/${cellKeys.length}`)
  }
}

function isRtdbPayloadTooBigError(err) {
  const msg = `${err && err.message ? err.message : err} ${err && err.code ? err.code : ''}`.toLowerCase()
  return (
    msg.includes('write_too_big') ||
    msg.includes('too_big') ||
    msg.includes('payload') ||
    msg.includes('limit exceeded') ||
    msg.includes('data too large')
  )
}

/**
 * Clears `worldBlockEdits/{worldId}` without ever `.get()`-ing the full subtree.
 * @param {any} rtdb
 * @param {{ databaseURL: string, worldId: string, saJson: Record<string, unknown> | null }} opts
 */
async function clearWorldBlockEditsRtdb(rtdb, opts) {
  const { databaseURL, worldId, saJson } = opts
  const root = `worldBlockEdits/${worldId}`
  const base = databaseURL.replace(/\/$/, '')

  console.log(`[clear-terrain] RTDB: single remove() on ${root} (no full-tree download)…`)
  try {
    await rtdb.ref(root).remove()
    console.log(`[clear-terrain] RTDB: remove() finished.`)
    return
  } catch (e) {
    if (!isRtdbPayloadTooBigError(e)) {
      throw e
    }
    console.warn(
      '[clear-terrain] RTDB: root remove() hit size / payload limits; using shallow + batched PATCH (parallel).',
    )
  }

  if (!saJson?.private_key) {
    throw new Error(
      'RTDB fallback needs a service account JSON (GOOGLE_APPLICATION_CREDENTIALS or scripts/firebase-admin.local.json). Application-default credentials alone cannot mint RTDB REST tokens here.',
    )
  }

  const accessToken = await getServiceAccountAccessToken(saJson)
  const cellsPath = `${root}/cells`
  let cellKeys = []
  try {
    cellKeys = await rtdbShallowKeys(base, cellsPath, accessToken)
  } catch (e) {
    const msg = String(e && e.message ? e.message : e)
    if (msg.includes('404') || msg.toLowerCase().includes('not found')) {
      cellKeys = []
    } else {
      throw e
    }
  }

  if (cellKeys.length) {
    console.log(`[clear-terrain] RTDB: clearing ${cellKeys.length} cell bucket key(s) under cells/…`)
    await rtdbDeleteCellBucketsBatched(base, cellsPath, cellKeys, accessToken)
  }
  await rtdbDeletePath(base, cellsPath, accessToken).catch(() => {})

  const topKeys = await rtdbShallowKeys(base, root, accessToken).catch(() => [])
  for (const k of topKeys) {
    await rtdbDeletePath(base, `${root}/${k}`, accessToken)
  }
  console.log(`[clear-terrain] RTDB: shallow fallback finished.`)
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: resolveAdminCredential(),
    projectId,
    databaseURL,
  })
}

const rtdbPath = `worldBlockEdits/${worldId}`

async function main() {
  const saJson = loadServiceAccountJson()
  await assertOauth2Resolvable()
  console.log(`[clear-terrain] project=${projectId}`)
  console.log(`[clear-terrain] databaseURL=${databaseURL}`)
  console.log(`[clear-terrain] worldId=${worldId}`)
  console.log(
    `[clear-terrain] dryRun=${dryRun} rtdbOnly=${rtdbOnly} firestoreOnly=${firestoreOnly}`,
  )

  const rtdb = admin.database()
  const fs = admin.firestore()

  if (!firestoreOnly) {
    if (dryRun) {
      if (!saJson?.private_key) {
        console.log(
          `[dry-run] RTDB ${rtdbPath}: (no service account JSON found — skipping shallow size probe; use credentials for stats)`,
        )
      } else {
        const token = await getServiceAccountAccessToken(saJson)
        const base = databaseURL.replace(/\/$/, '')
        const top = await rtdbShallowKeys(base, rtdbPath, token).catch(() => [])
        const cellPath = `${rtdbPath}/cells`
        const cells = await rtdbShallowKeys(base, cellPath, token).catch(() => [])
        console.log(`[dry-run] RTDB ${rtdbPath} top-level keys: ${top.length ? top.join(', ') : '(missing or empty)'}`)
        console.log(`[dry-run] RTDB ${cellPath} bucket count ≈ ${cells.length}`)
      }
    } else {
      await clearWorldBlockEditsRtdb(rtdb, { databaseURL, worldId, saJson })
    }
  }

  if (!rtdbOnly) {
    const docRef = fs.collection(FIRESTORE_COL).doc(worldId)
    if (dryRun) {
      const snap = await docRef.get()
      console.log(`[dry-run] Firestore ${FIRESTORE_COL}/${worldId} exists=${snap.exists}`)
      if (snap.exists()) {
        const cb = snap.get('customBlocks')
        const len = Array.isArray(cb) ? cb.length : cb == null ? 0 : 'non-array'
        console.log(`[dry-run] customBlocks: ${len}`)
      }
    } else {
      await docRef.set(
        {
          customBlocks: [],
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      )
      console.log(`[clear-terrain] Firestore ${FIRESTORE_COL}/${worldId} customBlocks cleared (merge)`)
    }
  }

  console.log('[clear-terrain] done.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
