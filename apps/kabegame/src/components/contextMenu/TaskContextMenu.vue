<template>
  <ContextMenu
    :visible="visible"
    :position="position"
    :items="menuItems"
    :z-index="zIndex"
    @close="$emit('close')"
    @command="$emit('command', $event)"
  />
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "@kabegame/i18n";
import {
  Collection,
  Delete,
  Document,
  InfoFilled,
  Picture,
  RefreshRight,
  VideoPause,
} from "@kabegame/element-plus-icons";
import ContextMenu, { type MenuItem } from "@/components/ContextMenu.vue";

interface Props {
  visible: boolean;
  zIndex: number;
  position: { x: number; y: number };
  task: any | null;
  canRerun: boolean;
}

const props = defineProps<Props>();
const { t } = useI18n();

const menuItems = computed<MenuItem[]>(() => {
  const items: MenuItem[] = [];

  // 停止任务（只在运行中时显示）
  if (props.task?.status === "running" || props.task?.status === "waiting_downloads") {
    items.push({
      key: "stop",
      type: "item",
      label: t("contextMenu.stopTask"),
      icon: VideoPause,
      command: "stop",
      className: "warning",
    });
  }

  // 详情
  items.push({
    key: "detail",
    type: "item",
    label: t("contextMenu.taskDetail"),
    icon: InfoFilled,
    command: "detail",
  });

  // 图片
  items.push({
    key: "images",
    type: "item",
    label: t("contextMenu.taskImages"),
    icon: Picture,
    command: "images",
  });

  // 日志
  items.push({
    key: "log",
    type: "item",
    label: t("contextMenu.taskLog"),
    icon: Document,
    command: "log",
  });

  // 再次执行
  if (props.canRerun) {
    items.push({
      key: "rerun",
      type: "item",
      label: t("contextMenu.rerunTask"),
      icon: RefreshRight,
      command: "rerun",
    });
  }

  // 保存为配置
  items.push({
    key: "save-config",
    type: "item",
    label: t("contextMenu.saveAsConfig"),
    icon: Collection,
    command: "save-config",
  });

  // 分隔符
  items.push({ key: "divider", type: "divider" });

  // 删除任务
  items.push({
    key: "delete",
    type: "item",
    label: t("contextMenu.deleteTask"),
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
