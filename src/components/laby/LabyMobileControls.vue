<script setup>
/**
 * Touch-screen HUD for the embedded js-minecraft engine. Provides:
 *   - left joystick → WASD (via engine `Keyboard.setState`)
 *   - right-half drag → camera look (writes into {@code mc.window.mouseMotion*})
 *   - bottom-right action buttons (Break / Jump / Place)
 *
 * Rendered only when a coarse pointer is detected. Desktop is unaffected.
 *
 * IMPORTANT: we deliberately use pointer events (not touch events) so the engine's
 * own `registerFusEmbedTouchInputBridge` keeps handling hotbar taps at window level —
 * this overlay sits BELOW the hotbar row (uses `bottom: 100px`) so it never steals those taps.
 */
import { computed, onBeforeUnmount, ref } from 'vue'
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
const LOOK_SENSITIVITY = 9

const joyEl = ref(null)
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

function onJoyDown(e) {
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
  onJoyMove(e)
  e.preventDefault()
  e.stopPropagation()
}

function onJoyMove(e) {
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

function onLookDown(e) {
  if (lookPointerId.value !== null) return
  lookPointerId.value = e.pointerId
  lookPrev.value = { x: e.clientX, y: e.clientY }
  try {
    e.currentTarget.setPointerCapture?.(e.pointerId)
  } catch {
    /* ignore */
  }
  e.preventDefault()
  e.stopPropagation()
}

function onLookMove(e) {
  if (e.pointerId !== lookPointerId.value) return
  const dx = e.clientX - lookPrev.value.x
  const dy = e.clientY - lookPrev.value.y
  lookPrev.value = { x: e.clientX, y: e.clientY }
  const win = props.mc?.window
  if (win) {
    // Match engine convention (see GameWindow.registerMobileListeners): touchmove → ×10, y flipped.
    win.mouseMotionX = (win.mouseMotionX || 0) + dx * LOOK_SENSITIVITY
    win.mouseMotionY = (win.mouseMotionY || 0) - dy * LOOK_SENSITIVITY
  }
  e.preventDefault()
  e.stopPropagation()
}

function onLookUp(e) {
  if (e.pointerId !== lookPointerId.value) return
  try {
    e.currentTarget.releasePointerCapture?.(e.pointerId)
  } catch {
    /* ignore */
  }
  lookPointerId.value = null
  e.preventDefault()
  e.stopPropagation()
}

function onJumpDown(e) {
  Keyboard.setState('Space', true)
  e.preventDefault()
  e.stopPropagation()
}
function onJumpUp(e) {
  Keyboard.setState('Space', false)
  e.preventDefault()
  e.stopPropagation()
}

/** Break is continuous while pressed — engine's own mouse-click auto-repeat uses the same 250 ms cadence. */
let breakIv = 0
function onBreakDown(e) {
  if (breakIv) return
  const mc = props.mc
  if (!mc) return
  mc.onMouseClicked?.(0)
  breakIv = window.setInterval(() => {
    const cur = props.mc
    cur?.onMouseClicked?.(0)
  }, 250)
  e.preventDefault()
  e.stopPropagation()
}
function onBreakUp(e) {
  if (breakIv) {
    window.clearInterval(breakIv)
    breakIv = 0
  }
  e.preventDefault()
  e.stopPropagation()
}

function onPlaceDown(e) {
  props.mc?.onMouseClicked?.(2)
  e.preventDefault()
  e.stopPropagation()
}

onBeforeUnmount(() => {
  if (breakIv) {
    window.clearInterval(breakIv)
    breakIv = 0
  }
  clearMoveKeys()
  Keyboard.setState('Space', false)
})
</script>

<template>
  <div v-if="isTouch && mc" class="laby-mhud" aria-hidden="true">
    <div
      class="laby-mhud-look"
      @pointerdown="onLookDown"
      @pointermove="onLookMove"
      @pointerup="onLookUp"
      @pointercancel="onLookUp"
    />
    <div
      ref="joyEl"
      class="laby-mhud-joystick"
      :class="{ 'is-active': joyActive }"
      @pointerdown="onJoyDown"
      @pointermove="onJoyMove"
      @pointerup="onJoyUp"
      @pointercancel="onJoyUp"
    >
      <div class="laby-mhud-joystick-base" />
      <div
        class="laby-mhud-joystick-nub"
        :style="{ transform: `translate(${joyNub.x}px, ${joyNub.y}px)` }"
      />
    </div>
    <div class="laby-mhud-actions">
      <button
        type="button"
        class="laby-mhud-btn laby-mhud-btn-place"
        aria-label="Поставити блок"
        @pointerdown="onPlaceDown"
      >▣</button>
      <button
        type="button"
        class="laby-mhud-btn laby-mhud-btn-jump"
        aria-label="Стрибок"
        @pointerdown="onJumpDown"
        @pointerup="onJumpUp"
        @pointercancel="onJumpUp"
        @pointerleave="onJumpUp"
      >⤒</button>
      <button
        type="button"
        class="laby-mhud-btn laby-mhud-btn-break"
        aria-label="Ламати"
        @pointerdown="onBreakDown"
        @pointerup="onBreakUp"
        @pointercancel="onBreakUp"
        @pointerleave="onBreakUp"
      >⛏</button>
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
  touch-action: none;
}

/* Look drag zone: right half of screen, ending well above hotbar + action buttons. */
.laby-mhud-look {
  position: absolute;
  right: 0;
  top: 0;
  width: 50%;
  height: calc(100% - 200px);
  pointer-events: auto;
  touch-action: none;
  background: transparent;
}

.laby-mhud-joystick {
  position: absolute;
  left: 22px;
  bottom: 22px;
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
  /* Above the in-game hotbar (roughly ~60 px in CSS pixels at common scale factors). */
  right: 20px;
  bottom: 100px;
  display: grid;
  grid-template-columns: 72px 72px;
  grid-template-rows: 72px 72px;
  gap: 10px;
  pointer-events: none;
}
.laby-mhud-btn {
  pointer-events: auto;
  touch-action: none;
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
.laby-mhud-btn-place { grid-column: 2; grid-row: 1; background: rgba(6, 95, 70, 0.6); }
.laby-mhud-btn-jump  { grid-column: 1; grid-row: 2; background: rgba(37, 99, 235, 0.6); }
.laby-mhud-btn-break { grid-column: 2; grid-row: 2; background: rgba(127, 29, 29, 0.6); }
</style>
