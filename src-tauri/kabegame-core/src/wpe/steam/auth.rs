//! 对话框里的 Steam 登录：每一步是一次 HTTPS 调用 `IAuthenticationService`，待完成的登录只在内存里（带超时）。
//!
//! - 扫码：`BeginAuthSessionViaQR` → 前端显示二维码 → 轮询 `PollAuthSessionStatus`（二维码会刷新）。
//! - 账号密码：`GetPasswordRSAPublicKey` → `BeginAuthSessionViaCredentials`（密码 RSA PKCS#1 v1.5 加密）→
//!   需要验证码时 `UpdateAuthSessionWithSteamGuardCode` → 轮询。手机确认不用输入，轮询即可。
//!
//! 都以 `SteamClient` 平台类型发起，拿到的 refresh token 才能登录 CM（2026-11-15 实测 `aud` 含 `client`）。
//! 成功后交给 [`super::sessions::save`]，密码只在这一次调用里经过内存。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::prelude::BASE64_STANDARD;
use base64::Engine;
use rsa::{BigUint, Pkcs1v15Encrypt, RsaPublicKey};
use serde::Serialize;
use steam_vent_proto_common::protobuf::{EnumOrUnknown, Message, MessageField};
use steam_vent_proto_steam::enums::ESessionPersistence;
use steam_vent_proto_steam::steammessages_auth_steamclient::{
    CAuthentication_AllowedConfirmation, CAuthentication_BeginAuthSessionViaCredentials_Request,
    CAuthentication_BeginAuthSessionViaCredentials_Response, CAuthentication_BeginAuthSessionViaQR_Request,
    CAuthentication_BeginAuthSessionViaQR_Response, CAuthentication_DeviceDetails,
    CAuthentication_GetPasswordRSAPublicKey_Request, CAuthentication_GetPasswordRSAPublicKey_Response,
    CAuthentication_PollAuthSessionStatus_Request, CAuthentication_PollAuthSessionStatus_Response,
    CAuthentication_UpdateAuthSessionWithSteamGuardCode_Request,
    CAuthentication_UpdateAuthSessionWithSteamGuardCode_Response, EAuthSessionGuardType,
    EAuthTokenPlatformType,
};

use super::sessions::{self, SessionInfo};

/// 待完成的登录过了这么久就丢弃（Steam 那边的会话也早过期了）。
const PENDING_TTL: Duration = Duration::from_secs(15 * 60);
const DEVICE_NAME: &str = "Kabegame";

struct PendingLogin {
    client_id: u64,
    request_id: Vec<u8>,
    steam_id: u64,
    /// 账号密码登录时已知；扫码登录由轮询结果给出。
    account: Option<String>,
    created: Instant,
}

fn pending() -> &'static Mutex<HashMap<String, PendingLogin>> {
    static PENDING: OnceLock<Mutex<HashMap<String, PendingLogin>>> = OnceLock::new();
    PENDING.get_or_init(Default::default)
}

fn insert_pending(login: PendingLogin) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    let mut map = pending().lock().unwrap_or_else(|e| e.into_inner());
    map.retain(|_, login| login.created.elapsed() < PENDING_TTL);
    map.insert(id.clone(), login);
    id
}

fn with_pending<T>(login_id: &str, f: impl FnOnce(&mut PendingLogin) -> T) -> Result<T, String> {
    let mut map = pending().lock().unwrap_or_else(|e| e.into_inner());
    map.retain(|_, login| login.created.elapsed() < PENDING_TTL);
    map.get_mut(login_id)
        .map(f)
        .ok_or_else(|| "登录已过期，请重新开始".to_string())
}

/// 登录第一步的结果。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginStart {
    pub login_id: String,
    /// 扫码登录的二维码（PNG data URL）。
    pub qr_data_url: Option<String>,
    /// 可用的确认方式：`deviceConfirmation`（手机上点确认）、`deviceCode`（令牌验证码）、
    /// `emailCode`（邮箱验证码）、`emailConfirmation`（邮件里点链接）、`none`（不需要确认）。
    pub confirmations: Vec<String>,
    /// 邮箱验证码发往的邮箱域名等提示（Steam 给的原文）。
    pub email_hint: Option<String>,
    /// 建议的轮询间隔（毫秒）。
    pub poll_interval_ms: u64,
}

/// 一次轮询的结果。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "status")]
pub enum LoginPoll {
    /// 还在等（扫码时 `scanned` 表示手机已扫、等确认）。
    Pending {
        scanned: bool,
        /// 二维码刷新了才有。
        qr_data_url: Option<String>,
    },
    /// 登录成功，会话已保存。
    Done { session: SessionInfo },
}

fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .build()
            .unwrap_or_default()
    })
}

/// Steam 的 EResult 转成提示（只列登录里常见的几种）。
fn eresult_message(method: &str, eresult: i32) -> String {
    let reason = match eresult {
        5 => "账号或密码错误",
        9 | 27 => "登录会话已过期，请重新开始",
        29 => "重复的请求",
        63 => "Steam 拒绝了这次登录（AccountLogonDenied）",
        65 => "验证码错误",
        84 => "请求过于频繁，请稍后再试",
        88 => "验证码不正确或已过期",
        _ => "",
    };
    if reason.is_empty() {
        format!("Steam {method} 失败（EResult {eresult}）")
    } else {
        format!("{reason}（EResult {eresult}）")
    }
}

/// 只接受 GET 的方法（2026-11-15 实测：`GetPasswordRSAPublicKey` 用 POST 返回 HTTP 405），其余用 POST。
const GET_METHODS: &[&str] = &["GetPasswordRSAPublicKey"];

/// 经 HTTPS 调 `IAuthenticationService/<method>/v1`：请求 protobuf 经 `input_protobuf_encoded` 传
/// （POST 放表单、GET 放查询串），响应体是 protobuf，结果看 `x-eresult` 头。
async fn auth_call<Req: Message, Rsp: Message>(method: &str, req: &Req) -> Result<Rsp, String> {
    let url = format!("https://api.steampowered.com/IAuthenticationService/{method}/v1");
    let body = BASE64_STANDARD.encode(req.write_to_bytes().map_err(|e| e.to_string())?);
    let params = [("input_protobuf_encoded", body)];
    let request = if GET_METHODS.contains(&method) {
        http().get(&url).query(&params)
    } else {
        http().post(&url).form(&params)
    };
    let res = request
        .send()
        .await
        .map_err(|e| format!("连接 Steam 失败：{e}"))?;
    let status = res.status();
    let eresult = res
        .headers()
        .get("x-eresult")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<i32>().ok());
    let bytes = res.bytes().await.map_err(|e| format!("读取 Steam 响应失败：{e}"))?;
    match eresult {
        Some(1) => {}
        Some(code) => return Err(eresult_message(method, code)),
        None if !status.is_success() => return Err(format!("Steam {method} 返回 HTTP {status}")),
        None => {}
    }
    Rsp::parse_from_bytes(&bytes).map_err(|e| format!("解析 Steam {method} 响应失败：{e}"))
}

fn device_details() -> MessageField<CAuthentication_DeviceDetails> {
    MessageField::some(CAuthentication_DeviceDetails {
        device_friendly_name: Some(DEVICE_NAME.into()),
        platform_type: Some(EnumOrUnknown::new(
            EAuthTokenPlatformType::k_EAuthTokenPlatformType_SteamClient,
        )),
        os_type: Some(os_type()),
        ..Default::default()
    })
}

/// Steam 的 EOSType：只用来让「已授权设备」里显示得像样，取值照 SteamKit2 `EOSType`。
fn os_type() -> i32 {
    if cfg!(target_os = "windows") {
        16 // Windows10
    } else if cfg!(target_os = "macos") {
        -102 // MacOSUnknown
    } else {
        -203 // LinuxUnknown
    }
}

fn confirmation_name(confirmation: &CAuthentication_AllowedConfirmation) -> &'static str {
    match confirmation.confirmation_type() {
        EAuthSessionGuardType::k_EAuthSessionGuardType_None => "none",
        EAuthSessionGuardType::k_EAuthSessionGuardType_EmailCode => "emailCode",
        EAuthSessionGuardType::k_EAuthSessionGuardType_DeviceCode => "deviceCode",
        EAuthSessionGuardType::k_EAuthSessionGuardType_DeviceConfirmation => "deviceConfirmation",
        EAuthSessionGuardType::k_EAuthSessionGuardType_EmailConfirmation => "emailConfirmation",
        _ => "unknown",
    }
}

fn qr_data_url(content: &str) -> Result<String, String> {
    let code = qrcode::QrCode::new(content.as_bytes()).map_err(|e| format!("生成二维码失败：{e}"))?;
    let image = code
        .render::<image::Luma<u8>>()
        .min_dimensions(240, 240)
        .build();
    let mut png = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageLuma8(image)
        .write_to(&mut png, image::ImageFormat::Png)
        .map_err(|e| format!("生成二维码失败：{e}"))?;
    Ok(format!("data:image/png;base64,{}", BASE64_STANDARD.encode(png.into_inner())))
}

fn interval_ms(interval: f32) -> u64 {
    (interval.max(1.0) * 1000.0) as u64
}

/// 扫码登录第一步。
pub async fn begin_qr() -> Result<LoginStart, String> {
    let rsp: CAuthentication_BeginAuthSessionViaQR_Response = auth_call(
        "BeginAuthSessionViaQR",
        &CAuthentication_BeginAuthSessionViaQR_Request {
            device_friendly_name: Some(DEVICE_NAME.into()),
            platform_type: Some(EnumOrUnknown::new(
                EAuthTokenPlatformType::k_EAuthTokenPlatformType_SteamClient,
            )),
            website_id: Some("Client".into()),
            device_details: device_details(),
            ..Default::default()
        },
    )
    .await?;
    let qr = qr_data_url(rsp.challenge_url())?;
    let login_id = insert_pending(PendingLogin {
        client_id: rsp.client_id(),
        request_id: rsp.request_id().to_vec(),
        steam_id: 0,
        account: None,
        created: Instant::now(),
    });
    Ok(LoginStart {
        login_id,
        qr_data_url: Some(qr),
        confirmations: rsp
            .allowed_confirmations
            .iter()
            .map(|c| confirmation_name(c).to_string())
            .collect(),
        email_hint: None,
        poll_interval_ms: interval_ms(rsp.interval()),
    })
}

/// 账号密码登录第一步。已存的 Steam Guard 机器数据会一起带上，同一台机器通常不再要邮箱验证码。
pub async fn begin_credentials(account: &str, password: &str) -> Result<LoginStart, String> {
    let account = account.trim();
    if account.is_empty() || password.is_empty() {
        return Err("请输入账号和密码".to_string());
    }
    let key: CAuthentication_GetPasswordRSAPublicKey_Response = auth_call(
        "GetPasswordRSAPublicKey",
        &CAuthentication_GetPasswordRSAPublicKey_Request {
            account_name: Some(account.to_string()),
            ..Default::default()
        },
    )
    .await?;
    let modulus = BigUint::parse_bytes(key.publickey_mod().as_bytes(), 16)
        .ok_or("Steam 返回的 RSA 公钥无效")?;
    let exponent = BigUint::parse_bytes(key.publickey_exp().as_bytes(), 16)
        .ok_or("Steam 返回的 RSA 公钥无效")?;
    let public_key = RsaPublicKey::new(modulus, exponent).map_err(|e| format!("Steam 返回的 RSA 公钥无效：{e}"))?;
    let encrypted = public_key
        .encrypt(&mut rsa::rand_core::OsRng, Pkcs1v15Encrypt, password.as_bytes())
        .map_err(|e| format!("加密密码失败：{e}"))?;

    let rsp: CAuthentication_BeginAuthSessionViaCredentials_Response = auth_call(
        "BeginAuthSessionViaCredentials",
        &CAuthentication_BeginAuthSessionViaCredentials_Request {
            account_name: Some(account.to_string()),
            encrypted_password: Some(BASE64_STANDARD.encode(encrypted)),
            encryption_timestamp: Some(key.timestamp()),
            persistence: Some(EnumOrUnknown::new(
                ESessionPersistence::k_ESessionPersistence_Persistent,
            )),
            website_id: Some("Client".into()),
            device_details: device_details(),
            guard_data: sessions::guard_data(account),
            ..Default::default()
        },
    )
    .await?;
    let email_hint = rsp
        .allowed_confirmations
        .iter()
        .find(|c| {
            c.confirmation_type() == EAuthSessionGuardType::k_EAuthSessionGuardType_EmailCode
        })
        .and_then(|c| c.associated_message.clone())
        .filter(|hint| !hint.is_empty());
    let login_id = insert_pending(PendingLogin {
        client_id: rsp.client_id(),
        request_id: rsp.request_id().to_vec(),
        steam_id: rsp.steamid(),
        account: Some(account.to_string()),
        created: Instant::now(),
    });
    Ok(LoginStart {
        login_id,
        qr_data_url: None,
        confirmations: rsp
            .allowed_confirmations
            .iter()
            .map(|c| confirmation_name(c).to_string())
            .collect(),
        email_hint,
        poll_interval_ms: interval_ms(rsp.interval()),
    })
}

/// 提交邮箱 / 令牌验证码。`kind` 为 `emailCode` 或 `deviceCode`。提交后继续轮询。
pub async fn submit_code(login_id: &str, code: &str, kind: &str) -> Result<(), String> {
    let code_type = match kind {
        "emailCode" => EAuthSessionGuardType::k_EAuthSessionGuardType_EmailCode,
        "deviceCode" => EAuthSessionGuardType::k_EAuthSessionGuardType_DeviceCode,
        other => return Err(format!("不支持的验证方式：{other}")),
    };
    let code = code.trim();
    if code.is_empty() {
        return Err("请输入验证码".to_string());
    }
    let (client_id, steam_id) = with_pending(login_id, |login| (login.client_id, login.steam_id))?;
    let _: CAuthentication_UpdateAuthSessionWithSteamGuardCode_Response = auth_call(
        "UpdateAuthSessionWithSteamGuardCode",
        &CAuthentication_UpdateAuthSessionWithSteamGuardCode_Request {
            client_id: Some(client_id),
            steamid: Some(steam_id),
            code: Some(code.to_string()),
            code_type: Some(EnumOrUnknown::new(code_type)),
            ..Default::default()
        },
    )
    .await?;
    Ok(())
}

/// 轮询一次。成功时保存会话并结束这次登录。
pub async fn poll(login_id: &str) -> Result<LoginPoll, String> {
    let (client_id, request_id) = with_pending(login_id, |login| (login.client_id, login.request_id.clone()))?;
    let rsp: CAuthentication_PollAuthSessionStatus_Response = auth_call(
        "PollAuthSessionStatus",
        &CAuthentication_PollAuthSessionStatus_Request {
            client_id: Some(client_id),
            request_id: Some(request_id),
            ..Default::default()
        },
    )
    .await?;

    if rsp.has_refresh_token() && !rsp.refresh_token().is_empty() {
        let account = with_pending(login_id, |login| login.account.clone())?
            .or_else(|| rsp.account_name.clone())
            .filter(|account| !account.is_empty())
            .ok_or("Steam 没有返回账号名")?;
        let session = sessions::save(&account, rsp.refresh_token(), rsp.new_guard_data.as_deref())?;
        cancel(login_id);
        return Ok(LoginPoll::Done { session });
    }

    // 扫码登录的二维码会定期刷新：换 client id 与新的挑战地址
    let mut qr = None;
    if let Some(new_client_id) = rsp.new_client_id {
        with_pending(login_id, |login| login.client_id = new_client_id)?;
    }
    if let Some(url) = rsp.new_challenge_url.as_deref().filter(|url| !url.is_empty()) {
        qr = Some(qr_data_url(url)?);
    }
    Ok(LoginPoll::Pending {
        scanned: rsp.had_remote_interaction(),
        qr_data_url: qr,
    })
}

/// 放弃一次登录（关掉对话框、换方式）。
pub fn cancel(login_id: &str) {
    pending()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(login_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_logins_expire_and_cancel() {
        let id = insert_pending(PendingLogin {
            client_id: 1,
            request_id: vec![1],
            steam_id: 2,
            account: Some("a".into()),
            created: Instant::now(),
        });
        assert_eq!(with_pending(&id, |login| login.client_id).unwrap(), 1);
        cancel(&id);
        assert!(with_pending(&id, |_| ()).is_err());

        let stale = insert_pending(PendingLogin {
            client_id: 1,
            request_id: vec![],
            steam_id: 0,
            account: None,
            created: Instant::now() - PENDING_TTL - Duration::from_secs(1),
        });
        assert!(with_pending(&stale, |_| ()).is_err());
    }

    #[test]
    fn qr_is_png_data_url() {
        let url = qr_data_url("https://s.team/q/1/2").unwrap();
        assert!(url.starts_with("data:image/png;base64,"));
    }
}
