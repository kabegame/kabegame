<template>
  <!-- 读取 / 保存中（showDisabled）同样禁用：原 el-switch 的 loading 态本身就不可切换 -->
  <Switch
    :model-value="!!settingValue"
    :disabled="props.disabled || disabled || showDisabled"
    @update:model-value="onChange"
  />
</template>

<script setup lang="ts">
import Switch from "@/components/ui/Switch.vue";
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
