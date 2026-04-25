<script setup>
import { ref, computed, onMounted } from 'vue'
import {
  getAllUsers, adminSetUserCoins, adminSetUserXp, adminSetUserField, adminClearUserInventoryAndCosmetics,
  adminFlushTransactions, adminFlushQuestCompletions, adminFlushQuests,
  adminFlushTrades, adminResetStudentStats,
} from '@/firebase/collections'
import AppButton from '@/components/ui/AppButton.vue'
import AppInput from '@/components/ui/AppInput.vue'
import AppModal from '@/components/ui/AppModal.vue'
import {
  Terminal, Search, Coins, Zap, Users, Trash2, RotateCcw,
  TriangleAlert, CheckCircle2, ChevronDown, ChevronUp, Loader2,
  GraduationCap,
} from 'lucide-vue-next'
import { useToast } from '@/composables/useToast'
import { useAuthStore } from '@/stores/auth'
import { clearLabySharedWorldMobsRtdb } from '@/firebase/labyMobsRtdb'
import { seedSchoolRoster, ROSTER_TEACHERS, ROSTER_STUDENTS } from '@/firebase/schoolRosterSeed'

const { success, error, warning } = useToast()
const authStore = useAuthStore()

const users    = ref([])
const loading  = ref(true)
const search   = ref('')
const filterRole = ref('all')

const selectedUser  = ref(null)
const editCoins     = ref(0)
const editXp        = ref(0)
const saving        = ref(false)

const confirmModal  = ref(false)
const confirmAction = ref(null) // { label, fn }
const running       = ref(false)
const runLog        = ref([])

const showSeedModal = ref(false)
const seedingRoster = ref(false)

onMounted(async () => {
  loading.value = true
  users.value = await getAllUsers()
  loading.value = false
})

const filteredUsers = computed(() => {
  let list = users.value
  if (filterRole.value !== 'all') list = list.filter(u => u.role === filterRole.value)
  const q = search.value.trim().toLowerCase()
  if (q) list = list.filter(u => u.displayName?.toLowerCase().includes(q) || u.email?.toLowerCase().includes(q))
  return list
})

function selectUser(u) {
  selectedUser.value = u
  editCoins.value    = u.coins   ?? 0
  editXp.value       = u.xp     ?? 0
}

async function saveBalance() {
  if (!selectedUser.value) return
  saving.value = true
  try {
    await adminSetUserCoins(selectedUser.value.id, editCoins.value)
    await adminSetUserXp(selectedUser.value.id,   editXp.value)
    // Update local copy
    const idx = users.value.findIndex(u => u.id === selectedUser.value.id)
    if (idx !== -1) {
      users.value[idx].coins = editCoins.value
      users.value[idx].xp    = editXp.value
      selectedUser.value = { ...users.value[idx] }
    }
    success(`Баланс ${selectedUser.value.displayName} оновлено`)
  } catch (e) { error(e.message) }
  saving.value = false
}

async function clearInventory() {
  if (!selectedUser.value) return
  saving.value = true
  try {
    await adminClearUserInventoryAndCosmetics(selectedUser.value.id)
    const idx = users.value.findIndex(u => u.id === selectedUser.value.id)
    if (idx !== -1) {
      users.value[idx].inventory = []
      users.value[idx].inventoryCounts = {}
      users.value[idx].mysteryBoxCounts = {}
      users.value[idx].avatar = {
        ...(users.value[idx].avatar || {}),
        skinId: 'default',
        skinUrl: null,
        accessories: [],
        roomId: null,
        petId: null,
      }
      selectedUser.value = { ...users.value[idx] }
    }
    success('Інвентар і косметика скинуті до стандарту')
  } catch (e) { error(e.message) }
  saving.value = false
}

function askConfirm(label, fn) {
  confirmAction.value = { label, fn }
  confirmModal.value  = true
}

async function runConfirmed() {
  confirmModal.value = false
  running.value      = true
  runLog.value       = []
  try {
    const count = await confirmAction.value.fn()
    runLog.value.push({ ok: true, msg: `${confirmAction.value.label}: виконано (${count ?? '?'} записів)` })
    success('Готово!')
  } catch (e) {
    runLog.value.push({ ok: false, msg: e.message })
    error(e.message)
  }
  running.value = false
}

async function runSeedRoster() {
  if (!authStore.currentCode || !authStore.user?.email) {
    error('Увійдіть знову з кодом доступу (потрібно для відновлення сесії після створення акаунтів).')
    return
  }
  seedingRoster.value = true
  try {
    const r = await seedSchoolRoster({
      adminEmail: authStore.user.email,
      adminCode: authStore.currentCode,
    })
    showSeedModal.value = false
    success(
      `Вчителів: створено ${r.teachersCreated}, пропущено ${r.teachersSkipped} · Учнів: створено ${r.studentsCreated}, пропущено ${r.studentsSkipped}`,
    )
    if (r.warnings.length) {
      warning(
        r.warnings.slice(0, 6).join(' · ') + (r.warnings.length > 6 ? ` … (+${r.warnings.length - 6})` : ''),
        9000,
      )
    }
    if (r.errors.length) error(r.errors.slice(0, 5).join(' · ') + (r.errors.length > 5 ? ' …' : ''))
    users.value = await getAllUsers()
  } catch (e) {
    error(e.message)
  } finally {
    seedingRoster.value = false
  }
}

const FLUSH_OPS = [
  {
    label:   'Видалити всі транзакції',
    desc:    'Очищає журнал активності для всіх користувачів',
    danger:  false,
    fn:      () => adminFlushTransactions(),
  },
  {
    label:   'Видалити всі заявки на завдання',
    desc:    'Видаляє всі поданні та затвердженні виконання квестів',
    danger:  false,
    fn:      () => adminFlushQuestCompletions(),
  },
  {
    label:   'Видалити всі завдання вчителів',
    desc:    'Видаляє квести, створені вчителями',
    danger:  false,
    fn:      () => adminFlushQuests(),
  },
  {
    label:   'Видалити всі обміни',
    desc:    'Очищає всі активні та завершені торгові пропозиції',
    danger:  false,
    fn:      () => adminFlushTrades(),
  },
  {
    label:   'Скинути статистику ВСІХ учнів',
    desc:    'Обнуляє монети, XP, рівень, серію, інвентар та бейджі',
    danger:  true,
    fn:      () => adminResetStudentStats(),
  },
  {
    label:   'RTDB: очистити всіх мобів у спільному Лабі',
    desc:    'Видаляє усі worldMobs/…/instances і worldMobPlayerHits (застарілі тестові моби).',
    danger:  true,
    fn:      async () => {
      await clearLabySharedWorldMobsRtdb()
    },
  },
]

const ROLE_LABELS = { student: 'Учень', teacher: 'Вчитель', admin: 'Адмін' }
const ROLE_COLORS = { student: 'text-blue-400', teacher: 'text-emerald-400', admin: 'text-amber-400' }
</script>

<template>
  <div class="flex flex-col gap-6 pb-10">

    <!-- Header -->
    <div>
      <div class="flex items-center gap-2.5 mb-1">
        <Terminal :size="22" :stroke-width="2" class="text-amber-400" />
        <h1 class="text-2xl font-extrabold gradient-heading">Інструменти</h1>
      </div>
      <p class="text-slate-500 text-sm">Пряме управління базою даних без Firebase Console</p>
    </div>

    <!-- ── User Balance Editor ────────────────────────────────────────────── -->
    <div class="glass-card p-5 flex flex-col gap-4">
      <div class="flex items-center gap-2 font-extrabold text-sm text-slate-300">
        <Users :size="16" :stroke-width="2" class="text-amber-400" />
        Редактор балансу користувача
      </div>

      <!-- Search + filter -->
      <div class="flex gap-2">
        <div class="relative flex-1">
          <Search :size="14" class="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            v-model="search"
            placeholder="Пошук..."
            class="w-full pl-8 pr-3 py-2 text-sm rounded-xl bg-white/[0.05] text-slate-200 placeholder-slate-600 outline-none focus:bg-white/[0.08] transition-colors"
          />
        </div>
        <select
          v-model="filterRole"
          class="px-3 py-2 text-sm rounded-xl bg-white/[0.05] text-slate-300 outline-none"
        >
          <option value="all">Всі ролі</option>
          <option value="student">Учні</option>
          <option value="teacher">Вчителі</option>
          <option value="admin">Адміни</option>
        </select>
      </div>

      <div class="flex gap-4 min-h-[260px]">
        <!-- User list -->
        <div class="w-44 flex-shrink-0 flex flex-col gap-1 overflow-y-auto" style="max-height:320px">
          <div v-if="loading" class="text-slate-600 text-xs text-center py-6">Завантаження...</div>
          <button
            v-for="u in filteredUsers"
            :key="u.id"
            class="text-left px-3 py-2 rounded-xl text-xs font-bold transition-all"
            :class="selectedUser?.id === u.id
              ? 'bg-amber-500/15 text-amber-300'
              : 'text-slate-400 hover:bg-white/[0.05] hover:text-slate-200'"
            @click="selectUser(u)"
          >
            <div class="truncate">{{ u.displayName || u.email || u.id }}</div>
            <div class="text-[10px] font-normal mt-0.5" :class="ROLE_COLORS[u.role]">
              {{ ROLE_LABELS[u.role] || u.role }}
            </div>
          </button>
          <div v-if="!loading && filteredUsers.length === 0" class="text-slate-600 text-xs text-center py-6">Нічого не знайдено</div>
        </div>

        <!-- Edit panel -->
        <div class="flex-1 flex flex-col gap-3">
          <div v-if="!selectedUser" class="flex items-center justify-center h-full text-slate-600 text-sm">
            Оберіть користувача зліва
          </div>
          <template v-else>
            <div class="font-extrabold text-sm text-slate-200">{{ selectedUser.displayName }}</div>
            <div class="text-xs text-slate-500 -mt-2">{{ selectedUser.email }}</div>

            <!-- Coins -->
            <div>
              <label class="text-xs font-bold text-slate-500 mb-1 flex items-center gap-1">
                <Coins :size="11" :stroke-width="2" class="text-coin" /> Монети
              </label>
              <input
                v-model.number="editCoins"
                type="number" min="0"
                class="w-full px-3 py-2 text-sm rounded-xl bg-white/[0.05] text-slate-200 outline-none focus:bg-white/[0.08]"
              />
              <div class="text-[10px] text-slate-600 mt-1">Поточно: {{ selectedUser.coins ?? 0 }}</div>
            </div>

            <!-- XP -->
            <div>
              <label class="text-xs font-bold text-slate-500 mb-1 flex items-center gap-1">
                <Zap :size="11" :stroke-width="2" class="text-xp" /> XP (рівень перерахується автоматично)
              </label>
              <input
                v-model.number="editXp"
                type="number" min="0"
                class="w-full px-3 py-2 text-sm rounded-xl bg-white/[0.05] text-slate-200 outline-none focus:bg-white/[0.08]"
              />
              <div class="text-[10px] text-slate-600 mt-1">Поточно: {{ selectedUser.xp ?? 0 }} XP · Lv.{{ selectedUser.level ?? 1 }}</div>
            </div>

            <!-- Actions -->
            <div class="flex gap-2 mt-1">
              <AppButton variant="primary" size="sm" :loading="saving" @click="saveBalance">
                Зберегти
              </AppButton>
              <AppButton variant="danger" size="sm" :loading="saving" @click="clearInventory">
                Очистити інвентар
              </AppButton>
            </div>

            <!-- Current stats read-only -->
            <div class="grid grid-cols-3 gap-2 mt-auto">
              <div class="rounded-xl p-2 text-center" style="background:rgba(255,255,255,0.04)">
                <div class="text-[10px] text-slate-500">Монети</div>
                <div class="font-extrabold text-sm text-coin">{{ selectedUser.coins ?? 0 }}</div>
              </div>
              <div class="rounded-xl p-2 text-center" style="background:rgba(255,255,255,0.04)">
                <div class="text-[10px] text-slate-500">XP</div>
                <div class="font-extrabold text-sm text-xp">{{ selectedUser.xp ?? 0 }}</div>
              </div>
              <div class="rounded-xl p-2 text-center" style="background:rgba(255,255,255,0.04)">
                <div class="text-[10px] text-slate-500">Рівень</div>
                <div class="font-extrabold text-sm text-amber-400">{{ selectedUser.level ?? 1 }}</div>
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>

    <!-- ── School roster import ─────────────────────────────────────────────── -->
    <div class="glass-card p-5 flex flex-col gap-4">
      <div class="flex items-center gap-2 font-extrabold text-sm text-slate-300">
        <GraduationCap :size="16" :stroke-width="2" class="text-emerald-400" />
        Склад школи
      </div>
      <p class="text-xs text-slate-500 leading-relaxed">
        Створює в Firebase Auth і Firestore {{ ROSTER_TEACHERS.length }} вчителів та {{ ROSTER_STUDENTS.length }} учнів за фіксованим списком.
        Записи з таким самим ім’ям уже в базі пропускаються. Класи мають існувати (назва з цифри на початку, напр. «1-А») — інакше учень буде без класу.
      </p>
      <AppButton variant="primary" size="sm" class="w-fit" @click="showSeedModal = true">
        Імпортувати повний список
      </AppButton>
    </div>

    <!-- ── Bulk / Flush Operations ────────────────────────────────────────── -->
    <div class="glass-card p-5 flex flex-col gap-4">
      <div class="flex items-center gap-2 font-extrabold text-sm text-slate-300">
        <Trash2 :size="16" :stroke-width="2" class="text-red-400" />
        Масові операції
      </div>
      <p class="text-xs text-slate-500">Незворотні дії. Переконайся перед виконанням.</p>

      <div class="flex flex-col gap-2">
        <div
          v-for="op in FLUSH_OPS"
          :key="op.label"
          class="flex items-center justify-between gap-4 rounded-xl px-4 py-3"
          :class="op.danger ? 'bg-red-500/[0.07] border border-red-500/20' : 'bg-white/[0.04]'"
        >
          <div>
            <div class="font-bold text-sm" :class="op.danger ? 'text-red-400' : 'text-slate-300'">
              {{ op.label }}
            </div>
            <div class="text-xs text-slate-600 mt-0.5">{{ op.desc }}</div>
          </div>
          <AppButton
            :variant="op.danger ? 'danger' : 'secondary'"
            size="sm"
            class="flex-shrink-0"
            @click="askConfirm(op.label, op.fn)"
          >
            <Trash2 :size="12" /> Виконати
          </AppButton>
        </div>
      </div>

      <!-- Log -->
      <div v-if="runLog.length" class="flex flex-col gap-1">
        <div
          v-for="(entry, i) in runLog"
          :key="i"
          class="flex items-center gap-2 text-xs px-3 py-2 rounded-xl"
          :class="entry.ok ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'"
        >
          <CheckCircle2 v-if="entry.ok" :size="12" :stroke-width="2.5" />
          <TriangleAlert v-else :size="12" :stroke-width="2.5" />
          {{ entry.msg }}
        </div>
      </div>

      <div v-if="running" class="flex items-center gap-2 text-xs text-slate-500">
        <Loader2 :size="14" class="animate-spin" /> Виконання...
      </div>
    </div>

    <!-- Seed roster modal -->
    <AppModal v-model="showSeedModal" title="Імпорт складу школи" size="lg">
      <div class="flex flex-col gap-4 px-1 pb-1">
        <p class="text-sm text-slate-400">
          Буде виконано серію реєстрацій у Firebase. Після кожного акаунта адмінський сеанс відновлюється автоматично.
          Переконайся, що предмети та класи вже є в системі (наприклад, через «Seed data»).
        </p>
        <div class="flex gap-2">
          <AppButton variant="ghost" block :disabled="seedingRoster" @click="showSeedModal = false">
            Скасувати
          </AppButton>
          <AppButton variant="primary" block :loading="seedingRoster" @click="runSeedRoster">
            Створити всіх
          </AppButton>
        </div>
      </div>
    </AppModal>

    <!-- Confirm modal -->
    <AppModal v-model="confirmModal" title="Підтвердження">
      <div class="flex flex-col gap-4">
        <div class="flex items-start gap-3 p-4 rounded-2xl bg-red-500/[0.08]">
          <TriangleAlert :size="20" :stroke-width="2" class="text-red-400 flex-shrink-0 mt-0.5" />
          <div>
            <div class="font-extrabold text-sm text-red-400">Незворотна дія!</div>
            <div class="text-sm text-slate-300 mt-1">{{ confirmAction?.label }}</div>
            <div class="text-xs text-slate-500 mt-1">Ці дані неможливо відновити. Продовжити?</div>
          </div>
        </div>
        <div class="flex gap-2">
          <AppButton variant="ghost" block @click="confirmModal = false">Скасувати</AppButton>
          <AppButton variant="danger" block @click="runConfirmed">Так, виконати</AppButton>
        </div>
      </div>
    </AppModal>
  </div>
</template>
