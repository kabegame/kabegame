//! 全局光标与子 frame 的原生鼠标注入。
//!
//! - 轮询中心（`hub`）：有订阅时一条后台线程每 16 ms 读一次全局光标与左键，按每个订阅自己的窗口换成
//!   该窗口客户区里的 CSS 像素（视图坐标，光标在窗口外也给出，可为负或越界）。没有订阅时线程退出。
//! - frame 注入（`frames`）：网页壁纸 / 场景宿主的 iframe 调 `plugin:cursor|attach_frame` 登记自己，插件按它所在
//!   窗口轮询光标，把移动与（按窗口的点击规则）左键交给应用设的注入器，由注入器直接注入这个 frame。图库预览与
//!   桌面壁纸窗口走同一条路，只是点击规则不同（[`ClickRule`]）。
//! - Rust 的 [`watch`] 与 [`position_in_window`] 也给别处用（场景开场时问一次真实光标）。
//! - 平台：Windows（`GetCursorPos` / `GetAsyncKeyState` / `WindowFromPoint`）与 macOS（`NSEvent` +
//!   窗口服务）读全局光标；Linux 读不到，应用把窗口登记成外部来源（[`register_external_pointer`]）后推送指针
//!   （[`push_external_pointer`]，带来源 [`PointerOrigin`]：桌面上的光标是 Plasma 壁纸插件转发的，窗口里的光标是窗口自己的
//!   页面交给应用的），没登记的窗口同其它平台：`watch` 返回 `None`，`attach_frame` 返回 `false`。
//!
//! 插件只给「光标位置、左键是否按着、光标下是什么」，什么时候算一次点击由点击规则定，怎么注入由应用定
//! （插件不依赖 CEF runtime）。

mod frames;
mod hub;
mod platform;

use tauri::plugin::{Builder, TauriPlugin};
use tauri::webview::PageLoadEvent;
use tauri::{RunEvent, Runtime, WebviewEvent, WindowEvent};

pub use frames::{set_click_rule, set_frame_injector, ClickRule, FrameInput};
pub use hub::{watch, HitTest, Sample, Watch};
pub use platform::{native_window, position_in_window, NativeWindow};
#[cfg(target_os = "linux")]
pub use platform::{
    push_external_pointer, register_external_pointer, unregister_external_pointer, PointerOrigin,
};

/// 插件名（前端 `plugin:cursor|...`）。
pub const PLUGIN_NAME: &str = "cursor";

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new(PLUGIN_NAME)
        .invoke_handler(tauri::generate_handler![
            frames::attach_frame,
            frames::detach_frame
        ])
        // 主 frame 开始加载新文档（刷新、导航）：旧文档里的子 frame 全部作废
        .on_page_load(|webview, payload| {
            if payload.event() == PageLoadEvent::Started {
                frames::release_webview(webview.label());
            }
        })
        .on_event(|_app, event| match event {
            // 子 frame 销毁（关预览、切壁纸、窗口刷新）：清它的登记
            RunEvent::WebviewEvent {
                label,
                event: WebviewEvent::SubframeDestroyed(frame),
                ..
            } => frames::release_frame(label, frame.as_str()),
            // 窗口销毁：清它的全部登记
            RunEvent::WindowEvent {
                label,
                event: WindowEvent::Destroyed,
                ..
            } => frames::release_webview(label),
            _ => {}
        })
        .build()
}
