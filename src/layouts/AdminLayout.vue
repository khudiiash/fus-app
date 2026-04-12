<script setup>
import { ref } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import AppButton from '@/components/ui/AppButton.vue'
import { BarChart2, School, Users, GraduationCap, BookOpen, ShoppingBag, Terminal, Boxes, Activity } from 'lucide-vue-next'

const auth     = useAuthStore()
const route    = useRoute()
const router   = useRouter()
const menuOpen = ref(false)

const navItems = [
  { to: '/admin',           Icon: BarChart2,     label: 'Панель',     exact: true },
  { to: '/admin/classes',   Icon: School,        label: 'Класи'                  },
  { to: '/admin/students',  Icon: Users,         label: 'Учні'                   },
  { to: '/admin/teachers',  Icon: GraduationCap, label: 'Вчителі'                },
  { to: '/admin/subjects',  Icon: BookOpen,      label: 'Предмети'               },
  { to: '/admin/shop',      Icon: ShoppingBag,   label: 'Магазин'                },
  { to: '/admin/rooms',     Icon: Boxes,         label: 'Примірочна'             },
  { to: '/admin/activity',  Icon: Activity,      label: 'Активність'             },
  { to: '/admin/devtools',  Icon: Terminal,      label: 'Інструменти'            },
]

const isActive = (item) => item.exact ? route.path === item.to : route.path.startsWith(item.to)

async function logout() {
  await auth.logout()
  router.push('/login')
}
</script>

<template>
  <div class="flex h-screen bg-game-bg">

    <!-- ── Sidebar (desktop) ─────────────────────────────────────────── -->
    <aside class="sidebar hidden md:flex flex-col w-56 p-4 gap-2">
      <div class="px-2 py-4 mb-2">
        <div class="font-extrabold text-xl text-accent tracking-tight">FUSAPP</div>
        <div class="text-xs text-slate-500 font-semibold">Адмін панель</div>
      </div>
      <nav class="flex-1 flex flex-col gap-1">
        <RouterLink
          v-for="item in navItems"
          :key="item.to"
          :to="item.to"
          class="flex items-center gap-3 px-3 py-2.5 rounded-2xl font-bold text-sm transition-all duration-150"
          :class="isActive(item) ? 'text-white shadow-sm' : 'text-slate-400 hover:bg-white/[0.06] hover:text-white'"
          :style="isActive(item) ? 'background: rgba(var(--accent-rgb),0.18); box-shadow: inset 0 0 0 1px rgba(var(--accent-rgb),0.3)' : ''"
        >
          <component :is="item.Icon" :size="18" :stroke-width="isActive(item) ? 2.2 : 1.8" />
          {{ item.label }}
        </RouterLink>
      </nav>
      <AppButton variant="ghost" size="sm" block @click="logout">Вийти</AppButton>
    </aside>

    <div class="flex-1 flex flex-col min-w-0">

      <!-- ── Mobile top bar ──────────────────────────────────────────── -->
      <header class="top-bar md:hidden sticky top-0 z-40 px-4 pb-3 flex items-center justify-between">
        <div class="font-extrabold text-accent tracking-tight">FUSAPP Адмін</div>
        <button class="text-slate-400 w-9 h-9 flex items-center justify-center rounded-xl hover:bg-white/10 transition-colors" @click="menuOpen = !menuOpen">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><rect y="3" width="18" height="2" rx="1" fill="currentColor"/><rect y="8" width="18" height="2" rx="1" fill="currentColor"/><rect y="13" width="18" height="2" rx="1" fill="currentColor"/></svg>
        </button>
      </header>

      <!-- ── Mobile drawer ────────────────────────────────────────────── -->
      <Transition name="drawer">
        <div v-if="menuOpen" class="md:hidden fixed inset-0 z-50" @click="menuOpen = false">
          <div class="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <div class="drawer-panel absolute left-0 top-0 h-full w-64 px-5 pb-5 flex flex-col gap-2" @click.stop>
            <div class="font-extrabold text-xl text-accent tracking-tight px-2 py-4 mb-2">FUSAPP</div>
            <nav class="flex-1 flex flex-col gap-1">
              <RouterLink
                v-for="item in navItems"
                :key="item.to"
                :to="item.to"
                class="flex items-center gap-3 px-3 py-2.5 rounded-2xl font-bold text-sm transition-all"
                :class="isActive(item) ? 'text-white' : 'text-slate-400 hover:bg-white/[0.06]'"
                :style="isActive(item) ? 'background: rgba(var(--accent-rgb),0.18)' : ''"
                @click="menuOpen = false"
              >
                <component :is="item.Icon" :size="18" :stroke-width="isActive(item) ? 2.2 : 1.8" />
                {{ item.label }}
              </RouterLink>
            </nav>
            <AppButton variant="ghost" size="sm" block @click="logout">Вийти</AppButton>
          </div>
        </div>
      </Transition>

      <!-- ── Page content ─────────────────────────────────────────────── -->
      <main class="flex-1 p-4 md:p-6 overflow-auto">
        <RouterView />
      </main>

    </div>
  </div>
</template>

<style scoped>
.sidebar {
  background: rgba(11, 11, 28, 0.95);
  box-shadow: 1px 0 0 rgba(255, 255, 255, 0.05);
}

.top-bar {
  padding-top: calc(env(safe-area-inset-top, 0px) + 0.75rem);
  background: rgba(6, 6, 15, 0.85);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  box-shadow: 0 1px 0 rgba(255, 255, 255, 0.05), 0 4px 20px rgba(0, 0, 0, 0.4);
}

.drawer-panel {
  padding-top: calc(env(safe-area-inset-top, 0px) + 1.25rem);
  background: rgba(11, 11, 28, 0.98);
  backdrop-filter: blur(24px);
  -webkit-backdrop-filter: blur(24px);
  box-shadow: 4px 0 32px rgba(0, 0, 0, 0.6);
}

/* Drawer transition */
.drawer-enter-active, .drawer-leave-active { transition: opacity 0.25s ease; }
.drawer-enter-from, .drawer-leave-to { opacity: 0; }
.drawer-enter-active .drawer-panel { animation: slide-in-left 0.3s cubic-bezier(0.34, 1.56, 0.64, 1) both; }

@keyframes slide-in-left {
  from { transform: translateX(-100%); }
  to   { transform: translateX(0); }
}
</style>
