<script setup>
import { ref, onMounted, onUnmounted, watch } from 'vue'
import * as skinview3d from 'skinview3d'
import * as THREE from 'three'
import { loadRemoteSkinForViewer } from '@/utils/loadRemoteSkinForViewer'

const props = defineProps({
  skinUrl: { type: String, default: null },
  skinId:  { type: String, default: 'default' },
  width:   { type: Number, default: 100 },
  height:  { type: Number, default: 160 },
  /** No panel fill — WebGL clear alpha 0 (e.g. shop modal over game background). */
  transparentBackground: { type: Boolean, default: false },
})

// ─── Canvas-based fallback skin generation ───────────────────────────────────
// Returns an HTMLCanvasElement so loadSkin() can use it synchronously (no Promise).
const SKIN_PALETTES = {
  default:  { body: '#7c3aed', legs: '#7c3aed', head: '#7c3aed' },
  sigma:    { body: '#374151', legs: '#111827', head: '#1f2937' },
  brainrot: { body: '#d946ef', legs: '#86198f', head: '#c026d3' },
  ohio:     { body: '#15803d', legs: '#14532d', head: '#166534' },
  rizz:     { body: '#9333ea', legs: '#581c87', head: '#7e22ce' },
  npc:      { body: '#9ca3af', legs: '#6b7280', head: '#4b5563' },
  brat:     { body: '#84cc16', legs: '#3f6212', head: '#65a30d' },
  chillguy: { body: '#d97706', legs: '#92400e', head: '#b45309' },
  skibidi:  { body: '#38bdf8', legs: '#0369a1', head: '#0ea5e9' },
  galaxy:   { body: '#4338ca', legs: '#1e1b4b', head: '#3730a3' },
  fire:     { body: '#ef4444', legs: '#7f1d1d', head: '#dc2626' },
}

function generateSkinCanvas(skinId) {
  const p = SKIN_PALETTES[skinId] || SKIN_PALETTES.default
  const c = document.createElement('canvas')
  c.width = 64; c.height = 64
  const ctx = c.getContext('2d')
  ctx.fillStyle = p.body
  ctx.fillRect(0, 0, 64, 64)
  // Head
  ctx.fillStyle = p.head;  ctx.fillRect(8, 8, 8, 8)
  // Body
  ctx.fillStyle = p.body;  ctx.fillRect(20, 20, 8, 12)
  // Right arm
  ctx.fillStyle = p.body;  ctx.fillRect(44, 20, 4, 12)
  // Left arm
  ctx.fillStyle = p.body;  ctx.fillRect(36, 52, 4, 12)
  // Right leg
  ctx.fillStyle = p.legs;  ctx.fillRect(4, 20, 4, 12)
  // Left leg
  ctx.fillStyle = p.legs;  ctx.fillRect(20, 52, 4, 12)
  // Eyes
  ctx.fillStyle = '#ffffff'; ctx.fillRect(9, 10, 2, 2); ctx.fillRect(13, 10, 2, 2)
  ctx.fillStyle = '#000000'; ctx.fillRect(10, 10, 1, 1); ctx.fillRect(14, 10, 1, 1)
  // Smile
  ctx.fillStyle = '#000000'; ctx.fillRect(10, 13, 1, 1); ctx.fillRect(11, 14, 2, 1); ctx.fillRect(13, 13, 1, 1)
  return c
}

const canvasRef = ref(null)
let viewer = null

async function initViewer() {
  if (!canvasRef.value) return
  safeDispose()

  viewer = new skinview3d.SkinViewer({
    canvas:       canvasRef.value,
    width:        props.width,
    height:       props.height,
    renderPaused: true,   // we render manually — no continuous RAF
  })

  // three.js r183 renamed ShaderPass.fsQuad → ._fsQuad (private).
  // skinview3d's dispose() still calls .fsQuad.dispose(), so patch it back.
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

  const fallbackCanvas = generateSkinCanvas(props.skinId || 'default')
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