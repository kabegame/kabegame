//! CM（Steam 客户端协议）上的调用：用 refresh token 登录（`steam-vent`），查 PICS、取 depot 密钥、
//! manifest request code、CDN 服务器列表与 CDN 授权 token。照 SteamKit2 `SteamContent` / DepotDownloader。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Map, Value};
use steam_vent::{Connection, ConnectionError, ConnectionTrait, LoginError, ServerList};
use steam_vent_proto_steam::steammessages_clientserver_2::{
    CMsgClientGetDepotDecryptionKey, CMsgClientGetDepotDecryptionKeyResponse,
};
use steam_vent_proto_steam::steammessages_clientserver_appinfo::{
    cmsg_client_picsproduct_info_request, CMsgClientPICSAccessTokenRequest,
    CMsgClientPICSAccessTokenResponse, CMsgClientPICSProductInfoRequest,
    CMsgClientPICSProductInfoResponse,
};
use steam_vent_proto_steam::steammessages_contentsystem_steamclient::{
    CContentServerDirectory_GetCDNAuthToken_Request,
    CContentServerDirectory_GetManifestRequestCode_Request,
    CContentServerDirectory_GetServersForSteamPipe_Request,
};

use super::sessions::{self, SessionInfo};
use crate::wpe::discover::parse_vdf;

/// 连接失败的两种去向：会话失效（删掉会话、让用户重新登录）与其它（网络等，可重试）。
#[derive(Debug)]
pub enum CmError {
    SessionInvalid(String),
    Other(String),
}

impl std::fmt::Display for CmError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::SessionInvalid(message) | Self::Other(message) => f.write_str(message),
        }
    }
}

impl From<CmError> for String {
    fn from(error: CmError) -> Self {
        error.to_string()
    }
}

fn is_session_rejected(error: &ConnectionError) -> bool {
    matches!(
        error,
        ConnectionError::AccessToken(_)
            | ConnectionError::LoginError(
                LoginError::InvalidCredentials
                    | LoginError::Unknown(_)
                    | LoginError::InvalidSteamId
                    | LoginError::UnavailableAccount
            )
    )
}

/// 一次连 CM 最多等多久：WebSocket 偶尔连不上时系统要等 75 秒才超时，不如换一台服务器再试。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

/// 用已保存的会话登录 CM。会话不存在或被 Steam 拒绝时返回 [`CmError::SessionInvalid`] 并删掉会话；
/// 网络错误与超时重试三次（每次重新取服务器列表）。只由 [`shared_connection`] 调用。
async fn connect(account: &str) -> Result<Connection, CmError> {
    let session = sessions::load(account).ok_or_else(|| {
        CmError::SessionInvalid(format!("账号 {account} 没有可用的 Steam 登录，请重新登录"))
    })?;
    let mut last_error = String::new();
    for attempt in 0..3 {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_secs(2 * attempt)).await;
        }
        let servers = match ServerList::discover().await {
            Ok(servers) => servers,
            Err(error) => {
                last_error = format!("获取 Steam 服务器列表失败：{error}");
                continue;
            }
        };
        let login = Connection::access(&servers, &session.account, &session.refresh_token);
        match tokio::time::timeout(CONNECT_TIMEOUT, login).await {
            Ok(Ok(connection)) => {
                sessions::touch(account);
                return Ok(connection);
            }
            Ok(Err(error)) if is_session_rejected(&error) => {
                tracing::warn!("Steam 拒绝了账号 {account} 的登录：{error}");
                let _ = sessions::remove(account);
                return Err(CmError::SessionInvalid(format!(
                    "账号 {account} 的 Steam 登录已失效，请重新登录"
                )));
            }
            Ok(Err(error)) => {
                tracing::warn!("连接 Steam 失败（第 {} 次）：{error}", attempt + 1);
                last_error = format!("连接 Steam 失败：{error}");
            }
            Err(_) => {
                tracing::warn!("连接 Steam 超时（第 {} 次）", attempt + 1);
                last_error = "连接 Steam 超时".to_string();
            }
        }
    }
    Err(CmError::Other(last_error))
}

/// 没人在用的连接空闲多久后断开。
const IDLE: Duration = Duration::from_secs(5 * 60);

struct CachedConnection {
    connection: Arc<Connection>,
    last_used: std::time::Instant,
}

static SHARED: std::sync::LazyLock<tokio::sync::Mutex<HashMap<String, CachedConnection>>> =
    std::sync::LazyLock::new(Default::default);
static SWEEPER: std::sync::Once = std::sync::Once::new();

/// 账号的 CM 连接：每个账号只有一条，浏览订阅、复用前的验证、下载本体、下载工坊条目都用它。
///
/// steam-vent 登录时 login id（`obfuscated_private_ip`）固定为 0，同一账号再登录一条连接会把前一条踢下线，
/// 所以不能各连各的。还有人持有（任务在下载）时不回收；没人持有且空闲 [`IDLE`] 后断开。
/// 调用失败时由调用方 [`invalidate`] 再取，会重新登录。
pub async fn shared_connection(account: &str) -> Result<Arc<Connection>, CmError> {
    let mut cache = SHARED.lock().await;
    if let Some(cached) = cache.get_mut(account) {
        cached.last_used = std::time::Instant::now();
        return Ok(Arc::clone(&cached.connection));
    }
    let connection = Arc::new(connect(account).await?);
    cache.insert(
        account.to_string(),
        CachedConnection {
            connection: Arc::clone(&connection),
            last_used: std::time::Instant::now(),
        },
    );
    SWEEPER.call_once(|| {
        tokio::spawn(async {
            loop {
                tokio::time::sleep(Duration::from_secs(60)).await;
                SHARED.lock().await.retain(|_, cached| {
                    Arc::strong_count(&cached.connection) > 1 || cached.last_used.elapsed() < IDLE
                });
            }
        });
    });
    Ok(connection)
}

/// 这条连接不能用了（调用失败、被踢下线）：从缓存里拿掉，下次 [`shared_connection`] 重新登录。
/// 只拿掉同一条，已经换成新连接的不动。
pub async fn invalidate(connection: &Connection) {
    SHARED
        .lock()
        .await
        .retain(|_, cached| !std::ptr::eq(Arc::as_ptr(&cached.connection), connection));
}

/// 取共享连接并查 PICS（任务的第一步）。缓存里的连接可能已经断了：查询失败就作废它、重新登录再查一次。
pub async fn connect_and_build(account: &str, app_id: u32) -> Result<(Arc<Connection>, AppBuild), CmError> {
    let connection = shared_connection(account).await?;
    match app_build(&connection, app_id).await {
        Ok(build) => Ok((connection, build)),
        Err(CmError::Other(error)) => {
            tracing::info!("Steam 连接不可用（{error}），重新登录");
            invalidate(&connection).await;
            let connection = shared_connection(account).await?;
            let build = app_build(&connection, app_id).await?;
            Ok((connection, build))
        }
        Err(error) => Err(error),
    }
}

/// 拿掉某个账号的连接（换账号、删会话时）。
pub async fn forget_account(account: &str) {
    SHARED.lock().await.remove(account);
}

/// 复用前的验证：拿一次共享连接（HTTPS 的 `GenerateAccessTokenForApp` 对客户端 token 返回 AccountLogonDenied，不可用）。
/// 已有连接时再查一次 PICS 访问令牌，确认它还活着；死了就重新登录。
pub async fn verify_session(account: &str) -> Result<SessionInfo, CmError> {
    let connection = shared_connection(account).await?;
    let alive: Result<CMsgClientPICSAccessTokenResponse, _> = connection
        .job(CMsgClientPICSAccessTokenRequest {
            appids: vec![super::WPE_APP_ID],
            ..Default::default()
        })
        .await;
    if alive.is_err() {
        invalidate(&connection).await;
        shared_connection(account).await?;
    }
    sessions::list()
        .into_iter()
        .find(|info| info.account == account)
        .ok_or_else(|| CmError::SessionInvalid(format!("账号 {account} 的 Steam 登录已失效，请重新登录")))
}

/// PICS 里的一个可下载 depot（public 分支）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DepotInfo {
    pub depot_id: u32,
    pub manifest_id: u64,
    /// 解压后的总字节数（PICS 的 `size`）。
    pub size: u64,
    /// 需下载的字节数（PICS 的 `download`）。
    pub download: u64,
}

/// 应用的 public 分支信息。
#[derive(Debug, Clone)]
pub struct AppBuild {
    pub build_id: String,
    pub depots: Vec<DepotInfo>,
    /// 创意工坊条目所在的 depot（`depots.workshopdepot`）；没写时照 DepotDownloader 用 app id 本身。
    pub workshop_depot: Option<u32>,
}

fn map_err<E: std::fmt::Display>(what: &str) -> impl FnOnce(E) -> CmError + '_ {
    move |error| CmError::Other(format!("{what}失败：{error}"))
}

/// 查 PICS：先取 app access token，再取 product info，解析 public 分支的 depot 与 manifest。
pub async fn app_build(connection: &Connection, app_id: u32) -> Result<AppBuild, CmError> {
    let tokens: CMsgClientPICSAccessTokenResponse = connection
        .job(CMsgClientPICSAccessTokenRequest {
            appids: vec![app_id],
            ..Default::default()
        })
        .await
        .map_err(map_err("获取 PICS 访问令牌"))?;
    if tokens.app_denied_tokens.contains(&app_id) {
        return Err(CmError::Other(
            "这个 Steam 账号没有 Wallpaper Engine（app 431960），需要先在 Steam 购买".to_string(),
        ));
    }
    let access_token = tokens
        .app_access_tokens
        .iter()
        .find(|token| token.appid() == app_id)
        .map(|token| token.access_token());
    let info: CMsgClientPICSProductInfoResponse = connection
        .job(CMsgClientPICSProductInfoRequest {
            apps: vec![cmsg_client_picsproduct_info_request::AppInfo {
                appid: Some(app_id),
                access_token,
                only_public_obsolete: Some(false),
                ..Default::default()
            }],
            meta_data_only: Some(false),
            single_response: Some(true),
            ..Default::default()
        })
        .await
        .map_err(map_err("查询应用信息"))?;
    let app = info
        .apps
        .iter()
        .find(|app| app.appid() == app_id)
        .ok_or_else(|| CmError::Other("Steam 没有返回 Wallpaper Engine 的应用信息".to_string()))?;
    let text = String::from_utf8_lossy(app.buffer());
    parse_app_build(text.trim_matches('\0'))
        .ok_or_else(|| CmError::Other("解析 Wallpaper Engine 的应用信息失败".to_string()))
}

/// 从 PICS 的 VDF 里取 public 分支：depot 键是数字、有 `manifests.public.gid`；
/// 跳过只给 `steamchina` 区域的、`oslist` 不含 windows 的、借用别的 app 的（`depotfromapp`）与 DLC 的。
pub(crate) fn parse_app_build(text: &str) -> Option<AppBuild> {
    let root = parse_vdf(text)?;
    let app = root.get("appinfo").and_then(Value::as_object).unwrap_or(&root);
    let depots = app.get("depots").and_then(Value::as_object)?;
    let build_id = depots
        .get("branches")
        .and_then(|b| b.get("public"))
        .and_then(|p| p.get("buildid"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let str_at = |entry: &Map<String, Value>, path: &[&str]| -> Option<String> {
        let mut value = entry.get(path[0])?;
        for key in &path[1..] {
            value = value.get(*key)?;
        }
        value.as_str().map(str::to_string)
    };
    let workshop_depot = depots
        .get("workshopdepot")
        .and_then(Value::as_str)
        .and_then(|id| id.parse::<u32>().ok())
        .filter(|id| *id != 0);
    let mut out = Vec::new();
    for (key, entry) in depots {
        let (Ok(depot_id), Some(entry)) = (key.parse::<u32>(), entry.as_object()) else {
            continue;
        };
        if entry.contains_key("depotfromapp") || entry.contains_key("dlcappid") {
            continue;
        }
        if str_at(entry, &["config", "realm"]).is_some_and(|realm| realm.eq_ignore_ascii_case("steamchina")) {
            continue;
        }
        if str_at(entry, &["config", "oslist"])
            .is_some_and(|os| !os.is_empty() && !os.split(',').any(|o| o.trim() == "windows"))
        {
            continue;
        }
        let Some(manifest_id) =
            str_at(entry, &["manifests", "public", "gid"]).and_then(|gid| gid.parse::<u64>().ok())
        else {
            continue;
        };
        let number = |field: &str| {
            str_at(entry, &["manifests", "public", field])
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or_default()
        };
        out.push(DepotInfo {
            depot_id,
            manifest_id,
            size: number("size"),
            download: number("download"),
        });
    }
    out.sort_by_key(|depot| depot.depot_id);
    Some(AppBuild {
        build_id,
        depots: out,
        workshop_depot,
    })
}

pub async fn depot_key(connection: &Connection, app_id: u32, depot_id: u32) -> Result<Vec<u8>, CmError> {
    let rsp: CMsgClientGetDepotDecryptionKeyResponse = connection
        .job(CMsgClientGetDepotDecryptionKey {
            depot_id: Some(depot_id),
            app_id: Some(app_id),
            ..Default::default()
        })
        .await
        .map_err(map_err("获取 depot 密钥"))?;
    if rsp.eresult() != 1 {
        return Err(CmError::Other(format!(
            "获取 depot {depot_id} 的密钥失败（EResult {}），账号可能没有这个应用",
            rsp.eresult()
        )));
    }
    Ok(rsp.depot_encryption_key().to_vec())
}

/// manifest request code，约 5 分钟有效。照 SteamKit2：public 分支的 `app_branch` 留空（传 "public" 拿到的码无效）。
pub async fn manifest_request_code(
    connection: &Connection,
    app_id: u32,
    depot_id: u32,
    manifest_id: u64,
) -> Result<u64, CmError> {
    let code = connection
        .service_method(CContentServerDirectory_GetManifestRequestCode_Request {
            app_id: Some(app_id),
            depot_id: Some(depot_id),
            manifest_id: Some(manifest_id),
            app_branch: None,
            ..Default::default()
        })
        .await
        .map_err(map_err("获取 manifest 请求码"))?
        .manifest_request_code();
    if code == 0 {
        return Err(CmError::Other(format!("Steam 没有发给 depot {depot_id} 的 manifest 请求码")));
    }
    Ok(code)
}

/// 一台内容服务器。照 SteamKit2 `ConvertServerList` / `BuildCommand`：URL 主机用 vhost，
/// `https_support` 为 `mandatory` 才走 https，否则 http；CDN 授权 token 按 `host` 申请。
#[derive(Debug, Clone)]
pub struct CdnServer {
    pub host: String,
    pub base_url: String,
}

pub async fn cdn_servers(connection: &Connection, app_id: u32) -> Result<Vec<CdnServer>, CmError> {
    let mut servers = connection
        .service_method(CContentServerDirectory_GetServersForSteamPipe_Request {
            cell_id: Some(connection.cell_id()),
            ..Default::default()
        })
        .await
        .map_err(map_err("获取下载服务器"))?
        .servers;
    servers.retain(|server| {
        matches!(server.type_(), "SteamCache" | "CDN")
            && (server.allowed_app_ids.is_empty() || server.allowed_app_ids.contains(&app_id))
    });
    servers.sort_by(|a, b| a.weighted_load().total_cmp(&b.weighted_load()));
    let out: Vec<CdnServer> = servers
        .iter()
        .map(|server| {
            let scheme = if server.https_support() == "mandatory" { "https" } else { "http" };
            CdnServer {
                host: server.host().to_string(),
                base_url: format!("{scheme}://{}", server.vhost()),
            }
        })
        .collect();
    if out.is_empty() {
        return Err(CmError::Other("Steam 没有分配可用的下载服务器".to_string()));
    }
    Ok(out)
}

/// 某台服务器上某个 depot 的 CDN 授权 token（原样作为 query 拼在 URL 后）。
pub async fn cdn_auth_token(
    connection: &Connection,
    app_id: u32,
    depot_id: u32,
    host: &str,
) -> Result<String, CmError> {
    let token = connection
        .service_method(CContentServerDirectory_GetCDNAuthToken_Request {
            app_id: Some(app_id),
            depot_id: Some(depot_id),
            host_name: Some(host.to_string()),
            ..Default::default()
        })
        .await
        .map_err(map_err("获取 CDN 授权"))?
        .token()
        .trim_start_matches('?')
        .to_string();
    Ok(token)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 取自 2026-11-15 实测的 431960 PICS 结构（删减）。
    const SAMPLE: &str = r#""appinfo"
{
	"appid"		"431960"
	"depots"
	{
		"workshopdepot"		"431960"
		"431961"
		{
			"manifests"
			{
				"public" { "gid" "5060075082323178717" "size" "826555680" "download" "377269744" }
				"beta" { "gid" "7003604965956812188" }
			}
		}
		"431966"
		{
			"config" { "realm" "steamchina" }
			"manifests" { "public" { "gid" "5369633619945201395" } }
		}
		"431967"
		{
			"config" { "oslist" "macos" }
			"manifests" { "public" { "gid" "1" } }
		}
		"431968"
		{
			"depotfromapp" "228980"
			"manifests" { "public" { "gid" "2" } }
		}
		"branches"
		{
			"public" { "buildid" "26168761" }
			"beta" { "buildid" "26649179" "description" "a \"quoted\" note" }
		}
	}
}"#;

    #[test]
    fn picks_public_windows_depots_only() {
        let build = parse_app_build(SAMPLE).unwrap();
        assert_eq!(build.build_id, "26168761");
        assert_eq!(build.workshop_depot, Some(431960));
        assert_eq!(
            build.depots,
            vec![DepotInfo {
                depot_id: 431961,
                manifest_id: 5060075082323178717,
                size: 826555680,
                download: 377269744,
            }]
        );
    }
}
