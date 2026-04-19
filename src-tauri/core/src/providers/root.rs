//! 统一根 provider（新 Provider 树）。
//!
//! 新树：`VdNewUnifiedRoot`（Provider）— vd/…（Phase 3）+ gallery/…（Phase 4）。
//! VD 子树的目录显示名按 `kabegame_i18n::current_vd_locale()` 同步翻译，无需 locale 路径段。

use std::sync::Arc;

use crate::providers::gallery::root::GalleryRootProvider;
use crate::providers::provider::{ChildEntry, Provider};
use crate::providers::vd::root::VdRootProvider;
use crate::storage::gallery::ImageQuery;

/// 新树根：含 VD 子树（Phase 3）和 Gallery 子树（Phase 4）。
pub struct VdNewUnifiedRoot;

impl Provider for VdNewUnifiedRoot {
    fn list_children(&self, _composed: &ImageQuery) -> Result<Vec<ChildEntry>, String> {
        Ok(vec![
            ChildEntry::new("vd", Arc::new(VdRootProvider)),
            ChildEntry::new("gallery", Arc::new(GalleryRootProvider)),
        ])
    }

    fn get_child(&self, name: &str, _composed: &ImageQuery) -> Option<Arc<dyn Provider>> {
        match name {
            "vd" => Some(Arc::new(VdRootProvider)),
            "gallery" => Some(Arc::new(GalleryRootProvider)),
            _ => None,
        }
    }
}
