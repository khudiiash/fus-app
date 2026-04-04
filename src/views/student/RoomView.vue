<script setup>
import { ref, computed, onMounted, watch, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { doc, getDoc } from 'firebase/firestore'
import { db } from '@/firebase/config'
import { useAuthStore } from '@/stores/auth'
import { useUserStore } from '@/stores/user'
import CharacterScene from '@/components/character/CharacterScene.vue'
import { ArrowLeft } from 'lucide-vue-next'

const route     = useRoute()
const router    = useRouter()
const auth      = useAuthStore()
const userStore = useUserStore()

const targetProfile  = ref(null)
const targetOwnedIds = ref([])
const loading        = ref(true)

const isOwnRoom = computed(() => !route.params.uid || route.params.uid === auth.profile?.id)

/** У layout (студент / вчитель) висоту дає flex-1; лише автономний /room/:uid (напр. адмін) — повний екран */
const isEmbeddedRoom = computed(
  () => route.path.startsWith('/student/room') || route.path.startsWith('/teacher/room'),
)
const standaloneRoomStyle = computed(() =>
  isEmbeddedRoom.value ? null : { minHeight: '100dvh', height: '100dvh' },
)

watch(loading, (v) => {
  if (!v) nextTick(() => window.dispatchEvent(new Event('resize')))
})

onMounted(async () => {
  // Catalog: never block the room on a full Firestore round-trip; CharacterScene
  // watches allItems.length and rebuilds when shop data arrives.
  void userStore.fetchItems()

  if (isOwnRoom.value) {
    targetProfile.value = auth.profile
    targetOwnedIds.value = auth.profile?.inventory || []
    loading.value = false
    return
  }

  const uid = route.params.uid
  try {
    const snap = await getDoc(doc(db, 'users', uid))
    if (snap.exists()) {
      targetProfile.value = { id: snap.id, ...snap.data() }
      targetOwnedIds.value = targetProfile.value.inventory || []
    }
  } catch (e) {
    console.error('Failed to load student profile:', e)
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div
    class="flex flex-col overflow-hidden box-border w-full bg-game-bg"
    :class="isEmbeddedRoom ? 'flex-1 min-h-0' : ''"
    :style="standaloneRoomStyle"
  >

    <!-- Top bar (safe-area лише для автономного /room/:uid — у layout хедер уже з inset) -->
    <div
      class="flex items-center gap-3 px-4 py-2 shrink-0 z-20 border-b border-white/[0.06]"
      :class="isEmbeddedRoom ? '' : 'pt-[calc(env(safe-area-inset-top,0px)+0.35rem)]'"
      style="background:rgba(0,0,0,0.45);backdrop-filter:blur(12px)"
    >
      <button
        class="flex items-center gap-1.5 text-sm font-bold text-amber-400/80 hover:text-amber-300 transition-colors"
        @click="router.back()"
      >
        <ArrowLeft :size="16" :stroke-width="2.5" />
        Назад
      </button>
      <div class="flex-1 text-center">
        <div class="font-extrabold text-sm text-slate-300">
          {{ isOwnRoom ? 'Моя кімната' : `Кімната: ${targetProfile?.displayName || '...'}` }}
        </div>
      </div>
      <div class="w-20" />
    </div>

    <!-- 3D scene: flex-1 дає висоту; absolute дочірній блок заповнює її повністю -->
    <div class="flex-1 min-h-0 w-full relative">
      <div v-if="loading" class="absolute inset-0 flex items-center justify-center text-slate-400 font-bold z-10">
        Завантаження...
      </div>
      <CharacterScene
        v-else-if="targetProfile"
        :profile="targetProfile"
        :owned-item-ids="targetOwnedIds"
        :all-items="userStore.items"
        :room-mode="true"
        :interactive="true"
        :readonly="!isOwnRoom"
        class="absolute inset-0 w-full h-full min-h-0"
      />
      <div v-else class="absolute inset-0 flex items-center justify-center text-slate-400 font-bold z-10">
        Кімнату не знайдено
      </div>
      <p
        class="absolute bottom-2 left-2 right-2 text-center text-[10px] text-slate-500 pointer-events-none z-20"
      >
        Потягніть щоб обертати камеру
      </p>
    </div>
  </div>
</template>
