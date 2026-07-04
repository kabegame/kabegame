//! Kabegame CLI（sidecar）
//!
//! 目前支持：
//! - `plugin run`：运行 Rhai 爬虫插件（支持通过插件 id 或 .kgpg 路径）
//!   - `--` 之后的参数会被解析并映射到插件 `config.json` 的 `var` 变量
//!   - required 规则：与前端一致，`default` 不存在即视为 required
//! - `plugin pack`：打包单个插件目录为 `.kgpg`（v2/v3 双轨）
//! - `plugin import`：导入本地 `.kgpg` 插件文件（复制到 plugins_directory）
//! - `plugin run migrate`：本地执行插件包内 metadata_migrations/vN.rhai，输入 JSON，输出 JSON

use clap::{Args, Parser, Subcommand, ValueEnum};
use include_dir::{include_dir, Dir};
use kabegame_core::ipc::client::daemon_startup::*;
use kabegame_core::plugin as core_plugin;
use kabegame_core::{
    kgpg,
    plugin::{manifest_value_to_display_string, PluginManager},
};
use regex::Regex;
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;

const TEMPLATE_DIR: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/template");

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
    Vd(VdCommands),
}

#[derive(Subcommand, Debug)]
enum PluginCommands {
    /// 创建插件模板目录
    New(NewPluginArgs),
    /// 运行爬虫插件（Rhai）
    Run(RunPluginArgs),
    /// 打包单个插件目录为 `.kgpg`（KGPG v2：固定头部 + ZIP，ZIP 内不含 icon.png）
    Pack(PackPluginArgs),
    /// 导入本地 `.kgpg` 插件文件（复制到 plugins_directory）
    Import(ImportPluginArgs),
}

#[derive(Subcommand, Debug)]
enum VdCommands {
    /// 挂载虚拟盘（通过 daemon IPC 触发）
    Mount(VdMountArgs),
    /// 卸载虚拟盘（通过 daemon IPC 触发）
    Unmount(VdUnmountArgs),
    /// 检查挂载点是否可访问（通过 daemon IPC 触发）
    Status(VdStatusArgs),
}

#[derive(Args, Debug)]
struct VdMountArgs {}

#[derive(Args, Debug)]
struct VdUnmountArgs {}

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

#[derive(Clone, Copy, Debug, ValueEnum)]
enum PluginBackend {
    Rhai,
    Webview,
    V8,
}

impl PluginBackend {
    fn kb_backend_str(self) -> &'static str {
        match self {
            Self::Rhai => "rhai",
            Self::Webview => "webview",
            Self::V8 => "v8",
        }
    }

    fn script_file_name(self) -> &'static str {
        match self {
            Self::Rhai => "crawl.rhai",
            Self::Webview => "crawl.js",
            Self::V8 => "crawl.js",
        }
    }
}

impl From<PluginBackend> for core_plugin::PluginBackend {
    fn from(b: PluginBackend) -> Self {
        match b {
            PluginBackend::Rhai => core_plugin::PluginBackend::Rhai,
            PluginBackend::Webview => core_plugin::PluginBackend::Webview,
            PluginBackend::V8 => core_plugin::PluginBackend::V8,
        }
    }
}

#[derive(Args, Debug)]
struct NewPluginArgs {
    /// 插件名（目录名）：仅允许 kebab-case（全小写）
    name: String,
    /// 插件后端（默认 v8）
    #[arg(long, value_enum, default_value_t = PluginBackend::V8)]
    backend: PluginBackend,
}

#[derive(Args, Debug)]
struct ImportPluginArgs {
    /// 本地插件文件路径（.kgpg）
    path: PathBuf,
}

#[derive(Args, Debug)]
struct RunPluginArgs {
    /// 特殊运行模式；`migrate` 表示本地测试 metadata_migrations
    #[arg(value_name = "RUN_COMMAND")]
    run_command: Option<String>,

    /// 插件 ID（已安装的 .kgpg 文件名，不含扩展名）或插件文件路径（.kgpg）
    #[arg(short = 'p', long = "plugin")]
    plugin: Option<String>,

    /// `plugin run migrate` 的输入 metadata JSON 字符串
    #[arg(long = "input")]
    migrate_input: Option<String>,

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

/// 解析 cargo-generate.toml 的条件规则，返回忽略文件集（相对于仓库根）
fn parse_cargo_generate_conditions(toml_src: &str, backend_str: &str) -> Result<Vec<String>, String> {
    let mut ignored: Vec<String> = Vec::new();
    let mut current_condition: Option<String> = None;
    let mut in_conditional = false;

    for line in toml_src.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("[conditional.") && trimmed.ends_with(']') {
            let cond = &trimmed[13..trimmed.len() - 1];
            let cond = cond.trim_matches('\'').trim_matches('"');
            current_condition = Some(cond.to_string());
            in_conditional = true;
            continue;
        }
        if in_conditional && (trimmed.starts_with('[') || trimmed.is_empty()) {
            in_conditional = false;
            current_condition = None;
            if trimmed.starts_with('[') && !trimmed.starts_with("[conditional.") {
                continue;
            }
        }
        if let Some(ref cond) = current_condition {
            if trimmed.starts_with("ignore") {
                let rest = trimmed.strip_prefix("ignore").unwrap_or("").trim();
                let rest = rest.strip_prefix('=').unwrap_or(rest).trim();
                let arr: Vec<String> = rest
                    .trim_start_matches('[')
                    .trim_end_matches(']')
                    .split(',')
                    .map(|s| s.trim().trim_matches('"').trim_matches('\'').to_string())
                    .filter(|s| !s.is_empty())
                    .collect();
                if eval_condition(cond, backend_str) {
                    ignored.extend(arr);
                }
            }
        }
    }
    Ok(ignored)
}

fn eval_condition(cond: &str, backend_str: &str) -> bool {
    if let Some(val) = cond.strip_prefix("backend != ").or_else(|| cond.strip_prefix("backend != \"").map(|s| s.trim_end_matches('"'))) {
        let val = val.trim_matches('"');
        return backend_str != val;
    }
    if let Some(val) = cond.strip_prefix("backend == ").or_else(|| cond.strip_prefix("backend == \"").map(|s| s.trim_end_matches('"'))) {
        let val = val.trim_matches('"');
        return backend_str == val;
    }
    false
}

/// 极简 Liquid 子集渲染：支持 {{ var }} 和 {% if var == "val" %} / {% elsif ... %} / {% else %} / {% endif %}
fn render_liquid_template(
    template: &str,
    vars: &HashMap<String, String>,
) -> Result<String, String> {
    let mut out = String::with_capacity(template.len());
    let mut i = 0;
    let chars: Vec<char> = template.chars().collect();
    let len = chars.len();

    // Stack: (in_true_branch, branch_has_rendered)
    let mut stack: Vec<(bool, bool)> = Vec::new();

    while i < len {
        if i + 2 < len && chars[i] == '{' && chars[i + 1] == '%' {
            // Control tag: {% ... %}
            let end = find_tag_end(&chars, i + 2, '%');
            let tag_body = chars_to_string(&chars[i + 2..end]).trim().to_string();
            i = end + 2;

            if let Some(cond) = tag_body.strip_prefix("if ") {
                let result = eval_liquid_cond(cond, vars);
                stack.push((result, result));
            } else if let Some(cond) = tag_body.strip_prefix("elsif ") {
                let (in_branch, rendered) = stack.pop().ok_or("unexpected elsif")?;
                if !rendered {
                    let result = eval_liquid_cond(cond, vars);
                    stack.push((result, !in_branch && result));
                } else {
                    stack.push((false, true));
                }
            } else if tag_body == "else" {
                let (in_branch, rendered) = stack.pop().ok_or("unexpected else")?;
                stack.push((!in_branch && !rendered, !rendered));
            } else if tag_body == "endif" {
                stack.pop().ok_or("unexpected endif")?;
            }
        } else if i + 2 < len && chars[i] == '{' && chars[i + 1] == '{' {
            // Variable: {{ var }}
            let end = find_tag_end(&chars, i + 2, '}');
            let var_name = chars_to_string(&chars[i + 2..end]).trim().to_string();
            i = end + 2;

            let should_render = stack.last().map(|(_, r)| *r).unwrap_or(true);
            if should_render {
                let raw = vars
                    .get(&var_name)
                    .cloned()
                    .unwrap_or_else(|| format!("{{{{ {} }}}}", var_name));
                out.push_str(&raw);
            }
        } else {
            let should_render = stack.last().map(|(_, r)| *r).unwrap_or(true);
            if should_render {
                out.push(chars[i]);
            }
            i += 1;
        }
    }

    Ok(out)
}

fn find_tag_end(chars: &[char], start: usize, tag_char: char) -> usize {
    let mut i = start;
    while i < chars.len() {
        if i + 1 < chars.len() && chars[i] == '%' && chars[i + 1] == '}' {
            return i;
        }
        if i + 1 < chars.len() && chars[i] == tag_char && chars[i + 1] == '}' {
            return i;
        }
        i += 1;
    }
    chars.len()
}

fn chars_to_string(chars: &[char]) -> String {
    chars.iter().collect()
}

fn eval_liquid_cond(cond: &str, vars: &HashMap<String, String>) -> bool {
    let cond = cond.trim();
    if let Some(rest) = cond.strip_prefix("backend == ") {
        let val = rest.trim().trim_matches('"');
        return vars.get("backend").map(|s| s.as_str()) == Some(val);
    }
    if let Some(rest) = cond.strip_prefix("backend != ") {
        let val = rest.trim().trim_matches('"');
        return vars.get("backend").map(|s| s.as_str()) != Some(val);
    }
    false
}

#[tokio::main]
async fn main() {
    #[cfg(target_os = "linux")]
    kabegame_core::workarounds::apply_nvidia_dmabuf_renderer_workaround();
    let cli = Cli::parse();

    let res = match cli.command {
        Commands::IpcStatus => ipc_status().await,
        Commands::Plugin(cmd) => match cmd {
            PluginCommands::New(args) => new_plugin(args),
            PluginCommands::Run(args) => run_plugin(args).await,
            PluginCommands::Pack(args) => pack_plugin(args),
            PluginCommands::Import(args) => import_plugin(args).await,
        },
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

fn new_plugin(args: NewPluginArgs) -> Result<(), String> {
    if !is_valid_plugin_name(&args.name) {
        return Err(format!(
            "非法插件名 `{}`：只允许 kebab-case（如 `my-plugin`）",
            args.name
        ));
    }

    let cwd = std::env::current_dir().map_err(|e| format!("读取当前目录失败: {e}"))?;
    let plugin_dir = cwd.join(&args.name);
    if plugin_dir.exists() {
        return Err(format!(
            "目标目录已存在，请先移除或更换名称: {}",
            plugin_dir.display()
        ));
    }

    std::fs::create_dir_all(&plugin_dir).map_err(|e| format!("创建插件目录失败: {e}"))?;

    let backend_str = args.backend.kb_backend_str().to_string();
    let backend_clone = backend_str.clone();
    let project_name = args.name.clone();

    let cargo_gen_toml = TEMPLATE_DIR
        .get_file("cargo-generate.toml")
        .and_then(|f| f.contents_utf8())
        .unwrap_or("");
    let ignored = parse_cargo_generate_conditions(cargo_gen_toml, &backend_str)?;

    let mut vars = HashMap::new();
    vars.insert("project-name".to_string(), project_name.clone());
    vars.insert("backend".to_string(), backend_clone);

    write_template_files(&TEMPLATE_DIR, "", &plugin_dir, &vars, &ignored)?;

    println!(
        "插件模板创建成功：{}（backend={}）",
        plugin_dir.display(),
        backend_str
    );
    Ok(())
}

fn write_template_files(
    dir: &Dir<'_>,
    rel_prefix: &str,
    out_dir: &Path,
    vars: &HashMap<String, String>,
    ignored: &[String],
) -> Result<(), String> {
    for entry in dir.entries() {
        match entry {
            include_dir::DirEntry::Dir(sub_dir) => {
                let rel = if rel_prefix.is_empty() {
                    sub_dir.path().to_string_lossy().to_string()
                } else {
                    format!("{}/{}", rel_prefix, sub_dir.path().to_string_lossy().to_string())
                };
                if rel == "src" && vars.get("backend").map(|s| s.as_str()) != Some("v8") {
                    continue;
                }
                write_template_files(sub_dir, &rel, out_dir, vars, ignored)?;
            }
            include_dir::DirEntry::File(file) => {
                let rel = if rel_prefix.is_empty() {
                    file.path().to_string_lossy().to_string()
                } else {
                    format!("{}/{}", rel_prefix, file.path().to_string_lossy().to_string())
                };
                if ignored.iter().any(|p| rel.starts_with(p.as_str()) || rel == *p) {
                    continue;
                }
                if rel == "cargo-generate.toml" {
                    continue;
                }
                let out_path = out_dir.join(&rel);
                if let Some(parent) = out_path.parent() {
                    std::fs::create_dir_all(parent)
                        .map_err(|e| format!("创建目录失败 {}: {e}", parent.display()))?;
                }
                let ext = out_path
                    .extension()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_ascii_lowercase();
                let is_text = matches!(ext.as_str(), "json" | "js" | "ts" | "mjs" | "rhai" | "md" | "toml" | "gitignore" | "kabegameignore");

                if is_text {
                    if let Some(text) = file.contents_utf8() {
                        let rendered = render_liquid_template(text, vars)?;
                        std::fs::write(&out_path, rendered)
                            .map_err(|e| format!("写入文件失败 {}: {e}", out_path.display()))?;
                    } else {
                        std::fs::write(&out_path, file.contents())
                            .map_err(|e| format!("写入文件失败 {}: {e}", out_path.display()))?;
                    }
                } else {
                    std::fs::write(&out_path, file.contents())
                        .map_err(|e| format!("写入文件失败 {}: {e}", out_path.display()))?;
                }
            }
        }
    }
    // Handle root-level files for the first level
    if rel_prefix.is_empty() {
        for entry in dir.files() {
            let rel = entry.path().to_string_lossy().to_string();
            if ignored.iter().any(|p| rel.starts_with(p.as_str()) || rel == *p) {
                continue;
            }
            if rel == "cargo-generate.toml" {
                continue;
            }
            // Already handled above
        }
    }
    Ok(())
}

fn is_valid_plugin_name(name: &str) -> bool {
    Regex::new(r"^[a-z][a-z0-9]*(-[a-z0-9]+)*$")
        .map(|re| re.is_match(name))
        .unwrap_or(false)
}

// NOTE: build_minimal_app / run_plugin 等"后台能力"已迁移到独立的 `kabegame-daemon` 中。

/// 运行插件命令
async fn run_plugin(args: RunPluginArgs) -> Result<(), String> {
    if args.run_command.as_deref() == Some("migrate") {
        return run_plugin_migrate(args).await;
    }
    if let Some(command) = args.run_command.as_deref() {
        return Err(format!("未知 plugin run 子命令 `{command}`"));
    }
    if args.migrate_input.is_some() {
        return Err("`--input` 只能用于 `plugin run migrate`".to_string());
    }
    let plugin = args
        .plugin
        .ok_or_else(|| "缺少必需参数：--plugin <PLUGIN>".to_string())?;

    if !is_daemon_available().await {
        let daemon_path = find_daemon_executable()
            .unwrap_or_else(|_| std::path::PathBuf::from("kabegame-daemon"));
        return Err(format!(
            "无法连接 kabegame-daemon\n提示：请先启动 `{}`",
            daemon_path.display()
        ));
    }

    let output_album_id = match args.output_album {
        Some(name) => match resolve_album_name_to_id(&name).await {
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

    let req = kabegame_core::ipc::ipc::IpcRequest::PluginRun {
        plugin,
        output_dir: args
            .output_dir
            .as_ref()
            .map(|p| p.to_string_lossy().to_string()),
        task_id: args.task_id,
        output_album_id,
        plugin_args: args.plugin_args,
        http_headers: None,
    };
    match kabegame_core::ipc::ipc::request(req).await {
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

async fn run_plugin_migrate(args: RunPluginArgs) -> Result<(), String> {
    if args.output_dir.is_some()
        || args.task_id.is_some()
        || args.output_album.is_some()
        || !args.plugin_args.is_empty()
    {
        return Err(
            "`plugin run migrate` 只接受 `--input <JSON>` 和 `--plugin <plugin.kgpg>`".to_string(),
        );
    }

    let input = args
        .migrate_input
        .ok_or_else(|| "缺少必需参数：--input <JSON>".to_string())?;
    let plugin_path = args
        .plugin
        .map(PathBuf::from)
        .ok_or_else(|| "缺少必需参数：--plugin <plugin.kgpg>".to_string())?;

    let pm = PluginManager::new();
    let plugin = pm.preview_import_from_kgpg(&plugin_path).await?;
    let scripts = plugin.metadata_migrations.into_iter().collect();
    let output =
        kabegame_core::plugin::metadata_migration::test_metadata_migrations(input, scripts)?;
    println!("{output}");
    Ok(())
}

/// 将画册名称转换为 ID（通过 IPC 查询）
async fn resolve_album_name_to_id(name: &str) -> Result<Option<String>, String> {
    use kabegame_core::ipc::client::IpcClient;
    use kabegame_core::storage::albums::Album;

    let client = IpcClient::new();
    let albums_value = client.storage_get_albums().await?;

    let albums: Vec<Album> =
        serde_json::from_value(albums_value).map_err(|e| format!("解析画册列表失败: {}", e))?;

    let name_lower = name.trim().to_lowercase();
    for album in albums {
        if album.name.to_lowercase() == name_lower {
            return Ok(Some(album.id));
        }
    }

    Ok(None)
}

fn vd_mount(_args: VdMountArgs) -> Result<(), String> {
    let rt =
        tokio::runtime::Runtime::new().map_err(|e| format!("create tokio runtime failed: {e}"))?;
    if !rt.block_on(kabegame_core::ipc::client::daemon_startup::is_daemon_available()) {
        let daemon_path = kabegame_core::ipc::client::daemon_startup::find_daemon_executable()
            .unwrap_or_else(|_| std::path::PathBuf::from("kabegame-daemon"));
        return Err(format!(
            "无法连接 kabegame-daemon\n提示：请先启动 `{}`",
            daemon_path.display()
        ));
    }
    let req = kabegame_core::ipc::ipc::IpcRequest::VdMount;
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

fn vd_unmount(_args: VdUnmountArgs) -> Result<(), String> {
    let rt =
        tokio::runtime::Runtime::new().map_err(|e| format!("create tokio runtime failed: {e}"))?;
    if !rt.block_on(is_daemon_available()) {
        let daemon_path = find_daemon_executable()
            .unwrap_or_else(|_| std::path::PathBuf::from("kabegame-daemon"));
        return Err(format!(
            "无法连接 kabegame-daemon\n提示：请先启动 `{}`",
            daemon_path.display()
        ));
    }
    let req = kabegame_core::ipc::ipc::IpcRequest::VdUnmount;
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

fn vd_status(args: VdStatusArgs) -> Result<(), String> {
    let _ = args;
    let rt =
        tokio::runtime::Runtime::new().map_err(|e| format!("create tokio runtime failed: {e}"))?;
    if !rt.block_on(is_daemon_available()) {
        let daemon_path = find_daemon_executable()
            .unwrap_or_else(|_| std::path::PathBuf::from("kabegame-daemon"));
        return Err(format!(
            "无法连接 kabegame-daemon\n提示：请先启动 `{}`",
            daemon_path.display()
        ));
    }
    let req = kabegame_core::ipc::ipc::IpcRequest::VdStatus;
    let resp = rt.block_on(kabegame_core::ipc::ipc::request(req))?;
    println!(
        "{}",
        serde_json::to_string_pretty(&resp).unwrap_or_else(|_| "ok".to_string())
    );
    Ok(())
}

async fn ipc_status() -> Result<(), String> {
    if !is_daemon_available().await {
        let daemon_path = find_daemon_executable()
            .unwrap_or_else(|_| std::path::PathBuf::from("kabegame-daemon"));
        return Err(format!(
            "无法连接 kabegame-daemon\n提示：请先启动 `{}`",
            daemon_path.display()
        ));
    }
    let resp =
        kabegame_core::ipc::ipc::request(kabegame_core::ipc::ipc::IpcRequest::Status).await?;
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
    PluginManager::init_global()?;
    let pm = PluginManager::global();

    if let Err(e) = pm.ensure_installed_cache_initialized().await {
        eprintln!("[WARN] 初始化插件缓存失败（将继续导入）：{e}");
    }

    validate_kgpg_structure(pm, &p).await?;

    let plugin = pm.install_plugin_from_kgpg(&p).await?;
    let plugins_dir = pm.get_plugins_directory();

    println!(
        "导入成功：id={}; name={}; version={}; 目标目录={}",
        plugin.id,
        manifest_value_to_display_string(&plugin.name),
        plugin.version,
        plugins_dir.display()
    );
    Ok(())
}

async fn validate_kgpg_structure(
    pm: &PluginManager,
    zip_path: &std::path::Path,
) -> Result<(), String> {
    let _manifest = pm.read_plugin_manifest(zip_path).await?;

    // 检查 zip 内是否有 package.json 且为 v3
    if let Some(pkg) = read_optional_package_json_from_zip(zip_path)? {
        if core_plugin::package_json_is_v3(&pkg) {
            let main_path = pkg
                .get("main")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if main_path.is_empty() || !has_non_empty_zip_entry(zip_path, main_path)? {
                return Err(format!(
                    "v3 插件包 `main` 脚本不存在或为空: {}",
                    main_path
                ));
            }
            let _ = pm.read_plugin_config_public(zip_path)?;
            return Ok(());
        }
    }

    // v2 回退
    let script = pm.read_plugin_script(zip_path)?;
    let has_rhai = !script.as_deref().unwrap_or("").trim().is_empty();
    let has_webview = has_non_empty_zip_entry(zip_path, "crawl.js")?;
    if !has_rhai && !has_webview {
        return Err("插件包缺少 crawl.rhai / crawl.js（或内容为空）".to_string());
    }

    let _ = pm.read_plugin_config_public(zip_path)?;

    Ok(())
}

// ── Pack ──

fn read_optional_package_json(plugin_dir: &Path) -> Result<Option<serde_json::Value>, String> {
    let pkg_path = plugin_dir.join("package.json");
    if !pkg_path.is_file() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&pkg_path)
        .map_err(|e| format!("读取 package.json 失败: {}", e))?;
    let val: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("解析 package.json 失败: {}", e))?;
    Ok(Some(val))
}

fn read_optional_package_json_from_zip(
    zip_path: &Path,
) -> Result<Option<serde_json::Value>, String> {
    let file_bytes = std::fs::read(zip_path)
        .map_err(|e| format!("读取插件包失败 {}: {e}", zip_path.display()))?;
    let zip_offset = file_bytes
        .windows(4)
        .position(|w| w == [0x50, 0x4B, 0x03, 0x04])
        .ok_or_else(|| format!("插件包不是有效 ZIP/KGPG 格式: {}", zip_path.display()))?;

    let cursor = std::io::Cursor::new(file_bytes[zip_offset..].to_vec());
    let mut archive =
        zip::ZipArchive::new(cursor).map_err(|e| format!("解析插件 ZIP 失败: {e}"))?;
    let result = match archive.by_name("package.json") {
        Ok(mut f) => {
            let mut s = String::new();
            f.read_to_string(&mut s)
                .map_err(|e| format!("读取 package.json 失败: {e}"))?;
            let val: serde_json::Value =
                serde_json::from_str(&s).map_err(|e| format!("解析 package.json 失败: {e}"))?;
            Ok(Some(val))
        }
        Err(_) => Ok(None),
    };
    result
}

fn pack_plugin(args: PackPluginArgs) -> Result<(), String> {
    let plugin_dir = args.plugin_dir;
    if !plugin_dir.is_dir() {
        return Err(format!("插件目录不存在: {}", plugin_dir.display()));
    }

    let pkg = read_optional_package_json(&plugin_dir)?;
    match pkg.as_ref().filter(|v| core_plugin::package_json_is_v3(v)) {
        Some(pkg) => pack_plugin_v3(&plugin_dir, &args.output, pkg),
        None => pack_plugin_v2(&plugin_dir, &args.output),
    }
}

fn pack_plugin_v2(
    plugin_dir: &PathBuf,
    output: &Path,
) -> Result<(), String> {
    let manifest_path = plugin_dir.join("manifest.json");
    if !manifest_path.is_file() {
        return Err(format!("缺少必需文件: {}", manifest_path.display()));
    }
    let manifest_raw = std::fs::read_to_string(&manifest_path)
        .map_err(|e| format!("读取 manifest.json 失败: {}", e))?;
    let manifest_val: serde_json::Value = serde_json::from_str(&manifest_raw)
        .map_err(|e| format!("解析 manifest.json 失败: {}", e))?;

    let header_manifest_bytes = serde_json::to_vec(&manifest_val)
        .map_err(|e| format!("序列化头部 manifest 失败: {}", e))?;

    // v3 目录可能有 package.json，v2 pack 忽略它
    if plugin_dir.join("package.json").is_file() {
        eprintln!("[WARN] 目录存在 package.json 但非 v3 格式（kbPackageVersion < 3），按 v2 打包");
    }

    // warn about stale manifest.json / config.json
    if plugin_dir.join("manifest.json").is_file() {
        eprintln!("[WARN] v3 目录不应有 manifest.json，请迁移到 package.json");
    }

    maybe_run_webview_build(plugin_dir)?;
    let backend = detect_plugin_backend(plugin_dir)?;

    let icon_path = plugin_dir.join("icon.png");
    let icon_rgb = if icon_path.is_file() {
        match kgpg::icon_png_to_rgb24_fixed(&icon_path) {
            Ok(rgb) => Some(rgb),
            Err(e) => {
                eprintln!("[WARN] 读取 icon.png 失败，将忽略图标: {e}");
                None
            }
        }
    } else {
        None
    };
    let header = kgpg::build_kgpg2_header(icon_rgb.as_deref(), &header_manifest_bytes)?;

    let zip_bytes = build_plugin_zip_bytes(plugin_dir, backend)?;
    kgpg::write_kgpg2_from_zip_bytes(output, &header, &zip_bytes)?;
    Ok(())
}

fn pack_plugin_v3(
    plugin_dir: &Path,
    output: &Path,
    pkg: &serde_json::Value,
) -> Result<(), String> {
    let pkg_obj = pkg
        .as_object()
        .ok_or_else(|| "package.json 必须是 JSON 对象".to_string())?;

    // ── 校验 ──
    let pkg_name = pkg_obj
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "package.json 缺少 \"name\" 字段".to_string())?;
    let dir_name = plugin_dir
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    let output_stem = output
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    if pkg_name != dir_name || pkg_name != output_stem {
        return Err(format!(
            "package.json name \"{}\" 必须等于目录名 \"{}\" 和输出文件名 stem \"{}\"（P3-7）",
            pkg_name, dir_name, output_stem
        ));
    }

    let _version = pkg_obj
        .get("version")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "package.json 缺少 \"version\" 字段".to_string())?;

    let kb_pkg_ver = pkg_obj
        .get("kbPackageVersion")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    if kb_pkg_ver != 3 {
        if kb_pkg_ver > 3 {
            return Err(format!(
                "kbPackageVersion {} 超过 CLI 支持的版本 3，请升级 CLI",
                kb_pkg_ver
            ));
        }
        return Err(format!(
            "v3 打包要求 kbPackageVersion == 3，当前: {}",
            kb_pkg_ver
        ));
    }

    let engines_ver = pkg_obj
        .get("engines")
        .and_then(|eng| eng.get("kabegame"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| "v3 插件缺少 engines.kabegame 字段".to_string())?;
    let min_ver = core_plugin::normalize_engines_kabegame(engines_ver)?;
    core_plugin::check_min_app_version(env!("CARGO_PKG_VERSION"), &min_ver)
        .map_err(|e| format!("engines.kabegame 要求不满足: {}", e))?;

    // warn about stale manifest.json / config.json
    if plugin_dir.join("manifest.json").is_file() {
        eprintln!(
            "[WARN] v3 目录 {} 含 manifest.json，zip 内不会包含此文件",
            plugin_dir.display()
        );
    }
    if plugin_dir.join("config.json").is_file() {
        eprintln!(
            "[WARN] v3 目录 {} 含 config.json，zip 内不会包含此文件；请将配置移入 package.json kbConfig",
            plugin_dir.display()
        );
    }

    let kb_backend_str = pkg_obj
        .get("kbBackend")
        .and_then(|v| v.as_str())
        .unwrap_or("rhai");
    let _core_backend: core_plugin::PluginBackend = std::str::FromStr::from_str(kb_backend_str)?;

    let main_path = pkg_obj
        .get("main")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "v3 插件缺少 \"main\" 字段".to_string())?;
    core_plugin::validate_kb_rel_path(main_path)?;
    let main_file = plugin_dir.join(main_path);
    if !main_file.is_file() {
        return Err(format!("main 脚本不存在: {}", main_file.display()));
    }
    let main_content = std::fs::read_to_string(&main_file)
        .map_err(|e| format!("读取 main 脚本失败: {}", e))?;
    if main_content.trim().is_empty() {
        return Err(format!("main 脚本不能为空: {}", main_file.display()));
    }

    // kb* 路径字段校验
    for key in &["kbIcon", "kbDescriptionTemplate"] {
        if let Some(val) = pkg_obj.get(*key).and_then(|v| v.as_str()) {
            core_plugin::validate_kb_rel_path(val)?;
            if !plugin_dir.join(val).is_file() {
                return Err(format!("{} 引用的文件不存在: {}", key, val));
            }
        }
    }
    if let Some(doc_map) = pkg_obj.get("kbDoc").and_then(|v| v.as_object()) {
        for (lang, v) in doc_map {
            if let Some(path) = v.as_str() {
                core_plugin::validate_kb_rel_path(path)?;
                if !plugin_dir.join(path).is_file() {
                    return Err(format!("kbDoc[\"{}\"] 引用的文件不存在: {}", lang, path));
                }
            }
        }
    }
    if let Some(cfgs) = pkg_obj.get("kbRecommendedConfigs").and_then(|v| v.as_array()) {
        for (i, v) in cfgs.iter().enumerate() {
            if let Some(path) = v.as_str() {
                core_plugin::validate_kb_rel_path(path)?;
                if !plugin_dir.join(path).is_file() {
                    return Err(format!("kbRecommendedConfigs[{}] 引用的文件不存在: {}", i, path));
                }
            }
        }
    }
    if let Some(provs) = pkg_obj.get("kbPathQLProviders").and_then(|v| v.as_array()) {
        for (i, v) in provs.iter().enumerate() {
            if let Some(path) = v.as_str() {
                core_plugin::validate_kb_rel_path(path)?;
                if !plugin_dir.join(path).is_file() {
                    return Err(format!("kbPathQLProviders[{}] 引用的文件不存在: {}", i, path));
                }
            }
        }
    }
    if let Some(migrations) = pkg_obj.get("kbMetadataMigrations").and_then(|v| v.as_array()) {
        for (i, v) in migrations.iter().enumerate() {
            if let Some(path) = v.as_str() {
                core_plugin::validate_kb_rel_path(path)?;
                if !plugin_dir.join(path).is_file() {
                    return Err(format!("kbMetadataMigrations[{}] 引用的文件不存在: {}", i, path));
                }
            }
        }
    }

    // kbConfig 序列化校验
    if let Some(kb_config) = pkg_obj.get("kbConfig") {
        let arr = kb_config
            .as_array()
            .ok_or_else(|| "kbConfig 必须是数组".to_string())?;
        for (i, item) in arr.iter().enumerate() {
            serde_json::from_value::<kabegame_core::plugin::VarDefinition>(item.clone()).map_err(
                |e| format!("kbConfig[{}] 解析失败: {}", i, e),
            )?;
        }
    }

    // ── 头部 ──
    let header_manifest_bytes = derive_header_manifest(pkg)?;

    let icon_rgb = if let Some(icon_rel) = pkg_obj.get("kbIcon").and_then(|v| v.as_str()) {
        let icon_path = plugin_dir.join(icon_rel);
        match kgpg::icon_png_to_rgb24_fixed(&icon_path) {
            Ok(rgb) => Some(rgb),
            Err(e) => {
                eprintln!("[WARN] 读取 kbIcon 失败，将忽略图标: {e}");
                None
            }
        }
    } else {
        None
    };
    let header = kgpg::build_kgpg2_header(icon_rgb.as_deref(), &header_manifest_bytes)?;

    // ── ZIP ──
    let zip_bytes = collect_v3_entries(plugin_dir, pkg)?;
    kgpg::write_kgpg2_from_zip_bytes(output, &header, &zip_bytes)?;
    Ok(())
}

fn derive_header_manifest(pkg: &serde_json::Value) -> Result<Vec<u8>, String> {
    let obj = pkg
        .as_object()
        .ok_or_else(|| "package.json 必须是 JSON 对象".to_string())?;

    let version = obj
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or("1.0.0")
        .to_string();

    let author = match obj.get("author") {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(a @ serde_json::Value::Object(_)) => a
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        _ => String::new(),
    };

    let min_app_version = obj
        .get("engines")
        .and_then(|eng| eng.get("kabegame"))
        .and_then(|v| v.as_str())
        .map(|raw| core_plugin::normalize_engines_kabegame(raw))
        .transpose()?
        .unwrap_or_default();

    let mut header: serde_json::Map<String, serde_json::Value> = serde_json::Map::new();
    header.insert("version".to_string(), serde_json::Value::String(version));
    header.insert("author".to_string(), serde_json::Value::String(author));
    if !min_app_version.is_empty() {
        header.insert(
            "minAppVersion".to_string(),
            serde_json::Value::String(min_app_version),
        );
    }

    // name + name.*
    for (k, v) in obj {
        if k == "name" || k.starts_with("name.") {
            if let Some(s) = v.as_str() {
                header.insert(k.clone(), serde_json::Value::String(s.to_string()));
            }
        }
        if k == "description" || k.starts_with("description.") {
            if let Some(s) = v.as_str() {
                header.insert(k.clone(), serde_json::Value::String(s.to_string()));
            }
        }
    }

    let header_bytes = serde_json::to_vec(&serde_json::Value::Object(header))
        .map_err(|e| format!("序列化头部 manifest 失败: {}", e))?;
    if header_bytes.len() > 4096 {
        return Err(format!(
            "头部 manifest 超过 4096 字节（{} bytes）",
            header_bytes.len()
        ));
    }
    Ok(header_bytes)
}

fn collect_v3_entries(
    plugin_dir: &Path,
    pkg: &serde_json::Value,
) -> Result<Vec<u8>, String> {
    use std::io::Write;

    let pkg_obj = pkg
        .as_object()
        .ok_or_else(|| "package.json 必须是 JSON 对象".to_string())?;

    let kubignore = load_kubignore(plugin_dir);

    let mut entries: Vec<(String, PathBuf)> = Vec::new();

    // package.json
    entries.push((
        "package.json".to_string(),
        plugin_dir.join("package.json"),
    ));

    // main script
    let main_path = pkg_obj
        .get("main")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "缺少 main".to_string())?;
    entries.push((main_path.to_string(), plugin_dir.join(main_path)));

    // kbDescriptionTemplate
    if let Some(tpl) = pkg_obj.get("kbDescriptionTemplate").and_then(|v| v.as_str()) {
        entries.push((tpl.to_string(), plugin_dir.join(tpl)));
    }

    // kbDoc + referenced images
    if let Some(doc_map) = pkg_obj.get("kbDoc").and_then(|v| v.as_object()) {
        for (_lang, doc_path_val) in doc_map {
            let doc_path = doc_path_val.as_str().unwrap_or("");
            let doc_full = plugin_dir.join(doc_path);
            let md_text =
                std::fs::read_to_string(&doc_full).map_err(|e| format!("读取 {} 失败: {}", doc_path, e))?;

            let md_dir = std::path::Path::new(doc_path)
                .parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
            let refs = core_plugin::extract_doc_local_refs(&md_text, &md_dir);

            for (normalized_path, _original_ref) in &refs {
                let ref_full = plugin_dir.join(normalized_path);
                if ref_full.is_file() {
                    let ext = ref_full
                        .extension()
                        .and_then(|s| s.to_str())
                        .unwrap_or("")
                        .to_ascii_lowercase();
                    let is_img = matches!(
                        ext.as_str(),
                        "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp"
                    );
                    if is_img {
                        const MAX_SIZE: u64 = 2 * 1024 * 1024;
                        let sz =
                            std::fs::metadata(&ref_full).map(|m| m.len()).unwrap_or(0);
                        if sz > MAX_SIZE {
                            eprintln!(
                                "[WARN] doc 图片过大已跳过（上限 2MB）: {} ({} bytes)",
                                normalized_path, sz
                            );
                            continue;
                        }
                        entries.push((normalized_path.clone(), ref_full));
                    }
                } else {
                    return Err(format!(
                        "文档 \"{}\" 引用的图片 \"{}\" 不存在",
                        doc_path, normalized_path
                    ));
                }
            }
            entries.push((doc_path.to_string(), doc_full));
        }
    }

    // kbRecommendedConfigs
    if let Some(configs) = pkg_obj.get("kbRecommendedConfigs").and_then(|v| v.as_array()) {
        for cfg_val in configs {
            if let Some(cfg_path) = cfg_val.as_str() {
                entries.push((cfg_path.to_string(), plugin_dir.join(cfg_path)));
            }
        }
    }

    // kbPathQLProviders
    if let Some(provs) = pkg_obj.get("kbPathQLProviders").and_then(|v| v.as_array()) {
        for prov_val in provs {
            if let Some(prov_path) = prov_val.as_str() {
                entries.push((prov_path.to_string(), plugin_dir.join(prov_path)));
            }
        }
    }

    // kbMetadataMigrations
    if let Some(migrations) = pkg_obj.get("kbMetadataMigrations").and_then(|v| v.as_array()) {
        for mig_val in migrations {
            if let Some(mig_path) = mig_val.as_str() {
                entries.push((mig_path.to_string(), plugin_dir.join(mig_path)));
            }
        }
    }

    // .kabegameignore
    if let Some(ignore_rules) = kubignore {
        let rooted = make_rooted_globset(&ignore_rules)?;
        
        // remove matches
        entries.retain(|(name, _path)| {
            if rooted.is_match(name) {
                let is_critical = 
                    name == "package.json" ||
                    name == main_path ||
                    pkg_obj.get("kbDoc").and_then(|v| v.as_object()).map(|d| d.values().any(|x| x.as_str() == Some(name))).unwrap_or(false);
                if is_critical {
                    eprintln!("[ERROR] .kabegameignore 排除了关键文件: {}", name);
                }
                !is_critical
            } else {
                true
            }
        });

        // !force_includes
        for rule in &ignore_rules {
            if let Some(pattern) = rule.strip_prefix('!') {
                let pattern = pattern.trim();
                // walk plugin_dir for matches to force-include
                let mut stack = vec![plugin_dir.to_path_buf()];
                while let Some(dir) = stack.pop() {
                    let rd = match std::fs::read_dir(&dir) {
                        Ok(rd) => rd,
                        Err(_) => continue,
                    };
                    for ent in rd.flatten() {
                        let p = ent.path();
                        if p.is_dir() {
                            let dir_name = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
                            if dir_name == "node_modules" || dir_name == ".git" {
                                continue;
                            }
                            stack.push(p);
                            continue;
                        }
                        let rel = p
                            .strip_prefix(plugin_dir)
                            .map(|p| p.to_string_lossy().replace('\\', "/"))
                            .unwrap_or_default();
                        if glob_match(pattern, &rel) {
                            if !entries.iter().any(|(n, _)| n == &rel) {
                                entries.push((rel, p));
                            }
                        }
                    }
                }
            }
        }
    }

    // write ZIP
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

fn load_kubignore(plugin_dir: &Path) -> Option<Vec<String>> {
    let path = plugin_dir.join(".kabegameignore");
    if !path.is_file() {
        return None;
    }
    let content = std::fs::read_to_string(&path).ok()?;
    let lines: Vec<String> = content
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty() && !l.starts_with('#') && !l.starts_with("//"))
        .collect();
    if lines.is_empty() {
        None
    } else {
        Some(lines)
    }
}

fn glob_match(pat: &str, name: &str) -> bool {
    let re_str = glob_to_regex(pat);
    Regex::new(&re_str).map(|re| re.is_match(name)).unwrap_or(false)
}

fn glob_to_regex(pat: &str) -> String {
    let mut out = String::from("^");
    let chars: Vec<char> = pat.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        match chars[i] {
            '*' => {
                if i + 1 < chars.len() && chars[i + 1] == '*' {
                    i += 1;
                    out.push_str(".*");
                } else {
                    out.push_str("[^/]*");
                }
            }
            '?' => out.push('.'),
            '.' | '+' | '(' | ')' | '|' | '^' | '$' | '{' | '}' | '[' | ']' | '\\' => {
                out.push('\\');
                out.push(chars[i]);
            }
            c => out.push(c),
        }
        i += 1;
    }
    out.push('$');
    out
}

fn make_rooted_globset(rules: &[String]) -> Result<globset::GlobSet, String> {
    let mut builder = globset::GlobSetBuilder::new();
    for rule in rules {
        if rule.starts_with('!') {
            continue;
        }
        builder.add(globset::Glob::new(rule).map_err(|e| format!("无效 glob: {} ({})", rule, e))?);
    }
    builder.build().map_err(|e| format!("构建 globset 失败: {}", e))
}

fn maybe_run_webview_build(plugin_dir: &Path) -> Result<(), String> {
    let package_json_path = plugin_dir.join("package.json");
    if !package_json_path.is_file() {
        return Ok(());
    }

    let package_raw = std::fs::read_to_string(&package_json_path)
        .map_err(|e| format!("读取 package.json 失败: {e}"))?;
    let package_val: serde_json::Value =
        serde_json::from_str(&package_raw).map_err(|e| format!("解析 package.json 失败: {e}"))?;
    let has_build_script = package_val
        .get("scripts")
        .and_then(|s| s.get("build"))
        .and_then(|v| v.as_str())
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    if !has_build_script {
        return Ok(());
    }

    let has_bun_lock =
        plugin_dir.join("bun.lockb").is_file() || plugin_dir.join("bun.lock").is_file();
    let use_bun = if has_bun_lock {
        command_exists("bun")
    } else {
        false
    };

    let (runner, args) = if use_bun {
        ("bun", vec!["run", "build"])
    } else if command_exists("npm") {
        ("npm", vec!["run", "build"])
    } else if command_exists("bun") {
        ("bun", vec!["run", "build"])
    } else {
        return Err("未找到可用的包管理器（npm/bun），无法执行 webview 构建".to_string());
    };

    let status = Command::new(runner)
        .current_dir(plugin_dir)
        .args(args)
        .status()
        .map_err(|e| format!("执行 `{runner} run build` 失败: {e}"))?;
    if !status.success() {
        return Err(format!(
            "webview 构建失败（`{runner} run build` 退出码: {status}）"
        ));
    }
    Ok(())
}

fn command_exists(bin: &str) -> bool {
    Command::new(bin)
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn detect_plugin_backend(plugin_dir: &Path) -> Result<PluginBackend, String> {
    let has_webview_script = plugin_dir.join("crawl.js").is_file();
    let has_rhai_script = plugin_dir.join("crawl.rhai").is_file();
    match (has_webview_script, has_rhai_script) {
        (true, _) => Ok(PluginBackend::Webview),
        (false, true) => Ok(PluginBackend::Rhai),
        (false, false) => Err(format!(
            "缺少必需脚本：{} 或 {}",
            plugin_dir.join("crawl.js").display(),
            plugin_dir.join("crawl.rhai").display()
        )),
    }
}

fn build_plugin_zip_bytes(plugin_dir: &PathBuf, backend: PluginBackend) -> Result<Vec<u8>, String> {
    use std::io::Write;

    let required = plugin_dir.join(backend.script_file_name());
    if !required.is_file() {
        return Err(format!("缺少必需文件: {}", required.display()));
    }

    let mut entries: Vec<(String, PathBuf)> = Vec::new();
    entries.push((
        "manifest.json".to_string(),
        plugin_dir.join("manifest.json"),
    ));
    entries.push((
        backend.script_file_name().to_string(),
        plugin_dir.join(backend.script_file_name()),
    ));

    let config = plugin_dir.join("config.json");
    if config.is_file() {
        entries.push(("config.json".to_string(), config));
    }

    let configs_dir = plugin_dir.join("configs");
    if configs_dir.is_dir() {
        let mut stack = vec![configs_dir.clone()];
        while let Some(dir) = stack.pop() {
            let rd = std::fs::read_dir(&dir).map_err(|e| format!("读取 configs 失败: {}", e))?;
            for ent in rd {
                let ent = ent.map_err(|e| format!("读取 configs 失败: {}", e))?;
                let p = ent.path();
                if p.is_dir() {
                    stack.push(p);
                    continue;
                }
                if !p.is_file() {
                    continue;
                }
                let rel = p
                    .strip_prefix(plugin_dir)
                    .map_err(|_| "configs 路径异常".to_string())?
                    .to_string_lossy()
                    .replace('\\', "/");
                if !rel.starts_with("configs/") {
                    continue;
                }
                let ext = p
                    .extension()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_ascii_lowercase();
                if ext == "json" {
                    entries.push((rel, p));
                }
            }
        }
    }

    let providers_dir = plugin_dir.join("providers");
    if providers_dir.is_dir() {
        let mut stack = vec![providers_dir.clone()];
        while let Some(dir) = stack.pop() {
            let rd = std::fs::read_dir(&dir).map_err(|e| format!("读取 providers 失败: {}", e))?;
            for ent in rd {
                let ent = ent.map_err(|e| format!("读取 providers 失败: {}", e))?;
                let p = ent.path();
                if p.is_dir() {
                    stack.push(p);
                    continue;
                }
                if !p.is_file() {
                    continue;
                }
                let rel = p
                    .strip_prefix(plugin_dir)
                    .map_err(|_| "providers 路径异常".to_string())?
                    .to_string_lossy()
                    .replace('\\', "/");
                if kabegame_core::providers::is_provider_file_path(&rel) {
                    entries.push((rel, p));
                }
            }
        }
    }

    let metadata_migrations_dir = plugin_dir.join("metadata_migrations");
    if metadata_migrations_dir.is_dir() {
        let rd = std::fs::read_dir(&metadata_migrations_dir)
            .map_err(|e| format!("读取 metadata_migrations 失败: {}", e))?;
        for ent in rd {
            let ent = ent.map_err(|e| format!("读取 metadata_migrations 失败: {}", e))?;
            let p = ent.path();
            if !p.is_file() {
                continue;
            }
            let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
            let is_versioned_rhai = name
                .strip_prefix('v')
                .and_then(|s| s.strip_suffix(".rhai"))
                .map(|version| !version.is_empty() && version.chars().all(|ch| ch.is_ascii_digit()))
                .unwrap_or(false);
            if is_versioned_rhai {
                let rel = p
                    .strip_prefix(plugin_dir)
                    .map_err(|_| "metadata_migrations 路径异常".to_string())?
                    .to_string_lossy()
                    .replace('\\', "/");
                entries.push((rel, p));
            }
        }
    }

    let doc_root = plugin_dir.join("doc_root");
    if doc_root.is_dir() {
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
                let rel = p
                    .strip_prefix(plugin_dir)
                    .map_err(|_| "doc_root 路径异常".to_string())?
                    .to_string_lossy()
                    .replace('\\', "/");
                if !rel.starts_with("doc_root/") {
                    continue;
                }
                let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
                let ext = p
                    .extension()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_ascii_lowercase();
                if ext == "md" {
                    if dir == doc_root
                        && (name == "doc.md" || (name.starts_with("doc.") && name.ends_with(".md")))
                    {
                        entries.push((rel, p));
                    }
                    continue;
                }
                let ok = matches!(
                    ext.as_str(),
                    "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp"
                );
                if ok {
                    const DOC_RESOURCE_MAX_FILE_SIZE: u64 = 2 * 1024 * 1024;
                    let file_size = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
                    if file_size > DOC_RESOURCE_MAX_FILE_SIZE {
                        eprintln!(
                            "[WARN] doc_root 资源文件过大已跳过（上限 2MB）: {} ({} bytes)",
                            rel, file_size
                        );
                        continue;
                    }
                    entries.push((rel, p));
                }
            }
        }
    }

    let templates_dir = plugin_dir.join("templates");
    if templates_dir.is_dir() {
        let rd =
            std::fs::read_dir(&templates_dir).map_err(|e| format!("读取 templates 失败: {}", e))?;
        for ent in rd {
            let ent = ent.map_err(|e| format!("读取 templates 失败: {}", e))?;
            let p = ent.path();
            if !p.is_file() {
                continue;
            }
            let ext = p
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if ext == "ejs" {
                let rel = p
                    .strip_prefix(plugin_dir)
                    .map_err(|_| "templates 路径异常".to_string())?
                    .to_string_lossy()
                    .replace('\\', "/");
                entries.push((rel, p));
            }
        }
    }

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

fn has_non_empty_zip_entry(zip_path: &Path, entry_name: &str) -> Result<bool, String> {
    let bytes = std::fs::read(zip_path)
        .map_err(|e| format!("读取插件包失败 {}: {e}", zip_path.display()))?;
    let zip_offset = bytes
        .windows(4)
        .position(|w| w == [0x50, 0x4B, 0x03, 0x04])
        .ok_or_else(|| format!("插件包不是有效 ZIP/KGPG 格式: {}", zip_path.display()))?;

    let cursor = std::io::Cursor::new(&bytes[zip_offset..]);
    let mut archive =
        zip::ZipArchive::new(cursor).map_err(|e| format!("解析插件 ZIP 失败: {e}"))?;
    let mut file = match archive.by_name(entry_name) {
        Ok(f) => f,
        Err(_) => return Ok(false),
    };

    let mut content = String::new();
    file.read_to_string(&mut content)
        .map_err(|e| format!("读取 `{entry_name}` 失败: {e}"))?;
    Ok(!content.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_render_liquid_basic() {
        let mut vars = HashMap::new();
        vars.insert("project-name".to_string(), "my-plugin".to_string());
        vars.insert("backend".to_string(), "v8".to_string());

        let tmpl = r#"{"name": "{{ project-name }}", "backend": "{{ backend }}"}"#;
        let result = render_liquid_template(tmpl, &vars).unwrap();
        assert_eq!(result, r#"{"name": "my-plugin", "backend": "v8"}"#);
    }

    #[test]
    fn test_render_liquid_if_v8() {
        let mut vars = HashMap::new();
        vars.insert("backend".to_string(), "v8".to_string());

        let tmpl = "{% if backend == \"v8\" %}v8-block{% else %}other{% endif %}";
        let result = render_liquid_template(tmpl, &vars).unwrap();
        assert_eq!(result, "v8-block");
    }

    #[test]
    fn test_render_liquid_if_rhai() {
        let mut vars = HashMap::new();
        vars.insert("backend".to_string(), "rhai".to_string());

        let tmpl = "{% if backend == \"v8\" %}v8-block{% elsif backend == \"webview\" %}web-block{% else %}rhai-block{% endif %}";
        let result = render_liquid_template(tmpl, &vars).unwrap();
        assert_eq!(result, "rhai-block");
    }

    #[test]
    fn test_package_json_is_v3_from_core() {
        assert!(kabegame_core::plugin::package_json_is_v3(
            &serde_json::json!({"kbPackageVersion": 3})
        ));
        assert!(!kabegame_core::plugin::package_json_is_v3(
            &serde_json::json!({"kbPackageVersion": 2})
        ));
    }

    #[test]
    fn test_glob_match() {
        assert!(glob_match("*.log", "error.log"));
        assert!(!glob_match("*.log", "logs/error.log"));
        assert!(!glob_match("*.log", "file.txt"));
        assert!(glob_match("dist/**", "dist/main.js"));
        assert!(glob_match("dist/**", "dist/sub/file.js"));
        assert!(!glob_match("dist/**", "src/main.ts"));
    }

    #[test]
    fn test_parse_cargo_generate_conditions() {
        let toml = r#"
[placeholders]
backend = { type = "string", choices = ["rhai", "v8", "webview"] }

[conditional.'backend != "v8"']
ignore = ["src", "rspack.config.mjs"]

[conditional.'backend == "rhai"']
ignore = ["tsconfig.json"]
"#;
        let ignored = parse_cargo_generate_conditions(toml, "v8").unwrap();
        // v8 -> "backend != v8" is false, so src/rspack not ignored
        // "backend == rhai" is false
        assert!(!ignored.contains(&"src".to_string()));
        assert!(!ignored.contains(&"rspack.config.mjs".to_string()));

        let ignored_rhai = parse_cargo_generate_conditions(toml, "rhai").unwrap();
        assert!(ignored_rhai.contains(&"src".to_string()));
        assert!(ignored_rhai.contains(&"rspack.config.mjs".to_string()));
        assert!(ignored_rhai.contains(&"tsconfig.json".to_string()));
    }
}
