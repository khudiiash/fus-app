import * as THREE from '@labymc/libraries/three.module.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import {
  onChildAdded,
  onChildChanged,
  onChildRemoved,
  off,
  push as dbPush,
  ref as dbRef,
  remove as dbRemove,
  runTransaction,
  set as dbSet,
  update as dbUpdate,
} from 'firebase/database'
import {
  fusMobAggroRadius,
  fusMobAnimClip,
  fusMobDmgHalfForLevel,
  fusMobMaxHpForLevel,
  fusMobTypeById,
  fusMobTypeIdForLabyWorldXZ,
} from '@labymc/src/js/net/minecraft/client/fus/FusMobRegistry.js'
import { fusMobKillXpReward } from '@labymc/src/js/net/minecraft/client/fus/fusMobKillXp.js'
import { fusPveMobDamageToPlayerHp, fusPvePlayerDamageToMobHp } from './fusPveCombatBalance.js'
import {
  fusLabyEntityInTerrainDrawWindow,
  fusLabyIsWithinAnimProcessRangeXz,
  fusLabyIsWithinPlayerInterestXz,
} from './fusLabyEntityTerrainWindow.js'
import { labyDisplayNameForMobDropBwKey } from './fusLabyMobDropLabels.js'

/**
 * Multiplayer-synced, visibility-culled mob system.
 *
 * Two modes:
 *   • Local (no `worldId`/`uid`/`rtdb` passed) — classic solo behavior: this client spawns,
 *     ticks, and kills mobs entirely in-memory. No network traffic, used in dev / single-user.
 *   • Shared (all three provided) — mobs are authoritative records under
 *     `worldMobs/{worldId}/instances/{mobKey}` in Firebase RTDB. Every player sees the same
 *     pool, interpolates other leaders' movements, and can damage any mob.
 *
 * Shared-mode architecture:
 *   • Leader election per-mob, lease-based (see {@code LEADER_LEASE_MS}). A lease is refreshed
 *     every {@code LEADER_REFRESH_MS}; when it expires any nearby peer may claim via a
 *     transactional CAS. Keeps exactly one leader writing AI state while surviving drops.
 *   • The leader is the only client writing this mob's `{x,y,z,ry,state,hp,...}`. Everyone else
 *     treats those writes as observations and interpolates through {@link INTERP_DELAY_MS}.
   *   • Spawning: each client tops up mobs only **near itself** (RTDB push) so candidates use
   *     heightmaps from chunks this engine has actually loaded. A single “master” filling every
   *     player’s bubble failed when the master had not visited remote terrain. A global cap still
   *     limits total live mobs; the smallest-uid peer runs despawn of mobs left with no one near.
 *   • Visibility gate ({@code VIS_RANGE}): mobs too far from us are not rendered and we won't
 *     claim their leadership. Network cost stays flat (we still observe positions, tiny payload)
 *     while local Three.js scene stays lean.
 *   • Materials: every GLB mesh has its material replaced with {@link THREE.MeshBasicMaterial}
 *     wrapping the original diffuse map. The minecraft scene has no lights at runtime, so any
 *     PBR/Lambert material renders almost pure black.
 *   • Interpolation: leaders write ~{@link TICK_HZ} Hz. Observers buffer the last N samples and
 *     sample `Date.now() - INTERP_DELAY_MS` so playback looks smooth even at 6 Hz. Mirrors the
 *     approach used in {@link installFusRemoteAvatars}.
 *
 * Hit routing in shared mode:
 *   • `mc.fusTryRemoteMelee()` (used by {@link Minecraft#onMouseClicked}) picks the closest mob
 *     in the forward cone and pushes a {@code worldMobPlayerHits} row `{mobKey,fromUid,dmgHalf,
 *     clientTs}`. The mob's current leader (only) consumes the push, decrements hp, writes the
 *     new state and deletes the row. Works uniformly regardless of who leads the mob.
 *   • Mob → player damage is evaluated locally on every client against _their own_ player so we
 *     don't need a second RTDB pipeline; state='attack' from the leader is the cue.
 *   • Kill attribution: leader stores `lastHitUid` on the mob state so whoever dealt the killing
 *     blow gets loot even across a lease flip. `onChildRemoved` observers match on this field.
 *
 * @param {any} mc
 * @param {{
 *   count?: number,
 *   spawnRadius?: number,
 *   level?: number,
 *   respawn?: boolean,
 *   worldId?: string | null,
 *   uid?: string | null,
 *   rtdb?: any | null,
 *   displayName?: string | null,
 * }} [opts]
 */
export function installFusSimpleMobs(mc, opts = {}) {
  if (!mc || !mc.worldRenderer?.scene) {
    console.warn('[fusSimpleMobs] missing scene; skip install')
    return () => {}
  }

  const {
    /** Legacy "global mob cap" kept for backwards compat — but only used as a hard ceiling
     *  on the total pool. Actual spawn decisions are now per-player. See {@link MOBS_PER_PLAYER}. */
    count = 8,
    spawnRadius = 28,
    level = 1,
    respawn = true,
    worldId = null,
    uid = null,
    rtdb = null,
  } = opts

  /**
   * Dynamic-spawn parameters (user request, 2026-04):
   *   "mobs must only be spawn on demand when players are active in the area, and be
   *    spawned all around the world based on players activity and location (spawning
   *    around them, despawning when no one around)"
   *
   * Previously the master spawned near *itself* up to {@link count} total, which meant
   * every mob clustered around the master's spawn point. The new budget is per-player:
   * each live player has its own bubble of mobs, and when they wander the master follows
   * them around with fresh spawns. The total is hard-capped so a 10-player lobby can't
   * explode to 100 mobs at once.
   */
  /** Per-player mob budget — user target ≈5+ visible near one chunk; mobile keeps same cap. */
  const MOBS_PER_PLAYER = count <= 4 ? 6 : 8
  /** Bubble radius inside which a mob "belongs" to a player for counting purposes. */
  const BUBBLE_RADIUS = 52
  /** Beyond this horizontal distance from every live player anchor, the master may cull. */
  const DESPAWN_RADIUS = 150
  /** Extra time before cull so chasing mobs don’t RTDB-delete when both sides move fast. */
  const DESPAWN_GRACE_MS = 22000
  /**
   * After the last frame where {@link mobFeetOnResolvedGround} + terrain window passed, keep
   * the mesh visible for this long. Chunk `group.visible`, ground Y, and strict mobile radius
   * can flicker 1–3 frames while a mob walks toward the player; without hold they pop out.
   */
  /**
   * After visibility passes, keep drawing briefly so a 1–2 frame cull flicker does not pop mobs.
   * Touch clients: **0** — the hold was keeping far / bad-ground mobs on screen and cost mixer CPU.
   */
  const MOB_RENDER_VIS_HOLD_MS = 520
  const getMobVisHoldMs = () =>
    mc.fusLowTierMobile || mc.fusIosSafari ? 0 : MOB_RENDER_VIS_HOLD_MS
  /** Global ceiling — scales with install {@code count} so large lobbies stay bounded. */
  const MAX_TOTAL_MOBS = Math.max(48, count * 6)
  /**
   * After a natural kill, re-seed the same mob at the same rough location so the world
   * doesn't go empty. Only the last-hitter schedules (multiplayer) so we don't duplicate spawns.
   */
  const MOB_RESPAWN_AFTER_KILL_MS = 60 * 60 * 1000
  /**
   * After a killing blow, block mob→player melee for a few frames. Covers residual timing and
   * pairs with the ingest rule that never raises {@code mob.hp} from 0 to a positive stale row.
   */
  const PVE_BLOCK_MOB_HIT_AFTER_KILL_MS = 140
  /** @type {Set<ReturnType<typeof setTimeout>>} */
  const killRespawnTimers = new Set()

  const scene = mc.worldRenderer.scene
  const multiplayer = !!(worldId && uid && rtdb)

  /**
   * Distance (blocks) beyond which a mob is hidden locally. Derived from the engine's
   * {@link GameSettings#viewDistance} (chunks) × 16 (block chunk size) so mobs never
   * render past the edge of the world the player can actually see. If we hard-coded a
   * larger radius than chunk-load distance, users see mobs walking in mid-air over
   * un-meshed terrain — reported as "mobs are rendered further than the world is
   * visible". A small margin (-4 blocks) keeps them safely inside the fog boundary.
   *
   * Re-read on every visibility check so changing "Render Distance" in GuiOptions
   * immediately tightens the mob bubble without a boot.
   */
  const getVisRange = () => {
    const vd = Number(mc?.settings?.viewDistance)
    /** ChunkSection.SIZE is 16. Cap 5 to match the Laby render slider — matches fog + chunks. */
    const chunks = Number.isFinite(vd) && vd > 0 ? Math.min(10, Math.max(2, Math.round(vd))) : 5
    return Math.max(32, chunks * 16 - 4)
  }

  /**
   * Same value as {@link WorldRenderer#renderChunks}’s `renderDistance` (chunk-space check is
   * {@code |dx| < renderDistance} for each axis). Mesh culling must not use {@link #getVisRange}’s
   * Euclidean disc — that was tighter than the square of loaded columns and mobs also vanished
   * after {@link #findEjectFromLocalFlag} if the teleport was past the disc but the chunk was fine.
   */
  const getEngineViewDistance = () => {
    const v = Number(mc?.settings?.viewDistance)
    return Number.isFinite(v) && v > 0 ? v : 4
  }

  /** World spawn (hub) — used as the “center” for distance → mob level. */
  const getWorldSpawnXZ = () => {
    const w = mc.world
    if (w && w.spawn) {
      const x = Number(w.spawn.x)
      const z = Number(w.spawn.z)
      if (Number.isFinite(x) && Number.isFinite(z)) return { x, z }
    }
    return { x: 0, z: 0 }
  }
  /** Horizontal blocks per +1 mob level; levels cap at {@link MOB_LEVEL_MAX}. Tighter than 48m
   *  so “far from spawn” (hundreds of blocks, not thousands) can reach high-20s / 30. */
  const MOB_LEVEL_DIST = 15
  const MOB_LEVEL_MAX = 30
  const levelForWorldPos = (wx, wz) => {
    const { x: ox, z: oz } = getWorldSpawnXZ()
    const d = Math.hypot(wx - ox, wz - oz)
    return Math.min(MOB_LEVEL_MAX, 1 + Math.floor(d / MOB_LEVEL_DIST))
  }

  const WARDEN_TYPE_ID = 'gigant_warden_mob'
  const FUS_LABY_MOB_DROP_BW_KEYS = Object.freeze([
    'fus_bw_block_grass',
    'fus_bw_block_dirt',
    'fus_bw_block_sand',
    'fus_bw_block_stone',
    'fus_bw_block_wood',
    'fus_bw_block_leaf',
    'fus_bw_block_coal',
    'fus_bw_block_tree',
    'fus_bw_block_glass',
    'fus_bw_block_quartz',
    'fus_bw_block_diamond',
    'fus_bw_pick',
    'fus_bw_tool_Stone_Pickaxe',
    'fus_bw_tool_Iron_Pickaxe',
    'fus_bw_tool_Wooden_Sword',
    'fus_bw_tool_Stone_Sword',
  ])

  const labyStrHash = (str) => {
    let h = 2166136261
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    return h | 0
  }
  const labyPersonalityFromSeed = (seed) => {
    const h0 = Math.imul(seed, 1103515245) + 12345
    const u0 = (h0 >>> 0) / 0xffffffff
    const h1 = Math.imul(seed ^ 0x9e3779b9, 2246822519)
    const u1 = (h1 >>> 0) / 0xffffffff
    const speedMul = 0.72 + u0 * 0.36
    const hpTaper = 0.55 + (1.12 - Math.min(1.12, speedMul)) * 0.78
    const hpMul = (0.85 + u1 * 0.18) * hpTaper
    return {
      speedMul: Math.max(0.52, Math.min(1.15, speedMul)),
      hpMul: Math.max(0.58, Math.min(1.22, hpMul)),
    }
  }
  const labyTemplateSeed = (x, y, z, typeId, lvl) =>
    (Math.floor(x) * 312541 + Math.floor(z) * 120451 + labyStrHash(String(typeId)) + (lvl | 0) * 100003) | 0
  const statsForLabyMob = (x, y, z, typeId, lvl) => {
    const t = fusMobTypeById(typeId)
    const base = fusMobMaxHpForLevel(lvl, t)
    const { hpMul, speedMul } = labyPersonalityFromSeed(labyTemplateSeed(x, y, z, typeId, lvl))
    return {
      maxHp: Math.max(1, Math.round(base * hpMul)),
      speedMul,
    }
  }
  const typeIdForSpawnPos = (x, z) => fusMobTypeIdForLabyWorldXZ(x, z)

  /**
   * No new spawns in this XZ disc around the *local* player's placed spawn flag. Prevents
   * mobs from standing on the flag and chain-killing on respawn.
   */
  const FLAG_SPAWN_EXCLUSION_R = 28
  const getLocalSpawnFlagPos = () => {
    const f = mc.fusSpawnFlagPos
    if (!f || typeof f !== 'object') return null
    const x = Number(f.x)
    const z = Number(f.z)
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null
    return { x, z }
  }
  const distSqToLocalFlag = (x, z) => {
    const fp = getLocalSpawnFlagPos()
    if (!fp) return Infinity
    const dx = x - fp.x
    const dz = z - fp.z
    return dx * dx + dz * dz
  }
  const findEjectFromLocalFlag = () => {
    const fp = getLocalSpawnFlagPos()
    if (!fp) return null
    const pl = mc.player
    const rd = getEngineViewDistance()
    for (let tries = 0; tries < 20; tries++) {
      const ang = Math.random() * Math.PI * 2
      const r = FLAG_SPAWN_EXCLUSION_R + 4 + Math.random() * 24
      const sx = fp.x + Math.cos(ang) * r
      const sz = fp.z + Math.sin(ang) * r
      if (distSqToLocalFlag(sx, sz) < FLAG_SPAWN_EXCLUSION_R * FLAG_SPAWN_EXCLUSION_R) continue
      if (pl && Number.isFinite(pl.x) && Number.isFinite(pl.z)) {
        const mcx = Math.floor(sx) >> 4
        const mcz = Math.floor(sz) >> 4
        const pcx = Math.floor(pl.x) >> 4
        const pcz = Math.floor(pl.z) >> 4
        if (Math.abs(mcx - pcx) >= rd || Math.abs(mcz - pcz) >= rd) continue
      }
      const y = solidGroundYAt(sx, sz)
      if (y == null) continue
      return { x: sx, y, z: sz }
    }
    return null
  }
  /** Leader write cadence. Six samples per second + interpolation looks continuous. */
  const TICK_HZ = 6
  const TICK_MS = Math.round(1000 / TICK_HZ)
  /** Claim validity. If the leader hasn't touched `leaderUntil` within this window, any peer
   *  may claim. Chosen > 2× refresh so a stutter tab doesn't instantly lose the mob. */
  const LEADER_LEASE_MS = 5000
  const LEADER_REFRESH_MS = 2000
  /** Playback lag so observers always have a sample ahead of render time. */
  const INTERP_DELAY_MS = 180
  /** Spawn-top-up cadence and jitter so if two tabs briefly agree on master they don't both
   *  fire at the same frame. */
  const SPAWN_CHECK_MS = 2400
  /** Mob melee bite range (world units, horizontal). User-reported: "attack distance from
   *  mobs is also very short ... they have to come into our camera clipped to actually
   *  attack". Raised from 1.1 → 2.6 blocks so a mob with its lunge animation reaching the
   *  player's torso can land the hit without overlapping the player's own body box. This
   *  also matches the feel of the new (larger) player attack range so fights aren't
   *  comically one-sided. */
  const MELEE_RANGE = 2.6
  /** Vertical melee cap. A mob on the ground can't reach a player on top of a tower, so any
   *  hit requires the target to be near its own altitude. Matches roughly 2 blocks of reach. */
  const MELEE_Y_MAX = 2.0
  /** Maximum vertical distance at which a mob considers a player worth chasing. Beyond this
   *  (e.g. player on a tall pillar or diving into a chasm) the mob stays idle. */
  const AGGRO_Y_MAX = 4.0
  /** Leash radius. Once a chase starts, the mob gives up when XZ distance exceeds this. Absolute
   *  20 block number overrides per-type aggro floors — the user spec is "escape at 20 m". */
  const AGGRO_DROP_R = 20
  /** Wall-clock time we aim for one full attack clip (end of strike ≈ when damage applies). */
  const TARGET_ATTACK_WALL_SEC = 0.42
  /** Fallback if GLB has no attack clip or zero duration. */
  const ATTACK_WINDUP_FALLBACK_MS = 300
  /** Target body height in world units after auto-fit. Matches roughly a tall player so the mobs
   *  sit in the player's visual reference frame; per-type {@code modelScale} can shrink swarmers
   *  (spider, scarad) or grow tanks (warden) from this anchor. */
  const MOB_HEIGHT_TARGET = 1.9

  /** @type {Map<string, Promise<{ scene: THREE.Group, clips: THREE.AnimationClip[] }>>} */
  const templateCache = new Map()

  /**
   * @typedef {Object} Mob
   * @property {string} id  - Local id; in shared mode this is the RTDB push key.
   * @property {string} typeId
   * @property {any} type
   * @property {THREE.Object3D} mesh
   * @property {THREE.AnimationMixer|null} mixer
   * @property {THREE.AnimationAction|null} idleAction
   * @property {THREE.AnimationAction|null} walkAction
   * @property {THREE.AnimationAction|null} attackAction
   * @property {number} hp
   * @property {number} maxHp
   * @property {number} level
   * @property {number} speed   - blocks / (60 frames) base step.
   * @property {number} aggroR
   * @property {number} dmgHalf
   * @property {'idle'|'walk'|'attack'} state
   * @property {number} targetY - target feet-anchored ground y, smoothly approached.
   * @property {string} leaderUid - '' if local-only or no leader; else uid claiming the AI.
   * @property {number} leaderUntil - wall-clock ms when the current lease expires.
   * @property {string} lastHitUid
   * @property {string} targetUid
   * @property {number} lastTickMs
   * @property {number} lastRefreshMs
   * @property {number} lastLocalHitMs
   * @property {Array<{ts:number,x:number,y:number,z:number,ry:number,state:string}>} poseBuffer
   * @property {THREE.Mesh|null} nameMesh
   * @property {THREE.CanvasTexture|null} nameTexture
   * @property {HTMLCanvasElement|null} nameCanvas
   * @property {number} drawnHp
   * @property {number} drawnMaxHp
   * @property {number} flashUntilMs
   */

  /** @type {Map<string, Mob>} */
  const mobs = new Map()
  mc.fusSimpleMobs = mobs

  let disposed = false
  let respawnIv = 0
  /** Listen handles for RTDB. Set in shared-mode only. */
  let offAdd = null
  let offChg = null
  let offRem = null
  let offHits = null
  /** Cache of live peers so the master checker isn't calling into `fusRemoteAvatars` lazily. */
  let isMaster = false

  const nowMs = () => Date.now()

  /** Resolve the GLB url from the vite plugin that pins it under `labyminecraft/...`. Fallback
   *  path so a stray test fixture doesn't silently 404. */
  const glbUrlFor = (typeId) => {
    const t = fusMobTypeById(typeId)
    const base =
      typeof window !== 'undefined' && typeof window.__LABY_MC_ASSET_BASE__ === 'string'
        ? window.__LABY_MC_ASSET_BASE__
        : '/labyminecraft/'
    return `${base}src/resources/models/${t.file}`
  }

  const loadTemplate = (typeId) => {
    const cached = templateCache.get(typeId)
    if (cached) return cached
    const loader = new GLTFLoader()
    const url = glbUrlFor(typeId)
    const p = new Promise((resolve, reject) => {
      loader.load(
        url,
        (gltf) => {
          /** Compute the raw GLB height once per type so we can normalise wildly-different
           *  exports (some of the mob packs ship at centimetre scale, others at metre scale).
           *  Storing it on the cached template means every subsequent clone reuses the number
           *  without rebuilding a Box3 per spawn. */
          let rawHeight = 1.9
          try {
            const bbox = new THREE.Box3().setFromObject(gltf.scene)
            const size = new THREE.Vector3()
            bbox.getSize(size)
            if (Number.isFinite(size.y) && size.y > 0.001) rawHeight = size.y
          } catch (e) {
            console.warn('[fusSimpleMobs] bbox compute failed', typeId, e)
          }
          resolve({ scene: gltf.scene, clips: gltf.animations || [], rawHeight })
        },
        undefined,
        (err) => reject(err),
      )
    })
    templateCache.set(typeId, p)
    return p
  }

  /**
   * Replace the GLTF-imported material with a lit-independent {@link THREE.MeshBasicMaterial}.
   * The minecraft scene uses vertex-color / fullbright rendering and has no scene light set up
   * at runtime, so anything that needs lighting (Standard, Lambert) renders effectively black.
   * We keep the original diffuse map so skins still look right.
   */
  const convertMaterialsToBasic = (root) => {
    root.traverse((o) => {
      if (!o.isMesh) return
      const oldMats = Array.isArray(o.material) ? o.material : [o.material]
      const newMats = oldMats.map((m) => {
        if (!m) return m
        /** Already basic — reuse. */
        if (m.isMeshBasicMaterial) return m
        const basic = new THREE.MeshBasicMaterial({
          map: m.map || null,
          color: m.color ? m.color.clone() : new THREE.Color(0xffffff),
          transparent: !!m.transparent,
          opacity: typeof m.opacity === 'number' ? m.opacity : 1,
          alphaTest: typeof m.alphaTest === 'number' ? m.alphaTest : 0,
          side: m.side ?? THREE.FrontSide,
          vertexColors: !!m.vertexColors,
          toneMapped: false,
          depthTest: true,
          depthWrite: m.depthWrite !== false,
        })
        if (basic.map && basic.map.colorSpace !== THREE.SRGBColorSpace) {
          basic.map.colorSpace = THREE.SRGBColorSpace
          basic.map.needsUpdate = true
        }
        /** Dispose the original since we own a reference now; nothing else refers to the clone
         *  body's materials. */
        try {
          m.dispose?.()
        } catch {
          /* ignore */
        }
        return basic
      })
      o.material = Array.isArray(o.material) ? newMats : newMats[0]
    })
  }

  /** Block ids we refuse to use as "floor" for a mob spawn or a chase step. Trees (log 17 /
   *  leaf 18) previously put mobs out of reach on top of the canopy; water (9) and lava
   *  (10) drop them into a hazard immediately. */
  const NON_FLOOR_IDS = new Set([9, 10, 17, 18])
  /** Block ids that count as walkable open space above the floor block. */
  const AIR_ID = 0

  /**
   * Resolve the y where a mob should *stand* at (wx, wz). `getHeightAt` returns the highest
   * non-air column, which for trees is the top of the canopy — placing mobs there was the
   * "spawned on the leaves I can't reach" user report. Instead we walk down from that column
   * top until we find a block that's a real floor (grass/dirt/stone/etc.) with two air
   * blocks above it (mob torso clearance). Returns the air y the feet stand at, or null if
   * we can't find anything valid within a reasonable scan window.
   */
  const solidGroundYAt = (wx, wz) => {
    const w = mc.world
    if (!w || typeof w.getBlockAt !== 'function' || typeof w.getHeightAt !== 'function') return null
    const bx = Math.floor(wx)
    const bz = Math.floor(wz)
    if (typeof w.chunkExists === 'function' && !w.chunkExists(bx >> 4, bz >> 4)) return null
    const top = w.getHeightAt(bx, bz)
    if (typeof top !== 'number' || top <= 0) return null
    /** Scan down at most 24 blocks; deeper than this and we're inside a cave or the column
     *  is entirely air — either way not a valid surface spawn. */
    const scanFloor = Math.max(1, top - 24)
    for (let y = top; y >= scanFloor; y--) {
      const floorId = w.getBlockAt(bx, y - 1, bz)
      if (floorId === AIR_ID) continue
      if (NON_FLOOR_IDS.has(floorId)) continue
      const feet = w.getBlockAt(bx, y, bz)
      const head = w.getBlockAt(bx, y + 1, bz)
      if (feet !== AIR_ID || head !== AIR_ID) continue
      return y
    }
    return null
  }

  /**
   * Resolve the y a mob should stand at *near its current altitude*. Crucial for chase AI:
   * the vanilla `world.getHeightAt` returns the top of the highest non-air column, which
   * for a mob walking *under* a tree is the top of the canopy — user-reported as "when
   * chasing the player and walking under a tree, get teleport on top of the tree". Same
   * bug hits caves, overhangs, and any terrain where blocks sit above the mob.
   *
   * Strategy (look at current y first, then allow small step-up / fall):
   *   1. If the mob is currently standing on a valid floor (block below is solid non-tree,
   *      block at feet is air, block at head is air) → keep the current y.
   *   2. Otherwise walk up/down from `currentY` within a small window (`stepUp`, `fallMax`)
   *      searching for the first valid (feet-air, head-air, floor-solid) slot. Up is tried
   *      first for auto-jump semantics when the mob walks into a 1-block step.
   *   3. Tree logs / leaves are never accepted as "floor" but *are* treated as solid head
   *      clearance blockers — so a mob under a tree stays on the dirt below the log column
   *      rather than jumping up through the canopy.
   *
   * Returns the "feet y" (first air block the mob's origin should sit at), or `null` if no
   * valid position exists inside the window — caller should then hold position.
   *
   * @param {number} wx
   * @param {number} wz
   * @param {number} currentY
   * @param {number} [stepUp=1] blocks we allow the mob to auto-jump
   * @param {number} [fallMax=6] blocks we allow the mob to fall toward ground
   */
  const walkableGroundYNear = (wx, wz, currentY, stepUp = 1, fallMax = 6) => {
    const w = mc.world
    if (!w || typeof w.getBlockAt !== 'function') return null
    const bx = Math.floor(wx)
    const bz = Math.floor(wz)
    /** Helper — a "floor" is a non-air, non-tree, non-liquid block we can stand on. */
    const isFloor = (y) => {
      const id = w.getBlockAt(bx, y, bz)
      if (id === AIR_ID) return false
      if (NON_FLOOR_IDS.has(id)) return false
      return true
    }
    const isClear = (y) => w.getBlockAt(bx, y, bz) === AIR_ID
    const startY = Math.round(currentY)
    /** Try current level first so a mob that's already standing properly doesn't jitter. */
    if (isFloor(startY - 1) && isClear(startY) && isClear(startY + 1)) {
      return startY
    }
    /** Step up: maybe the mob walked into a 1-block obstacle and needs to climb. */
    for (let dy = 1; dy <= stepUp; dy++) {
      const y = startY + dy
      if (isFloor(y - 1) && isClear(y) && isClear(y + 1)) return y
    }
    /** Fall: we walked off a ledge / over a hole. Look below for the first real floor. */
    for (let dy = 1; dy <= fallMax; dy++) {
      const y = startY - dy
      if (y < 1) break
      if (isFloor(y - 1) && isClear(y) && isClear(y + 1)) return y
    }
    return null
  }

  /** All known player positions (self + interpolated remote peers). Used for AI targeting and
   *  visibility checks. Remote peers come from {@link installFusRemoteAvatars}. */
  const eachPlayerPos = (visit) => {
    const pl = mc.player
    if (pl && Number.isFinite(pl.x) && Number.isFinite(pl.z)) {
      /** Always include the local position for distance-based systems (spawns, despawn, mob
       *  visibility, bubble counts). Skipping `self` only during `fusSpawnInvuln` starved
       *  `collectPlayerAnchors` for 5s after every load, so the shared-world balancer saw
       *  `anchors.length === 0` and visibility had no reference player — mobs
       *  could not spawn or render while you explored. Aggro and combat still respect
       *  invulnerability in {@link nearestTargetFor} and player-combat. */
      visit({ uid, x: pl.x, y: pl.y, z: pl.z, self: true })
    }
    const peers = mc.fusRemoteAvatars
    if (peers && typeof peers.forEach === 'function') {
      peers.forEach((av, peerUid) => {
        if (!av || !av.root) return
        const p = av.root.position
        if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) return
        visit({ uid: peerUid, x: p.x, y: p.y, z: p.z, self: false })
      })
    }
  }

  /** True if `uid` is the lowest-sorting live uid among self + peers. We re-evaluate on every
   *  `SPAWN_CHECK_MS` tick — cheap since the peer set is in the order of ~dozens. */
  const computeIsMaster = () => {
    if (!multiplayer) return true
    let smallest = String(uid)
    const peers = mc.fusRemoteAvatars
    if (peers && typeof peers.forEach === 'function') {
      peers.forEach((_, peerUid) => {
        if (typeof peerUid === 'string' && peerUid < smallest) smallest = peerUid
      })
    }
    return smallest === uid
  }

  /** Minimum horizontal distance from *any* player for a valid spawn. Users reported mobs
   *  spawning on top of them and instantly killing; pushed out to 22 blocks so the player
   *  has time to react and the mob still has room to chase. Roughly 3× melee range. */
  const SPAWN_MIN_DIST = 22
  /** Maximum horizontal distance — outside this the mob spawns beyond visibility and
   *  despawns immediately. Capped at visibility - 4 so the spawn isn't wasted. */
  const spawnMaxDist = () => Math.max(SPAWN_MIN_DIST + 10, getVisRange() - 4)

  /**
   * Find a spawn point around the given anchor (usually another player's position). Falls
   * back to our own player when no anchor is provided so existing "spawn near me" callers
   * still work.
   *
   * Picks a random ring radius in `[SPAWN_MIN_DIST, spawnMaxDist()]` so mobs don't appear
   * on top of the player (user report: "currently all mobs are placed around the spawn of
   * the player, killing him instantly"). Candidate is rejected if:
   *   • chunk not loaded / no ground resolvable at that column;
   *   • ground surface is a tree log / leaf / water / lava (user report: "try to spawn mobs
   *     not on the trees, as most of them get spawned on the trees where I can't reach");
   *   • there's another live player closer than {@link SPAWN_MIN_DIST} (prevents peer
   *     ambushes in multiplayer);
   *   • the mob would overlap an existing mob within 4 blocks (keeps the spread even).
   *
   * Tries up to 24 random samples before giving up — the retry count is high because with
   * the strict tree filter we sometimes need several rolls to find a grass patch in a
   * forested biome.
   *
   * @param {{x:number,y:number,z:number}} [anchor]
   */
  const findSpawnNearPoint = (anchor) => {
    const a = anchor || (mc.player ? { x: mc.player.x, y: mc.player.y, z: mc.player.z } : null)
    if (!a) return null
    const anchors = collectPlayerAnchors()
    const maxR = spawnMaxDist()
    const minR2 = SPAWN_MIN_DIST * SPAWN_MIN_DIST
    const mobClearR2 = 4 * 4
    for (let tries = 0; tries < 36; tries++) {
      const ang = Math.random() * Math.PI * 2
      const r = SPAWN_MIN_DIST + Math.random() * (maxR - SPAWN_MIN_DIST)
      const sx = a.x + Math.cos(ang) * r
      const sz = a.z + Math.sin(ang) * r

      if (distSqToLocalFlag(sx, sz) < FLAG_SPAWN_EXCLUSION_R * FLAG_SPAWN_EXCLUSION_R) continue

      /** Reject if too close to any player (not just the chosen anchor). */
      let tooCloseToPlayer = false
      for (const p of anchors) {
        const dx = p.x - sx
        const dz = p.z - sz
        if (dx * dx + dz * dz < minR2) {
          tooCloseToPlayer = true
          break
        }
      }
      if (tooCloseToPlayer) continue

      /** Reject if another mob is already within 4 blocks — keeps spawns from clustering. */
      let tooCloseToMob = false
      for (const m of mobs.values()) {
        if (m.hp <= 0) continue
        const mp = m.mesh.position
        const dx = mp.x - sx
        const dz = mp.z - sz
        if (dx * dx + dz * dz < mobClearR2) {
          tooCloseToMob = true
          break
        }
      }
      if (tooCloseToMob) continue

      const w = mc.world
      const tbx = Math.floor(sx)
      const tbz = Math.floor(sz)
      if (w && typeof w.chunkExists === 'function' && !w.chunkExists(tbx >> 4, tbz >> 4)) {
        continue
      }

      const y = solidGroundYAt(sx, sz)
      if (y == null) continue
      return { x: sx, y, z: sz }
    }
    return null
  }
  /** Legacy name kept for callers outside this refactor. */
  const findSpawnNearPlayer = () => findSpawnNearPoint(null)

  /**
   * Instantiate the three.js mesh + mixer for a mob, from its type template. Caller supplies
   * the `(typeId, level)` — we size scale/hp/speed from the registry. Returns null if the GLB
   * isn't loaded yet (spawn flow retries next tick).
   */
  const buildMobFromTemplate = async (id, typeId, lvl, pos) => {
    const type = fusMobTypeById(typeId)
    let tpl = null
    try {
      tpl = await loadTemplate(typeId)
    } catch (e) {
      console.warn('[fusSimpleMobs] GLB load failed', typeId, e)
      return null
    }
    if (disposed) return null

    const mesh = tpl.scene.clone(true)
    /** Auto-fit to {@link MOB_HEIGHT_TARGET} so mobs exported at different scales land at
     *  a consistent visual size. Per-type {@code modelScale} is then applied as a gameplay
     *  multiplier (e.g. spider 0.6 → ~1.14 m tall, warden 1 → 1.9 m tall). Before this fix the
     *  raw `modelScale` was taken as the absolute scale, which made some GLBs render as giants
     *  and others as ants when the source assets changed hands. */
    const modelScale =
      typeof type.modelScale === 'number' && type.modelScale > 0 ? type.modelScale : 1
    const autoFit = tpl.rawHeight > 0.001 ? MOB_HEIGHT_TARGET / tpl.rawHeight : 1
    mesh.scale.setScalar(autoFit * modelScale)
    mesh.position.set(pos.x, pos.y, pos.z)
    mesh.matrixAutoUpdate = true
    mesh.traverse((o) => {
      o.matrixAutoUpdate = true
      if (o.isMesh) {
        o.castShadow = false
        o.receiveShadow = false
      }
    })
    convertMaterialsToBasic(mesh)
    scene.add(mesh)

    let mixer = null
    let idleAction = null
    let walkAction = null
    let attackAction = null
    let attackClipDurationSec = 0
    if (tpl.clips.length > 0) {
      mixer = new THREE.AnimationMixer(mesh)
      const idleClip = fusMobAnimClip(tpl.clips, 'idle', type)
      const walkClip = fusMobAnimClip(tpl.clips, 'walk', type)
      const attackClip = fusMobAnimClip(tpl.clips, 'attack', type)
      if (idleClip) {
        idleAction = mixer.clipAction(idleClip)
        idleAction.play()
      }
      if (walkClip) {
        walkAction = mixer.clipAction(walkClip)
        walkAction.setEffectiveWeight(0)
        walkAction.play()
      }
      if (attackClip) {
        attackAction = mixer.clipAction(attackClip)
        attackAction.setLoop(THREE.LoopOnce, 1)
        if (Number.isFinite(attackClip.duration) && attackClip.duration > 0.01) {
          attackClipDurationSec = attackClip.duration
        }
      }
    }

    const { maxHp, speedMul: personalitySpeedMul } = statsForLabyMob(pos.x, pos.y, pos.z, typeId, lvl)

    /**
     * Nametag + HP bar above the mob. Pattern mirrors remote-player avatars: a
     * {@link THREE.CanvasTexture} backed by a 2D canvas that we redraw whenever hp / name
     * changes. The mesh is billboarded to face the camera each frame (yaw-only so text
     * stays upright). Appended as a sibling — not a child — because child planes inherit
     * the auto-fit scale we applied to the GLB, which would blow the text up 20×.
     */
    /** 2D canvas is authored at 512×168 logical px; the bitmap is 1–2× that via DPR for
     *  sharp subpixel text. Mipmaps off + linear min/mag: mip sampling was blurring the
     *  label into mush at any distance. */
    const nameCanvas = document.createElement('canvas')
    /** Lineage-style: compact (name + one thin bar only); large text for legibility. */
    const tagLW = 900
    const tagLH = 100
    const tagDpr = Math.min(
      2,
      Math.max(1, typeof window !== 'undefined' && typeof window.devicePixelRatio === 'number' ? window.devicePixelRatio : 1),
    )
    nameCanvas.width = Math.round(tagLW * tagDpr)
    nameCanvas.height = Math.round(tagLH * tagDpr)
    const nameTexture = new THREE.CanvasTexture(nameCanvas)
    nameTexture.magFilter = THREE.LinearFilter
    nameTexture.minFilter = THREE.LinearFilter
    nameTexture.generateMipmaps = false
    nameTexture.colorSpace = THREE.SRGBColorSpace
    const nameMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1.8, 0.22),
      new THREE.MeshBasicMaterial({
        map: nameTexture,
        transparent: true,
        /** `depthTest: true` so terrain and other blocks occlude the nametag — users asked
         *  for no see-through labels. `depthWrite: false` keeps the transparent pixels from
         *  cutting holes in anything rendered behind them. The combo is the standard
         *  "solid object occludes, but I don't occlude myself" billboard setup. */
        depthTest: true,
        depthWrite: false,
        alphaTest: 0.01,
        toneMapped: false,
      }),
    )
    /** Render above the mob. Effective height is `MOB_HEIGHT_TARGET * modelScale` (after
     *  the auto-fit × per-type multiplier applied above); +0.35 puts the plane a hand's
     *  width above the head regardless of mob size. */
    const effectiveHeight = MOB_HEIGHT_TARGET * modelScale
    nameMesh.position.set(pos.x, pos.y + effectiveHeight + 0.35, pos.z)
    /** Drop the render order too — with depthTest on, the explicit 999 was making the tag
     *  render late in the transparent queue but the depth buffer now takes care of
     *  occlusion regardless. A plain default keeps Three.js's built-in transparent sort
     *  (front-to-back) doing its job. */
    nameMesh.renderOrder = 5
    scene.add(nameMesh)

    /** @type {Mob} */
    const mob = {
      id,
      typeId,
      type,
      mesh,
      mixer,
      idleAction,
      walkAction,
      attackAction,
      hp: maxHp,
      maxHp,
      level: lvl,
      nameMesh,
      nameTexture,
      nameCanvas,
      /** Used by {@link redrawMobTag} to keep canvas backing store aligned with DPR. */
      _nameTagDpr: tagDpr,
      _nameTagLW: tagLW,
      _nameTagLH: tagLH,
      effectiveHeight,
      drawnHp: -1,
      drawnMaxHp: -1,
      flashUntilMs: 0,
      /** Base step. User-reported: "Mobs are too slow as well, it is easy just to step back
       *  and hit repeatedly to kill them, make them faster". Previously `0.022 × moveSpeed`
       *  → ~1.3 bl/s for the median mob, which a player walking (~4.3 bl/s) trivially outran.
       *  Bumped base to `0.055` so a `moveSpeed=1` mob runs ~3.3 bl/s, and a fast spider
       *  (`moveSpeed≈0.95`) gets to ~3.1 bl/s — close enough to a walking player that kiting
       *  forces actual footwork rather than a free back-pedal. Sprinting players (~5.6 bl/s)
       *  can still outrun everything, which matches the user's "make them faster" without
       *  removing the "but I can flee" escape hatch. Per-type multipliers from
       *  the mob registry stay in place so relative ordering (spider > boar > warden)
       *  is preserved. */
      speed: 0.055 * (type.moveSpeed || 1) * personalitySpeedMul,
      aggroR: fusMobAggroRadius(typeId),
      dmgHalf: fusMobDmgHalfForLevel(typeId, lvl, 2),
      state: 'idle',
      targetY: pos.y,
      leaderUid: '',
      leaderUntil: 0,
      lastHitUid: '',
      targetUid: '',
      lastTickMs: 0,
      lastRefreshMs: 0,
      lastLocalHitMs: 0,
      /** Timestamp at/after which the next hit on the local player is allowed. Armed on the
       *  attack-state transition in {@link blendTo} so the *first* hit of a swing lands at
       *  the end of the wind-up animation instead of the instant the mob enters range. */
      nextHitReadyMs: 0,
      poseBuffer: [],
      /** Seconds — used to sync {@link #nextHitReadyMs} with the end of the attack animation. */
      attackClipDurationSec,
    }
    mobs.set(id, mob)
    return mob
  }

  const removeMob = (mob, reason = '') => {
    if (!mob) return
    if (!mobs.has(mob.id)) return
    mobs.delete(mob.id)
    scene.remove(mob.mesh)
    if (mob.nameMesh) {
      try {
        scene.remove(mob.nameMesh)
        mob.nameMesh.material?.dispose?.()
        mob.nameMesh.geometry?.dispose?.()
      } catch {
        /* ignore */
      }
    }
    try {
      mob.nameTexture?.dispose?.()
    } catch {
      /* ignore */
    }
    try {
      mob.mixer?.stopAllAction?.()
    } catch {
      /* ignore */
    }
    mob.mesh.traverse((o) => {
      if (o.isMesh) {
        try {
          o.geometry?.dispose?.()
          const mats = Array.isArray(o.material) ? o.material : [o.material]
          for (const m of mats) m?.dispose?.()
        } catch {
          /* ignore */
        }
      }
    })
    void reason
  }

  /**
   * Player-side loot grant — called when a mob disappears and we were the last-hitter.
   * Pass a **live mob** (has {@code .mesh}) or an **RTDB instance row** (e.g. when
   * {@code onChildRemoved} fires after {@code ingestRemoteRow} already pruned the local map
   * at the hp=0 path — otherwise rewards were lost).
   *
   * XP: {@link fusMobKillXpReward}. Coins: at least 1 per kill; extra stack on a level-scaled
   * roll (harder mobs = larger stacks) — see {@link fusMobKillXp.js}.
   */
  const grantKillRewards = (mobOrRow) => {
    const isLiveMob = !!(mobOrRow && mobOrRow.mesh)
    const resolvePlLv = () => {
      const cands = [mc?.fusLevel, mc?.player?.fusLevel]
      if (typeof window !== 'undefined' && window.__FUS_MC__ && window.__FUS_MC__.level != null) {
        cands.push(window.__FUS_MC__.level)
      }
      for (const c of cands) {
        const n = Math.floor(Number(c) || 0)
        if (n > 0) return Math.max(1, Math.min(50, n))
      }
      return 1
    }
    const resolveMobLv = () => {
      const fromRow = Math.floor(Number(mobOrRow?.level) || 0)
      if (fromRow > 0) return Math.max(1, Math.min(MOB_LEVEL_MAX, fromRow))
      if (isLiveMob && mobOrRow?.mesh?.position) {
        const p = mobOrRow.mesh.position
        return levelForWorldPos(p.x, p.z)
      }
      const x = Number(mobOrRow?.x)
      const z = Number(mobOrRow?.z)
      if (Number.isFinite(x) && Number.isFinite(z)) {
        return levelForWorldPos(x, z)
      }
      return 1
    }
    const plLv = resolvePlLv()
    const mobLv = resolveMobLv()
    const deltaUp = Math.max(0, mobLv - plLv) /** positive when mob is stronger */
    const typeId = String(
      (isLiveMob ? mobOrRow.typeId || mobOrRow.type?.id : mobOrRow.typeId) || 'spider_mob',
    )
    const type = (isLiveMob ? mobOrRow.type : null) || fusMobTypeById(typeId)
    const maxH =
      isLiveMob && Number.isFinite(mobOrRow.maxHp)
        ? Number(mobOrRow.maxHp)
        : fusMobMaxHpForLevel(mobLv, type)
    const xpFromLevel = fusMobKillXpReward(typeId, mobLv, maxH, plLv)
    /** At least 1 so kills always show XP (backstop if {@link fusMobKillXpReward} ever returns 0). */
    const xp = Math.max(1, xpFromLevel)

    const du = Math.min(30, deltaUp)
    const coinChance =
      deltaUp <= 0
        ? 0.18 + Math.random() * 0.25
        : Math.min(0.9, 0.35 + 0.55 * (du / 30))
    let coinCount = 1
    if (Math.random() < coinChance) {
      if (deltaUp <= 0) {
        coinCount = 1 + Math.floor(Math.random() * 2)
      } else {
        const t = du / 30
        const nmax = 1 + Math.floor(10 * t)
        coinCount = 1 + Math.floor(Math.random() * nmax)
      }
    }
    if (deltaUp > 0) {
      const floorC = 1 + Math.min(6, Math.floor(du / 3))
      coinCount = Math.max(floorC, coinCount)
    } else {
      coinCount = Math.max(1, coinCount)
    }
    if (typeId === WARDEN_TYPE_ID) {
      coinCount = Math.max(3, Math.round(coinCount * 2.8))
    }

    const getKillPos = () => {
      if (isLiveMob) {
        return {
          x: mobOrRow.mesh.position.x,
          y: mobOrRow.mesh.position.y,
          z: mobOrRow.mesh.position.z,
        }
      }
      const x = Number(mobOrRow.x)
      const y = Number(mobOrRow.y)
      const z = Number(mobOrRow.z)
      if ([x, z].every(Number.isFinite)) {
        return { x, y: Number.isFinite(y) ? y : 64, z }
      }
      return null
    }

    const getKillerUidForHooks = () => {
      const fromMc =
        typeof window !== 'undefined' && window.__FUS_MC__ && window.__FUS_MC__.uid != null
          ? String(window.__FUS_MC__.uid)
          : ''
      return (
        (fromMc && fromMc !== '' ? fromMc : null) ||
        (uid != null && String(uid) !== '' ? String(uid) : null)
      )
    }

    const pos = getKillPos()
    const mobTypeLabel = type?.displayName || typeId
    const haveBundled =
      typeof window !== 'undefined' && typeof window.__FUS_GRANT_LABY_MOB_PAYOUT__ === 'function'
    const myUid0 = getKillerUidForHooks()
    let usedBundledPayout = false
    if (haveBundled && myUid0 && (xp > 0 || coinCount > 0)) {
      try {
        const p = window.__FUS_GRANT_LABY_MOB_PAYOUT__({
          xp,
          coins: coinCount,
          mobType: mobTypeLabel,
          killerUid: myUid0,
        })
        if (p && typeof p.then === 'function') {
          p.catch((e) => console.warn('[fusSimpleMobs] __FUS_GRANT_LABY_MOB_PAYOUT__', e))
        }
        usedBundledPayout = true
      } catch (e) {
        console.warn('[fusSimpleMobs] bundled mob payout failed', e)
      }
    }
    if (!usedBundledPayout) {
      try {
        if (typeof window !== 'undefined' && typeof window.__FUS_GRANT_LABY_XP__ === 'function' && xp > 0) {
          const myUid = getKillerUidForHooks()
          if (myUid) {
            void Promise.resolve(
              window.__FUS_GRANT_LABY_XP__(xp, {
                mobType: mobTypeLabel,
                killerUid: myUid,
              }),
            ).catch((e) => console.warn('[fusSimpleMobs] grant laby xp', e))
          }
        }
      } catch {
        /* ignore */
      }
      if (coinCount > 0) {
        try {
          const canPhysical = typeof mc.fusDropCoinAt === 'function'
          if (canPhysical && pos) {
            let left = coinCount
            /** Weak touch clients: at most two world nodes (≤40 coins) + grant rest in-app — was spamming RTDB + GLB clones on warden-tier kills. */
            const maxStacks = mc.fusLowTierMobile ? 2 : 1e9
            let stacks = 0
            while (left > 0 && stacks < maxStacks) {
              const chunk = Math.min(20, left)
              const jx = (Math.random() - 0.5) * 0.55
              const jz = (Math.random() - 0.5) * 0.55
              mc.fusDropCoinAt(pos.x + jx, pos.y + 0.25, pos.z + jz, { coins: chunk, source: 'mob' })
              left -= chunk
              stacks += 1
            }
            if (left > 0) {
              if (typeof window !== 'undefined' && typeof window.__FUS_GRANT_LOOT__ === 'function') {
                void Promise.resolve(
                  window.__FUS_GRANT_LOOT__({ kind: 'coins', coins: left, source: 'mob' }),
                ).catch((e) => console.warn('[fusSimpleMobs] overflow mob coins', e))
              } else {
                while (left > 0) {
                  const chunk = Math.min(20, left)
                  const jx = (Math.random() - 0.5) * 0.55
                  const jz = (Math.random() - 0.5) * 0.55
                  mc.fusDropCoinAt(pos.x + jx, pos.y + 0.25, pos.z + jz, { coins: chunk, source: 'mob' })
                  left -= chunk
                }
              }
            }
          } else if (typeof window !== 'undefined' && typeof window.__FUS_GRANT_LOOT__ === 'function') {
            const p = window.__FUS_GRANT_LOOT__({ kind: 'coins', coins: coinCount, source: 'mob' })
            if (p && typeof p.then === 'function') {
              p.catch((e) => console.warn('[fusSimpleMobs] __FUS_GRANT_LOOT__', e))
            }
          }
        } catch (e) {
          console.warn('[fusSimpleMobs] coin grant failed', e)
        }
      }
    }

    try {
      const tough = Math.min(1, deltaUp / 18 + mobLv / 28)
      let pItem = 0.2 + tough * 0.42 + Math.min(0.18, du * 0.02)
      if (typeId === WARDEN_TYPE_ID) pItem += 0.14
      pItem = Math.min(0.88, pItem)
      if (Math.random() < pItem) {
        const pick = Math.floor(Math.random() * FUS_LABY_MOB_DROP_BW_KEYS.length)
        const bwKey = FUS_LABY_MOB_DROP_BW_KEYS[pick] || FUS_LABY_MOB_DROP_BW_KEYS[0]
        const st = bwKey.startsWith('fus_bw_tool_') || bwKey === 'fus_bw_pick' ? 'tool' : 'block'
        const itemLabel = labyDisplayNameForMobDropBwKey(bwKey)
        const grantItemDirect = typeof window !== 'undefined' && typeof window.__FUS_GRANT_LOOT__ === 'function'
        if (grantItemDirect) {
          const p = window.__FUS_GRANT_LOOT__({
            kind: 'item',
            bwSeedKey: bwKey,
            source: 'mob',
            itemLabel,
          })
          if (p && typeof p.then === 'function') {
            p.catch((e) => console.warn('[fusSimpleMobs] __FUS_GRANT_LOOT__ item', e))
          }
        } else if (pos && typeof mc.fusDropItemAt === 'function') {
          const jx2 = (Math.random() - 0.5) * 0.65
          const jz2 = (Math.random() - 0.5) * 0.65
          mc.fusDropItemAt(pos.x + jx2, pos.y + 0.2, pos.z + jz2, {
            subtype: st,
            label: itemLabel.slice(0, 32),
            payload: { bwSeedKey: bwKey, source: 'mob' },
          })
        }
      }
    } catch (e) {
      console.warn('[fusSimpleMobs] item drop failed', e)
    }
  }

  /**
   * Red-tint flash + hit particle burst in one call. The flash is driven from the RAF
   * via {@code mob.flashUntilMs} — setting a timestamp here and polling each frame
   * avoids drift between `setTimeout`-fired restores and the mob potentially being
   * removed (which would leak the original color references). Particle burst is fire-
   * and-forget into {@link mc.fusFxHit}.
   */
  const FLASH_MS = 220
  const flashHit = (mob) => {
    if (!mob || !mob.mesh) return
    mob.flashUntilMs = nowMs() + FLASH_MS
    mob.mesh.traverse((o) => {
      if (o.isMesh && o.material && !o._fusOrigColor) {
        const mat = o.material
        o._fusOrigColor = mat.color ? mat.color.clone() : null
        if (mat.color) mat.color.setRGB(1, 0.15, 0.15)
      }
    })
    try {
      const p = mob.mesh.position
      mc.fusFxHit?.(p.x, p.y + 0.9, p.z, { count: 8, spread: 0.4 })
    } catch {
      /* ignore */
    }
  }

  const clearFlash = (mob) => {
    if (!mob || !mob.mesh) return
    mob.mesh.traverse((o) => {
      if (o.isMesh && o.material && o._fusOrigColor) {
        try {
          o.material.color.copy(o._fusOrigColor)
        } catch {
          /* ignore */
        }
        o._fusOrigColor = null
      }
    })
  }

  /**
   * Death VFX — hide the mesh + nametag, fire a death particle burst centred at the mob.
   * Caller is responsible for removing the mob from the map shortly after (the RAF frame
   * will still attempt to update a hidden mesh/nametag, which is fine — invisible mesh
   * updates cost nothing measurable). The mob's GLB colour isn't readable cleanly (mix
   * of textured surfaces), so we pick a reasonable per-type tint from the registry if
   * available, else a neutral grey.
   */
  const triggerDeathVfx = (mob) => {
    if (!mob || !mob.mesh) return
    if (mob._fusDeathVfxDone) return
    mob._fusDeathVfxDone = true
    const p = mob.mesh.position
    const tint = typeof mob.type?.deathTint === 'number' ? mob.type.deathTint : 0x94a3b8
    try {
      mc.fusFxDeath?.(p.x, p.y + 0.9, p.z, { count: 20, color: tint, spread: 1.0 })
    } catch {
      /* ignore */
    }
    try {
      mob.mesh.visible = false
      if (mob.nameMesh) mob.nameMesh.visible = false
    } catch {
      /* ignore */
    }
  }

  /**
   * Name + level (e.g. {@code Варден · 4}), thin HP bar, no HP numbers.
   */
  const redrawMobTag = (mob) => {
    if (!mob.nameCanvas || !mob.nameTexture) return
    const nameColor = String(mob.type?.nameTextColor || '#f8fafc')
    const lv = Math.max(1, Math.floor(Number(mob.level) || 1))
    if (
      mob.drawnHp === mob.hp &&
      mob.drawnMaxHp === mob.maxHp &&
      mob._drawnNameColor === nameColor &&
      mob._drawnLevel === lv
    ) {
      return
    }
    mob.drawnHp = mob.hp
    mob.drawnMaxHp = mob.maxHp
    mob._drawnNameColor = nameColor
    mob._drawnLevel = lv
    const ctx = mob.nameCanvas.getContext('2d')
    if (!ctx) return
    const dpr = Math.min(
      2,
      Math.max(1, typeof window !== 'undefined' && typeof window.devicePixelRatio === 'number' ? window.devicePixelRatio : 1),
    )
    const LW = Number.isFinite(mob._nameTagLW) ? mob._nameTagLW : 400
    const LH = Number.isFinite(mob._nameTagLH) ? mob._nameTagLH : 48
    if (!Number.isFinite(mob._nameTagDpr) || Math.abs(mob._nameTagDpr - dpr) > 0.01) {
      mob._nameTagDpr = dpr
      mob.nameCanvas.width = Math.round(LW * dpr)
      mob.nameCanvas.height = Math.round(LH * dpr)
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    const Wc = mob.nameCanvas.width
    const Hc = mob.nameCanvas.height
    ctx.clearRect(0, 0, Wc, Hc)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const W = LW
    const baseName = String(mob.type?.displayName || mob.typeId || 'Mob')
    const labelLine = `${baseName} · ${lv}`
    const pad = 6
    const nameY = 40
    /** Short, thick HP bar: ~38% of canvas width, centered. */
    const barW = Math.round((W - pad * 2) * 0.38)
    const barX = (W - barW) / 2
    const barY = 70
    const barH = 7
    const ratio = mob.maxHp > 0 ? Math.max(0, Math.min(1, mob.hp / mob.maxHp)) : 0

    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.lineWidth = 4
    ctx.font = '700 52px system-ui, "Segoe UI", Tahoma, Arial'
    const nx = W / 2
    ctx.strokeStyle = 'rgba(0,0,0,0.92)'
    ctx.fillStyle = nameColor
    ctx.strokeText(labelLine, nx, nameY, W - 24)
    ctx.fillText(labelLine, nx, nameY, W - 24)

    /** Dark track + HSL fill (shorter, thicker). */
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.fillRect(barX, barY, barW, barH)
    if (ratio > 0) {
      ctx.fillStyle = `hsl(${Math.round(120 * ratio)}, 82%, 50%)`
      ctx.fillRect(barX, barY, Math.max(1, barW * ratio), barH)
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0)
    mob.nameTexture.needsUpdate = true
  }

  // ---------------------------------------------------------------------------
  //  LOCAL MODE — same API, no RTDB.
  // ---------------------------------------------------------------------------

  const spawnOneLocal = async () => {
    if (disposed) return
    const pos = findSpawnNearPlayer()
    if (!pos) return
    const typeId = typeIdForSpawnPos(pos.x, pos.z)
    const id = `m_${Math.random().toString(36).slice(2, 9)}`
    const lvl = levelForWorldPos(pos.x, pos.z)
    await buildMobFromTemplate(id, typeId, lvl, pos)
  }

  // ---------------------------------------------------------------------------
  //  SHARED MODE — RTDB plumbing.
  // ---------------------------------------------------------------------------

  /** Ref to `worldMobs/{worldId}/instances` — the authoritative pool. */
  const instancesRef = multiplayer
    ? dbRef(rtdb, `worldMobs/${worldId}/instances`)
    : null
  /** Ref to the player→mob damage log. */
  const hitsRef = multiplayer ? dbRef(rtdb, `worldMobPlayerHits/${worldId}`) : null

  /** Last RTDB row for mobs we skipped meshing (out of interest); retried in {@link #frame} when the player is close. */
  /** @type {Map<string, object>} */
  const deferredRemoteIngest = new Map()

  /** Apply a remote state row to our local mob (creating it if we haven't seen it yet). */
  const ingestRemoteRow = async (key, row) => {
    if (!row || typeof row !== 'object') return
    const typeId = typeof row.typeId === 'string' ? row.typeId : null
    if (!typeId) return
    const x = Number(row.x)
    const y = Number(row.y)
    const z = Number(row.z)
    const ry = Number(row.ry)
    if (![x, y, z].every(Number.isFinite)) return
    const pl0 = mc.player
    if (!mobs.has(key) && pl0 && !fusLabyIsWithinPlayerInterestXz(mc, x, z)) {
      deferredRemoteIngest.set(key, row)
      return
    }
    let mob = mobs.get(key)
    if (!mob) {
      const lvl = Math.max(1, Math.floor(Number(row.level) || level))
      const built = await buildMobFromTemplate(key, typeId, lvl, { x, y, z })
      if (!built) return
      mob = built
    }
    mob.leaderUid = typeof row.leaderUid === 'string' ? row.leaderUid : ''
    mob.leaderUntil = Number(row.leaderUntil) || 0
    mob.lastHitUid = typeof row.lastHitUid === 'string' ? row.lastHitUid : ''
    mob.targetUid = typeof row.targetUid === 'string' ? row.targetUid : ''
    /** Observer-side damage detection — if the leader shrank hp, play the flash+puff so
     *  every client sees the impact without needing to consume the hit themselves. */
    const prevHp = mob.hp
    if (Number.isFinite(row.hp)) {
      const incoming = Math.max(0, Number(row.hp))
      /**
       * Out-of-order {@code onChildChanged}: we may have already applied a local killing blow
       * (optimistic {@code hp=0}) or a prior {@code hp:0} event while RTDB still delivers an
       * older row with positive hp — that would "resurrect" the mesh for a frame, and
       * {@link applyMobDamageToLocalPlayer} could land one more hit after loot/coins.
       * Mobs never legitimately go from dead → alive; ignore stale positive hp in that case.
       */
      if (mob.hp <= 0) {
        if (incoming > 0) {
          /* keep 0 */
        } else {
          mob.hp = 0
        }
      } else {
        mob.hp = incoming
      }
    }
    if (Number.isFinite(row.maxHp)) mob.maxHp = Math.max(1, Number(row.maxHp))
    if (Number.isFinite(prevHp) && mob.hp < prevHp - 0.001 && mob.leaderUid !== uid) {
      flashHit(mob)
    }
    const state =
      row.state === 'walk' || row.state === 'attack' || row.state === 'idle' ? row.state : 'idle'
    /** Only buffer pose samples when the authoritative writer is _someone else_. Our own
     *  leader ticks set the mesh position synchronously for zero-latency local rendering. */
    if (mob.leaderUid !== uid) {
      mob.poseBuffer.push({
        ts: nowMs(),
        x,
        y,
        z,
        ry: Number.isFinite(ry) ? ry : 0,
        state,
      })
      if (mob.poseBuffer.length > 24) mob.poseBuffer.shift()
    }
    /** RTDB can deliver {@code hp:0} on {@code onChildChanged} before {@code onChildRemoved}
     *  (or the remove can be delayed) — cull the corpse so it does not idle in the world. */
    if (Number.isFinite(prevHp) && mob.hp <= 0) {
      if (prevHp > 0) triggerDeathVfx(mob)
      if (!mob._fusIngestDeathPending) {
        mob._fusIngestDeathPending = true
        window.setTimeout(() => {
          mob._fusIngestDeathPending = false
          if (mobs.has(mob.id)) removeMob(mob, 'ingest-hp0')
        }, 45)
      }
    }
    deferredRemoteIngest.delete(key)
  }

  const subscribeInstances = () => {
    if (!instancesRef) return
    offAdd = onChildAdded(instancesRef, (snap) => {
      const key = snap.key
      if (!key) return
      void ingestRemoteRow(key, snap.val())
    })
    offChg = onChildChanged(instancesRef, (snap) => {
      const key = snap.key
      if (!key) return
      void ingestRemoteRow(key, snap.val())
    })
    offRem = onChildRemoved(instancesRef, (snap) => {
      const key = snap.key
      if (!key) return
      deferredRemoteIngest.delete(key)
      const row = snap.val() || {}
      const mob = mobs.get(key)
      const lastHit =
        (typeof mob?.lastHitUid === 'string' && mob.lastHitUid) ||
        (typeof row.lastHitUid === 'string' && row.lastHitUid) ||
        ''
      if (lastHit && String(lastHit) === String(uid)) {
        try {
          mc.fusPveBlockMobHitUntilMs = nowMs() + PVE_BLOCK_MOB_HIT_AFTER_KILL_MS
        } catch {
          /* ignore */
        }
        if (mob) {
          grantKillRewards(mob)
          const killPos = {
            x: mob.mesh.position.x,
            y: mob.mesh.position.y,
            z: mob.mesh.position.z,
          }
          scheduleMobRespawnAfterKill(killPos, mob.typeId, mob.level)
        } else {
          /** Local map was already cleared (e.g. hp0 ingest timeout) before RTDB remove arrived. */
          grantKillRewards(row)
          const x = Number(row.x)
          const y = Number(row.y)
          const z = Number(row.z)
          if ([x, y, z].every((n) => Number.isFinite(n))) {
            scheduleMobRespawnAfterKill({ x, y, z }, row.typeId, row.level)
          }
        }
      }
      if (!mob) {
        return
      }
      /** Fire the death puff before dropping the mesh from the scene. Everyone watching
       *  sees the burst; mesh/nameMesh removal follows ~25 ms later so particles have a
       *  chance to spawn at the right location. */
      triggerDeathVfx(mob)
      window.setTimeout(() => removeMob(mob, 'rtdb-remove'), 30)
    })
  }

  const subscribeHits = () => {
    if (!hitsRef) return
    /** Process new hit pushes. Every client is subscribed; only the leader of the targeted mob
     *  actually consumes (applies damage + deletes the row). Non-leaders ignore. */
    offHits = onChildAdded(hitsRef, async (snap) => {
      const row = snap.val()
      const key = snap.key
      if (!row || !key) return
      const mobKey = typeof row.mobKey === 'string' ? row.mobKey : ''
      if (!mobKey) return
      const mob = mobs.get(mobKey)
      if (!mob) return
      if (mob.leaderUid !== uid) return
      const hitRef = dbRef(rtdb, `worldMobPlayerHits/${worldId}/${key}`)
      /** Stale/duplicate hit rows after the mob is already dead: drop them without
       *  re-flashing, re-writing, or re-running {@link killMobShared}. */
      if (mob.hp <= 0) {
        try {
          await dbRemove(hitRef)
        } catch {
          /* ignore */
        }
        return
      }
      const dmgHalf = Number(row.dmgHalf)
      if (!Number.isFinite(dmgHalf) || dmgHalf <= 0) return
      const fromUid = typeof row.fromUid === 'string' ? row.fromUid : ''
      mob.hp = Math.max(0, mob.hp - dmgHalf)
      mob.lastHitUid = fromUid
      flashHit(mob)
      try {
        await dbRemove(hitRef)
      } catch {
        /* ignore — even if delete fails, the idempotent damage update still prevents
           double-apply because we only consume as leader and only once per row id. */
      }
      /** If the blow killed the mob, the leader tick will persist the dead state, see it, and
       *  remove the RTDB entry. Force a write now so latency is minimized. */
      await writeLeaderState(mob, /* force */ true)
      if (mob.hp <= 0) await killMobShared(mob)
    })
  }

  /** Claim leadership on a mob we want to lead. Transactional so two clients racing end with
   *  exactly one winner. */
  const tryClaimLeadership = async (mobKey) => {
    if (!multiplayer) return false
    const now = nowMs()
    const ref = dbRef(rtdb, `worldMobs/${worldId}/instances/${mobKey}`)
    try {
      const res = await runTransaction(ref, (row) => {
        if (!row) return row
        const until = Number(row.leaderUntil) || 0
        if (row.leaderUid && row.leaderUid !== uid && until > now - 500) {
          /** Someone else still holds a valid lease — abort. */
          return /* abort */
        }
        row.leaderUid = uid
        row.leaderUntil = now + LEADER_LEASE_MS
        return row
      })
      if (res.committed) {
        const local = mobs.get(mobKey)
        if (local) {
          local.leaderUid = uid
          local.leaderUntil = now + LEADER_LEASE_MS
          local.lastRefreshMs = now
        }
        return true
      }
    } catch (e) {
      console.warn('[fusSimpleMobs] claim transaction failed', e)
    }
    return false
  }

  /** Flush the mob's current state to RTDB. Cheap update (no server timestamp). */
  const writeLeaderState = async (mob, force = false) => {
    if (!multiplayer) return
    const now = nowMs()
    if (!force && now - mob.lastTickMs < TICK_MS) return
    mob.lastTickMs = now
    try {
      await dbUpdate(dbRef(rtdb, `worldMobs/${worldId}/instances/${mob.id}`), {
        x: mob.mesh.position.x,
        y: mob.mesh.position.y,
        z: mob.mesh.position.z,
        ry: (mob.mesh.rotation.y * 180) / Math.PI,
        state: mob.state,
        hp: mob.hp,
        typeId: typeof mob.typeId === 'string' ? mob.typeId : String(mob.typeId || 'spider_mob'),
        level: Math.max(1, Math.floor(Number(mob.level) || 1)),
        maxHp: mob.maxHp,
        leaderUid: mob.leaderUid,
        leaderUntil: mob.leaderUntil,
        lastHitUid: mob.lastHitUid,
        targetUid: mob.targetUid,
        at: now,
      })
    } catch (e) {
      console.warn('[fusSimpleMobs] leader write failed', mob.id, e)
    }
  }

  const refreshLeaderLease = async (mob) => {
    /** A corpse must not keep extending the lease or spamming {@code worldMobs} while remove is in flight. */
    if (mob.hp <= 0) return
    const now = nowMs()
    if (now - mob.lastRefreshMs < LEADER_REFRESH_MS) return
    mob.leaderUntil = now + LEADER_LEASE_MS
    mob.lastRefreshMs = now
    try {
      await dbUpdate(dbRef(rtdb, `worldMobs/${worldId}/instances/${mob.id}`), {
        leaderUntil: mob.leaderUntil,
      })
    } catch {
      /* ignore — next tick will retry. */
    }
  }

  /** Leader-only: remove the mob from RTDB (so every observer hears `onChildRemoved`). */
  const killMobShared = (mob) => {
    if (mob._fusKillRtdbPromise) return mob._fusKillRtdbPromise
    mob.hp = 0
    const instRef = dbRef(rtdb, `worldMobs/${worldId}/instances/${mob.id}`)
    mob._fusKillRtdbPromise = (async () => {
      try {
        /**
         * Ensure {@code lastHitUid} (and 0 HP) are on the node **before** delete so every client's
         * {@code onChildRemoved} payload attributes loot to the killer. Without this, a fast local
         * {@code removeMob} from ingest + empty {@code lastHit} on a rare race lost rewards.
         */
        try {
          await dbUpdate(instRef, {
            hp: 0,
            typeId: typeof mob.typeId === 'string' ? mob.typeId : String(mob.typeId || 'spider_mob'),
            level: Math.max(1, Math.floor(Number(mob.level) || 1)),
            maxHp: Number.isFinite(Number(mob.maxHp)) ? Number(mob.maxHp) : 0,
            lastHitUid: typeof mob.lastHitUid === 'string' ? mob.lastHitUid : '',
            at: nowMs(),
          })
        } catch (e) {
          console.warn('[fusSimpleMobs] pre-remove kill state failed', mob.id, e)
        }
        try {
          await dbRemove(instRef)
        } catch (e) {
          console.warn('[fusSimpleMobs] kill write failed', mob.id, e)
        }
      } finally {
        mob._fusKillRtdbPromise = null
      }
    })()
    return mob._fusKillRtdbPromise
  }

  /**
   * Master-only: spawn a new mob record near the given anchor (defaults to self). Used by
   * the dynamic spawn pass which picks an under-populated player and asks us to seed a
   * mob in their bubble.
   * @param {{x:number,y:number,z:number}} [anchor]
   */
  const spawnOneShared = async (anchor) => {
    if (!multiplayer) return
    if (disposed) return
    const pos = findSpawnNearPoint(anchor || null)
    if (!pos) return
    const typeId = typeIdForSpawnPos(pos.x, pos.z)
    const mobLvl = levelForWorldPos(pos.x, pos.z)
    const { maxHp } = statsForLabyMob(pos.x, pos.y, pos.z, typeId, mobLvl)
    const now = nowMs()
    const payload = {
      typeId,
      level: mobLvl,
      x: pos.x,
      y: pos.y,
      z: pos.z,
      ry: 0,
      state: 'idle',
      hp: maxHp,
      maxHp,
      leaderUid: uid,
      leaderUntil: now + LEADER_LEASE_MS,
      lastHitUid: '',
      targetUid: '',
      at: now,
    }
    try {
      const newRef = dbPush(instancesRef)
      await dbSet(newRef, payload)
    } catch (e) {
      console.warn('[fusSimpleMobs] spawn push failed', e)
    }
  }

  const spawnOneSharedAt = async (pos, typeId, mobLevel) => {
    if (!multiplayer) return
    if (disposed) return
    if (mobs.size >= MAX_TOTAL_MOBS) return
    const tId = typeof typeId === 'string' ? typeId : String(typeId)
    if (!tId) return
    const mLvl = Math.max(1, Math.floor(Number(mobLevel) || 1))
    const x = Number(pos && pos.x)
    const y = Number(pos && pos.y)
    const z = Number(pos && pos.z)
    if (![x, y, z].every(Number.isFinite)) return
    const { maxHp } = statsForLabyMob(x, y, z, tId, mLvl)
    const now = nowMs()
    const payload = {
      typeId: tId,
      level: mLvl,
      x,
      y,
      z,
      ry: 0,
      state: 'idle',
      hp: maxHp,
      maxHp,
      leaderUid: uid,
      leaderUntil: now + LEADER_LEASE_MS,
      lastHitUid: '',
      targetUid: '',
      at: now,
    }
    try {
      const newRef = dbPush(instancesRef)
      await dbSet(newRef, payload)
    } catch (e) {
      console.warn('[fusSimpleMobs] respawn push failed', e)
    }
  }

  const scheduleMobRespawnAfterKill = (pos, typeId, _mobLevel) => {
    if (!pos) return
    const tid = window.setTimeout(() => {
      killRespawnTimers.delete(tid)
      if (disposed) return
      if (mobs.size >= MAX_TOTAL_MOBS) return
      const tStr = String(typeId || '')
      if (!tStr) return
      const mLvl = levelForWorldPos(pos.x, pos.z)
      const feetY = walkableGroundYNear(pos.x, pos.z, pos.y, 3, 14) ?? pos.y
      if (multiplayer) {
        void spawnOneSharedAt({ x: pos.x, y: feetY, z: pos.z }, tStr, mLvl)
      } else {
        const newId = `m_${Math.random().toString(36).slice(2, 9)}`
        void buildMobFromTemplate(newId, tStr, mLvl, { x: pos.x, y: feetY, z: pos.z })
      }
    }, MOB_RESPAWN_AFTER_KILL_MS)
    killRespawnTimers.add(tid)
  }

  // ---------------------------------------------------------------------------
  //  Attack hook — player → mob damage.
  // ---------------------------------------------------------------------------

  /** Minimum bite — a fist with a level-1 attacker still has to take chip damage off a mob.
   *  Real damage is computed per-swing in {@link tryMelee} via {@link fusPvePlayerDamageToMobHp}. */
  const MIN_DAMAGE_PER_HIT = 0.5
  /** Bumped from 5.5 → 7.5 blocks. Users reported "attack distance seems extremely small,
   *  I have to walk into the mob to attack" — at 5.5 the cone gate plus the mob's own
   *  forward-walk animation meant you'd often close to contact range before the swing
   *  connected. Bumped to 8.5 (2026-04) — user reported hits still felt cramped when a mob
   *  was mid-charge, and the extra block of forgiveness helps the cone pick up tall mobs
   *  whose centre sits above or below the crosshair. Kept in lockstep with the PvP range. */
  const ATTACK_RANGE = 8.5
  /** cos(60°) — widened further from the previous cos(50°) so tilting the crosshair a
   *  bit won't drop the swing. Matches the PvP cone so the same input reliably hits
   *  whatever's in front of the player. */
  const ATTACK_CONE_COS = 0.5
  /** Point-blank forgiveness: targets with horizontal distance under this get an
   *  automatic dot=1 (cone bypass). Raised to 3.0 so a mob mid-bite at contact range is
   *  always hittable, even if its centre has clipped slightly past the player and the
   *  dot product went negative (user-reported: "ours to mobs is quite short, they have to
   *  come into our camera clipped to actually attack"). */
  const POINT_BLANK_XZ = 3.0
  const prevRemoteMelee = mc.fusTryRemoteMelee

  const findMobTargetInCone = () => {
    const pl = mc.player
    if (!pl) return null
    if (mobs.size === 0) return null
    /** Mirrors {@code PlayerEntity.getVectorForRotation}. */
    const yawRad = (pl.rotationYaw * Math.PI) / 180
    const pitchRad = (pl.rotationPitch * Math.PI) / 180
    const cosP = Math.cos(pitchRad)
    const dirX = Math.sin(yawRad) * cosP
    const dirY = -Math.sin(pitchRad)
    const dirZ = -Math.cos(yawRad) * cosP
    const eyeY = pl.y + 1.5

    let best = null
    let bestScore = -Infinity
    for (const m of mobs.values()) {
      if (!mobChunkLoadedAt(m)) continue
      if (m.hp <= 0) continue
      /** Deliberately ignore `m.mesh.visible` for visibility-bubble flicker; chunk gate above. */
      const dx = m.mesh.position.x - pl.x
      const dy = (m.mesh.position.y + (m.effectiveHeight || 1.9) * 0.5) - eyeY
      const dz = m.mesh.position.z - pl.z
      const distXZ = Math.hypot(dx, dz)
      const dist = Math.hypot(dx, dy, dz)
      if (dist > ATTACK_RANGE) continue
      let dot
      if (distXZ < POINT_BLANK_XZ) {
        dot = 1 /** Inside our body: force-pick regardless of aim. */
      } else {
        dot = (dx * dirX + dy * dirY + dz * dirZ) / (dist || 1)
        if (dot < ATTACK_CONE_COS) continue
      }
      /** Score: prefer closer + better-aimed. Scaling dot by range lets a well-aimed mob 4 m
       *  away beat a lightly-aimed one 1 m away, which matches "aim wins" player
       *  expectations. */
      const score = dot * 10 - dist
      if (score > bestScore) {
        bestScore = score
        best = m
      }
    }
    return best
  }

  const tryMelee = () => {
    /** Gate on death — player shouldn't be able to keep attacking after HP hits 0 while
     *  the death overlay is waiting for the respawn click. Pairs with the same guard in
     *  the player-combat chain and with the freeze in `fusDeathScreenInstall`. */
    if (typeof mc.fusIsDead === 'function' && mc.fusIsDead()) return false
    if (Number.isFinite(mc.fusSpawnInvulnUntilMs) && Date.now() < mc.fusSpawnInvulnUntilMs) {
      return false
    }

    const target = findMobTargetInCone()
    if (!target) return false

    const pl = mc.player
    try {
      pl?.swingArm?.()
    } catch {
      /* ignore */
    }
    /** Also tell the presence writer so peers see the arm arc whenever we swing at a mob —
     *  the engine's `swingProgressInt`-based inference misses the first click after hot
     *  reload. Safe no-op when the writer isn't installed. */
    try {
      mc.fusMarkSwing?.()
    } catch {
      /* ignore */
    }

    /** Unified fist/tool/level damage — same helper the PvP path uses so buffs that grow
     *  weapon damage automatically also grow PvE damage. Fist at L1 = 0.5 HP (one half-
     *  heart), spider has 8 HP → 16 punches; a wooden sword chops that to 4 hits. */
    const dmgHp = Math.max(MIN_DAMAGE_PER_HIT, fusPvePlayerDamageToMobHp(mc, target))

    try {
      mc.fusMarkCombatForRegen?.()
    } catch {
      /* ignore */
    }

    if (!multiplayer) {
      target.hp -= dmgHp
      target.lastHitUid = uid || ''
      flashHit(target)
      if (target.hp <= 0) {
        try {
          mc.fusPveBlockMobHitUntilMs = nowMs() + PVE_BLOCK_MOB_HIT_AFTER_KILL_MS
        } catch {
          /* ignore */
        }
        const killPos = {
          x: target.mesh.position.x,
          y: target.mesh.position.y,
          z: target.mesh.position.z,
        }
        const kType = target.typeId
        const kLv = target.level
        grantKillRewards(target)
        triggerDeathVfx(target)
        scheduleMobRespawnAfterKill(killPos, kType, kLv)
        window.setTimeout(() => removeMob(target, 'local-kill'), 30)
      }
      return true
    }

    /** Shared mode: push damage message; leader applies. Optimistic local flash + hp drop
     *  for feedback — the nametag's HP bar is the user's primary signal that a hit landed,
     *  so waiting for the RTDB round-trip makes the game feel broken on high-latency
     *  connections. The leader's authoritative {@link ingestRemoteRow} will overwrite our
     *  local `target.hp` with the real value on the next tick; we clamp to 0 so we don't
     *  briefly flicker negative. */
    flashHit(target)
    target.hp = Math.max(0, target.hp - dmgHp)
    target.lastHitUid = uid || ''
    const payload = {
      mobKey: target.id,
      fromUid: uid,
      dmgHalf: dmgHp,
      clientTs: nowMs(),
    }
    try {
      const newHit = dbPush(hitsRef)
      void dbSet(newHit, payload).catch((e) =>
        console.warn('[fusSimpleMobs] hit push failed', e),
      )
    } catch (e) {
      console.warn('[fusSimpleMobs] hit push failed', e)
    }
    /** If our optimistic predict says the mob is dead, fire the death VFX locally. The
     *  leader's subsequent `onChildRemoved` will just find the mob already torn down on
     *  our client and noop. */
    if (target.hp <= 0) {
      try {
        mc.fusPveBlockMobHitUntilMs = nowMs() + PVE_BLOCK_MOB_HIT_AFTER_KILL_MS
      } catch {
        /* ignore */
      }
      triggerDeathVfx(target)
    }
    return true
  }
  mc.fusTryRemoteMelee = tryMelee

  // ---------------------------------------------------------------------------
  //  AI + render frame.
  // ---------------------------------------------------------------------------

  /**
   * Pick the nearest live player that's a valid target for {@code mob} right now. Hysteresis:
   *   • idle → walk transition requires the target to be within `aggroR` (per-type) horizontally
   *     and {@link AGGRO_Y_MAX} vertically.
   *   • walk → idle transition uses the wider `AGGRO_DROP_R` (~20 m) leash so a player who
   *     dipped out of aggro range doesn't instantly de-aggro with a jitter.
   * Returning {@code null} means "go idle". Always considers the local player so solo play
   * works without remote avatars.
   */
  const nearestTargetFor = (mob) => {
    const engaged = mob.state === 'walk' || mob.state === 'attack'
    const maxR = engaged ? AGGRO_DROP_R : mob.aggroR
    const maxRSq = maxR * maxR
    let best = null
    let bestSq = maxRSq
    const inv = Number.isFinite(mc.fusSpawnInvulnUntilMs) && Date.now() < mc.fusSpawnInvulnUntilMs
    const localDead = typeof mc.fusIsDead === 'function' && mc.fusIsDead()
    eachPlayerPos((p) => {
      if (inv && p.self) return
      if (localDead && p.self) return
      const dx = p.x - mob.mesh.position.x
      const dy = p.y - mob.mesh.position.y
      const dz = p.z - mob.mesh.position.z
      if (Math.abs(dy) > AGGRO_Y_MAX) return
      const d2 = dx * dx + dz * dz
      if (d2 <= bestSq) {
        bestSq = d2
        best = { ...p, dist: Math.sqrt(d2), dy }
      }
    })
    return best
  }

  /**
   * One full attack swing: speed up long GLB clips toward {@link TARGET_ATTACK_WALL_SEC},
   * schedule the next allowed player hit for the **end** of that clip (contact frame).
   */
  const playAttackAndScheduleNextHit = (mob) => {
    if (!mob.attackAction || !mob.attackClipDurationSec || mob.attackClipDurationSec <= 0) {
      if (mob.attackAction) {
        mob.attackAction.reset()
        mob.attackAction.setEffectiveWeight(1)
        mob.attackAction.timeScale = 1
        mob.attackAction.play()
      }
      mob.nextHitReadyMs = nowMs() + ATTACK_WINDUP_FALLBACK_MS
      return
    }
    const dur = mob.attackClipDurationSec
    const scale = Math.max(1, dur / TARGET_ATTACK_WALL_SEC)
    mob.attackAction.timeScale = scale
    mob.attackAction.reset()
    mob.attackAction.setEffectiveWeight(1)
    mob.attackAction.play()
    const wallMs = (dur / scale) * 1000
    mob.nextHitReadyMs = nowMs() + wallMs
  }

  /** Cross-fade helper — same as the original implementation. */
  const blendTo = (mob, role) => {
    if (mob.state === role) return
    const set = (action, weight) => {
      if (!action) return
      action.enabled = true
      action.setEffectiveWeight(weight)
    }
    if (role === 'walk') {
      set(mob.idleAction, 0)
      set(mob.walkAction, 1)
    } else if (role === 'idle') {
      set(mob.idleAction, 1)
      set(mob.walkAction, 0)
    } else if (role === 'attack') {
      if (mob.attackAction) {
        playAttackAndScheduleNextHit(mob)
      } else {
        set(mob.idleAction, 1)
        set(mob.walkAction, 0)
        mob.nextHitReadyMs = nowMs() + ATTACK_WINDUP_FALLBACK_MS
      }
    }
    mob.state = role
  }

  /** Sample interpolated pose at a given wall clock; null if the buffer is empty. */
  const samplePose = (buf, renderTimeMs) => {
    if (!buf || buf.length === 0) return null
    if (buf.length === 1) {
      const s = buf[0]
      return { x: s.x, y: s.y, z: s.z, ry: s.ry, state: s.state, moving: false }
    }
    for (let i = buf.length - 1; i >= 1; i--) {
      const b = buf[i]
      const a = buf[i - 1]
      if (renderTimeMs >= a.ts && renderTimeMs <= b.ts) {
        const span = Math.max(1, b.ts - a.ts)
        const t = (renderTimeMs - a.ts) / span
        const dx = b.x - a.x
        const dz = b.z - a.z
        const moving = dx * dx + dz * dz > 1e-4
        /** Shortest-arc angle lerp. */
        let dRy = ((b.ry - a.ry + 540) % 360) - 180
        return {
          x: a.x + (b.x - a.x) * t,
          y: a.y + (b.y - a.y) * t,
          z: a.z + (b.z - a.z) * t,
          ry: a.ry + dRy * t,
          state: b.state,
          moving,
        }
      }
    }
    const tail = buf[buf.length - 1]
    return { x: tail.x, y: tail.y, z: tail.z, ry: tail.ry, state: tail.state, moving: false }
  }

  /** Run the mob's AI step as leader. Mutates mesh transform + state in-place. */
  const leaderTickMob = (mob, dt) => {
    /** A mob whose hp has reached zero must not move, chase, or attack — even if the RTDB
     *  delete hasn't landed yet (~30 ms grace before {@link killMobShared}). Previously the
     *  leader kept ticking the walk/attack AI on a corpse, so observers saw the mob pivot
     *  toward the player and swing a final blow after its death burst. Freezing on hp<=0
     *  also prevents a stray optimistic-kill flicker from resetting the AI to walk when
     *  the leader briefly reinterprets a stale row. */
    if (mob.hp <= 0) {
      blendTo(mob, 'idle')
      return
    }
    {
      const ex2 = FLAG_SPAWN_EXCLUSION_R * FLAG_SPAWN_EXCLUSION_R
      const mpx = mob.mesh.position.x
      const mpz = mob.mesh.position.z
      if (distSqToLocalFlag(mpx, mpz) < ex2) {
        const np = findEjectFromLocalFlag()
        if (np) {
          mob.mesh.position.set(np.x, np.y, np.z)
          mob.targetY = np.y
        }
      }
    }
    const target = nearestTargetFor(mob)
    if (target) {
      const dx = target.x - mob.mesh.position.x
      const dz = target.z - mob.mesh.position.z
      const distXZ = Math.hypot(dx, dz)
      const absDy = Math.abs(target.dy)
      /** Melee must match on BOTH axes — a mob on the ground should NOT hit a player sitting
       *  on top of a 10-block pillar just because their XZ projection lines up. */
      const inMelee = distXZ < MELEE_RANGE && absDy < MELEE_Y_MAX
      if (inMelee) {
        mob.targetUid = target.uid || ''
        mob.mesh.rotation.y = Math.atan2(dx, dz)
        blendTo(mob, 'attack')
      } else {
        /** Chase: always walk toward the target while it's within the leash. `nearestTargetFor`
         *  already applied the engage/disengage radii so if we got a target here it's valid. */
        const nx = dx / (distXZ || 1)
        const nz = dz / (distXZ || 1)
        const step = mob.speed * 60 * dt
        mob.mesh.position.x += nx * step
        mob.mesh.position.z += nz * step
        mob.mesh.rotation.y = Math.atan2(nx, nz)
        mob.targetUid = target.uid || ''
        blendTo(mob, 'walk')
      }
    } else {
      mob.targetUid = ''
      blendTo(mob, 'idle')
    }

    /** Resolve ground relative to the mob's *current* altitude rather than "top of the
     *  column". Previous `groundYAt` used `world.getHeightAt` which returns the highest
     *  non-air y — for a mob walking under a tree that's the top of the leaves, so the
     *  mob would teleport onto the canopy (user-reported: "when chasing the player and
     *  walking under a tree, get teleport on top of the tree"). The cave case was the
     *  same bug (highest block over a cave = the surface). `walkableGroundYNear` looks
     *  at the mob's current y first, allows a 1-block auto-jump up, and otherwise
     *  falls up to 6 blocks toward solid floor. */
    const gy = walkableGroundYNear(
      mob.mesh.position.x,
      mob.mesh.position.z,
      mob.mesh.position.y,
    )
    if (gy != null) mob.targetY = gy
    mob.mesh.position.y += (mob.targetY - mob.mesh.position.y) * Math.min(1, dt * 12)
  }

  /**
   * Local-player damage: if any visible mob is in `state:attack` AND within {@link MELEE_RANGE}
   * of the local player AND its `targetUid` references us (or we're in local mode), subtract
   * the next strike after each hit — timed to the end of the attack animation.
   */
  const applyMobDamageToLocalPlayer = (now) => {
    const pl = mc.player
    if (!pl) return
    if (Number.isFinite(mc.fusSpawnInvulnUntilMs) && now < mc.fusSpawnInvulnUntilMs) return
    if (Number.isFinite(mc.fusPveBlockMobHitUntilMs) && now < mc.fusPveBlockMobHitUntilMs) return
    /** No further damage to the corpse — without this gate mobs that were mid-attack when
     *  the player died keep piling on hits, re-triggering the damage flash and making the
     *  death-screen feel buggy ("the red vignette never goes away"). */
    if (typeof mc.fusIsDead === 'function' && mc.fusIsDead()) return
    for (const mob of mobs.values()) {
      /** Dead mobs stop attacking the instant they die — otherwise a mid-attack mob keeps
       *  draining the player's HP after the killing
       *  blow. Mirrors the hp-gate in {@link leaderTickMob}. */
      if (mob.hp <= 0) continue
      if (mob.state !== 'attack') continue
      if (!mob.mesh.visible) continue
      if (multiplayer && mob.targetUid && mob.targetUid !== uid) continue
      const dx = mob.mesh.position.x - pl.x
      const dy = mob.mesh.position.y - pl.y
      const dz = mob.mesh.position.z - pl.z
      const dXZ = Math.hypot(dx, dz)
      /** Same horizontal + vertical gate as {@link leaderTickMob}'s melee check. A player 30
       *  blocks in the air above a mob was previously taking hits because we only measured
       *  XZ — the fix is a proper cylindrical check. */
      if (dXZ > MELEE_RANGE + 0.2) continue
      if (Math.abs(dy) > MELEE_Y_MAX) continue
      /** Hit only after the attack clip reaches its end (see {@link playAttackAndScheduleNextHit}). */
      if (now < (mob.nextHitReadyMs || 0)) continue
      mob.lastLocalHitMs = now
      const dmgHalf = fusPveMobDamageToPlayerHp(mob, mc)
      /** Feed the death-screen resolver BEFORE applying damage — if this blow is fatal the
       *  overlay needs a fresh record to attribute the kill to this mob. */
      try {
        mc.fusRecordDamageFrom?.({
          type: 'mob',
          name: mob.type?.displayName || mob.typeId || 'Моб',
        })
      } catch {
        /* ignore */
      }
      const beforeHp = typeof pl.health === 'number' ? pl.health : NaN
      try {
        if (typeof pl.takeHit === 'function') pl.takeHit(dmgHalf)
        else if (typeof pl.damageEntity === 'function') pl.damageEntity(null, dmgHalf)
        else if (typeof pl.attackEntityFrom === 'function')
          pl.attackEntityFrom({ source: 'mob' }, dmgHalf)
        else if (typeof pl.health === 'number') pl.health = Math.max(0, pl.health - dmgHalf)
      } catch {
        if (typeof pl.health === 'number') pl.health = Math.max(0, pl.health - dmgHalf)
      }
      /** Hit sparkle at the player's chest so damage reads visually even without a proper
       *  hurt overlay. Mirrors what PvP hits fire in {@link fusPlayerCombatInstall}. */
      try {
        mc.fusFxHit?.(pl.x, pl.y + 1.1, pl.z, { count: 6, spread: 0.3 })
      } catch {
        /* ignore */
      }
      /** Local death puff when the killing blow came from a mob. The player-combat module
       *  handles this path for PvP; mobs are local-only here. */
      if (
        Number.isFinite(beforeHp) &&
        beforeHp > 0 &&
        typeof pl.health === 'number' &&
        pl.health <= 0
      ) {
        try {
          mc.fusFxDeath?.(pl.x, pl.y + 1.0, pl.z, { count: 22, color: 0xdc2626, spread: 1.0 })
        } catch {
          /* ignore */
        }
      }
      /** Next impact lines up with the end of the next attack swing (faster timeScale on long GLBs). */
      if (mob.state === 'attack' && mob.hp > 0) {
        playAttackAndScheduleNextHit(mob)
      }
    }
  }

  /**
   * True when block data and feet Y agree on a standable floor. (We do not require GPU
   * tessellation: `Chunk#rebuild` clears the section group for frames and caused random
   * invisibility, especially at chunk boundaries.)
   */
  const mobFeetOnResolvedGround = (mob) => {
    const p = mob.mesh?.position
    if (!p || !Number.isFinite(p.y)) return false
    const gy = walkableGroundYNear(p.x, p.z, p.y, 3, 32)
    if (gy == null) return false
    return Math.abs(p.y - gy) < 2.1
  }

  /**
   * Hide the mesh until the column exists and the world renderer has marked the chunk
   * {@link Chunk#loaded} (inside the camera's render distance). Feet vs block ground are
   * handled in {@link mobFeetOnResolvedGround}.
   */
  const mobChunkLoadedAt = (mob) => {
    const w = mc.world
    if (!w || typeof w.chunkExists !== 'function') return false
    const bx = Math.floor(mob.mesh.position.x)
    const bz = Math.floor(mob.mesh.position.z)
    const cx = bx >> 4
    const cz = bz >> 4
    if (!w.chunkExists(cx, cz)) return false
    let chunk
    try {
      chunk = w.getChunkAt(cx, cz)
    } catch {
      return false
    }
    if (!chunk || !chunk.loaded) return false
    return true
  }

  /**
   * Close enough to try claiming leadership. Must cover the engine's view-distance chunk
   * square (same window as {@link fusLabyEntityInTerrainDrawWindow}): the old {@link getVisRange}
   * disc was smaller than the farthest in-square corner, so mobs in corners had no nearby leader.
   */
  const mobIsOursToClaim = (mob) => {
    const pl = mc.player
    if (!pl) return false
    const rd = getEngineViewDistance()
    const rMax = 16 * Math.SQRT2 * Math.max(0, rd - 0.4) + 6
    const rSq = rMax * rMax
    const dx = pl.x - mob.mesh.position.x
    const dz = pl.z - mob.mesh.position.z
    return dx * dx + dz * dz <= rSq
  }

  let prevTimeMs = performance.now()
  const _cameraWorldPos = new THREE.Vector3()
  const frame = () => {
    if (disposed) return
    const now = performance.now()
    const dt = Math.min(0.1, (now - prevTimeMs) / 1000)
    prevTimeMs = now
    const wall = nowMs()

    const pl = mc.player
    const frozen = !pl || mc.fusFrozen

    if (multiplayer && pl && deferredRemoteIngest.size) {
      for (const [dKey, dRow] of Array.from(deferredRemoteIngest.entries())) {
        const dx = Number(dRow.x)
        const dy = Number(dRow.y)
        const dz = Number(dRow.z)
        if (![dx, dy, dz].every(Number.isFinite)) continue
        if (!fusLabyIsWithinPlayerInterestXz(mc, dx, dz)) continue
        void ingestRemoteRow(dKey, dRow)
      }
    }

    /** Re-evaluate master every few seconds. Cheap. */
    isMaster = computeIsMaster()

    const renderTime = wall - INTERP_DELAY_MS

    /** Cache camera world pos once per frame for billboard calcs. */
    const cam = mc.worldRenderer?.camera
    if (cam && typeof cam.getWorldPosition === 'function') {
      cam.getWorldPosition(_cameraWorldPos)
    }

    for (const mob of mobs.values()) {
      /** Column has block data + engine "loaded" — used for AI ticks; do not tie this to
       *  chunk.group.visible or the draw window, or mobs freeze when only the draw cull hides them. */
      const chunkOk = mobChunkLoadedAt(mob)
      const p = mob.mesh.position
      const inAnim =
        pl &&
        Number.isFinite(p.x) &&
        Number.isFinite(p.z) &&
        fusLabyIsWithinAnimProcessRangeXz(mc, p.x, p.z)
      let renderVisible = false
      if (mob.hp > 0) {
        const renderRaw =
          chunkOk &&
          mobFeetOnResolvedGround(mob) &&
          fusLabyEntityInTerrainDrawWindow(mc, p.x, p.z)
        if (renderRaw) {
          mob._fusVisLastTrueAt = wall
        }
        const holdMs = getMobVisHoldMs()
        renderVisible =
          renderRaw ||
          (holdMs > 0 &&
            typeof mob._fusVisLastTrueAt === 'number' &&
            wall - mob._fusVisLastTrueAt < holdMs)
      } else {
        mob._fusVisLastTrueAt = undefined
      }
      mob.mesh.visible = renderVisible
      if (mob.nameMesh) mob.nameMesh.visible = renderVisible
      /** GLTF mixer time: only within ~20 m of the local player (see {@link fusLabyIsWithinAnimProcessRangeXz}). */
      if (renderVisible && inAnim) {
        mob.mixer?.update?.(dt)
      }

      /** Flash-expire: drop the red tint exactly at the stored timestamp so the flash
       *  duration is frame-rate independent. */
      if (inAnim && mob.flashUntilMs && wall >= mob.flashUntilMs) {
        mob.flashUntilMs = 0
        clearFlash(mob)
      }

      if (!multiplayer) {
        if (!frozen && chunkOk) leaderTickMob(mob, dt)
        continue
      }

      /** Shared mode. Branch on whether we lead this mob. */
      const leaseActive = mob.leaderUntil > wall - 500
      const weAreLeader = mob.leaderUid === uid && leaseActive

      if (weAreLeader) {
        if (mob.hp <= 0) {
          /**
           * While HP is zero the RTDB row should disappear — never drive leader writes/lease on a
           * corpse. Doing so (especially {@link refreshLeaderLease}) was pinning weak Android with
           * endless `worldMobs` traffic + listener churn if remove lagged or failed a frame.
           */
          void killMobShared(mob)
        } else if (!frozen && chunkOk) {
          leaderTickMob(mob, dt)
          void writeLeaderState(mob)
          void refreshLeaderLease(mob)
        }
      } else if (inAnim) {
        /** Observer: interpolate — but only while the mob is alive. A corpse should stay
         *  exactly where it died; the pose buffer still holds old walk samples and
         *  replaying them would drag the carcass around until `onChildRemoved` fires. */
        if (mob.hp > 0) {
          const pose = samplePose(mob.poseBuffer, renderTime)
          if (pose) {
            mob.mesh.position.x = pose.x
            mob.mesh.position.z = pose.z
            mob.mesh.rotation.y = (pose.ry * Math.PI) / 180
            blendTo(mob, pose.state === 'walk' || pose.state === 'attack' ? pose.state : 'idle')
            const gy = walkableGroundYNear(
              mob.mesh.position.x,
              mob.mesh.position.z,
              pose.y,
              3,
              32,
            )
            if (gy != null) mob.targetY = gy
            else if (Number.isFinite(pose.y)) mob.targetY = pose.y
            mob.mesh.position.y += (mob.targetY - mob.mesh.position.y) * Math.min(1, dt * 12)
          }
        } else {
          /** Clamp animations to idle-weight-0 so the attack clip doesn't finish its
           *  swing past death; mixer keeps ticking so particle-like sub-animations that
           *  decay naturally still look right. */
          blendTo(mob, 'idle')
        }
        /** Lease expired and this mob is in our bubble → try to take over. Skip for
         *  dead mobs — there's no point leading a corpse. */
        if (!leaseActive && mob.hp > 0 && mobIsOursToClaim(mob)) {
          void tryClaimLeadership(mob.id)
        }
      } else if (!leaseActive && mob.hp > 0 && mobIsOursToClaim(mob)) {
        void tryClaimLeadership(mob.id)
      }

      /** Nametag bookkeeping — only meaningful while the mob is in the render bubble. */
      if (renderVisible && inAnim && mob.nameMesh) {
        const mp = mob.mesh.position
        const h = typeof mob.effectiveHeight === 'number' ? mob.effectiveHeight : MOB_HEIGHT_TARGET
        mob.nameMesh.position.set(mp.x, mp.y + h + 0.35, mp.z)
        /** Yaw-only billboard so text never tilts. */
        if (cam) {
          const dx = _cameraWorldPos.x - mp.x
          const dz = _cameraWorldPos.z - mp.z
          mob.nameMesh.rotation.set(0, Math.atan2(dx, dz), 0)
        }
        redrawMobTag(mob)
      }
    }

    if (!frozen) applyMobDamageToLocalPlayer(wall)
  }
  /**
   * One animation pass per video frame, invoked from {@link WorldRenderer#render} so Laby
   * does not maintain a second rAF alongside {@link #fusWorldDropsTick} and the engine loop
   * (which was spiking main-thread work on low-end Android after intense combat).
   */
  mc.fusSimpleMobsFrameTick = frame

  // ---------------------------------------------------------------------------
  //  Bootstrap: subscribe (shared) + initial spawn top-up.
  // ---------------------------------------------------------------------------

  if (multiplayer) {
    subscribeInstances()
    subscribeHits()
  }

  /**
   * Enumerate {uid, x, y, z} for every player who should receive their own mob bubble:
   * our local player plus every live remote peer. Drops peers with a stale / missing
   * position. Used by both the spawn balancer and the despawn grace tracker.
   */
  const collectPlayerAnchors = () => {
    /** @type {Array<{uid: string, x: number, y: number, z: number}>} */
    const out = []
    eachPlayerPos((p) => {
      out.push({ uid: p.uid || '', x: p.x, y: p.y, z: p.z })
    })
    return out
  }

  /** Count live mobs within {@link BUBBLE_RADIUS} of each anchor. Returns a Map keyed by anchor
   *  index (not uid, since multiple peers could share the same stale uid). */
  const countMobsPerAnchor = (anchors) => {
    const r2 = BUBBLE_RADIUS * BUBBLE_RADIUS
    const counts = new Array(anchors.length).fill(0)
    for (const m of mobs.values()) {
      if (m.hp <= 0) continue
      const mp = m.mesh.position
      for (let i = 0; i < anchors.length; i++) {
        const a = anchors[i]
        const dx = a.x - mp.x
        const dz = a.z - mp.z
        if (dx * dx + dz * dz <= r2) counts[i]++
      }
    }
    return counts
  }

  /** Per-mob grace timer so transient out-of-range ticks don't auto-despawn. Populated by
   *  {@link despawnAbandonedMobs}, keyed by mob id. Cleared the moment a player comes back
   *  inside range. */
  const outOfRangeSinceMs = new Map()

  /**
   * Master-only: delete mobs that haven't had a player within {@link DESPAWN_RADIUS} for
   * {@link DESPAWN_GRACE_MS}. Dead mobs are left alone (the leader's kill path removes
   * them). Runs on the same cadence as spawn top-up.
   */
  const despawnAbandonedMobs = async () => {
    if (!multiplayer || !isMaster) return
    const anchors = collectPlayerAnchors()
    const r2 = DESPAWN_RADIUS * DESPAWN_RADIUS
    const now = nowMs()
    /** Snapshot ids — we mutate `mobs` during iteration via RTDB removes. */
    const ids = Array.from(mobs.keys())
    for (const id of ids) {
      const mob = mobs.get(id)
      if (!mob) continue
      if (mob.hp <= 0) {
        outOfRangeSinceMs.delete(id)
        continue
      }
      const mp = mob.mesh.position
      let nearest = Infinity
      for (const a of anchors) {
        const dx = a.x - mp.x
        const dz = a.z - mp.z
        const d2 = dx * dx + dz * dz
        if (d2 < nearest) nearest = d2
      }
      if (nearest <= r2) {
        outOfRangeSinceMs.delete(id)
        continue
      }
      const since = outOfRangeSinceMs.get(id) || now
      if (!outOfRangeSinceMs.has(id)) {
        outOfRangeSinceMs.set(id, now)
        continue
      }
      if (now - since < DESPAWN_GRACE_MS) continue
      outOfRangeSinceMs.delete(id)
      try {
        await dbRemove(dbRef(rtdb, `worldMobs/${worldId}/instances/${id}`))
      } catch (e) {
        console.warn('[fusSimpleMobs] despawn remove failed', id, e)
      }
    }
  }

  /**
   * Master-only: dynamic spawn balancer. For every player anchor whose bubble has fewer
   * than {@link MOBS_PER_PLAYER}, we try to add one mob per invocation (so spawns drip in
   * rather than burst). Respects the hard cap {@link MAX_TOTAL_MOBS}.
   */
  const topUpSpawns = async () => {
    if (disposed) return
    if (!multiplayer) {
      for (let i = 0; i < MOBS_PER_PLAYER && mobs.size < count; i++) {
        // eslint-disable-next-line no-await-in-loop
        await spawnOneLocal()
      }
      return
    }
    if (mobs.size >= MAX_TOTAL_MOBS) return
    const anchors = collectPlayerAnchors()
    if (anchors.length === 0) return
    const counts = countMobsPerAnchor(anchors)
    /**
     * Only the local client can validate spawn columns — heightmap reads need chunks loaded
     * on *this* machine. The old master-only path tried to place mobs for distant players
     * using the master’s empty terrain, so nothing spawned outside the master’s visit radius.
     */
    const myIdx = anchors.findIndex((a) => a.uid === uid)
    if (myIdx < 0) return
    const deficit = MOBS_PER_PLAYER - counts[myIdx]
    if (deficit <= 0) return
    const batch = Math.min(deficit, 5, Math.max(0, MAX_TOTAL_MOBS - mobs.size))
    for (let s = 0; s < batch; s++) {
      if (mobs.size >= MAX_TOTAL_MOBS) break
      // eslint-disable-next-line no-await-in-loop
      await spawnOneShared(anchors[myIdx])
    }
  }

  const initialSpawn = async () => {
    if (!multiplayer) {
      /** Local (offline) mode: fill the per-player bubble against our own position. */
      for (let i = 0; i < MOBS_PER_PLAYER && mobs.size < count; i++) {
        // eslint-disable-next-line no-await-in-loop
        await spawnOneLocal()
      }
      return
    }
    /** Give the RTDB subscription ~600 ms to hydrate any pre-existing mobs before the master
     *  decides there aren't enough and starts spawning — otherwise two tabs racing to pick
     *  master will each spawn the full batch. */
    window.setTimeout(() => {
      isMaster = computeIsMaster()
      void topUpSpawns()
    }, 600)
  }
  void initialSpawn()

  if (respawn) {
    respawnIv = window.setInterval(() => {
      if (disposed) return
      /** Re-evaluate master each tick so reconnects flip correctly. */
      isMaster = computeIsMaster()
      /** Despawn frees RTDB + local slots; run it *before* top-up or `mobs.size >=
       *  MAX_TOTAL_MOBS` can block the explorer even when every mob is thousands of
       *  blocks away (async remove hadn't landed yet in the same tick as top-up). */
      void (async () => {
        try {
          await despawnAbandonedMobs()
        } catch {
          /* ignore */
        }
        try {
          await topUpSpawns()
        } catch {
          /* ignore */
        }
      })()
    }, SPAWN_CHECK_MS)
  }

  // ---------------------------------------------------------------------------
  //  Dispose.
  // ---------------------------------------------------------------------------

  const dispose = () => {
    if (disposed) return
    disposed = true
    for (const t of killRespawnTimers) {
      try {
        clearTimeout(t)
      } catch {
        /* ignore */
      }
    }
    killRespawnTimers.clear()
    delete mc.fusSimpleMobsFrameTick
    if (respawnIv) {
      window.clearInterval(respawnIv)
      respawnIv = 0
    }
    for (const off1 of [offAdd, offChg, offRem, offHits]) {
      try {
        off1?.()
      } catch {
        /* ignore */
      }
    }
    if (instancesRef) {
      try {
        off(instancesRef)
      } catch {
        /* ignore */
      }
    }
    if (hitsRef) {
      try {
        off(hitsRef)
      } catch {
        /* ignore */
      }
    }
    for (const m of mobs.values()) {
      scene.remove(m.mesh)
      if (m.nameMesh) {
        try {
          scene.remove(m.nameMesh)
          m.nameMesh.material?.dispose?.()
          m.nameMesh.geometry?.dispose?.()
        } catch {
          /* ignore */
        }
      }
      try {
        m.nameTexture?.dispose?.()
      } catch {
        /* ignore */
      }
      try {
        m.mixer?.stopAllAction?.()
      } catch {
        /* ignore */
      }
      m.mesh.traverse((o) => {
        if (o.isMesh) {
          try {
            o.geometry?.dispose?.()
            const mats = Array.isArray(o.material) ? o.material : [o.material]
            for (const mm of mats) mm?.dispose?.()
          } catch {
            /* ignore */
          }
        }
      })
    }
    mobs.clear()
    mc.fusTryRemoteMelee = typeof prevRemoteMelee === 'function' ? prevRemoteMelee : null
    delete mc.fusSimpleMobs
  }
  mc.fusDisposeSimpleMobs = dispose

  return dispose
}
