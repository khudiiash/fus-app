<script setup>
import BlockWorldGuiBlockIcon from '@/components/blockWorld/BlockWorldGuiBlockIcon.vue'

/**
 * Renders one block-world hotbar cell (emoji / block texture / tool sprite sheet).
 * Shared by in-profile hotbar editor and picker grid.
 */
defineProps({
  visual: { type: Object, required: true },
  /** When set, blocks use the same 3-face GL preview as the in-game hotbar. */
  minecraft: { type: Object, default: null },
  /** Canvas resolution for GL block icons (inventory uses a larger value). */
  blockIconRenderSize: { type: Number, default: 28 },
})

function bgPos(vis) {
  const cols = vis.cols <= 1 ? 1 : vis.cols
  const rows = vis.rows <= 1 ? 1 : vis.rows
  const posX = cols <= 1 ? 0 : (vis.col / (cols - 1)) * 100
  const posY = rows <= 1 ? 0 : (vis.row / (rows - 1)) * 100
  return { posX, posY, cols, rows }
}

/** 16×16 terrain atlas: one index per 16px tile (see BlockRenderer.renderGuiItem). */
function terrainBgPos(vis) {
  const t = (vis.textureSlot | 0) & 255
  const col = t % 16
  const row = Math.floor(t / 16)
  const cols = vis.cols <= 1 ? 16 : vis.cols
  const rows = vis.rows <= 1 ? 16 : vis.rows
  const posX = cols <= 1 ? 0 : (col / (cols - 1)) * 100
  const posY = rows <= 1 ? 0 : (row / (rows - 1)) * 100
  return { posX, posY }
}
</script>

<template>
  <img
    v-if="visual.type === 'img'"
    class="bw-hb-icon-img"
    alt=""
    draggable="false"
    :src="visual.src"
  />
  <BlockWorldGuiBlockIcon
    v-else-if="visual.type === 'blockIcon' && minecraft"
    class="bw-hb-gui-block"
    :minecraft="minecraft"
    :engine-block-id="visual.engineBlockId"
    :size="blockIconRenderSize"
  />
  <div
    v-else-if="visual.type === 'terrainSprite'"
    class="bw-hb-tool-sprite bw-hb-terrain-sprite"
    role="presentation"
    :style="{
      backgroundImage: `url(${String(visual.sheetSrc)})`,
      backgroundSize: `${visual.cols * 100}% ${visual.rows * 100}%`,
      backgroundPosition: `${terrainBgPos(visual).posX}% ${terrainBgPos(visual).posY}%`,
    }"
  />
  <div
    v-else-if="visual.type === 'blockIcon'"
    class="bw-hb-tool-sprite bw-hb-terrain-sprite"
    role="presentation"
    :style="{
      backgroundImage: `url(${String(visual.sheetSrc)})`,
      backgroundSize: `${visual.cols * 100}% ${visual.rows * 100}%`,
      backgroundPosition: `${terrainBgPos(visual).posX}% ${terrainBgPos(visual).posY}%`,
    }"
  />
  <div
    v-else-if="visual.type === 'toolSprite'"
    class="bw-hb-tool-sprite"
    role="presentation"
    :style="{
      backgroundImage: `url(${String(visual.sheetSrc)})`,
      backgroundSize: `${visual.cols * 100}% ${visual.rows * 100}%`,
      backgroundPosition: `${bgPos(visual).posX}% ${bgPos(visual).posY}%`,
    }"
  />
  <span v-else class="bw-hb-emoji">{{ visual.text }}</span>
</template>

<style scoped>
.bw-hb-icon-img {
  width: 30px;
  height: 30px;
  image-rendering: pixelated;
  pointer-events: none;
}
.bw-hb-tool-sprite {
  width: 30px;
  height: 30px;
  background-repeat: no-repeat;
  image-rendering: pixelated;
  pointer-events: none;
}
.bw-hb-emoji {
  font-size: 1.35rem;
  line-height: 1;
  user-select: none;
  pointer-events: none;
}
</style>
