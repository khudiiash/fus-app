import {
  onDisconnect,
  ref as dbRef,
  serverTimestamp,
  update as dbUpdate,
} from 'firebase/database'

/**
 * Local-player → `worldPresence/{worldId}/{uid}` writer.
 *
 * Design:
 *   • RAF loop throttled to ~PRESENCE_WRITE_MS (≈20 Hz) for movement; anim / swing / hp
 *     changes bypass the spacing gate so walk→idle and attacks are not held back.
 *   • Only writes when something actually changed (pose, anim, hp, held, pvp state).
 *   • Registers `onDisconnect()` so peers see `{left:true}` the instant the tab closes.
 *   • `mc.fusMarkSwing()` and `mc.fusMarkHeldItem(id)` exposed for feature modules that
 *     know about attack swings / hotbar changes to push an immediate write.
 *
 * Schema written:
 *   {
 *     name: string, skinUrl: string|null, slim: boolean,
 *     x, y, z: number,                 // feet position (entity y)
 *     ry: number,                      // body/head yaw, degrees (engine native)
 *     rp: number,                      // head pitch, degrees
 *     hp, maxHp: number,
 *     anim: 'idle' | 'walk' | 'run' | 'attack',
 *     heldId: number,                  // engine block/tool id (0 = empty)
 *     swingAt: number,                 // ms wall clock of last swing start
 *     pvpMode: 'white' | 'purple' | 'red',
 *     karma: number,
 *     left: boolean,                   // always false while connected; onDisconnect flips it
 *     at: serverTimestamp,
 *     clientMs: number,                // for staleness detection by peers
 *   }
 *
 * @param {any} mc
 * @param {{ worldId: string, uid: string, rtdb: any, displayName?: string, skinUrl?: string|null, slim?: boolean }} opts
 * @returns {() => void} dispose fn
 */
export function installFusPresenceWriter(mc, { worldId, uid, rtdb, displayName, skinUrl, slim }) {
  if (!mc || !rtdb || !worldId || !uid) return () => {}

  const PRESENCE_WRITE_MS = 50
  const PRESENCE_IDLE_WRITE_MS = 1500
  const MOVE_EPS = 0.01
  const ROT_EPS = 0.5

  const presRef = dbRef(rtdb, `worldPresence/${worldId}/${uid}`)

  /** Flip `left:true` the instant the tab dies so peers despawn this avatar cleanly. */
  try {
    onDisconnect(presRef).update({ left: true, at: serverTimestamp() })
  } catch (e) {
    console.warn('[fusPresenceWriter] onDisconnect install failed', e)
  }

  /** Set by {@code mc.fusMarkSwing}; keeps {@code anim: 'attack'} on RTDB long enough for
   *  peers' pickup + arm arc (short swings were invisible between RTDB samples). */
  let attackAnimUntilMs = 0
  const ATTACK_PRESENCE_MS = 520
  /** Monotonic — peers use this to restart the attack arm even when {@code swingAt} matches. */
  let swingSerial = 0
  let lastSentSwingSerial = -1

  const state = {
    name: String(displayName || 'Player').slice(0, 24),
    skinUrl: skinUrl || null,
    slim: !!slim,
    lastX: Number.NaN,
    lastY: Number.NaN,
    lastZ: Number.NaN,
    lastRy: Number.NaN,
    lastRp: Number.NaN,
    lastHp: Number.NaN,
    lastMax: Number.NaN,
    lastAnim: '',
    lastHeld: -1,
    lastHeldTool: '',
    lastMode: '',
    lastKarma: -1,
    lastSwingAt: 0,
    lastWriteMs: 0,
    lastMoveMs: 0,
    walkAccum: 0,
    lastSwingObserved: -1,
    lastInvUntil: -1,
  }

  /**
   * `fusPlaceSpawnFlag` / hotbar code can set a held id hint so the presence write picks
   * the authoritative value without having to decode the engine's inventory every frame.
   */
  mc.fusSetHeldHint = (id) => {
    if (typeof id === 'number' && id >= 0) {
      state.lastHeld = id | 0
      state.lastWriteMs = 0
    }
  }

  mc.fusSetPresenceName = (nm) => {
    if (typeof nm === 'string' && nm.length > 0) {
      state.name = nm.slice(0, 24)
      state.lastWriteMs = 0
    }
  }
  mc.fusSetPresenceSkin = (url, slimFlag) => {
    state.skinUrl = url || null
    state.slim = !!slimFlag
    state.lastWriteMs = 0
  }

  let rafId = 0
  let disposed = false

  const getHeld = () => {
    const inv = mc.player?.inventory
    if (!inv) return { heldId: 0, heldTool: '' }
    const sel = typeof inv.selectedSlotIndex === 'number' ? inv.selectedSlotIndex : 0
    let heldId = 0
    try {
      const id =
        typeof inv.getItemInSlot === 'function'
          ? inv.getItemInSlot(sel)
          : typeof inv.getItemStack === 'function'
          ? inv.getItemStack(sel)
          : 0
      heldId = typeof id === 'number' ? id : 0
    } catch {
      heldId = 0
    }
    /** `fusHotbarSlotMeta` (see {@link resolveFusLabyHotbar}) carries the tool's GLB mesh name
     *  — peers use it to render the correct tools.glb object in the hand instead of a placeholder. */
    const meta = mc.fusHotbarSlotMeta?.[sel]
    const heldTool = meta && meta.kind === 'tool' && typeof meta.toolMeshName === 'string' ? meta.toolMeshName : ''
    return { heldId, heldTool }
  }

  const getPvp = () => {
    const s = mc.fusPvpSelfState
    const mode = s?.mode === 'red' || s?.mode === 'purple' ? s.mode : 'white'
    const karma = Number.isFinite(Number(s?.karma)) ? Number(s.karma) : 0
    return { mode, karma }
  }

  const classifyAnim = (pl, now, dtMs) => {
    if (Number.isFinite(attackAnimUntilMs) && now < attackAnimUntilMs) {
      return 'attack'
    }
    /**
     * Attack only while an arm swing is in progress. {@link EntityLiving#updateArmSwingProgress}
     * sets `swingProgressInt = 0` when idle, not -1 — so we must not treat `sp >= 0` alone as
     * attack or we'd never send walk/run.
     */
    const sp = Number(pl.swingProgressInt)
    const inArmSwing = pl.isSwingInProgress === true
    if (inArmSwing && Number.isFinite(sp) && sp >= 0) {
      if (sp !== state.lastSwingObserved && sp <= 2) {
        /** Rising edge of a swing — push a timestamp so remote can time the clip. */
        state.lastSwingAt = now
      }
      state.lastSwingObserved = sp
      return 'attack'
    }
    state.lastSwingObserved = -1
    /** User input — set every tick before physics; more reliable than motionX when friction zeros motion. */
    const mCtrl =
      Math.abs(Number(pl.moveForward) || 0) + Math.abs(Number(pl.moveStrafing) || 0)
    const sprinting = pl.sprinting === true || (typeof pl.isSprinting === 'function' && pl.isSprinting())
    if (mCtrl > 0.0001) {
      return sprinting ? 'run' : 'walk'
    }
    /**
     * Horizontal motion. The delta `(pl - lastWrite)` lags; motionX/Z is instant in-world.
     */
    const motX = Number(pl.motionX) || 0
    const motZ = Number(pl.motionZ) || 0
    if (motX * motX + motZ * motZ > 0.0002) {
      return sprinting ? 'run' : 'walk'
    }
    const vx = pl.x - state.lastX
    const vz = pl.z - state.lastZ
    const speed2 = (vx * vx + vz * vz) / Math.max(1e-3, dtMs / 1000) ** 2
    /** (blocks/s)² — ~5.3+ m/s reads as sprint; walking ~4.3 m/s stays below. */
    if (speed2 > 28) {
      return 'run'
    }
    /** Lowered from 0.36 — (blocks/s)², enough headroom for slow / lagged position deltas. */
    if (speed2 > 0.04) {
      return sprinting ? 'run' : 'walk'
    }
    return 'idle'
  }

  /**
   * Fire-and-forget `dbUpdate` (no write queue). A serial queue of `await` here backed up
   * every RAF+swing for seconds — peers saw actions long after the fact.
   */
  async function writeRowInner(forceImmediate) {
    const pl = mc.player
    if (!pl) return
    const now = Date.now()
    const dt = state.lastWriteMs > 0 ? now - state.lastWriteMs : PRESENCE_WRITE_MS
    const liveX = Number(pl.x)
    const liveY = Number(pl.y)
    const liveZ = Number(pl.z)
    const liveRy = Number(pl.rotationYaw)
    const liveRp = Number(pl.rotationPitch)
    /** Preserve half-heart precision. Damage resolves in half-heart increments (fist = 1 half =
     *  0.5 HP), so plain `Math.round` was eating every fist hit — the remote observer would
     *  see `hp:6` -> `hp:6` -> `hp:5`, missing the per-hit flash and only updating on every
     *  other swing. Sending halves doubles the granularity; the network cost is a single
     *  digit more per presence write. */
    const rawHp = Math.max(0, Math.round(Number(pl.health) * 2) / 2 || 0)
    const maxHp = Math.max(1, Math.round(Number(pl.maxHealth) * 2) / 2 || 20)
    /** While dead (HP≤0) peers only need name + empty bar — never broadcast movement, regen
     *  ticks, or walk/attack. Freeze the first 0-hp frame’s pose; clear on respawn. */
    if (rawHp > 0) {
      try {
        mc.fusLastCorpsePresence = null
      } catch {
        /* ignore */
      }
    } else {
      if (!mc.fusLastCorpsePresence || typeof mc.fusLastCorpsePresence !== 'object') {
        try {
          mc.fusLastCorpsePresence = {
            x: liveX,
            y: liveY,
            z: liveZ,
            ry: liveRy,
            rp: liveRp,
          }
        } catch {
          /* ignore */
        }
      }
    }
    const cp = mc.fusLastCorpsePresence
    const frozen =
      rawHp <= 0 &&
      cp &&
      typeof cp === 'object' &&
      [cp.x, cp.y, cp.z, cp.ry, cp.rp].every((v) => Number.isFinite(Number(v)))
    const x = frozen ? Number(cp.x) : liveX
    const y = frozen ? Number(cp.y) : liveY
    const z = frozen ? Number(cp.z) : liveZ
    const ry = frozen ? Number(cp.ry) : liveRy
    const rp = frozen ? Number(cp.rp) : liveRp
    const hp = rawHp <= 0 ? 0 : rawHp
    const anim = rawHp <= 0 ? 'idle' : classifyAnim(pl, now, Math.max(16, dt))
    const { heldId, heldTool } = rawHp <= 0 ? { heldId: 0, heldTool: '' } : getHeld()
    const { mode, karma } = getPvp()
    const invUntil = Number.isFinite(mc.fusSpawnInvulnUntilMs) ? Math.floor(mc.fusSpawnInvulnUntilMs) : 0

    const moved =
      Math.abs(x - state.lastX) > MOVE_EPS ||
      Math.abs(y - state.lastY) > MOVE_EPS ||
      Math.abs(z - state.lastZ) > MOVE_EPS ||
      Math.abs(ry - state.lastRy) > ROT_EPS ||
      Math.abs(rp - state.lastRp) > ROT_EPS
    const stateChanged =
      hp !== state.lastHp ||
      maxHp !== state.lastMax ||
      anim !== state.lastAnim ||
      heldId !== state.lastHeld ||
      heldTool !== state.lastHeldTool ||
      mode !== state.lastMode ||
      karma !== state.lastKarma ||
      swingSerial !== lastSentSwingSerial ||
      invUntil !== state.lastInvUntil
    const idleTimeUp = now - state.lastWriteMs > PRESENCE_IDLE_WRITE_MS
    /** HP changes (and maxHp, and death) are user-visible events: peers want the flash/burst
     *  immediately, not on the next spacing tick. */
    const hpCrossed = hp !== state.lastHp || maxHp !== state.lastMax

    if (!forceImmediate && !moved && !stateChanged && !idleTimeUp) return
    /** Throttle *position* spam only. Previously this gate ran for every `writeRow` call, so
     *  a walk→idle flip with no micro-move (common when releasing keys) was dropped until the
     *  next window — remotes saw running for seconds after a stop. */
    if (!forceImmediate && !hpCrossed && now - state.lastWriteMs < PRESENCE_WRITE_MS && !stateChanged) {
      return
    }

    state.lastX = x
    state.lastY = y
    state.lastZ = z
    state.lastRy = ry
    state.lastRp = rp
    state.lastHp = hp
    state.lastMax = maxHp
    state.lastAnim = anim
    state.lastHeld = heldId
    state.lastHeldTool = heldTool
    state.lastMode = mode
    state.lastKarma = karma
    state.lastInvUntil = invUntil
    state.lastWriteMs = now

    const payload = {
      name: state.name,
      skinUrl: state.skinUrl || null,
      slim: !!state.slim,
      x,
      y,
      z,
      ry,
      rp,
      hp,
      maxHp,
      anim,
      heldId: heldId | 0,
      heldTool: heldTool || '',
      swingAt: state.lastSwingAt,
      swingSerial,
      pvpMode: mode,
      karma,
      left: false,
      clientMs: now,
      at: serverTimestamp(),
      invUntil,
    }
    try {
      await dbUpdate(presRef, payload)
      lastSentSwingSerial = swingSerial
    } catch (e) {
      /** Don't spam on transient failures — RTDB writes will resume on their own. */
      if (!state.lastWriteWarn || Date.now() - state.lastWriteWarn > 30_000) {
        state.lastWriteWarn = Date.now()
        console.warn('[fusPresenceWriter] update failed', e)
      }
    }
  }

  const writeRow = (forceImmediate) => writeRowInner(forceImmediate)

  mc.fusMarkSwing = () => {
    const t = Date.now()
    state.lastSwingAt = t
    state.lastWriteMs = 0
    attackAnimUntilMs = t + ATTACK_PRESENCE_MS
    swingSerial = (swingSerial + 1) | 0
    void writeRowInner(true)
  }
  /** Flush pose + hp to RTDB on the same tick (e.g. local player just died). @returns {Promise<void>} */
  mc.fusForcePresenceWrite = () => writeRowInner(true)

  const tick = () => {
    if (disposed) return
    rafId = requestAnimationFrame(tick)
    if (!mc.player) return
    void writeRow(false)
  }
  rafId = requestAnimationFrame(tick)

  const dispose = () => {
    if (disposed) return
    disposed = true
    if (rafId) cancelAnimationFrame(rafId)
    try {
      mc.fusLastCorpsePresence = null
    } catch {
      /* ignore */
    }
    try {
      void dbUpdate(presRef, { left: true, at: serverTimestamp(), clientMs: Date.now() })
    } catch (e) {
      console.warn('[fusPresenceWriter] final write', e)
    }
    mc.fusMarkSwing = undefined
    mc.fusForcePresenceWrite = undefined
    mc.fusSetHeldHint = undefined
    mc.fusSetPresenceName = undefined
    mc.fusSetPresenceSkin = undefined
  }
  mc.fusDisposePresenceWriter = dispose
  return dispose
}
