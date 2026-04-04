import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useAuthStore } from './auth'
import { updateUser, getAllItems, getDailyQuests, updateQuestProgress, xpForLevel, xpToNextLevel } from '@/firebase/collections'

export const useUserStore = defineStore('user', () => {
  const items       = ref([])
  const quests      = ref([])
  const loadingItems = ref(false)

  /** Single in-flight catalog fetch (layout + room + shop mounting together). */
  let itemsFetchPromise = null

  /**
   * @param {{ force?: boolean }} opts force: bypass in-memory skip (e.g. after long idle).
   */
  async function fetchItems(opts = {}) {
    const { force = false } = opts
    if (!force && items.value.length > 0) {
      void refreshItemsFromServerQuietly()
      return
    }
    if (itemsFetchPromise && !force) return itemsFetchPromise

    loadingItems.value = true
    itemsFetchPromise = (async () => {
      try {
        items.value = await getAllItems()
      } finally {
        loadingItems.value = false
        itemsFetchPromise = null
      }
    })()
    return itemsFetchPromise
  }

  /** Update catalog without blocking UI when we already have a usable list. */
  async function refreshItemsFromServerQuietly() {
    if (itemsFetchPromise) return
    try {
      const fresh = await getAllItems()
      if (fresh.length) items.value = fresh
    } catch {
      /* keep stale */
    }
  }

  async function fetchQuests() {
    const auth = useAuthStore()
    if (!auth.profile) return
    try {
      quests.value = await getDailyQuests(auth.profile.id)
    } catch (e) {
      console.warn('[fetchQuests] failed:', e?.message)
    }
  }

  async function progressQuest(type, amount = 1) {
    const auth = useAuthStore()
    if (!auth.profile) return
    const updated = await updateQuestProgress(auth.profile.id, type, amount)
    if (updated) quests.value = updated
  }

  async function equipItem(category, itemId) {
    const auth = useAuthStore()
    if (!auth.profile) return

    const item = items.value.find(i => i.id === itemId)
    if (!item) return

    const currentAvatar = { ...(auth.profile.avatar || {}) }
    let newAvatar

    if (category === 'skin') {
      newAvatar = {
        ...currentAvatar,
        skinId:  item.skinId  || 'default',
        skinUrl: item.skinUrl || null,
      }
    } else if (category === 'accessory') {
      // Toggle: equip this accessory (replacing any previous one), or remove if already on
      const current = currentAvatar.accessories || []
      const already = current.includes(itemId)
      newAvatar = { ...currentAvatar, accessories: already ? [] : [itemId] }
    } else if (category === 'room') {
      // Toggle: equip this room skin, or revert to default if already equipped
      const already = currentAvatar.roomId === itemId
      newAvatar = { ...currentAvatar, roomId: already ? null : itemId }
    } else if (category === 'pet') {
      const already = currentAvatar.petId === itemId
      newAvatar = { ...currentAvatar, petId: already ? null : itemId }
    } else {
      return
    }

    await updateUser(auth.profile.id, { avatar: newAvatar })
    // Optimistically update local profile so UI reacts immediately
    if (auth.profile) auth.profile.avatar = newAvatar
  }

  function resizeImageToSquare(file, size = 256, quality = 0.75) {
    return new Promise((resolve, reject) => {
      const img = new Image()
      const url = URL.createObjectURL(file)
      img.onload = () => {
        URL.revokeObjectURL(url)
        // Centre-crop to square then scale to target size
        const side = Math.min(img.width, img.height)
        const sx   = (img.width  - side) / 2
        const sy   = (img.height - side) / 2
        const c    = document.createElement('canvas')
        c.width = size; c.height = size
        c.getContext('2d').drawImage(img, sx, sy, side, side, 0, 0, size, size)
        resolve(c.toDataURL('image/jpeg', quality))
      }
      img.onerror = reject
      img.src = url
    })
  }

  async function uploadPhoto(file) {
    const auth = useAuthStore()
    if (!auth.profile) return
    const photoUrl  = await resizeImageToSquare(file)
    const newAvatar = { ...(auth.profile.avatar || {}), photoUrl }
    await updateUser(auth.profile.id, { avatar: newAvatar })
    if (auth.profile) auth.profile.avatar = newAvatar
  }

  async function removePhoto() {
    const auth = useAuthStore()
    if (!auth.profile) return
    const newAvatar = { ...(auth.profile.avatar || {}), photoUrl: null }
    await updateUser(auth.profile.id, { avatar: newAvatar })
    if (auth.profile) auth.profile.avatar = newAvatar
  }

  async function unequipItem(category) {
    const auth = useAuthStore()
    if (!auth.profile) return
    if (category !== 'skin') return
    const newAvatar = { ...(auth.profile.avatar || {}), skinId: 'default', skinUrl: null }
    await updateUser(auth.profile.id, { avatar: newAvatar })
    if (auth.profile) auth.profile.avatar = newAvatar
  }

  async function setDefaultRoom() {
    const auth = useAuthStore()
    if (!auth.profile) return
    const newAvatar = { ...(auth.profile.avatar || {}), roomId: null }
    await updateUser(auth.profile.id, { avatar: newAvatar })
    if (auth.profile) auth.profile.avatar = newAvatar
  }

  async function setNoPet() {
    const auth = useAuthStore()
    if (!auth.profile) return
    const newAvatar = { ...(auth.profile.avatar || {}), petId: null }
    await updateUser(auth.profile.id, { avatar: newAvatar })
    if (auth.profile) auth.profile.avatar = newAvatar
  }

  async function setNoAccessory() {
    const auth = useAuthStore()
    if (!auth.profile) return
    const newAvatar = { ...(auth.profile.avatar || {}), accessories: [] }
    await updateUser(auth.profile.id, { avatar: newAvatar })
    if (auth.profile) auth.profile.avatar = newAvatar
  }

  function getXpProgress(profile) {
    if (!profile) return { current: 0, needed: 100, percent: 0 }
    const levelStart = xpForLevel(profile.level || 1)
    const levelEnd   = levelStart + xpToNextLevel(profile.level || 1)
    const current    = (profile.xp || 0) - levelStart
    const needed     = levelEnd - levelStart
    return { current, needed, percent: Math.min(100, Math.round((current / needed) * 100)) }
  }

  function ownedItems(profile) {
    if (!profile) return []
    return items.value.filter(i => (profile.inventory || []).includes(i.id))
  }

  return {
    items, quests, loadingItems,
    fetchItems, fetchQuests, progressQuest, equipItem, unequipItem, setDefaultRoom, setNoPet, setNoAccessory, getXpProgress, ownedItems,
    uploadPhoto, removePhoto,
  }
})
