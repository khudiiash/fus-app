import * as THREE from 'three'
import type { WebGPURenderer } from 'three/webgpu'
import Core from './minebase/core'
import Control from './minebase/control'
import Player, { Mode } from './minebase/player'
import Terrain from './minebase/terrain'
import Audio from './minebase/audio'
import { mountBlockWorldHud, type BlockWorldHudHandle } from './blockWorldHud'
import { PLAYER_EYE_HEIGHT } from '@/game/playerConstants'
import { FirstPersonBlockWorldItems } from './firstPersonBlockWorldItems'
import { trySwapBlockWorldToWebGpu } from './minebase/blockWorldWebGpuSwap'
import Stats from 'three/addons/libs/stats.module.js'
import { useTouchGameControls } from './minebase/utils'

/**
 * When `true`, {@link prepareWebGpuRenderer} swaps to WebGPU if supported.
 * WebGPU still has weaker transparency / ordering for instanced voxel foliage in three.js r183;
 * default WebGL keeps correct depth. Flip to `true` to experiment on your target devices.
 */
const BLOCK_WORLD_USE_WEBGPU_RENDERER = false

export type SpawnTeleportResolved = {
  position: THREE.Vector3
  quaternion: THREE.Quaternion
}

function blockWorldTouchLikeDevice(): boolean {
  return (
    'ontouchstart' in window ||
    (navigator.maxTouchPoints || 0) > 0 ||
    (window.matchMedia?.('(pointer: coarse)').matches ?? false)
  )
}

export type FusBlockWorldApi = {
  start: () => void
  dispose: () => void
  /** Active graphics API after {@link prepareWebGpuRenderer} (before that, always `webgl`). */
  get rendererBackend(): 'webgpu' | 'webgl'
  /**
   * WebGPU swap when enabled in this module (see `BLOCK_WORLD_USE_WEBGPU_RENDERER`).
   * Call once after mount / `syncRendererSize`, before {@link start}. Returns `false` if unsupported or init fails.
   */
  prepareWebGpuRenderer: () => Promise<boolean>
  /** Match canvas buffer to mount element (e.g. after mobile visualViewport / layout changes). */
  syncRendererSize: () => void
  /** Move camera to the position set on first {@link start} (after surface height snap). */
  teleportToSpawn: () => void
  /**
   * When set, {@link teleportToSpawn} uses this pose if non-null; otherwise the default
   * world spawn captured at {@link start}.
   */
  setSpawnTeleportResolver: (
    fn: (() => SpawnTeleportResolved | null) | null,
  ) => void
  /** HUD from {@link start}; null before start / after dispose. */
  hud: BlockWorldHudHandle | null
  core: Core
  terrain: Terrain
  control: Control
  player: Player
}

/**
 * Embedded block world (from minecraft-threejs minebase) without the upstream HTML UI.
 * Call {@link start} after Firebase seeds / custom blocks are applied if needed.
 */
export function createFusBlockWorld(
  mountEl: HTMLElement,
  hooks?: {
    onCustomBlocksChange?: () => void
    onFrame?: (dt: number) => void
    /** Optional: reset world (Firestore + terrain); confirm in UI before calling. */
    onRestoreWorld?: () => void | Promise<void>
    /** Set this player’s spawn flag at current feet position (RTDB / UI). */
    onPlaceSpawnFlag?: () => void | Promise<void>
  },
): FusBlockWorldApi {
  let hud: BlockWorldHudHandle | null = null
  let spawnTeleportResolver: (() => SpawnTeleportResolved | null) | null = null
  let fpItems: FirstPersonBlockWorldItems | null = null
  const core = new Core(mountEl)
  const camera = core.camera
  const scene = core.scene

  const player = new Player()
  const audio = new Audio(camera)
  const terrain = new Terrain(scene, camera)
  if (hooks?.onCustomBlocksChange) {
    terrain.onCustomBlockChange(hooks.onCustomBlocksChange)
  }

  const control = new Control(
    scene,
    camera,
    player,
    terrain,
    audio,
    core.renderer.domElement,
  )

  const timer = new THREE.Timer()
  if (typeof document !== 'undefined') timer.connect(document)
  let raf = 0
  let running = false
  const spawnPosition = new THREE.Vector3()
  const spawnQuaternion = new THREE.Quaternion()
  let webGpuActive = false

  let stats: InstanceType<typeof Stats> | null = null

  const animate = () => {
    if (!running) return
    raf = requestAnimationFrame(animate)
    timer.update()
    const dt = Math.min(timer.getDelta(), 0.25)
    control.update()
    terrain.update()
    fpItems?.update(dt)
    hooks?.onFrame?.(dt)
    stats?.begin()
    if (webGpuActive) {
      ;(core.renderer as WebGPURenderer).render(scene, camera)
    } else {
      core.renderer.render(scene, camera)
    }
    stats?.end()
  }

  const teleportToSpawn = () => {
    if (!running) return
    control.velocity.set(0, 0, 0)
    control.setTouchAnalog(0, 0)
    const resolved = spawnTeleportResolver?.() ?? null
    if (resolved) {
      camera.position.copy(resolved.position)
      camera.quaternion.copy(resolved.quaternion)
    } else {
      camera.position.copy(spawnPosition)
      camera.quaternion.copy(spawnQuaternion)
    }
  }

  return {
    get rendererBackend(): 'webgpu' | 'webgl' {
      return webGpuActive ? 'webgpu' : 'webgl'
    },
    prepareWebGpuRenderer: async () => {
      if (!BLOCK_WORLD_USE_WEBGPU_RENDERER) return false
      if (webGpuActive) return true
      core.syncRendererSize()
      const size = new THREE.Vector2()
      core.renderer.getSize(size)
      const w = Math.max(1, Math.floor(size.x))
      const h = Math.max(1, Math.floor(size.y))
      const ok = await trySwapBlockWorldToWebGpu({
        core,
        control,
        pixelRatio: core.renderer.getPixelRatio(),
        width: w,
        height: h,
        antialias: !blockWorldTouchLikeDevice(),
      })
      webGpuActive = ok
      if (ok) {
        console.info('[fusBlockWorld] WebGPU renderer active.')
      } else if (typeof navigator !== 'undefined' && !navigator.gpu) {
        console.info(
          '[fusBlockWorld] WebGPU unavailable (navigator.gpu). Use https:// or localhost; rendering with WebGL.',
        )
      }
      return ok
    },
    syncRendererSize: () => {
      core.syncRendererSize()
    },
    teleportToSpawn,
    setSpawnTeleportResolver: (fn) => {
      spawnTeleportResolver = fn
    },
    get hud() {
      return hud
    },
    start: () => {
      if (running) return
      running = true
      terrain.initBlocks()
      terrain.generate()
      control.player.setMode(Mode.walking)
      {
        const n = terrain.noise
        const gx = camera.position.x
        const gz = camera.position.z
        const yOff = Math.floor(
          n.get(gx / n.gap, gz / n.gap, n.seed) * n.amp,
        )
        const groundCenterY = 30 + yOff
        const surfaceY = groundCenterY + 0.5
        camera.position.y = surfaceY + PLAYER_EYE_HEIGHT + 0.08
        spawnPosition.copy(camera.position)
        spawnQuaternion.copy(camera.quaternion)
      }
      fpItems = new FirstPersonBlockWorldItems(camera, terrain, control)
      control.onHandSwingRequested = () => {
        fpItems?.triggerHandSwing()
      }
      void fpItems.loadToolModel().catch((err) => {
        console.warn('[fusBlockWorld] pickaxe model', err)
      })
      stats = new Stats()
      stats.showPanel(0)
      const st = stats.dom
      st.style.position = 'absolute'
      st.style.left = '0'
      st.style.bottom = '0'
      st.style.top = 'auto'
      st.style.zIndex = '130'
      mountEl.appendChild(st)

      hud = mountBlockWorldHud({
        mountEl,
        control,
        touchUi: useTouchGameControls(),
        teleportToSpawn,
        onRestoreWorld: hooks?.onRestoreWorld,
        onPlaceSpawnFlag: hooks?.onPlaceSpawnFlag,
      })
      control.onPlayerDamaged = () => {
        hud?.flashDamage()
      }
      raf = requestAnimationFrame(animate)
    },
    dispose: () => {
      running = false
      spawnTeleportResolver = null
      control.onPlayerDamaged = undefined
      hud?.dispose()
      hud = null
      if (stats) {
        const el = stats.dom
        if (el.parentNode) el.parentNode.removeChild(el)
        stats = null
      }
      timer.dispose()
      fpItems?.dispose()
      fpItems = null
      control.onHandSwingRequested = undefined
      cancelAnimationFrame(raf)
      control.disposeDocumentInput()
      try {
        control.control.unlock()
      } catch {
        /* ignore */
      }
      control.control.dispose()
      try {
        terrain.generateWorker.terminate()
      } catch {
        /* ignore */
      }
      webGpuActive = false
      core.renderer.dispose()
      if (core.renderer.domElement.parentNode) {
        core.renderer.domElement.parentNode.removeChild(core.renderer.domElement)
      }
    },
    core,
    terrain,
    control,
    player,
  }
}
