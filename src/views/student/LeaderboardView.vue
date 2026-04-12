<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useUserStore } from '@/stores/user'
import { getLeaderboard } from '@/firebase/collections'
import { useToast } from '@/composables/useToast'
import AvatarDisplay from '@/components/avatar/AvatarDisplay.vue'
import CoinDisplay from '@/components/gamification/CoinDisplay.vue'
import {
  Trophy, Crown, Flame, Zap, LayoutDashboard, Star,
} from 'lucide-vue-next'

const auth      = useAuthStore()
const userStore = useUserStore()
const router    = useRouter()
const { error: toastError } = useToast()

const scope    = ref('global')   // global | class — за замовчуванням уся школа
const sortBy   = ref('xp')   // xp | coins | streak
const students = ref([])
const leaderboardLoading = ref(true)

onMounted(async () => {
  await userStore.fetchItems()
  await fetchLeaderboard()
})

async function fetchLeaderboard() {
  leaderboardLoading.value = true
  try {
    const classId = scope.value === 'class' ? auth.profile?.classId : null
    students.value = await getLeaderboard(classId, 50, sortBy.value)
  } catch (e) {
    console.warn('[Leaderboard]', e?.code, e?.message)
    students.value = []
    const m = String(e?.message || '')
    const indexBuilding = e?.code === 'failed-precondition' || m.includes('index')
    toastError(
      indexBuilding
        ? 'Індекс у базі ще будується. Зачекайте хвилину й оновіть сторінку або спробуйте знову.'
        : 'Не вдалося завантажити рейтинг.',
    )
  } finally {
    leaderboardLoading.value = false
  }
}

watch(scope, () => { void fetchLeaderboard() })
watch(sortBy, () => { void fetchLeaderboard() })

const myRank = computed(() => {
  const idx = students.value.findIndex(s => s.id === auth.profile?.id)
  return idx >= 0 ? idx + 1 : null
})

const podium = computed(() => students.value.slice(0, 3))
const rest   = computed(() => students.value.slice(3))

const SORT_OPTS = [
  { key: 'xp',     label: 'Досвід' },
  { key: 'coins',  label: 'Монети' },
  { key: 'streak', label: 'Серія'  },
]
</script>

<template>
  <div class="flex flex-col gap-4 animate-fade-in">

    <!-- Header -->
    <div>
      <div class="flex items-center gap-2.5 mb-0.5">
        <Trophy :size="22" :stroke-width="2" class="text-amber-400" />
        <h1 class="text-2xl font-extrabold gradient-heading">Рейтинг</h1>
      </div>
      <div v-if="myRank" class="text-slate-500 text-sm">
        Ваше місце: <span class="text-violet-300 font-bold">#{{ myRank }}</span>
      </div>
    </div>

    <!-- Scope + Sort -->
    <div class="flex gap-2">
      <!-- Scope pills -->
      <div class="flex p-1 rounded-2xl flex-1" style="background:rgba(255,255,255,0.04)">
        <button
          v-for="s in [{ key: 'global', label: 'Школа' }, { key: 'class', label: 'Мій клас' }]"
          :key="s.key"
          class="flex-1 py-1.5 rounded-xl text-sm font-bold transition-all duration-200"
          :class="scope === s.key ? 'tab-active' : 'text-slate-500 hover:text-slate-300'"
          @click="scope = s.key"
        >{{ s.label }}</button>
      </div>

      <!-- Sort pills -->
      <div class="flex gap-1 p-1 rounded-2xl" style="background:rgba(255,255,255,0.04)">
        <button
          v-for="opt in SORT_OPTS"
          :key="opt.key"
          class="px-2.5 py-1.5 rounded-xl text-xs font-bold transition-all duration-200"
          :class="sortBy === opt.key ? 'tab-active' : 'text-slate-500 hover:text-slate-300'"
          @click="sortBy = opt.key"
        >{{ opt.label }}</button>
      </div>
    </div>

    <!-- Podium: skeleton під час завантаження — без стрибка висоти -->
    <div
      v-if="leaderboardLoading"
      class="flex items-end justify-center gap-3 mb-2 mt-2 min-h-[220px]"
      aria-hidden="true"
    >
      <div class="flex flex-col items-center gap-2 w-[5.5rem]">
        <div class="h-16 w-16 rounded-full bg-white/[0.06] animate-pulse" />
        <div class="w-20 h-16 rounded-2xl bg-white/[0.06] animate-pulse" />
      </div>
      <div class="flex flex-col items-center gap-2 w-[6.5rem]">
        <div class="h-6 w-6 rounded-full bg-white/[0.06] animate-pulse" />
        <div class="h-[4.5rem] w-[4.5rem] rounded-full bg-white/[0.06] animate-pulse" />
        <div class="w-24 h-20 rounded-2xl bg-white/[0.08] animate-pulse" />
      </div>
      <div class="flex flex-col items-center gap-2 w-[5.5rem]">
        <div class="h-16 w-16 rounded-full bg-white/[0.06] animate-pulse" />
        <div class="w-20 h-14 rounded-2xl bg-white/[0.06] animate-pulse" />
      </div>
    </div>

    <!-- Podium top 3 -->
    <div v-else-if="podium.length >= 3" class="flex items-end justify-center gap-3 mb-2 mt-2 pt-1">
      <!-- 2nd -->
      <div class="flex flex-col items-center gap-2">
        <div class="cursor-pointer" @click="router.push(podium[1]?.id === auth.profile?.id ? '/student/room' : `/student/room/${podium[1]?.id}`)">
          <AvatarDisplay :avatar="podium[1]?.avatar" :display-name="podium[1]?.displayName || ''" :items="userStore.items" size="md" :show-name="true" />
        </div>
        <div class="podium-block w-20 h-16 rounded-2xl flex flex-col items-center justify-center" style="background:linear-gradient(155deg,rgba(148,163,184,0.15),rgba(148,163,184,0.05));box-shadow:inset 0 0 0 1px rgba(148,163,184,0.2)">
          <div class="text-xl font-extrabold text-slate-300">2</div>
          <CoinDisplay v-if="sortBy === 'coins'" :amount="podium[1]?.coins || 0" size="sm" />
          <div v-else-if="sortBy === 'xp'" class="flex items-center gap-0.5 text-emerald-400 font-extrabold text-sm">
            <Zap :size="13" :stroke-width="2.5" /><span class="tabular-nums">{{ podium[1]?.xp || 0 }}</span>
          </div>
          <div v-else class="flex items-center gap-0.5 text-orange-400 font-extrabold text-sm">
            <Flame :size="13" :stroke-width="2.5" /><span class="tabular-nums">{{ podium[1]?.streak || 0 }}</span>
          </div>
        </div>
      </div>

      <!-- 1st -->
      <div class="flex flex-col items-center gap-2">
        <Crown :size="22" :stroke-width="1.8" class="text-amber-400 animate-float" />
        <div class="cursor-pointer" @click="router.push(podium[0]?.id === auth.profile?.id ? '/student/room' : `/student/room/${podium[0]?.id}`)">
          <AvatarDisplay :avatar="podium[0]?.avatar" :display-name="podium[0]?.displayName || ''" :items="userStore.items" size="lg" :show-name="true" />
        </div>
        <div class="w-24 h-20 rounded-2xl flex flex-col items-center justify-center glow-legendary" style="background:linear-gradient(155deg,rgba(251,191,36,0.2),rgba(251,191,36,0.05))">
          <div class="text-2xl font-extrabold gradient-gold">1</div>
          <CoinDisplay v-if="sortBy === 'coins'" :amount="podium[0]?.coins || 0" size="sm" />
          <div v-else-if="sortBy === 'xp'" class="flex items-center gap-0.5 text-emerald-400 font-extrabold text-base">
            <Zap :size="15" :stroke-width="2.5" /><span class="tabular-nums">{{ podium[0]?.xp || 0 }}</span>
          </div>
          <div v-else class="flex items-center gap-0.5 text-orange-400 font-extrabold text-base">
            <Flame :size="15" :stroke-width="2.5" /><span class="tabular-nums">{{ podium[0]?.streak || 0 }}</span>
          </div>
        </div>
      </div>

      <!-- 3rd -->
      <div class="flex flex-col items-center gap-2">
        <div class="cursor-pointer" @click="router.push(podium[2]?.id === auth.profile?.id ? '/student/room' : `/student/room/${podium[2]?.id}`)">
          <AvatarDisplay :avatar="podium[2]?.avatar" :display-name="podium[2]?.displayName || ''" :items="userStore.items" size="md" :show-name="true" />
        </div>
        <div class="w-20 h-14 rounded-2xl flex flex-col items-center justify-center" style="background:linear-gradient(155deg,rgba(180,83,9,0.15),rgba(180,83,9,0.05));box-shadow:inset 0 0 0 1px rgba(180,83,9,0.2)">
          <div class="text-lg font-extrabold text-amber-700">3</div>
          <CoinDisplay v-if="sortBy === 'coins'" :amount="podium[2]?.coins || 0" size="sm" />
          <div v-else-if="sortBy === 'xp'" class="flex items-center gap-0.5 text-emerald-400 font-extrabold text-sm">
            <Zap :size="13" :stroke-width="2.5" /><span class="tabular-nums">{{ podium[2]?.xp || 0 }}</span>
          </div>
          <div v-else class="flex items-center gap-0.5 text-orange-400 font-extrabold text-sm">
            <Flame :size="13" :stroke-width="2.5" /><span class="tabular-nums">{{ podium[2]?.streak || 0 }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Rest of list -->
    <div class="flex flex-col gap-2">
      <div
        v-for="(s, i) in (podium.length >= 3 ? rest : students)"
        :key="s.id"
        class="glass-card flex items-center gap-3 p-3 transition-all cursor-pointer"
        :class="s.id === auth.profile?.id ? 'glow-primary' : 'hover:glow-primary'"
        @click="router.push(s.id === auth.profile?.id ? '/student/room' : `/student/room/${s.id}`)"
      >
        <!-- Rank -->
        <div class="w-7 text-center font-extrabold text-sm flex-shrink-0 text-slate-500 tabular-nums">
          {{ podium.length >= 3 ? i + 4 : i + 1 }}
        </div>

        <AvatarDisplay :avatar="s.avatar" :display-name="s.displayName" :items="userStore.items" size="sm" />

        <!-- Info -->
        <div class="flex-1 min-w-0">
          <div class="font-bold text-sm truncate">
            {{ s.displayName }}
            <span v-if="s.id === auth.profile?.id" class="text-violet-400 text-xs ml-1">(ти)</span>
          </div>
          <div class="flex items-center gap-1.5 text-xs text-slate-500 mt-0.5">
            <span>Рів.{{ s.level }}</span>
            <span class="text-slate-700">·</span>
            <Flame :size="11" :stroke-width="1.8" class="text-orange-400" />
            <span>{{ s.streak }}</span>
          </div>
        </div>

        <!-- Score -->
        <div class="flex flex-col items-end gap-1">
          <CoinDisplay v-if="sortBy === 'coins'" :amount="s.coins || 0" size="sm" />
          <div v-else-if="sortBy === 'xp'" class="flex items-center gap-1 text-emerald-400 font-extrabold text-sm">
            <Zap :size="13" :stroke-width="2.5" />
            <span class="tabular-nums">{{ s.xp || 0 }}</span>
          </div>
          <div v-else class="flex items-center gap-1 text-orange-400 font-extrabold text-sm">
            <Flame :size="13" :stroke-width="2.5" />
            <span class="tabular-nums">{{ s.streak || 0 }}</span>
          </div>

          <button
            class="flex items-center gap-0.5 text-[10px] font-bold text-violet-400/60 hover:text-violet-400 transition-colors"
            @click.stop="router.push(s.id === auth.profile?.id ? '/student/room' : `/student/room/${s.id}`)"
          >
            <LayoutDashboard :size="11" :stroke-width="2" />
            <span>Кімната</span>
          </button>
        </div>
      </div>

      <div v-if="students.length === 0" class="text-center py-16 text-slate-600">
        <Trophy :size="40" :stroke-width="1" class="mx-auto mb-3 opacity-30" />
        <div class="font-bold">Рейтинг порожній</div>
      </div>
    </div>
  </div>
</template>
