//! 画册 Provider：管理画册目录和其中的图片（主要用于虚拟盘）。

use std::sync::Arc;

use crate::providers::common::CommonProvider;
#[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
use crate::providers::provider::{DeleteChildKind, DeleteChildMode, VdOpsContext};
use crate::providers::provider::{FsEntry, Provider};
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

    fn list(&self) -> Result<Vec<FsEntry>, String> {
        let albums = Storage::global().get_albums()?;
        Ok(albums.into_iter().map(|a| FsEntry::dir(a.name)).collect())
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
        // 根据名称查找画册 ID
        let album_id = Storage::global().find_album_id_by_name_ci(name).ok()??;
        Some(Arc::new(AlbumProvider::new(album_id)))
    }

    #[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
    fn can_create_child_dir(&self) -> bool {
        // `画册\` 下 mkdir = 创建画册（VD 专用语义）
        true
    }

    #[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
    fn create_child_dir(
        &self,
        child_name: &str,
        ctx: &dyn VdOpsContext,
    ) -> Result<(), String> {
        crate::providers::vd_ops::albums_create_child_dir(child_name)?;
        ctx.albums_created(child_name);
        Ok(())
    }

    #[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
    fn delete_child(
        &self,
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
        let Some(album_id) = Storage::global().find_album_id_by_name_ci(child_name)? else {
            return Ok(false);
        };
        if album_id == FAVORITE_ALBUM_ID {
            return Err("不能删除系统默认画册".to_string());
        }
        if mode == DeleteChildMode::Check {
            return Ok(true);
        }
        Storage::global().delete_album(&album_id)?;
        ctx.albums_deleted(child_name);
        Ok(true)
    }
}

/// 单个画册 Provider - 委托给 AllProvider 处理分页
pub struct AlbumProvider {
    album_id: String,
    inner: CommonProvider,
}

impl AlbumProvider {
    pub fn new(album_id: String) -> Self {
        let inner = CommonProvider::with_query(ImageQuery::by_album(album_id.clone()));
        Self { album_id, inner }
    }
}

impl Provider for AlbumProvider {
    fn descriptor(&self) -> crate::providers::descriptor::ProviderDescriptor {
        crate::providers::descriptor::ProviderDescriptor::Album {
            album_id: self.album_id.clone(),
        }
    }

    fn list(&self) -> Result<Vec<FsEntry>, String> {
        self.inner.list()
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
        self.inner.get_child(name)
    }

    fn resolve_file(&self, name: &str) -> Option<(String, PathBuf)> {
        // 关键：让虚拟盘能从“画册\<album>”目录中打开文件（包括收藏画册）。
        self.inner.resolve_file(name)
    }

    fn can_rename(&self) -> bool {
        // 可以重命名画册（除了收藏）
        self.album_id != FAVORITE_ALBUM_ID
    }

    fn rename(&self, new_name: &str) -> Result<(), String> {
        Storage::global().rename_album(&self.album_id, new_name)
    }

    #[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
    fn delete_child(
        &self,
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
        let removed =
            crate::providers::vd_ops::album_delete_child_file(&self.album_id, child_name)?;
        if removed {
            if let Some(name) = Storage::global().get_album_name_by_id(&self.album_id)? {
                ctx.album_images_removed(&name);
            }
        }
        Ok(removed)
    }
}
