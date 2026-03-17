<template>
  <PageHeader
    :title="albumName || t('albums.title')"
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
          v-if="isRenaming"
          :value="editingName"
          ref="renameInputRef"
          class="album-name-input"
          @input="(e) => $emit('update:editingName', (e.target as HTMLInputElement).value)"
          @blur="handleRenameConfirm"
          @keyup.enter="handleRenameConfirm"
          @keyup.esc="handleRenameCancel"
        />
        <span v-else class="album-name" @dblclick.stop="handleStartRename" @click.stop :title="t('albums.doubleClickToRename')">
          {{ albumName || t('albums.title') }}
        </span>
      </div>
    </template>
  </PageHeader>
</template>

<script setup lang="ts">
import { computed, ref, watch, nextTick } from "vue";
import { useI18n } from "vue-i18n";
import PageHeader from "@kabegame/core/components/common/PageHeader.vue";
import { HeaderFeatureId } from "@kabegame/core/stores/header";
import { IS_ANDROID } from "@kabegame/core/env";

interface Props {
  albumName?: string;
  totalImagesCount?: number;
  isRenaming?: boolean;
  editingName?: string;
  albumDriveEnabled?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  albumName: undefined,
  totalImagesCount: undefined,
  isRenaming: false,
  editingName: "",
  albumDriveEnabled: false,
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
}>();

const { t } = useI18n();
const renameInputRef = ref<HTMLInputElement>();

const subtitle = computed(() =>
  props.totalImagesCount ? t("albums.totalCountSubtitle", { count: props.totalImagesCount }) : ""
);

const withVd = (ids: string[]) =>
  props.albumDriveEnabled ? ids : ids.filter((id) => id !== HeaderFeatureId.OpenVirtualDrive);

// 计算显示和折叠的feature ID
const showIds = computed(() => {
  if (IS_ANDROID) {
    return [HeaderFeatureId.TaskDrawer];
  } else {
    return withVd([HeaderFeatureId.OpenVirtualDrive, HeaderFeatureId.Refresh, HeaderFeatureId.SetAsWallpaperCarousel, HeaderFeatureId.DeleteAlbum, HeaderFeatureId.TaskDrawer, HeaderFeatureId.Help, HeaderFeatureId.QuickSettings]);
  }
});

const foldIds = computed(() => {
  if (IS_ANDROID) {
    return withVd([HeaderFeatureId.OpenVirtualDrive, HeaderFeatureId.Refresh, HeaderFeatureId.SetAsWallpaperCarousel, HeaderFeatureId.DeleteAlbum, HeaderFeatureId.Help, HeaderFeatureId.QuickSettings]);
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