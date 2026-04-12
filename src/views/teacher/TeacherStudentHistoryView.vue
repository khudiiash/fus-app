<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useUserStore } from '@/stores/user'
import {
  getUser,
  teacherMayAccessStudentProfile,
  getStudentActivityTransactions,
  aggregateStudentAwardCoinsBySubject,
} from '@/firebase/collections'
import { enrichStudentFeedTransactions } from '@/composables/useTransactionFeed'
import HistoryTransactionCard from '@/components/feed/HistoryTransactionCard.vue'
import AppButton from '@/components/ui/AppButton.vue'
import CoinDisplay from '@/components/gamification/CoinDisplay.vue'
import { BookOpen, Clock, Inbox, ArrowLeft, GraduationCap } from 'lucide-vue-next'

const route  = useRoute()
const router = useRouter()
const auth   = useAuthStore()
const userStore = useUserStore()

const studentId = computed(() => route.params.studentId)
const student     = ref(null)
const history     = ref([])
const subjectCoins = ref([])
const loading       = ref(true)
const forbidden     = ref(false)

onMounted(async () => {
  loading.value = true
  try {
    if (!userStore.items.length) await userStore.fetchItems()
    const s = await getUser(studentId.value)
    if (!s || s.role !== 'student') {
      forbidden.value = true
      return
    }
    if (!teacherMayAccessStudentProfile(auth.profile, s)) {
      forbidden.value = true
      return
    }
    student.value = s
    const [raw, subj] = await Promise.all([
      getStudentActivityTransactions(studentId.value, 100),
      aggregateStudentAwardCoinsBySubject(studentId.value),
    ])
    subjectCoins.value = subj
    history.value = await enrichStudentFeedTransactions(raw, studentId.value)
  } finally {
    loading.value = false
  }
})

function formatDate(ts) {
  if (!ts) return ''
  const d = ts.toDate ? ts.toDate() : new Date(ts)
  return d.toLocaleDateString('uk-UA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}
</script>

<template>
  <div class="flex flex-col gap-4 animate-fade-in pb-4">
    <div class="flex items-start gap-2">
      <AppButton variant="ghost" size="sm" class="shrink-0 !px-2" @click="router.back()">
        <ArrowLeft :size="16" :stroke-width="2.5" />
      </AppButton>
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2 mb-0.5">
          <BookOpen :size="20" :stroke-width="2" class="text-amber-500" />
          <h1 class="text-xl font-extrabold gradient-heading leading-tight">Журнал учня</h1>
        </div>
        <p v-if="student" class="text-slate-500 text-sm truncate">{{ student.displayName }}</p>
      </div>
    </div>

    <div v-if="loading" class="flex flex-col items-center py-16 gap-3 text-slate-600">
      <Clock :size="40" :stroke-width="1" class="opacity-30" />
      <div class="text-sm">Завантаження...</div>
    </div>

    <div v-else-if="forbidden" class="text-center py-16 text-slate-500 text-sm">
      Немає доступу до цього учня або профіль не знайдено.
    </div>

    <template v-else>
      <div
        v-if="subjectCoins.length > 0"
        class="glass-card rounded-2xl border border-white/[0.07] p-3.5"
      >
        <div class="flex items-center gap-2 mb-2.5">
          <GraduationCap :size="16" :stroke-width="2" class="text-violet-400" />
          <span class="font-extrabold text-sm text-slate-200">Монети за предметами</span>
        </div>
        <p class="text-[11px] text-slate-500 mb-2">Лише нарахування від вчителів з вказаним предметом</p>
        <div class="flex flex-col gap-1.5">
          <div
            v-for="row in subjectCoins"
            :key="row.subjectName"
            class="flex items-center justify-between gap-2 text-sm rounded-xl bg-white/[0.04] px-3 py-2"
          >
            <span class="text-slate-300 font-semibold truncate">{{ row.subjectName }}</span>
            <CoinDisplay :amount="row.coins" size="sm" />
          </div>
        </div>
      </div>

      <div v-if="history.length === 0" class="flex flex-col items-center py-12 gap-2 text-slate-600">
        <Inbox :size="40" :stroke-width="1" class="opacity-30" />
        <div class="font-bold text-slate-500 text-sm">Записів немає</div>
      </div>

      <div v-else class="flex flex-col gap-2.5">
        <HistoryTransactionCard
          v-for="tx in history"
          :key="tx.id"
          :tx="tx"
          :items="userStore.items"
        >
          <template #time>{{ formatDate(tx.timestamp) }}</template>
        </HistoryTransactionCard>
      </div>
    </template>
  </div>
</template>
