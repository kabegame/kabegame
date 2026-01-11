// kabegame-cliw: 用于 Windows 文件关联（双击 .kgpg）时“无控制台窗口”地调用 kabegame-cli.exe
//
// 说明：
// - kabegame-cli.exe 是控制台子系统，直接从 Explorer 启动会弹黑窗口。
// - 本程序编译为 Windows 子系统（无控制台），并以 CREATE_NO_WINDOW 方式启动 kabegame-cli.exe。
// - 这样双击 .kgpg 时只会出现导入 UI（如有），不会再出现额外黑窗口。

#![cfg_attr(windows, windows_subsystem = "windows")]

use std::{path::PathBuf, process::Command};

fn main() {
    let mut target = match std::env::current_exe() {
        Ok(p) => p,
        Err(_) => PathBuf::from("kabegame-cliw"),
    };

    // 与本 exe 同目录的 kabegame-cli(.exe)
    let cli_name = if cfg!(windows) {
        "kabegame-cli.exe"
    } else {
        "kabegame-cli"
    };
    target.set_file_name(cli_name);

    let args: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();

    let mut cmd = Command::new(target);
    cmd.args(args);

    // Windows 下隐藏子进程控制台窗口
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let code = match cmd.status() {
        Ok(s) => s.code().unwrap_or(0),
        Err(_) => 1,
    };

    std::process::exit(code);
}
