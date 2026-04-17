import {
  doc,
  setDoc,
  updateDoc,
  onSnapshot,
  getDoc,
  serverTimestamp,
  runTransaction as runFirestoreTransaction,
  type DocumentReference,
} from 'firebase/firestore'
import {
  ref as dbRef,
  onValue,
  onChildAdded,
  onChildChanged,
  onChildRemoved,
  set,
  get,
  update,
  remove,
  serverTimestamp as rtdbServerTimestamp,
  onDisconnect,
  type DataSnapshot,
} from 'firebase/database'
import { db, rtdb } from '@/firebase/config'
import type Terrain from './minebase/terrain'
import Block from './minebase/terrain/mesh/block'
import type { BlockType } from './minebase/terrain'
import { BLOCK_WORLD_MAX_HP_HALF_UNITS } from '@/game/playerConstants'
import { blockWorldAggressiveMobile } from './minebase/utils'

const WORLD_COLLECTION = 'sharedWorlds'
/** Realtime DB path for ephemeral player poses. */
const RTDB_PRESENCE_ROOT = 'worldPresence'
/** Realtime DB path for shared custom block list (low-latency vs Firestore doc). */
const RTDB_WORLD_BLOCKS_ROOT = 'worldBlockEdits'

function worldCustomBlocksRtdbPath(worldId: string) {
  return `${RTDB_WORLD_BLOCKS_ROOT}/${worldId}/customBlocks`
}

function worldBlockEditsRootPath(worldId: string) {
  return `${RTDB_WORLD_BLOCKS_ROOT}/${worldId}`
}

/** One animation frame so flush work does not extend the same long task as the debounce timer. */
function yieldOneFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve())
  })
}

/**
 * Same cell resolution as {@link remoteBlocksFromRtdbRootVal} (legacy then cells overwrite),
 * without allocating the merged array until values are needed.
 */
function mergeRemoteBlockMapFromVal(val: unknown): Map<string, SerializedBlock> {
  const m = new Map<string, SerializedBlock>()
  if (!val || typeof val !== 'object') return m
  const o = val as Record<string, unknown>
  for (const b of blocksFromRtdbVal(o.customBlocks)) {
    m.set(blockCellKey(b), { x: b.x, y: b.y, z: b.z, type: b.type, placed: b.placed })
  }
  const cells = o.cells
  if (cells && typeof cells === 'object') {
    for (const [key, raw] of Object.entries(cells as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object') continue
      const ro = raw as Record<string, unknown>
      const t = Number(ro.t)
      if (!Number.isFinite(t)) continue
      const placed = ro.p === 1 || ro.p === true
      const parts = key.split(',').map((s) => Number(String(s).trim()))
      if (parts.length !== 3 || !parts.every((n) => Number.isFinite(n))) continue
      m.set(key, { x: parts[0], y: parts[1], z: parts[2], type: t, placed })
    }
  }
  return m
}

/** Fingerprint RTDB root without building a merged `SerializedBlock[]` (saves a large alloc per snapshot). */
function fingerprintRtdbRootVal(val: unknown): string {
  const m = mergeRemoteBlockMapFromVal(val)
  let a = 0
  let b = 0
  for (const raw of m.values()) {
    const x = Math.round(raw.x) | 0
    const y = Math.round(raw.y) | 0
    const z = Math.round(raw.z) | 0
    const t = raw.type | 0
    const p = raw.placed ? 0xa5a5a5a5 : 0x5a5a5a5a
    const u =
      (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791) ^ Math.imul(t, 2663) ^ p) >>>
      0
    const v =
      ((x * 0x9e3779b1) ^ (y * 0x85ebca6b) ^ (z * 0xc2b2ae35) ^ (t << 16) ^ (p << 24)) >>> 0
    a ^= u
    b ^= v
  }
  return `${m.size}:${(a >>> 0).toString(16)}:${(b >>> 0).toString(16)}`
}

/** Merge legacy `customBlocks` array with sparse `cells` map (cells win per coordinate). */
function remoteBlocksFromRtdbRootVal(val: unknown): SerializedBlock[] {
  return [...mergeRemoteBlockMapFromVal(val).values()]
}

async function pushSerializedBlocksToCells(worldId: string, blocks: SerializedBlock[]): Promise<void> {
  if (!rtdb || blocks.length === 0) return
  const rootRef = dbRef(rtdb, worldBlockEditsRootPath(worldId))
  const CHUNK = 250
  for (let i = 0; i < blocks.length; i += CHUNK) {
    const slice = blocks.slice(i, i + CHUNK)
    const upd: Record<string, unknown> = {}
    for (const b of slice) {
      upd[`cells/${blockCellKey(b)}`] = { t: b.type, p: b.placed ? 1 : 0 }
    }
    await update(rootRef, upd)
  }
}

async function migrateLegacyCustomBlocksArrayToCells(
  worldId: string,
  legacy: SerializedBlock[],
): Promise<void> {
  if (!rtdb || legacy.length === 0) return
  await pushSerializedBlocksToCells(worldId, sortSerializedBlocks(legacy))
  try {
    await set(dbRef(rtdb, worldCustomBlocksRtdbPath(worldId)), null)
  } catch {
    /* ignore */
  }
}

/**
 * Merge local block list into RTDB using **sparse `cells/{x,y,z}` updates** so each edit sends
 * only changed keys (not the full array). Skips network when fingerprint matches remote.
 */
async function mergePushRtdbWorldBlocks(worldId: string, sortedLocal: SerializedBlock[]): Promise<void> {
  if (!rtdb) return
  await yieldOneFrame()
  const rootRef = dbRef(rtdb, worldBlockEditsRootPath(worldId))
  const snap = await get(rootRef)
  const val = snap.exists() ? snap.val() : null
  const remote = remoteBlocksFromRtdbRootVal(val)
  const merged = sortSerializedBlocks(mergeCustomBlockLists(remote, sortedLocal))
  if (fingerprintBlocksList(merged) === fingerprintBlocksList(remote)) {
    return
  }

  const currentCells =
    val && typeof val === 'object' && (val as Record<string, unknown>).cells != null
      ? ((val as Record<string, unknown>).cells as Record<string, { t?: unknown; p?: unknown }>)
      : {}

  const nextCells: Record<string, { t: number; p: number }> = {}
  for (const b of merged) {
    nextCells[blockCellKey(b)] = { t: b.type, p: b.placed ? 1 : 0 }
  }

  if (merged.length > 350) {
    await yieldOneFrame()
  }

  const updates: Record<string, unknown> = {}
  for (const k of Object.keys(nextCells)) {
    const cur = currentCells[k]
    const nw = nextCells[k]
    const ct = cur != null && typeof cur === 'object' ? Number((cur as { t?: unknown }).t) : Number.NaN
    const cp = cur != null && typeof cur === 'object' ? Number((cur as { p?: unknown }).p) : Number.NaN
    if (!Number.isFinite(ct) || !Number.isFinite(cp) || ct !== nw.t || cp !== nw.p) {
      updates[`cells/${k}`] = nw
    }
  }
  for (const k of Object.keys(currentCells)) {
    if (!(k in nextCells)) {
      updates[`cells/${k}`] = null
    }
  }

  if (Object.keys(updates).length === 0) {
    return
  }

  const keys = Object.keys(updates)
  const CHUNK = 200
  for (let i = 0; i < keys.length; i += CHUNK) {
    const batch: Record<string, unknown> = {}
    for (let j = i; j < Math.min(i + CHUNK, keys.length); j++) {
      const k = keys[j]
      batch[k] = updates[k]
    }
    await update(rootRef, batch)
  }
}

let activePresenceDisconnect: ReturnType<typeof onDisconnect> | null = null

export type SharedWorldSeeds = {
  noise: number
  stone: number
  tree: number
  coal: number
  leaf: number
}

export type SerializedBlock = {
  x: number
  y: number
  z: number
  type: number
  placed: boolean
}

function sortSerializedBlocks(blocks: SerializedBlock[]) {
  return [...blocks].sort(
    (a, b) =>
      a.x - b.x ||
      a.y - b.y ||
      a.z - b.z ||
      a.type - b.type ||
      Number(a.placed) - Number(b.placed),
  )
}

/**
 * Order-independent multiset fingerprint, O(n). Used to skip redundant syncs.
 * (Avoids sort + JSON.stringify on large `customBlocks` arrays — that froze the main thread on each edit.)
 */
export function fingerprintBlocksList(blocks: SerializedBlock[]): string {
  let a = 0
  let b = 0
  for (const raw of blocks) {
    const x = Math.round(raw.x) | 0
    const y = Math.round(raw.y) | 0
    const z = Math.round(raw.z) | 0
    const t = raw.type | 0
    const p = raw.placed ? 0xa5a5a5a5 : 0x5a5a5a5a
    const u =
      (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791) ^ Math.imul(t, 2663) ^ p) >>>
      0
    const v =
      ((x * 0x9e3779b1) ^ (y * 0x85ebca6b) ^ (z * 0xc2b2ae35) ^ (t << 16) ^ (p << 24)) >>> 0
    a ^= u
    b ^= v
  }
  return `${blocks.length}:${(a >>> 0).toString(16)}:${(b >>> 0).toString(16)}`
}

function blockCellKey(b: Pick<SerializedBlock, 'x' | 'y' | 'z'>): string {
  return `${b.x},${b.y},${b.z}`
}

/**
 * Merge remote block list with this client's view: same cell (x,y,z) prefers **local**
 * so rapid local edits are not wiped during RTDB transactions.
 */
export function mergeCustomBlockLists(
  remote: SerializedBlock[],
  local: SerializedBlock[],
): SerializedBlock[] {
  const m = new Map<string, SerializedBlock>()
  for (const b of remote) {
    m.set(blockCellKey(b), {
      x: b.x,
      y: b.y,
      z: b.z,
      type: b.type,
      placed: b.placed,
    })
  }
  for (const b of local) {
    m.set(blockCellKey(b), {
      x: b.x,
      y: b.y,
      z: b.z,
      type: b.type,
      placed: b.placed,
    })
  }
  return [...m.values()]
}

function randomSeed() {
  return Math.random()
}

function isValidSharedWorldSeeds(value: unknown): value is SharedWorldSeeds {
  if (!value || typeof value !== 'object') return false
  const o = value as Record<string, unknown>
  return ['noise', 'stone', 'tree', 'coal', 'leaf'].every((k) =>
    Number.isFinite(Number(o[k])),
  )
}

/** Stable numeric copy for hashing and cross-device parity. */
export function normalizeSharedWorldSeeds(raw: SharedWorldSeeds): SharedWorldSeeds {
  return {
    noise: Number(raw.noise),
    stone: Number(raw.stone),
    tree: Number(raw.tree),
    coal: Number(raw.coal),
    leaf: Number(raw.leaf),
  }
}

/**
 * Old `sharedWorlds/*` rows may lack `seeds`. Must be atomic: concurrent clients used to each
 * `updateDoc` their own random bundle and keep different in-memory worlds while Firestore showed one.
 */
async function ensureSeedsOnWorldDoc(
  worldDocRef: DocumentReference,
  data: Record<string, unknown> | undefined,
): Promise<SharedWorldSeeds | undefined> {
  const raw = data?.seeds
  if (isValidSharedWorldSeeds(raw)) {
    return normalizeSharedWorldSeeds(raw)
  }
  try {
    const seeds = await runFirestoreTransaction(db, async (transaction) => {
      const snap = await transaction.get(worldDocRef)
      if (!snap.exists()) return undefined
      const d = snap.data() as Record<string, unknown>
      if (isValidSharedWorldSeeds(d?.seeds)) {
        return normalizeSharedWorldSeeds(d.seeds as SharedWorldSeeds)
      }
      const next: SharedWorldSeeds = {
        noise: randomSeed(),
        stone: randomSeed(),
        tree: randomSeed(),
        coal: randomSeed(),
        leaf: randomSeed(),
      }
      transaction.update(worldDocRef, {
        seeds: next,
        updatedAt: serverTimestamp(),
      })
      return next
    })
    return seeds ? normalizeSharedWorldSeeds(seeds) : undefined
  } catch (e) {
    console.warn('[sharedWorld] ensureSeedsOnWorldDoc transaction', e)
    const snap = await getDoc(worldDocRef)
    const d = snap.data() as Record<string, unknown> | undefined
    if (isValidSharedWorldSeeds(d?.seeds)) {
      return normalizeSharedWorldSeeds(d.seeds as SharedWorldSeeds)
    }
    return undefined
  }
}

/** Stable JSON fingerprint for world doc remote state (seeds + custom blocks). */
export function fingerprintSharedWorldDoc(data: Record<string, unknown> | undefined) {
  const seeds = data?.seeds as SharedWorldSeeds | undefined
  const rawBlocks = (data?.customBlocks ?? []) as SerializedBlock[]
  return JSON.stringify({ seeds: seeds ?? null, blocks: sortSerializedBlocks(rawBlocks) })
}

function serializedBlocksFromTerrain(terrain: Terrain): SerializedBlock[] {
  return terrain.customBlocks.map((b) => ({
    x: b.x,
    y: b.y,
    z: b.z,
    type: b.type as number,
    placed: b.placed,
  }))
}

function parseSerializedBlock(raw: unknown): SerializedBlock | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const x = Number(o.x)
  const y = Number(o.y)
  const z = Number(o.z)
  const type = Number(o.type)
  if (![x, y, z, type].every((n) => Number.isFinite(n))) return null
  return {
    x,
    y,
    z,
    type,
    placed: Boolean(o.placed),
  }
}

/** Normalize RTDB value (array or legacy object map) to a block list. */
function blocksFromRtdbVal(val: unknown): SerializedBlock[] {
  if (val == null) return []
  if (Array.isArray(val)) {
    const out: SerializedBlock[] = []
    for (const item of val) {
      const b = parseSerializedBlock(item)
      if (b) out.push(b)
    }
    return out
  }
  if (typeof val === 'object') {
    const out: SerializedBlock[] = []
    for (const v of Object.values(val as Record<string, unknown>)) {
      const b = parseSerializedBlock(v)
      if (b) out.push(b)
    }
    return out
  }
  return []
}

/** True when live terrain already matches the remote block list (skip redundant worker regen). */
function terrainMatchesBlockList(terrain: Terrain, rawBlocks: SerializedBlock[]) {
  return (
    fingerprintBlocksList(rawBlocks) ===
    fingerprintBlocksList(serializedBlocksFromTerrain(terrain))
  )
}

/** Canonical Laby (js-minecraft) spawn on `sharedWorlds/{id}` — same world + same feet position on every device. */
export type LabySpawnPose = { x: number; y: number; z: number }

function parseLabySpawn(raw: unknown): LabySpawnPose | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const x = Number(o.x)
  const y = Number(o.y)
  const z = Number(o.z)
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null
  if (!Number.isFinite(y)) return { x, y: Number.NaN, z }
  return { x, y, z }
}

export type SharedWorldInitialState = {
  seeds: SharedWorldSeeds | undefined
  blocks: SerializedBlock[]
  blocksFingerprint: string
  /** When set, Laby uses this pose instead of local `findSpawn()`. */
  labySpawn: LabySpawnPose | null
}

/**
 * Ensure `sharedWorlds/{worldId}` exists, migrate Firestore → RTDB custom blocks when needed,
 * and return the canonical block list + fingerprint (no {@link Terrain} required).
 */
export async function loadSharedWorldInitialState(
  worldId: string,
): Promise<SharedWorldInitialState> {
  const worldDocRef = doc(db, WORLD_COLLECTION, worldId)

  /** One writer wins — avoids two clients minting different `seeds` for the same world id. */
  await runFirestoreTransaction(db, async (tx) => {
    const s = await tx.get(worldDocRef)
    if (s.exists()) return
    const seeds: SharedWorldSeeds = {
      noise: randomSeed(),
      stone: randomSeed(),
      tree: randomSeed(),
      coal: randomSeed(),
      leaf: randomSeed(),
    }
    tx.set(worldDocRef, {
      seeds,
      customBlocks: [] as SerializedBlock[],
      updatedAt: serverTimestamp(),
    })
  })

  const snap = await getDoc(worldDocRef)
  if (!snap.exists()) {
    console.error('[sharedWorld] sharedWorlds doc missing after create transaction:', worldId)
    return {
      seeds: undefined,
      blocks: [],
      blocksFingerprint: fingerprintBlocksList([]),
      labySpawn: null,
    }
  }

  let data = snap.data() as Record<string, unknown> | undefined
  const seeds = await ensureSeedsOnWorldDoc(worldDocRef, data)
  if (!isValidSharedWorldSeeds(data?.seeds)) {
    const again = await getDoc(worldDocRef)
    data = again.data() as Record<string, unknown> | undefined
  }
  const fsBlocksRaw = (data?.customBlocks ?? []) as SerializedBlock[]
  const fsBlocks = sortSerializedBlocks(
    fsBlocksRaw
      .map((b) => parseSerializedBlock(b))
      .filter((b): b is SerializedBlock => b != null),
  )

  if (rtdb) {
    const rootRef = dbRef(rtdb, worldBlockEditsRootPath(worldId))
    let rootSnap = await get(rootRef)
    let val = rootSnap.exists() ? rootSnap.val() : null
    let legacy = blocksFromRtdbVal(val != null && typeof val === 'object' ? (val as { customBlocks?: unknown }).customBlocks : null)
    const cellKeyCount =
      val != null &&
      typeof val === 'object' &&
      (val as { cells?: unknown }).cells != null &&
      typeof (val as { cells: unknown }).cells === 'object'
        ? Object.keys((val as { cells: Record<string, unknown> }).cells).length
        : 0
    if (legacy.length > 0 && cellKeyCount === 0) {
      await migrateLegacyCustomBlocksArrayToCells(worldId, legacy)
      rootSnap = await get(rootRef)
      val = rootSnap.exists() ? rootSnap.val() : null
    }
    let rtdbBlocks = remoteBlocksFromRtdbRootVal(val)
    if (!rootSnap.exists() && rtdbBlocks.length === 0 && fsBlocks.length === 0) {
      await set(rootRef, { customBlocks: [] })
    }
    if (rtdbBlocks.length === 0 && fsBlocks.length > 0) {
      await pushSerializedBlocksToCells(worldId, fsBlocks)
      rootSnap = await get(rootRef)
      val = rootSnap.exists() ? rootSnap.val() : null
      rtdbBlocks = remoteBlocksFromRtdbRootVal(val)
    }
    return {
      seeds: seeds ? normalizeSharedWorldSeeds(seeds) : undefined,
      blocks: rtdbBlocks,
      blocksFingerprint: fingerprintBlocksList(rtdbBlocks),
      labySpawn: parseLabySpawn(data?.labySpawn),
    }
  }

  return {
    seeds: seeds ? normalizeSharedWorldSeeds(seeds) : undefined,
    blocks: fsBlocks,
    blocksFingerprint: fingerprintBlocksList(fsBlocks),
    labySpawn: parseLabySpawn(data?.labySpawn),
  }
}

/**
 * First client persists full spawn `{x,y,z}`; others load it from {@link loadSharedWorldInitialState}.
 * Call after spawn chunks are ready (`getSpawn()` Y is final). If the returned pose differs, move the player.
 */
/** Latest `labySpawn` from Firestore (for “teleport to shared spawn” without reloading the whole world). */
export async function fetchSharedWorldLabySpawnPose(worldId: string): Promise<LabySpawnPose | null> {
  const worldDocRef = doc(db, WORLD_COLLECTION, worldId)
  const snap = await getDoc(worldDocRef)
  if (!snap.exists()) return null
  const d = snap.data() as Record<string, unknown>
  return parseLabySpawn(d?.labySpawn)
}

export async function ensureSharedWorldLabySpawn(
  worldId: string,
  candidate: LabySpawnPose,
): Promise<LabySpawnPose> {
  const worldDocRef = doc(db, WORLD_COLLECTION, worldId)
  const out = await runFirestoreTransaction(db, async (tx) => {
    const snap = await tx.get(worldDocRef)
    if (!snap.exists()) return candidate
    const d = snap.data() as Record<string, unknown>
    const existing = parseLabySpawn(d?.labySpawn)
    if (existing && Number.isFinite(existing.x) && Number.isFinite(existing.z) && Number.isFinite(existing.y)) {
      return existing
    }
    if (existing && Number.isFinite(existing.x) && Number.isFinite(existing.z) && !Number.isFinite(existing.y)) {
      const merged: LabySpawnPose = { x: existing.x, y: candidate.y, z: existing.z }
      tx.update(worldDocRef, {
        labySpawn: merged,
        updatedAt: serverTimestamp(),
      })
      return merged
    }
    const pose: LabySpawnPose = {
      x: candidate.x,
      y: candidate.y,
      z: candidate.z,
    }
    tx.update(worldDocRef, {
      labySpawn: pose,
      updatedAt: serverTimestamp(),
    })
    return pose
  })
  return out
}

/** Overwrites Firestore `labySpawn` (canonical meeting point for all clients). */
export async function overwriteSharedWorldLabySpawn(worldId: string, pose: LabySpawnPose): Promise<void> {
  if (!Number.isFinite(pose.x) || !Number.isFinite(pose.z)) return
  const worldDocRef = doc(db, WORLD_COLLECTION, worldId)
  await updateDoc(worldDocRef, {
    labySpawn: {
      x: pose.x,
      y: Number.isFinite(pose.y) ? pose.y : 64,
      z: pose.z,
    },
    updatedAt: serverTimestamp(),
  })
}

/**
 * Ensure world doc exists with noise seeds; load custom blocks from RTDB (migrates from Firestore once if needed).
 * @returns blocks fingerprint for {@link subscribeSharedWorldDoc} to skip the first redundant regen.
 */
export async function initSharedWorldFromFirestore(
  worldId: string,
  terrain: Terrain,
): Promise<string> {
  const { seeds, blocks } = await loadSharedWorldInitialState(worldId)
  if (seeds) {
    terrain.noise.seed = seeds.noise
    terrain.noise.stoneSeed = seeds.stone
    terrain.noise.treeSeed = seeds.tree
    terrain.noise.coalSeed = seeds.coal
    terrain.noise.leafSeed = seeds.leaf
  }
  terrain.customBlocks = blocks.map(
    (b) => new Block(b.x, b.y, b.z, b.type as BlockType, b.placed),
  )
  return fingerprintBlocksList(serializedBlocksFromTerrain(terrain))
}

/**
 * Live custom block list (same source as {@link subscribeSharedWorldDoc}).
 * When RTDB is configured, listens there; otherwise listens on the Firestore world document.
 */
export function subscribeSharedWorldCustomBlocks(
  worldId: string,
  onBlocks: (blocks: SerializedBlock[]) => void,
  /** From {@link loadSharedWorldInitialState} to skip the first duplicate callback. */
  initialFingerprint = '',
): () => void {
  if (!rtdb) {
    const worldDocRef = doc(db, WORLD_COLLECTION, worldId)
    let lastFp = initialFingerprint
    return onSnapshot(worldDocRef, (snap) => {
      if (!snap.exists()) return
      if (snap.metadata.hasPendingWrites) return
      const data = snap.data() as Record<string, unknown> | undefined
      const rawBlocks = ((data?.customBlocks ?? []) as unknown[])
        .map((b) => parseSerializedBlock(b))
        .filter((b): b is SerializedBlock => b != null)
      const fp = fingerprintBlocksList(rawBlocks)
      if (fp === lastFp) return
      lastFp = fp
      onBlocks(rawBlocks)
    })
  }

  const rootRef = dbRef(rtdb, worldBlockEditsRootPath(worldId))
  let lastFp = initialFingerprint
  let rtdbBlocksRaf = 0
  let latestRtdbVal: unknown | undefined
  const deliverRtdbBlocks = () => {
    rtdbBlocksRaf = 0
    while (latestRtdbVal !== undefined) {
      const val = latestRtdbVal
      latestRtdbVal = undefined
      const rawBlocks = remoteBlocksFromRtdbRootVal(val)
      const fp = fingerprintBlocksList(rawBlocks)
      if (fp !== lastFp) {
        lastFp = fp
        onBlocks(rawBlocks)
      }
    }
  }
  const scheduleRtdbBlocksDelivery = () => {
    if (rtdbBlocksRaf) return
    rtdbBlocksRaf = requestAnimationFrame(deliverRtdbBlocks)
  }
  const unsubRtdb = onValue(rootRef, (snap) => {
    const val = snap.exists() ? snap.val() : null
    const fp = fingerprintRtdbRootVal(val)
    if (fp === lastFp) return
    latestRtdbVal = val
    scheduleRtdbBlocksDelivery()
  })
  return () => {
    if (rtdbBlocksRaf) cancelAnimationFrame(rtdbBlocksRaf)
    rtdbBlocksRaf = 0
    latestRtdbVal = undefined
    unsubRtdb()
  }
}

export function subscribeSharedWorldDoc(
  worldId: string,
  terrain: Terrain,
  onRemoteCustomBlocks: () => void,
  /** From {@link initSharedWorldFromFirestore} so the first listener value does not redundant-regenerate. */
  initialFingerprint = '',
) {
  if (!rtdb) {
    const worldDocRef = doc(db, WORLD_COLLECTION, worldId)
    let lastRemoteFingerprint = initialFingerprint
    return onSnapshot(worldDocRef, (snap) => {
      if (!snap.exists()) return
      if (snap.metadata.hasPendingWrites) return
      const data = snap.data() as Record<string, unknown> | undefined
      const seeds = data?.seeds as SharedWorldSeeds | undefined
      const rawBlocks = ((data?.customBlocks ?? []) as SerializedBlock[])
        .map((b) => parseSerializedBlock(b))
        .filter((b): b is SerializedBlock => b != null)
      const fingerprint = fingerprintSharedWorldDoc(data)
      if (fingerprint === lastRemoteFingerprint) return

      if (terrainMatchesBlockList(terrain, rawBlocks)) {
        lastRemoteFingerprint = fingerprint
        return
      }

      lastRemoteFingerprint = fingerprint

      if (seeds) {
        terrain.noise.seed = seeds.noise
        terrain.noise.stoneSeed = seeds.stone
        terrain.noise.treeSeed = seeds.tree
        terrain.noise.coalSeed = seeds.coal
        terrain.noise.leafSeed = seeds.leaf
      }
      terrain.customBlocks = rawBlocks.map(
        (b) => new Block(b.x, b.y, b.z, b.type as BlockType, b.placed),
      )
      onRemoteCustomBlocks()
    })
  }

  const rootRef = dbRef(rtdb, worldBlockEditsRootPath(worldId))
  let lastFp = initialFingerprint
  return onValue(rootRef, (snap) => {
    const rawBlocks = remoteBlocksFromRtdbRootVal(snap.exists() ? snap.val() : null)
    const fp = fingerprintBlocksList(rawBlocks)
    if (fp === lastFp) return
    if (terrainMatchesBlockList(terrain, rawBlocks)) {
      lastFp = fp
      return
    }
    lastFp = fp
    terrain.customBlocks = rawBlocks.map(
      (b) => new Block(b.x, b.y, b.z, b.type as BlockType, b.placed),
    )
    onRemoteCustomBlocks()
  })
}

let flushTimer: ReturnType<typeof setTimeout> | null = null
let flushChain: Promise<void> = Promise.resolve()

const FLUSH_DEBOUNCE_MS = 55

/** Drop a pending debounced flush (e.g. before restoring world so stale edits are not written). */
export function cancelScheduledFlushCustomBlocks() {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
}
/** Max chained flushes when terrain keeps changing during writes (fast build/break). */
const FLUSH_MAX_ROUNDS = 12

export function scheduleFlushCustomBlocks(worldId: string, terrain: Terrain) {
  if (flushTimer) clearTimeout(flushTimer)
  const debounceMs = blockWorldAggressiveMobile() ? 105 : FLUSH_DEBOUNCE_MS
  flushTimer = setTimeout(() => {
    flushTimer = null
    flushChain = flushChain.then(() => flushCustomBlocksNow(worldId, terrain)).catch((e) => {
      console.warn('[sharedWorld] flushCustomBlocks', e)
    })
  }, debounceMs)
}

async function flushCustomBlocksNow(worldId: string, terrain: Terrain) {
  if (!rtdb) {
    const worldDocRef = doc(db, WORLD_COLLECTION, worldId)
    for (let round = 0; round < FLUSH_MAX_ROUNDS; round++) {
      const beforeFp = fingerprintBlocksList(serializedBlocksFromTerrain(terrain))
      await runFirestoreTransaction(db, async (tx) => {
        const snap = await tx.get(worldDocRef)
        const data = snap.data() ?? {}
        const remote = ((data.customBlocks ?? []) as SerializedBlock[])
          .map((b) => parseSerializedBlock(b))
          .filter((b): b is SerializedBlock => b != null)
        const local = serializedBlocksFromTerrain(terrain)
        const merged = sortSerializedBlocks(mergeCustomBlockLists(remote, local))
        tx.set(
          worldDocRef,
          {
            customBlocks: merged,
            updatedAt: serverTimestamp(),
          },
          { merge: true },
        )
      })
      const afterFp = fingerprintBlocksList(serializedBlocksFromTerrain(terrain))
      if (afterFp === beforeFp) break
    }
    return
  }

  for (let round = 0; round < FLUSH_MAX_ROUNDS; round++) {
    const beforeFp = fingerprintBlocksList(serializedBlocksFromTerrain(terrain))
    const localSorted = sortSerializedBlocks(serializedBlocksFromTerrain(terrain))
    await mergePushRtdbWorldBlocks(worldId, localSorted)
    const afterFp = fingerprintBlocksList(serializedBlocksFromTerrain(terrain))
    if (afterFp === beforeFp) break
  }
}

let flushSharedListTimer: ReturnType<typeof setTimeout> | null = null
let flushSharedListChain: Promise<void> = Promise.resolve()

/** Cancel debounced {@link scheduleFlushSharedWorldBlocksList} (e.g. when leaving world-next). */
export function cancelScheduledFlushSharedWorldBlocksList() {
  if (flushSharedListTimer) {
    clearTimeout(flushSharedListTimer)
    flushSharedListTimer = null
  }
}

let rtdbCellPatchTimer: ReturnType<typeof setTimeout> | null = null
let rtdbCellPatchChain: Promise<void> = Promise.resolve()

/** Cancel debounced {@link scheduleRtdbCellPatches} (Laby incremental RTDB flush). */
export function cancelScheduledRtdbCellPatches() {
  if (rtdbCellPatchTimer) {
    clearTimeout(rtdbCellPatchTimer)
    rtdbCellPatchTimer = null
  }
}

export type RtdbCellPatchTakeResult = {
  keys: string[]
  /** Per-key cell to write; missing key or `undefined` value ⇒ delete RTDB cell. */
  cells: Map<string, SerializedBlock | undefined>
}

export type ScheduleRtdbCellPatchOptions = ScheduleSharedWorldBlocksListOptions & {
  onPushed?: (payload: RtdbCellPatchTakeResult) => void
}

/**
 * Debounced **sparse** RTDB `cells/{x,y,z}` writes (no full-doc read/merge on each edit).
 * Used by the Laby shared bridge so mine/place stays responsive like the terrain worker world.
 */
export function scheduleRtdbCellPatches(
  worldId: string,
  takePending: () => RtdbCellPatchTakeResult | null,
  options?: ScheduleRtdbCellPatchOptions,
) {
  if (!rtdb) return
  if (rtdbCellPatchTimer) clearTimeout(rtdbCellPatchTimer)
  const debounceMs =
    options?.debounceMs ?? (blockWorldAggressiveMobile() ? 85 : 45)
  rtdbCellPatchTimer = setTimeout(() => {
    rtdbCellPatchTimer = null
    const batch = takePending()
    if (!batch || batch.keys.length === 0) return
    rtdbCellPatchChain = rtdbCellPatchChain
      .then(() => pushRtdbSparseCellUpdates(worldId, batch.keys, batch.cells))
      .then(() => {
        try {
          options?.onPushed?.(batch)
        } catch {
          /* ignore */
        }
      })
      .catch((e) => {
        console.warn('[sharedWorld] pushRtdbSparseCellUpdates', e)
      })
  }, debounceMs)
}

async function pushRtdbSparseCellUpdates(
  worldId: string,
  keys: string[],
  cells: Map<string, SerializedBlock | undefined>,
) {
  await yieldOneFrame()
  const rootRef = dbRef(rtdb!, worldBlockEditsRootPath(worldId))
  const CHUNK = 72
  for (let i = 0; i < keys.length; i += CHUNK) {
    const slice = keys.slice(i, i + CHUNK)
    const upd: Record<string, unknown> = {}
    for (const k of slice) {
      const b = cells.get(k)
      if (!b) {
        upd[`cells/${k}`] = null
      } else {
        upd[`cells/${k}`] = { t: b.type, p: b.placed ? 1 : 0 }
      }
    }
    await update(rootRef, upd)
    if (keys.length > CHUNK) await yieldOneFrame()
  }
}

function parseRtdbCellSnapshot(key: string, val: unknown): SerializedBlock | null {
  if (!val || typeof val !== 'object') return null
  const o = val as Record<string, unknown>
  const t = Number(o.t)
  if (!Number.isFinite(t)) return null
  const placed = o.p === 1 || o.p === true
  const parts = key.split(',').map((s) => Number(String(s).trim()))
  if (parts.length !== 3 || !parts.every((n) => Number.isFinite(n))) return null
  return { x: parts[0], y: parts[1], z: parts[2], type: t, placed }
}

export type RtdbWorldCellDelta =
  | { kind: 'upsert'; key: string; block: SerializedBlock }
  | { kind: 'remove'; key: string }

/**
 * Incremental RTDB listener on `cells/*` (one child event per edit instead of re-parsing the whole tree).
 * Pair with {@link scheduleRtdbCellPatches} for Laby; keep {@link subscribeSharedWorldCustomBlocks} for Firestore-only.
 */
export function subscribeRtdbWorldBlockCells(
  worldId: string,
  onDelta: (d: RtdbWorldCellDelta) => void,
): () => void {
  if (!rtdb) {
    return () => {}
  }
  const cellsRef = dbRef(rtdb, `${worldBlockEditsRootPath(worldId)}/cells`)
  const handleUpsert = (snap: DataSnapshot) => {
    const key = snap.key
    if (!key) return
    const block = parseRtdbCellSnapshot(key, snap.val())
    if (block) onDelta({ kind: 'upsert', key, block })
  }
  const handleRemove = (snap: DataSnapshot) => {
    const key = snap.key
    if (key) onDelta({ kind: 'remove', key })
  }
  const u1 = onChildAdded(cellsRef, (s) => handleUpsert(s))
  const u2 = onChildChanged(cellsRef, (s) => handleUpsert(s))
  const u3 = onChildRemoved(cellsRef, (s) => handleRemove(s))
  return () => {
    try {
      u1()
    } catch {
      /* ignore */
    }
    try {
      u2()
    } catch {
      /* ignore */
    }
    try {
      u3()
    } catch {
      /* ignore */
    }
  }
}

export type ScheduleSharedWorldBlocksListOptions = {
  /** Override debounce (ms); Laby can use a higher value on touch devices to cut RTDB churn. */
  debounceMs?: number
}

/**
 * Merge `getLocalBlocks()` into Firestore / RTDB the same way as terrain-based flushes
 * ({@link scheduleFlushCustomBlocks}), without a {@link Terrain} instance.
 */
export function scheduleFlushSharedWorldBlocksList(
  worldId: string,
  getLocalBlocks: () => SerializedBlock[],
  options?: ScheduleSharedWorldBlocksListOptions,
) {
  if (flushSharedListTimer) clearTimeout(flushSharedListTimer)
  const debounceMs =
    options?.debounceMs ?? (blockWorldAggressiveMobile() ? 105 : FLUSH_DEBOUNCE_MS)
  flushSharedListTimer = setTimeout(() => {
    flushSharedListTimer = null
    const list = getLocalBlocks()
    flushSharedListChain = flushSharedListChain
      .then(() => flushSharedWorldCustomBlocksList(worldId, list))
      .catch((e) => {
        console.warn('[sharedWorld] flushSharedWorldCustomBlocksList', e)
      })
  }, debounceMs)
}

/** One RTDB / Firestore transaction: remote ⊕ `localBlocks` (per-cell local wins, same as terrain flush). */
export async function flushSharedWorldCustomBlocksList(
  worldId: string,
  localBlocks: SerializedBlock[],
): Promise<void> {
  await yieldOneFrame()
  const sorted = sortSerializedBlocks(
    localBlocks
      .map((b) => parseSerializedBlock(b))
      .filter((b): b is SerializedBlock => b != null),
  )
  if (!rtdb) {
    const worldDocRef = doc(db, WORLD_COLLECTION, worldId)
    await runFirestoreTransaction(db, async (tx) => {
      const snap = await tx.get(worldDocRef)
      const data = snap.data() ?? {}
      const remote = ((data.customBlocks ?? []) as unknown[])
        .map((b) => parseSerializedBlock(b))
        .filter((b): b is SerializedBlock => b != null)
      const merged = sortSerializedBlocks(mergeCustomBlockLists(remote, sorted))
      tx.set(
        worldDocRef,
        {
          customBlocks: merged,
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      )
    })
    return
  }
  await mergePushRtdbWorldBlocks(worldId, sorted)
}

export type PresenceDoc = {
  x: number
  y: number
  z: number
  ry: number
  /** Head yaw offset on skin rig (rad); vanilla `rotationYawHead − rotationYaw`. */
  hr: number
  moving: boolean
  skinUrl: string | null
  /** Profile photo (HTTPS) for nameplate when present. */
  photoUrl?: string | null
  displayName: string
  /** Hotbar / hand: mine + pickaxe vs build + block. */
  mode?: 'mine' | 'build'
  /** Hotbar index (dynamic length from inventory). */
  slot?: number
  /** Terrain {@link BlockType} value when {@link mode} is `build`. */
  bwBlockType?: number
  /** When {@link mode} is `mine`: empty hand vs tool model. */
  bwHandMine?: 'fist' | 'tool'
  /** glTF node name in `tools.glb` when holding a tool. */
  bwToolMesh?: string | null
  /** Increments on each mine/place swing; remotes animate the held item. */
  handSwingSeq?: number
  /** Block-world HP in half-hearts (0–20). */
  playerHpHalfUnits?: number
  /** Soft-delete so others hide this avatar without requiring delete permission. */
  left?: boolean
}

/** Hide presence if no heartbeat (tab killed / network lost) — normal play updates every ≤200ms. */
const STALE_PRESENCE_MS = 120_000

function presenceUpdatedAtMs(v: Record<string, unknown>): number {
  const u = v.updatedAt
  if (typeof u === 'number' && Number.isFinite(u)) return u
  return 0
}

function parsePresenceChild(
  v: Partial<PresenceDoc> & Record<string, unknown>,
  now: number,
): PresenceDoc | null {
  if (v?.left === true) return null
  const updatedMs = presenceUpdatedAtMs(v)
  if (updatedMs > 0 && now - updatedMs > STALE_PRESENCE_MS) return null
  const slotRaw = Number(v.slot)
  const slot =
    Number.isFinite(slotRaw) && slotRaw >= 0 && slotRaw <= 24
      ? Math.floor(slotRaw)
      : 0
  const bwBt = Number(v.bwBlockType)
  const bwBlockType =
    Number.isFinite(bwBt) && bwBt >= 0 && bwBt <= 11 ? Math.floor(bwBt) : 0
  const bwHandMine = v.bwHandMine === 'tool' ? 'tool' : 'fist'
  let bwToolMesh: string | null = null
  const tm = v.bwToolMesh
  if (typeof tm === 'string' && tm.length > 0 && tm.length <= 80) {
    bwToolMesh = tm.slice(0, 80)
  }
  const swingRaw = Number(v.handSwingSeq)
  const handSwingSeq =
    Number.isFinite(swingRaw) && swingRaw >= 0 ? Math.floor(swingRaw) : 0
  const hpRaw = Number(v.playerHpHalfUnits)
  const playerHpHalfUnits =
    Number.isFinite(hpRaw) && hpRaw >= 0
      ? Math.min(BLOCK_WORLD_MAX_HP_HALF_UNITS, Math.floor(hpRaw))
      : undefined
  const hrRaw = Number(v.hr)
  const hr = Number.isFinite(hrRaw) ? hrRaw : 0
  return {
    x: Number(v.x) || 0,
    y: Number(v.y) || 0,
    z: Number(v.z) || 0,
    ry: Number(v.ry) || 0,
    hr,
    moving: Boolean(v.moving),
    skinUrl: typeof v.skinUrl === 'string' ? v.skinUrl : null,
    photoUrl: typeof v.photoUrl === 'string' ? v.photoUrl : null,
    displayName: typeof v.displayName === 'string' ? v.displayName : '',
    mode: v.mode === 'build' ? 'build' : 'mine',
    slot,
    bwBlockType,
    bwHandMine,
    bwToolMesh,
    handSwingSeq,
    playerHpHalfUnits,
  }
}

/**
 * When the client disconnects abruptly, remove their RTDB node so remotes do not ghost.
 * Call once after joining; {@link deletePresence} cancels this before a normal remove.
 */
export async function bindPresenceDisconnectRemove(worldId: string, uid: string) {
  await unbindPresenceDisconnectRemove()
  if (!rtdb) return
  const r = dbRef(rtdb, `${RTDB_PRESENCE_ROOT}/${worldId}/${uid}`)
  activePresenceDisconnect = onDisconnect(r)
  await activePresenceDisconnect.remove()
}

export async function unbindPresenceDisconnectRemove() {
  if (!activePresenceDisconnect) return
  try {
    await activePresenceDisconnect.cancel()
  } catch {
    /* not queued */
  }
  activePresenceDisconnect = null
}

export function subscribePresence(
  worldId: string,
  onPlayers: (map: Map<string, PresenceDoc>) => void,
) {
  if (!rtdb) {
    console.warn('[sharedWorld] Realtime Database not configured; multiplayer presence disabled.')
    onPlayers(new Map())
    return () => {}
  }
  const presenceRef = dbRef(rtdb, `${RTDB_PRESENCE_ROOT}/${worldId}`)
  return onValue(presenceRef, (snap) => {
    const val = snap.val() as Record<string, Record<string, unknown>> | null
    const m = new Map<string, PresenceDoc>()
    const now = Date.now()
    if (val && typeof val === 'object') {
      for (const [uid, raw] of Object.entries(val)) {
        if (!raw || typeof raw !== 'object') continue
        const row = parsePresenceChild(
          raw as Partial<PresenceDoc> & Record<string, unknown>,
          now,
        )
        if (row) m.set(uid, row)
      }
    }
    onPlayers(m)
  })
}

export async function writePresence(
  worldId: string,
  uid: string,
  data: PresenceDoc,
) {
  if (!rtdb) {
    throw new Error(
      'Realtime Database is not configured. Set VITE_FIREBASE_DATABASE_URL in .env',
    )
  }
  const swingRaw = Number(data.handSwingSeq)
  const handSwingSeq =
    Number.isFinite(swingRaw) && swingRaw >= 0 ? Math.floor(swingRaw) : 0
  const slotRaw = Number(data.slot)
  const slot =
    Number.isFinite(slotRaw) && slotRaw >= 0 && slotRaw <= 24
      ? Math.floor(slotRaw)
      : 0
  const bwBtRaw = Number(data.bwBlockType)
  const bwBlockType =
    Number.isFinite(bwBtRaw) && bwBtRaw >= 0 && bwBtRaw <= 11
      ? Math.floor(bwBtRaw)
      : 0
  const bwHandMine = data.bwHandMine === 'tool' ? 'tool' : 'fist'
  let bwToolMeshOut: string | null = null
  if (typeof data.bwToolMesh === 'string' && data.bwToolMesh.length > 0) {
    bwToolMeshOut = data.bwToolMesh.slice(0, 80)
  }
  const hpRaw = Number(data.playerHpHalfUnits)
  const playerHpHalfUnits =
    Number.isFinite(hpRaw) && hpRaw >= 0
      ? Math.min(BLOCK_WORLD_MAX_HP_HALF_UNITS, Math.floor(hpRaw))
      : BLOCK_WORLD_MAX_HP_HALF_UNITS
  const payload: Record<string, unknown> = {
    x: data.x,
    y: data.y,
    z: data.z,
    ry: data.ry,
    hr: Number.isFinite(data.hr) ? data.hr : 0,
    moving: Boolean(data.moving),
    displayName: (data.displayName || 'Гравець').trim().slice(0, 64) || 'Гравець',
    mode: data.mode === 'build' ? 'build' : 'mine',
    slot,
    bwBlockType,
    bwHandMine,
    handSwingSeq,
    playerHpHalfUnits,
    left: false,
    updatedAt: rtdbServerTimestamp(),
  }
  if (bwToolMeshOut) payload.bwToolMesh = bwToolMeshOut
  const skin = data.skinUrl
  if (typeof skin === 'string' && skin.length > 0) payload.skinUrl = skin
  const photo = data.photoUrl
  if (typeof photo === 'string' && photo.length > 0) payload.photoUrl = photo

  await set(dbRef(rtdb, `${RTDB_PRESENCE_ROOT}/${worldId}/${uid}`), payload)
}

/** Best-effort remove presence on leave (ignore permission errors). */
export async function deletePresence(worldId: string, uid: string) {
  await unbindPresenceDisconnectRemove()
  if (!rtdb) return
  const r = dbRef(rtdb, `${RTDB_PRESENCE_ROOT}/${worldId}/${uid}`)
  try {
    await remove(r)
  } catch {
    try {
      await set(r, {
        left: true,
        updatedAt: rtdbServerTimestamp(),
      })
    } catch {
      /* ignore */
    }
  }
}

/**
 * Re-run the terrain worker with current noise + customBlocks.
 * Does not call {@link Terrain.initBlocks} — avoids removing all meshes (multiplayer sync blink).
 */
export function regenerateTerrain(terrain: Terrain) {
  terrain.generate()
}

/**
 * Remove all player-placed / mined deltas from the shared world (procedural terrain only).
 * Clears RTDB (live sync) and Firestore `customBlocks` for consistency / backups.
 */
export async function restoreSharedWorldToDefaultTerrain(
  worldId: string,
  terrain: Terrain,
) {
  cancelScheduledFlushCustomBlocks()
  if (rtdb) {
    const rootRef = dbRef(rtdb, worldBlockEditsRootPath(worldId))
    await set(rootRef, { customBlocks: [], cells: null })
  }
  const worldDocRef = doc(db, WORLD_COLLECTION, worldId)
  await setDoc(
    worldDocRef,
    {
      customBlocks: [] as SerializedBlock[],
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  )
  terrain.customBlocks = []
  regenerateTerrain(terrain)
}
