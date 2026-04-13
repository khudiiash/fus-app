import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * While the voxel world is running, student chrome (header + bottom nav) is hidden
 * and the HUD can sit above the page chrome.
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
