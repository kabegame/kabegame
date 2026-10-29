//! 启动进度：重型初始化（插件、Storage 迁移与阻塞回填、服务）期间供启动页读取的单值通道。
//!
//! 刻意不依赖 Tauri、`GlobalEmitter` 与 `Storage::global()`：全局单例就绪之前就要能读写。
//! app 层把它转成 `startup-progress` 事件与 `get_startup_state` 命令。

use crate::storage::migrations::StartupProgress;
use serde::Serialize;
use std::sync::OnceLock;
use tokio::sync::watch;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "phase",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum StartupPhase {
    Settings,
    Plugins,
    Schema {
        version: u32,
        name: String,
    },
    Backfill {
        id: String,
        processed: usize,
        total: Option<usize>,
    },
    Services,
    Ready,
    Failed {
        message: String,
    },
}

impl StartupPhase {
    /// `Ready` 与 `Failed` 之后不会再变化。
    pub fn is_terminal(&self) -> bool {
        matches!(self, Self::Ready | Self::Failed { .. })
    }
}

impl From<StartupProgress> for StartupPhase {
    fn from(progress: StartupProgress) -> Self {
        match progress {
            StartupProgress::Schema { version, name } => Self::Schema {
                version,
                name: name.to_string(),
            },
            StartupProgress::Backfill {
                id,
                processed,
                total,
            } => Self::Backfill {
                id: id.to_string(),
                processed,
                total,
            },
        }
    }
}

static STATE: OnceLock<watch::Sender<StartupPhase>> = OnceLock::new();

fn sender() -> &'static watch::Sender<StartupPhase> {
    STATE.get_or_init(|| watch::channel(StartupPhase::Settings).0)
}

/// 更新当前阶段。进入终态后忽略后续写入（失败信息不能被后面的步骤覆盖）。
pub fn set(phase: StartupPhase) {
    sender().send_if_modified(|current| {
        if current.is_terminal() || *current == phase {
            return false;
        }
        *current = phase;
        true
    });
}

pub fn snapshot() -> StartupPhase {
    sender().borrow().clone()
}

pub fn subscribe() -> watch::Receiver<StartupPhase> {
    sender().subscribe()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phase_serializes_with_tag_and_camel_case_fields() {
        let value = serde_json::to_value(StartupPhase::Backfill {
            id: "x".into(),
            processed: 3,
            total: Some(9),
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({ "phase": "backfill", "id": "x", "processed": 3, "total": 9 })
        );
        let value = serde_json::to_value(StartupPhase::Failed {
            message: "boom".into(),
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({ "phase": "failed", "message": "boom" })
        );
        assert_eq!(
            serde_json::to_value(StartupPhase::Ready).unwrap(),
            serde_json::json!({ "phase": "ready" })
        );
    }
}
