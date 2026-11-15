<template>
  <KbStepper
    v-if="isCompact"
    :model-value="local"
    :min="min"
    :max="max"
    :step-size="step"
    :precision="precision"
    :disabled="disabled"
    @update:model-value="commit"
  />
  <!-- 拖动中只改本地值（右侧数值跟手），松手（commit）才往外报，同设置页的 SettingSliderControl -->
  <div v-else class="flex w-[min(280px,100%)] min-w-0 items-center gap-3">
    <Slider
      v-model="local"
      class="min-w-[80px] flex-1"
      :min="min"
      :max="max"
      :step="step"
      :disabled="disabled"
      @commit="commit"
    />
    <span class="min-w-[2.5em] shrink-0 text-[12px] tabular-nums text-kb-fg-muted">{{ local.toFixed(precision) }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import Slider from "@/components/ui/Slider.vue";
import KbStepper from "@/components/common/form/KbStepper.vue";
import { useUiStore } from "@/stores/ui";

const props = defineProps<{
  modelValue: number;
  min: number;
  max: number;
  step: number;
  precision: number;
  disabled?: boolean;
}>();
const emit = defineEmits<{ commit: [value: number] }>();

const isCompact = computed(() => useUiStore().isCompact);
const local = ref(props.modelValue);
watch(
  () => props.modelValue,
  (value) => {
    local.value = value;
  },
);

function commit(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return;
  if (value === props.modelValue) return;
  emit("commit", value);
}
</script>
