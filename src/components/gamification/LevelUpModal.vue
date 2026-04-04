<script setup>
import { ref, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useHaptic } from '@/composables/useHaptic'

const auth = useAuthStore()
const { levelUp } = useHaptic()

const show = ref(false)
const newLevel = ref(1)
const particles = ref([])

function triggerLevelUp(level) {
  newLevel.value = level
  show.value = true
  levelUp()
  spawnParticles()
  setTimeout(() => { show.value = false }, 4000)
}

function spawnParticles() {
  particles.value = Array.from({ length: 20 }, (_, i) => ({
    id: i,
    x: Math.random() * 100,
    delay: Math.random() * 0.5,
    size: 8 + Math.random() * 12,
    color: ['#f59e0b', '#a855f7', '#3b82f6', '#22c55e', '#f97316'][Math.floor(Math.random() * 5)],
  }))
}

// Watch for level changes in profile
let prevLevel = 0
watch(() => auth.profile?.level, (level) => {
  if (level && prevLevel > 0 && level > prevLevel) {
    triggerLevelUp(level)
  }
  if (level) prevLevel = level
}, { immediate: true })
</script>

<template>
  <Teleport to="body">
    <!-- Dimming: opacity only — no scale (scaling the full-screen layer looked wrong) -->
    <Transition name="levelup-fade">
      <div
        v-if="show"
        class="fixed inset-0 z-[9998] bg-black/80 backdrop-blur-sm"
        aria-hidden="true"
        @click="show = false"
      />
    </Transition>
    <!-- Particles: fixed to viewport, outside scaled panel -->
    <template v-if="show">
      <div
        v-for="p in particles"
        :key="p.id"
        class="fixed bottom-0 z-[9999] animate-bounce-in pointer-events-none"
        :style="{
          left: p.x + '%',
          transform: 'translateX(-50%)',
          width: p.size + 'px',
          height: p.size + 'px',
          backgroundColor: p.color,
          borderRadius: '50%',
          animation: `coin-pop 1.5s ease-out ${p.delay}s both`,
        }"
      />
    </template>
    <Transition name="levelup-pop">
      <div
        v-if="show"
        key="levelup-panel"
        class="levelup-panel fixed left-1/2 top-1/2 z-[10000] flex w-full max-w-lg flex-col items-center gap-6 px-8 text-center pointer-events-auto"
        @click.stop
      >
        <div class="relative flex flex-col items-center gap-6 animate-bounce-in">
          <div class="text-8xl animate-float">⭐</div>
          <div>
            <div class="text-violet-300 font-bold text-xl mb-2">НОВИЙ РІВЕНЬ!</div>
            <div class="text-6xl font-extrabold text-white leading-none">{{ newLevel }}</div>
            <div class="legendary-gradient font-extrabold text-2xl mt-2">Ти перейшов на новий рівень!</div>
          </div>
          <div class="text-slate-300 text-sm">Продовжуй заробляти та торгувати, щоб досягти рівня {{ Math.min(50, newLevel + 1) }}!</div>
          <button
            type="button"
            class="bg-gradient-to-br from-violet-500 to-violet-700 hover:from-violet-400 hover:to-violet-600 text-white font-bold px-8 py-3 rounded-2xl active:scale-95 transition-all shadow-lg shadow-violet-950/60"
            @click="show = false"
          >
            Супер! 🎉
          </button>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.levelup-fade-enter-active,
.levelup-fade-leave-active {
  transition: opacity 0.35s ease;
}
.levelup-fade-enter-from,
.levelup-fade-leave-to {
  opacity: 0;
}

/* Centering + scale only on the card — backdrop stays full-bleed */
.levelup-panel {
  transform: translate(-50%, -50%);
}
.levelup-pop-enter-active.levelup-panel,
.levelup-pop-leave-active.levelup-panel {
  transition:
    opacity 0.4s ease,
    transform 0.4s cubic-bezier(0.34, 1.3, 0.64, 1);
}
.levelup-pop-leave-active.levelup-panel {
  transition-duration: 0.28s;
}
.levelup-pop-enter-from.levelup-panel,
.levelup-pop-leave-to.levelup-panel {
  opacity: 0;
  transform: translate(-50%, -50%) scale(0.88);
}
</style>
