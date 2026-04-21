<template>
  <AndroidPickerNumber
    v-if="isCompact"
    :model-value="localValue"
    :min="effectiveMin"
    :max="effectiveMax"
    :step="effectiveStep"
    title="选择数值"
    :disabled="props.disabled || disabled"
    @update:model-value="onChange"
  />
  <el-input-number
    v-else
    v-model="localValue"
    :min="typeof min === 'number' && !isNaN(min) ? min : undefined"
    :max="typeof max === 'number' && !isNaN(max) ? max : undefined"
    :step="step"
    :disabled="props.disabled || disabled"
    :loading="showDisabled"
    @change="onChange"
  />
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useSettingKeyState } from "../../../composables/useSettingKeyState";
import { type AppSettingKey } from "../../../stores/settings";
import { useUiStore } from "../../../stores/ui";
import AndroidPickerNumber from "../../AndroidPickerNumber.vue";

const props = defineProps<{
  settingKey: AppSettingKey;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
}>();

const isCompact = computed(() => useUiStore().isCompact);
const { settingValue, disabled, showDisabled, set } = useSettingKeyState(props.settingKey);
const localValue = ref<number>(0);

const effectiveMin = computed(() =>
  typeof props.min === "number" && !Number.isNaN(props.min) ? props.min : 0
);
const effectiveMax = computed(() =>
  typeof props.max === "number" && !Number.isNaN(props.max) ? props.max : 100
);
const effectiveStep = computed(() =>
  typeof props.step === "number" && props.step > 0 ? props.step : 1
);

watch(
  () => settingValue.value,
  (v) => {
    const n = typeof v === "number" ? v : Number(v);
    localValue.value = Number.isFinite(n) ? n : 0;
  },
  { immediate: true }
);

const onChange = async (v: number | undefined) => {
  if (typeof v !== "number" || !Number.isFinite(v)) return;
  await set(v);
};
</script>

