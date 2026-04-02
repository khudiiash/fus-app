<script setup>
import { ref, computed, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { getAllAchievements } from '@/firebase/collections'
import AppCard from '@/components/ui/AppCard.vue'
import CoinDisplay from '@/components/gamification/CoinDisplay.vue'
import { Award, Lock, CheckCircle2, Inbox } from 'lucide-vue-next'

const auth         = useAuthStore()
const achievements = ref([])
const filter       = ref('all')
const filters      = [
  { key: 'all',    label: 'Всі' },
  { key: 'earned', label: 'Отримані' },
  { key: 'locked', label: 'Заблоковані' },
]

onMounted(async () => {
  achievements.value = await getAllAchievements()
})

const earned = computed(() => new Set(auth.profile?.badges || []))

const filtered = computed(() => {
  const all = achievements.value
  if (filter.value === 'earned') return all.filter(a => earned.value.has(a.id))
  if (filter.value === 'locked') return all.filter(a => !earned.value.has(a.id))
  return all
})

const earnedCount = computed(() => achievements.value.filter(a => earned.value.has(a.id)).length)

const conditionLabel = (ach) => {
  const { type, threshold } = ach.condition || {}
  if (type === 'coins')  return `Зароби ${threshold} монет`
  if (type === 'level')  return `Досягни рівня ${threshold}`
  if (type === 'streak') return `${threshold} днів входу поспіль`
  return 'Виконай особливі завдання'
}
</script>

<template>
  <div class="flex flex-col gap-4 animate-fade-in">
    <!-- Header -->
    <div>
      <div class="flex items-center gap-2 mb-0.5">
        <Award :size="20" :stroke-width="2" class="text-amber-500" />
        <h1 class="text-2xl font-extrabold gradient-heading">Досягнення</h1>
      </div>
      <p class="text-slate-500 text-sm">{{ earnedCount }} / {{ achievements.length }} розблоковано</p>
    </div>

    <!-- Progress bar -->
    <div class="glass-card p-4">
      <div class="flex justify-between text-xs text-slate-400 mb-2 font-semibold">
        <span>Прогрес</span>
        <span class="text-violet-300">{{ earnedCount }} / {{ achievements.length }}</span>
      </div>
      <div class="h-3 bg-black/30 rounded-full overflow-hidden">
        <div
          class="h-full bg-gradient-to-r from-amber-600 to-amber-400 rounded-full transition-all duration-700"
          :style="{ width: achievements.length ? Math.round((earnedCount / achievements.length) * 100) + '%' : '0%' }"
        />
      </div>
    </div>

    <!-- Filter -->
    <div class="flex p-1 rounded-2xl" style="background:rgba(255,255,255,0.05)">
      <button v-for="f in filters" :key="f.key"
        class="flex-1 py-2 rounded-xl font-bold text-sm transition-all duration-200"
        :class="filter === f.key ? 'tab-active' : 'text-slate-500 hover:text-slate-300'"
        @click="filter = f.key"
      >{{ f.label }}</button>
    </div>

    <div v-if="filtered.length === 0" class="text-center py-12 text-slate-600">
      <Inbox :size="48" :stroke-width="1" class="mx-auto mb-3 opacity-30" />
      <div class="font-bold text-slate-500">Нічого не знайдено</div>
    </div>

    <div v-else class="grid grid-cols-2 gap-3">
      <div
        v-for="ach in filtered"
        :key="ach.id"
        class="glass-card p-4 flex flex-col gap-2 text-center transition-all duration-300"
        :class="{
          'glow-legendary': earned.has(ach.id) && ach.rarity === 'legendary',
          'glow-epic':      earned.has(ach.id) && ach.rarity === 'epic',
          'glow-rare':      earned.has(ach.id) && ach.rarity === 'rare',
          'opacity-40':     !earned.has(ach.id),
        }"
      >
        <!-- Icon (emoji from data, or Award fallback) -->
        <div class="relative flex items-center justify-center h-12">
          <span v-if="ach.icon" class="text-4xl">{{ ach.icon }}</span>
          <Award v-else :size="36" :stroke-width="1.5" class="text-amber-500/60" />
          <div v-if="!earned.has(ach.id)" class="absolute inset-0 flex items-center justify-center">
            <div class="w-8 h-8 rounded-full bg-game-bg/80 flex items-center justify-center">
              <Lock :size="16" :stroke-width="2" class="text-slate-500" />
            </div>
          </div>
        </div>

        <div class="font-extrabold text-sm">{{ ach.name }}</div>
        <div class="text-xs text-slate-400">{{ conditionLabel(ach) }}</div>
        <div v-if="earned.has(ach.id)" class="flex items-center justify-center gap-1 text-xs text-emerald-400 font-bold">
          <CheckCircle2 :size="11" :stroke-width="2.5" /> Розблоковано
        </div>
        <div v-if="ach.rewardCoins" class="flex justify-center">
          <CoinDisplay :amount="ach.rewardCoins" show-sign size="sm" />
        </div>
      </div>
    </div>
  </div>
</template>
