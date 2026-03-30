//! Gallery Provider 浏览（给 app-main 复用“按 provider-path 查询”的模型）。
//!
//! 设计目标：
//! - 前端只传一个 provider 路径（例如 `all`、`all/1-10000/1-1000`、`by-plugin/konachan/1-1000`）
//! - 后端返回“下一步列表”：子目录（range 目录）+ 当前层的图片（remainder / leaf）
//! - range 目录使用贪心分解策略，与 `providers/all.rs` 保持一致的语义

use serde::{Deserialize, Serialize};

use crate::providers::descriptor::ProviderDescriptor;
use crate::providers::provider::FsEntry;
use crate::providers::{ProviderRuntime, main_root::MainRootProvider};
use crate::storage::gallery::ImageQuery;
use crate::storage::{ImageInfo, Storage};

/// 返回给前端的条目
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum GalleryBrowseEntry {
    Dir { name: String },
    Image { image: ImageInfo },
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
/// - `surf/<surfRecordId>[/desc]/<page>` - 按畅游记录分组（默认升序，支持 desc）
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

    let root = std::sync::Arc::new(MainRootProvider::new())
        as std::sync::Arc<dyn crate::providers::provider::Provider>;

    // 解析到 provider
    let provider = provider_rt
        .resolve_provider_for_root(root, &raw_segs)?
        .ok_or_else(|| format!("路径不存在: {}", path.trim()))?;

    let desc = provider.descriptor();

    match desc {
        // 新增：SimplePage 直接返回图片（叶子节点）
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
        // 新增：SimpleAll 返回 total + 目录列表（根节点）
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
            // 返回目录列表（desc 子目录 + 页码目录）
            let mut entries = Vec::new();
            if query.is_ascending() {
                entries.push(GalleryBrowseEntry::Dir { name: "desc".to_string() });
            }
            // 页码目录通过 resolve_child 动态提供，这里只返回 total
            Ok(GalleryBrowseResult {
                total,
                base_offset: 0,
                range_total: total,
                entries,
            })
        }

        // 保留旧兼容性：DiskProvider 体系
        ProviderDescriptor::All { query } => {
            let total = storage.get_images_count_by_query(&query)?;
            if total == 0 {
                return Ok(GalleryBrowseResult {
                    total: 0,
                    base_offset: 0,
                    range_total: 0,
                    entries: vec![],
                });
            }
            list_node(storage, &query, total, 0, total)
        }
        ProviderDescriptor::Album { album_id } => {
            // 画册视图：构建 by_album 查询
            let query = ImageQuery::by_album(album_id);
            let total = storage.get_images_count_by_query(&query)?;
            if total == 0 {
                return Ok(GalleryBrowseResult {
                    total: 0,
                    base_offset: 0,
                    range_total: 0,
                    entries: vec![],
                });
            }
            list_node(storage, &query, total, 0, total)
        }
        ProviderDescriptor::Range {
            query,
            offset,
            count,
            depth: _,
        } => {
            let total = storage.get_images_count_by_query(&query)?;
            if total == 0 {
                return Ok(GalleryBrowseResult {
                    total: 0,
                    base_offset: 0,
                    range_total: 0,
                    entries: vec![],
                });
            }
            list_node(storage, &query, total, offset, count)
        }
        ProviderDescriptor::DateScoped { query, .. } => {
            let total = storage.get_images_count_by_query(&query)?;
            if total == 0 {
                return Ok(GalleryBrowseResult {
                    total: 0,
                    base_offset: 0,
                    range_total: 0,
                    entries: vec![],
                });
            }
            let raw = provider.list()?;
            let entries = fs_entries_to_gallery_browse(storage, raw)?;
            Ok(GalleryBrowseResult {
                total,
                base_offset: 0,
                range_total: total,
                entries,
            })
        }
        _ => {
            // 非图片集合 provider：只返回目录列表
            let entries = provider.list()?;
            Ok(GalleryBrowseResult {
                total: 0,
                base_offset: 0,
                range_total: 0,
                entries: entries
                    .into_iter()
                    .filter_map(|e| match e {
                        crate::providers::provider::FsEntry::Directory { name } => {
                            Some(GalleryBrowseEntry::Dir { name })
                        }
                        _ => None,
                    })
                    .collect(),
            })
        }
    }
}

fn fs_entries_to_gallery_browse(
    storage: &Storage,
    entries: Vec<FsEntry>,
) -> Result<Vec<GalleryBrowseEntry>, String> {
    let mut out = Vec::with_capacity(entries.len());
    for e in entries {
        match e {
            FsEntry::Directory { name } => {
                out.push(GalleryBrowseEntry::Dir { name });
            }
            FsEntry::File { image_id, .. } => {
                let mut image = storage
                    .find_image_by_id(&image_id)?
                    .ok_or_else(|| format!("图片不存在: {}", image_id))?;
                image.metadata = None;
                out.push(GalleryBrowseEntry::Image { image });
            }
        }
    }
    Ok(out)
}

// === 与 AllProvider 同步的贪心分解逻辑 ===

/// 叶子目录最多包含的图片数量（安卓与桌面统一：每页 100 张）
const LEAF_SIZE: usize = 100;
/// 每个分组目录最多包含的子目录数量
const GROUP_SIZE: usize = 10;

fn get_range_sizes(total: usize) -> Vec<usize> {
    let mut sizes = Vec::new();
    let mut size = LEAF_SIZE;
    while size <= total {
        sizes.push(size);
        size *= GROUP_SIZE;
    }
    sizes.reverse();
    sizes
}

fn greedy_decompose(total: usize) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    let sizes = get_range_sizes(total);
    let mut pos = 0;

    for size in sizes {
        if size == total {
            continue;
        }
        while pos + size <= total {
            ranges.push((pos, size));
            pos += size;
        }
    }

    ranges
}

fn range_name(start_1based: usize, end_1based: usize) -> String {
    format!("{}-{}", start_1based, end_1based)
}

fn list_node(
    storage: &Storage,
    query: &ImageQuery,
    total: usize,
    base_offset: usize,
    range_total: usize,
) -> Result<GalleryBrowseResult, String> {
    if range_total <= LEAF_SIZE {
        let imgs = storage.get_images_info_range_by_query(query, base_offset, range_total)?;
        return Ok(GalleryBrowseResult {
            total,
            base_offset,
            range_total,
            entries: imgs
                .into_iter()
                .map(|image| GalleryBrowseEntry::Image { image })
                .collect(),
        });
    }

    let ranges = greedy_decompose(range_total);
    let covered: usize = ranges.iter().map(|(_, c)| c).sum();
    let remainder = range_total.saturating_sub(covered);

    let mut entries: Vec<GalleryBrowseEntry> = Vec::new();

    for (offset, count) in &ranges {
        entries.push(GalleryBrowseEntry::Dir {
            name: range_name(*offset + 1, *offset + *count),
        });
    }

    if remainder > 0 {
        let remainder_offset = base_offset + covered;
        let imgs = storage.get_images_info_range_by_query(query, remainder_offset, remainder)?;
        entries.extend(
            imgs.into_iter()
                .map(|image| GalleryBrowseEntry::Image { image }),
        );
    }

    Ok(GalleryBrowseResult {
        total,
        base_offset,
        range_total,
        entries,
    })
}
