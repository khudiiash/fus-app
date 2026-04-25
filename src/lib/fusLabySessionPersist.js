const STORAGE_KEY = 'fus_laby_session_v1'
/** Max age for restoring position/health (ms). */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
/** Autosave at most once per this many ms to avoid localStorage write amplification. */
const PERSIST_MIN_INTERVAL_MS = 2500

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
    const hasFlag =
      mc.fusSpawnFlagPos &&
      [mc.fusSpawnFlagPos.x, mc.fusSpawnFlagPos.y, mc.fusSpawnFlagPos.z].every(
        (n) => typeof n === 'number' && Number.isFinite(n),
      )
    if (
      [s.x, s.y, s.z].every((n) => typeof n === 'number' && Number.isFinite(n)) &&
      !hasFlag
    ) {
      pl.setPosition(s.x, s.y, s.z)
    }
    const mx = typeof mc.fusMaxHealth === 'number' && mc.fusMaxHealth > 0 ? mc.fusMaxHealth : 20
    if (typeof s.health === 'number' && Number.isFinite(s.health)) {
      pl.health = Math.max(1, Math.min(mx, s.health))
    }
    if (pl.inventory && typeof s.slot === 'number' && Number.isFinite(s.slot)) {
      const si = Math.max(0, Math.min(8, Math.floor(s.slot)))
      pl.inventory.selectedSlotIndex = si
    }
  } catch (e) {
    console.warn('[fusLabySessionPersist] restore', e)
  }
  if (typeof mc.fusResyncHealthFlashBaseline === 'function') {
    try {
      mc.fusResyncHealthFlashBaseline()
    } catch {
      /* ignore */
    }
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
  const now = Date.now()
  if (
    mc._fusLabyLastSessionWrite != null &&
    now - mc._fusLabyLastSessionWrite < PERSIST_MIN_INTERVAL_MS
  ) {
    return
  }
  try {
    const payload = {
      worldId,
      x: pl.x,
      y: pl.y,
      z: pl.z,
      health: pl.health,
      slot: pl.inventory ? pl.inventory.selectedSlotIndex : 0,
      t: now,
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
    mc._fusLabyLastSessionWrite = now
  } catch (_) {
    /* ignore quota / private mode */
  }
}

/**
 * One-shot save on tab close / PWA background — throttling bypassed so the last pose is
 * not lost on mobile WebKit (often kills JS without a full unload).
 * @param {import('@labymc/src/js/net/minecraft/client/Minecraft.js').default} mc
 * @param {string} worldId
 */
export function flushFusLabySessionToStorage(mc, worldId) {
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
      slot: pl.inventory ? pl.inventory.selectedSlotIndex : 0,
      t: Date.now(),
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  } catch (_) {
    /* ignore */
  }
}
