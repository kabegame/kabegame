//! macOS 与 Linux 共用的部分：按登录 shell 的 `PATH` 找程序、登录 + 交互 shell 跑命令、`setsid` 脱离终端、后台收尸、
//! 用 `tauri-plugin-opener` 打开路径与网址。两个平台的快捷方式对命令的语义必须一致（在终端里能跑的命令，点快捷方式也能跑），
//! 所以共用这一份；平台各自的部分（取图标、应用的启动）在 `mac.rs` / `linux.rs`。
//!
//! - 命令整条交给用户的登录 + 交互 shell（`$SHELL -i -l -c`），和在终端里敲一样：登录与交互配置里的 `PATH`（Homebrew、
//!   nvm、pyenv 等）、别名、函数都在，改了立即生效。从 Finder / Dock / 桌面启动的应用自己的 `PATH` 不一定有这些；
//!   代价是每次多一次 shell 启动（oh-my-zsh 加 nvm 约 0.6 s）。
//! - 子进程先 `setsid()`、工作目录是主目录、不接标准输入输出；起不来当场返回原因。起来后不等它：另起线程收尸，
//!   [`FAILURE_WINDOW`] 内以非 0 退出（拼错的命令是 127）就算启动失败，经 `user-message` 通道告诉用户，之后才退出的只记日志
//!   （[`spawn_checked`]）。
//! - 当场能知道的失败（目标不存在、起不来）返回给用户看的原因（`Err`），由命令层经同一个通道交给前端的看板娘。

use std::ffi::{OsStr, OsString};
use std::io::Read;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{mpsc, OnceLock};
use std::time::{Duration, Instant};

use kabegame_core::wpe::user_props::{ShortcutKind, UserShortcut};

/// 读登录 shell 的 `PATH` 最多等这么久（`.zshrc` 里加载很多东西时会慢），之后用应用自己的 `PATH`。
const SHELL_PATH_TIMEOUT: Duration = Duration::from_secs(5);
/// 登录 shell 打印 `PATH` 时前后的标记：rc 文件可能往标准输出打别的东西。
const PATH_BEGIN: &str = "__KABEGAME_PATH_BEGIN__";
const PATH_END: &str = "__KABEGAME_PATH_END__";
/// 子进程起来后这段时间内以非 0 退出算启动失败、告诉用户（拼错的命令、程序立刻报错）；之后才退出的只记日志。登录 + 交互 shell
/// 读完配置才跑命令，在 app 里实测找不到命令要约 1.3 s 才退出（终端里 0.5 s），所以不在启动命令里同步等，而是事后经通道报。
const FAILURE_WINDOW: Duration = Duration::from_secs(5);
/// 没有 `$SHELL`（Linux 上再查不到 passwd）时用的 shell：macOS 的缺省是 zsh。
#[cfg(target_os = "macos")]
const DEFAULT_SHELL: &str = "/bin/zsh";
#[cfg(not(target_os = "macos"))]
const DEFAULT_SHELL: &str = "/bin/sh";

/// 取图标的路径：命令取命令行里的程序（照 shell 规则拆，取第一个词），其余取路径本身。
pub fn icon_target(shortcut: &UserShortcut) -> String {
    match shortcut.kind {
        ShortcutKind::Cmd => shlex::split(&command_line(shortcut))
            .and_then(|words| words.into_iter().next())
            .unwrap_or_else(|| shortcut.path.clone()),
        _ => shortcut.path.clone(),
    }
}

/// 路径存在就用它；不存在、又不带 `/` 时按登录 shell 的 `PATH`（取不到用应用自己的）找同名的可执行文件；都不是就原样返回。
pub fn resolve_path(path: &str) -> PathBuf {
    let search = shell_path().cloned().or_else(|| std::env::var_os("PATH"));
    resolve_path_in(path, search.as_deref())
}

pub fn resolve_path_in(path: &str, search: Option<&OsStr>) -> PathBuf {
    let given = PathBuf::from(path);
    if given.exists() || path.contains('/') {
        return given;
    }
    search
        .into_iter()
        .flat_map(|paths| std::env::split_paths(paths).collect::<Vec<_>>())
        .map(|dir| dir.join(path))
        .find(|candidate| is_executable_file(candidate))
        .unwrap_or(given)
}

/// 用户的登录 shell：`$SHELL`（从 Finder / 桌面启动的应用也有）；没有或不可执行时 Linux 查 passwd，最后用 [`DEFAULT_SHELL`]。
fn user_shell() -> PathBuf {
    let usable = |shell: &PathBuf| shell.is_absolute() && is_executable_file(shell);
    std::env::var_os("SHELL")
        .map(PathBuf::from)
        .filter(usable)
        .or_else(|| passwd_shell().filter(usable))
        .unwrap_or_else(|| PathBuf::from(DEFAULT_SHELL))
}

/// passwd 里本用户的登录 shell（`getpwuid_r`）。macOS 上不查，行为同以前（直接用 zsh）。
#[cfg(target_os = "linux")]
fn passwd_shell() -> Option<PathBuf> {
    use std::ffi::CStr;
    use std::os::unix::ffi::OsStrExt;
    let mut entry: libc::passwd = unsafe { std::mem::zeroed() };
    let mut found: *mut libc::passwd = std::ptr::null_mut();
    let mut buffer = vec![0 as libc::c_char; 16 * 1024];
    // SAFETY: entry / buffer 在调用期间有效，长度如实给出；成功时 found 指向 entry，字段指进 buffer
    let status = unsafe {
        libc::getpwuid_r(
            libc::getuid(),
            &mut entry,
            buffer.as_mut_ptr(),
            buffer.len(),
            &mut found,
        )
    };
    if status != 0 || found.is_null() || entry.pw_shell.is_null() {
        return None;
    }
    // SAFETY: pw_shell 指向 buffer 里以 NUL 结尾的串
    let shell = unsafe { CStr::from_ptr(entry.pw_shell) };
    (!shell.to_bytes().is_empty()).then(|| PathBuf::from(OsStr::from_bytes(shell.to_bytes())))
}

#[cfg(not(target_os = "linux"))]
fn passwd_shell() -> Option<PathBuf> {
    None
}

/// 用户在终端里看到的 `PATH`：让登录 + 交互 shell 打印一次（`.zshrc` / `.bashrc` 只有交互 shell 才读），进程内缓存。
/// 启动命令每次都在登录 shell 里跑、不用它；它只给命令的图标按名字找程序。超时或失败时缓存成 `None`，不再重试
/// （否则每个图标都要等）。
pub fn shell_path() -> Option<&'static OsString> {
    static CACHED: OnceLock<Option<OsString>> = OnceLock::new();
    CACHED
        .get_or_init(|| {
            let script = format!("printf '\\n{PATH_BEGIN}%s{PATH_END}\\n' \"$PATH\"");
            let output = shell_output(&script, SHELL_PATH_TIMEOUT);
            let path = output.as_deref().and_then(parse_marked_path);
            match &path {
                Some(_) => tracing::debug!("读到登录 shell 的 PATH"),
                None => tracing::warn!("读登录 shell 的 PATH 失败，命令图标按应用自己的 PATH 找"),
            }
            path
        })
        .as_ref()
}

/// 在登录 + 交互 shell 里跑 `script`，收标准输出；超时杀掉、返回 `None`。
fn shell_output(script: &str, timeout: Duration) -> Option<String> {
    let mut command = login_shell_command(script);
    command.stdout(Stdio::piped());
    let mut child = command.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let mut text = String::new();
        let _ = stdout.read_to_string(&mut text);
        let _ = sender.send(text);
    });
    let text = receiver.recv_timeout(timeout).ok();
    if text.is_none() {
        let _ = child.kill();
    }
    let _ = child.wait();
    text
}

/// 取两个标记之间的 `PATH`，空串当没有。
fn parse_marked_path(text: &str) -> Option<OsString> {
    let start = text.rfind(PATH_BEGIN)? + PATH_BEGIN.len();
    let end = start + text[start..].find(PATH_END)?;
    let path = text[start..end].trim();
    (!path.is_empty()).then(|| OsString::from(path))
}

pub fn is_executable_file(path: &Path) -> bool {
    path.metadata()
        .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
}

/// 打开前确认目标在：opener 交给系统后多半不回报「不存在」（xdg-open 会自己弹错或静默失败），这里先查，好把原因告诉用户。
pub fn ensure_exists(path: &str, directory: bool) -> Result<(), String> {
    let target = Path::new(path);
    match (directory, target.is_dir(), target.exists()) {
        (true, true, _) | (false, _, true) => Ok(()),
        (true, false, true) => Err(format!("不是文件夹：{path}")),
        (true, false, false) => Err(format!("文件夹不存在：{path}")),
        (false, _, false) => Err(format!("文件不存在：{path}")),
    }
}

/// 用默认程序打开路径（文件、文件夹；macOS 上 `.app` 会被启动）。
pub fn open_path(path: &str) -> Result<(), String> {
    tauri_plugin_opener::open_path(path, None::<&str>).map_err(|error| format!("打开失败：{error}"))
}

/// 打开网址：没写协议的补 `https://`（[`super::web::launch_url`]，保存时不补）。
pub fn open_url(input: &str) -> Result<(), String> {
    let url = super::web::launch_url(input).ok_or_else(|| format!("网址不合法：{input}"))?;
    tauri_plugin_opener::open_url(url.as_str(), None::<&str>)
        .map_err(|error| format!("打开网址失败：{error}"))
}

/// 命令的整条命令行：`parse_user_shortcut` 在第一个空格处拆成程序与参数，这里拼回去。
pub fn command_line(shortcut: &UserShortcut) -> String {
    if shortcut.args.is_empty() {
        shortcut.path.clone()
    } else {
        format!("{} {}", shortcut.path, shortcut.args)
    }
}

/// `/bin/sh -c <line>`，见 [`spawn_checked`]。
pub fn run_shell(line: &str) -> Result<(), String> {
    let mut command = Command::new("/bin/sh");
    command.arg("-c").arg(line);
    new_session(&mut command);
    spawn_checked(command)
}

/// 用户的登录 + 交互 shell 跑 `line`（`-i -l -c` 分开写，fish 也认）。标准输入输出不接，交互 shell 读到的是空输入；
/// 工作目录是主目录，子进程自成一个会话（见 [`new_session`]）。
pub fn login_shell_command(line: &str) -> Command {
    let mut command = Command::new(user_shell());
    command
        .args(["-i", "-l", "-c"])
        .arg(line)
        .stdin(Stdio::null())
        .stderr(Stdio::null());
    new_session(&mut command);
    command
}

/// 子进程先 `setsid()`：脱离控制终端、自成会话与进程组。从终端启动的 Kabegame（dev）带着控制终端，后台进程组里的交互 shell
/// 一碰终端就被 SIGTTOU 停住（实测停在 `T` 状态）；脱离之后和从 Finder / 桌面启动时一样，终端里的 Ctrl+C 也带不走它。
/// 工作目录顺带设成主目录。
pub fn new_session(command: &mut Command) {
    if let Some(home) = std::env::var_os("HOME") {
        command.current_dir(home);
    }
    // SAFETY: pre_exec 在 fork 之后、exec 之前跑，只调 async-signal-safe 的 setsid
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

/// 起子进程：不接标准输入输出，另起线程收尸。起不来时返回原因；起来了就返回，[`FAILURE_WINDOW`] 内以非 0 退出时经
/// `user-message` 通道告诉用户（[`report_failure`]）。`command` 已经由 [`new_session`] 处理过。
pub fn spawn_checked(command: Command) -> Result<(), String> {
    spawn_watched(command, report_failure)
}

/// 启动后出错退出：记日志，并经 `user-message` 通道交给前端的看板娘（同启动命令当场失败时的提示）。
fn report_failure(reason: String) {
    tracing::warn!("场景快捷方式启动后出错退出：{reason}");
    kabegame_core::emitter::GlobalEmitter::global().emit_user_message(
        kabegame_core::emitter::UserMessageLevel::Error,
        "gallery.wpeShortcutLaunchFailed",
        serde_json::json!({ "reason": reason }),
    );
}

/// [`spawn_checked`] 的实现，`on_failure` 可换（单测收原因用）。
fn spawn_watched(
    mut command: Command,
    on_failure: impl FnOnce(String) + Send + 'static,
) -> Result<(), String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let program = command.get_program().to_string_lossy().into_owned();
    let mut child = command
        .spawn()
        .map_err(|error| format!("启动 {program} 失败：{error}"))?;
    let started = Instant::now();
    let _ = std::thread::Builder::new()
        .name("wpe-shortcut-wait".into())
        .spawn(move || match child.wait() {
            Ok(status) if !status.success() => {
                if started.elapsed() <= FAILURE_WINDOW {
                    on_failure(exit_reason(status));
                } else {
                    tracing::warn!("场景快捷方式的命令没有正常结束：{status}");
                }
            }
            Ok(_) => {}
            Err(error) => tracing::warn!("等待场景快捷方式的命令失败：{error}"),
        });
    Ok(())
}

/// 启动后很快以非 0 退出的原因。shell 找不到命令退出 127、找到了但不能执行退出 126。
fn exit_reason(status: std::process::ExitStatus) -> String {
    use std::os::unix::process::ExitStatusExt;
    match (status.code(), status.signal()) {
        (Some(127), _) => "找不到命令（退出码 127）".to_owned(),
        (Some(126), _) => "命令不能执行（退出码 126）".to_owned(),
        (Some(code), _) => format!("启动后立刻出错退出（退出码 {code}）"),
        (None, Some(signal)) => format!("启动后被信号 {signal} 结束"),
        (None, None) => "启动后立刻退出".to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shortcut(kind: ShortcutKind, path: &str, args: &str) -> UserShortcut {
        UserShortcut {
            kind,
            path: path.into(),
            args: args.into(),
        }
    }

    #[test]
    fn command_line_and_program_follow_shell_rules() {
        // parse_user_shortcut 在第一个空格处拆，拼回去是原命令行
        let cmd = shortcut(ShortcutKind::Cmd, "open", "-a Calculator");
        assert_eq!(command_line(&cmd), "open -a Calculator");
        assert_eq!(icon_target(&cmd), "open");
        // 带引号的程序路径：第一个空格落在引号里，图标仍取完整路径
        let quoted = shortcut(
            ShortcutKind::Cmd,
            "\"/Applications/My",
            "App.app/Contents/MacOS/x\" --flag",
        );
        assert_eq!(
            icon_target(&quoted),
            "/Applications/My App.app/Contents/MacOS/x"
        );
        // 引号不配对时退回路径本身
        let broken = shortcut(ShortcutKind::Cmd, "\"oops", "");
        assert_eq!(icon_target(&broken), "\"oops");
        // 其它类型取路径
        let file = shortcut(ShortcutKind::File, "/Applications/Safari.app", "-x");
        assert_eq!(icon_target(&file), "/Applications/Safari.app");
    }

    #[test]
    fn resolve_path_searches_path_only_for_bare_names() {
        let search = OsStr::new("/nonexistent:/bin");
        // sh 必在 /bin
        assert_eq!(
            resolve_path_in("sh", Some(search)),
            PathBuf::from("/bin/sh")
        );
        // 带 `/` 的不查
        assert_eq!(
            resolve_path_in("bin/sh", Some(search)),
            PathBuf::from("bin/sh")
        );
        // 查不到、没有 PATH 都原样返回
        assert_eq!(
            resolve_path_in("kabegame-no-such-program", Some(search)),
            PathBuf::from("kabegame-no-such-program")
        );
        assert_eq!(resolve_path_in("sh", None), PathBuf::from("sh"));
    }

    #[test]
    fn marked_path_ignores_noise_from_rc_files() {
        let text = format!("Welcome!\n{PATH_BEGIN}/opt/homebrew/bin:/usr/bin{PATH_END}\nbye\n");
        assert_eq!(
            parse_marked_path(&text),
            Some(OsString::from("/opt/homebrew/bin:/usr/bin"))
        );
        // 取最后一个开始标记（rc 文件里碰巧也打印了标记时以我们的为准）
        let twice = format!("{PATH_BEGIN}x{PATH_END}{PATH_BEGIN}/bin{PATH_END}");
        assert_eq!(parse_marked_path(&twice), Some(OsString::from("/bin")));
        assert_eq!(parse_marked_path(&format!("{PATH_BEGIN}{PATH_END}")), None);
        assert_eq!(parse_marked_path("no markers"), None);
    }

    #[test]
    fn existence_is_checked_before_opening() {
        assert!(ensure_exists("/", true).is_ok());
        assert!(ensure_exists("/bin/sh", false).is_ok());
        assert!(ensure_exists("/", false).is_ok());
        assert_eq!(
            ensure_exists("/bin/sh", true).unwrap_err(),
            "不是文件夹：/bin/sh"
        );
        assert!(ensure_exists("/kabegame-nope", true)
            .unwrap_err()
            .starts_with("文件夹不存在"));
        assert!(ensure_exists("/kabegame-nope", false)
            .unwrap_err()
            .starts_with("文件不存在"));
    }

    #[test]
    fn early_failures_are_reported_and_running_programs_are_not() {
        let shell = |line: &str| {
            let mut command = Command::new("/bin/sh");
            command.arg("-c").arg(line);
            new_session(&mut command);
            let (sender, receiver) = mpsc::channel();
            spawn_watched(command, move |reason| {
                let _ = sender.send(reason);
            })
            .map(|()| receiver)
        };
        let wait = Duration::from_secs(3);
        assert_eq!(
            shell("kabegame-no-such-command")
                .unwrap()
                .recv_timeout(wait)
                .unwrap(),
            "找不到命令（退出码 127）"
        );
        assert_eq!(
            shell("exit 3").unwrap().recv_timeout(wait).unwrap(),
            "启动后立刻出错退出（退出码 3）"
        );
        // 正常结束、还在跑：不报（返回不等它）
        let started = std::time::Instant::now();
        let quiet = shell("true").unwrap();
        let running = shell("sleep 3").unwrap();
        assert!(started.elapsed() < Duration::from_millis(500));
        assert!(quiet.recv_timeout(Duration::from_millis(500)).is_err());
        assert!(running.recv_timeout(Duration::from_millis(500)).is_err());
        // 起不来：当场返回原因
        let missing = Command::new("/kabegame-no-such-program");
        assert!(spawn_watched(missing, |_| {})
            .unwrap_err()
            .starts_with("启动 /kabegame-no-such-program 失败"));
    }

    #[test]
    fn user_shell_is_an_absolute_executable() {
        let shell = user_shell();
        assert!(shell.is_absolute(), "{}", shell.display());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn passwd_has_a_login_shell() {
        let shell = passwd_shell().expect("passwd 里没有登录 shell");
        assert!(shell.is_absolute(), "{}", shell.display());
    }

    /// 真跑一次用户的登录 shell（本机核对用，`#[ignore]`）：拿到的 PATH 应比 `/bin/sh` 的长。
    #[test]
    #[ignore]
    fn reads_login_shell_path() {
        let path = shell_path().expect("读不到登录 shell 的 PATH");
        println!("{}", path.to_string_lossy());
        assert!(path.to_string_lossy().contains("/usr/bin"));
    }
}
