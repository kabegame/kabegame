<template>
  <PageHeader
    :title="t('plugins.manageTitle')"
    :show="showIds"
    :fold="foldIds"
    @action="handleAction"
  />
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "@kabegame/i18n";
import PageHeader from "@kabegame/core/components/common/PageHeader.vue";
import { HeaderFeatureId } from "@kabegame/core/stores/header";
import { useUiStore } from "@kabegame/core/stores/ui";
import { useApp } from "@/stores/app";
import { storeToRefs } from "pinia";

const { t } = useI18n();

const emit = defineEmits<{
  refresh: [];
  'import-source': [];
  help: [];
  'quick-settings': [];
  'manage-sources': [];
}>();

const { isCompact } = storeToRefs(useUiStore());
const { isSuper } = storeToRefs(useApp());

// 计算显示和折叠的feature ID
const showIds = computed(() => {
  if (isCompact.value) {
    return [];
  }
  const ids = [HeaderFeatureId.ImportSource, HeaderFeatureId.Help, HeaderFeatureId.QuickSettings];
  if (isSuper.value) ids.unshift(HeaderFeatureId.Refresh);
  return ids;
});

const foldIds = computed(() => {
  if (!isCompact.value) return [];
  const ids = [HeaderFeatureId.ImportSource, HeaderFeatureId.Help, HeaderFeatureId.QuickSettings, HeaderFeatureId.ManageSources];
  if (isSuper.value) ids.unshift(HeaderFeatureId.Refresh);
  return ids;
});

// 处理action事件
const handleAction = (payload: { id: string; data: { type: string } }) => {
  switch (payload.id) {
    case HeaderFeatureId.Refresh:
      emit("refresh");
      break;
    case HeaderFeatureId.ImportSource:
      emit("import-source");
      break;
    case HeaderFeatureId.Help:
      emit("help");
      break;
    case HeaderFeatureId.QuickSettings:
      emit("quick-settings");
      break;
    case HeaderFeatureId.ManageSources:
      emit("manage-sources");
      break;
  }
};
</script>