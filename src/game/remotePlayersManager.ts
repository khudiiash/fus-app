import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { PlayerObject } from '@/assets/minecraft-character/model.js'
import { IdleAnimation, WalkingAnimation } from '@/assets/minecraft-character/animation.js'
import { createPlayerSkinViewerShim } from './createPlayerSkinViewerShim.js'
import { loadRemoteSkinForViewer } from '@/utils/loadRemoteSkinForViewer'
import { normalizeSkinUrlForPresence } from '@/utils/presenceSkinUrl'
import type { PresenceDoc } from './sharedWorldFirestore'
import { PLAYER_EYE_HEIGHT } from '@/game/playerConstants'
import type Terrain from './minebase/terrain'
import { BlockType } from './minebase/terrain'
import { TOOL_HOTBAR_INDEX } from './minebase/control'
import {
  applyHandHeldLightingLift,
  applySrgbColorMaps,
  configureRemoteToolMaterials,
  flipToolRootWindingX,
  orientPickaxeForRemoteTemplate,
  REMOTE_TOOL_MAX_DIM,
  scaleGltfToMaxDimension,
} from './toolGltfUtils'

const REMOTE_TOOL_MODEL_URL = new URL('./assets/minecraft_tool.glb', import.meta.url)
  .href

/** Same order as Control hotbar block slots 0–6. */
const REMOTE_BLOCK_TYPES: BlockType[] = [
  BlockType.grass,
  BlockType.stone,
  BlockType.tree,
  BlockType.wood,
  BlockType.diamond,
  BlockType.quartz,
  BlockType.glass,
]

let remoteToolTemplate: THREE.Object3D | null = null
let remoteToolLoadPromise: Promise<void> | null = null

async function ensureRemoteToolTemplate(): Promise<THREE.Object3D | null> {
  if (remoteToolTemplate) return remoteToolTemplate
  if (!remoteToolLoadPromise) {
    remoteToolLoadPromise = (async () => {
      try {
        const gltf = await new GLTFLoader().loadAsync(REMOTE_TOOL_MODEL_URL)
        const root = gltf.scene
        scaleGltfToMaxDimension(root, REMOTE_TOOL_MAX_DIM)
        orientPickaxeForRemoteTemplate(root)
        flipToolRootWindingX(root)
        configureRemoteToolMaterials(root)
        remoteToolTemplate = root
      } catch (e) {
        console.warn('[RemotePlayers] tool GLB', e)
      }
    })()
  }
  await remoteToolLoadPromise
  return remoteToolTemplate
}

function blockTypeFromPresenceSlot(slot: number): BlockType {
  if (slot >= 0 && slot < TOOL_HOTBAR_INDEX) {
    return REMOTE_BLOCK_TYPES[slot] ?? BlockType.grass
  }
  return REMOTE_BLOCK_TYPES[0]
}

/** Small lift so scaled skin feet clear voxel tops (network Y is sender eye). */
const FEET_Y_OFFSET = 0.12
/**
 * Match remote rig height to local first-person scale (camera uses PLAYER_EYE_HEIGHT).
 * Native skin rig ~24 world units tall at scale 1 (empirical for this asset).
 */
const REMOTE_NATIVE_HEIGHT = 24.5
const MODEL_SCALE = (PLAYER_EYE_HEIGHT + 0.12) / REMOTE_NATIVE_HEIGHT
/** World-space height of scaled rig (used for vertical offset). */
const REMOTE_WORLD_HEIGHT = REMOTE_NATIVE_HEIGHT * MODEL_SCALE
/** Snap teleport if network correction is huge (respawn / bad packet). */
const TELEPORT_DIST = 28
/** Position smoothing (higher → catches sparse network presence updates faster). */
const POS_SMOOTH = 22
const ROT_SMOOTH = 18

/** Shift angle by multiples of 2π so it lies within π of `reference` (smooth yaw interpolation, no long spins). */
function unwrapAngleNear(reference: number, angle: number): number {
  let a = angle
  while (a - reference > Math.PI) a -= Math.PI * 2
  while (a - reference < -Math.PI) a += Math.PI * 2
  return a
}

function purpleFallbackCanvas() {
  const c = document.createElement('canvas')
  c.width = 64
  c.height = 64
  const ctx = c.getContext('2d')
  if (ctx) {
    ctx.fillStyle = '#7c3aed'
    ctx.fillRect(0, 0, 64, 64)
  }
  return c
}

/** Minecraft skin atlas: front of head (64×64 or 128×128). */
function drawSkinHeadOnCircle(
  ctx: CanvasRenderingContext2D,
  skin: HTMLCanvasElement,
  cx: number,
  cy: number,
  radius: number,
) {
  const w = skin.width
  const m = w >= 96 ? 2 : 1
  const sx = 8 * m
  const sy = 8 * m
  const sw = 8 * m
  const sh = 8 * m
  ctx.save()
  ctx.beginPath()
  ctx.arc(cx, cy, radius, 0, Math.PI * 2)
  ctx.clip()
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(skin, sx, sy, sw, sh, cx - radius, cy - radius, radius * 2, radius * 2)
  ctx.restore()
}

function drawPhotoCoverInCircle(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement | HTMLCanvasElement,
  cx: number,
  cy: number,
  radius: number,
) {
  ctx.save()
  ctx.beginPath()
  ctx.arc(cx, cy, radius, 0, Math.PI * 2)
  ctx.clip()
  const iw = img.width
  const ih = img.height
  if (iw < 1 || ih < 1) {
    ctx.restore()
    return
  }
  const cover = Math.max((radius * 2) / iw, (radius * 2) / ih)
  const w = iw * cover
  const h = ih * cover
  ctx.imageSmoothingEnabled = true
  ctx.drawImage(img, cx - w / 2, cy - h / 2, w, h)
  ctx.restore()
}

function createPlayerNameLabel(initialName: string) {
  const mat = new THREE.SpriteMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: false,
  })
  const sprite = new THREE.Sprite(mat)
  sprite.position.set(0, 2.18, 0)
  sprite.renderOrder = 1000

  let currentName = initialName
  let skinFaceSource: HTMLCanvasElement | null = null
  let profilePhotoUrl: string | null = null
  let profilePhotoImg: HTMLImageElement | null = null
  let photoLoadToken = 0
  let lastPaintSig = ''

  const paint = () => {
    const display =
      (currentName || 'Гравець').trim().slice(0, 24) || 'Гравець'
    const skinKey = skinFaceSource ? `${skinFaceSource.width}x${skinFaceSource.height}` : '0'
    const sig = `${display}\0${skinKey}\0${profilePhotoUrl || ''}\0${profilePhotoImg ? '1' : '0'}`
    if (sig === lastPaintSig && mat.map) return
    lastPaintSig = sig
    if (mat.map) {
      mat.map.dispose()
      mat.map = null
    }
    const c = document.createElement('canvas')
    const ctx = c.getContext('2d')
    if (!ctx) return

    const letter = display.charAt(0).toUpperCase()
    const hue =
      display.split('').reduce((a, ch) => a + ch.charCodeAt(0), 0) % 360
    const centerY = 64
    const avatarR = 40
    const gap = 16
    ctx.font = 'bold 34px system-ui, "Segoe UI", Ubuntu, sans-serif'
    const tw = Math.min(ctx.measureText(display).width + 28, 500)
    const contentW = avatarR * 2 + gap + tw
    const canvasW = Math.ceil(Math.max(320, contentW + 56))
    c.width = canvasW
    c.height = 128
    const cx = canvasW / 2
    const left = cx - contentW / 2
    const avatarCx = left + avatarR
    const pillLeft = left + avatarR * 2 + gap

    let drewAvatar = false
    if (profilePhotoImg && profilePhotoImg.complete && profilePhotoImg.naturalWidth > 0) {
      try {
        drawPhotoCoverInCircle(ctx, profilePhotoImg, avatarCx, centerY, avatarR)
        drewAvatar = true
      } catch {
        drewAvatar = false
      }
    }
    if (!drewAvatar && skinFaceSource && skinFaceSource.width >= 8) {
      try {
        drawSkinHeadOnCircle(ctx, skinFaceSource, avatarCx, centerY, avatarR)
        drewAvatar = true
      } catch {
        drewAvatar = false
      }
    }
    if (!drewAvatar) {
      ctx.fillStyle = `hsl(${hue}, 62%, 42%)`
      ctx.beginPath()
      ctx.arc(avatarCx, centerY, avatarR, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = 'rgba(255,255,255,0.35)'
      ctx.lineWidth = 4
      ctx.stroke()
      ctx.fillStyle = '#fff'
      ctx.font = 'bold 48px system-ui, "Segoe UI", Ubuntu, sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(letter, avatarCx, centerY + 2)
    } else {
      ctx.strokeStyle = 'rgba(255,255,255,0.35)'
      ctx.lineWidth = 4
      ctx.beginPath()
      ctx.arc(avatarCx, centerY, avatarR, 0, Math.PI * 2)
      ctx.stroke()
    }

    ctx.fillStyle = 'rgba(0,0,0,0.75)'
    const rx = pillLeft - 14
    const ry = centerY - 44
    const rw = tw
    const rh = 88
    const rr = 14
    if (typeof ctx.roundRect === 'function') {
      ctx.beginPath()
      ctx.roundRect(rx, ry, rw, rh, rr)
      ctx.fill()
    } else {
      ctx.fillRect(rx, ry, rw, rh)
    }
    ctx.fillStyle = '#f1f5f9'
    ctx.font = 'bold 34px system-ui, "Segoe UI", Ubuntu, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(display, pillLeft + tw / 2 - 14, centerY)

    const tex = new THREE.CanvasTexture(c)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.minFilter = THREE.LinearFilter
    tex.magFilter = THREE.LinearFilter
    mat.map = tex
    mat.needsUpdate = true
    const aspect = c.width / c.height
    const h = 0.5
    sprite.scale.set(h * aspect, h, 1)
  }

  paint()
  return {
    sprite,
    setName(raw: string) {
      currentName = raw || 'Гравець'
      lastPaintSig = ''
      paint()
    },
    setSkinFace(source: HTMLCanvasElement | null) {
      skinFaceSource = source
      lastPaintSig = ''
      paint()
    },
    setProfilePhotoUrl(url: string | null) {
      profilePhotoUrl = url
      profilePhotoImg = null
      photoLoadToken++
      lastPaintSig = ''
      if (!url) {
        paint()
        return
      }
      const token = photoLoadToken
      const im = new Image()
      im.crossOrigin = 'anonymous'
      im.onload = () => {
        if (token !== photoLoadToken) return
        profilePhotoImg = im
        lastPaintSig = ''
        paint()
      }
      im.onerror = () => {
        if (token !== photoLoadToken) return
        profilePhotoImg = null
        lastPaintSig = ''
        paint()
      }
      im.src = url
    },
    dispose() {
      if (mat.map) {
        mat.map.dispose()
        mat.map = null
      }
      mat.dispose()
    },
  }
}

type Entry = {
  root: THREE.Group
  playerObject: PlayerObject
  idle: IdleAnimation
  walk: WalkingAnimation
  current: IdleAnimation | WalkingAnimation
  skinShim: ReturnType<typeof createPlayerSkinViewerShim>
  nameLabel: ReturnType<typeof createPlayerNameLabel>
  lastMoving: boolean
  targetX: number
  targetY: number
  targetZ: number
  targetRy: number
  /** Smoothed display yaw (can exceed ±π; stays continuous for interpolation). */
  smoothRy: number
  netMoving: boolean
  lx: number
  lz: number
  animBlend: number
  lastSkinUrl: string | null | undefined
  lastDisplayName: string
  lastProfilePhotoUrl: string
  handGroup: THREE.Group
  /** Pivot between arm and item mesh — animated on remote swing. */
  handSwingPivot: THREE.Group
  lastHandMode: 'mine' | 'build'
  lastHandSlot: number
  /** Last applied {@link PresenceDoc.handSwingSeq}; -1 = uninitialized (skip first-frame swing). */
  lastRemoteSwingSeq: number
  handSwingPhase: number
  /**
   * Bumped on each {@link refreshRemoteHand} start so a slower in-flight tool GLB load
   * cannot add the pickaxe after a newer refresh already showed a block (and vice versa).
   */
  handRefreshGen: number
}

export class RemotePlayersManager {
  private scene: THREE.Scene
  private localUid: string
  private terrain: Terrain
  private players = new Map<string, Entry>()
  private tmpV = new THREE.Vector3()

  constructor(scene: THREE.Scene, localUid: string, terrain: Terrain) {
    this.scene = scene
    this.localUid = localUid
    this.terrain = terrain
  }

  private spawn(uid: string): Entry {
    const root = new THREE.Group()
    root.name = `remote-player-${uid}`
    const playerObject = new PlayerObject()
    playerObject.scale.setScalar(MODEL_SCALE)
    // Lift skin by half its world height so it sits above network feet anchor (root stays at feet).
    playerObject.position.y = REMOTE_WORLD_HEIGHT * 0.5
    playerObject.traverse((o) => {
      if (o instanceof THREE.Mesh) o.frustumCulled = false
    })
    root.add(playerObject)
    this.scene.add(root)

    {
      const brightened = new Set<THREE.Material>()
      playerObject.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return
        const mats = Array.isArray(o.material) ? o.material : [o.material]
        for (const m of mats) {
          if (
            m instanceof THREE.MeshStandardMaterial &&
            m.map &&
            !brightened.has(m)
          ) {
            brightened.add(m)
            m.roughness = Math.min(0.8, (m.roughness ?? 1) * 0.82)
            m.metalness = Math.min(0.02, m.metalness ?? 0)
            m.emissive.setHex(0xe8eef8)
            m.emissiveIntensity = 0.085
          }
        }
      })
    }

    const idle = new IdleAnimation()
    const walk = new WalkingAnimation()
    idle.speed = 1
    walk.speed = 1
    const skinShim = createPlayerSkinViewerShim(playerObject)
    skinShim.loadSkin(purpleFallbackCanvas())

    const nameLabel = createPlayerNameLabel('Гравець')
    root.add(nameLabel.sprite)

    const handGroup = new THREE.Group()
    handGroup.name = 'remote-hand-item'
    playerObject.skin.rightArm.add(handGroup)
    // Slightly forward + down so the tool reads like a held item (skin arm pivot is high).
    handGroup.position.set(0.5, -5.5, 3.2)
    handGroup.rotation.set(0.12, 0.08, -0.06)
    // Skin rig is already under `playerObject` scaled by MODEL_SCALE — do not multiply MODEL_SCALE again here
    // or the held item shrinks to ~MODEL_SCALE² and becomes nearly invisible.
    handGroup.scale.setScalar(4.2)

    const handSwingPivot = new THREE.Group()
    handSwingPivot.name = 'remote-hand-swing-pivot'
    handGroup.add(handSwingPivot)

    const entry: Entry = {
      root,
      playerObject,
      idle,
      walk,
      current: idle,
      skinShim,
      nameLabel,
      lastMoving: false,
      targetX: 0,
      targetY: 0,
      targetZ: 0,
      targetRy: 0,
      smoothRy: 0,
      netMoving: false,
      lx: 0,
      lz: 0,
      animBlend: 0,
      lastSkinUrl: undefined,
      lastDisplayName: '',
      lastProfilePhotoUrl: '',
      handGroup,
      handSwingPivot,
      lastHandMode: 'mine',
      lastHandSlot: -1,
      lastRemoteSwingSeq: -1,
      handSwingPhase: 0,
      handRefreshGen: 0,
    }
    this.players.set(uid, entry)
    return entry
  }

  private clearRemoteHandVisual(e: Entry) {
    while (e.handSwingPivot.children.length > 0) {
      const ch = e.handSwingPivot.children[0]
      e.handSwingPivot.remove(ch)
      ch.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry?.dispose()
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material]
          mats.forEach((m) => m?.dispose?.())
        }
      })
    }
  }

  private async refreshRemoteHand(
    entry: Entry,
    mode: 'mine' | 'build',
    slot: number,
  ) {
    const gen = ++entry.handRefreshGen
    this.clearRemoteHandVisual(entry)
    if (mode === 'mine') {
      const tpl = await ensureRemoteToolTemplate()
      if (gen !== entry.handRefreshGen) return
      if (!tpl) return
      entry.handSwingPivot.add(tpl.clone(true))
    } else {
      const bt = blockTypeFromPresenceSlot(slot)
      const src = this.terrain.materials.get(this.terrain.materialType[bt])
      const base = Array.isArray(src) ? src[0]! : src
      const mat = base.clone()
      mat.side = THREE.FrontSide
      applySrgbColorMaps(mat)
      applyHandHeldLightingLift(mat)
      const s = 0.62 * 3
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), mat)
      entry.handSwingPivot.add(mesh)
    }
  }

  remove(uid: string) {
    const e = this.players.get(uid)
    if (!e) return
    this.clearRemoteHandVisual(e)
    e.nameLabel.dispose()
    e.skinShim.dispose()
    this.scene.remove(e.root)
    e.root.traverse((ch) => {
      if (ch instanceof THREE.Mesh) {
        ch.geometry?.dispose?.()
        const mats = Array.isArray(ch.material) ? ch.material : [ch.material]
        mats.forEach((m) => m?.dispose?.())
      }
    })
    this.players.delete(uid)
  }

  async applySkin(entry: Entry, skinUrl: string | null) {
    const fallback = purpleFallbackCanvas()
    const resolved = normalizeSkinUrlForPresence(skinUrl)
    try {
      await loadRemoteSkinForViewer(
        { loadSkin: entry.skinShim.loadSkin.bind(entry.skinShim) },
        resolved || undefined,
        fallback,
      )
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      })
      entry.nameLabel.setSkinFace(
        resolved ? entry.skinShim.getSkinCanvas() : null,
      )
    } catch (e) {
      console.warn('[RemotePlayers] applySkin', e)
      try {
        entry.skinShim.loadSkin(fallback)
      } catch {
        /* ignore */
      }
      entry.nameLabel.setSkinFace(null)
    }
  }

  sync(players: Map<string, PresenceDoc>) {
    const seen = new Set<string>()
    for (const [uid, p] of players) {
      if (uid === this.localUid) continue
      seen.add(uid)
      let entry = this.players.get(uid)
      const skinNorm = normalizeSkinUrlForPresence(p.skinUrl)
      const displayName = (p.displayName || 'Гравець').trim() || 'Гравець'
      if (!entry) {
        entry = this.spawn(uid)
        entry.lastSkinUrl = skinNorm
        void this.applySkin(entry, p.skinUrl)
      } else if (entry.lastSkinUrl !== skinNorm) {
        entry.lastSkinUrl = skinNorm
        void this.applySkin(entry, p.skinUrl)
      }
      if (entry.lastDisplayName !== displayName) {
        entry.lastDisplayName = displayName
        entry.nameLabel.setName(displayName)
      }

      const photoNorm = normalizeSkinUrlForPresence(
        typeof p.photoUrl === 'string' ? p.photoUrl : null,
      )
      const ph = photoNorm || ''
      if (entry.lastProfilePhotoUrl !== ph) {
        entry.lastProfilePhotoUrl = ph
        entry.nameLabel.setProfilePhotoUrl(photoNorm)
      }

      const feetY = p.y - PLAYER_EYE_HEIGHT + FEET_Y_OFFSET
      entry.targetX = p.x
      entry.targetY = feetY
      entry.targetZ = p.z
      const modelRy = p.ry
      entry.targetRy = unwrapAngleNear(entry.smoothRy, modelRy)
      entry.netMoving = Boolean(p.moving)

      const mode = p.mode === 'build' ? 'build' : 'mine'
      const slot =
        typeof p.slot === 'number' && p.slot >= 0 && p.slot <= 7
          ? p.slot
          : 0
      if (entry.lastHandMode !== mode || entry.lastHandSlot !== slot) {
        entry.lastHandMode = mode
        entry.lastHandSlot = slot
        void this.refreshRemoteHand(entry, mode, slot)
      }

      const swingSeqRaw = p.handSwingSeq
      const swingSeq =
        typeof swingSeqRaw === 'number' &&
        Number.isFinite(swingSeqRaw) &&
        swingSeqRaw >= 0
          ? Math.floor(swingSeqRaw)
          : 0
      if (entry.lastRemoteSwingSeq < 0) {
        entry.lastRemoteSwingSeq = swingSeq
      } else if (swingSeq > entry.lastRemoteSwingSeq) {
        entry.lastRemoteSwingSeq = swingSeq
        entry.handSwingPhase = 1
      }

      this.tmpV.set(entry.targetX, entry.targetY, entry.targetZ)
      const d = entry.root.position.distanceTo(this.tmpV)
      if (d > TELEPORT_DIST) {
        entry.root.position.set(entry.targetX, entry.targetY, entry.targetZ)
        entry.smoothRy = entry.targetRy
        entry.root.rotation.y = entry.smoothRy
        entry.lx = entry.root.position.x
        entry.lz = entry.root.position.z
      }
    }
    for (const uid of this.players.keys()) {
      if (!seen.has(uid)) this.remove(uid)
    }
  }

  update(dt: number) {
    const kPos = 1 - Math.exp(-POS_SMOOTH * dt)
    const kRot = 1 - Math.exp(-ROT_SMOOTH * dt)
    const dtSafe = Math.max(dt, 1e-4)

    for (const e of this.players.values()) {
      const px = e.root.position.x
      const pz = e.root.position.z

      e.root.position.x += (e.targetX - e.root.position.x) * kPos
      e.root.position.y += (e.targetY - e.root.position.y) * kPos
      e.root.position.z += (e.targetZ - e.root.position.z) * kPos

      e.smoothRy += (e.targetRy - e.smoothRy) * kRot
      e.root.rotation.y = e.smoothRy

      const hSpeed =
        Math.hypot(e.root.position.x - px, e.root.position.z - pz) / dtSafe
      e.lx = e.root.position.x
      e.lz = e.root.position.z

      const wantWalk = e.netMoving || hSpeed > 0.14
      const targetBlend = wantWalk ? 1 : 0
      e.animBlend += (targetBlend - e.animBlend) * Math.min(1, 10 * dt)

      const walkVis = e.animBlend > 0.55
      if (walkVis !== e.lastMoving) {
        e.playerObject.resetJoints()
        e.current = walkVis ? e.walk : e.idle
        e.current.progress = 0
        e.lastMoving = walkVis
      }

      e.current.update(e.playerObject, dt)

      if (e.handSwingPhase > 0) {
        e.handSwingPhase = Math.max(0, e.handSwingPhase - dt * 6.2)
        const u = 1 - e.handSwingPhase
        const a = Math.sin(u * Math.PI) * 1.08
        e.handSwingPivot.rotation.x = a
        e.handSwingPivot.rotation.z = a * 0.22
        e.handSwingPivot.rotation.y = a * 0.08
      } else {
        e.handSwingPivot.rotation.set(0, 0, 0)
      }
    }
  }

  dispose() {
    for (const uid of [...this.players.keys()]) {
      this.remove(uid)
    }
  }
}
