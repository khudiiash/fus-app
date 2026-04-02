import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import './style.css'

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
