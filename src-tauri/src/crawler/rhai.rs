use crate::plugin::Plugin;
use rhai::{Dynamic, Engine, Map, Scope};
use scraper::{Html, Selector};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};
use url::Url;

/// 注册爬虫相关的 Rhai 函数
pub fn register_crawler_functions(
    engine: &mut Engine,
    page_stack: &Arc<Mutex<Vec<(String, String)>>>,
    images_dir: &Path,
    app: &AppHandle,
    plugin_id: &str,
    task_id: &str,
    current_progress: Arc<Mutex<f64>>,
    output_album_id: Option<String>,
) -> Result<(), String> {
    let stack = Arc::clone(page_stack);

    // re_is_match(pattern, text) - 正则匹配判断（pattern 使用 Rust regex 语法）
    // 注意：pattern 编译失败时返回 false
    engine.register_fn("re_is_match", |pattern: &str, text: &str| -> bool {
        regex::Regex::new(pattern)
            .map(|re| re.is_match(text))
            .unwrap_or(false)
    });

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
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let result = match crate::crawler::create_blocking_client() {
                    Ok(client) => client.get(&url_clone).send().and_then(|r| r.text()),
                    Err(e) => {
                        eprintln!("Failed to create HTTP client with proxy: {}", e);
                        // 创建一个模拟的网络错误
                        let err = reqwest::blocking::get("http://invalid-url-that-will-fail")
                            .unwrap_err();
                        Err(err)
                    }
                };
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
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let result = match crate::crawler::create_blocking_client() {
                    Ok(client) => client.get(&url_clone).send().and_then(|r| r.text()),
                    Err(e) => {
                        eprintln!("Failed to create HTTP client with proxy: {}", e);
                        // 创建一个模拟的网络错误
                        let err = reqwest::blocking::get("http://invalid-url-that-will-fail")
                            .unwrap_err();
                        Err(err)
                    }
                };
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

    // 辅助函数：递归扫描目录
    fn scan_directory_recursive(
        dir: &std::path::Path,
        extensions: &std::collections::HashSet<String>,
        file_list: &mut rhai::Array,
    ) -> Result<(), Box<rhai::EvalAltResult>> {
        let entries =
            std::fs::read_dir(dir).map_err(|e| format!("Failed to read directory: {}", e))?;

        for entry in entries {
            let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
            let path = entry.path();

            if path.is_file() {
                // 检查文件扩展名
                if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                    let ext_with_dot = format!(".{}", ext.to_lowercase());
                    if extensions.contains(&ext_with_dot) {
                        // 返回文件的完整路径（使用 file:// 协议）
                        let file_path_str = path.to_string_lossy().replace("\\", "/");
                        let file_url = format!("file:///{}", file_path_str);
                        file_list.push(Dynamic::from(file_url));
                    }
                }
            } else if path.is_dir() {
                // 递归处理子目录
                scan_directory_recursive(&path, extensions, file_list)?;
            }
        }

        Ok(())
    }

    // list_local_files(folder_url, extensions, recursive) - 列出本地文件夹内的文件
    // recursive 为可选参数，默认为 false（非递归）
    engine.register_fn(
        "list_local_files",
        |folder_url: &str,
         extensions: rhai::Array,
         recursive: bool|
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

            let folder_path = std::path::PathBuf::from(&folder_path_str);

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

            // 递归或非递归扫描
            if recursive {
                scan_directory_recursive(&folder_path, &extensions_set, &mut file_list)?;
            } else {
                // 非递归扫描：只读取当前文件夹
                let entries = std::fs::read_dir(&folder_path)
                    .map_err(|e| format!("Failed to read directory: {}", e))?;

                for entry in entries {
                    let entry =
                        entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
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
            let dq = app_handle.state::<crate::crawler::DownloadQueue>();
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

    // download_image(url) - 同步下载图片并添加到 gallery（等待窗口有空位后直接执行）
    let images_dir = images_dir.to_path_buf();
    let app_handle = app.clone();
    let plugin_id = plugin_id.to_string();
    let task_id_for_download = task_id.to_string();
    let output_album_id_for_download = output_album_id.clone();
    engine.register_fn(
        "download_image",
        move |url: &str| -> Result<bool, Box<rhai::EvalAltResult>> {
            // 如果任务已被取消，让脚本失败退出
            let dq = app_handle.state::<crate::crawler::DownloadQueue>();
            if dq.is_task_canceled(&task_id_for_download) {
                return Err("Task canceled".into());
            }

            let images_dir = images_dir.clone();
            let app_handle = app_handle.clone();
            let plugin_id = plugin_id.clone();
            let task_id = task_id_for_download.clone();

            // 预检查：如果是本地文件且数据库已有相同路径，则检查缩略图并补全（如果需要），无需下载
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

                if let Ok(canonical_source_path) = source_path.canonicalize() {
                    if canonical_source_path.exists() {
                        let storage = app_handle.state::<crate::storage::Storage>();
                        // 规范化路径并移除 Windows 长路径前缀，确保与数据库中的格式一致
                        let source_path_str = canonical_source_path
                            .to_string_lossy()
                            .trim_start_matches("\\\\?\\")
                            .to_string();

                        // 检查数据库中是否有相同路径（规范化后的路径）
                        if let Ok(Some(existing)) = storage.find_image_by_path(&source_path_str) {
                            let existing_path = std::path::PathBuf::from(&existing.local_path);
                            let thumb_path = if existing.thumbnail_path.trim().is_empty() {
                                existing_path.clone()
                            } else {
                                std::path::PathBuf::from(&existing.thumbnail_path)
                            };

                            // 检查缩略图是否存在，不存在则补全
                            if !thumb_path.exists() {
                                // 尝试生成缩略图
                                if let Ok(Some(gen_thumb)) =
                                    crate::crawler::generate_thumbnail(&existing_path, &app_handle)
                                {
                                    // 更新数据库中的缩略图路径
                                    let _ = storage.update_image_thumbnail_path(
                                        &existing.id,
                                        &gen_thumb
                                            .to_string_lossy()
                                            .trim_start_matches("\\\\?\\")
                                            .to_string(),
                                    );
                                }
                            }

                            // 文件已存在，无需下载
                            return Ok(true);
                        }
                        // 数据库中没有相同路径，继续下载
                    }
                }
            }

            // 检查任务图片数量限制（最多10000张）
            const MAX_TASK_IMAGES: usize = 10000;
            let storage = app_handle.state::<crate::storage::Storage>();
            match storage.get_task_image_ids(&task_id) {
                Ok(image_ids) => {
                    if image_ids.len() >= MAX_TASK_IMAGES {
                        return Err(format!(
                            "任务图片数量已达到上限（{} 张），无法继续爬取",
                            MAX_TASK_IMAGES
                        ).into());
                    }
                }
                Err(e) => {
                    return Err(format!("检查任务图片数量失败: {}", e).into());
                }
            }

            // 记录下载开始时间（使用毫秒以支持更精确的时间控制）
            let download_start_time = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64;

            // 同步下载图片（等待窗口有空位后直接执行）
            let download_queue = app_handle.state::<crate::crawler::DownloadQueue>();
            match download_queue.download_image(
                url.to_string(),
                images_dir,
                plugin_id,
                task_id,
                download_start_time,
                output_album_id_for_download.clone(),
            ) {
                Ok(_) => Ok(true), // 下载成功
                Err(e) => Err(format!("Failed to download image: {}", e).into()),
            }
        },
    );

    Ok(())
}

/// 执行 Rhai 爬虫脚本
pub fn execute_crawler_script(
    _plugin: &Plugin,
    images_dir: &Path,
    app: &AppHandle,
    plugin_id: &str,
    task_id: &str,
    script_content: &str,
    merged_config: HashMap<String, serde_json::Value>,
    output_album_id: Option<String>, // 输出画册ID，如果指定则下载完成后自动添加到画册
) -> Result<(), String> {
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
        &plugin_id,
        task_id,
        Arc::clone(&current_progress),
        output_album_id,
    )?;

    // 创建作用域
    let mut scope = Scope::new();

    // 注入变量到脚本作用域：
    // Rhai 的函数体默认不能捕获/读取 Scope 里的"普通变量"，但可以读取常量。
    // 因此这里统一用 push_constant，避免脚本在 fn 内访问不到 start_page/max_pages 等变量。
    for (key, value) in merged_config {
        // 根据值的类型转换为 Rhai 类型
        match value {
            serde_json::Value::Number(n) => {
                if n.is_i64() {
                    scope.push_constant(key.clone(), n.as_i64().unwrap_or(0));
                } else if n.is_u64() {
                    scope.push_constant(key.clone(), n.as_u64().unwrap_or(0) as i64);
                } else if n.is_f64() {
                    scope.push_constant(key.clone(), n.as_f64().unwrap_or(0.0));
                }
            }
            serde_json::Value::String(s) => {
                scope.push_constant(key.clone(), s);
            }
            serde_json::Value::Bool(b) => {
                scope.push_constant(key.clone(), b);
            }
            serde_json::Value::Object(_) => {
                // 将 JSON 对象转换为 Rhai Map（支持脚本中使用 foo.a/foo.b）
                let mut map = Map::new();
                convert_json_to_rhai_map(&value, &mut map);
                scope.push_constant(key.clone(), map);
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
                scope.push_constant(key.clone(), rhai_array);
            }
            serde_json::Value::Null => {
                // 跳过 null 值，不注入到 scope（避免脚本读到 () 类型导致函数调用失败）
                // 脚本可以通过 try-catch 检测变量是否存在
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

    Ok(())
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
