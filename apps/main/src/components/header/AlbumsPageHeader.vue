<template>
  <PageHeader
    :title="t('albums.title')"
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

const props = withDefaults(
  defineProps<{ albumDriveEnabled?: boolean }>(),
  { albumDriveEnabled: false }
);

const emit = defineEmits<{
  'view-vd': [];
  refresh: [];
  'create-album': [];
  help: [];
  'quick-settings': [];
}>();

const withVd = (ids: string[]) =>
  props.albumDriveEnabled ? ids : ids.filter((id) => id !== HeaderFeatureId.OpenVirtualDrive);

// 计算显示和折叠的feature ID
const showIds = computed(() => {
  if (IS_ANDROID) {
    return [HeaderFeatureId.TaskDrawer];
  } else {
    return withVd([HeaderFeatureId.OpenVirtualDrive, HeaderFeatureId.Refresh, HeaderFeatureId.CreateAlbum, HeaderFeatureId.TaskDrawer, HeaderFeatureId.Help, HeaderFeatureId.QuickSettings]);
  }
});

const foldIds = computed(() => {
  if (IS_ANDROID) {
    return withVd([HeaderFeatureId.OpenVirtualDrive, HeaderFeatureId.Refresh, HeaderFeatureId.CreateAlbum, HeaderFeatureId.Help, HeaderFeatureId.QuickSettings]);
  } else {
    return [];
  }
});

// 处理action事件
const handleAction = (payload: { id: string; data: { type: string } }) => {
  switch (payload.id) {
    case HeaderFeatureId.OpenVirtualDrive:
      emit("view-vd");
      break;
    case HeaderFeatureId.Refresh:
      emit("refresh");
      break;
    case HeaderFeatureId.CreateAlbum:
      emit("create-album");
      break;
    case HeaderFeatureId.Help:
      emit("help");
      break;
    case HeaderFeatureId.QuickSettings:
      emit("quick-settings");
      break;
  }
};
</script>