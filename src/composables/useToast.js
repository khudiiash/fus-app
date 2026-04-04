import { ref } from 'vue'

/** One visible toast at a time; extras wait in a FIFO queue. */
const queue = []
const currentToast = ref(null)
let nextId = 0
let durationTimer = null

const DEFAULT_DURATION_MS = 1500

function clearTimer() {
  if (durationTimer) {
    clearTimeout(durationTimer)
    durationTimer = null
  }
}

/** Module-level: used by setTimeout in showNextFromQueue (dismiss inside useToast is not in scope there). */
function dismissToast(id) {
  if (currentToast.value?.id === id) {
    clearTimer()
    currentToast.value = null
  } else {
    const i = queue.findIndex((t) => t.id === id)
    if (i >= 0) queue.splice(i, 1)
  }
}

function showNextFromQueue() {
  if (currentToast.value != null || queue.length === 0) return
  const item = queue.shift()
  currentToast.value = item
  const ms = typeof item.duration === 'number' && item.duration > 0 ? item.duration : DEFAULT_DURATION_MS
  durationTimer = setTimeout(() => dismissToast(item.id), ms)
}

export function onToastAfterLeave() {
  // Do not clearTimer() here: a second after-leave (e.g. dev Strict Mode) would cancel the next toast's timeout.
  showNextFromQueue()
}

export function useToast() {
  function show(message, type = 'info', duration = DEFAULT_DURATION_MS) {
    const id = ++nextId
    const ms = typeof duration === 'number' && duration > 0 ? duration : DEFAULT_DURATION_MS
    queue.push({ id, message, type, duration: ms })
    if (!currentToast.value) showNextFromQueue()
  }

  function dismiss(id) {
    dismissToast(id)
  }

  const success = (msg, d) => show(msg, 'success', d)
  const error = (msg, d) => show(msg, 'error', d)
  const info = (msg, d) => show(msg, 'info', d)
  const coin = (msg, d) => show(msg, 'coin', d)
  const warning = (msg, d) => show(msg, 'warning', d)

  return { currentToast, show, dismiss, success, error, info, coin, warning }
}
