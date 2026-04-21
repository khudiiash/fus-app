import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import './style.css'

// `vite-plugin-pwa` / prior visits can leave a service worker on localhost; it caches `/assets/*`
// and makes Laby (`vendor-labyminecraft`) look frozen even though `third-party/js-minecraft` changed.
if (import.meta.env.DEV && typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.getRegistrations().then((registrations) => {
    for (const registration of registrations) {
      void registration.unregister()
    }
  })
}

const app = createApp(App)
const pinia = createPinia()
app.use(pinia)

// Initialize auth state before mounting so the router guard
// always has a resolved auth state on first navigation.
import('@/stores/auth').then(({ useAuthStore }) => {
  useAuthStore().init().then(() => {
    app.use(router)
    app.mount('#app')
  })
})
