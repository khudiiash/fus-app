import { computed, onScopeDispose, ref } from 'vue'

/**
 * Local-time release timestamp: 2026-06-26 00:00:00.
 * Tweak the year/time here when the next blackout window needs to be scheduled.
 */
export const FUS_CHARACTER_RELEASE_AT = new Date(2026, 5, 26, 0, 0, 0, 0).getTime()

/**
 * Module-scope singleton so every component that calls {@link useCharacterReleaseGate}
 * observes the same ticking countdown and flips to "released" the instant we cross the
 * release timestamp. Re-evaluated every second while a consumer is mounted.
 */
const nowMs = ref(Date.now())
let tickerId = /** @type {ReturnType<typeof setInterval> | null} */ (null)
let consumerCount = 0

function startTicker() {
  if (tickerId != null) return
  if (typeof window === 'undefined') return
  tickerId = setInterval(() => {
    nowMs.value = Date.now()
  }, 1000)
}

function stopTicker() {
  if (tickerId == null) return
  clearInterval(tickerId)
  tickerId = null
}

/**
 * @returns {{
 *   releaseAt: number,
 *   releaseDate: Date,
 *   now: import('vue').Ref<number>,
 *   isReleased: import('vue').ComputedRef<boolean>,
 *   msUntilRelease: import('vue').ComputedRef<number>,
 *   countdownParts: import('vue').ComputedRef<{ days: number, hours: number, minutes: number, seconds: number, totalSeconds: number }>,
 *   countdownLabel: import('vue').ComputedRef<string>,
 * }}
 */
export function useCharacterReleaseGate() {
  consumerCount += 1
  startTicker()
  onScopeDispose(() => {
    consumerCount = Math.max(0, consumerCount - 1)
    if (consumerCount === 0) stopTicker()
  })

  const isReleased = computed(() => nowMs.value >= FUS_CHARACTER_RELEASE_AT)
  const msUntilRelease = computed(() => Math.max(0, FUS_CHARACTER_RELEASE_AT - nowMs.value))

  const countdownParts = computed(() => {
    const total = Math.max(0, Math.floor(msUntilRelease.value / 1000))
    const days = Math.floor(total / 86400)
    const hours = Math.floor((total % 86400) / 3600)
    const minutes = Math.floor((total % 3600) / 60)
    const seconds = total % 60
    return { days, hours, minutes, seconds, totalSeconds: total }
  })

  const countdownLabel = computed(() => {
    const { days, hours, minutes, seconds } = countdownParts.value
    const pad = (n) => String(n).padStart(2, '0')
    if (days > 0) return `${days}д ${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
  })

  return {
    releaseAt: FUS_CHARACTER_RELEASE_AT,
    releaseDate: new Date(FUS_CHARACTER_RELEASE_AT),
    now: nowMs,
    isReleased,
    msUntilRelease,
    countdownParts,
    countdownLabel,
  }
}
