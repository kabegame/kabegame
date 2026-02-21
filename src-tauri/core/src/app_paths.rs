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

/// 获取"用户程序数据目录"。
///
/// - 开发模式（debug）：使用源码根目录下的 `data/`（即 `<repo>/data`）
/// - 生产模式（release）：使用系统数据目录并追加 `app_folder_name`（保持现有行为）
/// - Android/iOS：使用 Tauri 路径 API 获取的数据目录（需要先调用 `init_app_data_dir`）
fn user_data_dir(app_folder_name: &str) -> PathBuf {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        // 移动端使用 Tauri 路径 API
        if let Some(path) = APP_DATA_DIR.get() {
            return path.clone();
        }
        // 如果未初始化，返回一个默认路径（不应该发生）
        panic!("App data directory not initialized. Call init_app_data_dir() first.");
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        // 桌面端使用 dirs crate
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

// Android/iOS 应用数据目录（通过 Tauri 路径 API 获取）
#[cfg(any(target_os = "android", target_os = "ios"))]
static APP_DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

#[cfg(any(target_os = "android", target_os = "ios"))]
pub fn init_app_data_dir(path: PathBuf) {
    APP_DATA_DIR.set(path).expect("App data directory already initialized");
}

#[cfg(any(target_os = "android", target_os = "ios"))]
static PROVIDER_CACHE_DIR: OnceLock<PathBuf> = OnceLock::new();

#[cfg(any(target_os = "android", target_os = "ios"))]
static STORE_CACHE_DIR: OnceLock<PathBuf> = OnceLock::new();

#[cfg(any(target_os = "android", target_os = "ios"))]
pub fn init_android_cache_dirs(provider_dir: PathBuf, store_dir: PathBuf) {
    PROVIDER_CACHE_DIR
        .set(provider_dir)
        .expect("Provider cache dir already initialized");
    STORE_CACHE_DIR
        .set(store_dir)
        .expect("Store cache dir already initialized");
}

pub fn provider_cache_dir() -> PathBuf {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        PROVIDER_CACHE_DIR
            .get()
            .expect("Provider cache dir not initialized")
            .clone()
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        dirs::cache_dir()
            .expect("Failed to get cache dir")
            .join("Kabegame")
            .join("provider-cache")
    }
}

pub fn store_cache_dir() -> PathBuf {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        STORE_CACHE_DIR
            .get()
            .expect("Store cache dir not initialized")
            .clone()
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        dirs::cache_dir()
            .expect("Failed to get cache dir")
            .join("Kabegame")
            .join("store-cache")
    }
}