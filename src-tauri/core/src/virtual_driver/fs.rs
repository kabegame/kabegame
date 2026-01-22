use std::sync::Arc;

use crate::providers::provider::Provider;

/// Kabegame 陌壽供譁・ｻｶ邉ｻ扈・Handler
pub struct KabegameFs {
    pub root: Arc<dyn Provider>,
}
