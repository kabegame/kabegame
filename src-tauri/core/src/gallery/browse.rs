//! Gallery Provider 浏览 — ChildEntry + ImageInfo → GalleryBrowseEntry 转换。

use serde::Serialize;
use serde_json::Value as JsonValue;

use crate::providers::provider::ChildEntry;
use crate::storage::ImageInfo;

/// 返回给前端的条目
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum GalleryBrowseEntry {
    Dir {
        name: String,
        /// 6b 起：未类型化 JSON（兼容旧 wire format `{"kind": "...", "data": {...}}`）。
        #[serde(skip_serializing_if = "Option::is_none")]
        meta: Option<JsonValue>,
        /// 6b 起：core 暂不计算 per-child total；保留字段供未来 IPC 层扩展。
        #[serde(skip_serializing_if = "Option::is_none")]
        total: Option<usize>,
    },
    Image {
        image: ImageInfo,
    },
}

/// 将 Provider list 输出 + Storage 取的 images 列表转换为前端可序列化的 GalleryBrowseEntry。
pub fn browse_from_provider_jsonmeta(
    children: Vec<ChildEntry>,
    images: Vec<ImageInfo>,
) -> Result<Vec<GalleryBrowseEntry>, String> {
    let mut out = Vec::with_capacity(children.len() + images.len());
    for child in children {
        out.push(GalleryBrowseEntry::Dir {
            name: child.name,
            meta: child.meta,
            total: None,
        });
    }
    for image in images {
        out.push(GalleryBrowseEntry::Image { image });
    }
    Ok(out)
}

/// 旧版 alias，保持向后兼容。
pub fn browse_from_provider(
    children: Vec<ChildEntry>,
    images: Vec<ImageInfo>,
) -> Result<Vec<GalleryBrowseEntry>, String> {
    browse_from_provider_jsonmeta(children, images)
}
