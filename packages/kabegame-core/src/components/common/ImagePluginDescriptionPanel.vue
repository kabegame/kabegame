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
    <div v-if="descriptionSrcdoc" class="description-iframe-wrap">
      <iframe
        ref="descriptionIframeRef"
        class="description-iframe"
        :srcdoc="descriptionSrcdoc"
        sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
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
  type ImageMetadataResolver,
} from "../../composables/useImageMetadataCache";
import { usePluginStore } from "../../stores/plugins";
import { openExternalLink } from "../../utils/openExternalLink";

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

const injectedResolveMetadata = inject<ImageMetadataResolver | null>(
  imageMetadataResolverKey,
  null,
);

/** 列表未带 metadata 时由懒加载写入；undefined 表示尚未完成一次解析 */
const resolvedMetadata = ref<unknown | null | undefined>(undefined);
const resolvedPluginVersion = ref(0);

type ImageMetadataFullPayload = {
  data?: unknown | null;
  pluginVersion?: number | null;
} | null;

function pluginVersionForImage(img: ImageDetailLike | null): number {
  const version = img?.pluginVersion;
  return typeof version === "number" && Number.isFinite(version) && version >= 0
    ? Math.floor(version)
    : 0;
}

async function loadMetadataForImage(img: ImageDetailLike | null) {
  resolvedMetadata.value = undefined;
  resolvedPluginVersion.value = pluginVersionForImage(img);
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
      const m = await injectedResolveMetadata(img.id, resolvedPluginVersion.value);
      resolvedMetadata.value = m ?? null;
    } else {
      const full = await invoke<ImageMetadataFullPayload>("get_image_metadata_full", {
        imageId: img.id,
      });
      resolvedPluginVersion.value =
        typeof full?.pluginVersion === "number" &&
        Number.isFinite(full.pluginVersion) &&
        full.pluginVersion >= 0
          ? Math.floor(full.pluginVersion)
          : resolvedPluginVersion.value;
      resolvedMetadata.value = full?.data ?? null;
    }
  } catch (e) {
    console.error("image detail metadata load failed", e);
    resolvedMetadata.value = null;
  }
}

watch(
  [() => props.image?.metadataId],
  () => {
    console.log('reload metadata');
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
      void openExternalLink(url)
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
      { metadata: meta, plugin_version: resolvedPluginVersion.value },
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
