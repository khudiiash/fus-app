<script setup>
import { ref, computed, onMounted } from 'vue'
import { doc, getDoc } from 'firebase/firestore'
import { db } from '@/firebase/config'
import { useAuthStore } from '@/stores/auth'
import { getAwardHistory } from '@/firebase/collections'
import AppCard from '@/components/ui/AppCard.vue'
import CoinDisplay from '@/components/gamification/CoinDisplay.vue'
import { ClipboardList, Coins, Clock, Inbox } from 'lucide-vue-next'

const auth    = useAuthStore()
const history = ref([])
const loading = ref(true)

const nameCache = {}
async function resolveName(uid) {
  if (!uid) return 'Невідомо'
  if (nameCache[uid]) return nameCache[uid]
  try {
    const snap = await getDoc(doc(db, 'users', uid))
    const name = snap.exists() ? (snap.data().displayName || 'Невідомо') : 'Невідомо'
    nameCache[uid] = name
    return name
  } catch { return 'Невідомо' }
}

onMounted(async () => {
  loading.value = true
  const raw = await getAwardHistory(auth.profile.id)
  const uids = [...new Set(raw.map(tx => tx.toUid).filter(Boolean))]
  await Promise.all(uids.map(resolveName))
  history.value = raw.map(tx => ({ ...tx, toName: nameCache[tx.toUid] || 'Невідомо' }))
  loading.value = false
})

function formatDate(ts) {
  if (!ts) return ''
  const d = ts.toDate ? ts.toDate() : new Date(ts)
  return d.toLocaleDateString('uk-UA', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

const totalAwarded = computed(() => history.value.reduce((s, tx) => s + (tx.amount || 0), 0))
</script>

<template>
  <div class="flex flex-col gap-4">
    <div>
      <div class="flex items-center gap-2 mb-0.5">
        <ClipboardList :size="20" :stroke-width="2" class="text-amber-500" />
        <h1 class="text-2xl font-extrabold gradient-heading">Нарахування</h1>
      </div>
      <div class="flex items-center gap-1.5 text-slate-500 text-sm">
        Всього нараховано: <CoinDisplay :amount="totalAwarded" size="sm" />
      </div>
    </div>

    <div v-if="loading" class="flex flex-col items-center py-16 gap-3 text-slate-600">
      <Clock :size="40" :stroke-width="1" class="opacity-30" />
      <div class="text-sm">Завантаження...</div>
    </div>

    <div v-else-if="history.length === 0" class="text-center py-16 text-slate-600">
      <Inbox :size="48" :stroke-width="1" class="mx-auto mb-3 opacity-30" />
      <div class="font-bold text-slate-500">Нарахувань ще немає</div>
    </div>

    <div v-else class="flex flex-col gap-3">
      <AppCard v-for="tx in history" :key="tx.id">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 bg-amber-500/10 rounded-xl flex items-center justify-center flex-shrink-0">
            <Coins :size="18" :stroke-width="1.8" class="text-amber-400" />
          </div>
          <div class="flex-1 min-w-0">
            <div class="flex items-center justify-between gap-2">
              <CoinDisplay :amount="tx.amount" show-sign size="sm" />
              <div class="text-xs text-slate-600">{{ formatDate(tx.timestamp) }}</div>
            </div>
            <div class="text-sm font-semibold text-slate-200">{{ tx.toName }}</div>
            <div v-if="tx.note" class="text-xs text-slate-400 italic mt-0.5">"{{ tx.note }}"</div>
          </div>
        </div>
      </AppCard>
    </div>
  </div>
</template>
