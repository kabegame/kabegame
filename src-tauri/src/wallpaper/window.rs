// 窗口壁纸模块 - 类似 Wallpaper Engine 的实现

use crate::settings::Settings;
use std::sync::{Condvar, Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

// 标记壁纸窗口是否已完全初始化（前端 DOM + Vue 组件 + 事件监听器都已就绪）
// 由 wallpaper_window_ready 命令设置为 true，并通过 notify_all 唤醒所有等待者
struct ReadyNotify {
    ready: Mutex<bool>,
    cv: Condvar,
}

static WALLPAPER_WINDOW_READY: OnceLock<ReadyNotify> = OnceLock::new();

fn ready_notify() -> &'static ReadyNotify {
    WALLPAPER_WINDOW_READY.get_or_init(|| ReadyNotify {
        ready: Mutex::new(false),
        cv: Condvar::new(),
    })
}

pub struct WallpaperWindow {
    window: WebviewWindow,
    app: AppHandle,
}

impl WallpaperWindow {
    pub fn new(app: AppHandle) -> Self {
        Self {
            window: app.get_webview_window("wallpaper").unwrap(),
            app,
        }
    }

    #[allow(dead_code)]
    pub fn sync_wallpaper(&self, image_path: &str) -> Result<(), String> {
        // 等待窗口完全初始化（前端 DOM + Vue 组件 + 事件监听器都已就绪）
        // 超时时间：最多等待 100 秒
        Self::wait_ready(std::time::Duration::from_secs(100))?;

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
        self.set_window_as_wallpaper()
            .map_err(|e| format!("设置窗口为壁纸层失败: {}", e))?;

        // 显示窗口
        self.window
            .show()
            .map_err(|e| format!("显示壁纸窗口失败: {}", e))?;
        Ok(())
    }

    /// 标记壁纸窗口已完全初始化（由 wallpaper_window_ready 命令调用）
    pub fn mark_ready() {
        let n = ready_notify();
        if let Ok(mut ready) = n.ready.lock() {
            *ready = true;
            n.cv.notify_all();
        } else {
            // poisoned，不阻断主流程
            n.cv.notify_all();
        }
    }

    /// 重置 ready 标记（窗口重新创建或隐藏时调用）
    #[allow(dead_code)]
    pub fn reset_ready() {
        let n = ready_notify();
        if let Ok(mut ready) = n.ready.lock() {
            *ready = false;
        }
    }

    /// 检查窗口是否已 ready
    #[allow(dead_code)]
    pub fn is_ready() -> bool {
        let n = ready_notify();
        n.ready.lock().map(|g| *g).unwrap_or(false)
    }

    /// 等待窗口 ready（用于 window_manager 在 set_wallpaper 时阻塞等待）
    pub fn wait_ready(timeout: std::time::Duration) -> Result<(), String> {
        let n = ready_notify();
        let guard = n
            .ready
            .lock()
            .map_err(|_| "WALLPAPER_WINDOW_READY mutex poisoned".to_string())?;

        if *guard {
            return Ok(());
        }

        let (guard, wait_res) =
            n.cv.wait_timeout_while(guard, timeout, |ready| !*ready)
                .map_err(|_| "WALLPAPER_WINDOW_READY condvar wait failed".to_string())?;

        if *guard {
            Ok(())
        } else if wait_res.timed_out() {
            Err("壁纸窗口初始化超时，放弃推送".to_string())
        } else {
            Err("壁纸窗口等待就绪失败".to_string())
        }
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
        self.set_window_as_wallpaper()
            .map_err(|e| format!("重新挂载窗口到桌面失败: {}", e))?;

        // 显示窗口
        self.window
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

    fn set_window_as_wallpaper(&self) -> Result<(), String> {
        use std::thread;
        use std::time::Duration;

        // 等待 wallpaper 窗口前端 ready（由 mark_ready() -> notify_all() 唤醒），
        // 避免靠固定 sleep 猜测窗口/DOM 初始化时机
        Self::wait_ready(Duration::from_secs(100))?;

        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Foundation::RECT;
        use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM};
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            EnumWindows, FindWindowExW, FindWindowW, GetClientRect, GetParent, GetSystemMetrics,
            GetWindowLongPtrW, GetWindowRect, IsWindow, IsWindowVisible, SendMessageTimeoutW,
            SendMessageW, SetParent, SetWindowLongPtrW, SetWindowPos, ShowWindow, GWL_EXSTYLE,
            GWL_STYLE, SMTO_ABORTIFHUNG, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
            SWP_SHOWWINDOW, SW_SHOW, WS_CHILD, WS_EX_NOACTIVATE, WS_EX_TRANSPARENT, WS_POPUP,
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
            // 关键：有些系统/桌面工具会让 Progman 里存在“隐藏的 DefView”，真正可见的图标宿主在某个 WorkerW。
            // 所以这里优先选择：包含 DefView 且“可见 + client rect/窗口矩形非零”的那个顶层窗口（通常是 WorkerW）。
            #[derive(Default)]
            struct Best {
                hwnd: HWND,
                area: i64,
                class_name: String,
                has_folder_view: bool,
            }

            unsafe extern "system" fn enum_find_best(hwnd: HWND, lparam: LPARAM) -> BOOL {
                let best = &mut *(lparam as *mut Best);

                let class_name = hwnd_class(hwnd);
                if class_name != "WorkerW" && class_name != "Progman" {
                    return 1;
                }

                let def_view =
                    FindWindowExW(hwnd, 0, wide("SHELLDLL_DefView").as_ptr(), std::ptr::null());
                if def_view == 0 {
                    return 1;
                }

                // 说明：IsWindowVisible 在某些壳层上不可靠（可能返回 0 但仍然是桌面层）。
                // 所以这里只用于“打日志/辅助判断”，不作为过滤条件。
                let _visible = IsWindowVisible(hwnd) != 0;

                // 用窗口矩形评估面积（更能过滤“client=0 但仍存在句柄”的假窗口）
                let mut rc = std::mem::zeroed();
                if GetWindowRect(hwnd, &mut rc) == 0 {
                    return 1;
                }
                let w = rc.right - rc.left;
                let h = rc.bottom - rc.top;
                if w <= 0 || h <= 0 {
                    return 1;
                }
                let area = (w as i64) * (h as i64);

                // FolderView (SysListView32) 存在通常意味着这里就是“真正的桌面图标视图”
                let folder_view = FindWindowExW(
                    def_view,
                    0,
                    wide("SysListView32").as_ptr(),
                    std::ptr::null(),
                );
                let has_folder_view = folder_view != 0;

                // 选择策略：
                // 1) 优先 has_folder_view=true（更可能是真图标宿主）
                // 2) 再按 area 最大
                let better = if has_folder_view && !best.has_folder_view {
                    true
                } else if has_folder_view == best.has_folder_view && area > best.area {
                    true
                } else {
                    false
                };

                if better {
                    best.area = area;
                    best.hwnd = hwnd;
                    best.class_name = class_name;
                    best.has_folder_view = has_folder_view;
                }
                1
            }

            let mut best = Best::default();
            EnumWindows(Some(enum_find_best), (&mut best as *mut Best) as isize);

            if best.hwnd != 0 {
                eprintln!(
                    "[DEBUG] shell_top selected hwnd={} class={} area={} has_folder_view={}",
                    best.hwnd, best.class_name, best.area, best.has_folder_view
                );
                return Ok(best.hwnd);
            }

            // 兜底：如果没找到“可见”的，再退回 Progman（兼容极端壳层）
            let def_view = FindWindowExW(
                progman,
                0,
                wide("SHELLDLL_DefView").as_ptr(),
                std::ptr::null(),
            );
            if def_view != 0 {
                eprintln!("[DEBUG] shell_top fallback to Progman");
                return Ok(progman);
            }

            Err(
                "找不到桌面图标宿主（未在可见的 WorkerW/Progman 顶层窗口中发现 SHELLDLL_DefView）"
                    .to_string(),
            )
        }

        /// 只在 “shell_top(含 DefView) 之后的 Z 序链” 上找 WorkerW。
        /// 这是经典 Wallpaper Engine 路径：把壁纸挂到 DefView 后面的 WorkerW，天然在图标下面。
        unsafe fn find_workerw_behind_shell_top(shell_top: HWND) -> Option<HWND> {
            let mut after = shell_top;
            loop {
                let w = FindWindowExW(0, after, wide("WorkerW").as_ptr(), std::ptr::null());
                if w == 0 {
                    return None;
                }

                // 跳过包含 DefView 的 WorkerW（那是图标宿主或其同层）
                let def_view =
                    FindWindowExW(w, 0, wide("SHELLDLL_DefView").as_ptr(), std::ptr::null());
                if def_view == 0 {
                    // 只接受 client rect 有效的 WorkerW，避免 0 高度导致“挂载成功但不可见/裁剪”
                    let mut rc: RECT = std::mem::zeroed();
                    if GetClientRect(w, &mut rc as *mut RECT) != 0 {
                        let ww = rc.right - rc.left;
                        let hh = rc.bottom - rc.top;
                        if ww > 0 && hh > 0 {
                            return Some(w);
                        }
                    }
                }

                after = w;
            }
        }

        /// 如果图标宿主是 Progman，则优先使用“Progman 后面的第一个 WorkerW”作为壁纸宿主。
        /// 这条路径在 Win11 上更稳：壁纸挂在 WorkerW，图标仍在 Progman 上层，避免 WebView2 覆盖图标层。
        unsafe fn find_workerw_after(hwnd: HWND) -> Option<HWND> {
            let w = FindWindowExW(0, hwnd, wide("WorkerW").as_ptr(), std::ptr::null());
            if w != 0 {
                Some(w)
            } else {
                None
            }
        }

        /// 枚举所有顶层 WorkerW，选择一个“不包含 DefView”的作为壁纸宿主。
        /// 解决某些 Win11 壳层上 WorkerW 不在 Progman “后面”导致 FindWindowExW 找不到的问题。
        unsafe fn find_any_workerw_without_defview() -> Option<HWND> {
            #[derive(Default)]
            struct Best {
                hwnd: HWND,
                area: i64,
            }

            unsafe extern "system" fn enum_pick(hwnd: HWND, lparam: LPARAM) -> BOOL {
                let best = &mut *(lparam as *mut Best);
                if hwnd_class(hwnd) != "WorkerW" {
                    return 1;
                }
                let def_view =
                    FindWindowExW(hwnd, 0, wide("SHELLDLL_DefView").as_ptr(), std::ptr::null());
                if def_view != 0 {
                    return 1;
                }
                let mut rc = std::mem::zeroed();
                if GetWindowRect(hwnd, &mut rc) == 0 {
                    return 1;
                }
                let w = rc.right - rc.left;
                let h = rc.bottom - rc.top;
                if w <= 0 || h <= 0 {
                    return 1;
                }
                let area = (w as i64) * (h as i64);
                if area > best.area {
                    best.area = area;
                    best.hwnd = hwnd;
                }
                1
            }

            let mut best = Best::default();
            EnumWindows(Some(enum_pick), (&mut best as *mut Best) as isize);
            if best.hwnd != 0 {
                Some(best.hwnd)
            } else {
                None
            }
        }

        unsafe fn dump_desktop_toplevel_windows() {
            unsafe extern "system" fn enum_dump(hwnd: HWND, _lparam: LPARAM) -> BOOL {
                let class_name = hwnd_class(hwnd);
                if class_name != "WorkerW" && class_name != "Progman" {
                    return 1;
                }
                let def_view =
                    FindWindowExW(hwnd, 0, wide("SHELLDLL_DefView").as_ptr(), std::ptr::null());
                let folder_view = if def_view != 0 {
                    FindWindowExW(
                        def_view,
                        0,
                        wide("SysListView32").as_ptr(),
                        std::ptr::null(),
                    )
                } else {
                    0
                };
                let mut rc = std::mem::zeroed();
                let ok = GetWindowRect(hwnd, &mut rc);
                let w = rc.right - rc.left;
                let h = rc.bottom - rc.top;
                eprintln!(
                    "[DEBUG] desktop top hwnd={} class={} vis={} rect_ok={} rect=({}, {}, {}, {}) size={}x{} has_defview={} has_folder_view={}",
                    hwnd,
                    class_name,
                    IsWindowVisible(hwnd),
                    ok,
                    rc.left, rc.top, rc.right, rc.bottom,
                    w, h,
                    def_view != 0,
                    folder_view != 0
                );
                1
            }
            EnumWindows(Some(enum_dump), 0);
        }

        let tauri_hwnd = self
            .window
            .hwnd()
            .map_err(|e| format!("无法获取壁纸窗口句柄(hwnd): {}", e))?;
        let tauri_hwnd: HWND = tauri_hwnd.0 as isize;

        unsafe {
            let progman = FindWindowW(wide("Progman").as_ptr(), std::ptr::null());
            if progman == 0 {
                return Err("FindWindowW(Progman) failed".to_string());
            }

            // 促使生成 WorkerW（不同实现对 wParam 取值不一致：0 / 0xD 都有人用）
            let mut _result: usize = 0;
            let _ = SendMessageTimeoutW(
                progman,
                0x052C,
                0,
                0,
                SMTO_ABORTIFHUNG,
                1000,
                &mut _result as *mut usize,
            );
            let _ = SendMessageTimeoutW(
                progman,
                0x052C,
                0xD,
                0,
                SMTO_ABORTIFHUNG,
                1000,
                &mut _result as *mut usize,
            );

            // 查找 shell_top 并尽量找到其后的 WorkerW
            let mut parent: HWND = 0;
            let mut shell_top: HWND = 0;
            let mut last_err: Option<String> = None;
            // 如果我们强制把某个 WorkerW 拉满屏幕，这里记录目标尺寸，避免后续 GetClientRect 仍返回旧的 198x56
            let mut forced_parent_wh: Option<(i32, i32)> = None;
            for _ in 0..60 {
                match find_shell_top(progman) {
                    Ok(top) => {
                        shell_top = top;
                        // 优先：如果 shell_top 本身就是 Progman（你的环境），则尽量把壁纸挂到 Progman 后面的 WorkerW。
                        // 这是经典“壁纸层”窗口，能让图标层天然在上面。
                        let shell_top_class = hwnd_class(shell_top);
                        if shell_top_class == "Progman" {
                            // Win11 某些桌面结构：图标确实在 Progman(DefView/FolderView)，而 WorkerW 永远在 Progman 之上且无法被压下去。
                            // 这时把“壁纸(不透明 WebView2)”挂到 WorkerW 会导致图标整层不可见（你当前遇到的现象）。
                            // 在无法可靠解决顶层 Z 序的前提下，直接判定 window 模式不兼容，交给上层回退到 native。
                            //
                            // 如需强行继续尝试（可能导致图标不可见），设置环境变量：KABEGAMI_FORCE_WORKERW=1
                            if std::env::var("KABEGAMI_FORCE_WORKERW")
                                .ok()
                                .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
                                != Some(true)
                            {
                                let def_view = FindWindowExW(
                                    shell_top,
                                    0,
                                    wide("SHELLDLL_DefView").as_ptr(),
                                    std::ptr::null(),
                                );
                                let folder_view = if def_view != 0 {
                                    FindWindowExW(
                                        def_view,
                                        0,
                                        wide("SysListView32").as_ptr(),
                                        std::ptr::null(),
                                    )
                                } else {
                                    0
                                };
                                if def_view != 0 && folder_view != 0 {
                                    return Err("Win11 桌面结构检测：图标宿主在 Progman，使用 WorkerW 作为壁纸层会导致图标不可见；已阻止 window 模式并建议回退到 native。可设置环境变量 KABEGAMI_FORCE_WORKERW=1 强行尝试（不推荐）".to_string());
                                }
                            }

                            parent = find_workerw_after(shell_top).unwrap_or(0);
                            if parent != 0 {
                                eprintln!(
                                    "[DEBUG] using workerw_after_progman as parent: {}",
                                    parent
                                );
                            }
                            // 某些系统里 WorkerW 不在 Progman 后面：改为全局枚举一个可用 WorkerW
                            if parent == 0 {
                                parent = find_any_workerw_without_defview().unwrap_or(0);
                                if parent != 0 {
                                    eprintln!(
                                        "[DEBUG] using workerw_any_no_defview as parent: {}",
                                        parent
                                    );
                                } else {
                                    eprintln!("[DEBUG] no WorkerW(no DefView) found, fallback to shell_top");
                                }
                            }
                        }
                        // 否则走常规：在 shell_top 之后找 WorkerW（不含 DefView）
                        if parent == 0 {
                            parent = find_workerw_behind_shell_top(shell_top).unwrap_or(shell_top);
                        }
                        break;
                    }
                    Err(e) => {
                        last_err = Some(e);
                        thread::sleep(Duration::from_millis(100));
                    }
                }
            }
            if parent == 0 {
                return Err(format!(
                    "查找桌面承载窗口失败: {}",
                    last_err.unwrap_or_else(|| "unknown".to_string())
                ));
            }

            if IsWindow(tauri_hwnd) == 0 {
                return Err("Tauri wallpaper hwnd is invalid (IsWindow=0)".to_string());
            }
            if IsWindow(parent) == 0 {
                return Err("Parent hwnd is invalid (IsWindow=0)".to_string());
            }

            // Win11 上：只要 parent 是 WorkerW（壁纸层），就无条件把它铺满虚拟屏幕并 show。
            // 否则经常出现“WorkerW 尺寸/裁剪不一致 -> 壁纸区域外黑底”的情况。
            {
                let parent_class = hwnd_class(parent);
                if parent_class == "WorkerW" && parent != shell_top {
                    // 用虚拟屏幕尺寸（多显示器更稳）
                    // SM_XVIRTUALSCREEN=76, SM_YVIRTUALSCREEN=77, SM_CXVIRTUALSCREEN=78, SM_CYVIRTUALSCREEN=79
                    let vx = GetSystemMetrics(76);
                    let vy = GetSystemMetrics(77);
                    let sw = GetSystemMetrics(78);
                    let sh = GetSystemMetrics(79);

                    let mut rcw: RECT = std::mem::zeroed();
                    let ok = GetClientRect(parent, &mut rcw as *mut RECT);
                    let pw = if ok != 0 { rcw.right - rcw.left } else { -1 };
                    let ph = if ok != 0 { rcw.bottom - rcw.top } else { -1 };
                    eprintln!(
                        "[DEBUG] parent WorkerW {} client before resize ok={} size={}x{}, target virtual={}x{} at ({}, {})",
                        parent, ok, pw, ph, sw, sh, vx, vy
                    );

                    const HWND_BOTTOM: HWND = 1;
                    SetWindowPos(
                        parent,
                        HWND_BOTTOM,
                        vx,
                        vy,
                        sw,
                        sh,
                        SWP_NOACTIVATE | SWP_SHOWWINDOW,
                    );
                    ShowWindow(parent, SW_SHOW);
                    forced_parent_wh = Some((sw, sh));
                    eprintln!(
                        "[DEBUG] resized/showed parent WorkerW {} to {}x{} at ({}, {})",
                        parent, sw, sh, vx, vy
                    );
                }
            }

            // 变成子窗口
            let style = GetWindowLongPtrW(tauri_hwnd, GWL_STYLE) as isize;
            let new_style = (style & !(WS_POPUP as isize)) | (WS_CHILD as isize);
            SetWindowLongPtrW(tauri_hwnd, GWL_STYLE, new_style);

            // 挂载
            // 注意：SetParent 返回“旧父窗口”，旧父窗口可能为 NULL（顶层窗口），此时返回 0 仍可能是成功。
            // 所以这里用 GetParent 校验结果，避免误报。
            let _old_parent = SetParent(tauri_hwnd, parent);
            if GetParent(tauri_hwnd) != parent {
                let err = windows_sys::Win32::Foundation::GetLastError();
                return Err(format!(
                    "SetParent failed (GetParent mismatch). GetLastError={}",
                    err
                ));
            }

            // 不抢焦点 + 鼠标穿透（避免壁纸窗口抢占桌面图标/桌面工具的点击）
            // 注意：这会使壁纸窗口“不可交互”，但本项目窗口模式主要用于展示图片壁纸，这是期望行为。
            let ex = GetWindowLongPtrW(tauri_hwnd, GWL_EXSTYLE) as isize;
            let new_ex = ex | (WS_EX_NOACTIVATE as isize) | (WS_EX_TRANSPARENT as isize);
            SetWindowLongPtrW(tauri_hwnd, GWL_EXSTYLE, new_ex);

            // 输出 debug
            {
                let parent_class = hwnd_class(parent);
                let shell_top_class = hwnd_class(shell_top);
                eprintln!(
                    "[DEBUG] wallpaper parent hwnd={} class={} shell_top={} shell_top_class={} progman={}",
                    parent, parent_class, shell_top, shell_top_class, progman
                );
                if parent == shell_top {
                    dump_desktop_toplevel_windows();
                }
            }

            // 计算 parent client rect 并铺满（child 坐标系）
            let mut rc: RECT = std::mem::zeroed();
            let ok = GetClientRect(parent, &mut rc as *mut RECT);
            let mut w = 0;
            let mut h = 0;
            if ok != 0 {
                w = rc.right - rc.left;
                h = rc.bottom - rc.top;
            }

            // 子窗口尺寸策略：
            // - parent 是 WorkerW：无条件用虚拟屏幕尺寸铺满（避免黑底/黑边）
            // - 否则按 client rect / 虚拟屏幕兜底
            let parent_class = hwnd_class(parent);
            if parent_class == "WorkerW" && parent != shell_top {
                let (sw, sh) =
                    forced_parent_wh.unwrap_or((GetSystemMetrics(78), GetSystemMetrics(79)));
                w = sw;
                h = sh;
                eprintln!(
                    "[DEBUG] force wallpaper child size to {}x{} (parent client ok={} was {}x{})",
                    w,
                    h,
                    ok,
                    rc.right - rc.left,
                    rc.bottom - rc.top
                );
            } else {
                // 否则：如果 parent client rect 仍明显偏小，也用虚拟屏幕兜底（避免黑边）
                let sw = GetSystemMetrics(78);
                let sh = GetSystemMetrics(79);
                if ok == 0 || w <= 0 || h <= 0 || (w < (sw * 3 / 4) || h < (sh * 3 / 4)) {
                    w = sw;
                    h = sh;
                }
            }

            // Z序策略（更硬、更稳定）：
            // 1) 壁纸窗口永远放到同父窗口的最底层
            // 2) 如果 parent==shell_top（你这台机子是 Progman），则把 DefView 和 SysListView32 都显式抬到最上，
            //    彻底避免“图标整层被 webview 合成层压没”的情况。
            const HWND_BOTTOM: HWND = 1;
            const HWND_TOP: HWND = 0;

            SetWindowPos(
                tauri_hwnd,
                HWND_BOTTOM,
                0,
                0,
                w,
                h,
                SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_FRAMECHANGED,
            );
            ShowWindow(tauri_hwnd, SW_SHOW);

            // Win11 + WebView2 场景：即便壁纸挂到 WorkerW，仍可能因为顶层 Z 序/壳层干预导致图标层被压在下面。
            // 这里在 parent 为 WorkerW 时，显式把 Progman/DefView/FolderView 提到 WorkerW 之上（不激活），确保图标可见。
            {
                let parent_class = hwnd_class(parent);
                if parent_class == "WorkerW" && parent != shell_top {
                    const HWND_TOP: HWND = 0;
                    const WM_PAINT: u32 = 0x000F;
                    const WM_NCPAINT: u32 = 0x0085;

                    // 关键：顶层窗口 Z 序钉死
                    // - WorkerW 做壁纸层：永远放到最底（顶层）
                    // - Progman(图标宿主)：永远放到最顶（顶层）
                    // 否则即便 DefView/FolderView 在 Progman 内部置顶，整个 Progman 仍可能被 WorkerW 覆盖导致“图标不可见”。
                    SetWindowPos(
                        parent,
                        HWND_BOTTOM,
                        0,
                        0,
                        0,
                        0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                    );
                    SetWindowPos(
                        shell_top,
                        HWND_TOP,
                        0,
                        0,
                        0,
                        0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                    );

                    ShowWindow(shell_top, SW_SHOW);
                    SetWindowPos(
                        shell_top,
                        HWND_TOP,
                        0,
                        0,
                        0,
                        0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                    );

                    let def_view = FindWindowExW(
                        shell_top,
                        0,
                        wide("SHELLDLL_DefView").as_ptr(),
                        std::ptr::null(),
                    );
                    if def_view != 0 && IsWindow(def_view) != 0 {
                        ShowWindow(def_view, SW_SHOW);
                        SetWindowPos(
                            def_view,
                            HWND_TOP,
                            0,
                            0,
                            0,
                            0,
                            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                        );

                        let folder_view = FindWindowExW(
                            def_view,
                            0,
                            wide("SysListView32").as_ptr(),
                            std::ptr::null(),
                        );
                        if folder_view != 0 && IsWindow(folder_view) != 0 {
                            ShowWindow(folder_view, SW_SHOW);
                            SetWindowPos(
                                folder_view,
                                HWND_TOP,
                                0,
                                0,
                                0,
                                0,
                                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                            );
                        }

                        // 触发一次重绘，避免“Z序对了但没刷新”
                        let _ = SendMessageW(shell_top, WM_NCPAINT, 0, 0);
                        let _ = SendMessageW(shell_top, WM_PAINT, 0, 0);
                        let _ = SendMessageW(def_view, WM_NCPAINT, 0, 0);
                        let _ = SendMessageW(def_view, WM_PAINT, 0, 0);
                        if folder_view != 0 {
                            let _ = SendMessageW(folder_view, WM_NCPAINT, 0, 0);
                            let _ = SendMessageW(folder_view, WM_PAINT, 0, 0);
                        }
                    }

                    eprintln!("[DEBUG] bumped shell_top/DefView above WorkerW wallpaper parent");
                    eprintln!("[DEBUG] forced top-level z-order: WorkerW->BOTTOM, Progman->TOP");
                }
            }

            // 关键补偿：仅当 parent==shell_top 时（我们不得不挂到图标宿主），才尝试抬升图标层。
            // 如果 parent 是 WorkerW（推荐路径），图标不在此父窗口下，没必要也不应该动它。
            if parent == shell_top {
                let def_view = FindWindowExW(
                    shell_top,
                    0,
                    wide("SHELLDLL_DefView").as_ptr(),
                    std::ptr::null(),
                );
                if def_view != 0 && IsWindow(def_view) != 0 {
                    // 一些壳层/桌面工具会让 DefView 处于隐藏/未重绘状态；这里强制显示并重绘一次
                    ShowWindow(def_view, SW_SHOW);

                    SetWindowPos(
                        def_view,
                        HWND_TOP,
                        0,
                        0,
                        0,
                        0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                    );

                    let folder_view = FindWindowExW(
                        def_view,
                        0,
                        wide("SysListView32").as_ptr(),
                        std::ptr::null(),
                    );
                    if folder_view != 0 && IsWindow(folder_view) != 0 {
                        ShowWindow(folder_view, SW_SHOW);
                        SetWindowPos(
                            folder_view,
                            HWND_TOP,
                            0,
                            0,
                            0,
                            0,
                            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                        );
                    }

                    // 强制刷新：用 WM_PAINT/WM_NCPAINT 触发重绘（不依赖额外 windows-sys feature）
                    const WM_PAINT: u32 = 0x000F;
                    const WM_NCPAINT: u32 = 0x0085;
                    let _ = SendMessageW(shell_top, WM_NCPAINT, 0, 0);
                    let _ = SendMessageW(shell_top, WM_PAINT, 0, 0);
                    let _ = SendMessageW(def_view, WM_NCPAINT, 0, 0);
                    let _ = SendMessageW(def_view, WM_PAINT, 0, 0);
                    if folder_view != 0 {
                        let _ = SendMessageW(folder_view, WM_NCPAINT, 0, 0);
                        let _ = SendMessageW(folder_view, WM_PAINT, 0, 0);
                    }
                } else {
                    eprintln!("[DEBUG] parent==shell_top but DefView not found under shell_top");
                }
            }
        }

        println!("[DEBUG] 窗口已设置为壁纸层（纯 Win32，无 PowerShell）");
        Ok(())
    }
}
