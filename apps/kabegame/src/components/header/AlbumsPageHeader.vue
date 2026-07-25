<template>
  <PageHeader
    :title="t('albums.title')"
    :show="showIds"
    :fold="foldIds"
    @action="handleAction"
  />
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted } from "vue";
import { useI18n } from "@kabegame/i18n";
import PageHeader from "@kabegame/core/components/common/PageHeader.vue";
import { HeaderFeatureId } from "@kabegame/core/stores/header";
import { useUiStore } from "@kabegame/core/stores/ui";
import { storeToRefs } from "pinia";
import { usePageBridgeStore } from "@/stores/pageBridge";

const { t } = useI18n();

const props = withDefaults(
  defineProps<{ albumDriveEnabled?: boolean }>(),
  { albumDriveEnabled: false }
);

const emit = defineEmits<{
  'view-vd': [];
  refresh: [];
  'create-album': [];
}>();

const { isCompact } = storeToRefs(useUiStore());
const pageBridge = usePageBridgeStore();

// Refresh 入口已收进全局工具箱，这里只注册桥接。
onMounted(() => {
  pageBridge.setRefresh(() => emit("refresh"));
});
onUnmounted(() => {
  pageBridge.setRefresh(null);
});

const withVd = (ids: string[]) =>
  props.albumDriveEnabled ? ids : ids.filter((id) => id !== HeaderFeatureId.OpenVirtualDrive);

// 计算显示和折叠的feature ID
const showIds = computed(() => {
  if (isCompact.value) {
    return [HeaderFeatureId.TaskDrawer];
  } else {
    return withVd([HeaderFeatureId.OpenVirtualDrive, HeaderFeatureId.CreateAlbum, HeaderFeatureId.TaskDrawer]);
  }
});

const foldIds = computed(() => {
  if (isCompact.value) {
    return withVd([HeaderFeatureId.OpenVirtualDrive, HeaderFeatureId.CreateAlbum]);
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
    case HeaderFeatureId.CreateAlbum:
      emit("create-album");
      break;
  }
};
</script>