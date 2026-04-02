<script setup>
import { computed } from 'vue'
import { Flame } from 'lucide-vue-next'

const props = defineProps({ streak: { type: Number, default: 0 } })

const milestones = [3, 7, 14, 30]
const nextMilestone = computed(() => milestones.find(m => m > props.streak) || 30)
const progress = computed(() => Math.min(100, Math.round((props.streak / nextMilestone.value) * 100)))

const flameSize = computed(() => {
  if (props.streak >= 30) return 'text-4xl'
  if (props.streak >= 14) return 'text-3xl'
  if (props.streak >= 7)  return 'text-2xl'
  if (props.streak >= 3)  return 'text-xl'
  return 'text-lg'
})

const multiplier = computed(() => {
  if (props.streak >= 30) return '×2.0'
  if (props.streak >= 14) return '×1.5'
  if (props.streak >= 7)  return '×1.25'
  if (props.streak >= 3)  return '×1.1'
  return '×1.0'
})
</script>

<template>
  <div class="glass-card p-4">
    <div class="flex items-center justify-between mb-3">
      <div class="flex items-center gap-2.5">
        <div class="w-10 h-10 rounded-2xl bg-orange-500/[0.12] flex items-center justify-center flex-shrink-0">
          <Flame :size="20" :stroke-width="1.8" class="text-orange-400 animate-float" />
        </div>
        <div>
          <div class="font-extrabold text-base leading-none">{{ streak }} днів поспіль</div>
          <div class="text-xs text-amber-400 font-semibold mt-0.5">{{ multiplier }} бонус монет</div>
        </div>
      </div>
      <div class="text-right">
        <div class="text-xs text-slate-400">Наступна ціль</div>
          <div class="font-bold text-amber-400">{{ nextMilestone }} днів</div>
      </div>
    </div>
    <div class="h-1.5 bg-white/[0.06] rounded-full overflow-hidden">
      <div
        class="h-full bg-gradient-to-r from-orange-500 to-amber-400 rounded-full transition-all duration-700"
        :style="{ width: progress + '%' }"
      />
    </div>
    <div class="flex justify-between mt-1 text-xs text-slate-500">
      <span>{{ streak }}</span>
      <span>{{ nextMilestone }}</span>
    </div>
  </div>
</template>
