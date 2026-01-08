<template>
  <el-input-number v-model="localValue" :min="min" :max="max" :step="step" :disabled="disabled || saving"
    @change="onChange" />
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore, type AppSettingKey } from "@kabegame/core/src/stores/settings";

const props = defineProps<{
  settingKey: AppSettingKey;
  command: string;
  buildArgs: (value: number) => Record<string, any>;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
}>();

const settingsStore = useSettingsStore();
const saving = computed(() => settingsStore.savingByKey[props.settingKey] === true);
const localValue = ref<number>(0);

watch(
  () => (settingsStore.values as any)[props.settingKey],
  (v) => {
    const n = typeof v === "number" ? v : Number(v);
    localValue.value = Number.isFinite(n) ? n : 0;
  },
  { immediate: true }
);

const onChange = async (v: number | undefined) => {
  if (typeof v !== "number" || !Number.isFinite(v)) return;
  const prev = (settingsStore.values as any)[props.settingKey] as any;
  (settingsStore.values as any)[props.settingKey] = v;
  settingsStore.savingByKey[props.settingKey] = true;
  try {
    await invoke(props.command, props.buildArgs(v));
  } catch (e) {
    (settingsStore.values as any)[props.settingKey] = prev;
    localValue.value = typeof prev === "number" ? prev : localValue.value;
    ElMessage.error("保存设置失败");
    // eslint-disable-next-line no-console
    console.error(e);
  } finally {
    settingsStore.savingByKey[props.settingKey] = false;
  }
};
</script>
