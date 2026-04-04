<script setup>
import { useToast, onToastAfterLeave } from '@/composables/useToast'
import { CheckCircle2, XCircle, Coins, AlertTriangle, Info } from 'lucide-vue-next'

const { currentToast, dismiss } = useToast()

const config = {
  success: { bg: 'bg-emerald-500',  text: 'text-white',      Icon: CheckCircle2  },
  error:   { bg: 'bg-red-500',      text: 'text-white',      Icon: XCircle       },
  warning: { bg: 'bg-orange-500',   text: 'text-white',      Icon: AlertTriangle },
  coin:    { bg: 'bg-amber-500',    text: 'text-slate-900',  Icon: Coins         },
  info:    { bg: '',                text: 'text-white',      Icon: Info, style: 'background:var(--accent)' },
}
</script>

<template>
  <Teleport to="body">
    <div
      class="fixed left-1/2 -translate-x-1/2 z-[9999] w-[90vw] max-w-sm pointer-events-none"
      style="top: calc(env(safe-area-inset-top, 0px) + 1rem)"
    >
      <Transition name="toast" mode="out-in" @after-leave="onToastAfterLeave">
        <div
          v-if="currentToast"
          :key="currentToast.id"
          class="flex items-center gap-3 px-4 py-3 rounded-xl font-bold text-sm shadow-2xl pointer-events-auto cursor-default select-none"
          :class="[config[currentToast.type]?.bg || 'bg-slate-700', config[currentToast.type]?.text || 'text-white']"
          :style="config[currentToast.type]?.style"
          role="status"
          aria-live="polite"
          @click="dismiss(currentToast.id)"
        >
          <component
            :is="config[currentToast.type]?.Icon || Info"
            :size="16"
            :stroke-width="2.2"
            class="flex-shrink-0"
          />
          <span>{{ currentToast.message }}</span>
        </div>
      </Transition>
    </div>
  </Teleport>
</template>

<style scoped>
.toast-enter-active {
  transition: opacity 0.26s cubic-bezier(0.22, 1, 0.36, 1), transform 0.26s cubic-bezier(0.22, 1, 0.36, 1);
}
.toast-leave-active {
  transition: opacity 0.32s ease-out, transform 0.28s ease-out;
}
.toast-enter-from {
  opacity: 0;
  transform: translateY(-12px);
}
.toast-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}
</style>
