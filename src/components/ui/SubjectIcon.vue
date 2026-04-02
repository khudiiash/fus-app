<script setup>
import { computed } from 'vue'
import 'flag-icons/css/flag-icons.min.css'

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

const countryCode = computed(() => isFlagEmoji(props.icon) ? toCountryCode(props.icon) : null)
</script>

<template>
  <!-- CSS-based flag from the bundled flag-icons package -->
  <span
    v-if="countryCode"
    :class="`fi fi-${countryCode}`"
    :style="{ fontSize: size, lineHeight: 1, display: 'inline-block', verticalAlign: 'middle', borderRadius: '2px' }"
  />
  <!-- Regular emoji -->
  <span v-else :style="{ fontSize: size, lineHeight: 1 }">{{ icon }}</span>
</template>
