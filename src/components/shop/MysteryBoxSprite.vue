<script setup>
import { computed } from 'vue'
import spriteUrl from '@/assets/mystery_boxes.png'

const props = defineProps({
  /** common | rare | epic | legendary */
  rarity: { type: String, default: 'common' },
  /** Outer box size (px) */
  size: { type: Number, default: 72 },
})

const RARITY_KEYS = ['common', 'rare', 'epic', 'legendary']

/** Firestore / forms sometimes use different casing; unknown → common (grey crate) */
const normalizedRarity = computed(() => {
  const r = String(props.rarity ?? 'common')
    .toLowerCase()
    .trim()
  return RARITY_KEYS.includes(r) ? r : 'common'
})

/** Spritesheet 2×2: TL common, TR rare, BL epic, BR legendary */
const pos = computed(() => {
  const p = {
    common:    { x: '0%',   y: '0%' },
    rare:      { x: '100%', y: '0%' },
    epic:      { x: '0%',   y: '100%' },
    legendary: { x: '100%', y: '100%' },
  }[normalizedRarity.value] || { x: '0%', y: '0%' }
  return p
})

const boxStyle = computed(() => ({
  width: `${props.size}px`,
  height: `${props.size}px`,
  backgroundImage: `url(${spriteUrl})`,
  backgroundSize: '200% 200%',
  backgroundPosition: `${pos.value.x} ${pos.value.y}`,
  backgroundRepeat: 'no-repeat',
}))
</script>

<template>
  <div
    class="mystery-box-sprite shrink-0 rounded-lg overflow-hidden"
    :style="boxStyle"
    role="img"
    :aria-label="`Магічна коробка (${normalizedRarity})`"
  />
</template>

<style scoped>
.mystery-box-sprite {
  /* soften black matte from sprite on dark UI */
  filter: drop-shadow(0 4px 12px rgba(0, 0, 0, 0.45));
}
</style>
