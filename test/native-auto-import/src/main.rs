//! 原生自动导入探针。
//!
//! 这是一个独立实验程序，用来在接入 Kabegame 主应用前，验证不同系统的原生本地媒体发现方案。
//!
//! 当前工作原理：
//! 1. 根据 `--backend` 选择 backend；`auto` 当前在 macOS 上默认使用 `mdfind`。
//! 2. 通过 `--backend` 选择 macOS Spotlight 接入方式：
//!    - `mdfind`：执行 `/usr/bin/mdfind -0 -onlyin <scope> <query>`，适合验证命令行行为。
//!    - `nsmetadata`：使用 Foundation 的 `NSMetadataQuery`，适合验证未来主应用内集成。
//!    两种 backend 默认都查询 `public.image`；开启 `--include-videos` 后额外查询
//!    `public.movie`。
//! 3. 原生索引器只负责“找路径”。Rust 侧继续做 Kabegame 导入前仍然需要的检查：
//!    规范化监听目录、处理已消失文件、过滤非普通文件、根据 mtime 判断文件是否已经稳定，
//!    避免把仍在写入的图片或视频提前交给导入流程。
//! 4. watch 模式按 backend 分两种：
//!    - `mdfind` 仍然用 `--poll` 间隔轮询 Spotlight 命令行结果。
//!    - `nsmetadata` 启动长生命周期 `NSMetadataQuery`，通过
//!      `NSMetadataQueryDidFinishGatheringNotification` 和
//!      `NSMetadataQueryDidUpdateNotification` 唤醒处理。启动时先做目录级预热；
//!      实时阶段只消费通知 `userInfo` 里的 added/changed/removed items，不按
//!      `--poll` 重复查询。
//!    首轮扫描默认只预热路径指纹缓存；除非开启 `--emit-initial`，否则不会把已有文件都
//!    当作新增候选输出。后续扫描比较 `(size, modified_time)` 指纹，发现新文件输出
//!    `new`，发现同一路径内容变化输出 `changed`。
//! 5. 探针不会真正导入文件，只打印“候选导入事件”和“扫描统计”。后续接入主应用时，
//!    这些候选路径才会进入 Kabegame 现有 local import / postprocess 流程。
//!
//! 输出格式：
//! - 默认文本模式：
//!   - 候选事件输出到 stdout：
//!     `[candidate] reason=<new|changed> size=<bytes> modified_unix_ms=<ms> stable_for_ms=<ms> path=<path>`
//!   - 扫描统计输出到 stderr：
//!     `[scan] hits=<n> stable=<n> detected=<n> printed=<n> unstable=<n> missing=<n> elapsed=<ms>ms`
//! - `--json` 模式：
//!   - 每行一个 JSON 对象，方便脚本消费，也就是 NDJSON。
//!   - 候选事件：
//!     `{"event":"candidate","reason":"new","path":"...","size":123,"modified_unix_ms":123,"stable_for_ms":123}`
//!   - 扫描统计：
//!     `{"event":"scan","hits":1,"stable":1,"detected":1,"printed":1,"skipped_unstable":0,"skipped_missing":0,"elapsed_ms":1}`
//!
//! backend 边界刻意保持很小：未来 Windows Everything、macOS FSEvents、
//! Linux Tracker 等 backend 可以替换路径发现或 watch 驱动，但应继续复用候选过滤和输出逻辑。

use std::collections::{HashMap, HashSet};
use std::env;
use std::ffi::OsString;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
#[cfg(target_os = "macos")]
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[cfg(target_os = "macos")]
use objc2::rc::{autoreleasepool, Retained};
#[cfg(target_os = "macos")]
use objc2::runtime::AnyObject;
#[cfg(target_os = "macos")]
use objc2::{define_class, msg_send, sel, AnyThread, DefinedClass};
#[cfg(target_os = "macos")]
use objc2_foundation::{
    NSArray, NSCompoundPredicate, NSDate, NSDictionary, NSMetadataItem,
    NSMetadataItemContentTypeTreeKey, NSMetadataItemPathKey, NSMetadataQuery,
    NSMetadataQueryDidFinishGatheringNotification, NSMetadataQueryDidUpdateNotification,
    NSMetadataQueryIndexedLocalComputerScope, NSMetadataQueryUpdateAddedItemsKey,
    NSMetadataQueryUpdateChangedItemsKey, NSMetadataQueryUpdateRemovedItemsKey, NSNotification,
    NSNotificationCenter, NSObject, NSObjectProtocol, NSPredicate, NSRunLoop, NSString,
};

const DEFAULT_POLL_SECONDS: u64 = 5;
const DEFAULT_STABLE_SECONDS: u64 = 3;
const DEFAULT_NSMETADATA_TIMEOUT_SECONDS: u64 = 10;
const NSMETADATA_EVENT_WARMUP_QUIET_SECONDS: u64 = 8;
const NSMETADATA_STARTUP_UPDATE_CATCHUP_THRESHOLD: usize = 10_000;

fn main() {
    match run() {
        Ok(()) => {}
        Err(err) => {
            eprintln!("error: {err}");
            eprintln!();
            print_usage();
            std::process::exit(1);
        }
    }
}

fn run() -> Result<(), ProbeError> {
    let config = Config::parse(env::args_os().skip(1))?;

    // --help 执行入口：只打印帮助并退出，不做平台探测和扫描。
    if config.help {
        print_usage();
        return Ok(());
    }

    let backend = Backend::for_choice(config.backend);

    // --print-query 执行入口：展示当前平台 backend 以及它会交给原生索引器的查询语句。
    if config.print_query {
        println!("backend={}", backend.name());
        println!("query={}", backend.query_text(config.include_videos));
    }

    let mut state = WatchState::default();

    // --once 执行入口：只做一次 scan，scan_once 内部继续消费 --scope/--stable/--limit/--json 等选项。
    if config.once {
        let report = scan_once(&backend, &config, &mut state, true)?;
        print_scan_report(&config, &report);
        return Ok(());
    }

    if backend.is_nsmetadata() {
        return run_nsmetadata_watch(&config, &mut state);
    }

    eprintln!(
        "watching with backend={} scopes={} poll={}s stable={}s",
        backend.name(),
        config
            .scopes
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(", "),
        config.poll.as_secs(),
        config.stable_for.as_secs()
    );

    let mut first = true;
    loop {
        // --emit-initial 执行入口：watch 模式首轮默认只预热指纹缓存；
        // 开启后首轮也会输出候选事件，便于模拟“启动即导入已存在文件”。
        let emit = !first || config.emit_initial;
        let report = scan_once(&backend, &config, &mut state, emit)?;
        print_scan_report(&config, &report);
        first = false;
        // --poll 执行入口：watch 模式每轮 mdfind polling 的间隔。
        thread::sleep(config.poll);
    }
}

fn scan_once(
    backend: &Backend,
    config: &Config,
    state: &mut WatchState,
    emit_candidates: bool,
) -> Result<ScanReport, ProbeError> {
    let started = Instant::now();
    // --scope 与 --include-videos 执行入口：
    // backend.query 会把所有 scope 传给原生索引器，并按 include_videos 决定查询图片或图片+视频。
    let paths = backend.query(
        &config.scopes,
        config.include_videos,
        config.nsmetadata_timeout,
    )?;
    let outcome = scan_paths(paths, config, state, emit_candidates, true, started)?;
    Ok(outcome.report)
}

fn scan_paths(
    paths: Vec<PathBuf>,
    config: &Config,
    state: &mut WatchState,
    emit_candidates: bool,
    retain_seen: bool,
    started: Instant,
) -> Result<ScanOutcome, ProbeError> {
    let mut seen_this_scan = HashSet::new();
    let mut stable_paths = Vec::new();
    let mut unstable_paths = Vec::new();
    let mut stable_count = 0usize;
    let mut detected = 0usize;
    let mut printed = 0usize;
    let mut skipped_unstable = 0usize;
    let mut skipped_missing = 0usize;

    for path in paths {
        if !seen_this_scan.insert(path.clone()) {
            continue;
        }

        // --stable 执行入口：只接受 mtime 足够旧的文件，避免导入仍在写入的媒体。
        let Some(candidate) = Candidate::from_path(&path, config.stable_for)? else {
            skipped_missing += 1;
            continue;
        };

        if !candidate.stable {
            skipped_unstable += 1;
            let retry_after = config
                .stable_for
                .saturating_sub(candidate.stable_age)
                .max(Duration::from_millis(100));
            unstable_paths.push((candidate.path, retry_after));
            continue;
        }
        stable_count += 1;
        stable_paths.push(candidate.path.clone());

        let reason = match state.fingerprints.get(&candidate.path) {
            None => ChangeReason::New,
            Some(old) if old != &candidate.fingerprint => ChangeReason::Changed,
            Some(_) => {
                state
                    .fingerprints
                    .insert(candidate.path.clone(), candidate.fingerprint.clone());
                continue;
            }
        };

        state
            .fingerprints
            .insert(candidate.path.clone(), candidate.fingerprint.clone());

        detected += 1;
        if emit_candidates {
            // --limit 执行入口：限制每轮实际打印的候选数量；detected 仍保留真实候选数。
            if config.limit.map_or(true, |limit| printed < limit) {
                // --json 执行入口之一：候选事件输出格式由 print_candidate 决定。
                print_candidate(config, &candidate, reason);
                printed += 1;
            }
        }
    }

    if retain_seen {
        state
            .fingerprints
            .retain(|path, _| seen_this_scan.contains(path));
    }

    Ok(ScanOutcome {
        report: ScanReport {
            hits: seen_this_scan.len(),
            stable: stable_count,
            detected,
            printed,
            skipped_unstable,
            skipped_missing,
            elapsed: started.elapsed(),
        },
        stable_paths,
        unstable_paths,
    })
}

fn print_scan_report(config: &Config, report: &ScanReport) {
    // --json 执行入口之一：扫描统计也使用 NDJSON，便于脚本消费。
    if config.json {
        println!(
            "{{\"event\":\"scan\",\"hits\":{},\"stable\":{},\"detected\":{},\"printed\":{},\"skipped_unstable\":{},\"skipped_missing\":{},\"elapsed_ms\":{}}}",
            report.hits,
            report.stable,
            report.detected,
            report.printed,
            report.skipped_unstable,
            report.skipped_missing,
            report.elapsed.as_millis()
        );
        return;
    }

    eprintln!(
        "[scan] hits={} stable={} detected={} printed={} unstable={} missing={} elapsed={}ms",
        report.hits,
        report.stable,
        report.detected,
        report.printed,
        report.skipped_unstable,
        report.skipped_missing,
        report.elapsed.as_millis()
    );
}

fn print_candidate(config: &Config, candidate: &Candidate, reason: ChangeReason) {
    // --json 执行入口之一：候选事件使用单行 JSON，后续可以直接接入导入队列测试脚本。
    if config.json {
        println!(
            "{{\"event\":\"candidate\",\"reason\":\"{}\",\"path\":\"{}\",\"size\":{},\"modified_unix_ms\":{},\"stable_for_ms\":{}}}",
            reason.as_str(),
            json_escape(&candidate.path.display().to_string()),
            candidate.fingerprint.len,
            system_time_unix_ms(candidate.fingerprint.modified),
            candidate.stable_age.as_millis()
        );
        return;
    }

    println!(
        "[candidate] reason={} size={} modified_unix_ms={} stable_for_ms={} path={}",
        reason.as_str(),
        candidate.fingerprint.len,
        system_time_unix_ms(candidate.fingerprint.modified),
        candidate.stable_age.as_millis(),
        candidate.path.display()
    );
}

fn print_usage() {
    eprintln!(
        "native-auto-import-probe

Usage:
  cargo run -- --scope <dir> [--scope <dir> ...] [options]

Options:
  --backend <name>    Native backend: auto, mdfind, nsmetadata. Default: auto.
  --scope <dir>       Directory to query through the native indexer; repeatable.
  --once              Run one scan and print stable candidates.
  --poll <seconds>    Poll interval for polling watch backends. Ignored by nsmetadata. Default: {DEFAULT_POLL_SECONDS}.
  --stable <seconds>  Required mtime age before a file is emitted. Default: {DEFAULT_STABLE_SECONDS}.
  --nsmetadata-timeout <seconds>
                      Max time to wait for NSMetadataQuery gathering. Default: {DEFAULT_NSMETADATA_TIMEOUT_SECONDS}.
  --include-videos    Include public.movie as well as public.image.
  --emit-initial      In watch mode, emit candidates from the first scan.
  --limit <n>         Limit printed candidates per scan.
  --json              Print newline-delimited JSON events.
  --print-query       Print backend query text.
  --help              Show this help.
"
    );
}

#[derive(Debug)]
struct Config {
    /// --backend <auto|mdfind|nsmetadata>
    /// 选择原生索引 backend。auto 当前在 macOS 上默认等价于 mdfind，用于保持旧行为。
    backend: BackendChoice,
    /// --scope <dir>
    /// 原生索引器的搜索范围。可重复传入多个目录；解析时会展开 `~` 并 canonicalize。
    scopes: Vec<PathBuf>,
    /// --once
    /// 单次扫描模式。开启后不会进入 watch loop。
    once: bool,
    /// --poll <seconds>
    /// --poll <seconds>
    /// 轮询型 watch backend 每轮扫描之间的等待时间；NSMetadataQuery 事件模式不使用它。
    poll: Duration,
    /// --stable <seconds>
    /// 文件最后修改时间距离当前时间至少达到该阈值后，才认为可导入。
    stable_for: Duration,
    /// --nsmetadata-timeout <seconds>
    /// NSMetadataQuery 初始 gathering 的最长等待时间；只对 --backend nsmetadata 生效。
    nsmetadata_timeout: Duration,
    /// --include-videos
    /// macOS mdfind 查询中额外包含 `public.movie`，默认只查 `public.image`。
    include_videos: bool,
    /// --emit-initial
    /// watch 模式首轮是否输出候选。默认首轮只建缓存，用于避免启动时把已有文件都当新增。
    emit_initial: bool,
    /// --limit <n>
    /// 每轮最多打印多少个候选事件。只限制输出，不影响 detected 统计。
    limit: Option<usize>,
    /// --json
    /// 使用 newline-delimited JSON 输出候选事件和扫描统计。
    json: bool,
    /// --print-query
    /// 打印当前 backend 与原生查询语句，方便调试 mdfind/Everything 查询表达式。
    print_query: bool,
    /// --help / -h
    /// 打印帮助并退出。
    help: bool,
}

impl Config {
    fn parse<I>(args: I) -> Result<Self, ProbeError>
    where
        I: IntoIterator<Item = OsString>,
    {
        let mut scopes = Vec::new();
        let mut backend = BackendChoice::Auto;
        let mut once = false;
        let mut poll = Duration::from_secs(DEFAULT_POLL_SECONDS);
        let mut stable_for = Duration::from_secs(DEFAULT_STABLE_SECONDS);
        let mut nsmetadata_timeout = Duration::from_secs(DEFAULT_NSMETADATA_TIMEOUT_SECONDS);
        let mut include_videos = false;
        let mut emit_initial = false;
        let mut limit = None;
        let mut json = false;
        let mut print_query = false;
        let mut help = false;

        let mut args = args.into_iter();
        while let Some(arg) = args.next() {
            let arg_str = arg.to_string_lossy();
            match arg_str.as_ref() {
                // --backend 解析入口：run() 会根据该值选择具体原生 backend。
                "--backend" => {
                    let value = next_arg(&mut args, "--backend")?;
                    backend = BackendChoice::parse(&value)?;
                }
                // --scope 解析入口：消费下一个参数作为目录，并规范化为真实目录路径。
                "--scope" => {
                    let value = next_arg(&mut args, "--scope")?;
                    scopes.push(normalize_scope(value)?);
                }
                // --once 解析入口：切换到单次扫描模式。
                "--once" => once = true,
                // --poll 解析入口：watch loop sleep 使用该秒数。
                "--poll" => {
                    let value = next_arg(&mut args, "--poll")?;
                    poll = Duration::from_secs(parse_u64(&value, "--poll")?);
                }
                // --stable 解析入口：scan_once 里用于过滤仍在写入的文件。
                "--stable" => {
                    let value = next_arg(&mut args, "--stable")?;
                    stable_for = Duration::from_secs(parse_u64(&value, "--stable")?);
                }
                // --nsmetadata-timeout 解析入口：NSMetadataQuery 后端等待 initial gathering 的上限。
                "--nsmetadata-timeout" => {
                    let value = next_arg(&mut args, "--nsmetadata-timeout")?;
                    nsmetadata_timeout =
                        Duration::from_secs(parse_u64(&value, "--nsmetadata-timeout")?);
                }
                // --include-videos 解析入口：backend 查询语句会扩展到视频 UTI。
                "--include-videos" => include_videos = true,
                // --emit-initial 解析入口：watch 模式首轮是否输出候选由 run() 决定。
                "--emit-initial" => emit_initial = true,
                // --limit 解析入口：scan_once 限制每轮 print_candidate 调用次数。
                "--limit" => {
                    let value = next_arg(&mut args, "--limit")?;
                    limit = Some(parse_usize(&value, "--limit")?);
                }
                // --json 解析入口：print_candidate / print_scan_report 会改为 NDJSON 输出。
                "--json" => json = true,
                // --print-query 解析入口：run() 在扫描前打印 backend 查询文本。
                "--print-query" => print_query = true,
                // --help 解析入口：run() 直接打印帮助并退出。
                "--help" | "-h" => help = true,
                other => return Err(ProbeError::Args(format!("unknown option: {other}"))),
            }
        }

        if !help && scopes.is_empty() {
            return Err(ProbeError::Args(
                "at least one --scope is required".to_string(),
            ));
        }

        Ok(Self {
            backend,
            scopes,
            once,
            poll,
            stable_for,
            nsmetadata_timeout,
            include_videos,
            emit_initial,
            limit,
            json,
            print_query,
            help,
        })
    }
}

fn next_arg<I>(args: &mut I, name: &str) -> Result<OsString, ProbeError>
where
    I: Iterator<Item = OsString>,
{
    args.next()
        .ok_or_else(|| ProbeError::Args(format!("{name} requires a value")))
}

fn parse_u64(value: &OsString, name: &str) -> Result<u64, ProbeError> {
    value
        .to_string_lossy()
        .parse::<u64>()
        .map_err(|_| ProbeError::Args(format!("{name} must be an integer")))
}

fn parse_usize(value: &OsString, name: &str) -> Result<usize, ProbeError> {
    value
        .to_string_lossy()
        .parse::<usize>()
        .map_err(|_| ProbeError::Args(format!("{name} must be an integer")))
}

#[derive(Debug, Clone, Copy)]
enum BackendChoice {
    Auto,
    Mdfind,
    NsMetadata,
}

impl BackendChoice {
    fn parse(value: &OsString) -> Result<Self, ProbeError> {
        match value.to_string_lossy().as_ref() {
            "auto" => Ok(Self::Auto),
            "mdfind" => Ok(Self::Mdfind),
            "nsmetadata" | "ns-metadata" | "NSMetadataQuery" => Ok(Self::NsMetadata),
            other => Err(ProbeError::Args(format!(
                "--backend must be one of auto, mdfind, nsmetadata; got {other}"
            ))),
        }
    }
}

fn normalize_scope(value: OsString) -> Result<PathBuf, ProbeError> {
    let raw = value.to_string_lossy();
    let expanded = if raw == "~" {
        home_dir().ok_or_else(|| ProbeError::Args("cannot resolve home directory".to_string()))?
    } else if let Some(rest) = raw.strip_prefix("~/") {
        home_dir()
            .ok_or_else(|| ProbeError::Args("cannot resolve home directory".to_string()))?
            .join(rest)
    } else {
        PathBuf::from(raw.as_ref())
    };

    let canonical = fs::canonicalize(&expanded)
        .map_err(|e| ProbeError::Io(format!("invalid scope {}: {e}", expanded.display())))?;
    if !canonical.is_dir() {
        return Err(ProbeError::Args(format!(
            "scope is not a directory: {}",
            canonical.display()
        )));
    }
    Ok(canonical)
}

fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME").map(PathBuf::from)
}

#[derive(Default)]
struct WatchState {
    fingerprints: HashMap<PathBuf, FileFingerprint>,
}

struct ScanReport {
    hits: usize,
    stable: usize,
    detected: usize,
    printed: usize,
    skipped_unstable: usize,
    skipped_missing: usize,
    elapsed: Duration,
}

struct ScanOutcome {
    report: ScanReport,
    stable_paths: Vec<PathBuf>,
    unstable_paths: Vec<(PathBuf, Duration)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FileFingerprint {
    len: u64,
    modified: SystemTime,
}

#[derive(Debug)]
struct Candidate {
    path: PathBuf,
    fingerprint: FileFingerprint,
    stable: bool,
    stable_age: Duration,
}

impl Candidate {
    fn from_path(path: &Path, stable_for: Duration) -> Result<Option<Self>, ProbeError> {
        let metadata = match fs::metadata(path) {
            Ok(metadata) => metadata,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(err) => {
                return Err(ProbeError::Io(format!(
                    "failed to read metadata for {}: {err}",
                    path.display()
                )))
            }
        };
        if !metadata.is_file() {
            return Ok(None);
        }
        let modified = metadata.modified().map_err(|e| {
            ProbeError::Io(format!(
                "failed to read modified time for {}: {e}",
                path.display()
            ))
        })?;
        let stable_age = SystemTime::now()
            .duration_since(modified)
            .unwrap_or_else(|_| Duration::from_secs(0));
        Ok(Some(Self {
            path: path.to_path_buf(),
            fingerprint: FileFingerprint {
                len: metadata.len(),
                modified,
            },
            stable: stable_age >= stable_for,
            stable_age,
        }))
    }
}

#[derive(Debug, Clone, Copy)]
enum ChangeReason {
    New,
    Changed,
}

impl ChangeReason {
    fn as_str(self) -> &'static str {
        match self {
            ChangeReason::New => "new",
            ChangeReason::Changed => "changed",
        }
    }
}

enum Backend {
    Mdfind,
    NsMetadata,
    Unsupported,
}

impl Backend {
    fn for_choice(choice: BackendChoice) -> Self {
        match choice {
            BackendChoice::Auto => {
                if cfg!(target_os = "macos") {
                    Self::Mdfind
                } else {
                    Self::Unsupported
                }
            }
            BackendChoice::Mdfind => {
                if cfg!(target_os = "macos") {
                    Self::Mdfind
                } else {
                    Self::Unsupported
                }
            }
            BackendChoice::NsMetadata => {
                if cfg!(target_os = "macos") {
                    Self::NsMetadata
                } else {
                    Self::Unsupported
                }
            }
        }
    }

    fn name(&self) -> &'static str {
        match self {
            Self::Mdfind => "macos-mdfind",
            Self::NsMetadata => "macos-nsmetadata",
            Self::Unsupported => "unsupported",
        }
    }

    fn is_nsmetadata(&self) -> bool {
        matches!(self, Self::NsMetadata)
    }

    fn query_text(&self, include_videos: bool) -> String {
        // --print-query 执行入口：该方法只返回原生查询文本，不真正执行扫描。
        match self {
            Self::Mdfind => mdfind_query(include_videos),
            Self::NsMetadata => spotlight_query(include_videos),
            Self::Unsupported => "<unsupported platform>".to_string(),
        }
    }

    fn query(
        &self,
        scopes: &[PathBuf],
        include_videos: bool,
        nsmetadata_timeout: Duration,
    ) -> Result<Vec<PathBuf>, ProbeError> {
        // --scope / --include-videos 执行入口：按当前平台分发到具体原生索引 backend。
        match self {
            Self::Mdfind => query_mdfind(scopes, include_videos),
            #[cfg(target_os = "macos")]
            Self::NsMetadata => query_nsmetadata(scopes, include_videos, nsmetadata_timeout),
            #[cfg(not(target_os = "macos"))]
            Self::NsMetadata => Err(ProbeError::Unsupported(
                "NSMetadataQuery backend is only available on macOS".to_string(),
            )),
            Self::Unsupported => Err(ProbeError::Unsupported(
                "only macOS native backends are implemented in this probe".to_string(),
            )),
        }
    }
}

fn spotlight_query(include_videos: bool) -> String {
    // --include-videos 执行入口：决定 Spotlight UTI 查询是否包含视频。
    if include_videos {
        "(kMDItemContentTypeTree == \"public.image\" || kMDItemContentTypeTree == \"public.movie\")"
            .to_string()
    } else {
        "kMDItemContentTypeTree == \"public.image\"".to_string()
    }
}

fn mdfind_query(include_videos: bool) -> String {
    spotlight_query(include_videos)
}

fn query_mdfind(scopes: &[PathBuf], include_videos: bool) -> Result<Vec<PathBuf>, ProbeError> {
    let query = mdfind_query(include_videos);
    let mut results = Vec::new();

    for scope in scopes {
        // --scope 执行入口：每个 scope 对应一次 `mdfind -onlyin <scope>`。
        // `-0` 使用 NUL 分隔路径，避免空格、换行等文件名破坏输出解析。
        let output = Command::new("/usr/bin/mdfind")
            .arg("-0")
            .arg("-onlyin")
            .arg(scope)
            .arg(&query)
            .output()
            .map_err(|e| ProbeError::Io(format!("failed to run mdfind: {e}")))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(ProbeError::Backend(format!(
                "mdfind failed for {}: {}",
                scope.display(),
                stderr.trim()
            )));
        }

        for part in output.stdout.split(|b| *b == 0) {
            if part.is_empty() {
                continue;
            }
            let path = String::from_utf8_lossy(part);
            results.push(PathBuf::from(path.as_ref()));
        }
    }

    Ok(results)
}

#[cfg(target_os = "macos")]
enum NsMetadataWatchSignal {
    InitialGathered,
    Updated(NsMetadataUpdatePaths),
}

#[cfg(target_os = "macos")]
#[derive(Clone, Copy)]
enum NsMetadataNotificationKind {
    InitialGathered,
    Updated,
}

#[cfg(target_os = "macos")]
#[derive(Default)]
struct NsMetadataUpdatePaths {
    changed_or_added: Vec<PathBuf>,
    removed: Vec<PathBuf>,
}

#[cfg(target_os = "macos")]
struct NsMetadataNotificationObserverIvars {
    sender: mpsc::Sender<NsMetadataWatchSignal>,
    kind: NsMetadataNotificationKind,
}

#[cfg(target_os = "macos")]
define_class!(
    // SAFETY: The observer only forwards Foundation notifications into an mpsc channel.
    #[unsafe(super(NSObject))]
    #[ivars = NsMetadataNotificationObserverIvars]
    struct NsMetadataNotificationObserver;

    impl NsMetadataNotificationObserver {
        #[unsafe(method(handleNotification:))]
        fn handle_notification(&self, notification: &NSNotification) {
            let signal = match self.ivars().kind {
                NsMetadataNotificationKind::InitialGathered => NsMetadataWatchSignal::InitialGathered,
                NsMetadataNotificationKind::Updated => {
                    NsMetadataWatchSignal::Updated(nsmetadata_update_paths_from_notification(notification))
                }
            };
            let _ = self.ivars().sender.send(signal);
        }
    }

    unsafe impl NSObjectProtocol for NsMetadataNotificationObserver {}
);

#[cfg(target_os = "macos")]
impl NsMetadataNotificationObserver {
    fn new(
        sender: mpsc::Sender<NsMetadataWatchSignal>,
        kind: NsMetadataNotificationKind,
    ) -> Retained<Self> {
        let observer =
            Self::alloc().set_ivars(NsMetadataNotificationObserverIvars { sender, kind });
        unsafe { msg_send![super(observer), init] }
    }
}

#[cfg(target_os = "macos")]
struct PendingRetry {
    due_at: Instant,
    emit: bool,
}

#[cfg(target_os = "macos")]
#[derive(Clone, Copy)]
enum NsMetadataScopeMode {
    DirectPaths,
    IndexedLocalComputer,
}

#[cfg(target_os = "macos")]
fn run_nsmetadata_watch(config: &Config, state: &mut WatchState) -> Result<(), ProbeError> {
    autoreleasepool(|_| {
        let mut pending = HashMap::new();
        handle_nsmetadata_direct_scan(config, state, config.emit_initial, &mut pending)?;

        let query = create_nsmetadata_query(
            &config.scopes,
            config.include_videos,
            NsMetadataScopeMode::IndexedLocalComputer,
        )?;
        let (tx, rx) = mpsc::channel();
        let finish_observer = NsMetadataNotificationObserver::new(
            tx.clone(),
            NsMetadataNotificationKind::InitialGathered,
        );
        let update_observer =
            NsMetadataNotificationObserver::new(tx, NsMetadataNotificationKind::Updated);

        let center = NSNotificationCenter::defaultCenter();
        let query_object = nsmetadata_query_as_any(&query);
        unsafe {
            center.addObserver_selector_name_object(
                nsmetadata_observer_as_any(&finish_observer),
                sel!(handleNotification:),
                Some(NSMetadataQueryDidFinishGatheringNotification),
                Some(query_object),
            );
            center.addObserver_selector_name_object(
                nsmetadata_observer_as_any(&update_observer),
                sel!(handleNotification:),
                Some(NSMetadataQueryDidUpdateNotification),
                Some(query_object),
            );
        }

        if !query.startQuery() {
            unsafe {
                center.removeObserver(nsmetadata_observer_as_any(&finish_observer));
                center.removeObserver(nsmetadata_observer_as_any(&update_observer));
            }
            return Err(ProbeError::Backend(
                "NSMetadataQuery failed to start".to_string(),
            ));
        }

        eprintln!(
            "watching with backend={} scopes={} mode=event stable={}s nsmetadata_timeout={}s",
            Backend::NsMetadata.name(),
            config
                .scopes
                .iter()
                .map(|p| p.display().to_string())
                .collect::<Vec<_>>()
                .join(", "),
            config.stable_for.as_secs(),
            config.nsmetadata_timeout.as_secs()
        );

        let run_loop = NSRunLoop::currentRunLoop();
        let warmup_started = Instant::now();
        let mut warmup_last_update = warmup_started;
        let mut event_ready = false;
        let mut performed_large_update_catchup = false;

        loop {
            let limit_date = nsmetadata_run_loop_limit_date(&pending);
            run_loop.runUntilDate(&limit_date);

            let mut changed_or_added = Vec::new();
            let mut removed = Vec::new();
            while let Ok(signal) = rx.try_recv() {
                match signal {
                    NsMetadataWatchSignal::Updated(paths) if event_ready => {
                        changed_or_added.extend(paths.changed_or_added);
                        removed.extend(paths.removed);
                    }
                    NsMetadataWatchSignal::Updated(_) if !event_ready => {
                        warmup_last_update = Instant::now();
                    }
                    _ => {}
                }
            }

            if !event_ready {
                let now = Instant::now();
                let quiet = now.duration_since(warmup_last_update)
                    >= Duration::from_secs(NSMETADATA_EVENT_WARMUP_QUIET_SECONDS);
                let timed_out = now.duration_since(warmup_started) >= config.nsmetadata_timeout;
                if quiet || timed_out {
                    handle_nsmetadata_direct_scan(config, state, false, &mut pending)?;
                    while rx.try_recv().is_ok() {}
                    event_ready = true;
                }
            } else if !changed_or_added.is_empty() || !removed.is_empty() {
                let update_path_count = changed_or_added.len() + removed.len();
                if update_path_count >= NSMETADATA_STARTUP_UPDATE_CATCHUP_THRESHOLD {
                    if !performed_large_update_catchup {
                        handle_nsmetadata_direct_scan(config, state, false, &mut pending)?;
                        performed_large_update_catchup = true;
                    }
                    process_due_nsmetadata_retries(config, state, &mut pending)?;
                    continue;
                }

                handle_nsmetadata_incremental(
                    changed_or_added,
                    removed,
                    config,
                    state,
                    &mut pending,
                )?;
            }

            process_due_nsmetadata_retries(config, state, &mut pending)?;
        }
    })
}

#[cfg(not(target_os = "macos"))]
fn run_nsmetadata_watch(_config: &Config, _state: &mut WatchState) -> Result<(), ProbeError> {
    Err(ProbeError::Unsupported(
        "NSMetadataQuery backend is only available on macOS".to_string(),
    ))
}

#[cfg(target_os = "macos")]
fn query_nsmetadata(
    scopes: &[PathBuf],
    include_videos: bool,
    timeout: Duration,
) -> Result<Vec<PathBuf>, ProbeError> {
    autoreleasepool(|_| {
        let query =
            create_nsmetadata_query(scopes, include_videos, NsMetadataScopeMode::DirectPaths)?;

        if !query.startQuery() {
            return Err(ProbeError::Backend(
                "NSMetadataQuery failed to start".to_string(),
            ));
        }

        if let Err(err) = wait_nsmetadata_query(&query, timeout) {
            query.stopQuery();
            return Err(err);
        }

        let results = nsmetadata_paths_from_query(&query, scopes);
        query.stopQuery();

        Ok(results)
    })
}

#[cfg(target_os = "macos")]
fn create_nsmetadata_query(
    scopes: &[PathBuf],
    include_videos: bool,
    scope_mode: NsMetadataScopeMode,
) -> Result<Retained<NSMetadataQuery>, ProbeError> {
    let predicate = nsmetadata_predicate(include_videos)?;
    let query = NSMetadataQuery::new();
    query.setPredicate(Some(&predicate));
    query.setNotificationBatchingInterval(0.2);

    match scope_mode {
        NsMetadataScopeMode::DirectPaths => {
            let scope_strings = nsmetadata_search_scopes(scopes);
            let search_scopes = NSArray::from_retained_slice(&scope_strings);
            // --scope 执行入口（NSMetadataQuery once）：searchScopes 传入目录路径字符串，
            // Foundation 会把初始查询限制在这些目录下，语义接近 `mdfind -onlyin <scope>`。
            unsafe {
                query.setSearchScopes(search_scopes.cast_unchecked::<AnyObject>());
            }
        }
        NsMetadataScopeMode::IndexedLocalComputer => {
            let indexed_scope = unsafe { NSMetadataQueryIndexedLocalComputerScope };
            let search_scopes = NSArray::from_slice(&[indexed_scope]);
            // NSMetadataQuery 对具体目录 scope 能做初始查询，但在 CLI probe 中不会稳定推送
            // DidUpdate；watch 模式用本地已索引范围接收事件，再按 --scope 过滤路径。
            unsafe {
                query.setSearchScopes(search_scopes.cast_unchecked::<AnyObject>());
            }
        }
    }

    Ok(query)
}

#[cfg(target_os = "macos")]
fn handle_nsmetadata_direct_scan(
    config: &Config,
    state: &mut WatchState,
    emit_candidates: bool,
    pending: &mut HashMap<PathBuf, PendingRetry>,
) -> Result<(), ProbeError> {
    let started = Instant::now();
    let paths = query_nsmetadata(
        &config.scopes,
        config.include_videos,
        config.nsmetadata_timeout,
    )?;
    let outcome = scan_paths(paths, config, state, emit_candidates, true, started)?;
    print_scan_report(config, &outcome.report);
    update_nsmetadata_pending(pending, outcome, emit_candidates);
    Ok(())
}

#[cfg(target_os = "macos")]
fn handle_nsmetadata_incremental(
    changed_or_added: Vec<PathBuf>,
    removed: Vec<PathBuf>,
    config: &Config,
    state: &mut WatchState,
    pending: &mut HashMap<PathBuf, PendingRetry>,
) -> Result<(), ProbeError> {
    for path in removed {
        if path_in_scopes(&path, &config.scopes) {
            state.fingerprints.remove(&path);
            pending.remove(&path);
        }
    }

    let paths = changed_or_added
        .into_iter()
        .filter(|path| path_in_scopes(path, &config.scopes))
        .collect::<Vec<_>>();
    if paths.is_empty() {
        return Ok(());
    }

    let outcome = scan_paths(paths, config, state, true, false, Instant::now())?;
    print_scan_report(config, &outcome.report);
    update_nsmetadata_pending(pending, outcome, true);
    Ok(())
}

#[cfg(target_os = "macos")]
fn process_due_nsmetadata_retries(
    config: &Config,
    state: &mut WatchState,
    pending: &mut HashMap<PathBuf, PendingRetry>,
) -> Result<(), ProbeError> {
    let now = Instant::now();
    let due = pending
        .iter()
        .filter(|(_, retry)| retry.due_at <= now)
        .map(|(path, retry)| (path.clone(), retry.emit))
        .collect::<Vec<_>>();

    if due.is_empty() {
        return Ok(());
    }

    for (path, _) in &due {
        pending.remove(path);
    }

    let mut warm_paths = Vec::new();
    let mut emit_paths = Vec::new();
    for (path, emit) in due {
        if emit {
            emit_paths.push(path);
        } else {
            warm_paths.push(path);
        }
    }

    if !warm_paths.is_empty() {
        let outcome = scan_paths(warm_paths, config, state, false, false, Instant::now())?;
        print_scan_report(config, &outcome.report);
        update_nsmetadata_pending(pending, outcome, false);
    }

    if !emit_paths.is_empty() {
        let outcome = scan_paths(emit_paths, config, state, true, false, Instant::now())?;
        print_scan_report(config, &outcome.report);
        update_nsmetadata_pending(pending, outcome, true);
    }

    Ok(())
}

#[cfg(target_os = "macos")]
fn update_nsmetadata_pending(
    pending: &mut HashMap<PathBuf, PendingRetry>,
    outcome: ScanOutcome,
    emit_candidates: bool,
) {
    for path in outcome.stable_paths {
        pending.remove(&path);
    }

    let now = Instant::now();
    for (path, retry_after) in outcome.unstable_paths {
        let due_at = now + retry_after;
        pending
            .entry(path)
            .and_modify(|retry| {
                if due_at < retry.due_at {
                    retry.due_at = due_at;
                }
                retry.emit |= emit_candidates;
            })
            .or_insert(PendingRetry {
                due_at,
                emit: emit_candidates,
            });
    }
}

#[cfg(target_os = "macos")]
fn nsmetadata_run_loop_limit_date(pending: &HashMap<PathBuf, PendingRetry>) -> Retained<NSDate> {
    let now = Instant::now();
    let wait = pending
        .values()
        .map(|retry| retry.due_at.saturating_duration_since(now))
        .min()
        .unwrap_or_else(|| Duration::from_millis(250))
        .min(Duration::from_millis(250))
        .max(Duration::from_millis(10));
    NSDate::dateWithTimeIntervalSinceNow(wait.as_secs_f64())
}

#[cfg(target_os = "macos")]
fn nsmetadata_query_as_any(query: &NSMetadataQuery) -> &AnyObject {
    unsafe { &*(query as *const NSMetadataQuery).cast::<AnyObject>() }
}

#[cfg(target_os = "macos")]
fn nsmetadata_observer_as_any(observer: &NsMetadataNotificationObserver) -> &AnyObject {
    unsafe { &*(observer as *const NsMetadataNotificationObserver).cast::<AnyObject>() }
}

#[cfg(target_os = "macos")]
fn nsmetadata_update_paths_from_notification(
    notification: &NSNotification,
) -> NsMetadataUpdatePaths {
    let mut paths = NsMetadataUpdatePaths::default();
    let Some(user_info) = notification.userInfo() else {
        return paths;
    };

    let added_key = unsafe { NSMetadataQueryUpdateAddedItemsKey };
    let changed_key = unsafe { NSMetadataQueryUpdateChangedItemsKey };
    let removed_key = unsafe { NSMetadataQueryUpdateRemovedItemsKey };
    append_nsmetadata_item_paths_for_key(&user_info, added_key, &mut paths.changed_or_added);
    append_nsmetadata_item_paths_for_key(&user_info, changed_key, &mut paths.changed_or_added);
    append_nsmetadata_item_paths_for_key(&user_info, removed_key, &mut paths.removed);
    paths
}

#[cfg(target_os = "macos")]
fn append_nsmetadata_item_paths_for_key(
    user_info: &NSDictionary,
    key: &NSString,
    paths: &mut Vec<PathBuf>,
) {
    let Some(value) = user_info.objectForKey(nsstring_as_any(key)) else {
        return;
    };
    let Ok(items) = value.downcast::<NSArray>() else {
        return;
    };

    for idx in 0..items.count() {
        let item = items.objectAtIndex(idx);
        let Ok(item) = item.downcast::<NSMetadataItem>() else {
            continue;
        };
        if let Some(path) = nsmetadata_item_path(&item) {
            paths.push(path);
        }
    }
}

#[cfg(target_os = "macos")]
fn nsstring_as_any(value: &NSString) -> &AnyObject {
    unsafe { &*(value as *const NSString).cast::<AnyObject>() }
}

#[cfg(target_os = "macos")]
fn nsmetadata_paths_from_query(query: &NSMetadataQuery, scopes: &[PathBuf]) -> Vec<PathBuf> {
    autoreleasepool(|_| {
        query.disableUpdates();
        let mut results = Vec::new();
        let count = query.resultCount();
        for idx in 0..count {
            let item = query.resultAtIndex(idx);
            let Ok(item) = item.downcast::<NSMetadataItem>() else {
                continue;
            };
            if let Some(path) = nsmetadata_item_path(&item) {
                if path_in_scopes(&path, scopes) {
                    results.push(path);
                }
            }
        }
        query.enableUpdates();
        results
    })
}

#[cfg(target_os = "macos")]
fn nsmetadata_item_path(item: &NSMetadataItem) -> Option<PathBuf> {
    let path_key = unsafe { NSMetadataItemPathKey };
    let value = item.valueForAttribute(path_key)?;
    let path = value.downcast::<NSString>().ok()?;
    let path_string = nsstring_to_string(&path);
    if path_string.is_empty() {
        None
    } else {
        Some(PathBuf::from(path_string))
    }
}

#[cfg(target_os = "macos")]
fn nsmetadata_search_scopes(scopes: &[PathBuf]) -> Vec<Retained<NSString>> {
    scopes
        .iter()
        .map(|scope| NSString::from_str(scope.to_string_lossy().as_ref()))
        .collect()
}

#[cfg(target_os = "macos")]
fn wait_nsmetadata_query(query: &NSMetadataQuery, timeout: Duration) -> Result<(), ProbeError> {
    let run_loop = NSRunLoop::currentRunLoop();
    let started = Instant::now();
    let mut gathering_finished_at = None;
    let mut last_count = query.resultCount();
    let mut count_stable_since = Instant::now();

    loop {
        let limit_date = NSDate::dateWithTimeIntervalSinceNow(0.05);
        run_loop.runUntilDate(&limit_date);

        let now = Instant::now();
        let count = query.resultCount();
        if count != last_count {
            last_count = count;
            count_stable_since = now;
        }

        // NSMetadataQuery 的 initial gathering 结束后，结果数组仍可能在接下来的
        // run loop tick 中补齐；这里等待一小段 drain + resultCount 稳定后再读取。
        if !query.isGathering() {
            let finished_at = *gathering_finished_at.get_or_insert(now);
            let drained = now.duration_since(finished_at) >= Duration::from_millis(100);
            let count_stable = now.duration_since(count_stable_since) >= Duration::from_millis(100);
            if drained && count_stable {
                return Ok(());
            }
        }

        if started.elapsed() >= timeout {
            return Err(ProbeError::Backend(format!(
                "NSMetadataQuery gathering timed out after {}s",
                timeout.as_secs()
            )));
        }
    }
}

fn path_in_scopes(path: &Path, scopes: &[PathBuf]) -> bool {
    scopes.iter().any(|scope| path.starts_with(scope))
}

#[cfg(target_os = "macos")]
fn nsmetadata_predicate(include_videos: bool) -> Result<Retained<NSPredicate>, ProbeError> {
    let image = nsmetadata_content_type_predicate("public.image")?;
    if !include_videos {
        return Ok(image);
    }

    let movie = nsmetadata_content_type_predicate("public.movie")?;
    let predicates = NSArray::from_retained_slice(&[image, movie]);
    let compound = NSCompoundPredicate::orPredicateWithSubpredicates(&predicates);
    Ok(compound.into_super())
}

#[cfg(target_os = "macos")]
fn nsmetadata_content_type_predicate(uti: &str) -> Result<Retained<NSPredicate>, ProbeError> {
    let format = NSString::from_str("%K == %@");
    let value = NSString::from_str(uti);
    let key = unsafe { NSMetadataItemContentTypeTreeKey };
    let args = NSArray::from_slice(&[key, &value]);
    // NSMetadataQuery 在应用内使用 NSPredicate；这里用 `%K == %@` 避免把 Spotlight
    // query string 解析规则和 NSPredicate format 规则混在一起。
    let predicate = unsafe {
        NSPredicate::predicateWithFormat_argumentArray(
            &format,
            Some(args.cast_unchecked::<AnyObject>()),
        )
    };
    Ok(predicate)
}

#[cfg(target_os = "macos")]
fn nsstring_to_string(value: &NSString) -> String {
    autoreleasepool(|pool| unsafe { value.to_str(pool).to_string() })
}

fn system_time_unix_ms(time: SystemTime) -> u128 {
    time.duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| Duration::from_secs(0))
        .as_millis()
}

fn json_escape(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for c in input.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c.is_control() => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

#[derive(Debug)]
enum ProbeError {
    Args(String),
    Io(String),
    Backend(String),
    Unsupported(String),
}

impl fmt::Display for ProbeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ProbeError::Args(message)
            | ProbeError::Io(message)
            | ProbeError::Backend(message)
            | ProbeError::Unsupported(message) => f.write_str(message),
        }
    }
}
