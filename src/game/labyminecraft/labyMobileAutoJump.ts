/**
 * Auto-jump when walking into short obstacles (touch / prismarine-style convenience).
 * Uses Laby world sampling in front of the player; call once per frame from the Vue HUD tick.
 */

type McLike = {
  player: {
    onGround: boolean
    collision: boolean
    rotationYaw: number
    x: number
    y: number
    z: number
    jumpTicks: number
    jump: () => void
  }
  world: { getBlockAt: (x: number, y: number, z: number) => number }
}

const COOLDOWN_MS = 320
let lastAutoJumpAt = 0

function frontCell(mc: McLike): { fx: number; fz: number } {
  const p = mc.player
  const yawRad = ((p.rotationYaw + 180) * Math.PI) / 180
  const dx = -Math.sin(yawRad) * 0.42
  const dz = Math.cos(yawRad) * 0.42
  return {
    fx: Math.floor(p.x + dx),
    fz: Math.floor(p.z + dz),
  }
}

/** Non-air blocks stacked in the front column from foot level up to +2. */
function frontColumnSolidCount(mc: McLike, footY: number, fx: number, fz: number): number {
  const w = mc.world
  let n = 0
  for (let y = footY; y <= footY + 2; y++) {
    if (w.getBlockAt(fx, y, fz) !== 0) n++
  }
  return n
}

function shouldTryAutoJump(mc: McLike): boolean {
  const p = mc.player
  const w = mc.world
  if (!p.onGround || !p.collision) return false

  const footY = Math.floor(p.y - 0.2)
  const { fx, fz } = frontCell(mc)
  const solids = frontColumnSolidCount(mc, footY, fx, fz)
  if (solids === 0) return false
  if (solids >= 3) return false

  // Need headroom above feet for a jump arc (single layer or low lip).
  const head1 = w.getBlockAt(fx, footY + 2, fz)
  const head2 = w.getBlockAt(fx, footY + 3, fz)
  if (head1 !== 0 && head2 !== 0) return false

  return true
}

export function tickLabyFusMobileAutoJump(
  mc: McLike | null | undefined,
  opts: { enabled: boolean; wantsMove: boolean },
): void {
  if (!opts.enabled || !mc?.player || !mc.world) return
  const p = mc.player
  if (!opts.wantsMove) return
  if (!p.onGround || !p.collision) return
  if (p.jumpTicks > 0) return

  const now = performance.now()
  if (now - lastAutoJumpAt < COOLDOWN_MS) return

  if (!shouldTryAutoJump(mc)) return

  p.jump()
  p.jumpTicks = 10
  lastAutoJumpAt = now
}
