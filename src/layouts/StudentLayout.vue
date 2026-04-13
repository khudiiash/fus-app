<script setup>
import { computed, watch, onMounted, onUnmounted } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { storeToRefs } from 'pinia'
import { useAuthStore }  from '@/stores/auth'
import { useBlockWorldSession } from '@/stores/blockWorldSession'
import { useTradeStore } from '@/stores/trade'
import { useStudentFeedStore } from '@/stores/studentFeed'
import { useUserStore }  from '@/stores/user'
import { useGameification } from '@/composables/useGameification'
import { useToast } from '@/composables/useToast'
import AvatarDisplay from '@/components/avatar/AvatarDisplay.vue'
import PushOptInBanner from '@/components/notifications/PushOptInBanner.vue'
import {
  Home, ShoppingBag, ArrowLeftRight, Trophy, LayoutDashboard, User, Coins, Boxes,
} from 'lucide-vue-next'

const auth        = useAuthStore()
const trade       = useTradeStore()
const studentFeed = useStudentFeedStore()
const userStore   = useUserStore()
const bwSession   = useBlockWorldSession()
const { immersive: bwImmersive } = storeToRefs(bwSession)
const route     = useRoute()
const { coin: toastCoin, info: toastInfo } = useToast()

const profile = computed(() => auth.profile)
const { level, xpProgress } = useGameification(profile)

const navItems = [
  { to: '/student',             Icon: Home,             label: 'Головна',  exact: true },
  { to: '/student/shop',        Icon: ShoppingBag,      label: 'Магазин'              },
  { to: '/student/trade',       Icon: ArrowLeftRight,   label: 'Обмін',    badge: true },
  { to: '/student/leaderboard', Icon: Trophy,           label: 'Рейтинг'              },
  { to: '/student/world',       Icon: Boxes,            label: 'Світ'                 },
  { to: '/student/room',        Icon: LayoutDashboard,  label: 'Кімната'              },
  { to: '/student/profile',     Icon: User,             label: 'Профіль'              },
]

// ── Real-time change notifications ───────────────────────────────────────────
// Track previous values so we can compute deltas on each snapshot update.
let prevCoins = null
let prevXp    = null
let notifyReady = false   // suppress toasts on initial profile load

watch(
  () => auth.profile,
  (newProfile) => {
    if (!newProfile) { prevCoins = null; prevXp = null; notifyReady = false; return }

    const coins = newProfile.coins ?? 0
    const xp    = newProfile.xp    ?? 0

    if (!notifyReady) {
      // First snapshot — seed the previous values; no toast yet.
      prevCoins   = coins
      prevXp      = xp
      notifyReady = true
      return
    }

    const coinDiff = coins - (prevCoins ?? coins)
    const xpDiff   = xp    - (prevXp    ?? xp)

    if (coinDiff > 0) toastCoin(`+${coinDiff} монет!`)
    // Any spend (shop, trade, etc.) lowers coins — only teacher fines should say «штраф» (see історія / сповіщення від вчителя).
    if (coinDiff < 0) toastInfo(`−${Math.abs(coinDiff)} монет`)
    if (xpDiff   > 0 && coinDiff === 0) toastInfo(`+${xpDiff} досвіду`)

    prevCoins = coins
    prevXp    = xp
  },
  { deep: false }   // profile ref is replaced on each snapshot, no deep needed
)

const isActive = (item) => item.exact ? route.path === item.to : route.path.startsWith(item.to)

/** Кімната: без pt/px у main — інакше залишаються смуги; flex-1 заповнює область під хедером і над таббаром */
const isStudentRoom = computed(() => route.path.startsWith('/student/room'))
const isStudentWorld = computed(() => route.path.startsWith('/student/world'))
/** Voxel world play mode: hide header + tab bar and drop main padding so the canvas fills the viewport. */
const hideStudentChrome = computed(() => isStudentWorld.value && bwImmersive.value)

watch(
  () => (auth.profile?.role === 'student' ? auth.profile.id : null),
  (uid) => {
    trade.teardown()
    studentFeed.teardown()
    if (uid) {
      trade.initListeners()
      studentFeed.init()
    }
  },
  { immediate: true },
)

onMounted(() => {
  userStore.fetchItems()
  userStore.fetchQuests()
})

onUnmounted(() => {
  trade.teardown()
  studentFeed.teardown()
  notifyReady = false
})
</script>

<template>
  <!-- h-dvh: явна висота viewport — інакше flex-1 у main не заповнює екран (кімната лишається «карткою») -->
  <div class="flex flex-col h-dvh max-h-dvh min-h-0 overflow-hidden bg-game-bg">

    <!-- ── Top bar ──────────────────────────────────────────────────────── -->
    <header v-show="!hideStudentChrome" class="top-bar shrink-0 z-40 px-4 pb-2">
      <div class="flex items-center gap-3 max-w-lg mx-auto">

        <!-- Avatar -->
        <RouterLink to="/student/profile" class="flex-shrink-0">
          <AvatarDisplay
            :avatar="auth.profile?.avatar"
            :display-name="auth.profile?.displayName || ''"
            :items="userStore.items"
            size="sm"
          />
        </RouterLink>

        <!-- Name + compact XP bar -->
        <div class="flex-1 min-w-0">
          <div class="font-extrabold text-sm truncate tracking-tight leading-tight">
            {{ auth.profile?.displayName }}
          </div>
          <div class="flex items-center gap-1.5 mt-1">
            <span class="text-[10px] font-extrabold shrink-0 leading-none text-accent">Lv.{{ level }}</span>
            <div class="flex-1 h-1 bg-white/[0.08] rounded-full overflow-hidden">
              <div
                class="h-full rounded-full transition-all duration-700"
                :style="{ width: xpProgress.percent + '%', background: 'linear-gradient(to right, var(--accent), #34d399)' }"
              />
            </div>
            <span class="text-[10px] text-slate-600 shrink-0 leading-none tabular-nums">
              {{ xpProgress.current }}/{{ xpProgress.needed }}
            </span>
          </div>
        </div>

        <!-- Coins chip -->
        <div class="coin-chip shrink-0">
          <Coins :size="14" :stroke-width="2" class="text-coin" />
          <span class="font-extrabold text-sm tabular-nums text-coin">{{ (auth.profile?.coins || 0).toLocaleString() }}</span>
        </div>

      </div>
    </header>

    <PushOptInBanner layout="student" />

    <!-- ── Page content ─────────────────────────────────────────────────── -->
    <main class="flex flex-1 min-h-0 w-full min-w-0 flex-col">
      <div
        v-if="isStudentRoom || isStudentWorld"
        class="flex min-h-0 w-full flex-1 flex-col"
        :class="hideStudentChrome ? 'overflow-hidden' : 'overflow-hidden pb-[calc(4rem+env(safe-area-inset-bottom,0px))]'"
      >
        <RouterView />
      </div>
      <div
        v-else
        class="student-app-scroll mx-auto w-full max-w-lg flex-1 min-h-0 overflow-y-auto overscroll-y-contain px-4 pt-4 pb-[calc(6.75rem+env(safe-area-inset-bottom,0px))] touch-pan-y"
      >
        <RouterView />
      </div>
    </main>

    <!-- ── Bottom navigation ─────────────────────────────────────────────── -->
    <nav v-show="!hideStudentChrome" class="bottom-nav fixed bottom-0 left-0 right-0 z-40">
      <div class="flex max-w-lg mx-auto px-2 py-1">
        <RouterLink
          v-for="item in navItems"
          :key="item.to"
          :to="item.to"
          class="flex-1 flex flex-col items-center gap-0.5 py-1.5 px-0.5 relative transition-colors duration-200"
          :class="isActive(item) ? '' : 'text-slate-600 hover:text-slate-400'"
          :style="isActive(item) ? 'color: var(--accent)' : ''"
        >
          <!-- Pill bg -->
          <div v-if="isActive(item)" class="absolute inset-0 mx-0.5 rounded-2xl bg-accent-subtle" />

          <!-- Icon + badge -->
          <div class="relative z-10">
            <span
              v-if="item.badge && trade.incomingCount > 0"
              class="absolute -top-1 -right-1.5 min-w-[14px] h-3.5 px-0.5 bg-red-500 text-white text-[9px] font-extrabold rounded-full flex items-center justify-center"
            >{{ trade.incomingCount }}</span>
            <component :is="item.Icon" :size="20" :stroke-width="isActive(item) ? 2.2 : 1.8" />
          </div>

          <span class="text-[9px] font-extrabold tracking-wide z-10 relative leading-none">
            {{ item.label }}
          </span>
        </RouterLink>
      </div>
    </nav>

  </div>
</template>

<style scoped>
.top-bar {
  /* Clear iPhone notch / Dynamic Island / status bar in standalone PWA */
  padding-top: calc(env(safe-area-inset-top, 0px) + 0.5rem);
  background: rgba(10, 10, 10, 0.92);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  box-shadow: 0 1px 0 rgba(255, 255, 255, 0.05);
}

.coin-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: rgba(245, 158, 11, 0.12);
  color: #fcd34d;
  padding: 4px 10px;
  border-radius: 999px;
  box-shadow: inset 0 0 0 1px rgba(245, 158, 11, 0.18);
}

.bottom-nav {
  background: rgba(10, 10, 10, 0.95);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  box-shadow: 0 -1px 0 rgba(255, 255, 255, 0.06);
  padding-bottom: env(safe-area-inset-bottom, 0px);
}

.student-app-scroll {
  -webkit-overflow-scrolling: touch;
}
</style>
