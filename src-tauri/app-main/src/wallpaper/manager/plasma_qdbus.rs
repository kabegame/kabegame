//! 共享的 Plasma qdbus 辅助函数，供 NativeWallpaperManager 和 PlasmaPluginWallpaperManager 使用。

#[cfg(target_os = "linux")]
pub fn run_qdbus_evaluate_script(script: &str) -> Result<(), String> {
    run_qdbus_evaluate_script_with_output(script)?;
    Ok(())
}

#[cfg(target_os = "linux")]
pub fn run_qdbus_evaluate_script_with_output(script: &str) -> Result<String, String> {
    use std::process::{Command, Stdio};
    use std::sync::OnceLock;

    static QDBUS_PROGRAM: OnceLock<Result<String, String>> = OnceLock::new();

    fn detect_qdbus_program() -> Result<String, String> {
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
            "Plasma 需要 `qdbus`（Plasma 5）或 `qdbus6`（Plasma 6），但当前系统未找到该命令。\n\
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

    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Kabegame Plasma 壁纸插件 ID（与 plasma_plugin.rs 中 switch_to_kabegame_plugin 一致）。
pub const KABEGAME_PLASMA_WALLPAPER_PLUGIN_ID: &str = "org.kabegame.wallpaper";

/// 检测 Kabegame Plasma 壁纸插件是否已安装（在系统或用户 wallpaper 插件目录下存在对应目录）。
/// 用于前端仅在有插件时展示「插件模式」选项。
#[cfg(target_os = "linux")]
pub fn is_kabegame_plasma_plugin_installed() -> bool {
    use std::path::Path;

    let system_path =
        Path::new("/usr/share/plasma/wallpapers").join(KABEGAME_PLASMA_WALLPAPER_PLUGIN_ID);
    if system_path.is_dir() {
        return true;
    }

    if let Some(data) = dirs::data_dir() {
        let user_path = data
            .join("plasma/wallpapers")
            .join(KABEGAME_PLASMA_WALLPAPER_PLUGIN_ID);
        if user_path.is_dir() {
            return true;
        }
    }

    false
}

#[cfg(not(target_os = "linux"))]
pub fn is_kabegame_plasma_plugin_installed() -> bool {
    false
}

/// 获取当前 Plasma 第一个桌面的壁纸插件 ID（如 org.kde.image、org.kabegame.wallpaper）。
/// 用于启动时判断是否需要自动切到 Kabegame 插件。
#[cfg(target_os = "linux")]
pub fn get_current_plasma_wallpaper_plugin() -> Result<String, String> {
    let script = r#"
        var allDesktops = desktops();
        if (allDesktops.length > 0) {
            print(allDesktops[0].wallpaperPlugin);
        } else {
            print('');
        }
    "#;
    let out = run_qdbus_evaluate_script_with_output(script)?;
    Ok(out.trim().to_string())
}
