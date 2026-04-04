<script setup>
import { ref, computed, onMounted } from 'vue'
import { useTradeStore } from '@/stores/trade'
import { useAuthStore } from '@/stores/auth'
import { useUserStore } from '@/stores/user'
import { useToast } from '@/composables/useToast'
import { useHaptic } from '@/composables/useHaptic'
import { checkAndGrantAchievements, updateQuestProgress, getAllClasses } from '@/firebase/collections'
import { trySystemNotify } from '@/utils/systemNotify'
import AppCard from '@/components/ui/AppCard.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppModal from '@/components/ui/AppModal.vue'
import AvatarDisplay from '@/components/avatar/AvatarDisplay.vue'
import CoinDisplay from '@/components/gamification/CoinDisplay.vue'
import ItemModelThumb from '@/components/character/ItemModelThumb.vue'
import { ArrowLeftRight, Inbox, Plus, Clock } from 'lucide-vue-next'

/** Match compact trade cards (~w-8); GLB/skin use same baked previews as shop */
const THUMB_CARD = { w: 32, h: 44 }
const THUMB_MODAL = { w: 36, h: 50 }
const THUMB_PICK = { w: 30, h: 42 }

const trade     = useTradeStore()
const auth      = useAuthStore()
const userStore = useUserStore()
const { success, error } = useToast()
const { success: hapticSuccess } = useHaptic()

const activeTab       = ref('incoming')
const showNewTrade    = ref(false)
const showDetail      = ref(null)   // full offer object for detail modal
const sending         = ref(false)
const accepting       = ref(false)
const studentSearch   = ref('')

const newTrade = ref({
  toUid: '',
  offeredCoins: 0,
  offeredItems: [],
  requestedCoins: 0,
  requestedItems: [],
})

const classMap = ref({})

onMounted(async () => {
  await Promise.all([trade.fetchClassmates(), userStore.fetchItems()])
  const classes = await getAllClasses()
  classMap.value = Object.fromEntries(classes.map(c => [c.id, c.name]))
})

// ─── Helpers ─────────────────────────────────────────────────────────────────
const myItems = computed(() =>
  userStore.items.filter(i => (auth.profile?.inventory || []).includes(i.id))
)

function getItem(id) {
  return userStore.items.find(i => i.id === id) || null
}

function getUser(uid) {
  return trade.classmates.find(s => s.id === uid) || null
}

const selectedClassmate = computed(() => trade.classmates.find(c => c.id === newTrade.value.toUid))
const classmateItems = computed(() => {
  if (!selectedClassmate.value) return []
  return userStore.items.filter(i => (selectedClassmate.value.inventory || []).includes(i.id))
})

const filteredStudents = computed(() => {
  const q = studentSearch.value.toLowerCase().trim()
  if (!q) return trade.classmates
  return trade.classmates.filter(s =>
    s.displayName?.toLowerCase().includes(q) ||
    classMap.value[s.classId]?.toLowerCase().includes(q)
  )
})

/** Унікальні записи з обох сторін (вхідні/вихідні історія), нові зверху */
const tradeHistoryMerged = computed(() => {
  const map = new Map()
  for (const o of [...trade.historyIncoming, ...trade.historyOutgoing]) {
    map.set(o.id, o)
  }
  const rows = [...map.values()]
  rows.sort((a, b) => {
    const ta = a.createdAt?.toMillis?.() ?? (a.createdAt?.seconds ? a.createdAt.seconds * 1000 : 0)
    const tb = b.createdAt?.toMillis?.() ?? (b.createdAt?.seconds ? b.createdAt.seconds * 1000 : 0)
    return tb - ta
  })
  return rows
})

function historyPartnerUid(offer) {
  if (!auth.profile?.id) return null
  return offer.fromUid === auth.profile.id ? offer.toUid : offer.fromUid
}

function formatCreated(ts) {
  if (!ts) return ''
  const d = ts.toDate ? ts.toDate() : new Date((ts.seconds ?? 0) * 1000)
  return d.toLocaleString('uk-UA', { dateStyle: 'short', timeStyle: 'short' })
}

function tradeStatusLabel(status) {
  if (status === 'accepted') return 'Виконано'
  if (status === 'declined') return 'Відхилено'
  return status || ''
}

/** Скільки «слотів» у стороні обміну (предмети + монети як один слот). */
function tradeSideSlotCount(offer, side) {
  const items = side === 'offered' ? offer.offeredItems : offer.requestedItems
  let n = (items && items.length) || 0
  const coins = side === 'offered' ? offer.offeredCoins : offer.requestedCoins
  if (coins > 0) n += 1
  return n
}

function toggleOfferedItem(id) {
  const idx = newTrade.value.offeredItems.indexOf(id)
  if (idx >= 0) newTrade.value.offeredItems.splice(idx, 1)
  else newTrade.value.offeredItems.push(id)
}

function toggleRequestedItem(id) {
  const idx = newTrade.value.requestedItems.indexOf(id)
  if (idx >= 0) newTrade.value.requestedItems.splice(idx, 1)
  else newTrade.value.requestedItems.push(id)
}

// ─── Actions ─────────────────────────────────────────────────────────────────
async function sendTrade() {
  if (!newTrade.value.toUid) { error('Оберіть учня'); return }
  const hasOffer   = newTrade.value.offeredCoins > 0   || newTrade.value.offeredItems.length > 0
  const hasRequest = newTrade.value.requestedCoins > 0 || newTrade.value.requestedItems.length > 0
  if (!hasOffer && !hasRequest) { error('Додайте хоча б щось до пропозиції'); return }
  sending.value = true
  try {
    await trade.sendOffer(newTrade.value)
    await updateQuestProgress(auth.profile.id, 'send_trade')
    hapticSuccess()
    success('Пропозицію обміну надіслано!')
    showNewTrade.value = false
    newTrade.value = { toUid: '', offeredCoins: 0, offeredItems: [], requestedCoins: 0, requestedItems: [] }
  } catch (e) {
    error(e.message)
  } finally {
    sending.value = false
  }
}

async function accept(offerId) {
  accepting.value = true
  try {
    await trade.acceptTrade(offerId)
    await checkAndGrantAchievements(auth.profile.id)
    await updateQuestProgress(auth.profile.id, 'trade')
    hapticSuccess()
    success('Обмін завершено! 🤝')
    void trySystemNotify('Обмін завершено!', 'Ти прийняв(ла) пропозицію 🤝', { tag: 'trade-accepted-self' })
    showDetail.value = null
  } catch (e) { error(e.message) }
  finally { accepting.value = false }
}

async function decline(offerId) {
  await trade.declineTrade(offerId)
  success('Пропозицію відхилено')
  showDetail.value = null
}

async function cancel(offerId) {
  await trade.cancelTrade(offerId)
  success('Пропозицію скасовано')
}

function formatExpiry(ts) {
  if (!ts) return ''
  const d = ts.toDate ? ts.toDate() : new Date(ts.seconds * 1000)
  const diff = (d - new Date()) / 3600000
  if (diff < 0) return 'Закінчилось'
  if (diff < 1) return `${Math.round(diff * 60)}хв`
  return `${Math.round(diff)}год`
}

const COIN_PRESETS = [5, 10, 25, 50, 100, 200]
</script>

<template>
  <div class="flex flex-col gap-4 animate-fade-in">
    <!-- Header -->
    <div class="flex items-center justify-between">
      <div>
        <div class="flex items-center gap-2 mb-0.5">
          <ArrowLeftRight :size="20" :stroke-width="2" class="text-violet-400" />
          <h1 class="text-2xl font-extrabold gradient-heading">Обмін</h1>
        </div>
        <p class="text-slate-500 text-sm">Обмінюйся монетами та предметами</p>
      </div>
      <AppButton variant="primary" size="sm" @click="showNewTrade = true">
        <Plus :size="15" :stroke-width="2.5" />
      </AppButton>
    </div>

    <!-- Tabs -->
    <div class="flex gap-1 p-1 rounded-2xl" style="background:rgba(255,255,255,0.04)">
      <button
        class="flex-1 py-1.5 rounded-xl font-bold text-xs min-[380px]:text-sm transition-all duration-200 relative"
        :class="activeTab === 'incoming' ? 'tab-active' : 'text-slate-500'"
        @click="activeTab = 'incoming'"
      >
        Вхідні
        <span v-if="trade.incoming.length > 0" class="absolute -top-0.5 -right-0.5 min-w-[1.15rem] h-[1.15rem] px-0.5 bg-red-500 text-white text-[10px] rounded-full flex items-center justify-center font-extrabold">{{ trade.incoming.length }}</span>
      </button>
      <button
        class="flex-1 py-1.5 rounded-xl font-bold text-xs min-[380px]:text-sm transition-all duration-200"
        :class="activeTab === 'outgoing' ? 'tab-active' : 'text-slate-500'"
        @click="activeTab = 'outgoing'"
      >Вихідні</button>
      <button
        class="flex-1 py-1.5 rounded-xl font-bold text-xs min-[380px]:text-sm transition-all duration-200"
        :class="activeTab === 'history' ? 'tab-active' : 'text-slate-500'"
        @click="activeTab = 'history'"
      >Історія</button>
    </div>

    <!-- ── Incoming ────────────────────────────────────────────────────── -->
    <div v-if="activeTab === 'incoming'">
      <div v-if="trade.incoming.length === 0" class="text-center py-12 text-slate-600">
        <Inbox :size="44" :stroke-width="1" class="mx-auto mb-3 opacity-30" />
        <div class="font-bold text-slate-500">Вхідних пропозицій немає</div>
      </div>
      <div v-else class="flex flex-col gap-3">
        <AppCard
          v-for="offer in trade.incoming"
          :key="offer.id"
          class="cursor-pointer hover:border-violet-500/50 transition-all"
          @click="showDetail = offer"
        >
          <!-- Partner row -->
          <div class="flex items-center gap-3 mb-3">
            <AvatarDisplay :avatar="getUser(offer.fromUid)?.avatar" :display-name="getUser(offer.fromUid)?.displayName || '?'" size="sm" />
            <div class="flex-1 min-w-0">
              <div class="font-bold text-sm">{{ getUser(offer.fromUid)?.displayName || 'Unknown' }}</div>
              <div class="flex items-center gap-0.5 text-xs text-orange-400 font-semibold">
                <Clock :size="11" :stroke-width="2" /> {{ formatExpiry(offer.expiresAt) }}
              </div>
            </div>
          </div>

          <!-- Offer / request summary -->
          <div class="grid grid-cols-2 gap-2 mb-3">
            <!-- Пропонує -->
            <div class="bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-2">
              <div class="text-[10px] font-extrabold text-emerald-400 mb-1.5">ПРОПОНУЄ В ОБМІН</div>
              <div v-if="offer.offeredCoins > 0" class="mb-1">
                <CoinDisplay :amount="offer.offeredCoins" size="sm" />
              </div>
              <div class="flex flex-wrap gap-1">
                <div
                  v-for="id in (offer.offeredItems || [])" :key="id"
                  class="flex-shrink-0"
                  :title="getItem(id)?.name"
                >
                  <ItemModelThumb :item="getItem(id)" :width="THUMB_CARD.w" :height="THUMB_CARD.h" />
                </div>
                <div v-if="!offer.offeredCoins && !(offer.offeredItems?.length)" class="text-xs text-slate-500 italic">нічого</div>
              </div>
            </div>

            <!-- Просить -->
            <div class="bg-violet-500/10 border border-violet-500/20 rounded-xl p-2">
              <div class="text-[10px] font-extrabold text-violet-400 mb-1.5">ПРОСИТЬ НАТОМІСТЬ</div>
              <div v-if="offer.requestedCoins > 0" class="mb-1">
                <CoinDisplay :amount="offer.requestedCoins" size="sm" />
              </div>
              <div class="flex flex-wrap gap-1">
                <div
                  v-for="id in (offer.requestedItems || [])" :key="id"
                  class="flex-shrink-0"
                  :title="getItem(id)?.name"
                >
                  <ItemModelThumb :item="getItem(id)" :width="THUMB_CARD.w" :height="THUMB_CARD.h" />
                </div>
                <div v-if="!offer.requestedCoins && !(offer.requestedItems?.length)" class="text-xs text-slate-500 italic">нічого</div>
              </div>
            </div>
          </div>

          <div class="flex gap-2">
            <AppButton variant="primary" size="sm" class="flex-1" @click.stop="accept(offer.id)">✓ Прийняти</AppButton>
            <AppButton variant="danger"  size="sm" class="flex-1" @click.stop="decline(offer.id)">✕ Відхилити</AppButton>
          </div>
        </AppCard>
      </div>
    </div>

    <!-- ── Outgoing ────────────────────────────────────────────────────── -->
    <div v-if="activeTab === 'outgoing'">
      <div v-if="trade.outgoing.length === 0" class="text-center py-12 text-slate-600">
        <Inbox :size="44" :stroke-width="1" class="mx-auto mb-3 opacity-30" />
        <div class="font-bold">Вихідних пропозицій немає</div>
        <div class="text-sm mt-1">Надішли пропозицію будь-якому учню</div>
      </div>
      <div v-else class="flex flex-col gap-3">
        <AppCard
          v-for="offer in trade.outgoing"
          :key="offer.id"
          class="cursor-pointer hover:border-violet-500/40 transition-all"
          @click="showDetail = offer"
        >
          <div class="flex items-center gap-3 mb-3">
            <AvatarDisplay :avatar="getUser(offer.toUid)?.avatar" :display-name="getUser(offer.toUid)?.displayName || '?'" size="sm" />
            <div class="flex-1 min-w-0">
              <div class="font-bold text-sm">→ {{ getUser(offer.toUid)?.displayName || 'Unknown' }}</div>
              <div class="flex items-center gap-0.5 text-xs text-orange-400 font-semibold">
                <Clock :size="11" :stroke-width="2" /> {{ formatExpiry(offer.expiresAt) }}
              </div>
            </div>
            <AppButton variant="ghost" size="sm" @click.stop="cancel(offer.id)">Скасувати</AppButton>
          </div>

          <div class="grid grid-cols-2 gap-2">
            <div class="bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-2">
              <div class="text-[10px] font-extrabold text-emerald-400 mb-1.5">ПРОПОНУЮ В ОБМІН</div>
              <div v-if="offer.offeredCoins > 0" class="mb-1"><CoinDisplay :amount="offer.offeredCoins" size="sm" /></div>
              <div class="flex flex-wrap gap-1">
                <div
                  v-for="id in (offer.offeredItems || [])" :key="id"
                  class="flex-shrink-0"
                  :title="getItem(id)?.name"
                >
                  <ItemModelThumb :item="getItem(id)" :width="THUMB_CARD.w" :height="THUMB_CARD.h" />
                </div>
                <div v-if="!offer.offeredCoins && !(offer.offeredItems?.length)" class="text-xs text-slate-500 italic">нічого</div>
              </div>
            </div>
            <div class="bg-violet-500/10 border border-violet-500/20 rounded-xl p-2">
              <div class="text-[10px] font-extrabold text-violet-400 mb-1.5">ПРОШУ НАТОМІСТЬ</div>
              <div v-if="offer.requestedCoins > 0" class="mb-1"><CoinDisplay :amount="offer.requestedCoins" size="sm" /></div>
              <div class="flex flex-wrap gap-1">
                <div
                  v-for="id in (offer.requestedItems || [])" :key="id"
                  class="flex-shrink-0"
                  :title="getItem(id)?.name"
                >
                  <ItemModelThumb :item="getItem(id)" :width="THUMB_CARD.w" :height="THUMB_CARD.h" />
                </div>
                <div v-if="!offer.requestedCoins && !(offer.requestedItems?.length)" class="text-xs text-slate-500 italic">нічого</div>
              </div>
            </div>
          </div>
        </AppCard>
      </div>
    </div>

    <!-- ── History (accepted / declined) ─────────────────────────────── -->
    <div v-if="activeTab === 'history'">
      <div v-if="tradeHistoryMerged.length === 0" class="text-center py-12 text-slate-600">
        <Clock :size="44" :stroke-width="1" class="mx-auto mb-3 opacity-30" />
        <div class="font-bold text-slate-500">Ще немає завершених обмінів</div>
        <div class="text-sm mt-1 text-slate-600">Прийняті та відхилені з’являться тут</div>
      </div>
      <div v-else class="flex flex-col gap-3">
        <p class="text-[11px] text-slate-500 leading-snug -mt-1">
          Як у вкладці «Вихідні»: зліва — <span class="text-slate-400">що запропонували в обмін</span>, справа —
          <span class="text-slate-400">що просили натомість у відповідь</span> (з погляду того, хто надіслав пропозицію).
        </p>
        <AppCard
          v-for="offer in tradeHistoryMerged"
          :key="offer.id"
          class="cursor-pointer hover:border-violet-500/40 transition-all"
          @click="showDetail = offer"
        >
          <div class="flex items-center justify-between gap-2 mb-3">
            <div class="flex items-center gap-2 min-w-0">
              <AvatarDisplay
                :avatar="getUser(historyPartnerUid(offer))?.avatar"
                :display-name="getUser(historyPartnerUid(offer))?.displayName || '?'"
                size="sm"
              />
              <div class="min-w-0">
                <div class="font-bold text-sm truncate">{{ getUser(historyPartnerUid(offer))?.displayName || 'Unknown' }}</div>
                <div class="text-[11px] text-slate-500">{{ formatCreated(offer.createdAt) }}</div>
              </div>
            </div>
            <span
              class="shrink-0 text-[10px] font-extrabold uppercase px-2 py-1 rounded-lg"
              :class="offer.status === 'accepted' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-slate-500/20 text-slate-400'"
            >{{ tradeStatusLabel(offer.status) }}</span>
          </div>
          <div class="grid grid-cols-2 gap-2">
            <div class="bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-2">
              <div class="text-[10px] font-extrabold text-emerald-400 mb-1.5 leading-tight">ЗАПРОПОНОВАНО В ОБМІН</div>
              <div v-if="offer.offeredCoins > 0" class="mb-1">
                <CoinDisplay :amount="offer.offeredCoins" size="sm" />
              </div>
              <div class="flex flex-wrap gap-1">
                <div
                  v-for="id in (offer.offeredItems || [])"
                  :key="id"
                  class="flex-shrink-0"
                  :title="getItem(id)?.name"
                >
                  <ItemModelThumb :item="getItem(id)" :width="THUMB_CARD.w" :height="THUMB_CARD.h" />
                </div>
                <div v-if="!offer.offeredCoins && !(offer.offeredItems?.length)" class="text-xs text-slate-500 italic">нічого</div>
              </div>
            </div>
            <div class="bg-violet-500/10 border border-violet-500/20 rounded-xl p-2">
              <div class="text-[10px] font-extrabold text-violet-400 mb-1.5 leading-tight">ПРОСИЛИ НАТОМІСТЬ</div>
              <div v-if="offer.requestedCoins > 0" class="mb-1">
                <CoinDisplay :amount="offer.requestedCoins" size="sm" />
              </div>
              <div class="flex flex-wrap gap-1">
                <div
                  v-for="id in (offer.requestedItems || [])"
                  :key="id"
                  class="flex-shrink-0"
                  :title="getItem(id)?.name"
                >
                  <ItemModelThumb :item="getItem(id)" :width="THUMB_CARD.w" :height="THUMB_CARD.h" />
                </div>
                <div v-if="!offer.requestedCoins && !(offer.requestedItems?.length)" class="text-xs text-slate-500 italic">нічого</div>
              </div>
            </div>
          </div>
          <div class="text-[10px] text-slate-500 mt-2 tabular-nums">
            Запропоновано: {{ tradeSideSlotCount(offer, 'offered') }} поз.
            · Просили натомість: {{ tradeSideSlotCount(offer, 'requested') }} поз.
          </div>
        </AppCard>
      </div>
    </div>

    <!-- ── Trade detail modal ─────────────────────────────────────────── -->
    <AppModal :model-value="!!showDetail" title="Деталі обміну" @update:model-value="v => { if (!v) showDetail = null }">
      <div v-if="showDetail" class="flex flex-col gap-4">
        <div
          v-if="showDetail.status && showDetail.status !== 'pending'"
          class="rounded-xl px-3 py-2 text-sm font-bold text-center"
          :class="showDetail.status === 'accepted' ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/25' : 'bg-slate-500/15 text-slate-400 border border-slate-500/25'"
        >
          {{ tradeStatusLabel(showDetail.status) }}
          <span class="font-normal text-slate-500 text-xs block mt-0.5">{{ formatCreated(showDetail.createdAt) }}</span>
        </div>
        <!-- Partner -->
        <div class="flex items-center gap-3">
          <AvatarDisplay
            :avatar="getUser(showDetail.fromUid === auth.profile?.id ? showDetail.toUid : showDetail.fromUid)?.avatar"
            :display-name="getUser(showDetail.fromUid === auth.profile?.id ? showDetail.toUid : showDetail.fromUid)?.displayName || '?'"
            size="md"
          />
          <div>
            <div class="font-extrabold">{{ getUser(showDetail.fromUid === auth.profile?.id ? showDetail.toUid : showDetail.fromUid)?.displayName || 'Unknown' }}</div>
              <div
                v-if="showDetail.status === 'pending'"
                class="flex items-center gap-0.5 text-xs text-orange-400"
              >
                <Clock :size="11" :stroke-width="2" /> {{ formatExpiry(showDetail.expiresAt) }}
              </div>
          </div>
        </div>

        <div class="grid grid-cols-2 gap-3">
          <!-- Пропонує -->
          <div class="bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-3">
            <div class="text-xs font-extrabold text-emerald-400 mb-2">ПРОПОНУЄ <span class="font-semibold text-emerald-400/65">в обмін</span></div>
            <div v-if="showDetail.offeredCoins > 0" class="mb-2"><CoinDisplay :amount="showDetail.offeredCoins" size="sm" /></div>
            <div class="flex flex-col gap-2">
              <div v-for="id in (showDetail.offeredItems || [])" :key="id" class="flex items-center gap-2">
                <ItemModelThumb :item="getItem(id)" :width="THUMB_MODAL.w" :height="THUMB_MODAL.h" />
                <div class="min-w-0">
                  <div class="text-xs font-bold truncate">{{ getItem(id)?.name || id }}</div>
                </div>
              </div>
              <div v-if="!showDetail.offeredCoins && !(showDetail.offeredItems?.length)" class="text-xs text-slate-500 italic">нічого</div>
            </div>
          </div>

          <!-- Просить -->
          <div class="bg-violet-500/10 border border-violet-500/20 rounded-xl p-3">
            <div class="text-xs font-extrabold text-violet-400 mb-2">ПРОСИТЬ <span class="font-semibold text-violet-400/65">натомість</span></div>
            <div v-if="showDetail.requestedCoins > 0" class="mb-2"><CoinDisplay :amount="showDetail.requestedCoins" size="sm" /></div>
            <div class="flex flex-col gap-2">
              <div v-for="id in (showDetail.requestedItems || [])" :key="id" class="flex items-center gap-2">
                <ItemModelThumb :item="getItem(id)" :width="THUMB_MODAL.w" :height="THUMB_MODAL.h" />
                <div class="min-w-0">
                  <div class="text-xs font-bold truncate">{{ getItem(id)?.name || id }}</div>
                </div>
              </div>
              <div v-if="!showDetail.requestedCoins && !(showDetail.requestedItems?.length)" class="text-xs text-slate-500 italic">нічого</div>
            </div>
          </div>
        </div>

        <!-- Actions: лише активні (pending) пропозиції -->
        <div v-if="showDetail.status === 'pending' && showDetail.toUid === auth.profile?.id" class="flex gap-2">
          <AppButton variant="primary" size="lg" class="flex-1" :loading="accepting" @click="accept(showDetail.id)">✓ Прийняти</AppButton>
          <AppButton variant="danger"  size="lg" class="flex-1" @click="decline(showDetail.id)">✕ Відхилити</AppButton>
        </div>
        <div v-else-if="showDetail.status === 'pending'">
          <AppButton variant="ghost" block @click="cancel(showDetail.id)">Скасувати пропозицію</AppButton>
        </div>
      </div>
    </AppModal>

    <!-- ── New Trade Modal ────────────────────────────────────────────── -->
    <AppModal v-model="showNewTrade" title="Нова пропозиція обміну" size="lg">
      <div class="flex flex-col gap-5">
        <!-- Pick student -->
        <div>
          <label class="text-sm font-bold text-slate-300 block mb-2">Обмінятися з</label>
          <input
            v-model="studentSearch"
            placeholder="🔍 Пошук учня або класу..."
            class="w-full bg-game-bg border border-game-border rounded-xl px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-violet-500 mb-2"
          />
          <div class="flex flex-col gap-2 max-h-44 overflow-y-auto">
            <label
              v-for="cm in filteredStudents" :key="cm.id"
              class="flex items-center gap-3 glass-card p-2.5 cursor-pointer"
              :class="newTrade.toUid === cm.id ? 'border-violet-500 glow-primary' : ''"
            >
              <input type="radio" :value="cm.id" v-model="newTrade.toUid" class="accent-violet-500 w-4 h-4" />
              <AvatarDisplay :avatar="cm.avatar" :display-name="cm.displayName" size="xs" />
              <span class="font-semibold text-sm flex-1 truncate">{{ cm.displayName }}</span>
              <span v-if="classMap[cm.classId]" class="text-[10px] font-bold text-slate-400 bg-game-card px-1.5 py-0.5 rounded-md flex-shrink-0">{{ classMap[cm.classId] }}</span>
              <CoinDisplay :amount="cm.coins || 0" size="sm" />
            </label>
            <div v-if="filteredStudents.length === 0" class="text-center py-4 text-slate-500 text-sm">Нікого не знайдено</div>
          </div>
        </div>

        <div class="grid grid-cols-2 gap-4">
          <!-- I Offer -->
          <div>
            <div class="text-sm font-extrabold text-emerald-400 mb-2">Я пропоную</div>
            <div class="text-xs text-slate-400 mb-1">Монети</div>
            <div class="flex flex-wrap gap-1 mb-2">
              <button v-for="p in COIN_PRESETS" :key="p"
                class="text-xs px-2 py-1 rounded-lg font-bold transition-all"
                :class="newTrade.offeredCoins === p ? 'bg-amber-500 text-slate-900' : 'bg-game-card text-slate-400'"
                @click="newTrade.offeredCoins = p">{{ p }}</button>
            </div>
            <input v-model="newTrade.offeredCoins" type="number" min="0"
              class="w-full bg-game-bg border border-game-border rounded-lg px-3 py-2 text-amber-400 font-bold text-sm focus:outline-none focus:border-amber-500 mb-2" />

            <div class="text-xs text-slate-400 mb-1">Мої предмети</div>
            <div class="flex flex-col gap-1.5 max-h-36 overflow-y-auto">
              <label v-for="item in myItems" :key="item.id"
                class="flex items-center gap-2 p-1.5 rounded-lg cursor-pointer transition-all"
                :class="newTrade.offeredItems.includes(item.id) ? 'bg-emerald-600/20 border border-emerald-500/30' : 'bg-game-card/50'">
                <input type="checkbox" :checked="newTrade.offeredItems.includes(item.id)" @change="toggleOfferedItem(item.id)" class="accent-emerald-500 w-3 h-3 flex-shrink-0" />
                <ItemModelThumb :item="item" :width="THUMB_PICK.w" :height="THUMB_PICK.h" />
                <span class="text-xs font-semibold truncate">{{ item.name }}</span>
              </label>
              <div v-if="myItems.length === 0" class="text-xs text-slate-500 py-2 text-center">Предметів немає</div>
            </div>
          </div>

          <!-- I Want -->
          <div>
            <div class="text-sm font-extrabold text-violet-400 mb-2">Я хочу</div>
            <div class="text-xs text-slate-400 mb-1">Монети</div>
            <div class="flex flex-wrap gap-1 mb-2">
              <button v-for="p in COIN_PRESETS" :key="p"
                class="text-xs px-2 py-1 rounded-lg font-bold transition-all"
                :class="newTrade.requestedCoins === p ? 'bg-violet-500 text-white' : 'bg-game-card text-slate-400'"
                @click="newTrade.requestedCoins = p">{{ p }}</button>
            </div>
            <input v-model="newTrade.requestedCoins" type="number" min="0"
              class="w-full bg-game-bg border border-game-border rounded-lg px-3 py-2 text-violet-300 font-bold text-sm focus:outline-none focus:border-violet-500 mb-2" />

            <div class="text-xs text-slate-400 mb-1">Їх предмети</div>
            <div class="flex flex-col gap-1.5 max-h-36 overflow-y-auto">
              <div v-if="!selectedClassmate" class="text-xs text-slate-500 py-2 text-center">Спочатку оберіть учня</div>
              <label v-for="item in classmateItems" :key="item.id"
                class="flex items-center gap-2 p-1.5 rounded-lg cursor-pointer transition-all"
                :class="newTrade.requestedItems.includes(item.id) ? 'bg-violet-600/20 border border-violet-500/30' : 'bg-game-card/50'">
                <input type="checkbox" :checked="newTrade.requestedItems.includes(item.id)" @change="toggleRequestedItem(item.id)" class="accent-violet-500 w-3 h-3 flex-shrink-0" />
                <ItemModelThumb :item="item" :width="THUMB_PICK.w" :height="THUMB_PICK.h" />
                <span class="text-xs font-semibold truncate">{{ item.name }}</span>
              </label>
              <div v-if="selectedClassmate && classmateItems.length === 0" class="text-xs text-slate-500 py-2 text-center">Предметів немає</div>
            </div>
          </div>
        </div>

        <AppButton variant="primary" block :loading="sending" @click="sendTrade">
          Надіслати пропозицію
        </AppButton>
      </div>
    </AppModal>
  </div>
</template>
