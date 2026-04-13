<script setup lang="ts">
/**
 * 2D preview for `category: block_world` shop rows — tool sprite from tools.png or block icon.
 */
import { computed } from 'vue'
import { parseBlockWorldItem } from '@/game/blockWorldItems'
import {
  TOOL_SPRITE_COLS,
  TOOL_SPRITE_ROWS,
  TOOLS_SPRITE_SHEET_URL,
  toolSpriteCellFromMeshName,
} from '@/game/blockWorldToolsRegistry'
import { BlockType } from '@/game/minebase/terrain'
import { blockWorldBlockIconUrl } from '@/game/blockWorldBlockIconUrls'

const props = withDefaults(
  defineProps<{
    item: Record<string, unknown> | null | undefined
    /** Square edge length in CSS px */
    size?: number
  }>(),
  { size: 88 },
)

const meta = computed(() => parseBlockWorldItem(props.item ?? null))

const toolStyle = computed(() => {
  const m = meta.value
  if (!m || m.kind !== 'tool') return null
  const mesh = m.toolMeshName ?? 'Iron_Pickaxe'
  const cell =
    toolSpriteCellFromMeshName(mesh) ??
    toolSpriteCellFromMeshName('Iron_Pickaxe') ?? { row: 3, col: 2 }
  const cols = TOOL_SPRITE_COLS
  const rows = TOOL_SPRITE_ROWS
  const posX = cols <= 1 ? 0 : (cell.col / (cols - 1)) * 100
  const posY = rows <= 1 ? 0 : (cell.row / (rows - 1)) * 100
  const s = Math.max(16, props.size)
  return {
    width: `${s}px`,
    height: `${s}px`,
    backgroundImage: `url(${TOOLS_SPRITE_SHEET_URL})`,
    backgroundSize: `${cols * 100}% ${rows * 100}%`,
    backgroundPosition: `${posX}% ${posY}%`,
    backgroundRepeat: 'no-repeat',
    imageRendering: 'pixelated' as const,
  }
})

const blockIconSrc = computed(() => {
  const m = meta.value
  if (!m || m.kind !== 'block') return null
  return blockWorldBlockIconUrl(m.blockType as BlockType)
})
</script>

<template>
  <div
    class="flex items-center justify-center"
    :style="{ width: size + 'px', height: size + 'px' }"
  >
    <div
      v-if="meta?.kind === 'tool' && toolStyle"
      class="rounded-xl ring-1 ring-white/20 shadow-inner shadow-black/40 bg-black/35"
      :style="toolStyle"
      role="img"
      :aria-label="item?.name?.toString?.() || 'Інструмент'"
    />
    <img
      v-else-if="meta?.kind === 'block' && blockIconSrc"
      :src="blockIconSrc"
      :width="Math.round(size * 0.92)"
      :height="Math.round(size * 0.92)"
      alt=""
      class="rounded-lg object-contain image-pixelated ring-1 ring-white/15 shadow-md shadow-black/30"
      draggable="false"
    />
    <div
      v-else
      class="rounded-xl bg-slate-800/80 text-slate-500 text-[10px] font-bold flex items-center justify-center ring-1 ring-white/10"
      :style="{ width: size + 'px', height: size + 'px' }"
    >
      ?
    </div>
  </div>
</template>

<style scoped>
.image-pixelated {
  image-rendering: pixelated;
}
</style>
