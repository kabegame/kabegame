pub mod rhai;

use crate::plugin::Plugin;
use crate::plugin::{VarDefinition, VarOption};
use futures_util::StreamExt;
use reqwest;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncWriteExt;
use url::Url;

/// 创建配置了系统代理的 reqwest 客户端
/// 自动从环境变量读取 HTTP_PROXY, HTTPS_PROXY, NO_PROXY 等配置
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
    _start_url: &str, // 不再使用，由脚本自己定义
    task_id: &str,    // 用于设置任务进度
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
        let start_page_val = merged_config.get("start_page").cloned();
        let max_pages_val = merged_config.get("max_pages").cloned();
        eprintln!(
            "[rhai-inject] plugin_id={} injected_keys={:?} start_page={:?} max_pages={:?}",
            plugin.id, keys, start_page_val, max_pages_val
        );
    }

    // 执行 Rhai 爬虫脚本
    rhai::execute_crawler_script(
        plugin,
        &images_dir,
        &app,
        &plugin.id,
        task_id,
        &script_content,
        merged_config,
        output_album_id,
    )?;

    // 获取下载队列中的任务数量（包括正在下载和等待中的）
    let download_queue = app.state::<DownloadQueue>();
    let queue_size = download_queue.get_queue_size().unwrap_or(0);
    let active_downloads = download_queue.get_active_downloads().unwrap_or_default();

    let total = queue_size + active_downloads.len();

    // 返回结果，表示脚本执行成功
    // 实际的下载由下载队列异步处理
    Ok(CrawlResult {
        total,
        downloaded: 0,      // 下载是异步的，无法立即知道已下载数量
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

    // 先按 var_defs 填满所有变量（默认值 -> 用户值覆盖）
    let mut merged: HashMap<String, serde_json::Value> = HashMap::new();
    for def in &var_defs {
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

    Ok(merged)
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

#[derive(Debug)]
struct DownloadedImage {
    path: PathBuf,
    thumbnail: Option<PathBuf>,
    hash: String,
    reused: bool,
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

#[allow(dead_code)]
fn compute_bytes_hash(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn sanitize_filename(name: &str, fallback_ext: &str) -> String {
    let path = Path::new(name);
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("image");
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .filter(|e| !e.is_empty())
        .unwrap_or(fallback_ext);

    let clean_stem: String = stem
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == ' ' {
                c
            } else {
                '_'
            }
        })
        .collect();

    let stem_final = if clean_stem.trim().is_empty() {
        "image"
    } else {
        clean_stem.trim()
    };
    format!("{}.{}", stem_final, ext)
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
        let new_name = if ext.is_empty() {
            format!("{}({})", stem, idx)
        } else {
            format!("{}({}).{}", stem, idx, ext)
        };
        candidate = dir.join(&new_name);
        if !candidate.exists() {
            return candidate;
        }
        idx += 1;
    }
}

async fn download_image(
    client: &reqwest::Client,
    url: &str,
    base_dir: &Path,
    plugin_id: &str,
    task_id: &str,
    download_start_time: u64,
    app: &AppHandle,
) -> Result<DownloadedImage, String> {
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

        // 计算源文件哈希
        let source_hash = compute_file_hash(&source_path)?;

        // 如果源文件已位于目标目录内，则不再执行复制，直接使用原文件
        if let Ok(target_dir_canonical) = target_dir.canonicalize() {
            if source_path.starts_with(&target_dir_canonical) {
                let thumbnail_path = generate_thumbnail(&source_path, app)?;
                return Ok(DownloadedImage {
                    path: source_path.clone(),
                    thumbnail: thumbnail_path,
                    hash: source_hash,
                    reused: false, // 需要在数据库记录（若未记录）
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
        let filename = sanitize_filename(original_name, extension);
        let target_path = unique_path(&target_dir, &filename);

        // 复制文件
        fs::copy(&source_path, &target_path).map_err(|e| format!("Failed to copy file: {}", e))?;

        // 删除 Windows Zone.Identifier 流（避免打开文件时出现安全警告）
        #[cfg(windows)]
        remove_zone_identifier(&target_path);

        // 生成缩略图
        let thumbnail_path = generate_thumbnail(&target_path, app)?;

        Ok(DownloadedImage {
            path: target_path,
            thumbnail: thumbnail_path,
            hash: source_hash,
            reused: false,
        })
    } else {
        // 处理 HTTP/HTTPS URL
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

        let filename = sanitize_filename(url_path, extension);
        let file_path = unique_path(&target_dir, &filename);

        // 失败重试：每次 attempt 都重新下载并写入新的临时文件（避免脏数据）
        let max_attempts = retry_count.saturating_add(1).max(1);
        let mut attempt: u32 = 0;

        let (content_hash, final_or_temp_path) = loop {
            attempt += 1;

            // 若任务已被取消，尽早退出
            let dq = app.state::<DownloadQueue>();
            if dq.is_task_canceled(task_id) {
                return Err("Task canceled".to_string());
            }

            let response = match client.get(url).send().await {
                Ok(r) => r,
                Err(e) => {
                    if attempt < max_attempts {
                        let backoff_ms = (500u64)
                            .saturating_mul(2u64.saturating_pow((attempt - 1) as u32))
                            .min(5000);
                        tokio::time::sleep(std::time::Duration::from_millis(backoff_ms)).await;
                        continue;
                    }
                    return Err(format!("Failed to download image: {}", e));
                }
            };

            let status = response.status();
            if !status.is_success() {
                let retryable =
                    status.as_u16() == 408 || status.as_u16() == 429 || status.is_server_error();
                if retryable && attempt < max_attempts {
                    let backoff_ms = (500u64)
                        .saturating_mul(2u64.saturating_pow((attempt - 1) as u32))
                        .min(5000);
                    tokio::time::sleep(std::time::Duration::from_millis(backoff_ms)).await;
                    continue;
                }
                return Err(format!("HTTP error: {}", status));
            }

            let total_bytes = response.content_length();
            let mut received_bytes: u64 = 0;

            // 临时文件：避免中途失败留下半成品；成功后再 rename 到最终路径
            let temp_name = format!(
                "{}.part-{}",
                file_path
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("image"),
                uuid::Uuid::new_v4()
            );
            let temp_path = target_dir.join(temp_name);

            let mut file = match tokio::fs::File::create(&temp_path).await {
                Ok(f) => f,
                Err(e) => return Err(format!("Failed to create file: {}", e)),
            };

            // 边下载边算 hash（用于去重）
            let mut hasher = Sha256::new();

            // 进度事件节流：至少 256KB 或 200ms 才发一次
            let mut last_emit_bytes: u64 = 0;
            let mut last_emit_at = std::time::Instant::now();
            let emit_interval = std::time::Duration::from_millis(200);
            let emit_bytes_step: u64 = 256 * 1024;

            // 首次立即发一个（用于 UI 及时出现 "0B / ?"）
            let _ = app.emit(
                "download-progress",
                serde_json::json!({
                    "taskId": task_id,
                    "url": url,
                    "startTime": download_start_time,
                    "pluginId": plugin_id,
                    "receivedBytes": received_bytes,
                    "totalBytes": total_bytes,
                }),
            );

            let mut stream = response.bytes_stream();
            let mut stream_error: Option<String> = None;

            while let Some(item) = stream.next().await {
                // 任务取消：中止并清理临时文件
                let dq = app.state::<DownloadQueue>();
                if dq.is_task_canceled(task_id) {
                    let _ = tokio::fs::remove_file(&temp_path).await;
                    return Err("Task canceled".to_string());
                }

                let chunk = match item {
                    Ok(c) => c,
                    Err(e) => {
                        stream_error = Some(format!("Failed to read stream: {}", e));
                        break;
                    }
                };

                hasher.update(&chunk);
                if let Err(e) = file.write_all(&chunk).await {
                    stream_error = Some(format!("Failed to write file: {}", e));
                    break;
                }

                received_bytes = received_bytes.saturating_add(chunk.len() as u64);

                let should_emit = received_bytes.saturating_sub(last_emit_bytes) >= emit_bytes_step
                    || last_emit_at.elapsed() >= emit_interval;
                if should_emit {
                    last_emit_bytes = received_bytes;
                    last_emit_at = std::time::Instant::now();
                    let _ = app.emit(
                        "download-progress",
                        serde_json::json!({
                            "taskId": task_id,
                            "url": url,
                            "startTime": download_start_time,
                            "pluginId": plugin_id,
                            "receivedBytes": received_bytes,
                            "totalBytes": total_bytes,
                        }),
                    );
                }
            }

            // 关闭文件句柄（确保 Windows 下 rename 不被占用）
            let _ = file.flush().await;
            drop(file);

            if let Some(err) = stream_error {
                let _ = tokio::fs::remove_file(&temp_path).await;
                if attempt < max_attempts {
                    let backoff_ms = (500u64)
                        .saturating_mul(2u64.saturating_pow((attempt - 1) as u32))
                        .min(5000);
                    tokio::time::sleep(std::time::Duration::from_millis(backoff_ms)).await;
                    continue;
                }
                return Err(err);
            }

            // 最终再发一次（接近 100%）
            let _ = app.emit(
                "download-progress",
                serde_json::json!({
                    "taskId": task_id,
                    "url": url,
                    "startTime": download_start_time,
                    "pluginId": plugin_id,
                    "receivedBytes": received_bytes,
                    "totalBytes": total_bytes,
                }),
            );

            let content_hash = format!("{:x}", hasher.finalize());
            break (content_hash, temp_path);
        };

        // 若已有相同哈希且文件存在，复用
        let storage = app.state::<crate::storage::Storage>();
        if let Ok(Some(existing)) = storage.find_image_by_hash(&content_hash) {
            let existing_path = PathBuf::from(&existing.local_path);
            if existing_path.exists() {
                // 删除刚下载的临时文件
                let _ = tokio::fs::remove_file(&final_or_temp_path).await;
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

                return Ok(DownloadedImage {
                    path: PathBuf::from(canonical_existing),
                    thumbnail: Some(PathBuf::from(canonical_thumb)),
                    hash: if existing.hash.is_empty() {
                        content_hash
                    } else {
                        existing.hash
                    },
                    reused: true,
                });
            }
        }

        // 未命中复用：将临时文件移动到最终路径
        tokio::fs::rename(&final_or_temp_path, &file_path)
            .await
            .map_err(|e| format!("Failed to finalize file: {}", e))?;

        // 删除 Windows Zone.Identifier 流（避免打开文件时出现安全警告）
        #[cfg(windows)]
        remove_zone_identifier(&file_path);

        // 生成缩略图
        let thumbnail_path = generate_thumbnail(&file_path, app)?;

        Ok(DownloadedImage {
            path: file_path,
            thumbnail: thumbnail_path,
            hash: content_hash,
            reused: false,
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

// 下载任务
#[derive(Debug, Clone)]
struct DownloadTask {
    url: String,
    images_dir: PathBuf,
    plugin_id: String,
    task_id: String,
    download_start_time: u64,
    output_album_id: Option<String>, // 输出画册ID，如果指定则下载完成后自动添加到画册
}

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
    /// - queued: 已入队等待
    /// - downloading: 正在下载
    /// - downloaded: 下载完成（字节已落盘/或复用判定完成）
    /// - processing: 下载后处理（路径规范化/去重/入库/通知）
    /// - dedupe_skipped: 去重命中，跳过入库
    /// - reused: 命中已有图片复用
    /// - db_added: 已写入数据库
    /// - notified: 已通知前端刷新（image-added）
    /// - failed: 失败
    /// - canceled: 已取消
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

// 下载队列管理器
#[derive(Clone)]
pub struct DownloadQueue {
    app: AppHandle,
    queue: Arc<Mutex<VecDeque<DownloadTask>>>,
    queue_cv: Arc<Condvar>,
    active_downloads: Arc<Mutex<u32>>,
    active_tasks: Arc<Mutex<Vec<ActiveDownloadInfo>>>,
    canceled_tasks: Arc<Mutex<HashSet<String>>>,
}

impl DownloadQueue {
    const MAX_QUEUE_LEN: usize = 300;

    pub fn new(app: AppHandle) -> Self {
        let queue = Self {
            app,
            queue: Arc::new(Mutex::new(VecDeque::new())),
            queue_cv: Arc::new(Condvar::new()),
            active_downloads: Arc::new(Mutex::new(0)),
            active_tasks: Arc::new(Mutex::new(Vec::new())),
            canceled_tasks: Arc::new(Mutex::new(HashSet::new())),
        };

        // 启动队列处理任务
        queue.start_processor();

        queue
    }

    /// 队列变短时，统一在这里唤醒所有等待入队的线程
    #[inline]
    fn notify_queue_shortened(queue_cv: &Condvar) {
        queue_cv.notify_all();
    }

    /// 当等待队列过长时，阻塞当前入队，直到队列变短（或任务被取消）
    fn lock_queue_wait_below_limit(
        &self,
        task_id: &str,
    ) -> Result<std::sync::MutexGuard<'_, VecDeque<DownloadTask>>, String> {
        let mut queue_guard = self
            .queue
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;

        while queue_guard.len() >= Self::MAX_QUEUE_LEN {
            if self.is_task_canceled(task_id) {
                return Ok(queue_guard);
            }
            queue_guard = self
                .queue_cv
                .wait(queue_guard)
                .map_err(|e| format!("Lock error: {}", e))?;
        }
        Ok(queue_guard)
    }

    // 获取正在下载的任务列表
    pub fn get_active_downloads(&self) -> Result<Vec<ActiveDownloadInfo>, String> {
        let tasks = self
            .active_tasks
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;
        Ok(tasks.clone())
    }

    // 获取队列中的任务数量
    pub fn get_queue_size(&self) -> Result<usize, String> {
        let queue = self
            .queue
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;
        Ok(queue.len())
    }

    /// 获取当前等待队列（仅排队中，不含 active_tasks）
    pub fn get_queue_items(&self) -> Result<Vec<ActiveDownloadInfo>, String> {
        let queue = self
            .queue
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;
        Ok(queue
            .iter()
            .map(|t| ActiveDownloadInfo {
                url: t.url.clone(),
                plugin_id: t.plugin_id.clone(),
                start_time: t.download_start_time,
                task_id: t.task_id.clone(),
                state: "queued".to_string(),
            })
            .collect())
    }

    /// 清空"等待队列"（不影响正在下载的任务）
    pub fn clear_queue(&self) -> Result<usize, String> {
        let mut queue = self
            .queue
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;
        let removed = queue.len();
        queue.clear();
        // 清空队列也属于"队列变短"，唤醒所有等待者
        Self::notify_queue_shortened(&self.queue_cv);
        Ok(removed)
    }

    // 添加下载任务到队列
    pub fn enqueue(
        &self,
        url: String,
        images_dir: PathBuf,
        plugin_id: String,
        task_id: String,
        download_start_time: u64,
        output_album_id: Option<String>,
    ) -> Result<(), String> {
        if self.is_task_canceled(&task_id) {
            return Ok(());
        }

        // 构造任务时保留原始字符串所有权，避免后续 emit/日志触发 move/borrow 冲突
        let task = DownloadTask {
            url: url.clone(),
            images_dir,
            plugin_id: plugin_id.clone(),
            task_id: task_id.clone(),
            download_start_time,
            output_album_id,
        };

        // 背压：当队列达到上限时阻塞，直到队列变短（等待与入队在同一把锁内完成，保证上限严格生效）
        let mut queue = self.lock_queue_wait_below_limit(&task_id)?;
        if self.is_task_canceled(&task_id) {
            return Ok(());
        }
        queue.push_back(task);

        // 入队后再 emit 状态事件（前端不一定展示 queued，但事件仍可用于调试/统计）
        emit_download_state(
            &self.app,
            &task_id,
            &url,
            download_start_time,
            &plugin_id,
            "queued",
            None,
        );

        Ok(())
    }

    // 取消任务：移除队列中该任务，并标记为取消，正在下载的任务在保存阶段会被跳过
    pub fn cancel_task(&self, task_id: &str) -> Result<(), String> {
        // 1. 标记为取消
        {
            let mut canceled = self
                .canceled_tasks
                .lock()
                .map_err(|e| format!("Lock error: {}", e))?;
            canceled.insert(task_id.to_string());
        }

        // 2. 从等待队列中移除属于该任务的所有下载项（立即生效，避免继续处理已取消任务的下载）
        {
            let mut queue = self
                .queue
                .lock()
                .map_err(|e| format!("Lock error: {}", e))?;
            let before_len = queue.len();
            queue.retain(|t| t.task_id != task_id);
            let removed = before_len - queue.len();
            if removed > 0 {
                eprintln!(
                    "[cancel_task] Removed {} queued downloads for task {}",
                    removed, task_id
                );
            }
        }
        // 取消任务会缩短队列，唤醒所有等待者
        Self::notify_queue_shortened(&self.queue_cv);

        Ok(())
    }

    pub fn is_task_canceled(&self, task_id: &str) -> bool {
        match self.canceled_tasks.lock() {
            Ok(c) => c.contains(task_id),
            Err(e) => e.into_inner().contains(task_id),
        }
    }

    // 启动队列处理器
    fn start_processor(&self) {
        let queue: Arc<Mutex<VecDeque<DownloadTask>>> = Arc::clone(&self.queue);
        let queue_cv: Arc<Condvar> = Arc::clone(&self.queue_cv);
        let active_downloads = Arc::clone(&self.active_downloads);
        let active_tasks = Arc::clone(&self.active_tasks);
        let canceled_tasks = Arc::clone(&self.canceled_tasks);
        let app = self.app.clone();

        // 在后台任务中处理队列
        tauri::async_runtime::spawn(async move {
            let mut interval = tokio::time::interval(tokio::time::Duration::from_millis(100));

            loop {
                interval.tick().await;

                // 获取最大并发数
                let max_concurrent = {
                    match app.try_state::<crate::settings::Settings>() {
                        Some(settings) => match settings.get_settings() {
                            Ok(s) => s.max_concurrent_downloads,
                            Err(_) => 3, // 默认值
                        },
                        None => 3, // 默认值
                    }
                };

                // 检查是否可以开始新的下载
                let current_active = {
                    let active = active_downloads.lock().unwrap();
                    *active
                };

                if current_active < max_concurrent {
                    // 从队列中取出任务（FIFO）
                    if let Some(task) = {
                        let mut queue_guard = queue.lock().unwrap();
                        queue_guard.pop_front()
                    } {
                        // pop_front 会让队列变短，唤醒等待入队者
                        Self::notify_queue_shortened(&queue_cv);
                        // 在开始处理前检查任务是否已被取消（避免处理已取消任务的下载）
                        {
                            let canceled = canceled_tasks.lock().unwrap();
                            if canceled.contains(&task.task_id) {
                                // 任务已取消，跳过此下载项
                                continue;
                            }
                        }

                        // 增加活跃下载数
                        {
                            let mut active = active_downloads.lock().unwrap();
                            *active += 1;
                        }

                        // 添加到活跃任务列表（并初始化状态）
                        let download_info = ActiveDownloadInfo {
                            url: task.url.clone(),
                            plugin_id: task.plugin_id.clone(),
                            start_time: task.download_start_time,
                            task_id: task.task_id.clone(),
                            state: "downloading".to_string(),
                        };
                        {
                            let mut tasks = active_tasks.lock().unwrap();
                            tasks.push(download_info.clone());
                        }

                        emit_download_state(
                            &app,
                            &download_info.task_id,
                            &download_info.url,
                            download_info.start_time,
                            &download_info.plugin_id,
                            "downloading",
                            None,
                        );

                        // 启动下载任务
                        let active_clone = Arc::clone(&active_downloads);
                        let active_tasks_clone = Arc::clone(&active_tasks);
                        let app_clone = app.clone();
                        let task_clone = task.clone();
                        let _canceled_clone = Arc::clone(&canceled_tasks);

                        tauri::async_runtime::spawn(async move {
                            let client = match crate::crawler::create_client() {
                                Ok(c) => c,
                                Err(e) => {
                                    eprintln!("Failed to create HTTP client with proxy: {}", e);
                                    return;
                                }
                            };
                            let result = download_image(
                                &client,
                                &task_clone.url,
                                &task_clone.images_dir,
                                &task_clone.plugin_id,
                                &task_clone.task_id,
                                task_clone.download_start_time,
                                &app_clone,
                            )
                            .await;

                            // 减少活跃下载数
                            {
                                let mut active = active_clone.lock().unwrap();
                                *active -= 1;
                            }
                            // 更新状态（下载结束 -> 后处理 / 失败）
                            {
                                let mut tasks = active_tasks_clone.lock().unwrap();
                                if let Some(t) = tasks.iter_mut().find(|t| {
                                    t.url == task_clone.url
                                        && t.start_time == task_clone.download_start_time
                                }) {
                                    match &result {
                                        Ok(downloaded) => {
                                            if downloaded.reused {
                                                t.state = "reused".to_string();
                                            } else {
                                                t.state = "downloaded".to_string();
                                            }
                                        }
                                        Err(e) => {
                                            t.state = if e.contains("Task canceled") {
                                                "canceled".to_string()
                                            } else {
                                                "failed".to_string()
                                            };
                                        }
                                    }
                                }
                            }

                            match &result {
                                Ok(downloaded) => {
                                    emit_download_state(
                                        &app_clone,
                                        &task_clone.task_id,
                                        &task_clone.url,
                                        task_clone.download_start_time,
                                        &task_clone.plugin_id,
                                        if downloaded.reused {
                                            "reused"
                                        } else {
                                            "downloaded"
                                        },
                                        None,
                                    );
                                }
                                Err(e) => {
                                    emit_download_state(
                                        &app_clone,
                                        &task_clone.task_id,
                                        &task_clone.url,
                                        task_clone.download_start_time,
                                        &task_clone.plugin_id,
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
                            if let Ok(downloaded) = result {
                                // 在保存到数据库前，再次检查任务是否已被取消
                                let dq = app_clone.state::<DownloadQueue>();
                                if dq.is_task_canceled(&task_clone.task_id) {
                                    // 任务已取消，跳过保存阶段，并清理已下载的文件（如果是新下载的）
                                    if !downloaded.reused {
                                        let _ = tokio::fs::remove_file(&downloaded.path).await;
                                        if let Some(thumb) = downloaded.thumbnail {
                                            if thumb.exists() {
                                                let _ = tokio::fs::remove_file(&thumb).await;
                                            }
                                        }
                                    }

                                    emit_download_state(
                                        &app_clone,
                                        &task_clone.task_id,
                                        &task_clone.url,
                                        task_clone.download_start_time,
                                        &task_clone.plugin_id,
                                        "canceled",
                                        None,
                                    );

                                    // 最终：从活跃任务列表中移除
                                    {
                                        let mut tasks = active_tasks_clone.lock().unwrap();
                                        tasks.retain(|t| {
                                            t.url != task_clone.url
                                                || t.start_time != task_clone.download_start_time
                                        });
                                    }
                                    return;
                                }

                                emit_download_state(
                                    &app_clone,
                                    &task_clone.task_id,
                                    &task_clone.url,
                                    task_clone.download_start_time,
                                    &task_clone.plugin_id,
                                    "processing",
                                    None,
                                );

                                {
                                    let mut tasks = active_tasks_clone.lock().unwrap();
                                    if let Some(t) = tasks.iter_mut().find(|t| {
                                        t.url == task_clone.url
                                            && t.start_time == task_clone.download_start_time
                                    }) {
                                        t.state = "processing".to_string();
                                    }
                                }

                                let storage = app_clone.state::<crate::storage::Storage>();
                                // 规范化路径为绝对路径，并移除 Windows 长路径前缀
                                let local_path_str = downloaded
                                    .path
                                    .canonicalize()
                                    .unwrap_or(downloaded.path)
                                    .to_string_lossy()
                                    .to_string()
                                    .trim_start_matches("\\\\?\\")
                                    .to_string();
                                let thumbnail_path_str = downloaded
                                    .thumbnail
                                    .and_then(|p| p.canonicalize().ok())
                                    .map(|p| {
                                        p.to_string_lossy()
                                            .to_string()
                                            .trim_start_matches("\\\\?\\")
                                            .to_string()
                                    })
                                    .unwrap_or_else(|| local_path_str.clone());
                                let mut should_emit = false;
                                let mut emitted_image_id: Option<String> = None;

                                if !downloaded.reused {
                                    emit_download_state(
                                        &app_clone,
                                        &task_clone.task_id,
                                        &task_clone.url,
                                        task_clone.download_start_time,
                                        &task_clone.plugin_id,
                                        "dedupe_check",
                                        None,
                                    );
                                    // 检查是否启用自动去重
                                    let should_skip = {
                                        let settings_state =
                                            app_clone.try_state::<crate::settings::Settings>();
                                        if let Some(settings) = settings_state {
                                            if let Ok(s) = settings.get_settings() {
                                                if s.auto_deduplicate && !downloaded.hash.is_empty()
                                                {
                                                    // 检查哈希是否已存在
                                                    if let Ok(Some(_existing)) =
                                                        storage.find_image_by_hash(&downloaded.hash)
                                                    {
                                                        true // 哈希已存在，跳过添加
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

                                    if !should_skip {
                                        emit_download_state(
                                            &app_clone,
                                            &task_clone.task_id,
                                            &task_clone.url,
                                            task_clone.download_start_time,
                                            &task_clone.plugin_id,
                                            "db_inserting",
                                            None,
                                        );
                                        // 如果配置了输出画册，且为收藏画册，则设置 favorite 为 true
                                        let favorite = if let Some(ref album_id) =
                                            task_clone.output_album_id
                                        {
                                            album_id == crate::storage::FAVORITE_ALBUM_ID
                                        } else {
                                            false
                                        };
                                        let image_info = crate::storage::ImageInfo {
                                            id: uuid::Uuid::new_v4().to_string(),
                                            url: task_clone.url.clone(),
                                            local_path: local_path_str,
                                            plugin_id: task_clone.plugin_id.clone(),
                                            task_id: Some(task_clone.task_id.clone()),
                                            crawled_at: task_clone.download_start_time,
                                            metadata: None,
                                            thumbnail_path: thumbnail_path_str.clone(),
                                            favorite,
                                            hash: downloaded.hash.clone(),
                                            order: Some(task_clone.download_start_time as i64), // 默认 order = crawled_at（越晚越大）
                                        };
                                        if storage.add_image(image_info.clone()).is_ok() {
                                            let image_id = image_info.id.clone();

                                            // 如果配置了输出画册，立即添加到画册
                                            if let Some(ref album_id) = task_clone.output_album_id {
                                                if !album_id.is_empty() {
                                                    match storage.add_images_to_album(
                                                        album_id,
                                                        &vec![image_id.clone()],
                                                    ) {
                                                        Ok(count) => {
                                                            if count == 0 {
                                                                eprintln!(
                                                                    "[WARN] 图片 {} 可能已存在于画册 {} 中",
                                                                    image_id, album_id
                                                                );
                                                            }
                                                        }
                                                        Err(e) => {
                                                            eprintln!(
                                                                "[ERROR] 添加图片 {} 到画册 {} 失败: {}",
                                                                image_id, album_id, e
                                                            );
                                                        }
                                                    }
                                                }
                                            }

                                            emit_download_state(
                                                &app_clone,
                                                &task_clone.task_id,
                                                &task_clone.url,
                                                task_clone.download_start_time,
                                                &task_clone.plugin_id,
                                                "db_added",
                                                None,
                                            );
                                            should_emit = true;
                                            emitted_image_id = Some(image_id);
                                        } else {
                                            emit_download_state(
                                                &app_clone,
                                                &task_clone.task_id,
                                                &task_clone.url,
                                                task_clone.download_start_time,
                                                &task_clone.plugin_id,
                                                "failed",
                                                Some("Failed to add image to database"),
                                            );
                                        }
                                    } else {
                                        emit_download_state(
                                            &app_clone,
                                            &task_clone.task_id,
                                            &task_clone.url,
                                            task_clone.download_start_time,
                                            &task_clone.plugin_id,
                                            "dedupe_skipped",
                                            None,
                                        );

                                        {
                                            let mut tasks = active_tasks_clone.lock().unwrap();
                                            if let Some(t) = tasks.iter_mut().find(|t| {
                                                t.url == task_clone.url
                                                    && t.start_time
                                                        == task_clone.download_start_time
                                            }) {
                                                t.state = "dedupe_skipped".to_string();
                                            }
                                        }
                                    }
                                } else {
                                    // 已有记录重用，也通知前端刷新列表，因为有可能缩略图被重新生成
                                    should_emit = true;
                                }

                                if should_emit {
                                    let _ = app_clone.emit(
                                        "image-added",
                                        serde_json::json!({
                                            "taskId": task_clone.task_id,
                                            "imageId": emitted_image_id.unwrap_or_default(),
                                        }),
                                    );
                                    emit_download_state(
                                        &app_clone,
                                        &task_clone.task_id,
                                        &task_clone.url,
                                        task_clone.download_start_time,
                                        &task_clone.plugin_id,
                                        "notified",
                                        None,
                                    );
                                }
                            }

                            // 最终：从活跃任务列表中移除
                            {
                                let mut tasks = active_tasks_clone.lock().unwrap();
                                tasks.retain(|t| {
                                    t.url != task_clone.url
                                        || t.start_time != task_clone.download_start_time
                                });
                            }
                        });
                    }
                }
            }
        });
    }
}
