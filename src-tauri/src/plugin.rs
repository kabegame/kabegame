use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use uuid::Uuid;
use zip::ZipArchive;

const BUILD_MODE: &str = env!("KABEGAME_BUILD_MODE"); // injected by build.rs

fn is_local_mode() -> bool {
    BUILD_MODE == "local"
}

fn is_immutable_builtin_id(builtins: &HashSet<String>, plugin_id: &str) -> bool {
    // 只有 local 模式才把内置插件视为“不可变/不可卸载”。
    // normal 模式的“本地两个插件”只是首次安装的种子，不应阻止用户覆盖/卸载。
    is_local_mode() && builtins.contains(plugin_id)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plugin {
    pub id: String,
    pub name: String,
    pub description: String,
    /// manifest.json 里的版本号
    pub version: String,
    #[serde(rename = "baseUrl")]
    pub base_url: String,
    pub enabled: bool,
    /// 插件包体大小（.kgpg 文件大小）
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
    /// 是否内置插件（目前 .kgpg 均视为非内置）
    #[serde(rename = "builtIn")]
    pub built_in: bool,
    pub config: HashMap<String, serde_json::Value>,
    pub selector: Option<PluginSelector>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSelector {
    #[serde(rename = "imageSelector")]
    pub image_selector: String,
    #[serde(rename = "nextPageSelector")]
    pub next_page_selector: Option<String>,
    #[serde(rename = "titleSelector")]
    pub title_selector: Option<String>,
}

pub struct PluginManager {
    app: AppHandle,
    remote_zip_cache: Mutex<HashMap<String, RemoteZipCacheEntry>>,
    builtins_cache: Mutex<Option<HashSet<String>>>,
    enabled_cache: Mutex<Option<HashMap<String, bool>>>,
}

impl PluginManager {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            remote_zip_cache: Mutex::new(HashMap::new()),
            builtins_cache: Mutex::new(None),
            enabled_cache: Mutex::new(None),
        }
    }

    pub fn build_mode(&self) -> &'static str {
        BUILD_MODE
    }

    fn prepackaged_plugins_dir(&self) -> Result<PathBuf, String> {
        // 开发模式：Tauri resource_dir 指向 target/debug 等，不包含我们的 resources 文件
        // 需要回退到项目源码里的 src-tauri/resources/plugins
        #[cfg(debug_assertions)]
        {
            // 尝试从 repo root 定位
            if let Some(repo_root) = crate::app_paths::repo_root_dir() {
                let dev_path = repo_root
                    .join("src-tauri")
                    .join("resources")
                    .join("plugins");
                if dev_path.exists() {
                    return Ok(dev_path);
                }
            }
        }

        // 生产模式：使用 Tauri resource_dir
        let dir = self
            .app
            .path()
            .resource_dir()
            .map_err(|e| format!("Failed to resolve resource_dir: {}", e))?
            .join("plugins");
        Ok(dir)
    }

    /// 从编译期常量解析内置插件列表（逗号分隔）
    fn parse_builtin_plugins() -> HashSet<String> {
        const BUILTINS_STR: &str = env!("KABEGAME_BUILTIN_PLUGINS");
        BUILTINS_STR
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect()
    }

    fn builtins(&self) -> HashSet<String> {
        if let Ok(mut guard) = self.builtins_cache.lock() {
            if let Some(cached) = guard.as_ref() {
                return cached.clone();
            }
            let loaded = Self::parse_builtin_plugins();
            *guard = Some(loaded.clone());
            return loaded;
        }
        Self::parse_builtin_plugins()
    }

    fn enabled_state_file(&self) -> PathBuf {
        let data_dir = crate::app_paths::user_data_dir("Kabegame");
        data_dir.join("plugin_enabled.json")
    }

    fn load_enabled_map(&self) -> HashMap<String, bool> {
        let file = self.enabled_state_file();
        if !file.is_file() {
            return HashMap::new();
        }
        let content = match fs::read_to_string(&file) {
            Ok(s) => s,
            Err(_) => return HashMap::new(),
        };
        serde_json::from_str::<HashMap<String, bool>>(&content).unwrap_or_default()
    }

    fn enabled_map(&self) -> HashMap<String, bool> {
        if let Ok(mut guard) = self.enabled_cache.lock() {
            if let Some(cached) = guard.as_ref() {
                return cached.clone();
            }
            let loaded = self.load_enabled_map();
            *guard = Some(loaded.clone());
            return loaded;
        }
        self.load_enabled_map()
    }

    fn save_enabled_map(&self, map: &HashMap<String, bool>) -> Result<(), String> {
        let file = self.enabled_state_file();
        if let Some(parent) = file.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create enabled state dir: {}", e))?;
        }
        let content = serde_json::to_string_pretty(map)
            .map_err(|e| format!("Failed to serialize enabled state: {}", e))?;
        fs::write(&file, content).map_err(|e| format!("Failed to write enabled state: {}", e))?;
        if let Ok(mut guard) = self.enabled_cache.lock() {
            *guard = Some(map.clone());
        }
        Ok(())
    }

    fn set_plugin_enabled(&self, plugin_id: &str, enabled: bool) -> Result<(), String> {
        let mut m = self.enabled_map();
        m.insert(plugin_id.to_string(), enabled);
        self.save_enabled_map(&m)
    }

    fn remove_plugin_enabled_state(&self, plugin_id: &str) -> Result<(), String> {
        let mut m = self.enabled_map();
        m.remove(plugin_id);
        self.save_enabled_map(&m)
    }

    /// 每次启动：将 resources/plugins 下的内置插件覆盖复制到用户插件目录，确保可用性/不变性
    pub fn ensure_prepackaged_plugins_installed(&self) -> Result<(), String> {
        let builtins = self.builtins();
        if builtins.is_empty() {
            return Ok(());
        }

        let src_dir = self.prepackaged_plugins_dir()?;

        // 强制使用用户插件目录（并创建），以确保 debug 模式也不会回退到 crawler-plugins/packed
        let data_dir = crate::app_paths::user_data_dir("Kabegame");
        let dst_dir = data_dir.join("plugins-directory");
        fs::create_dir_all(&dst_dir)
            .map_err(|e| format!("Failed to create plugins directory: {}", e))?;

        for id in builtins {
            let src = src_dir.join(format!("{}.kgpg", id));
            if !src.is_file() {
                // 资源缺失：跳过（不算致命）
                continue;
            }
            let dst = dst_dir.join(format!("{}.kgpg", id));

            // local 模式：无差别覆盖，确保可用性/不变性
            // normal 模式：仅首次安装（目标不存在才复制），允许用户后续覆盖/卸载
            if !is_local_mode() && dst.exists() {
                continue;
            }

            // 先拷贝到临时文件再原子替换（避免进程中途退出留下半文件）
            let tmp = dst_dir.join(format!("{}.kgpg.tmp", id));
            fs::copy(&src, &tmp).map_err(|e| format!("Failed to copy {}: {}", id, e))?;
            // Windows 上 rename 覆盖行为不一致：先删除旧文件再 rename
            if dst.exists() {
                let _ = fs::remove_file(&dst);
            }
            fs::rename(&tmp, &dst).map_err(|e| format!("Failed to finalize {}: {}", id, e))?;
        }
        Ok(())
    }

    /// 从插件目录中的 .kgpg 文件加载所有已安装的插件
    pub fn get_all(&self) -> Result<Vec<Plugin>, String> {
        let builtins = self.builtins();
        let enabled_map = self.enabled_map();

        let plugins_dir = self.get_plugins_directory();
        if !plugins_dir.exists() {
            return Ok(vec![]);
        }

        let mut plugins = Vec::new();
        let entries = fs::read_dir(&plugins_dir)
            .map_err(|e| format!("Failed to read plugins directory: {}", e))?;

        for entry in entries {
            let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
            let path = entry.path();

            // 只处理 .kgpg 文件
            if path.is_file() && path.extension().and_then(|s| s.to_str()) == Some("kgpg") {
                if let Ok(manifest) = self.read_plugin_manifest(&path) {
                    let config = self.read_plugin_config(&path)?;
                    let size_bytes = fs::metadata(&path)
                        .map_err(|e| format!("Failed to get plugin file metadata: {}", e))?
                        .len();

                    // 获取文件创建时间（安装时间）
                    let created_time = fs::metadata(&path)
                        .and_then(|m| m.created())
                        .or_else(|_| fs::metadata(&path).and_then(|m| m.modified()))
                        .map_err(|e| format!("Failed to get plugin file time: {}", e))?;

                    // 仅使用文件名作为插件 ID（避免冲突）
                    let file_name = path
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("")
                        .to_string();
                    let plugin_id = file_name.clone();

                    let plugin = Plugin {
                        id: plugin_id.clone(),
                        name: manifest.name.clone(),
                        description: manifest.description,
                        version: manifest.version,
                        base_url: config
                            .as_ref()
                            .map(|c| c.base_url.clone())
                            .unwrap_or_default(),
                        enabled: enabled_map.get(&plugin_id).copied().unwrap_or(true),
                        size_bytes,
                        built_in: is_immutable_builtin_id(&builtins, &plugin_id),
                        config: HashMap::new(),
                        selector: config.and_then(|c| c.selector),
                    };
                    plugins.push((plugin, created_time));
                }
            }
        }

        // 按文件创建时间排序（越早安装的越靠前）
        plugins.sort_by_key(|(_, time)| *time);
        let plugins: Vec<Plugin> = plugins.into_iter().map(|(p, _)| p).collect();

        Ok(plugins)
    }

    pub fn get(&self, id: &str) -> Option<Plugin> {
        let plugins = self.get_all().ok()?;
        plugins.into_iter().find(|p| p.id == id)
    }

    /// 更新插件配置（只更新 enabled 状态，其他信息从 .kgpg 文件读取）
    pub fn update(
        &self,
        id: &str,
        updates: HashMap<String, serde_json::Value>,
    ) -> Result<Plugin, String> {
        // 插件信息现在直接从 .kgpg 文件读取
        // 只允许更新 enabled 状态，其他信息不能修改
        // 如果需要修改插件信息，需要重新安装插件

        // 先获取插件
        let mut plugin = self
            .get(id)
            .ok_or_else(|| format!("Plugin {} not found", id))?;

        // 只更新 enabled 状态
        if let Some(enabled) = updates.get("enabled").and_then(|v| v.as_bool()) {
            plugin.enabled = enabled;
            self.set_plugin_enabled(id, enabled)?;
        }

        Ok(plugin)
    }

    /// 删除插件（删除对应的 .kgpg 文件）
    pub fn delete(&self, id: &str) -> Result<(), String> {
        // 内置插件不可卸载（仅 local 模式；normal 模式允许用户覆盖/卸载）
        if is_immutable_builtin_id(&self.builtins(), id) {
            return Err("该插件为内置插件，禁止卸载。请切换应用程序版本。".to_string());
        }

        let plugins_dir = self.get_plugins_directory();
        if !plugins_dir.exists() {
            return Err(format!("Plugin {} not found", id));
        }

        let entries = fs::read_dir(&plugins_dir)
            .map_err(|e| format!("Failed to read plugins directory: {}", e))?;

        for entry in entries {
            let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
            let path = entry.path();

            if path.is_file() && path.extension().and_then(|s| s.to_str()) == Some("kgpg") {
                let file_name = path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_string();
                let plugin_id = file_name;

                if plugin_id == id {
                    fs::remove_file(&path)
                        .map_err(|e| format!("Failed to delete plugin file: {}", e))?;
                    let _ = self.remove_plugin_enabled_state(id);
                    return Ok(());
                }
            }
        }

        Err(format!("Plugin {} not found", id))
    }

    pub fn get_plugins_directory(&self) -> PathBuf {
        // 开发模式：优先使用 data/plugins_directory，其次使用 crawler-plugins/packed
        #[cfg(debug_assertions)]
        {
            let app_data_dir = crate::app_paths::user_data_dir("Kabegame");
            let data_plugins_dir = app_data_dir.join("plugins-directory");

            // 优先尝试 data/plugins_directory（开发数据目录）
            if data_plugins_dir.exists() {
                return data_plugins_dir;
            }

            // 其次尝试 crawler-plugins/packed（向后兼容）
            // 1. 当前工作目录（开发时通常在项目根目录）
            if let Ok(cwd) = std::env::current_dir() {
                let packed_path = cwd.join("crawler-plugins").join("packed");
                if packed_path.exists() {
                    return packed_path;
                }
            }

            // 2. 从可执行文件位置查找
            if let Ok(exe_path) = std::env::current_exe() {
                if let Some(exe_dir) = exe_path.parent() {
                    // 在开发模式下，可执行文件在 target/debug，需要向上到项目根目录
                    if let Some(project_root) = exe_dir
                        .parent() // target
                        .and_then(|p| p.parent()) // src-tauri
                        .and_then(|p| p.parent())
                    // 项目根目录
                    {
                        let packed_path = project_root.join("crawler-plugins").join("packed");
                        if packed_path.exists() {
                            return packed_path;
                        }
                    }
                }
            }

            // 如果都不存在，返回 data/plugins_directory（即使不存在，也会在后续创建）
            return data_plugins_dir;
        }

        // 生产模式：使用应用数据目录
        #[cfg(not(debug_assertions))]
        {
            let app_data_dir = crate::app_paths::user_data_dir("Kabegame");
            app_data_dir.join("plugins-directory")
        }
    }

    pub fn get_favorites_file(&self) -> PathBuf {
        let app_data_dir = crate::app_paths::user_data_dir("Kabegame");
        app_data_dir.join("plugin_favorites.json")
    }

    pub fn load_browser_plugins(&self) -> Result<Vec<BrowserPlugin>, String> {
        let plugins_dir = self.get_plugins_directory();
        if !plugins_dir.exists() {
            // 开发模式下，如果 crawler-plugins/packed 不存在，返回空列表
            #[cfg(debug_assertions)]
            return Ok(vec![]);

            // 生产模式下，创建目录
            #[cfg(not(debug_assertions))]
            {
                fs::create_dir_all(&plugins_dir)
                    .map_err(|e| format!("Failed to create plugins directory: {}", e))?;
                return Ok(vec![]);
            }
        }

        let favorites = self.load_favorites()?;
        let mut browser_plugins = Vec::new();

        let entries = fs::read_dir(&plugins_dir)
            .map_err(|e| format!("Failed to read plugins directory: {}", e))?;

        for entry in entries {
            let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
            let path = entry.path();

            // 只支持 .kgpg 文件格式
            if path.is_file() {
                let ext = path.extension().and_then(|s| s.to_str());
                if ext == Some("kgpg") {
                    // 读取 ZIP 格式的插件
                    if let Ok(manifest) = self.read_plugin_manifest(&path) {
                        let file_name = path
                            .file_stem()
                            .and_then(|s| s.to_str())
                            .unwrap_or("")
                            .to_string();
                        let plugin_id = file_name.clone();
                        let favorite = favorites.contains(&plugin_id);

                        // 读取 doc.md（可选）
                        let doc = self.read_plugin_doc(&path).ok().flatten();

                        // 检查图标是否存在
                        let icon_path = if self.check_plugin_icon_exists(&path) {
                            Some(path.to_string_lossy().to_string())
                        } else {
                            None
                        };

                        browser_plugins.push(BrowserPlugin {
                            id: plugin_id,
                            name: manifest.name,
                            desp: manifest.description,
                            icon: icon_path, // 如果图标存在，存储插件文件路径
                            favorite,
                            file_path: Some(path.to_string_lossy().to_string()),
                            doc, // 添加 doc 字段
                        });
                    }
                }
            }
        }

        Ok(browser_plugins)
    }

    /// 从 ZIP 格式的插件文件中读取 manifest.json
    pub fn read_plugin_manifest(&self, zip_path: &Path) -> Result<PluginManifest, String> {
        let file =
            fs::File::open(zip_path).map_err(|e| format!("Failed to open plugin file: {}", e))?;
        let mut archive =
            ZipArchive::new(file).map_err(|e| format!("Failed to open ZIP archive: {}", e))?;

        // 只读取 manifest.json，不解压整个文件
        let mut manifest_file = archive
            .by_name("manifest.json")
            .map_err(|_| "manifest.json not found in plugin archive")?;

        let mut content = String::new();
        manifest_file
            .read_to_string(&mut content)
            .map_err(|e| format!("Failed to read manifest.json: {}", e))?;

        let manifest: PluginManifest = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse manifest.json: {}", e))?;
        Ok(manifest)
    }

    /// 从 ZIP 格式的插件文件中读取 doc_root/doc.md
    fn read_plugin_doc(&self, zip_path: &Path) -> Result<Option<String>, String> {
        let file =
            fs::File::open(zip_path).map_err(|e| format!("Failed to open plugin file: {}", e))?;
        let mut archive =
            ZipArchive::new(file).map_err(|e| format!("Failed to open ZIP archive: {}", e))?;

        // 优先从 doc_root/doc.md 读取，如果没有则尝试 doc.md（向后兼容）
        let doc_paths = ["doc_root/doc.md", "doc.md"];
        let mut doc_path_found = None;

        for doc_path in &doc_paths {
            if archive.by_name(doc_path).is_ok() {
                doc_path_found = Some(*doc_path);
                break;
            }
        }

        let doc_path = match doc_path_found {
            Some(p) => p,
            None => return Ok(None), // doc.md 是可选的
        };

        let mut doc_file = archive.by_name(doc_path).map_err(|_| "doc.md not found")?;

        let mut content = String::new();
        doc_file
            .read_to_string(&mut content)
            .map_err(|e| format!("Failed to read doc.md: {}", e))?;

        Ok(Some(content))
    }

    /// 从 ZIP 格式的插件文件中读取图片资源（用于 doc_root 下的图片）
    pub fn read_plugin_image(&self, zip_path: &Path, image_path: &str) -> Result<Vec<u8>, String> {
        let file =
            fs::File::open(zip_path).map_err(|e| format!("Failed to open plugin file: {}", e))?;
        let mut archive =
            ZipArchive::new(file).map_err(|e| format!("Failed to open ZIP archive: {}", e))?;

        // 规范化图片路径
        let mut normalized_path = image_path.trim().to_string();

        // 安全检查 1: 拒绝绝对路径
        if normalized_path.starts_with('/') || normalized_path.starts_with("\\") {
            return Err("Absolute paths are not allowed".to_string());
        }

        // URL 解码（处理 %20 等编码字符）
        // 手动替换常见的 URL 编码字符
        normalized_path = normalized_path
            .replace("%20", " ")
            .replace("%28", "(")
            .replace("%29", ")")
            .replace("%2F", "/")
            .replace("%5C", "\\")
            .replace("%2E", "."); // 解码 . 字符

        // 安全检查 2: 拒绝路径遍历攻击（../ 和 ..\）
        // 检查各种可能的路径遍历形式
        if normalized_path.contains("../")
            || normalized_path.contains("..\\")
            || normalized_path.contains("..%2F") // URL 编码的 ../
            || normalized_path.contains("..%5C") // URL 编码的 ..\
            || normalized_path.starts_with("..")
        {
            return Err("Path traversal attacks are not allowed".to_string());
        }

        // 移除 ./ 前缀
        if normalized_path.starts_with("./") {
            normalized_path = normalized_path[2..].to_string();
        }

        // 移除 doc_root/ 前缀（如果存在）
        if normalized_path.starts_with("doc_root/") {
            normalized_path = normalized_path[9..].to_string();
        }

        // 规范化路径分隔符（Windows 使用 \，但 ZIP 内部使用 /）
        normalized_path = normalized_path.replace('\\', "/");

        // 安全检查 3: 再次检查规范化后的路径（防止双重编码等攻击）
        if normalized_path.contains("../") || normalized_path.starts_with("..") {
            return Err("Path traversal detected after normalization".to_string());
        }

        // 安全检查 4: 确保路径不为空，且不包含控制字符
        if normalized_path.is_empty() {
            return Err("Empty image path is not allowed".to_string());
        }
        if normalized_path.chars().any(|c| c.is_control()) {
            return Err("Control characters in path are not allowed".to_string());
        }

        // 确保路径在 doc_root 目录下（安全限制）
        let final_path = format!("doc_root/{}", normalized_path);

        // 安全检查 5: 最终验证路径确实在 doc_root 下
        // 规范化最终路径，检查是否包含路径遍历
        if final_path.contains("../") || final_path.starts_with("../") {
            return Err("Final path validation failed".to_string());
        }

        let mut image_file = archive.by_name(&final_path).map_err(|e| {
            format!(
                "Image {} not found in plugin archive. Error: {:?}",
                final_path, e
            )
        })?;

        let mut image_data = Vec::new();
        image_file
            .read_to_end(&mut image_data)
            .map_err(|e| format!("Failed to read image: {}", e))?;

        Ok(image_data)
    }

    /// 从 ZIP 格式的插件文件中读取 crawl.rhai 脚本
    pub fn read_plugin_script(&self, zip_path: &Path) -> Result<Option<String>, String> {
        let file =
            fs::File::open(zip_path).map_err(|e| format!("Failed to open plugin file: {}", e))?;
        let mut archive =
            ZipArchive::new(file).map_err(|e| format!("Failed to open ZIP archive: {}", e))?;

        let mut script_file = match archive.by_name("crawl.rhai") {
            Ok(f) => f,
            Err(_) => return Ok(None), // crawl.rhai 是可选的
        };

        let mut content = String::new();
        script_file
            .read_to_string(&mut content)
            .map_err(|e| format!("Failed to read crawl.rhai: {}", e))?;
        Ok(Some(content))
    }

    /// 检查插件 ZIP 文件中是否存在 icon.png
    fn check_plugin_icon_exists(&self, zip_path: &Path) -> bool {
        if let Ok(file) = fs::File::open(zip_path) {
            if let Ok(mut archive) = ZipArchive::new(file) {
                return archive.by_name("icon.png").is_ok();
            }
        }
        false
    }

    /// 从 ZIP 格式的插件文件中读取 icon.png
    pub fn read_plugin_icon(&self, zip_path: &Path) -> Result<Option<Vec<u8>>, String> {
        let file =
            fs::File::open(zip_path).map_err(|e| format!("Failed to open plugin file: {}", e))?;
        let mut archive =
            ZipArchive::new(file).map_err(|e| format!("Failed to open ZIP archive: {}", e))?;

        let mut icon_file = match archive.by_name("icon.png") {
            Ok(f) => f,
            Err(_) => return Ok(None), // icon.png 是可选的
        };

        let mut icon_data = Vec::new();
        icon_file
            .read_to_end(&mut icon_data)
            .map_err(|e| format!("Failed to read icon.png: {}", e))?;

        Ok(Some(icon_data))
    }

    /// 从 ZIP 格式的插件文件中读取 config.json
    fn read_plugin_config(&self, zip_path: &Path) -> Result<Option<PluginConfig>, String> {
        let file =
            fs::File::open(zip_path).map_err(|e| format!("Failed to open plugin file: {}", e))?;
        let mut archive =
            ZipArchive::new(file).map_err(|e| format!("Failed to open ZIP archive: {}", e))?;

        let mut config_file = match archive.by_name("config.json") {
            Ok(f) => f,
            Err(_) => return Ok(None), // config.json 是可选的
        };

        let mut content = String::new();
        config_file
            .read_to_string(&mut content)
            .map_err(|e| format!("Failed to read config.json: {}", e))?;

        let config: PluginConfig = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse config.json: {}", e))?;
        Ok(Some(config))
    }

    /// 安装 .kgpg 插件（复制文件到插件目录）
    pub fn install_plugin_from_zip(&self, zip_path: &Path) -> Result<Plugin, String> {
        // 读取 manifest 以获取插件信息
        let manifest = self.read_plugin_manifest(zip_path)?;

        // 读取 config（如果存在）
        let config = self.read_plugin_config(zip_path)?;

        // 获取插件目录
        let plugins_dir = self.get_plugins_directory();
        fs::create_dir_all(&plugins_dir)
            .map_err(|e| format!("Failed to create plugins directory: {}", e))?;

        // 获取源文件名
        let file_name = zip_path
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or_else(|| "Invalid file name".to_string())?;

        // 目标文件路径
        let target_path = plugins_dir.join(file_name);

        // local 模式：禁止导入同 ID（提醒用户切换应用程序版本）
        let file_stem = zip_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        if is_local_mode() && self.get(&file_stem).is_some() {
            return Err(
                "检测到同 ID 插件已存在，本版本禁止覆盖导入。请切换应用程序版本获取该插件的对应更新。"
                    .to_string(),
            );
        }

        // 如果目标文件已存在，先删除
        if target_path.exists() {
            fs::remove_file(&target_path)
                .map_err(|e| format!("Failed to remove existing plugin file: {}", e))?;
        }

        // 复制 .kgpg 文件到插件目录
        fs::copy(zip_path, &target_path)
            .map_err(|e| format!("Failed to copy plugin file: {}", e))?;

        // 构建 Plugin 对象（从复制的文件中读取）
        let plugin_id = file_stem.clone();

        let size_bytes = fs::metadata(&target_path)
            .map_err(|e| format!("Failed to get plugin file metadata: {}", e))?
            .len();

        let plugin = Plugin {
            id: plugin_id.clone(),
            name: manifest.name.clone(),
            description: manifest.description,
            version: manifest.version,
            base_url: config
                .as_ref()
                .map(|c| c.base_url.clone())
                .unwrap_or_default(),
            enabled: true,
            size_bytes,
            built_in: is_immutable_builtin_id(&self.builtins(), &plugin_id),
            config: HashMap::new(),
            selector: config.and_then(|c| c.selector),
        };

        Ok(plugin)
    }

    /// 安装浏览器插件（从插件目录中的 .kgpg 文件安装）
    /// 实际上，如果文件已经在插件目录中，就已经是"已安装"状态了
    /// 这个方法主要用于标记插件为已安装（如果之前未安装的话）
    pub fn install_browser_plugin(&self, plugin_id: String) -> Result<Plugin, String> {
        let plugins_dir = self.get_plugins_directory();
        let entries = fs::read_dir(&plugins_dir)
            .map_err(|e| format!("Failed to read plugins directory: {}", e))?;

        for entry in entries {
            let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
            let path = entry.path();

            if path.is_file() && path.extension().and_then(|s| s.to_str()) == Some("kgpg") {
                if let Ok(manifest) = self.read_plugin_manifest(&path) {
                    let file_name = path
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("")
                        .to_string();

                    if file_name == plugin_id {
                        // 文件已经在插件目录中，直接读取并返回
                        let config = self.read_plugin_config(&path)?;
                        let size_bytes = fs::metadata(&path)
                            .map_err(|e| format!("Failed to get plugin file metadata: {}", e))?
                            .len();
                        let plugin = Plugin {
                            id: file_name.clone(),
                            name: manifest.name.clone(),
                            description: manifest.description,
                            version: manifest.version,
                            base_url: config
                                .as_ref()
                                .map(|c| c.base_url.clone())
                                .unwrap_or_default(),
                            enabled: true,
                            size_bytes,
                            built_in: false,
                            config: HashMap::new(),
                            selector: config.and_then(|c| c.selector),
                        };
                        return Ok(plugin);
                    }
                }
            }
        }

        Err(format!("Plugin {} not found", plugin_id))
    }

    fn load_favorites(&self) -> Result<Vec<String>, String> {
        let file = self.get_favorites_file();
        if !file.exists() {
            return Ok(vec![]);
        }

        let content = fs::read_to_string(&file)
            .map_err(|e| format!("Failed to read favorites file: {}", e))?;
        let favorites: Vec<String> = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse favorites: {}", e))?;
        Ok(favorites)
    }

    /// 获取插件的变量定义（从 config.json 中读取）
    pub fn get_plugin_vars(&self, plugin_id: &str) -> Result<Option<Vec<VarDefinition>>, String> {
        let plugins_dir = self.get_plugins_directory();
        let plugin_file = self.find_plugin_file(&plugins_dir, plugin_id)?;
        let config = self.read_plugin_config(&plugin_file)?;
        Ok(config.and_then(|c| c.var))
    }

    /// 加载用户对插件的配置
    pub fn load_plugin_config(
        &self,
        plugin_id: &str,
    ) -> Result<HashMap<String, serde_json::Value>, String> {
        let file = self.get_plugin_config_file(plugin_id);
        if !file.exists() {
            return Ok(HashMap::new());
        }

        let content = fs::read_to_string(&file)
            .map_err(|e| format!("Failed to read plugin config: {}", e))?;
        let config: HashMap<String, serde_json::Value> = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse plugin config: {}", e))?;
        Ok(config)
    }

    /// 保存用户对插件的配置
    pub fn save_plugin_config(
        &self,
        plugin_id: &str,
        config: &HashMap<String, serde_json::Value>,
    ) -> Result<(), String> {
        let file = self.get_plugin_config_file(plugin_id);
        if let Some(parent) = file.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create config directory: {}", e))?;
        }

        let content = serde_json::to_string_pretty(config)
            .map_err(|e| format!("Failed to serialize plugin config: {}", e))?;
        fs::write(&file, content).map_err(|e| format!("Failed to write plugin config: {}", e))?;
        Ok(())
    }

    /// 获取插件配置文件的路径
    fn get_plugin_config_file(&self, plugin_id: &str) -> PathBuf {
        let data_dir = crate::app_paths::user_data_dir("Kabegame");
        let config_dir = data_dir.join("plugin_configs");
        config_dir.join(format!("{}.json", plugin_id))
    }

    /// 查找插件文件
    fn find_plugin_file(&self, plugins_dir: &Path, plugin_id: &str) -> Result<PathBuf, String> {
        let entries = fs::read_dir(plugins_dir)
            .map_err(|e| format!("Failed to read plugins directory: {}", e))?;

        for entry in entries {
            let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
            let path = entry.path();

            if path.is_file() && path.extension().and_then(|s| s.to_str()) == Some("kgpg") {
                let file_name = path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_string();
                if file_name == plugin_id {
                    return Ok(path);
                }
            }
        }

        Err(format!("Plugin {} not found", plugin_id))
    }

    /// 加载插件源列表
    pub fn load_plugin_sources(&self) -> Result<Vec<PluginSource>, String> {
        let default_sources = self.get_default_sources();
        let file = self.get_plugin_sources_file();

        if !file.exists() {
            // 文件不存在，返回默认官方源
            return Ok(default_sources);
        }

        let content = fs::read_to_string(&file)
            .map_err(|e| format!("Failed to read plugin sources file: {}", e))?;
        let user_sources: Vec<PluginSource> = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse plugin sources: {}", e))?;

        // 合并官方源和用户源：确保官方源始终存在，且不能被用户修改
        let mut result = default_sources;
        let official_ids: std::collections::HashSet<String> =
            result.iter().map(|s| s.id.clone()).collect();

        // 添加用户自定义的源（排除官方源，避免重复）
        for source in user_sources {
            if !official_ids.contains(&source.id) {
                result.push(source);
            }
        }

        Ok(result)
    }

    /// 保存插件源列表（只保存用户自定义的源，官方源不会被保存）
    pub fn save_plugin_sources(&self, sources: &[PluginSource]) -> Result<(), String> {
        let file = self.get_plugin_sources_file();
        if let Some(parent) = file.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create plugin sources directory: {}", e))?;
        }

        // 过滤掉官方源，只保存用户自定义的源
        let official_ids: std::collections::HashSet<String> = self
            .get_default_sources()
            .iter()
            .map(|s| s.id.clone())
            .collect();

        let user_sources: Vec<PluginSource> = sources
            .iter()
            .filter(|s| !official_ids.contains(&s.id))
            .cloned()
            .collect();

        let content = serde_json::to_string_pretty(&user_sources)
            .map_err(|e| format!("Failed to serialize plugin sources: {}", e))?;
        fs::write(&file, content)
            .map_err(|e| format!("Failed to write plugin sources file: {}", e))?;
        Ok(())
    }

    /// 获取插件源文件路径
    fn get_plugin_sources_file(&self) -> PathBuf {
        let data_dir = crate::app_paths::user_data_dir("Kabegame");
        data_dir.join("plugin_sources.json")
    }

    /// 获取默认的官方源列表
    fn get_default_sources(&self) -> Vec<PluginSource> {
        let owner = option_env!("CRAWLER_PLUGINS_REPO_OWNER").unwrap_or("kabegame");
        let repo = option_env!("CRAWLER_PLUGINS_REPO_NAME").unwrap_or("crawler-plugins");
        // NOTE:
        // 以前这里使用 `releases/download/{tag}/index.json`（tag 由 build.rs 注入），
        // 但当 tag 对应的 Release 资产不存在/被清理时，前端会显示官方源 404。
        // 这里改为固定使用 GitHub 的 latest download 直链，避免依赖具体 tag。
        let index_url = format!(
            "https://github.com/{}/{}/releases/latest/download/index.json",
            owner, repo
        );

        vec![PluginSource {
            id: "official_github_release".to_string(),
            name: "官方 GitHub Releases 源".to_string(),
            index_url,
            built_in: true,
        }]
    }

    /// 从启用的源获取商店插件列表
    ///
    /// - `source_id=None`：从所有启用的源获取
    /// - `source_id=Some(id)`：只从指定源获取（若源不存在/未启用，则返回空列表）
    pub async fn fetch_store_plugins(
        &self,
        source_id: Option<&str>,
    ) -> Result<Vec<StorePluginResolved>, String> {
        let sources = self.load_plugin_sources()?;
        let enabled_sources: Vec<_> = sources
            .into_iter()
            .filter(|s| source_id.map(|id| id == s.id).unwrap_or(true))
            .collect();

        if enabled_sources.is_empty() {
            return Ok(vec![]);
        }

        let mut all_plugins = Vec::new();
        let mut errors = Vec::new();

        for source in enabled_sources {
            match self.fetch_plugins_from_source(&source).await {
                Ok(mut plugins) => all_plugins.append(&mut plugins),
                Err(e) => {
                    let error_msg = format!("源 '{}' 加载失败: {}", source.name, e);
                    eprintln!("{}", error_msg);
                    errors.push(error_msg);
                    // 继续处理其他源，不中断整个流程
                }
            }
        }

        // 如果指定了单一源且失败，返回该源的错误（便于前端提示“当前源不可用”）
        if source_id.is_some() && all_plugins.is_empty() && !errors.is_empty() {
            return Err(errors.join("\n"));
        }

        // 如果所有源都失败，返回错误
        if source_id.is_none() && all_plugins.is_empty() && !errors.is_empty() {
            return Err(format!("所有商店源加载失败：\n{}", errors.join("\n")));
        }

        // 检查已安装的插件版本
        let installed_plugins = self.get_all()?;
        for plugin in &mut all_plugins {
            if installed_plugins.iter().any(|p| p.id == plugin.id) {
                // 从已安装的插件文件中读取版本
                if let Ok(manifest) = self
                    .find_plugin_file(&self.get_plugins_directory(), &plugin.id)
                    .and_then(|path| self.read_plugin_manifest(&path))
                {
                    plugin.installed_version = Some(manifest.version);
                }
            }
        }

        // 如果有部分源失败，但仍然有成功的源，返回成功但记录错误（通过日志）
        if !errors.is_empty() {
            eprintln!(
                "部分商店源加载失败，但仍有可用插件：\n{}",
                errors.join("\n")
            );
        }

        Ok(all_plugins)
    }

    /// 从单个源获取插件列表
    async fn fetch_plugins_from_source(
        &self,
        source: &PluginSource,
    ) -> Result<Vec<StorePluginResolved>, String> {
        let client = reqwest::Client::new();
        let response = client
            .get(&source.index_url)
            .send()
            .await
            .map_err(|e| format!("Failed to fetch plugin index: {}", e))?;

        if !response.status().is_success() {
            return Err(format!(
                "Failed to fetch plugin index: HTTP {}",
                response.status()
            ));
        }

        let json: serde_json::Value = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse plugin index JSON: {}", e))?;

        // 解析 JSON 格式：期望是一个包含 "plugins" 数组的对象
        let plugins_array = json
            .get("plugins")
            .and_then(|v| v.as_array())
            .ok_or_else(|| "Invalid plugin index format: missing 'plugins' array".to_string())?;

        let mut resolved_plugins = Vec::new();

        for plugin_json in plugins_array {
            if let Ok(plugin) = self.parse_store_plugin(plugin_json, &source.id, &source.name) {
                resolved_plugins.push(plugin);
            }
        }

        Ok(resolved_plugins)
    }

    /// 验证一个 index.json URL 是否可获取并可解析（严格校验每个插件条目字段）
    pub async fn validate_store_source_index(
        &self,
        index_url: &str,
    ) -> Result<StoreSourceValidationResult, String> {
        let client = reqwest::Client::new();
        let response = client
            .get(index_url)
            .send()
            .await
            .map_err(|e| format!("Failed to fetch plugin index: {}", e))?;

        if !response.status().is_success() {
            return Err(format!(
                "Failed to fetch plugin index: HTTP {}",
                response.status()
            ));
        }

        let json: serde_json::Value = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse plugin index JSON: {}", e))?;

        let plugins_array = json
            .get("plugins")
            .and_then(|v| v.as_array())
            .ok_or_else(|| "Invalid plugin index format: missing 'plugins' array".to_string())?;

        // 严格验证：任何条目字段缺失都算错误（前端会弹窗让用户决定是否仍然添加）
        let mut errors: Vec<String> = Vec::new();
        for (idx, plugin_json) in plugins_array.iter().enumerate() {
            if let Err(e) = self.parse_store_plugin(plugin_json, "_validate", "_validate") {
                // 只收集前几个，避免错误过长
                if errors.len() < 3 {
                    errors.push(format!("#{}: {}", idx, e));
                }
            }
        }

        if !errors.is_empty() {
            return Err(format!(
                "index.json 已获取，但存在不合法的插件条目（示例）：\n{}",
                errors.join("\n")
            ));
        }

        Ok(StoreSourceValidationResult {
            plugin_count: plugins_array.len(),
        })
    }

    /// 解析单个商店插件 JSON
    fn parse_store_plugin(
        &self,
        plugin_json: &serde_json::Value,
        source_id: &str,
        source_name: &str,
    ) -> Result<StorePluginResolved, String> {
        let id = plugin_json
            .get("id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "Missing 'id' field".to_string())?
            .to_string();

        let name = plugin_json
            .get("name")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "Missing 'name' field".to_string())?
            .to_string();

        let version = plugin_json
            .get("version")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "Missing 'version' field".to_string())?
            .to_string();

        let description = plugin_json
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let download_url = plugin_json
            .get("downloadUrl")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "Missing 'downloadUrl' field".to_string())?
            .to_string();

        let icon_url = plugin_json
            .get("iconUrl")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let sha256 = plugin_json
            .get("sha256")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let size_bytes = plugin_json
            .get("sizeBytes")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);

        Ok(StorePluginResolved {
            id,
            name,
            version,
            description,
            download_url,
            icon_url,
            sha256,
            size_bytes,
            source_id: source_id.to_string(),
            source_name: source_name.to_string(),
            installed_version: None,
        })
    }

    /// 下载插件到临时文件
    pub async fn download_plugin_to_temp(
        &self,
        download_url: &str,
        expected_sha256: Option<&str>,
        expected_size: Option<u64>,
    ) -> Result<PathBuf, String> {
        let client = reqwest::Client::new();
        let response = client
            .get(download_url)
            .send()
            .await
            .map_err(|e| format!("Failed to download plugin: {}", e))?;

        if !response.status().is_success() {
            return Err(format!(
                "Failed to download plugin: HTTP {}",
                response.status()
            ));
        }

        // 检查大小（如果提供）
        if let Some(expected) = expected_size {
            if let Some(content_length) = response.content_length() {
                if content_length != expected {
                    return Err(format!(
                        "Size mismatch: expected {}, got {}",
                        expected, content_length
                    ));
                }
            }
        }

        // 创建临时文件
        let temp_dir = std::env::temp_dir();
        let temp_file = temp_dir.join(format!("plugin_{}.kgpg", Uuid::new_v4()));

        // 下载并写入文件
        let bytes = response
            .bytes()
            .await
            .map_err(|e| format!("Failed to read plugin data: {}", e))?;

        // 验证 SHA256（如果提供）
        if let Some(expected) = expected_sha256 {
            let mut hasher = Sha256::new();
            hasher.update(&bytes);
            let hash = format!("{:x}", hasher.finalize());
            if hash != expected {
                return Err(format!(
                    "SHA256 mismatch: expected {}, got {}",
                    expected, hash
                ));
            }
        }

        // 写入文件
        let mut file = fs::File::create(&temp_file)
            .map_err(|e| format!("Failed to create temp file: {}", e))?;
        file.write_all(&bytes)
            .map_err(|e| format!("Failed to write temp file: {}", e))?;

        Ok(temp_file)
    }

    async fn download_plugin_bytes(
        &self,
        download_url: &str,
        expected_sha256: Option<&str>,
        expected_size: Option<u64>,
    ) -> Result<Vec<u8>, String> {
        let client = reqwest::Client::new();
        let response = client
            .get(download_url)
            .send()
            .await
            .map_err(|e| format!("Failed to download plugin: {}", e))?;

        if !response.status().is_success() {
            return Err(format!(
                "Failed to download plugin: HTTP {}",
                response.status()
            ));
        }

        // 检查大小（如果提供）
        if let Some(expected) = expected_size {
            if let Some(content_length) = response.content_length() {
                if content_length != expected {
                    return Err(format!(
                        "Size mismatch: expected {}, got {}",
                        expected, content_length
                    ));
                }
            }
        }

        let bytes = response
            .bytes()
            .await
            .map_err(|e| format!("Failed to read plugin data: {}", e))?;

        // 验证 SHA256（如果提供）
        if let Some(expected) = expected_sha256 {
            let mut hasher = Sha256::new();
            hasher.update(&bytes);
            let hash = format!("{:x}", hasher.finalize());
            if hash != expected {
                return Err(format!(
                    "SHA256 mismatch: expected {}, got {}",
                    expected, hash
                ));
            }
        }

        Ok(bytes.to_vec())
    }

    fn remote_zip_cache_get_locked(
        cache: &mut HashMap<String, RemoteZipCacheEntry>,
        key: &str,
    ) -> Option<Arc<Vec<u8>>> {
        let now = Instant::now();
        let ttl = Duration::from_secs(10 * 60);
        if let Some(entry) = cache.get(key) {
            if now.duration_since(entry.inserted_at) <= ttl {
                return Some(entry.bytes.clone());
            }
        }
        cache.remove(key);
        None
    }

    fn remote_zip_cache_insert_locked(
        cache: &mut HashMap<String, RemoteZipCacheEntry>,
        key: String,
        bytes: Arc<Vec<u8>>,
    ) {
        // 清理过期
        let now = Instant::now();
        let ttl = Duration::from_secs(10 * 60);
        cache.retain(|_, v| now.duration_since(v.inserted_at) <= ttl);

        cache.insert(
            key,
            RemoteZipCacheEntry {
                inserted_at: Instant::now(),
                bytes,
            },
        );

        // 简单容量控制：最多保留 6 个，超出就按最老淘汰
        const MAX: usize = 6;
        if cache.len() > MAX {
            let mut items: Vec<_> = cache
                .iter()
                .map(|(k, v)| (k.clone(), v.inserted_at))
                .collect();
            items.sort_by_key(|(_, t)| *t);
            while cache.len() > MAX {
                if let Some((oldest_key, _)) = items.first().cloned() {
                    cache.remove(&oldest_key);
                    items.remove(0);
                } else {
                    break;
                }
            }
        }
    }

    pub async fn get_remote_zip_bytes_cached(
        &self,
        download_url: &str,
        expected_sha256: Option<&str>,
        expected_size: Option<u64>,
    ) -> Result<Arc<Vec<u8>>, String> {
        let key = download_url.to_string();

        if let Ok(mut cache) = self.remote_zip_cache.lock() {
            if let Some(hit) = Self::remote_zip_cache_get_locked(&mut cache, &key) {
                return Ok(hit);
            }
        }

        let bytes = self
            .download_plugin_bytes(download_url, expected_sha256, expected_size)
            .await?;
        let arc = Arc::new(bytes);

        if let Ok(mut cache) = self.remote_zip_cache.lock() {
            Self::remote_zip_cache_insert_locked(&mut cache, key, arc.clone());
        }

        Ok(arc)
    }

    pub fn load_installed_plugin_detail(&self, plugin_id: &str) -> Result<PluginDetail, String> {
        let plugins_dir = self.get_plugins_directory();
        let path = self.find_plugin_file(&plugins_dir, plugin_id)?;

        let manifest = self.read_plugin_manifest(&path)?;
        let doc = self.read_plugin_doc(&path).ok().flatten();
        let icon_data = self.read_plugin_icon(&path).ok().flatten();

        Ok(PluginDetail {
            id: plugin_id.to_string(),
            name: manifest.name,
            desp: manifest.description,
            doc,
            icon_data,
            origin: "installed".to_string(),
        })
    }

    pub async fn load_remote_plugin_detail(
        &self,
        plugin_id: &str,
        download_url: &str,
        expected_sha256: Option<&str>,
        expected_size: Option<u64>,
    ) -> Result<PluginDetail, String> {
        let bytes = self
            .get_remote_zip_bytes_cached(download_url, expected_sha256, expected_size)
            .await?;

        let cursor = std::io::Cursor::new(bytes.as_slice());
        let mut archive =
            ZipArchive::new(cursor).map_err(|e| format!("Failed to open ZIP archive: {}", e))?;

        // 读取 manifest.json（用单独作用域结束对 archive 的可变借用，避免后续再次 by_name 报错）
        let manifest: PluginManifest = {
            let mut manifest_file = archive
                .by_name("manifest.json")
                .map_err(|_| "manifest.json not found in plugin archive".to_string())?;
            let mut manifest_content = String::new();
            manifest_file
                .read_to_string(&mut manifest_content)
                .map_err(|e| format!("Failed to read manifest.json: {}", e))?;
            serde_json::from_str(&manifest_content)
                .map_err(|e| format!("Failed to parse manifest.json: {}", e))?
        };

        // 读取 doc.md（可选）
        let doc_paths = ["doc_root/doc.md", "doc.md"];
        let mut doc_path_found = None;
        for doc_path in &doc_paths {
            if archive.by_name(doc_path).is_ok() {
                doc_path_found = Some(*doc_path);
                break;
            }
        }
        let doc = match doc_path_found {
            Some(p) => {
                let mut doc_file = archive
                    .by_name(p)
                    .map_err(|_| "doc.md not found".to_string())?;
                let mut content = String::new();
                doc_file
                    .read_to_string(&mut content)
                    .map_err(|e| format!("Failed to read doc.md: {}", e))?;
                Some(content)
            }
            None => None,
        };

        // 读取 icon.png（可选）
        let icon_data = match archive.by_name("icon.png") {
            Ok(mut f) => {
                let mut data = Vec::new();
                f.read_to_end(&mut data)
                    .map_err(|e| format!("Failed to read icon.png: {}", e))?;
                Some(data)
            }
            Err(_) => None,
        };

        Ok(PluginDetail {
            id: plugin_id.to_string(),
            name: manifest.name,
            desp: manifest.description,
            doc,
            icon_data,
            origin: "remote".to_string(),
        })
    }

    pub async fn load_plugin_image_for_detail(
        &self,
        plugin_id: &str,
        download_url: Option<&str>,
        expected_sha256: Option<&str>,
        expected_size: Option<u64>,
        image_path: &str,
    ) -> Result<Vec<u8>, String> {
        match download_url {
            Some(url) => {
                let bytes = self
                    .get_remote_zip_bytes_cached(url, expected_sha256, expected_size)
                    .await?;
                let cursor = std::io::Cursor::new(bytes.as_slice());
                let mut archive = ZipArchive::new(cursor)
                    .map_err(|e| format!("Failed to open ZIP archive: {}", e))?;

                // 复用与本地一致的路径规范化与安全检查
                let mut normalized_path = image_path.trim().to_string();
                if normalized_path.starts_with('/') || normalized_path.starts_with("\\") {
                    return Err("Absolute paths are not allowed".to_string());
                }
                normalized_path = normalized_path
                    .replace("%20", " ")
                    .replace("%28", "(")
                    .replace("%29", ")")
                    .replace("%2F", "/")
                    .replace("%5C", "\\")
                    .replace("%2E", ".");
                if normalized_path.contains("../")
                    || normalized_path.contains("..\\")
                    || normalized_path.contains("..%2F")
                    || normalized_path.contains("..%5C")
                    || normalized_path.starts_with("..")
                {
                    return Err("Path traversal attacks are not allowed".to_string());
                }
                if normalized_path.starts_with("./") {
                    normalized_path = normalized_path[2..].to_string();
                }
                if normalized_path.starts_with("doc_root/") {
                    normalized_path = normalized_path[9..].to_string();
                }
                normalized_path = normalized_path.replace('\\', "/");
                if normalized_path.contains("../") || normalized_path.starts_with("..") {
                    return Err("Path traversal detected after normalization".to_string());
                }
                if normalized_path.is_empty() {
                    return Err("Empty image path is not allowed".to_string());
                }
                if normalized_path.chars().any(|c| c.is_control()) {
                    return Err("Control characters in path are not allowed".to_string());
                }
                let final_path = format!("doc_root/{}", normalized_path);
                if final_path.contains("../") || final_path.starts_with("../") {
                    return Err("Final path validation failed".to_string());
                }

                let mut image_file = archive.by_name(&final_path).map_err(|e| {
                    format!(
                        "Image {} not found in plugin archive. Error: {:?}",
                        final_path, e
                    )
                })?;
                let mut image_data = Vec::new();
                image_file
                    .read_to_end(&mut image_data)
                    .map_err(|e| format!("Failed to read image: {}", e))?;
                Ok(image_data)
            }
            None => {
                let plugins_dir = self.get_plugins_directory();
                let path = self.find_plugin_file(&plugins_dir, plugin_id)?;
                self.read_plugin_image(&path, image_path)
            }
        }
    }

    /// 预览导入插件（从 ZIP 文件读取信息）
    pub fn preview_import_from_zip(&self, zip_path: &Path) -> Result<ImportPreview, String> {
        let manifest = self.read_plugin_manifest(zip_path)?;

        // 获取文件大小
        let size_bytes = fs::metadata(zip_path)
            .map_err(|e| format!("Failed to get file metadata: {}", e))?
            .len();

        // 检查是否已存在
        let file_name = zip_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let plugin_id = file_name.clone();

        let already_exists = self.get(&plugin_id).is_some();

        // local 模式：禁止导入同 ID（包含内置/用户插件）
        if already_exists && is_local_mode() {
            return Err(
                "检测到同 ID 插件已存在，本版本禁止覆盖导入。请切换应用程序版本获取该插件的对应更新。"
                    .to_string(),
            );
        }

        let existing_version = if already_exists {
            // 从已安装的插件文件中读取版本
            if let Ok(existing_manifest) = self
                .find_plugin_file(&self.get_plugins_directory(), &plugin_id)
                .and_then(|path| self.read_plugin_manifest(&path))
            {
                Some(existing_manifest.version)
            } else {
                None
            }
        } else {
            None
        };

        // TODO: 实现变更日志差异比较
        let change_log_diff = None;

        Ok(ImportPreview {
            id: plugin_id,
            name: manifest.name,
            version: manifest.version,
            size_bytes,
            already_exists,
            existing_version,
            change_log_diff,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrowserPlugin {
    pub id: String,
    pub name: String,
    pub desp: String,
    pub icon: Option<String>,
    pub favorite: bool,
    pub file_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doc: Option<String>,
}

// 插件清单（manifest.json）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginManifest {
    pub name: String,
    pub version: String,
    pub description: String,
    pub author: String,
}

// 变量定义（config.json 中的 var 字段，现在是数组格式）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(untagged)]
pub enum VarOption {
    /// 兼容旧格式：["high","medium"]
    String(String),
    /// 推荐格式：[{ "name": "...", "variable": "..." }]
    Item { name: String, variable: String },
}

// 变量定义（config.json 中的 var 字段，现在是数组格式）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VarDefinition {
    pub key: String, // 变量名（用于在脚本中引用）
    #[serde(rename = "type")]
    pub var_type: String, // "int", "float", "options", "boolean", "list"
    pub name: String, // 展示给用户的名称
    #[serde(default)]
    pub descripts: Option<String>, // 描述（注意：用户写的是 descripts，不是 description）
    #[serde(default)]
    pub default: Option<serde_json::Value>, // 默认值
    #[serde(default)]
    pub options: Option<Vec<VarOption>>, // options/checkbox: 支持 string[] 或 {name,variable}[]
    #[serde(default)]
    pub min: Option<serde_json::Value>, // 最小值（int/float 类型使用）
    #[serde(default)]
    pub max: Option<serde_json::Value>, // 最大值（int/float 类型使用）
}

// 插件配置（config.json）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginConfig {
    #[serde(rename = "baseUrl")]
    pub base_url: String,
    // 注意：selector 字段已废弃，选择器现在在 crawl.rhai 脚本中定义
    // 保留此字段仅用于向后兼容，新插件不应使用
    #[serde(default)]
    pub selector: Option<PluginSelector>,
    // 变量定义（可选，数组格式以保持顺序）
    #[serde(default)]
    pub var: Option<Vec<VarDefinition>>,
}

// 插件源（商店源）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSource {
    pub id: String,
    pub name: String,
    #[serde(rename = "indexUrl")]
    pub index_url: String,
    /// 是否为内置官方源（不可删除）
    #[serde(default)]
    pub built_in: bool,
}

// 商店插件（从源解析后的插件信息）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorePluginResolved {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    #[serde(rename = "downloadUrl")]
    pub download_url: String,
    /// 可选：商店列表图标（通常指向 GitHub Release 的 <id>.icon.png）
    #[serde(default)]
    pub icon_url: Option<String>,
    pub sha256: Option<String>,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
    #[serde(rename = "sourceId")]
    pub source_id: String,
    #[serde(rename = "sourceName")]
    pub source_name: String,
    #[serde(rename = "installedVersion")]
    pub installed_version: Option<String>,
}

/// 商店源可用性验证结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreSourceValidationResult {
    pub plugin_count: usize,
}

// 导入预览
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
    #[serde(rename = "alreadyExists")]
    pub already_exists: bool,
    #[serde(rename = "existingVersion")]
    pub existing_version: Option<String>,
    #[serde(rename = "changeLogDiff")]
    pub change_log_diff: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDetail {
    pub id: String,
    pub name: String,
    pub desp: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doc: Option<String>,
    #[serde(rename = "iconData", skip_serializing_if = "Option::is_none")]
    pub icon_data: Option<Vec<u8>>,
    /// installed | remote
    pub origin: String,
}

#[derive(Debug, Clone)]
struct RemoteZipCacheEntry {
    inserted_at: Instant,
    bytes: Arc<Vec<u8>>,
}
