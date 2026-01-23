<template>
  <el-select
    v-model="localValue"
    :placeholder="placeholder"
    style="width: 100%"
    :clearable="clearable"
    :disabled="props.disabled || disabled" :loading="showDisabled"
    @change="onChange"
  >
    <el-option v-for="opt in options" :key="String(opt.value)" :label="opt.label" :value="opt.value" />
  </el-select>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
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
const localValue = ref<string | null>(null);

watch(
  () => settingValue.value,
  (v) => {
    localValue.value = v == null ? null : String(v);
  },
  { immediate: true }
);

const onChange = async (v: any) => {
  const val = v == null ? null : String(v);
  await set(val);
};
</script>

