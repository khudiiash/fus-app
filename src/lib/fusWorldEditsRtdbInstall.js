import {
  get,
  off,
  onChildAdded,
  onChildChanged,
  ref as dbRef,
  serverTimestamp,
  set as dbSet,
  update as dbUpdate,
} from 'firebase/database'

/**
 * RTDB-backed streaming of world edits with cross-session persistence.
 *
 * Design goals (from user request):
 *   • Any block edit (place, break) is persisted.
 *   • Edits are fetched and applied fast (subscribed to a moving window around the player,
 *     primed via a single `get` per cell the first time it enters the window, debounced
 *     batched writes so a fast builder doesn't round-trip 10 times/s).
 *   • Cost-proportional to activity — no polling, no per-frame RTDB calls.
 *   • **Respawns/reloads see their own historical edits.** The previous revision silently
 *     dropped incoming rows whose `by === uid`, under the assumption they were same-session
 *     echoes. That was correct mid-session but broke persistence across refreshes: a
 *     reloaded client has the *same* uid, so its own edits looked like echoes and were
 *     skipped, causing the world to revert on every rejoin. We now suppress same-session
 *     echoes via the `existing === id` local-state check (which is a free no-op when the
 *     server confirms what we just wrote) and leave cross-session edits alone.
 *
 * Storage layout:
 *   `worldBlockEdits/{worldId}/cells/{cellKey}/{cellCoord}`
 *     - `cellKey` = `cx_cz`, where `cx = x >> 4`, `cz = z >> 4`. 16×16 column.
 *     - `cellCoord` = `lx_y_lz` with local x/z (0-15) and *absolute* y.
 *     - Each leaf: `{ id, at, by }` where `id` is blockTypeId (0 = air), `at` is a
 *       `serverTimestamp()`, `by` is the writer's uid (kept for future admin tooling —
 *       "who broke this?" — but no longer used for echo suppression).
 *
 * Apply pipeline:
 *   • Same-frame apply if the target chunk is already loaded.
 *   • Deferred-apply queue otherwise. Each miss is pushed into
 *     {@link pendingApplies}; the RAF loop (which we already run for the subscribe-window
 *     reconcile) drains it in small batches, checking whether the chunk is now available.
 *     This is the failure mode that previously lost edits silently: the client
 *     subscribes → prime returns edits for chunks that haven't finished generating →
 *     `getBlockAt` throws → edit is discarded. Now it's just parked and retried.
 *   • Applies use a reentry guard so the patched `setBlockAt` below doesn't try to
 *     re-write what we just pulled from the server.
 *
 * @param {any} mc
 * @param {{ worldId: string, uid: string, rtdb: any }} opts
 * @returns {() => void}
 */
export function installFusWorldEditsRtdb(mc, { worldId, uid, rtdb }) {
  if (!mc || !mc.world || !rtdb || !worldId || !uid) {
    return () => {}
  }

  /** `true` while applying an incoming edit — suppresses the outgoing-write path. */
  let reentry = false
  const origSetBlockAt = mc.world.setBlockAt.bind(mc.world)
  mc.world.setBlockAt = function fusPatchedSetBlockAt(x, y, z, type) {
    origSetBlockAt(x, y, z, type)
    if (reentry) return
    queueWrite(x, y, z, type)
  }

  /**
   * Debounce writes per-cell so a fast builder spamming 10 blocks/sec still issues one
   * `update(...)` per cell per RAF window, not 10 round-trips. The bucket is keyed by
   * cellKey so edits in the same 16×16 column coalesce into a single multi-leaf update.
   * @type {Map<string, Record<string, { id: number, at: any, by: string }>>}
   */
  const writeBuffer = new Map()
  let writeFlushRaf = 0

  const queueWrite = (x, y, z, typeId) => {
    const cellKey = `${x >> 4}_${z >> 4}`
    const leafKey = `${x & 15}_${y}_${z & 15}`
    let bucket = writeBuffer.get(cellKey)
    if (!bucket) {
      bucket = {}
      writeBuffer.set(cellKey, bucket)
    }
    bucket[leafKey] = { id: typeId, at: serverTimestamp(), by: uid }
    if (!writeFlushRaf) {
      writeFlushRaf = requestAnimationFrame(flushWrites)
    }
  }

  const flushWrites = () => {
    writeFlushRaf = 0
    for (const [cellKey, bucket] of writeBuffer.entries()) {
      const path = `worldBlockEdits/${worldId}/cells/${cellKey}`
      dbUpdate(dbRef(rtdb, path), bucket).catch((e) =>
        console.warn('[fusWorldEditsRtdb] write failed', cellKey, e),
      )
    }
    writeBuffer.clear()
  }

  /**
   * Deferred apply queue for edits whose target chunk isn't loaded yet. Keyed by a
   * per-cell string so a later incoming update for the same cell overwrites the stale
   * one instead of double-applying.
   * @type {Map<string, { x: number, y: number, z: number, id: number, enqueuedAt: number }>}
   */
  const pendingApplies = new Map()
  /** Soft cap — if the server dumps tens of thousands of edits into a tiny client view,
   *  we don't want the retry map to grow without bound. Oldest entries get evicted. */
  const PENDING_MAX = 50000

  /** @type {Map<string, { ref: any, addedCb: any, changedCb: any }>} */
  const subs = new Map()
  let disposed = false

  /** Actually push an `(x,y,z,id)` tuple through the engine. Returns true on success,
   *  false if the chunk wasn't ready (caller parks it in {@link pendingApplies}). */
  const tryApply = (x, y, z, id) => {
    try {
      const existing = mc.world.getBlockAt(x, y, z)
      /** Same-session echo suppression — if the local state already matches the server,
       *  there's nothing to do (and calling setBlockAt would still be correct but pay the
       *  chunk-rebuild cost for nothing). */
      if (existing === id) return true
    } catch {
      return false /** chunk not loaded */
    }
    reentry = true
    try {
      mc.world.setBlockAt(x, y, z, id)
      mc.worldRenderer.flushRebuild = true
      return true
    } catch (e) {
      console.warn('[fusWorldEditsRtdb] apply failed', x, y, z, id, e)
      return false
    } finally {
      reentry = false
    }
  }

  const applyLeaf = (cellKey, leafKey, row) => {
    if (!row || typeof row !== 'object') return
    const id = Number(row.id)
    if (!Number.isFinite(id) || id < 0) return
    const [lxStr, yStr, lzStr] = leafKey.split('_')
    const [cxStr, czStr] = cellKey.split('_')
    const cx = Number(cxStr)
    const cz = Number(czStr)
    const lx = Number(lxStr)
    const lz = Number(lzStr)
    const y = Number(yStr)
    if (![cx, cz, lx, lz, y].every(Number.isFinite)) return
    const x = (cx << 4) | lx
    const z = (cz << 4) | lz
    if (tryApply(x, y, z, id)) return
    /** Chunk not ready — park. Key by absolute coords so a later echo for the same cell
     *  coalesces instead of stacking. */
    const pkey = `${x}|${y}|${z}`
    pendingApplies.set(pkey, { x, y, z, id, enqueuedAt: performance.now() })
    /** Evict oldest entries if we somehow got spammed into unboundedness. Map iterates
     *  in insertion order so the first key is the oldest. */
    while (pendingApplies.size > PENDING_MAX) {
      const firstKey = pendingApplies.keys().next().value
      if (firstKey == null) break
      pendingApplies.delete(firstKey)
    }
  }

  const subscribeCell = (cellKey) => {
    if (subs.has(cellKey)) return
    const r = dbRef(rtdb, `worldBlockEdits/${worldId}/cells/${cellKey}`)
    /**
     * Prime with a single `get` so edits made before we subscribed are applied. This is
     * critical on boot: the user just loaded the world, chunks are generating, we
     * subscribe, and need the server to tell us what's changed from the deterministic
     * seed's output. `onChildAdded` on its own would NOT fire for pre-existing rows
     * because Firebase's "added" event reflects an in-memory subscription event, not a
     * DB listing, so a fresh client otherwise wouldn't see historical edits.
     */
    get(r)
      .then((snap) => {
        const v = snap.val() || {}
        for (const leafKey of Object.keys(v)) applyLeaf(cellKey, leafKey, v[leafKey])
      })
      .catch((e) => console.warn('[fusWorldEditsRtdb] prime failed', cellKey, e))
    const addedCb = onChildAdded(r, (snap) => applyLeaf(cellKey, snap.key, snap.val()))
    const changedCb = onChildChanged(r, (snap) => applyLeaf(cellKey, snap.key, snap.val()))
    subs.set(cellKey, { ref: r, addedCb, changedCb })
  }

  const unsubscribeCell = (cellKey) => {
    const s = subs.get(cellKey)
    if (!s) return
    try {
      off(s.ref)
    } catch {
      /* ignore */
    }
    subs.delete(cellKey)
  }

  /**
   * Reconcile listeners against the `SUB_RADIUS` square centred on the player's current
   * chunk. Cheap to call every frame — the set operations all early-out when the target
   * window matches the live one.
   *
   * RADIUS of 2 gives a 5×5 = 25-cell window. That's enough for chunks at the horizon
   * (default view distance 3–4 in this build) to already have their edits primed by the
   * time they become visible. Smaller radii cause "edits pop in as you approach" which
   * users read as bugs.
   */
  const SUB_RADIUS = 2
  let lastCx = Number.NaN
  let lastCz = Number.NaN
  const reconcileWindow = () => {
    const pl = mc.player
    if (!pl) return
    const cx = Math.floor(pl.x) >> 4
    const cz = Math.floor(pl.z) >> 4
    if (cx === lastCx && cz === lastCz) return
    lastCx = cx
    lastCz = cz
    const want = new Set()
    for (let dx = -SUB_RADIUS; dx <= SUB_RADIUS; dx++) {
      for (let dz = -SUB_RADIUS; dz <= SUB_RADIUS; dz++) {
        want.add(`${cx + dx}_${cz + dz}`)
      }
    }
    for (const k of want) subscribeCell(k)
    for (const k of [...subs.keys()]) {
      if (!want.has(k)) unsubscribeCell(k)
    }
  }

  /**
   * Drain a slice of the pending-applies map each rAF. Desktop was 48; touch clients were
   * hammering the main thread (48× setBlock + light + mesh marks per frame) while
   * exploring — a major "smooth standing / choppy when moving" gap next to chunk mesh
   * work. Override: {@code mc.fusWorldEditsDrainPerFrame} (1..96).
   */
  const drainPerFrame = () => {
    if (typeof mc.fusWorldEditsDrainPerFrame === 'number' && Number.isFinite(mc.fusWorldEditsDrainPerFrame)) {
      return Math.max(1, Math.min(96, Math.floor(mc.fusWorldEditsDrainPerFrame)))
    }
    return mc.fusLowTierMobile || mc.fusIosSafari ? 12 : 48
  }
  const drainPending = () => {
    if (pendingApplies.size === 0) return
    const cap = drainPerFrame()
    let drained = 0
    for (const [pkey, entry] of pendingApplies) {
      if (drained >= cap) break
      if (tryApply(entry.x, entry.y, entry.z, entry.id)) {
        pendingApplies.delete(pkey)
        drained++
      }
      /** If it's still not loadable we just skip — next frame will retry. We don't
       *  advance `drained` on failure because failure is ~free (the catch branch in
       *  `tryApply` is a single try/catch hit with no work), so we can scan more
       *  entries per frame. */
    }
  }

  let rafId = 0
  const frame = () => {
    if (disposed) return
    rafId = requestAnimationFrame(frame)
    reconcileWindow()
    drainPending()
  }
  rafId = requestAnimationFrame(frame)

  const dispose = () => {
    if (disposed) return
    disposed = true
    if (rafId) cancelAnimationFrame(rafId)
    if (writeFlushRaf) cancelAnimationFrame(writeFlushRaf)
    flushWrites()
    for (const k of [...subs.keys()]) unsubscribeCell(k)
    pendingApplies.clear()
    mc.world.setBlockAt = origSetBlockAt
  }
  mc.fusDisposeWorldEditsRtdb = dispose
  return dispose
}

/**
 * One-shot helper: write a single edit directly (bypassing the local `setBlockAt` hook).
 * Useful for admin tools / world seeding. Uses the same schema as the runtime writer.
 *
 * @param {{ rtdb: any, worldId: string, uid: string, x: number, y: number, z: number, id: number }} opts
 */
export function fusWriteSingleBlockEdit({ rtdb, worldId, uid, x, y, z, id }) {
  if (!rtdb || !worldId || !uid) return Promise.resolve()
  const cellKey = `${x >> 4}_${z >> 4}`
  const leafKey = `${x & 15}_${y}_${z & 15}`
  return dbSet(dbRef(rtdb, `worldBlockEdits/${worldId}/cells/${cellKey}/${leafKey}`), {
    id,
    at: serverTimestamp(),
    by: uid,
  })
}
