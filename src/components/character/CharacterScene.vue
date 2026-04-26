<script setup>
import '@/utils/enableThreeFileCache'
import { loadRemoteSkinForViewer } from '@/utils/loadRemoteSkinForViewer'
import { generateFusAvatarSkinCanvas } from '@/lib/fusAvatarSkinCanvas.js'
import { ref, onMounted, onUnmounted, watch } from 'vue'
import {
  MinecraftSkinHost,
  IdleAnimation,
  WaveAnimation,
  HitAnimation,
} from '@/character/minecraftSkinHost.js'
import * as THREE from 'three'
import { Coins } from 'lucide-vue-next'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'

const props = defineProps({
  profile:              { type: Object,  default: null },
  ownedItemIds:         { type: Array,   default: () => [] },
  allItems:             { type: Array,   default: () => [] },
  roomMode:             { type: Boolean, default: false },
  interactive:          { type: Boolean, default: true },
  readonly:             { type: Boolean, default: false },
  width:                { type: Number,  default: 0 },
  height:               { type: Number,  default: 0 },
  roomOverrideUrl:      { type: String,  default: null }, // tester: override room GLB
  skinOverrideUrl:      { type: String,  default: null }, // tester: override skin PNG
  accessoryOverrideUrl: { type: String,  default: null }, // tester: preview accessory GLB
  /** Fitting room: preview pet GLB URL (wins over profile.avatar.petId + allItems). */
  petOverrideUrl:       { type: String,  default: null },
  accessoryBone:        { type: String,  default: 'head' }, // 'head' | 'body'
  brightnessOverride:   { type: Number,  default: null  }, // fitting room slider (0.1–3.0)
  initialZoom:          { type: Number,  default: null  }, // profile hero / custom framing
  showRoomHud:          { type: Boolean, default: true },   // name/coins strip in room mode
})

const emit = defineEmits(['clickItem'])

const canvasRef    = ref(null)
const containerRef = ref(null)
let viewer         = null
let animFrame      = null
let _resizeObs     = null
let _emoteTimer    = null

// ── Emote definitions ─────────────────────────────────────────────────────────
// Each entry: a factory for the animation instance + how long to play it (ms).
// WaveAnimation plays one arm-raise cycle ≈ 2.4 s at default speed = 1.
// HitAnimation plays one flinch cycle     ≈ 0.9 s at default speed = 1.
const EMOTES = [
  { make: () => new WaveAnimation('right'), ms: 2400 },
  { make: () => new WaveAnimation('left'),  ms: 2400 },
  { make: () => new HitAnimation(),         ms: 900  },
]

function scheduleEmote() {
  // Random idle gap: 8–18 seconds
  const idleMs = 8000 + Math.random() * 10000
  _emoteTimer = setTimeout(() => {
    if (!viewer) return
    const emote = EMOTES[Math.floor(Math.random() * EMOTES.length)]
    viewer.animation = emote.make()

    // After the emote finishes, return to idle then queue the next one
    _emoteTimer = setTimeout(() => {
      if (!viewer) return
      viewer.animation = new IdleAnimation()
      scheduleEmote()
    }, emote.ms)
  }, idleMs)
}

function cancelEmote() {
  if (_emoteTimer) { clearTimeout(_emoteTimer); _emoteTimer = null }
}

// ─── Per-model brightness ──────────────────────────────────────────────────────
// Stores original material colors keyed by material.uuid so the slider can be
// moved back-and-forth non-destructively.
const _origMatColors = new Map()   // uuid → { color: Color, emissive: Color }
let   _currentRoomObj = null       // the currently loaded room Object3D

function applyModelBrightness(model, multiplier) {
  if (!model) return
  const m = multiplier ?? 1.0
  model.traverse(child => {
    if (!child.isMesh) return
    const mats = Array.isArray(child.material) ? child.material : [child.material]
    mats.forEach(mat => {
      const id = mat.uuid
      if (!_origMatColors.has(id)) {
        _origMatColors.set(id, {
          color:    mat.color    ? mat.color.clone()    : null,
          emissive: mat.emissive ? mat.emissive.clone() : null,
        })
      }
      const orig = _origMatColors.get(id)
      if (mat.color && orig.color)       mat.color.copy(orig.color).multiplyScalar(m)
      if (mat.emissive && orig.emissive) mat.emissive.copy(orig.emissive).multiplyScalar(m)
      mat.needsUpdate = true
    })
  })
}

// ─── Zoom ─────────────────────────────────────────────────────────────────────
const MIN_ZOOM = 0.20
const MAX_ZOOM = 2.00
const currentZoom = ref(0.75)

function clampZoom(z) { return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z)) }

function applyZoom(delta) {
  if (!viewer) return
  const next = clampZoom(viewer.zoom + delta)
  viewer.zoom = next
  currentZoom.value = next
  // Keep OrbitControls internal spherical in sync with the moved camera
  viewer.controls.update()
}

// Track whether the pointer is currently inside the canvas container.
// Wheel events are only intercepted (and page scroll prevented) when the
// pointer is truly hovering over the 3D canvas.
let _pointerOverCanvas = false
function _onPointerEnterCanvas() { _pointerOverCanvas = true  }
function _onPointerLeaveCanvas() { _pointerOverCanvas = false }

// Desktop scroll wheel — non-passive so we can preventDefault
function onWheel(e) {
  if (!viewer || !_pointerOverCanvas) return
  e.preventDefault()
  // Normalise across trackpad (small delta) and mouse wheel (large delta)
  const raw = e.deltaY !== 0 ? e.deltaY : -e.deltaX
  const step = Math.sign(raw) * Math.min(Math.abs(raw) * 0.0008, 0.12)
  applyZoom(-step)
}

// Mobile pinch — track distance between two fingers
let _pinchDist = null

function _pinchDistance(e) {
  return Math.hypot(
    e.touches[0].clientX - e.touches[1].clientX,
    e.touches[0].clientY - e.touches[1].clientY
  )
}

function onTouchStart(e) {
  if (e.touches.length === 2) _pinchDist = _pinchDistance(e)
}

function onTouchMove(e) {
  if (e.touches.length !== 2 || _pinchDist === null) return
  e.preventDefault() // stop the browser pinch-zoom
  const newDist = _pinchDistance(e)
  applyZoom((newDist - _pinchDist) * 0.004)
  _pinchDist = newDist
}

function onTouchEnd(e) {
  if (e.touches.length < 2) _pinchDist = null
}

// Fixed room wall color — consistent dark navy look
const ROOM_WALL_COLOR  = 0x0f0c24
const ROOM_FLOOR_COLOR = 0x1a1008
const ROOM_BG_COLOR    = 0x111111

// ─── Nearest-filter helper (Minecraft pixel-perfect textures) ─────────────────
function applyNearestFilter(object) {
  object.traverse(child => {
    if (!child.isMesh) return
    const mats = Array.isArray(child.material) ? child.material : [child.material]
    mats.forEach(mat => {
      const keys = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'alphaMap']
      keys.forEach(k => {
        if (mat[k]) {
          mat[k].minFilter = THREE.NearestFilter
          mat[k].magFilter = THREE.NearestFilter
          mat[k].needsUpdate = true
        }
      })
    })
  })
}


// Load a custom room GLB from a base64 data URL (no caching — data URL is the key)
function loadCustomRoomModel(dataUrl) {
  return new Promise((resolve, reject) =>
    new GLTFLoader().load(dataUrl, gltf => resolve(gltf.scene), undefined, reject)
  )
}

// Token to cancel stale async buildRoom calls when the watcher fires rapidly
let _buildRoomToken = 0

// ─── Companion pet (room mode only): GLB + AnimationMixer, left of the player ──
let _petMixer = null
let _petRoot = null
let _applyPetToken = 0

const PET_IDLE_HINTS = ['idle', 'rest', 'stand', 'breathe', 'breathing', 'wait', 'loop', 'relax']

/** If the authored pet is larger than this (world units), scale down only. Smaller pets (bee vs dragon) keep their relative size. */
const PET_MAX_DIMENSION = 38
/** World anchor beside the player; pet root (0,0,0) is placed here — vertical offset in the GLB is kept (e.g. bee hovering). */
const PET_ANCHOR_X = -12
const PET_ANCHOR_Z = -8

function pickPetIdleClip(animations) {
  if (!animations?.length) return null
  const scored = animations.map((clip) => {
    const n = (clip.name || '').toLowerCase()
    let score = 0
    for (let i = 0; i < PET_IDLE_HINTS.length; i++) {
      if (n.includes(PET_IDLE_HINTS[i])) {
        score = PET_IDLE_HINTS.length - i
        break
      }
    }
    return { clip, score }
  })
  scored.sort((a, b) => b.score - a.score)
  return scored[0].score > 0 ? scored[0].clip : animations[0]
}

function disposePet() {
  if (_petMixer) {
    _petMixer.stopAllAction()
    _petMixer = null
  }
  if (_petRoot && viewer?.scene) {
    viewer.scene.remove(_petRoot)
    _petRoot.traverse((child) => {
      if (child.geometry) child.geometry.dispose()
      if (child.material) {
        const mats = Array.isArray(child.material) ? child.material : [child.material]
        mats.forEach((m) => m.dispose?.())
      }
    })
  }
  _petRoot = null
}

/** Inline copy of MinecraftSkinHost.draw() plus pet mixer tick (avoids double clock.getDelta). */
function installPetAwareDraw(viewerInstance) {
  if (!viewerInstance || viewerInstance._fusPetDrawInstalled) return
  viewerInstance._fusPetDrawInstalled = true
  viewerInstance.draw = function fusPetDraw() {
    const dt = this.clock.getDelta()
    if (_petMixer) _petMixer.update(dt)
    if (this._animation !== null) {
      this._animation.update(this.playerObject, dt)
    }
    if (this.autoRotate) {
      if (!(this.controls.enableRotate && this.isUserRotating)) {
        this.playerWrapper.rotation.y += dt * this.autoRotateSpeed
      }
    }
    this.controls.update()
    this.render()
    this.animationID = window.requestAnimationFrame(() => this.draw())
  }
}

async function applyEquippedPet() {
  const token = ++_applyPetToken
  disposePet()
  if (!viewer || !props.roomMode || !props.profile) return

  let modelUrl = props.petOverrideUrl || null
  let debugName = 'pet'
  if (!modelUrl) {
    const petId = props.profile.avatar?.petId || null
    if (!petId) return
    const item = (props.allItems || []).find((i) => i.id === petId)
    if (!item?.modelData) return
    modelUrl = item.modelData
    debugName = item.name
  }

  try {
    const gltf = await new Promise((resolve, reject) =>
      new GLTFLoader().load(modelUrl, resolve, undefined, reject),
    )
    if (token !== _applyPetToken || !viewer) return

    const model = gltf.scene;
    model.userData.isPet = true
    applyNearestFilter(model)
    model.traverse((child) => {
      if (child.isMesh) {
        child.castShadow = true
        child.receiveShadow = true
      }
    })

    const box = new THREE.Box3().setFromObject(model)
    const size = box.getSize(new THREE.Vector3())
    const maxDim = Math.max(size.x, size.y, size.z, 0.001)
    if (maxDim > PET_MAX_DIMENSION) {
      model.scale.setScalar(PET_MAX_DIMENSION / maxDim)
    }

    const floorY = -16
    model.position.set(PET_ANCHOR_X, floorY, PET_ANCHOR_Z)

    viewer.scene.add(model)
    _petRoot = model

    const clip = pickPetIdleClip(gltf.animations || [])
    if (clip) {
      _petMixer = new THREE.AnimationMixer(model)
      const action = _petMixer.clipAction(clip)
      action.play()
    }
  } catch (e) {
    if (token === _applyPetToken) console.warn('[CharacterScene] Pet GLB failed:', debugName, e)
  }
}

// ─── Room builder ─────────────────────────────────────────────────────────────
// roomItem can be a Firestore item object { modelData, brightnessMultiplier, ... }
// or null to load the default room.
async function buildRoom(scene, roomItem = null) {
  const token = ++_buildRoomToken

  // Remove previous room objects
  ;[...scene.children]
    .filter(c => c.userData.isRoom)
    .forEach(c => scene.remove(c))

  // If no room GLB is available, skip straight to the procedural fallback box
  if (!roomItem?.modelData && !props.roomOverrideUrl) {
    if (token !== _buildRoomToken || !viewer) return
    buildProceduralRoom(scene)
    return
  }

  try {
    // Load the equipped room GLB
    const room = roomItem?.modelData
      ? await loadCustomRoomModel(roomItem.modelData)
      : await loadCustomRoomModel(props.roomOverrideUrl)

    if (token !== _buildRoomToken || !viewer) return  // stale — newer call superseded us

    // Place the room so its local origin (0,0,0) sits exactly at the character's
    // feet (y=-16 in scene space).  All positioning/scaling should be done in the
    // modelling software — set the GLB origin to the spot where the character stands.
    room.position.set(0, -16, 0)
    room.userData.isRoom = true
    applyNearestFilter(room)
    room.traverse(child => {
      if (child.isMesh) {
        child.receiveShadow = true
        child.castShadow    = true
        child.userData.isRoom = true
      }
    })

    // Brightness priority (per-model — modifies material colors, not scene exposure):
    //   1. Stored Firestore value (item.brightnessMultiplier) — set when admin adds the item
    //   2. Fitting-room live slider override (props.brightnessOverride)
    //   3. Blender custom property on the GLB (backwards-compat fallback)
    //   4. 1.0 (neutral)
    const brightness =
      roomItem?.brightnessMultiplier
      ?? props.brightnessOverride
      ?? room.userData?.brightnessMultiplier
      ?? room.userData?.extras?.brightnessMultiplier
      ?? 0.25

    _origMatColors.clear()   // fresh colour cache for each newly loaded room
    _currentRoomObj = room
    applyModelBrightness(room, brightness)

    scene.add(room)
  } catch (err) {
    if (token !== _buildRoomToken || !viewer) return
    console.warn('[CharacterScene] GLB room failed to load, using procedural fallback:', err)
    buildProceduralRoom(scene)
  }

}

function buildProceduralRoom(scene) {
  const wallMat  = new THREE.MeshLambertMaterial({ color: ROOM_WALL_COLOR, side: THREE.FrontSide })
  const floorMat = new THREE.MeshLambertMaterial({ color: ROOM_FLOOR_COLOR })
  const W = 120, H = 90, D = 120
  const addPlane = (geo, mat, x, y, z, rx = 0, ry = 0) => {
    const m = new THREE.Mesh(geo, mat)
    m.position.set(x, y, z); m.rotation.x = rx; m.rotation.y = ry
    m.userData.isRoom = true; m.receiveShadow = true
    scene.add(m)
  }
  addPlane(new THREE.PlaneGeometry(W, D), floorMat, 0, -16, 0, -Math.PI / 2)
  addPlane(new THREE.PlaneGeometry(W, H), wallMat,  0, H / 2 - 16, -D / 2)
  addPlane(new THREE.PlaneGeometry(D, H), wallMat,  -W / 2, H / 2 - 16, 0, 0,  Math.PI / 2)
  addPlane(new THREE.PlaneGeometry(D, H), wallMat,   W / 2, H / 2 - 16, 0, 0, -Math.PI / 2)
}


// ─── Setup & teardown ─────────────────────────────────────────────────────────
function initViewer() {
  if (!canvasRef.value) return

  const w = props.width  || containerRef.value?.clientWidth  || 320
  const h = props.height || containerRef.value?.clientHeight || 420

  viewer = new MinecraftSkinHost({
    canvas:  canvasRef.value,
    width:   w,
    height:  h,
  })

  installPetAwareDraw(viewer)

  // ── Renderer ────────────────────────────────────────────────────────────────
  // Reinhard is much gentler on dark areas than ACES — preserves room detail.
  viewer.renderer.toneMapping         = THREE.ReinhardToneMapping
  viewer.renderer.toneMappingExposure = 1.0
  viewer.renderer.outputColorSpace    = THREE.SRGBColorSpace
  viewer.renderer.shadowMap.enabled   = true
  viewer.renderer.shadowMap.type = THREE.VSMShadowMap


  // ── Patch for three.js r183 compatibility ───────────────────────────────────
  // MinecraftSkinHost dispose() calls fxaaPass.fsQuad.dispose() but r183 ShaderPass
  // renamed the property from .fsQuad to ._fsQuad (private).
  if (viewer.fxaaPass && viewer.fxaaPass._fsQuad && !viewer.fxaaPass.fsQuad) {
    Object.defineProperty(viewer.fxaaPass, 'fsQuad', {
      get() { return this._fsQuad },
      configurable: true,
    })
  }

  // ── Lighting ────────────────────────────────────────────────────────────────
  viewer.globalLight.intensity = 0.0
  viewer.cameraLight.intensity = 0.0

  // Soft ambient lift — keeps dark corners readable without overexposing the character
  const ambient = new THREE.AmbientLight(0xbbccdd, 0.5)
  ambient.userData.isSceneLight = true
  viewer.scene.add(ambient)


  // ── Key spotlight ───────────────────────────────────────────────────────────
  const keySpot = new THREE.SpotLight(0xfff8e8, 500, 520, Math.PI / 10.5, 0.5, 1.0)
  keySpot.position.set(-45, 100, 55)
  keySpot.target.position.set(0, -5, 0)
  keySpot.castShadow            = true 
  keySpot.shadow.mapSize.width  = 1024 
  keySpot.shadow.mapSize.height = 1024
  keySpot.shadow.camera.near    = 20
  keySpot.shadow.camera.far     = 350
  keySpot.shadow.radius = 20
  keySpot.shadow.bias           = -0.005
  keySpot.userData.isSceneLight = true
  viewer.scene.add(keySpot)
  viewer.scene.add(keySpot.target)

  // ── Warm fill — softens key-light shadow side ─────────────────────────────────
  // const fillLight = new THREE.DirectionalLight(0xffddb0, 0.9)
  // fillLight.position.set(70, 15, 45)
  // fillLight.userData.isSceneLight = true
  // viewer.scene.add(fillLight)

  // ── Top-down fill — lifts ceilings and upper surfaces ────────────────────────
  // const topFill = new THREE.DirectionalLight(0xffffff, 0.4)
  // topFill.position.set(0, 100, 0)
  // topFill.userData.isSceneLight = true
  // viewer.scene.add(topFill)

  const lampLight = new THREE.PointLight(0xffaa55, 300, 180, 1.0)
  lampLight.position.set(-25, 50, -25)
  lampLight.userData.isSceneLight = true
  viewer.scene.add(lampLight)

  const windowLight = new THREE.PointLight(0xffff99, 100, 160, 1.0)
  windowLight.position.set(65, 35, 10)
  windowLight.userData.isSceneLight = true
  viewer.scene.add(windowLight)

  // ── Camera ──────────────────────────────────────────────────────────────────
  const defaultZoom = props.initialZoom != null ? clampZoom(props.initialZoom) : 0.4
  viewer.zoom = defaultZoom
  currentZoom.value = defaultZoom

  // ── Controls ────────────────────────────────────────────────────────────────
  viewer.controls.enableZoom   = false
  viewer.controls.enablePan    = false
  viewer.controls.enableRotate = props.interactive
  viewer.controls.autoRotate   = false

  // ── Animation ───────────────────────────────────────────────────────────────
  viewer.animation = new IdleAnimation()

  // No built-in name tag — we use the HTML overlay instead
  viewer.nameTag = null

  // Let the character cast shadows on the floor
  viewer.playerObject.traverse(child => {
    if (child.isMesh) {
      child.castShadow    = true
      child.receiveShadow = true
    }
  })

  setupPostProcessing()
  applyProfile().catch(e => console.warn('[CharacterScene] applyProfile error:', e))

  // Start the idle → emote → idle cycle
  cancelEmote()
  scheduleEmote()
}

// ─── Post-processing (GTAO + Bloom) ───────────────────────────────────────────
// Injected into the host EffectComposer so the existing animation loop,
// controls, and skin system keep working unchanged.
//
// Pipeline:
//   RenderPass  — renders scene (materials bake Reinhard tone-mapping in their
//                 shaders because renderer.toneMapping is set above)
//   GTAOPass    — reads depth buffer, computes and blends soft contact AO
//   BloomPass   — selective bloom on bright/emissive surfaces
//   FXAAShader  — anti-aliasing; as the last pass it renders to screen,
//                 at which point the renderer applies outputColorSpace (sRGB)
//
// NOTE: OutputPass is intentionally omitted here.  OutputPass converts linear
// HDR → sRGB, but the FXAA pass (renderToScreen=true) triggers the renderer's
// outputColorSpace conversion, causing double-sRGB if OutputPass is also present.
// The three.js materials already bake tone-mapping, so the pipeline is correct.
let _gtaoPass  = null
let _bloomPass = null

function setupPostProcessing() {
  if (!viewer) return

  const w = viewer.width  || 512
  const h = viewer.height || 512


  _bloomPass = new UnrealBloomPass(
    new THREE.Vector2(w, h),
    0.1,  // strength  — very subtle, only emissive highlights glow
    1.0,   // radius
    0.55   // threshold — only near-white pixels bloom
  )

  // Rebuild: default host passes [RenderPass, FXAAShader] → we want [RenderPass, Bloom, FXAAShader]
  viewer.composer.passes = [
    viewer.renderPass,
    _bloomPass,
    viewer.fxaaPass,
  ]
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

async function applyProfile() {
  if (!viewer || !props.profile) return

  const avatar = props.profile.avatar || {}

  // 1. Skin — skinOverrideUrl (tester) takes priority, then profile url, then palette fallback
  const fallbackCanvas = generateFusAvatarSkinCanvas(avatar.skinId || 'default')
  const skinUrl = props.skinOverrideUrl || avatar.skinUrl
  await loadRemoteSkinForViewer(viewer, skinUrl, fallbackCanvas)
  applyNearestFilterToSkin()

  // 2. Accessories on bones (profile accessories, then override if set)
  await applyAccessories(avatar.accessories || [])
  if (props.accessoryOverrideUrl) await applyAccessoryOverride()

  // 3. Room — pass full roomItem so buildRoom can use its stored brightnessMultiplier
  if (props.roomMode) {
    const roomItemId = avatar.roomId || null
    const roomItem   = roomItemId ? (props.allItems || []).find(i => i.id === roomItemId) : null
    await buildRoom(viewer.scene, roomItem || null)
    await applyEquippedPet()
  }

  // 4. Background — fixed dark color
  viewer.background = props.roomMode ? ROOM_BG_COLOR : 0x0f0c24
}

/**
 * When `allItems` hydrates after first paint (length 0 → N), upgrade room/pet/accessories
 * without reloading the skin — avoids visible multi-blink from stacked full applyProfile calls.
 */
async function applyCatalogDependentLayers() {
  if (!viewer || !props.profile) return
  const avatar = props.profile.avatar || {}
  await applyAccessories(avatar.accessories || [])
  if (props.accessoryOverrideUrl) await applyAccessoryOverride()
  if (props.roomMode) {
    const roomItemId = avatar.roomId || null
    const roomItem = roomItemId ? (props.allItems || []).find((i) => i.id === roomItemId) : null
    await buildRoom(viewer.scene, roomItem || null)
    await applyEquippedPet()
  }
  viewer.background = props.roomMode ? ROOM_BG_COLOR : 0x0f0c24
}

let _avatarApplyTimer = null
function scheduleApplyProfileFromAvatar() {
  if (_avatarApplyTimer) clearTimeout(_avatarApplyTimer)
  _avatarApplyTimer = setTimeout(() => {
    _avatarApplyTimer = null
    if (!viewer || !props.profile) return
    cancelEmote()
    applyProfile()
      .catch(() => {})
      .then(() => {
        if (viewer) scheduleEmote()
      })
  }, 40)
}

async function applyAccessories(accessoryItemIds) {
  if (!viewer) return
  const head = viewer.playerObject.skin.head
  const body = viewer.playerObject.skin.body

  // Clean old accessories
  ;[head, body].forEach(part => {
    [...part.children].filter(c => c.userData.isAccessory).forEach(c => {
      c.traverse(child => {
        if (child.geometry) child.geometry.dispose()
        if (child.material) {
          const mats = Array.isArray(child.material) ? child.material : [child.material]
          mats.forEach(m => m.dispose())
        }
      })
      part.remove(c)
    })
  })

  for (const itemId of accessoryItemIds) {
    const item = props.allItems.find(i => i.id === itemId)
    if (!item) continue

    if (item.modelData) {
      // Load GLB from base64 data URL (stored in Firestore — no CORS issues)
      try {
        const gltf = await new Promise((resolve, reject) =>
          new GLTFLoader().load(item.modelData, resolve, undefined, reject)
        )
        const model = gltf.scene
        applyNearestFilter(model)
        // Scale so a ~1-unit model fits the Minecraft head (~8 units wide)
        model.scale.setScalar(8)
        // Sit the model on top of the head
        model.position.set(0, 9, 0)
        model.userData.isAccessory = true
        head.add(model)
      } catch (e) {
        console.warn('[CharacterScene] Failed to load accessory GLB:', item.name, e)
      }
    }
  }
}

// Swap only the skin texture — does not touch accessories, room or camera
async function applySkinOnly() {
  if (!viewer) return
  const avatar = props.profile?.avatar || {}
  const fallback = generateFusAvatarSkinCanvas(avatar.skinId || 'default')
  const skinUrl = props.skinOverrideUrl || avatar.skinUrl
  await loadRemoteSkinForViewer(viewer, skinUrl, fallback)
  applyNearestFilterToSkin()
}

// Load a single accessory from a local URL (for the fitting-room tester)
async function applyAccessoryOverride() {
  if (!viewer || !props.accessoryOverrideUrl) return
  const boneMap = {
    head:     viewer.playerObject.skin.head,
    body:     viewer.playerObject.skin.body,
    leftArm:  viewer.playerObject.skin.leftArm,
    rightArm: viewer.playerObject.skin.rightArm,
  }
  const bone = boneMap[props.accessoryBone] ?? boneMap.head

  // Remove previous overrides on this bone
  ;[...bone.children].filter(c => c.userData.isAccessoryOverride).forEach(c => {
    c.traverse(child => {
      if (child.geometry) child.geometry.dispose()
      if (child.material) [child.material].flat().forEach(m => m.dispose())
    })
    bone.remove(c)
  })

  try {
    const gltf = await new Promise((resolve, reject) =>
      new GLTFLoader().load(props.accessoryOverrideUrl, resolve, undefined, reject)
    )
    const model = gltf.scene
    applyNearestFilter(model)
    model.scale.setScalar(8)
    model.position.set(0, props.accessoryBone === 'head' ? 9 : 0, 0)
    model.userData.isAccessory = true
    model.userData.isAccessoryOverride = true
    bone.add(model)
  } catch (e) {
    console.warn('[CharacterScene] accessory override load failed:', e)
  }
}

function handleResize() {
  if (!viewer || !containerRef.value) return
  const w = props.width  || containerRef.value.clientWidth
  const h = props.height || containerRef.value.clientHeight
  if (w > 0 && h > 0) {
    viewer.width  = w
    viewer.height = h
  }
}

onMounted(() => {
  initViewer()
  window.addEventListener('resize', handleResize)

  // ResizeObserver corrects the viewer dimensions whenever the container's
  // actual layout size is known (flex/grid resolve asynchronously after mount).
  if (window.ResizeObserver && containerRef.value) {
    _resizeObs = new ResizeObserver(handleResize)
    _resizeObs.observe(containerRef.value)
  }

  // Attach zoom + hover-guard listeners
  const el = containerRef.value
  if (el) {
    el.addEventListener('pointerenter', _onPointerEnterCanvas, { passive: true })
    el.addEventListener('pointerleave', _onPointerLeaveCanvas, { passive: true })
    el.addEventListener('wheel',        onWheel,               { passive: true })
    el.addEventListener('touchstart',   onTouchStart,          { passive: true  })
    el.addEventListener('touchmove',    onTouchMove,           { passive: false })
    el.addEventListener('touchend',     onTouchEnd,            { passive: true  })
  }
})

onUnmounted(() => {
  if (_avatarApplyTimer) {
    clearTimeout(_avatarApplyTimer)
    _avatarApplyTimer = null
  }

  window.removeEventListener('resize', handleResize)
  _resizeObs?.disconnect()
  _resizeObs = null

  _pointerOverCanvas = false
  _currentRoomObj = null
  _origMatColors.clear()

  const el = containerRef.value
  if (el) {
    el.removeEventListener('pointerenter', _onPointerEnterCanvas)
    el.removeEventListener('pointerleave', _onPointerLeaveCanvas)
    el.removeEventListener('wheel',        onWheel)
    el.removeEventListener('touchstart',   onTouchStart)
    el.removeEventListener('touchmove',    onTouchMove)
    el.removeEventListener('touchend',     onTouchEnd)
  }

  cancelEmote()
  disposePet()

  if (viewer) {
    // try/catch: dispose() accesses fxaaPass.fsQuad which
    // was renamed to _fsQuad in three.js r183 (we patch it above but guard anyway)
    try { viewer.dispose() } catch (_) { viewer.renderer?.dispose?.() }
    viewer = null
  }
})

// Avatar edits — debounce so Firestore/profile snapshot churn doesn’t stack full reloads
watch(() => props.profile?.avatar, () => scheduleApplyProfileFromAvatar(), { deep: true })

// Catalog arrived late: patch GLB room / pet / shop accessories only (no skin re-fetch)
watch(
  () => props.allItems?.length ?? 0,
  (len, prevLen) => {
    if (!viewer || !props.profile) return
    if (prevLen !== 0 || len === 0) return
    cancelEmote()
    applyCatalogDependentLayers()
      .catch(() => {})
      .then(() => {
        if (viewer) scheduleEmote()
      })
  },
)

watch(
  () => props.roomMode,
  (rm) => {
    if (!viewer) return
    if (!rm) disposePet()
    else applyProfile().catch(() => {})
  },
)

watch(() => props.interactive, (val) => {
  if (viewer) viewer.controls.enableRotate = val
})

// Rebuild room instantly when tester switches the override URL
watch(() => props.roomOverrideUrl, () => { if (viewer && props.roomMode) buildRoom(viewer.scene, null) })

watch(() => props.petOverrideUrl, () => {
  if (viewer && props.roomMode) applyEquippedPet().catch(() => {})
})

// Live brightness slider — updates current room's material colours in place (no reload)
watch(() => props.brightnessOverride, (v) => {
  if (v != null && _currentRoomObj) applyModelBrightness(_currentRoomObj, v)
})

// Surgical per-layer watchers — each only touches its own part of the scene
watch(() => props.skinOverrideUrl,      () => applySkinOnly().catch(() => {}))
watch(() => props.accessoryOverrideUrl, () => applyAccessoryOverride().catch(() => {}))
watch(() => props.accessoryBone,        () => applyAccessoryOverride().catch(() => {}))
</script>

<template>
  <div
    ref="containerRef"
    class="relative w-full h-full overflow-hidden"
    :class="roomMode ? 'rounded-none' : 'rounded-2xl'"
  >
    <canvas ref="canvasRef" class="w-full h-full block" />

    <!-- Zoom controls -->
    <div class="absolute top-3 right-3 flex flex-col gap-1 z-10">
      <button
        @click="applyZoom(+0.12)"
        class="w-8 h-8 rounded-lg bg-black/50 backdrop-blur border border-white/10 text-white flex items-center justify-center text-lg font-bold hover:bg-black/70 active:scale-95 transition-transform select-none"
        aria-label="Zoom in"
      >+</button>
      <button
        @click="applyZoom(-0.12)"
        class="w-8 h-8 rounded-lg bg-black/50 backdrop-blur border border-white/10 text-white flex items-center justify-center text-lg font-bold hover:bg-black/70 active:scale-95 transition-transform select-none"
        aria-label="Zoom out"
      >−</button>
    </div>

    <!-- Overlay HUD: anchored at the bottom so it never overlaps the character head -->
    <div v-if="roomMode && profile && showRoomHud" class="absolute bottom-10 left-0 right-0 flex justify-center pointer-events-none">
      <div class="bg-black/60 backdrop-blur-md rounded-2xl px-4 py-2 flex items-center gap-3 border border-white/10">
        <span class="font-extrabold text-base text-white">{{ profile.displayName }}</span>
        <span class="text-xs bg-violet-600/80 rounded-full px-2 py-0.5 font-bold text-white">Рів. {{ profile.level || 1 }}</span>
        <span class="inline-flex items-center gap-1 text-xs text-amber-300 font-bold tabular-nums">
          <Coins :size="12" :stroke-width="2" class="text-coin shrink-0" />
          {{ (profile.coins || 0).toLocaleString() }}
        </span>
      </div>
    </div>
  </div>
</template>
