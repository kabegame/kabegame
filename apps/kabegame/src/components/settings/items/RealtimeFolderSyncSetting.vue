<template>
  <el-switch
    v-model="localValue"
    :disabled="props.disabled || disabled"
    :loading="showDisabled"
    @change="handleChange"
  />
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { useI18n } from "@kabegame/i18n";
import { useSettingKeyState } from "@kabegame/core/composables/useSettingKeyState";

const props = defineProps<{
  disabled?: boolean;
}>();

const { t } = useI18n();
const { settingValue, disabled, showDisabled, set } = useSettingKeyState("realtimeFolderSync");
const localValue = ref(false);

watch(
  () => settingValue.value,
  (value) => {
    localValue.value = !!value;
  },
  { immediate: true },
);

const handleChange = async (value: boolean) => {
  try {
    await set(value);
    ElMessage.success(value ? t("settings.realtimeFolderSyncOn") : t("settings.realtimeFolderSyncOff"));
  } catch (error: any) {
    ElMessage.error(error?.message || String(error));
  }
};
</script>
