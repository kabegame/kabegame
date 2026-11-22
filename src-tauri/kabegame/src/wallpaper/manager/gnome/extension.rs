//! Kabegame 的 GNOME Shell 扩展（源码 `src-gnome-shell-extension/`）：版本门槛、在线检测、安装与掉线监听。
//!
//! - **两份扩展**：GNOME 45 起扩展是 ES 模块，之前是 `imports.*`，同一个文件两边都加载不了。共享的 `core.js` 加一个包装
//!   （`legacy.js` 给 42–44，`esm.js` 给 45+）在安装时拼成 `extension.js`，`metadata.json` 的 `shell-version` 按同一条线分开写。
//!   挂到桌面的手段另按 49 分（mutter 49 才公开 `Meta.Window.set_type`），在扩展里运行时判断，见 `core.js` 开头。
//! - **在线**：扩展启用期间在会话总线上占着 [`BUS_NAME`]，并在 [`OBJECT_PATH`] 导出 [`INTERFACE`]；它的 `Protocol` 属性等于
//!   [`PROTOCOL`] 才算在线（旧版本的扩展当作不在线，切插件模式时会被重装）。
//! - **安装**：写进 `~/.local/share/gnome-shell/extensions/<UUID>/`（已有的整个覆盖，不看装没装过），再把 UUID 加进
//!   `org.gnome.shell enabled-extensions`。GNOME Shell 只在登录时扫描扩展目录，装完要注销重新登录才会加载。
//! - **掉线**：一个常驻线程监听 [`BUS_NAME`] 的属主变化，名字没了（扩展被关掉、Shell 重启或崩溃）就回调。

use std::ops::RangeInclusive;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Mutex, Once};
use std::time::Duration;

use serde::Serialize;
use zbus::zvariant::OwnedValue;

/// 扩展的 UUID（也是安装目录名）。
pub const UUID: &str = "kabegame@kabegame.app";
/// 与扩展的约定版本，`core.js` 的 `PROTOCOL` 必须相等（单测核对）。改了 D-Bus 接口或窗口处理就加一，让应用重装扩展。
pub const PROTOCOL: u32 = 1;
/// 扩展启用期间占着的会话总线名字。
pub const BUS_NAME: &str = "app.kabegame.Shell";
pub const OBJECT_PATH: &str = "/app/kabegame/Shell";
pub const INTERFACE: &str = "app.kabegame.Shell1";
/// 支持的 GNOME Shell 主版本。`shell-version` 里没写的版本 GNOME 不加载扩展，新版本发布后要核对接口再加进来。
pub const SUPPORTED_SHELL: RangeInclusive<u32> = 42..=51;
/// 从这个版本起扩展是 ES 模块。
const ESM_SINCE: u32 = 45;
/// 问 Shell 的 D-Bus 调用的超时：Shell 卡住时不能把调用方一直挂着。
const CALL_TIMEOUT: Duration = Duration::from_secs(1);

const CORE: &str = include_str!("../../../../../../src-gnome-shell-extension/core.js");
const LEGACY_WRAPPER: &str = include_str!("../../../../../../src-gnome-shell-extension/legacy.js");
const ESM_WRAPPER: &str = include_str!("../../../../../../src-gnome-shell-extension/esm.js");
const CORE_PLACEHOLDER: &str = "/* @@KABEGAME_CORE@@ */";

/// 能不能切到插件模式（`get_plugin_mode_readiness` 的返回值）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum Readiness {
    /// 可以切。`gnome`：是 GNOME 会话（前端据此选确认文案）。
    Ready { gnome: bool },
    /// GNOME Shell 的版本不在 [`SUPPORTED_SHELL`] 里。
    GnomeShellUnsupported { version: String, min: u32, max: u32 },
    /// 版本支持，但扩展不在线（没装、没启用、没重新登录，或者是旧版本）。
    GnomeExtensionMissing { version: String },
}

/// 安装结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallOutcome {
    /// 系统的扩展总开关（`disable-user-extensions`）关着：重新登录后扩展也不会加载，要用户在「扩展」应用里打开。
    pub user_extensions_disabled: bool,
}

/// 共用一条会话总线连接；连不上时下次再试。
fn bus() -> Option<zbus::blocking::Connection> {
    static BUS: Mutex<Option<zbus::blocking::Connection>> = Mutex::new(None);
    let mut guard = BUS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if guard.is_none() {
        match zbus::blocking::connection::Builder::session()
            .and_then(|builder| builder.method_timeout(CALL_TIMEOUT).build())
        {
            Ok(connection) => *guard = Some(connection),
            Err(error) => {
                tracing::debug!("连不上会话总线: {error}");
                return None;
            }
        }
    }
    guard.clone()
}

fn get_property(destination: &str, path: &str, interface: &str, name: &str) -> Result<OwnedValue, String> {
    let connection = bus().ok_or_else(|| "连不上会话总线".to_string())?;
    let reply = connection
        .call_method(
            Some(destination),
            path,
            Some("org.freedesktop.DBus.Properties"),
            "Get",
            &(interface, name),
        )
        .map_err(|error| error.to_string())?;
    reply.body().deserialize::<OwnedValue>().map_err(|error| error.to_string())
}

/// 正在运行的 GNOME Shell 的版本（`org.gnome.Shell` 的 `ShellVersion`，如 `42.9`、`50.1`）。
pub fn shell_version() -> Result<String, String> {
    let value = get_property("org.gnome.Shell", "/org/gnome/Shell", "org.gnome.Shell", "ShellVersion")?;
    String::try_from(value).map_err(|error| format!("ShellVersion 不是字符串: {error}"))
}

/// 版本字符串的主版本号（`45.beta` → 45）。
pub fn shell_major(version: &str) -> Option<u32> {
    let digits: String = version.trim().chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}

/// 扩展在线：[`BUS_NAME`] 有属主，且导出的 `Protocol` 等于 [`PROTOCOL`]。
pub fn is_online() -> bool {
    match get_property(BUS_NAME, OBJECT_PATH, INTERFACE, "Protocol").map(u32::try_from) {
        Ok(Ok(protocol)) if protocol == PROTOCOL => true,
        Ok(Ok(protocol)) => {
            tracing::debug!("GNOME Shell 扩展的约定版本是 {protocol}，本应用要 {PROTOCOL}，当作不在线");
            false
        }
        Ok(Err(error)) => {
            tracing::debug!("GNOME Shell 扩展的 Protocol 不是整数: {error}");
            false
        }
        Err(_) => false,
    }
}

/// GNOME 会话下能不能切到插件模式。
pub fn readiness() -> Result<Readiness, String> {
    let version = shell_version().map_err(|error| format!("读不到 GNOME Shell 的版本: {error}"))?;
    Ok(classify(&version, is_online))
}

fn classify(version: &str, online: impl FnOnce() -> bool) -> Readiness {
    match shell_major(version) {
        Some(major) if SUPPORTED_SHELL.contains(&major) => {
            if online() {
                Readiness::Ready { gnome: true }
            } else {
                Readiness::GnomeExtensionMissing {
                    version: version.to_string(),
                }
            }
        }
        _ => Readiness::GnomeShellUnsupported {
            version: version.to_string(),
            min: *SUPPORTED_SHELL.start(),
            max: *SUPPORTED_SHELL.end(),
        },
    }
}

/// 给主版本 `major` 拼出扩展：`(metadata.json, extension.js)`。
pub fn render(major: u32) -> (String, String) {
    let (wrapper, versions): (&str, Vec<String>) = if major < ESM_SINCE {
        (
            LEGACY_WRAPPER,
            (*SUPPORTED_SHELL.start()..ESM_SINCE).map(|v| v.to_string()).collect(),
        )
    } else {
        (
            ESM_WRAPPER,
            (ESM_SINCE..=*SUPPORTED_SHELL.end()).map(|v| v.to_string()).collect(),
        )
    };
    let script = wrapper.replacen(CORE_PLACEHOLDER, CORE, 1);
    let metadata = serde_json::json!({
        "uuid": UUID,
        "name": "Kabegame",
        "description": "Puts Kabegame's wallpaper windows on the desktop (installed by Kabegame).",
        "shell-version": versions,
        // 锁屏时也保持启用：扩展一停，应用就把插件模式退回原生
        "session-modes": ["user", "unlock-dialog"],
        "url": "https://github.com/kabegame/kabegame",
    });
    let metadata = serde_json::to_string_pretty(&metadata).expect("固定的 JSON 一定能序列化") + "\n";
    (metadata, script)
}

/// 扩展的安装目录：`$XDG_DATA_HOME/gnome-shell/extensions/<UUID>`。
fn extension_dir() -> Option<PathBuf> {
    dirs::data_dir().map(|dir| dir.join("gnome-shell").join("extensions").join(UUID))
}

/// 按当前 Shell 的版本装扩展并启用（已有的整个覆盖，不看装没装过）。要注销重新登录才会加载。
pub fn install() -> Result<InstallOutcome, String> {
    let version = shell_version()?;
    let major = shell_major(&version)
        .filter(|major| SUPPORTED_SHELL.contains(major))
        .ok_or_else(|| format!("不支持的 GNOME Shell 版本 {version}"))?;
    let dir = extension_dir().ok_or_else(|| "找不到用户数据目录".to_string())?;
    let (metadata, script) = render(major);

    // 覆盖：旧的目录（或指过来的符号链接）整个换掉，不留上一版的文件
    if let Ok(meta) = std::fs::symlink_metadata(&dir) {
        let removed = if meta.is_dir() {
            std::fs::remove_dir_all(&dir)
        } else {
            std::fs::remove_file(&dir)
        };
        removed.map_err(|error| format!("删除旧的扩展 {} 失败: {error}", dir.display()))?;
    }
    std::fs::create_dir_all(&dir).map_err(|error| format!("建目录 {} 失败: {error}", dir.display()))?;
    for (name, content) in [("metadata.json", metadata), ("extension.js", script)] {
        std::fs::write(dir.join(name), content)
            .map_err(|error| format!("写 {} 失败: {error}", dir.join(name).display()))?;
    }

    enable_in_gsettings()?;
    let user_extensions_disabled = gsettings_get("disable-user-extensions")
        .map(|value| value.trim() == "true")
        .unwrap_or(false);
    tracing::info!(
        "已安装 GNOME Shell 扩展 {UUID}（GNOME {version}，{}）到 {}，重新登录后生效{}",
        if major < ESM_SINCE { "旧式模块" } else { "ES 模块" },
        dir.display(),
        if user_extensions_disabled { "；系统的扩展总开关关着" } else { "" }
    );
    Ok(InstallOutcome {
        user_extensions_disabled,
    })
}

/// UUID 加进 `enabled-extensions`，并从 `disabled-extensions` 里拿掉（两边都有时 GNOME 按禁用算）。
fn enable_in_gsettings() -> Result<(), String> {
    let mut enabled = parse_strv(&gsettings_get("enabled-extensions")?)?;
    if !enabled.iter().any(|uuid| uuid == UUID) {
        enabled.push(UUID.to_string());
        gsettings_set("enabled-extensions", &format_strv(&enabled))?;
    }
    if let Ok(mut disabled) = gsettings_get("disabled-extensions").and_then(|raw| parse_strv(&raw)) {
        let before = disabled.len();
        disabled.retain(|uuid| uuid != UUID);
        if disabled.len() != before {
            gsettings_set("disabled-extensions", &format_strv(&disabled))?;
        }
    }
    Ok(())
}

fn gsettings_get(key: &str) -> Result<String, String> {
    let output = Command::new("gsettings")
        .args(["get", "org.gnome.shell", key])
        .output()
        .map_err(|error| format!("运行 gsettings 失败: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "gsettings get org.gnome.shell {key} 失败: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn gsettings_set(key: &str, value: &str) -> Result<(), String> {
    let output = Command::new("gsettings")
        .args(["set", "org.gnome.shell", key, value])
        .output()
        .map_err(|error| format!("运行 gsettings 失败: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "gsettings set org.gnome.shell {key} 失败: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

/// 解析 gsettings 打印的字符串数组（`['a', 'b']`、`@as []`）。
fn parse_strv(raw: &str) -> Result<Vec<String>, String> {
    let text = raw.trim();
    let text = text.strip_prefix("@as").map(str::trim).unwrap_or(text);
    let inner = text
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
        .ok_or_else(|| format!("看不懂 gsettings 的值: {raw}"))?;
    let mut items = Vec::new();
    let mut chars = inner.chars().peekable();
    loop {
        while chars.next_if(|c| c.is_whitespace() || *c == ',').is_some() {}
        let Some(quote) = chars.next() else { break };
        if quote != '\'' && quote != '"' {
            return Err(format!("看不懂 gsettings 的值: {raw}"));
        }
        let mut item = String::new();
        loop {
            match chars.next() {
                Some('\\') => item.extend(chars.next()),
                Some(c) if c == quote => break,
                Some(c) => item.push(c),
                None => return Err(format!("看不懂 gsettings 的值: {raw}")),
            }
        }
        items.push(item);
    }
    Ok(items)
}

fn format_strv(items: &[String]) -> String {
    let quoted: Vec<String> = items
        .iter()
        .map(|item| format!("'{}'", item.replace('\\', "\\\\").replace('\'', "\\'")))
        .collect();
    format!("[{}]", quoted.join(", "))
}

/// 起一个常驻线程监听 [`BUS_NAME`]：名字没了就调 `on_offline`（只起一次）。
pub fn watch(on_offline: fn()) {
    static STARTED: Once = Once::new();
    STARTED.call_once(|| {
        let spawned = std::thread::Builder::new()
            .name("gnome-shell-extension-watch".into())
            .spawn(move || loop {
                if let Err(error) = watch_once(on_offline) {
                    tracing::debug!("监听 GNOME Shell 扩展失败，10 s 后重试: {error}");
                }
                std::thread::sleep(Duration::from_secs(10));
            });
        if let Err(error) = spawned {
            tracing::warn!("起不来 GNOME Shell 扩展的监听线程: {error}");
        }
    });
}

fn watch_once(on_offline: fn()) -> zbus::Result<()> {
    // 单独一条连接：信号迭代器一直阻塞着收消息
    let connection = zbus::blocking::Connection::session()?;
    let proxy = zbus::blocking::fdo::DBusProxy::new(&connection)?;
    for signal in proxy.receive_name_owner_changed_with_args(&[(0, BUS_NAME)])? {
        let Ok(args) = signal.args() else { continue };
        if args.new_owner().is_none() {
            on_offline();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn core_speaks_the_same_protocol_and_names() {
        assert!(CORE.contains(&format!("const PROTOCOL = {PROTOCOL};")));
        assert!(CORE.contains(&format!("const BUS_NAME = '{BUS_NAME}';")));
        assert!(CORE.contains(&format!("const OBJECT_PATH = '{OBJECT_PATH}';")));
        assert!(CORE.contains(&format!("<interface name=\"{INTERFACE}\">")));
        // 与 WindowWallpaperManager 给壁纸窗口起的标题对得上
        assert!(CORE.contains(&format!(
            "/^{}(\\d+)$/",
            crate::wallpaper::manager::window::WINDOWED_TITLE_PREFIX
        )));
    }

    #[test]
    fn legacy_flavor_before_45_and_esm_from_45() {
        for major in [42, 44] {
            let (metadata, script) = render(major);
            assert!(!script.contains(CORE_PLACEHOLDER));
            assert!(script.contains("class KabegameExtension"));
            assert!(script.contains("function init()"));
            assert!(!script.contains("\nimport "));
            let metadata: serde_json::Value = serde_json::from_str(&metadata).unwrap();
            assert_eq!(metadata["shell-version"], serde_json::json!(["42", "43", "44"]));
            assert_eq!(metadata["uuid"], UUID);
        }
        for major in [45, 51] {
            let (metadata, script) = render(major);
            assert!(!script.contains(CORE_PLACEHOLDER));
            assert!(script.contains("class KabegameExtension"));
            assert!(script.contains("export default class"));
            let metadata: serde_json::Value = serde_json::from_str(&metadata).unwrap();
            assert_eq!(
                metadata["shell-version"],
                serde_json::json!(["45", "46", "47", "48", "49", "50", "51"])
            );
        }
    }

    #[test]
    fn shell_major_reads_the_leading_number() {
        assert_eq!(shell_major("42.9"), Some(42));
        assert_eq!(shell_major("50.1"), Some(50));
        assert_eq!(shell_major("45.beta"), Some(45));
        assert_eq!(shell_major(" 46 "), Some(46));
        assert_eq!(shell_major(""), None);
        assert_eq!(shell_major("unknown"), None);
    }

    #[test]
    fn classify_checks_the_version_before_the_extension() {
        assert_eq!(
            classify("41.5", || unreachable!("版本不支持时不问扩展")),
            Readiness::GnomeShellUnsupported {
                version: "41.5".into(),
                min: 42,
                max: 51
            }
        );
        assert!(matches!(classify("52.0", || true), Readiness::GnomeShellUnsupported { .. }));
        assert_eq!(classify("42.9", || true), Readiness::Ready { gnome: true });
        assert_eq!(
            classify("50.1", || false),
            Readiness::GnomeExtensionMissing {
                version: "50.1".into()
            }
        );
    }

    #[test]
    fn gsettings_string_arrays_round_trip() {
        assert_eq!(parse_strv("@as []").unwrap(), Vec::<String>::new());
        assert_eq!(parse_strv("[]").unwrap(), Vec::<String>::new());
        assert_eq!(
            parse_strv("['ding@rastersoft.com', 'ubuntu-dock@ubuntu.com']").unwrap(),
            vec!["ding@rastersoft.com", "ubuntu-dock@ubuntu.com"]
        );
        assert_eq!(parse_strv(r#"['it\'s', "x"]"#).unwrap(), vec!["it's", "x"]);
        assert!(parse_strv("nonsense").is_err());
        let items = vec!["a@b".to_string(), "it's".to_string()];
        assert_eq!(parse_strv(&format_strv(&items)).unwrap(), items);
        assert_eq!(format_strv(&["a@b".to_string()]), "['a@b']");
    }

    #[test]
    fn readiness_serializes_with_a_status_tag() {
        let value = serde_json::to_value(Readiness::GnomeShellUnsupported {
            version: "41.5".into(),
            min: 42,
            max: 51,
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({ "status": "gnomeShellUnsupported", "version": "41.5", "min": 42, "max": 51 })
        );
        assert_eq!(
            serde_json::to_value(Readiness::Ready { gnome: false }).unwrap(),
            serde_json::json!({ "status": "ready", "gnome": false })
        );
    }
}
