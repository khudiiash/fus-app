import * as THREE from 'three'
import { BlockType } from '@/game/minebase/terrain'

/**
 * Approximate “dust” tint per block type (Minecraft-like colored hit / break particles).
 */
export function blockTypeParticleColor(t: BlockType): THREE.Color {
  switch (t) {
    case BlockType.grass:
      return new THREE.Color(0x5a9a3a)
    case BlockType.dirt:
      return new THREE.Color(0x6b4a32)
    case BlockType.sand:
      return new THREE.Color(0xc9b078)
    case BlockType.stone:
    case BlockType.coal:
      return new THREE.Color(0x7a7a82)
    case BlockType.wood:
    case BlockType.tree:
      return new THREE.Color(0x6b4a2a)
    case BlockType.leaf:
      return new THREE.Color(0x3d6b2d)
    case BlockType.diamond:
      return new THREE.Color(0x4a9e9e)
    case BlockType.quartz:
      return new THREE.Color(0xe8e0e8)
    case BlockType.glass:
      return new THREE.Color(0xb8d8e8)
    default:
      return new THREE.Color(0x888888)
  }
}

type BurstOpts = {
  count: number
  spread: number
  speed: number
  lifetimeMs: number
  gravity: number
  /** Uniform cube half-extent (world units) — crisp square “pixels”. */
  cubeHalf: number
}

const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _s = new THREE.Vector3()
const _p = new THREE.Vector3()

/**
 * Colored voxel-cube burst (no circular point sprites — reads as square pixels).
 */
function spawnVoxelParticleBurst(
  scene: THREE.Scene,
  center: THREE.Vector3,
  base: THREE.Color,
  opts: BurstOpts,
) {
  const { count, spread, speed, lifetimeMs, gravity, cubeHalf } = opts
  const positions = new Float32Array(count * 3)
  const colors = new Float32Array(count * 3)
  const velocities = new Float32Array(count * 3)
  const tmp = new THREE.Color()
  for (let i = 0; i < count; i++) {
    const ix = i * 3
    positions[ix] = center.x + (Math.random() - 0.5) * 0.06
    positions[ix + 1] = center.y + (Math.random() - 0.5) * 0.06
    positions[ix + 2] = center.z + (Math.random() - 0.5) * 0.06
    tmp.copy(base)
    tmp.offsetHSL(
      (Math.random() - 0.5) * 0.05,
      (Math.random() - 0.5) * 0.14,
      (Math.random() - 0.5) * 0.12,
    )
    colors[ix] = tmp.r
    colors[ix + 1] = tmp.g
    colors[ix + 2] = tmp.b
    const vx = (Math.random() - 0.5) * 2 * spread
    const vy = Math.random() * spread * 0.55 + speed * 0.18
    const vz = (Math.random() - 0.5) * 2 * spread
    const len = Math.hypot(vx, vy, vz) || 1
    const vScale = speed * 7
    velocities[ix] = (vx / len) * vScale
    velocities[ix + 1] = (vy / len) * vScale
    velocities[ix + 2] = (vz / len) * vScale
  }

  const geo = new THREE.BoxGeometry(1, 1, 1)
  const vn = geo.attributes.position.count
  const vtxWhite = new Float32Array(vn * 3)
  vtxWhite.fill(1)
  geo.setAttribute('color', new THREE.BufferAttribute(vtxWhite, 3))
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    vertexColors: true,
    transparent: true,
    opacity: 1,
    depthWrite: false,
    toneMapped: false,
  })
  const mesh = new THREE.InstancedMesh(geo, mat, count)
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  const colorAttr = new THREE.InstancedBufferAttribute(colors, 3)
  mesh.instanceColor = colorAttr
  mesh.frustumCulled = false

  const writeMatrices = (opacity: number) => {
    mat.opacity = opacity
    _q.identity()
    _s.set(cubeHalf * 2, cubeHalf * 2, cubeHalf * 2)
    for (let i = 0; i < count; i++) {
      const ix = i * 3
      _p.set(positions[ix], positions[ix + 1], positions[ix + 2])
      _m.compose(_p, _q, _s)
      mesh.setMatrixAt(i, _m)
    }
    mesh.instanceMatrix.needsUpdate = true
  }
  writeMatrices(1)
  scene.add(mesh)

  const t0 = performance.now()
  let last = t0
  let raf = 0
  const step = () => {
    const now = performance.now()
    const elapsed = now - t0
    if (elapsed > lifetimeMs) {
      scene.remove(mesh)
      geo.dispose()
      mat.dispose()
      if (raf) cancelAnimationFrame(raf)
      return
    }
    const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000))
    last = now
    const p = positions
    for (let i = 0; i < count; i++) {
      const ix = i * 3
      p[ix] += velocities[ix] * dt
      p[ix + 1] += velocities[ix + 1] * dt
      p[ix + 2] += velocities[ix + 2] * dt
      velocities[ix + 1] -= gravity * dt
    }
    writeMatrices(1 - elapsed / lifetimeMs)
    raf = requestAnimationFrame(step)
  }
  raf = requestAnimationFrame(step)
}

/** Short burst when a block is damaged but not broken. */
export function spawnBlockMiningHitParticles(
  scene: THREE.Scene,
  center: THREE.Vector3,
  blockType: BlockType,
) {
  const c = blockTypeParticleColor(blockType)
  spawnVoxelParticleBurst(scene, center.clone(), c, {
    count: 22,
    spread: 0.42,
    speed: 0.55,
    lifetimeMs: 340,
    gravity: 2.2,
    cubeHalf: 0.07,
  })
}

/** Larger burst when a block is destroyed. */
export function spawnBlockDestroyParticles(
  scene: THREE.Scene,
  center: THREE.Vector3,
  blockType: BlockType,
) {
  const c = blockTypeParticleColor(blockType)
  spawnVoxelParticleBurst(scene, center.clone(), c, {
    count: 64,
    spread: 0.72,
    speed: 0.95,
    lifetimeMs: 580,
    gravity: 2.8,
    cubeHalf: 0.09,
  })
}

/** Hit sparks when pickaxe connects with another player (local view). */
export function spawnPickaxePlayerHitParticles(scene: THREE.Scene, hitPoint: THREE.Vector3) {
  const c = new THREE.Color(0xffdede)
  spawnVoxelParticleBurst(scene, hitPoint.clone(), c, {
    count: 36,
    spread: 0.55,
    speed: 1.05,
    lifetimeMs: 400,
    gravity: 1.6,
    cubeHalf: 0.065,
  })
}
