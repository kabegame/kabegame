//! Steam 库发现与 WPE 壁纸根展开。
//!
//! Windows 从注册表 `HKCU\Software\Valve\Steam\SteamPath` 起步，Linux 走 Steam 的常见
//! 安装目录；两者都解析 `steamapps/libraryfolders.vdf`，只在包含 app `431960`
//! （Wallpaper Engine）的库里产出三类根。WPE 壁纸暂只支持 Windows（[`platform_supported`]）：
//! Linux 的路径探测保留但不再进入，Linux / macOS / Android / Web 返回空。

use serde::Serialize;
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

/// 三类自动发现的壁纸来源。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WpeRootKind {
    /// 创意工坊订阅：`<库>/steamapps/workshop/content/431960/<id>`。
    Workshop,
    /// WPE 自带默认项目。
    DefaultProjects,
    /// 用户「我的项目」。
    MyProjects,
}

impl WpeRootKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Workshop => "workshop",
            Self::DefaultProjects => "defaultprojects",
            Self::MyProjects => "myprojects",
        }
    }

    pub const ALL: [Self; 3] = [Self::Workshop, Self::DefaultProjects, Self::MyProjects];
}

/// 一个待扫描的壁纸根目录。
#[derive(Debug, Clone)]
pub struct WpeRoot {
    pub kind: WpeRootKind,
    pub path: PathBuf,
}

/// WPE 的 Steam app id。
pub const WPE_STEAM_APP_ID: &str = "431960";

/// 当前平台是否提供 WPE 发现：暂只支持 Windows。
///
/// Linux 的 Steam 路径探测（[`steam_install_roots`]）保留但不再进入；macOS / Android / Web 不适用。
pub fn platform_supported() -> bool {
    platform_supported_on(std::env::consts::OS)
}

/// 按目标系统名（`std::env::consts::OS` 的取值）判定，单测在任一平台都能覆盖各分支。
fn platform_supported_on(os: &str) -> bool {
    os == "windows"
}

/// Steam 安装根目录（Windows 注册表 / Linux 常见路径）。
pub fn steam_install_roots() -> Vec<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        if let Some(path) = windows_steam_path() {
            return vec![path];
        }
        Vec::new()
    }
    #[cfg(target_os = "linux")]
    {
        let Some(home) = dirs::home_dir() else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for candidate in [".steam/steam", ".steam/root", ".local/share/Steam"] {
            let path = home.join(candidate);
            if path.is_dir() {
                out.push(path);
            }
        }
        out
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        Vec::new()
    }
}

#[cfg(target_os = "windows")]
fn windows_steam_path() -> Option<PathBuf> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let key = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey("Software\\Valve\\Steam")
        .ok()?;
    let raw: String = key.get_value("SteamPath").ok()?;
    let path = PathBuf::from(raw.trim().replace('/', "\\"));
    path.is_dir().then_some(path)
}

/// 解析 `libraryfolders.vdf`，返回 `(库路径, 是否含 WPE)`。
///
/// 兼容两种格式：新格式每个库是对象（`path` + `apps`），旧格式直接是 `"1" "D:\\..."`。
pub fn parse_library_folders(text: &str) -> Vec<(PathBuf, bool)> {
    let tokens = tokenize_vdf(text);
    // VDF 顶层没有花括号，是裸的「键 值」序列（通常只有一个 "libraryfolders" 键），
    // 所以按隐式对象体解析，不能要求首 token 是 `{`。
    let Some(root) = parse_vdf_body(&tokens, &mut 0usize, false) else {
        return Vec::new();
    };
    // 旧格式写作 "LibraryFolders"，键名不区分大小写。
    let Some(libraryfolders) = root
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case("libraryfolders"))
        .and_then(|(_, value)| value.as_object())
        .cloned()
    else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for (key, value) in &libraryfolders {
        // 库条目的键是序号（"0"、"1"…）；旧格式同级还有 TimeNextStatsReport 等统计字段，
        // 它们的值也是字符串，必须按键过滤掉。
        if !key.bytes().all(|byte| byte.is_ascii_digit()) {
            continue;
        }
        match value {
            Value::String(path) => {
                let path = normalize_vdf_path(path);
                if let Some(path) = path {
                    // 旧格式没有 apps 信息，交给调用方按目录是否存在决定。
                    out.push((path, true));
                }
            }
            Value::Object(entry) => {
                let Some(path) = entry
                    .get("path")
                    .and_then(Value::as_str)
                    .and_then(normalize_vdf_path)
                else {
                    continue;
                };
                let has_wpe = entry
                    .get("apps")
                    .and_then(Value::as_object)
                    .is_some_and(|apps| apps.contains_key(WPE_STEAM_APP_ID));
                out.push((path, has_wpe));
            }
            _ => {}
        }
    }
    out
}

fn normalize_vdf_path(raw: &str) -> Option<PathBuf> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let normalized = trimmed.replace("\\\\", "\\");
    let path = PathBuf::from(if cfg!(target_os = "windows") {
        normalized
    } else {
        trimmed.replace('\\', "/")
    });
    Some(path)
}

fn tokenize_vdf(text: &str) -> Vec<VdfToken> {
    let bytes = text.as_bytes();
    let mut tokens = Vec::new();
    let mut index = 0usize;
    while index < bytes.len() {
        match bytes[index] {
            b'{' => {
                tokens.push(VdfToken::Open);
                index += 1;
            }
            b'}' => {
                tokens.push(VdfToken::Close);
                index += 1;
            }
            b'"' => {
                index += 1;
                let start = index;
                while index < bytes.len() && bytes[index] != b'"' {
                    index += 1;
                }
                tokens.push(VdfToken::Str(
                    String::from_utf8_lossy(&bytes[start..index]).into_owned(),
                ));
                if index < bytes.len() {
                    index += 1;
                }
            }
            b'/' if bytes.get(index + 1) == Some(&b'/') => {
                while index < bytes.len() && bytes[index] != b'\n' {
                    index += 1;
                }
            }
            byte if byte.is_ascii_whitespace() => index += 1,
            _ => {
                let start = index;
                while index < bytes.len()
                    && !bytes[index].is_ascii_whitespace()
                    && !matches!(bytes[index], b'{' | b'}' | b'"')
                {
                    index += 1;
                }
                tokens.push(VdfToken::Str(
                    String::from_utf8_lossy(&bytes[start..index]).into_owned(),
                ));
            }
        }
    }
    tokens
}

enum VdfToken {
    Open,
    Close,
    Str(String),
}

/// 解析一个带花括号的 VDF 对象（`{ 键 值 ... }`）。
fn parse_vdf_object(tokens: &[VdfToken], cursor: &mut usize) -> Option<Map<String, Value>> {
    if !matches!(tokens.get(*cursor), Some(VdfToken::Open)) {
        return None;
    }
    *cursor += 1;
    parse_vdf_body(tokens, cursor, true)
}

/// 解析「键 值」序列。`braced` 为 true 时遇到 `}` 结束并消费它；为 false 时表示顶层
/// 隐式对象，读到 token 末尾结束，遇到多余的 `}` 视为格式错误。
fn parse_vdf_body(
    tokens: &[VdfToken],
    cursor: &mut usize,
    braced: bool,
) -> Option<Map<String, Value>> {
    let mut map = Map::new();
    loop {
        match tokens.get(*cursor) {
            None if !braced => return Some(map),
            Some(VdfToken::Close) if braced => {
                *cursor += 1;
                return Some(map);
            }
            Some(VdfToken::Str(key)) => {
                let key = key.clone();
                *cursor += 1;
                match tokens.get(*cursor) {
                    Some(VdfToken::Open) => {
                        let child = parse_vdf_object(tokens, cursor)?;
                        map.insert(key, Value::Object(child));
                    }
                    Some(VdfToken::Str(value)) => {
                        map.insert(key, Value::String(value.clone()));
                        *cursor += 1;
                    }
                    _ => return None,
                }
            }
            _ => return None,
        }
    }
}

/// 把某个 Steam 库展开成三类 WPE 根（仅保留实际存在的目录）。
pub fn roots_in_library(library: &Path) -> Vec<WpeRoot> {
    let mut roots = Vec::new();
    let workshop = library
        .join("steamapps")
        .join("workshop")
        .join("content")
        .join(WPE_STEAM_APP_ID);
    if workshop.is_dir() {
        roots.push(WpeRoot {
            kind: WpeRootKind::Workshop,
            path: workshop,
        });
    }

    let projects = library
        .join("steamapps")
        .join("common")
        .join("wallpaper_engine")
        .join("projects");
    for (kind, name) in [
        (WpeRootKind::DefaultProjects, "defaultprojects"),
        (WpeRootKind::MyProjects, "myprojects"),
    ] {
        let path = projects.join(name);
        if path.is_dir() {
            roots.push(WpeRoot { kind, path });
        }
    }
    roots
}

/// 发现全部 WPE 根：读 Steam 库列表 → 每个含 WPE 的库展开三类根。
pub fn discover_roots() -> Vec<WpeRoot> {
    if !platform_supported() {
        return Vec::new();
    }
    // 注册表里的 SteamPath 与 vdf 里的库路径大小写、分隔符常不一致（如
    // `d:/applications/steam` 对 `D:\Applications\Steam`），统一规范化后按 path_key 去重；
    // 先登记的胜出，所以 vdf 的 apps 判断优先于补登的安装根。
    let mut libraries: Vec<(PathBuf, bool)> = Vec::new();
    let mut push_library = |path: &Path, has_wpe: bool| {
        let Some(path) = super::normalize_local_dir(path) else {
            return;
        };
        let key = super::scan::path_key(&path.to_string_lossy());
        if !libraries
            .iter()
            .any(|(known, _)| super::scan::path_key(&known.to_string_lossy()) == key)
        {
            libraries.push((path, has_wpe));
        }
    };
    for steam_root in steam_install_roots() {
        let vdf = steam_root
            .join("steamapps")
            .join("libraryfolders.vdf");
        let Ok(text) = std::fs::read_to_string(&vdf) else {
            continue;
        };
        for (path, has_wpe) in parse_library_folders(&text) {
            push_library(&path, has_wpe);
        }
        // libraryfolders.vdf 可能不列 Steam 自身所在的库；补上安装根。
        push_library(&steam_root, true);
    }

    let mut roots: Vec<WpeRoot> = Vec::new();
    for (library, has_wpe) in libraries {
        // 新格式里明确没有 431960 的库跳过；旧格式（无 apps 信息）已按 true 处理。
        if !has_wpe {
            continue;
        }
        for root in roots_in_library(&library) {
            if roots
                .iter()
                .any(|existing| existing.kind == root.kind && existing.path == root.path)
            {
                continue;
            }
            roots.push(root);
        }
    }
    roots
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_supported_is_windows_only() {
        assert!(platform_supported_on("windows"));
        // 非 Windows 分支：Linux 不再进入 Steam 探测，其余平台本来就不适用
        for os in ["linux", "macos", "android", "ios", "freebsd"] {
            assert!(!platform_supported_on(os), "{os}");
        }
        assert_eq!(platform_supported(), cfg!(target_os = "windows"));
    }

    #[test]
    fn parses_new_library_folders_format() {
        let vdf = r#"
            "libraryfolders"
            {
                "0"
                {
                    "path"      "D:\\Applications\\Steam"
                    "label"     ""
                    "apps"
                    {
                        "431960"        "826555680"
                    }
                }
                "1"
                {
                    "path"      "E:\\SteamLibrary"
                    "apps"
                    {
                    }
                }
            }
        "#;
        let libraries = parse_library_folders(vdf);
        assert_eq!(libraries.len(), 2);
        assert_eq!(
            libraries[0].0.to_string_lossy().replace('\\', "/"),
            "D:/Applications/Steam"
        );
        assert!(libraries[0].1);
        assert!(!libraries[1].1);
    }

    #[test]
    fn parses_old_library_folders_format() {
        let vdf = r#"
            "LibraryFolders"
            {
                "TimeNextStatsReport" "123"
                "ContentStatsID" "456"
                "1" "D:\\SteamLibrary"
            }
        "#;
        let libraries = parse_library_folders(vdf);
        assert_eq!(libraries.len(), 1);
        assert_eq!(
            libraries[0].0.to_string_lossy().replace('\\', "/"),
            "D:/SteamLibrary"
        );
    }
}
