//! Gallery Provider 浏览 — ChildEntry + ImageInfo → GalleryBrowseEntry 转换。

use serde::Serialize;

use crate::providers::provider::{ChildEntry, ImageEntry, ProviderMeta};
use crate::storage::{ImageInfo, Storage};

/// 返回给前端的条目
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum GalleryBrowseEntry {
    Dir {
        name: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        meta: Option<ProviderMeta>,
    },
    Image {
        image: ImageInfo,
    },
}

/// 将 Provider list_children + list_images 结果转换为前端可序列化的 GalleryBrowseEntry。
/// `ImageEntry` 已是 `ImageInfo` 别名，由 storage 层单次 SQL 组装；此处零二次查询。
pub fn browse_from_provider(
    children: Vec<ChildEntry>,
    images: Vec<ImageEntry>,
) -> Result<Vec<GalleryBrowseEntry>, String> {
    let mut out = Vec::with_capacity(children.len() + images.len());
    for child in children {
        out.push(GalleryBrowseEntry::Dir { name: child.name, meta: child.meta });
    }
    for image in images {
        out.push(GalleryBrowseEntry::Image { image });
    }
    Ok(out)
}
