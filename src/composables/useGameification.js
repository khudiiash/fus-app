import { computed } from 'vue'
import { xpForLevel, xpToNextLevel } from '@/firebase/collections'

export function useGameification(profile) {
  const level = computed(() => profile.value?.level || 1)
  const xp    = computed(() => profile.value?.xp    || 0)
  const coins = computed(() => profile.value?.coins  || 0)
  const streak = computed(() => profile.value?.streak || 0)

  const xpProgress = computed(() => {
    const lv = level.value
    const start = xpForLevel(lv)
    const end   = start + xpToNextLevel(lv)
    const current = xp.value - start
    const needed  = end - start
    return {
      current: Math.max(0, current),
      needed,
      percent: Math.min(100, Math.round((Math.max(0, current) / needed) * 100)),
    }
  })

  const streakMultiplier = computed(() => {
    const s = streak.value
    if (s >= 30) return 2.0
    if (s >= 14) return 1.5
    if (s >= 7)  return 1.25
    if (s >= 3)  return 1.1
    return 1.0
  })

  const streakMilestone = computed(() => {
    const s = streak.value
    const milestones = [3, 7, 14, 30]
    return milestones.find(m => m > s) || null
  })

  const rarityColor = (rarity) => ({
    common:    '#9ca3af',
    rare:      '#3b82f6',
    epic:      '#a855f7',
    legendary: '#f59e0b',
  }[rarity] || '#9ca3af')

  const rarityGlow = (rarity) => ({
    common:    '',
    rare:      'glow-rare',
    epic:      'glow-epic',
    legendary: 'glow-legendary',
  }[rarity] || '')

  return { level, xp, coins, streak, xpProgress, streakMultiplier, streakMilestone, rarityColor, rarityGlow }
}
