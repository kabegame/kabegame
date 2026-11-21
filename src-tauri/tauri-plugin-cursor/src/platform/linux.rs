//! Linux：读不到全局光标（Wayland 不给任何客户端），光标由外部来源推进来。应用把某个窗口登记成外部来源
//! （[`register_external_pointer`]），之后把收到的指针状态推给它（[`push_external_pointer`]）。Kabegame 的来源是
//! Plasma 壁纸插件转发的鼠标（插件模式的离屏壁纸窗口），插件只在光标落在桌面上时才有事件。
//!
//! - 没登记的窗口 [`native_window`] 为 `None`：`attach_frame` 返回 `false`（图库预览的 iframe 照旧直接收真实鼠标）。
//! - 每个订阅（每个登记的 frame）一条自己的样本队列：推送时连续的同状态样本合并成最后一个，按下 / 抬起 / 离开
//!   另起一项，轮询线程一轮全部交出（两轮之间的一次点击也不丢）；队列封顶，超出丢最旧的。
//! - 新订阅先拿到最近一次推送（登记时光标已在桌面上，立刻有位置）。
//! - 光标下恒为桌面（`over_desktop` 为真、`over_window` 为假）：事件只在光标落在桌面上时才来。
//! - 注销后订阅随下一轮 `alive` 为假被移除，frame 收到收尾。

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicIsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, Weak};

use super::NativeWindow;
use crate::hub::{Probe, Sample};

/// 一个订阅的队列最多攒多少项（正常一轮只有几项；轮询线程卡住时丢最旧的）。
const QUEUE_LIMIT: usize = 64;

#[derive(Default)]
struct Queue {
    items: VecDeque<Sample>,
    /// 最后入队那一项的（左键, 位置可知）。
    tail_state: Option<(bool, bool)>,
    /// 最后入队那一项可以被同状态的新样本覆盖（它不是状态变化的那一项）。
    tail_mergeable: bool,
}

impl Queue {
    fn push(&mut self, sample: Sample) {
        let state = (sample.left_down, sample.present);
        let same = self.tail_state == Some(state);
        if same && self.tail_mergeable {
            if let Some(back) = self.items.back_mut() {
                *back = sample;
                return;
            }
        }
        if self.items.len() >= QUEUE_LIMIT {
            self.items.pop_front();
        }
        self.items.push_back(sample);
        // 状态变化的那一项（按下、抬起、离开、回来）保留原位置，之后同状态的移动另起一项再合并
        self.tail_mergeable = same;
        self.tail_state = Some(state);
    }
}

struct Source {
    id: NativeWindow,
    last: Option<Sample>,
    queues: Vec<Weak<Mutex<Queue>>>,
}

static SOURCES: OnceLock<Mutex<HashMap<String, Source>>> = OnceLock::new();
static NEXT_ID: AtomicIsize = AtomicIsize::new(1);

fn sources() -> MutexGuard<'static, HashMap<String, Source>> {
    SOURCES
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 把 `label` 窗口登记成外部来源：之后它的 frame 可以登记注入，光标由 [`push_external_pointer`] 推进来。已登记时不变。
pub fn register_external_pointer(label: &str) {
    sources().entry(label.to_string()).or_insert_with(|| Source {
        id: NEXT_ID.fetch_add(1, Ordering::Relaxed),
        last: None,
        queues: Vec::new(),
    });
}

/// 注销外部来源：它的订阅下一轮被移除（frame 收到收尾），之后的推送忽略。
pub fn unregister_external_pointer(label: &str) {
    sources().remove(label);
}

/// 推一个指针样本给 `label` 窗口（视图坐标，同 [`Sample`]）。没登记的窗口忽略。可在任意线程调用。
pub fn push_external_pointer(label: &str, sample: Sample) {
    let mut map = sources();
    let Some(source) = map.get_mut(label) else {
        return;
    };
    source.last = Some(sample);
    source.queues.retain(|weak| match weak.upgrade() {
        Some(queue) => {
            queue
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(sample);
            true
        }
        None => false,
    });
}

/// 外部来源窗口的标识；没登记成外部来源的窗口 `None`。
pub fn native_window<R: tauri::Runtime>(window: &tauri::Window<R>) -> Option<NativeWindow> {
    sources().get(window.label()).map(|source| source.id)
}

/// 外部来源最近一次推来的位置（视图坐标）；没有、或光标已离开时 `None`。
pub fn position_in_window(native: NativeWindow) -> Option<(f64, f64)> {
    sources()
        .values()
        .find(|source| source.id == native)
        .and_then(|source| source.last)
        .filter(|sample| sample.present)
        .map(|sample| sample.view)
}

pub(crate) struct ExternalProbe {
    label: String,
    id: NativeWindow,
    queue: Arc<Mutex<Queue>>,
}

impl ExternalProbe {
    /// 给标识为 `native` 的外部来源新建一个订阅；来源不在时 `None`。
    pub(crate) fn new(native: NativeWindow) -> Option<Self> {
        let mut map = sources();
        let (label, source) = map.iter_mut().find(|(_, source)| source.id == native)?;
        let queue = Arc::new(Mutex::new(Queue::default()));
        if let Some(last) = source.last {
            queue.lock().unwrap().push(last);
        }
        source.queues.push(Arc::downgrade(&queue));
        Some(Self {
            label: label.clone(),
            id: native,
            queue,
        })
    }

    fn queue(&self) -> MutexGuard<'_, Queue> {
        self.queue
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl Probe for ExternalProbe {
    fn alive(&mut self) -> bool {
        sources()
            .get(&self.label)
            .is_some_and(|source| source.id == self.id)
    }

    fn sample(&mut self) -> Option<Sample> {
        self.queue().items.pop_front()
    }

    fn has_more(&mut self) -> bool {
        !self.queue().items.is_empty()
    }

    fn over_desktop(&mut self) -> bool {
        true
    }

    fn over_window(&mut self) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(x: f64, left_down: bool) -> Sample {
        Sample {
            view: (x, 0.0),
            inside: true,
            left_down,
            present: true,
        }
    }

    fn gone() -> Sample {
        Sample {
            present: false,
            ..at(0.0, false)
        }
    }

    fn drain(probe: &mut ExternalProbe) -> Vec<Sample> {
        let mut out = Vec::new();
        while let Some(sample) = probe.sample() {
            out.push(sample);
        }
        out
    }

    fn probe_for(label: &str) -> ExternalProbe {
        let id = sources().get(label).unwrap().id;
        ExternalProbe::new(id).unwrap()
    }

    #[test]
    fn moves_merge_but_button_edges_and_leave_are_kept() {
        let label = "test-merge";
        register_external_pointer(label);
        let mut probe = probe_for(label);
        for sample in [
            at(1.0, false),
            at(2.0, false),
            at(3.0, true), // 按下：保留按下时的位置
            at(4.0, true),
            at(5.0, true),
            at(6.0, false), // 抬起
            gone(),
            gone(),
            at(7.0, false), // 回来
            at(8.0, false),
        ] {
            push_external_pointer(label, sample);
        }
        let xs: Vec<(f64, bool, bool)> = drain(&mut probe)
            .into_iter()
            .map(|s| (s.view.0, s.left_down, s.present))
            .collect();
        // 状态变化的那一项原样保留，之后的同状态样本另起一项、再往它上面合并
        assert_eq!(
            xs,
            [
                (1.0, false, true),
                (2.0, false, true),
                (3.0, true, true),
                (5.0, true, true),
                (6.0, false, true),
                (0.0, false, false),
                (0.0, false, false),
                (7.0, false, true),
                (8.0, false, true),
            ]
        );
        assert!(!probe.has_more());
        unregister_external_pointer(label);
    }

    #[test]
    fn each_subscription_has_its_own_queue_and_new_ones_start_from_the_last_sample() {
        let label = "test-fanout";
        register_external_pointer(label);
        let mut first = probe_for(label);
        push_external_pointer(label, at(1.0, false));
        let mut second = probe_for(label);
        push_external_pointer(label, at(2.0, true));
        assert_eq!(drain(&mut first).len(), 2);
        // 第二个订阅先拿到登记时的最近位置，再是之后的按下
        let seen: Vec<f64> = drain(&mut second).iter().map(|s| s.view.0).collect();
        assert_eq!(seen, [1.0, 2.0]);
        unregister_external_pointer(label);
    }

    #[test]
    fn unregistered_windows_have_no_handle_and_probes_die() {
        let label = "test-dead";
        register_external_pointer(label);
        let id = sources().get(label).unwrap().id;
        let mut probe = ExternalProbe::new(id).unwrap();
        assert!(probe.alive());
        push_external_pointer(label, at(3.0, false));
        assert_eq!(position_in_window(id), Some((3.0, 0.0)));
        push_external_pointer(label, gone());
        assert_eq!(position_in_window(id), None, "离开后不给位置");
        unregister_external_pointer(label);
        assert!(!probe.alive());
        assert!(ExternalProbe::new(id).is_none());
        // 注销后推送忽略，重新登记换新标识
        push_external_pointer(label, at(4.0, false));
        register_external_pointer(label);
        assert_ne!(sources().get(label).unwrap().id, id);
        unregister_external_pointer(label);
    }

    #[test]
    fn queue_is_capped() {
        let mut queue = Queue::default();
        for i in 0..(QUEUE_LIMIT * 2) {
            // 交替按下抬起：每一项都是状态变化，不合并
            queue.push(at(i as f64, i % 2 == 0));
        }
        assert_eq!(queue.items.len(), QUEUE_LIMIT);
        assert_eq!(
            queue.items.back().unwrap().view.0,
            (QUEUE_LIMIT * 2 - 1) as f64
        );
    }
}
