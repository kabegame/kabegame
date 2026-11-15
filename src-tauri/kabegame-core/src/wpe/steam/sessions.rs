//! 已登录的 Steam 会话：存在 `wpe-import` 插件数据的宿主私有区（[`crate::storage::plugin_data::PRIVATE_KEY`]），
//! 插件脚本、界面与 web 调度都读不到。
//!
//! 私有区里的形状：
//! ```json
//! { "steamSessions": { "<账号>": { "refreshToken": "…", "steamId": "…", "expiresAt": 1812874175,
//!                                  "guardData": "…", "savedAt": 1794714051 } },
//!   "steamLastAccount": "<账号>" }
//! ```
//! 对外（[`SessionInfo`]）只有账号、steamId 与过期时间；refresh token 是 JWT，过期时间取它的 `exp`，不用联网。
//! `exp` 只是上限：用户在 Steam 里取消设备授权、改密码都会让它提前失效，所以复用前还要
//! [`super::cm::verify_session`] 连一次 CM。

use serde::Serialize;
use serde_json::{json, Map, Value};

use super::crypto::jwt_claims;
use crate::storage::Storage;
use crate::wpe::WPE_IMPORT_PLUGIN_ID;

const SESSIONS_KEY: &str = "steamSessions";
const LAST_ACCOUNT_KEY: &str = "steamLastAccount";

/// 对外的会话信息（不含 token）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub account: String,
    pub steam_id: String,
    /// refresh token 的 `exp`（Unix 秒）。
    pub expires_at: u64,
}

/// 任务里用的完整会话。
pub struct StoredSession {
    pub account: String,
    pub refresh_token: String,
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn read_private() -> Map<String, Value> {
    Storage::global()
        .plugin_data()
        .get_private(WPE_IMPORT_PLUGIN_ID)
        .unwrap_or_else(|error| {
            tracing::warn!("读取 Steam 会话失败：{error}");
            Map::new()
        })
}

fn info_of(account: &str, entry: &Value) -> Option<SessionInfo> {
    Some(SessionInfo {
        account: account.to_string(),
        steam_id: entry.get("steamId")?.as_str()?.to_string(),
        expires_at: entry.get("expiresAt")?.as_u64()?,
    })
}

/// 未过期的会话，最近用过的账号排第一。
pub fn list() -> Vec<SessionInfo> {
    let private = read_private();
    let last = private.get(LAST_ACCOUNT_KEY).and_then(Value::as_str).unwrap_or("");
    let now = now_secs();
    let mut out: Vec<SessionInfo> = private
        .get(SESSIONS_KEY)
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter_map(|(account, entry)| info_of(account, entry))
        .filter(|info| info.expires_at > now)
        .collect();
    out.sort_by_key(|info| (info.account != last, info.account.to_lowercase()));
    out
}

/// 取一个账号的完整会话；不存在或已过期时为 None。
pub fn load(account: &str) -> Option<StoredSession> {
    let private = read_private();
    let entry = private.get(SESSIONS_KEY)?.get(account)?;
    let info = info_of(account, entry)?;
    if info.expires_at <= now_secs() {
        return None;
    }
    Some(StoredSession {
        account: account.to_string(),
        refresh_token: entry.get("refreshToken")?.as_str()?.to_string(),
    })
}

/// 账号密码登录时带上的 Steam Guard 机器数据。
pub fn guard_data(account: &str) -> Option<String> {
    read_private()
        .get(SESSIONS_KEY)?
        .get(account)?
        .get("guardData")?
        .as_str()
        .map(str::to_string)
}

/// 保存登录结果。refresh token 必须是带 `client` 用途的 JWT，否则 CM 登录不了。
pub fn save(account: &str, refresh_token: &str, guard_data: Option<&str>) -> Result<SessionInfo, String> {
    let claims = jwt_claims(refresh_token).ok_or("Steam 返回的 token 无法解析")?;
    let is_client = claims
        .get("aud")
        .and_then(Value::as_array)
        .is_some_and(|aud| aud.iter().any(|a| a.as_str() == Some("client")));
    if !is_client {
        return Err("Steam 返回的 token 不能用于客户端登录".to_string());
    }
    let info = SessionInfo {
        account: account.to_string(),
        steam_id: claims.get("sub").and_then(Value::as_str).unwrap_or_default().to_string(),
        expires_at: claims.get("exp").and_then(Value::as_u64).unwrap_or_default(),
    };
    Storage::global()
        .plugin_data()
        .update_private(WPE_IMPORT_PLUGIN_ID, |private| {
            let sessions = private
                .entry(SESSIONS_KEY)
                .or_insert_with(|| Value::Object(Map::new()));
            if !sessions.is_object() {
                *sessions = Value::Object(Map::new());
            }
            let sessions = sessions.as_object_mut().unwrap();
            // 新的登录没给机器数据时沿用旧的
            let previous_guard = sessions
                .get(account)
                .and_then(|entry| entry.get("guardData"))
                .cloned();
            let guard = guard_data
                .map(|value| Value::String(value.to_string()))
                .or(previous_guard);
            let mut entry = json!({
                "refreshToken": refresh_token,
                "steamId": info.steam_id,
                "expiresAt": info.expires_at,
                "savedAt": now_secs(),
            });
            if let Some(guard) = guard {
                entry["guardData"] = guard;
            }
            sessions.insert(account.to_string(), entry);
            private.insert(LAST_ACCOUNT_KEY.to_string(), Value::String(account.to_string()));
        })
        .map_err(|error| format!("保存 Steam 会话失败：{error}"))?;
    Ok(info)
}

/// 记下最近用过的账号（任务开始时）。
pub fn touch(account: &str) {
    let _ = Storage::global()
        .plugin_data()
        .update_private(WPE_IMPORT_PLUGIN_ID, |private| {
            private.insert(LAST_ACCOUNT_KEY.to_string(), Value::String(account.to_string()));
        });
}

/// 删掉一个账号的会话（失效或用户登出）。Steam Guard 机器数据保留，下次账号密码登录少一次邮箱验证。
pub fn remove(account: &str) -> Result<(), String> {
    Storage::global()
        .plugin_data()
        .update_private(WPE_IMPORT_PLUGIN_ID, |private| {
            if let Some(entry) = private
                .get_mut(SESSIONS_KEY)
                .and_then(Value::as_object_mut)
                .and_then(|sessions| sessions.get_mut(account))
                .and_then(Value::as_object_mut)
            {
                entry.remove("refreshToken");
                entry.remove("expiresAt");
                entry.remove("steamId");
                entry.remove("savedAt");
                if entry.is_empty() {
                    private
                        .get_mut(SESSIONS_KEY)
                        .and_then(Value::as_object_mut)
                        .map(|sessions| sessions.remove(account));
                }
            }
        })
        .map_err(|error| format!("删除 Steam 会话失败：{error}"))
}
