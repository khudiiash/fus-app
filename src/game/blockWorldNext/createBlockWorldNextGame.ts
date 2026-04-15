import * as THREE from 'three'
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js'
import { PLAYER_EYE_HEIGHT } from '@/game/playerConstants'
import type { SerializedBlock } from '@/game/sharedWorldFirestore'
import { blockTypeHex } from './blockTypeColor'

const CHUNK_SIDE = 16
const MAX_SHARED_CUSTOM_BLOCKS = 20_000

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
  /** Replace instanced overlay from shared world `customBlocks` (placed entries only). */
  applyCustomBlocks: (blocks: SerializedBlock[]) => void
  requestPointerLock: () => void
  unlockPointer: () => void
  isPointerLocked: () => boolean
  readonly domElement: HTMLCanvasElement
}

/**
 * Minimal first-person slice: renderer, lighting, demo chunk, live shared custom blocks, WASD + gravity.
 * Intended to grow into the full shared world; see repo `THIRD_PARTY_NOTICES.txt`.
 */
export function createBlockWorldNextGame(
  mountEl: HTMLElement,
  options?: BlockWorldNextGameOptions,
): BlockWorldNextGame {
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x87b8e8)
  scene.fog = new THREE.Fog(0x87b8e8, 48, 280)

  const camera = new THREE.PerspectiveCamera(70, 1, 0.08, 512)
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
  sun.shadow.camera.far = 220
  sun.shadow.camera.left = -96
  sun.shadow.camera.right = 96
  sun.shadow.camera.top = 96
  sun.shadow.camera.bottom = -96
  scene.add(sun)

  const groundMat = new THREE.MeshStandardMaterial({ color: 0x3d6e3d, roughness: 1, metalness: 0 })
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), groundMat)
  ground.rotation.x = -Math.PI / 2
  ground.receiveShadow = true
  scene.add(ground)

  const demoBoxGeo = new THREE.BoxGeometry(1, 1, 1)
  const topMat = new THREE.MeshStandardMaterial({ color: 0x6ab06a, roughness: 0.92, metalness: 0 })
  const inst = new THREE.InstancedMesh(demoBoxGeo, topMat, CHUNK_SIDE * CHUNK_SIDE)
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

  const customBoxGeo = new THREE.BoxGeometry(1, 1, 1)
  const customMat = new THREE.MeshStandardMaterial({
    roughness: 0.88,
    metalness: 0.02,
    vertexColors: false,
  })
  const customMesh = new THREE.InstancedMesh(customBoxGeo, customMat, MAX_SHARED_CUSTOM_BLOCKS)
  customMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  customMesh.instanceColor = new THREE.InstancedBufferAttribute(
    new Float32Array(MAX_SHARED_CUSTOM_BLOCKS * 3),
    3,
  )
  customMesh.castShadow = true
  customMesh.receiveShadow = true
  customMesh.count = 0
  scene.add(customMesh)

  const colorTmp = new THREE.Color()
  const posTmp = new THREE.Vector3()
  const quatId = new THREE.Quaternion()
  const scaleOne = new THREE.Vector3(1, 1, 1)

  const applyCustomBlocks = (blocks: SerializedBlock[]) => {
    let idx = 0
    for (const b of blocks) {
      if (!b.placed) continue
      if (idx >= MAX_SHARED_CUSTOM_BLOCKS) break
      posTmp.set(b.x, b.y, b.z)
      m.compose(posTmp, quatId, scaleOne)
      customMesh.setMatrixAt(idx, m)
      colorTmp.setHex(blockTypeHex(b.type))
      customMesh.setColorAt(idx, colorTmp)
      idx++
    }
    customMesh.count = idx
    customMesh.instanceMatrix.needsUpdate = true
    if (customMesh.instanceColor) customMesh.instanceColor.needsUpdate = true
  }

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
    applyCustomBlocks,

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
      customMesh.dispose()
      ground.geometry.dispose()
      groundMat.dispose()
    },

    syncRendererSize,
    requestPointerLock: () => controls.lock(),
    unlockPointer: () => controls.unlock(),
    isPointerLocked: () => controls.isLocked,
  }
}
