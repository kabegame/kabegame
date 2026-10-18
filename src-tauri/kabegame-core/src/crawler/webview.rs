use async_trait::async_trait;
use std::sync::{Arc, OnceLock};
use tokio::sync::watch;

#[async_trait]
pub trait CrawlerWebViewHandler: Send + Sync + 'static {
    async fn create_task_window(&self, task_id: &str, base_url: &str) -> Result<(), String>;
    async fn destroy_task_window(&self, task_id: &str) -> Result<(), String>;
    /// 向所属 CEF webview 投递原生下载。surf_record_id 有值时使用畅游窗口，
    /// 否则使用 crawler 任务窗口；终态由下载条目上的 oneshot 回传给 worker。
    async fn start_native_download(
        &self,
        task_id: &str,
        surf_record_id: Option<&str>,
        url: &str,
    ) -> Result<(), String>;
}

static CRAWLER_WEBVIEW_HANDLER: OnceLock<Arc<dyn CrawlerWebViewHandler>> = OnceLock::new();

pub fn crawler_window_label(task_id: &str) -> String {
    format!("crawler-{task_id}")
}

pub fn task_id_from_crawler_label(label: &str) -> Option<&str> {
    label.strip_prefix("crawler-").filter(|id| !id.is_empty())
}

pub fn set_webview_handler(handler: Arc<dyn CrawlerWebViewHandler>) -> Result<(), String> {
    CRAWLER_WEBVIEW_HANDLER
        .set(handler)
        .map_err(|_| "Crawler webview handler already initialized".to_string())
}

pub fn get_webview_handler() -> Option<Arc<dyn CrawlerWebViewHandler>> {
    CRAWLER_WEBVIEW_HANDLER.get().cloned()
}

/// app 是否在前台（安卓宿主生命周期的进程级可见性）。默认可见：
/// 桌面与 web 没有「宿主不可见」这回事，看门狗照旧工作。
static HOST_VISIBLE: OnceLock<watch::Sender<bool>> = OnceLock::new();

fn host_visible_tx() -> &'static watch::Sender<bool> {
    HOST_VISIBLE.get_or_init(|| watch::channel(true).0)
}

/// 订阅前后台切换。看门狗用它在宿主不可见期间挂起计时。
pub fn host_visibility() -> watch::Receiver<bool> {
    host_visible_tx().subscribe()
}

/// 由 app 层（安卓 `CrawlerPlugin.subscribeHost`）上报前后台切换。
/// 只在值真正变化时通知；重复上报同值不会重置看门狗。
pub fn set_host_visible(visible: bool) {
    let _ = host_visible_tx().send_if_modified(|current| {
        if *current == visible {
            false
        } else {
            *current = visible;
            true
        }
    });
}
