<script setup>
import { computed } from 'vue'
import { useHaptic } from '@/composables/useHaptic'

const props = defineProps({
  variant:  { type: String,  default: 'primary' }, // primary | secondary | ghost | danger | coin | xp
  size:     { type: String,  default: 'md' },       // sm | md | lg
  loading:  { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  block:    { type: Boolean, default: false },
  /** `span` — для вкладення в `<label>` (файловий input); `<button>` у `<label>` некоректний HTML */
  as:       { type: String,  default: 'button' }, // button | span
})

const emit = defineEmits(['click'])
const { tap } = useHaptic()

function handleClick(e) {
  if (props.loading || props.disabled) return
  tap()
  emit('click', e)
}

const base = 'inline-flex items-center justify-center gap-2 font-bold rounded-2xl transition-all duration-200 active:scale-[0.97] select-none tracking-tight'

const variants = {
  primary:   'btn-primary',
  secondary: 'bg-white/[0.08] hover:bg-white/[0.13] text-slate-200',
  ghost:     'bg-transparent hover:bg-white/[0.06] text-slate-400 hover:text-slate-200',
  danger:    'bg-red-600 hover:brightness-110 text-white shadow-lg shadow-red-950/50',
  coin:      'bg-amber-500 hover:brightness-110 text-black shadow-lg shadow-amber-950/40 font-extrabold',
  xp:        'bg-emerald-600 hover:brightness-110 text-white shadow-lg shadow-emerald-950/50',
}

const sizes = {
  sm: 'text-xs px-3 py-1.5',
  md: 'text-sm px-4 py-2.5',
  lg: 'text-base px-6 py-3',
}

const isButton = computed(() => props.as === 'button')
</script>

<template>
  <component
    :is="as"
    :type="isButton ? 'button' : undefined"
    :disabled="isButton && (disabled || loading)"
    :aria-disabled="!isButton && (disabled || loading) ? 'true' : undefined"
    :class="[
      base,
      variants[variant],
      sizes[size],
      block ? 'w-full' : '',
      disabled || loading ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer',
    ]"
    @click="handleClick"
  >
    <span v-if="loading" class="animate-spin w-4 h-4 border-2 border-current border-t-transparent rounded-full" />
    <slot />
  </component>
</template>
