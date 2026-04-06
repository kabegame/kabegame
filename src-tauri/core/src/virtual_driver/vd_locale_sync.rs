//! 与设置中的 UI 语言一致的 VD `vd/{locale}` 段，供语义层与 Explorer 刷新路径共用。

use kabegame_i18n::translate_vd_canonical;

use crate::storage::Storage;

/// 从 `rust_i18n` 全局 locale 读取当前 VD 路径段（zh/en/ja/ko/zhtw）。
/// 不依赖 tokio runtime，可在 FUSE/Dokan 回调线程安全调用。
pub fn vd_locale_segment_for_settings_sync() -> &'static str {
    kabegame_i18n::current_vd_locale()
}

/// 当前 VD locale 下某 canonical 分组的显示名（与 `ProviderConfig::display_name` 一致数据源）。
pub fn vd_display_name_for_settings_sync(canonical: &str) -> String {
    let loc = vd_locale_segment_for_settings_sync();
    translate_vd_canonical(loc, canonical)
}

/// 挂载点下画册目录的绝对路径，与虚拟盘 `MainAlbumsProvider` / `MainAlbumTreeProvider` 一致。
///
/// - 顶层画册：`{挂载点}/{vd.album}/{画册名}`
/// - 子画册：`…/{vd.album}/{祖先1}/…/{vd.subAlbums}/{父名}/{vd.subAlbums}/{自身名}`（与 VD 中「子画册」目录链一致）
pub fn album_folder_abs_path_for_explorer(mount_point: &str, album_id: &str) -> Result<String, String> {
    let storage = Storage::global();
    let Some(target) = storage
        .get_album_by_id(album_id)
        .map_err(|e| e.to_string())?
    else {
        return Err("画册不存在".to_string());
    };
    let ancestors = storage.get_album_ancestors(album_id)?;
    let album_root = vd_display_name_for_settings_sync("album");
    let tree_seg = vd_display_name_for_settings_sync("tree");

    let mut p = std::path::PathBuf::from(mount_point.trim());
    p.push(&album_root);
    if ancestors.is_empty() {
        p.push(&target.name);
    } else {
        p.push(&ancestors[0].name);
        for anc in ancestors.iter().skip(1) {
            p.push(&tree_seg);
            p.push(&anc.name);
        }
        p.push(&tree_seg);
        p.push(&target.name);
    }
    Ok(p.to_string_lossy().into_owned())
}
