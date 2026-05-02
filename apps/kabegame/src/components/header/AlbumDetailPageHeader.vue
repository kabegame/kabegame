<template>
  <PageHeader
    :title="displayName"
    :subtitle="subtitle"
    :show="showIds"
    :fold="foldIds"
    @action="handleAction"
    show-back
    @back="handleBack"
  >
    <template #title>
      <div class="album-title-wrapper">
        <input
          v-if="isRenaming && !isHiddenAlbum"
          :value="editingName"
          ref="renameInputRef"
          class="album-name-input"
          @input="(e) => $emit('update:editingName', (e.target as HTMLInputElement).value)"
          @blur="handleRenameConfirm"
          @keyup.enter="handleRenameConfirm"
          @keyup.esc="handleRenameCancel"
        />
        <span
          v-else
          class="album-name"
          :class="{ 'album-name--readonly': isHiddenAlbum }"
          @dblclick.stop="isHiddenAlbum ? undefined : handleStartRename()"
          @click.stop
          :title="isHiddenAlbum ? '' : t('albums.doubleClickToRename')"
        >
          {{ displayName }}
        </span>
      </div>
    </template>
  </PageHeader>
</template>

<script setup lang="ts">
import { computed, ref, watch, nextTick, onUnmounted } from "vue";
import { useI18n } from "@kabegame/i18n";
import PageHeader from "@kabegame/core/components/common/PageHeader.vue";
import { HeaderFeatureId, useHeaderStore } from "@kabegame/core/stores/header";
import { useUiStore } from "@kabegame/core/stores/ui";
import { storeToRefs } from "pinia";
import { useAlbumDetailRouteStore } from "@/stores/albumDetailRoute";

interface Props {
  albumName?: string;
  totalImagesCount?: number;
  isRenaming?: boolean;
  editingName?: string;
  albumDriveEnabled?: boolean;
  /** 是否显示画册内「过滤 / 排序」（安卓上放入 fold） */
  includeBrowseControls?: boolean;
  /** 收藏画册：隐藏「新建子画册」按钮 */
  isFavoriteAlbum?: boolean;
  /** 隐藏画册：隐藏「新建子画册 / 删除 / 轮播」按钮 */
  isHiddenAlbum?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  albumName: undefined,
  totalImagesCount: undefined,
  isRenaming: false,
  editingName: "",
  albumDriveEnabled: false,
  includeBrowseControls: false,
  isFavoriteAlbum: false,
  isHiddenAlbum: false,
});

const emit = defineEmits<{
  'view-vd': [];
  refresh: [];
  'set-wallpaper-rotate': [];
  'delete-album': [];
  help: [];
  'quick-settings': [];
  back: [];
  'start-rename': [];
  'confirm-rename': [name: string];
  'cancel-rename': [];
  'update:editingName': [value: string];
  'open-browse-filter': [];
  'open-browse-sort': [];
  'open-browse-page-size': [];
  'create-sub-album': [];
}>();

const { t } = useI18n();
const renameInputRef = ref<HTMLInputElement>();
const albumRouteStore = useAlbumDetailRouteStore();
const { hide: albumHide } = storeToRefs(albumRouteStore);
const { isCompact } = storeToRefs(useUiStore());
const headerStore = useHeaderStore();

watch(
  albumHide,
  () => {
    headerStore.setFoldLabel(
      HeaderFeatureId.ToggleShowHidden,
      albumHide.value ? t("header.showHidden") : t("header.hideHidden")
    );
  },
  { immediate: true }
);
onUnmounted(() => {
  headerStore.setFoldLabel(HeaderFeatureId.ToggleShowHidden, undefined);
});

const subtitle = computed(() =>
  props.totalImagesCount ? t("albums.totalCountSubtitle", { count: props.totalImagesCount }) : ""
);

const displayName = computed(() => {
  if (props.isHiddenAlbum) return t("albums.hiddenAlbumName");
  return props.albumName || t("albums.title");
});

const withVd = (ids: string[]) =>
  props.albumDriveEnabled ? ids : ids.filter((id) => id !== HeaderFeatureId.OpenVirtualDrive);

const withoutCreateAlbum = (ids: string[]) =>
  props.isFavoriteAlbum ? ids.filter((id) => id !== HeaderFeatureId.CreateAlbum) : ids;

const withoutHiddenAlbumActions = (ids: string[]) =>
  props.isHiddenAlbum
    ? ids.filter(
        (id) =>
          id !== HeaderFeatureId.CreateAlbum &&
          id !== HeaderFeatureId.DeleteAlbum &&
          id !== HeaderFeatureId.SetAsWallpaperCarousel,
      )
    : ids;

// 计算显示和折叠的feature ID
const showIds = computed(() => {
  if (isCompact.value) {
    return [HeaderFeatureId.TaskDrawer];
  } else {
    return withoutHiddenAlbumActions(withoutCreateAlbum(withVd([HeaderFeatureId.OpenVirtualDrive, HeaderFeatureId.Refresh, HeaderFeatureId.CreateAlbum, HeaderFeatureId.SetAsWallpaperCarousel, HeaderFeatureId.DeleteAlbum, HeaderFeatureId.TaskDrawer, HeaderFeatureId.Help, HeaderFeatureId.QuickSettings])));
  }
});

const foldIds = computed(() => {
  const hideToggleIds = props.isHiddenAlbum ? [] : [HeaderFeatureId.ToggleShowHidden];
  if (isCompact.value) {
    const base = withoutHiddenAlbumActions(withoutCreateAlbum(withVd([
      HeaderFeatureId.OpenVirtualDrive,
      HeaderFeatureId.Refresh,
      HeaderFeatureId.CreateAlbum,
      HeaderFeatureId.SetAsWallpaperCarousel,
      HeaderFeatureId.DeleteAlbum,
      HeaderFeatureId.Help,
      HeaderFeatureId.QuickSettings,
    ])));
    const withHide = [...base, ...hideToggleIds];
    if (props.includeBrowseControls) {
      return [
        HeaderFeatureId.AlbumBrowseFilter,
        HeaderFeatureId.AlbumBrowseSort,
        HeaderFeatureId.GalleryPageSize,
        ...withHide,
      ];
    }
    return withHide;
  }
  return hideToggleIds;
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
      emit("create-sub-album");
      break;
    case HeaderFeatureId.SetAsWallpaperCarousel:
      emit("set-wallpaper-rotate");
      break;
    case HeaderFeatureId.DeleteAlbum:
      emit("delete-album");
      break;
    case HeaderFeatureId.Help:
      emit("help");
      break;
    case HeaderFeatureId.QuickSettings:
      emit("quick-settings");
      break;
    case HeaderFeatureId.AlbumBrowseFilter:
      emit("open-browse-filter");
      break;
    case HeaderFeatureId.AlbumBrowseSort:
      emit("open-browse-sort");
      break;
    case HeaderFeatureId.GalleryPageSize:
      emit("open-browse-page-size");
      break;
    case HeaderFeatureId.ToggleShowHidden:
      albumRouteStore.hide = !albumRouteStore.hide;
      break;
  }
};

// 处理返回
const handleBack = () => {
  emit("back");
};

// 处理重命名
const handleStartRename = () => {
  emit("start-rename");
};

const handleRenameConfirm = () => {
  if (props.editingName.trim()) {
    emit("confirm-rename", props.editingName.trim());
  }
};

const handleRenameCancel = () => {
  emit("cancel-rename");
};

watch(
  () => props.isRenaming,
  (val) => {
    if (val) {
      nextTick(() => {
        renameInputRef.value?.focus();
        renameInputRef.value?.select();
      });
    }
  }
);
</script>

<style scoped lang="scss">
.album-title-wrapper {
  display: flex;
  align-items: center;
  gap: 8px;
}

.album-name {
  cursor: pointer;
  user-select: none;
  background: linear-gradient(135deg, var(--anime-primary) 0%, var(--anime-secondary) 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;

  &--readonly {
    cursor: default;
  }
}

.album-name-input {
  background: transparent;
  border: 1px solid var(--anime-border);
  border-radius: 4px;
  padding: 4px 8px;
  color: var(--anime-text-primary);
  font-size: 22px;
  font-weight: 700;
  line-height: 1.2;
  outline: none;

  &:focus {
    border-color: var(--anime-primary);
  }
}
</style>