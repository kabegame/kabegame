<template>
  <el-switch
    v-model="localValue"
    :disabled="disabled || saving"
    :loading="saving"
    @change="onChange"
  />
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore, type AppSettingKey } from "@/stores/settings";

const props = defineProps<{
  settingKey: AppSettingKey;
  command: string;
  /** 根据 value 构造 invoke 参数 */
  buildArgs: (value: boolean) => Record<string, any>;
  disabled?: boolean;
}>();

const settingsStore = useSettingsStore();

const saving = computed(() => settingsStore.savingByKey[props.settingKey] === true);
const localValue = ref<boolean>(false);

watch(
  () => (settingsStore.values as any)[props.settingKey],
  (v) => {
    localValue.value = !!v;
  },
  { immediate: true }
);

const onChange = async (v: boolean) => {
  const prev = !!(settingsStore.values as any)[props.settingKey];
  (settingsStore.values as any)[props.settingKey] = v;
  settingsStore.savingByKey[props.settingKey] = true;
  try {
    await invoke(props.command, props.buildArgs(v));
  } catch (e) {
    (settingsStore.values as any)[props.settingKey] = prev;
    localValue.value = prev;
    ElMessage.error("保存设置失败");
    // eslint-disable-next-line no-console
    console.error(e);
  } finally {
    settingsStore.savingByKey[props.settingKey] = false;
  }
};
</script>


