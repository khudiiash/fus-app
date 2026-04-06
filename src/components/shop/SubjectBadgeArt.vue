<script setup>
import { computed } from 'vue'
import {
  subjectBadgeBackgroundStyle,
  isValidBadgeSpriteIndex,
} from '@/utils/subjectBadgeSprite'

const props = defineProps({
  /** Index in subjects.png (0–24). When set and valid, sprite is shown. */
  spriteIndex: { type: Number, default: undefined },
  emoji: { type: String, default: '🏅' },
  size: { type: Number, default: 72 },
})

const useSprite = computed(() => isValidBadgeSpriteIndex(props.spriteIndex))

const spriteLayerStyle = computed(() => {
  if (!useSprite.value) return null
  return subjectBadgeBackgroundStyle(props.spriteIndex, props.size)
})

const boxStyle = computed(() => ({
  width: props.size + 'px',
  height: props.size + 'px',
}))
</script>

<template>
  <div
    class="subject-badge-art relative flex items-center justify-center shrink-0 rounded-full overflow-hidden"
    :style="boxStyle"
    aria-hidden="true"
  >
    <div
      v-if="useSprite && spriteLayerStyle"
      class="rounded-full shrink-0"
      :style="spriteLayerStyle"
    />
    <!-- Fallback: лише емодзі, без золотої «тарілки» -->
    <span
      v-else
      class="select-none leading-none drop-shadow-[0_2px_8px_rgba(0,0,0,0.55)]"
      :style="{ fontSize: Math.round(size * 0.46) + 'px' }"
    >{{ emoji }}</span>
  </div>
</template>
