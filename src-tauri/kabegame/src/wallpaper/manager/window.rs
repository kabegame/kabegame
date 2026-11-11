use super::{
    style_options, transition_options, DisplayMode, Layout, Placement, WallpaperController,
    WallpaperManager, WallpaperOption, WindowAssignment,
};
use crate::wallpaper::screens::ScreenInfo;
use crate::wallpaper::window::WallpaperWindow;
use crate::wallpaper::{web_entry, WALLPAPER_LABELS};
use async_trait::async_trait;
use kabegame_i18n::t;
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Mutex, MutexGuard};
use tauri::{
    AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

/// 布置变化时发给对应壁纸窗口的事件（`emit_to(label, …)`），载荷是 [`WindowAssignment`]。
pub const ASSIGNMENT_EVENT: &str = "wallpaper-assignment";

/// 一块屏该有的窗口：铺在哪块屏、显示哪个目标、出不出声。
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct WindowPlan {
    /// 窗口铺满的屏。`None` 只出现在没有屏幕信息的平台（尚未实现显示器枚举）：这时只有一个窗口，
    /// 铺满它所在的屏（主屏）。
    pub screen: Option<ScreenInfo>,
    pub assignment: WindowAssignment,
}

impl WindowPlan {
    fn screen_id(&self) -> Option<&str> {
        self.screen.as_ref().map(|screen| screen.id.as_str())
    }
}

/// 按布局算出窗口表（纯函数）：每块在线屏一个窗口。
///
/// - `multiple`：各窗口显示同一个目标，只有主屏窗口出声（没有主屏标记时取第一块）；
/// - `single`：各窗口显示自己那块屏的目标，都出声；
/// - `span`：窗口模式不支持，不出窗口；
/// - 没有屏幕信息：一个不绑定屏的窗口。
///
/// 结果按「主屏第一，其余 (y, x)」排，与在线屏列表的顺序一致，和布局里默认目标排第一无关：
/// 全新建窗时主屏因此拿到池里的第一个 label。
pub(crate) fn plan_windows(layout: &Layout) -> Vec<WindowPlan> {
    let mut plans = Vec::new();
    for (target_id, placement) in &layout.targets {
        let assignment = |audible: bool| WindowAssignment {
            target_id: target_id.clone(),
            audible,
        };
        match placement {
            Placement::All { screens } if screens.is_empty() => plans.push(WindowPlan {
                screen: None,
                assignment: assignment(true),
            }),
            Placement::All { screens } => {
                let audible_index = screens
                    .iter()
                    .position(|screen| screen.primary)
                    .unwrap_or(0);
                plans.extend(
                    screens
                        .iter()
                        .enumerate()
                        .map(|(index, screen)| WindowPlan {
                            screen: Some(screen.clone()),
                            assignment: assignment(index == audible_index),
                        }),
                );
            }
            Placement::One { screen } => plans.push(WindowPlan {
                screen: Some(screen.clone()),
                assignment: assignment(true),
            }),
            Placement::Span => {}
        }
    }
    plans.sort_by_key(|plan| {
        plan.screen
            .as_ref()
            .map(|screen| (!screen.primary, screen.y, screen.x))
    });
    plans
}

/// 现有窗口与窗口表比对的结论。
#[derive(Debug, Default, PartialEq)]
struct WindowDiff {
    /// 屏已不在窗口表里的窗口（label）：销毁
    remove: Vec<String>,
    /// 留下的窗口：(label, 它对应的窗口表下标)
    keep: Vec<(String, usize)>,
    /// 还没有窗口的窗口表下标：新建
    create: Vec<usize>,
}

/// 现有窗口（label 与它铺的屏的 id）按**屏的 id** 与窗口表比对（纯函数）：同一块屏保留原窗口与 label，
/// 屏不在表里的销毁，表里多出来的屏新建。屏的位置、尺寸、布置的变化不影响这里的归类。
fn diff_windows(current: &[(String, Option<String>)], plans: &[WindowPlan]) -> WindowDiff {
    let mut diff = WindowDiff::default();
    let mut claimed = vec![false; plans.len()];
    for (label, screen_id) in current {
        let found = plans
            .iter()
            .enumerate()
            .position(|(index, plan)| !claimed[index] && plan.screen_id() == screen_id.as_deref());
        match found {
            Some(index) => {
                claimed[index] = true;
                diff.keep.push((label.clone(), index));
            }
            None => diff.remove.push(label.clone()),
        }
    }
    diff.create = (0..plans.len()).filter(|index| !claimed[*index]).collect();
    diff
}

/// 这个布置的输出是否落在铺 `screen` 的窗口上。
fn placement_covers(placement: &Placement, screen: Option<&ScreenInfo>) -> bool {
    match placement {
        Placement::All { .. } => true,
        Placement::One { screen: target } => screen.is_some_and(|screen| screen.id == target.id),
        Placement::Span => false,
    }
}

/// 窗口表里的一项。
struct Slot<R: Runtime> {
    /// 已挂载的窗口；建窗后、页面就绪并挂载完成之前为 `None`（这期间页面已经可以来取布置）。
    window: Option<WallpaperWindow<R>>,
    screen: Option<ScreenInfo>,
    assignment: WindowAssignment,
}

/// 窗口模式壁纸管理器：**每块在线屏一个壁纸窗口**，窗口矩形就是那块屏，各自完整渲染一幅画面。
/// label 取自固定的池 [`WALLPAPER_LABELS`]。窗口是**懒建**的：只在 `wallpaperMode == "window"` 且壁纸开着期间存在。
///
/// 窗口集合的**生命周期**：`init()` 进入窗口模式并把窗口集合对齐到当前布局，`reconcile()` 在显示器模式或在线屏
/// 变化后重新对齐（同一块屏保留原窗口、屏矩形变了重铺、布置变了推一条新的、多的销毁、缺的新建），`cleanup()`
/// 销毁全部窗口。窗口一旦建立即常显，中途不 hide/show。
///
/// 窗口的**内容**：图片 / 视频 / 网页壁纸都由壁纸页面（`WallpaperWindow.vue` → `WallpaperStage`）自驱动渲染。
/// 后端只给每个窗口一条布置 [`WindowAssignment`]（显示哪个目标、出不出声），样式、过渡与当前壁纸由页面从
/// `setting-change` 里的 `wallpaperTargets[targetId]` 自己读；网页壁纸（`x-wpe/web`）是 web 层里的 `file:` iframe，
/// 窗口不导航。`set_wallpaper` 只按壁纸类型给显示该目标的窗口开关桌面鼠标转发
/// （[`WallpaperWindow::set_mouse_forwarding`]）。
///
/// 两把锁：`active` 让 init / reconcile / cleanup 串行（对齐期间要等页面就绪，可能持有数秒）；`slots` 只在读写
/// 窗口表的瞬间持有，持有期间不调用会同步等主线程的窗口接口——页面初始化时的命令、轮播线程都要读它。
pub struct WindowWallpaperManager<R: Runtime> {
    app: AppHandle<R>,
    /// 值：是否处于窗口模式（`init` 之后、`cleanup` 之前）。锁本身让对齐串行。
    active: Mutex<bool>,
    /// label → 窗口
    slots: Mutex<BTreeMap<String, Slot<R>>>,
}

impl<R: Runtime> WindowWallpaperManager<R> {
    pub fn new(app: AppHandle<R>) -> Self {
        Self {
            app,
            active: Mutex::new(false),
            slots: Mutex::new(BTreeMap::new()),
        }
    }

    fn lock_active(&self) -> MutexGuard<'_, bool> {
        self.active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn lock_slots(&self) -> MutexGuard<'_, BTreeMap<String, Slot<R>>> {
        self.slots
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// 窗口后端此刻该对齐到的布局：按「窗口模式下生效的显示器模式」现算（切入窗口模式时 `wallpaperMode`
    /// 还没落盘，不能读当前模式），缺的目标顺带补种。
    fn current_layout() -> Layout {
        let controller = WallpaperController::global();
        controller.layout_for(controller.display_mode_for("window"), None)
    }

    /// 绊线：本 manager 的内容类方法**不会**兜底建窗（窗口不存在时 `set_wallpaper`
    /// 什么都不做）。
    ///
    /// 窗口只由 `init()` / `reconcile()` 创建，而 `init()` 只在两个地方被调用：启动
    /// （`startup.rs` → `WallpaperController::init()`）和模式/开关切换
    /// （`commands/wallpaper.rs` 的 `apply_backend_lifecycle` / `set_wallpaper_enabled`）。
    /// 任何新增的"让壁纸生效"路径若漏调 `init()`，症状是**静默无窗口**——
    /// 类型系统抓不到（去掉兜底建窗后已连续踩到三次：模式切换的无壁纸早返回、
    /// 切换中止路径、关闭壁纸后重新开启）。这行日志把它变成可见的。
    fn warn_if_window_missing(&self, who: &str) {
        if self.lock_slots().is_empty() {
            tracing::warn!(
                "{}: 处于 window 模式但没有任何壁纸窗口 —— 某条路径漏调了 \
                 WindowWallpaperManager::init()，壁纸不会显示",
                who
            );
        }
    }

    /// 建立一个壁纸窗口本体（不挂载），铺在 `screen` 上；`None` 时全屏到它所在的屏。
    fn create_window(
        &self,
        label: &str,
        screen: Option<&ScreenInfo>,
    ) -> Result<WebviewWindow<R>, String> {
        // 网页壁纸是 web 层里的 file: iframe，页面要读同目录文件：建窗前登记 label，CEF 只给这个 browser
        // 打开文件访问偏好（补丁 04），file: 文档的请求由运行时按网页壁纸目录索引约束。
        tauri_runtime_kbcef::allow_file_documents(label);
        // 壁纸窗口的 Vue 页用 <img> / <video> 显示图库媒体（file://），也要给 iframe 赋 file: src：登记
        // CEF 补丁 05 + 0006，应用页主 frame 的 file: 子资源免检，iframe 导航须落进库里某个网页壁纸目录。
        tauri_runtime_kbcef::allow_app_local_resources(label);
        // 补丁 10：壁纸 iframe 上的 Ctrl+滚轮不缩放；缩放按 host 存，这里和主窗口是同一个 host
        tauri_runtime_kbcef::disable_wheel_zoom(label);

        // 与主窗口同一个 index.html，前端 main.ts 按 ?window= 分发到壁纸 bootstrap。
        // `slot` 是 label 在池里的序号，页面不读它：各壁纸窗口的地址因此互不相同，调试工具能按 URL 认出是哪一个。
        let slot = WALLPAPER_LABELS
            .iter()
            .position(|pooled| *pooled == label)
            .unwrap_or(0);
        let builder = WebviewWindowBuilder::new(
            &self.app,
            label,
            WebviewUrl::App(format!("index.html?window=wallpaper&slot={slot}").into()),
        )
        // 固定标题，便于脚本/调试定位到正确窗口。
        .title(t!("window.wallpaperTitle"))
        // WPE 网页壁纸垫片：只在顶层的直接子 file: iframe 里启用，应用页里第一行就返回。
        .initialization_script_for_all_frames(crate::commands::wpe_web::WPE_SHIM_JS)
        .decorations(false)
        .skip_taskbar(true);

        let builder = match screen {
            // 建窗时就放到目标屏的矩形上（挂载时再精确铺一次），避免挂载前落在主屏。
            // 坐标是屏幕枚举给的平台桌面坐标；目前只有 macOS 有枚举，单位是点，与这里的逻辑坐标一致。
            Some(screen) => builder
                .position(f64::from(screen.x), f64::from(screen.y))
                .inner_size(f64::from(screen.width), f64::from(screen.height)),
            None => builder.fullscreen(true),
        };

        #[cfg(target_os = "windows")]
        let builder = builder.transparent(true);

        // 建成时不可见：挂载会把它改成背景 WorkerW 的子窗口并搬到桌面层，
        // 期间若可见会先在屏幕上闪一下窗口。`mount()` 内部挂完即 show，
        // 之后在窗口的整个生命周期里保持常显、不再 hide。
        builder
            .visible(false)
            .build()
            .map_err(|e| format!("创建壁纸窗口 {label} 失败: {:?}", e))
    }

    /// 销毁 `label` 的窗口本体（不存在则只撤销 ready 标记）。调用前先把它的 [`Slot`] 从表里摘掉并丢弃
    /// （看门狗、鼠标转发随之停止）。
    fn destroy_window(&self, label: &str) -> Result<(), String> {
        let result = match self.app.get_webview_window(label) {
            Some(window) => {
                // 窗口挂载时被改成了 WorkerW 的子窗口（WS_CHILD + 改过的扩展样式），先解绑再销毁。
                #[cfg(target_os = "windows")]
                if let Err(error) = tauri_plugin_wemt::detach_window(&window) {
                    tracing::warn!("解绑桌面窗口失败，仍将销毁窗口: {error}");
                }
                // `destroy()` 而非 `close()`：这是程序化拆除，不是「请求关闭」。
                // `close()` 会走 CloseRequested 事件，可被 `api.prevent_close()` 拦下
                // （`lib.rs` 已对 `crawler-*` 这么做）——一旦哪天拦截条件放宽到本窗口，
                // 窗口就关不掉，而「窗口存在 ⟺ mode==window ∧ !disabled」会**静默**失效。
                // 仓库内其他程序化销毁（surf / startup）也都用 `destroy()`。
                window
                    .destroy()
                    .map_err(|e| format!("销毁壁纸窗口 {label} 失败: {:?}", e))
            }
            None => Ok(()),
        };
        // ready 标记按 label 记在进程级静态里、label 会复用，必须随窗口一起撤销，否则下次用这个 label
        // 重建时 wait_ready 会立刻返回，挂载会打在一个前端尚未加载的新窗口上。
        WallpaperWindow::<R>::reset_ready(label);
        result
    }

    /// 建窗或挂载失败：把登记的 slot 摘掉、窗口销毁，不留半成品。
    fn discard(&self, label: &str) {
        let slot = self.lock_slots().remove(label);
        drop(slot);
        if let Err(e) = self.destroy_window(label) {
            tracing::warn!("{e}");
        }
    }

    /// 把窗口集合对齐到 `layout`。调用方持有 `active` 锁。部分窗口失败时其余窗口照常对齐，返回第一个错误。
    fn align(&self, layout: &Layout) -> Result<(), String> {
        let mut plans = plan_windows(layout);
        if plans.len() > WALLPAPER_LABELS.len() {
            tracing::warn!(
                "在线显示器 {} 块，超过壁纸窗口上限 {}：只给前 {} 块开窗口",
                plans.len(),
                WALLPAPER_LABELS.len(),
                WALLPAPER_LABELS.len()
            );
            plans.truncate(WALLPAPER_LABELS.len());
        }

        // 第一步（持表锁）：摘掉屏已不在的窗口，更新留下的窗口的屏与布置。
        let mut removed = Vec::new();
        let mut moved: Vec<(String, ScreenInfo)> = Vec::new();
        let mut reassigned: Vec<(String, WindowAssignment)> = Vec::new();
        let create: Vec<WindowPlan> = {
            let mut slots = self.lock_slots();
            let current: Vec<(String, Option<String>)> = slots
                .iter()
                .map(|(label, slot)| {
                    (
                        label.clone(),
                        slot.screen.as_ref().map(|screen| screen.id.clone()),
                    )
                })
                .collect();
            let diff = diff_windows(&current, &plans);
            for label in diff.remove {
                if let Some(slot) = slots.remove(&label) {
                    removed.push((label, slot));
                }
            }
            for (label, index) in diff.keep {
                let plan = &plans[index];
                let Some(slot) = slots.get_mut(&label) else {
                    continue;
                };
                if slot.screen != plan.screen {
                    slot.screen = plan.screen.clone();
                    if let Some(screen) = &plan.screen {
                        moved.push((label.clone(), screen.clone()));
                    }
                }
                if slot.assignment != plan.assignment {
                    slot.assignment = plan.assignment.clone();
                    reassigned.push((label, plan.assignment.clone()));
                }
            }
            diff.create
                .into_iter()
                .map(|index| plans[index].clone())
                .collect()
        };

        // 第二步（不持表锁，下面的窗口接口会同步等主线程）：销毁、重铺、推新布置。
        let mut first_error: Option<String> = None;
        for (label, slot) in removed {
            tracing::info!("壁纸窗口 {label} 的显示器已不在线，销毁");
            // 丢弃 WallpaperWindow：ping 看门狗与鼠标转发线程随之停止
            drop(slot);
            if let Err(e) = self.destroy_window(&label) {
                tracing::warn!("{e}");
                first_error.get_or_insert(e);
            }
        }
        for (label, screen) in moved {
            // Windows 目前没有显示器枚举，窗口不绑定屏，走不到这里；有了枚举之后在这里按新矩形重挂
            #[cfg(not(target_os = "macos"))]
            let _ = (label, screen);
            #[cfg(target_os = "macos")]
            if let Some(window) = self.app.get_webview_window(&label) {
                tracing::debug!(
                    "壁纸窗口 {label} 的显示器矩形变了，重新铺放到 {}x{}@({},{})",
                    screen.width,
                    screen.height,
                    screen.x,
                    screen.y
                );
                if let Err(e) = WallpaperWindow::place(&window, &screen) {
                    tracing::warn!("重新铺放壁纸窗口 {label} 失败: {e}");
                    first_error.get_or_insert(e);
                }
            }
        }
        for (label, assignment) in reassigned {
            tracing::debug!(
                "壁纸窗口 {label} 的布置变为 {}（出声 {}）",
                assignment.target_id,
                assignment.audible
            );
            if let Err(e) = self
                .app
                .emit_to(label.as_str(), ASSIGNMENT_EVENT, &assignment)
            {
                tracing::warn!("向壁纸窗口 {label} 推送布置失败: {e}");
            }
        }

        // 第三步：缺的窗口先全部建出来（各自的页面并行加载），再逐个等就绪、挂载。
        let mut built: Vec<(&'static str, WindowPlan, WebviewWindow<R>)> = Vec::new();
        for plan in create {
            // 先登记布置再建窗：页面初始化时就来取布置，早于它报告就绪。
            // 正在销毁、还没从 Tauri 的窗口表里消失的 label 也算占用。
            let label = {
                let mut slots = self.lock_slots();
                let free = WALLPAPER_LABELS.iter().copied().find(|label| {
                    !slots.contains_key(*label) && self.app.get_webview_window(label).is_none()
                });
                if let Some(label) = free {
                    slots.insert(
                        label.to_string(),
                        Slot {
                            window: None,
                            screen: plan.screen.clone(),
                            assignment: plan.assignment.clone(),
                        },
                    );
                }
                free
            };
            let Some(label) = label else {
                let e = "没有空闲的壁纸窗口 label".to_string();
                tracing::warn!("{e}");
                first_error.get_or_insert(e);
                continue;
            };
            tracing::info!(
                "新建壁纸窗口 {label}: 显示器 {}，目标 {}，出声 {}",
                plan.screen_id().unwrap_or("(未知，铺主屏)"),
                plan.assignment.target_id,
                plan.assignment.audible
            );
            match self.create_window(label, plan.screen.as_ref()) {
                Ok(window) => built.push((label, plan, window)),
                Err(e) => {
                    tracing::warn!("{e}");
                    self.discard(label);
                    first_error.get_or_insert(e);
                }
            }
        }
        for (label, plan, window) in built {
            let mut wallpaper_window = WallpaperWindow::new(window);
            // 挂到桌面层。内部会先等前端 ready 再动窗口句柄，并记下窗口句柄。
            match wallpaper_window.mount(plan.screen.as_ref()) {
                Ok(()) => {
                    if let Some(slot) = self.lock_slots().get_mut(label) {
                        slot.window = Some(wallpaper_window);
                    }
                }
                Err(e) => {
                    tracing::warn!("挂载壁纸窗口 {label} 失败: {e}");
                    drop(wallpaper_window);
                    self.discard(label);
                    first_error.get_or_insert(e);
                }
            }
        }

        first_error.map_or(Ok(()), Err)
    }
}

#[async_trait]
impl<R: Runtime> WallpaperManager for WindowWallpaperManager<R> {
    fn supported_styles(&self, _display: DisplayMode) -> Vec<WallpaperOption> {
        style_options(&["fill", "fit", "stretch", "center", "tile"])
    }

    fn supported_transitions(&self, _display: DisplayMode) -> Vec<WallpaperOption> {
        transition_options(
            &["none", "fade", "slide", "zoom"],
            "settings.transitionNone",
        )
    }

    fn unavailable_reason(&self, display: DisplayMode) -> Option<&'static str> {
        match display {
            DisplayMode::Multiple => None,
            // 跨屏拼接要每个窗口只露出并集画面的一块，并让视频、场景跨窗口对齐，暂不支持
            DisplayMode::Span => Some("settings.displayModeSpanWindow"),
            // 逐屏独立要知道有哪些屏：目前只有 macOS 有显示器枚举
            DisplayMode::Single => {
                (!cfg!(target_os = "macos")).then_some("settings.displayModeLater")
            }
        }
    }

    async fn set_wallpaper(
        &self,
        file_path: &str,
        _style: &str,
        _transition: &str,
        placement: &Placement,
    ) -> Result<(), String> {
        // 窗口在 init() / reconcile() 时已挂载且常显。图片 / 视频 / 网页壁纸都由壁纸页面按自己的布置
        // 监听 setting-change 自驱动渲染（样式由页面铺放，场景交给宿主，对网页壁纸不生效；过渡同样由页面做），
        // 这里只按这张壁纸的类型，给显示该目标的窗口开关桌面鼠标转发。设图、轮播、启动恢复、切换模式、
        // 重新开启壁纸、改样式、显示器模式或在线屏变化后的重新输出都会走到这里。
        self.warn_if_window_missing("set_wallpaper");
        // 判定在窗口锁外做（读 project.json），开关在锁内同步完成；锁内不调会同步等主线程的 getter。
        let path = Path::new(file_path);
        let is_web = web_entry(path)?.is_some();
        let is_scene = path.is_dir()
            && kabegame_core::wpe::read_project(path)
                .is_ok_and(|project| project.kind == kabegame_core::wpe::WpeKind::Scene);
        for slot in self.lock_slots().values_mut() {
            if !placement_covers(placement, slot.screen.as_ref()) {
                continue;
            }
            // 还在等页面就绪的窗口跳过：对齐完成后调用方会把各目标重新输出一次
            if let Some(window) = slot.window.as_mut() {
                window.set_mouse_forwarding(is_web || is_scene);
            }
        }
        Ok(())
    }

    fn reconcile(&self) -> Result<(), String> {
        let active = self.lock_active();
        if !*active {
            // 不在窗口模式（或壁纸关着）：窗口不该存在，屏幕变化与本后端无关
            return Ok(());
        }
        self.align(&Self::current_layout())
    }

    fn window_assignment(&self, label: &str) -> Option<WindowAssignment> {
        self.lock_slots()
            .get(label)
            .map(|slot| slot.assignment.clone())
    }

    fn cleanup(&self) -> Result<(), String> {
        // 离开 window 模式：销毁窗口，而不是藏起来。窗口挂载时被改成了 WorkerW 的
        // 子窗口（WS_CHILD + 改过的扩展样式），留着它下次只会在一个已被改过的窗口上
        // 再挂一次。
        let mut active = self.lock_active();
        *active = false;
        // 丢弃全部 WallpaperWindow：ping 看门狗与鼠标转发线程随之停止（`Pinger` / `InputForwarder` 的 Drop）。
        let slots = std::mem::take(&mut *self.lock_slots());
        drop(slots);
        // 池里每个 label 都查一遍，而不只是在册的：异常路径留下的窗口也一并销毁，不留孤儿。
        let mut first_error = None;
        for label in WALLPAPER_LABELS {
            if let Err(e) = self.destroy_window(label) {
                tracing::warn!("{e}");
                first_error.get_or_insert(e);
            }
        }
        first_error.map_or(Ok(()), Err)
    }

    fn init(&self) -> Result<(), String> {
        let mut active = self.lock_active();
        if !*active {
            tracing::debug!("初始化窗口模式壁纸管理器");
            *active = true;
        }
        // 已在窗口模式时等同于一次对齐（幂等）：窗口都在就什么都不做。
        self.align(&Self::current_layout())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wallpaper::manager::compute_layout;

    fn screen(id: &str, primary: bool, x: i32, y: i32) -> ScreenInfo {
        ScreenInfo {
            id: id.to_string(),
            name: None,
            x,
            y,
            width: 1920,
            height: 1080,
            pixel_width: 1920,
            pixel_height: 1080,
            scale: 1.0,
            primary,
        }
    }

    /// (屏 id, 目标 id, 是否出声)
    fn summary(plans: &[WindowPlan]) -> Vec<(Option<&str>, &str, bool)> {
        plans
            .iter()
            .map(|plan| {
                (
                    plan.screen_id(),
                    plan.assignment.target_id.as_str(),
                    plan.assignment.audible,
                )
            })
            .collect()
    }

    fn current(windows: &[(&str, Option<&str>)]) -> Vec<(String, Option<String>)> {
        windows
            .iter()
            .map(|(label, screen)| (label.to_string(), screen.map(str::to_string)))
            .collect()
    }

    #[test]
    fn multiple_gives_every_screen_the_same_target_and_only_primary_is_audible() {
        // 主屏不在列表第一位也照样只有它出声，且排到最前
        let screens = [screen("side", false, -1920, 0), screen("main", true, 0, 0)];
        let layout = compute_layout(DisplayMode::Multiple, &screens, None);
        assert_eq!(
            summary(&plan_windows(&layout)),
            vec![
                (Some("main"), "multiple", true),
                (Some("side"), "multiple", false)
            ]
        );
    }

    #[test]
    fn multiple_without_a_primary_flag_lets_the_first_screen_speak() {
        let screens = [screen("a", false, 0, 0), screen("b", false, 1920, 0)];
        let layout = compute_layout(DisplayMode::Multiple, &screens, None);
        assert_eq!(
            summary(&plan_windows(&layout)),
            vec![
                (Some("a"), "multiple", true),
                (Some("b"), "multiple", false)
            ]
        );
    }

    #[test]
    fn single_gives_each_screen_its_own_audible_target() {
        let screens = [
            screen("main", true, 0, 0),
            screen("right", false, 1920, 0),
            screen("left", false, -1920, 0),
        ];
        // 默认屏是 right：布局里它排第一，窗口表仍按屏的顺序（主屏第一，其余 (y, x)）
        let layout = compute_layout(DisplayMode::Single, &screens, Some("right"));
        assert_eq!(layout.default_target, "screen:right");
        assert_eq!(
            summary(&plan_windows(&layout)),
            vec![
                (Some("main"), "screen:main", true),
                (Some("left"), "screen:left", true),
                (Some("right"), "screen:right", true),
            ]
        );
    }

    #[test]
    fn no_screen_info_degrades_to_one_unbound_window() {
        // 没有显示器枚举的平台：multiple 与（回落后的）single 都是一个不绑定屏的窗口
        for mode in [DisplayMode::Multiple, DisplayMode::Single] {
            let layout = compute_layout(mode, &[], None);
            assert_eq!(
                summary(&plan_windows(&layout)),
                vec![(None, "multiple", true)]
            );
        }
    }

    #[test]
    fn span_has_no_windows() {
        let layout = compute_layout(DisplayMode::Span, &[screen("main", true, 0, 0)], None);
        assert!(plan_windows(&layout).is_empty());
    }

    #[test]
    fn more_screens_than_labels_are_all_planned() {
        // 截到 label 池大小并告警是对齐时做的，窗口表本身不截
        let screens: Vec<ScreenInfo> = (0..10)
            .map(|index| screen(&format!("s{index}"), index == 0, index * 1920, 0))
            .collect();
        let layout = compute_layout(DisplayMode::Single, &screens, None);
        let plans = plan_windows(&layout);
        assert_eq!(plans.len(), 10);
        assert!(plans.len() > WALLPAPER_LABELS.len());
        assert_eq!(plans[0].screen_id(), Some("s0"));
    }

    #[test]
    fn same_screens_keep_their_windows_whatever_the_assignment() {
        let screens = [screen("main", true, 0, 0), screen("side", false, 1920, 0)];
        let existing = current(&[("wallpaper", Some("main")), ("wallpaper-1", Some("side"))]);
        // multiple → single：屏没变，窗口一个都不动
        for mode in [DisplayMode::Multiple, DisplayMode::Single] {
            let plans = plan_windows(&compute_layout(mode, &screens, None));
            let diff = diff_windows(&existing, &plans);
            assert_eq!(diff.remove, Vec::<String>::new());
            assert_eq!(diff.create, Vec::<usize>::new());
            assert_eq!(
                diff.keep,
                vec![("wallpaper".to_string(), 0), ("wallpaper-1".to_string(), 1)]
            );
        }
    }

    #[test]
    fn windows_follow_screens_by_id_not_by_position() {
        // 副屏挪到了主屏左边（窗口表里顺序不变，矩形变了）：按屏 id 仍对上原窗口
        let screens = [screen("main", true, 0, 0), screen("side", false, -1920, 0)];
        let plans = plan_windows(&compute_layout(DisplayMode::Multiple, &screens, None));
        // label 与屏的对应故意是反的：对齐不按序号重新分配
        let existing = current(&[("wallpaper", Some("side")), ("wallpaper-1", Some("main"))]);
        let diff = diff_windows(&existing, &plans);
        assert_eq!(
            diff.keep,
            vec![("wallpaper".to_string(), 1), ("wallpaper-1".to_string(), 0)]
        );
        assert!(diff.remove.is_empty() && diff.create.is_empty());
    }

    #[test]
    fn unplugged_screen_loses_its_window_and_a_new_screen_gets_one() {
        let existing = current(&[("wallpaper", Some("main")), ("wallpaper-1", Some("side"))]);
        // 拔掉 side
        let plans = plan_windows(&compute_layout(
            DisplayMode::Single,
            &[screen("main", true, 0, 0)],
            None,
        ));
        let diff = diff_windows(&existing, &plans);
        assert_eq!(diff.remove, vec!["wallpaper-1".to_string()]);
        assert_eq!(diff.keep, vec![("wallpaper".to_string(), 0)]);
        assert!(diff.create.is_empty());

        // 再接上另一块屏 other：主屏窗口保留，other 新建
        let plans = plan_windows(&compute_layout(
            DisplayMode::Single,
            &[screen("main", true, 0, 0), screen("other", false, 1920, 0)],
            None,
        ));
        let diff = diff_windows(&current(&[("wallpaper", Some("main"))]), &plans);
        assert!(diff.remove.is_empty());
        assert_eq!(diff.keep, vec![("wallpaper".to_string(), 0)]);
        assert_eq!(diff.create, vec![1]);
    }

    #[test]
    fn empty_table_creates_every_window_and_empty_plan_removes_all() {
        let screens = [screen("main", true, 0, 0), screen("side", false, 1920, 0)];
        let plans = plan_windows(&compute_layout(DisplayMode::Multiple, &screens, None));
        assert_eq!(diff_windows(&[], &plans).create, vec![0, 1]);

        let existing = current(&[("wallpaper", Some("main")), ("wallpaper-1", Some("side"))]);
        let diff = diff_windows(&existing, &[]);
        assert_eq!(
            diff.remove,
            vec!["wallpaper".to_string(), "wallpaper-1".to_string()]
        );
        assert!(diff.keep.is_empty() && diff.create.is_empty());
    }

    #[test]
    fn unbound_window_matches_only_the_unbound_plan() {
        // 没有屏幕信息时的那一个窗口：布局不变就保留
        let plans = plan_windows(&compute_layout(DisplayMode::Multiple, &[], None));
        let diff = diff_windows(&current(&[("wallpaper", None)]), &plans);
        assert_eq!(diff.keep, vec![("wallpaper".to_string(), 0)]);
        assert!(diff.remove.is_empty() && diff.create.is_empty());
        // 之后有了屏幕信息：不绑定屏的窗口换成按屏的窗口
        let plans = plan_windows(&compute_layout(
            DisplayMode::Multiple,
            &[screen("main", true, 0, 0)],
            None,
        ));
        let diff = diff_windows(&current(&[("wallpaper", None)]), &plans);
        assert_eq!(diff.remove, vec!["wallpaper".to_string()]);
        assert_eq!(diff.create, vec![0]);
    }

    #[test]
    fn placement_picks_the_windows_showing_that_target() {
        let main = screen("main", true, 0, 0);
        let side = screen("side", false, 1920, 0);
        let all = Placement::All {
            screens: vec![main.clone(), side.clone()],
        };
        assert!(placement_covers(&all, Some(&main)));
        assert!(placement_covers(&all, Some(&side)));
        // 没有屏幕信息时的那一个窗口也属于「所有显示器」
        assert!(placement_covers(&Placement::All { screens: vec![] }, None));

        let one = Placement::One {
            screen: side.clone(),
        };
        assert!(placement_covers(&one, Some(&side)));
        assert!(!placement_covers(&one, Some(&main)));
        assert!(!placement_covers(&one, None));
        assert!(!placement_covers(&Placement::Span, Some(&main)));
    }

    #[test]
    fn assignment_serializes_as_camel_case() {
        let value = serde_json::to_value(WindowAssignment {
            target_id: "screen:a".into(),
            audible: false,
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({ "targetId": "screen:a", "audible": false })
        );
    }
}
