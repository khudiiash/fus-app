<script setup>
/**
 * Catalog-aware preview for transaction rows (skin / GLB items).
 * Avoids raw <img> on skin PNGs that aren't URLs and shows GlbThumbnail for 3D items.
 */
import Skin3dThumbnail from '@/components/character/Skin3dThumbnail.vue'
import GlbThumbnail from '@/components/character/GlbThumbnail.vue'
import MysteryBoxSprite from '@/components/shop/MysteryBoxSprite.vue'
import { Package } from 'lucide-vue-next'

defineProps({
  item: { type: Object, default: null },
  /** Compact row size */
  w: { type: Number, default: 28 },
  h: { type: Number, default: 40 },
})
</script>

<template>
  <div
    class="flex-shrink-0 overflow-hidden rounded-md"
    :style="{ width: w + 'px', height: h + 'px' }"
  >
    <Skin3dThumbnail
      v-if="item?.category === 'skin'"
      :skin-url="item.skinUrl"
      :skin-id="item.skinId || 'default'"
      :width="w"
      :height="h"
      class="!rounded-md"
    />
    <GlbThumbnail
      v-else-if="item?.category === 'room' && item.modelData"
      :model-data="item.modelData"
      :width="w"
      :height="h"
      is-room
      class="!rounded-md"
    />
    <GlbThumbnail
      v-else-if="item?.category === 'accessory' && item.modelData"
      :model-data="item.modelData"
      :width="w"
      :height="h"
      class="!rounded-md"
    />
    <GlbThumbnail
      v-else-if="item?.category === 'pet' && item.modelData"
      :model-data="item.modelData"
      :width="w"
      :height="h"
      class="!rounded-md"
    />
    <div
      v-else-if="item?.category === 'mystery_box'"
      class="w-full h-full flex items-center justify-center"
    >
      <MysteryBoxSprite :rarity="item.rarity || 'common'" :size="Math.max(14, Math.min(w, h) - 2)" />
    </div>
    <div v-else class="w-full h-full flex items-center justify-center text-slate-500">
      <Package :size="Math.min(14, Math.round(w * 0.45))" :stroke-width="1.5" />
    </div>
  </div>
</template>
