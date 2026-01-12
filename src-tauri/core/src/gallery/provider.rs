//! Gallery 用 RootProvider：仅包含画廊 UI 需要的 provider 根节点。
//!
//! 约定的 provider root（与前端路由 query.p 对齐）：
//! - `all`
//! - `by-plugin`
//! - `by-date`

use std::sync::Arc;

use crate::providers::{AllProvider, DateGroupProvider, PluginGroupProvider};
use crate::providers::provider::{FsEntry, Provider};
use crate::storage::Storage;

pub const DIR_ALL: &str = "all";
pub const DIR_BY_PLUGIN: &str = "by-plugin";
pub const DIR_BY_DATE: &str = "by-date";

#[derive(Clone, Default)]
pub struct GalleryRootProvider;

impl Provider for GalleryRootProvider {
    fn descriptor(&self) -> crate::providers::descriptor::ProviderDescriptor {
        crate::providers::descriptor::ProviderDescriptor::GalleryRoot
    }

    fn list(&self, _storage: &Storage) -> Result<Vec<FsEntry>, String> {
        Ok(vec![
            FsEntry::dir(DIR_ALL),
            FsEntry::dir(DIR_BY_PLUGIN),
            FsEntry::dir(DIR_BY_DATE),
        ])
    }

    fn get_child(&self, _storage: &Storage, name: &str) -> Option<Arc<dyn Provider>> {
        match name {
            n if n.eq_ignore_ascii_case(DIR_ALL) => Some(Arc::new(AllProvider::new())),
            n if n.eq_ignore_ascii_case(DIR_BY_PLUGIN) => Some(Arc::new(PluginGroupProvider::new())),
            n if n.eq_ignore_ascii_case(DIR_BY_DATE) => Some(Arc::new(DateGroupProvider::new())),
            _ => None,
        }
    }
}

