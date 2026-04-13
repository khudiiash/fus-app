import * as THREE from 'three'
import type Control from './minebase/control'
import type Terrain from './minebase/terrain'
import { BlockType } from './minebase/terrain'
import {
  applyHandHeldLightingLift,
  applySrgbColorMaps,
} from './toolGltfUtils'
import { cloneToolForFirstPerson, loadBlockWorldToolsPackScene } from './loadBlockWorldToolsPack'

const FP_BLOCK_SIZE = 0.32

/**
 * Bare-hand: thick box along local +Y (toward screen-up after parent `holdRot`),
 * wrist at y = 0 so swing/idle pivot at the in-frame “bottom” of the arm, not the mesh center.
 */
const FP_FIST_W = 0.2
const FP_FIST_THICK = 0.22
const FP_FIST_ARM_LEN = 0.5

/**
 * Mine swing rotates around this axis in **hand-rig space** (`toolSwingPivot` parent = `toolRoot`),
 * not the oriented tool mesh’s local X — so retuning the FP aim vector in `toolGltfUtils` does not
 * turn the swing into a sideways wipe. +X here ≈ “through the shoulder” → arc forward / down.
 */
const TOOL_SWING_AXIS_ROOT = new THREE.Vector3(1, 0, 0)
const _swingQ = new THREE.Quaternion()

const FP_HAND_RENDER_ORDER = 10000

function tagFpHandRenderOrder(root: THREE.Object3D) {
  root.traverse((o) => {
    if (o instanceof THREE.Mesh) o.renderOrder = FP_HAND_RENDER_ORDER
  })
}

function stampFpHandPresentation(m: THREE.Material) {
  m.transparent = true
  m.opacity = 1
  m.depthTest = false
  m.depthWrite = false
  m.polygonOffset = false
  m.polygonOffsetFactor = 0
  m.polygonOffsetUnits = 0
}

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

/**
 * First-person tool (from `tools.glb` by name), fist, or held block — parented to the camera.
 */
export class FirstPersonBlockWorldItems {
  private camera: THREE.PerspectiveCamera
  private terrain: Terrain
  private control: Control
  private root = new THREE.Group()
  /** Holds the current tool mesh clone (swapped when hotbar changes). */
  private toolRoot = new THREE.Group()
  /** Swing quaternion applied here so the axis stays aligned with the FP hand rig, not mesh-local axes. */
  private toolSwingPivot = new THREE.Group()
  /** Idle + swing rotation for held block / fist (wrist pivot). */
  private fpItemPivot = new THREE.Group()
  private blockMesh: THREE.Mesh
  private fpItemGeomKind: 'block' | 'fist' = 'block'
  private swingPhase = 0
  private lastBlockType: BlockType | null = null
  private fistMatActive = false
  private bobT = 0
  /** Camera-local anchor for FP arm / block / tool (x right, y up, z forward = negative into scene). */
  private readonly holdPos = new THREE.Vector3(0.16, -0.28, -1.08)
  private readonly holdRot = new THREE.Euler(-0.1, 0.26, 0.04, 'XYZ')
  private readonly blockIdleRot = new THREE.Euler(-0.22, 0.35, 0.1, 'XYZ')
  /**
   * Fist-only idle: slight negative pitch tucks the wrist edge below the frame so the flat
   * “lower end” of the forearm box is less visible; yaw still aims toward center.
   */
  private readonly fistIdleRot = new THREE.Euler(-0.1, 0.34, 0.02, 'XYZ')
  /** Extra offset for fist only — negative Y pulls the hand down so the wrist clips under the HUD. */
  private readonly fistHoldBias = new THREE.Vector3(0.03, -0.17, 0.03)
  private toolHoldBaseQuat = new THREE.Quaternion()
  private toolHoldQuatReady = false
  private activeToolMesh: THREE.Object3D | null = null
  private activeToolName: string | null = null
  private toolSwapGen = 0

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
    this.fpItemPivot.rotation.copy(this.blockIdleRot)
    this.fpItemPivot.add(this.blockMesh)
    this.toolRoot.visible = false
    this.toolRoot.add(this.toolSwingPivot)
    this.root.add(this.toolRoot)
    this.root.add(this.fpItemPivot)
    this.root.frustumCulled = false
    this.fpItemPivot.frustumCulled = false
    this.root.renderOrder = FP_HAND_RENDER_ORDER
    tagFpHandRenderOrder(this.root)
    this.camera.add(this.root)
    this.root.position.copy(this.holdPos)
    this.root.rotation.copy(this.holdRot)
  }

  async loadToolModel(): Promise<void> {
    await loadBlockWorldToolsPackScene()
  }

  private disposeToolSubtree() {
    while (this.toolSwingPivot.children.length > 0) {
      const ch = this.toolSwingPivot.children[0]!
      this.toolSwingPivot.remove(ch)
      ch.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry?.dispose()
          const mats = Array.isArray(o.material) ? o.material : [o.material]
          mats.forEach((m) => m?.dispose?.())
        }
      })
    }
    this.toolSwingPivot.quaternion.identity()
    this.activeToolMesh = null
    this.toolHoldQuatReady = false
  }

  private async swapToolMesh(meshName: string) {
    const gen = ++this.toolSwapGen
    const mesh = await cloneToolForFirstPerson(meshName, this.root)
    if (gen !== this.toolSwapGen) {
      mesh.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry?.dispose()
          const mats = Array.isArray(o.material) ? o.material : [o.material]
          mats.forEach((m) => m?.dispose?.())
        }
      })
      return
    }
    this.disposeToolSubtree()
    this.toolSwingPivot.quaternion.identity()
    this.toolSwingPivot.add(mesh)
    this.activeToolMesh = mesh
    this.toolHoldBaseQuat.copy(mesh.quaternion)
    this.toolHoldQuatReady = true
    this.activeToolName = meshName
    tagFpHandRenderOrder(mesh)
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

  /** Centered cube for held blocks; elongated box for fist with wrist at local z = 0. */
  private ensureFpItemGeometry(kind: 'block' | 'fist') {
    if (this.fpItemGeomKind === kind) return
    this.fpItemGeomKind = kind
    this.blockMesh.geometry.dispose()
    if (kind === 'fist') {
      this.blockMesh.geometry = new THREE.BoxGeometry(
        FP_FIST_W,
        FP_FIST_ARM_LEN,
        FP_FIST_THICK,
      )
      // Geometry centered on mesh; offset so min local Y (wrist) is 0 — pivot swings from wrist, not belly.
      this.blockMesh.position.set(0, FP_FIST_ARM_LEN * 0.25, 0)
    } else {
      this.blockMesh.geometry = new THREE.BoxGeometry(
        FP_BLOCK_SIZE,
        FP_BLOCK_SIZE,
        FP_BLOCK_SIZE,
      )
      this.blockMesh.position.set(0, 0, 0)
    }
  }

  update(dt: number) {
    const mine = this.control.interactionMode === 'mine'
    const hand = this.control.getPresenceHandFields()
    const showTool = mine && hand.bwHandMine === 'tool'
    const showFist = mine && hand.bwHandMine === 'fist'
    const wantName = showTool ? hand.bwToolMesh || 'Iron_Pickaxe' : null
    const fpIdle = mine && showFist ? this.fistIdleRot : this.blockIdleRot

    if (showTool && wantName && wantName !== this.activeToolName) {
      void this.swapToolMesh(wantName)
    }
    if (!showTool && this.activeToolName) {
      this.disposeToolSubtree()
      this.activeToolName = null
    }

    this.toolRoot.visible = showTool

    if (!mine) {
      this.ensureFpItemGeometry('block')
      this.blockMesh.visible = true
      this.blockMesh.scale.setScalar(1)
      this.fistMatActive = false
      this.syncBlockMaterial(this.control.getActiveBlockType())
    } else if (showFist) {
      this.ensureFpItemGeometry('fist')
      this.blockMesh.visible = true
      this.blockMesh.scale.setScalar(1)
      if (!this.fistMatActive) {
        this.fistMatActive = true
        this.lastBlockType = null
        const old = this.blockMesh.material as THREE.Material
        old.dispose()
        const skin = new THREE.MeshStandardMaterial({
          color: 0xc49a6c,
          roughness: 0.88,
          metalness: 0.02,
          side: THREE.FrontSide,
        })
        applyHandHeldLightingLift(skin)
        stampFpHandPresentation(skin)
        this.blockMesh.material = skin
      }
    } else {
      this.blockMesh.visible = false
      this.blockMesh.scale.setScalar(1)
      this.fistMatActive = false
    }

    this.bobT += dt
    const bob =
      Math.sin(this.bobT * 2.15) * 0.018 + Math.sin(this.bobT * 4.1) * 0.006
    const bx = showFist ? this.fistHoldBias.x : 0
    const by = showFist ? this.fistHoldBias.y : 0
    const bz = showFist ? this.fistHoldBias.z : 0
    this.root.position.set(
      this.holdPos.x + bx,
      this.holdPos.y + bob + by,
      this.holdPos.z + bz,
    )

    if (this.swingPhase > 0) {
      this.swingPhase = Math.max(0, this.swingPhase - dt * 6.2)
      const u = 1 - this.swingPhase
      const a = Math.sin(u * Math.PI) * 1.18
      if (
        mine &&
        this.toolRoot.visible &&
        this.activeToolMesh &&
        this.toolHoldQuatReady
      ) {
        _swingQ.setFromAxisAngle(TOOL_SWING_AXIS_ROOT, -a)
        this.toolSwingPivot.quaternion.copy(_swingQ)
        this.activeToolMesh!.quaternion.copy(this.toolHoldBaseQuat)
      } else if (!mine) {
        // Build: swing arc outward (toward target), not back into the camera.
        this.fpItemPivot.rotation.x = this.blockIdleRot.x - a * 0.95
        this.fpItemPivot.rotation.z = this.blockIdleRot.z - a * 0.42
        this.fpItemPivot.rotation.y = this.blockIdleRot.y - a * 0.12
      } else if (mine && showFist && this.blockMesh.visible) {
        // Mirror swing vs tool/block so the strike arcs **away** from the torso (toward the target).
        this.fpItemPivot.rotation.x = this.fistIdleRot.x - a * 0.55
        this.fpItemPivot.rotation.z = this.fistIdleRot.z - a * 0.28
        this.fpItemPivot.rotation.y = this.fistIdleRot.y - a * 0.08
      }
    } else {
      if (this.activeToolMesh && this.toolHoldQuatReady) {
        this.toolSwingPivot.quaternion.identity()
        this.activeToolMesh.quaternion.copy(this.toolHoldBaseQuat)
      }
      this.fpItemPivot.rotation.copy(fpIdle)
    }
  }

  dispose() {
    this.toolSwapGen++
    this.camera.remove(this.root)
    this.blockMesh.geometry.dispose()
    ;(this.blockMesh.material as THREE.Material).dispose()
    this.fpItemGeomKind = 'block'
    this.disposeToolSubtree()
  }
}
