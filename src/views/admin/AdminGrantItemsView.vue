<script setup>
/**
 * Admin tool: grant any shop item (or mystery box) to one or more students.
 * Separate from the "set coins" panel in {@link DevToolsView.vue} so it stays discoverable.
 *
 * Wire-up:
 *  • Route: `admin-grant` (see `src/router/index.js`).
 *  • RPC: {@link adminGrantItemToStudent} in `src/firebase/collections.js` — a transactional
 *    write that handles both {@code inventory / inventoryCounts} and {@code mysteryBoxCounts}.
 *    Called once per student; failures are aggregated in the toast but don't roll back others.
 *  • Activity: each call logs a {@code type: 'admin_grant'} transaction per recipient.
 */
import { computed, onMounted, ref } from 'vue'
import {
  Gift,
  Search,
  Medal,
  Package,
  Sparkles,
  PawPrint,
  Home,
  Palette,
  ShoppingBag,
  Users,
  CheckSquare,
  Square,
} from 'lucide-vue-next'
import AppButton from '@/components/ui/AppButton.vue'
import AppCard from '@/components/ui/AppCard.vue'
import {
  adminGrantItemToStudent,
  getActiveItems,
  getAllStudents,
  getAllClasses,
} from '@/firebase/collections'
import { useToast } from '@/composables/useToast'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const { success, error } = useToast()

const students = ref([])
const classes = ref([])
const items = ref([])
const loading = ref(true)

const studentSearch = ref('')
const classFilter = ref('all')
const itemSearch = ref('')
const categoryFilter = ref('all')
/**
 * Multi-select state — Set for O(1) toggle/lookup in Vue templates.
 * Kept as a `ref<Set>` with immutable replacement on mutation so reactivity fires.
 */
const selectedStudentIds = ref(new Set())
const selectedItemId = ref('')
const qty = ref(1)
const granting = ref(false)

const CATEGORIES = [
  { key: 'all', label: 'Усі', Icon: Sparkles },
  { key: 'skin', label: 'Скіни', Icon: Palette },
  { key: 'accessory', label: 'Аксесуари', Icon: ShoppingBag },
  { key: 'pet', label: 'Улюбленці', Icon: PawPrint },
  { key: 'room', label: 'Кімнати', Icon: Home },
  { key: 'subject_badge', label: 'Значки', Icon: Medal },
  { key: 'block_world', label: 'Блоки/Інструменти', Icon: Package },
  { key: 'mystery_box', label: 'Коробки', Icon: Gift },
]

onMounted(async () => {
  loading.value = true
  try {
    const [studs, cls, its] = await Promise.all([
      getAllStudents(),
      getAllClasses(),
      getActiveItems(),
    ])
    students.value = studs
    classes.value = cls
    items.value = its
  } catch (e) {
    error(e.message)
  } finally {
    loading.value = false
  }
})

const classNameById = computed(() => {
  const map = new Map()
  for (const c of classes.value) map.set(c.id, c.name)
  return map
})

/**
 * Visible students after class + text search filters.
 * NOT capped — "Select all" should affect everything the admin can actually see.
 */
const filteredStudents = computed(() => {
  const q = studentSearch.value.trim().toLowerCase()
  let list = students.value
  if (classFilter.value !== 'all') {
    list = list.filter((s) => s.classId === classFilter.value)
  }
  if (q) {
    list = list.filter((s) => {
      const name = String(s.displayName || '').toLowerCase()
      const code = String(s.accessCode || '').toLowerCase()
      return name.includes(q) || code.includes(q)
    })
  }
  return list
})

const filteredItems = computed(() => {
  const q = itemSearch.value.trim().toLowerCase()
  let list = items.value
  if (categoryFilter.value !== 'all') {
    list = list.filter((i) => i.category === categoryFilter.value)
  }
  if (q) {
    list = list.filter((i) => String(i.name || '').toLowerCase().includes(q))
  }
  return list.slice(0, 120)
})

const selectedItem = computed(() => items.value.find((i) => i.id === selectedItemId.value) || null)

const selectedCount = computed(() => selectedStudentIds.value.size)

/** True only if every currently-visible student is selected. Used for the master checkbox. */
const allVisibleSelected = computed(() => {
  const visible = filteredStudents.value
  if (visible.length === 0) return false
  const set = selectedStudentIds.value
  for (const s of visible) if (!set.has(s.id)) return false
  return true
})

function isSelected(id) {
  return selectedStudentIds.value.has(id)
}

/** Replace-on-write pattern so `ref<Set>` triggers reactivity on toggle. */
function toggleStudent(id) {
  const next = new Set(selectedStudentIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selectedStudentIds.value = next
}

/** Union/subtract all currently-visible rows from the selection. */
function toggleAllVisible() {
  const visible = filteredStudents.value
  const next = new Set(selectedStudentIds.value)
  const allIn = visible.every((s) => next.has(s.id))
  if (allIn) {
    for (const s of visible) next.delete(s.id)
  } else {
    for (const s of visible) next.add(s.id)
  }
  selectedStudentIds.value = next
}

function clearSelection() {
  selectedStudentIds.value = new Set()
}

async function doGrant() {
  if (selectedStudentIds.value.size === 0) {
    error('Оберіть щонайменше одного учня')
    return
  }
  if (!selectedItemId.value) {
    error('Оберіть предмет')
    return
  }
  const amount = Math.max(1, Math.min(50, Math.floor(Number(qty.value) || 1)))
  const recipientIds = Array.from(selectedStudentIds.value)
  granting.value = true
  let successCount = 0
  const failures = []
  let itemName = ''
  try {
    /**
     * Sequential loop keeps per-student errors isolated and logs one `admin_grant`
     * transaction per recipient. Fine for class-sized batches (~30); swap to
     * `Promise.all` with chunking if we ever need to grant to hundreds at once.
     */
    for (const uid of recipientIds) {
      try {
        const meta = await adminGrantItemToStudent({
          adminUid: auth.profile.id,
          studentUid: uid,
          itemId: selectedItemId.value,
          qty: amount,
        })
        itemName = meta.name || itemName
        successCount++
      } catch (e) {
        const who = students.value.find((s) => s.id === uid)?.displayName || uid
        failures.push(`${who}: ${e?.message || 'помилка'}`)
      }
    }
  } finally {
    granting.value = false
  }

  if (successCount > 0) {
    success(
      `${itemName || 'Предмет'} ×${amount} → ${successCount} учн${successCount === 1 ? 'ю' : 'ям'}` +
        (failures.length ? ` (помилок: ${failures.length})` : ''),
    )
  }
  if (failures.length > 0) {
    error(failures.slice(0, 3).join('; ') + (failures.length > 3 ? ` …(+${failures.length - 3})` : ''))
  }
  if (successCount > 0 && failures.length === 0) qty.value = 1
}
</script>

<template>
  <div class="flex flex-col gap-6 pb-10">
    <!-- Header -->
    <div>
      <div class="flex items-center gap-2.5 mb-1">
        <Gift :size="22" :stroke-width="2" class="text-amber-400" />
        <h1 class="text-2xl font-extrabold gradient-heading">Видати предмет</h1>
      </div>
      <p class="text-slate-500 text-sm">
        Надайте будь-який товар із магазину одному або кільком учням одразу. Підтримує магічні
        коробки та багатоштучні стеки. Кожна дія логується як
        <span class="text-slate-300 font-mono">admin_grant</span>.
      </p>
    </div>

    <div v-if="loading" class="text-center py-16 text-slate-600 text-sm">Завантаження...</div>

    <div v-else class="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <!-- Student picker -->
      <AppCard>
        <div class="flex flex-col gap-3">
          <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-2 font-extrabold text-sm text-slate-200">
              <Users :size="14" :stroke-width="2" /> Учні
              <span
                v-if="selectedCount > 0"
                class="text-[10px] font-bold bg-amber-500/15 text-amber-300 px-1.5 py-0.5 rounded-full"
              >
                обрано: {{ selectedCount }}
              </span>
            </div>
            <button
              v-if="selectedCount > 0"
              type="button"
              class="text-[11px] font-bold text-slate-500 hover:text-slate-300"
              @click="clearSelection"
            >Очистити</button>
          </div>

          <div class="flex gap-2">
            <select
              v-model="classFilter"
              class="px-2.5 py-2 text-xs rounded-xl bg-white/[0.05] text-slate-200 outline-none focus:bg-white/[0.08]"
            >
              <option value="all">Усі класи</option>
              <option v-for="c in classes" :key="c.id" :value="c.id">{{ c.name }}</option>
            </select>
            <input
              v-model="studentSearch"
              placeholder="Пошук за прізвищем / кодом..."
              class="flex-1 px-3 py-2 text-sm rounded-xl bg-white/[0.05] text-slate-200 placeholder-slate-600 outline-none focus:bg-white/[0.08]"
            />
          </div>

          <!-- Master "select all visible" row -->
          <button
            type="button"
            class="flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-bold transition-colors"
            :class="allVisibleSelected ? 'bg-amber-500/10 text-amber-300' : 'bg-white/[0.04] text-slate-400 hover:text-slate-200'"
            :disabled="filteredStudents.length === 0"
            @click="toggleAllVisible"
          >
            <component :is="allVisibleSelected ? CheckSquare : Square" :size="14" :stroke-width="2" />
            {{ allVisibleSelected ? 'Зняти виділення' : `Вибрати всіх (${filteredStudents.length})` }}
          </button>

          <div class="flex flex-col gap-1 overflow-y-auto" style="max-height: 320px">
            <button
              v-for="s in filteredStudents"
              :key="s.id"
              type="button"
              class="flex items-center gap-2 text-left px-3 py-2 rounded-xl text-xs font-bold transition-colors"
              :class="isSelected(s.id) ? 'bg-amber-500/15 text-amber-300' : 'text-slate-400 hover:bg-white/[0.05] hover:text-slate-200'"
              @click="toggleStudent(s.id)"
            >
              <component :is="isSelected(s.id) ? CheckSquare : Square" :size="13" :stroke-width="2" class="shrink-0" />
              <div class="flex-1 min-w-0">
                <div class="truncate">{{ s.displayName || s.id }}</div>
                <div class="text-[10px] text-slate-500 font-normal mt-0.5">
                  {{ classNameById.get(s.classId) || '—' }} · код {{ s.accessCode || '—' }}
                </div>
              </div>
            </button>
            <div v-if="filteredStudents.length === 0" class="text-slate-600 text-xs text-center py-6">
              Нічого не знайдено
            </div>
          </div>
        </div>
      </AppCard>

      <!-- Item picker -->
      <AppCard>
        <div class="flex flex-col gap-3">
          <div class="flex items-center gap-2 font-extrabold text-sm text-slate-200">
            <Package :size="14" :stroke-width="2" /> Предмет
          </div>
          <div class="flex gap-2 flex-wrap">
            <button
              v-for="cat in CATEGORIES"
              :key="cat.key"
              type="button"
              class="px-2.5 py-1 rounded-lg text-[11px] font-bold flex items-center gap-1 transition-colors"
              :class="categoryFilter === cat.key ? 'bg-violet-500/15 text-violet-300' : 'bg-white/[0.04] text-slate-500 hover:text-slate-300'"
              @click="categoryFilter = cat.key"
            >
              <component :is="cat.Icon" :size="12" :stroke-width="2" />
              {{ cat.label }}
            </button>
          </div>
          <input
            v-model="itemSearch"
            placeholder="Пошук за назвою..."
            class="w-full px-3 py-2 text-sm rounded-xl bg-white/[0.05] text-slate-200 placeholder-slate-600 outline-none focus:bg-white/[0.08]"
          />
          <div class="flex flex-col gap-1 overflow-y-auto" style="max-height: 320px">
            <button
              v-for="it in filteredItems"
              :key="it.id"
              type="button"
              class="flex items-center justify-between gap-2 text-left px-3 py-2 rounded-xl text-xs font-bold transition-colors"
              :class="selectedItemId === it.id ? 'bg-amber-500/15 text-amber-300' : 'text-slate-400 hover:bg-white/[0.05] hover:text-slate-200'"
              @click="selectedItemId = it.id"
            >
              <span class="truncate">{{ it.name }}</span>
              <span class="text-[10px] text-slate-500 font-normal shrink-0">{{ it.category }}</span>
            </button>
            <div v-if="filteredItems.length === 0" class="text-slate-600 text-xs text-center py-6">
              Нічого не знайдено
            </div>
          </div>
        </div>
      </AppCard>
    </div>

    <!-- Action bar -->
    <AppCard v-if="!loading">
      <div class="flex flex-col sm:flex-row sm:items-center gap-4">
        <div class="flex-1 min-w-0">
          <div class="text-xs text-slate-500">Надати</div>
          <div class="font-extrabold text-sm text-slate-200 truncate">
            <span v-if="selectedItem">{{ selectedItem.name }}</span>
            <span v-else class="text-slate-600">Виберіть предмет →</span>
          </div>
          <div class="text-xs text-slate-500 mt-0.5">
            <span v-if="selectedCount > 0">кому: {{ selectedCount }} учн{{ selectedCount === 1 ? 'ю' : selectedCount < 5 ? 'ям' : 'ям' }}</span>
            <span v-else class="text-slate-600">Виберіть учнів →</span>
          </div>
        </div>
        <div class="flex items-center gap-2">
          <label class="text-xs font-bold text-slate-500">К-сть</label>
          <input
            v-model.number="qty"
            type="number"
            min="1"
            max="50"
            class="w-20 px-3 py-2 text-sm rounded-xl bg-white/[0.05] text-slate-200 outline-none focus:bg-white/[0.08]"
          />
          <AppButton
            variant="primary"
            size="md"
            :loading="granting"
            :disabled="selectedCount === 0 || !selectedItemId"
            @click="doGrant"
          >
            <Gift :size="14" :stroke-width="2" /> Видати
          </AppButton>
        </div>
      </div>
    </AppCard>
  </div>
</template>
