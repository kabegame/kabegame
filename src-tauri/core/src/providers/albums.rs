//! 画册 Provider：管理画册目录和其中的图片（主要用于虚拟盘）。

use std::sync::Arc;

use crate::providers::all::AllProvider;
use crate::providers::provider::{
    DeleteChildKind, DeleteChildMode, FsEntry, Provider, VdOpsContext,
};
use crate::storage::gallery::ImageQuery;
use crate::storage::{Storage, FAVORITE_ALBUM_ID};
use std::path::PathBuf;

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

impl Provider for AlbumsProvider {
    fn descriptor(&self) -> crate::providers::descriptor::ProviderDescriptor {
        crate::providers::descriptor::ProviderDescriptor::Albums
    }

    fn list(&self, storage: &Storage) -> Result<Vec<FsEntry>, String> {
        let albums = storage.get_albums()?;
        Ok(albums.into_iter().map(|a| FsEntry::dir(a.name)).collect())
    }

    fn get_child(&self, storage: &Storage, name: &str) -> Option<Arc<dyn Provider>> {
        // 根据名称查找画册 ID
        let album_id = storage.find_album_id_by_name_ci(name).ok()??;
        Some(Arc::new(AlbumProvider::new(album_id)))
    }

    #[cfg(feature = "virtual-drive")]
    fn can_create_child_dir(&self) -> bool {
        // `画册\` 下 mkdir = 创建画册（VD 专用语义）
        true
    }

    #[cfg(feature = "virtual-drive")]
    fn create_child_dir(
        &self,
        storage: &Storage,
        child_name: &str,
        ctx: &dyn VdOpsContext,
    ) -> Result<(), String> {
        crate::virtual_drive::ops::albums_create_child_dir(storage, child_name)?;
        ctx.albums_created(child_name);
        Ok(())
    }

    #[cfg(feature = "virtual-drive")]
    fn delete_child(
        &self,
        storage: &Storage,
        child_name: &str,
        kind: DeleteChildKind,
        mode: DeleteChildMode,
        ctx: &dyn VdOpsContext,
    ) -> Result<bool, String> {
        if kind != DeleteChildKind::Directory {
            return Err("不支持删除该类型".to_string());
        }
        let child_name = child_name.trim();
        if child_name.is_empty() {
            return Err("目录名不能为空".to_string());
        }
        let Some(album_id) = storage.find_album_id_by_name_ci(child_name)? else {
            // 不存在：视为未删除
            return Ok(false);
        };
        if album_id == FAVORITE_ALBUM_ID {
            return Err("不能删除系统默认画册".to_string());
        }
        if mode == DeleteChildMode::Check {
            return Ok(true);
        }
        storage.delete_album(&album_id)?;
        ctx.albums_deleted(child_name);
        Ok(true)
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

impl Provider for AlbumProvider {
    fn descriptor(&self) -> crate::providers::descriptor::ProviderDescriptor {
        crate::providers::descriptor::ProviderDescriptor::Album {
            album_id: self.album_id.clone(),
        }
    }

    fn list(&self, storage: &Storage) -> Result<Vec<FsEntry>, String> {
        self.inner.list(storage)
    }

    fn get_child(&self, storage: &Storage, name: &str) -> Option<Arc<dyn Provider>> {
        self.inner.get_child(storage, name)
    }

    fn resolve_file(&self, storage: &Storage, name: &str) -> Option<(String, PathBuf)> {
        // 关键：让虚拟盘能从“画册\<album>”目录中打开文件（包括收藏画册）。
        self.inner.resolve_file(storage, name)
    }

    fn can_rename(&self) -> bool {
        // 可以重命名画册（除了收藏）
        self.album_id != FAVORITE_ALBUM_ID
    }

    fn rename(&self, storage: &Storage, new_name: &str) -> Result<(), String> {
        storage.rename_album(&self.album_id, new_name)
    }

    #[cfg(feature = "virtual-drive")]
    fn delete_child(
        &self,
        storage: &Storage,
        child_name: &str,
        kind: DeleteChildKind,
        mode: DeleteChildMode,
        ctx: &dyn VdOpsContext,
    ) -> Result<bool, String> {
        if kind != DeleteChildKind::File {
            return Err("不支持删除该类型".to_string());
        }
        if mode == DeleteChildMode::Check {
            // 允许删除文件（语义：从画册移除图片）
            return Ok(true);
        }
        let removed = crate::virtual_drive::ops::album_delete_child_file(
            storage,
            &self.album_id,
            child_name,
        )?;
        if removed {
            if let Some(name) = storage.get_album_name_by_id(&self.album_id)? {
                ctx.album_images_removed(&name);
            }
        }
        Ok(removed)
    }
}
