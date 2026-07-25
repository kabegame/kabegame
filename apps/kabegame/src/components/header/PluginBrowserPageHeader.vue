<template>
  <PageHeader
    :title="t('plugins.manageTitle')"
    :show="showIds"
    :fold="foldIds"
    @action="handleAction"
  />
</template>

<script setup lang="ts">
import { computed, onUnmounted, watch } from "vue";
import { useI18n } from "@kabegame/i18n";
import PageHeader from "@kabegame/core/components/common/PageHeader.vue";
import { HeaderFeatureId } from "@kabegame/core/stores/header";
import { useUiStore } from "@kabegame/core/stores/ui";
import { useApp } from "@/stores/app";
import { storeToRefs } from "pinia";
import { usePageBridgeStore } from "@/stores/pageBridge";

const { t } = useI18n();

const emit = defineEmits<{
  refresh: [];
  'import-source': [];
  'manage-sources': [];
}>();

const { isCompact } = storeToRefs(useUiStore());
const { isSuper } = storeToRefs(useApp());
const pageBridge = usePageBridgeStore();

// Refresh 入口已收进全局工具箱，这里只在 isSuper 时注册桥接（保持原先"仅 super 模式显示"的语义）。
watch(
  isSuper,
  (v) => {
    pageBridge.setRefresh(v ? () => emit("refresh") : null);
  },
  { immediate: true }
);
onUnmounted(() => {
  pageBridge.setRefresh(null);
});

// 计算显示和折叠的feature ID
const showIds = computed(() => {
  if (isCompact.value) {
    return [];
  }
  return [HeaderFeatureId.ImportSource];
});

const foldIds = computed(() => {
  if (!isCompact.value) return [];
  return [HeaderFeatureId.ImportSource, HeaderFeatureId.ManageSources];
});

// 处理action事件
const handleAction = (payload: { id: string; data: { type: string } }) => {
  switch (payload.id) {
    case HeaderFeatureId.ImportSource:
      emit("import-source");
      break;
    case HeaderFeatureId.ManageSources:
      emit("manage-sources");
      break;
  }
};
</script>