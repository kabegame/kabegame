//! 「壁纸」收集入口的只读命令：扫描自动来源 / 识别用户选中的目录。

use serde_json::Value;
use std::collections::HashSet;
use std::path::Path;

use crate::storage::Storage;
use crate::wpe::scan::{path_key, scan_extra_dir, scan_sources};

fn imported_paths() -> HashSet<String> {
    Storage::global()
        .list_wpe_local_paths()
        .unwrap_or_default()
        .into_iter()
        .map(|path| path_key(&path))
        .collect()
}

/// 扫描自动发现的 Steam 库来源（创意工坊 / 官方默认 / 我的项目）。
pub fn scan_wpe_sources() -> Result<Value, String> {
    let result = scan_sources(&imported_paths());
    serde_json::to_value(result).map_err(|error| error.to_string())
}

/// 识别一个用户选中的文件夹，返回它展开后的壁纸数量。
pub fn recognize_wpe_dir(path: String) -> Result<Value, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("路径不能为空".to_string());
    }
    let info = scan_extra_dir(Path::new(trimmed), &imported_paths())?;
    serde_json::to_value(info).map_err(|error| error.to_string())
}
