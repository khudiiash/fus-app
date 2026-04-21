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
 * RTDB-backed streaming of world edits.
 *
 * Design goals (from user request):
 *   • Any block edit (place, break) is persisted.
 *   • Edits near the local player stream in with minimum latency + low CPU cost.
 *   • We never re-apply our own writes.
 *
 * Architecture:
 *   • Storage key: `worldBlockEdits/{worldId}/cells/{cellKey}/{cellCoord}`.
 *     - `cellKey` = `cx_cz`, where `cx = x >> 4`, `cz = z >> 4`. 16×16 column.
 *     - `cellCoord` = `lx_y_lz` with local x/z (0-15) and *absolute* y.
 *     - Each leaf: `{ id, at, by }` where `id` is blockTypeId (0 = air), `at` is a
 *       `serverTimestamp()`, `by` is the writer's uid (so the writer can ignore its own
 *       echoes without needing a local shadow set).
 *   • Write side: monkey-patch `mc.world.setBlockAt`. We fire-and-forget the RTDB write;
 *     on failure we log but do NOT roll back the local block — offline drifts heal on
 *     next sync.
 *   • Read side: pick the 3×3 block of cells centred on the player and subscribe via
 *     `onChildAdded` + `onChildChanged`. Re-evaluate on chunk crossings (cheap: one
 *     integer compare per frame). When the player moves, old cells outside the window
 *     are detached to avoid unbounded listener counts.
 *   • Boot prime: `get(...)` the current snapshot of each window cell so edits made
 *     before anyone subscribed still appear.
 *
 * Scope decisions (explicit):
 *   • We do NOT treat a `setBlockAt` triggered *by the RTDB callback itself* as a new
 *     edit — a re-entry flag guards the patch so we don't loop.
 *   • We ignore edits we wrote ourselves (`by === uid`).
 *   • We skip applying an incoming edit if the local block already matches (common when
 *     the peer edit arrives before our own write echo clears).
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

  /** Debounce writes per-cell so a fast builder spamming 10 blocks/sec still issues one
   *  `update(...)` per cell per frame window, not 10 round-trips. */
  /** @type {Map<string, Record<string, { id: number, at: any, by: string }>>} */
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

  /** @type {Map<string, { ref: any, addedCb: any, changedCb: any }>} */
  const subs = new Map()
  let disposed = false

  const applyLeaf = (cellKey, leafKey, row) => {
    if (!row || typeof row !== 'object') return
    /** Ignore our own echoes. */
    if (row.by === uid) return
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
    /** Skip no-op applies — common during boot prime when local and remote agree. */
    try {
      const existing = mc.world.getBlockAt(x, y, z)
      if (existing === id) return
    } catch {
      /* chunk not loaded yet — skip and rely on generator output (chunk loader will call
       *  the RTDB applier path again later via a pending-edits queue we could add, but
       *  currently we trust chunk load order to keep up). */
      return
    }
    reentry = true
    try {
      mc.world.setBlockAt(x, y, z, id)
      mc.worldRenderer.flushRebuild = true
    } catch (e) {
      console.warn('[fusWorldEditsRtdb] apply failed', cellKey, leafKey, e)
    } finally {
      reentry = false
    }
  }

  const subscribeCell = (cellKey) => {
    if (subs.has(cellKey)) return
    const r = dbRef(rtdb, `worldBlockEdits/${worldId}/cells/${cellKey}`)
    /** Prime with a single `get` so edits made before we subscribed are applied. */
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
   */
  const SUB_RADIUS = 1 /** 1 → 3×3 = 9 cells around the player. */
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

  let rafId = 0
  const frame = () => {
    if (disposed) return
    rafId = requestAnimationFrame(frame)
    reconcileWindow()
  }
  rafId = requestAnimationFrame(frame)

  const dispose = () => {
    if (disposed) return
    disposed = true
    if (rafId) cancelAnimationFrame(rafId)
    if (writeFlushRaf) cancelAnimationFrame(writeFlushRaf)
    flushWrites()
    for (const k of [...subs.keys()]) unsubscribeCell(k)
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
