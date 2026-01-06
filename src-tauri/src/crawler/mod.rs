pub mod rhai;

use crate::plugin::Plugin;
use crate::plugin::{VarDefinition, VarOption};
use reqwest;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use tauri::{AppHandle, Emitter, Manager};
use url::Url;

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

#[derive(Debug, Clone)]
struct DownloadedImage {
    path: PathBuf,
    thumbnail: Option<PathBuf>,
    hash: String,
    reused: bool,
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

fn download_image(
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
                // 确保下载过程至少持续指定时间（即使文件已经存在）
                ensure_minimum_duration(download_start_time, 500);
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

        // 确保下载过程至少持续指定时间
        ensure_minimum_duration(download_start_time, 500);

        Ok(DownloadedImage {
            path: target_path,
            thumbnail: thumbnail_path,
            hash: source_hash,
            reused: false,
        })
    } else {
        // 处理 HTTP/HTTPS URL
        // 在单独线程中执行下载，以便发送进度事件
        let url_clone = url.to_string();
        let target_dir_clone = target_dir.clone();
        let plugin_id_clone = plugin_id.to_string();
        let task_id_clone = task_id.to_string();
        let app_clone = app.clone();
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
        let file_path_clone = file_path.clone();

        let (tx, rx) = std::sync::mpsc::channel();

        std::thread::spawn(move || {
            let result = (|| -> Result<(String, PathBuf), String> {
                let client = create_blocking_client()?;

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

                    let response = match client.get(&url_clone).send() {
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
                    let temp_name = format!(
                        "{}.part-{}",
                        file_path_clone
                            .file_name()
                            .and_then(|s| s.to_str())
                            .unwrap_or("image"),
                        uuid::Uuid::new_v4()
                    );
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
            })();

            let _ = tx.send(result);
        });

        let (content_hash, final_or_temp_path) = rx
            .recv()
            .map_err(|e| format!("Thread communication error: {}", e))?
            .map_err(|e| e)?;

        // 若已有相同哈希且文件存在，复用
        let storage = app.state::<crate::storage::Storage>();
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
                        content_hash
                    } else {
                        existing.hash
                    },
                    reused: true,
                });
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

// 下载并发窗口管理器（不再使用队列）
#[derive(Clone)]
pub struct DownloadQueue {
    app: AppHandle,
    window_cv: Arc<Condvar>, // 用于等待窗口空位
    active_downloads: Arc<Mutex<u32>>,
    active_tasks: Arc<Mutex<Vec<ActiveDownloadInfo>>>,
    canceled_tasks: Arc<Mutex<HashSet<String>>>,
}

impl DownloadQueue {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            window_cv: Arc::new(Condvar::new()),
            active_downloads: Arc::new(Mutex::new(0)),
            active_tasks: Arc::new(Mutex::new(Vec::new())),
            canceled_tasks: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    /// 获取最大并发数
    fn get_max_concurrent(&self) -> u32 {
        match self.app.try_state::<crate::settings::Settings>() {
            Some(settings) => match settings.get_settings() {
                Ok(s) => s.max_concurrent_downloads,
                Err(_) => 3, // 默认值
            },
            None => 3, // 默认值
        }
    }

    /// 等待窗口有空位（当窗口满时挂起，有空位时唤醒）
    fn wait_for_window_slot(&self, task_id: &str) -> Result<(), String> {
        let mut active_guard = self
            .active_downloads
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;

        // 在循环内部每次迭代时重新获取 max_concurrent，以便实时响应设置变更
        while {
            let max_concurrent = self.get_max_concurrent();
            *active_guard >= max_concurrent
        } {
            if self.is_task_canceled(task_id) {
                return Ok(());
            }
            active_guard = self
                .window_cv
                .wait(active_guard)
                .map_err(|e| format!("Lock error: {}", e))?;
        }

        Ok(())
    }

    /// 通知窗口有空位（当下载完成时调用）
    fn notify_window_slot_available(&self) {
        self.window_cv.notify_one();
    }

    /// 通知所有等待的任务重新检查窗口（当并发数设置改变时调用）
    pub fn notify_all_waiting(&self) {
        self.window_cv.notify_all();
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
    ) -> Result<bool, String> {
        if self.is_task_canceled(&task_id) {
            return Err("Task canceled".to_string());
        }

        // 在启动下载前，先检查 URL 是否已存在（如果启用了自动去重）
        // 这样可以避免占用下载窗口和活跃下载数
        let should_skip_by_url = {
            let settings_state = self.app.try_state::<crate::settings::Settings>();
            if let Some(settings) = settings_state {
                if let Ok(s) = settings.get_settings() {
                    if s.auto_deduplicate {
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
        };

        // 如果 URL 已存在，跳过下载但处理后续逻辑（如添加到画册）
        if should_skip_by_url {
            // 在后台线程处理后续逻辑（添加到画册等）
            let app_clone = self.app.clone();
            let url_clone = url.clone();
            let task_id_clone = task_id.clone();
            let plugin_id_clone = plugin_id.clone();
            let output_album_id_clone = output_album_id.clone();

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

                // 获取已存在的图片信息
                let storage = app_clone.state::<crate::storage::Storage>();
                if let Ok(Some(existing_image)) = storage.find_image_by_url(&url_clone) {
                    let image_id = existing_image.id.clone();

                    // 如果配置了输出画册，将已存在的图片添加到画册（静默失败）
                    let mut existing_image_for_event = existing_image.clone();
                    if let Some(ref album_id) = output_album_id_clone {
                        if !album_id.is_empty() {
                            let added = storage
                                .add_images_to_album_silent(album_id, &vec![image_id.clone()]);
                            if added > 0 {
                                if album_id == crate::storage::FAVORITE_ALBUM_ID {
                                    existing_image_for_event.favorite = true;
                                }
                            }
                        }
                    }

                    ensure_minimum_duration(download_start_time, 500);

                    // 发送事件
                    let _ = serde_json::to_value(&existing_image_for_event).map(|img_val| {
                        let mut payload = serde_json::json!({
                            "taskId": task_id_clone,
                            "imageId": image_id,
                            "image": img_val,
                            "reused": true,
                        });
                        if let Some(ref album_id) = output_album_id_clone {
                            if !album_id.is_empty() {
                                payload["albumId"] = serde_json::Value::String(album_id.clone());
                            }
                        }
                        let _ = app_clone.emit("image-added", payload);
                    });
                }

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

            return Ok(true);
        }

        // 等待窗口有空位（如果窗口满则阻塞）
        self.wait_for_window_slot(&task_id)?;
        if self.is_task_canceled(&task_id) {
            return Err("Task canceled".to_string());
        }

        // 增加活跃下载数
        {
            let mut active = self
                .active_downloads
                .lock()
                .map_err(|e| format!("Lock error: {}", e))?;
            *active += 1;
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

        // 在后台异步执行下载
        let app_clone = self.app.clone();
        let url_clone = url.clone();
        let images_dir_clone = images_dir.clone();
        let plugin_id_clone = plugin_id.clone();
        let task_id_clone = task_id.clone();
        let output_album_id_clone = output_album_id.clone();
        let active_downloads_clone = Arc::clone(&self.active_downloads);
        let active_tasks_clone = Arc::clone(&self.active_tasks);
        let window_cv_clone = Arc::clone(&self.window_cv);

        std::thread::spawn(move || {
            // 开始下载，更新状态为 downloading
            {
                let mut tasks = active_tasks_clone.lock().unwrap();
                if let Some(t) = tasks
                    .iter_mut()
                    .find(|t| t.url == url_clone && t.start_time == download_start_time)
                {
                    t.state = "downloading".to_string();
                }
            }

            // 执行下载
            let result = download_image(
                &url_clone,
                &images_dir_clone,
                &plugin_id_clone,
                &task_id_clone,
                download_start_time,
                &app_clone,
            );

            // 减少活跃下载数
            {
                let mut active = active_downloads_clone.lock().unwrap();
                *active -= 1;
            }

            // 通知窗口有空位
            window_cv_clone.notify_one();

            // 更新状态
            {
                let mut tasks = active_tasks_clone.lock().unwrap();
                if let Some(t) = tasks
                    .iter_mut()
                    .find(|t| t.url == url_clone && t.start_time == download_start_time)
                {
                    match &result {
                        Ok(_downloaded) => {
                            // 下载完成，进入处理阶段
                            t.state = "processing".to_string();
                        }
                        Err(e) => {
                            // 失败或取消时保持原状态（前端会处理错误显示）
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
                Ok(_downloaded) => {
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
                    // 任务已取消，跳过保存阶段，并清理已下载的文件（如果是新下载的）
                    if !downloaded.reused {
                        let _ = std::fs::remove_file(&downloaded.path);
                        if let Some(thumb) = &downloaded.thumbnail {
                            if thumb.exists() {
                                let _ = std::fs::remove_file(thumb);
                            }
                        }
                    }

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
                        let mut tasks = active_tasks_clone.lock().unwrap();
                        tasks.retain(|t| t.url != url_clone || t.start_time != download_start_time);
                    }
                    return;
                }

                {
                    let mut tasks = active_tasks_clone.lock().unwrap();
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
                let mut should_emit = false;
                let mut emitted_image_id: Option<String> = None;

                if !downloaded.reused {
                    // 检查是否启用自动去重
                    let should_skip = {
                        let settings_state = app_clone.try_state::<crate::settings::Settings>();
                        if let Some(settings) = settings_state {
                            if let Ok(s) = settings.get_settings() {
                                if s.auto_deduplicate {
                                    // 先用 URL 判断，如果 URL 不存在，再用哈希判断
                                    if let Ok(Some(_existing)) =
                                        storage.find_image_by_url(&url_clone)
                                    {
                                        true // URL 已存在，跳过添加
                                    } else if !downloaded.hash.is_empty() {
                                        // URL 不存在，检查哈希是否已存在
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
                        } else {
                            false
                        }
                    };

                    if !should_skip {
                        // favorite 字段不再存储在数据库中，将通过查询时 JOIN 收藏画册自动计算
                        // 状态已在下载完成时发送，这里不需要重复发送
                        let image_info = crate::storage::ImageInfo {
                            id: uuid::Uuid::new_v4().to_string(),
                            url: url_clone.clone(),
                            local_path: local_path_str.clone(),
                            plugin_id: plugin_id_clone.clone(),
                            task_id: Some(task_id_clone.clone()),
                            crawled_at: download_start_time,
                            metadata: None,
                            thumbnail_path: thumbnail_path_str.clone(),
                            favorite: false, // 不再存储，查询时会自动计算
                            hash: downloaded.hash.clone(),
                            order: Some(download_start_time as i64), // 默认 order = crawled_at（越晚越大）
                        };
                        if storage.add_image(image_info.clone()).is_ok() {
                            let image_id = image_info.id.clone();
                            let mut image_info_for_event = image_info.clone();

                            // 如果配置了输出画册，立即添加到画册（静默失败）
                            if let Some(ref album_id) = output_album_id_clone {
                                if !album_id.is_empty() {
                                    let added = storage.add_images_to_album_silent(
                                        album_id,
                                        &vec![image_id.clone()],
                                    );
                                    if added > 0 {
                                        // 如果添加到的是收藏画册，更新 favorite 状态
                                        if album_id == crate::storage::FAVORITE_ALBUM_ID {
                                            image_info_for_event.favorite = true;
                                        }
                                    }
                                }
                            }

                            should_emit = true;
                            emitted_image_id = Some(image_id.clone());

                            // 保存图片信息用于事件发送（使用更新后的 image_info_for_event）
                            let _ = serde_json::to_value(&image_info_for_event).map(|img_val| {
                                // 在事件中包含完整的图片信息
                                let mut payload = serde_json::json!({
                                    "taskId": task_id_clone,
                                    "imageId": image_id,
                                    "image": img_val,
                                });
                                // 如果图片被添加到画册，在事件中包含画册ID
                                if let Some(ref album_id) = output_album_id_clone {
                                    if !album_id.is_empty() {
                                        payload["albumId"] =
                                            serde_json::Value::String(album_id.clone());
                                    }
                                }
                                let _ = app_clone.emit("image-added", payload);
                            });
                        } else {
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
                    } else {
                        // 去重跳过时，状态已在下载完成时发送，这里不需要重复发送

                        {
                            let mut tasks = active_tasks_clone.lock().unwrap();
                            if let Some(t) = tasks
                                .iter_mut()
                                .find(|t| t.url == url_clone && t.start_time == download_start_time)
                            {
                                t.state = "processing".to_string();
                            }
                        }
                    }
                } else {
                    // 已有记录重用，也通知前端刷新列表，因为有可能缩略图被重新生成
                    // 需要从数据库查询完整的图片信息
                    if let Ok(Some(existing_image)) = storage.find_image_by_hash(&downloaded.hash) {
                        let image_id = existing_image.id.clone();

                        // 如果配置了输出画册，将重用的图片也添加到画册（静默失败）
                        let mut existing_image_for_event = existing_image.clone();
                        if let Some(ref album_id) = output_album_id_clone {
                            if !album_id.is_empty() {
                                let added = storage
                                    .add_images_to_album_silent(album_id, &vec![image_id.clone()]);
                                if added > 0 {
                                    // 如果添加到的是收藏画册，更新 favorite 状态
                                    if album_id == crate::storage::FAVORITE_ALBUM_ID {
                                        existing_image_for_event.favorite = true;
                                    }
                                }
                            }
                        }

                        should_emit = true;
                        emitted_image_id = Some(image_id.clone());

                        // 在事件中包含完整的图片信息（使用更新后的 existing_image_for_event）
                        let _ = serde_json::to_value(&existing_image_for_event).map(|img_val| {
                            let mut payload = serde_json::json!({
                                "taskId": task_id_clone,
                                "imageId": image_id,
                                "image": img_val,
                                "reused": true,
                            });
                            // 如果图片被添加到画册，在事件中包含画册ID
                            if let Some(ref album_id) = output_album_id_clone {
                                if !album_id.is_empty() {
                                    payload["albumId"] =
                                        serde_json::Value::String(album_id.clone());
                                }
                            }
                            let _ = app_clone.emit("image-added", payload);
                        });
                    }
                }

                if should_emit && emitted_image_id.is_none() {
                    // 兜底：如果 should_emit 为 true 但没有设置 emitted_image_id，发送最小事件
                    let mut payload = serde_json::json!({
                        "taskId": task_id_clone,
                        "imageId": "",
                    });
                    // 如果图片被添加到画册，在事件中包含画册ID
                    if let Some(ref album_id) = output_album_id_clone {
                        if !album_id.is_empty() {
                            payload["albumId"] = serde_json::Value::String(album_id.clone());
                        }
                    }
                    let _ = app_clone.emit("image-added", payload);
                }
            }

            // 最终：从活跃任务列表中移除
            {
                let mut tasks = active_tasks_clone.lock().unwrap();
                tasks.retain(|t| t.url != url_clone || t.start_time != download_start_time);
            }
        });

        // 立即返回成功（下载在后台进行）
        Ok(true)
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

        // 唤醒所有等待窗口的线程（让它们检查取消状态）
        self.notify_window_slot_available();

        Ok(())
    }

    pub fn is_task_canceled(&self, task_id: &str) -> bool {
        match self.canceled_tasks.lock() {
            Ok(c) => c.contains(task_id),
            Err(e) => e.into_inner().contains(task_id),
        }
    }
}
