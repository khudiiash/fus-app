import * as THREE from 'three'
import Noise from '../noise'
import { TERRAIN_SEA_LEVEL, TERRAIN_Y_BASE, terrainSurfaceYOffset } from '../surfaceHeight'

type CustomBlockMsg = {
  x: number
  y: number
  z: number
  type: number
  placed: boolean
}

enum BlockType {
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
  bedrock = 11,
  water = 12,
}

const matrix = new THREE.Matrix4()
const noise = new Noise()
const blocks: THREE.InstancedMesh[] = []

const geometry = new THREE.BoxGeometry()

let isFirstRun = true

/** Global cap (same on all clients) — balances mine depth vs fill rate / GPU. */
const SUBSURFACE_DEPTH = 4

onmessage = (
  msg: MessageEvent<{
    distance: number
    chunk: { x: number; y: number }
    noiseSeed: number
    treeSeed: number
    stoneSeed: number
    coalSeed: number
    leafSeed: number
    idMap: Map<string, number>
    blocksFactor: number[]
    blocksCount: number[]
    customBlocks: CustomBlockMsg[]
    chunkSize: number
  }>,
) => {
  const {
    distance,
    chunk,
    noiseSeed,
    idMap,
    blocksFactor,
    treeSeed,
    stoneSeed,
    coalSeed,
    leafSeed,
    customBlocks,
    blocksCount,
    chunkSize,
  } = msg.data

  const maxCount = (distance * chunkSize * 2 + chunkSize) ** 2 + 500

  if (isFirstRun) {
    for (let i = 0; i < blocksCount.length; i++) {
      const block = new THREE.InstancedMesh(
        geometry,
        new THREE.MeshBasicMaterial(),
        maxCount * blocksFactor[i],
      )
      blocks.push(block)
    }

    isFirstRun = false
  }

  noise.seed = noiseSeed
  noise.treeSeed = treeSeed
  noise.stoneSeed = stoneSeed
  noise.coalSeed = coalSeed
  if (typeof leafSeed === 'number') {
    noise.leafSeed = leafSeed
  }

  for (let i = 0; i < blocks.length; i++) {
    blocks[i].instanceMatrix = new THREE.InstancedBufferAttribute(
      new Float32Array(maxCount * blocksFactor[i] * 16),
      16,
    )
  }

  const addBlock = (cx: number, cy: number, cz: number, bt: BlockType) => {
    const key = `${cx}_${cy}_${cz}`
    if (idMap.has(key)) return
    matrix.setPosition(cx, cy, cz)
    const id = blocksCount[bt]
    idMap.set(key, id)
    blocks[bt].setMatrixAt(id, matrix)
    blocksCount[bt]++
  }

  for (
    let x = -chunkSize * distance + chunkSize * chunk.x;
    x < chunkSize * distance + chunkSize + chunkSize * chunk.x;
    x++
  ) {
    for (
      let z = -chunkSize * distance + chunkSize * chunk.y;
      z < chunkSize * distance + chunkSize + chunkSize * chunk.y;
      z++
    ) {
      const yOffset = terrainSurfaceYOffset(noise, x, z)
      const surfY = TERRAIN_Y_BASE + yOffset

      const stoneOffset =
        noise.get(x / noise.stoneGap, z / noise.stoneGap, stoneSeed) * noise.stoneAmp

      const coalOffset =
        noise.get(x / noise.coalGap, z / noise.coalGap, coalSeed) * noise.coalAmp

      for (let dy = 1; dy <= SUBSURFACE_DEPTH; dy++) {
        const cy = surfY - dy
        if (cy < 1) break
        let bt = BlockType.dirt
        if (dy >= 3) {
          const sn =
            noise.get(x * 0.08 + cy * 0.11, z * 0.08 - cy * 0.07, stoneSeed) * noise.stoneAmp
          bt = sn > noise.stoneThreshold * 0.52 ? BlockType.stone : BlockType.dirt
          const cn =
            noise.get(x / noise.coalGap + cy * 0.02, z / noise.coalGap - cy * 0.02, coalSeed) *
            noise.coalAmp
          if (bt === BlockType.stone && cn > noise.coalThreshold) bt = BlockType.coal
        }
        addBlock(x, cy, z, bt)
      }

      if (!idMap.has(`${x}_0_${z}`)) {
        addBlock(x, 0, z, BlockType.bedrock)
      }

      matrix.setPosition(x, surfY, z)

      if (stoneOffset > noise.stoneThreshold) {
        if (coalOffset > noise.coalThreshold) {
          idMap.set(`${x}_${surfY}_${z}`, blocksCount[BlockType.coal])
          blocks[BlockType.coal].setMatrixAt(blocksCount[BlockType.coal]++, matrix)
        } else {
          idMap.set(`${x}_${surfY}_${z}`, blocksCount[BlockType.stone])
          blocks[BlockType.stone].setMatrixAt(blocksCount[BlockType.stone]++, matrix)
        }
      } else {
        if (yOffset < -3) {
          idMap.set(`${x}_${surfY}_${z}`, blocksCount[BlockType.sand])
          blocks[BlockType.sand].setMatrixAt(blocksCount[BlockType.sand]++, matrix)
        } else {
          idMap.set(`${x}_${surfY}_${z}`, blocksCount[BlockType.grass])
          blocks[BlockType.grass].setMatrixAt(blocksCount[BlockType.grass]++, matrix)
        }
      }

      const treeOffset =
        noise.get(x / noise.treeGap, z / noise.treeGap, treeSeed) * noise.treeAmp

      if (
        treeOffset > noise.treeThreshold &&
        yOffset >= -3 &&
        stoneOffset < noise.stoneThreshold &&
        surfY >= TERRAIN_SEA_LEVEL - 1
      ) {
        for (let i = 1; i <= noise.treeHeight; i++) {
          idMap.set(`${x}_${surfY + i}_${z}`, blocksCount[BlockType.tree])

          matrix.setPosition(x, surfY + i, z)

          blocks[BlockType.tree].setMatrixAt(blocksCount[BlockType.tree]++, matrix)
        }

        for (let i = -2; i <= 2; i++) {
          for (let j = -2; j <= 2; j++) {
            for (let k = -2; k <= 2; k++) {
              if (i === 0 && k === 0) {
                continue
              }
              const leafOffset =
                noise.get(
                  (x + i + j) / noise.leafGap,
                  (z + k) / noise.leafGap,
                  leafSeed,
                ) * noise.leafAmp
              if (leafOffset > noise.leafThreshold) {
                idMap.set(
                  `${x + i}_${surfY + noise.treeHeight + j}_${z + k}`,
                  blocksCount[BlockType.leaf],
                )
                matrix.setPosition(x + i, surfY + noise.treeHeight + j, z + k)
                blocks[BlockType.leaf].setMatrixAt(blocksCount[BlockType.leaf]++, matrix)
              }
            }
          }
        }
      }

      if (surfY < TERRAIN_SEA_LEVEL) {
        for (let wy = surfY + 1; wy <= TERRAIN_SEA_LEVEL; wy++) {
          const wkey = `${x}_${wy}_${z}`
          if (idMap.has(wkey)) continue
          addBlock(x, wy, z, BlockType.water)
        }
      }
    }
  }

  for (const block of customBlocks) {
    if (
      block.x > -chunkSize * distance + chunkSize * chunk.x &&
      block.x < chunkSize * distance + chunkSize + chunkSize * chunk.x &&
      block.z > -chunkSize * distance + chunkSize * chunk.y &&
      block.z < chunkSize * distance + chunkSize + chunkSize * chunk.y
    ) {
      if (block.placed) {
        matrix.setPosition(block.x, block.y, block.z)
        blocks[block.type].setMatrixAt(blocksCount[block.type]++, matrix)
      } else {
        const id = idMap.get(`${block.x}_${block.y}_${block.z}`)
        if (id === undefined || id === null) {
          continue
        }

        blocks[block.type].setMatrixAt(
          id,
          new THREE.Matrix4().set(
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
            0,
          ),
        )
      }
    }
  }

  const arrays = blocks.map((block) => block.instanceMatrix.array)
  postMessage({ idMap, arrays, blocksCount })
}
