/**
 * Single shared WebGL context for baking GLB previews to PNG data URLs.
 * Shop / lists enqueue renders serially so the browser never opens N contexts.
 */
import '@/utils/enableThreeFileCache'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

const MAX_CACHE_ENTRIES = 96

/** @type {Map<string, string>} */
const cache = new Map()

let renderer = null
let scene = null
let camera = null
let lastW = 0
let lastH = 0

/** Serial queue; each step ends with .catch so one failure does not block the rest */
let pipeline = Promise.resolve()

function ensureRenderer(width, height) {
  if (!renderer || lastW !== width || lastH !== height) {
    renderer?.dispose()
    renderer = new THREE.WebGLRenderer({
      antialias: false,
      alpha: true,
      preserveDrawingBuffer: true,
    })
    renderer.setSize(width, height, false)
    renderer.setPixelRatio(1)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.setClearColor(0x000000, 0)
    lastW = width
    lastH = height

    scene = new THREE.Scene()
    scene.background = null

    const aspect = width / height
    camera = new THREE.PerspectiveCamera(40, aspect, 0.01, 2000)

    const amb = new THREE.AmbientLight(0xffffff, 1.8)
    scene.add(amb)

    const keyLight = new THREE.DirectionalLight(0xfff4e0, 2.5)
    keyLight.position.set(2, 3, 3)
    scene.add(keyLight)

    const rim = new THREE.DirectionalLight(0x8080ff, 0.8)
    rim.position.set(-2, 1, -2)
    scene.add(rim)
  }
}

function applyNearestFilter(obj) {
  obj.traverse(child => {
    if (!child.isMesh) return
    const mats = Array.isArray(child.material) ? child.material : [child.material]
    mats.forEach(mat => {
      if (!mat) return
      ;['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap'].forEach(k => {
        if (mat[k]) {
          mat[k].minFilter = THREE.NearestFilter
          mat[k].magFilter = THREE.NearestFilter
          mat[k].needsUpdate = true
        }
      })
    })
  })
}

function disposeObject3D(root) {
  root.traverse(child => {
    if (!child.isMesh) return
    child.geometry?.dispose()
    const mats = Array.isArray(child.material) ? child.material : [child.material]
    mats.forEach(mat => {
      if (!mat) return
      for (const key of Object.keys(mat)) {
        const v = mat[key]
        if (v && typeof v.dispose === 'function' && v.isTexture) v.dispose()
      }
      mat.dispose?.()
    })
  })
}

function cacheKey(modelData, width, height, isRoom) {
  return JSON.stringify([
    isRoom,
    width,
    height,
    modelData,
    GLB_THUMB_FILL_BOOST,
    isRoom ? 0 : THUMB_NON_ROOM_YAW_RAD,
  ])
}

function trimCache() {
  while (cache.size > MAX_CACHE_ENTRIES) {
    const k = cache.keys().next().value
    cache.delete(k)
  }
}

/**
 * @param {string} modelData
 * @param {number} width
 * @param {number} height
 * @param {{ isRoom?: boolean }} [opts]
 * @returns {Promise<string>} image/png data URL
 */
/**
 * Scale + center model so its bounding sphere fits inside the camera frustum at distance z.
 * Uses min(vertical, horizontal) half-extent so nothing clips on wide or tall assets.
 */
/** Extra scale so the model fills more of the baked PNG (card size stays the same in the UI). */
const GLB_THUMB_FILL_BOOST = 1.42

/** Accessories & pets: yaw so models don’t stare straight into the thumbnail camera. Rooms unchanged. */
const THUMB_NON_ROOM_YAW_RAD = (-30 * Math.PI) / 180

function fitModelToFrustum(model, size, center, distZ, margin) {
  const vFOV = (camera.fov * Math.PI) / 180
  const vHalf = distZ * Math.tan(vFOV / 2)
  const hHalf = vHalf * camera.aspect
  const fitRadius = Math.min(vHalf, hHalf) * margin
  const r = 0.5 * Math.sqrt(
    size.x * size.x + size.y * size.y + size.z * size.z,
  )
  const scale = (fitRadius / Math.max(r, 1e-4)) * GLB_THUMB_FILL_BOOST
  model.scale.setScalar(scale)
  model.position.set(-center.x * scale, -center.y * scale, -center.z * scale)
}

async function renderOnce(modelData, width, height, opts = {}) {
  const isRoom = !!opts.isRoom
  ensureRenderer(width, height)

  renderer.setClearColor(0x000000, 0)
  scene.background = null

  // Room: slightly looser margin (user-approved look). Accessory: extra padding — was clipping past frustum.
  const distZ = isRoom ? 3.5 : 2.85
  const margin = isRoom ? 0.86 : 0.72
  camera.position.set(0, 0, distZ)
  camera.lookAt(0, 0, 0)
  camera.updateProjectionMatrix()

  const toRemove = scene.children.filter(c => c.userData.isThumbModel)
  toRemove.forEach(c => {
    scene.remove(c)
    disposeObject3D(c)
  })

  const gltf = await new Promise((resolve, reject) => {
    new GLTFLoader().load(modelData, resolve, undefined, reject)
  })

  const model = gltf.scene
  model.userData.isThumbModel = true
  applyNearestFilter(model)

  if (!isRoom) {
    model.rotation.y = THUMB_NON_ROOM_YAW_RAD
  }

  const box = new THREE.Box3().setFromObject(model)
  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())
  fitModelToFrustum(model, size, center, distZ, margin)

  scene.add(model)
  renderer.clear(true, true, true)
  renderer.render(scene, camera)

  const dataUrl = renderer.domElement.toDataURL('image/png')

  scene.remove(model)
  disposeObject3D(model)

  return dataUrl
}

/**
 * @param {string|null|undefined} modelData
 * @param {number} width
 * @param {number} height
 * @param {{ isRoom?: boolean }} [opts]
 * @returns {Promise<string>}
 */
export function requestGlbThumbnail(modelData, width, height, opts = {}) {
  if (!modelData) return Promise.reject(new Error('Missing modelData'))

  const key = cacheKey(modelData, width, height, !!opts.isRoom)
  if (cache.has(key)) return Promise.resolve(cache.get(key))

  const run = async () => {
    const dataUrl = await renderOnce(modelData, width, height, opts)
    trimCache()
    cache.set(key, dataUrl)
    return dataUrl
  }

  const p = pipeline.catch(() => {}).then(run)
  pipeline = p.catch(() => {})
  return p
}

/** Drop cached image for a given model (e.g. after admin replaces file). */
export function invalidateGlbThumbnail(modelData) {
  if (!modelData) return
  for (const k of [...cache.keys()]) {
    try {
      const parsed = JSON.parse(k)
      const md = parsed[3]
      if (md === modelData) cache.delete(k)
    } catch { /* ignore */ }
  }
}

export function disposeGlbThumbnailRenderer() {
  pipeline = Promise.resolve()
  cache.clear()
  if (renderer) {
    renderer.dispose()
    renderer = null
  }
  scene = null
  camera = null
  lastW = 0
  lastH = 0
}
