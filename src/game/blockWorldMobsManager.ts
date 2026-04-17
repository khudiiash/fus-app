import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { LoopOnce, LoopRepeat } from 'three'
import type Terrain from '@/game/minebase/terrain'
import type { PresenceDoc } from '@/game/sharedWorldFirestore'
import {
  MOB_KIND_DEFS,
  pickAnimationClip,
  type MobKindId,
} from '@/game/blockWorldMobCatalog'
import {
  type MobStateDoc,
  type MobAnimNet,
  type MobCoinDropDoc,
  subscribeMobStates,
  subscribeMobCoinDrops,
  tryAcquireOrRenewMobLease,
  tryPublishMobDeathCoinDrops,
  writeMobStatesFullBatch,
  pushMobHitPlayer,
  resolveMobFeetY,
} from '@/game/blockWorldMobsRtdb'
import { PLAYER_EYE_HEIGHT } from '@/game/playerConstants'
import { spawnMobDeathPoofParticles } from '@/game/blockWorldParticles'
import { blockWorldAggressiveMobile, isLowPowerTouchDevice } from '@/game/minebase/utils'

const COIN_PICKUP_GLB_URL = new URL('./assets/coin.glb', import.meta.url).href

/** Real-time day cycle: same mob slot respawns one day after death. */
const RESPAWN_MS = 24 * 60 * 60 * 1000

let coinPickupTemplate: THREE.Group | null = null
let coinPickupTemplatePromise: Promise<void> | null = null

async function ensureCoinPickupTemplate(): Promise<void> {
  if (coinPickupTemplate) return
  if (!coinPickupTemplatePromise) {
    coinPickupTemplatePromise = (async () => {
      const gltf = await new GLTFLoader().loadAsync(COIN_PICKUP_GLB_URL)
      const model = gltf.scene.clone(true)
      model.updateMatrixWorld(true)
      const box0 = new THREE.Box3().setFromObject(model)
      const size = new THREE.Vector3()
      box0.getSize(size)
      const maxE = Math.max(size.x, size.y, size.z, 0.02)
      const target = coarsePointerForPerf() ? 0.46 : 0.56
      model.scale.setScalar(target / maxE)
      model.updateMatrixWorld(true)
      const box = new THREE.Box3().setFromObject(model)
      if (Number.isFinite(box.min.y)) {
        model.position.y -= box.min.y
      }
      const g = new THREE.Group()
      g.name = 'bw-coin-pickup-template'
      g.add(model)
      g.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.castShadow = false
          o.receiveShadow = false
          o.frustumCulled = true
        }
      })
      coinPickupTemplate = g
    })().catch((e) => {
      coinPickupTemplatePromise = null
      throw e
    })
  }
  await coinPickupTemplatePromise
}

export function disposeBlockWorldCoinPickupTemplate() {
  if (!coinPickupTemplate) {
    coinPickupTemplatePromise = null
    return
  }
  coinPickupTemplate.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.geometry?.dispose()
      const mats = Array.isArray(o.material) ? o.material : [o.material]
      for (const m of mats) m?.dispose?.()
    }
  })
  coinPickupTemplate = null
  coinPickupTemplatePromise = null
}

function cloneCoinPickupGroup(): THREE.Group {
  if (!coinPickupTemplate) return createGoldCoinGroupFallback()
  const g = coinPickupTemplate.clone(true)
  g.name = 'bw-coin-pickup'
  g.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.frustumCulled = true
    }
  })
  g.userData.disposeMobCoin = () => {
    g.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry?.dispose()
        const mats = Array.isArray(o.material) ? o.material : [o.material]
        for (const m of mats) m?.dispose?.()
      }
    })
  }
  return g
}
function coarsePointerForPerf(): boolean {
  if (typeof window === 'undefined') return false
  return (
    (navigator.maxTouchPoints || 0) > 0 ||
    (window.matchMedia?.('(pointer: coarse)').matches ?? false)
  )
}

/** Sim tick rate (authoritative); lower = fewer RTDB writes & less CPU. */
const MOB_SIM_DT_TARGET_MS = (() => {
  if (typeof window === 'undefined') return 300
  if (blockWorldAggressiveMobile()) return 520
  if (isLowPowerTouchDevice()) return 480
  return coarsePointerForPerf() ? 380 : 300
})()
/** Min interval between RTDB mob state flushes (throttle, not debounce). */
const MOB_NET_FLUSH_MS = (() => {
  if (typeof window === 'undefined') return 180
  if (blockWorldAggressiveMobile()) return 340
  if (isLowPowerTouchDevice()) return 290
  return coarsePointerForPerf() ? 220 : 180
})()
/** Lease heartbeat (RTDB transaction). */
const LEASE_CALL_MS = 1200
const ATTACK_ANIM_MS = 520
/** Deal RTDB damage this many ms after attack starts (near end of swing vs red flash at windup). */
const ATTACK_HIT_LAND_MS = Math.round(ATTACK_ANIM_MS * 0.82)
/** Spring toward network targets (reduces stepped motion from low sim/flush rates). */
const MOB_SPRING_STIFF = 48
const MOB_SPRING_DAMP = 15
/** Yaw smoothing (exponential), same idea as {@link RemotePlayersManager}. */
const MOB_ROT_SMOOTH = 16
const MOB_TELEPORT_SNAP_DIST = 22
/** Spawn mob GLB + mixer only when a player is this close horizontally (m, XZ). */
const MOB_VIS_SPAWN_HZ = 46
/** Drop mob visual when no player is within this horizontal distance (m) — wider than spawn to avoid thrash. */
const MOB_VIS_DESPAWN_HZ = 60
/** Max |ΔY| between mob feet and a player’s feet for visibility (m). */
const MOB_VIS_Y_MAX = 22
const MOB_HIT_FLASH_S = 0.28
const MOB_HIT_FLASH_RED = new THREE.Color(0xff1a1a)
/** Max yaw change per second (combat / chase / flee). */
const MOB_YAW_RATE_COMBAT = 3.6
/** Max yaw change per second while patrolling on the ring. */
const MOB_YAW_RATE_PATROL = 2.4
/** Min horizontal gap between mob feet and any player feet (meters) — keeps mobs from clipping the camera / body. */
const MOB_PLAYER_STANDOFF_H = 1.78
/** Fallback XZ half-extent (m) before the GLB bbox is known. */
const MOB_STANDOFF_HALF_XZ_FALLBACK = 0.58
const MOB_STANDOFF_ATTACK_FRAC = 0.5

const HP_BAR_CANVAS_W = 168
const HP_BAR_CANVAS_H = 30

function presenceFeet(p: PresenceDoc): THREE.Vector3 {
  return new THREE.Vector3(
    p.x,
    p.y - PLAYER_EYE_HEIGHT - 0.08,
    p.z,
  )
}

const _scratchLocalFeet = new THREE.Vector3()

function mobSeenByAnyPlayerCylinder(
  mx: number,
  my: number,
  mz: number,
  presence: Map<string, PresenceDoc>,
  localFeet: THREE.Vector3,
  hzMax: number,
  yMax: number,
): boolean {
  const hz2m = hzMax * hzMax
  const inCylinder = (fx: number, fy: number, fz: number) => {
    const dx = mx - fx
    const dz = mz - fz
    if (dx * dx + dz * dz > hz2m) return false
    return Math.abs(my - fy) <= yMax
  }
  if (
    inCylinder(localFeet.x, localFeet.y, localFeet.z)
  ) {
    return true
  }
  for (const p of presence.values()) {
    const ft = presenceFeet(p)
    if (inCylinder(ft.x, ft.y, ft.z)) return true
  }
  return false
}

function minStandoffHForMob(attackRange: number, mobHalfXZ: number) {
  const pad = Math.max(0, mobHalfXZ)
  return Math.max(
    MOB_PLAYER_STANDOFF_H + pad,
    attackRange * MOB_STANDOFF_ATTACK_FRAC + pad,
  )
}

/** Fallback if `coin.glb` fails to load. */
function createGoldCoinGroupFallback(): THREE.Group {
  const g = new THREE.Group()
  const coarse = coarsePointerForPerf()
  const segs = coarse ? 10 : 22
  const geo = new THREE.CylinderGeometry(0.2, 0.2, 0.045, segs)
  const mat = coarse
    ? new THREE.MeshBasicMaterial({ color: 0xffc14d })
    : new THREE.MeshStandardMaterial({
        color: 0xffc14d,
        metalness: 0.62,
        roughness: 0.34,
        emissive: new THREE.Color(0x4a2f00),
        emissiveIntensity: 0.32,
      })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.rotation.x = Math.PI / 2
  mesh.castShadow = false
  mesh.receiveShadow = false
  mesh.frustumCulled = true
  g.add(mesh)
  g.userData.disposeMobCoin = () => {
    geo.dispose()
    mat.dispose()
  }
  return g
}

/** Push mob horizontally so it stays outside every player’s personal space. */
function applyMobStandoffFromAllPlayers(
  m: MobStateDoc,
  presence: Map<string, PresenceDoc>,
  attackRange: number,
  mobHalfXZ: number,
) {
  const minH = minStandoffHForMob(attackRange, mobHalfXZ)
  for (let pass = 0; pass < 2; pass++) {
    for (const p of presence.values()) {
      const ft = presenceFeet(p)
      const dx = m.x - ft.x
      const dz = m.z - ft.z
      const d = Math.hypot(dx, dz)
      if (d >= minH || d < 1e-5) continue
      const nx = dx / d
      const nz = dz / d
      m.x = ft.x + nx * minH
      m.z = ft.z + nz * minH
    }
  }
}

function yawToward(fromX: number, fromZ: number, toX: number, toZ: number) {
  const dx = toX - fromX
  const dz = toZ - fromZ
  if (Math.abs(dx) + Math.abs(dz) < 1e-4) return 0
  return Math.atan2(dx, dz)
}

function unwrapAngleNear(reference: number, angle: number): number {
  let a = angle
  while (a - reference > Math.PI) a -= Math.PI * 2
  while (a - reference < -Math.PI) a += Math.PI * 2
  return a
}

function rotateYawToward(
  currentRy: number,
  desiredRy: number,
  maxStepRad: number,
): number {
  const t = unwrapAngleNear(currentRy, desiredRy)
  let d = t - currentRy
  if (d > Math.PI) d -= Math.PI * 2
  if (d < -Math.PI) d += Math.PI * 2
  if (d > maxStepRad) return currentRy + maxStepRad
  if (d < -maxStepRad) return currentRy - maxStepRad
  return t
}

type MobHpBar = {
  sprite: THREE.Sprite
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  tex: THREE.CanvasTexture
  mat: THREE.SpriteMaterial
}

function createMobHpBar(yAboveFeet: number): MobHpBar {
  const canvas = document.createElement('canvas')
  canvas.width = HP_BAR_CANVAS_W
  canvas.height = HP_BAR_CANVAS_H
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Mob HP bar canvas')
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthTest: true,
    depthWrite: false,
  })
  const sprite = new THREE.Sprite(mat)
  sprite.renderOrder = 48
  sprite.center.set(0.5, 0)
  sprite.scale.set(1.72, 0.3, 1)
  sprite.position.set(0, yAboveFeet, 0)
  return { sprite, canvas, ctx, tex, mat }
}

function paintMobHpBar(bar: MobHpBar, hp: number, hpMax: number) {
  const { ctx, canvas, tex } = bar
  const w = canvas.width
  const h = canvas.height
  const maxH = Math.max(1, Math.floor(hpMax))
  const cur = Math.max(0, Math.min(maxH, Math.floor(hp)))
  const frac = cur / maxH
  ctx.clearRect(0, 0, w, h)
  const pad = 3
  ctx.fillStyle = 'rgba(0,0,0,0.78)'
  ctx.fillRect(0, 0, w, h)
  ctx.strokeStyle = 'rgba(255,255,255,0.35)'
  ctx.lineWidth = 2
  ctx.strokeRect(1, 1, w - 2, h - 2)
  const innerW = w - pad * 2
  const innerH = h - pad * 2
  ctx.fillStyle = 'rgba(40,40,40,0.95)'
  ctx.fillRect(pad, pad, innerW, innerH)
  const fillW = Math.max(0, innerW * frac)
  ctx.fillStyle = frac < 0.22 ? '#dc2626' : frac < 0.45 ? '#f59e0b' : '#22c55e'
  ctx.fillRect(pad, pad, fillW, innerH)
  ctx.fillStyle = '#fff'
  ctx.font = 'bold 13px system-ui,Segoe UI,sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(`${cur} / ${maxH}`, w / 2, h / 2)
  tex.needsUpdate = true
}

type MobFlashMat = {
  mat: THREE.MeshStandardMaterial
  origEmissive: THREE.Color
  origEmissiveIntensity: number
}

type MobVisual = {
  root: THREE.Group
  model: THREE.Object3D
  mixer: THREE.AnimationMixer
  clips: {
    idle: THREE.AnimationClip | null
    walk: THREE.AnimationClip | null
    attack: THREE.AnimationClip | null
    death: THREE.AnimationClip | null
  }
  curAnim: MobAnimNet | ''
  activeAction: THREE.AnimationAction | null
  targetX: number
  targetY: number
  targetZ: number
  targetRy: number
  smoothRy: number
  interpInited: boolean
  velX: number
  velY: number
  velZ: number
  flashMats: MobFlashMat[]
  hitFlashRemain: number
  /** After a flash, restore emissive once when the timer reaches zero. */
  flashNeedsRestore: boolean
  lastHp: number
  hpBar: MobHpBar | null
  /** Last painted `hp/hpMax` key to avoid canvas redraw every frame. */
  hpBarPaintKey: string
  /** True after we have observed this mob alive at least once (avoids death poof on join-in to corpses). */
  seenAlive: boolean
  /** Local death presentation done (hide mesh / particles once). */
  deathPoofEmitted: boolean
}

type SimMem = {
  patrolAngle: number
  lastAttackMs: number
  fleeUntilMs: number
  lastWriteKey: string
  /** Wall-clock ms when a started melee should apply damage; 0 = none pending. */
  meleeHitAtMs: number
  meleeHitTargetUid: string | null
  meleeHitDmg: number
}

const gltfKindPromises = new Map<MobKindId, Promise<GLTF>>()

function loadMobGltf(kind: MobKindId): Promise<GLTF> {
  let p = gltfKindPromises.get(kind)
  if (!p) {
    const url = MOB_KIND_DEFS[kind].glbUrl
    p = new GLTFLoader().loadAsync(url)
    gltfKindPromises.set(kind, p)
  }
  return p
}

function alignModelFeetToOrigin(model: THREE.Object3D) {
  const box = new THREE.Box3().setFromObject(model)
  if (!Number.isFinite(box.min.y)) return
  model.position.y -= box.min.y
}

function collectFlashMaterials(model: THREE.Object3D): MobFlashMat[] {
  const out: MobFlashMat[] = []
  model.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return
    const mats = Array.isArray(o.material) ? o.material : [o.material]
    for (const m of mats) {
      if (m instanceof THREE.MeshStandardMaterial) {
        out.push({
          mat: m,
          origEmissive: m.emissive.clone(),
          origEmissiveIntensity: m.emissiveIntensity,
        })
      }
    }
  })
  return out
}

function pickClipsFromGltf(
  animations: THREE.AnimationClip[],
): MobVisual['clips'] {
  const list = animations.map((a) => ({ name: a.name }))
  const idleN = pickAnimationClip(list, ['idle', 'stand', 'wait', 'breath'])
  const walkN = pickAnimationClip(list, ['walk', 'run', 'move', 'patrol'])
  const attackN = pickAnimationClip(list, [
    'attack',
    'strike',
    'bite',
    'hit',
    'swing',
    'fight',
  ])
  const deathN = pickAnimationClip(list, ['death', 'die', 'dead'])
  const byName = (n: { name: string } | null) =>
    animations.find((c) => c.name === n?.name) ?? null
  return {
    idle: byName(idleN),
    walk: byName(walkN),
    attack: byName(attackN),
    death: byName(deathN),
  }
}

export class BlockWorldMobsManager {
  private scene: THREE.Scene
  private terrain: Terrain
  private worldId: string
  private localUid: string
  private unsub: (() => void) | null = null

  private net = new Map<string, MobStateDoc>()
  private visuals = new Map<string, MobVisual>()
  private simMem = new Map<string, SimMem>()
  private presence = new Map<string, PresenceDoc>()

  private simMobs = new Map<string, MobStateDoc>()
  private isLeaseHolder = false
  private accSim = 0
  private lastLeaseMs = 0

  private netVisualGen = 0

  private pendingNetWrites: Record<string, MobStateDoc> = {}
  private netFlushTimer: ReturnType<typeof setTimeout> | null = null
  private lastNetFlushMs = 0

  private lastMobHpSeen = new Map<string, number>()
  private coinUnsub: (() => void) | null = null
  private coinDrops = new Map<string, MobCoinDropDoc>()
  private coinRoots = new Map<string, THREE.Group>()
  private lastCoinPickupAt = 0
  private coinPickup: ((dropId: string) => Promise<number>) | null = null
  private animTick = 0
  /** In-flight {@link spawnVisualAsync} per mob id (avoid duplicate GLB loads). */
  private spawningIds = new Set<string>()
  /** Scaled GLB XZ half-extent at feet (used with {@link applyMobStandoffFromAllPlayers}). */
  private mobStandoffHalfXZ = new Map<string, number>()

  constructor(
    scene: THREE.Scene,
    terrain: Terrain,
    worldId: string,
    localUid: string,
  ) {
    this.scene = scene
    this.terrain = terrain
    this.worldId = worldId
    this.localUid = localUid
  }

  setPresenceMap(map: Map<string, PresenceDoc>) {
    this.presence = map
  }

  /** Firestore grant runs in the callback after a successful RTDB claim. */
  setCoinPickupHandler(fn: (dropId: string) => Promise<number>) {
    this.coinPickup = fn
  }

  private enqueueCoinPickup(dropId: string) {
    const fn = this.coinPickup
    if (!fn) return
    void fn(dropId).catch((e) => {
      console.warn('[BlockWorldMobs] coin pickup', e)
    })
  }

  async start(): Promise<void> {
    if (this.unsub) return
    try {
      await ensureCoinPickupTemplate()
    } catch (e) {
      console.warn('[BlockWorldMobs] coin.glb preload', e)
    }
    this.unsub = subscribeMobStates(this.worldId, (m) => {
      for (const [id, doc] of m) {
        const had = this.lastMobHpSeen.has(id)
        const prev = had ? (this.lastMobHpSeen.get(id) as number) : doc.hp
        if (had && prev > 0 && doc.hp <= 0 && doc.deadAt > 0) {
          void tryPublishMobDeathCoinDrops(
            this.worldId,
            id,
            doc,
            this.terrain,
          )
        }
        this.lastMobHpSeen.set(id, doc.hp)
      }
      for (const id of [...this.lastMobHpSeen.keys()]) {
        if (!m.has(id)) this.lastMobHpSeen.delete(id)
      }
      this.net = m
      if (!this.isLeaseHolder) {
        this.simMobs = new Map(m)
      }
      const gen = ++this.netVisualGen
      void this.ensureVisualsForNet(gen)
    })
    this.coinUnsub = subscribeMobCoinDrops(this.worldId, (map) => {
      this.syncCoinDropsFromNet(map)
    })
  }

  private disposeCoinDropById(id: string) {
    const g = this.coinRoots.get(id)
    if (!g) return
    this.scene.remove(g)
    const disp = g.userData.disposeMobCoin as (() => void) | undefined
    disp?.()
    this.coinRoots.delete(id)
    this.coinDrops.delete(id)
  }

  /**
   * Tear down this coin’s Three.js mesh as soon as we know the pickup succeeded locally,
   * instead of waiting for {@link subscribeMobCoinDrops} to deliver the claimed/removed snapshot.
   */
  removeCoinDropLocal(dropId: string) {
    this.disposeCoinDropById(dropId)
  }

  private syncCoinDropsFromNet(m: Map<string, MobCoinDropDoc>) {
    const next = new Set(m.keys())
    for (const [id, d] of m) {
      let g = this.coinRoots.get(id)
      if (!g) {
        g = cloneCoinPickupGroup()
        this.scene.add(g)
        this.coinRoots.set(id, g)
      }
      g.position.set(d.x, d.y, d.z)
      this.coinDrops.set(id, d)
    }
    for (const id of [...this.coinRoots.keys()]) {
      if (!next.has(id)) this.disposeCoinDropById(id)
    }
  }

  private updateCoinDrops(dt: number) {
    const t = Date.now()
    for (const g of this.coinRoots.values()) {
      g.rotation.y += dt * 1.35
    }
    if (!this.coinPickup || t - this.lastCoinPickupAt < 55) return
    const cam = this.terrain.camera
    const fx = cam.position.x
    const fy = cam.position.y - PLAYER_EYE_HEIGHT - 0.08
    const fz = cam.position.z
    let nearest: string | null = null
    let bestDh = 1.12
    for (const [id, d] of this.coinDrops) {
      const dh = Math.hypot(d.x - fx, d.z - fz)
      if (dh < bestDh && Math.abs(d.y - fy) < 1.45) {
        bestDh = dh
        nearest = id
      }
    }
    if (!nearest) return
    this.lastCoinPickupAt = t
    this.enqueueCoinPickup(nearest)
  }

  getRaycastRoots(): THREE.Object3D[] {
    return [...this.visuals.values()].map((v) => v.root)
  }

  private async ensureVisualsForNet(gen: number) {
    const seen = new Set<string>()
    for (const [id, doc] of this.net) {
      seen.add(id)
      const v = this.visuals.get(id)
      if (!v) continue
      if (gen !== this.netVisualGen) return
      this.setMobTargets(v, doc)
    }
    if (gen !== this.netVisualGen) return
    for (const id of [...this.visuals.keys()]) {
      if (!seen.has(id)) this.removeVisual(id)
    }
  }

  private fillLocalFeet(out: THREE.Vector3) {
    const cam = this.terrain.camera
    return out.set(
      cam.position.x,
      cam.position.y - PLAYER_EYE_HEIGHT - 0.08,
      cam.position.z,
    )
  }

  private pruneMobVisualsByVisibility(localFeet: THREE.Vector3) {
    for (const id of [...this.visuals.keys()]) {
      const doc = this.net.get(id)
      if (!doc) continue
      if (
        !mobSeenByAnyPlayerCylinder(
          doc.x,
          doc.y,
          doc.z,
          this.presence,
          localFeet,
          MOB_VIS_DESPAWN_HZ,
          MOB_VIS_Y_MAX,
        )
      ) {
        this.removeVisual(id)
      }
    }
  }

  private queueMobSpawnsWhenSeen(localFeet: THREE.Vector3) {
    for (const [id, doc] of this.net) {
      if (this.visuals.has(id) || this.spawningIds.has(id)) continue
      if (
        !mobSeenByAnyPlayerCylinder(
          doc.x,
          doc.y,
          doc.z,
          this.presence,
          localFeet,
          MOB_VIS_SPAWN_HZ,
          MOB_VIS_Y_MAX,
        )
      ) {
        continue
      }
      this.spawningIds.add(id)
      const netGen = this.netVisualGen
      void this.spawnVisualAsync(id, netGen)
    }
  }

  private async spawnVisualAsync(id: string, netGen: number) {
    try {
      if (this.visuals.has(id)) return
      let doc = this.net.get(id)
      if (!doc) return
      this.fillLocalFeet(_scratchLocalFeet)
      if (
        !mobSeenByAnyPlayerCylinder(
          doc.x,
          doc.y,
          doc.z,
          this.presence,
          _scratchLocalFeet,
          MOB_VIS_SPAWN_HZ,
          MOB_VIS_Y_MAX,
        )
      ) {
        return
      }
      let v: MobVisual
      try {
        v = await this.spawnVisual(id, doc)
      } catch (e) {
        console.warn('[BlockWorldMobs] spawn', id, e)
        return
      }
      if (netGen !== this.netVisualGen || !this.net.has(id)) {
        this.disposeMobVisualResources(v, id)
        return
      }
      doc = this.net.get(id)!
      this.fillLocalFeet(_scratchLocalFeet)
      if (
        !mobSeenByAnyPlayerCylinder(
          doc.x,
          doc.y,
          doc.z,
          this.presence,
          _scratchLocalFeet,
          MOB_VIS_SPAWN_HZ,
          MOB_VIS_Y_MAX,
        )
      ) {
        this.disposeMobVisualResources(v, id)
        return
      }
      if (this.visuals.has(id)) {
        this.disposeMobVisualResources(v, id)
        return
      }
      this.visuals.set(id, v)
      this.setMobTargets(v, doc)
    } finally {
      this.spawningIds.delete(id)
    }
  }

  private async spawnVisual(id: string, doc: MobStateDoc): Promise<MobVisual> {
    const gltf = await loadMobGltf(doc.kind)
    const model = gltf.scene.clone(true)
    const scale = MOB_KIND_DEFS[doc.kind].modelScale
    model.scale.setScalar(scale)
    alignModelFeetToOrigin(model)
    model.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.frustumCulled = true
        o.castShadow = false
        o.receiveShadow = false
      }
    })

    const root = new THREE.Group()
    root.name = `bw-mob-${id}`
    root.userData.blockWorldMobId = id
    root.add(model)

    const bbox = new THREE.Box3().setFromObject(model)
    const bboxSize = new THREE.Vector3()
    bbox.getSize(bboxSize)
    const halfXZ = Math.max(
      MOB_STANDOFF_HALF_XZ_FALLBACK,
      0.5 * Math.max(bboxSize.x, bboxSize.z) + 0.14,
    )
    this.mobStandoffHalfXZ.set(id, halfXZ)
    const modelTopY = Number.isFinite(bbox.max.y) ? bbox.max.y : bboxSize.y
    const h = Number.isFinite(bboxSize.y) ? Math.max(0.35, bboxSize.y) : 2
    const halfBar = 0.5 * 0.3
    const gapAboveHead = Math.max(
      0.58,
      0.1 * h + 0.42,
      0.055 * Math.max(bboxSize.x, bboxSize.z, h) + 0.5,
    )
    const hpBarY = modelTopY + gapAboveHead + halfBar * 0.35
    const hpBar = createMobHpBar(hpBarY)
    root.add(hpBar.sprite)
    paintMobHpBar(hpBar, doc.hp, doc.hpMax)
    const initialHpKey = `${doc.hp}\0${doc.hpMax}`

    const mixer = new THREE.AnimationMixer(model)
    const clips = pickClipsFromGltf(gltf.animations)

    this.scene.add(root)
    return {
      root,
      model,
      mixer,
      clips,
      curAnim: '',
      activeAction: null,
      targetX: 0,
      targetY: 0,
      targetZ: 0,
      targetRy: 0,
      smoothRy: 0,
      interpInited: false,
      velX: 0,
      velY: 0,
      velZ: 0,
      flashMats: collectFlashMaterials(model),
      hitFlashRemain: 0,
      flashNeedsRestore: false,
      lastHp: -1,
      hpBar,
      hpBarPaintKey: initialHpKey,
      seenAlive: false,
      deathPoofEmitted: false,
    }
  }

  private setMobTargets(v: MobVisual, doc: MobStateDoc) {
    const dead = doc.deadAt > 0 || doc.hp <= 0

    if (dead) {
      if (!v.deathPoofEmitted) {
        v.deathPoofEmitted = true
        v.model.visible = false
        if (v.hpBar) v.hpBar.sprite.visible = false
        v.mixer.stopAllAction()
        v.activeAction = null
        if (v.seenAlive) {
          spawnMobDeathPoofParticles(
            this.scene,
            new THREE.Vector3(doc.x, doc.y + 0.5, doc.z),
          )
        }
      }
      v.lastHp = doc.hp
      v.targetX = doc.x
      v.targetY = doc.y
      v.targetZ = doc.z
      v.targetRy = unwrapAngleNear(v.smoothRy, doc.ry)
      if (!v.interpInited) {
        v.root.position.set(doc.x, doc.y, doc.z)
        v.smoothRy = doc.ry
        v.root.rotation.y = v.smoothRy
        v.velX = 0
        v.velY = 0
        v.velZ = 0
        v.interpInited = true
      } else {
        const dx = doc.x - v.root.position.x
        const dy = doc.y - v.root.position.y
        const dz = doc.z - v.root.position.z
        if (Math.hypot(dx, dy, dz) > MOB_TELEPORT_SNAP_DIST) {
          v.root.position.set(doc.x, doc.y, doc.z)
          v.smoothRy = doc.ry
          v.root.rotation.y = v.smoothRy
          v.velX = 0
          v.velY = 0
          v.velZ = 0
        }
      }
      return
    }

    if (v.deathPoofEmitted) {
      v.deathPoofEmitted = false
      v.model.visible = true
      if (v.hpBar) {
        v.hpBar.sprite.visible = true
        v.hpBarPaintKey = `${doc.hp}\0${doc.hpMax}`
        paintMobHpBar(v.hpBar, doc.hp, doc.hpMax)
      }
    }
    v.seenAlive = true

    if (
      v.interpInited &&
      v.lastHp >= 0 &&
      doc.hp < v.lastHp &&
      v.flashMats.length > 0
    ) {
      v.hitFlashRemain = MOB_HIT_FLASH_S
      v.flashNeedsRestore = true
    }
    v.lastHp = doc.hp

    if (v.hpBar) {
      const paintKey = `${doc.hp}\0${doc.hpMax}`
      if (v.hpBarPaintKey !== paintKey) {
        v.hpBarPaintKey = paintKey
        paintMobHpBar(v.hpBar, doc.hp, doc.hpMax)
      }
    }

    v.targetX = doc.x
    v.targetY = doc.y
    v.targetZ = doc.z
    v.targetRy = unwrapAngleNear(v.smoothRy, doc.ry)
    this.playAnimIfNeeded(v, doc.anim)
    if (!v.interpInited) {
      v.root.position.set(doc.x, doc.y, doc.z)
      v.smoothRy = doc.ry
      v.root.rotation.y = v.smoothRy
      v.velX = 0
      v.velY = 0
      v.velZ = 0
      v.interpInited = true
      return
    }
    const dx = doc.x - v.root.position.x
    const dy = doc.y - v.root.position.y
    const dz = doc.z - v.root.position.z
    if (Math.hypot(dx, dy, dz) > MOB_TELEPORT_SNAP_DIST) {
      v.root.position.set(doc.x, doc.y, doc.z)
      v.smoothRy = doc.ry
      v.root.rotation.y = v.smoothRy
      v.velX = 0
      v.velY = 0
      v.velZ = 0
    }
  }

  private applyAuthorityTargets() {
    for (const [id, v] of this.visuals.entries()) {
      const doc = this.isLeaseHolder
        ? (this.simMobs.get(id) ?? this.net.get(id))
        : this.net.get(id)
      if (doc) this.setMobTargets(v, doc)
    }
  }

  private smoothMobVisuals(dt: number) {
    const dtSafe = Math.max(1e-4, dt)
    const kRot = 1 - Math.exp(-MOB_ROT_SMOOTH * dtSafe)
    const st = MOB_SPRING_STIFF
    const dm = MOB_SPRING_DAMP
    for (const v of this.visuals.values()) {
      if (!v.interpInited) continue
      const ex = v.targetX - v.root.position.x
      const ey = v.targetY - v.root.position.y
      const ez = v.targetZ - v.root.position.z
      v.velX += ex * st * dtSafe - v.velX * dm * dtSafe
      v.velY += ey * st * dtSafe - v.velY * dm * dtSafe
      v.velZ += ez * st * dtSafe - v.velZ * dm * dtSafe
      v.root.position.x += v.velX * dtSafe
      v.root.position.y += v.velY * dtSafe
      v.root.position.z += v.velZ * dtSafe
      v.smoothRy += (v.targetRy - v.smoothRy) * kRot
      v.root.rotation.y = v.smoothRy
    }
  }

  private updateHitFlash(dt: number) {
    for (const v of this.visuals.values()) {
      if (!v.flashMats.length) continue
      if (v.hitFlashRemain > 0) {
        v.hitFlashRemain = Math.max(0, v.hitFlashRemain - dt)
        const w =
          MOB_HIT_FLASH_S > 0 ? v.hitFlashRemain / MOB_HIT_FLASH_S : 0
        for (const f of v.flashMats) {
          f.mat.emissive.copy(f.origEmissive).lerp(MOB_HIT_FLASH_RED, 0.68 * w)
          f.mat.emissiveIntensity = f.origEmissiveIntensity + 1.35 * w
        }
      } else if (v.flashNeedsRestore) {
        v.flashNeedsRestore = false
        for (const f of v.flashMats) {
          f.mat.emissive.copy(f.origEmissive)
          f.mat.emissiveIntensity = f.origEmissiveIntensity
        }
      }
    }
  }

  private scheduleMobNetFlush(writes: Record<string, MobStateDoc>) {
    for (const [id, doc] of Object.entries(writes)) {
      this.pendingNetWrites[id] = doc
    }
    const now = Date.now()
    const flush = () => {
      this.netFlushTimer = null
      const batch = this.pendingNetWrites
      this.pendingNetWrites = {}
      if (Object.keys(batch).length === 0) return
      this.lastNetFlushMs = Date.now()
      void writeMobStatesFullBatch(this.worldId, batch).catch((e) => {
        console.warn('[BlockWorldMobs] batch write', e)
      })
    }
    if (now - this.lastNetFlushMs >= MOB_NET_FLUSH_MS) {
      flush()
      return
    }
    if (this.netFlushTimer != null) return
    const wait = Math.max(8, MOB_NET_FLUSH_MS - (now - this.lastNetFlushMs))
    this.netFlushTimer = setTimeout(flush, wait)
  }

  private playAnimIfNeeded(v: MobVisual, anim: MobAnimNet) {
    if (v.curAnim === anim) return
    v.curAnim = anim
    const clip =
      anim === 'idle'
        ? v.clips.idle
        : anim === 'walk'
          ? v.clips.walk
          : anim === 'attack'
            ? v.clips.attack
            : anim === 'death'
              ? v.clips.death
              : v.clips.idle
    if (!clip) {
      if (anim === 'death') v.mixer.stopAllAction()
      return
    }
    const prev = v.activeAction
    const next = v.mixer.clipAction(clip)
    next.reset()
    next.setEffectiveTimeScale(1)
    if (anim === 'attack' || anim === 'death') {
      next.setLoop(LoopOnce, 1)
      next.clampWhenFinished = anim === 'death'
    } else {
      next.setLoop(LoopRepeat, Infinity)
    }
    if (prev && prev !== next) prev.fadeOut(0.12)
    next.fadeIn(0.12).play()
    v.activeAction = next
  }

  /** Tear down a mob scene graph (registered or orphan after cancelled async spawn). */
  private disposeMobVisualResources(v: MobVisual, id: string) {
    v.activeAction = null
    v.mixer.stopAllAction()
    if (v.hpBar) {
      v.root.remove(v.hpBar.sprite)
      v.hpBar.tex.dispose()
      v.hpBar.mat.dispose()
      v.hpBar = null
    }
    this.scene.remove(v.root)
    v.root.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry?.dispose()
        const mats = Array.isArray(o.material) ? o.material : [o.material]
        for (const m of mats) m?.dispose?.()
      }
    })
    this.mobStandoffHalfXZ.delete(id)
  }

  private removeVisual(id: string) {
    const v = this.visuals.get(id)
    if (!v) return
    this.visuals.delete(id)
    this.disposeMobVisualResources(v, id)
  }

  update(dt: number) {
    const now = Date.now()
    this.animTick++
    this.fillLocalFeet(_scratchLocalFeet)
    this.pruneMobVisualsByVisibility(_scratchLocalFeet)
    this.queueMobSpawnsWhenSeen(_scratchLocalFeet)

    const cx = this.terrain.camera.position.x
    const cz = this.terrain.camera.position.z
    const farSq = 68 * 68
    const farAnimMask = blockWorldAggressiveMobile() ? 3 : 1
    for (const v of this.visuals.values()) {
      const dx = v.root.position.x - cx
      const dz = v.root.position.z - cz
      if (dx * dx + dz * dz > farSq && (this.animTick & farAnimMask) !== 0) {
        continue
      }
      v.mixer.update(dt)
    }

    if (now - this.lastLeaseMs >= LEASE_CALL_MS) {
      this.lastLeaseMs = now
      void this.tickLease(now)
    }
    this.accSim += dt * 1000
    if (this.accSim >= MOB_SIM_DT_TARGET_MS) {
      this.accSim -= MOB_SIM_DT_TARGET_MS
      this.accSim = Math.min(this.accSim, MOB_SIM_DT_TARGET_MS * 2)
      this.stepSimSync(now)
    }

    this.applyAuthorityTargets()
    this.smoothMobVisuals(dt)
    this.updateHitFlash(dt)
    this.updateCoinDrops(dt)
  }

  private async tickLease(now: number) {
    const ok = await tryAcquireOrRenewMobLease(this.worldId, this.localUid)
    const was = this.isLeaseHolder
    this.isLeaseHolder = ok
    if (ok && !was) {
      this.simMobs = new Map(this.net)
      for (const id of this.simMobs.keys()) {
        if (!this.simMem.has(id))
          this.simMem.set(id, {
            patrolAngle: Math.random() * Math.PI * 2,
            lastAttackMs: 0,
            fleeUntilMs: 0,
            lastWriteKey: '',
            meleeHitAtMs: 0,
            meleeHitTargetUid: null,
            meleeHitDmg: 0,
          })
      }
    }
  }

  private stepSimSync(now: number) {
    if (!this.isLeaseHolder) return
    if (this.simMobs.size === 0 && this.net.size > 0) {
      this.simMobs = new Map(this.net)
    }

    const writes: Record<string, MobStateDoc> = {}

    for (const [id, mob] of this.simMobs) {
      const def = MOB_KIND_DEFS[mob.kind]
      /** RTDB carries mob HP from all clients' `mobDamageFromPlayer` transactions — merge so sim flushes don't undo hits. */
      const nd = this.net.get(id)
      const merged =
        nd != null
          ? {
              ...mob,
              hp: nd.hp,
              hpMax: nd.hpMax,
              deadAt: nd.deadAt,
            }
          : { ...mob }
      let m = { ...merged }
      const mem =
        this.simMem.get(id) ??
        ({
          patrolAngle: Math.random() * Math.PI * 2,
          lastAttackMs: 0,
          fleeUntilMs: 0,
          lastWriteKey: '',
          meleeHitAtMs: 0,
          meleeHitTargetUid: null,
          meleeHitDmg: 0,
        } as SimMem)
      this.simMem.set(id, mem)

      if (m.deadAt > 0) {
        mem.meleeHitAtMs = 0
        mem.meleeHitTargetUid = null
        mem.meleeHitDmg = 0
        if (now - m.deadAt >= RESPAWN_MS) {
          const feetY = resolveMobFeetY(this.terrain, m.ax, m.az)
          m = {
            ...m,
            hp: m.hpMax,
            x: m.ax,
            z: m.az,
            y: feetY,
            ry: Math.random() * Math.PI * 2,
            anim: 'idle',
            deadAt: 0,
          }
        } else {
          m = { ...m, anim: 'death', hp: 0 }
        }
        const key = `${m.x.toFixed(1)}|${m.y.toFixed(1)}|${m.z.toFixed(1)}|${m.ry.toFixed(2)}|${m.anim}|${m.hp}|${m.deadAt}`
        if (key !== mem.lastWriteKey) {
          mem.lastWriteKey = key
          writes[id] = m
        }
        this.simMobs.set(id, m)
        continue
      }

      if (m.hp <= 0) {
        mem.meleeHitAtMs = 0
        mem.meleeHitTargetUid = null
        mem.meleeHitDmg = 0
        m = { ...m, deadAt: m.deadAt || now, anim: 'death', hp: 0 }
        const key = `${m.x.toFixed(1)}|${m.y.toFixed(1)}|${m.z.toFixed(1)}|${m.ry.toFixed(2)}|${m.anim}|${m.hp}|${m.deadAt}`
        if (key !== mem.lastWriteKey) {
          mem.lastWriteKey = key
          writes[id] = m
        }
        this.simMobs.set(id, m)
        continue
      }

      let bestUid: string | null = null
      let bestD = Infinity
      let bestFeet = new THREE.Vector3()
      for (const [uid, p] of this.presence) {
        const ft = presenceFeet(p)
        const dx = ft.x - m.x
        const dz = ft.z - m.z
        const d = Math.hypot(dx, dz)
        if (d < bestD) {
          bestD = d
          bestUid = uid
          bestFeet.copy(ft)
        }
      }

      const detect = def.detectRadius
      const aggroDetect = detect * (0.42 + def.aggro * 0.55)
      const armed =
        Boolean(bestUid) &&
        this.presence.get(bestUid!)?.bwHandMine === 'tool' &&
        (this.presence.get(bestUid!)?.playerHpHalfUnits ?? 99) > 0

      const playerDistFromAnchor =
        bestUid != null
          ? Math.hypot(bestFeet.x - m.ax, bestFeet.z - m.az)
          : Infinity
      /**
       * Soft leash from patrol anchor (reduces whole-map trains). Once the player is actually
       * near this mob, keep chasing even if they ran far from the anchor (no hit‑and‑retreat exploit).
       */
      const territorialAggroLimit = Math.max(
        52,
        def.patrolRadius + def.detectRadius * 1.75 + 8,
      )
      const chaseWhileEngaged =
        bestUid != null &&
        bestD <= Math.max(def.detectRadius * 2.25, def.attackRange * 4.5)
      const territorialOk =
        bestUid == null ||
        playerDistFromAnchor <= territorialAggroLimit ||
        chaseWhileEngaged

      let flee =
        mem.fleeUntilMs > now ||
        (bestUid &&
          territorialOk &&
          bestD < detect * 0.55 &&
          armed &&
          def.cowardice > 0.22 &&
          m.hp < m.hpMax * (0.35 + def.cowardice * 0.25))

      if (mem.meleeHitAtMs > 0 && now < mem.meleeHitAtMs) {
        const tgt = mem.meleeHitTargetUid
        if (
          !tgt ||
          tgt !== bestUid ||
          !bestUid ||
          bestD > def.attackRange * 1.08
        ) {
          mem.meleeHitAtMs = 0
          mem.meleeHitTargetUid = null
          mem.meleeHitDmg = 0
        }
      }

      const dtSim = MOB_SIM_DT_TARGET_MS / 1000
      const yawCombat = MOB_YAW_RATE_COMBAT * dtSim
      const yawPatrol = MOB_YAW_RATE_PATROL * dtSim

      if (flee && bestUid && territorialOk) {
        mem.meleeHitAtMs = 0
        mem.meleeHitTargetUid = null
        mem.meleeHitDmg = 0
        mem.fleeUntilMs = Math.max(mem.fleeUntilMs, now + 1600)
        const dx = m.x - bestFeet.x
        const dz = m.z - bestFeet.z
        const len = Math.hypot(dx, dz) || 1
        const sp = def.moveSpeed * 1.15 * dtSim
        m.x += (dx / len) * sp
        m.z += (dz / len) * sp
        const want =
          yawToward(m.x, m.z, bestFeet.x, bestFeet.z) + Math.PI
        m.ry = rotateYawToward(m.ry, want, yawCombat)
        m.anim = 'walk'
      } else if (bestUid && bestD < aggroDetect && territorialOk) {
        const dx = bestFeet.x - m.x
        const dz = bestFeet.z - m.z
        const len = Math.hypot(dx, dz) || 1
        if (bestD > def.attackRange * 0.92) {
          const sp = def.moveSpeed * dtSim
          m.x += (dx / len) * sp
          m.z += (dz / len) * sp
          const want = yawToward(m.x, m.z, bestFeet.x, bestFeet.z)
          m.ry = rotateYawToward(m.ry, want, yawCombat)
          m.anim = 'walk'
        } else {
          const want = yawToward(m.x, m.z, bestFeet.x, bestFeet.z)
          m.ry = rotateYawToward(m.ry, want, yawCombat)
          if (now - mem.lastAttackMs >= def.attackCooldownMs && bestUid) {
            mem.lastAttackMs = now
            m.anim = 'attack'
            mem.fleeUntilMs = 0
            mem.meleeHitAtMs = now + ATTACK_HIT_LAND_MS
            mem.meleeHitTargetUid = bestUid
            mem.meleeHitDmg = def.attackDamageHalf
          } else {
            m.anim = bestD > def.attackRange * 0.5 ? 'walk' : 'idle'
          }
        }
      } else {
        mem.meleeHitAtMs = 0
        mem.meleeHitTargetUid = null
        mem.meleeHitDmg = 0
        const R = def.patrolRadius
        const ox = m.x - m.ax
        const oz = m.z - m.az
        const curR = Math.hypot(ox, oz)
        if (Math.abs(curR - R) > 0.55) {
          const tx = m.ax + (ox / (curR || 1)) * R
          const tz = m.az + (oz / (curR || 1)) * R
          const dx = tx - m.x
          const dz = tz - m.z
          const len = Math.hypot(dx, dz) || 1
          const sp = def.moveSpeed * 0.48 * dtSim
          m.x += (dx / len) * sp
          m.z += (dz / len) * sp
          const want = yawToward(m.x, m.z, tx, tz)
          m.ry = rotateYawToward(m.ry, want, yawPatrol)
          mem.patrolAngle = Math.atan2(m.z - m.az, m.x - m.ax)
          m.anim = 'walk'
        } else {
          mem.patrolAngle += (def.moveSpeed * 0.52 * dtSim) / Math.max(0.35, R)
          m.x = m.ax + Math.cos(mem.patrolAngle) * R
          m.z = m.az + Math.sin(mem.patrolAngle) * R
          const want = Math.atan2(
            -Math.sin(mem.patrolAngle),
            Math.cos(mem.patrolAngle),
          )
          m.ry = rotateYawToward(m.ry, want, yawPatrol)
          m.anim = 'walk'
        }
      }

      const halfXZ =
        this.mobStandoffHalfXZ.get(id) ?? MOB_STANDOFF_HALF_XZ_FALLBACK
      applyMobStandoffFromAllPlayers(m, this.presence, def.attackRange, halfXZ)

      m.y = resolveMobFeetY(this.terrain, m.x, m.z)

      if (mem.meleeHitAtMs > 0 && now >= mem.meleeHitAtMs) {
        const tgt = mem.meleeHitTargetUid
        const dmg = mem.meleeHitDmg
        mem.meleeHitAtMs = 0
        mem.meleeHitTargetUid = null
        mem.meleeHitDmg = 0
        if (tgt && dmg > 0) {
          const pDoc = this.presence.get(tgt)
          if (pDoc) {
            const ft = presenceFeet(pDoc)
            const dHit = Math.hypot(ft.x - m.x, ft.z - m.z)
            if (dHit <= def.attackRange * 1.06) {
              void pushMobHitPlayer(this.worldId, id, tgt, dmg)
            }
          }
        }
      }

      if (
        mem.lastAttackMs > 0 &&
        now - mem.lastAttackMs < ATTACK_ANIM_MS
      ) {
        m.anim = 'attack'
      }

      const key = `${m.x.toFixed(1)}|${m.y.toFixed(1)}|${m.z.toFixed(1)}|${m.ry.toFixed(2)}|${m.anim}|${m.hp}|${m.deadAt}`
      if (key !== mem.lastWriteKey) {
        mem.lastWriteKey = key
        writes[id] = m
      }
      this.simMobs.set(id, m)
    }

    if (Object.keys(writes).length > 0) {
      this.scheduleMobNetFlush(writes)
    }
  }

  dispose() {
    if (this.netFlushTimer != null) {
      clearTimeout(this.netFlushTimer)
      this.netFlushTimer = null
    }
    if (Object.keys(this.pendingNetWrites).length > 0) {
      const batch = this.pendingNetWrites
      this.pendingNetWrites = {}
      void writeMobStatesFullBatch(this.worldId, batch).catch(() => {})
    }
    this.coinUnsub?.()
    this.coinUnsub = null
    for (const g of this.coinRoots.values()) {
      this.scene.remove(g)
      const disp = g.userData.disposeMobCoin as (() => void) | undefined
      disp?.()
    }
    this.coinRoots.clear()
    this.coinDrops.clear()
    this.coinPickup = null
    disposeBlockWorldCoinPickupTemplate()
    this.lastMobHpSeen.clear()
    this.mobStandoffHalfXZ.clear()
    this.unsub?.()
    this.unsub = null
    this.spawningIds.clear()
    for (const id of [...this.visuals.keys()]) this.removeVisual(id)
    this.visuals.clear()
    this.simMem.clear()
    this.simMobs.clear()
    this.net.clear()
  }
}
