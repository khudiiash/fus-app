/** Паралель з назви класу: «10-Б» → 10 */
export function gradeFromClassName(name) {
  const m = String(name || '').trim().match(/^(\d+)/)
  return m ? parseInt(m[1], 10) : null
}

/**
 * Як у вас у школі: молодша 1–4, середня 5–8, старша з 9 класу (9–11).
 */
export function schoolTierEmojiForClassName(name) {
  const g = gradeFromClassName(name)
  if (g == null) return '🏫'
  if (g >= 1 && g <= 4) return '🧒'
  if (g >= 5 && g <= 8) return '🧑‍🎓'
  return '🎓'
}
