<template>
  <div class="super-mode-toggle" :class="{ 'is-on': app.isSuper }">
    <el-tooltip :content="tooltipText" placement="right">
      <el-switch
        :model-value="app.isSuper"
        size="small"
        inline-prompt
        active-text="S"
        inactive-text="R"
        @update:model-value="(v) => app.setSuper(!!v)"
      />
    </el-tooltip>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { ElSwitch, ElTooltip } from "element-plus";
import { useApp } from "@/stores/app";

const app = useApp();

const tooltipText = computed(() =>
  app.isSuper
    ? "Super mode ON — 写操作已启用"
    : "Super mode OFF — 只读模式",
);
</script>

<style lang="scss" scoped>
.super-mode-toggle {
  position: fixed;
  left: 12px;
  bottom: 12px;
  z-index: 2000;
  padding: 6px 8px;
  border-radius: 999px;
  background: var(--el-bg-color-overlay);
  box-shadow: var(--el-box-shadow-light);
  display: flex;
  align-items: center;
  gap: 6px;
  transition: box-shadow 0.2s;

  &.is-on {
    box-shadow: 0 0 0 1px var(--el-color-primary), var(--el-box-shadow-light);
  }
}
</style>
