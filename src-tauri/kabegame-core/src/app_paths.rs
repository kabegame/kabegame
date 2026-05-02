use std::{path::PathBuf, sync::OnceLock};

/// 应用路径集中管理结构体
///
/// 所有路径在应用启动时由 tauri-plugin-pathes 一次性计算并初始化。
/// 各模块通过 `AppPaths::global()` 获取路径，只做 `.join()` 操作，不做 IO。
pub struct AppPaths {
    /// 数据目录根：桌面 dirs::data_local_dir()/Kabegame；安卓 filesDir
    pub data_dir: PathBuf,
    /// 缓存目录根：桌面 dirs::cache_dir()/Kabegame；安卓 cacheDir
    pub cache_dir: PathBuf,
    /// 临时目录根：桌面 std::env::temp_dir()/Kabegame；安卓 cacheDir
    pub temp_dir: PathBuf,
    /// 资源目录：Tauri BaseDirectory::Resource
    pub resource_dir: PathBuf,
    /// 可执行文件所在目录（仅桌面，Android 为 None）
    pub exe_dir: Option<PathBuf>,
    /// 外部存储的数据目录（仅安卓 getExternalFilesDir，桌面为 None）
    pub external_data_dir: Option<PathBuf>,
    /// 桌面端图片目录（dirs::picture_dir()，Android 为 None）
    pub pictures_dir: Option<PathBuf>,
}

static APP_PATHS: OnceLock<AppPaths> = OnceLock::new();

impl AppPaths {
    /// 初始化全局 AppPaths（由 tauri-plugin-pathes 在 setup 阶段调用）
    pub fn init(paths: AppPaths) -> Result<(), String> {
        APP_PATHS
            .set(paths)
            .map_err(|_| "AppPaths already initialized".to_string())
    }

    /// 获取全局 AppPaths 实例
    pub fn global() -> &'static AppPaths {
        APP_PATHS
            .get()
            .expect("AppPaths not initialized. Call AppPaths::init() at startup.")
    }

    // ========== 数据目录下的文件/目录 ==========

    /// settings.json 文件路径
    pub fn settings_json(&self) -> PathBuf {
        self.data_dir.join("settings.json")
    }

    /// images.db 数据库文件路径
    ///
    /// - 桌面：`data_dir/images.db`
    /// - Android：`data_dir/databases/images.db`（Android 数据库约定）
    pub fn images_db(&self) -> PathBuf {
        #[cfg(target_os = "android")]
        {
            self.data_dir.join("databases").join("images.db")
        }
        #[cfg(not(target_os = "android"))]
        {
            self.data_dir.join("images.db")
        }
    }

    /// plugins-directory 目录（用户安装的插件）
    pub fn plugins_dir(&self) -> PathBuf {
        self.data_dir.join("plugins-directory")
    }

    /// 插件默认配置目录：`plugins-directory/default-configs`
    pub fn default_configs_dir(&self) -> PathBuf {
        self.plugins_dir().join("default-configs")
    }

    /// 单个插件的默认配置文件：`default-configs/<plugin_id>.json`
    pub fn default_config_file(&self, plugin_id: &str) -> PathBuf {
        self.default_configs_dir()
            .join(format!("{}.json", plugin_id))
    }

    /// .cleanup_marker 文件路径（仅桌面）
    #[cfg(not(target_os = "android"))]
    pub fn cleanup_marker(&self) -> PathBuf {
        self.data_dir.join(".cleanup_marker")
    }

    // ========== 图片相关目录 ==========

    /// 图片存储目录
    ///
    /// - 桌面：优先 `pictures_dir/Kabegame`，回退到 `data_dir/images`
    /// - Android：`external_data_dir/images`
    pub fn images_dir(&self) -> PathBuf {
        #[cfg(target_os = "android")]
        {
            self.external_data_dir
                .as_ref()
                .map(|d| d.join("images"))
                .unwrap_or_else(|| self.data_dir.join("images"))
        }
        #[cfg(not(target_os = "android"))]
        {
            self.pictures_dir
                .as_ref()
                .map(|d| d.join("Kabegame"))
                .unwrap_or_else(|| self.data_dir.join("images"))
        }
    }

    /// 缩略图目录
    ///
    /// - 桌面：`data_dir/thumbnails`
    /// - Android：`external_data_dir/thumbnails`
    pub fn thumbnails_dir(&self) -> PathBuf {
        #[cfg(target_os = "android")]
        {
            self.external_data_dir
                .as_ref()
                .map(|d| d.join("thumbnails"))
                .unwrap_or_else(|| self.data_dir.join("thumbnails"))
        }
        #[cfg(not(target_os = "android"))]
        {
            self.data_dir.join("thumbnails")
        }
    }

    // ========== 缓存目录 ==========

    /// store-cache 目录（插件商店 index.json 缓存）
    pub fn store_cache_dir(&self) -> PathBuf {
        self.cache_dir.join("store-cache")
    }

    /// 特定商店源的插件缓存目录
    pub fn store_plugin_cache_dir(&self, source_id: &str) -> PathBuf {
        self.store_cache_dir().join(source_id)
    }

    /// 特定商店源特定插件的缓存文件路径
    pub fn store_plugin_cache_file(&self, source_id: &str, plugin_id: &str) -> PathBuf {
        self.store_plugin_cache_dir(source_id)
            .join(format!("{}.kgpg", plugin_id))
    }

    // ========== 临时目录 ==========

    /// 归档下载临时目录
    pub fn archive_download_temp(&self) -> PathBuf {
        self.temp_dir.join("archive-download")
    }

    /// 插件下载临时目录（返回 temp_dir 根目录）
    pub fn plugin_download_temp(&self) -> PathBuf {
        self.temp_dir.clone()
    }

    // ========== 虚拟驱动相关（仅桌面） ==========

    /// 虚拟驱动备注文件目录
    #[cfg(not(target_os = "android"))]
    pub fn virtual_driver_notes(&self) -> PathBuf {
        self.data_dir.join("virtual-driver").join("notes")
    }

    // ========== IPC Socket（仅桌面非 Windows） ==========

    /// virtual driver IPC socket 路径
    #[cfg(all(not(target_os = "android"), not(target_os = "windows")))]
    pub fn vd_socket(&self) -> PathBuf {
        self.temp_dir.join("kabegame-vd.sock")
    }

    // ========== 其他工具方法 ==========

    /// 获取可执行文件所在目录（仅桌面）
    pub fn exe_dir(&self) -> Option<&PathBuf> {
        self.exe_dir.as_ref()
    }
}

/// 是否使用开发数据目录（仓库本地 data/ 和 cache/）。
/// 由 --data dev|prod 构建选项控制（kabegame_data cfg），未指定时回退到 debug_assertions。
#[inline]
pub fn is_dev() -> bool {
    cfg!(kabegame_data = "dev")
}

/// 尝试从当前可执行文件位置推断项目根目录
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
