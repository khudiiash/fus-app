<script setup>
import { ref, onMounted, computed } from 'vue'
import {
  getAllStudents, getAllClasses, createAccessCode,
  updateUser, updateClass, deleteUserData, adminUpdateStudentProfile, adminRotateStudentAccessCode,
} from '@/firebase/collections'
import {
  createUserWithEmailAndPassword,
  updatePassword,
  updateProfile,
  signInWithEmailAndPassword,
} from 'firebase/auth'
import { auth as fbAuth, db } from '@/firebase/config'
import { setDoc, doc, serverTimestamp, arrayUnion } from 'firebase/firestore'
import { useAuthStore } from '@/stores/auth'
import { nameToEmail } from '@/composables/useNameToEmail'
import AppButton from '@/components/ui/AppButton.vue'
import AppModal from '@/components/ui/AppModal.vue'
import AppInput from '@/components/ui/AppInput.vue'
import { useToast } from '@/composables/useToast'
import { Trash2, UserX, Copy, Users, Search, X, Pencil, Bell } from 'lucide-vue-next'
import { adminBroadcastToStudents } from '@/firebase/adminPush'
import { gradeFromClassName as gradeFromName, schoolTierEmojiForClassName } from '@/utils/schoolTier'

const authStore  = useAuthStore()
const { success, error, info } = useToast()

const students    = ref([])
const classes     = ref([])
const showModal   = ref(false)
const showCode    = ref(null)
const saving      = ref(false)
const search      = ref('')
const filterClass = ref('')
const confirmDeleteId = ref(null)
const deleting    = ref(false)

const form = ref({ displayName: '', classId: '' })

onMounted(async () => {
  await Promise.all([fetchStudents(), fetchClasses()])
})

async function fetchStudents() { students.value = await getAllStudents() }
async function fetchClasses()  { classes.value  = await getAllClasses()  }

function compareClassesByGrade(a, b) {
  const ga = gradeFromName(a.name) ?? 1000
  const gb = gradeFromName(b.name) ?? 1000
  if (ga !== gb) return ga - gb
  return String(a.name).localeCompare(String(b.name), 'uk')
}

const isFiltering = computed(() => search.value.trim().length > 0 || filterClass.value !== '')

const studentsSorted = computed(() =>
  [...students.value].sort((a, b) => a.displayName?.localeCompare(b.displayName, 'uk') ?? 0),
)

const filtered = computed(() => {
  let list = [...students.value]
  if (filterClass.value) list = list.filter(s => s.classId === filterClass.value)
  if (search.value.trim()) {
    const q = search.value.toLowerCase()
    list = list.filter(s =>
      s.displayName?.toLowerCase().includes(q) ||
      s.accessCode?.toLowerCase().includes(q)
    )
  }
  const classById = (id) => classes.value.find(c => c.id === id)
  list.sort((a, b) => {
    const ca = classById(a.classId)
    const cb = classById(b.classId)
    const ga = ca ? (gradeFromName(ca.name) ?? 1000) : 1000
    const gb = cb ? (gradeFromName(cb.name) ?? 1000) : 1000
    if (ga !== gb) return ga - gb
    const na = ca?.name || ''
    const nb = cb?.name || ''
    if (na !== nb) return na.localeCompare(nb, 'uk')
    return a.displayName?.localeCompare(b.displayName, 'uk') ?? 0
  })
  return list
})

// Group by class when not filtering (класи 1 → 10, потім «Без класу»)
const grouped = computed(() => {
  if (isFiltering.value) return null
  const map = {}
  const noClass = []
  for (const s of filtered.value) {
    if (s.classId) {
      if (!map[s.classId]) map[s.classId] = []
      map[s.classId].push(s)
    } else {
      noClass.push(s)
    }
  }
  for (const cid of Object.keys(map)) {
    map[cid].sort((a, b) => a.displayName?.localeCompare(b.displayName, 'uk') ?? 0)
  }
  noClass.sort((a, b) => a.displayName?.localeCompare(b.displayName, 'uk') ?? 0)

  const withStudents = classes.value
    .filter(c => map[c.id]?.length)
    .sort(compareClassesByGrade)
  const result = withStudents.map(c => ({ id: c.id, name: c.name, students: map[c.id] }))
  if (noClass.length) result.push({ id: '__none', name: 'Без класу', students: noClass })
  return result
})

const classesByGrade = computed(() => [...classes.value].sort(compareClassesByGrade))

function openCreate() {
  form.value = { displayName: '', classId: classesByGrade.value[0]?.id || '' }
  showModal.value = true
}

function generateCode() {
  const adjs = ['SWIFT', 'BRAVE', 'SMART', 'COOL', 'EPIC', 'WILD', 'STAR', 'HERO', 'GOLD', 'IRON', 'BOLD', 'KEEN']
  return `${adjs[Math.floor(Math.random() * adjs.length)]}-${Math.floor(1000 + Math.random() * 9000)}`
}

async function createStudent() {
  if (!form.value.displayName.trim()) { error('Введіть ім\'я'); return }
  if (!authStore.currentCode) { error('Сесія не знайдена. Вийдіть і увійдіть знову.'); return }
  saving.value = true

  const adminEmail = authStore.user.email
  const adminCode  = authStore.currentCode

  try {
    const code  = generateCode()
    let email   = nameToEmail(form.value.displayName)

    let attempt = 0, created = null
    while (attempt < 10) {
      try {
        created = await createUserWithEmailAndPassword(fbAuth, email, code)
        break
      } catch (e) {
        if (e.code === 'auth/email-already-in-use') {
          attempt++
          email = nameToEmail(form.value.displayName).replace('@fus.ua', `${attempt}@fus.ua`)
        } else throw e
      }
    }

    await updateProfile(created.user, { displayName: form.value.displayName })
    const uid = created.user.uid
    await signInWithEmailAndPassword(fbAuth, adminEmail, adminCode)

    await setDoc(doc(db, 'users', uid), {
      displayName: form.value.displayName, email, role: 'student', accessCode: code,
      classId: form.value.classId || null, classIds: [],
      coins: 0, xp: 0, level: 1, streak: 0, lastLoginDate: null,
      avatar: { skinId: 'default', backgroundId: 'default', frameId: 'none', accessories: [] },
      inventory: [], inventoryCounts: {}, badges: [], createdAt: serverTimestamp(),
    })
    await createAccessCode(code, { email, uid, displayName: form.value.displayName, role: 'student', classId: form.value.classId || null })
    if (form.value.classId) await updateClass(form.value.classId, { studentIds: arrayUnion(uid) })

    showCode.value = { displayName: form.value.displayName, code, email }
    showModal.value = false
    success('Учня створено!')
    await fetchStudents()
  } catch (e) {
    error(e.message)
  } finally {
    saving.value = false
  }
}

async function deactivateStudent(student) {
  try {
    await updateUser(student.id, { isActive: false })
    const { updateDoc } = await import('firebase/firestore')
    await updateDoc(doc(db, 'accessCodes', student.accessCode), { isActive: false })
    success('Учня деактивовано')
    await fetchStudents()
  } catch (e) { error(e.message) }
}

async function deleteStudent(student) {
  deleting.value = true
  try {
    await deleteUserData(student.id, student.accessCode)
    students.value = students.value.filter(s => s.id !== student.id)
    confirmDeleteId.value = null
    success(`${student.displayName} видалено`)
  } catch (e) {
    error(e.message)
  } finally {
    deleting.value = false
  }
}

function className(classId) {
  return classes.value.find(c => c.id === classId)?.name || '—'
}

function copyCode(code) {
  navigator.clipboard?.writeText(code)
  info('Код скопійовано!')
}

function initials(name) {
  return (name || '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
}

// ─── Push учням ───────────────────────────────────────────────────────────────
const showPushModal = ref(false)
const pushTitle = ref('')
const pushBody = ref('')
const pushSelectedIds = ref([])
const pushing = ref(false)

function openPushModal() {
  pushTitle.value = ''
  pushBody.value = ''
  pushSelectedIds.value = students.value.map((s) => s.id)
  showPushModal.value = true
}

function togglePushStudent(id) {
  const set = new Set(pushSelectedIds.value)
  if (set.has(id)) set.delete(id)
  else set.add(id)
  pushSelectedIds.value = [...set]
}

function selectAllStudentsPush() {
  pushSelectedIds.value = students.value.map((s) => s.id)
}

function clearStudentsPush() {
  pushSelectedIds.value = []
}

async function sendStudentsPush() {
  const title = pushTitle.value.trim()
  const body = pushBody.value.trim()
  if (!title || !body) {
    error('Заповніть заголовок і текст повідомлення')
    return
  }
  if (!pushSelectedIds.value.length) {
    error('Оберіть хоча б одного учня')
    return
  }
  pushing.value = true
  try {
    const r = await adminBroadcastToStudents({
      title,
      body,
      studentUids: pushSelectedIds.value,
    })
    success(`Надіслано push: ${r.sent} з ${r.total ?? r.sent}`)
    showPushModal.value = false
  } catch (e) {
    error(e.message || String(e))
  } finally {
    pushing.value = false
  }
}

// ─── Edit student ─────────────────────────────────────────────────────────────
const showEditModal  = ref(false)
const editingStudent = ref(null)
const editForm       = ref({ displayName: '', classId: '' })
const savingEdit     = ref(false)
const rotatingCode   = ref(false)

function openEditStudent(s) {
  editingStudent.value = s
  editForm.value = {
    displayName: s.displayName || '',
    classId: s.classId || '',
  }
  showEditModal.value = true
}

async function saveEditStudent() {
  if (!editingStudent.value) return
  if (!editForm.value.displayName.trim()) {
    error('Введіть імʼя')
    return
  }
  savingEdit.value = true
  try {
    await adminUpdateStudentProfile(
      editingStudent.value.id,
      {
        displayName: editForm.value.displayName.trim(),
        classId: editForm.value.classId || null,
      },
      {
        previousClassId: editingStudent.value.classId || null,
        accessCode: editingStudent.value.accessCode,
      },
    )
    success('Дані учня оновлено')
    showEditModal.value = false
    editingStudent.value = null
    await fetchStudents()
  } catch (e) {
    error(e.message)
  } finally {
    savingEdit.value = false
  }
}

async function rotateStudentCode() {
  const s = editingStudent.value
  if (!s) return
  if (!s.email || !s.accessCode) {
    error('Немає email або поточного коду учня')
    return
  }
  if (!authStore.currentCode || !authStore.user?.email) {
    error('Сесія адміна не знайдена. Увійдіть заново.')
    return
  }

  const adminEmail = authStore.user.email
  const adminCode = authStore.currentCode
  let switchedToStudent = false
  rotatingCode.value = true

  try {
    // 1) Generate a unique-ish code; Firestore transaction still validates uniqueness.
    let nextCode = ''
    for (let i = 0; i < 6; i++) {
      const candidate = generateCode()
      if (candidate !== String(s.accessCode || '').toUpperCase()) {
        nextCode = candidate
        break
      }
    }
    if (!nextCode) throw new Error('Не вдалося згенерувати новий код')

    // 2) Rotate Firebase Auth password (email+password auth uses access code as password).
    await signInWithEmailAndPassword(fbAuth, s.email, String(s.accessCode).toUpperCase())
    switchedToStudent = true
    if (!fbAuth.currentUser) throw new Error('Не вдалося перемкнутися на акаунт учня')
    await updatePassword(fbAuth.currentUser, nextCode)

    // 3) Return to admin account before Firestore writes.
    await signInWithEmailAndPassword(fbAuth, adminEmail, adminCode)
    switchedToStudent = false

    // 4) Update Firestore profile and accessCodes docs.
    await adminRotateStudentAccessCode({
      studentId: s.id,
      oldCode: s.accessCode,
      newCode: nextCode,
      email: s.email,
      displayName: (editForm.value.displayName || s.displayName || '').trim(),
      classId: editForm.value.classId || s.classId || null,
    })

    showCode.value = {
      displayName: (editForm.value.displayName || s.displayName || '').trim(),
      email: s.email,
      code: nextCode,
      rotated: true,
    }
    // Keep in-modal state coherent before list refresh.
    editingStudent.value = { ...s, accessCode: nextCode }
    success('Код доступу учня змінено')
    await fetchStudents()
  } catch (e) {
    // Best-effort: always restore admin session if anything failed mid-switch.
    if (switchedToStudent) {
      try {
        await signInWithEmailAndPassword(fbAuth, adminEmail, adminCode)
      } catch {
        /* ignore */
      }
    }
    error(e?.message || String(e))
  } finally {
    rotatingCode.value = false
  }
}
</script>

<template>
  <div class="flex flex-col gap-4">

    <!-- Header -->
    <div class="flex items-center justify-between gap-3">
      <div>
        <div class="flex items-center gap-2">
          <Users :size="22" :stroke-width="2" class="text-accent" />
          <h1 class="text-2xl font-extrabold">Учні</h1>
        </div>
        <p class="text-slate-400 text-sm mt-1">{{ students.length }} учнів зареєстровано</p>
      </div>
      <div class="flex items-center gap-2">
        <AppButton variant="secondary" size="sm" class="!gap-1.5" @click="openPushModal">
          <Bell :size="14" :stroke-width="2" />
          Push
        </AppButton>
        <AppButton variant="primary" size="sm" @click="openCreate">+ Новий учень</AppButton>
      </div>
    </div>

    <!-- Search + class filter -->
    <div class="flex gap-2">
      <div class="relative flex-1">
        <Search :size="15" :stroke-width="2" class="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
        <input
          v-model="search"
          placeholder="Пошук за іменем або кодом..."
          class="w-full bg-game-card border border-white/[0.07] rounded-xl pl-9 pr-9 py-2.5 text-sm text-slate-200 placeholder-slate-500 outline-none focus:border-white/20 transition-colors"
        />
        <button v-if="search" class="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300" @click="search = ''">
          <X :size="14" :stroke-width="2" />
        </button>
      </div>
      <select
        v-model="filterClass"
        class="bg-game-card border border-white/[0.07] rounded-xl px-3 py-2.5 text-sm text-slate-300 outline-none focus:border-white/20 transition-colors"
      >
        <option value="">Всі класи</option>
        <option v-for="c in classesByGrade" :key="c.id" :value="c.id">
          {{ schoolTierEmojiForClassName(c.name) }} {{ c.name }}
        </option>
      </select>
    </div>

    <!-- Empty state -->
    <div v-if="students.length === 0" class="text-center py-16 text-slate-500">
      <Users :size="48" :stroke-width="1" class="mx-auto mb-3 opacity-20" />
      <div class="font-bold">Учнів ще немає</div>
    </div>

    <!-- No results -->
    <div v-else-if="filtered.length === 0" class="text-center py-10 text-slate-500 text-sm">
      Нікого не знайдено
    </div>

    <!-- Flat filtered list -->
    <div v-else-if="isFiltering" class="flex flex-col gap-1">
      <div
        v-for="s in filtered" :key="s.id"
        class="flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-white/[0.04] transition-colors group"
      >
        <div
          class="w-7 h-7 rounded-full overflow-hidden flex-shrink-0 ring-1 ring-white/10 flex items-center justify-center text-xs font-extrabold"
          :class="s.isActive === false ? 'bg-white/[0.05] text-slate-600' : 'bg-accent/20 text-accent'"
        >
          <img
            v-if="s.avatar?.photoUrl"
            :src="s.avatar.photoUrl"
            alt=""
            class="w-full h-full object-cover"
          />
          <span v-else>{{ initials(s.displayName) }}</span>
        </div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-1.5">
            <span class="text-sm font-semibold text-slate-200 truncate">{{ s.displayName }}</span>
            <span v-if="s.isActive === false" class="text-[9px] bg-red-500/20 text-red-400 px-1.5 py-0.5 rounded font-bold flex-shrink-0">деакт.</span>
          </div>
          <div class="flex items-center gap-2 text-xs text-slate-500">
            <span>{{ className(s.classId) }}</span>
            <span>·</span>
            <span>Lv.{{ s.level }}</span>
            <span>·</span>
            <button class="flex items-center gap-0.5 font-mono hover:text-slate-300 transition-colors" @click.stop="copyCode(s.accessCode)">
              {{ s.accessCode }}<Copy :size="9" :stroke-width="2" class="opacity-0 group-hover:opacity-100 transition-opacity ml-0.5" />
            </button>
          </div>
        </div>
        <div class="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
          <template v-if="confirmDeleteId !== s.id">
            <button
              class="p-1.5 rounded-lg text-slate-500 hover:text-sky-400 hover:bg-sky-500/10 transition-colors"
              title="Редагувати ім'я та клас"
              @click.stop="openEditStudent(s)"
            ><Pencil :size="13" :stroke-width="2" /></button>
            <button
              v-if="s.isActive !== false"
              class="p-1.5 rounded-lg text-slate-500 hover:text-amber-400 hover:bg-amber-500/10 transition-colors"
              title="Деактивувати" @click.stop="deactivateStudent(s)"
            ><UserX :size="13" :stroke-width="2" /></button>
            <button
              class="p-1.5 rounded-lg text-slate-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
              title="Видалити" @click.stop="confirmDeleteId = s.id"
            ><Trash2 :size="13" :stroke-width="2" /></button>
          </template>
          <template v-else>
            <span class="text-xs text-red-400 font-bold mr-1">Видалити?</span>
            <button class="text-xs px-2 py-1 rounded-lg bg-red-500/20 text-red-400 hover:bg-red-500/30 font-bold disabled:opacity-50" :disabled="deleting" @click.stop="deleteStudent(s)">{{ deleting ? '...' : 'Так' }}</button>
            <button class="text-xs px-2 py-1 rounded-lg bg-white/[0.06] text-slate-400 hover:bg-white/[0.10] font-bold" @click.stop="confirmDeleteId = null">Ні</button>
          </template>
        </div>
      </div>
    </div>

    <!-- Grouped by class -->
    <div v-else class="flex flex-col gap-5">
      <div v-for="group in grouped" :key="group.id">
        <div class="flex items-center gap-2 mb-2 px-1">
          <span class="text-base leading-none" :title="group.name">{{ schoolTierEmojiForClassName(group.name) }}</span>
          <span class="text-sm font-extrabold text-slate-300 uppercase tracking-wide">{{ group.name }}</span>
          <span class="text-xs text-slate-600 font-bold">{{ group.students.length }}</span>
          <div class="flex-1 h-px bg-white/[0.06] ml-1" />
        </div>
        <div class="flex flex-col gap-1">
          <div
            v-for="s in group.students" :key="s.id"
            class="flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-white/[0.04] transition-colors group"
          >
            <!-- Avatar bubble -->
            <div
              class="w-7 h-7 rounded-full overflow-hidden flex-shrink-0 ring-1 ring-white/10 flex items-center justify-center text-xs font-extrabold"
              :class="s.isActive === false ? 'bg-white/[0.05] text-slate-600' : 'bg-accent/20 text-accent'"
            >
              <img
                v-if="s.avatar?.photoUrl"
                :src="s.avatar.photoUrl"
                alt=""
                class="w-full h-full object-cover"
              />
              <span v-else>{{ initials(s.displayName) }}</span>
            </div>

            <!-- Info -->
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-1.5">
                <span class="text-sm font-semibold text-slate-200 truncate">{{ s.displayName }}</span>
                <span v-if="s.isActive === false" class="text-[9px] bg-red-500/20 text-red-400 px-1.5 py-0.5 rounded font-bold flex-shrink-0">деакт.</span>
              </div>
              <div class="flex items-center gap-2 text-xs text-slate-500">
                <span>Lv.{{ s.level }}</span>
                <span>·</span>
                <span>{{ s.coins }} монет</span>
                <span>·</span>
                <button class="flex items-center gap-0.5 font-mono hover:text-slate-300 transition-colors" @click.stop="copyCode(s.accessCode)">
                  {{ s.accessCode }}
                  <Copy :size="9" :stroke-width="2" class="opacity-0 group-hover:opacity-100 transition-opacity" />
                </button>
              </div>
            </div>

            <!-- Actions (appear on hover) -->
            <div class="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
              <template v-if="confirmDeleteId !== s.id">
                <button
                  class="p-1.5 rounded-lg text-slate-500 hover:text-sky-400 hover:bg-sky-500/10 transition-colors"
                  title="Редагувати ім'я та клас"
                  @click.stop="openEditStudent(s)"
                >
                  <Pencil :size="13" :stroke-width="2" />
                </button>
                <button
                  v-if="s.isActive !== false"
                  class="p-1.5 rounded-lg text-slate-500 hover:text-amber-400 hover:bg-amber-500/10 transition-colors"
                  title="Деактивувати"
                  @click.stop="deactivateStudent(s)"
                >
                  <UserX :size="13" :stroke-width="2" />
                </button>
                <button
                  class="p-1.5 rounded-lg text-slate-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                  title="Видалити назавжди"
                  @click.stop="confirmDeleteId = s.id"
                >
                  <Trash2 :size="13" :stroke-width="2" />
                </button>
              </template>
              <template v-else>
                <span class="text-xs text-red-400 font-bold mr-1">Видалити?</span>
                <button
                  class="text-xs px-2 py-1 rounded-lg bg-red-500/20 text-red-400 hover:bg-red-500/30 font-bold transition-colors disabled:opacity-50"
                  :disabled="deleting" @click.stop="deleteStudent(s)"
                >{{ deleting ? '...' : 'Так' }}</button>
                <button
                  class="text-xs px-2 py-1 rounded-lg bg-white/[0.06] text-slate-400 hover:bg-white/[0.10] font-bold transition-colors"
                  @click.stop="confirmDeleteId = null"
                >Ні</button>
              </template>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Push учням -->
    <AppModal v-model="showPushModal" title="Push учням">
      <div class="flex flex-col gap-4">
        <p class="text-xs text-slate-500">
          Учні мають увійти в застосунок і дозволити сповіщення. Можна обрати конкретних або всіх.
        </p>
        <AppInput v-model="pushTitle" label="Заголовок" placeholder="напр. Оголошення" />
        <div>
          <label class="text-sm font-bold text-slate-300 block mb-1.5">Текст</label>
          <textarea
            v-model="pushBody"
            rows="3"
            class="w-full bg-game-bg border border-white/[0.07] rounded-xl px-4 py-3 text-sm text-slate-200 placeholder-slate-500 outline-none focus:border-white/20 resize-y min-h-[5rem]"
            placeholder="Короткий текст повідомлення…"
          />
        </div>
        <div class="flex gap-2">
          <AppButton variant="ghost" size="sm" @click="selectAllStudentsPush">Усі</AppButton>
          <AppButton variant="ghost" size="sm" @click="clearStudentsPush">Зняти все</AppButton>
        </div>
        <div class="max-h-48 overflow-y-auto flex flex-col gap-1 rounded-xl border border-white/[0.06] p-2">
          <label
            v-for="s in studentsSorted" :key="s.id"
            class="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-white/[0.04] cursor-pointer text-sm"
          >
            <input
              type="checkbox"
              class="accent-violet-500 w-4 h-4 flex-shrink-0"
              :checked="pushSelectedIds.includes(s.id)"
              @change="togglePushStudent(s.id)"
            />
            <span class="truncate text-slate-300">{{ s.displayName }}</span>
          </label>
        </div>
        <AppButton variant="primary" block :loading="pushing" @click="sendStudentsPush">Надіслати</AppButton>
      </div>
    </AppModal>

    <!-- Edit student -->
    <AppModal v-model="showEditModal" title="Редагувати учня">
      <div v-if="editingStudent" class="flex flex-col gap-4">
        <AppInput v-model="editForm.displayName" label="Повне ім'я" placeholder="напр. Петренко Іван" />
        <div>
          <label class="text-sm font-bold text-slate-300 block mb-1.5">Клас</label>
          <select
            v-model="editForm.classId"
            class="w-full bg-game-bg border border-white/[0.07] rounded-xl px-4 py-3 text-white font-semibold focus:outline-none"
          >
            <option value="">Без класу</option>
            <option v-for="c in classesByGrade" :key="c.id" :value="c.id">
              {{ schoolTierEmojiForClassName(c.name) }} {{ c.name }}
            </option>
          </select>
        </div>
        <p class="text-xs text-slate-500">
          Якщо код злитий, його можна змінити без втрати профілю: прогрес, монети, інвентар та статистика збережуться.
        </p>
        <div class="rounded-xl p-3 bg-white/[0.04] border border-white/[0.06]">
          <div class="flex items-center justify-between gap-2">
            <div class="min-w-0">
              <div class="text-[11px] text-slate-500 font-bold uppercase tracking-wide">Поточний код</div>
              <div class="font-mono font-extrabold text-slate-200 truncate">{{ editingStudent.accessCode }}</div>
            </div>
            <AppButton
              variant="secondary"
              size="sm"
              class="!whitespace-nowrap"
              :loading="rotatingCode"
              @click="rotateStudentCode"
            >
              Змінити код
            </AppButton>
          </div>
        </div>
        <AppButton variant="primary" block :loading="savingEdit" @click="saveEditStudent">Зберегти</AppButton>
      </div>
    </AppModal>

    <!-- Create modal -->
    <AppModal v-model="showModal" title="Новий учень">
      <div class="flex flex-col gap-4">
        <AppInput v-model="form.displayName" label="Повне ім'я" placeholder="напр. Петренко Іван" />
        <div>
          <label class="text-sm font-bold text-slate-300 block mb-1.5">Клас</label>
          <select
            v-model="form.classId"
            class="w-full bg-game-bg border border-white/[0.07] rounded-xl px-4 py-3 text-white font-semibold focus:outline-none"
          >
            <option value="">Без класу</option>
            <option v-for="c in classesByGrade" :key="c.id" :value="c.id">
              {{ schoolTierEmojiForClassName(c.name) }} {{ c.name }}
            </option>
          </select>
        </div>
        <div class="rounded-xl p-3 text-xs text-slate-400" style="background:rgba(255,255,255,0.04)">
          Буде згенеровано унікальний код доступу. Учень вводить його на екрані входу — без email або пароля.
        </div>
        <AppButton variant="primary" block :loading="saving" @click="createStudent">Створити учня</AppButton>
      </div>
    </AppModal>

    <!-- Code reveal modal -->
    <AppModal :modelValue="!!showCode" :title="showCode?.rotated ? 'Код оновлено!' : 'Учня створено!'" @update:modelValue="v => { if (!v) showCode = null }">
      <div v-if="showCode" class="flex flex-col items-center gap-4 text-center">
        <div>
          <div class="font-bold text-lg">{{ showCode.displayName }}</div>
          <div class="text-slate-400 text-sm">
            {{ showCode.rotated ? 'отримав новий код доступу' : 'готовий приєднатися до FUSAPP' }}
          </div>
        </div>
        <div class="bg-game-bg rounded-xl p-4 w-full">
          <div class="text-xs text-slate-400 mb-2 font-semibold">КОД ДОСТУПУ</div>
          <div class="text-3xl font-extrabold text-accent tracking-widest">{{ showCode.code }}</div>
          <button class="text-xs text-slate-500 mt-2 hover:text-slate-300 flex items-center gap-1 mx-auto" @click="copyCode(showCode.code)">
            <Copy :size="12" :stroke-width="2" /> Скопіювати код
          </button>
        </div>
        <div class="text-xs text-slate-400">
          Передайте цей код учню. Він вводить його на екрані входу замість старого.
        </div>
        <AppButton variant="primary" block @click="showCode = null">Готово</AppButton>
      </div>
    </AppModal>
  </div>
</template>
