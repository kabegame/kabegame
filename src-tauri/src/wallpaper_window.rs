// 窗口壁纸模块 - 类似 Wallpaper Engine 的实现

use crate::settings::Settings;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

// 标记壁纸窗口是否已完全初始化（前端 DOM + Vue 组件 + 事件监听器都已就绪）
// 由 wallpaper_window_ready 命令设置为 true，create 方法中会等待此标记
static WALLPAPER_WINDOW_READY: AtomicBool = AtomicBool::new(false);

pub struct WallpaperWindow {
    window: Option<WebviewWindow>,
    app: AppHandle,
}

impl WallpaperWindow {
    pub fn new(app: AppHandle) -> Self {
        Self { window: None, app }
    }

    /// 创建壁纸窗口
    pub fn create(&mut self, image_path: &str) -> Result<(), String> {
        // 注意：不要 close 壁纸窗口！close 会销毁窗口句柄，后续 SetParent 会报 1400（无效句柄）。
        // 这里始终复用预创建的 wallpaper 窗口。
        let window = match &self.window {
            Some(w) => w.clone(),
            None => self
                .app
                .get_webview_window("wallpaper")
                .ok_or_else(|| "壁纸窗口不存在。请确保在应用启动时已创建壁纸窗口".to_string())?,
        };

        // 等待窗口完全初始化（前端 DOM + Vue 组件 + 事件监听器都已就绪）
        // 超时时间：最多等待 100 秒
        let max_wait_ms = 100000;
        let check_interval_ms = 100;
        let max_attempts = max_wait_ms / check_interval_ms;

        let mut attempts = 0;
        for _ in 0..max_attempts {
            if WALLPAPER_WINDOW_READY.load(Ordering::Acquire) {
                // 窗口已 ready，可以继续
                if attempts > 0 {
                    let waited_ms = attempts * check_interval_ms;
                    eprintln!("[DEBUG] 壁纸窗口已就绪（等待了 {}ms）", waited_ms);
                }
                break;
            }
            attempts += 1;
            std::thread::sleep(Duration::from_millis(check_interval_ms));
        }

        if !WALLPAPER_WINDOW_READY.load(Ordering::Acquire) {
            eprintln!(
                "[WARN] 壁纸窗口初始化超时（等待了 {}ms）,放弃推送",
                max_wait_ms
            );
            return Err("壁纸窗口初始化超时，放弃推送".to_string());
        } else {
            // 如果窗口已就绪，则直接推送壁纸更新事件到窗口
            self.app
                .emit("wallpaper-update-image", image_path)
                .map_err(|e| format!("推送壁纸图片事件失败: {}", e))?;

            // 推送样式和过渡效果事件
            if let Some(settings_state) = self.app.try_state::<Settings>() {
                if let Ok(s) = settings_state.get_settings() {
                    let _ = self
                        .app
                        .emit("wallpaper-update-style", s.wallpaper_rotation_style);
                    let _ = self.app.emit(
                        "wallpaper-update-transition",
                        s.wallpaper_rotation_transition,
                    );
                }
            }

            // 在 Windows 上设置窗口为壁纸层
            #[cfg(target_os = "windows")]
            {
                Self::set_window_as_wallpaper(&window)?;
            }

            // 显示窗口
            window
                .show()
                .map_err(|e| format!("显示壁纸窗口失败: {}", e))?;
            Ok(())
        }
    }

    /// 标记壁纸窗口已完全初始化（由 wallpaper_window_ready 命令调用）
    pub fn mark_ready() {
        WALLPAPER_WINDOW_READY.store(true, Ordering::Release);
    }

    /// 重置 ready 标记（窗口重新创建或隐藏时调用）
    pub fn reset_ready() {
        WALLPAPER_WINDOW_READY.store(false, Ordering::Release);
    }

    /// 检查窗口是否已 ready
    pub fn is_ready() -> bool {
        WALLPAPER_WINDOW_READY.load(Ordering::Acquire)
    }

    /// 更新壁纸图片
    pub fn update_image(&self, image_path: &str) -> Result<(), String> {
        // 事件改为广播，不依赖任何窗口引用（方便用 wallpaper_debug 验证事件是否到达）
        let _ = self.window.as_ref();
        let _ = self.app.get_webview_window("wallpaper");
        self.app
            .emit("wallpaper-update-image", image_path)
            .map_err(|e| format!("广播壁纸图片事件失败: {}", e))?;

        Ok(())
    }

    /// 重新挂载窗口到桌面（用于从原生模式切换回窗口模式时）
    pub fn remount(&self) -> Result<(), String> {
        let window = self
            .app
            .get_webview_window("wallpaper")
            .ok_or_else(|| "壁纸窗口不存在".to_string())?;

        #[cfg(target_os = "windows")]
        {
            Self::set_window_as_wallpaper(&window)?;
        }

        // 显示窗口
        window
            .show()
            .map_err(|e| format!("显示壁纸窗口失败: {}", e))?;

        Ok(())
    }

    /// 更新壁纸样式
    pub fn update_style(&self, style: &str) -> Result<(), String> {
        let _ = self.window.as_ref();
        let _ = self.app.get_webview_window("wallpaper");
        self.app
            .emit("wallpaper-update-style", style)
            .map_err(|e| format!("广播壁纸样式事件失败: {}", e))?;
        Ok(())
    }

    /// 更新壁纸过渡效果
    pub fn update_transition(&self, transition: &str) -> Result<(), String> {
        let _ = self.window.as_ref();
        let _ = self.app.get_webview_window("wallpaper");
        self.app
            .emit("wallpaper-update-transition", transition)
            .map_err(|e| format!("广播壁纸过渡事件失败: {}", e))?;
        Ok(())
    }

    /// 关闭壁纸窗口
    #[allow(dead_code)]
    pub fn close(&mut self) {
        // 不要主动 close 壁纸窗口：close 会销毁窗口句柄，后续 SetParent 可能报 1400（无效句柄）。
        // 这里只清空引用，窗口在应用生命周期内复用。
        self.window = None;
    }

    #[cfg(target_os = "windows")]
    fn set_window_as_wallpaper(window: &WebviewWindow) -> Result<(), String> {
        use std::thread;
        use std::time::Duration;

        // 等待窗口完全创建
        thread::sleep(Duration::from_millis(500));

        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Foundation::RECT;
        use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM};
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            EnumWindows, FindWindowExW, FindWindowW, GetClientRect, GetSystemMetrics,
            GetWindowLongPtrW, IsWindow, SendMessageTimeoutW, SetParent, SetWindowLongPtrW,
            SetWindowPos, ShowWindow, GWL_EXSTYLE, GWL_STYLE, SMTO_ABORTIFHUNG, SWP_NOACTIVATE,
            SWP_SHOWWINDOW, SW_SHOW, WS_CHILD, WS_EX_NOACTIVATE, WS_POPUP,
        };

        fn wide(s: &str) -> Vec<u16> {
            OsStr::new(s).encode_wide().chain(Some(0)).collect()
        }

        unsafe fn hwnd_class(hwnd: HWND) -> String {
            use windows_sys::Win32::UI::WindowsAndMessaging::GetClassNameW;
            let mut buf = [0u16; 256];
            let len = GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
            if len > 0 {
                String::from_utf16_lossy(&buf[..len as usize])
            } else {
                "<unknown>".to_string()
            }
        }

        unsafe fn find_shell_top(progman: HWND) -> Result<HWND, String> {
            #[derive(Default)]
            struct Search {
                shell_top: HWND,
            }

            unsafe extern "system" fn enum_find_shell_top(hwnd: HWND, lparam: LPARAM) -> BOOL {
                let state = &mut *(lparam as *mut Search);
                // 关键：File Explorer 窗口也包含 SHELLDLL_DefView（文件夹视图），会导致误判成“桌面”。
                // 所以这里只接受顶层 class 为 WorkerW / Progman 的窗口作为候选。
                let class_name = hwnd_class(hwnd);
                if class_name == "WorkerW" || class_name == "Progman" {
                    let def_view =
                        FindWindowExW(hwnd, 0, wide("SHELLDLL_DefView").as_ptr(), std::ptr::null());
                    if def_view != 0 {
                        state.shell_top = hwnd;
                        return 0; // stop
                    }
                }
                1 // continue
            }

            let mut search = Search::default();
            EnumWindows(
                Some(enum_find_shell_top),
                (&mut search as *mut Search) as isize,
            );

            // 如果没找到，尝试 Progman 本身是否承载 SHELLDLL_DefView
            let mut shell_top = search.shell_top;
            if shell_top == 0 {
                let def_view = FindWindowExW(
                    progman,
                    0,
                    wide("SHELLDLL_DefView").as_ptr(),
                    std::ptr::null(),
                );
                if def_view != 0 {
                    shell_top = progman;
                }
            }

            if shell_top == 0 {
                // 额外诊断：打印一下“哪些顶层窗口包含 SHELLDLL_DefView”，帮助定位误命中/壳层差异
                #[derive(Default)]
                struct Dump {
                    count: u32,
                }
                unsafe extern "system" fn enum_dump(hwnd: HWND, lparam: LPARAM) -> BOOL {
                    let d = &mut *(lparam as *mut Dump);
                    let def_view =
                        FindWindowExW(hwnd, 0, wide("SHELLDLL_DefView").as_ptr(), std::ptr::null());
                    if def_view != 0 {
                        d.count += 1;
                        eprintln!(
                            "[DEBUG] top hwnd={} class={} has SHELLDLL_DefView",
                            hwnd,
                            hwnd_class(hwnd)
                        );
                    }
                    1
                }
                let mut dump = Dump::default();
                EnumWindows(Some(enum_dump), (&mut dump as *mut Dump) as isize);

                return Err(
                    "找不到桌面图标宿主（未在 WorkerW/Progman 顶层窗口中发现 SHELLDLL_DefView）"
                        .to_string(),
                );
            }
            Ok(shell_top)
        }

        // 1) 获取 Tauri 壁纸窗口 HWND（无需查标题）
        let tauri_hwnd = window
            .hwnd()
            .map_err(|e| format!("无法获取壁纸窗口句柄(hwnd): {}", e))?;
        // tauri 的 hwnd() 在 windows 返回 *mut c_void；windows-sys 的 HWND 是 isize
        let tauri_hwnd: HWND = tauri_hwnd.0 as isize;

        unsafe {
            // 2) 找 Progman
            let progman = FindWindowW(wide("Progman").as_ptr(), std::ptr::null());
            if progman == 0 {
                return Err("FindWindowW(Progman) failed".to_string());
            }

            // 3) 发送 0x052C 促使生成 WorkerW
            let mut _result: usize = 0;
            let _ = SendMessageTimeoutW(
                progman,
                0x052C,
                0xD, // 关键：主流实现使用 wParam=0xD 来触发 WorkerW 创建/刷新
                0,
                SMTO_ABORTIFHUNG,
                1000,
                &mut _result as *mut usize,
            );

            // 4) 查找承载桌面图标的顶层窗口(shell_top)，并优先取其后一个 WorkerW
            // 经典路径：shell_top 是 WorkerW/Progman，且其后有一个 WorkerW 可用作壁纸层。
            // 兼容路径：有些 Win11/特殊壳层上，shell_top 可能不是 WorkerW，且没有“后一个 WorkerW”；
            //          这时直接把壁纸窗口挂到 shell_top，并在父窗口内置底(HWND_BOTTOM)，让图标层(DefView)仍在上面。
            let mut parent: HWND = 0;
            let mut shell_top: HWND = 0;
            let mut last_err: Option<String> = None;
            for _ in 0..12 {
                match find_shell_top(progman) {
                    Ok(top) => {
                        shell_top = top;
                        // 经典路径：icon_host(=shell_top) 后面的 WorkerW
                        let workerw_after =
                            FindWindowExW(0, shell_top, wide("WorkerW").as_ptr(), std::ptr::null());

                        // 兼容路径：有些系统上找不到“后一个 WorkerW”，但仍存在某个 WorkerW 作为“壁纸层”（不包含 DefView）。
                        // 关键：不要随便拿第一个！要选“client rect 最大且高度>0”的那个，否则会命中你现在这种 176x0 的假 WorkerW。
                        #[derive(Default)]
                        struct FindWorkerWBest {
                            best: HWND,
                            best_area: i64,
                            best_w: i32,
                            best_h: i32,
                        }
                        unsafe extern "system" fn enum_find_workerw_best(
                            hwnd: HWND,
                            lparam: LPARAM,
                        ) -> BOOL {
                            let s = &mut *(lparam as *mut FindWorkerWBest);

                            if hwnd_class(hwnd) != "WorkerW" {
                                return 1;
                            }
                            let def_view = FindWindowExW(
                                hwnd,
                                0,
                                wide("SHELLDLL_DefView").as_ptr(),
                                std::ptr::null(),
                            );
                            if def_view != 0 {
                                return 1;
                            }

                            let mut rc: RECT = std::mem::zeroed();
                            if GetClientRect(hwnd, &mut rc as *mut RECT) == 0 {
                                return 1;
                            }
                            let w = rc.right - rc.left;
                            let h = rc.bottom - rc.top;
                            if w <= 0 || h <= 0 {
                                return 1;
                            }
                            let area = (w as i64) * (h as i64);
                            if area > s.best_area {
                                s.best_area = area;
                                s.best = hwnd;
                                s.best_w = w;
                                s.best_h = h;
                            }
                            1
                        }

                        let mut best = FindWorkerWBest::default();
                        EnumWindows(
                            Some(enum_find_workerw_best),
                            (&mut best as *mut FindWorkerWBest) as isize,
                        );
                        let best_workerw_without_defview = best.best;

                        // 如果 workerw_after 存在但本身 client 为 0，也不要用它（同样会被裁剪成不可见）
                        let workerw_after_ok = if workerw_after != 0 {
                            let mut rc: RECT = std::mem::zeroed();
                            let ok = GetClientRect(workerw_after, &mut rc as *mut RECT);
                            let w = rc.right - rc.left;
                            let h = rc.bottom - rc.top;
                            ok != 0 && w > 0 && h > 0
                        } else {
                            false
                        };

                        parent = if workerw_after != 0 && workerw_after_ok {
                            workerw_after
                        } else if best_workerw_without_defview != 0 {
                            best_workerw_without_defview
                        } else {
                            // 最后兜底：只能挂到 shell_top（可能会挡图标），但至少不“完全没反应”
                            shell_top
                        };
                        break;
                    }
                    Err(e) => {
                        last_err = Some(e);
                        thread::sleep(Duration::from_millis(200));
                    }
                }
            }
            if parent == 0 {
                return Err(format!(
                    "查找桌面承载窗口失败: {}",
                    last_err.unwrap_or_else(|| "unknown".to_string())
                ));
            }

            // 句柄有效性检查（GetLastError=1400 的根因通常是无效 hwnd）
            if IsWindow(tauri_hwnd) == 0 {
                return Err("Tauri wallpaper hwnd is invalid (IsWindow=0)".to_string());
            }
            if IsWindow(parent) == 0 {
                return Err("Parent hwnd is invalid (IsWindow=0)".to_string());
            }

            // 5) 变成子窗口（否则 SetParent 后可能仍保持 WS_POPUP，导致不可见/不铺满等怪问题）
            let style = GetWindowLongPtrW(tauri_hwnd, GWL_STYLE) as isize;
            let new_style = (style & !(WS_POPUP as isize)) | (WS_CHILD as isize);
            SetWindowLongPtrW(tauri_hwnd, GWL_STYLE, new_style);

            // 5) SetParent 到 parent（优先 workerw_after_shell_top，否则其他 WorkerW，否则 shell_top）
            // 注意：child window 会被 parent 的 client area 裁剪。
            // 你现在日志里 WorkerW client height=0，导致“挂载成功但永远不可见”。
            // 所以这里先挂一次，后面会检测 parent client rect，如果为 0 则回退挂到 shell_top 并置底。
            {
                let prev_parent = SetParent(tauri_hwnd, parent);
                if prev_parent == 0 {
                    let err = windows_sys::Win32::Foundation::GetLastError();
                    return Err(format!("SetParent failed. GetLastError={}", err));
                }
            }

            // 6) 先只设置为不抢焦点，排除 WS_EX_LAYERED / WS_EX_TRANSPARENT 导致完全不可见的问题
            let ex = GetWindowLongPtrW(tauri_hwnd, GWL_EXSTYLE) as isize;
            let new_ex = ex | (WS_EX_NOACTIVATE as isize);
            SetWindowLongPtrW(tauri_hwnd, GWL_EXSTYLE, new_ex);

            // 7) 关键：作为子窗口时，坐标是“父窗口客户区坐标系”，不能用屏幕/虚拟屏幕坐标。
            // 否则很容易移动到父窗口范围之外，导致桌面上永远看不到任何变化。
            // 输出一些 debug，便于你确认挂到哪一层
            {
                let parent_class = hwnd_class(parent);
                let shell_top_class = hwnd_class(shell_top);
                eprintln!(
                    "[DEBUG] wallpaper parent hwnd={} class={} shell_top={} shell_top_class={} progman={}",
                    parent, parent_class, shell_top, shell_top_class, progman
                );
            }

            let mut rc: RECT = std::mem::zeroed();
            // Z序策略：
            // - 如果 parent == shell_top（也就是图标宿主本身），必须插到 SHELLDLL_DefView 下面，确保图标永远在上层
            // - 如果 parent 是 “shell_top 后面的 WorkerW”（经典壁纸层），置顶/默认即可
            const HWND_BOTTOM: HWND = 1;
            let insert_after: HWND = if parent == shell_top {
                let def_view = FindWindowExW(
                    shell_top,
                    0,
                    wide("SHELLDLL_DefView").as_ptr(),
                    std::ptr::null(),
                );
                if def_view != 0 && IsWindow(def_view) != 0 {
                    // 插到 DefView(桌面图标层) 的下面
                    def_view
                } else {
                    HWND_BOTTOM
                }
            } else {
                0
            };

            let mut w = 0;
            let mut h = 0;
            let ok = GetClientRect(parent, &mut rc as *mut RECT);
            if ok != 0 {
                w = rc.right - rc.left;
                h = rc.bottom - rc.top;
            }

            // 关键：child window 会被 parent 的 client area 裁剪。
            // 如果 parent client 为 0（你当前遇到的情况），无论子窗口设置多大都会“被裁成不可见”。
            // 此时回退：挂到 shell_top(Progman/WorkerW icon host) 并强制置底，让图标层在上面。
            if ok == 0 || w <= 0 || h <= 0 {
                eprintln!(
                    "[DEBUG] parent client rect invalid/zero (ok={}, rc=({}, {}, {}, {})), try fallback parent=shell_top and HWND_BOTTOM",
                    ok, rc.left, rc.top, rc.right, rc.bottom
                );

                if shell_top != 0 && IsWindow(shell_top) != 0 && parent != shell_top {
                    // 切换 parent 到 shell_top
                    let prev_parent = SetParent(tauri_hwnd, shell_top);
                    if prev_parent == 0 {
                        let err = windows_sys::Win32::Foundation::GetLastError();
                        return Err(format!("SetParent(shell_top) failed. GetLastError={}", err));
                    }
                    parent = shell_top;
                }

                // 重新取 client rect（shell_top 应该有有效大小）
                let mut rc2: RECT = std::mem::zeroed();
                let ok2 = GetClientRect(parent, &mut rc2 as *mut RECT);
                let mut w2 = 0;
                let mut h2 = 0;
                if ok2 != 0 {
                    w2 = rc2.right - rc2.left;
                    h2 = rc2.bottom - rc2.top;
                }

                if ok2 == 0 || w2 <= 0 || h2 <= 0 {
                    // 仍然异常：最后用屏幕尺寸（至少 SetWindowPos 有数值；但注意仍会被裁剪）
                    let sw = GetSystemMetrics(0); // SM_CXSCREEN
                    let sh = GetSystemMetrics(1); // SM_CYSCREEN
                    eprintln!(
                        "[DEBUG] shell_top client rect still invalid/zero (ok2={}, rc2=({}, {}, {}, {})), fallback to screen {}x{}",
                        ok2, rc2.left, rc2.top, rc2.right, rc2.bottom, sw, sh
                    );
                    w = sw;
                    h = sh;
                } else {
                    eprintln!(
                        "[DEBUG] fallback parent shell_top rc=({}, {}, {}, {}), size={}x{}",
                        rc2.left, rc2.top, rc2.right, rc2.bottom, w2, h2
                    );
                    w = w2;
                    h = h2;
                }

                // parent 已经是 shell_top：必须置底，避免挡住桌面图标层
                let insert_after = {
                    let def_view = FindWindowExW(
                        parent,
                        0,
                        wide("SHELLDLL_DefView").as_ptr(),
                        std::ptr::null(),
                    );
                    if def_view != 0 && IsWindow(def_view) != 0 {
                        def_view
                    } else {
                        HWND_BOTTOM
                    }
                };
                SetWindowPos(
                    tauri_hwnd,
                    insert_after,
                    0,
                    0,
                    w,
                    h,
                    SWP_NOACTIVATE | SWP_SHOWWINDOW,
                );
                ShowWindow(tauri_hwnd, SW_SHOW);
                println!("[DEBUG] 窗口已设置为壁纸层（fallback: parent=shell_top, bottom）");
                return Ok(());
            }

            eprintln!(
                "[DEBUG] parent client rect ok rc=({}, {}, {}, {}), size={}x{}",
                rc.left, rc.top, rc.right, rc.bottom, w, h
            );

            SetWindowPos(
                tauri_hwnd,
                insert_after,
                0,
                0,
                w,
                h,
                SWP_NOACTIVATE | SWP_SHOWWINDOW,
            );
            ShowWindow(tauri_hwnd, SW_SHOW);
        }

        println!("[DEBUG] 窗口已设置为壁纸层（纯 Win32，无 PowerShell）");
        Ok(())
    }

    /// 调试：把 wallpaper 窗口从桌面层“临时脱离”，作为普通窗口弹出 3 秒，然后再挂回桌面层。
    /// 用于确认：窗口本身是否在渲染（以及是否能看到 debug 面板），从而把问题收敛为“挂载层级/可见性”。
    #[cfg(target_os = "windows")]
    pub fn debug_detach_popup_3s(window: &WebviewWindow) -> Result<(), String> {
        use windows_sys::Win32::Foundation::HWND;
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            GetWindowLongPtrW, IsWindow, SetParent, SetWindowLongPtrW, SetWindowPos, ShowWindow,
            GWL_EXSTYLE, GWL_STYLE, SWP_NOACTIVATE, SWP_SHOWWINDOW, SW_SHOW, WS_CHILD,
            WS_EX_NOACTIVATE, WS_POPUP,
        };

        let hwnd = window
            .hwnd()
            .map_err(|e| format!("无法获取壁纸窗口句柄(hwnd): {}", e))?;
        let hwnd: HWND = hwnd.0 as isize;

        const HWND_TOPMOST: HWND = -1;
        const HWND_NOTOPMOST: HWND = -2;

        unsafe {
            if IsWindow(hwnd) == 0 {
                return Err("debug_detach_popup_3s: hwnd 无效(IsWindow=0)".to_string());
            }

            // 1) 脱离桌面层（父窗口设为 NULL）
            let _prev = SetParent(hwnd, 0);

            // 2) 变成普通 popup（屏幕坐标系）
            let style = GetWindowLongPtrW(hwnd, GWL_STYLE) as isize;
            let new_style = (style & !(WS_CHILD as isize)) | (WS_POPUP as isize);
            SetWindowLongPtrW(hwnd, GWL_STYLE, new_style);

            // 允许激活/可见：去掉 NOACTIVATE（否则可能看不到/点不到）
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as isize;
            let new_ex = ex & !(WS_EX_NOACTIVATE as isize);
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, new_ex);

            // 3) 置顶弹出 3 秒
            SetWindowPos(
                hwnd,
                HWND_TOPMOST,
                50,
                50,
                900,
                600,
                SWP_NOACTIVATE | SWP_SHOWWINDOW,
            );
            ShowWindow(hwnd, SW_SHOW);
        }

        std::thread::sleep(std::time::Duration::from_secs(3));

        unsafe {
            // 退出 topmost
            let _ = SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOACTIVATE);
        }

        // 4) 尝试再挂回桌面层（失败也不影响“弹出可见”这个调试结论）
        if let Err(e) = Self::set_window_as_wallpaper(window) {
            eprintln!("[DEBUG] debug_detach_popup_3s: reattach failed: {}", e);
        }
        Ok(())
    }
}
