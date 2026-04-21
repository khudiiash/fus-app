import {
  onValue,
  ref as dbRef,
  serverTimestamp,
  set as dbSet,
  update as dbUpdate,
} from 'firebase/database'

/**
 * Lineage-2-style PvP / karma system.
 *
 * Three modes:
 *   • **white**  – innocent / default. Killing a white player flips the attacker red (PK).
 *   • **purple** – flagged for PvP. Entered automatically on attacking another player and
 *     kept alive while we land more hits within {@link PURPLE_WINDOW_MS}. When the window
 *     lapses without a fresh hit, we fall back to white. Purple players can be killed
 *     without the killer gaining karma.
 *   • **red**    – chaotic / PK. Entered by killing a white player. Stored as an integer
 *     `karma` counter: each PK adds 1, each player-death removes 1, and *time* decays
 *     1 point per {@link KARMA_POINT_MS}. A red player dropping to karma 0 reverts to
 *     white. Being red means any other player can kill us without karma consequences.
 *
 * RTDB doc at `worldPlayerPvp/{worldId}/{uid}`:
 * ```
 * {
 *   mode: 'white' | 'purple' | 'red',
 *   karma: number,            // 0 unless red
 *   purpleExpiresAt: number,  // server-time ms
 *   lastUpdateAt: number,
 * }
 * ```
 * We subscribe once on install, cache remote docs on {@code mc.fusPvpStateByUid}, and
 * expose {@code mc.fusPvpColorFor(uid)} for any avatar / nametag renderer to query.
 *
 * Public imperative API (the owner of combat code calls these):
 *   • {@code mc.fusPvp.onHitPlayer(targetUid)} — we dealt damage to someone (no kill).
 *   • {@code mc.fusPvp.onKillPlayer(targetUid, targetModeAtKill)} — we killed someone; if
 *     target was white, +1 karma and mode → red.
 *   • {@code mc.fusPvp.onDeath(killerUid, dropContext?)} — we died; karma -= 1 (if red),
 *     and when red we emit a "drop request" on `window.__FUS_ON_PK_DEATH_DROPS__` so the
 *     Vue view can take coins / tools out of inventory (drop pipeline deliberately lives
 *     outside the engine — tool deletion is a shop-state concern, not a block-world one).
 *
 * Local persistence: karma survives page reloads via localStorage so a refresh doesn't
 * let a red player "reset" themselves.
 *
 * @param {any} mc
 * @param {{ worldId: string, uid: string, rtdb: any }} opts
 * @returns {() => void}
 */
export function installFusPvpKarma(mc, { worldId, uid, rtdb }) {
  if (!mc) return () => {}

  /** @typedef {{ mode: 'white'|'purple'|'red', karma: number, purpleExpiresAt: number, lastUpdateAt: number }} PvpState */

  const LS_KEY = `fus:pvpKarma:v1:${uid}`
  /** @type {PvpState} */
  const initial = loadLocalState(LS_KEY)
  /** Apply time-based karma decay that happened while the page was closed. */
  decayKarma(initial)

  /** @type {PvpState} */
  let state = initial
  /** @type {Map<string, PvpState>} */
  const remote = new Map()
  mc.fusPvpStateByUid = remote
  mc.fusPvpSelfState = state

  /** Track the most recent hit timestamp so we can expire purple mode on the RAF clock. */
  let lastHitAtMs = 0

  const writeRemote = () => {
    if (!rtdb || !worldId || !uid) return
    dbSet(dbRef(rtdb, `worldPlayerPvp/${worldId}/${uid}`), {
      mode: state.mode,
      karma: state.karma,
      purpleExpiresAt: state.purpleExpiresAt,
      lastUpdateAt: serverTimestamp(),
    }).catch((e) => console.warn('[fusPvpKarma] RTDB write failed', e))
  }

  const writeLocal = () => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(state))
    } catch {
      /* quota — ignore */
    }
  }

  const setMode = (mode) => {
    if (state.mode === mode) return
    state.mode = mode
    state.lastUpdateAt = Date.now()
    mc.fusPvpSelfState = state
    writeLocal()
    writeRemote()
  }

  const reconcileMode = () => {
    /** Priority: red (karma > 0) > purple (active window) > white. */
    if (state.karma > 0) {
      setMode('red')
      return
    }
    if (state.purpleExpiresAt > Date.now()) {
      setMode('purple')
      return
    }
    setMode('white')
  }

  /** Sync reconcile on install (handles LS karma that decayed to 0 while offline). */
  reconcileMode()
  writeRemote()

  const onHitPlayer = (targetUid) => {
    if (!targetUid || targetUid === uid) return
    lastHitAtMs = Date.now()
    if (state.mode === 'red') {
      /** Red stays red; but extend purple so post-red periods don't flap back to white mid-fight. */
      state.purpleExpiresAt = Math.max(state.purpleExpiresAt, lastHitAtMs + PURPLE_WINDOW_MS)
    } else {
      state.purpleExpiresAt = lastHitAtMs + PURPLE_WINDOW_MS
      setMode('purple')
    }
    state.lastUpdateAt = Date.now()
    writeLocal()
    writeRemote()
  }

  const onKillPlayer = (targetUid, targetModeAtKill) => {
    if (!targetUid || targetUid === uid) return
    /** Killing a purple or red target is "legal" — no karma. Killing a white is a PK. */
    if (targetModeAtKill === 'white') {
      state.karma = Math.min(MAX_KARMA, state.karma + 1)
      reconcileMode()
      writeLocal()
      writeRemote()
    }
  }

  const onDeath = (killerUid, dropContext) => {
    /** Always clear the purple window — you can't be "actively PvPing" mid-grave. */
    state.purpleExpiresAt = 0
    if (state.karma > 0) {
      state.karma -= 1
      /** Red PKs drop coins + tools. The heavy lifting (item mutation, Firestore write) is
       *  view-side. We only provide the trigger + payload. */
      if (typeof window !== 'undefined' && typeof window.__FUS_ON_PK_DEATH_DROPS__ === 'function') {
        try {
          window.__FUS_ON_PK_DEATH_DROPS__({
            worldId,
            uid,
            killerUid: killerUid || null,
            remainingKarma: state.karma,
            dropContext: dropContext || null,
          })
        } catch (e) {
          console.warn('[fusPvpKarma] drops hook threw', e)
        }
      }
    }
    reconcileMode()
    writeLocal()
    writeRemote()
  }

  /** @type {import('firebase/database').Unsubscribe | null} */
  let unsub = null
  if (rtdb && worldId) {
    /** Single-level onValue across all peers. Cheap (one socket) and gives us full refresh
     *  on any peer's mode change so a late-joining client sees coloured nametags immediately. */
    unsub = onValue(dbRef(rtdb, `worldPlayerPvp/${worldId}`), (snap) => {
      remote.clear()
      const val = snap.val() || {}
      for (const k of Object.keys(val)) {
        const row = val[k]
        if (!row) continue
        remote.set(k, {
          mode: row.mode || 'white',
          karma: Number(row.karma) || 0,
          purpleExpiresAt: Number(row.purpleExpiresAt) || 0,
          lastUpdateAt: Number(row.lastUpdateAt) || 0,
        })
      }
    })
  }

  /**
   * Tick the local karma decay and purple-window expiry. One point decays every
   * {@link KARMA_POINT_MS} — so 4 karma ≈ 4 hours assuming a default of 1 h per point.
   */
  const decayIv = window.setInterval(() => {
    const before = state.karma
    const purpleBefore = state.purpleExpiresAt
    decayKarma(state)
    if (state.purpleExpiresAt < Date.now()) state.purpleExpiresAt = 0
    if (state.karma !== before || state.purpleExpiresAt !== purpleBefore) {
      reconcileMode()
      writeLocal()
      writeRemote()
    }
    /** Also flip out of purple when the window lapses and karma is 0. */
    if (state.mode === 'purple' && state.purpleExpiresAt <= Date.now() && state.karma <= 0) {
      setMode('white')
    }
  }, 1000)

  /** Public reads */
  mc.fusPvpColorFor = (peerUid) => {
    const s = peerUid === uid ? state : remote.get(peerUid)
    return PVP_COLORS[s?.mode || 'white']
  }
  mc.fusPvpIsSafeTarget = (peerUid) => {
    /** Red / purple are fair game; white is not (attacking them flags us). */
    const s = peerUid === uid ? state : remote.get(peerUid)
    return (s?.mode || 'white') !== 'white'
  }
  mc.fusPvp = { onHitPlayer, onKillPlayer, onDeath }

  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    window.clearInterval(decayIv)
    unsub?.()
    /** Leave a "logout" marker so peers can gracefully stop colouring our nametag if we
     *  don't rejoin within a few minutes. We don't actually delete the doc — karma must
     *  persist across sessions. */
    if (rtdb && worldId && uid) {
      dbUpdate(dbRef(rtdb, `worldPlayerPvp/${worldId}/${uid}`), {
        lastUpdateAt: serverTimestamp(),
      }).catch(() => {})
    }
    mc.fusPvp = null
    mc.fusPvpColorFor = null
    mc.fusPvpIsSafeTarget = null
    mc.fusPvpStateByUid = null
    mc.fusPvpSelfState = null
  }
  mc.fusDisposePvpKarma = dispose
  return dispose
}

/** Mode → hex colour used by nametags / debug overlays. Kept out of the CSS because name
 *  tags are drawn by the engine's 3D canvas, not DOM. */
const PVP_COLORS = {
  white: 0xffffff,
  purple: 0xb366ff,
  red: 0xff4d4d,
}

/** 60 seconds since the last player-hit before purple decays to white (if karma is 0). */
const PURPLE_WINDOW_MS = 60_000
/** 1 hour per karma point. Killing 4 innocents sets karma=4 ≈ 4 hours red. */
const KARMA_POINT_MS = 60 * 60 * 1000
const MAX_KARMA = 50

function defaultState() {
  return { mode: 'white', karma: 0, purpleExpiresAt: 0, lastUpdateAt: Date.now() }
}

function loadLocalState(key) {
  if (typeof localStorage === 'undefined') return defaultState()
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return defaultState()
    const o = JSON.parse(raw)
    if (!o || typeof o !== 'object') return defaultState()
    const mode = ['white', 'purple', 'red'].includes(o.mode) ? o.mode : 'white'
    return {
      mode,
      karma: Math.max(0, Math.min(MAX_KARMA, Number(o.karma) || 0)),
      purpleExpiresAt: Number(o.purpleExpiresAt) || 0,
      lastUpdateAt: Number(o.lastUpdateAt) || 0,
    }
  } catch {
    return defaultState()
  }
}

/**
 * Offline-aware decay: compute the integer count of full {@link KARMA_POINT_MS} windows
 * that have elapsed since {@code state.lastUpdateAt} and subtract that many karma.
 * Storing decay against a monotonic wall-clock means a dropped player can't skip
 * sanctioning by leaving the tab open for 0.9 hours at a time.
 */
function decayKarma(state) {
  if (state.karma <= 0) {
    state.lastUpdateAt = Date.now()
    return
  }
  const now = Date.now()
  const elapsed = now - (state.lastUpdateAt || now)
  if (elapsed <= 0) return
  const decayed = Math.floor(elapsed / KARMA_POINT_MS)
  if (decayed <= 0) return
  state.karma = Math.max(0, state.karma - decayed)
  state.lastUpdateAt = now - (elapsed % KARMA_POINT_MS)
}
