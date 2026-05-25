<script setup>
/**
 * Daily 5-question quiz from Ukrainian ZNO/NMT-style banks (NLPForUA/ZNO GitHub datasets).
 * Після кожної відповіді показує вірно/ні; можна пройти всі 5 питань підряд.
 */
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { Brain, Loader2, ChevronRight, RotateCcw } from 'lucide-vue-next'
import AppButton from '@/components/ui/AppButton.vue'
import { useAuthStore } from '@/stores/auth'
import { useToast } from '@/composables/useToast'
import {
  getClass,
  submitDailyZnoQuiz,
  recordConsumedQuizQuestions,
  beginDailyZnoQuiz,
  utcCalendarDateString,
} from '@/firebase/collections'
import { ZNO_QUIZ_SUBJECTS } from '@/lib/znoQuizConstants'
import { isPrimarySchoolGrade } from '@/lib/primaryQuizBank'
import {
  fetchZnoSubjectBank,
  pickRandomQuizTasks,
  answersForDisplay,
} from '@/lib/znoQuizLoad'
import { gradeFromClassName } from '@/utils/schoolTier'

const auth = useAuthStore()
const { success, error, info } = useToast()

const studentGrade = ref(null)
const loadingGrade = ref(false)

const subjectSlug = ref('primary_school')
/** Сабміт на сервер лише коли немає часу — не збігається з жодною літерою варіантів. */
const PICK_TIMEOUT_SENTINEL = '__QUIZ_TIME__'
const QUESTION_TIME_SEC = 60

/** idle | loading | active | done | abandoned */
const phase = ref('idle')
const loadError = ref('')
const decorated = ref([])
const currentIndex = ref(0)
/** taskKey → picked letter */
const picks = ref({})
const submitting = ref(false)
const resultBanner = ref('')
/** Після перевірки відповіді до натискання «Далі» */
const answerReveal = ref(null)
/** Підсумок із сервера після фінального сабміту */
const quizOutcome = ref(null)

/** Секунди до кінця поточного питання (лише active, до перевірки відповіді). */
const secondsLeft = ref(0)
let questionTimerId = null
let terminatingLeave = false

function clearQuestionTimer() {
  if (questionTimerId != null) {
    clearInterval(questionTimerId)
    questionTimerId = null
  }
  secondsLeft.value = 0
}

function armQuestionTimer() {
  clearQuestionTimer()
  if (phase.value !== 'active' || submitting.value || answerReveal.value) return
  if (!currentTask.value) return
  const deadline = Date.now() + QUESTION_TIME_SEC * 1000
  const tick = () => {
    if (phase.value !== 'active' || answerReveal.value) {
      clearQuestionTimer()
      return
    }
    const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
    secondsLeft.value = left
    if (left <= 0) {
      clearQuestionTimer()
      forceWrongByTimeout()
    }
  }
  tick()
  questionTimerId = setInterval(tick, 250)
}

function forceWrongByTimeout() {
  if (phase.value !== 'active' || submitting.value) return
  if (answerReveal.value) return
  const t = currentTask.value
  if (!t) return
  picks.value = { ...picks.value, [t.taskKey]: PICK_TIMEOUT_SENTINEL }
  answerReveal.value = {
    taskKey: t.taskKey,
    correct: false,
    correctLetter: t.correctLetter,
    correctText: answerText(t, t.correctLetter),
    timeUp: true,
  }
}

async function terminateQuizForLeave() {
  if (phase.value !== 'active' || terminatingLeave) return
  terminatingLeave = true
  clearQuestionTimer()
  const keys = decorated.value.map((r) => r.taskKey).filter(Boolean)
  const msg =
    'Квіз припинено: перемикання вкладки або вихід з додатка. Ці питання більше не потраплять у ваш підбір.'
  phase.value = 'abandoned'
  answerReveal.value = null
  quizOutcome.value = null
  resultBanner.value = msg
  error(msg)
  if (auth.profile?.id && keys.length) {
    try {
      await recordConsumedQuizQuestions(auth.profile.id, keys, 'переривання (вкладка/фон)')
    } catch (e) {
      console.warn('[DailyQuiz] recordConsumed after leave:', e)
    }
  }
}

function onDocumentVisibilityChange() {
  if (typeof document === 'undefined') return
  if (document.visibilityState === 'hidden') void terminateQuizForLeave()
}

function onWindowPageHide(ev) {
  if (ev.persisted) return
  void terminateQuizForLeave()
}

watch(
  () => [phase.value, currentIndex.value, answerReveal.value],
  () => {
    if (phase.value === 'active' && !answerReveal.value && currentTask.value) armQuestionTimer()
    else clearQuestionTimer()
  },
  { flush: 'post' },
)

onMounted(() => {
  document.addEventListener('visibilitychange', onDocumentVisibilityChange)
  window.addEventListener('pagehide', onWindowPageHide)
})

onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onDocumentVisibilityChange)
  window.removeEventListener('pagehide', onWindowPageHide)
  clearQuestionTimer()
})

watch(
  () => auth.profile?.classId,
  async (cid) => {
    studentGrade.value = null
    if (!cid) return
    loadingGrade.value = true
    try {
      const cls = await getClass(cid)
      studentGrade.value = gradeFromClassName(cls?.name)
    } catch {
      studentGrade.value = null
    } finally {
      loadingGrade.value = false
    }
  },
  { immediate: true },
)

/** Предмети в селекті: для 1–4 класу — початкова школа + укр. мова; для старших — ZNO без початкової. */
const quizSubjectsForStudent = computed(() => {
  if (isPrimarySchoolGrade(studentGrade.value)) {
    return ZNO_QUIZ_SUBJECTS.filter(
      (s) => s.slug === 'primary_school' || s.slug === 'ukr_lang_lit',
    )
  }
  return ZNO_QUIZ_SUBJECTS.filter((s) => s.slug !== 'primary_school')
})

watch(
  [studentGrade, quizSubjectsForStudent],
  () => {
    const list = quizSubjectsForStudent.value
    if (!list.some((s) => s.slug === subjectSlug.value)) {
      subjectSlug.value = list[0]?.slug ?? ZNO_QUIZ_SUBJECTS[0].slug
    }
  },
  { immediate: true },
)

const consumedKeys = computed(() => {
  const arr = auth.profile?.quizConsumedQuestionIds
  return Array.isArray(arr) ? arr.map(String) : []
})

const quizToday = computed(() => utcCalendarDateString())

const quizTakenToday = computed(() => {
  const last = String(auth.profile?.quizDailyAttemptDate || '').trim()
  return last === quizToday.value
})

const currentTask = computed(() => decorated.value[currentIndex.value] || null)
const isLast = computed(() => currentIndex.value >= decorated.value.length - 1)

const revealForCurrent = computed(() => {
  const t = currentTask.value
  const ar = answerReveal.value
  if (!t || !ar || ar.taskKey !== t.taskKey) return null
  return ar
})

function answerText(task, letter) {
  const L = String(letter || '').trim()
  if (!task?.answers?.length) return ''
  const row = task.answers.find((a) => a.letter === L)
  return row?.text ? String(row.text) : ''
}

function pickLetter(taskKey, letter) {
  if (phase.value !== 'active' || answerReveal.value || submitting.value) return
  picks.value = { ...picks.value, [taskKey]: letter }
}

function optionWrapClass(opt) {
  const t = currentTask.value
  if (!t) return 'border-white/[0.07] bg-white/[0.03] text-slate-200 hover:bg-white/[0.06]'
  const ac = revealForCurrent.value
  const picked = picks.value[t.taskKey]
  if (ac) {
    if (opt.letter === ac.correctLetter) {
      return 'border-emerald-500/70 bg-emerald-500/12 text-emerald-50 ring-1 ring-emerald-500/25'
    }
    if (!ac.correct && ac.pickedWrong != null && opt.letter === ac.pickedWrong) {
      return 'border-red-500/60 bg-red-500/10 text-red-100 ring-1 ring-red-500/30'
    }
    return 'border-white/[0.05] bg-white/[0.02] text-slate-500 opacity-65'
  }
  if (picked === opt.letter) return 'border-sky-500/70 bg-sky-500/15 text-sky-50'
  return 'border-white/[0.07] bg-white/[0.03] text-slate-200 hover:bg-white/[0.06]'
}

async function buildSession() {
  if (!auth.profile?.id) return
  if (quizTakenToday.value) {
    loadError.value = 'Сьогоднішній предметний квіз ви вже проходили. Наступна спроба — завтра.'
    error(loadError.value)
    return
  }
  terminatingLeave = false
  clearQuestionTimer()
  phase.value = 'loading'
  loadError.value = ''
  resultBanner.value = ''
  quizOutcome.value = null
  picks.value = {}
  currentIndex.value = 0
  answerReveal.value = null
  decorated.value = []

  try {
    const meta = quizSubjectsForStudent.value.find((s) => s.slug === subjectSlug.value)
      ?? ZNO_QUIZ_SUBJECTS.find((s) => s.slug === subjectSlug.value)
    if (!meta) throw new Error('Невідомий предмет')
    const bank = await fetchZnoSubjectBank(meta, subjectSlug.value)
    const picked = pickRandomQuizTasks(bank, consumedKeys.value, studentGrade.value, 5)
    decorated.value = picked.map((t) => ({
      ...t,
      displayAnswers: answersForDisplay(t.answers),
    }))
    await beginDailyZnoQuiz(auth.profile.id)
    phase.value = 'active'
  } catch (e) {
    loadError.value = e?.message || 'Не вдалося завантажити питання'
    phase.value = 'idle'
    error(loadError.value)
  }
}

async function confirmAnswer() {
  const t = currentTask.value
  if (!t || answerReveal.value || submitting.value) return
  const picked = picks.value[t.taskKey]
  if (!picked) {
    error('Оберіть один з варіантів')
    return
  }

  const correctText = answerText(t, t.correctLetter)
  const correct = picked === t.correctLetter
  answerReveal.value = {
    taskKey: t.taskKey,
    correct,
    correctLetter: t.correctLetter,
    correctText,
    ...(correct ? {} : { pickedWrong: picked, pickedText: answerText(t, picked) }),
  }
}

async function proceedAfterReveal() {
  if (!answerReveal.value || submitting.value) return
  answerReveal.value = null
  if (isLast.value) {
    await submitFullRun()
    return
  }
  currentIndex.value += 1
}

async function submitFullRun() {
  for (const row of decorated.value) {
    if (!picks.value[row.taskKey]) {
      error('Внутрішня помилка: не всі відповіді зібрані')
      return
    }
  }

  submitting.value = true
  try {
    const items = decorated.value.map((row) => ({
      taskKey: row.taskKey,
      picked: picks.value[row.taskKey],
    }))
    const r = await submitDailyZnoQuiz(auth.profile.id, { subjectSlug: subjectSlug.value, items })
    phase.value = 'done'
    resultBanner.value = r.message
    quizOutcome.value = {
      errorCount: r.errorCount,
      rewarded: r.rewarded,
      skippedReward: r.skippedReward,
      coinsGranted: r.coinsGranted,
      boxName: r.boxName,
    }
    if (r.rewarded) success(r.message)
    else if (r.skippedReward) info(r.message)
    else info(r.message)
  } catch (e) {
    error(e?.message || 'Помилка збереження')
  } finally {
    submitting.value = false
  }
}

function resetToIdle() {
  terminatingLeave = false
  clearQuestionTimer()
  phase.value = 'idle'
  decorated.value = []
  picks.value = {}
  currentIndex.value = 0
  resultBanner.value = ''
  loadError.value = ''
  quizOutcome.value = null
  answerReveal.value = null
}

const doneSummaryClass = computed(() => {
  const ec = quizOutcome.value?.errorCount
  if (ec == null) return 'border-emerald-500/35 bg-emerald-500/10 text-emerald-200'
  if (ec === 0) return 'border-emerald-500/35 bg-emerald-500/10 text-emerald-200'
  if (ec <= 3) return 'border-amber-500/35 bg-amber-500/10 text-amber-100'
  return 'border-white/[0.12] bg-white/[0.05] text-slate-200'
})

const doneSummaryTitle = computed(() => {
  const ec = quizOutcome.value?.errorCount
  if (ec == null) return 'Квіз завершено'
  if (ec === 0) return 'Без помилок'
  return `Помилок: ${ec}`
})
</script>

<template>
  <div class="glass-card overflow-hidden">
    <div class="px-4 py-3 border-b border-white/[0.06] flex items-center justify-between gap-2">
      <div class="flex items-center gap-2 min-w-0">
        <Brain :size="18" :stroke-width="2" class="text-sky-400 shrink-0" />
        <div class="min-w-0">
          <h2 class="font-extrabold text-base text-slate-100 leading-tight">Предметний квіз</h2>
          <ul class="text-[11px] text-slate-500 leading-snug mt-1 list-disc list-inside space-y-0.5">
            <li>Одна спроба на день (UTC). До 1 хв на питання; перемикання вкладки завершує квіз без нагороди.</li>
            <li>0 помилок — 100 монет на предмет + легендарна коробка</li>
            <li>1 — 75 монет + епічна коробка</li>
            <li>2 — 50 монет + рідкісна коробка</li>
            <li>3 — 25 монет + звичайна коробка</li>
            <li>4–5 помилок — без нагороди</li>
          </ul>
        </div>
      </div>
    </div>

    <div class="p-4 flex flex-col gap-3 text-sm">
      <div class="flex flex-wrap items-center gap-2 text-xs text-slate-400">
        <span v-if="loadingGrade" class="inline-flex items-center gap-1">
          <Loader2 :size="12" class="animate-spin" /> клас…
        </span>
        <template v-else>
          <span>
            Питання за програмою
            <span v-if="studentGrade != null" class="text-sky-300/95 font-semibold">{{ studentGrade }} класу</span>
            <span v-else class="text-sky-300/95 font-semibold">10–11 класів</span>
            <span class="text-slate-500"> (тема з банку ЗНО)</span>
          </span>
        </template>
      </div>

      <p class="text-[11px] text-slate-500 leading-snug">
        <template v-if="subjectSlug === 'primary_school'">
          100 власних питань для 1–4 класу (математика, мова, природознавство).
        </template>
        <template v-else>
          Банк питань:
          <a
            href="https://github.com/NLPForUA/ZNO"
            target="_blank"
            rel="noopener noreferrer"
            class="text-sky-400 underline-offset-2 hover:underline font-semibold"
          >NLPForUA/ZNO</a>
          (ліцензії в репозиторії).
        </template>
      </p>

      <div v-if="phase === 'idle' || phase === 'loading'" class="flex flex-col gap-2">
        <div
          v-if="quizTakenToday"
          class="rounded-xl px-3 py-2.5 border border-amber-500/35 bg-amber-500/10 text-amber-100 text-xs font-semibold leading-snug"
        >
          Сьогоднішній квіз уже пройдено. Завтра з’явиться нова спроба.
        </div>
        <label class="text-xs font-bold text-slate-400 uppercase tracking-wide">Предмет</label>
        <select
          v-model="subjectSlug"
          class="bg-game-card border border-white/[0.08] rounded-xl px-3 py-2.5 text-slate-200 text-sm outline-none focus:border-white/18"
          :disabled="phase === 'loading' || quizTakenToday"
        >
          <option v-for="s in quizSubjectsForStudent" :key="s.slug" :value="s.slug">{{ s.label }}</option>
        </select>
        <AppButton
          variant="primary"
          size="lg"
          block
          :loading="phase === 'loading'"
          :disabled="quizTakenToday"
          @click="buildSession"
        >
          Розпочати квіз
        </AppButton>
        <p v-if="loadError" class="text-xs text-red-400 font-semibold">{{ loadError }}</p>
      </div>

      <div v-else-if="phase === 'active' && currentTask" class="flex flex-col gap-3">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="text-xs font-bold text-slate-500">
            Питання {{ currentIndex + 1 }} з 5
          </div>
          <div
            v-if="!answerReveal"
            class="text-xs font-extrabold tabular-nums rounded-lg px-2 py-1 border"
            :class="secondsLeft <= 10 ? 'text-amber-200 border-amber-500/40 bg-amber-500/10' : 'text-slate-300 border-white/[0.08] bg-white/[0.04]'"
          >
            Час: {{ secondsLeft }} с
          </div>
        </div>
        <div class="text-slate-100 font-semibold leading-snug">
          {{ currentTask.question }}
        </div>

        <div v-if="currentTask.photoUrl" class="rounded-xl overflow-hidden border border-white/[0.08] bg-black/20">
          <img
            :src="currentTask.photoUrl"
            :alt="'Ілюстрація до питання'"
            class="w-full max-h-72 object-contain object-center mx-auto block"
            loading="lazy"
            referrerpolicy="no-referrer"
          >
        </div>

        <div class="flex flex-col gap-2">
          <button
            v-for="opt in currentTask.displayAnswers"
            :key="currentTask.taskKey + opt.letter"
            type="button"
            :disabled="submitting || !!answerReveal"
            class="w-full text-left rounded-xl px-3 py-2.5 border text-sm transition-colors"
            :class="optionWrapClass(opt)"
            @click="pickLetter(currentTask.taskKey, opt.letter)"
          >
            <span class="font-extrabold text-sky-400 mr-1.5">{{ opt.letter }}.</span>
            {{ opt.text }}
          </button>
        </div>

        <div
          v-if="revealForCurrent?.correct"
          class="rounded-xl px-3 py-2.5 text-sm font-bold border border-emerald-500/35 bg-emerald-500/10 text-emerald-200"
        >
          Вірно!
        </div>
        <div
          v-else-if="revealForCurrent && !revealForCurrent.correct"
          class="rounded-xl px-3 py-2.5 text-sm border border-red-500/35 bg-red-500/10 text-red-100 space-y-1"
        >
          <div class="font-bold">{{ revealForCurrent.timeUp ? 'Час вичерпано (1 хв).' : 'Невірно.' }}</div>
          <p v-if="revealForCurrent.timeUp" class="text-xs text-slate-400">
            Відповідь не зараховано — час вийшов до натискання «Перевірити відповідь».
          </p>
          <div v-else-if="!revealForCurrent.timeUp && revealForCurrent.pickedText" class="text-xs text-slate-300">
            Ваш варіант: {{ revealForCurrent.pickedWrong }}.
            {{ revealForCurrent.pickedText }}
          </div>
          <div class="text-xs text-slate-300">
            Правильно: <span class="text-emerald-400 font-semibold">{{ revealForCurrent.correctLetter }}.</span>
            {{ revealForCurrent.correctText || '—' }}
          </div>
        </div>

        <div class="flex flex-col gap-2">
          <AppButton
            v-if="revealForCurrent"
            variant="primary"
            block
            :loading="submitting"
            @click="proceedAfterReveal"
          >
            {{ isLast ? 'Завершити квіз' : 'Далі' }}
            <ChevronRight v-if="!isLast" :size="16" class="opacity-90 inline" />
          </AppButton>
          <AppButton
            v-else
            variant="primary"
            block
            :loading="submitting"
            :disabled="!picks[currentTask.taskKey]"
            @click="confirmAnswer()"
          >
            Перевірити відповідь
          </AppButton>
        </div>
      </div>

      <div v-else-if="phase === 'abandoned'" class="flex flex-col gap-3">
        <div class="rounded-xl px-3 py-2.5 border border-amber-500/35 bg-amber-500/10 text-amber-100 text-sm font-bold">
          Квіз перервано
        </div>
        <p class="text-slate-200 font-semibold leading-snug">{{ resultBanner }}</p>
        <AppButton variant="secondary" block @click="resetToIdle">
          <RotateCcw :size="15" class="inline mr-1 opacity-90" /> Новий квіз
        </AppButton>
      </div>

      <div v-else-if="phase === 'done'" class="flex flex-col gap-3">
        <div
          class="rounded-xl px-3 py-2.5 border text-sm font-bold"
          :class="doneSummaryClass"
        >
          {{ doneSummaryTitle }}
        </div>
        <p class="text-slate-200 font-semibold leading-snug">{{ resultBanner }}</p>
        <AppButton variant="secondary" block @click="resetToIdle">
          <RotateCcw :size="15" class="inline mr-1 opacity-90" /> Новий квіз
        </AppButton>
      </div>
    </div>
  </div>
</template>
