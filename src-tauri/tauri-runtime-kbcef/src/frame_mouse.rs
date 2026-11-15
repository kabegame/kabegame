//! 子 frame 鼠标注入的纯规则：钳制与「按下 / 抬起是否配对」。CEF 调用在 `webview.rs` 的 `frame_mouse`，
//! 这里不碰 CEF，便于单测。
//!
//! 坐标都是 frame 自己的坐标（DIP，相对 frame 视口左上角），由 CEF 补丁 11 的 `ConvertPointFromView` 从浏览器
//! 视图坐标换算而来（已含父页面的 CSS 变换、缩放与滚动）。

/// 钳进 frame 时离右、下边界留的距离（DIP）：落在边上（`x == w`）的点不在 frame 里，Blink 按 1/64 像素取整后
/// 也可能算到框外，所以向内收半个像素。左、上边界（0）本身就在框内，不收。
const EDGE_INSET: f64 = 0.5;

/// 换算连续失败多少次才 warn。frame 刚登记时还没合成，第一次采样常常换算不出，之后就好；插件只在光标动了时
/// 发移动（16 ms 一次），连续这么多次都不行才说明是一直不行（同进程 frame、`display: none`）。
pub(crate) const MAPPING_WARN_AFTER: u32 = 30;

/// 把 frame 坐标里的点钳进 `[0, w) × [0, h)`：点在框里原样返回（第二项为真）；在框外时取 frame 中心到该点的
/// 连线与边界的交点（第二项为假）。尺寸不是正数、或坐标不是有限数时返回 `None`（不注入）。
pub fn clamp_to_frame(point: (f64, f64), size: (f64, f64)) -> Option<((f64, f64), bool)> {
    let (w, h) = size;
    let (x, y) = point;
    if !(w.is_finite() && h.is_finite() && w > 0.0 && h > 0.0 && x.is_finite() && y.is_finite()) {
        return None;
    }
    if x >= 0.0 && y >= 0.0 && x < w && y < h {
        return Some(((x, y), true));
    }
    let (cx, cy) = (w / 2.0, h / 2.0);
    let (dx, dy) = (x - cx, y - cy);
    // 从中心沿 (dx, dy) 走，先碰到哪条边就停在哪：两轴各自走到边界所需的比例取小者。点在框外，所以至少一轴
    // 的比例不超过 1。
    let along = |half: f64, d: f64| {
        if d == 0.0 {
            f64::INFINITY
        } else {
            half / d.abs()
        }
    };
    let t = along(cx, dx).min(along(cy, dy)).min(1.0);
    let px = (cx + dx * t).clamp(0.0, (w - EDGE_INSET).max(0.0));
    let py = (cy + dy * t).clamp(0.0, (h - EDGE_INSET).max(0.0));
    Some(((px, py), false))
}

/// 要注入到 frame 的一个事件（frame 坐标）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum FrameAction {
    Move { x: f64, y: f64 },
    Leave { x: f64, y: f64 },
    LeftDown { x: f64, y: f64 },
    LeftUp { x: f64, y: f64 },
}

/// 需要换算坐标的三种输入（`Release` 不换算，见 [`FrameMouseState::release`]）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PointerKind {
    Move,
    Down,
    Up,
}

/// 一个 frame 的注入状态（按 `(webview label, frame 标识)` 各一份）。
#[derive(Debug, Default)]
pub(crate) struct FrameMouseState {
    /// 按下已注入、还没抬起。
    pressed: bool,
    /// 上一次注入的位置（frame 坐标），收尾补抬起 / 离开用。
    last: Option<(f64, f64)>,
    /// 连续换算失败的次数（换算成功一次就清零）。
    failures: u32,
    /// 这个 frame 换算失败的 warn 已记过（每个 frame 只记一次）。
    warned: bool,
}

impl FrameMouseState {
    /// 一次移动 / 按下 / 抬起。`point` 是换算到 frame 的点（钳制前），`size` 是 frame 视口尺寸。
    /// - 移动：钳进 frame 后注入。
    /// - 按下：点（钳制前）在 frame 里才注入；不在就作废，之后的抬起也不发。
    /// - 抬起：只在按下被注入过时注入（钳进 frame）。
    pub(crate) fn input(
        &mut self,
        kind: PointerKind,
        point: (f64, f64),
        size: (f64, f64),
    ) -> Option<FrameAction> {
        self.failures = 0;
        let ((x, y), inside) = clamp_to_frame(point, size)?;
        let action = match kind {
            PointerKind::Move => FrameAction::Move { x, y },
            PointerKind::Down => {
                if !inside {
                    return None;
                }
                self.pressed = true;
                FrameAction::LeftDown { x, y }
            }
            PointerKind::Up => {
                if !self.pressed {
                    return None;
                }
                self.pressed = false;
                FrameAction::LeftUp { x, y }
            }
        };
        self.last = Some((x, y));
        Some(action)
    }

    /// 记一次换算失败；返回这次是否该 warn：连续失败到 [`MAPPING_WARN_AFTER`] 次时为真，每个 frame 只有一次。
    pub(crate) fn mapping_failed(&mut self) -> bool {
        self.failures = self.failures.saturating_add(1);
        if self.failures >= MAPPING_WARN_AFTER && !self.warned {
            self.warned = true;
            return true;
        }
        false
    }

    /// 停止注入：按下未抬起就补抬起，再发一次离开（都在上一次的位置），页面不会停在悬停 / 按住状态。
    /// 从没注入过就什么都不发。
    pub(crate) fn release(&mut self) -> Vec<FrameAction> {
        let mut actions = Vec::new();
        if let Some((x, y)) = self.last.take() {
            if std::mem::take(&mut self.pressed) {
                actions.push(FrameAction::LeftUp { x, y });
            }
            actions.push(FrameAction::Leave { x, y });
        }
        actions
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SIZE: (f64, f64) = (200.0, 100.0);

    fn close(a: (f64, f64), b: (f64, f64)) -> bool {
        (a.0 - b.0).abs() < 1e-9 && (a.1 - b.1).abs() < 1e-9
    }

    #[test]
    fn inside_points_pass_through() {
        assert_eq!(clamp_to_frame((0.0, 0.0), SIZE), Some(((0.0, 0.0), true)));
        assert_eq!(
            clamp_to_frame((199.9, 99.9), SIZE),
            Some(((199.9, 99.9), true))
        );
        assert_eq!(
            clamp_to_frame((50.5, 20.25), SIZE),
            Some(((50.5, 20.25), true))
        );
    }

    #[test]
    fn outside_points_land_on_the_line_from_the_center() {
        // 正右方：落在右边界（向内收半个像素），y 不变
        let (p, inside) = clamp_to_frame((500.0, 50.0), SIZE).unwrap();
        assert!(!inside);
        assert!(close(p, (199.5, 50.0)));
        // 正上方
        let (p, _) = clamp_to_frame((100.0, -300.0), SIZE).unwrap();
        assert!(close(p, (100.0, 0.0)));
        // 斜向：中心 (100, 50) 到 (400, 110)，方向 (300, 60)，先碰右边界：t = 100/300，交点 (200, 70)
        // （逐轴钳制会得到 (199.5, 99.5)）
        let (p, _) = clamp_to_frame((400.0, 110.0), SIZE).unwrap();
        assert!(close(p, (199.5, 70.0)), "{p:?}");
        // 斜向先碰下边界：方向 (60, 150)，t = 50/150，交点 (120, 100) → 收到 99.5
        let (p, _) = clamp_to_frame((160.0, 200.0), SIZE).unwrap();
        assert!(close(p, (120.0, 99.5)), "{p:?}");
        // 左上角外：方向 (-200, -100)，两轴同时到边，交点 (0, 0)
        let (p, _) = clamp_to_frame((-100.0, -50.0), SIZE).unwrap();
        assert!(close(p, (0.0, 0.0)), "{p:?}");
        // 恰好在右边界上（x == w）算框外
        let (p, inside) = clamp_to_frame((200.0, 50.0), SIZE).unwrap();
        assert!(!inside);
        assert!(close(p, (199.5, 50.0)));
    }

    #[test]
    fn degenerate_inputs_are_rejected() {
        assert_eq!(clamp_to_frame((1.0, 1.0), (0.0, 100.0)), None);
        assert_eq!(clamp_to_frame((1.0, 1.0), (100.0, -1.0)), None);
        assert_eq!(clamp_to_frame((f64::NAN, 1.0), SIZE), None);
        assert_eq!(clamp_to_frame((1.0, f64::INFINITY), SIZE), None);
        assert_eq!(clamp_to_frame((1.0, 1.0), (f64::NAN, 1.0)), None);
        // 不到一个像素宽的 frame：收边后仍在 [0, w) 里
        let (p, _) = clamp_to_frame((10.0, 0.2), (0.4, 0.4)).unwrap();
        assert!(p.0 >= 0.0 && p.0 < 0.4 && p.1 >= 0.0 && p.1 < 0.4, "{p:?}");
    }

    #[test]
    fn press_outside_the_frame_is_dropped_with_its_release() {
        let mut state = FrameMouseState::default();
        assert_eq!(state.input(PointerKind::Down, (-5.0, 10.0), SIZE), None);
        assert_eq!(state.input(PointerKind::Up, (10.0, 10.0), SIZE), None);
        // 从没注入过：收尾什么都不发
        assert_eq!(state.release(), []);
    }

    #[test]
    fn press_inside_pairs_with_release_even_outside() {
        let mut state = FrameMouseState::default();
        assert_eq!(
            state.input(PointerKind::Move, (10.0, 10.0), SIZE),
            Some(FrameAction::Move { x: 10.0, y: 10.0 })
        );
        assert_eq!(
            state.input(PointerKind::Down, (10.0, 10.0), SIZE),
            Some(FrameAction::LeftDown { x: 10.0, y: 10.0 })
        );
        // 拖到框外抬起：抬起照发，钳在边上
        assert_eq!(
            state.input(PointerKind::Up, (500.0, 50.0), SIZE),
            Some(FrameAction::LeftUp { x: 199.5, y: 50.0 })
        );
        // 已抬起：再抬起不发
        assert_eq!(state.input(PointerKind::Up, (10.0, 10.0), SIZE), None);
    }

    #[test]
    fn release_sends_pending_up_then_leave_once() {
        let mut state = FrameMouseState::default();
        state.input(PointerKind::Down, (30.0, 40.0), SIZE);
        state.input(PointerKind::Move, (-50.0, 50.0), SIZE);
        assert_eq!(
            state.release(),
            [
                FrameAction::LeftUp { x: 0.0, y: 50.0 },
                FrameAction::Leave { x: 0.0, y: 50.0 }
            ]
        );
        assert_eq!(state.release(), []);
        // 收尾后重新开始：没按下就不补抬起
        state.input(PointerKind::Move, (1.0, 2.0), SIZE);
        assert_eq!(state.release(), [FrameAction::Leave { x: 1.0, y: 2.0 }]);
    }

    #[test]
    fn mapping_failure_warns_only_when_it_persists() {
        let mut state = FrameMouseState::default();
        // 刚登记时失败几次、随后换算成功：不 warn，计数清零
        for _ in 0..MAPPING_WARN_AFTER - 1 {
            assert!(!state.mapping_failed());
        }
        state.input(PointerKind::Move, (1.0, 1.0), SIZE);
        for _ in 0..MAPPING_WARN_AFTER - 1 {
            assert!(!state.mapping_failed());
        }
        // 连续失败到门限那一次 warn，之后不再 warn（成功后再失败也不）
        assert!(state.mapping_failed());
        assert!(!state.mapping_failed());
        state.input(PointerKind::Move, (1.0, 1.0), SIZE);
        for _ in 0..MAPPING_WARN_AFTER * 2 {
            assert!(!state.mapping_failed());
        }
    }

    #[test]
    fn invalid_geometry_injects_nothing() {
        let mut state = FrameMouseState::default();
        assert_eq!(state.input(PointerKind::Move, (1.0, 1.0), (0.0, 0.0)), None);
        assert_eq!(state.input(PointerKind::Down, (1.0, 1.0), (0.0, 0.0)), None);
        assert_eq!(state.release(), []);
    }
}
