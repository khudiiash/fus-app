<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { renderFusGuiBlockIconToCanvas } from '@labymc/src/js/net/minecraft/client/fus/FusGuiBlockIcon.js'

const props = defineProps({
  /** @type {import('@labymc/src/js/net/minecraft/client/Minecraft.js').default | null} */
  minecraft: { type: Object, default: null },
  engineBlockId: { type: Number, required: true },
  size: { type: Number, default: 28 },
})

const host = ref(null)
let raf = 0

function draw() {
  if (raf) {
    cancelAnimationFrame(raf)
  }
  raf = requestAnimationFrame(() => {
    raf = 0
    const el = host.value
    const mc = props.minecraft
    if (!el) return
    if (!mc?.worldRenderer) {
      el.replaceChildren()
      return
    }
    const c = renderFusGuiBlockIconToCanvas(mc, props.engineBlockId | 0, props.size | 0)
    el.replaceChildren()
    if (c) {
      c.className = 'bw-gui-block-canvas'
      c.style.width = '100%'
      c.style.height = '100%'
      c.style.objectFit = 'contain'
      c.style.imageRendering = 'pixelated'
      c.style.display = 'block'
      el.appendChild(c)
    }
  })
}

watch(
  () => [props.minecraft, props.engineBlockId, props.size],
  () => draw(),
  { deep: false },
)

onMounted(() => draw())
onBeforeUnmount(() => {
  if (raf) {
    cancelAnimationFrame(raf)
  }
})
</script>

<template>
  <div ref="host" class="bw-gui-block-host" />
</template>

<style scoped>
.bw-gui-block-host {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
</style>
