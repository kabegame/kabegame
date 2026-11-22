// 窗口壁纸模块 - 类似 Wallpaper Engine 的实现

use crate::wallpaper::screens::ScreenInfo;
use std::collections::HashSet;
use std::sync::{Condvar, Mutex, OnceLock};
use tauri::{Runtime, WebviewWindow};

// 已完全初始化（前端 DOM + Vue 组件 + 事件监听器都已就绪）的壁纸窗口 label。
// 由 wallpaper_window_ready 命令按调用方 label 登记，并通过 notify_all 唤醒所有等待者；
// 每个壁纸窗口各等各的。
struct ReadyNotify {
    ready: Mutex<HashSet<String>>,
    cv: Condvar,
}

static WALLPAPER_WINDOW_READY: OnceLock<ReadyNotify> = OnceLock::new();

fn ready_notify() -> &'static ReadyNotify {
    WALLPAPER_WINDOW_READY.get_or_init(|| ReadyNotify {
        ready: Mutex::new(HashSet::new()),
        cv: Condvar::new(),
    })
}

/// 一个壁纸窗口。窗口模式下每块在线屏一个（见 [`super::WindowWallpaperManager`]），各有各的就绪握手与 ping 看门狗。
///
/// 窗口始终停在应用页（`index.html?window=wallpaper`，`WallpaperWindow.vue`），图片 / 视频 / 网页壁纸
/// 都由 `Wallpaper` 自驱动渲染：网页壁纸（`x-wpe/web`）是 `WpeWallpaperContent` 里的 `file:` iframe，与图库预览
/// 同一套组件与代码路径，窗口本身不再导航。后端只负责挂载与 ping 看门狗；桌面鼠标由网页壁纸 / 场景宿主的
/// iframe 自己向 `tauri-plugin-cursor` 登记（点击规则：光标下是桌面）。
pub struct WallpaperWindow<R: Runtime> {
    window: WebviewWindow<R>,
    /// ping 看门狗：mount 完成后启动，随本对象丢弃而停止。
    pinger: Option<super::ping::Pinger>,
    /// Linux（插件模式）：离屏 browser 的帧推到这一路 PipeWire 流；随本对象丢弃而断开，帧接收器同时摘掉。
    #[cfg(target_os = "linux")]
    stream: Option<std::sync::Arc<crate::wallpaper::manager::plasma::pipewire::WallpaperStream>>,
    /// Linux：窗口登记成了光标的外部来源（挂载后为真），随本对象丢弃注销。
    #[cfg(target_os = "linux")]
    external_pointer: bool,
}

/// Linux 离屏壁纸窗口的最高帧率（CEF `windowless_frame_rate`，也是 PipeWire 流的 `maxFramerate`）。
#[cfg(target_os = "linux")]
pub const OFFSCREEN_MAX_FPS: u32 = 60;

impl<R: Runtime> WallpaperWindow<R> {
    /// 由 `WindowWallpaperManager::init()` 在确保窗口已创建后调用。
    pub fn new(window: WebviewWindow<R>) -> Self {
        Self {
            window,
            pinger: None,
            #[cfg(target_os = "linux")]
            stream: None,
            #[cfg(target_os = "linux")]
            external_pointer: false,
        }
    }

    /// 标记壁纸窗口 `label` 已完全初始化（由 wallpaper_window_ready 命令按调用方 label 调用）
    pub fn mark_ready(label: &str) {
        let n = ready_notify();
        // poisoned 也照常登记，不阻断主流程
        n.ready
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(label.to_string());
        n.cv.notify_all();
    }

    /// 撤销 `label` 的 ready 标记。**必须**在销毁该壁纸窗口时调用：标记是进程级静态、label 会被复用，
    /// 不撤销的话下次用同一个 label 重建窗口时 `wait_ready` 会立刻返回，挂载会打在一个
    /// 前端尚未加载的窗口上。
    pub fn reset_ready(label: &str) {
        ready_notify()
            .ready
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(label);
    }

    /// 等待窗口 `label` ready（挂载前阻塞等待前端加载完成）
    pub fn wait_ready(label: &str, timeout: std::time::Duration) -> Result<(), String> {
        let n = ready_notify();
        let guard = n
            .ready
            .lock()
            .map_err(|_| "WALLPAPER_WINDOW_READY mutex poisoned".to_string())?;

        let (guard, wait_res) =
            n.cv.wait_timeout_while(guard, timeout, |ready| !ready.contains(label))
                .map_err(|_| "WALLPAPER_WINDOW_READY condvar wait failed".to_string())?;

        if guard.contains(label) {
            Ok(())
        } else if wait_res.timed_out() {
            Err(format!("壁纸窗口 {label} 初始化超时，放弃挂载"))
        } else {
            Err(format!("壁纸窗口 {label} 等待就绪失败"))
        }
    }

    /// 把窗口挂到桌面层并显示。窗口在其存续期间保持挂载与常显，故本方法只在
    /// `WindowWallpaperManager` 建立窗口时调用一次；之后屏的位置 / 尺寸变了用 [`Self::place`]。
    ///
    /// `screen` 是窗口要铺满的屏；`None`（没有屏幕信息的平台）时铺满窗口所在的屏。
    #[cfg_attr(not(target_os = "macos"), allow(unused_variables))]
    pub fn mount(&mut self, screen: Option<&ScreenInfo>) -> Result<(), String> {
        // 等待前端 ready（由 mark_ready() -> notify_all() 唤醒）后再挂载：
        // 挂载会读取窗口句柄并改其父子/样式，必须等 webview 真正建起来。
        Self::wait_ready(self.window.label(), std::time::Duration::from_secs(100))?;

        #[cfg(target_os = "windows")]
        tauri_plugin_wemt::attach_window(&self.window, None).map_err(|e| e.to_string())?;

        #[cfg(target_os = "macos")]
        tauri_plugin_wemt::mount_to_desktop(&self.window, screen.map(desktop_rect))?;

        // 建窗时是 visible(false)（避免挂载前闪一下窗口），挂好后转常显。
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        self.window
            .show()
            .map_err(|e| format!("显示壁纸窗口失败: {}", e))?;

        // Linux（Plasma）：没有桌面层可挂，离屏 browser 的帧推到 PipeWire，由 Plasma 壁纸插件显示。离屏 browser 建成时是隐藏的，
        // 有消费者拉流才显示、出帧（流的状态回调）。
        // Linux（GNOME）：普通窗口，显示出来后由 Kabegame 的 Shell 扩展按标题认出、挂到桌面层。
        #[cfg(target_os = "linux")]
        if tauri_runtime_kbcef::offscreen_geometry(self.window.label()).is_some() {
            self.attach_stream(screen)?;
        } else {
            self.window
                .show()
                .map_err(|e| format!("显示壁纸窗口失败: {}", e))?;
            crate::wallpaper::manager::pointer_socket::set_windowed_wallpaper(self.window.label(), true);
        }
        // 外部光标来源：Plasma 插件经输入 socket 把桌面上的鼠标发回来（`pointer_socket`），GNOME 下页面自己收到鼠标、经
        // `push_window_pointer` 交给应用；iframe 照 Windows / macOS 登记 frame 注入
        #[cfg(target_os = "linux")]
        {
            tauri_plugin_cursor::register_external_pointer(self.window.label());
            self.external_pointer = true;
        }

        let target = self.window.clone();
        self.pinger = Some(super::ping::Pinger::start(
            self.window.label().to_string(),
            // 重载当前文档；窗口已销毁时 reload 返回错误，只记日志。
            move || {
                if let Err(error) = target.reload() {
                    tracing::warn!("重载壁纸窗口失败: {error}");
                    return;
                }
                // 旧文档主 frame 的 JS 监听（含 wallpaper-ping）随重载作废，Tauri 不会自己清；
                // 网页壁纸 iframe 的监听随 frame 销毁（`SubframeDestroyed`）清掉，这里一并清也无妨。
                target.clear_js_listeners();
            },
        ));
        Ok(())
    }

    /// 建这个窗口的 PipeWire 流并挂成离屏 browser 的帧接收器。流的状态变了就让离屏 browser 停帧或恢复：没有消费者时
    /// 不出帧省 GPU，恢复时请一整帧（静态页面不会自己再出帧）。节点属性里带输入 socket，插件把桌面上的鼠标发回来。
    #[cfg(target_os = "linux")]
    fn attach_stream(&mut self, screen: Option<&ScreenInfo>) -> Result<(), String> {
        use crate::wallpaper::manager::plasma::pipewire::{StreamProps, WallpaperStream};

        let label = self.window.label().to_string();
        let slot = crate::wallpaper::WALLPAPER_LABELS
            .iter()
            .position(|pooled| *pooled == label)
            .unwrap_or(0) as u32;
        let size = self
            .window
            .inner_size()
            .map_err(|e| format!("读取壁纸窗口 {label} 的尺寸失败: {e}"))?;
        let state_label = label.clone();
        let idle_label = label.clone();
        let stream = WallpaperStream::new(
            StreamProps {
                node_name: format!("kabegame-wallpaper-{slot}"),
                description: format!("Kabegame Wallpaper {slot}"),
                slot,
                screen: screen.map(|screen| screen.id.clone()),
                // 应用启动时已经起好（init_post），这里只取路径
                input: crate::wallpaper::manager::pointer_socket::ensure_started(|| {
                    crate::wallpaper::manager::pointer_socket::main_window_probe(
                        tauri::Manager::app_handle(&self.window).clone(),
                    )
                }),
                max_fps: OFFSCREEN_MAX_FPS,
                // 与建窗时登记的共享纹理一致（manager::window::create_window）
                dmabuf: crate::wallpaper::manager::plasma::pipewire::dmabuf_enabled(),
            },
            size.width,
            size.height,
            Box::new(move |streaming| {
                if let Err(e) = tauri_runtime_kbcef::set_offscreen_hidden(&state_label, !streaming) {
                    tracing::warn!("切换壁纸窗口 {state_label} 的离屏出帧失败: {e}");
                }
                if streaming {
                    if let Err(e) = tauri_runtime_kbcef::invalidate_offscreen(&state_label) {
                        tracing::warn!("请壁纸窗口 {state_label} 重画失败: {e}");
                    }
                }
            }),
            // 静态页面不出帧：后连上来的消费者靠它拿到第一帧
            Box::new(move || {
                if let Err(e) = tauri_runtime_kbcef::invalidate_offscreen(&idle_label) {
                    tracing::debug!("请壁纸窗口 {idle_label} 重画失败: {e}");
                }
            }),
        )
        .map_err(|e| format!("建壁纸窗口 {label} 的 PipeWire 流失败: {e}"))?;
        tracing::info!(
            "壁纸窗口 {label} 推流到 PipeWire 节点 {}（{}x{}）",
            stream.node_name(),
            size.width,
            size.height
        );
        let stream = std::sync::Arc::new(stream);
        tauri_runtime_kbcef::set_offscreen_frame_sink(&label, Some(stream.clone()));
        self.stream = Some(stream);
        Ok(())
    }

    /// 已挂载的壁纸窗口重新铺到 `screen`（屏的位置 / 尺寸变了、系统重排后）。只动窗口的 frame 与层级，
    /// 页面不重载。会同步等主线程，调用方不能持 manager 的窗口表锁。
    ///
    /// Windows 目前没有显示器枚举（只有一个窗口、铺主屏），不会走到这里。
    #[cfg(target_os = "macos")]
    pub fn place(window: &WebviewWindow<R>, screen: &ScreenInfo) -> Result<(), String> {
        tauri_plugin_wemt::mount_to_desktop(window, Some(desktop_rect(screen))).map(|_| ())
    }
}

/// macOS：屏的矩形（左上原点的点坐标）交给 `tauri-plugin-wemt` 的桌面层挂载。
#[cfg(target_os = "macos")]
fn desktop_rect(screen: &ScreenInfo) -> tauri_plugin_wemt::DesktopRect {
    (
        f64::from(screen.x),
        f64::from(screen.y),
        f64::from(screen.width),
        f64::from(screen.height),
    )
}

#[cfg(target_os = "linux")]
impl<R: Runtime> Drop for WallpaperWindow<R> {
    fn drop(&mut self) {
        // 帧接收器表里还有一份流的引用：先摘掉，流随本对象最后一份引用断开、销毁节点
        if self.stream.take().is_some() {
            tauri_runtime_kbcef::set_offscreen_frame_sink(self.window.label(), None);
        }
        // 外部光标来源一并注销：已登记的 frame 下一轮收到收尾（补抬起与离开）
        if self.external_pointer {
            tauri_plugin_cursor::unregister_external_pointer(self.window.label());
        }
        crate::wallpaper::manager::pointer_socket::set_windowed_wallpaper(self.window.label(), false);
    }
}
