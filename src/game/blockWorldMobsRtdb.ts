import {
  ref as dbRef,
  get,
  onValue,
  onChildAdded,
  push,
  remove,
  set,
  update,
  runTransaction,
} from 'firebase/database'
import { rtdb } from '@/firebase/config'
import {
  MOB_KIND_DEFS,
  type MobKindId,
  isMobKindId,
} from '@/game/blockWorldMobCatalog'
import type Terrain from '@/game/minebase/terrain'
import * as THREE from 'three'

const RTDB_MOB_STATE = 'worldMobState'
const RTDB_MOB_META = 'worldMobMeta'
const RTDB_MOB_LEASE = 'worldMobLease'
const RTDB_MOB_HITS = 'worldMobHits'
const RTDB_MOB_DEATH_LOOT = 'worldMobDeathLoot'
const RTDB_MOB_COIN_DROPS = 'worldMobCoinDrops'

export type MobAnimNet = 'idle' | 'walk' | 'attack' | 'death'

export type MobStateDoc = {
  kind: MobKindId
  x: number
  y: number
  z: number
  ry: number
  hp: number
  hpMax: number
  anim: MobAnimNet
  /** Patrol / respawn anchor (XZ). */
  ax: number
  az: number
  /** 0 while alive; timestamp (ms) when killed (for respawn timing). */
  deadAt: number
}

function mobStatePath(worldId: string, mobId: string) {
  return `${RTDB_MOB_STATE}/${worldId}/${mobId}`
}

function parseMobState(
  raw: Record<string, unknown> | null,
): MobStateDoc | null {
  if (!raw || typeof raw !== 'object') return null
  const kind = String(raw.kind || '')
  if (!isMobKindId(kind)) return null
  const num = (k: string) => {
    const n = Number(raw[k])
    return Number.isFinite(n) ? n : NaN
  }
  const x = num('x')
  const y = num('y')
  const z = num('z')
  const ry = num('ry')
  const hp = Math.floor(num('hp'))
  const hpMax = Math.floor(num('hpMax'))
  const ax = num('ax')
  const az = num('az')
  const deadAtRaw = num('deadAt')
  const deadAt = Number.isFinite(deadAtRaw) ? Math.floor(deadAtRaw) : 0
  if (![x, y, z, ry, hp, hpMax, ax, az].every((n) => Number.isFinite(n)))
    return null
  let anim: MobAnimNet = 'idle'
  const a = String(raw.anim || 'idle')
  if (a === 'walk' || a === 'attack' || a === 'death' || a === 'idle') anim = a
  return { kind, x, y, z, ry, hp, hpMax, ax, az, deadAt, anim }
}

/** Foliage / trunk hits sit above walkable ground — skip so feet resolve to terrain. */
const RAYCAST_SKIP_BLOCK_NAMES = new Set(['tree', 'leaf'])

export function sampleTerrainSurfaceY(
  terrain: Terrain,
  x: number,
  z: number,
): number | null {
  const rc = new THREE.Raycaster()
  rc.ray.origin.set(x, 220, z)
  rc.ray.direction.set(0, -1, 0)
  rc.far = 260
  const hits = rc.intersectObjects(terrain.blocks, true)
  if (!hits.length) return null
  for (const h of hits) {
    const name = h.object.name
    if (RAYCAST_SKIP_BLOCK_NAMES.has(name)) continue
    return h.point.y
  }
  return null
}

/**
 * Same surface formula as {@link createFusBlockWorld} / terrain worker column height
 * (used when instanced-mesh raycasts miss, e.g. timing or bounds edge cases).
 */
export function estimateTerrainSurfaceY(terrain: Terrain, x: number, z: number) {
  const n = terrain.noise
  const ix = Math.floor(x + 1e-6)
  const iz = Math.floor(z + 1e-6)
  const yOff = Math.floor(n.get(ix / n.gap, iz / n.gap, n.seed) * n.amp)
  return 30 + yOff + 0.5
}

export function resolveMobFeetY(terrain: Terrain, x: number, z: number) {
  const columnTop = estimateTerrainSurfaceY(terrain, x, z) + 0.02
  const rayY = sampleTerrainSurfaceY(terrain, x, z)
  if (rayY == null) return columnTop
  let y = rayY + 0.02
  /** If ray still hit something well above procedural column top (canopy edge cases), clamp. */
  if (y > columnTop + 3.2) y = columnTop
  return y
}

type SeedKindRow = { id: string; kind: MobKindId }

/** Mob kinds and stable ids; XZ offsets ring near the seed anchor (see {@link mobSeedOffsetsFromSpawn}). */
const DEFAULT_SEED_MOBS: SeedKindRow[] = [
  { id: 'm0', kind: 'spider' },
  { id: 'm1', kind: 'wild_bore' },
  { id: 'm2', kind: 'fenmaw' },
  { id: 'm3', kind: 'golem' },
  { id: 'm4', kind: 'mutant_iron_golem' },
  { id: 'm5', kind: 'gigant_warden' },
  { id: 'm6', kind: 'spider' },
  { id: 'm7', kind: 'wild_bore' },
  { id: 'm8', kind: 'fenmaw' },
  { id: 'm9', kind: 'golem' },
  { id: 'm10', kind: 'mutant_iron_golem' },
  { id: 'm11', kind: 'gigant_warden' },
]

/** Default world spawn column (see minebase `Core.initCamera` XZ ≈ 8,8). */
export const BLOCKWORLD_DEFAULT_SPAWN_XZ = { x: 8, z: 8 } as const

/** Bump when spawn layout rules change — clients rewrite RTDB mob positions once. */
const CURRENT_MOB_SPAWN_LAYOUT_V = 4

/** At least this horizontal distance from the spawn anchor (mobs stay findable, not map-edge). */
const MOB_SEED_MIN_DIST_FROM_SPAWN = 14
/** Base ring radius from spawn; extra rings add separation between mobs. */
const MOB_SEED_RADIUS_BASE = 22
const MOB_SEED_RADIUS_STEP = 7

export type EnsureWorldMobsSeedOpts = {
  /** Feet / column XZ the player will stand on (flag, saved pose, or camera); used for first-time seed only. */
  spawnColumnX?: number
  spawnColumnZ?: number
}

function hashWorldIdToPhase(worldId: string): number {
  let h = 2166136261
  for (let i = 0; i < worldId.length; i++) {
    h ^= worldId.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 1000000) / 1000000 * Math.PI * 2
}

/**
 * Evenly spaced directions around the anchor, staggered radii so mobs are not stacked
 * and stay at least {@link MOB_SEED_MIN_DIST_FROM_SPAWN} from it (unless scaled up).
 */
function mobSeedOffsetsFromSpawn(
  worldId: string,
  n: number,
): Array<{ dx: number; dz: number }> {
  const phase = hashWorldIdToPhase(worldId)
  const out: Array<{ dx: number; dz: number }> = []
  for (let i = 0; i < n; i++) {
    const ang = phase + (i * Math.PI * 2) / n + i * 0.27
    const r = MOB_SEED_RADIUS_BASE + (i % 3) * MOB_SEED_RADIUS_STEP
    let dx = Math.cos(ang) * r
    let dz = Math.sin(ang) * r
    dx = Math.round(dx)
    dz = Math.round(dz)
    const d = Math.hypot(dx, dz)
    if (d < MOB_SEED_MIN_DIST_FROM_SPAWN && d > 1e-6) {
      const s = MOB_SEED_MIN_DIST_FROM_SPAWN / d
      dx = Math.round(dx * s)
      dz = Math.round(dz * s)
    }
    out.push({ dx, dz })
  }
  return out
}

function readMobMetaLayoutV(metaVal: unknown): number {
  if (!metaVal || typeof metaVal !== 'object') return 1
  const v = (metaVal as Record<string, unknown>).mobSpawnLayoutV
  if (typeof v !== 'number' || !Number.isFinite(v)) return 1
  return Math.floor(v)
}

function isMetaSeeded(metaVal: unknown): boolean {
  if (!metaVal || typeof metaVal !== 'object') return false
  return (metaVal as Record<string, unknown>).seeded === true
}

/**
 * One-time seed + layout version upgrades (rewrites mob XZ when `mobSpawnLayoutV` is stale).
 * Relocation for upgrades always uses {@link BLOCKWORLD_DEFAULT_SPAWN_XZ} so legacy packs leave world origin.
 */
export async function ensureWorldMobsSeeded(
  worldId: string,
  terrain: Terrain,
  opts?: EnsureWorldMobsSeedOpts,
) {
  if (!rtdb) return
  const metaRootRef = dbRef(rtdb, `${RTDB_MOB_META}/${worldId}`)
  const seededOnlyRef = dbRef(rtdb, `${RTDB_MOB_META}/${worldId}/seeded`)
  const stateRef = dbRef(rtdb, `${RTDB_MOB_STATE}/${worldId}`)
  const [metaSnap, stateSnap] = await Promise.all([
    get(metaRootRef),
    get(stateRef),
  ])
  const metaVal = metaSnap.exists() ? metaSnap.val() : null
  const seeded = isMetaSeeded(metaVal)
  const layoutV = readMobMetaLayoutV(metaVal)

  const rawState = stateSnap.exists() ? stateSnap.val() : null
  let parseableMobCount = 0
  if (rawState && typeof rawState === 'object') {
    for (const v of Object.values(rawState as Record<string, unknown>)) {
      if (v && typeof v === 'object' && parseMobState(v as Record<string, unknown>))
        parseableMobCount++
    }
  }

  if (seeded && parseableMobCount > 0 && layoutV >= CURRENT_MOB_SPAWN_LAYOUT_V) {
    return
  }

  if (seeded && parseableMobCount === 0) {
    try {
      await remove(metaRootRef)
    } catch {
      await set(seededOnlyRef, false)
    }
  }

  const payload: Record<string, unknown> = {}

  const firstSeedAnchorX = Math.round(
    opts?.spawnColumnX ?? terrain.camera.position.x,
  )
  const firstSeedAnchorZ = Math.round(
    opts?.spawnColumnZ ?? terrain.camera.position.z,
  )

  /** Legacy tight clusters were around world default spawn — pull them away from (8,8), not from the player's flag. */
  const relocateAnchorX = BLOCKWORLD_DEFAULT_SPAWN_XZ.x
  const relocateAnchorZ = BLOCKWORLD_DEFAULT_SPAWN_XZ.z

  const needsRelayout =
    seeded && parseableMobCount > 0 && layoutV < CURRENT_MOB_SPAWN_LAYOUT_V

  if (needsRelayout && rawState && typeof rawState === 'object') {
    const byId = new Map<string, MobStateDoc>()
    for (const [id, v] of Object.entries(rawState as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') continue
      const doc = parseMobState(v as Record<string, unknown>)
      if (doc) byId.set(id, doc)
    }

    const nSlots = Math.max(DEFAULT_SEED_MOBS.length, byId.size, 1)
    const offsets = mobSeedOffsetsFromSpawn(worldId, nSlots)

    for (let i = 0; i < DEFAULT_SEED_MOBS.length; i++) {
      const row = DEFAULT_SEED_MOBS[i]!
      const off = offsets[i]!
      const old = byId.get(row.id)
      const x = relocateAnchorX + off.dx
      const z = relocateAnchorZ + off.dz
      const feetY = resolveMobFeetY(terrain, x, z)
      if (old) {
        const doc: MobStateDoc = {
          ...old,
          x,
          y: feetY,
          z,
          ax: x,
          az: z,
        }
        payload[`${RTDB_MOB_STATE}/${worldId}/${row.id}`] = doc
      } else {
        const def = MOB_KIND_DEFS[row.kind]
        const doc: MobStateDoc = {
          kind: row.kind,
          x,
          y: feetY,
          z,
          ry: Math.random() * Math.PI * 2,
          hp: def.hpMax,
          hpMax: def.hpMax,
          anim: 'idle',
          ax: x,
          az: z,
          deadAt: 0,
        }
        payload[`${RTDB_MOB_STATE}/${worldId}/${row.id}`] = doc
      }
    }
  } else {
    const anchorX = firstSeedAnchorX
    const anchorZ = firstSeedAnchorZ
    const offsets = mobSeedOffsetsFromSpawn(worldId, DEFAULT_SEED_MOBS.length)

    let placed = 0
    for (let i = 0; i < DEFAULT_SEED_MOBS.length; i++) {
      const row = DEFAULT_SEED_MOBS[i]!
      const off = offsets[i]!
      const def = MOB_KIND_DEFS[row.kind]
      const x = anchorX + off.dx
      const z = anchorZ + off.dz
      const feetY = resolveMobFeetY(terrain, x, z)
      const doc: MobStateDoc = {
        kind: row.kind,
        x,
        y: feetY,
        z,
        ry: Math.random() * Math.PI * 2,
        hp: def.hpMax,
        hpMax: def.hpMax,
        anim: 'idle',
        ax: x,
        az: z,
        deadAt: 0,
      }
      payload[`${RTDB_MOB_STATE}/${worldId}/${row.id}`] = doc
      placed++
    }

    if (placed === 0) {
      console.warn('[worldMobs] seed skipped: no mob slots resolved')
      return
    }
  }

  payload[`${RTDB_MOB_META}/${worldId}/seeded`] = true
  payload[`${RTDB_MOB_META}/${worldId}/mobSpawnLayoutV`] =
    CURRENT_MOB_SPAWN_LAYOUT_V
  await update(dbRef(rtdb), payload)
}

/**
 * Admin / debug: revive all default mob slots at their anchors (full HP, alive).
 * Does not change mobSpawnLayoutV or meta.seeded.
 */
export async function forceRespawnWorldMobs(worldId: string, terrain: Terrain) {
  if (!rtdb) return
  const stateRef = dbRef(rtdb, `${RTDB_MOB_STATE}/${worldId}`)
  const snap = await get(stateRef)
  const rawState = snap.exists() ? snap.val() : null
  const byId = new Map<string, MobStateDoc>()
  if (rawState && typeof rawState === 'object') {
    for (const [id, v] of Object.entries(rawState as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') continue
      const doc = parseMobState(v as Record<string, unknown>)
      if (doc) byId.set(id, doc)
    }
  }

  const anchorX = BLOCKWORLD_DEFAULT_SPAWN_XZ.x
  const anchorZ = BLOCKWORLD_DEFAULT_SPAWN_XZ.z
  const offsets = mobSeedOffsetsFromSpawn(worldId, DEFAULT_SEED_MOBS.length)
  const payload: Record<string, unknown> = {}

  for (let i = 0; i < DEFAULT_SEED_MOBS.length; i++) {
    const row = DEFAULT_SEED_MOBS[i]!
    const old = byId.get(row.id)
    let x: number
    let z: number
    if (old && Number.isFinite(old.ax) && Number.isFinite(old.az)) {
      x = Math.round(old.ax)
      z = Math.round(old.az)
    } else {
      const off = offsets[i]!
      x = anchorX + off.dx
      z = anchorZ + off.dz
    }
    const feetY = resolveMobFeetY(terrain, x, z)
    const def = MOB_KIND_DEFS[row.kind]
    const ry =
      old && Number.isFinite(old.ry) ? old.ry : Math.random() * Math.PI * 2
    const doc: MobStateDoc = {
      kind: row.kind,
      x,
      y: feetY,
      z,
      ry,
      hp: def.hpMax,
      hpMax: def.hpMax,
      anim: 'idle',
      ax: x,
      az: z,
      deadAt: 0,
    }
    payload[`${RTDB_MOB_STATE}/${worldId}/${row.id}`] = doc
  }

  await update(dbRef(rtdb), payload)
}

export function subscribeMobStates(
  worldId: string,
  onMap: (m: Map<string, MobStateDoc>) => void,
): () => void {
  if (!rtdb) {
    onMap(new Map())
    return () => {}
  }
  const r = dbRef(rtdb, `${RTDB_MOB_STATE}/${worldId}`)
  return onValue(r, (snap) => {
    const m = new Map<string, MobStateDoc>()
    const val = snap.val() as Record<string, Record<string, unknown>> | null
    if (val && typeof val === 'object') {
      for (const [id, raw] of Object.entries(val)) {
        if (!raw || typeof raw !== 'object') continue
        const row = parseMobState(raw)
        if (row) m.set(id, row)
      }
    }
    onMap(m)
  })
}

export type MobHitPayload = {
  fromMobId: string
  toUid: string
  dmg: number
}

export type MobHitsSubscribeOptions = {
  ignoreHitsBeforeTs?: number
}

export function subscribeMobHitsForVictim(
  worldId: string,
  victimUid: string,
  onHit: (dmg: number, fromMobId: string) => void,
  options?: MobHitsSubscribeOptions,
): () => void {
  if (!rtdb) return () => {}
  const base = dbRef(rtdb, `${RTDB_MOB_HITS}/${worldId}`)
  const ignoreBefore = options?.ignoreHitsBeforeTs
  return onChildAdded(base, (snap) => {
    const v = snap.val() as Record<string, unknown> | null
    if (!v || typeof v !== 'object') return
    if (String(v.toUid) !== victimUid) return
    const rawTs = Number(v.ts)
    const ts = Number.isFinite(rawTs) ? rawTs : 0
    if (ignoreBefore != null && ts < ignoreBefore) {
      void remove(snap.ref).catch(() => {})
      return
    }
    const fromMobId = String(v.fromMobId || '')
    const dmg = Number(v.dmg)
    if (!fromMobId || !Number.isFinite(dmg) || dmg <= 0) {
      void remove(snap.ref).catch(() => {})
      return
    }
    onHit(dmg, fromMobId)
    void remove(snap.ref).catch(() => {})
  })
}

export async function pushMobHitPlayer(
  worldId: string,
  fromMobId: string,
  toUid: string,
  dmg: number,
) {
  if (!rtdb) return
  await push(dbRef(rtdb, `${RTDB_MOB_HITS}/${worldId}`), {
    fromMobId: fromMobId.slice(0, 48),
    toUid,
    dmg,
    ts: Date.now(),
  })
}

const LEASE_MS = 5000

export async function tryAcquireOrRenewMobLease(
  worldId: string,
  uid: string,
): Promise<boolean> {
  if (!rtdb) return false
  const ref = dbRef(rtdb, `${RTDB_MOB_LEASE}/${worldId}`)
  const now = Date.now()
  const res = await runTransaction(ref, (curr) => {
    const c = curr as { holder?: string; until?: number } | null
    const until = typeof c?.until === 'number' ? c.until : 0
    const holder = typeof c?.holder === 'string' ? c.holder : ''
    if (!c || until < now || holder === uid) {
      return { holder: uid, until: now + LEASE_MS }
    }
    return c
  })
  const v = res.snapshot.val() as { holder?: string } | null
  return v?.holder === uid
}

export async function mobDamageFromPlayer(
  worldId: string,
  mobId: string,
  dmgRaw: number,
  /** When the killing blow is applied here, publish coin drops even if no RTDB hp-transition was seen locally. */
  terrain?: Terrain,
) {
  if (!rtdb) return
  /** Tuned for high-HP mobs + co-op: player hits are a fraction of raw tool damage. */
  const dmg = Math.max(1, Math.min(26, Math.floor(Number(dmgRaw) * 0.28)))
  const ref = dbRef(rtdb, mobStatePath(worldId, mobId))
  const tx = await runTransaction(ref, (curr) => {
    if (!curr || typeof curr !== 'object') return curr
    const row = parseMobState(curr as Record<string, unknown>)
    if (!row || row.hp <= 0 || row.deadAt > 0) return curr
    const hp = Math.max(0, row.hp - dmg)
    const deadAt = hp <= 0 ? Date.now() : 0
    const anim: MobAnimNet = hp <= 0 ? 'death' : row.anim
    const next: MobStateDoc = {
      kind: row.kind,
      x: row.x,
      y: row.y,
      z: row.z,
      ry: row.ry,
      hp,
      hpMax: row.hpMax,
      anim,
      ax: row.ax,
      az: row.az,
      deadAt,
    }
    return next as unknown as Record<string, unknown>
  })
  if (!terrain || !tx.committed) return
  try {
    const snap = await get(ref)
    const raw = snap.val() as Record<string, unknown> | null
    const row = raw ? parseMobState(raw) : null
    if (row && row.hp <= 0 && row.deadAt > 0) {
      void tryPublishMobDeathCoinDrops(worldId, mobId, row, terrain)
    }
  } catch {
    /* ignore */
  }
}

/** One RTDB multi-path update (fewer round-trips than parallel `set`). */
export async function writeMobStatesFullBatch(
  worldId: string,
  docs: Record<string, MobStateDoc>,
) {
  if (!rtdb) return
  const entries = Object.entries(docs).filter(([id]) => id && id.length <= 48)
  if (!entries.length) return
  const payload: Record<string, unknown> = {}
  for (const [mobId, doc] of entries) {
    payload[`${RTDB_MOB_STATE}/${worldId}/${mobId}`] = doc
  }
  await update(dbRef(rtdb), payload)
}

export type MobCoinDropDoc = {
  x: number
  y: number
  z: number
  ts: number
  v: number
}

function parseCoinDrop(raw: unknown): MobCoinDropDoc | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o.claimedBy === 'string' && o.claimedBy.length > 0) return null
  const x = Number(o.x)
  const y = Number(o.y)
  const z = Number(o.z)
  const v = Math.max(1, Math.floor(Number(o.v) || 1))
  const ts = Number(o.ts)
  if (![x, y, z, ts].every(Number.isFinite)) return null
  return { x, y, z, v, ts }
}

/**
 * First writer per mob death spawns RTDB coin pickups (idempotent via loot lock).
 */
export async function tryPublishMobDeathCoinDrops(
  worldId: string,
  mobId: string,
  doc: MobStateDoc,
  terrain: Terrain,
) {
  if (!rtdb) return
  const deadAt = doc.deadAt
  if (!(deadAt > 0) || doc.hp > 0) return
  const def = MOB_KIND_DEFS[doc.kind]
  const n = Math.max(3, Math.min(30, def.coinDropCount))
  const lockRef = dbRef(
    rtdb,
    `${RTDB_MOB_DEATH_LOOT}/${worldId}/${mobId.slice(0, 40)}_${deadAt}`,
  )
  try {
    const res = await runTransaction(lockRef, (curr) => {
      if (curr !== null && curr !== undefined) return undefined
      return 1
    })
    if (!res.committed) return
  } catch {
    return
  }

  const payload: Record<string, unknown> = {}
  const cx = doc.x
  const cz = doc.z
  const t = Date.now()
  for (let i = 0; i < n; i++) {
    const ang = (i / n) * Math.PI * 2 + Math.random() * 0.55
    const rad = 0.42 + Math.random() * 1.05
    const x = cx + Math.cos(ang) * rad
    const z = cz + Math.sin(ang) * rad
    const y =
      resolveMobFeetY(terrain, x, z) + 0.14 + Math.random() * 0.16
    const id =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID().replace(/-/g, '').slice(0, 22)
        : `${t}_${i}_${Math.random().toString(36).slice(2, 11)}`
    payload[`${RTDB_MOB_COIN_DROPS}/${worldId}/${id}`] = {
      x,
      y,
      z,
      ts: t,
      v: 1,
    }
  }
  try {
    await update(dbRef(rtdb), payload)
  } catch (e) {
    console.warn('[worldMobs] coin drops publish', e)
  }
}

/**
 * Atomic claim for RTDB pickup (sets claimedBy). Caller may {@link removeMobCoinDrop} immediately
 * so pickups feel instant; grant Firestore in a debounced batch. If the drop row is removed before
 * a grant retry, use {@link tryReleaseMobCoinDropClaim} only when the node still exists.
 */
export async function tryClaimMobCoinDrop(
  worldId: string,
  dropId: string,
  uid: string,
): Promise<number> {
  if (!rtdb || !dropId || !uid) return 0
  const ref = dbRef(rtdb, `${RTDB_MOB_COIN_DROPS}/${worldId}/${dropId}`)
  try {
    const res = await runTransaction(ref, (curr) => {
      if (curr === null || curr === undefined) return undefined
      const o = curr as Record<string, unknown>
      if (typeof o.claimedBy === 'string' && o.claimedBy.length > 0)
        return undefined
      return { ...o, claimedBy: uid, claimedAt: Date.now() }
    })
    if (!res.committed) return 0
    const val = res.snapshot.val() as Record<string, unknown> | null
    if (!val || String(val.claimedBy) !== uid) return 0
    return Math.max(1, Math.floor(Number(val.v) || 1))
  } catch {
    return 0
  }
}

/** Remove drop node after Firestore grant (keeps RTDB small). */
export async function removeMobCoinDrop(worldId: string, dropId: string) {
  if (!rtdb || !dropId) return
  await remove(dbRef(rtdb, `${RTDB_MOB_COIN_DROPS}/${worldId}/${dropId}`)).catch(
    () => {},
  )
}

/** Undo a local claim if Firestore grant failed (drop stays hidden until reverted). */
export async function tryReleaseMobCoinDropClaim(
  worldId: string,
  dropId: string,
  uid: string,
) {
  if (!rtdb || !dropId || !uid) return
  const ref = dbRef(rtdb, `${RTDB_MOB_COIN_DROPS}/${worldId}/${dropId}`)
  try {
    await runTransaction(ref, (curr) => {
      if (!curr || typeof curr !== 'object') return undefined
      const o = curr as Record<string, unknown>
      if (String(o.claimedBy || '') !== uid) return undefined
      const next: Record<string, unknown> = { ...o }
      delete next.claimedBy
      delete next.claimedAt
      return next
    })
  } catch {
    /* ignore */
  }
}

export function subscribeMobCoinDrops(
  worldId: string,
  onMap: (m: Map<string, MobCoinDropDoc>) => void,
): () => void {
  if (!rtdb) {
    onMap(new Map())
    return () => {}
  }
  const r = dbRef(rtdb, `${RTDB_MOB_COIN_DROPS}/${worldId}`)
  return onValue(r, (snap) => {
    const m = new Map<string, MobCoinDropDoc>()
    const val = snap.val() as Record<string, unknown> | null
    if (val && typeof val === 'object') {
      for (const [id, raw] of Object.entries(val)) {
        const d = parseCoinDrop(raw)
        if (d) m.set(id, d)
      }
    }
    onMap(m)
  })
}
