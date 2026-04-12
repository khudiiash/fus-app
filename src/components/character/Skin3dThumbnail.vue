<script setup>
/**
 * Baked full-body skin preview (shared MinecraftSkinHost + queue). PNG with alpha.
 */
import { ref, watch } from 'vue'
import { requestSkinThumbnail } from '@/services/skinThumbnailRenderer'
import { Loader2, Palette } from 'lucide-vue-next'

const props = defineProps({
  skinUrl: { type: String, default: null },
  skinId:  { type: String, default: 'default' },
  width:   { type: Number, default: 112 },
  height:  { type: Number, default: 151 },
})

const dataUrl = ref(null)
const failed  = ref(false)
const loading = ref(false)
let requestId = 0

async function tryRender(id) {
  const scale = Math.min(2, typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1.5)
  const rw = Math.max(80, Math.round(props.width * scale))
  const rh = Math.max(80, Math.round(props.height * scale))
  return requestSkinThumbnail(props.skinUrl, props.skinId, rw, rh)
}

async function run() {
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
  () => [props.skinUrl, props.skinId, props.width, props.height],
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
    <Palette v-else-if="failed" :size="30" class="text-slate-600" :stroke-width="1.5" />
  </div>
</template>
