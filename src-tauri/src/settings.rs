use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use tauri::AppHandle;

// 获取应用数据目录的辅助函数
fn get_app_data_dir() -> PathBuf {
    dirs::data_local_dir()
        .or_else(|| dirs::data_dir())
        .expect("Failed to get app data directory")
        .join("Kabegami Crawler")
}

fn default_wallpaper_rotation_style() -> String {
    "fill".to_string()
}

fn default_wallpaper_rotation_transition() -> String {
    "none".to_string()
}

fn default_wallpaper_mode() -> String {
    "native".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub auto_launch: bool,
    pub max_concurrent_downloads: u32,
    pub network_retry_count: u32,   // 网络失效/请求失败时的重试次数
    pub image_click_action: String, // "preview" 或 "open"
    pub gallery_columns: u32,       // 画廊列数，默认自动
    pub gallery_image_aspect_ratio_match_window: bool, // 画廊图片宽高比是否与窗口相同
    pub gallery_page_size: u32,     // 画廊每次加载数量
    #[serde(default)]
    pub default_download_dir: Option<String>, // 默认下载目录（为空则使用应用内置目录）
    #[serde(default)]
    pub wallpaper_engine_dir: Option<String>, // Wallpaper Engine 安装目录（用于自动导入工程到 myprojects）
    #[serde(default)]
    pub wallpaper_rotation_enabled: bool, // 壁纸轮播是否启用
    #[serde(default)]
    pub wallpaper_rotation_album_id: Option<String>, // 轮播的画册ID
    #[serde(default)]
    pub wallpaper_rotation_interval_minutes: u32, // 轮播间隔（分钟）
    #[serde(default)]
    pub wallpaper_rotation_mode: String, // 轮播模式："random" 或 "sequential"
    #[serde(default = "default_wallpaper_rotation_style")]
    pub wallpaper_rotation_style: String, // 壁纸显示方式："fill"（填充）、"fit"（适应）、"stretch"（拉伸）、"center"（居中）、"tile"（平铺）
    #[serde(default = "default_wallpaper_rotation_transition")]
    pub wallpaper_rotation_transition: String, // 过渡方式："none"（无）、"fade"（淡入淡出）
    #[serde(default = "default_wallpaper_mode")]
    pub wallpaper_mode: String, // 壁纸模式："native"（原生）、"window"（窗口句柄）
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            auto_launch: false,
            max_concurrent_downloads: 3,
            network_retry_count: 2,
            image_click_action: "preview".to_string(),
            gallery_columns: 0, // 0 表示自动（auto-fill）
            gallery_image_aspect_ratio_match_window: false,
            gallery_page_size: 50,
            default_download_dir: None,
            wallpaper_engine_dir: None,
            wallpaper_rotation_enabled: false,
            wallpaper_rotation_album_id: None,
            wallpaper_rotation_interval_minutes: 60,
            wallpaper_rotation_mode: "random".to_string(),
            wallpaper_rotation_style: "fill".to_string(),
            wallpaper_rotation_transition: "none".to_string(),
            wallpaper_mode: "native".to_string(),
        }
    }
}

pub struct Settings;

impl Settings {
    pub fn new(_app: AppHandle) -> Self {
        Self
    }

    fn get_settings_file(&self) -> PathBuf {
        let app_data_dir = get_app_data_dir();
        app_data_dir.join("settings.json")
    }

    /// 获取系统默认的壁纸设置（从 Windows 注册表读取）
    #[cfg(target_os = "windows")]
    fn get_system_wallpaper_settings(&self) -> (String, String) {
        // 读取 Windows 注册表中的壁纸设置
        let script = r#"
$regPath = "HKCU:\Control Panel\Desktop";
$style = (Get-ItemProperty -Path $regPath -Name "WallpaperStyle" -ErrorAction SilentlyContinue).WallpaperStyle;
$tile = (Get-ItemProperty -Path $regPath -Name "TileWallpaper" -ErrorAction SilentlyContinue).TileWallpaper;
if ($style -eq $null) { $style = "10" }
if ($tile -eq $null) { $tile = "0" }
Write-Output "$style,$tile"
"#;

        match Command::new("powershell")
            .args(["-Command", script])
            .output()
        {
            Ok(output) => {
                let output_str = String::from_utf8_lossy(&output.stdout);
                let parts: Vec<&str> = output_str.trim().split(',').collect();
                if parts.len() >= 2 {
                    let style_value: u32 = parts[0].trim().parse().unwrap_or(10);
                    let tile_value: u32 = parts[1].trim().parse().unwrap_or(0);

                    // 将 Windows 注册表值转换为应用内部的样式值
                    let style = match (style_value, tile_value) {
                        (0, 1) => "tile",
                        (0, 0) => "center",
                        (2, 0) => "stretch",
                        (6, 0) => "fit",
                        (10, 0) => "fill",
                        _ => "fill", // 默认填充
                    };

                    // Windows 原生壁纸切换的淡入属于系统行为，应用不读取/不干预系统动画参数。
                    // 因此系统默认 transition 统一返回 none。
                    let transition = "none";

                    (style.to_string(), transition.to_string())
                } else {
                    ("fill".to_string(), "none".to_string())
                }
            }
            Err(_) => {
                // 如果读取失败，使用默认值
                ("fill".to_string(), "none".to_string())
            }
        }
    }

    /// 获取系统默认的壁纸设置（macOS 平台）
    #[cfg(target_os = "macos")]
    fn get_system_wallpaper_settings(&self) -> (String, String) {
        // macOS 使用 defaults 命令读取壁纸设置
        // 注意：macOS 的壁纸设置比较复杂，可能包含多个屏幕
        // 这里尝试读取，如果失败则使用默认值
        let script = r#"
defaults read com.apple.desktop Background 2>/dev/null | grep -o '"defaultImagePath" = "[^"]*"' | head -1 | sed 's/.*"defaultImagePath" = "\([^"]*\)".*/\1/'
"#;

        // macOS 的壁纸样式通常不支持像 Windows 那样的多种模式
        // 默认使用 fill（填充）模式
        let style = "fill".to_string();
        let transition = "none".to_string();

        // 尝试读取壁纸路径（虽然不直接用于样式，但可以验证系统设置是否可读）
        let _ = Command::new("sh").args(["-c", script]).output();

        (style, transition)
    }

    /// 获取系统默认的壁纸设置（Linux 平台）
    #[cfg(target_os = "linux")]
    fn get_system_wallpaper_settings(&self) -> (String, String) {
        // Linux 不同桌面环境有不同的方法
        // 尝试检测桌面环境并读取相应的设置

        // 1. 尝试 GNOME (gsettings)
        if let Ok(output) = Command::new("gsettings")
            .args(["get", "org.gnome.desktop.background", "picture-options"])
            .output()
        {
            let output_str = String::from_utf8_lossy(&output.stdout);
            let style = match output_str.trim() {
                s if s.contains("scaled") => "fill",
                s if s.contains("zoom") => "fill",
                s if s.contains("spanned") => "fill",
                s if s.contains("stretched") => "stretch",
                s if s.contains("centered") => "center",
                s if s.contains("wallpaper") => "tile",
                _ => "fill",
            };
            return (style.to_string(), "none".to_string());
        }

        // 2. 尝试 XFCE (xfconf-query)
        if let Ok(output) = Command::new("xfconf-query")
            .args([
                "-c",
                "xfce4-desktop",
                "-p",
                "/backdrop/screen0/monitor0/image-style",
            ])
            .output()
        {
            let output_str = String::from_utf8_lossy(&output.stdout);
            let style = match output_str.trim() {
                "0" => "center",
                "1" => "tile",
                "2" => "stretch",
                "3" => "fit",
                "4" => "fill",
                "5" => "fill",
                _ => "fill",
            };
            return (style.to_string(), "none".to_string());
        }

        // 3. 尝试 KDE (kreadconfig5)
        if let Ok(output) = Command::new("kreadconfig5")
            .args([
                "--file",
                "plasma-org.kde.plasma.desktop-appletsrc",
                "--group",
                "Containments",
                "--group",
                "1",
                "--group",
                "Wallpaper",
                "--group",
                "org.kde.image",
                "--group",
                "General",
                "--key",
                "FillMode",
            ])
            .output()
        {
            let output_str = String::from_utf8_lossy(&output.stdout);
            let style = match output_str.trim() {
                "0" => "fit",
                "1" => "fill",
                "2" => "stretch",
                _ => "fill",
            };
            return (style.to_string(), "none".to_string());
        }

        // 如果所有方法都失败，使用默认值
        ("fill".to_string(), "none".to_string())
    }

    /// 获取使用系统默认值的设置
    fn get_system_default_settings(&self) -> AppSettings {
        let (style, transition) = self.get_system_wallpaper_settings();
        let mut default = AppSettings::default();
        default.wallpaper_rotation_style = style;
        default.wallpaper_rotation_transition = transition;
        default
    }

    pub fn get_settings(&self) -> Result<AppSettings, String> {
        let file = self.get_settings_file();
        if !file.exists() {
            // 首次启动，使用系统默认值
            let default = self.get_system_default_settings();
            self.save_settings(&default)?;
            return Ok(default);
        }

        let content = fs::read_to_string(&file)
            .map_err(|e| format!("Failed to read settings file: {}", e))?;

        // 处理空文件：直接写入默认配置并返回
        if content.trim().is_empty() {
            let default = AppSettings::default();
            self.save_settings(&default)?;
            return Ok(default);
        }

        // 尝试解析为 JSON 值，然后手动构建 AppSettings，使用默认值填充缺失字段
        let json_value: serde_json::Value = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse settings JSON: {}", e))?;

        let mut settings = AppSettings::default();

        if let Some(auto_launch) = json_value.get("autoLaunch").and_then(|v| v.as_bool()) {
            settings.auto_launch = auto_launch;
        }
        if let Some(max_concurrent) = json_value
            .get("maxConcurrentDownloads")
            .and_then(|v| v.as_u64())
        {
            settings.max_concurrent_downloads = max_concurrent as u32;
        }
        if let Some(retry) = json_value.get("networkRetryCount").and_then(|v| v.as_u64()) {
            settings.network_retry_count = retry as u32;
        }
        if let Some(image_click_action) =
            json_value.get("imageClickAction").and_then(|v| v.as_str())
        {
            settings.image_click_action = image_click_action.to_string();
        }
        if let Some(gallery_columns) = json_value.get("galleryColumns").and_then(|v| v.as_u64()) {
            settings.gallery_columns = gallery_columns as u32;
        }
        if let Some(match_window) = json_value
            .get("galleryImageAspectRatioMatchWindow")
            .and_then(|v| v.as_bool())
        {
            settings.gallery_image_aspect_ratio_match_window = match_window;
        }
        if let Some(page_size) = json_value.get("galleryPageSize").and_then(|v| v.as_u64()) {
            settings.gallery_page_size = page_size as u32;
        }
        if let Some(dir) = json_value.get("defaultDownloadDir") {
            settings.default_download_dir = match dir {
                serde_json::Value::String(s) if !s.trim().is_empty() => Some(s.to_string()),
                _ => None,
            };
        }
        if let Some(dir) = json_value.get("wallpaperEngineDir") {
            settings.wallpaper_engine_dir = match dir {
                serde_json::Value::String(s) if !s.trim().is_empty() => Some(s.to_string()),
                _ => None,
            };
        }
        if let Some(enabled) = json_value
            .get("wallpaperRotationEnabled")
            .and_then(|v| v.as_bool())
        {
            settings.wallpaper_rotation_enabled = enabled;
        }
        if let Some(album_id) = json_value.get("wallpaperRotationAlbumId") {
            settings.wallpaper_rotation_album_id = match album_id {
                serde_json::Value::String(s) if !s.trim().is_empty() => Some(s.to_string()),
                _ => None,
            };
        }
        if let Some(interval) = json_value
            .get("wallpaperRotationIntervalMinutes")
            .and_then(|v| v.as_u64())
        {
            settings.wallpaper_rotation_interval_minutes = interval as u32;
        }
        if let Some(mode) = json_value
            .get("wallpaperRotationMode")
            .and_then(|v| v.as_str())
        {
            settings.wallpaper_rotation_mode = mode.to_string();
        }
        if let Some(style) = json_value
            .get("wallpaperRotationStyle")
            .and_then(|v| v.as_str())
        {
            settings.wallpaper_rotation_style = style.to_string();
        }
        if let Some(transition) = json_value
            .get("wallpaperRotationTransition")
            .and_then(|v| v.as_str())
        {
            settings.wallpaper_rotation_transition = transition.to_string();
        }
        if let Some(mode) = json_value.get("wallpaperMode").and_then(|v| v.as_str()) {
            settings.wallpaper_mode = mode.to_string();
        }

        // 保存合并后的设置，确保所有字段都存在
        self.save_settings(&settings)?;
        Ok(settings)
    }

    pub fn save_settings(&self, settings: &AppSettings) -> Result<(), String> {
        let file = self.get_settings_file();
        if let Some(parent) = file.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create settings directory: {}", e))?;
        }

        let content = serde_json::to_string_pretty(settings)
            .map_err(|e| format!("Failed to serialize settings: {}", e))?;
        fs::write(&file, content).map_err(|e| format!("Failed to write settings file: {}", e))?;
        Ok(())
    }

    pub fn set_auto_launch(&self, enabled: bool) -> Result<(), String> {
        let mut settings = self.get_settings()?;
        settings.auto_launch = enabled;
        self.save_settings(&settings)?;

        // 设置开机启动
        #[cfg(target_os = "windows")]
        {
            use auto_launch::AutoLaunchBuilder;
            let app_path = std::env::current_exe()
                .map_err(|e| format!("Failed to get current exe path: {}", e))?;

            let auto_launch = AutoLaunchBuilder::new()
                .set_app_name("Kabegami")
                .set_app_path(app_path.to_str().unwrap())
                .build()
                .map_err(|e| format!("Failed to create auto launch: {}", e))?;

            if enabled {
                auto_launch
                    .enable()
                    .map_err(|e| format!("Failed to enable auto launch: {}", e))?;
            } else {
                auto_launch
                    .disable()
                    .map_err(|e| format!("Failed to disable auto launch: {}", e))?;
            }
        }

        #[cfg(not(target_os = "windows"))]
        {
            // 其他平台的实现可以在这里添加
        }

        Ok(())
    }

    pub fn set_max_concurrent_downloads(&self, count: u32) -> Result<(), String> {
        let mut settings = self.get_settings()?;
        settings.max_concurrent_downloads = count;
        self.save_settings(&settings)?;
        Ok(())
    }

    pub fn set_network_retry_count(&self, count: u32) -> Result<(), String> {
        let mut settings = self.get_settings()?;
        settings.network_retry_count = count;
        self.save_settings(&settings)?;
        Ok(())
    }

    pub fn set_image_click_action(&self, action: String) -> Result<(), String> {
        let mut settings = self.get_settings()?;
        settings.image_click_action = action;
        self.save_settings(&settings)?;
        Ok(())
    }

    pub fn set_gallery_columns(&self, columns: u32) -> Result<(), String> {
        let mut settings = self.get_settings()?;
        settings.gallery_columns = columns;
        self.save_settings(&settings)?;
        Ok(())
    }

    pub fn set_gallery_image_aspect_ratio_match_window(&self, enabled: bool) -> Result<(), String> {
        let mut settings = self.get_settings()?;
        settings.gallery_image_aspect_ratio_match_window = enabled;
        self.save_settings(&settings)?;
        Ok(())
    }

    pub fn set_gallery_page_size(&self, page_size: u32) -> Result<(), String> {
        let mut settings = self.get_settings()?;
        settings.gallery_page_size = page_size;
        self.save_settings(&settings)?;
        Ok(())
    }

    pub fn set_default_download_dir(&self, dir: Option<String>) -> Result<(), String> {
        let mut settings = self.get_settings()?;
        let normalized = dir.and_then(|s| {
            let t = s.trim().to_string();
            if t.is_empty() {
                None
            } else {
                Some(t)
            }
        });

        // 若提供了目录，则做基本校验：存在且为目录；不存在则尝试创建
        if let Some(ref path) = normalized {
            let p = PathBuf::from(path);
            if p.exists() {
                if !p.is_dir() {
                    return Err("默认下载目录不是文件夹".to_string());
                }
            } else {
                fs::create_dir_all(&p).map_err(|e| format!("无法创建默认下载目录: {}", e))?;
            }
        }

        settings.default_download_dir = normalized;
        self.save_settings(&settings)?;
        Ok(())
    }

    pub fn set_wallpaper_engine_dir(&self, dir: Option<String>) -> Result<(), String> {
        let mut settings = self.get_settings()?;
        let normalized = dir.and_then(|s| {
            let t = s.trim().to_string();
            if t.is_empty() {
                None
            } else {
                Some(t)
            }
        });

        if let Some(ref path) = normalized {
            let p = PathBuf::from(path);
            if !p.exists() || !p.is_dir() {
                return Err("Wallpaper Engine 目录不存在或不是文件夹".to_string());
            }
        }

        settings.wallpaper_engine_dir = normalized;
        self.save_settings(&settings)?;
        Ok(())
    }

    /// 推导 Wallpaper Engine 的 myprojects 目录（用于自动导入 Web 工程）
    ///
    /// - 支持用户选择的是：WE 根目录 / WE\\projects / WE\\projects\\myprojects / 甚至直接选 myprojects
    pub fn get_wallpaper_engine_myprojects_dir(&self) -> Result<Option<String>, String> {
        let settings = self.get_settings()?;
        let Some(ref base) = settings.wallpaper_engine_dir else {
            return Ok(None);
        };

        let base = base.trim().trim_start_matches("\\\\?\\");
        if base.is_empty() {
            return Ok(None);
        }

        let p = PathBuf::from(base);
        if !p.exists() || !p.is_dir() {
            return Ok(None);
        }

        // 如果用户直接选到了 myprojects
        if p.file_name()
            .and_then(|s| s.to_str())
            .map(|s| s.eq_ignore_ascii_case("myprojects"))
            .unwrap_or(false)
        {
            return Ok(Some(p.to_string_lossy().to_string()));
        }

        // 如果用户选到了 projects
        if p.file_name()
            .and_then(|s| s.to_str())
            .map(|s| s.eq_ignore_ascii_case("projects"))
            .unwrap_or(false)
        {
            let mp = p.join("myprojects");
            if mp.exists() && mp.is_dir() {
                return Ok(Some(mp.to_string_lossy().to_string()));
            }
            // 没有就尝试创建（WE 通常会自动建，但我们也可以提前建）
            fs::create_dir_all(&mp).map_err(|e| format!("创建 myprojects 目录失败: {}", e))?;
            return Ok(Some(mp.to_string_lossy().to_string()));
        }

        // 默认：当作 WE 根目录
        let projects = p.join("projects");
        let mp = projects.join("myprojects");
        if mp.exists() && mp.is_dir() {
            return Ok(Some(mp.to_string_lossy().to_string()));
        }
        if projects.exists() && projects.is_dir() {
            fs::create_dir_all(&mp).map_err(|e| format!("创建 myprojects 目录失败: {}", e))?;
            return Ok(Some(mp.to_string_lossy().to_string()));
        }

        // 如果找不到 projects，就不强行创建，避免用户选错目录导致乱写
        Ok(None)
    }

    pub fn set_wallpaper_rotation_enabled(&self, enabled: bool) -> Result<(), String> {
        let mut settings = self.get_settings()?;
        settings.wallpaper_rotation_enabled = enabled;
        self.save_settings(&settings)?;
        Ok(())
    }

    pub fn set_wallpaper_rotation_album_id(&self, album_id: Option<String>) -> Result<(), String> {
        let mut settings = self.get_settings()?;
        settings.wallpaper_rotation_album_id = album_id;
        self.save_settings(&settings)?;
        Ok(())
    }

    pub fn set_wallpaper_rotation_interval_minutes(&self, minutes: u32) -> Result<(), String> {
        let mut settings = self.get_settings()?;
        settings.wallpaper_rotation_interval_minutes = minutes;
        self.save_settings(&settings)?;
        Ok(())
    }

    pub fn set_wallpaper_rotation_mode(&self, mode: String) -> Result<(), String> {
        let mut settings = self.get_settings()?;
        settings.wallpaper_rotation_mode = mode;
        self.save_settings(&settings)?;
        Ok(())
    }

    pub fn set_wallpaper_style(&self, style: String) -> Result<(), String> {
        let mut settings = self.get_settings()?;
        settings.wallpaper_rotation_style = style;
        self.save_settings(&settings)?;
        Ok(())
    }

    pub fn set_wallpaper_rotation_transition(&self, transition: String) -> Result<(), String> {
        let mut settings = self.get_settings()?;
        settings.wallpaper_rotation_transition = transition;
        self.save_settings(&settings)?;
        Ok(())
    }

    pub fn set_wallpaper_mode(&self, mode: String) -> Result<(), String> {
        let mut settings = self.get_settings()?;
        settings.wallpaper_mode = mode;
        self.save_settings(&settings)?;
        Ok(())
    }
}
