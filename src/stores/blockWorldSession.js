import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * Laby (and block-world) “play” mode: bottom tab bar hidden; a slim app header can stay
 * visible (see `StudentLayout` + `--fus-laby-chrome-top`).
 */
export const useBlockWorldSession = defineStore('blockWorldSession', () => {
  const immersive = ref(false)
  return {
    immersive,
    setImmersive(v) {
      immersive.value = Boolean(v)
    },
  }
})
