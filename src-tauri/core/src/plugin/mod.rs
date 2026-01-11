use reqwest;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use uuid::Uuid;
use zip::ZipArchive;

// Rhai 爬虫运行时/脚本执行（原先位于 crawler/rhai.rs）
pub mod rhai;

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
    installed_cache: Mutex<InstalledPluginsCache>,
}

#[derive(Debug, Clone, Copy)]
struct FileStamp {
    len: u64,
    modified: Option<SystemTime>,
}

impl FileStamp {
    fn from_path(path: &Path) -> Result<Self, String> {
        let meta = fs::metadata(path).map_err(|e| format!("读取插件文件 metadata 失败: {}", e))?;
        Ok(Self {
            len: meta.len(),
            modified: meta.modified().ok(),
        })
    }
}

#[derive(Debug, Clone)]
struct KgpgFileCacheEntry {
    stamp: FileStamp,
    manifest: PluginManifest,
    config: Option<PluginConfig>,
    doc: Option<String>,
    icon_present: bool,
    /// 懒加载：只有真正请求 icon bytes 时才读取并缓存（避免刷新/初始化时读大量二进制）
    icon_png_bytes: Option<Option<Vec<u8>>>,
}

#[derive(Default)]
struct InstalledPluginsCache {
    initialized: bool,
    plugins_dir: PathBuf,
    by_id: HashMap<String, PathBuf>,
    plugins: HashMap<String, Plugin>,
    files: HashMap<PathBuf, KgpgFileCacheEntry>,
}

struct ParsedKgpgForCache {
    manifest: PluginManifest,
    config: Option<PluginConfig>,
    doc: Option<String>,
    icon_present: bool,
}

impl PluginManager {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            remote_zip_cache: Mutex::new(HashMap::new()),
            builtins_cache: Mutex::new(None),
            installed_cache: Mutex::new(InstalledPluginsCache::default()),
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

        // 生产模式：尝试多个位置查找 resources/plugins
        // 1. 首先尝试使用 Tauri resource_dir
        if let Ok(resource_dir) = self.app.path().resource_dir() {
            let dir = resource_dir.join("plugins");
            if dir.exists() {
                return Ok(dir);
            }
        }

        // 2. 如果 resource_dir 不存在或目录不存在，尝试从可执行文件目录查找
        // 在 Windows 安装包中，resources 可能在可执行文件目录下
        if let Ok(exe_path) = std::env::current_exe() {
            if let Some(exe_dir) = exe_path.parent() {
                // 尝试 exe_dir/resources/plugins
                let dir = exe_dir.join("resources").join("plugins");
                if dir.exists() {
                    return Ok(dir);
                }
                // 尝试 exe_dir/../resources/plugins（如果是子目录结构）
                if let Some(parent_dir) = exe_dir.parent() {
                    let dir = parent_dir.join("resources").join("plugins");
                    if dir.exists() {
                        return Ok(dir);
                    }
                }
            }
        }

        // 如果都找不到，尝试使用 resource_dir 的默认路径（即使目录可能不存在）
        // 这样可以让调用方得到更有意义的错误信息
        let default_dir = self
            .app
            .path()
            .resource_dir()
            .map_err(|e| format!("Failed to resolve resource_dir: {}", e))?
            .join("plugins");

        Err(format!(
            "无法找到预打包插件目录。已尝试以下位置：\n  - {}\n  - 可执行文件目录下的 resources/plugins\n请确认插件文件已正确打包到 resources/plugins 目录",
            default_dir.display()
        ))
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
        self.ensure_installed_cache_initialized()?;
        let guard = self
            .installed_cache
            .lock()
            .map_err(|_| "插件缓存锁已中毒".to_string())?;
        let mut plugins: Vec<Plugin> = guard.plugins.values().cloned().collect();
        plugins.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(plugins)
    }

    pub fn get(&self, id: &str) -> Option<Plugin> {
        self.ensure_installed_cache_initialized().ok()?;
        let guard = self.installed_cache.lock().ok()?;
        guard.plugins.get(id).cloned()
    }

    /// 从指定 `.kgpg` 文件解析出运行时需要的 `Plugin` 信息（用于 CLI/调度器/插件编辑器临时运行）。
    ///
    /// 注意：
    /// - `built_in/config` 等运行时字段由调用方策略决定；这里按“可运行”默认值填充。
    /// - `plugin_id` 允许由调用方指定（例如调度器的 task request 里传入的 id），
    ///   CLI 场景一般会用文件名 stem 作为 id。
    pub fn build_runtime_plugin_from_kgpg_path(
        &self,
        plugin_id: String,
        kgpg_path: &Path,
    ) -> Result<Plugin, String> {
        if !kgpg_path.is_file() {
            return Err(format!("插件文件不存在: {}", kgpg_path.display()));
        }
        if kgpg_path.extension().and_then(|s| s.to_str()) != Some("kgpg") {
            return Err(format!("不是 .kgpg 文件: {}", kgpg_path.display()));
        }

        let manifest = self.read_plugin_manifest(kgpg_path)?;
        let config = self.read_plugin_config_public(kgpg_path).ok().flatten();
        let size_bytes = fs::metadata(kgpg_path)
            .map_err(|e| format!("读取插件文件大小失败: {}", e))?
            .len();

        Ok(Plugin {
            id: plugin_id,
            name: manifest.name,
            description: manifest.description,
            version: manifest.version,
            base_url: config
                .as_ref()
                .and_then(|c| c.base_url.clone())
                .unwrap_or_default(),
            size_bytes,
            built_in: false,
            config: HashMap::new(),
            selector: config.and_then(|c| c.selector),
        })
    }

    /// CLI 场景：支持传入插件 id（已安装）或 `.kgpg` 路径（临时运行）。
    /// 返回：
    /// - `Plugin`
    /// - `plugin_file_path`：若为临时运行则为 Some(path)，已安装则为 None
    /// - `var_defs`：用于 CLI 参数解析（来源于插件文件或已安装插件的 config.json var）
    #[allow(dead_code)] // 仅被 sidecar/CLI bin 调用；主程序二进制未直接使用
    pub fn resolve_plugin_for_cli_run(
        &self,
        id_or_path: &str,
    ) -> Result<(Plugin, Option<PathBuf>, Vec<VarDefinition>), String> {
        let p = PathBuf::from(id_or_path);
        if p.is_file() && p.extension().and_then(|s| s.to_str()) == Some("kgpg") {
            let id = p
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("plugin")
                .to_string();
            let plugin = self.build_runtime_plugin_from_kgpg_path(id, &p)?;
            let var_defs = self.get_plugin_vars_from_file(&p)?;
            return Ok((plugin, Some(p), var_defs));
        }

        // id 模式（已安装）
        let plugin = self
            .get(id_or_path)
            .ok_or_else(|| format!("插件未找到：{}", id_or_path))?;
        let var_defs = self.get_plugin_vars(id_or_path)?.unwrap_or_default();
        Ok((plugin, None, var_defs))
    }

    /// 调度器/任务场景：支持“已安装插件（plugin_id）”或“指定 `.kgpg` 文件临时运行”。
    /// 这里允许 `plugin_id` 由上层指定（DB/task 里存的 id），以保持历史行为一致。
    pub fn resolve_plugin_for_task_request(
        &self,
        plugin_id: &str,
        plugin_file_path: Option<&str>,
    ) -> Result<(Plugin, Option<PathBuf>), String> {
        if let Some(p) = plugin_file_path {
            let path = PathBuf::from(p);
            let plugin = self.build_runtime_plugin_from_kgpg_path(plugin_id.to_string(), &path)?;
            return Ok((plugin, Some(path)));
        }
        let plugin = self
            .get(plugin_id)
            .ok_or_else(|| format!("Plugin {} not found", plugin_id))?;
        Ok((plugin, None))
    }

    /// 删除插件（删除对应的 .kgpg 文件）
    pub fn delete(&self, id: &str) -> Result<(), String> {
        // 内置插件不可卸载（仅 local 模式；normal 模式允许用户覆盖/卸载）
        if is_immutable_builtin_id(&self.builtins(), id) {
            return Err("该插件为内置插件，禁止卸载。请切换应用程序版本。".to_string());
        }

        let plugins_dir = self.get_plugins_directory();
        let path = self.find_plugin_file(&plugins_dir, id)?;
        fs::remove_file(&path).map_err(|e| format!("Failed to delete plugin file: {}", e))?;
        // 删除后局部刷新缓存（避免前端仍看到旧列表/旧图标）
        let _ = self.refresh_installed_plugin_cache(id);
        Ok(())
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

    pub fn load_browser_plugins(&self) -> Result<Vec<BrowserPlugin>, String> {
        self.ensure_installed_cache_initialized()?;
        let guard = self
            .installed_cache
            .lock()
            .map_err(|_| "插件缓存锁已中毒".to_string())?;

        let mut ids: Vec<_> = guard.by_id.keys().cloned().collect();
        ids.sort();

        let mut browser_plugins = Vec::with_capacity(ids.len());
        for id in ids {
            let Some(path) = guard.by_id.get(&id) else {
                continue;
            };
            let Some(file) = guard.files.get(path) else {
                continue;
            };

            let icon_path = if file.icon_present {
                Some(path.to_string_lossy().to_string())
            } else {
                None
            };

            browser_plugins.push(BrowserPlugin {
                id: id.clone(),
                name: file.manifest.name.clone(),
                desp: file.manifest.description.clone(),
                icon: icon_path,
                file_path: Some(path.to_string_lossy().to_string()),
                doc: file.doc.clone(),
            });
        }

        Ok(browser_plugins)
    }

    /// 从 ZIP 格式的插件文件中读取 manifest.json
    pub fn read_plugin_manifest(&self, zip_path: &Path) -> Result<PluginManifest, String> {
        // 优先尝试：KGPG v2 固定头部（无需解析 zip）
        if let Ok(Some(s)) = crate::kgpg::read_kgpg2_manifest_json_from_file(zip_path) {
            if !s.trim().is_empty() {
                if let Ok(m) = serde_json::from_str::<PluginManifest>(&s) {
                    return Ok(m);
                }
            }
        }

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

    /// 从 ZIP 格式的插件文件中读取 doc_root/doc.md（供 app-cli/外部调用复用）
    pub fn read_plugin_doc_public(&self, zip_path: &Path) -> Result<Option<String>, String> {
        self.read_plugin_doc(zip_path)
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

    /// 从 ZIP 格式的插件文件中读取 config.json（供 CLI/外部调用复用）
    pub fn read_plugin_config_public(
        &self,
        zip_path: &Path,
    ) -> Result<Option<PluginConfig>, String> {
        self.read_plugin_config(zip_path)
    }

    /// 从任意 .kgpg 文件读取变量定义（config.json 的 var），不存在则返回空数组。
    pub fn get_plugin_vars_from_file(&self, zip_path: &Path) -> Result<Vec<VarDefinition>, String> {
        Ok(self
            .read_plugin_config(zip_path)?
            .and_then(|c| c.var)
            .unwrap_or_default())
    }

    /// 从 ZIP 格式的插件文件中读取 icon.png
    pub fn read_plugin_icon(&self, zip_path: &Path) -> Result<Option<Vec<u8>>, String> {
        // v2：优先读取头部固定 icon（RGB24 raw），并转换为 PNG bytes（前端保持不变）
        if let Ok(Some(rgb)) = crate::kgpg::read_kgpg2_icon_rgb_from_file(zip_path) {
            if rgb.len() == crate::kgpg::KGPG2_ICON_SIZE {
                use image::{ImageOutputFormat, RgbImage};
                let img =
                    RgbImage::from_raw(crate::kgpg::KGPG2_ICON_W, crate::kgpg::KGPG2_ICON_H, rgb)
                        .ok_or_else(|| "Invalid kgpg2 icon buffer".to_string())?;
                let mut out: Vec<u8> = Vec::new();
                let mut cursor = std::io::Cursor::new(&mut out);
                img.write_to(&mut cursor, ImageOutputFormat::Png)
                    .map_err(|e| format!("Failed to encode icon png: {}", e))?;
                return Ok(Some(out));
            }
        }

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

    /// 根据插件 ID 查找并读取插件图标
    /// 返回 PNG bytes，如果插件不存在或没有图标则返回错误或 None
    pub fn get_plugin_icon_by_id(&self, plugin_id: &str) -> Result<Option<Vec<u8>>, String> {
        self.ensure_installed_cache_initialized()?;
        let plugins_dir = self.get_plugins_directory();
        let path = self.find_plugin_file(&plugins_dir, plugin_id)?;

        // 先尝试缓存命中（不在持锁时做 IO）
        if let Ok(mut guard) = self.installed_cache.lock() {
            if let Some(entry) = guard.files.get_mut(&path) {
                let cur = FileStamp::from_path(&path)?;
                if entry.stamp.len == cur.len && entry.stamp.modified == cur.modified {
                    if let Some(cached) = entry.icon_png_bytes.clone() {
                        return Ok(cached);
                    }
                } else {
                    // 文件变化：清空 icon bytes 缓存，避免返回旧图标
                    entry.stamp = cur;
                    entry.icon_png_bytes = None;
                }
            }
        }

        let icon = self.read_plugin_icon(&path).ok().flatten();
        if let Ok(mut guard) = self.installed_cache.lock() {
            if let Some(entry) = guard.files.get_mut(&path) {
                entry.icon_png_bytes = Some(icon.clone());
            }
        }
        Ok(icon)
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
                .and_then(|c| c.base_url.clone())
                .unwrap_or_default(),
            size_bytes,
            built_in: is_immutable_builtin_id(&self.builtins(), &plugin_id),
            config: HashMap::new(),
            selector: config.and_then(|c| c.selector),
        };

        // 安装/覆盖后：局部刷新缓存，避免后续命令重复扫目录/读盘
        let _ = self.refresh_installed_plugin_cache(&plugin_id);
        Ok(plugin)
    }

    /// 安装浏览器插件（从插件目录中的 .kgpg 文件安装）
    /// 实际上，如果文件已经在插件目录中，就已经是"已安装"状态了
    /// 这个方法主要用于标记插件为已安装（如果之前未安装的话）
    pub fn install_browser_plugin(&self, plugin_id: String) -> Result<Plugin, String> {
        // 这个方法在历史上用于“标记安装”，但实际插件文件已在目录里即视为安装。
        // 这里直接复用缓存，避免扫目录/频繁读盘。
        self.ensure_installed_cache_initialized()?;
        let plugins_dir = self.get_plugins_directory();
        let _path = self.find_plugin_file(&plugins_dir, &plugin_id)?;

        let guard = self
            .installed_cache
            .lock()
            .map_err(|_| "插件缓存锁已中毒".to_string())?;
        let Some(p) = guard.plugins.get(&plugin_id) else {
            return Err(format!("Plugin {} not found", plugin_id));
        };

        // 保持旧行为：built_in=false（浏览器安装不参与“内置不可卸载”逻辑）
        let mut out = p.clone();
        out.built_in = false;
        Ok(out)
    }

    /// 获取插件的变量定义（从 config.json 中读取）
    pub fn get_plugin_vars(&self, plugin_id: &str) -> Result<Option<Vec<VarDefinition>>, String> {
        self.ensure_installed_cache_initialized()?;
        let plugins_dir = self.get_plugins_directory();
        let plugin_file = self.find_plugin_file(&plugins_dir, plugin_id)?;
        let guard = self
            .installed_cache
            .lock()
            .map_err(|_| "插件缓存锁已中毒".to_string())?;
        let Some(file) = guard.files.get(&plugin_file) else {
            return Ok(None);
        };
        Ok(file.config.clone().and_then(|c| c.var))
    }

    /// 查找插件文件
    fn find_plugin_file(&self, plugins_dir: &Path, plugin_id: &str) -> Result<PathBuf, String> {
        // 先走缓存索引（避免每次都扫目录）
        self.ensure_installed_cache_initialized()?;
        if let Ok(guard) = self.installed_cache.lock() {
            if guard.plugins_dir == plugins_dir {
                if let Some(p) = guard.by_id.get(plugin_id) {
                    return Ok(p.clone());
                }
            }
        }

        // 缓存未命中：尝试局部刷新一次（兼容外部手动复制/替换文件的场景）
        let _ = self.refresh_installed_plugin_cache(plugin_id);
        if let Ok(guard) = self.installed_cache.lock() {
            if let Some(p) = guard.by_id.get(plugin_id) {
                return Ok(p.clone());
            }
        }

        // 最终兜底：扫目录（保持历史行为）
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

    /// 获取商店源 index.json 缓存目录
    fn get_store_cache_dir(&self) -> PathBuf {
        let data_dir = crate::app_paths::user_data_dir("Kabegame");
        data_dir.join("store-cache")
    }

    /// 获取特定商店源的缓存文件路径
    fn get_store_cache_file(&self, source_id: &str) -> PathBuf {
        self.get_store_cache_dir()
            .join(format!("{}.json", source_id))
    }

    /// 从本地缓存加载商店 index.json
    fn load_store_cache(&self, source_id: &str) -> Option<serde_json::Value> {
        let cache_file = self.get_store_cache_file(source_id);
        if !cache_file.exists() {
            return None;
        }
        let content = fs::read_to_string(&cache_file).ok()?;
        serde_json::from_str(&content).ok()
    }

    /// 保存商店 index.json 到本地缓存
    fn save_store_cache(&self, source_id: &str, json: &serde_json::Value) -> Result<(), String> {
        let cache_dir = self.get_store_cache_dir();
        fs::create_dir_all(&cache_dir)
            .map_err(|e| format!("Failed to create store cache directory: {}", e))?;
        let cache_file = self.get_store_cache_file(source_id);
        let content = serde_json::to_string_pretty(json)
            .map_err(|e| format!("Failed to serialize store cache: {}", e))?;
        fs::write(&cache_file, content)
            .map_err(|e| format!("Failed to write store cache: {}", e))?;
        Ok(())
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
    /// - `force_refresh`：是否强制从远程刷新（忽略本地缓存）
    pub async fn fetch_store_plugins(
        &self,
        source_id: Option<&str>,
        force_refresh: bool,
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
            match self
                .fetch_plugins_from_source_cached(&source, force_refresh)
                .await
            {
                Ok(mut plugins) => all_plugins.append(&mut plugins),
                Err(e) => {
                    let error_msg = format!("源 '{}' 加载失败: {}", source.name, e);
                    eprintln!("{}", error_msg);
                    errors.push(error_msg);
                    // 继续处理其他源，不中断整个流程
                }
            }
        }

        // 如果指定了单一源且失败，返回该源的错误（便于前端提示"当前源不可用"）
        if source_id.is_some() && all_plugins.is_empty() && !errors.is_empty() {
            return Err(errors.join("\n"));
        }

        // 如果所有源都失败，返回错误
        if source_id.is_none() && all_plugins.is_empty() && !errors.is_empty() {
            return Err(format!("所有商店源加载失败：\n{}", errors.join("\n")));
        }

        // 检查已安装的插件版本
        let installed_plugins = self.get_all()?;
        let installed_versions: HashMap<String, String> = installed_plugins
            .iter()
            .map(|p| (p.id.clone(), p.version.clone()))
            .collect();
        for plugin in &mut all_plugins {
            if let Some(v) = installed_versions.get(&plugin.id) {
                plugin.installed_version = Some(v.clone());
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

    /// 从单个源获取插件列表（带缓存支持）
    ///
    /// - `force_refresh=false`：优先使用本地缓存
    /// - `force_refresh=true`：强制从远程获取并更新缓存
    async fn fetch_plugins_from_source_cached(
        &self,
        source: &PluginSource,
        force_refresh: bool,
    ) -> Result<Vec<StorePluginResolved>, String> {
        // 如果不强制刷新，先尝试从缓存加载
        if !force_refresh {
            if let Some(cached_json) = self.load_store_cache(&source.id) {
                // 解析缓存的 JSON
                if let Some(plugins_array) = cached_json.get("plugins").and_then(|v| v.as_array()) {
                    let mut resolved_plugins = Vec::new();
                    for plugin_json in plugins_array {
                        if let Ok(plugin) =
                            self.parse_store_plugin(plugin_json, &source.id, &source.name)
                        {
                            resolved_plugins.push(plugin);
                        }
                    }
                    if !resolved_plugins.is_empty() {
                        println!(
                            "从缓存加载商店源 '{}' 的插件列表（{} 个插件）",
                            source.name,
                            resolved_plugins.len()
                        );
                        return Ok(resolved_plugins);
                    }
                }
            }
        }

        // 从远程获取
        let result = self.fetch_plugins_from_source(source).await;

        // 如果成功，更新缓存（即使是强制刷新）
        if result.is_ok() {
            // 重新从远程获取 JSON 并缓存（fetch_plugins_from_source 内部已解析，这里需要重新获取原始 JSON）
            // 为了避免重复请求，我们在 fetch_plugins_from_source 内部处理缓存
        }

        result
    }

    /// 从单个源获取插件列表（从远程获取并保存缓存）
    async fn fetch_plugins_from_source(
        &self,
        source: &PluginSource,
    ) -> Result<Vec<StorePluginResolved>, String> {
        let mut client_builder = reqwest::Client::builder();

        // 配置代理：自动从环境变量读取系统代理设置
        if let Ok(proxy_url) = std::env::var("HTTP_PROXY")
            .or_else(|_| std::env::var("http_proxy"))
            .or_else(|_| std::env::var("HTTPS_PROXY"))
            .or_else(|_| std::env::var("https_proxy"))
        {
            if !proxy_url.trim().is_empty() {
                match reqwest::Proxy::all(&proxy_url) {
                    Ok(proxy) => {
                        client_builder = client_builder.proxy(proxy);
                        println!("插件商店网络代理已配置: {}", proxy_url);
                    }
                    Err(e) => {
                        println!("插件商店代理配置无效 ({}), 将使用直连: {}", proxy_url, e);
                    }
                }
            }
        }

        let client = client_builder
            .timeout(Duration::from_secs(30))
            .connect_timeout(Duration::from_secs(10))
            .user_agent("Kabegame/1.0")
            .build()
            .map_err(|e| format!("Failed to create HTTP client: {}", e))?;
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

        // 保存到本地缓存（仅缓存 index.json，不阻塞返回）
        if let Err(e) = self.save_store_cache(&source.id, &json) {
            eprintln!("保存商店缓存失败 ({}): {}", source.name, e);
        } else {
            println!(
                "已缓存商店源 '{}' 的 index.json（{} 个插件）",
                source.name,
                resolved_plugins.len()
            );
        }

        Ok(resolved_plugins)
    }

    /// 验证一个 index.json URL 是否可获取并可解析（严格校验每个插件条目字段）
    pub async fn validate_store_source_index(
        &self,
        index_url: &str,
    ) -> Result<StoreSourceValidationResult, String> {
        let mut client_builder = reqwest::Client::builder();

        // 配置代理：自动从环境变量读取系统代理设置
        if let Ok(proxy_url) = std::env::var("HTTP_PROXY")
            .or_else(|_| std::env::var("http_proxy"))
            .or_else(|_| std::env::var("HTTPS_PROXY"))
            .or_else(|_| std::env::var("https_proxy"))
        {
            if !proxy_url.trim().is_empty() {
                match reqwest::Proxy::all(&proxy_url) {
                    Ok(proxy) => {
                        client_builder = client_builder.proxy(proxy);
                        println!("插件源验证网络代理已配置: {}", proxy_url);
                    }
                    Err(e) => {
                        println!("插件源验证代理配置无效 ({}), 将使用直连: {}", proxy_url, e);
                    }
                }
            }
        }

        let client = client_builder
            .timeout(Duration::from_secs(30))
            .connect_timeout(Duration::from_secs(10))
            .user_agent("Kabegame/1.0")
            .build()
            .map_err(|e| format!("Failed to create HTTP client: {}", e))?;
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

        // 包格式版本（可选）：默认 1；过高按最高支持版本解析
        let raw_pkg_ver = plugin_json
            .get("packageVersion")
            .and_then(|v| v.as_u64())
            .unwrap_or(1);
        let effective_pkg_ver: u16 = {
            // 当前最高支持版本：2
            const MAX: u64 = 2;
            let v = if raw_pkg_ver > MAX { MAX } else { raw_pkg_ver };
            if v < 1 {
                1
            } else {
                v as u16
            }
        };

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
            package_version: effective_pkg_ver,
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
        let mut client_builder = reqwest::Client::builder();

        // 配置代理：自动从环境变量读取系统代理设置
        if let Ok(proxy_url) = std::env::var("HTTP_PROXY")
            .or_else(|_| std::env::var("http_proxy"))
            .or_else(|_| std::env::var("HTTPS_PROXY"))
            .or_else(|_| std::env::var("https_proxy"))
        {
            if !proxy_url.trim().is_empty() {
                match reqwest::Proxy::all(&proxy_url) {
                    Ok(proxy) => {
                        client_builder = client_builder.proxy(proxy);
                        println!("插件下载网络代理已配置: {}", proxy_url);
                    }
                    Err(e) => {
                        println!("插件下载代理配置无效 ({}), 将使用直连: {}", proxy_url, e);
                    }
                }
            }
        }

        let client = client_builder
            .timeout(Duration::from_secs(60)) // 下载可能需要更长时间
            .connect_timeout(Duration::from_secs(10))
            .user_agent("Kabegame/1.0")
            .build()
            .map_err(|e| format!("Failed to create HTTP client: {}", e))?;
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

        // 创建临时文件：优先从 URL 提取文件名（保持插件 ID），回退到 UUID
        let temp_dir = std::env::temp_dir();
        let file_name = extract_kgpg_filename_from_url(download_url)
            .unwrap_or_else(|| format!("plugin_{}.kgpg", Uuid::new_v4()));
        let temp_file = temp_dir.join(&file_name);

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
        let mut client_builder = reqwest::Client::builder();

        // 配置代理：自动从环境变量读取系统代理设置
        if let Ok(proxy_url) = std::env::var("HTTP_PROXY")
            .or_else(|_| std::env::var("http_proxy"))
            .or_else(|_| std::env::var("HTTPS_PROXY"))
            .or_else(|_| std::env::var("https_proxy"))
        {
            if !proxy_url.trim().is_empty() {
                match reqwest::Proxy::all(&proxy_url) {
                    Ok(proxy) => {
                        client_builder = client_builder.proxy(proxy);
                        println!("插件字节下载网络代理已配置: {}", proxy_url);
                    }
                    Err(e) => {
                        println!(
                            "插件字节下载代理配置无效 ({}), 将使用直连: {}",
                            proxy_url, e
                        );
                    }
                }
            }
        }

        let client = client_builder
            .timeout(Duration::from_secs(60)) // 下载可能需要更长时间
            .connect_timeout(Duration::from_secs(10))
            .user_agent("Kabegame/1.0")
            .build()
            .map_err(|e| format!("Failed to create HTTP client: {}", e))?;
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

    /// KGPG v2：仅通过 HTTP Range 获取固定头部，并返回 icon（PNG bytes）。
    /// 用于商店列表展示，避免额外的 `<id>.icon.png` 资产。
    pub async fn fetch_remote_plugin_icon_v2(
        &self,
        download_url: &str,
    ) -> Result<Option<Vec<u8>>, String> {
        use reqwest::header::RANGE;

        let client = crate::crawler::create_client()?;
        let end = crate::kgpg::KGPG2_TOTAL_HEADER_SIZE.saturating_sub(1);
        let range_value = format!("bytes=0-{}", end);
        let resp = client
            .get(download_url)
            .header(RANGE, range_value)
            .send()
            .await
            .map_err(|e| format!("Failed to fetch kgpg header: {}", e))?;

        if !(resp.status().is_success() || resp.status().as_u16() == 206) {
            return Err(format!(
                "Failed to fetch kgpg header: HTTP {}",
                resp.status()
            ));
        }

        let bytes = resp
            .bytes()
            .await
            .map_err(|e| format!("Failed to read kgpg header bytes: {}", e))?;
        if bytes.len() < crate::kgpg::KGPG2_TOTAL_HEADER_SIZE {
            return Err(format!(
                "Invalid kgpg header size: got {} expected {}",
                bytes.len(),
                crate::kgpg::KGPG2_TOTAL_HEADER_SIZE
            ));
        }

        let mut cursor = std::io::Cursor::new(bytes);
        let Some(rgb) = crate::kgpg::read_kgpg2_icon_rgb(&mut cursor)
            .map_err(|e| format!("Failed to parse kgpg v2 header: {}", e))?
        else {
            // 非 v2：不在这里回退（商店列表不强依赖 icon）
            return Ok(None);
        };
        if rgb.len() != crate::kgpg::KGPG2_ICON_SIZE {
            return Ok(None);
        }

        use image::{ImageOutputFormat, RgbImage};
        let img = RgbImage::from_raw(crate::kgpg::KGPG2_ICON_W, crate::kgpg::KGPG2_ICON_H, rgb)
            .ok_or_else(|| "Invalid kgpg2 icon buffer".to_string())?;
        let mut out: Vec<u8> = Vec::new();
        let mut out_cursor = std::io::Cursor::new(&mut out);
        img.write_to(&mut out_cursor, ImageOutputFormat::Png)
            .map_err(|e| format!("Failed to encode icon png: {}", e))?;
        Ok(Some(out))
    }

    pub fn load_installed_plugin_detail(&self, plugin_id: &str) -> Result<PluginDetail, String> {
        self.ensure_installed_cache_initialized()?;
        let plugins_dir = self.get_plugins_directory();
        let path = self.find_plugin_file(&plugins_dir, plugin_id)?;
        let (manifest, doc, base_url) = {
            let guard = self
                .installed_cache
                .lock()
                .map_err(|_| "插件缓存锁已中毒".to_string())?;
            let Some(file) = guard.files.get(&path) else {
                return Err(format!("Plugin {} not found", plugin_id));
            };
            (
                file.manifest.clone(),
                file.doc.clone(),
                file.config.clone().and_then(|c| c.base_url),
            )
        };

        // icon bytes：走懒加载缓存（避免每次详情都重新读盘）
        let icon_data = self.get_plugin_icon_by_id(plugin_id).ok().flatten();

        Ok(PluginDetail {
            id: plugin_id.to_string(),
            name: manifest.name,
            desp: manifest.description,
            doc,
            icon_data,
            origin: "installed".to_string(),
            base_url,
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

        // 检查是否是 kgpgv2 格式，并提取头部 icon（如果存在）
        let mut cursor = std::io::Cursor::new(bytes.as_slice());
        let (is_v2, v2_icon_data) = match crate::kgpg::read_kgpg2_meta(&mut cursor) {
            Ok(Some(meta)) => {
                // kgpgv2 格式：尝试读取头部 icon
                let icon = if meta.icon_present() {
                    cursor
                        .seek(SeekFrom::Start(crate::kgpg::KGPG2_META_SIZE as u64))
                        .ok();
                    let mut rgb = vec![0u8; crate::kgpg::KGPG2_ICON_SIZE];
                    if cursor.read_exact(&mut rgb).is_ok() {
                        // RGB24 -> PNG
                        use image::{ImageOutputFormat, RgbImage};
                        if let Some(img) = RgbImage::from_raw(
                            crate::kgpg::KGPG2_ICON_W,
                            crate::kgpg::KGPG2_ICON_H,
                            rgb,
                        ) {
                            let mut out: Vec<u8> = Vec::new();
                            let mut out_cursor = std::io::Cursor::new(&mut out);
                            if img
                                .write_to(&mut out_cursor, ImageOutputFormat::Png)
                                .is_ok()
                            {
                                Some(out)
                            } else {
                                None
                            }
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                } else {
                    None
                };
                (true, icon)
            }
            _ => (false, None),
        };

        // 打开 ZIP archive：kgpgv2 需要跳过头部
        let zip_cursor = if is_v2 {
            let zip_start = crate::kgpg::KGPG2_TOTAL_HEADER_SIZE;
            std::io::Cursor::new(&bytes[zip_start..])
        } else {
            std::io::Cursor::new(bytes.as_slice())
        };
        let mut archive = ZipArchive::new(zip_cursor)
            .map_err(|e| format!("Failed to open ZIP archive: {}", e))?;

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

        // 读取 icon：优先使用 kgpgv2 头部的 icon，回退到 ZIP 内的 icon.png
        let icon_data = if v2_icon_data.is_some() {
            v2_icon_data
        } else {
            match archive.by_name("icon.png") {
                Ok(mut f) => {
                    let mut data = Vec::new();
                    f.read_to_end(&mut data)
                        .map_err(|e| format!("Failed to read icon.png: {}", e))?;
                    Some(data)
                }
                Err(_) => None,
            }
        };

        // 读取 config.json（可选）以获取 baseUrl
        let base_url = match archive.by_name("config.json") {
            Ok(mut f) => {
                let mut content = String::new();
                if f.read_to_string(&mut content).is_ok() {
                    if let Ok(config) = serde_json::from_str::<PluginConfig>(&content) {
                        config.base_url
                    } else {
                        None
                    }
                } else {
                    None
                }
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
            base_url,
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

                // 检查是否是 kgpgv2 格式，需要跳过头部打开 ZIP
                let mut cursor = std::io::Cursor::new(bytes.as_slice());
                let is_v2 = crate::kgpg::read_kgpg2_meta(&mut cursor)
                    .ok()
                    .flatten()
                    .is_some();
                let zip_cursor = if is_v2 {
                    let zip_start = crate::kgpg::KGPG2_TOTAL_HEADER_SIZE;
                    std::io::Cursor::new(&bytes[zip_start..])
                } else {
                    std::io::Cursor::new(bytes.as_slice())
                };
                let mut archive = ZipArchive::new(zip_cursor)
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
            self.get(&plugin_id).map(|p| p.version)
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

    /// 前端手动“刷新已安装源”：重扫插件目录并重建缓存（全量刷新）
    pub fn refresh_installed_plugins_cache(&self) -> Result<(), String> {
        let plugins_dir = self.get_plugins_directory();
        let builtins = self.builtins();

        let mut by_id: HashMap<String, PathBuf> = HashMap::new();
        let mut plugins: HashMap<String, Plugin> = HashMap::new();
        let mut files: HashMap<PathBuf, KgpgFileCacheEntry> = HashMap::new();

        if plugins_dir.exists() {
            let entries = fs::read_dir(&plugins_dir)
                .map_err(|e| format!("Failed to read plugins directory: {}", e))?;
            for entry in entries {
                let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
                let path = entry.path();
                if !(path.is_file() && path.extension().and_then(|s| s.to_str()) == Some("kgpg")) {
                    continue;
                }
                let plugin_id = path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_string();
                if plugin_id.trim().is_empty() {
                    continue;
                }

                let stamp = FileStamp::from_path(&path)?;
                let parsed = self.parse_kgpg_for_cache(&path)?;

                let built_in = is_immutable_builtin_id(&builtins, &plugin_id);
                let plugin = Plugin {
                    id: plugin_id.clone(),
                    name: parsed.manifest.name.clone(),
                    description: parsed.manifest.description.clone(),
                    version: parsed.manifest.version.clone(),
                    base_url: parsed
                        .config
                        .as_ref()
                        .and_then(|c| c.base_url.clone())
                        .unwrap_or_default(),
                    size_bytes: stamp.len,
                    built_in,
                    config: HashMap::new(),
                    selector: parsed.config.clone().and_then(|c| c.selector),
                };

                by_id.insert(plugin_id.clone(), path.clone());
                plugins.insert(plugin_id, plugin);
                files.insert(
                    path.clone(),
                    KgpgFileCacheEntry {
                        stamp,
                        manifest: parsed.manifest,
                        config: parsed.config,
                        doc: parsed.doc,
                        icon_present: parsed.icon_present,
                        icon_png_bytes: None,
                    },
                );
            }
        }

        let mut guard = self
            .installed_cache
            .lock()
            .map_err(|_| "插件缓存锁已中毒".to_string())?;
        guard.initialized = true;
        guard.plugins_dir = plugins_dir;
        guard.by_id = by_id;
        guard.plugins = plugins;
        guard.files = files;
        Ok(())
    }

    /// 安装/更新/删除后：按 pluginId 局部刷新（部分刷新）
    pub fn refresh_installed_plugin_cache(&self, plugin_id: &str) -> Result<(), String> {
        let plugins_dir = self.get_plugins_directory();

        // 先处理目录切换（debug 模式可能从 packed 切到 data/plugins-directory）
        if let Ok(guard) = self.installed_cache.lock() {
            if guard.initialized && guard.plugins_dir != plugins_dir {
                drop(guard);
                return self.refresh_installed_plugins_cache();
            }
        }

        // 尝试直接命中默认路径（最常见：{plugins_dir}/{id}.kgpg）
        let expected = plugins_dir.join(format!("{}.kgpg", plugin_id));
        let found_path = if expected.is_file() {
            Some(expected)
        } else if plugins_dir.is_dir() {
            // 兜底：扫目录找 stem=plugin_id（兼容用户手动重命名）
            let entries = fs::read_dir(&plugins_dir)
                .map_err(|e| format!("Failed to read plugins directory: {}", e))?;
            let mut hit = None;
            for entry in entries {
                let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
                let path = entry.path();
                if path.is_file() && path.extension().and_then(|s| s.to_str()) == Some("kgpg") {
                    let stem = path
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("")
                        .to_string();
                    if stem == plugin_id {
                        hit = Some(path);
                        break;
                    }
                }
            }
            hit
        } else {
            None
        };

        let builtins = self.builtins();

        // 找到文件：重新解析并更新（不持锁做 IO）
        if let Some(path) = found_path {
            let stamp = FileStamp::from_path(&path)?;
            let parsed = self.parse_kgpg_for_cache(&path)?;
            let built_in = is_immutable_builtin_id(&builtins, plugin_id);

            let plugin = Plugin {
                id: plugin_id.to_string(),
                name: parsed.manifest.name.clone(),
                description: parsed.manifest.description.clone(),
                version: parsed.manifest.version.clone(),
                base_url: parsed
                    .config
                    .as_ref()
                    .and_then(|c| c.base_url.clone())
                    .unwrap_or_default(),
                size_bytes: stamp.len,
                built_in,
                config: HashMap::new(),
                selector: parsed.config.clone().and_then(|c| c.selector),
            };

            let mut guard = self
                .installed_cache
                .lock()
                .map_err(|_| "插件缓存锁已中毒".to_string())?;
            guard.initialized = true;
            guard.plugins_dir = plugins_dir;
            guard.by_id.insert(plugin_id.to_string(), path.clone());
            guard.plugins.insert(plugin_id.to_string(), plugin);
            guard.files.insert(
                path,
                KgpgFileCacheEntry {
                    stamp,
                    manifest: parsed.manifest,
                    config: parsed.config,
                    doc: parsed.doc,
                    icon_present: parsed.icon_present,
                    icon_png_bytes: None,
                },
            );
            return Ok(());
        }

        // 未找到文件：从索引与文件缓存里清理
        let mut guard = self
            .installed_cache
            .lock()
            .map_err(|_| "插件缓存锁已中毒".to_string())?;
        guard.initialized = true;
        guard.plugins_dir = plugins_dir;
        if let Some(old_path) = guard.by_id.remove(plugin_id) {
            guard.files.remove(&old_path);
        }
        guard.plugins.remove(plugin_id);
        Ok(())
    }

    fn ensure_installed_cache_initialized(&self) -> Result<(), String> {
        let plugins_dir = self.get_plugins_directory();
        if let Ok(guard) = self.installed_cache.lock() {
            if guard.initialized && guard.plugins_dir == plugins_dir {
                return Ok(());
            }
        }
        self.refresh_installed_plugins_cache()
    }

    fn parse_kgpg_for_cache(&self, zip_path: &Path) -> Result<ParsedKgpgForCache, String> {
        // 打开一次文件：同时支持 v2 头部读取 + SFX zip 解析
        let mut file =
            fs::File::open(zip_path).map_err(|e| format!("Failed to open plugin file: {}", e))?;

        // v2：可从固定头部读 icon_present + manifest（无需 zip）
        let mut icon_present_from_meta: Option<bool> = None;
        let mut manifest_from_meta: Option<PluginManifest> = None;
        if let Ok(Some(meta)) = crate::kgpg::read_kgpg2_meta(&mut file) {
            icon_present_from_meta = Some(meta.icon_present());
            if meta.manifest_present() {
                if let Ok(Some(s)) = crate::kgpg::read_kgpg2_manifest_json(&mut file) {
                    if !s.trim().is_empty() {
                        if let Ok(m) = serde_json::from_str::<PluginManifest>(&s) {
                            manifest_from_meta = Some(m);
                        }
                    }
                }
            }
        }

        // 交给 zip crate（支持 SFX：前置固定头部 + zip）
        let _ = file.seek(SeekFrom::Start(0));
        let mut archive =
            ZipArchive::new(file).map_err(|e| format!("Failed to open ZIP archive: {}", e))?;

        // manifest：若 v2 头部拿到了就用，否则从 zip 的 manifest.json 读
        let manifest = if let Some(m) = manifest_from_meta {
            m
        } else {
            let mut manifest_file = archive
                .by_name("manifest.json")
                .map_err(|_| "manifest.json not found in plugin archive".to_string())?;
            let mut content = String::new();
            manifest_file
                .read_to_string(&mut content)
                .map_err(|e| format!("Failed to read manifest.json: {}", e))?;
            serde_json::from_str::<PluginManifest>(&content)
                .map_err(|e| format!("Failed to parse manifest.json: {}", e))?
        };

        // doc（优先 doc_root/doc.md，其次 doc.md）
        let doc_paths = ["doc_root/doc.md", "doc.md"];
        let mut doc_path_found = None;
        for p in &doc_paths {
            if archive.by_name(p).is_ok() {
                doc_path_found = Some(*p);
                break;
            }
        }
        let doc = match doc_path_found {
            Some(p) => {
                let mut f = archive
                    .by_name(p)
                    .map_err(|_| "doc.md not found".to_string())?;
                let mut s = String::new();
                f.read_to_string(&mut s)
                    .map_err(|e| format!("Failed to read doc.md: {}", e))?;
                Some(s)
            }
            None => None,
        };

        // config.json（可选）
        let config = match archive.by_name("config.json") {
            Ok(mut f) => {
                let mut s = String::new();
                f.read_to_string(&mut s)
                    .map_err(|e| format!("Failed to read config.json: {}", e))?;
                let c: PluginConfig = serde_json::from_str(&s)
                    .map_err(|e| format!("Failed to parse config.json: {}", e))?;
                Some(c)
            }
            Err(_) => None,
        };

        // icon_present：v2 优先读头部 flags；否则检查 zip entry
        let icon_present =
            icon_present_from_meta.unwrap_or_else(|| archive.by_name("icon.png").is_ok());

        Ok(ParsedKgpgForCache {
            manifest,
            config,
            doc,
            icon_present,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrowserPlugin {
    pub id: String,
    pub name: String,
    pub desp: String,
    pub icon: Option<String>,
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
    #[serde(default)]
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
    #[serde(rename = "baseUrl", default)]
    pub base_url: Option<String>,
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
    /// KGPG 包格式版本（来自 index.json 的 packageVersion）
    /// 版本协商：过高按最高支持版本解析，过低按低版本解析。
    #[serde(rename = "packageVersion", default)]
    pub package_version: u16,
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
    /// 插件的基础URL（从 config.json 中读取）
    #[serde(rename = "baseUrl", skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
}

#[derive(Debug, Clone)]
struct RemoteZipCacheEntry {
    inserted_at: Instant,
    bytes: Arc<Vec<u8>>,
}

/// 从 URL 中提取 .kgpg 文件名（用于保持插件 ID 正确）
/// 例如：https://github.com/.../local-import.kgpg -> local-import.kgpg
fn extract_kgpg_filename_from_url(url: &str) -> Option<String> {
    // 移除查询参数和片段
    let path = url.split('?').next()?.split('#').next()?;
    // 获取最后一个路径段
    let file_name = path.rsplit('/').next()?;
    // 验证是 .kgpg 文件
    if file_name.ends_with(".kgpg") && file_name.len() > 5 {
        Some(file_name.to_string())
    } else {
        None
    }
}
