<template>
  <el-card class="info-card" shadow="hover">
    <template #header>
      <div class="card-header">
        <el-icon class="header-icon">
          <Setting />
        </el-icon>
        <span>配置</span>
      </div>
    </template>
    <el-form label-width="80px">
      <el-form-item label="基础URL">
        <el-input :model-value="baseUrl ?? ''" @update:model-value="$emit('update:baseUrl', $event)" placeholder="https://example.com" />
      </el-form-item>
    </el-form>
  </el-card>
</template>

<script setup lang="ts">
import { Setting } from "@element-plus/icons-vue";

defineProps<{
  baseUrl: string | undefined;
}>();

defineEmits<{
  "update:baseUrl": [value: string];
}>();
</script>

<style scoped lang="scss">
.info-card {
  flex-shrink: 0;

  // 移除悬浮时的运动效果
  &:hover {
    transform: none !important;
  }

  :deep(.el-card__header) {
    padding: 16px 20px;
    background: linear-gradient(135deg, rgba(255, 107, 157, 0.05) 0%, rgba(167, 139, 250, 0.05) 100%);
    border-bottom: 1px solid var(--anime-border);
  }

  :deep(.el-card__body) {
    padding: 20px;
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
}

/* 表单样式优化 */
:deep(.el-form-item) {
  margin-bottom: 18px;
}

:deep(.el-form-item__label) {
  font-weight: 500;
  color: var(--anime-text-primary);
}

:deep(.el-input__wrapper) {
  border-radius: 8px;
  transition: all 0.3s ease;
}
</style>