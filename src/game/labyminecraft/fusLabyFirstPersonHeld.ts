/**
 * FUS Laby (js-minecraft): first-person `tools.glb` only.
 * The GLTF is parented under the vanilla FP **arm bone** (meshes hidden when a tool is active) so it inherits
 * the same swing / bob / equip motion as the fist. Falls back to `firstPersonGroup` if the bone is missing.
 */
import * as THREE from '@labymc/libraries/three.module.js'
import { cloneToolForFirstPerson, loadBlockWorldToolsPackScene } from '@/game/loadBlockWorldToolsPack'

const FP_HAND_RENDER_ORDER = 10_000

/** When parented to `firstPersonGroup` only (no arm bone yet). */
const FP_TOOL_UNDER_FP_STACK_SCALE = 16
/** When parented to the steve arm bone after {@code copyTransformOf}. */
const FP_TOOL_UNDER_ARM_BONE_SCALE = 0.72

type McLike = {
  worldRenderer: { camera: THREE.PerspectiveCamera; overlay: THREE.Scene }
  player: {
    inventory: { selectedSlotIndex: number; getItemInSlot: (i: number) => number }
    renderer?: {
      firstPersonGroup?: THREE.Object3D
      handModel?: { bone: THREE.Object3D; render: () => void } | null
    }
  }
  fusHotbarSlotMeta?: Array<
    | { kind: 'empty' }
    | { kind: 'fist' }
    | { kind: 'block' }
    | { kind: 'tool'; toolMeshName: string; pvpDamageHalf: number }
  > | null
  fusHideVanillaFpHand?: (() => boolean) | null
  fusSyncFpToolIntoFirstPerson?:
    | ((player: unknown, stack: THREE.Object3D, partialTicks: number, hasItem: boolean) => void)
    | null
}

/** Shop / legacy data sometimes uses `Gold_*`; GLB nodes are `Golden_*`. */
function normalizeLabyToolMeshName(name: string): string {
  const t = name.trim()
  if (t.startsWith('Gold_')) return `Golden_${t.slice('Gold_'.length)}`
  return t
}

function tagRenderOrder(root: THREE.Object3D) {
  root.traverse((o) => {
    if (o instanceof THREE.Mesh) o.renderOrder = FP_HAND_RENDER_ORDER
  })
}

function disposeObjectSubtree(obj: THREE.Object3D) {
  obj.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.geometry?.dispose()
      const mats = Array.isArray(o.material) ? o.material : [o.material]
      mats.forEach((m) => m?.dispose?.())
    }
  })
}

export class FusLabyFirstPersonHeld {
  private readonly mc: McLike
  private readonly toolSwingPivot = new THREE.Group()
  private activeToolName: string | null = null
  private activeToolMesh: THREE.Object3D | null = null
  private toolHoldBaseQuat = new THREE.Quaternion()
  private toolHoldQuatReady = false
  private toolSwapGen = 0

  constructor(mc: McLike) {
    this.mc = mc
    this.toolSwingPivot.frustumCulled = false
    this.toolSwingPivot.renderOrder = FP_HAND_RENDER_ORDER
    /** See {@link fusIsUnderFpToolPivot} in js-minecraft `PlayerRenderer.js` — rebuild must not hide GLTF meshes. */
    this.toolSwingPivot.userData.__fusLabyFpToolRoot = true

    mc.fusHideVanillaFpHand = () => {
      const row = mc.fusHotbarSlotMeta
      const raw = mc.player.inventory.selectedSlotIndex ?? 0
      const i = Math.max(0, Math.min(8, Math.floor(Number(raw)) || 0))
      const cell = row?.[i]
      return cell?.kind === 'tool' && typeof (cell as { toolMeshName?: string }).toolMeshName === 'string'
    }

    mc.fusSyncFpToolIntoFirstPerson = (player, stack) => {
      this.syncToolIntoFirstPerson(player as McLike['player'], stack)
    }
  }

  async preloadToolsPack(): Promise<void> {
    await loadBlockWorldToolsPackScene()
  }

  private detachToolPivot() {
    const p = this.toolSwingPivot.parent
    if (p) p.remove(this.toolSwingPivot)
    this.toolSwingPivot.scale.set(1, 1, 1)
  }

  private disposeToolSubtree() {
    while (this.toolSwingPivot.children.length > 0) {
      const ch = this.toolSwingPivot.children[0]!
      this.toolSwingPivot.remove(ch)
      disposeObjectSubtree(ch)
    }
    this.toolSwingPivot.quaternion.identity()
    this.activeToolMesh = null
    this.toolHoldQuatReady = false
    this.activeToolName = null
  }

  private async swapToolMesh(meshName: string) {
    const gen = ++this.toolSwapGen
    const resolved = normalizeLabyToolMeshName(meshName)
    this.activeToolName = resolved
    const mesh = await cloneToolForFirstPerson(resolved, this.toolSwingPivot, 'laby')
    if (gen !== this.toolSwapGen) {
      disposeObjectSubtree(mesh)
      return
    }
    this.disposeToolSubtree()
    this.toolSwingPivot.quaternion.identity()
    this.toolSwingPivot.add(mesh)
    this.activeToolMesh = mesh
    this.toolHoldBaseQuat.copy(mesh.quaternion)
    this.toolHoldQuatReady = true
    this.activeToolName = resolved
    tagRenderOrder(mesh)
  }

  /**
   * After {@link WorldRenderer.renderHand} transforms `stack` and {@link PlayerRenderer.renderRightHand}
   * updated the arm bone.
   */
  syncToolIntoFirstPerson(player: McLike['player'], stack: THREE.Object3D) {
    const hide = typeof this.mc.fusHideVanillaFpHand === 'function' && this.mc.fusHideVanillaFpHand()
    if (!hide) {
      this.detachToolPivot()
      return
    }

    const bone = player.renderer?.handModel?.bone ?? null
    const target: THREE.Object3D = bone ?? stack

    if (this.toolSwingPivot.parent !== target) {
      this.detachToolPivot()
      target.add(this.toolSwingPivot)
      this.toolSwingPivot.position.set(0, 0, 0)
      this.toolSwingPivot.quaternion.identity()
    }

    this.toolSwingPivot.scale.setScalar(
      bone ? FP_TOOL_UNDER_ARM_BONE_SCALE : FP_TOOL_UNDER_FP_STACK_SCALE,
    )

    if (this.activeToolMesh && this.toolHoldQuatReady) {
      this.activeToolMesh.quaternion.copy(this.toolHoldBaseQuat)
    }
    this.toolSwingPivot.visible = true
    this.toolSwingPivot.traverse((o) => {
      if (o instanceof THREE.Mesh) o.visible = true
    })
  }

  update(_dt: number) {
    const mc = this.mc
    const meta = mc.fusHotbarSlotMeta
    const raw = mc.player.inventory.selectedSlotIndex ?? 0
    const idx = Math.max(0, Math.min(8, Math.floor(Number(raw)) || 0))
    const slotM = meta?.[idx]
    const mineTool = slotM?.kind === 'tool' && typeof slotM.toolMeshName === 'string'

    if (mineTool && slotM && slotM.kind === 'tool') {
      const wantRaw = slotM.toolMeshName.trim() || 'Iron_Pickaxe'
      const want = normalizeLabyToolMeshName(wantRaw)
      if (want !== this.activeToolName) {
        void this.swapToolMesh(wantRaw)
      }
      this.toolSwingPivot.visible = true
    } else {
      if (this.activeToolName) this.disposeToolSubtree()
      this.toolSwingPivot.visible = false
    }

    this.toolSwingPivot.quaternion.identity()
  }

  dispose() {
    this.toolSwapGen++
    this.mc.fusHideVanillaFpHand = null
    this.mc.fusSyncFpToolIntoFirstPerson = null
    this.detachToolPivot()
    this.disposeToolSubtree()
  }
}
