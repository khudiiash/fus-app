<script setup>
import { computed } from 'vue'

const props = defineProps({
  avatar: { type: Object, default: () => ({}) },
  displayName: { type: String, default: '' },
  size: { type: String, default: 'md' }, // xs | sm | md | lg | xl
  showName: { type: Boolean, default: false },
  items: { type: Array, default: () => [] },
  /** Only the circular avatar (no outer column) — for tight rows e.g. feed cards */
  circleOnly: { type: Boolean, default: false },
})

const sizeMap = {
  xs: { outer: 'w-8 h-8',   text: 'text-sm',  ring: 'ring-1' },
  sm: { outer: 'w-12 h-12', text: 'text-lg',  ring: 'ring-2' },
  md: { outer: 'w-16 h-16', text: 'text-2xl', ring: 'ring-2' },
  lg: { outer: 'w-24 h-24', text: 'text-4xl', ring: 'ring-4' },
  xl: { outer: 'w-32 h-32', text: 'text-5xl', ring: 'ring-4' },
}

const initials = computed(() => {
  return props.displayName
    .split(' ')
    .map(w => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase() || '?'
})

const skin = computed(() => {
  const skins = {
    default:  'from-violet-600 to-purple-700',
    // meme / gen-alpha
    sigma:    'from-gray-900 to-slate-600',
    brainrot: 'from-fuchsia-500 to-pink-600',
    ohio:     'from-green-900 to-emerald-700',
    rizz:     'from-purple-500 to-amber-400',
    npc:      'from-gray-400 to-gray-600',
    brat:     'from-lime-400 to-green-500',
    chillguy: 'from-orange-400 to-amber-600',
    skibidi:  'from-blue-400 to-cyan-500',
    // classic
    fire:     'from-red-500 to-orange-500',
    ocean:    'from-blue-500 to-cyan-500',
    forest:   'from-green-500 to-emerald-600',
    gold:     'from-yellow-500 to-amber-500',
    galaxy:   'from-indigo-600 to-purple-900',
    sunset:   'from-pink-500 to-orange-400',
    ice:      'from-cyan-400 to-blue-500',
  }
  return skins[props.avatar?.skinId] || skins.default
})


const accessories = computed(() => {
  return (props.avatar?.accessories || [])
    .map(id => props.items.find(i => i.id === id))
    .filter(Boolean)
})

const s = computed(() => sizeMap[props.size] || sizeMap.md)
</script>

<template>
  <div v-if="!circleOnly" class="flex flex-col items-center gap-2">
    <div
      class="relative rounded-full bg-gradient-to-br flex items-center justify-center select-none overflow-hidden ring-2 ring-violet-700 ring-offset-2 ring-offset-game-bg"
      :class="s.outer"
    >
      <!-- Uploaded photo (takes priority over everything) -->
      <img
        v-if="avatar?.photoUrl"
        :src="avatar.photoUrl"
        class="absolute inset-0 w-full h-full object-cover"
        alt="avatar"
        draggable="false"
      />

      <!-- Fallback: skin gradient + initials -->
      <template v-else>
        <div :class="['absolute inset-0 bg-gradient-to-br', skin]" />
        <span class="relative z-10 font-extrabold text-white select-none" :class="s.text">
          {{ initials }}
        </span>
      </template>

      <!-- Accessory emoji badges (bottom-right) -->
      <div v-if="accessories.length > 0" class="absolute bottom-0 right-0 flex gap-0.5 p-0.5">
        <span
          v-for="acc in accessories.slice(0, 2)"
          :key="acc.id"
          class="text-xs bg-black/40 rounded-full p-0.5 leading-none"
        >{{ acc.emoji || '✦' }}</span>
      </div>
    </div>

    <div v-if="showName" class="text-xs font-bold text-center text-slate-300 max-w-[80px] truncate">
      {{ displayName }}
    </div>
  </div>

  <div
    v-else
    class="relative rounded-full bg-gradient-to-br flex items-center justify-center select-none overflow-hidden ring-2 ring-violet-700 ring-offset-2 ring-offset-game-bg"
    :class="s.outer"
  >
    <img
      v-if="avatar?.photoUrl"
      :src="avatar.photoUrl"
      class="absolute inset-0 w-full h-full object-cover"
      alt="avatar"
      draggable="false"
    />
    <template v-else>
      <div :class="['absolute inset-0 bg-gradient-to-br', skin]" />
      <span class="relative z-10 font-extrabold text-white select-none" :class="s.text">
        {{ initials }}
      </span>
    </template>
    <div v-if="accessories.length > 0" class="absolute bottom-0 right-0 flex gap-0.5 p-0.5">
      <span
        v-for="acc in accessories.slice(0, 2)"
        :key="acc.id"
        class="text-xs bg-black/40 rounded-full p-0.5 leading-none"
      >{{ acc.emoji || '✦' }}</span>
    </div>
  </div>
</template>
