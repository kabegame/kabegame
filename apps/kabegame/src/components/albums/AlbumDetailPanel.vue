<template>
  <div class="album-detail-panel flex h-full min-h-0 flex-col">
    <div class="flex items-center gap-2 px-4 pb-2.5 pt-3">
      <span class="min-w-0 flex-1 truncate text-[13px] font-bold text-[var(--anime-text-primary)]">
        {{ t("albums.detailPanelTitle") }}
      </span>
      <button
        v-if="album && !isHidden"
        class="album-detail-panel-btn"
        type="button"
        :title="t('contextMenu.more')"
        @click="(e) => emit('more', e)"
      >
        <el-icon><MoreFilled /></el-icon>
      </button>
      <button
        class="album-detail-panel-btn"
        type="button"
        :title="t('common.close')"
        @click="emit('close')"
      >
        <el-icon><Close /></el-icon>
      </button>
    </div>

    <div v-if="!album" class="album-detail-panel-empty flex flex-1 items-center justify-center px-4 text-center">
      <span class="text-[13px] text-[var(--anime-text-muted)]">{{ t("albums.detailPanelEmpty") }}</span>
    </div>

    <div v-else class="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
      <div class="album-detail-cover">
        <!-- 封面是静态大图，不需要 ImageItem 的选中/hover/右键/视频控件那一整套
             （AlbumCard 当年正是为此写了一堆 :deep 去中和它的边框阴影）。
             直接用 ImageContent，并显式 fit="cover" —— 它默认 contain，会给横图留上下灰边。 -->
        <ImageContent
          v-if="cover"
          :key="cover.id"
          :image="cover"
          prefer="thumbnail"
          fit="cover"
          :native-drag="false"
        />
        <div v-else class="album-detail-cover-empty">
          <img src="/album-empty.png" alt="" class="album-detail-cover-empty-img" />
        </div>
      </div>

      <div class="mt-3.5">
        <div class="truncate text-[16px] font-bold text-[var(--anime-text-primary)]">
          {{ displayName }}
        </div>
        <div class="mt-0.5 flex min-w-0 items-center gap-1 text-[12px] text-[var(--anime-text-muted)]">
          <span class="flex-none">{{ t("albums.createdAtPrefix", { date: formatDate(album.createdAt) }) }}</span>
          <span class="flex-none">· {{ typeLabel }}</span>
        </div>
        <div
          v-if="isLocalFolder && album.syncFolder"
          class="mt-1 flex min-w-0 items-center gap-1 text-[12px]"
          :title="album.syncFolder"
        >
          <span v-if="folderStatusBad" class="album-detail-status-dot flex-none" />
          <span class="truncate text-[var(--anime-text-muted)]">{{ album.syncFolder }}</span>
        </div>
        <div
          v-if="isLocalFolder"
          class="mt-1.5 flex min-w-0 items-center gap-1.5 text-[12px]"
        >
          <el-icon
            v-if="syncModeIcon(album.syncMode)"
            class="flex-none text-[13px]"
            :class="syncModeIconClass(album.syncMode)"
          >
            <component :is="syncModeIcon(album.syncMode)!" />
          </el-icon>
          <span class="flex-none font-medium text-[var(--anime-text-secondary)]">
            {{ syncModeLabel(album.syncMode) }}
          </span>
          <span
            class="min-w-0 truncate text-[var(--anime-text-muted)]"
            :title="syncModeTooltip(album.syncMode)"
          >
            · {{ syncModeTooltip(album.syncMode) }}
          </span>
        </div>

        <div v-if="isRotating" class="album-detail-rotating-badge mt-2">
          <el-icon><Monitor /></el-icon>
          <span>{{ t("albums.detailRotatingBadge") }}</span>
        </div>
      </div>

      <div class="mt-3.5 grid grid-cols-2 gap-2">
        <div class="album-detail-stat">
          <div class="album-detail-stat-num">{{ stats.imageCount }}</div>
          <div class="album-detail-stat-label">{{ t("albums.imagesTab") }}</div>
        </div>
        <div class="album-detail-stat">
          <div class="album-detail-stat-num">{{ stats.subAlbumCount }}</div>
          <div class="album-detail-stat-label">{{ t("albums.subAlbums") }}</div>
        </div>
      </div>

      <div v-if="!isHidden" class="mt-3.5 flex flex-col gap-2">
        <button
          class="album-detail-primary-btn"
          type="button"
          @click="emit('command', isRotating ? 'stopWallpaperRotation' : 'setWallpaperRotation')"
        >
          {{ isRotating ? t("albums.detailStopRotation") : t("albums.detailStartRotation") }}
        </button>
        <div class="grid grid-cols-2 gap-2">
          <button
            v-if="canRename"
            class="album-detail-secondary-btn"
            type="button"
            @click="emit('command', 'rename')"
          >
            {{ t("contextMenu.rename") }}
          </button>
          <button
            v-if="canCreateSubAlbum"
            class="album-detail-secondary-btn"
            type="button"
            @click="emit('command', 'createSubAlbum')"
          >
            {{ t("contextMenu.createSubAlbum") }}
          </button>
          <button
            v-else-if="isLocalFolder"
            class="album-detail-secondary-btn"
            type="button"
            @click="emit('command', 'syncNow')"
          >
            {{ t("contextMenu.syncFolderOnly") }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "@kabegame/i18n";
import { Close, Monitor, MoreFilled } from "@kabegame/element-plus-icons";
import ImageContent from "@kabegame/core/components/image/ImageContent.vue";
import type { ImageInfo } from "@kabegame/core/types/image";
import type { Album } from "@/stores/albums";
import { HIDDEN_ALBUM_ID } from "@/stores/albums";
import {
  syncModeIcon,
  syncModeIconClass,
  syncModeLabel,
  syncModeTooltip,
} from "@/utils/albumSyncMode";

/**
 * 画册页右栏「画册信息」面板：纯展示 + 派发，无副作用。
 * 精简操作（轮播 / 重命名 / 新建子画册-或-立即同步）直接触发；其余操作（移动到…、
 * 打开虚拟盘、删除等）通过标题栏「⋯」交给宿主复用右键菜单那套 ActionRenderer。
 */

export type AlbumPanelCommand =
  | "setWallpaperRotation"
  | "stopWallpaperRotation"
  | "rename"
  | "createSubAlbum"
  | "syncNow";

interface Props {
  album: Album | null;
  isHidden: boolean;
  stats: { imageCount: number; subAlbumCount: number };
  isRotating: boolean;
  canCreateSubAlbum: boolean;
  canRename: boolean;
  cover: ImageInfo | null;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  close: [];
  more: [event: MouseEvent];
  command: [command: AlbumPanelCommand];
}>();

const { t } = useI18n();

const isLocalFolder = computed(() => props.album?.type === "local_folder");

const displayName = computed(() => {
  if (!props.album) return "";
  return props.album.id === HIDDEN_ALBUM_ID ? t("albums.hiddenAlbumName") : props.album.name;
});

const typeLabel = computed(() =>
  isLocalFolder.value ? t("albums.detailLocalFolderAlbum") : t("albums.detailManualAlbum"),
);

const folderStatusBad = computed(() => {
  const state = props.album?.folderStatus?.state;
  return !!state && state !== "ok";
});

const formatDate = (ts?: number) => {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${day}`;
};
</script>

<style scoped lang="scss">
.album-detail-panel-btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--anime-text-muted);
  font-size: 14px;
  cursor: pointer;
  transition: color 0.15s ease, background 0.15s ease;
}

.album-detail-panel-btn:hover {
  color: var(--anime-text-secondary);
  background: rgba(167, 139, 250, 0.16);
}

.album-detail-cover {
  height: 150px;
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid var(--anime-border, rgba(120, 140, 180, 0.18));
  background: var(--anime-surface-alt, rgba(120, 140, 180, 0.08));
}

.album-detail-cover-empty {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.album-detail-cover-empty-img {
  width: 48px;
  height: 48px;
  opacity: 0.5;
}

.album-detail-status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #ef4444;
}

.album-detail-rotating-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  background: linear-gradient(135deg, #ff6b9d, #a78bfa);
  color: #fff;
  border-radius: 999px;
  padding: 3px 9px;
  font-size: 11px;
  font-weight: 600;
}

.album-detail-stat {
  background: var(--anime-surface, #fff);
  border: 1px solid var(--anime-border, rgba(120, 140, 180, 0.18));
  border-radius: 10px;
  padding: 9px 11px;
}

.album-detail-stat-num {
  font-size: 18px;
  font-weight: 700;
  color: var(--anime-text-primary);
}

.album-detail-stat-label {
  font-size: 11px;
  color: var(--anime-text-muted);
}

.album-detail-primary-btn {
  height: 34px;
  border-radius: 9px;
  border: none;
  background: linear-gradient(135deg, #a78bfa, #7c3aed);
  color: #fff;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
}

.album-detail-secondary-btn {
  height: 32px;
  border-radius: 9px;
  border: 1px solid var(--anime-border, rgba(120, 140, 180, 0.28));
  background: var(--anime-surface, #fff);
  color: var(--anime-text-primary);
  font-size: 12px;
  cursor: pointer;
}

.album-detail-secondary-btn:hover,
.album-detail-primary-btn:hover {
  filter: brightness(1.05);
}
</style>
