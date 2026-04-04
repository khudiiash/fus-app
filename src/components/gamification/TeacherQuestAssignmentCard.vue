<script setup>
import { ref, watch, computed } from 'vue'
import { doc, getDoc } from 'firebase/firestore'
import { db } from '@/firebase/config'
import { useUserStore } from '@/stores/user'
import CoinDisplay from '@/components/gamification/CoinDisplay.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AvatarDisplay from '@/components/avatar/AvatarDisplay.vue'
import { Zap, Trophy, Clock, CheckCircle2, XCircle, Upload, RefreshCw } from 'lucide-vue-next'

const props = defineProps({
  quest: { type: Object, required: true },
  /** Заявка учня на це завдання або null */
  completion: { type: Object, default: null },
  /** Для підказки «першому» */
  studentId: { type: String, default: '' },
})

defineEmits(['submit'])

const userStore = useUserStore()

/** Уникаємо повторних getDoc для одного вчителя (багато квестів на сторінці). */
const teacherCache = new Map()

const teacherAvatar = ref(null)
const teacherDisplayName = ref('')

const subjectLabel = computed(() => {
  const s = props.quest?.subjectName
  if (s == null) return ''
  const t = String(s).trim()
  return t || ''
})

async function hydrateTeacher() {
  const q = props.quest
  const uid = q?.teacherId
  const fallbackName = (q?.teacherName && String(q.teacherName).trim()) || ''

  if (!uid) {
    teacherAvatar.value = null
    teacherDisplayName.value = fallbackName
    return
  }

  if (teacherCache.has(uid)) {
    const c = teacherCache.get(uid)
    teacherAvatar.value = c.avatar
    teacherDisplayName.value = (c.displayName && String(c.displayName).trim()) || fallbackName
    return
  }

  try {
    const snap = await getDoc(doc(db, 'users', uid))
    const d = snap.exists() ? snap.data() : {}
    const row = {
      avatar: d.avatar || null,
      displayName: (d.displayName && String(d.displayName).trim()) || '',
    }
    teacherCache.set(uid, row)
    teacherAvatar.value = row.avatar
    teacherDisplayName.value = row.displayName || fallbackName
  } catch {
    teacherCache.set(uid, { avatar: null, displayName: fallbackName })
    teacherAvatar.value = null
    teacherDisplayName.value = fallbackName
  }
}

watch(
  () => [props.quest?.teacherId, props.quest?.teacherName],
  () => {
    void hydrateTeacher()
  },
  { immediate: true },
)
</script>

<template>
  <div
    class="glass-card p-4 flex flex-col gap-3 transition-all"
    :class="completion?.status === 'approved' ? 'border-emerald-500/50 glow-xp' : ''"
  >
    <div class="flex items-start gap-3">
      <AvatarDisplay
        :avatar="teacherAvatar"
        :display-name="teacherDisplayName || quest.teacherName || 'Вчитель'"
        :items="userStore.items"
        size="xs"
        circle-only
        class="flex-shrink-0"
      />
      <div class="flex-1 min-w-0 flex gap-2 items-start">
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2 gap-y-1 mb-1">
            <span class="text-xs font-bold text-slate-300 leading-tight">
              {{ teacherDisplayName || quest.teacherName || 'Вчитель' }}
            </span>
            <span
              v-if="subjectLabel"
              class="text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-sky-500/15 text-sky-300"
            >{{ subjectLabel }}</span>
          </div>

          <div class="font-bold text-sm">{{ quest.title }}</div>
          <div v-if="quest.description" class="text-xs text-slate-400 mt-0.5">{{ quest.description }}</div>

          <div class="flex items-center gap-3 mt-1.5">
            <CoinDisplay :amount="quest.rewardCoins" :show-sign="true" size="sm" />
            <span class="inline-flex items-center gap-0.5 text-xs text-emerald-400 font-bold">
              <Zap :size="11" :stroke-width="2" />+{{ quest.rewardXp }}
            </span>
            <span
              v-if="quest.scope === 'class' && quest.rewardMode === 'first'"
              class="inline-flex items-center gap-1 text-xs text-slate-500"
            >
              <Trophy :size="11" :stroke-width="1.8" class="text-amber-600" /> Нагорода — першому
            </span>
            <span
              v-if="quest.firstCompletedBy && quest.rewardMode === 'first' && quest.firstCompletedBy !== studentId"
              class="text-xs text-slate-500"
            >· вже зайнято</span>
          </div>
        </div>

        <div v-if="completion" class="flex-shrink-0 self-start">
          <div
            v-if="completion.status === 'pending'"
            class="inline-flex items-center gap-1 text-[10px] font-extrabold bg-amber-500/15 text-amber-400 px-2 py-0.5 rounded-full"
          >
            <Clock :size="10" :stroke-width="2.5" /> Очікує
          </div>
          <div
            v-else-if="completion.status === 'approved'"
            class="inline-flex items-center justify-center rounded-full bg-emerald-500/15 text-emerald-400 p-1.5"
            title="Зараховано"
            aria-label="Зараховано"
          >
            <CheckCircle2 :size="14" :stroke-width="2.5" />
          </div>
          <div
            v-else-if="completion.status === 'rejected'"
            class="inline-flex items-center gap-1 text-[10px] font-extrabold bg-red-500/15 text-red-400 px-2 py-0.5 rounded-full"
          >
            <XCircle :size="10" :stroke-width="2.5" /> Відхилено
          </div>
        </div>
      </div>
    </div>

    <div v-if="!completion">
      <AppButton variant="primary" size="md" block @click="$emit('submit', quest)">
        <Upload :size="16" :stroke-width="2" /> Підтвердити виконання
      </AppButton>
    </div>
    <div v-else-if="completion?.status === 'pending'" class="text-xs text-slate-500 text-center py-1">
      Заявку надіслано — очікуй перевірки вчителя.
    </div>
    <div v-else-if="completion?.status === 'rejected'">
      <div class="text-xs text-slate-500 mb-2">Ваша заявка була відхилена. Спробуйте ще раз.</div>
      <AppButton variant="ghost" size="md" block @click="$emit('submit', quest)">
        <RefreshCw :size="16" :stroke-width="2" /> Надіслати знову
      </AppButton>
    </div>
  </div>
</template>
