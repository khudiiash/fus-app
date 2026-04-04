<script setup>
import { ref, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { submitQuestCompletion, uploadQuestProof } from '@/firebase/collections'
import { useToast } from '@/composables/useToast'
import AppModal from '@/components/ui/AppModal.vue'
import AppButton from '@/components/ui/AppButton.vue'
import CoinDisplay from '@/components/gamification/CoinDisplay.vue'
import { Zap, Paperclip, Send } from 'lucide-vue-next'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  quest: { type: Object, default: null },
})

const emit = defineEmits(['update:modelValue', 'submitted'])

const auth = useAuthStore()
const { success, error } = useToast()

const proofText = ref('')
const selectedFiles = ref([])
const uploadProgress = ref(0)
const submitting = ref(false)
const fileInputEl = ref(null)

const MAX_FILE_SIZE = 20 * 1024 * 1024

watch(
  () => props.modelValue,
  (open) => {
    if (!open) return
    proofText.value = ''
    selectedFiles.value = []
    uploadProgress.value = 0
  },
)

function close() {
  emit('update:modelValue', false)
}

function onFileChange(e) {
  const files = Array.from(e.target.files || [])
  const oversized = files.filter((f) => f.size > MAX_FILE_SIZE)
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

function fileIcon(type, name) {
  if (type?.startsWith('image/')) return '🖼️'
  if (type === 'application/pdf') return '📄'
  if (type?.includes('word') || /\.docx?$/i.test(name)) return '📝'
  if (type?.includes('spreadsheet') || /\.xlsx?$/i.test(name)) return '📊'
  if (type?.includes('presentation') || /\.pptx?$/i.test(name)) return '📑'
  if (type?.startsWith('video/')) return '🎬'
  if (type?.startsWith('audio/')) return '🎵'
  if (/\.(zip|rar|7z|tar|gz)$/i.test(name)) return '📦'
  return '📎'
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

async function doSubmit() {
  if (!proofText.value.trim() && selectedFiles.value.length === 0) {
    error('Додайте опис або прикріпіть файл')
    return
  }
  const uid = auth.profile?.id
  if (!uid || !props.quest?.id) return

  submitting.value = true
  uploadProgress.value = 0
  try {
    const questId = props.quest.id
    const total = selectedFiles.value.length || 1
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
    close()
    emit('submitted')
  } catch (e) {
    error(e.message)
  } finally {
    submitting.value = false
    uploadProgress.value = 0
  }
}
</script>

<template>
  <AppModal :model-value="modelValue" :title="quest?.title" size="lg" @update:model-value="emit('update:modelValue', $event)">
    <div v-if="quest" class="flex flex-col gap-4">
      <div v-if="quest.description" class="text-sm text-slate-400 bg-black/20 rounded-xl px-3 py-2">
        {{ quest.description }}
      </div>
      <div class="flex items-center gap-3 text-sm">
        <CoinDisplay :amount="quest.rewardCoins" :show-sign="true" size="md" />
        <span class="inline-flex items-center gap-0.5 text-emerald-400 font-bold">
          <Zap :size="13" :stroke-width="2" />+{{ quest.rewardXp }} XP
        </span>
      </div>

      <div>
        <label class="text-sm font-bold text-slate-300 block mb-2">Коментар (необов'язково)</label>
        <textarea
          v-model="proofText"
          rows="3"
          placeholder="Опишіть, що ви зробили..."
          class="w-full bg-game-bg border border-game-border rounded-xl px-4 py-2.5 text-sm font-semibold text-white placeholder-slate-500 focus:outline-none focus:border-violet-500 resize-none"
        />
      </div>

      <div>
        <label class="text-sm font-bold text-slate-300 block mb-2">Прикріпити файли</label>
        <input ref="fileInputEl" type="file" multiple class="hidden" @change="onFileChange" />
        <button
          type="button"
          class="w-full rounded-2xl py-4 px-4 flex flex-col items-center gap-2 text-slate-500 hover:text-violet-300 transition-all"
          style="border: 1.5px dashed rgba(139,92,246,0.25)"
          @click="fileInputEl?.click()"
        >
          <Paperclip :size="22" :stroke-width="1.8" />
          <span class="text-xs font-semibold">Натисніть щоб обрати файли</span>
          <span class="text-[10px] text-slate-500">PNG, JPG, PDF, XLSX, PPTX та ін. · до 20 МБ кожен</span>
        </button>

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
