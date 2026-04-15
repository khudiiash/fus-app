<script setup>
import { ref, onMounted, onUnmounted, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useUserStore } from '@/stores/user'
import {
  watchClass,
  getUsersByClass,
  awardCoins,
  fineStudent,
  checkAndGrantAchievements,
  getAllSubjects,
  getTeacherBudgetInfo,
  FINE_AMOUNT_OPTIONS,
  hasTeacherFinedStudentToday,
} from '@/firebase/collections'
import { getSubjectIcon } from '@/composables/useSubjectIcon'
import AppButton from '@/components/ui/AppButton.vue'
import AppModal from '@/components/ui/AppModal.vue'
import AppInput from '@/components/ui/AppInput.vue'
import SubjectIcon from '@/components/ui/SubjectIcon.vue'
import AvatarDisplay from '@/components/avatar/AvatarDisplay.vue'
import CoinDisplay from '@/components/gamification/CoinDisplay.vue'
import { useToast } from '@/composables/useToast'
import { useHaptic } from '@/composables/useHaptic'
import {
  Coins,
  Wallet,
  Flame,
  Gavel,
} from 'lucide-vue-next'

const route  = useRoute()
const router = useRouter()
const auth      = useAuthStore()
const userStore = useUserStore()
const { success, error } = useToast()
const { coin: hapticCoin } = useHaptic()

const classData   = ref(null)
const students    = ref([])
const showAward   = ref(false)
const awardTarget = ref(null)
const bulkMode    = ref(false)
/** У модалці «нарахувати класу» — чекбокси */
const bulkModalIds = ref([])
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
  if (!userStore.items.length) await userStore.fetchItems()
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

function openBulkAward() {
  awardTarget.value = null
  bulkMode.value = true
  bulkModalIds.value = []
  awardAmount.value = 10
  awardNote.value = ''
  awardSubject.value = teacherSubjects.value[0]?.name || ''
  showAward.value = true
}

function toggleBulkModal(id) {
  const idx = bulkModalIds.value.indexOf(id)
  if (idx >= 0) bulkModalIds.value.splice(idx, 1)
  else bulkModalIds.value.push(id)
}

function selectAllInModal() {
  if (bulkModalIds.value.length === students.value.length) bulkModalIds.value = []
  else bulkModalIds.value = students.value.map(s => s.id)
}

async function doAward() {
  if (!awardAmount.value || awardAmount.value < 1) { error('Введіть правильну суму'); return }

  let targets
  if (!bulkMode.value) {
    targets = awardTarget.value ? [awardTarget.value] : []
  } else {
    targets = students.value.filter((s) => bulkModalIds.value.includes(s.id))
  }

  if (!targets.length) {
    error('Оберіть учнів у списку')
    return
  }

  const total = targets.length * Number(awardAmount.value)
  const { remaining } = getTeacherBudgetInfo(auth.profile)
  if (total > remaining) {
    error(`Недостатньо бюджету. Потрібно ${total} 🪙, залишок на сьогодні: ${remaining} 🪙`)
    return
  }

  awarding.value = true
  try {
    const subj = (awardSubject.value || '').trim()
    const comment = (awardNote.value || '').trim()
    // Sequential to respect budget atomically — avoids race conditions
    for (const s of targets) {
      await awardCoins({
        fromUid: auth.profile.id,
        toUid: s.id,
        amount: Number(awardAmount.value),
        note: comment,
        subjectName: subj,
      })
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

const budgetInfo = computed(() => getTeacherBudgetInfo(auth.profile))
const budgetLowThresh = computed(() => Math.max(15, Math.round((budgetInfo.value.budget || 1) * 0.1)))
const budgetMidThresh = computed(() => Math.max(50, Math.round((budgetInfo.value.budget || 1) * 0.35)))
const awardRecipientCount = computed(() => {
  if (!bulkMode.value) return awardTarget.value ? 1 : 0
  return bulkModalIds.value.length
})

const totalCost  = computed(() => awardRecipientCount.value * (Number(awardAmount.value) || 0))

const awardModalTitle = computed(() => {
  if (!bulkMode.value) return `Нарахувати: ${awardTarget.value?.displayName || ''}`
  return 'Нарахувати класу'
})
const budgetOk = computed(() => totalCost.value <= budgetInfo.value.remaining)

// ── Fine state ───────────────────────────────────────────────────────────────
const showFine  = ref(false)
/** У модалці штрафу — чекбокси */
const fineModalIds = ref([])
const fineAmount = ref(10)
const fineReason = ref('')
const fining    = ref(false)

const fineModalTitle = computed(() => 'Штраф класу')

const fineModalTargets = computed(() =>
  students.value.filter((s) => fineModalIds.value.includes(s.id)),
)

const fineSelectedMinCoins = computed(() => {
  if (!fineModalTargets.value.length) return null
  return Math.min(...fineModalTargets.value.map((s) => s.coins || 0))
})

function openBulkFine() {
  fineModalIds.value = []
  fineAmount.value = 20
  fineReason.value = ''
  showFine.value = true
}

function toggleFineModal(id) {
  const idx = fineModalIds.value.indexOf(id)
  if (idx >= 0) fineModalIds.value.splice(idx, 1)
  else fineModalIds.value.push(id)
}

function selectAllFineInModal() {
  if (fineModalIds.value.length === students.value.length) fineModalIds.value = []
  else fineModalIds.value = students.value.map(s => s.id)
}

async function doFine() {
  const amt = Number(fineAmount.value)
  if (!FINE_AMOUNT_OPTIONS.includes(amt)) {
    error('Оберіть суму штрафу: 10, 20 або 30 монет')
    return
  }
  if (!fineReason.value.trim()) { error('Вкажіть причину штрафу'); return }

  const targets = students.value.filter((s) => fineModalIds.value.includes(s.id))

  if (!targets.length) {
    error('Оберіть учнів у списку')
    return
  }

  for (const s of targets) {
    if (await hasTeacherFinedStudentToday(auth.profile.id, s.id)) {
      error(`Сьогодні штраф для «${s.displayName || 'учня'}» вже накладено`)
      return
    }
  }

  fining.value = true
  try {
    const reason = fineReason.value.trim()
    for (const s of targets) {
      await fineStudent({
        fromUid: auth.profile.id,
        toUid: s.id,
        amount: amt,
        reason,
      })
    }
    if (targets.length === 1) {
      success(`Штраф ${amt} монет для ${targets[0].displayName}`)
    } else {
      success(`Штраф до ${amt} монет накладено для ${targets.length} учнів`)
    }
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
  <div class="flex flex-col gap-2.5 pb-6">
    <!-- Header -->
    <div class="flex flex-col gap-2">
      <div class="flex items-start justify-between gap-2 flex-wrap">
        <div class="min-w-0">
          <div class="flex items-center gap-1.5">
            <span class="text-2xl shrink-0">{{ classData?.icon || '🏫' }}</span>
            <h1 class="text-lg font-extrabold leading-tight [overflow-wrap:anywhere]">{{ classData?.name }}</h1>
          </div>
          <p class="text-slate-400 text-xs mt-0.5">{{ students.length }} учнів</p>
        </div>
        <div class="flex flex-wrap items-center gap-1.5 shrink-0 justify-end">
          <AppButton
            variant="secondary"
            size="sm"
            class="!border !border-red-500/45 !bg-red-600/15 !text-red-100 hover:!bg-red-600/25 hover:!border-red-400/55"
            @click="openBulkFine"
          >
            <Gavel :size="14" :stroke-width="2" />
            Штраф класу
          </AppButton>
          <AppButton variant="coin" size="sm" @click="openBulkAward">
            <Coins :size="14" :stroke-width="2" /> Нарахувати класу
          </AppButton>
        </div>
      </div>

      <!-- Daily budget meter -->
      <div class="glass-card p-2.5 flex flex-col gap-1.5">
        <div class="flex items-center justify-between text-xs">
          <span class="font-bold text-slate-300 flex items-center gap-1">
            <Wallet :size="13" :stroke-width="2" class="text-amber-400" /> Денний бюджет
          </span>
          <span
            class="font-extrabold"
            :class="budgetInfo.remaining <= budgetLowThresh ? 'text-red-400' : budgetInfo.remaining <= budgetMidThresh ? 'text-amber-400' : 'text-emerald-400'"
          >
            <span class="flex items-center gap-0.5 tabular-nums">
              {{ budgetInfo.remaining }} / {{ budgetInfo.budget }}
              <Coins :size="11" :stroke-width="2" />
            </span>
          </span>
        </div>
        <div class="h-1.5 bg-game-bg rounded-full overflow-hidden">
          <div
            class="h-full rounded-full transition-all duration-500"
            :class="budgetInfo.remaining <= budgetLowThresh ? 'bg-red-500' : budgetInfo.remaining <= budgetMidThresh ? 'bg-amber-500' : 'bg-emerald-500'"
            :style="{ width: Math.round((budgetInfo.remaining / budgetInfo.budget) * 100) + '%' }"
          />
        </div>
        <div v-if="budgetInfo.remaining === 0" class="text-xs text-red-400 font-bold text-center">
          Бюджет на сьогодні вичерпано. Ліміт оновиться завтра.
        </div>
      </div>
    </div>

    <!-- Search -->
    <input
      v-model="search"
      placeholder="🔍 Пошук учня..."
      class="w-full bg-game-card border border-game-border rounded-lg px-3 py-2 text-xs font-semibold text-white placeholder-slate-500 focus:outline-none focus:border-violet-500"
    />

    <div class="flex flex-col gap-2">
      <div
        v-for="(s, i) in sortedStudents"
        :key="s.id"
        class="glass-card flex gap-2 items-center p-2 rounded-xl border border-white/[0.06] hover:border-violet-500/35 transition-all cursor-pointer text-left w-full"
        role="link"
        tabindex="0"
        @click="router.push(`/teacher/student/${s.id}/profile`)"
        @keydown.enter.prevent="router.push(`/teacher/student/${s.id}/profile`)"
        @keydown.space.prevent="router.push(`/teacher/student/${s.id}/profile`)"
      >
        <div
          class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-xs font-black tabular-nums relative"
          :class="
            i === 0
              ? 'bg-amber-500/15 text-amber-400 ring-1 ring-amber-500/25'
              : i === 1
                ? 'bg-slate-400/10 text-slate-300 ring-1 ring-slate-400/20'
                : i === 2
                  ? 'bg-amber-800/20 text-amber-600 ring-1 ring-amber-700/25'
                  : 'bg-white/[0.04] text-slate-500'
          "
        >
          {{ i + 1 }}
        </div>

        <AvatarDisplay
          circle-only
          :avatar="s.avatar"
          :display-name="s.displayName || ''"
          :items="userStore.items"
          size="sm"
          class="shrink-0 pointer-events-none"
        />
        <div class="min-w-0 flex-1">
          <div
            class="font-bold text-sm leading-tight text-white [overflow-wrap:anywhere] line-clamp-2 min-w-0"
          >
            {{ s.displayName }}
          </div>
          <div
            class="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] font-semibold text-slate-400"
          >
            <span>Рів. {{ s.level ?? 1 }}</span>
            <span class="inline-flex items-center gap-0.5 text-orange-300/90">
              <Flame :size="11" :stroke-width="2" class="shrink-0" />
              {{ s.streak ?? 0 }}
            </span>
            <CoinDisplay :amount="s.coins || 0" size="sm" />
          </div>
        </div>
      </div>
    </div>

    <!-- Award modal -->
    <AppModal v-model="showAward" :title="awardModalTitle">
      <div class="flex flex-col gap-3">
        <div v-if="bulkMode">
          <div class="flex items-center justify-between mb-2">
            <label class="text-sm font-bold text-slate-300">Оберіть учнів</label>
            <button type="button" class="text-xs text-violet-400 font-bold" @click="selectAllInModal">
              {{ bulkModalIds.length === students.length ? 'Зняти вибір' : 'Вибрати всіх' }}
            </button>
          </div>
          <div class="max-h-48 overflow-y-auto flex flex-col gap-2">
            <label
              v-for="s in students"
              :key="s.id"
              class="flex items-center gap-3 glass-card p-2 cursor-pointer rounded-xl border"
              :class="bulkModalIds.includes(s.id) ? 'border-violet-500' : 'border-transparent'"
            >
              <input
                type="checkbox"
                :checked="bulkModalIds.includes(s.id)"
                class="accent-violet-500 w-4 h-4 shrink-0"
                @change="toggleBulkModal(s.id)"
              />
              <AvatarDisplay :avatar="s.avatar" :display-name="s.displayName" size="xs" />
              <span class="font-semibold text-sm truncate">{{ s.displayName }}</span>
              <CoinDisplay :amount="s.coins || 0" size="sm" class="ml-auto shrink-0" />
            </label>
          </div>
          <div class="text-xs text-slate-400 mt-1">{{ bulkModalIds.length }} обрано</div>
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
          size="md"
          block
          :loading="awarding"
          :disabled="awardRecipientCount === 0 || !budgetOk"
          @click="doAward"
        >
          <Coins :size="14" :stroke-width="2" />
          Нарахувати {{ awardAmount }} монет
          <template v-if="bulkMode && awardRecipientCount > 0">
            ({{ awardRecipientCount }})
          </template>
        </AppButton>
      </div>
    </AppModal>

    <!-- Fine modal -->
    <AppModal v-model="showFine" :title="fineModalTitle">
      <div class="flex flex-col gap-3">

        <!-- Warning banner -->
        <div class="flex items-start gap-2.5 rounded-2xl p-3" style="background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.18)">
          <Gavel :size="16" :stroke-width="2" class="text-red-400 flex-shrink-0 mt-0.5" />
          <div class="text-xs text-red-300">
            Кожному з обраних зніметься до {{ fineAmount }} монет (не більше його балансу). Монети повернуться до твого денного бюджету.
          </div>
        </div>

        <div>
          <div class="flex items-center justify-between mb-2">
            <label class="text-sm font-bold text-slate-300">Оберіть учнів</label>
            <button type="button" class="text-xs text-violet-400 font-bold" @click="selectAllFineInModal">
              {{ fineModalIds.length === students.length ? 'Зняти вибір' : 'Вибрати всіх' }}
            </button>
          </div>
          <div class="max-h-48 overflow-y-auto flex flex-col gap-2">
            <label
              v-for="s in students"
              :key="s.id"
              class="flex items-center gap-3 glass-card p-2 cursor-pointer rounded-xl border"
              :class="fineModalIds.includes(s.id) ? 'border-red-500/60' : 'border-transparent'"
            >
              <input
                type="checkbox"
                :checked="fineModalIds.includes(s.id)"
                class="accent-red-500 w-4 h-4 shrink-0"
                @change="toggleFineModal(s.id)"
              />
              <AvatarDisplay :avatar="s.avatar" :display-name="s.displayName" size="xs" />
              <span class="font-semibold text-sm truncate">{{ s.displayName }}</span>
              <CoinDisplay :amount="s.coins || 0" size="sm" class="ml-auto shrink-0" />
            </label>
          </div>
          <div v-if="fineSelectedMinCoins !== null" class="text-xs text-slate-500 mt-1">
            Найменший баланс серед обраних: {{ fineSelectedMinCoins }} 🪙
          </div>
          <div class="text-xs text-slate-400 mt-1">{{ fineModalIds.length }} обрано</div>
        </div>

        <!-- Amount -->
        <div>
          <label class="text-sm font-bold text-slate-300 flex items-center gap-1.5 mb-2">
            Сума штрафу <Coins :size="13" :stroke-width="2" class="text-red-400" />
          </label>
          <div class="flex gap-2 flex-wrap">
            <button
              v-for="a in FINE_AMOUNT_OPTIONS"
              :key="a"
              type="button"
              class="px-4 py-2 rounded-xl font-bold text-sm transition-all"
              :class="fineAmount === a ? 'bg-red-600 text-white' : 'bg-game-card text-slate-300 hover:bg-game-border'"
              @click="fineAmount = a"
            >
              −{{ a }}
            </button>
          </div>
        </div>

        <!-- Reason (required) -->
        <AppInput
          v-model="fineReason"
          label="Причина штрафу *"
          placeholder="напр. Зривав урок, не виконав завдання..."
        />

        <AppButton
          variant="danger"
          size="md"
          block
          :loading="fining"
          :disabled="!fineReason.trim() || fineModalIds.length === 0"
          @click="doFine"
        >
          <Gavel :size="14" :stroke-width="2" />
          Накласти штраф обраним ({{ fineModalIds.length }}× −{{ fineAmount }})
        </AppButton>
      </div>
    </AppModal>
  </div>
</template>
