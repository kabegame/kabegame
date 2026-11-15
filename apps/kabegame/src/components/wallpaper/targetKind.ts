/**
 * 壁纸目标按类型的判定（纯函数，供单测）：
 * - `x-wpe/web` → 网页（`WpeWallpaperContent` 的 `file:` iframe）；
 * - `x-wpe/scene` → 场景（`WpeSceneView`，WebGPU）；
 * - 视频（含目录型 `x-wpe/video`）→ `<video>`；
 * - 其余 → 图片。
 * `Wallpaper` 用它给没有类型的旧目标定图片行的类型、给平铺定铺法，调试快照的 `media` 也取它。
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

/** 受 `wallpaperPaused` 影响的壁纸：视频（含 WPE 视频）、网页、场景。图片是静态的，没什么可暂停。 */
export function isPausableTarget(target: WallpaperTarget): boolean {
  return isWebTarget(target) || isSceneTarget(target) || isVideoTarget(target);
}

/** 目标是哪类媒体（调试快照 `media` 的取值）。 */
export function stageMediaOf(target: WallpaperTarget): "image" | "video" | "web" | "scene" {
  if (isWebTarget(target)) return "web";
  if (isSceneTarget(target)) return "scene";
  if (isVideoTarget(target)) return "video";
  return "image";
}
