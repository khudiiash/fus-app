<script setup>
import { ref, onMounted } from 'vue'
import { gsap } from 'gsap'

const props = defineProps({
  amount: { type: Number, default: 0 },
  x: { type: Number, default: 0 },
  y: { type: Number, default: 0 },
})

const emit = defineEmits(['done'])

const coins = ref([])
const container = ref(null)

onMounted(() => {
  const count = Math.min(Math.ceil(props.amount / 10), 15)
  coins.value = Array.from({ length: count }, (_, i) => ({ id: i }))

  // Animate after DOM renders
  requestAnimationFrame(() => {
    const els = container.value?.querySelectorAll('.coin-particle')
    if (!els) return

    els.forEach((el, i) => {
      const angle  = -90 + (Math.random() - 0.5) * 120
      const dist   = 60 + Math.random() * 80
      const rad    = (angle * Math.PI) / 180
      const targetX = Math.cos(rad) * dist
      const targetY = Math.sin(rad) * dist - 20

      gsap.fromTo(el,
        { x: 0, y: 0, scale: 0, opacity: 1 },
        {
          x: targetX, y: targetY, scale: 1, opacity: 0,
          duration: 0.8 + Math.random() * 0.4,
          delay: i * 0.04,
          ease: 'power2.out',
          onComplete: i === 0 ? () => emit('done') : undefined,
        }
      )
    })
  })
})
</script>

<template>
  <div ref="container" class="fixed pointer-events-none z-[9997]" :style="{ left: x + 'px', top: y + 'px' }">
    <div
      v-for="c in coins"
      :key="c.id"
      class="coin-particle absolute text-xl select-none"
      style="transform-origin: center"
    >🪙</div>
  </div>
</template>
