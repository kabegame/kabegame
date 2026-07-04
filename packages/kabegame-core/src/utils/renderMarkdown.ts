import { marked } from "marked";
import DOMPurify from "dompurify";

/**
 * 轻量 Markdown 渲染：标准 Markdown（非 GFM）→ DOMPurify 净化。
 *
 * 用于只读文案（如应用更新日志）。DOMPurify 会剥离 `<script>` / `onclick` 等，
 * 即"绝不跑脚本"；调用方应自行拦截渲染结果里的 `<a>` 点击（Tauri webview 内
 * `target=_blank` 不可靠，需走 opener）。
 */
export function renderBasicMarkdown(md: string): string {
  if (!md) return "";
  const raw = marked.parse(md, { gfm: false, breaks: true }) as string;
  return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
}
