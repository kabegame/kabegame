//! Kabegame CLI（sidecar）
//!
//! 目前支持：
//! - `plugin new`：创建爬虫插件模板
//! - `plugin pack`：打包单个插件目录为 `.kgpg`（package.json v3）
//! - `plugin import`：导入本地 `.kgpg` 插件文件（复制到 plugins_directory）
//! - `plugin run`：运行已安装插件或临时 `.kgpg`，实时渲染日志与进度
//! - `data import-image`：通过内建 local-import 任务导入单个本地图片或视频
//! - `pathql generate`：生成 PathQL 客户端
//! - `pathql query`：查询 PathQL 数据

use clap::{Args, Parser, Subcommand, ValueEnum};
use include_dir::{include_dir, Dir};
use kabegame_core::plugin as core_plugin;
use kabegame_core::{
    kgpg,
    plugin::{manifest_value_to_display_string, PluginManager},
};
use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};

mod backend;
mod task_log;

use backend::{choose_backend, Backend, LocalNeeds, Via};

const TEMPLATE_DIR: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/template");

#[derive(Parser, Debug)]
#[command(name = "kabegame-cli")]
#[command(version)]
#[command(about = "Kabegame 命令行工具", long_about = None)]
struct Cli {
    /// 数据类操作的执行方式：自动优先主程序，或强制主程序/本地。
    #[arg(long, global = true, value_enum, default_value_t = Via::Auto)]
    via: Via,
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
    /// PathQL 相关命令
    #[command(subcommand)]
    Pathql(PathqlCommands),
    /// 运行中任务控制
    #[command(subcommand)]
    Task(TaskCommands),
}

#[derive(Subcommand, Debug)]
enum TaskCommands {
    /// 调整运行中任务的下载并发上限
    Concurrency(TaskConcurrencyArgs),
}

#[derive(Args, Debug)]
struct TaskConcurrencyArgs {
    /// 运行中任务 id
    task_id: String,
    /// 正整数，或 global（跟随应用全局设置）
    value: TaskConcurrencyValue,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TaskConcurrencyValue {
    Global,
    Limit(u32),
}

impl std::str::FromStr for TaskConcurrencyValue {
    type Err = String;

    fn from_str(raw: &str) -> Result<Self, Self::Err> {
        if raw.eq_ignore_ascii_case("global") {
            return Ok(Self::Global);
        }
        let value = raw
            .parse::<u32>()
            .map_err(|_| "并发数必须是正整数或 global".to_string())?;
        if value == 0 {
            return Err("并发数必须大于等于 1".to_string());
        }
        Ok(Self::Limit(value))
    }
}

#[derive(Subcommand, Debug)]
enum PluginCommands {
    /// 创建插件模板目录
    New(NewPluginArgs),
    /// 打包单个插件目录为 `.kgpg`（KGPG v3：固定头部 + ZIP，ZIP 内不含 icon.png）
    Pack(PackPluginArgs),
    /// 导入本地 `.kgpg` 插件文件（复制到 plugins_directory）
    Import(ImportPluginArgs),
    /// 运行插件：已安装的 id，或直接给 `.kgpg` 路径临时运行（不安装）
    Run(RunPluginArgs),
}

#[derive(Subcommand, Debug)]
enum DataCommands {
    /// 通过 local-import 任务导入单个本地文件（图片或视频）
    ImportImage(ImportImageArgs),
}

#[derive(Subcommand, Debug)]
enum PathqlCommands {
    /// 生成 PathQL 客户端
    Generate(GenerateArgs),
    /// 查询 PathQL 结果；始终在 CLI 本进程只读执行，忽略全局 --via
    Query(DataQueryArgs),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
enum GenerateTarget {
    #[value(name = "typescript")]
    TypeScript,
}

#[derive(Args, Debug)]
struct GenerateArgs {
    /// 生成目标
    #[arg(long, value_enum, default_value = "typescript")]
    target: GenerateTarget,
    /// 输出文件路径；传 `-` 时写入标准输出
    #[arg(long)]
    out: PathBuf,
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
    /// 已安装插件的 id（如 kemono），或一个 `.kgpg` 文件路径——后者临时运行，
    /// 不写进 plugins_directory。
    plugin: String,
    /// 仅 `.kgpg` 路径模式：指定本次运行用的插件 id，顶掉包内 package.json 的 `name`
    /// 与文件名。影响 provider namespace、插件数据目录与 `default-configs/<id>.json`
    /// 的取用——想让同一个包跑成另一份互不干扰的数据时用它。
    #[arg(long = "id", value_name = "PLUGIN_ID")]
    id: Option<String>,
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
    /// 本任务最大并发下载数（≥1，超过全局设置时按全局生效）；不传则跟随应用全局设置
    #[arg(long = "max-downloads", value_name = "N", value_parser = clap::value_parser!(u32).range(1..))]
    max_downloads: Option<u32>,
    /// 只解析并打印最终配置，不真正运行任务
    #[arg(long = "dry-run")]
    dry_run: bool,
    /// 不渲染进度条，日志逐行直出（适合 CI / 重定向到文件）
    #[arg(long = "plain")]
    plain: bool,
}

#[derive(Args, Debug)]
struct ImportImageArgs {
    /// 本地文件路径（图片或视频；不支持 URL / 文件夹）
    path: PathBuf,
    /// 目标画册树路径；前缀斜线可选，不传则不加入任何画册
    #[arg(long = "album")]
    album: Option<String>,
}

#[derive(Args, Debug)]
/// PathQL 只读查询参数；该子命令忽略全局 `--via`。
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
/// 一个够用的 liquid 子集：`{{ var }}` 与 `{% if/elsif/else/endif %}`，含 `{%- -%}` 空白控制。
///
/// 两个坑都踩过，别回退：
/// - 带 `-` 的空白控制标签要先剥掉 `-` 再认关键字。否则 `{%- if %}` 被当成未知标签整条跳过，
///   if / else 两个分支会一起写出去——生成过带重复 `main` 键的非法 package.json。
/// - 「当前该不该输出」看的是每层分支是否成立，不是「这层有没有分支命中过」；后者只用来决定
///   elsif / else 要不要接管。混用会让 `{% if %}A{% elsif %}B{% endif %}` 把 A、B 都写出去。
///
/// 不认识的标签 / 条件直接报错：模板写错时宁可 `plugin new` 失败，也不要静默生成坏文件。
fn render_liquid_template(
    template: &str,
    vars: &HashMap<String, String>,
) -> Result<String, String> {
    /// 一层 `{% if %}`：`parent_active` 是外层是否成立，`active` 是当前分支要不要输出，
    /// `taken` 记录本层是否已经有分支命中（elsif / else 据此短路）。
    struct Frame {
        parent_active: bool,
        active: bool,
        taken: bool,
    }

    let chars: Vec<char> = template.chars().collect();
    let len = chars.len();
    let mut out = String::with_capacity(template.len());
    let mut stack: Vec<Frame> = Vec::new();
    let mut i = 0;

    while i < len {
        let close = match (chars[i], chars.get(i + 1)) {
            ('{', Some('%')) => '%',
            ('{', Some('{')) => '}',
            _ => {
                if stack.iter().all(|f| f.active) {
                    out.push(chars[i]);
                }
                i += 1;
                continue;
            }
        };

        let end = find_tag_end(&chars, i + 2, close);
        let raw_body = chars_to_string(&chars[i + 2..end]);
        i = (end + 2).min(len);

        // 空白控制：`{%-` 吃掉前面已输出的空白，`-%}` 吃掉后面还没读的空白。
        if raw_body.starts_with('-') {
            while out.ends_with(|c: char| c.is_whitespace()) {
                out.pop();
            }
        }
        if raw_body.ends_with('-') {
            while i < len && chars[i].is_whitespace() {
                i += 1;
            }
        }
        let body = raw_body.trim_matches('-').trim();

        if close == '}' {
            if stack.iter().all(|f| f.active) {
                // 认不出的变量原样留着：模板里可能有并非变量的双花括号。
                out.push_str(
                    &vars
                        .get(body)
                        .cloned()
                        .unwrap_or_else(|| format!("{{{{ {body} }}}}")),
                );
            }
            continue;
        }

        if let Some(cond) = body.strip_prefix("if ") {
            let parent_active = stack.iter().all(|f| f.active);
            let hit = eval_liquid_cond(cond, vars)?;
            stack.push(Frame {
                parent_active,
                active: parent_active && hit,
                taken: hit,
            });
        } else if let Some(cond) = body.strip_prefix("elsif ") {
            let taken = stack
                .last()
                .ok_or_else(|| format!("模板里出现了没有 if 的 `{body}`"))?
                .taken;
            let hit = !taken && eval_liquid_cond(cond, vars)?;
            let frame = stack.last_mut().expect("checked above");
            frame.active = frame.parent_active && hit;
            frame.taken = taken || hit;
        } else if body == "else" {
            let frame = stack
                .last_mut()
                .ok_or_else(|| "模板里出现了没有 if 的 `else`".to_string())?;
            frame.active = frame.parent_active && !frame.taken;
            frame.taken = true;
        } else if body == "endif" {
            stack
                .pop()
                .ok_or_else(|| "模板里出现了没有 if 的 `endif`".to_string())?;
        } else {
            return Err(format!("模板里有不支持的标签 `{{% {body} %}}`"));
        }
    }

    if !stack.is_empty() {
        return Err("模板里有未闭合的 `{% if %}`".to_string());
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

/// 条件只支持 `<var> == "x"` / `<var> != "x"`，够模板用；其余报错而不是当成 false。
fn eval_liquid_cond(cond: &str, vars: &HashMap<String, String>) -> Result<bool, String> {
    let cond = cond.trim();
    for (op, want_eq) in [("==", true), ("!=", false)] {
        if let Some((lhs, rhs)) = cond.split_once(op) {
            let var = lhs.trim();
            let val = rhs.trim().trim_matches('"');
            let actual = vars
                .get(var)
                .ok_or_else(|| format!("模板条件 `{cond}` 引用了未知变量 `{var}`"))?;
            return Ok((actual == val) == want_eq);
        }
    }
    Err(format!("模板里有不支持的条件 `{cond}`"))
}

#[tokio::main]
async fn main() {
    let Cli { via, command } = Cli::parse();

    let res = match command {
        Commands::Plugin(cmd) => match cmd {
            PluginCommands::New(args) => new_plugin(args),
            PluginCommands::Pack(args) => pack_plugin(args),
            PluginCommands::Import(args) => import_plugin(args, via).await,
            PluginCommands::Run(args) => run_plugin(args, via).await,
        },
        Commands::Data(cmd) => match cmd {
            DataCommands::ImportImage(args) => data_import_image(args, via).await,
        },
        Commands::Pathql(cmd) => match cmd {
            PathqlCommands::Generate(args) => pathql_generate(args),
            PathqlCommands::Query(args) => data_query(args).await,
        },
        Commands::Task(cmd) => match cmd {
            TaskCommands::Concurrency(args) => task_concurrency(args, via).await,
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

    write_template_files(&TEMPLATE_DIR, &plugin_dir, &vars, &ignored)?;

    println!(
        "插件模板创建成功：{}（backend={}）",
        plugin_dir.display(),
        backend_str
    );
    Ok(())
}

/// 把内嵌模板目录递归写到 `out_dir`。
///
/// 注意 include_dir 的 `path()` 返回的是**相对模板根的完整路径**（`src/index.ts`），
/// 不是单层名字。曾经按「父目录前缀 + path()」拼接，于是写出了 `src/src/index.ts`、
/// `docs/docs/doc.md`——直接用 `path()` 即可。
fn write_template_files(
    dir: &Dir<'_>,
    out_dir: &Path,
    vars: &HashMap<String, String>,
    ignored: &[String],
) -> Result<(), String> {
    for entry in dir.entries() {
        let rel = entry.path().to_string_lossy().to_string();
        // cargo-generate.toml 只是模板自己的条件声明，不属于生成结果。
        if rel == "cargo-generate.toml" || is_ignored_template_path(&rel, ignored) {
            continue;
        }
        match entry {
            include_dir::DirEntry::Dir(sub_dir) => {
                write_template_files(sub_dir, out_dir, vars, ignored)?;
            }
            include_dir::DirEntry::File(file) => {
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
                    "json" | "js" | "ts" | "mjs" | "md" | "toml" | "gitignore"
                );

                match file.contents_utf8().filter(|_| is_text) {
                    Some(text) => {
                        let rendered = render_liquid_template(text, vars)?;
                        std::fs::write(&out_path, rendered)
                            .map_err(|e| format!("写入文件失败 {}: {e}", out_path.display()))?;
                    }
                    None => {
                        std::fs::write(&out_path, file.contents())
                            .map_err(|e| format!("写入文件失败 {}: {e}", out_path.display()))?;
                    }
                }
            }
        }
    }
    Ok(())
}

/// cargo-generate.toml 的 `ignore` 项既可以是文件也可以是目录，按路径段匹配：
/// `src` 命中 `src` 与 `src/index.ts`，但不命中 `srcfoo`。
fn is_ignored_template_path(rel: &str, ignored: &[String]) -> bool {
    ignored
        .iter()
        .any(|p| rel == p.as_str() || rel.starts_with(&format!("{p}/")))
}

fn is_valid_plugin_name(name: &str) -> bool {
    Regex::new(r"^[a-z][a-z0-9]*(-[a-z0-9]+)*$")
        .map(|re| re.is_match(name))
        .unwrap_or(false)
}

fn init_standalone_globals() -> Result<(), String> {
    init_paths()?;
    init_local_globals()
}

/// 数据目录只由编译期的 `kabegame_data` cfg 决定（构建系统 `--data dev|prod`，见 AGENTS.md）：
/// dev = 仓库内 `.kabegame/debug/{data,cache,tmp}`，prod = 系统用户数据目录。
fn init_paths() -> Result<(), String> {
    use kabegame_core::app_paths::{is_dev, repo_root_dir, AppPaths};

    let dev_debug_dir = if is_dev() {
        let root = repo_root_dir().ok_or_else(|| {
            "dev 数据模式的 CLI 需要在 Kabegame 仓库内运行（要能定位到包含 package.json 与 src-tauri/ 的目录）"
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
    })
}

fn init_local_globals() -> Result<(), String> {
    use kabegame_core::{emitter::GlobalEmitter, settings::Settings, storage::Storage};

    // 必须早于 GlobalEmitter：emit_* 会取 EventBroadcaster 的全局单例，没初始化就 panic。
    init_event_runtime()?;
    Settings::init_global()?;
    Storage::init_global()?;
    GlobalEmitter::init_global()?;
    Ok(())
}

/// 事件运行时。由本地后端初始化在最前面调用，不要在外面再调一次
/// （`init_global` 对重复初始化返回 Err）。
///
/// 顺序与 GUI 的 `kabegame/src/core_init.rs:73-88` 一致：
/// EventBroadcaster → SubscriptionManager → GlobalEmitter → DownloadQueue → TaskScheduler。
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

pub(crate) async fn init_local_runtime(needs: LocalNeeds) -> Result<(), String> {
    use kabegame_core::crawler::{TaskScheduler, MAX_TASK_WORKER_LOOPS};
    use kabegame_core::ipc::server::EventBroadcaster;

    init_local_globals()?;
    if needs.plugin {
        PluginManager::init_global_without_metadata_migrations()?;
    }
    if needs.tasks {
        init_task_runtime()?;
        tokio::spawn(async { EventBroadcaster::start_forward_task().await });
        let scheduler = TaskScheduler::global();
        scheduler.start_workers(MAX_TASK_WORKER_LOOPS).await;
        scheduler.start_download_workers_async().await;
    }
    Ok(())
}

async fn data_import_image(args: ImportImageArgs, via: Via) -> Result<(), String> {
    if !args.path.is_file() {
        return Err(format!("文件不存在或不是普通文件: {}", args.path.display()));
    }

    let path = std::fs::canonicalize(&args.path)
        .map_err(|error| format!("解析文件路径失败 {}: {error}", args.path.display()))?;
    init_paths()?;
    let backend = choose_backend(via, LocalNeeds::TASKS).await?;
    let album_id = match args.album.as_deref() {
        Some(tree_path) => Some(resolve_album_tree_path(&backend, tree_path).await?),
        None => None,
    };
    let mut events = backend.subscribe_task_events().await?;
    let task_id = backend
        .start_task(serde_json::json!({
            "pluginId": "local-import",
            "userConfig": {
                "paths": [path.to_string_lossy().into_owned()],
                "recursive": false,
            },
            "outputAlbumId": album_id.clone(),
            "triggerSource": "cli",
        }))
        .await?;
    let cancel_backend = backend.clone();
    let outcome = render_task(
        &task_id,
        "local-import",
        &mut events,
        !console::user_attended(),
        move |task_id| async move { cancel_backend.cancel_task(&task_id).await },
    )
    .await;

    match outcome {
        TaskOutcome::Completed {
            downloaded,
            dedup,
            failed,
        } => {
            let album = album_id
                .as_deref()
                .map(|id| format!("画册={id}"))
                .unwrap_or_else(|| "（未加入画册）".to_string());
            println!("导入完成：成功 {downloaded}，去重 {dedup}，失败 {failed}；{album}");
            Ok(())
        }
        TaskOutcome::Canceled => Err("任务已取消".to_string()),
        TaskOutcome::Failed(error) => Err(format!("任务失败：{error}")),
    }
}

/// PathQL 只读查询：总在本进程执行，不经主程序，不迁移、不写库。
async fn data_query(args: DataQueryArgs) -> Result<(), String> {
    init_paths()?;
    kabegame_core::storage::Storage::init_global_read_only()?;
    PluginManager::init_global_without_metadata_migrations()?;
    PluginManager::global()
        .ensure_installed_cache_initialized()
        .await?;
    use kabegame_core::commands::image::{pathql_entry, pathql_fetch, pathql_list};
    let output = if args.list {
        pathql_list(args.path, args.with_count).await?
    } else if args.entry {
        pathql_entry(args.path).await?
    } else {
        pathql_fetch(args.path).await?
    };
    println!(
        "{}",
        serde_json::to_string_pretty(&output).map_err(|error| error.to_string())?
    );
    Ok(())
}

fn pathql_generate(args: GenerateArgs) -> Result<(), String> {
    use kabegame_core::providers::provider_runtime;
    use pathql_rs::client_codegen::CodegenTarget;

    init_standalone_globals()?;
    let target = match args.target {
        GenerateTarget::TypeScript => CodegenTarget::TypeScript,
    };
    let output = provider_runtime()
        .client_codegen(target)
        .map_err(|error| error.to_string())?;
    let byte_count = output.len();

    if args.out == Path::new("-") {
        let mut stdout = std::io::stdout().lock();
        stdout
            .write_all(output.as_bytes())
            .map_err(|error| format!("写入标准输出失败: {error}"))?;
        stdout
            .flush()
            .map_err(|error| format!("刷新标准输出失败: {error}"))?;
        eprintln!("PathQL 客户端生成成功：{byte_count} 字节；输出=-");
        return Ok(());
    }

    if let Some(parent) = args
        .out
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("创建输出目录 `{}` 失败: {error}", parent.display()))?;
    }
    std::fs::write(&args.out, output)
        .map_err(|error| format!("写入 `{}` 失败: {error}", args.out.display()))?;
    eprintln!(
        "PathQL 客户端生成成功：{byte_count} 字节；输出={}",
        args.out.display()
    );
    Ok(())
}

/// 画册树路径转换为 albums provider 路径；前缀斜线可选。
#[cfg(test)]
fn album_tree_path_to_pathql(tree_path: &str) -> String {
    format!("albums://by_sub_tree/{}", tree_path.trim_start_matches('/'))
}

/// 查询目标画册的父路径，并从父画册返回的直接子画册中按名称查找目标 id。
async fn resolve_album_tree_path(backend: &Backend, tree_path: &str) -> Result<String, String> {
    use kabegame_core::providers::decode_provider_path_segments;

    let relative_path = tree_path.trim_start_matches('/').trim_end_matches('/');
    if relative_path.is_empty() {
        return Err("画册树路径不能为空".to_string());
    }

    let (parent_path, target_name_raw) = relative_path
        .rsplit_once('/')
        .map_or(("", relative_path), |(parent, name)| (parent, name));
    if target_name_raw.is_empty() {
        return Err(format!("无效的画册树路径: {tree_path}"));
    }
    let target_name = decode_provider_path_segments(target_name_raw);
    let query_path = if parent_path.is_empty() {
        "albums://by_sub_tree".to_string()
    } else {
        format!("albums://by_sub_tree/{parent_path}")
    };
    let rows = backend.pathql_fetch(&query_path).await?;
    let rows = rows
        .as_array()
        .ok_or_else(|| format!("画册查询返回了非数组数据: {query_path}"))?;
    album_id_from_children(rows, &target_name, tree_path)
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

async fn import_plugin(args: ImportPluginArgs, via: Via) -> Result<(), String> {
    let p = args.path;
    if !p.is_file() {
        return Err(format!("插件文件不存在: {}", p.display()));
    }
    if p.extension().and_then(|s| s.to_str()) != Some("kgpg") {
        return Err(format!("不是 .kgpg 文件: {}", p.display()));
    }

    let p = std::fs::canonicalize(&p)
        .map_err(|error| format!("解析插件路径失败 {}: {error}", p.display()))?;
    init_paths()?;

    // 包解析是纯文件系统读取：无论最终选哪个后端，都先在 CLI 进程校验。
    let preview = PluginManager::new().preview_import_from_kgpg(&p).await?;
    let backend = choose_backend(via, LocalNeeds::PLUGIN).await?;
    backend.install_plugin(&p).await?;
    let plugins_dir = kabegame_core::app_paths::AppPaths::global().plugins_dir();

    println!(
        "导入成功：id={}; name={}; version={}; 目标目录={}",
        preview.id,
        manifest_value_to_display_string(&preview.name),
        preview.version,
        plugins_dir.display()
    );
    Ok(())
}

/// 运行已安装插件，或直接临时运行 `.kgpg`。
async fn run_plugin(args: RunPluginArgs, via: Via) -> Result<(), String> {
    let plugin = if Path::new(&args.plugin)
        .extension()
        .and_then(|extension| extension.to_str())
        == Some("kgpg")
    {
        let path = PathBuf::from(&args.plugin);
        if !path.is_file() {
            return Err(format!("插件文件不存在: {}", path.display()));
        }
        std::fs::canonicalize(&path)
            .map_err(|error| format!("解析插件文件路径失败 {}: {error}", path.display()))?
            .to_string_lossy()
            .into_owned()
    } else {
        args.plugin.clone()
    };

    init_paths()?;
    let backend = choose_backend(via, LocalNeeds::TASKS).await?;
    let mut events = if args.dry_run {
        None
    } else {
        Some(backend.subscribe_task_events().await?)
    };
    let output = backend
        .run_plugin(kabegame_core::commands::task::PluginRunParams {
            plugin,
            id_override: args.id,
            args: args.vars,
            output_dir: args.output_dir,
            output_album_id: args.album_id,
            http_headers: None,
            max_concurrent_downloads: args.max_downloads,
            dry_run: args.dry_run,
        })
        .await?;
    let config_json = serde_json::to_string_pretty(&output.config).map_err(|e| e.to_string())?;
    println!(
        "{} {} v{}",
        console::style("插件").dim(),
        console::style(&output.plugin_id).bold(),
        output.plugin_version
    );
    if let Some(path) = output.plugin_file_path.as_ref() {
        println!("{} {}", console::style("临时运行（未安装）：").dim(), path);
    }
    println!("{}", console::style("最终配置：").dim());
    println!("{config_json}");

    if args.dry_run {
        return Ok(());
    }
    let task_id = output
        .task_id
        .ok_or_else(|| "插件运行未返回 task_id".to_string())?;
    let mut events = events
        .take()
        .ok_or_else(|| "插件运行未建立事件订阅".to_string())?;
    let plain = args.plain || !console::user_attended();
    let cancel_backend = backend.clone();
    let outcome = render_task(
        &task_id,
        &output.plugin_id,
        &mut events,
        plain,
        move |task_id| async move { cancel_backend.cancel_task(&task_id).await },
    )
    .await;

    match outcome {
        TaskOutcome::Completed {
            downloaded,
            dedup,
            failed,
        } => {
            println!(
                "{} 下载 {} 张，去重 {}，失败 {}",
                console::style("完成").green().bold(),
                downloaded,
                dedup,
                failed
            );
            Ok(())
        }
        TaskOutcome::Canceled => Err("任务已取消".to_string()),
        TaskOutcome::Failed(err) => Err(format!("任务失败：{err}")),
    }
}

async fn task_concurrency(args: TaskConcurrencyArgs, via: Via) -> Result<(), String> {
    if via == Via::Local {
        return Err(
            "task concurrency 只能调整主程序中运行的任务，不能使用 --via local".to_string(),
        );
    }
    init_paths()?;
    let backend = choose_backend(Via::App, LocalNeeds::DATA).await?;
    let value = match args.value {
        TaskConcurrencyValue::Global => None,
        TaskConcurrencyValue::Limit(value) => Some(value),
    };
    backend
        .set_task_max_concurrent_downloads(&args.task_id, value)
        .await?;
    println!(
        "任务 {} 的下载并发已设为 {}",
        args.task_id,
        value.map_or_else(|| "跟随全局".to_string(), |value| value.to_string())
    );
    Ok(())
}

enum TaskOutcome {
    Completed {
        downloaded: u64,
        dedup: u64,
        failed: u64,
    },
    Canceled,
    Failed(String),
}

/// 事件循环 + 终端渲染。
///
/// 形态：进度条常驻最后一行，日志由 `ProgressBar::println` 从进度条**上方**滚出，
/// 与 cargo / apt 一致。非 TTY（管道、CI）自动降级成逐行直出。
async fn render_task<C, Fut>(
    task_id: &str,
    plugin_id: &str,
    events: &mut tokio::sync::mpsc::UnboundedReceiver<
        std::sync::Arc<kabegame_core::ipc::events::AppEvent>,
    >,
    plain: bool,
    cancel: C,
) -> TaskOutcome
where
    C: FnOnce(String) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    use indicatif::{ProgressBar, ProgressStyle};
    use kabegame_core::ipc::events::AppEvent;

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
            msg.push_str(&format!(
                " · {}",
                console::style(format!("✗{failed}")).red()
            ));
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
            cancel(cancel_task_id).await;
        }
    });

    while let Some(ev) = events.recv().await {
        match &*ev {
            AppEvent::TaskLog {
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
            AppEvent::TaskChanged { task_id: tid, diff } if tid == task_id => {
                if let Some(p) = diff.get("progress").and_then(|v| v.as_f64()) {
                    progress = p;
                }
                // 计数只认这个快照：downloader 每次落库/去重后都会
                // `emit_task_image_counts_snapshot` 发一份读自 DB 的全量计数。
                // 曾经这里还按 `images-change(add)` 自行累加，但那两类事件走的是
                // 各自的 broadcast channel、再由独立 task 汇进同一个 mpsc，
                // 相互之间没有顺序保证：快照先到就会被随后的累加又叠一次，
                // 于是每张图都多计一次（实测稳定 +1）。
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
                        "completed" => Some(TaskOutcome::Completed {
                            downloaded,
                            dedup,
                            failed,
                        }),
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
    // core 的非插件日志是 i18n 载荷，先按应用设置的语言渲染成文本；插件日志原样保留。
    let message = task_log::render(message);
    let message = message.as_str();
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

fn pack_plugin(args: PackPluginArgs) -> Result<(), String> {
    let plugin_dir = args.plugin_dir;
    if !plugin_dir.is_dir() {
        return Err(format!("插件目录不存在: {}", plugin_dir.display()));
    }

    // 只支持 kbPackageVersion >= 3 的 package.json 插件格式。
    let pkg = read_optional_package_json(&plugin_dir)?
        .filter(|v| core_plugin::package_json_is_v3(v))
        .ok_or_else(|| "只支持 kbPackageVersion >= 3 的 package.json 插件".to_string())?;
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
    kabegame_core::app_paths::validate_plugin_id(pkg_name)
        .map_err(|reason| format!("插件 ID \"{pkg_name}\" 不合规: {reason}"))?;
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
    for field in ["kbDoc", "kbChangelog"] {
        if let Some(doc_map) = pkg_obj.get(field).and_then(|v| v.as_object()) {
            for (lang, v) in doc_map {
                if let Some(path) = v.as_str() {
                    core_plugin::validate_kb_rel_path(path)?;
                    if !plugin_dir.join(path).is_file() {
                        return Err(format!("{field}[\"{lang}\"] 引用的文件不存在: {path}"));
                    }
                }
            }
        }
    }

    let mut assets: HashMap<String, String> = HashMap::new();
    let mut total_size = 0_u64;
    if pkg_obj.contains_key("kbDocAssets") {
        return Err(
            "kbDocAssets 已被 kbAssets 取代：改为插件根相对路径数组，例如 \
             \"kbAssets\": [\"images/a.png\"]"
                .to_string(),
        );
    }
    if let Some(items) = pkg_obj.get("kbAssets") {
        let items = items
            .as_array()
            .ok_or_else(|| "kbAssets 必须是数组".to_string())?;
        for item in items {
            let raw = item
                .as_str()
                .ok_or_else(|| "kbAssets 每一项必须是字符串".to_string())?;
            let path = core_plugin::assets::normalize_asset_path(raw)
                .ok_or_else(|| format!("kbAssets 含非法资源路径: {raw:?}"))?;
            if let Some(prev) = assets.get(&path) {
                return Err(format!(
                    "kbAssets 归一化后冲突: {raw:?} 与 {prev:?} 都归一化为 {path:?}"
                ));
            }
            core_plugin::validate_kb_rel_path(&path)?;
            let file = plugin_dir.join(&path);
            if !file.is_file() {
                return Err(format!("kbAssets 项引用的文件不存在: {raw:?} → {path}"));
            }
            let mime = core_plugin::assets::mime_for_asset(&path);
            if !mime.starts_with("image/") || mime == "image/svg+xml" {
                return Err(format!(
                    "kbAssets 项扩展名不受支持: {path}（仅 jpg/jpeg/png/gif/webp/bmp）"
                ));
            }
            let size = std::fs::metadata(&file)
                .map_err(|e| format!("读取资源文件大小失败 {path}: {e}"))?
                .len();
            if size > core_plugin::assets::ASSET_MAX_FILE_SIZE as u64 {
                return Err(format!(
                    "kbAssets 项超过 2 MB 硬上限: {path} ({size} bytes)"
                ));
            }
            total_size = total_size.saturating_add(size);
            assets.insert(path, raw.to_string());
        }
    }

    let mut referenced = HashSet::new();
    for field in ["kbDoc", "kbChangelog"] {
        let Some(doc_map) = pkg_obj.get(field).and_then(|v| v.as_object()) else {
            continue;
        };
        for (lang, path_value) in doc_map {
            let Some(md_path) = path_value.as_str() else {
                continue;
            };
            let md = std::fs::read_to_string(plugin_dir.join(md_path))
                .map_err(|e| format!("读取 {field}[{lang:?}] {md_path:?} 失败: {e}"))?;
            for raw_ref in core_plugin::extract_local_refs(&md) {
                let Some(path) = core_plugin::assets::normalize_asset_path(&raw_ref) else {
                    continue;
                };
                referenced.insert(path.clone());
                if !assets.contains_key(&path) {
                    let json = serde_json::to_string(&path).unwrap_or_else(|_| "\"\"".into());
                    return Err(format!(
                        "{field}[{lang:?}] 引用了未在 kbAssets 声明的本地资源 {raw_ref:?}\
                         （插件根相对路径 {path:?}）。建议补充：\n\"kbAssets\": [{json}]"
                    ));
                }
            }
        }
    }

    // HashMap 迭代顺序每次都不同，排序后再报，日志才能逐行对得上。
    let mut assets_sorted: Vec<(&String, &String)> = assets.iter().collect();
    assets_sorted.sort_by(|(a, _), (b, _)| a.cmp(b));
    for (path, raw) in assets_sorted {
        // banner 图是走马灯橱窗图，本就不进 md，别为它报「未被引用」的噪音
        if !referenced.contains(path) && !core_plugin::assets::is_banner_asset(path) {
            eprintln!(
                "[WARN] kbAssets 声明但未被任何 kbDoc / kbChangelog 引用（允许预留）: \
                 {raw:?} → {path:?}"
            );
        }
    }
    if total_size > core_plugin::assets::ASSET_MAX_TOTAL_SIZE as u64 {
        eprintln!("[WARN] kbAssets 总体积超过 10 MB，加载期将跳过超出部分: {total_size} bytes");
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

    // v3 打包是全量白名单：只收 package.json 显式字段引用到的文件，没有额外的排除机制。
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

    // kbDoc / kbChangelog md 本体
    for field in ["kbDoc", "kbChangelog"] {
        if let Some(doc_map) = pkg_obj.get(field).and_then(|v| v.as_object()) {
            for (_lang, value) in doc_map {
                if let Some(path) = value.as_str() {
                    entries.push((path.to_string(), plugin_dir.join(path)));
                }
            }
        }
    }

    // kbAssets 资源路径归一化后直接作为 ZIP 内路径。
    if let Some(items) = pkg_obj.get("kbAssets").and_then(|v| v.as_array()) {
        for raw in items.iter().filter_map(|v| v.as_str()) {
            if let Some(path) = core_plugin::assets::normalize_asset_path(raw) {
                entries.push((path.clone(), plugin_dir.join(path)));
            }
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

    // 按 ZIP 内路径排序后去重。
    //
    // 排序：条目顺序不再取决于 package.json 的字段 / kbDoc 语言键的书写顺序（serde_json 开了
    // preserve_order，map 是按文件顺序迭代的），包内布局固定、`unzip -l` 好读。顺序对读取端
    // 没有影响——加载一律走中央目录按名查找。
    //
    // 去重：多语言 kbDoc 会让同一张插图被每个语言的 doc 各收集一次（6 个语言 = 6 份），
    // 图标 / 模板等也可能被多个字段同时引用。重复条目在 zip 0.6 下只是白白撑大包体，
    // 到了 zip 8 会直接报 `Duplicate filename` 让打包失败。
    entries.sort_by(|(a, _), (b, _)| a.cmp(b));
    entries.dedup_by(|(a, _), (b, _)| a == b);

    // write ZIP
    let mut buf: Vec<u8> = Vec::new();
    {
        let cursor = std::io::Cursor::new(&mut buf);
        let mut zip = zip::ZipWriter::new(cursor);
        // mtime 必须显式钉成 1980-01-01（`DateTime::DEFAULT`），别用 `default()` 带来的那个：
        // zip 的 `default()` 走 `default_for_write()`，一旦依赖图里有人打开 zip 的 `time`
        // feature（feature 是叠加的，不需要我们自己开）就变成写入当前挂钟时间，同一份源码
        // 每次打出来的包就都不一样了。配合上面的排序，pack 的输出只由内容决定。
        let opt = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .last_modified_time(zip::DateTime::DEFAULT)
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
        ])
        .unwrap();
        let Commands::Data(DataCommands::ImportImage(args)) = cli.command else {
            panic!("expected data import-image");
        };
        assert_eq!(args.album.as_deref(), Some("/星穹铁道/萤"));
        assert!(Cli::try_parse_from([
            "kabegame-cli",
            "data",
            "import-image",
            "./a.png",
            "--metadata",
            "{}",
        ])
        .is_err());
    }

    #[test]
    fn test_via_is_global() {
        let cli = Cli::try_parse_from([
            "kabegame-cli",
            "data",
            "import-image",
            "./a.png",
            "--via",
            "local",
        ])
        .unwrap();
        assert_eq!(cli.via, Via::Local);
    }

    #[test]
    fn test_pathql_query_parse_modes() {
        for args in [
            vec!["kabegame-cli", "pathql", "query", "images://gallery/all"],
            vec!["kabegame-cli", "pathql", "query", "p", "--list"],
            vec![
                "kabegame-cli",
                "pathql",
                "query",
                "p",
                "--list",
                "--with-count",
            ],
            vec!["kabegame-cli", "pathql", "query", "p", "--entry"],
            vec!["kabegame-cli", "pathql", "query", "p", "--fetch"],
        ] {
            assert!(Cli::try_parse_from(args).is_ok());
        }

        let cli = Cli::try_parse_from(["kabegame-cli", "pathql", "query", "images://gallery/all"])
            .unwrap();
        let Commands::Pathql(PathqlCommands::Query(args)) = cli.command else {
            panic!("expected pathql query");
        };
        assert!(!args.list && !args.entry && !args.fetch && !args.with_count);
    }

    #[test]
    fn test_pathql_generate_parse_defaults() {
        let cli = Cli::try_parse_from(["kabegame-cli", "pathql", "generate", "--out", "client.ts"])
            .unwrap();
        let Commands::Pathql(PathqlCommands::Generate(args)) = cli.command else {
            panic!("expected pathql generate");
        };
        assert_eq!(args.target, GenerateTarget::TypeScript);
        assert_eq!(args.out, PathBuf::from("client.ts"));
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
        let cli =
            Cli::try_parse_from(["kabegame-cli", "plugin", "run", "x", "--max-downloads", "2"])
                .unwrap();
        let Commands::Plugin(PluginCommands::Run(args)) = cli.command else {
            panic!("expected plugin run");
        };
        assert_eq!(args.max_downloads, Some(2));
        assert!(Cli::try_parse_from([
            "kabegame-cli",
            "plugin",
            "run",
            "x",
            "--max-downloads",
            "0",
        ])
        .is_err());
    }

    #[test]
    fn test_task_concurrency_parse() {
        for (raw, expected) in [
            ("global", TaskConcurrencyValue::Global),
            ("3", TaskConcurrencyValue::Limit(3)),
        ] {
            let cli = Cli::try_parse_from(["kabegame-cli", "task", "concurrency", "task-id", raw])
                .unwrap();
            let Commands::Task(TaskCommands::Concurrency(args)) = cli.command else {
                panic!("expected task concurrency");
            };
            assert_eq!(args.task_id, "task-id");
            assert_eq!(args.value, expected);
        }
        assert!(
            Cli::try_parse_from(["kabegame-cli", "task", "concurrency", "task-id", "0",]).is_err()
        );
    }

    #[test]
    fn test_removed_and_invalid_commands_fail_to_parse() {
        for args in [
            vec!["kabegame-cli", "pathql", "query", "p", "--list", "--entry"],
            vec!["kabegame-cli", "pathql", "query", "p", "--fetch", "--list"],
            vec!["kabegame-cli", "pathql", "query", "p", "--with-count"],
            vec!["kabegame-cli", "data", "query", "p"],
            vec!["kabegame-cli", "pathql", "generate"],
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

    /// elsif 只有第一个命中的分支该输出。曾经按「本层是否已命中」判断要不要输出，
    /// 导致 v8 分支和 webview 分支一起写出去（生成的 tsconfig.json 是两个拼起来的 JSON）。
    #[test]
    fn test_render_liquid_elsif_takes_only_first_match() {
        let mut vars = HashMap::new();
        vars.insert("backend".to_string(), "v8".to_string());

        let tmpl = "{% if backend == \"v8\" %}A{% elsif backend == \"webview\" %}B{% endif %}";
        assert_eq!(render_liquid_template(tmpl, &vars).unwrap(), "A");

        vars.insert("backend".to_string(), "webview".to_string());
        assert_eq!(render_liquid_template(tmpl, &vars).unwrap(), "B");
    }

    /// `{%- ... %}` / `{% ... -%}` 要被认成普通标签（只是多吃掉周围空白）。曾经因为
    /// `- if` 不匹配 `if ` 而把整条标签当未知内容跳过，if / else 两边都被写出去。
    #[test]
    fn test_render_liquid_whitespace_control() {
        let mut vars = HashMap::new();
        vars.insert("backend".to_string(), "v8".to_string());

        let tmpl = "head\n{%- if backend == \"v8\" %},v8{%- else %},web{%- endif %}\ntail";
        assert_eq!(
            render_liquid_template(tmpl, &vars).unwrap(),
            "head,v8\ntail"
        );

        let trim_after = "a{% if backend == \"v8\" -%}   \n  b{% endif %}";
        assert_eq!(render_liquid_template(trim_after, &vars).unwrap(), "ab");
    }

    #[test]
    fn test_render_liquid_rejects_broken_template() {
        let mut vars = HashMap::new();
        vars.insert("backend".to_string(), "v8".to_string());

        // 不认识的标签 / 条件 / 未闭合的 if 都要报错，不能静默生成坏文件。
        assert!(render_liquid_template("{% for x in y %}{% endfor %}", &vars).is_err());
        assert!(render_liquid_template("{% if nope %}x{% endif %}", &vars).is_err());
        assert!(render_liquid_template("{% if backend == \"v8\" %}x", &vars).is_err());
        assert!(render_liquid_template("{% endif %}", &vars).is_err());
    }

    /// 模板目录要按原样展开。include_dir 的 `path()` 已经是相对模板根的完整路径，
    /// 曾经再拼一层父前缀，写出了 `src/src/index.ts`、`docs/docs/doc.md`。
    fn render_template_to_temp(backend: &str) -> (PathBuf, Vec<String>) {
        let out_dir = std::env::temp_dir().join(format!(
            "kabegame-cli-template-{backend}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&out_dir);
        std::fs::create_dir_all(&out_dir).unwrap();

        let cargo_gen_toml = TEMPLATE_DIR
            .get_file("cargo-generate.toml")
            .and_then(|f| f.contents_utf8())
            .unwrap();
        let ignored = parse_cargo_generate_conditions(cargo_gen_toml, backend).unwrap();
        let mut vars = HashMap::new();
        vars.insert("project-name".to_string(), "my-plugin".to_string());
        vars.insert("backend".to_string(), backend.to_string());
        write_template_files(&TEMPLATE_DIR, &out_dir, &vars, &ignored).unwrap();

        let mut files = Vec::new();
        let mut stack = vec![out_dir.clone()];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    stack.push(path);
                } else {
                    files.push(
                        path.strip_prefix(&out_dir)
                            .unwrap()
                            .to_string_lossy()
                            .replace('\\', "/"),
                    );
                }
            }
        }
        files.sort();
        (out_dir, files)
    }

    #[test]
    fn test_write_template_files_v8_layout() {
        let (out_dir, files) = render_template_to_temp("v8");
        assert_eq!(
            files,
            vec![
                ".gitignore",
                "docs/doc.md",
                "icon.png",
                "package.json",
                "rspack.config.mjs",
                "src/index.ts",
                "tsconfig.json",
            ]
        );
        for name in ["package.json", "tsconfig.json"] {
            let raw = std::fs::read_to_string(out_dir.join(name)).unwrap();
            let json: serde_json::Value = serde_json::from_str(&raw)
                .unwrap_or_else(|e| panic!("生成的 {name} 不是合法 JSON: {e}\n{raw}"));
            if name == "package.json" {
                assert_eq!(json["name"], "my-plugin");
                assert_eq!(json["kbBackend"], "v8");
                assert_eq!(json["main"], "dist/main.js");
            }
        }
        std::fs::remove_dir_all(&out_dir).unwrap();
    }

    #[test]
    fn test_write_template_files_webview_layout() {
        let (out_dir, files) = render_template_to_temp("webview");
        assert_eq!(
            files,
            vec![
                ".gitignore",
                "crawl.js",
                "docs/doc.md",
                "icon.png",
                "package.json",
                "tsconfig.json",
            ]
        );
        let pkg: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(out_dir.join("package.json")).unwrap())
                .unwrap();
        assert_eq!(pkg["kbBackend"], "webview");
        assert_eq!(pkg["main"], "crawl.js");
        let ts = std::fs::read_to_string(out_dir.join("tsconfig.json")).unwrap();
        let ts: serde_json::Value = serde_json::from_str(&ts).unwrap();
        assert_eq!(ts["include"][0], "crawl.js");
        std::fs::remove_dir_all(&out_dir).unwrap();
    }

    /// 造一个最小可打包的 v3 插件目录：name 必须等于目录名与输出 stem（pack 的 P3-7 校验）。
    fn write_minimal_plugin(dir: &Path, name: &str) {
        std::fs::create_dir_all(dir.join("docs")).unwrap();
        std::fs::create_dir_all(dir.join("dist")).unwrap();
        // 字段故意不按字母序写，且 kbDoc 的语言键也乱序：验证包内顺序不随书写顺序漂移。
        std::fs::write(
            dir.join("package.json"),
            format!(
                r#"{{
  "name": "{name}",
  "version": "1.0.0",
  "engines": {{ "kabegame": ">=4.3.0" }},
  "kbPackageVersion": 3,
  "kbBackend": "v8",
  "main": "dist/main.js",
  "kbDoc": {{ "zhtw": "docs/zhtw.md", "default": "docs/doc.md", "en": "docs/en.md" }}
}}"#
            ),
        )
        .unwrap();
        std::fs::write(
            dir.join("dist/main.js"),
            "export async function crawl() {}\n",
        )
        .unwrap();
        for f in ["doc.md", "en.md", "zhtw.md"] {
            std::fs::write(dir.join("docs").join(f), format!("# {f}\n")).unwrap();
        }
    }

    fn zip_entry_names(kgpg: &Path) -> Vec<String> {
        let bytes = std::fs::read(kgpg).unwrap();
        let offset = bytes
            .windows(4)
            .position(|w| w == [0x50, 0x4B, 0x03, 0x04])
            .expect("kgpg 里应当有 ZIP 段");
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(&bytes[offset..])).unwrap();
        (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_string())
            .collect()
    }

    /// 同一份源码打两次必须字节一致，且条目按字母序。
    ///
    /// 两个前提都靠 `collect_v3_entries` 自己保证：条目显式排序，mtime 显式钉成 1980-01-01。
    /// 后者尤其容易被破——zip 的 `FileOptions::default()` 在 `time` feature 打开时会写当前
    /// 挂钟时间，而 feature 是整个依赖图叠加的。
    #[test]
    fn test_pack_v3_is_byte_reproducible_and_sorted() {
        let base = std::env::temp_dir().join(format!("kabegame-cli-pack-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let plugin_dir = base.join("repro-plugin");
        write_minimal_plugin(&plugin_dir, "repro-plugin");

        let pkg = read_optional_package_json(&plugin_dir).unwrap().unwrap();
        let out_a = base.join("a/repro-plugin.kgpg");
        let out_b = base.join("b/repro-plugin.kgpg");
        pack_plugin_v3(&plugin_dir, &out_a, &pkg).unwrap();
        pack_plugin_v3(&plugin_dir, &out_b, &pkg).unwrap();

        assert_eq!(
            zip_entry_names(&out_a),
            vec![
                "dist/main.js",
                "docs/doc.md",
                "docs/en.md",
                "docs/zhtw.md",
                "package.json",
            ],
            "条目应按 ZIP 内路径字母序，而不是 package.json 的书写顺序"
        );
        assert_eq!(
            std::fs::read(&out_a).unwrap(),
            std::fs::read(&out_b).unwrap(),
            "同一份源码打两次应当字节一致"
        );

        std::fs::remove_dir_all(&base).unwrap();
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
