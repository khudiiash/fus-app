<script setup>
/**
 * Experimental voxel playground (new engine path). Production world remains `/student/world`.
 */
import { ref, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { useBlockWorldSession } from '@/stores/blockWorldSession'
import { createBlockWorldNextGame } from '@/game/blockWorldNext'
import '@/game/minebase/style.css'

const router = useRouter()
const bwSession = useBlockWorldSession()

const mineRootRef = ref(null)
const mountRef = ref(null)
const playing = ref(false)
const pointerHint = ref(false)
let game = null

function syncPlayViewport() {
  const root = mineRootRef.value
  if (!root || !playing.value) {
    if (root) {
      root.style.minHeight = ''
      root.style.height = ''
    }
    return
  }
  root.style.minHeight = ''
  root.style.height = ''
  game?.syncRendererSize?.()
}

function onVisualViewportChange() {
  if (playing.value && game) syncPlayViewport()
}

let pinchLockCleanup = null
function clearPinchLock() {
  if (pinchLockCleanup) {
    pinchLockCleanup()
    pinchLockCleanup = null
  }
}
function installPinchLock() {
  clearPinchLock()
  const onMultiTouchMove = (e) => {
    if (e.touches.length > 1) e.preventDefault()
  }
  const onGesture = (e) => {
    e.preventDefault()
  }
  const onWheelCtrlZoom = (e) => {
    if (e.ctrlKey) e.preventDefault()
  }
  document.documentElement.classList.add('fus-block-world-play')
  document.addEventListener('touchmove', onMultiTouchMove, { passive: false })
  document.addEventListener('gesturestart', onGesture, { passive: false })
  document.addEventListener('gesturechange', onGesture, { passive: false })
  document.addEventListener('gestureend', onGesture, { passive: false })
  document.addEventListener('wheel', onWheelCtrlZoom, { passive: false })
  pinchLockCleanup = () => {
    document.documentElement.classList.remove('fus-block-world-play')
    document.removeEventListener('touchmove', onMultiTouchMove)
    document.removeEventListener('gesturestart', onGesture)
    document.removeEventListener('gesturechange', onGesture)
    document.removeEventListener('gestureend', onGesture)
    document.removeEventListener('wheel', onWheelCtrlZoom)
  }
}

async function beginPlay() {
  await nextTick()
  const el = mountRef.value
  if (!el) return
  game = createBlockWorldNextGame(el, {
    onPointerLockChange(locked) {
      pointerHint.value = !locked
    },
  })
  game.start()
  playing.value = true
  bwSession.setImmersive(true)
  await nextTick()
  syncPlayViewport()
  try {
    game.requestPointerLock()
  } catch {
    pointerHint.value = true
  }
}

async function exitToApp() {
  clearPinchLock()
  bwSession.setImmersive(false)
  if (game) {
    game.dispose()
    game = null
  }
  playing.value = false
  pointerHint.value = false
  await router.push('/student')
}

function resumePointer() {
  game?.requestPointerLock()
}

watch(
  () => playing.value,
  (v) => {
    if (v) installPinchLock()
    else clearPinchLock()
  },
  { immediate: true },
)

watch([playing], () => {
  void nextTick(() => syncPlayViewport())
})

onMounted(() => {
  window.visualViewport?.addEventListener('resize', onVisualViewportChange)
  window.visualViewport?.addEventListener('scroll', onVisualViewportChange)
  window.addEventListener('resize', onVisualViewportChange)
  window.addEventListener('orientationchange', onVisualViewportChange)
})

onUnmounted(() => {
  clearPinchLock()
  window.visualViewport?.removeEventListener('resize', onVisualViewportChange)
  window.visualViewport?.removeEventListener('scroll', onVisualViewportChange)
  window.removeEventListener('resize', onVisualViewportChange)
  window.removeEventListener('orientationchange', onVisualViewportChange)
  bwSession.setImmersive(false)
  if (game) {
    game.dispose()
    game = null
  }
})
</script>

<template>
  <div
    ref="mineRootRef"
    class="relative h-full min-h-0 w-full overflow-hidden bg-black fus-mine-root"
    :class="{ 'fus-mine-play-fixed': playing }"
  >
    <div ref="mountRef" class="fus-minecraft-engine absolute inset-0 h-full min-h-0 w-full" />

    <div
      v-if="!playing"
      class="absolute inset-0 z-20 flex flex-col items-center justify-center bg-gradient-to-b from-slate-900 via-slate-950 to-black px-6 text-center text-white"
    >
      <p class="mb-2 max-w-sm text-xs font-semibold leading-snug text-slate-400">
        Експериментальний рушій (окрема гілка розробки). Звичайний спільний світ — вкладка «Світ».
      </p>
      <button
        type="button"
        class="rounded-2xl bg-amber-500 px-10 py-3.5 text-base font-extrabold tracking-tight text-black shadow-lg shadow-amber-950/45 transition-all hover:bg-amber-400 hover:brightness-[1.02] focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 focus-visible:ring-offset-2 focus-visible:ring-offset-black/60 active:scale-[0.97]"
        @click="beginPlay"
      >
        Грати
      </button>
    </div>

    <button
      v-if="playing && pointerHint"
      type="button"
      class="absolute inset-0 z-30 flex cursor-pointer items-center justify-center bg-black/55 px-6 text-center text-sm font-extrabold text-white backdrop-blur-sm"
      @click="resumePointer"
    >
      Клацніть, щоб знову захопити курсор (WASD, пробіл — стрибок, Esc — вийти з режиму)
    </button>

    <button
      v-if="playing"
      type="button"
      class="fus-bw-exit-app pointer-events-auto absolute z-[220] touch-manipulation select-none rounded-xl border border-white/25 bg-black/55 px-3 py-2 text-xs font-extrabold text-white shadow-lg backdrop-blur-sm active:scale-[0.98]"
      style="top: max(0.5rem, env(safe-area-inset-top, 0px)); left: 0.5rem"
      @click="exitToApp"
    >
      Вийти
    </button>
  </div>
</template>

<style scoped>
.fus-mine-play-fixed {
  position: fixed;
  inset: 0;
  z-index: 30;
  width: 100%;
  max-width: 100%;
  touch-action: none;
  -webkit-user-select: none;
  user-select: none;
}

.fus-mine-root :deep(canvas) {
  display: block;
  width: 100%;
  height: 100%;
}

.fus-bw-exit-app {
  pointer-events: auto;
}
</style>
