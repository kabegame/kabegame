import type { ImageInfo } from "../types/image";
import { CONTENT_URI_PROXY_PREFIX, IS_ANDROID, LOCAL_FILE_PROXY_PREFIX } from "../env";
import { fileToUrl, thumbnailToUrl } from "../httpServer";
import { isVideoMediaType } from "../utils/mediaMime";

export type ImagePrefer = "original" | "thumbnail";

export interface ImageUrlPlan {
  thumbnailUrl: string;
  originalUrl: string;
}

function normalizeDesktopPath(path: string | undefined): string {
  return (path || "").trimStart().replace(/^\\\\\?\\/, "").trim();
}

function toDesktopUrl(path: string | undefined): string {
  const normalized = normalizeDesktopPath(path);
  if (!normalized) return "";
  return fileToUrl(normalized);
}

function toDesktopThumbnailUrl(path: string | undefined): string {
  const normalized = normalizeDesktopPath(path);
  if (!normalized) return "";
  return thumbnailToUrl(normalized);
}

function toAndroidProxyUrl(path: string | undefined): string {
  const raw = (path || "").trim();
  if (!raw.startsWith("content://")) return "";
  return raw.replace("content://", CONTENT_URI_PROXY_PREFIX);
}

function toAndroidLocalFileUrl(path: string | undefined): string {
  const raw = (path || "").trim();
  if (!raw || raw.startsWith("content://")) return "";
  return LOCAL_FILE_PROXY_PREFIX + raw;
}

export function buildImageUrlPlan(image: ImageInfo, prefer: ImagePrefer): ImageUrlPlan {
  if (IS_ANDROID) {
    const isVideo = isVideoMediaType(image.type);
    const thumbPath = image.thumbnailPath || image.localPath;
    const localFileUrl = toAndroidLocalFileUrl(thumbPath);
    const contentUrl = toAndroidProxyUrl(image.localPath);
    if (isVideo && localFileUrl) {
      return { thumbnailUrl: localFileUrl, originalUrl: contentUrl };
    }
    if (localFileUrl && prefer !== "original") {
      return { thumbnailUrl: localFileUrl, originalUrl: contentUrl };
    }
    return { thumbnailUrl: "", originalUrl: contentUrl };
  }

  const originalUrl = toDesktopUrl(image.localPath);
  const hasThumbnail = !!normalizeDesktopPath(image.thumbnailPath);
  const thumbnailUrl = hasThumbnail ? toDesktopThumbnailUrl(image.thumbnailPath) : originalUrl;
  return { thumbnailUrl, originalUrl };
}
