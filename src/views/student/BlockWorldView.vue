<script setup>
/**
 * Shared voxel world: minecraft-threejs engine + Firestore world state + remote skins.
 */
import { ref, onUnmounted, onMounted, nextTick, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useUserStore } from '@/stores/user'
import { useBlockWorldSession } from '@/stores/blockWorldSession'
import { createFusBlockWorld } from '@/game/fusBlockWorld'
import {
  initSharedWorldFromFirestore,
  subscribeSharedWorldDoc,
  scheduleFlushCustomBlocks,
  subscribePresence,
  writePresence,
  deletePresence,
  bindPresenceDisconnectRemove,
  regenerateTerrain,
} from '@/game/sharedWorldFirestore'
import { rtdb } from '@/firebase/config'
import { RemotePlayersManager } from '@/game/remotePlayersManager'
import { normalizeSkinUrlForPresence } from '@/utils/presenceSkinUrl'
import { cameraYawFromQuaternion } from '@/game/cameraYaw'
import { useTouchGameControls } from '@/game/minebase/utils'
import '@/game/minebase/style.css'
import minecraftSunset from '@/assets/minecraft-sunset.jpg'

const WORLD_ID = 'school'

const desktopGameHints = !useTouchGameControls()

const mineRootRef = ref(null)
const mountRef = ref(null)
const booting = ref(false)
const errorMsg = ref('')
const started = ref(false)

const auth = useAuthStore()
const userStore = useUserStore()
const bwSession = useBlockWorldSession()

/** Prefer `skinUrl`; else resolve shop skin URL from `skinId` using the items catalog. */
function resolvePresenceSkinUrl(profile, items) {
  const direct = normalizeSkinUrlForPresence(profile?.avatar?.skinUrl ?? null)
  if (direct) return direct
  const sid = profile?.avatar?.skinId
  if (!sid || sid === 'default' || !items?.length) return null
  const it = items.find((i) => i.skinId === sid || i.id === sid)
  return normalizeSkinUrlForPresence(it?.skinUrl ?? null)
}
const router = useRouter()

let worldApi = null
let unsubWorld = null
let unsubPresence = null
let remotes = null
let presenceTimer = null
/** Latest presence payload; one writer drains the queue so slow writes cannot backlog. */
let presencePendingPayload = null
let presenceWriteBusy = false
/** True while tearing down — blocks new writes and prevents a late write after deletePresence. */
let presenceStopped = false
/** Coalesce rapid Firestore world writes into one terrain worker run (reduces flicker). */
let terrainRegenTimer = null

async function flushPresenceQueue(worldId) {
  const uid = auth.user?.uid
  if (!uid || presenceWriteBusy || presenceStopped) return
  presenceWriteBusy = true
  try {
    while (presencePendingPayload && !presenceStopped) {
      const data = presencePendingPayload
      presencePendingPayload = null
      await writePresence(worldId, uid, data)
    }
  } catch (err) {
    console.warn('[BlockWorld] writePresence', err)
  } finally {
    presenceWriteBusy = false
    if (!presenceStopped && presencePendingPayload) void flushPresenceQueue(worldId)
  }
}

async function waitPresenceWriterIdle(maxMs = 5000) {
  const deadline = Date.now() + maxMs
  while (presenceWriteBusy && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25))
  }
}

function clearMinePlayViewport() {
  const el = mineRootRef.value
  if (!el) return
  el.style.minHeight = ''
  el.style.height = ''
}

function syncMinePlayViewport() {
  const root = mineRootRef.value
  if (!root || !started.value) {
    clearMinePlayViewport()
    return
  }
  const fixedPlay = started.value && !booting.value
  if (fixedPlay) {
    /* `.fus-mine-play-fixed` uses inset:0; drop inline height so it tracks the real viewport. */
    root.style.minHeight = ''
    root.style.height = ''
  } else {
    const vv = window.visualViewport
    if (vv) {
      root.style.minHeight = `${vv.height}px`
      root.style.height = `${vv.height}px`
    } else {
      root.style.minHeight = '100dvh'
      root.style.height = ''
    }
  }
  worldApi?.syncRendererSize?.()
}

async function exitFullscreenSafe() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen()
  } catch {
    /* ignore */
  }
}

async function teardownWorld() {
  presenceStopped = true
  if (terrainRegenTimer) {
    clearTimeout(terrainRegenTimer)
    terrainRegenTimer = null
  }
  if (presenceTimer) {
    clearInterval(presenceTimer)
    presenceTimer = null
  }
  presencePendingPayload = null
  const leaveUid = auth.user?.uid
  await waitPresenceWriterIdle()
  if (leaveUid) {
    await deletePresence(WORLD_ID, leaveUid)
  }
  unsubWorld?.()
  unsubWorld = null
  unsubPresence?.()
  unsubPresence = null
  remotes?.dispose()
  remotes = null
  worldApi?.dispose()
  worldApi = null
  clearMinePlayViewport()
}

async function leaveWorld() {
  await exitFullscreenSafe()
  bwSession.setImmersive(false)
  await teardownWorld()
  started.value = false
  booting.value = false
}

async function beginPlay() {
  if (!mountRef.value || started.value) return
  await auth.init()
  await userStore.fetchItems()
  if (!auth.user?.uid) {
    errorMsg.value =
      'Потрібна активна сесія Firebase Auth. Якщо зайшли з IP (наприклад 192.168.x.x), додайте цей хост у Firebase → Authentication → Authorized domains.'
    return
  }
  if (!rtdb) {
    errorMsg.value =
      'Для мультиплеєру потрібен Firebase Realtime Database: увімкни його в консолі (Build → Realtime Database) і додай у .env змінну VITE_FIREBASE_DATABASE_URL (URL бази з налаштувань проєкту).'
    return
  }
  errorMsg.value = ''
  started.value = true
  booting.value = true

  try {
    presenceStopped = false
    worldApi = createFusBlockWorld(mountRef.value, {
      onCustomBlocksChange: () => {
        if (worldApi) scheduleFlushCustomBlocks(WORLD_ID, worldApi.terrain)
      },
      onFrame: (dt) => {
        remotes?.update(dt)
      },
    })

    const presenceUid = auth.user.uid

    remotes = new RemotePlayersManager(
      worldApi.core.scene,
      presenceUid,
      worldApi.terrain,
    )

    const worldFingerprint = await initSharedWorldFromFirestore(WORLD_ID, worldApi.terrain)

    worldApi.start()

    await worldApi.terrain.waitForFirstGenerate()

    unsubWorld = subscribeSharedWorldDoc(
      WORLD_ID,
      worldApi.terrain,
      () => {
        if (terrainRegenTimer) clearTimeout(terrainRegenTimer)
        terrainRegenTimer = setTimeout(() => {
          terrainRegenTimer = null
          if (worldApi) regenerateTerrain(worldApi.terrain)
        }, 140)
      },
      worldFingerprint,
    )

    unsubPresence = subscribePresence(WORLD_ID, (map) => {
      remotes?.sync(map)
    })

    try {
      await bindPresenceDisconnectRemove(WORLD_ID, presenceUid)
    } catch (e) {
      console.warn('[BlockWorld] bindPresenceDisconnectRemove', e)
    }

    let presenceIdleCounter = 0
    presenceTimer = window.setInterval(() => {
      if (presenceStopped || !worldApi) return
      const uid = auth.user?.uid
      if (!uid) return
      const cam = worldApi.core.camera
      const v = worldApi.control.velocity
      const moving = v.x * v.x + v.y * v.y + v.z * v.z > 0.15
      if (!moving) {
        presenceIdleCounter = (presenceIdleCounter + 1) % 4
        if (presenceIdleCounter !== 0) return
      } else {
        presenceIdleCounter = 0
      }
      const skinUrl = resolvePresenceSkinUrl(auth.profile, userStore.items)
      const photoUrl = normalizeSkinUrlForPresence(
        auth.profile?.avatar?.photoUrl ?? null,
      )
      presencePendingPayload = {
        x: cam.position.x,
        y: cam.position.y,
        z: cam.position.z,
        ry: cameraYawFromQuaternion(cam.quaternion),
        moving,
        skinUrl,
        photoUrl,
        displayName: auth.profile?.displayName || 'Гравець',
        mode: worldApi.control.interactionMode,
        slot: worldApi.control.holdingIndex,
        handSwingSeq: worldApi.control.handSwingSeq,
      }
      void flushPresenceQueue(WORLD_ID)
    }, 50)

    bwSession.setImmersive(true)
    await nextTick()
    syncMinePlayViewport()
    const rootEl = mountRef.value?.parentElement
    if (rootEl?.requestFullscreen) {
      await rootEl.requestFullscreen().catch(() => {})
    }
    await nextTick()
    syncMinePlayViewport()
  } catch (e) {
    console.error('[BlockWorld]', e)
    errorMsg.value = e?.message || String(e)
    started.value = false
    bwSession.setImmersive(false)
    await exitFullscreenSafe()
    await teardownWorld()
  } finally {
    booting.value = false
  }
}

async function exitToApp() {
  await leaveWorld()
  await router.push('/student')
}

const onVisualViewportChange = () => {
  if (started.value && worldApi) syncMinePlayViewport()
}

onMounted(() => {
  window.visualViewport?.addEventListener('resize', onVisualViewportChange)
  window.visualViewport?.addEventListener('scroll', onVisualViewportChange)
})

watch([started, booting], () => {
  void nextTick(() => syncMinePlayViewport())
})

onUnmounted(async () => {
  window.visualViewport?.removeEventListener('resize', onVisualViewportChange)
  window.visualViewport?.removeEventListener('scroll', onVisualViewportChange)
  await exitFullscreenSafe()
  bwSession.setImmersive(false)
  await teardownWorld()
})
</script>

<template>
  <div
    ref="mineRootRef"
    class="relative w-full h-full min-h-0 bg-black overflow-hidden fus-mine-root"
    :class="{ 'fus-mine-play-fixed': started && !booting }"
  >
    <!-- Scoped minebase CSS (touch-action / overflow) applies only here — not whole document. -->
    <div ref="mountRef" class="fus-minecraft-engine absolute inset-0 w-full h-full min-h-0" />

    <div
      v-if="!started"
      class="absolute inset-0 z-20 flex flex-col items-center justify-center px-6 text-center text-white"
    >
      <div
        class="pointer-events-none absolute inset-0 bg-cover bg-center"
        :style="{ backgroundImage: `url(${minecraftSunset})` }"
        aria-hidden="true"
      />
      <div
        class="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/45 via-black/50 to-black/75"
        aria-hidden="true"
      />
      <div class="relative z-10 flex max-w-sm flex-col items-center gap-5">
        <p
          v-if="!auth.user?.uid && !auth.loading"
          class="text-xs font-semibold leading-snug text-red-200/95 drop-shadow-md"
        >
          Немає сесії Firebase — оновіть сторінку після входу або додайте цей хост у Authorized domains.
        </p>
        <p
          v-if="errorMsg"
          class="text-sm font-semibold leading-snug text-red-200 drop-shadow-md"
        >
          {{ errorMsg }}
        </p>
        <button
          type="button"
          class="rounded-2xl px-10 py-3.5 text-base font-extrabold tracking-tight text-black shadow-lg shadow-amber-950/45 transition-all active:scale-[0.97] disabled:pointer-events-none disabled:opacity-45 bg-amber-500 hover:bg-amber-400 hover:brightness-[1.02] focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 focus-visible:ring-offset-2 focus-visible:ring-offset-black/60"
          :disabled="!auth.user?.uid || auth.loading"
          @click="beginPlay"
        >
          Грати
        </button>
      </div>
    </div>

    <div
      v-else-if="booting"
      class="absolute inset-0 flex items-center justify-center bg-black/60 text-white z-10 text-sm font-bold"
    >
      Завантаження…
    </div>

    <button
      v-else-if="started && !booting"
      type="button"
      class="fus-bw-exit-app absolute z-[220] rounded-xl border border-white/25 bg-black/55 px-3 py-2 text-xs font-extrabold text-white shadow-lg backdrop-blur-sm active:scale-[0.98] touch-manipulation"
      style="top: max(0.5rem, env(safe-area-inset-top, 0px)); left: 0.5rem"
      @click="exitToApp"
    >
      Вийти
    </button>
    <p
      v-if="started && !booting && desktopGameHints"
      class="pointer-events-none absolute z-[215] max-w-[min(92vw,24rem)] text-center text-[11px] font-semibold leading-snug text-white/70 drop-shadow-md"
      style="top: max(3.25rem, calc(env(safe-area-inset-top, 0px) + 2.75rem)); left: 50%; transform: translateX(-50%)"
    >
      Клацни по світу, щоб захопити курсор · WASD — рух · миша — огляд · ЛКМ — ламати / будувати
    </p>
  </div>
</template>

<style scoped>
/* Cover the shell when flex layout height exceeds the visible viewport (mobile browser chrome). */
.fus-mine-play-fixed {
  position: fixed;
  inset: 0;
  z-index: 30;
  width: 100%;
  max-width: 100%;
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
