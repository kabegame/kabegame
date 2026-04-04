<template>
  <ContextMenu :visible="visible" :position="position" :items="menuItems" @close="$emit('close')"
    @command="$emit('command', $event)" />
</template>

<script setup lang="ts">
import { computed } from "vue";
import {
  InfoFilled,
  DocumentCopy,
  FolderOpened,
  Folder,
  Download,
  Delete,
  More,
} from "@element-plus/icons-vue";
import type { ImageInfo } from "../../types/image";
import ContextMenu, { type MenuItem } from "../ContextMenu.vue";

interface Props {
  visible: boolean;
  position: { x: number; y: number };
  image: ImageInfo | null;
  hide?: string[]; // 要隐藏的菜单项 key 列表
  removeText?: string;
}

const props = withDefaults(defineProps<Props>(), {
  hide: () => [],
  removeText: "删除",
});

// 注意：core 版右键菜单不包含“收藏/加入画册”
const getMenuItemsTemplate = (removeText: string): MenuItem[] => [
  { key: "detail", type: "item", label: "详情", icon: InfoFilled, command: "detail" },
  { key: "copy", type: "item", label: "复制图片", icon: DocumentCopy, command: "copy" },
  { key: "open", type: "item", label: "打开文件", icon: FolderOpened, command: "open" },
  { key: "openFolder", type: "item", label: "打开所在文件夹", icon: Folder, command: "openFolder" },
  {
    key: "more",
    type: "item",
    label: "更多",
    icon: More,
    children: [
      {
        key: "exportToWEAuto",
        type: "item",
        label: "导出到 Wallpaper Engine",
        icon: Download,
        command: "exportToWEAuto",
      },
    ],
  },
  { key: "divider", type: "divider" },
  { key: "remove", type: "item", label: removeText, icon: Delete, command: "remove" },
];

const menuItems = computed<MenuItem[]>(() => {
  const hideSet = new Set(props.hide);
  const items = getMenuItemsTemplate(props.removeText);
  return items.filter((item) => !item.key || !hideSet.has(item.key));
});

defineEmits<{
  close: [];
  command: [command: string];
}>();
</script>

<style scoped lang="scss"></style>


