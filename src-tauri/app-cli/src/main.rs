//! Kabegame CLI（sidecar）
//!
//! 目前支持：
//! - `plugin run`：运行 Rhai 爬虫插件（支持通过插件 id 或 .kgpg 路径）
//!   - `--` 之后的参数会被解析并映射到插件 `config.json` 的 `var` 变量
//!   - required 规则：与前端一致，`default` 不存在即视为 required
//! - `plugin pack`：打包单个插件目录为 `.kgpg`（KGPG v2：固定头部 + ZIP，ZIP 内不含 icon.png）
//! - `plugin import`：导入本地 `.kgpg` 插件文件（复制到 plugins_directory）

use clap::{Args, Parser, Subcommand};
use kabegame_core::{
    crawler, kgpg,
    plugin::{ImportPreview, Plugin, PluginDetail, PluginManager, PluginManifest, VarDefinition},
    providers,
    settings::Settings,
    storage::Storage,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::Manager;

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
    /// 插件相关命令
    #[command(subcommand)]
    Plugin(PluginCommands),

    /// 虚拟盘（Windows Dokan）相关命令
    #[command(subcommand)]
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
enum VdCommands {
    /// 提权 daemon：通过命名管道/本地 socket 提供 mount/unmount/status 服务（建议用 runas 启动）
    Daemon,
    /// 挂载虚拟盘（需要管理员权限；该命令会常驻直到被卸载）
    Mount(VdMountArgs),
    /// 卸载虚拟盘（需要管理员权限）
    Unmount(VdUnmountArgs),
    /// 检查挂载点是否可访问（非严格判定，仅用于脚本探测）
    Status(VdStatusArgs),
}

#[derive(Args, Debug)]
struct VdMountArgs {
    /// 挂载点（例如 K:\\ 或 K: 或 K）
    #[arg(long = "mount-point")]
    mount_point: String,

    /// 仅尝试挂载并立即退出（不推荐；默认会常驻作为 Dokan 服务端进程）
    #[arg(long = "no-wait", default_value_t = false)]
    no_wait: bool,
}

#[derive(Args, Debug)]
struct VdUnmountArgs {
    /// 挂载点（例如 K:\\ 或 K: 或 K）
    #[arg(long = "mount-point")]
    mount_point: String,
}

#[derive(Args, Debug)]
struct VdStatusArgs {
    /// 挂载点（例如 K:\\ 或 K: 或 K）
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

    /// 不启动 UI，直接执行导入（适合脚本/自动化）
    #[arg(long = "no-ui", default_value_t = false)]
    no_ui: bool,
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

    /// 输出画册 ID（可选）
    #[arg(long = "output-album-id")]
    output_album_id: Option<String>,

    /// 传给插件的参数（必须放在 `--` 之后）
    #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
    plugin_args: Vec<String>,
}

fn main() {
    let cli = Cli::parse();

    let res = match cli.command {
        Commands::Plugin(cmd) => match cmd {
            PluginCommands::Run(args) => {
                let app = build_minimal_app().unwrap_or_else(|e| {
                    eprintln!("初始化失败: {e}");
                    std::process::exit(1);
                });
                let rt = tokio::runtime::Runtime::new().unwrap_or_else(|e| {
                    eprintln!("创建 Tokio Runtime 失败: {e}");
                    std::process::exit(1);
                });
                rt.block_on(run_plugin(app.handle().clone(), args))
            }
            PluginCommands::Pack(args) => pack_plugin(args),
            PluginCommands::Import(args) => import_plugin(args),
        },
        Commands::Vd(cmd) => match cmd {
            VdCommands::Daemon => vd_daemon(),
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

fn build_minimal_app() -> Result<tauri::App, String> {
    tauri::Builder::default()
        .setup(|app| {
            // 初始化插件管理器
            let plugin_manager = PluginManager::new(app.app_handle().clone());
            app.manage(plugin_manager);

            // 初始化存储管理器（下载/入库依赖）
            let storage = Storage::new(app.app_handle().clone());
            storage
                .init()
                .map_err(|e| format!("Failed to initialize storage: {}", e))?;
            app.manage(storage);

            // 初始化 ProviderRuntime（虚拟盘/画廊 provider 浏览依赖）
            // 与 app-main 启动逻辑一致：失败则 fallback 默认配置。
            let rt = providers::ProviderRuntime::new(providers::ProviderCacheConfig::default())
                .or_else(|e| {
                    eprintln!(
                        "[providers] init ProviderRuntime failed, fallback to default cfg: {}",
                        e
                    );
                    providers::ProviderRuntime::new(providers::ProviderCacheConfig::default())
                })
                .map_err(|e| format!("ProviderRuntime init failed: {}", e))?;
            app.manage(rt);

            // 初始化设置管理器（下载队列会读设置并发数等）
            let settings = Settings::new(app.app_handle().clone());
            app.manage(settings);

            // 初始化下载队列
            let download_queue = crawler::DownloadQueue::new(app.app_handle().clone());
            app.manage(download_queue);

            Ok(())
        })
        .build(tauri::generate_context!())
        .map_err(|e| format!("Build tauri app failed: {}", e))
}

fn vd_mount(args: VdMountArgs) -> Result<(), String> {
    #[cfg(not(all(feature = "virtual-drive", target_os = "windows")))]
    {
        let _ = args;
        return Err("当前平台/构建未启用虚拟盘（virtual-drive）".to_string());
    }

    #[cfg(all(feature = "virtual-drive", target_os = "windows"))]
    {
        use kabegame_core::virtual_drive::drive_service::VirtualDriveServiceTrait;

        let app = build_minimal_app()?;
        let storage = app.handle().state::<Storage>().inner().clone();

        let drive = kabegame_core::virtual_drive::VirtualDriveService::default();
        drive.mount(&args.mount_point, storage, app.handle().clone())?;

        println!("mounted: {}", args.mount_point);

        if args.no_wait {
            return Ok(());
        }

        // Dokan 的用户态文件系统服务端需要常驻进程。
        // 这里阻塞住，直到外部卸载（vd unmount）触发 mount loop 结束，或进程被终止。
        loop {
            std::thread::park();
        }
    }
}

fn vd_unmount(args: VdUnmountArgs) -> Result<(), String> {
    #[cfg(not(all(feature = "virtual-drive", target_os = "windows")))]
    {
        let _ = args;
        return Err("当前平台/构建未启用虚拟盘（virtual-drive）".to_string());
    }

    #[cfg(all(feature = "virtual-drive", target_os = "windows"))]
    {
        let ok = kabegame_core::virtual_drive::drive_service::dokan_unmount_by_mount_point(
            &args.mount_point,
        )?;
        if ok {
            println!("unmounted: {}", args.mount_point);
        } else {
            println!("not mounted: {}", args.mount_point);
        }
        Ok(())
    }
}

fn vd_status(args: VdStatusArgs) -> Result<(), String> {
    let mp = args.mount_point.trim();
    if mp.is_empty() {
        return Err("mount_point 不能为空".to_string());
    }

    // 非严格：能 read_dir 则认为“可访问”
    let p = std::path::PathBuf::from(mp);
    match std::fs::read_dir(&p) {
        Ok(_) => {
            println!("ok");
            Ok(())
        }
        Err(e) => Err(format!("not accessible: {}", e)),
    }
}

fn vd_daemon() -> Result<(), String> {
    #[cfg(not(all(feature = "virtual-drive", target_os = "windows")))]
    {
        return Err("vd daemon 目前仅用于 Windows virtual-drive 构建".to_string());
    }

    #[cfg(all(feature = "virtual-drive", target_os = "windows"))]
    {
        use kabegame_core::virtual_drive::drive_service::VirtualDriveServiceTrait;
        use kabegame_core::virtual_drive::ipc::{self, VdIpcRequest, VdIpcResponse};

        use std::sync::Arc;

        let app = build_minimal_app()?;
        let storage = app.handle().state::<Storage>().inner().clone();
        let drive = Arc::new(kabegame_core::virtual_drive::VirtualDriveService::default());
        let app_handle = Arc::new(app.handle().clone());

        let rt = tokio::runtime::Runtime::new()
            .map_err(|e| format!("create tokio runtime failed: {}", e))?;

        // daemon：单线程处理请求即可（每个连接单次 request/response）
        rt.block_on(async move {
            ipc::serve(move |req| {
                let storage = storage.clone();
                let app_handle = app_handle.clone();
                let drive = drive.clone();
                async move {
                    match req {
                        VdIpcRequest::Mount { mount_point } => {
                            match drive.mount(&mount_point, storage.clone(), (*app_handle).clone()) {
                                Ok(()) => {
                                    let mp = drive.current_mount_point().unwrap_or(mount_point);
                                    VdIpcResponse {
                                        ok: true,
                                        message: Some("mounted".to_string()),
                                        mounted: Some(true),
                                        mount_point: Some(mp),
                                    }
                                }
                                Err(e) => VdIpcResponse::err(e),
                            }
                        }
                        VdIpcRequest::Unmount { mount_point } => {
                            // 优先卸载本进程维护的挂载；若不一致则按 mount_point 强制卸载
                            match drive.unmount() {
                                Ok(true) => VdIpcResponse {
                                    ok: true,
                                    message: Some("unmounted".to_string()),
                                    mounted: Some(false),
                                    mount_point: Some(mount_point),
                                },
                                _ => match kabegame_core::virtual_drive::drive_service::dokan_unmount_by_mount_point(&mount_point) {
                                    Ok(ok) => VdIpcResponse {
                                        ok: true,
                                        message: Some(if ok { "unmounted".to_string() } else { "not mounted".to_string() }),
                                        mounted: Some(false),
                                        mount_point: Some(mount_point),
                                    },
                                    Err(e) => VdIpcResponse::err(e),
                                },
                            }
                        }
                        VdIpcRequest::Status => {
                            let mp = drive.current_mount_point();
                            VdIpcResponse {
                                ok: true,
                                message: Some("status".to_string()),
                                mounted: Some(mp.is_some()),
                                mount_point: mp,
                            }
                        }
                    }
                }
            })
            .await
        })?;

        Ok(())
    }
}

fn import_plugin(args: ImportPluginArgs) -> Result<(), String> {
    let p = args.path;
    if !p.is_file() {
        return Err(format!("插件文件不存在: {}", p.display()));
    }
    if p.extension().and_then(|s| s.to_str()) != Some("kgpg") {
        return Err(format!("不是 .kgpg 文件: {}", p.display()));
    }

    if args.no_ui {
        return import_plugin_no_ui(p);
    }
    import_plugin_with_ui(p)
}

fn import_plugin_no_ui(p: PathBuf) -> Result<(), String> {
    let app = build_minimal_app()?;
    let pm = app.handle().state::<PluginManager>();

    // 先确保内置插件安装（主要是为了保证 plugins_directory 初始化/存在；失败不阻断导入）
    if let Err(e) = pm.ensure_prepackaged_plugins_installed() {
        eprintln!("[WARN] 安装内置插件失败（将继续导入）：{e}");
    }

    // 结构检查（尽量给出更友好的错误）
    validate_kgpg_structure(&pm, &p)?;

    let plugin = pm.install_plugin_from_zip(&p)?;
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CliImportPreview {
    preview: ImportPreview,
    manifest: PluginManifest,
    icon_png_base64: Option<String>,
    file_path: String,
    plugins_dir: String,
}

#[tauri::command]
fn cli_preview_import_plugin(
    zip_path: String,
    state: tauri::State<PluginManager>,
) -> Result<CliImportPreview, String> {
    let path = std::path::PathBuf::from(&zip_path);
    if !path.is_file() {
        return Err(format!("插件文件不存在: {}", zip_path));
    }
    if path.extension().and_then(|s| s.to_str()) != Some("kgpg") {
        return Err(format!("不是 .kgpg 文件: {}", zip_path));
    }

    // 先确保内置插件安装（主要为了初始化 plugins_directory；失败不阻断预览）
    if let Err(e) = state.ensure_prepackaged_plugins_installed() {
        eprintln!("[WARN] 安装内置插件失败（将继续预览）：{e}");
    }

    // 结构检查
    validate_kgpg_structure(&state, &path)?;

    let preview = state.preview_import_from_zip(&path)?;
    let manifest = state.read_plugin_manifest(&path)?;
    let icon_png_base64 = {
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        match state.read_plugin_icon(&path)? {
            Some(bytes) if !bytes.is_empty() => Some(STANDARD.encode(bytes)),
            _ => None,
        }
    };

    Ok(CliImportPreview {
        preview,
        manifest,
        icon_png_base64,
        file_path: path.to_string_lossy().to_string(),
        plugins_dir: state.get_plugins_directory().to_string_lossy().to_string(),
    })
}

#[tauri::command]
fn cli_import_plugin_from_zip(
    zip_path: String,
    state: tauri::State<PluginManager>,
) -> Result<Plugin, String> {
    let path = std::path::PathBuf::from(&zip_path);
    if !path.is_file() {
        return Err(format!("插件文件不存在: {}", zip_path));
    }
    if path.extension().and_then(|s| s.to_str()) != Some("kgpg") {
        return Err(format!("不是 .kgpg 文件: {}", zip_path));
    }

    // 再做一次结构检查，避免 UI 预览后文件被替换/损坏
    validate_kgpg_structure(&state, &path)?;
    state.install_plugin_from_zip(&path)
}

#[tauri::command]
fn cli_get_plugin_detail_from_zip(
    zip_path: String,
    state: tauri::State<PluginManager>,
) -> Result<PluginDetail, String> {
    let path = std::path::PathBuf::from(&zip_path);
    if !path.is_file() {
        return Err(format!("插件文件不存在: {}", zip_path));
    }
    if path.extension().and_then(|s| s.to_str()) != Some("kgpg") {
        return Err(format!("不是 .kgpg 文件: {}", zip_path));
    }

    // 复用结构检查，提前给出友好错误
    validate_kgpg_structure(&state, &path)?;

    let plugin_id = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("plugin")
        .to_string();

    let manifest = state.read_plugin_manifest(&path)?;
    let doc = state.read_plugin_doc_public(&path).ok().flatten();
    let icon_data = state.read_plugin_icon(&path).ok().flatten();
    let config = state.read_plugin_config_public(&path).ok().flatten();
    let base_url = config.and_then(|c| c.base_url);

    Ok(PluginDetail {
        id: plugin_id,
        name: manifest.name,
        desp: manifest.description,
        doc,
        icon_data,
        origin: "local".to_string(),
        base_url,
    })
}

#[tauri::command]
fn cli_get_plugin_image_from_zip(
    zip_path: String,
    image_path: String,
    state: tauri::State<PluginManager>,
) -> Result<Vec<u8>, String> {
    let path = std::path::PathBuf::from(&zip_path);
    if !path.is_file() {
        return Err(format!("插件文件不存在: {}", zip_path));
    }
    if path.extension().and_then(|s| s.to_str()) != Some("kgpg") {
        return Err(format!("不是 .kgpg 文件: {}", zip_path));
    }
    // image_path 的安全性由 read_plugin_image 内部校验
    state.read_plugin_image(&path, &image_path)
}

fn validate_kgpg_structure(pm: &PluginManager, zip_path: &std::path::Path) -> Result<(), String> {
    // 1) manifest 必须可读/可解析
    let _ = pm.read_plugin_manifest(zip_path)?;

    // 2) crawl.rhai 必须存在（插件包的核心）
    let script = pm.read_plugin_script(zip_path)?;
    if script.as_deref().unwrap_or("").trim().is_empty() {
        return Err("插件包缺少 crawl.rhai（或内容为空）".to_string());
    }

    // 3) config.json 若存在必须可解析（避免“安装后才炸”）
    let _ = pm.read_plugin_config_public(zip_path)?;

    Ok(())
}

fn import_plugin_with_ui(p: PathBuf) -> Result<(), String> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    let zip_path = p.to_string_lossy().to_string();
    let encoded = url::form_urlencoded::byte_serialize(zip_path.as_bytes()).collect::<String>();
    let url = WebviewUrl::App(format!("index.html?zipPath={}", encoded).into());

    let context = tauri::generate_context!();

    tauri::Builder::default()
        .setup(move |app| {
            // 只初始化插件管理器（导入 UI 不需要 Storage/Settings/DownloadQueue）
            let plugin_manager = PluginManager::new(app.app_handle().clone());
            app.manage(plugin_manager);

            let _ = WebviewWindowBuilder::new(app, "cli-import", url.clone())
                .title("Kabegame 插件导入")
                .inner_size(800.0, 1000.0)
                .resizable(true)
                .build();

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            cli_preview_import_plugin,
            cli_import_plugin_from_zip,
            cli_get_plugin_detail_from_zip,
            cli_get_plugin_image_from_zip
        ])
        .run(context)
        .map_err(|e| format!("运行导入窗口失败: {}", e))?;

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

async fn run_plugin(app: tauri::AppHandle, args: RunPluginArgs) -> Result<(), String> {
    let plugin_manager = app.state::<PluginManager>();

    // 确保内置插件已装到用户插件目录（id 运行依赖）
    if let Err(e) = plugin_manager.ensure_prepackaged_plugins_installed() {
        eprintln!("[WARN] 安装内置插件失败（将继续）：{e}");
    }

    let task_id = args
        .task_id
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let images_dir = args
        .output_dir
        .unwrap_or_else(crawler::get_default_images_dir);

    let (plugin, plugin_file_opt, var_defs) =
        plugin_manager.resolve_plugin_for_cli_run(&args.plugin)?;

    let user_cfg = parse_plugin_vars_from_tokens(&var_defs, &args.plugin_args)?;

    // required 检查（规则：default 不存在即 required）
    let missing = required_missing_keys(&var_defs, &user_cfg);
    if !missing.is_empty() {
        return Err(format!(
            "缺少必填参数（required）：{}\n提示：required 规则与前端一致，var 定义中 default 为空即视为必填。",
            missing.join(", ")
        ));
    }

    // 运行
    if let Some(plugin_file) = plugin_file_opt {
        crawler::crawl_images_from_plugin_file(
            &plugin,
            &plugin_file,
            &task_id,
            images_dir,
            app,
            Some(user_cfg),
            args.output_album_id,
        )
        .await?;
    } else {
        // id 模式：沿用既有实现（会从 plugins_directory 查找对应 .kgpg）
        crawler::crawl_images(
            &plugin,
            &task_id,
            images_dir,
            app,
            Some(user_cfg),
            args.output_album_id,
        )
        .await?;
    }

    Ok(())
}

fn required_missing_keys(
    var_defs: &[VarDefinition],
    user_cfg: &HashMap<String, serde_json::Value>,
) -> Vec<String> {
    let mut missing = Vec::new();
    for def in var_defs {
        let is_required = def.default.is_none();
        if is_required && !user_cfg.contains_key(&def.key) {
            missing.push(def.key.clone());
        }
    }
    missing
}

fn parse_plugin_vars_from_tokens(
    var_defs: &[VarDefinition],
    tokens: &[String],
) -> Result<HashMap<String, serde_json::Value>, String> {
    // 1) 先把 tokens 分成：命名参数（key -> raw string）和位置参数（Vec）
    let mut named: HashMap<String, Vec<String>> = HashMap::new();
    let mut positional: Vec<String> = Vec::new();

    let mut i = 0usize;
    while i < tokens.len() {
        let t = &tokens[i];

        // 支持：--key=value
        if let Some(rest) = t.strip_prefix("--") {
            if rest.is_empty() {
                i += 1;
                continue;
            }
            if let Some((k, v)) = rest.split_once('=') {
                named.entry(k.to_string()).or_default().push(v.to_string());
                i += 1;
                continue;
            }
            // 支持：--key value / --flag
            let k = rest.to_string();
            let v = if i + 1 < tokens.len() && !tokens[i + 1].starts_with("--") {
                i += 1;
                tokens[i].clone()
            } else {
                "true".to_string()
            };
            named.entry(k).or_default().push(v);
            i += 1;
            continue;
        }

        // 支持：key=value
        if let Some((k, v)) = t.split_once('=') {
            if !k.is_empty() {
                named.entry(k.to_string()).or_default().push(v.to_string());
                i += 1;
                continue;
            }
        }

        positional.push(t.clone());
        i += 1;
    }

    // 2) 按 var_defs 顺序消费 positional，并把 named 转成 JSON value
    let mut out: HashMap<String, serde_json::Value> = HashMap::new();
    let mut pos_idx = 0usize;

    for def in var_defs {
        let key = def.key.as_str();
        let raw_opt = match named.remove(key) {
            Some(mut vs) if !vs.is_empty() => Some(vs.remove(0)),
            _ => {
                if pos_idx < positional.len() {
                    let v = positional[pos_idx].clone();
                    pos_idx += 1;
                    Some(v)
                } else {
                    None
                }
            }
        };

        if let Some(raw) = raw_opt {
            let v = parse_value_for_var(def, &raw)?;
            out.insert(def.key.clone(), v);
        }
    }

    // 3) 仍然残留的 named（不在 var_defs 内）也注入（保持兼容扩展变量）
    for (k, mut vs) in named {
        if let Some(v0) = vs.pop() {
            out.insert(k, parse_value_fallback(&v0));
        }
    }

    Ok(out)
}

fn parse_value_for_var(def: &VarDefinition, raw: &str) -> Result<serde_json::Value, String> {
    let t = def.var_type.as_str();
    match t {
        "int" => raw
            .trim()
            .parse::<i64>()
            .map(|n| serde_json::Value::Number(n.into()))
            .map_err(|_| format!("参数 {} 需要 int，但得到：{}", def.key, raw)),
        "float" => raw
            .trim()
            .parse::<f64>()
            .ok()
            .and_then(serde_json::Number::from_f64)
            .map(serde_json::Value::Number)
            .ok_or_else(|| format!("参数 {} 需要 float，但得到：{}", def.key, raw)),
        "boolean" => parse_bool(raw).map(serde_json::Value::Bool).ok_or_else(|| {
            format!(
                "参数 {} 需要 boolean(true/false/1/0)，但得到：{}",
                def.key, raw
            )
        }),
        "list" => {
            // 支持 JSON 数组；否则用逗号分隔为 string[]
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) {
                Ok(v)
            } else {
                let arr: Vec<_> = raw
                    .split(',')
                    .map(|s| s.trim())
                    .filter(|s| !s.is_empty())
                    .map(|s| serde_json::Value::String(s.to_string()))
                    .collect();
                Ok(serde_json::Value::Array(arr))
            }
        }
        "checkbox" => {
            // normalize_var_value 会将 string/array/object 统一成 { option: bool }
            Ok(parse_value_fallback(raw))
        }
        "options" => Ok(serde_json::Value::String(raw.to_string())),
        _ => Ok(parse_value_fallback(raw)),
    }
}

fn parse_value_fallback(raw: &str) -> serde_json::Value {
    // 尝试解析 JSON（支持数字/数组/对象/bool），失败则当作字符串
    serde_json::from_str::<serde_json::Value>(raw)
        .unwrap_or_else(|_| serde_json::Value::String(raw.to_string()))
}

fn parse_bool(raw: &str) -> Option<bool> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "true" | "1" | "yes" | "y" | "on" => Some(true),
        "false" | "0" | "no" | "n" | "off" => Some(false),
        _ => None,
    }
}
