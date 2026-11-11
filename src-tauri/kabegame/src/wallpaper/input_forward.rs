//! 桌面鼠标转发：把用户在桌面上的移动与左键点击注入到壁纸窗口（WPE 网页 / 场景壁纸）。
//!
//! 照 Wallpaper Engine 的做法：不装鼠标钩子，而是由后台线程每帧轮询光标位置与左键状态。
//! - 光标在壁纸窗口范围内移动 → 注入 `Move`（视图坐标）；离开时注入一次 `Leave`。
//! - 左键按下沿 → 只有光标下是桌面（空白处或图标，而不是别的应用窗口）才注入 `LeftDown`；
//!   抬起沿只要按下被转发过就注入 `LeftUp`，保证按下 / 抬起成对。
//! - 不拦截、不吞掉任何输入：系统的桌面（Explorer / Finder）照常收到点击。
//! - 设置「暂停壁纸」打开时不转发（每轮读设置）：进入暂停时补一次 `Leave` 与未配对的 `LeftUp`，页面不会停在
//!   悬停 / 按住状态；恢复后按当前光标照常注入。
//!
//! 「读光标与左键」「光标下是不是桌面」两件事随平台不同，由 [`DesktopProbe`] 提供（Windows 见 [`win`]，
//! macOS 见 [`mac`]）；转发规则本身是 [`ForwardState`]，与平台无关。注入走 CEF（`inject_mouse`），不依赖窗口
//! 焦点与 Z 序。
//!
//! 只在「窗口模式 + 当前是网页 / 场景壁纸」时运行，由 `WallpaperWindow`（`wallpaper/window.rs`）启停。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use kabegame_core::settings::Settings;
use tauri_runtime_kbcef::MouseInjection;

#[cfg(target_os = "macos")]
pub(crate) mod mac;
#[cfg(target_os = "windows")]
pub(crate) mod win;

/// 轮询周期（约 60 Hz）。
const POLL_INTERVAL: Duration = Duration::from_millis(16);

/// 一次轮询读到的状态。
#[derive(Debug, Clone, Copy)]
pub(crate) struct Sample {
    /// 光标的视图坐标（DIP，相对壁纸窗口左上角）；光标在窗口外时也给出（可能为负或越界）。
    pub view: (i32, i32),
    /// 光标是否在壁纸窗口范围内。
    pub inside: bool,
    /// 左键是否按着。
    pub left_down: bool,
}

/// 平台探针：转发线程独占，所有方法都在那条线程上调用。
pub(crate) trait DesktopProbe: Send + 'static {
    /// 壁纸窗口还在不在；不在就结束转发。每轮调用一次。
    fn alive(&mut self) -> bool;
    /// 读一次光标与左键；读不到返回 `None`，本轮跳过。
    fn sample(&mut self) -> Option<Sample>;
    /// 上一次 [`Self::sample`] 的光标下是不是桌面（空白处或图标）。只在左键按下沿调用。
    fn over_desktop(&mut self) -> bool;
}

/// 正在运行的转发线程。`stop()` 只置停止标志、不 join：线程最多一个周期后自行退出，
/// 调用方（可能在主线程）不会被阻塞。
pub struct InputForwarder {
    stop: Arc<AtomicBool>,
    _handle: JoinHandle<()>,
}

impl InputForwarder {
    /// 为 `webview_label` 的壁纸窗口启动转发线程，光标与桌面判断由 `probe` 提供。
    pub(crate) fn start(webview_label: &str, probe: impl DesktopProbe) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let label = webview_label.to_string();
        let thread_stop = stop.clone();
        let handle = std::thread::Builder::new()
            .name("wpe-input-forward".into())
            .spawn(move || run(label, probe, thread_stop))
            .expect("spawn wpe input forward thread");
        Self {
            stop,
            _handle: handle,
        }
    }

    pub fn stop(&self) {
        self.stop.store(true, Ordering::Release);
    }
}

impl Drop for InputForwarder {
    fn drop(&mut self) {
        self.stop();
    }
}

/// 转发规则的状态：上一轮注入过什么，决定这一轮要补什么。
#[derive(Debug, Default)]
struct ForwardState {
    /// 上一次注入移动时的视图坐标（光标在窗口范围内时）。
    last_move: Option<(i32, i32)>,
    /// 上一轮的视图坐标（停止时补发抬起用）。
    last_view: (i32, i32),
    was_down: bool,
    down_forwarded: bool,
}

impl ForwardState {
    /// 处理一次轮询结果，把该注入的事件交给 `emit`。`over_desktop` 只在左键按下沿、且光标在窗口范围内时才求值。
    fn step(
        &mut self,
        sample: Sample,
        paused: bool,
        over_desktop: impl FnOnce() -> bool,
        emit: &mut impl FnMut(MouseInjection),
    ) {
        let (x, y) = sample.view;
        if paused {
            // 暂停的壁纸不接收桌面事件。按键状态照常记（末尾），恢复时左键还按着不会被当成一次新的按下
            if self.last_move.take().is_some() {
                emit(MouseInjection::Leave { x, y });
            }
            if self.down_forwarded {
                emit(MouseInjection::LeftUp { x, y });
                self.down_forwarded = false;
            }
        } else {
            if sample.inside {
                if self.last_move != Some(sample.view) {
                    emit(MouseInjection::Move { x, y });
                    self.last_move = Some(sample.view);
                }
            } else if self.last_move.take().is_some() {
                emit(MouseInjection::Leave { x, y });
            }

            if sample.left_down && !self.was_down {
                // 按下沿：只转发落在本窗口范围内、且光标下是桌面（空白处或图标）的点击。
                if sample.inside && over_desktop() {
                    emit(MouseInjection::LeftDown { x, y });
                    self.down_forwarded = true;
                }
            } else if !sample.left_down && self.was_down && self.down_forwarded {
                emit(MouseInjection::LeftUp { x, y });
                self.down_forwarded = false;
            }
        }

        self.was_down = sample.left_down;
        self.last_view = sample.view;
    }

    /// 停止时若按下已转发而尚未抬起，补一次抬起，页面不会卡在「按住」状态。
    fn finish(&mut self, emit: &mut impl FnMut(MouseInjection)) {
        if self.down_forwarded {
            let (x, y) = self.last_view;
            emit(MouseInjection::LeftUp { x, y });
            self.down_forwarded = false;
        }
    }
}

fn inject(label: &str, input: MouseInjection) {
    if let Err(error) = tauri_runtime_kbcef::inject_mouse(label, input) {
        tracing::warn!("注入鼠标事件失败: {error}");
    }
}

fn run(label: String, mut probe: impl DesktopProbe, stop: Arc<AtomicBool>) {
    tracing::debug!("桌面鼠标转发开始: {label}");
    let mut state = ForwardState::default();
    let mut emit = |input| inject(&label, input);

    while !stop.load(Ordering::Acquire) && probe.alive() {
        if let Some(sample) = probe.sample() {
            let paused = Settings::global().get_wallpaper_paused();
            state.step(sample, paused, || probe.over_desktop(), &mut emit);
        }
        std::thread::sleep(POLL_INTERVAL);
    }

    state.finish(&mut emit);
    tracing::debug!("桌面鼠标转发结束: {label}");
}

#[cfg(test)]
mod tests {
    use super::*;
    use MouseInjection::{Leave, LeftDown, LeftUp, Move};

    fn sample(x: i32, y: i32, inside: bool, left_down: bool) -> Sample {
        Sample {
            view: (x, y),
            inside,
            left_down,
        }
    }

    /// 依次喂入 `(采样, 是否暂停, 光标下是否桌面)`，返回注入序列；`finish` 为真时最后按停止收尾。
    fn drive(steps: &[(Sample, bool, bool)], finish: bool) -> Vec<MouseInjection> {
        let mut state = ForwardState::default();
        let mut out = Vec::new();
        let mut emit = |input| out.push(input);
        for (sample, paused, desktop) in steps {
            state.step(*sample, *paused, || *desktop, &mut emit);
        }
        if finish {
            state.finish(&mut emit);
        }
        out
    }

    #[test]
    fn move_is_deduplicated_and_leave_sent_once() {
        let out = drive(
            &[
                (sample(10, 10, true, false), false, true),
                (sample(10, 10, true, false), false, true),
                (sample(11, 10, true, false), false, true),
                (sample(-5, 10, false, false), false, true),
                (sample(-9, 10, false, false), false, true),
            ],
            false,
        );
        assert_eq!(
            out,
            [
                Move { x: 10, y: 10 },
                Move { x: 11, y: 10 },
                Leave { x: -5, y: 10 }
            ]
        );
    }

    #[test]
    fn click_is_forwarded_only_over_desktop_and_inside() {
        // 光标下是别的应用窗口：按下 / 抬起都不转发
        let over_app = drive(
            &[
                (sample(5, 5, true, true), false, false),
                (sample(5, 5, true, false), false, false),
            ],
            true,
        );
        assert_eq!(over_app, [Move { x: 5, y: 5 }]);

        // 光标在窗口范围外（另一块屏）：即使是桌面也不转发
        let outside = drive(
            &[
                (sample(-5, 5, false, true), false, true),
                (sample(-5, 5, false, false), false, true),
            ],
            true,
        );
        assert_eq!(outside, []);

        let on_desktop = drive(
            &[
                (sample(5, 5, true, true), false, true),
                // 按住期间不重复按下
                (sample(6, 5, true, true), false, true),
                (sample(6, 5, true, false), false, true),
            ],
            true,
        );
        assert_eq!(
            on_desktop,
            [
                Move { x: 5, y: 5 },
                LeftDown { x: 5, y: 5 },
                Move { x: 6, y: 5 },
                LeftUp { x: 6, y: 5 }
            ]
        );
    }

    #[test]
    fn release_outside_window_still_pairs_the_press() {
        let out = drive(
            &[
                (sample(5, 5, true, true), false, true),
                (sample(-3, 5, false, true), false, true),
                (sample(-3, 5, false, false), false, false),
            ],
            false,
        );
        assert_eq!(
            out,
            [
                Move { x: 5, y: 5 },
                LeftDown { x: 5, y: 5 },
                Leave { x: -3, y: 5 },
                LeftUp { x: -3, y: 5 }
            ]
        );
    }

    #[test]
    fn stop_while_pressed_sends_release() {
        let out = drive(&[(sample(5, 5, true, true), false, true)], true);
        assert_eq!(
            out,
            [
                Move { x: 5, y: 5 },
                LeftDown { x: 5, y: 5 },
                LeftUp { x: 5, y: 5 }
            ]
        );
    }

    #[test]
    fn pause_flushes_hover_and_press_then_stays_silent() {
        let out = drive(
            &[
                (sample(5, 5, true, true), false, true),
                // 进入暂停：补离开与抬起
                (sample(6, 5, true, true), true, true),
                // 暂停期间不注入
                (sample(7, 5, true, true), true, true),
                // 恢复时左键还按着：不算新的按下，只恢复移动
                (sample(8, 5, true, true), false, true),
                (sample(8, 5, true, false), false, true),
            ],
            true,
        );
        assert_eq!(
            out,
            [
                Move { x: 5, y: 5 },
                LeftDown { x: 5, y: 5 },
                Leave { x: 6, y: 5 },
                LeftUp { x: 6, y: 5 },
                Move { x: 8, y: 5 }
            ]
        );
    }
}
