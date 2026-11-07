//! 应用页不随 Ctrl+滚轮缩放（CEF 补丁 10）。
//!
//! 主文档里的 Ctrl+滚轮由前端 `preventDefault`，但落在子 frame（壁纸 iframe）上的滚轮事件只派发给子文档，
//! 主文档的监听收不到；没被取消的 Ctrl+滚轮回到浏览器侧，Alloy 经 `ContentsZoomChange` 缩放整个
//! WebContents（主文档连同全部 iframe），缩放级别还按主 frame 的 host 存进 profile 的
//! `per_host_zoom_levels`，重启后仍在。补丁 10 让建窗时 `extra_info` 带本键的 browser 忽略这一路；
//! `CefBrowserHost::SetZoomLevel` 不受影响，加载完成时据此把以前存下的缩放复位。

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

/// 建 browser 时 `extra_info` 里的 bool 键；键名必须与补丁里的字面量一致。
pub(crate) const DISABLE_WHEEL_ZOOM_EXTRA_INFO_KEY: &str = "kabegame.disable_wheel_zoom";

static LABELS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn labels() -> &'static Mutex<HashSet<String>> {
    LABELS.get_or_init(|| Mutex::new(HashSet::new()))
}

/// 建窗前登记：该 label 的 browser 不随 Ctrl+滚轮缩放。
pub(crate) fn disable_wheel_zoom(webview_label: &str) {
    if let Ok(mut set) = labels().lock() {
        set.insert(webview_label.to_string());
    }
}

pub(crate) fn wheel_zoom_disabled(webview_label: &str) -> bool {
    labels()
        .lock()
        .map(|set| set.contains(webview_label))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::{disable_wheel_zoom, wheel_zoom_disabled};

    #[test]
    fn only_registered_labels_are_disabled() {
        disable_wheel_zoom("page-zoom-test-main");
        assert!(wheel_zoom_disabled("page-zoom-test-main"));
        assert!(!wheel_zoom_disabled("page-zoom-test-surf"));
    }
}
