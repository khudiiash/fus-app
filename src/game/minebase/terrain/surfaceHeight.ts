/**
 * Integer surface block Y and sea level — must match `worker/generate.ts` terrain column.
 */
export const TERRAIN_Y_BASE = 30
export const TERRAIN_SEA_LEVEL = 27

type NoiseSurface = {
  gap: number
  amp: number
  seed: number
  leafSeed: number
  get: (x: number, y: number, z: number) => number
}

/** Integer offset from {@link TERRAIN_Y_BASE} (clamped multi-octave height). */
export function terrainSurfaceYOffset(n: NoiseSurface, x: number, z: number): number {
  const base = n.get(x / n.gap, z / n.gap, n.seed) * n.amp
  const ridge =
    n.get(x / 11 + 101.7, z / 11 - 43.2, n.seed * 1.414) * n.amp * 0.58
  const detail =
    n.get(x / 4.1 + 0.7, z / 4.1 + 0.4, n.leafSeed * 1.09) * n.amp * 0.32
  let o = Math.floor(base + ridge + detail)
  if (o > 15) o = 15
  if (o < -18) o = -18
  return o
}

export function terrainSurfaceBlockY(n: NoiseSurface, x: number, z: number): number {
  return TERRAIN_Y_BASE + terrainSurfaceYOffset(n, x, z)
}
