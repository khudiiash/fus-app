const STORAGE_KEY = 'fus_laby_session_v1'
/** Max age for restoring position/health (ms). */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Restore last position + health after reload (same world only).
 * Call after {@link applyFusPlayerLevelToMinecraft} so max health cap is correct.
 * @param {import('@labymc/src/js/net/minecraft/client/Minecraft.js').default} mc
 * @param {string} worldId
 */
export function restoreFusLabySessionOnce(mc, worldId) {
  if (typeof localStorage === 'undefined' || !mc?.player || !worldId) return
  if (mc._fusLabySessionRestored) return
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      mc._fusLabySessionRestored = true
      return
    }
    const s = JSON.parse(raw)
    if (!s || s.worldId !== worldId) {
      mc._fusLabySessionRestored = true
      return
    }
    const age = Date.now() - (typeof s.t === 'number' ? s.t : 0)
    if (!Number.isFinite(age) || age < 0 || age > MAX_AGE_MS) {
      mc._fusLabySessionRestored = true
      return
    }
    const pl = mc.player
    if ([s.x, s.y, s.z].every((n) => typeof n === 'number' && Number.isFinite(n))) {
      pl.setPosition(s.x, s.y, s.z)
    }
    const mx = typeof mc.fusMaxHealth === 'number' && mc.fusMaxHealth > 0 ? mc.fusMaxHealth : 20
    if (typeof s.health === 'number' && Number.isFinite(s.health)) {
      pl.health = Math.max(1, Math.min(mx, s.health))
    }
  } catch (e) {
    console.warn('[fusLabySessionPersist] restore', e)
  }
  mc._fusLabySessionRestored = true
}

/**
 * Periodic autosave while alive in-game.
 * @param {import('@labymc/src/js/net/minecraft/client/Minecraft.js').default} mc
 * @param {string} worldId
 */
export function tickPersistFusLabySession(mc, worldId) {
  if (typeof localStorage === 'undefined' || !worldId || !mc?.player) return
  if (!mc.isInGame() || mc.currentScreen !== null) return
  const pl = mc.player
  if (pl.health <= 0) return
  try {
    const payload = {
      worldId,
      x: pl.x,
      y: pl.y,
      z: pl.z,
      health: pl.health,
      t: Date.now(),
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  } catch (_) {
    /* ignore quota / private mode */
  }
}
