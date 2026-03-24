#![allow(dead_code)]

// Rhai 爬虫运行时/脚本执行
pub mod rhai;

use futures_util::StreamExt;
use reqwest;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::OnceLock;
use std::time::Duration;
use std::time::Instant;
use std::time::SystemTime;
use tokio::sync::Mutex;
use url::Url;
use uuid::Uuid;
use zip::ZipArchive;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plugin {
    pub id: String,
    /// 插件名称：string 或按语言 key 的对象（如 name、ja、ko），前端按 locale 解析，name 为回退
    pub name: serde_json::Value,
    /// 插件描述：同上
    pub description: serde_json::Value,
    /// manifest.json 里的版本号
    pub version: String,
    #[serde(rename = "baseUrl")]
    pub base_url: String,
    /// 插件包体大小（.kgpg 文件大小）
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
    pub config: HashMap<String, serde_json::Value>,
    pub selector: Option<PluginSelector>,
    /// 脚本类型：rhai（crawl.rhai）或 js（crawl.js）。安卓仅支持 rhai。
    #[serde(rename = "scriptType")]
    pub script_type: String,
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
    installed_cache: Mutex<InstalledPluginsCache>,
    /// 商店插件下载进度（内存态，供 `get_store_plugins` 合并）；key = `source_id::plugin_id`
    store_download_states: std::sync::Mutex<HashMap<String, StoreDownloadState>>,
}

/// 商店列表合并用：某插件当前下载进度（仅下载中；完成后从 map 移除）
#[derive(Debug, Clone)]
pub enum StoreDownloadState {
    Downloading {
        percent: u8,
        received: u64,
        total: Option<u64>,
    },
}

/// 供 Tauri 等向前端派发（1s 节流由下载循环内控制）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorePluginDownloadProgressEvent {
    pub source_id: String,
    pub plugin_id: String,
    pub percent: u8,
    pub received: u64,
    pub total: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 下载进度回调上下文（可选；无回调时仍更新 `store_download_states` 供列表合并）
pub struct StorePluginDownloadProgressContext {
    pub source_id: String,
    pub plugin_id: String,
    pub on_emit: Option<Arc<dyn Fn(StorePluginDownloadProgressEvent) + Send + Sync>>,
}

fn store_download_progress_key(source_id: &str, plugin_id: &str) -> String {
    format!("{}::{}", source_id, plugin_id)
}

// 全局 PluginManager 单例
static PLUGIN_MANAGER: OnceLock<PluginManager> = OnceLock::new();

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
    doc: Option<PluginDoc>,
    icon_present: bool,
    /// 懒加载：只有真正请求 icon bytes 时才读取并缓存（避免刷新/初始化时读大量二进制）
    icon_png_bytes: Option<Option<Vec<u8>>>,
}

#[derive(Default)]
struct InstalledPluginsCache {
    initialized: bool,
    user_plugins_dir: PathBuf,
    by_id: HashMap<String, PathBuf>,
    plugins: HashMap<String, Plugin>,
    files: HashMap<PathBuf, KgpgFileCacheEntry>,
}

struct ParsedKgpgForCache {
    manifest: PluginManifest,
    config: Option<PluginConfig>,
    doc: Option<PluginDoc>,
    icon_present: bool,
    /// "rhai" | "js"，由包内是否存在 crawl.js 决定
    script_type: String,
}

impl PluginManager {
    pub fn new() -> Self {
        Self {
            installed_cache: Mutex::new(InstalledPluginsCache::default()),
            store_download_states: std::sync::Mutex::new(HashMap::new()),
        }
    }

    /// 初始化全局 PluginManager（必须在首次使用前调用）
    pub fn init_global() -> Result<(), String> {
        let plugin_manager = PluginManager::new();
        PLUGIN_MANAGER
            .set(plugin_manager)
            .map_err(|_| "PluginManager already initialized".to_string())?;
        Ok(())
    }

    /// 获取全局 PluginManager 引用
    pub fn global() -> &'static PluginManager {
        PLUGIN_MANAGER
            .get()
            .expect("PluginManager not initialized. Call PluginManager::init_global() first.")
    }

    /// 从插件目录中的 .kgpg 文件加载所有已安装的插件
    pub async fn get_all(&self) -> Result<Vec<Plugin>, String> {
        let guard = self.installed_cache.lock().await;
        let mut plugins: Vec<Plugin> = guard.plugins.values().cloned().collect();
        plugins.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(plugins)
    }

    pub async fn get(&self, id: &str) -> Option<Plugin> {
        let guard = self.installed_cache.lock().await;
        guard.plugins.get(id).cloned()
    }

    /// 从指定 `.kgpg` 文件解析出运行时需要的 `Plugin` 信息（用于 CLI/调度器/插件编辑器临时运行）。
    ///
    /// 注意：
    /// - `config` 等运行时字段由调用方策略决定；这里按“可运行”默认值填充。
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

        let script_type = self.detect_script_type_from_kgpg(kgpg_path)?;
        Ok(Plugin {
            id: plugin_id,
            name: manifest.name_to_value(),
            description: manifest.description_to_value(),
            version: manifest.version,
            base_url: config
                .as_ref()
                .and_then(|c| c.base_url.clone())
                .unwrap_or_default(),
            size_bytes,
            config: HashMap::new(),
            selector: config.and_then(|c| c.selector),
            script_type,
        })
    }

    /// CLI 场景：支持传入插件 id（已安装）或 `.kgpg` 路径（临时运行）。
    /// 返回：
    /// - `Plugin`
    /// - `plugin_file_path`：若为临时运行则为 Some(path)，已安装则为 None
    /// - `var_defs`：用于 CLI 参数解析（来源于插件文件或已安装插件的 config.json var）
    #[allow(dead_code)] // 仅被 sidecar/CLI bin 调用；主程序二进制未直接使用
    pub async fn resolve_plugin_for_cli_run(
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
        let plugin = self.get(id_or_path).await.ok_or("Plugin not found!")?;
        let var_defs = self
            .get_plugin_vars(id_or_path)
            .await?
            .ok_or("Cannot read plugin variable")?;
        Ok((plugin, None, var_defs))
    }

    /// 调度器/任务场景：支持“已安装插件（plugin_id）”或“指定 `.kgpg` 文件临时运行”。
    /// 这里允许 `plugin_id` 由上层指定（DB/task 里存的 id），以保持历史行为一致。
    pub async fn resolve_plugin_for_task_request(
        &self,
        plugin_id: &str,
        plugin_file_path: Option<&str>,
    ) -> Result<(Plugin, Option<PathBuf>), String> {
        if let Some(p) = plugin_file_path {
            let path = PathBuf::from(p);
            let plugin = self.build_runtime_plugin_from_kgpg_path(plugin_id.to_string(), &path)?;
            return Ok((plugin, Some(path)));
        }
        let plugin = self.get(plugin_id).await.ok_or("找不到插件")?;
        Ok((plugin, None))
    }

    /// 删除插件（仅删除用户插件目录 data/plugins-directory 中的 .kgpg 文件）
    pub async fn delete(&self, id: &str) -> Result<(), String> {
        let user_plugins_dir = self.get_plugins_directory();
        let path = user_plugins_dir.join(format!("{}.kgpg", id));
        if !path.is_file() {
            return Err(format!("插件 {} 不在用户插件目录中或不存在", id));
        }
        fs::remove_file(&path).map_err(|e| format!("Failed to delete plugin file: {}", e))?;
        // 删除后局部刷新缓存（避免前端仍看到旧列表/旧图标）
        let _ = self.refresh_installed_plugin_cache(id).await;
        Ok(())
    }

    pub fn get_plugins_directory(&self) -> PathBuf {
        crate::app_paths::AppPaths::global().plugins_dir()
    }

    #[deprecated(note = "Use get_plugins_directory() instead")]
    fn _old_get_plugins_directory(&self) -> PathBuf {
        plugins_directory_for_readonly()
    }

    pub async fn load_browser_plugins(&self) -> Result<Vec<BrowserPlugin>, String> {
        let guard = self.installed_cache.lock().await;

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
                name: file.manifest.name_to_value(),
                desp: file.manifest.description_to_value(),
                icon: icon_path,
                file_path: Some(path.to_string_lossy().to_string()),
                doc: file.doc.clone(),
            });
        }

        Ok(browser_plugins)
    }

    /// 从 ZIP 格式的插件文件中读取 manifest.json
    pub fn read_plugin_manifest(&self, zip_path: &Path) -> Result<PluginManifest, String> {
        read_plugin_manifest_from_kgpg_file(zip_path)
    }

    /// 从 ZIP 格式的插件文件中读取 doc：doc_root/doc.md（default）、doc_root/doc.<lang>.md、或兼容 doc.md
    fn read_plugin_doc(&self, zip_path: &Path) -> Result<Option<PluginDoc>, String> {
        let file =
            fs::File::open(zip_path).map_err(|e| format!("Failed to open plugin file: {}", e))?;
        let mut archive =
            ZipArchive::new(file).map_err(|e| format!("Failed to open ZIP archive: {}", e))?;
        collect_doc_from_zip(&mut archive)
    }

    /// 从 ZIP 格式的插件文件中读取 doc（供 app-cli/外部调用复用）
    pub fn read_plugin_doc_public(&self, zip_path: &Path) -> Result<Option<PluginDoc>, String> {
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

    /// 从 ZIP 格式的插件文件中读取 crawl.js 脚本
    pub fn read_plugin_js_script(&self, zip_path: &Path) -> Result<Option<String>, String> {
        let file =
            fs::File::open(zip_path).map_err(|e| format!("Failed to open plugin file: {}", e))?;
        let mut archive =
            ZipArchive::new(file).map_err(|e| format!("Failed to open ZIP archive: {}", e))?;

        let mut script_file = match archive.by_name("crawl.js") {
            Ok(f) => f,
            Err(_) => return Ok(None),
        };

        let mut content = String::new();
        script_file
            .read_to_string(&mut content)
            .map_err(|e| format!("Failed to read crawl.js: {}", e))?;
        Ok(Some(content))
    }

    /// 从 .kgpg 文件检测脚本类型：存在 crawl.js 返回 "js"，否则 "rhai"（用于 build_runtime_plugin_from_kgpg_path 等）
    fn detect_script_type_from_kgpg(&self, zip_path: &Path) -> Result<String, String> {
        let mut file =
            fs::File::open(zip_path).map_err(|e| format!("Failed to open plugin file: {}", e))?;
        if crate::kgpg::read_kgpg2_meta(&mut file)
            .ok()
            .flatten()
            .is_some()
        {
            let _ = file.seek(SeekFrom::Start(crate::kgpg::KGPG2_TOTAL_HEADER_SIZE as u64));
        } else {
            let _ = file.seek(SeekFrom::Start(0));
        }
        let mut archive =
            ZipArchive::new(file).map_err(|e| format!("Failed to open ZIP archive: {}", e))?;
        Ok(if archive.by_name("crawl.js").is_ok() {
            "js".to_string()
        } else {
            "rhai".to_string()
        })
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
    pub async fn get_plugin_icon_by_id(&self, plugin_id: &str) -> Result<Option<Vec<u8>>, String> {
        let plugins_dir = self.get_plugins_directory();
        let path = self.find_plugin_file(&plugins_dir, plugin_id).await?;

        // 先尝试缓存命中
        {
            let guard = self.installed_cache.lock().await;
            if let Some(entry) = guard.files.get(&path) {
                let cur = FileStamp::from_path(&path)?;
                if entry.stamp.len == cur.len && entry.stamp.modified == cur.modified {
                    if let Some(cached) = entry.icon_png_bytes.clone() {
                        return Ok(cached);
                    }
                }
            }
        } // guard 在此处 drop，避免持锁做文件 IO

        // 缓存未命中或文件变化：不持锁读取图标（可能涉及 ZIP 解压）
        let icon = self.read_plugin_icon(&path).ok().flatten();

        // 读取完成后再获取锁，写回缓存
        let mut guard = self.installed_cache.lock().await;
        if let Some(entry) = guard.files.get_mut(&path) {
            let cur = FileStamp::from_path(&path)?;
            entry.stamp = cur;
            entry.icon_png_bytes = Some(icon.clone());
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
    pub async fn install_plugin_from_zip(&self, zip_path: &Path) -> Result<Plugin, String> {
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

        // 内置插件不允许覆盖导入
        let file_stem = zip_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();

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

        let script_type = self.detect_script_type_from_kgpg(&target_path)?;
        let plugin = Plugin {
            id: plugin_id.clone(),
            name: manifest.name_to_value(),
            description: manifest.description_to_value(),
            version: manifest.version,
            base_url: config
                .as_ref()
                .and_then(|c| c.base_url.clone())
                .unwrap_or_default(),
            size_bytes,
            config: HashMap::new(),
            selector: config.and_then(|c| c.selector),
            script_type,
        };

        // 安装/覆盖后：局部刷新缓存，避免后续命令重复扫目录/读盘
        // 注意：必须 await 以避免死锁（refresh_installed_plugin_cache 内部需要获取 installed_cache 锁）
        let _ = self.refresh_installed_plugin_cache(&plugin_id).await;
        Ok(plugin)
    }

    /// 安装浏览器插件（从插件目录中的 .kgpg 文件安装）
    /// 实际上，如果文件已经在插件目录中，就已经是"已安装"状态了
    /// 这个方法主要用于标记插件为已安装（如果之前未安装的话）
    pub async fn install_browser_plugin(&self, plugin_id: String) -> Result<Plugin, String> {
        // 这个方法在历史上用于"标记安装"，但实际插件文件已在目录里即视为安装。
        // 这里直接复用缓存，避免扫目录/频繁读盘。
        let user_plugins_dir = self.get_plugins_directory();
        let _path = self.find_plugin_file(&user_plugins_dir, &plugin_id).await?;

        let guard = self.installed_cache.lock().await;
        let Some(p) = guard.plugins.get(&plugin_id) else {
            return Err(format!("Plugin {} not found", plugin_id));
        };
        Ok(p.clone())
    }

    /// 获取插件的变量定义（从 config.json 中读取）
    pub async fn get_plugin_vars(
        &self,
        plugin_id: &str,
    ) -> Result<Option<Vec<VarDefinition>>, String> {
        let plugins_dir = self.get_plugins_directory();
        let plugin_file = self.find_plugin_file(&plugins_dir, plugin_id).await?;
        let guard = self.installed_cache.lock().await;
        let Some(file) = guard.files.get(&plugin_file) else {
            return Ok(None);
        };
        Ok(file.config.clone().and_then(|c| c.var))
    }

    /// 查找插件文件（用户 data 目录下的 .kgpg，经已安装缓存索引）
    async fn find_plugin_file(
        &self,
        _plugins_dir: &Path,
        plugin_id: &str,
    ) -> Result<PathBuf, String> {
        // 先走缓存索引（避免每次都扫目录）
        {
            let guard = self.installed_cache.lock().await;
            if guard.initialized {
                if let Some(p) = guard.by_id.get(plugin_id) {
                    return Ok(p.clone());
                }
            }
        } // guard 在此处 drop，避免下方 refresh 重入死锁

        // 缓存未命中：尝试局部刷新一次（兼容外部手动复制/替换文件的场景）
        let _ = self.refresh_installed_plugin_cache(plugin_id).await;
        let guard = self.installed_cache.lock().await;
        if let Some(p) = guard.by_id.get(plugin_id) {
            return Ok(p.clone());
        }

        // 最终兜底：仅从用户目录（data）查找
        let user_dir = self.get_plugins_directory();
        let user_path = user_dir.join(format!("{}.kgpg", plugin_id));
        if user_path.is_file() {
            return Ok(user_path);
        }

        Err(format!("Plugin {} not found", plugin_id))
    }

    /// 加载插件源列表
    pub fn load_plugin_sources(&self) -> Result<Vec<PluginSource>, String> {
        crate::storage::Storage::global()
            .plugin_sources()
            .get_all_sources()
            .map_err(|e| format!("Failed to load plugin sources: {}", e))
    }

    /// 添加插件源
    pub fn add_plugin_source(
        &self,
        id: Option<String>,
        name: String,
        index_url: String,
    ) -> Result<PluginSource, String> {
        if id
            .as_deref()
            .is_some_and(|i| i == crate::storage::plugin_sources::OFFICIAL_PLUGIN_SOURCE_ID)
        {
            return Err("不能使用保留的官方源 ID".to_string());
        }
        crate::storage::Storage::global()
            .plugin_sources()
            .add_source(id, name, index_url)
            .map_err(|e| format!("Failed to add plugin source: {}", e))
    }

    /// 更新插件源
    pub fn update_plugin_source(
        &self,
        id: String,
        name: String,
        index_url: String,
    ) -> Result<(), String> {
        crate::storage::Storage::global()
            .plugin_sources()
            .update_source(id, name, index_url)
            .map_err(|e| format!("Failed to update plugin source: {}", e))
    }

    /// 删除插件源（同时清理 .kgpg 缓存目录）
    pub fn delete_plugin_source(&self, id: String) -> Result<(), String> {
        if id == crate::storage::plugin_sources::OFFICIAL_PLUGIN_SOURCE_ID {
            return Err("官方 GitHub Releases 源不可删除".to_string());
        }
        // 删除数据库记录（缓存会通过 CASCADE 自动删除）
        crate::storage::Storage::global()
            .plugin_sources()
            .delete_source(id.clone())
            .map_err(|e| format!("Failed to delete plugin source: {}", e))?;

        // 清理 .kgpg 插件包缓存目录
        let cache_dir = crate::app_paths::AppPaths::global().store_plugin_cache_dir(&id);
        if cache_dir.exists() {
            std::fs::remove_dir_all(&cache_dir)
                .map_err(|e| format!("Failed to remove plugin cache directory: {}", e))?;
        }

        Ok(())
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
        let installed_plugins = self.get_all().await?;
        let installed_versions: HashMap<String, String> = installed_plugins
            .iter()
            .map(|p| (p.id.clone(), p.version.clone()))
            .collect();
        for plugin in &mut all_plugins {
            if let Some(v) = installed_versions.get(&plugin.id) {
                plugin.installed_version = Some(v.clone());
            }
        }

        self.merge_store_download_into_plugins(&mut all_plugins);

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
            if let Ok(Some(cached_json_str)) = crate::storage::Storage::global()
                .plugin_sources()
                .get_source_cache(&source.id)
            {
                if let Ok(cached_json) = serde_json::from_str::<serde_json::Value>(&cached_json_str)
                {
                    // 解析缓存的 JSON
                    if let Some(plugins_array) =
                        cached_json.get("plugins").and_then(|v| v.as_array())
                    {
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
        }

        // 从远程获取
        self.fetch_plugins_from_source(source).await
    }

    /// 从单个源获取插件列表（从远程获取并保存缓存）
    async fn fetch_plugins_from_source(
        &self,
        source: &PluginSource,
    ) -> Result<Vec<StorePluginResolved>, String> {
        let mut client_builder = reqwest::Client::builder();

        // 配置代理：环境变量 + Windows 注册表系统代理
        if let Some(ref proxy_url) = crate::crawler::proxy::get_proxy_config().proxy_url {
            match reqwest::Proxy::all(proxy_url) {
                Ok(proxy) => {
                    client_builder = client_builder.proxy(proxy);
                    println!("插件商店网络代理已配置: {}", proxy_url);
                }
                Err(e) => {
                    println!("插件商店代理配置无效 ({}), 将使用直连: {}", proxy_url, e);
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
        let json_str = serde_json::to_string_pretty(&json)
            .map_err(|e| format!("Failed to serialize JSON for cache: {}", e))?;

        if let Err(e) = crate::storage::Storage::global()
            .plugin_sources()
            .save_source_cache(source.id.clone(), json_str)
        {
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

        // 配置代理：环境变量 + Windows 注册表系统代理
        if let Some(ref proxy_url) = crate::crawler::proxy::get_proxy_config().proxy_url {
            match reqwest::Proxy::all(proxy_url) {
                Ok(proxy) => {
                    client_builder = client_builder.proxy(proxy);
                    println!("插件源验证网络代理已配置: {}", proxy_url);
                }
                Err(e) => {
                    println!("插件源验证代理配置无效 ({}), 将使用直连: {}", proxy_url, e);
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

    /// 解析单个商店插件 JSON。index.json 中 name/description 为扁平键（name, name.zh, description, description.zh 等），此处解析为前端 i18n 对象。
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

        let map = plugin_json
            .as_object()
            .ok_or_else(|| "Plugin entry must be an object".to_string())?;
        let name_flat = extract_manifest_text_from_flat(map, "name");
        if name_flat.is_empty() {
            return Err("Missing 'name' field".to_string());
        }
        let name = manifest_i18n_to_frontend_value(&name_flat, "name");

        let version = plugin_json
            .get("version")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "Missing 'version' field".to_string())?
            .to_string();

        let description_flat = extract_manifest_text_from_flat(map, "description");
        let description = manifest_i18n_to_frontend_value(&description_flat, "description");

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
            store_download_progress: None,
            store_download_error: None,
        })
    }

    fn merge_store_download_into_plugins(&self, plugins: &mut [StorePluginResolved]) {
        let guard = match self.store_download_states.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        for p in plugins.iter_mut() {
            let k = store_download_progress_key(&p.source_id, &p.id);
            if let Some(state) = guard.get(&k) {
                match state {
                    StoreDownloadState::Downloading {
                        percent,
                        received: _,
                        total: _,
                    } => {
                        p.store_download_progress = Some(*percent);
                        p.store_download_error = None;
                    }
                }
            }
        }
    }

    /// 下载插件：全程在内存中组装字节，校验通过后一次性落盘；流式读取避免部分文件缓存。
    /// `progress` 非空时更新 `store_download_states`，并对 `on_emit` 做至多 1 秒一次的节流（完成 100% 与错误立即派发）。
    /// 网络/读流等失败时自动重试 2 次（共最多 3 次）；校验类错误也会重试（可能偶发损坏）。
    async fn download_plugin_raw(
        &self,
        download_url: &str,
        expected_sha256: Option<&str>,
        expected_size: Option<u64>,
        progress: Option<StorePluginDownloadProgressContext>,
    ) -> Result<Vec<u8>, String> {
        let progress_key = progress
            .as_ref()
            .map(|p| store_download_progress_key(p.source_id.as_str(), p.plugin_id.as_str()));
        // 首次 + 失败重试 2 次
        const MAX_DOWNLOAD_ATTEMPTS: u32 = 3;

        let mut last_err = String::new();
        for attempt in 0..MAX_DOWNLOAD_ATTEMPTS {
            match self
                .download_plugin_raw_single_attempt(
                    download_url,
                    expected_sha256,
                    expected_size,
                    progress.as_ref(),
                    &progress_key,
                )
                .await
            {
                Ok(buf) => return Ok(buf),
                Err(e) => {
                    last_err = e;
                    if attempt + 1 < MAX_DOWNLOAD_ATTEMPTS {
                        eprintln!(
                            "插件下载失败（第 {} 次），400ms 后重试: {}",
                            attempt + 1,
                            last_err
                        );
                        tokio::time::sleep(Duration::from_millis(400)).await;
                    }
                }
            }
        }

        if let Some(ref ctx) = progress {
            self.emit_download_failed(ctx, last_err.clone());
        }
        Err(last_err)
    }

    fn parse_content_range_start_and_total(header: &str) -> Option<(u64, Option<u64>)> {
        // 形如: "bytes 123-456/789" 或 "bytes 123-456/*"
        let raw = header.trim();
        let bytes_part = raw.strip_prefix("bytes ")?;
        let (range_part, total_part) = bytes_part.split_once('/')?;
        let (start_part, _end_part) = range_part.split_once('-')?;
        let start = start_part.trim().parse::<u64>().ok()?;
        let total = if total_part.trim() == "*" {
            None
        } else {
            total_part.trim().parse::<u64>().ok()
        };
        Some((start, total))
    }

    /// 单次下载尝试（失败不向前端派发 error，由外层重试或最终统一派发）。
    /// 读流失败时优先在本次尝试内使用 HTTP Range 从已接收字节继续下载；
    /// 若服务端忽略 Range（返回 200 全量），自动回退为整包重下，避免拼接损坏。
    async fn download_plugin_raw_single_attempt(
        &self,
        download_url: &str,
        expected_sha256: Option<&str>,
        expected_size: Option<u64>,
        progress: Option<&StorePluginDownloadProgressContext>,
        progress_key: &Option<String>,
    ) -> Result<Vec<u8>, String> {
        let mut client_builder = reqwest::Client::builder();

        // 配置代理：环境变量 + Windows 注册表系统代理
        if let Some(ref proxy_url) = crate::crawler::proxy::get_proxy_config().proxy_url {
            match reqwest::Proxy::all(proxy_url) {
                Ok(proxy) => {
                    client_builder = client_builder.proxy(proxy);
                    println!("插件下载网络代理已配置: {}", proxy_url);
                }
                Err(e) => {
                    println!("插件下载代理配置无效 ({}), 将使用直连: {}", proxy_url, e);
                }
            }
        }

        let client = client_builder
            .timeout(Duration::from_secs(60)) // 下载可能需要更长时间
            .connect_timeout(Duration::from_secs(10))
            .user_agent("Kabegame/1.0")
            .build()
            .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

        let mut buffer: Vec<u8> = Vec::new();
        let mut received: u64 = 0;
        let mut total_hint = expected_size;
        let mut last_emit = Instant::now()
            .checked_sub(Duration::from_secs(2))
            .unwrap_or_else(Instant::now);
        const MAX_RESUME_ATTEMPTS: u32 = 2;
        let mut resume_attempts: u32 = 0;

        if let Some(ref k) = progress_key {
            if let Ok(mut g) = self.store_download_states.lock() {
                g.insert(
                    k.clone(),
                    StoreDownloadState::Downloading {
                        percent: 0,
                        received: 0,
                        total: total_hint,
                    },
                );
            }
        }

        'resume: loop {
            let mut req = client.get(download_url);
            if received > 0 {
                req = req.header(reqwest::header::RANGE, format!("bytes={}-", received));
            }
            let response = match req.send().await {
                Ok(r) => r,
                Err(e) => {
                    if received > 0 && resume_attempts < MAX_RESUME_ATTEMPTS {
                        resume_attempts += 1;
                        eprintln!(
                            "插件下载续传请求失败（第 {} 次），400ms 后重试: {}",
                            resume_attempts, e
                        );
                        tokio::time::sleep(Duration::from_millis(400)).await;
                        continue 'resume;
                    }
                    return Err(format!("Failed to download plugin: {}", e));
                }
            };

            if !response.status().is_success() {
                return Err(format!(
                    "Failed to download plugin: HTTP {}",
                    response.status()
                ));
            }

            if received > 0 && response.status() == reqwest::StatusCode::PARTIAL_CONTENT {
                if let Some(v) = response.headers().get(reqwest::header::CONTENT_RANGE) {
                    if let Ok(s) = v.to_str() {
                        if let Some((start, total)) = Self::parse_content_range_start_and_total(s) {
                            if start != received {
                                return Err(format!(
                                    "Invalid Content-Range start: expected {}, got {}",
                                    received, start
                                ));
                            }
                            if total_hint.is_none() {
                                total_hint = expected_size.or(total);
                            }
                        }
                    }
                }
                if total_hint.is_none() {
                    total_hint =
                        expected_size.or(response.content_length().map(|len| len + received));
                }
            } else {
                if received > 0 {
                    eprintln!("服务端未返回 206，回退为整包重下: {}", response.status());
                    buffer.clear();
                    received = 0;
                }
                // 仅在整包请求时做 content-length 与 expected_size 的快速校验。
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
                total_hint = expected_size.or(response.content_length());
            }

            let mut stream = response.bytes_stream();
            while let Some(chunk) = stream.next().await {
                let chunk = match chunk {
                    Ok(c) => c,
                    Err(e) => {
                        if resume_attempts < MAX_RESUME_ATTEMPTS {
                            resume_attempts += 1;
                            eprintln!(
                                "插件下载读流失败，基于已下载字节续传（第 {} 次）: {}",
                                resume_attempts, e
                            );
                            tokio::time::sleep(Duration::from_millis(400)).await;
                            continue 'resume;
                        }
                        return Err(format!("Failed to read plugin data: {}", e));
                    }
                };
                buffer.extend_from_slice(&chunk);
                received = buffer.len() as u64;

                let percent: u8 = if let Some(t) = total_hint.filter(|t| *t > 0) {
                    ((received.min(t) * 100) / t) as u8
                } else {
                    0
                };

                if let Some(ref k) = progress_key {
                    if let Ok(mut g) = self.store_download_states.lock() {
                        g.insert(
                            k.clone(),
                            StoreDownloadState::Downloading {
                                percent,
                                received,
                                total: total_hint,
                            },
                        );
                    }
                }

                if let Some(ctx) = progress {
                    let should_emit = last_emit.elapsed() >= Duration::from_secs(1);
                    if should_emit {
                        if let Some(ref cb) = ctx.on_emit {
                            cb(StorePluginDownloadProgressEvent {
                                source_id: ctx.source_id.clone(),
                                plugin_id: ctx.plugin_id.clone(),
                                percent,
                                received,
                                total: total_hint,
                                error: None,
                            });
                        }
                        last_emit = Instant::now();
                    }
                }
            }
            break;
        }

        if let Some(expected) = expected_size {
            if buffer.len() as u64 != expected {
                return Err(format!(
                    "Downloaded size mismatch: expected {}, got {}",
                    expected,
                    buffer.len()
                ));
            }
        }

        // 验证 SHA256（如果提供）
        if let Some(expected) = expected_sha256 {
            let mut hasher = Sha256::new();
            hasher.update(&buffer);
            let hash = format!("{:x}", hasher.finalize());
            if hash != expected {
                return Err(format!(
                    "SHA256 mismatch: expected {}, got {}",
                    expected, hash
                ));
            }
        }

        if let Some(ref k) = progress_key {
            if let Ok(mut g) = self.store_download_states.lock() {
                g.remove(k);
            }
        }

        if let Some(ctx) = progress {
            if let Some(ref cb) = ctx.on_emit {
                cb(StorePluginDownloadProgressEvent {
                    source_id: ctx.source_id.clone(),
                    plugin_id: ctx.plugin_id.clone(),
                    percent: 100,
                    received: buffer.len() as u64,
                    total: total_hint,
                    error: None,
                });
            }
        }

        Ok(buffer)
    }

    fn emit_download_failed(&self, ctx: &StorePluginDownloadProgressContext, msg: String) {
        let k = store_download_progress_key(ctx.source_id.as_str(), ctx.plugin_id.as_str());
        if let Ok(mut g) = self.store_download_states.lock() {
            g.remove(&k);
        }
        if let Some(ref cb) = ctx.on_emit {
            cb(StorePluginDownloadProgressEvent {
                source_id: ctx.source_id.clone(),
                plugin_id: ctx.plugin_id.clone(),
                percent: 0,
                received: 0,
                total: None,
                error: Some(msg),
            });
        }
    }

    pub async fn download_plugin_to_temp(
        &self,
        download_url: &str,
        expected_sha256: Option<&str>,
        expected_size: Option<u64>,
        progress: Option<StorePluginDownloadProgressContext>,
    ) -> Result<PathBuf, String> {
        let bytes = self
            .download_plugin_raw(download_url, expected_sha256, expected_size, progress)
            .await?;

        // 创建临时文件：优先从 URL 提取 stem（与 store 缓存 plugin_id 一致），回退到 UUID
        let temp_dir = std::env::temp_dir();
        let file_name = extract_kgpg_filename_from_url(download_url)
            .map(|stem| format!("{}.kgpg", stem))
            .unwrap_or_else(|| format!("plugin_{}.kgpg", Uuid::new_v4()));
        let temp_file = temp_dir.join(&file_name);

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
        self.download_plugin_raw(download_url, expected_sha256, expected_size, None)
            .await
    }

    /// 确保插件缓存存在并版本匹配
    /// 如果缓存不存在或版本不匹配，则下载并缓存
    pub async fn ensure_plugin_cached(
        &self,
        source_id: &str,
        plugin_id: &str,
        download_url: &str,
        expected_sha256: Option<&str>,
        expected_size: Option<u64>,
        expected_version: &str,
        progress: Option<StorePluginDownloadProgressContext>,
    ) -> Result<PathBuf, String> {
        let cache_file =
            crate::app_paths::AppPaths::global().store_plugin_cache_file(source_id, plugin_id);

        // 如果缓存文件存在，检查版本
        if cache_file.exists() {
            match self.read_plugin_manifest(&cache_file) {
                Ok(manifest) => {
                    if manifest.version == expected_version {
                        // 版本匹配，使用缓存
                        return Ok(cache_file);
                    }
                    // 版本不匹配，删除旧缓存
                    let _ = fs::remove_file(&cache_file);
                }
                Err(_) => {
                    // 读取 manifest 失败，删除损坏的缓存
                    let _ = fs::remove_file(&cache_file);
                }
            }
        }

        // 创建缓存目录
        if let Some(parent) = cache_file.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create cache directory: {}", e))?;
        }

        // 下载插件（内存组装完成后一次性写入，无部分文件）
        let bytes = self
            .download_plugin_raw(download_url, expected_sha256, expected_size, progress)
            .await?;

        // 写入缓存文件
        fs::write(&cache_file, &bytes).map_err(|e| format!("Failed to write cache file: {}", e))?;

        Ok(cache_file)
    }

    /// KGPG v2：仅通过 HTTP Range 获取固定头部，并返回 icon（PNG bytes）。
    /// 用于商店列表展示，避免额外的 `<id>.icon.png` 资产。
    pub async fn fetch_remote_plugin_icon_v2(
        &self,
        download_url: &str,
        source_id: Option<&str>,
        plugin_id: Option<&str>,
    ) -> Result<Option<Vec<u8>>, String> {
        // 优先检查缓存文件是否存在（需要 source_id 和 plugin_id）
        if let (Some(source_id), Some(plugin_id)) = (source_id, plugin_id) {
            let cache_file =
                crate::app_paths::AppPaths::global().store_plugin_cache_file(source_id, plugin_id);
            if cache_file.exists() {
                // 从缓存文件读取 icon
                return self.read_plugin_icon(&cache_file);
            }
        }

        // 缓存不存在或参数不完整，走原有 HTTP Range 逻辑
        use reqwest::header::RANGE;

        let mut client_builder = reqwest::Client::builder();
        if let Some(ref proxy_url) = crate::crawler::proxy::get_proxy_config().proxy_url {
            if let Ok(proxy) = reqwest::Proxy::all(proxy_url) {
                client_builder = client_builder.proxy(proxy);
            }
        }
        let client = client_builder
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| format!("Failed to create HTTP client: {}", e))?;
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

    pub async fn load_installed_plugin_detail(
        &self,
        plugin_id: &str,
    ) -> Result<PluginDetail, String> {
        let plugins_dir = self.get_plugins_directory();
        let path = self.find_plugin_file(&plugins_dir, plugin_id).await?;
        let (manifest, doc, base_url) = {
            let guard = self.installed_cache.lock().await;
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
        let icon_data = self.get_plugin_icon_by_id(plugin_id).await.ok().flatten();
        Ok(PluginDetail {
            id: plugin_id.to_string(),
            name: manifest.name_to_value(),
            desp: manifest.description_to_value(),
            version: Some(manifest.version.clone()),
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
        source_id: Option<&str>,
        expected_version: Option<&str>,
    ) -> Result<PluginDetail, String> {
        let cached_path =
            if let (Some(source_id), Some(expected_version)) = (source_id, expected_version) {
                // 使用缓存：确保插件已缓存且版本匹配
                self.ensure_plugin_cached(
                    source_id,
                    plugin_id,
                    download_url,
                    expected_sha256,
                    expected_size,
                    expected_version,
                    None,
                )
                .await?
            } else {
                // 兼容模式：下载到临时文件（用于非商店场景）
                self.download_plugin_to_temp(download_url, expected_sha256, expected_size, None)
                    .await?
            };

        // 读取整个文件到内存（复用原有逻辑）
        let bytes =
            fs::read(&cached_path).map_err(|e| format!("Failed to read cached file: {}", e))?;

        // 检查是否是 kgpgv2 格式，并提取头部 icon（如果存在）
        let mut cursor = std::io::Cursor::new(&bytes);
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

        // 读取 doc（doc_root/doc.md、doc_root/doc.<lang>.md、或兼容 doc.md）
        let doc = collect_doc_from_zip(&mut archive)?;

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
            name: manifest.name_to_value(),
            desp: manifest.description_to_value(),
            version: Some(manifest.version.clone()),
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
        source_id: Option<&str>,
        expected_version: Option<&str>,
    ) -> Result<Vec<u8>, String> {
        match download_url {
            Some(url) => {
                let cached_path = if let (Some(source_id), Some(expected_version)) =
                    (source_id, expected_version)
                {
                    // 使用缓存：确保插件已缓存且版本匹配
                    self.ensure_plugin_cached(
                        source_id,
                        plugin_id,
                        url,
                        expected_sha256,
                        expected_size,
                        expected_version,
                        None,
                    )
                    .await?
                } else {
                    // 兼容模式：下载到临时文件（用于非商店场景）
                    self.download_plugin_to_temp(url, expected_sha256, expected_size, None)
                        .await?
                };

                // 读取整个文件到内存
                let bytes = fs::read(&cached_path)
                    .map_err(|e| format!("Failed to read cached file: {}", e))?;

                // 检查是否是 kgpgv2 格式，需要跳过头部打开 ZIP
                let mut cursor = std::io::Cursor::new(&bytes);
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
                let path = self.find_plugin_file(&plugins_dir, plugin_id).await?;
                self.read_plugin_image(&path, image_path)
            }
        }
    }

    /// 预览导入插件（从 ZIP 文件读取信息）
    /// 即使插件为内置插件不允许覆盖导入，也会返回预览信息，但标记为不可安装
    pub async fn preview_import_from_zip(&self, zip_path: &Path) -> Result<ImportPreview, String> {
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
        let already_exists = self.get(&plugin_id).await.is_some();

        let (can_install, install_error) = (true, None);

        let existing_version = if already_exists {
            self.get(&plugin_id).await.map(|p| p.version)
        } else {
            None
        };

        // TODO: 实现变更日志差异比较
        let change_log_diff = None;

        Ok(ImportPreview {
            id: plugin_id,
            name: manifest.name_to_value(),
            version: manifest.version,
            size_bytes,
            already_exists,
            existing_version,
            change_log_diff,
            can_install,
            install_error,
        })
    }

    /// 前端手动"刷新已安装源"：重扫插件目录并重建缓存（全量刷新）
    /// 仅读取用户目录（data）下的 .kgpg
    pub async fn refresh_installed_plugins_cache(&self) -> Result<(), String> {
        let user_plugins_dir = self.get_plugins_directory();

        let mut by_id: HashMap<String, PathBuf> = HashMap::new();
        let mut plugins: HashMap<String, Plugin> = HashMap::new();
        let mut files: HashMap<PathBuf, KgpgFileCacheEntry> = HashMap::new();

        // 仅扫描用户目录（data）
        if user_plugins_dir.exists() {
            let entries = fs::read_dir(&user_plugins_dir)
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
                let plugin = Plugin {
                    id: plugin_id.clone(),
                    name: parsed.manifest.name_to_value(),
                    description: parsed.manifest.description_to_value(),
                    version: parsed.manifest.version.clone(),
                    base_url: parsed
                        .config
                        .as_ref()
                        .and_then(|c| c.base_url.clone())
                        .unwrap_or_default(),
                    size_bytes: stamp.len,
                    config: HashMap::new(),
                    selector: parsed.config.clone().and_then(|c| c.selector),
                    script_type: parsed.script_type.clone(),
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

        let mut guard = self.installed_cache.lock().await;
        guard.initialized = true;
        guard.user_plugins_dir = user_plugins_dir;
        guard.by_id = by_id;
        guard.plugins = plugins;
        guard.files = files;
        Ok(())
    }

    /// 安装/更新/删除后：按 pluginId 局部刷新（部分刷新）
    /// 仅从用户目录（data）查找指定 plugin_id
    pub async fn refresh_installed_plugin_cache(&self, plugin_id: &str) -> Result<(), String> {
        let user_plugins_dir = self.get_plugins_directory();

        // 先处理目录切换
        {
            let guard = self.installed_cache.lock().await;
            if guard.initialized && guard.user_plugins_dir != user_plugins_dir {
                drop(guard);
                return self.refresh_installed_plugins_cache().await;
            }
        } // guard 在此处 drop，避免下方重新获取锁时死锁

        // 仅从用户目录查找
        let mut found_path = None;
        if user_plugins_dir.exists() {
            let expected = user_plugins_dir.join(format!("{}.kgpg", plugin_id));
            if expected.is_file() {
                found_path = Some(expected);
            } else {
                // 兜底：扫目录找 stem=plugin_id
                let entries = fs::read_dir(&user_plugins_dir)
                    .map_err(|e| format!("Failed to read plugins directory: {}", e))?;
                for entry in entries {
                    let entry =
                        entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
                    let path = entry.path();
                    if path.is_file() && path.extension().and_then(|s| s.to_str()) == Some("kgpg") {
                        let stem = path
                            .file_stem()
                            .and_then(|s| s.to_str())
                            .unwrap_or("")
                            .to_string();
                        if stem == plugin_id {
                            found_path = Some(path);
                            break;
                        }
                    }
                }
            }
        }

        // 找到文件：重新解析并更新（不持锁做 IO）
        if let Some(path) = found_path {
            let stamp = FileStamp::from_path(&path)?;
            let parsed = self.parse_kgpg_for_cache(&path)?;

            let plugin = Plugin {
                id: plugin_id.to_string(),
                name: parsed.manifest.name_to_value(),
                description: parsed.manifest.description_to_value(),
                version: parsed.manifest.version.clone(),
                base_url: parsed
                    .config
                    .as_ref()
                    .and_then(|c| c.base_url.clone())
                    .unwrap_or_default(),
                size_bytes: stamp.len,
                config: HashMap::new(),
                selector: parsed.config.clone().and_then(|c| c.selector),
                script_type: parsed.script_type.clone(),
            };

            let mut guard = self.installed_cache.lock().await;
            guard.initialized = true;
            guard.user_plugins_dir = user_plugins_dir;

            // 如果已存在（可能是用户目录的），先移除旧条目
            if let Some(old_path) = guard.by_id.remove(plugin_id) {
                guard.files.remove(&old_path);
            }

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
        let mut guard = self.installed_cache.lock().await;
        guard.initialized = true;
        guard.user_plugins_dir = user_plugins_dir;
        if let Some(old_path) = guard.by_id.remove(plugin_id) {
            guard.files.remove(&old_path);
        }
        guard.plugins.remove(plugin_id);
        Ok(())
    }

    /// 确保已安装插件缓存已初始化（公开函数，用于启动时初始化）
    pub async fn ensure_installed_cache_initialized(&self) -> Result<(), String> {
        let user_plugins_dir = self.get_plugins_directory();
        {
            let guard = self.installed_cache.lock().await;
            if guard.initialized && guard.user_plugins_dir == user_plugins_dir {
                return Ok(());
            }
        }
        self.refresh_installed_plugins_cache().await
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

        // doc（doc_root/doc.md、doc_root/doc.<lang>.md、或兼容 doc.md）
        let doc = collect_doc_from_zip(&mut archive)?;

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

        // 脚本类型：存在 crawl.js 为 js，否则为 rhai（安卓仅支持 rhai）
        let script_type = if archive.by_name("crawl.js").is_ok() {
            "js".to_string()
        } else {
            "rhai".to_string()
        };

        Ok(ParsedKgpgForCache {
            manifest,
            config,
            doc,
            icon_present,
            script_type,
        })
    }
}

/// 获取用户插件目录（不依赖 AppHandle / PluginManager 实例）。
///
/// 说明：
/// - 这是 `PluginManager::get_plugins_directory()` 的可复用实现。
/// - 仅返回用户数据目录，用于写入操作（导入、删除等）。
/// - 读取插件时应该使用 `PluginManager` 的方法，它们会合并内置和用户目录。
pub fn plugins_directory_for_readonly() -> PathBuf {
    crate::app_paths::AppPaths::global().plugins_dir()
}

/// 查找插件文件路径（同步函数，仅查用户目录 data）
///
/// 用于不方便使用 async PluginManager 的场景（如 vd_ops.rs）
pub fn find_plugin_kgpg_path(plugin_id: &str) -> Option<PathBuf> {
    let user_dir = plugins_directory_for_readonly();
    let user_path = user_dir.join(format!("{}.kgpg", plugin_id));
    if user_path.is_file() {
        return Some(user_path);
    }
    None
}

/// 从任意 `.kgpg` 文件读取 manifest.json（优先 KGPG v2 头部）。
///
/// 说明：
/// - 这是 `PluginManager::read_plugin_manifest()` 的可复用实现。
pub fn read_plugin_manifest_from_kgpg_file(zip_path: &Path) -> Result<PluginManifest, String> {
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrowserPlugin {
    pub id: String,
    /// 同 Plugin.name，string 或 { name?, ja?, ko?, ... }
    pub name: serde_json::Value,
    /// 同 Plugin.description
    pub desp: serde_json::Value,
    pub icon: Option<String>,
    pub file_path: Option<String>,
    /// 文档多语言：{ "default": "...", "zh": "...", "en": ... }
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doc: Option<PluginDoc>,
}

// 插件清单（manifest.json）中 name/description 的国际化：仅 Record，扁平键 "name"（默认）、"name.zh"、"name.ja" 等
pub type ManifestI18nText = HashMap<String, String>;

/// 插件文档多语言：键 "default"（doc.md / doc_root/doc.md）及 "zh"、"en"、"ja"、"ko" 等（doc_root/doc.<lang>.md）
pub type PluginDoc = HashMap<String, String>;

/// 从已打开的 ZIP 中收集所有 doc 条目，返回键为 "default" 及语言码的 HashMap。
fn collect_doc_from_zip<R: std::io::Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
) -> Result<Option<PluginDoc>, String> {
    use std::io::Read;
    let mut map = PluginDoc::new();
    for i in 0..archive.len() {
        let mut f = archive
            .by_index(i)
            .map_err(|e| format!("Failed to get zip entry {}: {}", i, e))?;
        let name = f.name().to_string();
        let key: Option<String> = if name == "doc_root/doc.md" {
            Some("default".to_string())
        } else if name == "doc.md" {
            Some("default".to_string())
        } else if name.starts_with("doc_root/doc.") && name.ends_with(".md") {
            let lang = name
                .trim_start_matches("doc_root/doc.")
                .trim_end_matches(".md");
            if lang.is_empty() {
                None
            } else {
                Some(lang.to_string())
            }
        } else {
            None
        };
        if let Some(k) = key {
            if k == "default" && name == "doc.md" && map.contains_key("default") {
                continue;
            }
            let mut content = String::new();
            f.read_to_string(&mut content)
                .map_err(|e| format!("Failed to read doc {}: {}", name, e))?;
            map.insert(k, content);
        }
    }
    if map.is_empty() {
        Ok(None)
    } else {
        Ok(Some(map))
    }
}

fn extract_manifest_text_from_flat(
    obj: &serde_json::Map<String, serde_json::Value>,
    base_key: &str,
) -> ManifestI18nText {
    let mut out = HashMap::new();
    if let Some(v) = obj.get(base_key).and_then(|v| v.as_str()) {
        out.insert(base_key.to_string(), v.to_string());
    }
    let prefix = format!("{}.", base_key);
    for (k, v) in obj {
        if let Some(s) = v.as_str() {
            if k == base_key {
                out.insert(k.clone(), s.to_string());
            } else if k.starts_with(&prefix) {
                out.insert(k.clone(), s.to_string());
            }
        }
    }
    out
}

impl PluginManifest {
    /// 取默认字符串：键 "name" 或 "description"（无点后缀）
    pub fn name_fallback(&self) -> String {
        self.name.get("name").cloned().unwrap_or_default()
    }
    pub fn description_fallback(&self) -> String {
        self.description
            .get("description")
            .cloned()
            .unwrap_or_default()
    }
}

// 插件清单（manifest.json），扁平键 name / name.zh / name.ja，description / description.zh ...
#[derive(Debug, Clone, Serialize)]
pub struct PluginManifest {
    pub name: ManifestI18nText,
    pub version: String,
    pub description: ManifestI18nText,
    #[serde(default)]
    pub author: String,
}

impl<'de> Deserialize<'de> for PluginManifest {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let obj = serde_json::Value::deserialize(deserializer)?;
        let map = obj
            .as_object()
            .ok_or_else(|| serde::de::Error::custom("manifest must be an object"))?;
        let version = map
            .get("version")
            .and_then(|v| v.as_str())
            .unwrap_or("1.0.0")
            .to_string();
        let author = map
            .get("author")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let name = extract_manifest_text_from_flat(map, "name");
        let description = extract_manifest_text_from_flat(map, "description");
        Ok(PluginManifest {
            name,
            version,
            description,
            author,
        })
    }
}

/// 将 index.json 中的 description（或 name）字段（字符串或对象）归一化为前端 i18n 结构：{ "default": string, "zh"?: string, ... }。
/// 前端用 resolveManifestText(value, locale) 解析。
pub fn index_manifest_text_to_frontend_value(v: Option<&serde_json::Value>) -> serde_json::Value {
    let v = match v {
        Some(x) => x,
        None => return serde_json::json!({ "default": "" }),
    };
    if let Some(s) = v.as_str() {
        return serde_json::json!({ "default": s });
    }
    if let Some(obj) = v.as_object() {
        let mut out = serde_json::Map::new();
        for (k, val) in obj {
            if let Some(s) = val.as_str() {
                let key = if k == "default" {
                    "default"
                } else {
                    k.as_str()
                };
                out.insert(key.to_string(), serde_json::Value::String(s.to_string()));
            }
        }
        if !out.contains_key("default") {
            let fallback = obj
                .get("en")
                .and_then(|x| x.as_str())
                .or_else(|| obj.values().find_map(|x| x.as_str()))
                .unwrap_or("");
            out.insert(
                "default".to_string(),
                serde_json::Value::String(fallback.to_string()),
            );
        }
        return serde_json::Value::Object(out);
    }
    serde_json::json!({ "default": "" })
}

/// 将内部扁平键（"name"/"name.zh"/"name.ja"）转为前端结构：{ "default": ..., "zh": ..., "ja": ... }
fn manifest_i18n_to_frontend_value(map: &ManifestI18nText, base_key: &str) -> serde_json::Value {
    let mut out = serde_json::Map::new();
    let prefix = format!("{}.", base_key);
    for (k, v) in map {
        let key = if k == base_key {
            "default".to_string()
        } else if k.starts_with(&prefix) {
            k[prefix.len()..].to_string()
        } else {
            continue;
        };
        out.insert(key, serde_json::Value::String(v.clone()));
    }
    serde_json::Value::Object(out)
}

impl PluginManifest {
    pub fn name_to_value(&self) -> serde_json::Value {
        manifest_i18n_to_frontend_value(&self.name, "name")
    }
    pub fn description_to_value(&self) -> serde_json::Value {
        manifest_i18n_to_frontend_value(&self.description, "description")
    }
}

/// 从已序列化的 name/description Value 取回退展示字符串（用于 CLI/日志等无 locale 场景）。
/// Value 为前端结构：{ "default": ..., "zh": ..., "ja": ... }，默认键为 "default"。
pub fn manifest_value_to_display_string(v: &serde_json::Value) -> String {
    let m = match v.as_object() {
        Some(m) => m,
        None => return String::new(),
    };
    m.get("default")
        .and_then(|v| v.as_str())
        .map(String::from)
        .unwrap_or_default()
}

// 变量定义（config.json 中的 var 字段，现在是数组格式）
/// 选项：兼容 ["high","medium"] 或 [{ "name": "...", "variable": "..." }]；name 支持扁平多语言 name / name.zh / name.en
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[serde(untagged)]
pub enum VarOption {
    String(String),
    Item {
        name: ManifestI18nText,
        variable: String,
    },
}

impl<'de> Deserialize<'de> for VarOption {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let v = serde_json::Value::deserialize(deserializer)?;
        if let Some(s) = v.as_str() {
            return Ok(VarOption::String(s.to_string()));
        }
        let map = v
            .as_object()
            .ok_or_else(|| serde::de::Error::custom("VarOption: object or string"))?;
        let variable = map
            .get("variable")
            .and_then(|x| x.as_str())
            .ok_or_else(|| serde::de::Error::custom("VarOption Item: missing variable"))?
            .to_string();
        let name = extract_manifest_text_from_flat(map, "name");
        if name.is_empty() {
            return Err(serde::de::Error::custom("VarOption Item: missing name"));
        }
        Ok(VarOption::Item { name, variable })
    }
}

// 变量定义（config.json 中的 var 字段）；name/descripts 支持扁平多语言 name / name.zh / name.en
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VarDefinition {
    pub key: String,
    #[serde(rename = "type")]
    pub var_type: String,
    pub name: ManifestI18nText,
    #[serde(default)]
    pub descripts: Option<ManifestI18nText>,
    #[serde(default)]
    pub default: Option<serde_json::Value>,
    #[serde(default)]
    pub options: Option<Vec<VarOption>>,
    #[serde(default)]
    pub min: Option<serde_json::Value>,
    #[serde(default)]
    pub max: Option<serde_json::Value>,
    #[serde(default)]
    pub when: Option<HashMap<String, Vec<String>>>,
}

impl<'de> Deserialize<'de> for VarDefinition {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let obj = serde_json::Value::deserialize(deserializer)?;
        let map = obj
            .as_object()
            .ok_or_else(|| serde::de::Error::custom("VarDefinition: must be object"))?;
        let key = map
            .get("key")
            .and_then(|v| v.as_str())
            .ok_or_else(|| serde::de::Error::custom("VarDefinition: missing key"))?
            .to_string();
        let var_type = map
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("string")
            .to_string();
        let name = extract_manifest_text_from_flat(map, "name");
        if name.is_empty() {
            return Err(serde::de::Error::custom("VarDefinition: missing name"));
        }
        let descripts = {
            let d = extract_manifest_text_from_flat(map, "descripts");
            if d.is_empty() {
                None
            } else {
                Some(d)
            }
        };
        let default = map.get("default").cloned();
        let options: Option<Vec<VarOption>> = map.get("options").and_then(|v| {
            let arr = v.as_array()?;
            let mut out = Vec::with_capacity(arr.len());
            for item in arr {
                if let Some(s) = item.as_str() {
                    out.push(VarOption::String(s.to_string()));
                } else if let Some(m) = item.as_object() {
                    let variable = m.get("variable").and_then(|x| x.as_str())?.to_string();
                    let name = extract_manifest_text_from_flat(m, "name");
                    if !name.is_empty() {
                        out.push(VarOption::Item { name, variable });
                    }
                }
            }
            Some(out)
        });
        let min = map.get("min").cloned();
        let max = map.get("max").cloned();
        let when: Option<HashMap<String, Vec<String>>> = map
            .get("when")
            .and_then(|v| serde_json::from_value(v.clone()).ok());
        Ok(VarDefinition {
            key,
            var_type,
            name,
            descripts,
            default,
            options,
            min,
            max,
            when,
        })
    }
}

/// 将变量定义转为前端 i18n 结构：name/descripts/options[].name 为 Record (default, zh, en...)，便于前端按 locale 解析。
pub fn var_definition_to_frontend_value(v: &VarDefinition) -> serde_json::Value {
    let mut obj = serde_json::Map::new();
    obj.insert("key".to_string(), serde_json::Value::String(v.key.clone()));
    obj.insert(
        "type".to_string(),
        serde_json::Value::String(v.var_type.clone()),
    );
    obj.insert(
        "name".to_string(),
        manifest_i18n_to_frontend_value(&v.name, "name"),
    );
    if let Some(ref d) = v.descripts {
        obj.insert(
            "descripts".to_string(),
            manifest_i18n_to_frontend_value(d, "descripts"),
        );
    }
    if let Some(ref default) = v.default {
        obj.insert("default".to_string(), default.clone());
    }
    if let Some(ref opts) = v.options {
        let arr: Vec<serde_json::Value> = opts
            .iter()
            .map(|o| match o {
                VarOption::String(s) => {
                    let mut m = serde_json::Map::new();
                    m.insert("variable".to_string(), serde_json::Value::String(s.clone()));
                    let mut name_m = serde_json::Map::new();
                    name_m.insert("default".to_string(), serde_json::Value::String(s.clone()));
                    m.insert("name".to_string(), serde_json::Value::Object(name_m));
                    serde_json::Value::Object(m)
                }
                VarOption::Item { name, variable } => {
                    let mut m = serde_json::Map::new();
                    m.insert(
                        "variable".to_string(),
                        serde_json::Value::String(variable.clone()),
                    );
                    m.insert(
                        "name".to_string(),
                        manifest_i18n_to_frontend_value(name, "name"),
                    );
                    serde_json::Value::Object(m)
                }
            })
            .collect();
        obj.insert("options".to_string(), serde_json::Value::Array(arr));
    }
    if let Some(ref min) = v.min {
        obj.insert("min".to_string(), min.clone());
    }
    if let Some(ref max) = v.max {
        obj.insert("max".to_string(), max.clone());
    }
    if let Some(ref when) = v.when {
        let when_val = serde_json::to_value(when).unwrap_or(serde_json::Value::Null);
        obj.insert("when".to_string(), when_val);
    }
    serde_json::Value::Object(obj)
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
}

// 商店插件（从源解析后的插件信息）
/// name/description 与已安装插件一致：前端 i18n 对象 { "default": string, "zh"?: string, ... }，由 index.json 对应字段（字符串或对象）归一化而来。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorePluginResolved {
    pub id: String,
    /// 前端按 locale 解析：resolveManifestText(name, locale)
    pub name: serde_json::Value,
    pub version: String,
    /// 前端按 locale 解析：resolveManifestText(description, locale)
    pub description: serde_json::Value,
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
    /// 当前商店下载进度 0–100（仅当该插件包正在下载时由后端合并）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub store_download_progress: Option<u8>,
    /// 最近一次下载错误（通常已随事件推送，列表侧可为空）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub store_download_error: Option<String>,
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
    /// string 或 { name?, ja?, ko?, ... }，前端按 locale 解析
    pub name: serde_json::Value,
    pub version: String,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
    #[serde(rename = "alreadyExists")]
    pub already_exists: bool,
    #[serde(rename = "existingVersion")]
    pub existing_version: Option<String>,
    #[serde(rename = "changeLogDiff")]
    pub change_log_diff: Option<String>,
    /// 是否允许安装（false 时表示不允许安装，如内置插件）
    #[serde(rename = "canInstall", default = "default_true")]
    pub can_install: bool,
    /// 不允许安装时的错误信息
    #[serde(rename = "installError", skip_serializing_if = "Option::is_none")]
    pub install_error: Option<String>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDetail {
    pub id: String,
    /// string 或 { name?, ja?, ko?, ... }，前端按 locale 解析
    pub name: serde_json::Value,
    pub desp: serde_json::Value,
    /// manifest.json 中的版本号
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// 文档多语言：{ "default": "...", "zh": "...", "en": ... }
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doc: Option<PluginDoc>,
    #[serde(rename = "iconData", skip_serializing_if = "Option::is_none")]
    pub icon_data: Option<Vec<u8>>,
    /// installed | remote
    pub origin: String,
    /// 插件的基础URL（从 config.json 中读取）
    #[serde(rename = "baseUrl", skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
}

/// 从 URL 路径最后一段解析出插件 ID（**不含** `.kgpg` 后缀）。
/// `store_plugin_cache_file` 会再拼接 `.kgpg`，故此处必须返回 stem，避免出现 `foo.kgpg.kgpg`。
/// 例如：`.../anime-pictures.kgpg` -> `Some("anime-pictures")`
pub fn extract_kgpg_filename_from_url(url_str: &str) -> Option<String> {
    let url = Url::parse(url_str).ok()?;
    let file_name = url.path_segments().and_then(|segments| segments.last())?;
    if !file_name.ends_with(".kgpg") || file_name.len() <= 5 {
        return None;
    }
    let stem = file_name.trim_end_matches(".kgpg");
    if stem.is_empty() {
        return None;
    }
    Some(stem.to_string())
}
