<script setup>
/**
 * Shared voxel world: minecraft-threejs engine + Firestore world state + remote skins.
 */
import { ref, onUnmounted, onMounted, nextTick, watch } from 'vue'
import { buildBlockWorldHotbarSlots } from '@/game/blockWorldItems'
import * as THREE from 'three'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useUserStore } from '@/stores/user'
import { useBlockWorldSession } from '@/stores/blockWorldSession'
import { createFusBlockWorld } from '@/game/fusBlockWorld'
import {
  initSharedWorldFromFirestore,
  subscribeSharedWorldDoc,
  scheduleFlushCustomBlocks,
  cancelScheduledFlushCustomBlocks,
  subscribePresence,
  writePresence,
  deletePresence,
  bindPresenceDisconnectRemove,
  regenerateTerrain,
  restoreSharedWorldToDefaultTerrain,
} from '@/game/sharedWorldFirestore'
import {
  loadLastCameraPose,
  saveLastCameraPose,
  applyStoredPoseToCamera,
} from '@/game/blockWorldLocalPersist'
import { rtdb } from '@/firebase/config'
import { RemotePlayersManager } from '@/game/remotePlayersManager'
import { SpawnFlagsManager } from '@/game/spawnFlagsManager'
import {
  fetchPlayerSpawnFlag,
  savePlayerSpawnFlag,
  subscribeSpawnFlags,
  subscribePickaxeHitsForVictim,
  pushPickaxeHit,
} from '@/game/blockWorldRtdb'
import { PLAYER_EYE_HEIGHT } from '@/game/playerConstants'
import { normalizeSkinUrlForPresence } from '@/utils/presenceSkinUrl'
import { cameraYawFromQuaternion } from '@/game/cameraYaw'
import { useTouchGameControls } from '@/game/minebase/utils'
import '@/game/minebase/style.css'
import minecraftSunset from '@/assets/minecraft-sunset.jpg'

const WORLD_ID = 'school'

/** Only this access-code student sees “Скинути світ” in the block world HUD. */
const BLOCK_WORLD_RESET_ACCESS_CODE = 'GOLD-1531'

const desktopGameHints = !useTouchGameControls()

function applyBlockWorldHotbarFromStores() {
  if (!worldApi || !auth.profile) return
  const slots = buildBlockWorldHotbarSlots(
    auth.profile.inventory || [],
    auth.profile.inventoryCounts,
    userStore.items,
    auth.profile.blockWorldHotbarOrder,
  )
  worldApi.control.setBlockWorldHotbar(slots)
}

const mineRootRef = ref(null)
const mountRef = ref(null)
const booting = ref(false)
const errorMsg = ref('')
const started = ref(false)

const auth = useAuthStore()
const userStore = useUserStore()
const bwSession = useBlockWorldSession()

function studentMayResetBlockWorld() {
  const want = BLOCK_WORLD_RESET_ACCESS_CODE.toUpperCase()
  const fromProfile = String(auth.profile?.accessCode || '')
    .trim()
    .toUpperCase()
  const fromSession = String(auth.currentCode || '')
    .trim()
    .toUpperCase()
  return fromProfile === want || fromSession === want
}

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
let unsubSpawnFlags = null
let unsubPickaxeHits = null
let remotes = null
let spawnFlags = null
/** RTDB spawn flags (all players); reassigned in subscribe callback. */
let spawnFlagsMap = new Map()
/** Latest presence map for flag skins + online count. */
let presenceMapRef = new Map()
const spawnTeleportPos = new THREE.Vector3()
const spawnTeleportQuat = new THREE.Quaternion()
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
      if (presenceStopped) break
      await writePresence(worldId, uid, data)
      // Leaving the world sets presenceStopped mid-flight — never write again after teardown.
      if (presenceStopped) break
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
  if (worldApi?.control) {
    worldApi.control.onPlayerHpPresenceFlush = undefined
  }
  cancelScheduledFlushCustomBlocks()
  if (worldApi && auth.user?.uid) {
    saveLastCameraPose(WORLD_ID, auth.user.uid, worldApi.core.camera)
  }
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
  unsubSpawnFlags?.()
  unsubSpawnFlags = null
  unsubPickaxeHits?.()
  unsubPickaxeHits = null
  remotes?.dispose()
  remotes = null
  spawnFlags?.dispose()
  spawnFlags = null
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
    let lastPoseSaveAt = 0
    worldApi = createFusBlockWorld(mountRef.value, {
      onCustomBlocksChange: () => {
        if (worldApi) scheduleFlushCustomBlocks(WORLD_ID, worldApi.terrain)
      },
      onFrame: (dt) => {
        remotes?.update(dt)
        if (spawnFlags && worldApi) spawnFlags.update(worldApi.core.camera)
        if (presenceStopped || !worldApi) return
        const uid = auth.user?.uid
        if (!uid) return
        const t = Date.now()
        if (t - lastPoseSaveAt < 3500) return
        lastPoseSaveAt = t
        saveLastCameraPose(WORLD_ID, uid, worldApi.core.camera)
      },
      ...(studentMayResetBlockWorld()
        ? {
            onRestoreWorld: async () => {
              if (!worldApi) return
              const ok = confirm(
                'Скинути всі побудовані та зламані клітини в цьому світі для ВСІХ гравців?\n' +
                  'Рельєф (базові блоки з генератора) залишиться.\n' +
                  'Цю дію не можна скасувати.',
              )
              if (!ok) return
              try {
                await restoreSharedWorldToDefaultTerrain(WORLD_ID, worldApi.terrain)
              } catch (err) {
                console.error('[BlockWorld] restore world', err)
                window.alert(
                  'Не вдалося скинути світ. Перевір права доступу до Firestore або зʼєднання.',
                )
              }
            },
          }
        : {}),
      onPlaceSpawnFlag: async () => {
        if (!worldApi || !auth.user?.uid) return
        const cam = worldApi.core.camera
        const feetY = cam.position.y - PLAYER_EYE_HEIGHT - 0.08
        try {
          await savePlayerSpawnFlag(WORLD_ID, auth.user.uid, {
            x: cam.position.x,
            y: feetY,
            z: cam.position.z,
            ry: cameraYawFromQuaternion(cam.quaternion),
          })
        } catch (err) {
          console.warn('[BlockWorld] save spawn flag', err)
          window.alert('Не вдалося зберегти прапорець спавну.')
        }
      },
    })

    const presenceUid = auth.user.uid

    const syncSpawnFlagMeshes = () => {
      if (!spawnFlags) return
      const skinByUid = new Map()
      for (const [uid, doc] of presenceMapRef) {
        const url =
          uid === presenceUid
            ? resolvePresenceSkinUrl(auth.profile, userStore.items)
            : normalizeSkinUrlForPresence(doc?.skinUrl ?? null)
        skinByUid.set(uid, url)
      }
      spawnFlags.sync(spawnFlagsMap, skinByUid)
    }

    remotes = new RemotePlayersManager(
      worldApi.core.scene,
      presenceUid,
      worldApi.terrain,
    )
    spawnFlags = new SpawnFlagsManager(worldApi.core.scene, presenceUid)

    const worldFingerprint = await initSharedWorldFromFirestore(WORLD_ID, worldApi.terrain)

    worldApi.start()

    await worldApi.terrain.waitForFirstGenerate()

    const rtdbFlag = await fetchPlayerSpawnFlag(WORLD_ID, presenceUid)
    if (rtdbFlag) {
      spawnTeleportQuat.setFromEuler(new THREE.Euler(0, rtdbFlag.ry, 0, 'YXZ'))
      worldApi.core.camera.position.set(
        rtdbFlag.x,
        rtdbFlag.y + PLAYER_EYE_HEIGHT + 0.08,
        rtdbFlag.z,
      )
      worldApi.core.camera.quaternion.copy(spawnTeleportQuat)
      worldApi.control.velocity.set(0, 0, 0)
      worldApi.control.setTouchAnalog(0, 0)
    } else {
      const restored = loadLastCameraPose(WORLD_ID, presenceUid)
      if (restored) {
        applyStoredPoseToCamera(worldApi.core.camera, restored)
        worldApi.control.velocity.set(0, 0, 0)
        worldApi.control.setTouchAnalog(0, 0)
      }
    }

    worldApi.setSpawnTeleportResolver(() => {
      const pose = spawnFlagsMap.get(presenceUid)
      if (!pose) return null
      spawnTeleportPos.set(pose.x, pose.y + PLAYER_EYE_HEIGHT + 0.08, pose.z)
      spawnTeleportQuat.setFromEuler(new THREE.Euler(0, pose.ry, 0, 'YXZ'))
      return { position: spawnTeleportPos, quaternion: spawnTeleportQuat }
    })

    worldApi.control.getRemotePlayerRaycastRoots = () => remotes.getPickaxeRaycastRoots()
    worldApi.control.onPickaxeHitRemotePlayer = (targetUid) => {
      const dmg = worldApi.control.getBwPvpDamageHalf()
      if (dmg <= 0) return
      void pushPickaxeHit(WORLD_ID, presenceUid, targetUid, dmg)
    }
    worldApi.control.onHealthDepleted = () => {
      worldApi?.teleportToSpawn()
    }

    const pickaxeHitsIgnoreBefore = Date.now()
    unsubPickaxeHits = subscribePickaxeHitsForVictim(
      WORLD_ID,
      presenceUid,
      (dmg) => {
        worldApi?.control.applyDamageHalfUnits(dmg)
      },
      { ignoreHitsBeforeTs: pickaxeHitsIgnoreBefore },
    )

    unsubSpawnFlags = subscribeSpawnFlags(WORLD_ID, (m) => {
      spawnFlagsMap = m
      syncSpawnFlagMeshes()
    })

    unsubWorld = subscribeSharedWorldDoc(
      WORLD_ID,
      worldApi.terrain,
      () => {
        if (terrainRegenTimer) clearTimeout(terrainRegenTimer)
        terrainRegenTimer = setTimeout(() => {
          terrainRegenTimer = null
          if (worldApi) regenerateTerrain(worldApi.terrain)
        }, 70)
      },
      worldFingerprint,
    )

    unsubPresence = subscribePresence(WORLD_ID, (map) => {
      presenceMapRef = map
      remotes?.sync(map)
      worldApi?.hud?.setOnlineCount(map.size)
      syncSpawnFlagMeshes()
    })

    try {
      await bindPresenceDisconnectRemove(WORLD_ID, presenceUid)
    } catch (e) {
      console.warn('[BlockWorld] bindPresenceDisconnectRemove', e)
    }

    applyBlockWorldHotbarFromStores()

    function buildPresencePayload() {
      const cam = worldApi.core.camera
      const v = worldApi.control.velocity
      const moving = v.x * v.x + v.y * v.y + v.z * v.z > 0.15
      const skinUrl = resolvePresenceSkinUrl(auth.profile, userStore.items)
      const photoUrl = normalizeSkinUrlForPresence(
        auth.profile?.avatar?.photoUrl ?? null,
      )
      const hand = worldApi.control.getPresenceHandFields()
      return {
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
        bwBlockType: hand.bwBlockType,
        bwHandMine: hand.bwHandMine,
        bwToolMesh: hand.bwToolMesh ?? undefined,
        handSwingSeq: worldApi.control.handSwingSeq,
        playerHpHalfUnits: worldApi.control.playerHpHalfUnits,
      }
    }

    worldApi.control.onPlayerHpPresenceFlush = () => {
      if (presenceStopped || !worldApi) return
      presencePendingPayload = buildPresencePayload()
      void flushPresenceQueue(WORLD_ID)
    }

    let presenceIdleCounter = 0
    presenceTimer = window.setInterval(() => {
      if (presenceStopped || !worldApi) return
      const uid = auth.user?.uid
      if (!uid) return
      const v = worldApi.control.velocity
      const moving = v.x * v.x + v.y * v.y + v.z * v.z > 0.15
      if (!moving) {
        presenceIdleCounter = (presenceIdleCounter + 1) % 4
        if (presenceIdleCounter !== 0) return
      } else {
        presenceIdleCounter = 0
      }
      presencePendingPayload = buildPresencePayload()
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

watch(
  () => [
    started.value,
    auth.profile?.inventory?.join(','),
    JSON.stringify(auth.profile?.inventoryCounts || {}),
    JSON.stringify(auth.profile?.blockWorldHotbarOrder || []),
    userStore.items.length,
  ],
  () => {
    if (!started.value || presenceStopped || !worldApi) return
    applyBlockWorldHotbarFromStores()
  },
)

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
      Клацни по світу, щоб захопити курсор · WASD — рух · миша — огляд · хотбар (1–9) — предмети з магазину «Світ» · кулак ламає блоки повільно · кайло швидше і може влучати в гравців · ЛКМ — копати / ставити · ПКМ — ставити в режимі будівництва
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
