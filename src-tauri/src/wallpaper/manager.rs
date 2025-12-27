use tauri::{AppHandle, Manager};

/// 壁纸管理器 trait，定义壁纸设置的通用接口
#[allow(dead_code)]
pub trait WallpaperManager: Send + Sync {
    /// 设置壁纸
    ///
    /// # Arguments
    /// * `file_path` - 壁纸文件路径
    /// * `style` - 显示样式（fill/fit/stretch/center/tile）
    /// * `transition` - 过渡效果（none/fade/slide/zoom）
    fn set_wallpaper(&self, file_path: &str, style: &str, transition: &str) -> Result<(), String>;

    /// 更新壁纸样式
    ///
    /// # Arguments
    /// * `style` - 显示样式（fill/fit/stretch/center/tile）
    fn update_style(&self, style: &str) -> Result<(), String>;

    /// 更新壁纸过渡效果
    ///
    /// # Arguments
    /// * `transition` - 过渡效果（none/fade/slide/zoom）
    fn update_transition(&self, transition: &str) -> Result<(), String>;

    /// 清理资源（如关闭窗口等）
    fn cleanup(&self) -> Result<(), String>;
}

/// 原生壁纸管理器（使用系统原生 API）
pub struct NativeWallpaperManager {
    _app: AppHandle,
}

impl NativeWallpaperManager {
    pub fn new(app: AppHandle) -> Self {
        Self { _app: app }
    }
}

impl WallpaperManager for NativeWallpaperManager {
    fn set_wallpaper(&self, file_path: &str, style: &str, transition: &str) -> Result<(), String> {
        Self::set_wallpaper_internal(file_path, style, transition)
    }

    fn update_style(&self, _style: &str) -> Result<(), String> {
        // 原生模式不支持动态更新样式，需要重新设置壁纸
        // 实际使用中，应该在调用 update_style 时传入当前壁纸路径
        Err("原生模式不支持动态更新样式，请重新设置壁纸".to_string())
    }

    fn update_transition(&self, transition: &str) -> Result<(), String> {
        // Windows 原生模式支持 fade 过渡效果
        // 需要获取当前壁纸路径，然后重新应用
        #[cfg(target_os = "windows")]
        {
            // 从注册表读取当前壁纸路径
            let current_wallpaper = Self::get_current_wallpaper_path()?;

            // 获取当前样式（从注册表读取）
            let current_style = Self::get_current_wallpaper_style()?;

            // 重新设置壁纸以应用新的过渡效果
            Self::set_wallpaper_internal(&current_wallpaper, &current_style, transition)
        }

        #[cfg(not(target_os = "windows"))]
        {
            // 非 Windows 平台不支持过渡效果
            Ok(())
        }
    }

    fn cleanup(&self) -> Result<(), String> {
        // 原生模式不需要清理资源
        Ok(())
    }
}

impl NativeWallpaperManager {
    /// 从 Windows 注册表获取当前壁纸路径
    #[cfg(target_os = "windows")]
    fn get_current_wallpaper_path() -> Result<String, String> {
        use std::process::Command;

        let script = r#"
$regPath = "HKCU:\Control Panel\Desktop";
$wallpaper = (Get-ItemProperty -Path $regPath -Name "Wallpaper" -ErrorAction SilentlyContinue).Wallpaper;
if ($wallpaper) {
    Write-Output $wallpaper;
} else {
    Write-Error "无法获取当前壁纸路径";
    exit 1;
}
"#;

        let output = Command::new("powershell")
            .args(["-Command", script])
            .output()
            .map_err(|e| format!("执行 PowerShell 命令失败: {}", e))?;

        if !output.status.success() {
            return Err("无法从注册表读取当前壁纸路径".to_string());
        }

        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();

        if path.is_empty() {
            return Err("当前壁纸路径为空".to_string());
        }

        Ok(path)
    }

    /// 从 Windows 注册表获取当前壁纸样式
    #[cfg(target_os = "windows")]
    fn get_current_wallpaper_style() -> Result<String, String> {
        use std::process::Command;

        let script = r#"
$regPath = "HKCU:\Control Panel\Desktop";
$style = (Get-ItemProperty -Path $regPath -Name "WallpaperStyle" -ErrorAction SilentlyContinue).WallpaperStyle;
$tile = (Get-ItemProperty -Path $regPath -Name "TileWallpaper" -ErrorAction SilentlyContinue).TileWallpaper;
if ($null -eq $style) { $style = 10; }
if ($null -eq $tile) { $tile = 0; }
# 映射注册表值到样式字符串
if ($tile -eq 1) {
    Write-Output "tile";
} elseif ($style -eq 0) {
    Write-Output "center";
} elseif ($style -eq 2) {
    Write-Output "stretch";
} elseif ($style -eq 6) {
    Write-Output "fit";
} elseif ($style -eq 10) {
    Write-Output "fill";
} else {
    Write-Output "fill";
}
"#;

        let output = Command::new("powershell")
            .args(["-Command", script])
            .output()
            .map_err(|e| format!("执行 PowerShell 命令失败: {}", e))?;

        if !output.status.success() {
            return Ok("fill".to_string()); // 默认返回 fill
        }

        let style = String::from_utf8_lossy(&output.stdout).trim().to_string();

        Ok(if style.is_empty() {
            "fill".to_string()
        } else {
            style
        })
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

        println!("[DEBUG] NativeWallpaperManager::set_wallpaper_internal 被调用");
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
                .args(["-Command", &script])
                .output()
                .map_err(|e| format!("Failed to execute PowerShell command: {}", e))?;

            if !output.status.success() {
                let error_msg = String::from_utf8_lossy(&output.stderr);
                return Err(format!("PowerShell command failed: {}", error_msg));
            }

            println!(
                "[DEBUG] 壁纸设置完成，style={}, transition={}",
                style, transition
            );
            Ok(())
        }

        #[cfg(not(target_os = "windows"))]
        {
            // 非 Windows 平台使用系统命令设置壁纸
            // macOS 和 Linux 的实现可以在这里添加
            Err("当前平台不支持原生壁纸设置".to_string())
        }
    }
}

/// 窗口模式壁纸管理器（使用窗口句柄显示壁纸）
#[cfg(target_os = "windows")]
pub struct WindowWallpaperManager {
    app: AppHandle,
    wallpaper_window: Arc<Mutex<Option<WallpaperWindow>>>,
}

#[cfg(target_os = "windows")]
use super::window::WallpaperWindow;
#[cfg(target_os = "windows")]
use std::sync::{Arc, Mutex};

#[cfg(target_os = "windows")]
impl WindowWallpaperManager {
    pub fn new(app: AppHandle, wallpaper_window: Arc<Mutex<Option<WallpaperWindow>>>) -> Self {
        Self {
            app,
            wallpaper_window,
        }
    }
}

#[cfg(target_os = "windows")]
impl WallpaperManager for WindowWallpaperManager {
    fn set_wallpaper(&self, file_path: &str, style: &str, transition: &str) -> Result<(), String> {
        // 同时设置原生壁纸作为后备，如果窗口模式失败，用户至少能看到壁纸
        // 窗口会覆盖在原生壁纸之上，所以不会影响视觉效果
        let _ = NativeWallpaperManager::set_wallpaper_internal(file_path, style, transition);

        if let Ok(mut wp) = self.wallpaper_window.lock() {
            if let Some(ref wp_window) = *wp {
                // 窗口已存在，更新图片并重新挂载（确保从原生模式切换回来时窗口正确显示）
                if let Err(e) = wp_window.update_image(file_path) {
                    return Err(e);
                }
                let _ = wp_window.update_style(style);
                let _ = wp_window.update_transition(transition);
                // 重新挂载窗口，确保从原生模式切换回窗口模式时窗口正确显示
                if let Err(e) = wp_window.remount() {
                    eprintln!("[WARN] 重新挂载窗口失败: {}, 但继续执行", e);
                }
            } else {
                // 窗口不存在，需要创建并挂载到桌面
                println!("[DEBUG] WindowWallpaperManager: 窗口不存在，创建新窗口");
                let mut new_wp = WallpaperWindow::new(self.app.clone());
                if let Err(e) = new_wp.create(file_path) {
                    return Err(e);
                }
                let _ = new_wp.update_style(style);
                let _ = new_wp.update_transition(transition);
                *wp = Some(new_wp);
                println!("[DEBUG] WindowWallpaperManager: 窗口创建成功");
            }
        }
        Ok(())
    }

    fn update_style(&self, style: &str) -> Result<(), String> {
        if let Ok(wp) = self.wallpaper_window.lock() {
            if let Some(ref wp_window) = *wp {
                wp_window.update_style(style)
            } else {
                Err("窗口不存在".to_string())
            }
        } else {
            Err("无法获取窗口锁".to_string())
        }
    }

    fn update_transition(&self, transition: &str) -> Result<(), String> {
        if let Ok(wp) = self.wallpaper_window.lock() {
            if let Some(ref wp_window) = *wp {
                wp_window.update_transition(transition)
            } else {
                Err("窗口不存在".to_string())
            }
        } else {
            Err("无法获取窗口锁".to_string())
        }
    }

    fn cleanup(&self) -> Result<(), String> {
        // 隐藏窗口，但不销毁（因为窗口在应用生命周期内复用）
        if let Some(window) = self.app.get_webview_window("wallpaper") {
            window.hide().map_err(|e| format!("隐藏窗口失败: {}", e))?;
        }
        Ok(())
    }
}

/// 非 Windows 平台的窗口模式管理器（占位实现）
#[cfg(not(target_os = "windows"))]
pub struct WindowWallpaperManager {
    app: AppHandle,
}

#[cfg(not(target_os = "windows"))]
impl WindowWallpaperManager {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

#[cfg(not(target_os = "windows"))]
impl WallpaperManager for WindowWallpaperManager {
    fn set_wallpaper(
        &self,
        _file_path: &str,
        _style: &str,
        _transition: &str,
    ) -> Result<(), String> {
        Err("当前平台不支持窗口模式".to_string())
    }

    fn update_style(&self, _style: &str) -> Result<(), String> {
        Err("当前平台不支持窗口模式".to_string())
    }

    fn update_transition(&self, _transition: &str) -> Result<(), String> {
        Err("当前平台不支持窗口模式".to_string())
    }

    fn cleanup(&self) -> Result<(), String> {
        Ok(())
    }
}
