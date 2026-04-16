import Long from '@labymc/libraries/long.js'
import {
  cancelScheduledFlushSharedWorldBlocksList,
  cancelScheduledRtdbCellPatches,
  fingerprintBlocksList,
  mergeCustomBlockLists,
  normalizeSharedWorldSeeds,
  scheduleFlushSharedWorldBlocksList,
  scheduleRtdbCellPatches,
  subscribeRtdbWorldBlockCells,
  subscribeSharedWorldCustomBlocks,
  type LabySpawnPose,
  type RtdbWorldCellDelta,
  type SerializedBlock,
  type SharedWorldSeeds,
} from '@/game/sharedWorldFirestore'
import { rtdb } from '@/firebase/config'
import { fusBlockTypeToLabyTypeId, labyTypeIdToFusBlockType } from '@/game/labyminecraft/labyBlockMapping'
import { blockWorldAggressiveMobile } from '@/game/minebase/utils'

/** Hard cap for FUS Laby terrain loader (chunk ring + shared blocks + mesh settle). Work may continue after. */
export const LABY_WORLD_BOOT_MAX_MS = 5000

function cellKey(b: Pick<SerializedBlock, 'x' | 'y' | 'z'>): string {
  return `${Math.round(b.x)},${Math.round(b.y)},${Math.round(b.z)}`
}

function serializedBlockSig(b: SerializedBlock): string {
  return `${b.type}:${b.placed ? 1 : 0}`
}

/** Deterministic Laby world seed from persisted FUS five-float seeds. */
export function sharedWorldSeedsToLabyLong(seeds: SharedWorldSeeds) {
  const n = normalizeSharedWorldSeeds(seeds)
  // Fixed key order so Firestore-deserialized objects never change the Long vs identical numbers.
  const str = JSON.stringify({
    coal: n.coal,
    leaf: n.leaf,
    noise: n.noise,
    stone: n.stone,
    tree: n.tree,
  })
  let low = 0
  let hi = 0
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i)
    low = (Math.imul(31, low) + c) | 0
    hi = (Math.imul(17, hi) ^ Math.imul(c, 131)) | 0
  }
  return Long.fromBits(low >>> 0, hi >>> 0, false)
}

export type CreateLabyWorldOptions = {
  /** Firestore `labySpawn`; when `y` is finite, copies exact feet position before `loadWorld`. */
  labySpawn?: LabySpawnPose | null
}

export async function createAndLoadLabyWorldFromSeeds(
  mc: unknown,
  seeds: SharedWorldSeeds,
  options?: CreateLabyWorldOptions,
): Promise<void> {
  const { default: World } = await import('@labymc/src/js/net/minecraft/client/world/World.js')
  const { default: ChunkProviderGenerate } = await import(
    '@labymc/src/js/net/minecraft/client/world/provider/ChunkProviderGenerate.js',
  )
  const { default: PlayerController } = await import(
    '@labymc/src/js/net/minecraft/client/network/controller/PlayerController.js',
  )
  const m = mc as {
    loadWorld: (w: unknown) => void
    playerController: unknown
  }
  const seedLong = sharedWorldSeedsToLabyLong(seeds)
  const world = new World(m) as {
    spawn: { x: number; y: number; z: number }
    setChunkProvider: (p: unknown) => void
    getChunkProvider: () => { findSpawn: () => void }
    setSpawn: (x: number, z: number) => void
  }
  world.setChunkProvider(new ChunkProviderGenerate(world, seedLong))
  const ls = options?.labySpawn
  if (ls && Number.isFinite(ls.x) && Number.isFinite(ls.z)) {
    if (Number.isFinite(ls.y)) {
      world.spawn.x = ls.x
      world.spawn.y = ls.y
      world.spawn.z = ls.z
    } else {
      world.setSpawn(ls.x, ls.z)
    }
  } else {
    world.getChunkProvider().findSpawn()
  }
  m.playerController = new PlayerController(m)
  m.loadWorld(world)
}

/**
 * Resolves when the client is in-world and spawn terrain is usable.
 * Vanilla uses {@link GuiLoadingScreen}; FUS embed skips that UI and must replicate its chunk ring + progress gate here.
 * When `options.deadlineMs` is set, resolves once that time is reached so total bootstrap can stay within `LABY_WORLD_BOOT_MAX_MS`.
 */
export function waitUntilLabyPlaying(mc: unknown, options?: { deadlineMs?: number }): Promise<void> {
  const game = mc as {
    isInGame: () => boolean
    loadingScreen: unknown
    world: {
      getChunkProvider: () => { getChunks: () => { size: number } }
      getChunkAt: (cx: number, cz: number) => unknown
      lightUpdateQueue: { length: number }
    }
    player: { x: number; z: number }
    settings: { viewDistance: number }
    isSingleplayer: () => boolean
  }
  const fusEmbed =
    typeof window !== 'undefined' &&
    (window as unknown as { __LABY_MC_FUS_EMBED__?: boolean }).__LABY_MC_FUS_EMBED__

  return new Promise((resolve) => {
    /** Spread terrain gen across frames — a full ring of sync {@link getChunkAt} calls was freezing the tab for many seconds. Higher batch only while this waiter runs (before gameplay). */
    let ringCursor = 0
    const chunkBatch = blockWorldAggressiveMobile() ? 8 : 16

    function tick() {
      if (
        fusEmbed &&
        options?.deadlineMs != null &&
        performance.now() >= options.deadlineMs
      ) {
        resolve()
        return
      }
      if (!game.isInGame() || game.world == null) {
        requestAnimationFrame(tick)
        return
      }
      if (game.loadingScreen != null) {
        requestAnimationFrame(tick)
        return
      }
      if (fusEmbed) {
        const renderDistance = game.settings.viewDistance
        const cameraChunkX = Math.floor(game.player.x) >> 4
        const cameraChunkZ = Math.floor(game.player.z) >> 4
        const ring: [number, number][] = []
        for (let x = -renderDistance + 1; x < renderDistance; x++) {
          for (let z = -renderDistance + 1; z < renderDistance; z++) {
            ring.push([x, z])
          }
        }
        if (ring.length) {
          for (let b = 0; b < chunkBatch; b++) {
            const [ox, oz] = ring[ringCursor % ring.length]!
            game.world.getChunkAt(cameraChunkX + ox, cameraChunkZ + oz)
            ringCursor++
          }
        }
        const requiredChunks = game.isSingleplayer() ? Math.pow(renderDistance * 2 - 1, 2) : 1
        const loadedChunks = game.world.getChunkProvider().getChunks().size
        const progress =
          (1 / requiredChunks) *
          Math.max(0, loadedChunks - game.world.lightUpdateQueue.length / 1000)
        if (progress < 0.99) {
          requestAnimationFrame(tick)
          return
        }
      }
      resolve()
    }
    tick()
  })
}

export type FusLabySharedBridge = {
  dispose: () => void
  /** First merged Firestore/RTDB list has finished applying to the world (including chunked rAF upserts). */
  initialApplyComplete: Promise<void>
}

/**
 * RTDB/Firestore ⇄ Laby world: merges remote lists with local edits (same cell local wins on flush),
 * applies blocks to {@link World}, and wraps {@link World#setBlockAt} to push edits upstream.
 */
export function attachFusLabySharedWorldBridge(
  mc: unknown,
  world: {
    getBlockAt: (x: number, y: number, z: number) => number
    setBlockAt: (x: number, y: number, z: number, typeId: number) => void
  },
  worldId: string,
  initialBlocks: SerializedBlock[],
  initialFingerprint: string,
): FusLabySharedBridge {
  const useIncrementalRtdb = !!rtdb
  const workingByCell = new Map<string, SerializedBlock>()
  for (const b of initialBlocks) {
    workingByCell.set(cellKey(b), { ...b })
  }

  let applyingRemote = false
  const prevMergedByKey = new Map<string, SerializedBlock>()
  const origSetBlockAt = world.setBlockAt.bind(world)
  const blocksPerSyncFrame = blockWorldAggressiveMobile() ? 40 : 80
  const dirtyCellKeys = new Set<string>()
  const echoUntilByKey = new Map<string, number>()
  const echoedSigByKey = new Map<string, string>()

  let resolveInitialApply: (() => void) | undefined
  const initialApplyComplete = new Promise<void>((resolve) => {
    resolveInitialApply = resolve
  })
  function settleInitialApply() {
    if (!resolveInitialApply) return
    resolveInitialApply()
    resolveInitialApply = undefined
  }

  function markEchoAfterPush(keys: string[], cells: Map<string, SerializedBlock | undefined>) {
    const until = Date.now() + 140
    for (const k of keys) {
      echoUntilByKey.set(k, until)
      const b = cells.get(k)
      echoedSigByKey.set(k, b ? serializedBlockSig(b) : '__del__')
    }
  }

  function shouldIgnoreEcho(key: string, block: SerializedBlock | null, isRemove: boolean): boolean {
    const until = echoUntilByKey.get(key)
    if (!until || Date.now() > until) return false
    const sig = isRemove ? '__del__' : serializedBlockSig(block!)
    return sig === echoedSigByKey.get(key)
  }

  function applyRemovalsForNewMap(newMap: Map<string, SerializedBlock>) {
    applyingRemote = true
    try {
      for (const k of [...prevMergedByKey.keys()]) {
        if (!newMap.has(k)) {
          const [xs, ys, zs] = k.split(',').map(Number)
          origSetBlockAt(xs, ys, zs, 0)
          prevMergedByKey.delete(k)
        }
      }
    } finally {
      applyingRemote = false
    }
  }

  function syncWorldToBlockList(
    list: SerializedBlock[],
    applyToken: number,
    onDone?: () => void,
    opts?: { burst?: boolean },
  ) {
    const newMap = new Map<string, SerializedBlock>()
    for (const b of list) {
      newMap.set(cellKey(b), b)
    }
    applyRemovalsForNewMap(newMap)
    const upserts: Array<[string, SerializedBlock]> = []
    for (const entry of newMap) {
      const [k, b] = entry
      const prev = prevMergedByKey.get(k)
      if (prev && serializedBlockSig(prev) === serializedBlockSig(b)) {
        continue
      }
      upserts.push([k, b])
    }
    let upsertIdx = 0
    const burstFrame =
      opts?.burst === true ? (blockWorldAggressiveMobile() ? 360 : 640) : blocksPerSyncFrame
    const finish = () => {
      if (applyToken === activeApplyToken && onDone) {
        queueMicrotask(onDone)
      }
      if (applyToken === activeApplyToken) {
        settleInitialApply()
      }
    }
    const applyUpsertChunk = () => {
      if (applyToken !== activeApplyToken) return
      applyingRemote = true
      try {
        const end = Math.min(upsertIdx + burstFrame, upserts.length)
        for (let i = upsertIdx; i < end; i++) {
          const [, b] = upserts[i]!
          const x = Math.round(b.x)
          const y = Math.round(b.y)
          const z = Math.round(b.z)
          if (b.placed) {
            origSetBlockAt(x, y, z, fusBlockTypeToLabyTypeId(b.type))
          } else {
            origSetBlockAt(x, y, z, 0)
          }
          prevMergedByKey.set(cellKey(b), { ...b })
        }
        upsertIdx = end
      } finally {
        applyingRemote = false
      }
      if (applyToken !== activeApplyToken) return
      if (upsertIdx < upserts.length) {
        syncRaf = requestAnimationFrame(() => {
          syncRaf = 0
          applyUpsertChunk()
        })
      } else {
        finish()
      }
    }
    if (upserts.length === 0) {
      finish()
      return
    }
    applyUpsertChunk()
  }

  function schedulePush() {
    if (useIncrementalRtdb) {
      scheduleRtdbCellPatches(
        worldId,
        () => {
          if (dirtyCellKeys.size === 0) return null
          const keys = [...dirtyCellKeys]
          dirtyCellKeys.clear()
          const cells = new Map<string, SerializedBlock | undefined>()
          for (const k of keys) {
            cells.set(k, workingByCell.get(k))
          }
          return { keys, cells }
        },
        {
          debounceMs: blockWorldAggressiveMobile() ? 72 : 38,
          onPushed: (batch) => {
            markEchoAfterPush(batch.keys, batch.cells)
          },
        },
      )
      return
    }
    scheduleFlushSharedWorldBlocksList(worldId, () => [...workingByCell.values()], {
      debounceMs: blockWorldAggressiveMobile() ? 280 : 140,
    })
  }

  function touchPrevMergedFromLocal(rx: number, ry: number, rz: number, prevLabyType: number, newLabyType: number) {
    const k = `${rx},${ry},${rz}`
    if (newLabyType === 0 && prevLabyType !== 0) {
      prevMergedByKey.set(k, {
        x: rx,
        y: ry,
        z: rz,
        type: labyTypeIdToFusBlockType(prevLabyType),
        placed: false,
      })
    } else if (newLabyType !== 0) {
      prevMergedByKey.set(k, {
        x: rx,
        y: ry,
        z: rz,
        type: labyTypeIdToFusBlockType(newLabyType),
        placed: true,
      })
    } else {
      prevMergedByKey.delete(k)
    }
  }

  function recordLocalBlockChange(x: number, y: number, z: number, prevLabyType: number, newLabyType: number) {
    const rx = Math.round(x)
    const ry = Math.round(y)
    const rz = Math.round(z)
    const k = `${rx},${ry},${rz}`
    if (newLabyType === 0 && prevLabyType !== 0) {
      workingByCell.set(k, {
        x: rx,
        y: ry,
        z: rz,
        type: labyTypeIdToFusBlockType(prevLabyType),
        placed: false,
      })
    } else if (newLabyType !== 0) {
      workingByCell.set(k, {
        x: rx,
        y: ry,
        z: rz,
        type: labyTypeIdToFusBlockType(newLabyType),
        placed: true,
      })
    }
    touchPrevMergedFromLocal(rx, ry, rz, prevLabyType, newLabyType)
    if (useIncrementalRtdb) {
      dirtyCellKeys.add(k)
    }
    schedulePush()
  }

  function applyOneCellToMesh(k: string, b: SerializedBlock) {
    const prev = prevMergedByKey.get(k)
    if (prev && serializedBlockSig(prev) === serializedBlockSig(b)) return
    const x = Math.round(b.x)
    const y = Math.round(b.y)
    const z = Math.round(b.z)
    applyingRemote = true
    try {
      if (b.placed) {
        origSetBlockAt(x, y, z, fusBlockTypeToLabyTypeId(b.type))
      } else {
        origSetBlockAt(x, y, z, 0)
      }
      prevMergedByKey.set(k, { ...b })
    } finally {
      applyingRemote = false
    }
  }

  const remoteQueue: RtdbWorldCellDelta[] = []
  let remoteDrainRaf = 0
  const REMOTE_PER_FRAME = 12

  function drainRemoteQueue() {
    remoteDrainRaf = 0
    for (let n = 0; n < REMOTE_PER_FRAME && remoteQueue.length; n++) {
      applyRemoteDelta(remoteQueue.shift()!)
    }
    if (remoteQueue.length) {
      remoteDrainRaf = requestAnimationFrame(drainRemoteQueue)
    }
  }

  function applyRemoteDelta(d: RtdbWorldCellDelta) {
    if (d.kind === 'upsert') {
      if (shouldIgnoreEcho(d.key, d.block, false)) return
      const localAt = workingByCell.get(d.key)
      const merged = mergeCustomBlockLists([d.block], localAt ? [localAt] : [])[0]!
      workingByCell.set(d.key, merged)
      const pm = prevMergedByKey.get(d.key)
      if (pm && serializedBlockSig(pm) === serializedBlockSig(merged)) {
        return
      }
      applyOneCellToMesh(d.key, merged)
      return
    }
    if (shouldIgnoreEcho(d.key, null, true)) return
    const localAt = workingByCell.get(d.key)
    if (localAt) {
      schedulePush()
      return
    }
    workingByCell.delete(d.key)
    const [xs, ys, zs] = d.key.split(',').map(Number)
    applyingRemote = true
    try {
      origSetBlockAt(xs, ys, zs, 0)
    } finally {
      applyingRemote = false
    }
    prevMergedByKey.delete(d.key)
  }

  function enqueueRemote(d: RtdbWorldCellDelta) {
    remoteQueue.push(d)
    if (!remoteDrainRaf) {
      remoteDrainRaf = requestAnimationFrame(drainRemoteQueue)
    }
  }

  world.setBlockAt = (x: number, y: number, z: number, typeId: number) => {
    if (applyingRemote) {
      origSetBlockAt(x, y, z, typeId)
      return
    }
    const prev = world.getBlockAt(x, y, z)
    origSetBlockAt(x, y, z, typeId)
    if (prev === typeId) return
    recordLocalBlockChange(x, y, z, prev, typeId)
  }

  let syncRaf = 0
  let activeApplyToken = 0
  const scheduleSyncFromWorking = () => {
    activeApplyToken++
    const token = activeApplyToken
    if (syncRaf) cancelAnimationFrame(syncRaf)
    syncRaf = requestAnimationFrame(() => {
      syncRaf = 0
      if (token !== activeApplyToken) return
      syncWorldToBlockList([...workingByCell.values()], token)
    })
  }

  let unsubList: () => void = () => {}
  let unsubCells: (() => void) | null = null

  if (useIncrementalRtdb) {
    const initTok = ++activeApplyToken
    syncWorldToBlockList(
      initialBlocks,
      initTok,
      () => {
        unsubCells = subscribeRtdbWorldBlockCells(worldId, enqueueRemote)
      },
      { burst: true },
    )
  } else {
    unsubList = subscribeSharedWorldCustomBlocks(
      worldId,
      (remote) => {
        const localList = [...workingByCell.values()]
        const merged = mergeCustomBlockLists(remote, localList)
        const fpMerged = fingerprintBlocksList(merged)
        const fpApplied = fingerprintBlocksList([...prevMergedByKey.values()])
        workingByCell.clear()
        for (const b of merged) {
          workingByCell.set(cellKey(b), { ...b })
        }
        if (fpMerged !== fpApplied) {
          scheduleSyncFromWorking()
        }
      },
      initialFingerprint,
    )
    scheduleSyncFromWorking()
  }

  return {
    initialApplyComplete,
    dispose: () => {
      activeApplyToken++
      settleInitialApply()
      if (syncRaf) cancelAnimationFrame(syncRaf)
      syncRaf = 0
      if (remoteDrainRaf) cancelAnimationFrame(remoteDrainRaf)
      remoteDrainRaf = 0
      remoteQueue.length = 0
      unsubList()
      try {
        unsubCells?.()
      } catch {
        /* ignore */
      }
      unsubCells = null
      cancelScheduledFlushSharedWorldBlocksList()
      cancelScheduledRtdbCellPatches()
      world.setBlockAt = origSetBlockAt
    },
  }
}

/**
 * After {@link waitUntilLabyPlaying}, wait until the view-distance chunk ring is nearly full and the mesh rebuild queue stays drained for several frames (or timeout). Avoids hiding the loader on a brief empty-queue dip while work is still queued.
 */
export function waitUntilLabyWorldStable(mc: unknown, options?: { maxMs?: number }): Promise<void> {
  const maxMs = Math.max(0, options?.maxMs ?? LABY_WORLD_BOOT_MAX_MS)
  const game = mc as {
    worldRenderer?: { chunkSectionUpdateQueue?: { length: number } }
    world?: {
      getChunkProvider?: () => { getChunks?: () => { size: number } }
    }
    settings?: { viewDistance: number }
    isSingleplayer?: () => boolean
  }

  function requiredChunkCount(): number {
    const rd = game.settings?.viewDistance ?? 2
    if (game.isSingleplayer?.() === false) return 1
    const span = 2 * rd - 1
    return span * span
  }

  function loadedChunkCount(): number {
    return game.world?.getChunkProvider?.()?.getChunks?.()?.size ?? 0
  }

  return new Promise((resolve) => {
    if (maxMs <= 0) {
      resolve()
      return
    }
    const t0 = performance.now()
    let okFrames = 0
    const needStable = 4
    function tick() {
      const q = game.worldRenderer?.chunkSectionUpdateQueue?.length ?? 0
      const loaded = loadedChunkCount()
      const required = requiredChunkCount()
      const chunksOk = loaded >= required * 0.985
      const queueOk = q === 0
      if (queueOk && chunksOk) okFrames++
      else okFrames = 0
      if (okFrames >= needStable || performance.now() - t0 > maxMs) {
        resolve()
        return
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}
