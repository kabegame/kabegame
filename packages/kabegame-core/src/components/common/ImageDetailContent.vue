<template>
  <div v-if="image" class="image-detail-content">
    <div class="detail-fields-collapsible-wrap">
      <CollapsibleDrawerPanel
        storage-key="kabegame-image-detail-fields-open"
        :fill-when-expanded="false"
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
                v-if="pluginFilterTarget"
                type="button"
                class="detail-filter-link"
                :title="t('gallery.filterByPlugin')"
                @click="emitGalleryFilter(pluginFilterTarget)"
              >{{ getPluginName(image.pluginId) }}</button>
              <span v-else class="detail-value">{{ getPluginName(image.pluginId) }}</span>
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
    </div>
    <div v-if="descriptionSrcdoc" class="description-collapsible-wrap">
      <CollapsibleDrawerPanel
        storage-key="kabegame-image-detail-description-open"
        :toggle-aria-label="t('gallery.imageDetailPluginInfoToggle')"
      >
        <template #title>
          {{ t('gallery.imageDetailMoreSection') }}
        </template>
        <div class="description-iframe-wrap">
          <iframe
            ref="descriptionIframeRef"
            class="description-iframe"
            :srcdoc="descriptionSrcdoc"
            sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
            referrerpolicy="no-referrer"
          />
        </div>
      </CollapsibleDrawerPanel>
    </div>
    <div
      v-else-if="showRawMetadata"
      class="detail-item"
    >
      <span class="detail-label">{{ t('gallery.imageDetailMetadata') }}</span>
      <div class="detail-metadata">
        <div v-for="(value, key) in rawMetadataEntries" :key="key" class="metadata-item">
          <span class="metadata-key">{{ key }}：</span>
          <span class="metadata-value">{{ formatMetadataValue(value) }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, onMounted, onUnmounted, ref, watch } from "vue";
import ejs from "ejs";
import DESCRIPTION_BRIDGE_INJECT_SCRIPT from "./descriptionBridgeInject.body.js?raw";
import CollapsibleDrawerPanel from "./CollapsibleDrawerPanel.vue";
import { useI18n, resolveManifestText } from "@kabegame/i18n";
import { invoke } from "../../api";
import { openUrl } from "@tauri-apps/plugin-opener";
import { kameMessage as ElMessage } from "@kabegame/core/utils/kameMessage";
import { List } from "@element-plus/icons-vue";
import { IS_ANDROID, IS_WEB } from "../../env";
import { openImage } from "tauri-plugin-picker-api";
import { Plugin, usePluginStore } from "../../stores/plugins";
import {
  imageMetadataResolverKey,
  type ImageMetadataResolver,
} from "../../composables/useImageMetadataCache";
import { displayImageMimeType, isVideoMediaType } from "../../utils/mediaMime";
import { getEjsBridgeCache, setEjsBridgeCache } from "../../cache/ejsBridgeCache";

const { t, locale } = useI18n();
const pluginStore = usePluginStore();

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
  metadataVersion?: number;
  size?: number;
  width?: number;
  height?: number;
  taskId?: string;
  postUrl?: string;
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
}

const props = defineProps<Props>();

const emit = defineEmits<{
  "open-task": [taskId: string];
  "open-gallery-filter": [target: ImageDetailGalleryFilterTarget];
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

function isRenderableMetadata(v: unknown): boolean {
  if (v == null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

const injectedResolveMetadata = inject<ImageMetadataResolver | null>(
  imageMetadataResolverKey,
  null,
);

/** 列表未带 metadata 时由懒加载写入；undefined 表示尚未完成一次解析 */
const resolvedMetadata = ref<unknown | null | undefined>(undefined);
const resolvedMetadataVersion = ref(0);

type ImageMetadataFullPayload = {
  data?: unknown | null;
  version?: number | null;
} | null;

function metadataVersionForImage(img: ImageDetailLike | null): number {
  const version = img?.metadataVersion;
  return typeof version === "number" && Number.isFinite(version) && version >= 0
    ? Math.floor(version)
    : 0;
}

async function loadMetadataForImage(img: ImageDetailLike | null) {
  // resolvedMetadata.value = undefined;
  resolvedMetadataVersion.value = metadataVersionForImage(img);
  if (!img?.id) {
    resolvedMetadata.value = null;
    return;
  }
  if (isRenderableMetadata(img.metadata)) {
    resolvedMetadata.value = null;
    return;
  }
  if (!img.pluginId) {
    resolvedMetadata.value = null;
    return;
  }
  try {
    if (injectedResolveMetadata) {
      const m = await injectedResolveMetadata(img.id, resolvedMetadataVersion.value);
      resolvedMetadata.value = m ?? null;
    } else {
      const full = await invoke<ImageMetadataFullPayload>("get_image_metadata_full", {
        imageId: img.id,
      });
      resolvedMetadataVersion.value =
        typeof full?.version === "number" && Number.isFinite(full.version) && full.version >= 0
          ? Math.floor(full.version)
          : resolvedMetadataVersion.value;
      resolvedMetadata.value = full?.data ?? null;
    }
  } catch (e) {
    console.error("image detail metadata load failed", e);
    resolvedMetadata.value = null;
  }
}

watch(
  [() => props.image?.id, () => props.image?.metadataVersion],
  () => {
    void loadMetadataForImage(props.image ?? null);
  },
  { immediate: true },
);

const effectiveMetadata = computed(() => {
  const img = props.image;
  if (!img) return undefined;
  if (isRenderableMetadata(img.metadata)) return img.metadata;
  return resolvedMetadata.value;
});

const descriptionIframeRef = ref<HTMLIFrameElement | null>(null);

function isAllowedOpenUrl(u: string): boolean {
  try {
    const parsed = new URL(u);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function onIframeBridgeMessage(event: MessageEvent) {
  const iframeWin = descriptionIframeRef.value?.contentWindow;
  if (!iframeWin || event.source !== iframeWin) return;
  const d = event.data as Record<string, unknown> | null;
  if (!d || typeof d !== "object") return;

  if (d.type === "ejs-fetch") {
    const payload = d as {
      id: number;
      url: string;
      options?: { headers?: Record<string, string> };
    };
    const { id, url, options } = payload;
    const rawHeaders = options?.headers;
    const headers: Record<string, string> | undefined =
      rawHeaders && typeof rawHeaders === "object"
        ? Object.fromEntries(Object.entries(rawHeaders).map(([k, v]) => [k, String(v)]))
        : undefined;
    void invoke("proxy_fetch", { url, headers })
      .then((data: unknown) => {
        iframeWin.postMessage({ type: "ejs-fetch-response", id, data }, "*");
      })
      .catch((err: unknown) => {
        iframeWin.postMessage({ type: "ejs-fetch-response", id, error: String(err) }, "*");
      });
    return;
  }

  if (d.type === "ejs-bridge") {
    const id = d.id as number;
    const action = d.action as string;
    if (action === "getLocale") {
      iframeWin.postMessage(
        { type: "ejs-bridge-response", id, data: locale.value ?? "en" },
        "*",
      );
      return;
    }
    if (action === "getPluginData") {
      const pluginId = props.image?.pluginId ?? "";
      if (!pluginId) {
        iframeWin.postMessage(
          { type: "ejs-bridge-response", id, error: "missing plugin id" },
          "*",
        );
        return;
      }
      void invoke("get_plugin_data", { pluginId })
        .then((data: unknown) => {
          iframeWin.postMessage({ type: "ejs-bridge-response", id, data }, "*");
        })
        .catch((err: unknown) => {
          iframeWin.postMessage(
            { type: "ejs-bridge-response", id, error: String(err) },
            "*",
          );
      });
      return;
    }
    if (action === "getCache" || action === "setCache") {
      const pluginId = props.image?.pluginId ?? "";
      const key = typeof d.key === "string" ? d.key.trim() : "";
      if (!pluginId || !key || key.length > 200) {
        iframeWin.postMessage(
          { type: "ejs-bridge-response", id, error: "invalid cache key" },
          "*",
        );
        return;
      }
      if (action === "getCache") {
        void getEjsBridgeCache(pluginId, key)
          .then((data: unknown) => {
            iframeWin.postMessage({ type: "ejs-bridge-response", id, data }, "*");
          })
          .catch((err: unknown) => {
            iframeWin.postMessage(
              { type: "ejs-bridge-response", id, error: String(err) },
              "*",
            );
          });
        return;
      }
      void setEjsBridgeCache(pluginId, key, d.data ?? null)
        .then(() => {
          iframeWin.postMessage({ type: "ejs-bridge-response", id, data: true }, "*");
        })
        .catch((err: unknown) => {
          iframeWin.postMessage(
            { type: "ejs-bridge-response", id, error: String(err) },
            "*",
          );
        });
      return;
    }
    if (action === "openUrl") {
      const url = typeof d.url === "string" ? d.url : "";
      if (!isAllowedOpenUrl(url)) {
        iframeWin.postMessage(
          { type: "ejs-bridge-response", id, error: "invalid url" },
          "*",
        );
        return;
      }
      // web 端走浏览器新标签页（Tauri 的 openUrl 插件仅桌面/移动可用）
      if (IS_WEB) {
        try {
          window.open(url, "_blank", "noopener,noreferrer");
          iframeWin.postMessage({ type: "ejs-bridge-response", id }, "*");
        } catch (err: unknown) {
          iframeWin.postMessage(
            { type: "ejs-bridge-response", id, error: String(err) },
            "*",
          );
        }
        return;
      }
      void openUrl(url)
        .then(() => {
          iframeWin.postMessage({ type: "ejs-bridge-response", id }, "*");
        })
        .catch((err: unknown) => {
          iframeWin.postMessage(
            { type: "ejs-bridge-response", id, error: String(err) },
            "*",
          );
        });
    }
  }
}

onMounted(() => {
  window.addEventListener("message", onIframeBridgeMessage);
});
onUnmounted(() => {
  window.removeEventListener("message", onIframeBridgeMessage);
});

function pluginDescriptionTemplate(pluginId: string): string | undefined {
  return pluginStore.pluginDescriptionTemplate(pluginId);
}

/**
 * iframe srcdoc 是独立文档，无法继承主应用 :root 上的 --anime-*。
 * 用探测节点解析当前主题下的计算色，写入子文档 :root，使插件模板里 var(--anime-*) 生效。
 */
function buildDescriptionIframeThemeStyles(): string {
  if (typeof document === "undefined" || !document.body) return "";
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:fixed;left:-9999px;top:0;visibility:hidden;pointer-events:none;border:1px solid transparent;";
  document.body.appendChild(probe);

  const snapColor = (prop: "color" | "backgroundColor", value: string): string => {
    probe.style.color = "";
    probe.style.backgroundColor = "";
    if (prop === "color") probe.style.color = value;
    else probe.style.backgroundColor = value;
    return getComputedStyle(probe)[prop];
  };

  const textPrimary = snapColor("color", "var(--anime-text-primary)");
  const textSecondary = snapColor("color", "var(--anime-text-secondary)");
  const primaryAccent = snapColor("color", "var(--anime-primary)");
  probe.style.border = "1px solid";
  probe.style.borderColor = "var(--anime-border)";
  const borderColor = getComputedStyle(probe).borderTopColor;
  const bgCard = snapColor("backgroundColor", "var(--anime-bg-card)");

  document.body.removeChild(probe);

  const rules = [
    `--anime-text-primary:${textPrimary}`,
    `--anime-text-secondary:${textSecondary}`,
    `--anime-primary:${primaryAccent}`,
    `--anime-border:${borderColor}`,
    `--anime-bg-card:${bgCard}`,
  ].join(";");

  return `<style>:root{${rules}}html,body{margin:0;padding:8px;background:var(--anime-bg-card);color:var(--anime-text-primary);}body{box-sizing:border-box;}</style>`;
}

const EJS_BRIDGE_NONCE = "kabegame-ejs-bridge";

const descriptionSrcdoc = computed(() => {
  const img = props.image;
  const meta = effectiveMetadata.value;

  if (!img?.pluginId || !isRenderableMetadata(meta)) return "";
  const tpl = pluginDescriptionTemplate(img.pluginId);
  if (!tpl?.trim()) return "";
  try {
    let body = ejs.render(
      tpl,
      { metadata: meta, metadata_version: resolvedMetadataVersion.value },
      { rmWhitespace: false },
    );
    body = body.replace(/<script(?![^>]*\bnonce[=\s])/gi, `<script nonce="${EJS_BRIDGE_NONCE}"`);
    const theme = buildDescriptionIframeThemeStyles();
    return `${theme}<script nonce="${EJS_BRIDGE_NONCE}">${DESCRIPTION_BRIDGE_INJECT_SCRIPT}<\/script>${body}`;
  } catch (e) {
    console.error("image detail EJS render failed", e);
    return "";
  }
});

const showRawMetadata = computed(() => {
  const img = props.image;
  const meta = effectiveMetadata.value;
  if (!img?.pluginId || !isRenderableMetadata(meta)) return false;
  const tpl = pluginDescriptionTemplate(img.pluginId);
  if (tpl?.trim()) return false;
  return true;
});

const rawMetadataEntries = computed(() => {
  const m = effectiveMetadata.value;
  if (m == null || typeof m !== "object" || Array.isArray(m)) return {};
  return m as Record<string, unknown>;
});

function formatMetadataValue(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
    return String(v);
  }
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** 与 TaskSummaryRow 一致：回退用 pluginStore.pluginLabel（含 local-import → tasks.drawerLocalImport） */
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
    if (IS_WEB) {
      window.open(url, "_blank", "noopener,noreferrer");
    } else {
      await openUrl(url);
    }
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
</script>

<style scoped lang="scss">
.image-detail-content {
  display: flex;
  flex-direction: column;
  gap: 16px;
  height: 100%;

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

  .detail-fields-collapsible-wrap {
    flex-shrink: 0;

    :deep(.kb-collapsible-panel__body) {
      padding-bottom: 12px;
    }
  }

  .detail-fields-body {
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 0 12px;
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

  .detail-metadata {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 8px;
  }

  .metadata-item {
    display: flex;
    gap: 8px;
    padding: 8px;
    background: var(--anime-bg-card);
    border-radius: 4px;
  }

  .metadata-key {
    font-weight: 500;
    color: var(--anime-text-secondary);
    min-width: 100px;
    flex-shrink: 0;
  }

  .metadata-value {
    color: var(--anime-text-primary);
    word-break: break-all;
    flex: 1;
  }

  .description-collapsible-wrap {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;

    :deep(.kb-collapsible-panel) {
      flex: 1;
      min-height: 0;
    }

    :deep(.kb-collapsible-panel__body) {
      padding: 0 12px 12px;
    }
  }

  .description-iframe-wrap {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .description-iframe {
    box-sizing: border-box;
    width: 100%;
    min-height: 160px;
    border: 1px solid var(--anime-border);
    border-radius: 10px;
    background: var(--anime-bg-card);
    flex: 1;
  }
}
</style>
