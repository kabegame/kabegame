//! VD `albums/`：根画册列表 + 递归子画册（通过 subAlbums gate）。
//! 类型归属：路由壳（album name 翻译 + 委托 shared::AlbumProvider；i18n subAlbums 门把手）。
//! apply_query：delegate to shared::AlbumsProvider（with_join + prepend_order_by crawled_at ASC）。
//! list_images：override（委托 QueryPageProvider 取最后一页）。

use std::sync::Arc;

use kabegame_i18n::vd_display_name;

use crate::providers::provider::{ChildEntry, ImageEntry, Provider, ProviderMeta};
use crate::providers::shared::album::AlbumsProvider;
use crate::providers::shared::query_page::QueryPageProvider;
use crate::providers::vd::sub_album_gate::VdSubAlbumGateProvider;
use crate::storage::gallery::ImageQuery;
use crate::storage::{Storage, HIDDEN_ALBUM_ID};

// ── Albums root ──────────────────────────────────────────────────────────────

pub struct VdAlbumsProvider;

impl Provider for VdAlbumsProvider {
    fn apply_query(&self, current: ImageQuery) -> ImageQuery {
        AlbumsProvider.apply_query(current)
    }

    fn list_children(&self, _composed: &ImageQuery) -> Result<Vec<ChildEntry>, String> {
        let albums = Storage::global().get_albums(None)?;
        Ok(albums
            .into_iter()
            .map(|a| {
                let display = if a.id == HIDDEN_ALBUM_ID {
                    vd_display_name("hidden-album")
                } else {
                    a.name.clone()
                };
                ChildEntry::with_meta(
                    display,
                    Arc::new(VdAlbumEntryProvider { album_id: a.id.clone() }),
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
        if name == vd_display_name("hidden-album") {
            return Some(Arc::new(VdAlbumEntryProvider { album_id: HIDDEN_ALBUM_ID.to_string() }));
        }
        let album_id = Storage::global().find_child_album_by_name_ci(None, name).ok()??;
        Some(Arc::new(VdAlbumEntryProvider { album_id }))
    }
}

// ── Album entry ───────────────────────────────────────────────────────────────

/// 单个画册：列 `{i18n(subAlbums)}` 子目录（若有子画册）+ 分页数字段。
pub struct VdAlbumEntryProvider {
    pub album_id: String,
}

impl Provider for VdAlbumEntryProvider {
    fn apply_query(&self, current: ImageQuery) -> ImageQuery {
        let mut q = current.with_where("ai.album_id = ?", vec![self.album_id.clone()]);
        if self.album_id == HIDDEN_ALBUM_ID {
            q.wheres.retain(|w| !w.sql.contains("/*HIDE*/"));
        }
        q
    }

    fn list_children(&self, composed: &ImageQuery) -> Result<Vec<ChildEntry>, String> {
        let mut out = Vec::new();
        let has_sub = !Storage::global().get_albums(Some(&self.album_id))?.is_empty();
        if has_sub {
            out.push(ChildEntry::new(
                vd_display_name("subAlbums"),
                Arc::new(VdSubAlbumGateProvider {
                    parent_album_id: self.album_id.clone(),
                }),
            ));
        }
        out.extend(QueryPageProvider::root().list_children(composed)?);
        Ok(out)
    }

    fn get_child(&self, name: &str, composed: &ImageQuery) -> Option<Arc<dyn Provider>> {
        if name == vd_display_name("subAlbums") {
            return Some(Arc::new(VdSubAlbumGateProvider {
                parent_album_id: self.album_id.clone(),
            }));
        }
        QueryPageProvider::root().get_child(name, composed)
    }

    fn list_images(&self, composed: &ImageQuery) -> Result<Vec<ImageEntry>, String> {
        QueryPageProvider::root().list_images(composed)
    }

    fn get_meta(&self) -> Option<ProviderMeta> {
        Storage::global().get_album_by_id(&self.album_id).ok()?.map(ProviderMeta::Album)
    }
}
