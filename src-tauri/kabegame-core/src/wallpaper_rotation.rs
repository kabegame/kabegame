//! 壁纸轮播的 PathQL 路径约定（纯字符串，不访问 Storage / provider runtime）。
//!
//! 轮播只认一个设置路径 `wallpaperRotationPath`（不含分页尾）与位置 `wallpaperRotationPosition`
//! （下一张的 0 起序号）。rotator 每次切换：
//! 1. 按壁纸模式算出有效路径 [`effective_path`]（原生模式只留图片）；
//! 2. `count(有效路径)`，出错落回 [`default_path`]；
//! 3. 取 [`rows_path`]`(有效路径, 位置 + 1)` 这一张。
//!
//! 详见 `cocs/wallpaper/ROTATION_PATHQL.md`。

/// 原生壁纸后端只能显示图片时追加在有效路径尾部的过滤。
/// 全局 `_kb_fc` 在任何段都先于当前 provider 解析，AND 进已有条件且保留前面的排序。
const IMAGE_ONLY_TAIL: &str = "_kb_fc/media-type/image";

/// 壁纸模式能否显示视频：窗口 / plasma 插件可以，原生（含 Android）只能显示图片。
pub fn mode_supports_video(wallpaper_mode: &str) -> bool {
    wallpaper_mode == "window" || wallpaper_mode == "plasma-plugin"
}

/// 新的随机排序种子：满足 `gallery_sort_router` 的 `random-([0-9]{1,18})`。
/// 与前端 `newRandomSortSeed` 同一值域。
pub fn new_random_seed() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    // splitmix64：Windows 上 nanos 精度为 100ns，直接取模会集中在少数值上
    let mut x = nanos as u64;
    x ^= x >> 30;
    x = x.wrapping_mul(0xbf58476d1ce4e5b9);
    x ^= x >> 27;
    x = x.wrapping_mul(0x94d049bb133111eb);
    x ^= x >> 31;
    // JS Number.MAX_SAFE_INTEGER = 2^53 - 1
    (x % ((1u64 << 53) - 1)).to_string()
}

/// 默认轮播路径：全画廊（排除隐藏）随机排列，每次调用换一个新种子。
pub fn default_path() -> String {
    format!("images://gallery/hide/sort/random-{}", new_random_seed())
}

/// 规范化设置值：去首尾空白与尾部 `/`，空串视为未设置。
pub fn normalize_path(path: &str) -> Option<String> {
    let t = path.trim().trim_end_matches('/');
    if t.is_empty() {
        None
    } else if t.contains("://") {
        Some(t.to_string())
    } else {
        Some(format!("images://{}", t.trim_start_matches('/')))
    }
}

/// 按壁纸模式得到实际 count / 取行用的路径；设置里保存的仍是原始路径。
pub fn effective_path(path: &str, wallpaper_mode: &str) -> String {
    let base = path.trim_end_matches('/');
    if mode_supports_video(wallpaper_mode) {
        base.to_string()
    } else {
        format!("{base}/{IMAGE_ONLY_TAIL}")
    }
}

/// 页大小 `page_size`、第 `page`（1 起）页的取行路径；切换壁纸用页大小 1，第 `位置 + 1` 页即那一张。
///
/// 画廊路径与前端 `toLookupRowsPath`（`apps/kabegame/src/utils/galleryPath.ts`）同构：
/// filter 层只带 id 过滤、排序与切页，rank 打序号，lookup 回表补字段，避免深页慢。
pub fn rows_path(effective: &str, page_size: u64, page: u64) -> String {
    let paged = format!(
        "{}/_kb_x{}x/{}",
        effective.trim_end_matches('/'),
        page_size.max(1),
        page.max(1)
    );
    match paged.strip_prefix("images://gallery/") {
        Some(rest) => format!("images://filter/{rest}/~~/rank/~~p/lookup/gallery"),
        None => paged,
    }
}

/// 某张图在有效路径里的 1 起序号查询路径，与前端 `locateImageRowIndex` 同一形态。
/// 直接交给 provider runtime（不经 IPC 的段解码），图片 id 为数字，原样拼接。
pub fn rank_path(effective: &str, image_id: &str) -> String {
    format!(
        "{}/~~/rank/~~/id_{}",
        effective.trim_end_matches('/'),
        image_id.trim()
    )
}

/// 路径直接以某个画册为根（`gallery/[hide/]album/<id>` 或 `album-tree/<id>`）时返回该画册 id。
/// 用于「当前轮播画册」展示与删除画册时重置轮播；与前端 `rotationAlbumIdFromPath` 同规则。
pub fn album_id_of(path: &str) -> Option<&str> {
    let rest = path.strip_prefix("images://").unwrap_or(path);
    let rest = rest.strip_prefix("gallery/")?;
    let rest = rest.strip_prefix("hide/").unwrap_or(rest);
    let rest = rest
        .strip_prefix("album/")
        .or_else(|| rest.strip_prefix("album-tree/"))?;
    let id = rest.split('/').next()?;
    (!id.is_empty()).then_some(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn effective_path_appends_image_filter_only_for_native() {
        let p = "images://gallery/hide/sort/random-42";
        assert_eq!(effective_path(p, "window"), p);
        assert_eq!(effective_path(p, "plasma-plugin"), p);
        assert_eq!(
            effective_path(p, "native"),
            "images://gallery/hide/sort/random-42/_kb_fc/media-type/image"
        );
    }

    #[test]
    fn rows_path_uses_lookup_for_gallery_and_plain_paging_otherwise() {
        assert_eq!(
            rows_path("images://gallery/hide/all", 1, 3),
            "images://filter/hide/all/_kb_x1x/3/~~/rank/~~p/lookup/gallery"
        );
        assert_eq!(
            rows_path("images://x5x", 100, 0),
            "images://x5x/_kb_x100x/1"
        );
    }

    #[test]
    fn album_id_of_matches_album_roots_only() {
        let id = "11111111-1111-1111-1111-111111111111";
        assert_eq!(
            album_id_of(&format!("images://gallery/hide/album/{id}")),
            Some(id)
        );
        assert_eq!(
            album_id_of(&format!("images://gallery/album-tree/{id}/sort/by-id")),
            Some(id)
        );
        assert_eq!(album_id_of("images://gallery/hide/all"), None);
        assert_eq!(album_id_of("images://gallery/hide/plugin/pixiv"), None);
    }

    #[test]
    fn normalize_path_adds_scheme_and_drops_empty() {
        assert_eq!(normalize_path("  "), None);
        assert_eq!(
            normalize_path("gallery/hide/all/"),
            Some("images://gallery/hide/all".to_string())
        );
    }

    #[test]
    fn default_path_seed_fits_sort_router() {
        let p = default_path();
        let seed = p.rsplit("random-").next().unwrap();
        assert!(!seed.is_empty() && seed.len() <= 18 && seed.chars().all(|c| c.is_ascii_digit()));
    }
}
