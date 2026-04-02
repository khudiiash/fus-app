<script setup>
import { computed } from 'vue'
import { useGameification } from '@/composables/useGameification'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const { level, xpProgress } = useGameification(computed(() => auth.profile))
</script>

<template>
  <div class="flex flex-col gap-1">
    <div class="flex items-center justify-between text-xs font-semibold">
      <span class="text-slate-400">Рівень {{ level }}</span>
      <span class="text-xp font-bold tabular-nums">{{ xpProgress.current }}&thinsp;/&thinsp;{{ xpProgress.needed }} ДО</span>
    </div>
    <div class="h-1.5 bg-white/[0.07] rounded-full overflow-hidden">
      <div
        class="h-full bg-gradient-to-r from-violet-500 to-emerald-400 rounded-full transition-all duration-700 ease-out"
        :style="{ width: xpProgress.percent + '%' }"
      />
    </div>
  </div>
</template>
