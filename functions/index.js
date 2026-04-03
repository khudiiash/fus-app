const { onCall, HttpsError } = require('firebase-functions/v2/https')
const { initializeApp } = require('firebase-admin/app')
const { getFirestore, FieldValue } = require('firebase-admin/firestore')
const { getAuth } = require('firebase-admin/auth')
const { registerTradeOfferTriggers } = require('./tradePush')
const { registerSchoolPushTriggers } = require('./schoolPush')
const { registerAdminBroadcastPush } = require('./adminBroadcastPush')

initializeApp()

/** Європейський регіон узгоджено з Firestore (eur3). */
const REGION = 'europe-west1'

registerTradeOfferTriggers(REGION, exports)
registerSchoolPushTriggers(REGION, exports)
registerAdminBroadcastPush(REGION, exports)

/**
 * Один FCM-токен = один активний акаунт: прив’язує токен до поточного uid і знімає з інших.
 * Інакше push на вчителя приходить на пристрій, де залогінений учень (спільний браузер / той самий SW).
 */
exports.claimFcmToken = onCall({ region: REGION }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Потрібен вхід')
  }
  const uid = request.auth.uid
  const token = request.data?.token
  if (!token || typeof token !== 'string' || token.trim().length < 20) {
    throw new HttpsError('invalid-argument', 'Некоректний токен')
  }

  const db = getFirestore()
  const uidRef = db.collection('users').doc(uid)
  const uidSnap = await uidRef.get()
  if (!uidSnap.exists) {
    throw new HttpsError('failed-precondition', 'Немає профілю користувача в Firestore')
  }

  const dupSnap = await db.collection('users').where('fcmTokens', 'array-contains', token).get()
  const batch = db.batch()
  for (const d of dupSnap.docs) {
    if (d.id !== uid) {
      batch.update(d.ref, { fcmTokens: FieldValue.arrayRemove(token) })
    }
  }
  batch.update(uidRef, { fcmTokens: FieldValue.arrayUnion(token) })
  await batch.commit()
  return { ok: true }
})

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
