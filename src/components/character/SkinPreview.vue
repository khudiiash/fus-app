<script setup>
import { ref, onMounted, onUnmounted, watch } from 'vue'
import { MinecraftSkinHost } from '@/character/minecraftSkinHost.js'
import * as THREE from 'three'
import { loadRemoteSkinForViewer } from '@/utils/loadRemoteSkinForViewer'
import { generateFusAvatarSkinCanvas } from '@/lib/fusAvatarSkinCanvas.js'

const props = defineProps({
  skinUrl: { type: String, default: null },
  skinId:  { type: String, default: 'default' },
  width:   { type: Number, default: 100 },
  height:  { type: Number, default: 160 },
  /** No panel fill — WebGL clear alpha 0 (e.g. shop modal over game background). */
  transparentBackground: { type: Boolean, default: false },
})

const canvasRef = ref(null)
let viewer = null

async function initViewer() {
  if (!canvasRef.value) return
  safeDispose()

  viewer = new MinecraftSkinHost({
    canvas:       canvasRef.value,
    width:        props.width,
    height:       props.height,
    renderPaused: true,   // we render manually — no continuous RAF
  })

  // three.js r183 renamed ShaderPass.fsQuad → ._fsQuad (private).
  // Host dispose() still calls .fsQuad.dispose(), so patch it back.
  if (viewer.fxaaPass?._fsQuad && !viewer.fxaaPass.fsQuad) {
    Object.defineProperty(viewer.fxaaPass, 'fsQuad', {
      get() { return this._fsQuad },
      configurable: true,
    })
  }

  // Lighting
  viewer.globalLight.intensity = 2.5
  viewer.cameraLight.intensity = 0.5
  const hemi = new THREE.HemisphereLight(0xaaaaff, 0x442200, 0.6)
  viewer.scene.add(hemi)

  // Disable all controls — static view
  viewer.controls.enableRotate = false
  viewer.controls.enableZoom   = false
  viewer.controls.enablePan    = false
  viewer.controls.autoRotate   = false

  // No animation — static T-pose
  viewer.animation = null

  // Slightly zoomed out so the full character is visible in the thumbnail
  viewer.zoom = 0.9

  viewer.nameTag = null

  await loadAndRender()
}

function safeDispose() {
  if (!viewer) return
  try { viewer.dispose() } catch { /* r183 compat — dispose may throw */ }
  viewer = null
}

function applyViewerBackground() {
  if (!viewer) return
  if (props.transparentBackground) {
    viewer.background = null
    viewer.renderer.setClearColor(0x000000, 0)
  } else {
    viewer.background = 0x0f0c24
    viewer.renderer.setClearColor(0x0f0c24, 1)
  }
}

function applyNearestFilterToSkin() {
  if (!viewer) return
  viewer.playerObject.traverse(child => {
    if (child.isMesh && child.material?.map) {
      child.material.map.minFilter = THREE.NearestFilter
      child.material.map.magFilter = THREE.NearestFilter
      child.material.map.needsUpdate = true
    }
  })
}

async function loadAndRender() {
  if (!viewer) return
  applyViewerBackground()

  const fallbackCanvas = generateFusAvatarSkinCanvas(props.skinId || 'default')
  await loadRemoteSkinForViewer(viewer, props.skinUrl, fallbackCanvas)

  // Pixel-perfect Minecraft look
  applyNearestFilterToSkin()

  // Render twice: first pass lets three.js finish uploading textures to GPU,
  // second pass produces the final correct image.
  viewer.renderer.render(viewer.scene, viewer.camera)
  requestAnimationFrame(() => {
    if (viewer) viewer.renderer.render(viewer.scene, viewer.camera)
  })
}

onMounted(initViewer)

onUnmounted(safeDispose)

// Re-render whenever the skin URL or fallback ID changes
watch(() => [props.skinUrl, props.skinId, props.transparentBackground], loadAndRender)
</script>

<template>
  <canvas
    ref="canvasRef"
    :width="width"
    :height="height"
    class="block rounded-lg overflow-hidden"
    style="image-rendering: pixelated"
  />
</template>