import * as THREE from 'three'
import Core from './minebase/core'
import Control from './minebase/control'
import Player, { Mode } from './minebase/player'
import Terrain from './minebase/terrain'
import Audio from './minebase/audio'
import { mountBlockWorldHud, type BlockWorldHudHandle } from './blockWorldHud'
import { useTouchGameControls } from './minebase/utils'
import { PLAYER_EYE_HEIGHT } from '@/game/playerConstants'
import { FirstPersonBlockWorldItems } from './firstPersonBlockWorldItems'

export type SpawnTeleportResolved = {
  position: THREE.Vector3
  quaternion: THREE.Quaternion
}

export type FusBlockWorldApi = {
  start: () => void
  dispose: () => void
  /** Match WebGL buffer to mount element (e.g. after mobile visualViewport / layout changes). */
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
  const renderer = core.renderer

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
    renderer.domElement,
  )

  const clock = new THREE.Clock()
  let raf = 0
  let running = false
  const spawnPosition = new THREE.Vector3()
  const spawnQuaternion = new THREE.Quaternion()

  const animate = () => {
    if (!running) return
    raf = requestAnimationFrame(animate)
    const dt = clock.getDelta()
    control.update()
    terrain.update()
    fpItems?.update(dt)
    hooks?.onFrame?.(dt)
    renderer.render(scene, camera)
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
      clock.start()
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
      hud = mountBlockWorldHud({
        mountEl,
        control,
        touchUi: useTouchGameControls(),
        teleportToSpawn,
        onRestoreWorld: hooks?.onRestoreWorld,
        onPlaceSpawnFlag: hooks?.onPlaceSpawnFlag,
      })
      raf = requestAnimationFrame(animate)
    },
    dispose: () => {
      running = false
      spawnTeleportResolver = null
      hud?.dispose()
      hud = null
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
      renderer.dispose()
      if (renderer.domElement.parentNode) {
        renderer.domElement.parentNode.removeChild(renderer.domElement)
      }
    },
    core,
    terrain,
    control,
    player,
  }
}
