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

const onChange = async (v: boolean) => {
  await set(v);
};
</script>

