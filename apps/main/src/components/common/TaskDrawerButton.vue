<template>
  <el-badge
    v-if="activeTasksCount > 0"
    :value="activeTasksCount"
    :max="99"
    class="tasks-badge"
  >
    <el-button
      @click="handleClick"
      class="tasks-drawer-trigger"
      circle
      type="primary"
    >
      <el-icon>
        <List />
      </el-icon>
    </el-button>
  </el-badge>
  <el-button
    v-else
    @click="handleClick"
    class="tasks-drawer-trigger"
    circle
    type="primary"
  >
    <el-icon>
      <List />
    </el-icon>
  </el-button>
</template>

<script setup lang="ts">
import { List } from "@element-plus/icons-vue";
import { useTaskDrawerStore } from "@/stores/taskDrawer";
import { storeToRefs } from "pinia";

const taskDrawerStore = useTaskDrawerStore();
const { activeTasksCount } = storeToRefs(taskDrawerStore);

const handleClick = () => {
  taskDrawerStore.toggle();
};
</script>

<style scoped lang="scss">
.tasks-drawer-trigger {
  box-shadow: var(--anime-shadow);
  transition: all 0.3s ease;

  &:hover {
    transform: translateY(-2px);
    box-shadow: var(--anime-shadow-hover);
  }
}

.tasks-badge {
  display: block;

  :deep(.el-badge__content) {
    background-color: #f56c6c !important;
    border-color: #f56c6c !important;
    color: #fff !important;
    border-radius: 50% !important;
    width: 20px !important;
    height: 20px !important;
    min-width: 20px !important;
    padding: 0 !important;
    line-height: 20px !important;
    font-size: 12px !important;
    font-weight: 500 !important;
    display: inline-flex !important;
    align-items: center !important;
    justify-content: center !important;
  }
}
</style>

