// metadata 迁移引擎（裸 deno_core JsRuntime）与 V8 爬虫运行时。
// 两者均依赖 deno_core（Cargo.toml 已按 not(ios) 门控），故 iOS 排除。
#[cfg(all(not(target_os = "ios"), feature = "plugin-runtime"))]
pub mod metadata_migration;
// 嵌入式 V8 后端：桌面 + Android（仅 iOS 不支持）。
#[cfg(all(not(target_os = "ios"), feature = "plugin-runtime"))]
pub mod v8;

use arc_swap::ArcSwap;
use futures_util::StreamExt;
use reqwest;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::Arc;
use std::sync::OnceLock;
use std::time::Duration;
use std::time::Instant;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use url::Url;
use uuid::Uuid;
use zip::ZipArchive;

use pathql_rs::{
    ContribQuery, InvokeByName, Json5Loader, List, Loader, Namespace, ProviderDef,
    ProviderInvocation, ProviderName, Query, Resolve, SimpleName, Source, SqlExpr,
};

/// 脚本后端枚举（core 权威定义）。kbBackend 字符串解析目标。
/// Rhai 后端已移除：`kbBackend: "rhai"` 会在解析时报可读错误。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PluginBackend {
    V8,
    Webview,
}

impl FromStr for PluginBackend {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "v8" => Ok(PluginBackend::V8),
            "webview" => Ok(PluginBackend::Webview),
            "rhai" => Err(
                "Rhai 后端已停止支持，请更新该插件（迁移到 v8 / webview 后端）".to_string(),
            ),
            _ => Err(format!("不支持的脚本后端: \"{}\"，支持 v8 / webview", s)),
        }
    }
}

impl PluginBackend {
    fn script_type_str(self) -> &'static str {
        match self {
            PluginBackend::V8 => "v8",
            PluginBackend::Webview => "js",
        }
    }
}

/// 插件脚本（package.json + main）。旧版 manifest.json (v2) 与 Rhai 均已移除。
/// `backend` 为 `None` 表示无可执行脚本（如内置 local-import）。
#[derive(Debug, Clone, Default)]
pub struct PluginScript {
    backend: Option<PluginBackend>,
    source: String,
}

impl PluginScript {
    fn new(backend: PluginBackend, source: String) -> Self {
        Self {
            backend: Some(backend),
            source,
        }
    }

    fn script_type_str(&self) -> &'static str {
        match self.backend {
            Some(backend) => backend.script_type_str(),
            None => "js",
        }
    }

    pub fn js_source(&self) -> Option<&str> {
        matches!(self.backend, Some(PluginBackend::Webview)).then(|| self.source.as_str())
    }

    pub fn v8_source(&self) -> Option<&str> {
        matches!(self.backend, Some(PluginBackend::V8)).then(|| self.source.as_str())
    }
}

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
    /// 脚本类型：js（webview crawl.js）或 v8（自包含 ES module）。
    #[serde(rename = "scriptType")]
    pub script_type: String,
    /// manifest.json 可选字段：运行本插件所需的最低 Kabegame 应用版本（semver 主.次.补丁）
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        rename = "minAppVersion"
    )]
    pub min_app_version: Option<String>,
    /// 插件包文件路径（.kgpg），仅已安装插件有值
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "filePath")]
    pub file_path: Option<String>,
    /// 多语言文档：键为 "default"、"zh"、"en" 等
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub doc: Option<PluginDoc>,
    /// 图标 PNG 的 base64 编码（data:image/png;base64,... 不含前缀）
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        rename = "iconPngBase64"
    )]
    pub icon_png_base64: Option<String>,
    /// templates/description.ejs 内容
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        rename = "descriptionTemplate"
    )]
    pub description_template: Option<String>,
    /// configs/*.json 推荐运行配置列表（每项含 pluginId、filename 及预设字段）
    #[serde(
        default,
        skip_serializing_if = "Vec::is_empty",
        rename = "recommendedConfigs"
    )]
    pub recommended_configs: Vec<serde_json::Value>,
    /// 插件变量定义（来自 config.json 的 var 数组），仅后端使用，不序列化到前端
    #[serde(skip)]
    pub var_defs: Vec<VarDefinition>,
    /// 脚本内容及后端类型，仅后端使用，不序列化到前端
    #[serde(skip)]
    pub script: PluginScript,
    /// doc_root 下的非 .md 资源文件（图片等），键为相对路径，值为 base64 编码
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        rename = "docResources"
    )]
    pub doc_resources: Option<HashMap<String, String>>,
    /// 插件内 providers/ 解析出的 DSL，仅后端使用，不序列化到前端。
    #[serde(skip)]
    pub providers: Vec<PluginProviderDef>,
    /// kbMetadataMigration 单一迁移脚本源码（ES module，export migrate），仅后端使用，不序列化到前端。
    #[serde(skip)]
    pub metadata_migration: Option<String>,
    /// 插件版本的 packed 编码（每字节一段，`3.4.1` → `0x00030401`），仅后端使用，不序列化到前端。
    /// 用作 `image_metadata.plugin_version` 的写入值与迁移门控阈值。
    #[serde(skip)]
    pub version_packed: u32,
}

#[derive(Debug, Clone)]
pub struct PluginProviderDef {
    pub source_path: String,
    pub def: ProviderDef,
}

pub struct PluginManager {
    /// 已安装插件：None = 未初始化，Some = 已加载。
    plugins: ArcSwap<Option<InstalledPlugins>>,
    /// 商店插件缓存（已下载到本地的 .kgpg）；source_id → plugin_id → Plugin
    store_plugin_cache: ArcSwap<HashMap<String, HashMap<String, Plugin>>>,
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

/// 下载进度上下文：标识正在下载的插件，用于 `store_download_states` 合并和全局事件推送
pub struct StorePluginDownloadProgressContext {
    pub source_id: String,
    pub plugin_id: String,
}

fn store_download_progress_key(source_id: &str, plugin_id: &str) -> String {
    format!("{}::{}", source_id, plugin_id)
}

// 全局 PluginManager 单例
static PLUGIN_MANAGER: OnceLock<PluginManager> = OnceLock::new();

/// 已安装插件类型：plugin_id → Arc<Plugin>。
/// 使用 Arc 避免 HashMap clone 时复制整个 Plugin（仅复制 Arc 指针）。
type InstalledPlugins = HashMap<String, Arc<Plugin>>;

impl PluginManager {
    pub fn new() -> Self {
        Self {
            plugins: ArcSwap::from_pointee(None),
            store_plugin_cache: ArcSwap::from_pointee(HashMap::new()),
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

    /// 尝试获取全局 PluginManager（未初始化时返回 None）
    pub fn global_opt() -> Option<&'static PluginManager> {
        PLUGIN_MANAGER.get()
    }

    /// 将预置在 AppPaths::bundled_plugins_dir()（resources/plugins/）下的 .kgpg
    /// 移动进用户插件目录 AppPaths::plugins_dir()（data/plugins-directory）。
    ///
    /// 仅桌面/web（非 Android）；由 `init_kgpg_plugin()` 在插件缓存初始化之前
    /// 无条件调用一次。尽力而为：任何一步失败仅 eprintln! 记录，不返回 Err、不 panic。
    ///
    /// 幂等/一次性：文件被移动后 resources/plugins/ 随之清空，此后每次启动该目录
    /// 为空、函数立即返回；只有应用更新重新铺出新 .kgpg 才会再次触发搬运（且会
    /// 覆盖用户目录里的同名旧版本）。
    #[cfg(not(target_os = "android"))]
    pub async fn seed_bundled_plugins(&self) {
        let app_paths = crate::app_paths::AppPaths::global();

        let bundled_dir = app_paths.bundled_plugins_dir();
        let mut entries = match tokio::fs::read_dir(&bundled_dir).await {
            Ok(entries) => entries,
            // 目录不存在/不可读：dev 环境（不打包 resources）下必然如此，静默跳过
            Err(_) => return,
        };

        let user_dir = app_paths.plugins_dir();
        if let Err(e) = tokio::fs::create_dir_all(&user_dir).await {
            eprintln!("[plugin] seed_bundled_plugins: 创建用户插件目录失败: {e}");
            return;
        }

        loop {
            let entry = match entries.next_entry().await {
                Ok(Some(e)) => e,
                Ok(None) => break,
                Err(e) => {
                    eprintln!("[plugin] seed_bundled_plugins: 读取目录项失败: {e}");
                    break;
                }
            };
            let src = entry.path();
            if !(src.is_file() && src.extension().and_then(|s| s.to_str()) == Some("kgpg")) {
                continue;
            }
            let Some(file_name) = src.file_name() else {
                continue;
            };
            let dst = user_dir.join(file_name);

            // 预置版本始终覆盖用户目录中的同名旧版本（应用更新场景）
            if dst.exists() {
                if let Err(e) = tokio::fs::remove_file(&dst).await {
                    eprintln!(
                        "[plugin] seed_bundled_plugins: 删除旧插件文件失败 {}: {e}",
                        dst.display()
                    );
                    continue;
                }
            }

            if tokio::fs::rename(&src, &dst).await.is_ok() {
                continue;
            }
            // rename 失败（如跨盘/跨卷）：回退为 copy + remove_file
            if let Err(e) = tokio::fs::copy(&src, &dst).await {
                eprintln!(
                    "[plugin] seed_bundled_plugins: 搬运插件失败 {} -> {}: {e}",
                    src.display(),
                    dst.display()
                );
                continue;
            }
            if let Err(e) = tokio::fs::remove_file(&src).await {
                eprintln!(
                    "[plugin] seed_bundled_plugins: 清理源文件失败 {}: {e}",
                    src.display()
                );
            }
        }
    }

    /// 启动时初始化商店插件缓存：扫描 store-cache 目录，将已下载的 .kgpg 解析为 Plugin 放入内存
    pub async fn init_store_plugin_cache(&self) -> Result<(), String> {
        let store_cache_dir = crate::app_paths::AppPaths::global().store_cache_dir();
        let mut cache: HashMap<String, HashMap<String, Plugin>> = HashMap::new();

        if !store_cache_dir.exists() {
            return Ok(());
        }

        // 遍历 store-cache/<source_id>/<plugin_id>.kgpg
        let source_dirs = fs::read_dir(&store_cache_dir)
            .map_err(|e| format!("Failed to read store cache dir: {}", e))?;
        for source_entry in source_dirs {
            let source_entry =
                source_entry.map_err(|e| format!("Failed to read source dir entry: {}", e))?;
            let source_path = source_entry.path();
            if !source_path.is_dir() {
                continue;
            }
            let source_id = source_path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            if source_id.is_empty() {
                continue;
            }

            let plugin_files = match fs::read_dir(&source_path) {
                Ok(rd) => rd,
                Err(_) => continue,
            };
            for plugin_entry in plugin_files {
                let plugin_entry = match plugin_entry {
                    Ok(e) => e,
                    Err(_) => continue,
                };
                let path = plugin_entry.path();
                if !(path.is_file() && path.extension().and_then(|s| s.to_str()) == Some("kgpg")) {
                    continue;
                }
                match self.parse_kgpg(&path).await {
                    Ok(plugin) => {
                        let pid = plugin.id.clone();
                        cache
                            .entry(source_id.clone())
                            .or_default()
                            .insert(pid, plugin);
                    }
                    Err(_) => {
                        // 解析失败：删除损坏的缓存文件
                        let _ = fs::remove_file(&path);
                    }
                }
            }
        }

        self.store_plugin_cache.store(Arc::new(cache));
        Ok(())
    }

    /// 从缓存获取所有已安装的插件
    pub fn get_all(&self) -> Result<Vec<Arc<Plugin>>, String> {
        let guard = self.plugins.load_full();
        let mut plugins: Vec<Arc<Plugin>> = match guard.as_ref().as_ref() {
            Some(m) => m.values().map(|a| (*a).clone()).collect(),
            None => Vec::new(),
        };
        plugins.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(plugins)
    }

    /// 同步获取 Plugin（无锁读 ArcSwap 快照）。
    pub fn get(&self, id: &str) -> Option<Arc<Plugin>> {
        let guard = self.plugins.load_full();
        let plugins = guard.as_ref().as_ref()?;
        plugins.get(id).map(|a| (*a).clone())
    }

    /// 同步读取已安装缓存中的插件展示名（不做磁盘 IO）。
    /// - 仅使用内存缓存；缓存未初始化时返回 None。
    pub fn get_cached_plugin_display_name_sync(&self, plugin_id: &str) -> Option<String> {
        let guard = self.plugins.load();
        let plugins = guard.as_ref().as_ref()?;
        let plugin = plugins.get(plugin_id)?;
        let name = manifest_value_to_display_string(&plugin.name)
            .trim()
            .to_string();
        if name.is_empty() {
            None
        } else {
            Some(name)
        }
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
            let plugin = self.parse_kgpg(&p).await?;
            let var_defs = plugin.var_defs.clone();
            return Ok((plugin, Some(p), var_defs));
        }

        // id 模式（已安装）
        let plugin = self.get(id_or_path).ok_or("Plugin not found!")?;
        let var_defs = plugin.var_defs.clone();
        Ok(((*plugin).clone(), None, var_defs))
    }

    /// 调度器/任务场景：支持"已安装插件（plugin_id）"或"指定 `.kgpg` 文件临时运行"。
    pub async fn resolve_plugin_for_task_request(
        &self,
        plugin_id: &str,
        plugin_file_path: Option<&str>,
    ) -> Result<(Plugin, Option<PathBuf>), String> {
        if let Some(p) = plugin_file_path {
            let path = PathBuf::from(p);
            let plugin = self.parse_kgpg(&path).await?;
            return Ok((plugin, Some(path)));
        }
        self.ensure_installed_cache_initialized().await?;
        let plugin = self.get(plugin_id).ok_or("找不到插件")?;
        Ok(((*plugin).clone(), None))
    }

    /// 删除插件（仅删除用户插件目录 data/plugins-directory 中的 .kgpg 文件）
    pub async fn delete(&self, id: &str) -> Result<(), String> {
        let user_plugins_dir = self.get_plugins_directory();
        let path = user_plugins_dir.join(format!("{}.kgpg", id));
        if !path.is_file() {
            return Err(format!("插件 {} 不在用户插件目录中或不存在", id));
        }
        fs::remove_file(&path).map_err(|e| format!("Failed to delete plugin file: {}", e))?;
        if let Err(e) = crate::storage::Storage::global().plugin_data().delete(id) {
            eprintln!("[plugin-data] cleanup failed for {id}: {e}");
        }
        // 删除后局部刷新缓存（避免前端仍看到旧列表/旧图标）
        self.refresh_plugin(id).await?;

        // 发送插件删除事件
        if let Some(emitter) = crate::emitter::GlobalEmitter::try_global() {
            emitter.emit_plugin_deleted(id);
        }

        Ok(())
    }

    pub fn get_plugins_directory(&self) -> PathBuf {
        crate::app_paths::AppPaths::global().plugins_dir()
    }

    fn register_plugin_providers(&self, plugin: &Plugin) -> Result<(), String> {
        let defs: Vec<ProviderDef> = plugin.providers.iter().map(|p| p.def.clone()).collect();
        validate_plugin_provider_defs(&plugin.id, &defs)?;
        if defs.is_empty() {
            return Ok(());
        }

        let runtime = crate::providers::provider_runtime();
        for def in defs {
            runtime
                .register_provider(def)
                .map_err(|e| format!("register plugin `{}` provider failed: {}", plugin.id, e))?;
        }
        Ok(())
    }

    fn replace_plugin_providers(&self, old: Option<&Plugin>, new: &Plugin) -> Result<(), String> {
        let defs: Vec<ProviderDef> = new.providers.iter().map(|p| p.def.clone()).collect();
        validate_plugin_provider_defs(&new.id, &defs)?;
        if let Some(old) = old {
            self.unregister_plugin_providers(old)?;
        }
        self.register_plugin_providers(new)
    }

    fn unregister_plugin_providers(&self, plugin: &Plugin) -> Result<(), String> {
        if plugin.providers.is_empty() {
            return Ok(());
        }
        let runtime = crate::providers::provider_runtime();
        for provider in &plugin.providers {
            let namespace = provider
                .def
                .namespace
                .as_ref()
                .map(|ns| ns.0.as_str())
                .unwrap_or("");
            runtime.unregister_provider(namespace, provider.def.name.0.as_str());
        }
        Ok(())
    }

    /// 从 ZIP 格式的插件文件中读取 manifest.json
    pub async fn read_plugin_manifest(&self, zip_path: &Path) -> Result<PluginManifest, String> {
        read_plugin_manifest_from_kgpg_file(zip_path).await
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
    pub async fn read_plugin_icon(&self, zip_path: &Path) -> Result<Option<Vec<u8>>, String> {
        // v2：优先读取头部固定 icon（RGB24 raw），并转换为 PNG bytes（前端保持不变）
        if let Ok(Some(rgb)) = crate::kgpg::read_kgpg2_icon_rgb_from_file(zip_path).await {
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

    /// 从 ZIP 格式的插件文件中读取 config.json
    fn read_plugin_config(&self, zip_path: &Path) -> Result<Option<PluginConfig>, String> {
        let file =
            fs::File::open(zip_path).map_err(|e| format!("Failed to open plugin file: {}", e))?;
        let mut archive =
            ZipArchive::new(file).map_err(|e| format!("Failed to open ZIP archive: {}", e))?;

        if let Ok(mut f) = archive.by_name("package.json") {
            let mut s = String::new();
            f.read_to_string(&mut s)
                .map_err(|e| format!("Failed to read package.json: {}", e))?;
            if let Ok(pkg) = serde_json::from_str::<serde_json::Value>(&s) {
                if package_json_is_v3(&pkg) {
                    return plugin_config_from_package_json(&pkg);
                }
            }
        }

        let mut config_file = match archive.by_name("config.json") {
            Ok(f) => f,
            Err(_) => return Ok(None),
        };

        let mut content = String::new();
        config_file
            .read_to_string(&mut content)
            .map_err(|e| format!("Failed to read config.json: {}", e))?;

        let config: PluginConfig = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse config.json: {}", e))?;
        Ok(Some(config))
    }

    /// 安装 .kgpg 插件（复制文件到插件目录；若源文件已在插件目录则直接复用）
    pub async fn install_plugin_from_kgpg(&self, zip_path: &Path) -> Result<Plugin, String> {
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

        let source_canon =
            fs::canonicalize(zip_path).map_err(|e| format!("Failed to access plugin file: {e}"))?;
        let target_canon = fs::canonicalize(&target_path).ok();
        let already_installed = target_canon
            .as_ref()
            .map(|target| *target == source_canon)
            .unwrap_or(false);

        if !already_installed {
            // 如果目标文件已存在，先删除
            if target_path.exists() {
                fs::remove_file(&target_path)
                    .map_err(|e| format!("Failed to remove existing plugin file: {}", e))?;
            }

            // 复制 .kgpg 文件到插件目录
            fs::copy(zip_path, &target_path)
                .map_err(|e| format!("Failed to copy plugin file: {}", e))?;
        }

        // 从目标路径解析完整 Plugin 并更新缓存
        let plugin = self.parse_kgpg(&target_path).await?;
        let plugin_id = plugin.id.clone();
        let _ = self.ensure_default_config_file_if_missing(&plugin_id).await;

        // 原子更新已安装缓存
        let current = self.plugins.load();
        let was_update = current
            .as_ref()
            .as_ref()
            .map_or(false, |m| m.contains_key(&plugin_id));
        let old_plugin = current
            .as_ref()
            .as_ref()
            .and_then(|m| m.get(&plugin_id))
            .map(|p| (**p).clone());
        self.replace_plugin_providers(old_plugin.as_ref(), &plugin)?;
        let mut plugins_map = current.as_ref().as_ref().cloned().unwrap_or_default();
        plugins_map.insert(plugin_id, Arc::new(plugin.clone()));
        self.plugins.store(Arc::new(Some(plugins_map)));

        // 发送插件新增/更新事件
        if let Some(emitter) = crate::emitter::GlobalEmitter::try_global() {
            if let Ok(payload) = serde_json::to_value(&plugin) {
                if was_update {
                    emitter.emit_plugin_updated(&payload);
                } else {
                    emitter.emit_plugin_added(&payload);
                }
            }
        }

        #[cfg(all(not(target_os = "ios"), feature = "plugin-runtime"))]
        crate::plugin::metadata_migration::spawn_metadata_migrations_for_plugin(plugin.clone());

        Ok(plugin)
    }

    /// 从商店下载（若未缓存）并安装插件。
    /// 通过 `install_plugin_from_kgpg` 自动发送 `plugin-added` / `plugin-updated` 事件。
    pub async fn install_from_store(
        &self,
        source_id: &str,
        plugin_id: &str,
    ) -> Result<Plugin, String> {
        let cached_path = self.ensure_plugin_cached(source_id, plugin_id).await?;
        self.install_plugin_from_kgpg(&cached_path).await
    }

    /// 获取插件的变量定义（从内存中已加载的 Plugin 读取）
    pub async fn get_plugin_vars(
        &self,
        plugin_id: &str,
    ) -> Result<Option<Vec<VarDefinition>>, String> {
        if let Some(plugin) = self.get(plugin_id) {
            return Ok(Some(plugin.var_defs.clone()));
        }
        Err(format!("Plugin {} not found", plugin_id))
    }

    /// 从插件变量定义生成默认配置 JSON（不写盘）
    async fn build_default_config_json(
        &self,
        plugin_id: &str,
    ) -> Result<serde_json::Value, String> {
        let vars = self.get_plugin_vars(plugin_id).await?;
        let user_obj = match vars {
            Some(v) if !v.is_empty() => {
                let mut m = serde_json::Map::new();
                for def in v {
                    if let Some(d) = def.default {
                        m.insert(def.key, d);
                    } else {
                        m.insert(def.key, serde_json::Value::Null);
                    }
                }
                serde_json::Value::Object(m)
            }
            _ => serde_json::json!({}),
        };
        Ok(serde_json::json!({
            "userConfig": user_obj,
            "httpHeaders": {},
            "outputDir": null
        }))
    }

    fn write_default_config_file(
        &self,
        path: &Path,
        json: &serde_json::Value,
    ) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create default-configs directory: {}", e))?;
        }
        let s = serde_json::to_string_pretty(json).map_err(|e| e.to_string())?;
        fs::write(path, s).map_err(|e| format!("Failed to write default config: {}", e))
    }

    /// 读取磁盘上的插件默认配置；文件不存在返回 `None`，解析失败返回 `Err`
    pub fn read_plugin_default_config_file(
        &self,
        plugin_id: &str,
    ) -> Result<Option<serde_json::Value>, String> {
        let path = crate::app_paths::AppPaths::global().default_config_file(plugin_id);
        if !path.exists() {
            return Ok(None);
        }
        let s = fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read default config: {}", e))?;
        let v: serde_json::Value = serde_json::from_str(&s)
            .map_err(|e| format!("Failed to parse default config: {}", e))?;
        Ok(Some(v))
    }

    /// 保存插件默认配置到 `plugins-directory/default-configs/<plugin_id>.json`
    pub fn save_plugin_default_config(
        &self,
        plugin_id: &str,
        config: &serde_json::Value,
    ) -> Result<(), String> {
        let path = crate::app_paths::AppPaths::global().default_config_file(plugin_id);
        self.write_default_config_file(&path, config)
    }

    /// 若默认配置文件不存在，则根据插件 `config.json` 的 var 定义生成并写入
    pub async fn ensure_default_config_file_if_missing(
        &self,
        plugin_id: &str,
    ) -> Result<(), String> {
        let path = crate::app_paths::AppPaths::global().default_config_file(plugin_id);
        if path.exists() {
            return Ok(());
        }
        let json = self.build_default_config_json(plugin_id).await?;
        self.write_default_config_file(&path, &json)
    }

    /// 若文件不存在则创建；否则读取已有内容。用于设置页「确保有文件」。
    pub async fn ensure_plugin_default_config_loaded(
        &self,
        plugin_id: &str,
    ) -> Result<serde_json::Value, String> {
        let path = crate::app_paths::AppPaths::global().default_config_file(plugin_id);
        if !path.exists() {
            let json = self.build_default_config_json(plugin_id).await?;
            self.write_default_config_file(&path, &json)?;
            return Ok(json);
        }
        let s = fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read default config: {}", e))?;
        serde_json::from_str(&s).map_err(|e| format!("Failed to parse default config: {}", e))
    }

    /// 按插件当前变量定义重新生成默认配置并覆盖写入，返回新内容
    pub async fn reset_plugin_default_config(
        &self,
        plugin_id: &str,
    ) -> Result<serde_json::Value, String> {
        let json = self.build_default_config_json(plugin_id).await?;
        let path = crate::app_paths::AppPaths::global().default_config_file(plugin_id);
        self.write_default_config_file(&path, &json)?;
        Ok(json)
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
    /// - `revalidate_if_stale_after_secs`：在 `force_refresh == false` 时生效；若缓存行的
    ///   `updated_at` 距现在已超过该秒数，则改为走网络拉取并更新缓存。`None` 表示不按时间失效。
    pub async fn fetch_store_plugins(
        &self,
        source_id: Option<&str>,
        force_refresh: bool,
        revalidate_if_stale_after_secs: Option<u64>,
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
                .fetch_plugins_from_source_cached(
                    &source,
                    force_refresh,
                    revalidate_if_stale_after_secs,
                )
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
    /// - `force_refresh=false`：优先使用本地缓存（可选按 `updated_at` 过期后重拉）
    /// - `force_refresh=true`：强制从远程获取并更新缓存
    async fn fetch_plugins_from_source_cached(
        &self,
        source: &PluginSource,
        force_refresh: bool,
        revalidate_if_stale_after_secs: Option<u64>,
    ) -> Result<Vec<StorePluginResolved>, String> {
        if force_refresh {
            return self.fetch_plugins_from_source(source).await;
        }

        let storage = crate::storage::Storage::global().plugin_sources();
        let cache_row = match storage.get_source_cache_row(&source.id) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("读取商店源缓存元数据失败 ({}): {}", source.name, e);
                None
            }
        };

        let Some((cached_json_str, updated_at)) = cache_row else {
            return self.fetch_plugins_from_source(source).await;
        };

        let Some(resolved_plugins) = self.plugins_from_index_cache_json(&cached_json_str, source)
        else {
            return self.fetch_plugins_from_source(source).await;
        };

        let stale = match revalidate_if_stale_after_secs {
            None => false,
            Some(max_age) => {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0);
                now.saturating_sub(updated_at) >= max_age as i64
            }
        };

        if stale {
            return self.fetch_plugins_from_source(source).await;
        }

        println!(
            "从缓存加载商店源 '{}' 的插件列表（{} 个插件）",
            source.name,
            resolved_plugins.len()
        );
        Ok(resolved_plugins)
    }

    /// 从已缓存的 index JSON 字符串解析出插件列表；无效或为空则返回 `None`。
    fn plugins_from_index_cache_json(
        &self,
        cached_json_str: &str,
        source: &PluginSource,
    ) -> Option<Vec<StorePluginResolved>> {
        let cached_json = serde_json::from_str::<serde_json::Value>(cached_json_str).ok()?;
        let plugins_array = cached_json.get("plugins")?.as_array()?;
        let mut resolved_plugins = Vec::new();
        for plugin_json in plugins_array {
            if let Ok(plugin) = self.parse_store_plugin(plugin_json, &source.id, &source.name) {
                resolved_plugins.push(plugin);
            }
        }
        if resolved_plugins.is_empty() {
            None
        } else {
            Some(resolved_plugins)
        }
    }

    /// 从 DB 缓存的 source index JSON 中查找单个 StorePluginResolved。
    /// 用于 `load_remote_plugin` / `preview_store_install` 等场景：只需 source_id + plugin_id，
    /// download_url / sha256 / size / version 均从缓存中获取。
    pub fn lookup_store_plugin(
        &self,
        source_id: &str,
        plugin_id: &str,
    ) -> Result<StorePluginResolved, String> {
        let storage = crate::storage::Storage::global().plugin_sources();
        let (cached_json_str, _) = storage
            .get_source_cache_row(source_id)
            .map_err(|e| format!("读取商店源缓存失败: {}", e))?
            .ok_or_else(|| format!("商店源 {} 尚无缓存，请先刷新", source_id))?;

        let source = self
            .load_plugin_sources()?
            .into_iter()
            .find(|s| s.id == source_id)
            .ok_or_else(|| format!("商店源 {} 不存在", source_id))?;

        let cached_json = serde_json::from_str::<serde_json::Value>(&cached_json_str)
            .map_err(|e| format!("解析商店源缓存 JSON 失败: {}", e))?;
        let plugins_array = cached_json
            .get("plugins")
            .and_then(|v| v.as_array())
            .ok_or_else(|| "商店源缓存 JSON 中无 plugins 数组".to_string())?;

        for plugin_json in plugins_array {
            if let Ok(resolved) = self.parse_store_plugin(plugin_json, &source.id, &source.name) {
                if resolved.id == plugin_id {
                    return Ok(resolved);
                }
            }
        }
        Err(format!("商店源 {} 中未找到插件 {}", source_id, plugin_id))
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
            const MAX: u64 = 3;
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

        let min_app_version = plugin_json
            .get("minAppVersion")
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.to_string());

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
            min_app_version,
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
                        Self::emit_download_progress(&StorePluginDownloadProgressEvent {
                            source_id: ctx.source_id.clone(),
                            plugin_id: ctx.plugin_id.clone(),
                            percent,
                            received,
                            total: total_hint,
                            error: None,
                        });
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
            Self::emit_download_progress(&StorePluginDownloadProgressEvent {
                source_id: ctx.source_id.clone(),
                plugin_id: ctx.plugin_id.clone(),
                percent: 100,
                received: buffer.len() as u64,
                total: total_hint,
                error: None,
            });
        }

        Ok(buffer)
    }

    fn emit_download_progress(event: &StorePluginDownloadProgressEvent) {
        if let Some(emitter) = crate::emitter::GlobalEmitter::try_global() {
            if let Ok(payload) = serde_json::to_value(event) {
                emitter.emit("plugin-store-download-progress", payload);
            }
        }
    }

    fn emit_download_failed(&self, ctx: &StorePluginDownloadProgressContext, msg: String) {
        let k = store_download_progress_key(ctx.source_id.as_str(), ctx.plugin_id.as_str());
        if let Ok(mut g) = self.store_download_states.lock() {
            g.remove(&k);
        }
        Self::emit_download_progress(&StorePluginDownloadProgressEvent {
            source_id: ctx.source_id.clone(),
            plugin_id: ctx.plugin_id.clone(),
            percent: 0,
            received: 0,
            total: None,
            error: Some(msg),
        });
    }

    /// 确保插件缓存存在并版本匹配。
    /// 从 DB source cache 查找下载信息，优先查内存缓存；未命中则从远程下载并写盘刷新缓存。
    pub async fn ensure_plugin_cached(
        &self,
        source_id: &str,
        plugin_id: &str,
    ) -> Result<PathBuf, String> {
        let store_plugin = self.lookup_store_plugin(source_id, plugin_id)?;
        let cache_file =
            crate::app_paths::AppPaths::global().store_plugin_cache_file(source_id, plugin_id);

        // 1. 查内存缓存
        {
            let cache = self.store_plugin_cache.load();
            if let Some(source_map) = cache.get(source_id) {
                if let Some(plugin) = source_map.get(plugin_id) {
                    if plugin.version == store_plugin.version {
                        return Ok(cache_file);
                    }
                }
            }
        }

        // 2. 未命中 → 从远程下载
        if let Some(parent) = cache_file.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create cache directory: {}", e))?;
        }

        let progress = StorePluginDownloadProgressContext {
            source_id: source_id.to_string(),
            plugin_id: plugin_id.to_string(),
        };
        let bytes = self
            .download_plugin_raw(
                &store_plugin.download_url,
                store_plugin.sha256.as_deref(),
                Some(store_plugin.size_bytes),
                Some(progress),
            )
            .await?;

        // 写入文件系统
        fs::write(&cache_file, &bytes).map_err(|e| format!("Failed to write cache file: {}", e))?;

        // 解析并刷新内存缓存
        let plugin = self.parse_kgpg(&cache_file).await?;
        {
            let current = self.store_plugin_cache.load();
            let mut map = (**current).clone();
            map.entry(source_id.to_string())
                .or_default()
                .insert(plugin.id.clone(), plugin);
            self.store_plugin_cache.store(Arc::new(map));
        }

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
        // 优先从内存缓存读取 icon
        if let (Some(source_id), Some(plugin_id)) = (source_id, plugin_id) {
            let cache = self.store_plugin_cache.load();
            if let Some(source_map) = cache.get(source_id) {
                if let Some(plugin) = source_map.get(plugin_id) {
                    if let Some(ref b64) = plugin.icon_png_base64 {
                        use base64::{engine::general_purpose::STANDARD, Engine as _};
                        if let Ok(bytes) = STANDARD.decode(b64) {
                            return Ok(Some(bytes));
                        }
                    }
                    // 缓存中无 icon
                    return Ok(None);
                }
            }
        }

        // 内存缓存未命中，走 HTTP Range 逻辑
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

        let Some(rgb) = crate::kgpg::read_kgpg2_icon_rgb_from_bytes(&bytes) else {
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

    pub async fn load_installed_plugin_detail(&self, plugin_id: &str) -> Result<Plugin, String> {
        self.ensure_installed_cache_initialized().await?;
        let guard = self.plugins.load();
        guard
            .as_ref()
            .as_ref()
            .and_then(|m| m.get(plugin_id))
            .map(|a| (**a).clone())
            .ok_or_else(|| format!("Plugin {} not found", plugin_id))
    }

    /// 加载远程商店插件详情：确保 kgpg 已缓存，返回 Plugin。
    pub async fn load_remote_plugin(
        &self,
        source_id: &str,
        plugin_id: &str,
    ) -> Result<Plugin, String> {
        self.ensure_plugin_cached(source_id, plugin_id).await?;

        // 从内存缓存取 Plugin
        let cache = self.store_plugin_cache.load();
        let plugin = cache
            .get(source_id)
            .and_then(|m| m.get(plugin_id))
            .ok_or_else(|| {
                format!(
                    "Plugin {}:{} not found in store cache after ensure_plugin_cached",
                    source_id, plugin_id
                )
            })?;
        Ok(plugin.clone())
    }

    /// 从 kgpg 文件解析出 Plugin（plugin_id 从文件名提取）
    pub async fn preview_import_from_kgpg(&self, zip_path: &Path) -> Result<Plugin, String> {
        self.parse_kgpg(zip_path).await
    }

    /// 前端手动"刷新已安装源"：重扫插件目录并重建缓存（全量刷新）
    /// 仅读取用户目录（data）下的 .kgpg
    pub async fn refresh_plugins(&self) -> Result<(), String> {
        let user_plugins_dir = self.get_plugins_directory();
        let mut seen_plugin_ids = HashSet::new();

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
                let plugin = self.install_plugin_from_kgpg(&path).await?;
                seen_plugin_ids.insert(plugin.id);
            }
        }

        let current = self.plugins.load();
        let mut plugins_map = current.as_ref().as_ref().cloned().unwrap_or_default();
        let stale_ids: Vec<String> = plugins_map
            .keys()
            .filter(|id| !seen_plugin_ids.contains(*id))
            .cloned()
            .collect();
        for id in stale_ids {
            if let Some(old_plugin) = plugins_map.remove(&id) {
                self.unregister_plugin_providers(&old_plugin)?;
            }
        }
        self.plugins.store(Arc::new(Some(plugins_map)));
        Ok(())
    }

    /// 安装/更新/删除后：按 pluginId 局部刷新（部分刷新）
    /// 仅从用户目录（data）查找指定 plugin_id
    pub async fn refresh_plugin(&self, plugin_id: &str) -> Result<(), String> {
        let user_plugins_dir = self.get_plugins_directory();

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

        // 找到文件：重新解析（不持锁做 IO），然后 clone 当前缓存 + 更新 + store
        if let Some(path) = found_path {
            self.install_plugin_from_kgpg(&path).await?;
            return Ok(());
        }

        // 未找到文件：从快照中清理
        let current = self.plugins.load();
        let mut plugins_map = current.as_ref().as_ref().cloned().unwrap_or_default();
        if let Some(old_plugin) = plugins_map.remove(plugin_id) {
            self.unregister_plugin_providers(&old_plugin)?;
        }
        self.plugins.store(Arc::new(Some(plugins_map)));
        Ok(())
    }

    /// 确保已安装插件缓存已初始化（公开函数，用于启动时初始化）
    pub async fn ensure_installed_cache_initialized(&self) -> Result<(), String> {
        let current = self.plugins.load();
        if current.is_some() {
            return Ok(());
        }
        self.refresh_plugins().await
    }

    /// kgpg 文件 → Plugin（含全量字段：icon base64、doc、template、recommended_configs）
    ///
    /// plugin_id 从文件名（file_stem）提取，路径存在性由内部校验。
    async fn parse_kgpg(&self, path: &Path) -> Result<Plugin, String> {
        if !path.is_file() {
            return Err(format!("插件文件不存在: {}", path.display()));
        }
        let plugin_id = path
            .file_stem()
            .and_then(|s| s.to_str())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| format!("无法从路径提取插件 ID: {}", path.display()))?
            .to_string();

        let size_bytes = fs::metadata(path)
            .map_err(|e| format!("读取插件文件大小失败: {}", e))?
            .len();

        // v2：异步读取固定头部，优先获取 manifest 与 icon（无需解 zip）
        let mut manifest_from_meta: Option<PluginManifest> = None;
        let mut v2_icon_rgb24: Option<Vec<u8>> = None;
        if let Ok(Some(meta)) = crate::kgpg::read_kgpg2_meta(path).await {
            if let Ok(mut file) = tokio::fs::File::open(path).await {
                if meta.manifest_present() && meta.manifest_len > 0 {
                    let manifest_off =
                        (crate::kgpg::KGPG2_META_SIZE + crate::kgpg::KGPG2_ICON_SIZE) as u64;
                    let mut slot = vec![0u8; crate::kgpg::KGPG2_MANIFEST_SLOT_SIZE];
                    if file.seek(SeekFrom::Start(manifest_off)).await.is_ok()
                        && file.read_exact(&mut slot).await.is_ok()
                    {
                        let s = String::from_utf8_lossy(&slot[..meta.manifest_len as usize])
                            .to_string();
                        if !s.trim().is_empty() {
                            if let Ok(m) = serde_json::from_str::<PluginManifest>(&s) {
                                manifest_from_meta = Some(m);
                            }
                        }
                    }
                }
                if meta.icon_present() {
                    if let Ok(Some(rgb)) = crate::kgpg::read_kgpg2_icon_rgb(path).await {
                        if !rgb.is_empty() {
                            v2_icon_rgb24 = Some(rgb);
                        }
                    }
                }
            }
        }

        // ZIP 解析放到 blocking 线程池（单次遍历读取所有条目）
        let zip_path = path.to_path_buf();
        let plugin_id_for_zip = plugin_id.clone();
        const DOC_RESOURCE_MAX_FILE_SIZE: usize = 2 * 1024 * 1024; // 2 MB per file
        const DOC_RESOURCE_MAX_TOTAL_SIZE: usize = 10 * 1024 * 1024; // 10 MB total

        let (
            zip_manifest,
            config,
            doc,
            script_type,
            icon_png_bytes,
            description_template,
            recommended_configs,
            script,
            doc_resource_entries,
            provider_entries,
            metadata_migration_entry,
        ) = tokio::task::spawn_blocking(move || -> Result<_, String> {
            let file = fs::File::open(&zip_path)
                .map_err(|e| format!("Failed to open plugin file: {}", e))?;
            let mut archive =
                ZipArchive::new(file).map_err(|e| format!("Failed to open ZIP archive: {}", e))?;

            // 读取 package.json 判定 v3；旧版 manifest.json (v2) 插件格式已停止支持。
            let package_json: Option<String> = match archive.by_name("package.json") {
                Ok(mut f) => {
                    let mut s = String::new();
                    f.read_to_string(&mut s)
                        .map_err(|e| format!("Failed to read package.json: {}", e))?;
                    Some(s)
                }
                Err(_) => None,
            };
            let pkg = package_json
                .as_deref()
                .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok());
            let is_v3 = pkg.as_ref().map(package_json_is_v3).unwrap_or(false);
            if !is_v3 {
                return Err(
                    "只支持 package.json (v3) 插件格式；旧版 manifest.json (v2) 插件已停止支持"
                        .to_string(),
                );
            }
            load_plugin_v3_from_zip(
                &mut archive,
                pkg.as_ref().unwrap(),
                &plugin_id_for_zip,
                DOC_RESOURCE_MAX_FILE_SIZE,
                DOC_RESOURCE_MAX_TOTAL_SIZE,
            )
        })
        .await
        .map_err(|e| format!("Failed to join ZIP parser task: {}", e))??;

        let manifest = manifest_from_meta.unwrap_or(zip_manifest);

        // 优先使用 KGPG v2 头部 icon（RGB24 raw → PNG），回落到 zip icon_png_bytes
        let icon_png_base64 = if let Some(rgb24) = v2_icon_rgb24 {
            use base64::{engine::general_purpose::STANDARD, Engine as _};
            use image::RgbImage;
            let w = crate::kgpg::KGPG2_ICON_W;
            let h = crate::kgpg::KGPG2_ICON_H;
            RgbImage::from_raw(w, h, rgb24)
                .and_then(|img| {
                    let mut png_bytes: Vec<u8> = Vec::new();
                    image::DynamicImage::ImageRgb8(img)
                        .write_to(
                            &mut std::io::Cursor::new(&mut png_bytes),
                            image::ImageFormat::Png,
                        )
                        .ok()?;
                    if png_bytes.is_empty() {
                        None
                    } else {
                        Some(STANDARD.encode(png_bytes))
                    }
                })
                .or_else(|| icon_png_bytes.as_ref().map(|b| STANDARD.encode(b)))
        } else {
            icon_png_bytes.as_ref().map(|bytes| {
                use base64::{engine::general_purpose::STANDARD, Engine as _};
                STANDARD.encode(bytes)
            })
        };

        let doc_resources = if doc_resource_entries.is_empty() {
            None
        } else {
            use base64::{engine::general_purpose::STANDARD, Engine as _};
            let map: HashMap<String, String> = doc_resource_entries
                .into_iter()
                .map(|(path, bytes)| (path, STANDARD.encode(&bytes)))
                .collect();
            Some(map)
        };

        let providers = parse_plugin_provider_entries(&plugin_id, provider_entries)?;

        // 版本无法 packed 编码的插件直接拒绝加载（写入盖章与迁移门控都依赖它）
        let version_packed = pack_plugin_version(&manifest.version)?;

        Ok(Plugin {
            id: plugin_id,
            name: manifest.name_to_value(),
            description: manifest.description_to_value(),
            version: manifest.version.clone(),
            base_url: config
                .as_ref()
                .and_then(|c| c.base_url.clone())
                .unwrap_or_default(),
            size_bytes,
            config: plugin_config_to_frontend_config_map(&config),
            script_type,
            min_app_version: manifest.min_app_version.clone(),
            file_path: Some(path.to_string_lossy().to_string()),
            doc,
            icon_png_base64,
            description_template,
            recommended_configs,
            var_defs: config
                .as_ref()
                .and_then(|c| c.var.clone())
                .unwrap_or_default(),
            script,
            doc_resources,
            providers,
            metadata_migration: metadata_migration_entry,
            version_packed,
        })
    }
}

/// v3 装载：按 package.json 字段拉取 zip 条目，无条目名约定。
fn load_plugin_v3_from_zip<R: std::io::Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
    pkg: &serde_json::Value,
    plugin_id: &str,
    doc_resource_max_file_size: usize,
    doc_resource_max_total_size: usize,
) -> Result<
    (
        PluginManifest,
        Option<PluginConfig>,
        Option<PluginDoc>,
        String,
        Option<Vec<u8>>,
        Option<String>,
        Vec<serde_json::Value>,
        PluginScript,
        Vec<(String, Vec<u8>)>,
        Vec<(String, String)>,
        Option<String>,
    ),
    String,
> {
    let pkg_obj = pkg
        .as_object()
        .ok_or_else(|| "package.json 必须是 JSON 对象".to_string())?;

    let manifest = plugin_manifest_from_package_json(pkg)?;
    let config = plugin_config_from_package_json(pkg)?;

    let script_type: String;
    let script: PluginScript;

    let kb_backend_str = pkg_obj
        .get("kbBackend")
        .and_then(|v| v.as_str())
        .unwrap_or("rhai");
    let backend = PluginBackend::from_str(kb_backend_str)?;
    let main_path = pkg_obj
        .get("main")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "v3 插件 package.json 缺少 \"main\" 字段".to_string())?;
    validate_kb_rel_path(main_path)?;

    {
        let mut f = archive
            .by_name(main_path)
            .map_err(|_| format!("package.json 引用的 \"{}\" 不在包内", main_path))?;
        let mut source = String::new();
        f.read_to_string(&mut source)
            .map_err(|e| format!("读取 \"{}\" 失败: {}", main_path, e))?;
        script = PluginScript::new(backend, source);
        script_type = script.script_type_str().to_string();
    }

    let icon_png_bytes: Option<Vec<u8>> = if let Some(icon_path) =
        pkg_obj.get("kbIcon").and_then(|v| v.as_str())
    {
        validate_kb_rel_path(icon_path)?;
        match archive.by_name(icon_path) {
            Ok(mut f) => {
                let mut bytes = Vec::new();
                f.read_to_end(&mut bytes)
                    .map_err(|e| format!("读取 kbIcon \"{}\" 失败: {}", icon_path, e))?;
                if bytes.is_empty() {
                    None
                } else {
                    Some(bytes)
                }
            }
            Err(_) => {
                return Err(format!(
                    "package.json 引用的 kbIcon \"{}\" 不在包内",
                    icon_path
                ));
            }
        }
    } else {
        None
    };

    let description_template: Option<String> = if let Some(tpl_path) =
        pkg_obj.get("kbDescriptionTemplate").and_then(|v| v.as_str())
    {
        validate_kb_rel_path(tpl_path)?;
        let mut f = archive.by_name(tpl_path).map_err(|_| {
            format!(
                "package.json 引用的 kbDescriptionTemplate \"{}\" 不在包内",
                tpl_path
            )
        })?;
        let mut s = String::new();
        f.read_to_string(&mut s)
            .map_err(|e| format!("读取 \"{}\" 失败: {}", tpl_path, e))?;
        if s.is_empty() {
            None
        } else {
            Some(s)
        }
    } else {
        None
    };

    let mut doc_entries: Vec<(String, String)> = Vec::new();
    let mut doc_resource_entries: Vec<(String, Vec<u8>)> = Vec::new();
    let mut doc_resource_total_size: usize = 0;

    if let Some(doc_map) = pkg_obj.get("kbDoc").and_then(|v| v.as_object()) {
        for (lang_key, md_path_val) in doc_map {
            let md_path = md_path_val.as_str().ok_or_else(|| {
                format!("kbDoc[\"{}\"] 必须是字符串", lang_key)
            })?;
            validate_kb_rel_path(md_path)?;

            let md_text = {
                let mut f = archive.by_name(md_path).map_err(|_| {
                    format!(
                        "package.json 引用的 kbDoc[\"{}\"] \"{}\" 不在包内",
                        lang_key, md_path
                    )
                })?;
                let mut s = String::new();
                f.read_to_string(&mut s)
                    .map_err(|e| format!("读取 kbDoc \"{}\" 失败: {}", md_path, e))?;
                s
            };

            let md_dir = std::path::Path::new(md_path)
                .parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();

            let local_refs = extract_doc_local_refs(&md_text, &md_dir);
            let mut rewritten_md = md_text.clone();

            for (normalized_path, original_ref) in &local_refs {
                match archive.by_name(normalized_path) {
                    Ok(mut res_f) => {
                        let mut bytes = Vec::new();
                        res_f.read_to_end(&mut bytes).map_err(|e| {
                            format!(
                                "读取文档资源 \"{}\" 失败: {}",
                                normalized_path, e
                            )
                        })?;

                        let res_size = bytes.len();
                        if res_size > doc_resource_max_file_size
                            || doc_resource_total_size + res_size > doc_resource_max_total_size
                        {
                            continue;
                        }
                        doc_resource_total_size += res_size;

                        let already_exists = doc_resource_entries
                            .iter()
                            .any(|(p, _)| p == normalized_path);
                        if already_exists {
                            rewritten_md = rewritten_md.replace(original_ref, normalized_path);
                        } else {
                            doc_resource_entries
                                .push((normalized_path.clone(), bytes));
                            rewritten_md = rewritten_md.replace(original_ref, normalized_path);
                        }
                    }
                    Err(_) => {
                        return Err(format!(
                            "文档 \"{}\" 引用的资源 \"{}\" 不在包内",
                            md_path, normalized_path
                        ));
                    }
                }
            }

            doc_entries.push((lang_key.clone(), rewritten_md));
        }
    }

    let doc: Option<PluginDoc> = if doc_entries.is_empty() {
        None
    } else {
        Some(doc_entries.into_iter().collect())
    };

    let mut recommended_configs: Vec<serde_json::Value> = Vec::new();
    if let Some(configs_arr) = pkg_obj.get("kbRecommendedConfigs").and_then(|v| v.as_array()) {
        for (i, cfg_path_val) in configs_arr.iter().enumerate() {
            let cfg_path = cfg_path_val.as_str().ok_or_else(|| {
                format!("kbRecommendedConfigs[{}] 必须是字符串", i)
            })?;
            validate_kb_rel_path(cfg_path)?;

            let mut f = archive.by_name(cfg_path).map_err(|_| {
                format!(
                    "package.json 引用的 kbRecommendedConfigs[{}] \"{}\" 不在包内",
                    i, cfg_path
                )
            })?;
            let mut s = String::new();
            f.read_to_string(&mut s)
                .map_err(|e| format!("读取 \"{}\" 失败: {}", cfg_path, e))?;

            let filename = std::path::Path::new(cfg_path)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();

            let v: serde_json::Value =
                serde_json::from_str(&s).map_err(|e| format!("解析 \"{}\" 失败: {}", cfg_path, e))?;
            let mut obj = serde_json::Map::new();
            obj.insert(
                "pluginId".to_string(),
                serde_json::json!(plugin_id),
            );
            obj.insert("filename".to_string(), serde_json::json!(filename));
            if let serde_json::Value::Object(m) = v {
                for (k, val) in m {
                    obj.insert(k, val);
                }
            }
            recommended_configs.push(serde_json::Value::Object(obj));
        }
    }

    let mut provider_entries: Vec<(String, String)> = Vec::new();
    if let Some(prov_arr) = pkg_obj.get("kbPathQLProviders").and_then(|v| v.as_array()) {
        for (i, prov_path_val) in prov_arr.iter().enumerate() {
            let prov_path = prov_path_val.as_str().ok_or_else(|| {
                format!("kbPathQLProviders[{}] 必须是字符串", i)
            })?;
            validate_kb_rel_path(prov_path)?;

            let mut f = archive.by_name(prov_path).map_err(|_| {
                format!(
                    "package.json 引用的 kbPathQLProviders[{}] \"{}\" 不在包内",
                    i, prov_path
                )
            })?;
            let mut s = String::new();
            f.read_to_string(&mut s)
                .map_err(|e| format!("读取 \"{}\" 失败: {}", prov_path, e))?;
            if !s.trim().is_empty() {
                provider_entries.push((prov_path.to_string(), s));
            }
        }
    }

    // 单一迁移脚本：kbMetadataMigration（字符串路径，.js）。
    // 旧 kbMetadataMigrations 数组键已停止支持，加载时完全不解析。
    let mut metadata_migration_entry: Option<String> = None;
    if let Some(mig_val) = pkg_obj.get("kbMetadataMigration") {
        let mig_path = mig_val
            .as_str()
            .ok_or_else(|| "kbMetadataMigration 必须是字符串".to_string())?;
        validate_kb_rel_path(mig_path)?;
        if !mig_path.ends_with(".js") {
            return Err(format!(
                "kbMetadataMigration \"{}\" 必须是 .js 脚本（ES module，export migrate）",
                mig_path
            ));
        }
        let mut f = archive.by_name(mig_path).map_err(|_| {
            format!(
                "package.json 引用的 kbMetadataMigration \"{}\" 不在包内",
                mig_path
            )
        })?;
        let mut s = String::new();
        f.read_to_string(&mut s)
            .map_err(|e| format!("读取 \"{}\" 失败: {}", mig_path, e))?;
        if !s.trim().is_empty() {
            metadata_migration_entry = Some(s);
        }
    }

    Ok((
        manifest,
        config,
        doc,
        script_type,
        icon_png_bytes,
        description_template,
        recommended_configs,
        script,
        doc_resource_entries,
        provider_entries,
        metadata_migration_entry,
    ))
}

fn plugin_provider_namespace_allowed(plugin_id: &str, def: &ProviderDef) -> bool {
    let base = format!("plugins.{}", plugin_id);
    def.namespace
        .as_ref()
        .map(|ns| ns.0 == base || ns.0.starts_with(&(base + ".")))
        .unwrap_or(false)
}

fn validate_plugin_provider_defs(plugin_id: &str, defs: &[ProviderDef]) -> Result<(), String> {
    for def in defs {
        if !plugin_provider_namespace_allowed(plugin_id, def) {
            let ns = def.namespace.as_ref().map(|ns| ns.0.as_str()).unwrap_or("");
            return Err(format!(
                "插件 `{}` provider `{}.{}` 不能逃逸插件 namespace",
                plugin_id, ns, def.name.0
            ));
        }
    }
    Ok(())
}

fn normalize_plugin_provider_def(
    plugin_id: &str,
    mut def: ProviderDef,
) -> Result<ProviderDef, String> {
    let base = format!("plugins.{}", plugin_id);
    match def.namespace.as_ref().map(|ns| ns.0.as_str()) {
        None | Some("") => def.namespace = Some(Namespace(base)),
        Some(ns) if ns == base || ns.starts_with(&(base.clone() + ".")) => {}
        Some(ns) if !ns.starts_with("plugins.") => {
            def.namespace = Some(Namespace(format!("{}.{}", base, ns)));
        }
        Some(ns) => {
            return Err(format!(
                "插件 provider namespace `{}` 不能逃逸 `{}`",
                ns, base
            ))
        }
    }
    ensure_plugin_provider_filter_comb_resolve(&mut def);
    Ok(def)
}

fn ensure_plugin_provider_filter_comb_resolve(def: &mut ProviderDef) {
    let resolve = def.resolve.get_or_insert_with(Resolve::default);
    resolve
        .0
        .entry("filter_comb".to_string())
        .or_insert_with(|| {
            ProviderInvocation::ByName(InvokeByName {
                provider: ProviderName("kabegame.gallery_filter_comb".to_string()),
                properties: None,
                meta: None,
            })
        });
}

fn default_plugin_entry_provider(plugin_id: &str) -> ProviderDef {
    let mut def = ProviderDef {
        schema: None,
        namespace: Some(Namespace(format!("plugins.{}", plugin_id))),
        name: SimpleName("entry_provider".to_string()),
        properties: None,
        query: Some(Query::Contrib(ContribQuery {
            where_: Some(SqlExpr("1 = 0".to_string())),
            ..Default::default()
        })),
        list: Some(List::default()),
        resolve: None,
        note: None,
    };
    ensure_plugin_provider_filter_comb_resolve(&mut def);
    def
}

fn parse_plugin_provider_entries(
    plugin_id: &str,
    mut entries: Vec<(String, String)>,
) -> Result<Vec<PluginProviderDef>, String> {
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    let loader = Json5Loader;
    let mut providers = Vec::new();
    for (source_path, source) in entries {
        let def = loader.load(Source::Str(&source)).map_err(|err| {
            format!(
                "解析插件 `{}` provider `{}` 失败: {}",
                plugin_id, source_path, err
            )
        })?;
        providers.push(PluginProviderDef {
            source_path,
            def: normalize_plugin_provider_def(plugin_id, def)?,
        });
    }

    let base = format!("plugins.{}", plugin_id);
    let has_entry = providers.iter().any(|provider| {
        provider.def.namespace.as_ref().map(|ns| ns.0.as_str()) == Some(base.as_str())
            && provider.def.name.0 == "entry_provider"
    });
    if !has_entry {
        providers.push(PluginProviderDef {
            source_path: "<default entry_provider>".to_string(),
            def: default_plugin_entry_provider(plugin_id),
        });
    }

    Ok(providers)
}

/// 从任意 `.kgpg` 文件读取 manifest.json（优先 KGPG v2 头部）。
///
/// 说明：
/// - 这是 `PluginManager::read_plugin_manifest()` 的可复用实现。
pub async fn read_plugin_manifest_from_kgpg_file(
    zip_path: &Path,
) -> Result<PluginManifest, String> {
    // 优先尝试：KGPG v2 固定头部（无需解析 zip）
    if let Ok(Some(s)) = crate::kgpg::read_kgpg2_manifest_json_from_file(zip_path).await {
        if !s.trim().is_empty() {
            if let Ok(m) = serde_json::from_str::<PluginManifest>(&s) {
                return Ok(m);
            }
        }
    }

    let zip_path = zip_path.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let file =
            fs::File::open(&zip_path).map_err(|e| format!("Failed to open plugin file: {}", e))?;
        let mut archive =
            ZipArchive::new(file).map_err(|e| format!("Failed to open ZIP archive: {}", e))?;

        if let Ok(mut f) = archive.by_name("package.json") {
            let mut s = String::new();
            f.read_to_string(&mut s)
                .map_err(|e| format!("Failed to read package.json: {}", e))?;
            if let Ok(pkg) = serde_json::from_str::<serde_json::Value>(&s) {
                if package_json_is_v3(&pkg) {
                    return plugin_manifest_from_package_json(&pkg);
                }
            }
        }

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
    })
    .await
    .map_err(|e| format!("Failed to join manifest parser task: {}", e))?
}

pub fn read_plugin_manifest_from_kgpg_file_sync(zip_path: &Path) -> Result<PluginManifest, String> {
    // 同步兼容入口：用于非 async 场景（如 VD provider）。
    if let Ok(bytes) = fs::read(zip_path) {
        if let Some(s) = crate::kgpg::read_kgpg2_manifest_json_from_bytes(&bytes) {
            if !s.trim().is_empty() {
                if let Ok(m) = serde_json::from_str::<PluginManifest>(&s) {
                    return Ok(m);
                }
            }
        }
    }

    let file =
        fs::File::open(zip_path).map_err(|e| format!("Failed to open plugin file: {}", e))?;
    let mut archive =
        ZipArchive::new(file).map_err(|e| format!("Failed to open ZIP archive: {}", e))?;

    if let Ok(mut f) = archive.by_name("package.json") {
        let mut s = String::new();
        f.read_to_string(&mut s)
            .map_err(|e| format!("Failed to read package.json: {}", e))?;
        if let Ok(pkg) = serde_json::from_str::<serde_json::Value>(&s) {
            if package_json_is_v3(&pkg) {
                return plugin_manifest_from_package_json(&pkg);
            }
        }
    }

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

// 插件清单（manifest.json）中 name/description 的国际化：仅 Record，扁平键 "name"（默认）、"name.zh"、"name.ja" 等
pub type ManifestI18nText = HashMap<String, String>;

/// 插件文档多语言：键 "default"（doc.md / doc_root/doc.md）及 "zh"、"en"、"ja"、"ko" 等（doc_root/doc.<lang>.md）
pub type PluginDoc = HashMap<String, String>;

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

/// 解析 `major.minor.patch` 形式的 semver 片段，用于与插件 `minAppVersion` 比较。
fn parse_semver_triple(s: &str) -> Option<(u32, u32, u32)> {
    let parts: Vec<&str> = s.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    Some((
        parts[0].parse().ok()?,
        parts[1].parse().ok()?,
        parts[2].parse().ok()?,
    ))
}

/// 把插件版本 `major.minor.patch` 编码为 u32（每字节一段，高字节留空）：
/// `3.4.1` → `0x00030401`。直接比较大小即可比较版本先后。
/// 每段必须 ≤255；不合规返回可读错误（加载/打包时报给用户）。
pub fn pack_plugin_version(version: &str) -> Result<u32, String> {
    let (major, minor, patch) = parse_semver_triple(version).ok_or_else(|| {
        format!(
            "插件版本 \"{}\" 无法编码为版本号整数：需要 major.minor.patch 形式",
            version
        )
    })?;
    if major > 255 || minor > 255 || patch > 255 {
        return Err(format!(
            "插件版本 \"{}\" 无法编码为版本号整数：每段必须 ≤255",
            version
        ));
    }
    Ok((major << 16) | (minor << 8) | patch)
}

/// 当前应用版本 `current` 是否满足插件要求的最低版本 `required`（`>=`）。
pub fn check_min_app_version(current: &str, required: &str) -> Result<(), String> {
    let cur =
        parse_semver_triple(current).ok_or_else(|| format!("无法解析应用版本: {}", current))?;
    let req = parse_semver_triple(required)
        .ok_or_else(|| format!("无法解析插件要求的最低版本: {}", required))?;
    if cur >= req {
        Ok(())
    } else {
        Err(format!(
            "此插件要求 Kabegame >= {}，当前版本为 {}",
            required, current
        ))
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
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        rename = "minAppVersion"
    )]
    pub min_app_version: Option<String>,
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
        let min_app_version = map
            .get("minAppVersion")
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.to_string());
        let name = extract_manifest_text_from_flat(map, "name");
        let description = extract_manifest_text_from_flat(map, "description");
        Ok(PluginManifest {
            name,
            version,
            description,
            author,
            min_app_version,
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        when: Option<HashMap<String, Vec<serde_json::Value>>>,
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
        let when: Option<HashMap<String, Vec<serde_json::Value>>> = map
            .get("when")
            .and_then(|v| serde_json::from_value(v.clone()).ok());
        Ok(VarOption::Item {
            name,
            variable,
            when,
        })
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
    pub when: Option<HashMap<String, Vec<serde_json::Value>>>,
    /// date 类型：dayjs 格式，提交给脚本的日期字符串（如 YYYYMMDD）
    #[serde(default)]
    pub format: Option<String>,
    #[serde(default, rename = "dateMin")]
    pub date_min: Option<String>,
    #[serde(default, rename = "dateMax")]
    pub date_max: Option<String>,
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
                        let when: Option<HashMap<String, Vec<serde_json::Value>>> = m
                            .get("when")
                            .and_then(|v| serde_json::from_value(v.clone()).ok());
                        out.push(VarOption::Item {
                            name,
                            variable,
                            when,
                        });
                    }
                }
            }
            Some(out)
        });
        let min = map.get("min").cloned();
        let max = map.get("max").cloned();
        let when: Option<HashMap<String, Vec<serde_json::Value>>> = map
            .get("when")
            .and_then(|v| serde_json::from_value(v.clone()).ok());
        let format = map
            .get("format")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let date_min = map
            .get("dateMin")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let date_max = map
            .get("dateMax")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
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
            format,
            date_min,
            date_max,
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
                VarOption::Item {
                    name,
                    variable,
                    when,
                } => {
                    let mut m = serde_json::Map::new();
                    m.insert(
                        "variable".to_string(),
                        serde_json::Value::String(variable.clone()),
                    );
                    m.insert(
                        "name".to_string(),
                        manifest_i18n_to_frontend_value(name, "name"),
                    );
                    if let Some(ref w) = when {
                        if let Ok(wv) = serde_json::to_value(w) {
                            m.insert("when".to_string(), wv);
                        }
                    }
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
    if let Some(ref f) = v.format {
        obj.insert("format".to_string(), serde_json::Value::String(f.clone()));
    }
    if let Some(ref d) = v.date_min {
        obj.insert("dateMin".to_string(), serde_json::Value::String(d.clone()));
    }
    if let Some(ref d) = v.date_max {
        obj.insert("dateMax".to_string(), serde_json::Value::String(d.clone()));
    }
    serde_json::Value::Object(obj)
}

/// 将 config.json 中的变量定义写入 `Plugin.config["vars"]`，与 `get_plugin_vars` 返回数组同构。
fn plugin_config_to_frontend_config_map(
    config: &Option<PluginConfig>,
) -> HashMap<String, serde_json::Value> {
    let mut m = HashMap::new();
    let Some(c) = config.as_ref() else {
        return m;
    };
    let Some(vars) = c.var.as_ref() else {
        return m;
    };
    if vars.is_empty() {
        return m;
    }
    let arr: Vec<serde_json::Value> = vars.iter().map(var_definition_to_frontend_value).collect();
    m.insert("vars".to_string(), serde_json::Value::Array(arr));
    m
}

// 插件配置（config.json）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginConfig {
    #[serde(rename = "baseUrl", default)]
    pub base_url: Option<String>,
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
    /// 可选：index.json 中与 manifest 一致的最低 Kabegame 版本要求
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_app_version: Option<String>,
}

/// 商店源可用性验证结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreSourceValidationResult {
    pub plugin_count: usize,
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

// ── v3 package.json 共用纯函数 ──

/// 判定 package.json 是否 v3 清单（kbPackageVersion >= 3）。
pub fn package_json_is_v3(v: &serde_json::Value) -> bool {
    v.get("kbPackageVersion")
        .and_then(|x| x.as_u64())
        .unwrap_or(0)
        >= 3
}

/// engines.kabegame：仅支持 `>= X.Y.Z` 语法（`>=` 后可有可无空格）。
/// 返回值：裸三段版本字符串（即 minAppVersion）。
pub fn normalize_engines_kabegame(raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("engines.kabegame 值为空".to_string());
    }
    let version_str = match raw.strip_prefix(">=") {
        Some(s) => s.trim(),
        None => {
            return Err(format!(
                "engines.kabegame 仅支持 `>= X.Y.Z` 语法，当前值: \"{}\"",
                raw
            ));
        }
    };
    if version_str.is_empty() {
        return Err(format!(
            "engines.kabegame `>=` 后缺少版本号: \"{}\"",
            raw
        ));
    }
    let _v = semver::Version::parse(version_str).map_err(|e| {
        format!(
            "engines.kabegame 版本号无效 \"{}\": {}",
            version_str, e
        )
    })?;
    Ok(version_str.to_string())
}

/// kb* 路径字段安全校验：插件根相对、禁 ".."/绝对路径/盘符/前导 "/"。
pub fn validate_kb_rel_path(p: &str) -> Result<(), String> {
    if p.is_empty() {
        return Err("kb 路径字段为空".to_string());
    }
    let normalized = p.replace('\\', "/");

    if normalized.starts_with('/') {
        return Err(format!(
            "kb 路径字段不能以 \"/\" 开头: \"{}\"",
            p
        ));
    }

    for seg in normalized.split('/') {
        if seg == ".." {
            return Err(format!(
                "kb 路径字段不能包含 \"..\": \"{}\"",
                p
            ));
        }
    }

    if normalized.contains(":\\") || normalized.contains(":/") {
        return Err(format!(
            "kb 路径字段不能是绝对路径或包含盘符: \"{}\"",
            p
        ));
    }

    Ok(())
}

/// package.json（v3）→ PluginManifest
pub fn plugin_manifest_from_package_json(
    v: &serde_json::Value,
) -> Result<PluginManifest, String> {
    let obj = v
        .as_object()
        .ok_or_else(|| "package.json 必须是 JSON 对象".to_string())?;

    let version = obj
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or("1.0.0")
        .to_string();

    let npm_name = obj
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let author = match obj.get("author") {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(obj @ serde_json::Value::Object(_)) => obj
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        _ => String::new(),
    };

    let min_app_version = obj
        .get("engines")
        .and_then(|eng| eng.get("kabegame"))
        .and_then(|v| v.as_str())
        .map(|raw| normalize_engines_kabegame(raw))
        .transpose()?;

    let mut name = extract_manifest_text_from_flat(obj, "name");
    if name.is_empty() && !npm_name.is_empty() {
        name.insert("name".to_string(), npm_name);
    }

    let description = extract_manifest_text_from_flat(obj, "description");

    Ok(PluginManifest {
        name,
        version,
        description,
        author,
        min_app_version,
    })
}

/// package.json（v3）→ PluginConfig：base_url ← kbBaseUrl；var ← kbConfig。
pub fn plugin_config_from_package_json(
    v: &serde_json::Value,
) -> Result<Option<PluginConfig>, String> {
    let obj = match v.as_object() {
        Some(o) => o,
        None => return Ok(None),
    };

    let base_url = obj
        .get("kbBaseUrl")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());

    let var: Option<Vec<VarDefinition>> = obj
        .get("kbConfig")
        .map(|cfg| -> Result<Vec<VarDefinition>, String> {
            let arr = cfg
                .as_array()
                .ok_or_else(|| "kbConfig 必须是数组".to_string())?;
            let mut defs = Vec::with_capacity(arr.len());
            for item in arr {
                let def: VarDefinition = serde_json::from_value(item.clone()).map_err(|e| {
                    format!("kbConfig 变量定义解析失败: {}", e)
                })?;
                defs.push(def);
            }
            Ok(defs)
        })
        .transpose()?;

    if base_url.is_none() && var.as_ref().map_or(true, |v| v.is_empty()) {
        return Ok(None);
    }

    Ok(Some(PluginConfig { base_url, var }))
}

/// 解析一段 md 中的本地图片引用（![](...) 与 <img src>；跳过 http(s)/data:），
/// 返回 (归一化根相对路径, 原引用串) 列表。
pub fn extract_doc_local_refs(md: &str, doc_dir: &str) -> Vec<(String, String)> {
    let mut refs = Vec::new();
    let patterns = [
        regex::Regex::new(r"!\[[^\]]*\]\(([^)]+)\)").unwrap(),
        regex::Regex::new(r#"<img[^>]+src=["']([^"']+)["'][^>]*>"#).unwrap(),
    ];

    let doc_dir = doc_dir.trim_end_matches('/');

    for pat in &patterns {
        for cap in pat.captures_iter(md) {
            let raw_ref = cap.get(1).unwrap().as_str();
            if raw_ref.starts_with("http://")
                || raw_ref.starts_with("https://")
                || raw_ref.starts_with("data:")
            {
                continue;
            }

            let normalized = if raw_ref.starts_with('/') {
                raw_ref.trim_start_matches('/').to_string()
            } else {
                let prefix = if doc_dir.is_empty() {
                    String::new()
                } else {
                    format!("{}/", doc_dir)
                };
                let combined = format!("{}{}", prefix, raw_ref);
                normalized_path_from_dot_dot(&combined)
            };

            if !normalized.is_empty() {
                refs.push((normalized, raw_ref.to_string()));
            }
        }
    }
    refs
}

fn normalized_path_from_dot_dot(p: &str) -> String {
    let mut stack: Vec<&str> = Vec::new();
    let normalized = p.replace('\\', "/");
    for seg in normalized.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                stack.pop();
            }
            _ => stack.push(seg),
        }
    }
    stack.join("/")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn make_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let buf = std::io::Cursor::new(Vec::new());
        let mut writer = zip::ZipWriter::new(buf);
        let opts =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Stored);
        for (name, data) in entries {
            writer.start_file(*name, opts).unwrap();
            writer.write_all(data).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    fn open_zip(data: &[u8]) -> zip::ZipArchive<std::io::Cursor<Vec<u8>>> {
        zip::ZipArchive::new(std::io::Cursor::new(data.to_vec())).unwrap()
    }

    // ── 公共纯函数测试 ──

    #[test]
    fn test_package_json_is_v3() {
        assert!(package_json_is_v3(
            &serde_json::json!({"kbPackageVersion": 3})
        ));
        assert!(package_json_is_v3(
            &serde_json::json!({"kbPackageVersion": 5})
        ));
        assert!(!package_json_is_v3(&serde_json::json!({})));
        assert!(!package_json_is_v3(
            &serde_json::json!({"kbPackageVersion": 2})
        ));
        assert!(!package_json_is_v3(
            &serde_json::json!({"kbPackageVersion": 1})
        ));
    }

    #[test]
    fn test_normalize_engines_kabegame() {
        assert_eq!(
            normalize_engines_kabegame(">=4.3.0").unwrap(),
            "4.3.0"
        );
        assert_eq!(
            normalize_engines_kabegame(">= 4.3.0").unwrap(),
            "4.3.0"
        );
        assert_eq!(
            normalize_engines_kabegame(">=0.1.0").unwrap(),
            "0.1.0"
        );
        assert!(normalize_engines_kabegame("^4.0.0").is_err());
        assert!(normalize_engines_kabegame("~4.0.0").is_err());
        assert!(normalize_engines_kabegame("4.0.0").is_err());
        assert!(normalize_engines_kabegame(">=4.0.0 || >=5.0.0").is_err());
        assert!(normalize_engines_kabegame("*").is_err());
        assert!(normalize_engines_kabegame("").is_err());
    }

    #[test]
    fn test_validate_kb_rel_path() {
        assert!(validate_kb_rel_path("something/script.js").is_ok());
        assert!(validate_kb_rel_path("script.js").is_ok());
        assert!(validate_kb_rel_path("").is_err());
        assert!(validate_kb_rel_path("../escape.js").is_err());
        assert!(validate_kb_rel_path("foo/../../../etc").is_err());
        assert!(validate_kb_rel_path("/abs.js").is_err());
    }

    #[test]
    fn test_plugin_manifest_from_package_json_basic() {
        let pkg = serde_json::json!({
            "name": "my-plugin",
            "version": "2.0.0",
            "author": "Test Author",
            "description": "desc default",
            "description.zh": "中文描述",
        });
        let m = plugin_manifest_from_package_json(&pkg).unwrap();
        assert_eq!(m.name.get("name").unwrap(), "my-plugin");
        assert_eq!(m.version, "2.0.0");
        assert_eq!(m.author, "Test Author");
        assert_eq!(
            m.description.get("description").unwrap(),
            "desc default"
        );
        assert_eq!(
            m.description.get("description.zh").unwrap(),
            "中文描述"
        );
        assert!(m.min_app_version.is_none());
    }

    #[test]
    fn test_plugin_manifest_from_package_json_author_object() {
        let pkg = serde_json::json!({
            "name": "p",
            "version": "1.0.0",
            "author": {"name": "Author Name", "email": "a@b.com"}
        });
        let m = plugin_manifest_from_package_json(&pkg).unwrap();
        assert_eq!(m.author, "Author Name");
    }

    #[test]
    fn test_plugin_manifest_from_package_json_min_version() {
        let pkg = serde_json::json!({
            "name": "p",
            "version": "1.0.0",
            "engines": {"kabegame": ">= 4.3.0"}
        });
        let m = plugin_manifest_from_package_json(&pkg).unwrap();
        assert_eq!(m.min_app_version, Some("4.3.0".to_string()));
    }

    #[test]
    fn test_plugin_config_from_package_json() {
        let pkg = serde_json::json!({
            "kbBaseUrl": "https://example.com",
            "kbConfig": [
                {"key": "tag", "name": "Tag", "type": "string", "default": "cat"}
            ]
        });
        let c = plugin_config_from_package_json(&pkg).unwrap().unwrap();
        assert_eq!(c.base_url, Some("https://example.com".to_string()));
        let vars = c.var.unwrap();
        assert_eq!(vars.len(), 1);
        assert_eq!(vars[0].key, "tag");
    }

    #[test]
    fn test_extract_doc_local_refs() {
        let md = r#"
# Title
![img](./img.png)
<img src="sub/photo.jpg">
![](/assets/icon.png)
![ext](https://example.com/ext.png)
![data](data:image/png;base64,abc)
"#;
        let refs = extract_doc_local_refs(md, "doc");
        assert_eq!(refs.len(), 3);

        let paths: Vec<&str> = refs.iter().map(|(p, _)| p.as_str()).collect();
        assert!(paths.contains(&"doc/img.png"));
        assert!(paths.contains(&"doc/sub/photo.jpg"));
        assert!(paths.contains(&"assets/icon.png"));

        let original_refs: Vec<&str> = refs.iter().map(|(_, r)| r.as_str()).collect();
        assert!(original_refs.contains(&"./img.png"));
        assert!(original_refs.contains(&"sub/photo.jpg"));
        assert!(original_refs.contains(&"/assets/icon.png"));

        // should NOT include external refs
        for (_, ref_str) in &refs {
            assert!(!ref_str.starts_with("http"));
            assert!(!ref_str.starts_with("data:"));
        }
    }

    // ── v3 zip 装载测试 ──

    #[test]
    fn test_v3_load_with_v8_backend() {
        let pkg = serde_json::json!({
            "name": "test-v3",
            "version": "1.0.0",
            "author": "Tester",
            "kbPackageVersion": 3,
            "kbBackend": "v8",
            "main": "crawl/crawl.js",
            "description": "test desc",
        });
        let js_source = "export async function crawl() {}";
        let data = make_zip(&[
            ("package.json", serde_json::to_string_pretty(&pkg).unwrap().as_bytes()),
            ("crawl/crawl.js", js_source.as_bytes()),
        ]);

        let plugin_id = "test-v3";
        let mut archive = open_zip(&data);
        let result = load_plugin_v3_from_zip(
            &mut archive,
            &pkg,
            plugin_id,
            2 * 1024 * 1024,
            10 * 1024 * 1024,
        );
        let (manifest, _config, _doc, script_type, _icon, _tpl, _configs, script, _res, _prov, _mig) =
            result.unwrap();

        assert_eq!(manifest.version, "1.0.0");
        assert_eq!(script_type, "v8");
        assert_eq!(script.v8_source(), Some(js_source));
        assert!(script.js_source().is_none());
    }

    #[test]
    fn test_v3_load_missing_main_ref_error() {
        let pkg = serde_json::json!({
            "name": "t",
            "version": "1.0.0",
            "kbPackageVersion": 3,
            "kbBackend": "v8",
            "main": "nonexistent.js",
        });
        let data = make_zip(&[(
            "package.json",
            serde_json::to_string_pretty(&pkg).unwrap().as_bytes(),
        )]);

        let plugin_id = "t";
        let mut archive = open_zip(&data);
        let result = load_plugin_v3_from_zip(
            &mut archive,
            &pkg,
            plugin_id,
            2 * 1024 * 1024,
            10 * 1024 * 1024,
        );
        assert!(
            result.is_err(),
            "missing main ref should error"
        );
        let err = result.unwrap_err();
        assert!(
            err.contains("不在包内"),
            "error: {}",
            err
        );
    }

    #[test]
    fn test_pack_plugin_version() {
        assert_eq!(pack_plugin_version("3.4.1").unwrap(), 0x0003_0401);
        assert_eq!(pack_plugin_version("1.6.3").unwrap(), 0x0001_0603);
        assert_eq!(pack_plugin_version("0.0.0").unwrap(), 0);
        assert_eq!(pack_plugin_version("255.255.255").unwrap(), 0x00FF_FFFF);
        assert!(pack_plugin_version("1.2").is_err());
        assert!(pack_plugin_version("1.2.3.4").is_err());
        assert!(pack_plugin_version("1.2.256").is_err());
        assert!(pack_plugin_version("abc").is_err());
        // packed 比较与语义版本先后一致
        assert!(pack_plugin_version("1.10.0").unwrap() > pack_plugin_version("1.9.9").unwrap());
    }

    #[test]
    fn test_v3_load_metadata_migration_single_script() {
        let pkg = serde_json::json!({
            "name": "t",
            "version": "1.0.0",
            "kbPackageVersion": 3,
            "kbBackend": "v8",
            "main": "main.js",
            "kbMetadataMigration": "metadata_migrations/migrate.js",
        });
        let mig_source = "export function migrate(input) { return input; }";
        let data = make_zip(&[
            ("package.json", serde_json::to_string_pretty(&pkg).unwrap().as_bytes()),
            ("main.js", b"export async function crawl() {}"),
            ("metadata_migrations/migrate.js", mig_source.as_bytes()),
        ]);
        let mut archive = open_zip(&data);
        let (.., mig) = load_plugin_v3_from_zip(&mut archive, &pkg, "t", 2 << 20, 10 << 20).unwrap();
        assert_eq!(mig.as_deref(), Some(mig_source));
    }

    #[test]
    fn test_v3_load_metadata_migration_missing_file_error() {
        let pkg = serde_json::json!({
            "name": "t",
            "version": "1.0.0",
            "kbPackageVersion": 3,
            "kbBackend": "v8",
            "main": "main.js",
            "kbMetadataMigration": "metadata_migrations/migrate.js",
        });
        let data = make_zip(&[
            ("package.json", serde_json::to_string_pretty(&pkg).unwrap().as_bytes()),
            ("main.js", b"export async function crawl() {}"),
        ]);
        let mut archive = open_zip(&data);
        let err = load_plugin_v3_from_zip(&mut archive, &pkg, "t", 2 << 20, 10 << 20).unwrap_err();
        assert!(err.contains("不在包内"), "error: {}", err);
    }

    #[test]
    fn test_v3_load_metadata_migration_non_js_error() {
        let pkg = serde_json::json!({
            "name": "t",
            "version": "1.0.0",
            "kbPackageVersion": 3,
            "kbBackend": "v8",
            "main": "main.js",
            "kbMetadataMigration": "metadata_migrations/migrate.rhai",
        });
        let data = make_zip(&[
            ("package.json", serde_json::to_string_pretty(&pkg).unwrap().as_bytes()),
            ("main.js", b"export async function crawl() {}"),
            ("metadata_migrations/migrate.rhai", b"fn migrate(m) { m }"),
        ]);
        let mut archive = open_zip(&data);
        let err = load_plugin_v3_from_zip(&mut archive, &pkg, "t", 2 << 20, 10 << 20).unwrap_err();
        assert!(err.contains(".js"), "error: {}", err);
    }

    #[test]
    fn test_v3_load_legacy_migrations_array_ignored() {
        // 旧 kbMetadataMigrations 数组键完全不解析：正常加载且 metadata_migration 为 None
        let pkg = serde_json::json!({
            "name": "t",
            "version": "1.0.0",
            "kbPackageVersion": 3,
            "kbBackend": "v8",
            "main": "main.js",
            "kbMetadataMigrations": ["metadata_migrations/v1.rhai"],
        });
        let data = make_zip(&[
            ("package.json", serde_json::to_string_pretty(&pkg).unwrap().as_bytes()),
            ("main.js", b"export async function crawl() {}"),
        ]);
        let mut archive = open_zip(&data);
        let (.., mig) = load_plugin_v3_from_zip(&mut archive, &pkg, "t", 2 << 20, 10 << 20).unwrap();
        assert!(mig.is_none());
    }

    #[test]
    fn test_v3_load_invalid_kb_backend() {
        let pkg = serde_json::json!({
            "name": "t",
            "version": "1.0.0",
            "kbPackageVersion": 3,
            "kbBackend": "python",
            "main": "s.py",
            "description": "d",
        });
        let data = make_zip(&[
            ("package.json", serde_json::to_string_pretty(&pkg).unwrap().as_bytes()),
            ("s.py", b"print('hi')"),
        ]);

        let plugin_id = "t";
        let mut archive = open_zip(&data);
        let result = load_plugin_v3_from_zip(
            &mut archive,
            &pkg,
            plugin_id,
            2 * 1024 * 1024,
            10 * 1024 * 1024,
        );
        assert!(
            result.is_err(),
            "invalid kbBackend should error"
        );
    }

    // ── PluginScript 构造回归测试 ──

    #[test]
    fn test_script_webview_and_v8_sources() {
        let webview = PluginScript::new(PluginBackend::Webview, "// crawl js".to_string());
        assert_eq!(webview.script_type_str(), "js");
        assert_eq!(webview.js_source(), Some("// crawl js"));
        assert_eq!(webview.v8_source(), None);

        let v8 = PluginScript::new(PluginBackend::V8, "// crawl v8".to_string());
        assert_eq!(v8.script_type_str(), "v8");
        assert_eq!(v8.v8_source(), Some("// crawl v8"));
        assert_eq!(v8.js_source(), None);

        let empty = PluginScript::default();
        assert_eq!(empty.js_source(), None);
        assert_eq!(empty.v8_source(), None);
    }

    #[test]
    fn test_backend_rhai_rejected() {
        // Rhai 后端已移除：kbBackend "rhai" 解析报可读错误。
        let err = PluginBackend::from_str("rhai").unwrap_err();
        assert!(err.contains("Rhai"), "error: {}", err);
        assert!(PluginBackend::from_str("v8").is_ok());
        assert!(PluginBackend::from_str("webview").is_ok());
    }
}
