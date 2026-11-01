/**
 * `WallpaperStage` 按目标类型分层的判定（纯函数，供单测）：
 * - `x-wpe/web` → web 层（`file:` iframe）；
 * - `x-wpe/scene` → scene 层（`WpeSceneView`，WebGPU）；
 * - 视频（含目录型 `x-wpe/video`）→ base / top 双层 `<video>`；
 * - 其余 → base / top 双层图片。
 */
import type { WallpaperTarget } from "./types";

function normalizedType(target: WallpaperTarget): string {
  return (target.type || "").trim().toLowerCase();
}

function getPathExt(path: string): string {
  return (path.split(".").pop() || "").toLowerCase();
}

function isVideoPath(path: string): boolean {
  return ["mp4", "mov", "wmv", "webm", "mkv"].includes(getPathExt(path));
}

/** 目录型 WPE 壁纸（`local_path` 是目录，不能当文件读）。 */
export function isWpeTarget(target: WallpaperTarget): boolean {
  return normalizedType(target).startsWith("x-wpe/");
}

/** WPE 网页壁纸：走独立 web 层（iframe），不进 base / top 双层。 */
export function isWebTarget(target: WallpaperTarget): boolean {
  return normalizedType(target) === "x-wpe/web";
}

/** WPE 场景壁纸：走独立 scene 层（`WpeSceneView` 的 canvas），不进 base / top 双层。 */
export function isSceneTarget(target: WallpaperTarget): boolean {
  return normalizedType(target) === "x-wpe/scene";
}

/** 是否按视频播放：优先看行类型，缺失时回退旧扩展名逻辑。 */
export function isVideoTarget(target: WallpaperTarget): boolean {
  const type = normalizedType(target);
  if (type === "x-wpe/video" || type === "video" || type.startsWith("video/")) return true;
  if (type) return false;
  return isVideoPath(target.path);
}

/** 目标落在哪一层（与 `WallpaperStage` 的 `currentMediaType` / 调试快照 `media` 同一套取值）。 */
export function stageMediaOf(target: WallpaperTarget): "image" | "video" | "web" | "scene" {
  if (isWebTarget(target)) return "web";
  if (isSceneTarget(target)) return "scene";
  if (isVideoTarget(target)) return "video";
  return "image";
}
