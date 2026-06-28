<template>
  <el-radio-group :model-value="radioValue" :disabled="props.disabled || disabled" :loading="showDisabled" @change="onChange">
    <el-radio v-for="opt in options" :key="String(opt.value)" :value="opt.value">{{ opt.label }}</el-radio>
  </el-radio-group>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useSettingKeyState } from "../../../composables/useSettingKeyState";
import { type AppSettingKey } from "../../../stores/settings";

type Option = { label: string; value: string };

const props = defineProps<{
  settingKey: AppSettingKey;
  options: Option[];
  disabled?: boolean;
}>();

const { settingValue, disabled, showDisabled, set } = useSettingKeyState(props.settingKey);
const radioValue = computed(() => settingValue.value == null ? "" : String(settingValue.value));

const onChange = async (v: any) => {
  const val = String(v);
  await set(val);
};
</script>

