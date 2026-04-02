<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { getAllSubjects, createSubject, updateSubject, deleteSubject } from '@/firebase/collections'
import { getSubjectIcon, SUBJECT_ICONS } from '@/composables/useSubjectIcon'
import AppButton from '@/components/ui/AppButton.vue'
import AppModal from '@/components/ui/AppModal.vue'
import AppInput from '@/components/ui/AppInput.vue'
import SubjectIcon from '@/components/ui/SubjectIcon.vue'
import { useToast } from '@/composables/useToast'
import { BookOpen, Pencil, Trash2, Search, X } from 'lucide-vue-next'

const { success, error } = useToast()

// ── Data ──────────────────────────────────────────────────────────────────────
const subjects       = ref([])
const showModal      = ref(false)
const editingSubject = ref(null)
const saving         = ref(false)
const filterQuery    = ref('')
const confirmDeleteId = ref(null)
const deleting        = ref(false)

const form = ref({ name: '', icon: '📖' })
const iconManuallySet = ref(false)

// ── Categories ────────────────────────────────────────────────────────────────
const CATEGORIES = [
  { key: 'math',      label: 'Математика',               icon: '🔢' },
  { key: 'languages', label: 'Мови',                     icon: '🌐' },
  { key: 'literature',label: 'Література',                icon: '📚' },
  { key: 'sciences',  label: 'Природничі науки',          icon: '🧬' },
  { key: 'history',   label: 'Історія та суспільство',   icon: '🏛️' },
  { key: 'arts',      label: 'Мистецтво та технології',  icon: '🎨' },
  { key: 'pe',        label: 'Фізкультура та здоров\'я', icon: '🏃' },
  { key: 'homeroom',  label: 'Виховна робота',            icon: '👨‍🏫' },
  { key: 'other',     label: 'Інше',                     icon: '📖' },
]

function getCategoryKey(name) {
  const n = name.toLowerCase()
  // Order matters — more specific rules first
  if (/алгебр|геометр|математик/.test(n))                                         return 'math'
  if (/фізичн культур|фізкультур/.test(n))                                         return 'pe'
  if (/здоров|захист/.test(n))                                                     return 'pe'
  if (/фізик|астроном/.test(n))                                                    return 'sciences'
  if (/англійськ|польськ|іноземна|edukacja|навчання грамоти|літературне читання/.test(n)
      || n === 'читання'
      || (/мов/.test(n) && !/суспільствознав/.test(n)))                            return 'languages'
  if (/польська культур|зарубіжна літерат|українська літерат|літератур/.test(n))  return 'literature'
  if (/біологі|хімі|географ|природ|яд|я досліджу|пізнаємо природу/.test(n))      return 'sciences'
  if (/stem/.test(n) && !/куратор|класн|психолог|додатков|емоційн/.test(n))       return 'sciences'
  if (/вступ до істор|всесвітня істор|історія украін|історія.*інтегр|інтегр.*істор|история|historia|wos/.test(n)) return 'history'
  if (/правознавств|громадянськ|суспільствознав/.test(n))                         return 'history'
  if (/істор/.test(n))                                                             return 'history'
  if (/мистецтв|образотворч|музик|малюванн/.test(n))                             return 'arts'
  if (/інформатик|технологі|дизайн|трудове/.test(n))                             return 'arts'
  if (/куратор|класним|психолог|година|додаткова|емоційн/.test(n))               return 'homeroom'
  return 'other'
}

// ── Sorted + filtered ─────────────────────────────────────────────────────────
const filtered = computed(() => {
  const q = filterQuery.value.trim().toLowerCase()
  const sorted = [...subjects.value].sort((a, b) => a.name.localeCompare(b.name, 'uk'))
  if (!q) return sorted
  return sorted.filter(s => s.name.toLowerCase().includes(q))
})

const isFiltering = computed(() => filterQuery.value.trim().length > 0)

// Group into categories (only when not filtering)
const grouped = computed(() => {
  if (isFiltering.value) return null
  const map = {}
  for (const s of filtered.value) {
    const k = getCategoryKey(s.name)
    if (!map[k]) map[k] = []
    map[k].push(s)
  }
  // Return in CATEGORIES order, skip empty
  return CATEGORIES.filter(c => map[c.key]?.length).map(c => ({ ...c, subjects: map[c.key] }))
})

// ── Icon auto-detect ──────────────────────────────────────────────────────────
watch(() => form.value.name, name => {
  if (!iconManuallySet.value) form.value.icon = getSubjectIcon(name)
})

function pickIcon(icon) {
  form.value.icon = icon
  iconManuallySet.value = true
}

// ── CRUD ──────────────────────────────────────────────────────────────────────
onMounted(fetchSubjects)

async function fetchSubjects() {
  subjects.value = await getAllSubjects()
}

function openCreate() {
  editingSubject.value  = null
  iconManuallySet.value = false
  form.value = { name: '', icon: '📖' }
  showModal.value = true
}

function openEdit(s) {
  editingSubject.value  = s
  iconManuallySet.value = true
  form.value = { name: s.name, icon: s.icon || getSubjectIcon(s.name) }
  showModal.value = true
}

async function save() {
  if (!form.value.name.trim()) { error('Назва предмету обов\'язкова'); return }
  saving.value = true
  try {
    if (editingSubject.value) {
      await updateSubject(editingSubject.value.id, form.value)
      success('Предмет оновлено!')
    } else {
      await createSubject(form.value)
      success('Предмет створено!')
    }
    showModal.value = false
    await fetchSubjects()
  } catch (e) {
    error(e.message)
  } finally {
    saving.value = false
  }
}

async function hardDelete(s) {
  deleting.value = true
  try {
    await deleteSubject(s.id)
    confirmDeleteId.value = null
    success('Предмет видалено')
    await fetchSubjects()
  } catch (e) {
    error(e.message)
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <div class="flex flex-col gap-4">

    <!-- Header -->
    <div class="flex items-center justify-between gap-3">
      <div>
        <div class="flex items-center gap-2">
          <BookOpen :size="22" :stroke-width="2" class="text-accent" />
          <h1 class="text-2xl font-extrabold">Предмети</h1>
        </div>
        <p class="text-slate-400 text-sm mt-1">{{ subjects.length }} предметів</p>
      </div>
      <AppButton variant="primary" size="sm" @click="openCreate">+ Новий предмет</AppButton>
    </div>

    <!-- Search -->
    <div class="relative">
      <Search :size="15" :stroke-width="2" class="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
      <input
        v-model="filterQuery"
        placeholder="Пошук предмету..."
        class="w-full bg-game-card border border-white/[0.07] rounded-xl pl-9 pr-9 py-2.5 text-sm text-slate-200 placeholder-slate-500 outline-none focus:border-white/20 transition-colors"
      />
      <button
        v-if="filterQuery"
        class="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
        @click="filterQuery = ''"
      >
        <X :size="14" :stroke-width="2" />
      </button>
    </div>

    <!-- Empty state -->
    <div v-if="subjects.length === 0" class="text-center py-16 text-slate-500">
      <BookOpen :size="48" :stroke-width="1" class="mx-auto mb-3 opacity-20" />
      <div class="font-bold">Предметів ще немає</div>
      <div class="text-sm mt-1">Додайте предмети, щоб призначити їх вчителям</div>
    </div>

    <!-- No search results -->
    <div v-else-if="filtered.length === 0" class="text-center py-10 text-slate-500 text-sm">
      Нічого не знайдено за запитом «{{ filterQuery }}»
    </div>

    <!-- Filtered flat list -->
    <div v-else-if="isFiltering" class="flex flex-col gap-1">
      <div
        v-for="s in filtered"
        :key="s.id"
        class="flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-white/[0.04] transition-colors group"
      >
        <SubjectIcon :icon="s.icon || getSubjectIcon(s.name)" size="1.25rem" class="flex-shrink-0" />
        <span class="flex-1 text-sm font-semibold text-slate-200 truncate">{{ s.name }}</span>
        <div class="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <template v-if="confirmDeleteId !== s.id">
            <button
              class="p-1.5 rounded-lg text-slate-500 hover:text-slate-200 hover:bg-white/[0.08] transition-colors"
              title="Змінити"
              @click="openEdit(s)"
            >
              <Pencil :size="13" :stroke-width="2" />
            </button>
            <button
              class="p-1.5 rounded-lg text-slate-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
              title="Видалити"
              @click="confirmDeleteId = s.id"
            >
              <Trash2 :size="13" :stroke-width="2" />
            </button>
          </template>
          <template v-else>
            <span class="text-xs text-red-400 font-bold mr-1">Видалити?</span>
            <button
              class="text-xs px-2 py-1 rounded-lg bg-red-500/20 text-red-400 hover:bg-red-500/30 font-bold transition-colors disabled:opacity-50"
              :disabled="deleting"
              @click="hardDelete(s)"
            >{{ deleting ? '...' : 'Так' }}</button>
            <button
              class="text-xs px-2 py-1 rounded-lg bg-white/[0.06] text-slate-400 hover:bg-white/[0.10] font-bold transition-colors"
              @click="confirmDeleteId = null"
            >Ні</button>
          </template>
        </div>
      </div>
    </div>

    <!-- Grouped by category -->
    <div v-else class="flex flex-col gap-5">
      <div v-for="cat in grouped" :key="cat.key">
        <!-- Category header -->
        <div class="flex items-center gap-2 mb-2 px-1">
          <span class="text-base">{{ cat.icon }}</span>
          <span class="text-sm font-extrabold text-slate-300 uppercase tracking-wide">{{ cat.label }}</span>
          <span class="text-xs text-slate-600 font-bold ml-1">{{ cat.subjects.length }}</span>
          <div class="flex-1 h-px bg-white/[0.06] ml-1" />
        </div>
        <!-- Subjects in category -->
        <div class="flex flex-col gap-1">
          <div
            v-for="s in cat.subjects"
            :key="s.id"
            class="flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-white/[0.04] transition-colors group"
          >
            <SubjectIcon :icon="s.icon || getSubjectIcon(s.name)" size="1.25rem" class="flex-shrink-0" />
            <span class="flex-1 text-sm font-semibold text-slate-200 truncate">{{ s.name }}</span>

            <!-- Actions -->
            <div class="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <template v-if="confirmDeleteId !== s.id">
                <button
                  class="p-1.5 rounded-lg text-slate-500 hover:text-slate-200 hover:bg-white/[0.08] transition-colors"
                  title="Змінити"
                  @click="openEdit(s)"
                >
                  <Pencil :size="13" :stroke-width="2" />
                </button>
                <button
                  class="p-1.5 rounded-lg text-slate-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                  title="Видалити"
                  @click="confirmDeleteId = s.id"
                >
                  <Trash2 :size="13" :stroke-width="2" />
                </button>
              </template>
              <template v-else>
                <span class="text-xs text-red-400 font-bold mr-1">Видалити?</span>
                <button
                  class="text-xs px-2 py-1 rounded-lg bg-red-500/20 text-red-400 hover:bg-red-500/30 font-bold transition-colors disabled:opacity-50"
                  :disabled="deleting"
                  @click="hardDelete(s)"
                >{{ deleting ? '...' : 'Так' }}</button>
                <button
                  class="text-xs px-2 py-1 rounded-lg bg-white/[0.06] text-slate-400 hover:bg-white/[0.10] font-bold transition-colors"
                  @click="confirmDeleteId = null"
                >Ні</button>
              </template>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Modal -->
    <AppModal v-model="showModal" :title="editingSubject ? 'Редагувати предмет' : 'Новий предмет'">
      <div class="flex flex-col gap-4">
        <AppInput v-model="form.name" label="Назва предмету" placeholder="напр. Математика, Інформатика" />

        <!-- Auto-detected preview -->
        <div class="flex items-center gap-3 rounded-xl px-4 py-3" style="background:rgba(255,255,255,0.05)">
          <SubjectIcon :icon="form.icon" size="2.5rem" />
          <div>
            <div class="text-sm font-bold text-slate-300">{{ form.name || 'Назва предмету' }}</div>
            <div class="text-xs text-slate-500 mt-0.5">
              {{ iconManuallySet ? 'Іконка обрана вручну' : 'Іконка визначена автоматично' }}
              <button v-if="iconManuallySet" class="text-accent ml-1" @click="iconManuallySet = false; form.icon = getSubjectIcon(form.name)">
                скинути
              </button>
            </div>
          </div>
        </div>

        <!-- Icon picker -->
        <div>
          <label class="text-sm font-bold text-slate-300 block mb-2">Або обери іконку вручну</label>
          <div class="flex flex-wrap gap-1.5">
            <button
              v-for="icon in SUBJECT_ICONS"
              :key="icon"
              class="p-2 rounded-lg transition-all"
              :class="form.icon === icon ? 'ring-2 ring-white/50 scale-110 tab-active' : 'bg-game-card hover:bg-game-elevated'"
              @click="pickIcon(icon)"
            ><SubjectIcon :icon="icon" size="1.25rem" /></button>
          </div>
        </div>

        <AppButton variant="primary" block :loading="saving" @click="save">
          {{ editingSubject ? 'Зберегти зміни' : 'Створити предмет' }}
        </AppButton>
      </div>
    </AppModal>
  </div>
</template>
