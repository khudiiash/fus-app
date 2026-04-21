<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useShopStore } from '@/stores/shop'
import { useAuthStore } from '@/stores/auth'
import { useUserStore } from '@/stores/user'
import { useToast } from '@/composables/useToast'
import { useHaptic } from '@/composables/useHaptic'
import { checkAndGrantAchievements } from '@/firebase/collections'
import AppButton from '@/components/ui/AppButton.vue'
import AppModal from '@/components/ui/AppModal.vue'
import CoinDisplay from '@/components/gamification/CoinDisplay.vue'
import Skin3dThumbnail  from '@/components/character/Skin3dThumbnail.vue'
import GlbThumbnail     from '@/components/character/GlbThumbnail.vue'
import SubjectBadgeArt from '@/components/shop/SubjectBadgeArt.vue'
import BlockWorldShopThumb from '@/components/shop/BlockWorldShopThumb.vue'
import MysteryBoxSprite from '@/components/shop/MysteryBoxSprite.vue'
import MysteryBoxRevealModal from '@/components/shop/MysteryBoxRevealModal.vue'
import { ShoppingBag, Sparkles, Palette, ChefHat, Home, Package, CheckCircle2, Clock, Medal, PawPrint, Gift } from 'lucide-vue-next'

const shop      = useShopStore()
const auth      = useAuthStore()
const userStore = useUserStore()
const { success, error } = useToast()
const { coin: hapticCoin } = useHaptic()

const activeCategory = ref('all')
const selectedItem   = ref(null)
const buying         = ref(false)
/** Open-box flow state. {@link MysteryBoxRevealModal} drives the animation — we just feed revealed data. */
const openingBox      = ref(false)
const revealOpen      = ref(false)
const revealed        = ref(null)
const revealBoxRarity = ref('common')

watch(revealOpen, (v) => {
  if (!v) revealed.value = null
})

const CATEGORIES = [
  { key: 'all',          label: 'Усе',             Icon: Sparkles },
  { key: 'skin',         label: 'Скіни',           Icon: Palette  },
  { key: 'accessory',    label: 'Аксесуари',       Icon: ChefHat  },
  { key: 'pet',          label: 'Улюбленці',       Icon: PawPrint },
  { key: 'room',         label: 'Кімнати',         Icon: Home },
  { key: 'subject_badge', label: 'Значки',          Icon: Medal },
  { key: 'block_world',  label: 'Світ',            Icon: Package },
  { key: 'mystery_box',  label: 'Коробки',         Icon: Gift },
]

onMounted(async () => {
  // shop.fetchItems() reuses userStore catalog when present (one Firestore read, not two).
  await shop.fetchItems()
})

const displayed = computed(() => {
  if (activeCategory.value === 'all') return shop.items
  return shop.items.filter(i => i.category === activeCategory.value)
})

const sorted = computed(() => {
  const rarityOrder = { legendary: 0, epic: 1, rare: 2, common: 3 }
  return [...displayed.value].sort((a, b) => (rarityOrder[a.rarity] ?? 3) - (rarityOrder[b.rarity] ?? 3))
})

const CAT_LABEL = { skin: 'Скін', accessory: 'Аксесуар', pet: 'Улюбленець', room: 'Кімната', subject_badge: 'Предметний значок', block_world: 'Світ', mystery_box: 'Магічна коробка' }

function stackCount(itemId) {
  return shop.inventoryStackCount(itemId)
}

/** Stock on profile as {@code mysteryBoxCounts[itemId]} — separate from {@code inventory}. */
function boxCount(itemId) {
  return shop.mysteryBoxCount(itemId)
}

/**
 * Effective price after Friday discount (20-80 % off, deterministic per day+item).
 * Kept as a function rather than a computed map so template calls stay compact.
 */
function priceFor(item) {
  return shop.priceFor(item)
}
function discountFor(item) {
  return shop.discountFor(item)
}

/**
 * Subject-badge gate: pays with {@code subjectCoins} earned from that subject only.
 * Normal items pay from {@code auth.profile.coins}. See {@link purchaseItem} in
 * `src/firebase/collections.js` for the matching server-side check.
 */
function canAfford(item) {
  const cost = priceFor(item)
  if (item.coinKind === 'subject_earned') {
    return shop.subjectBadgeBudget(item.subjectName) >= cost
  }
  return (auth.profile?.coins || 0) >= cost
}

function shortage(item) {
  const cost = priceFor(item)
  if (item.coinKind === 'subject_earned') {
    return Math.max(0, cost - shop.subjectBadgeBudget(item.subjectName))
  }
  return Math.max(0, cost - (auth.profile?.coins || 0))
}

function isSoldOut(item) {
  return item.stock !== null && item.stock !== undefined && item.stock <= 0
}
function stockInfo(item) {
  if (item.stock === null || item.stock === undefined) return null
  if (item.stock === 0) return { text: 'Розпродано', cls: 'text-red-400' }
  if (item.stock <= 5)  return { text: `Залишок: ${item.stock}`, cls: 'text-orange-400' }
  return null
}

async function buyItem() {
  if (!selectedItem.value) return
  buying.value = true
  try {
    const boughtId = selectedItem.value.id
    await shop.buy(boughtId)
    await checkAndGrantAchievements(auth.profile.id)
    hapticCoin()
    const fresh = shop.items.find((i) => i.id === boughtId)
    if (fresh && selectedItem.value) selectedItem.value = fresh
    const cat = selectedItem.value?.category
    if (cat === 'subject_badge') {
      success(`Значок «${selectedItem.value.name}» додано! Передай його вчителю в «Профіль».`)
    } else if (cat === 'mystery_box') {
      success(`Коробку «${selectedItem.value.name}» куплено! Відкрий зараз або збережи на потім.`)
    } else {
      success(`🎉 ${selectedItem.value.name} розблоковано!`)
      selectedItem.value = null
    }
  } catch (e) {
    error(e.message)
  } finally {
    buying.value = false
  }
}

/**
 * Reveal-roll flow:
 *   1. {@link shop.openBox} debits `mysteryBoxCounts`, rolls loot server-side, returns `{ coins, itemIds }`.
 *   2. We enrich `itemIds` into full item objects for the reveal animation (shop → userStore → id fallback).
 *   3. {@link MysteryBoxRevealModal} animates and finally commits.
 */
function resolveItemMeta(id) {
  const fromShop = shop.items.find((i) => i.id === id)
  if (fromShop) return fromShop
  const fromAll = userStore.items?.find((i) => i.id === id)
  if (fromAll) return fromAll
  return { id, name: id }
}

async function openMysteryBoxAction() {
  if (!selectedItem.value || selectedItem.value.category !== 'mystery_box') return
  revealBoxRarity.value = selectedItem.value.rarity || 'common'
  openingBox.value = true
  try {
    const r = await shop.openBox(selectedItem.value.id)
    await checkAndGrantAchievements(auth.profile.id)
    hapticCoin()
    revealed.value = {
      coins: r.coins,
      items: (r.itemIds || []).map((id) => resolveItemMeta(id)),
    }
    revealOpen.value = true
  } catch (e) {
    error(e.message)
  } finally {
    openingBox.value = false
  }
}

const rarityGlow = { legendary: 'glow-legendary', epic: 'glow-epic', rare: 'glow-rare', common: '' }

/** Radial wash behind grid thumbnails (matches glow-* palette in style.css) */
function rarityRadialBg(rarity) {
  const rgb = {
    legendary: '251,191,36',
    epic: '192,132,252',
    rare: '96,165,250',
    common: '148,163,184',
  }[rarity] || '148,163,184'
  return `radial-gradient(ellipse 82% 78% at 50% 40%, rgba(${rgb},0.42) 0%, rgba(${rgb},0.14) 42%, rgba(${rgb},0.03) 62%, transparent 74%)`
}

/**
 * Modal preview: circle larger than the skin so the rarity wash frames the model, not only behind it.
 */
function rarityRadialBgModal(rarity) {
  const rgb = {
    legendary: '251,191,36',
    epic: '192,132,252',
    rare: '96,165,250',
    common: '148,163,184',
  }[rarity] || '148,163,184'
  return `radial-gradient(circle min(240px, 78vw) at 50% 42%, rgba(${rgb},0.5) 0%, rgba(${rgb},0.22) 40%, rgba(${rgb},0.08) 62%, transparent 82%)`
}

/** Grid thumbnails ~30% smaller than previous shop layout */
const THUMB_SKIN_W = 78
const THUMB_SKIN_H = 106
const THUMB_GLB_W = 130
const THUMB_GLB_H = 176
/** Modal GLB preview — same renderer as grid cards, slightly larger for detail */
const MODAL_GLB_W = 140
const MODAL_GLB_H = 190
/** Modal skin — baked PNG via skinThumbnailRenderer (memory + IndexedDB), not live SkinViewer */
const MODAL_SKIN_W = 140
const MODAL_SKIN_H = 200
/** Block world: sprite / block icon (no WebGL) */
const THUMB_BW = 96
const MODAL_BW = 120
</script>

<template>
  <div class="flex flex-col gap-4 animate-fade-in">
    <!-- Header -->
    <div class="flex items-center justify-between">
      <div>
        <div class="flex items-center gap-2 mb-0.5">
          <ShoppingBag :size="22" :stroke-width="2" class="text-amber-500" />
          <h1 class="text-2xl font-extrabold gradient-heading">Магазин</h1>
        </div>
        <p class="text-slate-500 text-sm">Витрачай монети на предмети для аватара</p>
      </div>
    </div>

    <!-- Friday all-day discount banner (20-80% off every item) -->
    <div
      v-if="shop.anyDiscountActive"
      class="rounded-2xl p-3 flex items-center gap-3 border border-red-500/25"
      style="background: linear-gradient(135deg, rgba(239,68,68,0.18), rgba(249,115,22,0.12))"
    >
      <div class="text-2xl">🔥</div>
      <div class="flex-1 text-sm">
        <div class="font-extrabold text-red-300">П'ятничні знижки</div>
        <div class="text-[11px] text-slate-300/90">Кожен товар — зі знижкою від 20 % до 80 %, тільки сьогодні до опівночі.</div>
      </div>
    </div>

    <!-- Category tabs: текст лише для «Усе», решта — іконки (підказка в title) -->
    <div class="flex p-1 rounded-2xl gap-0.5" style="background:rgba(255,255,255,0.05)">
      <button
        v-for="cat in CATEGORIES"
        :key="cat.key"
        type="button"
        class="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl font-bold transition-all duration-200"
        :class="[
          activeCategory === cat.key ? 'tab-active' : 'text-slate-500 hover:text-slate-300',
          cat.key === 'all' ? 'text-xs' : '',
        ]"
        :title="cat.key === 'all' ? undefined : cat.label"
        :aria-label="cat.label"
        @click="activeCategory = cat.key"
      >
        <component
          :is="cat.Icon"
          :size="cat.key === 'all' ? 14 : 18"
          :stroke-width="activeCategory === cat.key ? 2.2 : 1.8"
        />
        <span v-if="cat.key === 'all'">{{ cat.label }}</span>
      </button>
    </div>

    <!-- Items grid -->
    <div v-if="sorted.length === 0" class="text-center py-16 text-slate-600">
      <ShoppingBag :size="44" :stroke-width="1" class="mx-auto mb-3 opacity-30" />
      <div class="font-bold text-slate-500">Товарів поки немає</div>
      <div class="text-sm mt-1">Заходь пізніше за новинками!</div>
    </div>

    <div v-else class="grid grid-cols-2 gap-3">
      <div
        v-for="item in sorted"
        :key="item.id"
        class="item-card overflow-hidden cursor-pointer transition-[transform,opacity] duration-200 ease-out active:scale-[0.98] rounded-2xl flex flex-col"
        :class="rarityGlow[item.rarity]"
        @click="selectedItem = item"
      >
        <!-- Preview area — ~30% shorter than before; rarity radial behind model -->
        <div class="relative flex items-center justify-center bg-transparent min-h-[185px] py-1">
          <div
            class="absolute inset-0 pointer-events-none rounded-t-2xl overflow-hidden"
            :style="{ background: rarityRadialBg(item.rarity) }"
            aria-hidden="true"
          />
          <div class="relative z-[1] flex items-center justify-center min-h-[120px]">
            <Skin3dThumbnail
              v-if="item.category === 'skin'"
              :skin-url="item.skinUrl" :skin-id="item.skinId || 'default'"
              :width="THUMB_SKIN_W"
              :height="THUMB_SKIN_H"
            />
            <!-- GLB: один спільний WebGL-рендер, черга + кеш у glbThumbnailRenderer -->
            <GlbThumbnail
              v-else-if="item.category === 'room' && item.modelData"
              :model-data="item.modelData"
              :width="THUMB_GLB_W"
              :height="THUMB_GLB_H"
              is-room
            />
            <GlbThumbnail
              v-else-if="item.category === 'accessory' && item.modelData"
              :model-data="item.modelData"
              :width="THUMB_GLB_W"
              :height="THUMB_GLB_H"
            />
            <GlbThumbnail
              v-else-if="item.category === 'pet' && item.modelData"
              :model-data="item.modelData"
              :width="THUMB_GLB_W"
              :height="THUMB_GLB_H"
            />
            <div
              v-else-if="item.category === 'subject_badge'"
              class="relative z-[1] flex flex-col items-center justify-center py-2 min-h-[120px]"
            >
              <SubjectBadgeArt :sprite-index="item.badgeSpriteIndex" :emoji="item.badgeEmoji || '🏅'" :size="112" />
            </div>
            <div
              v-else-if="item.category === 'block_world'"
              class="relative z-[1] flex flex-col items-center justify-center gap-1.5 py-3 min-h-[120px] text-slate-200"
            >
              <BlockWorldShopThumb :item="item" :size="THUMB_BW" />
              <span class="text-[10px] font-bold text-slate-500">Спільний світ</span>
            </div>
            <div
              v-else-if="item.category === 'mystery_box'"
              class="relative z-[1] flex flex-col items-center justify-center py-2 min-h-[120px]"
            >
              <MysteryBoxSprite :rarity="item.rarity || 'common'" :size="112" />
            </div>
            <div v-else class="opacity-20 flex items-center justify-center w-full py-6">
              <Home v-if="item.category === 'room'" :size="56" :stroke-width="1" />
              <PawPrint v-else-if="item.category === 'pet'" :size="56" :stroke-width="1" />
              <Package v-else :size="56" :stroke-width="1" />
            </div>
          </div>
          <!-- Badges -->
          <div class="absolute top-2 left-2 flex flex-col gap-1">
            <div
              v-if="isSoldOut(item) && !(item.category === 'mystery_box' && boxCount(item.id) > 0)"
              class="text-[10px] font-extrabold bg-slate-700 text-slate-300 px-1.5 py-0.5 rounded-full tracking-wide"
            >Розпродано</div>
            <div v-else-if="item.isLimited" class="text-[10px] font-extrabold bg-red-500 text-white px-1.5 py-0.5 rounded-full tracking-wide">LTD</div>
            <div v-else-if="stockInfo(item)" class="text-[10px] font-extrabold bg-orange-500/80 text-white px-1.5 py-0.5 rounded-full tracking-wide">{{ stockInfo(item).text }}</div>
          </div>
          <!-- Stack / owned badge (mystery boxes + subject badges stack, others just show "owned") -->
          <div
            v-if="item.category === 'mystery_box' && boxCount(item.id) > 0"
            class="absolute bottom-2 right-2 min-w-[1.5rem] h-6 px-1.5 rounded-full bg-amber-500 flex items-center justify-center text-[10px] font-extrabold text-slate-900"
          >
            ×{{ boxCount(item.id) }}
          </div>
          <div
            v-else-if="item.category === 'subject_badge' && stackCount(item.id) > 0"
            class="absolute bottom-2 right-2 min-w-[1.5rem] h-6 px-1.5 rounded-full bg-amber-500 flex items-center justify-center text-[10px] font-extrabold text-slate-900"
          >
            ×{{ stackCount(item.id) }}
          </div>
          <div v-else-if="shop.isOwned(item.id)" class="absolute bottom-2 right-2 w-6 h-6 rounded-full bg-emerald-500 flex items-center justify-center">
            <CheckCircle2 :size="14" :stroke-width="2.5" class="text-white" />
          </div>
          <!-- Sold out overlay (коробки й значки не затемнюємо, якщо ще є в запасі) -->
          <div
            v-if="isSoldOut(item) && !shop.isOwned(item.id) && !(item.category === 'mystery_box' && boxCount(item.id) > 0) && !(item.category === 'subject_badge' && stackCount(item.id) > 0)"
            class="absolute inset-0 bg-black/50 rounded-t-2xl"
          />
        </div>

        <!-- Info strip -->
        <div class="px-3 py-2.5 flex items-center justify-between gap-2 bg-game-card/60">
          <div class="font-bold text-xs truncate" :class="isSoldOut(item) ? 'text-slate-500' : 'text-slate-200'">{{ item.name }}</div>
          <div class="flex items-center gap-1.5 shrink-0">
            <span
              v-if="discountFor(item).isActive"
              class="text-[10px] font-extrabold text-red-400 line-through opacity-70"
            >{{ discountFor(item).basePrice }}</span>
            <CoinDisplay
              :amount="priceFor(item)"
              size="sm"
              :class="(!canAfford(item) && !shop.isOwned(item.id)) || isSoldOut(item) ? 'opacity-30' : ''"
            />
          </div>
        </div>
        <div
          v-if="discountFor(item).isActive"
          class="absolute top-2 right-2 text-[10px] font-extrabold bg-red-500/90 text-white px-1.5 py-0.5 rounded-full tracking-wide shadow"
        >−{{ discountFor(item).pct }}%</div>
      </div>
    </div>

    <!-- Item detail modal -->
    <AppModal :modelValue="!!selectedItem" :title="selectedItem?.name" @update:modelValue="v => { if (!v) selectedItem = null }">
      <div v-if="selectedItem" class="flex flex-col gap-4">
        <!-- w-fit = glow box matches thumbnail, not full modal width (fixes stretched / clipped radial) -->
        <div class="flex justify-center py-1">
          <div class="relative w-fit max-w-full mx-auto px-8 py-7">
            <div
              class="absolute inset-0 pointer-events-none rounded-2xl overflow-hidden"
              :style="{ background: rarityRadialBgModal(selectedItem.rarity) }"
              aria-hidden="true"
            />
            <div class="relative z-[1] flex flex-col items-center justify-center gap-1.5">
            <Skin3dThumbnail
              v-if="selectedItem.category === 'skin'"
              :skin-url="selectedItem.skinUrl"
              :skin-id="selectedItem.skinId || 'default'"
              :width="MODAL_SKIN_W"
              :height="MODAL_SKIN_H"
            />
            <GlbThumbnail
              v-else-if="selectedItem.category === 'room' && selectedItem.modelData"
              :model-data="selectedItem.modelData"
              :width="MODAL_GLB_W"
              :height="MODAL_GLB_H"
              is-room
            />
            <GlbThumbnail
              v-else-if="selectedItem.category === 'accessory' && selectedItem.modelData"
              :model-data="selectedItem.modelData"
              :width="MODAL_GLB_W"
              :height="MODAL_GLB_H"
            />
            <GlbThumbnail
              v-else-if="selectedItem.category === 'pet' && selectedItem.modelData"
              :model-data="selectedItem.modelData"
              :width="MODAL_GLB_W"
              :height="MODAL_GLB_H"
            />
            <template v-else-if="selectedItem.category === 'subject_badge'">
              <SubjectBadgeArt :sprite-index="selectedItem.badgeSpriteIndex" :emoji="selectedItem.badgeEmoji || '🏅'" :size="100" />
              <p v-if="selectedItem.subjectName" class="text-[11px] text-amber-200/90 font-bold text-center px-2">
                {{ selectedItem.subjectName }}
              </p>
              <p class="text-[10px] text-slate-500 text-center px-2 max-w-[280px] leading-snug">
                Легендарний значок. Купи кілька й передай вчителю цього предмета після офлайн-активності (Профіль → Значки).
              </p>
            </template>
            <template v-else-if="selectedItem.category === 'block_world'">
              <BlockWorldShopThumb :item="selectedItem" :size="MODAL_BW" />
              <p class="text-[11px] text-slate-400 text-center px-2 max-w-[300px] leading-snug">
                Після покупки предмет зʼявиться в хотбарі спільного світу (вкладка «Світ (блоки)» тут у магазині). Кулак завжди доступний безкоштовно.
              </p>
            </template>
            <template v-else-if="selectedItem.category === 'mystery_box'">
              <MysteryBoxSprite :rarity="selectedItem.rarity || 'common'" :size="140" />
              <p class="text-[11px] text-slate-400 text-center px-2 max-w-[260px] leading-snug">
                Випадкові монети (до ~1,5× ціни коробки) та шанс на предмети з магазину за рідкістю коробки.
              </p>
            </template>
            <div v-else class="opacity-20 py-4 flex items-center justify-center">
              <Home v-if="selectedItem.category === 'room'" :size="80" :stroke-width="1" />
              <PawPrint v-else-if="selectedItem.category === 'pet'" :size="80" :stroke-width="1" />
              <Package v-else :size="80" :stroke-width="1" />
            </div>
            </div>
          </div>
        </div>

        <div class="flex items-center justify-between text-xs text-slate-400">
          <span class="font-bold capitalize" :class="{
            'text-amber-400': selectedItem.rarity === 'legendary',
            'text-purple-400': selectedItem.rarity === 'epic',
            'text-blue-400': selectedItem.rarity === 'rare',
            'text-slate-400': selectedItem.rarity === 'common',
          }">{{ { legendary: 'Легендарний', epic: 'Епічний', rare: 'Рідкісний', common: 'Звичайний' }[selectedItem.rarity] || selectedItem.rarity }}</span>
          <span class="capitalize">{{ CAT_LABEL[selectedItem.category] || selectedItem.category }}</span>
        </div>

        <p v-if="selectedItem.description" class="text-slate-300 text-sm">{{ selectedItem.description }}</p>

        <!-- Flags row -->
        <div class="flex gap-2 flex-wrap">
          <div v-if="isSoldOut(selectedItem)" class="flex items-center gap-1.5 rounded-xl px-3 py-1.5" style="background:rgba(100,100,100,0.15)">
            <div class="text-xs text-slate-400 font-bold">Розпродано</div>
          </div>
          <div v-else-if="selectedItem.isLimited" class="flex items-center gap-1.5 rounded-xl px-3 py-1.5" style="background:rgba(239,68,68,0.08)">
            <Clock :size="13" :stroke-width="2" class="text-red-400" />
            <div class="text-xs text-red-400 font-bold">Обмежений випуск</div>
          </div>
          <div v-if="stockInfo(selectedItem)" class="flex items-center gap-1.5 rounded-xl px-3 py-1.5" style="background:rgba(249,115,22,0.08)">
            <div class="text-xs font-bold" :class="stockInfo(selectedItem).cls">{{ stockInfo(selectedItem).text }}</div>
          </div>
        </div>

        <div class="glass-card p-4 flex items-center justify-between">
          <div class="text-sm font-bold text-slate-400">Ціна</div>
          <div class="flex items-center gap-2">
            <span
              v-if="discountFor(selectedItem).isActive"
              class="text-xs font-extrabold text-red-400 line-through opacity-70"
            >{{ discountFor(selectedItem).basePrice }}</span>
            <CoinDisplay :amount="priceFor(selectedItem)" size="md" />
            <span
              v-if="discountFor(selectedItem).isActive"
              class="text-[10px] font-extrabold bg-red-500/90 text-white px-1.5 py-0.5 rounded-full"
            >−{{ discountFor(selectedItem).pct }}%</span>
          </div>
        </div>

        <div
          v-if="selectedItem.coinKind === 'subject_earned' && selectedItem.subjectName"
          class="flex items-center justify-between rounded-xl px-3 py-2 text-xs"
          style="background:rgba(139,92,246,0.08)"
        >
          <span class="text-violet-300 font-bold">Монети з «{{ selectedItem.subjectName }}»</span>
          <span class="text-violet-200 font-extrabold">{{ shop.subjectBadgeBudget(selectedItem.subjectName) }} 🪙</span>
        </div>

        <template v-if="selectedItem.category === 'subject_badge'">
          <div
            v-if="stackCount(selectedItem.id) > 0"
            class="flex flex-col gap-0.5 rounded-xl p-2.5"
            style="background:rgba(251,191,36,0.08)"
          >
            <div class="text-amber-400 font-extrabold text-xs">У тебе: ×{{ stackCount(selectedItem.id) }}</div>
            <div class="text-[11px] text-slate-500 leading-snug">Відкрий «Профіль» → вкладка «Значки», щоб надіслати вчителю.</div>
          </div>
          <AppButton
            v-if="!isSoldOut(selectedItem)"
            variant="coin"
            size="lg"
            block
            :loading="buying"
            :disabled="!canAfford(selectedItem)"
            @click="buyItem"
          >
            {{ canAfford(selectedItem) ? 'Купити ще' : `Не вистачає ${shortage(selectedItem)}` }}
          </AppButton>
        </template>

        <template v-else-if="selectedItem.category === 'mystery_box'">
          <div
            v-if="boxCount(selectedItem.id) > 0"
            class="flex flex-col gap-0.5 rounded-xl p-2.5"
            style="background:rgba(251,191,36,0.08)"
          >
            <div class="text-amber-400 font-extrabold text-xs">У тебе коробок: ×{{ boxCount(selectedItem.id) }}</div>
            <div class="text-[11px] text-slate-500 leading-snug">Відкрий зараз — або купи ще в запас.</div>
          </div>
          <AppButton
            v-if="boxCount(selectedItem.id) > 0"
            variant="primary"
            size="lg"
            block
            :loading="openingBox"
            @click="openMysteryBoxAction"
          >
            <Gift :size="16" :stroke-width="2" /> Відкрити коробку
          </AppButton>
          <AppButton
            v-if="!isSoldOut(selectedItem)"
            variant="coin"
            size="lg"
            block
            :loading="buying"
            :disabled="!canAfford(selectedItem)"
            @click="buyItem"
          >
            {{ canAfford(selectedItem) ? (boxCount(selectedItem.id) > 0 ? 'Купити ще' : 'Купити') : `Не вистачає ${shortage(selectedItem)}` }}
          </AppButton>
          <div
            v-else-if="boxCount(selectedItem.id) === 0"
            class="flex items-center justify-center gap-1.5 rounded-2xl p-3"
            style="background:rgba(100,100,100,0.1)"
          >
            <div class="text-sm text-slate-500 font-bold">Розпродано</div>
          </div>
        </template>

        <template v-else>
          <div v-if="shop.isOwned(selectedItem.id)" class="flex flex-col items-center gap-1 rounded-2xl p-3" style="background:rgba(52,211,153,0.08)">
            <div class="flex items-center gap-1.5 text-emerald-400 font-extrabold text-sm">
              <CheckCircle2 :size="15" :stroke-width="2.5" /> Вже є у вас
            </div>
            <div class="text-xs text-slate-500">Встанови у розділі «Профіль»</div>
          </div>

          <div v-else-if="isSoldOut(selectedItem)" class="flex items-center justify-center gap-1.5 rounded-2xl p-3" style="background:rgba(100,100,100,0.1)">
            <div class="text-sm text-slate-500 font-bold">Цей товар розпродано</div>
          </div>

          <AppButton
            v-else
            variant="coin"
            size="lg"
            block
            :loading="buying"
            :disabled="!canAfford(selectedItem)"
            @click="buyItem"
          >
            {{ canAfford(selectedItem) ? 'Купити' : `Не вистачає ${shortage(selectedItem)}` }}
          </AppButton>
        </template>
      </div>
    </AppModal>

    <!-- Animated reveal of coins + rolled items after `openBox` resolves. -->
    <MysteryBoxRevealModal
      v-model="revealOpen"
      :revealed="revealed"
      :box-rarity="revealBoxRarity"
    />
  </div>
</template>

<style scoped>
.item-card {
  background: #1c1c1c;
  box-shadow: inset 0 0 0 1px rgba(255,255,255,0.07), 0 4px 16px rgba(0,0,0,0.4);
}
.item-card:hover { box-shadow: inset 0 0 0 1px rgba(255,255,255,0.14), 0 4px 16px rgba(0,0,0,0.4); }
</style>
