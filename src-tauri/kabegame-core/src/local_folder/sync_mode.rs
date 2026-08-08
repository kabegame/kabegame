use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SyncMode {
    None,
    Shallow,
    Recursive,
    Delegated,
}

impl SyncMode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Shallow => "shallow",
            Self::Recursive => "recursive",
            Self::Delegated => "delegated",
        }
    }

    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "none" => Some(Self::None),
            "shallow" => Some(Self::Shallow),
            "recursive" => Some(Self::Recursive),
            "delegated" => Some(Self::Delegated),
            _ => None,
        }
    }
}

impl Default for SyncMode {
    fn default() -> Self {
        Self::None
    }
}
