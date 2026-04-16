<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useUserStore } from '@/stores/user'
import { useBlockWorldSession } from '@/stores/blockWorldSession'
import { rtdb } from '@/firebase/config'
import {
  FUS_LABY_CANONICAL_SPAWN,
  FUS_SHARED_WORLD_LABY_ID,
} from '@/game/labyminecraft/fusSharedWorldLabyId'
import { blockWorldAggressiveMobile, useTouchGameControls } from '@/game/minebase/utils'
import {
  LABY_WORLD_BOOT_MAX_MS,
  attachFusLabySharedWorldBridge,
  createAndLoadLabyWorldFromSeeds,
  waitUntilLabyPlaying,
  waitUntilLabyWorldStable,
} from '@/game/labyminecraft/createFusLabySharedBridge'
import { attachFusLabyPresence } from '@/game/labyminecraft/attachFusLabyPresence'
import { buildLabyPresenceDoc } from '@/game/labyminecraft/labyPresencePayload'
import { fillLabyPlayerHotbar } from '@/game/labyminecraft/labyHotbarDefaults'
import { tickLabyFusMobileAutoJump } from '@/game/labyminecraft/labyMobileAutoJump'
import {
  fetchSharedWorldLabySpawnPose,
  loadSharedWorldInitialState,
  overwriteSharedWorldLabySpawn,
} from '@/game/sharedWorldFirestore'
import { normalizeSkinUrlForPresence } from '@/utils/presenceSkinUrl'
import GameProfile from '@labymc/src/js/net/minecraft/util/GameProfile.js'
import Session from '@labymc/src/js/net/minecraft/util/Session.js'
import UUID from '@labymc/src/js/net/minecraft/util/UUID.js'
import Keyboard from '@labymc/src/js/net/minecraft/util/Keyboard.js'
import { Home, Settings } from 'lucide-vue-next'

const router = useRouter()
const auth = useAuthStore()
const userStore = useUserStore()
const bwSession = useBlockWorldSession()

const hostId = 'laby-js-mc-canvas-host'
const error = ref('')
/** @type {import('vue').Ref<unknown>} */
const gameMc = ref(null)
/** Integer block-style coords, no label (e.g. "12  64  -3"). */
const positionLine = ref('—')
const respawning = ref(false)
/** @type {import('vue').Ref<{ x: number; y: number; z: number } | null>} */
const sharedSpawn = ref(null)

const showTouchHud = computed(() => useTouchGameControls())
/** Updated each HUD tick so we hide HTML chrome when a vanilla canvas GUI (inventory, etc.) is open. */
const labyCanvasGuiOpen = ref(false)
/** FUS-owned settings panel (replaces non-interactive canvas {@link GuiOptions} in embed). */
const labyVueSettingsOpen = ref(false)
/** Needs `VITE_FIREBASE_DATABASE_URL` so RTDB presence (other players) is enabled. */
const noRtdb = computed(() => !rtdb)
/** Full-screen overlay during Laby bootstrap (max duration capped in `createFusLabySharedBridge`). */
const worldBootstrapping = ref(true)
/** Local copies while the Vue settings sheet is open (written back on Done / backdrop close). */
const panelFov = ref(70)
const panelViewDistance = ref(3)
const panelAo = ref(true)
const panelBob = ref(true)

const labyRdMax = computed(() => (blockWorldAggressiveMobile() ? 6 : 16))

const sneakKeyCode = computed(() => {
  const mc = gameMc.value
  const k = mc?.settings?.keyCrouching
  return typeof k === 'string' && k ? k : 'ShiftLeft'
})

/** Dynamic joystick (minecraft-web-client style). */
const joy = ref({
  active: false,
  bx: 0,
  by: 0,
  kx: 0,
  ky: 0,
  pid: -1,
})
const JOY_RING_PX = 56
const JOY_KNOB_MAX = 36

/** @type {{ dispose: () => void } | null} */
let bridge = null
/** @type {{ dispose: () => void } | null} */
let presence = null
/** Stops deferred {@link attachFusLabyPresence} if the view unmounts mid-wait. */
let presenceAttachCancelled = false
let coordsRaf = 0
/** mrdoob stats.js FPS panel */
let statsPanel = null
/** @type {{ x: number; y: number; id: number; t: number; travel: number } | null} */
let lookPan = null

function sanitizeMcUsername(name) {
  const t = name.trim() || 'Student'
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

function buildPresencePayloadFromMc(mc) {
  const skinUrl = resolvePresenceSkinUrl(auth.profile, userStore.items)
  const photoUrl = normalizeSkinUrlForPresence(auth.profile?.avatar?.photoUrl ?? null)
  return buildLabyPresenceDoc(mc.player, {
    displayName: auth.profile?.displayName || 'Гравець',
    skinUrl,
    photoUrl,
  })
}

function applySpawnPose(mc, pose) {
  if (!pose || !mc?.world || !mc.player) return
  if (Number.isFinite(pose.x) && Number.isFinite(pose.y) && Number.isFinite(pose.z)) {
    mc.world.spawn.x = pose.x
    mc.world.spawn.y = pose.y
    mc.world.spawn.z = pose.z
    mc.player.respawn()
    return
  }
  if (Number.isFinite(pose.x) && Number.isFinite(pose.z)) {
    mc.world.setSpawn(pose.x, pose.z)
    mc.player.respawn()
  }
}

/** Prefer pointer/touch events over `click` so controls work under mobile hit-testing quirks. */
function isPrimaryPointer(ev) {
  if (ev.pointerType === 'mouse' && ev.button !== 0) return false
  return true
}

function syncLabyPanelFromMc() {
  const s = gameMc.value?.settings
  if (!s) return
  panelFov.value = s.fov
  panelViewDistance.value = s.viewDistance
  panelAo.value = s.ambientOcclusion
  panelBob.value = s.viewBobbing
}

function closeLabyVueSettings() {
  const mc = gameMc.value
  const s = mc?.settings
  if (s) {
    const prevAo = s.ambientOcclusion
    s.fov = Math.max(50, Math.min(100, Math.round(Number(panelFov.value))))
    s.viewDistance = Math.max(2, Math.min(labyRdMax.value, Math.round(Number(panelViewDistance.value))))
    s.ambientOcclusion = Boolean(panelAo.value)
    s.viewBobbing = Boolean(panelBob.value)
    if (s.ambientOcclusion !== prevAo) {
      try {
        mc.worldRenderer?.rebuildAll?.()
      } catch {
        /* ignore */
      }
    }
    try {
      s.save?.()
    } catch {
      /* ignore */
    }
  }
  labyVueSettingsOpen.value = false
}

function toggleLabyVueSettings() {
  if (worldBootstrapping.value || !gameMc.value?.settings) return
  const mc = gameMc.value
  if (mc.currentScreen != null && !labyVueSettingsOpen.value) return
  if (labyVueSettingsOpen.value) {
    closeLabyVueSettings()
  } else {
    syncLabyPanelFromMc()
    labyVueSettingsOpen.value = true
  }
}

function onSettingsPointerUp(ev) {
  ev.stopPropagation()
  if (!isPrimaryPointer(ev)) return
  toggleLabyVueSettings()
}

/** iOS/WebKit sometimes skips `pointerup` on small icon buttons; mirror with `touchend`. */
function onSettingsTouchEnd(ev) {
  ev.preventDefault()
  ev.stopPropagation()
  toggleLabyVueSettings()
}

function onHomePointerUp(ev) {
  ev.stopPropagation()
  if (!isPrimaryPointer(ev)) return
  if (respawning.value) return
  void respawnToSharedSpawn()
}

function onHomeTouchEnd(ev) {
  ev.preventDefault()
  ev.stopPropagation()
  if (respawning.value) return
  void respawnToSharedSpawn()
}

function tickCoordsHud() {
  coordsRaf = 0
  statsPanel?.begin()
  try {
    const mc = gameMc.value
    labyCanvasGuiOpen.value = Boolean(mc && mc.currentScreen != null)
    if (mc?.player && mc.world) {
      const p = mc.player
      positionLine.value = `${Math.round(p.x)}  ${Math.round(p.y)}  ${Math.round(p.z)}`
      if (showTouchHud.value) {
        const wantsMove =
          Keyboard.isKeyDown('KeyW') ||
          Keyboard.isKeyDown('KeyA') ||
          Keyboard.isKeyDown('KeyS') ||
          Keyboard.isKeyDown('KeyD')
        tickLabyFusMobileAutoJump(mc, { enabled: true, wantsMove })
      }
    }
  } finally {
    statsPanel?.end()
    coordsRaf = requestAnimationFrame(tickCoordsHud)
  }
}

function attachFpsStats() {
  if (statsPanel) return
  void import('stats.js').then((mod) => {
    const Stats = mod.default
    statsPanel = new Stats()
    statsPanel.showPanel(0)
    const dom = statsPanel.dom
    dom.style.cssText =
      'position:fixed;z-index:9999;left:8px;right:auto;top:auto;bottom:max(8px, env(safe-area-inset-bottom, 0px));cursor:pointer'
    document.body.appendChild(dom)
  })
}

function detachFpsStats() {
  if (!statsPanel) return
  try {
    statsPanel.dom.remove()
  } catch {
    /* ignore */
  }
  statsPanel = null
}

async function respawnToSharedSpawn() {
  const mc = gameMc.value
  if (!mc?.world || !mc.player || respawning.value) return
  respawning.value = true
  try {
    let pose = await fetchSharedWorldLabySpawnPose(FUS_SHARED_WORLD_LABY_ID)
    if (!pose || !Number.isFinite(pose.x) || !Number.isFinite(pose.z)) {
      pose = sharedSpawn.value
    }
    if (pose && (Number.isFinite(pose.y) || Number.isFinite(pose.x))) {
      applySpawnPose(mc, pose)
    } else {
      mc.player.respawn()
    }
  } catch (e) {
    console.warn('[labyminecraft] respawnToSharedSpawn', e)
    try {
      mc.player.respawn()
    } catch {
      /* ignore */
    }
  } finally {
    respawning.value = false
  }
}

function keyDown(code) {
  Keyboard.setState(code, true)
}
function keyUp(code) {
  Keyboard.setState(code, false)
}
function clearStickKeys() {
  ;['KeyW', 'KeyA', 'KeyS', 'KeyD'].forEach((c) => Keyboard.setState(c, false))
}

function clearMoveKeys() {
  const mc = gameMc.value
  const sne = mc?.settings?.keyCrouching || 'ShiftLeft'
  ;['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', sne].forEach((c) => Keyboard.setState(c, false))
}

function applyStickToKeyboard() {
  const j = joy.value
  const dx = j.kx
  const dy = j.ky
  const mag = Math.hypot(dx, dy)
  const dead = 4
  if (!j.active || mag < dead) {
    clearStickKeys()
    return
  }
  const nx = dx / mag
  const ny = dy / mag
  const f = (-ny * mag) / JOY_KNOB_MAX
  const s = (nx * mag) / JOY_KNOB_MAX
  Keyboard.setState('KeyW', f > 0.2)
  Keyboard.setState('KeyS', f < -0.2)
  // Match keyboard: A = +moveStrafe, D = −moveStrafe — stick right must press D.
  Keyboard.setState('KeyD', s > 0.2)
  Keyboard.setState('KeyA', s < -0.2)
}

function onLeftZoneDown(ev) {
  if (!(ev.currentTarget instanceof HTMLElement)) return
  const w = window.innerWidth
  const h = window.innerHeight
  if (ev.clientX > w * 0.48) return
  if (ev.clientY > h - 64) return
  joy.value = {
    active: true,
    bx: ev.clientX,
    by: ev.clientY,
    kx: 0,
    ky: 0,
    pid: ev.pointerId,
  }
  try {
    ev.currentTarget.setPointerCapture(ev.pointerId)
  } catch {
    /* ignore */
  }
}

function onLeftZoneMove(ev) {
  if (joy.value.pid !== ev.pointerId || !joy.value.active) return
  const dx = ev.clientX - joy.value.bx
  const dy = ev.clientY - joy.value.by
  const m = Math.hypot(dx, dy)
  const cap = JOY_KNOB_MAX
  if (m <= cap) {
    joy.value.kx = dx
    joy.value.ky = dy
  } else {
    joy.value.kx = (dx / m) * cap
    joy.value.ky = (dy / m) * cap
  }
  applyStickToKeyboard()
}

function onLeftZoneUp(ev) {
  if (joy.value.pid !== ev.pointerId) return
  joy.value.active = false
  joy.value.pid = -1
  joy.value.kx = 0
  joy.value.ky = 0
  clearStickKeys()
  if (ev.currentTarget instanceof HTMLElement) {
    try {
      ev.currentTarget.releasePointerCapture(ev.pointerId)
    } catch {
      /* ignore */
    }
  }
}

function onLeftZoneLostCapture(ev) {
  if (joy.value.pid !== ev.pointerId) return
  joy.value.active = false
  joy.value.pid = -1
  joy.value.kx = 0
  joy.value.ky = 0
  clearStickKeys()
}

function onRightLookDown(ev) {
  if (!(ev.currentTarget instanceof HTMLElement)) return
  lookPan = {
    x: ev.clientX,
    y: ev.clientY,
    id: ev.pointerId,
    t: performance.now(),
    travel: 0,
  }
  try {
    ev.currentTarget.setPointerCapture(ev.pointerId)
  } catch {
    /* ignore */
  }
}

function onRightLookMove(ev) {
  if (!lookPan || lookPan.id !== ev.pointerId) return
  const dx = ev.clientX - lookPan.x
  const dy = ev.clientY - lookPan.y
  lookPan.travel += Math.hypot(dx, dy)
  lookPan.x = ev.clientX
  lookPan.y = ev.clientY
  const mc = gameMc.value
  if (!mc?.window) return
  const win = mc.window
  /* Touch deltas are large vs pointer lock movementX; keep below vendor mobile *10 path to avoid spin. */
  const sens = blockWorldAggressiveMobile() ? 2.4 : 2.0
  win.mouseMotionX += dx * sens
  win.mouseMotionY -= dy * sens
}

function onRightLookEnd(ev) {
  let tapMine = false
  if (lookPan && lookPan.id === ev.pointerId) {
    const travel = lookPan.travel
    const dt = performance.now() - lookPan.t
    tapMine = travel < 16 && dt < 450
    lookPan = null
  }
  if (tapMine) {
    const mc = gameMc.value
    if (mc && typeof mc.onMouseClicked === 'function') mc.onMouseClicked(0)
  }
  if (ev.currentTarget instanceof HTMLElement) {
    try {
      ev.currentTarget.releasePointerCapture(ev.pointerId)
    } catch {
      /* ignore */
    }
  }
}

function onRightLookLostCapture(ev) {
  if (lookPan && lookPan.id === ev.pointerId) lookPan = null
}

function resetTouchHudState() {
  joy.value = { active: false, bx: 0, by: 0, kx: 0, ky: 0, pid: -1 }
  clearStickKeys()
  const mc = gameMc.value
  const sne = mc?.settings?.keyCrouching || 'ShiftLeft'
  Keyboard.setState('Space', false)
  Keyboard.setState(sne, false)
  lookPan = null
}

/** Laby uses button 2 for place-on-adjacent-cell (see Minecraft.js). */
function tapPlaceBlock() {
  const mc = gameMc.value
  if (mc && typeof mc.onMouseClicked === 'function') mc.onMouseClicked(2)
}

onMounted(async () => {
  window.addEventListener('keydown', onLabySettingsEscapeKey, true)
  error.value = ''
  bridge = null
  presence = null
  presenceAttachCancelled = false
  gameMc.value = null
  worldBootstrapping.value = true
  bwSession.setImmersive(true)

  const base = `${import.meta.env.BASE_URL || '/'}`.replace(/\/?$/, '/')
  window.__LABY_MC_ASSET_BASE__ = `${base}labyminecraft/`
  window.__LABY_MC_FUS_EMBED__ = true

  try {
    const [, , startMod] = await Promise.all([
      auth.init(),
      userStore.fetchItems(),
      import('@labymc/src/js/Start.js'),
    ])
    const { default: Start } = startMod
    const start = new Start()
    const mc = await start.launch(hostId)
    if (mc.settings) {
      mc.settings.viewDistance = Math.min(3, mc.settings.viewDistance)
    }
    if (blockWorldAggressiveMobile() && mc.settings) {
      mc.settings.viewDistance = Math.min(2, mc.settings.viewDistance)
    }
    if (useTouchGameControls() && mc.settings) {
      const s = mc.settings.sensitivity ?? 100
      mc.settings.sensitivity = Math.min(120, Math.max(85, s))
    }

    const displayName = sanitizeMcUsername(auth.profile?.displayName ?? 'Student')
    const profile = new GameProfile(UUID.randomUUID(), displayName)
    mc.setSession(new Session(profile, ''), false)

    const initial = await loadSharedWorldInitialState(FUS_SHARED_WORLD_LABY_ID)
    if (!initial.seeds) {
      error.value = 'Не вдалося завантажити seeds світу'
      return
    }

    const labySpawnPose = {
      x: FUS_LABY_CANONICAL_SPAWN.x,
      y: FUS_LABY_CANONICAL_SPAWN.y,
      z: FUS_LABY_CANONICAL_SPAWN.z,
    }
    try {
      await overwriteSharedWorldLabySpawn(FUS_SHARED_WORLD_LABY_ID, labySpawnPose)
    } catch (e) {
      console.warn('[labyminecraft] overwriteSharedWorldLabySpawn', e)
    }

    await createAndLoadLabyWorldFromSeeds(mc, initial.seeds, {
      labySpawn: labySpawnPose,
    })
    if (!mc.world) {
      error.value = 'Світ не ініціалізовано'
      return
    }

    const bootDeadline = performance.now() + LABY_WORLD_BOOT_MAX_MS
    /** Merge Firestore/RTDB blocks while terrain chunks stream — avoids 20s+ “empty world” after loader. */
    bridge = attachFusLabySharedWorldBridge(
      mc,
      mc.world,
      FUS_SHARED_WORLD_LABY_ID,
      initial.blocks,
      initial.blocksFingerprint,
    )

    await waitUntilLabyPlaying(mc, { deadlineMs: bootDeadline })

    if (!mc.world) {
      error.value = 'Світ не ініціалізовано'
      try {
        bridge?.dispose()
      } catch {
        /* ignore */
      }
      bridge = null
      return
    }

    mc.world.spawn.x = labySpawnPose.x
    mc.world.spawn.y = labySpawnPose.y
    mc.world.spawn.z = labySpawnPose.z
    if (mc.player && typeof mc.player.respawn === 'function') {
      mc.player.respawn()
    }

    const spFinal = mc.world.getSpawn()
    sharedSpawn.value = { x: spFinal.x, y: spFinal.y, z: spFinal.z }

    gameMc.value = mc
    attachFpsStats()
    try {
      fillLabyPlayerHotbar(mc.player.inventory)
      mc.player.inventory.selectedSlotIndex = 0
    } catch (e) {
      console.warn('[labyminecraft] hotbar fill', e)
    }
    coordsRaf = requestAnimationFrame(tickCoordsHud)

    /** `waitUntilLabyPlaying` can consume the whole boot budget; never race initial apply with 0ms. */
    const initialApplyWaitMs = Math.max(4500, bootDeadline - performance.now() + 3500)
    await Promise.race([
      bridge.initialApplyComplete,
      new Promise((r) => {
        setTimeout(r, initialApplyWaitMs)
      }),
    ])
    await waitUntilLabyWorldStable(mc, {
      maxMs: Math.max(800, Math.min(3500, bootDeadline - performance.now() + 1500)),
    })

    const uid = auth.user?.uid
    if (rtdb && uid) {
      void (async () => {
        for (let i = 0; i < 100; i++) {
          if (presenceAttachCancelled) return
          if (mc.worldRenderer?.scene) {
            try {
              presence = attachFusLabyPresence({
                mc,
                worldId: FUS_SHARED_WORLD_LABY_ID,
                uid,
                buildPresence: () => buildPresencePayloadFromMc(mc),
              })
            } catch (e) {
              console.warn('[labyminecraft] attachFusLabyPresence', e)
            }
            return
          }
          await new Promise((r) => setTimeout(r, 40))
        }
        if (!presenceAttachCancelled) {
          console.warn('[labyminecraft] worldRenderer.scene not ready — multiplayer avatars disabled')
        }
      })()
    }
  } catch (e) {
    console.error('[labyminecraft]', e)
    error.value = e instanceof Error ? e.message : String(e)
    try {
      bridge?.dispose()
    } catch {
      /* ignore */
    }
    bridge = null
    try {
      delete window.__LABY_MC_FUS_EMBED__
    } catch {
      window.__LABY_MC_FUS_EMBED__ = false
    }
  } finally {
    worldBootstrapping.value = false
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onLabySettingsEscapeKey, true)
  labyVueSettingsOpen.value = false
  presenceAttachCancelled = true
  bwSession.setImmersive(false)
  detachFpsStats()
  if (coordsRaf) cancelAnimationFrame(coordsRaf)
  coordsRaf = 0
  gameMc.value = null
  try {
    presence?.dispose()
  } catch {
    /* ignore */
  }
  presence = null
  try {
    bridge?.dispose()
  } catch {
    /* ignore */
  }
  bridge = null
  try {
    if (window.app && typeof window.app.stop === 'function') {
      window.app.stop()
    }
  } catch {
    /* ignore */
  }
  window.app = undefined
  try {
    delete window.__LABY_MC_ASSET_BASE__
  } catch {
    window.__LABY_MC_ASSET_BASE__ = ''
  }
  try {
    delete window.__LABY_MC_FUS_EMBED__
  } catch {
    window.__LABY_MC_FUS_EMBED__ = false
  }
  clearMoveKeys()
  joy.value = { active: false, bx: 0, by: 0, kx: 0, ky: 0, pid: -1 }
  lookPan = null
})

function goBack() {
  router.push({ name: 'student-home' })
}

function onLabySettingsEscapeKey(ev) {
  if (ev.key !== 'Escape' || !labyVueSettingsOpen.value) return
  ev.preventDefault()
  ev.stopPropagation()
  closeLabyVueSettings()
}

/** Keeps backdrop pointerdown from closing the sheet when interacting with the panel. */
function onLabySettingsPanelPointerdown(ev) {
  ev.stopPropagation()
}
</script>

<template>
  <div class="laby-wrap">
    <div v-if="worldBootstrapping" class="laby-boot" aria-busy="true" aria-label="Завантаження світу">
      <div class="laby-boot-inner">
        <div class="laby-boot-spinner" />
        <p class="laby-boot-text">Завантаження світу…</p>
      </div>
    </div>
    <p v-if="error" class="err">{{ error }}</p>
    <p v-if="noRtdb" class="hud-warn">
      Немає Realtime Database (<code class="code-env">VITE_FIREBASE_DATABASE_URL</code>) — аватари інших гравців
      не показуються.
    </p>

    <div v-if="showTouchHud" class="touch-layer" @pointercancel="resetTouchHudState">
      <!-- Left: invisible catch; joystick ring appears at press (minecraft-web-client style). -->
      <div
        class="touch-left-zone"
        aria-hidden="true"
        @pointerdown.prevent="onLeftZoneDown"
        @pointermove.prevent="onLeftZoneMove"
        @pointerup.prevent="onLeftZoneUp"
        @pointercancel="onLeftZoneUp"
        @lostpointercapture="onLeftZoneLostCapture"
      />
      <div
        v-show="joy.active"
        class="touch-joy-root"
        :style="{
          left: joy.bx - JOY_RING_PX + 'px',
          top: joy.by - JOY_RING_PX + 'px',
        }"
        aria-hidden="true"
      >
        <div class="touch-joy-ring" />
        <div
          class="touch-joy-knob"
          :style="{ transform: `translate(${joy.kx}px, ${joy.ky}px)` }"
        />
      </div>
      <!-- Right: camera (short tap = break block). -->
      <div
        class="touch-look-zone"
        aria-label="Огляд"
        @pointerdown.prevent="onRightLookDown"
        @pointermove.prevent="onRightLookMove"
        @pointerup.prevent="onRightLookEnd"
        @pointercancel="onRightLookEnd"
        @lostpointercapture="onRightLookLostCapture"
      />
      <div class="touch-edge-actions" aria-label="Дії">
        <button
          type="button"
          class="touch-edge-btn"
          aria-label="Стрибок"
          @pointerdown.prevent="keyDown('Space')"
          @pointerup.prevent="keyUp('Space')"
          @pointercancel="keyUp('Space')"
          @pointerleave="keyUp('Space')"
        >
          <span class="touch-edge-icon touch-edge-icon--up" aria-hidden="true" />
        </button>
        <button
          type="button"
          class="touch-edge-btn touch-edge-btn--place"
          aria-label="Поставити блок"
          @pointerdown.prevent.stop
          @pointerup.prevent.stop="tapPlaceBlock"
          @pointercancel.stop
        >
          <span class="touch-edge-place" aria-hidden="true" />
        </button>
        <button
          type="button"
          class="touch-edge-btn"
          aria-label="Присісти"
          @pointerdown.prevent="keyDown(sneakKeyCode)"
          @pointerup.prevent="keyUp(sneakKeyCode)"
          @pointercancel="keyUp(sneakKeyCode)"
          @pointerleave="keyUp(sneakKeyCode)"
        >
          <span class="touch-edge-icon touch-edge-icon--down" aria-hidden="true" />
        </button>
      </div>
    </div>

    <div :id="hostId" class="host" />

    <!-- Last in tree + high z-index so canvas/touch layers never steal taps from HUD chrome. -->
    <div class="laby-topbar">
      <button type="button" class="exit" @click="goBack">← Назад</button>
      <div class="laby-pos" aria-label="Позиція">{{ positionLine }}</div>
      <div class="laby-topbar-actions">
        <button
          type="button"
          class="hud-icon-btn"
          aria-label="Налаштування гри"
          @pointerup.stop="onSettingsPointerUp"
          @touchend.stop="onSettingsTouchEnd"
        >
          <Settings :size="20" :stroke-width="2" />
        </button>
        <button
          type="button"
          class="hud-icon-btn"
          :disabled="respawning"
          aria-label="На спільний спавн"
          @pointerup.stop="onHomePointerUp"
          @touchend.stop="onHomeTouchEnd"
        >
          <Home :size="20" :stroke-width="2" />
        </button>
      </div>
    </div>

    <div
      v-if="labyVueSettingsOpen && gameMc?.settings"
      class="laby-settings-root"
      aria-hidden="false"
    >
      <div
        class="laby-settings-backdrop"
        aria-hidden="true"
        @pointerdown.prevent="closeLabyVueSettings"
      />
      <div
        class="laby-settings-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="laby-settings-title"
        @pointerdown="onLabySettingsPanelPointerdown"
      >
        <h2 id="laby-settings-title" class="laby-settings-title">Налаштування</h2>
        <div class="laby-settings-body">
          <label class="laby-settings-row">
            <span class="laby-settings-label">Кут огляду (FOV)</span>
            <input
              v-model.number="panelFov"
              class="laby-settings-range"
              type="range"
              min="50"
              max="100"
              step="1"
            />
            <span class="laby-settings-num">{{ panelFov }}</span>
          </label>
          <label class="laby-settings-row">
            <span class="laby-settings-label">Дальність прорисовки</span>
            <input
              v-model.number="panelViewDistance"
              class="laby-settings-range"
              type="range"
              min="2"
              :max="labyRdMax"
              step="1"
            />
            <span class="laby-settings-num">{{ panelViewDistance }}</span>
          </label>
          <label class="laby-settings-check">
            <input v-model="panelAo" type="checkbox" />
            <span>Тіні блоків (AO)</span>
          </label>
          <label class="laby-settings-check">
            <input v-model="panelBob" type="checkbox" />
            <span>Похитування камери</span>
          </label>
        </div>
        <button type="button" class="laby-settings-done" @click="closeLabyVueSettings">Готово</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.laby-boot {
  position: absolute;
  inset: 0;
  z-index: 80;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(20, 16, 24, 0.92);
  pointer-events: all;
}
.laby-boot-inner {
  text-align: center;
  color: #e8e4ef;
}
.laby-boot-spinner {
  width: 44px;
  height: 44px;
  margin: 0 auto 16px;
  border: 3px solid rgba(255, 255, 255, 0.15);
  border-top-color: #9b7ed8;
  border-radius: 50%;
  animation: laby-boot-spin 0.75s linear infinite;
}
.laby-boot-text {
  margin: 0;
  font-size: 15px;
  opacity: 0.92;
}
@keyframes laby-boot-spin {
  to {
    transform: rotate(360deg);
  }
}
.laby-wrap {
  position: fixed;
  inset: 0;
  z-index: 50;
  background: #141018;
  -webkit-user-select: none;
  user-select: none;
  -webkit-touch-callout: none;
  -webkit-tap-highlight-color: transparent;
}
.laby-settings-root {
  position: fixed;
  inset: 0;
  z-index: 110;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  padding: max(12px, env(safe-area-inset-bottom, 0px)) 14px;
  pointer-events: none;
}
.laby-settings-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  pointer-events: auto;
}
.laby-settings-panel {
  position: relative;
  width: min(360px, 100%);
  max-height: min(72vh, 520px);
  overflow: auto;
  padding: 16px 16px 14px;
  border-radius: 14px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: rgba(22, 18, 30, 0.97);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.55);
  pointer-events: auto;
  -webkit-user-select: none;
  user-select: none;
}
.laby-settings-title {
  margin: 0 0 14px;
  font-size: 17px;
  font-weight: 700;
  color: #f4f0fa;
}
.laby-settings-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin-bottom: 14px;
}
.laby-settings-row {
  display: grid;
  grid-template-columns: 1fr auto;
  grid-template-rows: auto auto;
  gap: 6px 10px;
  align-items: center;
  font-size: 13px;
  color: rgba(255, 255, 255, 0.88);
}
.laby-settings-label {
  grid-column: 1 / -1;
}
.laby-settings-range {
  grid-column: 1 / 2;
  width: 100%;
  accent-color: #9b7ed8;
  touch-action: manipulation;
}
.laby-settings-num {
  grid-column: 2 / 3;
  grid-row: 2 / 3;
  min-width: 2.2em;
  text-align: right;
  font-variant-numeric: tabular-nums;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.72);
}
.laby-settings-check {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 14px;
  color: rgba(255, 255, 255, 0.9);
  cursor: pointer;
  touch-action: manipulation;
}
.laby-settings-check input {
  width: 18px;
  height: 18px;
  accent-color: #9b7ed8;
}
.laby-settings-done {
  width: 100%;
  padding: 11px 14px;
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  background: linear-gradient(180deg, rgba(155, 126, 216, 0.35), rgba(120, 90, 180, 0.25));
  color: #fff;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}
.laby-settings-done:active {
  transform: scale(0.98);
}
.laby-topbar {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  z-index: 100;
  padding: max(6px, env(safe-area-inset-top, 0px)) 10px 6px;
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 8px;
  pointer-events: auto;
  isolation: isolate;
}
.laby-topbar-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  pointer-events: auto;
}
.exit {
  padding: 7px 11px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  background: rgba(0, 0, 0, 0.45);
  color: #fff;
  font-size: 13px;
  cursor: pointer;
  touch-action: manipulation;
  -webkit-user-select: none;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
}
.laby-pos {
  text-align: center;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: rgba(255, 255, 255, 0.88);
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.85);
  pointer-events: none;
}
.hud-icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  padding: 0;
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.22);
  background: rgba(0, 0, 0, 0.45);
  color: #e8e8ef;
  cursor: pointer;
  touch-action: manipulation;
  -webkit-user-select: none;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
}
.hud-icon-btn:disabled {
  opacity: 0.45;
  cursor: wait;
}
.err {
  position: absolute;
  top: 52px;
  left: 10px;
  right: 10px;
  z-index: 70;
  color: #fecaca;
  font-size: 13px;
  -webkit-user-select: none;
  user-select: none;
}
.hud-warn {
  position: absolute;
  left: 10px;
  right: 10px;
  top: calc(max(6px, env(safe-area-inset-top, 0px)) + 46px);
  z-index: 69;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 10px;
  line-height: 1.35;
  color: #fcd34d;
  text-align: center;
  text-shadow: 0 1px 2px #000;
  pointer-events: none;
}
.hud-warn .code-env {
  font-size: 9px;
  color: #fde68a;
}
.touch-layer {
  position: absolute;
  inset: 0;
  z-index: 55;
  pointer-events: none;
  box-sizing: border-box;
  -webkit-user-select: none;
  user-select: none;
  -webkit-touch-callout: none;
  -webkit-tap-highlight-color: transparent;
}
.touch-left-zone {
  position: absolute;
  left: 0;
  top: 50px;
  bottom: max(56px, calc(env(safe-area-inset-bottom, 0px) + 48px));
  width: 48%;
  z-index: 56;
  pointer-events: auto;
  touch-action: none;
}
.touch-joy-root {
  position: absolute;
  z-index: 58;
  width: 112px;
  height: 112px;
  margin: 0;
  pointer-events: none;
}
.touch-joy-ring {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: rgba(32, 40, 48, 0.55);
  border: 2px solid rgba(255, 255, 255, 0.22);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
}
.touch-joy-knob {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 36px;
  height: 36px;
  margin: -18px 0 0 -18px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.88);
  border: 1px solid rgba(0, 0, 0, 0.2);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.25);
  pointer-events: none;
}
.touch-look-zone {
  position: absolute;
  left: 48%;
  right: 56px;
  top: 50px;
  bottom: max(56px, calc(env(safe-area-inset-bottom, 0px) + 48px));
  z-index: 56;
  pointer-events: auto;
  touch-action: none;
}
.touch-edge-actions {
  position: absolute;
  right: max(6px, env(safe-area-inset-right, 0px));
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  flex-direction: column;
  gap: 14px;
  z-index: 60;
  pointer-events: auto;
}
.touch-edge-btn {
  width: 48px;
  height: 48px;
  padding: 0;
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.35);
  background: rgba(8, 8, 12, 0.82);
  display: flex;
  align-items: center;
  justify-content: center;
  touch-action: none;
  cursor: pointer;
  -webkit-user-select: none;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
}
.touch-edge-btn:active {
  background: rgba(40, 40, 48, 0.95);
}
.touch-edge-icon {
  display: block;
  width: 0;
  height: 0;
  border-style: solid;
  pointer-events: none;
}
.touch-edge-icon--up {
  margin-top: 4px;
  border-width: 0 7px 10px 7px;
  border-color: transparent transparent #f4f4f8 transparent;
}
.touch-edge-icon--down {
  margin-top: -4px;
  border-width: 10px 7px 0 7px;
  border-color: #f4f4f8 transparent transparent transparent;
}
.touch-edge-btn--place {
  border-color: rgba(130, 210, 150, 0.45);
}
.touch-edge-place {
  display: block;
  width: 14px;
  height: 14px;
  box-sizing: border-box;
  border: 2px solid #f4f4f8;
  border-radius: 2px;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.2);
}
.host {
  position: absolute;
  inset: 0;
}
.host :deep(canvas) {
  position: absolute;
  image-rendering: pixelated;
  -webkit-user-select: none;
  user-select: none;
  -webkit-touch-callout: none;
  -webkit-tap-highlight-color: transparent;
}
</style>
