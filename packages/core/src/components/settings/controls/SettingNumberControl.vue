<template>
  <el-input-number
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
import { ref, watch } from "vue";
import { useSettingKeyState } from "../../../composables/useSettingKeyState";
import { type AppSettingKey } from "../../../stores/settings";

const props = defineProps<{
  settingKey: AppSettingKey;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
}>();

const { settingValue, disabled, showDisabled, set } = useSettingKeyState(props.settingKey);
const localValue = ref<number>(0);

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

