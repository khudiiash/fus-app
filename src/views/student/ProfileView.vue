<script setup>
import { computed, onMounted } from 'vue'
import { useAuthStore }  from '@/stores/auth'
import { useUserStore }  from '@/stores/user'
import { useRouter }     from 'vue-router'
import { useGameification } from '@/composables/useGameification'
import AvatarBuilder from '@/components/avatar/AvatarBuilder.vue'
import CharacterScene from '@/components/character/CharacterScene.vue'
import AppButton from '@/components/ui/AppButton.vue'
import { Star, Coins, Flame, Award, Package, LogOut, ArrowRight, Key, Palette } from 'lucide-vue-next'
import { currentAccent, setAccent, ACCENT_PRESETS } from '@/composables/useAccentColor'

const auth      = useAuthStore()
const userStore = useUserStore()
const router    = useRouter()
const profile   = computed(() => auth.profile)
const { level, coins, streak, xpProgress } = useGameification(profile)

onMounted(() => userStore.fetchItems())

function totalInventoryUnits(p) {
  if (!p) return 0
  const inv = p.inventory || []
  const iq = p.inventoryCounts || {}
  let n = 0
  for (const id of inv) n += iq[id] || 1
  const mb = p.mysteryBoxCounts || {}
  for (const c of Object.values(mb)) n += Number(c) || 0
  return n
}

const stats = computed(() => [
  { label: 'Рівень',   value: level.value,                              Icon: Star,    color: 'text-accent',     bg: 'bg-violet-500/[0.1]'  },
  { label: 'Монети',   value: coins.value.toLocaleString(),             Icon: Coins,   color: 'text-amber-400',  bg: 'bg-amber-500/[0.1]'   },
  { label: 'Серія',    value: streak.value + 'д',                       Icon: Flame,   color: 'text-orange-400', bg: 'bg-orange-500/[0.1]'  },
  { label: 'Нагороди', value: (profile.value?.badges || []).length,     Icon: Award,   color: 'text-blue-400',   bg: 'bg-blue-500/[0.1]'    },
  { label: 'Предмети', value: totalInventoryUnits(profile.value),      Icon: Package, color: 'text-emerald-400', bg: 'bg-emerald-500/[0.1]' },
])

async function logout() {
  await auth.logout()
  router.push('/login')
}
</script>

<template>
  <div class="flex flex-col gap-5 animate-fade-in">

    <!-- ── Character hero card ──────────────────────────────────────────── -->
    <div class="character-card overflow-hidden rounded-3xl cursor-pointer" @click="router.push('/student/room')">

      <!-- 3D scene -->
      <div class="h-[min(42vw,320px)] min-h-[220px] max-h-[320px] relative">
        <CharacterScene
          :profile="profile"
          :owned-item-ids="profile?.inventory || []"
          :all-items="userStore.items"
          :room-mode="true"
          :interactive="false"
          :initial-zoom="0.52"
          :show-room-hud="false"
          class="w-full h-full"
        />
        <!-- Gradient overlay with name -->
        <div class="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-black/80 to-transparent" />
        <div class="absolute bottom-0 inset-x-0 px-4 pb-3 flex items-end justify-between">
          <div>
            <div class="font-extrabold text-white text-base leading-tight">{{ profile?.displayName }}</div>
            <div class="flex items-center gap-1 text-slate-400 text-xs mt-0.5">
              <Key :size="11" :stroke-width="2" />
              <span>{{ profile?.accessCode }}</span>
            </div>
          </div>
          <div class="flex items-center gap-1 text-xs font-bold text-accent">
            <span>Кімната</span>
            <ArrowRight :size="12" :stroke-width="2.5" />
          </div>
        </div>
      </div>

      <!-- XP strip -->
      <div class="px-4 pt-2.5 pb-3">
        <div class="flex items-center justify-between mb-1.5 text-xs">
          <span class="font-extrabold text-slate-300">Рівень {{ level }}</span>
          <span class="text-xp font-bold tabular-nums">{{ xpProgress.current }}&thinsp;/&thinsp;{{ xpProgress.needed }} ДО</span>
        </div>
        <div class="h-1.5 bg-white/[0.07] rounded-full overflow-hidden">
          <div
            class="h-full rounded-full transition-all duration-700"
            :style="{ width: xpProgress.percent + '%', background: 'linear-gradient(to right, var(--accent), #34d399)' }"
          />
        </div>
      </div>
    </div>

    <!-- ── Stats row ─────────────────────────────────────────────────────── -->
    <div class="grid grid-cols-5 gap-2">
      <div
        v-for="stat in stats"
        :key="stat.label"
        class="stat-cell flex flex-col items-center gap-1 py-3 rounded-2xl"
        :class="stat.bg"
      >
        <component :is="stat.Icon" :size="18" :stroke-width="1.8" :class="stat.color" />
        <div class="font-extrabold text-sm leading-none">{{ stat.value }}</div>
        <div class="text-[9px] text-slate-500 font-bold leading-none">{{ stat.label }}</div>
      </div>
    </div>

    <!-- ── Avatar builder ─────────────────────────────────────────────────── -->
    <section>
      <h2 class="font-extrabold text-base mb-3 text-slate-200">Аватар</h2>
      <AvatarBuilder />
    </section>

    <!-- ── Accent color picker ──────────────────────────────────────────────── -->
    <section class="glass-card p-4 flex flex-col gap-3">
      <div class="flex items-center gap-2 text-sm font-bold text-slate-300">
        <Palette :size="15" :stroke-width="2" class="text-accent" />
        Колір інтерфейсу
      </div>
      <div class="flex gap-2.5 flex-wrap">
        <button
          v-for="preset in ACCENT_PRESETS"
          :key="preset.hex"
          class="w-8 h-8 rounded-full transition-all duration-200 hover:scale-110"
          :class="currentAccent === preset.hex ? 'ring-2 ring-white/70 ring-offset-2 ring-offset-game-card scale-110' : ''"
          :style="{ background: preset.hex }"
          :title="preset.name"
          @click="setAccent(preset.hex)"
        />
      </div>
    </section>

    <!-- ── Logout ─────────────────────────────────────────────────────────── -->
    <button
      class="logout-btn flex items-center justify-center gap-2 w-full py-3 rounded-2xl text-sm font-bold text-slate-500 transition-all hover:text-red-400"
      @click="logout"
    >
      <LogOut :size="16" :stroke-width="2" />
      Вийти
    </button>

  </div>
</template>

<style scoped>
.character-card {
  background: rgba(255, 255, 255, 0.04);
  box-shadow:
    inset 0 0 0 1px rgba(255, 255, 255, 0.07),
    0 8px 32px rgba(0, 0, 0, 0.4);
}

.logout-btn {
  background: rgba(255, 255, 255, 0.03);
}
.logout-btn:hover {
  background: rgba(239, 68, 68, 0.08);
}
</style>
