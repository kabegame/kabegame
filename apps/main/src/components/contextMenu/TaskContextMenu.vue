<template>
  <ContextMenu :visible="visible" :position="position" :items="menuItems" @close="$emit('close')"
    @command="$emit('command', $event)" />
</template>

<script setup lang="ts">
import { computed } from "vue";
import { FolderOpened, Collection, Delete, VideoPause } from "@element-plus/icons-vue";
import ContextMenu, { type MenuItem } from "@kabegame/core/components/ContextMenu.vue";

interface Props {
  visible: boolean;
  position: { x: number; y: number };
  task: any | null;
}

const props = defineProps<Props>();

const menuItems = computed<MenuItem[]>(() => {
  const items: MenuItem[] = [];

  // 停止任务（只在运行中时显示）
  if (props.task?.status === "running") {
    items.push({
      key: "stop",
      type: "item",
      label: "停止任务",
      icon: VideoPause,
      command: "stop",
      className: "warning",
    });
  }

  // 查看文件
  items.push({
    key: "view",
    type: "item",
    label: "查看文件",
    icon: FolderOpened,
    command: "view",
  });

  // 保存为配置
  items.push({
    key: "save-config",
    type: "item",
    label: "保存为配置",
    icon: Collection,
    command: "save-config",
  });

  // 分隔符
  items.push({ key: "divider", type: "divider" });

  // 删除任务
  items.push({
    key: "delete",
    type: "item",
    label: "删除任务",
    icon: Delete,
    command: "delete",
    className: "danger",
  });

  return items;
});

defineEmits<{
  close: [];
  command: [command: string];
}>();
</script>

<style scoped lang="scss">
:deep(.context-menu-item.danger) {
  color: #e74c3c;
}
</style>
