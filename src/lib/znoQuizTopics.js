/**
 * Topic lines from NLPForUA/ZNO tasks: `comment` → «ТЕМА: …».
 * Used to keep quiz items appropriate for 1–4 / 5–8 / 9–11 grade bands.
 */

/**
 * @param {string} comment raw task.comment
 * @returns {string} normalized topic (lowercase) or ''
 */
export function extractZnoTopic(comment) {
  const c = String(comment || '').trim()
  if (!c) return ''
  const m = c.match(/ТЕМА:\s*(.+)/i)
  return (m ? m[1] : c).trim().toLowerCase()
}

/** Topics / wording too advanced for молодша школа (1–4) — any match → exclude. */
const PRIMARY_BLOCK_MATH = [
  /похідн/,
  /первісн/,
  /диференці/,
  /інтеграл/,
  /логариф/,
  /тригонометр/,
  /стереометр/,
  /тіл[а]?\s+обертання/,
  /обертання/,
  /комбінаторик/,
  /ймовірност/,
  /математичн.*статистик/,
  /вектор/,
  /координат.*простор/,
  /у\s+просторі/,
  /функці[їі]/,
  /рівнян/,
  /нерівност/,
  /функці[їі].*похідн/,
  /дослідження\s+функці/,
  /числові\s+послідовност/,
  /нерівност.*систем/,
  /систем.*нерівност/,
  /ірраціональн/,
  /показников/,
  /многогранник/,
]

/** Математика 1–4: лише «базові» розділи з коментарів банку. */
const PRIMARY_ALLOW_MATH = [
  /планіметр/,
  /елементарн.*геометр/,
  /трикутник/,
  /чотирикутник/,
  /коло\s+та\s+круг/,
  /дійсні\s+числа/,
  /відсотк/,
  /пропорц/,
  /основні\s+задачі/,
  /відношенн/,
]

const PRIMARY_BLOCK_UKR = [
  /література\s+xx/,
  /література\s+кінця\s+xviii/,
  /література\s+кінця\s+18/,
  /аналіз\s+літературн/,
  /котляревськ/,
  /куліш/,
  /мирний/,
  /нечуй/,
  /карпенко/,
  /костенко/,
  /енеїда/,
  /слово\s+про\s+похід/,
  /хіба\s+ревуть/,
  /наталка\s+полтавка/,
  /маруся\s+чурай/,
  /кайдашева/,
  /мартин\s+боруля/,
  /чорна\s+рада/,
]

const PRIMARY_ALLOW_UKR = [
  /орфограф/,
  /орфоеп/,
  /наголос/,
  /морфолог/,
  /частини\s+мови/,
  /синтаксис/,
  /лексик/,
  /фразеолог/,
  /словотвір/,
  /будова\s+слова/,
  /значущі\s+частини/,
  /розвиток\s+мовлення/,
  /зміст\s+і\s+будова\s+тексту/,
  /текст\s+як\s+середовище/,
  /пунктуац/,
  /звук/,
]

const PRIMARY_BLOCK_HISTORY = [
  /друга\s+світова/,
  /перша\s+світова/,
  /революці/,
  /тоталітар/,
  /десталінізац/,
  /сталін/,
  /комуністичн/,
  /незалежності\s+україни/,
  /відновлення\s+незалежності/,
  /умовах\s+незалежності/,
  /російськ.*імпер/,
  /наддніпрянськ/,
  /західноукраїнськ/,
  /міжвоєнн/,
  /повоєнн/,
  /хмельницьк/,
  /національно-визвольн/,
  /укрср/,
  /радянськ/,
  /кризи\s+радянськ/,
  /голодомор/,
  /перебудов/,
]

const PRIMARY_ALLOW_HISTORY = [
  /стародавн/,
  /давн.*україн/,
  /київськ.*держав/,
  /русь-україн/,
  /русь\s*україн/,
  /князівств/,
  /трипіл/,
  /східні\s+слов/,
]

const PRIMARY_BLOCK_GEOGRAPHY = [
  /вторинний\s+сектор/,
  /третинний\s+сектор/,
  /металург/,
  /машинобуд/,
  /хімічн.*промисл/,
  /глобальн.*проблем/,
  /політична\s+карта\s+світу/,
  /міграційн.*політик/,
  /геополітик/,
  /транспорт.*коридор/,
  /енергетичн.*баланс/,
]

const PRIMARY_ALLOW_GEOGRAPHY = [
  /географічн.*координат/,
  /масштаб/,
  /азимут/,
  /рельєф/,
  /тектоніч/,
  /геологічн/,
  /ландшафт/,
  /клімат/,
  /ґрунт/,
  /води\s+суходолу/,
  /водні\s+ресурс/,
  /природокористування/,
  /населення/,
  /демографічн/,
  /сільськ.*господар/,
  /первинний\s+сектор/,
  /добувн/,
  /ліс/,
  /рослинн/,
  /тваринн/,
  /карта\s+україни/,
  /географічний\s+простір/,
  /годинних\s+пояс/,
  /висот.*місцевост/,
  /способи\s+зображення\s+земл/,
]

/** @type {Record<string, RegExp[]>} */
export const PRIMARY_TOPIC_BLOCK_BY_SUBJECT = {
  math: PRIMARY_BLOCK_MATH,
  ukr_lang_lit: PRIMARY_BLOCK_UKR,
  history: PRIMARY_BLOCK_HISTORY,
  geography: PRIMARY_BLOCK_GEOGRAPHY,
}

/** @type {Record<string, RegExp[]>} */
export const PRIMARY_TOPIC_ALLOW_BY_SUBJECT = {
  math: PRIMARY_ALLOW_MATH,
  ukr_lang_lit: PRIMARY_ALLOW_UKR,
  history: PRIMARY_ALLOW_HISTORY,
  geography: PRIMARY_ALLOW_GEOGRAPHY,
}

/** Middle school (5–8): block clearly senior-only topics. */
const MIDDLE_BLOCK_COMMON = [
  /похідн/,
  /інтеграл/,
  /диференці/,
  /логарифмічн/,
  /тригонометр.*перетвор/,
  /дослідження\s+функці.*похідн/,
]

/**
 * @param {string} subjectSlug
 * @param {string} topic normalized lowercase
 * @returns {boolean} true if topic line is blocked for 1–4
 */
export function isTopicBlockedForPrimary(subjectSlug, topic) {
  const t = String(topic || '').trim()
  if (!t) return false
  const blocks = PRIMARY_TOPIC_BLOCK_BY_SUBJECT[subjectSlug] || []
  return blocks.some((rx) => rx.test(t))
}

/**
 * @param {string} subjectSlug
 * @param {string} topic normalized lowercase
 * @returns {boolean} true if topic is in the allow-list for 1–4
 */
export function isTopicAllowedForPrimary(subjectSlug, topic) {
  const t = String(topic || '').trim()
  if (!t) return false
  const allows = PRIMARY_TOPIC_ALLOW_BY_SUBJECT[subjectSlug]
  if (!allows?.length) return false
  return allows.some((rx) => rx.test(t))
}

/**
 * @param {string} subjectSlug
 * @param {string} topic
 * @returns {boolean}
 */
export function isTopicBlockedForMiddle(subjectSlug, topic) {
  const t = String(topic || '').trim()
  if (!t) return false
  if (MIDDLE_BLOCK_COMMON.some((rx) => rx.test(t))) return true
  if (subjectSlug === 'math' && /стереометр.*вектор|координат.*вектор/.test(t)) return true
  return false
}

/**
 * Suitability from parsed topic + subject for grade band.
 * @param {string} subjectSlug
 * @param {string} topic
 * @param {0|1|2} tierOrdinal
 * @param {number | null | undefined} grade 1–11
 * @returns {'allow'|'block'|'neutral'} neutral → fall back to text-length heuristics only
 */
export function topicSuitability(subjectSlug, topic, tierOrdinal, grade) {
  const t = String(topic || '').trim()
  if (!t) return 'neutral'

  if (tierOrdinal === 0) {
    if (isTopicBlockedForPrimary(subjectSlug, t)) return 'block'
    const g = Number(grade)
    if (Number.isFinite(g) && g <= 2) {
      return isTopicAllowedForPrimary(subjectSlug, t) ? 'allow' : 'block'
    }
    if (isTopicAllowedForPrimary(subjectSlug, t)) return 'allow'
    return 'block'
  }

  if (tierOrdinal === 1) {
    return isTopicBlockedForMiddle(subjectSlug, t) ? 'block' : 'neutral'
  }

  return 'neutral'
}
