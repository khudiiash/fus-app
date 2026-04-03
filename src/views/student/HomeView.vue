<script setup>
import { ref, computed, onMounted } from 'vue'
import { storeToRefs } from 'pinia'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useUserStore } from '@/stores/user'
import { useStudentFeedStore } from '@/stores/studentFeed'
import {
  getTransactionHistory,
  submitQuestCompletion,
  uploadQuestProof,
} from '@/firebase/collections'
import { enrichStudentFeedTransactions } from '@/composables/useTransactionFeed'
import HistoryTransactionCard from '@/components/feed/HistoryTransactionCard.vue'
import { useGameification } from '@/composables/useGameification'
import { useToast } from '@/composables/useToast'
import StreakWidget from '@/components/gamification/StreakWidget.vue'
import QuestCard from '@/components/gamification/QuestCard.vue'
import CoinDisplay from '@/components/gamification/CoinDisplay.vue'
import AppModal from '@/components/ui/AppModal.vue'
import AppButton from '@/components/ui/AppButton.vue'
import {
  Zap, ClipboardList, ScrollText, Activity, Inbox, Upload,
  RefreshCw, Paperclip, Send, Clock, CheckCircle2, XCircle, Trophy,
} from 'lucide-vue-next'
import { givenNameFromDisplayName } from '@/utils/personName'

const router  = useRouter()
const { success, error } = useToast()

const auth        = useAuthStore()
const userStore   = useUserStore()
const studentFeed = useStudentFeedStore()
const { teacherQuests, questCompletions: myCompletions } = storeToRefs(studentFeed)
const profile   = computed(() => auth.profile)

const { level, coins, streak } = useGameification(profile)

const history = ref([])

// ─── Submission modal ─────────────────────────────────────────────────────────
const showSubmit      = ref(false)
const submitQuest     = ref(null)
const proofText       = ref('')
const selectedFiles   = ref([])   // File[]
const uploadProgress  = ref(0)    // 0–100
const submitting      = ref(false)
const fileInputEl     = ref(null)

const MAX_FILE_SIZE = 20 * 1024 * 1024 // 20 MB

onMounted(async () => {
  await userStore.fetchQuests()
  if (auth.profile?.id) {
    if (!userStore.items.length) await userStore.fetchItems()
    const raw = await getTransactionHistory(auth.profile.id, 10)
    history.value = await enrichStudentFeedTransactions(raw, auth.profile.id)
  }
})

function completionFor(questId) {
  return myCompletions.value.find((c) => c.questId === questId) || null
}

function openSubmit(quest) {
  submitQuest.value  = quest
  proofText.value    = ''
  selectedFiles.value = []
  uploadProgress.value = 0
  showSubmit.value   = true
}

function onFileChange(e) {
  const files = Array.from(e.target.files || [])
  const oversized = files.filter(f => f.size > MAX_FILE_SIZE)
  if (oversized.length) {
    error(`Файл "${oversized[0].name}" перевищує ліміт 20 МБ`)
    e.target.value = ''
    return
  }
  selectedFiles.value = [...selectedFiles.value, ...files]
  e.target.value = ''
}

function removeFile(idx) {
  selectedFiles.value = selectedFiles.value.filter((_, i) => i !== idx)
}

async function doSubmit() {
  if (!proofText.value.trim() && selectedFiles.value.length === 0) {
    error('Додайте опис або прикріпіть файл')
    return
  }
  submitting.value = true
  uploadProgress.value = 0
  try {
    const uid      = auth.profile.id
    const questId  = submitQuest.value.id
    const total    = selectedFiles.value.length || 1
    const attachments = []

    for (const file of selectedFiles.value) {
      const meta = await uploadQuestProof(uid, questId, file)
      attachments.push(meta)
      uploadProgress.value = Math.round((attachments.length / total) * 100)
    }

    await submitQuestCompletion(
      questId,
      uid,
      auth.profile.displayName,
      proofText.value.trim(),
      attachments,
    )
    success('📤 Заявку надіслано! Чекайте підтвердження вчителя.')
    showSubmit.value = false
  } catch (e) {
    error(e.message)
  } finally {
    submitting.value = false
    uploadProgress.value = 0
  }
}

function fileIcon(type, name) {
  if (type?.startsWith('image/'))                                         return '🖼️'
  if (type === 'application/pdf')                                         return '📄'
  if (type?.includes('word') || /\.docx?$/i.test(name))                  return '📝'
  if (type?.includes('spreadsheet') || /\.xlsx?$/i.test(name))           return '📊'
  if (type?.includes('presentation') || /\.pptx?$/i.test(name))          return '📑'
  if (type?.startsWith('video/'))                                         return '🎬'
  if (type?.startsWith('audio/'))                                         return '🎵'
  if (/\.(zip|rar|7z|tar|gz)$/i.test(name))                              return '📦'
  return '📎'
}

function formatSize(bytes) {
  if (bytes < 1024)            return `${bytes} B`
  if (bytes < 1024 * 1024)     return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(ts) {
  if (!ts) return ''
  const d = ts.toDate ? ts.toDate() : new Date(ts)
  const now = new Date()
  const diff = (now - d) / 1000
  if (diff < 60)    return 'щойно'
  if (diff < 3600)  return `${Math.floor(diff / 60)} хв тому`
  if (diff < 86400) return `${Math.floor(diff / 3600)} год тому`
  return d.toLocaleDateString('uk-UA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}
</script>

<template>
  <div class="flex flex-col gap-4 animate-fade-in">
    <!-- Greeting -->
    <div>
      <div class="font-extrabold text-2xl gradient-heading">Привіт, {{ givenNameFromDisplayName(profile?.displayName) }}!</div>
      <div class="text-slate-500 text-sm mt-0.5">Заробимо сьогодні монети!</div>
    </div>

    <!-- Streak -->
    <StreakWidget :streak="streak" />

    <!-- Daily Quests -->
    <div>
      <div class="flex items-center justify-between mb-3">
        <div class="flex items-center gap-2">
          <Zap :size="18" :stroke-width="2" class="text-violet-400" />
          <h2 class="font-extrabold text-base">Щоденні завдання</h2>
        </div>
        <div class="text-xs text-slate-400">Оновлюються опівночі</div>
      </div>
      <div class="flex flex-col gap-3">
        <QuestCard v-for="quest in userStore.quests" :key="quest.type" :quest="quest" />
        <div v-if="userStore.quests.length === 0" class="text-center py-8 text-slate-600">
          <Zap :size="36" :stroke-width="1" class="mx-auto mb-2 opacity-30" />
          <div class="text-sm text-slate-500">Завдань поки немає. Заходь завтра!</div>
        </div>
      </div>
    </div>

    <!-- Teacher Quests -->
    <div v-if="teacherQuests.length > 0">
      <div class="flex items-center justify-between mb-3">
        <div class="flex items-center gap-2">
          <ClipboardList :size="18" :stroke-width="2" class="text-violet-400" />
          <h2 class="font-extrabold text-base">Завдання від вчителя</h2>
        </div>
      </div>
      <div class="flex flex-col gap-3">
        <div
          v-for="quest in teacherQuests"
          :key="quest.id"
          class="glass-card p-4 flex flex-col gap-3 transition-all"
          :class="completionFor(quest.id)?.status === 'approved' ? 'border-emerald-500/50 glow-xp' : ''"
        >
          <div class="flex items-start gap-3">
            <!-- Icon -->
            <div class="w-11 h-11 rounded-2xl flex-shrink-0 flex items-center justify-center"
              :class="completionFor(quest.id)?.status === 'approved' ? 'bg-emerald-500/[0.14]' : 'bg-violet-500/[0.12]'">
              <ScrollText :size="20" :stroke-width="1.8"
                :class="completionFor(quest.id)?.status === 'approved' ? 'text-emerald-400' : 'text-violet-400'" />
            </div>
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <div class="font-bold text-sm">{{ quest.title }}</div>
                <!-- Status badge -->
                <div v-if="completionFor(quest.id)?.status === 'pending'"
                  class="inline-flex items-center gap-1 text-[10px] font-extrabold bg-amber-500/15 text-amber-400 px-2 py-0.5 rounded-full flex-shrink-0">
                  <Clock :size="10" :stroke-width="2.5" /> Очікує
                </div>
                <div v-else-if="completionFor(quest.id)?.status === 'approved'"
                  class="inline-flex items-center gap-1 text-[10px] font-extrabold bg-emerald-500/15 text-emerald-400 px-2 py-0.5 rounded-full flex-shrink-0">
                  <CheckCircle2 :size="10" :stroke-width="2.5" /> ВИКОНАНО
                </div>
                <div v-else-if="completionFor(quest.id)?.status === 'rejected'"
                  class="inline-flex items-center gap-1 text-[10px] font-extrabold bg-red-500/15 text-red-400 px-2 py-0.5 rounded-full flex-shrink-0">
                  <XCircle :size="10" :stroke-width="2.5" /> Відхилено
                </div>
              </div>
              <div v-if="quest.description" class="text-xs text-slate-400 mt-0.5">{{ quest.description }}</div>

              <!-- Reward row -->
              <div class="flex items-center gap-3 mt-1.5">
                <CoinDisplay :amount="quest.rewardCoins" :show-sign="true" size="sm" />
                <span class="inline-flex items-center gap-0.5 text-xs text-emerald-400 font-bold">
                  <Zap :size="11" :stroke-width="2" />+{{ quest.rewardXp }}
                </span>
                <span v-if="quest.scope === 'class' && quest.rewardMode === 'first'" class="inline-flex items-center gap-1 text-xs text-slate-500">
                  <Trophy :size="11" :stroke-width="1.8" class="text-amber-600" /> Нагорода — першому
                </span>
                <span v-if="quest.firstCompletedBy && quest.rewardMode === 'first' && quest.firstCompletedBy !== auth.profile?.id"
                  class="text-xs text-slate-500">· вже зайнято</span>
              </div>
            </div>
          </div>

          <!-- Action -->
          <div v-if="!completionFor(quest.id)">
            <AppButton variant="primary" size="md" block @click="openSubmit(quest)">
              <Upload :size="16" :stroke-width="2" /> Підтвердити виконання
            </AppButton>
          </div>
          <div v-else-if="completionFor(quest.id)?.status === 'rejected'">
            <div class="text-xs text-slate-500 mb-2">Ваша заявка була відхилена. Спробуйте ще раз.</div>
            <AppButton variant="ghost" size="md" block @click="openSubmit(quest)">
              <RefreshCw :size="16" :stroke-width="2" /> Надіслати знову
            </AppButton>
          </div>
        </div>
      </div>
    </div>

    <!-- Recent Activity -->
    <div>
      <div class="flex items-center justify-between mb-3">
        <div class="flex items-center gap-2">
          <Activity :size="18" :stroke-width="2" class="text-violet-400" />
          <h2 class="font-extrabold text-base">Остання активність</h2>
        </div>
        <button class="text-xs text-violet-400 font-semibold" @click="router.push('/student/history')">
          Вся історія →
        </button>
      </div>
      <div v-if="history.length === 0" class="text-center py-8 text-slate-600">
        <Inbox :size="36" :stroke-width="1" class="mx-auto mb-2 opacity-30" />
        <div class="text-sm text-slate-500">Активності ще немає. Починай заробляти!</div>
      </div>
      <div v-else class="flex flex-col gap-2">
        <HistoryTransactionCard
          v-for="tx in history"
          :key="tx.id"
          :tx="tx"
          :items="userStore.items"
          compact
        >
          <template #time>{{ formatDate(tx.timestamp) }}</template>
        </HistoryTransactionCard>
      </div>
    </div>
  </div>

  <!-- Submit proof modal -->
  <AppModal v-model="showSubmit" :title="submitQuest?.title" size="lg">
    <div class="flex flex-col gap-4">
      <!-- Quest info -->
      <div v-if="submitQuest?.description" class="text-sm text-slate-400 bg-black/20 rounded-xl px-3 py-2">
        {{ submitQuest.description }}
      </div>
      <div class="flex items-center gap-3 text-sm">
        <CoinDisplay v-if="submitQuest" :amount="submitQuest.rewardCoins" :show-sign="true" size="md" />
        <span class="inline-flex items-center gap-0.5 text-emerald-400 font-bold">
          <Zap :size="13" :stroke-width="2" />+{{ submitQuest?.rewardXp }} XP
        </span>
      </div>

      <!-- Text proof -->
      <div>
        <label class="text-sm font-bold text-slate-300 block mb-2">Коментар (необов'язково)</label>
        <textarea
          v-model="proofText"
          rows="3"
          placeholder="Опишіть, що ви зробили..."
          class="w-full bg-game-bg border border-game-border rounded-xl px-4 py-2.5 text-sm font-semibold text-white placeholder-slate-500 focus:outline-none focus:border-violet-500 resize-none"
        />
      </div>

      <!-- File attachments -->
      <div>
        <label class="text-sm font-bold text-slate-300 block mb-2">Прикріпити файли</label>

        <!-- Hidden file input -->
        <input
          ref="fileInputEl"
          type="file"
          multiple
          class="hidden"
          @change="onFileChange"
        />

        <!-- Drop-zone / pick button -->
        <button
          type="button"
          class="w-full rounded-2xl py-4 px-4 flex flex-col items-center gap-2 text-slate-500 hover:text-violet-300 transition-all"
          style="border: 1.5px dashed rgba(139,92,246,0.25)"
          @click="fileInputEl.click()"
        >
          <Paperclip :size="22" :stroke-width="1.8" />
          <span class="text-xs font-semibold">Натисніть щоб обрати файли</span>
          <span class="text-[10px] text-slate-500">PNG, JPG, PDF, XLSX, PPTX та ін. · до 20 МБ кожен</span>
        </button>

        <!-- Selected files list -->
        <div v-if="selectedFiles.length > 0" class="mt-3 flex flex-col gap-2">
          <div
            v-for="(file, idx) in selectedFiles"
            :key="idx"
            class="flex items-center gap-3 bg-game-bg border border-game-border rounded-xl px-3 py-2"
          >
            <span class="text-xl flex-shrink-0">{{ fileIcon(file.type, file.name) }}</span>
            <div class="flex-1 min-w-0">
              <div class="text-sm font-semibold truncate">{{ file.name }}</div>
              <div class="text-xs text-slate-500">{{ formatSize(file.size) }}</div>
            </div>
            <button
              type="button"
              class="text-slate-500 hover:text-red-400 transition-colors flex-shrink-0 w-7 h-7 flex items-center justify-center rounded-lg hover:bg-red-500/10"
              @click="removeFile(idx)"
            >✕</button>
          </div>
        </div>
      </div>

      <!-- Upload progress bar -->
      <div v-if="submitting && selectedFiles.length > 0" class="flex flex-col gap-1">
        <div class="flex items-center justify-between text-xs text-slate-400">
          <span>Завантаження файлів...</span>
          <span>{{ uploadProgress }}%</span>
        </div>
        <div class="h-1.5 bg-game-bg rounded-full overflow-hidden">
          <div
            class="h-full bg-violet-500 rounded-full transition-all duration-300"
            :style="{ width: uploadProgress + '%' }"
          />
        </div>
      </div>

      <AppButton
        variant="primary"
        size="lg"
        block
        :loading="submitting"
        :disabled="!proofText.trim() && selectedFiles.length === 0"
        @click="doSubmit"
      >
        <Send :size="15" :stroke-width="2" /> Надіслати заявку
      </AppButton>
    </div>
  </AppModal>
</template>
