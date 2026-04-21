import { calcLevel } from '@/firebase/collections'

/**
 * Student level for Laby / FUS embed — same source as the main app Firestore profile.
 * Uses XP-derived level via {@link calcLevel} when XP is present (canonical); otherwise {@code profile.level}.
 *
 * @param {{ xp?: number, level?: number } | null | undefined} profile
 * @returns {number} 1–50
 */
export function effectiveUserLevelFromProfile(profile) {
  if (!profile || typeof profile !== 'object') return 1
  const xp = Number(profile.xp)
  if (Number.isFinite(xp) && xp >= 0) {
    return Math.max(1, Math.min(50, calcLevel(xp)))
  }
  const lv = Math.floor(Number(profile.level) || 1)
  return Math.max(1, Math.min(50, lv))
}
