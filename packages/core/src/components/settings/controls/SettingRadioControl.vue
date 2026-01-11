<template>
  <el-radio-group v-model="localValue" :disabled="disabled || saving" @change="onChange">
    <el-radio v-for="opt in options" :key="String(opt.value)" :value="opt.value">{{ opt.label }}</el-radio>
  </el-radio-group>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore, type AppSettingKey } from "../../../stores/settings";

type Option = { label: string; value: string };

const props = defineProps<{
  settingKey: AppSettingKey;
  command: string;
  buildArgs: (value: string) => Record<string, any>;
  options: Option[];
  disabled?: boolean;
}>();

const settingsStore = useSettingsStore();
const saving = computed(() => settingsStore.savingByKey[props.settingKey] === true);
const localValue = ref<string>("");

watch(
  () => (settingsStore.values as any)[props.settingKey],
  (v) => {
    localValue.value = v == null ? "" : String(v);
  },
  { immediate: true }
);

const onChange = async (v: any) => {
  const value = String(v);
  const prev = (settingsStore.values as any)[props.settingKey];
  (settingsStore.values as any)[props.settingKey] = value;
  settingsStore.savingByKey[props.settingKey] = true;
  try {
    await invoke(props.command, props.buildArgs(value));
  } catch (e) {
    (settingsStore.values as any)[props.settingKey] = prev;
    localValue.value = prev == null ? "" : String(prev);
    ElMessage.error("保存设置失败");
    // eslint-disable-next-line no-console
    console.error(e);
  } finally {
    settingsStore.savingByKey[props.settingKey] = false;
  }
};
</script>

