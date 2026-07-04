<template>
  <el-select
    :model-value="selectValue"
    :placeholder="placeholder"
    style="width: 100%"
    :clearable="clearable"
    :disabled="props.disabled || disabled" :loading="showDisabled"
    @update:model-value="onChange"
  >
    <el-option v-for="opt in options" :key="String(opt.value)" :label="opt.label" :value="opt.value" />
  </el-select>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useSettingKeyState } from "../../../composables/useSettingKeyState";
import { type AppSettingKey } from "../../../stores/settings";

type Option = { label: string; value: string | number | null };

const props = defineProps<{
  settingKey: AppSettingKey;
  options: Option[];
  placeholder?: string;
  clearable?: boolean;
  disabled?: boolean;
}>();

const { settingValue, disabled, showDisabled, set } = useSettingKeyState(props.settingKey);
const selectValue = computed(() => settingValue.value == null ? null : String(settingValue.value));

const onChange = async (v: any) => {
  const val = v == null ? null : String(v);
  await set(val);
};
</script>

