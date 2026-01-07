use crate::crawler;
use crate::plugin::{PluginConfig, PluginManifest, VarDefinition, VarOption};
use image::imageops::FilterType;
use image::GenericImageView;
use rhai::{Engine, Scope};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorMarker {
    pub message: String,
    /// Monaco MarkerSeverity: 1=Hint,2=Info,4=Warning,8=Error
    pub severity: i32,
    pub start_line_number: i32,
    pub start_column: i32,
    pub end_line_number: i32,
    pub end_column: i32,
}

fn err_to_marker(message: String, line: i32, col: i32) -> EditorMarker {
    EditorMarker {
        message,
        severity: 8,
        start_line_number: line.max(1),
        start_column: col.max(1),
        end_line_number: line.max(1),
        end_column: (col + 1).max(1),
    }
}

#[tauri::command]
pub fn plugin_editor_check_rhai(script: String) -> Result<Vec<EditorMarker>, String> {
    let engine = Engine::new();
    match engine.compile(&script) {
        Ok(_) => Ok(vec![]),
        Err(e) => {
            let pos = e.position();
            Ok(vec![err_to_marker(
                format!("{}", e),
                pos.line().unwrap_or(1) as i32,
                pos.position().unwrap_or(1) as i32,
            )])
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginEditorTestResult {
    pub logs: Vec<String>,
    pub downloaded_urls: Vec<String>,
}

fn convert_json_to_rhai_map(json: &serde_json::Value, map: &mut rhai::Map) {
    match json {
        serde_json::Value::Object(obj) => {
            for (key, value) in obj {
                match value {
                    serde_json::Value::String(s) => {
                        map.insert(key.clone().into(), rhai::Dynamic::from(s.clone()));
                    }
                    serde_json::Value::Number(n) => {
                        if n.is_i64() {
                            map.insert(
                                key.clone().into(),
                                rhai::Dynamic::from(n.as_i64().unwrap_or(0)),
                            );
                        } else if n.is_u64() {
                            map.insert(
                                key.clone().into(),
                                rhai::Dynamic::from(n.as_u64().unwrap_or(0) as i64),
                            );
                        } else if n.is_f64() {
                            map.insert(
                                key.clone().into(),
                                rhai::Dynamic::from(n.as_f64().unwrap_or(0.0)),
                            );
                        }
                    }
                    serde_json::Value::Bool(b) => {
                        map.insert(key.clone().into(), rhai::Dynamic::from(*b));
                    }
                    serde_json::Value::Array(arr) => {
                        let mut rhai_array = rhai::Array::new();
                        for item in arr {
                            match item {
                                serde_json::Value::String(s) => {
                                    rhai_array.push(rhai::Dynamic::from(s.clone()));
                                }
                                serde_json::Value::Number(n) => {
                                    if n.is_i64() {
                                        rhai_array
                                            .push(rhai::Dynamic::from(n.as_i64().unwrap_or(0)));
                                    } else if n.is_u64() {
                                        rhai_array.push(rhai::Dynamic::from(
                                            n.as_u64().unwrap_or(0) as i64,
                                        ));
                                    } else if n.is_f64() {
                                        rhai_array
                                            .push(rhai::Dynamic::from(n.as_f64().unwrap_or(0.0)));
                                    }
                                }
                                serde_json::Value::Bool(b) => {
                                    rhai_array.push(rhai::Dynamic::from(*b));
                                }
                                serde_json::Value::Object(_) => {
                                    let mut nested_map = rhai::Map::new();
                                    convert_json_to_rhai_map(item, &mut nested_map);
                                    rhai_array.push(rhai::Dynamic::from(nested_map));
                                }
                                _ => {
                                    rhai_array.push(rhai::Dynamic::from(item.to_string()));
                                }
                            }
                        }
                        map.insert(key.clone().into(), rhai::Dynamic::from(rhai_array));
                    }
                    serde_json::Value::Object(_) => {
                        let mut nested_map = rhai::Map::new();
                        convert_json_to_rhai_map(value, &mut nested_map);
                        map.insert(key.clone().into(), rhai::Dynamic::from(nested_map));
                    }
                    serde_json::Value::Null => {
                        // skip
                    }
                }
            }
        }
        _ => {}
    }
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
                _ => {}
            }
            serde_json::Value::Object(obj)
        }
        _ => value.unwrap_or(serde_json::Value::Null),
    }
}

fn build_effective_user_config(
    var_defs: &[VarDefinition],
    user_config: Option<HashMap<String, serde_json::Value>>,
) -> HashMap<String, serde_json::Value> {
    let user_cfg = user_config.unwrap_or_default();
    let mut merged: HashMap<String, serde_json::Value> = HashMap::new();

    for def in var_defs {
        let user_value = user_cfg.get(&def.key).cloned();
        let default_value = def.default.clone();
        let normalized = normalize_var_value(def, user_value.or(default_value));
        merged.insert(def.key.clone(), normalized);
    }

    for (k, v) in user_cfg {
        if !merged.contains_key(&k) {
            merged.insert(k, v);
        }
    }

    merged
}

#[tauri::command]
pub fn plugin_editor_test_rhai(
    script: String,
    var_defs: Vec<VarDefinition>,
    user_config: Option<HashMap<String, serde_json::Value>>,
    app: tauri::AppHandle,
) -> Result<PluginEditorTestResult, String> {
    let merged = build_effective_user_config(&var_defs, user_config);

    // 复用现有 crawler API（允许真实网络请求），但把 download_image 改成“收集 URL”
    let page_stack: Arc<Mutex<Vec<(String, String)>>> = Arc::new(Mutex::new(Vec::new()));
    let current_progress: Arc<Mutex<f64>> = Arc::new(Mutex::new(0.0));
    let downloaded: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let logs: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));

    let images_dir: PathBuf = std::env::temp_dir().join("kabegame-plugin-editor");
    let _ = std::fs::create_dir_all(&images_dir);

    let mut engine = Engine::new();

    // capture print()
    {
        let logs = Arc::clone(&logs);
        engine.on_print(move |s| {
            if let Ok(mut g) = logs.lock() {
                g.push(s.to_string());
            }
        });
    }

    crawler::rhai::register_crawler_functions(
        &mut engine,
        &page_stack,
        &images_dir,
        &app,
        "plugin-editor",
        "plugin_editor_test",
        Arc::clone(&current_progress),
        None,
    )?;

    // 覆盖 download_image：仅记录，不下载
    {
        let downloaded = Arc::clone(&downloaded);
        engine.register_fn("download_image", move |url: &str| -> bool {
            if let Ok(mut g) = downloaded.lock() {
                g.push(url.to_string());
            }
            true
        });
    }

    // 覆盖 add_progress：忽略
    engine.register_fn("add_progress", |_p: f64| -> () {});

    // 注入变量（与现有执行逻辑一致：push_constant）
    let mut scope = Scope::new();
    for (key, value) in merged {
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
                let mut map = rhai::Map::new();
                convert_json_to_rhai_map(&value, &mut map);
                scope.push_constant(key.clone(), map);
            }
            serde_json::Value::Array(arr) => {
                let mut rhai_array = rhai::Array::new();
                for item in arr {
                    match item {
                        serde_json::Value::String(s) => rhai_array.push(rhai::Dynamic::from(s)),
                        serde_json::Value::Number(n) => {
                            if n.is_i64() {
                                rhai_array.push(rhai::Dynamic::from(n.as_i64().unwrap_or(0)));
                            } else if n.is_u64() {
                                rhai_array
                                    .push(rhai::Dynamic::from(n.as_u64().unwrap_or(0) as i64));
                            } else if n.is_f64() {
                                rhai_array.push(rhai::Dynamic::from(n.as_f64().unwrap_or(0.0)));
                            }
                        }
                        serde_json::Value::Bool(b) => rhai_array.push(rhai::Dynamic::from(b)),
                        _ => rhai_array.push(rhai::Dynamic::from(item.to_string())),
                    }
                }
                scope.push_constant(key.clone(), rhai_array);
            }
            serde_json::Value::Null => {}
        }
    }

    let _ = engine
        .eval_with_scope::<rhai::Dynamic>(&mut scope, &script)
        .map_err(|e| format!("Script execution error: {}", e))?;

    let logs = logs.lock().map(|g| g.clone()).unwrap_or_default();
    let downloaded_urls = downloaded.lock().map(|g| g.clone()).unwrap_or_default();

    Ok(PluginEditorTestResult {
        logs,
        downloaded_urls,
    })
}

/// 处理用户选择的图片，转换为 kgpg v2 icon 格式（128x128 RGB24）
/// 返回 base64 编码的 RGB24 数据
#[tauri::command]
pub fn plugin_editor_process_icon(image_path: String) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    let path = PathBuf::from(&image_path);
    if !path.exists() {
        return Err(format!("图片文件不存在: {}", image_path));
    }

    // 读取图片
    let img = image::open(&path).map_err(|e| format!("无法读取图片: {}", e))?;

    // 缩放到 128x128（保持比例，居中裁剪）
    let (w, h) = img.dimensions();
    let target_size = 128u32;

    // 计算裁剪区域（居中裁剪为正方形）
    let crop_size = w.min(h);
    let crop_x = (w - crop_size) / 2;
    let crop_y = (h - crop_size) / 2;

    // 裁剪并缩放
    let cropped = img.crop_imm(crop_x, crop_y, crop_size, crop_size);
    let resized = cropped.resize_exact(target_size, target_size, FilterType::Lanczos3);

    // 转换为 RGB24（无 alpha）
    let rgb_img = resized.to_rgb8();
    let rgb_bytes = rgb_img.into_raw();

    // 返回 base64 编码
    Ok(STANDARD.encode(&rgb_bytes))
}

#[tauri::command]
pub fn plugin_editor_export_kgpg(
    output_path: String,
    plugin_id: String,
    manifest: PluginManifest,
    config: PluginConfig,
    script: String,
    icon_rgb_base64: Option<String>,
) -> Result<(), String> {
    let path = PathBuf::from(output_path);

    // 先写 zip 到临时文件，再拼接 KGPG v2 固定头部（保持 ZIP 兼容）
    let file_name = path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "无效的输出文件名".to_string())?;
    let tmp_zip_name = format!("{}.zip.tmp", file_name);
    let tmp_zip_path = path.with_file_name(tmp_zip_name);

    let f = std::fs::File::create(&tmp_zip_path).map_err(|e| format!("创建临时文件失败: {}", e))?;
    let mut zip = zip::ZipWriter::new(f);
    let opt = zip::write::FileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o644);

    let manifest_json = serde_json::to_string_pretty(&manifest)
        .map_err(|e| format!("序列化 manifest.json 失败: {}", e))?;
    zip.start_file("manifest.json", opt)
        .map_err(|e| format!("写入 manifest.json 失败: {}", e))?;
    use std::io::Write;
    zip.write_all(manifest_json.as_bytes())
        .map_err(|e| format!("写入 manifest.json 失败: {}", e))?;

    let config_json = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("序列化 config.json 失败: {}", e))?;
    zip.start_file("config.json", opt)
        .map_err(|e| format!("写入 config.json 失败: {}", e))?;
    zip.write_all(config_json.as_bytes())
        .map_err(|e| format!("写入 config.json 失败: {}", e))?;

    zip.start_file("crawl.rhai", opt)
        .map_err(|e| format!("写入 crawl.rhai 失败: {}", e))?;
    zip.write_all(script.as_bytes())
        .map_err(|e| format!("写入 crawl.rhai 失败: {}", e))?;

    zip.finish().map_err(|e| format!("完成压缩失败: {}", e))?;

    // 统一由 `kabegame::kgpg` 写出 KGPG v2（固定头部 + ZIP，ZIP 内不包含 icon.png）
    let mini_manifest = serde_json::json!({
        "name": manifest.name,
        "version": manifest.version,
        "description": manifest.description,
    });
    let mini_bytes =
        serde_json::to_vec(&mini_manifest).map_err(|e| format!("序列化头部 manifest 失败: {}", e))?;

    // 解析 icon 数据（如果提供）
    let icon_bytes: Option<Vec<u8>> = if let Some(b64) = icon_rgb_base64 {
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        let decoded = STANDARD
            .decode(&b64)
            .map_err(|e| format!("解码 icon base64 失败: {}", e))?;
        if decoded.len() != crate::kgpg::KGPG2_ICON_SIZE {
            return Err(format!(
                "icon 数据大小不正确：{} bytes（应为 {} bytes）",
                decoded.len(),
                crate::kgpg::KGPG2_ICON_SIZE
            ));
        }
        Some(decoded)
    } else {
        None
    };

    let header = crate::kgpg::build_kgpg2_header(icon_bytes.as_deref(), &mini_bytes)?;
    let zip_bytes =
        std::fs::read(&tmp_zip_path).map_err(|e| format!("读取临时 zip 失败: {}", e))?;
    crate::kgpg::write_kgpg2_from_zip_bytes(&path, &header, &zip_bytes)?;

    // 清理临时 zip
    let _ = std::fs::remove_file(&tmp_zip_path);

    // 兼容现有规则：插件 ID = 文件名（不含扩展名）
    // 这里不强制校验 plugin_id 与文件名一致，但给调用方留足自由度。
    let _ = plugin_id;

    Ok(())
}
