<template>
  <CollapsibleDrawerPanel
    v-if="image"
    class="image-basic-info-panel min-w-0"
    storage-key="kabegame-image-detail-fields-open"
    :fill-when-expanded="fillWhenExpanded"
    :collapsible="collapsible"
    :toggle-aria-label="t('gallery.imageDetailFieldsToggle')"
  >
    <template #title>
      {{ t("gallery.imageDetailBasicSection") }}
    </template>
    <!-- 面板被压矮时内部滚动；line-clamp 的 overflow:hidden 会让 flex 子项被压到 0 高，子项一律不收缩 -->
    <div
      class="flex min-h-0 flex-col gap-3 overflow-y-auto px-3 pb-3 text-[13px] leading-normal text-kb-fg [&>*]:shrink-0"
    >
      <!-- 名称作标题；源、收藏时间、任务入口放在名称下 -->
      <div
        v-if="image.displayName"
        class="line-clamp-2 break-all text-[15px] font-600 leading-snug"
        :title="image.displayName"
      >
        {{ image.displayName }}
      </div>
      <div class="flex min-w-0 items-center gap-2.5">
        <span
          class="inline-flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-kb-fill text-kb-fg-muted [&_svg]:size-4"
        >
          <img v-if="sourceIconSrc" :src="sourceIconSrc" alt="" class="h-full w-full object-cover" />
          <component :is="sourceKind === 'surf' ? Compass : ImageIcon" v-else />
        </span>
        <div class="min-w-0 flex-1">
          <button
            v-if="sourceClickEnabled"
            type="button"
            :class="[LINK_CLASS, SOURCE_CLASS]"
            :title="sourceTitle"
            @click="handleOpenSource"
          >
            {{ sourceLabel }}
          </button>
          <span v-else :class="SOURCE_CLASS">{{ sourceLabel }}</span>
          <div
            class="flex flex-wrap items-baseline text-[12px] text-kb-fg-muted tabular-nums"
            :title="t('gallery.imageDetailCrawledAt')"
          >
            <template v-if="dateParts">
              <button
                type="button"
                :class="LINK_CLASS"
                :title="t('gallery.filterByTime')"
                @click="emitGalleryFilter(dateYearFilterTarget)"
              >
                {{ dateParts.year }}
              </button>
              <span>-</span>
              <button
                type="button"
                :class="LINK_CLASS"
                :title="t('gallery.filterByTime')"
                @click="emitGalleryFilter(dateMonthFilterTarget)"
              >
                {{ dateParts.month }}
              </button>
              <span>-</span>
              <button
                type="button"
                :class="LINK_CLASS"
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
        <Tooltip v-if="image.taskId" :content="t('gallery.imageDetailOpenTask')">
          <Button variant="ghost" size="icon-sm" :aria-label="t('gallery.imageDetailOpenTask')" @click="handleOpenTask">
            <ListChecks />
          </Button>
        </Tooltip>
      </div>

      <!-- 媒体属性芯片：每个可点的片段都是一个画廊筛选 -->
      <div class="flex flex-wrap items-center gap-1.5">
        <!-- 媒体类型：主类与格式各是一个筛选；目录型 WPE 壁纸显示「Wallpaper Engine · 类型」 -->
        <span :class="CHIP_CLASS">
          <component
            :is="mediaTypeParts.kind === 'video' ? Video : ImageIcon"
            v-if="!isWpeImage"
            class="mr-1 size-3.5 text-kb-fg-subtle"
          />
          <button
            type="button"
            :class="LINK_CLASS"
            :title="t('gallery.filterByMediaType')"
            @click="emitGalleryFilter(mediaKindFilterTarget)"
          >
            {{ mediaKindLabel }}
          </button>
          <template v-if="mediaTypeParts.format">
            <span class="mx-0.5 text-kb-fg-subtle">{{ isWpeImage ? "·" : "/" }}</span>
            <button
              type="button"
              :class="[LINK_CLASS, { uppercase: !isWpeImage }]"
              :title="t('gallery.filterByMediaType')"
              @click="emitGalleryFilter(mediaFormatFilterTarget)"
            >
              {{ mediaFormatText }}
            </button>
          </template>
        </span>
        <button
          v-if="image.size != null"
          type="button"
          :class="[CHIP_CLASS, CHIP_BUTTON_CLASS]"
          :title="t('gallery.filterBySize')"
          @click="emitGalleryFilter(sizeFilterTarget)"
        >
          {{ imageFileSizeLabel }}
        </button>
        <span v-if="imageDimensionsLabel" :class="CHIP_CLASS">{{ imageDimensionsLabel }}</span>
        <!-- 宽高比画成与图片同比例的矩形框，放得下就把比值写在框里 -->
        <button
          v-if="aspectFilterTarget && aspectFrame"
          type="button"
          class="inline-flex cursor-pointer items-center gap-1.25 rounded-[3px] border-0 bg-transparent p-0 text-[11px] text-kb-fg-muted tabular-nums outline-none transition-colors duration-150 hover:text-kb-fg focus-visible:ring-2 focus-visible:ring-kb-ring"
          :title="`${t('gallery.filterByAspect')} · ${aspectFrame.label}`"
          @click="emitGalleryFilter(aspectFilterTarget)"
        >
          <span
            class="box-border inline-flex h-[22px] items-center justify-center rounded-[3px] border-[1.5px] border-solid border-current leading-none"
            :style="{ width: `${aspectFrame.width}px` }"
          >
            <template v-if="aspectFrame.labelInside">{{ aspectFrame.label }}</template>
          </span>
          <span v-if="!aspectFrame.labelInside">{{ aspectFrame.label }}</span>
        </button>
      </div>

      <!-- 代表色：按占比分段的色带。点一段 = 当前页面按这个颜色排序（过滤不变）。
           没有色盘时整条不渲染、不占位。细边框与段间的 1px 间隔同色，白色、黑色段不会融进面板背景 -->
      <div
        v-if="paletteColors.length"
        class="box-content flex h-2.5 gap-px overflow-hidden rounded-[5px] border border-solid border-kb-line-strong bg-[var(--kb-line-strong)]"
        role="group"
        :aria-label="t('gallery.imageDetailPalette')"
      >
        <button
          v-for="(color, index) in paletteColors"
          :key="`${index}:${color.hex}`"
          type="button"
          class="min-w-1.5 basis-0 cursor-pointer appearance-none border-0 p-0 hover:brightness-110"
          :style="{ flexGrow: color.percent, backgroundColor: `#${color.hex}` }"
          :title="`${t('gallery.colorSortByThis')} · #${color.hex} · ${color.percent}%`"
          :aria-label="`${t('gallery.colorSortByThis')} #${color.hex}`"
          @click="emit('open-color-sort', color.hex)"
        />
      </div>

      <div
        v-if="showPostUrl || image.localPath"
        class="flex flex-col gap-1 border-0 border-t border-solid border-kb-line pt-2.5"
      >
        <div v-if="showPostUrl" :class="ROW_CLASS">
          <Link :class="ROW_ICON_CLASS" />
          <span :class="ROW_TEXT_CLASS" :title="image.postUrl" @click="handleOpenUrl(image.postUrl)">
            {{ image.postUrl }}
          </span>
          <Tooltip :content="t('gallery.imageDetailCopy')">
            <Button
              variant="ghost"
              size="icon-sm"
              :aria-label="t('gallery.imageDetailCopy')"
              @click="handleCopyText(image.postUrl)"
            >
              <Copy />
            </Button>
          </Tooltip>
        </div>
        <div v-if="image.localPath" :class="ROW_CLASS">
          <Folder :class="ROW_ICON_CLASS" />
          <!-- 路径从左侧省略、保留文件名（rtl）；LRM 防止 rtl 方向把开头的 / 甩到末尾 -->
          <span
            :class="[ROW_TEXT_CLASS, '[direction:rtl]']"
            :title="image.localPath"
            @click="handleOpenPath(image.localPath)"
            @contextmenu.prevent.stop="handleCopyText(image.localPath)"
          >
            {{ `\u200E${image.localPath}\u200E` }}
          </span>
          <Tooltip :content="t('gallery.imageDetailCopy')">
            <Button
              variant="ghost"
              size="icon-sm"
              :aria-label="t('gallery.imageDetailCopy')"
              @click="handleCopyText(image.localPath)"
            >
              <Copy />
            </Button>
          </Tooltip>
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
import { kameMessage } from "@/utils/kameMessage";
import { Compass, Copy, Folder, ImageIcon, Link, ListChecks, Video } from "@lucide/vue";
import { Button, Tooltip } from "@/components/ui";
import { IS_ANDROID, IS_WEB } from "../../env";
import { openImage } from "tauri-plugin-picker-api";
import { usePluginStore, type Plugin } from "../../stores/plugins";
import { useSurfStore } from "../../stores/surf";
import { displayImageMimeType, isVideoMediaType, isWpeMediaType } from "../../utils/mediaMime";
import { aspectBucketForDimensions, type GalleryMediaKind } from "../../utils/galleryQuery";
import { facetValueLabel, mediaFormatLabel } from "../../composables/useAdvancedQueryFacets";
import { openExternalLink } from "../../utils/openExternalLink";
import { parsePalette } from "../../utils/palette";

const { t, locale } = useI18n();
const pluginStore = usePluginStore();
const surfStore = useSurfStore();

/** 可点的筛选片段：外观随所在位置，悬停转强调色并出下划线 */
const LINK_CLASS =
  "min-w-0 cursor-pointer rounded-[3px] border-0 bg-transparent p-0 text-left text-inherit [font:inherit] outline-none " +
  "transition-colors duration-150 hover:text-kb-accent hover:underline hover:decoration-1 hover:underline-offset-2 " +
  "focus-visible:ring-2 focus-visible:ring-kb-ring";
/** 来源名（插件名 / 畅游站点） */
const SOURCE_CLASS = "block max-w-full truncate font-500 text-kb-fg";
/** 媒体属性芯片：中性浅底 */
const CHIP_CLASS =
  "inline-flex h-[22px] items-center whitespace-nowrap rounded-full bg-kb-fill px-2.25 text-[12px] text-kb-fg-muted tabular-nums";
/** 整个芯片可点（文件大小） */
const CHIP_BUTTON_CLASS =
  "cursor-pointer border-0 [font-family:inherit] outline-none transition-colors duration-150 hover:bg-kb-fill-dark hover:text-kb-fg focus-visible:ring-2 focus-visible:ring-kb-ring";
const ROW_CLASS = "flex min-w-0 items-center gap-2";
const ROW_ICON_CLASS = "size-4 shrink-0 text-kb-fg-subtle";
/** 链接 / 路径：点开、悬停转强调色 */
const ROW_TEXT_CLASS =
  "min-w-0 flex-1 cursor-pointer truncate text-left text-kb-fg hover:text-kb-accent hover:underline hover:underline-offset-2";

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
  /** 色盘 JSON 文本（`parsePalette` 解析）；没有色盘时为 null / 缺省。 */
  palette?: string | null;
};

export type ImageDetailSurfRecordTarget = {
  surfRecordId: string;
  host: string;
};

export type ImageDetailGalleryFilterTarget =
  | { type: "plugin"; pluginId: string }
  | { type: "media-type"; kind: GalleryMediaKind; format?: string }
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
  /** 点了代表色的一段：按这个颜色（六位小写十六进制）排序，过滤不变。 */
  "open-color-sort": [hex: string];
}>();

/** 代表色：直接来自图片行，面板自己不发请求；回填的 `palette` 补丁打到行上后这里跟着更新。 */
const paletteColors = computed(() => parsePalette(props.image?.palette));

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

/** 目录型 WPE 壁纸：类型显示成「Wallpaper Engine · 视频」，两段都是媒体类型过滤链接。 */
const isWpeImage = computed(() => isWpeMediaType(props.image?.type));

const mediaTypeParts = computed((): { kind: GalleryMediaKind; format: string } => {
  const raw = displayImageMimeType(props.image?.type).trim().toLowerCase();
  const kind: GalleryMediaKind = isWpeMediaType(raw) ? "x-wpe" : isVideoMediaType(raw) ? "video" : "image";
  const slash = raw.indexOf("/");
  const format = slash >= 0 ? raw.slice(slash + 1).trim() : raw.trim();
  return {
    kind,
    // 历史裸值 image / video 没有格式；x-wpe 的子类恰好叫 video，不能清掉
    format: !format || (kind !== "x-wpe" && (format === "image" || format === "video")) ? "" : format,
  };
});

const mediaKindLabel = computed(() => {
  const { kind } = mediaTypeParts.value;
  if (kind === "image") return t("gallery.imageDetailKindImage");
  if (kind === "video") return t("gallery.imageDetailKindVideo");
  return facetValueLabel("mediaType", kind, t);
});

/** WPE 子类显示「视频 / 网页 / 场景」，其余显示格式名。 */
const mediaFormatText = computed(() => mediaFormatLabel(mediaTypeParts.value.kind, mediaTypeParts.value.format, t));

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
    kameMessage.error(t("common.openUrlFailed"));
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
    kameMessage.error(t("common.openFileFailed"));
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
    kameMessage.success(t("common.copySuccess"));
  } catch (error) {
    console.error("复制失败:", error);
    kameMessage.error(t("common.copyFailed"));
  }
};
</script>
