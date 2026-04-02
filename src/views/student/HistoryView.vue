<script setup>
import { ref, onMounted } from 'vue'
import { doc, getDoc } from 'firebase/firestore'
import { db } from '@/firebase/config'
import { useAuthStore } from '@/stores/auth'
import { useUserStore } from '@/stores/user'
import { getTransactionHistory } from '@/firebase/collections'
import AppCard from '@/components/ui/AppCard.vue'
import AppButton from '@/components/ui/AppButton.vue'
import CoinDisplay from '@/components/gamification/CoinDisplay.vue'
import {
  BookOpen, Coins, ArrowLeftRight, ShoppingBag, Trophy, Flame, ScrollText, Star,
  Clock, Inbox, Package, Gavel, Gift,
} from 'lucide-vue-next'

const auth      = useAuthStore()
const userStore = useUserStore()
const history   = ref([])
const loading     = ref(true)
const loadingMore = ref(false)
const hasMore     = ref(false)
const PAGE        = 30

const nameCache = {}

async function resolveName(uid) {
  if (!uid || uid === auth.profile?.id) return null
  if (nameCache[uid]) return nameCache[uid]
  try {
    const snap = await getDoc(doc(db, 'users', uid))
    const name = snap.exists() ? (snap.data().displayName || 'Невідомо') : 'Невідомо'
    nameCache[uid] = name
    return name
  } catch { return 'Невідомо' }
}

async function enrich(txs) {
  const uids = [...new Set(txs.map(t => t.fromUid).filter(Boolean))]
  await Promise.all(uids.map(resolveName))
  return txs.map(tx => ({ ...tx, fromName: nameCache[tx.fromUid] || null }))
}

async function load(lim) {
  const raw = await getTransactionHistory(auth.profile?.id, lim)
  hasMore.value = raw.length === lim
  history.value = await enrich(raw)
}

onMounted(async () => {
  loading.value = true
  await load(PAGE)
  loading.value = false
})

async function loadMore() {
  loadingMore.value = true
  await load(history.value.length + PAGE)
  loadingMore.value = false
}

function getItem(id) { return userStore.items.find(i => i.id === id) || null }

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

const TX = {
  award:              { Icon: Coins,          label: 'Нарахування',      color: 'text-amber-400',   bg: 'bg-amber-500/10'   },
  fine:               { Icon: Gavel,          label: 'Штраф',            color: 'text-red-400',     bg: 'bg-red-500/10'     },
  trade:              { Icon: ArrowLeftRight,  label: 'Обмін',            color: 'text-blue-400',    bg: 'bg-blue-500/10'    },
  purchase:           { Icon: ShoppingBag,     label: 'Покупка',          color: 'text-violet-400',  bg: 'bg-violet-500/10'  },
  box_open:           { Icon: Gift,            label: 'Магічна коробка',  color: 'text-amber-400',   bg: 'bg-amber-500/10'   },
  achievement_reward: { Icon: Trophy,          label: 'Досягнення',       color: 'text-emerald-400', bg: 'bg-emerald-500/10' },
  streak_bonus:       { Icon: Flame,           label: 'Бонус серії',      color: 'text-orange-400',  bg: 'bg-orange-500/10'  },
  quest_reward:       { Icon: ScrollText,      label: 'Завдання виконано', color: 'text-violet-300', bg: 'bg-violet-500/10'  },
}
const cfg = t => TX[t] || { Icon: Star, label: t, color: 'text-slate-400', bg: 'bg-slate-500/10' }
</script>

<template>
  <div class="flex flex-col gap-4 animate-fade-in">
    <!-- Header -->
    <div>
      <div class="flex items-center gap-2 mb-0.5">
        <BookOpen :size="20" :stroke-width="2" class="text-amber-500" />
        <h1 class="text-2xl font-extrabold gradient-heading">Журнал</h1>
      </div>
      <p class="text-slate-500 text-sm">Усі твої надходження та активність</p>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="flex flex-col items-center py-16 gap-3 text-slate-600">
      <Clock :size="40" :stroke-width="1" class="opacity-30" />
      <div class="text-sm">Завантаження...</div>
    </div>

    <!-- Empty -->
    <div v-else-if="history.length === 0" class="flex flex-col items-center py-16 gap-3 text-slate-600">
      <Inbox :size="48" :stroke-width="1" class="opacity-30" />
      <div class="font-bold text-slate-500">Активності поки немає</div>
      <div class="text-sm text-center">Тут з'являться нарахування від вчителів,<br>бонуси та обміни</div>
    </div>

    <!-- List -->
    <div v-else class="flex flex-col gap-2">
      <AppCard
        v-for="tx in history"
        :key="tx.id"
        class="flex flex-col gap-2 !py-3"
      >
        <div class="flex items-center gap-3">
          <!-- Icon -->
          <div :class="['w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0', cfg(tx.type).bg, cfg(tx.type).color]">
            <component :is="cfg(tx.type).Icon" :size="18" :stroke-width="1.8" />
          </div>

          <!-- Details -->
          <div class="flex-1 min-w-0">
            <div class="font-extrabold text-sm">{{ cfg(tx.type).label }}</div>
            <div v-if="tx.fromName" class="text-xs text-slate-400">
              від <span class="text-slate-300 font-semibold">{{ tx.fromName }}</span>
            </div>
            <div v-if="tx.note" class="text-xs text-slate-300 italic mt-0.5">"{{ tx.note }}"</div>
            <div class="text-xs text-slate-600 mt-0.5">{{ formatDate(tx.timestamp) }}</div>
          </div>

          <!-- Amount -->
          <CoinDisplay :amount="tx.amount" :show-sign="tx.amount > 0" size="sm" class="flex-shrink-0" />
        </div>

        <!-- Item previews for trades / purchases -->
        <div v-if="tx.itemIds?.length" class="flex items-center gap-2 flex-wrap pl-13">
          <div
            v-for="itemId in tx.itemIds"
            :key="itemId"
            class="flex items-center gap-1.5 rounded-lg px-2 py-1"
            style="background:rgba(255,255,255,0.04)"
            :title="getItem(itemId)?.name"
          >
            <div class="w-5 h-7 flex-shrink-0 overflow-hidden rounded">
              <img
                v-if="getItem(itemId)?.skinUrl"
                :src="getItem(itemId).skinUrl"
                :alt="getItem(itemId).name"
                class="w-full h-full object-contain"
                style="image-rendering: pixelated; image-rendering: crisp-edges"
              />
              <div v-else class="w-full h-full flex items-center justify-center text-slate-500">
                <Package :size="14" :stroke-width="1.5" />
              </div>
            </div>
            <span class="text-xs font-semibold text-slate-300 max-w-[80px] truncate">
              {{ getItem(itemId)?.name || itemId }}
            </span>
          </div>
        </div>
      </AppCard>

      <AppButton v-if="hasMore" variant="secondary" block :loading="loadingMore" @click="loadMore">
        Завантажити більше
      </AppButton>
    </div>
  </div>
</template>
