use super::WallpaperManager;
use async_trait::async_trait;
use tauri::AppHandle;

/// 原生壁纸管理器（使用系统原生 API）
pub struct NativeWallpaperManager {
    _app: AppHandle,
}

impl NativeWallpaperManager {
    pub fn new(app: AppHandle) -> Self {
        Self { _app: app }
    }

    async fn current_wallpaper_path_from_settings(&self) -> Option<String> {
        let v = crate::daemon_client::get_ipc_client().settings_get().await.ok()?;
        let id = v.get("currentWallpaperImageId").and_then(|x| x.as_str())?;
        let img = crate::daemon_client::get_ipc_client()
                .storage_get_image_by_id(id.to_string())
                .await
        .ok()?;
        img.get("localPath").and_then(|x| x.as_str()).map(|s| s.to_string())
    }

    #[cfg(target_os = "windows")]
    async fn current_wallpaper_transition_from_ipc(&self) -> Option<String> {
        let v = crate::daemon_client::get_ipc_client().settings_get().await.ok()?;
        Some(
            v.get("wallpaperRotationTransition")
                .and_then(|x| x.as_str())
                .unwrap_or("none")
                .to_string(),
        )
    }

    #[cfg(all(target_os = "linux", desktop = "plasma"))]
    fn percent_encode_path_for_file_url(path: &str) -> String {
        // Plasma 的 org.kde.image 的 Image 通常是 URL（file:///...）。
        // 这里做一个轻量 percent-encode（UTF-8 bytes）来避免空格等字符导致解析失败。
        fn is_unreserved(b: u8) -> bool {
            matches!(b, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~')
        }

        let mut out = String::with_capacity(path.len() + 16);
        for &b in path.as_bytes() {
            if is_unreserved(b) || b == b'/' {
                out.push(b as char);
            } else {
                out.push('%');
                out.push_str(&format!("{:02X}", b));
            }
        }
        out
    }

    #[cfg(all(target_os = "linux", desktop = "plasma"))]
    fn escape_js_single_quoted(s: &str) -> String {
        // 用于构造 evaluateScript 的 JS 字符串字面量：'<here>'
        // 需要转义：\ 和 '
        s.replace('\\', "\\\\").replace('\'', "\\'")
    }

    #[cfg(all(target_os = "linux", desktop = "plasma"))]
    fn style_to_plasma_fill_mode(style: &str) -> &'static str {
        // KDE Plasma wallpaper plugin `org.kde.image` 的 FillMode（常见映射）：
        // 0: scaled (stretch)
        // 1: centered
        // 2: scaled & cropped (fill)
        // 3: tiled
        // 5: scaled keep proportions (fit)
        match style {
            "fit" => "5",
            "stretch" => "0",
            "center" => "1",
            "tile" => "3",
            _ => "2", // fill（默认）
        }
    }

    #[cfg(all(target_os = "linux", desktop = "plasma"))]
    fn plasma_fill_mode_to_style(fill_mode: &str) -> &'static str {
        // 将 Plasma FillMode 字符串映射回 style 字符串
        match fill_mode.trim() {
            "0" => "stretch",
            "1" => "center",
            "2" => "fill",
            "3" => "tile",
            "5" => "fit",
            _ => "fill", // 默认填充
        }
    }

    #[cfg(all(target_os = "linux", desktop = "plasma"))]
    fn run_qdbus_evaluate_script_with_output(script: &str) -> Result<String, String> {
        use std::process::{Command, Stdio};
        use std::sync::OnceLock;

        static QDBUS_PROGRAM: OnceLock<Result<String, String>> = OnceLock::new();

        fn detect_qdbus_program() -> Result<String, String> {
            // 说明：Plasma 6 上可能是 qdbus6，Plasma 5 通常是 qdbus。
            // 我们只做"存在性"探测，不依赖特定输出格式。
            for program in ["qdbus6", "qdbus"] {
                match Command::new(program)
                    .arg("--help")
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()
                {
                    Ok(_) => return Ok(program.to_string()),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(e) => {
                        return Err(format!(
                            "检测 `{}` 是否可用时失败：{}（请确认命令可执行且在 PATH 中）",
                            program, e
                        ))
                    }
                }
            }

            Err(
                "Plasma 原生壁纸模式需要 `qdbus`（Plasma 5）或 `qdbus6`（Plasma 6），但当前系统未找到该命令。\n\
请安装 Qt tools 并确保命令在 PATH 中后重试。\n\
示例：\n\
- Debian/Ubuntu: `sudo apt install qttools5-dev-tools` 或 `sudo apt install qt6-tools-dev-tools`\n\
- Arch: `sudo pacman -S qt5-tools` 或 `sudo pacman -S qt6-tools`\n\
- Fedora: `sudo dnf install qt5-qttools` 或 `sudo dnf install qt6-qttools`"
                    .to_string(),
            )
        }

        let program = QDBUS_PROGRAM
            .get_or_init(detect_qdbus_program)
            .as_ref()
            .map_err(|e| e.clone())?;

        let out = Command::new(program)
            .args([
                "org.kde.plasmashell",
                "/PlasmaShell",
                "org.kde.PlasmaShell.evaluateScript",
                script,
            ])
            .output()
            .map_err(|e| format!("执行 `{}` 失败：{}", program, e))?;

        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            let stdout = String::from_utf8_lossy(&out.stdout);
            return Err(format!(
                "`{}` evaluateScript 失败 (code={:?})。\n\
这通常表示 PlasmaShell 未运行、DBus 会话不可用、或脚本执行出错。\n\
stdout: {}\n\
stderr: {}",
                program,
                out.status.code(),
                stdout.trim(),
                stderr.trim()
            ));
        }

        // 返回 stdout（可能包含脚本的 print 输出）
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    #[cfg(all(target_os = "linux", desktop = "plasma"))]
    fn run_qdbus_evaluate_script(script: &str) -> Result<(), String> {
        // 复用 run_qdbus_evaluate_script_with_output，忽略输出
        Self::run_qdbus_evaluate_script_with_output(script)?;
        Ok(())
    }

    #[cfg(all(target_os = "linux", desktop = "plasma"))]
    fn get_wallpaper_plasma_fill_mode(&self) -> Result<String, String> {
        // 通过 qdbus evaluateScript 读取第一个桌面的 FillMode
        let script = r#"
            var allDesktops = desktops();
            if (allDesktops.length > 0) {
                var d = allDesktops[0];
                d.currentConfigGroup = ['Wallpaper', 'org.kde.image', 'General'];
                print(d.readConfig('FillMode'));
            } else {
                print('2'); // 默认 fill
            }
        "#;

        // 复用 run_qdbus_evaluate_script_with_output 读取输出
        let stdout = Self::run_qdbus_evaluate_script_with_output(script)?;
        let fill_mode = stdout.trim();

        // 如果输出为空或不是预期的数字，返回默认值
        if fill_mode.is_empty() {
            Ok("2".to_string()) // 默认 fill
        } else {
            Ok(fill_mode.to_string())
        }
    }

    #[cfg(all(target_os = "linux", desktop = "plasma"))]
    fn set_wallpaper_plasma(&self, file_path: &str, style: &str) -> Result<(), String> {
        use std::path::Path;

        let path = Path::new(file_path);
        if !path.exists() {
            return Err("File does not exist".to_string());
        }

        let abs = path
            .canonicalize()
            .unwrap_or_else(|_| path.to_path_buf())
            .to_string_lossy()
            .to_string();

        let file_url = format!(
            "file:///{}",
            Self::percent_encode_path_for_file_url(abs.trim_start_matches('/'))
        );
        let file_url_js = Self::escape_js_single_quoted(&file_url);
        let fill_mode = Self::style_to_plasma_fill_mode(style);

        // 通过 org.kde.plasmashell 的 evaluateScript 设置所有桌面的壁纸
        // 参考常见脚本：desktops() / wallpaperPlugin / currentConfigGroup / writeConfig
        let script = format!(
            "var allDesktops = desktops();\n\
for (var i=0; i<allDesktops.length; i++) {{\n\
  var d = allDesktops[i];\n\
  d.wallpaperPlugin = 'org.kde.image';\n\
  d.currentConfigGroup = ['Wallpaper', 'org.kde.image', 'General'];\n\
  d.writeConfig('Image', '{}');\n\
  d.writeConfig('FillMode', '{}');\n\
}}\n",
            file_url_js, fill_mode
        );

        Self::run_qdbus_evaluate_script(&script)?;
        Ok(())
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

#[async_trait]
impl WallpaperManager for NativeWallpaperManager {
    // 从注册表读取当前壁纸样式
    #[cfg(target_os = "windows")]
    async fn get_style(&self) -> Result<String, String> {
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

    #[cfg(not(target_os = "windows"))]
    async fn get_style(&self) -> Result<String, String> {
        // 非 Windows 平台：
        // - Plasma 原生壁纸（--plasma 编译期开关）下：通过 qdbus 读取 FillMode
        // - 其他平台：返回默认值
        #[cfg(all(target_os = "linux", desktop = "plasma"))]
        {
            match self.get_wallpaper_plasma_fill_mode() {
                Ok(fill_mode) => Ok(Self::plasma_fill_mode_to_style(&fill_mode).to_string()),
                Err(e) => {
                    eprintln!("[WARN] 无法读取 Plasma FillMode: {}，返回默认值 fill", e);
                    Ok("fill".to_string())
                }
            }
        }

        #[cfg(not(all(target_os = "linux", desktop = "plasma")))]
        {
        Ok("fill".to_string())
    }
    }

    async fn get_transition(&self) -> Result<String, String> {
        let v = crate::daemon_client::get_ipc_client().settings_get().await
        .map_err(|e| format!("Daemon unavailable: {}", e))?;
        Ok(v.get("wallpaperRotationTransition")
            .and_then(|x| x.as_str())
            .unwrap_or("none")
            .to_string())
    }

    async fn set_wallpaper_path(&self, file_path: &str, immediate: bool) -> Result<(), String> {
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
            use std::os::windows::ffi::OsStrExt;
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
                .current_wallpaper_transition_from_ipc()
                .await
                .unwrap_or_else(|| "none".to_string());

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
            // Plasma 原生壁纸：由 Kabegame 的 --plasma 编译期开关启用
            #[cfg(all(target_os = "linux", desktop = "plasma"))]
            {
                let _ = immediate;
                // style 从 daemon 读取（与前端保持一致）
                let style = crate::daemon_client::get_ipc_client().settings_get().await
                .ok()
                .and_then(|v| v.get("wallpaperRotationStyle").and_then(|x| x.as_str()).map(|s| s.to_string()))
                .unwrap_or_else(|| "fill".to_string());
                return self.set_wallpaper_plasma(file_path, &style);
            }

            #[cfg(not(all(target_os = "linux", desktop = "plasma")))]
            {
                let _ = immediate;
                return Err("当前平台不支持原生壁纸设置（NativeWallpaperManager）".to_string());
            }
        }
    }

    #[cfg(target_os = "windows")]
    async fn set_style(&self, style: &str, immediate: bool) -> Result<(), String> {
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
            if let Some(path) = self.current_wallpaper_path_from_settings().await {
                if std::path::Path::new(&path).exists() {
                    let _ = self.set_wallpaper_path(&path, true).await;
                }
            }
        }

        println!(
            "[DEBUG] 壁纸样式设置完成（使用 winreg，快速），style={}, immediate={}",
            style, immediate
        );
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    async fn set_style(&self, style: &str, immediate: bool) -> Result<(), String> {
        // 非 Windows 平台：
        // - 默认 no-op（由 WindowWallpaperManager/KDE 插件等负责）
        // - Plasma 原生壁纸（--plasma 编译期开关）下：通过 qdbus 写 FillMode，并尽量对当前壁纸立即生效

        #[cfg(all(target_os = "linux", desktop = "plasma"))]
        {
            if immediate {
                if let Some(path) = self.current_wallpaper_path_from_settings().await {
                    if std::path::Path::new(&path).exists() {
                        // 修复：正确处理错误，而不是忽略
                        self.set_wallpaper_plasma(&path, style)?;
                    } else {
                        return Err(format!("当前壁纸路径不存在: {}", path));
            }
                } else {
                    // 如果没有当前壁纸，仍然尝试通过 qdbus 只设置 FillMode（不改变图片）
                    // 这样可以确保 style 被正确设置，即使没有当前壁纸路径
                    let fill_mode = Self::style_to_plasma_fill_mode(style);
                    let script = format!(
                        "var allDesktops = desktops();\n\
                        for (var i=0; i<allDesktops.length; i++) {{\n\
                          var d = allDesktops[i];\n\
                          if (d.wallpaperPlugin === 'org.kde.image') {{\n\
                            d.currentConfigGroup = ['Wallpaper', 'org.kde.image', 'General'];\n\
                            d.writeConfig('FillMode', '{}');\n\
                          }}\n\
                        }}\n",
                        fill_mode
                    );
                    Self::run_qdbus_evaluate_script(&script)?;
                }
            }
            return Ok(());
        }

        #[cfg(not(all(target_os = "linux", desktop = "plasma")))]
        {
        let _ = style;
        let _ = immediate;
        Ok(())
        }
    }

    #[cfg(target_os = "windows")]
    async fn set_transition(&self, transition: &str, immediate: bool) -> Result<(), String> {
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
            let Some(current_wallpaper) = self.current_wallpaper_path_from_settings().await else {
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
            self.set_wallpaper_path(&current_wallpaper, true).await?;

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

    #[cfg(not(target_os = "windows"))]
    async fn set_transition(&self, transition: &str, _immediate: bool) -> Result<(), String> {
        // 非 Windows 平台：仅保存设置，不做系统级预览
            crate::daemon_client::get_ipc_client()
                .settings_set_wallpaper_rotation_transition(transition.to_string())
            .await?;
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

    #[cfg(not(target_os = "windows"))]
    fn refresh_desktop(&self) -> Result<(), String> {
        Ok(())
    }

    fn init(&self, _app: AppHandle) -> Result<(), String> {
        // 原生模式不需要初始化窗口
        Ok(())
    }
}
