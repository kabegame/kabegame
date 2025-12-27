use crate::settings::Settings;
use crate::storage::Storage;
#[cfg(target_os = "windows")]
use crate::wallpaper_window::WallpaperWindow;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};
use tokio::time::{interval, Duration};

pub struct WallpaperRotator {
    app: AppHandle,
    running: Arc<AtomicBool>,
    current_index: Arc<Mutex<usize>>,              // 用于顺序模式
    current_wallpaper: Arc<Mutex<Option<String>>>, // 当前壁纸路径
    #[cfg(target_os = "windows")]
    wallpaper_window: Arc<Mutex<Option<WallpaperWindow>>>, // 窗口壁纸（仅 Windows）
}

impl WallpaperRotator {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            running: Arc::new(AtomicBool::new(false)),
            current_index: Arc::new(Mutex::new(0)),
            current_wallpaper: Arc::new(Mutex::new(None)),
            #[cfg(target_os = "windows")]
            wallpaper_window: Arc::new(Mutex::new(None)),
        }
    }

    pub fn start(&self) -> Result<(), String> {
        if self.running.load(Ordering::Relaxed) {
            return Ok(()); // 已经在运行
        }

        self.running.store(true, Ordering::Relaxed);
        let app = self.app.clone();
        let running = Arc::clone(&self.running);
        let current_index = Arc::clone(&self.current_index);
        let current_wallpaper = Arc::clone(&self.current_wallpaper);
        #[cfg(target_os = "windows")]
        let wallpaper_window = Arc::clone(&self.wallpaper_window);

        // 在新线程中创建 Tokio runtime
        std::thread::spawn(move || {
            // 创建新的 Tokio runtime
            let rt = tokio::runtime::Runtime::new().expect("Failed to create Tokio runtime");

            rt.block_on(async move {
                use tauri::Manager;
                let mut interval_timer = interval(Duration::from_secs(60)); // 每分钟检查一次

                loop {
                    interval_timer.tick().await;

                    if !running.load(Ordering::Relaxed) {
                        break;
                    }

                    // 获取设置
                    let settings_state = match app.try_state::<Settings>() {
                        Some(state) => state,
                        None => {
                            eprintln!("无法获取设置状态");
                            continue;
                        }
                    };
                    let settings = match settings_state.get_settings() {
                        Ok(s) => s,
                        Err(e) => {
                            eprintln!("获取设置失败: {}", e);
                            continue;
                        }
                    };

                    // 检查是否启用轮播
                    if !settings.wallpaper_rotation_enabled {
                        continue;
                    }

                    // 检查是否有选中的画册
                    let album_id: String = match &settings.wallpaper_rotation_album_id {
                        Some(id) => id.clone(),
                        None => continue,
                    };

                    // 获取画册图片
                    let storage = match app.try_state::<Storage>() {
                        Some(state) => state,
                        None => {
                            eprintln!("无法获取存储状态");
                            continue;
                        }
                    };
                    let images: Vec<crate::storage::ImageInfo> =
                        match storage.get_album_images(&album_id) {
                            Ok(imgs) => imgs,
                            Err(e) => {
                                eprintln!("获取画册图片失败: {}", e);
                                continue;
                            }
                        };

                    if images.is_empty() {
                        continue;
                    }

                    // 选择图片
                    let selected_image = match settings.wallpaper_rotation_mode.as_str() {
                        "sequential" => {
                            let mut idx = current_index.lock().unwrap();
                            let image = &images[*idx % images.len()];
                            *idx = (*idx + 1) % images.len();
                            image.clone()
                        }
                        _ => {
                            // 随机模式
                            let random_idx = (std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .unwrap()
                                .as_nanos() as usize)
                                % images.len();
                            images[random_idx].clone()
                        }
                    };

                    // 检查文件是否存在
                    if !Path::new(&selected_image.local_path).exists() {
                        eprintln!("图片文件不存在: {}", selected_image.local_path);
                        continue;
                    }

                    // 设置壁纸
                    let wallpaper_path = selected_image.local_path.clone();
                    let wallpaper_mode = settings.wallpaper_mode.clone();

                    #[cfg(target_os = "windows")]
                    {
                        if wallpaper_mode == "window" {
                            // 使用窗口模式
                            let mut wp_window = WallpaperWindow::new(app.clone());
                            if let Err(e) = wp_window.create(&wallpaper_path) {
                                eprintln!("创建窗口壁纸失败: {}, 回退到原生模式", e);
                                // 回退到原生模式
                                if let Err(e) = Self::set_wallpaper_native(
                                    &wallpaper_path,
                                    &settings.wallpaper_rotation_style,
                                    &settings.wallpaper_rotation_transition,
                                ) {
                                    eprintln!("设置原生壁纸失败: {}", e);
                                }
                            } else {
                                // 应用样式和过渡效果
                                if let Err(e) =
                                    wp_window.update_style(&settings.wallpaper_rotation_style)
                                {
                                    eprintln!("更新窗口壁纸样式失败: {}", e);
                                }
                                if let Err(e) = wp_window
                                    .update_transition(&settings.wallpaper_rotation_transition)
                                {
                                    eprintln!("更新窗口壁纸过渡效果失败: {}", e);
                                }
                                // 保存窗口引用
                                if let Ok(mut wp) = wallpaper_window.lock() {
                                    *wp = Some(wp_window);
                                }
                            }
                        } else {
                            // 使用原生模式
                            if let Err(e) = Self::set_wallpaper_native(
                                &wallpaper_path,
                                &settings.wallpaper_rotation_style,
                                &settings.wallpaper_rotation_transition,
                            ) {
                                eprintln!("设置壁纸失败: {}", e);
                            }
                        }
                    }

                    #[cfg(not(target_os = "windows"))]
                    {
                        // 非 Windows 平台使用原生模式
                        if let Err(e) = Self::set_wallpaper_internal(
                            &wallpaper_path,
                            &settings.wallpaper_rotation_style,
                            &settings.wallpaper_rotation_transition,
                        ) {
                            eprintln!("设置壁纸失败: {}", e);
                        }
                    }

                    // 保存当前壁纸路径
                    if let Ok(mut current) = current_wallpaper.lock() {
                        *current = Some(wallpaper_path.clone());
                    }
                    println!("壁纸已更换: {}", wallpaper_path);

                    // 等待指定的间隔时间
                    let interval_seconds = settings.wallpaper_rotation_interval_minutes as u64 * 60;
                    let mut wait_interval = interval(Duration::from_secs(interval_seconds));
                    wait_interval.tick().await; // 跳过第一次立即触发
                }
            });
        });

        Ok(())
    }

    /// 立刻切换到下一张壁纸（用于托盘菜单/快捷操作）
    ///
    /// - 依赖当前设置：是否启用、画册、随机/顺序、原生/窗口模式、style/transition
    /// - 成功/失败会通过 `wallpaper-actual-mode` 事件反馈到前端（与轮播逻辑一致）
    pub fn rotate_once_now(&self) -> Result<(), String> {
        use tauri::Manager;

        let settings_state = self
            .app
            .try_state::<Settings>()
            .ok_or_else(|| "无法获取设置状态".to_string())?;
        let settings = settings_state
            .get_settings()
            .map_err(|e| format!("获取设置失败: {}", e))?;

        if !settings.wallpaper_rotation_enabled {
            return Err("壁纸轮播未启用".to_string());
        }

        let album_id = settings
            .wallpaper_rotation_album_id
            .clone()
            .ok_or_else(|| "未选择用于轮播的画册".to_string())?;

        let storage = self
            .app
            .try_state::<Storage>()
            .ok_or_else(|| "无法获取存储状态".to_string())?;
        let images: Vec<crate::storage::ImageInfo> = storage
            .get_album_images(&album_id)
            .map_err(|e| format!("获取画册图片失败: {}", e))?;

        if images.is_empty() {
            return Err("画册内没有图片".to_string());
        }

        // 选择一张存在的图片（避免本地文件丢失导致失败）
        let mut picked: Option<crate::storage::ImageInfo> = None;
        for _ in 0..images.len().min(50) {
            let candidate = match settings.wallpaper_rotation_mode.as_str() {
                "sequential" => {
                    let mut idx = self
                        .current_index
                        .lock()
                        .map_err(|e| format!("无法获取顺序索引: {}", e))?;
                    let img = images[*idx % images.len()].clone();
                    *idx = (*idx + 1) % images.len();
                    img
                }
                _ => {
                    let random_idx = (std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_nanos() as usize)
                        % images.len();
                    images[random_idx].clone()
                }
            };

            if Path::new(&candidate.local_path).exists() {
                picked = Some(candidate);
                break;
            }
        }

        let picked = picked.ok_or_else(|| "未找到存在的图片文件".to_string())?;
        let wallpaper_path = picked.local_path.clone();

        // 设置壁纸：窗口模式/原生模式
        #[cfg(target_os = "windows")]
        {
            if settings.wallpaper_mode == "window" {
                if let Ok(mut wp) = self.wallpaper_window.lock() {
                    if let Some(ref wp_window) = *wp {
                        // 窗口已存在，使用 update_image 更新图片，避免重复执行 SetParent 导致桌面刷新闪烁
                        wp_window.update_image(&wallpaper_path)?;
                        let _ = wp_window.update_style(&settings.wallpaper_rotation_style);
                        let _ =
                            wp_window.update_transition(&settings.wallpaper_rotation_transition);
                    } else {
                        // 窗口不存在，需要创建并挂载到桌面
                        let mut new_wp = WallpaperWindow::new(self.app.clone());
                        new_wp.create(&wallpaper_path)?;
                        let _ = new_wp.update_style(&settings.wallpaper_rotation_style);
                        let _ = new_wp.update_transition(&settings.wallpaper_rotation_transition);
                        *wp = Some(new_wp);
                    }
                }
            } else {
                return Self::set_wallpaper_native(
                    &wallpaper_path,
                    &settings.wallpaper_rotation_style,
                    &settings.wallpaper_rotation_transition,
                );
            }
        }

        #[cfg(not(target_os = "windows"))]
        {
            Self::set_wallpaper_internal(
                &wallpaper_path,
                &settings.wallpaper_rotation_style,
                &settings.wallpaper_rotation_transition,
            )?;
        }

        // 保存当前壁纸路径（用于 reapply）
        if let Ok(mut current) = self.current_wallpaper.lock() {
            *current = Some(wallpaper_path.clone());
        }

        Ok(())
    }

    pub fn stop(&self) {
        self.running.store(false, Ordering::Relaxed);
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::Relaxed)
    }

    /// 调试/兜底：把“当前壁纸 + 当前样式/过渡设置”推送给 wallpaper webview（不依赖 WorkerW/SetParent 成功）。
    /// 目的：即使窗口模式挂载失败，也能在弹出/调试窗口里看到实际渲染内容，快速区分“渲染链路问题”还是“桌面层级问题”。
    pub fn debug_push_current_to_wallpaper_windows(&self) -> Result<(), String> {
        use tauri::Manager;

        let path = {
            let current = self
                .current_wallpaper
                .lock()
                .map_err(|e| format!("无法获取当前壁纸: {}", e))?;
            current.clone()
        }
        .ok_or_else(|| "没有当前壁纸可推送（请先成功设置一次壁纸）".to_string())?;

        let settings_state = self
            .app
            .try_state::<Settings>()
            .ok_or_else(|| "无法获取设置状态".to_string())?;
        let settings = settings_state
            .get_settings()
            .map_err(|e| format!("获取设置失败: {}", e))?;

        // 广播给所有窗口（wallpaper / wallpaper_debug）
        let _ = self.app.emit("wallpaper-update-image", path.clone());
        let _ = self.app.emit(
            "wallpaper-update-style",
            settings.wallpaper_rotation_style.clone(),
        );
        let _ = self.app.emit(
            "wallpaper-update-transition",
            settings.wallpaper_rotation_transition.clone(),
        );

        Ok(())
    }

    /// 重新应用当前壁纸（使用最新设置）
    /// 如果提供了 style 和 transition 参数，则使用这些参数；否则从设置中读取
    pub fn reapply_current_wallpaper(
        &self,
        style: Option<&str>,
        transition: Option<&str>,
    ) -> Result<(), String> {
        use tauri::Manager;

        println!("[DEBUG] reapply_current_wallpaper 被调用");
        println!(
            "[DEBUG] 传入的参数 - style: {:?}, transition: {:?}",
            style, transition
        );

        // 获取当前壁纸路径
        let wallpaper_path = {
            let current = self
                .current_wallpaper
                .lock()
                .map_err(|e| format!("无法获取当前壁纸: {}", e))?;
            current.clone()
        };

        if let Some(path) = wallpaper_path {
            println!("[DEBUG] 当前壁纸路径: {}", path);

            // 检查文件是否存在
            if !Path::new(&path).exists() {
                return Err("当前壁纸文件不存在".to_string());
            }

            // 获取设置值：优先使用传入的参数，否则从设置中读取
            let (style_value, transition_value) = if let (Some(s), Some(t)) = (style, transition) {
                println!("[DEBUG] 使用传入的参数: style={}, transition={}", s, t);
                (s.to_string(), t.to_string())
            } else {
                let settings_state = self
                    .app
                    .try_state::<Settings>()
                    .ok_or_else(|| "无法获取设置状态".to_string())?;
                let settings = settings_state
                    .get_settings()
                    .map_err(|e| format!("获取设置失败: {}", e))?;
                let s = style
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| settings.wallpaper_rotation_style.clone());
                let t = transition
                    .map(|t| t.to_string())
                    .unwrap_or_else(|| settings.wallpaper_rotation_transition.clone());
                println!("[DEBUG] 从设置读取的值: style={}, transition={}", s, t);
                (s, t)
            };

            println!(
                "[DEBUG] 最终使用的值: style={}, transition={}",
                style_value, transition_value
            );

            // 获取壁纸模式并选择相应的设置方法
            let settings_state = self
                .app
                .try_state::<Settings>()
                .ok_or_else(|| "无法获取设置状态".to_string())?;
            let settings = settings_state
                .get_settings()
                .map_err(|e| format!("获取设置失败: {}", e))?;

            #[cfg(target_os = "windows")]
            {
                if settings.wallpaper_mode == "window" {
                    // 使用窗口模式
                    // 同时设置原生壁纸作为后备，如果窗口模式失败，用户至少能看到壁纸
                    // 窗口会覆盖在原生壁纸之上，所以不会影响视觉效果
                    let _ = Self::set_wallpaper_native(&path, &style_value, &transition_value);

                    if let Ok(mut wp) = self.wallpaper_window.lock() {
                        if let Some(ref wp_window) = *wp {
                            // 窗口已存在，更新图片并重新挂载（确保从原生模式切换回来时窗口正确显示）
                            if let Err(e) = wp_window.update_image(&path) {
                                return Err(e);
                            }
                            let _ = wp_window.update_style(&style_value);
                            let _ = wp_window.update_transition(&transition_value);
                            // 重新挂载窗口，确保从原生模式切换回窗口模式时窗口正确显示
                            if let Err(e) = wp_window.remount() {
                                eprintln!("[WARN] 重新挂载窗口失败: {}, 但继续执行", e);
                            }
                        } else {
                            // 窗口不存在，需要创建并挂载到桌面
                            println!("[DEBUG] reapply_current_wallpaper: 窗口不存在，创建新窗口");
                            let mut new_wp = WallpaperWindow::new(self.app.clone());
                            if let Err(e) = new_wp.create(&path) {
                                return Err(e);
                            }
                            let _ = new_wp.update_style(&style_value);
                            let _ = new_wp.update_transition(&transition_value);
                            *wp = Some(new_wp);
                            println!("[DEBUG] reapply_current_wallpaper: 窗口创建成功");
                        }
                    }
                    // 使用窗口模式
                    return Ok(());
                } else {
                    // 使用原生模式
                    return Self::set_wallpaper_native(&path, &style_value, &transition_value);
                }
            }

            #[cfg(not(target_os = "windows"))]
            {
                Self::set_wallpaper_internal(&path, &style_value, &transition_value)
            }
        } else {
            println!("[DEBUG] 没有当前壁纸可重新应用");
            Err("没有当前壁纸可重新应用".to_string())
        }
    }

    #[cfg(target_os = "windows")]
    fn set_wallpaper_native(file_path: &str, style: &str, transition: &str) -> Result<(), String> {
        Self::set_wallpaper_internal(file_path, style, transition)
    }

    fn set_wallpaper_internal(
        file_path: &str,
        style: &str,
        transition: &str,
    ) -> Result<(), String> {
        use std::path::Path;
        use std::process::Command;
        use std::thread;
        use std::time::Duration;

        println!("[DEBUG] set_wallpaper_internal 被调用");
        println!("[DEBUG] file_path: {}", file_path);
        println!("[DEBUG] style: {}", style);
        println!("[DEBUG] transition: {}", transition);

        let path = Path::new(file_path);
        if !path.exists() {
            return Err("File does not exist".to_string());
        }

        #[cfg(target_os = "windows")]
        {
            // Windows 使用 PowerShell 设置壁纸
            let absolute_path = path
                .canonicalize()
                .map_err(|e| format!("Failed to canonicalize path: {}", e))?
                .to_string_lossy()
                .to_string();

            let escaped_path = absolute_path.replace('"', "\"\"");

            // 设置壁纸显示方式（通过注册表）
            // Windows 注册表值：
            // center: WallpaperStyle = 0, TileWallpaper = 0
            // tile: WallpaperStyle = 0, TileWallpaper = 1
            // stretch: WallpaperStyle = 2, TileWallpaper = 0
            // fit: WallpaperStyle = 6, TileWallpaper = 0 (适应 - 保持比例，完整显示)
            // fill: WallpaperStyle = 10, TileWallpaper = 0 (填充 - 填满屏幕，可能裁剪)
            let (style_value, tile_value) = match style {
                "center" => (0, 0),
                "tile" => (0, 1),
                "stretch" => (2, 0),
                "fit" => (6, 0),
                "fill" => (10, 0),
                _ => (10, 0), // 默认填充
            };

            // 如果有过渡效果，先设置透明度（通过临时图片实现淡入效果）
            if transition == "fade" {
                // 对于淡入效果，我们可以先设置一个半透明的图片，然后立即设置为完整图片
                // 但由于 Windows API 限制，我们使用延迟来实现平滑过渡
                // 这里简化处理：先短暂延迟，然后设置壁纸
                thread::sleep(Duration::from_millis(100));
            }

            // 设置壁纸的脚本
            // 重要：先设置注册表，再设置壁纸，最后刷新桌面
            let script = format!(
                r#"
$style = {};
$tile = {};
$path = "{}";
# 先设置壁纸显示方式（注册表）
$regPath = "HKCU:\Control Panel\Desktop";
Set-ItemProperty -Path $regPath -Name "WallpaperStyle" -Value $style -Type String;
Set-ItemProperty -Path $regPath -Name "TileWallpaper" -Value $tile -Type String;
# 设置壁纸
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class Wallpaper {{
    [DllImport("user32.dll", CharSet=CharSet.Auto, SetLastError=true)]
    public static extern int SystemParametersInfo(int uAction, int uParam, string lpvParam, int fuWinIni);
}}
"@;
$result = [Wallpaper]::SystemParametersInfo(20, 0, $path, 3);
if ($result -eq 0) {{ throw "SystemParametersInfo failed" }}
# 刷新桌面以应用注册表更改
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class DesktopRefresh {{
    [DllImport("user32.dll", SetLastError=true)]
    public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam, uint fuFlags, uint uTimeout, out IntPtr lpdwResult);
    public static readonly IntPtr HWND_BROADCAST = new IntPtr(0xffff);
    public static readonly uint WM_SETTINGCHANGE = 0x001A;
    public static readonly uint SMTO_ABORTIFHUNG = 0x0002;
}}
"@;
[DesktopRefresh]::SendMessageTimeout([DesktopRefresh]::HWND_BROADCAST, [DesktopRefresh]::WM_SETTINGCHANGE, [IntPtr]::Zero, [IntPtr]::Zero, [DesktopRefresh]::SMTO_ABORTIFHUNG, 5000, [ref][IntPtr]::Zero);
"#,
                style_value, tile_value, escaped_path
            );

            let output = Command::new("powershell")
                .args([
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-Command",
                    &script,
                ])
                .output()
                .map_err(|e| format!("Failed to execute PowerShell: {}", e))?;

            if !output.status.success() {
                let error = String::from_utf8_lossy(&output.stderr);
                let stdout = String::from_utf8_lossy(&output.stdout);
                return Err(format!(
                    "Failed to set wallpaper. Error: {}, Output: {}",
                    error, stdout
                ));
            }

            println!(
                "[DEBUG] 壁纸设置完成，style={}, transition={}",
                style, transition
            );
        }

        #[cfg(target_os = "macos")]
        {
            let script = format!(
                r#"tell application "System Events" to tell every desktop to set picture to "{}""#,
                file_path
            );
            Command::new("osascript")
                .args(["-e", &script])
                .spawn()
                .map_err(|e| format!("Failed to set wallpaper: {}", e))?;
        }

        #[cfg(target_os = "linux")]
        {
            if Command::new("gsettings")
                .args([
                    "set",
                    "org.gnome.desktop.background",
                    "picture-uri",
                    &format!("file://{}", file_path),
                ])
                .spawn()
                .is_err()
            {
                Command::new("feh")
                    .args(["--bg-scale", &file_path])
                    .spawn()
                    .map_err(|e| format!("Failed to set wallpaper: {}", e))?;
            }
        }

        Ok(())
    }
}
