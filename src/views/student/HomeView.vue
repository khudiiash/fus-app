<script setup>
import { ref, computed, onMounted } from 'vue'
import { storeToRefs } from 'pinia'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useUserStore } from '@/stores/user'
import { useStudentFeedStore } from '@/stores/studentFeed'
import { getTransactionHistory } from '@/firebase/collections'
import { enrichStudentFeedTransactions } from '@/composables/useTransactionFeed'
import HistoryTransactionCard from '@/components/feed/HistoryTransactionCard.vue'
import { useGameification } from '@/composables/useGameification'
import StreakWidget from '@/components/gamification/StreakWidget.vue'
import QuestCard from '@/components/gamification/QuestCard.vue'
import TeacherQuestAssignmentCard from '@/components/gamification/TeacherQuestAssignmentCard.vue'
import QuestSubmitProofModal from '@/components/gamification/QuestSubmitProofModal.vue'
import { Zap, ClipboardList, Activity, Inbox } from 'lucide-vue-next'
import { givenNameFromDisplayName } from '@/utils/personName'

const router = useRouter()

const auth = useAuthStore()
const userStore = useUserStore()
const studentFeed = useStudentFeedStore()
const { teacherQuests, questCompletions: myCompletions } = storeToRefs(studentFeed)
const profile = computed(() => auth.profile)

const { streak } = useGameification(profile)

const history = ref([])

const showSubmit = ref(false)
const submitQuest = ref(null)

onMounted(async () => {
  await userStore.fetchQuests()
  if (auth.profile?.id) {
    if (!userStore.items.length) await userStore.fetchItems()
    const raw = await getTransactionHistory(auth.profile.id, 10)
    history.value = await enrichStudentFeedTransactions(raw, auth.profile.id)
  }
})

function completionFor(questId) {
  return myCompletions.value.find((c) => c.questId === questId) || null
}

/** Без зарахованих вчителем — на головній лише те, що ще актуально для учня. */
const teacherQuestsUncompleted = computed(() =>
  teacherQuests.value.filter((q) => completionFor(q.id)?.status !== 'approved'),
)

const teacherQuestsHomePreview = computed(() => teacherQuestsUncompleted.value.slice(0, 5))

function openSubmit(quest) {
  submitQuest.value = quest
  showSubmit.value = true
}

function formatDate(ts) {
  if (!ts) return ''
  const d = ts.toDate ? ts.toDate() : new Date(ts)
  const now = new Date()
  const diff = (now - d) / 1000
  if (diff < 60) return 'щойно'
  if (diff < 3600) return `${Math.floor(diff / 60)} хв тому`
  if (diff < 86400) return `${Math.floor(diff / 3600)} год тому`
  return d.toLocaleDateString('uk-UA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}
</script>

<template>
  <div class="flex flex-col gap-4 animate-fade-in">
    <!-- Greeting -->
    <div>
      <div class="font-extrabold text-2xl gradient-heading">Привіт, {{ givenNameFromDisplayName(profile?.displayName) }}!</div>
      <div class="text-slate-500 text-sm mt-0.5">Заробимо сьогодні монети!</div>
    </div>

    <!-- Streak -->
    <StreakWidget :streak="streak" />

    <!-- Daily Quests -->
    <div>
      <div class="flex items-center justify-between mb-3">
        <div class="flex items-center gap-2">
          <Zap :size="18" :stroke-width="2" class="text-violet-400" />
          <h2 class="font-extrabold text-base">Щоденні завдання</h2>
        </div>
        <div class="text-xs text-slate-400">Оновлюються опівночі</div>
      </div>
      <div class="flex flex-col gap-3">
        <QuestCard
          v-for="quest in userStore.quests"
          :key="quest.type"
          :quest="quest"
          :busy="userStore.claimingQuestType === quest.type"
          @claim="userStore.claimQuest(quest.type)"
        />
        <div v-if="userStore.quests.length === 0" class="text-center py-8 text-slate-600">
          <Zap :size="36" :stroke-width="1" class="mx-auto mb-2 opacity-30" />
          <div class="text-sm text-slate-500">Завдань поки немає. Заходь завтра!</div>
        </div>
      </div>
    </div>

    <!-- Teacher quests: лише 5 останніх незавершених; решта — /student/quests -->
    <div v-if="teacherQuests.length > 0">
      <div class="flex items-center justify-between mb-3">
        <div class="flex items-center gap-2">
          <ClipboardList :size="18" :stroke-width="2" class="text-violet-400" />
          <h2 class="font-extrabold text-base">Завдання від вчителя</h2>
        </div>
        <button
          type="button"
          class="text-xs text-violet-400 font-semibold"
          @click="router.push('/student/quests')"
        >
          Усі завдання →
        </button>
      </div>

      <div v-if="teacherQuestsHomePreview.length > 0" class="flex flex-col gap-3">
        <TeacherQuestAssignmentCard
          v-for="quest in teacherQuestsHomePreview"
          :key="quest.id"
          :quest="quest"
          :completion="completionFor(quest.id)"
          :student-id="auth.profile?.id || ''"
          @submit="openSubmit"
        />
      </div>
      <div
        v-else
        class="glass-card p-4 text-sm text-slate-500 text-center"
      >
        Немає незавершених завдань (або всі вже зараховані).
        <button type="button" class="text-violet-400 font-semibold ml-1" @click="router.push('/student/quests')">
          Переглянути список
        </button>
      </div>
    </div>

    <!-- Recent Activity -->
    <div>
      <div class="flex items-center justify-between mb-3">
        <div class="flex items-center gap-2">
          <Activity :size="18" :stroke-width="2" class="text-violet-400" />
          <h2 class="font-extrabold text-base">Остання активність</h2>
        </div>
        <button type="button" class="text-xs text-violet-400 font-semibold" @click="router.push('/student/history')">
          Вся історія →
        </button>
      </div>
      <div v-if="history.length === 0" class="text-center py-8 text-slate-600">
        <Inbox :size="36" :stroke-width="1" class="mx-auto mb-2 opacity-30" />
        <div class="text-sm text-slate-500">Активності ще немає. Починай заробляти!</div>
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
    </div>

    <QuestSubmitProofModal v-model="showSubmit" :quest="submitQuest" />
  </div>
</template>
