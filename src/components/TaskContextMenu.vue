<template>
  <ContextMenu :visible="visible" :position="position" @close="$emit('close')">
    <div class="context-menu-item" @click.stop="$emit('command', 'view')">
      <el-icon><FolderOpened /></el-icon>
      <span class="label">查看文件</span>
    </div>
    <div class="context-menu-item" @click.stop="$emit('command', 'save-config')">
      <el-icon><Collection /></el-icon>
      <span class="label">保存为配置</span>
    </div>
    <div class="context-menu-divider"></div>
    <div class="context-menu-item danger" @click.stop="$emit('command', 'delete')">
      <el-icon><Delete /></el-icon>
      <span class="label">删除任务</span>
    </div>
  </ContextMenu>
</template>

<script setup lang="ts">
import { FolderOpened, Collection, Delete } from "@element-plus/icons-vue";
import ContextMenu from "@/components/ContextMenu.vue";

interface Props {
  visible: boolean;
  position: { x: number; y: number };
}

defineProps<Props>();

defineEmits<{
  close: [];
  command: [command: string];
}>();
</script>

<style scoped lang="scss">
.label {
  margin-left: 8px;
}
.danger {
  color: #e74c3c;
}
</style>

