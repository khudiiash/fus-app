/**
 * Red-screen flash on player damage.
 *
 * Watches {@code mc.player.health} in a RAF loop and kicks the overlay opacity to 0.45
 * whenever health drops (>0.05 delta — ignores regen wiggle from food/sat ticks). The
 * overlay lives directly under {@code document.body} so it's agnostic to which Vue view is
 * currently mounted and can't be z-index-fought by the in-game HUD.
 *
 * Hooks into the PvP / mob-damage path so callers can force a flash ({@code mc.fusFlashDamage()})
 * when they deal the damage themselves — useful when a remote-PvP hit bypasses the engine's
 * {@code player.damage} method.
 *
 * @param {any} mc
 * @returns {() => void}
 */
export function installFusDamageFlash(mc) {
  if (!mc || typeof document === 'undefined') return () => {}

  /**
   * Single fixed-position overlay: pointer-events:none so it never eats clicks, z-index
   * above every in-game overlay but below any modal <dialog>. 2147483000 is deliberately
   * *below* the browser's synthetic max (2^31 − 1) so a floating toast/dialog can still
   * win in a fight for stacking order if one ever comes along.
   */
  const el = document.createElement('div')
  el.setAttribute('data-fus', 'damage-flash')
  el.style.cssText = [
    'position:fixed',
    'inset:0',
    'pointer-events:none',
    'background:radial-gradient(circle at center, rgba(220,20,20,0) 30%, rgba(220,20,20,0.8) 100%)',
    'opacity:0',
    'transition:opacity 260ms ease-out',
    'z-index:2147483000',
    'mix-blend-mode:multiply',
  ].join(';')
  document.body.appendChild(el)

  let resetTimeout = 0
  const trigger = (intensity = 0.55) => {
    el.style.opacity = String(Math.min(0.85, Math.max(0.15, intensity)))
    if (resetTimeout) window.clearTimeout(resetTimeout)
    resetTimeout = window.setTimeout(() => {
      el.style.opacity = '0'
      resetTimeout = 0
    }, 220)
  }
  mc.fusFlashDamage = trigger

  let prevHealth = typeof mc.player?.health === 'number' ? mc.player.health : Number.NaN
  let rafId = 0
  let disposed = false

  /** Threshold picked to ignore hunger-regen ticks (which oscillate in ±0.01 range in some
   *  engine forks). Real hits deal at least 0.5 health. */
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
      /** Scale intensity with damage taken (half-heart ≈ 0.5 → mild; full heart ≈ 1 → strong). */
      trigger(0.3 + Math.min(0.45, delta * 0.15))
    }
    prevHealth = pl.health
  }
  rafId = requestAnimationFrame(frame)

  const dispose = () => {
    if (disposed) return
    disposed = true
    if (rafId) cancelAnimationFrame(rafId)
    if (resetTimeout) window.clearTimeout(resetTimeout)
    el.remove()
    if (mc.fusFlashDamage === trigger) mc.fusFlashDamage = undefined
  }
  mc.fusDisposeDamageFlash = dispose
  return dispose
}
