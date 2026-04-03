/** Підрахунок відкритих AppModal — щоб не знімати lock, поки є інша модалка. */
let lockCount = 0
let savedScrollY = 0

export function pushModalScrollLock() {
  if (lockCount === 0) {
    savedScrollY = window.scrollY || document.documentElement.scrollTop || 0
    document.documentElement.style.overflow = 'hidden'
    document.documentElement.style.overscrollBehavior = 'none'
    document.body.style.overflow = 'hidden'
    document.body.style.position = 'fixed'
    document.body.style.top = `-${savedScrollY}px`
    document.body.style.left = '0'
    document.body.style.right = '0'
    document.body.style.width = '100%'
    document.body.style.overscrollBehavior = 'none'
  }
  lockCount++
}

export function popModalScrollLock() {
  if (lockCount <= 0) return
  lockCount--
  if (lockCount !== 0) return
  document.documentElement.style.removeProperty('overflow')
  document.documentElement.style.removeProperty('overscroll-behavior')
  document.body.style.removeProperty('overflow')
  document.body.style.removeProperty('position')
  document.body.style.removeProperty('top')
  document.body.style.removeProperty('left')
  document.body.style.removeProperty('right')
  document.body.style.removeProperty('width')
  document.body.style.removeProperty('overscroll-behavior')
  window.scrollTo(0, savedScrollY)
}
