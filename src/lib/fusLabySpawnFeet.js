import Block from '@labymc/src/js/net/minecraft/client/world/block/Block.js'

/**
 * Y offset (feet) into the first **clear** block row: enough clearance above the ground plane to avoid
 * spawning clipped into the block below / flag voxels. Previously +0.01 was too tight for collision.
 */
const FEET_LIFT = 0.62

/**
 * @param {any} world
 * @param {number} x
 * @param {number} yFeetBlock
 * @param {number} z
 * @returns {boolean} true if the player body (1.8m) can fit starting with feet in block row `yFeetBlock`
 */
function columnClearForPlayer(world, x, yFeetBlock, z) {
  for (let dy = 0; dy <= 2; dy++) {
    const y = yFeetBlock + dy
    if (y < 0) return false
    const id = world.getBlockAt(x, y, z)
    if (id === 0) continue
    const b = Block.getById(id)
    if (b == null) continue
    if (b.isSolid()) {
      return false
    }
  }
  return true
}

/**
 * Feet Y from RTDB/flag y alone (one block above the stored block index, with lift).
 * Used when terrain is missing and as a **floor** with terrain: flags on towers / custom builds
 * are often **above** {@code getHeightAt} (surface) — on slow clients the heightmap can also
 * lag behind edits, so spawns must not ignore the written flag y.
 *
 * @param {number|undefined} fallbackY
 * @returns {number}
 */
function feetYFromFlagFallback(fallbackY) {
  if (!Number.isFinite(fallbackY)) {
    return 97 + FEET_LIFT
  }
  return Math.floor(fallbackY) + 1 + FEET_LIFT
}

/**
 * Place feet in the first block column at (x,z) that has a clear 2+ block stack for a 1.8m-tall
 * player. Uses {@code getHeightAt} as a start index, then walks **up** if that cell (or the next)
 * is still solid (e.g. spawn flag, stale heightmap, or interactive block filling “first air”).
 *
 * @param {any} world
 * @param {number} ix  Block X (int)
 * @param {number} iz  Block Z (int)
 * @param {number} [fallbackY]  RTDB/flag y when the column is not ready (often the block the flag sits on)
 * @returns {number} Feet Y
 */
export function fusLabyFeetYAtColumn(world, ix, iz, fallbackY) {
  const fx = Math.floor(Number(ix)) || 0
  const fz = Math.floor(Number(iz)) || 0
  const fromFlag = feetYFromFlagFallback(fallbackY)

  if (!world || typeof world.getHeightAt !== 'function' || typeof world.getBlockAt !== 'function') {
    return fromFlag
  }
  /**
   * When a spawn flag y is known, the player chose that **column and elevation** (often a
   * cave, ledge, or build). A heightmap walk from the **surface** first (`getHeightAt`) and
   * `max(terrain, fromFlag)` wrongly sends cave flags to the mountaintop. Search **near the
   * stored y** first (after chunks have block data), then fall back to the legacy surface pass.
   */
  if (Number.isFinite(fallbackY)) {
    const fy = Math.floor(fallbackY)
    for (let dy = -2; dy <= 28; dy++) {
      const y = fy + dy
      if (y < 0) continue
      if (columnClearForPlayer(world, fx, y, fz)) {
        return y + FEET_LIFT
      }
    }
  }

  let base
  try {
    base = world.getHeightAt(fx, fz)
  } catch {
    return fromFlag
  }
  if (!Number.isFinite(base) || base <= 0 || base >= 600) {
    return fromFlag
  }
  const start = Math.max(0, Math.floor(base))
  let terrainFeet = null
  for (let y = start; y < start + 32; y++) {
    if (columnClearForPlayer(world, fx, y, fz)) {
      terrainFeet = y + FEET_LIFT
      break
    }
  }
  if (terrainFeet == null) {
    return fromFlag
  }
  if (Number.isFinite(fallbackY)) {
    return Math.max(terrainFeet, fromFlag)
  }
  return terrainFeet
}
