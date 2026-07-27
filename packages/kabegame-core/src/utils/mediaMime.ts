/** 与后端 `images.type` / API `type` 一致：格式键（如 `image/jpg`、`video/mp4`）；兼容历史 `video`。 */

export const DEFAULT_IMAGE_MIME = "image/jpeg";

/** 是否为视频类（格式键以 `video/` 开头，同时兼容历史 `video`；大小写不敏感） */
export function isVideoMediaType(t: string | undefined): boolean {
  if (t == null) return false;
  const s = String(t).trim().toLowerCase();
  return s === "video" || s.startsWith("video/");
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
  return [
    "image/jpg",
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
  ].includes((t ?? "").trim().toLowerCase());
}
