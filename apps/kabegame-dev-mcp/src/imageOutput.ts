/**
 * 图片类工具（`screenshot`、`render_scene`、`host_render`、`android_screen`）的输出：落盘原图、缩小回到会话里的那份、
 * 报原尺寸与回传尺寸。缩小在 MCP 进程里做（`scripts/kabegame-dev/png.ts`），REST 拿的总是原图。
 *
 * - `save`：路径（相对路径按仓库根），或 `"temp"`：系统临时目录下的 `kabegame-dev/`，自动命名（工具名 + 时间）。
 *   落盘的总是原尺寸。
 * - `size`：`{ scale?, maxWidth?, maxHeight? }`，只管回传的那份，等比、不放大；不给时长边缩到 1568，原图不超过就原样回。
 */
import { Buffer } from "node:buffer";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_MAX_EDGE, PngError, pngSize, resizePng } from "../../../scripts/kabegame-dev/png.ts";
import type { ImageDims, ResizeSpec } from "../../../scripts/kabegame-dev/png.ts";

export { DEFAULT_MAX_EDGE };
export type { ResizeSpec };

/** `save` 取这个值时落到临时目录、自动命名。 */
export const TEMP_SAVE = "temp";

export const tempImageDir = (): string => path.join(os.tmpdir(), "kabegame-dev");

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** 本地时间 `YYYYMMDD-HHmmss-SSS`。 */
export function timeStamp(now: Date): string {
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${pad(now.getMilliseconds(), 3)}`
  );
}

/** `<目录>/<工具名>[-<附加>]-<时间>.png`；同名已存在时再加序号。 */
export function tempImagePath(tool: string, extra?: string, now = new Date(), dir = tempImageDir()): string {
  const safe = (part: string) => part.replace(/[^\w.-]+/g, "_");
  const base = [safe(tool), extra ? safe(extra) : null, timeStamp(now)].filter(Boolean).join("-");
  let file = path.join(dir, `${base}.png`);
  for (let i = 2; existsSync(file); i++) file = path.join(dir, `${base}-${i}.png`);
  return file;
}

/** `save` 解析成绝对路径：`"temp"` 落临时目录，其余按仓库根解析。 */
export function resolveSavePath(root: string, save: string, tool: string, extra?: string): string {
  return save === TEMP_SAVE ? tempImagePath(tool, extra) : path.resolve(root, save);
}

export type ImageToolContent = Array<
  { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
>;

export interface ImageOutputOptions {
  /** 仓库根：相对的 `save` 按它解析。 */
  root: string;
  /** 工具名（自动命名用）。 */
  tool: string;
  /** 第一行的说明，例如 `截图 main`。 */
  label: string;
  save?: string;
  /** 缺省 true。 */
  inline?: boolean;
  size?: ResizeSpec;
  /** 自动命名的附加段（例如图片 id）。 */
  extra?: string;
  /** 放在尺寸行前面的几行。 */
  lead?: string[];
  /** 放在最后的几行（例如元数据）。 */
  tail?: string[];
}

export interface ImageOutput {
  content: ImageToolContent;
  saved: string | null;
  original: ImageDims | null;
  /** 回到会话里的尺寸；没回传图片时为 null。 */
  returned: ImageDims | null;
}

const kb = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
const dims = (d: ImageDims | null) => (d ? `${d.width}×${d.height}` : "尺寸未知");

/**
 * 先落盘原图（给了 `save` 时），再按 `size` 缩小回传的那份。缩小失败（格式不支持）时抛错，错误里带已保存的路径；
 * 不会回一张错图。
 */
export function imageOutput(png: Uint8Array, options: ImageOutputOptions): ImageOutput {
  const inline = options.inline !== false;
  if (!inline && !options.save) throw new Error("inline 为 false 时要给 save");
  const original = pngSize(png);
  const lines = [...(options.lead ?? [])];
  lines.push(`${options.label}：原尺寸 ${dims(original)}，PNG ${kb(png.length)}`);
  let saved: string | null = null;
  if (options.save) {
    saved = resolveSavePath(options.root, options.save, options.tool, options.extra);
    mkdirSync(path.dirname(saved), { recursive: true });
    writeFileSync(saved, png);
  }
  const content: ImageToolContent = [];
  let returned: ImageDims | null = null;
  if (inline) {
    let out;
    try {
      out = resizePng(png, options.size);
    } catch (error) {
      const reason = error instanceof PngError ? error.message : error instanceof Error ? error.message : String(error);
      throw new Error(
        `缩小回传图片失败：${reason}。没有回图` +
          (saved ? `；原图已保存：${saved}` : "") +
          "。要原图就传 size: { scale: 1 }（不缩小、不解码）",
      );
    }
    returned = out.returned;
    lines.push(
      out.resized
        ? `回传：${dims(out.returned)}（已缩小，PNG ${kb(out.png.length)}）`
        : `回传：原尺寸（${dims(out.returned)}）`,
    );
    content.push({ type: "image", data: Buffer.from(out.png).toString("base64"), mimeType: "image/png" });
  } else {
    lines.push("回传：没有（inline: false）");
  }
  if (saved) lines.push(`原图已保存：${saved}`);
  lines.push(...(options.tail ?? []));
  content.unshift({ type: "text", text: lines.join("\n") });
  return { content, saved, original, returned };
}
