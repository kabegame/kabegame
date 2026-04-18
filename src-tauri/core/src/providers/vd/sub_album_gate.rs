//! VdSubAlbumGateProvider：「子画册」固定入口 provider（i18n 翻译名）。
//! 类型归属：路由壳（gate，列直接子画册）。
//! apply_query：剥除父链中的 ai.album_id WHERE，以便子 VdAlbumEntryProvider 贡献正确的 album_id。
//! list_images：默认实现。

use std::sync::Arc;

use crate::providers::provider::{ChildEntry, Provider, ProviderMeta};
use crate::providers::vd::{albums::VdAlbumEntryProvider, locale::VdLocaleConfig};
use crate::storage::gallery::ImageQuery;
use crate::storage::Storage;

pub struct VdSubAlbumGateProvider {
    pub cfg: VdLocaleConfig,
    pub parent_album_id: String,
}

impl Provider for VdSubAlbumGateProvider {
    fn apply_query(&self, current: ImageQuery) -> ImageQuery {
        // Strip accumulated ai.album_id WHERE contributed by parent VdAlbumEntryProvider,
        // so the child VdAlbumEntryProvider can contribute its own filter cleanly.
        let mut q = current;
        q.wheres.retain(|w| !w.sql.contains("ai.album_id"));
        q
    }

    fn list_children(&self, _composed: &ImageQuery) -> Result<Vec<ChildEntry>, String> {
        let children = Storage::global().get_albums(Some(&self.parent_album_id))?;
        Ok(children
            .into_iter()
            .map(|a| {
                ChildEntry::with_meta(
                    a.name.clone(),
                    Arc::new(VdAlbumEntryProvider { cfg: self.cfg, album_id: a.id.clone() }),
                    ProviderMeta::Album(a),
                )
            })
            .collect())
    }

    fn get_child(&self, name: &str, _composed: &ImageQuery) -> Option<Arc<dyn Provider>> {
        let name = name.trim();
        if name.is_empty() {
            return None;
        }
        let child_id = Storage::global()
            .find_child_album_by_name_ci(Some(&self.parent_album_id), name)
            .ok()??;
        Some(Arc::new(VdAlbumEntryProvider { cfg: self.cfg, album_id: child_id }))
    }
}
