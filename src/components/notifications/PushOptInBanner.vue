<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'

const props = defineProps({
  /** Вирівнювання ширини з основним контентом лейауту */
  layout: { type: String, default: 'student' }, // 'student' | 'teacher'
})

const maxWidthClass = computed(() =>
  props.layout === 'teacher' ? 'max-w-2xl' : 'max-w-lg',
)
import {
  hasFcmVapidConfigured,
  isFcmWebPushEnvironmentOk,
  requestWebPushPermissionAndRegister,
} from '@/firebase/fcmClient'
import { useToast } from '@/composables/useToast'
import { Bell, X } from 'lucide-vue-next'

const DISMISS_MS = 7 * 24 * 60 * 60 * 1000
const STORAGE_KEY = 'fus_push_optin_dismissed_at'

/** localStorage/sessionStorage не реактивні — інкремент змушує computed перечитати ключі */
const optInDismissTick = ref(0)
const deniedHintTick = ref(0)

const auth = useAuthStore()
const { success, error } = useToast()

const envOk = ref(false)
const loading = ref(false)
/** 'default' | 'granted' | 'denied' */
const permission = ref(
  typeof Notification !== 'undefined' ? Notification.permission : 'denied',
)

function readPermission() {
  permission.value = typeof Notification !== 'undefined' ? Notification.permission : 'denied'
}

onMounted(async () => {
  envOk.value = await isFcmWebPushEnvironmentOk()
  readPermission()
})

watch(
  () => auth.profile?.id,
  () => readPermission(),
)

const dismissedRecently = computed(() => {
  void optInDismissTick.value
  const t = Number(localStorage.getItem(STORAGE_KEY) || '0')
  return t > 0 && Date.now() - t < DISMISS_MS
})

/** Банер «увімкнути» */
const showOptIn = computed(() => {
  if (!auth.profile?.id) return false
  if (!hasFcmVapidConfigured()) return false
  if (!envOk.value) return false
  if (permission.value !== 'default') return false
  if (dismissedRecently.value) return false
  return true
})

/** Підказка, якщо вже відмовили */
const showDeniedHint = computed(() => {
  void deniedHintTick.value
  if (!auth.profile?.id) return false
  if (!hasFcmVapidConfigured()) return false
  if (!envOk.value) return false
  if (permission.value !== 'denied') return false
  return sessionStorage.getItem('fus_push_denied_hint_closed') !== '1'
})

function dismissOptIn() {
  localStorage.setItem(STORAGE_KEY, String(Date.now()))
  optInDismissTick.value += 1
}

function closeDeniedHint() {
  sessionStorage.setItem('fus_push_denied_hint_closed', '1')
  deniedHintTick.value += 1
}

async function enablePush() {
  if (!auth.profile?.id) return
  loading.value = true
  try {
    const res = await requestWebPushPermissionAndRegister(auth.profile.id)
    readPermission()
    if (res.ok) {
      success('Сповіщення увімкнено')
      localStorage.removeItem(STORAGE_KEY)
    } else if (res.reason === 'not_configured') {
      error('Push не налаштовано (немає VAPID-ключа у збірці)')
    } else if (res.reason === 'unsupported') {
      error('Цей браузер не підтримує push')
    } else if (res.reason === 'denied') {
      error('Доступ заборонено — зміни в налаштуваннях сайту / браузера')
    } else {
      error('Не вдалося увімкнути сповіщення')
    }
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div v-if="showOptIn" class="shrink-0 z-30 px-3 pt-1 pb-2 mx-auto w-full" :class="maxWidthClass">
    <div
      class="flex items-start gap-2.5 rounded-2xl border border-violet-500/25 bg-violet-500/[0.08] px-3 py-2.5"
    >
      <div class="mt-0.5 rounded-xl bg-violet-500/20 p-1.5 shrink-0">
        <Bell :size="16" :stroke-width="2" class="text-violet-300" />
      </div>
      <div class="flex-1 min-w-0 pt-0.5">
        <div class="font-extrabold text-sm text-slate-100 leading-tight">Увімкнути сповіщення?</div>
        <p class="text-[11px] text-slate-400 mt-1 leading-snug">
          Завдання, обміни та нагороди — навіть коли вкладка неактивна. Натисни «Дозволити» в діалозі браузера.
        </p>
        <div class="flex flex-wrap gap-2 mt-2">
          <button
            type="button"
            class="min-h-9 px-3 rounded-xl font-extrabold text-xs text-slate-900 active:scale-[0.98] transition-transform disabled:opacity-50"
            style="background: linear-gradient(135deg, var(--accent), #a78bfa)"
            :disabled="loading"
            @click="enablePush"
          >
            {{ loading ? '…' : 'Увімкнути' }}
          </button>
          <button
            type="button"
            class="min-h-9 px-3 rounded-xl font-bold text-xs text-slate-400 bg-white/[0.06] border border-white/[0.08]"
            @click="dismissOptIn"
          >
            Не зараз
          </button>
        </div>
      </div>
      <button
        type="button"
        class="p-1 rounded-lg text-slate-500 hover:text-slate-300 shrink-0"
        aria-label="Закрити"
        @click="dismissOptIn"
      >
        <X :size="16" :stroke-width="2" />
      </button>
    </div>
  </div>

  <div
    v-else-if="showDeniedHint"
    class="shrink-0 z-30 px-3 pt-1 pb-2 mx-auto w-full"
    :class="maxWidthClass"
  >
    <div class="flex items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-[11px] text-slate-400">
      <span class="flex-1 leading-snug">
        Сповіщення вимкнено для цього сайту. Щоб отримувати push, дозволь їх у налаштуваннях браузера для FUSAPP.
      </span>
      <button
        type="button"
        class="p-1 rounded-lg text-slate-500 hover:text-slate-300 shrink-0"
        aria-label="Закрити"
        @click="closeDeniedHint"
      >
        <X :size="14" :stroke-width="2" />
      </button>
    </div>
  </div>
</template>
