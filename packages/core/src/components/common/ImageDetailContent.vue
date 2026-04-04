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
            <span class="detail-value line-clamp-2" :title="image.displayName">{{ image.displayName }}</span>
          </div>
          <div class="detail-item">
            <span class="detail-label">{{ t('gallery.imageDetailSource') }}</span>
            <span class="detail-value">{{ getPluginName(image.pluginId) }}</span>
          </div>
          <div v-if="image.taskId" class="detail-item">
            <span class="detail-label">{{ t('gallery.imageDetailTaskLabel') }}</span>
            <el-button size="small" link type="primary" @click="handleOpenTask">
              {{ t('gallery.imageDetailOpenTask') }}
            </el-button>
          </div>
          <div class="detail-item">
            <span class="detail-label">{{ t('gallery.imageDetailType') }}</span>
            <span class="detail-value">{{ imageTypeLabel }}</span>
          </div>
          <div v-if="image.url && !isFileUrl(image.url)" class="detail-item">
            <span class="detail-label">{{ t('gallery.imageDetailUrl') }}</span>
            <span
              class="detail-value line-clamp-2 clickable-link"
              :title="image.url"
              @click="handleOpenUrl(image.url)"
            >{{ image.url }}</span>
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
            <span class="detail-value">{{ formatDate(image.crawledAt) }}</span>
          </div>
          <div v-if="image.size != null" class="detail-item">
            <span class="detail-label">{{ t('gallery.imageDetailSize') }}</span>
            <span class="detail-value">{{ formatBytes(image.size) }}</span>
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
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ElMessage } from "element-plus";
import { IS_ANDROID } from "../../env";
import { openImage } from "tauri-plugin-picker-api";
import { useInstalledPluginsStore, usePluginStore } from "../../stores/plugins";
import {
  imageMetadataResolverKey,
  type ImageMetadataResolver,
} from "../../composables/useImageMetadataCache";
import { displayImageMimeType } from "../../utils/mediaMime";

const { t, locale } = useI18n();
const pluginStore = usePluginStore();
const installedPluginsStore = useInstalledPluginsStore();

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
  taskId?: string;
};

interface Props {
  image: ImageDetailLike | null;
  plugins?: Array<{ id: string; name?: string }>;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  "open-task": [taskId: string];
}>();

function handleOpenTask() {
  const tid = props.image?.taskId;
  if (tid) emit("open-task", tid);
}

const imageTypeLabel = computed((): string => {
  if (!props.image) return "";
  return displayImageMimeType(props.image.type);
});

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

async function loadMetadataForImage(img: ImageDetailLike | null) {
  // resolvedMetadata.value = undefined;
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
    const fn =
      injectedResolveMetadata ??
      (async (imageId: string, metadataId?: number) =>
        metadataId != null
          ? invoke<unknown | null>("get_image_metadata_by_metadata_id", {
              metadataId,
            })
          : invoke<unknown | null>("get_image_metadata", { imageId }));
    const m = await fn(img.id, img.metadataId);
    resolvedMetadata.value = m ?? null;
  } catch (e) {
    console.error("image detail metadata load failed", e);
    resolvedMetadata.value = null;
  }
}

watch(
  () => props.image?.id,
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
    if (action === "openUrl") {
      const url = typeof d.url === "string" ? d.url : "";
      if (!isAllowedOpenUrl(url)) {
        iframeWin.postMessage(
          { type: "ejs-bridge-response", id, error: "invalid url" },
          "*",
        );
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
  const a = pluginStore.pluginDescriptionTemplate(pluginId);
  if (a) return a;
  const b = installedPluginsStore.pluginDescriptionTemplate(pluginId);
  return b;
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
    let body = ejs.render(tpl, { metadata: meta }, { rmWhitespace: false });
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
    await openUrl(url);
  } catch (error) {
    console.error("打开 URL 失败:", error);
    ElMessage.error(t("common.openUrlFailed"));
  }
};

const handleOpenPath = async (path?: string) => {
  if (!path) return;
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
