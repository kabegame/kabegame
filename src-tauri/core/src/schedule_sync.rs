//! 预留钩子：任务终态不再回写运行配置的调度字段（由定时触发时写入与用户操作驱动）。

/// 任务进入终态时调用（兼容旧调用点）；不再修改 `run_configs`。
pub fn on_crawl_task_reached_terminal(_task_id: &str) {}
