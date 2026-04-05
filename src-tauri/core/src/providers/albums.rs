//! 画册 Provider：管理画册目录和其中的图片（主要用于虚拟盘）。

use std::sync::Arc;

use crate::providers::common::CommonProvider;
use crate::providers::descriptor::ProviderGroupKind;
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
    fn descriptor(&self) -> crate::providers::descriptor::ProviderDescriptor {
        crate::providers::descriptor::ProviderDescriptor::Group {
            kind: ProviderGroupKind::Album,
        }
    }

    fn list_entries(&self) -> Result<Vec<ListEntry>, String> {
        let albums = Storage::global().get_albums()?;
        Ok(albums
            .into_iter()
            .map(|a| ListEntry::Child {
                name: a.name.clone(),
                provider: Arc::new(AlbumProvider::new(a.id)),
            })
            .collect())
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
        // 根据名称查找画册 ID
        let album_id = Storage::global().find_album_id_by_name_ci(name).ok()??;
        Some(Arc::new(AlbumProvider::new(album_id)))
    }

    fn can_add_child(&self) -> bool {
        true
    }

    fn add_child(&self, child_name: &str) -> Result<(), String> {
        Storage::global().add_album(child_name)?;
        Ok(())
    }

    fn can_rename_child(&self) -> bool {
        true
    }

    fn rename_child(&self, child_name: &str, new_name: &str) -> Result<(), String> {
        let Some(album_id) = Storage::global().find_album_id_by_name_ci(child_name)? else {
            return Err("画册不存在".to_string());
        };
        if album_id == FAVORITE_ALBUM_ID {
            return Err("不能重命名系统默认画册".to_string());
        }
        Storage::global().rename_album(&album_id, new_name)
    }

    fn can_delete_child_v2(&self, child_name: &str) -> bool {
        match Storage::global().find_album_id_by_name_ci(child_name) {
            Ok(Some(id)) => id != FAVORITE_ALBUM_ID,
            _ => false,
        }
    }

    fn delete_child_v2(&self, child_name: &str) -> Result<(), String> {
        let Some(album_id) = Storage::global().find_album_id_by_name_ci(child_name)? else {
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
    fn descriptor(&self) -> crate::providers::descriptor::ProviderDescriptor {
        crate::providers::descriptor::ProviderDescriptor::All {
            query: ImageQuery::by_album(self.album_id.clone()),
        }
    }

    fn list_entries(&self) -> Result<Vec<ListEntry>, String> {
        self.inner.list_entries()
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
        self.inner.get_child(name)
    }

    fn can_rename(&self) -> bool {
        // 可以重命名画册（除了收藏）
        self.album_id != FAVORITE_ALBUM_ID
    }

    fn rename(&self, new_name: &str) -> Result<(), String> {
        Storage::global().rename_album(&self.album_id, new_name)
    }

    fn can_delete_child_v2(&self, _child_name: &str) -> bool {
        true
    }

    fn delete_child_v2(&self, child_name: &str) -> Result<(), String> {
        let removed = crate::providers::vd_ops::delete_child_file_by_album(&self.album_id, child_name)?;
        if removed {
            Ok(())
        } else {
            Err("图片不存在或不在该画册中".to_string())
        }
    }

}
