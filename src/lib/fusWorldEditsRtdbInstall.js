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

export function installFusWorldEditsRtdb(mc, { worldId, uid, rtdb }) {
  if (!mc || !mc.world || !rtdb || !worldId || !uid) {
    return () => {}
  }

  let reentry = false
  const origSetBlockAt = mc.world.setBlockAt.bind(mc.world)
  mc.world.setBlockAt = function fusPatchedSetBlockAt(x, y, z, type) {
    origSetBlockAt(x, y, z, type)
    if (reentry) return
    if (mc.fusSuppressWorldEditWrite) return
    if ((mc.fusPopulationDepth | 0) > 0) return
    if (mc.fusFrozen === true) return
    queueWrite(x, y, z, type)
  }

  const writeBuffer = new Map()
  let writeFlushId = null
  let writeFlushUsesTimeout = false
  const immediateWriteFlush = mc.fusInstantBlockActions !== false

  const queueWrite = (x, y, z, typeId) => {
    const cellKey = `${x >> 4}_${z >> 4}`
    const leafKey = `${x & 15}_${y}_${z & 15}`
    let bucket = writeBuffer.get(cellKey)
    if (!bucket) {
      bucket = {}
      writeBuffer.set(cellKey, bucket)
    }
    bucket[leafKey] = { id: typeId, at: serverTimestamp(), by: uid }
    if (writeFlushId == null) {
      if (immediateWriteFlush) {
        writeFlushUsesTimeout = true
        writeFlushId = window.setTimeout(flushWrites, 0)
      } else {
        writeFlushUsesTimeout = false
        writeFlushId = requestAnimationFrame(flushWrites)
      }
    }
  }

  const flushWrites = () => {
    writeFlushId = null
    writeFlushUsesTimeout = false
    for (const [cellKey, bucket] of writeBuffer.entries()) {
      const path = `worldBlockEdits/${worldId}/cells/${cellKey}`
      dbUpdate(dbRef(rtdb, path), bucket).catch((e) =>
        console.warn('[fusWorldEditsRtdb] write failed', cellKey, e),
      )
    }
    writeBuffer.clear()
  }

  const pendingApplies = new Map()
  const PENDING_MAX = 50000

  const subs = new Map()

  const subscribeDeferredQueue = []
  let disposed
 = false

  const tryApply = (x, y, z, id) => {
    try {
      const existing = mc.world.getBlockAt(x, y, z)
      if (existing === id) return true
    } catch {
      return false
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
  /** Wider than 2 so terrain that finishes loading after the first subscribe pass still
   *  receives historical cell state before the player walks into it ("trees came back"). */
  const SUB_RADIUS = 4
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

  /**
   * Re-fetch every cell we are currently subscribed to and re-apply all leaves. Safe after
   * chunks become loadable: `applyLeaf` no-ops when `existing === id`. Use once post-boot
   * when deterministic terrain was blocking earlier applies.
   */
  const replaySubscribedPrimes = () => {
    for (const [cellKey, s] of subs.entries()) {
      get(s.ref)
        .then((snap) => {
          const v = snap.val() || {}
          for (const leafKey of Object.keys(v)) applyLeaf(cellKey, leafKey, v[leafKey])
        })
        .catch((e) => console.warn('[fusWorldEditsRtdb] replay prime failed', cellKey, e))
    }
  }

  mc.fusRerunWorldEditsReconcileSoon = () => {
    lastCx = Number.NaN
    lastCz = Number.NaN
  }
  mc.fusReplayWorldEditPrimes = replaySubscribedPrimes

  const dispose = () => {
    if (disposed) return
    disposed = true
    if (rafId) cancelAnimationFrame(rafId)
    if (writeFlushId != null) {
      if (writeFlushUsesTimeout) clearTimeout(writeFlushId)
      else cancelAnimationFrame(writeFlushId)
      writeFlushId = null
    }
    flushWrites()
    for (const k of [...subs.keys()]) unsubscribeCell(k)
    pendingApplies.clear()
    mc.world.setBlockAt = origSetBlockAt
    delete mc.fusRerunWorldEditsReconcileSoon
    delete mc.fusReplayWorldEditPrimes
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
