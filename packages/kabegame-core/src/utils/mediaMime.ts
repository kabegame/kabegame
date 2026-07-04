/** 与后端 `images.type` / API `type` 一致：具体 MIME；视频为 `video` 或 `video/*` */

export const DEFAULT_IMAGE_MIME = "image/jpeg";

/** 是否为视频类（`video` 或 `video/*`，大小写不敏感） */
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
