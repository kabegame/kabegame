<template>
  <ContextMenu :visible="visible" :position="position" :items="menuItems" @close="$emit('close')"
    @command="$emit('command', $event)" />
</template>

<script setup lang="ts">
import { computed } from "vue";
import { Delete } from "@element-plus/icons-vue";
import type { ImageInfo } from "../../types/image";
import ContextMenu, { type MenuItem } from "../ContextMenu.vue";

interface Props {
  visible: boolean;
  position: { x: number; y: number };
  image: ImageInfo | null;
  selectedCount: number;
  isImageSelected: boolean; // 右键的图片是否在选中列表中
  hide?: string[];
  removeText?: string;
}

const props = withDefaults(defineProps<Props>(), {
  hide: () => [],
  removeText: "删除",
});

// 注意：多选时不显示复制选项，因为浏览器限制一次只能复制一张图片到剪贴板
const getMenuItemsTemplate = (countText: string, removeText: string): MenuItem[] => [
  { key: "remove", type: "item", label: removeText, icon: Delete, command: "remove", suffix: countText },
];

const menuItems = computed<MenuItem[]>(() => {
  const hideSet = new Set(props.hide);
  const countText = `(${props.selectedCount})`;

  // 只有当右键的图片在选中列表中时才显示批量操作
  if (!props.isImageSelected) return [];

  const items = getMenuItemsTemplate(countText, props.removeText);
  return items.filter((item) => !item.key || !hideSet.has(item.key));
});

defineEmits<{
  close: [];
  command: [command: string];
}>();
</script>

<style scoped lang="scss"></style>


