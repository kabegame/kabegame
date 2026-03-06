<template>
  <el-dropdown trigger="click" @command="handleCommand">
    <el-button type="primary" class="collect-btn">
      <el-icon>
        <Plus />
      </el-icon>
      开始收集
      <el-icon class="el-icon--right">
        <ArrowDown />
      </el-icon>
    </el-button>
    <template #dropdown>
      <el-dropdown-menu>
        <el-dropdown-item command="local">
          <el-icon><FolderOpened /></el-icon>
          本地
        </el-dropdown-item>
        <el-dropdown-item command="network">
          <el-icon><Connection /></el-icon>
          网络
        </el-dropdown-item>
      </el-dropdown-menu>
    </template>
  </el-dropdown>
</template>

<script setup lang="ts">
import { Plus, ArrowDown, FolderOpened, Connection } from "@element-plus/icons-vue";

const emit = defineEmits<{
  action: [data: { type: string; value?: string }];
}>();

const handleCommand = (command: string) => {
  emit("action", { type: "select", value: command });
};
</script>

<style scoped lang="scss">
.collect-btn {
  box-shadow: var(--anime-shadow);

  &:hover {
    transform: translateY(-2px);
    box-shadow: var(--anime-shadow-hover);
  }
}
</style>