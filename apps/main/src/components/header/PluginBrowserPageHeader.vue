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
import { IS_ANDROID } from "@kabegame/core/env";

const { t } = useI18n();

const emit = defineEmits<{
  refresh: [];
  'import-source': [];
  help: [];
  'quick-settings': [];
  'manage-sources': [];
}>();

// 计算显示和折叠的feature ID
const showIds = computed(() => {
  if (IS_ANDROID) {
    return [];
  } else {
    return [HeaderFeatureId.Refresh, HeaderFeatureId.ImportSource, HeaderFeatureId.Help, HeaderFeatureId.QuickSettings];
  }
});

const foldIds = computed(() => {
  return IS_ANDROID ? [HeaderFeatureId.Refresh, HeaderFeatureId.ImportSource, HeaderFeatureId.Help, HeaderFeatureId.QuickSettings, HeaderFeatureId.ManageSources] : [];
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