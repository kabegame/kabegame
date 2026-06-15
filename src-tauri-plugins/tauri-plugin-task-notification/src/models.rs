use serde::Serialize;

/// 单个活跃下载的通知条目（镜像 TaskDrawer「正在下载」面板的一行）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadNotificationItem {
    pub id: u64,
    pub title: String,
    /// 总大小未知 → 不确定进度条。
    pub indeterminate: bool,
    /// 0–100；`indeterminate` 为 true 时忽略。
    pub progress: u8,
}

/// 全量协调通知：汇总（运行任务数 + 下载数）+ 每个活跃下载一条子通知。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateNotificationsArgs {
    pub running_count: u32,
    pub items: Vec<DownloadNotificationItem>,
}
