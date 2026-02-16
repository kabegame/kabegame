<template>
  <el-dropdown trigger="click" placement="bottom-end" @command="handleCommand">
    <el-button circle>
      <el-icon>
        <MoreFilled />
      </el-icon>
    </el-button>
    <template #dropdown>
      <el-dropdown-menu>
        <el-dropdown-item
          v-for="feature in features"
          :key="feature.id"
          :command="feature.id"
        >
          <el-icon style="margin-right: 8px; vertical-align: middle;">
            <component :is="feature.icon" />
          </el-icon>
          <span>{{ feature.label }}</span>
        </el-dropdown-item>
      </el-dropdown-menu>
    </template>
  </el-dropdown>
</template>

<script setup lang="ts">
import { MoreFilled } from "@element-plus/icons-vue";
import type { HeaderFeature, HeaderFeatureId } from "@/header/headerFeatures";

interface Props {
  features: HeaderFeature[];
}

const props = defineProps<Props>();

const emit = defineEmits<{
  select: [featureId: HeaderFeatureId];
}>();

const handleCommand = (command: string | number) => {
  emit("select", command as HeaderFeatureId);
};
</script>

<style scoped lang="scss">
// 确保按钮样式与项目风格一致
:deep(.el-button) {
  box-shadow: var(--anime-shadow);
  transition: all 0.3s ease;

  &:hover {
    transform: translateY(-2px);
    box-shadow: var(--anime-shadow-hover);
  }
}

// 下拉菜单样式
:deep(.el-dropdown-menu__item) {
  display: flex;
  align-items: center;
  padding: 10px 16px;
  font-size: 14px;
  color: var(--anime-text-primary);

  &:hover {
    background-color: var(--el-fill-color-light);
  }

  .el-icon {
    font-size: 16px;
  }
}
</style>
