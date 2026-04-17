import * as THREE from 'three'
import type { WebGPURenderer } from 'three/webgpu'
import { isLowPowerTouchDevice } from '../utils'

export type BlockWorldCanvasRenderer = THREE.WebGLRenderer | WebGPURenderer

export default class Core {
  /** When set (Fus app), renderer mounts here and size follows the element. */
  mountEl: HTMLElement | null = null
  private readonly touchLikeDevice: boolean

  constructor(mountEl?: HTMLElement) {
    this.mountEl = mountEl ?? null
    this.touchLikeDevice =
      ('ontouchstart' in window) ||
      ((navigator.maxTouchPoints || 0) > 0) ||
      (window.matchMedia?.('(pointer: coarse)').matches ?? false)
    this.camera = new THREE.PerspectiveCamera()
    this.renderer = new THREE.WebGLRenderer({
      antialias: !this.touchLikeDevice,
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
      precision: 'highp',
    })
    this.scene = new THREE.Scene()
    this.initScene()
    this.initRenderer()
    this.initCamera()
  }

  camera: THREE.PerspectiveCamera
  scene: THREE.Scene
  renderer: BlockWorldCanvasRenderer

  private targetFov(aspect: number): number {
    // Portrait phones need wider vertical FOV for navigation.
    if (this.touchLikeDevice) {
      if (aspect < 0.9) return 66
      if (aspect < 1.2) return 60
      return 54
    }
    return 50
  }

  private targetPixelRatio(aspect: number): number {
    const dpr = window.devicePixelRatio || 1
    if (!this.touchLikeDevice) return Math.min(dpr, 1.65)
    const low = isLowPowerTouchDevice()
    if (aspect >= 1.2) return Math.min(dpr, low ? 1 : 1.05)
    return Math.min(dpr, low ? 1 : 1.15)
  }

  private sizeFromMount = () => {
    if (this.mountEl) {
      const r = this.mountEl.getBoundingClientRect()
      return { w: Math.max(1, r.width), h: Math.max(1, r.height) }
    }
    const vv = window.visualViewport
    if (vv) {
      return {
        w: Math.max(1, vv.width),
        h: Math.max(1, vv.height),
      }
    }
    return { w: window.innerWidth, h: window.innerHeight }
  }

  /** Resize camera + renderer from mount (call after layout / visualViewport changes). */
  syncRendererSize = () => {
    const { w, h } = this.sizeFromMount()
    const aspect = w / h
    this.camera.aspect = aspect
    this.camera.fov = this.targetFov(aspect)
    this.camera.updateProjectionMatrix()
    this.renderer.setPixelRatio(this.targetPixelRatio(aspect))
    this.renderer.setSize(w, h)
  }

  initCamera = () => {
    const { w, h } = this.sizeFromMount()
    const aspect = w / h
    this.camera.fov = this.targetFov(aspect)
    this.camera.aspect = aspect
    this.camera.near = 0.01
    // Smaller far plane on touch devices reduces overdraw and fragment load.
    this.camera.far = this.touchLikeDevice
      ? isLowPowerTouchDevice()
        ? 190
        : 220
      : 500
    this.camera.updateProjectionMatrix()
    this.camera.position.set(8, 50, 8)

    this.camera.lookAt(100, 30, 100)
    /** Required so meshes parented to the camera (e.g. FP held items) participate in render lists. */
    this.scene.add(this.camera)
  }

  initScene = () => {
    this.scene = new THREE.Scene()
    const backgroundColor = 0x87ceeb

    this.scene.fog = new THREE.Fog(backgroundColor, 2, 88)
    this.scene.background = new THREE.Color(backgroundColor)

    const hemi = new THREE.HemisphereLight(0xb4dcff, 0x524838, 0.5)
    this.scene.add(hemi)

    const sunDir = new THREE.DirectionalLight(0xfff6ec, 1.0)
    sunDir.position.set(55, 108, 42)
    this.scene.add(sunDir)

    const fill = new THREE.AmbientLight(0xf2f6ff, 0.4)
    this.scene.add(fill)
  }

  initRenderer = () => {
    const { w, h } = this.sizeFromMount()
    this.renderer.setPixelRatio(this.targetPixelRatio(w / h))
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    if (this.touchLikeDevice) {
      this.renderer.toneMapping = THREE.NoToneMapping
      this.renderer.toneMappingExposure = 1
    } else {
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping
      this.renderer.toneMappingExposure = 1.08
    }
    this.renderer.setSize(w, h)
    const parent = this.mountEl ?? document.body
    parent.appendChild(this.renderer.domElement)

    const onResize = () => this.syncRendererSize()
    window.addEventListener('resize', onResize)
    window.visualViewport?.addEventListener('resize', onResize)
    window.visualViewport?.addEventListener('scroll', onResize)
  }
}
