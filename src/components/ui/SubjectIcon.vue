<script setup>
import { computed } from 'vue'
import '@/styles/flag-icons-subset.css'

const props = defineProps({
  icon: { type: String, default: '📖' },
  size: { type: String, default: '1.4em' },
})

// Regional indicator letters sit at U+1F1E6 ('A') … U+1F1FF ('Z')
// Spreading a flag emoji gives exactly 2 chars (one code point each).
// Subtracting 0x1F1E6 from each code point and offsetting to 'A' (0x41)
// yields the ISO 3166-1 alpha-2 country code, e.g. 🇵🇱 → "pl".
function isFlagEmoji(str) {
  if (!str) return false
  const pts = [...str].map(c => c.codePointAt(0))
  return pts.length === 2 && pts.every(p => p >= 0x1F1E6 && p <= 0x1F1FF)
}

function toCountryCode(emoji) {
  return [...emoji]
    .map(c => String.fromCharCode(c.codePointAt(0) - 0x1F1E6 + 0x41))
    .join('')
    .toLowerCase()
}

/** Only these ship in the bundle (see flag-icons-subset.css). Others use native emoji. */
const CSS_FLAG_CODES = new Set(['pl', 'ua', 'gb', 'de'])

const cssFlagCode = computed(() => {
  if (!isFlagEmoji(props.icon)) return null
  const code = toCountryCode(props.icon)
  return CSS_FLAG_CODES.has(code) ? code : null
})
</script>

<template>
  <!-- CSS flags: PL / UA / GB / DE (small bundle); other flag emojis render natively -->
  <span
    v-if="cssFlagCode"
    :class="`fi fi-${cssFlagCode}`"
    :style="{ fontSize: size, lineHeight: 1, display: 'inline-block', verticalAlign: 'middle', borderRadius: '2px' }"
  />
  <span v-else :style="{ fontSize: size, lineHeight: 1 }">{{ icon }}</span>
</template>
