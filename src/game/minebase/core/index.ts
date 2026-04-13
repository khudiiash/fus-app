import * as THREE from 'three'

export default class Core {
  /** When set (Fus app), renderer mounts here and size follows the element. */
  mountEl: HTMLElement | null = null

  constructor(mountEl?: HTMLElement) {
    this.mountEl = mountEl ?? null
    this.camera = new THREE.PerspectiveCamera()
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
    this.scene = new THREE.Scene()
    this.initScene()
    this.initRenderer()
    this.initCamera()
  }

  camera: THREE.PerspectiveCamera
  scene: THREE.Scene
  renderer: THREE.WebGLRenderer

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
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(w, h)
  }

  initCamera = () => {
    this.camera.fov = 50
    const { w, h } = this.sizeFromMount()
    this.camera.aspect = w / h
    this.camera.near = 0.01
    this.camera.far = 500
    this.camera.updateProjectionMatrix()
    this.camera.position.set(8, 50, 8)

    this.camera.lookAt(100, 30, 100)
    /** Required so meshes parented to the camera (e.g. FP held items) participate in render lists. */
    this.scene.add(this.camera)
  }

  initScene = () => {
    this.scene = new THREE.Scene()
    const backgroundColor = 0x87ceeb

    this.scene.fog = new THREE.Fog(backgroundColor, 1, 96)
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
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.08
    this.renderer.setSize(w, h)
    const parent = this.mountEl ?? document.body
    parent.appendChild(this.renderer.domElement)

    const onResize = () => this.syncRendererSize()
    window.addEventListener('resize', onResize)
    window.visualViewport?.addEventListener('resize', onResize)
    window.visualViewport?.addEventListener('scroll', onResize)
  }
}
