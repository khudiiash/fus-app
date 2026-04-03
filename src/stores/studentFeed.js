import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useAuthStore } from './auth'
import {
  watchMergedActiveQuests,
  watchStudentQuestCompletions,
  watchIncomingTransactionsForStudent,
} from '@/firebase/collections'
import { trySystemNotify } from '@/utils/systemNotify'
import { useToast } from '@/composables/useToast'

function sortCompletionsDesc(list) {
  return list.slice().sort((a, b) => {
    const ta = a.submittedAt?.seconds ?? a.submittedAt?._seconds ?? 0
    const tb = b.submittedAt?.seconds ?? b.submittedAt?._seconds ?? 0
    return tb - ta
  })
}

/**
 * Реалтайм-стрічка для учня: завдання вчителя, рішення по заявках, нагороди/штрафи.
 * + toast і системні сповіщення (як у trade store), без серверного FCM.
 */
export const useStudentFeedStore = defineStore('studentFeed', () => {
  const teacherQuests = ref([])
  const questCompletions = ref([])

  const { info: toastInfo } = useToast()

  let unsubQuests = null
  let unsubCompletions = null
  let unsubTx = null

  let skipQuestNotify = true
  let prevQuestIds = new Set()

  let skipCompletionNotify = true
  const prevCompletionStatus = new Map()

  let skipTxNotify = true
  let prevTxIds = new Set()

  function teardown() {
    if (unsubQuests) {
      unsubQuests()
      unsubQuests = null
    }
    if (unsubCompletions) {
      unsubCompletions()
      unsubCompletions = null
    }
    if (unsubTx) {
      unsubTx()
      unsubTx = null
    }
    skipQuestNotify = true
    prevQuestIds = new Set()
    skipCompletionNotify = true
    prevCompletionStatus.clear()
    skipTxNotify = true
    prevTxIds = new Set()
    teacherQuests.value = []
    questCompletions.value = []
  }

  function init() {
    const auth = useAuthStore()
    if (!auth.profile?.id || auth.profile.role !== 'student') return

    teardown()

    const uid = auth.profile.id
    const classId = auth.profile.classId || null

    unsubQuests = watchMergedActiveQuests(uid, classId, (list) => {
      const ids = new Set(list.map((q) => q.id))
      if (skipQuestNotify) {
        skipQuestNotify = false
        prevQuestIds = ids
        teacherQuests.value = list
        return
      }
      for (const q of list) {
        if (!prevQuestIds.has(q.id)) {
          const who = q.teacherName ? ` (${q.teacherName})` : ''
          void trySystemNotify('Нове завдання від вчителя', `${q.title}${who}`, { tag: `quest-${q.id}` })
          toastInfo(`Нове завдання: ${q.title}`)
        }
      }
      prevQuestIds = ids
      teacherQuests.value = list
    })

    unsubCompletions = watchStudentQuestCompletions(uid, (list) => {
      const sorted = sortCompletionsDesc(list)
      if (skipCompletionNotify) {
        skipCompletionNotify = false
        for (const c of sorted) prevCompletionStatus.set(c.id, c.status)
        questCompletions.value = sorted
        return
      }
      for (const c of sorted) {
        const prev = prevCompletionStatus.get(c.id)
        if (c.status === 'approved' && prev === 'pending') {
          void trySystemNotify('Завдання зараховано', 'Нагорода вже на балансі', { tag: `qcomp-${c.id}` })
          toastInfo('Вчитель зарахував завдання!')
        }
        if (c.status === 'rejected' && prev === 'pending') {
          void trySystemNotify('Відповідь не прийнято', 'Можна надіслати нову на «Головній»', { tag: `qcomp-${c.id}` })
          toastInfo('Заявку на завдання відхилено')
        }
      }
      for (const c of sorted) prevCompletionStatus.set(c.id, c.status)
      questCompletions.value = sorted
    })

    unsubTx = watchIncomingTransactionsForStudent(uid, (rows) => {
      const ids = new Set(rows.map((r) => r.id))
      if (skipTxNotify) {
        skipTxNotify = false
        prevTxIds = ids
        return
      }
      for (const row of rows) {
        if (prevTxIds.has(row.id)) continue
        const t = row.type
        if (t === 'award') {
          const note = row.note ? String(row.note).slice(0, 120) : `+${row.amount ?? ''} монет`
          void trySystemNotify('Нагорода від вчителя', note, { tag: `tx-${row.id}` })
        } else if (t === 'fine') {
          const note = row.note ? String(row.note).slice(0, 120) : 'Штраф монетами'
          void trySystemNotify('Штраф від вчителя', note, { tag: `tx-${row.id}` })
        }
        // quest_reward: сповіщення вже є через зміну questCompletions → approved
      }
      prevTxIds = ids
    })
  }

  return {
    teacherQuests,
    questCompletions,
    init,
    teardown,
  }
})
