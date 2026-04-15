import fenmawUrl from '@/game/assets/fenmaw_mob.glb?url'
import gigantWardenUrl from '@/game/assets/gigant_warden_mob.glb?url'
import golemUrl from '@/game/assets/golem_mob.glb?url'
import mutantIronGolemUrl from '@/game/assets/mutant_iron_golem_mob.glb?url'
import spiderUrl from '@/game/assets/spider_mob.glb?url'
import wildBoreUrl from '@/game/assets/wild_bore_mob.glb?url'

export type MobKindId =
  | 'fenmaw'
  | 'gigant_warden'
  | 'golem'
  | 'mutant_iron_golem'
  | 'spider'
  | 'wild_bore'

export type MobKindDef = {
  id: MobKindId
  glbUrl: string
  /** Max HP (integer). */
  hpMax: number
  /** Horizontal move speed (blocks / sec). */
  moveSpeed: number
  /** Detection radius for players. */
  detectRadius: number
  /** Melee reach to apply damage. */
  attackRange: number
  /** Half-heart damage per hit (same units as player HP). */
  attackDamageHalf: number
  /** Min ms between attacks. */
  attackCooldownMs: number
  /** 0 = passive / flees easily, 1 = aggressive. */
  aggro: number
  /** 0 = never flees, 1 = flees often when hurt or vs armed players. */
  cowardice: number
  patrolRadius: number
  /** Uniform scale for this asset in the voxel world. */
  modelScale: number
  /** Gold pickups spawned around corpse on death (synced via RTDB). */
  coinDropCount: number
}

export const MOB_KIND_DEFS: Record<MobKindId, MobKindDef> = {
  fenmaw: {
    id: 'fenmaw',
    glbUrl: fenmawUrl as unknown as string,
    hpMax: 118,
    moveSpeed: 2.35,
    detectRadius: 13,
    /** Must exceed standoff (~2.4m+); sim uses `attackRange * 0.92` vs player feet. */
    attackRange: 3.35,
    attackDamageHalf: 5,
    attackCooldownMs: 820,
    aggro: 0.82,
    cowardice: 0.12,
    patrolRadius: 7,
    modelScale: 1.05,
    coinDropCount: 10,
  },
  gigant_warden: {
    id: 'gigant_warden',
    glbUrl: gigantWardenUrl as unknown as string,
    hpMax: 290,
    moveSpeed: 1.45,
    detectRadius: 16,
    attackRange: 4.05,
    attackDamageHalf: 9,
    attackCooldownMs: 1000,
    aggro: 0.95,
    cowardice: 0.02,
    patrolRadius: 5,
    modelScale: 0.95,
    coinDropCount: 28,
  },
  golem: {
    id: 'golem',
    glbUrl: golemUrl as unknown as string,
    hpMax: 235,
    moveSpeed: 1.55,
    detectRadius: 12,
    attackRange: 3.75,
    attackDamageHalf: 7,
    attackCooldownMs: 920,
    aggro: 0.72,
    cowardice: 0.06,
    patrolRadius: 6,
    modelScale: 1,
    coinDropCount: 18,
  },
  mutant_iron_golem: {
    id: 'mutant_iron_golem',
    glbUrl: mutantIronGolemUrl as unknown as string,
    hpMax: 330,
    moveSpeed: 1.35,
    detectRadius: 14,
    attackRange: 4.1,
    attackDamageHalf: 8,
    attackCooldownMs: 1050,
    aggro: 0.88,
    cowardice: 0.03,
    patrolRadius: 5,
    modelScale: 0.9,
    coinDropCount: 30,
  },
  spider: {
    id: 'spider',
    glbUrl: spiderUrl as unknown as string,
    hpMax: 72,
    moveSpeed: 2.85,
    detectRadius: 11,
    attackRange: 3.15,
    attackDamageHalf: 4,
    attackCooldownMs: 620,
    aggro: 0.78,
    cowardice: 0.35,
    patrolRadius: 8,
    modelScale: 1.15,
    coinDropCount: 4,
  },
  wild_bore: {
    id: 'wild_bore',
    glbUrl: wildBoreUrl as unknown as string,
    hpMax: 92,
    moveSpeed: 2.2,
    detectRadius: 12,
    attackRange: 3.35,
    attackDamageHalf: 4,
    attackCooldownMs: 740,
    aggro: 0.65,
    cowardice: 0.42,
    patrolRadius: 9,
    modelScale: 1.05,
    coinDropCount: 6,
  },
}

export function isMobKindId(s: string): s is MobKindId {
  return Object.prototype.hasOwnProperty.call(MOB_KIND_DEFS, s)
}

export function pickAnimationClip(
  clips: readonly { name: string }[],
  keywords: readonly string[],
): { name: string } | null {
  if (!clips.length) return null
  const lower = clips.map((c) => c.name.toLowerCase())
  for (const key of keywords) {
    const k = key.toLowerCase()
    const i = lower.findIndex((n) => n.includes(k))
    if (i >= 0) return clips[i] ?? null
  }
  return clips[0] ?? null
}
