import * as THREE from 'three'
import Core from './minebase/core'
import Control from './minebase/control'
import Player, { Mode } from './minebase/player'
import Terrain from './minebase/terrain'
import Audio from './minebase/audio'
import { mountBlockWorldHud } from './blockWorldHud'
import { useTouchGameControls } from './minebase/utils'
import { PLAYER_EYE_HEIGHT } from '@/game/playerConstants'
import { FirstPersonBlockWorldItems } from './firstPersonBlockWorldItems'

export type FusBlockWorldApi = {
  start: () => void
  dispose: () => void
  /** Match WebGL buffer to mount element (e.g. after mobile visualViewport / layout changes). */
  syncRendererSize: () => void
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
  },
): FusBlockWorldApi {
  let disposeHud: (() => void) | null = null
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

  return {
    syncRendererSize: () => {
      core.syncRendererSize()
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
      }
      fpItems = new FirstPersonBlockWorldItems(camera, terrain, control)
      control.onHandSwingRequested = () => {
        fpItems?.triggerHandSwing()
      }
      void fpItems.loadToolModel().catch((err) => {
        console.warn('[fusBlockWorld] pickaxe model', err)
      })
      disposeHud = mountBlockWorldHud({
        mountEl,
        control,
        touchUi: useTouchGameControls(),
      })
      raf = requestAnimationFrame(animate)
    },
    dispose: () => {
      running = false
      disposeHud?.()
      disposeHud = null
      fpItems?.dispose()
      fpItems = null
      control.onHandSwingRequested = undefined
      cancelAnimationFrame(raf)
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
