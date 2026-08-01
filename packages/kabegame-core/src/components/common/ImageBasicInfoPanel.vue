<template>
  <CollapsibleDrawerPanel
    v-if="image"
    class="image-basic-info-panel"
    storage-key="kabegame-image-detail-fields-open"
    :fill-when-expanded="fillWhenExpanded"
    :collapsible="collapsible"
    :toggle-aria-label="t('gallery.imageDetailFieldsToggle')"
  >
    <template #title>
      {{ t('gallery.imageDetailBasicSection') }}
    </template>
    <div class="detail-fields-body">
      <div v-if="image.displayName" class="detail-item">
        <span class="detail-label">{{ t('gallery.imageDetailDisplayName') }}</span>
        <button
          type="button"
          class="detail-value line-clamp-2 detail-filter-link"
          :title="image.displayName"
          @click="emitGalleryFilter(displayNameFilterTarget)"
        >{{ image.displayName }}</button>
      </div>
      <div class="detail-item">
        <span class="detail-label">{{ t('gallery.imageDetailSource') }}</span>
        <div class="detail-value-row">
          <button
            v-if="sourceClickEnabled"
            type="button"
            class="detail-filter-link"
            :title="sourceTitle"
            @click="handleOpenSource"
          >{{ sourceLabel }}</button>
          <span v-else class="detail-value">{{ sourceLabel }}</span>
          <el-button
            v-if="image.taskId"
            text
            circle
            size="small"
            type="primary"
            class="detail-open-task-btn"
            :title="t('gallery.imageDetailOpenTask')"
            :aria-label="t('gallery.imageDetailOpenTask')"
            @click="handleOpenTask"
          >
            <el-icon>
              <List />
            </el-icon>
          </el-button>
        </div>
      </div>
      <div class="detail-item">
        <span class="detail-label">{{ t('gallery.imageDetailType') }}</span>
        <div class="detail-value detail-inline-links">
          <button
            type="button"
            class="detail-filter-link"
            :title="t('gallery.filterByMediaType')"
            @click="emitGalleryFilter(mediaKindFilterTarget)"
          >{{ mediaTypeParts.kind }}</button>
          <template v-if="mediaTypeParts.format">
            <span class="detail-link-separator">/</span>
            <button
              type="button"
              class="detail-filter-link"
              :title="t('gallery.filterByMediaType')"
              @click="emitGalleryFilter(mediaFormatFilterTarget)"
            >{{ mediaTypeParts.format }}</button>
          </template>
        </div>
      </div>
      <div v-if="image.postUrl && !isFileUrl(image.postUrl)" class="detail-item">
        <span class="detail-label">{{ t('gallery.imageDetailUrl') }}</span>
        <span
          class="detail-value line-clamp-2 clickable-link"
          :title="image.postUrl"
          @click="handleOpenUrl(image.postUrl)"
        >{{ image.postUrl }}</span>
      </div>
      <div class="detail-item">
        <span class="detail-label">{{ t('gallery.imageDetailLocalPath') }}</span>
        <span
          class="detail-value line-clamp-2 clickable-link"
          :title="image.localPath"
          @click="handleOpenPath(image.localPath)"
          @contextmenu.prevent.stop="handleCopyLocalPath(image.localPath)"
        >{{ image.localPath }}</span>
      </div>
      <div class="detail-item">
        <span class="detail-label">{{ t('gallery.imageDetailCrawledAt') }}</span>
        <div v-if="dateParts" class="detail-value detail-inline-links">
          <button
            type="button"
            class="detail-filter-link"
            :title="t('gallery.filterByTime')"
            @click="emitGalleryFilter(dateYearFilterTarget)"
          >{{ dateParts.year }}</button>
          <span class="detail-link-separator">-</span>
          <button
            type="button"
            class="detail-filter-link"
            :title="t('gallery.filterByTime')"
            @click="emitGalleryFilter(dateMonthFilterTarget)"
          >{{ dateParts.month }}</button>
          <span class="detail-link-separator">-</span>
          <button
            type="button"
            class="detail-filter-link"
            :title="t('gallery.filterByTime')"
            @click="emitGalleryFilter(dateDayFilterTarget)"
          >{{ dateParts.day }}</button>
          <span v-if="dateParts.time" class="detail-date-time">{{ dateParts.time }}</span>
        </div>
        <span v-else class="detail-value">{{ formatDate(image.crawledAt) }}</span>
      </div>
      <div v-if="image.size != null" class="detail-item">
        <span class="detail-label">{{ t('gallery.imageDetailSize') }}</span>
        <div class="detail-value-row detail-value-row-wrap">
          <button
            type="button"
            class="detail-filter-link"
            :title="t('gallery.filterBySize')"
            @click="emitGalleryFilter(sizeFilterTarget)"
          >{{ imageFileSizeLabel }}</button>
          <button
            v-if="aspectFilterTarget"
            type="button"
            class="detail-filter-link detail-filter-link-muted"
            :title="t('gallery.filterByAspect')"
            @click="emitGalleryFilter(aspectFilterTarget)"
          >({{ imageDimensionsLabel }})</button>
        </div>
      </div>
    </div>
  </CollapsibleDrawerPanel>
</template>

<script setup lang="ts">
import { computed, watch } from "vue";
import CollapsibleDrawerPanel from "./CollapsibleDrawerPanel.vue";
import { useI18n, resolveManifestText } from "@kabegame/i18n";
import { invoke } from "../../api";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { kameMessage as ElMessage } from "@kabegame/core/utils/kameMessage";
import { List } from "@kabegame/element-plus-icons";
import { IS_ANDROID, IS_WEB } from "../../env";
import { openImage } from "tauri-plugin-picker-api";
import { usePluginStore, type Plugin } from "../../stores/plugins";
import { useSurfStore } from "../../stores/surf";
import { displayImageMimeType, isVideoMediaType } from "../../utils/mediaMime";
import { openExternalLink } from "../../utils/openExternalLink";

const { t, locale } = useI18n();
const pluginStore = usePluginStore();
const surfStore = useSurfStore();

const toLocaleTag = (loc: string) => {
  if (loc.startsWith("zh")) return loc === "zhtw" ? "zh-TW" : "zh-CN";
  return loc === "en" ? "en-US" : loc;
};

export type ImageDetailLike = {
  id?: string;
  url?: string;
  localPath?: string;
  pluginId?: string;
  crawledAt?: number;
  displayName?: string;
  /** 与库表 `images.type` 一致：具体 MIME（API 已规范化） */
  type?: string;
  metadata?: Record<string, unknown> | unknown;
  metadataId?: number;
  pluginVersion?: number;
  size?: number;
  width?: number;
  height?: number;
  taskId?: string;
  surfRecordId?: string;
  postUrl?: string;
};

export type ImageDetailSurfRecordTarget = {
  surfRecordId: string;
  host: string;
};

export type ImageDetailGalleryFilterTarget =
  | { type: "search"; search: string }
  | { type: "plugin"; pluginId: string }
  | { type: "media-type"; kind: "image" | "video"; format?: string }
  | { type: "date"; segment: string }
  | { type: "size"; range: string }
  | { type: "aspect"; range: string };

interface Props {
  image: ImageDetailLike | null;
  plugins?: Array<Plugin>;
  /** 是否允许收拢（详情弹窗桌面端并排三栏时关闭） */
  collapsible?: boolean;
  /** 展开时是否 flex:1 争夺容器剩余空间（侧栏内多面板共存时为 true） */
  fillWhenExpanded?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  collapsible: true,
  fillWhenExpanded: false,
});

const emit = defineEmits<{
  "open-task": [taskId: string];
  "open-gallery-filter": [target: ImageDetailGalleryFilterTarget];
  "open-surf-record": [target: ImageDetailSurfRecordTarget];
}>();

function handleOpenTask() {
  const tid = props.image?.taskId;
  if (tid) emit("open-task", tid);
}

const displayNameFilterTarget = computed<ImageDetailGalleryFilterTarget | null>(() => {
  const search = props.image?.displayName?.trim();
  return search ? { type: "search", search } : null;
});

const pluginFilterTarget = computed<ImageDetailGalleryFilterTarget | null>(() => {
  const pluginId = props.image?.pluginId?.trim();
  return pluginId ? { type: "plugin", pluginId } : null;
});

const surfRecordId = computed(() => props.image?.surfRecordId?.trim() || "");

watch(
  surfRecordId,
  (id) => {
    if (!id || pluginFilterTarget.value) return;
    void surfStore.ensureRecordsByIds([id]);
  },
  { immediate: true },
);

const surfSourceHost = computed(() => {
  const id = surfRecordId.value;
  return id ? surfStore.hostById(id) ?? "" : "";
});

const sourceKind = computed<"plugin" | "surf" | "unknown">(() => {
  if (pluginFilterTarget.value) return "plugin";
  if (surfRecordId.value && surfSourceHost.value) return "surf";
  return "unknown";
});

const sourceLabel = computed(() => {
  if (sourceKind.value === "plugin") return getPluginName(props.image?.pluginId);
  if (sourceKind.value === "surf") return surfSourceHost.value;
  return "unknown";
});

const sourceClickEnabled = computed(() => sourceKind.value !== "unknown");

const sourceTitle = computed(() => {
  if (sourceKind.value === "plugin") return t("gallery.filterByPlugin");
  return surfSourceHost.value || sourceLabel.value;
});

function handleOpenSource() {
  if (pluginFilterTarget.value) {
    emitGalleryFilter(pluginFilterTarget.value);
    return;
  }
  const id = surfRecordId.value;
  const host = surfSourceHost.value;
  if (id && host) emit("open-surf-record", { surfRecordId: id, host });
}

const mediaTypeParts = computed((): { kind: "image" | "video"; format: string } => {
  const raw = displayImageMimeType(props.image?.type).trim().toLowerCase();
  const kind: "image" | "video" = isVideoMediaType(raw) ? "video" : "image";
  const slash = raw.indexOf("/");
  const format = slash >= 0 ? raw.slice(slash + 1).trim() : raw.trim();
  return {
    kind,
    format: !format || format === "image" || format === "video" ? "" : format,
  };
});

const mediaKindFilterTarget = computed<ImageDetailGalleryFilterTarget>(() => ({
  type: "media-type",
  kind: mediaTypeParts.value.kind,
}));

const mediaFormatFilterTarget = computed<ImageDetailGalleryFilterTarget | null>(() => {
  const format = mediaTypeParts.value.format;
  return format ? { type: "media-type", kind: mediaTypeParts.value.kind, format } : null;
});

const imageDimensionsLabel = computed((): string => {
  const width = props.image?.width;
  const height = props.image?.height;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return "";
  if ((width as number) <= 0 || (height as number) <= 0) return "";
  return `${Math.round(width as number)} x ${Math.round(height as number)}`;
});

const imageFileSizeLabel = computed((): string => {
  const size = props.image?.size;
  if (size == null) return "";
  return formatBytes(size);
});

const dateParts = computed(() => galleryDateParts(props.image?.crawledAt));

const dateYearFilterTarget = computed<ImageDetailGalleryFilterTarget | null>(() => {
  const parts = dateParts.value;
  return parts ? { type: "date", segment: parts.year } : null;
});

const dateMonthFilterTarget = computed<ImageDetailGalleryFilterTarget | null>(() => {
  const parts = dateParts.value;
  return parts ? { type: "date", segment: `${parts.year}-${parts.month}` } : null;
});

const dateDayFilterTarget = computed<ImageDetailGalleryFilterTarget | null>(() => {
  const parts = dateParts.value;
  return parts ? { type: "date", segment: `${parts.year}-${parts.month}-${parts.day}` } : null;
});

const sizeFilterTarget = computed<ImageDetailGalleryFilterTarget>(() => ({
  type: "size",
  range: sizeRangeForBytes(props.image?.size),
}));

const aspectFilterTarget = computed<ImageDetailGalleryFilterTarget | null>(() => {
  const range = aspectRangeForDimensions(props.image?.width, props.image?.height);
  return range ? { type: "aspect", range } : null;
});

function emitGalleryFilter(target: ImageDetailGalleryFilterTarget | null) {
  if (!target) return;
  emit("open-gallery-filter", target);
}

/** 与 TaskSummaryRow 一致：回退用 pluginStore.pluginLabel。 */
const getPluginName = (pluginId?: string): string => {
  if (!pluginId) return "unknown";
  const plugin = (props.plugins || []).find((p) => p.id === pluginId);
  if (!plugin) return pluginStore.pluginLabel(pluginId);
  const raw = plugin.name;
  if (!raw || typeof raw !== "object") {
    return (raw as string)?.trim() || pluginStore.pluginLabel(pluginId);
  }
  return (
    resolveManifestText(raw, locale.value) ||
    (raw["default"] ?? pluginStore.pluginLabel(pluginId)) ||
    pluginStore.pluginLabel(pluginId)
  );
};

const formatBytes = (n: number): string => {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const fixed = i === 0 ? 0 : v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return `${v.toFixed(fixed)} ${units[i]}`;
};

function galleryDateParts(timestamp?: number): {
  year: string;
  month: string;
  day: string;
  time: string;
} | null {
  if (!Number.isFinite(timestamp) || (timestamp as number) <= 0) return null;
  const raw = Math.floor(timestamp as number);
  const seconds = raw > 253_402_300_799 ? Math.floor(raw / 1000) : raw;
  const d = new Date(seconds * 1000);
  if (Number.isNaN(d.getTime())) return null;
  const y = `${d.getUTCFullYear()}`;
  const m = `${d.getUTCMonth() + 1}`.padStart(2, "0");
  const day = `${d.getUTCDate()}`.padStart(2, "0");
  const hh = `${d.getHours()}`.padStart(2, "0");
  const mm = `${d.getMinutes()}`.padStart(2, "0");
  const ss = `${d.getSeconds()}`.padStart(2, "0");
  return { year: y, month: m, day, time: `${hh}:${mm}:${ss}` };
}

function sizeRangeForBytes(size?: number): string {
  if (!Number.isFinite(size) || (size as number) <= 0) return "unknown";
  const n = size as number;
  if (n < 524_288) return "1B-512KB";
  if (n < 1_048_576) return "512KB-1MB";
  if (n < 2_097_152) return "1MB-2MB";
  if (n < 5_242_880) return "2MB-5MB";
  if (n < 10_485_760) return "5MB-10MB";
  if (n < 52_428_800) return "10MB-50MB";
  return "50MB-";
}

function aspectRangeForDimensions(width?: number, height?: number): string | null {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  const w = Math.round(width as number);
  const h = Math.round(height as number);
  if (w <= 0 || h <= 0) return null;
  if (w * 3 > h * 4 && w * 9 <= h * 16) return "landscape-4x3-16x9";
  if (w * 9 > h * 16 && w * 3 <= h * 7) return "widescreen-16x9-21x9";
  if (w * 4 >= h * 3 && w * 3 <= h * 4) return "square-3x4-4x3";
  if (w * 16 >= h * 9 && w * 4 < h * 3) return "portrait-9x16-3x4";
  return "other";
}

const formatDate = (timestamp?: number) => {
  if (!Number.isFinite(timestamp) || (timestamp as number) <= 0) return t("gallery.imageDetailInvalidDate");
  const ts = timestamp as number;
  const ms = ts > 1e11 ? ts : ts * 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return t("gallery.imageDetailInvalidDate");
  const loc = locale.value ?? "zh";
  return d.toLocaleString(toLocaleTag(loc));
};

const isFileUrl = (url?: string) => {
  return url && url.toLowerCase().startsWith("file://");
};

const handleOpenUrl = async (url?: string) => {
  if (!url) return;
  try {
    await openExternalLink(url);
  } catch (error) {
    console.error("打开 URL 失败:", error);
    ElMessage.error(t("common.openUrlFailed"));
  }
};

const handleOpenPath = async (path?: string) => {
  if (!path) return;
  if (IS_WEB) return;
  try {
    if (IS_ANDROID) {
      const uri = path.startsWith("content://")
        ? path
        : path.startsWith("/")
          ? `file://${path}`
          : `file:///${path}`;
      await openImage(uri);
    } else {
      await invoke("open_file_path", { filePath: path });
    }
  } catch (error) {
    console.error("打开文件失败:", error);
    ElMessage.error(t("common.openFileFailed"));
  }
};

const handleCopyLocalPath = async (path?: string) => {
  if (!path) return;
  try {
    if (IS_WEB) {
      await navigator.clipboard.writeText(path);
    } else {
      await writeText(path);
    }
    ElMessage.success(t("common.copySuccess"));
  } catch (error) {
    console.error("复制本地路径失败:", error);
    ElMessage.error(t("common.copyFailed"));
  }
};
</script>

<style scoped lang="scss">
/* 外框/标题栏 chrome 由 CollapsibleDrawerPanel 提供（根即面板） */
.image-basic-info-panel {
  min-width: 0;

  .detail-item {
    display: flex;
    align-items: flex-start;
    gap: 12px;
  }

  .detail-label {
    font-weight: 500;
    color: var(--anime-text-secondary);
    min-width: 80px;
    flex-shrink: 0;
  }

  .detail-fields-body {
    display: flex;
    min-height: 0;
    flex-direction: column;
    gap: 16px;
    padding: 0 12px 12px;
    /* fill 模式（preview 侧栏）下内容超高时内部滚动 */
    overflow-y: auto;
  }

  .detail-value-row {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    min-width: 0;
  }

  .detail-value-row-wrap {
    flex-wrap: wrap;
    row-gap: 4px;
  }

  .detail-inline-links {
    display: inline-flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 0;
  }

  .detail-link-separator,
  .detail-date-time {
    color: var(--anime-text-primary);
  }

  .detail-date-time {
    margin-left: 8px;
  }

  .detail-open-task-btn {
    flex-shrink: 0;
  }

  .detail-value {
    color: var(--anime-text-primary);
    word-break: break-all;
    flex: 1;
    min-width: 0;

    &.clickable-link {
      color: var(--anime-primary);
      cursor: pointer;
      text-decoration: underline;
      transition: color 0.3s ease;

      &:hover {
        color: var(--anime-primary-dark);
      }
    }
  }

  .detail-filter-link {
    min-width: 0;
    max-width: 100%;
    border: 0;
    background: transparent;
    padding: 0;
    cursor: pointer;
    font: inherit;
    text-align: left;
    word-break: break-all;
    transition: color 0.3s ease;

    &:hover {
      color: var(--anime-primary);
      text-decoration-line: underline;
      text-decoration-thickness: 1px;
      text-underline-offset: 2px;
    }

    &:focus-visible {
      outline: 2px solid var(--anime-primary);
      outline-offset: 2px;
      border-radius: 3px;
    }
  }

  .detail-filter-link-muted {
    color: var(--anime-text-secondary);

    &:hover {
      color: var(--anime-primary);
    }
  }

}
</style>
