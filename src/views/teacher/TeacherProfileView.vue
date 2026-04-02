<script setup>
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useUserStore } from '@/stores/user'
import { useToast } from '@/composables/useToast'
import { getTeacherBudgetInfo } from '@/firebase/collections'
import AvatarDisplay from '@/components/avatar/AvatarDisplay.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppCard from '@/components/ui/AppCard.vue'
import CoinDisplay from '@/components/gamification/CoinDisplay.vue'
import { User, Camera, Wallet, GraduationCap, Clock, LogOut, Palette } from 'lucide-vue-next'
import { currentAccent, setAccent, ACCENT_PRESETS } from '@/composables/useAccentColor'

const auth      = useAuthStore()
const userStore = useUserStore()
const router    = useRouter()
const { success, error } = useToast()

const uploadingPhoto = ref(false)
const photoInputEl   = ref(null)

async function onPhotoChange(e) {
  const file = e.target.files?.[0]
  if (!file) return
  uploadingPhoto.value = true
  try {
    await userStore.uploadPhoto(file)
    success('Фото оновлено!')
  } catch (err) {
    error(err.message)
  } finally {
    uploadingPhoto.value = false
    e.target.value = ''
  }
}

async function removePhoto() {
  uploadingPhoto.value = true
  try {
    await userStore.removePhoto()
    success('Фото видалено')
  } catch (err) {
    error(err.message)
  } finally {
    uploadingPhoto.value = false
  }
}

const budgetInfo = computed(() => getTeacherBudgetInfo(auth.profile))

async function logout() {
  await auth.logout()
  router.push('/login')
}
</script>

<template>
  <div class="flex flex-col gap-6 animate-fade-in">

    <div>
      <div class="flex items-center gap-2">
        <User :size="20" :stroke-width="2" class="text-amber-500" />
        <h1 class="text-2xl font-extrabold gradient-heading">Профіль</h1>
      </div>
    </div>

    <!-- Avatar card -->
    <AppCard class="flex flex-col items-center gap-4 py-6">
      <!-- Avatar with camera button -->
      <div class="relative">
        <AvatarDisplay
          :avatar="auth.profile?.avatar"
          :display-name="auth.profile?.displayName || ''"
          :items="[]"
          size="xl"
        />
        <!-- Camera overlay button -->
        <label
          class="absolute bottom-0 right-0 w-10 h-10 rounded-full bg-violet-600 hover:bg-violet-500 flex items-center justify-center cursor-pointer shadow-lg transition-colors"
          :class="uploadingPhoto ? 'opacity-50 cursor-wait' : ''"
          title="Завантажити фото"
        >
          <component :is="uploadingPhoto ? Clock : Camera" :size="16" :stroke-width="2" class="text-white" />
          <input
            ref="photoInputEl"
            type="file"
            accept="image/*"
            class="hidden"
            :disabled="uploadingPhoto"
            @change="onPhotoChange"
          />
        </label>
      </div>

      <!-- Remove photo -->
      <button
        v-if="auth.profile?.avatar?.photoUrl"
        class="text-xs text-slate-500 hover:text-rose-400 transition-colors -mt-1"
        :disabled="uploadingPhoto"
        @click="removePhoto"
      >× Видалити фото</button>

      <!-- Name & role -->
      <div class="text-center">
        <div class="font-extrabold text-xl">{{ auth.profile?.displayName }}</div>
        <div class="text-sm text-violet-300 font-bold mt-0.5">Вчитель</div>
      </div>
    </AppCard>

    <!-- Info card -->
    <AppCard class="flex flex-col gap-3">
      <div class="text-sm font-extrabold text-slate-300 mb-1">Інформація</div>

      <div class="flex items-center justify-between py-2 border-b border-game-border">
        <span class="text-sm text-slate-400">Ім'я</span>
        <span class="font-bold text-sm">{{ auth.profile?.displayName }}</span>
      </div>

      <div class="flex items-center justify-between py-2 border-b border-game-border">
        <span class="text-sm text-slate-400">Роль</span>
        <span class="flex items-center gap-1 font-bold text-sm text-violet-300">
          <GraduationCap :size="13" :stroke-width="2" /> Вчитель
        </span>
      </div>

      <div class="flex items-center justify-between py-2">
        <span class="text-sm text-slate-400">Код доступу</span>
        <span class="font-mono font-extrabold text-amber-400 text-sm bg-amber-500/10 px-3 py-1 rounded-lg">
          {{ auth.profile?.accessCode || '—' }}
        </span>
      </div>
    </AppCard>

    <!-- Weekly budget card -->
    <AppCard class="flex flex-col gap-3">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-1.5 text-sm font-extrabold text-slate-300">
          <Wallet :size="14" :stroke-width="2" class="text-amber-400" /> Тижневий бюджет
        </div>
        <div class="font-extrabold text-sm" :class="budgetInfo.remaining < 50 ? 'text-red-400' : budgetInfo.remaining < 150 ? 'text-amber-400' : 'text-emerald-400'">
          <span class="flex items-center gap-1">
            {{ budgetInfo.remaining }} / {{ budgetInfo.budget }}
            <Wallet :size="11" :stroke-width="2" />
          </span>
        </div>
      </div>
      <div class="h-3 bg-game-bg rounded-full overflow-hidden">
        <div
          class="h-full rounded-full transition-all duration-500"
          :class="budgetInfo.remaining < 50 ? 'bg-red-500' : budgetInfo.remaining < 150 ? 'bg-amber-500' : 'bg-emerald-500'"
          :style="{ width: Math.round((budgetInfo.remaining / budgetInfo.budget) * 100) + '%' }"
        />
      </div>
      <div class="flex items-center justify-between text-xs text-slate-500">
        <span class="flex items-center gap-0.5">Використано: {{ budgetInfo.used }} <Wallet :size="10" :stroke-width="2" /></span>
        <span>Оновлюється щопонеділка</span>
      </div>
    </AppCard>

    <!-- Accent color picker -->
    <AppCard class="flex flex-col gap-3">
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
    </AppCard>

    <!-- Logout -->
    <AppButton variant="ghost" size="lg" block @click="logout">
      <LogOut :size="15" :stroke-width="2" /> Вийти
    </AppButton>

  </div>
</template>
