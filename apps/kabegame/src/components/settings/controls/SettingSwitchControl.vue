<template>
  <el-switch
    :model-value="!!settingValue"
    :disabled="props.disabled || disabled"
    :loading="showDisabled"
    @update:model-value="onChange"
  />
</template>

<script setup lang="ts">
import { useSettingKeyState } from "../../../composables/useSettingKeyState";
import { type AppSettingKey } from "../../../stores/settings";

const props = defineProps<{
  settingKey: AppSettingKey;
  disabled?: boolean;
}>();

const { settingValue, disabled, showDisabled, set } = useSettingKeyState(props.settingKey);

const onChange = async (v: string | number | boolean) => {
  await set(v === true); // el-switch 只抛 activeValue / inactiveValue，本控件用默认值，运行时恒为 boolean
};
</script>
