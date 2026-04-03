<script setup>
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { getClass } from '@/firebase/collections'
import AppCard from '@/components/ui/AppCard.vue'
import { School } from 'lucide-vue-next'
import { givenNameFromDisplayName } from '@/utils/personName'

const auth   = useAuthStore()
const router = useRouter()
const classes = ref([])

onMounted(async () => {
  const ids = auth.profile?.classIds || []
  const all = await Promise.all(ids.map(id => getClass(id)))
  classes.value = all.filter(Boolean)
})
</script>

<template>
  <div class="flex flex-col gap-6">
    <div>
      <h1 class="text-2xl font-extrabold gradient-heading">Вітаємо, {{ givenNameFromDisplayName(auth.profile?.displayName) }}!</h1>
      <p class="text-slate-500 text-sm mt-0.5">Оберіть клас, щоб нарахувати монети</p>
    </div>

    <div v-if="classes.length === 0" class="text-center py-16 text-slate-600">
      <School :size="52" :stroke-width="1" class="mx-auto mb-4 opacity-30" />
      <div class="font-bold text-slate-500">Класи не призначені</div>
      <div class="text-sm mt-1">Попросіть адміністратора призначити вас до класу</div>
    </div>

    <div v-else class="grid md:grid-cols-2 gap-4">
      <div
        v-for="cls in classes"
        :key="cls.id"
        class="glass-card p-6 cursor-pointer hover:border-violet-500/60 transition-all duration-200 active:scale-[0.98]"
        @click="router.push(`/teacher/class/${cls.id}`)"
      >
        <div class="flex items-start gap-4">
          <div class="text-5xl">{{ cls.icon || '🏫' }}</div>
          <div>
            <div class="font-extrabold text-xl">{{ cls.name }}</div>
            <div class="flex gap-4 mt-2 text-sm">
              <span class="text-violet-300 font-bold">{{ (cls.studentIds || []).length }} учнів</span>
            </div>
          </div>
        </div>
        <div class="mt-4 tab-active font-bold text-sm px-4 py-2 rounded-xl text-center">
          Нарахувати монети
        </div>
      </div>
    </div>
  </div>
</template>
