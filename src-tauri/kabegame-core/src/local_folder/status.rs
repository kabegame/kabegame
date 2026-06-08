use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum FolderStatus {
    Ok {
        checked_at: u64,
        #[serde(default)]
        last_synced_at_ms: u64,
    },
    Missing {
        checked_at: u64,
    },
    Denied {
        checked_at: u64,
        message: String,
    },
    NotADir {
        checked_at: u64,
    },
    IoError {
        checked_at: u64,
        message: String,
    },
}

impl FolderStatus {
    pub fn now_ok() -> Self {
        Self::ok_synced_at_ms(now_millis())
    }

    pub fn ok_synced_at_ms(last_synced_at_ms: u64) -> Self {
        Self::Ok {
            checked_at: now_secs(),
            last_synced_at_ms,
        }
    }

    pub fn now_missing() -> Self {
        Self::Missing {
            checked_at: now_secs(),
        }
    }

    pub fn now_denied(message: impl Into<String>) -> Self {
        Self::Denied {
            checked_at: now_secs(),
            message: message.into(),
        }
    }

    pub fn now_not_a_dir() -> Self {
        Self::NotADir {
            checked_at: now_secs(),
        }
    }

    pub fn now_io_error(message: impl Into<String>) -> Self {
        Self::IoError {
            checked_at: now_secs(),
            message: message.into(),
        }
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }

    pub fn last_synced_at_ms(&self) -> Option<u64> {
        match self {
            Self::Ok {
                last_synced_at_ms, ..
            } if *last_synced_at_ms > 0 => Some(*last_synced_at_ms),
            _ => None,
        }
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub(crate) fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or(0)
}
