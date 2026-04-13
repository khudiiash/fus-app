/**
 * In-world HUD: hotbar (bottom), touch look (full screen under controls) + analog move + actions.
 */
import './blockWorldHud.css'
import * as THREE from 'three'
import type Control from './minebase/control'

import grass from './minebase/static/block-icon/grass.png'
import stone from './minebase/static/block-icon/stone.png'
import tree from './minebase/static/block-icon/tree.png'
import wood from './minebase/static/block-icon/wood.png'
import diamond from './minebase/static/block-icon/diamond.png'
import quartz from './minebase/static/block-icon/quartz.png'
import glass from './minebase/static/block-icon/glass.png'
import toolIcon from './assets/tool.png'

const HOTBAR_ICONS = [...[grass, stone, tree, wood, diamond, quartz, glass], toolIcon]

const STICK_MAX = 56
/** Joystick deflection maps to [-1,1]; boost so full tilt matches keyboard cruise speed. */
const TOUCH_ANALOG_GAIN = 1.32

export type BlockWorldHudOptions = {
  mountEl: HTMLElement
  control: Control
  touchUi: boolean
}

function swallowPointer(e: Event) {
  e.stopPropagation()
}

export function mountBlockWorldHud(options: BlockWorldHudOptions): () => void {
  const { mountEl, control, touchUi } = options

  const root = document.createElement('div')
  root.className = 'fus-bw-hud'
  mountEl.appendChild(root)

  const cross = document.createElement('div')
  cross.className = 'fus-bw-crosshair'
  cross.textContent = '+'
  root.appendChild(cross)

  const bottom = document.createElement('div')
  bottom.className = 'fus-bw-bottom'
  root.appendChild(bottom)

  const hotbar = document.createElement('div')
  hotbar.className = 'fus-bw-hotbar'
  const hotbarSlots: HTMLDivElement[] = []
  for (let i = 0; i < HOTBAR_ICONS.length; i++) {
    const item = document.createElement('div')
    item.className =
      i === HOTBAR_ICONS.length - 1
        ? 'fus-bw-hotbar-item fus-bw-hotbar-item--tool'
        : 'fus-bw-hotbar-item'
    const img = document.createElement('img')
    img.className = 'fus-bw-hotbar-icon'
    img.alt = ''
    img.src = HOTBAR_ICONS[i]
    img.draggable = false
    item.appendChild(img)
    item.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      control.setHotbarSlot(i)
    })
    item.addEventListener('pointerdown', swallowPointer)
    hotbar.appendChild(item)
    hotbarSlots.push(item)
  }
  bottom.appendChild(hotbar)

  const syncHotbar = () => {
    const idx = control.holdingIndex
    for (let i = 0; i < hotbarSlots.length; i++) {
      hotbarSlots[i].classList.toggle('fus-bw-hotbar-item--selected', i === idx)
    }
  }
  control.onHotbarIndexChange = syncHotbar
  syncHotbar()

  const cleanups: Array<() => void> = []

  if (touchUi) {
    const look = document.createElement('div')
    look.className = 'fus-bw-look'
    const lookHint = document.createElement('div')
    lookHint.className = 'fus-bw-look-hint'
    lookHint.textContent = 'Тягни для огляду · короткий тик — дія'
    look.appendChild(lookHint)
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
      euler.y -= 0.009 * (e.clientX - lx)
      euler.x -= 0.009 * (e.clientY - ly)
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
      let dx = clientX - stickCx
      let dy = clientY - stickCy
      const len = Math.hypot(dx, dy) || 0
      if (len > STICK_MAX) {
        dx = (dx / len) * STICK_MAX
        dy = (dy / len) * STICK_MAX
      }
      stickKnob.style.transform = `translate(${dx}px, ${dy}px)`
      let fwd = -dy / STICK_MAX
      let str = dx / STICK_MAX
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

    const textBtn = (label: string, className: string, ariaLabel: string) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = `fus-bw-text-btn ${className}`.trim()
      b.textContent = label
      b.setAttribute('aria-label', ariaLabel)
      return b
    }

    const jumpBtn = textBtn('Стрибок', 'fus-bw-text-btn--jump', 'Стрибок')
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

    actions.appendChild(jumpBtn)

    row.appendChild(stickWrap)
    row.appendChild(actions)
    bottom.insertBefore(row, hotbar)

    cleanups.push(() => {
      resetStick()
      window.removeEventListener('pointermove', onLookMove)
      window.removeEventListener('pointerup', endLook)
      window.removeEventListener('pointercancel', endLook)
    })
  }

  return () => {
    control.onHotbarIndexChange = undefined
    control.setTouchAnalog(0, 0)
    for (const fn of cleanups) fn()
    root.remove()
  }
}
