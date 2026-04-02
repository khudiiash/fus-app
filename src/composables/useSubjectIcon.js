/**
 * Subject-name → emoji auto-detection + full icon picker list.
 * Rules are matched in order; first keyword hit wins.
 */

const RULES = [
  // ── Languages ────────────────────────────────────────────────────────────
  { keys: ['англійська', 'english', 'іноземна мова'],     icon: '🇬🇧' },
  { keys: ['німецька'],                                     icon: '🇩🇪' },
  { keys: ['польська', 'polska'],                          icon: '🇵🇱' },
  { keys: ['українська мова', 'навчання грамоти', 'читання', 'літературне читання'], icon: '🇺🇦' },
  { keys: ['українська література', 'зарубіжна літератур'], icon: '📚' },

  // ── Mathematics ──────────────────────────────────────────────────────────
  { keys: ['алгебр'],                                       icon: '📐' },
  { keys: ['геометр'],                                      icon: '📏' },
  { keys: ['математик'],                                    icon: '🔢' },

  // ── Natural sciences ─────────────────────────────────────────────────────
  { keys: ['біологі', 'екологі'],                          icon: '🧬' },
  { keys: ['хімі'],                                        icon: '⚗️' },
  { keys: ['фізик', 'астроном'],                           icon: '⚛️' },
  { keys: ['географ'],                                     icon: '🗺️' },
  { keys: ['пізнаємо природу', 'яд', 'я досліджу', 'природ', 'stem'], icon: '🌿' },

  // ── History & Social ─────────────────────────────────────────────────────
  { keys: ['всесвітня історія', '世界史'],                  icon: '🌍' },
  { keys: ['історія україни'],                             icon: '🏰' },
  { keys: ['вступ до істор'],                              icon: '📜' },
  { keys: ['істор'],                                       icon: '🏛️' },
  { keys: ['historia'],                                    icon: '🏛️' },
  { keys: ['громадянська', 'правознавств', 'основи права', 'edukacja obywatelska', 'wos', 'суспільствознав'], icon: '⚖️' },

  // ── Arts ─────────────────────────────────────────────────────────────────
  { keys: ['образотворче', 'малюванн'],                    icon: '🖼️' },
  { keys: ['музичне', 'музик'],                            icon: '🎵' },
  { keys: ['мистецтв'],                                    icon: '🎭' },

  // ── Technology & Design ──────────────────────────────────────────────────
  { keys: ['інформатик', 'computer'],                      icon: '💻' },
  { keys: ['технологі', 'дизайн', 'трудове'],             icon: '⚙️' },

  // ── Health & PE ──────────────────────────────────────────────────────────
  { keys: ['фізична культура', 'фізкультур', 'фізичн'],   icon: '🏃' },
  { keys: ["здоров'я", 'здоровя', 'добробут', 'безпека'], icon: '💚' },
  { keys: ['захист украін', 'захист укр'],                 icon: '🛡️' },

  // ── Homeroom / Soft-skills ────────────────────────────────────────────────
  { keys: ['емоційн'],                                     icon: '💭' },
  { keys: ['психолог'],                                    icon: '🧠' },
  { keys: ['громадянськ'],                                 icon: '🗳️' },
  { keys: ['класним керівник', 'куратор', 'кураторськ', 'година з'],  icon: '👨‍🏫' },
  { keys: ['додаткова година'],                            icon: '⏰' },

  // ── Polish-language curriculum ───────────────────────────────────────────
  { keys: ['польська культур'],                            icon: '🇵🇱' },
]

/**
 * Returns the best-matching emoji for a given subject name,
 * or a default bookmark emoji if nothing matches.
 */
export function getSubjectIcon(name = '') {
  const lower = name.toLowerCase().trim()
  if (!lower) return '📖'
  for (const rule of RULES) {
    if (rule.keys.some(k => lower.includes(k.toLowerCase()))) return rule.icon
  }
  return '📖'
}

/** Full list of emoji available in the manual picker */
export const SUBJECT_ICONS = [
  // Languages
  '🇺🇦', '🇬🇧', '🇩🇪', '🇵🇱',
  '📚', '📖', '📝', '✏️',
  // Maths & Sciences
  '🔢', '📐', '📏', '🧮',
  '⚛️', '⚗️', '🧬', '🔬', '🔭',
  // Geography / History / Social
  '🌍', '🗺️', '🏛️', '🏰', '📜', '⚖️', '🗳️',
  // Nature
  '🌿', '🍃', '🌱',
  // Technology
  '💻', '⚙️', '🛠️', '🔧',
  // Arts & Music
  '🎨', '🖼️', '🎭', '🎵', '🎶',
  // PE / Health
  '🏃', '⚽', '🏋️', '💚', '🛡️',
  // Soft-skills / Homeroom
  '👨‍🏫', '🧠', '💭', '🤝', '⏰',
  // Misc
  '📗', '📘', '📙', '🌐', '🏫',
]
