import * as THREE from 'three'
import type { SpawnFlagsMap } from './blockWorldRtdb'
import { normalizeSkinUrlForPresence } from '@/utils/presenceSkinUrl'

const FLAG_W = 0.95
const FLAG_H = 1.15
const POLE_H = 0.08

/** Vertical billboard “flag” with skin head; billboards toward camera each frame. */
export class SpawnFlagsManager {
  private scene: THREE.Scene
  private flags = new Map<
    string,
    {
      root: THREE.Group
      board: THREE.Mesh
      mat: THREE.MeshBasicMaterial
      tex: THREE.CanvasTexture | null
      lastSkinUrl: string | null
    }
  >()

  constructor(scene: THREE.Scene, _localUid: string) {
    this.scene = scene
  }

  private makePlaceholderTexture(hue: number) {
    const c = document.createElement('canvas')
    c.width = 32
    c.height = 40
    const ctx = c.getContext('2d')
    if (ctx) {
      ctx.fillStyle = `hsl(${hue % 360}, 55%, 38%)`
      ctx.fillRect(0, 0, 32, 40)
      ctx.fillStyle = 'rgba(255,255,255,0.35)'
      ctx.fillRect(4, 6, 24, 18)
    }
    const tex = new THREE.CanvasTexture(c)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.magFilter = THREE.NearestFilter
    tex.minFilter = THREE.NearestFilter
    return tex
  }

  private paintHeadFromSkinCanvas(
    ctx: CanvasRenderingContext2D,
    skin: HTMLCanvasElement | HTMLImageElement,
  ) {
    const w = skin.width
    const m = w >= 96 ? 2 : 1
    const sx = 8 * m
    const sy = 8 * m
    const sw = 8 * m
    const sh = 8 * m
    ctx.clearRect(0, 0, 32, 40)
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(skin, sx, sy, sw, sh, 2, 4, 28, 28)
    ctx.strokeStyle = 'rgba(0,0,0,0.55)'
    ctx.lineWidth = 2
    ctx.strokeRect(2, 4, 28, 28)
  }

  private tryLoadSkinForFlag(uid: string, skinUrl: string | null) {
    const entry = this.flags.get(uid)
    if (!entry) return
    const resolved = normalizeSkinUrlForPresence(skinUrl)
    const hue = uid.split('').reduce((a, ch) => a + ch.charCodeAt(0), 0)
    if (!resolved || !/^https?:\/\//i.test(resolved)) {
      if (entry.tex) entry.tex.dispose()
      entry.tex = this.makePlaceholderTexture(hue)
      entry.mat.map = entry.tex
      entry.mat.needsUpdate = true
      entry.lastSkinUrl = null
      return
    }
    if (entry.lastSkinUrl === resolved) return
    entry.lastSkinUrl = resolved

    const im = new Image()
    im.crossOrigin = 'anonymous'
    im.onload = () => {
      const e2 = this.flags.get(uid)
      if (!e2 || e2.lastSkinUrl !== resolved) return
      const c = document.createElement('canvas')
      c.width = 64
      c.height = 64
      const ctx = c.getContext('2d')
      if (!ctx) return
      try {
        ctx.drawImage(im, 0, 0, 64, 64)
        const c2 = document.createElement('canvas')
        c2.width = 32
        c2.height = 40
        const ctx2 = c2.getContext('2d')
        if (!ctx2) return
        this.paintHeadFromSkinCanvas(ctx2, c)
        if (e2.tex) e2.tex.dispose()
        e2.tex = new THREE.CanvasTexture(c2)
        e2.tex.colorSpace = THREE.SRGBColorSpace
        e2.tex.magFilter = THREE.NearestFilter
        e2.tex.minFilter = THREE.NearestFilter
        e2.mat.map = e2.tex
        e2.mat.needsUpdate = true
      } catch {
        if (e2.tex) e2.tex.dispose()
        e2.tex = this.makePlaceholderTexture(hue)
        e2.mat.map = e2.tex
        e2.mat.needsUpdate = true
      }
    }
    im.onerror = () => {
      const e2 = this.flags.get(uid)
      if (!e2) return
      if (e2.tex) e2.tex.dispose()
      e2.tex = this.makePlaceholderTexture(hue)
      e2.mat.map = e2.tex
      e2.mat.needsUpdate = true
    }
    im.src = resolved
  }

  sync(flags: SpawnFlagsMap, skinByUid: Map<string, string | null>) {
    const seen = new Set<string>()
    for (const [uid, pose] of flags) {
      seen.add(uid)
      let entry = this.flags.get(uid)
      if (!entry) {
        const root = new THREE.Group()
        root.name = `spawn-flag-${uid}`

        const pole = new THREE.Mesh(
          new THREE.BoxGeometry(0.06, FLAG_H * 0.55, 0.06),
          new THREE.MeshStandardMaterial({
            color: 0x5c4033,
            roughness: 0.9,
            metalness: 0,
          }),
        )
        pole.position.y = FLAG_H * 0.28
        root.add(pole)

        const mat = new THREE.MeshBasicMaterial({ transparent: true })
        const board = new THREE.Mesh(new THREE.PlaneGeometry(FLAG_W, FLAG_H), mat)
        board.position.set(0, FLAG_H * 0.62 + POLE_H, 0.08)
        board.frustumCulled = false
        root.add(board)

        root.position.set(pose.x, pose.y, pose.z)
        root.rotation.y = pose.ry
        this.scene.add(root)

        const hue = uid.split('').reduce((a, ch) => a + ch.charCodeAt(0), 0)
        const tex = this.makePlaceholderTexture(hue)
        mat.map = tex
        mat.needsUpdate = true
        entry = { root, board, mat, tex, lastSkinUrl: null }
        this.flags.set(uid, entry)
      } else {
        entry.root.position.set(pose.x, pose.y, pose.z)
        entry.root.rotation.y = pose.ry
      }
      this.tryLoadSkinForFlag(uid, skinByUid.get(uid) ?? null)
    }
    for (const uid of this.flags.keys()) {
      if (!seen.has(uid)) this.remove(uid)
    }
  }

  update(camera: THREE.PerspectiveCamera) {
    for (const entry of this.flags.values()) {
      entry.board.quaternion.copy(camera.quaternion)
    }
  }

  remove(uid: string) {
    const e = this.flags.get(uid)
    if (!e) return
    this.scene.remove(e.root)
    if (e.tex) e.tex.dispose()
    e.mat.dispose()
    e.root.traverse((ch) => {
      if (ch instanceof THREE.Mesh && ch !== e.board) {
        ch.geometry?.dispose()
        const mats = Array.isArray(ch.material) ? ch.material : [ch.material]
        mats.forEach((m) => m?.dispose?.())
      }
    })
    e.board.geometry.dispose()
    this.flags.delete(uid)
  }

  dispose() {
    for (const uid of [...this.flags.keys()]) {
      this.remove(uid)
    }
  }
}
