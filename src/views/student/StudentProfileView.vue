<script setup>
import { ref, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useUserStore } from '@/stores/user'
import { useGameification } from '@/composables/useGameification'
import AvatarBuilder from '@/components/avatar/AvatarBuilder.vue'
import CharacterScene from '@/components/character/CharacterScene.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppModal from '@/components/ui/AppModal.vue'
import AppInput from '@/components/ui/AppInput.vue'
import SubjectIcon from '@/components/ui/SubjectIcon.vue'
import HistoryTransactionCard from '@/components/feed/HistoryTransactionCard.vue'
import CoinDisplay from '@/components/gamification/CoinDisplay.vue'
import { useToast } from '@/composables/useToast'
import { useHaptic } from '@/composables/useHaptic'
import { getSubjectIcon } from '@/composables/useSubjectIcon'
import { enrichStudentFeedTransactions } from '@/composables/useTransactionFeed'
import {
  Star,
  Coins,
  Flame,
  Award,
  Package,
  LogOut,
  ArrowRight,
  Palette,
  GraduationCap,
  Activity,
  ArrowLeft,
  User,
  Gavel,
  ScrollText,
} from 'lucide-vue-next'
import { currentAccent, setAccent, ACCENT_PRESETS } from '@/composables/useAccentColor'
import {
  getUser,
  teacherMayAccessStudentProfile,
  studentMayAccessStudentProfile,
  getStudentActivityTransactions,
  aggregateStudentAwardCoinsBySubject,
  getAllSubjects,
  awardCoins,
  fineStudent,
  checkAndGrantAchievements,
  getTeacherBudgetInfo,
  FINE_AMOUNT_OPTIONS,
  hasTeacherFinedStudentToday,
} from '@/firebase/collections'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const userStore = useUserStore()
const { success, error } = useToast()
const { coin: hapticCoin } = useHaptic()

const viewUid = computed(() => {
  if (route.name === 'teacher-student-profile') return String(route.params.studentId || '')
  if (route.name === 'student-profile-peer') return String(route.params.uid || '')
  if (route.name === 'student-profile') return String(auth.profile?.id || '')
  return ''
})

const viewedStudent = ref(null)
const loading = ref(true)
const forbidden = ref(false)
const subjectCoins = ref([])
const history = ref([])
const teacherSubjects = ref([])

const profileRef = computed(() => viewedStudent.value)
const { level, coins, streak, xpProgress } = useGameification(profileRef)

const isOwnProfile = computed(
  () => !!viewedStudent.value?.id && viewedStudent.value.id === auth.profile?.id,
)
const isTeacherViewer = computed(() => auth.profile?.role === 'teacher')
const showStudentSettings = computed(
  () => isOwnProfile.value && auth.profile?.role === 'student',
)
const showTeacherActions = computed(
  () => isTeacherViewer.value && !forbidden.value && !!viewedStudent.value,
)

const pageTitle = computed(() => {
  if (forbidden.value) return 'Профіль'
  if (isOwnProfile.value) return 'Мій профіль'
  return viewedStudent.value?.displayName || 'Профіль учня'
})

async function loadProfile() {
  loading.value = true
  forbidden.value = false
  viewedStudent.value = null
  subjectCoins.value = []
  history.value = []

  const uid = viewUid.value
  if (!uid) {
    forbidden.value = true
    loading.value = false
    return
  }

  try {
    const s = await getUser(uid)
    if (!s || s.role !== 'student') {
      forbidden.value = true
      return
    }
    if (isTeacherViewer.value) {
      if (!teacherMayAccessStudentProfile(auth.profile, s)) {
        forbidden.value = true
        return
      }
      const subjIds = auth.profile?.subjectIds || []
      if (subjIds.length) {
        const all = await getAllSubjects()
        teacherSubjects.value = all.filter((x) => subjIds.includes(x.id))
      } else {
        teacherSubjects.value = []
      }
    } else if (auth.profile?.role === 'student') {
      if (uid !== auth.profile.id && !studentMayAccessStudentProfile(auth.profile, s)) {
        forbidden.value = true
        return
      }
    } else {
      forbidden.value = true
      return
    }

    viewedStudent.value = s
    if (!userStore.items.length) await userStore.fetchItems()

    const [raw, subj] = await Promise.all([
      getStudentActivityTransactions(uid, 80),
      aggregateStudentAwardCoinsBySubject(uid),
    ])
    subjectCoins.value = subj
    history.value = await enrichStudentFeedTransactions(raw, uid)
  } catch (e) {
    console.warn('[StudentProfileView]', e)
    forbidden.value = true
  } finally {
    loading.value = false
  }
}

watch(
  viewUid,
  (uid) => {
    if (uid) void loadProfile()
  },
  { immediate: true },
)

function goRoom() {
  const uid = viewUid.value
  if (isTeacherViewer.value) router.push(`/teacher/room/${uid}`)
  else if (isOwnProfile.value) router.push('/student/room')
  else router.push(`/student/room/${uid}`)
}

function totalInventoryUnits(p) {
  if (!p) return 0
  const inv = p.inventory || []
  const iq = p.inventoryCounts || {}
  let n = 0
  for (const id of inv) n += iq[id] || 1
  const mb = p.mysteryBoxCounts || {}
  for (const c of Object.values(mb)) n += Number(c) || 0
  return n
}

const stats = computed(() => {
  const p = viewedStudent.value
  return [
    { label: 'Рівень', value: level.value, Icon: Star, color: 'text-accent', bg: 'bg-violet-500/[0.1]' },
    { label: 'Монети', value: coins.value.toLocaleString(), Icon: Coins, color: 'text-amber-400', bg: 'bg-amber-500/[0.1]' },
    { label: 'Серія', value: streak.value + 'д', Icon: Flame, color: 'text-orange-400', bg: 'bg-orange-500/[0.1]' },
    { label: 'Нагороди', value: (p?.badges || []).length, Icon: Award, color: 'text-blue-400', bg: 'bg-blue-500/[0.1]' },
    { label: 'Предмети', value: totalInventoryUnits(p), Icon: Package, color: 'text-emerald-400', bg: 'bg-emerald-500/[0.1]' },
  ]
})

function formatDate(ts) {
  if (!ts) return ''
  const d = ts.toDate ? ts.toDate() : new Date(ts)
  return d.toLocaleDateString('uk-UA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

async function logout() {
  await auth.logout()
  router.push('/login')
}

// ── Teacher: нарахувати / штраф (один учень) ───────────────────────────────
const showAward = ref(false)
const showFine = ref(false)
const awardAmount = ref(10)
const awardNote = ref('')
const awardSubject = ref('')
const awarding = ref(false)
const fineAmount = ref(20)
const fineReason = ref('')
const fining = ref(false)
const QUICK_AMOUNTS = [5, 10, 25, 50, 100]
const budgetInfo = computed(() => getTeacherBudgetInfo(auth.profile))
const budgetOk = computed(() => (Number(awardAmount.value) || 0) <= budgetInfo.value.remaining)

function openAwardModal() {
  awardAmount.value = 10
  awardNote.value = ''
  awardSubject.value = teacherSubjects.value[0]?.name || ''
  showAward.value = true
}

function openFineModal() {
  fineAmount.value = 20
  fineReason.value = ''
  showFine.value = true
}

async function doAward() {
  const uid = viewUid.value
  const amt = Number(awardAmount.value)
  if (!amt || amt < 1) {
    error('Введіть правильну суму')
    return
  }
  const { remaining } = getTeacherBudgetInfo(auth.profile)
  if (amt > remaining) {
    error(`Недостатньо бюджету. Залишок: ${remaining} 🪙`)
    return
  }
  awarding.value = true
  try {
    const subj = (awardSubject.value || '').trim()
    const comment = (awardNote.value || '').trim()
    await awardCoins({
      fromUid: auth.profile.id,
      toUid: uid,
      amount: amt,
      note: comment,
      subjectName: subj,
    })
    await checkAndGrantAchievements(uid)
    hapticCoin()
    success(`🪙 +${amt} нараховано`)
    showAward.value = false
    await loadProfile()
  } catch (e) {
    error(e?.message || 'Помилка')
  } finally {
    awarding.value = false
  }
}

async function doFine() {
  const uid = viewUid.value
  const amt = Number(fineAmount.value)
  if (!FINE_AMOUNT_OPTIONS.includes(amt)) {
    error('Оберіть суму штрафу: 10, 20 або 30 монет')
    return
  }
  if (!fineReason.value.trim()) {
    error('Вкажіть причину штрафу')
    return
  }
  if (await hasTeacherFinedStudentToday(auth.profile.id, uid)) {
    error('Сьогодні штраф для цього учня вже накладено')
    return
  }
  fining.value = true
  try {
    await fineStudent({
      fromUid: auth.profile.id,
      toUid: uid,
      amount: amt,
      reason: fineReason.value.trim(),
    })
    success(`Штраф ${amt} монет накладено`)
    showFine.value = false
    await loadProfile()
  } catch (e) {
    error(e?.message || 'Помилка')
  } finally {
    fining.value = false
  }
}
</script>

<template>
  <div class="flex flex-col gap-5 animate-fade-in pb-2">
    <div v-if="!isOwnProfile || isTeacherViewer" class="flex items-center gap-2">
      <AppButton variant="ghost" size="sm" class="!px-2 shrink-0" @click="router.back()">
        <ArrowLeft :size="16" :stroke-width="2.5" />
      </AppButton>
      <div class="min-w-0 text-sm font-bold text-slate-400 truncate">{{ pageTitle }}</div>
    </div>
    <div v-else class="flex items-center gap-2">
      <User :size="20" :stroke-width="2" class="text-violet-400 shrink-0" />
      <h1 class="text-xl font-extrabold gradient-heading leading-tight">Мій профіль</h1>
    </div>

    <div v-if="loading" class="text-center py-16 text-slate-500 text-sm font-bold">Завантаження…</div>

    <div v-else-if="forbidden" class="text-center py-16 text-slate-500 text-sm">
      Немає доступу до цього профілю.
    </div>

    <template v-else>
      <div
        class="character-card overflow-hidden rounded-3xl cursor-pointer"
        @click="goRoom"
      >
        <div class="h-[min(42vw,320px)] min-h-[220px] max-h-[320px] relative">
          <CharacterScene
            :profile="viewedStudent"
            :owned-item-ids="viewedStudent?.inventory || []"
            :all-items="userStore.items"
            :room-mode="true"
            :interactive="false"
            :initial-zoom="0.52"
            :show-room-hud="false"
            class="w-full h-full"
          />
          <div class="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-black/80 to-transparent" />
          <div class="absolute bottom-0 inset-x-0 px-4 pb-3 flex items-end justify-between">
            <div>
              <div class="font-extrabold text-white text-base leading-tight">
                {{ viewedStudent?.displayName }}
              </div>
            </div>
            <div class="flex items-center gap-1 text-xs font-bold text-accent">
              <span>Кімната</span>
              <ArrowRight :size="12" :stroke-width="2.5" />
            </div>
          </div>
        </div>
        <div class="px-4 pt-2.5 pb-3">
          <div class="flex items-center justify-between mb-1.5 text-xs">
            <span class="font-extrabold text-slate-300">Рівень {{ level }}</span>
            <span class="text-xp font-bold tabular-nums">{{ xpProgress.current }}&thinsp;/&thinsp;{{ xpProgress.needed }} ДО</span>
          </div>
          <div class="h-1.5 bg-white/[0.07] rounded-full overflow-hidden">
            <div
              class="h-full rounded-full transition-all duration-700"
              :style="{ width: xpProgress.percent + '%', background: 'linear-gradient(to right, var(--accent), #34d399)' }"
            />
          </div>
        </div>
      </div>

      <div class="grid grid-cols-5 gap-2">
        <div
          v-for="stat in stats"
          :key="stat.label"
          class="stat-cell flex flex-col items-center gap-1 py-3 rounded-2xl"
          :class="stat.bg"
        >
          <component :is="stat.Icon" :size="18" :stroke-width="1.8" :class="stat.color" />
          <div class="font-extrabold text-sm leading-none">{{ stat.value }}</div>
          <div class="text-[9px] text-slate-500 font-bold leading-none">{{ stat.label }}</div>
        </div>
      </div>

      <div
        v-if="showTeacherActions"
        class="flex flex-col gap-2 sm:flex-row"
      >
        <AppButton variant="coin" size="md" block class="flex-1" @click="openAwardModal">
          <Coins :size="16" :stroke-width="2" />
          Нарахувати
        </AppButton>
        <AppButton
          variant="secondary"
          size="md"
          block
          class="flex-1 !border !border-red-500/45 !bg-red-600/15 !text-red-100"
          @click="openFineModal"
        >
          <Gavel :size="16" :stroke-width="2" />
          Оштрафувати
        </AppButton>
      </div>

      <section
        v-if="subjectCoins.length > 0"
        class="glass-card p-4 rounded-2xl border border-white/[0.07]"
      >
        <div class="flex items-center gap-2 mb-2">
          <GraduationCap :size="18" :stroke-width="2" class="text-violet-400" />
          <h2 class="font-extrabold text-base text-slate-200">Журнал: монети за предметами</h2>
        </div>
        <p class="text-[11px] text-slate-500 mb-3">
          Нарахування від вчителів з вказаним предметом
        </p>
        <div class="flex flex-col gap-1.5">
          <div
            v-for="row in subjectCoins"
            :key="row.subjectName"
            class="flex items-center justify-between gap-2 rounded-xl bg-white/[0.04] px-3 py-2"
          >
            <span class="text-sm font-semibold text-slate-200 truncate">{{ row.subjectName }}</span>
            <CoinDisplay :amount="row.coins" size="sm" />
          </div>
        </div>
      </section>

      <section>
        <div class="flex items-center gap-2 mb-3">
          <Activity :size="18" :stroke-width="2" class="text-violet-400" />
          <h2 class="font-extrabold text-base text-slate-200">Активність</h2>
        </div>
        <div v-if="history.length === 0" class="text-center py-10 text-slate-600 text-sm">
          Записів ще немає
        </div>
        <div v-else class="flex flex-col gap-2">
          <HistoryTransactionCard
            v-for="tx in history"
            :key="tx.id"
            :tx="tx"
            :items="userStore.items"
            compact
          >
            <template #time>{{ formatDate(tx.timestamp) }}</template>
          </HistoryTransactionCard>
        </div>
      </section>

      <template v-if="showStudentSettings">
        <section>
          <h2 class="font-extrabold text-base mb-3 text-slate-200">Аватар</h2>
          <AvatarBuilder />
        </section>
        <section class="glass-card p-4 flex flex-col gap-3">
          <div class="flex items-center gap-2 text-sm font-bold text-slate-300">
            <Palette :size="15" :stroke-width="2" class="text-accent" />
            Колір інтерфейсу
          </div>
          <div class="flex gap-2.5 flex-wrap">
            <button
              v-for="preset in ACCENT_PRESETS"
              :key="preset.hex"
              class="w-8 h-8 rounded-full transition-all duration-200 hover:scale-110"
              :class="currentAccent === preset.hex ? 'ring-2 ring-white/70 ring-offset-2 ring-offset-game-card scale-110' : ''"
              :style="{ background: preset.hex }"
              :title="preset.name"
              @click="setAccent(preset.hex)"
            />
          </div>
        </section>
        <button
          class="logout-btn flex items-center justify-center gap-2 w-full py-3 rounded-2xl text-sm font-bold text-slate-500 transition-all hover:text-red-400"
          @click="logout"
        >
          <LogOut :size="16" :stroke-width="2" />
          Вийти
        </button>
      </template>
    </template>

    <!-- Teacher: нарахувати -->
    <AppModal v-model="showAward" :title="`Нарахувати: ${viewedStudent?.displayName || ''}`">
      <div class="flex flex-col gap-3">
        <div v-if="teacherSubjects.length > 0">
          <label class="text-sm font-bold text-slate-300 block mb-2">Предмет</label>
          <div class="flex flex-wrap gap-2">
            <button
              v-for="subj in teacherSubjects"
              :key="subj.id"
              type="button"
              class="flex items-center gap-1.5 px-3 py-1.5 rounded-xl font-bold text-sm transition-all"
              :class="awardSubject === subj.name ? 'bg-violet-600 text-white' : 'bg-game-card text-slate-400 hover:text-white'"
              @click="awardSubject = awardSubject === subj.name ? '' : subj.name"
            >
              <SubjectIcon :icon="subj.icon || getSubjectIcon(subj.name)" size="1rem" />
              {{ subj.name }}
            </button>
          </div>
        </div>
        <div>
          <label class="text-sm font-bold text-slate-300 flex items-center gap-1.5 mb-2">
            Сума <Coins :size="13" :stroke-width="2" class="text-coin" />
          </label>
          <div class="flex gap-2 flex-wrap mb-3">
            <button
              v-for="a in QUICK_AMOUNTS"
              :key="a"
              type="button"
              class="px-4 py-2 rounded-xl font-bold text-sm transition-all"
              :class="awardAmount === a ? 'bg-amber-500 text-slate-900' : 'bg-game-card text-slate-300 hover:bg-game-border'"
              @click="awardAmount = a"
            >
              +{{ a }}
            </button>
          </div>
          <input
            v-model.number="awardAmount"
            type="number"
            min="1"
            class="w-full bg-game-bg border border-game-border rounded-xl px-4 py-3 text-center text-2xl font-extrabold text-amber-400 focus:outline-none focus:border-amber-500"
          />
        </div>
        <AppInput v-model="awardNote" label="Коментар (необов'язково)" placeholder="напр. Відмінна робота!" />
        <div
          class="flex items-center justify-between rounded-xl px-3 py-2 text-sm"
          :class="budgetOk ? 'bg-emerald-500/10 border border-emerald-500/20' : 'bg-red-500/10 border border-red-500/30'"
        >
          <span class="text-slate-400">З бюджету</span>
          <div class="flex items-center gap-2 font-extrabold">
            <CoinDisplay :amount="Number(awardAmount) || 0" size="sm" />
            <span class="text-slate-500 text-xs">/ {{ budgetInfo.remaining }}</span>
          </div>
        </div>
        <AppButton variant="coin" size="md" block :loading="awarding" :disabled="!budgetOk" @click="doAward">
          <Coins :size="14" :stroke-width="2" />
          Нарахувати
        </AppButton>
      </div>
    </AppModal>

    <!-- Teacher: штраф -->
    <AppModal v-model="showFine" :title="`Штраф: ${viewedStudent?.displayName || ''}`">
      <div class="flex flex-col gap-3">
        <div class="flex items-start gap-2.5 rounded-2xl p-3" style="background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.18)">
          <Gavel :size="16" :stroke-width="2" class="text-red-400 flex-shrink-0 mt-0.5" />
          <div class="text-xs text-red-300">
            Монети знімаються з балансу учня й повертаються до твого денного бюджету.
          </div>
        </div>
        <div class="flex items-center justify-between rounded-xl px-3 py-2 bg-white/[0.04]">
          <span class="text-sm text-slate-400">Баланс учня</span>
          <CoinDisplay :amount="viewedStudent?.coins || 0" size="sm" />
        </div>
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
        <AppInput v-model="fineReason" label="Причина штрафу *" placeholder="напр. Порушення правил…" />
        <AppButton variant="danger" size="md" block :loading="fining" :disabled="!fineReason.trim()" @click="doFine">
          <Gavel :size="14" :stroke-width="2" />
          Накласти штраф
        </AppButton>
      </div>
    </AppModal>
  </div>
</template>

<style scoped>
.character-card {
  background: rgba(255, 255, 255, 0.04);
  box-shadow:
    inset 0 0 0 1px rgba(255, 255, 255, 0.07),
    0 8px 32px rgba(0, 0, 0, 0.4);
}
.logout-btn {
  background: rgba(255, 255, 255, 0.03);
}
.logout-btn:hover {
  background: rgba(239, 68, 68, 0.08);
}
</style>
