/**
 * ZNO/NMT benchmarks (structured tests) sourced from NLPForUA/ZNO (GitHub).
 * @see https://github.com/NLPForUA/ZNO — DATA_LICENSE in that repo applies.
 */

export const ZNO_JS_DELIVR_BASE = 'https://cdn.jsdelivr.net/gh/NLPForUA/ZNO@main/tests'

/** @typedef {{ slug: string, label: string, fileName: string }} ZnoQuizSubject */

/** @type {ZnoQuizSubject[]} */
export const ZNO_QUIZ_SUBJECTS = [
  { slug: 'math', label: 'Математика', fileName: 'math_raw.json' },
  { slug: 'ukr_lang_lit', label: 'Українська мова й література', fileName: 'ukrainian_raw.json' },
  { slug: 'history', label: 'Історія України', fileName: 'history_raw.json' },
  { slug: 'geography', label: 'Географія', fileName: 'geography_raw.json' },
]

export function znoQuizDataUrl(subject) {
  return `${ZNO_JS_DELIVR_BASE}/${subject.fileName}`
}
