//! VdRootProvider：VD locale 根，列 7 个翻译后的 canonical 入口。
//! 类型归属：路由壳（VD locale 根）。
//! apply_query：with_id_order(true)（id ASC 基础排序，供整个 VD 子树兜底）。
//! list_images：默认实现（不 override）。

use std::sync::Arc;

use crate::providers::provider::{ChildEntry, Provider};
use crate::providers::shared::hide_gate::HideGateProvider;
use crate::providers::vd::{
    albums::VdAlbumsProvider,
    all::VdAllProvider,
    by_plugin::VdByPluginProvider,
    by_surf::VdBySurfProvider,
    by_task::VdByTaskProvider,
    by_time::VdByTimeProvider,
    by_type::VdByTypeProvider,
    locale::VdLocaleConfig,
    notes::vd_root_note,
};
use crate::storage::gallery::ImageQuery;

/// VD 根 provider（带 locale）。
pub struct VdRootProvider {
    pub cfg: VdLocaleConfig,
}

impl VdRootProvider {
    pub fn new(locale: &'static str) -> Self {
        Self { cfg: VdLocaleConfig { locale } }
    }
}

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

impl Provider for VdRootProvider {
    fn apply_query(&self, current: ImageQuery) -> ImageQuery {
        current.with_id_order(true)
    }

    fn list_children(&self, _composed: &ImageQuery) -> Result<Vec<ChildEntry>, String> {
        let cfg = self.cfg;
        let mut children: Vec<ChildEntry> = VD_TOP_CANONICALS
            .iter()
            .map(|(segment, i18n_key)| {
                let provider: Arc<dyn Provider> = match *segment {
                    "all"      => Arc::new(VdAllProvider { cfg }),
                    "byTask"   => Arc::new(VdByTaskProvider { cfg }),
                    "byPlugin" => Arc::new(VdByPluginProvider { cfg }),
                    "byTime"   => Arc::new(VdByTimeProvider { cfg }),
                    "bySurf"   => Arc::new(VdBySurfProvider { cfg }),
                    "byType"   => Arc::new(VdByTypeProvider { cfg }),
                    "albums"   => Arc::new(VdAlbumsProvider { cfg }),
                    _          => unreachable!(),
                };
                ChildEntry::new(cfg.display_name(i18n_key), provider)
            })
            .collect();
        children.push(ChildEntry::new(
            "hide",
            Arc::new(HideGateProvider::new(Arc::new(VdRootProvider { cfg }))),
        ));
        Ok(children)
    }

    fn get_child(&self, name: &str, _composed: &ImageQuery) -> Option<Arc<dyn Provider>> {
        if name == "hide" {
            let cfg = self.cfg;
            return Some(Arc::new(HideGateProvider::new(Arc::new(VdRootProvider { cfg }))));
        }

        let canonical = VD_TOP_CANONICALS
            .iter()
            .find(|(_, i18n_key)| self.cfg.display_name(i18n_key) == name)
            .map(|(segment, _)| *segment)
            .unwrap_or(name);

        let cfg = self.cfg;
        match canonical {
            "all"      => Some(Arc::new(VdAllProvider { cfg })),
            "byTask"   => Some(Arc::new(VdByTaskProvider { cfg })),
            "byPlugin" => Some(Arc::new(VdByPluginProvider { cfg })),
            "byTime"   => Some(Arc::new(VdByTimeProvider { cfg })),
            "bySurf"   => Some(Arc::new(VdBySurfProvider { cfg })),
            "byType"   => Some(Arc::new(VdByTypeProvider { cfg })),
            "albums"   => Some(Arc::new(VdAlbumsProvider { cfg })),
            _          => None,
        }
    }

    fn get_note(&self) -> Option<(String, String)> {
        Some(vd_root_note())
    }
}
