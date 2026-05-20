/**
 * Dev: скільки MCQ на предмет доступні для кожного класу (1–11).
 * node scripts/zno-grade-inventory.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const ztmp = join(root, 'ztmp')

const SUBJECTS = [
  { slug: 'math', file: 'math_raw.json' },
  { slug: 'ukr_lang_lit', file: 'ukrainian_raw.json' },
  { slug: 'history', file: 'history_raw.json' },
  { slug: 'geography', file: 'geography_raw.json' },
]

// Inline minimal copy of normalize + grade rules (keep in sync with src/lib)
const { inferCurriculumGradeRange, isTaskAppropriateForGrade } = await import(
  pathToFileURL(join(root, 'src/lib/znoCurriculumGrades.js')).href,
)

function extractZnoTopic(comment) {
  const m = String(comment || '').match(/ТЕМА:\s*(.+)/i)
  return (m ? m[1] : String(comment || '')).trim().toLowerCase()
}

function flattenMeta(subjectSlug, data) {
  const out = []
  if (!Array.isArray(data)) return out
  for (const rawTest of data) {
    const tasks = Array.isArray(rawTest?.tasks) ? rawTest.tasks : []
    for (const t of tasks) {
      const answers = Array.isArray(t?.answers) ? t.answers : []
      const n = answers.length
      if (n !== 4 && n !== 5) continue
      const ca = Array.isArray(t.correct_answer) ? t.correct_answer : []
      if (ca.length !== 1) continue
      const correct = String(ca[0] || '').trim()
      const letters = answers.map((a) => String(a?.answer || '').trim())
      if (!letters.includes(correct)) continue
      const comment = String(t.comment || '')
      const hay = `${t.question || ''}\n${comment}`.toLowerCase()
      const topic = extractZnoTopic(comment)
      const gr = inferCurriculumGradeRange(subjectSlug, topic, hay)
      out.push({ subjectSlug, topic, hay, gradeMin: gr.gradeMin, gradeMax: gr.gradeMax })
    }
  }
  return out
}

for (const { slug, file } of SUBJECTS) {
  const path = join(ztmp, file)
  if (!existsSync(path)) {
    console.log(`${slug}: missing ${file}`)
    continue
  }
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  const bank = flattenMeta(slug, raw)
  const counts = []
  for (let g = 1; g <= 11; g++) {
    const n = bank.filter((row) =>
      isTaskAppropriateForGrade(slug, row, g),
    ).length
    counts.push(`${g}:${n}`)
  }
  console.log(`${slug} total=${bank.length}  ${counts.join('  ')}`)
}
