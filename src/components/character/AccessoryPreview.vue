<script setup>
import '@/utils/enableThreeFileCache'
import { ref, onMounted, onUnmounted, watch } from 'vue'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

const props = defineProps({
  modelData: { type: String, default: null },
  width:     { type: Number, default: 100 },
  height:    { type: Number, default: 130 },
  /** Y rotation in degrees before framing (e.g. -30 for accessories/pets; 0 for rooms). */
  yawDeg:    { type: Number, default: -30 },
})

const canvasRef = ref(null)
let renderer = null
let scene    = null
let camera   = null

function applyNearestFilter(obj) {
  obj.traverse(child => {
    if (!child.isMesh) return
    const mats = Array.isArray(child.material) ? child.material : [child.material]
    mats.forEach(mat => {
      ;['map','normalMap','roughnessMap','metalnessMap','emissiveMap','aoMap'].forEach(k => {
        if (mat[k]) {
          mat[k].minFilter = THREE.NearestFilter
          mat[k].magFilter = THREE.NearestFilter
          mat[k].needsUpdate = true
        }
      })
    })
  })
}

function init() {
  if (!canvasRef.value) return

  renderer = new THREE.WebGLRenderer({ canvas: canvasRef.value, antialias: false, alpha: true })
  renderer.setSize(props.width, props.height)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))

  scene  = new THREE.Scene()
  camera = new THREE.PerspectiveCamera(45, props.width / props.height, 0.01, 1000)
  camera.position.set(0, 0, 3)

  scene.add(new THREE.AmbientLight(0xffffff, 1.8))
  const key = new THREE.DirectionalLight(0xfff4e0, 2.5)
  key.position.set(2, 3, 3)
  scene.add(key)
  const rim = new THREE.DirectionalLight(0x8080ff, 0.8)
  rim.position.set(-2, 1, -2)
  scene.add(rim)

  loadModel()
}

async function loadModel() {
  // Clear previous model from scene
  scene.children
    .filter(c => c.userData.isModel)
    .forEach(c => scene.remove(c))

  if (!props.modelData || !scene) {
    renderer?.render(scene, camera)
    return
  }

  try {
    const gltf = await new Promise((resolve, reject) =>
      new GLTFLoader().load(props.modelData, resolve, undefined, reject)
    )
    const model = gltf.scene
    model.userData.isModel = true
    applyNearestFilter(model)
    model.rotation.y = (props.yawDeg * Math.PI) / 180

    // Auto-fit: center and scale so longest axis = 1.6 units
    const box    = new THREE.Box3().setFromObject(model)
    const size   = box.getSize(new THREE.Vector3())
    const center = box.getCenter(new THREE.Vector3())
    const scale  = 1.6 / Math.max(size.x, size.y, size.z, 0.001)
    model.scale.setScalar(scale)
    model.position.set(-center.x * scale, -center.y * scale, -center.z * scale)

    scene.add(model)
  } catch (e) {
    console.warn('[AccessoryPreview] GLB load failed:', e)
  }

  // Single manual render — no continuous loop
  renderer?.render(scene, camera)
}

onMounted(init)

onUnmounted(() => {
  renderer?.dispose()
  renderer = null; scene = null; camera = null
})

watch(
  () => [props.modelData, props.yawDeg],
  () => {
    if (scene) loadModel()
  },
)
</script>

<template>
  <canvas
    ref="canvasRef"
    :width="width"
    :height="height"
    class="block rounded-lg"
    style="image-rendering: pixelated"
  />
</template>
