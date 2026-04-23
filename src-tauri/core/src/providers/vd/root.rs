//! VdRootProvider：VD 根，列 7 个翻译后的 canonical 入口 + 隐藏入口（i18n）。
//! 类型归属：路由壳（VD 根）。
//! apply_query：with_id_order(true)（id ASC 基础排序，供整个 VD 子树兜底）。
//! list_images：默认实现（不 override）。

use std::sync::Arc;

use kabegame_i18n::vd_display_name;

use crate::providers::provider::{ChildEntry, Provider};
use crate::providers::vd::{
    albums::VdAlbumsProvider,
    all::VdAllProvider,
    by_plugin::VdByPluginProvider,
    by_surf::VdBySurfProvider,
    by_task::VdByTaskProvider,
    by_time::VdByTimeProvider,
    by_type::VdByTypeProvider,
    notes::vd_root_note,
};
use crate::storage::gallery::ImageQuery;

/// VD 根 provider（locale 通过 `kabegame_i18n::current_vd_locale()` 同步读取，无需注入）。
pub struct VdRootProvider;

/// VD 7 个顶层 canonical key（与路径和 i18n 对应）。
const VD_TOP_CANONICALS: &[(&str, &str)] = &[
    ("all",      "all"),
    ("byTask",   "task"),
    ("byPlugin", "plugin"),
    ("byTime",   "date"),
    ("bySurf",   "surf"),
    ("byType",   "mediaType"),
    ("albums",   "album"),
];

fn make_canonical_provider(segment: &str) -> Option<Arc<dyn Provider>> {
    Some(match segment {
        "all"      => Arc::new(VdAllProvider),
        "byTask"   => Arc::new(VdByTaskProvider),
        "byPlugin" => Arc::new(VdByPluginProvider),
        "byTime"   => Arc::new(VdByTimeProvider),
        "bySurf"   => Arc::new(VdBySurfProvider),
        "byType"   => Arc::new(VdByTypeProvider),
        "albums"   => Arc::new(VdAlbumsProvider),
        _          => return None,
    })
}

impl Provider for VdRootProvider {
    fn apply_query(&self, current: ImageQuery) -> ImageQuery {
        current.with_id_order(true)
    }

    fn list_children(&self, _composed: &ImageQuery) -> Result<Vec<ChildEntry>, String> {
        let children: Vec<ChildEntry> = VD_TOP_CANONICALS
            .iter()
            .map(|(segment, i18n_key)| {
                let provider = make_canonical_provider(segment).expect("canonical segment");
                ChildEntry::new(vd_display_name(i18n_key), provider)
            })
            .collect();
        Ok(children)
    }

    fn get_child(&self, name: &str, _composed: &ImageQuery) -> Option<Arc<dyn Provider>> {
        let segment = VD_TOP_CANONICALS
            .iter()
            .find(|(_, i18n_key)| vd_display_name(i18n_key) == name)
            .map(|(segment, _)| *segment)
            .unwrap_or(name);

        make_canonical_provider(segment)
    }

    fn get_note(&self) -> Option<(String, String)> {
        Some(vd_root_note())
    }
}
