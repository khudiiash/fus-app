import * as THREE from 'three'
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js'
import { PLAYER_EYE_HEIGHT } from '@/game/playerConstants'

const CHUNK_SIDE = 16

/** Procedural column height for the prototype chunk (original math; not copied from upstream). */
function columnHeight(ix: number, iz: number): number {
  const x = ix - CHUNK_SIDE / 2
  const z = iz - CHUNK_SIDE / 2
  const h = 1.5 + Math.sin(x * 0.35) * Math.cos(z * 0.31) * 2.1
  return Math.max(1, Math.min(6, Math.floor(h)))
}

export type BlockWorldNextGameOptions = {
  /** Fired when pointer lock is acquired or released. */
  onPointerLockChange?: (locked: boolean) => void
}

export type BlockWorldNextGame = {
  start: () => void
  dispose: () => void
  syncRendererSize: () => void
  requestPointerLock: () => void
  unlockPointer: () => void
  isPointerLocked: () => boolean
  readonly domElement: HTMLCanvasElement
}

/**
 * Minimal first-person slice: renderer, lighting, one 16×16 heightmap chunk, WASD + gravity.
 * Intended to grow into the shared Firestore/RTDB world; see repo `THIRD_PARTY_NOTICES.txt`.
 */
export function createBlockWorldNextGame(
  mountEl: HTMLElement,
  options?: BlockWorldNextGameOptions,
): BlockWorldNextGame {
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x87b8e8)
  scene.fog = new THREE.Fog(0x87b8e8, 32, 140)

  const camera = new THREE.PerspectiveCamera(70, 1, 0.08, 256)
  camera.position.set(CHUNK_SIDE / 2, PLAYER_EYE_HEIGHT + 5, CHUNK_SIDE + 6)

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap

  const hemi = new THREE.HemisphereLight(0xbfd4ff, 0x6b5344, 0.55)
  scene.add(hemi)
  const sun = new THREE.DirectionalLight(0xfff2dc, 0.95)
  sun.position.set(30, 48, 20)
  sun.castShadow = true
  sun.shadow.mapSize.setScalar(1024)
  sun.shadow.camera.near = 0.5
  sun.shadow.camera.far = 120
  sun.shadow.camera.left = -40
  sun.shadow.camera.right = 40
  sun.shadow.camera.top = 40
  sun.shadow.camera.bottom = -40
  scene.add(sun)

  const groundMat = new THREE.MeshStandardMaterial({ color: 0x3d6e3d, roughness: 1, metalness: 0 })
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), groundMat)
  ground.rotation.x = -Math.PI / 2
  ground.receiveShadow = true
  scene.add(ground)

  const boxGeo = new THREE.BoxGeometry(1, 1, 1)
  const topMat = new THREE.MeshStandardMaterial({ color: 0x6ab06a, roughness: 0.92, metalness: 0 })
  const inst = new THREE.InstancedMesh(boxGeo, topMat, CHUNK_SIDE * CHUNK_SIDE)
  inst.castShadow = true
  inst.receiveShadow = true
  const m = new THREE.Matrix4()
  let i = 0
  for (let iz = 0; iz < CHUNK_SIDE; iz++) {
    for (let ix = 0; ix < CHUNK_SIDE; ix++) {
      const h = columnHeight(ix, iz)
      m.compose(
        new THREE.Vector3(ix + 0.5, h - 0.5, iz + 0.5),
        new THREE.Quaternion(),
        new THREE.Vector3(1, 1, 1),
      )
      inst.setMatrixAt(i++, m)
    }
  }
  inst.instanceMatrix.needsUpdate = true
  scene.add(inst)

  const controls = new PointerLockControls(camera, renderer.domElement)
  const onLock = () => options?.onPointerLockChange?.(true)
  const onUnlock = () => options?.onPointerLockChange?.(false)
  controls.addEventListener('lock', onLock)
  controls.addEventListener('unlock', onUnlock)

  const keys = new Set<string>()
  const onKeyDown = (e: KeyboardEvent) => {
    keys.add(e.code)
    if (e.code === 'Escape') controls.unlock()
  }
  const onKeyUp = (e: KeyboardEvent) => keys.delete(e.code)

  const clock = new THREE.Clock()
  let raf = 0
  let running = false
  const velocityY = { v: 0 }
  const moveSpeed = 19
  const gravity = 34

  const scratchDir = new THREE.Vector3()
  const scratchRight = new THREE.Vector3()

  const tick = () => {
    if (!running) return
    raf = requestAnimationFrame(tick)
    const dt = Math.min(clock.getDelta(), 0.05)
    if (controls.isLocked) {
      let mx = 0
      let mz = 0
      if (keys.has('KeyW')) mz -= 1
      if (keys.has('KeyS')) mz += 1
      if (keys.has('KeyA')) mx -= 1
      if (keys.has('KeyD')) mx += 1
      if (mx !== 0 || mz !== 0) {
        const len = Math.hypot(mx, mz)
        mx /= len
        mz /= len
        const speed = moveSpeed * dt
        scratchDir.set(0, 0, 0)
        camera.getWorldDirection(scratchDir)
        scratchDir.y = 0
        scratchDir.normalize()
        scratchRight.crossVectors(scratchDir, camera.up).normalize()
        camera.position.addScaledVector(scratchDir, -mz * speed)
        camera.position.addScaledVector(scratchRight, mx * speed)
      }
      if (keys.has('Space')) {
        if (camera.position.y <= PLAYER_EYE_HEIGHT + 0.06) velocityY.v = 9.2
      }
    }
    velocityY.v -= gravity * dt
    camera.position.y += velocityY.v * dt
    const floorY = PLAYER_EYE_HEIGHT
    if (camera.position.y < floorY) {
      camera.position.y = floorY
      velocityY.v = 0
    }
    renderer.render(scene, camera)
  }

  const syncRendererSize = () => {
    const w = mountEl.clientWidth || 1
    const h = mountEl.clientHeight || 1
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    renderer.setSize(w, h, false)
  }

  return {
    domElement: renderer.domElement,

    start() {
      if (running) return
      mountEl.appendChild(renderer.domElement)
      window.addEventListener('keydown', onKeyDown)
      window.addEventListener('keyup', onKeyUp)
      syncRendererSize()
      clock.getDelta()
      running = true
      tick()
    },

    dispose() {
      running = false
      cancelAnimationFrame(raf)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      controls.removeEventListener('lock', onLock)
      controls.removeEventListener('unlock', onUnlock)
      controls.disconnect()
      if (renderer.domElement.parentElement === mountEl) mountEl.removeChild(renderer.domElement)
      renderer.dispose()
      inst.dispose()
      ground.geometry.dispose()
      groundMat.dispose()
    },

    syncRendererSize,
    requestPointerLock: () => controls.lock(),
    unlockPointer: () => controls.unlock(),
    isPointerLocked: () => controls.isLocked,
  }
}
