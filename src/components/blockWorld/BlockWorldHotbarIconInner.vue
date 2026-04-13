<script setup>
/**
 * Renders one block-world hotbar cell (emoji / block texture / tool sprite sheet).
 * Shared by in-profile hotbar editor and picker grid.
 */
defineProps({
  visual: { type: Object, required: true },
})

function bgPos(vis) {
  const cols = vis.cols <= 1 ? 1 : vis.cols
  const rows = vis.rows <= 1 ? 1 : vis.rows
  const posX = cols <= 1 ? 0 : (vis.col / (cols - 1)) * 100
  const posY = rows <= 1 ? 0 : (vis.row / (rows - 1)) * 100
  return { posX, posY, cols, rows }
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
