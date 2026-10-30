<template>
  <!-- 面板壳与标题恒定存在；无插件数据时显示空态（不随内容有无出现/消失） -->
  <CollapsibleDrawerPanel
    class="image-plugin-description-panel"
    storage-key="kabegame-image-detail-plugin-description-open"
    :collapsible="collapsible"
    :fill-when-expanded="fillWhenExpanded"
    :toggle-aria-label="t('gallery.toggleDetailPanel')"
  >
    <template #title>
      {{ t("gallery.toggleDetailPanel") }}
    </template>
    <div v-if="pageSnapshot" class="description-iframe-wrap">
      <div class="mb-2 flex min-w-0 items-center gap-2">
        <span
          class="min-w-0 flex-1 truncate text-[13px] text-[var(--anime-text-secondary)]"
          :title="pageSnapshot.sourceUrl"
        >
          {{ pageSnapshot.title || pageSnapshot.sourceUrl }}
        </span>
        <button
          type="button"
          class="flex flex-none cursor-pointer items-center rounded-md border border-solid border-[var(--anime-border)] bg-transparent p-1 text-[var(--anime-text-secondary)] hover:bg-[var(--anime-bg-card)]"
          :title="t('common.refresh')"
          :aria-label="t('common.refresh')"
          @click="snapshotFrameKey += 1"
        >
          <el-icon><Refresh /></el-icon>
        </button>
        <button
          v-if="isAllowedOpenUrl(pageSnapshot.sourceUrl)"
          type="button"
          class="flex-none cursor-pointer rounded-md border border-solid border-[var(--anime-border)] bg-transparent px-2.5 py-1 text-xs text-[var(--anime-primary)] hover:bg-[var(--anime-bg-card)]"
          @click="openExternalLink(pageSnapshot.sourceUrl)"
        >
          {{ t("gallery.openOriginalPage") }}
        </button>
      </div>
      <!-- 捕获的是任意网站的 HTML：sandbox 为空（无脚本/表单/弹窗/导航），另加内层 CSP -->
      <iframe
        :key="snapshotFrameKey"
        class="description-iframe"
        :srcdoc="pageSnapshotSrcdoc"
        sandbox=""
        referrerpolicy="no-referrer"
      />
    </div>
    <div v-else-if="descriptionSrcdoc" class="description-iframe-wrap">
      <!-- 插件 EJS 模板：opaque origin（不带 allow-same-origin），碰不到父页、不继承应用页的 file: 显示权；
           内层 CSP 禁止脚本动态请求，与宿主只经 postMessage 桥（__bridge）通信 -->
      <iframe
        ref="descriptionIframeRef"
        class="description-iframe"
        :srcdoc="descriptionSrcdoc"
        sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
        referrerpolicy="no-referrer"
      />
    </div>
    <div v-else-if="showRawMetadata" class="detail-metadata">
      <div v-for="(value, key) in rawMetadataEntries" :key="key" class="metadata-item">
        <span class="metadata-key">{{ key }}：</span>
        <span class="metadata-value">{{ formatMetadataValue(value) }}</span>
      </div>
    </div>
    <DetailPanelEmptyState
      v-else-if="effectiveMetadata !== undefined"
      :title="t('gallery.pluginDetailEmptyTitle')"
      :description="t('gallery.pluginDetailEmptyDesc')"
    />
  </CollapsibleDrawerPanel>
</template>

<script setup lang="ts">
import { usePluginDescriptionTemplate } from "@/services/pluginFiles";
import { computed, inject, onMounted, onUnmounted, ref, watch } from "vue";
import ejs from "ejs";
import { useI18n } from "@kabegame/i18n";
import CollapsibleDrawerPanel from "./CollapsibleDrawerPanel.vue";
import DetailPanelEmptyState from "./DetailPanelEmptyState.vue";
import DESCRIPTION_BRIDGE_INJECT_SCRIPT from "./descriptionBridgeInject.body.js?raw";
import type { ImageDetailLike } from "./ImageBasicInfoPanel.vue";
import { invoke } from "../../api";
import { getEjsBridgeCache, setEjsBridgeCache } from "../../cache/ejsBridgeCache";
import {
  imageMetadataResolverKey,
  normalizeFrozenTemplate,
  type ImageMetadataResolver,
  type ResolvedImageMetadata,
} from "../../composables/useImageMetadataCache";
import { usePluginStore, WEBPAGE_PLUGIN_ID } from "../../stores/plugins";
import { openExternalLink } from "../../utils/openExternalLink";
import { Refresh } from "@kabegame/element-plus-icons";

const props = withDefaults(
  defineProps<{
    image: ImageDetailLike | null;
    /** 是否允许收拢（详情弹窗桌面端并排三栏时关闭） */
    collapsible?: boolean;
    /** 展开时是否 flex:1 争夺容器剩余空间（preview 侧栏多面板共存时为 true） */
    fillWhenExpanded?: boolean;
  }>(),
  {
    collapsible: true,
    fillWhenExpanded: true,
  },
);

const { t, locale } = useI18n();
const pluginStore = usePluginStore();

function isRenderableMetadata(v: unknown): boolean {
  if (v == null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

const injectedResolveMetadata = inject<ImageMetadataResolver | null>(imageMetadataResolverKey, null);

/** 列表未带 metadata 时由懒加载写入；undefined 表示尚未完成一次解析 */
const resolvedMetadata = ref<unknown | null | undefined>(undefined);
const resolvedPluginVersion = ref(0);
/** metadata 行冻结的描述模板（CLI `--freeze-template`） */
const resolvedTemplate = ref<string | null>(null);

async function loadMetadataForImage(img: ImageDetailLike | null) {
  resolvedMetadata.value = undefined;
  resolvedPluginVersion.value = 0;
  resolvedTemplate.value = null;
  if (!img?.id) {
    resolvedMetadata.value = null;
    return;
  }
  // 畅游图片 plugin_id 为空（只有 surf_record_id），其 metadata 可能是一键下载冻结的页面快照
  if (!img.pluginId && !img.surfRecordId) {
    resolvedMetadata.value = null;
    return;
  }
  try {
    let resolved: ResolvedImageMetadata | null;
    if (injectedResolveMetadata) {
      resolved = await injectedResolveMetadata(img.id, img.metadataId);
    } else {
      const full = await invoke<{
        data?: unknown | null;
        pluginVersion?: number | null;
        template?: string | null;
      } | null>("get_image_metadata_full", {
        imageId: img.id,
      });
      resolved = full
        ? {
            data: full.data ?? null,
            pluginVersion:
              typeof full.pluginVersion === "number" && Number.isFinite(full.pluginVersion) && full.pluginVersion >= 0
                ? Math.floor(full.pluginVersion)
                : 0,
            template: normalizeFrozenTemplate(full.template),
          }
        : null;
    }
    resolvedMetadata.value = resolved?.data ?? null;
    resolvedPluginVersion.value = resolved?.pluginVersion ?? 0;
    resolvedTemplate.value = resolved?.template ?? null;
  } catch (e) {
    console.error("image detail metadata load failed", e);
    resolvedMetadata.value = null;
  }
}

watch(
  [() => props.image?.id, () => props.image?.metadataId],
  () => {
    console.log("reload metadata");
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

/** 畅游 / 网页收集冻结的页面快照 */
type PageSnapshot = {
  sourceUrl: string;
  title?: string;
  pageHtml: string;
};

/** 快照只来自畅游或保留 id 的内建网页收集，不信任 metadata 自带的 kind。 */
const isSnapshotSource = computed(() => {
  const img = props.image;
  if (!img) return false;
  return (!img.pluginId && !!img.surfRecordId) || img.pluginId === WEBPAGE_PLUGIN_ID;
});

const pageSnapshot = computed<PageSnapshot | null>(() => {
  if (!isSnapshotSource.value) return null;
  const meta = effectiveMetadata.value as Record<string, unknown> | null | undefined;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  if (typeof meta.pageHtml !== "string") return null;
  return {
    sourceUrl: typeof meta.sourceUrl === "string" ? meta.sourceUrl : "",
    title: typeof meta.title === "string" ? meta.title : undefined,
    pageHtml: meta.pageHtml,
  };
});

/** 只放行远程图片/媒体与内联样式；脚本、连接、子 frame、表单一律禁止 */
const PAGE_SNAPSHOT_CSP =
  "default-src 'none'; img-src http: https: data:; media-src http: https: data:; style-src 'unsafe-inline'; font-src data:; form-action 'none'";

/** 递增即重建快照 iframe（重新挂载子页面，重载远程图片等子资源） */
const snapshotFrameKey = ref(0);

const pageSnapshotSrcdoc = computed(() => {
  const snapshot = pageSnapshot.value;
  if (!snapshot) return "";
  // CSP meta 必须在任何资源之前生效，直接前置到文档最前
  return `<meta http-equiv="Content-Security-Policy" content="${PAGE_SNAPSHOT_CSP}">${snapshot.pageHtml}`;
});

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
      iframeWin.postMessage({ type: "ejs-bridge-response", id, data: locale.value ?? "en" }, "*");
      return;
    }
    if (action === "getPluginData") {
      const pluginId = props.image?.pluginId ?? "";
      if (!pluginId) {
        iframeWin.postMessage({ type: "ejs-bridge-response", id, error: "missing plugin id" }, "*");
        return;
      }
      void invoke("get_plugin_data", { pluginId })
        .then((data: unknown) => {
          iframeWin.postMessage({ type: "ejs-bridge-response", id, data }, "*");
        })
        .catch((err: unknown) => {
          iframeWin.postMessage({ type: "ejs-bridge-response", id, error: String(err) }, "*");
        });
      return;
    }
    if (action === "getCache" || action === "setCache") {
      const pluginId = props.image?.pluginId ?? "";
      const key = typeof d.key === "string" ? d.key.trim() : "";
      if (!pluginId || !key || key.length > 200) {
        iframeWin.postMessage({ type: "ejs-bridge-response", id, error: "invalid cache key" }, "*");
        return;
      }
      if (action === "getCache") {
        void getEjsBridgeCache(pluginId, key)
          .then((data: unknown) => {
            iframeWin.postMessage({ type: "ejs-bridge-response", id, data }, "*");
          })
          .catch((err: unknown) => {
            iframeWin.postMessage({ type: "ejs-bridge-response", id, error: String(err) }, "*");
          });
        return;
      }
      void setEjsBridgeCache(pluginId, key, d.data ?? null)
        .then(() => {
          iframeWin.postMessage({ type: "ejs-bridge-response", id, data: true }, "*");
        })
        .catch((err: unknown) => {
          iframeWin.postMessage({ type: "ejs-bridge-response", id, error: String(err) }, "*");
        });
      return;
    }
    if (action === "openUrl") {
      const url = typeof d.url === "string" ? d.url : "";
      if (!isAllowedOpenUrl(url)) {
        iframeWin.postMessage({ type: "ejs-bridge-response", id, error: "invalid url" }, "*");
        return;
      }
      void openExternalLink(url)
        .then(() => {
          iframeWin.postMessage({ type: "ejs-bridge-response", id }, "*");
        })
        .catch((err: unknown) => {
          iframeWin.postMessage({ type: "ejs-bridge-response", id, error: String(err) }, "*");
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

const templatePlugin = computed(() => pluginStore.plugins.find((p) => p.id === props.image?.pluginId));
const { text: pluginTemplate, loading: pluginTemplateLoading } = usePluginDescriptionTemplate(templatePlugin);
// metadata 冻结模板与插件模板并行获取，前者非空即覆盖；有冻结模板时不等插件模板
const descriptionTemplate = computed(() => resolvedTemplate.value ?? pluginTemplate.value);
const templateLoading = computed(() => !resolvedTemplate.value && pluginTemplateLoading.value);

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

/**
 * 详情 iframe 的内层 CSP：禁止脚本动态请求（fetch / XHR / WebSocket / beacon），元素级远程图片照常；
 * `frame-src about:` 只放嵌套的 srcdoc / about:blank 子 frame（如来源页面快照），file: 与 http(s) frame 被拒。
 * 与父页策略取交集，脚本仍需 nonce；`__bridge.fetch` 走 postMessage，不受 `connect-src` 影响。
 */
const DESCRIPTION_CSP =
  `default-src 'none'; script-src 'unsafe-inline' 'nonce-${EJS_BRIDGE_NONCE}'; style-src 'unsafe-inline'; ` +
  "img-src https: http: data: blob:; media-src https: http: data: blob:; font-src data:; " +
  "connect-src 'none'; frame-src about:; form-action 'none'; base-uri 'none'";

const descriptionSrcdoc = computed(() => {
  const img = props.image;
  const meta = effectiveMetadata.value;
  if (pageSnapshot.value) return "";

  if (!img?.pluginId || !isRenderableMetadata(meta)) return "";
  const tpl = descriptionTemplate.value;
  if (!tpl?.trim()) return "";
  try {
    let body = ejs.render(
      tpl,
      { metadata: meta, plugin_version: resolvedPluginVersion.value },
      { rmWhitespace: false },
    );
    body = body.replace(/<script(?![^>]*\bnonce[=\s])/gi, `<script nonce="${EJS_BRIDGE_NONCE}"`);
    const theme = buildDescriptionIframeThemeStyles();
    // CSP meta 必须在任何资源与脚本之前生效，前置到文档最前
    return `<meta http-equiv="Content-Security-Policy" content="${DESCRIPTION_CSP}">${theme}<script nonce="${EJS_BRIDGE_NONCE}">${DESCRIPTION_BRIDGE_INJECT_SCRIPT}<\/script>${body}`;
  } catch (e) {
    console.error("image detail EJS render failed", e);
    return "";
  }
});

const showRawMetadata = computed(() => {
  const img = props.image;
  const meta = effectiveMetadata.value;
  if (pageSnapshot.value || templateLoading.value) return false;
  if (!img?.pluginId || !isRenderableMetadata(meta)) return false;
  const tpl = descriptionTemplate.value;
  if (tpl?.trim()) return false;
  return meta != null && typeof meta === "object" && !Array.isArray(meta);
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
</script>

<style scoped lang="scss">
/* 外框/标题栏 chrome 由 CollapsibleDrawerPanel 提供 */
.image-plugin-description-panel {
  min-width: 0;
}

.description-iframe-wrap {
  display: flex;
  min-height: 160px;
  flex: 1 1 auto;
  flex-direction: column;
  padding: 12px;
}

.description-iframe {
  box-sizing: border-box;
  width: 100%;
  min-height: 160px;
  flex: 1 1 auto;
  border: 1px solid var(--anime-border);
  border-radius: 10px;
  background: var(--anime-bg-card);
}

.detail-metadata {
  display: flex;
  min-height: 0;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 8px;
  overflow: auto;
  padding: 12px;
}

.metadata-item {
  display: flex;
  gap: 8px;
  padding: 8px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--anime-secondary) 7%, transparent);
}

.metadata-key {
  min-width: 100px;
  flex-shrink: 0;
  color: var(--anime-text-secondary);
  font-weight: 500;
}

.metadata-value {
  min-width: 0;
  flex: 1;
  color: var(--anime-text-primary);
  word-break: break-all;
}
</style>
