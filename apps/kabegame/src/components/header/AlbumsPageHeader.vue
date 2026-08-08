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
  /** 紧凑模式：唤起画册树抽屉（桌面左树常驻，无此按钮） */
  'open-tree': [];
  /** 桌面：开合画册信息右栏；紧凑模式：唤起画册信息抽屉 */
  'toggle-detail': [];
}>();

const { isCompact } = storeToRefs(useUiStore());
const pageBridge = usePageBridgeStore();

// Refresh 的入口在 header 上，这里额外注册桥接供全局快捷键（⇧⌘R）使用。
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
    return [HeaderFeatureId.AlbumTree, HeaderFeatureId.AlbumInfo, HeaderFeatureId.TaskDrawer];
  } else {
    return withVd([HeaderFeatureId.AlbumInfo, HeaderFeatureId.OpenVirtualDrive, HeaderFeatureId.Refresh, HeaderFeatureId.CreateAlbum, HeaderFeatureId.TaskDrawer]);
  }
});

const foldIds = computed(() => {
  if (isCompact.value) {
    return withVd([HeaderFeatureId.OpenVirtualDrive, HeaderFeatureId.Refresh, HeaderFeatureId.CreateAlbum]);
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
    case HeaderFeatureId.AlbumTree:
      emit("open-tree");
      break;
    case HeaderFeatureId.AlbumInfo:
      emit("toggle-detail");
      break;
  }
};
</script>