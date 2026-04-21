import { doc, getDoc, runTransaction, serverTimestamp } from 'firebase/firestore'
import { db } from '@/firebase/config'

export const FUS_SHARED_WORLD_LABY_ID = 'fus-world-laby'

const COL = 'sharedWorlds'

/**
 * Ensure `sharedWorlds/{worldId}` exists with five noise seeds (atomic create).
 * @param {string} worldId
 */
export async function ensureSharedWorldSeeds(worldId) {
  const ref = doc(db, COL, worldId)
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref)
    if (snap.exists()) return
    tx.set(ref, {
      seeds: {
        noise: Math.random(),
        stone: Math.random(),
        tree: Math.random(),
        coal: Math.random(),
        leaf: Math.random(),
      },
      customBlocks: [],
      updatedAt: serverTimestamp(),
    })
  })
}

/**
 * @param {string} worldId
 * @returns {Promise<{ seeds: ReturnType<typeof parseSeeds> extends infer S ? S : never, labySpawn: { x: number, y: number, z: number } | null }>}
 */
export async function loadLabySharedWorldDoc(worldId) {
  const ref = doc(db, COL, worldId)
  const snap = await getDoc(ref)
  if (!snap.exists()) {
    return { seeds: null, labySpawn: null }
  }
  const d = snap.data()
  const seeds = parseSeeds(d?.seeds)
  const labySpawn = parseLabySpawn(d?.labySpawn)
  return { seeds, labySpawn }
}

/** @param {unknown} raw */
function parseSeeds(raw) {
  if (!raw || typeof raw !== 'object') return null
  const o = raw
  const keys = ['noise', 'stone', 'tree', 'coal', 'leaf']
  const out = {}
  for (const k of keys) {
    const n = Number(o[k])
    if (!Number.isFinite(n)) return null
    out[k] = n
  }
  return out
}

/** @param {unknown} raw */
function parseLabySpawn(raw) {
  if (!raw || typeof raw !== 'object') return null
  const x = Number(raw.x)
  const z = Number(raw.z)
  const y = Number(raw.y)
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null
  return {
    x,
    y: Number.isFinite(y) ? y : Number.NaN,
    z,
  }
}
