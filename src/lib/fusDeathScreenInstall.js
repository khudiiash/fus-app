import Keyboard from '@labymc/src/js/net/minecraft/util/Keyboard.js'
import { fusLabyFeetYAtColumn } from '@/lib/fusLabySpawnFeet'

/**
 * Death-screen driver — health-watcher + respawn coordinator.
 *
 * Why a separate installer rather than baking this into {@link installFusPlayerCombat}?
 *   • Mob kills, fall damage, and future hazards (lava, drowning) all need the same "you
 *     died → show overlay → respawn on click" flow. Keeping the detector centralised here
 *     means every damage source just calls {@link mc.fusRecordDamageFrom} and stops worrying
 *     about UI.
 *   • Respawn logic (flag → fallback world spawn) lives in one place so fixing the
 *     teleport path (e.g. updating to `setPositionAndRotation` when the engine gains it)
 *     is a single-file change.
 *
 * Lifecycle:
 *   1. RAF poll notices `player.health` transitioned from >0 to ≤0.
 *   2. {@link DamageRecord} captured by the most recent {@link mc.fusRecordDamageFrom} call
 *      within the {@link KILL_WINDOW_MS} window is used as the killer label; records older
 *      than this fall back to "Невідомо" (unknown).
 *   3. `onDeath({ killerLabel })` fires exactly once per death transition.
 *   4. `mc.fusRespawnNow()` — called by the Vue overlay's button — heals to `maxHealth`,
 *      teleports to {@link mc.fusSpawnFlagPos} if set, otherwise to `mc.fusDefaultWorldSpawn`
 *      (Laby: 0, 120, 0) or {@link World#getSpawn}, then invokes `onRespawn()`.
 *   5. `mc.fusTeleportToDefaultSpawn()` — settings “unstuck”: same target as (4) when no flag,
 *      no heal (e.g. stuck in blocks). `mc.fusDefaultWorldSpawn` is set when the Laby world loads.
 *
 * Freeze semantics:
 *   While dead (hp ≤ 0 and overlay-visible), we zero out the engine movement inputs every
 *   tick. That keeps WASD / mobile joystick from driving a corpse around and sidesteps the
 *   need to introduce a new "dead" flag in the engine. It's the same freeze pattern the
 *   flag teleport channel uses ({@link fusLabySpawnFlagInstall}).
 *
 * @param {any} mc
 * @param {{
 *   onDeath?: (info: { killerLabel: string, killerUid: string | null }) => void,
 *   onRespawn?: () => void,
 * }} [opts]
 * @returns {() => void} dispose
 */
export function installFusDeathScreen(mc, opts = {}) {
  if (!mc) return () => {}
  const { onDeath, onRespawn } = opts

  /** @typedef {{ type: 'player' | 'mob' | 'world', name: string, uid?: string | null, ts: number }} DamageRecord */
  /** @type {DamageRecord | null} */
  let lastDamage = null
  /** A damage record older than this is considered stale and ignored when attributing a kill.
   *  Long enough to survive short stuns (mob cooldown ~900 ms) + network jitter. */
  const KILL_WINDOW_MS = 4000

  let deathActive = false
  let lastSeenHealth = Number.NaN

  mc.fusRecordDamageFrom = (info) => {
    if (!info || typeof info !== 'object') return
    const type = info.type === 'mob' || info.type === 'world' ? info.type : 'player'
    const name = typeof info.name === 'string' && info.name ? info.name.slice(0, 48) : ''
    const uid = typeof info.uid === 'string' ? info.uid : null
    lastDamage = { type, name, uid, ts: Date.now() }
  }

  const resolveKillerLabel = () => {
    if (!lastDamage) return { killerLabel: 'Невідомо', killerUid: null }
    const age = Date.now() - lastDamage.ts
    if (age > KILL_WINDOW_MS) return { killerLabel: 'Невідомо', killerUid: null }
    if (lastDamage.type === 'mob') {
      return { killerLabel: lastDamage.name || 'Моб', killerUid: null }
    }
    if (lastDamage.type === 'world') {
      return { killerLabel: lastDamage.name || 'Світ', killerUid: null }
    }
    return { killerLabel: lastDamage.name || 'Гравець', killerUid: lastDamage.uid }
  }

  /** Scrub every piece of residual movement state on the player so the engine's next tick
   *  starts from a dead-stop. This is what the user was really asking for with "movement
   *  and velocity not reset" — the previous respawn only zeroed `motion*`, but the player
   *  would still drift because:
   *    - `moveForward`/`moveStrafing` were latched by keys that are still physically held.
   *    - The engine's `prev*` position vectors from the time-of-death frame still looked
   *      stale, causing one-frame interpolation snap.
   *    - `fallDistance` retained the pre-death accumulated fall so the first post-respawn
   *      ground contact re-applied damage immediately (caused a death-loop in testing).
   *
   *  We also call {@link Keyboard.unPressAll} so held keys (WASD, space, shift) don't
   *  immediately re-drive the character. The mobile joystick uses the same `Keyboard.state`
   *  map (see `LabyMobileControls.vue`) so this covers touch input too. */
  /**
   * Teleport the local player and sync `prev*` so remote avatars and interpolation do not
   * streak. Shared by death-respawn, default-spawn-only paths, and {@link mc.fusTeleportToDefaultSpawn}.
   * @param {any} pl
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @param {number} [yaw]
   */
  const applyPos = (pl, x, y, z, yaw) => {
    if (typeof pl.setPositionAndRotation === 'function') {
      pl.setPositionAndRotation(
        x,
        y,
        z,
        Number.isFinite(yaw) ? yaw : pl.rotationYaw || 0,
        pl.rotationPitch || 0,
      )
    } else if (typeof pl.setPosition === 'function') {
      pl.setPosition(x, y, z)
      if (Number.isFinite(yaw) && typeof pl.rotationYaw === 'number') {
        pl.rotationYaw = yaw
      }
    }
    pl.prevX = x
    pl.prevY = y
    pl.prevZ = z
    if (typeof pl.fallDistance === 'number') pl.fallDistance = 0
  }

  const resetPlayerMotion = (pl) => {
    if (!pl) return
    if (typeof pl.motionX === 'number') pl.motionX = 0
    if (typeof pl.motionY === 'number') pl.motionY = 0
    if (typeof pl.motionZ === 'number') pl.motionZ = 0
    if (typeof pl.moveForward === 'number') pl.moveForward = 0
    if (typeof pl.moveStrafing === 'number') pl.moveStrafing = 0
    if (typeof pl.jumping === 'boolean') pl.jumping = false
    if (typeof pl.isSneaking === 'boolean') pl.isSneaking = false
    if (typeof pl.fallDistance === 'number') pl.fallDistance = 0
    if (typeof pl.swingProgress === 'number') pl.swingProgress = 0
    if (typeof pl.swingProgressInt === 'number') pl.swingProgressInt = 0
    if (typeof pl.isSwingInProgress === 'boolean') pl.isSwingInProgress = false
    if (typeof pl.hurtTime === 'number') pl.hurtTime = 0
    if (typeof pl.deathTime === 'number') pl.deathTime = 0
    try {
      Keyboard.unPressAll()
    } catch {
      /* ignore */
    }
  }

  mc.fusRespawnNow = () => {
    const pl = mc.player
    if (!pl) return
    /** Prefer the level-derived max (`mc.fusMaxHealth` — 6 HP at L1, 18 HP at L50) over the
     *  engine's vestigial 20 HP default. If some hot-reload path blew away our level binding
     *  we re-apply the stats install before reading, so an "after death you had 9 hearts at
     *  level 2" bug can't recur. */
    const fusMax = Number(mc.fusMaxHealth)
    const maxHp = Number.isFinite(fusMax) && fusMax > 0
      ? fusMax
      : Math.max(2, Number(pl.maxHealth) || 6)
    pl.maxHealth = maxHp
    pl.health = maxHp
    try {
      mc.fusLastCorpsePresence = null
    } catch {
      /* ignore */
    }
    /** Teleport to the flag if the player has planted one this world, otherwise defer to the
     *  engine's `respawn()` which uses the world spawn point. Prefer
     *  `setPositionAndRotation` because it also resets `prev*` coords — that's what stops
     *  the remote-avatar interpolator on other clients from drawing a stretched streak
     *  between the death location and the respawn spawn. */
    const flag = mc.fusSpawnFlagPos
    if (flag && Number.isFinite(flag.x) && Number.isFinite(flag.y) && Number.isFinite(flag.z)) {
      try {
        const feetY = fusLabyFeetYAtColumn(mc.world, flag.x, flag.z, flag.y)
        applyPos(pl, flag.x + 0.5, feetY, flag.z + 0.5, flag.ry)
      } catch (e) {
        console.warn('[fusDeathScreen] flag teleport failed', e)
      }
    } else {
      try {
        const fixed = mc.fusDefaultWorldSpawn
        const s0 =
          fixed && [fixed.x, fixed.y, fixed.z].every((n) => Number.isFinite(n))
            ? fixed
            : pl.world && typeof pl.world.getSpawn === 'function'
              ? pl.world.getSpawn()
              : null
        if (s0 && Number.isFinite(s0.x) && Number.isFinite(s0.y) && Number.isFinite(s0.z)) {
          applyPos(pl, s0.x, s0.y, s0.z, pl.rotationYaw)
        } else {
          pl.respawn?.()
          pl.prevX = pl.x
          pl.prevY = pl.y
          pl.prevZ = pl.z
        }
      } catch (e) {
        console.warn('[fusDeathScreen] respawn failed', e)
      }
    }
    resetPlayerMotion(pl)
    try {
      mc.fusResetBlockBreakState?.()
    } catch {
      /* ignore */
    }
    lastDamage = null
    lastSeenHealth = maxHp
    deathActive = false
    try {
      mc.fusRefreshSpawnInvuln?.()
    } catch (e) {
      console.warn('[fusDeathScreen] refresh spawn invuln', e)
    }
    try {
      onRespawn?.()
    } catch (e) {
      console.warn('[fusDeathScreen] onRespawn threw', e)
    }
  }

  /**
   * Settings / escape hatch: move to the world's default {@link World#getSpawn} (not the
   * planted flag), same target as a death respawn without the flag. When Laby's channel
   * teleport is installed, uses the same ~15 s channeled TP + VFX as the flag / Key R path;
   * otherwise an instant move. No HP change.
   */
  mc.fusTeleportToDefaultSpawn = () => {
    const pl = mc.player
    if (!pl || !pl.world) return
    if (typeof mc.isInGame === 'function' && !mc.isInGame()) {
      return
    }
    const fixed = mc.fusDefaultWorldSpawn
    const s =
      fixed && [fixed.x, fixed.y, fixed.z].every((n) => Number.isFinite(n))
        ? fixed
        : pl.world.getSpawn()
    if (!s || !Number.isFinite(s.x) || !Number.isFinite(s.y) || !Number.isFinite(s.z)) {
      return
    }
    if (typeof mc.fusLabyStartTeleportToBlockPosChannel === 'function') {
      try {
        mc.fusLabyStartTeleportToBlockPosChannel({ x: s.x, y: s.y, z: s.z })
        return
      } catch (e) {
        console.warn('[fusDeathScreen] channeled default-spawn TP failed', e)
      }
    }
    try {
      applyPos(pl, s.x, s.y, s.z, pl.rotationYaw)
    } catch (e) {
      console.warn('[fusDeathScreen] default spawn teleport failed', e)
      return
    }
    resetPlayerMotion(pl)
    try {
      mc.fusResetBlockBreakState?.()
    } catch {
      /* ignore */
    }
    try {
      mc.fusRefreshSpawnInvuln?.()
    } catch (e) {
      console.warn('[fusDeathScreen] refresh spawn invuln (unstuck)', e)
    }
  }

  mc.fusIsDead = () => deathActive

  let disposed = false
  let rafId = 0
  const tick = () => {
    if (disposed) return
    rafId = requestAnimationFrame(tick)
    const pl = mc.player
    if (!pl) return
    const hp = Number(pl.health)
    if (!Number.isFinite(hp)) return

    /** Transition detection — only fire `onDeath` on the frame HP crosses the zero line.
     *  `lastSeenHealth` starts NaN so the first poll doesn't false-trigger on a player
     *  that was already dead at install time. */
    if (Number.isFinite(lastSeenHealth) && lastSeenHealth > 0 && hp <= 0 && !deathActive) {
      deathActive = true
      /** Kill the hurt-vignette the moment we go into the death state so it doesn't
       *  linger under the respawn card. The flash module already guards future triggers
       *  via `fusIsDead`, but an in-flight 220 ms fade-out would still be visible. */
      try {
        mc.fusClearDamageFlash?.()
      } catch {
        /* ignore */
      }
      /** Release the engine's pointer lock so the cursor becomes visible and the user
       *  can click the respawn button. Without this, the mouse is captured by the game
       *  canvas and the overlay button is technically not clickable — on desktop the
       *  user would be stuck pressing their hotkey alone. `exitPointerLock` is a
       *  no-op when the pointer isn't locked (mobile, unfocused tab). */
      try {
        if (typeof document !== 'undefined' && typeof document.exitPointerLock === 'function') {
          document.exitPointerLock()
        }
      } catch {
        /* ignore */
      }
      const { killerLabel, killerUid } = resolveKillerLabel()
      try {
        onDeath?.({ killerLabel, killerUid })
      } catch (e) {
        console.warn('[fusDeathScreen] onDeath threw', e)
      }
    }
    lastSeenHealth = hp

    if (deathActive) {
      /** Belt-and-suspenders: if anything in the mod stack nudged HP upward while the overlay
       *  is up, we still only broadcast 0 in {@link installFusPresenceWriter} and peers must
       *  not see a "healing" dead body. */
      if (typeof pl.health === 'number' && pl.health > 0) {
        pl.health = 0
      }
    }

    /** Freeze the corpse — zero every motion/input field every frame while dead. Covers:
     *    - `moveForward/moveStrafing/jumping`: in case a held key latched in before the
     *      unPressAll on death. (We don't unPressAll on death itself; only on respawn —
     *      wiping input mid-death loop would silently drop the keys the player is
     *      *currently pressing* and they'd feel a desync when they respawn.)
     *    - `motionX/Y/Z`: stop any residual knockback / gravity drift, matches vanilla
     *      death-cam behaviour.
     *    - `hurtTime`/`deathTime`: engine uses these for red flash + camera roll; without
     *      clearing they tick down slowly and look like an unresponsive animation on long
     *      overlay displays. */
    if (deathActive) {
      if (typeof pl.moveForward === 'number') pl.moveForward = 0
      if (typeof pl.moveStrafing === 'number') pl.moveStrafing = 0
      if (typeof pl.jumping === 'boolean') pl.jumping = false
      if (typeof pl.motionX === 'number') pl.motionX = 0
      if (typeof pl.motionY === 'number') pl.motionY = 0
      if (typeof pl.motionZ === 'number') pl.motionZ = 0
    }
  }
  rafId = requestAnimationFrame(tick)

  /** Desktop keyboard shortcut for respawn.
   *
   *  On desktop the game runs in pointer-lock; even after we release the lock on death
   *  some users instinctively reach for the keyboard instead of the mouse. Binding
   *  Space/Enter to the respawn action keeps the flow keyboard-only and matches the
   *  "Press Space to respawn" convention from vanilla MC. We attach to `window` in the
   *  capture phase so the engine's keydown handlers — which consume Space as "jump" —
   *  don't swallow the event first (they're on `document`/canvas, bubble phase). */
  const onKeyDown = (ev) => {
    if (!deathActive) return
    if (ev.defaultPrevented) return
    const code = ev.code
    if (code !== 'Space' && code !== 'Enter' && code !== 'NumpadEnter') return
    ev.preventDefault()
    ev.stopPropagation()
    try {
      mc.fusRespawnNow?.()
    } catch (e) {
      console.warn('[fusDeathScreen] keybind respawn failed', e)
    }
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', onKeyDown, true)
  }

  const dispose = () => {
    if (disposed) return
    disposed = true
    if (rafId) {
      cancelAnimationFrame(rafId)
      rafId = 0
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', onKeyDown, true)
    }
    mc.fusRecordDamageFrom = undefined
    mc.fusRespawnNow = undefined
    mc.fusTeleportToDefaultSpawn = undefined
    mc.fusIsDead = undefined
  }
  mc.fusDisposeDeathScreen = dispose
  return dispose
}
