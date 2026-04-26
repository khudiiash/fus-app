<script setup>
import { ref, computed } from 'vue'
import { useUserStore } from '@/stores/user'
import { useAuthStore } from '@/stores/auth'
import AvatarDisplay from './AvatarDisplay.vue'
import Skin3dThumbnail from '@/components/character/Skin3dThumbnail.vue'
import GlbThumbnail from '@/components/character/GlbThumbnail.vue'
import SubjectBadgeArt from '@/components/shop/SubjectBadgeArt.vue'
import AppModal from '@/components/ui/AppModal.vue'
import { useToast } from '@/composables/useToast'
import { useHaptic } from '@/composables/useHaptic'
import { getTeachersForSubject, sendSubjectBadge } from '@/firebase/collections'
import { Palette, ChefHat, Home, Camera, Package, Medal, PawPrint } from 'lucide-vue-next'

const userStore = useUserStore()
const auth = useAuthStore()
const { success, error } = useToast()
const { coin: hapticCoin } = useHaptic()

const activeTab = ref('skin')
const tabs = [
  { key: 'skin',        label: 'Скіни',       Icon: Palette },
  { key: 'accessory',   label: 'Аксесуари',   Icon: ChefHat },
  { key: 'pet',         label: 'Улюбленці',   Icon: PawPrint },
  { key: 'room',        label: 'Кімнати',     Icon: Home },
  { key: 'subject_badge', label: 'Значки', Icon: Medal },
]

const ownedItems = computed(() => userStore.ownedItems(auth.profile))
const categoryItems = computed(() => ownedItems.value.filter(i => i.category === activeTab.value))

const sendBadgeModalItem = ref(null)
const teachersForBadge = ref([])
const loadingTeachers = ref(false)
const sendingBadge = ref(false)

async function openSendBadgeModal(item) {
  if (!item?.subjectId || !auth.profile?.id) return
  sendBadgeModalItem.value = item
  loadingTeachers.value = true
  teachersForBadge.value = []
  try {
    teachersForBadge.value = await getTeachersForSubject(item.subjectId)
    if (!teachersForBadge.value.length) {
      error('Немає вчителя з цим предметом у школі. Попроси адміна призначити предмет вчителю.')
      sendBadgeModalItem.value = null
    }
  } catch (e) {
    error(e.message)
    sendBadgeModalItem.value = null
  } finally {
    loadingTeachers.value = false
  }
}

async function confirmSendBadge(teacherUid) {
  const item = sendBadgeModalItem.value
  if (!item || !auth.profile?.id) return
  sendingBadge.value = true
  try {
    await sendSubjectBadge({
      studentUid: auth.profile.id,
      itemId: item.id,
      teacherUid,
    })
    hapticCoin()
    success('Значок передано вчителю!')
    sendBadgeModalItem.value = null
    await userStore.fetchItems()
  } catch (e) {
    error(e.message)
  } finally {
    sendingBadge.value = false
  }
}

function stackQty(item) {
  return auth.profile?.inventoryCounts?.[item.id] || 1
}

const saving        = ref(false)
const uploadingPhoto = ref(false)

async function onPhotoChange(event) {
  const file = event.target.files?.[0]
  if (!file) return
  uploadingPhoto.value = true
  try {
    await userStore.uploadPhoto(file)
    success('Фото оновлено!')
  } catch (e) {
    error(e.message)
  } finally {
    uploadingPhoto.value = false
    // Reset input so the same file can be picked again
    event.target.value = ''
  }
}

async function onRemovePhoto() {
  uploadingPhoto.value = true
  try {
    await userStore.removePhoto()
    success('Фото видалено')
  } catch (e) {
    error(e.message)
  } finally {
    uploadingPhoto.value = false
  }
}

async function equip(item) {
  saving.value = true
  try {
    await userStore.equipItem(item.category, item.id)
    success('Одягнено!')
  } catch (e) {
    error(e.message)
  } finally {
    saving.value = false
  }
}

async function equipDefaultRoom() {
  saving.value = true
  try {
    await userStore.setDefaultRoom()
    success('Стандартна кімната встановлена!')
  } catch (e) {
    error(e.message)
  } finally {
    saving.value = false
  }
}

const isDefaultRoomActive = computed(() => !auth.profile?.avatar?.roomId)
const isNoPetActive = computed(() => !auth.profile?.avatar?.petId)
const isNoAccessoryActive = computed(() => !(auth.profile?.avatar?.accessories || []).length)
const isDefaultSkinActive = computed(() => {
  const av = auth.profile?.avatar || {}
  if (av.skinUrl) return false
  const id = av.skinId || 'default'
  return id === 'default'
})

async function equipDefaultSkin() {
  saving.value = true
  try {
    await userStore.unequipItem('skin')
    success('Стандартний скін встановлено!')
  } catch (e) {
    error(e.message)
  } finally {
    saving.value = false
  }
}

function isEquipped(item) {
  const av = auth.profile?.avatar || {}
  if (item.category === 'skin') {
    /** URL skins: match by URL only. Palette / default: no `skinUrl` on profile — never treat URL catalog rows as equipped via `skinId || 'default'`. */
    if (av.skinUrl) {
      return !!(item.skinUrl && av.skinUrl === item.skinUrl)
    }
    if (item.skinUrl) return false
    return (av.skinId || 'default') === (item.skinId || 'default')
  }
  if (item.category === 'accessory') return (av.accessories || []).includes(item.id)
  if (item.category === 'room')      return av.roomId === item.id
  if (item.category === 'pet')       return av.petId === item.id
  return false
}

async function equipNoPet() {
  saving.value = true
  try {
    await userStore.setNoPet()
    success('Улюбленця знято')
  } catch (e) {
    error(e.message)
  } finally {
    saving.value = false
  }
}

async function equipNoAccessory() {
  saving.value = true
  try {
    await userStore.setNoAccessory()
    success('Аксесуар знято')
  } catch (e) {
    error(e.message)
  } finally {
    saving.value = false
  }
}

/** Compact grid thumbs (~30% shorter than previous profile picker) */
const THUMB_SKIN_W = 55
const THUMB_SKIN_H = 74
const THUMB_GLB_W = 92
const THUMB_GLB_H = 124
</script>

<template>
  <div class="flex flex-col gap-4">
    <!-- Avatar preview + photo upload -->
    <div class="flex flex-col items-center gap-3 py-4">
      <div class="relative">
        <AvatarDisplay
          :avatar="auth.profile?.avatar"
          :display-name="auth.profile?.displayName || ''"
          :items="userStore.items"
          size="xl"
        />
        <!-- Camera button overlay -->
        <label
          class="absolute bottom-0 right-0 w-9 h-9 rounded-full flex items-center justify-center cursor-pointer shadow-lg transition-all"
          :class="uploadingPhoto ? 'opacity-50 cursor-wait' : 'hover:scale-110'"
          style="background:linear-gradient(135deg,#7c3aed,#5b21b6);box-shadow:0 0 16px rgba(124,58,237,0.5)"
          title="Завантажити фото"
        >
          <Camera :size="16" :stroke-width="2" class="text-white" />
          <input
            type="file"
            accept="image/*"
            class="hidden"
            :disabled="uploadingPhoto"
            @change="onPhotoChange"
          />
        </label>
      </div>

      <!-- Remove photo link (only shown when a photo is set) -->
      <button
        v-if="auth.profile?.avatar?.photoUrl"
        class="text-xs text-slate-500 hover:text-rose-400 transition-colors"
        :disabled="uploadingPhoto"
        @click="onRemovePhoto"
      >
        × Видалити фото
      </button>
    </div>

    <!-- Tabs: лише іконки (як у магазині), підказка в title / aria-label -->
    <div class="flex gap-1.5 p-1 rounded-2xl" style="background:rgba(255,255,255,0.04)">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        type="button"
        class="flex-1 flex items-center justify-center py-2.5 rounded-xl font-bold transition-all duration-200"
        :class="activeTab === tab.key ? 'tab-active' : 'text-slate-500 hover:text-slate-300'"
        :title="tab.label"
        :aria-label="tab.label"
        @click="activeTab = tab.key"
      >
        <component :is="tab.Icon" :size="18" :stroke-width="activeTab === tab.key ? 2.2 : 1.8" />
      </button>
    </div>

    <!-- Предметні значки: передати вчителю предмета (офлайн-активність) -->
    <div v-if="activeTab === 'subject_badge' && categoryItems.length > 0" class="grid grid-cols-3 gap-2">
      <div
        v-for="item in categoryItems"
        :key="item.id"
        class="glass-card flex flex-col relative overflow-hidden rounded-2xl border border-amber-500/25 shadow-[0_0_12px_rgba(251,191,36,0.16),0_0_24px_rgba(251,191,36,0.05),inset_0_0_0_1px_rgba(251,191,36,0.12)]"
      >
        <div class="relative flex flex-col items-center gap-1.5 p-2">
          <SubjectBadgeArt :sprite-index="item.badgeSpriteIndex" :emoji="item.badgeEmoji || '🏅'" :size="72" />
          <div class="text-[10px] font-bold text-center truncate w-full leading-tight text-amber-100/90">{{ item.name }}</div>
          <div v-if="item.subjectName" class="text-[9px] text-slate-500 text-center truncate w-full">{{ item.subjectName }}</div>
          <div
            v-if="stackQty(item) > 1"
            class="absolute top-1.5 right-1.5 min-w-[1.25rem] h-5 px-1 rounded-full bg-amber-500 flex items-center justify-center text-[9px] font-extrabold text-slate-900"
          >
            ×{{ stackQty(item) }}
          </div>
        </div>
        <button
          type="button"
          class="w-full py-1.5 rounded-none rounded-b-2xl border-t border-amber-900/25 text-[10px] font-extrabold bg-gradient-to-r from-amber-500 to-amber-600 text-slate-900 active:scale-[0.99] transition-transform"
          @click="openSendBadgeModal(item)"
        >
          Надіслати вчителю
        </button>
      </div>
    </div>

    <div v-else-if="activeTab === 'subject_badge'" class="text-center py-8 text-slate-600">
      <Medal :size="36" :stroke-width="1.2" class="mx-auto mb-2 opacity-40 text-amber-400" />
      <div class="text-sm font-bold text-slate-500">Немає предметних значків</div>
      <div class="text-xs mt-1">Купи їх у магазині (категорія «Предметні значки»)</div>
    </div>

    <!-- Єдина сітка: стандарт / «без …» + куплені предмети (без розриву між рядками) -->
    <div v-if="activeTab === 'skin'" class="grid grid-cols-3 gap-2">
      <div
        class="glass-card p-2 flex flex-col items-center gap-1 cursor-pointer transition-all duration-150 active:scale-95"
        :class="isDefaultSkinActive ? 'border-violet-400 glow-primary' : ''"
        @click="equipDefaultSkin"
      >
        <div class="flex items-center justify-center rounded-lg overflow-hidden" :style="{ width: THUMB_SKIN_W + 'px', height: THUMB_SKIN_H + 'px' }">
          <Skin3dThumbnail
            skin-id="default"
            :width="THUMB_SKIN_W"
            :height="THUMB_SKIN_H"
            class="rounded-lg"
          />
        </div>
        <div class="text-[11px] font-bold text-center w-full leading-tight">Стандартний</div>
        <div class="text-[9px] text-slate-500 font-bold">безкоштовно</div>
        <div v-if="isDefaultSkinActive" class="text-[10px] text-violet-400 font-bold">✓ Активно</div>
        <div v-else class="text-[10px] text-slate-500">обрати</div>
      </div>
      <div
        v-for="item in categoryItems"
        :key="item.id"
        class="glass-card p-2 flex flex-col items-center gap-1 cursor-pointer transition-all duration-150 active:scale-95 relative"
        :class="isEquipped(item) ? 'border-violet-400 glow-primary' : ''"
        @click="equip(item)"
      >
        <Skin3dThumbnail
          :skin-url="item.skinUrl" :skin-id="item.skinId || 'default'"
          :width="THUMB_SKIN_W"
          :height="THUMB_SKIN_H"
          class="rounded-lg"
        />
        <div class="text-[11px] font-bold text-center truncate w-full leading-tight">{{ item.name }}</div>
        <div
          v-if="stackQty(item) > 1"
          class="absolute top-1.5 right-1.5 min-w-[1.25rem] h-5 px-1 rounded-full bg-slate-600 flex items-center justify-center text-[9px] font-extrabold text-white"
        >
          ×{{ stackQty(item) }}
        </div>
        <div v-if="isEquipped(item)" class="text-[10px] text-violet-400 font-bold">✓ Активно</div>
        <div v-else class="text-[10px] text-slate-500">одягнути</div>
      </div>
    </div>

    <div v-else-if="activeTab === 'room'" class="grid grid-cols-3 gap-2">
      <div
        class="glass-card p-2 flex flex-col items-center gap-1 cursor-pointer transition-all duration-150 active:scale-95"
        :class="isDefaultRoomActive ? 'border-violet-400 glow-primary' : ''"
        @click="equipDefaultRoom"
      >
        <div class="w-[52px] h-[52px] flex items-center justify-center">
          <Home :size="28" :stroke-width="1.2" class="text-violet-400/60" />
        </div>
        <div class="text-[11px] font-bold text-center w-full leading-tight">Стандартна</div>
        <div class="text-[9px] text-slate-500 font-bold">безкоштовно</div>
        <div v-if="isDefaultRoomActive" class="text-[10px] text-violet-400 font-bold">✓ Активно</div>
        <div v-else class="text-[10px] text-slate-500">обрати</div>
      </div>
      <div
        v-for="item in categoryItems"
        :key="item.id"
        class="glass-card p-2 flex flex-col items-center gap-1 cursor-pointer transition-all duration-150 active:scale-95 relative"
        :class="isEquipped(item) ? 'border-violet-400 glow-primary' : ''"
        @click="equip(item)"
      >
        <GlbThumbnail
          v-if="item.modelData"
          :model-data="item.modelData"
          :width="THUMB_GLB_W"
          :height="THUMB_GLB_H"
          is-room
          class="rounded-xl"
        />
        <div
          v-else
          class="flex items-center justify-center opacity-30"
          :style="{ width: THUMB_GLB_W + 'px', height: THUMB_GLB_H + 'px' }"
        >
          <Home :size="28" :stroke-width="1.2" />
        </div>
        <div class="text-[11px] font-bold text-center truncate w-full leading-tight">{{ item.name }}</div>
        <div
          v-if="stackQty(item) > 1"
          class="absolute top-1.5 right-1.5 min-w-[1.25rem] h-5 px-1 rounded-full bg-slate-600 flex items-center justify-center text-[9px] font-extrabold text-white"
        >
          ×{{ stackQty(item) }}
        </div>
        <div v-if="isEquipped(item)" class="text-[10px] text-violet-400 font-bold">✓ Активно</div>
        <div v-else class="text-[10px] text-slate-500">обрати</div>
      </div>
    </div>

    <div v-else-if="activeTab === 'pet'" class="grid grid-cols-3 gap-2">
      <div
        class="glass-card p-2 flex flex-col items-center gap-1 cursor-pointer transition-all duration-150 active:scale-95"
        :class="isNoPetActive ? 'border-violet-400 glow-primary' : ''"
        @click="equipNoPet"
      >
        <div class="w-[52px] h-[52px] flex items-center justify-center">
          <PawPrint :size="28" :stroke-width="1.2" class="text-slate-500" />
        </div>
        <div class="text-[11px] font-bold text-center w-full leading-tight">Без улюбленця</div>
        <div v-if="isNoPetActive" class="text-[10px] text-violet-400 font-bold">✓ Активно</div>
        <div v-else class="text-[10px] text-slate-500">обрати</div>
      </div>
      <div
        v-for="item in categoryItems"
        :key="item.id"
        class="glass-card p-2 flex flex-col items-center gap-1 cursor-pointer transition-all duration-150 active:scale-95 relative"
        :class="isEquipped(item) ? 'border-violet-400 glow-primary' : ''"
        @click="equip(item)"
      >
        <GlbThumbnail
          v-if="item.modelData"
          :model-data="item.modelData"
          :width="THUMB_GLB_W"
          :height="THUMB_GLB_H"
          class="rounded-xl"
        />
        <div
          v-else
          class="flex items-center justify-center opacity-30"
          :style="{ width: THUMB_GLB_W + 'px', height: THUMB_GLB_H + 'px' }"
        >
          <PawPrint :size="28" :stroke-width="1.2" />
        </div>
        <div class="text-[11px] font-bold text-center truncate w-full leading-tight">{{ item.name }}</div>
        <div
          v-if="stackQty(item) > 1"
          class="absolute top-1.5 right-1.5 min-w-[1.25rem] h-5 px-1 rounded-full bg-slate-600 flex items-center justify-center text-[9px] font-extrabold text-white"
        >
          ×{{ stackQty(item) }}
        </div>
        <div v-if="isEquipped(item)" class="text-[10px] text-violet-400 font-bold">✓ Активно</div>
        <div v-else class="text-[10px] text-slate-500">обрати</div>
      </div>
    </div>

    <div v-else-if="activeTab === 'accessory'" class="grid grid-cols-3 gap-2">
      <div
        class="glass-card p-2 flex flex-col items-center gap-1 cursor-pointer transition-all duration-150 active:scale-95"
        :class="isNoAccessoryActive ? 'border-violet-400 glow-primary' : ''"
        @click="equipNoAccessory"
      >
        <div class="w-[52px] h-[52px] flex items-center justify-center">
          <ChefHat :size="28" :stroke-width="1.2" class="text-slate-500" />
        </div>
        <div class="text-[11px] font-bold text-center w-full leading-tight">Без аксесуара</div>
        <div class="text-[9px] text-slate-500 font-bold">стандарт</div>
        <div v-if="isNoAccessoryActive" class="text-[10px] text-violet-400 font-bold">✓ Активно</div>
        <div v-else class="text-[10px] text-slate-500">обрати</div>
      </div>
      <div
        v-for="item in categoryItems"
        :key="item.id"
        class="glass-card p-2 flex flex-col items-center gap-1 cursor-pointer transition-all duration-150 active:scale-95 relative"
        :class="isEquipped(item) ? 'border-violet-400 glow-primary' : ''"
        @click="equip(item)"
      >
        <GlbThumbnail
          v-if="item.modelData"
          :model-data="item.modelData"
          :width="THUMB_GLB_W"
          :height="THUMB_GLB_H"
          class="rounded-xl"
        />
        <div
          v-else
          class="flex items-center justify-center opacity-30"
          :style="{ width: THUMB_GLB_W + 'px', height: THUMB_GLB_H + 'px' }"
        >
          <Package :size="28" :stroke-width="1.2" />
        </div>
        <div class="text-[11px] font-bold text-center truncate w-full leading-tight">{{ item.name }}</div>
        <div
          v-if="stackQty(item) > 1"
          class="absolute top-1.5 right-1.5 min-w-[1.25rem] h-5 px-1 rounded-full bg-slate-600 flex items-center justify-center text-[9px] font-extrabold text-white"
        >
          ×{{ stackQty(item) }}
        </div>
        <div v-if="isEquipped(item)" class="text-[10px] text-violet-400 font-bold">✓ Активно</div>
        <div v-else class="text-[10px] text-slate-500">
          {{ (auth.profile?.avatar?.accessories?.length > 0) ? 'замінити' : 'одягнути' }}
        </div>
      </div>
    </div>

    <AppModal
      :model-value="!!sendBadgeModalItem"
      title="Кому передати значок?"
      @update:model-value="(v) => { if (!v) sendBadgeModalItem = null }"
    >
      <div v-if="sendBadgeModalItem" class="flex flex-col gap-4">
        <div class="flex flex-col items-center gap-2 py-1">
          <SubjectBadgeArt :sprite-index="sendBadgeModalItem.badgeSpriteIndex" :emoji="sendBadgeModalItem.badgeEmoji || '🏅'" :size="88" />
          <p class="text-sm text-slate-200 text-center font-bold">{{ sendBadgeModalItem.name }}</p>
          <p v-if="sendBadgeModalItem.subjectName" class="text-xs text-amber-200/80">{{ sendBadgeModalItem.subjectName }}</p>
        </div>
        <p class="text-xs text-slate-500 text-center leading-relaxed">
          Обери вчителя, який викладає цей предмет. Один натискання — один значок (після офлайн-активності на уроці).
        </p>
        <div v-if="loadingTeachers" class="text-center text-sm text-slate-500 py-4">Завантаження…</div>
        <div v-else class="flex flex-col gap-2 max-h-56 overflow-y-auto">
          <button
            v-for="t in teachersForBadge"
            :key="t.id"
            type="button"
            class="w-full text-left px-4 py-3 rounded-xl font-bold text-sm bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.08] transition-colors disabled:opacity-50"
            :disabled="sendingBadge"
            @click="confirmSendBadge(t.id)"
          >
            {{ t.displayName || t.email || t.id }}
          </button>
        </div>
        <button
          type="button"
          class="w-full py-3 rounded-xl font-bold text-sm text-slate-400 bg-white/[0.06]"
          @click="sendBadgeModalItem = null"
        >
          Скасувати
        </button>
      </div>
    </AppModal>
  </div>
</template>
