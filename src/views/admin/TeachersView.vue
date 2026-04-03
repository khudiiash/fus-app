<script setup>
import { ref, onMounted, computed } from 'vue'
import { getAllTeachers, getAllClasses, getAllSubjects, createAccessCode, updateClass, setTeacherWeeklyBudget, DEFAULT_WEEKLY_BUDGET, deleteUserData, adminUpdateTeacherAssignments } from '@/firebase/collections'
import { createUserWithEmailAndPassword, updateProfile, signInWithEmailAndPassword } from 'firebase/auth'
import { auth as fbAuth } from '@/firebase/config'
import { setDoc, doc, serverTimestamp, arrayUnion } from 'firebase/firestore'
import { db } from '@/firebase/config'
import { useAuthStore } from '@/stores/auth'
import AppButton from '@/components/ui/AppButton.vue'
import AppModal from '@/components/ui/AppModal.vue'
import AppInput from '@/components/ui/AppInput.vue'
import SubjectIcon from '@/components/ui/SubjectIcon.vue'
import { useToast } from '@/composables/useToast'
import { nameToEmail } from '@/composables/useNameToEmail'
import { getSubjectIcon } from '@/composables/useSubjectIcon'
import { Trash2, Copy, GraduationCap, Pencil, Search, X, Coins } from 'lucide-vue-next'

const authStore = useAuthStore()
const { success, error, info } = useToast()

const teachers  = ref([])
const classes   = ref([])
const subjects  = ref([])
const showModal = ref(false)
const showCode  = ref(null)
const saving    = ref(false)
const search    = ref('')

const form = ref({ displayName: '', classIds: [], subjectIds: [] })

onMounted(async () => {
  const [t, c, s] = await Promise.all([getAllTeachers(), getAllClasses(), getAllSubjects()])
  teachers.value = t
  classes.value  = c
  subjects.value = s
})

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  const list = [...teachers.value].sort((a, b) =>
    a.displayName?.localeCompare(b.displayName, 'uk') ?? 0
  )
  if (!q) return list
  return list.filter(t =>
    t.displayName?.toLowerCase().includes(q) ||
    t.accessCode?.toLowerCase().includes(q)
  )
})

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

const classesByGrade = computed(() => [...classes.value].sort(compareClassesByGrade))

function generateCode() {
  const adjs = ['TEACH', 'PROF', 'GUIDE', 'TUTOR', 'COACH', 'MENTOR']
  return `${adjs[Math.floor(Math.random() * adjs.length)]}-${Math.floor(1000 + Math.random() * 9000)}`
}

async function createTeacher() {
  if (!form.value.displayName.trim()) { error('Введіть ім\'я'); return }
  if (!authStore.currentCode) { error('Сесія не знайдена. Вийдіть і увійдіть знову.'); return }
  saving.value = true

  const adminEmail = authStore.user.email
  const adminCode  = authStore.currentCode

  try {
    const code = generateCode()
    let email  = nameToEmail(form.value.displayName)

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
      displayName: form.value.displayName, email, role: 'teacher', accessCode: code,
      classIds: form.value.classIds, subjectIds: form.value.subjectIds,
      classId: null, coins: 0, xp: 0, level: 1, streak: 0, lastLoginDate: null,
      avatar: { skinId: 'default', backgroundId: 'default', frameId: 'none', accessories: [] },
      inventory: [], inventoryCounts: {}, badges: [], createdAt: serverTimestamp(),
    })
    await createAccessCode(code, { email, uid, displayName: form.value.displayName, role: 'teacher', classId: null })
    for (const cid of form.value.classIds) await updateClass(cid, { teacherIds: arrayUnion(uid) })

    showCode.value  = { displayName: form.value.displayName, code }
    showModal.value = false
    success('Вчителя створено!')
    teachers.value  = await getAllTeachers()
  } catch (e) {
    error(e.message)
  } finally {
    saving.value = false
  }
}

function toggleClass(id) {
  const idx = form.value.classIds.indexOf(id)
  if (idx >= 0) { form.value.classIds.splice(idx, 1) } else { form.value.classIds.push(id) }
}
function toggleSubject(id) {
  const idx = form.value.subjectIds.indexOf(id)
  if (idx >= 0) { form.value.subjectIds.splice(idx, 1) } else { form.value.subjectIds.push(id) }
}

function classNames(ids) {
  return (ids || []).map(id => classes.value.find(c => c.id === id)?.name || '').filter(Boolean).join(', ') || '—'
}

function subjectIconsFor(ids) {
  return (ids || []).map(id => {
    const s = subjects.value.find(s => s.id === id)
    return s ? (s.icon || getSubjectIcon(s.name)) : null
  }).filter(Boolean)
}

function copyCode(code) {
  navigator.clipboard?.writeText(code)
  info('Скопійовано!')
}

function openModal() {
  form.value = { displayName: '', classIds: [], subjectIds: [] }
  showModal.value = true
}

function initials(name) {
  return (name || '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
}

// ─── Delete ───────────────────────────────────────────────────────────────────
const confirmDeleteId = ref(null)
const deleting        = ref(false)

async function deleteTeacher(teacher) {
  deleting.value = true
  try {
    await deleteUserData(teacher.id, teacher.accessCode)
    teachers.value = teachers.value.filter(t => t.id !== teacher.id)
    confirmDeleteId.value = null
    success(`${teacher.displayName} видалено`)
  } catch (e) {
    error(e.message)
  } finally {
    deleting.value = false
  }
}

// ─── Budget edit ──────────────────────────────────────────────────────────────
const showBudget     = ref(false)
const budgetTeacher  = ref(null)
const budgetAmount   = ref(DEFAULT_WEEKLY_BUDGET)
const savingBudget   = ref(false)

function openBudget(teacher) {
  budgetTeacher.value = teacher
  budgetAmount.value  = teacher.coinsBudgetWeekly ?? DEFAULT_WEEKLY_BUDGET
  showBudget.value    = true
}

async function saveBudget() {
  if (!budgetAmount.value || budgetAmount.value < 0) { error('Введіть коректне значення'); return }
  savingBudget.value = true
  try {
    await setTeacherWeeklyBudget(budgetTeacher.value.id, budgetAmount.value)
    success(`Бюджет оновлено: ${budgetAmount.value} монет/тиждень`)
    showBudget.value = false
    teachers.value   = await getAllTeachers()
  } catch (e) {
    error(e.message)
  } finally {
    savingBudget.value = false
  }
}

// ─── Edit subjects / classes ────────────────────────────────────────────────────
const showEditModal   = ref(false)
const editingTeacher  = ref(null)
const editForm        = ref({ subjectIds: [], classIds: [] })
const savingEdit      = ref(false)

function openEditTeacher(t) {
  editingTeacher.value = t
  editForm.value = {
    subjectIds: [...(t.subjectIds || [])],
    classIds: [...(t.classIds || [])],
  }
  showEditModal.value = true
}

function toggleEditClass(id) {
  const idx = editForm.value.classIds.indexOf(id)
  if (idx >= 0) editForm.value.classIds.splice(idx, 1)
  else editForm.value.classIds.push(id)
}

function toggleEditSubject(id) {
  const idx = editForm.value.subjectIds.indexOf(id)
  if (idx >= 0) editForm.value.subjectIds.splice(idx, 1)
  else editForm.value.subjectIds.push(id)
}

async function saveEditTeacher() {
  if (!editingTeacher.value) return
  savingEdit.value = true
  try {
    await adminUpdateTeacherAssignments(
      editingTeacher.value.id,
      {
        subjectIds: editForm.value.subjectIds,
        classIds: editForm.value.classIds,
      },
      editingTeacher.value.classIds,
    )
    success('Зміни збережено')
    showEditModal.value = false
    editingTeacher.value = null
    teachers.value = await getAllTeachers()
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
          <GraduationCap :size="22" :stroke-width="2" class="text-accent" />
          <h1 class="text-2xl font-extrabold">Вчителі</h1>
        </div>
        <p class="text-slate-400 text-sm mt-1">{{ teachers.length }} вчителів</p>
      </div>
      <AppButton variant="primary" size="sm" @click="openModal">+ Новий вчитель</AppButton>
    </div>

    <!-- Search -->
    <div class="relative">
      <Search :size="15" :stroke-width="2" class="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
      <input
        v-model="search"
        placeholder="Пошук вчителя..."
        class="w-full bg-game-card border border-white/[0.07] rounded-xl pl-9 pr-9 py-2.5 text-sm text-slate-200 placeholder-slate-500 outline-none focus:border-white/20 transition-colors"
      />
      <button v-if="search" class="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300" @click="search = ''">
        <X :size="14" :stroke-width="2" />
      </button>
    </div>

    <!-- Empty state -->
    <div v-if="teachers.length === 0" class="text-center py-16 text-slate-500">
      <GraduationCap :size="48" :stroke-width="1" class="mx-auto mb-3 opacity-20" />
      <div class="font-bold">Вчителів ще немає</div>
    </div>

    <!-- No results -->
    <div v-else-if="filtered.length === 0" class="text-center py-10 text-slate-500 text-sm">
      Нікого не знайдено
    </div>

    <!-- List -->
    <div v-else class="flex flex-col gap-1">
      <div
        v-for="t in filtered" :key="t.id"
        class="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-white/[0.04] transition-colors group"
      >
        <!-- Avatar -->
        <div class="w-8 h-8 rounded-full bg-accent/15 flex items-center justify-center text-xs font-extrabold flex-shrink-0 text-accent">
          {{ initials(t.displayName) }}
        </div>

        <!-- Info -->
        <div class="flex-1 min-w-0">
          <div class="text-sm font-semibold text-slate-200 truncate">{{ t.displayName }}</div>
          <div class="flex items-center gap-2 mt-0.5 flex-wrap">
            <!-- Subject icons -->
            <div class="flex items-center gap-0.5">
              <SubjectIcon
                v-for="icon in subjectIconsFor(t.subjectIds)"
                :key="icon"
                :icon="icon"
                size="0.8rem"
              />
              <span v-if="!t.subjectIds?.length" class="text-xs text-slate-600">—</span>
            </div>
            <span class="text-slate-700 text-xs">·</span>
            <span class="text-xs text-slate-500 truncate">{{ classNames(t.classIds) }}</span>
            <span class="text-slate-700 text-xs">·</span>
            <button
              class="flex items-center gap-0.5 font-mono text-xs text-slate-500 hover:text-slate-300 transition-colors"
              @click.stop="copyCode(t.accessCode)"
            >
              {{ t.accessCode }}
              <Copy :size="9" :stroke-width="2" class="opacity-0 group-hover:opacity-100 transition-opacity ml-0.5" />
            </button>
            <span class="text-slate-700 text-xs">·</span>
            <span class="text-xs text-amber-400 font-bold">{{ t.coinsBudgetWeekly ?? DEFAULT_WEEKLY_BUDGET }} м/тиж</span>
          </div>
        </div>

        <!-- Actions -->
        <div class="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
          <template v-if="confirmDeleteId !== t.id">
            <button
              class="p-1.5 rounded-lg text-slate-500 hover:text-sky-400 hover:bg-sky-500/10 transition-colors"
              title="Предмети та класи"
              @click.stop="openEditTeacher(t)"
            >
              <Pencil :size="13" :stroke-width="2" />
            </button>
            <button
              class="p-1.5 rounded-lg text-slate-500 hover:text-accent hover:bg-accent/10 transition-colors"
              title="Редагувати бюджет"
              @click.stop="openBudget(t)"
            >
              <Coins :size="13" :stroke-width="2" />
            </button>
            <button
              class="p-1.5 rounded-lg text-slate-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
              title="Видалити назавжди"
              @click.stop="confirmDeleteId = t.id"
            >
              <Trash2 :size="13" :stroke-width="2" />
            </button>
          </template>
          <template v-else>
            <span class="text-xs text-red-400 font-bold mr-1">Видалити?</span>
            <button
              class="text-xs px-2 py-1 rounded-lg bg-red-500/20 text-red-400 hover:bg-red-500/30 font-bold disabled:opacity-50"
              :disabled="deleting" @click.stop="deleteTeacher(t)"
            >{{ deleting ? '...' : 'Так' }}</button>
            <button
              class="text-xs px-2 py-1 rounded-lg bg-white/[0.06] text-slate-400 hover:bg-white/[0.10] font-bold"
              @click.stop="confirmDeleteId = null"
            >Ні</button>
          </template>
        </div>
      </div>
    </div>

    <!-- Create modal -->
    <AppModal v-model="showModal" title="Новий вчитель">
      <div class="flex flex-col gap-4">
        <AppInput v-model="form.displayName" label="Повне ім'я" placeholder="напр. Коваль Олена" />

        <div>
          <label class="text-sm font-bold text-slate-300 block mb-2">Предмети</label>
          <div v-if="subjects.length === 0" class="text-xs text-slate-500 py-2">
            Спочатку додайте предмети у розділі «Предмети»
          </div>
          <div v-else class="flex flex-col gap-1 max-h-48 overflow-y-auto">
            <label
              v-for="s in subjects" :key="s.id"
              class="flex items-center gap-3 px-3 py-2 rounded-xl cursor-pointer hover:bg-white/[0.04] transition-colors"
            >
              <input type="checkbox" :checked="form.subjectIds.includes(s.id)" @change="toggleSubject(s.id)" class="accent-violet-500 w-4 h-4 flex-shrink-0" />
              <SubjectIcon :icon="s.icon || getSubjectIcon(s.name)" size="1em" />
              <span class="text-sm font-semibold">{{ s.name }}</span>
            </label>
          </div>
        </div>

        <div>
          <label class="text-sm font-bold text-slate-300 block mb-2">Класи</label>
          <div v-if="classes.length === 0" class="text-xs text-slate-500 py-2">
            Спочатку додайте класи у розділі «Класи»
          </div>
          <div v-else class="flex flex-col gap-1">
            <label
              v-for="c in classesByGrade" :key="c.id"
              class="flex items-center gap-3 px-3 py-2 rounded-xl cursor-pointer hover:bg-white/[0.04] transition-colors"
            >
              <input type="checkbox" :checked="form.classIds.includes(c.id)" @change="toggleClass(c.id)" class="accent-violet-500 w-4 h-4 flex-shrink-0" />
              <span class="text-sm font-semibold">{{ c.icon || '🏫' }} {{ c.name }}</span>
            </label>
          </div>
        </div>

        <AppButton variant="primary" block :loading="saving" @click="createTeacher">Створити вчителя</AppButton>
      </div>
    </AppModal>

    <!-- Edit teacher: subjects + classes -->
    <AppModal v-model="showEditModal" title="Предмети та класи">
      <div v-if="editingTeacher" class="flex flex-col gap-4">
        <div class="text-sm text-slate-400">
          Вчитель: <span class="font-bold text-white">{{ editingTeacher.displayName }}</span>
        </div>

        <div>
          <label class="text-sm font-bold text-slate-300 block mb-2">Предмети</label>
          <div v-if="subjects.length === 0" class="text-xs text-slate-500 py-2">
            Спочатку додайте предмети у розділі «Предмети»
          </div>
          <div v-else class="flex flex-col gap-1 max-h-48 overflow-y-auto">
            <label
              v-for="s in subjects" :key="s.id"
              class="flex items-center gap-3 px-3 py-2 rounded-xl cursor-pointer hover:bg-white/[0.04] transition-colors"
            >
              <input
                type="checkbox"
                :checked="editForm.subjectIds.includes(s.id)"
                class="accent-violet-500 w-4 h-4 flex-shrink-0"
                @change="toggleEditSubject(s.id)"
              />
              <SubjectIcon :icon="s.icon || getSubjectIcon(s.name)" size="1em" />
              <span class="text-sm font-semibold">{{ s.name }}</span>
            </label>
          </div>
        </div>

        <div>
          <label class="text-sm font-bold text-slate-300 block mb-2">Класи</label>
          <div v-if="classes.length === 0" class="text-xs text-slate-500 py-2">
            Спочатку додайте класи у розділі «Класи»
          </div>
          <div v-else class="flex flex-col gap-1 max-h-40 overflow-y-auto">
            <label
              v-for="c in classesByGrade" :key="c.id"
              class="flex items-center gap-3 px-3 py-2 rounded-xl cursor-pointer hover:bg-white/[0.04] transition-colors"
            >
              <input
                type="checkbox"
                :checked="editForm.classIds.includes(c.id)"
                class="accent-violet-500 w-4 h-4 flex-shrink-0"
                @change="toggleEditClass(c.id)"
              />
              <span class="text-sm font-semibold">{{ c.icon || '🏫' }} {{ c.name }}</span>
            </label>
          </div>
        </div>

        <AppButton variant="primary" block :loading="savingEdit" @click="saveEditTeacher">Зберегти</AppButton>
      </div>
    </AppModal>

    <!-- Budget edit modal -->
    <AppModal v-model="showBudget" title="Тижневий бюджет">
      <div class="flex flex-col gap-4">
        <div class="text-sm text-slate-400">
          Вчитель: <span class="font-bold text-white">{{ budgetTeacher?.displayName }}</span>
        </div>
        <div>
          <label class="text-sm font-bold text-slate-300 block mb-2">Монет на тиждень</label>
          <input
            v-model="budgetAmount" type="number" min="0" step="50"
            class="w-full bg-game-bg border border-white/[0.07] rounded-xl px-4 py-3 text-center text-2xl font-extrabold text-amber-400 focus:outline-none focus:border-amber-500"
          />
        </div>
        <div class="flex gap-2 flex-wrap">
          <button
            v-for="v in [100, 250, 500, 1000, 2000]" :key="v"
            class="flex-1 py-2 rounded-xl text-sm font-bold transition-all"
            :class="budgetAmount == v ? 'bg-amber-500 text-slate-900' : 'bg-game-card text-slate-300 hover:bg-game-elevated'"
            @click="budgetAmount = v"
          >{{ v }}</button>
        </div>
        <div class="text-xs text-slate-500 text-center">
          Бюджет оновлюється щопонеділка. Поточне значення: {{ budgetTeacher?.coinsBudgetWeekly ?? DEFAULT_WEEKLY_BUDGET }} монет
        </div>
        <AppButton variant="primary" block :loading="savingBudget" @click="saveBudget">Зберегти бюджет</AppButton>
      </div>
    </AppModal>

    <!-- Code reveal modal -->
    <AppModal :modelValue="!!showCode" title="Вчителя створено!" @update:modelValue="v => { if (!v) showCode = null }">
      <div v-if="showCode" class="flex flex-col items-center gap-4 text-center">
        <div class="font-bold text-lg">{{ showCode.displayName }}</div>
        <div class="bg-game-bg rounded-xl p-4 w-full">
          <div class="text-xs text-slate-400 mb-2 font-semibold">КОД ДОСТУПУ</div>
          <div class="text-3xl font-extrabold text-accent tracking-widest">{{ showCode.code }}</div>
          <button class="text-xs text-slate-500 mt-2 hover:text-slate-300 flex items-center gap-1 mx-auto" @click="copyCode(showCode.code)">
            <Copy :size="12" :stroke-width="2" /> Скопіювати
          </button>
        </div>
        <AppButton variant="primary" block @click="showCode = null">Готово</AppButton>
      </div>
    </AppModal>
  </div>
</template>
