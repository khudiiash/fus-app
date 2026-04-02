<script setup>
import { computed } from 'vue'
import { LogIn, ArrowLeftRight, ShoppingBag, Coins, Send, Star, CheckCircle2 } from 'lucide-vue-next'
import CoinDisplay from '@/components/gamification/CoinDisplay.vue'

const props = defineProps({
  quest: { type: Object, required: true },
})

const iconMap = {
  login:      LogIn,
  trade:      ArrowLeftRight,
  spend:      ShoppingBag,
  receive:    Coins,
  send_trade: Send,
}

const questIcon = computed(() => iconMap[props.quest.type] || Star)
const progress  = computed(() => Math.min(100, Math.round((props.quest.progress / props.quest.target) * 100)))
</script>

<template>
  <div
    class="glass-card p-4 flex items-center gap-3.5 transition-all duration-300"
    :class="quest.completed ? 'glow-xp' : ''"
  >
    <!-- Icon cell -->
    <div
      class="w-11 h-11 rounded-2xl flex items-center justify-center flex-shrink-0 transition-colors"
      :class="quest.completed ? 'bg-emerald-500/[0.14]' : 'bg-violet-500/[0.12]'"
    >
      <component
        :is="questIcon"
        :size="20"
        :stroke-width="1.8"
        :class="quest.completed ? 'text-emerald-400' : 'text-violet-400'"
      />
    </div>

    <div class="flex-1 min-w-0">
      <div class="flex items-center justify-between gap-2 mb-1.5">
        <div class="font-bold text-sm truncate">{{ quest.label }}</div>
        <div v-if="quest.completed" class="flex items-center gap-1 flex-shrink-0 text-emerald-400 text-xs font-extrabold">
          <CheckCircle2 :size="13" :stroke-width="2.5" />
          <span>Виконано</span>
        </div>
      </div>
      <!-- Progress bar -->
      <div class="h-1 bg-white/[0.06] rounded-full overflow-hidden mb-1.5">
        <div
          class="h-full rounded-full transition-all duration-500"
          :class="quest.completed ? 'bg-emerald-400' : 'bg-violet-500'"
          :style="{ width: progress + '%' }"
        />
      </div>
      <div class="flex items-center justify-between text-xs text-slate-500">
        <span class="tabular-nums">{{ quest.progress }}&thinsp;/&thinsp;{{ quest.target }}</span>
        <CoinDisplay :amount="quest.rewardCoins" :show-sign="true" size="sm" />
      </div>
    </div>
  </div>
</template>
