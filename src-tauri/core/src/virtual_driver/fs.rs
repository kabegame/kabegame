use std::sync::Arc;

use crate::providers::provider::Provider;

/// Kabegame 虚拟文件系统 Handler
pub struct KabegameFs {
    pub root: Arc<dyn Provider>,
}
