import * as THREE from 'three'
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js'
import Player, { Mode } from '../player'
import Terrain, { BlockType } from '../terrain'

import Block from '../terrain/mesh/block'
import Noise from '../terrain/noise'
import Audio from '../audio'
import { isMobile, useTouchGameControls } from '../utils'
import {
  PLAYER_EYE_HEIGHT,
  BLOCK_WORLD_MAX_HP_HALF_UNITS,
  FIST_MINE_DAMAGE_PER_SWING,
  MINING_DAMAGE_HOLDING_BLOCK,
} from '@/game/playerConstants'
import { blockTypeBreakHp } from '@/game/blockWorldBlockStats'
import {
  spawnBlockDestroyParticles,
  spawnBlockMiningHitParticles,
  spawnPickaxePlayerHitParticles,
} from '@/game/blockWorldParticles'
import type { BlockWorldHotbarSlot } from '@/game/blockWorldItems'
import { BW_HOTBAR_MAX_SLOTS } from '@/game/blockWorldItems'

/** @deprecated Fixed pickaxe slot; hotbar is now dynamic from inventory. */
export const TOOL_HOTBAR_INDEX = 7
export const HOTBAR_SLOT_COUNT = BW_HOTBAR_MAX_SLOTS
export const HOTBAR_MAX_SLOTS = BW_HOTBAR_MAX_SLOTS
export type BlockWorldInteractionMode = 'mine' | 'build'

enum Side {
  front,
  back,
  left,
  right,
  down,
  up
}

export default class Control {
  constructor(
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    player: Player,
    terrain: Terrain,
    audio: Audio,
    lockDomElement: HTMLElement
  ) {
    this.scene = scene
    this.camera = camera
    this.player = player
    this.terrain = terrain
    this.control = new PointerLockControls(camera, lockDomElement)
    this.audio = audio

    this.raycaster = new THREE.Raycaster()
    this.raycaster.far = 8
    this.far = this.player.body.height

    this.initRayCaster()
    this.initEventListeners()
    this.syncInteractionFromHotbar()
  }

  // core properties
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  player: Player
  terrain: Terrain
  control: PointerLockControls
  audio: Audio
  velocity = new THREE.Vector3(0, 0, 0)

  // collide and jump properties
  frontCollide = false
  backCollide = false
  leftCollide = false
  rightCollide = false
  downCollide = true
  upCollide = false
  isJumping = false

  raycasterDown = new THREE.Raycaster()
  raycasterUp = new THREE.Raycaster()
  raycasterFront = new THREE.Raycaster()
  raycasterBack = new THREE.Raycaster()
  raycasterRight = new THREE.Raycaster()
  raycasterLeft = new THREE.Raycaster()

  /** Lightweight voxel probe mesh (same logic as classic mine three.js demos — fast). */
  tempMesh = (() => {
    const m = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial(),
      100,
    )
    m.frustumCulled = false
    return m
  })()
  tempMeshMatrix = new THREE.InstancedBufferAttribute(
    new Float32Array(100 * 16),
    16,
  )

  // other properties
  p1 = performance.now()
  p2 = performance.now()
  raycaster: THREE.Raycaster
  far: number

  /** Slot 0 = fist; further slots = owned `block_world` shop items (see {@link setBlockWorldHotbar}). */
  bwHotbar: BlockWorldHotbarSlot[] = [{ kind: 'fist' }]
  holdingIndex = 0
  /** Mine vs build from current hotbar slot. */
  interactionMode: BlockWorldInteractionMode = 'mine'
  /** Fus HUD: sync selected slot when index changes from keys/wheel/tap. */
  onHotbarIndexChange?: (index: number) => void
  /** Fus HUD: rebuild hotbar row when inventory-driven slots change. */
  onHotbarLayoutChange?: () => void
  /** Fus HUD: Break / Build button state. */
  onInteractionModeChange?: (mode: BlockWorldInteractionMode) => void
  /**
   * Monotonic counter + callback for first-person hand swing (mine or build).
   * Remotes read {@link handSwingSeq} from presence.
   */
  handSwingSeq = 0
  onHandSwingRequested?: () => void
  /** Half-heart units (20 = 10 hearts). */
  playerHpHalfUnits = BLOCK_WORLD_MAX_HP_HALF_UNITS
  onPlayerHpChanged?: (hpHalf: number) => void
  /** Optional: bump multiplayer presence so remotes see HP without waiting for the pose tick. */
  onPlayerHpPresenceFlush?: () => void
  /** After HP hits 0 (then refilled); e.g. teleport to spawn / flag. */
  onHealthDepleted?: () => void
  /** Pickaxe raycast targets (remote `PlayerObject` roots). */
  getRemotePlayerRaycastRoots: () => THREE.Object3D[] = () => []
  /** When pickaxe swing hits a remote rig (cooldown applied). */
  onPickaxeHitRemotePlayer?: (targetUid: string) => void
  private lastPickaxePlayerHitMs = 0
  /** Accumulated mining damage toward the block currently being targeted. */
  private blockBreakDamage = new Map<string, number>()
  private lastMineTargetKey: string | null = null
  wheelGap = false
  clickInterval?: ReturnType<typeof setInterval>
  jumpInterval?: ReturnType<typeof setInterval>
  mouseHolding = false
  spaceHolding = false

  private blockContextMenu = (ev: Event) => {
    ev.preventDefault()
  }

  /** Best-effort pointer lock; never throws (detached canvas / policy / async rejection). */
  private tryRequestPointerLock = () => {
    const el = this.control.domElement
    if (!el?.isConnected) return
    if (document.pointerLockElement === el) return
    try {
      const r = el.requestPointerLock() as void | Promise<void>
      if (r != null && typeof (r as Promise<void>).catch === 'function') {
        void (r as Promise<void>).catch(() => {})
      }
    } catch {
      /* sync denial */
    }
  }

  /** Touch analog stick: forward (+1) / back (-1), strafe right (+1) / left (-1). */
  touchForward = 0
  touchStrafe = 0

  setTouchAnalog = (forward: number, strafe: number) => {
    this.touchForward = Math.max(-1, Math.min(1, forward))
    this.touchStrafe = Math.max(-1, Math.min(1, strafe))
    if (
      Math.abs(this.touchForward) < 0.001 &&
      Math.abs(this.touchStrafe) < 0.001
    ) {
      this.touchForward = 0
      this.touchStrafe = 0
      if (!this.downKeys.w && !this.downKeys.s) this.velocity.x = 0
      if (!this.downKeys.a && !this.downKeys.d) this.velocity.z = 0
    }
  }

  /** Touch UI: toggle walk ↔ fly once (avoids synthetic key double-toggle bugs). */
  cycleFlyingMode = () => {
    if (
      this.player.mode === Mode.walking ||
      this.player.mode === Mode.sneaking
    ) {
      this.player.setMode(Mode.flying)
    } else {
      this.player.setMode(Mode.walking)
    }
    this.velocity.x = 0
    this.velocity.y = 0
    this.velocity.z = 0
    this.touchForward = 0
    this.touchStrafe = 0
    this.isJumping = false
  }

  initRayCaster = () => {
    this.raycasterUp.ray.direction = new THREE.Vector3(0, 1, 0)
    this.raycasterDown.ray.direction = new THREE.Vector3(0, -1, 0)
    this.raycasterFront.ray.direction = new THREE.Vector3(1, 0, 0)
    this.raycasterBack.ray.direction = new THREE.Vector3(-1, 0, 0)
    this.raycasterLeft.ray.direction = new THREE.Vector3(0, 0, -1)
    this.raycasterRight.ray.direction = new THREE.Vector3(0, 0, 1)

    this.raycasterUp.far = 1.2
    this.raycasterDown.far = this.player.body.height
    this.raycasterFront.far = this.player.body.width
    this.raycasterBack.far = this.player.body.width
    this.raycasterLeft.far = this.player.body.width
    this.raycasterRight.far = this.player.body.width
  }

  downKeys = {
    a: false,
    d: false,
    w: false,
    s: false
  }
  setMovementHandler = (e: KeyboardEvent) => {
    if (e.repeat) {
      return
    }

    switch (e.key) {
      case 'q':
        if (this.player.mode === Mode.walking) {
          this.player.setMode(Mode.flying)
        } else {
          this.player.setMode(Mode.walking)
        }
        this.velocity.y = 0
        this.velocity.x = 0
        this.velocity.z = 0
        break
      case 'w':
      case 'W':
        this.downKeys.w = true
        this.velocity.x = this.player.speed
        break
      case 's':
      case 'S':
        this.downKeys.s = true
        this.velocity.x = -this.player.speed
        break
      case 'a':
      case 'A':
        this.downKeys.a = true
        this.velocity.z = -this.player.speed
        break
      case 'd':
      case 'D':
        this.downKeys.d = true
        this.velocity.z = this.player.speed
        break
      case ' ':
        if (this.player.mode === Mode.sneaking && !this.isJumping) {
          return
        }
        if (this.player.mode === Mode.walking) {
          // jump
          if (!this.isJumping) {
            this.velocity.y = 8
            this.isJumping = true
            this.downCollide = false
            this.far = 0
            setTimeout(() => {
              this.far = this.player.body.height
            }, 300)
          }
        } else {
          this.velocity.y += this.player.speed
        }
        if (this.player.mode === Mode.walking && !this.spaceHolding) {
          this.spaceHolding = true
          this.jumpInterval = setInterval(() => {
            this.setMovementHandler(e)
          }, 10)
        }
        break
      case 'Shift':
        if (this.player.mode === Mode.walking) {
          if (!this.isJumping) {
            this.player.setMode(Mode.sneaking)
            if (this.downKeys.w) {
              this.velocity.x = this.player.speed
            }
            if (this.downKeys.s) {
              this.velocity.x = -this.player.speed
            }
            if (this.downKeys.a) {
              this.velocity.z = -this.player.speed
            }
            if (this.downKeys.d) {
              this.velocity.z = this.player.speed
            }
            this.camera.position.setY(this.camera.position.y - 0.2)
          }
        } else {
          this.velocity.y -= this.player.speed
        }
        break
      default:
        break
    }
  }

  resetMovementHandler = (e: KeyboardEvent) => {
    if (e.repeat) {
      return
    }

    switch (e.key) {
      case 'w':
      case 'W':
        this.downKeys.w = false
        this.velocity.x = 0
        break
      case 's':
      case 'S':
        this.downKeys.s = false
        this.velocity.x = 0
        break
      case 'a':
      case 'A':
        this.downKeys.a = false
        this.velocity.z = 0
        break
      case 'd':
      case 'D':
        this.downKeys.d = false
        this.velocity.z = 0
        break
      case ' ':
        if (this.player.mode === Mode.sneaking && !this.isJumping) {
          return
        }
        this.jumpInterval && clearInterval(this.jumpInterval)
        this.spaceHolding = false
        if (this.player.mode === Mode.walking) {
          return
        }
        this.velocity.y = 0
        break
      case 'Shift':
        if (this.player.mode === Mode.sneaking) {
          if (!this.isJumping) {
            this.player.setMode(Mode.walking)
            if (this.downKeys.w) {
              this.velocity.x = this.player.speed
            }
            if (this.downKeys.s) {
              this.velocity.x = -this.player.speed
            }
            if (this.downKeys.a) {
              this.velocity.z = -this.player.speed
            }
            if (this.downKeys.d) {
              this.velocity.z = this.player.speed
            }
            this.camera.position.setY(this.camera.position.y + 0.2)
          }
        }
        if (this.player.mode === Mode.walking) {
          return
        }
        this.velocity.y = 0
        break
      default:
        break
    }
  }

  getCurrentBwSlot(): BlockWorldHotbarSlot {
    return this.bwHotbar[this.holdingIndex] ?? { kind: 'fist' }
  }

  /** Block type for placement / held block preview when in build mode. */
  getActiveBlockType = (): BlockType => {
    const s = this.getCurrentBwSlot()
    if (s.kind === 'item' && s.meta.kind === 'block' && s.count > 0) {
      return s.meta.blockType
    }
    return BlockType.grass
  }

  getCurrentMineDamage(): number {
    const s = this.getCurrentBwSlot()
    if (s.kind === 'fist') return FIST_MINE_DAMAGE_PER_SWING
    if (s.kind === 'item' && s.meta.kind === 'tool') return s.meta.mineDamage
    if (s.kind === 'item' && s.meta.kind === 'block') {
      return MINING_DAMAGE_HOLDING_BLOCK
    }
    return FIST_MINE_DAMAGE_PER_SWING
  }

  /** Half-heart damage for PvP melee; 0 = fist / blocks (no player damage). */
  getBwPvpDamageHalf(): number {
    const s = this.getCurrentBwSlot()
    if (s.kind !== 'item' || s.meta.kind !== 'tool') return 0
    return s.meta.pvpDamageHalf
  }

  /** True when current slot can deal PvP melee damage (cooldown checked separately in {@link crosshairBreak}). */
  canMeleePvP(): boolean {
    return this.interactionMode === 'mine' && this.getBwPvpDamageHalf() > 0
  }

  /** RTDB presence: block type in hand when building; mine hand variant. */
  getPresenceHandFields(): {
    bwBlockType: number
    bwHandMine: 'fist' | 'tool'
    bwToolMesh: string | null
  } {
    const s = this.getCurrentBwSlot()
    let bwBlockType = 0
    let bwHandMine: 'fist' | 'tool' = 'fist'
    let bwToolMesh: string | null = null
    if (s.kind === 'item' && s.meta.kind === 'block' && s.count > 0) {
      bwBlockType = s.meta.blockType
    }
    if (s.kind === 'item' && s.meta.kind === 'tool') {
      bwHandMine = 'tool'
      bwToolMesh = s.meta.toolMeshName ?? 'Iron_Pickaxe'
    }
    return { bwBlockType, bwHandMine, bwToolMesh }
  }

  /** glTF node name in `tools.glb` for the current tool slot. */
  getBwToolMeshName(): string | null {
    const s = this.getCurrentBwSlot()
    if (s.kind !== 'item' || s.meta.kind !== 'tool') return null
    return s.meta.toolMeshName ?? 'Iron_Pickaxe'
  }

  setBlockWorldHotbar(slots: BlockWorldHotbarSlot[]) {
    const next =
      slots.length > 0 ? slots.slice(0, BW_HOTBAR_MAX_SLOTS) : [{ kind: 'fist' as const }]
    this.bwHotbar = next
    if (this.holdingIndex >= this.bwHotbar.length) this.holdingIndex = 0
    this.blockBreakDamage.clear()
    this.lastMineTargetKey = null
    this.syncInteractionFromHotbar()
    this.onHotbarIndexChange?.(this.holdingIndex)
    this.onHotbarLayoutChange?.()
  }

  getBwHotbarSlotCount(): number {
    return this.bwHotbar.length
  }

  getBwHotbarSlotAt(index: number): BlockWorldHotbarSlot | undefined {
    return this.bwHotbar[index]
  }

  /** Derive mine vs build from current hotbar slot. */
  private syncInteractionFromHotbar = () => {
    const s = this.getCurrentBwSlot()
    if (s.kind === 'item' && s.meta.kind === 'block' && s.count > 0) {
      this.interactionMode = 'build'
    } else {
      this.interactionMode = 'mine'
    }
    this.onInteractionModeChange?.(this.interactionMode)
  }

  /** Touch / tap: one action at crosshair from current {@link interactionMode}. */
  performPrimaryTap = () => {
    if (this.interactionMode === 'mine') this.crosshairBreak()
    else this.crosshairPlace()
  }

  private requestHandSwing = () => {
    this.handSwingSeq++
    this.onHandSwingRequested?.()
  }

  private findRemoteUidFromIntersect(hit: THREE.Intersection): string | null {
    let o: THREE.Object3D | null = hit.object
    while (o) {
      const u = o.userData?.blockWorldHitUid as string | undefined
      if (typeof u === 'string' && u.length > 0) return u
      o = o.parent
    }
    return null
  }

  applyDamageHalfUnits(dmg: number) {
    this.playerHpHalfUnits = Math.max(0, this.playerHpHalfUnits - dmg)
    const dead = this.playerHpHalfUnits <= 0
    if (dead) {
      this.playerHpHalfUnits = BLOCK_WORLD_MAX_HP_HALF_UNITS
    }
    this.onPlayerHpChanged?.(this.playerHpHalfUnits)
    this.onPlayerHpPresenceFlush?.()
    if (dead) this.onHealthDepleted?.()
  }

  resetHealthFull() {
    this.playerHpHalfUnits = BLOCK_WORLD_MAX_HP_HALF_UNITS
    this.onPlayerHpChanged?.(this.playerHpHalfUnits)
    this.onPlayerHpPresenceFlush?.()
  }

  /** Voxel the player is standing on (same XZ column, block below feet). Breaking it causes fall-through / heavy regen. */
  private blockUnderFeetCell(): { x: number; y: number; z: number } {
    return {
      x: Math.round(this.camera.position.x),
      z: Math.round(this.camera.position.z),
      y: Math.floor(this.camera.position.y - PLAYER_EYE_HEIGHT - 0.2),
    }
  }

  crosshairBreak = () => {
    this.requestHandSwing()
    this.raycaster.setFromCamera({ x: 0, y: 0 }, this.camera)

    const roots = this.getRemotePlayerRaycastRoots()
    if (
      this.canMeleePvP() &&
      roots.length > 0 &&
      Date.now() - this.lastPickaxePlayerHitMs > 420
    ) {
      const ph = this.raycaster.intersectObjects(roots, true)[0]
      const bh = this.raycaster.intersectObjects(this.terrain.blocks)[0]
      if (ph && (!bh || ph.distance <= bh.distance)) {
        const uid = this.findRemoteUidFromIntersect(ph)
        if (uid) {
          this.lastPickaxePlayerHitMs = Date.now()
          if (ph.point) {
            spawnPickaxePlayerHitParticles(this.scene, ph.point)
          }
          this.onPickaxeHitRemotePlayer?.(uid)
          return
        }
      }
    }

    const block = this.raycaster.intersectObjects(this.terrain.blocks)[0]
    const matrix = new THREE.Matrix4()
    if (!(block && block.object instanceof THREE.InstancedMesh)) return

    block.object.getMatrixAt(block.instanceId!, matrix)
    const position = new THREE.Vector3().setFromMatrixPosition(matrix)

    const stand = this.blockUnderFeetCell()
    if (
      Math.round(position.x) === stand.x &&
      Math.round(position.z) === stand.z &&
      Math.round(position.y) === stand.y
    ) {
      return
    }

    const blockTypeEnum = BlockType[block.object.name as any] as unknown as BlockType
    if (blockTypeEnum === BlockType.bedrock) {
      this.terrain.generateAdjacentBlocks(position)
      return
    }

    const cellKey = `${Math.round(position.x)},${Math.round(position.y)},${Math.round(position.z)}`
    if (this.lastMineTargetKey !== cellKey) {
      this.blockBreakDamage.clear()
      this.lastMineTargetKey = cellKey
    }
    const hpMax = blockTypeBreakHp(blockTypeEnum)
    if (Number.isFinite(hpMax)) {
      const dmg = this.getCurrentMineDamage()
      const acc = (this.blockBreakDamage.get(cellKey) ?? 0) + dmg
      if (acc < hpMax) {
        this.blockBreakDamage.set(cellKey, acc)
        spawnBlockMiningHitParticles(this.scene, position, blockTypeEnum)
        return
      }
      this.blockBreakDamage.delete(cellKey)
    }

    block.object.setMatrixAt(
      block.instanceId!,
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
      ),
    )

    this.audio.playSound(
      BlockType[block.object.name as any] as unknown as BlockType,
    )

    spawnBlockDestroyParticles(this.scene, position, blockTypeEnum)

    const hitMesh = block.object as THREE.InstancedMesh
    hitMesh.instanceMatrix.needsUpdate = true
    hitMesh.boundingSphere = null
    hitMesh.boundingBox = null

    let existed = false
    for (const customBlock of this.terrain.customBlocks) {
      if (
        customBlock.x === position.x &&
        customBlock.y === position.y &&
        customBlock.z === position.z
      ) {
        existed = true
        customBlock.placed = false
      }
    }

    if (!existed) {
      this.terrain.customBlocks.push(
        new Block(
          position.x,
          position.y,
          position.z,
          BlockType[block.object.name as any] as unknown as BlockType,
          false,
        ),
      )
    }

    this.terrain.generateAdjacentBlocks(position)
    this.terrain.touchCustomBlocks()
  }

  crosshairPlace = () => {
    this.requestHandSwing()
    const slot = this.getCurrentBwSlot()
    if (slot.kind !== 'item' || slot.meta.kind !== 'block' || slot.count < 1) {
      return
    }
    const placeType = slot.meta.blockType
    this.raycaster.setFromCamera({ x: 0, y: 0 }, this.camera)
    const block = this.raycaster.intersectObjects(this.terrain.blocks)[0]
    const matrix = new THREE.Matrix4()
    if (!(block && block.object instanceof THREE.InstancedMesh)) return

    const normal = block.face!.normal
    block.object.getMatrixAt(block.instanceId!, matrix)
    const position = new THREE.Vector3().setFromMatrixPosition(matrix)

    if (
      position.x + normal.x === Math.round(this.camera.position.x) &&
      position.z + normal.z === Math.round(this.camera.position.z) &&
      (position.y + normal.y === Math.round(this.camera.position.y) ||
        position.y + normal.y ===
          Math.round(this.camera.position.y - PLAYER_EYE_HEIGHT))
    ) {
      return
    }

    matrix.setPosition(
      normal.x + position.x,
      normal.y + position.y,
      normal.z + position.z,
    )
    const placeMesh = this.terrain.blocks[placeType]
    placeMesh.setMatrixAt(this.terrain.getCount(placeType), matrix)
    this.terrain.setCount(placeType)

    this.audio.playSound(placeType)

    placeMesh.instanceMatrix.needsUpdate = true
    placeMesh.boundingSphere = null
    placeMesh.boundingBox = null

    this.terrain.customBlocks.push(
      new Block(
        normal.x + position.x,
        normal.y + position.y,
        normal.z + position.z,
        placeType,
        true,
      ),
    )
    this.terrain.touchCustomBlocks()
  }

  mousedownHandler = (e: MouseEvent) => {
    const t = e.target
    if (t instanceof Element && (t.closest('.fus-bw-hud') || t.closest('.fus-bw-exit-app')))
      return

    const touchMode = useTouchGameControls()
    const canvas = this.control.domElement
    // Request lock on canvas click, but never return early: if lock fails or is delayed,
    // break/place must still run (otherwise every click only "tries lock" and does nothing).
    if (
      !touchMode &&
      e.button === 0 &&
      document.pointerLockElement !== canvas &&
      t instanceof Node &&
      canvas.contains(t)
    ) {
      this.tryRequestPointerLock()
    }

    e.preventDefault()

    // Desktop: pickaxe slot = mine on LMB; block slots = place on LMB. RMB places when building.
    switch (e.button) {
      case 0:
        if (this.interactionMode === 'mine') this.crosshairBreak()
        else this.crosshairPlace()
        break
      case 2:
        if (this.interactionMode === 'build') this.crosshairPlace()
        break
      default:
        break
    }

    if (
      !isMobile &&
      !this.mouseHolding &&
      e.button === 0 &&
      this.interactionMode === 'mine'
    ) {
      this.mouseHolding = true
      this.clickInterval = setInterval(() => {
        this.crosshairBreak()
      }, 333)
    }
  }
  mouseupHandler = () => {
    this.clickInterval && clearInterval(this.clickInterval)
    this.mouseHolding = false
  }

  changeHoldingBlockHandler = (e: KeyboardEvent) => {
    if (isNaN(parseInt(e.key)) || e.key === '0') {
      return
    }
    const slot = parseInt(e.key, 10) - 1
    if (slot < 0 || slot >= this.bwHotbar.length) return
    this.setHotbarSlot(slot)
  }

  wheelHandler = (e: WheelEvent) => {
    if (!this.wheelGap) {
      this.wheelGap = true
      setTimeout(() => {
        this.wheelGap = false
      }, 100)
      const max = Math.max(0, this.bwHotbar.length - 1)
      if (e.deltaY > 0) {
        this.holdingIndex++
        this.holdingIndex > max && (this.holdingIndex = 0)
      } else if (e.deltaY < 0) {
        this.holdingIndex--
        this.holdingIndex < 0 && (this.holdingIndex = max)
      }
      this.applyHotbarIndexFromWheel()
    }
  }

  private applyHotbarIndexFromWheel = () => {
    const i = this.holdingIndex
    this.syncInteractionFromHotbar()
    this.onHotbarIndexChange?.(i)
  }

  setHotbarSlot = (index: number) => {
    const max = Math.max(0, this.bwHotbar.length - 1)
    const i = Math.max(0, Math.min(max, index))
    this.holdingIndex = i
    this.syncInteractionFromHotbar()
    this.onHotbarIndexChange?.(i)
  }

  private gameplayListenersAttached = false

  private attachGameplayListeners = () => {
    if (this.gameplayListenersAttached) return
    this.gameplayListenersAttached = true
    document.body.addEventListener('keydown', this.changeHoldingBlockHandler)
    document.body.addEventListener('wheel', this.wheelHandler, {
      passive: true,
    })
    document.body.addEventListener('keydown', this.setMovementHandler)
    document.body.addEventListener('keyup', this.resetMovementHandler)
    document.body.addEventListener('mousedown', this.mousedownHandler)
    document.body.addEventListener('mouseup', this.mouseupHandler)
  }

  private detachGameplayListeners = () => {
    if (!this.gameplayListenersAttached) return
    this.gameplayListenersAttached = false
    document.body.removeEventListener('keydown', this.changeHoldingBlockHandler)
    document.body.removeEventListener('wheel', this.wheelHandler)
    document.body.removeEventListener('keydown', this.setMovementHandler)
    document.body.removeEventListener('keyup', this.resetMovementHandler)
    document.body.removeEventListener('mousedown', this.mousedownHandler)
    document.body.removeEventListener('mouseup', this.mouseupHandler)
  }

  /** Tear down body listeners + canvas contextmenu. Call when disposing the block world. */
  disposeDocumentInput = () => {
    this.mouseupHandler()
    this.detachGameplayListeners()
    try {
      this.control.domElement.removeEventListener('contextmenu', this.blockContextMenu)
    } catch {
      /* ignore */
    }
  }

  initEventListeners = () => {
    const touchMode = useTouchGameControls()
    document.addEventListener('pointerlockchange', () => {
      if (document.pointerLockElement) {
        this.attachGameplayListeners()
      } else {
        // Desktop: never detach here — listeners must exist *before* the first
        // pointer lock so mousedown can call lock() (Three r183+ has no auto lock on click).
        // Otherwise WASD / click-to-lock never wire up (chicken-and-egg).
        if (touchMode) {
          this.detachGameplayListeners()
        }
        this.velocity = new THREE.Vector3(0, 0, 0)
      }
    })
    // Touch always needs keys/wheel; desktop needs mousedown on body to request lock.
    this.attachGameplayListeners()

    this.control.domElement.addEventListener('contextmenu', this.blockContextMenu)
  }

  // move along X with direction factor
  moveX(distance: number, delta: number) {
    this.camera.position.x +=
      distance * (this.player.speed / Math.PI) * 2 * delta
  }

  // move along Z with direction factor
  moveZ = (distance: number, delta: number) => {
    this.camera.position.z +=
      distance * (this.player.speed / Math.PI) * 2 * delta
  }

  // collide checking
  collideCheckAll = (
    position: THREE.Vector3,
    noise: Noise,
    customBlocks: Block[],
    far: number
  ) => {
    this.collideCheck(Side.down, position, noise, customBlocks, far)
    this.collideCheck(Side.front, position, noise, customBlocks)
    this.collideCheck(Side.back, position, noise, customBlocks)
    this.collideCheck(Side.left, position, noise, customBlocks)
    this.collideCheck(Side.right, position, noise, customBlocks)
    this.collideCheck(Side.up, position, noise, customBlocks)
  }

  collideCheck = (
    side: Side,
    position: THREE.Vector3,
    noise: Noise,
    customBlocks: Block[],
    far: number = this.player.body.width,
  ) => {
    const matrix = new THREE.Matrix4()

    let index = 0
    this.tempMesh.instanceMatrix = new THREE.InstancedBufferAttribute(
      new Float32Array(100 * 16),
      16,
    )

    let removed = false
    const treeRemoved = new Array<boolean>(
      this.terrain.noise.treeHeight + 1,
    ).fill(false)

    let x = Math.round(position.x)
    let z = Math.round(position.z)

    switch (side) {
      case Side.front:
        x++
        this.raycasterFront.ray.origin.copy(position)
        break
      case Side.back:
        x--
        this.raycasterBack.ray.origin.copy(position)
        break
      case Side.left:
        z--
        this.raycasterLeft.ray.origin.copy(position)
        break
      case Side.right:
        z++
        this.raycasterRight.ray.origin.copy(position)
        break
      case Side.down:
        // vyse12138/minecraft-threejs: down ray from camera, far from collideCheckAll argument.
        this.raycasterDown.ray.origin.copy(position)
        this.raycasterDown.far = far
        break
      case Side.up:
        this.raycasterUp.ray.origin.copy(position)
        this.raycasterUp.ray.origin.y -= 1
        break
    }

    let y =
      Math.floor(
        noise.get(x / noise.gap, z / noise.gap, noise.seed) * noise.amp,
      ) + 30

    for (const block of customBlocks) {
      if (block.x === x && block.z === z) {
        if (block.placed) {
          matrix.setPosition(block.x, block.y, block.z)
          this.tempMesh.setMatrixAt(index++, matrix)
        } else if (block.y === y) {
          removed = true
        } else {
          for (let i = 1; i <= this.terrain.noise.treeHeight; i++) {
            if (block.y === y + i) {
              treeRemoved[i] = true
            }
          }
        }
      }
    }

    if (!removed) {
      matrix.setPosition(x, y, z)
      this.tempMesh.setMatrixAt(index++, matrix)
    }
    for (let i = 1; i <= this.terrain.noise.treeHeight; i++) {
      if (!treeRemoved[i]) {
        const treeOffset =
          noise.get(x / noise.treeGap, z / noise.treeGap, noise.treeSeed) *
          noise.treeAmp

        const stoneOffset =
          noise.get(x / noise.stoneGap, z / noise.stoneGap, noise.stoneSeed) *
          noise.stoneAmp

        if (
          treeOffset > noise.treeThreshold &&
          y >= 27 &&
          stoneOffset < noise.stoneThreshold
        ) {
          matrix.setPosition(x, y + i, z)
          this.tempMesh.setMatrixAt(index++, matrix)
        }
      }
    }

    if (
      this.player.mode === Mode.sneaking &&
      y < Math.floor(this.camera.position.y - 2) &&
      side !== Side.down &&
      side !== Side.up
    ) {
      matrix.setPosition(
        x,
        Math.floor(this.camera.position.y - 1),
        z,
      )
      this.tempMesh.setMatrixAt(index++, matrix)
    }
    this.tempMesh.instanceMatrix.needsUpdate = true
    this.tempMesh.count = index
    this.tempMesh.boundingSphere = null
    this.tempMesh.boundingBox = null

    // Second horizontal sample 1m below eye — matches upstream minecraft-threejs.
    const bodyLowerOrigin = new THREE.Vector3(
      position.x,
      position.y - 1,
      position.z,
    )

    switch (side) {
      case Side.front: {
        const c1 = this.raycasterFront.intersectObject(this.tempMesh).length
        this.raycasterFront.ray.origin.copy(bodyLowerOrigin)
        const c2 = this.raycasterFront.intersectObject(this.tempMesh).length
        this.frontCollide = Boolean(c1 || c2)
        break
      }
      case Side.back: {
        const c1 = this.raycasterBack.intersectObject(this.tempMesh).length
        this.raycasterBack.ray.origin.copy(bodyLowerOrigin)
        const c2 = this.raycasterBack.intersectObject(this.tempMesh).length
        this.backCollide = Boolean(c1 || c2)
        break
      }
      case Side.left: {
        const c1 = this.raycasterLeft.intersectObject(this.tempMesh).length
        this.raycasterLeft.ray.origin.copy(bodyLowerOrigin)
        const c2 = this.raycasterLeft.intersectObject(this.tempMesh).length
        this.leftCollide = Boolean(c1 || c2)
        break
      }
      case Side.right: {
        const c1 = this.raycasterRight.intersectObject(this.tempMesh).length
        this.raycasterRight.ray.origin.copy(bodyLowerOrigin)
        const c2 = this.raycasterRight.intersectObject(this.tempMesh).length
        this.rightCollide = Boolean(c1 || c2)
        break
      }
      case Side.down: {
        const c1 = this.raycasterDown.intersectObject(this.tempMesh).length
        this.downCollide = c1 > 0
        break
      }
      case Side.up: {
        const c1 = this.raycasterUp.intersectObject(this.tempMesh).length
        this.upCollide = c1 > 0
        break
      }
    }
  }

  update = () => {
    this.p1 = performance.now()
    const rawDelta = (this.p1 - this.p2) / 1000
    const delta = Math.min(0.05, Math.max(0, rawDelta))
    if (
      // dev mode
      this.player.mode === Mode.flying
    ) {
      const analogFly =
        Math.abs(this.touchForward) + Math.abs(this.touchStrafe) > 0.02
      if (analogFly) {
        this.velocity.x = this.touchForward * this.player.speed
        this.velocity.z = this.touchStrafe * this.player.speed
      }
      this.control.moveForward(this.velocity.x * delta)
      this.control.moveRight(this.velocity.z * delta)
      this.camera.position.y += this.velocity.y * delta
    } else {
      // normal mode — analog stick overrides WASD while active
      if (
        Math.abs(this.touchForward) + Math.abs(this.touchStrafe) >
        0.02
      ) {
        this.velocity.x = this.touchForward * this.player.speed
        this.velocity.z = this.touchStrafe * this.player.speed
      }
      this.collideCheckAll(
        this.camera.position,
        this.terrain.noise,
        this.terrain.customBlocks,
        this.far - this.velocity.y * delta,
      )

      // Same order as vyse12138/minecraft-threejs control/index.ts
      if (Math.abs(this.velocity.y) < this.player.falling) {
        this.velocity.y -= 25 * delta
      }

      if (this.upCollide) {
        this.velocity.y = -225 * delta
        this.far = this.player.body.height
      }

      if (this.downCollide && !this.isJumping) {
        this.velocity.y = 0
      } else if (this.downCollide && this.isJumping) {
        this.isJumping = false
      }

      // side collide handler
      let vector = new THREE.Vector3(0, 0, -1).applyQuaternion(
        this.camera.quaternion
      )
      let direction = Math.atan2(vector.x, vector.z)
      if (
        this.frontCollide ||
        this.backCollide ||
        this.leftCollide ||
        this.rightCollide
      ) {
        // collide front (positive x)
        if (this.frontCollide) {
          // camera front
          if (direction < Math.PI && direction > 0 && this.velocity.x > 0) {
            if (
              (!this.leftCollide && direction > Math.PI / 2) ||
              (!this.rightCollide && direction < Math.PI / 2)
            ) {
              this.moveZ(Math.PI / 2 - direction, delta)
            }
          } else if (
            !this.leftCollide &&
            !this.rightCollide &&
            this.velocity.x > 0
          ) {
            this.control.moveForward(this.velocity.x * delta)
          }

          // camera back
          if (direction < 0 && direction > -Math.PI && this.velocity.x < 0) {
            if (
              (!this.leftCollide && direction > -Math.PI / 2) ||
              (!this.rightCollide && direction < -Math.PI / 2)
            ) {
              this.moveZ(-Math.PI / 2 - direction, delta)
            }
          } else if (
            !this.leftCollide &&
            !this.rightCollide &&
            this.velocity.x < 0
          ) {
            this.control.moveForward(this.velocity.x * delta)
          }

          // camera left
          if (
            direction < Math.PI / 2 &&
            direction > -Math.PI / 2 &&
            this.velocity.z < 0
          ) {
            if (
              (!this.rightCollide && direction < 0) ||
              (!this.leftCollide && direction > 0)
            ) {
              this.moveZ(-direction, delta)
            }
          } else if (
            !this.leftCollide &&
            !this.rightCollide &&
            this.velocity.z < 0
          ) {
            this.control.moveRight(this.velocity.z * delta)
          }

          // camera right
          if (
            (direction < -Math.PI / 2 || direction > Math.PI / 2) &&
            this.velocity.z > 0
          ) {
            if (!this.rightCollide && direction > 0) {
              this.moveZ(Math.PI - direction, delta)
            }
            if (!this.leftCollide && direction < 0) {
              this.moveZ(-Math.PI - direction, delta)
            }
          } else if (
            !this.leftCollide &&
            !this.rightCollide &&
            this.velocity.z > 0
          ) {
            this.control.moveRight(this.velocity.z * delta)
          }
        }

        // collide back (negative x)
        if (this.backCollide) {
          // camera front
          if (direction < 0 && direction > -Math.PI && this.velocity.x > 0) {
            if (
              (!this.leftCollide && direction < -Math.PI / 2) ||
              (!this.rightCollide && direction > -Math.PI / 2)
            ) {
              this.moveZ(Math.PI / 2 + direction, delta)
            }
          } else if (
            !this.leftCollide &&
            !this.rightCollide &&
            this.velocity.x > 0
          ) {
            this.control.moveForward(this.velocity.x * delta)
          }

          // camera back
          if (direction < Math.PI && direction > 0 && this.velocity.x < 0) {
            if (
              (!this.leftCollide && direction < Math.PI / 2) ||
              (!this.rightCollide && direction > Math.PI / 2)
            ) {
              this.moveZ(direction - Math.PI / 2, delta)
            }
          } else if (
            !this.leftCollide &&
            !this.rightCollide &&
            this.velocity.x < 0
          ) {
            this.control.moveForward(this.velocity.x * delta)
          }

          // camera left
          if (
            (direction < -Math.PI / 2 || direction > Math.PI / 2) &&
            this.velocity.z < 0
          ) {
            if (!this.leftCollide && direction > 0) {
              this.moveZ(-Math.PI + direction, delta)
            }
            if (!this.rightCollide && direction < 0) {
              this.moveZ(Math.PI + direction, delta)
            }
          } else if (
            !this.leftCollide &&
            !this.rightCollide &&
            this.velocity.z < 0
          ) {
            this.control.moveRight(this.velocity.z * delta)
          }

          // camera right
          if (
            direction < Math.PI / 2 &&
            direction > -Math.PI / 2 &&
            this.velocity.z > 0
          ) {
            if (
              (!this.leftCollide && direction < 0) ||
              (!this.rightCollide && direction > 0)
            ) {
              this.moveZ(direction, delta)
            }
          } else if (
            !this.leftCollide &&
            !this.rightCollide &&
            this.velocity.z > 0
          ) {
            this.control.moveRight(this.velocity.z * delta)
          }
        }

        // collide left (negative z)
        if (this.leftCollide) {
          // camera front
          if (
            (direction < -Math.PI / 2 || direction > Math.PI / 2) &&
            this.velocity.x > 0
          ) {
            if (!this.frontCollide && direction > 0) {
              this.moveX(Math.PI - direction, delta)
            }
            if (!this.backCollide && direction < 0) {
              this.moveX(-Math.PI - direction, delta)
            }
          } else if (
            !this.frontCollide &&
            !this.backCollide &&
            this.velocity.x > 0
          ) {
            this.control.moveForward(this.velocity.x * delta)
          } else if (
            this.frontCollide &&
            direction < 0 &&
            direction > -Math.PI / 2 &&
            this.velocity.x > 0
          ) {
            this.control.moveForward(this.velocity.x * delta)
          } else if (
            this.backCollide &&
            direction < Math.PI / 2 &&
            direction > 0 &&
            this.velocity.x > 0
          ) {
            this.control.moveForward(this.velocity.x * delta)
          }

          // camera back
          if (
            direction < Math.PI / 2 &&
            direction > -Math.PI / 2 &&
            this.velocity.x < 0
          ) {
            if (
              (!this.frontCollide && direction < 0) ||
              (!this.backCollide && direction > 0)
            ) {
              this.moveX(-direction, delta)
            }
          } else if (
            !this.frontCollide &&
            !this.backCollide &&
            this.velocity.x < 0
          ) {
            this.control.moveForward(this.velocity.x * delta)
          } else if (
            this.frontCollide &&
            direction < Math.PI &&
            direction > Math.PI / 2 &&
            this.velocity.x < 0
          ) {
            this.control.moveForward(this.velocity.x * delta)
          } else if (
            this.backCollide &&
            direction > -Math.PI &&
            direction < -Math.PI / 2 &&
            this.velocity.x < 0
          ) {
            this.control.moveForward(this.velocity.x * delta)
          }

          // camera left
          if (direction > 0 && direction < Math.PI && this.velocity.z < 0) {
            if (
              (!this.backCollide && direction > Math.PI / 2) ||
              (!this.frontCollide && direction < Math.PI / 2)
            ) {
              this.moveX(Math.PI / 2 - direction, delta)
            }
          } else if (
            !this.frontCollide &&
            !this.backCollide &&
            this.velocity.z < 0
          ) {
            this.control.moveRight(this.velocity.z * delta)
          } else if (
            this.frontCollide &&
            direction > -Math.PI &&
            direction < -Math.PI / 2 &&
            this.velocity.z < 0
          ) {
            this.control.moveRight(this.velocity.z * delta)
          } else if (
            this.backCollide &&
            direction > -Math.PI / 2 &&
            direction < 0 &&
            this.velocity.z < 0
          ) {
            this.control.moveRight(this.velocity.z * delta)
          }

          // camera right
          if (direction < 0 && direction > -Math.PI && this.velocity.z > 0) {
            if (
              (!this.backCollide && direction > -Math.PI / 2) ||
              (!this.frontCollide && direction < -Math.PI / 2)
            ) {
              this.moveX(-Math.PI / 2 - direction, delta)
            }
          } else if (
            !this.frontCollide &&
            !this.backCollide &&
            this.velocity.z > 0
          ) {
            this.control.moveRight(this.velocity.z * delta)
          } else if (
            this.frontCollide &&
            direction < Math.PI / 2 &&
            direction > 0 &&
            this.velocity.z > 0
          ) {
            this.control.moveRight(this.velocity.z * delta)
          } else if (
            this.backCollide &&
            direction < Math.PI &&
            direction > Math.PI / 2 &&
            this.velocity.z > 0
          ) {
            this.control.moveRight(this.velocity.z * delta)
          }
        }

        // collide right (positive z)
        if (this.rightCollide) {
          // camera front
          if (
            direction < Math.PI / 2 &&
            direction > -Math.PI / 2 &&
            this.velocity.x > 0
          ) {
            if (
              (!this.backCollide && direction < 0) ||
              (!this.frontCollide && direction > 0)
            ) {
              this.moveX(direction, delta)
            }
          } else if (
            !this.frontCollide &&
            !this.backCollide &&
            this.velocity.x > 0
          ) {
            this.control.moveForward(this.velocity.x * delta)
          } else if (
            this.frontCollide &&
            direction < -Math.PI / 2 &&
            direction > -Math.PI &&
            this.velocity.x > 0
          ) {
            this.control.moveForward(this.velocity.x * delta)
          } else if (
            this.backCollide &&
            direction < Math.PI &&
            direction > Math.PI / 2 &&
            this.velocity.x > 0
          ) {
            this.control.moveForward(this.velocity.x * delta)
          }

          // camera back
          if (
            (direction < -Math.PI / 2 || direction > Math.PI / 2) &&
            this.velocity.x < 0
          ) {
            if (!this.backCollide && direction > 0) {
              this.moveX(-Math.PI + direction, delta)
            }
            if (!this.frontCollide && direction < 0) {
              this.moveX(Math.PI + direction, delta)
            }
          } else if (
            !this.frontCollide &&
            !this.backCollide &&
            this.velocity.x < 0
          ) {
            this.control.moveForward(this.velocity.x * delta)
          } else if (
            this.frontCollide &&
            direction < Math.PI / 2 &&
            direction > 0 &&
            this.velocity.x < 0
          ) {
            this.control.moveForward(this.velocity.x * delta)
          } else if (
            this.backCollide &&
            direction < 0 &&
            direction > -Math.PI / 2 &&
            this.velocity.x < 0
          ) {
            this.control.moveForward(this.velocity.x * delta)
          }

          // camera left
          if (direction < 0 && direction > -Math.PI && this.velocity.z < 0) {
            if (
              (!this.frontCollide && direction > -Math.PI / 2) ||
              (!this.backCollide && direction < -Math.PI / 2)
            ) {
              this.moveX(Math.PI / 2 + direction, delta)
            }
          } else if (
            !this.frontCollide &&
            !this.backCollide &&
            this.velocity.z < 0
          ) {
            this.control.moveRight(this.velocity.z * delta)
          } else if (
            this.frontCollide &&
            direction > Math.PI / 2 &&
            direction < Math.PI &&
            this.velocity.z < 0
          ) {
            this.control.moveRight(this.velocity.z * delta)
          } else if (
            this.backCollide &&
            direction > 0 &&
            direction < Math.PI / 2 &&
            this.velocity.z < 0
          ) {
            this.control.moveRight(this.velocity.z * delta)
          }

          // camera right
          if (direction > 0 && direction < Math.PI && this.velocity.z > 0) {
            if (
              (!this.frontCollide && direction > Math.PI / 2) ||
              (!this.backCollide && direction < Math.PI / 2)
            ) {
              this.moveX(direction - Math.PI / 2, delta)
            }
          } else if (
            !this.frontCollide &&
            !this.backCollide &&
            this.velocity.z > 0
          ) {
            this.control.moveRight(this.velocity.z * delta)
          } else if (
            this.frontCollide &&
            direction > -Math.PI / 2 &&
            direction < 0 &&
            this.velocity.z > 0
          ) {
            this.control.moveRight(this.velocity.z * delta)
          } else if (
            this.backCollide &&
            direction > -Math.PI &&
            direction < -Math.PI / 2 &&
            this.velocity.z > 0
          ) {
            this.control.moveRight(this.velocity.z * delta)
          }
        }
      } else {
        // no collide
        this.control.moveForward(this.velocity.x * delta)
        this.control.moveRight(this.velocity.z * delta)
      }

      this.camera.position.y += this.velocity.y * delta

      // catching net
      if (this.camera.position.y < -100) {
        this.camera.position.y = 60
      }
    }
    this.p2 = this.p1
  }
}
