import { defineStore } from 'pinia'
import { ref } from 'vue'
import {
  createTrade,
  watchIncomingTrades,
  watchOutgoingTrades,
  watchIncomingTradeHistory,
  watchOutgoingTradeHistory,
  updateTrade,
  executeTrade,
  getAllStudents,
  getTrade,
  updateQuestProgress,
  checkAndGrantAchievements,
} from '@/firebase/collections'
import { useUserStore } from './user'
import { useAuthStore } from './auth'
import { trySystemNotify } from '@/utils/systemNotify'
import { useToast } from '@/composables/useToast'

export const useTradeStore = defineStore('trade', () => {
  const { info: toastInfo, success: toastSuccess } = useToast()
  const incoming = ref([])
  const outgoing = ref([])
  const historyIncoming = ref([])
  const historyOutgoing = ref([])
  const classmates = ref([])
  const loading = ref(false)

  let unsubIn = null
  let unsubOut = null
  let unsubHistIn = null
  let unsubHistOut = null

  function initListeners() {
    const auth = useAuthStore()
    if (!auth.profile) return
    const uid = auth.profile.id
    if (unsubIn) unsubIn()
    if (unsubOut) unsubOut()
    if (unsubHistIn) unsubHistIn()
    if (unsubHistOut) unsubHistOut()

    let skipIncomingNotify = true
    let prevIncomingIds = new Set()

    unsubIn = watchIncomingTrades(uid, (data) => {
      if (skipIncomingNotify) {
        skipIncomingNotify = false
        prevIncomingIds = new Set(data.map((d) => d.id))
        incoming.value = data
        incomingCount.value = data.length
        return
      }
      const nextIds = new Set(data.map((d) => d.id))
      for (const id of prevIncomingIds) {
        if (!nextIds.has(id)) {
          void (async () => {
            try {
              const t = await getTrade(id)
              if (t?.status === 'declined' && t.declinedBy === 'from') {
                toastInfo('Відправник скасував пропозицію обміну')
                await trySystemNotify(
                  'Пропозицію скасовано',
                  'Відправник відкликав обмін',
                  { tag: `trade-cancel-${id}` },
                )
              }
            } catch {
              /* ignore */
            }
          })()
        }
      }
      for (const row of data) {
        if (!prevIncomingIds.has(row.id)) {
          toastInfo('Нова пропозиція обміну — відкрий вкладку «Обмін»')
          void trySystemNotify(
            'Нова пропозиція обміну',
            'Відкрий вкладку «Обмін», щоб переглянути',
            { tag: `trade-in-${row.id}` },
          )
        }
      }
      prevIncomingIds = nextIds
      incoming.value = data
      incomingCount.value = data.length
    })

    let skipOutgoingNotify = true
    let prevOutgoingMap = new Map()

    unsubOut = watchOutgoingTrades(uid, (data) => {
      if (skipOutgoingNotify) {
        skipOutgoingNotify = false
        prevOutgoingMap = new Map(data.map((d) => [d.id, d]))
        outgoing.value = data
        return
      }
      const nextMap = new Map(data.map((d) => [d.id, d]))
      for (const [id] of prevOutgoingMap) {
        if (!nextMap.has(id)) {
          void (async () => {
            try {
              const t = await getTrade(id)
              if (t?.status === 'accepted') {
                toastSuccess('Обмін виконано! Твою пропозицію прийнято 🤝')
                await trySystemNotify(
                  'Обмін виконано!',
                  'Твою пропозицію прийнято 🤝',
                  { tag: `trade-done-${id}` },
                )
                try {
                  const granted = await checkAndGrantAchievements(uid)
                  if (granted?.length > 0) auth.newAchievements = granted
                  await updateQuestProgress(uid, 'trade')
                  await useUserStore().fetchQuests()
                } catch (e) {
                  console.warn('[trade] post-accept sync:', e?.message || e)
                }
              } else if (t?.status === 'declined' && t.declinedBy === 'to') {
                toastInfo('Пропозицію обміну відхилено')
                await trySystemNotify(
                  'Пропозицію відхилено',
                  'Можна надіслати іншу угоду',
                  { tag: `trade-out-${id}` },
                )
              }
            } catch {
              /* ignore */
            }
          })()
        }
      }
      prevOutgoingMap = nextMap
      outgoing.value = data
    })

    unsubHistIn = watchIncomingTradeHistory(uid, (data) => {
      historyIncoming.value = data
    })
    unsubHistOut = watchOutgoingTradeHistory(uid, (data) => {
      historyOutgoing.value = data
    })
  }

  function teardown() {
    if (unsubIn) {
      unsubIn()
      unsubIn = null
    }
    if (unsubOut) {
      unsubOut()
      unsubOut = null
    }
    if (unsubHistIn) {
      unsubHistIn()
      unsubHistIn = null
    }
    if (unsubHistOut) {
      unsubHistOut()
      unsubHistOut = null
    }
  }

  async function fetchClassmates() {
    const auth = useAuthStore()
    if (!auth.profile) return
    const all = await getAllStudents()
    classmates.value = all.filter((s) => s.id !== auth.profile.id)
  }

  async function sendOffer({ toUid, offeredCoins, offeredItems, requestedCoins, requestedItems }) {
    const auth = useAuthStore()
    loading.value = true
    try {
      const id = await createTrade({
        fromUid: auth.profile.id,
        toUid,
        offeredCoins: offeredCoins || 0,
        offeredItems: offeredItems || [],
        requestedCoins: requestedCoins || 0,
        requestedItems: requestedItems || [],
      })
      return id
    } finally {
      loading.value = false
    }
  }

  async function acceptTrade(tradeId) {
    loading.value = true
    try {
      await executeTrade(tradeId)
    } finally {
      loading.value = false
    }
  }

  async function declineTrade(tradeId) {
    await updateTrade(tradeId, { status: 'declined', declinedBy: 'to' })
  }

  async function cancelTrade(tradeId) {
    await updateTrade(tradeId, { status: 'declined', declinedBy: 'from' })
  }

  const incomingCount = ref(0)

  return {
    incoming,
    outgoing,
    historyIncoming,
    historyOutgoing,
    classmates,
    loading,
    incomingCount,
    initListeners,
    teardown,
    fetchClassmates,
    sendOffer,
    acceptTrade,
    declineTrade,
    cancelTrade,
  }
})
