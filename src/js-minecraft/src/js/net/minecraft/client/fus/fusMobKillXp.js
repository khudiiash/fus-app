const XP_MAX = 50
/** Same level: 1 or 2 XP. */
const XP_SAME_RNG = 2

/**
 * Laby mob kill XP (used by {@link installFusSimpleMobs} and RTDB kill path).
 * Scales with how much **above** the killer the mob was; much lower (grey) mobs still
 * grant 1 XP so kills never feel "empty" on the XP number alone.
 *
 * @param {string} _typeId
 * @param {number} mobLevel
 * @param {number} _maxHp
 * @param {number} killerLevel
 * @returns {number} 1..50
 */
const WARDEN_ID = 'gigant_warden_mob'

/**
 * Warden: ~2.5× XP vs other mobs of the same level gap.
 * @param {string} typeId
 * @param {number} n
 * @returns {number}
 */
function withMobTypeXpMod(typeId, n) {
  if (String(typeId) === WARDEN_ID) {
    return Math.min(XP_MAX, Math.round(n * 2.4))
  }
  return n
}

export function fusMobKillXpReward(typeId, mobLevel, _maxHp, killerLevel) {
  const mobLv = Math.max(1, Math.floor(Number(mobLevel) || 1))
  const plLv = Math.max(1, Math.floor(Number(killerLevel) || 1))
  const down = plLv - mobLv
  /** Grey mobs: 1 XP (caller also uses Math.max(1, …) as a backstop). */
  if (down >= 2) return withMobTypeXpMod(typeId, 1)
  if (down === 1) return withMobTypeXpMod(typeId, 1)

  const deltaUp = Math.max(0, mobLv - plLv)
  if (deltaUp === 0) {
    return withMobTypeXpMod(typeId, 2 + Math.floor(Math.random() * XP_SAME_RNG))
  }
  /**
   * +1 level and up: steeper than before so L5 vs L7 (Δ=2) clearly beats “+1” grey kills.
   * Scales to ~50 at +30.
   */
  const n = Math.min(
    XP_MAX,
    Math.max(4, Math.round(3 + (50 * Math.min(30, deltaUp)) / 30)),
  )
  return withMobTypeXpMod(typeId, n)
}
