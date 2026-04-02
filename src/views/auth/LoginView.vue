<script setup>
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useHaptic } from '@/composables/useHaptic'
import { useToast } from '@/composables/useToast'
import AppButton from '@/components/ui/AppButton.vue'

const router  = useRouter()
const auth    = useAuthStore()
const { error: hapticError, success: hapticSuccess } = useHaptic()
const { error, info } = useToast()

const code    = ref('')
const loading = ref(false)
const shake   = ref(false)
const stars   = ref([])

onMounted(() => {
  stars.value = Array.from({ length: 30 }, (_, i) => ({
    id: i,
    x: Math.random() * 100,
    y: Math.random() * 100,
    size: 1 + Math.random() * 3,
    delay: Math.random() * 3,
    duration: 2 + Math.random() * 4,
  }))
})

async function login() {
  if (!code.value.trim()) {
    triggerShake()
    error('Введіть код доступу')
    return
  }
  loading.value = true
  try {
    await auth.loginWithCode(code.value)
    hapticSuccess()
    // Read role from profile after await (Pinia computed on store can be stale if captured wrong)
    const role = auth.profile?.role
    if (role === 'admin') await router.replace('/admin')
    else if (role === 'teacher') await router.replace('/teacher')
    else await router.replace('/student')
  } catch (e) {
    triggerShake()
    hapticError()
    error(e.message || 'Невірний код. Спробуйте ще раз.')
  } finally {
    loading.value = false
  }
}

function triggerShake() {
  shake.value = true
  setTimeout(() => { shake.value = false }, 500)
}

function onKey(e) { if (e.key === 'Enter') login() }
</script>

<template>
  <div
    class="relative min-h-screen min-h-dvh flex flex-col items-center justify-center px-4 overflow-hidden bg-game-bg login-safe"
  >
    <!-- Star field -->
    <div class="absolute inset-0 overflow-hidden pointer-events-none">
      <div
        v-for="star in stars"
        :key="star.id"
        class="absolute rounded-full bg-white animate-pulse-glow"
        :style="{
          left: star.x + '%',
          top: star.y + '%',
          width: star.size + 'px',
          height: star.size + 'px',
          animationDelay: star.delay + 's',
          animationDuration: star.duration + 's',
          opacity: 0.3 + Math.random() * 0.5,
        }"
      />
    </div>

    <!-- Glow orbs -->
    <div class="absolute top-1/4 left-1/4 w-64 h-64 bg-violet-600/20 rounded-full blur-3xl pointer-events-none" />
    <div class="absolute bottom-1/4 right-1/4 w-48 h-48 bg-indigo-600/20 rounded-full blur-3xl pointer-events-none" />

    <!-- Logo -->
    <div class="relative text-center mb-10">
      <div class="text-7xl animate-float mb-4">⚡</div>
      <div class="text-5xl font-extrabold bg-gradient-to-r from-violet-400 to-indigo-300 bg-clip-text text-transparent">
        FUSAPP
      </div>
      <div class="text-slate-400 font-semibold mt-2">Твоя шкільна пригода починається тут</div>
    </div>

    <!-- Login card -->
    <div
      class="relative glass-card p-8 w-full max-w-sm"
      :class="shake ? 'animate-[shake_0.5s_ease-in-out]' : ''"
    >
      <div class="text-center mb-6">
        <h2 class="font-extrabold text-xl mb-1">Введіть свій код</h2>
        <p class="text-slate-400 text-sm">Вчитель або адмін видали вам код для входу</p>
      </div>

      <div class="flex flex-col gap-4">
        <div class="relative">
          <input
            v-model="code"
            type="text"
            placeholder="напр. WOLF-4821"
            class="w-full bg-game-bg border-2 border-game-border rounded-xl px-4 py-4 text-center text-2xl font-extrabold text-white placeholder-slate-600 uppercase tracking-widest focus:outline-none focus:border-violet-500 transition-colors"
            :class="shake ? 'border-red-500' : ''"
            maxlength="12"
            autocomplete="off"
            autocapitalize="characters"
            @keyup="code = code.toUpperCase()"
            @keydown="onKey"
          />
        </div>

        <AppButton variant="primary" size="lg" block :loading="loading" @click="login">
          🚀 Увійти до FUSAPP
        </AppButton>
      </div>

      <div class="mt-6 text-center text-xs text-slate-500">
        Немає коду? Запитайте у вчителя або адміністратора.
      </div>
    </div>

    <!-- Bottom tagline -->
    <div class="relative mt-8 text-center text-slate-600 text-xs">
      Заробляй · Торгуй · Розвивайся
    </div>
  </div>
</template>

<style scoped>
.login-safe {
  padding-top: env(safe-area-inset-top, 0px);
  padding-bottom: env(safe-area-inset-bottom, 0px);
}

@keyframes shake {
  0%, 100% { transform: translateX(0); }
  20% { transform: translateX(-8px); }
  40% { transform: translateX(8px); }
  60% { transform: translateX(-6px); }
  80% { transform: translateX(6px); }
}
</style>
