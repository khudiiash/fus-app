import {
  ref as dbRef,
  get,
  onValue,
  onChildAdded,
  push,
  remove,
  set,
} from 'firebase/database'
import { rtdb } from '@/firebase/config'

const RTDB_SPAWN_FLAGS = 'worldSpawnFlags'
const RTDB_PICKAXE_HITS = 'worldPickaxeHits'

export type SpawnFlagPose = {
  x: number
  y: number
  z: number
  ry: number
}

export type SpawnFlagsMap = Map<string, SpawnFlagPose>

function spawnFlagsDirPath(worldId: string) {
  return `${RTDB_SPAWN_FLAGS}/${worldId}`
}

function pickaxeHitsPath(worldId: string) {
  return `${RTDB_PICKAXE_HITS}/${worldId}`
}

export async function fetchPlayerSpawnFlag(
  worldId: string,
  uid: string,
): Promise<SpawnFlagPose | null> {
  if (!rtdb) return null
  const snap = await get(dbRef(rtdb, `${spawnFlagsDirPath(worldId)}/${uid}`))
  if (!snap.exists()) return null
  const v = snap.val() as Record<string, unknown> | null
  if (!v || typeof v !== 'object') return null
  const x = Number(v.x)
  const y = Number(v.y)
  const z = Number(v.z)
  const ry = Number(v.ry)
  if (![x, y, z, ry].every((n) => Number.isFinite(n))) return null
  return { x, y, z, ry }
}

export async function savePlayerSpawnFlag(
  worldId: string,
  uid: string,
  pose: SpawnFlagPose,
) {
  if (!rtdb) return
  await set(dbRef(rtdb, `${spawnFlagsDirPath(worldId)}/${uid}`), {
    x: pose.x,
    y: pose.y,
    z: pose.z,
    ry: pose.ry,
  })
}

/** Subscribe to all players' spawn flags under this world. */
export function subscribeSpawnFlags(
  worldId: string,
  onFlags: (map: SpawnFlagsMap) => void,
): () => void {
  if (!rtdb) {
    onFlags(new Map())
    return () => {}
  }
  const r = dbRef(rtdb, spawnFlagsDirPath(worldId))
  return onValue(r, (snap) => {
    const m: SpawnFlagsMap = new Map()
    const val = snap.val() as Record<string, Record<string, unknown>> | null
    if (val && typeof val === 'object') {
      for (const [uid, raw] of Object.entries(val)) {
        if (!raw || typeof raw !== 'object') continue
        const x = Number(raw.x)
        const y = Number(raw.y)
        const z = Number(raw.z)
        const ry = Number(raw.ry)
        if (![x, y, z, ry].every((n) => Number.isFinite(n))) continue
        m.set(uid, { x, y, z, ry })
      }
    }
    onFlags(m)
  })
}

export type PickaxeHitPayload = {
  fromUid: string
  toUid: string
  dmg: number
}

export type PickaxeHitsSubscribeOptions = {
  /**
   * Ignore hits with `ts` older than this (client ms). Skips RTDB replay of stale rows on attach.
   */
  ignoreHitsBeforeTs?: number
}

/** Victim listens and applies damage; removes processed row. */
export function subscribePickaxeHitsForVictim(
  worldId: string,
  victimUid: string,
  onHit: (dmg: number, fromUid: string) => void,
  options?: PickaxeHitsSubscribeOptions,
): () => void {
  if (!rtdb) return () => {}
  const base = dbRef(rtdb, pickaxeHitsPath(worldId))
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
    const fromUid = String(v.fromUid || '')
    const dmg = Number(v.dmg)
    if (!Number.isFinite(dmg) || dmg <= 0) {
      void remove(snap.ref).catch(() => {})
      return
    }
    onHit(dmg, fromUid)
    void remove(snap.ref).catch(() => {})
  })
}

export async function pushPickaxeHit(
  worldId: string,
  fromUid: string,
  toUid: string,
  dmg: number,
) {
  if (!rtdb) return
  await push(dbRef(rtdb, pickaxeHitsPath(worldId)), {
    fromUid,
    toUid,
    dmg,
    ts: Date.now(),
  })
}
