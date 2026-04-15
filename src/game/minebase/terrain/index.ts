import * as THREE from 'three'
import Materials, { MaterialType } from './mesh/materials'
import Block from './mesh/block'
import Highlight from './highlight'
import Noise from './noise'

import Generate from './worker/generate?worker'

/** Fewer generated chunks on phones / coarse pointer (big CPU+GPU win). */
function terrainReducedViewRange(): boolean {
  if (typeof window === 'undefined') return false
  return (
    (navigator.maxTouchPoints || 0) > 0 ||
    (window.matchMedia?.('(pointer: coarse)').matches ?? false)
  )
}

export enum BlockType {
  grass = 0,
  sand = 1,
  tree = 2,
  leaf = 3,
  dirt = 4,
  stone = 5,
  coal = 6,
  wood = 7,
  diamond = 8,
  quartz = 9,
  glass = 10,
  bedrock = 11
}
export default class Terrain {
  constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    this.scene = scene
    this.camera = camera
    this.maxCount =
      (this.distance * this.chunkSize * 2 + this.chunkSize) ** 2 + 500
    this.highlight = new Highlight(scene, camera, this)
    this.scene.add(this.cloud)

    this.generateWorker.onerror = (ev) => {
      console.error('[minebase terrain worker]', ev.message || ev)
    }
    this.generateWorker.onmessage = (
      msg: MessageEvent<{
        idMap: Map<string, number>
        arrays: ArrayLike<number>[]
        blocksCount: number[]
      }>,
    ) => {
      try {
        this.idMap = msg.data.idMap
        this.blocksCount = msg.data.blocksCount

        for (let i = 0; i < msg.data.arrays.length; i++) {
          const src = msg.data.arrays[i]
          const mesh = this.blocks[i]
          if (!mesh) continue
          const cnt = Math.max(0, this.blocksCount[i] ?? 0)
          const attr = mesh.instanceMatrix as THREE.InstancedBufferAttribute
          const dst = attr.array as Float32Array
          const srcLen = (src as ArrayLike<number>).length
          if (dst.length === srcLen) {
            dst.set(src as ArrayLike<number> as Float32Array)
            attr.needsUpdate = true
          } else {
            const buf = new Float32Array(srcLen)
            buf.set(src as ArrayLike<number>)
            mesh.instanceMatrix = new THREE.InstancedBufferAttribute(buf, 16)
            mesh.instanceMatrix.needsUpdate = true
          }
          mesh.count = cnt
          // Raycast / culling use cached bounds; stale sphere after matrix edits rejects all hits.
          mesh.boundingSphere = null
          mesh.boundingBox = null
        }

        if (!this._firstGenerateDone) {
          this._firstGenerateDone = true
          this._resolveFirstGenerate?.()
          this._resolveFirstGenerate = null
        }
      } catch (err) {
        console.error('[minebase terrain] onmessage', err)
      }
    }
  }
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  distance = terrainReducedViewRange() ? 2 : 3
  chunkSize = 24

  maxCount: number
  chunk = new THREE.Vector2(0, 0)
  previousChunk = new THREE.Vector2(0, 0)
  noise = new Noise()

  materials = new Materials()
  materialType = [
    MaterialType.grass,
    MaterialType.sand,
    MaterialType.tree,
    MaterialType.leaf,
    MaterialType.dirt,
    MaterialType.stone,
    MaterialType.coal,
    MaterialType.wood,
    MaterialType.diamond,
    MaterialType.quartz,
    MaterialType.glass,
    MaterialType.bedrock
  ]

  blocks: THREE.InstancedMesh[] = []
  blocksCount: number[] = []
  blocksFactor = [1, 0.2, 0.1, 0.7, 0.1, 0.2, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1]

  customBlocks: Block[] = []
  private customBlockListeners: Array<() => void> = []
  /** Throttle expensive {@link BlockHighlight.update} (ms). */
  private lastHighlightUpdateMs = 0
  onCustomBlockChange(cb: () => void) {
    this.customBlockListeners.push(cb)
  }
  touchCustomBlocks() {
    for (const cb of this.customBlockListeners) {
      cb()
    }
  }

  highlight: Highlight

  idMap = new Map<string, number>()
  generateWorker = new Generate()
  private _firstGeneratePromise: Promise<void> | null = null
  private _resolveFirstGenerate: (() => void) | null = null
  private _firstGenerateDone = false

  waitForFirstGenerate = () => {
    if (this._firstGenerateDone) return Promise.resolve()
    if (!this._firstGeneratePromise) {
      this._firstGeneratePromise = new Promise<void>((resolve) => {
        this._resolveFirstGenerate = resolve
      })
    }
    return this._firstGeneratePromise
  }

  cloud = new THREE.InstancedMesh(
    new THREE.BoxGeometry(20, 5, 14),
    new THREE.MeshStandardMaterial({
      transparent: true,
      color: 0xffffff,
      opacity: 0.4
    }),
    1000
  )
  cloudCount = 0
  cloudGap = 5

  getCount = (type: BlockType) => {
    return this.blocksCount[type]
  }

  setCount = (type: BlockType) => {
    this.blocksCount[type] = this.blocksCount[type] + 1
    // InstancedMesh.count limits how many instances render; blocksCount alone is not enough
    // (otherwise new blocks only appear after the worker round-trip — “ghost” from highlight).
    const mesh = this.blocks[type]
    if (mesh) {
      const cap = mesh.instanceMatrix.count
      mesh.count = Math.min(Math.max(0, this.blocksCount[type] ?? 0), cap)
    }
  }

  initBlocks = () => {
    for (const block of this.blocks) {
      this.scene.remove(block)
    }
    this.blocks = []

    const geometry = new THREE.BoxGeometry()

    for (let i = 0; i < this.materialType.length; i++) {
      const mesh = new THREE.InstancedMesh(
        geometry,
        this.materials.get(this.materialType[i]),
        this.maxCount * this.blocksFactor[i],
      )
      mesh.name = BlockType[i]
      mesh.frustumCulled = false
      this.blocks.push(mesh)
      this.scene.add(mesh)
    }

    this.blocksCount = new Array(this.materialType.length).fill(0)
  }

  generate = () => {
    const zeroCounts = new Array(this.blocks.length).fill(0)
    const customBlocksPlain = this.customBlocks.map((b) => ({
      x: b.x,
      y: b.y,
      z: b.z,
      type: b.type,
      placed: b.placed,
    }))
    this.generateWorker.postMessage({
      distance: this.distance,
      chunk: { x: this.chunk.x, y: this.chunk.y },
      noiseSeed: this.noise.seed,
      treeSeed: this.noise.treeSeed,
      stoneSeed: this.noise.stoneSeed,
      coalSeed: this.noise.coalSeed,
      leafSeed: this.noise.leafSeed,
      idMap: new Map<string, number>(),
      blocksFactor: this.blocksFactor,
      blocksCount: zeroCounts,
      customBlocks: customBlocksPlain,
      chunkSize: this.chunkSize,
    })

    if (this.cloudGap++ > 5) {
      this.cloudGap = 0
      this.cloud.instanceMatrix = new THREE.InstancedBufferAttribute(
        new Float32Array(1000 * 16),
        16
      )
      this.cloudCount = 0
      for (
        let x =
          -this.chunkSize * this.distance * 3 + this.chunkSize * this.chunk.x;
        x <
        this.chunkSize * this.distance * 3 +
          this.chunkSize +
          this.chunkSize * this.chunk.x;
        x += 20
      ) {
        for (
          let z =
            -this.chunkSize * this.distance * 3 + this.chunkSize * this.chunk.y;
          z <
          this.chunkSize * this.distance * 3 +
            this.chunkSize +
            this.chunkSize * this.chunk.y;
          z += 20
        ) {
          const matrix = new THREE.Matrix4()
          matrix.setPosition(x, 80 + (Math.random() - 0.5) * 30, z)

          if (Math.random() > 0.8) {
            this.cloud.setMatrixAt(this.cloudCount++, matrix)
          }
        }
      }
      this.cloud.instanceMatrix.needsUpdate = true
      this.cloud.boundingSphere = null
      this.cloud.boundingBox = null
    }
  }

  generateAdjacentBlocks = (position: THREE.Vector3) => {
    const { x, y, z } = position
    const noise = this.noise
    const yOffset = Math.floor(
      noise.get(x / noise.gap, z / noise.gap, noise.seed) * noise.amp
    )

    if (y > 30 + yOffset) {
      return
    }

    const stoneOffset =
      noise.get(x / noise.stoneGap, z / noise.stoneGap, noise.stoneSeed) *
      noise.stoneAmp

    let type: BlockType

    if (stoneOffset > noise.stoneThreshold || y < 23) {
      type = BlockType.stone
    } else {
      if (yOffset < -3) {
        type = BlockType.sand
      } else {
        type = BlockType.dirt
      }
    }

    this.buildBlock(new THREE.Vector3(x, y - 1, z), type)
    this.buildBlock(new THREE.Vector3(x, y + 1, z), type)
    this.buildBlock(new THREE.Vector3(x - 1, y, z), type)
    this.buildBlock(new THREE.Vector3(x + 1, y, z), type)
    this.buildBlock(new THREE.Vector3(x, y, z - 1), type)
    this.buildBlock(new THREE.Vector3(x, y, z + 1), type)

    this.blocks[type].instanceMatrix.needsUpdate = true
  }

  buildBlock = (position: THREE.Vector3, type: BlockType) => {
    const noise = this.noise
    const yOffset = Math.floor(
      noise.get(position.x / noise.gap, position.z / noise.gap, noise.seed) *
        noise.amp
    )
    if (position.y >= 30 + yOffset || position.y < 0) {
      return
    }

    position.y === 0 && (type = BlockType.bedrock)

    for (const block of this.customBlocks) {
      if (
        block.x === position.x &&
        block.y === position.y &&
        block.z === position.z
      ) {
        return
      }
    }

    this.customBlocks.push(
      new Block(position.x, position.y, position.z, type, true)
    )

    const matrix = new THREE.Matrix4()
    matrix.setPosition(position)
    const mesh = this.blocks[type]
    mesh.setMatrixAt(this.getCount(type), matrix)
    mesh.instanceMatrix.needsUpdate = true
    mesh.boundingSphere = null
    mesh.boundingBox = null
    this.setCount(type)
    this.touchCustomBlocks()
  }

  update = () => {
    this.chunk.set(
      Math.floor(this.camera.position.x / this.chunkSize),
      Math.floor(this.camera.position.z / this.chunkSize)
    )

    if (
      this.chunk.x !== this.previousChunk.x ||
      this.chunk.y !== this.previousChunk.y
    ) {
      this.generate()
    }

    this.previousChunk.copy(this.chunk)

    const t = performance.now()
    const interval = terrainReducedViewRange() ? 140 : 110
    if (t - this.lastHighlightUpdateMs >= interval) {
      this.lastHighlightUpdateMs = t
      this.highlight.update()
    }
  }
}
