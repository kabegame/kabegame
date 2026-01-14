#![allow(dead_code)]

pub mod task_scheduler;

pub use task_scheduler::{CrawlTaskRequest, TaskScheduler};

use crate::plugin::Plugin;
use crate::plugin::{VarDefinition, VarOption};
use reqwest;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::collections::HashSet;
use std::collections::VecDeque;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use tauri::{AppHandle, Emitter, Manager};
use url::Url;
use zip::ZipArchive;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ArchiveType {
    Zip,
}

impl ArchiveType {
    fn parse(s: &str) -> Option<Self> {
        let t = s.trim().to_ascii_lowercase();
        match t.as_str() {
            "zip" => Some(ArchiveType::Zip),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskLogEvent {
    pub task_id: String,
    pub level: String,
    pub message: String,
    pub ts: u64,
}

pub fn emit_task_log(app: &AppHandle, task_id: &str, level: &str, message: impl Into<String>) {
    let task_id = task_id.trim();
    if task_id.is_empty() {
        return;
    }
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let _ = app.emit(
        "task-log",
        TaskLogEvent {
            task_id: task_id.to_string(),
            level: level.to_string(),
            message: message.into(),
            ts,
        },
    );
}

fn build_reqwest_header_map(
    app: &AppHandle,
    task_id: &str,
    headers: &HashMap<String, String>,
) -> HeaderMap {
    let mut map = HeaderMap::new();
    for (k, v) in headers {
        let key = k.trim();
        if key.is_empty() {
            continue;
        }
        let name = match HeaderName::from_bytes(key.as_bytes()) {
            Ok(n) => n,
            Err(e) => {
                emit_task_log(
                    app,
                    task_id,
                    "warn",
                    format!("[headers] 跳过无效 header 名：{key} ({e})"),
                );
                continue;
            }
        };
        let value = match HeaderValue::from_str(v) {
            Ok(v) => v,
            Err(e) => {
                emit_task_log(
                    app,
                    task_id,
                    "warn",
                    format!("[headers] 跳过无效 header 值：{key} ({e})"),
                );
                continue;
            }
        };
        map.insert(name, value);
    }
    map
}

fn download_file_to_path_with_retry(
    app: &AppHandle,
    task_id: &str,
    url: &str,
    dest: &Path,
    headers: &HashMap<String, String>,
    retry_count: u32,
) -> Result<(), String> {
    let client = create_blocking_client()?;
    let header_map = build_reqwest_header_map(app, task_id, headers);
    let max_attempts = retry_count.saturating_add(1).max(1);

    let mut attempt: u32 = 0;
    loop {
        attempt += 1;

        let dq = app.state::<DownloadQueue>();
        if dq.is_task_canceled(task_id) {
            return Err("Task canceled".to_string());
        }

        let mut req = client.get(url);
        if !header_map.is_empty() {
            req = req.headers(header_map.clone());
        }

        let resp = match req.send() {
            Ok(r) => r,
            Err(e) => {
                if attempt < max_attempts {
                    let backoff_ms = (500u64)
                        .saturating_mul(2u64.saturating_pow((attempt - 1) as u32))
                        .min(5000);
                    std::thread::sleep(std::time::Duration::from_millis(backoff_ms));
                    continue;
                }
                return Err(format!("Failed to download archive: {e}"));
            }
        };

        let status = resp.status();
        if !status.is_success() {
            let retryable =
                status.as_u16() == 408 || status.as_u16() == 429 || status.is_server_error();
            if retryable && attempt < max_attempts {
                let backoff_ms = (500u64)
                    .saturating_mul(2u64.saturating_pow((attempt - 1) as u32))
                    .min(5000);
                std::thread::sleep(std::time::Duration::from_millis(backoff_ms));
                continue;
            }
            return Err(format!("HTTP error: {status}"));
        }

        let mut file = std::fs::File::create(dest)
            .map_err(|e| format!("Failed to create archive file: {e}"))?;
        let mut reader = resp;
        std::io::copy(&mut reader, &mut file)
            .map_err(|e| format!("Failed to write archive file: {e}"))?;
        return Ok(());
    }
}

/// 创建配置了系统代理的 reqwest 客户端
/// 自动从环境变量读取 HTTP_PROXY, HTTPS_PROXY, NO_PROXY 等配置
#[allow(dead_code)]
pub fn create_client() -> Result<reqwest::Client, String> {
    let mut client_builder = reqwest::Client::builder();

    // 配置代理：自动从环境变量读取系统代理设置
    // 支持 HTTP_PROXY, HTTPS_PROXY, http_proxy, https_proxy
    if let Ok(proxy_url) = std::env::var("HTTP_PROXY")
        .or_else(|_| std::env::var("http_proxy"))
        .or_else(|_| std::env::var("HTTPS_PROXY"))
        .or_else(|_| std::env::var("https_proxy"))
    {
        if !proxy_url.trim().is_empty() {
            match reqwest::Proxy::all(&proxy_url) {
                Ok(proxy) => {
                    client_builder = client_builder.proxy(proxy);
                    eprintln!("网络代理已配置: {}", proxy_url);
                }
                Err(e) => {
                    eprintln!("代理配置无效 ({}), 将使用直连: {}", proxy_url, e);
                }
            }
        }
    }

    // 配置不使用代理的地址列表
    if let Ok(no_proxy) = std::env::var("NO_PROXY").or_else(|_| std::env::var("no_proxy")) {
        if !no_proxy.trim().is_empty() {
            // NO_PROXY 格式通常是逗号分隔的域名/IP列表，如: localhost,127.0.0.1,.local
            let no_proxy_list: Vec<&str> = no_proxy.split(',').map(|s| s.trim()).collect();
            for domain in no_proxy_list {
                if !domain.is_empty() {
                    match reqwest::Proxy::all(&format!("direct://{}", domain)) {
                        Ok(proxy) => {
                            client_builder = client_builder.proxy(proxy);
                        }
                        Err(e) => {
                            eprintln!("跳过无效的 NO_PROXY 配置 {}: {}", domain, e);
                        }
                    }
                }
            }
        }
    }

    // 设置合理的超时时间，避免请求挂起
    client_builder = client_builder
        .timeout(std::time::Duration::from_secs(30))
        .connect_timeout(std::time::Duration::from_secs(10))
        .user_agent("Kabegame/1.0");

    client_builder
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))
}

/// 创建阻塞版本的配置了系统代理的 reqwest 客户端
pub fn create_blocking_client() -> Result<reqwest::blocking::Client, String> {
    let mut client_builder = reqwest::blocking::Client::builder();

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
                    eprintln!("网络代理已配置 (blocking): {}", proxy_url);
                }
                Err(e) => {
                    eprintln!("代理配置无效 ({}), 将使用直连 (blocking): {}", proxy_url, e);
                }
            }
        }
    }

    // 配置不使用代理的地址列表
    if let Ok(no_proxy) = std::env::var("NO_PROXY").or_else(|_| std::env::var("no_proxy")) {
        if !no_proxy.trim().is_empty() {
            let no_proxy_list: Vec<&str> = no_proxy.split(',').map(|s| s.trim()).collect();
            for domain in no_proxy_list {
                if !domain.is_empty() {
                    match reqwest::Proxy::all(&format!("direct://{}", domain)) {
                        Ok(proxy) => {
                            client_builder = client_builder.proxy(proxy);
                        }
                        Err(e) => {
                            eprintln!("跳过无效的 NO_PROXY 配置 {}: {}", domain, e);
                        }
                    }
                }
            }
        }
    }

    // 设置合理的超时时间，避免请求挂起
    client_builder = client_builder
        .timeout(std::time::Duration::from_secs(30))
        .connect_timeout(std::time::Duration::from_secs(10))
        .user_agent("Kabegame/1.0");

    client_builder
        .build()
        .map_err(|e| format!("Failed to create blocking HTTP client: {}", e))
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CrawlResult {
    pub total: usize,
    pub downloaded: usize,
    pub images: Vec<ImageData>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageData {
    pub url: String,
    #[serde(rename = "localPath")]
    pub local_path: String,
    pub metadata: Option<HashMap<String, String>>,
    #[serde(rename = "thumbnailPath")]
    #[serde(default)]
    pub thumbnail_path: String,
}

pub async fn crawl_images(
    plugin: &Plugin,
    task_id: &str, // 用于设置任务进度
    images_dir: PathBuf,
    app: AppHandle,
    user_config: Option<HashMap<String, serde_json::Value>>, // 用户配置的变量
    output_album_id: Option<String>, // 输出画册ID，如果指定则下载完成后自动添加到画册
) -> Result<CrawlResult, String> {
    // 获取插件文件路径
    let plugin_manager = app.state::<crate::plugin::PluginManager>();
    let plugins_dir = plugin_manager.get_plugins_directory();

    // 查找插件文件
    let plugin_file = find_plugin_file(&plugins_dir, &plugin.id)?;

    // 读取爬取脚本（必须存在，否则报错）
    let script_content = plugin_manager
        .read_plugin_script(&plugin_file)?
        .ok_or_else(|| format!("插件 {} 没有提供 crawl.rhai 脚本文件，无法执行", plugin.id))?;

    // 构造最终注入配置：
    // - 先从插件 config.json 的 var 定义里拿默认值（确保 start_page 等变量始终存在）
    // - 再用 user_config 覆盖默认值
    // - checkbox 默认/输入统一规范化为对象：{ option: bool }
    let merged_config = build_effective_user_config(&app, &plugin.id, user_config)?;

    // Debug：打印最终注入的变量，定位"为什么脚本里变量不存在"
    #[cfg(debug_assertions)]
    {
        let mut keys: Vec<_> = merged_config.keys().cloned().collect();
        keys.sort();
        eprintln!(
            "[rhai-inject] plugin_id={} injected_keys={:?}",
            plugin.id, keys
        );
    }

    // 执行 Rhai 爬虫脚本（位于 plugin 模块中）
    crate::plugin::rhai::execute_crawler_script(
        plugin,
        &images_dir,
        &app,
        &plugin.id,
        task_id,
        &script_content,
        merged_config,
        output_album_id,
    )?;

    // 获取正在下载的任务数量（已移除队列，只有正在下载的）
    let download_queue = app.state::<DownloadQueue>();
    let active_downloads = download_queue.get_active_downloads().unwrap_or_default();

    let total = active_downloads.len();

    // 返回结果，表示脚本执行成功
    // 实际的下载由脚本中的 download_image 同步调用完成
    Ok(CrawlResult {
        total,
        downloaded: 0,      // 下载是同步的，但这里无法立即知道已下载数量
        images: Vec::new(), // 图片会在下载完成后自动添加到 gallery
    })
}

/// 读取插件变量定义，合并默认值与用户配置，并对部分类型进行规范化（尤其是 checkbox）。
fn build_effective_user_config(
    app: &AppHandle,
    plugin_id: &str,
    user_config: Option<HashMap<String, serde_json::Value>>,
) -> Result<HashMap<String, serde_json::Value>, String> {
    let plugin_manager = app.state::<crate::plugin::PluginManager>();
    let user_cfg = user_config.unwrap_or_default();

    // 读取插件变量定义（config.json 的 var）
    let var_defs: Vec<VarDefinition> = plugin_manager
        .get_plugin_vars(plugin_id)?
        .unwrap_or_default();

    Ok(build_effective_user_config_from_var_defs(
        &var_defs, user_cfg,
    ))
}

/// 将变量定义（var_defs）的默认值与用户配置合并，并对部分类型做规范化。
///
/// 说明：
/// - 该函数不依赖 AppHandle，便于在 CLI/路径运行场景复用（由调用方自行读取 var_defs）。
/// 将变量定义（var_defs）的默认值与用户配置合并，并对部分类型做规范化。
///
/// 说明：
/// - 该函数不依赖 AppHandle，便于在 CLI/插件编辑器等场景复用（由调用方自行读取 var_defs）。
pub fn build_effective_user_config_from_var_defs(
    var_defs: &[VarDefinition],
    user_cfg: HashMap<String, serde_json::Value>,
) -> HashMap<String, serde_json::Value> {
    // 先按 var_defs 填满所有变量（默认值 -> 用户值覆盖）
    let mut merged: HashMap<String, serde_json::Value> = HashMap::new();
    for def in var_defs {
        let user_value = user_cfg.get(&def.key).cloned();
        let default_value = def.default.clone();
        let normalized = normalize_var_value(def, user_value.or(default_value));
        merged.insert(def.key.clone(), normalized);
    }

    // 再把 user_cfg 中那些不在 var_defs 里的键也注入（保持兼容扩展变量）
    for (k, v) in user_cfg {
        if !merged.contains_key(&k) {
            merged.insert(k, v);
        }
    }

    merged
}

/// 从指定的插件文件（.kgpg 路径）执行爬虫脚本。
///
/// 用途：
/// - CLI/sidecar 支持通过插件文件路径运行（不要求插件已安装到 plugins_directory）
pub async fn crawl_images_from_plugin_file(
    plugin: &Plugin,
    plugin_file: &Path,
    task_id: &str,
    images_dir: PathBuf,
    app: AppHandle,
    user_config: Option<HashMap<String, serde_json::Value>>, // 用户配置的变量
    output_album_id: Option<String>,
) -> Result<CrawlResult, String> {
    let plugin_manager = app.state::<crate::plugin::PluginManager>();

    // 读取爬取脚本（必须存在，否则报错）
    let script_content = plugin_manager
        .read_plugin_script(plugin_file)?
        .ok_or_else(|| format!("插件 {} 没有提供 crawl.rhai 脚本文件，无法执行", plugin.id))?;

    // 读取变量定义（从插件文件本身读取）
    let var_defs = plugin_manager.get_plugin_vars_from_file(plugin_file)?;

    // 先构造 merged_config（默认值 -> 用户覆盖 -> checkbox 规范化）
    let merged_config =
        build_effective_user_config_from_var_defs(&var_defs, user_config.unwrap_or_default());

    // 执行 Rhai 爬虫脚本（位于 plugin 模块中）
    crate::plugin::rhai::execute_crawler_script(
        plugin,
        &images_dir,
        &app,
        &plugin.id,
        task_id,
        &script_content,
        merged_config,
        output_album_id,
    )?;

    // 获取正在下载的任务数量（已移除队列，只有正在下载的）
    let download_queue = app.state::<DownloadQueue>();
    let active_downloads = download_queue.get_active_downloads().unwrap_or_default();

    let total = active_downloads.len();

    Ok(CrawlResult {
        total,
        downloaded: 0,
        images: Vec::new(),
    })
}

fn extract_option_variables(options: &Option<Vec<VarOption>>) -> Vec<String> {
    match options {
        None => Vec::new(),
        Some(opts) => opts
            .iter()
            .filter_map(|o| match o {
                VarOption::String(s) => Some(s.clone()),
                VarOption::Item { variable, .. } => Some(variable.clone()),
            })
            .collect(),
    }
}

/// 将变量值规范化，确保脚本侧不会出现"变量不存在"或类型完全不匹配。
/// - checkbox：无论输入是 ["a","b"] 还是 {a:true,b:false}，都输出对象 { option: bool }
fn normalize_var_value(def: &VarDefinition, value: Option<serde_json::Value>) -> serde_json::Value {
    let t = def.var_type.as_str();
    match t {
        "checkbox" => {
            let vars = extract_option_variables(&def.options);
            let mut obj = serde_json::Map::new();
            for k in &vars {
                obj.insert(k.clone(), serde_json::Value::Bool(false));
            }

            match value {
                Some(serde_json::Value::Object(m)) => {
                    for (k, v) in m {
                        let b = match v {
                            serde_json::Value::Bool(b) => b,
                            serde_json::Value::Number(n) => n.as_i64().unwrap_or(0) != 0,
                            serde_json::Value::String(s) => s == "true" || s == "1",
                            _ => false,
                        };
                        obj.insert(k, serde_json::Value::Bool(b));
                    }
                }
                Some(serde_json::Value::Array(arr)) => {
                    for it in arr {
                        if let serde_json::Value::String(s) = it {
                            obj.insert(s, serde_json::Value::Bool(true));
                        }
                    }
                }
                Some(serde_json::Value::String(s)) => {
                    obj.insert(s, serde_json::Value::Bool(true));
                }
                _ => {
                    // 无值：保持全 false（或由 config.json default 已经传入）
                }
            }
            serde_json::Value::Object(obj)
        }
        "int" => match value {
            Some(serde_json::Value::Number(n)) => {
                serde_json::Value::Number(serde_json::Number::from(n.as_i64().unwrap_or(0)))
            }
            Some(serde_json::Value::String(s)) => {
                serde_json::Value::Number(serde_json::Number::from(s.parse::<i64>().unwrap_or(0)))
            }
            Some(serde_json::Value::Bool(b)) => {
                serde_json::Value::Number(serde_json::Number::from(if b { 1 } else { 0 }))
            }
            _ => serde_json::Value::Number(serde_json::Number::from(0)),
        },
        "float" => match value {
            Some(serde_json::Value::Number(n)) => serde_json::Value::Number(
                serde_json::Number::from_f64(n.as_f64().unwrap_or(0.0)).unwrap(),
            ),
            Some(serde_json::Value::String(s)) => serde_json::Value::Number(
                serde_json::Number::from_f64(s.parse::<f64>().unwrap_or(0.0)).unwrap(),
            ),
            Some(serde_json::Value::Bool(b)) => serde_json::Value::Number(
                serde_json::Number::from_f64(if b { 1.0 } else { 0.0 }).unwrap(),
            ),
            _ => serde_json::Value::Number(serde_json::Number::from_f64(0.0).unwrap()),
        },
        "boolean" => match value {
            Some(serde_json::Value::Bool(b)) => serde_json::Value::Bool(b),
            Some(serde_json::Value::Number(n)) => {
                serde_json::Value::Bool(n.as_i64().unwrap_or(0) != 0)
            }
            Some(serde_json::Value::String(s)) => serde_json::Value::Bool(s == "true" || s == "1"),
            _ => serde_json::Value::Bool(false),
        },
        // options/list/其它：保持原样；若无值则给一个可用的空值，避免变量缺失
        "options" => match value {
            Some(v) => v,
            None => serde_json::Value::String(String::new()),
        },
        "list" => match value {
            Some(serde_json::Value::Array(arr)) => serde_json::Value::Array(arr),
            Some(v) => v,
            None => serde_json::Value::Array(vec![]),
        },
        _ => value.unwrap_or(serde_json::Value::Null),
    }
}

/// 查找插件文件
fn find_plugin_file(plugins_dir: &Path, plugin_id: &str) -> Result<PathBuf, String> {
    let entries = fs::read_dir(plugins_dir)
        .map_err(|e| format!("Failed to read plugins directory: {}", e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
        let path = entry.path();

        if path.is_file() && path.extension().and_then(|s| s.to_str()) == Some("kgpg") {
            // 插件 ID = 插件文件名（不含扩展名）
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

    Err(format!("Plugin file not found for {}", plugin_id))
}

/// 获取默认的图片目录（用于判断是否是用户指定的目录）
pub fn get_default_images_dir() -> PathBuf {
    // 先尝试获取用户的Pictures目录
    if let Some(pictures_dir) = dirs::picture_dir() {
        pictures_dir.join("Kabegame")
    } else {
        // 如果获取不到Pictures目录，回落到原来的设置
        crate::app_paths::kabegame_data_dir().join("images")
    }
}

#[derive(Debug, Clone)]
struct DownloadedImage {
    path: PathBuf,
    thumbnail: Option<PathBuf>,
    hash: String,
    reused: bool,
    /// 是否“由本次任务创建/复制/下载”得到的图片文件（用于取消/去重跳过时的清理策略）
    /// - false: 来源文件本就在输出目录内或复用已有记录时，不应删除源文件
    /// - true : 本次任务落盘产生的新文件，可在取消/跳过入库时清理
    owns_file: bool,
}

/// 确保下载过程至少持续指定时间（从开始时间算起）
/// 如果已经超过最小时间，则立即返回；否则休眠剩余时间
fn ensure_minimum_duration(download_start_time: u64, min_duration_ms: u64) {
    let elapsed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        - download_start_time;
    if elapsed < min_duration_ms {
        let remaining = min_duration_ms - elapsed;
        std::thread::sleep(std::time::Duration::from_millis(remaining));
    }
}

fn compute_file_hash(path: &Path) -> Result<String, String> {
    let mut file =
        fs::File::open(path).map_err(|e| format!("Failed to open file for hash: {}", e))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 8192];
    loop {
        let n = file
            .read(&mut buffer)
            .map_err(|e| format!("Failed to read file for hash: {}", e))?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn resolve_local_path_from_url(url: &str) -> Option<PathBuf> {
    // 支持：
    // - file:///xxx
    // - file://xxx
    // - 直接的本地绝对/相对路径（但必须存在）
    let path = if url.starts_with("file://") {
        let path_str = if url.starts_with("file:///") {
            &url[8..]
        } else {
            &url[7..]
        };
        #[cfg(windows)]
        let path_str = path_str.replace("/", "\\");
        #[cfg(not(windows))]
        let path_str = path_str;
        PathBuf::from(path_str)
    } else {
        let p = PathBuf::from(url);
        if !p.exists() {
            return None;
        }
        p
    };

    path.canonicalize().ok()
}

fn is_zip_path(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("zip"))
        .unwrap_or(false)
}

fn is_supported_image_ext(ext: &str) -> bool {
    // 与 local-import 默认扩展名保持一致（避免 svg 等非 raster 格式导致 thumbnail 失败）
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp" | "ico"
    )
}

fn collect_images_recursive(dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    let entries = fs::read_dir(dir).map_err(|e| format!("Failed to read directory: {}", e))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
        let p = entry.path();
        if p.is_dir() {
            collect_images_recursive(&p, out)?;
        } else if p.is_file() {
            if let Some(ext) = p.extension().and_then(|e| e.to_str()) {
                if is_supported_image_ext(ext) {
                    out.push(p);
                }
            }
        }
    }
    Ok(())
}

#[derive(Debug)]
struct TempDirGuard {
    path: PathBuf,
}

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        // 需求：任何时候都要清理（best-effort）
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn extract_zip_to_dir(zip_path: &Path, dst_dir: &Path) -> Result<(), String> {
    let file = fs::File::open(zip_path).map_err(|e| format!("Failed to open zip: {}", e))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("Failed to open zip: {}", e))?;

    for i in 0..archive.len() {
        let mut f = archive
            .by_index(i)
            .map_err(|e| format!("Failed to read zip entry #{}: {}", i, e))?;

        // 安全：拒绝路径穿越
        let Some(rel) = f.enclosed_name().map(|p| p.to_owned()) else {
            continue;
        };

        let out_path = dst_dir.join(rel);
        if f.name().ends_with('/') {
            fs::create_dir_all(&out_path)
                .map_err(|e| format!("Failed to create dir {}: {}", out_path.display(), e))?;
            continue;
        }

        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create dir {}: {}", parent.display(), e))?;
        }

        let mut out_file =
            fs::File::create(&out_path).map_err(|e| format!("Failed to write file: {}", e))?;
        std::io::copy(&mut f, &mut out_file)
            .map_err(|e| format!("Failed to extract zip entry: {}", e))?;
        let _ = out_file.flush();
    }

    Ok(())
}

#[allow(dead_code)]
fn compute_bytes_hash(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// Windows/跨平台安全的文件名长度上限（保守值，避免 Win32 ERROR_INVALID_NAME=123）
/// - Windows 单个文件名通常上限为 255（UTF-16 code units）
/// - 这里取更保守值，给 unique_path 的 “(n)” 与临时名后缀留空间
const MAX_SAFE_FILENAME_LEN: usize = 180;

fn short_hash8(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    let full = format!("{:x}", hasher.finalize());
    full.chars().take(8).collect()
}

fn clamp_ascii_len(s: &str, max_len: usize) -> &str {
    if s.len() <= max_len {
        return s;
    }
    // 这里的 stem 只包含 ASCII（sanitize 后），按字节切片安全
    &s[..max_len]
}

fn is_windows_reserved_device_name(stem: &str) -> bool {
    // https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file
    let u = stem
        .trim()
        .trim_end_matches([' ', '.'])
        .to_ascii_uppercase();
    if matches!(u.as_str(), "CON" | "PRN" | "AUX" | "NUL") {
        return true;
    }
    if (u.starts_with("COM") || u.starts_with("LPT")) && u.len() == 4 {
        return matches!(
            u.chars().nth(3),
            Some('1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9')
        );
    }
    false
}

fn sanitize_stem_for_filename(stem: &str) -> String {
    let mut out: String = stem
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == ' ' {
                c
            } else {
                '_'
            }
        })
        .collect();

    // 压缩空格，避免极长的连续空格
    while out.contains("  ") {
        out = out.replace("  ", " ");
    }

    // Windows 不允许末尾是空格/点
    let out = out.trim().trim_end_matches([' ', '.']).to_string();

    let mut out = if out.is_empty() {
        "image".to_string()
    } else {
        out
    };
    if is_windows_reserved_device_name(&out) {
        out = format!("_{}", out);
    }
    out
}

fn normalize_ext(ext: &str, fallback_ext: &str) -> String {
    let e = ext.trim().trim_start_matches('.').trim();
    let e = if e.is_empty() { fallback_ext.trim() } else { e };
    let e = e.trim().trim_start_matches('.').trim();
    if e.is_empty() {
        "jpg".to_string()
    } else {
        e.to_ascii_lowercase()
    }
}

/// 生成“安全且长度受控”的文件名：
/// - 保留部分可读 stem
/// - 追加稳定短 hash（基于 hash_source）避免碰撞
/// - 总长度限制在 MAX_SAFE_FILENAME_LEN 内
fn build_safe_filename(hint_filename: &str, fallback_ext: &str, hash_source: &str) -> String {
    let path = Path::new(hint_filename);
    let raw_stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("image");
    let raw_ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");

    let ext = normalize_ext(raw_ext, fallback_ext);
    let stem = sanitize_stem_for_filename(raw_stem);
    let h = short_hash8(hash_source);
    let suffix = format!("-{}", h);

    // stem + suffix + "." + ext <= MAX_SAFE_FILENAME_LEN
    let reserve = suffix.len() + 1 + ext.len(); // 1 for '.'
    let stem_max = MAX_SAFE_FILENAME_LEN.saturating_sub(reserve).max(1);
    let stem_final = clamp_ascii_len(&stem, stem_max);

    format!("{}{}.{}", stem_final, suffix, ext)
}

// 兼容旧调用点（目前不再使用）；保留以减少未来改动成本
#[allow(dead_code)]
fn sanitize_filename(name: &str, fallback_ext: &str) -> String {
    build_safe_filename(name, fallback_ext, name)
}

fn unique_path(dir: &Path, filename: &str) -> PathBuf {
    let mut candidate = dir.join(filename);
    if !candidate.exists() {
        return candidate;
    }

    let path = Path::new(filename);
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("image");
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");

    let mut idx = 1;
    loop {
        let suffix = format!("({})", idx);
        let (stem_max, ext_part) = if ext.is_empty() {
            (
                MAX_SAFE_FILENAME_LEN.saturating_sub(suffix.len()).max(1),
                String::new(),
            )
        } else {
            (
                MAX_SAFE_FILENAME_LEN
                    .saturating_sub(suffix.len() + 1 + ext.len())
                    .max(1),
                format!(".{}", ext),
            )
        };
        let stem_final = clamp_ascii_len(stem, stem_max);
        let new_name = format!("{}{}{}", stem_final, suffix, ext_part);
        candidate = dir.join(&new_name);
        if !candidate.exists() {
            return candidate;
        }
        idx += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_safe_filename_should_be_short_and_windows_safe() {
        let url = "https://konachan.net/jpeg/22ddb4e9b6207ba3402e4642a95be066/Konachan.com%20-%20397362%200dd%202girls%20aqua_eyes%20arknights%20bell%20blush%20bow%20christmas%20dress%20hat%20headband%20horns%20long_hair%20moon%20pantyhose%20santa_hat%20scarf%20shorts%20snow%20tree%20white_hair.jpg";
        let url_path = "Konachan.com%20-%20397362%200dd%202girls%20aqua_eyes%20arknights%20bell%20blush%20bow%20christmas%20dress%20hat%20headband%20horns%20long_hair%20moon%20pantyhose%20santa_hat%20scarf%20shorts%20snow%20tree%20white_hair.jpg";

        let filename = build_safe_filename(url_path, "jpg", url);
        assert!(
            filename.len() <= MAX_SAFE_FILENAME_LEN,
            "filename too long: {}",
            filename.len()
        );
        assert!(filename.ends_with(".jpg"));
        assert!(!filename.ends_with(' '));
        assert!(!filename.ends_with('.'));
        for c in ['<', '>', ':', '"', '/', '\\', '|', '?', '*'] {
            assert!(
                !filename.contains(c),
                "filename contains invalid char {}: {}",
                c,
                filename
            );
        }
    }

    #[test]
    fn unique_path_should_append_suffix_and_keep_length() {
        let dir = std::env::temp_dir().join(format!("kabegame-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();

        let filename = build_safe_filename("a-very-long-name.jpg", "jpg", "hash-source");
        let p1 = dir.join(&filename);
        fs::write(&p1, b"test").unwrap();

        let p2 = unique_path(&dir, &filename);
        assert_ne!(p1, p2);
        let name2 = p2.file_name().and_then(|s| s.to_str()).unwrap_or("");
        assert!(name2.len() <= MAX_SAFE_FILENAME_LEN);

        let _ = fs::remove_dir_all(&dir);
    }
}

fn download_image(
    url: &str,
    base_dir: &Path,
    plugin_id: &str,
    task_id: &str,
    download_start_time: u64,
    app: &AppHandle,
    http_headers: &HashMap<String, String>,
) -> Result<DownloadedImage, String> {
    // 统一拒绝协议：上层可用 `reject:<reason>` 来显式拒绝某个下载/导入项
    const REJECT_PREFIX: &str = "reject:";
    if let Some(reason) = url.trim().strip_prefix(REJECT_PREFIX) {
        return Err(reason.trim().to_string());
    }

    // 检查是否是本地文件路径
    let is_local_path = url.starts_with("file://")
        || (!url.starts_with("http://") && !url.starts_with("https://") && Path::new(url).exists());

    // 计算默认/用户目录，用于确定最终输出位置
    let default_images_dir = get_default_images_dir();
    let is_default_dir = base_dir
        .canonicalize()
        .ok()
        .and_then(|base| {
            default_images_dir
                .canonicalize()
                .ok()
                .map(|def| base == def)
        })
        .unwrap_or(false);

    let target_dir = if is_default_dir {
        let plugin_dir = base_dir.join(plugin_id);
        fs::create_dir_all(&plugin_dir)
            .map_err(|e| format!("Failed to create plugin directory: {}", e))?;
        plugin_dir
    } else {
        fs::create_dir_all(base_dir)
            .map_err(|e| format!("Failed to create output directory: {}", e))?;
        base_dir.to_path_buf()
    };

    if is_local_path {
        // 处理本地文件路径
        let source_path = if url.starts_with("file://") {
            let path_str = if url.starts_with("file:///") {
                &url[8..]
            } else {
                &url[7..]
            };
            #[cfg(windows)]
            let path_str = if path_str.len() > 1 && &path_str[1..2] == ":" {
                path_str.replace("/", "\\")
            } else {
                path_str.replace("/", "\\")
            };
            #[cfg(not(windows))]
            let path_str = path_str;
            PathBuf::from(path_str)
        } else {
            PathBuf::from(url)
        };

        let source_path = source_path
            .canonicalize()
            .map_err(|e| format!("Failed to canonicalize source path: {}", e))?;

        if !source_path.exists() {
            return Err(format!(
                "Source file does not exist: {}",
                source_path.display()
            ));
        }

        // 防无限循环：当虚拟盘开启且导入路径来自虚拟盘挂载点时拒绝导入
        // - 不依赖 app-main 的虚拟盘服务，只读取 core 的 Settings（跨平台）
        #[cfg(feature = "virtual-drive")]
        {
            fn normalize_mount_point(input: &str) -> String {
                let s = input.trim();
                if s.is_empty() {
                    return String::new();
                }
                #[cfg(target_os = "windows")]
                {
                    // 兼容：K / K: / K:\ 都归一为 K:\
                    let upper = s.to_uppercase();
                    if upper.len() == 1 && upper.chars().next().unwrap().is_ascii_alphabetic() {
                        return format!("{}:\\", upper);
                    }
                    if upper.len() == 2
                        && upper.chars().next().unwrap().is_ascii_alphabetic()
                        && upper.chars().nth(1) == Some(':')
                    {
                        return format!("{}\\", upper);
                    }
                    return upper;
                }
                #[cfg(not(target_os = "windows"))]
                {
                    s.to_string()
                }
            }

            #[cfg(target_os = "windows")]
            fn drive_letter(p: &std::path::Path) -> Option<char> {
                use std::path::Component;
                match p.components().next() {
                    Some(Component::Prefix(prefix)) => match prefix.kind() {
                        std::path::Prefix::Disk(d) | std::path::Prefix::VerbatimDisk(d) => {
                            Some((d as char).to_ascii_uppercase())
                        }
                        _ => None,
                    },
                    _ => None,
                }
            }

            #[cfg(target_os = "windows")]
            fn is_under_mount_point(source: &std::path::Path, mount_point: &str) -> bool {
                let mp = normalize_mount_point(mount_point);
                if mp.is_empty() {
                    return false;
                }
                // 若 mount_point 是盘符挂载：同盘符一律视为虚拟盘来源
                let mp_path = std::path::Path::new(&mp);
                if let Some(mp_drive) = drive_letter(mp_path) {
                    return drive_letter(source) == Some(mp_drive);
                }
                // 目录挂载：按路径组件匹配
                let Ok(mp_canon) = mp_path.canonicalize() else {
                    return false;
                };
                source.starts_with(&mp_canon)
            }

            #[cfg(not(target_os = "windows"))]
            fn is_under_mount_point(source: &std::path::Path, mount_point: &str) -> bool {
                let mp = normalize_mount_point(mount_point);
                if mp.is_empty() {
                    return false;
                }
                let mp_path = std::path::Path::new(&mp);
                let Ok(mp_canon) = mp_path.canonicalize() else {
                    return false;
                };
                source.starts_with(&mp_canon)
            }

            if let Some(settings) = app
                .try_state::<crate::settings::Settings>()
                .and_then(|s| s.get_settings().ok())
            {
                if settings.album_drive_enabled {
                    let mp = normalize_mount_point(&settings.album_drive_mount_point);
                    if !mp.is_empty() && std::path::Path::new(&mp).exists() {
                        if is_under_mount_point(&source_path, &mp) {
                            return Err(format!(
                                "禁止从虚拟盘导入（会导致无限循环）。路径：{}（挂载点：{}）",
                                source_path.display(),
                                mp
                            ));
                        }
                    }
                }
            }
        }

        // 计算源文件哈希
        let source_hash = compute_file_hash(&source_path)?;

        // 去重开关
        let auto_deduplicate = app
            .try_state::<crate::settings::Settings>()
            .and_then(|s| s.get_settings().ok())
            .map(|s| s.auto_deduplicate)
            .unwrap_or(false);

        // 若启用自动去重：本地文件也仅按哈希判断是否复用（不看 URL/路径）
        if auto_deduplicate {
            let storage = app.state::<crate::storage::Storage>();
            if let Ok(Some(existing)) = storage.find_image_by_hash(&source_hash) {
                let existing_path = PathBuf::from(&existing.local_path);
                if existing_path.exists() {
                    // 复用允许“补齐缩略图”：如果 DB 缩略图缺失或文件不存在，则生成并写回 DB
                    let mut need_backfill = existing.thumbnail_path.trim().is_empty();
                    let thumb_path = if !need_backfill {
                        let p = PathBuf::from(&existing.thumbnail_path);
                        if p.exists() {
                            Some(p)
                        } else {
                            need_backfill = true;
                            None
                        }
                    } else {
                        None
                    };
                    if need_backfill {
                        if let Ok(Some(gen)) = generate_thumbnail(&existing_path, app) {
                            let canonical_thumb = gen
                                .canonicalize()
                                .unwrap_or(gen)
                                .to_string_lossy()
                                .to_string()
                                .trim_start_matches("\\\\?\\")
                                .to_string();
                            let _ =
                                storage.update_image_thumbnail_path(&existing.id, &canonical_thumb);
                        }
                    } else if let Some(p) = thumb_path {
                        // 兼容：DB 里存的可能是相对/非规范路径，这里不强制写回
                        let _ = p;
                    }

                    // 复用：按需求“什么都不做”（不复制、不入库、不加画册、不关联任务）
                    ensure_minimum_duration(download_start_time, 500);
                    return Ok(DownloadedImage {
                        path: source_path.clone(),
                        thumbnail: None,
                        hash: source_hash,
                        reused: true,
                        owns_file: false,
                    });
                }
            }
        }

        // 如果源文件已位于目标目录内（含子目录），则不再执行复制，直接使用原文件
        if let Ok(target_dir_canonical) = target_dir.canonicalize() {
            if source_path.starts_with(&target_dir_canonical) {
                let thumbnail_path = generate_thumbnail(&source_path, app)?;
                // 确保下载过程至少持续指定时间（即使文件已经存在）
                ensure_minimum_duration(download_start_time, 500);
                return Ok(DownloadedImage {
                    path: source_path.clone(),
                    thumbnail: thumbnail_path,
                    hash: source_hash,
                    reused: false, // 需要入库 -> 才会关联任务/加入画册
                    owns_file: false,
                });
            }
        }

        let extension = source_path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("jpg");
        let original_name = source_path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("image");
        let filename = build_safe_filename(
            original_name,
            extension,
            &source_path.to_string_lossy().to_string(),
        );
        let target_path = unique_path(&target_dir, &filename);

        // 复制文件
        fs::copy(&source_path, &target_path).map_err(|e| format!("Failed to copy file: {}", e))?;

        // 删除 Windows Zone.Identifier 流（避免打开文件时出现安全警告）
        #[cfg(windows)]
        remove_zone_identifier(&target_path);

        // 生成缩略图
        let thumbnail_path = generate_thumbnail(&target_path, app)?;

        // 确保下载过程至少持续指定时间
        ensure_minimum_duration(download_start_time, 500);

        Ok(DownloadedImage {
            path: target_path,
            thumbnail: thumbnail_path,
            hash: source_hash,
            reused: false,
            owns_file: true,
        })
    } else {
        // 处理 HTTP/HTTPS URL
        // 在单独线程中执行下载，以便发送进度事件
        let url_clone = url.to_string();
        let target_dir_clone = target_dir.clone();
        let plugin_id_clone = plugin_id.to_string();
        let task_id_clone = task_id.to_string();
        let app_clone = app.clone();
        let http_headers_clone = http_headers.clone();
        let retry_count = app
            .try_state::<crate::settings::Settings>()
            .and_then(|s| s.get_settings().ok())
            .map(|s| s.network_retry_count)
            .unwrap_or(0);

        // 从 URL 获取文件名（用于落盘；实际写入先写到 temp，再 rename）
        let parsed_url = Url::parse(url).map_err(|e| format!("Invalid image URL: {}", e))?;
        let url_path = parsed_url
            .path_segments()
            .and_then(|segments| segments.last())
            .unwrap_or("image");

        let extension = Path::new(url_path)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("jpg");

        let filename = build_safe_filename(url_path, extension, &url_clone);
        let file_path = unique_path(&target_dir, &filename);

        // 注意：download_image 由 download worker 线程调用，因此这里不再额外 spawn 一层线程。
        // 这样可以确保“并发下载数 x”真正对应 x 个 worker 的并发度。
        let (content_hash, final_or_temp_path) = (|| -> Result<(String, PathBuf), String> {
            let client = create_blocking_client()?;
            let header_map =
                build_reqwest_header_map(&app_clone, &task_id_clone, &http_headers_clone);

            // 失败重试：每次 attempt 都重新下载并写入新的临时文件（避免脏数据）
            let max_attempts = retry_count.saturating_add(1).max(1);
            let mut attempt: u32 = 0;

            loop {
                attempt += 1;

                // 若任务已被取消，尽早退出
                let dq = app_clone.state::<DownloadQueue>();
                if dq.is_task_canceled(&task_id_clone) {
                    return Err("Task canceled".to_string());
                }

                let mut req = client.get(&url_clone);
                if !header_map.is_empty() {
                    req = req.headers(header_map.clone());
                }
                let response = match req.send() {
                    Ok(r) => r,
                    Err(e) => {
                        if attempt < max_attempts {
                            let backoff_ms = (500u64)
                                .saturating_mul(2u64.saturating_pow((attempt - 1) as u32))
                                .min(5000);
                            std::thread::sleep(std::time::Duration::from_millis(backoff_ms));
                            continue;
                        }
                        return Err(format!("Failed to download image: {}", e));
                    }
                };

                let status = response.status();
                if !status.is_success() {
                    let retryable = status.as_u16() == 408
                        || status.as_u16() == 429
                        || status.is_server_error();
                    if retryable && attempt < max_attempts {
                        let backoff_ms = (500u64)
                            .saturating_mul(2u64.saturating_pow((attempt - 1) as u32))
                            .min(5000);
                        std::thread::sleep(std::time::Duration::from_millis(backoff_ms));
                        continue;
                    }
                    return Err(format!("HTTP error: {}", status));
                }

                let total_bytes = response.content_length();
                let mut received_bytes: u64 = 0;

                // 临时文件：避免中途失败留下半成品；成功后再 rename 到最终路径
                // 临时文件名必须“短且稳定格式”，避免 Windows 因路径/文件名过长报错 123
                let temp_name = format!("__kg_tmp_{}.part", uuid::Uuid::new_v4());
                let temp_path = target_dir_clone.join(temp_name);

                let mut file = match std::fs::File::create(&temp_path) {
                    Ok(f) => f,
                    Err(e) => return Err(format!("Failed to create file: {}", e)),
                };

                // 记录临时文件到数据库
                if let Some(storage) = app_clone.try_state::<crate::storage::Storage>() {
                    let temp_path_str = temp_path.to_string_lossy().to_string();
                    let _ = storage.add_temp_file(&temp_path_str);
                }

                // 边下载边算 hash（用于去重）
                let mut hasher = Sha256::new();

                // 进度事件节流：至少 256KB 或 200ms 才发一次
                let mut last_emit_bytes: u64 = 0;
                let mut last_emit_at = std::time::Instant::now();
                let emit_interval = std::time::Duration::from_millis(200);
                let emit_bytes_step: u64 = 256 * 1024;

                // 首次立即发一个（用于 UI 及时出现 "0B / ?"）
                let _ = app_clone.emit(
                    "download-progress",
                    serde_json::json!({
                        "taskId": task_id_clone,
                        "url": url_clone,
                        "startTime": download_start_time,
                        "pluginId": plugin_id_clone,
                        "receivedBytes": received_bytes,
                        "totalBytes": total_bytes,
                    }),
                );

                // 首次下载时发送下载状态
                emit_download_state(
                    &app_clone,
                    &task_id_clone,
                    &url_clone,
                    download_start_time,
                    &plugin_id_clone,
                    "downloading",
                    None,
                );

                let mut stream_error: Option<String> = None;

                // 使用阻塞方式读取响应（分块读取以支持进度更新）
                let mut reader = response;
                loop {
                    // 若任务已被取消，中止并清理临时文件
                    let dq = app_clone.state::<DownloadQueue>();
                    if dq.is_task_canceled(&task_id_clone) {
                        // 从数据库中删除临时文件记录
                        if let Some(storage) = app_clone.try_state::<crate::storage::Storage>() {
                            let temp_path_str = temp_path.to_string_lossy().to_string();
                            let _ = storage.remove_temp_file(&temp_path_str);
                        }
                        let _ = std::fs::remove_file(&temp_path);
                        return Err("Task canceled".to_string());
                    }

                    let mut buffer = vec![0u8; 8192];
                    match std::io::Read::read(&mut reader, &mut buffer) {
                        Ok(0) => break, // EOF
                        Ok(n) => {
                            let chunk = &buffer[..n];
                            hasher.update(chunk);
                            if let Err(e) = std::io::Write::write_all(&mut file, chunk) {
                                stream_error = Some(format!("Failed to write file: {}", e));
                                break;
                            }

                            received_bytes = received_bytes.saturating_add(n as u64);

                            let should_emit = received_bytes.saturating_sub(last_emit_bytes)
                                >= emit_bytes_step
                                || last_emit_at.elapsed() >= emit_interval;
                            if should_emit {
                                last_emit_bytes = received_bytes;
                                last_emit_at = std::time::Instant::now();
                                let _ = app_clone.emit(
                                    "download-progress",
                                    serde_json::json!({
                                        "taskId": task_id_clone,
                                        "url": url_clone,
                                        "startTime": download_start_time,
                                        "pluginId": plugin_id_clone,
                                        "receivedBytes": received_bytes,
                                        "totalBytes": total_bytes,
                                    }),
                                );
                            }
                        }
                        Err(e) => {
                            stream_error = Some(format!("Failed to read stream: {}", e));
                            break;
                        }
                    }
                }

                // 关闭文件句柄（确保 Windows 下 rename 不被占用）
                drop(file);

                if let Some(err) = stream_error {
                    // 从数据库中删除临时文件记录
                    if let Some(storage) = app_clone.try_state::<crate::storage::Storage>() {
                        let temp_path_str = temp_path.to_string_lossy().to_string();
                        let _ = storage.remove_temp_file(&temp_path_str);
                    }
                    let _ = std::fs::remove_file(&temp_path);
                    if attempt < max_attempts {
                        let backoff_ms = (500u64)
                            .saturating_mul(2u64.saturating_pow((attempt - 1) as u32))
                            .min(5000);
                        std::thread::sleep(std::time::Duration::from_millis(backoff_ms));
                        continue;
                    }
                    return Err(err);
                }

                // 最终再发一次（接近 100%）
                let _ = app_clone.emit(
                    "download-progress",
                    serde_json::json!({
                        "taskId": task_id_clone,
                        "url": url_clone,
                        "startTime": download_start_time,
                        "pluginId": plugin_id_clone,
                        "receivedBytes": received_bytes,
                        "totalBytes": total_bytes,
                    }),
                );

                let content_hash = format!("{:x}", hasher.finalize());
                return Ok((content_hash, temp_path));
            }
        })()?;

        // 若已有相同哈希且文件存在，复用（仅在启用自动去重时检查）
        let storage = app.state::<crate::storage::Storage>();
        let should_check_hash_dedupe = app
            .try_state::<crate::settings::Settings>()
            .and_then(|s| s.get_settings().ok())
            .map(|s| s.auto_deduplicate)
            .unwrap_or(false);

        if should_check_hash_dedupe {
            if let Ok(Some(existing)) = storage.find_image_by_hash(&content_hash) {
                let existing_path = PathBuf::from(&existing.local_path);
                if existing_path.exists() {
                    // 从数据库中删除临时文件记录
                    let temp_path_str = final_or_temp_path.to_string_lossy().to_string();
                    let _ = storage.remove_temp_file(&temp_path_str);
                    // 删除刚下载的临时文件
                    let _ = std::fs::remove_file(&final_or_temp_path);
                    // thumbnail_path 在 DB/结构上已是必填；这里仍做兜底以兼容极端旧数据
                    let mut thumb_path = if existing.thumbnail_path.trim().is_empty() {
                        existing_path.clone()
                    } else {
                        PathBuf::from(&existing.thumbnail_path)
                    };

                    if !thumb_path.exists() {
                        // 缩略图文件缺失：尝试补生成；失败则兜底为原图
                        if let Ok(Some(gen)) = generate_thumbnail(&existing_path, app) {
                            thumb_path = gen;
                            // 复用允许“补齐缩略图”：写回 DB
                            let canonical_thumb = thumb_path
                                .canonicalize()
                                .unwrap_or(thumb_path.clone())
                                .to_string_lossy()
                                .to_string()
                                .trim_start_matches("\\\\?\\")
                                .to_string();
                            let _ =
                                storage.update_image_thumbnail_path(&existing.id, &canonical_thumb);
                        } else {
                            thumb_path = existing_path.clone();
                        }
                    }

                    let canonical_existing = existing_path
                        .canonicalize()
                        .unwrap_or(existing_path)
                        .to_string_lossy()
                        .to_string()
                        .trim_start_matches("\\\\?\\")
                        .to_string();
                    let canonical_thumb = thumb_path
                        .canonicalize()
                        .unwrap_or(thumb_path)
                        .to_string_lossy()
                        .to_string()
                        .trim_start_matches("\\\\?\\")
                        .to_string();

                    // 确保下载过程至少持续指定时间（即使复用了已有文件）
                    ensure_minimum_duration(download_start_time, 500);

                    return Ok(DownloadedImage {
                        path: PathBuf::from(canonical_existing),
                        thumbnail: Some(PathBuf::from(canonical_thumb)),
                        hash: if existing.hash.is_empty() {
                            content_hash.clone()
                        } else {
                            existing.hash
                        },
                        reused: true,
                        owns_file: false,
                    });
                }
            }
        }

        // 未命中复用：将临时文件移动到最终路径
        std::fs::rename(&final_or_temp_path, &file_path)
            .map_err(|e| format!("Failed to finalize file: {}", e))?;
        // 从数据库中删除临时文件记录（文件已成功移动到最终路径）
        let temp_path_str = final_or_temp_path.to_string_lossy().to_string();
        let _ = storage.remove_temp_file(&temp_path_str);

        // 删除 Windows Zone.Identifier 流（避免打开文件时出现安全警告）
        #[cfg(windows)]
        remove_zone_identifier(&file_path);

        // 生成缩略图
        let thumbnail_path = generate_thumbnail(&file_path, app)?;

        // 确保下载过程至少持续指定时间
        ensure_minimum_duration(download_start_time, 500);

        Ok(DownloadedImage {
            path: file_path,
            thumbnail: thumbnail_path,
            hash: content_hash,
            reused: false,
            owns_file: true,
        })
    }
}

/// 删除 Windows Zone.Identifier 备用数据流
/// 这可以避免从网络下载的文件在打开时出现安全警告
#[cfg(windows)]
fn remove_zone_identifier(file_path: &Path) {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::DeleteFileW;

    // 构建 Zone.Identifier 流的路径：文件路径 + ":Zone.Identifier"
    let mut stream_path = file_path.as_os_str().to_owned();
    stream_path.push(":Zone.Identifier");

    // 转换为 Windows 宽字符串
    let wide_path: Vec<u16> = OsStr::new(&stream_path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    // 删除备用数据流（忽略错误，因为流可能不存在）
    unsafe {
        DeleteFileW(wide_path.as_ptr());
    }
}

#[cfg(not(windows))]
fn remove_zone_identifier(_file_path: &Path) {
    // 非 Windows 系统不需要处理
}

pub fn generate_thumbnail(image_path: &Path, _app: &AppHandle) -> Result<Option<PathBuf>, String> {
    let app_data_dir = crate::app_paths::kabegame_data_dir();
    let thumbnails_dir = app_data_dir.join("thumbnails");
    fs::create_dir_all(&thumbnails_dir)
        .map_err(|e| format!("Failed to create thumbnails directory: {}", e))?;

    // 尝试打开图片
    let img = match image::open(image_path) {
        Ok(img) => img,
        Err(_) => return Ok(None), // 如果无法打开，跳过缩略图生成
    };

    // 生成缩略图（最大 300x300，提升清晰度）
    let thumbnail = img.thumbnail(300, 300);

    // 保存缩略图
    let thumbnail_filename = format!("{}.jpg", uuid::Uuid::new_v4());
    let thumbnail_path = thumbnails_dir.join(&thumbnail_filename);

    thumbnail
        .save(&thumbnail_path)
        .map_err(|e| format!("Failed to save thumbnail: {}", e))?;

    Ok(Some(thumbnail_path))
}

// 下载任务（已移除，不再使用队列）

// 正在下载的任务信息（用于前端显示）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActiveDownloadInfo {
    pub url: String,
    #[serde(rename = "plugin_id")]
    pub plugin_id: String,
    #[serde(rename = "start_time")]
    pub start_time: u64,
    #[serde(rename = "task_id")]
    pub task_id: String,
    /// 下载状态机状态（用于前端展示）
    /// - preparing: 准备中（等待开始下载）
    /// - downloading: 下载中（正在下载文件）
    /// - processing: 处理中（下载完成后的处理，包括去重、入库、通知等）
    #[serde(default)]
    pub state: String,
}

fn emit_download_state(
    app: &AppHandle,
    task_id: &str,
    url: &str,
    start_time: u64,
    plugin_id: &str,
    state: &str,
    error: Option<&str>,
) {
    let mut payload = serde_json::json!({
        "taskId": task_id,
        "url": url,
        "startTime": start_time,
        "pluginId": plugin_id,
        "state": state,
    });
    if let Some(e) = error {
        payload["error"] = serde_json::Value::String(e.to_string());
    }
    let _ = app.emit("download-state", payload);
}

#[derive(Debug, Clone)]
struct DownloadRequest {
    url: String,
    images_dir: PathBuf,
    plugin_id: String,
    task_id: String,
    download_start_time: u64,
    output_album_id: Option<String>,
    http_headers: HashMap<String, String>,
    archive_type: Option<ArchiveType>,
    /// zip 解压临时目录生命周期守卫：
    /// - 普通下载为 None
    /// - zip 内文件下载为 Some(Arc<TempDirGuard>)，确保文件被 worker 处理完前临时目录不会被清理
    temp_dir_guard: Option<Arc<TempDirGuard>>,
}

#[derive(Debug)]
struct DownloadPoolState {
    in_flight: u32,
    queue: VecDeque<DownloadRequest>,
}

#[derive(Debug)]
struct DownloadPool {
    desired_workers: AtomicU32,
    total_workers: AtomicU32,
    state: Mutex<DownloadPoolState>,
    cv: Condvar,
}

#[allow(dead_code)]
impl DownloadPool {
    fn new(initial_workers: u32) -> Self {
        let n = initial_workers.max(1);
        Self {
            desired_workers: AtomicU32::new(n),
            total_workers: AtomicU32::new(n),
            state: Mutex::new(DownloadPoolState {
                in_flight: 0,
                queue: VecDeque::new(),
            }),
            cv: Condvar::new(),
        }
    }

    #[allow(dead_code)]
    fn set_desired(&self, desired: u32) -> u32 {
        let n = desired.max(1);
        self.desired_workers.store(n, Ordering::Relaxed);
        self.cv.notify_all();
        n
    }
}

// 下载调度器：固定/可伸缩 download worker（并发=设置 max_concurrent_downloads）
#[derive(Clone)]
pub struct DownloadQueue {
    app: AppHandle,
    pool: Arc<DownloadPool>,
    active_tasks: Arc<Mutex<Vec<ActiveDownloadInfo>>>,
    canceled_tasks: Arc<Mutex<HashSet<String>>>,
}

impl DownloadQueue {
    pub fn new(app: AppHandle) -> Self {
        let initial = match app.try_state::<crate::settings::Settings>() {
            Some(settings) => settings
                .get_settings()
                .ok()
                .map(|s| s.max_concurrent_downloads)
                .unwrap_or(3),
            None => 3,
        };
        let pool = Arc::new(DownloadPool::new(initial));
        Self {
            app: app.clone(),
            pool: Arc::clone(&pool),
            active_tasks: Arc::new(Mutex::new(Vec::new())),
            canceled_tasks: Arc::new(Mutex::new(HashSet::new())),
        }
        .start_download_workers(pool.total_workers.load(Ordering::Relaxed))
    }

    fn start_download_workers(self, count: u32) -> Self {
        for _ in 0..count {
            let app = self.app.clone();
            let pool = Arc::clone(&self.pool);
            let active_tasks = Arc::clone(&self.active_tasks);
            std::thread::spawn(move || download_worker_loop(app, pool, active_tasks));
        }
        self
    }

    /// 调整 download worker 数量（全局并发下载数）
    ///
    /// - 增大：创建新线程并立刻生效
    /// - 减小：空闲 worker 会尽快退出；忙碌 worker 会在本次下载完成后自我终止（不回收 slot）
    pub fn set_desired_concurrency(&self, desired: u32) {
        let desired = self.pool.set_desired(desired);
        // 若需要扩容：补齐线程数
        loop {
            let total = self.pool.total_workers.load(Ordering::Relaxed);
            if total >= desired {
                break;
            }
            let add = desired - total;
            self.pool.total_workers.fetch_add(add, Ordering::Relaxed);
            for _ in 0..add {
                let app = self.app.clone();
                let pool = Arc::clone(&self.pool);
                let active_tasks = Arc::clone(&self.active_tasks);
                std::thread::spawn(move || download_worker_loop(app, pool, active_tasks));
            }
            break;
        }
        self.pool.cv.notify_all();
    }

    /// 唤醒所有等待中的 download_image（用于并发设置变更/取消任务）
    pub fn notify_all_waiting(&self) {
        self.pool.cv.notify_all();
    }

    // 获取正在下载的任务列表
    pub fn get_active_downloads(&self) -> Result<Vec<ActiveDownloadInfo>, String> {
        let tasks = self
            .active_tasks
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;
        Ok(tasks.clone())
    }

    // 将下载任务加入窗口（如果窗口满则阻塞等待）
    pub fn download_image(
        &self,
        url: String,
        images_dir: PathBuf,
        plugin_id: String,
        task_id: String,
        download_start_time: u64,
        output_album_id: Option<String>,
        http_headers: HashMap<String, String>,
    ) -> Result<(), String> {
        self.download_image_with_temp_guard(
            url,
            images_dir,
            plugin_id,
            task_id,
            download_start_time,
            output_album_id,
            http_headers,
            None,
            None,
        )
    }

    pub fn download_archive(
        &self,
        url: String,
        archive_type: &str,
        images_dir: PathBuf,
        plugin_id: String,
        task_id: String,
        download_start_time: u64,
        output_album_id: Option<String>,
        http_headers: HashMap<String, String>,
    ) -> Result<(), String> {
        let Some(t) = ArchiveType::parse(archive_type) else {
            return Err(format!("Unsupported archive type: {archive_type}"));
        };
        self.download_image_with_temp_guard(
            url,
            images_dir,
            plugin_id,
            task_id,
            download_start_time,
            output_album_id,
            http_headers,
            Some(t),
            None,
        )
    }

    fn download_image_with_temp_guard(
        &self,
        mut url: String,
        images_dir: PathBuf,
        plugin_id: String,
        task_id: String,
        download_start_time: u64,
        output_album_id: Option<String>,
        http_headers: HashMap<String, String>,
        archive_type: Option<ArchiveType>,
        temp_dir_guard: Option<Arc<TempDirGuard>>,
    ) -> Result<(), String> {
        const REJECT_PREFIX: &str = "reject:";
        let trimmed = url.trim();
        if let Some(reason) = trimmed.strip_prefix(REJECT_PREFIX) {
            return Err(reason.trim().to_string());
        }
        // 统一去掉首尾空白，避免后续 starts_with/exists 判断出现诡异行为
        if trimmed.len() != url.len() {
            url = trimmed.to_string();
        }

        if self.is_task_canceled(&task_id) {
            return Err("Task canceled".to_string());
        }

        // 在启动下载前，先检查 URL 是否已存在（如果启用了自动去重）
        // 这样可以避免占用下载窗口和活跃下载数
        let should_skip_by_url = {
            // archive job 不参与 URL 去重（zip 不是图片，且 archive 的语义不同）
            if archive_type.is_some() {
                false
            } else {
                let settings_state = self.app.try_state::<crate::settings::Settings>();
                if let Some(settings) = settings_state {
                    if let Ok(s) = settings.get_settings() {
                        // 需求：URL 去重仅对网络 URL 生效（http/https）；本地导入不做 URL 去重
                        let is_http_url = url.starts_with("http://") || url.starts_with("https://");
                        if s.auto_deduplicate && is_http_url {
                            let storage = self.app.state::<crate::storage::Storage>();
                            if let Ok(Some(_existing)) = storage.find_image_by_url(&url) {
                                true // URL 已存在，跳过下载
                            } else {
                                false
                            }
                        } else {
                            false
                        }
                    } else {
                        false
                    }
                } else {
                    false
                }
            }
        };

        // 如果 URL 已存在（仅网络 URL 才会走到这里），按需求“复用=不入库/不加画册/不关联任务/不发 image-added”
        // 但允许“补齐缩略图”：若 DB 中缩略图缺失或文件不存在，则生成并写回 DB。
        if should_skip_by_url {
            let app_clone = self.app.clone();
            let url_clone = url.clone();
            let task_id_clone = task_id.clone();
            let plugin_id_clone = plugin_id.clone();

            std::thread::spawn(move || {
                emit_download_state(
                    &app_clone,
                    &task_id_clone,
                    &url_clone,
                    download_start_time,
                    &plugin_id_clone,
                    "processing",
                    None,
                );

                let storage = app_clone.state::<crate::storage::Storage>();
                if let Ok(Some(existing)) = storage.find_image_by_url(&url_clone) {
                    let existing_path = PathBuf::from(&existing.local_path);
                    if existing_path.exists() {
                        let mut need_backfill = existing.thumbnail_path.trim().is_empty();
                        if !need_backfill {
                            let p = PathBuf::from(&existing.thumbnail_path);
                            if !p.exists() {
                                need_backfill = true;
                            }
                        }
                        if need_backfill {
                            if let Ok(Some(gen)) = generate_thumbnail(&existing_path, &app_clone) {
                                let canonical_thumb = gen
                                    .canonicalize()
                                    .unwrap_or(gen)
                                    .to_string_lossy()
                                    .to_string()
                                    .trim_start_matches("\\\\?\\")
                                    .to_string();
                                let _ = storage
                                    .update_image_thumbnail_path(&existing.id, &canonical_thumb);
                            }
                        }
                    }
                }

                ensure_minimum_duration(download_start_time, 500);

                emit_download_state(
                    &app_clone,
                    &task_id_clone,
                    &url_clone,
                    download_start_time,
                    &plugin_id_clone,
                    "completed",
                    None,
                );
            });

            return Ok(());
        }

        // 关键语义：仅当没有可用 download worker 时才阻塞
        {
            let mut st = self
                .pool
                .state
                .lock()
                .map_err(|e| format!("Lock error: {}", e))?;
            while {
                let desired = self.pool.desired_workers.load(Ordering::Relaxed);
                st.in_flight >= desired
            } {
                if self.is_task_canceled(&task_id) {
                    return Err("Task canceled".to_string());
                }
                st = self
                    .pool
                    .cv
                    .wait(st)
                    .map_err(|e| format!("Lock error: {}", e))?;
            }
            st.in_flight = st.in_flight.saturating_add(1);
        }

        if self.is_task_canceled(&task_id) {
            // 释放 slot（因为已经拿到了 worker）
            if let Ok(mut st) = self.pool.state.lock() {
                st.in_flight = st.in_flight.saturating_sub(1);
                self.pool.cv.notify_one();
            }
            return Err("Task canceled".to_string());
        }

        // 添加到活跃任务列表
        let download_info = ActiveDownloadInfo {
            url: url.clone(),
            plugin_id: plugin_id.clone(),
            start_time: download_start_time,
            task_id: task_id.clone(),
            state: "preparing".to_string(),
        };
        {
            let mut tasks = self
                .active_tasks
                .lock()
                .map_err(|e| format!("Lock error: {}", e))?;
            tasks.push(download_info.clone());
        }

        emit_download_state(
            &self.app,
            &task_id,
            &url,
            download_start_time,
            &plugin_id,
            "preparing",
            None,
        );

        // 入队：由 download worker 异步执行；此处立刻返回
        {
            let mut st = self
                .pool
                .state
                .lock()
                .map_err(|e| format!("Lock error: {}", e))?;
            st.queue.push_back(DownloadRequest {
                url,
                images_dir,
                plugin_id,
                task_id,
                download_start_time,
                output_album_id,
                http_headers,
                archive_type,
                temp_dir_guard,
            });
            self.pool.cv.notify_one();
        }

        Ok(())
    }

    // 取消任务：标记为取消，正在下载的任务在保存阶段会被跳过
    pub fn cancel_task(&self, task_id: &str) -> Result<(), String> {
        // 标记为取消
        {
            let mut canceled = self
                .canceled_tasks
                .lock()
                .map_err(|e| format!("Lock error: {}", e))?;
            canceled.insert(task_id.to_string());
        }

        // 唤醒所有等待 download slot 的线程（让它们检查取消状态）
        self.notify_all_waiting();

        Ok(())
    }

    pub fn is_task_canceled(&self, task_id: &str) -> bool {
        match self.canceled_tasks.lock() {
            Ok(c) => c.contains(task_id),
            Err(e) => e.into_inner().contains(task_id),
        }
    }
}

fn download_worker_loop(
    app: AppHandle,
    pool: Arc<DownloadPool>,
    active_tasks: Arc<Mutex<Vec<ActiveDownloadInfo>>>,
) {
    loop {
        let job = {
            let mut st = match pool.state.lock() {
                Ok(g) => g,
                Err(e) => e.into_inner(),
            };

            while st.queue.is_empty() {
                // 缩容：空闲 worker 直接退出
                let desired = pool.desired_workers.load(Ordering::Relaxed);
                let total = pool.total_workers.load(Ordering::Relaxed);
                if total > desired {
                    pool.total_workers.fetch_sub(1, Ordering::Relaxed);
                    pool.cv.notify_all();
                    return;
                }

                st = match pool.cv.wait(st) {
                    Ok(g) => g,
                    Err(e) => e.into_inner(),
                };
            }

            st.queue.pop_front()
        };

        let Some(job) = job else { continue };

        // archive(zip) 导入：zip 可以是本地路径/file URL，也可以是 http(s) URL。
        // 同时兼容旧逻辑：未显式指定 archive_type，但 url 是本地 zip 时也走这里。
        let is_zip_archive_job = job.archive_type == Some(ArchiveType::Zip)
            || resolve_local_path_from_url(&job.url)
                .as_deref()
                .map(is_zip_path)
                .unwrap_or(false);
        if is_zip_archive_job {
            // 更新 active download 状态为 extracting（zip 导入整体视为一次 download job）
            {
                let mut tasks = match active_tasks.lock() {
                    Ok(g) => g,
                    Err(e) => e.into_inner(),
                };
                if let Some(t) = tasks
                    .iter_mut()
                    .find(|t| t.url == job.url && t.start_time == job.download_start_time)
                {
                    t.state = "extracting".to_string();
                }
            }

            let app_clone = app.clone();
            let url_clone = job.url.clone();
            let plugin_id_clone = job.plugin_id.clone();
            let task_id_clone = job.task_id.clone();
            let output_album_id_clone = job.output_album_id.clone();
            let http_headers_clone = job.http_headers.clone();
            let download_start_time = job.download_start_time;

            emit_download_state(
                &app_clone,
                &task_id_clone,
                &url_clone,
                download_start_time,
                &plugin_id_clone,
                "extracting",
                None,
            );

            let result: Result<(), String> = (|| {
                // 取消检查
                let dq = app_clone.state::<DownloadQueue>();
                if dq.is_task_canceled(&task_id_clone) {
                    return Err("Task canceled".to_string());
                }

                // 解压到临时目录（生命周期由后续入队的每个文件下载请求托管）
                let temp_dir = std::env::temp_dir()
                    .join(format!("kabegame_zip_{}", uuid::Uuid::new_v4().to_string()));
                fs::create_dir_all(&temp_dir)
                    .map_err(|e| format!("Failed to create temp dir: {}", e))?;
                let temp_guard = Arc::new(TempDirGuard {
                    path: temp_dir.clone(),
                });

                // 取 zip 源：
                // - 本地 zip：直接用路径
                // - 远程 zip：http(s) 下载到 temp_dir 后再解压
                let zip_path = if let Some(p) = resolve_local_path_from_url(&url_clone) {
                    p
                } else if url_clone.starts_with("http://") || url_clone.starts_with("https://") {
                    let archive_path = temp_dir.join("__kg_archive.zip");
                    let retry_count = app_clone
                        .try_state::<crate::settings::Settings>()
                        .and_then(|s| s.get_settings().ok())
                        .map(|s| s.network_retry_count)
                        .unwrap_or(0);
                    download_file_to_path_with_retry(
                        &app_clone,
                        &task_id_clone,
                        &url_clone,
                        &archive_path,
                        &http_headers_clone,
                        retry_count,
                    )?;
                    archive_path
                } else {
                    return Err(format!("Unsupported archive url: {}", url_clone));
                };

                if !is_zip_path(&zip_path) {
                    return Err(format!(
                        "Archive type mismatch, expected zip: {}",
                        zip_path.display()
                    ));
                }

                extract_zip_to_dir(&zip_path, &temp_dir)?;

                // 解压完成：zip 进入 processing（递归扫描 + 入队都算处理阶段）
                {
                    let mut tasks = match active_tasks.lock() {
                        Ok(g) => g,
                        Err(e) => e.into_inner(),
                    };
                    if let Some(t) = tasks
                        .iter_mut()
                        .find(|t| t.url == url_clone && t.start_time == download_start_time)
                    {
                        t.state = "processing".to_string();
                    }
                }
                emit_download_state(
                    &app_clone,
                    &task_id_clone,
                    &url_clone,
                    download_start_time,
                    &plugin_id_clone,
                    "processing",
                    None,
                );

                // 递归收集图片
                let mut images = Vec::<PathBuf>::new();
                collect_images_recursive(&temp_dir, &mut images)?;
                if images.is_empty() {
                    // 空包：立刻清理临时目录（best-effort）
                    let _ = fs::remove_dir_all(&temp_dir);
                    return Ok(());
                }

                // 逐个入队（不新建线程，复用当前 worker；入队过程会按并发限制阻塞等待）
                const MAX_TASK_IMAGES: usize = 10000;
                let dq = app_clone.state::<DownloadQueue>();
                let storage = app_clone.state::<crate::storage::Storage>();

                let base_count = storage
                    .get_task_image_ids(&task_id_clone)
                    .map(|v| v.len())
                    .unwrap_or(0);
                let mut queued_count: usize = 0;

                for img in images {
                    if dq.is_task_canceled(&task_id_clone) {
                        break;
                    }
                    if base_count.saturating_add(queued_count) >= MAX_TASK_IMAGES {
                        break;
                    }

                    let url_for_image = img.to_string_lossy().to_string();
                    let res = dq.download_image_with_temp_guard(
                        url_for_image,
                        job.images_dir.clone(),
                        plugin_id_clone.clone(),
                        task_id_clone.clone(),
                        0,
                        output_album_id_clone.clone(),
                        HashMap::new(),
                        None,
                        Some(Arc::clone(&temp_guard)),
                    );
                    if res.is_ok() {
                        queued_count = queued_count.saturating_add(1);
                    }
                }

                Ok(())
            })();

            match &result {
                Ok(_) => {
                    emit_download_state(
                        &app_clone,
                        &task_id_clone,
                        &url_clone,
                        download_start_time,
                        &plugin_id_clone,
                        "completed",
                        None,
                    );
                }
                Err(e) => {
                    if !e.contains("Task canceled") {
                        eprintln!("[下载失败] URL: {}, 错误: {}", url_clone, e);
                        // 记录失败图片（用于 TaskDetail 展示 + 手动重试）
                        let storage = app_clone.state::<crate::storage::Storage>();
                        let _ = storage.add_task_failed_image(
                            &task_id_clone,
                            &plugin_id_clone,
                            &url_clone,
                            download_start_time as i64,
                            Some(e.as_str()),
                        );
                    }
                    emit_download_state(
                        &app_clone,
                        &task_id_clone,
                        &url_clone,
                        download_start_time,
                        &plugin_id_clone,
                        if e.contains("Task canceled") {
                            "canceled"
                        } else {
                            "failed"
                        },
                        Some(e),
                    );
                }
            }

            // 最终：从活跃任务列表中移除
            {
                let mut tasks = match active_tasks.lock() {
                    Ok(g) => g,
                    Err(e) => e.into_inner(),
                };
                tasks.retain(|t| t.url != url_clone || t.start_time != download_start_time);
            }

            // 释放/退出 worker
            release_or_exit_worker(&pool);
            continue;
        }

        // 开始下载，更新状态为 downloading
        {
            let mut tasks = match active_tasks.lock() {
                Ok(g) => g,
                Err(e) => e.into_inner(),
            };
            if let Some(t) = tasks
                .iter_mut()
                .find(|t| t.url == job.url && t.start_time == job.download_start_time)
            {
                t.state = "downloading".to_string();
            }
        }

        let app_clone = app.clone();
        let url_clone = job.url.clone();
        let plugin_id_clone = job.plugin_id.clone();
        let task_id_clone = job.task_id.clone();
        let output_album_id_clone = job.output_album_id.clone();
        let download_start_time = job.download_start_time;

        // 执行下载（worker 线程内同步执行，避免额外 spawn）
        let result = download_image(
            &job.url,
            &job.images_dir,
            &job.plugin_id,
            &job.task_id,
            job.download_start_time,
            &app,
            &job.http_headers,
        );

        // 更新状态
        {
            let mut tasks = match active_tasks.lock() {
                Ok(g) => g,
                Err(e) => e.into_inner(),
            };
            if let Some(t) = tasks
                .iter_mut()
                .find(|t| t.url == job.url && t.start_time == job.download_start_time)
            {
                match &result {
                    Ok(_) => t.state = "processing".to_string(),
                    Err(e) => {
                        if e.contains("Task canceled") {
                            t.state = "canceled".to_string();
                        } else {
                            t.state = "failed".to_string();
                        }
                    }
                }
            }
        }

        match &result {
            Ok(_) => {
                emit_download_state(
                    &app_clone,
                    &task_id_clone,
                    &url_clone,
                    download_start_time,
                    &plugin_id_clone,
                    "processing",
                    None,
                );
            }
            Err(e) => {
                if !e.contains("Task canceled") {
                    eprintln!("[下载失败] URL: {}, 错误: {}", url_clone, e);
                    // 记录失败图片（用于 TaskDetail 展示 + 手动重试）
                    // 说明：允许重复记录，因此这里不做去重。
                    let storage = app_clone.state::<crate::storage::Storage>();
                    let _ = storage.add_task_failed_image(
                        &task_id_clone,
                        &plugin_id_clone,
                        &url_clone,
                        download_start_time as i64,
                        Some(e.as_str()),
                    );
                }
                emit_download_state(
                    &app_clone,
                    &task_id_clone,
                    &url_clone,
                    download_start_time,
                    &plugin_id_clone,
                    if e.contains("Task canceled") {
                        "canceled"
                    } else {
                        "failed"
                    },
                    Some(e),
                );
            }
        }

        // 如果下载成功，保存到 gallery（后处理阶段）
        if let Ok(downloaded) = &result {
            // 在保存到数据库前，再次检查任务是否已被取消
            let dq = app_clone.state::<DownloadQueue>();
            if dq.is_task_canceled(&task_id_clone) {
                // 任务已取消：跳过保存阶段。
                // 注意：取消任务时不应删除任何“最终文件”（无论是复制到输出目录的，还是已在输出目录内的源文件）。
                // 临时文件（.part-*）已在下载阶段/失败分支里清理。

                emit_download_state(
                    &app_clone,
                    &task_id_clone,
                    &url_clone,
                    download_start_time,
                    &plugin_id_clone,
                    "canceled",
                    None,
                );

                // 最终：从活跃任务列表中移除
                {
                    let mut tasks = match active_tasks.lock() {
                        Ok(g) => g,
                        Err(e) => e.into_inner(),
                    };
                    tasks.retain(|t| t.url != url_clone || t.start_time != download_start_time);
                }

                // 释放/退出 worker
                release_or_exit_worker(&pool);
                continue;
            }

            {
                let mut tasks = match active_tasks.lock() {
                    Ok(g) => g,
                    Err(e) => e.into_inner(),
                };
                if let Some(t) = tasks
                    .iter_mut()
                    .find(|t| t.url == url_clone && t.start_time == download_start_time)
                {
                    t.state = "processing".to_string();
                }
            }

            let storage = app_clone.state::<crate::storage::Storage>();
            // 规范化路径为绝对路径，并移除 Windows 长路径前缀
            let local_path_str = downloaded
                .path
                .canonicalize()
                .unwrap_or_else(|_| downloaded.path.clone())
                .to_string_lossy()
                .to_string()
                .trim_start_matches("\\\\?\\")
                .to_string();
            let thumbnail_path_str = downloaded
                .thumbnail
                .as_ref()
                .and_then(|p| p.canonicalize().ok())
                .map(|p| {
                    p.to_string_lossy()
                        .to_string()
                        .trim_start_matches("\\\\?\\")
                        .to_string()
                })
                .unwrap_or_else(|| local_path_str.clone());

            if !downloaded.reused {
                // 检查是否启用自动去重（URL 仅网络；哈希 网络+本地）
                let should_skip = {
                    let settings_state = app_clone.try_state::<crate::settings::Settings>();
                    if let Some(settings) = settings_state {
                        if let Ok(s) = settings.get_settings() {
                            if s.auto_deduplicate {
                                let is_http_url = url_clone.starts_with("http://")
                                    || url_clone.starts_with("https://");
                                if is_http_url {
                                    if let Ok(Some(_)) = storage.find_image_by_url(&url_clone) {
                                        true
                                    } else if !downloaded.hash.is_empty() {
                                        storage
                                            .find_image_by_hash(&downloaded.hash)
                                            .ok()
                                            .flatten()
                                            .is_some()
                                    } else {
                                        false
                                    }
                                } else if !downloaded.hash.is_empty() {
                                    storage
                                        .find_image_by_hash(&downloaded.hash)
                                        .ok()
                                        .flatten()
                                        .is_some()
                                } else {
                                    false
                                }
                            } else {
                                false
                            }
                        } else {
                            false
                        }
                    } else {
                        false
                    }
                };

                if should_skip {
                    // 竞态兜底：若被判定为复用，则不入库/不加画册/不关联任务/不发 image-added。
                    // 若本次产生了新落盘文件（owns_file=true），清理它，避免产生“明明复用但仍复制”的副作用。
                    if downloaded.owns_file {
                        let _ = std::fs::remove_file(&downloaded.path);
                        if let Some(thumb) = &downloaded.thumbnail {
                            let _ = std::fs::remove_file(thumb);
                        }
                    }
                } else {
                    let image_info = crate::storage::ImageInfo {
                        // 说明：images.id 已迁移为自增整数主键；这里不再生成 UUID
                        id: "".to_string(),
                        url: url_clone.clone(),
                        local_path: local_path_str.clone(),
                        plugin_id: plugin_id_clone.clone(),
                        task_id: Some(task_id_clone.clone()),
                        crawled_at: download_start_time,
                        metadata: None,
                        thumbnail_path: thumbnail_path_str.clone(),
                        favorite: false,
                        hash: downloaded.hash.clone(),
                        order: Some(download_start_time as i64),
                        local_exists: true, // 刚下载完成，文件肯定存在
                    };
                    match storage.add_image(image_info) {
                        Ok(inserted) => {
                            let image_id = inserted.id.clone();
                            let mut image_info_for_event = inserted.clone();

                            if let Some(ref album_id) = output_album_id_clone {
                                if !album_id.is_empty() {
                                    let added = storage.add_images_to_album_silent(
                                        album_id,
                                        &vec![image_id.clone()],
                                    );
                                    if added > 0 && album_id == crate::storage::FAVORITE_ALBUM_ID {
                                        image_info_for_event.favorite = true;
                                    }
                                    if added > 0 {
                                        let _ = app_clone.emit(
                                            "album-images-changed",
                                            serde_json::json!({
                                                "albumId": album_id,
                                                "reason": "add",
                                                "imageIds": [image_id.clone()]
                                            }),
                                        );
                                    }
                                }
                            }

                            let _ = serde_json::to_value(&image_info_for_event).map(|img_val| {
                                let mut payload = serde_json::json!({
                                    "taskId": task_id_clone,
                                    "imageId": image_id,
                                    "image": img_val,
                                });
                                if let Some(ref album_id) = output_album_id_clone {
                                    if !album_id.is_empty() {
                                        payload["albumId"] =
                                            serde_json::Value::String(album_id.clone());
                                    }
                                }
                                let _ = app_clone.emit("image-added", payload);
                            });
                        }
                        Err(_) => {
                            emit_download_state(
                                &app_clone,
                                &task_id_clone,
                                &url_clone,
                                download_start_time,
                                &plugin_id_clone,
                                "failed",
                                Some("Failed to add image to database"),
                            );
                        }
                    }
                }
            } else {
                // 复用：按需求“什么都不做”（不入库、不加画册、不关联任务、不发 image-added）
            }
        }

        // 最终：从活跃任务列表中移除
        {
            let mut tasks = match active_tasks.lock() {
                Ok(g) => g,
                Err(e) => e.into_inner(),
            };
            tasks.retain(|t| t.url != url_clone || t.start_time != download_start_time);
        }

        // 释放/退出 worker
        if release_or_exit_worker(&pool) {
            return;
        }
    }
}

fn release_or_exit_worker(pool: &DownloadPool) -> bool {
    // 释放一个“并发占用”
    if let Ok(mut st) = pool.state.lock() {
        st.in_flight = st.in_flight.saturating_sub(1);
    }
    let desired = pool.desired_workers.load(Ordering::Relaxed);
    let total = pool.total_workers.load(Ordering::Relaxed);
    if total > desired {
        pool.total_workers.fetch_sub(1, Ordering::Relaxed);
        pool.cv.notify_all();
        true
    } else {
        pool.cv.notify_one();
        false
    }
}
