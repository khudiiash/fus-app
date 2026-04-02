<script setup>
import { Coins } from 'lucide-vue-next'

defineProps({
  amount:   { type: Number, default: 0 },
  size:     { type: String, default: 'md' }, // sm | md | lg
  animated: { type: Boolean, default: false },
  showSign: { type: Boolean, default: false },
})

const sizeMap = { sm: 'text-xs gap-1', md: 'text-sm gap-1.5', lg: 'text-xl gap-2' }
const iconMap = { sm: 14, md: 16, lg: 22 }
</script>

<template>
  <div class="inline-flex items-center font-extrabold" :class="[sizeMap[size], animated ? 'animate-pulse-glow' : '']">
    <Coins :size="iconMap[size]" :stroke-width="2" class="text-coin flex-shrink-0" />
    <span class="text-coin tabular-nums">
      {{ showSign && amount > 0 ? '+' : '' }}{{ amount.toLocaleString() }}
    </span>
  </div>
</template>
