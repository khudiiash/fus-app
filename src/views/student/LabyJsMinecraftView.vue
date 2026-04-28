<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import Stats from 'stats.js'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useUserStore } from '@/stores/user'
import { useBlockWorldSession } from '@/stores/blockWorldSession'
import { get, onValue, ref as dbRef } from 'firebase/database'
import { rtdb } from '@/firebase/config'
import {
  calcLevel,
  debitPkLootFromUser,
  debitPvpCoinFromUser,
  grantLabyGameplayXp,
  grantLabyMobKillPayout,
  grantLabyMobCoinsCapped,
  grantShopItemByBwSeedKey,
  grantShopSkinBySkinId,
  grantStudentCoinsFromGame,
} from '@/firebase/collections'
import { clearLabySharedWorldMobsRtdb } from '@/firebase/labyMobsRtdb'
import {
  FUS_SHARED_WORLD_LABY_ID,
  ensureSharedWorldSeeds,
  loadLabySharedWorldDoc,
} from '@/firebase/sharedWorldLaby'
import { createLabyWorldAndLoad } from '@/lib/labyEmbedWorld'
import { fusLabyFeetYAtColumn } from '@/lib/fusLabySpawnFeet'
import { resolveFusLabyHotbar } from '@/lib/fusLabyHotbarLayout'
import BlockWorldLabyInventoryModal from '@/components/blockWorld/BlockWorldLabyInventoryModal.vue'
import LabyMobileControls from '@/components/laby/LabyMobileControls.vue'
import { installFusLabyFpToolHooks } from '@labymc/src/js/net/minecraft/client/fus/FusLabyFpToolHeld.js'
import { installFusFpToolTuningGui } from '@labymc/src/js/net/minecraft/client/fus/FusFpToolTuningGui.js'
import { installFusTpToolTuningGui } from '@labymc/src/js/net/minecraft/client/fus/FusTpToolTuningGui.js'
import { normalizeSkinUrlForPresence } from '@/utils/presenceSkinUrl'
import FocusStateType from '@labymc/src/js/net/minecraft/util/FocusStateType.js'
import GameProfile from '@labymc/src/js/net/minecraft/util/GameProfile.js'
import Session from '@labymc/src/js/net/minecraft/util/Session.js'
import UUID from '@labymc/src/js/net/minecraft/util/UUID.js'
import PlayerController from '@labymc/src/js/net/minecraft/client/network/controller/PlayerController.js'
import { applyFusPlayerLevelToMinecraft } from '@labymc/src/js/net/minecraft/client/fus/fusLabyLevelStats.js'
import {
  flushFusLabySessionToStorage,
  restoreFusLabySessionOnce,
  tickPersistFusLabySession,
} from '@/lib/fusLabySessionPersist'
import {
  FUS_LABY_VIEW_MAX,
  FUS_LABY_VIEW_MIN,
  applyFusLabyViewDistanceFromStorage,
  installFusLabyViewDistanceSaveHook,
} from '@/lib/fusLabyViewDistance'
import { effectiveUserLevelFromProfile } from '@/lib/fusLabyUserLevel.js'
import { labyDisplayNameForMobDropBwKey } from '@/lib/fusLabyMobDropLabels.js'
import { useToast } from '@/composables/useToast'
import { FUS_LABY_FLAG_CHANNEL_MS } from '@labymc/src/js/net/minecraft/client/fus/FusLabyFlagChannel.js'
import { installFusLabySpawnFlag } from '@/lib/fusLabySpawnFlagInstall'
import { installFusSkinLoader } from '@/lib/fusSkinLoaderInstall'
import { installFusSimpleMobs } from '@/lib/fusSimpleMobsInstall'
import { installFusPlayerCombat } from '@/lib/fusPlayerCombatInstall'
import { installFusAutoJump } from '@/lib/fusAutoJumpInstall'
import { installFusBlockHardness } from '@/lib/fusBlockHardnessInstall'
import { installFusDamageFlash } from '@/lib/fusDamageFlashInstall'
import { installFusPvpKarma } from '@/lib/fusPvpKarmaInstall'
import { installFusWorldDrops } from '@/lib/fusWorldDropsInstall'
import { installFusWaterFlow } from '@/lib/fusWaterFlowInstall'
import { installFusWorldEditsRtdb } from '@/lib/fusWorldEditsRtdbInstall'
import { installFusSpawnInvuln } from '@/lib/fusSpawnInvulnInstall'
import { installFusPresenceWriter } from '@/lib/fusPresenceWriterInstall'
import { installFusRemoteAvatars } from '@/lib/fusRemoteAvatarsInstall'
import { installFusHealthRegen } from '@/lib/fusHealthRegenInstall'
import { installFusDeathScreen } from '@/lib/fusDeathScreenInstall'
import { installFusCombatFx } from '@/lib/fusCombatFxInstall'

const router = useRouter()
const auth = useAuthStore()
const { user: authFbUser } = storeToRefs(auth)
const userStore = useUserStore()
const bwSession = useBlockWorldSession()
const { success: toastLabySuccess, info: toastLabyInfo } = useToast()

const isLabyDev = import.meta.env.DEV
const hostId = 'laby-js-mc-canvas-host'
/** Host for mrdoob/stats.js — set in template */
const statsHostRef = ref(null)
/** @type {Stats | null} */
let fusStats = null
let fusStatsRaf = 0

function mountFusStats() {
  if (!isLabyDev || typeof window === 'undefined' || fusStats) return
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
const booting = ref(false)
/** Set true when the user taps “Вхід” to begin the heavy load. */
const labyPlayStarted = ref(false)
/** Root container for the Laby shell (canvas + HUD). */
const labyPageRef = ref(/** @type {HTMLElement | null} */ (null))

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
/** True while the engine shows a 2D screen (e.g. legacy canvas UI if any). */
const labyEngineGuiOpen = ref(false)
/** FUS: Ukrainian HTML settings panel (replaces canvas GuiOptions in Laby). */
const labyHtmlSettingsOpen = ref(false)
const labyHudBlocked = computed(() => labyEngineGuiOpen.value || labyHtmlSettingsOpen.value)
/** Synced for the fullscreen button label. */
const labyPageFullscreen = ref(false)
/** iOS Safari often lacks a working Fullscreen API; we expand the play layer to the viewport. */
const labyPseudoPageFullscreen = ref(false)
/** Form mirrors {@code mc.settings} while the HTML panel is open. */
const labySetAmbientOcclusion = ref(false)
const labySetViewBobbing = ref(false)
const labySetFov = ref(70)
const labySetViewDistance = ref(5)

let _labyFsListener = null

function fusLabyIsNativePageFullscreen() {
  if (typeof document === 'undefined') return false
  const d = document
  return Boolean(
    d.fullscreenElement || d.webkitFullscreenElement || d.mozFullScreenElement || d.msFullscreenElement,
  )
}

function fusLabyIsPageFullscreen() {
  return fusLabyIsNativePageFullscreen() || labyPseudoPageFullscreen.value
}

function fusLabySyncFullscreenState() {
  labyPageFullscreen.value = fusLabyIsPageFullscreen()
}

async function fusLabyTogglePageFullscreen() {
  if (typeof document === 'undefined') return
  const doc = document

  if (fusLabyIsNativePageFullscreen()) {
    const exit = doc.exitFullscreen || doc.webkitExitFullscreen || doc.mozCancelFullScreen || doc.msExitFullscreen
    try {
      exit?.call(doc)
    } catch {
      /* ignore */
    }
    fusLabySyncFullscreenState()
    return
  }
  if (labyPseudoPageFullscreen.value) {
    labyPseudoPageFullscreen.value = false
    fusLabySyncFullscreenState()
    return
  }

  const tryFullscreen = async (el) => {
    if (!el) return false
    const req =
      el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen
    if (typeof req !== 'function') return false
    try {
      const p = req.call(el)
      if (p && typeof p.then === 'function') await p
      return fusLabyIsNativePageFullscreen()
    } catch {
      return false
    }
  }

  let ok = await tryFullscreen(doc.documentElement)
  if (!ok) ok = await tryFullscreen(labyPageRef.value)
  if (!ok) labyPseudoPageFullscreen.value = true
  fusLabySyncFullscreenState()
}

function syncLabySettingsFormFromMc() {
  const mc = gameMc.value
  const s = mc?.settings
  if (!s) return
  labySetAmbientOcclusion.value = Boolean(s.ambientOcclusion)
  labySetViewBobbing.value = Boolean(s.viewBobbing)
  labySetFov.value = Math.max(50, Math.min(100, Math.round(Number(s.fov) || 70)))
  const vd = Math.round(Number(s.viewDistance) || FUS_LABY_VIEW_MIN)
  labySetViewDistance.value = Math.max(FUS_LABY_VIEW_MIN, Math.min(FUS_LABY_VIEW_MAX, vd))
  fusLabySyncFullscreenState()
}

function closeLabyHtmlSettings() {
  const mc = gameMc.value
  labyHtmlSettingsOpen.value = false
  if (mc?.settings) {
    try {
      /** Sliders may not have fired `change` yet — sync latest UI values before save. */
      mc.settings.fov = labySetFov.value
      mc.settings.viewDistance = labySetViewDistance.value
      mc.settings.save()
    } catch {
      /* ignore */
    }
  }
  const w = mc?.window
  if (w) {
    /**
     * After HTML settings, the browser may still be in a pointer-lock retry cooldown, or
     * `mouseInsideWindow` may be false until the user moves (game won’t re-request lock).
     * Unblock the next canvas click and finish any {@code REQUEST_EXIT} → {@code EXITTED} transition.
     */
    if (typeof w._fusPlRetryNotBefore === 'number') {
      w._fusPlRetryNotBefore = 0
    }
    w.mouseInsideWindow = true
    if (w.focusState === FocusStateType.REQUEST_EXIT) {
      try {
        w.updateFocusState(FocusStateType.EXITTED)
      } catch {
        /* ignore */
      }
    }
  }
  void nextTick(() => {
    if (w && typeof w.requestCursorUpdate === 'function') {
      try {
        w.requestCursorUpdate()
      } catch {
        /* ignore */
      }
    }
  })
}

/** Pointer-lock captures the mouse on desktop, so HTML buttons in the shell (place-flag,
 *  teleport, settings, inventory, respawn) are effectively unclickable without releasing
 *  the lock first. We release it whenever we open an overlay UI from a keybind; when the
 *  user closes the overlay the engine re-acquires the lock on the next canvas click.
 *  {@link document.exitPointerLock} alone is not enough: {@code GameWindow.requestCursorUpdate}
 *  re-requests the lock on the next event while focus state is still {@code LOCKED}. */
function releaseDesktopPointerLock(mc) {
  const w = mc?.window
  if (w && typeof w.updateFocusState === 'function') {
    try {
      w.updateFocusState(FocusStateType.REQUEST_EXIT)
    } catch {
      /* ignore */
    }
    return
  }
  if (typeof document === 'undefined') return
  const exit = document.exitPointerLock || document.webkitExitPointerLock
  if (typeof exit === 'function') {
    try {
      exit.call(document)
    } catch {
      /* ignore */
    }
  }
}

/** Wait until the browser has released pointer lock (needed before showing HTML range sliders on PC). */
function waitForPointerLockRelease() {
  if (typeof document === 'undefined') return Promise.resolve()
  if (!document.pointerLockElement) return Promise.resolve()
  return new Promise((resolve) => {
    const maxMs = 800
    function cleanup() {
      clearTimeout(tid)
      document.removeEventListener('pointerlockchange', onPlc)
    }
    function onPlc() {
      if (!document.pointerLockElement) {
        cleanup()
        resolve()
      }
    }
    const tid = window.setTimeout(() => {
      cleanup()
      resolve()
    }, maxMs)
    document.addEventListener('pointerlockchange', onPlc)
  })
}

/** Toggles the Vue block-world inventory; assigned to `window.__FUS_LABY_TOGGLE_INVENTORY__` so
 *  `Minecraft.onKeyPressed` (default KeyE) opens the same UI instead of the canvas
 *  `GuiContainerCreative` (which bypassed modal layout/CSS). */
function toggleLabyBlockInventory() {
  const nextOpen = !showHotbarInventory.value
  showHotbarInventory.value = nextOpen
  if (nextOpen) releaseDesktopPointerLock(gameMc.value)
}

/**
 * Desktop: **K** відкриває HTML-налаштування (після зняття pointer lock). **Esc** тільки знімає
 * захоплення курсора / закриває оверлеї, без відкриття меню (раніше Esc+другий клік плодив баги).
 * (F прапор, R телепорт, I/0 інвентар, T чат, Space/Enter респавн.)
 */
function onLabyInventoryKeydown(e) {
  if (e.repeat) return
  const mc = gameMc.value
  if (!labyPlayStarted.value) {
    e.preventDefault()
    e.stopPropagation()
    if (e.code === 'Escape') {
      goBack()
    }
    return
  }

  /** Close overlays on Esc first (incl. when focus is inside a range / checkbox in those modals). */
  if (e.code === 'Escape') {
    if (showHotbarInventory.value) {
      e.preventDefault()
      e.stopImmediatePropagation()
      showHotbarInventory.value = false
      return
    }
    if (labyHtmlSettingsOpen.value) {
      e.preventDefault()
      e.stopImmediatePropagation()
      closeLabyHtmlSettings()
      return
    }
  }

  const el = /** @type {HTMLElement | null} */ (e.target)
  if (el?.closest?.('input, textarea, select, [contenteditable="true"]')) return

  if (e.code === 'Escape') {
    if (mc && mc.currentScreen !== null) {
      e.preventDefault()
      e.stopImmediatePropagation()
      mc.displayScreen(null)
      return
    }
    if (mc) {
      e.preventDefault()
      e.stopImmediatePropagation()
      releaseDesktopPointerLock(mc)
    }
    return
  }
  if (e.code === 'Digit0' || e.key === '0') {
    e.preventDefault()
    toggleLabyBlockInventory()
  }
  const invKey = mc?.settings?.keyOpenInventory || 'KeyE'
  if (e.code === 'KeyI' && invKey !== 'KeyI') {
    e.preventDefault()
    toggleLabyBlockInventory()
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
  if (e.code === 'KeyP' && rtdb) {
    e.preventDefault()
    e.stopPropagation()
    labyToggleOnlinePanel()
  }
  if (e.code === 'KeyK' && mc && mc.currentScreen === null) {
    e.preventDefault()
    e.stopImmediatePropagation()
    void openLabySettings()
    return
  }
  if (e.code === 'F7') {
    /** Developer hotkey for the FP tool tuning dat.gui panel. The panel mutates
     *  {@link fusFpToolTuning} live (position/scale/rotation of the held tool in first
     *  person) and calls `mc.fusBumpFpToolGltfRebuild()` on each tweak so changes show
     *  up next frame. Toggle so repeat presses close it without rebuilding from scratch
     *  — keeps tuned values across multiple debug sessions in the same page load. */
    e.preventDefault()
    e.stopPropagation()
    if (mc) {
      if (mc._fusFpToolTuningGui) {
        try {
          mc._fusFpToolTuningGui.domElement?.remove?.()
        } catch {
          /* ignore */
        }
        try {
          mc._fusFpToolTuningGui.destroy?.()
        } catch {
          /* ignore */
        }
        mc._fusFpToolTuningGui = null
      } else {
        //installFusFpToolTuningGui(mc)
      }
    }
  }
}

const labyCoordX = ref(0)
const labyCoordY = ref(0)
const labyCoordZ = ref(0)
/** 0…1 fill for flag teleport channel (engine-driven). */
const flagChannelProgress = ref(0)
/** Live PvP mode + karma count for the HUD. Driven off {@code mc.fusPvpSelfState} via the
 *  same 250 ms poll that updates the coord readout — cheap and avoids plumbing a
 *  reactive bridge through the karma installer. User spec: "we need to display Karma
 *  count". */
const labyPvpMode = ref('white')
const labyKarma = ref(0)
/** Peers in {@code worldPresence} for the shared Laby world (excluding self, stale, left). */
/** @type {import('vue').Ref<{ uid: string, name: string, x: number, y: number, z: number }[]>} */
const labyOnlinePeers = ref([])
const labyShowOnlinePanel = ref(false)
const labyOnlineCount = computed(() => labyOnlinePeers.value.length)

const LABY_PRESENCE_STALE_MS = 30_000
/** Latest RTDB feet coords per uid (for mid-channel updates — teleport completes ~15s after tap). */
const lastLabyPeerWorldByUid = new Map()
/** @type {null | (() => void)} */
let labyWorldPresenceUnsub = null

function bindLabyWorldPresenceRoster() {
  labyWorldPresenceUnsub?.()
  labyWorldPresenceUnsub = null
  labyOnlinePeers.value = []
  lastLabyPeerWorldByUid.clear()
  if (!rtdb) return
  const myUid = authFbUser.value?.uid || auth.profile?.id
  if (!myUid) return
  const presRef = dbRef(rtdb, `worldPresence/${FUS_SHARED_WORLD_LABY_ID}`)
  labyWorldPresenceUnsub = onValue(presRef, (snap) => {
    const val = snap.val() || {}
    const now = Date.now()
    lastLabyPeerWorldByUid.clear()
    const list = []
    for (const [id, row] of Object.entries(val)) {
      if (!row || row.left === true) continue
      const cm = Number(row.clientMs)
      if (Number.isFinite(cm) && now - cm > LABY_PRESENCE_STALE_MS) continue
      const x = Number(row.x)
      const y = Number(row.y)
      const z = Number(row.z)
      if (![x, y, z].every((n) => Number.isFinite(n))) continue
      lastLabyPeerWorldByUid.set(id, { x, y, z })
      if (id === myUid) continue
      const name =
        typeof row.name === 'string' && row.name.trim() ? String(row.name).slice(0, 24) : id
      list.push({ uid: id, name, x, y, z })
    }
    list.sort((a, b) => a.name.localeCompare(b.name, 'uk'))
    labyOnlinePeers.value = list
  })
}

function labyToggleOnlinePanel() {
  if (_labyBtnCooldown('onlinepanel')) return
  if (!labyShowOnlinePanel.value && labyOnlineCount.value === 0) return
  const willOpen = !labyShowOnlinePanel.value
  if (willOpen) {
    const isPc =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(pointer: fine)').matches
    if (isPc) releaseDesktopPointerLock(gameMc.value)
  }
  labyShowOnlinePanel.value = !labyShowOnlinePanel.value
}

watch(labyOnlineCount, (n) => {
  if (n === 0) labyShowOnlinePanel.value = false
})

/** Same channel + VFX as spawn-flag / Key R; target is peer feet from presence. */
function labyTeleportToPeer(p) {
  if (!p) return
  if (_labyBtnCooldown('peertp')) return
  labyShowOnlinePanel.value = false
  const mc = gameMc.value
  if (mc && typeof mc.fusLabyStartTeleportToBlockPosChannel === 'function') {
    void mc.fusLabyStartTeleportToBlockPosChannel({
      x: p.x,
      y: p.y,
      z: p.z,
      usePresenceEntityPos: true,
      peerUid: p.uid,
    })
  }
}
/** Death-screen state — populated by {@link installFusDeathScreen} when the local player's
 *  health crosses 0. `active` flips the overlay on; `killerLabel` is the attributed killer
 *  (another player's name, a mob type, or "Невідомо" when nothing relevant was recorded).
 *  Reset by the "Відродитися" button which drives `mc.fusRespawnNow()`. */
const deathActive = ref(false)
const deathKillerLabel = ref('')
/** Interval id for coord ticks — cleared when `gameMc` changes or on unmount */
let labyCoordsIv = 0
/** `pagehide` listener for last-chance session flush (mobile backgrounding). */
let labyPageHideFlush = null

const noRtdb = computed(() => !rtdb)

const labyUserReady = computed(() => !!(authFbUser.value?.uid || auth.profile?.id))

const labyInPlay = computed(() => !!gameMc.value && !booting.value && !error.value)

watch(labyInPlay, (v) => {
  if (!v) labyShowOnlinePanel.value = false
})

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

/**
 * User gesture: immersive play (slim app header preserved — no browser fullscreen, so PWA
 * / OS notifications and toasts are not blocked).
 */
async function labyStartPlay() {
  if (booting.value) return
  bwSession.setImmersive(true)
  if (typeof document !== 'undefined') {
    document.documentElement.classList.add('fus-laby-play')
  }
  labyPlayStarted.value = true
  await nextTick()
  await runLabyEngineBootstrap()
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
  const mc = gameMc.value
  if (!mc) return
  /**
   * Dismiss any engine canvas screen first (not subject to the 350 ms double-tap guard).
   */
  if (mc.currentScreen !== null) {
    releaseDesktopPointerLock(mc)
    mc.displayScreen(null)
    return
  }
  if (labyHtmlSettingsOpen.value) {
    closeLabyHtmlSettings()
    return
  }
  if (_labyBtnCooldown('settings')) return
  releaseDesktopPointerLock(mc)
  showHotbarInventory.value = false
  syncLabySettingsFormFromMc()
  await waitForPointerLockRelease()
  await nextTick()
  labyHtmlSettingsOpen.value = true
}

function onLabySetAmbientOcclusion(e) {
  const v = e.target && 'checked' in e.target ? Boolean(e.target.checked) : labySetAmbientOcclusion.value
  labySetAmbientOcclusion.value = v
  const mc = gameMc.value
  if (mc?.settings) {
    mc.settings.ambientOcclusion = v
    /** Defer mesh invalidation so the checkbox handler returns immediately (PC jank guard). */
    const wr = mc.worldRenderer
    if (wr && typeof wr.rebuildAll === 'function') {
      queueMicrotask(() => {
        try {
          wr.rebuildAll()
        } catch {
          /* ignore */
        }
      })
    }
  }
}

function onLabySetViewBobbing(e) {
  const v = e.target && 'checked' in e.target ? Boolean(e.target.checked) : labySetViewBobbing.value
  labySetViewBobbing.value = v
  const mc = gameMc.value
  if (mc?.settings) mc.settings.viewBobbing = v
}

function onLabySetFovInput(e) {
  const n = Math.round(Number(e?.target?.value))
  labySetFov.value = Math.max(50, Math.min(100, Number.isFinite(n) ? n : 70))
  /** Do not write `mc.settings` every input tick — sync on `@change` only (PC: avoids main-thread stalls). */
}

function onLabySetFovCommit() {
  const mc = gameMc.value
  if (mc?.settings) mc.settings.fov = labySetFov.value
}

function onLabySetViewDistanceInput(e) {
  const n = Math.round(Number(e?.target?.value))
  labySetViewDistance.value = Math.max(
    FUS_LABY_VIEW_MIN,
    Math.min(FUS_LABY_VIEW_MAX, Number.isFinite(n) ? n : FUS_LABY_VIEW_MIN),
  )
}

function onLabySetViewDistanceCommit() {
  const mc = gameMc.value
  if (mc?.settings) mc.settings.viewDistance = labySetViewDistance.value
}

function labyStuckTeleportToSpawn() {
  const mc = gameMc.value
  if (mc && typeof mc.fusTeleportToDefaultSpawn === 'function') {
    try {
      mc.fusTeleportToDefaultSpawn()
    } catch (err) {
      console.warn('[LabyJsMinecraftView] stuck teleport', err)
    }
  }
}

/** Touch HUD: no E / I / 0 key — same as hotbar "⋯" slot + {@link toggleLabyBlockInventory}. */
function openLabyBlockInventoryFromUi() {
  if (_labyBtnCooldown('invui')) return
  toggleLabyBlockInventory()
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

/**
 * Death-screen respawn button handler. Delegates to {@link mc.fusRespawnNow} which knows
 * how to choose between the player's planted flag and the engine's default spawn. The
 * `onRespawn` callback set up in {@link boot} clears {@link deathActive} so the overlay
 * unmounts once the teleport commits.
 */
function respawnFromDeath() {
  const mc = gameMc.value
  if (!mc || typeof mc.fusRespawnNow !== 'function') {
    /** Overlay stuck without an install is a bug, but don't leave the user trapped. */
    deathActive.value = false
    return
  }
  try {
    mc.fusRespawnNow()
  } catch (e) {
    console.warn('[LabyJsMinecraftView] respawn from death failed', e)
    deathActive.value = false
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

/** Hotbar blocks/tools + local skin / RTDB presence after profile or catalog changes (e.g. PK loot). */
function applyLabyProfileAppearanceToEngine() {
  const mc = gameMc.value
  if (!mc?.player?.renderer) return
  const url = resolvePresenceSkinUrl(auth.profile, userStore.items)
  const slim = auth.profile?.avatar?.modelType === 'slim'
  try {
    mc.fusSetPresenceSkin?.(url || null, slim)
  } catch {
    /* ignore */
  }
  mc.player.fusSkinUrl = url || null
  if (url && typeof mc.ensureFusSkinTexture === 'function') {
    void mc.ensureFusSkinTexture(url, () => {
      try {
        mc.player?.renderer?.prepareModel?.(mc.player)
      } catch {
        /* ignore */
      }
    })
  } else if (typeof mc.ensureFusDefaultProfileSkinTexture === 'function') {
    const sid = auth.profile?.avatar?.skinId
    mc.ensureFusDefaultProfileSkinTexture(
      typeof sid === 'string' && sid.length ? sid : 'default',
      () => {
        try {
          mc.player?.renderer?.prepareModel?.(mc.player)
        } catch {
          /* ignore */
        }
      },
    )
  }
}

watch(
  () => [auth.profile?.inventory, auth.profile?.avatar, auth.profile?.id, userStore.items],
  () => {
    if (!gameMc.value) return
    syncHotbarToEngine()
    applyLabyProfileAppearanceToEngine()
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

watch(labyHudBlocked, (open) => {
  if (open) showHotbarInventory.value = false
})

/** Pointer lock: opening the Vue inventory may bypass {@link toggleLabyBlockInventory} (e.g. v-model from child) — always request unlock when the modal opens. */
watch(showHotbarInventory, (open) => {
  if (open) releaseDesktopPointerLock(gameMc.value)
})

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
      labyPvpMode.value = 'white'
      labyKarma.value = 0
      return
    }
    const tick = () => {
      labyEngineGuiOpen.value = mc.currentScreen != null
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
      /** Pull PvP state + karma for the HUD. `fusPvpSelfState` is written every time the
       *  karma module updates state so polling is safe (no reactive plumbing needed). */
      const self = mc.fusPvpSelfState
      if (self) {
        labyPvpMode.value = self.mode || 'white'
        labyKarma.value = Math.max(0, Math.floor(Number(self.karma) || 0))
      }
      tickPersistFusLabySession(mc, FUS_SHARED_WORLD_LABY_ID)
    }
    tick()
    labyCoordsIv = window.setInterval(tick, 220)
  },
  { immediate: true },
)

async function runLabyEngineBootstrap() {
  error.value = ''
  booting.value = true
  try {
    const uid = authFbUser.value?.uid || auth.profile?.id
    if (!uid) {
      error.value = 'Увійдіть, щоб грати'
      return
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
    mc.fusLabyReadPeerPos = (uid) => {
      if (typeof uid !== 'string' || !uid.length) return null
      return lastLabyPeerWorldByUid.get(uid) || null
    }
    labyEngineGuiOpen.value = mc.currentScreen != null
    const _origDisplayScreen = mc.displayScreen.bind(mc)
    mc.displayScreen = function fusLabyPatchedDisplayScreen(screen) {
      try {
        _origDisplayScreen(screen)
      } finally {
        labyEngineGuiOpen.value = mc.currentScreen != null
      }
    }
    /**
     * Freeze the engine until boot completes — prevents touch drags from spinning the camera,
     * dropped block clicks, and mob AI / world ticks from burning CPU behind the loader spinner.
     * Cleared in the `finally` block below after world + spawn flag + skin are all loaded.
     */
    mc.fusFrozen = true

    installFusLabyFpToolHooks(mc)
    if (import.meta.env.DEV === true) {
      // installFusTpToolTuningGui(mc)
      // installFusFpToolTuningGui(mc)
    }
    installFusLabySpawnFlag(mc, { worldId: FUS_SHARED_WORLD_LABY_ID, uid, rtdb })
    installFusSkinLoader(mc)
    installFusAutoJump(mc)
    installFusBlockHardness(mc)
    /** Spawn/respawn invulnerability + FP blink: must run even without RTDB; clock reset in `finally` when boot unfreezes. */
    installFusSpawnInvuln(mc)
    installFusDamageFlash(mc)
    installFusCombatFx(mc)
    installFusPvpKarma(mc, { worldId: FUS_SHARED_WORLD_LABY_ID, uid, rtdb })
    installFusWorldDrops(mc, { worldId: FUS_SHARED_WORLD_LABY_ID, uid, rtdb })
    mc.fusDisposeWaterFlow = installFusWaterFlow(mc)

    if (import.meta.env.DEV && typeof window !== 'undefined') {
      window.__FUS_CLEAR_LABY_MOBS__ = () => clearLabySharedWorldMobsRtdb()
    }

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
      /** Cuts framebuffer pixels on 2–3× DPR devices; see {@link GameWindow#updateWindowSize}. */
      mc.fusWebglPixelRatioMax = 2;
      if (strainedAndroid) {
        /**
         * Route Android through the same ultra-strict throttle constants as iOS Safari. All the
         * hot paths test {@code fusIosSafari} as the "be very conservative" switch; using it as
         * a "strained mobile" flag avoids adding a third tier everywhere.
         */
        mc.fusIosSafari = true
      }
    }
    /** Tighter horizontal cull for mobs / remotes / spawn flag so they do not draw past cut-off sky on touch clients. */
    mc.fusLabyStricterEntityCull = isIosSafari || isAndroid

    /**
     * {@link WorldRenderer#onTick}: at most N chunk-section mesh rebuilds per game tick, and
     * a lower burst cap on {@code flushRebuild} so explore-spikes don’t stutter the main thread.
     * Android: explicit 1/tick; all Laby low-tier touch clients also use a smaller flush cap.
     */
    if (isAndroid) {
      mc.fusChunkRebuildsPerTick = 1
    }
    if (mc.fusLowTierMobile) {
      mc.fusChunkFlushRebuildCap = 4
    }
    /**
     * Laby in-browser (PC included): 2 section rebuilds per tick + large flush cap spikes the
     * main thread when many chunks become visible. Match the Android steady-state budget on
     * all embed clients so explore stays smooth; horizon fills marginally slower.
     */
    if (typeof window !== 'undefined' && window.__LABY_MC_FUS_EMBED__) {
      mc.fusChunkRebuildsPerTick = 1
      const cap = Number(mc.fusChunkFlushRebuildCap)
      mc.fusChunkFlushRebuildCap = Number.isFinite(cap) && cap > 0 ? Math.min(cap, 4) : 4
    }
    /** {@link World#onTick}: no advancing time / sky-light / full chunk rebuilds from day cycle. */
    mc.fusLabyStaticDayTime = true
    /** Double-tap jump → creative flight: dev-only (see {@link PlayerEntity#onLivingUpdate}). */
    mc.fusAllowFlying = isLabyDev

    if (mc.settings) {
      /**
       * Render distance: {@link applyFusLabyViewDistanceFromStorage} uses localStorage as
       * the source of truth (clamped 2..5) so mobile browsers that drop or partition
       * cookies still respect the in-game slider. {@link installFusLabyViewDistanceSaveHook}
       * mirrors every {@link GameSettings#save} into the same key.
       */
      applyFusLabyViewDistanceFromStorage(mc, {
        isAndroid,
        isIosSafari,
        strainedAndroid,
      })
      installFusLabyViewDistanceSaveHook(mc)
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

    if (rtdb) {
      try {
        const snap = await get(dbRef(rtdb, `worldSpawnFlags/${FUS_SHARED_WORLD_LABY_ID}/${uid}`))
        if (snap.exists()) {
          const f = snap.val()
          const x = Number(f.x)
          const y = Number(f.y)
          const z = Number(f.z)
          if ([x, y, z].every((n) => Number.isFinite(n))) {
            const ry = Number.isFinite(Number(f.ry)) ? Number(f.ry) : null
            mc.fusSpawnFlagPos = { x, y, z, ry: ry != null && Number.isFinite(ry) ? ry : undefined }
            const feetY = fusLabyFeetYAtColumn(mc.world, x, z, y)
            mc.player.setPosition(x + 0.5, feetY, z + 0.5)
            if (ry != null && Number.isFinite(ry) && typeof mc.player.rotationYaw === 'number') {
              mc.player.rotationYaw = ry
            }
          }
        }
      } catch (e) {
        console.warn('[LabyJsMinecraftView] spawn flag load (early)', e)
      }
    }

    /** First ~10s: defer distant RTDB cell applies on embed (nearest-first still streams; see FusRtdbBlocks). */
    if (typeof performance !== 'undefined') {
      mc._fusTerrainBootUntil = performance.now() + 10000
    }

    /** Mount world-edits streaming now that `mc.world` exists. Install order is important:
     *  chunks primed before this call still apply because the cell `get(...)` prime runs on
     *  every subscribed cell the first time it enters the window. */
    if (rtdb) {
      installFusWorldEditsRtdb(mc, { worldId: FUS_SHARED_WORLD_LABY_ID, uid, rtdb })
      /** After chunks hydrate, replay RTDB primes so persisted breaks (trees) win over stale terrain. */
      void nextTick(() => {
        requestAnimationFrame(() => {
          try {
            mc.fusRerunWorldEditsReconcileSoon?.()
          } catch {
            /* ignore */
          }
        })
      })
      mc._fusWorldEditsReplayTimer = window.setTimeout(() => {
        try {
          mc.fusReplayWorldEditPrimes?.()
          mc.fusRerunWorldEditsReconcileSoon?.()
        } catch {
          /* ignore */
        }
        mc._fusWorldEditsReplayTimer = 0
      }, 9500)
    }

    /**
     * Multiplayer avatars: write our pose/HP/held/PvP state to `worldPresence/...` at ~10 Hz
     * and subscribe to every peer's row to draw their skinned model + nametag + HP bar. The
     * remote-avatar installer must come after world-edits so the avatar scale computations
     * get the final `worldRenderer` camera (set during world load).
     */
    if (rtdb) {
      installFusPresenceWriter(mc, {
        worldId: FUS_SHARED_WORLD_LABY_ID,
        uid,
        rtdb,
        displayName,
        skinUrl,
        slim: auth.profile?.avatar?.modelType === 'slim',
      })
      try {
        mc.fusForcePresenceWrite?.()
      } catch {
        /* first push of invUntil after writer exists */
      }
      installFusRemoteAvatars(mc, { worldId: FUS_SHARED_WORLD_LABY_ID, uid, rtdb })
    }

    syncHotbarToEngine()
    mc.player.inventory.selectedSlotIndex = 0

    try {
      mc.fusRefreshSpawnFlagMarker?.()
    } catch {
      /* ignore */
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
    } else if (typeof mc.ensureFusDefaultProfileSkinTexture === 'function') {
      const sid = auth.profile?.avatar?.skinId
      mc.ensureFusDefaultProfileSkinTexture(typeof sid === 'string' && sid.length ? sid : 'default', () => {
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
    if (typeof window !== 'undefined' && window.__LABY_MC_FUS_EMBED__ && mc.worldRenderer?.fusPrewarmSpawnAreaMeshes) {
      try {
        await mc.worldRenderer.fusPrewarmSpawnAreaMeshes({ maxTotalMs: 8000, stepsPerRaf: 28 })
      } catch (e) {
        console.warn('[LabyJsMinecraftView] chunk mesh prewarm', e)
      }
    }

    if (mc.fusSpawnFlagPos) {
      const fp = mc.fusSpawnFlagPos
      const x = Number(fp.x)
      const y = Number(fp.y)
      const z = Number(fp.z)
      if ([x, y, z].every((n) => Number.isFinite(n)) && mc.player) {
        try {
          const feetY = fusLabyFeetYAtColumn(mc.world, x, z, y)
          mc.player.setPosition(x + 0.5, feetY, z + 0.5)
        } catch (e) {
          console.warn('[LabyJsMinecraftView] spawn flag feet re-apply after terrain ready', e)
        }
      }
    }

    /**
     * Local-only simple mob system (spawns/AI/attack hook). Drop-in replacement for the
     * deleted FusMobSync — see {@code fusSimpleMobsInstall.js}. Runs after render-ready
     * so the first spawn snaps to terrain that actually exists.
     */
    installFusSimpleMobs(mc, {
      count: mc.fusLowTierMobile ? 4 : 8,
      spawnRadius: 28,
      level: Math.max(1, Math.floor(labyLevel) || 1),
      worldId: rtdb ? FUS_SHARED_WORLD_LABY_ID : null,
      /** Always pass the same id the XP handler uses — null was breaking solo / no-RTDB kills. */
      uid,
      rtdb: rtdb || null,
      displayName,
    })
    /**
     * PvP / PK combat wiring. Must come AFTER {@link installFusSimpleMobs} so it can
     * chain on top of the mob-melee hook — see {@link installFusPlayerCombat} for the
     * priority it uses (player → mob → block). Requires presence + remote-avatars to
     * already be subscribed so the attacker's target resolver has positions to raycast
     * against.
     */
    if (rtdb) {
      installFusPlayerCombat(mc, {
        worldId: FUS_SHARED_WORLD_LABY_ID,
        uid,
        rtdb,
        displayName,
      })
    }

    /**
     * Passive HP regen: 30 s after any hit (given or taken), then +1 HP every 10 s until
     * full. See {@link installFusHealthRegen}. After combat install so `player.health`
     * is the same reference; `fusMarkCombatForRegen` runs from PvP + mob installers.
     */
    installFusHealthRegen(mc, { outOfCombatMs: 30000, regenIntervalMs: 10000, amount: 1 })

    /**
     * Death-screen coordinator. Shows an overlay (template below) naming the killer and
     * offering a "Відродитися" respawn button. We keep the install *after* combat / regen
     * so `mc.fusRecordDamageFrom` exists before mobs or PvP start landing hits. The Vue
     * callbacks bridge reactive refs to the raw `mc` state.
     */
    installFusDeathScreen(mc, {
      onDeath: ({ killerLabel }) => {
        deathKillerLabel.value = killerLabel || 'Невідомо'
        deathActive.value = true
      },
      onRespawn: () => {
        deathActive.value = false
        deathKillerLabel.value = ''
      },
    })
  } catch (e) {
    console.warn('[LabyJsMinecraftView]', e)
    error.value = e?.message || 'Помилка запуску'
  } finally {
    if (error.value) labyPlayStarted.value = false
    if (error.value) {
      bwSession.setImmersive(false)
      if (typeof document !== 'undefined') {
        document.documentElement.classList.remove('fus-laby-play')
      }
    }
    const mc = gameMc.value
    if (mc) {
      /** Freeze only on failed bootstrap; clear on success (same intent as the old `!error && !labyPlayStarted` product). */
      mc.fusFrozen = Boolean(error.value)
      /**
       * `installFusSpawnInvuln` runs early; the 5s window was expiring during the loader / terrain wait, so
       * FP + third-person blink looked “broken”. Restart invuln at first successful unfreeze, then push
       * `invUntil` to presence (when RTDB is enabled).
       */
      if (!error.value) {
        try {
          mc.fusRefreshSpawnInvuln?.()
        } catch {
          /* ignore */
        }
        if (rtdb) {
          try {
            mc.fusForcePresenceWrite?.()
          } catch {
            /* ignore */
          }
        }
      }
    }
    booting.value = false
  }
  if (!error.value && isLabyDev) {
    await nextTick()
    mountFusStats()
  }
}

onMounted(async () => {
  error.value = ''
  booting.value = false
  labyPlayStarted.value = false
  gameMc.value = null
  bwSession.setImmersive(false)

  const base = `${import.meta.env.BASE_URL || '/'}`.replace(/\/?$/, '/')
  window.__LABY_MC_ASSET_BASE__ = `${base}labyminecraft/`
  window.__LABY_MC_FUS_EMBED__ = true

  window.__FUS_LABY_TOGGLE_INVENTORY__ = toggleLabyBlockInventory

  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', onLabyInventoryKeydown, true)
    labyPageHideFlush = () => {
      const mc = gameMc.value
      if (mc) flushFusLabySessionToStorage(mc, FUS_SHARED_WORLD_LABY_ID)
    }
    window.addEventListener('pagehide', labyPageHideFlush)
  }

  if (typeof document !== 'undefined') {
    _labyFsListener = () => fusLabySyncFullscreenState()
    document.addEventListener('fullscreenchange', _labyFsListener)
    document.addEventListener('webkitfullscreenchange', _labyFsListener)
    fusLabySyncFullscreenState()
  }

  /** Let the browser rotate on phones/tablets (some hosts lock orientation for games). */
  if (typeof screen !== 'undefined' && screen.orientation && typeof screen.orientation.unlock === 'function') {
    try {
      screen.orientation.unlock()
    } catch {
      /* ignore — not user-gesture or unsupported */
    }
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

    bindLabyWorldPresenceRoster()

    window.__FUS_GRANT_LABY_XP__ = async (amount, meta) => {
      /** Firestore `users/{uid}` uses Firebase auth uid — align with coin grants. */
      const u = authFbUser.value?.uid || auth.profile?.id
      const fb = authFbUser.value?.uid
      const prof = auth.profile?.id
      const killerUid = meta && typeof meta.killerUid === 'string' ? meta.killerUid : ''
      if (!killerUid || amount == null) return
      const isLocalKiller =
        (fb && killerUid === fb) || (prof && killerUid === prof) || killerUid === uid
      if (!isLocalKiller) return
      if (!u) return
      try {
        const label =
          meta && typeof meta.mobType === 'string'
            ? `Лабі-світ — ${meta.mobType}`
            : 'Лабі-світ — моб'
        await grantLabyGameplayXp(u, Number(amount), label)
      } catch (e) {
        console.warn('[LabyJsMinecraftView] grant xp', e)
      }
    }

    /**
     * One Firestore write for mob-kill combat XP + capped mob coins — keeps rewards immediate
     * (see {@link grantLabyMobKillPayout}). Used when {@code installFusSimpleMobs} sees this hook.
     */
    window.__FUS_GRANT_LABY_MOB_PAYOUT__ = async (payload) => {
      if (!payload || typeof payload !== 'object') return
      const u = authFbUser.value?.uid || auth.profile?.id
      if (!u) {
        console.warn('[Laby] mob payout: no uid')
        return
      }
      const fb = authFbUser.value?.uid
      const prof = auth.profile?.id
      const killerUid = typeof payload.killerUid === 'string' ? payload.killerUid : ''
      if (!killerUid) return
      const isLocalKiller =
        (fb && killerUid === fb) || (prof && killerUid === prof) || killerUid === uid
      if (!isLocalKiller) return
      const xp = Math.max(0, Math.round(Number(payload.xp) || 0))
      const coins = Math.max(0, Math.round(Number(payload.coins) || 0))
      if (xp === 0 && coins === 0) return
      const label =
        typeof payload.mobType === 'string' && payload.mobType.length
          ? `Лабі-світ — ${payload.mobType}`
          : 'Лабі — здобич з мобів'
      try {
        await grantLabyMobKillPayout(u, { xp, coins, note: label })
      } catch (e) {
        console.warn('[LabyJsMinecraftView] grantLabyMobKillPayout', e)
      }
    }

    window.__FUS_GRANT_LOOT__ = async (payload) => {
      if (!payload || typeof payload !== 'object') {
        console.warn('[LabyJsMinecraftView] __FUS_GRANT_LOOT__: invalid payload', payload)
        return { ok: false, reason: 'bad-payload' }
      }
      /**
       * `users/{uid}` in Firestore uses the Firebase auth uid. Prefer it over
       * `auth.profile.id` (which can differ or lag while profile hydrates) or grants no-op
       * / wrong-doc writes without an obvious error.
       */
      const u = authFbUser.value?.uid || auth.profile?.id
      if (!u) {
        console.warn(
          '[LabyJsMinecraftView] __FUS_GRANT_LOOT__: no uid — wait for auth/profile (pickup was too early)',
        )
        return { ok: false, reason: 'no-uid' }
      }
      const kind = payload.kind
      try {
        if (kind === 'coins' && payload.coins != null) {
          const amt = Number(payload.coins)
          if (payload.source === 'pk') {
            await grantStudentCoinsFromGame(u, amt, 'PK — здобич')
            return { ok: true, kind: 'coins', source: 'pk' }
          } else if (payload.source === 'ore') {
            const r = await grantLabyMobCoinsCapped(u, amt, 'Лабі — золота руда')
            /**
             * Do **not** mutate `auth.profile` in place here — the Firestore listener will
             * replace the profile object with server truth. In-place + listener ordering caused
             * coin totals to “dip” and false −coin toasts (same grant applied twice in UI math).
             */
            if (amt > 0 && r.granted < amt) {
              console.warn('[Laby] ore coins not fully granted (daily mob cap, etc.)', { wanted: amt, ...r })
            }
            return { ok: true, kind: 'coins', source: 'ore', ...r }
          } else {
            const r = await grantLabyMobCoinsCapped(u, amt, 'Лабі — здобич з мобів')
            if (amt > 0 && r.granted < amt) {
              console.warn('[Laby] mob coins not fully granted (daily mob cap, etc.)', { wanted: amt, ...r })
            }
            return { ok: true, kind: 'coins', source: 'mob', ...r }
          }
        } else if (kind === 'item' && payload.bwSeedKey) {
          const bw = String(payload.bwSeedKey)
          const fromPayload =
            typeof payload.itemLabel === 'string' && payload.itemLabel.trim()
              ? payload.itemLabel.trim()
              : labyDisplayNameForMobDropBwKey(bw)
          const added = await grantShopItemByBwSeedKey(u, bw)
          await userStore.fetchItems()
          await nextTick()
          syncHotbarToEngine()
          if (added) {
            toastLabySuccess(`Отримано в інвентар: ${fromPayload}`, 2200)
          } else {
            toastLabyInfo(
              `Предмет «${fromPayload}» не знайдено в каталозі (адміністратору: перевірте bwSeedKey).`,
              3200,
            )
          }
          return { ok: added, kind: 'item', label: fromPayload }
        } else if (kind === 'skin' && payload.skinId) {
          const ok = await grantShopSkinBySkinId(u, String(payload.skinId))
          await userStore.fetchItems()
          await nextTick()
          syncHotbarToEngine()
          if (ok) {
            toastLabySuccess('Новий скін додано до інвентаря', 2000)
          }
          return { ok, kind: 'skin' }
        }
      } catch (e) {
        console.warn('[LabyJsMinecraftView] grant loot', e)
        throw e
      }
      return { ok: true }
    }

    /**
     * PvP coin transfer: only when the victim was **purple** (flagged for PvP) — the losing
     * client fires this hook. We debit a small fixed coin count from the loser (1–5 by
     * level vs killer), then spawn one stacked coin drop for the killer. Killing a white
     * (innocent) player does not run this. If the loser is broke, nothing drops.
     */
    window.__FUS_ON_PVP_DEATH_DROP__ = async ({ killerUid, x, y, z }) => {
      const u = auth.profile?.id
      if (!u || !killerUid || killerUid === u) return
      try {
        const { debited } = await debitPvpCoinFromUser(u, { winnerUid: killerUid })
        if (!debited) return
        const mc = gameMc.value
        if (mc && typeof mc.fusDropCoinAt === 'function') {
          mc.fusDropCoinAt(Number(x) || 0, Number(y) || 0, Number(z) || 0, {
            coins: debited,
            winnerUid: killerUid,
            source: 'pk',
          })
        }
      } catch (e) {
        console.warn('[LabyJsMinecraftView] pvp death drop failed', e)
      }
    }

    /**
     * PK death: fallen PK drops 1..min(50,k) coins (k = karma) + random items
     * from their inventory. One RTDB row stacks all debited coins; items drop as separate
     * cubes with a small XZ offset.
     */
    window.__FUS_ON_PK_DEATH_DROPS__ = async ({ karmaAtDeath, dropContext }) => {
      const u = auth.profile?.id
      if (!u) return
      const k = Math.max(1, Math.floor(Number(karmaAtDeath) || 1))
      const baseX = Number(dropContext?.x) || 0
      const baseY = Number(dropContext?.y) || 0
      const baseZ = Number(dropContext?.z) || 0
      try {
        const { coinsDropped, items } = await debitPkLootFromUser(u, { karma: k })
        const mc = gameMc.value
        if (!mc) return
        if (coinsDropped > 0) {
          const jx = (Math.random() - 0.5) * 2.2
          const jz = (Math.random() - 0.5) * 2.2
          mc.fusDropCoinAt?.(baseX + jx, baseY + 0.3, baseZ + jz, {
            coins: coinsDropped,
            source: 'pk',
            loserUid: u,
          })
        }
        for (const item of items) {
          const jx = (Math.random() - 0.5) * 2.6
          const jz = (Math.random() - 0.5) * 2.6
          mc.fusDropItemAt?.(baseX + jx, baseY + 0.5, baseZ + jz, {
            subtype: item.subtype,
            payload: item.payload,
            label: item.label,
            loserUid: u,
          })
        }
        await userStore.fetchItems({ force: true })
        await nextTick()
        syncHotbarToEngine()
        applyLabyProfileAppearanceToEngine()
      } catch (e) {
        console.warn('[LabyJsMinecraftView] PK drop failed', e)
      }
    }

  } catch (e) {
    console.warn('[LabyJsMinecraftView] init', e)
    error.value = e?.message || 'Помилка'
  }
})

onBeforeUnmount(() => {
  unmountFusStats()
  const mcd = gameMc.value
  if (mcd) {
    try {
      mcd.fusLabyReadPeerPos = null
    } catch {
      /* ignore */
    }
  }
  lastLabyPeerWorldByUid.clear()
  try {
    labyWorldPresenceUnsub?.()
  } catch {
    /* ignore */
  }
  labyWorldPresenceUnsub = null
  labyPseudoPageFullscreen.value = false
  if (typeof document !== 'undefined' && _labyFsListener) {
    try {
      document.removeEventListener('fullscreenchange', _labyFsListener)
      document.removeEventListener('webkitfullscreenchange', _labyFsListener)
    } catch {
      /* ignore */
    }
    _labyFsListener = null
  }
  if (typeof window !== 'undefined') {
    window.removeEventListener('keydown', onLabyInventoryKeydown, true)
    if (labyPageHideFlush) {
      try {
        labyPageHideFlush()
      } catch {
        /* ignore */
      }
      window.removeEventListener('pagehide', labyPageHideFlush)
      labyPageHideFlush = null
    }
  }
  /** Dispose the FP tool tuning dat.gui if it was opened (either auto in dev, or F7 in
   *  prod). The panel pins itself to `document.body`, so leaving it dangling after the
   *  view unmounts would stack up across route changes. */
  const gui = gameMc.value?._fusFpToolTuningGui
  if (gui) {
    try {
      gui.domElement?.remove?.()
    } catch {
      /* ignore */
    }
    try {
      gui.destroy?.()
    } catch {
      /* ignore */
    }
    if (gameMc.value) gameMc.value._fusFpToolTuningGui = null
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
    delete window.__FUS_LABY_TOGGLE_INVENTORY__
  } catch {
    window.__FUS_LABY_TOGGLE_INVENTORY__ = undefined
  }
  try {
    delete window.__FUS_CLEAR_LABY_MOBS__
  } catch {
    window.__FUS_CLEAR_LABY_MOBS__ = undefined
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
  try {
    delete window.__FUS_GRANT_LABY_MOB_PAYOUT__
  } catch {
    window.__FUS_GRANT_LABY_MOB_PAYOUT__ = undefined
  }
  try {
    delete window.__FUS_ON_PVP_DEATH_DROP__
  } catch {
    window.__FUS_ON_PVP_DEATH_DROP__ = undefined
  }
  try {
    delete window.__FUS_ON_PK_DEATH_DROPS__
  } catch {
    window.__FUS_ON_PK_DEATH_DROPS__ = undefined
  }

  const mc = gameMc.value
  labyEngineGuiOpen.value = false
  labyHtmlSettingsOpen.value = false
  gameMc.value = null
  if (!mc) return
  try {
    mc.fusDisposePlayerCombat?.()
  } catch (e) {
    console.warn('[LabyJsMinecraftView] dispose player combat', e)
  }
  try {
    mc.fusDisposeHealthRegen?.()
  } catch (e) {
    console.warn('[LabyJsMinecraftView] dispose health regen', e)
  }
  try {
    mc.fusDisposeDeathScreen?.()
  } catch (e) {
    console.warn('[LabyJsMinecraftView] dispose death screen', e)
  }
  try {
    mc.fusDisposeCombatFx?.()
  } catch (e) {
    console.warn('[LabyJsMinecraftView] dispose combat fx', e)
  }
  try {
    mc.fusDisposeSimpleMobs?.()
  } catch (e) {
    console.warn('[LabyJsMinecraftView] dispose mobs', e)
  }
  try {
    mc.fusDisposeAutoJump?.()
  } catch (e) {
    console.warn('[LabyJsMinecraftView] dispose auto-jump', e)
  }
  try {
    mc.fusDisposeBlockHardness?.()
  } catch (e) {
    console.warn('[LabyJsMinecraftView] dispose block hardness', e)
  }
  try {
    mc.fusDisposeDamageFlash?.()
  } catch (e) {
    console.warn('[LabyJsMinecraftView] dispose damage flash', e)
  }
  try {
    mc.fusDisposeLabySpawnFlag?.()
  } catch (e) {
    console.warn('[LabyJsMinecraftView] dispose spawn flag', e)
  }
  try {
    mc.fusDisposePvpKarma?.()
  } catch (e) {
    console.warn('[LabyJsMinecraftView] dispose pvp karma', e)
  }
  try {
    mc.fusDisposeWorldDrops?.()
  } catch (e) {
    console.warn('[LabyJsMinecraftView] dispose world drops', e)
  }
  try {
    mc.fusDisposeWaterFlow?.()
    delete mc.fusDisposeWaterFlow
  } catch (e) {
    console.warn('[LabyJsMinecraftView] dispose water flow', e)
  }
  if (typeof mc._fusWorldEditsReplayTimer === 'number' && mc._fusWorldEditsReplayTimer > 0) {
    try {
      window.clearTimeout(mc._fusWorldEditsReplayTimer)
    } catch {
      /* ignore */
    }
    mc._fusWorldEditsReplayTimer = 0
  }
  try {
    mc.fusDisposeWorldEditsRtdb?.()
  } catch (e) {
    console.warn('[LabyJsMinecraftView] dispose world edits rtdb', e)
  }
  try {
    mc.fusDisposeRemoteAvatars?.()
  } catch (e) {
    console.warn('[LabyJsMinecraftView] dispose remote avatars', e)
  }
  try {
    try {
      mc.fusDisposeSpawnInvuln?.()
    } catch (e) {
      console.warn('[LabyJsMinecraftView] dispose spawn invuln', e)
    }
    mc.fusDisposePresenceWriter?.()
  } catch (e) {
    console.warn('[LabyJsMinecraftView] dispose presence writer', e)
  }
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
  <div
    ref="labyPageRef"
    class="laby-page"
    :class="{ 'laby-page--play': labyPlayStarted, 'laby-page--pseudo-fs': labyPseudoPageFullscreen }"
  >
    <div v-if="booting" class="laby-boot" aria-busy="true">
      <div class="laby-boot-spinner" />
      <p class="laby-boot-text">Завантаження світу…</p>
    </div>
    <p v-if="error" class="laby-err">{{ error }}</p>
    <p v-if="noRtdb" class="laby-warn">
      Немає Realtime Database (<code>VITE_FIREBASE_DATABASE_URL</code>) — спільні блоки та присутність інших гравців
      можуть не працювати.
    </p>

    <div
      v-if="labyUserReady && !labyPlayStarted"
      class="laby-lobby"
      role="dialog"
      aria-modal="true"
      aria-label="Вхід"
    >
      <button
        type="button"
        class="laby-play-gate-cta"
        @pointerdown.stop.prevent="labyStartPlay"
        @click.stop.prevent="labyStartPlay"
      >
        Вхід
      </button>
    </div>

    <div v-show="labyInPlay && !labyHudBlocked" class="laby-top-hud">
      <div class="laby-top-hud-left">
        <div class="laby-top-hud-left-stack">
          <button type="button" class="laby-back" @click="goBack">← Назад</button>
          <button
            v-if="!showDesktopKeyHint && !noRtdb"
            type="button"
            class="laby-players-online"
            title="Гравці онлайн"
            aria-label="Гравці онлайн"
            @pointerdown.stop.prevent="labyToggleOnlinePanel"
            @click.stop.prevent="labyToggleOnlinePanel"
          >
            <span class="laby-btn-icon" aria-hidden="true">👥</span>
            <span class="laby-btn-badge">{{ labyOnlineCount }}</span>
          </button>
        </div>
      </div>
      <div class="laby-top-hud-center-wrap" aria-hidden="true">
        <div class="laby-top-hud-center">
          {{ labyCoordX }} {{ labyCoordY }} {{ labyCoordZ }}
        </div>
        <div
          v-if="flagChannelProgress > 0"
          class="laby-tp-channel"
        >
          <div class="laby-tp-track" role="progressbar" :aria-valuenow="Math.round(flagChannelProgress * 100)" aria-valuemin="0" aria-valuemax="100">
            <div class="laby-tp-fill" :style="{ width: `${flagChannelProgress * 100}%` }" />
          </div>
        </div>
      </div>
      <div class="laby-top-hud-right">
        <button
          v-if="!showDesktopKeyHint"
          type="button"
          class="laby-settings"
          title="Налаштування"
          aria-label="Налаштування"
          @pointerdown.stop.prevent="openLabySettings"
          @click.stop.prevent="openLabySettings"
        >
          <span class="laby-btn-icon">⚙</span>
        </button>
        <button
          v-if="!showDesktopKeyHint"
          type="button"
          class="laby-inv-open"
          title="Інвентар"
          aria-label="Відкрити інвентар блоків"
          @pointerdown.stop.prevent="openLabyBlockInventoryFromUi"
          @click.stop.prevent="openLabyBlockInventoryFromUi"
        >
          <span class="laby-btn-icon">🎒</span>
        </button>
        <button
          v-if="showDesktopKeyHint && !noRtdb"
          type="button"
          class="laby-players-online laby-players-online--desktop"
          title="Гравці онлайн (P)"
          aria-label="Гравці онлайн, клавіша P"
          @pointerdown.stop.prevent="labyToggleOnlinePanel"
          @click.stop.prevent="labyToggleOnlinePanel"
        >
          <span class="laby-btn-icon" aria-hidden="true">👥</span>
          <span class="laby-btn-badge">{{ labyOnlineCount }}</span>
          <span class="laby-btn-key">P</span>
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
    </div>

    <!-- Mobile: top HUD is hidden while налаштування (HTML) or canvas GUI is open — keep one
         control so the same "gear" can dismiss. Desktop: K opens settings; Esc only unlocks / closes overlays. -->
    <div
      v-if="labyInPlay && labyHudBlocked && !showDesktopKeyHint"
      class="laby-engine-gui-chrome"
    >
      <button
        type="button"
        class="laby-settings"
        title="Закрити налаштування"
        aria-label="Закрити налаштування"
        @pointerdown.stop.prevent="openLabySettings"
        @click.stop.prevent="openLabySettings"
      >
        <span class="laby-btn-icon">⚙</span>
      </button>
    </div>

    <div
      v-if="labyInPlay && !labyHudBlocked && showDesktopKeyHint"
      class="laby-key-hint"
      aria-live="polite"
    >
      <span>F — прапор</span>
      <span>I / 0 — інвентар</span>
      <span>R — телепорт до прапора</span>
      <span v-if="!noRtdb">P — гравці онлайн</span>
      <span>K — налаштування</span>
    </div>

    <div
      v-if="labyInPlay && labyShowOnlinePanel && !labyHudBlocked"
      class="laby-players-panel"
      role="dialog"
      aria-modal="true"
      aria-label="Гравці онлайн"
      @click.self="labyShowOnlinePanel = false"
    >
      <div class="laby-players-card" @click.stop>
        <div class="laby-players-card-head">
          <span class="laby-players-title">Онлайн</span>
          <button
            type="button"
            class="laby-players-close"
            aria-label="Закрити"
            @click="labyShowOnlinePanel = false"
          >
            ×
          </button>
        </div>
        <p v-if="!labyOnlinePeers.length" class="laby-players-empty">
          Немає інших гравців у світі зараз.
        </p>
        <ul v-else class="laby-players-list">
          <li v-for="p in labyOnlinePeers" :key="p.uid" class="laby-players-row">
            <span class="laby-players-name" :title="p.name">{{ p.name }}</span>
            <button
              type="button"
              class="laby-players-tp"
              :disabled="!gameMc"
              @click="labyTeleportToPeer(p)"
            >
              Телепорт
            </button>
          </li>
        </ul>
      </div>
    </div>

    <div
      v-if="labyInPlay && !labyHudBlocked && (labyKarma > 0 || labyPvpMode === 'purple')"
      class="laby-pvp-indicator"
      :class="{
        'laby-pvp-red': labyPvpMode === 'red' || labyKarma > 0,
        'laby-pvp-purple': labyPvpMode === 'purple' && labyKarma <= 0,
      }"
      aria-live="polite"
    >
      <span v-if="labyKarma > 0" class="laby-pvp-karma">
        <span class="laby-pvp-icon">☠</span>
        <span class="laby-pvp-label">PK</span>
        <span class="laby-pvp-value">{{ labyKarma }}</span>
        <span class="laby-pvp-suffix">карма</span>
      </span>
      <span v-else class="laby-pvp-karma">
        <span class="laby-pvp-icon">⚔</span>
        <span class="laby-pvp-label">PvP</span>
      </span>
    </div>

    <div
      v-show="isLabyDev && labyInPlay && !labyHudBlocked"
      ref="statsHostRef"
      class="laby-stats"
      aria-hidden="true"
    />

    <LabyMobileControls v-if="labyInPlay && !labyHudBlocked" :mc="gameMc" />

    <BlockWorldLabyInventoryModal
      v-model="showHotbarInventory"
      :laby-engine-gui-open="labyHudBlocked"
      :uid="auth.profile?.id || ''"
      :profile="auth.profile"
      :shop-items="userStore.items"
      :live-hotbar-item-ids="liveLabyHotbarItemIds"
      :game-mc="gameMc"
      @saved="syncHotbarToEngine"
    />

    <div
      v-show="labyPlayStarted"
      :id="hostId"
      class="laby-host"
      :class="{ 'laby-host--no-pointer': labyHtmlSettingsOpen }"
    />

    <div
      v-if="labyInPlay && labyHtmlSettingsOpen"
      class="laby-settings-html"
      role="dialog"
      aria-modal="true"
      aria-labelledby="laby-settings-html-title"
      @click.self="closeLabyHtmlSettings"
    >
      <div class="laby-settings-html-card" @click.stop>
        <h2 id="laby-settings-html-title" class="laby-settings-html-title">Налаштування</h2>

        <label class="laby-settings-row laby-settings-check">
          <input
            type="checkbox"
            :checked="labySetAmbientOcclusion"
            @change="onLabySetAmbientOcclusion"
          />
          <span>Амбієнтне затінення (тіні між блоками)</span>
        </label>

        <label class="laby-settings-row laby-settings-check">
          <input type="checkbox" :checked="labySetViewBobbing" @change="onLabySetViewBobbing" />
          <span>Покачування камери під час руху</span>
        </label>

        <div class="laby-settings-row">
          <div class="laby-settings-label">Поле зору (FOV): {{ labySetFov }}°</div>
          <input
            class="laby-settings-range"
            type="range"
            min="50"
            max="100"
            step="1"
            :value="labySetFov"
            @input="onLabySetFovInput"
            @change="onLabySetFovCommit"
          />
        </div>

        <div class="laby-settings-row">
          <div class="laby-settings-label">Дальність рендеру: {{ labySetViewDistance }} чанків</div>
          <input
            class="laby-settings-range"
            type="range"
            :min="FUS_LABY_VIEW_MIN"
            :max="FUS_LABY_VIEW_MAX"
            step="1"
            :value="labySetViewDistance"
            @input="onLabySetViewDistanceInput"
            @change="onLabySetViewDistanceCommit"
          />
        </div>

        <div class="laby-settings-actions">
          <button type="button" class="laby-settings-btn laby-settings-btn-secondary" @click="fusLabyTogglePageFullscreen">
            {{ labyPageFullscreen ? 'Вийти з повноекранного режиму' : 'Повноекранний режим' }}
          </button>
          <button
            v-if="gameMc && typeof gameMc.fusTeleportToDefaultSpawn === 'function'"
            type="button"
            class="laby-settings-btn laby-settings-btn-warn"
            @click="labyStuckTeleportToSpawn"
          >
            Застряг? Телепорт на спавн світу
          </button>
          <button type="button" class="laby-settings-btn laby-settings-btn-primary" @click="closeLabyHtmlSettings">
            Готово
          </button>
        </div>
      </div>
    </div>

    <div
      v-if="deathActive"
      class="laby-death"
      role="dialog"
      aria-modal="true"
      aria-labelledby="laby-death-title"
    >
      <div class="laby-death-card" @pointerdown.stop @click.stop>
        <div id="laby-death-title" class="laby-death-title">Ви загинули</div>
        <div class="laby-death-killer">
          Вас вбив: <strong>{{ deathKillerLabel || 'Невідомо' }}</strong>
        </div>
        <button
          type="button"
          class="laby-death-respawn"
          :title="showDesktopKeyHint ? 'Відродитися (Space / Enter)' : ''"
          @pointerdown.stop.prevent="respawnFromDeath"
          @click.stop.prevent="respawnFromDeath"
        >
          <span>Відродитися</span>
          <span v-if="showDesktopKeyHint" class="laby-death-respawn-key">Space</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Lobby: in-flow under StudentLayout header + bottom nav. Play: fixed layer over the viewport. */
.laby-page {
  position: relative;
  min-height: 0;
  flex: 1 1 0;
  display: flex;
  flex-direction: column;
  width: 100%;
  background-color: #020617;
  /* iOS: `manipulation` suppresses double-tap page zoom; `none` here was letting Safari zoom the page */
  touch-action: manipulation;
  overscroll-behavior: none;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
}
/** Pre-play (lobby + boot): `public/game_screen_bg.jpg` — scrim keeps the bright center readable. */
.laby-page:not(.laby-page--play) {
  background-image:
    linear-gradient(180deg, rgba(15, 23, 42, 0.5) 0%, rgba(2, 6, 23, 0.72) 50%, rgba(2, 6, 23, 0.78) 100%),
    url(/game_screen_bg.jpg);
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
}
.laby-page--play {
  position: fixed;
  /* Below {@link StudentLayout} slim header; var set on layout when Laby is immersive. */
  top: var(--fus-laby-chrome-top, 0px);
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 60;
  flex: none;
  height: auto;
  min-height: 0;
  max-height: none;
  touch-action: manipulation;
}
/**
 * iOS: when the browser has no usable Fullscreen API, we still cover the viewport (over the
 * slim app chrome) so the game uses the full screen area; exit via the same settings button.
 */
.laby-page--play.laby-page--pseudo-fs {
  top: 0 !important;
  z-index: 100050;
  padding-top: env(safe-area-inset-top, 0px);
  min-height: 100dvh;
  min-height: 100vh;
  box-sizing: border-box;
  background-image: none;
}

.laby-lobby {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  min-height: 0;
  pointer-events: auto;
}
.laby-play-gate-cta {
  pointer-events: auto;
  user-select: none;
  -webkit-tap-highlight-color: rgba(255, 255, 255, 0.2);
  touch-action: manipulation;
  min-height: 52px;
  padding: 0 24px;
  border-radius: 14px;
  font-size: 1rem;
  font-weight: 800;
  color: #0f172a;
  background: linear-gradient(180deg, #a5b4fc, #6366f1);
  border: 1px solid rgba(199, 210, 254, 0.9);
  box-shadow: 0 4px 20px rgba(99, 102, 241, 0.5);
  cursor: pointer;
}
.laby-play-gate-cta:hover {
  filter: brightness(1.06);
}
.laby-play-gate-cta:active {
  transform: scale(0.98);
  filter: brightness(0.95);
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
/**
 * While HTML settings are open, the WebGL host must not receive pointer events.
 * `pointer-events: none` on a parent does **not** disable the canvas: descendants keep
 * the default `auto` and still win hit-testing, so range sliders on the overlay never
 * receive drags. Force the whole embed subtree (canvas + any injected nodes) inert.
 */
.laby-host--no-pointer,
.laby-host--no-pointer * {
  pointer-events: none;
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
  width: 200px;
  max-width: 200px;
  flex-shrink: 0;
  pointer-events: none;
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
/* Single tappable control above the canvas when the 2D engine menu is open (mobile). */
.laby-engine-gui-chrome {
  position: absolute;
  top: max(6px, env(safe-area-inset-top, 0px));
  right: max(8px, env(safe-area-inset-right, 0px));
  z-index: 50;
  pointer-events: auto;
  display: flex;
  align-items: flex-start;
  justify-content: flex-end;
}

.laby-top-hud {
  position: absolute;
  top: max(6px, env(safe-area-inset-top, 0px));
  left: max(8px, env(safe-area-inset-left, 0px));
  right: max(8px, env(safe-area-inset-right, 0px));
  z-index: 46;
  display: flex;
  flex-direction: row;
  /* `flex-start`: when the right column stacks tall (portrait), do not vertically center the
   * back button + coords in that column — that pushed them toward the middle of the screen. */
  align-items: flex-start;
  justify-content: space-between;
  min-height: 44px;
  pointer-events: none;
  gap: 8px;
}
.laby-top-hud-left,
.laby-top-hud-right {
  flex: 0 0 auto;
  display: flex;
  align-items: flex-start;
  pointer-events: none;
}
.laby-top-hud-left-stack {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  pointer-events: auto;
}
.laby-top-hud-right {
  flex-direction: row;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
  /**
   * Same as former `.laby-right-actions` — the mobile look-pad can overlap; keep buttons tappable.
   */
}
.laby-top-hud-center-wrap {
  position: absolute;
  left: 50%;
  /* Match `.laby-back` vertical padding so coords line up with the back label, not the bar’s vertical center. */
  top: 8px;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  max-width: min(90vw, 220px);
  z-index: 45;
  pointer-events: none;
}
.laby-top-hud-center {
  max-width: min(50vw, 200px);
  font-size: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: rgba(226, 232, 240, 0.88);
  text-align: center;
  line-height: 1.2;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.65);
  white-space: nowrap;
}

/* Portrait: stack action buttons on the top-right. */
@media (orientation: portrait) {
  .laby-top-hud-right {
    flex-direction: column;
    flex-wrap: nowrap;
    justify-content: flex-start;
    align-items: stretch;
    margin-left: auto;
  }
}

.laby-pvp-indicator {
  position: absolute;
  top: 54px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 35;
  pointer-events: none;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.04em;
  padding: 4px 10px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(4px);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.85);
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  animation: laby-pvp-pulse 1.8s ease-in-out infinite;
}

.laby-pvp-indicator.laby-pvp-red {
  color: #fecaca;
  box-shadow: 0 0 0 1px rgba(220, 38, 38, 0.8), 0 0 16px rgba(220, 38, 38, 0.4);
}

.laby-pvp-indicator.laby-pvp-purple {
  color: #e9d5ff;
  box-shadow: 0 0 0 1px rgba(179, 102, 255, 0.8), 0 0 14px rgba(179, 102, 255, 0.4);
}

.laby-pvp-karma {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.laby-pvp-icon {
  font-size: 14px;
  line-height: 1;
}

.laby-pvp-value {
  font-size: 15px;
  font-weight: 800;
}

.laby-pvp-suffix {
  font-size: 11px;
  opacity: 0.8;
  font-weight: 500;
}

@keyframes laby-pvp-pulse {
  0%,
  100% {
    opacity: 0.95;
  }
  50% {
    opacity: 0.65;
  }
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
.laby-settings,
.laby-inv-open,
.laby-players-online,
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
  position: relative;
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
.laby-btn-badge {
  position: absolute;
  top: 2px;
  right: 2px;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 800;
  line-height: 16px;
  text-align: center;
  color: #0f172a;
  background: #7dd3fc;
  box-shadow: 0 0 0 1px rgba(15, 23, 42, 0.35);
  pointer-events: none;
}
.laby-settings:hover,
.laby-inv-open:hover,
.laby-players-online:hover,
.laby-flag-place:hover,
.laby-flag-tp:hover {
  background: rgba(30, 41, 59, 0.92);
}
.laby-settings:active,
.laby-inv-open:active,
.laby-players-online:active,
.laby-flag-place:active,
.laby-flag-tp:active {
  background: rgba(51, 65, 85, 0.95);
  transform: scale(0.97);
}
.laby-players-panel {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 72px 16px 24px;
  background: rgba(2, 6, 23, 0.55);
  pointer-events: auto;
  touch-action: manipulation;
}
.laby-players-card {
  width: 100%;
  max-width: 360px;
  max-height: min(58vh, 420px);
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px;
  border-radius: 16px;
  background: rgba(15, 23, 42, 0.96);
  border: 1px solid rgba(148, 163, 184, 0.28);
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.45);
  overflow: hidden;
}
.laby-players-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.laby-players-title {
  font-size: 15px;
  font-weight: 800;
  color: #e2e8f0;
}
.laby-players-close {
  min-width: 36px;
  min-height: 36px;
  border: none;
  border-radius: 10px;
  font-size: 22px;
  line-height: 1;
  color: #94a3b8;
  background: rgba(30, 41, 59, 0.65);
  cursor: pointer;
}
.laby-players-close:hover {
  color: #e2e8f0;
  background: rgba(51, 65, 85, 0.9);
}
.laby-players-empty {
  margin: 0;
  font-size: 13px;
  line-height: 1.4;
  color: #94a3b8;
}
.laby-players-list {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.laby-players-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 10px;
  background: rgba(30, 41, 59, 0.55);
  border: 1px solid rgba(148, 163, 184, 0.12);
}
.laby-players-name {
  font-size: 13px;
  font-weight: 700;
  color: #e2e8f0;
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.laby-players-tp {
  flex: 0 0 auto;
  padding: 6px 10px;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 800;
  color: #0f172a;
  background: linear-gradient(135deg, #7dd3fc, #a78bfa);
  border: none;
  cursor: pointer;
  touch-action: manipulation;
}
.laby-players-tp:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.laby-boot {
  position: absolute;
  inset: 0;
  /**
   * Above the game host (z 1). Canvas stays `display:none` until play starts, so a frosted
   * scrim lets the lobby background show through without flashing half-meshed terrain.
   */
  z-index: 30;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  background: rgba(15, 23, 42, 0.82);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
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
  color: #e2e8f0;
  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.75);
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
/**
 * Death overlay — full-viewport scrim above the canvas but below the system settings modal
 * (z 55 puts us over .laby-right-actions at 40 and the HUD, under .laby-boot at 30? no: we
 * use 70 so the dead state beats the boot spinner too if a death transition happens mid-load).
 * Pointer-events are enabled so the "Відродитися" button captures taps even though the rest
 * of the HUD has disabled input via the dead-freeze in fusDeathScreenInstall.
 */
.laby-death {
  position: absolute;
  inset: 0;
  z-index: 70;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(2, 6, 23, 0.72);
  backdrop-filter: blur(3px);
  -webkit-backdrop-filter: blur(3px);
  pointer-events: auto;
  user-select: none;
  -webkit-user-select: none;
  animation: laby-death-in 220ms ease-out;
}
.laby-death-card {
  min-width: 260px;
  max-width: 380px;
  padding: 22px 24px 20px;
  border-radius: 18px;
  background: linear-gradient(180deg, rgba(30, 10, 10, 0.95), rgba(15, 23, 42, 0.95));
  border: 1px solid rgba(248, 113, 113, 0.35);
  box-shadow: 0 24px 48px rgba(127, 29, 29, 0.35), 0 0 0 1px rgba(0, 0, 0, 0.4) inset;
  text-align: center;
  color: #fecaca;
}
.laby-death-title {
  font-size: 22px;
  font-weight: 900;
  letter-spacing: 0.5px;
  color: #fca5a5;
  text-shadow: 0 2px 0 rgba(0, 0, 0, 0.6);
  margin-bottom: 10px;
}
.laby-death-killer {
  font-size: 14px;
  font-weight: 600;
  color: #e2e8f0;
  margin-bottom: 18px;
  word-break: break-word;
}
.laby-death-killer strong {
  color: #fde68a;
  font-weight: 800;
}
.laby-death-respawn {
  appearance: none;
  -webkit-appearance: none;
  border: 0;
  cursor: pointer;
  width: 100%;
  padding: 12px 18px;
  border-radius: 12px;
  font-size: 15px;
  font-weight: 800;
  color: #052e16;
  background: linear-gradient(180deg, #86efac, #22c55e);
  box-shadow: 0 4px 0 #166534, 0 8px 16px rgba(34, 197, 94, 0.35);
  transition: transform 80ms ease, box-shadow 80ms ease;
  touch-action: manipulation;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
}
.laby-death-respawn-key {
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.02em;
  color: #052e16;
  background: rgba(255, 255, 255, 0.55);
  border: 1px solid rgba(5, 46, 22, 0.25);
  border-radius: 6px;
  padding: 2px 8px;
  line-height: 1;
}
.laby-death-respawn:hover {
  filter: brightness(1.05);
}
.laby-death-respawn:active {
  transform: translateY(2px);
  box-shadow: 0 2px 0 #166534, 0 4px 10px rgba(34, 197, 94, 0.3);
}
@keyframes laby-death-in {
  from { opacity: 0; transform: scale(0.98); }
  to { opacity: 1; transform: scale(1); }
}
/**
 * FUS: HTML нативне меню «Налаштування» (замінює canvas GuiOptions). z-index 60 — під екраном смерті (70).
 * No backdrop-filter: full-viewport blur + range slider updates repainted the whole scrim every
 * frame on some desktops and looked like a hard freeze (no JS errors).
 */
.laby-settings-html {
  position: absolute;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: max(12px, env(safe-area-inset-top, 0px)) 16px 24px;
  background: rgba(2, 6, 23, 0.88);
  pointer-events: auto;
  -webkit-tap-highlight-color: transparent;
  overflow: auto;
  user-select: auto;
  -webkit-user-select: auto;
}
.laby-settings-html-card {
  width: 100%;
  max-width: 400px;
  margin-top: 4vh;
  padding: 20px 20px 18px;
  border-radius: 18px;
  background: linear-gradient(180deg, rgba(30, 41, 59, 0.97), rgba(15, 23, 42, 0.98));
  border: 1px solid rgba(148, 163, 184, 0.28);
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.45);
  color: #e2e8f0;
  font-size: 14px;
  line-height: 1.45;
  touch-action: manipulation;
  user-select: auto;
  -webkit-user-select: auto;
}
.laby-settings-html-title {
  margin: 0 0 16px;
  font-size: 20px;
  font-weight: 800;
  letter-spacing: 0.02em;
  color: #f8fafc;
  text-align: center;
}
.laby-settings-row {
  margin-bottom: 14px;
}
.laby-settings-check {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  cursor: pointer;
  user-select: none;
}
.laby-settings-check input {
  margin-top: 3px;
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  accent-color: #a78bfa;
  cursor: pointer;
}
.laby-settings-label {
  font-weight: 600;
  color: #cbd5e1;
  margin-bottom: 6px;
  font-size: 13px;
}
.laby-settings-range {
  position: relative;
  z-index: 2;
  width: 100%;
  height: 28px;
  accent-color: #a78bfa;
  cursor: pointer;
  pointer-events: auto;
  touch-action: none;
}
.laby-settings-actions {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 6px;
  padding-top: 4px;
}
.laby-settings-btn {
  appearance: none;
  -webkit-appearance: none;
  border: 0;
  border-radius: 12px;
  padding: 12px 14px;
  font-size: 14px;
  font-weight: 800;
  cursor: pointer;
  touch-action: manipulation;
  width: 100%;
  transition: filter 0.1s ease, transform 0.08s ease;
}
.laby-settings-btn:active {
  transform: scale(0.98);
}
.laby-settings-btn-primary {
  color: #0f172a;
  background: linear-gradient(180deg, #e9d5ff, #c4b5fd);
  box-shadow: 0 2px 0 #7c3aed;
}
.laby-settings-btn-secondary {
  color: #e2e8f0;
  background: rgba(51, 65, 85, 0.85);
  border: 1px solid rgba(148, 163, 184, 0.3);
}
.laby-settings-btn-warn {
  color: #fef3c7;
  background: rgba(120, 53, 15, 0.5);
  border: 1px solid rgba(251, 191, 36, 0.4);
  font-size: 13px;
  font-weight: 700;
}
</style>
