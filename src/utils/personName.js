/**
 * У додатку `displayName` зберігається у шкільному стилі: «Прізвище Ім'я»
 * (за потреби «Прізвище Ім'я По батькові»). Не плутати з «Ім'я Прізвище».
 */

export function givenNameFromDisplayName(displayName) {
  const parts = String(displayName || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (parts.length === 0) return ''
  if (parts.length === 1) return parts[0]
  return parts[1]
}

export function surnameFromDisplayName(displayName) {
  const parts = String(displayName || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  return parts[0] || ''
}

/** Перша літера імені (для аватарки в хедері), узгоджено з привітанням. */
export function givenNameInitial(displayName) {
  const g = givenNameFromDisplayName(displayName)
  const ch = (g || String(displayName || '').trim() || '?').charAt(0)
  return ch.toLocaleUpperCase('uk')
}
