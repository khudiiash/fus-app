/**
 * One-off admin: reverse **coins and XP** from classic block-world mob pickups.
 * Matches `grantStudentCoinsFromGame` (collections.js): coins += amt, xp += ceil(amt*1.5), level recalc — this script subtracts the same.
 *
 * Matches `transactions` where `note` equals the mob-coin journal line (see
 * `src/game/blockWorldMobEconomy.ts` → BLOCK_WORLD_MOB_COIN_TX_NOTE_UA).
 *
 * Project ID is resolved in order: FIREBASE_PROJECT_ID / GCLOUD_PROJECT →
 * GOOGLE_APPLICATION_CREDENTIALS JSON → repo `.firebaserc` (default) → `.env.local` / `.env` (`VITE_FIREBASE_PROJECT_ID`).
 *
 * Credentials (one of):
 *   • Place the service account JSON at `scripts/firebase-admin.local.json` (gitignored), or
 *   • set GOOGLE_APPLICATION_CREDENTIALS=C:\path\to\serviceAccount.json
 *   • or: gcloud auth application-default login
 *
 * Dry run (no writes):
 *   npm run reverse:mob-coins:dry
 *   npm run reverse:mob-coins -- --dry-run
 *   node scripts/reverse-block-world-mob-coins.mjs --dry-run
 *
 * Apply:
 *   npm run reverse:mob-coins
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import admin from 'firebase-admin'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')
/** Optional: drop Firebase “Generate new private key” JSON here (gitignored). */
const FIREBASE_ADMIN_LOCAL_SA = join(REPO_ROOT, 'scripts', 'firebase-admin.local.json')

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

/** Minimal `.env` parse: first `VITE_FIREBASE_PROJECT_ID=value` wins. */
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

const MOB_COIN_NOTE =
  'Світ блоків: монети з мобів'

const REVERSAL_NOTE =
  'Корекція економіки: скасовано нарахування з мобів (світ блоків). Знято монети та відповідний досвід (XP) з профілю.'

function calcLevel(xp) {
  let level = 1
  let threshold = 0
  while (level < 50) {
    threshold += level * 100
    if (xp < threshold) break
    level++
  }
  return Math.min(level, 50)
}

/** Same XP bump as `grantStudentCoinsFromGame` in `src/firebase/collections.js`. */
function xpGrantedForMobCoinAmount(amt) {
  return Math.ceil(Math.max(0, Math.min(5000, Math.round(Number(amt) || 0))) * 1.5)
}

const dryRun = process.argv.includes('--dry-run')

let projectId =
  process.env.FIREBASE_PROJECT_ID ||
  process.env.GCLOUD_PROJECT ||
  null
const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
if (!projectId && credPath) {
  try {
    const raw = readFileSync(resolve(credPath), 'utf8')
    projectId = JSON.parse(raw).project_id || null
  } catch {
    // ignore
  }
}
if (!projectId && existsSync(FIREBASE_ADMIN_LOCAL_SA)) {
  try {
    const raw = readFileSync(FIREBASE_ADMIN_LOCAL_SA, 'utf8')
    projectId = JSON.parse(raw).project_id || null
  } catch {
    // ignore
  }
}
if (!projectId) {
  projectId = tryReadFirebasercProjectId()
}
if (!projectId) {
  projectId = tryReadViteProjectIdFromEnvFiles()
}
if (!projectId) {
  console.error(
    'Could not determine Firebase project ID. Do one of:\n' +
      '  • set FIREBASE_PROJECT_ID=fusapp-5217f\n' +
      '  • ensure `.firebaserc` or `.env` / `.env.local` contains the project (see .env.example)\n' +
      '  • set GOOGLE_APPLICATION_CREDENTIALS to a service account JSON (project_id inside)',
  )
  process.exit(1)
}

console.log(`[reverse-mob-coins] Using project: ${projectId}`)

function resolveAdminCredential() {
  if (credPath) {
    const abs = resolve(credPath)
    if (!existsSync(abs)) {
      console.error(
        `GOOGLE_APPLICATION_CREDENTIALS file not found:\n  ${abs}`,
      )
      process.exit(1)
    }
    try {
      const json = JSON.parse(readFileSync(abs, 'utf8'))
      return admin.credential.cert(json)
    } catch (e) {
      console.error('Failed to read service account JSON:', e?.message || e)
      process.exit(1)
    }
  }
  if (existsSync(FIREBASE_ADMIN_LOCAL_SA)) {
    try {
      const json = JSON.parse(readFileSync(FIREBASE_ADMIN_LOCAL_SA, 'utf8'))
      console.log(
        '[reverse-mob-coins] Using scripts/firebase-admin.local.json (gitignored — do not commit)',
      )
      return admin.credential.cert(json)
    } catch (e) {
      console.error(
        'Failed to read scripts/firebase-admin.local.json:',
        e?.message || e,
      )
      process.exit(1)
    }
  }
  return admin.credential.applicationDefault()
}

if (!admin.apps.length) {
  try {
    admin.initializeApp({
      credential: resolveAdminCredential(),
      projectId,
    })
  } catch (e) {
    console.error(
      'Firebase Admin init failed. Set credentials, e.g.:\n' +
        '  set GOOGLE_APPLICATION_CREDENTIALS=C:\\path\\to\\serviceAccount.json\n' +
        '(Firebase Console → Project settings → Service accounts → Generate new private key)\n' +
        'Or: gcloud auth application-default login\n',
      e?.message || e,
    )
    process.exit(1)
  }
}

const db = admin.firestore()

let snap
try {
  snap = await db
    .collection('transactions')
    .where('note', '==', MOB_COIN_NOTE)
    .get()
} catch (e) {
  if (
    String(e?.message || '').includes('Could not load the default credentials')
  ) {
    console.error(
      'No Google credentials found. Do one of:\n' +
        '  1) Save the service account JSON as scripts/firebase-admin.local.json (see .gitignore)\n' +
        '  2) set GOOGLE_APPLICATION_CREDENTIALS=C:\\path\\to\\key.json\n' +
        '  3) gcloud auth application-default login   (then re-run)\n' +
        '\n' +
        'Note: npm run reverse:mob-coins --dry-run does NOT pass --dry-run. Use:\n' +
        '  npm run reverse:mob-coins:dry\n' +
        '  or: npm run reverse:mob-coins -- --dry-run',
    )
  } else {
    console.error(e)
  }
  process.exit(1)
}

const candidates = snap.docs
  .map((d) => ({ id: d.id, ...d.data() }))
  .filter(
    (row) =>
      row.type === 'award' &&
      row.fromUid &&
      row.fromUid === row.toUid &&
      typeof row.amount === 'number' &&
      row.amount > 0 &&
      !row.mobCoinReversalApplied,
  )

console.log(
  `Found ${snap.size} docs with note match; ${candidates.length} reversible self-awards (positive amount, not yet reversed).`,
)
if (dryRun) {
  let totalCoins = 0
  let totalXp = 0
  for (const row of candidates) {
    const xpR = xpGrantedForMobCoinAmount(row.amount)
    totalCoins += row.amount
    totalXp += xpR
    console.log(
      `  [dry-run] tx=${row.id} uid=${row.toUid} coins=-${row.amount} xp=-${xpR}`,
    )
  }
  console.log(
    `Totals: ${totalCoins} coins and ${totalXp} XP to remove from user profiles (plus level recalc from new XP).`,
  )
  process.exit(0)
}

let ok = 0
let skipped = 0
for (const row of candidates) {
  const txId = row.id
  const uid = row.toUid
  const txRef = db.collection('transactions').doc(txId)
  /** Set only when this run actually performs writes (avoids counting no-op tx as OK). */
  let appliedReversal = false

  try {
    await db.runTransaction(async (t) => {
      appliedReversal = false
      const orig = await t.get(txRef)
      if (!orig.exists) return
      const d = orig.data()
      if (d.mobCoinReversalApplied) return
      if (d.type !== 'award' || d.fromUid !== d.toUid || d.toUid !== uid) return
      const amt = Math.round(Number(d.amount) || 0)
      if (amt <= 0) return
      const xpRemove = xpGrantedForMobCoinAmount(amt)

      const uRef = db.collection('users').doc(uid)
      const uSnap = await t.get(uRef)
      if (!uSnap.exists) {
        throw new Error(`user missing: ${uid}`)
      }
      const u = uSnap.data()
      const prevCoins = u.coins || 0
      const prevXp = u.xp || 0
      const nextCoins = Math.max(0, prevCoins - amt)
      const nextXp = Math.max(0, prevXp - xpRemove)

      t.update(uRef, {
        coins: nextCoins,
        xp: nextXp,
        level: calcLevel(nextXp),
      })

      const revRef = db.collection('transactions').doc()
      t.set(revRef, {
        type: 'award',
        fromUid: uid,
        toUid: uid,
        amount: -amt,
        note: REVERSAL_NOTE,
        reversesTransactionId: txId,
        mobReversalXpRemoved: xpRemove,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      })

      t.update(txRef, {
        mobCoinReversalApplied: admin.firestore.FieldValue.serverTimestamp(),
      })
      appliedReversal = true
    })
  } catch (e) {
    skipped++
    console.warn(
      `SKIP tx=${txId} uid=${uid} (Firestore transaction failed)`,
      e?.message || e,
    )
    continue
  }

  if (!appliedReversal) {
    console.warn(
      `NO-OP tx=${txId} uid=${uid} (already reversed or doc changed — nothing to do)`,
    )
    continue
  }

  ok++
  const logAmt = Math.round(Number(row.amount) || 0)
  const logXp = xpGrantedForMobCoinAmount(logAmt)
  try {
    console.log(
      `OK tx=${txId} uid=${uid} profile: -${logAmt} coins, -${logXp} XP (level recalculated)`,
    )
  } catch (logErr) {
    console.warn(
      `tx=${txId} reversed in Firestore but console failed:`,
      logErr?.message || logErr,
    )
  }
}

console.log(`Done. Reversed: ${ok}, transaction failures: ${skipped}`)
