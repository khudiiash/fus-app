<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import {
  getClass, getUsersByClass, getAllSubjects,
  createQuest, cancelQuest, getQuestsByTeacher,
  getQuestCompletions, approveQuestCompletion, rejectQuestCompletion,
  getTeacherBudgetInfo,
} from '@/firebase/collections'
import AppButton from '@/components/ui/AppButton.vue'
import AppModal from '@/components/ui/AppModal.vue'
import AppInput from '@/components/ui/AppInput.vue'
import AvatarDisplay from '@/components/avatar/AvatarDisplay.vue'
import { useToast } from '@/composables/useToast'
import {
  ScrollText, Wallet, Coins, School, User, Users, Trophy, Clock, Inbox,
  CheckCircle2, XCircle, ChevronDown, ChevronUp, X, Plus, TriangleAlert, Zap,
} from 'lucide-vue-next'

const auth = useAuthStore()
const { success, error } = useToast()

const quests        = ref([])
const classes       = ref([])
const modalStudents = ref([])
const teacherSubjects = ref([])
const loading       = ref(false)

// ─── Create-quest modal ───────────────────────────────────────────────────────
const showCreate  = ref(false)
const creating    = ref(false)
const form = ref({
  title:       '',
  description: '',
  subjectId:   '',
  scope:       'class',   // 'class' | 'student'
  classId:     '',
  studentId:   '',
  rewardMode:  'all',     // 'all' | 'first'  (class scope only)
  rewardCoins: 20,
  rewardXp:    50,
})

// ─── Completions panel ────────────────────────────────────────────────────────
const expandedId    = ref(null)
const completions   = ref({})   // questId → []
const processing    = ref(null) // completionId being approved/rejected

const statusFilter = ref('active')  // 'active' | 'cancelled' | 'all'
const budgetInfo   = computed(() => getTeacherBudgetInfo(auth.profile))

const filteredQuests = computed(() => {
  if (statusFilter.value === 'all') return quests.value
  return quests.value.filter(q => q.status === statusFilter.value)
})

const pendingCount = computed(() =>
  Object.values(completions.value).flat().filter(c => c.status === 'pending').length
)

// ─── Lifecycle ────────────────────────────────────────────────────────────────
onMounted(async () => {
  const ids = auth.profile?.classIds || []
  const all = await Promise.all(ids.map(id => getClass(id)))
  classes.value = all.filter(Boolean)
  if (classes.value.length) form.value.classId = classes.value[0].id

  const subjIds = auth.profile?.subjectIds || []
  try {
    const allSub = await getAllSubjects()
    teacherSubjects.value = subjIds.length
      ? allSub.filter((s) => subjIds.includes(s.id))
      : allSub
  } catch {
    teacherSubjects.value = []
  }

  await fetchQuests()
})

async function fetchQuests() {
  loading.value = true
  try {
    quests.value = await getQuestsByTeacher(auth.profile.id)
    // Pre-load completions for all quests
    await Promise.all(quests.value.map(q => loadCompletions(q.id)))
  } finally {
    loading.value = false
  }
}

async function loadCompletions(questId) {
  const list = await getQuestCompletions(questId)
  completions.value = { ...completions.value, [questId]: list }
}

// ─── Class → students for "for student" scope ─────────────────────────────────
watch(() => form.value.classId, async (id) => {
  if (!id) { modalStudents.value = []; return }
  modalStudents.value = await getUsersByClass(id)
  if (modalStudents.value.length) form.value.studentId = modalStudents.value[0].id
})

watch(() => form.value.scope, (s) => {
  if (s === 'class') form.value.studentId = ''
})

// ─── Create quest ─────────────────────────────────────────────────────────────
function openCreate() {
  form.value = {
    title: '', description: '', subjectId: '', scope: 'class',
    classId: classes.value[0]?.id || '',
    studentId: '',
    rewardMode: 'all',
    rewardCoins: 20, rewardXp: 50,
  }
  showCreate.value = true
}

function selectedSubjectMeta() {
  const id = form.value.subjectId
  if (!id) return { subjectId: null, subjectName: null }
  const s = teacherSubjects.value.find((x) => x.id === id)
  return { subjectId: id, subjectName: s?.name || null }
}

async function doCreate() {
  if (!form.value.title.trim()) { error('Введіть назву завдання'); return }
  if (form.value.scope === 'student' && !form.value.studentId) { error('Оберіть учня'); return }
  if (form.value.scope === 'class'   && !form.value.classId)   { error('Оберіть клас');  return }

  creating.value = true
  try {
    const sub = selectedSubjectMeta()
    await createQuest({
      teacherId:   auth.profile.id,
      teacherName: auth.profile.displayName,
      title:       form.value.title.trim(),
      description: form.value.description.trim(),
      subjectId:   sub.subjectId,
      subjectName: sub.subjectName,
      scope:       form.value.scope,
      classId:     form.value.scope === 'class'   ? form.value.classId   : null,
      studentId:   form.value.scope === 'student' ? form.value.studentId : null,
      rewardMode:  form.value.scope === 'class'   ? form.value.rewardMode : 'all',
      rewardCoins: Number(form.value.rewardCoins) || 0,
      rewardXp:    Number(form.value.rewardXp)    || 0,
    })
    success('📜 Завдання створено!')
    showCreate.value = false
    await fetchQuests()
  } catch (e) {
    error(e.message)
  } finally {
    creating.value = false
  }
}

async function doCancel(questId) {
  if (!confirm('Скасувати завдання?')) return
  await cancelQuest(questId)
  await fetchQuests()
  success('Завдання скасовано')
}

// ─── Expand / collapse completions ───────────────────────────────────────────
function toggleExpand(questId) {
  expandedId.value = expandedId.value === questId ? null : questId
}

// ─── Approve / reject ─────────────────────────────────────────────────────────
async function approve(completion, quest) {
  processing.value = completion.id
  try {
    const alreadyClaimed = quest.firstCompletedBy && quest.rewardMode === 'first'
    if (alreadyClaimed) {
      if (!confirm(`Завдання типу "перший" вже виконане учнем ${quest.firstCompletedBy}. Все одно нарахувати нагороду?`)) {
        processing.value = null
        return
      }
    }
    await approveQuestCompletion(completion.id, quest.id, {
      teacherId:  auth.profile.id,
      studentId:  completion.studentId,
      questTitle: quest.title,
      coins:      quest.rewardCoins,
      xp:         quest.rewardXp,
    })
    success(`✅ ${completion.studentName} — нагороду нараховано!`)
    await loadCompletions(quest.id)
    await fetchQuests()
  } catch (e) {
    error(e.message)
  } finally {
    processing.value = null
  }
}

async function reject(completionId, questId) {
  processing.value = completionId
  try {
    await rejectQuestCompletion(completionId)
    success('Заявку відхилено')
    await loadCompletions(questId)
  } catch (e) {
    error(e.message)
  } finally {
    processing.value = null
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function className(classId) {
  return classes.value.find(c => c.id === classId)?.name || classId
}

function pendingFor(questId) {
  return (completions.value[questId] || []).filter(c => c.status === 'pending').length
}

function formatTs(ts) {
  if (!ts) return ''
  const d = ts.toDate ? ts.toDate() : new Date(ts)
  return d.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function fileIcon(type, name) {
  if (type?.startsWith('image/'))                               return '🖼️'
  if (type === 'application/pdf')                               return '📄'
  if (type?.includes('word') || /\.docx?$/i.test(name))        return '📝'
  if (type?.includes('spreadsheet') || /\.xlsx?$/i.test(name)) return '📊'
  if (type?.includes('presentation') || /\.pptx?$/i.test(name))return '📑'
  if (type?.startsWith('video/'))                               return '🎬'
  if (type?.startsWith('audio/'))                               return '🎵'
  if (/\.(zip|rar|7z|tar|gz)$/i.test(name))                    return '📦'
  return '📎'
}

function formatSize(bytes) {
  if (!bytes) return ''
  if (bytes < 1024)        return `${bytes} B`
  if (bytes < 1048576)     return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1048576).toFixed(1)} MB`
}

function isImage(type) {
  return type?.startsWith('image/')
}
</script>

<template>
  <div class="flex flex-col gap-4 animate-fade-in">
    <!-- Header -->
    <div class="flex items-start justify-between gap-3 flex-wrap">
      <div>
        <div class="flex items-center gap-2 mb-0.5">
          <ScrollText :size="20" :stroke-width="2" class="text-amber-500" />
          <h1 class="text-2xl font-extrabold gradient-heading">Завдання</h1>
        </div>
        <p class="text-slate-500 text-sm">Створюйте завдання для класів або окремих учнів</p>
      </div>
      <div class="flex items-center gap-2 flex-wrap justify-end">
        <!-- Budget chip -->
        <div
          class="flex items-center gap-1.5 text-xs font-extrabold px-3 py-1.5 rounded-2xl"
          :class="budgetInfo.remaining < 50 ? 'bg-red-500/10 text-red-400'
                : budgetInfo.remaining < 150 ? 'bg-amber-500/10 text-amber-400'
                : 'bg-emerald-500/10 text-emerald-400'"
        >
          <Wallet :size="12" :stroke-width="2" />
          {{ budgetInfo.remaining }} / {{ budgetInfo.budget }}
          <Coins :size="11" :stroke-width="2" />
        </div>
        <div v-if="pendingCount > 0" class="bg-amber-500 text-slate-900 font-extrabold text-xs px-2.5 py-1 rounded-full animate-pulse">
          {{ pendingCount }} нових
        </div>
        <AppButton variant="primary" size="sm" @click="openCreate">
          <Plus :size="14" :stroke-width="2.5" /> Нове завдання
        </AppButton>
      </div>
    </div>

    <!-- Filter tabs -->
    <div class="flex p-1 rounded-2xl" style="background:rgba(255,255,255,0.05)">
      <button
        v-for="f in [['active','Активні'],['all','Усі'],['cancelled','Скасовані']]"
        :key="f[0]"
        class="flex-1 py-1.5 rounded-xl text-sm font-bold transition-all duration-200"
        :class="statusFilter === f[0] ? 'tab-active' : 'text-slate-500 hover:text-slate-300'"
        @click="statusFilter = f[0]"
      >{{ f[1] }}</button>
    </div>

    <!-- Empty state -->
    <div v-if="loading" class="text-center py-16 text-slate-600">
      <Clock :size="44" :stroke-width="1" class="mx-auto mb-3 opacity-30" />
      <div class="text-sm">Завантаження...</div>
    </div>
    <div v-else-if="filteredQuests.length === 0" class="text-center py-16 text-slate-600">
      <Inbox :size="48" :stroke-width="1" class="mx-auto mb-3 opacity-30" />
      <div class="font-bold text-slate-500">Завдань немає</div>
      <div class="text-sm mt-1">Натисніть «Нове завдання», щоб розпочати</div>
    </div>

    <!-- Quest list -->
    <div v-else class="flex flex-col gap-3">
      <div
        v-for="quest in filteredQuests"
        :key="quest.id"
        class="glass-card overflow-hidden transition-all"
        :class="quest.status === 'cancelled' ? 'opacity-60' : ''"
      >
        <!-- Quest header -->
        <div class="p-4 cursor-pointer" @click="toggleExpand(quest.id)">
          <div class="flex items-start gap-3">
            <!-- Icon -->
            <div class="w-10 h-10 rounded-xl flex-shrink-0 flex items-center justify-center"
              :class="quest.status === 'active' ? 'bg-violet-500/15 text-violet-400' : 'bg-slate-700/30 text-slate-500'">
              <component :is="quest.scope === 'class' ? School : User" :size="18" :stroke-width="1.8" />
            </div>

            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <div class="font-extrabold truncate">{{ quest.title }}</div>
                <!-- Pending badge -->
                <div v-if="pendingFor(quest.id) > 0"
                  class="bg-amber-500 text-slate-900 font-extrabold text-[10px] px-2 py-0.5 rounded-full flex-shrink-0">
                  {{ pendingFor(quest.id) }} нових
                </div>
                <div v-if="quest.status === 'cancelled'" class="text-[10px] font-bold text-slate-500 bg-slate-700/40 px-2 py-0.5 rounded-full">СКАСОВАНО</div>
              </div>

              <div v-if="quest.description" class="text-sm text-slate-400 mt-0.5 line-clamp-2">{{ quest.description }}</div>

              <!-- Meta row -->
              <div class="flex items-center gap-2 mt-2 flex-wrap">
                <span
                  v-if="quest.subjectName"
                  class="text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-sky-500/15 text-sky-300"
                >{{ quest.subjectName }}</span>
                <span class="flex items-center gap-0.5 text-xs text-violet-300 font-bold">
                  <component :is="quest.scope === 'class' ? School : User" :size="10" :stroke-width="2" />
                  {{ quest.scope === 'class' ? className(quest.classId) : 'Індивідуальне' }}
                </span>
                <span v-if="quest.scope === 'class'" class="flex items-center gap-0.5 text-xs font-bold"
                  :class="quest.rewardMode === 'first' ? 'text-amber-400' : 'text-emerald-400'">
                  <component :is="quest.rewardMode === 'first' ? Trophy : Users" :size="10" :stroke-width="2" />
                  {{ quest.rewardMode === 'first' ? 'Перший' : 'Всі' }}
                </span>
                <span class="flex items-center gap-0.5 text-xs text-amber-400 font-bold">
                  <Coins :size="10" :stroke-width="2" />{{ quest.rewardCoins }}
                </span>
                <span class="flex items-center gap-0.5 text-xs text-emerald-400 font-bold">
                  <Zap :size="10" :stroke-width="2" />{{ quest.rewardXp }} XP
                </span>
                <span v-if="quest.firstCompletedBy" class="flex items-center gap-0.5 text-xs text-slate-500">
                  <CheckCircle2 :size="10" :stroke-width="2" /> Виконано
                </span>
              </div>
            </div>

            <!-- Right: expand arrow + cancel -->
            <div class="flex items-center gap-2 flex-shrink-0">
              <button
                v-if="quest.status === 'active'"
                class="w-7 h-7 flex items-center justify-center rounded-lg text-slate-500 hover:text-red-400 hover:bg-red-500/10 transition-all"
                @click.stop="doCancel(quest.id)"
              >
                <X :size="14" :stroke-width="2" />
              </button>
              <div class="w-7 h-7 flex items-center justify-center text-slate-500 transition-transform duration-200" :class="expandedId === quest.id ? 'rotate-180' : ''">
                <ChevronDown :size="16" :stroke-width="2" />
              </div>
            </div>
          </div>
        </div>

        <!-- Completions panel -->
        <div v-if="expandedId === quest.id" class="border-t border-game-border">
          <div class="p-4">
            <div class="text-sm font-extrabold text-slate-300 mb-3">Заявки на виконання</div>

            <div v-if="!(completions[quest.id]?.length)" class="flex flex-col items-center py-6 text-slate-600 text-sm gap-2">
              <Clock :size="28" :stroke-width="1" class="opacity-30" />
              Заявок ще немає
            </div>

            <div v-else class="flex flex-col gap-3">
              <div
                v-for="c in completions[quest.id]"
                :key="c.id"
                class="rounded-xl p-3 flex flex-col gap-2"
                :class="{
                  'bg-amber-500/10 border border-amber-500/30': c.status === 'pending',
                  'bg-emerald-500/10 border border-emerald-500/30': c.status === 'approved',
                  'bg-slate-700/30 border border-slate-600/30': c.status === 'rejected',
                }"
              >
                <div class="flex items-center gap-2">
                  <div class="font-bold text-sm flex-1">{{ c.studentName }}</div>
                  <div class="text-[10px] font-extrabold px-2 py-0.5 rounded-full flex-shrink-0"
                    :class="{
                      'bg-amber-500/20 text-amber-400': c.status === 'pending',
                      'bg-emerald-500/20 text-emerald-400': c.status === 'approved',
                      'bg-slate-600/20 text-slate-400': c.status === 'rejected',
                    }">
                    <span v-if="c.status === 'pending'" class="flex items-center gap-0.5"><Clock :size="10" :stroke-width="2" /> Очікує</span>
                    <span v-else-if="c.status === 'approved'" class="flex items-center gap-0.5"><CheckCircle2 :size="10" :stroke-width="2" /> Підтверджено</span>
                    <span v-else class="flex items-center gap-0.5"><XCircle :size="10" :stroke-width="2" /> Відхилено</span>
                  </div>
                </div>

                <!-- Text proof -->
                <div v-if="c.proof" class="text-sm text-slate-300 bg-black/20 rounded-lg px-3 py-2 italic">"{{ c.proof }}"</div>

                <!-- File attachments -->
                <div v-if="c.attachments?.length" class="flex flex-col gap-2">
                  <div
                    v-for="(att, ai) in c.attachments"
                    :key="ai"
                    class="rounded-xl overflow-hidden border border-game-border"
                  >
                    <!-- Image preview -->
                    <a v-if="isImage(att.type)" :href="att.url" target="_blank" rel="noopener">
                      <img :src="att.url" :alt="att.name" class="w-full max-h-48 object-contain bg-black/30" />
                    </a>
                    <!-- Non-image file row -->
                    <a
                      v-else
                      :href="att.url"
                      target="_blank"
                      rel="noopener"
                      class="flex items-center gap-3 px-3 py-2.5 hover:bg-white/5 transition-colors"
                    >
                      <span class="text-2xl flex-shrink-0">{{ fileIcon(att.type, att.name) }}</span>
                      <div class="flex-1 min-w-0">
                        <div class="text-sm font-semibold truncate text-white">{{ att.name }}</div>
                        <div class="text-xs text-slate-500">{{ formatSize(att.size) }}</div>
                      </div>
                      <span class="text-xs text-violet-400 font-bold flex-shrink-0">Завантажити</span>
                    </a>
                    <!-- Image filename footer -->
                    <div v-if="isImage(att.type)" class="flex items-center gap-2 px-3 py-1.5 bg-black/20">
                      <span class="text-xs text-slate-400 flex-1 truncate">{{ att.name }}</span>
                      <a :href="att.url" target="_blank" rel="noopener" class="text-xs text-violet-400 font-bold flex-shrink-0">Відкрити</a>
                    </div>
                  </div>
                </div>

                <div class="text-xs text-slate-500">{{ formatTs(c.submittedAt) }}</div>

                <!-- Actions for pending -->
                <div v-if="c.status === 'pending'" class="flex flex-col gap-2 mt-1">
                  <div v-if="quest.rewardCoins > budgetInfo.remaining"
                    class="flex items-center gap-1.5 text-xs text-red-400 font-bold bg-red-500/10 px-3 py-1.5 rounded-lg">
                    <TriangleAlert :size="12" :stroke-width="2" /> Недостатньо бюджету (залишок: {{ budgetInfo.remaining }})
                  </div>
                  <div class="flex gap-2">
                    <AppButton
                      variant="xp"
                      size="sm"
                      class="flex-1"
                      :loading="processing === c.id"
                      :disabled="quest.rewardCoins > budgetInfo.remaining"
                      @click="approve(c, quest)"
                    >
                      <CheckCircle2 :size="13" :stroke-width="2.5" />
                      +{{ quest.rewardCoins }} / +{{ quest.rewardXp }} XP
                    </AppButton>
                    <AppButton
                      variant="ghost"
                      size="sm"
                      :loading="processing === c.id"
                      @click="reject(c.id, quest.id)"
                    >
                      <XCircle :size="14" :stroke-width="2" />
                    </AppButton>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Create quest modal -->
    <AppModal v-model="showCreate" title="Нове завдання" size="lg">
      <div class="flex flex-col gap-4">
        <AppInput v-model="form.title" label="Назва завдання" placeholder="напр. Прочитати розділ 5..." />

        <div>
          <label class="text-sm font-bold text-slate-300 block mb-2">Опис (необов'язково)</label>
          <textarea
            v-model="form.description"
            rows="3"
            placeholder="Детальний опис того, що потрібно зробити..."
            class="w-full bg-game-bg border border-game-border rounded-xl px-4 py-2.5 text-sm font-semibold text-white placeholder-slate-500 focus:outline-none focus:border-violet-500 resize-none"
          />
        </div>

        <div v-if="teacherSubjects.length > 0">
          <label class="text-sm font-bold text-slate-300 block mb-2">Предмет (необов’язково)</label>
          <select
            v-model="form.subjectId"
            class="w-full bg-game-bg border border-game-border rounded-xl px-4 py-2.5 text-sm font-bold text-white focus:outline-none focus:border-violet-500"
          >
            <option value="">— Без предмета —</option>
            <option v-for="s in teacherSubjects" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select>
        </div>

        <!-- Scope toggle -->
        <div>
          <label class="text-sm font-bold text-slate-300 block mb-2">Для кого</label>
          <div class="flex p-1 bg-game-bg rounded-xl">
            <button
              class="flex-1 py-2 rounded-lg text-sm font-bold transition-all"
              :class="form.scope === 'class' ? 'bg-violet-600 text-white' : 'text-slate-400'"
              @click="form.scope = 'class'"
            >
              <School :size="14" :stroke-width="1.8" class="inline mr-1" />Для класу
            </button>
            <button
              class="flex-1 py-2 rounded-lg text-sm font-bold transition-all"
              :class="form.scope === 'student' ? 'bg-violet-600 text-white' : 'text-slate-400'"
              @click="form.scope = 'student'"
            >
              <User :size="14" :stroke-width="1.8" class="inline mr-1" />Для учня
            </button>
          </div>
        </div>

        <!-- Class selector -->
        <div v-if="classes.length > 0">
          <label class="text-sm font-bold text-slate-300 block mb-2">Клас</label>
          <select
            v-model="form.classId"
            class="w-full bg-game-bg border border-game-border rounded-xl px-4 py-2.5 text-sm font-bold text-white focus:outline-none focus:border-violet-500"
          >
            <option v-for="c in classes" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
        </div>

        <!-- Student selector (only when scope=student) -->
        <div v-if="form.scope === 'student' && modalStudents.length > 0">
          <label class="text-sm font-bold text-slate-300 block mb-2">Учень</label>
          <select
            v-model="form.studentId"
            class="w-full bg-game-bg border border-game-border rounded-xl px-4 py-2.5 text-sm font-bold text-white focus:outline-none focus:border-violet-500"
          >
            <option v-for="s in modalStudents" :key="s.id" :value="s.id">{{ s.displayName }}</option>
          </select>
        </div>

        <!-- Reward mode (class quests only) -->
        <div v-if="form.scope === 'class'">
          <label class="text-sm font-bold text-slate-300 block mb-2">Нагорода дістається</label>
          <div class="flex p-1 bg-game-bg rounded-xl">
            <button
              class="flex-1 py-2 rounded-lg text-sm font-bold transition-all"
              :class="form.rewardMode === 'all' ? 'bg-emerald-600 text-white' : 'text-slate-400'"
              @click="form.rewardMode = 'all'"
            >
              <Users :size="14" :stroke-width="1.8" class="inline mr-1" />Усім виконавцям
            </button>
            <button
              class="flex-1 py-2 rounded-lg text-sm font-bold transition-all"
              :class="form.rewardMode === 'first' ? 'bg-amber-600 text-white' : 'text-slate-400'"
              @click="form.rewardMode = 'first'"
            >
              <Trophy :size="14" :stroke-width="1.8" class="inline mr-1" />Першому виконавцю
            </button>
          </div>
        </div>

        <!-- Rewards -->
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="text-sm font-bold text-slate-300 flex items-center gap-1.5 mb-2">
              Нагорода <Coins :size="13" :stroke-width="2" class="text-coin" />
            </label>
            <input
              v-model="form.rewardCoins"
              type="number"
              min="0"
              class="w-full bg-game-bg border border-game-border rounded-xl px-4 py-3 text-center text-xl font-extrabold text-amber-400 focus:outline-none focus:border-amber-500"
            />
          </div>
          <div>
            <label class="text-sm font-bold text-slate-300 flex items-center gap-1.5 mb-2">
              Нагорода <Zap :size="13" :stroke-width="2" class="text-xp" /> XP
            </label>
            <input
              v-model="form.rewardXp"
              type="number"
              min="0"
              class="w-full bg-game-bg border border-game-border rounded-xl px-4 py-3 text-center text-xl font-extrabold text-emerald-400 focus:outline-none focus:border-emerald-500"
            />
          </div>
        </div>

        <AppButton variant="primary" size="lg" block :loading="creating" @click="doCreate">
          <ScrollText :size="15" :stroke-width="2" /> Створити завдання
        </AppButton>
      </div>
    </AppModal>
  </div>
</template>
