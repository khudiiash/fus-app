/**
 * One shared skinview3d SkinViewer — bakes character + skin to PNG (shop grids).
 * Serial queue + cache; same pattern as glbThumbnailRenderer.js
 */
import * as skinview3d from 'skinview3d'
import * as THREE from 'three'

const MAX_CACHE_ENTRIES = 96

/** @type {Map<string, string>} */
const cache = new Map()

let viewer = null
let canvas = null
let lastW = 0
let lastH = 0
let pipeline = Promise.resolve()

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
  ctx.fillStyle = p.head;  ctx.fillRect(8, 8, 8, 8)
  ctx.fillStyle = p.body;  ctx.fillRect(20, 20, 8, 12)
  ctx.fillStyle = p.body;  ctx.fillRect(44, 20, 4, 12)
  ctx.fillStyle = p.body;  ctx.fillRect(36, 52, 4, 12)
  ctx.fillStyle = p.legs;  ctx.fillRect(4, 20, 4, 12)
  ctx.fillStyle = p.legs;  ctx.fillRect(20, 52, 4, 12)
  ctx.fillStyle = '#ffffff'; ctx.fillRect(9, 10, 2, 2); ctx.fillRect(13, 10, 2, 2)
  ctx.fillStyle = '#000000'; ctx.fillRect(10, 10, 1, 1); ctx.fillRect(14, 10, 1, 1)
  ctx.fillStyle = '#000000'; ctx.fillRect(10, 13, 1, 1); ctx.fillRect(11, 14, 2, 1); ctx.fillRect(13, 13, 1, 1)
  return c
}

function patchFxaa(viewer) {
  if (viewer.fxaaPass?._fsQuad && !viewer.fxaaPass.fsQuad) {
    Object.defineProperty(viewer.fxaaPass, 'fsQuad', {
      get() { return this._fsQuad },
      configurable: true,
    })
  }
}

function safeDisposeViewer() {
  if (!viewer) return
  try { viewer.dispose() } catch { /* r183 */ }
  viewer = null
  canvas = null
  lastW = 0
  lastH = 0
}

function ensureViewer(w, h) {
  if (viewer && lastW === w && lastH === h) return

  safeDisposeViewer()
  canvas = document.createElement('canvas')
  viewer = new skinview3d.SkinViewer({
    canvas,
    width:  w,
    height: h,
    renderPaused: true,
    preserveDrawingBuffer: true,
    pixelRatio: 1,
  })
  patchFxaa(viewer)

  lastW = w
  lastH = h

  viewer.background = null
  viewer.scene.background = null
  viewer.renderer.setClearColor(0x000000, 0)

  viewer.globalLight.intensity = 2.2
  viewer.cameraLight.intensity = 0.5
  const hemi = new THREE.HemisphereLight(0xaaccff, 0x442211, 0.55)
  viewer.scene.add(hemi)

  viewer.controls.enableRotate = false
  viewer.controls.enableZoom   = false
  viewer.controls.enablePan    = false
  viewer.controls.autoRotate   = false
  viewer.animation = null
  viewer.nameTag = null
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

function cacheKey(skinUrl, skinId, w, h) {
  return JSON.stringify(['skin', skinUrl || '', skinId || 'default', w, h])
}

function trimCache() {
  while (cache.size > MAX_CACHE_ENTRIES) {
    cache.delete(cache.keys().next().value)
  }
}

async function renderOnce(skinUrl, skinId, w, h) {
  ensureViewer(w, h)

  viewer.background = null
  viewer.scene.background = null
  viewer.renderer.setClearColor(0x000000, 0)

  const fallbackCanvas = generateSkinCanvas(skinId || 'default')
  if (skinUrl) {
    try {
      await viewer.loadSkin(skinUrl)
    } catch {
      viewer.loadSkin(fallbackCanvas)
    }
  } else {
    viewer.loadSkin(fallbackCanvas)
  }

  applyNearestFilterToSkin()
  viewer.resetCameraPose()
  viewer.fov = 52
  viewer.zoom = 1.08

  viewer.renderer.render(viewer.scene, viewer.camera)
  await new Promise(r => requestAnimationFrame(r))
  viewer.renderer.render(viewer.scene, viewer.camera)

  return canvas.toDataURL('image/png')
}

/**
 * @param {string|null|undefined} skinUrl
 * @param {string|null|undefined} skinId
 * @param {number} width
 * @param {number} height
 */
export function requestSkinThumbnail(skinUrl, skinId, width, height) {
  const key = cacheKey(skinUrl, skinId, width, height)
  if (cache.has(key)) return Promise.resolve(cache.get(key))

  const run = async () => {
    const dataUrl = await renderOnce(skinUrl, skinId, width, height)
    trimCache()
    cache.set(key, dataUrl)
    return dataUrl
  }

  const p = pipeline.catch(() => {}).then(run)
  pipeline = p.catch(() => {})
  return p
}

export function invalidateSkinThumbnail(skinUrl) {
  if (skinUrl == null) return
  for (const k of [...cache.keys()]) {
    try {
      const [, url] = JSON.parse(k)
      if (url === skinUrl) cache.delete(k)
    } catch { /* ignore */ }
  }
}

export function disposeSkinThumbnailRenderer() {
  pipeline = Promise.resolve()
  cache.clear()
  safeDisposeViewer()
}
