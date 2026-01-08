use crate::plugin::{PluginConfig, PluginManifest};
use image::imageops::FilterType;
use image::GenericImageView;
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
    let mini_bytes = serde_json::to_vec(&mini_manifest)
        .map_err(|e| format!("序列化头部 manifest 失败: {}", e))?;

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
