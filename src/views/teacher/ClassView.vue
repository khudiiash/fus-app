<script setup>
import { ref, onMounted, onUnmounted, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { watchClass, getUsersByClass, awardCoins, fineStudent, checkAndGrantAchievements, getAllSubjects, getTeacherBudgetInfo } from '@/firebase/collections'
import { getSubjectIcon } from '@/composables/useSubjectIcon'
import AppCard from '@/components/ui/AppCard.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppModal from '@/components/ui/AppModal.vue'
import AppInput from '@/components/ui/AppInput.vue'
import SubjectIcon from '@/components/ui/SubjectIcon.vue'
import AvatarDisplay from '@/components/avatar/AvatarDisplay.vue'
import CoinDisplay from '@/components/gamification/CoinDisplay.vue'
import { useToast } from '@/composables/useToast'
import { useHaptic } from '@/composables/useHaptic'
import { Coins, Wallet, Flame, LayoutDashboard, Gavel } from 'lucide-vue-next'

const route  = useRoute()
const router = useRouter()
const auth   = useAuthStore()
const { success, error } = useToast()
const { coin: hapticCoin } = useHaptic()

const classData   = ref(null)
const students    = ref([])
const showAward   = ref(false)
const awardTarget = ref(null)
const bulkMode    = ref(false)
const selectedIds = ref([])
const awardAmount = ref(10)
const awardNote   = ref('')
const awardSubject = ref('')   // selected subject name for the award
const awarding    = ref(false)
const search      = ref('')

// Subjects this teacher teaches (filtered from all subjects)
const teacherSubjects = ref([])

let unsubClass = null

onMounted(async () => {
  const classId = route.params.id
  unsubClass = watchClass(classId, data => { classData.value = data })
  students.value = await getUsersByClass(classId)

  // Load subjects and filter to only those the teacher teaches
  const subjectIds = auth.profile?.subjectIds || []
  if (subjectIds.length) {
    const all = await getAllSubjects()
    teacherSubjects.value = all.filter(s => subjectIds.includes(s.id))
  }
})

onUnmounted(() => { if (unsubClass) unsubClass() })

const filtered = computed(() => {
  if (!search.value.trim()) return students.value
  const q = search.value.toLowerCase()
  return students.value.filter(s => s.displayName?.toLowerCase().includes(q))
})

const sortedStudents = computed(() =>
  [...filtered.value].sort((a, b) => (b.coins || 0) - (a.coins || 0))
)

function openAward(student) {
  awardTarget.value = student
  bulkMode.value = false
  awardAmount.value = 10
  awardNote.value = ''
  awardSubject.value = teacherSubjects.value[0]?.name || ''
  showAward.value = true
}

function openBulkAward() {
  awardTarget.value = null
  bulkMode.value = true
  selectedIds.value = []
  awardAmount.value = 10
  awardNote.value = ''
  awardSubject.value = teacherSubjects.value[0]?.name || ''
  showAward.value = true
}

function toggleSelect(id) {
  const idx = selectedIds.value.indexOf(id)
  if (idx >= 0) selectedIds.value.splice(idx, 1)
  else selectedIds.value.push(id)
}

function selectAll() {
  if (selectedIds.value.length === students.value.length) selectedIds.value = []
  else selectedIds.value = students.value.map(s => s.id)
}

async function doAward() {
  if (!awardAmount.value || awardAmount.value < 1) { error('Введіть правильну суму'); return }

  const targets = bulkMode.value
    ? students.value.filter(s => selectedIds.value.includes(s.id))
    : [awardTarget.value]

  const total = targets.length * Number(awardAmount.value)
  const { remaining } = getTeacherBudgetInfo(auth.profile)
  if (total > remaining) {
    error(`Недостатньо бюджету. Потрібно ${total} 🪙, залишок цього тижня: ${remaining} 🪙`)
    return
  }

  awarding.value = true
  try {
    const noteText = [awardSubject.value, awardNote.value].filter(Boolean).join(' — ')
    // Sequential to respect budget atomically — avoids race conditions
    for (const s of targets) {
      await awardCoins({ fromUid: auth.profile.id, toUid: s.id, amount: Number(awardAmount.value), note: noteText })
    }
    await Promise.all(targets.map(s => checkAndGrantAchievements(s.id)))

    hapticCoin()
    success(`🪙 +${awardAmount.value} нараховано ${targets.length} учн${targets.length === 1 ? 'ю' : 'ям'}!`)
    showAward.value = false
    students.value = await getUsersByClass(route.params.id)
  } catch (e) {
    error(e.message)
  } finally {
    awarding.value = false
  }
}

const QUICK_AMOUNTS = [5, 10, 25, 50, 100]
const FINE_AMOUNTS  = [5, 10, 25, 50]

const budgetInfo = computed(() => getTeacherBudgetInfo(auth.profile))
const totalCost  = computed(() => {
  const count = bulkMode.value ? selectedIds.value.length : 1
  return count * (Number(awardAmount.value) || 0)
})
const budgetOk = computed(() => totalCost.value <= budgetInfo.value.remaining)

// ── Fine state ───────────────────────────────────────────────────────────────
const showFine  = ref(false)
const fineTarget = ref(null)
const fineAmount = ref(10)
const fineReason = ref('')
const fining    = ref(false)

function openFine(student) {
  fineTarget.value = student
  fineAmount.value = 10
  fineReason.value = ''
  showFine.value   = true
}

async function doFine() {
  if (!fineAmount.value || fineAmount.value < 1) { error('Введіть суму штрафу'); return }
  if (!fineReason.value.trim()) { error('Вкажіть причину штрафу'); return }
  fining.value = true
  try {
    await fineStudent({
      fromUid: auth.profile.id,
      toUid:   fineTarget.value.id,
      amount:  Number(fineAmount.value),
      reason:  fineReason.value.trim(),
    })
    success(`Штраф ${fineAmount.value} монет для ${fineTarget.value.displayName}`)
    showFine.value = false
    students.value = await getUsersByClass(route.params.id)
  } catch (e) {
    error(e.message)
  } finally {
    fining.value = false
  }
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <!-- Header -->
    <div class="flex flex-col gap-3">
      <div class="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div class="flex items-center gap-2">
            <span class="text-3xl">{{ classData?.icon || '🏫' }}</span>
            <h1 class="text-2xl font-extrabold">{{ classData?.name }}</h1>
          </div>
          <p class="text-slate-400 text-sm mt-1">{{ students.length }} учнів</p>
        </div>
        <AppButton variant="coin" @click="openBulkAward">
          <Coins :size="14" :stroke-width="2" /> Нарахувати класу
        </AppButton>
      </div>

      <!-- Weekly budget meter -->
      <div class="glass-card p-3 flex flex-col gap-2">
        <div class="flex items-center justify-between text-sm">
          <span class="font-bold text-slate-300 flex items-center gap-1.5">
            <Wallet :size="14" :stroke-width="2" class="text-amber-400" /> Тижневий бюджет
          </span>
          <span class="font-extrabold" :class="budgetInfo.remaining < 50 ? 'text-red-400' : budgetInfo.remaining < 150 ? 'text-amber-400' : 'text-emerald-400'">
            <span class="flex items-center gap-1">
              {{ budgetInfo.remaining }} / {{ budgetInfo.budget }}
              <Coins :size="12" :stroke-width="2" />
            </span>
          </span>
        </div>
        <div class="h-2 bg-game-bg rounded-full overflow-hidden">
          <div
            class="h-full rounded-full transition-all duration-500"
            :class="budgetInfo.remaining < 50 ? 'bg-red-500' : budgetInfo.remaining < 150 ? 'bg-amber-500' : 'bg-emerald-500'"
            :style="{ width: Math.round((budgetInfo.remaining / budgetInfo.budget) * 100) + '%' }"
          />
        </div>
        <div v-if="budgetInfo.remaining === 0" class="text-xs text-red-400 font-bold text-center">
          Бюджет вичерпано. Оновлення в понеділок.
        </div>
      </div>
    </div>

    <!-- Search -->
    <input
      v-model="search"
      placeholder="🔍 Пошук учня..."
      class="w-full bg-game-card border border-game-border rounded-xl px-4 py-2.5 text-sm font-semibold text-white placeholder-slate-500 focus:outline-none focus:border-violet-500"
    />

    <div class="flex flex-col gap-3">
      <div
        v-for="(s, i) in sortedStudents"
        :key="s.id"
        class="glass-card flex items-center gap-3 p-4 cursor-pointer hover:border-violet-500/40 transition-all"
        @click="router.push(`/room/${s.id}`)"
      >
        <!-- Rank -->
        <div class="w-7 text-center font-extrabold text-sm flex-shrink-0"
          :class="i === 0 ? 'text-amber-400' : i === 1 ? 'text-slate-300' : i === 2 ? 'text-amber-700' : 'text-slate-500'">
          {{ i + 1 }}
        </div>

        <AvatarDisplay :avatar="s.avatar" :display-name="s.displayName" size="sm" />

        <div class="flex-1 min-w-0">
          <div class="font-bold truncate">{{ s.displayName }}</div>
          <div class="flex items-center gap-1 text-xs text-slate-400">
            Рів.{{ s.level }}
            <span class="flex items-center gap-0.5 ml-1">
              <Flame :size="11" :stroke-width="2" class="text-orange-400" />{{ s.streak }}
            </span>
          </div>
        </div>

        <CoinDisplay :amount="s.coins || 0" size="sm" />

        <button
          class="flex items-center justify-center w-8 h-8 rounded-xl text-violet-400 hover:text-violet-300 hover:bg-violet-500/10 transition-all"
          title="Переглянути кімнату"
          @click.stop="router.push(`/room/${s.id}`)"
        >
          <LayoutDashboard :size="15" :stroke-width="1.8" />
        </button>

        <AppButton variant="coin" size="sm" @click.stop="openAward(s)" title="Нарахувати монети">
          <Coins :size="13" :stroke-width="2.2" />
        </AppButton>

        <button
          class="flex items-center justify-center w-8 h-8 rounded-xl text-red-400/70 hover:text-red-400 hover:bg-red-500/10 transition-all flex-shrink-0"
          title="Штраф"
          @click.stop="openFine(s)"
        >
          <Gavel :size="14" :stroke-width="2" />
        </button>
      </div>
    </div>

    <!-- Award modal -->
    <AppModal v-model="showAward" :title="bulkMode ? 'Нарахувати всьому класу' : `Нарахувати: ${awardTarget?.displayName}`">
      <div class="flex flex-col gap-4">
        <!-- Bulk select -->
        <div v-if="bulkMode">
          <div class="flex items-center justify-between mb-2">
            <label class="text-sm font-bold text-slate-300">Оберіть учнів</label>
            <button class="text-xs text-violet-400 font-bold" @click="selectAll">
              {{ selectedIds.length === students.length ? 'Зняти вибір' : 'Вибрати всіх' }}
            </button>
          </div>
          <div class="max-h-48 overflow-y-auto flex flex-col gap-2">
            <label
              v-for="s in students"
              :key="s.id"
              class="flex items-center gap-3 glass-card p-2 cursor-pointer"
              :class="selectedIds.includes(s.id) ? 'border-violet-500' : ''"
            >
              <input type="checkbox" :checked="selectedIds.includes(s.id)" @change="toggleSelect(s.id)" class="accent-violet-500 w-4 h-4" />
              <AvatarDisplay :avatar="s.avatar" :display-name="s.displayName" size="xs" />
              <span class="font-semibold text-sm">{{ s.displayName }}</span>
              <CoinDisplay :amount="s.coins || 0" size="sm" class="ml-auto" />
            </label>
          </div>
          <div class="text-xs text-slate-400 mt-1">{{ selectedIds.length }} обрано</div>
        </div>

        <!-- Subject selector -->
        <div v-if="teacherSubjects.length > 0">
          <label class="text-sm font-bold text-slate-300 block mb-2">Предмет</label>
          <div class="flex flex-wrap gap-2">
            <button
              v-for="subj in teacherSubjects"
              :key="subj.id"
              class="flex items-center gap-1.5 px-3 py-1.5 rounded-xl font-bold text-sm transition-all"
              :class="awardSubject === subj.name
                ? 'bg-violet-600 text-white'
                : 'bg-game-card text-slate-400 hover:text-white'"
              @click="awardSubject = awardSubject === subj.name ? '' : subj.name"
            >
              <SubjectIcon :icon="subj.icon || getSubjectIcon(subj.name)" size="1rem" />
              {{ subj.name }}
            </button>
          </div>
        </div>

        <!-- Amount -->
        <div>
          <label class="text-sm font-bold text-slate-300 flex items-center gap-1.5 mb-2">
            Сума <Coins :size="13" :stroke-width="2" class="text-coin" />
          </label>
          <div class="flex gap-2 flex-wrap mb-3">
            <button
              v-for="a in QUICK_AMOUNTS"
              :key="a"
              class="px-4 py-2 rounded-xl font-bold text-sm transition-all"
              :class="awardAmount === a ? 'bg-amber-500 text-slate-900' : 'bg-game-card text-slate-300 hover:bg-game-border'"
              @click="awardAmount = a"
            >+{{ a }}</button>
          </div>
          <input
            v-model="awardAmount"
            type="number"
            min="1"
            class="w-full bg-game-bg border border-game-border rounded-xl px-4 py-3 text-center text-2xl font-extrabold text-amber-400 focus:outline-none focus:border-amber-500"
          />
        </div>

        <AppInput v-model="awardNote" label="Коментар (необов'язково)" placeholder="напр. Відмінна домашня робота!" />

        <!-- Budget summary row -->
        <div class="flex items-center justify-between rounded-xl px-3 py-2 text-sm"
          :class="budgetOk ? 'bg-emerald-500/10 border border-emerald-500/20' : 'bg-red-500/10 border border-red-500/30'">
          <span class="text-slate-400">Вартість нарахування</span>
          <div class="flex items-center gap-2 font-extrabold">
            <CoinDisplay :amount="totalCost" size="sm" :class="budgetOk ? '' : 'opacity-60'" />
            <span class="text-slate-500 text-xs">/ залишок {{ budgetInfo.remaining }}</span>
          </div>
        </div>

        <AppButton
          variant="coin"
          size="lg"
          block
          :loading="awarding"
          :disabled="(bulkMode && selectedIds.length === 0) || !budgetOk"
          @click="doAward"
        >
          <Coins :size="14" :stroke-width="2" /> Нарахувати {{ awardAmount }} монет{{ bulkMode ? ` ${selectedIds.length} учням` : '' }}
        </AppButton>
      </div>
    </AppModal>

    <!-- Fine modal -->
    <AppModal v-model="showFine" :title="`Штраф: ${fineTarget?.displayName}`">
      <div class="flex flex-col gap-4">

        <!-- Warning banner -->
        <div class="flex items-start gap-2.5 rounded-2xl p-3" style="background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.18)">
          <Gavel :size="16" :stroke-width="2" class="text-red-400 flex-shrink-0 mt-0.5" />
          <div class="text-xs text-red-300">
            Монети будуть знято з балансу учня і повернуті до твого тижневого бюджету.
          </div>
        </div>

        <!-- Student current balance -->
        <div class="flex items-center justify-between rounded-xl px-3 py-2 bg-white/[0.04]">
          <span class="text-sm text-slate-400">Баланс учня</span>
          <CoinDisplay :amount="fineTarget?.coins || 0" size="sm" />
        </div>

        <!-- Amount -->
        <div>
          <label class="text-sm font-bold text-slate-300 flex items-center gap-1.5 mb-2">
            Сума штрафу <Coins :size="13" :stroke-width="2" class="text-red-400" />
          </label>
          <div class="flex gap-2 flex-wrap mb-3">
            <button
              v-for="a in FINE_AMOUNTS"
              :key="a"
              class="px-4 py-2 rounded-xl font-bold text-sm transition-all"
              :class="fineAmount === a ? 'bg-red-600 text-white' : 'bg-game-card text-slate-300 hover:bg-game-border'"
              @click="fineAmount = a"
            >−{{ a }}</button>
          </div>
          <input
            v-model="fineAmount"
            type="number"
            min="1"
            :max="fineTarget?.coins || 9999"
            class="w-full bg-game-bg border border-red-500/30 rounded-xl px-4 py-3 text-center text-2xl font-extrabold text-red-400 focus:outline-none focus:border-red-500"
          />
        </div>

        <!-- Reason (required) -->
        <AppInput
          v-model="fineReason"
          label="Причина штрафу *"
          placeholder="напр. Зривав урок, не виконав завдання..."
        />

        <AppButton
          variant="danger"
          size="lg"
          block
          :loading="fining"
          :disabled="!fineReason.trim()"
          @click="doFine"
        >
          <Gavel :size="14" :stroke-width="2" /> Накласти штраф −{{ fineAmount }}
        </AppButton>
      </div>
    </AppModal>
  </div>
</template>
