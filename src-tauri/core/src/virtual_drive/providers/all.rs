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

use super::super::provider::{FsEntry, VirtualFsProvider};
use crate::storage::gallery::ImageQuery;
use crate::storage::Storage;

/// 每个叶子目录最多包含的图片数量
const LEAF_SIZE: usize = 1000;
/// 每个分组目录最多包含的子目录数量
const GROUP_SIZE: usize = 10;

/// 全部图片 Provider - 支持自定义查询条件
#[derive(Clone)]
pub struct AllProvider {
    query: ImageQuery,
}

impl AllProvider {
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

impl Default for AllProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl VirtualFsProvider for AllProvider {
    fn list(&self, storage: &Storage) -> Result<Vec<FsEntry>, String> {
        let total = storage.get_images_count_by_query(&self.query)?;
        if total == 0 {
            return Ok(Vec::new());
        }

        if total <= LEAF_SIZE {
            // 直接显示图片
            let entries = storage.get_images_fs_entries_by_query(&self.query, 0, total)?;
            return Ok(entries
                .into_iter()
                .map(|e| FsEntry::file(e.file_name, e.image_id, PathBuf::from(e.resolved_path)))
                .collect());
        }

        // 使用贪心分解策略列出子目录 + 剩余文件
        list_greedy_subdirs_with_remainder(storage, &self.query, 0, total)
    }

    fn get_child(&self, storage: &Storage, name: &str) -> Option<Arc<dyn VirtualFsProvider>> {
        let total = storage.get_images_count_by_query(&self.query).ok()?;
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

    fn resolve_file(&self, storage: &Storage, name: &str) -> Option<(String, PathBuf)> {
        // 文件名格式通常为 "<id>.<ext>"，这里取最后一个 '.' 之前的部分作为 image_id
        let image_id = name.rsplit_once('.').map(|(s, _)| s).unwrap_or(name);
        if image_id.trim().is_empty() {
            return None;
        }
        let resolved = storage.resolve_gallery_image_path(image_id).ok()??;
        Some((image_id.to_string(), PathBuf::from(resolved)))
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

impl VirtualFsProvider for RangeProvider {
    fn list(&self, storage: &Storage) -> Result<Vec<FsEntry>, String> {
        if self.depth == 0 {
            // 叶子层：显示图片
            let entries =
                storage.get_images_fs_entries_by_query(&self.query, self.offset, self.count)?;
            return Ok(entries
                .into_iter()
                .map(|e| FsEntry::file(e.file_name, e.image_id, PathBuf::from(e.resolved_path)))
                .collect());
        }

        // 非叶子层：使用贪心分解显示子目录 + 剩余文件
        list_greedy_subdirs_with_remainder(storage, &self.query, self.offset, self.count)
    }

    fn get_child(&self, _storage: &Storage, name: &str) -> Option<Arc<dyn VirtualFsProvider>> {
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

    fn resolve_file(&self, storage: &Storage, name: &str) -> Option<(String, PathBuf)> {
        // 同 AllProvider：直接按文件名解析 image_id
        let image_id = name.rsplit_once('.').map(|(s, _)| s).unwrap_or(name);
        if image_id.trim().is_empty() {
            return None;
        }
        let resolved = storage.resolve_gallery_image_path(image_id).ok()??;
        Some((image_id.to_string(), PathBuf::from(resolved)))
    }
}

// === 辅助函数 ===

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
        // 例如 total=10000 时，如果返回 [(0, 10000)]，进入 `1-10000/` 后又会再出现 `1-10000/` ...
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
    storage: &Storage,
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
            storage.get_images_fs_entries_by_query(query, remainder_offset, remainder)?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_calc_depth_for_size() {
        assert_eq!(calc_depth_for_size(1), 0);
        assert_eq!(calc_depth_for_size(1000), 0);
        assert_eq!(calc_depth_for_size(1001), 1);
        assert_eq!(calc_depth_for_size(10000), 1);
        assert_eq!(calc_depth_for_size(10001), 2);
        assert_eq!(calc_depth_for_size(100000), 2);
    }

    #[test]
    fn test_get_range_sizes() {
        let empty: Vec<usize> = vec![];
        assert_eq!(get_range_sizes(500), empty);
        assert_eq!(get_range_sizes(1000), vec![1000]);
        assert_eq!(get_range_sizes(1500), vec![1000]);
        assert_eq!(get_range_sizes(10000), vec![10000, 1000]);
        assert_eq!(get_range_sizes(112400), vec![100000, 10000, 1000]);
    }

    #[test]
    fn test_parse_range() {
        assert_eq!(parse_range("1-1000"), Some((0, 1000)));
        assert_eq!(parse_range("1001-2000"), Some((1000, 1000)));
        assert_eq!(parse_range("1-10000"), Some((0, 10000)));
        assert_eq!(parse_range("1-100000"), Some((0, 100000)));
        assert_eq!(parse_range("invalid"), None);
        assert_eq!(parse_range("0-1000"), None);
    }

    #[test]
    fn test_greedy_decompose() {
        // 900 张图片：没有完整目录
        let empty: Vec<(usize, usize)> = vec![];
        assert_eq!(greedy_decompose(900), empty);

        // 1000 张图片：全部直接显示为文件，不生成目录
        assert_eq!(greedy_decompose(1000), empty);

        // 1900 张图片：1-1000，剩余 900
        assert_eq!(greedy_decompose(1900), vec![(0, 1000)]);

        // 2500 张图片：1-1000, 1001-2000，剩余 500
        assert_eq!(greedy_decompose(2500), vec![(0, 1000), (1000, 1000)]);

        // 10000 张图片：不生成 1-10000 这种“自我嵌套”目录，改为 10 个 1000 的目录
        assert_eq!(
            greedy_decompose(10000),
            vec![
                (0, 1000),
                (1000, 1000),
                (2000, 1000),
                (3000, 1000),
                (4000, 1000),
                (5000, 1000),
                (6000, 1000),
                (7000, 1000),
                (8000, 1000),
                (9000, 1000)
            ]
        );

        // 10500 张图片：1-10000，剩余 500
        assert_eq!(greedy_decompose(10500), vec![(0, 10000)]);

        // 12400 张图片：1-10000, 10001-11000, 11001-12000，剩余 400
        assert_eq!(
            greedy_decompose(12400),
            vec![(0, 10000), (10000, 1000), (11000, 1000)]
        );

        // 112400 张图片：
        // 1-100000, 100001-110000, 110001-111000, 111001-112000，剩余 400
        assert_eq!(
            greedy_decompose(112400),
            vec![(0, 100000), (100000, 10000), (110000, 1000), (111000, 1000)]
        );

        // 200000 张图片：1-100000, 100001-200000
        assert_eq!(
            greedy_decompose(200000),
            vec![(0, 100000), (100000, 100000)]
        );
    }

    #[test]
    fn test_validate_greedy_range() {
        // 112400 张图片
        assert!(validate_greedy_range(0, 100000, 112400)); // 1-100000 有效
        assert!(validate_greedy_range(100000, 10000, 112400)); // 100001-110000 有效
        assert!(validate_greedy_range(110000, 1000, 112400)); // 110001-111000 有效
        assert!(validate_greedy_range(111000, 1000, 112400)); // 111001-112000 有效
        assert!(!validate_greedy_range(112000, 400, 112400)); // 剩余文件不是目录

        // 无效范围
        assert!(!validate_greedy_range(0, 10000, 112400)); // 不是贪心分解的结果
        assert!(!validate_greedy_range(50000, 50000, 112400)); // 不是贪心分解的结果
    }
}
