import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/login' },

    {
      path: '/login',
      name: 'login',
      component: () => import('@/views/auth/LoginView.vue'),
      meta: { guest: true },
    },

    // ─── Admin ─────────────────────────────────────────────────────────────
    {
      path: '/admin',
      component: () => import('@/layouts/AdminLayout.vue'),
      meta: { requiresAuth: true, role: 'admin' },
      children: [
        { path: '', name: 'admin-home', component: () => import('@/views/admin/AdminDashboard.vue') },
        { path: 'classes', name: 'admin-classes', component: () => import('@/views/admin/ClassesView.vue') },
        { path: 'students', name: 'admin-students', component: () => import('@/views/admin/StudentsView.vue') },
        { path: 'teachers', name: 'admin-teachers', component: () => import('@/views/admin/TeachersView.vue') },
        { path: 'subjects', name: 'admin-subjects', component: () => import('@/views/admin/SubjectsView.vue') },
        { path: 'shop',     name: 'admin-shop',     component: () => import('@/views/admin/ShopManagementView.vue') },
        { path: 'devtools', name: 'admin-devtools', component: () => import('@/views/admin/DevToolsView.vue') },
        { path: 'rooms',    name: 'admin-rooms',    component: () => import('@/views/admin/RoomTesterView.vue') },
      ],
    },

    // ─── Teacher ───────────────────────────────────────────────────────────
    {
      path: '/teacher',
      component: () => import('@/layouts/TeacherLayout.vue'),
      meta: { requiresAuth: true, role: 'teacher' },
      children: [
        { path: '', name: 'teacher-home', component: () => import('@/views/teacher/TeacherDashboard.vue') },
        { path: 'class/:id', name: 'teacher-class', component: () => import('@/views/teacher/ClassView.vue') },
        { path: 'history', name: 'teacher-history', component: () => import('@/views/teacher/AwardHistoryView.vue') },
        { path: 'leaderboard', name: 'teacher-leaderboard', component: () => import('@/views/teacher/TeacherLeaderboardView.vue') },
        { path: 'quests',      name: 'teacher-quests',      component: () => import('@/views/teacher/TeacherQuestsView.vue') },
        { path: 'profile',     name: 'teacher-profile',     component: () => import('@/views/teacher/TeacherProfileView.vue') },
        { path: 'room/:uid',   name: 'teacher-room-student', component: () => import('@/views/student/RoomView.vue') },
      ],
    },

    // ─── Student ───────────────────────────────────────────────────────────
    {
      path: '/student',
      component: () => import('@/layouts/StudentLayout.vue'),
      meta: { requiresAuth: true, role: 'student' },
      children: [
        { path: '', name: 'student-home', component: () => import('@/views/student/HomeView.vue') },
        { path: 'profile', name: 'student-profile', component: () => import('@/views/student/ProfileView.vue') },
        { path: 'shop', name: 'student-shop', component: () => import('@/views/student/ShopView.vue') },
        { path: 'trade', name: 'student-trade', component: () => import('@/views/student/TradeView.vue') },
        { path: 'leaderboard', name: 'student-leaderboard', component: () => import('@/views/student/LeaderboardView.vue') },
        { path: 'achievements', name: 'student-achievements', component: () => import('@/views/student/AchievementsView.vue') },
        { path: 'history',     name: 'student-history',      component: () => import('@/views/student/HistoryView.vue') },
        { path: 'room',        name: 'student-room',         component: () => import('@/views/student/RoomView.vue') },
        { path: 'room/:uid',   name: 'student-room-other',   component: () => import('@/views/student/RoomView.vue') },
      ],
    },

    // ─── Universal room view — any authenticated role can visit any student's room ──
    {
      path: '/room/:uid',
      name: 'room-view',
      component: () => import('@/views/student/RoomView.vue'),
      meta: { requiresAuth: true },
    },

    { path: '/:pathMatch(.*)*', redirect: '/login' },
  ],
})

router.beforeEach(async (to) => {
  const { useAuthStore } = await import('@/stores/auth')
  const auth = useAuthStore()

  // Auth is always pre-initialized in main.js, but guard against any edge case
  if (auth.loading) await auth.init()

  const isAuthenticated = auth.isAuthenticated
  const role = auth.role  // null until profile loads

  // Not authenticated → only allow guest/public routes
  if (!isAuthenticated) {
    return to.meta.requiresAuth ? '/login' : true
  }

  // Authenticated but profile not ready yet → let it through and let the
  // view handle the loading state; do NOT redirect or we get an infinite loop
  if (!role) return true

  // Students: /room/:uid is outside StudentLayout (no footer). Use nested route instead.
  if (to.name === 'room-view' && role === 'student' && to.params.uid) {
    return { path: `/student/room/${to.params.uid}`, replace: true }
  }

  // Teachers: same — use layout with safe-area header + bottom nav (matches student room UX).
  if (to.name === 'room-view' && role === 'teacher' && to.params.uid) {
    return { path: `/teacher/room/${to.params.uid}`, replace: true }
  }

  // Authenticated, profile ready, trying to visit the login page
  if (to.meta.guest) return roleHome(role)

  // Authenticated but wrong role (admins bypass all role checks)
  if (to.meta.role && role !== to.meta.role && role !== 'admin') {
    return roleHome(role)
  }

  return true
})

function roleHome(role) {
  if (role === 'admin')   return '/admin'
  if (role === 'teacher') return '/teacher'
  if (role === 'student') return '/student'
  return '/login'
}

export default router
