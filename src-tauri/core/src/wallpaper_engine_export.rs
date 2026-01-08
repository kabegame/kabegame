use crate::settings::Settings;
use crate::storage::{ImageInfo, Storage};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

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

fn build_index_html(title: &str) -> String {
    format!(
        r#"<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{}</title>
    <link rel="stylesheet" href="style.css" />
  </head>
  <body>
    <div class="wallpaper-root">
      <div class="wallpaper-stage">
        <img id="baseImg" class="wallpaper-img base" alt="" />
        <img id="topImg" class="wallpaper-img top" alt="" />
        <div id="baseTile" class="wallpaper-tile base"></div>
        <div id="topTile" class="wallpaper-tile top"></div>
      </div>
    </div>
    <script src="main.js"></script>
  </body>
</html>
"#,
        title
    )
}

fn build_style_css() -> String {
    // 基于 `src/components/WallpaperLayer.vue` 的样式裁剪而来（保持过渡体验一致）
    r#"
html, body {
  width: 100%;
  height: 100%;
  margin: 0;
  padding: 0;
  overflow: hidden;
  background: transparent;
}

.wallpaper-root {
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  background: transparent;
}

.wallpaper-stage {
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
}

.wallpaper-img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
  pointer-events: none;
}

.wallpaper-img.base { opacity: 1; }
.wallpaper-img.top {
  opacity: 0;
  transform: none;
  transition: none;
  will-change: opacity, transform;
}

.wallpaper-tile {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  background-color: transparent;
  pointer-events: none;
}

.wallpaper-tile.base { opacity: 1; }
.wallpaper-tile.top {
  opacity: 0;
  transform: none;
  transition: none;
  will-change: opacity, transform;
}

/* transitions (对齐 WallpaperLayer.vue) */
.top.fade.enter {
  opacity: 1;
  transition: opacity var(--kabegame-fade-ms, 800ms) ease-in-out;
}

.top.slide.prep {
  opacity: 0;
  transform: translateX(32px);
}
.top.slide.enter {
  opacity: 1;
  transform: translateX(0);
  transition: opacity var(--kabegame-slide-ms, 800ms) ease, transform var(--kabegame-slide-ms, 800ms) ease;
}

.top.zoom.prep {
  opacity: 0;
  transform: scale(1.06);
}
.top.zoom.enter {
  opacity: 1;
  transform: scale(1);
  transition: opacity var(--kabegame-zoom-ms, 900ms) ease, transform var(--kabegame-zoom-ms, 900ms) ease;
}
"#
    .to_string()
}

fn build_main_js(config_json: &str, images_json: &str) -> String {
    format!(
        r#"
// 由 Kabegame 导出生成
(function() {{
  'use strict';
  
  const CONFIG = {config_json};
  const IMAGES = {images_json};

  function clampPositiveInt(v, fallback) {{
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.floor(n);
  }}

  // 把过渡时长也导出成 CSS 变量，方便用户在 WE 里二次调（在 DOM 加载前就可以设置）
  if (document.documentElement) {{
    document.documentElement.style.setProperty("--kabegame-fade-ms", `${{clampPositiveInt(CONFIG.fadeMs || 800, 800)}}ms`);
    document.documentElement.style.setProperty("--kabegame-slide-ms", `${{clampPositiveInt(CONFIG.slideMs || 800, 800)}}ms`);
    document.documentElement.style.setProperty("--kabegame-zoom-ms", `${{clampPositiveInt(CONFIG.zoomMs || 900, 900)}}ms`);
  }}

  function init() {{
    // 确保 DOM 已加载
    const baseImg = document.getElementById("baseImg");
    const topImg = document.getElementById("topImg");
    const baseTile = document.getElementById("baseTile");
    const topTile = document.getElementById("topTile");
    
    // 安全检查：如果元素不存在，直接返回（避免崩溃）
    if (!baseImg || !topImg || !baseTile || !topTile) {{
      console.error("Wallpaper: Required DOM elements not found");
      return;
    }}
    
    const intervalMs = clampPositiveInt(CONFIG.intervalMs, 60000);
    const transition = (CONFIG.transition || "fade").toLowerCase();
    const style = (CONFIG.style || "fill").toLowerCase();
    const order = (CONFIG.order || "random").toLowerCase();

    function applyStyle() {{
      // tile 模式：使用 background-repeat
      const isTile = style === "tile";
      baseImg.style.display = isTile ? "none" : "block";
      topImg.style.display = isTile ? "none" : "block";
      baseTile.style.display = isTile ? "block" : "none";
      topTile.style.display = isTile ? "block" : "none";

      // img 模式：使用 object-fit
      const fit = style === "fit" ? "contain"
        : style === "stretch" ? "fill"
        : "cover"; // fill/center 默认 cover

      baseImg.style.objectFit = fit;
      topImg.style.objectFit = fit;
      baseImg.style.objectPosition = "center center";
      topImg.style.objectPosition = "center center";

      // center：不拉伸，保持原比例，但居中展示（object-fit: none）
      if (style === "center") {{
        baseImg.style.objectFit = "none";
        topImg.style.objectFit = "none";
      }}
    }}

    function setBase(url) {{
      if (style === "tile") {{
        baseTile.style.backgroundImage = `url("${{url}}")`;
        baseTile.style.backgroundRepeat = "repeat";
        baseTile.style.backgroundPosition = "0 0";
        baseTile.style.backgroundSize = "auto";
      }} else {{
        baseImg.src = url;
      }}
    }}

    function setTop(url) {{
      if (style === "tile") {{
        topTile.style.backgroundImage = `url("${{url}}")`;
        topTile.style.backgroundRepeat = "repeat";
        topTile.style.backgroundPosition = "0 0";
        topTile.style.backgroundSize = "auto";
      }} else {{
        topImg.src = url;
      }}
    }}

    function resetTopClasses() {{
      topImg.className = "wallpaper-img top";
      topTile.className = "wallpaper-tile top";
    }}

    function applyTransitionPrep() {{
      resetTopClasses();
      if (transition === "none") return;
      if (style === "tile") {{
        topTile.classList.add("top", transition, "prep");
      }} else {{
        topImg.classList.add("top", transition, "prep");
      }}
    }}

    function applyTransitionEnter() {{
      if (transition === "none") return;
      if (style === "tile") {{
        topTile.classList.remove("prep");
        topTile.classList.add("enter");
      }} else {{
        topImg.classList.remove("prep");
        topImg.classList.add("enter");
      }}
    }}

    function commitTopToBase() {{
      // 把 top 变成 base
      if (style === "tile") {{
        baseTile.style.backgroundImage = topTile.style.backgroundImage;
        topTile.style.backgroundImage = "";
      }} else {{
        baseImg.src = topImg.src;
        topImg.src = "";
      }}
      resetTopClasses();
    }}

    function buildSequence(images) {{
      if (order === "sequential") return images.slice();
      // random：简单洗牌，循环用
      const arr = images.slice();
      for (let i = arr.length - 1; i > 0; i--) {{
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }}
      return arr;
    }}

    let seq = buildSequence(IMAGES);
    let idx = 0;
    let started = false;

    function nextUrl() {{
      if (seq.length === 0) return "";
      const url = seq[idx % seq.length];
      idx++;
      if (order !== "sequential" && idx % seq.length === 0) {{
        // random 每轮重新洗牌一次
        seq = buildSequence(IMAGES);
        idx = 0;
      }}
      return url;
    }}

    function tick() {{
      if (IMAGES.length === 0) return;
      if (!started) {{
        applyStyle();
        setBase(nextUrl());
        started = true;
        setTimeout(tick, intervalMs);
        return;
      }}

      const url = nextUrl();
      if (!url) return;

      // prepare
      applyTransitionPrep();
      setTop(url);

      // force reflow
      void (style === "tile" ? topTile.offsetHeight : topImg.offsetHeight);

      // enter
      applyTransitionEnter();

      const target = style === "tile" ? topTile : topImg;
      if (transition === "none") {{
        commitTopToBase();
      }} else {{
        const onEnd = (e) => {{
          if (e.target !== e.currentTarget) return;
          if (e.propertyName !== "opacity") return;
          target.removeEventListener("transitionend", onEnd);
          commitTopToBase();
        }};
        target.addEventListener("transitionend", onEnd);
        // guard：避免某些情况下 transitionend 丢失
        setTimeout(() => {{
          target.removeEventListener("transitionend", onEnd);
          commitTopToBase();
        }}, Math.max(1400, intervalMs / 3));
      }}

      setTimeout(tick, intervalMs);
    }}
    
    tick();
  }}
  
  // 等待 DOM 加载完成
  if (document.readyState === "loading") {{
    document.addEventListener("DOMContentLoaded", init);
  }} else {{
    // DOM 已加载，直接执行
    init();
  }}
}})();
"#,
        config_json = config_json,
        images_json = images_json
    )
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

    // 构建工程文件
    let index_html = build_index_html(project_title);
    let style_css = build_style_css();

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
    );

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
    })
}

fn resolve_options_from_settings(
    settings: &crate::settings::AppSettings,
    override_opt: Option<WeExportOptions>,
) -> WeExportOptions {
    let o = override_opt.unwrap_or(WeExportOptions {
        style: None,
        transition: None,
        interval_ms: None,
        order: None,
    });

    WeExportOptions {
        style: Some(
            o.style
                .unwrap_or_else(|| settings.wallpaper_rotation_style.clone()),
        ),
        transition: Some(
            o.transition
                .unwrap_or_else(|| settings.wallpaper_rotation_transition.clone()),
        ),
        interval_ms: Some(
            o.interval_ms
                .unwrap_or_else(|| settings.wallpaper_rotation_interval_minutes as u64 * 60_000),
        ),
        order: Some(
            o.order
                .unwrap_or_else(|| settings.wallpaper_rotation_mode.clone()),
        ),
    }
}

pub fn export_album_to_we_project(
    album_id: String,
    album_name: String,
    output_parent_dir: String,
    options: Option<WeExportOptions>,
    storage: &Storage,
    settings: &Settings,
) -> Result<WeExportResult, String> {
    let app_settings = settings.get_settings()?;
    let options = resolve_options_from_settings(&app_settings, options);

    let images: Vec<ImageInfo> = storage.get_album_images(&album_id)?;
    let image_paths: Vec<String> = images.into_iter().map(|i| i.local_path).collect();
    let title = if album_name.trim().is_empty() {
        format!("Kabegame_Album_{}", album_id)
    } else {
        format!("Kabegame_{}", album_name.trim())
    };
    write_we_web_project(&output_parent_dir, &title, &image_paths, &options)
}

pub fn export_images_to_we_project(
    image_paths: Vec<String>,
    title: Option<String>,
    output_parent_dir: String,
    options: Option<WeExportOptions>,
    settings: &Settings,
) -> Result<WeExportResult, String> {
    let app_settings = settings.get_settings()?;
    let options = resolve_options_from_settings(&app_settings, options);

    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let t = title.unwrap_or_else(|| format!("Kabegame_Selection_{}", ts));
    write_we_web_project(&output_parent_dir, &t, &image_paths, &options)
}
