use std::{path::PathBuf, sync::OnceLock};

/// 是否为开发模式（debug 构建）。
#[inline]
pub fn is_dev() -> bool {
    cfg!(debug_assertions)
}

/// 尝试从当前可执行文件位置推断项目根目录。
///
/// 典型 Tauri dev：`<repo>/src-tauri/target/debug/<exe>`
/// 我们向上回溯，找到同时包含 `package.json` 和 `src-tauri/` 的目录，作为 repo 根目录。
pub fn repo_root_dir() -> Option<PathBuf> {
    let exe_path = std::env::current_exe().ok()?;
    let mut dir = exe_path.parent()?.to_path_buf();

    // 向上最多回溯 10 层，避免极端情况下死循环/过度遍历。
    for _ in 0..10 {
        let has_pkg_json = dir.join("package.json").is_file();
        let has_src_tauri = dir.join("src-tauri").is_dir();
        if has_pkg_json && has_src_tauri {
            return Some(dir);
        }

        dir = dir.parent()?.to_path_buf();
    }

    None
}

/// 获取“用户程序数据目录”。
///
/// - 开发模式（debug）：使用源码根目录下的 `data/`（即 `<repo>/data`）
/// - 生产模式（release）：使用系统数据目录并追加 `app_folder_name`（保持现有行为）
fn user_data_dir(app_folder_name: &str) -> PathBuf {
    if is_dev() {
        if let Some(repo_root) = repo_root_dir() {
            return repo_root.join("data");
        }
    }

    dirs::data_local_dir()
        .or_else(|| dirs::data_dir())
        .expect("Failed to get app data directory")
        .join(app_folder_name)
}

/// Kabegame 主应用数据目录（便于统一调用）。
#[inline]
pub fn kabegame_data_dir() -> PathBuf {
    user_data_dir("Kabegame")
}

static RESOURCE_PATH: OnceLock<PathBuf> = OnceLock::new();

pub fn resource_dir() -> PathBuf {
    return RESOURCE_PATH.get().unwrap().clone()
}

pub fn init_resource_path(path: PathBuf) {
    RESOURCE_PATH.set(path).unwrap();
}