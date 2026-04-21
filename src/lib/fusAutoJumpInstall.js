/**
 * Auto-jump: when the player walks into a 1-block-tall obstacle that they *could* jump
 * onto (solid block ahead at feet level, free block above, and free headroom after the
 * hop), automatically trigger a jump. Mirrors the vanilla Minecraft "Auto-Jump"
 * accessibility option rather than being smart enough to parkour.
 *
 * Why a RAF loop and not a player.onLivingUpdate monkey-patch:
 *   • The engine's collision detection populates `player.collision` at the end of every
 *     physics tick. Reading it each animation frame is cheap and avoids reaching into
 *     protected super.onLivingUpdate() timing.
 *   • Works identically for touch (virtual joystick) and desktop because we only look at
 *     {@code moveForward}/{@code moveStrafing}, which both input paths write to.
 *
 * Scope guarded so it never fires while:
 *   • engine is frozen (`mc.fusFrozen`) — prevents boot-time jump salvos
 *   • player is flying or in water — different physics, different UX expectations
 *   • player is airborne — prevents double-jumps
 *
 * @param {any} mc
 * @returns {() => void} disposer
 */
export function installFusAutoJump(mc) {
  if (!mc) return () => {}

  let rafId = 0
  let disposed = false

  /** Minimum horizontal motion magnitude (blocks / tick²-ish) required before we consider
   * the player "trying to move into something". Anything smaller is drift from slipperiness
   * and shouldn't cause surprise jumps. */
  const MIN_INPUT = 0.02

  const tick = () => {
    if (disposed) return
    rafId = requestAnimationFrame(tick)
    if (mc.fusFrozen) return
    /** Don't jump while channelling a teleport — the channel locks movement and a
     *  sudden hop would both look odd and trivially drift the player past the 1.5-block
     *  cancel radius, auto-cancelling the TP. */
    if (mc.fusLabyChannelLockMove) return
    const pl = mc.player
    const world = mc.world
    if (!pl || !world) return
    if (!pl.onGround) return
    if (pl.flying) return
    if (typeof pl.isInWater === 'function' && pl.isInWater()) return
    if (pl.health <= 0) return

    const mf = pl.moveForward || 0
    const ms = pl.moveStrafing || 0
    if (Math.abs(mf) < MIN_INPUT && Math.abs(ms) < MIN_INPUT) return
    /** Require actual forward collision (engine sets this when horizontal motion is blocked). */
    if (!pl.collision) return

    /** Convert player-local (moveForward, moveStrafing) into world-space XZ direction.
     *  Matches {@code PlayerEntity.moveRelative}: forward = -sin(yaw), cos(yaw) in engine's
     *  coordinate system (yaw rotates with `yaw + 180` quirk). We reproduce the same math
     *  to aim the probe ray correctly — any mismatch here makes auto-jump trigger on
     *  collisions that are *not* in front of the player (users notice).
     */
    const yawRad = ((pl.rotationYaw + 180) * Math.PI) / 180
    const sinY = Math.sin(yawRad)
    const cosY = Math.cos(yawRad)
    const dx = ms * cosY - mf * sinY
    const dz = mf * cosY + ms * sinY
    const len = Math.hypot(dx, dz)
    if (len < 1e-4) return
    const nx = dx / len
    const nz = dz / len

    /** Probe ~0.6 blocks in front of the player (bounding box half-width 0.3 + a pad).
     *  Smaller values miss because `collision` is set when the AABB touched the block,
     *  not when the center crossed it. */
    const probeX = Math.floor(pl.x + nx * 0.6)
    const probeZ = Math.floor(pl.z + nz * 0.6)
    const feetY = Math.floor(pl.y)

    /** Must be a solid block exactly at feet level (step-up candidate). */
    if (!isSolid(world, probeX, feetY, probeZ)) return
    /** Can't be a 2-block wall. */
    if (isSolid(world, probeX, feetY + 1, probeZ)) return
    /** Need headroom one above the landing spot so we don't bonk our skull. */
    if (isSolid(world, probeX, feetY + 2, probeZ)) return
    /** Headroom above current position too (standing in a 1-high tunnel shouldn't jump). */
    if (isSolid(world, Math.floor(pl.x), feetY + 2, Math.floor(pl.z))) return

    try {
      pl.jump?.()
    } catch (e) {
      console.warn('[fusAutoJump] jump threw', e)
    }
  }

  rafId = requestAnimationFrame(tick)

  const dispose = () => {
    if (disposed) return
    disposed = true
    if (rafId) {
      cancelAnimationFrame(rafId)
      rafId = 0
    }
  }
  mc.fusDisposeAutoJump = dispose
  return dispose
}

const isSolid = (world, x, y, z) => {
  try {
    return typeof world.isSolidBlockAt === 'function'
      ? world.isSolidBlockAt(x, y, z)
      : world.getBlockAt(x, y, z) !== 0
  } catch {
    return false
  }
}
