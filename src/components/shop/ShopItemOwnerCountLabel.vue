<script setup>
import { computed } from 'vue'
import { Users } from 'lucide-vue-next'

const props = defineProps({
  /** Fetched from {@code items/{id}.ownersCount} — unique users with ≥1 copy. */
  count: { type: [Number, String], default: undefined },
  /** Tighter icon + text for dense admin rows */
  compact: { type: Boolean, default: false },
})

const n = computed(() => {
  const v = Number(props.count)
  if (!Number.isFinite(v) || v < 0) return 0
  return Math.floor(v)
})
</script>

<template>
  <span
    class="inline-flex items-center gap-0.5 tabular-nums select-none"
    :class="compact ? 'text-[9px] font-bold text-slate-500' : 'text-[10px] font-bold text-slate-500'"
    title="Скільки користувачів мають цей предмет (у профілі чи коробки в запасі)"
  >
    <Users :size="compact ? 9 : 10" :stroke-width="2" class="opacity-75 shrink-0" aria-hidden="true" />
    <span>{{ n }}</span>
  </span>
</template>
