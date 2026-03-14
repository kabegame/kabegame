<template>
  <div class="download-interval-setting">
    <AndroidPickerDuration
      v-if="IS_ANDROID"
      :model-value="localValue"
      title="下载间隔时间"
      :disabled="disabled"
      @update:model-value="onChange"
    />
    <el-input-number
      v-else
      v-model="localValue"
      :min="100"
      :max="10000"
      :step="100"
      :disabled="disabled"
      :loading="showDisabled"
      @change="onChange"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { useSettingKeyState } from "@kabegame/core/composables/useSettingKeyState";
import { IS_ANDROID } from "@kabegame/core/env";
import AndroidPickerDuration from "@kabegame/core/components/AndroidPickerDuration.vue";

const { settingValue, disabled, showDisabled, set } = useSettingKeyState("downloadIntervalMs");
const localValue = ref<number>(500);

const clamp = (v: number) => Math.max(100, Math.min(10000, Math.round(v / 100) * 100));

watch(
  () => settingValue.value,
  (v) => {
    const n = typeof v === "number" ? v : Number(v);
    localValue.value = Number.isFinite(n) ? clamp(n) : 500;
  },
  { immediate: true }
);

const onChange = async (v: number | undefined) => {
  if (typeof v !== "number" || !Number.isFinite(v)) return;
  const clamped = clamp(v);
  localValue.value = clamped;
  await set(clamped);
};
</script>

<style scoped lang="scss">
.download-interval-setting {
  width: 100%;
}
</style>
