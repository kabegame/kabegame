//! Gallery 画册路由壳（album/ → 画册列表 → 单画册 + 各种排序/过滤 shell + 子画册 + 分页）。
//! 类型归属：路由壳。
//! apply_query：with_join(album_images) + prepend crawled_at ASC（Albums）/ with_where(album_id)（Album）
//!             / prepend ai.id ASC（AlbumOrder）/ with_where media_type（MediaFilter）
//!             / wallpaper_set_filter + prepend last_set_wallpaper_at ASC（Wallpaper）。
//! list_images：override（委托 QueryPageProvider 取最后一页）。
//!
//! 画册下的前端路径（由 [apps/main/src/utils/albumPath.ts](../../../../apps/main/src/utils/albumPath.ts) 生成）：
//! - `album/{id}/{page}` —— 全部 / time-asc（默认）
//! - `album/{id}/desc/{page}` —— 全部 / time-desc
//! - `album/{id}/album-order/{page}` —— 全部 / join-asc（按入画册顺序 ai.id ASC）
//! - `album/{id}/album-order/desc/{page}` —— 全部 / join-desc
//! - `album/{id}/wallpaper-order/{page}` —— 仅设过壁纸 / set-asc
//! - `album/{id}/wallpaper-order/desc/{page}` —— 仅设过壁纸 / set-desc
//! - `album/{id}/image-only/...` / `video-only/...` —— 按媒体类型过滤；同样支持 desc / album-order / wallpaper-order。

use std::sync::Arc;

use crate::providers::provider::{ChildEntry, ImageEntry, Provider, ProviderMeta};
use crate::providers::shared::{
    album::AlbumsProvider, query_page::QueryPageProvider, sort::SortProvider,
};
use crate::storage::gallery::ImageQuery;
use crate::storage::Storage;

// ── 画册列表根 ────────────────────────────────────────────────────────────────

/// `gallery/album/`：列所有根画册。apply_query：委托 AlbumsProvider（JOIN + crawled_at ASC）。
pub struct GalleryAlbumsProvider;

impl Provider for GalleryAlbumsProvider {
    fn apply_query(&self, current: ImageQuery) -> ImageQuery {
        AlbumsProvider.apply_query(current)
    }

    fn list_children(&self, _composed: &ImageQuery) -> Result<Vec<ChildEntry>, String> {
        let albums = Storage::global().get_albums(None)?;
        Ok(albums
            .into_iter()
            .map(|a| {
                ChildEntry::with_meta(
                    a.id.clone(),
                    Arc::new(GalleryAlbumEntryProvider { album_id: a.id.clone() }),
                    ProviderMeta::Album(a),
                )
            })
            .collect())
    }

    fn list_children_with_meta(
        &self,
        composed: &ImageQuery,
    ) -> Result<Vec<ChildEntry>, String> {
        self.list_children(composed)
    }

    fn get_child(&self, name: &str, _composed: &ImageQuery) -> Option<Arc<dyn Provider>> {
        let id = name.trim();
        if id.is_empty() {
            return None;
        }
        if !Storage::global().album_exists(id).ok()? {
            return None;
        }
        Some(Arc::new(GalleryAlbumEntryProvider { album_id: id.to_string() }))
    }
}

// ── 单画册节点 ────────────────────────────────────────────────────────────────

/// `gallery/album/<id>/`：单画册节点。apply_query：with_where(album_id)（依赖父链 JOIN）。
/// list_children：desc/ + album-order/ + image-only/ + video-only/ + wallpaper-order/ + 子画册 + 数字页段。
/// list_images：override（最后一页）。
pub struct GalleryAlbumEntryProvider {
    pub album_id: String,
}

impl Provider for GalleryAlbumEntryProvider {
    fn apply_query(&self, current: ImageQuery) -> ImageQuery {
        current.with_where("ai.album_id = ?", vec![self.album_id.clone()])
    }

    fn list_children(&self, composed: &ImageQuery) -> Result<Vec<ChildEntry>, String> {
        let mut children: Vec<ChildEntry> = Vec::new();

        let sort_shell: Arc<dyn Provider> = Arc::new(SortProvider::new(Arc::new(
            GalleryAlbumEntryProvider { album_id: self.album_id.clone() },
        )));
        children.push(ChildEntry::new("desc", sort_shell));
        children.push(ChildEntry::new(
            "album-order",
            Arc::new(GalleryAlbumOrderShell),
        ));
        children.push(ChildEntry::new(
            "image-only",
            Arc::new(GalleryAlbumMediaFilterShell { kind: "image".to_string() }),
        ));
        children.push(ChildEntry::new(
            "video-only",
            Arc::new(GalleryAlbumMediaFilterShell { kind: "video".to_string() }),
        ));
        children.push(ChildEntry::new(
            "wallpaper-order",
            Arc::new(GalleryAlbumWallpaperShell),
        ));

        let sub_albums = Storage::global().get_albums(Some(&self.album_id))?;
        for a in sub_albums {
            children.push(ChildEntry::with_meta(
                a.id.clone(),
                Arc::new(GalleryAlbumEntryProvider { album_id: a.id.clone() }),
                ProviderMeta::Album(a),
            ));
        }

        children.extend(QueryPageProvider::root().list_children(composed)?);
        Ok(children)
    }

    fn get_child(&self, name: &str, composed: &ImageQuery) -> Option<Arc<dyn Provider>> {
        // 注意：保留字分支必须放在 Storage DB 查询之前。
        if name == "desc" {
            return Some(Arc::new(SortProvider::new(Arc::new(GalleryAlbumEntryProvider {
                album_id: self.album_id.clone(),
            }))));
        }
        if name == "album-order" {
            return Some(Arc::new(GalleryAlbumOrderShell));
        }
        if name == "image-only" {
            return Some(Arc::new(GalleryAlbumMediaFilterShell {
                kind: "image".to_string(),
            }));
        }
        if name == "video-only" {
            return Some(Arc::new(GalleryAlbumMediaFilterShell {
                kind: "video".to_string(),
            }));
        }
        if name == "wallpaper-order" {
            return Some(Arc::new(GalleryAlbumWallpaperShell));
        }
        if name.parse::<usize>().is_ok() {
            return QueryPageProvider::root().get_child(name, composed);
        }
        let album = Storage::global().get_album_by_id(name).ok()??;
        if album.parent_id.as_deref() != Some(&self.album_id) {
            return None;
        }
        Some(Arc::new(GalleryAlbumEntryProvider { album_id: name.to_string() }))
    }

    fn list_images(&self, composed: &ImageQuery) -> Result<Vec<ImageEntry>, String> {
        QueryPageProvider::root().list_images(composed)
    }

    fn get_meta(&self) -> Option<ProviderMeta> {
        Storage::global().get_album_by_id(&self.album_id).ok()?.map(ProviderMeta::Album)
    }
}

// ── album-order shell：按加入画册顺序（ai.id ASC）────────────────────────────

/// `album-order`：画册内部按"加入画册顺序"排序。
/// 类型归属：路由壳（无状态，album_id 已由父链的 WHERE 携带）。
/// apply_query：prepend `COALESCE(ai."order", ai.rowid) ASC`。
/// 说明：`album_images` 表结构为 `(album_id, image_id, "order")`，无 `id` 列，
/// 因此用 `"order"` 列（若为 NULL 回退到 SQLite 隐式 rowid）作为入画册顺序。
/// list_images：override（最后一页）。
pub struct GalleryAlbumOrderShell;

impl Provider for GalleryAlbumOrderShell {
    fn apply_query(&self, current: ImageQuery) -> ImageQuery {
        current.prepend_order_by("COALESCE(ai.\"order\", ai.rowid) ASC")
    }

    fn list_children(&self, composed: &ImageQuery) -> Result<Vec<ChildEntry>, String> {
        let mut children: Vec<ChildEntry> = vec![ChildEntry::new(
            "desc",
            Arc::new(SortProvider::new(Arc::new(GalleryAlbumOrderShell))),
        )];
        children.extend(QueryPageProvider::root().list_children(composed)?);
        Ok(children)
    }

    fn get_child(&self, name: &str, composed: &ImageQuery) -> Option<Arc<dyn Provider>> {
        if name == "desc" {
            return Some(Arc::new(SortProvider::new(Arc::new(GalleryAlbumOrderShell))));
        }
        QueryPageProvider::root().get_child(name, composed)
    }

    fn list_images(&self, composed: &ImageQuery) -> Result<Vec<ImageEntry>, String> {
        QueryPageProvider::root().list_images(composed)
    }
}

// ── image-only / video-only shell：按媒体类型过滤 ──────────────────────────

/// `image-only` / `video-only`：按媒体类型过滤画册内容。
/// 类型归属：路由壳。
/// apply_query：merge(media_type_filter)。
/// list_children：desc/ + album-order/ + wallpaper-order/ + 数字页段。
/// list_images：override（最后一页）。
pub struct GalleryAlbumMediaFilterShell {
    pub kind: String, // "image" | "video"
}

impl Provider for GalleryAlbumMediaFilterShell {
    fn apply_query(&self, current: ImageQuery) -> ImageQuery {
        current.merge(&ImageQuery::media_type_filter(&self.kind))
    }

    fn list_children(&self, composed: &ImageQuery) -> Result<Vec<ChildEntry>, String> {
        let kind = self.kind.clone();
        let desc_inner: Arc<dyn Provider> = Arc::new(SortProvider::new(Arc::new(
            GalleryAlbumMediaFilterShell { kind: kind.clone() },
        )));
        let mut children: Vec<ChildEntry> = vec![
            ChildEntry::new("desc", desc_inner),
            ChildEntry::new("album-order", Arc::new(GalleryAlbumOrderShell)),
            ChildEntry::new("wallpaper-order", Arc::new(GalleryAlbumWallpaperShell)),
        ];
        children.extend(QueryPageProvider::root().list_children(composed)?);
        Ok(children)
    }

    fn get_child(&self, name: &str, composed: &ImageQuery) -> Option<Arc<dyn Provider>> {
        if name == "desc" {
            return Some(Arc::new(SortProvider::new(Arc::new(
                GalleryAlbumMediaFilterShell { kind: self.kind.clone() },
            ))));
        }
        if name == "album-order" {
            return Some(Arc::new(GalleryAlbumOrderShell));
        }
        if name == "wallpaper-order" {
            return Some(Arc::new(GalleryAlbumWallpaperShell));
        }
        QueryPageProvider::root().get_child(name, composed)
    }

    fn list_images(&self, composed: &ImageQuery) -> Result<Vec<ImageEntry>, String> {
        QueryPageProvider::root().list_images(composed)
    }
}

// ── wallpaper-order shell：仅设过壁纸 + 按设置时间排序 ──────────────────────

/// `wallpaper-order`：画册内仅"设过壁纸"的图片，按 last_set_wallpaper_at ASC 排序。
/// 类型归属：路由壳（无状态）。
/// apply_query：merge(wallpaper_set_filter) + prepend last_set_wallpaper_at ASC。
/// list_images：override（最后一页）。
pub struct GalleryAlbumWallpaperShell;

impl Provider for GalleryAlbumWallpaperShell {
    fn apply_query(&self, current: ImageQuery) -> ImageQuery {
        current
            .merge(&ImageQuery::wallpaper_set_filter())
            .prepend_order_by("images.last_set_wallpaper_at ASC")
    }

    fn list_children(&self, composed: &ImageQuery) -> Result<Vec<ChildEntry>, String> {
        let mut children: Vec<ChildEntry> = vec![ChildEntry::new(
            "desc",
            Arc::new(SortProvider::new(Arc::new(GalleryAlbumWallpaperShell))),
        )];
        children.extend(QueryPageProvider::root().list_children(composed)?);
        Ok(children)
    }

    fn get_child(&self, name: &str, composed: &ImageQuery) -> Option<Arc<dyn Provider>> {
        if name == "desc" {
            return Some(Arc::new(SortProvider::new(Arc::new(GalleryAlbumWallpaperShell))));
        }
        QueryPageProvider::root().get_child(name, composed)
    }

    fn list_images(&self, composed: &ImageQuery) -> Result<Vec<ImageEntry>, String> {
        QueryPageProvider::root().list_images(composed)
    }
}
