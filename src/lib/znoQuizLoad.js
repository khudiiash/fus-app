/**
 * Loads and normalizes NLPForUA/ZNO JSON test banks for the daily quiz UI.
 */

import { znoQuizDataUrl } from '@/lib/znoQuizConstants'
import { extractZnoTopic, topicSuitability } from '@/lib/znoQuizTopics'

/** @typedef {{ letter: string, text: string }} ZnoAnswer */

/**
 * @typedef {object} ZnoFlatTask
 * @property {string} taskKey Stable id: `${subjectSlug}#t${testIndex}#${task_id}`
 * @property {string} question
 * @property {ZnoAnswer[]} answers 4 or 5 options (А–Г або А–Д за даними ZNO/NMT).
 * @property {string} correctLetter One capital Cyrillic letter.
 * @property {string | null} [photoUrl] Лише якщо в банку `with_photo` і є валідний http(s) URL.
 */

const _cache = new Map()

/**
 * @param {number | null | undefined} grade 1–11 or null
 * @returns {0|1|2} primary / middle / high school bucket
 */
export function schoolTierOrdinalFromGrade(grade) {
  const g = Number(grade)
  if (!Number.isFinite(g) || g < 1) return 2
  if (g <= 4) return 0
  if (g <= 8) return 1
  return 2
}

/** Heuristic “hard” wording in question/comment when topic line is missing or ambiguous. */
const HARD_TOPIC_RX =
  /похідн|диференціал|інтеграл|логариф|арк(?:кос|ксин|танг)|тригонометр|комплексн|матриц|ймовірність.*формул|[\d]+\s*[∫∑Π√]|векторн.*множенн|стереометр|обертання|x\s*[\^²³]|y\s*=/msi

/** @typedef {{ ql: number, al: number, earlyTest: boolean, hay: string, topic: string }} ZnoTaskMeta */

/**
 * @param {string} subjectSlug
 * @param {number} testIndex
 * @param {number} numTests outer array length
 * @param {unknown} rawTask raw task obj (for comment/topic line)
 */
function taskMeta(subjectSlug, testIndex, numTests, rawTask) {
  const comment = typeof rawTask?.comment === 'string' ? rawTask.comment : ''
  const question = typeof rawTask?.question === 'string' ? rawTask.question : ''
  const answers = Array.isArray(rawTask?.answers) ? rawTask.answers : []
  let al = 0
  for (const a of answers) {
    const t = String(a?.text || '').length
    if (t > al) al = t
  }
  const nT = Number(numTests)
  const earlyTest =
    Number.isFinite(nT) && nT > 0 ? testIndex < Math.ceil(nT * 0.32) : true
  return {
    ql: question.length,
    al,
    earlyTest,
    hay: `${question}\n${comment}`.toLowerCase(),
    topic: extractZnoTopic(comment),
  }
}

/**
 * @param {unknown} task
 * @returns {string | null}
 */
function readTaskPhotoUrl(task) {
  if (!task || typeof task !== 'object' || task.with_photo !== true) return null
  const raw =
    typeof task.photo_url === 'string'
      ? task.photo_url.trim()
      : typeof task.photoUrl === 'string'
        ? task.photoUrl.trim()
        : ''
  if (!raw) return null
  try {
    const u = new URL(raw)
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.href
  } catch {
    /* ignore */
  }
  return null
}

function normalizeTask(subjectSlug, testIndex, numTests, task) {
  if (!task || typeof task !== 'object') return null
  const photoUrl = readTaskPhotoUrl(task)
  if (task.with_photo === true && !photoUrl) return null
  const answers = Array.isArray(task.answers) ? task.answers : []
  const nAnswers = answers.length
  if (nAnswers !== 4 && nAnswers !== 5) return null
  const ca = Array.isArray(task.correct_answer) ? task.correct_answer : []
  if (ca.length !== 1) return null
  const correctLetter = String(ca[0] || '').trim()
  if (!correctLetter) return null
  const normAnswers = answers.map((a) => ({
    letter: String(a.answer || '').trim(),
    text: String(a.text || '').trim(),
  }))
  if (normAnswers.some((a) => !a.letter || !a.text)) return null
  if (new Set(normAnswers.map((a) => a.letter)).size !== nAnswers) return null
  if (!normAnswers.some((a) => a.letter === correctLetter)) return null

  const tid = Number(task.task_id)
  const taskSuffix = Number.isFinite(tid) ? tid : '?'
  const taskKey = `${subjectSlug}#t${testIndex}#${taskSuffix}`
  const meta = taskMeta(subjectSlug, testIndex, numTests, task)

  return {
    taskKey,
    question: String(task.question || '').trim(),
    answers: normAnswers,
    correctLetter,
    photoUrl,
    /** @internal difficulty heuristics (not submitted to backend) */
    _meta: meta,
    subjectSlug,
  }
}

/**
 * Flat ZNO/NMT rows with heuristic metadata for difficulty by school grade.
 * @typedef {ZnoFlatTask & {_meta?: ZnoTaskMeta, subjectSlug?: string}} BankRow
 */

/**
 * @returns {BankRow[]}
 */
function flattenExamJson(subjectSlug, data) {
  /** @type {BankRow[]} */
  const out = []
  if (!Array.isArray(data)) return out
  const numTests = data.length

  data.forEach((rawTest, testIndex) => {
    const tasks = Array.isArray(rawTest?.tasks) ? rawTest.tasks : []
    tasks.forEach((task) => {
      const nt = normalizeTask(subjectSlug, testIndex, numTests, task)
      if (nt) out.push(nt)
    })
  })
  return out
}

/**
 * @param {typeof import('@/lib/znoQuizConstants').ZNO_QUIZ_SUBJECTS[0]} subject
 * @param {string} subjectSlug e.g. math
 */
export async function fetchZnoSubjectBank(subject, subjectSlug) {
  const ck = `${subjectSlug}:bankV5`
  const hit = _cache.get(ck)
  if (hit?.promise) return hit.promise

  const url = znoQuizDataUrl(subject)
  const promise = fetch(url, { credentials: 'omit' }).then(async (r) => {
    if (!r.ok) throw new Error(`Не вдалося завантажити банк питань (${r.status})`)
    return r.json()
  }).then((json) => flattenExamJson(subjectSlug, json))

  _cache.set(ck, { promise })
  return promise
}

/** @param {BankRow} t */
function metaOf(t) {
  const m = t._meta
  if (m && typeof m === 'object') return m
  const ql = String(t.question || '').length
  let al = 0
  for (const a of t.answers || []) {
    const L = String(a?.text || '').length
    if (L > al) al = L
  }
  return { ql, al, earlyTest: false, hay: String(t.question || '').toLowerCase(), topic: '' }
}

/**
 * @param {BankRow} row
 * @param {0|1|2} tierOrdinal
 * @param {number | null | undefined} grade
 */
function topicOk(row, tierOrdinal, grade) {
  const m = metaOf(row)
  const slug = row.subjectSlug || ''
  const suit = topicSuitability(slug, m.topic, tierOrdinal, grade)
  if (suit === 'block') return false
  if (suit === 'allow') return true
  return !HARD_TOPIC_RX.test(m.hay)
}

/**
 * Cascading filters by parallel (grade). Primary never falls back to «any» row — only non-blocked topics.
 * @param {0|1|2} tierOrdinal from {@link schoolTierOrdinalFromGrade}
 * @param {number | null | undefined} grade клас 1–11
 * @returns {Array<(row: BankRow) => boolean>}
 */
function difficultyPredicatesForTier(tierOrdinal, grade) {
  if (tierOrdinal === 2) {
    return [() => true]
  }
  if (tierOrdinal === 1) {
    return [
      (t) => {
        const m = metaOf(t)
        return topicOk(t, 1, grade) && m.ql <= 320 && m.al <= 200
      },
      (t) => {
        const m = metaOf(t)
        return topicOk(t, 1, grade) && m.ql <= 400 && m.al <= 260
      },
      (t) => topicOk(t, 1, grade),
    ]
  }
  /** Primary 1–4: тема з коментаря (allow/block) + короткий текст; без «будь-якого» ЗНО-питання в кінці */
  return [
    (t) => {
      const m = metaOf(t)
      return topicOk(t, 0, grade) && m.earlyTest && m.ql <= 85 && m.al <= 45
    },
    (t) => {
      const m = metaOf(t)
      return topicOk(t, 0, grade) && m.earlyTest && m.ql <= 110 && m.al <= 60
    },
    (t) => {
      const m = metaOf(t)
      return topicOk(t, 0, grade) && m.ql <= 130 && m.al <= 72
    },
    (t) => {
      const m = metaOf(t)
      return topicOk(t, 0, grade) && m.ql <= 160 && m.al <= 90
    },
    (t) => topicOk(t, 0, grade),
  ]
}

/**
 * @param {BankRow[] | ZnoFlatTask[]} bank
 * @param {string[]} consumedKeys already used keys (Firestore; all subjects merged)
 * @param {number | null | undefined} studentGrade клас 1–11 з назви класу; null → гурт як для старшої школи
 * @param {number} [need]
 */
export function pickRandomQuizTasks(bank, consumedKeys, studentGrade, need = 5) {
  const used = new Set(consumedKeys.map(String))
  const avail = bank.filter((t) => !used.has(t.taskKey))
  if (avail.length < need) {
    throw new Error(
      'Недостатньо нових питань за цим предметом (усі підходящі ви вже проходили). '
      + 'Оберіть інший предмет або попросить адміністратора доповнити банк.',
    )
  }

  const g = Number(studentGrade)
  const tier = schoolTierOrdinalFromGrade(Number.isFinite(g) && g >= 1 ? g : null)

  for (const pred of difficultyPredicatesForTier(tier, Number.isFinite(g) && g >= 1 ? g : null)) {
    const pool = avail.filter((t) => pred(/** @type {BankRow} */ (t)))
    if (pool.length >= need) return shufflePick(pool, need)
  }
  return shufflePick(avail, need)
}

function shufflePick(arr, n) {
  const copy = [...arr]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy.slice(0, n)
}

/** Fisher–Yates shuffle for answer rows (keeps original letter per option). */
export function shuffleAnswersForDisplay(answers) {
  const copy = [...answers]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}
