import * as THREE from 'three'
import Terrain from '..'
import { blockWorldAggressiveMobile, useTouchGameControls } from '../../utils'

/** Voxel grid half-extent around camera for crosshair pick (smaller = less CPU). */
function highlightPickHalfExtent(): number {
  if (blockWorldAggressiveMobile()) return 5
  if (useTouchGameControls()) return 6
  return 8
}

const _pickPos = new THREE.Vector3()
const _zeroInstance = new THREE.Matrix4().set(
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
)

/**
 * Crosshair voxel highlight: reuses GPU buffers and one pick mesh (no per-frame allocations).
 */
export default class BlockHighlight {
  constructor(
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    terrain: Terrain,
  ) {
    this.camera = camera
    this.scene = scene
    this.terrain = terrain
    this.raycaster = new THREE.Raycaster()
    this.raycaster.far = 8

    this.simMatrixBuffer = new Float32Array(1000 * 16)
    this.instanceMesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(),
      new THREE.MeshBasicMaterial(),
      1000,
    )
    this.instanceMesh.instanceMatrix = new THREE.InstancedBufferAttribute(
      this.simMatrixBuffer,
      16,
    )
    this.instanceMesh.frustumCulled = false

    this.pickMesh = new THREE.Mesh(this.geometry, this.material)
    this.pickMesh.visible = false
    this.scene.add(this.pickMesh)
  }

  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  terrain: Terrain
  raycaster: THREE.Raycaster
  block: THREE.Intersection | null = null

  geometry = new THREE.BoxGeometry(1.01, 1.01, 1.01)
  material = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0.28,
    depthWrite: false,
  })

  instanceMesh: THREE.InstancedMesh
  private readonly simMatrixBuffer: Float32Array
  private readonly pickMesh: THREE.Mesh
  private readonly matrix = new THREE.Matrix4()
  private index = 0

  update() {
    this.index = 0
    this.pickMesh.visible = false
    this.block = null

    const position = this.camera.position
    const noise = this.terrain.noise
    const idMap = new Map<string, number>()

    const xPos = Math.round(position.x)
    const zPos = Math.round(position.z)
    const ext = highlightPickHalfExtent()

    for (let i = -ext; i < ext; i++) {
      for (let j = -ext; j < ext; j++) {
        const x = xPos + i
        const z = zPos + j
        const y =
          Math.floor(
            noise.get(x / noise.gap, z / noise.gap, noise.seed) * noise.amp,
          ) + 30

        idMap.set(`${x}_${y}_${z}`, this.index)
        this.matrix.setPosition(x, y, z)
        this.instanceMesh.setMatrixAt(this.index++, this.matrix)

        const stoneOffset =
          noise.get(x / noise.stoneGap, z / noise.stoneGap, noise.stoneSeed) *
          noise.stoneAmp

        const treeOffset =
          noise.get(x / noise.treeGap, z / noise.treeGap, noise.treeSeed) *
          noise.treeAmp

        if (
          treeOffset > noise.treeThreshold &&
          y - 30 >= -3 &&
          stoneOffset < noise.stoneThreshold
        ) {
          for (let t = 1; t <= noise.treeHeight; t++) {
            idMap.set(`${x}_${y + t}_${z}`, this.index)
            this.matrix.setPosition(x, y + t, z)
            this.instanceMesh.setMatrixAt(this.index++, this.matrix)
          }
        }
      }
    }

    for (const block of this.terrain.customBlocks) {
      if (block.placed) {
        this.matrix.setPosition(block.x, block.y, block.z)
        this.instanceMesh.setMatrixAt(this.index++, this.matrix)
      } else {
        if (idMap.has(`${block.x}_${block.y}_${block.z}`)) {
          const id = idMap.get(`${block.x}_${block.y}_${block.z}`)
          this.instanceMesh.setMatrixAt(id!, _zeroInstance)
        }
      }
    }

    this.instanceMesh.count = this.index
    this.instanceMesh.instanceMatrix.needsUpdate = true

    this.raycaster.setFromCamera({ x: 0, y: 0 }, this.camera)
    const hit = this.raycaster.intersectObject(this.instanceMesh, false)[0]
    if (
      hit &&
      hit.object === this.instanceMesh &&
      typeof hit.instanceId === 'number'
    ) {
      this.block = hit
      this.instanceMesh.getMatrixAt(hit.instanceId, this.matrix)
      _pickPos.setFromMatrixPosition(this.matrix)
      this.pickMesh.position.copy(_pickPos)
      this.pickMesh.visible = true
    }
  }
}
