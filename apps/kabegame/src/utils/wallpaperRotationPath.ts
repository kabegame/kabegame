import { withGalleryPrefix } from "@/utils/path";

/**
 * 壁纸轮播路径约定（与 Rust `kabegame_core::wallpaper_rotation` 对应）。
 *
 * 每个壁纸目标的轮播只认一个 PathQL 路径（目标配置的 `rotationPath`，不含分页尾）：后端按位置逐张取
 * `<路径>/_kb_x1x/<位置+1>`；原生壁纸模式下后端会在尾部追加 `_kb_fc/media-type/image`。
 */

/** 当前视图（route store 的 `computedPath`，不含分页尾）→ 轮播路径。 */
export function viewRotationPath(computedPath: string): string {
  const body = withGalleryPrefix(computedPath);
  return body.includes("://") ? body : `images://${body}`;
}

/** 画册默认视图的轮播路径：与画册详情空查询时的视图一致（排除隐藏、按画册顺序）。 */
export function albumRotationPath(albumId: string): string {
  return `images://gallery/hide/album/${albumId}/sort/by-album-order`;
}

/**
 * 路径直接以某个画册为根（`gallery/[hide/]album/<id>` 或 `album-tree/<id>`）时返回画册 id。
 * 与 Rust `wallpaper_rotation::album_id_of` 同规则。
 */
export function rotationAlbumIdFromPath(path: string | null | undefined): string | null {
  if (!path) return null;
  const m = /^(?:images:\/\/)?gallery\/(?:hide\/)?album(?:-tree)?\/([^/]+)/.exec(path.trim());
  return m ? m[1] : null;
}

/** 一组轮播路径（各壁纸目标各一条）里直接以画册为根的那些画册 id，去重。 */
export function rotationAlbumIdsFromPaths(paths: readonly (string | null | undefined)[]): string[] {
  const ids = new Set<string>();
  for (const path of paths) {
    const id = rotationAlbumIdFromPath(path);
    if (id) ids.add(id);
  }
  return [...ids];
}

/**
 * 一组活跃壁纸目标里，轮播路径满足 `matches` 的那些目标 id（保持入参顺序）。
 *
 * 多个目标时「轮播中」分两档：有目标命中就打标记；全部目标都命中时才不再提供「设为轮播」
 * （没有哪块屏还能再设）。只有一个目标时两档重合，与单目标时的行为相同。
 *
 * @example
 * ```ts
 * const hits = rotatingTargetIds(sources, (path) => rotationAlbumIdFromPath(path) === albumId);
 * const marked = hits.length > 0;
 * const canSetMore = hits.length < sources.length;
 * ```
 */
export function rotatingTargetIds(
  sources: readonly { targetId: string; path: string | null }[],
  matches: (path: string) => boolean,
): string[] {
  return sources.filter((source) => !!source.path && matches(source.path)).map((source) => source.targetId);
}

/** 壁纸模式能否显示视频：窗口 / plasma 插件可以，原生（含 Android）只能显示图片。 */
export function wallpaperModeSupportsVideo(mode: string | null | undefined): boolean {
  return mode === "window" || mode === "plasma-plugin";
}
