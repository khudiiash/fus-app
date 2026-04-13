import {
  doc,
  setDoc,
  deleteDoc,
  onSnapshot,
  getDoc,
  serverTimestamp,
  collection,
  query,
} from 'firebase/firestore'
import { db } from '@/firebase/config'
import type Terrain from './minebase/terrain'
import Block from './minebase/terrain/mesh/block'
import type { BlockType } from './minebase/terrain'

const WORLD_COLLECTION = 'sharedWorlds'

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

/** True when live terrain already matches the snapshot (client prediction / server echo). */
function terrainMatchesSnapshot(
  terrain: Terrain,
  seeds: SharedWorldSeeds | undefined,
  rawBlocks: SerializedBlock[],
) {
  if (seeds) {
    if (
      terrain.noise.seed !== seeds.noise ||
      terrain.noise.stoneSeed !== seeds.stone ||
      terrain.noise.treeSeed !== seeds.tree ||
      terrain.noise.coalSeed !== seeds.coal ||
      terrain.noise.leafSeed !== seeds.leaf
    ) {
      return false
    }
  }
  return fingerprintBlocksList(rawBlocks) === fingerprintBlocksList(serializedBlocksFromTerrain(terrain))
}

/**
 * Ensure world doc exists with noise seeds; load customBlocks into terrain.
 * @returns fingerprint to pass into {@link subscribeSharedWorldDoc} so the first snapshot does not redundant-regenerate.
 */
export async function initSharedWorldFromFirestore(
  worldId: string,
  terrain: Terrain,
): Promise<string> {
  const ref = doc(db, WORLD_COLLECTION, worldId)
  const snap = await getDoc(ref)
  if (!snap.exists()) {
    const seeds: SharedWorldSeeds = {
      noise: randomSeed(),
      stone: randomSeed(),
      tree: randomSeed(),
      coal: randomSeed(),
      leaf: randomSeed(),
    }
    await setDoc(ref, {
      seeds,
      customBlocks: [] as SerializedBlock[],
      updatedAt: serverTimestamp(),
    })
  }

  const data = (await getDoc(ref)).data() as Record<string, unknown> | undefined
  const seeds = data?.seeds as SharedWorldSeeds | undefined
  if (seeds) {
    terrain.noise.seed = seeds.noise
    terrain.noise.stoneSeed = seeds.stone
    terrain.noise.treeSeed = seeds.tree
    terrain.noise.coalSeed = seeds.coal
    terrain.noise.leafSeed = seeds.leaf
  }
  const blocks = (data?.customBlocks ?? []) as SerializedBlock[]
  terrain.customBlocks = blocks.map(
    (b) => new Block(b.x, b.y, b.z, b.type as BlockType, b.placed),
  )
  return fingerprintSharedWorldDoc(data)
}

export function subscribeSharedWorldDoc(
  worldId: string,
  terrain: Terrain,
  onRemoteCustomBlocks: () => void,
  /** From {@link initSharedWorldFromFirestore} so the first listener callback matches already-applied state. */
  initialFingerprint = '',
) {
  const ref = doc(db, WORLD_COLLECTION, worldId)
  /** Skip identical snapshots (metadata-only / duplicate delivery) to avoid terrain clear+regen flashes. */
  let lastRemoteFingerprint = initialFingerprint
  return onSnapshot(ref, (snap) => {
    if (!snap.exists()) return
    if (snap.metadata.hasPendingWrites) return
    const data = snap.data() as Record<string, unknown> | undefined
    const seeds = data?.seeds as SharedWorldSeeds | undefined
    const rawBlocks = (data?.customBlocks ?? []) as SerializedBlock[]
    const fingerprint = fingerprintSharedWorldDoc(data)
    if (fingerprint === lastRemoteFingerprint) return

    if (terrainMatchesSnapshot(terrain, seeds, rawBlocks)) {
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

let flushTimer: ReturnType<typeof setTimeout> | null = null

export function scheduleFlushCustomBlocks(worldId: string, terrain: Terrain) {
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flushCustomBlocksNow(worldId, terrain)
  }, 550)
}

async function flushCustomBlocksNow(worldId: string, terrain: Terrain) {
  const ref = doc(db, WORLD_COLLECTION, worldId)
  const serialized: SerializedBlock[] = terrain.customBlocks.map((b) => ({
    x: b.x,
    y: b.y,
    z: b.z,
    type: b.type as number,
    placed: b.placed,
  }))
  await setDoc(
    ref,
    {
      customBlocks: serialized,
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  )
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
  /** 0–6 block type slot, 7 = tool / mine hand. */
  slot?: number
  /** Increments on each mine/place swing; remotes animate the held item. */
  handSwingSeq?: number
  /** Soft-delete so others hide this avatar without requiring delete permission. */
  left?: boolean
}

export function subscribePresence(
  worldId: string,
  onPlayers: (map: Map<string, PresenceDoc>) => void,
) {
  const col = collection(db, WORLD_COLLECTION, worldId, 'presence')
  return onSnapshot(query(col), (snap) => {
    const m = new Map<string, PresenceDoc>()
    snap.forEach((d) => {
      const v = d.data() as Partial<PresenceDoc> & Record<string, unknown>
      if (v?.left === true) return
      const slotRaw = Number(v.slot)
      const slot =
        Number.isFinite(slotRaw) && slotRaw >= 0 && slotRaw <= 7
          ? Math.floor(slotRaw)
          : 0
      const swingRaw = Number(v.handSwingSeq)
      const handSwingSeq =
        Number.isFinite(swingRaw) && swingRaw >= 0 ? Math.floor(swingRaw) : 0
      m.set(d.id, {
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
        handSwingSeq,
      })
    })
    onPlayers(m)
  })
}

export async function writePresence(
  worldId: string,
  uid: string,
  data: PresenceDoc,
) {
  const ref = doc(db, WORLD_COLLECTION, worldId, 'presence', uid)
  await setDoc(
    ref,
    {
      ...data,
      /** Must clear soft-leave or the listener skips this doc forever (`if (v?.left) return`). */
      left: false,
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  )
}

/** Best-effort remove presence on leave (ignore permission errors). */
export async function deletePresence(worldId: string, uid: string) {
  const ref = doc(db, WORLD_COLLECTION, worldId, 'presence', uid)
  try {
    await deleteDoc(ref)
  } catch {
    try {
      await setDoc(
        ref,
        { left: true, updatedAt: serverTimestamp() },
        { merge: true },
      )
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
