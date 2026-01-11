<template>
  <el-card class="console-card" shadow="hover">
    <template #header>
      <div class="card-header">
        <el-icon class="header-icon">
          <Monitor />
        </el-icon>
        <span>输出</span>
        <el-button v-if="consoleText" size="small" text @click="$emit('clear')" class="clear-btn">
          <el-icon>
            <Close />
          </el-icon>
          清空
        </el-button>
      </div>
    </template>
    <div class="console-wrapper">
      <pre class="console-body">{{ consoleText || "（空）" }}</pre>
    </div>
  </el-card>
</template>

<script setup lang="ts">
import { Monitor, Close } from "@element-plus/icons-vue";

defineProps<{
  consoleText: string;
}>();

defineEmits<{
  clear: [];
}>();
</script>

<style scoped lang="scss">
.console-card {
  height: 250px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;

  // 移除悬浮时的运动效果
  &:hover {
    transform: none !important;
  }

  :deep(.el-card__header) {
    padding: 12px 20px;
    background: linear-gradient(135deg, rgba(255, 107, 157, 0.05) 0%, rgba(167, 139, 250, 0.05) 100%);
    border-bottom: 1px solid var(--anime-border);
  }

  :deep(.el-card__body) {
    flex: 1;
    min-height: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  font-weight: 600;
  font-size: 15px;
  color: var(--anime-text-primary);

  .header-icon {
    font-size: 18px;
    color: var(--anime-primary);
  }

  .clear-btn {
    margin-left: auto;
  }
}

.console-wrapper {
  flex: 1;
  overflow: auto;
  padding: 16px 20px;
  user-select: text;
  -webkit-user-select: text;
  -moz-user-select: text;
  -ms-user-select: text;
}

.console-body {
  margin: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--anime-text-primary);
  background: rgba(0, 0, 0, 0.02);
  padding: 12px;
  border-radius: 8px;
  border: 1px solid var(--anime-border);
  user-select: text;
  -webkit-user-select: text;
  -moz-user-select: text;
  -ms-user-select: text;
  cursor: text;
}
</style>