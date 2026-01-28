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

use std::path::PathBuf;
use std::sync::Arc;

use crate::providers::descriptor::ProviderDescriptor;
#[cfg(not(kabegame_mode = "light"))]
use crate::providers::provider::{DeleteChildKind, DeleteChildMode, VdOpsContext};
use crate::providers::provider::{FsEntry, Provider};
use crate::storage::gallery::ImageQuery;
use crate::storage::Storage;

/// 每个叶子目录最多包含的图片数量
const LEAF_SIZE: usize = 1000;
/// 每个分组目录最多包含的子目录数量
const GROUP_SIZE: usize = 10;

/// 全部图片 Provider - 支持自定义查询条件
#[derive(Clone)]
pub struct CommonProvider {
    query: ImageQuery,
}

impl CommonProvider {
    pub fn new() -> Self {
        Self {
            query: ImageQuery::all_recent(),
        }
    }

    /// 使用自定义查询条件创建 Provider
    pub fn with_query(query: ImageQuery) -> Self {
        Self { query }
    }
}

impl Default for CommonProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl Provider for CommonProvider {
    fn descriptor(&self) -> ProviderDescriptor {
        ProviderDescriptor::All {
            query: self.query.clone(),
        }
    }

    fn list(&self) -> Result<Vec<FsEntry>, String> {
        let total = Storage::global().get_images_count_by_query(&self.query)?;
        if total == 0 {
            return Ok(Vec::new());
        }

        if total <= LEAF_SIZE {
            // 直接显示图片
            let entries = Storage::global().get_images_fs_entries_by_query(&self.query, 0, total)?;
            return Ok(entries
                .into_iter()
                .map(|e| FsEntry::file(e.file_name, e.image_id, PathBuf::from(e.resolved_path)))
                .collect());
        }

        // 使用贪心分解策略列出子目录 + 剩余文件
        list_greedy_subdirs_with_remainder(&self.query, 0, total)
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
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

    fn resolve_file(&self, name: &str) -> Option<(String, PathBuf)> {
        // 文件名格式通常为 "<id>.<ext>"，这里取最后一个 '.' 之前的部分作为 image_id
        let image_id = name.rsplit_once('.').map(|(s, _)| s).unwrap_or(name);
        if image_id.trim().is_empty() {
            return None;
        }
        let resolved = Storage::global().resolve_gallery_image_path(image_id).ok()??;
        Some((image_id.to_string(), PathBuf::from(resolved)))
    }

    #[cfg(not(kabegame_mode = "light"))]
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
        if !crate::providers::vd_ops::query_can_delete_child_file(&self.query) {
            return Err("当前目录不支持删除文件".to_string());
        }
        if mode == DeleteChildMode::Check {
            return Ok(true);
        }
        let removed =
            crate::providers::vd_ops::query_delete_child_file(&self.query, child_name)?;
        if removed {
            if let Some(album_id) = crate::providers::vd_ops::album_id_from_query(&self.query) {
                if let Some(name) = Storage::global().get_album_name_by_id(album_id)? {
                    ctx.album_images_removed(&name);
                }
            }
        }
        Ok(removed)
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
    fn descriptor(&self) -> ProviderDescriptor {
        ProviderDescriptor::Range {
            query: self.query.clone(),
            offset: self.offset,
            count: self.count,
            depth: self.depth,
        }
    }

    fn list(&self) -> Result<Vec<FsEntry>, String> {
        if self.depth == 0 {
            // 叶子层：显示图片
            let entries =
                Storage::global().get_images_fs_entries_by_query(&self.query, self.offset, self.count)?;
            return Ok(entries
                .into_iter()
                .map(|e| FsEntry::file(e.file_name, e.image_id, PathBuf::from(e.resolved_path)))
                .collect());
        }

        // 非叶子层：使用贪心分解显示子目录 + 剩余文件
        list_greedy_subdirs_with_remainder(&self.query, self.offset, self.count)
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

    fn resolve_file(&self, name: &str) -> Option<(String, PathBuf)> {
        // 同 AllProvider：直接按文件名解析 image_id
        let image_id = name.rsplit_once('.').map(|(s, _)| s).unwrap_or(name);
        if image_id.trim().is_empty() {
            return None;
        }
        let resolved = Storage::global().resolve_gallery_image_path(image_id).ok()??;
        Some((image_id.to_string(), PathBuf::from(resolved)))
    }

    #[cfg(not(kabegame_mode = "light"))]
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
        if !crate::providers::vd_ops::query_can_delete_child_file(&self.query) {
            return Err("当前目录不支持删除文件".to_string());
        }
        if mode == DeleteChildMode::Check {
            return Ok(true);
        }
        let removed =
            crate::providers::vd_ops::query_delete_child_file(&self.query, child_name)?;
        if removed {
            if let Some(album_id) = crate::providers::vd_ops::album_id_from_query(&self.query) {
                if let Some(name) = Storage::global().get_album_name_by_id(album_id)? {
                    ctx.album_images_removed(&name);
                }
            }
        }
        Ok(removed)
    }
}

// === 辅助函数（与旧实现保持一致）===

/// 计算给定大小对应的深度（用于 RangeProvider）
/// 例如：1000 -> 0, 10000 -> 1, 100000 -> 2
fn calc_depth_for_size(size: usize) -> usize {
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
fn parse_range(range: &str) -> Option<(usize, usize)> {
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
fn validate_greedy_range(offset: usize, count: usize, total: usize) -> bool {
    let ranges = greedy_decompose(total);
    ranges.contains(&(offset, count))
}

/// 使用贪心分解策略列出子目录 + 剩余文件
fn list_greedy_subdirs_with_remainder(
    query: &ImageQuery,
    base_offset: usize,
    total: usize,
) -> Result<Vec<FsEntry>, String> {
    let mut entries = Vec::new();
    let ranges = greedy_decompose(total);

    // 添加目录
    for (offset, count) in &ranges {
        entries.push(FsEntry::dir(range_name(*offset + 1, *offset + *count)));
    }

    // 计算剩余文件的起始位置
    let covered: usize = ranges.iter().map(|(_, c)| c).sum();
    let remainder = total - covered;

    // 添加剩余文件（直接显示）
    if remainder > 0 {
        let remainder_offset = base_offset + covered;
        let file_entries =
            Storage::global().get_images_fs_entries_by_query(query, remainder_offset, remainder)?;
        for e in file_entries {
            entries.push(FsEntry::file(
                e.file_name,
                e.image_id,
                PathBuf::from(e.resolved_path),
            ));
        }
    }

    Ok(entries)
}
