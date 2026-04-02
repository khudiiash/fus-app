<script setup>
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { getAllStudents, getAllTeachers, getAllClasses, getAllItems } from '@/firebase/collections'
import { runFullSeed, seedSubjects } from '@/firebase/seedData'
import AppCard from '@/components/ui/AppCard.vue'
import AppButton from '@/components/ui/AppButton.vue'
import { useToast } from '@/composables/useToast'

const router  = useRouter()
const { success, error } = useToast()
const seeding         = ref(false)
const seedingSubjects = ref(false)
const stats   = ref({ students: 0, teachers: 0, classes: 0, items: 0 })
const topStudents = ref([])

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
