import type { PresenceDoc } from '@/game/sharedWorldFirestore'
import { PLAYER_EYE_HEIGHT } from '@/game/playerConstants'
import { normalizeSkinUrlForPresence } from '@/utils/presenceSkinUrl'
import * as THREE from '@labymc/libraries/three.module.js'
import {
  createLabyPresencePlayerWrapper,
  LabyMinecraftSkinRig,
} from '@/game/labyminecraft/labyMinecraftSkinRig'
import { normalizeMinecraftSkinToCanvas } from '@/game/labyminecraft/normalizeMinecraftSkinCanvas'

function colorFromUid(uid: string): number {
  let h = 0
  for (let i = 0; i < uid.length; i++) h = (h * 31 + uid.charCodeAt(i)) >>> 0
  return (h & 0xffffff) | 0x505050
}

function paintFallbackCanvas(uid: string): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = 64
  c.height = 64
  const ctx = c.getContext('2d')
  if (ctx) {
    const hex = (colorFromUid(uid) & 0xffffff).toString(16).padStart(6, '0')
    ctx.fillStyle = `#${hex}`
    ctx.fillRect(0, 0, 64, 64)
    ctx.fillStyle = 'rgba(255,255,255,0.12)'
    for (let y = 0; y < 64; y += 8) ctx.fillRect(0, y, 64, 4)
  }
  return c
}

function loadSkinImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = url
  })
}

function configureSkinTexture(tex: THREE.Texture) {
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  tex.colorSpace = THREE.SRGBColorSpace
  tex.needsUpdate = true
}

/** Match {@link src/game/remotePlayersManager.ts} remote rig footprint. */
const REMOTE_NATIVE_HEIGHT = 24.5
const FEET_Y_OFFSET = 0.12
const MODEL_SCALE = (PLAYER_EYE_HEIGHT + 0.12) / REMOTE_NATIVE_HEIGHT
const REMOTE_WORLD_HEIGHT = REMOTE_NATIVE_HEIGHT * MODEL_SCALE

const REMOTE_POS_SMOOTH = 14
const REMOTE_TELEPORT_SNAP = 14
/** Vanilla {@link EntityRenderer} mirrors the model with `(-s,-s,s)` scale; our rig does not — offset root yaw. */
const REMOTE_ROOT_YAW_OFFSET = Math.PI

function lerpShortestAngleY(from: number, to: number, t: number): number {
  let d = to - from
  while (d > Math.PI) d -= Math.PI * 2
  while (d < -Math.PI) d += Math.PI * 2
  return from + d * t
}

type AvatarEntry = {
  uid: string
  root: THREE.Group
  skinRig: LabyMinecraftSkinRig
  skinTexture: THREE.Texture | null
  /** `null` until first texture apply; then the last normalized URL or `''` if none. */
  lastSkinNorm: string | null
  loadToken: number
  moving: boolean
  animPhase: number
  /** Network pose (eye Y). */
  tx: number
  ty: number
  tz: number
  try: number
  /** Smoothed pose for rendering (eye Y). */
  sx: number
  sy: number
  sz: number
  sry: number
  /** Target / smoothed head yaw offset on rig (rad). */
  thr: number
  sthr: number
}

/**
 * Other players in the Laby scene: full Minecraft skin **box model** (same UV layout as
 * block-world remotes), {@link THREE.MeshBasicMaterial} so lighting does not flatten it.
 */
export class LabyPresenceAvatars {
  private readonly scene: THREE.Scene
  private readonly selfUid: string
  private readonly entries = new Map<string, AvatarEntry>()
  private rafId = 0
  private lastRafMs = performance.now()

  constructor(scene: THREE.Scene, selfUid: string) {
    this.scene = scene
    this.selfUid = selfUid
    const loop = (t: number) => {
      this.rafId = requestAnimationFrame(loop)
      if (this.entries.size === 0) return
      const dt = Math.min(0.05, (t - this.lastRafMs) / 1000)
      this.lastRafMs = t
      for (const e of this.entries.values()) this.animTick(e, dt)
    }
    this.lastRafMs = performance.now()
    this.rafId = requestAnimationFrame(loop)
  }

  private animTick(e: AvatarEntry, dt: number) {
    this.smoothRemotePose(e, dt)
    e.animPhase += dt
    const rig = e.skinRig
    const basicArmZ = Math.PI * 0.02
    if (e.moving) {
      const t = e.animPhase * 8
      rig.leftLeg.rotation.x = Math.sin(t) * 0.5
      rig.rightLeg.rotation.x = Math.sin(t + Math.PI) * 0.5
      rig.leftArm.rotation.x = Math.sin(t + Math.PI) * 0.5
      rig.rightArm.rotation.x = Math.sin(t) * 0.5
      rig.leftArm.rotation.z = Math.cos(t) * 0.03 + basicArmZ
      rig.rightArm.rotation.z = Math.cos(t + Math.PI) * 0.03 - basicArmZ
      rig.head.rotation.y = e.sthr + Math.sin(t / 4) * 0.2
      rig.head.rotation.x = Math.sin(t / 5) * 0.1
    } else {
      const t = e.animPhase * 2
      rig.leftLeg.rotation.x = 0
      rig.rightLeg.rotation.x = 0
      rig.leftArm.rotation.x = 0
      rig.rightArm.rotation.x = 0
      rig.head.rotation.x = 0
      rig.head.rotation.z = 0
      rig.head.rotation.y = e.sthr + Math.sin(t / 4) * 0.04
      rig.leftArm.rotation.z = Math.cos(t) * 0.03 + basicArmZ
      rig.rightArm.rotation.z = Math.cos(t + Math.PI) * 0.03 - basicArmZ
    }
  }

  private smoothRemotePose(e: AvatarEntry, dt: number) {
    const dist = Math.hypot(e.tx - e.sx, e.ty - e.sy, e.tz - e.sz)
    if (dist > REMOTE_TELEPORT_SNAP) {
      e.sx = e.tx
      e.sy = e.ty
      e.sz = e.tz
      e.sry = e.try
      e.sthr = e.thr
    } else {
      const k = 1 - Math.exp(-REMOTE_POS_SMOOTH * dt)
      e.sx += (e.tx - e.sx) * k
      e.sy += (e.ty - e.sy) * k
      e.sz += (e.tz - e.sz) * k
      e.sry = lerpShortestAngleY(e.sry, e.try, k)
      e.sthr += (e.thr - e.sthr) * k
    }
    const feetY = e.sy - PLAYER_EYE_HEIGHT + FEET_Y_OFFSET
    e.root.position.set(e.sx, feetY, e.sz)
    e.root.rotation.y = e.sry + REMOTE_ROOT_YAW_OFFSET
  }

  private createEntry(uid: string, p: PresenceDoc): AvatarEntry {
    const root = new THREE.Group()
    const skinRig = new LabyMinecraftSkinRig(false)
    const wrap = createLabyPresencePlayerWrapper(skinRig, MODEL_SCALE, REMOTE_WORLD_HEIGHT * 0.5)
    wrap.userData.blockWorldHitUid = uid
    root.add(wrap)
    this.scene.add(root)
    const entry: AvatarEntry = {
      uid,
      root,
      skinRig,
      skinTexture: null,
      lastSkinNorm: null,
      loadToken: 0,
      moving: false,
      animPhase: 0,
      tx: p.x,
      ty: p.y,
      tz: p.z,
      try: p.ry,
      thr: p.hr,
      sx: p.x,
      sy: p.y,
      sz: p.z,
      sry: p.ry,
      sthr: p.hr,
    }
    const feetY = p.y - PLAYER_EYE_HEIGHT + FEET_Y_OFFSET
    root.position.set(p.x, feetY, p.z)
    root.rotation.y = p.ry + REMOTE_ROOT_YAW_OFFSET
    skinRig.resetPose()
    void this.applySkinTexture(entry, null)
    return entry
  }

  private replaceSkinTexture(entry: AvatarEntry, tex: THREE.Texture) {
    configureSkinTexture(tex)
    entry.skinRig.setSkinMap(tex)
    const prev = entry.skinTexture
    entry.skinTexture = tex
    if (prev && prev !== tex) prev.dispose()
  }

  private async applySkinTexture(entry: AvatarEntry, skinUrl: string | null | undefined) {
    const norm = normalizeSkinUrlForPresence(skinUrl ?? '') || ''
    const token = ++entry.loadToken
    if (entry.lastSkinNorm !== null && norm === entry.lastSkinNorm) return

    if (!norm) {
      const canvas = paintFallbackCanvas(entry.uid)
      const tex = new THREE.CanvasTexture(canvas)
      entry.skinRig.setTexturePixelSize(64, 64)
      this.replaceSkinTexture(entry, tex)
      if (token !== entry.loadToken) return
      entry.lastSkinNorm = ''
      return
    }

    const img = await loadSkinImage(norm)
    if (token !== entry.loadToken) return
    if (!img || img.naturalWidth < 32) {
      const canvas = paintFallbackCanvas(entry.uid)
      const tex = new THREE.CanvasTexture(canvas)
      entry.skinRig.setTexturePixelSize(64, 64)
      if (token !== entry.loadToken) return
      this.replaceSkinTexture(entry, tex)
      entry.lastSkinNorm = norm
      return
    }

    if (token !== entry.loadToken) return
    let skinCanvas: HTMLCanvasElement
    try {
      skinCanvas = normalizeMinecraftSkinToCanvas(img)
    } catch {
      skinCanvas = paintFallbackCanvas(entry.uid)
    }
    if (token !== entry.loadToken) return
    const tex = new THREE.CanvasTexture(skinCanvas)
    entry.skinRig.setTexturePixelSize(skinCanvas.width, skinCanvas.height)
    if (token !== entry.loadToken) return
    this.replaceSkinTexture(entry, tex)
    if (token !== entry.loadToken) return
    entry.lastSkinNorm = norm
  }

  sync(map: Map<string, PresenceDoc>) {
    const seen = new Set<string>()
    for (const [uid, p] of map) {
      if (uid === this.selfUid) continue
      seen.add(uid)
      let e = this.entries.get(uid)
      if (!e) {
        e = this.createEntry(uid, p)
        this.entries.set(uid, e)
      }
      e.tx = p.x
      e.ty = p.y
      e.tz = p.z
      e.try = p.ry
      e.thr = p.hr
      e.moving = p.moving
      void this.applySkinTexture(e, p.skinUrl)
    }
    for (const [uid, e] of [...this.entries]) {
      if (!seen.has(uid)) {
        this.scene.remove(e.root)
        e.skinRig.setSkinMap(null)
        e.skinTexture?.dispose()
        e.skinRig.disposeGeometriesAndMaterials()
        this.entries.delete(uid)
      }
    }
  }

  /** Ray roots for Laby PvP (same `userData.blockWorldHitUid` convention as Block World remotes). */
  getMeleeRaycastRoots(): THREE.Object3D[] {
    return [...this.entries.values()].map((e) => e.root)
  }

  dispose() {
    cancelAnimationFrame(this.rafId)
    for (const e of this.entries.values()) {
      this.scene.remove(e.root)
      e.skinRig.setSkinMap(null)
      e.skinTexture?.dispose()
      e.skinRig.disposeGeometriesAndMaterials()
    }
    this.entries.clear()
  }
}
