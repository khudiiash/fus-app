import { defineStore } from 'pinia'
import { ref } from 'vue'
import { purchaseItem, getActiveItems, openMysteryBox } from '@/firebase/collections'
import { useAuthStore } from './auth'

export const useShopStore = defineStore('shop', () => {
  const items   = ref([])
  const loading = ref(false)
  const error   = ref(null)

  async function fetchItems() {
    loading.value = true
    error.value   = null
    try {
      items.value = await getActiveItems()
    } catch (e) {
      error.value = e.message
    } finally {
      loading.value = false
    }
  }

  async function buy(itemId) {
    const auth = useAuthStore()
    const item = items.value.find(i => i.id === itemId)
    if (!item) throw new Error('Item not found')
    await purchaseItem({ uid: auth.profile.id, itemId, price: item.price })
  }

  async function openBox(itemId) {
    const auth = useAuthStore()
    if (!auth.profile?.id) throw new Error('Not signed in')
    return openMysteryBox(auth.profile.id, itemId)
  }

  function itemsByCategory(category) {
    return items.value.filter(i => i.category === category)
  }

  function isOwned(itemId) {
    const auth = useAuthStore()
    const item = items.value.find(i => i.id === itemId)
    if (item?.category === 'mystery_box') return false
    return (auth.profile?.inventory || []).includes(itemId)
  }

  function mysteryBoxCount(itemId) {
    const auth = useAuthStore()
    return auth.profile?.mysteryBoxCounts?.[itemId] || 0
  }

  return { items, loading, error, fetchItems, buy, openBox, itemsByCategory, isOwned, mysteryBoxCount }
})
