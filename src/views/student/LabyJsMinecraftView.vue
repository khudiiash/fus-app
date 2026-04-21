<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import Stats from 'stats.js'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useUserStore } from '@/stores/user'
import { useBlockWorldSession } from '@/stores/blockWorldSession'
import { get, ref as dbRef } from 'firebase/database'
import { rtdb } from '@/firebase/config'
import {
  grantLabyGameplayXp,
  grantLabyMobCoinsCapped,
  grantShopItemByBwSeedKey,
  grantShopSkinBySkinId,
  grantStudentCoinsFromGame,
} from '@/firebase/collections'
import {
  FUS_SHARED_WORLD_LABY_ID,
  ensureSharedWorldSeeds,
  loadLabySharedWorldDoc,
} from '@/firebase/sharedWorldLaby'
import { createLabyWorldAndLoad } from '@/lib/labyEmbedWorld'
import { resolveFusLabyHotbar } from '@/lib/fusLabyHotbarLayout'
import BlockWorldLabyInventoryModal from '@/components/blockWorld/BlockWorldLabyInventoryModal.vue'
import { installFusLabyFpToolHooks } from '@labymc/src/js/net/minecraft/client/fus/FusLabyFpToolHeld.js'
import { normalizeSkinUrlForPresence } from '@/utils/presenceSkinUrl'
import GameProfile from '@labymc/src/js/net/minecraft/util/GameProfile.js'
import Session from '@labymc/src/js/net/minecraft/util/Session.js'
import UUID from '@labymc/src/js/net/minecraft/util/UUID.js'
import PlayerController from '@labymc/src/js/net/minecraft/client/network/controller/PlayerController.js'
import { applyFusPlayerLevelToMinecraft } from '@labymc/src/js/net/minecraft/client/fus/fusLabyLevelStats.js'
import { restoreFusLabySessionOnce } from '@/lib/fusLabySessionPersist'
import { effectiveUserLevelFromProfile } from '@/lib/fusLabyUserLevel.js'
import { FUS_LABY_FLAG_CHANNEL_MS } from '@labymc/src/js/net/minecraft/client/fus/FusLabyFlagChannel.js'

const router = useRouter()
const auth = useAuthStore()
const { user: authFbUser } = storeToRefs(auth)
const userStore = useUserStore()
const bwSession = useBlockWorldSession()

const hostId = 'laby-js-mc-canvas-host'
/** Host for mrdoob/stats.js — set in template */
const statsHostRef = ref(null)
/** @type {Stats | null} */
let fusStats = null
let fusStatsRaf = 0

function mountFusStats() {
  if (typeof window === 'undefined' || fusStats) return
  const host = statsHostRef.value
  if (!host) return
  const s = new Stats()
  s.showPanel(0)
  const dom = s.dom
  dom.style.position = 'relative'
  dom.style.top = 'auto'
  dom.style.left = 'auto'
  host.appendChild(dom)
  fusStats = s
  const tick = () => {
    fusStats?.update()
    fusStatsRaf = window.requestAnimationFrame(tick)
  }
  fusStatsRaf = window.requestAnimationFrame(tick)
}

function unmountFusStats() {
  if (fusStatsRaf) {
    window.cancelAnimationFrame(fusStatsRaf)
    fusStatsRaf = 0
  }
  if (fusStats?.dom?.parentNode) {
    fusStats.dom.parentNode.removeChild(fusStats.dom)
  }
  fusStats = null
}

const error = ref('')
const booting = ref(true)

/**
 * Wait until the first render pass around the player is ready, or until {@code timeoutMs}
 * elapses (whichever comes first). Called before dismissing the opaque boot loader so users
 * don't see a half-meshed terrain "blocks jumping around" flash.
 *
 * Readiness is conservative on purpose: one rAF per check, break out the moment the player's
 * immediate chunk is visible and the rebuild queue has drained below a small threshold. The
 * hard timeout prevents an infinite spinner when an edge-case chunk never finishes meshing.
 *
 * @param {any} mc
 * @param {number} timeoutMs
 */
async function waitForWorldRenderReady(mc, timeoutMs) {
  if (!mc || typeof performance === 'undefined') return
  const deadline = performance.now() + Math.max(500, timeoutMs || 5000)
  /** Require two consecutive ready checks so a transient empty queue doesn't dismiss too early. */
  let streak = 0
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (performance.now() > deadline) return
    const wr = mc.worldRenderer
    const world = mc.world
    if (wr && world && mc.player) {
      try {
        const provider = world.getChunkProvider?.()
        const chunks = provider?.getChunks?.()
        const cx = Math.floor(mc.player.x) >> 4
        const cz = Math.floor(mc.player.z) >> 4
        const center = chunks?.get?.(cx + (cz << 16))
        const queueLen = Array.isArray(wr.chunkSectionUpdateQueue) ? wr.chunkSectionUpdateQueue.length : 0
        const centerReady = !!(center && center.loaded && center.group && center.group.visible !== false)
        if (centerReady && queueLen <= 4) {
          streak++
          if (streak >= 2) return
        } else {
          streak = 0
        }
      } catch (_) {
        /* ignore — retry next frame */
      }
    }
    await new Promise((r) => requestAnimationFrame(() => r(null)))
  }
}

/** @type {import('vue').Ref<import('@labymc/src/js/net/minecraft/client/Minecraft.js').default | null>} */
const gameMc = ref(null)
const showHotbarInventory = ref(false)

/**
 * Desktop (pointer lock): F — прапор, I/0 — інвентар, R — телепорт до прапора (T залишено під чат у грі).
 */
function onLabyInventoryKeydown(e) {
  if (e.repeat) return
  const el = /** @type {HTMLElement | null} */ (e.target)
  if (el?.closest?.('input, textarea, select, [contenteditable="true"]')) return
  const mc = gameMc.value
  if (e.code === 'Digit0' || e.key === '0') {
    e.preventDefault()
    showHotbarInventory.value = !showHotbarInventory.value
  }
  if (e.code === 'KeyI') {
    e.preventDefault()
    showHotbarInventory.value = !showHotbarInventory.value
  }
  if (e.code === 'KeyF') {
    e.preventDefault()
    if (mc && typeof mc.fusPlaceSpawnFlag === 'function') {
      void mc.fusPlaceSpawnFlag()
    }
  }
  if (e.code === 'KeyR') {
    e.preventDefault()
    e.stopPropagation()
    if (mc && typeof mc.fusLabyStartFlagTeleportChannel === 'function') {
      void mc.fusLabyStartFlagTeleportChannel()
    }
  }
}

const labyCoordX = ref(0)
const labyCoordY = ref(0)
const labyCoordZ = ref(0)
/** 0…1 fill for flag teleport channel (engine-driven). */
const flagChannelProgress = ref(0)
/** Interval id for coord ticks — cleared when `gameMc` changes or on unmount */
let labyCoordsIv = 0

const noRtdb = computed(() => !rtdb)

/** Firestore item ids for engine slots 1–8 — mirrors live `mc.fusHotbarSlotMeta` for the inventory UI. */
const liveLabyHotbarItemIds = computed(() => {
  const mc = gameMc.value
  const meta = mc?.fusHotbarSlotMeta
  if (!Array.isArray(meta)) return null
  const out = Array(8).fill('')
  for (let s = 1; s <= 8; s++) {
    const m = meta[s]
    const id = m && typeof m.itemId === 'string' ? m.itemId : ''
    out[s - 1] = id
  }
  return out
})

/** iOS Safari pinch; trackpad pinch (ctrl+wheel); multi-touch — complements `html.fus-laby-play` in `style.css`. */
let _labyDocInteractionCleanup = null

function installLabyDocumentInteractionGuards() {
  if (typeof document === 'undefined') return
  const prevent = (e) => {
    e.preventDefault()
  }
  document.addEventListener('gesturestart', prevent, { passive: false })
  document.addEventListener('gesturechange', prevent, { passive: false })
  document.addEventListener('gestureend', prevent, { passive: false })
  const onWheel = (e) => {
    if (e.ctrlKey) e.preventDefault()
  }
  document.addEventListener('wheel', onWheel, { passive: false })
  /**
   * Safari iOS: double-tap zoom sometimes ignores CSS `touch-action` unless `preventDefault` runs
   * on non-passive touch listeners. The engine also attaches these on the game canvas; this catches
   * touches on the fixed shell (e.g. letterboxing) that never hit the canvas.
   */
  const host = document.getElementById(hostId)
  const touchOpts = { passive: false }
  const blockTouchZoom = (e) => {
    e.preventDefault()
  }
  if (host) {
    host.addEventListener('touchstart', blockTouchZoom, touchOpts)
    host.addEventListener('touchend', blockTouchZoom, touchOpts)
    host.addEventListener('touchmove', blockTouchZoom, touchOpts)
    host.addEventListener('touchcancel', blockTouchZoom, touchOpts)
  }
  _labyDocInteractionCleanup = () => {
    document.removeEventListener('gesturestart', prevent)
    document.removeEventListener('gesturechange', prevent)
    document.removeEventListener('gestureend', prevent)
    document.removeEventListener('wheel', onWheel)
    if (host) {
      host.removeEventListener('touchstart', blockTouchZoom)
      host.removeEventListener('touchend', blockTouchZoom)
      host.removeEventListener('touchmove', blockTouchZoom)
      host.removeEventListener('touchcancel', blockTouchZoom)
    }
    _labyDocInteractionCleanup = null
  }
}

function sanitizeMcUsername(name) {
  const t = (name || '').trim() || 'Student'
  return t.length > 14 ? t.slice(0, 14) : t
}

function resolvePresenceSkinUrl(profile, items) {
  const direct = normalizeSkinUrlForPresence(profile?.avatar?.skinUrl ?? null)
  if (direct) return direct
  const sid = profile?.avatar?.skinId
  if (!sid || sid === 'default' || !items?.length) return null
  const it = items.find((i) => i.skinId === sid || i.id === sid)
  return normalizeSkinUrlForPresence(it?.skinUrl ?? null)
}

function goBack() {
  router.push({ name: 'student-home' })
}

/** Keyboard hints row — fine pointer desktops only (avoids clutter on touch). */
const showDesktopKeyHint = computed(() => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(pointer: fine)').matches
})

/**
 * Per-button tap dedup. The right-action buttons listen to both {@code pointerdown} and
 * {@code click} so taps work on every mobile browser, but that means each tap can fire both
 * handlers back-to-back. A 350 ms cooldown swallows the duplicate without blocking real
 * double-presses.
 */
const _labyBtnLastTapMs = /** @type {Record<string, number>} */ ({})
function _labyBtnCooldown(key) {
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
  const last = _labyBtnLastTapMs[key] || 0
  if (now - last < 350) return true
  _labyBtnLastTapMs[key] = now
  return false
}

async function openLabySettings() {
  if (_labyBtnCooldown('settings')) return
  const mc = gameMc.value
  if (!mc) return
  const { default: GuiOptions } = await import(
    '@labymc/src/js/net/minecraft/client/gui/screens/GuiOptions.js'
  )
  mc.displayScreen(new GuiOptions(null))
}

function placeSpawnFlagAtFeet() {
  if (_labyBtnCooldown('flag')) return
  const mc = gameMc.value
  if (mc && typeof mc.fusPlaceSpawnFlag === 'function') {
    void mc.fusPlaceSpawnFlag()
  }
}

/** Lineage-style channel (~15 s), then teleport — same as {@code KeyR}. */
function startTeleportToFlagChannel() {
  if (_labyBtnCooldown('flagtp')) return
  const mc = gameMc.value
  if (mc && typeof mc.fusLabyStartFlagTeleportChannel === 'function') {
    void mc.fusLabyStartFlagTeleportChannel()
  }
}

function syncHotbarToEngine() {
  const mc = gameMc.value
  if (!mc?.player?.inventory) return
  const uid = auth.profile?.id || ''
  const { engineSlots, slotMeta } = resolveFusLabyHotbar(auth.profile, userStore.items, uid)
  for (let i = 0; i < 9; i++) {
    mc.player.inventory.setItem(i, engineSlots[i] ?? 0)
  }
  mc.fusHotbarSlotMeta = slotMeta
  mc.itemRenderer?.scheduleDirty?.('hotbar')
}

watch(
  () => [auth.profile?.inventory, auth.profile?.id, userStore.items],
  () => {
    if (gameMc.value) syncHotbarToEngine()
  },
  { deep: true },
)

/** Same level as main app profile (XP → {@link calcLevel}); keeps engine + {@code __FUS_MC__.level} in sync when Firestore updates. */
watch(
  () => [auth.profile?.xp, auth.profile?.level, auth.profile?.id],
  () => {
    const mc = gameMc.value
    if (!mc || !auth.profile) return
    const lv = effectiveUserLevelFromProfile(auth.profile)
    applyFusPlayerLevelToMinecraft(mc, lv, false)
    if (typeof window !== 'undefined' && window.__FUS_MC__ && typeof window.__FUS_MC__ === 'object') {
      window.__FUS_MC__.level = lv
    }
  },
  { deep: true },
)

watch(
  () => gameMc.value,
  (mc) => {
    if (labyCoordsIv) {
      window.clearInterval(labyCoordsIv)
      labyCoordsIv = 0
    }
    if (!mc) {
      labyCoordX.value = 0
      labyCoordY.value = 0
      labyCoordZ.value = 0
      flagChannelProgress.value = 0
      return
    }
    const tick = () => {
      const pl = mc.player
      if (pl) {
        labyCoordX.value = Math.floor(pl.x)
        labyCoordY.value = Math.floor(pl.y)
        labyCoordZ.value = Math.floor(pl.z)
      }
      const endAt = mc.fusLabyFlagChannelEndAt
      const now = Date.now()
      if (typeof endAt === 'number' && endAt > now) {
        const p = 1 - (endAt - now) / FUS_LABY_FLAG_CHANNEL_MS
        flagChannelProgress.value = Math.min(1, Math.max(0, p))
      } else {
        flagChannelProgress.value = 0
      }
    }
    tick()
    labyCoordsIv = window.setInterval(tick, 220)
  },
  { immediate: true },
)

onMounted(async () => {
  error.value = ''
  booting.value = true
  gameMc.value = null
  bwSession.setImmersive(true)
  if (typeof document !== 'undefined') {
    document.documentElement.classList.add('fus-laby-play')
  }

  const base = `${import.meta.env.BASE_URL || '/'}`.replace(/\/?$/, '/')
  window.__LABY_MC_ASSET_BASE__ = `${base}labyminecraft/`
  window.__LABY_MC_FUS_EMBED__ = true

  window.__fusLabyOpenHotbarExtras = () => {
    showHotbarInventory.value = true
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', onLabyInventoryKeydown, true)
  }

  installLabyDocumentInteractionGuards()

  try {
    await auth.init()
    if (!userStore.items.length) await userStore.fetchItems()

    const uid = authFbUser.value?.uid || auth.profile?.id
    if (!uid) {
      error.value = 'Увійдіть, щоб грати'
      return
    }

    window.__FUS_GRANT_LABY_XP__ = async (amount, meta) => {
      const myUid = authFbUser.value?.uid || auth.profile?.id
      const killerUid = meta && typeof meta.killerUid === 'string' ? meta.killerUid : ''
      if (!myUid || killerUid !== myUid || amount == null) return
      try {
        const label =
          meta && typeof meta.mobType === 'string'
            ? `Лабі-світ — ${meta.mobType}`
            : 'Лабі-світ — моб'
        await grantLabyGameplayXp(auth.profile?.id, Number(amount), label)
      } catch (e) {
        console.warn('[LabyJsMinecraftView] grant xp', e)
      }
    }

    window.__FUS_GRANT_LOOT__ = async (payload) => {
      const u = auth.profile?.id
      if (!u || !payload || typeof payload !== 'object') return
      const kind = payload.kind
      if (kind === 'coins' && payload.coins != null) {
        const amt = Number(payload.coins)
        if (payload.source === 'pk') {
          await grantStudentCoinsFromGame(u, amt, 'PK — здобич')
        } else {
          await grantLabyMobCoinsCapped(u, amt, 'Лабі — здобич з мобів')
        }
      } else if (kind === 'item' && payload.bwSeedKey) {
        await grantShopItemByBwSeedKey(u, String(payload.bwSeedKey))
        await userStore.fetchItems()
      } else if (kind === 'skin' && payload.skinId) {
        await grantShopSkinBySkinId(u, String(payload.skinId))
        await userStore.fetchItems()
      }
    }

    const skinUrl = resolvePresenceSkinUrl(auth.profile, userStore.items)
    const labyLevel = effectiveUserLevelFromProfile(auth.profile)
    window.__FUS_MC__ = {
      worldId: FUS_SHARED_WORLD_LABY_ID,
      uid,
      displayName: auth.profile?.displayName || 'Гравець',
      skinUrl: skinUrl || undefined,
      level: labyLevel,
      /** Vite dev: fast mob respawn + no mob damage (see FusMobSync / FusLabyCombat). */
      dev: import.meta.env.DEV === true,
    }

    const [, startMod] = await Promise.all([
      ensureSharedWorldSeeds(FUS_SHARED_WORLD_LABY_ID),
      import('@labymc/src/js/Start.js'),
    ])
    const { default: Start } = startMod
    const start = new Start()
    const mc = await start.launch(hostId)
    gameMc.value = mc
    /**
     * Freeze the engine until boot completes — prevents touch drags from spinning the camera,
     * dropped block clicks, and mob AI / world ticks from burning CPU behind the loader spinner.
     * Cleared in the `finally` block below after world + spawn flag + skin are all loaded.
     */
    mc.fusFrozen = true

    installFusLabyFpToolHooks(mc)

    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
    const isIosSafari =
      /iPad|iPhone|iPod/.test(ua) ||
      (typeof navigator !== 'undefined' &&
        navigator.platform === 'MacIntel' &&
        navigator.maxTouchPoints > 1)
    const isAndroid = /Android/i.test(ua)
    /**
     * Any touch mobile device under 8 hardware cores is treated as "strained" — AI/LOD/LOS
     * throttles hit the same hot paths that the iOS build already paths through (see
     * {@link FusMobSync}, {@link WorldRenderer}). User report: "android got very bad" while
     * iOS was fine → Android was taking the relaxed desktop path. Flip it to the iOS path.
     */
    const hwCores =
      typeof navigator !== 'undefined' && Number.isFinite(Number(navigator.hardwareConcurrency))
        ? Number(navigator.hardwareConcurrency)
        : 8
    const strainedAndroid = isAndroid && hwCores <= 8
    if (isIosSafari) {
      mc.fusIosSafari = true
      mc.fusLowTierMobile = true
    } else if (isAndroid) {
      mc.fusLowTierMobile = true
      if (strainedAndroid) {
        /**
         * Route Android through the same ultra-strict throttle constants as iOS Safari. All the
         * hot paths test {@code fusIosSafari} as the "be very conservative" switch; using it as
         * a "strained mobile" flag avoids adding a third tier everywhere.
         */
        mc.fusIosSafari = true
      }
    }

    if (mc.settings) {
      /**
       * First-ever launch on this device gets a safe default per tier; thereafter we respect the
       * user's saved `viewDistance` (they can crank it up or down via the in-game Settings screen
       * and it persists through {@link GameSettings#save}).
       */
      const FUS_VD_INITIALIZED_KEY = 'fus:viewDistanceInitialized:v1'
      let hasInit = false
      try {
        hasInit = !!(typeof localStorage !== 'undefined' && localStorage.getItem(FUS_VD_INITIALIZED_KEY))
      } catch {
        /* ignore */
      }
      if (!hasInit) {
        const vdCap = isIosSafari ? 2 : isAndroid ? 3 : 4
        mc.settings.viewDistance = vdCap
        try {
          mc.settings.save?.()
          if (typeof localStorage !== 'undefined') {
            localStorage.setItem(FUS_VD_INITIALIZED_KEY, '1')
          }
        } catch {
          /* ignore */
        }
      }
    }

    mc.worldRenderer?.applyFusMobileGraphicsProfile?.()

    const displayName = sanitizeMcUsername(auth.profile?.displayName ?? 'Student')
    mc.setSession(new Session(new GameProfile(UUID.randomUUID(), displayName), ''), false)

    const { seeds, labySpawn } = await loadLabySharedWorldDoc(FUS_SHARED_WORLD_LABY_ID)
    if (!seeds) {
      error.value = 'Не вдалося завантажити seeds світу'
      return
    }

    mc.playerController = new PlayerController(mc)
    await createLabyWorldAndLoad(mc, seeds, labySpawn)
    if (!mc.world) {
      error.value = 'Світ не ініціалізовано'
      return
    }

    /** First ~10s: defer distant RTDB cell applies on embed (nearest-first still streams; see FusRtdbBlocks). */
    if (typeof performance !== 'undefined') {
      mc._fusTerrainBootUntil = performance.now() + 10000
    }

    syncHotbarToEngine()
    mc.player.inventory.selectedSlotIndex = 0

    if (rtdb) {
      try {
        const snap = await get(dbRef(rtdb, `worldSpawnFlags/${FUS_SHARED_WORLD_LABY_ID}/${uid}`))
        if (snap.exists()) {
          const f = snap.val()
          const x = Number(f.x)
          const y = Number(f.y)
          const z = Number(f.z)
          if ([x, y, z].every((n) => Number.isFinite(n))) {
            mc.fusSpawnFlagPos = { x, y, z }
            mc.player.setPosition(x, y, z)
          }
        }
      } catch (e) {
        console.warn('[LabyJsMinecraftView] spawn flag load', e)
      }
    }

    applyFusPlayerLevelToMinecraft(mc, effectiveUserLevelFromProfile(auth.profile))
    restoreFusLabySessionOnce(mc, FUS_SHARED_WORLD_LABY_ID)

    mc.player.fusSkinUrl = skinUrl || null
    if (skinUrl && typeof mc.ensureFusSkinTexture === 'function') {
      mc.ensureFusSkinTexture(skinUrl, () => {
        try {
          mc.player?.renderer?.prepareModel?.(mc.player)
        } catch (_) {
          /* ignore */
        }
      })
    }

    /**
     * Hold the opaque loader until the world actually has frame-ready terrain around the
     * player (or until the 5 s hard cap elapses — UX research: anything longer and users bail).
     *
     * "Frame-ready" means both:
     *   • at least one chunk around the player has been meshed, and
     *   • the initial rebuild queue has drained below a few sections (otherwise you see the
     *     "blue sky with block outlines jumping" effect the user reported).
     *
     * We keep {@code fusFrozen} until this completes so mob AI + input don't eat CPU budget
     * that chunk uploads desperately need. Unfreezing even a couple frames early is visible.
     */
    await waitForWorldRenderReady(mc, 5000)
  } catch (e) {
    console.warn('[LabyJsMinecraftView]', e)
    error.value = e?.message || 'Помилка запуску'
  } finally {
    /** Release the engine first so the first unfrozen frame already has terrain. */
    const mc = gameMc.value
    if (mc) {
      mc.fusFrozen = false
    }
    booting.value = false
  }
  await nextTick()
    mountFusStats()
})

onBeforeUnmount(() => {
  unmountFusStats()
  if (typeof window !== 'undefined') {
    window.removeEventListener('keydown', onLabyInventoryKeydown, true)
  }
  if (labyCoordsIv) {
    window.clearInterval(labyCoordsIv)
    labyCoordsIv = 0
  }
  _labyDocInteractionCleanup?.()
  if (typeof document !== 'undefined') {
    document.documentElement.classList.remove('fus-laby-play')
  }
  bwSession.setImmersive(false)
  try {
    delete window.__FUS_MC__
  } catch {
    window.__FUS_MC__ = undefined
  }
  try {
    delete window.__LABY_MC_FUS_EMBED__
  } catch {
    window.__LABY_MC_FUS_EMBED__ = undefined
  }
  try {
    delete window.__LABY_MC_ASSET_BASE__
  } catch {
    window.__LABY_MC_ASSET_BASE__ = undefined
  }
  try {
    delete window.__fusLabyOpenHotbarExtras
  } catch {
    window.__fusLabyOpenHotbarExtras = undefined
  }
  try {
    delete window.__FUS_GRANT_LOOT__
  } catch {
    window.__FUS_GRANT_LOOT__ = undefined
  }
  try {
    delete window.__FUS_GRANT_LABY_XP__
  } catch {
    window.__FUS_GRANT_LABY_XP__ = undefined
  }

  const mc = gameMc.value
  gameMc.value = null
  if (!mc) return
  try {
    mc.loadWorld(null)
  } catch (e) {
    console.warn('[LabyJsMinecraftView] loadWorld(null)', e)
  }
  try {
    mc.stop()
  } catch (e) {
    console.warn('[LabyJsMinecraftView] stop', e)
  }
})
</script>

<template>
  <div class="laby-page">
    <div v-if="booting" class="laby-boot" aria-busy="true">
      <div class="laby-boot-spinner" />
      <p class="laby-boot-text">Завантаження світу…</p>
    </div>
    <p v-if="error" class="laby-err">{{ error }}</p>
    <p v-if="noRtdb" class="laby-warn">
      Немає Realtime Database (<code>VITE_FIREBASE_DATABASE_URL</code>) — спільні блоки та присутність інших гравців
      можуть не працювати.
    </p>

    <div class="laby-bar">
      <button type="button" class="laby-back" @click="goBack">← Назад</button>
    </div>

    <div
      v-if="gameMc && !booting && !error"
      class="laby-right-actions"
    >
      <button
        type="button"
        class="laby-settings"
        :title="showDesktopKeyHint ? 'Налаштування' : ''"
        aria-label="Налаштування"
        @pointerdown.stop.prevent="openLabySettings"
        @click.stop.prevent="openLabySettings"
      >
        <span class="laby-btn-icon">⚙</span>
      </button>
      <button
        type="button"
        class="laby-flag-place"
        :title="showDesktopKeyHint ? 'Прапор (F)' : ''"
        aria-label="Поставити прапор"
        @pointerdown.stop.prevent="placeSpawnFlagAtFeet"
        @click.stop.prevent="placeSpawnFlagAtFeet"
      >
        <span class="laby-btn-icon">🚩</span>
        <span v-if="showDesktopKeyHint" class="laby-btn-key">F</span>
      </button>
      <button
        type="button"
        class="laby-flag-tp"
        :title="showDesktopKeyHint ? 'До прапора (R)' : ''"
        aria-label="Телепорт до прапора"
        @pointerdown.stop.prevent="startTeleportToFlagChannel"
        @click.stop.prevent="startTeleportToFlagChannel"
      >
        <span class="laby-btn-icon">✈</span>
        <span v-if="showDesktopKeyHint" class="laby-btn-key">R</span>
      </button>
    </div>

    <div
      v-if="gameMc && !booting && !error && showDesktopKeyHint"
      class="laby-key-hint"
      aria-live="polite"
    >
      <span>F — прапор</span>
      <span>I / 0 — інвентар</span>
      <span>R — телепорт до прапора</span>
    </div>

    <div
      v-if="gameMc && !booting && !error && flagChannelProgress > 0"
      class="laby-tp-channel"
      aria-hidden="true"
    >
      <div class="laby-tp-label">Телепорт</div>
      <div class="laby-tp-track">
        <div class="laby-tp-fill" :style="{ width: `${flagChannelProgress * 100}%` }" />
      </div>
    </div>

    <div
      v-if="gameMc && !booting && !error"
      class="laby-coords"
      aria-hidden="true"
    >
      {{ labyCoordX }} {{ labyCoordY }} {{ labyCoordZ }}
    </div>

    <div ref="statsHostRef" class="laby-stats" aria-hidden="true" />

    <BlockWorldLabyInventoryModal
      v-model="showHotbarInventory"
      :uid="auth.profile?.id || ''"
      :profile="auth.profile"
      :shop-items="userStore.items"
      :live-hotbar-item-ids="liveLabyHotbarItemIds"
      :game-mc="gameMc"
      @saved="syncHotbarToEngine"
    />

    <div :id="hostId" class="laby-host" />
  </div>
</template>

<style scoped>
.laby-page {
  position: fixed;
  inset: 0;
  z-index: 60;
  background: #020617;
  touch-action: none;
  overscroll-behavior: none;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
}
.laby-stats {
  position: absolute;
  left: 8px;
  bottom: 8px;
  z-index: 42;
  pointer-events: none;
  line-height: 0;
}
.laby-host {
  position: absolute;
  inset: 0;
  z-index: 1;
  width: 100%;
  height: 100%;
  touch-action: none;
  overscroll-behavior: none;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
}
.laby-key-hint {
  position: absolute;
  left: 10px;
  bottom: 52px;
  z-index: 43;
  max-width: min(380px, 94vw);
  display: flex;
  flex-direction: column;
  gap: 4px;
  pointer-events: none;
  font-size: 11px;
  font-weight: 600;
  color: rgba(203, 213, 225, 0.92);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.65);
  line-height: 1.35;
}
.laby-tp-channel {
  position: absolute;
  left: 50%;
  bottom: 72px;
  transform: translateX(-50%);
  z-index: 44;
  width: min(320px, 86vw);
  pointer-events: none;
}
.laby-tp-label {
  font-size: 11px;
  font-weight: 700;
  color: rgba(226, 232, 240, 0.92);
  text-align: center;
  margin-bottom: 6px;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);
}
.laby-tp-track {
  height: 10px;
  border-radius: 999px;
  background: rgba(15, 23, 42, 0.82);
  border: 1px solid rgba(129, 140, 248, 0.35);
  overflow: hidden;
}
.laby-tp-fill {
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, #6366f1, #38bdf8);
  box-shadow: 0 0 12px rgba(99, 102, 241, 0.45);
  transition: width 0.12s linear;
}
.laby-coords {
  position: absolute;
  top: 48px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 35;
  pointer-events: none;
  font-size: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: rgba(226, 232, 240, 0.88);
  text-align: center;
  line-height: 1.2;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.65);
  white-space: nowrap;
}
.laby-bar {
  position: absolute;
  top: 10px;
  left: 10px;
  z-index: 40;
  pointer-events: none;
}
.laby-back {
  pointer-events: auto;
  user-select: none;
  -webkit-user-select: none;
  padding: 8px 14px;
  border-radius: 12px;
  font-size: 13px;
  font-weight: 800;
  color: #e2e8f0;
  background: rgba(15, 23, 42, 0.75);
  border: 1px solid rgba(148, 163, 184, 0.25);
  cursor: pointer;
}
.laby-back:hover {
  background: rgba(30, 41, 59, 0.9);
}
.laby-right-actions {
  position: absolute;
  top: 10px;
  right: 10px;
  z-index: 40;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  pointer-events: none;
}
.laby-settings,
.laby-flag-place,
.laby-flag-tp {
  pointer-events: auto;
  user-select: none;
  -webkit-user-select: none;
  /**
   * Mobile-tappable: the parent .laby-page has touch-action:none so movement & look don't
   * scroll the page; that also suppressed synthetic click events on descendant buttons in
   * iOS Safari and some Android browsers — "settings button is not clickable on mobile".
   * touch-action:manipulation re-enables tap-to-click while still disabling pinch-zoom.
   */
  touch-action: manipulation;
  -webkit-tap-highlight-color: rgba(255, 255, 255, 0.2);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-width: 48px;
  min-height: 44px;
  padding: 0 12px;
  border-radius: 12px;
  font-size: 20px;
  font-weight: 800;
  line-height: 1;
  color: #e2e8f0;
  background: rgba(15, 23, 42, 0.78);
  border: 1px solid rgba(148, 163, 184, 0.28);
  cursor: pointer;
}
.laby-btn-icon {
  font-size: 20px;
  line-height: 1;
}
.laby-btn-key {
  font-size: 11px;
  font-weight: 700;
  color: #cbd5e1;
  background: rgba(148, 163, 184, 0.25);
  border-radius: 6px;
  padding: 2px 6px;
  line-height: 1;
}
.laby-settings:hover,
.laby-flag-place:hover,
.laby-flag-tp:hover {
  background: rgba(30, 41, 59, 0.92);
}
.laby-settings:active,
.laby-flag-place:active,
.laby-flag-tp:active {
  background: rgba(51, 65, 85, 0.95);
  transform: scale(0.97);
}
.laby-boot {
  position: absolute;
  inset: 0;
  /**
   * Opaque: sits above the canvas (z-index 25 > 1) and hides the half-meshed terrain that would
   * otherwise flash "blue sky with block outlines" during boot. User request: no see-through
   * loader — nothing of the WIP scene should be visible until world is render-ready.
   */
  z-index: 30;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  background: #0f172a;
  pointer-events: auto;
}
.laby-boot-spinner {
  width: 40px;
  height: 40px;
  border-radius: 999px;
  border: 3px solid rgba(148, 163, 184, 0.25);
  border-top-color: #a78bfa;
  animation: laby-spin 0.85s linear infinite;
}
.laby-boot-text {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
  color: #cbd5e1;
}
@keyframes laby-spin {
  to {
    transform: rotate(360deg);
  }
}
.laby-err {
  position: absolute;
  top: 52px;
  left: 12px;
  right: 12px;
  z-index: 28;
  margin: 0;
  padding: 10px 12px;
  border-radius: 12px;
  font-size: 13px;
  font-weight: 600;
  color: #fecaca;
  background: rgba(127, 29, 29, 0.45);
  border: 1px solid rgba(248, 113, 113, 0.35);
}
.laby-warn {
  position: absolute;
  bottom: 10px;
  left: 10px;
  right: 10px;
  z-index: 28;
  margin: 0;
  padding: 8px 10px;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 600;
  color: #fde68a;
  background: rgba(113, 63, 18, 0.45);
  border: 1px solid rgba(251, 191, 36, 0.35);
}
.laby-warn code {
  font-size: 10px;
}
</style>
