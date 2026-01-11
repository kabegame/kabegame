<template>
  <ContextMenu :visible="visible" :position="position" :items="menuItems" @close="$emit('close')"
    @command="$emit('command', $event)" />
</template>

<script setup lang="ts">
import { computed } from "vue";
import {
  Picture,
  Star,
  StarFilled,
  FolderAdd,
  Delete,
} from "@element-plus/icons-vue";
import type { ImageInfo } from "@/stores/crawler";
import ContextMenu, { type MenuItem } from "@kabegame/core/components/ContextMenu.vue";

interface Props {
  visible: boolean;
  position: { x: number; y: number };
  image: ImageInfo | null;
  selectedCount: number;
  isImageSelected: boolean; // 右键的图片是否在选中列表中
  hide?: string[]; // 要隐藏的菜单项 key 列表
  removeText?: string; // "移除"菜单项文案（不同页面可定制）
  simplified?: boolean; // 是否只显示简化菜单（复制、移除）
}

const props = withDefaults(defineProps<Props>(), {
  hide: () => [],
  removeText: "删除",
  simplified: false,
});

// 简化模式菜单项模板（多选时不显示复制选项，因为浏览器限制一次只能复制一张图片）
const getSimplifiedMenuItemsTemplate = (countText: string, removeText: string): MenuItem[] => [
  {
    key: "remove",
    type: "item",
    label: removeText,
    icon: Delete,
    command: "remove",
    suffix: countText,
  },
];

// 完整模式菜单项模板（多选时不显示复制选项，因为浏览器限制一次只能复制一张图片）
const getFullMenuItemsTemplate = (countText: string, removeText: string, image: ImageInfo | null): MenuItem[] => [
  {
    key: "favorite",
    type: "item",
    label: image?.favorite ? "取消收藏" : "收藏",
    icon: image?.favorite ? StarFilled : Star,
    command: "favorite",
    suffix: countText,
  },
  {
    key: "addToAlbum",
    type: "item",
    label: "加入画册",
    icon: FolderAdd,
    command: "addToAlbum",
    suffix: countText,
  },
  {
    key: "wallpaper",
    type: "item",
    label: "抱到桌面上",
    icon: Picture,
    command: "wallpaper",
  },
  { key: "divider", type: "divider" },
  {
    key: "remove",
    type: "item",
    label: removeText,
    icon: Delete,
    command: "remove",
    suffix: countText,
  },
];

const menuItems = computed<MenuItem[]>(() => {
  const hideSet = new Set(props.hide);
  const countText = `(${props.selectedCount})`;

  // 简化模式：只显示复制和删除
  if (props.simplified) {
    const items = getSimplifiedMenuItemsTemplate(countText, props.removeText);
    return items.filter((item) => !item.key || !hideSet.has(item.key));
  }

  // 完整模式：只有当右键的图片在选中列表中时才显示批量操作
  if (!props.isImageSelected) {
    return [];
  }

  const items = getFullMenuItemsTemplate(countText, props.removeText, props.image);
  // 根据 hide 列表过滤菜单项
  return items.filter((item) => !item.key || !hideSet.has(item.key));
});

defineEmits<{
  close: [];
  command: [command: string];
}>();
</script>

<style scoped lang="scss"></style>
