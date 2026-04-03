<script setup>
import { useToast } from '@/composables/useToast'
import { CheckCircle2, XCircle, Coins, AlertTriangle, Info } from 'lucide-vue-next'

const { toasts, dismiss } = useToast()

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
      class="fixed left-1/2 -translate-x-1/2 z-[9999] flex flex-col gap-2 w-[90vw] max-w-sm pointer-events-none"
      style="top: calc(env(safe-area-inset-top, 0px) + 1rem)"
    >
      <TransitionGroup name="toast">
        <div
          v-for="toast in toasts"
          :key="toast.id"
          class="flex items-center gap-3 px-4 py-3 rounded-xl font-bold text-sm shadow-2xl pointer-events-auto cursor-pointer"
          :class="[config[toast.type]?.bg || 'bg-slate-700', config[toast.type]?.text || 'text-white']"
          :style="config[toast.type]?.style"
          @click="dismiss(toast.id)"
        >
          <component
            :is="config[toast.type]?.Icon || Info"
            :size="16"
            :stroke-width="2.2"
            class="flex-shrink-0"
          />
          <span>{{ toast.message }}</span>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<style scoped>
.toast-enter-active { transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1); }
.toast-leave-active { transition: all 0.2s ease; }
.toast-enter-from  { opacity: 0; transform: translateY(-16px) scale(0.93); }
.toast-leave-to    { opacity: 0; transform: translateY(-8px) scale(0.96); }
</style>
