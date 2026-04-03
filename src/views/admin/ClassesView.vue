<script setup>
import { ref, computed, onMounted } from 'vue'
import { getAllClasses, createClass, updateClass, deleteClass } from '@/firebase/collections'
import AppButton from '@/components/ui/AppButton.vue'
import AppModal from '@/components/ui/AppModal.vue'
import AppInput from '@/components/ui/AppInput.vue'
import { useToast } from '@/composables/useToast'
import { School, Pencil, Trash2, Search, X, Users, GraduationCap } from 'lucide-vue-next'

const { success, error } = useToast()
const classes      = ref([])
const showModal    = ref(false)
const editingClass = ref(null)
const saving       = ref(false)
const search       = ref('')
const confirmDeleteId = ref(null)
const deleting        = ref(false)

const form = ref({ name: '', icon: '🏫' })

/** Те, про що йшлося: візуально молодша / середня / старша школа */
const CLASS_LEVEL_ICONS = [
  { emoji: '🧒', hint: '1–4 клас' },
  { emoji: '🧑‍🎓', hint: '5–8 клас' },
  { emoji: '🎓', hint: '9+ клас' },
]

/** Додаткові іконки (без «бігуна» — для молодших класів краще 🧒 зверху) */
const CLASS_ICONS_EXTRA = [
  '🏫', '📚', '🔬', '🎨', '🎵', '🌍', '💻', '📐', '🧬', '📝', '🎭', '⭐', '🚀', '🌱', '🔑',
]

// ── Sorting helpers ───────────────────────────────────────────────────────────
function classNumber(name = '') {
  const m = name.match(/^(\d+)/)
  return m ? parseInt(m[1]) : 999
}

function classSuffix(name = '') {
  return name.replace(/^\d+/, '').trim()
}

const SCHOOL_LEVELS = [
  { key: 'primary', label: 'Молодша школа', range: '1–4 клас',  min: 1, max: 4  },
  { key: 'middle',  label: 'Середня школа', range: '5–8 клас',  min: 5, max: 8  },
  { key: 'high',    label: 'Старша школа',  range: '9–11 клас', min: 9, max: 99 },
  { key: 'other',   label: 'Інше',          range: '',          min: -1, max: -1 },
]

function getLevelKey(name) {
  const n = classNumber(name)
  for (const lvl of SCHOOL_LEVELS) {
    if (n >= lvl.min && n <= lvl.max) return lvl.key
  }
  return 'other'
}

// ── Computed ──────────────────────────────────────────────────────────────────
const sorted = computed(() =>
  [...classes.value].sort((a, b) => {
    const nd = classNumber(a.name) - classNumber(b.name)
    if (nd !== 0) return nd
    return classSuffix(a.name).localeCompare(classSuffix(b.name), 'uk')
  })
)

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return sorted.value
  return sorted.value.filter(c => c.name.toLowerCase().includes(q))
})

const isFiltering = computed(() => search.value.trim().length > 0)

const grouped = computed(() => {
  if (isFiltering.value) return null
  const map = {}
  for (const cls of filtered.value) {
    const k = getLevelKey(cls.name)
    if (!map[k]) map[k] = []
    map[k].push(cls)
  }
  return SCHOOL_LEVELS.filter(lvl => map[lvl.key]?.length).map(lvl => ({
    ...lvl,
    classes: map[lvl.key],
  }))
})

// ── CRUD ──────────────────────────────────────────────────────────────────────
onMounted(fetchClasses)
async function fetchClasses() { classes.value = await getAllClasses() }

function openCreate() {
  editingClass.value = null
  form.value = { name: '', icon: '🏫' }
  showModal.value = true
}

function openEdit(cls) {
  editingClass.value = cls
  form.value = { name: cls.name, icon: cls.icon || '🏫' }
  showModal.value = true
}

async function save() {
  if (!form.value.name.trim()) { error('Назва класу обов\'язкова'); return }
  saving.value = true
  try {
    if (editingClass.value) {
      await updateClass(editingClass.value.id, form.value)
      success('Клас оновлено!')
    } else {
      await createClass({ ...form.value, studentIds: [], teacherIds: [] })
      success('Клас створено!')
    }
    showModal.value = false
    await fetchClasses()
  } catch (e) {
    error(e.message)
  } finally {
    saving.value = false
  }
}

async function hardDelete(cls) {
  deleting.value = true
  try {
    await deleteClass(cls.id)
    classes.value = classes.value.filter(c => c.id !== cls.id)
    confirmDeleteId.value = null
    success('Клас видалено')
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
          <School :size="22" :stroke-width="2" class="text-accent" />
          <h1 class="text-2xl font-extrabold">Класи</h1>
        </div>
        <p class="text-slate-400 text-sm mt-1">{{ classes.length }} класів всього</p>
      </div>
      <AppButton variant="primary" size="sm" @click="openCreate">+ Новий клас</AppButton>
    </div>

    <!-- Search -->
    <div class="relative">
      <Search :size="15" :stroke-width="2" class="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
      <input
        v-model="search"
        placeholder="Пошук класу..."
        class="w-full bg-game-card border border-white/[0.07] rounded-xl pl-9 pr-9 py-2.5 text-sm text-slate-200 placeholder-slate-500 outline-none focus:border-white/20 transition-colors"
      />
      <button v-if="search" class="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300" @click="search = ''">
        <X :size="14" :stroke-width="2" />
      </button>
    </div>

    <!-- Empty -->
    <div v-if="classes.length === 0" class="text-center py-16 text-slate-500">
      <School :size="48" :stroke-width="1" class="mx-auto mb-3 opacity-20" />
      <div class="font-bold">Класів ще немає</div>
      <div class="text-sm mt-1">Створіть перший клас, щоб розпочати</div>
    </div>

    <!-- No results -->
    <div v-else-if="filtered.length === 0" class="text-center py-10 text-slate-500 text-sm">
      Нічого не знайдено за запитом «{{ search }}»
    </div>

    <!-- Flat filtered list -->
    <div v-else-if="isFiltering" class="flex flex-col gap-1">
      <div
        v-for="cls in filtered" :key="cls.id"
        class="flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-white/[0.04] transition-colors group"
      >
        <span class="text-lg w-7 text-center flex-shrink-0">{{ cls.icon || '🏫' }}</span>
        <span class="flex-1 text-sm font-semibold text-slate-200 truncate">{{ cls.name }}</span>
        <div class="flex items-center gap-3 text-xs text-slate-600">
          <span>{{ (cls.studentIds || []).length }} учнів</span>
          <span>{{ (cls.teacherIds || []).length }} вчит.</span>
        </div>
        <div class="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <template v-if="confirmDeleteId !== cls.id">
            <button class="p-1.5 rounded-lg text-slate-500 hover:text-slate-200 hover:bg-white/[0.08] transition-colors" @click="openEdit(cls)">
              <Pencil :size="13" :stroke-width="2" />
            </button>
            <button class="p-1.5 rounded-lg text-slate-500 hover:text-red-400 hover:bg-red-500/10 transition-colors" @click="confirmDeleteId = cls.id">
              <Trash2 :size="13" :stroke-width="2" />
            </button>
          </template>
          <template v-else>
            <span class="text-xs text-red-400 font-bold mr-1">Видалити?</span>
            <button class="text-xs px-2 py-1 rounded-lg bg-red-500/20 text-red-400 hover:bg-red-500/30 font-bold disabled:opacity-50" :disabled="deleting" @click="hardDelete(cls)">{{ deleting ? '...' : 'Так' }}</button>
            <button class="text-xs px-2 py-1 rounded-lg bg-white/[0.06] text-slate-400 font-bold" @click="confirmDeleteId = null">Ні</button>
          </template>
        </div>
      </div>
    </div>

    <!-- Grouped by school level -->
    <div v-else class="flex flex-col gap-5">
      <div v-for="lvl in grouped" :key="lvl.key">
        <!-- Level header -->
        <div class="flex items-center gap-2 mb-2 px-1">
          <span class="text-sm font-extrabold text-slate-300 uppercase tracking-wide">{{ lvl.label }}</span>
          <span class="text-xs text-slate-600 font-semibold">{{ lvl.range }}</span>
          <span class="text-xs text-slate-700 font-bold ml-0.5">· {{ lvl.classes.length }}</span>
          <div class="flex-1 h-px bg-white/[0.06] ml-1" />
        </div>

        <!-- Class rows -->
        <div class="flex flex-col gap-1">
          <div
            v-for="cls in lvl.classes" :key="cls.id"
            class="flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-white/[0.04] transition-colors group"
          >
            <span class="text-lg w-7 text-center flex-shrink-0">{{ cls.icon || '🏫' }}</span>

            <span class="flex-1 text-sm font-semibold text-slate-200">{{ cls.name }}</span>

            <!-- Stats -->
            <div class="flex items-center gap-3 text-xs text-slate-600 opacity-0 group-hover:opacity-100 transition-opacity mr-2">
              <span class="flex items-center gap-1">
                <Users :size="10" :stroke-width="2" />{{ (cls.studentIds || []).length }}
              </span>
              <span class="flex items-center gap-1">
                <GraduationCap :size="10" :stroke-width="2" />{{ (cls.teacherIds || []).length }}
              </span>
            </div>

            <!-- Actions -->
            <div class="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <template v-if="confirmDeleteId !== cls.id">
                <button class="p-1.5 rounded-lg text-slate-500 hover:text-slate-200 hover:bg-white/[0.08] transition-colors" title="Змінити" @click="openEdit(cls)">
                  <Pencil :size="13" :stroke-width="2" />
                </button>
                <button class="p-1.5 rounded-lg text-slate-500 hover:text-red-400 hover:bg-red-500/10 transition-colors" title="Видалити" @click="confirmDeleteId = cls.id">
                  <Trash2 :size="13" :stroke-width="2" />
                </button>
              </template>
              <template v-else>
                <span class="text-xs text-red-400 font-bold mr-1">Видалити?</span>
                <button class="text-xs px-2 py-1 rounded-lg bg-red-500/20 text-red-400 hover:bg-red-500/30 font-bold disabled:opacity-50" :disabled="deleting" @click="hardDelete(cls)">{{ deleting ? '...' : 'Так' }}</button>
                <button class="text-xs px-2 py-1 rounded-lg bg-white/[0.06] text-slate-400 font-bold" @click="confirmDeleteId = null">Ні</button>
              </template>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Modal -->
    <AppModal v-model="showModal" :title="editingClass ? 'Редагувати клас' : 'Новий клас'">
      <div class="flex flex-col gap-4">
        <AppInput v-model="form.name" label="Назва класу" placeholder="напр. 10А, 11Б, 9В" />
        <div>
          <label class="text-sm font-bold text-slate-300 block mb-1">Іконка</label>
          <p class="text-xs text-slate-500 mb-2">За рівнем школи (молодші / середні / старші):</p>
          <div class="flex flex-wrap gap-2 mb-4">
            <button
              v-for="row in CLASS_LEVEL_ICONS" :key="row.emoji"
              type="button"
              class="flex flex-col items-center gap-0.5 px-3 py-2 rounded-xl min-w-[4.5rem] transition-all border border-transparent"
              :class="form.icon === row.emoji ? 'ring-2 ring-accent/80 bg-accent/15 border-accent/30' : 'bg-game-card hover:bg-game-elevated'"
              @click="form.icon = row.emoji"
            >
              <span class="text-2xl leading-none">{{ row.emoji }}</span>
              <span class="text-[10px] font-semibold text-slate-500 leading-tight text-center">{{ row.hint }}</span>
            </button>
          </div>
          <p class="text-xs text-slate-500 mb-2">Інші варіанти:</p>
          <div class="flex flex-wrap gap-2">
            <button
              v-for="icon in CLASS_ICONS_EXTRA" :key="icon"
              type="button"
              class="text-xl p-2 rounded-lg transition-all"
              :class="form.icon === icon ? 'ring-2 ring-white/50 scale-110 tab-active' : 'bg-game-card hover:bg-game-elevated'"
              @click="form.icon = icon"
            >{{ icon }}</button>
          </div>
        </div>
        <AppButton variant="primary" block :loading="saving" @click="save">
          {{ editingClass ? 'Зберегти зміни' : 'Створити клас' }}
        </AppButton>
      </div>
    </AppModal>
  </div>
</template>
