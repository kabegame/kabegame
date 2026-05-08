<template>
  <div class="task-counts-inline">
    <span class="count-item count-success" :class="{ 'is-zero': success === 0 }"
      :title="t('tasks.totalCount', { n: success })">
      <el-icon>
        <CircleCheck />
      </el-icon>
      <span>{{ success }}</span>
    </span>
    <span class="count-item count-failed" :class="{ 'is-zero': failed === 0 }"
      :title="t('tasks.failedCount', { n: failed })">
      <el-icon>
        <WarningFilled />
      </el-icon>
      <span>{{ failed }}</span>
    </span>
    <span class="count-item count-deleted" :class="{ 'is-zero': deleted === 0 }"
      :title="t('tasks.deletedCount', { n: deleted })">
      <el-icon>
        <Delete />
      </el-icon>
      <span>{{ deleted }}</span>
    </span>
    <span class="count-item count-dedup" :class="{ 'is-zero': dedup === 0 }"
      :title="t('tasks.dedupCount', { n: dedup })">
      <el-icon>
        <CopyDocument />
      </el-icon>
      <span>{{ dedup }}</span>
    </span>
    <span v-if="duration" class="count-duration">{{ duration }}</span>
  </div>
</template>

<script setup lang="ts">
import { CircleCheck, CopyDocument, Delete, WarningFilled } from "@element-plus/icons-vue";
import { useI18n } from "@kabegame/i18n";

defineProps<{
  success: number;
  failed: number;
  deleted: number;
  dedup: number;
  duration?: string;
}>();

const { t } = useI18n();
</script>

<style scoped lang="scss">
.task-counts-inline {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 4px;
  font-size: 12px;
  color: var(--anime-text-secondary);

  .count-item {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
    transition: opacity 0.15s ease;

    .el-icon {
      font-size: 14px;
    }

    &.is-zero {
      opacity: 0.38;
    }
  }

  .count-success {
    color: #67c23a;
  }

  .count-failed {
    color: #f56c6c;
  }

  .count-deleted {
    color: var(--el-text-color-secondary, #909399);

    .el-icon,
    span {
      color: inherit;
    }
  }

  .count-dedup {
    color: var(--anime-text-muted);
  }

  .count-duration {
    color: var(--anime-text-muted);
    font-size: 11px;
    white-space: nowrap;
  }
}
</style>
