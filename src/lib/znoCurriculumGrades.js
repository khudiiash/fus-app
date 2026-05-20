/**
 * Прив’язка питань ZNO (поле comment «ТЕМА: …») до класів 1–11 за змістом
 * чинних навчальних програм (ДСБО / типові розділи 5–11, базові теми 1–4).
 *
 * Це евристика по ключових словах у рядку теми, не повний парсинг PDF програм.
 * Невідомі теми за замовчуванням — 10–11 клас (рівень ЗНО/НМТ).
 */

/** @typedef {{ rx: RegExp, min: number, max: number }} CurriculumGradeRule */

/** @typedef {{ gradeMin: number, gradeMax: number, matched: boolean }} GradeRange */

const DEFAULT_ZNO_GRADE = { gradeMin: 10, gradeMax: 11, matched: false }

/**
 * @param {CurriculumGradeRule[]} rules
 * @param {string} topic
 * @returns {GradeRange | null}
 */
function matchRules(rules, topic) {
  const t = String(topic || '').trim()
  if (!t) return null
  for (const { rx, min, max } of rules) {
    if (rx.test(t)) return { gradeMin: min, gradeMax: max, matched: true }
  }
  return null
}

/** Математика (програма 5–9: алгебра + геометрія; 10–11: аналіз, стереометрія, ЗНО). */
const MATH_RULES = /** @type {CurriculumGradeRule[]} */ ([
  { rx: /похідн|первісн|інтеграл|диференці|дослідження\s+функці/, min: 11, max: 11 },
  { rx: /тригонометр/, min: 10, max: 11 },
  { rx: /логариф|показников|ірраціональн/, min: 10, max: 11 },
  { rx: /стереометр|обертання|многогранник|координат.*простор|вектор.*простор/, min: 10, max: 11 },
  { rx: /ймовірност|комбінаторик|математичн.*статистик/, min: 10, max: 11 },
  { rx: /числові\s+послідовност/, min: 9, max: 11 },
  { rx: /функці[їі]/, min: 9, max: 11 },
  { rx: /рівнян.*систем|систем.*рівнян|нерівност.*систем/, min: 9, max: 11 },
  { rx: /нерівност/, min: 8, max: 11 },
  { rx: /рівнян/, min: 7, max: 10 },
  { rx: /відсотк|пропорц|відношенн|основні\s+задачі/, min: 5, max: 8 },
  { rx: /дійсні\s+числа/, min: 7, max: 9 },
  { rx: /раціональн.*вираз/, min: 7, max: 9 },
  { rx: /степінь|степен/, min: 7, max: 8 },
  { rx: /числа\s+(і|та)\s+вирази/, min: 5, max: 8 },
  { rx: /коло\s+та\s+круг/, min: 8, max: 9 },
  { rx: /трикутник/, min: 7, max: 9 },
  { rx: /чотирикутник/, min: 7, max: 9 },
  { rx: /елементарн.*геометр/, min: 5, max: 7 },
  { rx: /планіметр/, min: 7, max: 9 },
  { rx: /геометрія/, min: 7, max: 11 },
  { rx: /алгебра/, min: 7, max: 11 },
])

/** Українська мова (1–4: мовлення/орфографія; 5–9: граматика; 8–11: література). */
const UKR_RULES = /** @type {CurriculumGradeRule[]} */ ([
  { rx: /література\s+xx|література\s+кінця\s+(xviii|18)|аналіз\s+літературн/, min: 9, max: 11 },
  { rx: /котляревськ|куліш|мирний|нечуй|карпенко|костенко|енеїда|слово\s+про\s+похід|хіба\s+ревуть|наталка|маруся|кайдашева|мартин\s+боруля|чорна\s+рада/, min: 8, max: 11 },
  { rx: /давня\s+українська\s+література|література\s+доби/, min: 6, max: 8 },
  { rx: /література/, min: 8, max: 11 },
  { rx: /синтаксис|складн.*речен/, min: 6, max: 9 },
  { rx: /морфолог|частини\s+мови|дієслів|іменник|прикметник/, min: 5, max: 8 },
  { rx: /орфограф|орфоеп|наголос|пунктуац/, min: 3, max: 11 },
  { rx: /лексик|фразеолог|словотвір|будова\s+слова|значущі\s+частини/, min: 5, max: 9 },
  { rx: /розвиток\s+мовлення|зміст\s+і\s+будова\s+тексту|текст\s+як\s+середовище|мікротем/, min: 3, max: 6 },
  { rx: /звук|фонетик/, min: 3, max: 5 },
])

/** Історія України (програма 5–6: стародавність; 7–8: Київська Русь; 9–11: ХХ ст.). */
const HISTORY_RULES = /** @type {CurriculumGradeRule[]} */ ([
  { rx: /друга\s+світова|перша\s+світова|друга\s+світова/, min: 10, max: 11 },
  { rx: /революці|тоталітар|сталін|голодомор|перебудов|десталінізац/, min: 10, max: 11 },
  { rx: /незалежності|відновлення\s+незалежності|умовах\s+незалежності/, min: 10, max: 11 },
  { rx: /укрср|радянськ|комуністичн|кризи\s+радянськ/, min: 10, max: 11 },
  { rx: /міжвоєнн|повоєнн|західноукраїнськ/, min: 10, max: 11 },
  { rx: /російськ.*імпер|наддніпрянськ/, min: 9, max: 11 },
  { rx: /національно-визвольн|хмельницьк|козацьк/, min: 8, max: 10 },
  { rx: /галицько-волинськ|роздроблен/, min: 7, max: 9 },
  { rx: /київськ|русь-україн|русь\s*україн|князівств/, min: 7, max: 8 },
  { rx: /стародавн|трипіл|східні\s+слов|кочовик|половец/, min: 6, max: 7 },
  { rx: /українські\s+землі/, min: 8, max: 11 },
])

/** Географія (6–7: карта й природа; 8–9: Україна; 10–11: господарство світу). */
const GEOGRAPHY_RULES = /** @type {CurriculumGradeRule[]} */ ([
  { rx: /глобальн.*проблем|геополітик|міграційн.*політик|політична\s+карта\s+світу/, min: 10, max: 11 },
  { rx: /вторинний\s+сектор|третинний\s+сектор|металург|машинобуд|хімічн.*промисл/, min: 9, max: 11 },
  { rx: /національна\s+економіка|світове\s+господарство|економіко-географічний/, min: 9, max: 11 },
  { rx: /демографічн|населення/, min: 7, max: 10 },
  { rx: /природокористування/, min: 8, max: 10 },
  { rx: /рельєф|тектоніч|геологічн|ландшафт|клімат|ґрунт|води\s+суходолу|водні\s+ресурс/, min: 6, max: 9 },
  { rx: /сільськ.*господар|первинний\s+сектор|добувн|ліс|рослинн|тваринн/, min: 7, max: 9 },
  { rx: /географічн.*координат|масштаб|азимут|способи\s+зображення|висот.*місцевост/, min: 6, max: 8 },
  { rx: /географічний\s+простір|годинних\s+пояс|карта\s+україни/, min: 6, max: 8 },
  { rx: /земля\s+на\s+плані/, min: 6, max: 7 },
  { rx: /природні\s+умови/, min: 6, max: 9 },
])

/** @type {Record<string, CurriculumGradeRule[]>} */
const RULES_BY_SUBJECT = {
  math: MATH_RULES,
  ukr_lang_lit: UKR_RULES,
  history: HISTORY_RULES,
  geography: GEOGRAPHY_RULES,
}

/** Занадто «старші» формулювання в тексті питання для молодших класів. */
const HARD_QUESTION_RX =
  /похідн|диференціал|інтеграл|логариф|тригонометр|стереометр|x\s*[\^²³]|y\s*=\s*[^0-9]|√|∫/i

/**
 * @param {string} subjectSlug
 * @param {string} topic normalized
 * @param {string} [questionHay] question + comment lowercase
 * @returns {GradeRange}
 */
export function inferCurriculumGradeRange(subjectSlug, topic, questionHay = '') {
  const rules = RULES_BY_SUBJECT[subjectSlug]
  const hit = rules ? matchRules(rules, topic) : null
  if (hit) return hit
  return { ...DEFAULT_ZNO_GRADE }
}

/**
 * @param {number | null | undefined} grade 1–11
 * @param {number} gradeMin
 * @param {number} gradeMax
 */
export function gradeWithinRange(grade, gradeMin, gradeMax) {
  const g = Number(grade)
  const min = Number(gradeMin)
  const max = Number(gradeMax)
  if (!Number.isFinite(min) || !Number.isFinite(max)) return false
  if (!Number.isFinite(g) || g < 1) return min <= 9 && max >= 9
  return g >= min && g <= max
}

/**
 * @param {string} subjectSlug
 * @param {{ topic?: string, hay?: string, gradeMin?: number, gradeMax?: number }} meta
 * @param {number | null | undefined} studentGrade
 */
export function isTaskAppropriateForGrade(subjectSlug, meta, studentGrade) {
  const g = Number(studentGrade)
  let gradeMin = meta?.gradeMin
  let gradeMax = meta?.gradeMax
  if (!Number.isFinite(gradeMin) || !Number.isFinite(gradeMax)) {
    const inferred = inferCurriculumGradeRange(subjectSlug, meta?.topic || '', meta?.hay || '')
    gradeMin = inferred.gradeMin
    gradeMax = inferred.gradeMax
  }
  if (!gradeWithinRange(g, gradeMin, gradeMax)) return false
  if (Number.isFinite(g) && g <= 8 && HARD_QUESTION_RX.test(meta?.hay || '')) return false
  return true
}

/**
 * Коротка підказка для UI (діапазон класів теми).
 * @param {number} gradeMin
 * @param {number} gradeMax
 */
export function formatGradeRangeLabel(gradeMin, gradeMax) {
  const a = Number(gradeMin)
  const b = Number(gradeMax)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return ''
  if (a === b) return `${a} клас`
  return `${a}–${b} клас`
}
