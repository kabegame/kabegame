//! 画册 Provider：管理画册目录和其中的图片（主要用于虚拟盘）。

use std::sync::Arc;

use crate::providers::common::CommonProvider;
use crate::providers::descriptor::{ProviderDescriptor, ProviderGroupKind};
use crate::providers::provider::{ListEntry, Provider};
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

impl Provider for AlbumsProvider {
    fn descriptor(&self) -> ProviderDescriptor {
        ProviderDescriptor::Group {
            kind: ProviderGroupKind::Album,
            locale: None,
        }
    }

    fn list_entries(&self) -> Result<Vec<ListEntry>, String> {
        let albums = Storage::global().get_albums(None)?;
        Ok(albums
            .into_iter()
            .map(|a| ListEntry::Child {
                name: a.name.clone(),
                provider: Arc::new(AlbumProvider::new(a.id)),
            })
            .collect())
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
        let album_id = Storage::global()
            .find_child_album_by_name_ci(None, name)
            .ok()??;
        Some(Arc::new(AlbumProvider::new(album_id)))
    }

    fn can_add_child(&self) -> bool {
        true
    }

    fn add_child(&self, child_name: &str) -> Result<(), String> {
        Storage::global().add_album(child_name, None)?;
        Ok(())
    }

    fn can_rename_child(&self) -> bool {
        true
    }

    fn rename_child(&self, child_name: &str, new_name: &str) -> Result<(), String> {
        let Some(album_id) = Storage::global().find_child_album_by_name_ci(None, child_name)?
        else {
            return Err("画册不存在".to_string());
        };
        if album_id == FAVORITE_ALBUM_ID {
            return Err("不能重命名系统默认画册".to_string());
        }
        Storage::global().rename_album(&album_id, new_name)
    }

    fn can_delete_child(&self, child_name: &str) -> bool {
        match Storage::global().find_child_album_by_name_ci(None, child_name) {
            Ok(Some(id)) => id != FAVORITE_ALBUM_ID,
            _ => false,
        }
    }

    fn delete_child(&self, child_name: &str) -> Result<(), String> {
        let Some(album_id) = Storage::global().find_child_album_by_name_ci(None, child_name)?
        else {
            return Err("画册不存在".to_string());
        };
        if album_id == FAVORITE_ALBUM_ID {
            return Err("不能删除系统默认画册".to_string());
        }
        Storage::global().delete_album(&album_id)
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
    fn descriptor(&self) -> ProviderDescriptor {
        ProviderDescriptor::All {
            query: ImageQuery::by_album(self.album_id.clone()),
        }
    }

    fn list_entries(&self) -> Result<Vec<ListEntry>, String> {
        let mut entries = Vec::new();
        let children = Storage::global().get_albums(Some(&self.album_id))?;
        if !children.is_empty() {
            entries.push(ListEntry::Child {
                name: "子画册".to_string(),
                provider: Arc::new(VdAlbumTreeProvider::new(self.album_id.clone())),
            });
        }
        entries.extend(self.inner.list_entries()?);
        Ok(entries)
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
        if name == "子画册" {
            return Some(Arc::new(VdAlbumTreeProvider::new(self.album_id.clone())));
        }
        self.inner.get_child(name)
    }

    fn can_delete_child(&self, _child_name: &str) -> bool {
        true
    }

    fn delete_child(&self, child_name: &str) -> Result<(), String> {
        let removed = crate::providers::vd_ops::delete_child_file_by_album(&self.album_id, child_name)?;
        if removed {
            Ok(())
        } else {
            Err("图片不存在或不在该画册中".to_string())
        }
    }

}

/// 虚拟盘「子画册」目录：下列当前画册的直接子画册（按名称）。
pub struct VdAlbumTreeProvider {
    album_id: String,
}

impl VdAlbumTreeProvider {
    pub fn new(album_id: String) -> Self {
        Self { album_id }
    }
}

impl Provider for VdAlbumTreeProvider {
    fn descriptor(&self) -> ProviderDescriptor {
        ProviderDescriptor::VdAlbumTree {
            album_id: self.album_id.clone(),
        }
    }

    fn list_entries(&self) -> Result<Vec<ListEntry>, String> {
        let children = Storage::global().get_albums(Some(&self.album_id))?;
        Ok(children
            .into_iter()
            .map(|a| ListEntry::Child {
                name: a.name.clone(),
                provider: Arc::new(AlbumProvider::new(a.id)),
            })
            .collect())
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
        let child_id = Storage::global()
            .find_child_album_by_name_ci(Some(&self.album_id), name)
            .ok()??;
        Some(Arc::new(AlbumProvider::new(child_id)))
    }

    fn can_add_child(&self) -> bool {
        true
    }

    fn add_child(&self, child_name: &str) -> Result<(), String> {
        Storage::global()
            .add_album(child_name, Some(&self.album_id))?;
        Ok(())
    }

    fn can_delete_child(&self, child_name: &str) -> bool {
        match Storage::global().find_child_album_by_name_ci(Some(&self.album_id), child_name) {
            Ok(Some(id)) => id != FAVORITE_ALBUM_ID,
            _ => false,
        }
    }

    fn delete_child(&self, child_name: &str) -> Result<(), String> {
        let album_id = Storage::global()
            .find_child_album_by_name_ci(Some(&self.album_id), child_name)?
            .ok_or_else(|| "画册不存在".to_string())?;
        Storage::global().delete_album(&album_id)
    }

    fn can_rename_child(&self) -> bool {
        true
    }

    fn rename_child(&self, child_name: &str, new_name: &str) -> Result<(), String> {
        let album_id = Storage::global()
            .find_child_album_by_name_ci(Some(&self.album_id), child_name)?
            .ok_or_else(|| "画册不存在".to_string())?;
        if album_id == FAVORITE_ALBUM_ID {
            return Err("不能重命名系统默认画册".to_string());
        }
        Storage::global().rename_album(&album_id, new_name)
    }
}
