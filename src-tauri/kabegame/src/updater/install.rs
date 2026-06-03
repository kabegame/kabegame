//! 平台安装 + 重启（Phase 6）。
//!
//! - macOS：用 `open` 打开下载好的 dmg 镜像（交给系统/用户拖入 Applications）→ 退出本进程。
//! - Windows：直接运行下载好的 `setup.exe`（支持原地升级）→ 退出本进程。
//! - Linux：不支持（不应进入 restartable）。

use std::path::Path;
#[allow(unused_imports)]
use std::process::Command;

use tauri::AppHandle;

/// 应用已下载的安装包并重启。按平台分流。
pub fn apply(app: &AppHandle, package: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        return apply_macos(app, package);
    }
    #[cfg(target_os = "windows")]
    {
        return apply_windows(app, package);
    }
    #[cfg(target_os = "linux")]
    {
        let _ = (app, package);
        return Err("restart-update is not supported on Linux".to_string());
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = (app, package);
        Err("restart-update is not supported on this platform".to_string())
    }
}

#[cfg(target_os = "macos")]
fn apply_macos(app: &AppHandle, dmg: &Path) -> Result<(), String> {
    // 直接用系统 `open` 打开 dmg 镜像；用户在弹出的窗口里把 .app 拖入 Applications。
    // 打开成功即退出本进程（避免占用旧版本 / 让用户完成替换）。
    let status = Command::new("open")
        .arg(dmg)
        .status()
        .map_err(|e| format!("打开镜像失败: {e}"))?;
    if !status.success() {
        return Err("打开镜像失败".to_string());
    }
    app.exit(0);
    Ok(())
}

#[cfg(target_os = "windows")]
fn apply_windows(app: &AppHandle, setup: &Path) -> Result<(), String> {
    Command::new(setup)
        .spawn()
        .map_err(|e| format!("启动安装程序失败: {e}"))?;
    app.exit(0);
    Ok(())
}
