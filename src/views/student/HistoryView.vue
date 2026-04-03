<script setup>
import { ref, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useUserStore } from '@/stores/user'
import { getTransactionHistory } from '@/firebase/collections'
import { enrichStudentFeedTransactions } from '@/composables/useTransactionFeed'
import HistoryTransactionCard from '@/components/feed/HistoryTransactionCard.vue'
import AppButton from '@/components/ui/AppButton.vue'
import { BookOpen, Clock, Inbox } from 'lucide-vue-next'

const auth      = useAuthStore()
const userStore = useUserStore()
const history   = ref([])
const loading     = ref(true)
const loadingMore = ref(false)
const hasMore     = ref(false)
const PAGE        = 30

async function load(lim) {
  const raw = await getTransactionHistory(auth.profile?.id, lim)
  hasMore.value = raw.length === lim
  history.value = await enrichStudentFeedTransactions(raw, auth.profile?.id)
}

onMounted(async () => {
  loading.value = true
  try {
    if (!userStore.items.length) await userStore.fetchItems()
    await load(PAGE)
  } finally {
    loading.value = false
  }
})

async function loadMore() {
  loadingMore.value = true
  await load(history.value.length + PAGE)
  loadingMore.value = false
}

function formatDate(ts) {
  if (!ts) return ''
  const d = ts.toDate ? ts.toDate() : new Date(ts)
  const now = new Date()
  const diff = (now - d) / 1000
  if (diff < 60)    return 'щойно'
  if (diff < 3600)  return `${Math.floor(diff / 60)} хв тому`
  if (diff < 86400) return `${Math.floor(diff / 3600)} год тому`
  return d.toLocaleDateString('uk-UA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}
</script>

<template>
  <div class="flex flex-col gap-4 animate-fade-in">
    <div>
      <div class="flex items-center gap-2 mb-0.5">
        <BookOpen :size="20" :stroke-width="2" class="text-amber-500" />
        <h1 class="text-2xl font-extrabold gradient-heading">Журнал</h1>
      </div>
      <p class="text-slate-500 text-sm">Усі твої надходження та активність</p>
    </div>

    <div v-if="loading" class="flex flex-col items-center py-16 gap-3 text-slate-600">
      <Clock :size="40" :stroke-width="1" class="opacity-30" />
      <div class="text-sm">Завантаження...</div>
    </div>

    <div v-else-if="history.length === 0" class="flex flex-col items-center py-16 gap-3 text-slate-600">
      <Inbox :size="48" :stroke-width="1" class="opacity-30" />
      <div class="font-bold text-slate-500">Активності поки немає</div>
      <div class="text-sm text-center">Тут з'являться нарахування від вчителів,<br>бонуси та обміни</div>
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

      <AppButton v-if="hasMore" variant="secondary" block :loading="loadingMore" @click="loadMore">
        Завантажити більше
      </AppButton>
    </div>
  </div>
</template>
