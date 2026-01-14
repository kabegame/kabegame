use super::WallpaperManager;
use kabegame_core::settings::Settings;
use tauri::{AppHandle, Manager};

/// 原生壁纸管理器（使用系统原生 API）
pub struct NativeWallpaperManager {
    _app: AppHandle,
}

impl NativeWallpaperManager {
    pub fn new(app: AppHandle) -> Self {
        Self { _app: app }
    }

    #[cfg(target_os = "windows")]
    fn current_wallpaper_path_from_settings(&self) -> Option<String> {
        let settings = self._app.try_state::<Settings>()?.get_settings().ok()?;
        let id = settings.current_wallpaper_image_id?;
        let storage = self._app.try_state::<crate::storage::Storage>()?;
        storage
            .find_image_by_id(&id)
            .ok()
            .flatten()
            .map(|img| img.local_path)
    }

    /// 确保系统启用壁纸淡入淡出效果（通过注册表设置）
    #[cfg(target_os = "windows")]
    fn ensure_fade_enabled(&self) -> Result<(), String> {
        use winreg::enums::*;
        use winreg::RegKey;

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let desktop_key = hkcu
            .open_subkey_with_flags("Control Panel\\Desktop", KEY_WRITE)
            .map_err(|e| format!("无法打开注册表键: {}", e))?;

        // 确保 WallpaperTransition 存在且为 1（启用淡入淡出）
        // 如果不存在或值不为 1，则设置为 1
        let current_value: String = desktop_key
            .get_value("WallpaperTransition")
            .unwrap_or_else(|_| "0".to_string());

        if current_value != "1" {
            desktop_key
                .set_value("WallpaperTransition", &"1")
                .map_err(|e| format!("设置 WallpaperTransition 失败: {}", e))?;
            println!("[DEBUG] 已启用系统壁纸淡入淡出效果（WallpaperTransition=1）");
        }

        Ok(())
    }

    /// 使用 IDesktopWallpaper COM 接口设置壁纸（支持淡入淡出效果）
    #[cfg(target_os = "windows")]
    fn set_wallpaper_via_com(&self, wide_path: &[u16]) -> Result<(), String> {
        use windows::core::*;
        use windows::Win32::System::Com::*;
        use windows::Win32::UI::Shell::*;

        unsafe {
            // 初始化 COM（如果尚未初始化，忽略已初始化的错误）
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);

            // 创建 IDesktopWallpaper 接口实例
            let desktop_wallpaper: IDesktopWallpaper =
                CoCreateInstance(&DesktopWallpaper, None, CLSCTX_ALL)
                    .map_err(|e| format!("CoCreateInstance failed: {:?}", e))?;

            // 将 UTF-16 路径转换为 PCWSTR
            // wide_path 已经包含 null 终止符
            let wallpaper_path = PCWSTR::from_raw(wide_path.as_ptr());

            // 设置壁纸（monitorID = None 表示所有显示器）
            desktop_wallpaper
                .SetWallpaper(None, wallpaper_path)
                .map_err(|e| format!("SetWallpaper failed: {:?}", e))?;

            Ok(())
        }
    }
}

impl WallpaperManager for NativeWallpaperManager {
    // 从注册表读取当前壁纸样式
    #[cfg(target_os = "windows")]
    fn get_style(&self) -> Result<String, String> {
        // 优化：直接使用 winreg crate 读取注册表，而不是通过 PowerShell
        use winreg::enums::*;
        use winreg::RegKey;

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let desktop_key = hkcu
            .open_subkey("Control Panel\\Desktop")
            .map_err(|e| format!("无法打开注册表键: {}", e))?;

        // 读取 WallpaperStyle 和 TileWallpaper
        let style_value: String = desktop_key
            .get_value("WallpaperStyle")
            .unwrap_or_else(|_| "10".to_string()); // 默认 fill
        let tile_value: String = desktop_key
            .get_value("TileWallpaper")
            .unwrap_or_else(|_| "0".to_string()); // 默认不平铺

        // 将注册表值映射回样式字符串
        let style = match (style_value.as_str(), tile_value.as_str()) {
            ("0", "0") => "center",
            ("0", "1") => "tile",
            ("2", "0") => "stretch",
            ("6", "0") => "fit",
            ("10", "0") => "fill",
            _ => "fill", // 默认填充
        };

        Ok(style.to_string())
    }

    fn get_transition(&self) -> Result<String, String> {
        // 从 app 中获取 transition
        let settings = self._app.state::<Settings>().get_settings().unwrap();
        Ok(settings.wallpaper_rotation_transition.clone())
    }

    fn set_wallpaper_path(&self, file_path: &str, immediate: bool) -> Result<(), String> {
        use std::os::windows::ffi::OsStrExt;
        use std::path::Path;

        println!("[DEBUG] NativeWallpaperManager::set_wallpaper_path 被调用");
        println!("[DEBUG] file_path: {}", file_path);
        println!("[DEBUG] immediate: {}", immediate);

        let path = Path::new(file_path);
        if !path.exists() {
            return Err("File does not exist".to_string());
        }

        #[cfg(target_os = "windows")]
        {
            // 优化：直接使用 FFI 调用 Windows API，而不是通过 PowerShell
            // 这样可以大幅提升性能（避免启动 PowerShell 进程的开销）

            let absolute_path = path
                .canonicalize()
                .map_err(|e| format!("Failed to canonicalize path: {}", e))?;

            // 转换为 UTF-16 宽字符串
            let wide_path: Vec<u16> = absolute_path
                .as_os_str()
                .encode_wide()
                .chain(Some(0))
                .collect();

            let transition = self
                ._app
                .state::<Settings>()
                .get_settings()
                .map(|s| s.wallpaper_rotation_transition)
                .unwrap_or_else(|_| "none".to_string());

            // 参考 wallpaper_rotator.rs 的实现：使用模拟方式实现淡入淡出
            // wallpaper_rotator.rs 中的实现能工作，它使用延迟 + SPIF_SENDWININICHANGE 来触发系统动画
            // 当 transition == "fade" 时，先延迟 100ms，然后使用 fuWinIni=3 设置壁纸
            if transition == "fade" && immediate {
                // 确保系统启用壁纸淡入淡出效果
                let _ = self.ensure_fade_enabled();

                // 优先尝试 IDesktopWallpaper（COM）接口，使用 windows-rs 的正式绑定
                // 这个接口应该能正确触发 Windows 原生的淡入淡出效果
                // 如果失败，则回退到"延迟 + SystemParametersInfoW"的模拟方式
                if let Ok(()) = self.set_wallpaper_via_com(&wide_path) {
                    println!(
                        "[DEBUG] 壁纸路径设置完成（使用 IDesktopWallpaper COM，支持原生淡入淡出）"
                    );
                    return Ok(());
                }

                println!("[DEBUG] IDesktopWallpaper COM 接口调用失败，回退到模拟方式");

                use std::thread;
                use std::time::Duration;

                // 参考 wallpaper_rotator.rs：先短暂延迟，让系统有时间准备淡入动画
                // 使用 100ms 延迟（与 wallpaper_rotator.rs 保持一致）
                thread::sleep(Duration::from_millis(100));

                // 使用 fuWinIni=3 (SPIF_UPDATEINIFILE | SPIF_SENDWININICHANGE) 来触发系统动画
                // 这与 wallpaper_rotator.rs 中的实现完全一致
                const SPIF_UPDATEINIFILE: u32 = 0x01;
                const SPIF_SENDWININICHANGE: u32 = 0x02;
                let fu_win_ini = SPIF_UPDATEINIFILE | SPIF_SENDWININICHANGE; // 3

                unsafe {
                    extern "system" {
                        fn SystemParametersInfoW(
                            uiAction: u32,
                            uiParam: u32,
                            pvParam: *mut std::ffi::c_void,
                            fWinIni: u32,
                        ) -> windows_sys::Win32::Foundation::BOOL;
                    }

                    const SPI_SETDESKWALLPAPER: u32 = 0x0014; // 20

                    let result = SystemParametersInfoW(
                        SPI_SETDESKWALLPAPER,
                        0,
                        wide_path.as_ptr() as *mut std::ffi::c_void,
                        fu_win_ini,
                    );

                    if result == 0 {
                        use windows_sys::Win32::Foundation::GetLastError;
                        let err = GetLastError();
                        return Err(format!(
                            "SystemParametersInfoW failed. GetLastError={}",
                            err
                        ));
                    }
                }

                println!("[DEBUG] 壁纸路径设置完成（使用模拟淡入淡出：延迟100ms + SPIF_SENDWININICHANGE）");
                return Ok(());
            }

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
            let fu_win_ini = if immediate {
                if transition == "none" {
                    1u32 // SPIF_UPDATEINIFILE
                } else {
                    3u32 // SPIF_UPDATEINIFILE | SPIF_SENDWININICHANGE
                }
            } else {
                1u32 // SPIF_UPDATEINIFILE
            };

            println!(
                "[DEBUG] set_wallpaper_path: transition={}, fuWinIni={}",
                transition, fu_win_ini
            );

            // 直接使用 FFI 调用 SystemParametersInfoW
            unsafe {
                extern "system" {
                    fn SystemParametersInfoW(
                        uiAction: u32,
                        uiParam: u32,
                        pvParam: *mut std::ffi::c_void,
                        fWinIni: u32,
                    ) -> windows_sys::Win32::Foundation::BOOL;
                }

                const SPI_SETDESKWALLPAPER: u32 = 0x0014; // 20

                let result = SystemParametersInfoW(
                    SPI_SETDESKWALLPAPER,
                    0,
                    wide_path.as_ptr() as *mut std::ffi::c_void,
                    fu_win_ini,
                );

                if result == 0 {
                    use windows_sys::Win32::Foundation::GetLastError;
                    let err = GetLastError();
                    return Err(format!(
                        "SystemParametersInfoW failed. GetLastError={}",
                        err
                    ));
                }
            }

            println!("[DEBUG] 壁纸路径设置完成（使用 FFI，快速）");
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
        use winreg::enums::*;
        use winreg::RegKey;

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

        // 优化：直接使用 winreg crate 操作注册表，而不是通过 PowerShell
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let desktop_key = hkcu
            .open_subkey_with_flags("Control Panel\\Desktop", KEY_WRITE)
            .map_err(|e| format!("无法打开注册表键: {}", e))?;

        // 将数值转换为字符串（Windows 注册表中这些值存储为字符串）
        desktop_key
            .set_value("WallpaperStyle", &style_value.to_string())
            .map_err(|e| format!("设置 WallpaperStyle 失败: {}", e))?;
        desktop_key
            .set_value("TileWallpaper", &tile_value.to_string())
            .map_err(|e| format!("设置 TileWallpaper 失败: {}", e))?;

        // 如果 immediate=true，发送 WM_SETTINGCHANGE 消息刷新桌面
        if immediate {
            use windows_sys::Win32::UI::WindowsAndMessaging::{
                SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE,
            };

            unsafe {
                let mut result: usize = 0;
                let _ = SendMessageTimeoutW(
                    HWND_BROADCAST,
                    WM_SETTINGCHANGE,
                    0,
                    0,
                    SMTO_ABORTIFHUNG,
                    5000,
                    &mut result,
                );
            }

            // 仅刷新 WM_SETTINGCHANGE 在某些系统上仍可能不触发壁纸重新布局，
            // 这里强制"重载一次当前壁纸路径"，确保新 style 立刻反映到桌面。
            if let Some(path) = self.current_wallpaper_path_from_settings() {
                if std::path::Path::new(&path).exists() {
                    let _ = self.set_wallpaper_path(&path, true);
                }
            }
        }

        println!(
            "[DEBUG] 壁纸样式设置完成（使用 winreg，快速），style={}, immediate={}",
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

            // 从全局设置读取当前壁纸路径（由应用维护）
            let Some(current_wallpaper) = self.current_wallpaper_path_from_settings() else {
                return Ok(());
            };

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
        // 优化：直接使用 Windows API 刷新桌面，而不是通过 PowerShell
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE,
        };

        unsafe {
            let mut result: usize = 0;
            let ret = SendMessageTimeoutW(
                HWND_BROADCAST,
                WM_SETTINGCHANGE,
                0,
                0,
                SMTO_ABORTIFHUNG,
                5000,
                &mut result,
            );

            if ret == 0 {
                use windows_sys::Win32::Foundation::GetLastError;
                let err = GetLastError();
                return Err(format!("SendMessageTimeoutW failed. GetLastError={}", err));
            }
        }

        println!("[DEBUG] 桌面刷新完成（使用 FFI，快速）");
        Ok(())
    }

    fn init(&self, _app: AppHandle) -> Result<(), String> {
        // 原生模式不需要初始化窗口
        Ok(())
    }
}
