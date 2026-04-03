import { getFunctions, httpsCallable } from 'firebase/functions'
import app from '@/firebase/config'

const REGION = import.meta.env.VITE_FUNCTIONS_REGION || 'europe-west1'

/**
 * @param {{ title: string, body: string, targetRole: 'teacher' | 'student', userUids?: string[] }} payload
 */
export async function adminBroadcastPush(payload) {
  const functions = getFunctions(app, REGION)
  const call = httpsCallable(functions, 'adminBroadcastPush')
  // Гарантовано «звичайний» масив (не Vue Proxy); ключ завжди передаємо, щоб не було гілки «усім» на сервері.
  const userUids = [...(payload.userUids || [])]
  const res = await call({
    title: payload.title,
    body: payload.body,
    targetRole: payload.targetRole,
    userUids,
  })
  return res.data
}

/** @param {{ title: string, body: string, teacherUids?: string[] }} payload */
export async function adminBroadcastToTeachers(payload) {
  return adminBroadcastPush({
    title: payload.title,
    body: payload.body,
    targetRole: 'teacher',
    userUids: payload.teacherUids,
  })
}

/** @param {{ title: string, body: string, studentUids?: string[] }} payload */
export async function adminBroadcastToStudents(payload) {
  return adminBroadcastPush({
    title: payload.title,
    body: payload.body,
    targetRole: 'student',
    userUids: payload.studentUids,
  })
}
