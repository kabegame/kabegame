<template>
  <el-input :model-value="modelValue || ''" :placeholder="placeholder" clearable @update:model-value="onInput">
    <template #append>
      <el-button @click="pickDir">
        <el-icon><FolderOpened /></el-icon>
        {{ $t("common.chooseFolder") }}
      </el-button>
    </template>
  </el-input>
</template>

<script setup lang="ts">
import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpened } from "@element-plus/icons-vue";

const props = withDefaults(
  defineProps<{
    modelValue?: string;
    placeholder?: string;
  }>(),
  { placeholder: "" },
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();

const onInput = (v: string) => {
  emit("update:modelValue", v ?? "");
};

const pickDir = async () => {
  try {
    const selected = await open({ directory: true, multiple: false });
    if (selected && typeof selected === "string") {
      emit("update:modelValue", selected);
    }
  } catch (e) {
    console.error("选择目录失败:", e);
  }
};
</script>
