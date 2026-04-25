/**
 * Horizontal radius (blocks) for “this player should simulate / render / care” — same disc
 * as the strict path in {@link fusLabyEntityInTerrainDrawWindow} (view distance, chunk col).
 *
 * @param {any} mc
 * @returns {number}
 */
export function fusLabyPlayerInterestRadiusBlocks(mc) {
  const v = Number(mc?.settings?.viewDistance)
  const rd = Number.isFinite(v) && v > 0 ? v : 4
  const touchTight = !!(mc.fusLowTierMobile || mc.fusIosSafari)
  return touchTight ? 12 * rd * Math.SQRT2 + 6 : 16 * rd * Math.SQRT2 + 8
}

/**
 * True when (worldX, worldZ) is within the local player’s interest radius (no Y test).
 * Use to skip RTDB-driven work for far peers/mobs when we are not the authoritative writer.
 *
 * @param {any} mc
 * @param {number} worldX
 * @param {number} worldZ
 * @returns {boolean}
 */
export function fusLabyIsWithinPlayerInterestXz(mc, worldX, worldZ) {
  const pl = mc?.player
  if (!pl || !Number.isFinite(pl.x) || !Number.isFinite(pl.z)) return true
  if (typeof worldX !== 'number' || typeof worldZ !== 'number' || !Number.isFinite(worldX) || !Number.isFinite(worldZ)) {
    return true
  }
  const r = fusLabyPlayerInterestRadiusBlocks(mc)
  const dx = pl.x - worldX
  const dz = pl.z - worldZ
  return dx * dx + dz * dz <= r * r
}

/** World XZ distance (1 unit ≈ 1 m) at which Laby still runs per-frame animation + cheap visuals. */
export const FUS_LABY_ANIM_PROCESS_RADIUS = 20
const FUS_LABY_ANIM_PROCESS_R2 = FUS_LABY_ANIM_PROCESS_RADIUS * FUS_LABY_ANIM_PROCESS_RADIUS

/**
 * True within {@link FUS_LABY_ANIM_PROCESS_RADIUS} horizontal blocks of the local player.
 * Mobs, coins, and remote avatars: skip mixer spin/bob/nametag work outside this disc.
 *
 * @param {any} mc
 * @param {number} worldX
 * @param {number} worldZ
 * @returns {boolean}
 */
export function fusLabyIsWithinAnimProcessRangeXz(mc, worldX, worldZ) {
  const pl = mc?.player
  if (!pl || !Number.isFinite(pl.x) || !Number.isFinite(pl.z)) return true
  if (typeof worldX !== 'number' || typeof worldZ !== 'number' || !Number.isFinite(worldX) || !Number.isFinite(worldZ)) {
    return true
  }
  const dx = pl.x - worldX
  const dz = pl.z - worldZ
  return dx * dx + dz * dz <= FUS_LABY_ANIM_PROCESS_R2
}

/**
 * Laby: gate Three.js content (mobs, remote avatars, spawn-flag marker) so it only draws
 * when the world renderer is actually showing that chunk column. On mobile, chunk
 * "loaded" in memory and walkable Y can be ready before the mesh queue has drawn terrain
 * under the same XZ, which looked like mobs/flags/players "floating" past the cut-off
 * (see Laby user reports, 2026-04). WorldRenderer also sets {@link Chunk#group}.visible
 * from the same distance test as this helper's square gate.
 *
 * @param {any} mc
 * @param {number} worldX
 * @param {number} worldZ
 * @returns {boolean}
 */
export function fusLabyEntityInTerrainDrawWindow(mc, worldX, worldZ) {
  const w = mc?.world
  const pl = mc?.player
  if (!w || !pl) return false
  if (typeof worldX !== 'number' || typeof worldZ !== 'number' || !Number.isFinite(worldX) || !Number.isFinite(worldZ)) {
    return false
  }
  if (!Number.isFinite(pl.x) || !Number.isFinite(pl.z)) return false
  const mcx = Math.floor(worldX) >> 4
  const mcz = Math.floor(worldZ) >> 4
  if (typeof w.chunkExists === 'function' && !w.chunkExists(mcx, mcz)) return false
  const pcx = Math.floor(pl.x) >> 4
  const pcz = Math.floor(pl.z) >> 4
  const v = Number(mc?.settings?.viewDistance)
  const rd = Number.isFinite(v) && v > 0 ? v : 4
  /**
   * Mobile: one chunk *inside* the engine’s view square so we never draw mobs/avatars in the
   * outer ring (often mid-air or heavy poly before terrain settles) — was a main Android lag source.
   */
  const touchTight = !!(mc.fusLowTierMobile || mc.fusIosSafari)
  const rdCol = touchTight ? Math.max(2, rd - 1) : rd
  if (Math.abs(mcx - pcx) >= rdCol || Math.abs(mcz - pcz) >= rdCol) return false
  let chunk
  try {
    chunk = w.getChunkAt(mcx, mcz)
  } catch {
    return false
  }
  if (!chunk || !chunk.loaded) return false
  if (chunk.group && chunk.group.visible === false) return false
  const strict = !!mc.fusLabyStricterEntityCull
  if (strict) {
    const dx = pl.x - worldX
    const dz = pl.z - worldZ
    const d2 = dx * dx + dz * dz
    /**
     * Must cover chunk-square corners. Touch clients use a *smaller* disc so we do not
     * spend GPU/CPU on distant models that read as off-mesh or float at the fog edge.
     */
    const rMax = touchTight
      ? 12 * rd * Math.SQRT2 + 6
      : 16 * rd * Math.SQRT2 + 8
    if (d2 > rMax * rMax) return false
  }
  return true
}
