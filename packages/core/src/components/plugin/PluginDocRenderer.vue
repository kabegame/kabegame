<template>
  <div class="doc-root">
    <div v-if="!markdown" class="empty">
      <el-empty :description="emptyDescription" :image-size="100" />
    </div>
    <div v-else class="doc" v-html="html"></div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watchEffect } from "vue";

type LoadImageBytes = (imagePath: string) => Promise<Uint8Array | number[]>;

const props = withDefaults(
  defineProps<{
    markdown?: string | null;
    emptyDescription?: string;
    loadImageBytes?: LoadImageBytes;
  }>(),
  {
    emptyDescription: "该源暂无文档",
  }
);

const html = ref("");

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
  if (ext === "svg") return "image/svg+xml";
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

const renderMarkdown = async (
  markdown: string,
  loadImageBytes?: LoadImageBytes
): Promise<string> => {
  if (!markdown) return "";

  // 1) 解析图片引用：![alt](path)，支持路径中包含括号
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

    let pathEnd = markdown.indexOf(")", pathStart + 1);
    if (pathEnd === -1) break;

    let nextBrace = markdown.indexOf(")", pathEnd + 1);
    while (nextBrace !== -1 && nextBrace < markdown.length) {
      const nextChar = markdown[nextBrace + 1];
      if (
        nextChar === " " ||
        nextChar === "\n" ||
        nextChar === "!" ||
        nextChar === undefined
      ) {
        pathEnd = nextBrace;
        break;
      }
      nextBrace = markdown.indexOf(")", nextBrace + 1);
    }

    const altText = markdown.substring(altStart, altEnd);
    const imagePath = markdown.substring(pathStart + 1, pathEnd);
    const fullMatch = markdown.substring(imgStart, pathEnd + 1);

    imageMatches.push({ match: fullMatch, alt: altText, path: imagePath });
    searchIndex = pathEnd + 1;
  }

  // 2) 替换图片：按倒序替换，避免索引偏移
  let processed = markdown;
  if (imageMatches.length > 0 && loadImageBytes) {
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

  // 3) 简易 Markdown -> HTML（保持与 main 旧实现一致）
  let out = processed
    .replace(/^### (.*$)/gim, "<h3>$1</h3>")
    .replace(/^## (.*$)/gim, "<h2>$1</h2>")
    .replace(/^# (.*$)/gim, "<h1>$1</h1>")
    .replace(/\*\*(.*?)\*\*/gim, "<strong>$1</strong>")
    .replace(/\*(.*?)\*/gim, "<em>$1</em>")
    .replace(/```([\s\S]*?)```/gim, "<pre><code>$1</code></pre>")
    .replace(/`(.*?)`/gim, "<code>$1</code>")
    .replace(
      /\[([^\]]+)\]\(([^)]+)\)/gim,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
    )
    .replace(/^\s*[-*+]\s+(.*)$/gim, "<li>$1</li>")
    .replace(/^\s*\d+\.\s+(.*)$/gim, "<li>$1</li>")
    .replace(/\n\n/gim, "</p><p>")
    .replace(/\n/gim, "<br>");

  out = out.replace(/(<li>.*<\/li>)/gim, "<ul>$1</ul>");
  if (
    !out.startsWith("<h") &&
    !out.startsWith("<ul") &&
    !out.startsWith("<pre") &&
    !out.startsWith("<img")
  ) {
    out = "<p>" + out + "</p>";
  }
  return out;
};

watchEffect(() => {
  // 使用 async IIFE，避免 watchEffect 返回 Promise
  void (async () => {
    const text = md.value;
    if (!text) {
      html.value = "";
      return;
    }
    html.value = await renderMarkdown(text, props.loadImageBytes);
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
</style>

