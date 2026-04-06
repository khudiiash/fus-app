/**
 * Витягує перше число з назви класу («10 клас», «2-А», «Клас 7») для сортування 2 → 10.
 * Без цифр — у кінець списку, далі за localeCompare.
 */
export function classGradeSortKey(name) {
  const s = String(name || '').trim()
  const m = s.match(/(\d+)/)
  if (m) return parseInt(m[1], 10)
  return Number.POSITIVE_INFINITY
}

/** Класи від молодшого номера до старшого; при однаковому номері — за повною назвою (uk). */
export function sortClassesByGradeAsc(list) {
  if (!list?.length) return []
  return [...list].sort((a, b) => {
    const na = classGradeSortKey(a?.name)
    const nb = classGradeSortKey(b?.name)
    if (na !== nb) return na - nb
    return String(a?.name || '').localeCompare(String(b?.name || ''), 'uk')
  })
}
