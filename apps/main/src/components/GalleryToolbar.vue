<template>
  <PageHeader title="画廊" :show="showIds" :fold="foldIds" @action="handleAction" sticky>
    <template #subtitle>
      <span>{{ totalCountText }}</span>
    </template>
  </PageHeader>
</template>

<script setup lang="ts">
import { computed } from "vue";
import PageHeader from "@kabegame/core/components/common/PageHeader.vue";
import { HeaderFeatureId } from "@kabegame/core/stores/header";
import { IS_ANDROID } from "@kabegame/core/env";

interface Props {
  isLoadingAll?: boolean;
  totalCount?: number;
  bigPageEnabled?: boolean;
  currentPosition?: number; // 当前位置（分页启用时使用）
  monthOptions?: string[];
  monthLoading?: boolean;
  selectedRange?: [string, string] | null; // YYYY-MM-DD
}

const props = withDefaults(defineProps<Props>(), {
  isLoadingAll: false,
  totalCount: 0,
  bigPageEnabled: false,
  currentPosition: 1,
  monthOptions: () => [],
  monthLoading: false,
  selectedRange: null,
});

const totalCountText = computed(() => {
  if (props.totalCount === 0) {
    return "暂无图片";
  }
  // 如果启用了分页，显示当前位置
  if (props.bigPageEnabled && props.currentPosition !== undefined) {
    return `第 ${props.currentPosition} / ${props.totalCount}`;
  }
  // 否则显示原来的格式
  return `共 ${props.totalCount} 张图片`;
});

const emit = defineEmits<{
  refresh: [];
  showHelp: [];
  showQuickSettings: [];
  showCrawlerDialog: [];
  showLocalImport: [];
  openCollectMenu: [];
  "update:selectedRange": [value: [string, string] | null];
}>();

const showIds = computed(() => {
  if (IS_ANDROID) {
    return [HeaderFeatureId.Collect, HeaderFeatureId.TaskDrawer];
  }
  return [HeaderFeatureId.Refresh, HeaderFeatureId.Help, HeaderFeatureId.QuickSettings, HeaderFeatureId.Organize, HeaderFeatureId.TaskDrawer, HeaderFeatureId.Collect];
});

const foldIds = computed(() => {
  return IS_ANDROID ? [HeaderFeatureId.Help, HeaderFeatureId.QuickSettings] : [];
});

// 处理action事件
const handleAction = (payload: { id: string; data: { type: string; value?: string } }) => {
  switch (payload.id) {
    case HeaderFeatureId.Collect:
      if (payload.data.type === "select") {
        if (payload.data.value === "local") {
          emit("showLocalImport");
        } else if (payload.data.value === "network") {
          emit("showCrawlerDialog");
        }
      }
      break;
    case HeaderFeatureId.Help:
      emit("showHelp");
      break;
    case HeaderFeatureId.QuickSettings:
      emit("showQuickSettings");
      break;
    case HeaderFeatureId.Organize:
      // 整理由 header 的 OrganizeHeaderControl 处理，此处不会触发（Organize 在 show 中）
      break;
  }
};
</script>

<style scoped lang="scss">
.date-range-filter {
  width: 260px;
  margin-left: 8px;
}

.add-task-btn {
  box-shadow: var(--anime-shadow);

  &:hover {
    transform: translateY(-2px);
    box-shadow: var(--anime-shadow-hover);
  }
}
</style>
