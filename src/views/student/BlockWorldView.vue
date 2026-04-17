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
import {
  ensureWorldMobsSeeded,
  forceRespawnWorldMobs,
  subscribeMobHitsForVictim,
  mobDamageFromPlayer,
  tryClaimMobCoinDrop,
  removeMobCoinDrop,
} from '@/game/blockWorldMobsRtdb'
import { grantStudentCoinsFromGame } from '@/firebase/collections'
import { BlockWorldMobsManager } from '@/game/blockWorldMobsManager'
import { PLAYER_EYE_HEIGHT } from '@/game/playerConstants'
import { normalizeSkinUrlForPresence } from '@/utils/presenceSkinUrl'
import { cameraYawFromQuaternion } from '@/game/cameraYaw'
import { blockWorldAggressiveMobile, isLowPowerTouchDevice } from '@/game/minebase/utils'
import '@/game/minebase/style.css'
import minecraftSunset from '@/assets/minecraft-sunset.jpg'

const WORLD_ID = 'school'

/** Only this access-code student sees “Скинути світ” in the block world HUD. */
const BLOCK_WORLD_RESET_ACCESS_CODE = 'GOLD-1531'

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
let unsubMobHits = null
let mobsManager = null
/** Mob coin Firestore grants are debounced; RTDB pickup + HUD update happen immediately. */
let mobCoinFirestorePending = 0
let mobCoinFirestoreTimer = null
const MOB_COIN_FIRESTORE_DEBOUNCE_MS = 720

/** Coins only — XP/level follow the batched Firestore grant (`ceil(total*1.5)`), avoiding per-coin ceil drift. */
function bumpOptimisticMobCoins(delta) {
  const p = auth.profile
  if (!p || delta <= 0) return
  auth.profile = {
    ...p,
    coins: (p.coins || 0) + delta,
  }
}

function scheduleMobCoinFirestoreFlush(uid) {
  if (mobCoinFirestoreTimer) clearTimeout(mobCoinFirestoreTimer)
  mobCoinFirestoreTimer = setTimeout(() => {
    mobCoinFirestoreTimer = null
    void flushMobCoinFirestore(uid)
  }, MOB_COIN_FIRESTORE_DEBOUNCE_MS)
}

async function flushMobCoinFirestore(uid) {
  const amt = mobCoinFirestorePending
  mobCoinFirestorePending = 0
  if (!amt || !uid) return
  try {
    await grantStudentCoinsFromGame(
      uid,
      amt,
      'Світ блоків: монети з мобів',
    )
  } catch (e) {
    console.warn('[BlockWorld] batched mob coins (Firestore)', e)
    mobCoinFirestorePending += amt
    scheduleMobCoinFirestoreFlush(uid)
  }
}

async function flushMobCoinFirestoreOnLeave(uid) {
  if (mobCoinFirestoreTimer) {
    clearTimeout(mobCoinFirestoreTimer)
    mobCoinFirestoreTimer = null
  }
  const amt = mobCoinFirestorePending
  mobCoinFirestorePending = 0
  if (!amt || !uid) return
  try {
    await grantStudentCoinsFromGame(
      uid,
      amt,
      'Світ блоків: монети з мобів',
    )
  } catch (e) {
    console.warn('[BlockWorld] flush mob coins on leave', e)
    mobCoinFirestorePending += amt
  }
}

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
  unsubMobHits?.()
  unsubMobHits = null
  await flushMobCoinFirestoreOnLeave(leaveUid)
  mobsManager?.dispose()
  mobsManager = null
  if (worldApi?.control) {
    worldApi.control.getMobRaycastRoots = () => []
    worldApi.control.onPickaxeHitMob = undefined
  }
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
    const bwCpuTight = blockWorldAggressiveMobile()
    let lastPoseSaveAt = 0
    worldApi = createFusBlockWorld(mountRef.value, {
      onCustomBlocksChange: () => {
        if (worldApi) scheduleFlushCustomBlocks(WORLD_ID, worldApi.terrain)
      },
      onFrame: (dt) => {
        remotes?.update(dt)
        mobsManager?.setPresenceMap(presenceMapRef)
        mobsManager?.update(dt)
        if (presenceStopped || !worldApi) return
        const uid = auth.user?.uid
        if (!uid) return
        const t = Date.now()
        if (t - lastPoseSaveAt < (bwCpuTight ? 5200 : 3500)) return
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
            onRespawnMobs: async () => {
              if (!worldApi) return
              const ok = confirm(
                'Оживити всіх стандартних мобів у цьому світі (повне HP, без очікування респавну)?\n' +
                  'Це не скасовує вбиті блоки чи будівлі.',
              )
              if (!ok) return
              try {
                await forceRespawnWorldMobs(WORLD_ID, worldApi.terrain)
              } catch (err) {
                console.error('[BlockWorld] respawn mobs', err)
                window.alert(
                  'Не вдалося оновити мобів. Перевір зʼєднання з Realtime Database.',
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

    worldApi.syncRendererSize()

    try {
      await worldApi.prepareWebGpuRenderer()
    } catch (e) {
      console.warn('[BlockWorld] WebGPU init', e)
    }

    worldApi.start()

    await worldApi.terrain.waitForFirstGenerate()

    const rtdbFlag = await fetchPlayerSpawnFlag(WORLD_ID, presenceUid)
    const restoredPose = rtdbFlag
      ? null
      : loadLastCameraPose(WORLD_ID, presenceUid)
    const mobSeedSpawnX = rtdbFlag
      ? rtdbFlag.x
      : restoredPose
        ? restoredPose.x
        : worldApi.core.camera.position.x
    const mobSeedSpawnZ = rtdbFlag
      ? rtdbFlag.z
      : restoredPose
        ? restoredPose.z
        : worldApi.core.camera.position.z

    try {
      await ensureWorldMobsSeeded(WORLD_ID, worldApi.terrain, {
        spawnColumnX: mobSeedSpawnX,
        spawnColumnZ: mobSeedSpawnZ,
      })
    } catch (e) {
      console.warn('[BlockWorld] seed mobs', e)
    }
    mobsManager = new BlockWorldMobsManager(
      worldApi.core.scene,
      worldApi.terrain,
      WORLD_ID,
      presenceUid,
    )
    mobsManager.setCoinPickupHandler(async (dropId) => {
      const n = await tryClaimMobCoinDrop(WORLD_ID, dropId, presenceUid)
      if (n <= 0) return 0
      mobsManager.removeCoinDropLocal(dropId)
      bumpOptimisticMobCoins(n)
      void removeMobCoinDrop(WORLD_ID, dropId)
      mobCoinFirestorePending += n
      scheduleMobCoinFirestoreFlush(presenceUid)
      return n
    })
    await mobsManager.start()

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
    } else if (restoredPose) {
      applyStoredPoseToCamera(worldApi.core.camera, restoredPose)
      worldApi.control.velocity.set(0, 0, 0)
      worldApi.control.setTouchAnalog(0, 0)
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
    worldApi.control.getMobRaycastRoots = () => mobsManager?.getRaycastRoots() ?? []
    worldApi.control.onPickaxeHitMob = (mobId, dmg) => {
      void mobDamageFromPlayer(WORLD_ID, mobId, dmg, worldApi.terrain)
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

    const mobHitsIgnoreBefore = Date.now()
    unsubMobHits = subscribeMobHitsForVictim(
      WORLD_ID,
      presenceUid,
      (dmg) => {
        worldApi?.control.applyDamageHalfUnits(dmg)
      },
      { ignoreHitsBeforeTs: mobHitsIgnoreBefore },
    )

    unsubSpawnFlags = subscribeSpawnFlags(WORLD_ID, (m) => {
      spawnFlagsMap = m
      syncSpawnFlagMeshes()
    })

    const terrainRegenDebounceMs = bwCpuTight ? 140 : 70
    unsubWorld = subscribeSharedWorldDoc(
      WORLD_ID,
      worldApi.terrain,
      () => {
        if (terrainRegenTimer) clearTimeout(terrainRegenTimer)
        terrainRegenTimer = setTimeout(() => {
          terrainRegenTimer = null
          if (worldApi) regenerateTerrain(worldApi.terrain)
        }, terrainRegenDebounceMs)
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
        hr: 0,
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
    const presenceTickMs = bwCpuTight ? 110 : isLowPowerTouchDevice() ? 88 : 50
    presenceTimer = window.setInterval(() => {
      if (presenceStopped || !worldApi) return
      const uid = auth.user?.uid
      if (!uid) return
      const v = worldApi.control.velocity
      const moving = v.x * v.x + v.y * v.y + v.z * v.z > 0.15
      const idleStride = bwCpuTight ? 3 : isLowPowerTouchDevice() ? 3 : 4
      if (!moving) {
        presenceIdleCounter = (presenceIdleCounter + 1) % idleStride
        if (presenceIdleCounter !== 0) return
      } else {
        presenceIdleCounter = 0
      }
      presencePendingPayload = buildPresencePayload()
      void flushPresenceQueue(WORLD_ID)
    }, presenceTickMs)

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
  window.addEventListener('resize', onVisualViewportChange)
  window.addEventListener('orientationchange', onVisualViewportChange)
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

/** While the world is active: block pinch/page zoom and multi-touch gestures that break play (iOS Safari). */
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

watch(
  () => started.value && !booting.value,
  (playing) => {
    if (playing) installPinchLock()
    else clearPinchLock()
  },
  { immediate: true },
)

onUnmounted(async () => {
  clearPinchLock()
  window.visualViewport?.removeEventListener('resize', onVisualViewportChange)
  window.visualViewport?.removeEventListener('scroll', onVisualViewportChange)
  window.removeEventListener('resize', onVisualViewportChange)
  window.removeEventListener('orientationchange', onVisualViewportChange)
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
      class="fus-bw-exit-app select-none absolute z-[220] rounded-xl border border-white/25 bg-black/55 px-3 py-2 text-xs font-extrabold text-white shadow-lg backdrop-blur-sm active:scale-[0.98] touch-manipulation"
      style="top: max(0.5rem, env(safe-area-inset-top, 0px)); left: 0.5rem"
      @click="exitToApp"
    >
      Вийти
    </button>
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
