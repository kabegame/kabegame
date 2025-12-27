use super::WallpaperManager;
use crate::settings::Settings;
use tauri::{AppHandle, Manager};

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
    #[cfg(target_os = "windows")]
    fn get_wallpaper_path(&self) -> Result<String, String> {
        use windows_sys::Win32::Foundation::GetLastError;
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            SystemParametersInfoW, SPI_GETDESKWALLPAPER,
        };

        // SPI_GETDESKWALLPAPER 返回 UTF-16 路径，能正确处理中文等非 ASCII 字符
        let mut buf: [u16; 4096] = [0; 4096];
        let ok = unsafe {
            SystemParametersInfoW(
                SPI_GETDESKWALLPAPER,
                buf.len() as u32,
                buf.as_mut_ptr() as *mut _,
                0,
            )
        };
        if ok == 0 {
            return Err(format!("获取当前壁纸失败(GetLastError={} )", unsafe {
                GetLastError()
            }));
        }

        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        let path = String::from_utf16_lossy(&buf[..len]).trim().to_string();

        if path.is_empty() {
            return Err("当前壁纸路径为空".to_string());
        }

        Ok(path)
    }

    // 从注册表读取当前壁纸样式
    #[cfg(target_os = "windows")]
    fn get_style(&self) -> Result<String, String> {
        use std::process::Command;

        let script = r#"
$regPath = "HKCU:\Control Panel\Desktop";
$style = (Get-ItemProperty -Path $regPath -Name "WallpaperStyle" -ErrorAction SilentlyContinue).WallpaperStyle;
$tile = (Get-ItemProperty -Path $regPath -Name "TileWallpaper" -ErrorAction SilentlyContinue).TileWallpaper;
if ($null -eq $style) { $style = 10; }
if ($null -eq $tile) { $tile = 0; }
"#;

        let output = Command::new("powershell")
            .args(["-Command", script])
            .output()
            .map_err(|e| format!("执行 PowerShell 命令失败: {}", e))?;

        if !output.status.success() {
            return Err("无法从注册表读取当前壁纸样式".to_string());
        }
        let style = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Ok(style)
    }

    fn get_transition(&self) -> Result<String, String> {
        // 从 app 中获取 transition
        let settings = self._app.state::<Settings>().get_settings().unwrap();
        Ok(settings.wallpaper_rotation_transition.clone())
    }

    fn set_wallpaper_path(&self, file_path: &str, immediate: bool) -> Result<(), String> {
        use std::path::Path;
        use std::process::Command;

        println!("[DEBUG] NativeWallpaperManager::set_wallpaper_path 被调用");
        println!("[DEBUG] file_path: {}", file_path);
        println!("[DEBUG] immediate: {}", immediate);

        let path = Path::new(file_path);
        if !path.exists() {
            return Err("File does not exist".to_string());
        }

        #[cfg(target_os = "windows")]
        {
            // Windows：优先尝试 IDesktopWallpaper（Shell COM）设置壁纸。
            // 经验上它更可能绕开 Explorer 对 SPI_SETDESKWALLPAPER 的淡入动画处理。
            //
            // 注意：我们只在 transition=none 时使用它；其他 transition 仍走 SPI 以保持兼容。
            let absolute_path = path
                .canonicalize()
                .map_err(|e| format!("Failed to canonicalize path: {}", e))?
                .to_string_lossy()
                .to_string();

            let transition = self
                ._app
                .state::<Settings>()
                .get_settings()
                .map(|s| s.wallpaper_rotation_transition)
                .unwrap_or_else(|_| "none".to_string());

            // 注意：尝试使用 IDesktopWallpaper（COM）来绕开 SPI 的系统淡入动画在部分环境中不可用；
            // 目前先禁用该路径（保持编译稳定）。后续若要继续尝试，可改为 windows crate 的 COM 调用并做兼容回退。

            let escaped_path = absolute_path.replace('"', "\"\"");

            // 设置壁纸路径
            // 注意：SystemParametersInfo 的最后一个参数 fuWinIni：
            // - 0 = 不更新用户配置文件，不刷新桌面（临时设置，重启后失效）
            // - 1 = 更新用户配置文件，不刷新桌面（持久化设置，重启后保留，但不立即刷新）
            // - 2 = 不更新用户配置文件，刷新桌面（临时设置，立即生效）
            // - 3 = 更新用户配置文件，刷新桌面（持久化设置，立即生效）
            //
            // 实测/经验：在一些系统上，使用 3（带广播）会触发 Explorer 的桌面淡入动画；
            // 而使用 1（仅更新用户配置文件）仍然会立即切换壁纸，但更少触发系统动画。
            // 因此：当用户选择 transition=none 时，即使 immediate=true 也优先用 1。
            let immediate_value = if immediate {
                if transition == "none" {
                    1
                } else {
                    3
                }
            } else {
                1
            };
            println!(
                "[DEBUG] set_wallpaper_path: transition={}, fuWinIni={}",
                transition, immediate_value
            );
            let script = format!(
                r#"
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class Wallpaper {{
    [DllImport("user32.dll", CharSet=CharSet.Auto, SetLastError=true)]
    public static extern int SystemParametersInfo(int uAction, int uParam, string lpvParam, int fuWinIni);
}}
"@;
$path = "{}";
$result = [Wallpaper]::SystemParametersInfo(20, 0, $path, {immediate_value});
if ($result -eq 0) {{ throw "SystemParametersInfo failed" }}
"#,
                escaped_path
            );

            let output = Command::new("powershell")
                .args(["-Command", &script])
                .output()
                .map_err(|e| format!("Failed to execute PowerShell command: {}", e))?;

            if !output.status.success() {
                let error_msg = String::from_utf8_lossy(&output.stderr);
                return Err(format!("PowerShell command failed: {}", error_msg));
            }

            println!("[DEBUG] 壁纸路径设置完成（未刷新桌面）");
            Ok(())
        }

        // TODO: 非 Windows 平台使用系统命令设置壁纸
        #[cfg(not(target_os = "windows"))]
        {
            // 非 Windows 平台使用系统命令设置壁纸
            // macOS 和 Linux 的实现可以在这里添加
            Err("当前平台不支持原生壁纸设置".to_string())
        }
    }

    #[cfg(target_os = "windows")]
    fn set_style(&self, style: &str, immediate: bool) -> Result<(), String> {
        use std::process::Command;

        // 将样式字符串映射到注册表值
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

        // 根据 immediate 参数决定是否刷新桌面
        let script = if immediate {
            format!(
                r#"
$regPath = "HKCU:\Control Panel\Desktop";
$style = {};
$tile = {};
# 设置壁纸显示方式（注册表）
Set-ItemProperty -Path $regPath -Name "WallpaperStyle" -Value $style -Type String;
Set-ItemProperty -Path $regPath -Name "TileWallpaper" -Value $tile -Type String;
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
                style_value, tile_value
            )
        } else {
            format!(
                r#"
$regPath = "HKCU:\Control Panel\Desktop";
$style = {};
$tile = {};
# 设置壁纸显示方式（注册表）
Set-ItemProperty -Path $regPath -Name "WallpaperStyle" -Value $style -Type String;
Set-ItemProperty -Path $regPath -Name "TileWallpaper" -Value $tile -Type String;
"#,
                style_value, tile_value
            )
        };

        let output = Command::new("powershell")
            .args(["-Command", &script])
            .output()
            .map_err(|e| format!("Failed to execute PowerShell command: {}", e))?;

        if !output.status.success() {
            let error_msg = String::from_utf8_lossy(&output.stderr);
            return Err(format!("PowerShell command failed: {}", error_msg));
        }

        // immediate=true 时：仅刷新 WM_SETTINGCHANGE 在某些系统上仍可能不触发壁纸重新布局，
        // 这里强制"重载一次当前壁纸路径"，确保新 style 立刻反映到桌面。
        if immediate {
            if let Ok(path) = self.get_wallpaper_path() {
                if std::path::Path::new(&path).exists() {
                    // 忽略错误：如果重载失败，至少 style 已写入注册表
                    let _ = self.set_wallpaper_path(&path, true);
                }
            }
        }

        println!(
            "[DEBUG] 壁纸样式设置完成，style={}, immediate={}",
            style, immediate
        );
        Ok(())
    }

    #[cfg(target_os = "windows")]
    fn set_transition(&self, transition: &str, immediate: bool) -> Result<(), String> {
        use std::thread;
        use std::time::Duration;

        // 保存设置到用户配置中
        let settings = self._app.state::<Settings>();
        settings
            .set_wallpaper_rotation_transition(transition.to_string())
            .map_err(|e| format!("保存过渡效果设置失败: {}", e))?;

        // 方案 A：不修改系统级动画相关注册表。
        // 原生模式的"无过渡"仅表示：应用不会额外触发/预览过渡；
        // Windows 自身在切换壁纸时可能仍有系统级淡入动画，这属于系统行为，应用不强控。

        // 如果 immediate 为 true，需要立即重新加载当前壁纸以应用过渡效果
        if immediate {
            // "none" 表示无过渡，不应该重新设置壁纸（避免触发系统默认的淡入效果）
            if transition == "none" {
                println!(
                    "[DEBUG] 壁纸过渡效果设置为无过渡，仅保存设置，不重新设置壁纸，transition={}, immediate={}",
                    transition, immediate
                );
                return Ok(());
            }

            // 从注册表读取当前壁纸路径
            let current_wallpaper = self.get_wallpaper_path()?;

            // 对于 fade 效果，先短暂延迟，然后重新设置壁纸
            // 这样可以模拟淡入效果（Windows 原生 API 不支持真正的 fade，但可以通过延迟来实现平滑过渡）
            if transition == "fade" {
                // 短暂延迟以模拟淡入效果
                thread::sleep(Duration::from_millis(100));
            }

            // 重新设置壁纸路径，immediate = true 会立即生效并刷新桌面
            // 这样可以让用户看到过渡效果
            self.set_wallpaper_path(&current_wallpaper, true)?;

            println!(
                "[DEBUG] 壁纸过渡效果设置完成，transition={}, immediate={}",
                transition, immediate
            );
        } else {
            // immediate = false 时，仅保存设置，不立即应用
            // 过渡效果会在下次设置壁纸时生效
            println!(
                "[DEBUG] 壁纸过渡效果设置已保存到用户配置，transition={}, immediate={}",
                transition, immediate
            );
        }
        Ok(())
    }

    fn cleanup(&self) -> Result<(), String> {
        // 原生模式不需要清理资源
        Ok(())
    }

    #[cfg(target_os = "windows")]
    fn refresh_desktop(&self) -> Result<(), String> {
        #[cfg(target_os = "windows")]
        {
            use std::process::Command;

            // 刷新桌面以同步壁纸设置
            // 使用 SendMessageTimeout 广播 WM_SETTINGCHANGE 消息
            let script = r#"
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class DesktopRefresh {
    [DllImport("user32.dll", SetLastError=true)]
    public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam, uint fuFlags, uint uTimeout, out IntPtr lpdwResult);
    public static readonly IntPtr HWND_BROADCAST = new IntPtr(0xffff);
    public static readonly uint WM_SETTINGCHANGE = 0x001A;
    public static readonly uint SMTO_ABORTIFHUNG = 0x0002;
}
"@;
$result = [DesktopRefresh]::SendMessageTimeout([DesktopRefresh]::HWND_BROADCAST, [DesktopRefresh]::WM_SETTINGCHANGE, [IntPtr]::Zero, [IntPtr]::Zero, [DesktopRefresh]::SMTO_ABORTIFHUNG, 5000, [ref][IntPtr]::Zero);
if ($result -eq [IntPtr]::Zero) { throw "SendMessageTimeout failed" }
"#;

            let output = Command::new("powershell")
                .args(["-Command", script])
                .output()
                .map_err(|e| format!("Failed to execute PowerShell command: {}", e))?;

            if !output.status.success() {
                let error_msg = String::from_utf8_lossy(&output.stderr);
                return Err(format!("PowerShell command failed: {}", error_msg));
            }

            println!("[DEBUG] 桌面刷新完成");
            Ok(())
        }

        #[cfg(not(target_os = "windows"))]
        {
            // 非 Windows 平台不需要刷新桌面
            Ok(())
        }
    }

    fn init(&self, _app: AppHandle) -> Result<(), String> {
        // 原生模式不需要初始化窗口
        Ok(())
    }
}
