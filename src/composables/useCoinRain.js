import { ref, createApp, h } from 'vue'
import CoinRain from '@/components/gamification/CoinRain.vue'

const active = ref([])

export function useCoinRain() {
  function rain(amount, x, y) {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(CoinRain, {
          amount,
          x: x ?? window.innerWidth / 2,
          y: y ?? window.innerHeight / 3,
          onDone: () => {
            setTimeout(() => {
              app.unmount()
              container.remove()
            }, 1200)
          },
        })
      },
    })
    app.mount(container)
  }

  return { rain }
}
