<script setup>
import { defineAsyncComponent, onMounted } from 'vue'
import { initAccent } from '@/composables/useAccentColor'
import ToastContainer from '@/components/ui/ToastContainer.vue'

/** Defer chunk that pulls auth store watcher until after first paint */
const LevelUpModal = defineAsyncComponent(() =>
  import('@/components/gamification/LevelUpModal.vue'),
)

onMounted(() => {
  initAccent()
})
</script>

<template>
  <div id="app-root" class="min-h-screen bg-game-bg text-slate-100 font-sans">
    <RouterView />
    <LevelUpModal />
    <ToastContainer />
  </div>
</template>
