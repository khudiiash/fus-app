import * as THREE from 'three'
import Stats from 'three/addons/libs/stats.module.js'
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js'
import {
  BLOCK_WORLD_MAX_REACH,
  FIST_MINE_DAMAGE_PER_SWING,
  PLAYER_EYE_HEIGHT,
} from '@/game/playerConstants'
import type {
  SerializedBlock,
  SharedWorldInitialState,
  SharedWorldSeeds,
} from '@/game/sharedWorldFirestore'
import {
  applyStoredPoseToCamera,
  type StoredCameraPose,
} from '@/game/blockWorldLocalPersist'
import Terrain, { BlockType } from '@/game/minebase/terrain'
import Block from '@/game/minebase/terrain/mesh/block'
import { TERRAIN_Y_BASE, terrainSurfaceYOffset } from '@/game/minebase/terrain/surfaceHeight'
import { blockTypeBreakHp } from '@/game/blockWorldBlockStats'
import { blockWorldNextLowGpu } from '@/game/minebase/utils'

const PLACE_COOLDOWN_MS = 220
const MINE_REPEAT_MS = 230

function blocksPlacedAt(blocks: SerializedBlock[], x: number, y: number, z: number): SerializedBlock | null {
  const rx = Math.round(x)
  const ry = Math.round(y)
  const rz = Math.round(z)
  for (const b of blocks) {
    if (!b.placed) continue
    if (Math.round(b.x) === rx && Math.round(b.y) === ry && Math.round(b.z) === rz) return b
  }
  return null
}

function customEntryAt(blocks: SerializedBlock[], rx: number, ry: number, rz: number): SerializedBlock | null {
  for (const b of blocks) {
    if (Math.round(b.x) === rx && Math.round(b.y) === ry && Math.round(b.z) === rz) return b
  }
  return null
}

function upsertBlock(blocks: SerializedBlock[], edit: SerializedBlock): SerializedBlock[] {
  const m = new Map<string, SerializedBlock>()
  const key = (b: Pick<SerializedBlock, 'x' | 'y' | 'z'>) =>
    `${Math.round(b.x)},${Math.round(b.y)},${Math.round(b.z)}`
  for (const b of blocks) m.set(key(b), { ...b })
  m.set(key(edit), { ...edit })
  return [...m.values()].sort(
    (a, b) =>
      a.x - b.x || a.y - b.y || a.z - b.z || a.type - b.type || Number(a.placed) - Number(b.placed),
  )
}

function workingBlocksToTerrainBlocks(blocks: SerializedBlock[]): Block[] {
  return blocks.map((b) => new Block(b.x, b.y, b.z, b.type as BlockType, b.placed))
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
  /** Resolves after the terrain worker’s first mesh post (safe to rely on `terrain.idMap`). */
  waitTerrainReady: () => Promise<void>
  /**
   * Same data path as classic {@link initSharedWorldFromFirestore}: noise seeds + custom blocks
   * from one {@link loadSharedWorldInitialState} result. Call before {@link start}.
   */
  configureFromSharedInitialState: (initial: SharedWorldInitialState) => void
  readonly domElement: HTMLCanvasElement
}

function disposeTerrainVisuals(scene: THREE.Scene, terrain: Terrain) {
  try {
    terrain.generateWorker.terminate()
  } catch {
    /* ignore */
  }
  const hl = terrain.highlight as unknown as {
    pickMesh: THREE.Mesh
    instanceMesh: THREE.InstancedMesh
  }
  scene.remove(hl.pickMesh)
  hl.pickMesh.geometry.dispose()
  ;(hl.pickMesh.material as THREE.Material).dispose()
  hl.instanceMesh.dispose()
  scene.remove(terrain.cloud)
  terrain.cloud.dispose()
  for (const mesh of terrain.blocks) {
    scene.remove(mesh)
  }
  terrain.blocks = []
  terrain.blocksCount = []
}

/**
 * Shared-world slice: minebase {@link Terrain} (worker + noise), live `customBlocks`,
 * progressive fist mine, RMB place, WASD + simple ground collision.
 */
export function createBlockWorldNextGame(
  mountEl: HTMLElement,
  options?: BlockWorldNextGameOptions,
): BlockWorldNextGame {
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x87b8e8)
  const lowGpu = blockWorldNextLowGpu()
  scene.fog = new THREE.Fog(0x87b8e8, 48, lowGpu ? 200 : 280)

  const camera = new THREE.PerspectiveCamera(70, 1, 0.08, lowGpu ? 240 : 512)
  /** Match {@link Core.initCamera} defaults so the first terrain chunk matches classic `/student/world`. */
  camera.position.set(8, 50, 8)
  camera.lookAt(100, 30, 100)

  let appliedSeeds: SharedWorldSeeds | undefined

  const renderer = new THREE.WebGLRenderer({
    antialias: !lowGpu,
    alpha: false,
    powerPreference: 'high-performance',
    stencil: false,
  })
  renderer.setPixelRatio(
    lowGpu ? Math.min(window.devicePixelRatio || 1, 1) : Math.min(window.devicePixelRatio || 1, 2),
  )
  renderer.outputColorSpace = THREE.SRGBColorSpace
  if (lowGpu) {
    renderer.toneMapping = THREE.NoToneMapping
    renderer.toneMappingExposure = 1
  } else {
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.05
  }
  renderer.shadowMap.enabled = !lowGpu
  if (!lowGpu) {
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
  }

  const hemi = new THREE.HemisphereLight(0xbfd4ff, 0x6b5344, lowGpu ? 0.62 : 0.55)
  scene.add(hemi)
  const sun = new THREE.DirectionalLight(0xfff2dc, lowGpu ? 0.88 : 0.95)
  sun.position.set(30, 48, 20)
  sun.castShadow = !lowGpu
  if (!lowGpu) {
    sun.shadow.mapSize.setScalar(1024)
    sun.shadow.camera.near = 0.5
    sun.shadow.camera.far = 220
    sun.shadow.camera.left = -96
    sun.shadow.camera.right = 96
    sun.shadow.camera.top = 96
    sun.shadow.camera.bottom = -96
  }
  scene.add(sun)
  if (lowGpu) {
    scene.add(new THREE.AmbientLight(0xe8f0ff, 0.38))
  }

  const terrain = new Terrain(scene, camera)

  let workingBlocks: SerializedBlock[] = []
  const damageByCell = new Map<string, number>()
  let selectedPlaceType: BlockType = BlockType.grass
  let lastMineCellKey = ''

  const m = new THREE.Matrix4()
  const zeroMatrix = new THREE.Matrix4().set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
  const posTmp = new THREE.Vector3()

  const pushWorkingBlocksToTerrain = () => {
    terrain.customBlocks = workingBlocksToTerrainBlocks(workingBlocks)
  }

  const regenerateFromRemote = () => {
    damageByCell.clear()
    lastMineCellKey = ''
    pushWorkingBlocksToTerrain()
    terrain.generate()
  }

  const applyCustomBlocks = (blocks: SerializedBlock[]) => {
    workingBlocks = blocks.map((b) => ({
      x: b.x,
      y: b.y,
      z: b.z,
      type: b.type,
      placed: b.placed,
    }))
    if (running) {
      regenerateFromRemote()
    }
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
  const groundRay = new THREE.Raycaster()
  const groundRayOrigin = new THREE.Vector3()
  const down = new THREE.Vector3(0, -1, 0)
  let lastPlaceAt = 0
  let mineHoldTimer: ReturnType<typeof setInterval> | null = null

  const cellKeyStr = (x: number, y: number, z: number) =>
    `${Math.round(x)},${Math.round(y)},${Math.round(z)}`

  const isCellSolid = (rx: number, ry: number, rz: number) => {
    const c = customEntryAt(workingBlocks, rx, ry, rz)
    if (c) return c.placed === true
    return terrain.idMap.has(`${rx}_${ry}_${rz}`)
  }

  const trySwingMineOnce = () => {
    if (!controls.isLocked) return
    raycaster.near = 0.06
    raycaster.far = BLOCK_WORLD_MAX_REACH
    raycaster.setFromCamera(ndcCenter, camera)
    const hit = raycaster.intersectObjects(terrain.blocks, false)[0]
    if (!hit || !(hit.object instanceof THREE.InstancedMesh)) return
    const mesh = hit.object
    const blockTypeEnum = BlockType[mesh.name as keyof typeof BlockType] as unknown as BlockType
    if (blockTypeEnum === BlockType.bedrock || blockTypeEnum === BlockType.water) {
      mesh.getMatrixAt(hit.instanceId!, m)
      const p = posTmp.setFromMatrixPosition(m)
      terrain.generateAdjacentBlocks(p)
      return
    }
    mesh.getMatrixAt(hit.instanceId!, m)
    const position = posTmp.setFromMatrixPosition(m)
    const cellKey = cellKeyStr(position.x, position.y, position.z)
    if (lastMineCellKey !== cellKey) {
      damageByCell.clear()
      lastMineCellKey = cellKey
    }
    const hpMax = blockTypeBreakHp(blockTypeEnum)
    if (Number.isFinite(hpMax)) {
      const acc = (damageByCell.get(cellKey) ?? 0) + FIST_MINE_DAMAGE_PER_SWING
      if (acc < hpMax) {
        damageByCell.set(cellKey, acc)
        return
      }
      damageByCell.delete(cellKey)
    }

    mesh.setMatrixAt(hit.instanceId!, zeroMatrix)
    mesh.instanceMatrix.needsUpdate = true
    mesh.boundingSphere = null
    mesh.boundingBox = null

    workingBlocks = upsertBlock(workingBlocks, {
      x: position.x,
      y: position.y,
      z: position.z,
      type: blockTypeEnum,
      placed: false,
    })
    pushWorkingBlocksToTerrain()

    terrain.generateAdjacentBlocks(position)
    terrain.touchCustomBlocks()
    options?.onBlocksEdited?.()
  }

  const tryPlaceOnce = () => {
    if (!controls.isLocked) return
    const now = performance.now()
    if (now - lastPlaceAt < PLACE_COOLDOWN_MS) return
    raycaster.near = 0.06
    raycaster.far = BLOCK_WORLD_MAX_REACH
    raycaster.setFromCamera(ndcCenter, camera)
    const hit = raycaster.intersectObjects(terrain.blocks, false)[0]
    if (!hit || !(hit.object instanceof THREE.InstancedMesh) || !hit.face) return

    hitNormalScratch.copy(hit.face.normal)
    hitNormalScratch.transformDirection(hit.object.matrixWorld)

    hit.object.getMatrixAt(hit.instanceId!, m)
    const base = posTmp.setFromMatrixPosition(m)
    const px = base.x + hitNormalScratch.x
    const py = base.y + hitNormalScratch.y
    const pz = base.z + hitNormalScratch.z

    if (
      Math.round(px) === Math.round(camera.position.x) &&
      Math.round(pz) === Math.round(camera.position.z) &&
      (Math.round(py) === Math.round(camera.position.y) ||
        Math.round(py) === Math.round(camera.position.y - PLAYER_EYE_HEIGHT))
    ) {
      return
    }

    const rx = Math.round(px)
    const ry = Math.round(py)
    const rz = Math.round(pz)
    if (blocksPlacedAt(workingBlocks, px, py, pz)) return
    if (isCellSolid(rx, ry, rz)) return

    const cam = camera.position
    if (
      Math.abs(cam.x - px) < 0.55 &&
      Math.abs(cam.z - pz) < 0.55 &&
      cam.y < py + 1.2 &&
      cam.y > py - 0.2
    ) {
      return
    }

    workingBlocks = upsertBlock(workingBlocks, {
      x: px,
      y: py,
      z: pz,
      type: selectedPlaceType,
      placed: true,
    })
    pushWorkingBlocksToTerrain()

    m.setPosition(px, py, pz)
    const placeMesh = terrain.blocks[selectedPlaceType]
    placeMesh.setMatrixAt(terrain.getCount(selectedPlaceType), m)
    terrain.setCount(selectedPlaceType)
    placeMesh.instanceMatrix.needsUpdate = true
    placeMesh.boundingSphere = null
    placeMesh.boundingBox = null

    lastPlaceAt = now
    terrain.touchCustomBlocks()
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
  let stats: InstanceType<typeof Stats> | null = null
  const velocityY = { v: 0 }
  const moveSpeed = 19
  const gravity = 34
  let onGround = false

  const scratchDir = new THREE.Vector3()
  const scratchRight = new THREE.Vector3()

  /** Match `terrain/worker/generate.ts` (via `surfaceHeight.ts`). */
  const analyticTerrainSurfaceTop = (wx: number, wz: number) => {
    const x = Math.round(wx)
    const z = Math.round(wz)
    return TERRAIN_Y_BASE + terrainSurfaceYOffset(terrain.noise, x, z) + 0.5
  }

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
      if (keys.has('Space') && onGround) {
        velocityY.v = 9.2
      }
    }
    velocityY.v -= gravity * dt
    camera.position.y += velocityY.v * dt

    terrain.update()

    const feetY = camera.position.y - PLAYER_EYE_HEIGHT
    const rayStartY = Math.max(feetY + 12, camera.position.y + 1.5, 44)
    groundRayOrigin.set(camera.position.x, rayStartY, camera.position.z)
    groundRay.set(groundRayOrigin, down)
    groundRay.far = rayStartY + 200

    let hits = groundRay.intersectObjects(terrain.blocks, false)
    if (hits.length === 0) {
      for (const mesh of terrain.blocks) {
        if (mesh.count > 0) mesh.computeBoundingSphere()
      }
      hits = groundRay.intersectObjects(terrain.blocks, false)
    }

    let bestFloorY = -Infinity
    for (const h of hits) {
      if (!h.face) continue
      hitNormalScratch.copy(h.face.normal).transformDirection(h.object.matrixWorld)
      if (hitNormalScratch.y < 0.28) continue
      if (h.point.y > feetY + 0.55) continue
      if (h.point.y > bestFloorY) bestFloorY = h.point.y
    }
    if (!Number.isFinite(bestFloorY)) {
      for (const h of hits) {
        if (h.point.y <= feetY + 2.2 && h.point.y > bestFloorY) bestFloorY = h.point.y
      }
    }
    if (!Number.isFinite(bestFloorY)) {
      bestFloorY = analyticTerrainSurfaceTop(camera.position.x, camera.position.z)
    }

    const minCamY = bestFloorY + 0.06 + PLAYER_EYE_HEIGHT
    onGround = feetY <= bestFloorY + 0.2
    if (camera.position.y < minCamY) {
      camera.position.y = minCamY
      velocityY.v = Math.min(0, velocityY.v)
    }
    if (camera.position.y < PLAYER_EYE_HEIGHT - 120) {
      const rescueY =
        analyticTerrainSurfaceTop(camera.position.x, camera.position.z) +
        PLAYER_EYE_HEIGHT +
        0.12
      camera.position.y = rescueY
      velocityY.v = 0
    }
    stats?.begin()
    renderer.render(scene, camera)
    stats?.end()
  }

  const syncRendererSize = () => {
    const w = mountEl.clientWidth || 1
    const h = mountEl.clientHeight || 1
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    renderer.setSize(w, h, false)
  }

  const applySeeds = () => {
    const seeds = appliedSeeds
    if (!seeds) return
    const n = terrain.noise
    n.seed = seeds.noise
    n.stoneSeed = seeds.stone
    n.treeSeed = seeds.tree
    n.coalSeed = seeds.coal
    n.leafSeed = seeds.leaf
  }

  /**
   * Classic applies spawn after the first generate while the camera is still near the Core default,
   * so chunk (0,0) is correct. World-next applies spawn before start — align worker chunk with the
   * camera so the first `generate()` covers the column the player will stand in.
   */
  const syncTerrainChunkFromCamera = () => {
    const cx = Math.floor(camera.position.x / terrain.chunkSize)
    const cz = Math.floor(camera.position.z / terrain.chunkSize)
    terrain.chunk.set(cx, cz)
    terrain.previousChunk.copy(terrain.chunk)
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

  const configureFromSharedInitialState = (initial: SharedWorldInitialState) => {
    appliedSeeds = initial.seeds
    applyCustomBlocks(initial.blocks)
  }

  return {
    domElement: renderer.domElement,
    configureFromSharedInitialState,
    applyCustomBlocks,
    getWorkingBlocksSnapshot: () => workingBlocks.map((b) => ({ ...b })),
    getCamera: () => camera,
    getScene: () => scene,
    isMovingForPresence,
    applyCameraSpawnFromRtdbOrLocal,
    waitTerrainReady: () => terrain.waitForFirstGenerate(),

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
      applySeeds()
      syncTerrainChunkFromCamera()
      terrain.initBlocks()
      pushWorkingBlocksToTerrain()
      terrain.generate()
      running = true
      options?.onPlaceTypeChange?.(selectedPlaceType)
      if (import.meta.env.DEV) {
        stats = new Stats()
        stats.showPanel(0)
        const st = stats.dom
        st.style.position = 'absolute'
        st.style.left = '0'
        st.style.bottom = '0'
        st.style.top = 'auto'
        st.style.zIndex = '130'
        mountEl.appendChild(st)
      }
      tick()
    },

    dispose() {
      running = false
      clearMineHold()
      cancelAnimationFrame(raf)
      if (stats) {
        const el = stats.dom
        if (el.parentNode) el.parentNode.removeChild(el)
        stats = null
      }
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
      disposeTerrainVisuals(scene, terrain)
      scene.remove(hemi)
      scene.remove(sun)
      hemi.dispose()
      sun.dispose()
    },

    syncRendererSize,
    requestPointerLock: () => controls.lock(),
    unlockPointer: () => controls.unlock(),
    isPointerLocked: () => controls.isLocked,
    getSelectedPlaceType: () => selectedPlaceType,
  }
}
