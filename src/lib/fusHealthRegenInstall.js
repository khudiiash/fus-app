/**
 * Passive HP regen for the local player.
 *
 * • After the last “combat” event (took damage, hit a player, or hit a mob), wait
 *   {@link OUT_OF_COMBAT_MS} with no regen, then add {@link amount} HP every
 *   {@link REGEN_INTERVAL_MS} until full. Each combat event restarts the wait.
 * • `mc.fusMarkCombatForRegen` is set so combat installers can mark outgoing hits
 *   (HP-only detection misses those).
 * • Paused while the engine is frozen (chunk loading / death overlay via `fusFrozen`).
 * • Incoming damage is still detected from `player.health` dropping.
 *
 * @param {any} mc
 * @param {{
 *   outOfCombatMs?: number,
 *   regenIntervalMs?: number,
 *   amount?: number
 * }} [opts]
 *   `outOfCombatMs` — no healing until this long after the last hit (taken or dealt).
 *   `regenIntervalMs` — once eligible, time between +HP ticks.
 * @returns {() => void} dispose
 */
export function installFusHealthRegen(mc, opts = {}) {
  if (!mc) return () => {}
  const _ooc = Number(opts.outOfCombatMs)
  const OUT_OF_COMBAT_MS = Number.isFinite(_ooc) && _ooc >= 0 ? _ooc : 30000
  const _ri = Number(opts.regenIntervalMs)
  const REGEN_INTERVAL_MS = Math.max(200, Number.isFinite(_ri) && _ri > 0 ? _ri : 10000)
  const _amt = Number(opts.amount)
  const amount = Math.max(1, Number.isFinite(_amt) && _amt > 0 ? _amt : 1)

  let disposed = false
  let lastCombatAt = /** @type {number | null} */ (null)
  /** @type {number | null} — wall clock when the next +HP is allowed; null = not scheduled */
  let nextRegenAt = null
  let lastSeenHealth = Number.NaN
  let rafId = 0

  const nowMs = () =>
    typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now()

  const markCombat = () => {
    lastCombatAt = nowMs()
    nextRegenAt = null
  }

  const tick = () => {
    if (disposed) return
    rafId = requestAnimationFrame(tick)
    const pl = mc.player
    if (!pl || mc.fusFrozen) return

    const hp = Number(pl.health)
    const maxHp = Number(pl.maxHealth)
    if (!Number.isFinite(hp) || !Number.isFinite(maxHp) || maxHp <= 0) return

    if (Number.isFinite(lastSeenHealth) && lastSeenHealth <= 0 && hp > 0) {
      /** Respawn / revive — new life, no post-combat lock. */
      lastCombatAt = null
      nextRegenAt = null
    }
    if (Number.isFinite(lastSeenHealth) && hp < lastSeenHealth - 0.01) {
      markCombat()
    }
    lastSeenHealth = hp

    if (hp <= 0) {
      nextRegenAt = null
      return
    }

    const now = nowMs()
    const lockUntil = lastCombatAt != null ? lastCombatAt + OUT_OF_COMBAT_MS : 0
    if (now < lockUntil) return
    if (hp >= maxHp) {
      nextRegenAt = null
      return
    }
    if (nextRegenAt == null) {
      nextRegenAt = lastCombatAt != null ? lockUntil : now + REGEN_INTERVAL_MS
    }
    if (now < nextRegenAt) return

    pl.health = Math.min(maxHp, hp + amount)
    lastSeenHealth = pl.health
    nextRegenAt = now + REGEN_INTERVAL_MS
  }
  rafId = requestAnimationFrame(tick)

  mc.fusMarkCombatForRegen = markCombat

  const dispose = () => {
    if (disposed) return
    disposed = true
    if (mc.fusMarkCombatForRegen === markCombat) {
      mc.fusMarkCombatForRegen = undefined
    }
    if (rafId) {
      cancelAnimationFrame(rafId)
      rafId = 0
    }
  }
  mc.fusDisposeHealthRegen = dispose
  return dispose
}
