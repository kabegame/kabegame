use super::WallpaperManager;
use tauri::AppHandle;

/// Plasma 插件壁纸管理器：
/// - 将 Plasma 当前桌面壁纸插件切换为 `org.kabegame.wallpaper`
/// - 写入插件配置（尤其是 KabegameBridgeEnabled=true）
///
/// 仅在 `desktop="plasma"` 编译期开关启用时可用。
#[cfg(all(target_os = "linux", desktop = "plasma"))]
pub struct PlasmaPluginWallpaperManager {
    _app: AppHandle,
}

#[cfg(all(target_os = "linux", desktop = "plasma"))]
impl PlasmaPluginWallpaperManager {
    pub fn new(app: AppHandle) -> Self {
        Self { _app: app }
    }

    fn escape_js_single_quoted(s: &str) -> String {
        // 用于构造 evaluateScript 的 JS 字符串字面量：'<here>'
        // 需要转义：\ 和 '
        s.replace('\\', "\\\\").replace('\'', "\\'")
    }

    fn run_qdbus_evaluate_script(script: &str) -> Result<(), String> {
        use std::process::{Command, Stdio};
        use std::sync::OnceLock;

        static QDBUS_PROGRAM: OnceLock<Result<String, String>> = OnceLock::new();

        fn detect_qdbus_program() -> Result<String, String> {
            // Plasma 6: qdbus6；Plasma 5: qdbus
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
                "Plasma 插件壁纸模式需要 `qdbus`（Plasma 5）或 `qdbus6`（Plasma 6），但当前系统未找到该命令。\n\
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
        Ok(())
    }

    fn apply_plugin_config(
        &self,
        image_path: Option<&str>,
        fill_mode: Option<&str>,
        transition: Option<&str>,
        transition_duration: Option<i64>,
    ) -> Result<(), String> {
        let image_js = image_path
            .map(|p| Self::escape_js_single_quoted(p))
            .unwrap_or_default();
        let fill_js = fill_mode
            .map(|s| Self::escape_js_single_quoted(s))
            .unwrap_or_default();
        let trans_js = transition
            .map(|t| Self::escape_js_single_quoted(t))
            .unwrap_or_default();

        // 关键：插件配置 group
        // - wallpaperPlugin: org.kabegame.wallpaper
        // - currentConfigGroup: ["Wallpaper","org.kabegame.wallpaper","General"]
        //
        // 只要 KabegameBridgeEnabled=true，插件后端会通过 unix socket IPC 自动同步 daemon 设置。
        let script = format!(
            "var allDesktops = desktops();\n\
for (var i=0; i<allDesktops.length; i++) {{\n\
  var d = allDesktops[i];\n\
  d.wallpaperPlugin = 'org.kabegame.wallpaper';\n\
  d.currentConfigGroup = ['Wallpaper', 'org.kabegame.wallpaper', 'General'];\n\
  d.writeConfig('KabegameBridgeEnabled', true);\n\
  {maybe_image}\
  {maybe_fill}\
  {maybe_transition}\
  {maybe_duration}\
}}\n",
            maybe_image = if image_path.is_some() {
                format!("d.writeConfig('Image', '{}');\n", image_js)
            } else {
                "".to_string()
            },
            maybe_fill = if fill_mode.is_some() {
                format!("d.writeConfig('FillMode', '{}');\n", fill_js)
            } else {
                "".to_string()
            },
            maybe_transition = if transition.is_some() {
                format!("d.writeConfig('Transition', '{}');\n", trans_js)
            } else {
                "".to_string()
            },
            maybe_duration = if let Some(ms) = transition_duration {
                format!("d.writeConfig('TransitionDuration', {});\n", ms)
            } else {
                "".to_string()
            },
        );

        Self::run_qdbus_evaluate_script(&script)?;
        Ok(())
    }
}

#[cfg(all(target_os = "linux", desktop = "plasma"))]
impl WallpaperManager for PlasmaPluginWallpaperManager {
    fn get_style(&self) -> Result<String, String> {
        // 以 daemon 设置为准（插件会同步 daemon）
        let v = tauri::async_runtime::block_on(async {
            crate::daemon_client::get_ipc_client().settings_get().await
        })
        .map_err(|e| format!("Daemon unavailable: {}", e))?;
        Ok(v.get("wallpaperRotationStyle")
            .and_then(|x| x.as_str())
            .unwrap_or("fill")
            .to_string())
    }

    fn get_transition(&self) -> Result<String, String> {
        let v = tauri::async_runtime::block_on(async {
            crate::daemon_client::get_ipc_client().settings_get().await
        })
        .map_err(|e| format!("Daemon unavailable: {}", e))?;
        Ok(v.get("wallpaperRotationTransition")
            .and_then(|x| x.as_str())
            .unwrap_or("fade")
            .to_string())
    }

    fn set_style(&self, style: &str, immediate: bool) -> Result<(), String> {
        // 风格以插件配置为即时展示；daemon 侧的保存由上层 command 负责。
        // immediate=false 时只保存到 daemon（由上层处理），这里不强制写 Plasma 配置。
        if immediate {
            self.apply_plugin_config(None, Some(style), None, None)?;
        }
        Ok(())
    }

    fn set_transition(&self, transition: &str, immediate: bool) -> Result<(), String> {
        if immediate {
            self.apply_plugin_config(None, None, Some(transition), None)?;
        }
        Ok(())
    }

    fn set_wallpaper_path(&self, file_path: &str, immediate: bool) -> Result<(), String> {
        use std::path::Path;
        let _ = immediate;

        if !Path::new(file_path).exists() {
            return Err("File does not exist".to_string());
        }

        // 用 daemon 的当前 style/transition 初始化插件配置，避免切到插件模式后出现“空白/配置不一致”
        let v = tauri::async_runtime::block_on(async {
            crate::daemon_client::get_ipc_client().settings_get().await
        })
        .map_err(|e| format!("Daemon unavailable: {}", e))?;

        let style = v
            .get("wallpaperRotationStyle")
            .and_then(|x| x.as_str())
            .unwrap_or("fill");
        let transition = v
            .get("wallpaperRotationTransition")
            .and_then(|x| x.as_str())
            .unwrap_or("fade");
        let duration = v
            .get("wallpaperTransitionDuration")
            .and_then(|x| x.as_i64())
            .or_else(|| v.get("wallpaperRotationTransitionDuration").and_then(|x| x.as_i64()))
            .unwrap_or(500);

        self.apply_plugin_config(Some(file_path), Some(style), Some(transition), Some(duration))?;
        Ok(())
    }

    fn cleanup(&self) -> Result<(), String> {
        Ok(())
    }

    fn refresh_desktop(&self) -> Result<(), String> {
        Ok(())
    }

    fn init(&self, _app: AppHandle) -> Result<(), String> {
        Ok(())
    }
}

