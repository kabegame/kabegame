<template>
  <el-card class="info-card" shadow="hover">
    <template #header>
      <div class="card-header">
        <el-icon class="header-icon">
          <Document />
        </el-icon>
        <span>插件信息</span>
      </div>
    </template>
    <el-form label-width="80px">
      <el-form-item label="插件ID">
        <el-input :model-value="pluginId" @update:model-value="$emit('update:pluginId', $event)" placeholder="my-plugin" />
      </el-form-item>
      <el-form-item label="名称">
        <el-input :model-value="manifest.name" @update:model-value="updateManifestField('name', $event)" placeholder="我的插件" />
      </el-form-item>
      <el-form-item label="版本">
        <el-input :model-value="manifest.version" @update:model-value="updateManifestField('version', $event)" placeholder="1.0.0" />
      </el-form-item>
      <el-form-item label="作者">
        <el-input :model-value="manifest.author" @update:model-value="updateManifestField('author', $event)" placeholder="Kabegame" />
      </el-form-item>
      <el-form-item label="描述">
        <el-input :model-value="manifest.description" @update:model-value="updateManifestField('description', $event)" type="textarea" :rows="3" placeholder="插件描述" />
      </el-form-item>
      <el-form-item label="图标">
        <div class="icon-picker" @click="$emit('select-icon')">
          <img v-if="iconPreviewUrl" :src="iconPreviewUrl" class="icon-preview" />
          <div v-else class="icon-placeholder">
            <el-icon style="font-size: 32px; color: var(--anime-text-muted)">
              <Picture />
            </el-icon>
          </div>
        </div>
      </el-form-item>
    </el-form>
  </el-card>
</template>

<script setup lang="ts">
import { Document, Picture } from "@element-plus/icons-vue";

const props = defineProps<{
  pluginId: string;
  manifest: {
    name: string;
    version: string;
    description: string;
    author: string;
  };
  iconPreviewUrl: string | null;
}>();

const emit = defineEmits<{
  "select-icon": [];
  "update:pluginId": [value: string];
  "update:manifest": [value: { name: string; version: string; description: string; author: string }];
}>();

// 更新 manifest 的某个字段
function updateManifestField(field: keyof typeof props.manifest, value: string) {
  emit("update:manifest", { ...props.manifest, [field]: value });
}
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

/* Icon 选择器 */
.icon-picker {
  width: 80px;
  height: 80px;
  border: 2px dashed var(--anime-border);
  border-radius: 12px;
  cursor: pointer;
  overflow: hidden;
  transition: all 0.3s ease;
  position: relative;

  &:hover {
    border-color: var(--anime-primary);
    background: rgba(255, 107, 157, 0.05);
  }
}

.icon-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.02);
}

.icon-preview {
  width: 100%;
  height: 100%;
  object-fit: cover;
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

:deep(.el-textarea__inner) {
  border-radius: 8px;
  font-family: inherit;
}
</style>