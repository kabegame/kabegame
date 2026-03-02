<template>
  <OptionPickerDrawer
    :model-value="modelValue"
    :title="title"
    :options="mediaOptions"
    class="media-picker-drawer"
    @update:model-value="$emit('update:modelValue', $event)"
    @select="handleSelect"
  />
</template>

<script setup lang="ts">
import { computed } from "vue";
import { Picture, FolderOpened, Box } from "@element-plus/icons-vue";
import OptionPickerDrawer from "@/components/common/OptionPickerDrawer.vue";
import type { OptionItem } from "@/components/common/OptionPickerDrawer.vue";
import { pickFolder, type PickFolderResult } from "tauri-plugin-picker-api";

interface Props {
  modelValue: boolean;
  title?: string;
}

const props = withDefaults(defineProps<Props>(), {
  title: "选择导入方式",
});

const emit = defineEmits<{
  (e: "update:modelValue", v: boolean): void;
  (e: "select", type: "image" | "folder" | "archive", payload?: PickFolderResult): void;
}>();

const mediaOptions = computed<OptionItem[]>(() => [
  {
    id: "image",
    title: "选择图片",
    desc: "从手机相册选择一张或多张图片",
    icon: Picture,
  },
  {
    id: "folder",
    title: "选择文件夹",
    desc: "选择一个包含图片的文件夹",
    icon: FolderOpened,
  },
  {
    id: "archive",
    title: "选择压缩文件",
    desc: "支持 .zip 格式",
    icon: Box,
  },
]);

// 受控：仅通过 modelValue 控制显示；选择时发 select，由父组件关闭
// 移动端选文件夹时在此调用 picker 插件并带上结果
const handleSelect = async (id: string) => {
  const type = id as "image" | "folder" | "archive";
  if (type === "folder") {
    const result = await pickFolder();
    if (result?.uri ?? result?.path) {
      emit("select", "folder", result);
    }
    return;
  }
  emit("select", type);
};
</script>

<style lang="scss" scoped>
.media-picker-drawer {
  :deep(.el-drawer__header) {
    margin-bottom: 20px;
    padding: 20px 20px 0;
  }

  :deep(.el-drawer__body) {
    padding: 20px;
  }

  &:deep(.el-drawer.btt) {
    .el-drawer__body {
      padding-bottom: calc(20px + env(safe-area-inset-bottom, 0px));
    }
  }
}
</style>
