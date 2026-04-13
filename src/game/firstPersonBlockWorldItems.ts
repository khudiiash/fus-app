import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type Control from './minebase/control'
import type Terrain from './minebase/terrain'
import { BlockType } from './minebase/terrain'
import {
  applyHandHeldLightingLift,
  applySrgbColorMaps,
  flipToolRootWindingX,
  FP_TOOL_MAX_DIM,
  orientPickaxeForFirstPerson,
  scaleGltfToMaxDimension,
} from './toolGltfUtils'

const TOOL_MODEL_URL = new URL('./assets/minecraft_tool.glb', import.meta.url)
  .href
const FP_BLOCK_SIZE = 0.58

const TOOL_SWING_AXIS = new THREE.Vector3(1, 0, 0)
const _swingQ = new THREE.Quaternion()

/**
 * Transparent pass draws after all opaque geometry; high renderOrder sorts after default
 * transparent (leaves, glass) so the hand draws on top. See reversePainterSortStable in three.
 */
const FP_HAND_RENDER_ORDER = 10000

function tagFpHandRenderOrder(root: THREE.Object3D) {
  root.traverse((o) => {
    if (o instanceof THREE.Mesh) o.renderOrder = FP_HAND_RENDER_ORDER
  })
}

/** View-model: no depth test (see through walls), drawn last among transparents. */
function stampFpHandPresentation(m: THREE.Material) {
  m.transparent = true
  m.opacity = 1
  m.depthTest = false
  m.depthWrite = false
  m.polygonOffset = false
  m.polygonOffsetFactor = 0
  m.polygonOffsetUnits = 0
}

/** Lit hand preview: clone terrain / tool PBR so voxels read as 3D, not flat stickers. */
function makeHandHeldBlockMaterial(
  src: THREE.MeshStandardMaterial | THREE.MeshStandardMaterial[],
): THREE.MeshStandardMaterial {
  const base = Array.isArray(src) ? src[0]! : src
  const m = base.clone()
  m.toneMapped = true
  applySrgbColorMaps(m)
  applyHandHeldLightingLift(m)
  m.side = THREE.FrontSide
  stampFpHandPresentation(m)
  return m
}

/** FP pickaxe: sRGB maps, same PBR response as terrain; transparent pass + view-model depth. */
function configureFpToolMaterials(root: THREE.Object3D) {
  root.traverse((o) => {
    o.frustumCulled = false
    if (o instanceof THREE.Mesh) {
      const mats = Array.isArray(o.material) ? o.material : [o.material]
      const next = mats.map((m) => {
        if (m instanceof THREE.MeshPhysicalMaterial) {
          const c = m.clone()
          c.toneMapped = true
          applySrgbColorMaps(c)
          applyHandHeldLightingLift(c)
          c.side = THREE.FrontSide
          stampFpHandPresentation(c)
          return c
        }
        if (m instanceof THREE.MeshStandardMaterial) {
          const c = m.clone()
          c.toneMapped = true
          applySrgbColorMaps(c)
          applyHandHeldLightingLift(c)
          c.side = THREE.FrontSide
          stampFpHandPresentation(c)
          return c
        }
        if (m instanceof THREE.MeshBasicMaterial) {
          const c = new THREE.MeshStandardMaterial({
            map: m.map ?? undefined,
            color: m.color?.clone() ?? new THREE.Color(0xffffff),
            roughness: 0.72,
            metalness: 0.05,
            side: THREE.FrontSide,
          })
          if (c.map) c.map.colorSpace = THREE.SRGBColorSpace
          applyHandHeldLightingLift(c)
          stampFpHandPresentation(c)
          return c
        }
        return m
      })
      o.material = next.length === 1 ? next[0]! : next
    }
  })
}

/**
 * First-person pickaxe (mine) or solid block (build), parented to the camera.
 * Lit materials with sRGB color maps; pickaxe uses `flipToolRootWindingX` for Blender glTF winding.
 */
export class FirstPersonBlockWorldItems {
  private camera: THREE.PerspectiveCamera
  private terrain: Terrain
  private control: Control
  private root = new THREE.Group()
  private tool: THREE.Object3D | null = null
  private blockMesh: THREE.Mesh
  private swingPhase = 0
  private lastBlockType: BlockType | null = null
  private bobT = 0
  /** Camera-local hold anchor (before idle bob). More negative z = further forward (−Z view). */
  private readonly holdPos = new THREE.Vector3(0.28, -0.45, -1.2)
  private readonly holdRot = new THREE.Euler(-0.1, 0.26, 0.04, 'XYZ')
  private readonly blockIdleRot = new THREE.Euler(-0.22, 0.35, 0.1, 'XYZ')
  private readonly toolHoldBaseQuat = new THREE.Quaternion()
  private toolHoldQuatReady = false

  constructor(camera: THREE.PerspectiveCamera, terrain: Terrain, control: Control) {
    this.camera = camera
    this.terrain = terrain
    this.control = control
    const placeholderMat = new THREE.MeshStandardMaterial({
      color: 0x6b8e4a,
      roughness: 0.78,
      metalness: 0.02,
      side: THREE.FrontSide,
    })
    applyHandHeldLightingLift(placeholderMat)
    stampFpHandPresentation(placeholderMat)
    this.blockMesh = new THREE.Mesh(
      new THREE.BoxGeometry(FP_BLOCK_SIZE, FP_BLOCK_SIZE, FP_BLOCK_SIZE),
      placeholderMat,
    )
    this.blockMesh.visible = false
    this.blockMesh.frustumCulled = false
    this.blockMesh.rotation.copy(this.blockIdleRot)
    this.root.add(this.blockMesh)
    this.root.frustumCulled = false
    this.root.renderOrder = FP_HAND_RENDER_ORDER
    tagFpHandRenderOrder(this.root)
    this.camera.add(this.root)
    this.root.position.copy(this.holdPos)
    this.root.rotation.copy(this.holdRot)
  }

  async loadToolModel(): Promise<void> {
    const gltf = await new Promise<{
      scene: THREE.Group
    }>((resolve, reject) => {
      new GLTFLoader().load(TOOL_MODEL_URL, resolve, undefined, reject)
    })
    const scene = gltf.scene
    scaleGltfToMaxDimension(scene, FP_TOOL_MAX_DIM)
    configureFpToolMaterials(scene)
    orientPickaxeForFirstPerson(scene, this.root)
    flipToolRootWindingX(scene)
    scene.position.set(0.1, -0.1, 0.04)
    scene.frustumCulled = false
    this.tool = scene
    this.toolHoldBaseQuat.copy(scene.quaternion)
    this.toolHoldQuatReady = true
    this.tool.visible = false
    this.root.add(this.tool)
    tagFpHandRenderOrder(this.root)
  }

  triggerHandSwing = () => {
    this.swingPhase = 1
  }

  private syncBlockMaterial(t: BlockType) {
    if (this.lastBlockType === t) return
    this.lastBlockType = t
    const src = this.terrain.materials.get(this.terrain.materialType[t])
    const old = this.blockMesh.material as THREE.Material
    old.dispose()
    this.blockMesh.material = makeHandHeldBlockMaterial(src)
  }

  update(dt: number) {
    const mine = this.control.interactionMode === 'mine'
    if (this.tool) this.tool.visible = mine
    this.blockMesh.visible = !mine
    if (!mine) {
      this.syncBlockMaterial(this.control.getActiveBlockType())
    }

    this.bobT += dt
    const bob =
      Math.sin(this.bobT * 2.15) * 0.018 + Math.sin(this.bobT * 4.1) * 0.006
    this.root.position.set(this.holdPos.x, this.holdPos.y + bob, this.holdPos.z)

    if (this.swingPhase > 0) {
      this.swingPhase = Math.max(0, this.swingPhase - dt * 6.2)
      const u = 1 - this.swingPhase
      const a = Math.sin(u * Math.PI) * 1.18
      if (mine && this.tool && this.toolHoldQuatReady) {
        _swingQ.setFromAxisAngle(TOOL_SWING_AXIS, a)
        this.tool.quaternion.copy(this.toolHoldBaseQuat).multiply(_swingQ)
      } else if (!mine) {
        this.blockMesh.rotation.x = this.blockIdleRot.x + a * 0.95
        this.blockMesh.rotation.z = this.blockIdleRot.z + a * 0.42
        this.blockMesh.rotation.y = this.blockIdleRot.y + a * 0.12
      }
    } else {
      if (this.tool && this.toolHoldQuatReady) {
        this.tool.quaternion.copy(this.toolHoldBaseQuat)
      }
      this.blockMesh.rotation.copy(this.blockIdleRot)
    }
  }

  dispose() {
    this.camera.remove(this.root)
    this.blockMesh.geometry.dispose()
    ;(this.blockMesh.material as THREE.Material).dispose()
    this.tool?.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry?.dispose()
        const mats = Array.isArray(o.material) ? o.material : [o.material]
        mats.forEach((m) => m?.dispose())
      }
    })
  }
}
