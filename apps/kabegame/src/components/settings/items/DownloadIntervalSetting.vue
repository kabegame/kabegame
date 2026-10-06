<template>
  <!-- 不套外层容器：SettingRow 的控件格靠 justify-end 右对齐，多一层 width:100% 的包裹会把控件顶到左边 -->
  <AndroidPickerDuration
    v-if="uiStore.isCompact"
    :model-value="localValue"
    :title="$t('settings.downloadIntervalTitle')"
    :disabled="disabled"
    @update:model-value="onChange"
  />
  <KbNumber
    v-else
    v-model="inputValue"
    type="int"
    class="!w-[150px]"
    :min="100"
    :max="10000"
    :step="100"
    :disabled="disabled"
    @change="onCommit"
  />
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { useSettingKeyState } from "@/composables/useSettingKeyState";
import AndroidPickerDuration from "@/components/AndroidPickerDuration.vue";
import KbNumber from "@/components/common/form/KbNumber.vue";
import { useUiStore } from "@/stores/ui";

const { settingValue, disabled, set } = useSettingKeyState("downloadIntervalMs");
const localValue = ref<number>(500);
/** 桌面输入框的原始值：编辑中可能是非法文本（string），提交后回到 localValue */
const inputValue = ref<number | string | undefined>(500);

const clamp = (v: number) => Math.max(100, Math.min(10000, Math.round(v / 100) * 100));

watch(
  () => settingValue.value,
  (v) => {
    const n = typeof v === "number" ? v : Number(v);
    localValue.value = Number.isFinite(n) ? clamp(n) : 500;
    inputValue.value = localValue.value;
  },
  { immediate: true },
);

const uiStore = useUiStore();

const onChange = async (v: number | undefined) => {
  if (typeof v !== "number" || !Number.isFinite(v)) return;
  const clamped = clamp(v);
  localValue.value = clamped;
  inputValue.value = clamped;
  await set(clamped);
};

/** 非法文本回退到已保存值；值未变（如回车后再失焦）不重复保存 */
const onCommit = async (v: number | undefined) => {
  if (v === undefined || clamp(v) === localValue.value) {
    inputValue.value = localValue.value;
    return;
  }
  await onChange(v);
};
</script>
