import { defineStore } from 'pinia'
import { ref } from 'vue'
import {
  createTrade, watchIncomingTrades, watchOutgoingTrades,
  updateTrade, executeTrade, getAllStudents,
} from '@/firebase/collections'
import { useAuthStore } from './auth'

export const useTradeStore = defineStore('trade', () => {
  const incoming = ref([])
  const outgoing = ref([])
  const classmates = ref([])
  const loading  = ref(false)

  let unsubIn = null, unsubOut = null

  function initListeners() {
    const auth = useAuthStore()
    if (!auth.profile) return
    const uid = auth.profile.id
    if (unsubIn)  unsubIn()
    if (unsubOut) unsubOut()
    unsubIn  = watchIncomingTrades(uid, data => { incoming.value = data })
    unsubOut = watchOutgoingTrades(uid, data => { outgoing.value = data })
  }

  function teardown() {
    if (unsubIn)  { unsubIn();  unsubIn  = null }
    if (unsubOut) { unsubOut(); unsubOut = null }
  }

  async function fetchClassmates() {
    const auth = useAuthStore()
    if (!auth.profile) return
    const all = await getAllStudents()
    classmates.value = all.filter(s => s.id !== auth.profile.id)
  }

  async function sendOffer({ toUid, offeredCoins, offeredItems, requestedCoins, requestedItems }) {
    const auth = useAuthStore()
    loading.value = true
    try {
      const id = await createTrade({
        fromUid: auth.profile.id,
        toUid,
        offeredCoins:   offeredCoins   || 0,
        offeredItems:   offeredItems   || [],
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
    await updateTrade(tradeId, { status: 'declined' })
  }

  async function cancelTrade(tradeId) {
    await updateTrade(tradeId, { status: 'declined' })
  }

  const incomingCount = ref(0)
  function watchBadge() {
    const auth = useAuthStore()
    if (!auth.profile) return
    watchIncomingTrades(auth.profile.id, data => { incomingCount.value = data.length })
  }

  return {
    incoming, outgoing, classmates, loading, incomingCount,
    initListeners, teardown, fetchClassmates,
    sendOffer, acceptTrade, declineTrade, cancelTrade, watchBadge,
  }
})
