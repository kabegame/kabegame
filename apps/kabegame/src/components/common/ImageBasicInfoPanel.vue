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
      {{ t("gallery.imageDetailBasicSection") }}
    </template>
    <div class="basic-info-body">
      <!-- 名称作标题；源、收藏时间、任务入口放在名称下 -->
      <div v-if="image.displayName" class="basic-info-name line-clamp-2" :title="image.displayName">
        {{ image.displayName }}
      </div>
      <div class="flex items-center gap-2 min-w-0">
        <span class="basic-info-avatar">
          <img v-if="sourceIconSrc" :src="sourceIconSrc" alt="" class="h-full w-full object-cover" />
          <el-icon v-else><component :is="sourceKind === 'surf' ? Compass : Picture" /></el-icon>
        </span>
        <div class="flex-1 min-w-0">
          <button
            v-if="sourceClickEnabled"
            type="button"
            class="basic-info-link basic-info-source"
            :title="sourceTitle"
            @click="handleOpenSource"
          >
            {{ sourceLabel }}
          </button>
          <span v-else class="basic-info-source">{{ sourceLabel }}</span>
          <div class="basic-info-date" :title="t('gallery.imageDetailCrawledAt')">
            <template v-if="dateParts">
              <button
                type="button"
                class="basic-info-link"
                :title="t('gallery.filterByTime')"
                @click="emitGalleryFilter(dateYearFilterTarget)"
              >
                {{ dateParts.year }}
              </button>
              <span>-</span>
              <button
                type="button"
                class="basic-info-link"
                :title="t('gallery.filterByTime')"
                @click="emitGalleryFilter(dateMonthFilterTarget)"
              >
                {{ dateParts.month }}
              </button>
              <span>-</span>
              <button
                type="button"
                class="basic-info-link"
                :title="t('gallery.filterByTime')"
                @click="emitGalleryFilter(dateDayFilterTarget)"
              >
                {{ dateParts.day }}
              </button>
              <span v-if="dateParts.time" class="ml-1.5">{{ dateParts.time }}</span>
            </template>
            <span v-else>{{ formatDate(image.crawledAt) }}</span>
          </div>
        </div>
        <el-button
          v-if="image.taskId"
          text
          circle
          size="small"
          type="primary"
          class="shrink-0"
          :title="t('gallery.imageDetailOpenTask')"
          :aria-label="t('gallery.imageDetailOpenTask')"
          @click="handleOpenTask"
        >
          <el-icon>
            <List />
          </el-icon>
        </el-button>
      </div>

      <!-- 媒体属性芯片：每个可点的片段都是一个画廊筛选 -->
      <div class="flex flex-wrap items-center gap-1.5">
        <!-- 目录型 WPE 壁纸：显示「Wallpaper Engine · 类型」，不提供媒体类型筛选 -->
        <span v-if="isWpeImage" class="basic-info-chip">Wallpaper Engine · {{ wpeKindText }}</span>
        <span v-else class="basic-info-chip">
          <el-icon class="mr-0.5"><component :is="mediaTypeParts.kind === 'video' ? VideoCamera : Picture" /></el-icon>
          <button
            type="button"
            class="basic-info-link"
            :title="t('gallery.filterByMediaType')"
            @click="emitGalleryFilter(mediaKindFilterTarget)"
          >
            {{ mediaKindLabel }}
          </button>
          <template v-if="mediaTypeParts.format">
            <span class="mx-0.5 opacity-60">/</span>
            <button
              type="button"
              class="basic-info-link uppercase"
              :title="t('gallery.filterByMediaType')"
              @click="emitGalleryFilter(mediaFormatFilterTarget)"
            >
              {{ mediaTypeParts.format }}
            </button>
          </template>
        </span>
        <button
          v-if="image.size != null"
          type="button"
          class="basic-info-chip basic-info-link"
          :title="t('gallery.filterBySize')"
          @click="emitGalleryFilter(sizeFilterTarget)"
        >
          {{ imageFileSizeLabel }}
        </button>
        <span v-if="imageDimensionsLabel" class="basic-info-chip">{{ imageDimensionsLabel }}</span>
        <!-- 宽高比画成与图片同比例的矩形框，放得下就把比值写在框里 -->
        <button
          v-if="aspectFilterTarget && aspectFrame"
          type="button"
          class="basic-info-aspect"
          :title="`${t('gallery.filterByAspect')} · ${aspectFrame.label}`"
          @click="emitGalleryFilter(aspectFilterTarget)"
        >
          <span class="basic-info-aspect-frame" :style="{ width: `${aspectFrame.width}px` }">
            <template v-if="aspectFrame.labelInside">{{ aspectFrame.label }}</template>
          </span>
          <span v-if="!aspectFrame.labelInside">{{ aspectFrame.label }}</span>
        </button>
      </div>

      <div v-if="showPostUrl || image.localPath" class="basic-info-links">
        <div v-if="showPostUrl" class="basic-info-link-row">
          <el-icon class="basic-info-row-icon"><Link /></el-icon>
          <span class="basic-info-row-text" :title="image.postUrl" @click="handleOpenUrl(image.postUrl)">
            {{ image.postUrl }}
          </span>
          <button
            type="button"
            class="basic-info-copy"
            :title="t('gallery.imageDetailCopy')"
            :aria-label="t('gallery.imageDetailCopy')"
            @click="handleCopyText(image.postUrl)"
          >
            <el-icon><CopyDocument /></el-icon>
          </button>
        </div>
        <div v-if="image.localPath" class="basic-info-link-row">
          <el-icon class="basic-info-row-icon"><Folder /></el-icon>
          <!-- 路径从左侧省略、保留文件名；LRM 防止 rtl 方向把开头的 / 甩到末尾 -->
          <span
            class="basic-info-row-text basic-info-row-text--tail"
            :title="image.localPath"
            @click="handleOpenPath(image.localPath)"
            @contextmenu.prevent.stop="handleCopyText(image.localPath)"
          >
            {{ `\u200E${image.localPath}\u200E` }}
          </span>
          <button
            type="button"
            class="basic-info-copy"
            :title="t('gallery.imageDetailCopy')"
            :aria-label="t('gallery.imageDetailCopy')"
            @click="handleCopyText(image.localPath)"
          >
            <el-icon><CopyDocument /></el-icon>
          </button>
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
import { kameMessage as ElMessage } from "@/utils/kameMessage";
import { Compass, CopyDocument, Folder, Link, List, Picture, VideoCamera } from "@kabegame/element-plus-icons";
import { IS_ANDROID, IS_WEB } from "../../env";
import { openImage } from "tauri-plugin-picker-api";
import { usePluginStore, type Plugin } from "../../stores/plugins";
import { useSurfStore } from "../../stores/surf";
import { displayImageMimeType, isVideoMediaType, isWpeMediaType, wpeKind } from "../../utils/mediaMime";
import { aspectBucketForDimensions } from "../../utils/galleryQuery";
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
  return id ? (surfStore.hostById(id) ?? "") : "";
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

const sourceIconSrc = computed(() => {
  if (sourceKind.value !== "plugin") return undefined;
  return pluginStore.pluginIconSrc(props.image?.pluginId?.trim() ?? "");
});

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

const mediaKindLabel = computed(() =>
  t(mediaTypeParts.value.kind === "video" ? "gallery.imageDetailKindVideo" : "gallery.imageDetailKindImage"),
);
/** 目录型 WPE 壁纸：类型显示成「Wallpaper Engine · 视频」，不提供媒体类型过滤链接。 */
const isWpeImage = computed(() => isWpeMediaType(props.image?.type));
const wpeKindText = computed(() => {
  const kind = wpeKind(props.image?.type);
  if (!kind) return "";
  if (kind === "video") return t("gallery.wpeKindVideo");
  if (kind === "web") return t("gallery.wpeKindWeb");
  if (kind === "scene") return t("gallery.wpeKindScene");
  return kind;
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
  return `${Math.round(width as number)} × ${Math.round(height as number)}`;
});

/** 常见比例；实际比值与之相差 1.5% 内就显示该比例，否则显示小数比值。 */
const COMMON_ASPECT_RATIOS: Array<[number, number]> = [
  [1, 1],
  [5, 4],
  [4, 3],
  [3, 2],
  [5, 3],
  [16, 10],
  [16, 9],
  [2, 1],
  [21, 9],
  [32, 9],
];

/** 框高固定 22px（与芯片同高），宽按比例换算并夹在 [12, 56]；比值文字放得下才写进框里。 */
const ASPECT_FRAME_HEIGHT = 22;

const aspectFrame = computed(() => {
  const width = props.image?.width;
  const height = props.image?.height;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if ((width as number) <= 0 || (height as number) <= 0) return null;
  const ratio = (width as number) / (height as number);
  const portrait = ratio < 1;
  const long = portrait ? 1 / ratio : ratio;
  const common = COMMON_ASPECT_RATIOS.find(([a, b]) => Math.abs(long / (a / b) - 1) <= 0.015);
  const label = common
    ? portrait
      ? `${common[1]}:${common[0]}`
      : `${common[0]}:${common[1]}`
    : portrait
      ? `1:${long.toFixed(2)}`
      : `${long.toFixed(2)}:1`;
  const frameWidth = Math.min(56, Math.max(12, Math.round(ASPECT_FRAME_HEIGHT * ratio)));
  // 11px 等宽数字约 6.5px/字，左右各留 3px
  const labelInside = frameWidth >= label.length * 6.5 + 6;
  return { label, width: frameWidth, labelInside };
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
  const range = aspectBucketForDimensions(props.image?.width, props.image?.height);
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
  // 与后端 date/* provider 的 strftime(..., 'unixepoch', 'localtime') 同口径：按本地时区切日
  const y = `${d.getFullYear()}`;
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
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

const formatDate = (timestamp?: number) => {
  if (!Number.isFinite(timestamp) || (timestamp as number) <= 0) return t("gallery.imageDetailInvalidDate");
  const ts = timestamp as number;
  const ms = ts > 1e11 ? ts : ts * 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return t("gallery.imageDetailInvalidDate");
  const loc = locale.value ?? "zh";
  return d.toLocaleString(toLocaleTag(loc));
};

const showPostUrl = computed(() => {
  const url = props.image?.postUrl;
  return !!url && !url.toLowerCase().startsWith("file://");
});

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
      const uri = path.startsWith("content://") ? path : path.startsWith("/") ? `file://${path}` : `file:///${path}`;
      await openImage(uri);
    } else {
      await invoke("open_path", { path });
    }
  } catch (error) {
    console.error("打开文件失败:", error);
    ElMessage.error(t("common.openFileFailed"));
  }
};

const handleCopyText = async (text?: string) => {
  if (!text) return;
  try {
    if (IS_WEB) {
      await navigator.clipboard.writeText(text);
    } else {
      await writeText(text);
    }
    ElMessage.success(t("common.copySuccess"));
  } catch (error) {
    console.error("复制失败:", error);
    ElMessage.error(t("common.copyFailed"));
  }
};
</script>

<style scoped lang="scss">
/* 外框/标题栏 chrome 由 CollapsibleDrawerPanel 提供（根即面板） */
.image-basic-info-panel {
  min-width: 0;

  .basic-info-body {
    display: flex;
    min-height: 0;
    flex-direction: column;
    gap: 12px;
    padding: 0 12px 12px;
    font-size: 13px;
    line-height: 1.5;
    color: var(--anime-text-primary);
    /* 面板被压矮时内部滚动 */
    overflow-y: auto;

    /* line-clamp 的 overflow:hidden 会让 flex 子项被压到 0 高 */
    > * {
      flex-shrink: 0;
    }
  }

  .basic-info-name {
    font-size: 15px;
    font-weight: 600;
    word-break: break-all;
  }

  .basic-info-avatar {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    overflow: hidden;
    border-radius: 50%;
    background: color-mix(in srgb, var(--anime-primary) 12%, transparent);
    color: var(--anime-primary);
    font-size: 16px;
  }

  .basic-info-source {
    display: block;
    max-width: 100%;
    overflow: hidden;
    color: var(--anime-primary);
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .basic-info-date {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    color: var(--anime-text-secondary);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }

  /* 可点筛选片段：外观随所在位置，悬停才出主色下划线 */
  .basic-info-link {
    min-width: 0;
    border: 0;
    background: transparent;
    padding: 0;
    color: inherit;
    cursor: pointer;
    font: inherit;
    text-align: left;
    transition: color 0.2s ease;

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

  .basic-info-chip {
    display: inline-flex;
    align-items: center;
    height: 22px;
    padding: 0 9px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--anime-primary) 10%, transparent);
    color: var(--anime-primary-dark);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  button.basic-info-chip:hover {
    background: color-mix(in srgb, var(--anime-primary) 18%, transparent);
    text-decoration-line: none;
  }

  .basic-info-aspect {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    border: 0;
    background: transparent;
    padding: 0;
    color: var(--anime-primary-dark);
    cursor: pointer;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    transition: color 0.2s ease;

    &:hover {
      color: var(--anime-primary);
    }

    &:focus-visible {
      outline: 2px solid var(--anime-primary);
      outline-offset: 2px;
      border-radius: 3px;
    }
  }

  .basic-info-aspect-frame {
    display: inline-flex;
    box-sizing: border-box;
    align-items: center;
    justify-content: center;
    height: 22px;
    border: 1.5px solid currentColor;
    border-radius: 3px;
    line-height: 1;
  }

  .basic-info-links {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding-top: 10px;
    border-top: 1px solid color-mix(in srgb, var(--anime-border) 70%, transparent);
  }

  .basic-info-link-row {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .basic-info-row-icon {
    flex-shrink: 0;
    color: var(--anime-text-secondary);
    font-size: 15px;
  }

  .basic-info-row-text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    color: var(--anime-primary);
    cursor: pointer;
    text-overflow: ellipsis;
    white-space: nowrap;

    &:hover {
      color: var(--anime-primary-dark);
      text-decoration: underline;
    }

    /* 路径从左省略，保留末尾文件名 */
    &--tail {
      direction: rtl;
      text-align: left;
    }
  }

  .basic-info-copy {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--anime-text-secondary);
    cursor: pointer;
    font-size: 14px;

    &:hover {
      background: color-mix(in srgb, var(--anime-primary) 10%, transparent);
      color: var(--anime-primary);
    }
  }
}
</style>
