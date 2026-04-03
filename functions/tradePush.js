/**
 * FCM push при зміні tradeOffers (учень ↔ учень).
 */
const { onDocumentCreated, onDocumentUpdated } = require('firebase-functions/v2/firestore')
const { getFirestore } = require('firebase-admin/firestore')
const { sendPushToUser } = require('./fcmHelpers')

/** @param {string} region @param {Record<string, unknown>} exportsObj */
function registerTradeOfferTriggers(region, exportsObj) {
  async function getDisplayName(uid) {
    if (!uid) return 'Учень'
    const s = await getFirestore().collection('users').doc(uid).get()
    return s.exists ? (s.data().displayName || 'Учень') : 'Учень'
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

      // Лише ініціатору: той, хто натиснув «Прийняти», і так знає; push не шлемо.
      if (before.status === 'pending' && after.status === 'accepted') {
        const accepterName = await getDisplayName(after.toUid)
        await sendPushToUser(after.fromUid, {
          title: 'Пропозицію прийнято',
          body: `${accepterName} прийняв(ла) обмін`,
          data: { type: 'trade_accepted', tradeId, tag: `trade-accepted-${tradeId}` },
        })
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
