//! 桌面端应用自动更新 —— GitHub Release。
//!
//! 仅桌面 Tauri 栈、非 Android 编译（见 `lib.rs` 的 cfg 门禁）。
//! - `github`/`asset`：拉取 releases、计算错过版本（≤5）、匹配下载 asset（查询层）。
//! - `service`：`UpdaterService` 全局单例，后端权威状态机 + 调度 + 广播（仿 OrganizeService）。
//! - `download`：流式下载到临时目录 + 进度/错误事件 + 取消。
//! - `install`：平台安装 + 重启（Phase 6）。

mod asset;
mod download;
mod github;
#[cfg(not(target_os = "android"))]
mod install;
mod service;

pub use download::download_update;
#[cfg(not(target_os = "android"))]
pub use install::apply as apply_update;
pub use service::{spawn_schedule, UpdaterService, UpdaterState};

use serde::Serialize;

/// 错过版本计算上限：最多保留最新的 5 个。
pub const MAX_RELEASES: usize = 5;

/// 单个 GitHub release 对前端暴露的信息。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseInfo {
    /// 原始 tag（带 `v` 前缀，如 `v4.1.1`）；下载 URL 路径与展示均用它。
    pub tag: String,
    /// release 名称；为空时回退为 `tag`。
    pub name: String,
    /// changelog markdown 原文。
    pub body: String,
    /// 该 release 的 GitHub 页面。
    pub html_url: String,
    /// 发布时间（ISO8601 原样透传）。
    pub published_at: String,
    /// 匹配到的当前平台/模式/架构下载直链；无则 `None`。
    pub asset_url: Option<String>,
    pub asset_name: Option<String>,
}

/// `check_for_updates` 命令返回结构。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    /// 当前运行版本（`env!("CARGO_PKG_VERSION")`，无 `v` 前缀）。
    pub current_version: String,
    /// "windows" | "macos" | "linux"。
    pub platform: String,
    /// "standard" | "light"。
    pub mode: String,
    /// "x64" | "aarch64" | 原始 target_arch。
    pub arch: String,
    /// 是否有更新（等价于 `!releases.is_empty()`）。
    pub has_update: bool,
    /// 最新一版是否匹配到当前平台/模式/架构的 asset（即可下载）。
    pub downloadable: bool,
    /// 错过版本，最新在前，≤ [`MAX_RELEASES`]。
    pub releases: Vec<ReleaseInfo>,
}

/// 当前运行平台（编译期决定）。
pub fn current_platform() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "windows"
    }
    #[cfg(target_os = "macos")]
    {
        "macos"
    }
    #[cfg(target_os = "linux")]
    {
        "linux"
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        "unknown"
    }
}

/// 当前构建模式（编译期由 Cargo feature 决定）。
pub fn current_mode() -> &'static str {
    #[cfg(feature = "light")]
    {
        "light"
    }
    #[cfg(not(feature = "light"))]
    {
        "standard"
    }
}

/// 当前架构，映射到 asset 命名所用 token。
pub fn current_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "aarch64",
        other => other,
    }
}

/// GitHub tag 形如 `v4.1.1`，而 `CARGO_PKG_VERSION` 是 `4.1.1`（无 `v`）。
/// 比较前两边都剥掉前导 `v`，避免把当前版本误判为更新。
pub fn norm_tag(tag: &str) -> &str {
    tag.strip_prefix('v').unwrap_or(tag)
}

/// 语义化版本比较（两边可带或不带 `v` 前缀）。
///
/// 仅做发布版本的数值比较：按 `.` 分段，取各段前导数字逐段比较，缺失段视为 0，
/// 忽略 `-pre`/`+build` 等后缀（剥到首个 `-`/`+`）。用于判断某 release 是否
/// **严格新于**当前运行版本——仅靠 tag 相等无法处理「当前版本高于线上最新」
/// （此时不应把任何旧版本当作更新）的场景。
pub fn cmp_version(a: &str, b: &str) -> std::cmp::Ordering {
    fn core(v: &str) -> &str {
        let v = v.strip_prefix('v').unwrap_or(v);
        v.split(['-', '+']).next().unwrap_or(v)
    }
    fn seg(s: &str) -> u64 {
        let digits: String = s.chars().take_while(|c| c.is_ascii_digit()).collect();
        digits.parse().unwrap_or(0)
    }
    let (a, b) = (core(a), core(b));
    let mut ai = a.split('.');
    let mut bi = b.split('.');
    loop {
        match (ai.next(), bi.next()) {
            (None, None) => return std::cmp::Ordering::Equal,
            (av, bv) => {
                let ord = seg(av.unwrap_or("0")).cmp(&seg(bv.unwrap_or("0")));
                if ord != std::cmp::Ordering::Equal {
                    return ord;
                }
            }
        }
    }
}

/// 查询更新：拉取 releases → 计算错过版本（含 asset 匹配）→ 组装结果。
pub async fn check_updates() -> Result<UpdateCheckResult, String> {
    let current = env!("CARGO_PKG_VERSION").to_string();
    let platform = current_platform().to_string();
    let mode = current_mode().to_string();
    let arch = current_arch().to_string();

    let raw = github::fetch_releases().await?;
    let releases = github::compute_missed(&current, &raw, &platform, &mode, &arch);

    let downloadable = releases
        .first()
        .map(|r| r.asset_url.is_some())
        .unwrap_or(false);

    Ok(UpdateCheckResult {
        current_version: current,
        platform,
        mode,
        arch,
        has_update: !releases.is_empty(),
        downloadable,
        releases,
    })
}
