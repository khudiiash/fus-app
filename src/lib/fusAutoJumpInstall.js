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

  /** Minimum horizontal motion-input magnitude required before we consider the player
   *  "trying to move". 0.02 covers slight analog-stick drift but still lets a real
   *  joystick nudge fire. */
  const MIN_INPUT = 0.02
  /** Throttle so the same hop doesn't re-trigger on the next frame if the player is
   *  still mid-air. 280 ms ≈ a typical step-up arc, fast enough to chain up a staircase. */
  const MIN_JUMP_INTERVAL_MS = 280

  let lastJumpAt = 0

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

    const now = performance.now()
    if (now - lastJumpAt < MIN_JUMP_INTERVAL_MS) return

    /** Convert player-local input into a **world-space physical-displacement** XZ
     *  direction.
     *
     *  Engine subtlety — the gotcha that caused the previous revision of this module
     *  to probe in the wrong direction (user report: "auto-jump fires when I step
     *  back from the block"):
     *
     *    • {@link PlayerEntity#moveRelative} computes a motion vector via
     *      `dx_motion =  strafe*cos - forward*sin`
     *      `dz_motion =  forward*cos + strafe*sin`   with yaw = rotationYaw + 180
     *    • BUT the engine then calls {@code moveCollide(-motionX, motionY, -motionZ)},
     *      so the **actual BB displacement** each tick is the *negation* of those
     *      components. I.e. a `moveForward = 1` (W) at yaw=0 produces a motion vector
     *      of `(0, -1)` but physically moves the player to `(0, +1)` after the
     *      sign-flip in `moveCollide`.
     *
     *  Auto-jump wants to probe where the player will *actually end up*, not where
     *  the motion vector happens to point in engine-internal units, so we invert
     *  both components. (Equivalent to feeding the engine-flipped yaw; keeping the
     *  original formula plus an explicit negate makes the intent obvious for the
     *  next person to read this.)
     */
    const yawRad = ((pl.rotationYaw + 180) * Math.PI) / 180
    const sinY = Math.sin(yawRad)
    const cosY = Math.cos(yawRad)
    const motionX = ms * cosY - mf * sinY
    const motionZ = mf * cosY + ms * sinY
    const dx = -motionX
    const dz = -motionZ
    const len = Math.hypot(dx, dz)
    if (len < 1e-4) return
    const nx = dx / len
    const nz = dz / len

    /** Two probe distances. 0.35 catches the "I'm already against the wall" case where
     *  the BB has clipped flush against the block and the player's centre is barely
     *  touching the cell boundary; 0.75 catches the "I'm walking at full speed, the
     *  wall is 1 step ahead" case so we hop *before* visually slamming into it. If
     *  either distance finds a step-able block, we jump. We don't rely on
     *  {@code pl.collision} anymore — that flag flickers on for a single tick after
     *  moveCollide clips horizontal motion and RAF frames miss it constantly on
     *  phones, which is the entire reason auto-jump felt broken. */
    const PROBE_DISTANCES = [0.35, 0.75]
    const feetY = Math.floor(pl.y + 0.02) /** +0.02 so a foot sitting on block Y doesn't floor to Y-1 */
    /** Head clearance above the current cell — if the tunnel we're in is only 1 high we
     *  can't jump out of it regardless of what's ahead. */
    if (isSolid(world, Math.floor(pl.x), feetY + 2, Math.floor(pl.z))) return

    let wantJump = false
    for (const d of PROBE_DISTANCES) {
      const px = Math.floor(pl.x + nx * d)
      const pz = Math.floor(pl.z + nz * d)
      /** Target cell must be a 1-high step: solid at feet, air at feet+1 and feet+2. */
      if (!isSolid(world, px, feetY, pz)) continue
      if (isSolid(world, px, feetY + 1, pz)) continue
      if (isSolid(world, px, feetY + 2, pz)) continue
      wantJump = true
      break
    }
    if (!wantJump) return

    try {
      pl.jump?.()
      lastJumpAt = now
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
