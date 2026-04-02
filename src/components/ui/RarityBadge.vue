<script setup>
defineProps({ rarity: { type: String, default: 'common' } })

const labels = { common: 'Звичайний', rare: 'Рідкісний', epic: 'Епічний', legendary: 'Легендарний' }

// Borderless: background pill with subtle inner shadow instead of a border
const styles = {
  common:    'bg-slate-500/15 text-slate-400',
  rare:      'bg-blue-500/15 text-blue-300',
  epic:      'bg-purple-500/15 text-purple-300',
  legendary: 'bg-amber-500/15 text-amber-300',
}
</script>

<template>
  <span class="inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full text-[10px] font-extrabold tracking-wide" :class="styles[rarity]">
    <span v-if="rarity === 'legendary'">✦</span>
    <span v-else-if="rarity === 'epic'">◆</span>
    <span v-else-if="rarity === 'rare'">●</span>
    {{ labels[rarity] }}
  </span>
</template>
