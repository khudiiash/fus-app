import {
  doc,
  setDoc,
  onSnapshot,
  getDoc,
  serverTimestamp,
  runTransaction as runFirestoreTransaction,
} from 'firebase/firestore'
import {
  ref as dbRef,
  onValue,
  set,
  get,
  remove,
  serverTimestamp as rtdbServerTimestamp,
  onDisconnect,
  runTransaction,
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

/** Canonical JSON for custom block list (order-independent). */
function fingerprintBlocksList(blocks: SerializedBlock[]) {
  return JSON.stringify(sortSerializedBlocks(blocks))
}

function blockCellKey(b: Pick<SerializedBlock, 'x' | 'y' | 'z'>): string {
  return `${b.x},${b.y},${b.z}`
}

/**
 * Merge remote block list with this client's view: same cell (x,y,z) prefers **local**
 * so rapid local edits are not wiped during RTDB transactions.
 */
function mergeCustomBlockLists(
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
  return sortSerializedBlocks([...m.values()])
}

function randomSeed() {
  return Math.random()
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
    return sortSerializedBlocks(out)
  }
  if (typeof val === 'object') {
    const out: SerializedBlock[] = []
    for (const v of Object.values(val as Record<string, unknown>)) {
      const b = parseSerializedBlock(v)
      if (b) out.push(b)
    }
    return sortSerializedBlocks(out)
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

export type SharedWorldInitialState = {
  seeds: SharedWorldSeeds | undefined
  blocks: SerializedBlock[]
  blocksFingerprint: string
}

/**
 * Ensure `sharedWorlds/{worldId}` exists, migrate Firestore → RTDB custom blocks when needed,
 * and return the canonical block list + fingerprint (no {@link Terrain} required).
 */
export async function loadSharedWorldInitialState(
  worldId: string,
): Promise<SharedWorldInitialState> {
  const worldDocRef = doc(db, WORLD_COLLECTION, worldId)
  const snap = await getDoc(worldDocRef)
  if (!snap.exists()) {
    const seeds: SharedWorldSeeds = {
      noise: randomSeed(),
      stone: randomSeed(),
      tree: randomSeed(),
      coal: randomSeed(),
      leaf: randomSeed(),
    }
    await setDoc(worldDocRef, {
      seeds,
      customBlocks: [] as SerializedBlock[],
      updatedAt: serverTimestamp(),
    })
    if (rtdb) {
      await set(dbRef(rtdb, worldCustomBlocksRtdbPath(worldId)), [])
    }
    return { seeds, blocks: [], blocksFingerprint: fingerprintBlocksList([]) }
  }

  const data = (await getDoc(worldDocRef)).data() as Record<string, unknown> | undefined
  const seeds = data?.seeds as SharedWorldSeeds | undefined
  const fsBlocksRaw = (data?.customBlocks ?? []) as SerializedBlock[]
  const fsBlocks = sortSerializedBlocks(
    fsBlocksRaw
      .map((b) => parseSerializedBlock(b))
      .filter((b): b is SerializedBlock => b != null),
  )

  if (rtdb) {
    const br = dbRef(rtdb, worldCustomBlocksRtdbPath(worldId))
    const rtdbSnap = await get(br)
    let rtdbBlocks = blocksFromRtdbVal(rtdbSnap.exists() ? rtdbSnap.val() : null)
    if (rtdbBlocks.length === 0 && fsBlocks.length > 0) {
      await set(br, fsBlocks)
      rtdbBlocks = fsBlocks.slice()
    }
    return {
      seeds,
      blocks: rtdbBlocks,
      blocksFingerprint: fingerprintBlocksList(rtdbBlocks),
    }
  }

  return {
    seeds,
    blocks: fsBlocks,
    blocksFingerprint: fingerprintBlocksList(fsBlocks),
  }
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

  const blockRef = dbRef(rtdb, worldCustomBlocksRtdbPath(worldId))
  let lastFp = initialFingerprint
  return onValue(blockRef, (snap) => {
    const rawBlocks = blocksFromRtdbVal(snap.val())
    const fp = fingerprintBlocksList(rawBlocks)
    if (fp === lastFp) return
    lastFp = fp
    onBlocks(rawBlocks)
  })
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

  const blockRef = dbRef(rtdb, worldCustomBlocksRtdbPath(worldId))
  let lastFp = initialFingerprint
  return onValue(blockRef, (snap) => {
    const rawBlocks = blocksFromRtdbVal(snap.val())
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
        const merged = mergeCustomBlockLists(remote, local)
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

  const blockRef = dbRef(rtdb, worldCustomBlocksRtdbPath(worldId))
  for (let round = 0; round < FLUSH_MAX_ROUNDS; round++) {
    const beforeFp = fingerprintBlocksList(serializedBlocksFromTerrain(terrain))
    await runTransaction(blockRef, (current) => {
      const remote = blocksFromRtdbVal(current)
      const local = serializedBlocksFromTerrain(terrain)
      return mergeCustomBlockLists(remote, local)
    })
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

/**
 * Merge `getLocalBlocks()` into Firestore / RTDB the same way as terrain-based flushes
 * ({@link scheduleFlushCustomBlocks}), without a {@link Terrain} instance.
 */
export function scheduleFlushSharedWorldBlocksList(
  worldId: string,
  getLocalBlocks: () => SerializedBlock[],
) {
  if (flushSharedListTimer) clearTimeout(flushSharedListTimer)
  const debounceMs = blockWorldAggressiveMobile() ? 105 : FLUSH_DEBOUNCE_MS
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
      const merged = mergeCustomBlockLists(remote, sorted)
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
  const blockRef = dbRef(rtdb, worldCustomBlocksRtdbPath(worldId))
  await runTransaction(blockRef, (current) => {
    const remote = blocksFromRtdbVal(current)
    return mergeCustomBlockLists(remote, sorted)
  })
}

export type PresenceDoc = {
  x: number
  y: number
  z: number
  ry: number
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
  return {
    x: Number(v.x) || 0,
    y: Number(v.y) || 0,
    z: Number(v.z) || 0,
    ry: Number(v.ry) || 0,
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
    await set(dbRef(rtdb, worldCustomBlocksRtdbPath(worldId)), [])
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
