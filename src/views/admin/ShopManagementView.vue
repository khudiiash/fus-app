<script setup>
import '@/utils/enableThreeFileCache'
import { ref, onMounted, computed } from 'vue'
import { getAuth } from 'firebase/auth'
import { useAuthStore } from '@/stores/auth'
import { getAllItems, getAllSubjects, createItem, updateItem, archiveItem, restoreItem, deleteItem, deleteAllShopItems } from '@/firebase/collections'
import SkinPreview      from '@/components/character/SkinPreview.vue'
import Skin3dThumbnail from '@/components/character/Skin3dThumbnail.vue'
import AccessoryPreview from '@/components/character/AccessoryPreview.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppModal from '@/components/ui/AppModal.vue'
import AppInput from '@/components/ui/AppInput.vue'
import { useToast } from '@/composables/useToast'
import { Archive, RotateCcw, Package, Layers, Infinity, Trash2, Pencil, Search, X, ShoppingBag, Download, Blocks } from 'lucide-vue-next'
import SubjectBadgeArt from '@/components/shop/SubjectBadgeArt.vue'
import BlockWorldShopThumb from '@/components/shop/BlockWorldShopThumb.vue'
import GlbThumbnail from '@/components/character/GlbThumbnail.vue'
import {
  seedSkinsFromFiles,
  seedGlbShopItemsFromFiles,
  seedBlockWorldShopItems,
} from '@/firebase/seedData'
import { uploadShopGlb, uploadSkinTextureFile } from '@/firebase/shopAssetStorage'
import { syncShopStorageClaim } from '@/firebase/syncShopStorageClaim'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { BADGE_SPRITE_LABELS } from '@/utils/subjectBadgeSprite'

const { success, error } = useToast()
const authStore = useAuthStore()

function shopFirebaseErrorMessage(err) {
  const c = err?.code
  if (c === 'storage/unauthorized' || c === 'permission-denied') {
    return (
      'Немає прав на завантаження. Перевірте: у Firestore users/[ваш uid] є role "admin"; firebase deploy --only storage. '
      + 'Після першого деплою функцій ця сторінка сама оновлює права — виконайте: firebase deploy --only functions (тариф Blaze).'
    )
  }
  return err?.message || 'Помилка'
}

const items     = ref([])
const showModal = ref(false)
const editItem  = ref(null)
const saving         = ref(false)
const uploadingSkin  = ref(false)
const uploadingModel = ref(false)
const pendingModelFile = ref(null)
const search         = ref('')
const seedingPack       = ref(false)
const seedingRoomGlbs   = ref(false)
const seedingAccGlbs    = ref(false)
const seedingPetGlbs    = ref(false)
const seedingBlockWorld = ref(false)
const showPurgeModal    = ref(false)
const purgeConfirmText  = ref('')
const purgingAll        = ref(false)
const PURGE_CONFIRM_PHRASE = 'ВИДАЛИТИ УСІ'
const skinFilesInput    = ref(null)
const roomGlbInput      = ref(null)
const accGlbInput       = ref(null)
const petGlbInput       = ref(null)

const CATS   = ['skin', 'accessory', 'pet', 'room', 'subject_badge', 'block_world']
const CAT_LABELS = { skin: 'Скіни', accessory: 'Аксесуари', pet: 'Улюбленці', room: 'Кімнати', subject_badge: 'Предметні значки', block_world: 'Світ (блоки + інструменти)' }
const RARITIES = ['common', 'rare', 'epic', 'legendary']
const RARITY_LABELS = { common: 'Звичайний', rare: 'Рідкісний', epic: 'Епічний', legendary: 'Легендарний' }
const rarityColor    = { common: 'text-slate-400', rare: 'text-blue-400', epic: 'text-purple-400', legendary: 'text-amber-400' }
const rarityDot      = { common: 'bg-slate-500', rare: 'bg-blue-500', epic: 'bg-purple-500', legendary: 'bg-amber-400' }

const form = ref({
  name: '', description: '', category: 'skin', rarity: 'common',
  price: 100, isLimited: false, limitedStock: false, stock: 10,
  skinUrl: '', skinId: '', modelData: '', brightnessMultiplier: 1.0,
  subjectId: '', subjectName: '', badgeEmoji: '🔢',
  /** -1 = тільки емодзі; 0–24 = кадр subjects.png */
  badgeSpriteIndex: 0,
})

const isSkin        = computed(() => form.value.category === 'skin')
const isAccessory   = computed(() => form.value.category === 'accessory')
const isRoom        = computed(() => form.value.category === 'room')
const isPet         = computed(() => form.value.category === 'pet')
const isSubjectBadge = computed(() => form.value.category === 'subject_badge')
const subjectsList = ref([])

const activeItems   = computed(() => items.value.filter(i => i.active !== false))
const archivedItems = computed(() => items.value.filter(i => i.active === false))

const filteredActive = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return activeItems.value
  return activeItems.value.filter(i => i.name?.toLowerCase().includes(q))
})

const filteredArchived = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return archivedItems.value
  return archivedItems.value.filter(i => i.name?.toLowerCase().includes(q))
})

// Group active items by category
const grouped = computed(() =>
  CATS
    .map(cat => ({ cat, items: filteredActive.value.filter(i => i.category === cat) }))
    .filter(g => g.items.length)
)

onMounted(async () => {
  await fetchItems()
  try {
    subjectsList.value = await getAllSubjects()
  } catch {
    subjectsList.value = []
  }
  if (!authStore.isAdmin) return
  try {
    await syncShopStorageClaim()
    await getAuth().currentUser?.getIdToken(true)
  } catch (e) {
    const code = e?.code
    if (code === 'functions/not-found') {
      error('Задеплойте хмарну функцію: у корені проєкту `cd functions && npm install`, потім `firebase deploy --only functions` (потрібен Blaze). Після цього оновіть цю сторінку.')
    } else {
      console.warn('[shop] syncShopStorageClaim', e)
    }
  }
})
async function fetchItems() { items.value = await getAllItems() }

function setCategory(cat) {
  form.value.category = cat
  if (cat === 'subject_badge') {
    form.value.rarity = 'legendary'
    form.value.price = 1000
    if (form.value.badgeSpriteIndex == null || form.value.badgeSpriteIndex < -1) {
      form.value.badgeSpriteIndex = 0
    }
  }
}

function stockLabel(item) {
  if (item.stock == null) return null
  if (item.stock === 0)   return { text: 'Розпродано', cls: 'text-red-400' }
  if (item.stock <= 5)    return { text: `${item.stock} зал.`, cls: 'text-orange-400' }
  return { text: `${item.stock}`, cls: 'text-emerald-400' }
}

function openCreate() {
  editItem.value = null; pendingModelFile.value = null
  form.value = {
    name: '', description: '', category: 'skin', rarity: 'common',
    price: 100, isLimited: false, limitedStock: false, stock: 10,
    skinUrl: '', skinId: '', modelData: '', brightnessMultiplier: 1.0,
    subjectId: '', subjectName: '', badgeEmoji: '🔢', badgeSpriteIndex: 0,
  }
  showModal.value = true
}

function openEdit(item) {
  editItem.value = item; pendingModelFile.value = null
  const hasStock = item.stock != null
  form.value = {
    name: item.name, description: item.description || '',
    category: item.category, rarity: item.rarity, price: item.price,
    isLimited: item.isLimited || false, limitedStock: hasStock,
    stock: hasStock ? item.stock : 10,
    skinUrl: item.skinUrl || '', skinId: item.skinId || '', modelData: item.modelData || '',
    brightnessMultiplier: item.brightnessMultiplier ?? 1.0,
    subjectId: item.subjectId || '', subjectName: item.subjectName || '', badgeEmoji: item.badgeEmoji || '🏅',
    badgeSpriteIndex:
      item.badgeSpriteIndex != null && item.badgeSpriteIndex >= 0 ? item.badgeSpriteIndex : -1,
  }
  showModal.value = true
}

function syncSubjectNameFromId() {
  const id = form.value.subjectId
  const s = subjectsList.value.find((x) => x.id === id)
  form.value.subjectName = s?.name || ''
}

async function save() {
  if (!form.value.name.trim()) { error('Введіть назву'); return }
  if (form.value.category === 'subject_badge') {
    if (!form.value.subjectId) { error('Оберіть предмет для значка'); return }
    syncSubjectNameFromId()
    if (!form.value.subjectName) { error('Некоректний предмет'); return }
  }
  saving.value = true
  try {
    if (pendingModelFile.value && (form.value.category === 'accessory' || form.value.category === 'room' || form.value.category === 'pet')) {
      uploadingModel.value = true
      try {
        form.value.modelData = await uploadShopGlb(
          form.value.category,
          pendingModelFile.value.name,
          pendingModelFile.value,
        )
      }
      catch (e) { error('Завантаження GLB у Storage: ' + shopFirebaseErrorMessage(e)); return }
      finally { uploadingModel.value = false; pendingModelFile.value = null }
    }
    const data = {
      name: form.value.name.trim(), description: form.value.description.trim(),
      category: form.value.category, rarity: form.value.rarity, price: Number(form.value.price),
      isLimited: form.value.isLimited,
      stock: form.value.limitedStock ? Math.max(0, Number(form.value.stock)) : null,
      skinUrl:   form.value.category === 'skin'                          ? (form.value.skinUrl   || null) : null,
      skinId:    form.value.category === 'skin'                          ? (form.value.skinId    || null) : null,
      modelData: ['accessory', 'room', 'pet'].includes(form.value.category) ? (form.value.modelData || null) : null,
      brightnessMultiplier: form.value.category === 'room' ? Number(form.value.brightnessMultiplier) : null,
      subjectId: form.value.category === 'subject_badge' ? form.value.subjectId : null,
      subjectName: form.value.category === 'subject_badge' ? (form.value.subjectName || null) : null,
      badgeEmoji: form.value.category === 'subject_badge' ? (form.value.badgeEmoji || '🏅') : null,
      badgeSpriteIndex:
        form.value.category === 'subject_badge' && form.value.badgeSpriteIndex >= 0
          ? Number(form.value.badgeSpriteIndex)
          : null,
    }
    if (editItem.value) { await updateItem(editItem.value.id, data); success('Товар оновлено!') }
    else                { await createItem(data);                     success('Товар додано!')   }
    showModal.value = false
    await fetchItems()
  } catch (e) { error(shopFirebaseErrorMessage(e)) }
  finally { saving.value = false }
}

async function archive(item) {
  if (!confirm(`Прибрати "${item.name}" з магазину?`)) return
  try { await archiveItem(item.id); success('Товар прибрано'); await fetchItems() }
  catch (e) { error(shopFirebaseErrorMessage(e)) }
}

async function restore(item) {
  try { await restoreItem(item.id); success('Товар повернуто'); await fetchItems() }
  catch (e) { error(shopFirebaseErrorMessage(e)) }
}

const confirmDeleteItemId = ref(null)
const deletingItem = ref(false)

async function hardDeleteItem(item) {
  deletingItem.value = true
  try {
    await deleteItem(item.id)
    items.value = items.value.filter(i => i.id !== item.id)
    confirmDeleteItemId.value = null
    success(`"${item.name}" видалено назавжди`)
  } catch (e) { error(shopFirebaseErrorMessage(e)) }
  finally { deletingItem.value = false }
}

const rarityPrices = { common: 100, rare: 300, epic: 600, legendary: 1200 }
function onRarityChange() { form.value.price = rarityPrices[form.value.rarity] || 100 }

async function uploadSkinTexture(file) {
  if (!file) return
  if (file.size > 12 * 1024 * 1024) { error('Файл занадто великий (макс 12 МБ)'); return }
  uploadingSkin.value = true
  try {
    form.value.skinUrl = await uploadSkinTextureFile(file.name, file)
    success('Текстуру завантажено в Firebase Storage!')
  }
  catch (e) { error('Помилка: ' + shopFirebaseErrorMessage(e)) }
  finally { uploadingSkin.value = false }
}

function onSkinFileChange(e)  { const f = e.target.files?.[0]; if (f) uploadSkinTexture(f) }

async function onSkinPackFilesChange(e) {
  // Snapshot before clearing: clearing value empties the live FileList in browsers.
  const files = e.target.files ? Array.from(e.target.files) : []
  e.target.value = ''
  if (!files.length) return
  seedingPack.value = true
  try {
    const r = await seedSkinsFromFiles(files)
    const parts = []
    if (r.added) parts.push(`додано ${r.added}`)
    if (r.updated) parts.push(`оновлено URL: ${r.updated}`)
    if (r.uploaded) parts.push(`завантажено PNG: ${r.uploaded}`)
    if (r.notInCatalog) parts.push(`не знайдено в каталозі SEED_SKINS: ${r.notInCatalog}`)
    success(parts.length ? `Скіни → Storage: ${parts.join(', ')}` : 'Немає відповідних PNG у каталозі.')
    await fetchItems()
  } catch (err) {
    error(shopFirebaseErrorMessage(err))
  } finally {
    seedingPack.value = false
  }
}

function formatSeedStats(r, label) {
  const p = []
  if (r.added)   p.push(`+${r.added}`)
  if (r.updated) p.push(`URL ${r.updated}`)
  if (r.skipped) p.push(`без змін ${r.skipped}`)
  return p.length ? `${label}: ${p.join(', ')}` : ''
}

async function onRoomGlbFilesChange(e) {
  const files = e.target.files ? Array.from(e.target.files) : []
  e.target.value = ''
  if (!files.length) return
  seedingRoomGlbs.value = true
  try {
    const rooms = await seedGlbShopItemsFromFiles(files, 'room')
    success(formatSeedStats(rooms, 'Кімнати (Storage)') || 'Кімнати: без змін')
    await fetchItems()
  } catch (err) {
    error(shopFirebaseErrorMessage(err))
  } finally {
    seedingRoomGlbs.value = false
  }
}

async function onAccessoryGlbFilesChange(e) {
  const files = e.target.files ? Array.from(e.target.files) : []
  e.target.value = ''
  if (!files.length) return
  seedingAccGlbs.value = true
  try {
    const accessories = await seedGlbShopItemsFromFiles(files, 'accessory')
    success(formatSeedStats(accessories, 'Аксесуари (Storage)') || 'Аксесуари: без змін')
    await fetchItems()
  } catch (err) {
    error(shopFirebaseErrorMessage(err))
  } finally {
    seedingAccGlbs.value = false
  }
}

async function onPetGlbFilesChange(e) {
  const files = e.target.files ? Array.from(e.target.files) : []
  e.target.value = ''
  if (!files.length) return
  seedingPetGlbs.value = true
  try {
    const r = await seedGlbShopItemsFromFiles(files, 'pet')
    success(formatSeedStats(r, 'Улюбленці GLB → Storage') || 'Улюбленці: без змін')
    await fetchItems()
  } catch (err) {
    error(shopFirebaseErrorMessage(err))
  } finally {
    seedingPetGlbs.value = false
  }
}

/** Синхронізує каталог `block_world` з шаблоном (додає нові за bwSeedKey, оновлює наявні). */
async function onSeedBlockWorldCatalog() {
  seedingBlockWorld.value = true
  try {
    const { added, updated, total } = await seedBlockWorldShopItems()
    success(
      `Каталог спільного світу: додано ${added}, оновлено з шаблону ${updated} (усього ${total} позицій).`,
    )
    await fetchItems()
  } catch (err) {
    error(shopFirebaseErrorMessage(err))
  } finally {
    seedingBlockWorld.value = false
  }
}

function openPurgeModal() {
  purgeConfirmText.value = ''
  showPurgeModal.value = true
}

function closePurgeModal() {
  showPurgeModal.value = false
  purgeConfirmText.value = ''
}

async function executePurgeAllItems() {
  if (purgeConfirmText.value.trim() !== PURGE_CONFIRM_PHRASE) {
    error(`Введіть точно: ${PURGE_CONFIRM_PHRASE}`)
    return
  }
  purgingAll.value = true
  try {
    const { deleted } = await deleteAllShopItems()
    closePurgeModal()
    await fetchItems()
    success(deleted ? `Видалено документів у Firestore: ${deleted}. Завантажте файли знову через кнопки → Storage.` : 'Каталог уже був порожній.')
  } catch (e) {
    error(shopFirebaseErrorMessage(e))
  } finally {
    purgingAll.value = false
  }
}

function onModelFileSelect(e) {
  const f = e.target.files?.[0]; if (!f) return
  if (f.size > 80 * 1024 * 1024) { error('Файл занадто великий (макс 80 МБ)'); return }
  pendingModelFile.value = f; form.value.modelData = ''

  // For room GLBs, auto-read brightnessMultiplier from Blender custom property
  if (form.value.category === 'room') {
    const url = URL.createObjectURL(f)
    new GLTFLoader().load(
      url,
      (gltf) => {
        URL.revokeObjectURL(url)
        const scene = gltf.scene
        const bm =
          scene.userData?.brightnessMultiplier ??
          scene.userData?.extras?.brightnessMultiplier
        if (bm != null) {
          form.value.brightnessMultiplier = Number(bm)
          success(`Зчитано яскравість з GLB: ${Number(bm).toFixed(2)}`)
        }
      },
      undefined,
      () => URL.revokeObjectURL(url)
    )
  }
}
</script>

<template>
  <div class="flex flex-col gap-4">

    <!-- Header -->
    <div class="flex items-center justify-between gap-3">
      <div>
        <div class="flex items-center gap-2">
          <ShoppingBag :size="22" :stroke-width="2" class="text-accent" />
          <h1 class="text-2xl font-extrabold">Товари магазину</h1>
        </div>
        <p class="text-slate-400 text-sm mt-1">{{ activeItems.length }} активних · {{ archivedItems.length }} в архіві</p>
      </div>
      <div class="flex flex-wrap gap-2">
        <!-- label + sr-only input: programmatic .click() on display:none inputs is blocked in many browsers -->
        <label
          class="inline-flex cursor-pointer rounded-2xl"
          :class="seedingPack ? 'pointer-events-none opacity-40 cursor-not-allowed' : ''"
        >
          <input
            ref="skinFilesInput"
            type="file"
            accept=".png,image/png"
            multiple
            class="sr-only"
            :disabled="seedingPack"
            @change="onSkinPackFilesChange"
          />
          <AppButton as="span" variant="secondary" size="sm" :loading="seedingPack">
            <Download :size="14" :stroke-width="2" />
            Скіни PNG → Storage
          </AppButton>
        </label>
        <label
          class="inline-flex cursor-pointer rounded-2xl"
          :class="seedingRoomGlbs ? 'pointer-events-none opacity-40 cursor-not-allowed' : ''"
        >
          <input
            ref="roomGlbInput"
            type="file"
            accept=".glb,model/gltf-binary"
            multiple
            class="sr-only"
            :disabled="seedingRoomGlbs"
            @change="onRoomGlbFilesChange"
          />
          <AppButton as="span" variant="secondary" size="sm" :loading="seedingRoomGlbs">
            <Layers :size="14" :stroke-width="2" />
            Кімнати GLB → Storage
          </AppButton>
        </label>
        <label
          class="inline-flex cursor-pointer rounded-2xl"
          :class="seedingAccGlbs ? 'pointer-events-none opacity-40 cursor-not-allowed' : ''"
        >
          <input
            ref="accGlbInput"
            type="file"
            accept=".glb,model/gltf-binary"
            multiple
            class="sr-only"
            :disabled="seedingAccGlbs"
            @change="onAccessoryGlbFilesChange"
          />
          <AppButton as="span" variant="secondary" size="sm" :loading="seedingAccGlbs">
            <Package :size="14" :stroke-width="2" />
            Аксесуари GLB → Storage
          </AppButton>
        </label>
        <label
          class="inline-flex cursor-pointer rounded-2xl"
          :class="seedingPetGlbs ? 'pointer-events-none opacity-40 cursor-not-allowed' : ''"
        >
          <input
            ref="petGlbInput"
            type="file"
            accept=".glb,model/gltf-binary"
            multiple
            class="sr-only"
            :disabled="seedingPetGlbs"
            @change="onPetGlbFilesChange"
          />
          <AppButton as="span" variant="secondary" size="sm" :loading="seedingPetGlbs">
            <Package :size="14" :stroke-width="2" />
            Улюбленці GLB → Storage
          </AppButton>
        </label>
        <AppButton
          variant="secondary"
          size="sm"
          :loading="seedingBlockWorld"
          :disabled="seedingBlockWorld"
          class="inline-flex items-center gap-1.5"
          @click="onSeedBlockWorldCatalog"
        >
          <Blocks :size="14" :stroke-width="2" />
          Блоки + інструменти → Firestore
        </AppButton>
        <AppButton variant="danger" size="sm" :disabled="items.length === 0" @click="openPurgeModal">
          <Trash2 :size="14" :stroke-width="2" />
          Очистити каталог (Firestore)
        </AppButton>
        <AppButton variant="primary" size="sm" @click="openCreate">+ Новий товар</AppButton>
      </div>
    </div>

    <!-- Search -->
    <div class="relative">
      <Search :size="15" :stroke-width="2" class="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
      <input
        v-model="search"
        placeholder="Пошук товару..."
        class="w-full bg-game-card border border-white/[0.07] rounded-xl pl-9 pr-9 py-2.5 text-sm text-slate-200 placeholder-slate-500 outline-none focus:border-white/20 transition-colors"
      />
      <button v-if="search" class="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300" @click="search = ''">
        <X :size="14" :stroke-width="2" />
      </button>
    </div>

    <!-- Empty -->
    <div v-if="items.length === 0" class="text-center py-16 text-slate-500">
      <Package :size="48" :stroke-width="1" class="mx-auto mb-3 opacity-20" />
      <div class="font-bold">Товарів ще немає</div>
    </div>

    <!-- Active items grouped by category -->
    <div v-if="grouped.length" class="flex flex-col gap-5">
      <div v-for="g in grouped" :key="g.cat">
        <!-- Category header -->
        <div class="flex items-center gap-2 mb-2 px-1">
          <span class="text-sm font-extrabold text-slate-300 uppercase tracking-wide">{{ CAT_LABELS[g.cat] }}</span>
          <span class="text-xs text-slate-600 font-bold">{{ g.items.length }}</span>
          <div class="flex-1 h-px bg-white/[0.06] ml-1" />
        </div>

        <div class="flex flex-col gap-1">
          <div
            v-for="item in g.items" :key="item.id"
            class="flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-white/[0.04] transition-colors group"
          >
            <!-- Tiny preview — 2D only, no WebGL -->
            <div class="w-9 h-9 flex-shrink-0 flex items-center justify-center">
              <Skin3dThumbnail
                v-if="item.category === 'skin'"
                :skin-url="item.skinUrl"
                :skin-id="item.skinId || 'default'"
                :width="41"
                :height="56"
              />
              <SubjectBadgeArt
                v-else-if="item.category === 'subject_badge'"
                :sprite-index="item.badgeSpriteIndex"
                :emoji="item.badgeEmoji || '🏅'"
                :size="34"
              />
              <GlbThumbnail
                v-else-if="item.modelData && ['accessory', 'room', 'pet'].includes(item.category)"
                :model-data="item.modelData"
                :width="41"
                :height="56"
                :is-room="item.category === 'room'"
              />
              <BlockWorldShopThumb
                v-else-if="item.category === 'block_world'"
                :item="item"
                :size="34"
              />
              <Package v-else :size="18" :stroke-width="1.5" class="text-slate-600" />
            </div>

            <!-- Info -->
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-1.5">
                <span class="text-sm font-semibold text-slate-200 truncate">{{ item.name }}</span>
                <span v-if="item.isLimited" class="text-[9px] bg-red-500/20 text-red-400 px-1.5 py-0.5 rounded font-bold flex-shrink-0">LTD</span>
              </div>
              <div class="flex items-center gap-2 text-xs mt-0.5">
                <span :class="rarityColor[item.rarity]">{{ RARITY_LABELS[item.rarity] }}</span>
                <span class="text-slate-600">·</span>
                <span class="text-amber-400 font-bold">{{ item.price }} м</span>
                <span class="text-slate-600">·</span>
                <span v-if="item.stock == null" class="text-slate-600 flex items-center gap-0.5">
                  <Infinity :size="9" :stroke-width="2" /> необм.
                </span>
                <span v-else :class="stockLabel(item)?.cls">{{ stockLabel(item)?.text }}</span>
              </div>
            </div>

            <!-- Rarity dot -->
            <div class="w-1.5 h-1.5 rounded-full flex-shrink-0" :class="rarityDot[item.rarity]" />

            <!-- Actions -->
            <div class="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
              <button
                class="p-1.5 rounded-lg text-slate-500 hover:text-slate-200 hover:bg-white/[0.08] transition-colors"
                title="Редагувати" @click.stop="openEdit(item)"
              ><Pencil :size="13" :stroke-width="2" /></button>
              <button
                class="p-1.5 rounded-lg text-slate-500 hover:text-amber-400 hover:bg-amber-500/10 transition-colors"
                title="Прибрати з магазину" @click.stop="archive(item)"
              ><Archive :size="13" :stroke-width="2" /></button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Archived -->
    <div v-if="filteredArchived.length">
      <div class="flex items-center gap-2 mb-2 px-1">
        <span class="text-sm font-extrabold text-slate-600 uppercase tracking-wide">Архів</span>
        <span class="text-xs text-slate-700 font-bold">{{ filteredArchived.length }}</span>
        <div class="flex-1 h-px bg-white/[0.04] ml-1" />
      </div>
      <div class="flex flex-col gap-1">
        <div
          v-for="item in filteredArchived" :key="item.id"
          class="flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-white/[0.03] transition-colors group opacity-50 hover:opacity-80"
        >
          <div class="w-1.5 h-1.5 rounded-full bg-slate-700 flex-shrink-0" />
          <div class="flex-1 min-w-0">
            <span class="text-sm font-semibold text-slate-400 truncate">{{ item.name }}</span>
            <div class="text-xs text-slate-600">{{ CAT_LABELS[item.category] || item.category }} · {{ item.price }} м</div>
          </div>
          <div class="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
            <button
              class="p-1.5 rounded-lg text-slate-500 hover:text-emerald-400 hover:bg-emerald-500/10 transition-colors"
              title="Відновити" @click.stop="restore(item)"
            ><RotateCcw :size="13" :stroke-width="2" /></button>
            <template v-if="confirmDeleteItemId !== item.id">
              <button
                class="p-1.5 rounded-lg text-slate-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                title="Видалити назавжди" @click.stop="confirmDeleteItemId = item.id"
              ><Trash2 :size="13" :stroke-width="2" /></button>
            </template>
            <template v-else>
              <span class="text-xs text-red-400 font-bold mr-1">Видалити?</span>
              <button class="text-xs px-2 py-1 rounded-lg bg-red-500/20 text-red-400 hover:bg-red-500/30 font-bold disabled:opacity-50" :disabled="deletingItem" @click.stop="hardDeleteItem(item)">{{ deletingItem ? '...' : 'Так' }}</button>
              <button class="text-xs px-2 py-1 rounded-lg bg-white/[0.06] text-slate-400 hover:bg-white/[0.10] font-bold" @click.stop="confirmDeleteItemId = null">Ні</button>
            </template>
          </div>
        </div>
      </div>
    </div>

    <!-- Create / Edit modal -->
    <AppModal v-model="showModal" :title="editItem ? 'Редагувати товар' : 'Новий товар'" size="lg">
      <div class="flex flex-col gap-4">
        <!-- Category -->
        <div>
          <label class="text-sm font-bold text-slate-300 block mb-1.5">Категорія</label>
          <div class="flex flex-wrap gap-2">
            <button
              v-for="cat in CATS" :key="cat"
              class="min-w-[calc(50%-4px)] flex-1 py-2 rounded-xl font-bold text-sm transition-all"
              :class="form.category === cat ? 'tab-active' : 'bg-game-card text-slate-400 hover:text-white'"
              @click="setCategory(cat)"
            >{{ CAT_LABELS[cat] }}</button>
          </div>
          <p v-if="isSubjectBadge" class="text-[11px] text-slate-500 mt-2 leading-relaxed">
            Значок прив’язаний до предмета: учень купує його в магазині й може надіслати вчителю цього предмета (офлайн-активність). Без 3D-моделі — лише емодзі на золотій рамці.
          </p>
        </div>

        <div class="grid grid-cols-2 gap-4">
          <AppInput v-model="form.name" label="Назва" placeholder="Назва предмета" />
          <AppInput v-model="form.price" label="Ціна (монети)" type="number" />
        </div>

        <AppInput v-model="form.description" label="Опис" placeholder="Опис предмета..." />

        <!-- Rarity -->
        <div>
          <label class="text-sm font-bold text-slate-300 block mb-1.5">Рідкісність</label>
          <select
            v-model="form.rarity"
            class="w-full bg-game-bg border border-white/[0.07] rounded-xl px-4 py-3 text-white font-semibold focus:outline-none"
            @change="onRarityChange"
          >
            <option v-for="r in RARITIES" :key="r" :value="r">{{ RARITY_LABELS[r] }}</option>
          </select>
        </div>

        <!-- Skin fields -->
        <template v-if="isSkin && !isSubjectBadge">
          <div>
            <label class="text-sm font-bold text-slate-300 block mb-1.5">Текстура скіна (PNG)</label>
            <label
              class="flex items-center justify-center gap-2 py-3 px-4 bg-game-card border border-dashed rounded-xl cursor-pointer transition-colors font-bold text-sm"
              :class="uploadingSkin ? 'border-white/10 text-slate-500 cursor-wait' : form.skinUrl ? 'border-emerald-500 text-emerald-400' : 'border-white/10 text-slate-400 hover:text-white'"
            >
              <span v-if="uploadingSkin">Завантаження...</span>
              <span v-else-if="form.skinUrl">Текстура завантажена (натисни щоб замінити)</span>
              <span v-else>Завантажити PNG текстуру</span>
              <input type="file" accept=".png,.jpg,.jpeg" class="hidden" :disabled="uploadingSkin" @change="onSkinFileChange" />
            </label>
          </div>
          <AppInput v-model="form.skinId" label="ID скіна (fallback колір)" placeholder="sigma / brainrot / ohio …" />
          <div v-if="form.skinUrl || form.skinId" class="flex items-center gap-4 p-3 bg-game-card rounded-xl">
            <SkinPreview :skin-url="form.skinUrl || null" :skin-id="form.skinId || 'default'" :width="80" :height="110" />
            <div class="text-sm text-slate-400">
              <div v-if="form.skinUrl" class="text-emerald-400 font-bold mb-1">Текстура завантажена</div>
              <div v-else class="text-amber-400 font-bold mb-1">Тільки fallback колір</div>
              <div>Прев'ю персонажа</div>
            </div>
          </div>
        </template>

        <!-- Accessory / Pet / Room GLB -->
        <template v-else-if="(isAccessory || isPet || isRoom) && !isSubjectBadge">
          <div>
            <label class="text-sm font-bold text-slate-300 block mb-1.5">
              {{ isRoom ? '3D модель кімнати (.glb)' : isPet ? '3D модель улюбленця (.glb)' : '3D модель аксесуара (.glb)' }}
            </label>
            <label
              class="flex items-center justify-center gap-2 py-3 px-4 bg-game-card border border-dashed rounded-xl cursor-pointer transition-colors font-bold text-sm"
              :class="pendingModelFile ? 'border-accent text-accent' : form.modelData ? 'border-emerald-500 text-emerald-400' : 'border-white/10 text-slate-400 hover:text-white'"
            >
              <span v-if="pendingModelFile">{{ pendingModelFile.name }}</span>
              <span v-else-if="form.modelData">3D модель (натисни щоб замінити)</span>
              <span v-else>Завантажити .glb модель</span>
              <input type="file" accept=".glb,.gltf" class="hidden" @change="onModelFileSelect" />
            </label>
            <p class="text-[11px] text-slate-500 mt-1">
              {{ isRoom ? 'Макс 700 КБ. Підлога на y=0.' : isPet ? 'Анімація: шукаємо кліп з «idle» у назві, інакше перший кліп.' : 'Позиція на голові персонажа. ~1×1×1 од.' }}
            </p>
          </div>

          <!-- Brightness multiplier — only for rooms -->
          <div v-if="isRoom">
            <label class="text-sm font-bold text-slate-300 block mb-1.5">
              Яскравість кімнати
              <span class="text-xs font-normal text-slate-500 ml-1">(автоматично зчитується з GLB)</span>
            </label>
            <div class="flex items-center gap-3">
              <input
                type="range" min="0.1" max="3.0" step="0.05"
                v-model.number="form.brightnessMultiplier"
                class="flex-1 accent-amber-400"
              />
              <span class="text-sm font-mono text-amber-400 w-10 text-right">{{ Number(form.brightnessMultiplier).toFixed(2) }}</span>
            </div>
            <p class="text-[11px] text-slate-500 mt-1">Множник яскравості сцени. 1.0 = нейтральний.</p>
          </div>
        </template>

        <template v-else-if="isSubjectBadge">
          <div>
            <label class="text-sm font-bold text-slate-300 block mb-1.5">Предмет (з колекції subjects)</label>
            <select
              v-model="form.subjectId"
              class="w-full bg-game-bg border border-white/[0.07] rounded-xl px-4 py-3 text-white font-semibold focus:outline-none"
              @change="syncSubjectNameFromId"
            >
              <option value="" disabled>— оберіть предмет —</option>
              <option v-for="s in subjectsList" :key="s.id" :value="s.id">{{ s.name }}</option>
            </select>
          </div>
          <div>
            <label class="text-sm font-bold text-slate-300 block mb-1.5">Зображення з листа (subjects.png)</label>
            <select
              v-model.number="form.badgeSpriteIndex"
              class="w-full bg-game-bg border border-white/[0.07] rounded-xl px-4 py-3 text-white font-semibold focus:outline-none"
            >
              <option :value="-1">Лише емодзі (без спрайта)</option>
              <option v-for="(label, i) in BADGE_SPRITE_LABELS" :key="i" :value="i">
                {{ i }}. {{ label }}
              </option>
            </select>
          </div>
          <AppInput v-model="form.badgeEmoji" label="Емодзі (запасний варіант)" placeholder="⚛️" />
          <div class="flex items-center gap-4 p-3 bg-game-card rounded-xl">
            <SubjectBadgeArt
              :sprite-index="form.badgeSpriteIndex >= 0 ? form.badgeSpriteIndex : undefined"
              :emoji="form.badgeEmoji || '🏅'"
              :size="72"
            />
            <div class="text-sm text-slate-400">
              <div class="text-amber-400 font-bold mb-1">Прев’ю (легендарна рамка)</div>
              <div>Предмет: {{ form.subjectName || '—' }}</div>
            </div>
          </div>
        </template>

        <!-- Flags -->
        <div class="flex flex-col gap-2.5">
          <label class="flex items-center gap-3 cursor-pointer">
            <input type="checkbox" v-model="form.isLimited" class="w-4 h-4 rounded accent-amber-500" />
            <span class="text-sm font-bold text-slate-300">Обмежений випуск (LTD значок)</span>
          </label>
          <label class="flex items-center gap-3 cursor-pointer">
            <input type="checkbox" v-model="form.limitedStock" class="w-4 h-4 rounded" />
            <span class="text-sm font-bold text-slate-300">Обмежена кількість</span>
          </label>
          <div v-if="form.limitedStock" class="flex items-center gap-3 pl-7">
            <AppInput v-model="form.stock" label="Кількість в запасі" type="number" placeholder="10" class="w-40" />
            <p class="text-xs text-slate-500 mt-5">Після продажу останнього товар стане «Розпродано»</p>
          </div>
        </div>

        <AppButton variant="primary" block :loading="saving || uploadingModel" @click="save">
          <span v-if="uploadingModel">Завантаження моделі...</span>
          <span v-else>{{ editItem ? 'Зберегти зміни' : 'Додати до магазину' }}</span>
        </AppButton>
      </div>
    </AppModal>

    <AppModal v-model="showPurgeModal" title="Видалити всі товари з Firestore?" size="md">
      <div class="flex flex-col gap-4 text-sm text-slate-300">
        <p class="leading-relaxed text-slate-400">
          Буде видалено <span class="text-slate-200 font-bold">{{ items.length }}</span> документів колекції
          <code class="text-xs text-accent px-1">items</code>. Файли в Firebase Storage лишаються — після очищення знову імпортуйте GLB/PNG через кнопки вище, щоб створити нові записи з коректними URL.
        </p>
        <p class="text-amber-400/90 text-xs leading-relaxed">
          У профілях учнів можуть залишитися старі ID предметів у інвентарі; їх доведеться виправити вручну або скинути, якщо потрібно.
        </p>
        <div>
          <label class="text-xs font-bold text-slate-500 uppercase tracking-wide block mb-1.5">Підтвердження</label>
          <p class="text-xs text-slate-500 mb-2">Введіть фразу: <span class="text-slate-300 font-mono">{{ PURGE_CONFIRM_PHRASE }}</span></p>
          <input
            v-model="purgeConfirmText"
            type="text"
            autocomplete="off"
            class="w-full bg-game-bg border border-white/[0.12] rounded-xl px-4 py-3 text-white font-mono text-sm outline-none focus:border-red-500/40"
            placeholder="ВИДАЛИТИ УСІ"
          />
        </div>
        <div class="flex gap-2 justify-end pt-1">
          <AppButton variant="secondary" size="sm" :disabled="purgingAll" @click="closePurgeModal">Скасувати</AppButton>
          <AppButton
            variant="danger"
            size="sm"
            :loading="purgingAll"
            :disabled="purgeConfirmText.trim() !== PURGE_CONFIRM_PHRASE"
            @click="executePurgeAllItems"
          >
            Видалити все
          </AppButton>
        </div>
      </div>
    </AppModal>
  </div>
</template>
