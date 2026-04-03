<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useUserStore } from '@/stores/user'
import { getLeaderboard, getClass } from '@/firebase/collections'
import AvatarDisplay from '@/components/avatar/AvatarDisplay.vue'
import CoinDisplay from '@/components/gamification/CoinDisplay.vue'
import AppCard from '@/components/ui/AppCard.vue'
import { Trophy, Crown, Zap, Flame, Inbox, LayoutDashboard } from 'lucide-vue-next'

const auth      = useAuthStore()
const userStore = useUserStore()
const router    = useRouter()

const scope     = ref('class')
const sortBy    = ref('coins')
const students  = ref([])
const classes   = ref([])
const selectedClassId = ref(null)

onMounted(async () => {
  await userStore.fetchItems()

  const ids = auth.profile?.classIds || []
  const all = await Promise.all(ids.map(id => getClass(id)))
  classes.value = all.filter(Boolean)

  if (classes.value.length > 0) {
    selectedClassId.value = classes.value[0].id
  }

  await fetchLeaderboard()
})

async function fetchLeaderboard() {
  const classId = scope.value === 'class' ? selectedClassId.value : null
  students.value = await getLeaderboard(classId, 50)
}

const sorted = computed(() => {
  return [...students.value].sort((a, b) => {
    if (sortBy.value === 'xp')     return (b.xp     || 0) - (a.xp     || 0)
    if (sortBy.value === 'streak') return (b.streak  || 0) - (a.streak  || 0)
    return (b.coins || 0) - (a.coins || 0)
  })
})

const podium = computed(() => sorted.value.slice(0, 3))
const rest   = computed(() => sorted.value.slice(3))

const rankColor = (i) => {
  if (i === 0) return 'text-amber-400'
  if (i === 1) return 'text-slate-300'
  if (i === 2) return 'text-amber-700'
  return 'text-slate-500'
}

watch(scope, fetchLeaderboard)
watch(selectedClassId, () => { if (scope.value === 'class') fetchLeaderboard() })
</script>

<template>
  <div class="flex flex-col gap-4 animate-fade-in">
    <!-- Header -->
    <div>
      <div class="flex items-center gap-2 mb-0.5">
        <Trophy :size="20" :stroke-width="2" class="text-amber-500" />
        <h1 class="text-2xl font-extrabold gradient-heading">Рейтинг учнів</h1>
      </div>
      <p class="text-slate-500 text-sm">Перегляньте успіхи своїх класів</p>
    </div>

    <!-- Scope + class selector -->
    <div class="flex flex-col gap-2">
      <div class="flex p-1 bg-game-card rounded-xl">
        <button
          class="flex-1 py-1.5 rounded-lg text-sm font-bold transition-all"
          :class="scope === 'class' ? 'bg-violet-600 text-white' : 'text-slate-400'"
          @click="scope = 'class'"
        >Мій клас</button>
        <button
          class="flex-1 py-1.5 rounded-lg text-sm font-bold transition-all"
          :class="scope === 'global' ? 'bg-violet-600 text-white' : 'text-slate-400'"
          @click="scope = 'global'"
        >Вся школа</button>
      </div>

      <div class="flex gap-2">
        <select
          v-if="scope === 'class' && classes.length > 1"
          v-model="selectedClassId"
          class="flex-1 bg-game-card border border-game-border rounded-xl px-3 py-2 text-sm font-bold text-white focus:outline-none"
        >
          <option v-for="c in classes" :key="c.id" :value="c.id">{{ c.name }}</option>
        </select>

        <select
          v-model="sortBy"
          class="bg-game-card border border-game-border rounded-xl px-3 py-2 text-sm font-bold text-white focus:outline-none"
          :class="scope === 'class' && classes.length > 1 ? '' : 'flex-1'"
        >
          <option value="coins">Монети</option>
          <option value="xp">Досвід</option>
          <option value="streak">Серія</option>
        </select>
      </div>
    </div>

    <div v-if="students.length === 0" class="text-center py-16 text-slate-600">
      <Inbox :size="48" :stroke-width="1" class="mx-auto mb-3 opacity-30" />
      <div class="font-bold text-slate-500">Учнів не знайдено</div>
    </div>

    <div v-else>
      <!-- Podium top 3 -->
      <div v-if="podium.length >= 3" class="flex items-end justify-center gap-3 mb-6 mt-8 pt-3">
        <!-- 2nd place -->
        <div class="flex flex-col items-center gap-2">
          <div class="cursor-pointer" @click="router.push(`/teacher/room/${podium[1]?.id}`)">
            <AvatarDisplay :avatar="podium[1]?.avatar" :display-name="podium[1]?.displayName || ''" :items="userStore.items" size="md" :show-name="true" />
          </div>
          <div class="bg-gradient-to-b from-slate-400/30 to-slate-600/10 border border-slate-400/30 rounded-xl px-4 py-2 text-center w-20 h-16 flex flex-col items-center justify-center">
            <div class="text-xl font-extrabold text-slate-300">2</div>
            <CoinDisplay :amount="podium[1]?.coins || 0" size="sm" />
          </div>
        </div>
        <!-- 1st place -->
        <div class="flex flex-col items-center gap-2">
          <Crown :size="22" :stroke-width="1.8" class="text-amber-400 animate-float" />
          <div class="cursor-pointer" @click="router.push(`/teacher/room/${podium[0]?.id}`)">
            <AvatarDisplay :avatar="podium[0]?.avatar" :display-name="podium[0]?.displayName || ''" :items="userStore.items" size="lg" :show-name="true" />
          </div>
          <div class="bg-gradient-to-b from-amber-500/30 to-amber-900/10 border border-amber-500/40 rounded-xl px-4 py-2 text-center w-24 h-20 flex flex-col items-center justify-center glow-legendary">
            <div class="text-2xl font-extrabold text-amber-400">1</div>
            <CoinDisplay :amount="podium[0]?.coins || 0" size="sm" />
          </div>
        </div>
        <!-- 3rd place -->
        <div class="flex flex-col items-center gap-2">
          <div class="cursor-pointer" @click="router.push(`/teacher/room/${podium[2]?.id}`)">
            <AvatarDisplay :avatar="podium[2]?.avatar" :display-name="podium[2]?.displayName || ''" :items="userStore.items" size="md" :show-name="true" />
          </div>
          <div class="bg-gradient-to-b from-amber-700/20 to-amber-900/10 border border-amber-700/30 rounded-xl px-4 py-2 text-center w-20 h-14 flex flex-col items-center justify-center">
            <div class="text-lg font-extrabold text-amber-700">3</div>
            <CoinDisplay :amount="podium[2]?.coins || 0" size="sm" />
          </div>
        </div>
      </div>

      <!-- Rest of list -->
      <div class="flex flex-col gap-2">
        <div
          v-for="(s, i) in (podium.length >= 3 ? rest : sorted)"
          :key="s.id"
          class="glass-card flex items-center gap-3 p-3 cursor-pointer hover:border-violet-500/40 transition-all"
          @click="router.push(`/teacher/room/${s.id}`)"
        >
          <div class="w-8 text-center font-extrabold flex-shrink-0" :class="rankColor(podium.length >= 3 ? i + 3 : i)">
            {{ podium.length >= 3 ? i + 4 : i + 1 }}
          </div>
          <AvatarDisplay :avatar="s.avatar" :display-name="s.displayName" :items="userStore.items" size="sm" />
          <div class="flex-1 min-w-0">
            <div class="font-bold text-sm truncate">{{ s.displayName }}</div>
            <div class="flex items-center gap-1 text-xs text-slate-400">
              Рів.{{ s.level }}
              <span class="flex items-center gap-0.5 ml-1">
                <Flame :size="11" :stroke-width="2" class="text-orange-400" />{{ s.streak }}
              </span>
            </div>
          </div>
          <div class="flex flex-col items-end gap-1">
            <CoinDisplay v-if="sortBy === 'coins'" :amount="s.coins || 0" size="sm" />
            <div v-else-if="sortBy === 'xp'" class="flex items-center gap-0.5 text-emerald-400 font-extrabold text-sm">
              <Zap :size="12" :stroke-width="2" />{{ s.xp || 0 }}
            </div>
            <div v-else class="flex items-center gap-0.5 text-orange-400 font-extrabold text-sm">
              <Flame :size="12" :stroke-width="2" />{{ s.streak || 0 }}
            </div>
            <span class="flex items-center gap-0.5 text-[10px] font-bold text-violet-400">
              <LayoutDashboard :size="10" :stroke-width="2" /> Кімната
            </span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
