<script setup>
import { ref, watch, nextTick, computed } from 'vue'
import gsap from 'gsap'
import AppModal from '@/components/ui/AppModal.vue'
import CoinDisplay from '@/components/gamification/CoinDisplay.vue'
import MysteryBoxSprite from '@/components/shop/MysteryBoxSprite.vue'
import ItemModelThumb from '@/components/character/ItemModelThumb.vue'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  /** { coins: number, items: Array<{ id, name, category, ... }> } */
  revealed: { type: Object, default: null },
  boxRarity: { type: String, default: 'common' },
})

const emit = defineEmits(['update:modelValue'])

/** box | item | coins | empty | done */
const phase = ref('box')
const itemStep = ref(0)
const headerTitle = ref('Відкриваємо…')
const animating = ref(false)
/** Після анімації: що залишається великим у сцені */
const finalView = ref(null)

const boxLayer = ref(null)
const stageReveal = ref(null)
const stageRoot = ref(null)

let runGeneration = 0

function close() {
  emit('update:modelValue', false)
}

function raf2() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve))
  })
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

const itemsList = computed(() => props.revealed?.items || [])
const itemCount = computed(() => itemsList.value.length)
const currentItem = computed(() => itemsList.value[itemStep.value] || null)
const coinAmount = computed(() => Math.max(0, Number(props.revealed?.coins) || 0))

async function waitForRefs(attempts = 12) {
  for (let i = 0; i < attempts; i++) {
    await nextTick()
    await raf2()
    if (boxLayer.value && stageRoot.value && stageReveal.value) return true
    await new Promise((r) => setTimeout(r, 40))
  }
  return !!(boxLayer.value && stageRoot.value)
}

function setTitle(t) {
  headerTitle.value = t
}

watch(
  () => props.modelValue,
  (open) => {
    if (!open) {
      runGeneration++
      const b = boxLayer.value
      const s = stageReveal.value
      const root = stageRoot.value
      gsap.killTweensOf([b, s, root].filter(Boolean))
      if (b) gsap.set(b, { clearProps: 'all' })
      if (s) gsap.set(s, { clearProps: 'all' })
      if (root) gsap.set(root, { clearProps: 'all' })
      phase.value = 'box'
      itemStep.value = 0
      animating.value = false
      headerTitle.value = 'Відкриваємо…'
      finalView.value = null
    }
  },
)

watch(
  () => [props.modelValue, props.revealed],
  async ([open, data]) => {
    if (!open || !data) return
    const gen = ++runGeneration
    animating.value = true
    phase.value = 'box'
    itemStep.value = 0
    setTitle('Відкриваємо…')

    const ok = await waitForRefs()
    if (!ok || gen !== runGeneration) {
      animating.value = false
      return
    }

    const box = boxLayer.value
    const inner = stageReveal.value
    if (!box) {
      animating.value = false
      return
    }

    gsap.killTweensOf([box, inner, stageRoot.value].filter(Boolean))
    gsap.set(box, { x: 0, scale: 1, opacity: 1, filter: 'none' })
    if (inner) gsap.set(inner, { opacity: 0, scale: 0.88, y: 16 })

    await new Promise((resolve) => {
      const tl = gsap.timeline({ onComplete: resolve })
      tl.to(box, {
        x: 5,
        duration: 0.06,
        repeat: 13,
        yoyo: true,
        ease: 'power1.inOut',
      })
      tl.to(box, { x: 0, duration: 0.04 })
      tl.to(box, {
        scale: 1.2,
        filter: 'brightness(1.75) saturate(1.2)',
        duration: 0.12,
        ease: 'power2.out',
      })
      tl.to(box, { scale: 0, opacity: 0, duration: 0.24, ease: 'back.in(2)' })
    })

    if (gen !== runGeneration) return

    phase.value = 'item'
    const items = itemsList.value
    const coins = coinAmount.value

    const showRevealIn = async () => {
      await nextTick()
      await raf2()
      const el = stageReveal.value
      if (!el || gen !== runGeneration) return
      gsap.killTweensOf(el)
      gsap.set(el, { opacity: 0, scale: 0.82, y: 18 })
      await gsap.to(el, {
        opacity: 1,
        scale: 1,
        y: 0,
        duration: 0.52,
        ease: 'back.out(1.35)',
      })
    }

    const showRevealOut = async () => {
      const el = stageReveal.value
      if (!el || gen !== runGeneration) return
      await gsap.to(el, {
        opacity: 0,
        scale: 0.9,
        y: -12,
        duration: 0.32,
        ease: 'power2.in',
      })
    }

    if (items.length) {
      for (let i = 0; i < items.length; i++) {
        if (gen !== runGeneration) return
        itemStep.value = i
        if (itemCount.value > 1) {
          setTitle(`Приз ${i + 1} з ${itemCount.value}`)
        } else {
          setTitle('Твій приз!')
        }
        await showRevealIn()
        if (gen !== runGeneration) return
        await delay(1650)
        if (gen !== runGeneration) return
        const isLast = i === items.length - 1
        const willShowCoinsAfter = isLast && coins > 0
        if (!isLast || willShowCoinsAfter) {
          await showRevealOut()
        }
      }
    }

    if (gen !== runGeneration) return

    if (coins > 0) {
      setTitle('Бонус монетами!')
      itemStep.value = 0
      phase.value = 'coins'
      await showRevealIn()
      if (gen !== runGeneration) return
      await delay(1700)
    } else if (!items.length) {
      setTitle('На цей раз…')
      phase.value = 'empty'
      await showRevealIn()
      if (gen !== runGeneration) return
      await delay(1400)
    }

    if (gen !== runGeneration) return

    if (coins > 0) {
      finalView.value = { type: 'coins', amount: coins }
    } else if (items.length) {
      finalView.value = { type: 'item', item: items[items.length - 1] }
    } else {
      finalView.value = { type: 'empty' }
    }

    phase.value = 'done'
    setTitle('Нагорода!')
    animating.value = false
  },
  { flush: 'post' },
)

const closeDisabled = computed(() => animating.value && phase.value !== 'done')
</script>

<template>
  <AppModal
    :model-value="modelValue"
    :title="headerTitle"
    size="sm"
    @update:model-value="(v) => { if (!v) close() }"
  >
    <div v-if="revealed" class="flex flex-col gap-3 min-h-0">
      <!-- Одна сцена: коробка та призи в тому ж місці -->
      <div
        ref="stageRoot"
        class="relative w-full min-h-[min(36vh,220px)] max-h-[42vh] sm:min-h-[240px] sm:max-h-none flex items-center justify-center rounded-xl border border-white/[0.06] bg-white/[0.02]"
      >
        <div
          ref="boxLayer"
          v-show="phase === 'box'"
          class="absolute inset-0 flex items-center justify-center pointer-events-none"
        >
          <MysteryBoxSprite :rarity="boxRarity" :size="96" />
        </div>

        <div
          ref="stageReveal"
          v-show="phase !== 'box'"
          class="absolute inset-0 flex flex-col items-center justify-center px-3 py-3 text-center overflow-hidden"
        >
          <template v-if="phase === 'item' && currentItem">
            <ItemModelThumb
              :item="currentItem"
              :width="148"
              :height="168"
              class="rounded-xl border border-white/10 shadow-lg shadow-black/40"
            />
            <p class="mt-2 text-sm sm:text-base font-extrabold text-slate-100 leading-tight max-w-[260px] line-clamp-2">
              {{ currentItem.name }}
            </p>
          </template>

          <template v-else-if="phase === 'coins'">
            <p class="text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-2">Монети</p>
            <div
              class="inline-flex items-center justify-center rounded-xl px-5 py-3"
              style="background: rgba(251, 191, 36, 0.14)"
            >
              <CoinDisplay :amount="coinAmount" size="md" show-sign />
            </div>
          </template>

          <template v-else-if="phase === 'empty'">
            <p class="text-sm font-semibold text-slate-400 max-w-xs leading-snug px-1">
              На цей раз без дропу — спробуй ще раз пізніше.
            </p>
          </template>

          <template v-else-if="phase === 'done' && finalView">
            <template v-if="finalView.type === 'item'">
              <ItemModelThumb
                :item="finalView.item"
                :width="148"
                :height="168"
                class="rounded-xl border border-white/10 shadow-lg shadow-black/40"
              />
              <p class="mt-2 text-sm sm:text-base font-extrabold text-slate-100 leading-tight max-w-[260px] line-clamp-2">
                {{ finalView.item.name }}
              </p>
              <p v-if="itemCount > 1" class="mt-1 text-xs text-slate-500">
                Усі {{ itemCount }} призів додано в інвентар.
              </p>
            </template>
            <template v-else-if="finalView.type === 'coins'">
              <p class="text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-2">Монети</p>
              <div
                class="inline-flex items-center justify-center rounded-xl px-5 py-3"
                style="background: rgba(251, 191, 36, 0.14)"
              >
                <CoinDisplay :amount="finalView.amount" size="md" show-sign />
              </div>
              <p v-if="itemCount" class="mt-2 text-xs text-slate-500">
                Предмети та монети вже в інвентарі / на балансі.
              </p>
            </template>
            <template v-else-if="finalView.type === 'empty'">
              <p class="text-sm font-semibold text-slate-400 max-w-xs leading-snug px-1">
                На цей раз без дропу — спробуй ще раз пізніше.
              </p>
            </template>
          </template>
        </div>
      </div>
    </div>

    <template #footer>
      <button
        v-if="revealed"
        type="button"
        class="w-full py-2.5 rounded-xl font-extrabold text-sm transition-all active:scale-[0.98] disabled:opacity-40 disabled:pointer-events-none"
        style="background: linear-gradient(135deg, var(--accent), #34d399); color: #0f0f0f"
        :disabled="closeDisabled"
        @click="close"
      >
        Супер!
      </button>
    </template>
  </AppModal>
</template>
