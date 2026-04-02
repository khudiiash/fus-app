import { ref } from 'vue'

export const ACCENT_PRESETS = [
  { name: 'Помаранчевий', hex: '#f97316' },
  { name: 'Синій',        hex: '#3b82f6' },
  { name: 'Зелений',      hex: '#22c55e' },
  { name: 'Рожевий',      hex: '#ec4899' },
  { name: 'Блакитний',    hex: '#06b6d4' },
  { name: 'Золотий',      hex: '#f59e0b' },
  { name: 'Фіолетовий',   hex: '#8b5cf6' },
  { name: 'Червоний',     hex: '#ef4444' },
]

const STORAGE_KEY    = 'fusapp-accent'
const DEFAULT_ACCENT = '#f97316'

function hexToRgb(hex) {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return { r, g, b }
}

function applyToDom(hex) {
  if (typeof document === 'undefined') return
  const { r, g, b } = hexToRgb(hex)
  const root = document.documentElement
  root.style.setProperty('--accent',     hex)
  root.style.setProperty('--accent-rgb', `${r}, ${g}, ${b}`)
}

const stored = typeof localStorage !== 'undefined'
  ? localStorage.getItem(STORAGE_KEY) || DEFAULT_ACCENT
  : DEFAULT_ACCENT

export const currentAccent = ref(stored)

export function initAccent() {
  applyToDom(currentAccent.value)
}

export function setAccent(hex) {
  currentAccent.value = hex
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(STORAGE_KEY, hex)
  }
  applyToDom(hex)
}
