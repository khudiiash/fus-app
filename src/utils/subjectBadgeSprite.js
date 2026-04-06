/**
 * Spritesheet: src/assets/subjects.png — 7×4 grid (last row: 4 badges, cols 0–3).
 * Indices 0–20: row = floor(i/7), col = i % 7; indices 21–24: row 3, col = i - 21.
 */
import sheetUrl from '@/assets/subjects.png'

export const BADGE_SPRITE_COLS = 7
export const BADGE_SPRITE_ROWS = 4
export const BADGE_SPRITE_COUNT = 25

/** Short labels for admin UI (order matches sheet left-to-right, top-to-bottom). */
export const BADGE_SPRITE_LABELS = [
  'Історія / класика',
  'Географія',
  'Право / громадянське',
  'Суспільствознавство',
  'Математика',
  'Фізика',
  'Хімія (колба)',
  'Хімія (фіолет.)',
  'Біологія',
  'Екологія',
  'Природознавство',
  'Інформатика',
  'Українська (золото)',
  'Українська (срібло)',
  'Зарубіжна література',
  'Читання / бібліотека',
  'Англійська',
  'Німецька',
  'Польська',
  'Мистецтво (палітра)',
  'Мистецтво (мольберт)',
  'Музика',
  'Фізкультура',
  'Здоров’я',
  'Захист України',
]

export function isValidBadgeSpriteIndex(n) {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n < BADGE_SPRITE_COUNT
}

export function badgeIndexToGrid(index) {
  if (index < 21) {
    return { row: Math.floor(index / 7), col: index % 7 }
  }
  return { row: 3, col: index - 21 }
}

/**
 * Inline styles for a square cell showing one frame of the sheet.
 */
export function subjectBadgeBackgroundStyle(spriteIndex, sizePx) {
  if (!isValidBadgeSpriteIndex(spriteIndex)) return null
  const { row, col } = badgeIndexToGrid(spriteIndex)
  const cols = BADGE_SPRITE_COLS
  const rows = BADGE_SPRITE_ROWS
  const xPct = cols <= 1 ? 0 : (col / (cols - 1)) * 100
  const yPct = rows <= 1 ? 0 : (row / (rows - 1)) * 100
  return {
    backgroundImage: `url("${sheetUrl}")`,
    backgroundSize: `${cols * 100}% ${rows * 100}%`,
    backgroundPosition: `${xPct}% ${yPct}%`,
    backgroundRepeat: 'no-repeat',
    width: `${sizePx}px`,
    height: `${sizePx}px`,
  }
}

export { sheetUrl as SUBJECT_BADGE_SHEET_URL }
