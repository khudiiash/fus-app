import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  purchaseItem,
  openMysteryBox,
  aggregateStudentAwardCoinsBySubject,
} from '@/firebase/collections'
import { applyFridayDiscount, getFridayDiscount } from '@/lib/fridayDiscount'
import { useAuthStore } from './auth'
import { useUserStore } from './user'

export const useShopStore = defineStore('shop', () => {
  const items   = ref([])
  const loading = ref(false)
  const error   = ref(null)

  /**
   * Cached per-subject earned coin totals for the current user.
   * Populated by {@link refreshSubjectEarnedCoins} — called on shop entry and after any
   * subject-badge purchase so the gate stays in sync with the journal view.
   * @type {import('vue').Ref<Record<string, number>>}
   */
  const subjectEarnedCoins = ref({})

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
      await refreshSubjectEarnedCoins()
    } catch (e) {
      error.value = e.message
    } finally {
      loading.value = false
    }
  }

  /**
   * Refresh per-subject award totals — source of truth for the subject-badge buy gate.
   * Safe to call without a signed-in user (no-op).
   */
  async function refreshSubjectEarnedCoins() {
    const auth = useAuthStore()
    const uid = auth.profile?.id
    if (!uid) {
      subjectEarnedCoins.value = {}
      return
    }
    try {
      const rows = await aggregateStudentAwardCoinsBySubject(uid)
      const map = {}
      for (const r of rows) {
        if (r?.subjectName) map[r.subjectName] = Number(r.coins) || 0
      }
      subjectEarnedCoins.value = map
    } catch {
      // Soft fail — gate will show 0 earned and block the purchase, which is a safe default.
      subjectEarnedCoins.value = {}
    }
  }

  /**
   * Budget available for a subject badge: earned (award tx) minus already-spent (on-user ledger).
   * See {@link purchaseItem} in `collections.js` for the matching debit path.
   */
  function subjectBadgeBudget(subjectName) {
    if (!subjectName) return 0
    const auth = useAuthStore()
    const earned = Number(subjectEarnedCoins.value[subjectName]) || 0
    const spent = Number(auth.profile?.subjectCoinsSpent?.[subjectName]) || 0
    return Math.max(0, earned - spent)
  }

  /** Subject badges bill per-subject earned coins — no Friday % off (price must match server gate). */
  function isSubjectBilledItem(item) {
    return (
      item?.coinKind === 'subject_earned' ||
      (item?.category === 'subject_badge' && typeof item?.subjectName === 'string')
    )
  }

  /** Discounted price for a shop item (Friday all-day, 20-80 % off). */
  function priceFor(itemOrId) {
    const item = typeof itemOrId === 'string' ? items.value.find((i) => i.id === itemOrId) : itemOrId
    if (!item) return 0
    const base = Math.max(0, Math.floor(Number(item.price) || 0))
    if (isSubjectBilledItem(item)) return base
    return applyFridayDiscount(base, item.id)
  }

  /** Full discount descriptor for UI (pct, basePrice, discountedPrice, savings, isActive). */
  function discountFor(itemOrId) {
    const item = typeof itemOrId === 'string' ? items.value.find((i) => i.id === itemOrId) : itemOrId
    if (!item) return { pct: 0, basePrice: 0, discountedPrice: 0, savings: 0, isActive: false }
    if (isSubjectBilledItem(item)) {
      const base = Math.max(0, Math.floor(Number(item.price) || 0))
      return { pct: 0, basePrice: base, discountedPrice: base, savings: 0, isActive: false }
    }
    return getFridayDiscount(item)
  }

  async function buy(itemId) {
    const auth = useAuthStore()
    const item = items.value.find(i => i.id === itemId)
    if (!item) throw new Error('Item not found')
    const payPrice = priceFor(item)
    /**
     * Subject badges are billed against per-subject earned coins; pass the earned total so
     * the transaction can verify the gate without re-querying award history inside the txn.
     */
    const subjectEarned = item.subjectName ? Number(subjectEarnedCoins.value[item.subjectName]) || 0 : undefined
    await purchaseItem({
      uid: auth.profile.id,
      itemId,
      price: payPrice,
      ...(isSubjectBilledItem(item) ? { subjectEarnedCoins: subjectEarned } : {}),
    })
    await fetchItems({ forceCatalog: true })
    await useUserStore().fetchQuests()
  }

  /** Застаріло: магічні коробки; залишено для старих акаунтів. */
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

  function inventoryStackCount(itemId) {
    const auth = useAuthStore()
    if (!(auth.profile?.inventory || []).includes(itemId)) return 0
    return auth.profile?.inventoryCounts?.[itemId] || 1
  }

  /** True whenever any shop item has an active Friday discount — drives the banner in the UI. */
  const anyDiscountActive = computed(() => items.value.some((it) => getFridayDiscount(it).isActive))

  return {
    items,
    loading,
    error,
    subjectEarnedCoins,
    anyDiscountActive,
    fetchItems,
    refreshSubjectEarnedCoins,
    subjectBadgeBudget,
    isSubjectBilledItem,
    priceFor,
    discountFor,
    buy,
    openBox,
    itemsByCategory,
    isOwned,
    mysteryBoxCount,
    inventoryStackCount,
  }
})
