<script setup>
import { ref, onMounted, computed } from 'vue'
import {
  getAllStudents, getAllClasses, createAccessCode,
  updateUser, updateClass, deleteUserData, adminUpdateStudentProfile,
} from '@/firebase/collections'
import { createUserWithEmailAndPassword, updateProfile, signInWithEmailAndPassword } from 'firebase/auth'
import { auth as fbAuth, db } from '@/firebase/config'
import { setDoc, doc, serverTimestamp, arrayUnion } from 'firebase/firestore'
import { useAuthStore } from '@/stores/auth'
import { nameToEmail } from '@/composables/useNameToEmail'
import AppButton from '@/components/ui/AppButton.vue'
import AppModal from '@/components/ui/AppModal.vue'
import AppInput from '@/components/ui/AppInput.vue'
import { useToast } from '@/composables/useToast'
import { Trash2, UserX, Copy, Users, Search, X, Pencil } from 'lucide-vue-next'

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

/** Паралель з назви класу (на початку цифра): «1-А» → 1, «10-Б» → 10; без цифри — в кінець списку */
function gradeFromClassName(name) {
  const m = String(name || '').trim().match(/^(\d+)/)
  return m ? parseInt(m[1], 10) : 1000
}

function compareClassesByGrade(a, b) {
  const ga = gradeFromClassName(a.name)
  const gb = gradeFromClassName(b.name)
  if (ga !== gb) return ga - gb
  return String(a.name).localeCompare(String(b.name), 'uk')
}

const isFiltering = computed(() => search.value.trim().length > 0 || filterClass.value !== '')

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
    const ga = ca ? gradeFromClassName(ca.name) : 1000
    const gb = cb ? gradeFromClassName(cb.name) : 1000
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

// ─── Edit student ─────────────────────────────────────────────────────────────
const showEditModal  = ref(false)
const editingStudent = ref(null)
const editForm       = ref({ displayName: '', classId: '' })
const savingEdit     = ref(false)

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
      <AppButton variant="primary" size="sm" @click="openCreate">+ Новий учень</AppButton>
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
        <option v-for="c in classesByGrade" :key="c.id" :value="c.id">{{ c.name }}</option>
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
          class="w-7 h-7 rounded-full flex items-center justify-center text-xs font-extrabold flex-shrink-0"
          :class="s.isActive === false ? 'bg-white/[0.05] text-slate-600' : 'bg-accent/20 text-accent'"
        >{{ initials(s.displayName) }}</div>
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
              class="w-7 h-7 rounded-full flex items-center justify-center text-xs font-extrabold flex-shrink-0"
              :class="s.isActive === false ? 'bg-white/[0.05] text-slate-600' : 'bg-accent/20 text-accent'"
            >{{ initials(s.displayName) }}</div>

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

    <!-- Edit student -->
    <AppModal v-model="showEditModal" title="Редагувати учня">
      <div v-if="editingStudent" class="flex flex-col gap-4">
        <AppInput v-model="editForm.displayName" label="Повне ім'я" placeholder="напр. Іван Петренко" />
        <div>
          <label class="text-sm font-bold text-slate-300 block mb-1.5">Клас</label>
          <select
            v-model="editForm.classId"
            class="w-full bg-game-bg border border-white/[0.07] rounded-xl px-4 py-3 text-white font-semibold focus:outline-none"
          >
            <option value="">Без класу</option>
            <option v-for="c in classesByGrade" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
        </div>
        <p class="text-xs text-slate-500">
          Код доступу для входу не змінюється. Поле email у профілі лишається як при реєстрації (вхід працює як раніше).
        </p>
        <AppButton variant="primary" block :loading="savingEdit" @click="saveEditStudent">Зберегти</AppButton>
      </div>
    </AppModal>

    <!-- Create modal -->
    <AppModal v-model="showModal" title="Новий учень">
      <div class="flex flex-col gap-4">
        <AppInput v-model="form.displayName" label="Повне ім'я" placeholder="напр. Іван Петренко" />
        <div>
          <label class="text-sm font-bold text-slate-300 block mb-1.5">Клас</label>
          <select
            v-model="form.classId"
            class="w-full bg-game-bg border border-white/[0.07] rounded-xl px-4 py-3 text-white font-semibold focus:outline-none"
          >
            <option value="">Без класу</option>
            <option v-for="c in classesByGrade" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
        </div>
        <div class="rounded-xl p-3 text-xs text-slate-400" style="background:rgba(255,255,255,0.04)">
          Буде згенеровано унікальний код доступу. Учень вводить його на екрані входу — без email або пароля.
        </div>
        <AppButton variant="primary" block :loading="saving" @click="createStudent">Створити учня</AppButton>
      </div>
    </AppModal>

    <!-- Code reveal modal -->
    <AppModal :modelValue="!!showCode" title="Учня створено!" @update:modelValue="v => { if (!v) showCode = null }">
      <div v-if="showCode" class="flex flex-col items-center gap-4 text-center">
        <div>
          <div class="font-bold text-lg">{{ showCode.displayName }}</div>
          <div class="text-slate-400 text-sm">готовий приєднатися до FUSAPP</div>
        </div>
        <div class="bg-game-bg rounded-xl p-4 w-full">
          <div class="text-xs text-slate-400 mb-2 font-semibold">КОД ДОСТУПУ</div>
          <div class="text-3xl font-extrabold text-accent tracking-widest">{{ showCode.code }}</div>
          <button class="text-xs text-slate-500 mt-2 hover:text-slate-300 flex items-center gap-1 mx-auto" @click="copyCode(showCode.code)">
            <Copy :size="12" :stroke-width="2" /> Скопіювати код
          </button>
        </div>
        <div class="text-xs text-slate-400">Передайте цей код учню. Він вводить його на екрані входу.</div>
        <AppButton variant="primary" block @click="showCode = null">Готово</AppButton>
      </div>
    </AppModal>
  </div>
</template>
