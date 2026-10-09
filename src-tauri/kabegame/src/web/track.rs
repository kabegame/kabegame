// Web 版 `/rpc` 接口埋点：每次调用发一条 umami `rpc_call` 事件（data: method / ok / code / ms）。
// 只在服务端按接口统计，不读取、不转发任何客户端请求头（IP、UA 等），事件全部归到服务器自己这一个访客。
// 配置走运行时环境变量（systemd drop-in），未配置即整体关闭：
//   KABEGAME_UMAMI_SEND_URL    umami 收集端点，例如 https://umi.kabegame.com/api/send
//   KABEGAME_UMAMI_WEBSITE_ID  umami website UUID
//   KABEGAME_UMAMI_HOSTNAME    可选，事件的 hostname（缺省时 umami 记为 localhost）
// 上报经有界队列交给后台 worker，队列满即丢弃，接口延迟不受 umami 影响。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;

const QUEUE_CAPACITY: usize = 1024;
const SEND_CONCURRENCY: usize = 8;
const SEND_TIMEOUT: Duration = Duration::from_secs(5);
const UNKNOWN_METHOD: &str = "(unknown)";
// umami 的 isbot 会把 `name/version` 形式的 UA（含 reqwest、Kabegame/1.0）判成 bot 并回 {"beep":"boop"} 丢弃，
// 必须带 Mozilla 前缀才会入库。
const USER_AGENT: &str = concat!(
    "Mozilla/5.0 (X11; Linux x86_64) kabegame-web/",
    env!("CARGO_PKG_VERSION")
);

struct Config {
    send_url: String,
    website: String,
    hostname: Option<String>,
}

struct RpcCall {
    method: &'static str,
    code: Option<i64>,
    ms: u64,
}

static SENDER: OnceLock<Option<mpsc::Sender<RpcCall>>> = OnceLock::new();

fn env_nonempty(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// 读环境变量并启动后台 worker。需在 tokio runtime 内调用；只生效一次。
pub fn init() {
    SENDER.get_or_init(|| {
        let (Some(send_url), Some(website)) = (
            env_nonempty("KABEGAME_UMAMI_SEND_URL"),
            env_nonempty("KABEGAME_UMAMI_WEBSITE_ID"),
        ) else {
            println!("  - RPC tracking disabled (KABEGAME_UMAMI_SEND_URL / KABEGAME_UMAMI_WEBSITE_ID not set)");
            return None;
        };
        let client = match reqwest::Client::builder()
            // 服务进程带全局 HTTPS_PROXY，埋点直连 umami，不走代理
            .no_proxy()
            .user_agent(USER_AGENT)
            .timeout(SEND_TIMEOUT)
            .build()
        {
            Ok(c) => c,
            Err(e) => {
                eprintln!("  ✗ RPC tracking disabled: failed to build HTTP client: {e}");
                return None;
            }
        };
        println!("  ✓ RPC tracking → {send_url} (website {website})");
        let cfg = Arc::new(Config {
            send_url,
            website,
            hostname: env_nonempty("KABEGAME_UMAMI_HOSTNAME"),
        });
        let (tx, rx) = mpsc::channel(QUEUE_CAPACITY);
        tokio::spawn(run_worker(cfg, client, rx));
        Some(tx)
    });
}

pub struct RpcCallTimer {
    method: &'static str,
    started: Instant,
}

/// 埋点关闭时返回 None，调用方零开销跳过。
pub fn start(method: &str) -> Option<RpcCallTimer> {
    SENDER.get()?.as_ref()?;
    Some(RpcCallTimer {
        method: super::dispatch::registered_method(method).unwrap_or(UNKNOWN_METHOD),
        started: Instant::now(),
    })
}

impl RpcCallTimer {
    pub fn finish(self, resp: &Value) {
        let Some(Some(tx)) = SENDER.get() else {
            return;
        };
        let code = resp
            .get("error")
            .map(|e| e.get("code").and_then(Value::as_i64).unwrap_or(0));
        let call = RpcCall {
            method: self.method,
            code,
            ms: self.started.elapsed().as_millis() as u64,
        };
        // 队列满（umami 慢或不可达）直接丢，不反压接口
        let _ = tx.try_send(call);
    }
}

async fn run_worker(cfg: Arc<Config>, client: reqwest::Client, rx: mpsc::Receiver<RpcCall>) {
    // 只在「正常 ↔ 失败」切换时打日志，umami 宕机时不刷屏
    let healthy = Arc::new(AtomicBool::new(true));
    ReceiverStream::new(rx)
        .for_each_concurrent(SEND_CONCURRENCY, |call| {
            let cfg = cfg.clone();
            let client = client.clone();
            let healthy = healthy.clone();
            async move {
                match send(&cfg, &client, &call).await {
                    Ok(()) => {
                        if !healthy.swap(true, Ordering::Relaxed) {
                            println!("[umami] RPC tracking recovered");
                        }
                    }
                    Err(e) => {
                        if healthy.swap(false, Ordering::Relaxed) {
                            eprintln!("[umami] RPC tracking failed: {e}");
                        }
                    }
                }
            }
        })
        .await;
}

async fn send(cfg: &Config, client: &reqwest::Client, call: &RpcCall) -> Result<(), String> {
    let mut data = json!({
        "method": call.method,
        "ok": call.code.is_none(),
        "ms": call.ms,
    });
    if let Some(code) = call.code {
        data["code"] = json!(code);
    }
    let mut payload = json!({
        "website": cfg.website,
        "url": "/rpc",
        "name": "rpc_call",
        "data": data,
    });
    if let Some(hostname) = &cfg.hostname {
        payload["hostname"] = json!(hostname);
    }
    let body = serde_json::to_vec(&json!({ "type": "event", "payload": payload }))
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(&cfg.send_url)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("HTTP {status}: {text}"));
    }
    // 200 + {"beep":"boop"} 表示被当成 bot 静默丢弃
    if text.contains("\"beep\"") {
        return Err(format!("rejected as bot: {text}"));
    }
    Ok(())
}
