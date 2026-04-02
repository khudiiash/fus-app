<script setup>
defineProps({
  glow:   { type: String,  default: null },  // primary | coin | xp | rare | epic | legendary
  padded: { type: Boolean, default: true },
  raised: { type: Boolean, default: false },  // extra elevation
})
</script>

<template>
  <div
    class="glass-card animate-fade-in"
    :class="[
      padded ? 'p-4' : '',
      raised ? 'raised' : '',
      glow === 'primary'   ? 'glow-primary'   : '',
      glow === 'coin'      ? 'glow-coin'       : '',
      glow === 'xp'        ? 'glow-xp'         : '',
      glow === 'rare'      ? 'glow-rare'       : '',
      glow === 'epic'      ? 'glow-epic'       : '',
      glow === 'legendary' ? 'glow-legendary'  : '',
    ]"
  >
    <slot />
  </div>
</template>

<style scoped>
.raised {
  box-shadow:
    inset 0 0 0 1px rgba(255, 255, 255, 0.1),
    0 16px 48px rgba(0, 0, 0, 0.55),
    0 4px 12px rgba(0, 0, 0, 0.4);
}
</style>
