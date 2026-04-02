<script setup>
import { onMounted, onUnmounted } from 'vue'

const props = defineProps({
  modelValue: Boolean,
  title:  String,
  size:   { type: String, default: 'md' }, // sm | md | lg
})
const emit = defineEmits(['update:modelValue'])
const close = () => emit('update:modelValue', false)

const sizes = { sm: 'max-w-sm', md: 'max-w-md', lg: 'max-w-lg' }

function onKey(e) { if (e.key === 'Escape') close() }
onMounted(() => document.addEventListener('keydown', onKey))
onUnmounted(() => document.removeEventListener('keydown', onKey))
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="modelValue" class="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4" @click.self="close">
        <!-- Backdrop -->
        <div class="absolute inset-0 bg-black/60 backdrop-blur-md" @click="close" />

        <!-- Sheet -->
        <div
          class="modal-sheet relative w-full sm:rounded-2xl"
          :class="sizes[size]"
        >
          <!-- Drag handle (mobile only) -->
          <div class="sm:hidden flex justify-center pt-3 pb-1">
            <div class="w-10 h-1 bg-white/20 rounded-full" />
          </div>

          <!-- Header -->
          <div v-if="title" class="flex items-center justify-between px-5 py-3">
            <h3 class="font-extrabold text-lg tracking-tight">{{ title }}</h3>
            <button
              class="w-8 h-8 rounded-xl flex items-center justify-center text-slate-400 hover:text-white hover:bg-white/10 transition-colors text-lg leading-none"
              @click="close"
            >×</button>
          </div>

          <!-- Divider -->
          <div v-if="title" class="h-px bg-white/[0.06] mx-5" />

          <!-- Body -->
          <div class="p-5 max-h-[82dvh] overflow-y-auto">
            <slot />
          </div>

          <!-- Footer -->
          <div v-if="$slots.footer" class="px-5 pb-5 pt-0">
            <slot name="footer" />
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* Sheet styling */
.modal-sheet {
  background: rgba(14, 14, 30, 0.96);
  backdrop-filter: blur(32px);
  -webkit-backdrop-filter: blur(32px);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.10),
    0 -8px 48px rgba(0, 0, 0, 0.6),
    0 32px 64px rgba(0, 0, 0, 0.4);
  border-radius: 1.5rem 1.5rem 0 0;
}

@media (min-width: 640px) {
  .modal-sheet {
    border-radius: 1.5rem;
    box-shadow:
      inset 0 0 0 1px rgba(255, 255, 255, 0.09),
      0 32px 80px rgba(0, 0, 0, 0.6);
  }
}

/* Transitions */
.modal-enter-active { transition: opacity 0.25s ease; }
.modal-leave-active { transition: opacity 0.2s ease; }
.modal-enter-from,
.modal-leave-to { opacity: 0; }

.modal-enter-active .modal-sheet { animation: sheet-up 0.32s cubic-bezier(0.34, 1.56, 0.64, 1) both; }
.modal-leave-active .modal-sheet { animation: sheet-up 0.2s ease reverse both; }

@keyframes sheet-up {
  from { opacity: 0; transform: translateY(32px) scale(0.97); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}
</style>
