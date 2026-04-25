/**
 * Red-screen flash on player damage — uses WebGL ({@link WorldRenderer#queueFusDamageFlash}),
 * not a DOM overlay: the full canvas gets a brief solid red tint for a few frames.
 *
 * Watches {@code mc.player.health} in a RAF loop and triggers on real damage drops.
 * Callers can also fire {@code mc.fusFlashDamage(strength)} when damage bypasses the engine
 * (e.g. remote PvP).
 *
 * @param {any} mc
 * @returns {() => void}
 */
export function installFusDamageFlash(mc) {
  if (!mc || typeof window === 'undefined') return () => {}

  const trigger = (intensity = 0.55) => {
    if (typeof mc.fusIsDead === 'function' && mc.fusIsDead()) {
      clearNow()
      return
    }
    const wr = mc.worldRenderer
    if (wr && typeof wr.queueFusDamageFlash === 'function') {
      wr.queueFusDamageFlash(intensity)
    }
  }

  const clearNow = () => {
    const wr = mc.worldRenderer
    if (wr && typeof wr.clearFusDamageFlash === 'function') {
      wr.clearFusDamageFlash()
    }
  }

  mc.fusFlashDamage = trigger
  mc.fusClearDamageFlash = clearNow
  mc.fusResyncHealthFlashBaseline = () => {
    const pl = mc.player
    prevHealth = pl && typeof pl.health === 'number' ? pl.health : Number.NaN
  }

  let prevHealth = typeof mc.player?.health === 'number' ? mc.player.health : Number.NaN
  let rafId = 0
  let disposed = false

  const MIN_DELTA = 0.05

  const frame = () => {
    if (disposed) return
    rafId = requestAnimationFrame(frame)
    const pl = mc.player
    if (!pl || typeof pl.health !== 'number') {
      prevHealth = Number.NaN
      return
    }
    if (!Number.isFinite(prevHealth)) {
      prevHealth = pl.health
      return
    }
    const delta = prevHealth - pl.health
    if (delta > MIN_DELTA) {
      trigger(0.3 + Math.min(0.45, delta * 0.15))
    }
    prevHealth = pl.health
  }
  rafId = requestAnimationFrame(frame)

  const dispose = () => {
    if (disposed) return
    disposed = true
    if (rafId) cancelAnimationFrame(rafId)
    clearNow()
    if (mc.fusFlashDamage === trigger) mc.fusFlashDamage = undefined
    if (mc.fusClearDamageFlash === clearNow) mc.fusClearDamageFlash = undefined
    if (mc.fusResyncHealthFlashBaseline) mc.fusResyncHealthFlashBaseline = undefined
  }
  mc.fusDisposeDamageFlash = dispose
  return dispose
}
