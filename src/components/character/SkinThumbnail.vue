<script setup>
/**
 * Lightweight skin thumbnail — 2D canvas only, zero WebGL.
 * Crops the face region (8,8 → 16,16) from a Minecraft skin texture.
 * Falls back to the skinId colour palette if no URL is provided.
 */
import { ref, onMounted, watch } from 'vue'

const props = defineProps({
  skinUrl: { type: String, default: null },
  skinId:  { type: String, default: 'default' },
  size:    { type: Number, default: 40 },
})

const PALETTES = {
  default:  '#7c3aed', sigma:    '#1f2937', brainrot: '#c026d3',
  ohio:     '#166534', rizz:     '#7e22ce', npc:      '#4b5563',
  brat:     '#65a30d', chillguy: '#b45309', skibidi:  '#0ea5e9',
  galaxy:   '#3730a3', fire:     '#dc2626',
}

const canvasRef = ref(null)

function drawFallback() {
  const canvas = canvasRef.value
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  const color = PALETTES[props.skinId] || PALETTES.default
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = color
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  // Simple white pixel-eyes
  const s = canvas.width / 8
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(s * 2, s * 2, s, s)
  ctx.fillRect(s * 5, s * 2, s, s)
  ctx.fillStyle = '#000000'
  ctx.fillRect(s * 2.4, s * 2.4, s * 0.5, s * 0.5)
  ctx.fillRect(s * 5.4, s * 2.4, s * 0.5, s * 0.5)
}

function draw() {
  const canvas = canvasRef.value
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = false

  if (!props.skinUrl) { drawFallback(); return }

  const img = new Image()
  // Do NOT set crossOrigin — we never call getImageData() so CORS is not needed.
  // Setting it would cause a CORS cache-poisoning failure if the browser already
  // has the image cached without CORS headers (common for local Vite asset URLs).
  img.onload = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    // Face front layer: texture coords (8,8) size (8,8) in a 64×64 sheet
    ctx.drawImage(img, 8, 8, 8, 8, 0, 0, canvas.width, canvas.height)
    // Hat/overlay layer: texture coords (40,8) size (8,8) — drawn on top
    ctx.drawImage(img, 40, 8, 8, 8, 0, 0, canvas.width, canvas.height)
  }
  img.onerror = drawFallback
  img.src = props.skinUrl
}

onMounted(draw)
watch(() => [props.skinUrl, props.skinId], draw)
</script>

<template>
  <canvas
    ref="canvasRef"
    :width="size"
    :height="size"
    class="rounded-md flex-shrink-0"
    style="image-rendering: pixelated"
  />
</template>
