//! 子 frame 的原生鼠标注入：frame 自己登记（`plugin:cursor|attach_frame`），插件按它所在窗口轮询全局光标，
//! 把移动与左键交给应用设的注入器（[`set_frame_injector`]），注入器再把事件直接注入这个 frame。
//!
//! - 坐标：交给注入器的是窗口客户区的 CSS 像素（= 浏览器视图坐标），光标在窗口外时也照给；换算到 frame、
//!   钳进 frame 都由注入器做（插件不知道 frame 在窗口里的位置）。
//! - 移动：位置变了才发。
//! - 按下：只在左键按下沿、光标在窗口范围内、且满足这个窗口的点击规则（[`ClickRule`]）时发；抬起沿只在
//!   按下发过时发，保证成对。登记时左键已按着不算一次按下。
//! - 离开：外部来源（Linux）说光标离开了它的范围（`Sample::present` 为假）时发一次 [`FrameInput::Leave`]（注入器补抬起
//!   与离开），之后再有位置时照常移动（页面看到重新进入）；离开期间不发按下。
//! - 收尾：解除登记、frame 销毁、主文档重新加载、窗口销毁时发一次 [`FrameInput::Release`]（注入器补抬起与离开）。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use tauri::ipc::CallerFrame;
use tauri::{Runtime, Webview};

use crate::hub::{self, HitTest, Sample, Watch};
use crate::platform;

/// 交给注入器的输入。坐标是窗口客户区的 CSS 像素（浏览器视图坐标），可越界。
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum FrameInput {
    Move {
        x: f64,
        y: f64,
    },
    /// 左键按下。注入器还要判断按下点是否落在 frame 里，不在就作废（连同之后的抬起）。
    Down {
        x: f64,
        y: f64,
    },
    Up {
        x: f64,
        y: f64,
    },
    /// 光标离开了（外部来源给不出位置）：补未配对的抬起与一次离开，之后的移动照常注入。
    Leave,
    /// 停止向这个 frame 注入：补未配对的抬起与一次离开。
    Release,
}

/// 左键按下沿什么时候算一次点击，按窗口 label 设（[`set_click_rule`]）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ClickRule {
    /// 光标下的顶层窗口就是本窗口：只收应用内的点击，允许和浮在 frame 上的界面重叠（图库预览）。
    #[default]
    OverWindow,
    /// 光标下是桌面（空白处或图标，而不是别的应用窗口）：壁纸窗口在桌面层，真实点击落到系统桌面上。
    OverDesktop,
}

/// 注入器：`(webview label, frame 标识, 输入)`。在插件的轮询线程上调用，不能阻塞。
type Injector = dyn Fn(&str, &str, FrameInput) + Send + Sync;

static INJECTOR: OnceLock<Box<Injector>> = OnceLock::new();
static CLICK_RULES: OnceLock<Mutex<HashMap<String, ClickRule>>> = OnceLock::new();
/// 已登记的 frame：`(webview label, frame 标识)` → 轮询订阅。丢弃订阅即停止，回调在轮询线程上 drop 时发收尾。
static FRAMES: OnceLock<Mutex<HashMap<(String, String), Watch>>> = OnceLock::new();

/// 设注入器（应用 setup 时调一次；之后再调不生效）。没设时 `attach_frame` 返回 `false`。
pub fn set_frame_injector(injector: impl Fn(&str, &str, FrameInput) + Send + Sync + 'static) {
    if INJECTOR.set(Box::new(injector)).is_err() {
        tracing::warn!("frame 注入器已设置过，忽略");
    }
}

/// 设 `label` 窗口的点击规则（缺省 [`ClickRule::OverWindow`]）。只影响之后登记的 frame。
pub fn set_click_rule(label: &str, rule: ClickRule) {
    click_rules()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(label.to_string(), rule);
}

fn click_rules() -> &'static Mutex<HashMap<String, ClickRule>> {
    CLICK_RULES.get_or_init(Default::default)
}

fn click_rule(label: &str) -> ClickRule {
    click_rules()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(label)
        .copied()
        .unwrap_or_default()
}

fn frames() -> &'static Mutex<HashMap<(String, String), Watch>> {
    FRAMES.get_or_init(Default::default)
}

/// 一个 frame 的「采样 → 输入」规则（与平台、注入无关）。
#[derive(Debug, Default)]
struct FrameDriver {
    /// 上一次发出的移动位置。
    last: Option<(f64, f64)>,
    /// 上一轮左键是否按着；`None` 是还没采样过（登记时已按着的左键不算按下沿）。
    was_down: Option<bool>,
    /// 按下已发出、还没抬起。
    down_sent: bool,
    /// 已发过离开、还没再有位置。
    gone: bool,
}

impl FrameDriver {
    fn step(
        &mut self,
        sample: Sample,
        rule: ClickRule,
        hit: &mut dyn HitTest,
        emit: &mut dyn FnMut(FrameInput),
    ) {
        let (x, y) = sample.view;
        if !sample.present {
            // 离开只发一次；注入器补抬起，这边的按下随之作废（之后的松开不再配对）
            if !self.gone && self.last.is_some() {
                emit(FrameInput::Leave);
            }
            self.gone = true;
            self.last = None;
            self.down_sent = false;
            self.was_down = Some(sample.left_down);
            return;
        }
        self.gone = false;
        if self.last != Some(sample.view) {
            emit(FrameInput::Move { x, y });
            self.last = Some(sample.view);
        }
        let was_down = self.was_down.replace(sample.left_down);
        match (was_down, sample.left_down) {
            (Some(false), true) => {
                // 先判窗口范围：命中测试在 macOS 上要上主线程，窗口外不必问
                let allowed = sample.inside
                    && match rule {
                        ClickRule::OverWindow => hit.over_window(),
                        ClickRule::OverDesktop => hit.over_desktop(),
                    };
                if allowed {
                    emit(FrameInput::Down { x, y });
                    self.down_sent = true;
                }
            }
            (Some(true), false) if self.down_sent => {
                emit(FrameInput::Up { x, y });
                self.down_sent = false;
            }
            _ => {}
        }
    }
}

/// 轮询回调持有的东西：随订阅移除在轮询线程上 drop，那时发收尾。
struct FrameFeed {
    label: String,
    frame: String,
    rule: ClickRule,
    driver: FrameDriver,
    inject: &'static Injector,
}

impl FrameFeed {
    fn step(&mut self, sample: Sample, hit: &mut dyn HitTest) {
        let (label, frame, inject) = (&self.label, &self.frame, self.inject);
        self.driver.step(sample, self.rule, hit, &mut |input| {
            inject(label, frame, input)
        });
    }
}

impl Drop for FrameFeed {
    fn drop(&mut self) {
        (self.inject)(&self.label, &self.frame, FrameInput::Release);
        tracing::debug!("frame 鼠标注入结束: {} / {}", self.label, self.frame);
    }
}

/// 子 frame 登记自己：之后它所在窗口的光标移动与（按规则的）左键注入到它。已登记时什么都不做。
/// 返回是否在注入：拿不到光标（Linux 上没登记成外部来源的窗口，见 `register_external_pointer`）或应用没设注入器时
/// `false`。只能由子 frame 调用。
/// 异步命令：取窗口句柄在 macOS 上要等主线程。
#[tauri::command]
pub async fn attach_frame<R: Runtime>(
    webview: Webview<R>,
    frame: CallerFrame,
) -> Result<bool, String> {
    let CallerFrame::Sub(frame) = frame else {
        return Err("attach_frame 只能由子 frame 调用".into());
    };
    let key = (webview.label().to_string(), frame.as_str().to_string());
    if frames().lock().unwrap().contains_key(&key) {
        return Ok(true);
    }
    let Some(inject) = INJECTOR.get() else {
        return Ok(false);
    };
    let Some(native) = platform::native_window(&webview.window()) else {
        return Ok(false);
    };
    let mut map = frames().lock().unwrap();
    // 取句柄期间同一个 frame 又登记了一次
    if map.contains_key(&key) {
        return Ok(true);
    }
    let mut feed = FrameFeed {
        label: key.0.clone(),
        frame: key.1.clone(),
        rule: click_rule(&key.0),
        driver: FrameDriver::default(),
        inject: inject.as_ref(),
    };
    let Some(watch) = hub::watch(native, move |sample, hit| feed.step(sample, hit)) else {
        return Ok(false);
    };
    tracing::debug!("frame 鼠标注入开始: {} / {}", key.0, key.1);
    map.insert(key, watch);
    Ok(true)
}

/// 子 frame 解除登记（补抬起与离开）。没登记过时什么都不做。只能由子 frame 调用。
#[tauri::command]
pub fn detach_frame<R: Runtime>(webview: Webview<R>, frame: CallerFrame) -> Result<(), String> {
    let CallerFrame::Sub(frame) = frame else {
        return Err("detach_frame 只能由子 frame 调用".into());
    };
    release_frame(webview.label(), frame.as_str());
    Ok(())
}

/// 清一个 frame 的登记（frame 销毁时）。
pub(crate) fn release_frame(label: &str, frame: &str) {
    let removed = frames()
        .lock()
        .unwrap()
        .remove(&(label.to_string(), frame.to_string()));
    // 出锁再丢：订阅的 Drop 只置标志，收尾在轮询线程上发
    drop(removed);
}

/// 清某个 webview 的全部登记（主文档重新加载、窗口销毁时）。
pub(crate) fn release_webview(label: &str) {
    let removed: Vec<Watch> = {
        let mut map = frames().lock().unwrap();
        let keys: Vec<_> = map.keys().filter(|key| key.0 == label).cloned().collect();
        keys.into_iter()
            .filter_map(|key| map.remove(&key))
            .collect()
    };
    drop(removed);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub::{Hub, Probe};
    use FrameInput::{Down, Move, Up};

    struct FakeHit {
        desktop: bool,
        window: bool,
        asked: u32,
    }

    impl HitTest for FakeHit {
        fn over_desktop(&mut self) -> bool {
            self.asked += 1;
            self.desktop
        }
        fn over_window(&mut self) -> bool {
            self.asked += 1;
            self.window
        }
    }

    fn sample(x: f64, y: f64, inside: bool, left_down: bool) -> Sample {
        Sample {
            view: (x, y),
            inside,
            left_down,
            present: true,
        }
    }

    /// 依次喂入采样，返回输入序列与命中测试被问的次数。
    fn drive(
        rule: ClickRule,
        desktop: bool,
        window: bool,
        samples: &[Sample],
    ) -> (Vec<FrameInput>, u32) {
        let mut driver = FrameDriver::default();
        let mut hit = FakeHit {
            desktop,
            window,
            asked: 0,
        };
        let mut out = Vec::new();
        for s in samples {
            driver.step(*s, rule, &mut hit, &mut |input| out.push(input));
        }
        (out, hit.asked)
    }

    /// 窗口内一次完整的按下抬起。
    const CLICK: [Sample; 3] = [
        Sample {
            view: (5.0, 5.0),
            inside: true,
            left_down: false,
            present: true,
        },
        Sample {
            view: (5.0, 5.0),
            inside: true,
            left_down: true,
            present: true,
        },
        Sample {
            view: (5.0, 5.0),
            inside: true,
            left_down: false,
            present: true,
        },
    ];

    #[test]
    fn moves_are_sent_only_when_the_position_changes_even_outside() {
        let (out, _) = drive(
            ClickRule::OverWindow,
            false,
            true,
            &[
                sample(10.0, 10.0, true, false),
                sample(10.0, 10.0, true, false),
                // 窗口外照发（注入器钳进 frame）
                sample(-50.0, 10.0, false, false),
                sample(-50.0, 10.0, false, false),
            ],
        );
        assert_eq!(out, [Move { x: 10.0, y: 10.0 }, Move { x: -50.0, y: 10.0 }]);
    }

    #[test]
    fn over_window_rule_clicks_only_over_this_window() {
        let (out, _) = drive(ClickRule::OverWindow, false, true, &CLICK);
        assert_eq!(
            out,
            [
                Move { x: 5.0, y: 5.0 },
                Down { x: 5.0, y: 5.0 },
                Up { x: 5.0, y: 5.0 }
            ]
        );
        // 光标下是别的窗口（盖在本窗口上）：不发；按桌面也不算
        let (out, _) = drive(ClickRule::OverWindow, true, false, &CLICK);
        assert_eq!(out, [Move { x: 5.0, y: 5.0 }]);
    }

    #[test]
    fn over_desktop_rule_clicks_only_over_the_desktop() {
        let (out, _) = drive(ClickRule::OverDesktop, true, false, &CLICK);
        assert_eq!(
            out,
            [
                Move { x: 5.0, y: 5.0 },
                Down { x: 5.0, y: 5.0 },
                Up { x: 5.0, y: 5.0 }
            ]
        );
        let (out, _) = drive(ClickRule::OverDesktop, false, true, &CLICK);
        assert_eq!(out, [Move { x: 5.0, y: 5.0 }]);
    }

    #[test]
    fn press_outside_the_window_is_not_sent_and_hit_test_is_skipped() {
        let (out, asked) = drive(
            ClickRule::OverDesktop,
            true,
            true,
            &[
                sample(-5.0, 5.0, false, false),
                sample(-5.0, 5.0, false, true),
                sample(-5.0, 5.0, false, false),
            ],
        );
        assert_eq!(out, [Move { x: -5.0, y: 5.0 }]);
        assert_eq!(asked, 0, "窗口外不必问命中");
    }

    #[test]
    fn button_already_down_when_attached_is_not_a_press() {
        let (out, _) = drive(
            ClickRule::OverWindow,
            false,
            true,
            &[
                sample(5.0, 5.0, true, true),
                sample(6.0, 5.0, true, true),
                sample(6.0, 5.0, true, false),
            ],
        );
        assert_eq!(out, [Move { x: 5.0, y: 5.0 }, Move { x: 6.0, y: 5.0 }]);
    }

    /// 外部来源说光标离开了：位置不可知的样本。
    fn gone(x: f64, y: f64, left_down: bool) -> Sample {
        Sample {
            present: false,
            ..sample(x, y, false, left_down)
        }
    }

    #[test]
    fn leave_is_sent_once_and_moves_resume_after_it() {
        let (out, _) = drive(
            ClickRule::OverDesktop,
            true,
            false,
            &[
                sample(5.0, 5.0, true, false),
                gone(5.0, 5.0, false),
                gone(5.0, 5.0, false),
                // 回来：同一个位置也要重新发移动（页面看到重新进入）
                sample(5.0, 5.0, true, false),
            ],
        );
        assert_eq!(
            out,
            [
                Move { x: 5.0, y: 5.0 },
                FrameInput::Leave,
                Move { x: 5.0, y: 5.0 }
            ]
        );
    }

    #[test]
    fn leave_before_any_position_sends_nothing() {
        let (out, _) = drive(ClickRule::OverDesktop, true, false, &[gone(0.0, 0.0, false)]);
        assert!(out.is_empty());
    }

    #[test]
    fn leave_while_pressed_drops_the_pending_release() {
        // 按着离开：注入器在离开时补抬起，回来后的松开不再配对
        let (out, _) = drive(
            ClickRule::OverDesktop,
            true,
            false,
            &[
                sample(5.0, 5.0, true, false),
                sample(5.0, 5.0, true, true),
                gone(5.0, 5.0, true),
                sample(7.0, 5.0, true, true),
                sample(7.0, 5.0, true, false),
            ],
        );
        assert_eq!(
            out,
            [
                Move { x: 5.0, y: 5.0 },
                Down { x: 5.0, y: 5.0 },
                FrameInput::Leave,
                Move { x: 7.0, y: 5.0 }
            ]
        );
    }

    #[test]
    fn press_after_coming_back_is_a_new_click() {
        // 离开期间松开、回来后再按：是一次新的按下
        let (out, _) = drive(
            ClickRule::OverDesktop,
            true,
            false,
            &[
                sample(5.0, 5.0, true, false),
                gone(5.0, 5.0, false),
                sample(6.0, 5.0, true, false),
                sample(6.0, 5.0, true, true),
                sample(6.0, 5.0, true, false),
            ],
        );
        assert_eq!(
            out,
            [
                Move { x: 5.0, y: 5.0 },
                FrameInput::Leave,
                Move { x: 6.0, y: 5.0 },
                Down { x: 6.0, y: 5.0 },
                Up { x: 6.0, y: 5.0 }
            ]
        );
    }

    #[test]
    fn release_outside_still_pairs_the_press() {
        let (out, _) = drive(
            ClickRule::OverWindow,
            false,
            true,
            &[
                sample(5.0, 5.0, true, false),
                sample(5.0, 5.0, true, true),
                sample(-3.0, 5.0, false, true),
                sample(-3.0, 5.0, false, false),
            ],
        );
        assert_eq!(
            out,
            [
                Move { x: 5.0, y: 5.0 },
                Down { x: 5.0, y: 5.0 },
                Move { x: -3.0, y: 5.0 },
                Up { x: -3.0, y: 5.0 }
            ]
        );
    }

    #[test]
    fn dropping_the_feed_releases_the_frame() {
        static SEEN: Mutex<Vec<(String, String, FrameInput)>> = Mutex::new(Vec::new());
        let inject: &'static Injector = Box::leak(Box::new(|label: &str, frame: &str, input| {
            SEEN.lock()
                .unwrap()
                .push((label.to_string(), frame.to_string(), input));
        }));
        let mut feed = FrameFeed {
            label: "t-feed".into(),
            frame: "9".into(),
            rule: ClickRule::OverWindow,
            driver: FrameDriver::default(),
            inject,
        };
        let mut hit = FakeHit {
            desktop: false,
            window: true,
            asked: 0,
        };
        feed.step(sample(1.0, 2.0, true, false), &mut hit);
        drop(feed);
        let seen = SEEN.lock().unwrap();
        let mine: Vec<_> = seen
            .iter()
            .filter(|(label, frame, _)| label == "t-feed" && frame == "9")
            .map(|(_, _, input)| *input)
            .collect();
        assert_eq!(mine, [Move { x: 1.0, y: 2.0 }, FrameInput::Release]);
    }

    struct Idle;
    impl Probe for Idle {
        fn alive(&mut self) -> bool {
            true
        }
        fn sample(&mut self) -> Option<Sample> {
            None
        }
        fn over_desktop(&mut self) -> bool {
            false
        }
        fn over_window(&mut self) -> bool {
            false
        }
    }

    fn add(hub: &Hub, label: &str, frame: &str) {
        let watch = hub.watch_probe(Box::new(Idle), |_, _| {});
        frames()
            .lock()
            .unwrap()
            .insert((label.to_string(), frame.to_string()), watch);
    }

    fn has(label: &str, frame: &str) -> bool {
        frames()
            .lock()
            .unwrap()
            .contains_key(&(label.to_string(), frame.to_string()))
    }

    #[test]
    fn release_clears_only_the_given_frames() {
        let hub = Hub::new();
        add(&hub, "t-release-a", "1");
        add(&hub, "t-release-a", "2");
        add(&hub, "t-release-b", "1");
        release_webview("t-release-a");
        assert!(!has("t-release-a", "1") && !has("t-release-a", "2"));
        assert!(has("t-release-b", "1"));
        release_frame("t-release-b", "1");
        assert!(!has("t-release-b", "1"));
        // 没登记过：什么都不做
        release_frame("t-release-b", "1");
    }

    #[test]
    fn click_rule_defaults_to_over_window() {
        assert_eq!(click_rule("t-rule-unset"), ClickRule::OverWindow);
        set_click_rule("t-rule-desktop", ClickRule::OverDesktop);
        assert_eq!(click_rule("t-rule-desktop"), ClickRule::OverDesktop);
    }
}
