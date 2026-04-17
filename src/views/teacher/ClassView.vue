<script setup>
import { ref, onMounted, onUnmounted, computed, reactive, watch } from 'vue'
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
  getTeacherFineTotalToday,
  FINE_INCREMENT,
  MAX_TEACHER_DAILY_FINE_PER_STUDENT,
} from '@/firebase/collections'
import { getSubjectIcon } from '@/composables/useSubjectIcon'
import AppButton from '@/components/ui/AppButton.vue'
import SubjectIcon from '@/components/ui/SubjectIcon.vue'
import AvatarDisplay from '@/components/avatar/AvatarDisplay.vue'
import CoinDisplay from '@/components/gamification/CoinDisplay.vue'
import { useToast } from '@/composables/useToast'
import { useHaptic } from '@/composables/useHaptic'
import {
  Coins,
  Wallet,
  Flame,
  Plus,
  Minus,
  MessageSquareText,
} from 'lucide-vue-next'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const userStore = useUserStore()
const { success, error } = useToast()
const { coin: hapticCoin } = useHaptic()

const POINT_STEP = 5

const CLASS_LAST_SUBJECT_LS = 'fus.classView.lastAwardSubject'

function lastAwardSubjectStorageKey(teacherId) {
  return `${CLASS_LAST_SUBJECT_LS}:${teacherId}`
}

function applyStoredDefaultSubject() {
  const tid = auth.profile?.id
  if (!tid || !teacherSubjects.value.length) return
  try {
    const saved = localStorage.getItem(lastAwardSubjectStorageKey(tid))
    if (!saved) return
    if (teacherSubjects.value.some((s) => s.name === saved)) {
      defaultAwardSubject.value = saved
    }
  } catch {
    /* private mode / quota */
  }
}

/** Extra scroll space above in-layout sticky submit (see template). */
const CLASS_VIEW_SCROLL_PAD = 'calc(6rem + env(safe-area-inset-bottom, 0px))'

const classData = ref(null)
const students = ref([])
const search = ref('')
const teacherSubjects = ref([])
const defaultAwardSubject = ref('')

const pendingDelta = reactive({})
const studentNotes = reactive({})
const messageOpenForId = ref(null)
const fineTotalByStudent = reactive({})
const submitting = ref(false)

let unsubClass = null

async function loadFineTotals() {
  const tid = auth.profile?.id
  if (!tid || !students.value.length) return
  await Promise.all(
    students.value.map(async (s) => {
      fineTotalByStudent[s.id] = await getTeacherFineTotalToday(tid, s.id)
    }),
  )
}

onMounted(async () => {
  const classId = route.params.id
  unsubClass = watchClass(classId, (data) => {
    classData.value = data
  })
  if (!userStore.items.length) await userStore.fetchItems()
  students.value = await getUsersByClass(classId)

  const subjectIds = auth.profile?.subjectIds || []
  if (subjectIds.length) {
    const all = await getAllSubjects()
    teacherSubjects.value = all.filter((s) => subjectIds.includes(s.id))
    defaultAwardSubject.value = teacherSubjects.value[0]?.name || ''
    applyStoredDefaultSubject()
  }

  await loadFineTotals()
})

watch(defaultAwardSubject, (name) => {
  const tid = auth.profile?.id
  if (!tid || !name) return
  try {
    localStorage.setItem(lastAwardSubjectStorageKey(tid), String(name))
  } catch {
    /* ignore */
  }
})

onUnmounted(() => {
  if (unsubClass) unsubClass()
})

const filtered = computed(() => {
  if (!search.value.trim()) return students.value
  const q = search.value.toLowerCase()
  return students.value.filter((s) => s.displayName?.toLowerCase().includes(q))
})

const sortedStudents = computed(() =>
  [...filtered.value].sort((a, b) => (b.coins || 0) - (a.coins || 0)),
)

const budgetInfo = computed(() => getTeacherBudgetInfo(auth.profile))
const budgetLowThresh = computed(() =>
  Math.max(15, Math.round((budgetInfo.value.budget || 1) * 0.1)),
)
const budgetMidThresh = computed(() =>
  Math.max(50, Math.round((budgetInfo.value.budget || 1) * 0.35)),
)

function deltaFor(sid) {
  const d = pendingDelta[sid]
  if (typeof d !== 'number' || !Number.isFinite(d)) return 0
  return d
}

function setDelta(sid, next) {
  if (next === 0) {
    delete pendingDelta[sid]
  } else {
    pendingDelta[sid] = next
  }
}

const totalPendingAwards = computed(() => {
  let t = 0
  for (const sid of Object.keys(pendingDelta)) {
    t += Math.max(0, deltaFor(sid))
  }
  return t
})

const effectiveBudgetRemaining = computed(() =>
  Math.max(0, budgetInfo.value.remaining - totalPendingAwards.value),
)

const pendingRowCount = computed(() =>
  Object.keys(pendingDelta).filter((sid) => deltaFor(sid) !== 0).length,
)

const hasAnyPending = computed(() => pendingRowCount.value > 0)

function toggleMessageRow(studentId) {
  messageOpenForId.value = messageOpenForId.value === studentId ? null : studentId
}

function rowNoteTrim(sid) {
  return String(studentNotes[sid] ?? '').trim()
}

function fineTotalFor(sid) {
  const n = fineTotalByStudent[sid]
  return typeof n === 'number' && Number.isFinite(n) ? n : 0
}

function canBumpPlus(s) {
  const cur = deltaFor(s.id)
  const next = cur + POINT_STEP
  const curA = Math.max(0, cur)
  const nextA = Math.max(0, next)
  const deltaAwards = nextA - curA
  if (deltaAwards <= 0) return true
  return totalPendingAwards.value - curA + nextA <= budgetInfo.value.remaining
}

function canBumpMinus(s) {
  const cur = deltaFor(s.id)
  const next = cur - POINT_STEP
  const nextF = Math.max(0, -next)
  if (fineTotalFor(s.id) + nextF > MAX_TEACHER_DAILY_FINE_PER_STUDENT) return false
  return true
}

function bumpPlus(s) {
  if (submitting.value) return
  if (!canBumpPlus(s)) {
    error(
      `Недостатньо бюджету під чергу (залишок ${budgetInfo.value.remaining} монет, у черзі вже ${totalPendingAwards.value})`,
    )
    return
  }
  setDelta(s.id, deltaFor(s.id) + POINT_STEP)
}

function bumpMinus(s) {
  if (submitting.value) return
  if (!canBumpMinus(s)) {
    error('Денний ліміт штрафу для цього учня вже 30 монет')
    return
  }
  setDelta(s.id, deltaFor(s.id) - POINT_STEP)
}

function studentById(id) {
  return students.value.find((u) => u.id === id) || null
}

function goProfile(s) {
  router.push(`/teacher/student/${s.id}/profile`)
}

async function submitPending() {
  if (submitting.value || !hasAnyPending.value) return

  const pairs = Object.keys(pendingDelta)
    .map((sid) => ({ sid, delta: deltaFor(sid) }))
    .filter((p) => p.delta !== 0)

  const subj = String(defaultAwardSubject.value || '').trim()

  for (const { sid, delta } of pairs) {
    const s = studentById(sid)
    if (!s) continue
    const fines = Math.max(0, -delta)
    const awards = Math.max(0, delta)
    if (fineTotalFor(sid) + fines > MAX_TEACHER_DAILY_FINE_PER_STUDENT) {
      error(`Перевір штраф для «${s.displayName}»: разом з уже накладеним виходить понад 30 монет`)
      return
    }
    if (fines > 0 && fineTotalFor(sid) === 0 && !rowNoteTrim(sid)) {
      error(`Вкажи причину штрафу для «${s.displayName}» у коментарі`)
      return
    }
    if (awards > 0 && awards % POINT_STEP !== 0) {
      error('Внутрішня помилка кроку нарахування')
      return
    }
  }

  if (totalPendingAwards.value > budgetInfo.value.remaining) {
    error(`Недостатньо денного бюджету для черги (потрібно ${totalPendingAwards.value} монет)`)
    return
  }

  submitting.value = true
  try {
    for (const { sid, delta } of pairs) {
      const s = studentById(sid)
      if (!s) continue
      const fines = Math.max(0, -delta)
      const awards = Math.max(0, delta)
      const initialFine = fineTotalFor(sid)
      const steps = Math.round(fines / POINT_STEP)
      const note = rowNoteTrim(sid)

      for (let i = 0; i < steps; i++) {
        await fineStudent({
          fromUid: auth.profile.id,
          toUid: sid,
          amount: FINE_INCREMENT,
          reason: i === 0 && initialFine === 0 ? note : '',
        })
      }

      if (awards > 0) {
        await awardCoins({
          fromUid: auth.profile.id,
          toUid: sid,
          amount: awards,
          note,
          subjectName: subj,
        })
        await checkAndGrantAchievements(sid)
      }

      setDelta(sid, 0)
    }

    hapticCoin()
    success(
      pairs.length === 1
        ? 'Зміни застосовано'
        : `Застосовано зміни для ${pairs.length} учнів`,
    )
    students.value = await getUsersByClass(route.params.id)
    await loadFineTotals()
  } catch (e) {
    error(e?.message || 'Помилка')
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div
    class="class-view-root flex flex-col gap-3"
    :style="{ paddingBottom: CLASS_VIEW_SCROLL_PAD }"
  >
    <div class="flex flex-col gap-2">
      <div class="min-w-0">
        <div class="flex items-center gap-1.5">
          <span class="text-xl shrink-0">{{ classData?.icon || '🏫' }}</span>
          <h1 class="text-base font-extrabold leading-tight [overflow-wrap:anywhere]">
            {{ classData?.name }}
          </h1>
        </div>
        <p class="text-slate-500 text-[11px] mt-0.5">{{ students.length }} учнів</p>
      </div>

      <div v-if="teacherSubjects.length > 0" class="glass-card p-2 flex flex-col gap-1.5">
        <span class="text-[10px] font-bold text-slate-500 uppercase tracking-wide">Предмет</span>
        <div class="flex flex-wrap gap-1">
          <button
            v-for="subj in teacherSubjects"
            :key="subj.id"
            type="button"
            class="flex items-center gap-1 px-2 py-0.5 rounded-md font-bold text-[11px] transition-all border"
            :class="
              defaultAwardSubject === subj.name
                ? 'bg-violet-600 text-white border-violet-400/50'
                : 'bg-game-bg text-slate-400 border-game-border hover:text-white'
            "
            @click="defaultAwardSubject = subj.name"
          >
            <SubjectIcon :icon="subj.icon || getSubjectIcon(subj.name)" size="0.75rem" />
            {{ subj.name }}
          </button>
        </div>
      </div>

      <div class="glass-card p-2.5 flex flex-col gap-1.5">
        <div class="flex items-center justify-between text-[11px]">
          <span class="font-bold text-slate-400 flex items-center gap-1">
            <Wallet :size="12" :stroke-width="2" class="text-amber-400/90" /> Бюджет
          </span>
          <span
            class="font-extrabold tabular-nums"
            :class="
              effectiveBudgetRemaining <= budgetLowThresh
                ? 'text-red-400'
                : effectiveBudgetRemaining <= budgetMidThresh
                  ? 'text-amber-400'
                  : 'text-emerald-400'
            "
          >
            {{ budgetInfo.remaining }} / {{ budgetInfo.budget }}
            <Coins :size="10" :stroke-width="2" class="inline opacity-90" />
          </span>
        </div>
        <div class="h-1 bg-game-bg rounded-full overflow-hidden">
          <div
            class="h-full rounded-full transition-all duration-500"
            :class="
              effectiveBudgetRemaining <= budgetLowThresh
                ? 'bg-red-500'
                : effectiveBudgetRemaining <= budgetMidThresh
                  ? 'bg-amber-500'
                  : 'bg-emerald-500'
            "
            :style="{
              width:
                Math.round(
                  (Math.max(0, budgetInfo.remaining - totalPendingAwards) / budgetInfo.budget) * 100,
                ) + '%',
            }"
          />
        </div>
        <div v-if="budgetInfo.remaining === 0" class="text-[11px] text-red-400 font-bold text-center">
          Бюджет на сьогодні вичерпано.
        </div>
      </div>
    </div>

    <input
      v-model="search"
      placeholder="Пошук учня…"
      class="w-full bg-game-card border border-game-border rounded-lg px-3 py-2 text-xs font-semibold text-white placeholder-slate-500 focus:outline-none focus:border-violet-500/60"
    />

    <div class="flex flex-col gap-2.5">
      <div
        v-for="(s, i) in sortedStudents"
        :key="s.id"
        class="glass-card rounded-xl border border-white/[0.06] p-3 flex flex-col gap-2 min-w-0"
      >
        <div class="grid grid-cols-[auto_1fr] gap-x-2.5 gap-y-2 min-w-0 items-start">
          <div
            class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[10px] font-black tabular-nums"
            :class="
              i === 0
                ? 'bg-amber-500/12 text-amber-400/95'
                : i === 1
                  ? 'bg-slate-400/10 text-slate-400'
                  : i === 2
                    ? 'bg-amber-800/15 text-amber-600/90'
                    : 'bg-white/[0.04] text-slate-500'
            "
          >
            {{ i + 1 }}
          </div>

          <div
            class="min-w-0 flex items-start justify-between gap-2"
            role="link"
            tabindex="0"
            @click="goProfile(s)"
            @keydown.enter.prevent="goProfile(s)"
            @keydown.space.prevent="goProfile(s)"
          >
            <div class="flex min-w-0 flex-1 items-start gap-2">
              <AvatarDisplay
                circle-only
                :avatar="s.avatar"
                :display-name="s.displayName || ''"
                :items="userStore.items"
                size="sm"
                class="shrink-0 pointer-events-none"
              />
              <div class="min-w-0 flex-1 pt-0.5">
                <div class="font-bold text-sm text-white leading-snug [overflow-wrap:anywhere] line-clamp-2">
                  {{ s.displayName }}
                </div>
                <div
                  class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-slate-500"
                >
                  <span>Рів. {{ s.level ?? 1 }}</span>
                  <span class="inline-flex items-center gap-0.5 text-orange-400/85">
                    <Flame :size="10" :stroke-width="2" class="shrink-0" />
                    {{ s.streak ?? 0 }}
                  </span>
                  <span v-if="fineTotalFor(s.id) > 0" class="text-red-400/80 tabular-nums font-semibold">
                    штраф: {{ fineTotalFor(s.id) }}/{{ MAX_TEACHER_DAILY_FINE_PER_STUDENT }}
                  </span>
                </div>
              </div>
            </div>
            <div class="flex shrink-0 flex-col items-end gap-0.5 pt-0.5">
              <CoinDisplay :amount="s.coins || 0" size="sm" />
              <span
                v-if="deltaFor(s.id) !== 0"
                class="text-xs font-black tabular-nums"
                :class="deltaFor(s.id) > 0 ? 'text-emerald-400' : 'text-red-400'"
              >
                {{ deltaFor(s.id) > 0 ? '+' : '' }}{{ deltaFor(s.id) }}
              </span>
            </div>
          </div>

          <div class="col-span-2 min-w-0 flex flex-col gap-2" @click.stop>
            <div class="flex w-full items-stretch gap-1.5">
              <AppButton
                variant="ghost"
                size="sm"
                class="!h-9 flex-1 min-w-0 !px-0"
                :class="messageOpenForId === s.id ? '!bg-violet-600/20 !text-white' : ''"
                title="Повідомлення / коментар"
                @click="toggleMessageRow(s.id)"
              >
                <MessageSquareText :size="18" :stroke-width="2" />
              </AppButton>
              <AppButton
                variant="secondary"
                size="sm"
                class="!h-9 flex-1 min-w-0 !px-0 !border-red-500/35 !bg-red-950/35 !text-red-100"
                :disabled="submitting || !canBumpMinus(s)"
                :title="`−${POINT_STEP}`"
                @click="bumpMinus(s)"
              >
                <Minus :size="18" :stroke-width="2.5" />
              </AppButton>
              <AppButton
                variant="coin"
                size="sm"
                class="!h-9 flex-1 min-w-0 !px-0"
                :disabled="submitting || !canBumpPlus(s)"
                :title="`+${POINT_STEP}`"
                @click="bumpPlus(s)"
              >
                <Plus :size="18" :stroke-width="2.5" />
              </AppButton>
            </div>

            <div v-if="messageOpenForId === s.id" class="w-full min-w-0">
              <label class="sr-only">Коментар або причина штрафу для {{ s.displayName }}</label>
              <textarea
                v-model="studentNotes[s.id]"
                rows="3"
                placeholder="Коментар до нарахування або причина штрафу…"
                class="w-full min-h-[5.5rem] rounded-lg border border-game-border bg-game-bg/80 px-3 py-2.5 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-violet-500/50 focus:border-violet-500/40 resize-y"
              />
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Bottom edge aligns with top of tab bar (no transparent gap). Offset = nav row + its safe-area padding. -->
    <Teleport to="body">
      <div
        class="fixed inset-x-0 z-[45] flex justify-center border-t border-white/[0.1] bg-game-bg/98 px-4 pt-2.5 pb-2 backdrop-blur-md pointer-events-auto"
        :style="{
          /* Distance from viewport bottom to this bar’s bottom = teacher tab bar height (tune if gap/overlap) */
          bottom: 'calc(2.9rem + env(safe-area-inset-bottom, 0px))',
        }"
      >
        <div class="w-full max-w-2xl">
          <div
            v-if="hasAnyPending"
            class="mb-1.5 flex items-center justify-between gap-2 text-[10px] font-bold text-slate-500 tabular-nums"
          >
            <span>У черзі: {{ pendingRowCount }}</span>
            <span class="inline-flex items-center gap-1 font-bold text-slate-400">
              Нарахування:
              <CoinDisplay :amount="totalPendingAwards" size="sm" />
            </span>
          </div>
          <AppButton
            variant="coin"
            size="md"
            block
            :loading="submitting"
            :disabled="!hasAnyPending"
            @click="submitPending"
          >
            Застосувати зміни
          </AppButton>
        </div>
      </div>
    </Teleport>
  </div>
</template>
