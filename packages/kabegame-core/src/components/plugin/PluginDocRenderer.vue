<template>
  <div ref="docRootRef" class="doc-root">
    <div v-if="!markdown" class="empty">
      <el-empty :description="effectiveEmptyDescription" :image-size="100" />
    </div>
    <div v-else class="doc" v-html="html"></div>

    <!-- Android：photoswipe-vue 底层组件，不循环 -->
    <PhotoSwipe
      v-if="uiStore.isCompact"
      :open="pswpModal.isOpen.value"
      v-model:index="docPswpIndex"
      :data-source="docPswpDataSource"
      :loop="false"
      :z-index="pswpModal.zIndex.value"
      @update:open="pswpModal.close"
      @close="handleDocPreviewClose"
    />

    <!-- 桌面：Element Plus 图片查看器，不循环 -->
    <ElImageViewer
      v-if="!uiStore.isCompact && desktopViewerModal.isOpen.value"
      :url-list="docDesktopUrlList"
      :initial-index="docDesktopInitialIndex"
      :infinite="false"
      teleported
      @close="handleDocPreviewClose"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watchEffect } from "vue";
import { ElImageViewer } from "element-plus";
import DOMPurify from "dompurify";
import { marked } from "marked";
// @ts-expect-error - Vue SFC component import, types resolved via package.json exports
import PhotoSwipe from "photoswipe-vue/vue";
import "photoswipe-vue/photoswipe.css";
import { useI18n } from "@kabegame/i18n";
import { useModal } from "../../composables/useModal";
import { useUiStore } from "@kabegame/core/stores/ui";
import { openExternalLink } from "../../utils/openExternalLink";
import { guessAssetMime, normalizeAssetPath } from "../../utils/assetPath";

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
     * 插件内嵌资源：归一化后的插件根相对路径 → base64。
     * 键的语义由 `normalizeAssetPath` 裁决，与后端 `assets::normalize_asset_path` 同构。
     */
    assets?: Record<string, string> | null;
    /** 标题锚点前缀；同页多个渲染器实例（如 说明/更新记录 tab 同时挂载）必须各自不同 */
    anchorPrefix?: string;
  }>(),
  {
    anchorPrefix: "kbdoc",
  }
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

/** 桌面 ElImageViewer */
const desktopViewerModal = useModal();
const docDesktopUrlList = ref<string[]>([]);
const docDesktopInitialIndex = ref(0);
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
        await nextTick();
        pswpModal.open();
      } else {
        docDesktopUrlList.value = urls;
        docDesktopInitialIndex.value = index;
        desktopViewerModal.open();
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
  if (!uiStore.isCompact) {
    desktopViewerModal.close();
  }
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
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

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
    }
  );
};

const renderMarkdown = async (
  markdown: string,
  assets?: Record<string, string> | null
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

  // 2) 替换本地图片引用：用 assets（内嵌 base64）。
  //    外链（http/https/data/协议相对）归一化返回 null，原样留给 marked 渲染。
  let processed = markdown;
  for (const img of imageMatches.slice().reverse()) {
    const key = normalizeAssetPath(img.path);
    if (key === null) continue;

    const base64 = assets?.[key];
    const escapedMatch = img.match.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (base64) {
      const url = `data:${guessAssetMime(key)};base64,${base64}`;
      processed = processed.replace(
        new RegExp(escapedMatch, "g"),
        `<img src="${url}" alt="${escapeHtml(
          img.alt
        )}" style="max-width: 100%; height: auto;" />`
      );
    } else {
      processed = processed.replace(
        new RegExp(escapedMatch, "g"),
        `[${escapeHtml(t("plugins.detail.imageLoadFailed", { path: img.path }))}]`
      );
    }
  }

  // 3) 配置 marked 渲染器：链接新窗口打开；标题打序号锚点并同步收集目录项。
  //    序号即锚点下标——TOC 项与 DOM 锚点共用同一个 i，不存在对不上的可能。
  const headings: DocHeading[] = [];
  const renderer = new marked.Renderer();
  renderer.link = function(token) {
    const href = token.href;
    const title = token.title;
    const text = this.parser.parseInline(token.tokens || []);
    const titleAttr = title ? ` title="${title.replace(/"/g, '&quot;')}"` : '';
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
  return { html: sanitizeHtml(rawHtml), headings };
};

watchEffect(() => {
  void (async () => {
    const text = md.value;
    if (!text) {
      html.value = "";
      emit("headings", []);
      return;
    }
    const result = await renderMarkdown(text, props.assets);
    html.value = result.html;
    emit("headings", result.headings);
  })();
});
</script>

<style scoped lang="scss">
.doc-root {
  width: 100%;
}

.empty {
  padding: 12px 0;
}

.doc {
  color: var(--anime-text-primary);
  line-height: 1.7;
  word-break: break-word;
}

.doc :deep(pre) {
  background: rgba(255, 255, 255, 0.6);
  border: 1px solid var(--anime-border);
  border-radius: 12px;
  padding: 10px 12px;
  overflow: auto;
}

.doc :deep(code) {
  background: rgba(255, 255, 255, 0.55);
  border: 1px solid var(--anime-border);
  border-radius: 8px;
  padding: 2px 6px;
}

.doc :deep(h1),
.doc :deep(h2),
.doc :deep(h3) {
  color: var(--anime-text-primary);
}

.doc :deep(table) {
  width: 100%;
  border-collapse: collapse;
  margin: 12px 0;
}

.doc :deep(th),
.doc :deep(td) {
  border: 1px solid var(--anime-border);
  padding: 8px 10px;
  text-align: left;
}

.doc :deep(blockquote) {
  margin: 12px 0;
  padding: 8px 12px;
  border-left: 4px solid var(--anime-border);
  background: rgba(255, 255, 255, 0.45);
  border-radius: 8px;
}

.doc :deep(ul),
.doc :deep(ol) {
  margin: 10px 0 10px 18px;
}

.doc :deep(li) {
  margin: 4px 0;
}

.doc :deep(img) {
  cursor: zoom-in;
}
</style>
