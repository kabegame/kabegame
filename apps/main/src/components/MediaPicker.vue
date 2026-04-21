<template>
  <OptionPickerDrawer
    :model-value="modelValue"
    :title="resolvedTitle"
    :options="mediaOptions"
    class="media-picker-drawer"
    @update:model-value="$emit('update:modelValue', $event)"
    @select="handleSelect"
  />
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "@kabegame/i18n";
import { Picture, FolderOpened, Box, VideoPlay } from "@element-plus/icons-vue";
import OptionPickerDrawer from "@/components/common/OptionPickerDrawer.vue";
import type { OptionItem } from "@/components/common/OptionPickerDrawer.vue";
import { pickFolder, type PickFolderResult } from "tauri-plugin-picker-api";
import { guardDesktopOnly } from "@/utils/desktopOnlyGuard";
import { useApp } from "@/stores/app";
import { useUiStore } from "@kabegame/core/stores/ui";
import { IS_WEB } from "@kabegame/core/env";

interface Props {
  modelValue: boolean;
  title?: string;
}

const props = withDefaults(defineProps<Props>(), {
  title: undefined,
});
const { t } = useI18n();
const resolvedTitle = computed(() => props.title ?? t('gallery.chooseImportMethod'));
const appStore = useApp();

const emit = defineEmits<{
  (e: "update:modelValue", v: boolean): void;
  (e: "select", type: "image" | "folder" | "video" | "archive", payload?: PickFolderResult): void;
}>();

const mediaOptions = computed<OptionItem[]>(() => [
  {
    id: "image",
    title: t('gallery.selectImage'),
    desc: t('gallery.selectImageDesc'),
    icon: Picture,
  },
  {
    id: "video",
    title: t('gallery.selectVideo'),
    desc: t('gallery.selectVideoDesc'),
    icon: VideoPlay,
  },
  ...(IS_WEB ? [] : [{
    id: "folder",
    title: t('gallery.selectFolder'),
    desc: t('gallery.selectFolderDesc'),
    icon: FolderOpened,
  }]),
  {
    id: "archive",
    title: t('gallery.selectArchive'),
    desc: t('gallery.selectArchiveDesc'),
    icon: Box,
  },
]);

// 受控：仅通过 modelValue 控制显示；选择时发 select，由父组件关闭
// 移动端选文件夹时在此调用 picker 插件并带上结果
const handleSelect = async (id: string) => {
  if (!appStore.isSuper && await guardDesktopOnly("picker")) return;
  const type = id as "image" | "folder" | "video" | "archive";
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
      padding-bottom: calc(20px + var(--sab, env(safe-area-inset-bottom, 0px)));
    }
  }
}
</style>
