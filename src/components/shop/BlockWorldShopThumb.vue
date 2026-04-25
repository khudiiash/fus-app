<script setup lang="ts">
/**
 * 2D preview for `category: block_world` shop rows — tool sprite from tools.png or block emoji.
 */
import { computed } from 'vue'
import {
  TOOL_SPRITE_COLS,
  TOOL_SPRITE_ROWS,
  TOOLS_SPRITE_SHEET_URL,
  hotbarCellVisualForBwSlot,
  parseBlockWorldItem,
  toolSpriteCellFromMeshName,
} from '@/lib/blockWorldShopVisuals'

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

const blockTerrainStyle = computed(() => {
  const m = meta.value
  if (!m || m.kind !== 'block') return null
  const v = hotbarCellVisualForBwSlot({ kind: 'item', itemId: '', meta: m, count: 1 })
  if (!v || v.type !== 'blockIcon' || !v.sheetSrc) return null
  const cols = v.cols <= 0 ? 32 : v.cols
  const rows = v.rows <= 0 ? 16 : v.rows
  const t = (v.textureSlot | 0) >>> 0
  const col = t % cols
  const row = Math.floor(t / cols)
  const posX = (col / (cols - 1)) * 100
  const posY = (row / (rows - 1)) * 100
  const s = Math.max(16, props.size)
  return {
    width: `${s}px`,
    height: `${s}px`,
    backgroundImage: `url(${String(v.sheetSrc)})`,
    backgroundSize: `${cols * 100}% ${rows * 100}%`,
    backgroundPosition: `${posX}% ${posY}%`,
    backgroundRepeat: 'no-repeat',
    imageRendering: 'pixelated' as const,
  }
})

const blockEmoji = computed(() => {
  const m = meta.value
  if (!m || m.kind !== 'block') return null
  const v = hotbarCellVisualForBwSlot({ kind: 'item', itemId: '', meta: m, count: 1 })
  return v?.type === 'emoji' ? v.text : null
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
    <div
      v-else-if="meta?.kind === 'block' && blockTerrainStyle"
      class="rounded-xl ring-1 ring-white/15 shadow-md shadow-black/30 bg-black/35"
      :style="blockTerrainStyle"
      role="img"
      aria-hidden="true"
    />
    <div
      v-else-if="meta?.kind === 'block' && blockEmoji"
      class="rounded-xl bg-slate-800/80 flex items-center justify-center ring-1 ring-white/15 shadow-md shadow-black/30 select-none leading-none"
      :style="{ fontSize: Math.round(size * 0.55) + 'px', width: size + 'px', height: size + 'px' }"
      aria-hidden="true"
    >
      {{ blockEmoji }}
    </div>
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
