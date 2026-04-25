/**
 * In-game "Render distance" (chunk radius) for the Laby embed. Stored in localStorage
 * (not only cookies) so it works on mobile Safari/Chrome and PWAs where cookies are
 * unreliable or third-party cookie rules caused {@link GameSettings#viewDistance} to
 * never persist — the user would change the slider and see no effect after reload.
 *
 * Capped 2..10 chunks. Default remains 5; very high values can stress low-end Android.
 */

const STORAGE_KEY = 'fus:viewDistance:v2'
export const FUS_LABY_VIEW_MIN = 2
export const FUS_LABY_VIEW_MAX = 10

const clamp = (n) => Math.max(FUS_LABY_VIEW_MIN, Math.min(FUS_LABY_VIEW_MAX, Math.round(n)))

/**
 * @param {any} mc
 * @param {{ isAndroid: boolean, isIosSafari: boolean, strainedAndroid: boolean }} env
 */
export function applyFusLabyViewDistanceFromStorage(mc, env) {
  if (!mc?.settings) return
  const s = mc.settings
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null
    if (raw != null) {
      const p = parseInt(String(raw), 10)
      if (Number.isFinite(p)) {
        s.viewDistance = clamp(p)
        return
      }
    }
  } catch {
    /* ignore */
  }
  const { isAndroid, isIosSafari, strainedAndroid } = env
  const isTouchMobile = isIosSafari || strainedAndroid || isAndroid
  /**
   * No saved value: iOS 3; Android 5 (dpr cap + Laby opt target ~60fps at radius 5); other touch 3; desktop 5.
   */
  const defaultVd = isIosSafari ? 3 : isAndroid ? 5 : isTouchMobile ? 3 : 5
  s.viewDistance = clamp(defaultVd)
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, String(s.viewDistance))
    }
  } catch {
    /* ignore */
  }
}

/**
 * Persists the slider to localStorage whenever {@link GameSettings#save} runs (e.g. closing Options).
 * @param {any} mc
 */
export function installFusLabyViewDistanceSaveHook(mc) {
  if (!mc?.settings?._fusLabyViewSavePatched) {
    const st = mc.settings
    st._fusLabyViewSavePatched = true
    const orig = st.save.bind(st)
    st.save = function fusLabyPatchedSettingsSave() {
      orig()
      try {
        if (typeof this.viewDistance === 'number') {
          this.viewDistance = clamp(this.viewDistance)
          if (typeof localStorage !== 'undefined') {
            localStorage.setItem(STORAGE_KEY, String(this.viewDistance))
          }
        }
      } catch {
        /* ignore */
      }
    }
  }
}
