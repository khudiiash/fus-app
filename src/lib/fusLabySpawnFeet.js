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

/**
 * In a single (ix, iz) column, find a valid standing feet Y whose value is **closest** to
 * {@code hintEntityFeetY}. Avoids {@link fusLabyFeetYAtColumn}’s “first clear from below”
 * rule that can pick a cave / gap under a platform.
 *
 * @param {any} world
 * @param {number} ix
 * @param {number} iz
 * @param {number} hintEntityFeetY
 * @returns {number | null} feet Y, or null if no candidate
 */
function nearestClearFeetYInOneColumn(world, ix, iz, hintEntityFeetY) {
  if (!world || typeof world.getBlockAt !== 'function' || !Number.isFinite(hintEntityFeetY)) {
    return null
  }
  const h = Number(hintEntityFeetY)
  const lo = Math.max(0, Math.floor(h) - 3)
  const hi = Math.min(600, Math.floor(h) + 10)
  let bestY = null
  let bestScore = Infinity
  for (let yB = lo; yB <= hi; yB++) {
    if (!columnClearForPlayer(world, ix, yB, iz)) continue
    const feetY = yB + FEET_LIFT
    const score = Math.abs(feetY - h)
    if (score < bestScore) {
      bestScore = score
      bestY = feetY
    }
  }
  return bestY
}

/**
 * Feet Y in column {@code (ix, iz)} near {@code hint}, or null if no valid stand.
 * @param {any} world
 * @param {number} ix
 * @param {number} iz
 * @param {number} hint
 * @returns {number | null}
 */
function feetYInColumnForPeer(world, ix, iz, hint) {
  let fy = nearestClearFeetYInOneColumn(world, ix, iz, hint)
  if (fy == null) {
    try {
      fy = fusLabyFeetYAtColumn(world, ix, iz, hint)
    } catch {
      fy = null
    }
  }
  if (fy == null || !Number.isFinite(fy)) return null
  return fy
}

/**
 * Picks the best cell among offsets (lowest |feetY − hint|), or null if none are standable.
 * @param {any} world
 * @param {number} bix
 * @param {number} biz
 * @param {number} hint
 * @param {number[][]} offsets  Array of [ox, oz] in block space from the peer’s column.
 * @returns {{ x: number, y: number, z: number } | null}
 */
function bestPeerTeleportAmongOffsets(world, bix, biz, hint, offsets) {
  let bestX = 0
  let bestZ = 0
  let bestY = 0
  let bestS = Infinity
  for (const pair of offsets) {
    const ox = pair[0]
    const oz = pair[1]
    const ix = bix + ox
    const iz = biz + oz
    const fy = feetYInColumnForPeer(world, ix, iz, hint)
    if (fy == null) continue
    const sc = Math.abs(fy - hint)
    if (sc < bestS) {
      bestS = sc
      bestX = ix + 0.5
      bestZ = iz + 0.5
      bestY = fy
    }
  }
  return bestS < Infinity ? { x: bestX, y: bestY, z: bestZ } : null
}

/**
 * Resolves a safe teleport point near a **live** {@code worldPresence} (x, y, z) feet
 * target. Prefers a **1-block diagonal** offset from the peer’s column (so you don’t land
 * inside their hitbox), then other neighbors, and only then the same cell.
 *
 * @param {any} world
 * @param {number} px  peer feet x (entity coords)
 * @param {number} pz  peer feet z
 * @param {number} hintEntityFeetY  peer feet y
 * @returns {{ x: number, y: number, z: number }}
 */
export function fusLabyResolvePeerTeleportPosition(world, px, pz, hintEntityFeetY) {
  if (!Number.isFinite(px) || !Number.isFinite(pz) || !Number.isFinite(hintEntityFeetY)) {
    return { x: px, y: hintEntityFeetY, z: pz }
  }
  if (!world || typeof world.getBlockAt !== 'function') {
    return { x: px, y: hintEntityFeetY, z: pz }
  }
  const bix = Math.floor(Number(px)) || 0
  const biz = Math.floor(Number(pz)) || 0
  const hint = Number(hintEntityFeetY)
  /** One block diagonally only — try all four before cardinals. */
  const diagonals = [
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ]
  const cardinals = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ]
  const d = bestPeerTeleportAmongOffsets(world, bix, biz, hint, diagonals)
  if (d) return d
  const c = bestPeerTeleportAmongOffsets(world, bix, biz, hint, cardinals)
  if (c) return c
  const s = bestPeerTeleportAmongOffsets(world, bix, biz, hint, [[0, 0]])
  if (s) return s
  return { x: px, y: hint, z: pz }
}
