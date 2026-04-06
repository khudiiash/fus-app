<script setup>
import { computed } from 'vue'
/**
 * Student journal / home feed row: peer avatar when another user is involved,
 * clearer hierarchy, item & mystery-box previews.
 */
import AvatarDisplay from '@/components/avatar/AvatarDisplay.vue'
import CoinDisplay from '@/components/gamification/CoinDisplay.vue'
import TransactionItemThumb from '@/components/shop/TransactionItemThumb.vue'
import MysteryBoxSprite from '@/components/shop/MysteryBoxSprite.vue'
import {
  Coins, ArrowLeftRight, ShoppingBag, Trophy, Flame, ScrollText, Star,
  Gavel, Gift, Medal,
} from 'lucide-vue-next'

const props = defineProps({
  tx: { type: Object, required: true },
  items: { type: Array, default: () => [] },
  /** Tighter padding / smaller lead for home “остання активність” */
  compact: { type: Boolean, default: false },
  /** Учитель: вхідний предметний значок (інший заголовок) */
  teacherBadgeInbox: { type: Boolean, default: false },
})

const TX = {
  award:              { Icon: Coins,          label: 'Нарахування',       color: 'text-amber-400',   bg: 'bg-amber-500/12',   ring: 'ring-amber-500/25'   },
  fine:               { Icon: Gavel,          label: 'Штраф',             color: 'text-red-400',     bg: 'bg-red-500/12',     ring: 'ring-red-500/25'     },
  trade:              { Icon: ArrowLeftRight, label: 'Обмін',             color: 'text-sky-400',     bg: 'bg-sky-500/12',     ring: 'ring-sky-500/25'     },
  purchase:           { Icon: ShoppingBag,    label: 'Покупка',           color: 'text-violet-400',  bg: 'bg-violet-500/12',  ring: 'ring-violet-500/25'  },
  box_open:           { Icon: Gift,           label: 'Магічна коробка',   color: 'text-amber-400',   bg: 'bg-amber-500/12',   ring: 'ring-amber-500/25'   },
  badge_sent:         { Icon: Medal,          label: 'Передано значок',   color: 'text-amber-300',   bg: 'bg-amber-500/12',   ring: 'ring-amber-500/30'   },
  achievement_reward: { Icon: Trophy,         label: 'Досягнення',        color: 'text-emerald-400', bg: 'bg-emerald-500/12', ring: 'ring-emerald-500/25' },
  streak_bonus:       { Icon: Flame,          label: 'Бонус серії',       color: 'text-orange-400',  bg: 'bg-orange-500/12',  ring: 'ring-orange-500/25'  },
  quest_reward:       { Icon: ScrollText,     label: 'Завдання виконано', color: 'text-violet-300',  bg: 'bg-violet-500/12',  ring: 'ring-violet-500/25'  },
}

function cfg(t) {
  return TX[t] || { Icon: Star, label: t, color: 'text-slate-400', bg: 'bg-slate-500/12', ring: 'ring-slate-500/20' }
}

const rowLabel = computed(() => {
  if (props.teacherBadgeInbox && props.tx.type === 'badge_sent') {
    return 'Значок від учня'
  }
  return cfg(props.tx.type).label
})

function getItem(id) {
  return props.items.find((i) => i.id === id) || null
}

const boxMeta = computed(() => {
  const t = props.tx
  if (t.type !== 'box_open') return { rarity: 'common', name: 'Коробка' }

  const note = (t.note || '').trim()
  let meta = t.boxItemId ? getItem(t.boxItemId) : null

  // Legacy rows without boxItemId / boxRarity: match catalog by box name (note)
  if (!meta && note) {
    meta =
      props.items.find(
        (i) =>
          i.category === 'mystery_box' &&
          (i.name === note || (i.name || '').trim() === note),
      ) || null
  }

  const name = meta?.name || note || 'Коробка'
  const rarity = meta?.rarity || t.boxRarity || 'common'

  return { rarity, name }
})

function roleLabel(role) {
  if (role === 'teacher') return 'Вчитель'
  if (role === 'admin') return 'Адмін'
  return 'Учень'
}

/** Нарахування від вчителя/адміна: предмет у бейджі, коментар окремо (див. awardCoins subjectName). */
function parseTeacherAwardNote(tx) {
  const sn = (tx.subjectName || '').trim()
  const note = (tx.note || '').trim()
  if (sn) return { subject: sn, message: note }
  const sep = ' — '
  const i = note.indexOf(sep)
  if (i > 0) {
    return {
      subject: note.slice(0, i).trim(),
      message: note.slice(i + sep.length).trim(),
    }
  }
  return { subject: '', message: note }
}

const peerChipLabel = computed(() => {
  const peer = props.tx.peerProfile
  if (!peer) return ''
  const r = peer.role
  if (props.tx.type === 'badge_sent') {
    const sub = (props.tx.subjectName || '').trim()
    return sub || roleLabel(r)
  }
  if (props.tx.type === 'award' && (r === 'teacher' || r === 'admin')) {
    const { subject } = parseTeacherAwardNote(props.tx)
    if (subject) return subject
  }
  return roleLabel(r)
})

const messageBodyText = computed(() => {
  if (props.tx.type === 'box_open') return ''
  if (props.tx.type === 'badge_sent') {
    const sub = (props.tx.subjectName || '').trim()
    const name = (props.tx.note || '').trim()
    if (sub && name) return `${name} · ${sub}`
    if (props.teacherBadgeInbox) {
      return sub || name || 'Учень передав значок після офлайн-активності на уроці'
    }
    return sub || name || 'Подяка вчителю за офлайн-активність'
  }
  if (props.tx.type !== 'award') return (props.tx.note || '').trim()
  const peer = props.tx.peerProfile
  if (!peer || (peer.role !== 'teacher' && peer.role !== 'admin')) {
    return (props.tx.note || '').trim()
  }
  return parseTeacherAwardNote(props.tx).message
})

const subjectInChip = computed(() => {
  if (props.tx.type !== 'award' || !props.tx.peerProfile) return false
  const r = props.tx.peerProfile.role
  if (r !== 'teacher' && r !== 'admin') return false
  return !!parseTeacherAwardNote(props.tx).subject
})
</script>

<template>
  <div
    class="rounded-2xl border border-white/[0.07] bg-white/[0.03] backdrop-blur-sm"
    :class="compact ? 'p-3' : 'p-3.5'"
  >
    <div class="flex gap-3">
      <!-- Lead: peer avatar or type icon -->
      <div class="relative shrink-0">
        <AvatarDisplay
          v-if="tx.peerProfile"
          circle-only
          :avatar="tx.peerProfile.avatar"
          :display-name="tx.peerProfile.displayName"
          :items="items"
          size="sm"
          class="shadow-lg shadow-black/30 ring-2 ring-white/15 !ring-offset-0"
        />
        <div
          v-else
          :class="[
            'w-12 h-12 rounded-2xl flex items-center justify-center ring-1',
            cfg(tx.type).bg,
            cfg(tx.type).ring,
          ]"
        >
          <component :is="cfg(tx.type).Icon" :size="20" :stroke-width="1.85" :class="cfg(tx.type).color" />
        </div>
        <!-- Type badge when avatar shows peer -->
        <div
          v-if="tx.peerProfile"
          class="absolute -bottom-1 -right-1 w-6 h-6 rounded-lg flex items-center justify-center ring-2 ring-[#0a0a0a]"
          :class="cfg(tx.type).bg"
        >
          <component :is="cfg(tx.type).Icon" :size="12" :stroke-width="2" :class="cfg(tx.type).color" />
        </div>
      </div>

      <div class="flex-1 min-w-0 flex flex-col gap-2">
        <!-- Title row -->
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <div class="font-extrabold text-[15px] text-white leading-tight tracking-tight">
              {{ rowLabel }}
            </div>
            <div v-if="tx.peerProfile" class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span class="text-sm font-semibold text-slate-200 truncate">{{ tx.peerProfile.displayName }}</span>
              <span
                class="text-[10px] font-bold px-1.5 py-0.5 rounded-md bg-white/[0.06] max-w-[min(12rem,55vw)] truncate"
                :class="subjectInChip ? 'text-slate-200 tracking-tight normal-case' : 'uppercase tracking-wide text-slate-400'"
                :title="peerChipLabel"
              >
                {{ peerChipLabel }}
              </span>
            </div>
          </div>
          <CoinDisplay
            v-if="tx.type !== 'badge_sent' && tx.amount !== 0"
            :amount="tx.amount"
            :show-sign="tx.amount > 0"
            size="sm"
            class="shrink-0 pt-0.5"
          />
        </div>

        <!-- Message / note (box name lives in the box chip below) -->
        <div
          v-if="messageBodyText && tx.type !== 'box_open'"
          class="rounded-xl border border-white/[0.06] bg-black/25 px-3 py-2 text-sm text-slate-200/95 leading-snug"
        >
          <span class="text-slate-500 text-[10px] font-bold uppercase tracking-wider block mb-1">Повідомлення</span>
          {{ messageBodyText }}
        </div>

        <!-- Mystery box + loot row -->
        <div v-if="tx.type === 'box_open'" class="flex flex-wrap items-center gap-2">
          <div
            class="flex items-center gap-2 rounded-xl border border-amber-500/20 bg-amber-500/[0.07] px-2 py-1.5"
          >
            <MysteryBoxSprite :rarity="boxMeta.rarity" :size="compact ? 28 : 32" />
            <span class="text-xs font-bold text-amber-100/90 max-w-[120px] truncate">{{ boxMeta.name }}</span>
          </div>
          <template v-if="tx.itemIds?.length">
            <div
              v-for="itemId in tx.itemIds"
              :key="itemId"
              class="flex items-center gap-1.5 rounded-xl border border-white/[0.08] bg-white/[0.04] px-2 py-1"
              :title="getItem(itemId)?.name"
            >
              <TransactionItemThumb :item="getItem(itemId)" :w="24" :h="34" />
              <span class="text-xs font-semibold text-slate-300 max-w-[88px] truncate">
                {{ getItem(itemId)?.name || itemId }}
              </span>
            </div>
          </template>
        </div>

        <!-- Purchases / trades: items only (box row above handles box_open) -->
        <div
          v-else-if="tx.itemIds?.length"
          class="flex flex-wrap items-center gap-2"
        >
          <div
            v-for="itemId in tx.itemIds"
            :key="itemId"
            class="flex items-center gap-1.5 rounded-xl border border-white/[0.08] bg-white/[0.04] px-2 py-1"
            :title="getItem(itemId)?.name"
          >
            <TransactionItemThumb :item="getItem(itemId)" :w="24" :h="34" />
            <span class="text-xs font-semibold text-slate-300 max-w-[100px] truncate">
              {{ getItem(itemId)?.name || itemId }}
            </span>
          </div>
        </div>

        <div class="text-[11px] font-medium text-slate-500 tabular-nums">
          <slot name="time" />
        </div>
      </div>
    </div>
  </div>
</template>
