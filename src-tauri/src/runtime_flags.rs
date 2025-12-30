use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// 运行时开关（不写入设置文件）
///
/// - `force_deduplicate`: 强制按 hash 去重（无视 settings.auto_deduplicate）
/// - `force_deduplicate_wait_until_idle`: 若为 true，则当下载队列空闲时自动关闭 force_deduplicate 并发事件通知前端
#[derive(Clone, Default)]
pub struct RuntimeFlags {
    force_deduplicate: Arc<AtomicBool>,
    force_deduplicate_wait_until_idle: Arc<AtomicBool>,
}

impl RuntimeFlags {
    pub fn set_force_deduplicate(&self, active: bool) {
        self.force_deduplicate.store(active, Ordering::SeqCst);
    }

    pub fn force_deduplicate(&self) -> bool {
        self.force_deduplicate.load(Ordering::SeqCst)
    }

    pub fn set_force_deduplicate_wait_until_idle(&self, active: bool) {
        self.force_deduplicate_wait_until_idle
            .store(active, Ordering::SeqCst);
    }

    pub fn force_deduplicate_wait_until_idle(&self) -> bool {
        self.force_deduplicate_wait_until_idle.load(Ordering::SeqCst)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForceDedupeStartResult {
    pub will_wait_until_downloads_end: bool,
}


