<script setup>
import { ref, watch, onMounted, onUnmounted } from 'vue'
import { pushModalScrollLock, popModalScrollLock } from '@/utils/modalScrollLock.js'

const props = defineProps({
  modelValue: Boolean,
  title:  String,
  size:   { type: String, default: 'md' }, // sm | md | lg
})
const emit = defineEmits(['update:modelValue'])
const close = () => emit('update:modelValue', false)

const sizes = { sm: 'max-w-sm', md: 'max-w-md', lg: 'max-w-lg' }

const scrollLockHeld = ref(false)

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      pushModalScrollLock()
      scrollLockHeld.value = true
    } else if (scrollLockHeld.value) {
      popModalScrollLock()
      scrollLockHeld.value = false
    }
  },
  { immediate: true },
)

/** Не-passive через модифікатор .prevent у шаблоні — зупиняє pull-to-refresh під пальцем */
function swallowTouchMove(e) {
  e.preventDefault()
}

function onKey(e) { if (e.key === 'Escape') close() }
onMounted(() => document.addEventListener('keydown', onKey))
onUnmounted(() => {
  document.removeEventListener('keydown', onKey)
  if (scrollLockHeld.value) {
    popModalScrollLock()
    scrollLockHeld.value = false
  }
})
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div
        v-if="modelValue"
        class="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4 overscroll-none touch-none sm:touch-auto"
        @click.self="close"
      >
        <!-- Backdrop: touchmove — щоб жест не йшов у Chrome pull-to-refresh -->
        <div
          class="absolute inset-0 bg-black/60 backdrop-blur-md"
          @click="close"
          @touchmove.prevent="swallowTouchMove"
        />

        <!-- Sheet -->
        <div
          class="modal-sheet relative w-full sm:rounded-2xl flex flex-col max-h-[90dvh] sm:max-h-[min(88vh,720px)] min-h-0 touch-auto overscroll-y-contain"
          :class="sizes[size]"
        >
          <!-- Header -->
          <div
            v-if="title"
            class="flex items-center gap-3 px-4 sm:px-5 py-3 sm:py-3.5 shrink-0"
            @touchmove.prevent="swallowTouchMove"
          >
            <h3 class="font-extrabold text-lg tracking-tight min-w-0 flex-1 leading-snug">{{ title }}</h3>
            <button
              type="button"
              class="shrink-0 flex items-center justify-center gap-1.5 min-h-11 px-3.5 rounded-xl font-extrabold text-sm
                bg-white/[0.14] hover:bg-white/[0.22] active:bg-white/[0.18] border border-white/[0.14]
                text-white shadow-sm transition-colors"
              aria-label="Закрити"
              @click="close"
            >
              <span class="text-lg leading-none font-light" aria-hidden="true">×</span>
              <span>Закрити</span>
            </button>
          </div>

          <!-- Divider -->
          <div v-if="title" class="h-px bg-white/[0.06] mx-5 shrink-0" />

          <!-- Body -->
          <div class="flex-1 min-h-0 overflow-y-auto overscroll-y-contain touch-pan-y p-4 sm:p-5">
            <slot />
          </div>

          <!-- Footer (sticky below scroll — primary actions belong here) -->
          <div
            v-if="$slots.footer"
            class="px-4 sm:px-5 pb-4 sm:pb-5 pt-3 border-t border-white/[0.06] shrink-0 bg-[rgba(14,14,30,0.98)]"
            @touchmove.prevent="swallowTouchMove"
          >
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
