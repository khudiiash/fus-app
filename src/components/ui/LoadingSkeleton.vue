<script setup>
defineProps({
  rows: { type: Number, default: 3 },
  type: { type: String, default: 'list' }, // list | card | avatar
})
</script>

<template>
  <div v-if="type === 'card'" class="grid grid-cols-2 gap-3">
    <div v-for="i in rows" :key="i" class="glass-card p-4 h-32 animate-pulse">
      <div class="w-1/2 h-4 bg-slate-700 rounded mb-2" />
      <div class="w-3/4 h-3 bg-slate-700/60 rounded mb-2" />
      <div class="w-1/3 h-3 bg-slate-700/40 rounded" />
    </div>
  </div>
  <div v-else-if="type === 'avatar'" class="flex justify-center">
    <div class="w-32 h-32 bg-slate-700 rounded-full animate-pulse" />
  </div>
  <div v-else class="flex flex-col gap-3">
    <div v-for="i in rows" :key="i" class="glass-card p-4 flex items-center gap-3 animate-pulse">
      <div class="w-10 h-10 bg-slate-700 rounded-full flex-shrink-0" />
      <div class="flex-1">
        <div class="w-3/4 h-4 bg-slate-700 rounded mb-2" />
        <div class="w-1/2 h-3 bg-slate-700/60 rounded" />
      </div>
    </div>
  </div>
</template>
