<template>
    <el-select v-model="localValue" :placeholder="placeholder" style="width: 100%" :clearable="clearable"
        :disabled="disabled || saving" @change="onChange">
        <el-option v-for="opt in options" :key="String(opt.value)" :label="opt.label" :value="opt.value" />
    </el-select>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore, type AppSettingKey } from "@/stores/settings";

type Option = { label: string; value: string | number | null };

const props = defineProps<{
    settingKey: AppSettingKey;
    command: string;
    buildArgs: (value: string | null) => Record<string, any>;
    options: Option[];
    placeholder?: string;
    clearable?: boolean;
    disabled?: boolean;
}>();

const settingsStore = useSettingsStore();
const saving = computed(() => settingsStore.savingByKey[props.settingKey] === true);
const localValue = ref<string | null>(null);

watch(
    () => (settingsStore.values as any)[props.settingKey],
    (v) => {
        localValue.value = v == null ? null : String(v);
    },
    { immediate: true }
);

const onChange = async (v: any) => {
    const value = v == null ? null : String(v);
    const prev = (settingsStore.values as any)[props.settingKey];
    (settingsStore.values as any)[props.settingKey] = value;
    settingsStore.savingByKey[props.settingKey] = true;
    try {
        await invoke(props.command, props.buildArgs(value));
    } catch (e) {
        (settingsStore.values as any)[props.settingKey] = prev;
        localValue.value = prev == null ? null : String(prev);
        ElMessage.error("保存设置失败");
        // eslint-disable-next-line no-console
        console.error(e);
    } finally {
        settingsStore.savingByKey[props.settingKey] = false;
    }
};
</script>
