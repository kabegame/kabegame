//! 可执行文件查找和执行模块
//!
//! 提供跨平台的可执行文件查找和执行功能，支持通过关键字查找：
//! - `daemon` -> `kabegame-daemon`
//! - `cli` -> `kabegame-cli`
//! - `plugin-editor` -> `kabegame-plugin-editor`
//! - `main` -> `kabegame` (主程序)
//!
//! 查找策略：
//! - Linux 生产环境（release）：优先从 PATH 查找（如 /usr/bin）
//! - 开发环境（debug）或 Windows：同目录查找
//! - 不查找 resources 目录

use std::path::PathBuf;
use std::process::{Command, Stdio};

/// 可执行文件类型
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BinaryType {
    Daemon,
    Cli,
    PluginEditor,
    Main,
}

impl BinaryType {
    /// 获取可执行文件的基础名称（不含扩展名）
    pub fn base_name(&self) -> &'static str {
        match self {
            BinaryType::Daemon => "kabegame-daemon",
            BinaryType::Cli => "kabegame-cli",
            BinaryType::PluginEditor => "kabegame-plugin-editor",
            BinaryType::Main => "kabegame",
        }
    }

    /// 获取可执行文件的完整名称（含扩展名）
    pub fn full_name(&self) -> String {
        let base = self.base_name();
        #[cfg(target_os = "windows")]
        {
            format!("{}.exe", base)
        }
        #[cfg(not(target_os = "windows"))]
        {
            base.to_string()
        }
    }

    /// 从关键字字符串创建 BinaryType
    pub fn from_keyword(keyword: &str) -> Option<Self> {
        match keyword.to_lowercase().as_str() {
            "daemon" => Some(BinaryType::Daemon),
            "cli" => Some(BinaryType::Cli),
            "plugin-editor" | "plugin_editor" | "plugineditor" => Some(BinaryType::PluginEditor),
            "main" => Some(BinaryType::Main),
            _ => None,
        }
    }
}

/// 是否为开发环境（debug 构建）
#[inline]
fn is_dev() -> bool {
    cfg!(debug_assertions)
}

/// 查找可执行文件路径
///
/// 查找策略：
/// - Linux 生产环境（release）：优先从 PATH 查找，然后同目录
/// - 开发环境（debug）或 Windows：同目录查找
/// - 不查找 resources 目录
pub fn find_binary(binary_type: BinaryType) -> Result<PathBuf, String> {
    let binary_name = binary_type.full_name();
    let base_name = binary_type.base_name();

    // Linux 生产环境：优先从 PATH 查找
    #[cfg(target_os = "linux")]
    if !is_dev() {
        if let Ok(path) = find_in_path(base_name) {
            return Ok(path);
        }
    }

    // 开发环境或 Windows：同目录查找
    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(exe_dir) = current_exe.parent() {
            let binary_path = exe_dir.join(&binary_name);
            if binary_path.exists() {
                return Ok(binary_path);
            }
        }
    }

    Err(format!(
        "找不到可执行文件: {}\n请确认安装包已正确安装。",
        binary_name
    ))
}

/// 查找可执行文件路径（带 Tauri AppHandle，但仅用于兼容性，不查找 resources）
#[cfg(feature = "tauri")]
pub fn find_binary_with_app_handle(
    binary_type: BinaryType,
    _app_handle: Option<&tauri::AppHandle>,
) -> Result<PathBuf, String> {
    // 不查找 resources 目录，直接使用基础查找
    find_binary(binary_type)
}

/// 从 PATH 中查找可执行文件（Linux）
#[cfg(target_os = "linux")]
fn find_in_path(binary_name: &str) -> Result<PathBuf, String> {
    // Try `which` command
    if let Ok(output) = Command::new("which").arg(binary_name).output() {
        if output.status.success() {
            if let Ok(path_str) = String::from_utf8(output.stdout) {
                let path_str = path_str.trim();
                if !path_str.is_empty() {
                    let path = PathBuf::from(path_str);
                    if path.exists() {
                        return Ok(path);
                    }
                }
            }
        }
    }

    // Fallback: try `command -v` (POSIX standard)
    if let Ok(output) = Command::new("sh")
        .arg("-c")
        .arg(format!("command -v {}", binary_name))
        .output()
    {
        if output.status.success() {
            if let Ok(path_str) = String::from_utf8(output.stdout) {
                let path_str = path_str.trim();
                if !path_str.is_empty() {
                    let path = PathBuf::from(path_str);
                    if path.exists() {
                        return Ok(path);
                    }
                }
            }
        }
    }

    Err(format!("在 PATH 中找不到: {}", binary_name))
}

/// 从关键字查找可执行文件
pub fn find_binary_by_keyword(keyword: &str) -> Result<PathBuf, String> {
    let binary_type = BinaryType::from_keyword(keyword)
        .ok_or_else(|| format!("未知的可执行文件关键字: {}", keyword))?;
    find_binary(binary_type)
}

/// 从关键字查找可执行文件（带 Tauri AppHandle）
#[cfg(feature = "tauri")]
pub fn find_binary_by_keyword_with_app_handle(
    keyword: &str,
    _app_handle: Option<&tauri::AppHandle>,
) -> Result<PathBuf, String> {
    find_binary_by_keyword(keyword)
}

/// 执行可执行文件的选项
#[derive(Debug)]
pub struct ExecuteOptions {
    /// 参数列表
    pub args: Vec<String>,
    /// 是否在后台运行（spawn）
    pub background: bool,
    /// 是否等待完成
    pub wait: bool,
    /// 标准输入
    pub stdin: Option<Stdio>,
    /// 标准输出
    pub stdout: Option<Stdio>,
    /// 标准错误
    pub stderr: Option<Stdio>,
}

impl Default for ExecuteOptions {
    fn default() -> Self {
        Self {
            args: Vec::new(),
            background: false,
            wait: true,
            stdin: None,
            stdout: None,
            stderr: None,
        }
    }
}

/// 执行可执行文件
pub fn execute_binary(
    binary_type: BinaryType,
    execute_options: &mut ExecuteOptions,
) -> Result<(), String> {
    let binary_path = find_binary(binary_type)?;
    execute_binary_at_path(&binary_path, binary_type, execute_options)
}

/// 执行可执行文件（带 Tauri AppHandle）
#[cfg(feature = "tauri")]
pub fn execute_binary_with_app_handle(
    binary_type: BinaryType,
    execute_options: &mut ExecuteOptions,
    _app_handle: Option<&tauri::AppHandle>,
) -> Result<(), String> {
    execute_binary(binary_type, execute_options)
}

/// 在指定路径执行可执行文件
pub fn execute_binary_at_path(
    binary_path: &PathBuf,
    binary_type: BinaryType,
    execute_options: &mut ExecuteOptions,
) -> Result<(), String> {
    // Windows 上运行 daemon 时自动使用 runas 提权
    #[cfg(target_os = "windows")]
    {
        if matches!(binary_type, BinaryType::Daemon) {
            crate::shell_open::runas(
                &binary_path.to_string_lossy(),
                &execute_options.args.join(" "),
            )?;
            return Ok(());
        }
    }
    
    // 在非 Windows 平台上，binary_type 参数保留用于未来扩展
    #[allow(unused_variables)]
    let _ = binary_type;

    // 构建命令
    let mut cmd = Command::new(binary_path);
    cmd.args(&execute_options.args);

    // 设置标准流
    if let Some(stdin) = execute_options.stdin.take() {
        cmd.stdin(stdin);
    } else if execute_options.background {
        cmd.stdin(Stdio::null());
    }

    if let Some(stdout) = execute_options.stdout.take() {
        cmd.stdout(stdout);
    } else if execute_options.background {
        cmd.stdout(Stdio::null());
    }

    if let Some(stderr) = execute_options.stderr.take() {
        cmd.stderr(stderr);
    } else if execute_options.background {
        cmd.stderr(Stdio::null());
    }

    // Windows 下隐藏控制台窗口（如果是在后台运行）
    #[cfg(target_os = "windows")]
    if execute_options.background {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    // 执行
    if execute_options.background {
        cmd.spawn()
            .map_err(|e| format!("启动 {} 失败: {}", binary_path.display(), e))?;
    } else if execute_options.wait {
        let status = cmd
            .status()
            .map_err(|e| format!("执行 {} 失败: {}", binary_path.display(), e))?;
        if !status.success() {
            return Err(format!(
                "{} 执行失败，退出码: {:?}",
                binary_path.display(),
                status.code()
            ));
        }
    } else {
        cmd.spawn()
            .map_err(|e| format!("启动 {} 失败: {}", binary_path.display(), e))?;
    }

    Ok(())
}

/// 从关键字执行可执行文件
pub fn execute_binary_by_keyword(
    keyword: &str,
    execute_options: &mut ExecuteOptions,
) -> Result<(), String> {
    let binary_type = BinaryType::from_keyword(keyword)
        .ok_or_else(|| format!("未知的可执行文件关键字: {}", keyword))?;
    execute_binary(binary_type, execute_options)
}

/// 从关键字执行可执行文件（带 Tauri AppHandle）
#[cfg(feature = "tauri")]
pub fn execute_binary_by_keyword_with_app_handle(
    keyword: &str,
    execute_options: &mut ExecuteOptions,
    _app_handle: Option<&tauri::AppHandle>,
) -> Result<(), String> {
    execute_binary_by_keyword(keyword, execute_options)
}

/// 便捷函数：查找并执行（后台运行）
pub fn spawn_binary(keyword: &str, args: Vec<String>) -> Result<(), String> {
    let mut exec_opts = ExecuteOptions::default();
    exec_opts.args = args;
    exec_opts.background = true;
    exec_opts.wait = false;
    execute_binary_by_keyword(keyword, &mut exec_opts)
}

/// 便捷函数：查找并执行（等待完成）
pub fn run_binary(keyword: &str, args: Vec<String>) -> Result<(), String> {
    let mut exec_opts = ExecuteOptions::default();
    exec_opts.args = args;
    exec_opts.background = false;
    exec_opts.wait = true;
    execute_binary_by_keyword(keyword, &mut exec_opts)
}
