<script setup>
import { computed } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import {
  LayoutDashboard, ScrollText, Trophy, History, User,
} from 'lucide-vue-next'
import { givenNameInitial } from '@/utils/personName'

const auth  = useAuthStore()
const route = useRoute()

const navItems = [
  { to: '/teacher',             Icon: LayoutDashboard, label: 'Панель',   exact: true },
  { to: '/teacher/quests',      Icon: ScrollText,      label: 'Завдання'              },
  { to: '/teacher/leaderboard', Icon: Trophy,          label: 'Рейтинг'              },
  { to: '/teacher/history',     Icon: History,         label: 'Історія'              },
  { to: '/teacher/profile',     Icon: User,            label: 'Профіль'              },
]

const isActive = (item) => item.exact ? route.path === item.to : route.path.startsWith(item.to)

/** Кімната учня: як у студента — повна висота між хедером і таббаром, без горизонтальних полів */
const isTeacherRoom = computed(() => route.path.startsWith('/teacher/room'))
</script>

<template>
  <div class="flex flex-col h-dvh max-h-dvh min-h-0 overflow-hidden bg-game-bg">

    <!-- ── Top bar ──────────────────────────────────────────────────────── -->
    <header class="top-bar shrink-0 z-40 px-4 pb-3">
      <div class="max-w-2xl mx-auto flex items-center justify-between">
        <div>
          <div class="font-extrabold leading-none tracking-tight text-accent">FUSAPP</div>
          <div class="text-xs text-slate-500 font-semibold mt-0.5">{{ auth.profile?.displayName }}</div>
        </div>

        <RouterLink to="/teacher/profile" class="avatar-pill w-9 h-9 rounded-full flex items-center justify-center font-extrabold text-base text-white">
          {{ givenNameInitial(auth.profile?.displayName) }}
        </RouterLink>
      </div>
    </header>

    <!-- ── Page content ─────────────────────────────────────────────────── -->
    <main
      class="flex-1 min-h-0 w-full flex flex-col min-w-0"
      :class="isTeacherRoom
        ? 'max-w-none mx-0 px-0 pt-0 overflow-hidden pb-[calc(4rem+env(safe-area-inset-bottom,0px))]'
        : 'max-w-2xl mx-auto w-full px-4 py-5 overflow-y-auto overscroll-y-contain pb-[calc(5.5rem+env(safe-area-inset-bottom,0px))]'"
    >
      <div v-if="isTeacherRoom" class="flex flex-1 flex-col min-h-0 min-w-0 w-full">
        <RouterView />
      </div>
      <RouterView v-else />
    </main>

    <!-- ── Bottom navigation ─────────────────────────────────────────────── -->
    <nav class="bottom-nav fixed bottom-0 left-0 right-0 z-40">
      <div class="flex max-w-2xl mx-auto px-2 py-1">
        <RouterLink
          v-for="item in navItems"
          :key="item.to"
          :to="item.to"
          class="flex-1 flex flex-col items-center gap-0.5 py-1.5 px-0.5 relative transition-colors duration-200"
          :class="isActive(item) ? '' : 'text-slate-600 hover:text-slate-400'"
          :style="isActive(item) ? 'color: var(--accent)' : ''"
        >
          <div v-if="isActive(item)" class="absolute inset-0 mx-0.5 rounded-2xl bg-accent-subtle" />
          <component :is="item.Icon" :size="20" :stroke-width="isActive(item) ? 2.2 : 1.8" class="z-10 relative" />
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
  padding-top: calc(env(safe-area-inset-top, 0px) + 0.75rem);
  background: rgba(10, 10, 10, 0.92);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  box-shadow: 0 1px 0 rgba(255, 255, 255, 0.05);
}

.avatar-pill {
  background: rgba(255, 255, 255, 0.08);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.12);
  transition: background 0.2s;
}
.avatar-pill:hover { background: rgba(255, 255, 255, 0.14); }

.bottom-nav {
  background: rgba(10, 10, 10, 0.95);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  box-shadow: 0 -1px 0 rgba(255, 255, 255, 0.06);
  padding-bottom: env(safe-area-inset-bottom, 0px);
}
</style>
