import type { PresenceDoc } from '@/game/sharedWorldFirestore'
import { BLOCK_WORLD_MAX_HP_HALF_UNITS } from '@/game/playerConstants'

/** Minimal player surface read from js-minecraft {@link PlayerEntity}. */
export type LabyPresencePlayerLike = {
  x: number
  y: number
  z: number
  rotationYaw: number
  rotationYawHead: number
  getEyeHeight: () => number
  moveForward: number
  moveStrafing: number
  jumping: boolean
  /** {@link EntityLiving#health} — half-heart units (0–20) when present. */
  health?: number
}

/**
 * Horizontal yaw (radians) for the remote root, same basis as {@link EntityRenderer} /
 * {@link WorldRenderer#orientCamera}: `toRadians(-rotationYaw + 180)`.
 *
 * Vanilla entity meshes also use `scale(-s, -s, s)`; our Laby skin rig does not, so
 * {@link LabyPresenceAvatars} applies an extra π on the root to match visible facing.
 */
export function labyPresenceRyFromPlayer(player: LabyPresencePlayerLike): number {
  return ((-(player.rotationYaw) + 180) * Math.PI) / 180
}

/** Head vs body (radians), same basis as vanilla `rotationYawHead - rotationYaw`. */
export function labyPresenceHeadYawOffsetRad(player: LabyPresencePlayerLike): number {
  let d = player.rotationYawHead - player.rotationYaw
  while (d > 180) d -= 360
  while (d < -180) d += 360
  return (d * Math.PI) / 180
}

export function labyPlayerMovingForPresence(player: LabyPresencePlayerLike): boolean {
  return (
    Math.abs(player.moveForward) > 0.02 ||
    Math.abs(player.moveStrafing) > 0.02 ||
    Boolean(player.jumping)
  )
}

export function buildLabyPresenceDoc(
  player: LabyPresencePlayerLike | null | undefined,
  profile: {
    displayName: string
    skinUrl: string | null
    photoUrl: string | null
  },
  overrides?: Partial<PresenceDoc> | null,
): PresenceDoc | null {
  if (
    player == null ||
    typeof player.getEyeHeight !== 'function' ||
    !Number.isFinite(player.x) ||
    !Number.isFinite(player.y) ||
    !Number.isFinite(player.z)
  ) {
    return null
  }
  const hpRaw = player.health
  const playerHpHalfUnits =
    typeof hpRaw === 'number' && Number.isFinite(hpRaw)
      ? Math.min(BLOCK_WORLD_MAX_HP_HALF_UNITS, Math.max(0, Math.ceil(hpRaw)))
      : BLOCK_WORLD_MAX_HP_HALF_UNITS

  const doc: PresenceDoc = {
    x: player.x,
    y: player.y + player.getEyeHeight(),
    z: player.z,
    ry: labyPresenceRyFromPlayer(player),
    hr: labyPresenceHeadYawOffsetRad(player),
    moving: labyPlayerMovingForPresence(player),
    skinUrl: profile.skinUrl,
    photoUrl: profile.photoUrl,
    displayName: profile.displayName,
    mode: 'mine',
    slot: 0,
    bwBlockType: 0,
    bwHandMine: 'fist',
    bwToolMesh: null,
    handSwingSeq: 0,
    playerHpHalfUnits,
  }
  if (overrides) {
    Object.assign(doc, overrides)
  }
  return doc
}
