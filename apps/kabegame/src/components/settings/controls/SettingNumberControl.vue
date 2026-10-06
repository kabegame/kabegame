<template>
  <KbStepper
    v-if="isCompact"
    :model-value="localValue"
    :min="effectiveMin"
    :max="effectiveMax"
    :step-size="effectiveStep"
    :disabled="props.disabled || disabled"
    @update:model-value="onChange"
  />
  <!-- 输入框随打随更新 inputValue，只在步进 / 失焦 / 回车（change）时保存一次 -->
  <KbNumber
    v-else
    v-model="inputValue"
    type="int"
    class="!w-[150px]"
    :min="typeof min === 'number' && !isNaN(min) ? min : undefined"
    :max="typeof max === 'number' && !isNaN(max) ? max : undefined"
    :step="step"
    :disabled="props.disabled || disabled"
    @change="onCommit"
  />
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useSettingKeyState } from "../../../composables/useSettingKeyState";
import { type AppSettingKey } from "../../../stores/settings";
import { useUiStore } from "../../../stores/ui";
import KbNumber from "../../common/form/KbNumber.vue";
import KbStepper from "../../common/form/KbStepper.vue";

const props = defineProps<{
  settingKey: AppSettingKey;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
}>();

const isCompact = computed(() => useUiStore().isCompact);
const { settingValue, disabled, set } = useSettingKeyState(props.settingKey);
const localValue = ref<number>(0);
/** 桌面输入框的原始值：编辑中可能是非法文本（string），提交后回到 localValue */
const inputValue = ref<number | string | undefined>(0);

const effectiveMin = computed(() => (typeof props.min === "number" && !Number.isNaN(props.min) ? props.min : 0));
const effectiveMax = computed(() => (typeof props.max === "number" && !Number.isNaN(props.max) ? props.max : 100));
const effectiveStep = computed(() => (typeof props.step === "number" && props.step > 0 ? props.step : 1));

watch(
  () => settingValue.value,
  (v) => {
    const n = typeof v === "number" ? v : Number(v);
    localValue.value = Number.isFinite(n) ? n : 0;
    inputValue.value = localValue.value;
  },
  { immediate: true },
);

const onChange = async (v: number | undefined) => {
  if (typeof v !== "number" || !Number.isFinite(v)) return;
  const ok = await set(v);
  if (!ok) {
    const current = Number(settingValue.value);
    localValue.value = Number.isFinite(current) ? current : 0;
  }
  inputValue.value = localValue.value;
};

/** 非法文本回退到已保存值；值未变（如回车后再失焦）不重复保存 */
const onCommit = async (v: number | undefined) => {
  if (v === undefined || v === localValue.value) {
    inputValue.value = localValue.value;
    return;
  }
  localValue.value = v;
  await onChange(v);
};
</script>
