<script setup>
import { ref, computed, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useUserStore } from '@/stores/user'
import { getAwardHistory } from '@/firebase/collections'
import { enrichTeacherAwardRows } from '@/composables/useTransactionFeed'
import AvatarDisplay from '@/components/avatar/AvatarDisplay.vue'
import CoinDisplay from '@/components/gamification/CoinDisplay.vue'
import { ClipboardList, Clock, Inbox } from 'lucide-vue-next'

const auth      = useAuthStore()
const userStore = useUserStore()
const history   = ref([])
const loading   = ref(true)

onMounted(async () => {
  loading.value = true
  try {
    if (!userStore.items.length) await userStore.fetchItems()
    const raw = await getAwardHistory(auth.profile.id)
    history.value = await enrichTeacherAwardRows(raw)
  } finally {
    loading.value = false
  }
})

function formatDate(ts) {
  if (!ts) return ''
  const d = ts.toDate ? ts.toDate() : new Date(ts)
  return d.toLocaleDateString('uk-UA', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
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

    <div v-else class="flex flex-col gap-2.5">
      <div
        v-for="tx in history"
        :key="tx.id"
        class="rounded-2xl border border-white/[0.07] bg-white/[0.03] backdrop-blur-sm p-3.5"
      >
        <div class="flex gap-3">
          <AvatarDisplay
            v-if="tx.studentProfile"
            circle-only
            :avatar="tx.studentProfile.avatar"
            :display-name="tx.studentProfile.displayName"
            :items="userStore.items"
            size="sm"
            class="shrink-0 shadow-lg shadow-black/30 ring-2 ring-white/15 !ring-offset-0"
          />
          <div
            v-else
            class="w-12 h-12 shrink-0 rounded-2xl bg-amber-500/12 ring-1 ring-amber-500/25 flex items-center justify-center text-amber-400 font-extrabold text-sm"
          >
            ?
          </div>

          <div class="flex-1 min-w-0 flex flex-col gap-2">
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0">
                <div class="font-extrabold text-[15px] text-white leading-tight tracking-tight">
                  Нарахування монет
                </div>
                <div class="mt-1 text-sm font-semibold text-slate-200 truncate">
                  {{ tx.studentProfile?.displayName || 'Учень' }}
                </div>
                <span
                  class="inline-block mt-1 text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-md bg-white/[0.06] text-slate-400"
                >
                  Учень
                </span>
              </div>
              <CoinDisplay :amount="tx.amount" show-sign size="sm" class="shrink-0 pt-0.5" />
            </div>

            <div
              v-if="tx.note"
              class="rounded-xl border border-white/[0.06] bg-black/25 px-3 py-2 text-sm text-slate-200/95 leading-snug"
            >
              <span class="text-slate-500 text-[10px] font-bold uppercase tracking-wider block mb-1">
                Коментар для учня
              </span>
              {{ tx.note }}
            </div>

            <div class="text-[11px] font-medium text-slate-500 tabular-nums">
              {{ formatDate(tx.timestamp) }}
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
