//! 按画册分组的共享 provider（shared 底层）。
//!
//! - `AlbumsProvider`：路由壳；apply_query：with_join(album_images) + prepend_order_by(crawled_at ASC)。
//! - `AlbumProvider`：shared 底层；apply_query：with_where(album_id = ?)（依赖父链已 JOIN album_images）；
//!   list_children：子画册 + 数字页段；list_images：override（最后一页）。

use std::sync::Arc;

use crate::providers::provider::{ChildEntry, ImageEntry, Provider, ProviderMeta};
use crate::providers::shared::page_size::PageSizeGroupProvider;
use crate::storage::gallery::ImageQuery;
use crate::storage::{Storage, HIDDEN_ALBUM_ID};

/// 画册列表节点（根）。apply_query：with_join(album_images) + prepend_order_by(crawled_at ASC)。
pub struct AlbumsProvider;

impl Provider for AlbumsProvider {
    fn apply_query(&self, current: ImageQuery) -> ImageQuery {
        current
            .with_join("INNER JOIN album_images ai ON images.id = ai.image_id", vec![])
            .prepend_order_by("images.crawled_at ASC")
    }

    fn list_children(&self, _composed: &ImageQuery) -> Result<Vec<ChildEntry>, String> {
        let albums = Storage::global().get_albums(None)?;
        Ok(albums
            .into_iter()
            .map(|a| {
                ChildEntry::with_meta(
                    a.id.clone(),
                    Arc::new(AlbumProvider { album_id: a.id.clone() }),
                    ProviderMeta::Album(a),
                )
            })
            .collect())
    }

    fn get_child(&self, name: &str, _composed: &ImageQuery) -> Option<Arc<dyn Provider>> {
        let id = name.trim();
        if id.is_empty() {
            return None;
        }
        if !Storage::global().album_exists(id).ok()? {
            return None;
        }
        Some(Arc::new(AlbumProvider { album_id: id.to_string() }))
    }
}

/// 单一画册节点。apply_query：with_where(album_id)（JOIN 已由父链 AlbumsProvider 贡献）。
/// list_children：子画册 + 数字页段。list_images：override（最后一页）。
pub struct AlbumProvider {
    pub album_id: String,
}

impl Provider for AlbumProvider {
    fn apply_query(&self, current: ImageQuery) -> ImageQuery {
        let mut q = current.with_where("ai.album_id = ?", vec![self.album_id.clone()]);
        if self.album_id == HIDDEN_ALBUM_ID {
            q.wheres.retain(|w| !w.sql.contains("/*HIDE*/"));
        }
        q
    }

    fn list_children(&self, composed: &ImageQuery) -> Result<Vec<ChildEntry>, String> {
        let sub_albums = Storage::global().get_albums(Some(&self.album_id))?;
        let mut children: Vec<ChildEntry> = sub_albums
            .into_iter()
            .map(|a| {
                ChildEntry::with_meta(
                    a.id.clone(),
                    Arc::new(AlbumProvider { album_id: a.id.clone() }),
                    ProviderMeta::Album(a),
                )
            })
            .collect();
        children.extend(PageSizeGroupProvider.list_children(composed)?);
        Ok(children)
    }

    fn get_child(&self, name: &str, composed: &ImageQuery) -> Option<Arc<dyn Provider>> {
        // 数字页段 + x{size}x 页面大小段委托 PageSizeGroupProvider
        if name.parse::<usize>().is_ok()
            || (name.starts_with('x') && name.ends_with('x'))
        {
            return PageSizeGroupProvider.get_child(name, composed);
        }
        // 子画册：验证存在且父是本画册
        let album = Storage::global().get_album_by_id(name).ok()??;
        if album.parent_id.as_deref() != Some(&self.album_id) {
            return None;
        }
        Some(Arc::new(AlbumProvider { album_id: name.to_string() }))
    }

    fn list_images(&self, composed: &ImageQuery) -> Result<Vec<ImageEntry>, String> {
        PageSizeGroupProvider.list_images(composed)
    }

    fn get_meta(&self) -> Option<ProviderMeta> {
        Storage::global().get_album_by_id(&self.album_id).ok()?.map(ProviderMeta::Album)
    }
}
