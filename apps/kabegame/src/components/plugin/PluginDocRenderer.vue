<template>
  <div ref="docRootRef" class="doc-root">
    <div v-if="loading" class="flex flex-col gap-3 py-2">
      <Skeleton class="h-5 w-2/5" />
      <Skeleton v-for="i in 5" :key="i" class="h-3.5" :class="i === 5 ? 'w-3/5' : 'w-full'" />
    </div>
    <Empty v-else-if="!markdown" :title="effectiveEmptyDescription">
      <template #icon><FileText /></template>
    </Empty>
    <div v-else class="doc" v-html="html"></div>

    <!-- 紧凑端：photoswipe-vue（捏合缩放），不循环。挂进所在的对话框（如导入插件）而不是 body：
         Reka 的模态对话框打开时 body 不可点、焦点被锁在对话框里 -->
    <PhotoSwipe
      v-if="uiStore.isCompact"
      :open="pswpModal.isOpen.value"
      :append-to="pswpAppendTo"
      v-model:index="docPswpIndex"
      :data-source="docPswpDataSource"
      :loop="false"
      :z-index="pswpModal.zIndex.value"
      @update:open="pswpModal.close"
      @close="handleDocPreviewClose"
    />

    <!-- 桌面：灯箱（方向键翻页、滚轮缩放），不循环 -->
    <Lightbox
      v-if="!uiStore.isCompact"
      v-model:open="desktopViewerOpen"
      v-model:index="docDesktopIndex"
      :images="docDesktopUrlList"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, watchEffect } from "vue";
import { FileText } from "@lucide/vue";
import { Empty, Lightbox, Skeleton } from "@/components/ui";
import DOMPurify from "dompurify";
import { marked } from "marked";
// @ts-expect-error - Vue SFC component import, types resolved via package.json exports
import PhotoSwipe from "photoswipe-vue/vue";
import "photoswipe-vue/photoswipe.css";
import { useI18n } from "@kabegame/i18n";
import { useModal } from "../../composables/useModal";
import { useUiStore } from "@/stores/ui";
import { openExternalLink } from "../../utils/openExternalLink";
import { pluginAssetUrl } from "@/services/pluginFiles";
import type { Plugin } from "@/stores/plugins";
import { normalizeAssetPath } from "../../utils/assetPath";

/** 文档目录项：id 是渲染时打进标题的锚点，序号即下标，与 DOM 锚点天然一一对应 */
export interface DocHeading {
  id: string;
  text: string;
  level: number;
}

const props = withDefaults(
  defineProps<{
    markdown?: string | null;
    emptyDescription?: string;
    /**
     * 插件清单与资源键：图片经插件文件统一出口读取，key 由 `normalizeAssetPath` 裁决，
     * 与后端 `assets::normalize_asset_path` 同构。
     */
    plugin?: Plugin | null;
    loading?: boolean;
    /** 标题锚点前缀；同页多个渲染器实例（如 说明/更新记录 tab 同时挂载）必须各自不同 */
    anchorPrefix?: string;
  }>(),
  {
    anchorPrefix: "kbdoc",
  },
);

const { t } = useI18n();

const emit = defineEmits<{
  (e: "image-preview-open", payload: DocImagePreviewPayload): void;
  (e: "image-preview-close", payload: DocImagePreviewPayload): void;
  (e: "headings", headings: DocHeading[]): void;
}>();

type DocImagePreviewPayload = {
  index: number;
  count: number;
  src: string;
  alt: string;
};

const effectiveEmptyDescription = computed(() => props.emptyDescription ?? t("common.pluginNoDoc"));

const html = ref("");
const docRootRef = ref<HTMLElement | null>(null);

/** Android PhotoSwipe */
const pswpModal = useModal();
const docPswpIndex = ref(0);
const docPswpDataSource = ref<Array<{ src: string; width: number; height: number }>>([]);

const uiStore = useUiStore();

/** 桌面灯箱（自己接返回栈与层级，不再借 useModal） */
const desktopViewerOpen = ref(false);
const docDesktopUrlList = ref<string[]>([]);
const docDesktopIndex = ref(0);
watch(desktopViewerOpen, (open) => {
  if (!open) handleDocPreviewClose();
});

/** photoswipe 的挂载点：在对话框里时挂进对话框，否则 body */
const pswpAppendTo = ref<HTMLElement | string>("body");
const currentDocPreview = ref<DocImagePreviewPayload | null>(null);

const PSWP_FALLBACK_W = 1920;
const PSWP_FALLBACK_H = 1080;

/** 解析文档内图片的自然尺寸，供 Android PhotoSwipe dataSource 使用（避免错误宽高比）。 */
async function naturalSizeForDocImage(el: HTMLImageElement, src: string): Promise<{ width: number; height: number }> {
  if (el.complete && el.naturalWidth > 0 && el.naturalHeight > 0) {
    return { width: el.naturalWidth, height: el.naturalHeight };
  }
  return new Promise((resolve) => {
    const im = new Image();
    im.onload = () => {
      resolve({
        width: im.naturalWidth > 0 ? im.naturalWidth : PSWP_FALLBACK_W,
        height: im.naturalHeight > 0 ? im.naturalHeight : PSWP_FALLBACK_H,
      });
    };
    im.onerror = () => resolve({ width: PSWP_FALLBACK_W, height: PSWP_FALLBACK_H });
    im.src = src;
  });
}

async function buildDocPreviewMeta(imgs: HTMLImageElement[]) {
  const items: Array<{ src: string; width: number; height: number }> = [];
  const urls: string[] = [];
  for (let i = 0; i < imgs.length; i++) {
    const el = imgs[i];
    const src = el.getAttribute("src")?.trim() || "";
    const { width, height } = await naturalSizeForDocImage(el, src);
    items.push({ src, width, height });
    urls.push(src);
  }
  return { items, urls };
}

const handleDocClick = (e: MouseEvent) => {
  const img = (e.target as HTMLElement).closest(".doc img");
  if (img) {
    const docEl = docRootRef.value?.querySelector(".doc");
    if (!docEl || !docEl.contains(img)) return;
    const imgs = Array.from(docEl.querySelectorAll("img")) as HTMLImageElement[];
    const index = imgs.indexOf(img as HTMLImageElement);
    if (index < 0) return;
    e.preventDefault();
    e.stopPropagation();
    void (async () => {
      const { items, urls } = await buildDocPreviewMeta(imgs);
      const el = img as HTMLImageElement;
      const previewPayload = {
        index,
        count: imgs.length,
        src: el.getAttribute("src")?.trim() || "",
        alt: el.getAttribute("alt")?.trim() || "",
      };
      currentDocPreview.value = previewPayload;
      emit("image-preview-open", previewPayload);
      if (uiStore.isCompact) {
        docPswpDataSource.value = items;
        docPswpIndex.value = index;
        pswpAppendTo.value = docRootRef.value?.closest<HTMLElement>('[role="dialog"]') ?? "body";
        await nextTick();
        pswpModal.open();
      } else {
        docDesktopUrlList.value = urls;
        docDesktopIndex.value = index;
        desktopViewerOpen.value = true;
      }
    })();
    return;
  }

  const a = (e.target as HTMLElement).closest("a");
  if (!a || !a.href) return;
  const href = a.getAttribute("href");
  if (!href || (!href.startsWith("http:") && !href.startsWith("https:"))) return;
  e.preventDefault();
  void openExternalLink(href);
};

const handleDocPreviewClose = () => {
  if (currentDocPreview.value) {
    emit("image-preview-close", currentDocPreview.value);
    currentDocPreview.value = null;
  }
};

onMounted(() => {
  docRootRef.value?.addEventListener("click", handleDocClick);
});
onBeforeUnmount(() => {
  docRootRef.value?.removeEventListener("click", handleDocClick);
});

const md = computed(() => (props.markdown || "").trim());

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const sanitizeHtml = (rawHtml: string): string => {
  const sanitized = DOMPurify.sanitize(rawHtml, {
    USE_PROFILES: { html: true },
    ADD_DATA_URI_TAGS: ["img"],
  });

  // 后处理：让所有链接在新窗口打开
  return sanitized.replace(
    /<a\s+([^>]*?)href\s*=\s*["']([^"']*)["']([^>]*?)>/gi,
    (match, beforeHref, href, afterHref) => {
      // 如果已经有target="_blank"，则不修改
      if (afterHref.includes('target="_blank"') || afterHref.includes("target='_blank'")) {
        return match;
      }
      // 添加target="_blank"和rel属性
      return `<a ${beforeHref}href="${href}"${afterHref} target="_blank" rel="noopener noreferrer">`;
    },
  );
};

const renderMarkdown = async (
  markdown: string,
  plugin?: Plugin | null,
): Promise<{ html: string; headings: DocHeading[] }> => {
  if (!markdown) return { html: "", headings: [] };

  // 1) 解析图片引用：![alt](path)，路径中可含括号，用括号计数找闭合 ) 避免正文如「胡桃(原神)」干扰
  const imageMatches: Array<{ match: string; alt: string; path: string }> = [];
  let searchIndex = 0;
  while (searchIndex < markdown.length) {
    const imgStart = markdown.indexOf("![", searchIndex);
    if (imgStart === -1) break;

    const altStart = imgStart + 2;
    const altEnd = markdown.indexOf("]", altStart);
    if (altEnd === -1) break;

    const pathStart = markdown.indexOf("(", altEnd);
    if (pathStart === -1 || pathStart !== altEnd + 1) break;

    let depth = 1;
    let pathEnd = -1;
    for (let i = pathStart + 1; i < markdown.length; i++) {
      const c = markdown[i];
      if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        if (depth === 0) {
          pathEnd = i;
          break;
        }
      }
    }
    if (pathEnd === -1) break;

    const altText = markdown.substring(altStart, altEnd);
    const imagePath = markdown.substring(pathStart + 1, pathEnd);
    const fullMatch = markdown.substring(imgStart, pathEnd + 1);

    imageMatches.push({ match: fullMatch, alt: altText, path: imagePath });
    searchIndex = pathEnd + 1;
  }

  // 2) 替换本地图片引用：用 plugin.assetKeys 按需读取。
  //    外链（http/https/data/协议相对）归一化返回 null，原样留给 marked 渲染。
  const assetKeys = new Set(plugin?.assetKeys ?? []);
  const urls = new Map<string, string>();
  if (plugin) {
    await Promise.all(
      [
        ...new Set(
          imageMatches
            .map((img) => normalizeAssetPath(img.path))
            .filter((key): key is string => !!key && assetKeys.has(key)),
        ),
      ].map(async (key) => {
        try {
          urls.set(key, await pluginAssetUrl(plugin, key));
        } catch {
          /* 使用现有的图片加载失败文案。 */
        }
      }),
    );
  }
  let processed = markdown;
  const resolvedSources = new Map<string, string>();
  for (const img of imageMatches.slice().reverse()) {
    const key = normalizeAssetPath(img.path);
    if (key === null) continue;

    const escapedMatch = img.match.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (plugin && urls.has(key)) {
      const url = urls.get(key)!;
      // DOMPurify 默认会删除 blob:；先用安全占位地址清洗，再只回填宿主生成的 URL。
      const placeholder = `https://kb-plugin-asset.invalid/${resolvedSources.size}`;
      resolvedSources.set(placeholder, url);
      processed = processed.replace(
        new RegExp(escapedMatch, "g"),
        `<img src="${placeholder}" alt="${escapeHtml(img.alt)}" style="max-width: 100%; height: auto;" />`,
      );
    } else {
      processed = processed.replace(
        new RegExp(escapedMatch, "g"),
        `[${escapeHtml(t("plugins.detail.imageLoadFailed", { path: img.path }))}]`,
      );
    }
  }

  // 3) 配置 marked 渲染器：链接新窗口打开；标题打序号锚点并同步收集目录项。
  //    序号即锚点下标——TOC 项与 DOM 锚点共用同一个 i，不存在对不上的可能。
  const headings: DocHeading[] = [];
  const renderer = new marked.Renderer();
  renderer.link = function (token) {
    const href = token.href;
    const title = token.title;
    const text = this.parser.parseInline(token.tokens || []);
    const titleAttr = title ? ` title="${title.replace(/"/g, "&quot;")}"` : "";
    return `<a href="${href}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
  };
  renderer.heading = function (token) {
    const text = this.parser.parseInline(token.tokens || []);
    const id = `${props.anchorPrefix}-h-${headings.length}`;
    headings.push({ id, text: String(token.text ?? "").trim(), level: token.depth });
    return `<h${token.depth} id="${id}">${text}</h${token.depth}>`;
  };

  // 使用 marked 做标准 Markdown 渲染，再进行 HTML 清洗
  const rawHtml = marked.parse(processed, {
    gfm: true,
    breaks: true,
    renderer,
  }) as string;
  let html = sanitizeHtml(rawHtml);
  for (const [placeholder, url] of resolvedSources) html = html.split(placeholder).join(escapeHtml(url));
  return { html, headings };
};

watchEffect((onCleanup) => {
  const text = md.value;
  const plugin = props.plugin;
  let current = true;
  onCleanup(() => {
    current = false;
  });
  if (!text) {
    html.value = "";
    emit("headings", []);
    return;
  }
  void renderMarkdown(text, plugin).then((result) => {
    if (!current) return;
    html.value = result.html;
    emit("headings", result.headings);
  });
});
</script>

<style scoped lang="scss">
.doc-root {
  width: 100%;
}

.doc {
  color: var(--kb-fg-regular);
  font-size: 13.5px;
  line-height: 1.75;
  word-break: break-word;
}

.doc :deep(pre) {
  background: var(--kb-fill-lighter);
  border: 1px solid var(--kb-line);
  border-radius: var(--kb-radius-md);
  padding: 10px 12px;
  overflow: auto;
  font-size: 12.5px;
}

.doc :deep(code) {
  background: var(--kb-fill-light);
  border-radius: var(--kb-radius-sm);
  padding: 1px 5px;
  font-size: 0.92em;
}

.doc :deep(pre code) {
  background: none;
  padding: 0;
  font-size: inherit;
}

.doc :deep(a) {
  color: var(--kb-fg);
  text-underline-offset: 2px;
}

.doc :deep(h1),
.doc :deep(h2),
.doc :deep(h3) {
  color: var(--kb-fg);
  font-weight: 600;
  letter-spacing: -0.01em;
  line-height: 1.4;
}

.doc :deep(h1) {
  font-size: 20px;
}

.doc :deep(h2) {
  font-size: 16.5px;
}

.doc :deep(h3) {
  font-size: 14.5px;
}

.doc :deep(hr) {
  border: 0;
  border-top: 1px solid var(--kb-line);
}

.doc :deep(table) {
  width: 100%;
  border-collapse: collapse;
  margin: 12px 0;
}

.doc :deep(th),
.doc :deep(td) {
  border: 1px solid var(--kb-line);
  padding: 7px 10px;
  text-align: left;
}

.doc :deep(th) {
  background: var(--kb-fill-lighter);
  color: var(--kb-fg);
  font-weight: 600;
}

.doc :deep(blockquote) {
  margin: 12px 0;
  padding: 8px 12px;
  border-left: 3px solid var(--kb-line-strong);
  background: var(--kb-fill-lighter);
  border-radius: 0 var(--kb-radius-md) var(--kb-radius-md) 0;
  color: var(--kb-fg-muted);
}

.doc :deep(ul),
.doc :deep(ol) {
  margin: 10px 0 10px 18px;
}

.doc :deep(li) {
  margin: 4px 0;
}

.doc :deep(img) {
  max-width: 100%;
  border-radius: var(--kb-radius-md);
  cursor: zoom-in;
}
</style>
