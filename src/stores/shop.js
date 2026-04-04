import { defineStore } from 'pinia'
import { ref } from 'vue'
import { purchaseItem, openMysteryBox } from '@/firebase/collections'
import { useAuthStore } from './auth'
import { useUserStore } from './user'

export const useShopStore = defineStore('shop', () => {
  const items   = ref([])
  const loading = ref(false)
  const error   = ref(null)

  /** @param {{ forceCatalog?: boolean }} opts Re-fetch Firestore after purchase (stock) */
  async function fetchItems(opts = {}) {
    const { forceCatalog = false } = opts
    loading.value = true
    error.value   = null
    try {
      const userStore = useUserStore()
      if (!userStore.items.length) {
        await userStore.fetchItems()
      } else if (forceCatalog) {
        await userStore.fetchItems({ force: true })
      }
      items.value = userStore.items.filter((i) => i.active !== false)
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
    await fetchItems({ forceCatalog: true })
    await useUserStore().fetchQuests()
  }

  async function openBox(itemId) {
    const auth = useAuthStore()
    if (!auth.profile?.id) throw new Error('Not signed in')
    const result = await openMysteryBox(auth.profile.id, itemId)
    await fetchItems({ forceCatalog: true })
    return result
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
