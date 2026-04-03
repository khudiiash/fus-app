import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import {
  signInWithEmailAndPassword, signOut, onAuthStateChanged,
  createUserWithEmailAndPassword, updateProfile,
} from 'firebase/auth'
import { auth } from '@/firebase/config'

export const useAuthStore = defineStore('auth', () => {
  const user        = ref(null)   // Firebase Auth user
  const profile     = ref(null)   // Firestore user profile
  const loading     = ref(true)
  const currentCode = ref(null)   // access code used to sign in (needed for re-auth when creating users)
  const newAchievements = ref([])

  const isAuthenticated = computed(() => !!user.value)
  const role = computed(() => profile.value?.role || null)
  const isAdmin   = computed(() => role.value === 'admin')
  const isTeacher = computed(() => role.value === 'teacher')
  const isStudent = computed(() => role.value === 'student')

  let unsubscribeProfile = null
  let _initPromise = null

  function init() {
    if (_initPromise) return _initPromise
    _initPromise = new Promise(resolve => {
      onAuthStateChanged(auth, async fbUser => {
        if (fbUser) {
          user.value = fbUser
          await loadProfile(fbUser.uid)
        } else {
          user.value    = null
          profile.value = null
          if (unsubscribeProfile) { unsubscribeProfile(); unsubscribeProfile = null }
        }
        loading.value = false
        resolve()
      })
    })
    return _initPromise
  }

  async function loadProfile(uid) {
    const { getUser, watchUser } = await import('@/firebase/collections')
    if (unsubscribeProfile) unsubscribeProfile()

    // Seed the profile immediately from a one-time read so the UI
    // doesn't stay blank while the snapshot subscription initialises.
    profile.value = await getUser(uid) || null
    if (profile.value?.accessCode) currentCode.value = profile.value.accessCode

    // Real-time listener takes over from here — every remote change is
    // picked up without a page reload.
    unsubscribeProfile = watchUser(uid, data => {
      profile.value = data || null
      if (data?.accessCode) currentCode.value = data.accessCode
    })
  }

  async function loginWithCode(code) {
    const {
      getCodeData,
      syncLevel,
      updateStreak,
      getDailyQuests,
      updateQuestProgress,
      checkAndGrantAchievements,
    } = await import('@/firebase/collections')
    const trimmedCode = code.trim().toUpperCase()
    const codeData = await getCodeData(trimmedCode)
    if (!codeData) throw new Error('Невірний код доступу')
    if (codeData.isActive === false) throw new Error('Цей код деактивовано')

    const credential = await signInWithEmailAndPassword(auth, codeData.email, trimmedCode)
    user.value = credential.user
    currentCode.value = trimmedCode   // store for re-auth when creating sub-accounts
    await loadProfile(credential.user.uid)

    const { setDoc, doc, updateDoc, serverTimestamp } = await import('firebase/firestore')
    const { db } = await import('@/firebase/config')

    // If access code has no role field (manually created admin), default to 'admin'
    if (!codeData.role) codeData.role = 'admin'

    // Bootstrap Firestore profile if it doesn't exist yet (e.g. manually created admin)
    if (!profile.value) {
      await setDoc(doc(db, 'users', credential.user.uid), {
        displayName: codeData.displayName || credential.user.displayName || 'Адмін',
        email: codeData.email,
        role: codeData.role || 'admin',
        accessCode: trimmedCode,
        classId: codeData.classId || null,
        classIds: codeData.classIds || [],
        coins: 0, xp: 0, level: 1, streak: 0, lastLoginDate: null,
        avatar: { skinId: 'default', backgroundId: 'default', frameId: 'none', accessories: [] },
        inventory: [], inventoryCounts: {}, badges: [],
        createdAt: serverTimestamp(),
      })
      await loadProfile(credential.user.uid)
    } else {
      // Profile exists — ensure role and accessCode are correct in Firestore.
      // isOwner rule allows users to update their own document, so this is always permitted.
      const expectedRole = codeData.role || 'admin'
      const needsUpdate = profile.value.role !== expectedRole || profile.value.accessCode !== trimmedCode
      if (needsUpdate) {
        await updateDoc(doc(db, 'users', credential.user.uid), {
          role: expectedRole,
          accessCode: trimmedCode,
        })
        profile.value = { ...profile.value, role: expectedRole, accessCode: trimmedCode }
      }
    }

    // Post-login gamification (students) — run in background so login + navigation
    // are not blocked on slow Firestore / achievement checks (fixes stuck login UI).
    if (profile.value?.role === 'student') {
      const uid = credential.user.uid
      const snap = { ...profile.value }
      void (async () => {
        try {
          await syncLevel(uid, snap.xp, snap.level)
          await updateStreak(uid)
          await getDailyQuests(uid)
          await updateQuestProgress(uid, 'login', 1)
          const { registerWebPushAndSave } = await import('@/firebase/fcmClient')
          void registerWebPushAndSave(uid)
          const granted = await checkAndGrantAchievements(uid)
          if (granted.length > 0) newAchievements.value = granted
        } catch (e) {
          console.warn('[auth] post-login student sync:', e)
        }
      })()
    }

    return profile.value
  }

  async function logout() {
    if (unsubscribeProfile) { unsubscribeProfile(); unsubscribeProfile = null }
    await signOut(auth)
    user.value        = null
    profile.value     = null
    currentCode.value = null
  }

  // Admin utility: create a new Firebase Auth account for student/teacher
  async function createUserAccount({ displayName, role, classId, classIds }) {
    const { nameToEmail } = await import('@/composables/useNameToEmail')
    const baseEmail = nameToEmail(displayName)

    // Generate unique access code
    const adjectives = ['SWIFT', 'BRAVE', 'SMART', 'COOL', 'EPIC', 'WILD', 'STAR', 'HERO', 'GOLD', 'IRON']
    const adj = adjectives[Math.floor(Math.random() * adjectives.length)]
    const num = String(Math.floor(1000 + Math.random() * 9000))
    const code = `${adj}-${num}`

    // Try to create account; if email exists append a number
    let email = baseEmail
    let credential
    let attempts = 0
    while (attempts < 10) {
      try {
        credential = await createUserWithEmailAndPassword(auth, email, code)
        break
      } catch (e) {
        if (e.code === 'auth/email-already-in-use') {
          attempts++
          email = baseEmail.replace('@', `${attempts}@`)
        } else throw e
      }
    }

    await updateProfile(credential.user, { displayName })

    const { setDoc, doc, serverTimestamp } = await import('firebase/firestore')
    const { db } = await import('@/firebase/config')
    const { createAccessCode } = await import('@/firebase/collections')

    // Create Firestore user profile
    await setDoc(doc(db, 'users', credential.user.uid), {
      displayName,
      email,
      role,
      accessCode: code,
      classId: classId || null,
      classIds: classIds || [],
      coins: 0,
      xp: 0,
      level: 1,
      streak: 0,
      lastLoginDate: null,
      avatar: { skinId: 'default', backgroundId: 'default', frameId: 'none', accessories: [] },
      inventory: [],
      inventoryCounts: {},
      badges: [],
      createdAt: serverTimestamp(),
    })

    await createAccessCode(code, { email, uid: credential.user.uid, displayName, role, classId: classId || null })

    // Re-sign in as admin (credential changes current user)
    // We sign back in as the current admin
    return { uid: credential.user.uid, email, code }
  }

  function clearNewAchievements() { newAchievements.value = [] }

  return {
    user, profile, loading, currentCode, newAchievements,
    isAuthenticated, role, isAdmin, isTeacher, isStudent,
    init, loginWithCode, logout, createUserAccount, clearNewAchievements,
  }
})
