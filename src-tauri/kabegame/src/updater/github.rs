//! GitHub releases 拉取与错过版本计算。

use serde::Deserialize;
use std::time::Duration;

use super::{asset, cmp_version, ReleaseInfo, MAX_RELEASES};

const RELEASES_API: &str = "https://api.github.com/repos/kabegame/kabegame/releases?per_page=30";
const USER_AGENT: &str = "kabegame-updater";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

/// GitHub release 原始结构（只反序列化用到的字段，其余忽略）。
#[derive(Debug, Clone, Deserialize)]
pub struct RawRelease {
    pub tag_name: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub html_url: String,
    #[serde(default)]
    pub published_at: String,
    #[serde(default)]
    pub draft: bool,
    #[serde(default)]
    pub assets: Vec<RawAsset>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RawAsset {
    pub name: String,
    pub browser_download_url: String,
}

/// 拉取 releases 列表（GitHub 默认按发布时间倒序，最新在前）。
pub async fn fetch_releases() -> Result<Vec<RawRelease>, String> {
    let mut builder = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .redirect(reqwest::redirect::Policy::default());
    // 复用全局代理配置（与 proxy_fetch 一致），照顾代理环境用户。
    if let Some(ref proxy_url) = kabegame_core::crawler::proxy::get_proxy_config().proxy_url {
        if let Ok(proxy) = reqwest::Proxy::all(proxy_url) {
            builder = builder.proxy(proxy);
        }
    }
    let client = builder.build().map_err(|e| e.to_string())?;

    let resp = client
        .get(RELEASES_API)
        // GitHub 强制要求 User-Agent，缺失会 403。
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        // 避免中间层/CDN 缓存导致编辑过的 release notes 不刷新
        .header(reqwest::header::CACHE_CONTROL, "no-cache")
        .send()
        .await
        .map_err(|e| format!("请求 GitHub releases 失败: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("GitHub releases 返回状态 {}", resp.status()));
    }

    resp.json::<Vec<RawRelease>>()
        .await
        .map_err(|e| format!("解析 GitHub releases 失败: {e}"))
}

/// 计算错过版本：从最新向下收集**严格新于**当前版本的 release，跳过草稿，
/// 最多 [`MAX_RELEASES`] 个。
///
/// 用语义化比较而非 tag 相等，避免当前版本高于线上最新时（如本地 4.2.0、
/// 线上仅到 v4.1.1）把一串旧版本误当作更新列出。GitHub 默认按发布时间倒序，
/// 一般与版本序一致；为稳妥起见对每个 release 单独比较，而非命中即停。
pub fn compute_missed(
    current: &str,
    raw_list: &[RawRelease],
    platform: &str,
    mode: &str,
    arch: &str,
) -> Vec<ReleaseInfo> {
    let mut out = Vec::new();
    for r in raw_list {
        if r.draft {
            continue;
        }
        if cmp_version(&r.tag_name, current) != std::cmp::Ordering::Greater {
            continue; // 与当前版本相同或更旧，不算更新
        }
        out.push(to_release_info(r, platform, mode, arch));
        if out.len() == MAX_RELEASES {
            break;
        }
    }
    out
}

fn to_release_info(r: &RawRelease, platform: &str, mode: &str, arch: &str) -> ReleaseInfo {
    let matched = asset::match_asset(&r.assets, platform, mode, arch);
    let tag = r.tag_name.clone();
    let name = r
        .name
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| tag.clone());
    ReleaseInfo {
        tag,
        name,
        body: r.body.clone().unwrap_or_default(),
        html_url: r.html_url.clone(),
        published_at: r.published_at.clone(),
        asset_url: matched.as_ref().map(|(_, url)| url.clone()),
        asset_name: matched.map(|(name, _)| name),
    }
}
