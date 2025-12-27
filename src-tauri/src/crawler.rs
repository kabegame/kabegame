use crate::plugin::Plugin;
use reqwest;
use rhai::{Dynamic, Engine, Map, Scope};
use scraper::{Html, Selector};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};
use url::Url;

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

    // 创建页面栈（存储 (url, html) 对）
    let page_stack: Arc<Mutex<Vec<(String, String)>>> = Arc::new(Mutex::new(Vec::new()));

    // 创建 Rhai 引擎
    let mut engine = Engine::new();

    // 创建共享的进度值（使用 Arc<Mutex> 以便在闭包中修改）
    let current_progress: Arc<Mutex<f64>> = Arc::new(Mutex::new(0.0));

    // 注册爬虫相关的 API（传入页面栈和任务ID）
    register_crawler_functions(
        &mut engine,
        &page_stack,
        &images_dir,
        &app,
        &plugin.id,
        task_id,
        Arc::clone(&current_progress),
    )?;

    // 创建作用域
    let mut scope = Scope::new();

    // 注入用户配置的变量到脚本作用域
    if let Some(config) = user_config {
        for (key, value) in config {
            // 根据值的类型转换为 Rhai 类型
            match value {
                serde_json::Value::Number(n) => {
                    if n.is_i64() {
                        scope.push(key.clone(), n.as_i64().unwrap_or(0));
                    } else if n.is_u64() {
                        scope.push(key.clone(), n.as_u64().unwrap_or(0) as i64);
                    } else if n.is_f64() {
                        scope.push(key.clone(), n.as_f64().unwrap_or(0.0));
                    }
                }
                serde_json::Value::String(s) => {
                    scope.push(key.clone(), s);
                }
                serde_json::Value::Bool(b) => {
                    scope.push(key.clone(), b);
                }
                serde_json::Value::Array(arr) => {
                    // 将数组转换为 Rhai 数组
                    let mut rhai_array = rhai::Array::new();
                    for item in arr {
                        match item {
                            serde_json::Value::String(s) => {
                                rhai_array.push(Dynamic::from(s));
                            }
                            serde_json::Value::Number(n) => {
                                if n.is_i64() {
                                    rhai_array.push(Dynamic::from(n.as_i64().unwrap_or(0)));
                                } else if n.is_u64() {
                                    rhai_array.push(Dynamic::from(n.as_u64().unwrap_or(0) as i64));
                                } else if n.is_f64() {
                                    rhai_array.push(Dynamic::from(n.as_f64().unwrap_or(0.0)));
                                }
                            }
                            serde_json::Value::Bool(b) => {
                                rhai_array.push(Dynamic::from(b));
                            }
                            _ => {
                                rhai_array.push(Dynamic::from(item.to_string()));
                            }
                        }
                    }
                    scope.push(key.clone(), rhai_array);
                }
                _ => {
                    // 其他类型转换为字符串
                    scope.push(key.clone(), value.to_string());
                }
            }
        }
    }

    // 执行脚本
    // 脚本通过 download_image() 函数将图片添加到下载队列
    // 不需要脚本返回 URL 数组，因为下载是异步的
    engine
        .eval_with_scope(&mut scope, &script_content)
        .map_err(|e| {
            eprintln!("Script execution error: {}", e);
            format!("Script execution error: {}", e)
        })?;

    eprintln!("Script executed successfully, images should be queued via download_image()");

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

/// 查找插件文件
fn find_plugin_file(plugins_dir: &Path, plugin_id: &str) -> Result<PathBuf, String> {
    let entries = fs::read_dir(plugins_dir)
        .map_err(|e| format!("Failed to read plugins directory: {}", e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
        let path = entry.path();

        if path.is_file() && path.extension().and_then(|s| s.to_str()) == Some("kgpg") {
            // 读取 manifest 来匹配插件 ID
            let file =
                fs::File::open(&path).map_err(|e| format!("Failed to open plugin file: {}", e))?;
            let mut archive = zip::ZipArchive::new(file)
                .map_err(|e| format!("Failed to open ZIP archive: {}", e))?;

            // 读取 manifest 内容到局部变量，确保 archive 在读取完成后可以释放
            let manifest_content = {
                let mut manifest_file = match archive.by_name("manifest.json") {
                    Ok(f) => f,
                    Err(_) => continue,
                };
                let mut content = String::new();
                if manifest_file.read_to_string(&mut content).is_err() {
                    continue;
                }
                content
            };

            // 现在 archive 已经可以释放了，解析 manifest
            if let Ok(manifest) =
                serde_json::from_str::<crate::plugin::PluginManifest>(&manifest_content)
            {
                let file_name = path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_string();
                let generated_id = format!("{}-{}", file_name, manifest.name);

                if generated_id == plugin_id {
                    return Ok(path);
                }
            }
        }
    }

    Err(format!("Plugin file not found for {}", plugin_id))
}

/// 将 serde_json::Value 转换为 rhai::Map
fn convert_json_to_rhai_map(json: &serde_json::Value, map: &mut Map) {
    match json {
        serde_json::Value::Object(obj) => {
            for (key, value) in obj {
                match value {
                    serde_json::Value::String(s) => {
                        map.insert(key.clone().into(), Dynamic::from(s.clone()));
                    }
                    serde_json::Value::Number(n) => {
                        if n.is_i64() {
                            map.insert(key.clone().into(), Dynamic::from(n.as_i64().unwrap_or(0)));
                        } else if n.is_u64() {
                            map.insert(
                                key.clone().into(),
                                Dynamic::from(n.as_u64().unwrap_or(0) as i64),
                            );
                        } else if n.is_f64() {
                            map.insert(
                                key.clone().into(),
                                Dynamic::from(n.as_f64().unwrap_or(0.0)),
                            );
                        }
                    }
                    serde_json::Value::Bool(b) => {
                        map.insert(key.clone().into(), Dynamic::from(*b));
                    }
                    serde_json::Value::Array(arr) => {
                        let mut rhai_array = rhai::Array::new();
                        for item in arr {
                            match item {
                                serde_json::Value::String(s) => {
                                    rhai_array.push(Dynamic::from(s.clone()));
                                }
                                serde_json::Value::Number(n) => {
                                    if n.is_i64() {
                                        rhai_array.push(Dynamic::from(n.as_i64().unwrap_or(0)));
                                    } else if n.is_u64() {
                                        rhai_array
                                            .push(Dynamic::from(n.as_u64().unwrap_or(0) as i64));
                                    } else if n.is_f64() {
                                        rhai_array.push(Dynamic::from(n.as_f64().unwrap_or(0.0)));
                                    }
                                }
                                serde_json::Value::Bool(b) => {
                                    rhai_array.push(Dynamic::from(*b));
                                }
                                serde_json::Value::Object(_) => {
                                    let mut nested_map = Map::new();
                                    convert_json_to_rhai_map(item, &mut nested_map);
                                    rhai_array.push(Dynamic::from(nested_map));
                                }
                                serde_json::Value::Array(_) => {
                                    let mut nested_array = rhai::Array::new();
                                    convert_json_to_rhai_array(item, &mut nested_array);
                                    rhai_array.push(Dynamic::from(nested_array));
                                }
                                serde_json::Value::Null => {
                                    rhai_array.push(Dynamic::UNIT);
                                }
                            }
                        }
                        map.insert(key.clone().into(), Dynamic::from(rhai_array));
                    }
                    serde_json::Value::Object(_) => {
                        let mut nested_map = Map::new();
                        convert_json_to_rhai_map(value, &mut nested_map);
                        map.insert(key.clone().into(), Dynamic::from(nested_map));
                    }
                    serde_json::Value::Null => {
                        map.insert(key.clone().into(), Dynamic::UNIT);
                    }
                }
            }
        }
        _ => {}
    }
}

/// 将 serde_json::Value 数组转换为 rhai::Array
fn convert_json_to_rhai_array(json: &serde_json::Value, array: &mut rhai::Array) {
    if let serde_json::Value::Array(arr) = json {
        for item in arr {
            match item {
                serde_json::Value::String(s) => {
                    array.push(Dynamic::from(s.clone()));
                }
                serde_json::Value::Number(n) => {
                    if n.is_i64() {
                        array.push(Dynamic::from(n.as_i64().unwrap_or(0)));
                    } else if n.is_u64() {
                        array.push(Dynamic::from(n.as_u64().unwrap_or(0) as i64));
                    } else if n.is_f64() {
                        array.push(Dynamic::from(n.as_f64().unwrap_or(0.0)));
                    }
                }
                serde_json::Value::Bool(b) => {
                    array.push(Dynamic::from(*b));
                }
                serde_json::Value::Object(_) => {
                    let mut nested_map = Map::new();
                    convert_json_to_rhai_map(item, &mut nested_map);
                    array.push(Dynamic::from(nested_map));
                }
                serde_json::Value::Array(_) => {
                    let mut nested_array = rhai::Array::new();
                    convert_json_to_rhai_array(item, &mut nested_array);
                    array.push(Dynamic::from(nested_array));
                }
                serde_json::Value::Null => {
                    array.push(Dynamic::UNIT);
                }
            }
        }
    }
}

/// 注册爬虫相关的 Rhai 函数
// 获取默认的图片目录（用于判断是否是用户指定的目录）
fn get_default_images_dir() -> PathBuf {
    get_app_data_dir().join("images")
}

pub fn register_crawler_functions(
    engine: &mut Engine,
    page_stack: &Arc<Mutex<Vec<(String, String)>>>,
    images_dir: &Path,
    app: &AppHandle,
    plugin_id: &str,
    task_id: &str,
    current_progress: Arc<Mutex<f64>>,
) -> Result<(), String> {
    let stack = Arc::clone(page_stack);

    // to(url) - 访问一个网页，将当前页面入栈
    engine.register_fn("to", {
        let stack = Arc::clone(&stack);
        move |url: &str| -> Result<(), String> {
            // 获取当前栈顶的 URL（用于解析相对 URL）
            let base_url = {
                let stack_guard = stack.lock().map_err(|e| format!("Lock error: {}", e))?;
                stack_guard
                    .last()
                    .map(|(url, _)| url.clone())
                    .unwrap_or_else(|| url.to_string())
            };

            // 解析 URL（可能是相对 URL）
            let resolved_url = if url.starts_with("http://") || url.starts_with("https://") {
                url.to_string()
            } else {
                let base = Url::parse(&base_url).map_err(|e| format!("Invalid base URL: {}", e))?;
                base.join(url)
                    .map_err(|e| format!("Failed to resolve URL: {}", e))?
                    .to_string()
            };

            // 获取 HTML
            // 在单独的线程中执行阻塞的 HTTP 请求，避免在 Tokio runtime 中创建新的 runtime
            let url_clone = resolved_url.clone();
            let (tx, rx) = mpsc::channel();
            std::thread::spawn(move || {
                let result = reqwest::blocking::Client::new()
                    .get(&url_clone)
                    .send()
                    .and_then(|r| r.text());
                let _ = tx.send(result);
            });
            let html = rx
                .recv()
                .map_err(|e| format!("Thread communication error: {}", e))?
                .map_err(|e| format!("Failed to fetch: {}", e))?;

            // 将当前页面推入栈（如果栈不为空，先保存当前页面）
            let mut stack_guard = stack.lock().map_err(|e| format!("Lock error: {}", e))?;
            stack_guard.push((resolved_url, html));
            Ok(())
        }
    });

    // to_json(url) - 访问一个 JSON API，返回 JSON 对象
    engine.register_fn("to_json", {
        let stack = Arc::clone(&stack);
        move |url: &str| -> Result<Map, String> {
            // 获取当前栈顶的 URL（用于解析相对 URL）
            let base_url = {
                let stack_guard = stack.lock().map_err(|e| format!("Lock error: {}", e))?;
                stack_guard
                    .last()
                    .map(|(url, _)| url.clone())
                    .unwrap_or_else(|| url.to_string())
            };

            // 解析 URL（可能是相对 URL）
            let resolved_url = if url.starts_with("http://") || url.starts_with("https://") {
                url.to_string()
            } else {
                let base = Url::parse(&base_url).map_err(|e| format!("Invalid base URL: {}", e))?;
                base.join(url)
                    .map_err(|e| format!("Failed to resolve URL: {}", e))?
                    .to_string()
            };

            // 获取 JSON 响应
            // 在单独的线程中执行阻塞的 HTTP 请求，避免在 Tokio runtime 中创建新的 runtime
            let url_clone = resolved_url.clone();
            let (tx, rx) = mpsc::channel();
            std::thread::spawn(move || {
                let result = reqwest::blocking::Client::new()
                    .get(&url_clone)
                    .send()
                    .and_then(|r| r.text());
                let _ = tx.send(result);
            });
            let text = rx
                .recv()
                .map_err(|e| format!("Thread communication error: {}", e))?
                .map_err(|e| format!("Failed to fetch: {}", e))?;
            let json_value = serde_json::from_str::<serde_json::Value>(&text)
                .map_err(|e| format!("Failed to parse JSON: {}", e))?;

            // 将当前页面推入栈（保存 URL 和 JSON 字符串表示）
            let json_string = serde_json::to_string(&json_value)
                .map_err(|e| format!("Failed to serialize JSON: {}", e))?;
            let mut stack_guard = stack.lock().map_err(|e| format!("Lock error: {}", e))?;
            stack_guard.push((resolved_url, json_string));

            // 将 JSON 值转换为 Rhai 类型
            match &json_value {
                serde_json::Value::Object(_) => {
                    // 如果是对象，转换为 Map
                    let mut map = Map::new();
                    convert_json_to_rhai_map(&json_value, &mut map);
                    Ok(map)
                }
                serde_json::Value::Array(_) => {
                    // 如果是数组，转换为 Array，然后包装在 Map 中
                    let mut array = rhai::Array::new();
                    convert_json_to_rhai_array(&json_value, &mut array);
                    let mut map = Map::new();
                    map.insert("data".into(), Dynamic::from(array));
                    Ok(map)
                }
                serde_json::Value::String(s) => {
                    let mut map = Map::new();
                    map.insert("data".into(), Dynamic::from(s.clone()));
                    Ok(map)
                }
                serde_json::Value::Number(n) => {
                    let mut map = Map::new();
                    let value = if n.is_i64() {
                        Dynamic::from(n.as_i64().unwrap_or(0))
                    } else if n.is_u64() {
                        Dynamic::from(n.as_u64().unwrap_or(0) as i64)
                    } else if n.is_f64() {
                        Dynamic::from(n.as_f64().unwrap_or(0.0))
                    } else {
                        Dynamic::UNIT
                    };
                    map.insert("data".into(), value);
                    Ok(map)
                }
                serde_json::Value::Bool(b) => {
                    let mut map = Map::new();
                    map.insert("data".into(), Dynamic::from(*b));
                    Ok(map)
                }
                serde_json::Value::Null => {
                    let mut map = Map::new();
                    map.insert("data".into(), Dynamic::UNIT);
                    Ok(map)
                }
            }
        }
    });

    // back() - 返回上一页，出栈
    engine.register_fn("back", {
        let stack = Arc::clone(&stack);
        move || -> Result<(), String> {
            let mut stack_guard = stack.lock().map_err(|e| format!("Lock error: {}", e))?;
            if stack_guard.is_empty() {
                return Err("Page stack is empty, cannot go back".to_string());
            }
            stack_guard.pop();
            Ok(())
        }
    });

    // current_url() - 获取当前栈顶的 URL
    engine.register_fn("current_url", {
        let stack = Arc::clone(&stack);
        move || -> Result<String, String> {
            let stack_guard = stack.lock().map_err(|e| format!("Lock error: {}", e))?;
            stack_guard
                .last()
                .map(|(url, _)| url.clone())
                .ok_or_else(|| "Page stack is empty".to_string())
        }
    });

    // current_html() - 获取当前栈顶的 HTML
    engine.register_fn("current_html", {
        let stack = Arc::clone(&stack);
        move || -> Result<String, String> {
            let stack_guard = stack.lock().map_err(|e| format!("Lock error: {}", e))?;
            stack_guard
                .last()
                .map(|(_, html)| html.clone())
                .ok_or_else(|| "Page stack is empty".to_string())
        }
    });

    // query(selector) - 在当前栈顶页面查询元素文本
    // 支持 CSS 选择器和 XPath（以 / 或 // 开头）
    engine.register_fn("query", {
        let stack = Arc::clone(&stack);
        move |selector: &str| -> Result<rhai::Array, String> {
            let html = {
                let stack_guard = stack.lock().map_err(|e| format!("Lock error: {}", e))?;
                stack_guard
                    .last()
                    .map(|(_, html)| html.clone())
                    .ok_or_else(|| "Page stack is empty, call to(url) first".to_string())?
            };

            let mut results = rhai::Array::new();

            // 判断是 XPath 还是 CSS 选择器
            let is_xpath = selector.starts_with("/")
                || selector.starts_with("//")
                || selector.contains("[@")
                || selector.contains("::");

            if is_xpath {
                // 使用 XPath（使用 select crate）
                let document = select::document::Document::from(html.as_str());

                // 简单的 XPath 实现
                if selector.starts_with("//") {
                    // //tag 格式：查找所有 tag 元素
                    let path_parts: Vec<&str> =
                        selector.trim_start_matches("//").split('/').collect();
                    if let Some(tag_name) = path_parts.first() {
                        let tag = tag_name.trim();
                        if !tag.is_empty() {
                            for node in document.find(select::predicate::Name(tag)) {
                                results.push(Dynamic::from(node.text()));
                            }
                        } else {
                            // // 表示所有元素
                            for node in document.find(select::predicate::Any) {
                                results.push(Dynamic::from(node.text()));
                            }
                        }
                    }
                } else if selector.starts_with("/") {
                    // /tag 格式：从根节点查找
                    let path_parts: Vec<&str> =
                        selector.trim_start_matches("/").split('/').collect();
                    if let Some(tag_name) = path_parts.first() {
                        let tag = tag_name.trim();
                        if !tag.is_empty() {
                            for node in document.find(select::predicate::Name(tag)) {
                                results.push(Dynamic::from(node.text()));
                            }
                        }
                    }
                } else {
                    // 其他 XPath 格式，尝试作为标签名处理
                    for node in document.find(select::predicate::Name(selector)) {
                        results.push(Dynamic::from(node.text()));
                    }
                }
            } else {
                // 使用 CSS 选择器
                let document = Html::parse_document(&html);
                let css_selector = Selector::parse(selector)
                    .map_err(|e| format!("Invalid CSS selector: {}", e))?;

                for element in document.select(&css_selector) {
                    let text = element.text().collect::<String>();
                    results.push(Dynamic::from(text));
                }
            }

            Ok(results)
        }
    });

    // query_by_text(text) - 通过文本内容查找包含该文本的元素，返回元素的文本和属性
    // 直接返回数组，出错时返回空数组
    engine.register_fn("query_by_text", {
        let stack = Arc::clone(&stack);
        move |text: &str| -> rhai::Array {
            let html = match stack.lock() {
                Ok(guard) => match guard.last() {
                    Some((_, html)) => html.clone(),
                    None => return rhai::Array::new(),
                },
                Err(_) => return rhai::Array::new(),
            };

            let mut results = rhai::Array::new();
            let document = Html::parse_document(&html);

            // 使用通用选择器查找所有元素
            let all_selector = match Selector::parse("*") {
                Ok(sel) => sel,
                Err(_) => return rhai::Array::new(),
            };

            for element in document.select(&all_selector) {
                // 获取元素的文本内容（只包含直接文本，不包括子元素）
                let element_text: String = element.text().collect();

                // 检查是否包含目标文本
                if element_text.contains(text) {
                    // 创建一个 Map 来存储元素信息
                    let mut element_info = Map::new();
                    element_info.insert("text".into(), Dynamic::from(element_text.clone()));

                    // 获取元素的标签名
                    let tag_name = element.value().name();
                    element_info.insert("tag".into(), Dynamic::from(tag_name.to_string()));

                    // 获取元素的所有属性
                    let mut attrs = Map::new();
                    for (attr_name, attr_value) in element.value().attrs() {
                        attrs.insert(
                            attr_name.to_string().into(),
                            Dynamic::from(attr_value.to_string()),
                        );
                    }
                    element_info.insert("attrs".into(), Dynamic::from(attrs));

                    // 尝试获取元素的 ID 或 class（如果存在）
                    if let Some(id) = element.value().attr("id") {
                        element_info.insert("id".into(), Dynamic::from(id.to_string()));
                    }
                    if let Some(class) = element.value().attr("class") {
                        element_info.insert("class".into(), Dynamic::from(class.to_string()));
                    }

                    results.push(Dynamic::from(element_info));
                }
            }

            results
        }
    });

    // find_by_text(text, tag) - 在指定标签中查找包含该文本的元素，返回元素的文本
    engine.register_fn("find_by_text", {
        let stack = Arc::clone(&stack);
        move |text: &str, tag: &str| -> Result<rhai::Array, String> {
            let html = {
                let stack_guard = stack.lock().map_err(|e| format!("Lock error: {}", e))?;
                stack_guard
                    .last()
                    .map(|(_, html)| html.clone())
                    .ok_or_else(|| "Page stack is empty, call to(url) first".to_string())?
            };

            let mut results = rhai::Array::new();
            let document = Html::parse_document(&html);

            // 使用 CSS 选择器查找指定标签
            let selector_str = format!("{}", tag);
            let selector = Selector::parse(&selector_str)
                .map_err(|e| format!("Invalid tag selector: {}", e))?;

            for element in document.select(&selector) {
                let element_text: String = element.text().collect();
                if element_text.contains(text) {
                    results.push(Dynamic::from(element_text));
                }
            }

            Ok(results)
        }
    });

    // get_attr(selector, attr) - 在当前栈顶页面获取元素属性
    // 支持 CSS 选择器和 XPath（以 / 或 // 开头）
    // 直接返回数组，出错时返回空数组
    engine.register_fn("get_attr", {
        let stack = Arc::clone(&stack);
        move |selector: &str, attr: &str| -> rhai::Array {
            let html = match stack.lock() {
                Ok(guard) => match guard.last() {
                    Some((_, html)) => html.clone(),
                    None => return rhai::Array::new(),
                },
                Err(_) => return rhai::Array::new(),
            };

            let mut results = rhai::Array::new();

            // 判断是 XPath 还是 CSS 选择器
            let is_xpath = selector.starts_with("/")
                || selector.starts_with("//")
                || selector.contains("[@")
                || selector.contains("::");

            if is_xpath {
                // 使用 XPath（使用 select crate）
                let document = select::document::Document::from(html.as_str());

                // 简单的 XPath 实现
                if selector.starts_with("//") {
                    // //tag 格式：查找所有 tag 元素
                    let path_parts: Vec<&str> =
                        selector.trim_start_matches("//").split('/').collect();
                    if let Some(tag_name) = path_parts.first() {
                        let tag = tag_name.trim();
                        if !tag.is_empty() {
                            for node in document.find(select::predicate::Name(tag)) {
                                if let Some(value) = node.attr(attr) {
                                    results.push(Dynamic::from(value.to_string()));
                                }
                            }
                        } else {
                            // // 表示所有元素
                            for node in document.find(select::predicate::Any) {
                                if let Some(value) = node.attr(attr) {
                                    results.push(Dynamic::from(value.to_string()));
                                }
                            }
                        }
                    }
                } else if selector.starts_with("/") {
                    // /tag 格式：从根节点查找
                    let path_parts: Vec<&str> =
                        selector.trim_start_matches("/").split('/').collect();
                    if let Some(tag_name) = path_parts.first() {
                        let tag = tag_name.trim();
                        if !tag.is_empty() {
                            for node in document.find(select::predicate::Name(tag)) {
                                if let Some(value) = node.attr(attr) {
                                    results.push(Dynamic::from(value.to_string()));
                                }
                            }
                        }
                    }
                } else {
                    // 其他 XPath 格式，尝试作为标签名处理
                    for node in document.find(select::predicate::Name(selector)) {
                        if let Some(value) = node.attr(attr) {
                            results.push(Dynamic::from(value.to_string()));
                        }
                    }
                }
            } else {
                // 使用 CSS 选择器
                let document = Html::parse_document(&html);
                if let Ok(css_selector) = Selector::parse(selector) {
                    for element in document.select(&css_selector) {
                        if let Some(value) = element.value().attr(attr) {
                            results.push(Dynamic::from(value.to_string()));
                        }
                    }
                }
            }

            results
        }
    });

    // resolve_url(relative) - 解析相对 URL 为绝对 URL（基于当前栈顶 URL）
    // 直接返回 String，出错时返回原始 URL
    engine.register_fn("resolve_url", {
        let stack = Arc::clone(&stack);
        move |relative: &str| -> String {
            let base_url = match stack.lock() {
                Ok(guard) => match guard.last() {
                    Some((url, _)) => url.clone(),
                    None => return relative.to_string(),
                },
                Err(_) => return relative.to_string(),
            };

            match Url::parse(&base_url) {
                Ok(base) => match base.join(relative) {
                    Ok(resolved) => resolved.to_string(),
                    Err(_) => relative.to_string(),
                },
                Err(_) => relative.to_string(),
            }
        }
    });

    // is_image_url(url) - 检查是否是图片 URL
    engine.register_fn("is_image_url", |url: &str| -> bool {
        let url_lower = url.to_lowercase();
        url_lower.ends_with(".jpg")
            || url_lower.ends_with(".jpeg")
            || url_lower.ends_with(".png")
            || url_lower.ends_with(".gif")
            || url_lower.ends_with(".webp")
            || url_lower.contains("image")
            || url_lower.contains("img")
    });

    // list_local_files(folder_url, extensions) - 列出本地文件夹内的文件（非递归）
    engine.register_fn(
        "list_local_files",
        |folder_url: &str,
         extensions: rhai::Array|
         -> Result<rhai::Array, Box<rhai::EvalAltResult>> {
            // 解析文件夹路径
            let folder_path_str = if folder_url.starts_with("file:///") {
                &folder_url[8..]
            } else if folder_url.starts_with("file://") {
                &folder_url[7..]
            } else {
                folder_url
            };

            // 检查路径是否为空
            if folder_path_str.is_empty() {
                return Err(format!("Empty folder path. Original URL: {}", folder_url).into());
            }

            // 处理 Windows 路径分隔符
            // 先统一处理：将正斜杠替换为反斜杠（Windows 标准）
            // 如果路径中已经有反斜杠，它们会保持不变
            #[cfg(windows)]
            let folder_path_str = folder_path_str.replace("/", "\\");
            #[cfg(not(windows))]
            let folder_path_str = folder_path_str;

            let folder_path = PathBuf::from(&folder_path_str);

            // 检查文件夹是否存在
            if !folder_path.exists() {
                return Err(format!(
                    "Folder does not exist: {} (original URL: {}, parsed path: {})",
                    folder_path.display(),
                    folder_url,
                    folder_path_str
                )
                .into());
            }

            if !folder_path.is_dir() {
                return Err(format!("Path is not a directory: {}", folder_path.display()).into());
            }

            // 读取文件夹内容（非递归）
            let entries = fs::read_dir(&folder_path)
                .map_err(|e| format!("Failed to read directory: {}", e))?;

            let mut file_list = rhai::Array::new();
            let extensions_set: std::collections::HashSet<String> = extensions
                .into_iter()
                .map(|ext| {
                    let ext_str = ext.to_string().to_lowercase();
                    // 确保扩展名包含点号
                    if ext_str.starts_with(".") {
                        ext_str
                    } else {
                        format!(".{}", ext_str)
                    }
                })
                .collect();

            for entry in entries {
                let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
                let path = entry.path();

                // 只处理文件，不处理目录
                if path.is_file() {
                    // 检查文件扩展名
                    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                        let ext_with_dot = format!(".{}", ext.to_lowercase());
                        if extensions_set.contains(&ext_with_dot) {
                            // 返回文件的完整路径（使用 file:// 协议）
                            let file_path_str = path.to_string_lossy().replace("\\", "/");
                            let file_url = format!("file:///{}", file_path_str);
                            file_list.push(Dynamic::from(file_url));
                        }
                    }
                }
            }

            Ok(file_list)
        },
    );

    // add_progress(percentage) - 增加任务运行进度（单位为%，累加）
    let app_handle = app.clone();
    let task_id_str = task_id.to_string();
    let progress_guard = Arc::clone(&current_progress);
    engine.register_fn(
        "add_progress",
        move |percentage: f64| -> Result<(), String> {
            let task_id = task_id_str.clone();
            let app_handle = app_handle.clone();
            let progress_guard = Arc::clone(&progress_guard);

            // 若任务已被取消，直接让脚本失败退出
            let dq = app_handle.state::<DownloadQueue>();
            if dq.is_task_canceled(&task_id) {
                return Err("Task canceled".to_string());
            }

            // 累加进度值
            let mut current = progress_guard
                .lock()
                .map_err(|e| format!("Lock error: {}", e))?;
            *current += percentage;

            // 限制最大值为 99.9%（100% 由任务完成时自动设置）
            if *current > 99.9 {
                *current = 99.9;
            }

            // 确保进度不为负数
            if *current < 0.0 {
                *current = 0.0;
            }

            let final_progress = *current;

            // 通过事件发送进度更新
            app_handle
                .emit(
                    "task-progress",
                    serde_json::json!({
                        "taskId": task_id,
                        "progress": final_progress
                    }),
                )
                .map_err(|e| format!("Failed to emit progress event: {}", e))?;

            Ok(())
        },
    );

    // download_image(url) - 下载图片并添加到 gallery（通过下载队列）
    let images_dir = images_dir.to_path_buf();
    let app_handle = app.clone();
    let plugin_id = plugin_id.to_string();
    let task_id_for_download = task_id.to_string();
    engine.register_fn(
        "download_image",
        move |url: &str| -> Result<bool, Box<rhai::EvalAltResult>> {
            // 如果任务已被取消，让脚本失败退出
            let dq = app_handle.state::<DownloadQueue>();
            if dq.is_task_canceled(&task_id_for_download) {
                return Err("Task canceled".into());
            }

            let images_dir = images_dir.clone();
            let app_handle = app_handle.clone();
            let plugin_id = plugin_id.clone();
            let task_id = task_id_for_download.clone();

            // 预检查：如果是本地文件且数据库已有相同哈希（且文件/缩略图都存在），则无需入队
            // 注意：HTTP/HTTPS 无法在不下载内容的情况下计算 hash，因此仍走队列流程
            let is_local_path = url.starts_with("file://")
                || (!url.starts_with("http://")
                    && !url.starts_with("https://")
                    && std::path::Path::new(url).exists());
            if is_local_path {
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
                    std::path::PathBuf::from(path_str)
                } else {
                    std::path::PathBuf::from(url)
                };

                if let Ok(source_path) = source_path.canonicalize() {
                    if source_path.exists() {
                        if let Ok(hash) = compute_file_hash(&source_path) {
                            let storage = app_handle.state::<crate::storage::Storage>();
                            if let Ok(Some(existing)) = storage.find_image_by_hash(&hash) {
                                let existing_path = std::path::PathBuf::from(&existing.local_path);
                                let thumb = if existing.thumbnail_path.is_empty() {
                                    None
                                } else {
                                    Some(std::path::PathBuf::from(&existing.thumbnail_path))
                                };
                                if existing_path.exists()
                                    && thumb.as_ref().map(|p| p.exists()).unwrap_or(true)
                                {
                                    return Ok(true);
                                }
                            }
                        }
                    }
                }
            }

            // 记录下载开始时间
            let download_start_time = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs();

            // 将任务添加到下载队列
            let download_queue = app_handle.state::<DownloadQueue>();
            match download_queue.enqueue(
                url.to_string(),
                images_dir,
                plugin_id,
                task_id,
                download_start_time,
            ) {
                Ok(_) => Ok(true), // 成功加入队列
                Err(e) => Err(format!("Failed to enqueue download: {}", e).into()),
            }
        },
    );

    Ok(())
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

        let max_attempts = retry_count.saturating_add(1).max(1);
        let mut attempt: u32 = 0;
        let content = loop {
            attempt += 1;

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

            match response.bytes().await {
                Ok(b) => break b,
                Err(e) => {
                    if attempt < max_attempts {
                        let backoff_ms = (500u64)
                            .saturating_mul(2u64.saturating_pow((attempt - 1) as u32))
                            .min(5000);
                        tokio::time::sleep(std::time::Duration::from_millis(backoff_ms)).await;
                        continue;
                    }
                    return Err(format!("Failed to read image: {}", e));
                }
            }
        };

        let content_hash = compute_bytes_hash(&content);

        // 若已有相同哈希且文件存在，复用
        let storage = app.state::<crate::storage::Storage>();
        if let Ok(Some(existing)) = storage.find_image_by_hash(&content_hash) {
            let existing_path = PathBuf::from(&existing.local_path);
            if existing_path.exists() {
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

        // 从 URL 获取文件名
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

        let mut file =
            fs::File::create(&file_path).map_err(|e| format!("Failed to create file: {}", e))?;
        file.write_all(&content)
            .map_err(|e| format!("Failed to write file: {}", e))?;

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

// 获取应用数据目录的辅助函数
fn get_app_data_dir() -> PathBuf {
    dirs::data_local_dir()
        .or_else(|| dirs::data_dir())
        .expect("Failed to get app data directory")
        .join("Kabegami Crawler")
}

fn generate_thumbnail(image_path: &Path, _app: &AppHandle) -> Result<Option<PathBuf>, String> {
    let app_data_dir = get_app_data_dir();
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
}

// 下载队列管理器
pub struct DownloadQueue {
    app: AppHandle,
    queue: Arc<Mutex<VecDeque<DownloadTask>>>,
    active_downloads: Arc<Mutex<u32>>,
    active_tasks: Arc<Mutex<Vec<ActiveDownloadInfo>>>,
    canceled_tasks: Arc<Mutex<HashSet<String>>>,
}

impl DownloadQueue {
    pub fn new(app: AppHandle) -> Self {
        let queue = Self {
            app,
            queue: Arc::new(Mutex::new(VecDeque::new())),
            active_downloads: Arc::new(Mutex::new(0)),
            active_tasks: Arc::new(Mutex::new(Vec::new())),
            canceled_tasks: Arc::new(Mutex::new(HashSet::new())),
        };

        // 启动队列处理任务
        queue.start_processor();

        queue
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

    // 添加下载任务到队列
    pub fn enqueue(
        &self,
        url: String,
        images_dir: PathBuf,
        plugin_id: String,
        task_id: String,
        download_start_time: u64,
    ) -> Result<(), String> {
        if self.is_task_canceled(&task_id) {
            return Ok(());
        }
        let task = DownloadTask {
            url,
            images_dir,
            plugin_id,
            task_id,
            download_start_time,
        };

        let mut queue = self
            .queue
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;
        queue.push_back(task);
        Ok(())
    }

    // 取消任务：移除队列中该任务，并标记为取消，正在下载的任务在保存阶段会被跳过
    pub fn cancel_task(&self, task_id: &str) -> Result<(), String> {
        // 仅标记为取消，不清空队列或活跃下载，让已在队列/运行中的任务继续或自行完成。
        let mut canceled = self
            .canceled_tasks
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;
        canceled.insert(task_id.to_string());
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
                    let task = {
                        let mut queue_guard = queue.lock().unwrap();
                        queue_guard.pop_front()
                    };

                    if let Some(task) = task {
                        // 增加活跃下载数
                        {
                            let mut active = active_downloads.lock().unwrap();
                            *active += 1;
                        }

                        // 添加到活跃任务列表
                        let download_info = ActiveDownloadInfo {
                            url: task.url.clone(),
                            plugin_id: task.plugin_id.clone(),
                            start_time: task.download_start_time,
                            task_id: task.task_id.clone(),
                        };
                        {
                            let mut tasks = active_tasks.lock().unwrap();
                            tasks.push(download_info.clone());
                        }

                        // 启动下载任务
                        let active_clone = Arc::clone(&active_downloads);
                        let active_tasks_clone = Arc::clone(&active_tasks);
                        let app_clone = app.clone();
                        let task_clone = task.clone();
                        let _canceled_clone = Arc::clone(&canceled_tasks);

                        tauri::async_runtime::spawn(async move {
                            let client = reqwest::Client::new();
                            let result = download_image(
                                &client,
                                &task_clone.url,
                                &task_clone.images_dir,
                                &task_clone.plugin_id,
                                &app_clone,
                            )
                            .await;

                            // 从活跃任务列表中移除
                            {
                                let mut tasks = active_tasks_clone.lock().unwrap();
                                tasks.retain(|t| {
                                    t.url != task_clone.url
                                        || t.start_time != task_clone.download_start_time
                                });
                            }

                            // 减少活跃下载数
                            {
                                let mut active = active_clone.lock().unwrap();
                                *active -= 1;
                            }

                            // 如果下载成功，保存到 gallery
                            if let Ok(downloaded) = result {
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
                                    let image_info = crate::storage::ImageInfo {
                                        id: uuid::Uuid::new_v4().to_string(),
                                        url: task_clone.url.clone(),
                                        local_path: local_path_str,
                                        plugin_id: task_clone.plugin_id.clone(),
                                        task_id: Some(task_clone.task_id.clone()),
                                        crawled_at: task_clone.download_start_time,
                                        metadata: None,
                                        thumbnail_path: thumbnail_path_str.clone(),
                                        favorite: false,
                                        hash: downloaded.hash.clone(),
                                    };
                                    if storage.add_image(image_info.clone()).is_ok() {
                                        should_emit = true;
                                        emitted_image_id = Some(image_info.id);
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
                                }
                            }
                        });
                    }
                }
            }
        });
    }
}
