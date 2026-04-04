/**
 * Bulk-create teachers and students from the school roster (admin tools).
 * Skips users whose displayName already exists among teachers/students.
 */

import { createUserWithEmailAndPassword, updateProfile, signInWithEmailAndPassword } from 'firebase/auth'
import { setDoc, doc, serverTimestamp, arrayUnion } from 'firebase/firestore'
import { auth as fbAuth, db } from './config'
import {
  getAllSubjects,
  getAllClasses,
  getAllTeachers,
  getAllStudents,
  createAccessCode,
  updateClass,
  DEFAULT_DAILY_BUDGET,
} from './collections'
import { nameToEmail } from '../composables/useNameToEmail'

/** @type {Array<[string, string[]]>} displayName, canonical subject names (as in Firestore / seed) */
export const ROSTER_TEACHERS = [
  ['Корогод Тетяна', ['Математика']],
  ['Івасенко Юлія', ['Навчання грамоти']],
  ['Михайленко Лілія', ['Навчання грамоти']],
  ['Яценко Алла', ['Навчання грамоти']],
  ['Казмерчук Алла', ['Історія']],
  ['Осташевська Людмила', ['Англійська мова']],
  ['Раскіта Альона', ['Англійська мова']],
  ['Худіяш Дмитро', ['Інформатика']],
  ['Жаринова Владислава', ['Українська мова', 'Українська література']],
  ['Цибулькіна Анастасія', ['Географія']],
  ['Молчан Вікторія', ['Фізична культура']],
  ['Мединська Анжеліка', ['Година психолога']],
  ['Черкас Олександр', ['Українська література']],
  ['Миргородська Дарина', ['Образотворче мистецтво']],
  ['Мельниченко Руслана', ['Музичне мистецтво']],
  ['Тітов Олександр', ['Німецька мова', 'Англійська мова']],
  ['Подобєд Сергій', ['Хімія']],
  ['Войтенко Олег', ['Фізика']],
  ['Нікуліна Ярослава', ['Українська мова', 'Українська література']],
]

/** @type {Array<[string, number]>} displayName, grade (class number) */
export const ROSTER_STUDENTS = [
  ['Буковчаник Іван', 1],
  ['Володькін Артем', 1],
  ['Єршов Сергій', 1],
  ['Каріка-Микитюк Адріан', 1],
  ['Непомнящий Давід', 1],
  ['Чалков Макар', 1],
  ['Чуйков Макар', 1],
  ['Ардатов Марк', 2],
  ['Денисенко Олексій', 2],
  ['Ігнатов Ренат', 2],
  ['Люханов Михайло', 2],
  ['Гайдук Адріан', 4],
  ['Каденко Артем', 4],
  ['Каріка Аделіна', 4],
  ['Пашаєва Нурай', 4],
  ['Каріка Амалія', 5],
  ['Понкратов Володимир', 5],
  ['Денисенко Мілана', 6],
  ['Сметана Володимир', 6],
  ['Гарматіна Марія', 7],
  ['Кізуб-Притиченко Вайнона', 7],
  ['Кнох Данііл', 7],
  ['Колток Еліна', 7],
  ['Коржик Мирослав', 7],
  ['Нікітін Лев', 7],
  ['Каріка Афіна', 8],
  ['Ширий Христина', 8],
  ['Григорьєва Єва', 8],
  ['Недошевський Матвій', 8],
  ['Крижко Назарій', 8],
  ['Єршов Михайло', 9],
  ['Можаровська Софія', 9],
  ['Бичкова Поліна', 10],
  ['Мандрик Єва', 10],
  ['Москаленко Іванна', 10],
]

function normName(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase()
}

function generateTeacherCode() {
  const adjs = ['TEACH', 'PROF', 'GUIDE', 'TUTOR', 'COACH', 'MENTOR']
  return `${adjs[Math.floor(Math.random() * adjs.length)]}-${Math.floor(1000 + Math.random() * 9000)}`
}

function generateStudentCode() {
  const adjs = ['SWIFT', 'BRAVE', 'SMART', 'COOL', 'EPIC', 'WILD', 'STAR', 'HERO', 'GOLD', 'IRON', 'BOLD', 'KEEN']
  return `${adjs[Math.floor(Math.random() * adjs.length)]}-${Math.floor(1000 + Math.random() * 9000)}`
}

function resolveSubjectIds(subjectNames, subjects) {
  const norm = (x) => normName(x)
  const ids = []
  for (const raw of subjectNames) {
    const want = norm(raw)
    let sub = subjects.find((s) => norm(s.name) === want)
    if (!sub) {
      sub = subjects.find((s) => {
        const n = norm(s.name)
        return n === want || n.includes(want) || want.includes(n)
      })
    }
    if (sub && !ids.includes(sub.id)) ids.push(sub.id)
  }
  return ids
}

function classIdForGrade(grade, classes) {
  const n = Number(grade)
  const list = classes.filter((c) => {
    const m = String(c.name || '').trim().match(/^(\d+)/)
    return m && parseInt(m[1], 10) === n
  })
  if (!list.length) return null
  list.sort((a, b) => a.name.length - b.name.length || String(a.name).localeCompare(String(b.name), 'uk'))
  return list[0].id
}

async function registerUser(displayName, adminEmail, adminCode, generateCode) {
  const code = generateCode()
  let email = nameToEmail(displayName)
  let attempt = 0
  let created = null
  while (attempt < 10) {
    try {
      created = await createUserWithEmailAndPassword(fbAuth, email, code)
      break
    } catch (e) {
      if (e.code === 'auth/email-already-in-use') {
        attempt++
        email = nameToEmail(displayName).replace('@fus.ua', `${attempt}@fus.ua`)
      } else {
        throw e
      }
    }
  }
  if (!created) throw new Error(`Не вдалося створити акаунт для ${displayName}`)
  await updateProfile(created.user, { displayName })
  const uid = created.user.uid
  await signInWithEmailAndPassword(fbAuth, adminEmail, adminCode)
  return { uid, email, code }
}

/**
 * @param {{ adminEmail: string, adminCode: string }} opts
 */
export async function seedSchoolRoster({ adminEmail, adminCode }) {
  if (!adminEmail || !adminCode) {
    throw new Error('Потрібні email і код адміністратора для повторного входу після створення акаунтів')
  }

  const [subjects, classes, teachers, students] = await Promise.all([
    getAllSubjects(),
    getAllClasses(),
    getAllTeachers(),
    getAllStudents(),
  ])

  const existing = new Set([
    ...teachers.map((t) => normName(t.displayName)),
    ...students.map((s) => normName(s.displayName)),
  ])

  const warnings = []
  const errors = []
  let teachersCreated = 0
  let teachersSkipped = 0
  let studentsCreated = 0
  let studentsSkipped = 0

  for (const [displayName, subjectNames] of ROSTER_TEACHERS) {
    if (existing.has(normName(displayName))) {
      teachersSkipped++
      continue
    }
    try {
      const subjectIds = resolveSubjectIds(subjectNames, subjects)
      if (subjectIds.length < subjectNames.length) {
        warnings.push(`${displayName}: не всі предмети знайдено у БД (${subjectNames.join(', ')})`)
      }
      const { uid, email, code } = await registerUser(
        displayName,
        adminEmail,
        adminCode,
        generateTeacherCode,
      )
      await setDoc(doc(db, 'users', uid), {
        displayName,
        email,
        role: 'teacher',
        accessCode: code,
        classIds: [],
        subjectIds,
        classId: null,
        coins: 0,
        xp: 0,
        level: 1,
        streak: 0,
        lastLoginDate: null,
        avatar: { skinId: 'default', backgroundId: 'default', frameId: 'none', accessories: [] },
        inventory: [],
        badges: [],
        createdAt: serverTimestamp(),
        coinsBudgetDaily: DEFAULT_DAILY_BUDGET,
      })
      await createAccessCode(code, { email, uid, displayName, role: 'teacher', classId: null })
      existing.add(normName(displayName))
      teachersCreated++
    } catch (e) {
      errors.push(`${displayName} (вчитель): ${e.message || e}`)
    }
  }

  for (const [displayName, grade] of ROSTER_STUDENTS) {
    if (existing.has(normName(displayName))) {
      studentsSkipped++
      continue
    }
    const classId = classIdForGrade(grade, classes)
    if (!classId) {
      warnings.push(`${displayName}: клас «${grade}» не знайдено — учень без класу`)
    }
    try {
      const { uid, email, code } = await registerUser(
        displayName,
        adminEmail,
        adminCode,
        generateStudentCode,
      )
      await setDoc(doc(db, 'users', uid), {
        displayName,
        email,
        role: 'student',
        accessCode: code,
        classId: classId || null,
        classIds: [],
        coins: 0,
        xp: 0,
        level: 1,
        streak: 0,
        lastLoginDate: null,
        avatar: { skinId: 'default', backgroundId: 'default', frameId: 'none', accessories: [] },
        inventory: [],
        badges: [],
        createdAt: serverTimestamp(),
      })
      await createAccessCode(code, {
        email,
        uid,
        displayName,
        role: 'student',
        classId: classId || null,
      })
      if (classId) await updateClass(classId, { studentIds: arrayUnion(uid) })
      existing.add(normName(displayName))
      studentsCreated++
    } catch (e) {
      errors.push(`${displayName} (учень): ${e.message || e}`)
    }
  }

  return {
    teachersCreated,
    teachersSkipped,
    studentsCreated,
    studentsSkipped,
    warnings,
    errors,
  }
}
