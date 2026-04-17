import * as THREE from 'three'
import { pushPickaxeHit } from '@/game/blockWorldRtdb'
import { BLOCK_WORLD_MAX_REACH } from '@/game/playerConstants'
import { pvpDamageHalfForSelectedSlot, type FusLabyHotbarSlotMeta } from '@/game/labyminecraft/labyHotbarSlotMeta'

type McLike = {
  player: {
    inventory: { selectedSlotIndex: number }
    getPositionEyes: (partialTicks: number) => { x: number; y: number; z: number; squareDistanceTo: (o: unknown) => number }
    rayTrace: (reach: number, partialTicks: number) => { x: number; y: number; z: number } | null
    swingArm: () => void
  }
  worldRenderer: { camera: THREE.PerspectiveCamera }
  fusHotbarSlotMeta?: FusLabyHotbarSlotMeta[] | null
}

function findHitUid(hit: THREE.Intersection): string | null {
  let o: THREE.Object3D | null = hit.object
  while (o) {
    const u = o.userData?.blockWorldHitUid as string | undefined
    if (typeof u === 'string' && u.length > 0) return u
    o = o.parent
  }
  return null
}

export type FusLabyRemoteMeleeContext = {
  worldId: string
  myUid: string
  /** Typically {@link LabyPresenceAvatars#getMeleeRaycastRoots} (Three.Object3D roots). */
  getMeleeRoots: () => object[]
}

const MELEE_COOLDOWN_MS = 420

/**
 * Returns a bound `tryMelee(mc)` for {@link Minecraft#fusTryRemoteMelee}: ray vs presence avatars,
 * respects block line-of-sight priority, pushes {@link pushPickaxeHit} like Block World.
 */
export function createFusLabyRemoteMeleeTry(
  ctx: FusLabyRemoteMeleeContext,
): (mc: McLike) => boolean {
  const raycaster = new THREE.Raycaster()
  const ndc = new THREE.Vector2(0, 0)
  let lastSwingAt = 0

  return (mc: McLike): boolean => {
    const now = performance.now()
    if (now - lastSwingAt < MELEE_COOLDOWN_MS) return false

    const pvp = pvpDamageHalfForSelectedSlot(
      mc.fusHotbarSlotMeta,
      mc.player.inventory.selectedSlotIndex,
    )
    if (pvp <= 0) return false

    const roots = ctx.getMeleeRoots() as THREE.Object3D[]
    if (!roots.length) return false

    const cam = mc.worldRenderer?.camera
    if (!cam) return false

    raycaster.setFromCamera(ndc, cam)
    const hits = raycaster.intersectObjects(roots, true)
    const ph = hits[0]
    if (!ph || ph.distance > BLOCK_WORLD_MAX_REACH + 0.25) return false

    const uid = findHitUid(ph)
    if (!uid || uid === ctx.myUid) return false

    const eyes = mc.player.getPositionEyes(1.0)
    const blockHit = mc.player.rayTrace(BLOCK_WORLD_MAX_REACH, 1.0)
    let blockDistSq = Infinity
    if (blockHit) {
      const bx = blockHit.x + 0.5
      const by = blockHit.y + 0.5
      const bz = blockHit.z + 0.5
      blockDistSq = eyes.squareDistanceTo({ x: bx, y: by, z: bz })
    }
    const phDistSq = ph.distance * ph.distance
    if (blockDistSq + 0.02 < phDistSq) return false

    lastSwingAt = now
    void pushPickaxeHit(ctx.worldId, ctx.myUid, uid, pvp)
    try {
      mc.player.swingArm()
    } catch {
      /* ignore */
    }
    return true
  }
}
