<script setup>
defineProps({
  modelValue:  [String, Number],
  label:       String,
  placeholder: String,
  type:        { type: String, default: 'text' },
  error:       String,
  icon:        String,
})
defineEmits(['update:modelValue'])
</script>

<template>
  <div class="flex flex-col gap-1.5">
    <label v-if="label" class="text-sm font-bold text-slate-300">{{ label }}</label>
    <div class="relative">
      <span v-if="icon" class="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-lg">{{ icon }}</span>
      <input
        :value="modelValue"
        :type="type"
        :placeholder="placeholder"
        class="app-input w-full rounded-2xl px-4 py-3 text-slate-100 placeholder-slate-500 focus:outline-none transition-all font-semibold"
        :class="icon ? 'pl-10' : ''"
        @input="$emit('update:modelValue', $event.target.value)"
      />
    </div>
    <p v-if="error" class="text-xs text-red-400 font-semibold">{{ error }}</p>
  </div>
</template>

<style scoped>
.app-input {
  background: rgba(255, 255, 255, 0.05);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.08);
}
.app-input:focus {
  background: rgba(255, 255, 255, 0.07);
  box-shadow:
    inset 0 0 0 1px rgba(124, 58, 237, 0.6),
    0 0 0 3px rgba(124, 58, 237, 0.12);
}
</style>
