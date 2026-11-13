<template>
  <div class="album-detail-panel flex h-full min-h-0 flex-col">
    <div class="flex items-center gap-1 pb-2 pl-4 pr-2.5 pt-3">
      <span class="min-w-0 flex-1 truncate text-[13px] font-600 text-kb-fg">
        {{ t("albums.detailPanelTitle") }}
      </span>
      <Tooltip v-if="album && !isHidden" :content="t('contextMenu.more')">
        <Button
          variant="ghost"
          size="icon-sm"
          :aria-label="t('contextMenu.more')"
          @click="(e: MouseEvent) => emit('more', e)"
        >
          <Ellipsis />
        </Button>
      </Tooltip>
      <Tooltip :content="t('common.close')">
        <Button variant="ghost" size="icon-sm" :aria-label="t('common.close')" @click="emit('close')">
          <X />
        </Button>
      </Tooltip>
    </div>

    <div v-if="!album" class="flex flex-1 items-center justify-center px-4 text-center">
      <span class="text-[13px] text-kb-fg-subtle">{{ t("albums.detailPanelEmpty") }}</span>
    </div>

    <div v-else class="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
      <div class="relative h-[150px] overflow-hidden rounded-kb-lg border border-solid border-kb-line bg-kb-fill-light">
        <!-- 封面是静态大图，不需要 ImageItem 的选中/hover/右键/视频控件那一整套
             （AlbumCard 当年正是为此写了一堆 :deep 去中和它的边框阴影）。
             直接用 ImageContent，并显式 fit="cover" —— 它默认 contain，会给横图留上下灰边。 -->
        <ImageContent v-if="cover" :key="cover.id" :image="cover" prefer="thumbnail" fit="cover" :native-drag="false" />
        <div v-else class="flex size-full items-center justify-center">
          <img :src="albumEmptyImageUrl" alt="" class="size-12 opacity-50" />
        </div>
      </div>

      <div class="mt-3.5">
        <div class="truncate text-[16px] font-600 leading-6 tracking-[-0.01em] text-kb-fg">
          {{ displayName }}
        </div>
        <div class="mt-0.5 flex min-w-0 items-center gap-1 text-[12px] text-kb-fg-muted">
          <span class="flex-none tabular-nums">
            {{ t("albums.createdAtPrefix", { date: formatDate(album.createdAt) }) }}
          </span>
          <span class="flex-none">· {{ typeLabel }}</span>
        </div>
        <div
          v-if="isLabelForest && album.labelPath"
          class="mt-1 flex min-w-0 items-center gap-1 text-[12px]"
          :title="album.labelPath"
        >
          <span class="flex-none text-kb-fg-muted">{{ t("albums.labelKeyPrefix") }}</span>
          <code class="kb-selectable truncate font-mono text-[11.5px] text-[var(--kb-fg-regular)]">
            {{ album.labelPath }}
          </code>
        </div>
        <div
          v-if="isLocalFolder && album.syncFolder"
          class="mt-1 flex min-w-0 items-center gap-1.5 text-[12px]"
          :title="album.syncFolder"
        >
          <span v-if="folderStatusBad" class="size-1.5 flex-none rounded-full bg-kb-danger" />
          <span class="kb-selectable truncate text-kb-fg-muted">{{ album.syncFolder }}</span>
        </div>
        <div v-if="isLocalFolder" class="mt-1.5 flex min-w-0 items-center gap-1.5 text-[12px]">
          <!-- 类名字面量与 syncModeIconClass 的返回值一致，供 UnoCSS 扫描：text-kb-fg-muted text-kb-fg-subtle opacity-70 -->
          <component
            :is="syncModeIcon(album.syncMode)!"
            v-if="syncModeIcon(album.syncMode)"
            class="size-3.5 flex-none"
            :class="syncModeIconClass(album.syncMode)"
          />
          <span class="flex-none font-500 text-[var(--kb-fg-regular)]">
            {{ syncModeLabel(album.syncMode) }}
          </span>
          <span class="min-w-0 truncate text-kb-fg-muted" :title="syncModeTooltip(album.syncMode)">
            · {{ syncModeTooltip(album.syncMode) }}
          </span>
        </div>

        <!-- 逐屏独立且不止一块屏时写明是哪几块屏在轮播它 -->
        <Tag v-if="isRotating" tone="accent" size="sm" class="mt-2" :title="rotatingBadge">
          <template #icon><Monitor /></template>
          {{ rotatingBadge }}
        </Tag>
      </div>

      <div v-if="isLabelDir" class="mt-3.5 rounded-kb-md bg-kb-fill-light px-3 py-2.5">
        <div :class="STAT_NUM">{{ stats.imageCount }}</div>
        <div :class="STAT_LABEL">
          {{ t("albums.labelDirChildCount", { count: stats.imageCount }) }}
        </div>
      </div>
      <div v-else class="mt-3.5 grid grid-cols-2 gap-2">
        <div class="rounded-kb-md bg-kb-fill-light px-3 py-2.5">
          <div :class="STAT_NUM">{{ stats.imageCount }}</div>
          <div :class="STAT_LABEL">{{ t("albums.imagesTab") }}</div>
        </div>
        <div class="rounded-kb-md bg-kb-fill-light px-3 py-2.5">
          <div :class="STAT_NUM">{{ stats.subAlbumCount }}</div>
          <div :class="STAT_LABEL">{{ t("albums.subAlbums") }}</div>
        </div>
      </div>

      <div v-if="!isHidden" class="mt-3.5 flex flex-col gap-2">
        <Button
          v-if="!isLabelDir"
          :variant="canStartRotation ? 'primary' : 'outline'"
          class="w-full"
          @click="emit('command', canStartRotation ? 'setWallpaperRotation' : 'stopWallpaperRotation')"
        >
          <MonitorPlay v-if="canStartRotation" />
          <MonitorStop v-else />
          {{ canStartRotation ? t("albums.detailStartRotation") : t("albums.detailStopRotation") }}
        </Button>
        <!-- 只有部分屏在轮播它：主按钮仍是「设为轮播」（给另一块屏），停止另给一个入口（关的是全局开关） -->
        <Button
          v-if="!isLabelDir && isRotating && canStartRotation"
          class="w-full"
          @click="emit('command', 'stopWallpaperRotation')"
        >
          <MonitorStop />
          {{ t("albums.detailStopRotation") }}
        </Button>
        <div class="grid grid-cols-2 gap-2">
          <Button v-if="canRename" class="w-full" @click="emit('command', 'rename')">
            <Pencil />
            {{ t("contextMenu.rename") }}
          </Button>
          <Button v-if="canCreateSubAlbum" class="w-full" @click="emit('command', 'createSubAlbum')">
            <FolderPlus />
            {{ t("contextMenu.createSubAlbum") }}
          </Button>
          <Button v-else-if="isLocalFolder" class="w-full" @click="emit('command', 'syncNow')">
            <RefreshCw />
            {{ t("contextMenu.syncFolderOnly") }}
          </Button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "@kabegame/i18n";
import { Ellipsis, FolderPlus, Monitor, MonitorPlay, MonitorStop, Pencil, RefreshCw, X } from "@lucide/vue";
import { Button, Tag, Tooltip } from "@/components/ui";
import ImageContent from "@/components/image/ImageContent.vue";
import type { ImageInfo } from "@/types/image";
import { HIDDEN_ALBUM_ID, type Album } from "@/services/albums";
import { syncModeIcon, syncModeIconClass, syncModeLabel, syncModeTooltip } from "@/utils/albumSyncMode";
import { albumEmptyImageUrl } from "@/assets/illustrations";

/**
 * 画册页右栏「画册信息」面板：纯展示 + 派发，无副作用。
 * 精简操作（轮播 / 重命名 / 新建子画册-或-立即同步）直接触发；其余操作（移动到…、
 * 打开虚拟盘、删除等）通过标题栏「⋯」交给宿主复用右键菜单那套 ActionRenderer。
 */

export type AlbumPanelCommand =
  "setWallpaperRotation" | "stopWallpaperRotation" | "rename" | "createSubAlbum" | "syncNow";

interface Props {
  album: Album | null;
  isHidden: boolean;
  stats: { imageCount: number; subAlbumCount: number };
  /** 轮播开着，且有壁纸目标在轮播这个画册 */
  isRotating: boolean;
  /** 还有壁纸目标没在轮播它（多块屏逐屏独立时可能与 `isRotating` 同时为 true）；缺省按「没在轮播才能设」 */
  canSetRotation?: boolean;
  /** 多个壁纸目标时，正在轮播它的屏的名字；只有一个目标时为空 */
  rotatingScreens?: readonly string[];
  canCreateSubAlbum: boolean;
  canRename: boolean;
  cover: ImageInfo | null;
}

// 布尔 prop 不传时 Vue 会给 false，这里要能区分「没传」
const props = withDefaults(defineProps<Props>(), { canSetRotation: undefined, rotatingScreens: () => [] });

const emit = defineEmits<{
  close: [];
  more: [event: MouseEvent];
  command: [command: AlbumPanelCommand];
}>();

const { t } = useI18n();

const STAT_NUM = "text-[18px] font-600 leading-6 tabular-nums text-kb-fg";
const STAT_LABEL = "text-[11.5px] text-kb-fg-subtle";

const isLocalFolder = computed(() => props.album?.type === "local_folder");
const isLabel = computed(() => props.album?.type === "label");
const isLabelDir = computed(() => props.album?.type === "label_dir");
const isLabelForest = computed(() => isLabel.value || isLabelDir.value);

// 主按钮是「设为轮播」还是「停止轮播」：还有屏能设就是前者
const canStartRotation = computed(() => props.canSetRotation ?? !props.isRotating);
const rotatingBadge = computed(() =>
  props.rotatingScreens.length > 0
    ? t("albums.detailRotatingBadgeOn", { screens: props.rotatingScreens.join(t("common.listSeparator")) })
    : t("albums.detailRotatingBadge"),
);

const displayName = computed(() => {
  if (!props.album) return "";
  return props.album.id === HIDDEN_ALBUM_ID ? t("albums.hiddenAlbumName") : props.album.name;
});

const typeLabel = computed(() => {
  if (isLocalFolder.value) return t("albums.detailLocalFolderAlbum");
  if (isLabelDir.value) return t("albums.detailLabelDir");
  if (isLabel.value) return t("albums.detailLabelAlbum");
  return t("albums.detailManualAlbum");
});

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
