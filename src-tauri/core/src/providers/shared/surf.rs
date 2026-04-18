//! 按畅游记录分组的共享 provider（shared 底层）。
//!
//! - `SurfsProvider`：路由壳；apply_query：noop；list_images：默认实现。
//! - `SurfProvider`：shared 底层；apply_query：with_where(surf_record_id = ?)；list_images：override（最后一页）。

use std::sync::Arc;

use crate::providers::provider::{ChildEntry, ImageEntry, Provider, ProviderMeta};
use crate::providers::shared::query_page::QueryPageProvider;
use crate::storage::gallery::ImageQuery;
use crate::storage::Storage;

/// 畅游记录列表节点（根）。apply_query：noop。
pub struct SurfsProvider;

impl Provider for SurfsProvider {
    fn list_children(&self, _composed: &ImageQuery) -> Result<Vec<ChildEntry>, String> {
        let records = Storage::global().get_surf_records_with_images()?;
        let ids: Vec<String> = records.iter().map(|(id, _)| id.clone()).collect();
        let mut meta_map = Storage::global().get_surf_records_by_ids(&ids)?;
        Ok(records
            .into_iter()
            .map(|(id, host)| {
                let provider: Arc<dyn Provider> = Arc::new(SurfProvider { record_id: id.clone() });
                match meta_map.remove(&id) {
                    Some(r) => ChildEntry::with_meta(host, provider, ProviderMeta::SurfRecord(r)),
                    None => ChildEntry::new(host, provider),
                }
            })
            .collect())
    }

    fn get_child(&self, name: &str, _composed: &ImageQuery) -> Option<Arc<dyn Provider>> {
        let host = name.trim().to_lowercase();
        if host.is_empty() {
            return None;
        }
        let record = Storage::global().get_surf_record_by_host(&host).ok()??;
        Some(Arc::new(SurfProvider { record_id: record.id }))
    }
}

/// 单一畅游记录节点。apply_query：with_where(surf_record_id)。list_images：override（最后一页）。
pub struct SurfProvider {
    pub record_id: String,
}

impl Provider for SurfProvider {
    fn apply_query(&self, current: ImageQuery) -> ImageQuery {
        current.with_where("images.surf_record_id = ?", vec![self.record_id.clone()])
    }

    fn list_children(&self, composed: &ImageQuery) -> Result<Vec<ChildEntry>, String> {
        QueryPageProvider::root().list_children(composed)
    }

    fn get_child(&self, name: &str, composed: &ImageQuery) -> Option<Arc<dyn Provider>> {
        QueryPageProvider::root().get_child(name, composed)
    }

    fn list_images(&self, composed: &ImageQuery) -> Result<Vec<ImageEntry>, String> {
        QueryPageProvider::root().list_images(composed)
    }

    fn get_meta(&self) -> Option<ProviderMeta> {
        Storage::global().get_surf_record(&self.record_id).ok()?.map(ProviderMeta::SurfRecord)
    }
}
