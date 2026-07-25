<template>
  <div class="segmented-control" :class="{ 'is-disabled': disabled }" role="radiogroup">
    <button
      v-for="opt in options"
      :key="String(opt.value)"
      type="button"
      class="segmented-control-item"
      role="radio"
      :aria-checked="opt.value === modelValue"
      :class="{ 'is-active': opt.value === modelValue }"
      :disabled="disabled"
      @click="onSelect(opt.value)"
    >
      {{ opt.label }}
    </button>
  </div>
</template>

<script setup lang="ts">
type Option = { label: string; value: string };

const props = defineProps<{
  modelValue: string;
  options: Option[];
  disabled?: boolean;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: string): void;
}>();

function onSelect(value: string) {
  if (props.disabled || value === props.modelValue) return;
  emit("update:modelValue", value);
}
</script>

<style scoped>
.segmented-control {
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  gap: 2px;
  padding: 3px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--anime-primary) 9%, transparent);
}

.segmented-control.is-disabled {
  opacity: 0.6;
}

.segmented-control-item {
  appearance: none;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 28px;
  padding: 0 15px;
  border: none;
  border-radius: 9px;
  margin: 0;
  color: var(--anime-text-secondary);
  background: transparent;
  cursor: pointer;
  font: inherit;
  font-size: 13px;
  white-space: nowrap;
  transition: color 0.2s ease, background-color 0.2s ease, box-shadow 0.2s ease;
}

.segmented-control-item:disabled {
  cursor: not-allowed;
}

.segmented-control-item:not(.is-active):not(:disabled):hover {
  color: var(--anime-primary);
}

.segmented-control-item.is-active {
  color: #fff;
  font-weight: 600;
  background: linear-gradient(135deg, var(--anime-primary), var(--anime-secondary));
  box-shadow: 0 3px 10px rgba(255, 107, 157, 0.3);
}
</style>
