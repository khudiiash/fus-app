<script setup>
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { getClass } from '@/firebase/collections'
import { School, ChevronRight, Users } from 'lucide-vue-next'
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

    <div v-else class="flex flex-col gap-2.5">
      <button
        v-for="cls in classes"
        :key="cls.id"
        type="button"
        class="glass-card w-full text-left flex items-center gap-3.5 p-3.5 rounded-2xl border border-white/[0.06] hover:border-violet-500/45 active:scale-[0.99] transition-all duration-200"
        @click="router.push(`/teacher/class/${cls.id}`)"
      >
        <div
          class="w-11 h-11 rounded-xl flex items-center justify-center text-xl shrink-0 bg-white/[0.06] ring-1 ring-white/[0.08]"
          aria-hidden="true"
        >
          {{ cls.icon || '🏫' }}
        </div>
        <div class="flex-1 min-w-0 py-0.5">
          <div class="font-extrabold text-base text-white truncate leading-tight">{{ cls.name }}</div>
          <div class="flex items-center gap-1.5 mt-1 text-xs text-slate-500">
            <Users :size="13" :stroke-width="2" class="text-slate-500 shrink-0" />
            <span>{{ (cls.studentIds || []).length }} учнів</span>
          </div>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <span class="hidden sm:inline text-[11px] font-bold text-amber-400/90 whitespace-nowrap">Монети</span>
          <span
            class="inline-flex items-center gap-1 rounded-xl px-2.5 py-2 text-[11px] font-extrabold text-slate-900 tab-active"
          >
            <span class="max-[380px]:hidden">Нарахувати</span>
            <ChevronRight :size="16" :stroke-width="2.5" class="text-slate-900 opacity-90" />
          </span>
        </div>
      </button>
    </div>
  </div>
</template>
