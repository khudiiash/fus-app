/**
 * @param {unknown} err
 * @param {string} [fallback]
 */
export function firestoreClientErrorMessage(err, fallback = 'Помилка') {
  const code = String(err?.code || '')
  const msg = String(err?.message || '')
  if (code === 'permission-denied' || /insufficient permissions/i.test(msg)) {
    return 'Немає прав для цієї дії в базі даних. Зверніться до адміністратора школи — можливо, потрібно оновити правила Firestore.'
  }
  if (code === 'failed-precondition') {
    return 'Дані змінилися під час операції. Спробуйте ще раз.'
  }
  return msg || fallback
}
