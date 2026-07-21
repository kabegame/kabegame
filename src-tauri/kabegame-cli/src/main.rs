//! Kabegame CLI（sidecar）
//!
//! 目前支持：
//! - `plugin new`：创建爬虫插件模板
//! - `plugin pack`：打包单个插件目录为 `.kgpg`（package.json v3）
//! - `plugin import`：导入本地 `.kgpg` 插件文件（复制到 plugins_directory）
//! - `plugin run`：在本进程跑一个**已安装**的 V8 插件，实时渲染日志与进度
//! - `data import-image`：直接导入单个本地图片或视频
//! - `data query`：查询 PathQL 数据

use clap::{Args, Parser, Subcommand, ValueEnum};
use include_dir::{include_dir, Dir};
use kabegame_core::plugin as core_plugin;
use kabegame_core::{
    kgpg,
    plugin::{manifest_value_to_display_string, PluginManager},
};
use regex::Regex;
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};

const TEMPLATE_DIR: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/template");

#[derive(Parser, Debug)]
#[command(name = "kabegame-cli")]
#[command(version)]
#[command(about = "Kabegame 命令行工具", long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// 插件相关命令
    #[command(subcommand)]
    Plugin(PluginCommands),
    /// 管理数据库
    #[command(subcommand)]
    Data(DataCommands),
}

#[derive(Subcommand, Debug)]
enum PluginCommands {
    /// 创建插件模板目录
    New(NewPluginArgs),
    /// 打包单个插件目录为 `.kgpg`（KGPG v3：固定头部 + ZIP，ZIP 内不含 icon.png）
    Pack(PackPluginArgs),
    /// 导入本地 `.kgpg` 插件文件（复制到 plugins_directory）
    Import(ImportPluginArgs),
    /// 运行一个已安装的 V8 插件（先 `plugin import` 安装）
    Run(RunPluginArgs),
}

#[derive(Subcommand, Debug)]
enum DataCommands {
    /// 将单个本地文件（图片或视频）直接导入数据库
    ImportImage(ImportImageArgs),
    /// 查询 PathQL 结果
    Query(DataQueryArgs),
}

#[derive(Args, Debug)]
struct PackPluginArgs {
    /// 插件目录（包含 package.json/crawl.js 等）
    #[arg(long = "plugin-dir")]
    plugin_dir: PathBuf,

    /// 输出 `.kgpg` 文件路径
    #[arg(long = "output")]
    output: PathBuf,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum PluginBackend {
    Webview,
    V8,
}

impl PluginBackend {
    fn kb_backend_str(self) -> &'static str {
        match self {
            Self::Webview => "webview",
            Self::V8 => "v8",
        }
    }
}

impl From<PluginBackend> for core_plugin::PluginBackend {
    fn from(b: PluginBackend) -> Self {
        match b {
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
    /// 已安装插件的 id（等于插件目录名 / .kgpg 文件名 stem，如 kemono）
    plugin: String,
    /// 覆盖单个配置项，形如 `--var key=value`，可重复。
    /// 值按插件 kbConfig 里该 key 的类型自动转换（int/float/boolean 等）。
    #[arg(long = "var", value_name = "KEY=VALUE")]
    vars: Vec<String>,
    /// 图片输出目录；不传则用应用默认的爬取输出目录
    #[arg(long = "output-dir")]
    output_dir: Option<String>,
    /// 目标画册 id；不传则不加入画册
    #[arg(long = "album-id")]
    album_id: Option<String>,
    /// 只解析并打印最终配置，不真正运行任务
    #[arg(long = "dry-run")]
    dry_run: bool,
    /// 不渲染进度条，日志逐行直出（适合 CI / 重定向到文件）
    #[arg(long = "plain")]
    plain: bool,
    /// 数据目录：dev = 仓库内 .kabegame/debug（`repack-crawler-plugins` 投放插件的地方），
    /// prod = 系统用户数据目录。默认跟随编译期配置。
    #[arg(long = "data", value_enum, default_value_t = DataMode::Auto)]
    data: DataMode,
}

#[derive(Args, Debug)]
struct ImportImageArgs {
    /// 本地文件路径（图片或视频；不支持 URL / 文件夹）
    path: PathBuf,
    /// 目标画册树路径；前缀斜线可选，不传则不加入任何画册
    #[arg(long = "album")]
    album: Option<String>,
    /// 附加到图片的 metadata 字符串（原样存储，不校验 JSON）
    #[arg(long = "metadata")]
    metadata: Option<String>,
}

#[derive(Args, Debug)]
struct DataQueryArgs {
    /// PathQL 查询路径，如 images://gallery/all/x10x/1
    path: String,
    /// 列举子项；可搭配 --with-count
    #[arg(long, group = "query_mode")]
    list: bool,
    /// 查询节点自身 entry
    #[arg(long, group = "query_mode")]
    entry: bool,
    /// 拉取数据行（默认模式）
    #[arg(long, group = "query_mode")]
    fetch: bool,
    /// 仅 --list 可用：为每个子项附带 total 计数
    #[arg(long = "with-count", requires = "list")]
    with_count: bool,
}

/// 解析 cargo-generate.toml 的条件规则，返回忽略文件集（相对于仓库根）
fn parse_cargo_generate_conditions(
    toml_src: &str,
    backend_str: &str,
) -> Result<Vec<String>, String> {
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
    if let Some(val) = cond.strip_prefix("backend != ").or_else(|| {
        cond.strip_prefix("backend != \"")
            .map(|s| s.trim_end_matches('"'))
    }) {
        let val = val.trim_matches('"');
        return backend_str != val;
    }
    if let Some(val) = cond.strip_prefix("backend == ").or_else(|| {
        cond.strip_prefix("backend == \"")
            .map(|s| s.trim_end_matches('"'))
    }) {
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
    let cli = Cli::parse();

    let res = match cli.command {
        Commands::Plugin(cmd) => match cmd {
            PluginCommands::New(args) => new_plugin(args),
            PluginCommands::Pack(args) => pack_plugin(args),
            PluginCommands::Import(args) => import_plugin(args).await,
            PluginCommands::Run(args) => run_plugin(args).await,
        },
        Commands::Data(cmd) => match cmd {
            DataCommands::ImportImage(args) => data_import_image(args).await,
            DataCommands::Query(args) => data_query(args),
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
                    format!(
                        "{}/{}",
                        rel_prefix,
                        sub_dir.path().to_string_lossy().to_string()
                    )
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
                    format!(
                        "{}/{}",
                        rel_prefix,
                        file.path().to_string_lossy().to_string()
                    )
                };
                if ignored
                    .iter()
                    .any(|p| rel.starts_with(p.as_str()) || rel == *p)
                {
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
                let is_text = matches!(
                    ext.as_str(),
                    "json" | "js" | "ts" | "mjs" | "md" | "toml" | "gitignore" | "kabegameignore"
                );

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
            if ignored
                .iter()
                .any(|p| rel.starts_with(p.as_str()) || rel == *p)
            {
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

/// 数据目录模式。与构建系统的 `--data dev|prod`（见 CLAUDE.md）同义：
/// dev = 仓库内 `.kabegame/debug/{data,cache,tmp}`，prod = 系统用户数据目录。
#[derive(Copy, Clone, Debug, Default, PartialEq, Eq, ValueEnum)]
enum DataMode {
    /// 跟随编译期的 `kabegame_data` cfg（release 构建即 prod）
    #[default]
    Auto,
    /// 强制用仓库内的 `.kabegame/debug` 目录
    Dev,
    /// 强制用系统用户数据目录
    Prod,
}

fn init_standalone_globals() -> Result<(), String> {
    init_standalone_globals_with(DataMode::Auto)
}

fn init_standalone_globals_with(mode: DataMode) -> Result<(), String> {
    use kabegame_core::app_paths::{is_dev, repo_root_dir, AppPaths};
    use kabegame_core::{emitter::GlobalEmitter, settings::Settings, storage::Storage};

    let use_dev = match mode {
        DataMode::Auto => is_dev(),
        DataMode::Dev => true,
        DataMode::Prod => false,
    };
    let dev_debug_dir = if use_dev {
        let root = repo_root_dir().ok_or_else(|| {
            "--data dev 需要在 Kabegame 仓库内运行（要能定位到包含 package.json 与 src-tauri/ 的目录）"
                .to_string()
        })?;
        Some(root.join(".kabegame").join("debug"))
    } else {
        None
    };
    let data_dir = dev_debug_dir
        .as_ref()
        .map(|dir| dir.join("data"))
        .unwrap_or_else(|| {
            dirs::data_local_dir()
                .or_else(dirs::data_dir)
                .expect("cannot determine data dir")
                .join("Kabegame")
        });
    let cache_dir = dev_debug_dir
        .as_ref()
        .map(|dir| dir.join("cache"))
        .unwrap_or_else(|| {
            dirs::cache_dir()
                .expect("cannot determine cache dir")
                .join("Kabegame")
        });
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf));
    let resource_dir = exe_dir
        .as_deref()
        .map(|dir| dir.join("resources"))
        .unwrap_or_else(|| std::env::temp_dir().join("Kabegame").join("resources"));

    let compatibles_dir_path = data_dir.join("compatibles");
    AppPaths::init(AppPaths {
        data_dir,
        cache_dir,
        temp_dir: dev_debug_dir
            .as_ref()
            .map(|dir| dir.join("tmp"))
            .unwrap_or_else(|| std::env::temp_dir().join("Kabegame")),
        resource_dir,
        exe_dir,
        external_data_dir: None,
        pictures_dir: dirs::picture_dir(),
        compatibles_dir_path,
    })?;
    Settings::init_global()?;
    Storage::init_global()?;
    GlobalEmitter::init_global()?;
    Ok(())
}

/// 在 `init_standalone_globals()` 之外，额外初始化「跑任务」需要的运行时。
///
/// 顺序与 GUI 的 `kabegame/src/core_init.rs:73-88` 一致：
/// EventBroadcaster → SubscriptionManager → GlobalEmitter → DownloadQueue → TaskScheduler。
/// GlobalEmitter 的 emit_* 会取 `EventBroadcaster::global()`，未初始化会 panic，
/// 所以本函数必须在 `init_standalone_globals()`（内含 GlobalEmitter::init_global）之前调用。
fn init_event_runtime() -> Result<(), String> {
    use kabegame_core::ipc::server::{EventBroadcaster, SubscriptionManager};
    EventBroadcaster::init_global(1000).map_err(|e| format!("EventBroadcaster: {e}"))?;
    SubscriptionManager::init_global().map_err(|e| format!("SubscriptionManager: {e}"))?;
    Ok(())
}

fn init_task_runtime() -> Result<(), String> {
    use kabegame_core::crawler::{DownloadQueue, TaskScheduler};
    use std::sync::Arc;
    let download_queue = Arc::new(DownloadQueue::new());
    TaskScheduler::init_global(download_queue).map_err(|e| format!("TaskScheduler: {e}"))?;
    Ok(())
}

async fn data_import_image(args: ImportImageArgs) -> Result<(), String> {
    if !args.path.is_file() {
        return Err(format!("文件不存在或不是普通文件: {}", args.path.display()));
    }

    init_standalone_globals()?;
    let album_id = args
        .album
        .as_deref()
        .map(resolve_album_tree_path)
        .transpose()?;
    let carry = match args.metadata {
        Some(metadata) => {
            let metadata_id =
                kabegame_core::storage::Storage::global().insert_image_metadata_text(&metadata)?;
            let display_name = args
                .path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("image")
                .to_string();
            Some(kabegame_core::local_folder::import::CarryFromOld {
                display_name,
                metadata_id: Some(metadata_id),
                order: None,
            })
        }
        None => None,
    };
    let size = std::fs::metadata(&args.path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    let image_id = kabegame_core::local_folder::import::import_local_file(
        &args.path,
        album_id.as_deref(),
        size,
        carry,
    )
    .await?;

    if let Some(album_id) = album_id {
        println!("导入成功：image_id={image_id}; 画册={album_id}");
    } else {
        println!("导入成功：image_id={image_id};（未加入画册）");
    }
    Ok(())
}

fn data_query(args: DataQueryArgs) -> Result<(), String> {
    use kabegame_core::providers::{
        decode_provider_path_segments, query_entry, query_fetch, query_list,
    };

    init_standalone_globals()?;
    let path = decode_provider_path_segments(&args.path);
    let output = if args.list {
        serde_json::to_value(query_list(&path, args.with_count)?)
    } else if args.entry {
        serde_json::to_value(query_entry(&path)?)
    } else {
        serde_json::to_value(query_fetch(&path)?)
    }
    .map_err(|error| error.to_string())?;
    println!(
        "{}",
        serde_json::to_string_pretty(&output).map_err(|error| error.to_string())?
    );
    Ok(())
}

/// 画册树路径转换为 albums provider 路径；前缀斜线可选。
fn album_tree_path_to_pathql(tree_path: &str) -> String {
    format!("albums://by_sub_tree/{}", tree_path.trim_start_matches('/'))
}

/// 查询目标画册的父路径，并从父画册返回的直接子画册中按名称查找目标 id。
fn resolve_album_tree_path(tree_path: &str) -> Result<String, String> {
    use kabegame_core::providers::{decode_provider_path_segments, query_fetch};

    let full_path = decode_provider_path_segments(&album_tree_path_to_pathql(tree_path));
    let relative_path = full_path
        .strip_prefix("albums://by_sub_tree/")
        .ok_or_else(|| format!("无效的画册树路径: {tree_path}"))?
        .trim_end_matches('/');
    if relative_path.is_empty() {
        return Err("画册树路径不能为空".to_string());
    }

    let (parent_path, target_name) = relative_path
        .rsplit_once('/')
        .map_or(("", relative_path), |(parent, name)| (parent, name));
    if target_name.is_empty() {
        return Err(format!("无效的画册树路径: {tree_path}"));
    }
    let query_path = if parent_path.is_empty() {
        "albums://by_sub_tree".to_string()
    } else {
        format!("albums://by_sub_tree/{parent_path}")
    };
    let rows = query_fetch(&query_path)?;
    album_id_from_children(&rows, target_name, tree_path)
}

fn album_id_from_children(
    rows: &[serde_json::Value],
    target_name: &str,
    tree_path: &str,
) -> Result<String, String> {
    rows.iter()
        .find(|row| row.get("name").and_then(|value| value.as_str()) == Some(target_name))
        .and_then(|row| row.get("id"))
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .ok_or_else(|| format!("未找到画册树路径: {tree_path}"))
}

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

/// 运行一个已安装的 V8 插件。
///
/// 整体链路与 GUI 一致：`start_task` 建任务 → TaskScheduler 冻结参数并入队 →
/// worker 取出后在 `spawn_blocking` 里跑 V8。差别只在于 CLI 自己订阅
/// `EventBroadcaster` 把事件渲染到终端，而不是转发给前端。
async fn run_plugin(args: RunPluginArgs) -> Result<(), String> {
    use kabegame_core::crawler::{TaskScheduler, MAX_TASK_WORKER_LOOPS};
    use kabegame_core::ipc::server::EventBroadcaster;

    // EventBroadcaster 必须先于 GlobalEmitter：后者 emit 时会取前者的全局单例。
    init_event_runtime()?;
    init_standalone_globals_with(args.data)?;
    init_task_runtime()?;

    // 扇出循环：不 spawn 的话所有事件只会堆在 mpsc 里，订阅者一条都收不到。
    tokio::spawn(async { EventBroadcaster::start_forward_task().await });

    PluginManager::init_global()?;
    let pm = PluginManager::global();
    // 刷新失败不致命：目录里若混有旧版容器（KGPG v2）等坏包，refresh_plugins 会在第一颗上
    // 直接返回 Err。只要目标插件本身能解析出来，就不该挡住这次运行。
    if let Err(e) = pm.ensure_installed_cache_initialized().await {
        eprintln!(
            "{} 插件目录扫描未全部成功：{e}",
            console::style("[WARN]").yellow()
        );
    }

    let plugin = pm.get(&args.plugin).ok_or_else(|| {
        let mut ids: Vec<String> = pm
            .get_all()
            .unwrap_or_default()
            .iter()
            .map(|p| p.id.clone())
            .collect();
        ids.sort();
        if ids.is_empty() {
            format!(
                "插件 {} 未安装，且当前没有任何已安装插件。\n先用 `kabegame-cli plugin import <file.kgpg>` 安装。",
                args.plugin
            )
        } else {
            format!(
                "插件 {} 未安装。已安装的有：{}\n用 `kabegame-cli plugin import <file.kgpg>` 安装。",
                args.plugin,
                ids.join(", ")
            )
        }
    })?;

    // 暂时只支持 V8：WebView 后端要真实浏览器窗口，headless CLI 起不来。
    if plugin.script_type != "v8" {
        return Err(format!(
            "插件 {} 的后端是 `{}`，`plugin run` 目前只支持 v8 后端。",
            plugin.id, plugin.script_type
        ));
    }
    if let Some(min_ver) = plugin.min_app_version.as_deref() {
        core_plugin::check_min_app_version(env!("CARGO_PKG_VERSION"), min_ver)?;
    }

    let resolved = resolve_run_config(pm, &plugin, &args.vars)?;
    let config = resolved.user_config;
    // 用 BTreeMap 打印，保证 key 有序（HashMap 的迭代顺序每次都不同，diff 起来很烦）。
    let sorted: std::collections::BTreeMap<_, _> = config.iter().collect();
    let config_json = serde_json::to_string_pretty(&sorted).map_err(|e| e.to_string())?;
    println!(
        "{} {} v{}",
        console::style("插件").dim(),
        console::style(&plugin.id).bold(),
        plugin.version
    );
    println!("{}", console::style("最终配置：").dim());
    println!("{config_json}");

    if args.dry_run {
        return Ok(());
    }

    // 订阅必须早于 start_task：forward task 在没有订阅者时会直接丢弃事件，
    // 晚订阅会漏掉任务开头的日志。
    let mut events = EventBroadcaster::global().subscribe_filtered_stream(&[
        kabegame_core::ipc::events::DaemonEventKind::TaskLog,
        kabegame_core::ipc::events::DaemonEventKind::TasksChange,
        kabegame_core::ipc::events::DaemonEventKind::ImagesChange,
    ]);

    let scheduler = TaskScheduler::global();
    scheduler.start_workers(MAX_TASK_WORKER_LOOPS).await;
    scheduler.start_download_workers_async().await;

    // 字段名必须是 camelCase：commands::task::start_task 的 StartTaskParams 带
    // `#[serde(rename_all = "camelCase")]`。
    let mut task_param = serde_json::json!({
        "pluginId": plugin.id,
        "userConfig": config,
        "triggerSource": "cli",
    });
    if !resolved.http_headers.is_empty() {
        task_param["httpHeaders"] = serde_json::json!(resolved.http_headers);
    }
    // 命令行的 --output-dir 优先于默认配置里保存的 outputDir。
    if let Some(dir) = args.output_dir.as_ref().or(resolved.output_dir.as_ref()) {
        task_param["outputDir"] = serde_json::Value::String(dir.clone());
    }
    if let Some(album) = args.album_id.as_ref() {
        task_param["outputAlbumId"] = serde_json::Value::String(album.clone());
    }
    let task_id = kabegame_core::commands::task::start_task(task_param).await?;

    let plain = args.plain || !console::user_attended();
    let outcome = render_task(&task_id, &plugin.id, &mut events, plain).await;

    match outcome {
        TaskOutcome::Completed { downloaded, failed } => {
            println!(
                "{} 下载 {} 张，失败 {}",
                console::style("完成").green().bold(),
                downloaded,
                failed
            );
            Ok(())
        }
        TaskOutcome::Canceled => Err("任务已取消".to_string()),
        TaskOutcome::Failed(err) => Err(format!("任务失败：{err}")),
    }
}

enum TaskOutcome {
    Completed { downloaded: u64, failed: u64 },
    Canceled,
    Failed(String),
}

/// 事件循环 + 终端渲染。
///
/// 形态：进度条常驻最后一行，日志由 `ProgressBar::println` 从进度条**上方**滚出，
/// 与 cargo / apt 一致。非 TTY（管道、CI）自动降级成逐行直出。
async fn render_task(
    task_id: &str,
    plugin_id: &str,
    events: &mut tokio::sync::mpsc::UnboundedReceiver<(
        u64,
        std::sync::Arc<kabegame_core::ipc::events::DaemonEvent>,
    )>,
    plain: bool,
) -> TaskOutcome {
    use indicatif::{ProgressBar, ProgressStyle};
    use kabegame_core::ipc::events::DaemonEvent;

    let bar = if plain {
        ProgressBar::hidden()
    } else {
        let pb = ProgressBar::new(10_000);
        pb.set_style(
            ProgressStyle::with_template(
                "{spinner:.green} [{elapsed_precise}] [{bar:28.cyan/blue}] {percent:>3}% {msg}",
            )
            .unwrap()
            .progress_chars("=> "),
        );
        pb.enable_steady_tick(std::time::Duration::from_millis(120));
        pb
    };

    let mut downloaded: u64 = 0;
    let mut failed: u64 = 0;
    let mut dedup: u64 = 0;
    let mut progress: f64 = 0.0;

    let refresh = |bar: &ProgressBar, progress: f64, downloaded: u64, failed: u64, dedup: u64| {
        bar.set_position((progress * 100.0) as u64);
        let mut msg = format!("{plugin_id} · ↓{downloaded}");
        if failed > 0 {
            msg.push_str(&format!(" · {}", console::style(format!("✗{failed}")).red()));
        }
        if dedup > 0 {
            msg.push_str(&format!(" · {}", console::style(format!("⊘{dedup}")).dim()));
        }
        bar.set_message(msg);
    };
    refresh(&bar, progress, downloaded, failed, dedup);

    // Ctrl-C：取消任务而不是硬退出，避免 DB 里留下永远 Running 的任务。
    let cancel_task_id = task_id.to_string();
    tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            kabegame_core::crawler::TaskScheduler::global()
                .cancel_task(&cancel_task_id)
                .await;
        }
    });

    while let Some((_id, ev)) = events.recv().await {
        match &*ev {
            DaemonEvent::TaskLog {
                task_id: tid,
                level,
                message,
            } if tid == task_id => {
                let line = format_log_line(level, message);
                if plain {
                    println!("{line}");
                } else {
                    // 用 suspend 而不是 ProgressBar::println：后者在 indicatif 0.18 下实测
                    // 不输出任何内容。suspend 会先擦掉进度条、执行闭包、再重绘，
                    // 日志因此和 plain 模式一样走 stdout。
                    bar.suspend(|| println!("{line}"));
                }
            }
            DaemonEvent::ImagesChange {
                reason,
                image_ids,
                task_ids,
                ..
            } if reason == "add" => {
                // success_count 的自增是纯 SQL、不发事件，所以这里自己按 images-change 累加。
                let ours = task_ids
                    .as_ref()
                    .map(|ids| ids.iter().any(|t| t == task_id))
                    .unwrap_or(false);
                if ours {
                    downloaded += image_ids.len() as u64;
                    refresh(&bar, progress, downloaded, failed, dedup);
                }
            }
            DaemonEvent::TaskChanged { task_id: tid, diff } if tid == task_id => {
                if let Some(p) = diff.get("progress").and_then(|v| v.as_f64()) {
                    progress = p;
                }
                // 计数快照事件是权威值，直接覆盖本地累加。
                if let Some(v) = diff.get("successCount").and_then(|v| v.as_u64()) {
                    downloaded = v;
                }
                if let Some(v) = diff.get("failedCount").and_then(|v| v.as_u64()) {
                    failed = v;
                }
                if let Some(v) = diff.get("dedupCount").and_then(|v| v.as_u64()) {
                    dedup = v;
                }
                refresh(&bar, progress, downloaded, failed, dedup);

                if let Some(status) = diff.get("status").and_then(|v| v.as_str()) {
                    let outcome = match status {
                        "completed" => Some(TaskOutcome::Completed { downloaded, failed }),
                        "canceled" | "cancelled" => Some(TaskOutcome::Canceled),
                        "failed" => Some(TaskOutcome::Failed(
                            diff.get("error")
                                .and_then(|v| v.as_str())
                                .unwrap_or("未知错误")
                                .to_string(),
                        )),
                        _ => None,
                    };
                    if let Some(outcome) = outcome {
                        bar.finish_and_clear();
                        return outcome;
                    }
                }
            }
            _ => {}
        }
    }

    bar.finish_and_clear();
    TaskOutcome::Failed("事件流意外结束".to_string())
}

fn format_log_line(level: &str, message: &str) -> String {
    let tag = match level {
        "error" => console::style(" ERROR ").red().bold().to_string(),
        "warn" => console::style("  WARN ").yellow().bold().to_string(),
        "info" => console::style("  INFO ").cyan().to_string(),
        _ => console::style("   LOG ").dim().to_string(),
    };
    let body = match level {
        "error" => console::style(message).red().to_string(),
        "warn" => console::style(message).yellow().to_string(),
        _ => message.to_string(),
    };
    format!("{tag} {body}")
}

/// `--var key=value` → (key, 原始字符串值)。值里允许再出现 `=`。
fn parse_var_arg(raw: &str) -> Result<(String, String), String> {
    let (k, v) = raw
        .split_once('=')
        .ok_or_else(|| format!("--var 需要 key=value 形式，收到：{raw}"))?;
    let k = k.trim();
    if k.is_empty() {
        return Err(format!("--var 的 key 不能为空：{raw}"));
    }
    Ok((k.to_string(), v.to_string()))
}

/// 解析本次运行的最终配置。
///
/// 与主应用一致的三层叠加：
/// 1. `kbConfig` 里每项的 `default`
/// 2. 用户在应用里保存的插件默认配置（`plugins-directory/default-configs/<id>.json`）
/// 3. 本次命令行的 `--var` 覆盖
///
/// 第 1 层由 `build_effective_user_config_from_var_defs` 负责（同时做类型规范化，
/// 所以 `--var page=3` 这种字符串会被转成数字），这里只负责 2、3 层的合并。
struct ResolvedRun {
    user_config: HashMap<String, serde_json::Value>,
    http_headers: HashMap<String, String>,
    output_dir: Option<String>,
}

fn resolve_run_config(
    pm: &PluginManager,
    plugin: &core_plugin::Plugin,
    vars: &[String],
) -> Result<ResolvedRun, String> {
    // 用户在应用里保存的默认配置。文件结构是 { userConfig, httpHeaders, outputDir }
    // （见 PluginManager::build_default_config_json）；不存在或坏了都退回空，不阻断运行。
    let saved = pm
        .read_plugin_default_config_file(&plugin.id)
        .ok()
        .flatten()
        .unwrap_or(serde_json::Value::Null);

    let mut user_cfg: HashMap<String, serde_json::Value> = saved
        .get("userConfig")
        .and_then(|v| v.as_object())
        .map(|m| m.clone().into_iter().collect())
        .unwrap_or_default();
    let http_headers: HashMap<String, String> = saved
        .get("httpHeaders")
        .and_then(|v| v.as_object())
        .map(|m| {
            m.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect()
        })
        .unwrap_or_default();
    let output_dir = saved
        .get("outputDir")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let known: std::collections::HashSet<&str> =
        plugin.var_defs.iter().map(|d| d.key.as_str()).collect();
    for raw in vars {
        let (k, v) = parse_var_arg(raw)?;
        if !known.contains(k.as_str()) {
            let mut keys: Vec<&str> = known.iter().copied().collect();
            keys.sort_unstable();
            return Err(format!(
                "插件 {} 没有配置项 `{}`。可用的有：{}",
                plugin.id,
                k,
                keys.join(", ")
            ));
        }
        // 一律先按字符串放进去，交给 normalize_var_value 按 var_defs 的类型转换。
        user_cfg.insert(k, serde_json::Value::String(v));
    }

    Ok(ResolvedRun {
        user_config:
            kabegame_core::crawler::task_scheduler::build_effective_user_config_from_var_defs(
                &plugin.var_defs,
                user_cfg,
            ),
        http_headers,
        output_dir,
    })
}

async fn validate_kgpg_structure(
    pm: &PluginManager,
    zip_path: &std::path::Path,
) -> Result<(), String> {
    let _manifest = pm.read_plugin_manifest(zip_path).await?;

    // 只支持 v3 package.json；旧清单格式与 Rhai 均不支持。
    let pkg = read_optional_package_json_from_zip(zip_path)?
        .filter(core_plugin::package_json_is_v3)
        .ok_or_else(|| {
            "只支持 package.json (v3) 插件格式；旧清单格式不受支持".to_string()
        })?;
    let main_path = pkg.get("main").and_then(|v| v.as_str()).unwrap_or("");
    if main_path.is_empty() || !has_non_empty_zip_entry(zip_path, main_path)? {
        return Err(format!("v3 插件包 `main` 脚本不存在或为空: {}", main_path));
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
    let raw =
        std::fs::read_to_string(&pkg_path).map_err(|e| format!("读取 package.json 失败: {}", e))?;
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

    // 只支持 kbPackageVersion >= 3 的 package.json 插件格式。
    let pkg = read_optional_package_json(&plugin_dir)?
        .filter(|v| core_plugin::package_json_is_v3(v))
        .ok_or_else(|| {
            "只支持 kbPackageVersion >= 3 的 package.json 插件".to_string()
        })?;
    pack_plugin_v3(&plugin_dir, &args.output, &pkg)
}

fn pack_plugin_v3(plugin_dir: &Path, output: &Path, pkg: &serde_json::Value) -> Result<(), String> {
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
    let output_stem = output.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    if pkg_name != dir_name || pkg_name != output_stem {
        return Err(format!(
            "package.json name \"{}\" 必须等于目录名 \"{}\" 和输出文件名 stem \"{}\"（P3-7）",
            pkg_name, dir_name, output_stem
        ));
    }

    let version = pkg_obj
        .get("version")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "package.json 缺少 \"version\" 字段".to_string())?;
    // 版本必须可 packed 编码（metadata 写入盖章与迁移门控依赖），否则拒绝打包
    core_plugin::pack_plugin_version(version)?;

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

    // 不在这里跑插件构建：pack 只负责打包「已构建好」的目录。构建由上层
    // package-plugin.ts 负责（见下方 main 脚本存在性检查——目录没构建过会在那里报错）。
    let kb_backend_str = pkg_obj
        .get("kbBackend")
        .and_then(|v| v.as_str())
        .unwrap_or("v8");
    // Rhai 已停止支持：from_str 对 "rhai" 会返回可读错误。
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
    let main_content =
        std::fs::read_to_string(&main_file).map_err(|e| format!("读取 main 脚本失败: {}", e))?;
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
    if let Some(cfgs) = pkg_obj
        .get("kbRecommendedConfigs")
        .and_then(|v| v.as_array())
    {
        for (i, v) in cfgs.iter().enumerate() {
            if let Some(path) = v.as_str() {
                core_plugin::validate_kb_rel_path(path)?;
                if !plugin_dir.join(path).is_file() {
                    return Err(format!(
                        "kbRecommendedConfigs[{}] 引用的文件不存在: {}",
                        i, path
                    ));
                }
            }
        }
    }
    if let Some(provs) = pkg_obj.get("kbPathQLProviders").and_then(|v| v.as_array()) {
        for (i, v) in provs.iter().enumerate() {
            if let Some(path) = v.as_str() {
                core_plugin::validate_kb_rel_path(path)?;
                if !plugin_dir.join(path).is_file() {
                    return Err(format!(
                        "kbPathQLProviders[{}] 引用的文件不存在: {}",
                        i, path
                    ));
                }
            }
        }
    }
    if pkg_obj.contains_key("kbMetadataMigrations") {
        return Err(
            "kbMetadataMigrations 已停止支持，请合并为单一迁移脚本并改用 kbMetadataMigration 字段"
                .to_string(),
        );
    }
    if let Some(mig_val) = pkg_obj.get("kbMetadataMigration") {
        let path = mig_val
            .as_str()
            .ok_or_else(|| "kbMetadataMigration 必须是字符串".to_string())?;
        core_plugin::validate_kb_rel_path(path)?;
        if !path.ends_with(".js") {
            return Err(format!(
                "kbMetadataMigration \"{}\" 必须是 .js 脚本（ES module，export migrate）",
                path
            ));
        }
        if !plugin_dir.join(path).is_file() {
            return Err(format!("kbMetadataMigration 引用的文件不存在: {}", path));
        }
    }

    // kbConfig 序列化校验
    if let Some(kb_config) = pkg_obj.get("kbConfig") {
        let arr = kb_config
            .as_array()
            .ok_or_else(|| "kbConfig 必须是数组".to_string())?;
        for (i, item) in arr.iter().enumerate() {
            serde_json::from_value::<kabegame_core::plugin::VarDefinition>(item.clone())
                .map_err(|e| format!("kbConfig[{}] 解析失败: {}", i, e))?;
        }
    }

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
    let header = kgpg::build_kgpg3_header(icon_rgb.as_deref())?;

    // ── ZIP ──
    let zip_bytes = collect_v3_entries(plugin_dir, pkg)?;
    kgpg::write_kgpg3_from_zip_bytes(output, &header, &zip_bytes)?;
    Ok(())
}

fn collect_v3_entries(plugin_dir: &Path, pkg: &serde_json::Value) -> Result<Vec<u8>, String> {
    use std::io::Write;

    let pkg_obj = pkg
        .as_object()
        .ok_or_else(|| "package.json 必须是 JSON 对象".to_string())?;

    let kubignore = load_kubignore(plugin_dir);

    let mut entries: Vec<(String, PathBuf)> = Vec::new();

    // package.json
    entries.push(("package.json".to_string(), plugin_dir.join("package.json")));

    // main script
    let main_path = pkg_obj
        .get("main")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "缺少 main".to_string())?;
    entries.push((main_path.to_string(), plugin_dir.join(main_path)));

    // kbIcon
    if let Some(icon) = pkg_obj.get("kbIcon").and_then(|v| v.as_str()) {
        entries.push((icon.to_string(), plugin_dir.join(icon)));
    }

    // kbDescriptionTemplate
    if let Some(tpl) = pkg_obj
        .get("kbDescriptionTemplate")
        .and_then(|v| v.as_str())
    {
        entries.push((tpl.to_string(), plugin_dir.join(tpl)));
    }

    // kbDoc + referenced images
    if let Some(doc_map) = pkg_obj.get("kbDoc").and_then(|v| v.as_object()) {
        for (_lang, doc_path_val) in doc_map {
            let doc_path = doc_path_val.as_str().unwrap_or("");
            let doc_full = plugin_dir.join(doc_path);
            let md_text = std::fs::read_to_string(&doc_full)
                .map_err(|e| format!("读取 {} 失败: {}", doc_path, e))?;

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
                        let sz = std::fs::metadata(&ref_full).map(|m| m.len()).unwrap_or(0);
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
    if let Some(configs) = pkg_obj
        .get("kbRecommendedConfigs")
        .and_then(|v| v.as_array())
    {
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

    // kbMetadataMigration（单一迁移脚本）
    if let Some(mig_path) = pkg_obj.get("kbMetadataMigration").and_then(|v| v.as_str()) {
        entries.push((mig_path.to_string(), plugin_dir.join(mig_path)));
    }

    // .kabegameignore
    if let Some(ignore_rules) = kubignore {
        let rooted = make_rooted_globset(&ignore_rules)?;

        // remove matches
        entries.retain(|(name, _path)| {
            if rooted.is_match(name) {
                let is_critical = name == "package.json"
                    || name == main_path
                    || pkg_obj
                        .get("kbDoc")
                        .and_then(|v| v.as_object())
                        .map(|d| d.values().any(|x| x.as_str() == Some(name)))
                        .unwrap_or(false);
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
    Regex::new(&re_str)
        .map(|re| re.is_match(name))
        .unwrap_or(false)
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
    builder
        .build()
        .map_err(|e| format!("构建 globset 失败: {}", e))
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
    fn test_data_import_image_parse_defaults() {
        let cli = Cli::try_parse_from(["kabegame-cli", "data", "import-image", "./a.png"]).unwrap();
        let Commands::Data(DataCommands::ImportImage(args)) = cli.command else {
            panic!("expected data import-image");
        };
        assert_eq!(args.path, PathBuf::from("./a.png"));
        assert!(args.album.is_none());
        assert!(args.metadata.is_none());
    }

    #[test]
    fn test_data_import_image_parse_options() {
        let cli = Cli::try_parse_from([
            "kabegame-cli",
            "data",
            "import-image",
            "./a.png",
            "--album",
            "/星穹铁道/萤",
            "--metadata",
            r#"{"k":1}"#,
        ])
        .unwrap();
        let Commands::Data(DataCommands::ImportImage(args)) = cli.command else {
            panic!("expected data import-image");
        };
        assert_eq!(args.album.as_deref(), Some("/星穹铁道/萤"));
        assert_eq!(args.metadata.as_deref(), Some(r#"{"k":1}"#));
    }

    #[test]
    fn test_data_query_parse_modes() {
        for args in [
            vec!["kabegame-cli", "data", "query", "images://gallery/all"],
            vec!["kabegame-cli", "data", "query", "p", "--list"],
            vec![
                "kabegame-cli",
                "data",
                "query",
                "p",
                "--list",
                "--with-count",
            ],
            vec!["kabegame-cli", "data", "query", "p", "--entry"],
            vec!["kabegame-cli", "data", "query", "p", "--fetch"],
        ] {
            assert!(Cli::try_parse_from(args).is_ok());
        }

        let cli =
            Cli::try_parse_from(["kabegame-cli", "data", "query", "images://gallery/all"]).unwrap();
        let Commands::Data(DataCommands::Query(args)) = cli.command else {
            panic!("expected data query");
        };
        assert!(!args.list && !args.entry && !args.fetch && !args.with_count);
    }

    #[test]
    fn test_plugin_commands_still_parse() {
        assert!(Cli::try_parse_from(["kabegame-cli", "plugin", "new", "foo"]).is_ok());
        assert!(Cli::try_parse_from([
            "kabegame-cli",
            "plugin",
            "pack",
            "--plugin-dir",
            "d",
            "--output",
            "o.kgpg",
        ])
        .is_ok());
        assert!(Cli::try_parse_from(["kabegame-cli", "plugin", "import", "x.kgpg"]).is_ok());
    }

    #[test]
    fn test_removed_and_invalid_commands_fail_to_parse() {
        for args in [
            vec!["kabegame-cli", "data", "query", "p", "--list", "--entry"],
            vec!["kabegame-cli", "data", "query", "p", "--fetch", "--list"],
            vec!["kabegame-cli", "data", "query", "p", "--with-count"],
            vec!["kabegame-cli", "data", "import-image"],
            vec!["kabegame-cli", "plugin", "pack"],
            vec!["kabegame-cli", "vd", "mount"],
            vec!["kabegame-cli", "plugin", "run", "--plugin", "x"],
            vec!["kabegame-cli", "ipc-status"],
        ] {
            assert!(Cli::try_parse_from(args).is_err());
        }
    }

    #[test]
    fn test_album_tree_path_to_pathql() {
        assert_eq!(
            album_tree_path_to_pathql("星穹铁道/萤"),
            "albums://by_sub_tree/星穹铁道/萤"
        );
        assert_eq!(
            album_tree_path_to_pathql("/星穹铁道/萤"),
            "albums://by_sub_tree/星穹铁道/萤"
        );
        assert_eq!(
            album_tree_path_to_pathql("id_00000000-0000-0000-0000-000000000001"),
            "albums://by_sub_tree/id_00000000-0000-0000-0000-000000000001"
        );
        assert_eq!(album_tree_path_to_pathql(""), "albums://by_sub_tree/");
    }

    #[test]
    fn test_album_id_from_parent_children() {
        let rows = vec![
            serde_json::json!({"id": "march-id", "name": "三月七"}),
            serde_json::json!({"id": "firefly-id", "name": "萤"}),
        ];
        assert_eq!(
            album_id_from_children(&rows, "萤", "/星穹铁道/萤").unwrap(),
            "firefly-id"
        );
        let error = album_id_from_children(&rows, "流萤", "/星穹铁道/流萤").unwrap_err();
        assert!(error.contains("未找到画册树路径"));
    }

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
    fn test_render_liquid_if_webview() {
        let mut vars = HashMap::new();
        vars.insert("backend".to_string(), "webview".to_string());

        let tmpl = "{% if backend == \"v8\" %}v8-block{% else %}web-block{% endif %}";
        let result = render_liquid_template(tmpl, &vars).unwrap();
        assert_eq!(result, "web-block");
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
backend = { type = "string", choices = ["v8", "webview"] }

[conditional.'backend != "v8"']
ignore = ["src", "rspack.config.mjs"]

[conditional.'backend == "webview"']
ignore = ["tsconfig.json"]
"#;
        let ignored = parse_cargo_generate_conditions(toml, "v8").unwrap();
        // v8 -> "backend != v8" is false, so src/rspack not ignored;
        // "backend == webview" is false.
        assert!(!ignored.contains(&"src".to_string()));
        assert!(!ignored.contains(&"rspack.config.mjs".to_string()));

        let ignored_webview = parse_cargo_generate_conditions(toml, "webview").unwrap();
        assert!(ignored_webview.contains(&"src".to_string()));
        assert!(ignored_webview.contains(&"rspack.config.mjs".to_string()));
        assert!(ignored_webview.contains(&"tsconfig.json".to_string()));
    }
}
