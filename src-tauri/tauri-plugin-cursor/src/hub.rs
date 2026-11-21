//! 轮询中心：进程级的一条后台线程，每 16 ms 采样一次全部订阅窗口的光标与左键（Linux 的外部来源是取走两轮之间推来的
//! 样本，见 `platform::linux`）。
//!
//! 线程只在有订阅时存在：第一个 [`watch`] 启动它，最后一个订阅被移除后它自行退出，没有订阅时不占 CPU、
//! 不忙等。所有回调都在这条线程上依次调用；订阅被丢弃（[`Watch`] drop）或窗口不在了，回调也在这条线程上
//! drop，所以回调的 `Drop` 里可以补发收尾事件（例如 frame 注入补未配对的抬起与离开）。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::Duration;

use crate::platform::{self, NativeWindow};

/// 轮询周期（约 60 Hz）。
const POLL_INTERVAL: Duration = Duration::from_millis(16);

/// 一次采样：光标在窗口客户区里的视图坐标（CSS 像素 / DIP，光标在窗口外也给出，可为负或越界）、
/// 是否在窗口内、左键是否按着、位置是否可知。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Sample {
    pub view: (f64, f64),
    pub inside: bool,
    pub left_down: bool,
    /// 光标位置可知。读全局光标的平台恒为真；外部来源（Linux，见 `platform::linux`）在光标离开它的范围后为假，
    /// 这时 `view` 是离开前最后的位置，frame 收到一次离开。
    pub present: bool,
}

/// 回调里按需问「上一次采样的光标下是什么」。只在需要时求值（Windows 一次 `WindowFromPoint`，
/// macOS 要上主线程），所以放在回调里按需调，不随每次采样算。
pub trait HitTest {
    /// 光标下是桌面（空白处或图标，而不是别的应用窗口）。
    fn over_desktop(&mut self) -> bool;
    /// 光标下的顶层窗口就是被观察的窗口（没被别的窗口盖住）。
    fn over_window(&mut self) -> bool;
}

/// 平台探针：轮询线程独占，所有方法都在那条线程上调用。
pub(crate) trait Probe: Send + 'static {
    /// 窗口还在不在；不在就移除订阅。每轮调用一次。
    fn alive(&mut self) -> bool;
    /// 读一次光标与左键；读不到（外部来源：没有新样本）返回 `None`，本轮跳过。
    fn sample(&mut self) -> Option<Sample>;
    /// 本轮还有没交出的样本（外部来源在两轮之间攒下的按下 / 抬起，一轮全部交出，边沿不丢）。读全局光标的平台
    /// 一轮只有一个。
    fn has_more(&mut self) -> bool {
        false
    }
    /// 上一次 [`Self::sample`] 的光标下是不是桌面。
    fn over_desktop(&mut self) -> bool;
    /// 上一次 [`Self::sample`] 的光标下的顶层窗口是不是被观察的窗口。
    fn over_window(&mut self) -> bool;
}

struct Hit<'a>(&'a mut dyn Probe);

impl HitTest for Hit<'_> {
    fn over_desktop(&mut self) -> bool {
        self.0.over_desktop()
    }
    fn over_window(&mut self) -> bool {
        self.0.over_window()
    }
}

type Callback = Box<dyn FnMut(Sample, &mut dyn HitTest) + Send>;

struct Entry {
    probe: Box<dyn Probe>,
    callback: Callback,
    /// 订阅句柄丢弃时置位，轮询线程下一轮移除。
    dropped: Arc<AtomicBool>,
}

/// 订阅句柄：丢弃即停止。只置标志，轮询线程下一轮把订阅移除并在那条线程上丢弃回调。
pub struct Watch {
    dropped: Arc<AtomicBool>,
    shared: Arc<Shared>,
}

impl Drop for Watch {
    fn drop(&mut self) {
        self.dropped.store(true, Ordering::Release);
        // 唤醒线程尽快清理（等待周期里也会醒）
        self.shared.wake.notify_all();
    }
}

#[derive(Default)]
struct State {
    pending: Vec<Entry>,
    running: bool,
}

#[derive(Default)]
struct Shared {
    state: Mutex<State>,
    wake: Condvar,
}

/// 轮询中心。全局只有一个（[`watch`] 用），测试里可以单独建一个并注入假探针。
pub(crate) struct Hub {
    shared: Arc<Shared>,
}

impl Hub {
    pub(crate) fn new() -> Self {
        Self {
            shared: Arc::new(Shared::default()),
        }
    }

    /// 轮询线程当前是否存在（测试用：没有订阅时它应当已退出）。
    #[cfg(test)]
    pub(crate) fn is_running(&self) -> bool {
        self.shared.state.lock().unwrap().running
    }

    pub(crate) fn watch_probe(
        &self,
        probe: Box<dyn Probe>,
        callback: impl FnMut(Sample, &mut dyn HitTest) + Send + 'static,
    ) -> Watch {
        let dropped = Arc::new(AtomicBool::new(false));
        let entry = Entry {
            probe,
            callback: Box::new(callback),
            dropped: dropped.clone(),
        };
        let mut state = self.shared.state.lock().unwrap();
        state.pending.push(entry);
        if !state.running {
            state.running = true;
            let shared = self.shared.clone();
            std::thread::Builder::new()
                .name("cursor-poll".into())
                .spawn(move || run(shared))
                .expect("spawn cursor poll thread");
        }
        drop(state);
        Watch {
            dropped,
            shared: self.shared.clone(),
        }
    }
}

fn run(shared: Arc<Shared>) {
    tracing::debug!("光标轮询线程开始");
    let mut entries: Vec<Entry> = Vec::new();
    loop {
        {
            let mut state = shared.state.lock().unwrap();
            entries.append(&mut state.pending);
        }
        // 先清掉已丢弃的订阅（回调在这里 drop，不持锁）
        entries.retain(|entry| !entry.dropped.load(Ordering::Acquire));
        {
            let mut state = shared.state.lock().unwrap();
            if entries.is_empty() && state.pending.is_empty() {
                // 没有订阅：线程退出，下一个 watch 再起。在持锁时置标志，和 watch_probe 的判断不会错开。
                state.running = false;
                break;
            }
        }
        entries.retain_mut(|entry| {
            if !entry.probe.alive() {
                return false;
            }
            while let Some(sample) = entry.probe.sample() {
                let mut hit = Hit(entry.probe.as_mut());
                (entry.callback)(sample, &mut hit);
                if !entry.probe.has_more() {
                    break;
                }
            }
            true
        });
        // 用条件变量代替 sleep：有订阅被丢弃时可以提前醒，没有别的事时就是一个周期
        let state = shared.state.lock().unwrap();
        if state.pending.is_empty() {
            let _ = shared.wake.wait_timeout(state, POLL_INTERVAL);
        }
    }
    tracing::debug!("光标轮询线程结束");
}

static HUB: OnceLock<Hub> = OnceLock::new();

/// 开始观察 `native` 窗口：轮询线程每 16 ms 调一次 `on_sample`（采样失败的那轮跳过）；窗口不在了
/// （`alive` 为假）自动移除。不支持的平台返回 `None`。所有回调在同一条轮询线程上依次调用。
pub fn watch(
    native: NativeWindow,
    on_sample: impl FnMut(Sample, &mut dyn HitTest) + Send + 'static,
) -> Option<Watch> {
    let probe = platform::probe(native)?;
    Some(HUB.get_or_init(Hub::new).watch_probe(probe, on_sample))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::thread::ThreadId;
    use std::time::Instant;

    struct FakeProbe {
        alive: Arc<AtomicBool>,
    }

    impl Probe for FakeProbe {
        fn alive(&mut self) -> bool {
            self.alive.load(Ordering::Acquire)
        }
        fn sample(&mut self) -> Option<Sample> {
            Some(Sample {
                view: (1.5, 2.5),
                inside: true,
                left_down: false,
                present: true,
            })
        }
        fn over_desktop(&mut self) -> bool {
            true
        }
        fn over_window(&mut self) -> bool {
            false
        }
    }

    fn fake(alive: &Arc<AtomicBool>) -> Box<dyn Probe> {
        Box::new(FakeProbe {
            alive: alive.clone(),
        })
    }

    fn wait_until(what: &str, mut condition: impl FnMut() -> bool) {
        let start = Instant::now();
        while !condition() {
            assert!(start.elapsed() < Duration::from_secs(5), "超时: {what}");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    /// 回调里持有的东西：被 drop 时记下是哪条线程。
    struct DropMark(Arc<Mutex<Option<ThreadId>>>);
    impl Drop for DropMark {
        fn drop(&mut self) {
            *self.0.lock().unwrap() = Some(std::thread::current().id());
        }
    }

    #[test]
    fn watch_invokes_callback_with_samples_and_hit_test() {
        let hub = Hub::new();
        let alive = Arc::new(AtomicBool::new(true));
        let calls = Arc::new(AtomicUsize::new(0));
        let desktop = Arc::new(AtomicBool::new(false));
        let window = Arc::new(AtomicBool::new(true));
        let (c, d, w) = (calls.clone(), desktop.clone(), window.clone());
        let _watch = hub.watch_probe(fake(&alive), move |sample, hit| {
            assert_eq!(sample.view, (1.5, 2.5));
            d.store(hit.over_desktop(), Ordering::Release);
            w.store(hit.over_window(), Ordering::Release);
            c.fetch_add(1, Ordering::AcqRel);
        });
        wait_until("回调被调", || calls.load(Ordering::Acquire) >= 2);
        assert!(desktop.load(Ordering::Acquire));
        assert!(!window.load(Ordering::Acquire));
    }

    #[test]
    fn dropping_watch_stops_callbacks_and_drops_callback_on_poll_thread() {
        let hub = Hub::new();
        let alive = Arc::new(AtomicBool::new(true));
        let calls = Arc::new(AtomicUsize::new(0));
        let dropped_on = Arc::new(Mutex::new(None));
        let mark = DropMark(dropped_on.clone());
        let c = calls.clone();
        let watch = hub.watch_probe(fake(&alive), move |_, _| {
            let _ = &mark;
            c.fetch_add(1, Ordering::AcqRel);
        });
        wait_until("回调被调", || calls.load(Ordering::Acquire) >= 1);
        drop(watch);
        wait_until("回调被 drop", || dropped_on.lock().unwrap().is_some());
        let after = calls.load(Ordering::Acquire);
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(calls.load(Ordering::Acquire), after, "丢弃后不应再调");
        let thread = dropped_on.lock().unwrap().unwrap();
        assert_ne!(
            thread,
            std::thread::current().id(),
            "回调应在轮询线程上 drop"
        );
    }

    #[test]
    fn dead_window_is_removed_automatically() {
        let hub = Hub::new();
        let alive = Arc::new(AtomicBool::new(true));
        let dropped_on = Arc::new(Mutex::new(None));
        let mark = DropMark(dropped_on.clone());
        let _watch = hub.watch_probe(fake(&alive), move |_, _| {
            let _ = &mark;
        });
        alive.store(false, Ordering::Release);
        wait_until("窗口不在后回调被移除", || {
            dropped_on.lock().unwrap().is_some()
        });
        // 唯一的订阅没了，线程随之退出
        wait_until("线程退出", || !hub.is_running());
    }

    #[test]
    fn watches_are_removed_per_label_independently() {
        // 两个订阅，只丢一个：另一个继续被调
        let hub = Hub::new();
        let alive = Arc::new(AtomicBool::new(true));
        let a = Arc::new(AtomicUsize::new(0));
        let b = Arc::new(AtomicUsize::new(0));
        let (ca, cb) = (a.clone(), b.clone());
        let wa = hub.watch_probe(fake(&alive), move |_, _| {
            ca.fetch_add(1, Ordering::AcqRel);
        });
        let _wb = hub.watch_probe(fake(&alive), move |_, _| {
            cb.fetch_add(1, Ordering::AcqRel);
        });
        wait_until("两个都被调", || {
            a.load(Ordering::Acquire) > 0 && b.load(Ordering::Acquire) > 0
        });
        drop(wa);
        std::thread::sleep(Duration::from_millis(60));
        let a_after = a.load(Ordering::Acquire);
        let b_mark = b.load(Ordering::Acquire);
        wait_until("另一个继续被调", || {
            b.load(Ordering::Acquire) > b_mark + 1
        });
        assert_eq!(a.load(Ordering::Acquire), a_after);
    }

    #[test]
    fn thread_exits_when_idle_and_restarts_on_new_watch() {
        let hub = Hub::new();
        assert!(!hub.is_running());
        let alive = Arc::new(AtomicBool::new(true));
        let watch = hub.watch_probe(fake(&alive), |_, _| {});
        assert!(hub.is_running());
        drop(watch);
        wait_until("线程退出", || !hub.is_running());

        let calls = Arc::new(AtomicUsize::new(0));
        let c = calls.clone();
        let _watch = hub.watch_probe(fake(&alive), move |_, _| {
            c.fetch_add(1, Ordering::AcqRel);
        });
        wait_until("重启后回调被调", || {
            calls.load(Ordering::Acquire) >= 1
        });
    }

    /// 攒了几个样本的探针（外部来源）：一轮全部交出。
    struct BatchProbe {
        pending: Arc<Mutex<Vec<f64>>>,
    }

    impl Probe for BatchProbe {
        fn alive(&mut self) -> bool {
            true
        }
        fn sample(&mut self) -> Option<Sample> {
            let mut pending = self.pending.lock().unwrap();
            (!pending.is_empty()).then(|| Sample {
                view: (pending.remove(0), 0.0),
                inside: true,
                left_down: false,
                present: true,
            })
        }
        fn has_more(&mut self) -> bool {
            !self.pending.lock().unwrap().is_empty()
        }
        fn over_desktop(&mut self) -> bool {
            true
        }
        fn over_window(&mut self) -> bool {
            false
        }
    }

    #[test]
    fn queued_samples_are_all_delivered_in_order() {
        let hub = Hub::new();
        let pending = Arc::new(Mutex::new(vec![1.0, 2.0, 3.0]));
        let seen = Arc::new(Mutex::new(Vec::new()));
        let s = seen.clone();
        let _watch = hub.watch_probe(
            Box::new(BatchProbe {
                pending: pending.clone(),
            }),
            move |sample, _| s.lock().unwrap().push(sample.view.0),
        );
        wait_until("三个样本都交出", || seen.lock().unwrap().len() == 3);
        assert_eq!(*seen.lock().unwrap(), [1.0, 2.0, 3.0]);
    }

    #[test]
    fn polling_does_not_spin() {
        // 一个订阅存在时 16 ms 一轮：300 ms 内的回调次数有上界（忙等会远远超过）
        let hub = Hub::new();
        let alive = Arc::new(AtomicBool::new(true));
        let calls = Arc::new(AtomicUsize::new(0));
        let c = calls.clone();
        let _watch = hub.watch_probe(fake(&alive), move |_, _| {
            c.fetch_add(1, Ordering::AcqRel);
        });
        std::thread::sleep(Duration::from_millis(300));
        let n = calls.load(Ordering::Acquire);
        assert!(
            (1..=40).contains(&n),
            "300 ms 内回调 {n} 次，不符合 16 ms 周期"
        );
    }
}
