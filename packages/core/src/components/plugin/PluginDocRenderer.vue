<template>
  <div ref="docRootRef" class="doc-root">
    <div v-if="!markdown" class="empty">
      <el-empty :description="emptyDescription" :image-size="100" />
    </div>
    <div v-else class="doc" v-html="html"></div>

    <!-- Android：photoswipe-vue 底层组件，不循环 -->
    <PhotoSwipe
      v-if="IS_ANDROID"
      v-model:open="docPswpOpen"
      v-model:index="docPswpIndex"
      :data-source="docPswpDataSource"
      :loop="false"
      :zIndex="2000"
    />

    <!-- 桌面：Element Plus 图片查看器，不循环 -->
    <ElImageViewer
      v-if="!IS_ANDROID && docDesktopViewerVisible"
      :url-list="docDesktopUrlList"
      :initial-index="docDesktopInitialIndex"
      :infinite="false"
      teleported
      @close="docDesktopViewerVisible = false"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watchEffect } from "vue";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ElImageViewer } from "element-plus";
import DOMPurify from "dompurify";
import { marked } from "marked";
// @ts-expect-error - Vue SFC component import, types resolved via package.json exports
import PhotoSwipe from "photoswipe-vue/vue";
import "photoswipe-vue/photoswipe.css";
import { IS_ANDROID } from "../../env";
import { useModalBack } from "../../composables/useModalBack";

type LoadImageBytes = (imagePath: string) => Promise<Uint8Array | number[]>;

const props = withDefaults(
  defineProps<{
    markdown?: string | null;
    emptyDescription?: string;
    /** 按路径加载图片字节（用于 data URL 或无 HTTP/自定义 URL 时） */
    loadImageBytes?: LoadImageBytes;
    /** 插件文档图片 URL 前缀：桌面为 http 服务器路径，安卓为 kbg-plugin-doc.localhost。有值时图片用 src=baseUrl+encodeURIComponent(path)，不调 loadImageBytes */
    docImageBaseUrl?: string | null;
  }>(),
  {
    emptyDescription: "该源暂无文档",
  }
);

const html = ref("");
const docRootRef = ref<HTMLElement | null>(null);

/** Android PhotoSwipe */
const docPswpOpen = ref(false);
const docPswpIndex = ref(0);
const docPswpDataSource = ref<Array<{ src: string; width: number; height: number }>>([]);

/** 桌面 ElImageViewer */
const docDesktopViewerVisible = ref(false);
const docDesktopUrlList = ref<string[]>([]);
const docDesktopInitialIndex = ref(0);

useModalBack(docPswpOpen);

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
      if (IS_ANDROID) {
        docPswpDataSource.value = items;
        docPswpIndex.value = index;
        await nextTick();
        docPswpOpen.value = true;
      } else {
        docDesktopUrlList.value = urls;
        docDesktopInitialIndex.value = index;
        docDesktopViewerVisible.value = true;
      }
    })();
    return;
  }

  const a = (e.target as HTMLElement).closest("a");
  if (!a || !a.href) return;
  const href = a.getAttribute("href");
  if (!href || (!href.startsWith("http:") && !href.startsWith("https:"))) return;
  e.preventDefault();
  void openUrl(href);
};

onMounted(() => {
  docRootRef.value?.addEventListener("click", handleDocClick);
});
onBeforeUnmount(() => {
  docRootRef.value?.removeEventListener("click", handleDocClick);
});

const md = computed(() => (props.markdown || "").trim());

const bytesToBase64 = (bytes: Uint8Array): string => {
  const chunkSize = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, Array.from(chunk));
  }
  return btoa(binary);
};

const guessMime = (path: string): string => {
  const ext = path.split(".").pop()?.toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  if (ext === "bmp") return "image/bmp";
  return "image/png";
};

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const normalizeDocPath = (imgPath: string): string => {
  let p = imgPath.trim();

  // 安全检查（前端快速过滤，后端仍会做更严格验证）
  if (p.startsWith("/") || p.startsWith("\\")) throw new Error("不允许绝对路径");
  if (p.includes("../") || p.includes("..\\")) throw new Error("不允许路径遍历");

  if (p.startsWith("./")) p = p.slice(2);
  if (p.startsWith("doc_root/")) p = p.slice("doc_root/".length);

  // URL decode（容错）
  try {
    p = decodeURIComponent(p);
  } catch {
    p = p
      .replace(/%20/g, " ")
      .replace(/%28/g, "(")
      .replace(/%29/g, ")")
      .replace(/%2F/g, "/")
      .replace(/%2E/g, ".")
      .replace(/%5F/g, "_");
  }

  if (!p) throw new Error("图片路径为空");
  if (p.includes("../") || p.includes("..\\")) throw new Error("不允许路径遍历");
  return p;
};

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
  loadImageBytes?: LoadImageBytes,
  docImageBaseUrl?: string | null
): Promise<string> => {
  if (!markdown) return "";

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

  // 2) 替换图片：有 docImageBaseUrl 时用 URL（桌面 HTTP / 安卓自定义 host），否则用 loadImageBytes 转 data URL
  let processed = markdown;
  if (imageMatches.length > 0) {
    if (docImageBaseUrl) {
      for (const img of imageMatches.slice().reverse()) {
        try {
          const normalizedPath = normalizeDocPath(img.path);
          const url = docImageBaseUrl + encodeURIComponent(normalizedPath);
          const escapedMatch = img.match.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          processed = processed.replace(
            new RegExp(escapedMatch, "g"),
            `<img src="${url}" alt="${escapeHtml(
              img.alt
            )}" style="max-width: 100%; height: auto;" />`
          );
        } catch {
          const escapedMatch = img.match.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          processed = processed.replace(
            new RegExp(escapedMatch, "g"),
            `[图片加载失败: ${escapeHtml(img.path)}]`
          );
        }
      }
    } else if (loadImageBytes) {
      for (const img of imageMatches.slice().reverse()) {
        try {
          const normalizedPath = normalizeDocPath(img.path);
          const bytesAny = await loadImageBytes(normalizedPath);
          const bytes =
            bytesAny instanceof Uint8Array ? bytesAny : new Uint8Array(bytesAny);
          const base64 = bytesToBase64(bytes);
          const mime = guessMime(img.path);
          const url = `data:${mime};base64,${base64}`;
          const escapedMatch = img.match.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          processed = processed.replace(
            new RegExp(escapedMatch, "g"),
            `<img src="${url}" alt="${escapeHtml(
              img.alt
            )}" style="max-width: 100%; height: auto;" />`
          );
        } catch {
          const escapedMatch = img.match.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          processed = processed.replace(
            new RegExp(escapedMatch, "g"),
            `[图片加载失败: ${escapeHtml(img.path)}]`
          );
        }
      }
    }
  }

  // 3) 配置 marked 渲染器，让链接在新窗口打开
  const renderer = new marked.Renderer();
  renderer.link = function(token) {
    const href = token.href;
    const title = token.title;
    const text = this.parser.parseInline(token.tokens || []);
    const titleAttr = title ? ` title="${title.replace(/"/g, '&quot;')}"` : '';
    return `<a href="${href}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
  };

  // 使用 marked 做标准 Markdown 渲染，再进行 HTML 清洗
  const rawHtml = marked.parse(processed, {
    gfm: true,
    breaks: true,
    renderer,
  }) as string;
  return sanitizeHtml(rawHtml);
};

watchEffect(() => {
  void (async () => {
    const text = md.value;
    if (!text) {
      html.value = "";
      return;
    }
    html.value = await renderMarkdown(
      text,
      props.loadImageBytes,
      props.docImageBaseUrl
    );
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

