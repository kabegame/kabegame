//! Kabegame CLI（sidecar）
//!
//! 目前支持：
//! - `plugin run`：运行 Rhai 爬虫插件（支持通过插件 id 或 .kgpg 路径）
//!   - `--` 之后的参数会被解析并映射到插件 `config.json` 的 `var` 变量
//!   - required 规则：与前端一致，`default` 不存在即视为 required
//! - `plugin pack`：打包单个插件目录为 `.kgpg`（KGPG v2：固定头部 + ZIP，ZIP 内不含 icon.png）

use clap::{Args, Parser, Subcommand};
use kabegame::{
    crawler, kgpg,
    plugin::{PluginManager, VarDefinition},
    settings::Settings,
    storage::Storage,
};
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
}

#[derive(Subcommand, Debug)]
enum PluginCommands {
    /// 运行爬虫插件（Rhai）
    Run(RunPluginArgs),
    /// 打包单个插件目录为 `.kgpg`（KGPG v2：固定头部 + ZIP，ZIP 内不含 icon.png）
    Pack(PackPluginArgs),
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
            "",
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
