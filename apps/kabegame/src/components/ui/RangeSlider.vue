<template>
  <SliderRoot
    :model-value="model"
    :min="min"
    :max="max"
    :step="step"
    :min-steps-between-thumbs="minStepsBetweenThumbs"
    :disabled="disabled"
    class="relative flex h-5 w-full touch-none select-none items-center data-[disabled]:opacity-50"
    @update:model-value="(v) => v && v.length === 2 && (model = [v[0], v[1]])"
    @value-commit="(v) => emit('commit', [v[0], v[1]])"
  >
    <SliderTrack class="relative h-1 grow overflow-hidden rounded-full bg-kb-fill-dark">
      <SliderRange class="absolute h-full rounded-full bg-kb-primary" />
    </SliderTrack>
    <SliderThumb
      v-for="i in 2"
      :key="i"
      :aria-label="label"
      class="block size-4 cursor-grab rounded-full border border-solid border-kb-line-strong bg-white shadow-kb-md outline-none transition-transform duration-100 hover:scale-110 focus-visible:ring-2 focus-visible:ring-kb-ring active:cursor-grabbing"
    />
  </SliderRoot>
</template>

<script setup lang="ts">
/** 区间滑块（v-model [起, 止]）。拖动中持续更新 v-model，松手时发 commit。 */
import { SliderRange, SliderRoot, SliderThumb, SliderTrack } from "reka-ui";

withDefaults(
  defineProps<{
    min?: number;
    max?: number;
    step?: number;
    /** 两个滑块之间至少隔几步 */
    minStepsBetweenThumbs?: number;
    disabled?: boolean;
    label?: string;
  }>(),
  { min: 0, max: 100, step: 1, minStepsBetweenThumbs: 0 },
);

const emit = defineEmits<{ commit: [[number, number]] }>();
const model = defineModel<[number, number]>({ default: () => [0, 0] });
</script>
