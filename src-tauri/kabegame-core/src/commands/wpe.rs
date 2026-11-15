//! 「壁纸」收集入口的只读命令：扫描自动来源 / 识别用户选中的目录。

use serde_json::Value;
use std::collections::HashSet;
use std::path::Path;

use crate::storage::Storage;
use crate::wpe::scan::{path_key, scan_extra_dir, scan_sources};

fn imported_paths() -> HashSet<String> {
    Storage::global()
        .list_wpe_local_paths()
        .unwrap_or_default()
        .into_iter()
        .map(|path| path_key(&path))
        .collect()
}

/// 扫描自动发现的 Steam 库来源（创意工坊 / 官方默认 / 我的项目）。
pub fn scan_wpe_sources() -> Result<Value, String> {
    let result = scan_sources(&imported_paths());
    serde_json::to_value(result).map_err(|error| error.to_string())
}

/// 「从 Steam 拉取」卡片的状态：当前 WPE 目录、它是否是 Kabegame 管理的那份、已装信息、可复用的登录。
/// 先跑一次自动查找（会把 Steam 库里的 WPE 写进设置）。阻塞调用。
pub fn wpe_steam_status() -> Result<Value, String> {
    use crate::wpe::steam::{install, managed_engine_dir, sessions};
    let engine_dir = crate::wpe::discover::engine_dir();
    let setting = crate::settings::Settings::global().get_wpe_engine_dir();
    let engine_is_managed = setting
        .as_deref()
        .is_some_and(|dir| install::is_managed_engine_dir(Path::new(dir)));
    Ok(serde_json::json!({
        // 设置里的目录（可能已失效）与它是否可用
        "engineDir": setting,
        "engineValid": engine_dir.is_some(),
        "engineIsManaged": engine_is_managed,
        "managedEngineDir": managed_engine_dir().map(|dir| dir.to_string_lossy().into_owned()),
        "managedInstall": install::managed_install_info(),
        "sessions": sessions::list(),
    }))
}

/// 复用前验证一个已存的登录：连一次 CM。失效时会话被删掉、返回错误。
pub async fn wpe_steam_verify_session(account: String) -> Result<Value, String> {
    let info = crate::wpe::steam::cm::verify_session(&account).await?;
    serde_json::to_value(info).map_err(|error| error.to_string())
}

/// 删掉一个已存的登录（「换个账号」「退出」）。
pub async fn wpe_steam_forget_session(account: String) -> Result<(), String> {
    crate::wpe::steam::cm::forget_account(&account).await;
    crate::wpe::steam::sessions::remove(&account)
}

pub async fn wpe_steam_login_qr() -> Result<Value, String> {
    let start = crate::wpe::steam::auth::begin_qr().await?;
    serde_json::to_value(start).map_err(|error| error.to_string())
}

pub async fn wpe_steam_login_credentials(account: String, password: String) -> Result<Value, String> {
    let start = crate::wpe::steam::auth::begin_credentials(&account, &password).await?;
    serde_json::to_value(start).map_err(|error| error.to_string())
}

pub async fn wpe_steam_login_submit_code(login_id: String, code: String, kind: String) -> Result<(), String> {
    crate::wpe::steam::auth::submit_code(&login_id, &code, &kind).await
}

pub async fn wpe_steam_login_poll(login_id: String) -> Result<Value, String> {
    let poll = crate::wpe::steam::auth::poll(&login_id).await?;
    serde_json::to_value(poll).map_err(|error| error.to_string())
}

pub fn wpe_steam_login_cancel(login_id: String) {
    crate::wpe::steam::auth::cancel(&login_id);
}

/// 用账号的共享 CM 连接取一页条目；调用失败时作废连接、重新登录再取一次（连接可能已被 Steam 断开）。
/// 取到后补上每条在本地的状态。
async fn workshop_page<F, Fut>(account: &str, fetch: F) -> Result<Value, String>
where
    F: Fn(std::sync::Arc<steam_vent::Connection>) -> Fut,
    Fut: std::future::Future<Output = Result<crate::wpe::steam::workshop::WorkshopPage, crate::wpe::steam::cm::CmError>>,
{
    use crate::wpe::steam::{cm, workshop};
    let mut result = Err(cm::CmError::Other(String::new()));
    for _ in 0..2 {
        let connection = cm::shared_connection(account).await?;
        result = fetch(std::sync::Arc::clone(&connection)).await;
        if result.is_ok() {
            break;
        }
        cm::invalidate(&connection).await;
    }
    let mut page = result?;
    let page = tokio::task::spawn_blocking(move || {
        let engine = crate::wpe::steam::target_engine_dir();
        workshop::fill_local_state(engine.as_deref(), &mut page.items);
        page
    })
    .await
    .map_err(|error| error.to_string())?;
    serde_json::to_value(page).map_err(|error| error.to_string())
}

/// 「从 Steam 导入」的订阅列表：一页订阅（分页、排序、分级筛选都由 Steam 做）加上每条在本地的状态。
pub async fn wpe_steam_subscriptions(
    account: String,
    page: u32,
    per_page: u32,
    sort: Option<String>,
    ratings: Option<Vec<String>>,
) -> Result<Value, String> {
    use crate::wpe::steam::workshop::{self, SubscriptionSort};
    let sort = match sort.as_deref() {
        None | Some("lastUpdated") => SubscriptionSort::LastUpdated,
        Some("subscriptionDate") => SubscriptionSort::SubscriptionDate,
        Some(other) => return Err(format!("未知的排序方式：{other}")),
    };
    let ratings = ratings.unwrap_or_default();
    workshop_page(&account, |connection| {
        let ratings = ratings.clone();
        async move { workshop::subscriptions_page(&connection, page, per_page, sort, &ratings).await }
    })
    .await
}

/// 「从 Steam 导入」的工坊发现：一页创意工坊条目（排序、搜索、分级 / 类型筛选都由 Steam 做）加上每条在本地的状态。
/// 搜索文字整段是条目 id / 工坊链接时改为按 id 查（见 [`crate::wpe::steam::workshop::parse_item_ids`]）。
#[allow(clippy::too_many_arguments)]
pub async fn wpe_steam_workshop_query(
    account: String,
    page: u32,
    per_page: u32,
    sort: Option<String>,
    days: Option<u32>,
    text: Option<String>,
    ratings: Option<Vec<String>>,
    kinds: Option<Vec<String>>,
) -> Result<Value, String> {
    use crate::wpe::steam::workshop::{self, DiscoverQuery, DiscoverSort};
    let sort = match sort.as_deref() {
        None | Some("trend") => DiscoverSort::Trend,
        Some("mostSubscribed") => DiscoverSort::MostSubscribed,
        Some("topRated") => DiscoverSort::TopRated,
        Some("newest") => DiscoverSort::Newest,
        Some("recentlyUpdated") => DiscoverSort::RecentlyUpdated,
        Some("relevance") => DiscoverSort::Relevance,
        Some(other) => return Err(format!("未知的排序方式：{other}")),
    };
    let query = DiscoverQuery {
        page,
        per_page,
        sort,
        days,
        text,
        ratings: ratings.unwrap_or_default(),
        kinds: kinds.unwrap_or_default(),
    };
    // 搜索框里是条目 id 或工坊链接：直接按 id 查，不看排序与筛选
    if let Some(ids) = query.text.as_deref().and_then(workshop::parse_item_ids) {
        return workshop_page(&account, |connection| {
            let ids = ids.clone();
            async move { workshop::details_page(&connection, &ids).await }
        })
        .await;
    }
    workshop_page(&account, |connection| {
        let query = query.clone();
        async move { workshop::discover_page(&connection, &query).await }
    })
    .await
}

/// 识别一个用户选中的文件夹，返回它展开后的壁纸数量。
pub fn recognize_wpe_dir(path: String) -> Result<Value, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("路径不能为空".to_string());
    }
    let info = scan_extra_dir(Path::new(trimmed), &imported_paths())?;
    serde_json::to_value(info).map_err(|error| error.to_string())
}
