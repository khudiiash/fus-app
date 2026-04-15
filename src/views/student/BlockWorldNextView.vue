<script setup>
/**
 * Experimental voxel playground (new engine path). Production world remains `/student/world`.
 * Same shared `customBlocks`, spawn / last pose, and RTDB presence as the classic world.
 */
import { ref, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useUserStore } from '@/stores/user'
import { useBlockWorldSession } from '@/stores/blockWorldSession'
import { rtdb } from '@/firebase/config'
import {
  loadSharedWorldInitialState,
  subscribeSharedWorldCustomBlocks,
  subscribePresence,
  writePresence,
  deletePresence,
  bindPresenceDisconnectRemove,
  scheduleFlushSharedWorldBlocksList,
  cancelScheduledFlushSharedWorldBlocksList,
} from '@/game/sharedWorldFirestore'
import { fetchPlayerSpawnFlag } from '@/game/blockWorldRtdb'
import {
  loadLastCameraPose,
  saveLastCameraPose,
} from '@/game/blockWorldLocalPersist'
import { cameraYawFromQuaternion } from '@/game/cameraYaw'
import { normalizeSkinUrlForPresence } from '@/utils/presenceSkinUrl'
import { BLOCK_WORLD_MAX_HP_HALF_UNITS } from '@/game/playerConstants'
import {
  createBlockWorldNextGame,
  BlockWorldNextPresenceAvatars,
} from '@/game/blockWorldNext'
import '@/game/minebase/style.css'

const WORLD_ID = 'school'

const router = useRouter()
const auth = useAuthStore()
const userStore = useUserStore()
const bwSession = useBlockWorldSession()

const mineRootRef = ref(null)
const mountRef = ref(null)
const playing = ref(false)
const booting = ref(false)
const errorMsg = ref('')
const pointerHint = ref(false)
let game = null
/** @type {null | (() => void)} */
let unsubBlocks = null
/** @type {null | (() => void)} */
let unsubPresence = null
/** @type {BlockWorldNextPresenceAvatars | null} */
let avatars = null
let presenceTimer = null
let poseSaveTimer = null
let presenceStopped = true

function resolvePresenceSkinUrl(profile, items) {
  const direct = normalizeSkinUrlForPresence(profile?.avatar?.skinUrl ?? null)
  if (direct) return direct
  const sid = profile?.avatar?.skinId
  if (!sid || sid === 'default' || !items?.length) return null
  const it = items.find((i) => i.skinId === sid || i.id === sid)
  return normalizeSkinUrlForPresence(it?.skinUrl ?? null)
}

function buildPresencePayload() {
  const cam = game.getCamera()
  const moving = game.isMovingForPresence()
  const skinUrl = resolvePresenceSkinUrl(auth.profile, userStore.items)
  const photoUrl = normalizeSkinUrlForPresence(auth.profile?.avatar?.photoUrl ?? null)
  return {
    x: cam.position.x,
    y: cam.position.y,
    z: cam.position.z,
    ry: cameraYawFromQuaternion(cam.quaternion),
    moving,
    skinUrl,
    photoUrl,
    displayName: auth.profile?.displayName || 'Гравець',
    mode: 'mine',
    slot: 0,
    bwBlockType: 0,
    bwHandMine: 'fist',
    handSwingSeq: 0,
    playerHpHalfUnits: BLOCK_WORLD_MAX_HP_HALF_UNITS,
  }
}

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

async function teardownGame() {
  cancelScheduledFlushSharedWorldBlocksList()
  presenceStopped = true
  if (poseSaveTimer) {
    clearInterval(poseSaveTimer)
    poseSaveTimer = null
  }
  if (presenceTimer) {
    clearInterval(presenceTimer)
    presenceTimer = null
  }
  if (unsubPresence) {
    try {
      unsubPresence()
    } catch {
      /* ignore */
    }
    unsubPresence = null
  }
  if (avatars) {
    avatars.dispose()
    avatars = null
  }

  const leaveUid = auth.user?.uid
  if (leaveUid && game) {
    try {
      saveLastCameraPose(WORLD_ID, leaveUid, game.getCamera())
    } catch {
      /* ignore */
    }
  }
  if (leaveUid) {
    try {
      await deletePresence(WORLD_ID, leaveUid)
    } catch {
      /* ignore */
    }
  }

  if (unsubBlocks) {
    try {
      unsubBlocks()
    } catch {
      /* ignore */
    }
    unsubBlocks = null
  }
  if (game) {
    game.dispose()
    game = null
  }
}

async function beginPlay() {
  if (booting.value || playing.value) return
  errorMsg.value = ''
  booting.value = true
  await auth.init()
  await userStore.fetchItems()
  if (!auth.user?.uid) {
    errorMsg.value =
      'Потрібна активна сесія Firebase Auth. Якщо зайшли з IP (наприклад 192.168.x.x), додайте цей хост у Firebase → Authentication → Authorized domains.'
    booting.value = false
    return
  }
  try {
    await nextTick()
    const el = mountRef.value
    if (!el) {
      booting.value = false
      return
    }
    const uid = auth.user.uid
    const rtdbFlag = await fetchPlayerSpawnFlag(WORLD_ID, uid)
    const storedPose = rtdbFlag ? null : loadLastCameraPose(WORLD_ID, uid)

    const initial = await loadSharedWorldInitialState(WORLD_ID)
    const g = createBlockWorldNextGame(el, {
      onPointerLockChange(locked) {
        pointerHint.value = !locked
      },
      onBlocksEdited() {
        scheduleFlushSharedWorldBlocksList(WORLD_ID, () =>
          game ? game.getWorkingBlocksSnapshot() : [],
        )
      },
    })
    g.applyCustomBlocks(initial.blocks)
    g.applyCameraSpawnFromRtdbOrLocal(rtdbFlag, storedPose)
    g.start()
    game = g

    unsubBlocks = subscribeSharedWorldCustomBlocks(
      WORLD_ID,
      (blocks) => {
        game?.applyCustomBlocks(blocks)
      },
      initial.blocksFingerprint,
    )

    if (rtdb) {
      presenceStopped = false
      avatars = new BlockWorldNextPresenceAvatars(g.getScene(), uid)
      unsubPresence = subscribePresence(WORLD_ID, (map) => {
        avatars?.sync(map)
      })
      try {
        await bindPresenceDisconnectRemove(WORLD_ID, uid)
      } catch (e) {
        console.warn('[BlockWorldNext] bindPresenceDisconnectRemove', e)
      }
      const presenceTickMs = 88
      presenceTimer = window.setInterval(() => {
        if (presenceStopped || !game) return
        void writePresence(WORLD_ID, uid, buildPresencePayload()).catch(() => {})
      }, presenceTickMs)
      void writePresence(WORLD_ID, uid, buildPresencePayload()).catch(() => {})
    }

    poseSaveTimer = window.setInterval(() => {
      if (!playing.value || !game || !auth.user?.uid) return
      saveLastCameraPose(WORLD_ID, auth.user.uid, game.getCamera())
    }, 3600)

    playing.value = true
    bwSession.setImmersive(true)
    await nextTick()
    syncPlayViewport()
    try {
      g.requestPointerLock()
    } catch {
      pointerHint.value = true
    }
  } catch (e) {
    console.error('[BlockWorldNext]', e)
    errorMsg.value = e?.message || String(e)
    await teardownGame()
    playing.value = false
    bwSession.setImmersive(false)
  } finally {
    booting.value = false
  }
}

async function exitToApp() {
  clearPinchLock()
  bwSession.setImmersive(false)
  await teardownGame()
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

onUnmounted(async () => {
  clearPinchLock()
  window.visualViewport?.removeEventListener('resize', onVisualViewportChange)
  window.visualViewport?.removeEventListener('scroll', onVisualViewportChange)
  window.removeEventListener('resize', onVisualViewportChange)
  window.removeEventListener('orientationchange', onVisualViewportChange)
  bwSession.setImmersive(false)
  await teardownGame()
})
</script>

<template>
  <div
    ref="mineRootRef"
    class="relative h-full min-h-0 w-full overflow-hidden bg-black fus-mine-root"
    :class="{ 'fus-mine-play-fixed': playing && !booting }"
  >
    <div ref="mountRef" class="fus-minecraft-engine absolute inset-0 h-full min-h-0 w-full" />

    <div
      v-if="!playing"
      class="absolute inset-0 z-20 flex flex-col items-center justify-center bg-gradient-to-b from-slate-900 via-slate-950 to-black px-6 text-center text-white"
    >
      <p class="mb-2 max-w-sm text-xs font-semibold leading-snug text-slate-400">
        Експериментальний рушій. ЛКМ — зламати поставлений блок, ПКМ — трава на сусідній клітині (той самий світ у
        RTDB/Firestore). Класичний режим — «Світ».
      </p>
      <p
        v-if="errorMsg"
        class="mb-3 max-w-sm text-xs font-semibold leading-snug text-red-200/95"
      >
        {{ errorMsg }}
      </p>
      <button
        type="button"
        class="rounded-2xl bg-amber-500 px-10 py-3.5 text-base font-extrabold tracking-tight text-black shadow-lg shadow-amber-950/45 transition-all hover:bg-amber-400 hover:brightness-[1.02] focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 focus-visible:ring-offset-2 focus-visible:ring-offset-black/60 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-45"
        :disabled="booting || !auth.user?.uid || auth.loading"
        @click="beginPlay"
      >
        {{ booting ? 'Підключення…' : 'Грати' }}
      </button>
    </div>

    <div
      v-else-if="booting"
      class="absolute inset-0 z-10 flex items-center justify-center bg-black/60 text-sm font-bold text-white"
    >
      Завантаження…
    </div>

    <button
      v-if="playing && !booting && pointerHint"
      type="button"
      class="absolute inset-0 z-30 flex cursor-pointer items-center justify-center bg-black/55 px-6 text-center text-sm font-extrabold text-white backdrop-blur-sm"
      @click="resumePointer"
    >
      Клацніть, щоб знову захопити курсор (WASD, пробіл — стрибок, Esc — вийти з режиму)
    </button>

    <button
      v-if="playing && !booting"
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
