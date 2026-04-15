/**
 * In-world HUD: hotbar (bottom), touch look (full screen under controls) + analog move + actions.
 */
import './blockWorldHud.css'
import * as THREE from 'three'
import type Control from './minebase/control'

import heartsSheet from './assets/hearts_sh.png'
import { BLOCK_WORLD_MAX_HP_HALF_UNITS } from '@/game/playerConstants'
import { hotbarCellVisualForBwSlot } from '@/game/blockWorldHotbarVisuals'

/** Move stick: max knob offset scales with `.fus-bw-stick-base` size (120px → radius 60). */
const STICK_BASE_REF_RADIUS_PX = 60
const STICK_MAX_REF = 56
/** Look stick: matches default 162px ring (radius 81) × ~0.89. */
const LOOK_STICK_BASE_REF_RADIUS_PX = 81
const LOOK_STICK_MAX_REF = 72
/** Radians per pixel — full-screen drag look (`.fus-bw-look`). */
const LOOK_SENS = 0.009
/** Radians per pixel — look ring *inside* the rim (drag to aim); higher than legacy 0.009. */
const LOOK_STICK_DRAG_SENS = 0.016
/** Rad/s only while finger is at the outer rim (continuous spin). */
const LOOK_STICK_YAW_SPEED = 2.85
const LOOK_STICK_PITCH_SPEED = 2.2
/** Finger must reach this fraction of max radius before rim / continuous spin. */
const LOOK_STICK_RIM_FRAC = 0.94
/** Joystick deflection maps to [-1,1]; boost so full tilt matches keyboard cruise speed. */
const TOUCH_ANALOG_GAIN = 1.32

export type BlockWorldHudOptions = {
  mountEl: HTMLElement
  control: Control
  touchUi: boolean
  /** Return to spawn (camera + velocity reset). */
  teleportToSpawn?: () => void
  /** Clear all custom blocks for everyone (confirm before calling). */
  onRestoreWorld?: () => void | Promise<void>
  /** Place / update this player’s spawn flag at current feet position. */
  onPlaceSpawnFlag?: () => void | Promise<void>
}

export type BlockWorldHudHandle = {
  dispose: () => void
  setHeartsHalfUnits: (hp: number, maxHalf?: number) => void
  setOnlineCount: (n: number) => void
  /** Brief red vignette when the local player takes damage. */
  flashDamage: () => void
}

function swallowPointer(e: Event) {
  e.stopPropagation()
}

export function mountBlockWorldHud(
  options: BlockWorldHudOptions,
): BlockWorldHudHandle {
  const { mountEl, control, touchUi, teleportToSpawn, onRestoreWorld, onPlaceSpawnFlag } =
    options

  const root = document.createElement('div')
  root.className = 'fus-bw-hud'
  mountEl.appendChild(root)

  const damageFlash = document.createElement('div')
  damageFlash.className = 'fus-bw-damage-flash'
  damageFlash.setAttribute('aria-hidden', 'true')
  root.appendChild(damageFlash)
  let damageFlashTimer: ReturnType<typeof setTimeout> | null = null
  /** Start of current “burst” for capping how long the vignette can stay on. */
  let damageFlashBurstT0 = 0
  const DAMAGE_FLASH_GAP_MS = 650
  const DAMAGE_FLASH_EXTEND_MS = 200
  const DAMAGE_FLASH_CAP_MS = 480
  const flashDamage = () => {
    const now = performance.now()
    if (
      !damageFlashBurstT0 ||
      now - damageFlashBurstT0 > DAMAGE_FLASH_GAP_MS
    ) {
      damageFlashBurstT0 = now
    }
    damageFlash.classList.add('fus-bw-damage-flash--on')
    if (damageFlashTimer != null) clearTimeout(damageFlashTimer)
    const capAt = damageFlashBurstT0 + DAMAGE_FLASH_CAP_MS
    const hideAt = Math.min(capAt, now + DAMAGE_FLASH_EXTEND_MS)
    damageFlashTimer = setTimeout(() => {
      damageFlashTimer = null
      damageFlash.classList.remove('fus-bw-damage-flash--on')
    }, Math.max(0, hideAt - now))
  }

  const status = document.createElement('div')
  status.className = 'fus-bw-status'
  const onlineEl = document.createElement('div')
  onlineEl.className = 'fus-bw-online'
  onlineEl.textContent = 'Гравці: 1'
  status.appendChild(onlineEl)

  const heartsRow = document.createElement('div')
  heartsRow.className = 'fus-bw-hearts'
  const heartCells: HTMLDivElement[] = []
  for (let i = 0; i < 10; i++) {
    const h = document.createElement('div')
    h.className = 'fus-bw-heart fus-bw-heart--full'
    h.setAttribute('role', 'presentation')
    heartsRow.appendChild(h)
    heartCells.push(h)
  }
  root.appendChild(status)

  const setHeartsHalfUnits = (hp: number, maxHalf = BLOCK_WORLD_MAX_HP_HALF_UNITS) => {
    const clamped = Math.max(0, Math.min(maxHalf, hp))
    for (let i = 0; i < 10; i++) {
      const left = clamped > i * 2
      const right = clamped > i * 2 + 1
      let cls = 'fus-bw-heart fus-bw-heart--empty'
      if (left && right) cls = 'fus-bw-heart fus-bw-heart--full'
      else if (left) cls = 'fus-bw-heart fus-bw-heart--half'
      heartCells[i].className = cls
    }
  }

  const setOnlineCount = (n: number) => {
    onlineEl.textContent = `Гравці: ${Math.max(0, Math.floor(n))}`
  }

  heartsRow.style.setProperty('--fus-hearts-url', `url(${String(heartsSheet)})`)

  control.onPlayerHpChanged = (hp) => {
    setHeartsHalfUnits(hp)
  }
  setHeartsHalfUnits(control.playerHpHalfUnits)

  if (teleportToSpawn || onRestoreWorld || onPlaceSpawnFlag) {
    const topActions = document.createElement('div')
    topActions.className = 'fus-bw-top-actions'
    if (teleportToSpawn) {
      const spawnBtn = document.createElement('button')
      spawnBtn.type = 'button'
      spawnBtn.className = 'fus-bw-spawn-btn'
      spawnBtn.textContent = 'До спавну'
      spawnBtn.setAttribute('aria-label', 'Повернутися на стартову позицію')
      spawnBtn.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        teleportToSpawn()
      })
      spawnBtn.addEventListener('pointerdown', swallowPointer)
      topActions.appendChild(spawnBtn)
    }
    if (onRestoreWorld) {
      const restoreBtn = document.createElement('button')
      restoreBtn.type = 'button'
      restoreBtn.className = 'fus-bw-restore-world-btn'
      restoreBtn.textContent = 'Скинути світ'
      restoreBtn.setAttribute(
        'aria-label',
        'Прибрати всі побудовані блоки для всіх гравців',
      )
      restoreBtn.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        void onRestoreWorld()
      })
      restoreBtn.addEventListener('pointerdown', swallowPointer)
      topActions.appendChild(restoreBtn)
    }
    if (onPlaceSpawnFlag) {
      const flagBtn = document.createElement('button')
      flagBtn.type = 'button'
      flagBtn.className = 'fus-bw-flag-spawn-btn'
      flagBtn.textContent = 'Прапор спавну'
      flagBtn.setAttribute(
        'aria-label',
        'Поставити прапорець спавну тут (твоя точка відродження)',
      )
      flagBtn.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        void onPlaceSpawnFlag()
      })
      flagBtn.addEventListener('pointerdown', swallowPointer)
      topActions.appendChild(flagBtn)
    }
    root.appendChild(topActions)
  }

  const cross = document.createElement('div')
  cross.className = 'fus-bw-crosshair'
  cross.textContent = '+'
  root.appendChild(cross)

  const bottom = document.createElement('div')
  bottom.className = 'fus-bw-bottom'
  root.appendChild(bottom)

  const hotbar = document.createElement('div')
  hotbar.className = 'fus-bw-hotbar'
  bottom.appendChild(hotbar)
  const heartsHud = document.createElement('div')
  heartsHud.className = 'fus-bw-hearts-hud'
  heartsHud.appendChild(heartsRow)
  bottom.insertBefore(heartsHud, hotbar)
  const hotbarSlots: HTMLDivElement[] = []

  const rebuildHotbar = () => {
    hotbar.replaceChildren()
    hotbarSlots.length = 0
    const n = control.getBwHotbarSlotCount()
    for (let i = 0; i < n; i++) {
      const item = document.createElement('div')
      item.className = 'fus-bw-hotbar-item'
      const stack = control.getBwHotbarSlotAt(i)
      const vis = hotbarCellVisualForBwSlot(stack)
      if (stack?.kind === 'item' && stack.meta.kind === 'tool') {
        item.classList.add('fus-bw-hotbar-item--tool')
      }
      if (vis.type === 'img') {
        const img = document.createElement('img')
        img.className = 'fus-bw-hotbar-icon'
        img.alt = ''
        img.src = vis.src
        img.draggable = false
        item.appendChild(img)
      } else if (vis.type === 'toolSprite') {
        const { sheetSrc, col, row, cols, rows } = vis
        const sp = document.createElement('div')
        sp.className = 'fus-bw-hotbar-tool-sprite'
        sp.setAttribute('role', 'presentation')
        const posX = cols <= 1 ? 0 : (col / (cols - 1)) * 100
        const posY = rows <= 1 ? 0 : (row / (rows - 1)) * 100
        sp.style.backgroundImage = `url(${String(sheetSrc)})`
        sp.style.backgroundSize = `${cols * 100}% ${rows * 100}%`
        sp.style.backgroundPosition = `${posX}% ${posY}%`
        item.appendChild(sp)
      } else {
        const sp = document.createElement('span')
        sp.className = 'fus-bw-hotbar-emoji'
        sp.textContent = vis.text
        item.appendChild(sp)
      }
      if (stack && stack.kind === 'item' && stack.count > 1) {
        const badge = document.createElement('span')
        badge.className = 'fus-bw-hotbar-stack'
        badge.textContent = String(stack.count)
        item.appendChild(badge)
      }
      const idx = i
      item.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        control.setHotbarSlot(idx)
      })
      item.addEventListener('pointerdown', swallowPointer)
      hotbar.appendChild(item)
      hotbarSlots.push(item)
    }
    syncHotbarSelection()
  }

  const syncHotbarSelection = () => {
    const idx = control.holdingIndex
    for (let i = 0; i < hotbarSlots.length; i++) {
      hotbarSlots[i].classList.toggle('fus-bw-hotbar-item--selected', i === idx)
    }
  }

  control.onHotbarIndexChange = syncHotbarSelection
  control.onHotbarLayoutChange = rebuildHotbar
  rebuildHotbar()

  const cleanups: Array<() => void> = []

  if (touchUi) {
    const look = document.createElement('div')
    look.className = 'fus-bw-look'
    root.insertBefore(look, bottom)

    const euler = new THREE.Euler(0, 0, 0, 'YXZ')
    let lookPtr: number | null = null
    let lx = 0
    let ly = 0
    let lookDownX = 0
    let lookDownY = 0
    let lookDownT = 0

    const onLookMove = (e: PointerEvent) => {
      if (lookPtr !== e.pointerId) return
      euler.setFromQuaternion(control.camera.quaternion)
      euler.y -= LOOK_SENS * (e.clientX - lx)
      euler.x -= LOOK_SENS * (e.clientY - ly)
      euler.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, euler.x))
      control.camera.quaternion.setFromEuler(euler)
      lx = e.clientX
      ly = e.clientY
    }
    const endLook = (e: PointerEvent) => {
      if (lookPtr !== e.pointerId) return
      const dist = Math.hypot(e.clientX - lookDownX, e.clientY - lookDownY)
      const dt = performance.now() - lookDownT
      if (dist < 20 && dt < 520) {
        control.performPrimaryTap()
      }
      look.releasePointerCapture(e.pointerId)
      lookPtr = null
      window.removeEventListener('pointermove', onLookMove)
      window.removeEventListener('pointerup', endLook)
      window.removeEventListener('pointercancel', endLook)
    }
    look.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return
      e.stopPropagation()
      lookPtr = e.pointerId
      lx = e.clientX
      ly = e.clientY
      lookDownX = e.clientX
      lookDownY = e.clientY
      lookDownT = performance.now()
      look.setPointerCapture(e.pointerId)
      window.addEventListener('pointermove', onLookMove)
      window.addEventListener('pointerup', endLook)
      window.addEventListener('pointercancel', endLook)
    })

    const row = document.createElement('div')
    row.className = 'fus-bw-controls'

    const stickWrap = document.createElement('div')
    stickWrap.className = 'fus-bw-stick-wrap'
    const stickBase = document.createElement('div')
    stickBase.className = 'fus-bw-stick-base'
    const stickKnob = document.createElement('div')
    stickKnob.className = 'fus-bw-stick-knob'
    stickBase.appendChild(stickKnob)
    stickWrap.appendChild(stickBase)
    const stickLabel = document.createElement('div')
    stickLabel.className = 'fus-bw-stick-label'
    stickLabel.textContent = 'Хід'
    stickWrap.appendChild(stickLabel)

    let stickId: number | null = null
    let stickCx = 0
    let stickCy = 0

    const applyStick = (clientX: number, clientY: number) => {
      const sr = stickBase.getBoundingClientRect()
      const stickRadius = Math.min(sr.width, sr.height) / 2
      const stickMax =
        stickRadius * (STICK_MAX_REF / STICK_BASE_REF_RADIUS_PX) || 1
      let dx = clientX - stickCx
      let dy = clientY - stickCy
      const len = Math.hypot(dx, dy) || 0
      if (len > stickMax) {
        dx = (dx / len) * stickMax
        dy = (dy / len) * stickMax
      }
      stickKnob.style.transform = `translate(${dx}px, ${dy}px)`
      let fwd = -dy / stickMax
      let str = dx / stickMax
      const m = Math.max(Math.abs(fwd), Math.abs(str))
      if (m > 1) {
        fwd /= m
        str /= m
      }
      fwd = Math.max(-1, Math.min(1, fwd * TOUCH_ANALOG_GAIN))
      str = Math.max(-1, Math.min(1, str * TOUCH_ANALOG_GAIN))
      control.setTouchAnalog(fwd, str)
    }
    const resetStick = () => {
      stickKnob.style.transform = 'translate(0px, 0px)'
      control.setTouchAnalog(0, 0)
    }

    stickBase.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const r = stickBase.getBoundingClientRect()
      stickCx = r.left + r.width / 2
      stickCy = r.top + r.height / 2
      stickId = e.pointerId
      stickBase.setPointerCapture(e.pointerId)
      applyStick(e.clientX, e.clientY)
    })
    stickBase.addEventListener('pointermove', (e) => {
      if (stickId !== e.pointerId) return
      applyStick(e.clientX, e.clientY)
    })
    const stickUp = (e: PointerEvent) => {
      if (stickId !== e.pointerId) return
      try {
        stickBase.releasePointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
      stickId = null
      resetStick()
    }
    stickBase.addEventListener('pointerup', stickUp)
    stickBase.addEventListener('pointercancel', stickUp)

    const actions = document.createElement('div')
    actions.className = 'fus-bw-actions'

    const emitKey = (key: string) => ({ key }) as KeyboardEvent

    const jumpBtn = document.createElement('button')
    jumpBtn.type = 'button'
    jumpBtn.className = 'fus-bw-jump-btn fus-bw-jump-btn--compact'
    jumpBtn.textContent = 'Стрибок'
    jumpBtn.setAttribute('aria-label', 'Стрибок')
    jumpBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      e.stopPropagation()
      control.setMovementHandler(emitKey(' '))
    })
    jumpBtn.addEventListener('pointerup', (e) => {
      e.preventDefault()
      e.stopPropagation()
      control.resetMovementHandler(emitKey(' '))
    })
    jumpBtn.addEventListener('pointercancel', (e) => {
      e.stopPropagation()
      control.resetMovementHandler(emitKey(' '))
    })

    const lookStickWrap = document.createElement('div')
    lookStickWrap.className = 'fus-bw-look-stick-wrap'
    const lookStickBase = document.createElement('div')
    lookStickBase.className = 'fus-bw-look-stick-base'
    const lookStickKnob = document.createElement('div')
    lookStickKnob.className = 'fus-bw-look-stick-knob'
    lookStickBase.appendChild(lookStickKnob)
    const lookStickLabel = document.createElement('div')
    lookStickLabel.className = 'fus-bw-stick-label fus-bw-look-stick-label'
    lookStickLabel.textContent = 'Огляд · тик дія'
    lookStickWrap.appendChild(lookStickLabel)
    lookStickWrap.appendChild(lookStickBase)

    let lookStickId: number | null = null
    let lookStickLsX = 0
    let lookStickLsY = 0
    let lookStickDownX = 0
    let lookStickDownY = 0
    let lookStickDownT = 0
    /** Normalized rim knob (clamped); used for continuous spin direction at the rim. */
    let lookStickRimNx = 0
    let lookStickRimNy = 0
    let lookStickSpinActive = false
    let lookStickRaf = 0
    let lookStickLastTick = 0

    const stopLookStickRaf = () => {
      if (lookStickRaf !== 0) {
        cancelAnimationFrame(lookStickRaf)
        lookStickRaf = 0
      }
      lookStickLastTick = 0
      lookStickSpinActive = false
    }

    const resetLookStickVisual = () => {
      lookStickKnob.style.transform = 'translate(0px, 0px)'
    }

    /**
     * Updates knob visual and rim direction. Returns true at outer rim (continuous spin only there).
     */
    const setLookStickDeflectionFromClient = (clientX: number, clientY: number): boolean => {
      const r = lookStickBase.getBoundingClientRect()
      const cx = r.left + r.width / 2
      const cy = r.top + r.height / 2
      let dx = clientX - cx
      let dy = clientY - cy
      const lookRadius = Math.min(r.width, r.height) / 2
      const lookMax =
        lookRadius * (LOOK_STICK_MAX_REF / LOOK_STICK_BASE_REF_RADIUS_PX) || 1
      const rawLen = Math.hypot(dx, dy) || 0
      const atRim = rawLen >= lookMax * LOOK_STICK_RIM_FRAC
      if (rawLen > lookMax) {
        dx = (dx / rawLen) * lookMax
        dy = (dy / rawLen) * lookMax
      }
      lookStickKnob.style.transform = `translate(${dx}px, ${dy}px)`
      lookStickRimNx = dx / lookMax
      lookStickRimNy = dy / lookMax
      return atRim
    }

    const lookStickFrame = (t: number) => {
      if (lookStickId == null || !lookStickSpinActive) {
        stopLookStickRaf()
        return
      }
      const prev = lookStickLastTick > 0 ? lookStickLastTick : t - 1000 / 60
      lookStickLastTick = t
      const dt = Math.min(0.07, Math.max(0.001, (t - prev) / 1000))

      euler.setFromQuaternion(control.camera.quaternion)
      euler.y -= LOOK_STICK_YAW_SPEED * lookStickRimNx * dt
      euler.x -= LOOK_STICK_PITCH_SPEED * lookStickRimNy * dt
      euler.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, euler.x))
      control.camera.quaternion.setFromEuler(euler)

      lookStickRaf = requestAnimationFrame(lookStickFrame)
    }

    const ensureLookStickRaf = () => {
      if (lookStickRaf !== 0) return
      lookStickLastTick = 0
      lookStickRaf = requestAnimationFrame(lookStickFrame)
    }

    const onLookStickMove = (e: PointerEvent) => {
      if (lookStickId !== e.pointerId) return
      const atRim = setLookStickDeflectionFromClient(e.clientX, e.clientY)
      if (atRim) {
        lookStickSpinActive = true
        lookStickLsX = e.clientX
        lookStickLsY = e.clientY
        ensureLookStickRaf()
      } else {
        stopLookStickRaf()
        euler.setFromQuaternion(control.camera.quaternion)
        euler.y -= LOOK_STICK_DRAG_SENS * (e.clientX - lookStickLsX)
        euler.x -= LOOK_STICK_DRAG_SENS * (e.clientY - lookStickLsY)
        euler.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, euler.x))
        control.camera.quaternion.setFromEuler(euler)
        lookStickLsX = e.clientX
        lookStickLsY = e.clientY
      }
    }

    const onLookStickUp = (e: PointerEvent) => {
      if (lookStickId !== e.pointerId) return
      const dist = Math.hypot(e.clientX - lookStickDownX, e.clientY - lookStickDownY)
      const dt = performance.now() - lookStickDownT
      if (dist < 20 && dt < 520) {
        control.performPrimaryTap()
      }
      try {
        lookStickBase.releasePointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
      lookStickId = null
      lookStickRimNx = 0
      lookStickRimNy = 0
      stopLookStickRaf()
      resetLookStickVisual()
      lookStickBase.removeEventListener('pointermove', onLookStickMove)
      lookStickBase.removeEventListener('pointerup', onLookStickUp)
      lookStickBase.removeEventListener('pointercancel', onLookStickUp)
    }

    lookStickBase.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      e.stopPropagation()
      lookStickId = e.pointerId
      lookStickDownX = e.clientX
      lookStickDownY = e.clientY
      lookStickDownT = performance.now()
      lookStickLsX = e.clientX
      lookStickLsY = e.clientY
      lookStickBase.setPointerCapture(e.pointerId)
      const atRim = setLookStickDeflectionFromClient(e.clientX, e.clientY)
      if (atRim) {
        lookStickSpinActive = true
        ensureLookStickRaf()
      }
      lookStickBase.addEventListener('pointermove', onLookStickMove)
      lookStickBase.addEventListener('pointerup', onLookStickUp)
      lookStickBase.addEventListener('pointercancel', onLookStickUp)
    })

    actions.appendChild(lookStickWrap)
    actions.appendChild(jumpBtn)

    row.appendChild(stickWrap)
    row.appendChild(actions)
    /* After hearts + hotbar: paint on top; CSS positions row at lower corners above the dock. */
    bottom.appendChild(row)

    cleanups.push(() => {
      resetStick()
      resetLookStickVisual()
      stopLookStickRaf()
      lookStickRimNx = 0
      lookStickRimNy = 0
      if (lookStickId != null) {
        try {
          lookStickBase.releasePointerCapture(lookStickId)
        } catch {
          /* ignore */
        }
        lookStickId = null
        lookStickBase.removeEventListener('pointermove', onLookStickMove)
        lookStickBase.removeEventListener('pointerup', onLookStickUp)
        lookStickBase.removeEventListener('pointercancel', onLookStickUp)
      }
      window.removeEventListener('pointermove', onLookMove)
      window.removeEventListener('pointerup', endLook)
      window.removeEventListener('pointercancel', endLook)
    })
  }

  const dispose = () => {
    if (damageFlashTimer != null) clearTimeout(damageFlashTimer)
    damageFlashTimer = null
    damageFlashBurstT0 = 0
    damageFlash.classList.remove('fus-bw-damage-flash--on')
    control.onHotbarIndexChange = undefined
    control.onHotbarLayoutChange = undefined
    control.onPlayerHpChanged = undefined
    control.onPlayerHpPresenceFlush = undefined
    control.setTouchAnalog(0, 0)
    for (const fn of cleanups) fn()
    root.remove()
  }

  return { dispose, setHeartsHalfUnits, setOnlineCount, flashDamage }
}
