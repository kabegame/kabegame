//! Kabegame CLI（sidecar）
//!
//! 目前支持：
//! - `plugin run`：运行 Rhai 爬虫插件（支持通过插件 id 或 .kgpg 路径）
//!   - `--` 之后的参数会被解析并映射到插件 `config.json` 的 `var` 变量
//!   - required 规则：与前端一致，`default` 不存在即视为 required
//! - `plugin pack`：打包单个插件目录为 `.kgpg`（KGPG v2：固定头部 + ZIP，ZIP 内不含 icon.png）
//! - `plugin import`：导入本地 `.kgpg` 插件文件（复制到 plugins_directory）

use clap::{Args, Parser, Subcommand};
use kabegame_core::ipc::client::daemon_startup::*;
use kabegame_core::{
    kgpg,
    plugin::{ImportPreview, Plugin, PluginDetail, PluginManager, PluginManifest},
};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Parser, Debug)]
#[command(name = "kabegame-cli")]
#[command(version)]
#[command(about = "Kabegame 命令行工具（运行插件等）", long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// 调试：检查 daemon IPC 是否就绪
    IpcStatus,
    /// 插件相关命令
    #[command(subcommand)]
    Plugin(PluginCommands),

    /// 虚拟盘相关命令
    #[command(subcommand)]
    #[cfg(not(kabegame_mode = "light"))]
    Vd(VdCommands),
}

#[derive(Subcommand, Debug)]
enum PluginCommands {
    /// 运行爬虫插件（Rhai）
    Run(RunPluginArgs),
    /// 打包单个插件目录为 `.kgpg`（KGPG v2：固定头部 + ZIP，ZIP 内不含 icon.png）
    Pack(PackPluginArgs),
    /// 导入本地 `.kgpg` 插件文件（复制到 plugins_directory）
    Import(ImportPluginArgs),
}

#[derive(Subcommand, Debug)]
#[cfg(not(kabegame_mode = "light"))]
enum VdCommands {
    /// 挂载虚拟盘（通过 daemon IPC 触发）
    Mount(VdMountArgs),
    /// 卸载虚拟盘（通过 daemon IPC 触发）
    Unmount(VdUnmountArgs),
    /// 检查挂载点是否可访问（通过 daemon IPC 触发）
    Status(VdStatusArgs),
}

#[cfg(not(kabegame_mode = "light"))]
#[derive(Args, Debug)]
struct VdMountArgs {}

#[cfg(not(kabegame_mode = "light"))]
#[derive(Args, Debug)]
struct VdUnmountArgs {}

#[cfg(not(kabegame_mode = "light"))]
#[derive(Args, Debug)]
struct VdStatusArgs {
    /// 挂载点（例如 K:\\ 或 K: 或 K）（Unix默认为 $HOME/kabegame-vd）
    #[arg(long = "mount-point")]
    mount_point: String,
}

#[derive(Args, Debug)]
struct PackPluginArgs {
    /// 插件目录（包含 manifest.json/crawl.rhai 等）
    #[arg(long = "plugin-dir")]
    plugin_dir: PathBuf,

    /// 输出 `.kgpg` 文件路径
    #[arg(long = "output")]
    output: PathBuf,
}

#[derive(Args, Debug)]
struct ImportPluginArgs {
    /// 本地插件文件路径（.kgpg）
    path: PathBuf,
}

#[derive(Args, Debug)]
struct RunPluginArgs {
    /// 插件 ID（已安装的 .kgpg 文件名，不含扩展名）或插件文件路径（.kgpg）
    #[arg(short = 'p', long = "plugin")]
    plugin: String,

    /// 输出目录（下载图片保存目录）。不指定则使用默认图片目录（Pictures/Kabegame 或数据目录）。
    #[arg(short = 'o', long = "output-dir")]
    output_dir: Option<PathBuf>,

    /// 任务 ID（用于进度与日志归档）。不指定则自动生成。
    #[arg(long = "task-id")]
    task_id: Option<String>,

    /// 输出画册名称（可选）
    #[arg(long = "output-album")]
    output_album: Option<String>,

    /// 传给插件的参数（必须放在 `--` 之后）
    #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
    plugin_args: Vec<String>,
}

#[tokio::main]
async fn main() {
     // 执行绕过
    #[cfg(target_os = "linux")]
    kabegame_core::workarounds::apply_nvidia_dmabuf_renderer_workaround();
    let cli = Cli::parse();

    let res = match cli.command {
        Commands::IpcStatus => ipc_status().await,
        Commands::Plugin(cmd) => match cmd {
            PluginCommands::Run(args) => run_plugin(args),
            PluginCommands::Pack(args) => pack_plugin(args),
            PluginCommands::Import(args) => import_plugin(args).await,
        },
        #[cfg(not(kabegame_mode = "light"))]
        Commands::Vd(cmd) => match cmd {
            VdCommands::Mount(args) => vd_mount(args),
            VdCommands::Unmount(args) => vd_unmount(args),
            VdCommands::Status(args) => vd_status(args),
        },
    };

    if let Err(e) = res {
        eprintln!("{e}");
        std::process::exit(1);
    }
}

// NOTE: build_minimal_app / run_plugin 等"后台能力"已迁移到独立的 `kabegame-daemon` 中。

/// 运行插件命令
fn run_plugin(args: RunPluginArgs) -> Result<(), String> {
    // 仅通过 daemon IPC 执行（CLI 不再本地直跑，避免多进程争抢数据目录/DB）
    let rt = tokio::runtime::Runtime::new().unwrap_or_else(|e| {
        eprintln!("创建 Tokio Runtime 失败: {e}");
        std::process::exit(1);
    });

    // 检查 daemon 是否可用（连接失败时会自动弹出错误窗口）
    if !rt.block_on(is_daemon_available()) {
        let daemon_path = find_daemon_executable()
            .unwrap_or_else(|_| std::path::PathBuf::from("kabegame-daemon"));
        return Err(format!(
            "无法连接 kabegame-daemon\n提示：请先启动 `{}`",
            daemon_path.display()
        ));
    }

    // 将画册名称转换为 ID（如果提供了名称）
    let output_album_id = match args.output_album {
        Some(name) => match rt.block_on(resolve_album_name_to_id(&name)) {
            Ok(Some(id)) => Some(id),
            Ok(None) => {
                return Err(format!("未找到名称为 \"{}\" 的画册", name));
            }
            Err(e) => {
                return Err(format!("查询画册失败: {}", e));
            }
        },
        None => None,
    };

    let req = kabegame_core::ipc::ipc::CliIpcRequest::PluginRun {
        plugin: args.plugin,
        output_dir: args
            .output_dir
            .as_ref()
            .map(|p| p.to_string_lossy().to_string()),
        task_id: args.task_id,
        output_album_id,
        plugin_args: args.plugin_args,
        http_headers: None,
    };
    match rt.block_on(kabegame_core::ipc::ipc::request(req)) {
        Ok(resp) if resp.ok => {
            if let Some(msg) = resp.message {
                println!("{msg}");
            } else {
                println!("ok");
            }
            Ok(())
        }
        Ok(resp) => Err(resp
            .message
            .unwrap_or_else(|| "daemon returned error".to_string())),
        Err(e) => Err(format!(
            "无法连接 kabegame-daemon：{}\n提示：请先启动 `kabegame-daemon`",
            e
        )),
    }
}

/// 将画册名称转换为 ID（通过 IPC 查询）
async fn resolve_album_name_to_id(name: &str) -> Result<Option<String>, String> {
    use kabegame_core::ipc::client::IpcClient;
    use kabegame_core::storage::albums::Album;

    let client = IpcClient::new();
    let albums_value = client.storage_get_albums().await?;

    // 解析画册列表
    let albums: Vec<Album> =
        serde_json::from_value(albums_value).map_err(|e| format!("解析画册列表失败: {}", e))?;

    // 不区分大小写查找匹配的画册名称
    let name_lower = name.trim().to_lowercase();
    for album in albums {
        if album.name.to_lowercase() == name_lower {
            return Ok(Some(album.id));
        }
    }

    Ok(None)
}

#[cfg(not(kabegame_mode = "light"))]
fn vd_mount(_args: VdMountArgs) -> Result<(), String> {
    let rt =
        tokio::runtime::Runtime::new().map_err(|e| format!("create tokio runtime failed: {e}"))?;
    // 检查 daemon 是否可用（连接失败时会自动弹出错误窗口）
    if !rt.block_on(kabegame_core::ipc::client::daemon_startup::is_daemon_available()) {
        let daemon_path = kabegame_core::ipc::client::daemon_startup::find_daemon_executable()
            .unwrap_or_else(|_| std::path::PathBuf::from("kabegame-daemon"));
        return Err(format!(
            "无法连接 kabegame-daemon\n提示：请先启动 `{}`",
            daemon_path.display()
        ));
    }
    let req = kabegame_core::ipc::ipc::CliIpcRequest::VdMount;
    let resp = rt.block_on(kabegame_core::ipc::ipc::request(req))?;
    if resp.ok {
        println!("{}", resp.message.unwrap_or_else(|| "ok".to_string()));
        Ok(())
    } else {
        Err(resp
            .message
            .unwrap_or_else(|| "daemon returned error".to_string()))
    }
}

#[cfg(not(kabegame_mode = "light"))]
fn vd_unmount(_args: VdUnmountArgs) -> Result<(), String> {
    let rt =
        tokio::runtime::Runtime::new().map_err(|e| format!("create tokio runtime failed: {e}"))?;
    // 检查 daemon 是否可用（连接失败时会自动弹出错误窗口）
    if !rt.block_on(is_daemon_available()) {
        let daemon_path = find_daemon_executable()
            .unwrap_or_else(|_| std::path::PathBuf::from("kabegame-daemon"));
        return Err(format!(
            "无法连接 kabegame-daemon\n提示：请先启动 `{}`",
            daemon_path.display()
        ));
    }
    let req = kabegame_core::ipc::ipc::CliIpcRequest::VdUnmount;
    let resp = rt.block_on(kabegame_core::ipc::ipc::request(req))?;
    if resp.ok {
        println!("{}", resp.message.unwrap_or_else(|| "ok".to_string()));
        Ok(())
    } else {
        Err(resp
            .message
            .unwrap_or_else(|| "daemon returned error".to_string()))
    }
}

#[cfg(not(kabegame_mode = "light"))]
fn vd_status(args: VdStatusArgs) -> Result<(), String> {
    let _ = args;
    let rt =
        tokio::runtime::Runtime::new().map_err(|e| format!("create tokio runtime failed: {e}"))?;
    // 检查 daemon 是否可用（连接失败时会自动弹出错误窗口）
    if !rt.block_on(is_daemon_available()) {
        let daemon_path = find_daemon_executable()
            .unwrap_or_else(|_| std::path::PathBuf::from("kabegame-daemon"));
        return Err(format!(
            "无法连接 kabegame-daemon\n提示：请先启动 `{}`",
            daemon_path.display()
        ));
    }
    let req = kabegame_core::ipc::ipc::CliIpcRequest::VdStatus;
    let resp = rt.block_on(kabegame_core::ipc::ipc::request(req))?;
    println!(
        "{}",
        serde_json::to_string_pretty(&resp).unwrap_or_else(|_| "ok".to_string())
    );
    Ok(())
}

async fn ipc_status() -> Result<(), String> {
    // 检查 daemon 是否可用（连接失败时会自动弹出错误窗口）
    if !is_daemon_available().await {
        let daemon_path = find_daemon_executable()
            .unwrap_or_else(|_| std::path::PathBuf::from("kabegame-daemon"));
        return Err(format!(
            "无法连接 kabegame-daemon\n提示：请先启动 `{}`",
            daemon_path.display()
        ));
    }
    let resp = kabegame_core::ipc::ipc::request(kabegame_core::ipc::ipc::CliIpcRequest::Status).await?;
    println!(
        "{}",
        serde_json::to_string_pretty(&resp).unwrap_or_else(|_| "ok".to_string())
    );
    Ok(())
}

// NOTE: vd daemon 已迁移到独立的 `kabegame-daemon` 中，通过统一 IPC 提供服务。

async fn import_plugin(args: ImportPluginArgs) -> Result<(), String> {
    let p = args.path;
    if !p.is_file() {
        return Err(format!("插件文件不存在: {}", p.display()));
    }
    if p.extension().and_then(|s| s.to_str()) != Some("kgpg") {
        return Err(format!("不是 .kgpg 文件: {}", p.display()));
    }

    import_plugin_no_ui(p).await
}

async fn import_plugin_no_ui(p: PathBuf) -> Result<(), String> {
    // 初始化全局 PluginManager（不再使用 manage）
    PluginManager::init_global()?;
    let pm = PluginManager::global();

    // 初始化插件缓存（会自动合并读取内置和用户目录）
    if let Err(e) = pm.ensure_installed_cache_initialized().await {
        eprintln!("[WARN] 初始化插件缓存失败（将继续导入）：{e}");
    }

    // 结构检查（尽量给出更友好的错误）
    validate_kgpg_structure(pm, &p)?;

    let plugin = pm.install_plugin_from_zip(&p).await?;
    let plugins_dir = pm.get_plugins_directory();

    println!(
        "导入成功：id={}; name={}; version={}; 目标目录={}",
        plugin.id,
        plugin.name,
        plugin.version,
        plugins_dir.display()
    );
    Ok(())
}

fn validate_kgpg_structure(pm: &PluginManager, zip_path: &std::path::Path) -> Result<(), String> {
    // 1) manifest 必须可读/可解析
    let _ = pm.read_plugin_manifest(zip_path)?;

    // 2) crawl.rhai 必须存在（插件包的核心）
    let script = pm.read_plugin_script(zip_path)?;
    if script.as_deref().unwrap_or("").trim().is_empty() {
        return Err("插件包缺少 crawl.rhai（或内容为空）".to_string());
    }

    // 3) config.json 若存在必须可解析（避免"安装后才炸"）
    let _ = pm.read_plugin_config_public(zip_path)?;

    Ok(())
}

fn pack_plugin(args: PackPluginArgs) -> Result<(), String> {
    let plugin_dir = args.plugin_dir;
    if !plugin_dir.is_dir() {
        return Err(format!("插件目录不存在: {}", plugin_dir.display()));
    }

    // 读取并解析 manifest.json（完整 manifest 仍会写入 ZIP；头部只写 mini 字段）
    let manifest_path = plugin_dir.join("manifest.json");
    if !manifest_path.is_file() {
        return Err(format!("缺少必需文件: {}", manifest_path.display()));
    }
    let manifest_raw = std::fs::read_to_string(&manifest_path)
        .map_err(|e| format!("读取 manifest.json 失败: {}", e))?;
    let manifest_val: serde_json::Value = serde_json::from_str(&manifest_raw)
        .map_err(|e| format!("解析 manifest.json 失败: {}", e))?;

    let mini = serde_json::json!({
        "name": manifest_val.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        "version": manifest_val.get("version").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        "description": manifest_val.get("description").and_then(|v| v.as_str()).unwrap_or("").to_string(),
    });
    let mini_bytes =
        serde_json::to_vec(&mini).map_err(|e| format!("序列化头部 manifest 失败: {}", e))?;

    // icon（头部）：优先读取 icon.png；ZIP 内不再包含 icon.png
    let icon_path = plugin_dir.join("icon.png");
    let icon_rgb = if icon_path.is_file() {
        Some(kgpg::icon_png_to_rgb24_fixed(&icon_path)?)
    } else {
        None
    };
    let header = kgpg::build_kgpg2_header(icon_rgb.as_deref(), &mini_bytes)?;

    // 生成 ZIP bytes
    let zip_bytes = build_plugin_zip_bytes(&plugin_dir)?;
    kgpg::write_kgpg2_from_zip_bytes(&args.output, &header, &zip_bytes)?;
    Ok(())
}

fn build_plugin_zip_bytes(plugin_dir: &PathBuf) -> Result<Vec<u8>, String> {
    use std::io::Write;

    let required = plugin_dir.join("crawl.rhai");
    if !required.is_file() {
        return Err(format!("缺少必需文件: {}", required.display()));
    }

    // 收集要写入 ZIP 的条目（v2：明确不包含 icon.png）
    let mut entries: Vec<(String, PathBuf)> = Vec::new();
    entries.push((
        "manifest.json".to_string(),
        plugin_dir.join("manifest.json"),
    ));
    entries.push(("crawl.rhai".to_string(), plugin_dir.join("crawl.rhai")));

    let config = plugin_dir.join("config.json");
    if config.is_file() {
        entries.push(("config.json".to_string(), config));
    }

    // doc_root（仅允许 doc.md + 常见图片）
    let doc_root = plugin_dir.join("doc_root");
    if doc_root.is_dir() {
        let doc_md = doc_root.join("doc.md");
        if doc_md.is_file() {
            entries.push(("doc_root/doc.md".to_string(), doc_md));
        }

        // 图片资源（递归）
        let mut stack = vec![doc_root.clone()];
        while let Some(dir) = stack.pop() {
            let rd = std::fs::read_dir(&dir).map_err(|e| format!("读取 doc_root 失败: {}", e))?;
            for ent in rd {
                let ent = ent.map_err(|e| format!("读取 doc_root 失败: {}", e))?;
                let p = ent.path();
                if p.is_dir() {
                    stack.push(p);
                    continue;
                }
                if !p.is_file() {
                    continue;
                }
                let ext = p
                    .extension()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_ascii_lowercase();
                let ok = matches!(
                    ext.as_str(),
                    "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp" | "svg" | "ico"
                );
                if !ok {
                    continue;
                }
                let rel = p
                    .strip_prefix(plugin_dir)
                    .map_err(|_| "doc_root 路径异常".to_string())?
                    .to_string_lossy()
                    .replace('\\', "/");
                // 只允许 doc_root 内
                if !rel.starts_with("doc_root/") {
                    continue;
                }
                // 避免重复添加 doc.md
                if rel == "doc_root/doc.md" {
                    continue;
                }
                entries.push((rel, p));
            }
        }
    }

    // 写 ZIP 到内存
    let mut buf: Vec<u8> = Vec::new();
    {
        let cursor = std::io::Cursor::new(&mut buf);
        let mut zip = zip::ZipWriter::new(cursor);
        let opt = zip::write::FileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .unix_permissions(0o644);

        for (name, path) in entries {
            let bytes = std::fs::read(&path)
                .map_err(|e| format!("读取文件失败 {}: {}", path.display(), e))?;
            zip.start_file(name, opt)
                .map_err(|e| format!("写入 ZIP 失败: {}", e))?;
            zip.write_all(&bytes)
                .map_err(|e| format!("写入 ZIP 失败: {}", e))?;
        }

        zip.finish().map_err(|e| format!("完成 ZIP 失败: {}", e))?;
    }
    Ok(buf)
}
