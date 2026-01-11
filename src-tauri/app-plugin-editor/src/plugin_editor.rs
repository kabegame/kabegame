use image::imageops::FilterType;
use image::GenericImageView;
use kabegame_core::{
    kgpg,
    plugin::{PluginConfig, PluginManager, PluginManifest},
};
use rhai::Engine;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

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

/// 处理用户选择的图片，转换为 kgpg v2 icon 格式（128x128 RGB24）
/// 返回 base64 编码的 RGB24 数据
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

/// 处理用户裁剪后的图片 bytes（PNG/JPEG 等），转换为 kgpg v2 icon 格式（128x128 RGB24）
/// 入参为 base64 编码的“原始图片文件 bytes”（不是 data URL）
/// 返回 base64 编码的 RGB24 数据
pub fn plugin_editor_process_icon_bytes(image_bytes_base64: String) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let bytes = STANDARD
        .decode(image_bytes_base64.trim())
        .map_err(|e| format!("解码图片 base64 失败: {}", e))?;
    if bytes.is_empty() {
        return Err("图片数据为空".to_string());
    }
    let rgb = image_bytes_to_rgb24_fixed(&bytes)?;
    Ok(STANDARD.encode(&rgb))
}

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

    // 统一由 `kabegame_core::kgpg` 写出 KGPG v2（固定头部 + ZIP，ZIP 内不包含 icon.png）
    let mini_manifest = serde_json::json!({
        "name": manifest.name,
        "version": manifest.version,
        "description": manifest.description,
        "author": manifest.author,
    });
    let mini_bytes = serde_json::to_vec(&mini_manifest)
        .map_err(|e| format!("序列化头部 manifest 失败: {}", e))?;

    // 解析 icon 数据（如果提供）
    let icon_bytes: Option<Vec<u8>> = if let Some(b64) = icon_rgb_base64 {
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        let decoded = STANDARD
            .decode(&b64)
            .map_err(|e| format!("解码 icon base64 失败: {}", e))?;
        if decoded.len() != kgpg::KGPG2_ICON_SIZE {
            return Err(format!(
                "icon 数据大小不正确：{} bytes（应为 {} bytes）",
                decoded.len(),
                kgpg::KGPG2_ICON_SIZE
            ));
        }
        Some(decoded)
    } else {
        None
    };

    let header = kgpg::build_kgpg2_header(icon_bytes.as_deref(), &mini_bytes)?;
    let zip_bytes =
        std::fs::read(&tmp_zip_path).map_err(|e| format!("读取临时 zip 失败: {}", e))?;
    kgpg::write_kgpg2_from_zip_bytes(&path, &header, &zip_bytes)?;

    // 清理临时 zip
    let _ = std::fs::remove_file(&tmp_zip_path);

    // 兼容现有规则：插件 ID = 文件名（不含扩展名）
    // 这里不强制校验 plugin_id 与文件名一致，但给调用方留足自由度。
    let _ = plugin_id;

    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginEditorImportResult {
    pub plugin_id: String,
    pub manifest: PluginManifest,
    pub config: PluginConfig,
    pub script: String,
    /// 128*128 RGB24 raw bytes（base64）。用于前端预览/再次导出；None 表示没有图标。
    pub icon_rgb_base64: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AutosaveDraftMeta {
    /// 实际编辑的插件 ID（因为 autosave 文件名固定，不能靠 file stem 恢复）
    pub plugin_id: String,
    /// 毫秒时间戳
    pub saved_at: u64,
}

fn autosave_dir() -> PathBuf {
    std::env::temp_dir().join("kabegame-plugin-editor")
}

fn autosave_path() -> PathBuf {
    autosave_dir().join("autosave.kgpg")
}

fn write_kgpg_with_extra_entries(
    output_path: &PathBuf,
    manifest: &PluginManifest,
    config: &PluginConfig,
    script: &str,
    icon_rgb_base64: Option<String>,
    extra_entries: Vec<(&str, Vec<u8>)>,
) -> Result<(), String> {
    use std::io::Write;

    // 先写 zip 到临时文件，再拼接 KGPG v2 固定头部
    let file_name = output_path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "无效的输出文件名".to_string())?;
    let tmp_zip_name = format!("{}.zip.tmp", file_name);
    let tmp_zip_path = output_path.with_file_name(tmp_zip_name);

    if let Some(parent) = tmp_zip_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建临时目录失败: {}", e))?;
    }

    let f = std::fs::File::create(&tmp_zip_path).map_err(|e| format!("创建临时文件失败: {}", e))?;
    let mut zip = zip::ZipWriter::new(f);
    let opt = zip::write::FileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o644);

    let manifest_json = serde_json::to_string_pretty(manifest)
        .map_err(|e| format!("序列化 manifest.json 失败: {}", e))?;
    zip.start_file("manifest.json", opt)
        .map_err(|e| format!("写入 manifest.json 失败: {}", e))?;
    zip.write_all(manifest_json.as_bytes())
        .map_err(|e| format!("写入 manifest.json 失败: {}", e))?;

    let config_json = serde_json::to_string_pretty(config)
        .map_err(|e| format!("序列化 config.json 失败: {}", e))?;
    zip.start_file("config.json", opt)
        .map_err(|e| format!("写入 config.json 失败: {}", e))?;
    zip.write_all(config_json.as_bytes())
        .map_err(|e| format!("写入 config.json 失败: {}", e))?;

    zip.start_file("crawl.rhai", opt)
        .map_err(|e| format!("写入 crawl.rhai 失败: {}", e))?;
    zip.write_all(script.as_bytes())
        .map_err(|e| format!("写入 crawl.rhai 失败: {}", e))?;

    for (name, bytes) in extra_entries {
        zip.start_file(name, opt)
            .map_err(|e| format!("写入 {} 失败: {}", name, e))?;
        zip.write_all(&bytes)
            .map_err(|e| format!("写入 {} 失败: {}", name, e))?;
    }

    zip.finish().map_err(|e| format!("完成压缩失败: {}", e))?;

    // header mini manifest
    let mini_manifest = serde_json::json!({
        "name": manifest.name,
        "version": manifest.version,
        "description": manifest.description,
        "author": manifest.author,
    });
    let mini_bytes = serde_json::to_vec(&mini_manifest)
        .map_err(|e| format!("序列化头部 manifest 失败: {}", e))?;

    // icon
    let icon_bytes: Option<Vec<u8>> = if let Some(b64) = icon_rgb_base64 {
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        let decoded = STANDARD
            .decode(&b64)
            .map_err(|e| format!("解码 icon base64 失败: {}", e))?;
        if decoded.len() != kgpg::KGPG2_ICON_SIZE {
            return Err(format!(
                "icon 数据大小不正确：{} bytes（应为 {} bytes）",
                decoded.len(),
                kgpg::KGPG2_ICON_SIZE
            ));
        }
        Some(decoded)
    } else {
        None
    };

    let header = kgpg::build_kgpg2_header(icon_bytes.as_deref(), &mini_bytes)?;
    let zip_bytes =
        std::fs::read(&tmp_zip_path).map_err(|e| format!("读取临时 zip 失败: {}", e))?;
    kgpg::write_kgpg2_from_zip_bytes(output_path, &header, &zip_bytes)?;

    let _ = std::fs::remove_file(&tmp_zip_path);
    Ok(())
}

fn read_autosave_plugin_id_from_kgpg(path: &std::path::Path) -> Option<String> {
    use std::io::Read;
    let f = std::fs::File::open(path).ok()?;
    let mut archive = zip::ZipArchive::new(f).ok()?;
    let mut meta_file = archive.by_name("draft.json").ok()?;
    let mut s = String::new();
    meta_file.read_to_string(&mut s).ok()?;
    let meta: AutosaveDraftMeta = serde_json::from_str(&s).ok()?;
    let id = meta.plugin_id.trim().to_string();
    if id.is_empty() {
        None
    } else {
        Some(id)
    }
}

fn rgb24_bytes_to_png_bytes(rgb: &[u8]) -> Result<Vec<u8>, String> {
    use image::{ImageOutputFormat, RgbImage};
    if rgb.len() != kgpg::KGPG2_ICON_SIZE {
        return Err(format!(
            "icon RGB 大小不正确：{} bytes（应为 {} bytes）",
            rgb.len(),
            kgpg::KGPG2_ICON_SIZE
        ));
    }
    let img = RgbImage::from_raw(kgpg::KGPG2_ICON_W, kgpg::KGPG2_ICON_H, rgb.to_vec())
        .ok_or_else(|| "Invalid icon rgb buffer".to_string())?;
    let mut out: Vec<u8> = Vec::new();
    let mut cursor = std::io::Cursor::new(&mut out);
    img.write_to(&mut cursor, ImageOutputFormat::Png)
        .map_err(|e| format!("Failed to encode icon png: {}", e))?;
    Ok(out)
}

fn image_bytes_to_rgb24_fixed(image_bytes: &[u8]) -> Result<Vec<u8>, String> {
    // 与 plugin_editor_process_icon 保持一致：居中裁剪为正方形，再缩放到 128x128，最后转 RGB24
    let img = image::load_from_memory(image_bytes).map_err(|e| format!("无法解析图片: {}", e))?;
    let (w, h) = img.dimensions();
    let crop_size = w.min(h);
    let crop_x = (w - crop_size) / 2;
    let crop_y = (h - crop_size) / 2;
    let cropped = img.crop_imm(crop_x, crop_y, crop_size, crop_size);
    let resized =
        cropped.resize_exact(kgpg::KGPG2_ICON_W, kgpg::KGPG2_ICON_H, FilterType::Lanczos3);
    Ok(resized.to_rgb8().into_raw())
}

fn read_icon_rgb_base64_from_kgpg(
    pm: &PluginManager,
    kgpg_path: &std::path::Path,
) -> Result<Option<String>, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    // v2：优先从固定头部读取 RGB24
    if let Ok(Some(rgb)) = kgpg::read_kgpg2_icon_rgb_from_file(kgpg_path) {
        if rgb.is_empty() {
            return Ok(None);
        }
        if rgb.len() == kgpg::KGPG2_ICON_SIZE {
            return Ok(Some(STANDARD.encode(&rgb)));
        }
    }

    // fallback：尝试读取 zip 内 icon.png（v1 或兼容包），并转为 RGB24
    if let Ok(Some(png_bytes)) = pm.read_plugin_icon(kgpg_path) {
        let rgb = image_bytes_to_rgb24_fixed(&png_bytes)?;
        if rgb.len() == kgpg::KGPG2_ICON_SIZE {
            return Ok(Some(STANDARD.encode(&rgb)));
        }
    }

    Ok(None)
}

pub fn plugin_editor_import_kgpg(
    plugin_manager: &PluginManager,
    file_path: String,
) -> Result<PluginEditorImportResult, String> {
    let p = std::path::PathBuf::from(&file_path);
    if !p.is_file() {
        return Err(format!("插件文件不存在: {}", file_path));
    }
    if p.extension().and_then(|s| s.to_str()) != Some("kgpg") {
        return Err(format!("不是 .kgpg 文件: {}", file_path));
    }

    let mut plugin_id = p
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("plugin")
        .to_string();
    // autosave：优先从 draft.json 恢复真实 plugin_id
    if let Some(id) = read_autosave_plugin_id_from_kgpg(&p) {
        plugin_id = id;
    }

    let manifest = plugin_manager.read_plugin_manifest(&p)?;
    let config = plugin_manager
        .read_plugin_config_public(&p)
        .ok()
        .flatten()
        .unwrap_or(PluginConfig {
            base_url: None,
            selector: None,
            var: None,
        });
    let script = plugin_manager
        .read_plugin_script(&p)?
        .unwrap_or_else(|| String::from("// 在这里编写 crawl.rhai\n"));
    let icon_rgb_base64 = read_icon_rgb_base64_from_kgpg(plugin_manager, &p)?;

    Ok(PluginEditorImportResult {
        plugin_id,
        manifest,
        config,
        script,
        icon_rgb_base64,
    })
}

pub fn plugin_editor_autosave_save(
    plugin_id: String,
    manifest: PluginManifest,
    config: PluginConfig,
    script: String,
    icon_rgb_base64: Option<String>,
) -> Result<String, String> {
    let dir = autosave_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建 autosave 目录失败: {}", e))?;
    let path = autosave_path();
    let meta = AutosaveDraftMeta {
        plugin_id: plugin_id.trim().to_string(),
        saved_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
    };
    let meta_bytes =
        serde_json::to_vec_pretty(&meta).map_err(|e| format!("序列化 draft.json 失败: {}", e))?;
    write_kgpg_with_extra_entries(
        &path,
        &manifest,
        &config,
        &script,
        icon_rgb_base64,
        vec![("draft.json", meta_bytes)],
    )?;
    Ok(path.to_string_lossy().to_string())
}

pub fn plugin_editor_autosave_load(
    plugin_manager: &PluginManager,
) -> Result<Option<PluginEditorImportResult>, String> {
    let path = autosave_path();
    if !path.is_file() {
        return Ok(None);
    }
    let res = plugin_editor_import_kgpg(plugin_manager, path.to_string_lossy().to_string())?;
    Ok(Some(res))
}

pub fn plugin_editor_autosave_clear() -> Result<(), String> {
    let path = autosave_path();
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("删除 autosave 失败: {}", e))?;
    }
    Ok(())
}

pub fn plugin_editor_export_folder(
    output_dir: String,
    manifest: PluginManifest,
    config: PluginConfig,
    script: String,
    icon_rgb_base64: Option<String>,
) -> Result<(), String> {
    use std::io::Write;

    let dir = PathBuf::from(output_dir);
    if dir.exists() && !dir.is_dir() {
        return Err(format!("输出路径不是文件夹: {}", dir.display()));
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建输出目录失败: {}", e))?;

    // manifest.json
    let manifest_json = serde_json::to_string_pretty(&manifest)
        .map_err(|e| format!("序列化 manifest.json 失败: {}", e))?;
    std::fs::File::create(dir.join("manifest.json"))
        .and_then(|mut f| f.write_all(manifest_json.as_bytes()))
        .map_err(|e| format!("写入 manifest.json 失败: {}", e))?;

    // config.json
    let config_json = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("序列化 config.json 失败: {}", e))?;
    std::fs::File::create(dir.join("config.json"))
        .and_then(|mut f| f.write_all(config_json.as_bytes()))
        .map_err(|e| format!("写入 config.json 失败: {}", e))?;

    // crawl.rhai
    std::fs::File::create(dir.join("crawl.rhai"))
        .and_then(|mut f| f.write_all(script.as_bytes()))
        .map_err(|e| format!("写入 crawl.rhai 失败: {}", e))?;

    // icon.png（可选）
    if let Some(b64) = icon_rgb_base64 {
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        let decoded = STANDARD
            .decode(&b64)
            .map_err(|e| format!("解码 icon base64 失败: {}", e))?;
        if decoded.len() == kgpg::KGPG2_ICON_SIZE {
            let png = rgb24_bytes_to_png_bytes(&decoded)?;
            std::fs::File::create(dir.join("icon.png"))
                .and_then(|mut f| f.write_all(&png))
                .map_err(|e| format!("写入 icon.png 失败: {}", e))?;
        }
    }

    Ok(())
}
