import * as THREE from 'three'
import type Core from '@/game/minebase/core'
import type Control from '@/game/minebase/control'

/**
 * When `navigator.gpu` is available, replaces the block world canvas with {@link WebGPURenderer}
 * (no SSGI / composer — same scene graph, fewer moving parts).
 * Falls back if init fails.
 */
export async function trySwapBlockWorldToWebGpu(opts: {
  core: Core
  control: Control
  pixelRatio: number
  width: number
  height: number
  /** Match {@link THREE.WebGLRenderer} defaults from Core (MSAA off on coarse-pointer devices). */
  antialias?: boolean
}): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.gpu) return false

  const THREE_GPU = await import('three/webgpu')
  const oldRenderer = opts.core.renderer
  if (oldRenderer instanceof THREE_GPU.WebGPURenderer) return true
  if (!(oldRenderer instanceof THREE.WebGLRenderer)) return false

  const oldCanvas = oldRenderer.domElement
  const oldParent = oldCanvas.parentNode
  if (!oldParent) {
    console.warn('[fusWebGpu] canvas has no parent; cannot swap renderer')
    return false
  }

  const renderer = new THREE_GPU.WebGPURenderer({
    antialias: opts.antialias ?? false,
    alpha: false,
    powerPreference: 'high-performance',
  })

  try {
    await renderer.init()
  } catch (e) {
    console.warn('[fusWebGpu] WebGPURenderer.init failed', e)
    renderer.dispose()
    return false
  }

  opts.control.control.disconnect()
  oldRenderer.dispose()
  oldParent.removeChild(oldCanvas)

  renderer.outputColorSpace = THREE_GPU.SRGBColorSpace
  renderer.toneMapping = THREE_GPU.NeutralToneMapping
  renderer.toneMappingExposure = 1.2
  renderer.setPixelRatio(opts.pixelRatio)
  renderer.setSize(opts.width, opts.height)
  oldParent.appendChild(renderer.domElement)

  ;(opts.core as unknown as { renderer: typeof renderer }).renderer = renderer
  opts.control.rebindPointerLockElement(renderer.domElement)

  return true
}
