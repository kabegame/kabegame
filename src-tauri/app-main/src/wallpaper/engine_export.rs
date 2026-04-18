// Wallpaper Engine 导出功能（在 app-main 中执行）

use include_dir::{include_dir, Dir};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::str;
use std::time::{SystemTime, UNIX_EPOCH};

/// WE Web 工程模板（编译时嵌入）
static WE_TEMPLATES: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/template");

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WeExportOptions {
    /// 图片显示方式：fill/fit/stretch/center/tile
    pub style: Option<String>,
    /// 过渡：none/fade/slide/zoom
    pub transition: Option<String>,
    /// 切换间隔（毫秒）
    pub interval_ms: Option<u64>,
    /// 轮播顺序：random/sequential
    pub order: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WeExportResult {
    pub project_dir: String,
    pub image_count: usize,
    /// 导出为视频壁纸时为 Some(1)，图片轮播时为 None 或 Some(0)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video_count: Option<usize>,
}

fn normalize_windows_path(p: &str) -> String {
    // 前端可能传 `\\?\D:\...` 这种前缀，std::fs 在大多数情况下能处理，但我们这里顺手去掉，避免奇怪兼容问题
    p.trim().trim_start_matches(r"\\?\").to_string()
}

fn sanitize_project_name(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
        } else if ch == ' ' || ch == '-' || ch == '_' {
            out.push('_');
        } else if ch.is_ascii() {
            // 其他 ASCII 字符统一变成下划线
            out.push('_');
        } else {
            // 非 ASCII（如中文）也保留（Windows 文件名支持）
            out.push(ch);
        }
    }
    let out = out.trim_matches('_').trim().to_string();
    let out = if out.is_empty() {
        "kabegame_wallpaper".to_string()
    } else {
        out
    };
    // 避免太长的文件夹名
    out.chars().take(64).collect()
}

fn ensure_unique_dir(parent: &Path, base_name: &str) -> PathBuf {
    let base = parent.join(base_name);
    if !base.exists() {
        return base;
    }
    for i in 2..=9999 {
        let candidate = parent.join(format!("{base_name}_{i}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    // 兜底：基本不可能走到这里
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    parent.join(format!("{base_name}_{ts}"))
}

fn ext_from_path(p: &Path) -> String {
    let ext = p
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("jpg")
        .to_ascii_lowercase();
    // 只允许简单扩展名，避免写出奇怪文件名
    if ext.chars().all(|c| c.is_ascii_alphanumeric()) && !ext.is_empty() {
        ext
    } else {
        "jpg".to_string()
    }
}

fn write_file(path: &Path, content: &str) -> Result<(), String> {
    fs::write(path, content).map_err(|e| format!("写入文件失败 {}: {}", path.display(), e))
}

fn get_template(path: &str) -> Result<String, String> {
    let file = WE_TEMPLATES
        .get_file(path)
        .ok_or_else(|| format!("模板文件不存在: {}", path))?;
    str::from_utf8(file.contents())
        .map(String::from)
        .map_err(|e| format!("模板 {} 编码错误: {}", path, e))
}

fn build_index_html(title: &str) -> Result<String, String> {
    let tpl = get_template("we/index.html")?;
    Ok(tpl.replace("__TITLE__", title))
}

fn build_style_css() -> Result<String, String> {
    get_template("we/style.css")
}

fn build_main_js(config_json: &str, images_json: &str) -> Result<String, String> {
    let tpl = get_template("we/main.js")?;
    Ok(tpl
        .replace("__CONFIG_JSON__", config_json)
        .replace("__IMAGES_JSON__", images_json))
}

fn write_we_web_project(
    output_parent_dir: &str,
    project_title: &str,
    image_paths: &[String],
    options: &WeExportOptions,
) -> Result<WeExportResult, String> {
    let parent = PathBuf::from(normalize_windows_path(output_parent_dir));
    if parent.as_os_str().is_empty() {
        return Err("导出目录为空".to_string());
    }
    fs::create_dir_all(&parent)
        .map_err(|e| format!("创建导出目录失败 {}: {}", parent.display(), e))?;

    let base_name = sanitize_project_name(project_title);
    let project_dir = ensure_unique_dir(&parent, &base_name);
    fs::create_dir_all(&project_dir)
        .map_err(|e| format!("创建工程目录失败 {}: {}", project_dir.display(), e))?;

    let assets_dir = project_dir.join("assets");
    let images_dir = assets_dir.join("images");
    fs::create_dir_all(&images_dir)
        .map_err(|e| format!("创建资源目录失败 {}: {}", images_dir.display(), e))?;

    let mut rel_images: Vec<String> = Vec::new();
    let mut copied_first: Option<(PathBuf, String)> = None;

    for (i, raw) in image_paths.iter().enumerate() {
        let normalized = normalize_windows_path(raw);
        if normalized.is_empty() {
            continue;
        }
        let src = PathBuf::from(&normalized);
        if !src.exists() {
            continue;
        }
        let ext = ext_from_path(&src);
        let file_name = format!("img_{:04}.{}", i + 1, ext);
        let dst = images_dir.join(&file_name);
        fs::copy(&src, &dst)
            .map_err(|e| format!("复制图片失败 {} -> {}: {}", src.display(), dst.display(), e))?;
        let rel = format!("assets/images/{}", file_name);
        if copied_first.is_none() {
            copied_first = Some((dst.clone(), rel.clone()));
        }
        rel_images.push(rel);
    }

    if rel_images.is_empty() {
        return Err("没有可导出的图片（文件不存在或路径为空）".to_string());
    }

    // preview：复制首张
    let (first_dst_abs, _first_rel) = copied_first.unwrap();
    let preview_ext = ext_from_path(&first_dst_abs);
    let preview_name = format!("preview.{}", preview_ext);
    let preview_abs = project_dir.join(&preview_name);
    let _ = fs::copy(&first_dst_abs, &preview_abs);

    // 构建工程文件（从嵌入模板读取并替换占位符）
    let index_html = build_index_html(project_title)?;
    let style_css = build_style_css()?;

    let config = serde_json::json!({
        "title": project_title,
        "style": options.style,
        "transition": options.transition,
        "intervalMs": options.interval_ms,
        "order": options.order,
        // 单独提供默认过渡时长（用户可在 WE 内改 main.js 或 CSS 变量）
        "fadeMs": 800,
        "slideMs": 800,
        "zoomMs": 900
    });
    let images =
        serde_json::to_string(&rel_images).map_err(|e| format!("序列化图片列表失败: {}", e))?;
    let main_js = build_main_js(
        &serde_json::to_string(&config).map_err(|e| format!("序列化配置失败: {}", e))?,
        &images,
    )?;

    // 生成更简化的 project.json（仅保留 WE Web 必需字段，避免读取异常）
    let project_json = serde_json::json!({
        "title": project_title,
        "type": "web",
        "file": "index.html",
        "preview": preview_name,
        "description": "Exported from Kabegame",
        "tags": []
    });

    write_file(&project_dir.join("index.html"), &index_html)?;
    write_file(&project_dir.join("style.css"), &style_css)?;
    write_file(&project_dir.join("main.js"), &main_js)?;
    write_file(
        &project_dir.join("project.json"),
        &serde_json::to_string_pretty(&project_json)
            .map_err(|e| format!("序列化 project.json 失败: {}", e))?,
    )?;

    Ok(WeExportResult {
        project_dir: project_dir.to_string_lossy().to_string(),
        image_count: rel_images.len(),
        video_count: None,
    })
}

/// 视频扩展名（与 image_type 一致）：仅允许安全扩展名
fn video_ext_from_path(p: &Path) -> String {
    let ext = p
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("mp4")
        .to_lowercase();
    if ext.chars().all(|c| c.is_ascii_alphanumeric()) && !ext.is_empty() {
        if kabegame_core::image_type::is_supported_video_ext(&ext) {
            return ext;
        }
    }
    "mp4".to_string()
}

/// 导出单个视频为 Wallpaper Engine 视频壁纸工程（仅 Windows）
pub fn write_we_video_project(
    output_parent_dir: &str,
    project_title: &str,
    video_path: &str,
) -> Result<WeExportResult, String> {
    let parent = PathBuf::from(normalize_windows_path(output_parent_dir));
    if parent.as_os_str().is_empty() {
        return Err("导出目录为空".to_string());
    }
    fs::create_dir_all(&parent)
        .map_err(|e| format!("创建导出目录失败 {}: {}", parent.display(), e))?;

    let base_name = sanitize_project_name(project_title);
    let project_dir = ensure_unique_dir(&parent, &base_name);
    fs::create_dir_all(&project_dir)
        .map_err(|e| format!("创建工程目录失败 {}: {}", project_dir.display(), e))?;

    let normalized = normalize_windows_path(video_path);
    if normalized.is_empty() {
        return Err("视频路径为空".to_string());
    }
    let src = PathBuf::from(&normalized);
    if !src.exists() {
        return Err(format!("视频文件不存在: {}", src.display()));
    }
    if !kabegame_core::image_type::is_video_by_path(&src) {
        return Err("文件不是支持的视频格式（支持 mp4、mov）".to_string());
    }

    let ext = video_ext_from_path(&src);
    let file_name = format!("video.{}", ext);
    let dst = project_dir.join(&file_name);
    fs::copy(&src, &dst)
        .map_err(|e| format!("复制视频失败 {} -> {}: {}", src.display(), dst.display(), e))?;

    let project_json = serde_json::json!({
        "title": project_title,
        "type": "video",
        "file": file_name,
        "preview": file_name,
        "description": "Exported from Kabegame",
        "tags": []
    });
    write_file(
        &project_dir.join("project.json"),
        &serde_json::to_string_pretty(&project_json)
            .map_err(|e| format!("序列化 project.json 失败: {}", e))?,
    )?;

    Ok(WeExportResult {
        project_dir: project_dir.to_string_lossy().to_string(),
        image_count: 0,
        video_count: Some(1),
    })
}

/// 导出单个视频到 Wallpaper Engine 项目（仅 Windows）
pub async fn export_video_to_we_project(
    video_path: String,
    title: Option<String>,
    output_parent_dir: String,
) -> Result<WeExportResult, String> {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let t = title.unwrap_or_else(|| format!("Kabegame_Video_{}", ts));
    write_we_video_project(&output_parent_dir, &t, &video_path)
}

/// 通过 daemon 获取设置并解析选项
fn resolve_options_from_settings(override_opt: Option<WeExportOptions>) -> WeExportOptions {
    let o = override_opt.unwrap_or(WeExportOptions {
        style: None,
        transition: None,
        interval_ms: None,
        order: None,
    });

    let settings = kabegame_core::settings::Settings::global();
    let style = settings.get_wallpaper_rotation_style();
    let transition = settings.get_wallpaper_rotation_transition();
    let interval_minutes = settings.get_wallpaper_rotation_interval_minutes();
    let mode = settings.get_wallpaper_rotation_mode();

    WeExportOptions {
        style: Some(o.style.unwrap_or(style)),
        transition: Some(o.transition.unwrap_or(transition)),
        interval_ms: Some(o.interval_ms.unwrap_or(interval_minutes as u64 * 60_000)),
        order: Some(o.order.unwrap_or(mode)),
    }
}

/// 导出相册到 Wallpaper Engine 项目
pub async fn export_album_to_we_project(
    album_id: String,
    album_name: String,
    output_parent_dir: String,
    options: Option<WeExportOptions>,
) -> Result<WeExportResult, String> {
    let options = resolve_options_from_settings(options);

    let images = kabegame_core::storage::Storage::global()
        .get_album_images(&album_id)
        .map_err(|e| format!("获取相册图片失败: {}", e))?;
    let image_paths: Vec<String> = images.into_iter().map(|i| i.local_path).collect();
    let title = if album_name.trim().is_empty() {
        format!("Kabegame_Album_{}", album_id)
    } else {
        format!("Kabegame_{}", album_name.trim())
    };
    write_we_web_project(&output_parent_dir, &title, &image_paths, &options)
}

/// 导出图片列表到 Wallpaper Engine 项目
pub async fn export_images_to_we_project(
    image_paths: Vec<String>,
    title: Option<String>,
    output_parent_dir: String,
    options: Option<WeExportOptions>,
) -> Result<WeExportResult, String> {
    let options = resolve_options_from_settings(options);

    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let t = title.unwrap_or_else(|| format!("Kabegame_Selection_{}", ts));
    write_we_web_project(&output_parent_dir, &t, &image_paths, &options)
}
