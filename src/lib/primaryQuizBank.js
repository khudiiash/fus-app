/**
 * Локальний банк MCQ для молодшої школи (1–4 клас), без ZNO.
 */

import bankJson from '@/data/primaryQuizBank.json'

/** @typedef {{ letter: string, text: string }} PrimaryAnswer */

/**
 * @typedef {object} PrimaryQuizItem
 * @property {number} id
 * @property {string} question
 * @property {PrimaryAnswer[]} answers
 * @property {string} correctLetter
 * @property {string} topic
 * @property {number} gradeMin
 * @property {number} gradeMax
 */

/** @typedef {import('@/lib/znoQuizLoad').ZnoFlatTask & { _meta?: object, subjectSlug?: string }} BankRow */

let _cached = null

/**
 * @returns {BankRow[]}
 */
export function loadPrimaryQuizBank() {
  if (_cached) return _cached
  /** @type {PrimaryQuizItem[]} */
  const raw = Array.isArray(bankJson) ? bankJson : []
  const slug = 'primary_school'
  _cached = raw
    .map((item) => normalizePrimaryItem(slug, item))
    .filter(Boolean)
  return _cached
}

/**
 * @param {string} subjectSlug
 * @param {PrimaryQuizItem} item
 * @returns {BankRow | null}
 */
function normalizePrimaryItem(subjectSlug, item) {
  if (!item || typeof item !== 'object') return null
  const question = String(item.question || '').trim()
  const answers = Array.isArray(item.answers) ? item.answers : []
  if (answers.length !== 4) return null
  const correctLetter = String(item.correctLetter || '').trim()
  const normAnswers = answers.map((a) => ({
    letter: String(a.letter || '').trim(),
    text: String(a.text || '').trim(),
  }))
  if (normAnswers.some((a) => !a.letter || !a.text)) return null
  if (!normAnswers.some((a) => a.letter === correctLetter)) return null

  const gradeMin = Number(item.gradeMin)
  const gradeMax = Number(item.gradeMax)
  const gmin = Number.isFinite(gradeMin) ? gradeMin : 1
  const gmax = Number.isFinite(gradeMax) ? gradeMax : 4
  const topic = String(item.topic || 'загальна підготовка').trim().toLowerCase()
  let al = 0
  for (const a of normAnswers) {
    const L = a.text.length
    if (L > al) al = L
  }
  const hay = question.toLowerCase()
  const id = Number(item.id)

  return {
    taskKey: `${subjectSlug}#p${Number.isFinite(id) ? id : '?'}`,
    question,
    answers: normAnswers,
    correctLetter,
    photoUrl: null,
    subjectSlug,
    _meta: {
      ql: question.length,
      al,
      earlyTest: true,
      hay,
      topic,
      gradeMin: gmin,
      gradeMax: gmax,
    },
  }
}

/** Чи підходить предмет для паралелі (молодша школа). */
export function isPrimarySchoolGrade(grade) {
  const g = Number(grade)
  return Number.isFinite(g) && g >= 1 && g <= 4
}
