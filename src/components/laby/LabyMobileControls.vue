<script setup>
/**
 * Touch-screen HUD for the embedded js-minecraft engine. Provides:
 *   - left joystick → WASD (via engine `Keyboard.setState`)
 *   - full-screen look layer (below joystick + action buttons): **drag** → camera look; **short tap** → primary action
 *   - one optional mode toggle (hit vs place) when a **block** is held; hidden for tools/fist (always hit)
 *   - jump at the right-center edge
 *
 * Rendered only when a coarse pointer is detected. Desktop is unaffected.
 *
 * IMPORTANT: we deliberately use pointer events (not touch events) so the engine's
 * own `registerFusEmbedTouchInputBridge` keeps handling hotbar taps at window level —
 * The look layer is full-screen under the fixed controls; action buttons sit on the right edge
 * (do not cover the hotbar strip — hotbar is handled at window level).
 *
 * Android Chrome: `touch-action: manipulation` + pointer capture often yields a single move then
 * silence; we use `touch-action: none` on drag surfaces and route move/up/cancel on `window`
 * while a pointer is active (same pattern as many mobile game joysticks).
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import Keyboard from '@labymc/src/js/net/minecraft/util/Keyboard.js'

const props = defineProps({
  mc: { type: Object, default: null },
})

const isTouch = computed(() => {
  if (typeof navigator === 'undefined') return false
  if (navigator.maxTouchPoints > 0) return true
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(pointer: coarse)').matches
  }
  return false
})

/** Joystick geometry — nub can travel `JOY_RADIUS` px from centre before it clamps. */
const JOY_RADIUS = 58
/** Dead-zone (px) around centre to avoid jitter from resting finger. */
const JOY_DEADZONE = 10
/** Per-px look multiplier so the right-half drag feels comparable to the engine's vanilla ×10. */
const LOOK_SENSITIVITY = 7.2

const joyEl = ref(null)
/** Look layer ref — needed to release pointer capture when handling `pointerup` from `window`. */
const lookEl = ref(/** @type {HTMLElement | null} */ (null))

const joyActive = ref(false)
const joyNub = ref({ x: 0, y: 0 })
const joyPointerId = ref(/** @type {number | null} */ (null))
const joyCenter = ref({ x: 0, y: 0 })

function clearMoveKeys() {
  Keyboard.setState('KeyW', false)
  Keyboard.setState('KeyS', false)
  Keyboard.setState('KeyA', false)
  Keyboard.setState('KeyD', false)
}

function applyMoveKeysFromVector(dx, dy) {
  const mag = Math.hypot(dx, dy)
  if (mag < JOY_DEADZONE) {
    clearMoveKeys()
    return
  }
  // Screen-space: +x = right, +y = down. We want +y (down) → KeyS, so forward is -y.
  const deg = (Math.atan2(-dy, dx) * 180) / Math.PI
  // 90° overlap sectors so diagonals press two keys at once (W+A etc.).
  Keyboard.setState('KeyW', deg > 22.5 && deg < 157.5)
  Keyboard.setState('KeyS', deg < -22.5 && deg > -157.5)
  Keyboard.setState('KeyD', deg > -67.5 && deg < 67.5)
  Keyboard.setState('KeyA', deg > 112.5 || deg < -112.5)
}

/** @type {{ move: (e: PointerEvent) => void, up: (e: PointerEvent) => void } | null} */
let joyWindowHandlers = null
/** @type {{ move: (e: PointerEvent) => void, up: (e: PointerEvent) => void } | null} */
let lookWindowHandlers = null

const winMoveOpts = { capture: true, passive: false }
const winEndOpts = { capture: true, passive: false }

/** Pixel-art jump arrow — `public/labyminecraft/src/resources/gui/jump_icon.png` */
const jumpIconUrl = `${import.meta.env.BASE_URL}labyminecraft/src/resources/gui/jump_icon.png`

function unbindJoyWindow() {
  if (!joyWindowHandlers) return
  window.removeEventListener('pointermove', joyWindowHandlers.move, winMoveOpts)
  window.removeEventListener('pointerup', joyWindowHandlers.up, winEndOpts)
  window.removeEventListener('pointercancel', joyWindowHandlers.up, winEndOpts)
  joyWindowHandlers = null
}

function bindJoyWindow() {
  unbindJoyWindow()
  const move = /** @param {PointerEvent} ev */ (ev) => {
    onJoyMove(ev)
  }
  const up = /** @param {PointerEvent} ev */ (ev) => {
    onJoyUp(ev)
  }
  joyWindowHandlers = { move, up }
  window.addEventListener('pointermove', move, winMoveOpts)
  window.addEventListener('pointerup', up, winEndOpts)
  window.addEventListener('pointercancel', up, winEndOpts)
}

function onJoyDown(e) {
  if (props.mc?.fusLabyChannelLockMove) {
    clearMoveKeys()
    return
  }
  if (joyPointerId.value !== null) return
  const el = joyEl.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  joyCenter.value = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  joyPointerId.value = e.pointerId
  joyActive.value = true
  try {
    el.setPointerCapture(e.pointerId)
  } catch {
    /* not every browser supports pointer capture on div */
  }
  bindJoyWindow()
  onJoyMove(e)
  e.preventDefault()
  e.stopPropagation()
}

function onJoyMove(e) {
  if (props.mc?.fusLabyChannelLockMove) {
    clearMoveKeys()
    return
  }
  if (!joyActive.value || e.pointerId !== joyPointerId.value) return
  const dx = e.clientX - joyCenter.value.x
  const dy = e.clientY - joyCenter.value.y
  const d = Math.hypot(dx, dy)
  const nx = d > JOY_RADIUS ? (dx / d) * JOY_RADIUS : dx
  const ny = d > JOY_RADIUS ? (dy / d) * JOY_RADIUS : dy
  joyNub.value = { x: nx, y: ny }
  applyMoveKeysFromVector(nx, ny)
  e.preventDefault()
  e.stopPropagation()
}

function onJoyUp(e) {
  if (e.pointerId !== joyPointerId.value) return
  unbindJoyWindow()
  const el = joyEl.value
  try {
    el?.releasePointerCapture?.(e.pointerId)
  } catch {
    /* ignore */
  }
  joyPointerId.value = null
  joyActive.value = false
  joyNub.value = { x: 0, y: 0 }
  clearMoveKeys()
  e.preventDefault()
  e.stopPropagation()
}

const lookPointerId = ref(/** @type {number | null} */ (null))
const lookPrev = ref({ x: 0, y: 0 })
/** Pixels before a touch is treated as “look drag” instead of a tap (action). */
const LOOK_DRAG_THRESHOLD = 12
/** If pointerup is later than this after pointerdown, we do not treat it as a tap (no action). */
const TAP_MAX_MS = 320

/** Re-read slot meta — `mc` is not always deep-reactive for inventory. */
const uiTick = ref(0)
let uiTickIv = 0
onMounted(() => {
  uiTickIv = window.setInterval(() => {
    uiTick.value++
  }, 200)
})

function getSelectedSlotMeta() {
  const mc = props.mc
  if (!mc?.player?.inventory) return null
  const idx = mc.player.inventory.selectedSlotIndex ?? 0
  const meta = mc.fusHotbarSlotMeta
  return Array.isArray(meta) ? meta[idx] : null
}

const holdingBlock = computed(() => {
  void uiTick.value
  return getSelectedSlotMeta()?.kind === 'block'
})

/** When holding a block: false = break/melee, true = place. Ignored when not holding a block. */
const preferBuild = ref(true)

function onModeToggle(e) {
  preferBuild.value = !preferBuild.value
  e.preventDefault()
  e.stopPropagation()
}

let lookDown = { x: 0, y: 0 }
let lookDownAtMs = 0
let lookDragging = false

function clearLookActionHold() {
  if (props.mc) props.mc.fusMobileBreakHeld = false
}

function unbindLookWindow() {
  if (!lookWindowHandlers) return
  window.removeEventListener('pointermove', lookWindowHandlers.move, winMoveOpts)
  window.removeEventListener('pointerup', lookWindowHandlers.up, winEndOpts)
  window.removeEventListener('pointercancel', lookWindowHandlers.up, winEndOpts)
  lookWindowHandlers = null
}

function bindLookWindow() {
  unbindLookWindow()
  const move = /** @param {PointerEvent} ev */ (ev) => {
    onLookMove(ev)
  }
  const up = /** @param {PointerEvent} ev */ (ev) => {
    onLookUp(ev)
  }
  lookWindowHandlers = { move, up }
  window.addEventListener('pointermove', move, winMoveOpts)
  window.addEventListener('pointerup', up, winEndOpts)
  window.addEventListener('pointercancel', up, winEndOpts)
}

function onLookDown(e) {
  if (lookPointerId.value !== null) return
  const mc = props.mc
  if (!mc) return
  lookPointerId.value = e.pointerId
  lookDown = { x: e.clientX, y: e.clientY }
  lookDownAtMs = typeof performance !== 'undefined' ? performance.now() : Date.now()
  lookPrev.value = { x: e.clientX, y: e.clientY }
  lookDragging = false
  try {
    const host = lookEl.value || /** @type {HTMLElement | null} */ (e.currentTarget)
    host?.setPointerCapture?.(e.pointerId)
  } catch {
    /* ignore */
  }
  bindLookWindow()
  e.preventDefault()
  e.stopPropagation()
}

function onLookMove(e) {
  if (e.pointerId !== lookPointerId.value) return
  const dx = e.clientX - lookDown.x
  const dy = e.clientY - lookDown.y
  if (!lookDragging && Math.hypot(dx, dy) >= LOOK_DRAG_THRESHOLD) {
    lookDragging = true
    clearLookActionHold()
    lookPrev.value = { x: e.clientX, y: e.clientY }
    e.preventDefault()
    e.stopPropagation()
    return
  }
  if (!lookDragging) {
    e.preventDefault()
    e.stopPropagation()
    return
  }
  const pdx = e.clientX - lookPrev.value.x
  const pdy = e.clientY - lookPrev.value.y
  lookPrev.value = { x: e.clientX, y: e.clientY }
  const win = props.mc?.window
  if (win) {
    win.mouseMotionX = (win.mouseMotionX || 0) + pdx * LOOK_SENSITIVITY
    win.mouseMotionY = (win.mouseMotionY || 0) - pdy * LOOK_SENSITIVITY
  }
  e.preventDefault()
  e.stopPropagation()
}

function onLookUp(e) {
  if (e.pointerId !== lookPointerId.value) return
  unbindLookWindow()
  try {
    lookEl.value?.releasePointerCapture?.(e.pointerId)
  } catch {
    /* ignore */
  }
  lookPointerId.value = null
  const mc = props.mc
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
  const elapsed = now - lookDownAtMs
  const isTap = !lookDragging && elapsed <= TAP_MAX_MS
  if (isTap && mc) {
    const block = getSelectedSlotMeta()?.kind === 'block'
    const usePlace = block && preferBuild.value
    if (usePlace) {
      mc.onMouseClicked?.(2)
    } else {
      mc.onMouseClicked?.(0)
    }
  }
  clearLookActionHold()
  e.preventDefault()
  e.stopPropagation()
}

function onJumpDown(e) {
  if (props.mc?.fusLabyChannelLockMove) return
  Keyboard.setState('Space', true)
  e.preventDefault()
  e.stopPropagation()
}
function onJumpUp(e) {
  Keyboard.setState('Space', false)
  e.preventDefault()
  e.stopPropagation()
}

onBeforeUnmount(() => {
  unbindJoyWindow()
  unbindLookWindow()
  if (uiTickIv) {
    clearInterval(uiTickIv)
    uiTickIv = 0
  }
  clearLookActionHold()
  if (props.mc) props.mc.fusMobileBreakHeld = false
  clearMoveKeys()
  Keyboard.setState('Space', false)
})
</script>

<template>
  <div v-if="isTouch && mc" class="laby-mhud" aria-hidden="true">
    <div
      ref="lookEl"
      class="laby-mhud-look"
      @pointerdown="onLookDown"
    />
    <div
      ref="joyEl"
      class="laby-mhud-joystick"
      :class="{ 'is-active': joyActive }"
      @pointerdown="onJoyDown"
    >
      <div class="laby-mhud-joystick-base" />
      <div
        class="laby-mhud-joystick-nub"
        :style="{ transform: `translate(${joyNub.x}px, ${joyNub.y}px)` }"
      />
    </div>
    <div class="laby-mhud-actions">
      <button
        v-if="holdingBlock"
        type="button"
        class="laby-mhud-btn laby-mhud-btn-mode"
        :class="{ 'is-build': preferBuild }"
        :aria-pressed="preferBuild"
        :aria-label="preferBuild ? 'Режим: будувати' : 'Режим: ламати / бити'"
        @pointerdown="onModeToggle"
      >
        {{ preferBuild ? '▣' : '⛏' }}
      </button>
      <button
        type="button"
        class="laby-mhud-btn laby-mhud-btn-jump"
        aria-label="Стрибок"
        @pointerdown="onJumpDown"
        @pointerup="onJumpUp"
        @pointercancel="onJumpUp"
        @pointerleave="onJumpUp"
      >
        <img class="laby-mhud-btn-jump-icon" :src="jumpIconUrl" alt="" width="32" height="32" draggable="false" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.laby-mhud {
  position: absolute;
  inset: 0;
  z-index: 44;
  pointer-events: none;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
  /* Android: `manipulation` lets the browser claim gestures — drags on the look layer stall. */
  touch-action: none;
}

/* Full screen so every drag routes to look (FUS embed disables canvas touch-look). Hotbar still works:
 * `GameWindow` uses window-capture for bottom strip before this layer sees the event. */
.laby-mhud-look {
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: auto;
  touch-action: none;
  background: transparent;
}

.laby-mhud-joystick {
  position: absolute;
  left: 22px;
  bottom: 22px;
  z-index: 2;
  width: 140px;
  height: 140px;
  pointer-events: auto;
  touch-action: none;
}
.laby-mhud-joystick-base {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: rgba(15, 23, 42, 0.5);
  border: 2px solid rgba(148, 163, 184, 0.4);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
}
.laby-mhud-joystick.is-active .laby-mhud-joystick-base {
  background: rgba(30, 41, 59, 0.6);
  border-color: rgba(226, 232, 240, 0.55);
}
.laby-mhud-joystick-nub {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 54px;
  height: 54px;
  margin-left: -27px;
  margin-top: -27px;
  border-radius: 50%;
  background: rgba(100, 116, 139, 0.8);
  border: 2px solid rgba(241, 245, 249, 0.85);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.4);
  pointer-events: none;
  transition: transform 0.02s linear;
}

.laby-mhud-actions {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 12px;
  pointer-events: none;
  z-index: 2;
}
.laby-mhud-btn {
  pointer-events: auto;
  touch-action: manipulation;
  width: 72px;
  height: 72px;
  border-radius: 50%;
  background: rgba(15, 23, 42, 0.55);
  border: 2px solid rgba(148, 163, 184, 0.55);
  color: rgba(241, 245, 249, 0.95);
  font-size: 28px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  user-select: none;
  line-height: 1;
  padding: 0;
  -webkit-tap-highlight-color: transparent;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
}
.laby-mhud-btn:active {
  transform: scale(0.94);
  filter: brightness(1.25);
}
.laby-mhud-btn-mode {
  background: rgba(127, 29, 29, 0.55);
  border-color: rgba(252, 165, 165, 0.45);
}
.laby-mhud-btn-mode.is-build {
  background: rgba(6, 95, 70, 0.65);
  border-color: rgba(110, 231, 183, 0.45);
}
/**
 * Match {@link LabyJsMinecraftView} `.laby-settings` / `.laby-inv-open` (top HUD) — same
 * slate panel, 12px radius, 1px border — not the circular `.laby-mhud-btn` base.
 */
.laby-mhud-btn-jump {
  width: 52px;
  height: 52px;
  min-width: 48px;
  min-height: 44px;
  border-radius: 12px;
  background: rgba(15, 23, 42, 0.78);
  border: 1px solid rgba(148, 163, 184, 0.28);
  box-shadow: none;
  color: transparent;
  font-size: 0;
  -webkit-tap-highlight-color: rgba(255, 255, 255, 0.2);
  filter: none;
}
.laby-mhud-btn-jump:hover {
  background: rgba(30, 41, 59, 0.92);
}
.laby-mhud-btn-jump:active {
  background: rgba(51, 65, 85, 0.95);
  transform: scale(0.97);
  filter: none;
}
.laby-mhud-btn-jump-icon {
  width: 32px;
  height: 32px;
  object-fit: contain;
  object-position: center;
  user-select: none;
  -webkit-user-drag: none;
  pointer-events: none;
  image-rendering: crisp-edges;
}
</style>
