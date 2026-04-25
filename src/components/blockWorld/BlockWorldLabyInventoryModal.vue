<script setup>
import { computed, ref, watch } from 'vue'

/** @see onDragStartPalette — some browsers only reliably expose text/plain on drop. */
const DRAG_MIME = 'application/x-fus-laby-inv'
const DRAG_PREFIX = 'fus-laby-inv:'
import creativeBg from '@labymc/src/resources/gui/container/creative.png'
import { parseBlockWorldItem } from '@/lib/blockWorldShopVisuals'
import { hotbarCellVisualForBwSlot } from '@/lib/blockWorldShopVisuals'
import { buildFusLabyHotbarFromProfile } from '@/lib/fusLabyHotbarFromProfile'
import { loadLabyHotbarItemIds, saveLabyHotbarItemIds } from '@/lib/fusLabyHotbarLayout'
import BlockWorldHotbarIconInner from '@/components/blockWorld/BlockWorldHotbarIconInner.vue'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  /** When true, hide the overlay (e.g. in-game pause/options open). Replaces v-show on
   *  the parent — `Teleport` is not a valid target for `v-show` and triggers a Vue warn. */
  labyEngineGuiOpen: { type: Boolean, default: false },
  uid: { type: String, default: '' },
  profile: { type: Object, default: null },
  shopItems: { type: Array, default: () => [] },
  /** Length 8 Firestore ids for engine slots 1–8 — from live `mc.fusHotbarSlotMeta` when opening. */
  liveHotbarItemIds: { type: Array, default: null },
  /** Live game instance — used for 3-face block icons (same as in-game hotbar). */
  gameMc: { type: Object, default: null },
})

const emit = defineEmits(['update:modelValue', 'saved'])

/** Ignore backdrop close briefly after open — same touch that opened from the game can otherwise hit the overlay. */
const backdropCloseOkAt = ref(0)

/** @type {import('vue').Ref<string[]>} */
const slotItemIds = ref(Array(8).fill(''))

/** Palette scroll: rows of 9 items (0 = first row visible in 9×5 grid). */
const paletteScrollRow = ref(0)

/** Click-to-move: first click arms, second click applies (mobile / no DnD). */
const pick = ref(
  /** @type {{ kind: 'palette' | 'hotbar'; itemId: string; slot?: number } | null} */ (null),
)

const ownedRows = computed(() => {
  const inv = new Set(props.profile?.inventory || [])
  const out = []
  for (const it of props.shopItems) {
    if (!it || typeof it !== 'object') continue
    if (!inv.has(it.id) || it.category !== 'block_world' || it.active === false) continue
    const bw = parseBlockWorldItem(it)
    if (!bw) continue
    out.push({ row: it, bw })
  }
  out.sort((a, b) =>
    String(a.row.name || a.row.id || '').localeCompare(String(b.row.name || b.row.id || ''), 'uk'),
  )
  return out
})

const paletteRows = computed(() => Math.max(1, Math.ceil(ownedRows.value.length / 9)))
const maxScrollRow = computed(() => Math.max(0, paletteRows.value - 5))

watch(
  () => ownedRows.value.length,
  () => {
    if (paletteScrollRow.value > maxScrollRow.value) {
      paletteScrollRow.value = maxScrollRow.value
    }
  },
)

/** Flat index → palette item id or empty. */
function paletteIdAt(cellIndex) {
  const i = paletteScrollRow.value * 9 + cellIndex
  const o = ownedRows.value[i]
  return o ? o.row.id : ''
}

function rowMetaForItemId(itemId) {
  if (!itemId) return null
  const hit = ownedRows.value.find((x) => x.row.id === itemId)
  if (hit) return hit.bw
  const row = props.shopItems.find((it) => it && typeof it === 'object' && it.id === itemId)
  return row ? parseBlockWorldItem(row) : null
}

function paletteVisual(cellIndex) {
  const id = paletteIdAt(cellIndex)
  if (!id) {
    return { type: 'emoji', text: '' }
  }
  const bw = rowMetaForItemId(id)
  if (!bw) {
    return { type: 'emoji', text: '?' }
  }
  return hotbarCellVisualForBwSlot({ kind: 'item', itemId: id, meta: bw, count: 1 })
}

const slotVisuals = computed(() => {
  const list = []
  list.push(hotbarCellVisualForBwSlot({ kind: 'fist' }))
  for (let si = 0; si < 8; si++) {
    const id = slotItemIds.value[si]
    if (!id) {
      list.push({ type: 'emoji', text: '+' })
      continue
    }
    const bw = rowMetaForItemId(id)
    if (!bw) {
      list.push({ type: 'emoji', text: '?' })
      continue
    }
    list.push(hotbarCellVisualForBwSlot({ kind: 'item', itemId: id, meta: bw, count: 1 }))
  }
  return list
})

function syncFromStorage() {
  if (!props.uid) return
  const s = loadLabyHotbarItemIds(props.uid)
  slotItemIds.value = s ? [...s] : Array(8).fill('')
}

function syncHotbarWhenOpen() {
  const live = props.liveHotbarItemIds
  if (Array.isArray(live) && live.length === 8) {
    slotItemIds.value = live.map((x) => (typeof x === 'string' ? x : ''))
    return
  }
  if (props.uid) {
    syncFromStorage()
  }
}

function persistAndSync() {
  if (props.uid) {
    saveLabyHotbarItemIds(props.uid, slotItemIds.value)
  }
  emit('saved')
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      syncHotbarWhenOpen()
      paletteScrollRow.value = 0
      pick.value = null
      backdropCloseOkAt.value = Date.now() + 450
    }
  },
)

function close() {
  pick.value = null
  emit('update:modelValue', false)
}

function onOverlayBackdropPointerDown(e) {
  if (e.target === e.currentTarget && Date.now() < backdropCloseOkAt.value) {
    e.preventDefault()
    e.stopPropagation()
  }
}

function onOverlayBackdropClick(e) {
  if (e.target !== e.currentTarget) return
  if (Date.now() < backdropCloseOkAt.value) return
  close()
}

function autofill() {
  const { slotMeta } = buildFusLabyHotbarFromProfile(props.profile, props.shopItems)
  const next = Array(8).fill('')
  for (let s = 1; s <= 8; s++) {
    const m = slotMeta[s]
    if (!m) continue
    if (m.kind === 'tool' && m.itemId) next[s - 1] = m.itemId
    if (m.kind === 'block' && m.itemId) next[s - 1] = m.itemId
  }
  slotItemIds.value = next
  persistAndSync()
}

// --- Drag & drop (desktop) ---

/** @param {DragEvent} e */
function onDragStartPalette(e, itemId) {
  if (!itemId) return
  const payload = JSON.stringify({ from: 'palette', itemId })
  try {
    e.dataTransfer?.setData(DRAG_MIME, payload)
  } catch {
    /* ignore */
  }
  e.dataTransfer?.setData('text/plain', `${DRAG_PREFIX}${payload}`)
  e.dataTransfer.effectAllowed = 'copy'
}

/** @param {DragEvent} e */
function onDragStartHotbar(e, engineSlot) {
  if (engineSlot < 1 || engineSlot > 8) {
    e.preventDefault()
    return
  }
  const id = slotItemIds.value[engineSlot - 1] || ''
  if (!id) {
    e.preventDefault()
    return
  }
  const payload = JSON.stringify({ from: 'hotbar', engineSlot, itemId: id })
  try {
    e.dataTransfer?.setData(DRAG_MIME, payload)
  } catch {
    /* ignore */
  }
  e.dataTransfer?.setData('text/plain', `${DRAG_PREFIX}${payload}`)
  e.dataTransfer.effectAllowed = 'move'
}

/** @param {DragEvent} e */
function parseDropPayload(e) {
  let raw = ''
  try {
    raw = e.dataTransfer?.getData(DRAG_MIME) || ''
  } catch {
    raw = ''
  }
  if (!raw) {
    const plain = e.dataTransfer?.getData('text/plain') || ''
    if (plain.startsWith(DRAG_PREFIX)) {
      raw = plain.slice(DRAG_PREFIX.length)
    }
  }
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** @param {DragEvent} e */
function onDragOverSlot(e) {
  e.preventDefault()
  if (e.dataTransfer) {
    e.dataTransfer.dropEffect = e.dataTransfer.effectAllowed === 'move' ? 'move' : 'copy'
  }
}

/** Hotbar slot 0 = fist — not a drop target; handlers no-op so Vue never binds `undefined`. */
function onHotbarDragEnterEngine(engineSlot, e) {
  if (engineSlot < 1 || engineSlot > 8) return
  e.preventDefault()
}

function onHotbarDragOverEngine(engineSlot, e) {
  if (engineSlot < 1 || engineSlot > 8) return
  onDragOverSlot(e)
}

/** @param {DragEvent} e */
function onDropHotbar(e, engineSlot) {
  e.preventDefault()
  if (engineSlot < 1 || engineSlot > 8) return
  const p = parseDropPayload(e)
  if (!p || !p.itemId) return
  const next = [...slotItemIds.value]
  if (p.from === 'hotbar' && typeof p.engineSlot === 'number') {
    const from = p.engineSlot - 1
    const to = engineSlot - 1
    if (from < 0 || from > 7 || from === to) return
    const t = next[from]
    next[from] = next[to]
    next[to] = t
  } else {
    next[engineSlot - 1] = p.itemId
  }
  slotItemIds.value = next
  persistAndSync()
}

function onHotbarDropEngine(engineSlot, e) {
  if (engineSlot < 1 || engineSlot > 8) return
  onDropHotbar(e, engineSlot)
}

/** Return item to pool: clear hotbar slot. */
/** @param {DragEvent} e */
function onDropPalette(e) {
  e.preventDefault()
  const p = parseDropPayload(e)
  if (!p || p.from !== 'hotbar' || typeof p.engineSlot !== 'number') return
  const si = p.engineSlot - 1
  if (si < 0 || si >= 8) return
  const next = [...slotItemIds.value]
  next[si] = ''
  slotItemIds.value = next
  persistAndSync()
}

// --- Click-to-pick (mobile / fallback) ---

function onPaletteClick(cellIndex) {
  const itemId = paletteIdAt(cellIndex)
  if (!itemId) return
  const cur = pick.value
  if (cur && cur.kind === 'hotbar' && typeof cur.slot === 'number') {
    assignHotbar(cur.slot, itemId)
    pick.value = null
    return
  }
  pick.value = { kind: 'palette', itemId }
}

function onHotbarClick(engineSlot) {
  if (engineSlot === 0) {
    pick.value = null
    return
  }
  const cur = pick.value
  if (cur?.kind === 'palette' && cur.itemId) {
    assignHotbar(engineSlot, cur.itemId)
    pick.value = null
    return
  }
  if (cur?.kind === 'hotbar' && typeof cur.slot === 'number' && cur.slot === engineSlot) {
    pick.value = null
    return
  }
  if (cur?.kind === 'hotbar' && typeof cur.slot === 'number' && cur.slot !== engineSlot) {
    swapHotbar(cur.slot, engineSlot)
    pick.value = null
    return
  }
  const id = engineSlot >= 1 && engineSlot <= 8 ? slotItemIds.value[engineSlot - 1] : ''
  if (!id) {
    if (cur?.kind === 'palette' && cur.itemId) {
      assignHotbar(engineSlot, cur.itemId)
      pick.value = null
    }
    return
  }
  pick.value = { kind: 'hotbar', itemId: id, slot: engineSlot }
}

function assignHotbar(engineSlot, itemId) {
  if (engineSlot < 1 || engineSlot > 8) return
  const next = [...slotItemIds.value]
  next[engineSlot - 1] = itemId || ''
  slotItemIds.value = next
  persistAndSync()
}

function swapHotbar(a, b) {
  if (a < 1 || a > 8 || b < 1 || b > 8) return
  const next = [...slotItemIds.value]
  const t = next[a - 1]
  next[a - 1] = next[b - 1]
  next[b - 1] = t
  slotItemIds.value = next
  persistAndSync()
}

/** @param {WheelEvent} e */
function onPaletteWheel(e) {
  if (maxScrollRow.value <= 0) return
  const d = e.deltaY > 0 ? 1 : -1
  paletteScrollRow.value = Math.min(maxScrollRow.value, Math.max(0, paletteScrollRow.value + d))
}

function paletteSlotClass(cellIndex) {
  const id = paletteIdAt(cellIndex)
  const active =
    pick.value?.kind === 'palette' && pick.value.itemId === id && id
  return { 'inv-slot--pick': !!active, 'inv-slot--empty': !id }
}

function hotbarSlotClass(ix) {
  const engineSlot = ix
  const active =
    pick.value?.kind === 'hotbar' && pick.value.slot === engineSlot && engineSlot >= 1
  return { 'inv-slot--pick': !!active }
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="modelValue && !labyEngineGuiOpen"
      class="inv-overlay"
      dir="ltr"
      role="dialog"
      aria-modal="true"
      @pointerdown.self="onOverlayBackdropPointerDown"
      @click.self="onOverlayBackdropClick"
    >
      <div class="inv-wrap">
        <!-- texture 195×136: palette 162×90 @ (8,17) 9×5; hotbar 162×17 @ (8,111) 9 slots -->
        <div class="inv-frame" @click.stop>
          <div class="inv-panel" :style="{ backgroundImage: `url(${creativeBg})` }">
            <button type="button" class="inv-auto" @click.stop="autofill">Авто</button>
            <div class="inv-palette" @wheel.prevent="onPaletteWheel">
              <button
                v-for="cellIndex in 45"
                :key="'p' + cellIndex"
                type="button"
                class="inv-slot"
                :class="paletteSlotClass(cellIndex - 1)"
                :draggable="!!paletteIdAt(cellIndex - 1)"
                @dragstart="onDragStartPalette($event, paletteIdAt(cellIndex - 1))"
                @dragenter.prevent
                @dragover.prevent="onDragOverSlot"
                @drop.prevent="onDropPalette"
                @click="onPaletteClick(cellIndex - 1)"
              >
                <BlockWorldHotbarIconInner
                  v-if="paletteIdAt(cellIndex - 1)"
                  class="inv-icon"
                  :minecraft="gameMc"
                  :block-icon-render-size="56"
                  :visual="paletteVisual(cellIndex - 1)"
                />
              </button>
            </div>

            <div class="inv-hotbar">
              <button
                v-for="ix in 9"
                :key="'h' + ix"
                type="button"
                class="inv-slot"
                :class="[
                  hotbarSlotClass(ix - 1),
                  { 'inv-slot--fist': ix === 1 },
                ]"
                :draggable="ix >= 2 && !!slotItemIds[ix - 2]"
                @dragstart="onDragStartHotbar($event, ix - 1)"
                @dragenter="onHotbarDragEnterEngine(ix - 1, $event)"
                @dragover="onHotbarDragOverEngine(ix - 1, $event)"
                @drop="onHotbarDropEngine(ix - 1, $event)"
                @click="onHotbarClick(ix - 1)"
              >
                <BlockWorldHotbarIconInner
                  class="inv-icon"
                  :minecraft="gameMc"
                  :block-icon-render-size="56"
                  :visual="slotVisuals[ix - 1]"
                />
              </button>
            </div>

            <div v-if="maxScrollRow > 0" class="inv-scrollbar">
              <input
                v-model.number="paletteScrollRow"
                class="inv-scroll-range"
                type="range"
                min="0"
                :max="maxScrollRow"
                step="1"
                aria-label="Прокрутка каталогу"
              />
            </div>

            <button type="button" class="inv-close" aria-label="Закрити" @click.stop="close">×</button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.inv-overlay {
  position: fixed;
  inset: 0;
  z-index: 120;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: min(12px, 2vw);
  background: rgba(2, 6, 23, 0.55);
  /** Grids must stay column-major LTR; OS/bidi must not mirror the 9×n layout. */
  direction: ltr;
  unicode-bidi: isolate;
}

.inv-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0;
  max-width: 100%;
}

.inv-frame {
  /** Fits phones without dominating the whole screen. */
  width: min(380px, calc(100vw - max(16px, env(safe-area-inset-left, 0px) + env(safe-area-inset-right, 0px))));
  max-width: 100%;
  filter: drop-shadow(0 12px 28px rgba(0, 0, 0, 0.55));
}

/**
 * `creative.png` is cropped to 195×136; slot regions match the overlay math below (1:1 with pixels).
 */
.inv-panel {
  position: relative;
  width: 100%;
  aspect-ratio: 195 / 136;
  overflow: hidden;
  background-repeat: no-repeat;
  background-position: 0 0;
  background-size: 100% 100%;
  image-rendering: pixelated;
  border-radius: 2px;
  direction: ltr;
}

/**
 * Use flex (not grid) for row-major LTR: some WebViews mirror CSS Grid when any ancestor
 * is RTL / bidi — flex row + `justify-content: flex-start` is harder to flip visually.
 */
.inv-palette {
  position: absolute;
  left: calc(8 / 195 * 100%);
  top: calc(17 / 136 * 100%);
  width: calc(162 / 195 * 100%);
  height: calc(90 / 136 * 100%);
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  align-content: flex-start;
  align-items: stretch;
  justify-content: flex-start;
  gap: 0;
  overflow: hidden;
  direction: ltr !important;
}

.inv-palette > .inv-slot {
  box-sizing: border-box;
  flex: 0 0 calc(100% / 9);
  width: calc(100% / 9);
  max-width: calc(100% / 9);
  height: calc(100% / 5);
  min-height: 0;
}

.inv-hotbar {
  position: absolute;
  left: calc(8 / 195 * 100%);
  top: calc(111 / 136 * 100%);
  width: calc(162 / 195 * 100%);
  height: calc(17 / 136 * 100%);
  display: flex;
  flex-direction: row;
  flex-wrap: nowrap;
  align-items: stretch;
  justify-content: flex-start;
  gap: 0;
  overflow: hidden;
  direction: ltr !important;
}

.inv-hotbar > .inv-slot {
  flex: 1 1 0;
  min-width: 0;
  width: 0;
}

.inv-scrollbar {
  position: absolute;
  /* Same strip as classic creative (x=171, w=24) unless the PNG moves it — only palette hotbar use (8,17)/(8,111). */
  left: calc(171 / 195 * 100%);
  top: calc(17 / 136 * 100%);
  width: calc(24 / 195 * 100%);
  min-width: 20px;
  height: calc(90 / 136 * 100%);
  display: flex;
  align-items: stretch;
  justify-content: center;
  overflow: hidden;
  box-sizing: border-box;
  direction: ltr;
  unicode-bidi: isolate;
}

/** Vertical range; `direction: ltr` only — `rtl` was a suspect for bidi leaks on WebKit. */
.inv-scroll-range {
  writing-mode: vertical-lr;
  direction: ltr;
  width: 100%;
  min-height: 0;
  accent-color: #8b5cf6;
  cursor: pointer;
  unicode-bidi: isolate;
}

.inv-slot {
  position: relative;
  margin: 0;
  padding: 0;
  border: none;
  background: transparent;
  cursor: grab;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
  min-height: 0;
  box-sizing: border-box;
  overflow: hidden;
  /** Lets icons size with `cqmin` so tools stay square inside slightly rectangular cells. */
  container-type: size;
  direction: ltr;
}

.inv-slot:active {
  cursor: grabbing;
}

.inv-slot--empty {
  cursor: default;
}

.inv-slot--fist {
  cursor: default;
}

.inv-slot--pick {
  box-shadow: inset 0 0 0 2px rgba(167, 139, 250, 0.95);
  background: rgba(124, 58, 237, 0.2);
}

/**
 * Fill each slot — previous rules capped sprites at ~20px while cells are ~35–45px on phones,
 * so icons looked tiny. Use cqmin for a square that fits the cell; fall back via @supports.
 */
.inv-icon {
  width: 100%;
  height: 100%;
  max-width: 100%;
  max-height: 100%;
  flex-shrink: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.inv-slot :deep(.bw-hb-tool-sprite),
.inv-slot :deep(.bw-hb-terrain-sprite) {
  width: 92% !important;
  height: 92% !important;
  max-width: 100% !important;
  max-height: 100% !important;
  flex-shrink: 0;
  box-sizing: border-box;
}

.inv-slot :deep(.bw-hb-gui-block) {
  width: 92% !important;
  height: 92% !important;
  max-width: 100% !important;
  max-height: 100% !important;
  flex-shrink: 0;
  box-sizing: border-box;
}

.inv-slot :deep(.bw-hb-emoji) {
  font-size: clamp(20px, 6.5vw, 34px);
  line-height: 1;
}

@supports (width: min(1cqmin, 1px)) {
  .inv-slot :deep(.bw-hb-tool-sprite),
  .inv-slot :deep(.bw-hb-terrain-sprite) {
    width: min(94cqmin, 100%) !important;
    height: min(94cqmin, 100%) !important;
  }

  .inv-slot :deep(.bw-hb-gui-block) {
    width: min(94cqmin, 100%) !important;
    height: min(94cqmin, 100%) !important;
  }

  .inv-slot :deep(.bw-hb-emoji) {
    font-size: clamp(20px, 55cqmin, 36px);
  }
}

.inv-slot :deep(.bw-hb-icon-img) {
  width: 92%;
  height: 92%;
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  flex-shrink: 0;
}

.inv-auto {
  position: absolute;
  left: calc(8 / 195 * 100%);
  top: calc(2 / 136 * 100%);
  z-index: 4;
  min-width: 40px;
  padding: 2px 8px;
  border: 1px solid rgba(148, 163, 184, 0.4);
  border-radius: 4px;
  font-size: 11px;
  font-weight: 700;
  color: #e2e8f0;
  background: rgba(15, 23, 42, 0.72);
  cursor: pointer;
  line-height: 1.2;
}

.inv-auto:hover {
  background: rgba(30, 41, 59, 0.88);
}

.inv-close {
  position: absolute;
  top: calc(2 / 136 * 100%);
  right: calc(8 / 195 * 100%);
  z-index: 4;
  width: 26px;
  height: 26px;
  border: 1px solid rgba(148, 163, 184, 0.35);
  border-radius: 4px;
  font-size: 16px;
  line-height: 1;
  color: #f1f5f9;
  background: rgba(15, 23, 42, 0.72);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}

.inv-close:hover {
  background: rgba(30, 41, 59, 0.88);
}
</style>
