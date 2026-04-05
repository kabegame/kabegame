//! 全部图片 Provider：按分页显示所有图片，支持嵌套子目录
//!
//! 使用贪心分解策略：从最大范围开始，逐级用较小范围填充剩余部分。
//!
//! 例如 112400 张图片会显示为：
//! - 1-100000/      (10万级目录)
//! - 100001-110000/ (1万级目录)
//! - 110001-111000/ (1千级目录)
//! - 111001-112000/ (1千级目录)
//! - 400 个文件     (剩余直接显示)
//!
//! 支持通过 ImageQuery 参数自定义查询条件，可用于画册、插件、日期等过滤。

use std::sync::Arc;

use crate::providers::descriptor::ProviderDescriptor;
use crate::providers::provider::{ListEntry, Provider};
use crate::storage::gallery::ImageQuery;
use crate::storage::Storage;

/// 每个叶子目录最多包含的图片数量（安卓与桌面统一：每页 100 张）
pub(crate) const LEAF_SIZE: usize = 100;
/// 每个分组目录最多包含的子目录数量
const GROUP_SIZE: usize = 10;

/// 分页模式：决定 `CommonProvider` 的列目录、`resolve_child` 与 `ProviderDescriptor`。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PaginationMode {
    /// 贪心分解（虚拟盘 / 与 VD 一致的子目录区间）
    Greedy,
    /// Main 路径：`.../<page>`、`.../desc/<page>` 由 `SimplePageProvider` 承载
    SimplePage,
}

/// 全部图片 Provider - 支持自定义查询条件
#[derive(Clone)]
pub struct CommonProvider {
    query: ImageQuery,
    /// 分页语义：见 [`PaginationMode`]；构造时须明确，决定 `list` / `resolve_child` / `descriptor` 行为。
    mode: PaginationMode,
}

impl CommonProvider {
    pub fn new() -> Self {
        Self {
            query: ImageQuery::all_recent(),
            mode: PaginationMode::Greedy,
        }
    }

    /// 使用自定义查询条件创建 Provider（贪心模式，默认）
    pub fn with_query(query: ImageQuery) -> Self {
        Self {
            query,
            mode: PaginationMode::Greedy,
        }
    }

    /// 使用自定义查询条件和分页模式创建 Provider
    pub fn with_query_and_mode(query: ImageQuery, mode: PaginationMode) -> Self {
        Self { query, mode }
    }

    /// 当前分页模式（Main 的 `.../desc/<page>` 须为 [`PaginationMode::SimplePage`]）
    #[inline]
    pub fn pagination_mode(&self) -> PaginationMode {
        self.mode
    }
}

impl Default for CommonProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl Provider for CommonProvider {
    fn list_entries(&self) -> Result<Vec<ListEntry>, String> {
        match self.mode {
            PaginationMode::Greedy => {
                let total = Storage::global().get_images_count_by_query(&self.query)?;
                if total == 0 {
                    return Ok(Vec::new());
                }

                let mut out: Vec<ListEntry> = Vec::new();
                if self.query.is_ascending() {
                    out.push(ListEntry::Child {
                        name: "倒序".to_string(),
                        provider: Arc::new(CommonProvider::with_query(self.query.to_desc())),
                    });
                }

                if total <= LEAF_SIZE {
                    let images = Storage::global().get_image_entries_by_query(&self.query, 0, total)?;
                    out.extend(images.into_iter().map(ListEntry::Image));
                    return Ok(out);
                }

                let ranges = greedy_decompose(total);
                for (offset, count) in &ranges {
                    out.push(ListEntry::Child {
                        name: range_name(*offset + 1, *offset + *count),
                        provider: Arc::new(RangeProvider::new(
                            self.query.clone(),
                            *offset,
                            *count,
                            calc_depth_for_size(*count),
                        )) as Arc<dyn Provider>,
                    });
                }

                let covered: usize = ranges.iter().map(|(_, c)| c).sum();
                let remainder = total.saturating_sub(covered);
                if remainder > 0 {
                    let images = Storage::global().get_image_entries_by_query(
                        &self.query,
                        covered,
                        remainder,
                    )?;
                    out.extend(images.into_iter().map(ListEntry::Image));
                }
                Ok(out)
            }
            PaginationMode::SimplePage => {
                if self.query.is_ascending() {
                    Ok(vec![ListEntry::Child {
                        name: "desc".to_string(),
                        provider: Arc::new(CommonProvider::with_query_and_mode(
                            self.query.to_desc(),
                            PaginationMode::SimplePage,
                        )),
                    }])
                } else {
                    Ok(Vec::new())
                }
            }
        }
    }

    fn descriptor(&self) -> ProviderDescriptor {
        match self.mode {
            PaginationMode::Greedy => ProviderDescriptor::All {
                query: self.query.clone(),
            },
            PaginationMode::SimplePage => ProviderDescriptor::SimpleAll {
                query: self.query.clone(),
            },
        }
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
        match self.mode {
            PaginationMode::Greedy => {
                // 升序下提供「倒序」子节点
                if name == "倒序" && self.query.is_ascending() {
                    return Some(Arc::new(CommonProvider::with_query(self.query.to_desc())));
                }

                let total = Storage::global().get_images_count_by_query(&self.query).ok()?;
                if total == 0 || total <= LEAF_SIZE {
                    return None;
                }

                // 解析范围名称
                let (offset, count) = parse_range(name)?;

                // 验证范围是否在贪心分解的结果中
                if !validate_greedy_range(offset, count, total) {
                    return None;
                }

                // 计算该范围的深度
                let depth = calc_depth_for_size(count);

                Some(Arc::new(RangeProvider::new(
                    self.query.clone(),
                    offset,
                    count,
                    depth,
                )))
            }
            PaginationMode::SimplePage => {
                // SimplePage 模式：支持 "desc" 与动态页码
                if name == "desc" && self.query.is_ascending() {
                    return Some(Arc::new(CommonProvider::with_query_and_mode(
                        self.query.to_desc(),
                        PaginationMode::SimplePage,
                    )));
                }
                if let Ok(page) = name.parse::<usize>() {
                    if page > 0 {
                        return Some(
                            Arc::new(SimplePageProvider::new(self.query.clone(), page))
                                as Arc<dyn Provider>,
                        );
                    }
                }
                None
            }
        }
    }

}

/// 范围 Provider - 表示一个范围内的图片或子范围
pub struct RangeProvider {
    /// 查询条件
    query: ImageQuery,
    /// 起始偏移（0-based）
    offset: usize,
    /// 范围内的图片数量
    count: usize,
    /// 当前深度（0 = 叶子层，直接显示图片）
    depth: usize,
}

impl RangeProvider {
    pub fn new(query: ImageQuery, offset: usize, count: usize, depth: usize) -> Self {
        Self {
            query,
            offset,
            count,
            depth,
        }
    }
}

impl Provider for RangeProvider {
    fn list_entries(&self) -> Result<Vec<ListEntry>, String> {
        if self.depth == 0 {
            let images =
                Storage::global().get_image_entries_by_query(&self.query, self.offset, self.count)?;
            return Ok(images.into_iter().map(ListEntry::Image).collect());
        }

        let mut out = Vec::new();
        let ranges = greedy_decompose(self.count);
        for (local_offset, local_count) in &ranges {
            out.push(ListEntry::Child {
                name: range_name(*local_offset + 1, *local_offset + *local_count),
                provider: Arc::new(RangeProvider::new(
                    self.query.clone(),
                    self.offset + *local_offset,
                    *local_count,
                    calc_depth_for_size(*local_count),
                )),
            });
        }

        let covered: usize = ranges.iter().map(|(_, c)| c).sum();
        let remainder = self.count.saturating_sub(covered);
        if remainder > 0 {
            let images = Storage::global().get_image_entries_by_query(
                &self.query,
                self.offset + covered,
                remainder,
            )?;
            out.extend(images.into_iter().map(ListEntry::Image));
        }
        Ok(out)
    }

    fn descriptor(&self) -> ProviderDescriptor {
        ProviderDescriptor::Range {
            query: self.query.clone(),
            offset: self.offset,
            count: self.count,
            depth: self.depth,
        }
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
        if self.depth == 0 {
            // 叶子层没有子目录
            return None;
        }

        // 解析范围名称（相对于当前范围）
        let (local_offset, local_count) = parse_range(name)?;

        // 验证范围是否在贪心分解的结果中
        if !validate_greedy_range(local_offset, local_count, self.count) {
            return None;
        }

        // 计算绝对偏移
        let absolute_offset = self.offset + local_offset;

        // 计算该范围的深度
        let child_depth = calc_depth_for_size(local_count);

        Some(Arc::new(RangeProvider::new(
            self.query.clone(),
            absolute_offset,
            local_count,
            child_depth,
        )))
    }

}

// === 辅助函数（与旧实现保持一致）===

/// 计算给定大小对应的深度（用于 RangeProvider）
/// 例如：1000 -> 0, 10000 -> 1, 100000 -> 2
pub(crate) fn calc_depth_for_size(size: usize) -> usize {
    if size <= LEAF_SIZE {
        return 0;
    }
    let mut depth = 0;
    let mut range_size = LEAF_SIZE;
    while range_size < size {
        depth += 1;
        range_size *= GROUP_SIZE;
    }
    depth
}

/// 获取所有可能的范围大小（从大到小）
/// 例如：[100000, 10000, 1000]
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

/// 生成范围名称
fn range_name(start_1based: usize, end_1based: usize) -> String {
    format!("{}-{}", start_1based, end_1based)
}

/// 解析范围名称，返回 (offset, count)
pub(crate) fn parse_range(range: &str) -> Option<(usize, usize)> {
    let parts: Vec<&str> = range.split('-').collect();
    if parts.len() != 2 {
        return None;
    }

    let start_1based: usize = parts[0].parse().ok()?;
    let end_1based: usize = parts[1].parse().ok()?;

    if start_1based == 0 || end_1based == 0 || start_1based > end_1based {
        return None;
    }

    let offset = start_1based - 1;
    let count = end_1based - start_1based + 1;

    Some((offset, count))
}

/// 贪心分解：生成目录范围列表
/// 返回 Vec<(offset, count)>，不包含最后的剩余文件
fn greedy_decompose(total: usize) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    let sizes = get_range_sizes(total);
    let mut pos = 0;

    for size in sizes {
        // 重要：跳过与 total 完全相等的范围，避免生成“目录里还是同名目录”的无限嵌套
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

/// 验证范围是否在贪心分解的结果中
pub(crate) fn validate_greedy_range(offset: usize, count: usize, total: usize) -> bool {
    let ranges = greedy_decompose(total);
    ranges.contains(&(offset, count))
}

/// SimplePageProvider - 简单页码模式的叶子 provider
/// 直接返回 offset=(page-1)*100, count=100 的图片
pub struct SimplePageProvider {
    query: ImageQuery,
    page: usize,
}

impl SimplePageProvider {
    pub fn new(query: ImageQuery, page: usize) -> Self {
        Self { query, page }
    }
}

impl Provider for SimplePageProvider {
    fn list_entries(&self) -> Result<Vec<ListEntry>, String> {
        let offset = (self.page - 1) * LEAF_SIZE;
        let images = Storage::global().get_image_entries_by_query(&self.query, offset, LEAF_SIZE)?;
        Ok(images.into_iter().map(ListEntry::Image).collect())
    }

    fn descriptor(&self) -> ProviderDescriptor {
        ProviderDescriptor::SimplePage {
            query: self.query.clone(),
            page: self.page,
        }
    }

}
