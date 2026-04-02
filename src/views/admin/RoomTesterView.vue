<script setup>
import { ref, computed, onMounted } from 'vue'
import CharacterScene from '@/components/character/CharacterScene.vue'
import SkinThumbnail from '@/components/character/SkinThumbnail.vue'
import { Shirt, ChevronDown } from 'lucide-vue-next'
import { getAllItems } from '@/firebase/collections'

/** Список з Firestore (URL → Firebase Storage), без локальних import.meta.glob */
const shopItems = ref([])
const catalogLoading = ref(true)

onMounted(async () => {
  try {
    shopItems.value = await getAllItems()
  } finally {
    catalogLoading.value = false
  }
})

const rooms = computed(() =>
  shopItems.value
    .filter((i) => i.category === 'room' && i.modelData)
    .map((i) => ({ id: i.id, label: i.name, url: i.modelData }))
    .sort((a, b) => a.label.localeCompare(b.label, 'uk')),
)

const skins = computed(() =>
  shopItems.value
    .filter((i) => i.category === 'skin' && i.skinUrl)
    .map((i) => ({ id: i.id, label: i.name, url: i.skinUrl }))
    .sort((a, b) => a.label.localeCompare(b.label, 'uk')),
)

const accessories = computed(() =>
  shopItems.value
    .filter((i) => i.category === 'accessory' && i.modelData)
    .map((i) => ({ id: i.id, label: i.name, url: i.modelData }))
    .sort((a, b) => a.label.localeCompare(b.label, 'uk')),
)

const pets = computed(() =>
  shopItems.value
    .filter((i) => i.category === 'pet' && i.modelData)
    .map((i) => ({ id: i.id, label: i.name, url: i.modelData }))
    .sort((a, b) => a.label.localeCompare(b.label, 'uk')),
)

// ── Selections ─────────────────────────────────────────────────────────────────
const selectedRoom      = ref(null)
const selectedSkin      = ref(null)        // null = default palette skin
const selectedAccessory = ref(null)        // null = no accessory
const selectedPet       = ref(null)        // null = no pet (CharacterScene petOverrideUrl)
const accessoryBone     = ref('head')
const skinSearch        = ref('')

const BONES = [
  { value: 'head',     label: 'Голова' },
  { value: 'body',     label: 'Тіло' },
  { value: 'leftArm',  label: 'Ліва рука' },
  { value: 'rightArm', label: 'Права рука' },
]

const filteredSkins = computed(() => {
  const q = skinSearch.value.trim().toLowerCase()
  const list = skins.value
  return q ? list.filter((s) => s.label.toLowerCase().includes(q)) : list
})

// Section collapse state
const open = ref({ rooms: true, skins: true, accessories: true, pets: true })

// Live brightness slider — range 0.1–3.0, null means "let CharacterScene decide"
const brightnessOverride = ref(1.0)

const dummyProfile = {
  displayName: 'Preview',
  level: 1,
  coins: 0,
  avatar: { skinId: 'default', skinUrl: null, accessories: [], roomId: null },
}
</script>

<template>
  <div class="flex flex-col gap-3 h-full overflow-hidden">

    <!-- Header -->
    <div class="flex items-center gap-2 flex-shrink-0">
      <Shirt :size="20" :stroke-width="2" class="text-accent" />
      <h1 class="text-xl font-extrabold">Примірочна</h1>
      <span v-if="!catalogLoading" class="text-xs text-slate-500 ml-1">
        {{ rooms.length }} кімнат · {{ skins.length }} скінів · {{ accessories.length }} аксесуарів · {{ pets.length }} улюбленців
      </span>
      <span v-else class="text-xs text-slate-600 ml-1">Завантаження каталогу…</span>
    </div>

    <!-- overflow-hidden bounds the row to its flex-assigned height so that the
         left panel's overflow-y-auto actually clips and creates a scrollbar -->
    <div class="flex gap-3 flex-1 overflow-hidden">

      <!-- ── Left panel: 3 collapsible selectors ──────────────────────────── -->
      <!-- h-full gives a definite height so overflow-y-auto actually activates -->
      <div class="flex flex-col gap-2 w-56 flex-shrink-0 overflow-y-auto h-full">

        <!-- Rooms -->
        <div class="rounded-xl bg-white/[0.03] border border-white/[0.06] overflow-hidden flex-shrink-0">
          <button
            class="w-full flex items-center justify-between px-3 py-2.5 text-sm font-bold text-slate-300 hover:text-white transition-colors"
            @click="open.rooms = !open.rooms"
          >
            <span>Кімнати <span class="font-normal text-slate-600 text-xs">({{ rooms.length }})</span></span>
            <ChevronDown :size="14" class="transition-transform" :class="open.rooms ? '' : '-rotate-90'" />
          </button>
          <div v-show="open.rooms" class="flex flex-col gap-0.5 px-1.5 pb-1.5">
            <button
              class="flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-left transition-all"
              :class="selectedRoom === null ? 'bg-accent/20 text-accent' : 'text-slate-500 hover:text-slate-300 hover:bg-white/[0.05]'"
              @click="selectedRoom = null"
            >— Стандартна</button>
            <button
              v-for="room in rooms"
              :key="room.id"
              @click="selectedRoom = room"
              class="flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-left transition-all"
              :class="selectedRoom?.id === room.id ? 'bg-accent/20 text-accent' : 'text-slate-400 hover:text-slate-200 hover:bg-white/[0.05]'"
            >{{ room.label }}</button>
          </div>
        </div>

        <!-- Skins -->
        <div class="rounded-xl bg-white/[0.03] border border-white/[0.06] overflow-hidden flex-shrink-0">
          <button
            class="w-full flex items-center justify-between px-3 py-2.5 text-sm font-bold text-slate-300 hover:text-white transition-colors"
            @click="open.skins = !open.skins"
          >
            <span>Скіни <span class="font-normal text-slate-600 text-xs">({{ skins.length }})</span></span>
            <ChevronDown :size="14" class="transition-transform" :class="open.skins ? '' : '-rotate-90'" />
          </button>
          <div v-show="open.skins" class="flex flex-col gap-0.5 px-1.5 pb-1.5">
            <input
              v-model="skinSearch"
              placeholder="Пошук..."
              class="w-full px-2.5 py-1.5 mb-1 rounded-lg bg-white/[0.06] border border-white/[0.08] text-xs text-slate-200 placeholder:text-slate-600 outline-none focus:border-accent/40"
            />
            <button
              class="flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-left transition-all"
              :class="selectedSkin === null ? 'bg-accent/20 text-accent' : 'text-slate-500 hover:text-slate-300 hover:bg-white/[0.05]'"
              @click="selectedSkin = null"
            >— За замовчуванням</button>
            <button
              v-for="skin in filteredSkins"
              :key="skin.id"
              @click="selectedSkin = skin"
              class="flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs font-semibold text-left transition-all"
              :class="selectedSkin?.id === skin.id ? 'bg-accent/20 text-accent' : 'text-slate-400 hover:text-slate-200 hover:bg-white/[0.05]'"
            >
              <SkinThumbnail :skin-url="skin.url" :size="24" class="rounded flex-shrink-0" />
              <span class="truncate">{{ skin.label }}</span>
            </button>
            <div v-if="filteredSkins.length === 0" class="text-xs text-slate-600 py-3 text-center">Нічого не знайдено</div>
          </div>
        </div>

        <!-- Accessories -->
        <div class="rounded-xl bg-white/[0.03] border border-white/[0.06] overflow-hidden flex-shrink-0">
          <button
            class="w-full flex items-center justify-between px-3 py-2.5 text-sm font-bold text-slate-300 hover:text-white transition-colors"
            @click="open.accessories = !open.accessories"
          >
            <span>Аксесуари <span class="font-normal text-slate-600 text-xs">({{ accessories.length }})</span></span>
            <ChevronDown :size="14" class="transition-transform" :class="open.accessories ? '' : '-rotate-90'" />
          </button>
          <div v-show="open.accessories" class="flex flex-col gap-0.5 px-1.5 pb-1.5">
            <!-- Bone selector -->
            <div class="flex gap-1 flex-wrap mb-1">
              <button
                v-for="b in BONES"
                :key="b.value"
                @click="accessoryBone = b.value"
                class="flex-1 px-1.5 py-1 rounded-lg text-[10px] font-semibold transition-all"
                :class="accessoryBone === b.value ? 'bg-accent/20 text-accent' : 'bg-white/[0.04] text-slate-500 hover:text-slate-300'"
              >{{ b.label }}</button>
            </div>
            <button
              class="flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-left transition-all"
              :class="selectedAccessory === null ? 'bg-accent/20 text-accent' : 'text-slate-500 hover:text-slate-300 hover:bg-white/[0.05]'"
              @click="selectedAccessory = null"
            >— Без аксесуара</button>
            <div v-if="accessories.length === 0" class="text-xs text-slate-600 py-3 text-center">
              Імпортуйте GLB у магазин<br/>(Товари → Аксесуари GLB → Storage)
            </div>
            <button
              v-for="acc in accessories"
              :key="acc.id"
              @click="selectedAccessory = acc"
              class="flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-left transition-all"
              :class="selectedAccessory?.id === acc.id ? 'bg-accent/20 text-accent' : 'text-slate-400 hover:text-slate-200 hover:bg-white/[0.05]'"
            >{{ acc.label }}            </button>
          </div>
        </div>

        <!-- Pets -->
        <div class="rounded-xl bg-white/[0.03] border border-white/[0.06] overflow-hidden flex-shrink-0">
          <button
            class="w-full flex items-center justify-between px-3 py-2.5 text-sm font-bold text-slate-300 hover:text-white transition-colors"
            @click="open.pets = !open.pets"
          >
            <span>Улюбленці <span class="font-normal text-slate-600 text-xs">({{ pets.length }})</span></span>
            <ChevronDown :size="14" class="transition-transform" :class="open.pets ? '' : '-rotate-90'" />
          </button>
          <div v-show="open.pets" class="flex flex-col gap-0.5 px-1.5 pb-1.5">
            <button
              class="flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-left transition-all"
              :class="selectedPet === null ? 'bg-accent/20 text-accent' : 'text-slate-500 hover:text-slate-300 hover:bg-white/[0.05]'"
              @click="selectedPet = null"
            >— Без улюбленця</button>
            <div v-if="pets.length === 0" class="text-xs text-slate-600 py-3 text-center">
              Імпортуйте GLB у магазин<br/>(Товари → Улюбленці GLB → Storage)
            </div>
            <button
              v-for="p in pets"
              :key="p.id"
              @click="selectedPet = p"
              class="flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-left transition-all"
              :class="selectedPet?.id === p.id ? 'bg-accent/20 text-accent' : 'text-slate-400 hover:text-slate-200 hover:bg-white/[0.05]'"
            >{{ p.label }}</button>
          </div>
        </div>

      </div>

      <!-- ── 3D Preview ─────────────────────────────────────────────────────── -->
      <div class="flex-1 flex flex-col gap-2 min-w-0">
        <div class="flex-1 rounded-2xl overflow-hidden" style="background: #111">
          <CharacterScene
            :profile="dummyProfile"
            :room-mode="true"
            :interactive="true"
            :room-override-url="selectedRoom?.url ?? null"
            :skin-override-url="selectedSkin?.url ?? null"
            :accessory-override-url="selectedAccessory?.url ?? null"
            :accessory-bone="accessoryBone"
            :pet-override-url="selectedPet?.url ?? null"
            :brightness-override="brightnessOverride"
          />
        </div>

        <!-- Status bar + brightness -->
        <div class="flex items-center gap-4 px-4 py-2 rounded-xl bg-game-card text-xs text-slate-500 flex-shrink-0">
          <span>
            🏠 <span class="text-slate-300">{{ selectedRoom?.label ?? 'Стандартна' }}</span>
          </span>
          <span>·</span>
          <span>
            👤 <span class="text-slate-300">{{ selectedSkin?.label ?? 'Default' }}</span>
          </span>
          <span>·</span>
          <span>
            ✨ <span class="text-slate-300">{{ selectedAccessory?.label ?? 'Без аксесуара' }}</span>
            <span v-if="selectedAccessory" class="text-slate-600 ml-1">({{ accessoryBone }})</span>
          </span>
          <span>·</span>
          <span>
            🐾 <span class="text-slate-300">{{ selectedPet?.label ?? 'Без улюбленця' }}</span>
          </span>

          <!-- Brightness control -->
          <div class="ml-auto flex items-center gap-2">
            <span class="text-slate-500">☀</span>
            <input
              type="range" min="0.1" max="3.0" step="0.05"
              v-model.number="brightnessOverride"
              class="w-28 accent-amber-400 cursor-pointer"
              title="Яскравість сцени"
            />
            <span class="font-mono text-amber-400 w-8 text-right">{{ brightnessOverride.toFixed(2) }}</span>
          </div>
        </div>
      </div>

    </div>
  </div>
</template>
