<script setup>
/**
 * Shared skin / GLB preview for lists (trade, etc.) — same pipeline as Shop & AvatarBuilder.
 */
import Skin3dThumbnail from '@/components/character/Skin3dThumbnail.vue'
import GlbThumbnail from '@/components/character/GlbThumbnail.vue'
import MysteryBoxSprite from '@/components/shop/MysteryBoxSprite.vue'
import { Package, Home, PawPrint } from 'lucide-vue-next'

defineProps({
  item:   { type: Object, default: null },
  width:  { type: Number, default: 32 },
  height: { type: Number, default: 44 },
})
</script>

<template>
  <div
    class="rounded-lg overflow-hidden flex-shrink-0 flex items-center justify-center"
    :style="{ width: width + 'px', height: height + 'px' }"
  >
    <template v-if="item">
      <Skin3dThumbnail
        v-if="item.category === 'skin'"
        :skin-url="item.skinUrl"
        :skin-id="item.skinId || 'default'"
        :width="width"
        :height="height"
      />
      <GlbThumbnail
        v-else-if="item.category === 'room' && item.modelData"
        :model-data="item.modelData"
        :width="width"
        :height="height"
        is-room
      />
      <GlbThumbnail
        v-else-if="item.category === 'accessory' && item.modelData"
        :model-data="item.modelData"
        :width="width"
        :height="height"
      />
      <GlbThumbnail
        v-else-if="item.category === 'pet' && item.modelData"
        :model-data="item.modelData"
        :width="width"
        :height="height"
      />
      <MysteryBoxSprite
        v-else-if="item.category === 'mystery_box'"
        :rarity="item.rarity || 'common'"
        :size="Math.round(Math.min(width, height) * 0.92)"
      />
      <div v-else class="flex items-center justify-center w-full h-full text-slate-600">
        <Home v-if="item.category === 'room'" :size="Math.min(18, width * 0.45)" :stroke-width="1.5" />
        <PawPrint v-else-if="item.category === 'pet'" :size="Math.min(18, width * 0.45)" :stroke-width="1.5" />
        <Package v-else :size="Math.min(18, width * 0.45)" :stroke-width="1.5" />
      </div>
    </template>
    <Package v-else :size="14" :stroke-width="1.5" class="text-slate-600" />
  </div>
</template>
