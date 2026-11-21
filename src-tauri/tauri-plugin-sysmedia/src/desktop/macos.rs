//! macOS 的数据源：MediaRemote（系统的 Now Playing）。
//!
//! macOS 15.4 起 MediaRemote 只给系统程序数据，所以照 mediaremote-adapter 的做法借 `/usr/bin/perl`：它加载我们的
//! 动态库、调导出函数，动态库在 perl 进程里读 MediaRemote，把变化逐行打印成 JSON。动态库与上游的 perl 脚本都编进
//! 程序（`build.rs`），第一次用时按内容哈希解到应用缓存目录（照 `.framework` 的目录形状，上游脚本不用改）。
//!
//! 一条线程管一个 `perl … stream --micros` 子进程：逐行读 stdout 交给 [`stream::Tracker`]，stderr 记日志；
//! 子进程意外退出时退避重启（新进程的第一行是完整状态，和之前推过的比较，只推变了的）。丢弃 [`MacWatch`] 即杀掉
//! 子进程、等线程退出。Kabegame 崩溃时子进程要等下一次写 stdout 收到 SIGPIPE 才退出。

mod stream;

use crate::OnEvent;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

const ADAPTER_LIBRARY: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/MediaRemoteAdapter"));
const ADAPTER_SCRIPT: &[u8] =
    include_bytes!("../../macos/mediaremote-adapter/bin/mediaremote-adapter.pl");
const PERL: &str = "/usr/bin/perl";
const FRAMEWORK: &str = "MediaRemoteAdapter.framework";
const LIBRARY: &str = "MediaRemoteAdapter";
const SCRIPT: &str = "mediaremote-adapter.pl";
/// 重启退避：从 1 s 起翻倍、封顶 30 s；子进程连续跑满一分钟后回到 1 s。
const BACKOFF_MIN: Duration = Duration::from_secs(1);
const BACKOFF_MAX: Duration = Duration::from_secs(30);
const HEALTHY_RUN: Duration = Duration::from_secs(60);

pub struct MacWatch {
    stop: Arc<AtomicBool>,
    child: Arc<Mutex<Option<Child>>>,
    thread: Option<JoinHandle<()>>,
}

impl MacWatch {
    /// `cache` 是插件自己的缓存目录（`<应用缓存>/sysmedia`）。
    pub fn start(cache: PathBuf, emit: OnEvent) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let child = Arc::new(Mutex::new(None));
        let thread = std::thread::Builder::new()
            .name("kabegame-sysmedia".to_string())
            .spawn({
                let stop = stop.clone();
                let child = child.clone();
                move || run(&cache, &stop, &child, &emit)
            })
            .map_err(|error| tracing::warn!("启动系统媒体会话线程失败: {error}"))
            .ok();
        Self {
            stop,
            child,
            thread,
        }
    }
}

impl Drop for MacWatch {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(child) = lock(&self.child).as_mut() {
            // 杀掉后 stdout 关闭，读线程的 read_line 返回 EOF
            let _ = child.kill();
        }
        if let Some(thread) = self.thread.take() {
            if thread.thread().id() != std::thread::current().id() {
                let _ = thread.join();
            }
        }
    }
}

fn lock(child: &Mutex<Option<Child>>) -> std::sync::MutexGuard<'_, Option<Child>> {
    child.lock().unwrap_or_else(|e| e.into_inner())
}

fn run(cache: &Path, stop: &AtomicBool, slot: &Mutex<Option<Child>>, emit: &OnEvent) {
    let mut tracker = stream::Tracker::default();
    let mut reported = false;
    let mut backoff = BACKOFF_MIN;
    while !stop.load(Ordering::SeqCst) {
        let started = Instant::now();
        // 每次起子进程前都解一次（文件在就跳过）：桌面的 dev 与已安装版 identifier 相同、共用缓存目录，版本不同时会把
        // 对方的哈希目录当旧版本删掉，这样被删了也能自己补回来
        let spawned = extract(cache)
            .map_err(|error| format!("解出失败: {error}"))
            .and_then(|files| spawn(&files).map_err(|error| error.to_string()));
        match spawned {
            Ok(mut child) => {
                let stdout = child.stdout.take();
                let stderr = child.stderr.take();
                *lock(slot) = Some(child);
                // 放进槽之前就要停的：这里补杀
                if stop.load(Ordering::SeqCst) {
                    if let Some(child) = lock(slot).as_mut() {
                        let _ = child.kill();
                    }
                }
                if let Some(stderr) = stderr {
                    forward_stderr(stderr);
                }
                if let Some(stdout) = stdout {
                    let mut reader = BufReader::new(stdout);
                    let mut line = String::new();
                    loop {
                        line.clear();
                        match reader.read_line(&mut line) {
                            Ok(0) | Err(_) => break,
                            Ok(_) => {
                                for event in tracker.apply(&line) {
                                    reported = true;
                                    emit(event);
                                }
                            }
                        }
                    }
                }
                if let Some(mut child) = lock(slot).take() {
                    let status = child.wait();
                    if !stop.load(Ordering::SeqCst) {
                        tracing::warn!(
                            "mediaremote-adapter 退出（{status:?}），{backoff:?} 后重启"
                        );
                    }
                }
            }
            Err(error) => {
                tracing::warn!("启动 mediaremote-adapter 失败（{backoff:?} 后重试）: {error}")
            }
        }
        if !reported {
            // 起不来或一行都没出：照约定先报一次「没有会话」
            reported = true;
            emit(crate::MediaEvent::Session(None));
        }
        if started.elapsed() >= HEALTHY_RUN {
            backoff = BACKOFF_MIN;
        }
        sleep_unless_stopped(stop, backoff);
        backoff = (backoff * 2).min(BACKOFF_MAX);
    }
}

fn spawn(files: &AdapterFiles) -> std::io::Result<Child> {
    Command::new(PERL)
        .arg(&files.script)
        .arg(&files.framework)
        .args(["stream", "--micros"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
}

fn forward_stderr(stderr: std::process::ChildStderr) {
    let _ = std::thread::Builder::new()
        .name("kabegame-sysmedia-stderr".to_string())
        .spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if !line.trim().is_empty() {
                    tracing::warn!("mediaremote-adapter: {line}");
                }
            }
        });
}

fn sleep_unless_stopped(stop: &AtomicBool, total: Duration) {
    let deadline = Instant::now() + total;
    while !stop.load(Ordering::SeqCst) {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return;
        }
        std::thread::sleep(left.min(Duration::from_millis(100)));
    }
}

struct AdapterFiles {
    script: PathBuf,
    framework: PathBuf,
}

/// 解到 `<cache>/<内容哈希>/`：`mediaremote-adapter.pl` 与 `MediaRemoteAdapter.framework/MediaRemoteAdapter`。
/// 文件已在且大小相同就不重写；同目录下别的哈希目录多半是旧版本留下的，顺手删掉——也可能是同时在跑的另一个版本
/// （dev 与已安装版共用缓存目录），删掉不影响它已经起来的子进程，它下次起子进程前会重新解出（[`run`]）。
fn extract(cache: &Path) -> std::io::Result<AdapterFiles> {
    let hash = format!("{:016x}", fnv1a(&[ADAPTER_LIBRARY, ADAPTER_SCRIPT]));
    let dir = cache.join(&hash);
    let script = dir.join(SCRIPT);
    let framework = dir.join(FRAMEWORK);
    write_if_needed(&script, ADAPTER_SCRIPT)?;
    write_if_needed(&framework.join(LIBRARY), ADAPTER_LIBRARY)?;
    if let Ok(entries) = std::fs::read_dir(cache) {
        for entry in entries.flatten() {
            if entry.file_name() != hash.as_str() && entry.path().is_dir() {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
    Ok(AdapterFiles { script, framework })
}

fn write_if_needed(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if std::fs::metadata(path).is_ok_and(|meta| meta.len() == bytes.len() as u64) {
        return Ok(());
    }
    let parent = path.parent().expect("解出路径有父目录");
    std::fs::create_dir_all(parent)?;
    // 先写临时文件（名字带进程号）再改名：dev 与已安装版共用缓存目录，同时解出也不会读到半个文件
    let temp = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name().unwrap_or_default().to_string_lossy(),
        std::process::id()
    ));
    {
        let mut file = std::fs::File::create(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    std::fs::rename(&temp, path)
}

/// FNV-1a 64：只用来给解出目录起名，要的是跨运行稳定。
fn fnv1a(parts: &[&[u8]]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for part in parts {
        for byte in *part {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_into_a_framework_shaped_dir_and_drops_old_versions() {
        let cache =
            std::env::temp_dir().join(format!("kabegame-sysmedia-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&cache);
        std::fs::create_dir_all(cache.join("0000000000000000")).unwrap();
        let files = extract(&cache).unwrap();
        assert!(files.script.ends_with(SCRIPT));
        assert_eq!(
            std::fs::read(files.framework.join(LIBRARY)).unwrap(),
            ADAPTER_LIBRARY
        );
        assert!(!cache.join("0000000000000000").exists());
        // 再解一次：不报错、内容不变
        extract(&cache).unwrap();
        std::fs::remove_dir_all(&cache).unwrap();
    }

    /// 真机：本机有正在播放的媒体时会推出会话（没有时是 `Session(None)`），两种都算通过；只看适配器能起来、能出数据。
    #[test]
    #[ignore = "起 /usr/bin/perl 读系统 Now Playing，手动跑"]
    fn the_adapter_reports_a_session_on_this_machine() {
        let cache =
            std::env::temp_dir().join(format!("kabegame-sysmedia-live-{}", std::process::id()));
        let (sender, receiver) = std::sync::mpsc::channel();
        let watch = MacWatch::start(
            cache.clone(),
            Box::new(move |event| {
                let _ = sender.send(event);
            }),
        );
        let first = receiver.recv_timeout(Duration::from_secs(10)).unwrap();
        assert!(matches!(first, crate::MediaEvent::Session(_)));
        // 之后 3 秒内的读数一并打出来（封面只打长度）
        let mut events = vec![first];
        let deadline = Instant::now() + Duration::from_secs(3);
        while let Ok(event) =
            receiver.recv_timeout(deadline.saturating_duration_since(Instant::now()))
        {
            events.push(event);
        }
        for event in &events {
            let mut event = event.clone();
            if let crate::MediaEvent::Session(Some(crate::MediaSnapshot {
                properties: Some(p),
                ..
            }))
            | crate::MediaEvent::Properties(Some(p)) = &mut event
            {
                if let Some(bytes) = p.thumbnail.take() {
                    println!("  (thumbnail {} bytes)", bytes.len());
                }
            }
            println!("{event:?}");
        }
        drop(watch);
        let _ = std::fs::remove_dir_all(&cache);
    }
}
