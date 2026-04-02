<script setup>
/**
 * Baked GLB preview via a single shared WebGLRenderer (see glbThumbnailRenderer.js).
 * Renders to a PNG data URL — safe for dense grids (shop, avatar picker).
 */
import { ref, watch } from 'vue'
import { requestGlbThumbnail } from '@/services/glbThumbnailRenderer'
import { Home, Gem, Loader2 } from 'lucide-vue-next'

const props = defineProps({
  modelData: { type: String, default: null },
  width:     { type: Number, default: 186 },
  height:    { type: Number, default: 252 },
  /** Room GLBs — camera pulled back + larger fit target */
  isRoom:    { type: Boolean, default: false },
})

const dataUrl = ref(null)
const failed  = ref(false)
const loading = ref(false)
let requestId = 0

async function tryRender(id) {
  const scale = Math.min(2, typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1.5)
  const rw = Math.max(80, Math.round(props.width * scale))
  const rh = Math.max(80, Math.round(props.height * scale))
  return requestGlbThumbnail(props.modelData, rw, rh, {
    isRoom: props.isRoom,
  })
}

async function run() {
  if (!props.modelData) {
    dataUrl.value = null
    failed.value = true
    loading.value = false
    return
  }
  const id = ++requestId
  loading.value = true
  failed.value = false
  dataUrl.value = null
  try {
    const url = await tryRender(id)
    if (id !== requestId) return
    dataUrl.value = url
  } catch {
    if (id !== requestId) return
    // One retry: shared WebGL pipeline can fail under load (many thumbs, mobile); brief delay helps
    await new Promise(r => setTimeout(r, 350))
    if (id !== requestId) return
    try {
      const url = await tryRender(id)
      if (id !== requestId) return
      dataUrl.value = url
    } catch {
      if (id !== requestId) return
      failed.value = true
    }
  } finally {
    if (id === requestId) loading.value = false
  }
}

watch(
  () => [props.modelData, props.width, props.height, props.isRoom],
  () => { run() },
  { immediate: true },
)
</script>

<template>
  <div
    class="relative flex items-center justify-center overflow-hidden rounded-lg"
    :style="{ width: width + 'px', height: height + 'px' }"
  >
    <img
      v-if="dataUrl"
      :src="dataUrl"
      alt=""
      class="block w-full h-full object-contain"
      :style="{ maxWidth: width + 'px', maxHeight: height + 'px' }"
      draggable="false"
    />
    <Loader2
      v-else-if="loading"
      :size="28"
      class="text-slate-500 animate-spin"
      :stroke-width="2"
    />
    <div v-else-if="failed" class="flex flex-col items-center justify-center gap-1 text-slate-600 px-2">
      <Home v-if="isRoom" :size="32" :stroke-width="1.2" />
      <Gem v-else :size="30" :stroke-width="1.2" />
    </div>
  </div>
</template>
