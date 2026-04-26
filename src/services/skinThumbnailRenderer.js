/**
 * One shared MinecraftSkinHost — bakes character + skin to PNG (shop grids).
 * Serial queue + memory cache + IndexedDB across sessions (thumbnailIndexedDb.js).
 */
import { getPersistentThumbnail, setPersistentThumbnail } from '@/services/thumbnailIndexedDb'
import { loadRemoteSkinForViewer } from '@/utils/loadRemoteSkinForViewer'
import { MinecraftSkinHost } from '@/character/minecraftSkinHost.js'
import * as THREE from 'three'
import { generateFusAvatarSkinCanvas } from '@/lib/fusAvatarSkinCanvas.js'

const MAX_CACHE_ENTRIES = 96

/** @type {Map<string, string>} */
const cache = new Map()

let viewer = null
let canvas = null
let lastW = 0
let lastH = 0
let pipeline = Promise.resolve()

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
  viewer = new MinecraftSkinHost({
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

  const fallbackCanvas = generateFusAvatarSkinCanvas(skinId || 'default')
  await loadRemoteSkinForViewer(viewer, skinUrl, fallbackCanvas)

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

  return getPersistentThumbnail('skin', key).then((fromDisk) => {
    if (cache.has(key)) return cache.get(key)
    if (fromDisk) {
      trimCache()
      cache.set(key, fromDisk)
      return fromDisk
    }

    const run = async () => {
      if (cache.has(key)) return cache.get(key)
      const dataUrl = await renderOnce(skinUrl, skinId, width, height)
      trimCache()
      cache.set(key, dataUrl)
      setPersistentThumbnail('skin', key, dataUrl)
      return dataUrl
    }

    const p = pipeline.catch(() => {}).then(run)
    pipeline = p.catch(() => {})
    return p
  })
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
