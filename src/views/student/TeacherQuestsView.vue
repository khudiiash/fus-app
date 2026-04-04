<script setup>
import { ref, computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useStudentFeedStore } from '@/stores/studentFeed'
import TeacherQuestAssignmentCard from '@/components/gamification/TeacherQuestAssignmentCard.vue'
import QuestSubmitProofModal from '@/components/gamification/QuestSubmitProofModal.vue'
import { ClipboardList } from 'lucide-vue-next'

const router = useRouter()
const auth = useAuthStore()
const studentFeed = useStudentFeedStore()
const { teacherQuests, questCompletions: myCompletions } = storeToRefs(studentFeed)

const showSubmit = ref(false)
const submitQuest = ref(null)
const activeTab = ref('new') // 'new' | 'completed'

const SUBJECT_FALLBACK = 'Без предмета'

function completionFor(questId) {
  return myCompletions.value.find((c) => c.questId === questId) || null
}

function questCreatedMs(q) {
  return q.createdAt?.seconds ?? q.createdAt?._seconds ?? 0
}

function sortQuestsNewestFirst(a, b) {
  return questCreatedMs(b) - questCreatedMs(a)
}

const newQuestsSorted = computed(() =>
  teacherQuests.value
    .filter((q) => completionFor(q.id)?.status !== 'approved')
    .sort(sortQuestsNewestFirst),
)

const completedQuestsSorted = computed(() =>
  teacherQuests.value
    .filter((q) => completionFor(q.id)?.status === 'approved')
    .sort(sortQuestsNewestFirst),
)

/**
 * Групи за назвою предмета (subjectName з квесту). Старі квести без поля — у «Без предмета».
 */
function groupBySubject(quests) {
  const map = new Map()
  for (const q of quests) {
    const raw = q.subjectName != null ? String(q.subjectName).trim() : ''
    const label = raw || SUBJECT_FALLBACK
    if (!map.has(label)) map.set(label, [])
    map.get(label).push(q)
  }
  const groups = [...map.entries()].map(([subjectLabel, list]) => ({
    subjectLabel,
    quests: list.sort(sortQuestsNewestFirst),
  }))
  groups.sort((a, b) => {
    if (a.subjectLabel === SUBJECT_FALLBACK) return 1
    if (b.subjectLabel === SUBJECT_FALLBACK) return -1
    return a.subjectLabel.localeCompare(b.subjectLabel, 'uk')
  })
  return groups
}

const newGrouped = computed(() => groupBySubject(newQuestsSorted.value))
const completedGrouped = computed(() => groupBySubject(completedQuestsSorted.value))

const currentGroups = computed(() =>
  activeTab.value === 'completed' ? completedGrouped.value : newGrouped.value,
)

function openSubmit(quest) {
  submitQuest.value = quest
  showSubmit.value = true
}
</script>

<template>
  <div class="flex flex-col gap-4 animate-fade-in">
    <div class="flex items-center gap-2">
      <button
        type="button"
        class="text-sm text-violet-400 font-semibold -ml-1 px-1 py-0.5 rounded-lg hover:bg-violet-500/10"
        @click="router.push('/student')"
      >
        ← Головна
      </button>
    </div>

    <div class="flex items-center gap-2">
      <ClipboardList :size="22" :stroke-width="2" class="text-violet-400" />
      <h1 class="text-xl font-extrabold gradient-heading">Завдання від вчителя</h1>
    </div>

    <!-- Tabs: нові / виконані -->
    <div class="flex p-1 rounded-2xl gap-0.5" style="background: rgba(255, 255, 255, 0.05)">
      <button
        type="button"
        class="flex-1 py-2.5 rounded-xl text-sm font-bold transition-all duration-200"
        :class="activeTab === 'new' ? 'tab-active' : 'text-slate-500 hover:text-slate-300'"
        @click="activeTab = 'new'"
      >
        Нові
      </button>
      <button
        type="button"
        class="flex-1 py-2.5 rounded-xl text-sm font-bold transition-all duration-200"
        :class="activeTab === 'completed' ? 'tab-active' : 'text-slate-500 hover:text-slate-300'"
        @click="activeTab = 'completed'"
      >
        Виконані
      </button>
    </div>

    <div v-if="teacherQuests.length === 0" class="text-center py-16 text-slate-600">
      <ClipboardList :size="44" :stroke-width="1" class="mx-auto mb-3 opacity-30" />
      <div class="font-bold text-slate-500">Завдань немає</div>
      <div class="text-sm mt-1">Коли вчитель додасть завдання, воно з’явиться тут.</div>
    </div>

    <template v-else>
      <div
        v-if="activeTab === 'new' && newQuestsSorted.length === 0"
        class="text-center py-12 text-slate-600 text-sm"
      >
        Немає нових завдань. Переглянь вкладку «Виконані» або зачекай на нове від вчителя.
      </div>
      <div
        v-else-if="activeTab === 'completed' && completedQuestsSorted.length === 0"
        class="text-center py-12 text-slate-600 text-sm"
      >
        Ще нічого не зараховано вчителем.
      </div>

      <div v-else class="flex flex-col gap-6">
        <section
          v-for="group in currentGroups"
          :key="activeTab + '-' + group.subjectLabel"
          class="flex flex-col gap-3"
        >
          <h2 class="text-xs font-extrabold text-slate-500 uppercase tracking-wider px-0.5">
            {{ group.subjectLabel }}
          </h2>
          <div class="flex flex-col gap-3">
            <TeacherQuestAssignmentCard
              v-for="quest in group.quests"
              :key="quest.id"
              :quest="quest"
              :completion="completionFor(quest.id)"
              :student-id="auth.profile?.id || ''"
              @submit="openSubmit"
            />
          </div>
        </section>
      </div>
    </template>

    <QuestSubmitProofModal v-model="showSubmit" :quest="submitQuest" />
  </div>
</template>
