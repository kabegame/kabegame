//! 统一根 provider（新 Provider 树）。
//!
//! 新树：`VdNewUnifiedRoot`（Provider）— vd/{locale}/…（Phase 3）+ gallery/…（Phase 4）。

use std::sync::Arc;

use crate::providers::gallery::root::GalleryRootProvider;
use crate::providers::provider::{ChildEntry, Provider};
use crate::providers::vd::root::VdRootProvider;
use crate::storage::gallery::ImageQuery;

const SUPPORTED_VD_LOCALES: &[&'static str] = &["zh", "en", "ja", "ko", "zhtw"];

/// 新树根：含 VD 子树（Phase 3）和 Gallery 子树（Phase 4）。
pub struct VdNewUnifiedRoot;

impl Provider for VdNewUnifiedRoot {
    fn list_children(&self, _composed: &ImageQuery) -> Result<Vec<ChildEntry>, String> {
        Ok(vec![
            ChildEntry::new("vd", Arc::new(VdNewLocaleRouter)),
            ChildEntry::new("gallery", Arc::new(GalleryRootProvider)),
        ])
    }

    fn get_child(&self, name: &str, _composed: &ImageQuery) -> Option<Arc<dyn Provider>> {
        match name {
            "vd" => Some(Arc::new(VdNewLocaleRouter)),
            "gallery" => Some(Arc::new(GalleryRootProvider)),
            _ => None,
        }
    }
}

/// `vd/`：按 locale 分段路由（zh / en / ja / ko / zhtw）。
struct VdNewLocaleRouter;

impl Provider for VdNewLocaleRouter {
    fn list_children(&self, _composed: &ImageQuery) -> Result<Vec<ChildEntry>, String> {
        Ok(SUPPORTED_VD_LOCALES
            .iter()
            .copied()
            .map(|loc| ChildEntry::new(loc, Arc::new(VdRootProvider::new(loc))))
            .collect())
    }

    fn get_child(&self, name: &str, _composed: &ImageQuery) -> Option<Arc<dyn Provider>> {
        let locale = SUPPORTED_VD_LOCALES.iter().copied().find(|&l| l == name)?;
        Some(Arc::new(VdRootProvider::new(locale)))
    }
}
