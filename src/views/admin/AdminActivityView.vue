<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import {
  classesCol,
  getAdminRecentTransactions,
  getStudentActivityTransactions,
  getTeacherActivityTransactions,
  getUsersByClass,
  getAllStudents,
  getAllTeachers,
} from '@/firebase/collections'
import { getDocs } from 'firebase/firestore'
import { resolveUserProfile } from '@/composables/useTransactionFeed'
import { useToast } from '@/composables/useToast'
import AppButton from '@/components/ui/AppButton.vue'
import CoinDisplay from '@/components/gamification/CoinDisplay.vue'
import { Activity, Clock, Inbox, School, User, GraduationCap, Search, X } from 'lucide-vue-next'

const { error: toastError } = useToast()

const mode = ref('recent') // recent | student | teacher | class
const loading = ref(false)
const rows = ref([])
const nameByUid = ref({})

const classes = ref([])
const selectedClassId = ref('')
const classStudentIds = ref(new Set())

const allStudents = ref([])
const allTeachers = ref([])
const studentSearch = ref('')
const teacherSearch = ref('')
const selectedStudentId = ref('')
const selectedTeacherId = ref('')

function classNameForStudent(classId) {
  if (!classId) return ''
  const c = classes.value.find((x) => x.id === classId)
  return c?.name || ''
}

const studentsFiltered = computed(() => {
  const q = studentSearch.value.trim().toLowerCase()
  let list = [...allStudents.value].sort((a, b) =>
    String(a.displayName || '').localeCompare(String(b.displayName || ''), 'uk'),
  )
  if (q) {
    list = list.filter(
      (s) =>
        (s.displayName && s.displayName.toLowerCase().includes(q))
        || (s.accessCode && String(s.accessCode).toLowerCase().includes(q)),
    )
  }
  return list
})

const teachersFiltered = computed(() => {
  const q = teacherSearch.value.trim().toLowerCase()
  let list = [...allTeachers.value].sort((a, b) =>
    String(a.displayName || '').localeCompare(String(b.displayName || ''), 'uk'),
  )
  if (q) {
    list = list.filter(
      (t) =>
        (t.displayName && t.displayName.toLowerCase().includes(q))
        || (t.accessCode && String(t.accessCode).toLowerCase().includes(q)),
    )
  }
  return list
})

async function loadNames(uids) {
  const m = { ...nameByUid.value }
  for (const uid of uids) {
    if (!uid || m[uid]) continue
    const p = await resolveUserProfile(uid)
    m[uid] = p?.displayName || uid
  }
  nameByUid.value = m
}

function displayUid(uid) {
  return nameByUid.value[uid] || uid || '—'
}

function txLabel(t) {
  const map = {
    award: 'Нарахування',
    fine: 'Штраф',
    trade: 'Обмін',
    purchase: 'Покупка',
    badge_sent: 'Значок',
    box_open: 'Коробка',
    quest_reward: 'Завдання',
    streak_bonus: 'Серія',
    daily_quest: 'Щоденне завдання',
    achievement_reward: 'Досягнення',
  }
  return map[t.type] || (t.type || 'Подія')
}

async function runLoad() {
  loading.value = true
  rows.value = []
  try {
    if (mode.value === 'recent') {
      const raw = await getAdminRecentTransactions(280)
      rows.value = raw
      const uids = new Set()
      raw.forEach((t) => {
        if (t.fromUid) uids.add(t.fromUid)
        if (t.toUid) uids.add(t.toUid)
      })
      await loadNames([...uids])
      return
    }

    if (mode.value === 'student') {
      const uid = selectedStudentId.value.trim()
      if (!uid) {
        toastError('Оберіть учня зі списку')
        return
      }
      const raw = await getStudentActivityTransactions(uid, 150)
      rows.value = raw
      const uids = new Set()
      raw.forEach((t) => {
        if (t.fromUid) uids.add(t.fromUid)
        if (t.toUid) uids.add(t.toUid)
      })
      await loadNames([...uids])
      return
    }

    if (mode.value === 'teacher') {
      const uid = selectedTeacherId.value.trim()
      if (!uid) {
        toastError('Оберіть вчителя зі списку')
        return
      }
      const raw = await getTeacherActivityTransactions(uid, 150)
      rows.value = raw
      const uids = new Set()
      raw.forEach((t) => {
        if (t.fromUid) uids.add(t.fromUid)
        if (t.toUid) uids.add(t.toUid)
      })
      await loadNames([...uids])
      return
    }

    if (mode.value === 'class') {
      if (!selectedClassId.value) {
        toastError('Оберіть клас')
        return
      }
      const studs = await getUsersByClass(selectedClassId.value)
      const set = new Set(studs.map((s) => s.id))
      classStudentIds.value = set
      const raw = await getAdminRecentTransactions(450)
      rows.value = raw.filter(
        (t) =>
          (t.fromUid && set.has(t.fromUid)) || (t.toUid && set.has(t.toUid)),
      )
      const uids = new Set()
      rows.value.forEach((t) => {
        if (t.fromUid) uids.add(t.fromUid)
        if (t.toUid) uids.add(t.toUid)
      })
      await loadNames([...uids])
    }
  } catch (e) {
    console.warn('[AdminActivity]', e?.message)
    toastError(e?.message || 'Не вдалося завантажити')
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  try {
    const [snap, studs, teach] = await Promise.all([
      getDocs(classesCol()),
      getAllStudents(),
      getAllTeachers(),
    ])
    classes.value = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'uk'))
    if (classes.value.length) selectedClassId.value = classes.value[0].id
    allStudents.value = studs || []
    allTeachers.value = teach || []
  } catch {
    classes.value = []
    allStudents.value = []
    allTeachers.value = []
  }
  await runLoad()
})

watch(mode, () => {
  rows.value = []
})

function formatDate(ts) {
  if (!ts) return ''
  const d = ts.toDate ? ts.toDate() : new Date(ts)
  return d.toLocaleString('uk-UA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}
</script>

<template>
  <div class="flex flex-col gap-5 animate-fade-in max-w-4xl">
    <div>
      <div class="flex items-center gap-2 mb-0.5">
        <Activity :size="22" :stroke-width="2" class="text-amber-500" />
        <h1 class="text-2xl font-extrabold gradient-heading">Активність</h1>
      </div>
      <p class="text-slate-500 text-sm">Транзакції школи: останні події, за учнем, вчителем або класом</p>
    </div>

    <div class="flex flex-wrap gap-2">
      <button
        v-for="opt in [
          { k: 'recent', label: 'Останні' },
          { k: 'student', label: 'За учнем' },
          { k: 'teacher', label: 'За вчителем' },
          { k: 'class', label: 'За класом' },
        ]"
        :key="opt.k"
        type="button"
        class="px-3 py-1.5 rounded-xl text-xs font-bold transition-all"
        :class="mode === opt.k ? 'tab-active' : 'bg-white/[0.06] text-slate-400 hover:text-slate-200'"
        @click="mode = opt.k"
      >
        {{ opt.label }}
      </button>
    </div>

    <div v-if="mode === 'student'" class="flex flex-col gap-3 max-w-xl">
      <label class="text-[11px] font-bold text-slate-500 uppercase tracking-wide flex items-center gap-1">
        <User :size="12" /> Учень
      </label>
      <div class="relative">
        <Search
          :size="15"
          :stroke-width="2"
          class="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none"
        />
        <input
          v-model="studentSearch"
          type="search"
          class="w-full bg-game-card border border-game-border rounded-xl pl-9 pr-9 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-violet-500"
          placeholder="Пошук за іменем або кодом…"
          autocomplete="off"
        />
        <button
          v-if="studentSearch"
          type="button"
          class="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-lg text-slate-500 hover:text-slate-300"
          aria-label="Очистити пошук"
          @click="studentSearch = ''"
        >
          <X :size="14" :stroke-width="2" />
        </button>
      </div>
      <select
        v-model="selectedStudentId"
        class="w-full bg-game-card border border-game-border rounded-xl px-3 py-2.5 text-sm font-semibold text-white focus:outline-none focus:border-violet-500 max-h-[min(40vh,16rem)]"
        size="8"
      >
        <option value="">— Оберіть учня —</option>
        <option
          v-for="s in studentsFiltered"
          :key="s.id"
          :value="s.id"
          :title="s.id"
        >
          {{ s.displayName || 'Без імені' }}{{ classNameForStudent(s.classId) ? ` · ${classNameForStudent(s.classId)}` : '' }}
        </option>
      </select>
      <div class="text-[11px] text-slate-500">
        Знайдено: {{ studentsFiltered.length }} з {{ allStudents.length }}
      </div>
      <AppButton variant="secondary" size="sm" class="w-fit" :loading="loading" @click="runLoad">
        Завантажити журнал
      </AppButton>
    </div>

    <div v-if="mode === 'teacher'" class="flex flex-col gap-3 max-w-xl">
      <label class="text-[11px] font-bold text-slate-500 uppercase tracking-wide flex items-center gap-1">
        <GraduationCap :size="12" /> Вчитель
      </label>
      <div class="relative">
        <Search
          :size="15"
          :stroke-width="2"
          class="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none"
        />
        <input
          v-model="teacherSearch"
          type="search"
          class="w-full bg-game-card border border-game-border rounded-xl pl-9 pr-9 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-violet-500"
          placeholder="Пошук за іменем або кодом…"
          autocomplete="off"
        />
        <button
          v-if="teacherSearch"
          type="button"
          class="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-lg text-slate-500 hover:text-slate-300"
          aria-label="Очистити пошук"
          @click="teacherSearch = ''"
        >
          <X :size="14" :stroke-width="2" />
        </button>
      </div>
      <select
        v-model="selectedTeacherId"
        class="w-full bg-game-card border border-game-border rounded-xl px-3 py-2.5 text-sm font-semibold text-white focus:outline-none focus:border-violet-500 max-h-[min(40vh,16rem)]"
        size="8"
      >
        <option value="">— Оберіть вчителя —</option>
        <option v-for="t in teachersFiltered" :key="t.id" :value="t.id" :title="t.id">
          {{ t.displayName || 'Без імені' }}
        </option>
      </select>
      <div class="text-[11px] text-slate-500">
        Знайдено: {{ teachersFiltered.length }} з {{ allTeachers.length }}
      </div>
      <AppButton variant="secondary" size="sm" class="w-fit" :loading="loading" @click="runLoad">
        Завантажити журнал
      </AppButton>
    </div>

    <div v-if="mode === 'class'" class="flex flex-wrap gap-2 items-end">
      <div class="flex-1 min-w-[12rem]">
        <label class="text-[11px] font-bold text-slate-500 uppercase tracking-wide flex items-center gap-1 mb-1">
          <School :size="12" /> Клас
        </label>
        <select
          v-model="selectedClassId"
          class="w-full bg-game-card border border-game-border rounded-xl px-3 py-2 text-sm font-bold text-white"
        >
          <option v-for="c in classes" :key="c.id" :value="c.id">{{ c.name }}</option>
        </select>
      </div>
      <AppButton variant="secondary" size="sm" :loading="loading" @click="runLoad">Завантажити</AppButton>
    </div>

    <div v-if="mode === 'recent'" class="flex justify-end">
      <AppButton variant="secondary" size="sm" :loading="loading" @click="runLoad">Оновити</AppButton>
    </div>

    <div v-if="loading" class="flex flex-col items-center py-16 gap-3 text-slate-600">
      <Clock :size="40" :stroke-width="1" class="opacity-30" />
      <div class="text-sm">Завантаження...</div>
    </div>

    <div v-else-if="rows.length === 0" class="text-center py-16 text-slate-600">
      <Inbox :size="44" :stroke-width="1" class="mx-auto mb-3 opacity-30" />
      <div class="font-bold text-slate-500">Немає записів</div>
    </div>

    <div v-else class="flex flex-col gap-1.5 overflow-x-auto">
      <div
        v-for="tx in rows"
        :key="tx.id"
        class="rounded-xl border border-white/[0.07] bg-white/[0.03] px-3 py-2.5 text-sm flex flex-wrap items-center gap-x-3 gap-y-1"
      >
        <span class="font-extrabold text-violet-300 shrink-0">{{ txLabel(tx) }}</span>
        <span class="text-slate-500 text-xs tabular-nums shrink-0">{{ formatDate(tx.timestamp) }}</span>
        <span class="text-slate-400 text-xs min-w-0">
          <span class="text-slate-500">від</span> {{ displayUid(tx.fromUid) }}
          <span class="text-slate-600 mx-1">→</span>
          <span class="text-slate-500">до</span> {{ displayUid(tx.toUid) }}
        </span>
        <span v-if="tx.subjectName" class="text-[11px] text-slate-500 truncate max-w-[10rem]">{{ tx.subjectName }}</span>
        <CoinDisplay
          v-if="Number(tx.amount) !== 0"
          :amount="tx.amount"
          :show-sign="Number(tx.amount) > 0"
          size="sm"
          class="ml-auto shrink-0"
        />
      </div>
    </div>
  </div>
</template>
