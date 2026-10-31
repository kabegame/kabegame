//! 外部网页窗口的原生标题：保留页面标题，并随界面语言重算上下文段。

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use kabegame_core::crawler::TaskScheduler;
use kabegame_core::plugin::manifest_value_display_for_locale;
use kabegame_i18n::{current_vd_locale, t};
use tauri::{AppHandle, Manager, Runtime, WebviewWindow};

#[derive(Clone)]
pub enum WebPageWindow {
    Surf { host: String },
    Crawler { task_id: String },
}

// window label → 窗口种类与最近一次页面标题，语言切换时据此重算。
static PAGE_TITLES: LazyLock<Mutex<HashMap<String, (WebPageWindow, String)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn on_page_title<R: Runtime>(
    window: &WebviewWindow<R>,
    kind: WebPageWindow,
    page_title: String,
) {
    let title = compose(&kind, &page_title);
    {
        let mut titles = PAGE_TITLES.lock().expect("window titles mutex poisoned");
        // 畅游含导航栏子 webview，需按 Window 查询，不能用 get_webview_window。
        titles.retain(|label, _| window.app_handle().get_window(label).is_some());
        titles.insert(window.label().to_string(), (kind, page_title));
    }
    let _ = window.set_title(&title);
}

pub fn initial_title(kind: &WebPageWindow) -> String {
    compose(kind, "")
}

pub fn refresh_all<R: Runtime>(app: &AppHandle<R>) {
    let windows: Vec<_> = {
        let mut titles = PAGE_TITLES.lock().expect("window titles mutex poisoned");
        titles.retain(|label, _| app.get_window(label).is_some());
        titles
            .iter()
            .map(|(label, (kind, title))| (label.clone(), kind.clone(), title.clone()))
            .collect()
    };
    // 放开缓存锁后再设置窗口标题，避免跨 UI 线程调用期间持锁。
    for (label, kind, page_title) in windows {
        if let Some(window) = app.get_window(&label) {
            let _ = window.set_title(&compose(&kind, &page_title));
        }
    }
}

fn compose(kind: &WebPageWindow, page_title: &str) -> String {
    let section = match kind {
        WebPageWindow::Surf { .. } => t!("window.surfSection").to_string(),
        WebPageWindow::Crawler { task_id } => TaskScheduler::global()
            .get_run(task_id)
            .map(|run| {
                manifest_value_display_for_locale(&run.params.plugin.name, current_vd_locale())
            })
            .unwrap_or_default(),
    };
    compose_parts(
        kind,
        page_title,
        &section,
        &t!("window.crawlerFallback"),
        &t!("common.appName"),
    )
}

// 中间段与翻译作为参数传入，让拼接规则可脱离调度器与全局语言测试。
fn compose_parts(
    kind: &WebPageWindow,
    page_title: &str,
    section: &str,
    crawler_fallback: &str,
    app_name: &str,
) -> String {
    let page_title = page_title.trim();
    let page = match kind {
        WebPageWindow::Surf { host } if page_title.is_empty() => host.as_str(),
        _ => page_title,
    };
    let section = match kind {
        WebPageWindow::Crawler { .. } if section.trim().is_empty() => crawler_fallback,
        _ => section,
    };
    [page, section, app_name]
        .into_iter()
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" - ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compose_surf_title_and_empty_page_fallback() {
        let kind = WebPageWindow::Surf {
            host: "example.com".into(),
        };
        assert_eq!(
            compose_parts(&kind, " 页面标题 ", "畅游", "WebView", "Kabegame"),
            "页面标题 - 畅游 - Kabegame"
        );
        for title in ["", " \n "] {
            assert_eq!(
                compose_parts(&kind, title, "Surf", "WebView", "Kabegame"),
                "example.com - Surf - Kabegame"
            );
        }
    }

    #[test]
    fn compose_crawler_omits_empty_page_and_falls_back_for_empty_plugin() {
        let kind = WebPageWindow::Crawler {
            task_id: "task".into(),
        };
        assert_eq!(
            compose_parts(&kind, " 页面 ", " 插件 ", "WebView", "Kabegame"),
            "页面 - 插件 - Kabegame"
        );
        assert_eq!(
            compose_parts(&kind, " \n ", "插件", "WebView", "Kabegame"),
            "插件 - Kabegame"
        );
        for plugin in ["", " \n "] {
            assert_eq!(
                compose_parts(&kind, "页面", plugin, "WebView", "Kabegame"),
                "页面 - WebView - Kabegame"
            );
            assert_eq!(
                compose_parts(&kind, "", plugin, "WebView", "Kabegame"),
                "WebView - Kabegame"
            );
        }
    }
}
