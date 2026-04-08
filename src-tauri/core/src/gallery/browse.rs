//! Gallery Provider 浏览（给 app-main 复用“按 provider-path 查询”的模型）。
//!
//! 设计目标：
//! - 前端只传一个 provider 路径（例如 `all`、`all/1-10000/1-1000`、`by-plugin/konachan/1-1000`）
//! - 后端返回“下一步列表”：子目录（range 目录）+ 当前层的图片（remainder / leaf）
//! - range 目录使用贪心分解策略，与 `providers/all.rs` 保持一致的语义

use serde::{Deserialize, Serialize};

use crate::providers::descriptor::ProviderDescriptor;
use crate::providers::provider::ListEntry;
use crate::providers::ProviderRuntime;
use crate::storage::{ImageInfo, Storage};

/// 子画册浏览卡片（`album/<id>/tree`）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumBrowseInfo {
    pub id: String,
    pub name: String,
    pub image_count: usize,
    pub preview_images: Vec<ImageInfo>,
}

/// 返回给前端的条目
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum GalleryBrowseEntry {
    Dir { name: String },
    Image { image: ImageInfo },
    Album { album: AlbumBrowseInfo },
}

/// 浏览结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GalleryBrowseResult {
    pub total: usize,
    /// 当前节点对应的“范围起点”（0-based，全局 offset）
    pub base_offset: usize,
    /// 当前节点对应的“范围大小”（该节点覆盖的图片数量）
    pub range_total: usize,
    pub entries: Vec<GalleryBrowseEntry>,
}

/// provider 路径入口
///
/// MainProvider 路径格式：
/// - `all[/desc]/<page>` - 全部图片（可选 desc 排序）
/// - `wallpaper-order[/desc]/<page>` - 按「最后一次设为壁纸」时间排序（曾设为壁纸的图片）
/// - `plugin/<pluginId>/<page>` - 按插件分组
/// - `date/<yyyy>/<page>` - 按公历年分组
/// - `date/<yyyy-mm>/<page>` - 按月份分组
/// - `date/<yyyy-mm-dd>/<page>` - 按自然日分组
/// - `date-range/<start~end>/<page>` - 按日期范围分组
/// - `album/<albumId>/<page>` - 画册（按抓取时间升序）；`album/<albumId>/desc/<page>` 降序；
///   `album/<albumId>/album-order/[desc/]<page>` 按画册内加入顺序（`order` 列）；
///   `album/<albumId>/wallpaper-order/[desc/]<page>` 仅曾设为壁纸，按设壁纸时间排序；
///   `album/<albumId>/image-only/...`、`album/<albumId>/video-only/...` 仅图片或仅视频（子路径与上同）
/// - `media-type/image[/desc]/<page>`、`media-type/video[/desc]/<page>` - 按媒体类型（画廊根）
/// - `task/<taskId>/<page>` - 按任务分组
/// - `surf/<host>[/desc]/<page>` - 按畅游记录分组（host 与 `surf_records.host` 一致；默认升序，支持 desc）
///
/// 保留旧 VD 路径兼容性（all/by-plugin/by-date/by-task/by-album）
///
/// `page_size`：SimplePage 叶子每页条数（前端与设置一致，通常为 100 / 500 / 1000）
pub fn browse_gallery_provider(
    storage: &Storage,
    provider_rt: &ProviderRuntime,
    path: &str,
    page_size: usize,
) -> Result<GalleryBrowseResult, String> {
    let page_size = match page_size {
        100 | 500 | 1000 => page_size,
        _ => 100,
    };
    let raw_segs: Vec<&str> = path
        .split('/')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();

    if raw_segs.is_empty() {
        return Err("path 不能为空".to_string());
    }

    // 解析到 provider
    let provider = provider_rt
        .resolve(&format!("gallery/{}", raw_segs.join("/")))?
        .ok_or_else(|| format!("路径不存在: {}", path.trim()))?;

    let desc = provider.descriptor();

    match desc {
        // SimplePage 直接返回图片（叶子节点）
        ProviderDescriptor::SimplePage { query, page } => {
            let total = storage.get_images_count_by_query(&query)?;
            if total == 0 {
                return Ok(GalleryBrowseResult {
                    total: 0,
                    base_offset: 0,
                    range_total: 0,
                    entries: vec![],
                });
            }
            let offset = (page - 1).saturating_mul(page_size);
            if offset >= total {
                return Ok(GalleryBrowseResult {
                    total,
                    base_offset: offset,
                    range_total: 0,
                    entries: vec![],
                });
            }
            let remaining = total - offset;
            let count = page_size.min(remaining);
            let imgs = storage.get_images_info_range_by_query(&query, offset, count)?;
            Ok(GalleryBrowseResult {
                total,
                base_offset: offset,
                range_total: imgs.len(),
                entries: imgs
                    .into_iter()
                    .map(|image| GalleryBrowseEntry::Image { image })
                    .collect(),
            })
        }
        // SimpleAll 直接按 page_size 返回第一页图片
        ProviderDescriptor::SimpleAll { query } => {
            let total = storage.get_images_count_by_query(&query)?;
            if total == 0 {
                return Ok(GalleryBrowseResult {
                    total: 0,
                    base_offset: 0,
                    range_total: 0,
                    entries: vec![],
                });
            }
            let count = page_size.min(total);
            let imgs = storage.get_images_info_range_by_query(&query, 0, count)?;
            Ok(GalleryBrowseResult {
                total,
                base_offset: 0,
                range_total: count,
                entries: imgs
                    .into_iter()
                    .map(|image| GalleryBrowseEntry::Image { image })
                    .collect(),
            })
        }
        ProviderDescriptor::AlbumTree { album_id } => {
            let children = storage.get_albums(Some(album_id.as_str()))?;
            let mut entries = Vec::new();
            for child in &children {
                let count = storage.get_album_image_count(&child.id)?;
                let preview = storage.get_album_preview(&child.id, 3)?;
                entries.push(GalleryBrowseEntry::Album {
                    album: AlbumBrowseInfo {
                        id: child.id.clone(),
                        name: child.name.clone(),
                        image_count: count,
                        preview_images: preview,
                    },
                });
            }
            let n = children.len();
            Ok(GalleryBrowseResult {
                total: n,
                base_offset: 0,
                range_total: n,
                entries,
            })
        }
        _ => {
            let (total, base_offset, range_total) = match &desc {
                ProviderDescriptor::All { query }
                | ProviderDescriptor::DateScoped { query, .. } => {
                    let t = storage.get_images_count_by_query(query)?;
                    (t, 0, t)
                }
                ProviderDescriptor::Range { query, offset, count, .. } => {
                    let t = storage.get_images_count_by_query(query)?;
                    (t, *offset, *count)
                }
                _ => (0, 0, 0),
            };
            let entries = provider.list_entries()?;
            let entries = list_entries_to_gallery_browse(storage, entries)?;
            Ok(GalleryBrowseResult {
                total,
                base_offset,
                range_total,
                entries,
            })
        }
    }
}

fn list_entries_to_gallery_browse(
    storage: &Storage,
    entries: Vec<ListEntry>,
) -> Result<Vec<GalleryBrowseEntry>, String> {
    let mut out = Vec::with_capacity(entries.len());
    for e in entries {
        match e {
            ListEntry::Child { name, .. } => {
                out.push(GalleryBrowseEntry::Dir { name });
            }
            ListEntry::Image(image_entry) => {
                let mut image = storage
                    .find_image_by_id(&image_entry.id)?
                    .ok_or_else(|| format!("图片不存在: {}", image_entry.id))?;
                image.metadata = None;
                out.push(GalleryBrowseEntry::Image { image });
            }
        }
    }
    Ok(out)
}

