/**
 * FCM: завдання (вчитель ↔ учень) та прямі нагороди/штрафи (transactions).
 */
const { onDocumentCreated, onDocumentUpdated } = require('firebase-functions/v2/firestore')
const { getFirestore } = require('firebase-admin/firestore')
const { sendPushToUser } = require('./fcmHelpers')

/** @param {string} region @param {Record<string, unknown>} exportsObj */
function registerSchoolPushTriggers(region, exportsObj) {
  const db = getFirestore()

  /** Учень надіслав заявку — сповіщаємо вчителя */
  exportsObj.onQuestCompletionCreated = onDocumentCreated(
    { document: 'questCompletions/{completionId}', region },
    async (event) => {
      const d = event.data?.data()
      if (!d || d.status !== 'pending') return
      const questSnap = await db.collection('quests').doc(d.questId).get()
      if (!questSnap.exists) return
      const q = questSnap.data()
      const teacherId = q.teacherId
      if (!teacherId || teacherId === d.studentId) return
      const questTitle = q.title || 'Завдання'
      const completionId = event.params.completionId
      await sendPushToUser(teacherId, {
        title: 'Нова заявка на завдання',
        body: `${d.studentName || 'Учень'} — «${questTitle}»`,
        data: {
          type: 'quest_pending',
          completionId,
          questId: d.questId,
          tag: `quest-pending-${completionId}`,
        },
      })
    },
  )

  /** Вчитель схвалив / відхилив — сповіщаємо учня */
  exportsObj.onQuestCompletionUpdated = onDocumentUpdated(
    { document: 'questCompletions/{completionId}', region },
    async (event) => {
      const before = event.data.before.data()
      const after = event.data.after.data()
      if (!before || !after) return
      if (before.status !== 'pending') return
      const completionId = event.params.completionId
      const studentId = after.studentId
      if (!studentId) return

      if (after.status === 'approved') {
        const questSnap = await db.collection('quests').doc(after.questId).get()
        const title = questSnap.exists ? (questSnap.data().title || '') : ''
        await sendPushToUser(studentId, {
          title: 'Завдання зараховано',
          body: title ? `«${title}» — нагорода на балансі` : 'Нагорода на балансі',
          data: {
            type: 'quest_approved',
            completionId,
            questId: after.questId,
            tag: `quest-approved-${completionId}`,
          },
        })
        return
      }

      if (after.status === 'rejected') {
        await sendPushToUser(studentId, {
          title: 'Заявку відхилено',
          body: 'Можна надіслати нову відповідь у застосунку',
          data: {
            type: 'quest_rejected',
            completionId,
            questId: after.questId,
            tag: `quest-rejected-${completionId}`,
          },
        })
      }
    },
  )

  /** Нове активне завдання — учням (клас або один учень) */
  exportsObj.onQuestCreated = onDocumentCreated(
    { document: 'quests/{questId}', region },
    async (event) => {
      const q = event.data?.data()
      if (!q || q.status !== 'active') return
      const questId = event.params.questId
      const title = q.title || 'Нове завдання'
      const teacher = q.teacherName ? String(q.teacherName) : 'Вчитель'
      const payloadBase = {
        title: 'Нове завдання від вчителя',
        body: `${title} — ${teacher}`,
        data: {
          type: 'quest_new',
          questId,
          tag: `quest-new-${questId}`,
        },
      }

      if (q.scope === 'student' && q.studentId) {
        await sendPushToUser(q.studentId, payloadBase)
        return
      }

      if (q.scope === 'class' && q.classId) {
        // Порядок полів як у firestore.indexes.json (classId, role, coins)
        const snap = await db
          .collection('users')
          .where('classId', '==', q.classId)
          .where('role', '==', 'student')
          .get()
        await Promise.all(snap.docs.map((doc) => sendPushToUser(doc.id, payloadBase)))
      }
    },
  )

  /** Прямі нагороди та штрафи (без дубля для quest_reward — вже є quest_approved) */
  exportsObj.onStudentTransactionCreated = onDocumentCreated(
    { document: 'transactions/{txId}', region },
    async (event) => {
      const t = event.data?.data()
      if (!t || !t.toUid) return
      if (t.type === 'quest_reward') return
      if (t.type !== 'award' && t.type !== 'fine') return

      const txId = event.params.txId
      const isFine = t.type === 'fine'
      const title = isFine ? 'Штраф від вчителя' : 'Нагорода від вчителя'
      let body = t.note ? String(t.note).slice(0, 160) : ''
      if (!body) {
        const n = Number(t.amount) || 0
        body = isFine ? `−${Math.abs(n)} 🪙` : `+${n} 🪙`
      }

      await sendPushToUser(t.toUid, {
        title,
        body,
        data: {
          type: isFine ? 'tx_fine' : 'tx_award',
          txId,
          tag: `tx-${txId}`,
        },
      })
    },
  )
}

module.exports = { registerSchoolPushTriggers }
