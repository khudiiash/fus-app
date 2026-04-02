import { ref } from 'vue'

const toasts = ref([])
let nextId = 0

export function useToast() {
  function show(message, type = 'info', duration = 3000) {
    const id = ++nextId
    toasts.value.push({ id, message, type })
    setTimeout(() => dismiss(id), duration)
  }

  function dismiss(id) {
    toasts.value = toasts.value.filter(t => t.id !== id)
  }

  const success = (msg, d) => show(msg, 'success', d)
  const error   = (msg, d) => show(msg, 'error', d)
  const info    = (msg, d) => show(msg, 'info', d)
  const coin    = (msg, d) => show(msg, 'coin', d)
  const warning = (msg, d) => show(msg, 'warning', d)

  return { toasts, show, dismiss, success, error, info, coin, warning }
}
