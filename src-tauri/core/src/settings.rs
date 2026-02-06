use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;
use std::time::Duration;
use tokio::sync::Mutex as TokioMutex;
use tokio::time::Instant;

use crate::emitter::GlobalEmitter;

#[cfg(any(target_os = "linux", target_os = "macos"))]
use dirs;

fn atomic_replace_file(tmp: &Path, dest: &Path) -> Result<(), String> {
    if !tmp.exists() {
        return Err(format!(
            "Failed to replace settings file: temporary file does not exist: {}",
            tmp.display()
        ));
    }

    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create destination directory: {}", e))?;
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };

        let tmp_w: Vec<u16> = tmp.as_os_str().encode_wide().chain(Some(0)).collect();
        let dest_w: Vec<u16> = dest.as_os_str().encode_wide().chain(Some(0)).collect();

        let ok = unsafe {
            MoveFileExW(
                tmp_w.as_ptr(),
                dest_w.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        };
        if ok == 0 {
            return Err(format!(
                "Failed to replace settings file: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        fs::rename(tmp, dest).map_err(|e| format!("Failed to replace settings file: {}", e))?;
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowState {
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub width: f64,
    pub height: f64,
    pub maximized: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SettingKey {
    /// 开机启动
    AutoLaunch,
    /// 最大并发下载数
    MaxConcurrentDownloads,
    /// 网络重试次数
    NetworkRetryCount,
    /// 图片双击动作
    ImageClickAction,
    /// 画廊图片宽高比
    GalleryImageAspectRatio,
    /// 自动去重
    AutoDeduplicate,
    /// 默认下载目录
    DefaultDownloadDir,
    /// 壁纸引擎目录
    WallpaperEngineDir,
    /// 壁纸轮播启用
    WallpaperRotationEnabled,
    /// 壁纸轮播画册ID，为空则为画廊
    WallpaperRotationAlbumId,
    /// 壁纸轮播间隔分钟
    WallpaperRotationIntervalMinutes,
    /// 壁纸轮播模式（随机、顺序）
    WallpaperRotationMode,
    /// 壁纸样式
    WallpaperStyle,
    /// 壁纸轮播过渡效果
    WallpaperRotationTransition,
    /// 不同轮播模式下单独存储的style
    WallpaperStyleByMode,
    /// 不同轮播模式下单独存储的transition
    WallpaperTransitionByMode,
    /// 壁纸模式（原生等）
    WallpaperMode,
    /// 窗口状态（窗口位置、大小、是否最大化）
    WindowState,
    /// 当前壁纸图片ID
    CurrentWallpaperImageId,
    /// 画册盘启用
    #[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
    AlbumDriveEnabled,
    /// 画册盘挂载点
    #[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
    AlbumDriveMountPoint,
}

// 用于序列化的值类型
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SettingValue {
    Bool(bool),
    U32(u32),
    String(String),
    OptionString(Option<String>),
    WindowState(WindowState),
    OptionWindowState(Option<WindowState>),
    HashMapStringString(HashMap<String, String>),
}

impl SettingValue {
    fn as_bool(&self) -> Option<bool> {
        match self {
            SettingValue::Bool(b) => Some(*b),
            _ => None,
        }
    }

    fn as_u32(&self) -> Option<u32> {
        match self {
            SettingValue::U32(n) => Some(*n),
            _ => None,
        }
    }

    fn as_string(&self) -> Option<String> {
        match self {
            SettingValue::String(s) => Some(s.clone()),
            _ => None,
        }
    }

    fn as_option_string(&self) -> Option<Option<String>> {
        match self {
            SettingValue::OptionString(s) => Some(s.clone()),
            _ => None,
        }
    }

    #[allow(unused)]
    fn as_window_state(&self) -> Option<WindowState> {
        match self {
            SettingValue::WindowState(ws) => Some(ws.clone()),
            SettingValue::OptionWindowState(Some(ws)) => Some(ws.clone()),
            _ => None,
        }
    }

    fn as_option_window_state(&self) -> Option<Option<WindowState>> {
        match self {
            SettingValue::OptionWindowState(ws) => Some(ws.clone()),
            SettingValue::WindowState(ws) => Some(Some(ws.clone())),
            _ => None,
        }
    }

    fn as_hashmap_string_string(&self) -> Option<HashMap<String, String>> {
        match self {
            SettingValue::HashMapStringString(m) => Some(m.clone()),
            _ => None,
        }
    }
}

// AppSettings 是 HashMap<SettingKey, SettingValue>
pub type AppSettings = HashMap<SettingKey, SettingValue>;

// 直接使用 OnceLock 存储 cells
static CELLS: OnceLock<HashMap<SettingKey, TokioMutex<SettingValue>>> = OnceLock::new();

// 防抖状态（独立保护）
struct DebounceState {
    last_modified: Option<Instant>,
    debounce_task: Option<tokio::task::JoinHandle<()>>,
}

static DEBOUNCE_STATE: OnceLock<tokio::sync::RwLock<DebounceState>> = OnceLock::new();

// 为了保持 API 兼容性，保留 Settings 结构体（但它是空的）
pub struct Settings;

// 为了向后兼容，保留 SETTINGS
static SETTINGS: OnceLock<Settings> = OnceLock::new();

impl Settings {
    /// 初始化全局 Settings（必须在首次使用前调用）
    pub fn init_global() -> Result<(), String> {
        let settings_file = Self::get_settings_file();
        let cells = Self::load_settings_map(&settings_file)?;

        CELLS
            .set(cells)
            .map_err(|_| "Settings already initialized".to_string())?;
        DEBOUNCE_STATE
            .set(tokio::sync::RwLock::new(DebounceState {
                last_modified: None,
                debounce_task: None,
            }))
            .map_err(|_| "Debounce state already initialized".to_string())?;
        SETTINGS
            .set(Settings)
            .map_err(|_| "Settings already initialized".to_string())?;

        Ok(())
    }

    /// 获取全局 Settings 引用
    pub fn global() -> &'static Settings {
        SETTINGS
            .get()
            .expect("Settings not initialized. Call Settings::init_global() first.")
    }

    /// 获取 cells（内部使用）
    fn cells() -> &'static HashMap<SettingKey, TokioMutex<SettingValue>> {
        CELLS
            .get()
            .expect("Settings not initialized. Call Settings::init_global() first.")
    }

    /// 获取防抖状态（内部使用）
    fn debounce_state() -> &'static tokio::sync::RwLock<DebounceState> {
        DEBOUNCE_STATE
            .get()
            .expect("Settings not initialized. Call Settings::init_global() first.")
    }

    fn get_settings_file() -> PathBuf {
        crate::app_paths::kabegame_data_dir().join("settings.json")
    }

    fn default_value(key: SettingKey) -> SettingValue {
        match key {
            SettingKey::AutoLaunch => SettingValue::Bool(false),
            SettingKey::MaxConcurrentDownloads => SettingValue::U32(3),
            SettingKey::NetworkRetryCount => SettingValue::U32(2),
            SettingKey::ImageClickAction => SettingValue::String("preview".to_string()),
            SettingKey::GalleryImageAspectRatio => SettingValue::OptionString(None),
            SettingKey::AutoDeduplicate => SettingValue::Bool(false),
            SettingKey::DefaultDownloadDir => SettingValue::OptionString(None),
            SettingKey::WallpaperEngineDir => SettingValue::OptionString(None),
            SettingKey::WallpaperRotationEnabled => SettingValue::Bool(false),
            SettingKey::WallpaperRotationAlbumId => SettingValue::OptionString(None),
            SettingKey::WallpaperRotationIntervalMinutes => SettingValue::U32(60),
            SettingKey::WallpaperRotationMode => SettingValue::String("random".to_string()),
            SettingKey::WallpaperStyle => {
                SettingValue::String(Self::default_wallpaper_rotation_style())
            }
            SettingKey::WallpaperRotationTransition => {
                SettingValue::String(Self::default_wallpaper_rotation_transition())
            }
            SettingKey::WallpaperStyleByMode => SettingValue::HashMapStringString(HashMap::new()),
            SettingKey::WallpaperTransitionByMode => {
                SettingValue::HashMapStringString(HashMap::new())
            }
            SettingKey::WallpaperMode => SettingValue::String(Self::default_wallpaper_mode()),
            SettingKey::WindowState => SettingValue::OptionWindowState(None),
            SettingKey::CurrentWallpaperImageId => SettingValue::OptionString(None),
            #[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
            SettingKey::AlbumDriveEnabled => SettingValue::Bool(false),
            #[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
            SettingKey::AlbumDriveMountPoint => {
                SettingValue::String(Self::default_album_drive_mount_point())
            }
        }
    }

    fn default_wallpaper_rotation_style() -> String {
        "fill".to_string()
    }

    fn default_wallpaper_rotation_transition() -> String {
        #[cfg(target_os = "windows")]
        {
            "fade".to_string()
        }
        #[cfg(not(target_os = "windows"))]
        {
            "none".to_string()
        }
    }

    fn default_wallpaper_mode() -> String {
        #[cfg(target_os = "windows")]
        {
            "window".to_string()
        }
        #[cfg(not(target_os = "windows"))]
        {
            "native".to_string()
        }
    }

    #[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
    fn default_album_drive_mount_point() -> String {
        #[cfg(target_os = "windows")]
        {
            "K:\\".to_string()
        }
        #[cfg(target_os = "linux")]
        {
            // 使用用户 home 目录下的 kabegame-vd，避免需要 root 权限
            dirs::home_dir()
                .map(|p| p.join("kabegame-vd").to_string_lossy().to_string())
                .unwrap_or_else(|| "/tmp/kabegame-vd".to_string())
        }
        #[cfg(target_os = "macos")]
        {
            // macOS 也可以使用用户目录，避免需要 root 权限
            dirs::home_dir()
                .map(|p| p.join("kabegame-vd").to_string_lossy().to_string())
                .unwrap_or_else(|| "/tmp/kabegame-vd".to_string())
        }
    }

    /// 获取系统默认的壁纸设置
    #[cfg(target_os = "windows")]
    fn get_system_wallpaper_settings() -> (String, String) {
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

                    let style = match (style_value, tile_value) {
                        (0, 1) => "tile",
                        (0, 0) => "center",
                        (2, 0) => "stretch",
                        (6, 0) => "fit",
                        (10, 0) => "fill",
                        _ => "fill",
                    };

                    (style.to_string(), "none".to_string())
                } else {
                    ("fill".to_string(), "none".to_string())
                }
            }
            Err(_) => ("fill".to_string(), "none".to_string()),
        }
    }

    #[cfg(target_os = "macos")]
    fn get_system_wallpaper_settings() -> (String, String) {
        ("fill".to_string(), "none".to_string())
    }

    #[cfg(target_os = "linux")]
    fn get_system_wallpaper_settings() -> (String, String) {
        if let Ok(output) = Command::new("gsettings")
            .args(["get", "org.gnome.desktop.background", "picture-options"])
            .output()
        {
            let output_str = String::from_utf8_lossy(&output.stdout);
            let style = match output_str.trim() {
                s if s.contains("scaled") => "fit", // 修正：scaled 对应 fit（适应）
                s if s.contains("zoom") => "fill",  // zoom 对应 fill（填充）
                s if s.contains("spanned") => "fill", // spanned 对应 fill（多屏横向拼接）
                s if s.contains("stretched") => "stretch", // stretched 对应 stretch（拉伸）
                s if s.contains("centered") => "center", // centered 对应 center（居中）
                s if s.contains("wallpaper") => "tile", // wallpaper 对应 tile（平铺）
                _ => "fill",
            };
            return (style.to_string(), "none".to_string());
        }

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
                "4" | "5" => "fill",
                _ => "fill",
            };
            return (style.to_string(), "none".to_string());
        }

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

        ("fill".to_string(), "none".to_string())
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    fn get_system_wallpaper_settings() -> (String, String) {
        ("fill".to_string(), "none".to_string())
    }

    fn load_settings_map(
        file: &Path,
    ) -> Result<HashMap<SettingKey, TokioMutex<SettingValue>>, String> {
        let mut cells = HashMap::new();

        // 初始化所有键的默认值
        let all_keys = vec![
            SettingKey::AutoLaunch,
            SettingKey::MaxConcurrentDownloads,
            SettingKey::NetworkRetryCount,
            SettingKey::ImageClickAction,
            SettingKey::GalleryImageAspectRatio,
            SettingKey::AutoDeduplicate,
            SettingKey::DefaultDownloadDir,
            SettingKey::WallpaperEngineDir,
            SettingKey::WallpaperRotationEnabled,
            SettingKey::WallpaperRotationAlbumId,
            SettingKey::WallpaperRotationIntervalMinutes,
            SettingKey::WallpaperRotationMode,
            SettingKey::WallpaperStyle,
            SettingKey::WallpaperRotationTransition,
            SettingKey::WallpaperStyleByMode,
            SettingKey::WallpaperTransitionByMode,
            SettingKey::WallpaperMode,
            SettingKey::WindowState,
            SettingKey::CurrentWallpaperImageId,
            #[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
            SettingKey::AlbumDriveEnabled,
            #[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
            SettingKey::AlbumDriveMountPoint,
        ];

        // 先读取 JSON（如果存在）
        let json_value = if file.exists() {
            let mut content =
                fs::read_to_string(file).map_err(|e| format!("读取设置文件失败！ {}", e))?;

            // 处理空文件
            if content.trim().is_empty() {
                for _ in 0..3 {
                    std::thread::sleep(Duration::from_millis(20));
                    content = fs::read_to_string(file)
                        .map_err(|e| format!("Failed to read settings file: {}", e))?;
                    if !content.trim().is_empty() {
                        break;
                    }
                }
            }

            // TODO: 落回到默认设置
            if !content.trim().is_empty() {
                match serde_json::from_str::<serde_json::Value>(&content) {
                    Ok(json) => Some(json),
                    Err(e) => {
                        eprintln!("[Warn] Failed to parse settings JSON: {}", e);
                        None
                    }
                }
            } else {
                None
            }
        } else {
            None
        };

        // 创建所有键的值（从 JSON 读取或使用默认值）
        for key in all_keys {
            let value = if let Some(ref json) = json_value {
                Self::get_value_from_json(key, json).unwrap_or_else(|| Self::default_value(key))
            } else {
                Self::default_value(key)
            };
            cells.insert(key, TokioMutex::new(value));
        }

        // 如果文件不存在或为空，使用系统默认值覆盖壁纸相关设置
        if json_value.is_none() {
            let (style, transition) = Self::get_system_wallpaper_settings();
            *cells.get_mut(&SettingKey::WallpaperStyle).unwrap() =
                TokioMutex::new(SettingValue::String(style));
            *cells
                .get_mut(&SettingKey::WallpaperRotationTransition)
                .unwrap() = TokioMutex::new(SettingValue::String(transition));
        }

        Ok(cells)
    }

    fn get_value_from_json(key: SettingKey, json: &serde_json::Value) -> Option<SettingValue> {
        // 兼容历史键名
        let value = match key {
            SettingKey::WallpaperStyleByMode => json
                .get("wallpaperStyleByMode")
                .or_else(|| json.get("wallpaper_style_by_mode")),
            SettingKey::WallpaperTransitionByMode => json
                .get("wallpaperTransitionByMode")
                .or_else(|| json.get("wallpaper_transition_by_mode")),
            _ => {
                let key_str = Self::key_to_json_string(key);
                json.get(&key_str)
            }
        }?;
        Self::json_value_to_setting_value(key, value).ok()
    }

    fn json_value_to_setting_value(
        key: SettingKey,
        json: &serde_json::Value,
    ) -> Result<SettingValue, String> {
        // json 参数已经是值了，不需要再次查找
        match key {
            SettingKey::AutoLaunch
            | SettingKey::AutoDeduplicate
            | SettingKey::WallpaperRotationEnabled => {
                Ok(SettingValue::Bool(json.as_bool().unwrap_or(false)))
            }
            #[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
            SettingKey::AlbumDriveEnabled => {
                Ok(SettingValue::Bool(json.as_bool().unwrap_or(false)))
            }
            SettingKey::MaxConcurrentDownloads
            | SettingKey::NetworkRetryCount
            | SettingKey::WallpaperRotationIntervalMinutes => {
                Ok(SettingValue::U32(json.as_u64().unwrap_or(0) as u32))
            }
            SettingKey::ImageClickAction
            | SettingKey::WallpaperRotationMode
            | SettingKey::WallpaperStyle
            | SettingKey::WallpaperRotationTransition
            | SettingKey::WallpaperMode => Ok(SettingValue::String(
                json.as_str().unwrap_or("").to_string(),
            )),
            #[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
            SettingKey::AlbumDriveMountPoint => Ok(SettingValue::String(
                json.as_str().unwrap_or("").to_string(),
            )),
            SettingKey::GalleryImageAspectRatio
            | SettingKey::DefaultDownloadDir
            | SettingKey::WallpaperEngineDir
            | SettingKey::CurrentWallpaperImageId => match json {
                serde_json::Value::String(s) if !s.trim().is_empty() => {
                    Ok(SettingValue::OptionString(Some(s.clone())))
                }
                _ => Ok(SettingValue::OptionString(None)),
            },
            SettingKey::WallpaperRotationAlbumId => {
                match json {
                    serde_json::Value::String(s) => {
                        // 空字符串表示全画廊轮播，需要保留
                        Ok(SettingValue::OptionString(Some(s.clone())))
                    }
                    _ => Ok(SettingValue::OptionString(None)),
                }
            }
            SettingKey::WallpaperStyleByMode | SettingKey::WallpaperTransitionByMode => {
                let mut map = HashMap::new();
                if let Some(obj) = json.as_object() {
                    for (k, v) in obj {
                        if let Some(s) = v.as_str() {
                            map.insert(k.clone(), s.to_string());
                        }
                    }
                }
                Ok(SettingValue::HashMapStringString(map))
            }
            SettingKey::WindowState => {
                if let Ok(ws) = serde_json::from_value::<WindowState>(json.clone()) {
                    Ok(SettingValue::OptionWindowState(Some(ws)))
                } else {
                    Ok(SettingValue::OptionWindowState(None))
                }
            }
        }
    }

    /// 序列化当前所有设置到 JSON
    async fn serialize_to_json() -> Result<serde_json::Value, String> {
        let cells = Self::cells();
        let mut json_map = serde_json::Map::new();

        // 按 SettingKey 顺序获取所有值
        let keys: Vec<SettingKey> = cells.keys().cloned().collect();
        for key in keys {
            if let Some(cell) = cells.get(&key) {
                let val = cell.lock().await;
                let json_val = Self::setting_value_to_json(key, &val)?;
                let key_str = Self::key_to_json_string(key);
                json_map.insert(key_str, json_val);
            }
        }

        Ok(serde_json::Value::Object(json_map))
    }

    fn key_to_json_string(key: SettingKey) -> String {
        match key {
            SettingKey::AutoLaunch => "autoLaunch".to_string(),
            SettingKey::MaxConcurrentDownloads => "maxConcurrentDownloads".to_string(),
            SettingKey::NetworkRetryCount => "networkRetryCount".to_string(),
            SettingKey::ImageClickAction => "imageClickAction".to_string(),
            SettingKey::GalleryImageAspectRatio => "galleryImageAspectRatio".to_string(),
            SettingKey::AutoDeduplicate => "autoDeduplicate".to_string(),
            SettingKey::DefaultDownloadDir => "defaultDownloadDir".to_string(),
            SettingKey::WallpaperEngineDir => "wallpaperEngineDir".to_string(),
            SettingKey::WallpaperRotationEnabled => "wallpaperRotationEnabled".to_string(),
            SettingKey::WallpaperRotationAlbumId => "wallpaperRotationAlbumId".to_string(),
            SettingKey::WallpaperRotationIntervalMinutes => {
                "wallpaperRotationIntervalMinutes".to_string()
            }
            SettingKey::WallpaperRotationMode => "wallpaperRotationMode".to_string(),
            SettingKey::WallpaperStyle => "wallpaperStyle".to_string(),
            SettingKey::WallpaperRotationTransition => "wallpaperRotationTransition".to_string(),
            SettingKey::WallpaperStyleByMode => "wallpaperStyleByMode".to_string(),
            SettingKey::WallpaperTransitionByMode => "wallpaperTransitionByMode".to_string(),
            SettingKey::WallpaperMode => "wallpaperMode".to_string(),
            SettingKey::WindowState => "windowState".to_string(),
            SettingKey::CurrentWallpaperImageId => "currentWallpaperImageId".to_string(),
            #[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
            SettingKey::AlbumDriveEnabled => "albumDriveEnabled".to_string(),
            #[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
            SettingKey::AlbumDriveMountPoint => "albumDriveMountPoint".to_string(),
        }
    }

    fn setting_value_to_json(
        _key: SettingKey,
        val: &SettingValue,
    ) -> Result<serde_json::Value, String> {
        match val {
            SettingValue::Bool(b) => Ok(serde_json::Value::Bool(*b)),
            SettingValue::U32(n) => Ok(serde_json::Value::Number((*n).into())),
            SettingValue::String(s) => Ok(serde_json::Value::String(s.clone())),
            SettingValue::OptionString(opt) => match opt {
                Some(s) => Ok(serde_json::Value::String(s.clone())),
                None => Ok(serde_json::Value::Null),
            },
            SettingValue::WindowState(ws) => serde_json::to_value(ws)
                .map_err(|e| format!("Failed to serialize WindowState: {}", e)),
            SettingValue::OptionWindowState(opt) => match opt {
                Some(ws) => serde_json::to_value(ws)
                    .map_err(|e| format!("Failed to serialize WindowState: {}", e)),
                None => Ok(serde_json::Value::Null),
            },
            SettingValue::HashMapStringString(map) => {
                let mut json_map = serde_json::Map::new();
                for (k, v) in map {
                    json_map.insert(k.clone(), serde_json::Value::String(v.clone()));
                }
                Ok(serde_json::Value::Object(json_map))
            }
        }
    }

    /// 发送设置变更事件
    async fn emit_setting_change(key: SettingKey, value: &SettingValue) {
        // 尝试通过 GlobalEmitter 发送事件
        if let Some(emitter) = GlobalEmitter::try_global() {
            // 将 SettingKey 和 SettingValue 转换为 JSON
            let key_str = Self::key_to_json_string(key);
            let json_value = match Self::setting_value_to_json(key, value) {
                Ok(v) => v,
                Err(_) => return, // 序列化失败，跳过发送
            };

            // 构造 changes 对象
            let changes = serde_json::json!({
                key_str: json_value
            });
            emitter.emit_setting_change(changes);
        }
    }

    /// 触发防抖写盘
    async fn trigger_debounce_save() -> Result<(), String> {
        let state = Self::debounce_state();
        let mut state_guard = state.write().await;
        state_guard.last_modified = Some(Instant::now());

        // 取消之前的任务
        if let Some(task) = state_guard.debounce_task.take() {
            task.abort();
        }

        let file = Self::get_settings_file();

        let task = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(5)).await;

            let should_write = {
                let state = Self::debounce_state();
                let state_guard = state.read().await;
                state_guard
                    .last_modified
                    .map(|t| t.elapsed() >= Duration::from_secs(4))
                    .unwrap_or(false)
            };

            if should_write {
                if let Some(parent) = file.parent() {
                    let _ = fs::create_dir_all(parent);
                }

                // 序列化并写入
                if let Ok(json_val) = Self::serialize_to_json().await {
                    if let Ok(content) = serde_json::to_string_pretty(&json_val) {
                        let tmp = file.with_extension("json.tmp");
                        if fs::write(&tmp, content).is_ok() {
                            let _ = atomic_replace_file(&tmp, &file);
                        }
                    }
                }
            }
        });

        state_guard.debounce_task = Some(task);
        Ok(())
    }

    /// 立即写入文件
    // async fn save_immediate() -> Result<(), String> {
    //     let file = Self::get_settings_file();

    //     if let Some(parent) = file.parent() {
    //         fs::create_dir_all(parent)
    //             .map_err(|e| format!("Failed to create settings directory: {}", e))?;
    //     }

    //     let json_val = Self::serialize_to_json().await?;
    //     let content = serde_json::to_string_pretty(&json_val)
    //         .map_err(|e| format!("Failed to serialize settings: {}", e))?;

    //     let tmp = file.with_extension("json.tmp");
    //     fs::write(&tmp, content)
    //         .map_err(|e| format!("Failed to write temp settings file: {}", e))?;
    //     atomic_replace_file(&tmp, &file)?;

    //     Ok(())
    // }

    // ========== Getter 方法 ==========

    pub async fn get_auto_launch(&self) -> Result<bool, String> {
        let cells = Self::cells();
        if let Some(cell) = cells.get(&SettingKey::AutoLaunch) {
            let val = cell.lock().await;
            Ok(val.as_bool().unwrap_or(false))
        } else {
            Ok(false)
        }
    }

    pub async fn get_max_concurrent_downloads(&self) -> Result<u32, String> {
        let cells = Self::cells();
        if let Some(cell) = cells.get(&SettingKey::MaxConcurrentDownloads) {
            let val = cell.lock().await;
            Ok(val.as_u32().unwrap_or(3))
        } else {
            Ok(3)
        }
    }

    pub async fn get_network_retry_count(&self) -> Result<u32, String> {
        let cells = Self::cells();
        if let Some(cell) = cells.get(&SettingKey::NetworkRetryCount) {
            let val = cell.lock().await;
            Ok(val.as_u32().unwrap_or(2))
        } else {
            Ok(2)
        }
    }

    pub async fn get_image_click_action(&self) -> Result<String, String> {
        let cells = Self::cells();
        if let Some(cell) = cells.get(&SettingKey::ImageClickAction) {
            let val = cell.lock().await;
            Ok(val.as_string().unwrap_or_else(|| "preview".to_string()))
        } else {
            Ok("preview".to_string())
        }
    }

    pub async fn get_gallery_image_aspect_ratio(&self) -> Result<Option<String>, String> {
        let cells = Self::cells();
        if let Some(cell) = cells.get(&SettingKey::GalleryImageAspectRatio) {
            let val = cell.lock().await;
            Ok(val.as_option_string().unwrap_or(None))
        } else {
            Ok(None)
        }
    }

    pub async fn get_auto_deduplicate(&self) -> Result<bool, String> {
        let cells = Self::cells();
        if let Some(cell) = cells.get(&SettingKey::AutoDeduplicate) {
            let val = cell.lock().await;
            Ok(val.as_bool().unwrap_or(false))
        } else {
            Ok(false)
        }
    }

    pub async fn get_default_download_dir(&self) -> Result<Option<String>, String> {
        let cells = Self::cells();
        if let Some(cell) = cells.get(&SettingKey::DefaultDownloadDir) {
            let val = cell.lock().await;
            Ok(val.as_option_string().unwrap_or(None))
        } else {
            Ok(None)
        }
    }

    pub async fn get_wallpaper_engine_dir(&self) -> Result<Option<String>, String> {
        let cells = Self::cells();
        if let Some(cell) = cells.get(&SettingKey::WallpaperEngineDir) {
            let val = cell.lock().await;
            Ok(val.as_option_string().unwrap_or(None))
        } else {
            Ok(None)
        }
    }

    pub async fn get_wallpaper_rotation_enabled(&self) -> Result<bool, String> {
        let cells = Self::cells();
        if let Some(cell) = cells.get(&SettingKey::WallpaperRotationEnabled) {
            let val = cell.lock().await;
            Ok(val.as_bool().unwrap_or(false))
        } else {
            Ok(false)
        }
    }

    pub async fn get_wallpaper_rotation_album_id(&self) -> Result<Option<String>, String> {
        let cells = Self::cells();
        if let Some(cell) = cells.get(&SettingKey::WallpaperRotationAlbumId) {
            let val = cell.lock().await;
            Ok(val.as_option_string().unwrap_or(None))
        } else {
            Ok(None)
        }
    }

    pub async fn get_wallpaper_rotation_interval_minutes(&self) -> Result<u32, String> {
        let cells = Self::cells();
        if let Some(cell) = cells.get(&SettingKey::WallpaperRotationIntervalMinutes) {
            let val = cell.lock().await;
            Ok(val.as_u32().unwrap_or(60))
        } else {
            Ok(60)
        }
    }

    pub async fn get_wallpaper_rotation_mode(&self) -> Result<String, String> {
        let cells = Self::cells();
        if let Some(cell) = cells.get(&SettingKey::WallpaperRotationMode) {
            let val = cell.lock().await;
            Ok(val.as_string().unwrap_or_else(|| "random".to_string()))
        } else {
            Ok("random".to_string())
        }
    }

    pub async fn get_wallpaper_rotation_style(&self) -> Result<String, String> {
        let cells = Self::cells();
        if let Some(cell) = cells.get(&SettingKey::WallpaperStyle) {
            let val = cell.lock().await;
            Ok(val.as_string().unwrap_or_else(|| "fill".to_string()))
        } else {
            Ok("fill".to_string())
        }
    }

    pub async fn get_wallpaper_rotation_transition(&self) -> Result<String, String> {
        let cells = Self::cells();
        if let Some(cell) = cells.get(&SettingKey::WallpaperRotationTransition) {
            let val = cell.lock().await;
            Ok(val
                .as_string()
                .unwrap_or_else(|| Self::default_wallpaper_rotation_transition()))
        } else {
            Ok(Self::default_wallpaper_rotation_transition())
        }
    }

    pub async fn get_wallpaper_style_by_mode(&self) -> Result<HashMap<String, String>, String> {
        let cells = Self::cells();
        if let Some(cell) = cells.get(&SettingKey::WallpaperStyleByMode) {
            let val = cell.lock().await;
            Ok(val.as_hashmap_string_string().unwrap_or_default())
        } else {
            Ok(HashMap::new())
        }
    }

    pub async fn get_wallpaper_transition_by_mode(
        &self,
    ) -> Result<HashMap<String, String>, String> {
        let cells = Self::cells();
        if let Some(cell) = cells.get(&SettingKey::WallpaperTransitionByMode) {
            let val = cell.lock().await;
            Ok(val.as_hashmap_string_string().unwrap_or_default())
        } else {
            Ok(HashMap::new())
        }
    }

    pub async fn get_wallpaper_mode(&self) -> Result<String, String> {
        let cells = Self::cells();
        if let Some(cell) = cells.get(&SettingKey::WallpaperMode) {
            let val = cell.lock().await;
            Ok(val
                .as_string()
                .unwrap_or_else(|| Self::default_wallpaper_mode()))
        } else {
            Ok(Self::default_wallpaper_mode())
        }
    }

    pub async fn get_window_state(&self) -> Result<Option<WindowState>, String> {
        let cells = Self::cells();
        if let Some(cell) = cells.get(&SettingKey::WindowState) {
            let val = cell.lock().await;
            Ok(val.as_option_window_state().unwrap_or(None))
        } else {
            Ok(None)
        }
    }

    pub async fn get_current_wallpaper_image_id(&self) -> Result<Option<String>, String> {
        let cells = Self::cells();
        if let Some(cell) = cells.get(&SettingKey::CurrentWallpaperImageId) {
            let val = cell.lock().await;
            Ok(val.as_option_string().unwrap_or(None))
        } else {
            Ok(None)
        }
    }

    #[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
    pub async fn get_album_drive_enabled(&self) -> Result<bool, String> {
        let cells = Self::cells();
        if let Some(cell) = cells.get(&SettingKey::AlbumDriveEnabled) {
            let val = cell.lock().await;
            Ok(val.as_bool().unwrap_or(false))
        } else {
            Ok(false)
        }
    }

    #[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
    pub async fn get_album_drive_mount_point(&self) -> Result<String, String> {
        let cells = Self::cells();
        if let Some(cell) = cells.get(&SettingKey::AlbumDriveMountPoint) {
            let val = cell.lock().await;
            Ok(val
                .as_string()
                .unwrap_or_else(|| Self::default_album_drive_mount_point()))
        } else {
            Ok(Self::default_album_drive_mount_point())
        }
    }

    // ========== Setter 方法 ==========

    pub async fn set_auto_launch(&self, enabled: bool) -> Result<(), String> {
        let cells = Self::cells();
        let new_value = SettingValue::Bool(enabled);
        if let Some(cell) = cells.get(&SettingKey::AutoLaunch) {
            let mut val = cell.lock().await;
            *val = new_value.clone();
        }
        Self::emit_setting_change(SettingKey::AutoLaunch, &new_value).await;
        Self::trigger_debounce_save().await?;

        // 设置开机启动（Windows、Linux、macOS 共用逻辑）
        #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
        {
            use auto_launch::AutoLaunchBuilder;
            let app_path = std::env::current_exe()
                .map_err(|e| format!("Failed to get current exe path: {}", e))?;
            let app_path_str = app_path.to_str().unwrap();

            let mut builder = AutoLaunchBuilder::new();
            builder.set_app_name("Kabegame");
            builder.set_app_path(app_path_str);
            
            // 如果启用开机启动，添加 --auto-startup 参数
            if enabled {
                builder.set_args(&["--auto-startup"]);
            }

            let auto_launch = builder
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

        Ok(())
    }

    pub async fn set_max_concurrent_downloads(&self, count: u32) -> Result<(), String> {
        let cells = Self::cells();
        let new_value = SettingValue::U32(count);
        if let Some(cell) = cells.get(&SettingKey::MaxConcurrentDownloads) {
            let mut val = cell.lock().await;
            *val = new_value.clone();
        }
        Self::emit_setting_change(SettingKey::MaxConcurrentDownloads, &new_value).await;
        Self::trigger_debounce_save().await?;
        Ok(())
    }

    pub async fn set_network_retry_count(&self, count: u32) -> Result<(), String> {
        let cells = Self::cells();
        let new_value = SettingValue::U32(count);
        if let Some(cell) = cells.get(&SettingKey::NetworkRetryCount) {
            let mut val = cell.lock().await;
            *val = new_value.clone();
        }
        Self::emit_setting_change(SettingKey::NetworkRetryCount, &new_value).await;
        Self::trigger_debounce_save().await?;
        Ok(())
    }

    pub async fn set_image_click_action(&self, action: String) -> Result<(), String> {
        let cells = Self::cells();
        let new_value = SettingValue::String(action);
        if let Some(cell) = cells.get(&SettingKey::ImageClickAction) {
            let mut val = cell.lock().await;
            *val = new_value.clone();
        }
        Self::emit_setting_change(SettingKey::ImageClickAction, &new_value).await;
        Self::trigger_debounce_save().await?;
        Ok(())
    }

    pub async fn set_gallery_image_aspect_ratio(
        &self,
        aspect_ratio: Option<String>,
    ) -> Result<(), String> {
        let cells = Self::cells();
        let new_value = SettingValue::OptionString(aspect_ratio);
        if let Some(cell) = cells.get(&SettingKey::GalleryImageAspectRatio) {
            let mut val = cell.lock().await;
            *val = new_value.clone();
        }
        Self::emit_setting_change(SettingKey::GalleryImageAspectRatio, &new_value).await;
        Self::trigger_debounce_save().await?;
        Ok(())
    }

    pub async fn set_auto_deduplicate(&self, enabled: bool) -> Result<(), String> {
        let cells = Self::cells();
        let new_value = SettingValue::Bool(enabled);
        if let Some(cell) = cells.get(&SettingKey::AutoDeduplicate) {
            let mut val = cell.lock().await;
            *val = new_value.clone();
        }
        Self::emit_setting_change(SettingKey::AutoDeduplicate, &new_value).await;
        Self::trigger_debounce_save().await?;
        Ok(())
    }

    pub async fn set_default_download_dir(&self, dir: Option<String>) -> Result<(), String> {
        let normalized = dir.and_then(|s| {
            let t = s.trim().to_string();
            if t.is_empty() {
                None
            } else {
                Some(t)
            }
        });

        // 若提供了目录，则做基本校验
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

        let cells = Self::cells();
        let new_value = SettingValue::OptionString(normalized.clone());
        if let Some(cell) = cells.get(&SettingKey::DefaultDownloadDir) {
            let mut val = cell.lock().await;
            *val = new_value.clone();
        }
        Self::emit_setting_change(SettingKey::DefaultDownloadDir, &new_value).await;
        Self::trigger_debounce_save().await?;
        Ok(())
    }

    pub async fn set_wallpaper_engine_dir(&self, dir: Option<String>) -> Result<(), String> {
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

        let cells = Self::cells();
        let new_value = SettingValue::OptionString(normalized.clone());
        if let Some(cell) = cells.get(&SettingKey::WallpaperEngineDir) {
            let mut val = cell.lock().await;
            *val = new_value.clone();
        }
        Self::emit_setting_change(SettingKey::WallpaperEngineDir, &new_value).await;
        Self::trigger_debounce_save().await?;
        Ok(())
    }

    pub async fn get_wallpaper_engine_myprojects_dir(&self) -> Result<Option<String>, String> {
        let base = self.get_wallpaper_engine_dir().await?;
        let Some(ref base) = base else {
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

        Ok(None)
    }

    pub async fn set_wallpaper_rotation_enabled(&self, enabled: bool) -> Result<(), String> {
        let cells = Self::cells();
        let new_value = SettingValue::Bool(enabled);
        if let Some(cell) = cells.get(&SettingKey::WallpaperRotationEnabled) {
            let mut val = cell.lock().await;
            *val = new_value.clone();
        }
        Self::emit_setting_change(SettingKey::WallpaperRotationEnabled, &new_value).await;
        Self::trigger_debounce_save().await?;
        Ok(())
    }

    pub async fn set_wallpaper_rotation_album_id(
        &self,
        album_id: Option<String>,
    ) -> Result<(), String> {
        let cells = Self::cells();
        let new_value = SettingValue::OptionString(album_id);
        if let Some(cell) = cells.get(&SettingKey::WallpaperRotationAlbumId) {
            let mut val = cell.lock().await;
            *val = new_value.clone();
        }
        Self::emit_setting_change(SettingKey::WallpaperRotationAlbumId, &new_value).await;
        Self::trigger_debounce_save().await?;
        Ok(())
    }

    pub async fn set_wallpaper_rotation_interval_minutes(
        &self,
        minutes: u32,
    ) -> Result<(), String> {
        let cells = Self::cells();
        let new_value = SettingValue::U32(minutes);
        if let Some(cell) = cells.get(&SettingKey::WallpaperRotationIntervalMinutes) {
            let mut val = cell.lock().await;
            *val = new_value.clone();
        }
        Self::emit_setting_change(SettingKey::WallpaperRotationIntervalMinutes, &new_value).await;
        Self::trigger_debounce_save().await?;
        Ok(())
    }

    pub async fn set_wallpaper_rotation_mode(&self, mode: String) -> Result<(), String> {
        let cells = Self::cells();
        let new_value = SettingValue::String(mode);
        if let Some(cell) = cells.get(&SettingKey::WallpaperRotationMode) {
            let mut val = cell.lock().await;
            *val = new_value.clone();
        }
        Self::emit_setting_change(SettingKey::WallpaperRotationMode, &new_value).await;
        Self::trigger_debounce_save().await?;
        Ok(())
    }

    pub async fn set_wallpaper_style(&self, style: String) -> Result<(), String> {
        let mode = self.get_wallpaper_mode().await?;
        let cells = Self::cells();

        // 更新 style
        let new_style_value = SettingValue::String(style.clone());
        if let Some(cell) = cells.get(&SettingKey::WallpaperStyle) {
            let mut val = cell.lock().await;
            *val = new_style_value.clone();
        }

        // 更新 style_by_mode
        let mut style_by_mode_value = None;
        if let Some(cell) = cells.get(&SettingKey::WallpaperStyleByMode) {
            let mut val = cell.lock().await;
            if let SettingValue::HashMapStringString(ref mut map) = *val {
                map.insert(mode.clone(), style);
                style_by_mode_value = Some(SettingValue::HashMapStringString(map.clone()));
            }
        }

        Self::emit_setting_change(SettingKey::WallpaperStyle, &new_style_value).await;
        if let Some(ref v) = style_by_mode_value {
            Self::emit_setting_change(SettingKey::WallpaperStyleByMode, v).await;
        }

        Self::trigger_debounce_save().await?;
        Ok(())
    }

    pub async fn set_wallpaper_rotation_transition(
        &self,
        transition: String,
    ) -> Result<(), String> {
        let mode = self.get_wallpaper_mode().await?;
        let cells = Self::cells();

        // 更新 transition
        let new_transition_value = SettingValue::String(transition.clone());
        if let Some(cell) = cells.get(&SettingKey::WallpaperRotationTransition) {
            let mut val = cell.lock().await;
            *val = new_transition_value.clone();
        }

        // 更新 transition_by_mode
        let mut transition_by_mode_value = None;
        if let Some(cell) = cells.get(&SettingKey::WallpaperTransitionByMode) {
            let mut val = cell.lock().await;
            if let SettingValue::HashMapStringString(ref mut map) = *val {
                map.insert(mode.clone(), transition);
                transition_by_mode_value = Some(SettingValue::HashMapStringString(map.clone()));
            }
        }

        Self::emit_setting_change(
            SettingKey::WallpaperRotationTransition,
            &new_transition_value,
        )
        .await;
        if let Some(ref v) = transition_by_mode_value {
            Self::emit_setting_change(SettingKey::WallpaperTransitionByMode, v).await;
        }

        Self::trigger_debounce_save().await?;
        Ok(())
    }

    pub async fn set_wallpaper_mode(&self, mode: String) -> Result<(), String> {
        let cells = Self::cells();
        let new_value = SettingValue::String(mode);
        if let Some(cell) = cells.get(&SettingKey::WallpaperMode) {
            let mut val = cell.lock().await;
            *val = new_value.clone();
        }
        Self::emit_setting_change(SettingKey::WallpaperMode, &new_value).await;
        Self::trigger_debounce_save().await?;
        Ok(())
    }

    pub async fn save_window_state(&self, window_state: WindowState) -> Result<(), String> {
        let cells = Self::cells();
        let new_value = SettingValue::OptionWindowState(Some(window_state));
        if let Some(cell) = cells.get(&SettingKey::WindowState) {
            let mut val = cell.lock().await;
            *val = new_value.clone();
        }
        Self::emit_setting_change(SettingKey::WindowState, &new_value).await;
        Self::trigger_debounce_save().await?;
        Ok(())
    }

    pub async fn clear_window_state(&self) -> Result<(), String> {
        let cells = Self::cells();
        let new_value = SettingValue::OptionWindowState(None);
        if let Some(cell) = cells.get(&SettingKey::WindowState) {
            let mut val = cell.lock().await;
            *val = new_value.clone();
        }
        Self::emit_setting_change(SettingKey::WindowState, &new_value).await;
        Self::trigger_debounce_save().await?;
        Ok(())
    }

    #[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
    pub async fn set_album_drive_enabled(&self, enabled: bool) -> Result<(), String> {
        let cells = Self::cells();
        let new_value = SettingValue::Bool(enabled);
        if let Some(cell) = cells.get(&SettingKey::AlbumDriveEnabled) {
            let mut val = cell.lock().await;
            *val = new_value.clone();
        }
        Self::emit_setting_change(SettingKey::AlbumDriveEnabled, &new_value).await;
        Self::trigger_debounce_save().await?;
        Ok(())
    }

    #[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
    pub async fn set_album_drive_mount_point(&self, mount_point: String) -> Result<(), String> {
        let t = mount_point.trim().to_string();
        if t.is_empty() {
            return Err("挂载点不能为空".to_string());
        }
        let cells = Self::cells();
        let new_value = SettingValue::String(t.clone());
        if let Some(cell) = cells.get(&SettingKey::AlbumDriveMountPoint) {
            let mut val = cell.lock().await;
            *val = new_value.clone();
        }
        Self::emit_setting_change(SettingKey::AlbumDriveMountPoint, &new_value).await;
        Self::trigger_debounce_save().await?;
        Ok(())
    }

    pub async fn set_current_wallpaper_image_id(
        &self,
        image_id: Option<String>,
    ) -> Result<(), String> {
        let normalized = image_id.and_then(|s| {
            let t = s.trim().to_string();
            if t.is_empty() {
                None
            } else {
                Some(t)
            }
        });
        let cells = Self::cells();
        let new_value = SettingValue::OptionString(normalized);
        if let Some(cell) = cells.get(&SettingKey::CurrentWallpaperImageId) {
            let mut val = cell.lock().await;
            *val = new_value.clone();
        }
        Self::emit_setting_change(SettingKey::CurrentWallpaperImageId, &new_value).await;
        Self::trigger_debounce_save().await?;
        Ok(())
    }

    /// 切换模式前调用：交换 style/transition
    pub async fn swap_style_transition_for_mode_switch(
        &self,
        old_mode: &str,
        new_mode: &str,
    ) -> Result<(String, String), String> {
        // 获取当前值
        let cur_style = self.get_wallpaper_rotation_style().await?;
        let cur_transition = self.get_wallpaper_rotation_transition().await?;

        // 缓存旧模式的值
        let mut style_by_mode = self.get_wallpaper_style_by_mode().await?;
        let mut transition_by_mode = self.get_wallpaper_transition_by_mode().await?;
        style_by_mode.insert(old_mode.to_string(), cur_style.clone());
        transition_by_mode.insert(old_mode.to_string(), cur_transition.clone());

        // 尽量保留当前值
        let mut next_style = Self::normalize_style_for_mode(new_mode, &cur_style);
        let mut next_transition = Self::normalize_transition_for_mode(new_mode, &cur_transition);

        // 如果 normalize 改变了值，尝试用新模式缓存兜底
        if next_style != cur_style {
            if let Some(v) = style_by_mode.get(new_mode).cloned() {
                next_style = Self::normalize_style_for_mode(new_mode, &v);
            }
        }
        if next_transition != cur_transition {
            if let Some(v) = transition_by_mode.get(new_mode).cloned() {
                next_transition = Self::normalize_transition_for_mode(new_mode, &v);
            }
        }

        // 更新当前值和缓存
        style_by_mode.insert(new_mode.to_string(), next_style.clone());
        transition_by_mode.insert(new_mode.to_string(), next_transition.clone());

        let cells = Self::cells();
        let new_style_value = SettingValue::String(next_style.clone());
        let new_transition_value = SettingValue::String(next_transition.clone());
        let new_style_by_mode_value = SettingValue::HashMapStringString(style_by_mode.clone());
        let new_transition_by_mode_value =
            SettingValue::HashMapStringString(transition_by_mode.clone());

        if let Some(cell) = cells.get(&SettingKey::WallpaperStyle) {
            let mut val = cell.lock().await;
            *val = new_style_value.clone();
        }
        if let Some(cell) = cells.get(&SettingKey::WallpaperRotationTransition) {
            let mut val = cell.lock().await;
            *val = new_transition_value.clone();
        }
        if let Some(cell) = cells.get(&SettingKey::WallpaperStyleByMode) {
            let mut val = cell.lock().await;
            *val = new_style_by_mode_value.clone();
        }
        if let Some(cell) = cells.get(&SettingKey::WallpaperTransitionByMode) {
            let mut val = cell.lock().await;
            *val = new_transition_by_mode_value.clone();
        }

        Self::emit_setting_change(SettingKey::WallpaperStyle, &new_style_value).await;
        Self::emit_setting_change(
            SettingKey::WallpaperRotationTransition,
            &new_transition_value,
        )
        .await;
        Self::emit_setting_change(SettingKey::WallpaperStyleByMode, &new_style_by_mode_value).await;
        Self::emit_setting_change(
            SettingKey::WallpaperTransitionByMode,
            &new_transition_by_mode_value,
        )
        .await;
        Self::trigger_debounce_save().await?;

        Ok((next_style, next_transition))
    }

    fn normalize_transition_for_mode(mode: &str, transition: &str) -> String {
        if mode == "native" {
            match transition {
                "none" | "fade" => transition.to_string(),
                _ => "none".to_string(),
            }
        } else {
            transition.to_string()
        }
    }

    fn normalize_style_for_mode(mode: &str, style: &str) -> String {
        if mode != "native" {
            return style.to_string();
        }

        #[cfg(target_os = "windows")]
        {
            return style.to_string();
        }

        #[cfg(target_os = "macos")]
        {
            let supported = ["fill", "center"];
            if supported.contains(&style) {
                return style.to_string();
            }
            return "fill".to_string();
        }

        #[cfg(target_os = "linux")]
        {
            return style.to_string();
        }

        #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
        {
            "fill".to_string()
        }
    }
}
