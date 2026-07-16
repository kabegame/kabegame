//! 构建变体上报。前端据此适配 UI（android 精简、web 只读回弹等）。
//!
//! 这些 feature（`web` / `android` / `standard`）是 **`kabegame` crate** 自己的，
//! kabegame-core 里并不存在，所以本函数留在 kabegame crate。web dispatch 与桌面
//! Tauri 命令（`commands::plugin::get_build_mode`）共用本实现，因此模块不随
//! web/not-web 门控（见 `lib.rs`）。

use serde_json::Value;

pub fn get_build_mode() -> Result<Value, String> {
    let mode = if cfg!(feature = "web") {
        "web"
    } else if cfg!(feature = "android") {
        "android"
    } else if cfg!(feature = "standard") {
        "standard"
    } else {
        "unknown"
    };
    Ok(Value::String(mode.to_string()))
}
