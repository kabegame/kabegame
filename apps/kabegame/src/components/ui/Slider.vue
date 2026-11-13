<template>
  <SliderRoot
    :model-value="[model ?? min]"
    :min="min"
    :max="max"
    :step="step"
    :disabled="disabled"
    class="relative flex h-5 w-full touch-none select-none items-center data-[disabled]:opacity-50"
    @update:model-value="(v) => v && (model = v[0])"
    @value-commit="(v) => emit('commit', v[0])"
  >
    <SliderTrack class="relative h-1 grow overflow-hidden rounded-full bg-kb-fill-dark">
      <SliderRange class="absolute h-full rounded-full bg-kb-primary" />
    </SliderTrack>
    <SliderThumb
      :aria-label="label"
      class="block size-4 cursor-grab rounded-full border border-solid border-kb-line-strong bg-white shadow-kb-md outline-none transition-transform duration-100 hover:scale-110 focus-visible:ring-2 focus-visible:ring-kb-ring active:cursor-grabbing"
    />
  </SliderRoot>
</template>

<script setup lang="ts">
/** 滑块（v-model 数值）。拖动中持续更新 v-model，松手时发 commit（写库这类开销大的放在 commit）。 */
import { SliderRange, SliderRoot, SliderThumb, SliderTrack } from "reka-ui";

withDefaults(defineProps<{ min?: number; max?: number; step?: number; disabled?: boolean; label?: string }>(), {
  min: 0,
  max: 100,
  step: 1,
});

const emit = defineEmits<{ commit: [number] }>();
const model = defineModel<number>();
</script>
