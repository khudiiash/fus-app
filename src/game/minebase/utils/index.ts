export const htmlToDom = (html: string) => {
  const templateDom = document.createElement('template')
  templateDom.innerHTML = html
  window.document.body.appendChild(templateDom.content)
}

export const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry/i.test(
  navigator.userAgent
)

/** Primary touch / phone UI (joystick): UA or coarse pointer (tablets, touch laptops). */
export function useTouchGameControls(): boolean {
  if (typeof window === 'undefined') return false
  if (isMobile) return true
  try {
    return window.matchMedia('(pointer: coarse)').matches
  } catch {
    return false
  }
}

type NavigatorMem = Navigator & { deviceMemory?: number }

function readDeviceMemoryGb(): number | undefined {
  if (typeof navigator === 'undefined') return undefined
  const m = (navigator as NavigatorMem).deviceMemory
  return typeof m === 'number' && m > 0 ? m : undefined
}

/**
 * Budget phones: few cores and/or little RAM — cap DPR / terrain radius harder.
 * Also: many WebViews omit `deviceMemory`; 8×A53 phones (e.g. Redmi 6) report 8 cores so
 * `hardwareConcurrency <= 4` alone misses them — treat Android + unknown memory as low tier.
 */
export function isLowPowerTouchDevice(): boolean {
  if (typeof navigator === 'undefined' || !useTouchGameControls()) return false
  const cores = navigator.hardwareConcurrency
  if (typeof cores === 'number' && cores > 0 && cores <= 4) return true
  const mem = readDeviceMemoryGb()
  if (mem !== undefined && mem <= 4) return true
  if (/Android/i.test(navigator.userAgent) && mem === undefined) return true
  return false
}

/**
 * Stronger block-world limits on typical **Android phones** (Helio P22 / Mali class),
 * even when `deviceMemory` buckets high (e.g. 8) so {@link isLowPowerTouchDevice} misses.
 * Large tablets (short CSS edge ≥ 600px) keep milder settings.
 */
export function blockWorldAggressiveMobile(): boolean {
  if (typeof navigator === 'undefined' || !useTouchGameControls()) return false
  if (isLowPowerTouchDevice()) return true
  if (!/Android/i.test(navigator.userAgent)) return false
  try {
    const shortEdge = Math.min(
      window.screen?.width ?? 0,
      window.screen?.height ?? 0,
    )
    if (shortEdge >= 600) return false
  } catch {
    /* ignore */
  }
  return true
}

/**
 * Touch or coarse pointer — matches terrain chunk radius heuristics and is a good
 * signal for “phone / tablet WebGL” without relying only on UA.
 */
export function terrainReducedViewRange(): boolean {
  if (typeof window === 'undefined') return false
  return (
    (navigator.maxTouchPoints || 0) > 0 ||
    (window.matchMedia?.('(pointer: coarse)').matches ?? false)
  )
}

/** Block World Next: turn off shadows, cap DPR, etc. (deterministic; safe for shared worlds). */
export function blockWorldNextLowGpu(): boolean {
  return terrainReducedViewRange() || isLowPowerTouchDevice() || blockWorldAggressiveMobile()
}
