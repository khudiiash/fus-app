const { onCall, HttpsError } = require('firebase-functions/v2/https')
const { initializeApp } = require('firebase-admin/app')
const { getFirestore } = require('firebase-admin/firestore')
const { getAuth } = require('firebase-admin/auth')
const { registerTradeOfferTriggers } = require('./tradePush')
const { registerSchoolPushTriggers } = require('./schoolPush')

initializeApp()

/** Європейський регіон узгоджено з Firestore (eur3). */
const REGION = 'europe-west1'

registerTradeOfferTriggers(REGION, exports)
registerSchoolPushTriggers(REGION, exports)

/**
 * Виклик з клієнта (тільки залогінений користувач).
 * Якщо в Firestore users/{uid}.role === "admin" — додає JWT claim storageAdmin=true
 * (правила Storage дозволяють upload без firestore.get у Storage).
 */
exports.syncShopStorageClaim = onCall({ region: REGION }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Потрібен вхід')
  }
  const uid = request.auth.uid
  const snap = await getFirestore().collection('users').doc(uid).get()
  if (!snap.exists) {
    throw new HttpsError('failed-precondition', 'Немає профілю користувача в Firestore')
  }
  const role = snap.data().role
  const record = await getAuth().getUser(uid)
  const claims = { ...(record.customClaims || {}) }
  if (role === 'admin') {
    claims.storageAdmin = true
  } else {
    claims.storageAdmin = false
  }
  await getAuth().setCustomUserClaims(uid, claims)
  return { storageAdmin: claims.storageAdmin === true }
})
