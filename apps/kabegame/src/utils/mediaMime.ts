/** 与后端 `images.type` / API `type` 一致：格式键（如 `image/jpg`、`video/mp4`）；兼容历史 `video`。 */

export const DEFAULT_IMAGE_MIME = "image/jpeg";

/** 是否为视频类（格式键以 `video/` 开头，同时兼容历史 `video`；大小写不敏感） */
export function isVideoMediaType(t: string | undefined): boolean {
  if (t == null) return false;
  const s = String(t).trim().toLowerCase();
  return s === "video" || s.startsWith("video/");
}

/** 目录型 WPE 壁纸：`local_path` 是目录；视频播放走 `compatible_path`（入口视频本身或兼容副本）。 */
export function wpeKind(t: string | undefined): string | null {
  if (t == null) return null;
  const s = String(t).trim().toLowerCase();
  if (!s.startsWith("x-wpe/")) return null;
  const kind = s.slice("x-wpe/".length).trim();
  return kind || null;
}

export function isWpeMediaType(t: string | undefined): boolean {
  return wpeKind(t) != null;
}

/** 第一阶段只有 `x-wpe/video` 会入库；其余类型仅占位。 */
export function isWpeVideoType(t: string | undefined): boolean {
  return wpeKind(t) === "video";
}

/**
 * 播放形态判定：普通视频或目录型 WPE 视频壁纸。
 * 预览、背景与壁纸窗口用这个；只应展示静图的场景仍用 {@link isVideoMediaType}。
 */
export function isVideoPlaybackType(t: string | undefined): boolean {
  return isVideoMediaType(t) || isWpeVideoType(t);
}

/** 详情等展示用：无值时与后端默认一致 */
export function displayImageMimeType(t: string | undefined): string {
  const s = t == null ? "" : String(t).trim();
  return s || DEFAULT_IMAGE_MIME;
}

/**
 * 是否支持读取并展示图片文件内嵌的原生元数据。
 * 必须与 Rust `native_metadata::supports_native_metadata` 的格式集保持一致。
 */
export function isNativeMetadataEligible(t?: string): boolean {
  return ["image/jpg", "image/jpeg", "image/png", "image/webp", "image/gif"].includes((t ?? "").trim().toLowerCase());
}
