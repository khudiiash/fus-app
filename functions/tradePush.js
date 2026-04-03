/**
 * FCM push при зміні tradeOffers (учень ↔ учень).
 * Потрібні збережені в users/{uid}.fcmTokens (реєструє клієнт після входу).
 */
const { onDocumentCreated, onDocumentUpdated } = require('firebase-functions/v2/firestore')
const { getFirestore, FieldValue } = require('firebase-admin/firestore')
const { getMessaging } = require('firebase-admin/messaging')

/** @param {string} region @param {Record<string, unknown>} exportsObj */
function registerTradeOfferTriggers(region, exportsObj) {
  async function getDisplayName(uid) {
    if (!uid) return 'Учень'
    const s = await getFirestore().collection('users').doc(uid).get()
    return s.exists ? (s.data().displayName || 'Учень') : 'Учень'
  }

  async function sendPushToUser(uid, { title, body, data = {} }) {
    if (!uid) return
    const db = getFirestore()
    const userRef = db.collection('users').doc(uid)
    const snap = await userRef.get()
    if (!snap.exists) return
    const raw = snap.data().fcmTokens || []
    const tokens = [...new Set(raw.filter(Boolean))]
    if (!tokens.length) return

    const stringData = {
      title: String(title),
      body: String(body),
      ...Object.fromEntries(
        Object.entries(data).map(([k, v]) => [k, v == null ? '' : String(v)]),
      ),
    }

    /**
     * Лише data (без top-level notification): інакше Chrome у фоні сам показує «тихе»
     * повідомлення в шторку без звуку/heads-up. Тоді onBackgroundMessage у SW
     * або не викликається, або дублюється. Усі поля — рядки (вимога FCM data).
     */
    const messaging = getMessaging()
    const res = await messaging.sendEachForMulticast({
      tokens,
      data: stringData,
      android: { priority: 'high' },
      webpush: {
        headers: {
          Urgency: 'high',
          TTL: '86400',
        },
        fcmOptions: { link: '/' },
      },
    })

    const dead = []
    res.responses.forEach((r, i) => {
      if (r.success) return
      const c = r.error?.code || ''
      if (
        c.includes('registration-token-not-registered') ||
        c.includes('invalid-registration-token')
      ) {
        dead.push(tokens[i])
      }
    })
    if (dead.length) {
      try {
        await userRef.update({ fcmTokens: FieldValue.arrayRemove(...dead) })
      } catch (e) {
        console.warn('[tradePush] prune tokens', e?.message || e)
      }
    }
  }

  exportsObj.onTradeOfferCreated = onDocumentCreated(
    { document: 'tradeOffers/{tradeId}', region },
    async (event) => {
      const data = event.data?.data()
      if (!data || data.status !== 'pending') return
      const tradeId = event.params.tradeId
      const fromName = await getDisplayName(data.fromUid)
      await sendPushToUser(data.toUid, {
        title: 'Нова пропозиція обміну',
        body: `${fromName} пропонує обмін`,
        data: {
          type: 'trade_in',
          tradeId,
          tag: `trade-in-${tradeId}`,
        },
      })
    },
  )

  exportsObj.onTradeOfferUpdated = onDocumentUpdated(
    { document: 'tradeOffers/{tradeId}', region },
    async (event) => {
      const before = event.data.before.data()
      const after = event.data.after.data()
      if (!before || !after) return
      const tradeId = event.params.tradeId

      if (before.status === 'pending' && after.status === 'accepted') {
        await Promise.all([
          sendPushToUser(after.fromUid, {
            title: 'Обмін виконано!',
            body: 'Твою пропозицію прийнято 🤝',
            data: { type: 'trade_done', tradeId, tag: `trade-done-${tradeId}` },
          }),
          sendPushToUser(after.toUid, {
            title: 'Обмін виконано!',
            body: 'Угоду підтверджено 🤝',
            data: { type: 'trade_done', tradeId, tag: `trade-done-recv-${tradeId}` },
          }),
        ])
        return
      }

      if (before.status === 'pending' && after.status === 'declined') {
        await sendPushToUser(after.fromUid, {
          title: 'Пропозицію відхилено',
          body: 'Можна надіслати іншу угоду',
          data: { type: 'trade_declined', tradeId, tag: `trade-out-${tradeId}` },
        })
      }
    },
  )
}

module.exports = { registerTradeOfferTriggers }
