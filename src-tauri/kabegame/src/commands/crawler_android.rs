//! 安卓 WebView 爬虫宿主：`CrawlerActivity` 只当 wry 的宿主，页面由 `CrawlerHost` 停靠到主界面下。
//!
//! 与桌面同形：初始化脚本、`on_page_load`、按 label 认任务的 `crawl_*` 命令都是同一份；差别只在
//! 窗口位置与下载通道：
//! - 页面挂在主界面内容根节点、z = -1（主 webview 下面），所以窗口始终可见、Chromium 不冻结；
//!   `requestShowWebview()` / 任务抽屉「打开窗口」把 z 提到最上层。
//! - 没有 CEF 下载通道：脚本下载在 `crawl_download_image` 入队前补 Cookie / UA / Referer；
//!   页面自发下载由本模块用 reqwest 写进任务 VFS 的 `tmp/Downloads`，再交给 `finish_page_download`。
//!
//! Kotlin 只负责四件事：宿主 Activity + 停靠、原生工具栏直接操作 `RustWebView`、把 IPC 限制在主框架、
//! 拦截页面自发下载与渲染进程退出，经每任务一个 events Channel 回传。
use super::crawler::{
    assign_page_download_destination, finish_page_download, notify_page_download,
};
use kabegame_core::crawler::task_log_i18n::task_log_i18n;
use kabegame_core::crawler::task_scheduler::{TaskError, TaskResult};
use kabegame_core::crawler::webview::crawler_window_label;
use kabegame_core::crawler::TaskScheduler;
use kabegame_core::emitter::GlobalEmitter;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
use tauri::{AppHandle, Manager, Runtime};
use url::Url;

pub struct CrawlerAndroid<R: Runtime>(PluginHandle<R>);

/// 原生工具栏与任务卡片文案。Rust 统一用 `t!()` 下发，i18n 只维护一处。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CrawlerToolbarTexts {
    /// 插件展示名（最近任务卡片与工具栏标题）。
    title: String,
    collapse: String,
    cancel: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AttachArgs {
    label: String,
    task_name: String,
    events: Channel<serde_json::Value>,
    texts: CrawlerToolbarTexts,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttachResponse {
    ipc_available: bool,
}

#[derive(Serialize)]
struct LabelArgs {
    label: String,
}

#[derive(Deserialize)]
struct ShowResponse {
    /// app 在后台时安卓不允许拉起界面：Kotlin 记下待显示，回到前台再提到最上层。
    pending: bool,
}

#[derive(Serialize)]
struct SubscribeArgs {
    events: Channel<serde_json::Value>,
}

#[derive(Serialize)]
struct ClearCookiesArgs {
    url: String,
}

#[derive(Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum HostEvent {
    /// 进程级前后台切换（`ProcessLifecycleOwner`）。看门狗据此在后台挂起心跳计时。
    HostVisibility { visible: bool },
}

#[derive(Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum CrawlerWindowEvent {
    /// `setDownloadListener` 拦到的页面自发下载。
    PageDownload {
        url: String,
        suggested_name: Option<String>,
        mime_type: Option<String>,
    },
    /// 共用渲染进程退出（崩溃或被系统回收）。不返回 true 会被 Chromium 连带杀掉整个 app。
    RenderGone { crashed: bool },
    /// 工具栏「取消任务」。
    Cancel,
    /// 用户从最近任务划掉宿主（`finishAndRemoveTask` 之外的自然结束）＝取消任务。
    Closed,
}

/// 建窗时为各爬虫宿主选定的桌面 UA（按 label）。
///
/// 目标站畅游记录是「桌面版网站」时，爬虫页面用桌面 UA（与畅游共用 CookieManager，Cookie 与签发
/// UA 必须配对）；页面自发下载的补头读这里，保证与页面实际 UA 一致。不能事后按任务重新推导：
/// 建窗地址是 `start_url`（网页收集即来源页），不一定是插件 `base_url`。
static DESKTOP_USER_AGENTS: LazyLock<Mutex<HashMap<String, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 该爬虫宿主建窗时使用的桌面 UA；移动 UA（系统默认）时为 `None`。
pub(crate) fn desktop_user_agent_for_label(label: &str) -> Option<String> {
    DESKTOP_USER_AGENTS
        .lock()
        .ok()
        .and_then(|agents| agents.get(label).cloned())
}

/// 安卓 WebView 爬虫的窗口与下载出口。
pub struct AndroidCrawlerWebViewHandler<R: Runtime> {
    app: AppHandle<R>,
}

impl<R: Runtime> AndroidCrawlerWebViewHandler<R> {
    pub fn new(app: AppHandle<R>) -> Self {
        Self { app }
    }
}

#[async_trait::async_trait]
impl<R: Runtime> kabegame_core::crawler::webview::CrawlerWebViewHandler
    for AndroidCrawlerWebViewHandler<R>
{
    async fn create_task_window(&self, task_id: &str, base_url: &str) -> Result<(), String> {
        let run = TaskScheduler::global()
            .get_run(task_id)
            .ok_or_else(|| format!("Crawler task not found for task {task_id}"))?;
        ensure_host_subscription(&self.app).await;
        let scripts = crate::startup::crawler_initialization_scripts(&run, base_url)?;
        let label = crawler_window_label(task_id);
        let task_name = task_display_name(&run.params.plugin.id);

        // Activity 的创建与畅游同路径：从异步命令上下文建窗（Tauri 会自己投递到平台侧）。
        // build 之后 attach 才拿得到 ipcAvailable。
        let desktop_user_agent = Url::parse(base_url)
            .ok()
            .and_then(|url| super::surf_common::android_desktop_user_agent_for_url(&url));
        crate::startup::create_crawler_activity(
            self.app.clone(),
            &label,
            base_url,
            &scripts,
            desktop_user_agent.as_deref(),
        )?;
        // 建窗成功后才登记；之后的失败分支都经 destroy_task_window 清掉。
        if let Some(user_agent) = desktop_user_agent {
            if let Ok(mut agents) = DESKTOP_USER_AGENTS.lock() {
                agents.insert(label.clone(), user_agent);
            }
        }

        let app_for_events = self.app.clone();
        let task_for_events = task_id.to_string();
        let events = Channel::new(move |body| {
            if let InvokeResponseBody::Json(json) = body {
                if let Ok(event) = serde_json::from_str::<CrawlerWindowEvent>(&json) {
                    on_window_event(app_for_events.clone(), task_for_events.clone(), event);
                }
            }
            Ok(())
        });

        let plugin = self.app.state::<CrawlerAndroid<R>>().0.clone();
        let attached = tokio::time::timeout(
            Duration::from_secs(10),
            plugin.run_mobile_plugin_async::<AttachResponse>(
                "attach",
                AttachArgs {
                    label: label.clone(),
                    task_name: task_name.clone(),
                    events,
                    texts: CrawlerToolbarTexts {
                        title: task_name,
                        collapse: kabegame_i18n::translate("crawler.toolbar.collapse"),
                        cancel: kabegame_i18n::translate("crawler.toolbar.cancel"),
                    },
                },
            ),
        )
        .await;
        match attached {
            Ok(Ok(response)) => {
                if !response.ipc_available {
                    // 没有 IPC，页面无法调用 crawl_*，任务永远走不到 completion；直接失败比等心跳超时清楚。
                    let _ = self.destroy_task_window(task_id).await;
                    return Err("WebView 主框架 IPC 不可用，无法运行爬虫任务".to_string());
                }
                Ok(())
            }
            Ok(Err(error)) => {
                let _ = self.destroy_task_window(task_id).await;
                Err(format!("绑定爬虫宿主 Activity 失败: {error}"))
            }
            Err(_) => {
                let _ = self.destroy_task_window(task_id).await;
                Err("绑定爬虫宿主 Activity 超时".to_string())
            }
        }
    }

    async fn destroy_task_window(&self, task_id: &str) -> Result<(), String> {
        let label = crawler_window_label(task_id);
        let plugin = self.app.state::<CrawlerAndroid<R>>().0.clone();
        // 主线程不可用（后台冻结 / ANR）时不能把 worker 永久卡在 destroy 上：超时就改为直接销毁窗口。
        let closed = tokio::time::timeout(
            Duration::from_secs(5),
            plugin.run_mobile_plugin_async::<()>(
                "close",
                LabelArgs {
                    label: label.clone(),
                },
            ),
        )
        .await;
        // Activity 没起来 / attach 超时 / close 超时：Tauri 窗口还在表里，直接销毁兜底。
        if !matches!(closed, Ok(Ok(()))) {
            if let Some(window) = self.app.get_webview_window(&label) {
                let _ = window.destroy();
            }
        }
        TaskScheduler::global()
            .download_queue()
            .abort_native_waits_for_task(task_id);
        if let Ok(mut agents) = DESKTOP_USER_AGENTS.lock() {
            agents.remove(&label);
        }
        Ok(())
    }

    async fn start_native_download(
        &self,
        _task_id: &str,
        _surf_record_id: Option<&str>,
        _url: &str,
    ) -> Result<(), String> {
        // 安卓没有 CEF 下载通道；`is_native_job` 在安卓恒为 false，不会走到这里。
        Err("Android 没有 CEF 原生下载通道".to_string())
    }
}

fn task_display_name(plugin_id: &str) -> String {
    kabegame_core::plugin::PluginManager::global()
        .get_cached_plugin_display_name_sync(plugin_id)
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| kabegame_i18n::translate("window.crawlerTitle"))
}

fn on_window_event<R: Runtime>(app: AppHandle<R>, task_id: String, event: CrawlerWindowEvent) {
    match event {
        CrawlerWindowEvent::PageDownload {
            url,
            suggested_name,
            mime_type,
        } => {
            tauri::async_runtime::spawn(async move {
                on_page_download(
                    &app,
                    &task_id,
                    &url,
                    suggested_name.as_deref(),
                    mime_type.as_deref(),
                )
                .await;
            });
        }
        CrawlerWindowEvent::RenderGone { crashed } => {
            GlobalEmitter::global().emit_task_log(
                &task_id,
                "error",
                &task_log_i18n(
                    "taskLogWebviewRenderGone",
                    serde_json::json!({ "crashed": crashed }),
                ),
            );
            finish_task(
                task_id,
                Err(TaskError::Other("WebView 渲染进程已退出".into())),
            );
        }
        CrawlerWindowEvent::Cancel => {
            finish_task(task_id, Err(TaskError::Canceled));
        }
        CrawlerWindowEvent::Closed => {
            GlobalEmitter::global().emit_task_log(
                &task_id,
                "warn",
                &task_log_i18n("taskLogWebviewHostClosed", serde_json::json!({})),
            );
            finish_task(task_id, Err(TaskError::Canceled));
        }
    }
}

/// 结束 WebView 会话。任务已经收尾（completion 已取走）时是 no-op。
fn finish_task(task_id: String, result: TaskResult) {
    tauri::async_runtime::spawn(async move {
        TaskScheduler::global()
            .complete_webview_task(&task_id, result)
            .await;
    });
}

/// 页面自发下载（`Content-Disposition: attachment` 或 WebView 渲染不了的 MIME）。
///
/// 安卓没有 CEF 的下载回调，这里按桌面 `on_download` 的同一口径处理：定向到任务 VFS 的
/// `tmp/Downloads`，带 Cookie / UA / Referer 用 reqwest 落盘，再把虚拟路径回传给页面。
/// 不做压缩包拦截：WebView 插件自己决定怎么处理（与桌面一致）。
async fn on_page_download<R: Runtime>(
    app: &AppHandle<R>,
    task_id: &str,
    url: &str,
    name: Option<&str>,
    _mime_type: Option<&str>,
) {
    let Ok(parsed) = Url::parse(url) else {
        return;
    };
    // data: / blob: 的字节只在页面里，页面外取不到；与畅游同口径地忽略。
    if !matches!(parsed.scheme(), "http" | "https") {
        return;
    }
    let Some(run) = TaskScheduler::global().get_run(task_id) else {
        return;
    };
    let Some(webview) = app.get_webview(&crawler_window_label(task_id)) else {
        return;
    };
    let mut destination = std::path::PathBuf::new();
    if let Err(error) =
        assign_page_download_destination(&run.vfs, run.fs_handle, &parsed, name, &mut destination)
    {
        notify_page_download(
            &webview,
            serde_json::json!({ "url": parsed.as_str(), "success": false, "error": error }),
        );
        return;
    }
    let headers = super::surf_receive::android_identity_headers(&webview, &parsed).await;
    let success = match download_to_file(&parsed, &headers, &destination).await {
        Ok(()) => true,
        Err(error) => {
            eprintln!("[crawler] 页面自发下载失败 {}: {error}", parsed.as_str());
            false
        }
    };
    finish_page_download(
        &webview,
        &run.vfs,
        run.fs_handle,
        &parsed,
        &destination,
        success,
    );
}

/// 流式落盘：媒体文件可能很大，不能整段读进内存。
async fn download_to_file(
    url: &Url,
    headers: &HashMap<String, String>,
    destination: &Path,
) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;

    let client = kabegame_core::crawler::downloader::create_following_redirects_client()?;
    let mut request = client.get(url.clone());
    for (name, value) in headers {
        request = request.header(name.as_str(), value.as_str());
    }
    let mut response = request
        .send()
        .await
        .map_err(|error| format!("请求失败: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("HTTP {status}"));
    }
    if let Some(parent) = destination.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| format!("创建下载目录失败: {error}"))?;
    }
    let mut file = tokio::fs::File::create(destination)
        .await
        .map_err(|error| format!("创建下载文件失败: {error}"))?;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("读取响应失败: {error}"))?
    {
        file.write_all(&chunk)
            .await
            .map_err(|error| format!("写入下载文件失败: {error}"))?;
    }
    file.flush()
        .await
        .map_err(|error| format!("刷新下载文件失败: {error}"))?;
    Ok(())
}

/// 前后台事件只订阅一次；首个任务建窗前重试（插件 setup 早于任何 Activity 实例）。
static HOST_SUBSCRIBED: AtomicBool = AtomicBool::new(false);

fn host_events_channel() -> Channel<serde_json::Value> {
    Channel::new(|body| {
        if let InvokeResponseBody::Json(json) = body {
            if let Ok(HostEvent::HostVisibility { visible }) =
                serde_json::from_str::<HostEvent>(&json)
            {
                kabegame_core::crawler::webview::set_host_visible(visible);
            }
        }
        Ok(())
    })
}

async fn try_subscribe_host<R: Runtime>(plugin: &PluginHandle<R>) -> Result<(), String> {
    plugin
        .run_mobile_plugin_async::<()>(
            "subscribeHost",
            SubscribeArgs {
                events: host_events_channel(),
            },
        )
        .await
        .map_err(|error| error.to_string())
}

/// 确保 `hostVisibility` 已订阅。插件 setup 阶段可能还没有 Activity 可派发命令，
/// 因此延迟到首个 WebView 任务（此时主 Activity 必然存在）再重试。
async fn ensure_host_subscription<R: Runtime>(app: &AppHandle<R>) {
    if HOST_SUBSCRIBED.load(Ordering::Relaxed) {
        return;
    }
    let plugin = app.state::<CrawlerAndroid<R>>().0.clone();
    match try_subscribe_host(&plugin).await {
        Ok(()) => HOST_SUBSCRIBED.store(true, Ordering::Relaxed),
        Err(error) => eprintln!("[crawler] 订阅前后台事件失败，将在下个任务重试: {error}"),
    }
}

/// 注册 `CrawlerPlugin`，并尽力提前订阅进程级前后台切换。
pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("kabegame-crawler")
        .setup(|app, api| {
            let handle = api.register_android_plugin("app.kabegame", "CrawlerPlugin")?;
            let host_handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                if try_subscribe_host(&host_handle).await.is_ok() {
                    HOST_SUBSCRIBED.store(true, Ordering::Relaxed);
                }
            });
            app.manage(CrawlerAndroid(handle));
            Ok(())
        })
        .build()
}

/// `Kabegame.clearData()` 的安卓实现：逐个把该 URL 的 Cookie 写成过期。
pub(crate) async fn crawler_android_clear_cookies<R: Runtime>(
    app: AppHandle<R>,
    url: String,
) -> Result<(), String> {
    let parsed =
        Url::parse(url.trim()).map_err(|e| format!("Invalid URL for clear_site_data: {e}"))?;
    let plugin = app.state::<CrawlerAndroid<R>>().0.clone();
    plugin
        .run_mobile_plugin_async::<()>(
            "clearCookies",
            ClearCookiesArgs {
                url: parsed.to_string(),
            },
        )
        .await
        .map_err(|error| format!("清除站点 Cookie 失败: {error}"))
}

/// `show_crawler_window` 的安卓出口。返回 `true` 表示 app 在后台、已记为待显示。
pub(crate) async fn show_crawler_window_via_plugin<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
) -> Result<bool, String> {
    let plugin = app.state::<CrawlerAndroid<R>>().0.clone();
    plugin
        .run_mobile_plugin_async::<ShowResponse>(
            "show",
            LabelArgs {
                label: label.to_string(),
            },
        )
        .await
        .map(|response| response.pending)
        .map_err(|error| format!("显示爬虫页面失败: {error}"))
}

/// `show_crawler_window` 的后台分支日志：只记一次，回到前台 Kotlin 会自动提到最上层。
pub(crate) fn log_pending_show(task_id: &str) {
    GlobalEmitter::global().emit_task_log(
        task_id,
        "info",
        &task_log_i18n("taskLogWebviewPendingShow", serde_json::json!({})),
    );
}
