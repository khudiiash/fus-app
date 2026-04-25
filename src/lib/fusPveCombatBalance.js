/**
 * PvE damage scaling (player ↔ mobs). Separated from PvP so we can tune “same level ≈ fair
 * trade” without touching {@link fusPlayerCombatInstall}.
 *
 * Design (2026-04):
 *   • At equal levels, mob hits cost a fraction of max HP (not raw {@link fusMobDmgHalfForLevel}
 *     which could one-shot low max-HP players).
 *   • One-shot from a mob only when it outlevels the player by ~30+.
 *   • Player damage to mobs is scaled down at parity so fights last several hits, not 1–2.
 */
import { fusAttackDamageHp } from './fusPlayerCombatInstall.js'
import { fusMobDmgHalfForLevel } from '@labymc/src/js/net/minecraft/client/fus/FusMobRegistry.js'

const WARDEN_ID = 'gigant_warden_mob'

/**
 * HP to subtract from the local player when this mob lands a melee hit.
 * @param {{ level?: number, type?: { displayName?: string }, typeId?: string }} mob
 * @param {{ player?: { health?: number, maxHealth?: number }, fusLevel?: number }} mc
 * @returns {number}
 */
export function fusPveMobDamageToPlayerHp(mob, mc) {
  const pl = mc?.player
  if (!pl) return 0
  const plMax = Math.max(2, typeof pl.maxHealth === 'number' && pl.maxHealth > 0 ? pl.maxHealth : 6)
  const plLv = Math.max(1, Math.floor(Number(mc.fusLevel) || 1))
  const mLv = Math.max(1, Math.floor(Number(mob?.level) || 1))
  const delta = mLv - plLv
  const typeId = String(mob?.typeId || mob?.type?.id || 'spider_mob')

  /** At parity, one hit shaves a noticeable chunk; higher-level mobs hit much harder. */
  let frac = 0.1
  if (delta > 0) {
    frac *= 1 + 0.04 * Math.min(40, delta)
  } else {
    frac /= 1 + 0.14 * Math.min(40, -delta)
  }

  let hp = plMax * frac
  if (delta >= 30) {
    hp = plMax
  } else {
    hp = Math.min(hp, plMax * 0.45)
  }
  /** Blend in registry half-hearts so heavy types (e.g. warden) actually hit harder than pests. */
  const half = fusMobDmgHalfForLevel(typeId, mLv, 2)
  const typeMul = Math.min(2.6, 0.32 + half / 12)
  hp *= typeMul
  /**
   * Same player level: higher-level mobs must hit harder than low-level mobs of the same type.
   * (Without this, parity fights felt identical from lv1–lv15 mobs.)
   */
  const absLv = Math.max(1, mLv)
  const mobLevelMul = 0.52 + 0.038 * Math.min(35, absLv - 1)
  hp *= Math.min(2.15, Math.max(0.45, mobLevelMul))
  return Math.max(0.2, Math.min(hp, plMax * 0.58))
}

/**
 * HP to subtract from the mob’s {@code mob.hp} for one player melee swing.
 * @param {any} mc
 * @param {{ level?: number }} mob
 * @returns {number}
 */
export function fusPvePlayerDamageToMobHp(mc, mob) {
  const base = fusAttackDamageHp(mc)
  const plLv = Math.max(1, Math.floor(Number(mc?.fusLevel) || 1))
  const mLv = Math.max(1, Math.floor(Number(mob?.level) || 1))
  const delta = plLv - mLv
  /** Parity: slow fight; mobs a lot of levels up take very few effective HP per swing. */
  let mult = 0.32
  if (delta > 0) {
    mult *= 1 + 0.05 * Math.min(35, delta)
  } else {
    mult /= 1 + 0.2 * Math.min(40, -delta)
  }
  let dmg = base * mult
  if (String(mob?.typeId || mob?.type?.id) === WARDEN_ID) {
    dmg *= 0.38
  }
  return Math.max(0.12, dmg)
}
