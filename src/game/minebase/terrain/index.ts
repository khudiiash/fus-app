import * as THREE from 'three'
import Materials, { MaterialType } from './mesh/materials'
import Block from './mesh/block'
import Highlight from './highlight'
import Noise from './noise'

import Generate from './worker/generate?worker'

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

    // generate worker callback handler
    this.generateWorker.onerror = (ev) => {
      console.error('[minebase terrain worker]', ev.message || ev)
    }
    this.generateWorker.onmessage = (
      msg: MessageEvent<{
        idMap: Map<string, number>
        arrays: ArrayLike<number>[]
        blocksCount: number[]
      }>
    ) => {
      try {
        this.resetBlocks()
        this.idMap = msg.data.idMap
        this.blocksCount = msg.data.blocksCount

        for (let i = 0; i < msg.data.arrays.length; i++) {
          const src = msg.data.arrays[i]
          const buf = new Float32Array(src.length)
          buf.set(src as ArrayLike<number>)
          const mesh = this.blocks[i]
          mesh.instanceMatrix = new THREE.InstancedBufferAttribute(buf, 16)
          mesh.count = Math.max(0, this.blocksCount[i] ?? 0)
          mesh.instanceMatrix.needsUpdate = true
          // InstancedMesh caches bounds for culling; stale sphere after matrix replace culls everything (blue sky).
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
  // core properties
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  distance = 3
  chunkSize = 24

  // terrain properties
  maxCount: number
  chunk = new THREE.Vector2(0, 0)
  previousChunk = new THREE.Vector2(0, 0)
  noise = new Noise()

  // materials
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

  // other properties
  blocks: THREE.InstancedMesh[] = []
  blocksCount: number[] = []
  blocksFactor = [1, 0.2, 0.1, 0.7, 0.1, 0.2, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1]

  customBlocks: Block[] = []
  /** Fus: notified when customBlocks change (place/break) for multiplayer sync. */
  private customBlockListeners: Array<() => void> = []
  /** Re-run terrain worker shortly after edits so idMap / instancing match customBlocks without waiting for Firestore. */
  private customChangeGenerateTimer: ReturnType<typeof setTimeout> | null = null
  onCustomBlockChange(cb: () => void) {
    this.customBlockListeners.push(cb)
  }
  private scheduleGenerateFromCustomChange = () => {
    if (this.customChangeGenerateTimer) {
      clearTimeout(this.customChangeGenerateTimer)
    }
    this.customChangeGenerateTimer = setTimeout(() => {
      this.customChangeGenerateTimer = null
      this.generate()
    }, 56)
  }
  touchCustomBlocks() {
    for (const cb of this.customBlockListeners) {
      cb()
    }
    this.scheduleGenerateFromCustomChange()
  }

  highlight: Highlight

  idMap = new Map<string, number>()
  generateWorker = new Generate()
  /** Resolves once after the first successful worker → main terrain mesh update. */
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

  // cloud
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
  }

  initBlocks = () => {
    // reset
    for (const block of this.blocks) {
      this.scene.remove(block)
    }
    this.blocks = []

    // create instance meshes
    const geometry = new THREE.BoxGeometry()

    for (let i = 0; i < this.materialType.length; i++) {
      let block = new THREE.InstancedMesh(
        geometry,
        this.materials.get(this.materialType[i]),
        this.maxCount * this.blocksFactor[i]
      )
      block.name = BlockType[i]
      this.blocks.push(block)
      this.scene.add(block)
    }

    this.blocksCount = new Array(this.materialType.length).fill(0)
  }

  resetBlocks = () => {
    // reest count and instance matrix
    for (let i = 0; i < this.blocks.length; i++) {
      this.blocks[i].instanceMatrix = new THREE.InstancedBufferAttribute(
        new Float32Array(this.maxCount * this.blocksFactor[i] * 16),
        16
      )
    }
  }

  generate = () => {
    this.blocksCount = new Array(this.blocks.length).fill(0)
    // post work to generate worker
    this.generateWorker.postMessage({
      distance: this.distance,
      chunk: this.chunk,
      noiseSeed: this.noise.seed,
      treeSeed: this.noise.treeSeed,
      stoneSeed: this.noise.stoneSeed,
      coalSeed: this.noise.coalSeed,
      leafSeed: this.noise.leafSeed,
      idMap: new Map<string, number>(),
      blocksFactor: this.blocksFactor,
      blocksCount: this.blocksCount,
      customBlocks: this.customBlocks,
      chunkSize: this.chunkSize
    })

    // cloud

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

  // generate adjacent blocks after removing a block (vertical infinity world)
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
    // check if it's natural terrain
    const yOffset = Math.floor(
      noise.get(position.x / noise.gap, position.z / noise.gap, noise.seed) *
        noise.amp
    )
    if (position.y >= 30 + yOffset || position.y < 0) {
      return
    }

    position.y === 0 && (type = BlockType.bedrock)

    // check custom blocks
    for (const block of this.customBlocks) {
      if (
        block.x === position.x &&
        block.y === position.y &&
        block.z === position.z
      ) {
        return
      }
    }

    // build block
    this.customBlocks.push(
      new Block(position.x, position.y, position.z, type, true)
    )

    const matrix = new THREE.Matrix4()
    matrix.setPosition(position)
    this.blocks[type].setMatrixAt(this.getCount(type), matrix)
    this.blocks[type].instanceMatrix.needsUpdate = true
    this.setCount(type)
    this.touchCustomBlocks()
  }

  update = () => {
    this.chunk.set(
      Math.floor(this.camera.position.x / this.chunkSize),
      Math.floor(this.camera.position.z / this.chunkSize)
    )

    //generate terrain when getting into new chunk
    if (
      this.chunk.x !== this.previousChunk.x ||
      this.chunk.y !== this.previousChunk.y
    ) {
      this.generate()
    }

    this.previousChunk.copy(this.chunk)

    this.highlight.update()
  }
}
