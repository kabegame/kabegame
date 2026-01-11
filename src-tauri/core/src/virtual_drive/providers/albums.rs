//! 画册 Provider：管理画册目录和其中的图片

use std::sync::Arc;

use super::super::provider::{FsEntry, VirtualFsProvider};
use super::all::AllProvider;
use crate::storage::gallery::ImageQuery;
use crate::storage::{Storage, FAVORITE_ALBUM_ID};

/// 画册列表 Provider - 列出所有画册
#[derive(Clone)]
pub struct AlbumsProvider;

impl AlbumsProvider {
    pub fn new() -> Self {
        Self
    }
}

impl Default for AlbumsProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl VirtualFsProvider for AlbumsProvider {
    fn list(&self, storage: &Storage) -> Result<Vec<FsEntry>, String> {
        let albums = storage.get_albums()?;
        Ok(albums.into_iter().map(|a| FsEntry::dir(a.name)).collect())
    }

    fn get_child(&self, storage: &Storage, name: &str) -> Option<Arc<dyn VirtualFsProvider>> {
        // 根据名称查找画册 ID
        let album_id = storage.find_album_id_by_name_ci(name).ok()??;
        Some(Arc::new(AlbumProvider::new(album_id)))
    }
}

/// 单个画册 Provider - 委托给 AllProvider 处理分页
pub struct AlbumProvider {
    album_id: String,
    inner: AllProvider,
}

impl AlbumProvider {
    pub fn new(album_id: String) -> Self {
        let inner = AllProvider::with_query(ImageQuery::by_album(album_id.clone()));
        Self { album_id, inner }
    }
}

impl VirtualFsProvider for AlbumProvider {
    fn list(&self, storage: &Storage) -> Result<Vec<FsEntry>, String> {
        self.inner.list(storage)
    }

    fn get_child(&self, storage: &Storage, name: &str) -> Option<Arc<dyn VirtualFsProvider>> {
        self.inner.get_child(storage, name)
    }

    fn can_delete(&self) -> bool {
        // 可以删除画册（除了收藏）
        self.album_id != FAVORITE_ALBUM_ID
    }

    fn delete(&self, storage: &Storage) -> Result<(), String> {
        if self.album_id == FAVORITE_ALBUM_ID {
            return Err("不能删除系统默认画册".to_string());
        }
        storage.delete_album(&self.album_id)
    }

    fn can_rename(&self) -> bool {
        // 可以重命名画册（除了收藏）
        self.album_id != FAVORITE_ALBUM_ID
    }

    fn rename(&self, storage: &Storage, new_name: &str) -> Result<(), String> {
        if self.album_id == FAVORITE_ALBUM_ID {
            return Err("不能重命名系统默认画册".to_string());
        }
        storage.rename_album(&self.album_id, new_name)
    }
}
