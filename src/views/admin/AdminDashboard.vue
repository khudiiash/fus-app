<script setup>
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { getAllStudents, getAllTeachers, getAllClasses, getAllItems } from '@/firebase/collections'
import { runFullSeed, seedSubjects } from '@/firebase/seedData'
import AppCard from '@/components/ui/AppCard.vue'
import AppButton from '@/components/ui/AppButton.vue'
import { useToast } from '@/composables/useToast'
import { Download, KeyRound } from 'lucide-vue-next'

const router  = useRouter()
const { success, error } = useToast()
const seeding         = ref(false)
const seedingSubjects = ref(false)
const stats   = ref({ students: 0, teachers: 0, classes: 0, items: 0 })
const topStudents = ref([])
const exportingStudents = ref(false)
const exportingTeachers = ref(false)

/** Один рядок: прізвище ім'я код (ім'я може бути з кількох слів, напр. по батькові). */
function lineSurnameNameCode(displayName, accessCode) {
  const parts = String(displayName || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  const code = String(accessCode || '').trim()
  if (parts.length >= 2) {
    const surname = parts[0]
    const givenRest = parts.slice(1).join(' ')
    return `${surname} ${givenRest} ${code}`.trim()
  }
  if (parts.length === 1) return `${parts[0]} ${code}`.trim()
  return code
}

function downloadTxt(filename, text) {
  const blob = new Blob(['\ufeff', text], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function todaySlug() {
  return new Date().toISOString().slice(0, 10)
}

async function exportStudentCodes() {
  exportingStudents.value = true
  try {
    const [students, classes] = await Promise.all([getAllStudents(), getAllClasses()])
    const className = (id) => classes.find((c) => c.id === id)?.name || '—'
    const sorted = [...students].sort((a, b) => {
      const na = className(a.classId).localeCompare(className(b.classId), 'uk')
      if (na !== 0) return na
      return (a.displayName || '').localeCompare(b.displayName || '', 'uk')
    })
    const lines = []
    let prevClassLabel = null
    for (const s of sorted) {
      const label = className(s.classId)
      if (label !== prevClassLabel) {
        lines.push(`# ${label}`)
        prevClassLabel = label
      }
      lines.push(lineSurnameNameCode(s.displayName, s.accessCode))
    }
    const text = lines.join('\r\n')
    downloadTxt(`fusapp-kody-uchni-${todaySlug()}.txt`, text)
    success(`Експортовано ${sorted.length} учнів`)
  } catch (e) {
    error(e.message || 'Не вдалося експортувати')
  } finally {
    exportingStudents.value = false
  }
}

async function exportTeacherCodes() {
  exportingTeachers.value = true
  try {
    const teachers = await getAllTeachers()
    const sorted = [...teachers].sort((a, b) =>
      (a.displayName || '').localeCompare(b.displayName || '', 'uk'),
    )
    const lines = sorted.map((t) => lineSurnameNameCode(t.displayName, t.accessCode))
    downloadTxt(`fusapp-kody-vchyteli-${todaySlug()}.txt`, lines.join('\r\n'))
    success(`Експортовано ${sorted.length} вчителів`)
  } catch (e) {
    error(e.message || 'Не вдалося експортувати')
  } finally {
    exportingTeachers.value = false
  }
}

async function doSeedSubjects() {
  seedingSubjects.value = true
  try {
    const { added, skipped } = await seedSubjects()
    success(`Додано ${added} предметів${skipped ? `, пропущено ${skipped} (вже існують)` : ''}.`)
  } catch (e) {
    error(e.message)
  } finally {
    seedingSubjects.value = false
  }
}

async function seedData() {
  if (!confirm('Це замінить ВСІ товари магазину та досягнення стандартними даними. Продовжити?')) return
  seeding.value = true
  try {
    const result = await runFullSeed()
    success(`Додано ${result.items} товарів та ${result.achievements} досягнень!`)
    stats.value.items = result.items
  } catch (e) {
    error(e.message)
  } finally {
    seeding.value = false
  }
}

onMounted(async () => {
  const [students, teachers, classes, items] = await Promise.all([
    getAllStudents(), getAllTeachers(), getAllClasses(), getAllItems(),
  ])
  stats.value = { students: students.length, teachers: teachers.length, classes: classes.length, items: items.length }
  topStudents.value = students.slice(0, 5)
})

const statCards = [
  { key: 'students', label: 'Учні',    icon: '👦', color: 'text-violet-400', to: '/admin/students' },
  { key: 'teachers', label: 'Вчителі', icon: '👩‍🏫', color: 'text-blue-400', to: '/admin/teachers' },
  { key: 'classes',  label: 'Класи',   icon: '🏫', color: 'text-emerald-400', to: '/admin/classes' },
  { key: 'items',    label: 'Товари',  icon: '🛍️', color: 'text-amber-400', to: '/admin/shop' },
]
</script>

<template>
  <div class="flex flex-col gap-6">
    <div>
      <h1 class="text-2xl font-extrabold">📊 Панель керування</h1>
      <p class="text-slate-400 text-sm mt-1">Огляд активності FUSAPP</p>
    </div>

    <!-- Stats -->
    <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
      <AppCard
        v-for="s in statCards"
        :key="s.key"
        class="cursor-pointer hover:border-violet-500/50 transition-colors"
        @click="router.push(s.to)"
      >
        <div class="text-3xl mb-2">{{ s.icon }}</div>
        <div class="text-3xl font-extrabold" :class="s.color">{{ stats[s.key] }}</div>
        <div class="text-sm text-slate-400 font-semibold">{{ s.label }}</div>
      </AppCard>
    </div>

    <!-- Top students -->
    <div v-if="topStudents.length > 0">
      <h2 class="font-extrabold text-lg mb-3">🏆 Найкращі учні</h2>
      <div class="flex flex-col gap-2">
        <AppCard
          v-for="(s, i) in topStudents"
          :key="s.id"
          class="flex items-center gap-3"
        >
          <div class="w-8 h-8 rounded-full flex items-center justify-center font-extrabold text-sm flex-shrink-0"
            :class="i === 0 ? 'bg-amber-500 text-slate-900' : i === 1 ? 'bg-slate-400 text-slate-900' : i === 2 ? 'bg-amber-700 text-white' : 'bg-game-border text-slate-300'">
            {{ i + 1 }}
          </div>
          <div class="flex-1">
            <div class="font-bold">{{ s.displayName }}</div>
            <div class="text-xs text-slate-400">Рівень {{ s.level }} · {{ s.streak }} днів поспіль</div>
          </div>
          <div class="text-amber-400 font-extrabold">🪙 {{ (s.coins || 0).toLocaleString() }}</div>
        </AppCard>
      </div>
    </div>

    <!-- Access code lists (.txt: прізвище ім'я код) -->
    <AppCard>
      <div class="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div class="flex gap-3">
          <div class="w-10 h-10 rounded-xl bg-violet-500/15 flex items-center justify-center shrink-0">
            <KeyRound :size="20" :stroke-width="2" class="text-violet-400" />
          </div>
          <div>
            <div class="font-extrabold">Коди доступу</div>
            <div class="text-xs text-slate-400 mt-1 max-w-xl">
              Текстовий файл (.txt): кожен рядок — <span class="text-slate-300">прізвище ім'я код</span>.
              У списку учнів перед групою — рядок <span class="text-slate-300"># назва класу</span>. UTF‑8 (зручно в Блокноті).
            </div>
          </div>
        </div>
        <div class="flex flex-col sm:flex-row gap-2 shrink-0">
          <AppButton
            variant="secondary"
            size="sm"
            :loading="exportingStudents"
            :disabled="exportingTeachers"
            @click="exportStudentCodes"
          >
            <Download :size="14" :stroke-width="2" class="shrink-0" />
            Коди учнів
          </AppButton>
          <AppButton
            variant="secondary"
            size="sm"
            :loading="exportingTeachers"
            :disabled="exportingStudents"
            @click="exportTeacherCodes"
          >
            <Download :size="14" :stroke-width="2" class="shrink-0" />
            Коди вчителів
          </AppButton>
        </div>
      </div>
    </AppCard>

    <!-- Quick actions -->
    <div>
      <h2 class="font-extrabold text-lg mb-3">⚡ Швидкі дії</h2>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
        <button
          v-for="s in statCards"
          :key="s.key"
          class="glass-card p-4 flex flex-col items-center gap-2 cursor-pointer hover:border-violet-500/50 transition-all active:scale-95"
          @click="router.push(s.to)"
        >
          <span class="text-2xl">{{ s.icon }}</span>
          <span class="text-xs font-bold">Керувати: {{ s.label }}</span>
        </button>
      </div>
    </div>

    <!-- Seed data -->
    <AppCard>
      <div class="flex items-center justify-between gap-4">
        <div>
          <div class="font-extrabold">🌱 Заповнити даними</div>
          <div class="text-xs text-slate-400 mt-1">Додати стандартні товари магазину та досягнення. Безпечно для нового проєкту.</div>
        </div>
        <AppButton variant="secondary" size="sm" :loading="seeding" @click="seedData">Заповнити</AppButton>
      </div>
      <div class="border-t border-white/[0.07] mt-3 pt-3 flex items-center justify-between gap-4">
        <div>
          <div class="font-semibold text-sm">📚 Додати всі предмети</div>
          <div class="text-xs text-slate-400 mt-0.5">Завантажує повний список предметів із авто-іконками. Вже існуючі пропускаються.</div>
        </div>
        <AppButton variant="secondary" size="sm" :loading="seedingSubjects" @click="doSeedSubjects">Додати</AppButton>
      </div>
    </AppCard>
  </div>
</template>
