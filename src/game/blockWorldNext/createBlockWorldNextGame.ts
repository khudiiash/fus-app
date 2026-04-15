import * as THREE from 'three'
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js'
import {
  BLOCK_WORLD_MAX_REACH,
  FIST_MINE_DAMAGE_PER_SWING,
  PLAYER_EYE_HEIGHT,
} from '@/game/playerConstants'
import type { SerializedBlock } from '@/game/sharedWorldFirestore'
import {
  applyStoredPoseToCamera,
  type StoredCameraPose,
} from '@/game/blockWorldLocalPersist'
import { blockTypeHex } from './blockTypeColor'
import { BlockType } from '@/game/minebase/terrain'
import { blockTypeBreakHp } from '@/game/blockWorldBlockStats'

const CHUNK_SIDE = 16
const MAX_SHARED_CUSTOM_BLOCKS = 20_000
const PLACE_COOLDOWN_MS = 220
const MINE_REPEAT_MS = 230

/** Procedural column height for the prototype chunk (original math; not copied from upstream). */
function columnHeight(ix: number, iz: number): number {
  const x = ix - CHUNK_SIDE / 2
  const z = iz - CHUNK_SIDE / 2
  const h = 1.5 + Math.sin(x * 0.35) * Math.cos(z * 0.31) * 2.1
  return Math.max(1, Math.min(6, Math.floor(h)))
}

function isDemoVoxelAt(wx: number, wy: number, wz: number): boolean {
  for (let iz = 0; iz < CHUNK_SIDE; iz++) {
    for (let ix = 0; ix < CHUNK_SIDE; ix++) {
      const h = columnHeight(ix, iz)
      const cx = ix + 0.5
      const cz = iz + 0.5
      if (Math.abs(wx - cx) > 0.501 || Math.abs(wz - cz) > 0.501) continue
      for (let k = 0; k < h; k++) {
        const cy = k + 0.5
        if (Math.abs(wy - cy) < 0.501) return true
      }
    }
  }
  return false
}

function voxelCellFromPointOnSurface(
  point: THREE.Vector3,
  normalWorld: THREE.Vector3,
  outward: boolean,
): { x: number; y: number; z: number } {
  const p = point.clone().addScaledVector(normalWorld, outward ? 0.05 : -0.05)
  return {
    x: Math.floor(p.x) + 0.5,
    y: Math.floor(p.y) + 0.5,
    z: Math.floor(p.z) + 0.5,
  }
}

function blocksPlacedAt(blocks: SerializedBlock[], x: number, y: number, z: number): SerializedBlock | null {
  for (const b of blocks) {
    if (!b.placed) continue
    if (Math.abs(b.x - x) < 1e-4 && Math.abs(b.y - y) < 1e-4 && Math.abs(b.z - z) < 1e-4) return b
  }
  return null
}

function upsertBlock(blocks: SerializedBlock[], edit: SerializedBlock): SerializedBlock[] {
  const m = new Map<string, SerializedBlock>()
  const key = (b: Pick<SerializedBlock, 'x' | 'y' | 'z'>) => `${b.x},${b.y},${b.z}`
  for (const b of blocks) m.set(key(b), { ...b })
  m.set(key(edit), { ...edit })
  return [...m.values()].sort(
    (a, b) =>
      a.x - b.x || a.y - b.y || a.z - b.z || a.type - b.type || Number(a.placed) - Number(b.placed),
  )
}

/** Keys `Digit1`…`Digit9` while pointer-locked (same order as classic-ish palette). */
const PLACE_HOTKEY: BlockType[] = [
  BlockType.grass,
  BlockType.dirt,
  BlockType.stone,
  BlockType.sand,
  BlockType.glass,
  BlockType.wood,
  BlockType.leaf,
  BlockType.quartz,
  BlockType.coal,
]

export type BlockWorldNextGameOptions = {
  onPointerLockChange?: (locked: boolean) => void
  /** After a local mine/place; use to schedule {@link scheduleFlushSharedWorldBlocksList}. */
  onBlocksEdited?: () => void
  /** Fired when player picks another block type for RMB place (keys 1–9). */
  onPlaceTypeChange?: (type: BlockType) => void
}

export type BlockWorldNextSpawnFlag = {
  x: number
  y: number
  z: number
  ry: number
}

export type BlockWorldNextGame = {
  start: () => void
  dispose: () => void
  syncRendererSize: () => void
  applyCustomBlocks: (blocks: SerializedBlock[]) => void
  getWorkingBlocksSnapshot: () => SerializedBlock[]
  getCamera: () => THREE.PerspectiveCamera
  getScene: () => THREE.Scene
  isMovingForPresence: () => boolean
  applyCameraSpawnFromRtdbOrLocal: (
    rtdbFlag: BlockWorldNextSpawnFlag | null,
    storedPose: StoredCameraPose | null,
  ) => void
  requestPointerLock: () => void
  unlockPointer: () => void
  isPointerLocked: () => boolean
  /** Block type used for the next RMB place (hotkeys 1–9). */
  getSelectedPlaceType: () => BlockType
  readonly domElement: HTMLCanvasElement
}

/**
 * First-person slice: demo chunk, live shared blocks, progressive mine (LMB hold),
 * place with RMB (type via keys 1–9), WASD + gravity.
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

  const customMeta: (SerializedBlock | null)[] = new Array(MAX_SHARED_CUSTOM_BLOCKS).fill(null)
  let workingBlocks: SerializedBlock[] = []
  const damageByCell = new Map<string, number>()
  let selectedPlaceType: BlockType = BlockType.grass

  const colorTmp = new THREE.Color()
  const posTmp = new THREE.Vector3()
  const quatId = new THREE.Quaternion()
  const scaleOne = new THREE.Vector3(1, 1, 1)

  const rebuildCustomInstancedFromWorking = () => {
    customMeta.fill(null)
    let idx = 0
    for (const b of workingBlocks) {
      if (!b.placed) continue
      if (idx >= MAX_SHARED_CUSTOM_BLOCKS) break
      posTmp.set(b.x, b.y, b.z)
      m.compose(posTmp, quatId, scaleOne)
      customMesh.setMatrixAt(idx, m)
      colorTmp.setHex(blockTypeHex(b.type))
      customMesh.setColorAt(idx, colorTmp)
      customMeta[idx] = { ...b }
      idx++
    }
    customMesh.count = idx
    customMesh.instanceMatrix.needsUpdate = true
    if (customMesh.instanceColor) customMesh.instanceColor.needsUpdate = true
  }

  const applyCustomBlocks = (blocks: SerializedBlock[]) => {
    damageByCell.clear()
    workingBlocks = blocks.map((b) => ({
      x: b.x,
      y: b.y,
      z: b.z,
      type: b.type,
      placed: b.placed,
    }))
    rebuildCustomInstancedFromWorking()
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
    if (!controls.isLocked || e.repeat) return
    if (e.code >= 'Digit1' && e.code <= 'Digit9') {
      const idx = Number(e.code.slice(5)) - 1
      const t = PLACE_HOTKEY[idx]
      if (t !== undefined && t !== selectedPlaceType) {
        selectedPlaceType = t
        options?.onPlaceTypeChange?.(t)
      }
    }
  }
  const onKeyUp = (e: KeyboardEvent) => keys.delete(e.code)

  const raycaster = new THREE.Raycaster()
  const ndcCenter = new THREE.Vector2(0, 0)
  const hitNormalScratch = new THREE.Vector3()
  let lastPlaceAt = 0
  let mineHoldTimer: ReturnType<typeof setInterval> | null = null

  const cellKeyStr = (x: number, y: number, z: number) => `${x},${y},${z}`

  const trySwingMineOnce = () => {
    if (!controls.isLocked) return
    raycaster.near = 0.06
    raycaster.far = BLOCK_WORLD_MAX_REACH
    raycaster.setFromCamera(ndcCenter, camera)
    const hits = raycaster.intersectObject(customMesh, false)
    if (hits.length === 0) return
    const hit = hits[0]
    if (hit.instanceId == null) return
    const id = hit.instanceId
    if (id < 0 || id >= customMesh.count) return
    const meta = customMeta[id]
    if (!meta || !meta.placed) return
    const bt = meta.type as BlockType
    const maxHp = blockTypeBreakHp(bt)
    if (maxHp === Number.POSITIVE_INFINITY) return
    const k = cellKeyStr(meta.x, meta.y, meta.z)
    const acc = (damageByCell.get(k) ?? 0) + FIST_MINE_DAMAGE_PER_SWING
    if (acc >= maxHp) {
      damageByCell.delete(k)
      workingBlocks = upsertBlock(workingBlocks, {
        x: meta.x,
        y: meta.y,
        z: meta.z,
        type: meta.type,
        placed: false,
      })
      rebuildCustomInstancedFromWorking()
      options?.onBlocksEdited?.()
    } else {
      damageByCell.set(k, acc)
    }
  }

  const tryPlaceOnce = () => {
    if (!controls.isLocked) return
    const now = performance.now()
    if (now - lastPlaceAt < PLACE_COOLDOWN_MS) return
    raycaster.near = 0.06
    raycaster.far = BLOCK_WORLD_MAX_REACH
    raycaster.setFromCamera(ndcCenter, camera)
    const hits = raycaster.intersectObjects([customMesh, inst, ground], false)
    if (hits.length === 0) return
    const hit = hits[0]
    hitNormalScratch.copy(hit.face?.normal ?? new THREE.Vector3(0, 1, 0))
    hitNormalScratch.transformDirection(hit.object.matrixWorld)
    const cell = voxelCellFromPointOnSurface(hit.point, hitNormalScratch, true)
    if (blocksPlacedAt(workingBlocks, cell.x, cell.y, cell.z)) return
    if (isDemoVoxelAt(cell.x, cell.y, cell.z)) return
    const cam = camera.position
    if (
      Math.abs(cam.x - cell.x) < 0.55 &&
      Math.abs(cam.z - cell.z) < 0.55 &&
      cam.y < cell.y + 1.2 &&
      cam.y > cell.y - 0.2
    ) {
      return
    }
    workingBlocks = upsertBlock(workingBlocks, {
      x: cell.x,
      y: cell.y,
      z: cell.z,
      type: selectedPlaceType,
      placed: true,
    })
    rebuildCustomInstancedFromWorking()
    lastPlaceAt = now
    options?.onBlocksEdited?.()
  }

  const clearMineHold = () => {
    if (mineHoldTimer) {
      clearInterval(mineHoldTimer)
      mineHoldTimer = null
    }
  }

  const onMouseDown = (e: MouseEvent) => {
    if (e.button === 0) {
      clearMineHold()
      trySwingMineOnce()
      mineHoldTimer = setInterval(trySwingMineOnce, MINE_REPEAT_MS)
    } else if (e.button === 2) {
      tryPlaceOnce()
    }
  }

  const onWindowMouseUp = (e: MouseEvent) => {
    if (e.button === 0) clearMineHold()
  }

  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault()
  }

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

  const applyCameraSpawnFromRtdbOrLocal = (
    rtdbFlag: BlockWorldNextSpawnFlag | null,
    storedPose: StoredCameraPose | null,
  ) => {
    if (rtdbFlag) {
      camera.position.set(
        rtdbFlag.x,
        rtdbFlag.y + PLAYER_EYE_HEIGHT + 0.08,
        rtdbFlag.z,
      )
      camera.quaternion.setFromEuler(new THREE.Euler(0, rtdbFlag.ry, 0, 'YXZ'))
      return
    }
    if (storedPose) applyStoredPoseToCamera(camera, storedPose)
  }

  const isMovingForPresence = () => {
    if (
      keys.has('KeyW') ||
      keys.has('KeyS') ||
      keys.has('KeyA') ||
      keys.has('KeyD') ||
      keys.has('Space')
    ) {
      return true
    }
    return Math.abs(velocityY.v) > 0.45
  }

  return {
    domElement: renderer.domElement,
    applyCustomBlocks,
    getWorkingBlocksSnapshot: () => workingBlocks.map((b) => ({ ...b })),
    getCamera: () => camera,
    getScene: () => scene,
    isMovingForPresence,
    applyCameraSpawnFromRtdbOrLocal,

    start() {
      if (running) return
      mountEl.appendChild(renderer.domElement)
      window.addEventListener('keydown', onKeyDown)
      window.addEventListener('keyup', onKeyUp)
      window.addEventListener('mouseup', onWindowMouseUp)
      renderer.domElement.addEventListener('mousedown', onMouseDown)
      renderer.domElement.addEventListener('contextmenu', onContextMenu)
      syncRendererSize()
      clock.getDelta()
      running = true
      options?.onPlaceTypeChange?.(selectedPlaceType)
      tick()
    },

    dispose() {
      running = false
      clearMineHold()
      cancelAnimationFrame(raf)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('mouseup', onWindowMouseUp)
      renderer.domElement.removeEventListener('mousedown', onMouseDown)
      renderer.domElement.removeEventListener('contextmenu', onContextMenu)
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
    getSelectedPlaceType: () => selectedPlaceType,
  }
}
