import Long from '@labymc/libraries/long.js'

/**
 * @param {Record<string, unknown>} raw
 */
export function normalizeSharedWorldSeeds(raw) {
  return {
    noise: Number(raw.noise),
    stone: Number(raw.stone),
    tree: Number(raw.tree),
    coal: Number(raw.coal),
    leaf: Number(raw.leaf),
  }
}

/**
 * Deterministic Laby world seed from persisted five-float Firestore seeds.
 * @param {ReturnType<typeof normalizeSharedWorldSeeds>} seeds
 */
export function sharedWorldSeedsToLabyLong(seeds) {
  const n = normalizeSharedWorldSeeds(seeds)
  const str = JSON.stringify({
    coal: n.coal,
    leaf: n.leaf,
    noise: n.noise,
    stone: n.stone,
    tree: n.tree,
  })
  let low = 0
  let hi = 0
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i)
    low = (Math.imul(31, low) + c) | 0
    hi = (Math.imul(17, hi) ^ Math.imul(c, 131)) | 0
  }
  return Long.fromBits(low >>> 0, hi >>> 0, false)
}
