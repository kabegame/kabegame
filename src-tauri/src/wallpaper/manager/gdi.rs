// GDI 壁纸管理器 - 使用纯 Win32 窗口 + GDI 渲染壁纸

use super::WallpaperManager;
use crate::settings::Settings;
use crate::wallpaper::gdi_renderer::GdiWallpaperRenderer;
use crate::wallpaper::window_mount;
use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{GetDC, ReleaseDC};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetClientRect, GetMessageW, GetParent,
    GetWindowLongPtrW, IsWindow, PeekMessageW, PostMessageW, PostQuitMessage, RegisterClassExW,
    SetWindowLongPtrW, SetWindowPos, ShowWindow, TranslateMessage, UnregisterClassW, CS_HREDRAW,
    CS_VREDRAW, GWLP_USERDATA, GWL_EXSTYLE, MSG, PM_REMOVE, SWP_NOACTIVATE, SWP_SHOWWINDOW,
    SW_SHOW, WM_CREATE, WM_DESTROY, WM_PAINT, WNDCLASSEXW, WS_EX_NOACTIVATE, WS_POPUP, WS_VISIBLE,
};

/// GDI 壁纸窗口（内部使用）
struct GdiWallpaperWindow {
    hwnd: HWND,
    renderer: Arc<Mutex<GdiWallpaperRenderer>>,
    message_thread_handle: Option<std::thread::JoinHandle<()>>,
    should_quit: Arc<AtomicBool>, // 用于通知线程退出的标志
}

impl GdiWallpaperWindow {
    /// 创建一个新的 GDI 壁纸窗口
    fn new() -> Result<Self, String> {
        unsafe {
            fn wide(s: &str) -> Vec<u16> {
                OsStr::new(s).encode_wide().chain(Some(0)).collect()
            }

            const CLASS_NAME: &str = "KabegamiGdiWallpaper";

            // 先尝试注销窗口类（如果存在），然后重新注册
            // 这样可以确保窗口类状态是干净的
            let class_name_wide = wide(CLASS_NAME);

            // 尝试注销窗口类（如果不存在，会返回错误，我们可以忽略）
            unsafe {
                let _ = UnregisterClassW(class_name_wide.as_ptr(), 0);
            }

            // 重新注册窗口类
            // 注意：hCursor 必须设置为有效的光标句柄，0 可能导致 CreateWindowExW 失败
            use windows_sys::Win32::UI::WindowsAndMessaging::{LoadCursorW, IDC_ARROW};
            let hcursor = LoadCursorW(0, IDC_ARROW);

            let wc = WNDCLASSEXW {
                cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                style: CS_HREDRAW | CS_VREDRAW,
                lpfnWndProc: Some(window_proc),
                cbClsExtra: 0,
                cbWndExtra: 0,
                hInstance: 0, // 0 表示使用当前模块
                hIcon: 0,
                hCursor: hcursor, // 使用默认箭头光标
                hbrBackground: 0, // 0 = NULL_BRUSH，背景不填充，由我们的绘制代码处理
                lpszMenuName: std::ptr::null(),
                lpszClassName: class_name_wide.as_ptr(),
                hIconSm: 0,
            };

            let class_atom = RegisterClassExW(&wc);
            if class_atom == 0 {
                let err = windows_sys::Win32::Foundation::GetLastError();
                eprintln!(
                    "[ERROR] RegisterClassExW failed with error code: {} (类名: {})",
                    err, CLASS_NAME
                );
                return Err(format!(
                    "窗口类注册失败，错误码: {} (类名: {})",
                    err, CLASS_NAME
                ));
            } else {
                eprintln!(
                    "[INFO] 窗口类 {} 注册成功，atom: {}",
                    CLASS_NAME, class_atom
                );
            }

            // 创建窗口（先作为顶层窗口创建，后面会被 SetParent 到桌面层）
            // 注意：如果使用 WS_CHILD，必须提供有效的父窗口句柄，否则 CreateWindowExW 会失败
            // 所以我们先用 WS_POPUP 创建顶层窗口，后面 SetParent 时会自动变成子窗口
            // 注意：WS_POPUP 窗口的父窗口必须为 NULL，否则 CreateWindowExW 可能失败
            eprintln!("[DEBUG] 准备创建窗口，类名: {}", CLASS_NAME);

            // 在创建窗口之前清除错误码，以便准确获取 CreateWindowExW 的错误
            use windows_sys::Win32::Foundation::SetLastError;
            unsafe {
                SetLastError(0);
            }

            // 创建窗口时不使用 WS_VISIBLE，先隐藏窗口，避免在挂载前显示（造成"窗口闪过"）
            // 挂载到桌面后再显示窗口
            let hwnd = CreateWindowExW(
                WS_EX_NOACTIVATE,
                class_name_wide.as_ptr(),
                std::ptr::null(),
                WS_POPUP, // 不使用 WS_VISIBLE，先隐藏窗口
                0,
                0,
                100,
                100,                  // 临时大小，挂载到桌面后会调整
                0 as HWND,            // NULL - WS_POPUP 窗口不应该有父窗口
                0,                    // hMenu (HMENU)
                0,                    // hInstance - 0 表示使用当前模块
                std::ptr::null_mut(), // lpParam
            );

            if hwnd == 0 {
                let err = windows_sys::Win32::Foundation::GetLastError();
                eprintln!("[ERROR] CreateWindowExW failed:");
                eprintln!(
                    "  - 错误码: {} (0 表示没有错误码，可能是窗口过程函数或其他问题)",
                    err
                );
                eprintln!("  - 窗口类: {}", CLASS_NAME);
                eprintln!("  - 扩展样式: WS_EX_NOACTIVATE ({})", WS_EX_NOACTIVATE);
                eprintln!(
                    "  - 窗口样式: WS_VISIBLE | WS_POPUP ({})",
                    WS_VISIBLE | WS_POPUP
                );
                eprintln!("  - 父窗口: NULL (WS_POPUP 窗口不需要父窗口)");
                eprintln!("  - hInstance: 0 (当前模块)");
                eprintln!("  - 窗口类应该已经注册（如果 RegisterClassExW 失败会在前面报告）");

                // 如果错误码是 0，可能是窗口过程函数的问题
                if err == 0 {
                    eprintln!("  - 警告: 错误码为 0，可能是窗口过程函数签名或实现有问题");
                }

                return Err(format!(
                    "CreateWindowExW failed with error code: {} (窗口类: {})",
                    err, CLASS_NAME
                ));
            }

            eprintln!("[DEBUG] 窗口创建成功，HWND: {}", hwnd);

            // 创建渲染器实例
            let renderer = Arc::new(Mutex::new(GdiWallpaperRenderer::new(hwnd)));

            // 将 renderer 指针存储到窗口的 USERDATA 中（用于在 window_proc 中访问）
            // 使用 Box::into_raw 创建一个堆上的 Arc 副本，这样 Arc 不会被自动释放
            // 注意：Arc::into_raw 返回的是指向内部值（Mutex）的指针，而不是指向 Arc 的指针
            // 所以我们需要使用 Box 来创建一个指向 Arc 的指针
            let renderer_box = Box::into_raw(Box::new(Arc::clone(&renderer)));
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, renderer_box as isize);

            // 挂载到桌面层（使用 saikyo 版本，支持 Windows 11）
            window_mount::mount_to_desktop_saikyo(hwnd)?;

            eprintln!("[DEBUG] 窗口挂载完成");

            // 挂载完成后，显示窗口并确保窗口样式正确
            unsafe {
                // 确保窗口可见
                ShowWindow(hwnd, SW_SHOW);

                // 添加额外的窗口样式来防止系统关闭窗口
                // WS_EX_TOOLWINDOW: 防止窗口出现在任务栏和 Alt+Tab 列表中
                // 这对于壁纸窗口很重要，可以防止系统将其识别为普通应用窗口
                use windows_sys::Win32::UI::WindowsAndMessaging::WS_EX_TOOLWINDOW;
                let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
                let new_ex_style = ex_style | WS_EX_TOOLWINDOW;
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, new_ex_style as isize);

                eprintln!("[DEBUG] 窗口已显示并设置保护样式");
            }

            // 创建共享的退出标志
            let should_quit = Arc::new(AtomicBool::new(false));
            let should_quit_clone = Arc::clone(&should_quit);

            // 在单独线程中运行消息循环
            // 注意：PostQuitMessage 必须从消息循环所在的线程调用，所以我们在 WM_DESTROY 中处理
            // 注意：GetMessageW 的第二个参数应该是 HWND(0) 来接收所有消息，而不是特定窗口
            let message_thread_handle = std::thread::spawn(move || {
                unsafe {
                    use windows_sys::Win32::System::Threading::GetCurrentThreadId;
                    let thread_id = GetCurrentThreadId();
                    eprintln!(
                        "[DEBUG] GdiWallpaperWindow: 消息循环线程启动，线程 ID: {}",
                        thread_id
                    );
                    let mut msg: MSG = std::mem::zeroed();
                    loop {
                        // 检查退出标志
                        if should_quit_clone.load(Ordering::Relaxed) {
                            eprintln!(
                                "[DEBUG] GdiWallpaperWindow: 收到退出标志，调用 PostQuitMessage(0)"
                            );
                            PostQuitMessage(0);
                            break;
                        }

                        // 使用 PeekMessageW 来非阻塞地检查消息，这样我们可以定期检查退出标志
                        use windows_sys::Win32::UI::WindowsAndMessaging::{
                            PeekMessageW, PM_REMOVE,
                        };
                        let has_msg = PeekMessageW(&mut msg, 0, 0, 0, PM_REMOVE) != 0;

                        if has_msg {
                            if msg.message == 0x0012 {
                                // WM_QUIT
                                eprintln!("[DEBUG] GdiWallpaperWindow: 消息循环收到 WM_QUIT，退出");
                                break;
                            } else {
                                TranslateMessage(&msg);
                                DispatchMessageW(&msg);
                            }
                        } else {
                            // 没有消息，短暂休眠以避免 CPU 占用过高，然后继续检查退出标志
                            std::thread::sleep(std::time::Duration::from_millis(10));
                        }
                    }
                    eprintln!("[DEBUG] GdiWallpaperWindow: 消息循环线程退出");
                }
            });

            Ok(Self {
                hwnd,
                renderer,
                message_thread_handle: Some(message_thread_handle),
                should_quit,
            })
        }
    }

    /// 设置要显示的图片
    fn set_image(&self, image_path: &str) -> Result<(), String> {
        eprintln!("[DEBUG] GdiWallpaperWindow::set_image 开始: {}", image_path);
        let mut renderer = self
            .renderer
            .lock()
            .map_err(|e| format!("获取渲染器锁失败: {}", e))?;
        eprintln!("[DEBUG] 开始加载图片...");
        renderer.set_image(image_path).map_err(|e| {
            eprintln!("[ERROR] 渲染器加载图片失败: {}", e);
            e
        })?;
        eprintln!("[DEBUG] 图片加载完成");
        drop(renderer);

        // 确保窗口可见并触发重绘
        unsafe {
            // 直接使用窗口句柄，不检查 IsWindow（跨线程可能不可靠）
            ShowWindow(self.hwnd, SW_SHOW);
            eprintln!("[DEBUG] 窗口已显示");

            // 强制刷新窗口位置和大小
            use windows_sys::Win32::UI::WindowsAndMessaging::SWP_FRAMECHANGED;
            let parent = GetParent(self.hwnd);
            if parent != 0 {
                let mut rc: windows_sys::Win32::Foundation::RECT = std::mem::zeroed();
                if GetClientRect(parent, &mut rc as *mut windows_sys::Win32::Foundation::RECT) != 0
                {
                    let w = rc.right - rc.left;
                    let h = rc.bottom - rc.top;
                    if w > 0 && h > 0 {
                        SetWindowPos(
                            self.hwnd,
                            0 as HWND,
                            0,
                            0,
                            w,
                            h,
                            SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_FRAMECHANGED,
                        );
                        eprintln!("[DEBUG] set_image: 已更新窗口大小和位置: {}x{}", w, h);
                    }
                }
            }
        }

        // 触发重绘（这会直接绘制）
        self.invalidate();
        eprintln!("[DEBUG] GdiWallpaperWindow::set_image 完成");
        Ok(())
    }

    /// 设置显示样式（fill/fit/stretch/center/tile）
    fn set_style(&self, style: &str) -> Result<(), String> {
        let mut renderer = self
            .renderer
            .lock()
            .map_err(|e| format!("获取渲染器锁失败: {}", e))?;
        renderer.set_style(style);
        drop(renderer);
        self.invalidate();
        Ok(())
    }

    /// 获取窗口句柄
    fn hwnd(&self) -> HWND {
        self.hwnd
    }

    /// 触发窗口重绘
    fn invalidate(&self) {
        eprintln!(
            "[DEBUG] GdiWallpaperWindow::invalidate: 开始，hwnd: {}",
            self.hwnd
        );
        unsafe {
            // 先检查窗口是否有效
            if IsWindow(self.hwnd) == 0 {
                eprintln!(
                    "[WARN] GdiWallpaperWindow::invalidate: 窗口句柄无效 (hwnd={}), 跳过重绘",
                    self.hwnd
                );
                return;
            }

            // 确保窗口可见
            ShowWindow(self.hwnd, SW_SHOW);

            // 直接获取 DC 并绘制（在锁外快速获取 DC，然后在锁内绘制，减少锁持有时间）
            let hdc = GetDC(self.hwnd);
            if hdc != 0 {
                // 获取渲染器锁并绘制
                let renderer = self.renderer.lock();
                if let Ok(renderer_guard) = renderer {
                    eprintln!("[DEBUG] GdiWallpaperWindow::invalidate: 获取 DC 成功，直接绘制");
                    let paint_result = renderer_guard.paint(hdc);
                    if paint_result.is_err() {
                        eprintln!(
                            "[ERROR] GdiWallpaperWindow::invalidate: paint 失败: {:?}",
                            paint_result
                        );
                    } else {
                        eprintln!("[DEBUG] GdiWallpaperWindow::invalidate: paint 成功");
                    }
                } else {
                    eprintln!("[ERROR] GdiWallpaperWindow::invalidate: 无法获取 renderer 锁");
                }
                ReleaseDC(self.hwnd, hdc);
            } else {
                let err = windows_sys::Win32::Foundation::GetLastError();
                eprintln!(
                    "[ERROR] GdiWallpaperWindow::invalidate: GetDC 失败，错误码: {}",
                    err
                );
            }
        }
        eprintln!("[DEBUG] GdiWallpaperWindow::invalidate: 完成");
    }
}

impl Drop for GdiWallpaperWindow {
    fn drop(&mut self) {
        eprintln!(
            "[DEBUG] GdiWallpaperWindow::Drop: 开始销毁窗口，HWND: {}",
            self.hwnd
        );
        unsafe {
            use windows_sys::Win32::UI::WindowsAndMessaging::{
                DestroyWindow, GetWindowLongPtrW, PostQuitMessage,
            };

            // 先清理 USERDATA 中的 Box 指针（在窗口销毁前）
            // 我们使用 Box::into_raw 创建了一个堆上的 Arc，需要手动释放
            if IsWindow(self.hwnd) != 0 {
                eprintln!("[DEBUG] GdiWallpaperWindow::Drop: 清理 USERDATA");
                let renderer_box_ptr = GetWindowLongPtrW(self.hwnd, GWLP_USERDATA)
                    as *mut Arc<Mutex<GdiWallpaperRenderer>>;
                if !renderer_box_ptr.is_null() {
                    // 从原始指针恢复 Box 并释放（Box::into_raw 的逆操作）
                    // 这会释放堆上的 Arc，减少引用计数
                    let _ = Box::from_raw(renderer_box_ptr);
                    SetWindowLongPtrW(self.hwnd, GWLP_USERDATA, 0);
                    eprintln!("[DEBUG] GdiWallpaperWindow::Drop: USERDATA 已清理");
                }
            }

            // 设置退出标志，通知消息循环线程退出
            eprintln!("[DEBUG] GdiWallpaperWindow::Drop: 设置退出标志");
            self.should_quit.store(true, Ordering::Relaxed);

            // 尝试销毁窗口（如果有效），这会触发 WM_DESTROY
            // 但即使窗口无效，退出标志也已经设置，线程会退出
            if IsWindow(self.hwnd) != 0 {
                eprintln!(
                    "[DEBUG] GdiWallpaperWindow::Drop: 调用 DestroyWindow（这会触发 WM_DESTROY）"
                );
                DestroyWindow(self.hwnd);
                eprintln!("[DEBUG] GdiWallpaperWindow::Drop: DestroyWindow 调用完成");
            } else {
                eprintln!("[DEBUG] GdiWallpaperWindow::Drop: 窗口句柄无效，跳过 DestroyWindow（退出标志已设置）");
            }

            // 等待消息循环线程结束（WM_DESTROY 中的 PostQuitMessage 会发送 WM_QUIT 消息）
            if let Some(handle) = self.message_thread_handle.take() {
                eprintln!("[DEBUG] GdiWallpaperWindow::Drop: 等待消息循环线程结束（可能会阻塞）");
                // 使用 join 会阻塞，但这是必要的，因为我们需要确保线程完全退出
                // 如果线程卡住了，这里会一直阻塞
                // 注意：这里可能会无限期阻塞，如果 WM_DESTROY 没有被正确处理
                let _ = handle.join();
                eprintln!("[DEBUG] GdiWallpaperWindow::Drop: 消息循环线程已结束");
            } else {
                eprintln!("[DEBUG] GdiWallpaperWindow::Drop: 没有消息循环线程句柄");
            }
        }
        eprintln!("[DEBUG] GdiWallpaperWindow::Drop: 完成");
    }
}

// 窗口过程（处理 WM_PAINT 消息）
unsafe extern "system" fn window_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    use windows_sys::Win32::UI::WindowsAndMessaging::GetWindowLongPtrW;

    match msg {
        WM_CREATE => {
            // WM_CREATE 在窗口创建时发送，此时 USERDATA 可能还没有设置
            // 我们直接返回 0 允许窗口创建继续
            eprintln!("[DEBUG] window_proc: 收到 WM_CREATE");
            0
        }
        WM_PAINT => {
            eprintln!("[DEBUG] window_proc: 收到 WM_PAINT，开始绘制");
            // 从窗口的 USERDATA 获取 GdiWallpaperRenderer 实例
            // 注意：USERDATA 存储的是 Box<Arc<Mutex<GdiWallpaperRenderer>>> 的原始指针
            let renderer_box_ptr =
                GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut Arc<Mutex<GdiWallpaperRenderer>>;
            if !renderer_box_ptr.is_null() {
                // 通过原始指针访问 Arc（不安全，但在这里是必要的）
                // 注意：这假设 Arc 的引用计数在窗口生命周期内始终保持有效
                let renderer_arc = &*renderer_box_ptr;
                if let Ok(renderer) = renderer_arc.lock() {
                    // 对于 WM_PAINT 消息，使用 GetDC/ReleaseDC 进行绘制
                    // 注意：虽然通常 WM_PAINT 应该使用 BeginPaint/EndPaint，
                    // 但为了保持与 invalidate() 中直接绘制的一致性，这里也使用 GetDC
                    use windows_sys::Win32::Graphics::Gdi::GetDC;
                    use windows_sys::Win32::Graphics::Gdi::ReleaseDC;
                    let hdc = GetDC(hwnd);
                    if hdc != 0 {
                        eprintln!("[DEBUG] window_proc: GetDC 成功，开始调用 renderer.paint");
                        let paint_result = renderer.paint(hdc);
                        if paint_result.is_err() {
                            eprintln!(
                                "[ERROR] window_proc: renderer.paint 失败: {:?}",
                                paint_result
                            );
                        } else {
                            eprintln!("[DEBUG] window_proc: renderer.paint 成功");
                        }
                        ReleaseDC(hwnd, hdc);
                        eprintln!("[DEBUG] window_proc: ReleaseDC 完成");
                    } else {
                        eprintln!(
                            "[ERROR] window_proc: GetDC 失败，错误码: {}",
                            windows_sys::Win32::Foundation::GetLastError()
                        );
                    }
                } else {
                    eprintln!("[ERROR] window_proc: 无法获取 renderer 锁");
                }
            } else {
                eprintln!("[ERROR] window_proc: USERDATA 指针为空");
            }
            // 对于 WM_PAINT，如果我们处理了绘制，应该返回 0
            // 不需要调用 DefWindowProcW，因为我们已经完成了绘制
            0
        }
        WM_NCHITTEST => {
            // 对于桌面壁纸窗口，我们需要让鼠标消息穿透，但也要确保窗口能响应系统消息
            // 先让 DefWindowProcW 处理，然后检查结果
            // 如果是在窗口客户区，返回 HTTRANSPARENT 让消息穿透
            // 否则返回默认结果
            let result = DefWindowProcW(hwnd, msg, wparam, lparam);
            use windows_sys::Win32::UI::WindowsAndMessaging::{HTCLIENT, HTTRANSPARENT};
            // 如果 DefWindowProcW 返回 HTCLIENT（在窗口客户区），则返回 HTTRANSPARENT 让消息穿透
            // 否则返回默认结果（如 HTNOWHERE、HTCAPTION 等），确保窗口能响应系统消息
            if result == HTCLIENT as isize {
                HTTRANSPARENT as isize
            } else {
                result
            }
        }
        WM_DESTROY => {
            eprintln!("[DEBUG] window_proc: 收到 WM_DESTROY，调用 PostQuitMessage(0)");
            PostQuitMessage(0);
            eprintln!("[DEBUG] window_proc: PostQuitMessage(0) 已调用");
            0
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

/// GDI 版本的 WallpaperWindow 接口（类似窗口模式的 WallpaperWindow）
/// 提供与窗口模式一致的接口，但底层使用 GDI 渲染
struct GdiWallpaperWindowWrapper {
    gdi_window: Arc<Mutex<Option<GdiWallpaperWindow>>>,
}

impl GdiWallpaperWindowWrapper {
    fn new(gdi_window: Arc<Mutex<Option<GdiWallpaperWindow>>>) -> Self {
        Self { gdi_window }
    }

    /// 创建或获取 GDI 窗口（类似 WallpaperWindow::new）
    fn ensure_window(&self) -> Result<(), String> {
        let mut window_guard = self
            .gdi_window
            .lock()
            .map_err(|e| format!("无法获取窗口锁: {}", e))?;

        if window_guard.is_none() {
            *window_guard = Some(GdiWallpaperWindow::new()?);
        }

        Ok(())
    }

    /// 更新壁纸图片（类似 WallpaperWindow::update_image）
    fn update_image(&self, image_path: &str) -> Result<(), String> {
        self.ensure_window()?;

        let window_guard = self
            .gdi_window
            .lock()
            .map_err(|e| format!("无法获取窗口锁: {}", e))?;

        if let Some(ref window) = *window_guard {
            // 先检查窗口是否有效
            unsafe {
                let hwnd = window.hwnd();
                if IsWindow(hwnd) == 0 {
                    eprintln!(
                        "[WARN] GdiWallpaperWindowWrapper::update_image: 窗口句柄无效 (hwnd={})",
                        hwnd
                    );
                    drop(window_guard);
                    return Err("窗口句柄无效，需要重新创建窗口".to_string());
                }
            }

            window.set_image(image_path)?;
        } else {
            return Err("窗口初始化失败".to_string());
        }

        Ok(())
    }

    /// 更新壁纸样式（类似 WallpaperWindow::update_style）
    fn update_style(&self, style: &str) -> Result<(), String> {
        let window_guard = self
            .gdi_window
            .lock()
            .map_err(|e| format!("无法获取窗口锁: {}", e))?;

        if let Some(ref window) = *window_guard {
            window.set_style(style)?;
        }

        Ok(())
    }

    /// 更新壁纸过渡效果（类似 WallpaperWindow::update_transition）
    /// 注意：GDI 模式不支持过渡效果，此方法为空实现
    fn update_transition(&self, _transition: &str) -> Result<(), String> {
        // GDI 渲染器不支持过渡效果
        Ok(())
    }

    /// 重新挂载窗口到桌面（类似 WallpaperWindow::remount）
    fn remount(&self) -> Result<(), String> {
        self.ensure_window()?;

        let window_guard = self
            .gdi_window
            .lock()
            .map_err(|e| format!("无法获取窗口锁: {}", e))?;

        if let Some(ref window) = *window_guard {
            let hwnd = window.hwnd();
            unsafe {
                // 先检查窗口是否有效
                if IsWindow(hwnd) == 0 {
                    eprintln!("[WARN] GdiWallpaperWindowWrapper::remount: 窗口句柄无效，跳过挂载");
                    drop(window_guard);
                    // 窗口无效，需要重新创建
                    return Err("窗口句柄无效，需要重新创建窗口".to_string());
                }

                // 检查窗口是否已经挂载
                let parent = GetParent(hwnd);
                if parent != 0 && IsWindow(parent) != 0 {
                    eprintln!("[DEBUG] GdiWallpaperWindowWrapper::remount: 窗口已挂载到 parent={}, 跳过重复挂载", parent);
                    // 窗口已挂载，只触发重绘
                    window.invalidate();
                    return Ok(());
                }

                // 窗口未挂载或父窗口无效，重新挂载
                eprintln!("[DEBUG] GdiWallpaperWindowWrapper::remount: 窗口未挂载，开始挂载");
                window_mount::mount_to_desktop_saikyo(hwnd)?;
                // 触发重绘
                window.invalidate();
            }
        } else {
            return Err("窗口未初始化".to_string());
        }

        Ok(())
    }
}

/// GDI 壁纸管理器（实现 WallpaperManager trait）
/// 使用与窗口模式类似的接口风格
pub struct GdiWallpaperManager {
    app: AppHandle,
    gdi_window: Arc<Mutex<Option<GdiWallpaperWindow>>>,
    current_wallpaper_path: Arc<Mutex<Option<String>>>,
    // 使用包装器提供统一接口
    window_wrapper: GdiWallpaperWindowWrapper,
}

impl GdiWallpaperManager {
    pub fn new(app: AppHandle) -> Self {
        let gdi_window = Arc::new(Mutex::new(None));
        let window_wrapper = GdiWallpaperWindowWrapper::new(Arc::clone(&gdi_window));

        Self {
            app,
            gdi_window,
            current_wallpaper_path: Arc::new(Mutex::new(None)),
            window_wrapper,
        }
    }
}

impl WallpaperManager for GdiWallpaperManager {
    fn get_wallpaper_path(&self) -> Result<String, String> {
        let path = self
            .current_wallpaper_path
            .lock()
            .map_err(|e| format!("无法获取壁纸路径锁: {}", e))?;
        path.clone().ok_or_else(|| "当前没有设置壁纸".to_string())
    }

    fn get_style(&self) -> Result<String, String> {
        let settings = self.app.state::<Settings>();
        let current_settings = settings
            .get_settings()
            .map_err(|e| format!("获取设置失败: {}", e))?;
        Ok(current_settings.wallpaper_rotation_style.clone())
    }

    fn get_transition(&self) -> Result<String, String> {
        // GDI 渲染器不支持过渡效果，返回 "none"
        Ok("none".to_string())
    }

    fn set_wallpaper_path(&self, file_path: &str, immediate: bool) -> Result<(), String> {
        eprintln!(
            "[DEBUG] GdiWallpaperManager::set_wallpaper_path 开始: {}",
            file_path
        );
        use std::path::Path;

        let path = Path::new(file_path);
        if !path.exists() {
            eprintln!("[ERROR] 文件不存在: {}", file_path);
            return Err("File does not exist".to_string());
        }

        // 更新 manager 中的壁纸路径状态
        {
            let mut current_path = self
                .current_wallpaper_path
                .lock()
                .map_err(|e| format!("无法获取壁纸路径锁: {}", e))?;
            *current_path = Some(file_path.to_string());
        }
        eprintln!("[DEBUG] 壁纸路径状态已更新");

        // 使用窗口模式的接口风格：通过 wrapper 更新图片
        // 类似 WindowWallpaperManager 使用 WallpaperWindow::update_image
        // 先检查窗口状态，如果窗口有效且已挂载，直接更新图片，避免不必要的 remount
        let need_remount = {
            let window_guard = self
                .gdi_window
                .lock()
                .map_err(|e| format!("无法获取窗口锁: {}", e))?;

            if let Some(ref window) = *window_guard {
                unsafe {
                    let hwnd = window.hwnd();
                    // 检查窗口是否有效
                    if IsWindow(hwnd) == 0 {
                        eprintln!("[DEBUG] 窗口无效，需要重新创建");
                        drop(window_guard);
                        true
                    } else {
                        // 检查窗口是否已挂载
                        let parent = GetParent(hwnd);
                        if parent == 0 || IsWindow(parent) == 0 {
                            eprintln!("[DEBUG] 窗口未挂载 (parent={}), 需要挂载", parent);
                            drop(window_guard);
                            true
                        } else {
                            eprintln!("[DEBUG] 窗口有效且已挂载 (parent={}), 直接更新图片", parent);
                            false
                        }
                    }
                }
            } else {
                eprintln!("[DEBUG] 窗口不存在，需要创建");
                drop(window_guard);
                true
            }
        };

        // 更新图片
        self.window_wrapper.update_image(file_path)?;

        // 只有在需要时才重新挂载（避免重复挂载导致错误）
        if need_remount && immediate {
            eprintln!("[DEBUG] 执行 remount 以确保窗口正确挂载");
            if let Err(e) = self.window_wrapper.remount() {
                eprintln!("[WARN] remount 失败: {}, 但图片已更新", e);
            }
        }

        eprintln!("[DEBUG] GdiWallpaperManager::set_wallpaper_path 完成");
        Ok(())
    }

    fn set_style(&self, style: &str, immediate: bool) -> Result<(), String> {
        // 保存样式到 Settings
        let settings = self.app.state::<Settings>();
        settings
            .set_wallpaper_style(style.to_string())
            .map_err(|e| format!("保存样式设置失败: {}", e))?;

        // 使用窗口模式的接口风格：通过 wrapper 更新样式
        // 类似 WindowWallpaperManager 使用 WallpaperWindow::update_style
        self.window_wrapper.update_style(style)?;

        // 如果 immediate=true，重新挂载窗口以确保立即生效
        if immediate {
            // 避免每次都 remount 导致闪烁；仅在窗口不可见时 remount
            let window_guard = self
                .gdi_window
                .lock()
                .map_err(|e| format!("无法获取窗口锁: {}", e))?;

            if let Some(ref window) = *window_guard {
                unsafe {
                    let hwnd = window.hwnd();
                    let parent = GetParent(hwnd);
                    if parent == 0 || IsWindow(parent) == 0 {
                        drop(window_guard);
                        // 窗口未挂载，重新挂载
                        let _ = self.window_wrapper.remount();
                    }
                }
            }
        }

        Ok(())
    }

    fn set_transition(&self, transition: &str, immediate: bool) -> Result<(), String> {
        // 保存过渡效果到 Settings（即使 GDI 不支持，也保存设置以保持一致性）
        let settings = self.app.state::<Settings>();
        settings
            .set_wallpaper_rotation_transition(transition.to_string())
            .map_err(|e| format!("保存过渡效果设置失败: {}", e))?;

        // 使用窗口模式的接口风格：通过 wrapper 更新过渡效果
        // 类似 WindowWallpaperManager 使用 WallpaperWindow::update_transition
        // 注意：GDI 渲染器不支持过渡效果，此方法为空实现
        self.window_wrapper.update_transition(transition)?;

        // 如果 immediate=true，重新挂载窗口以确保立即生效
        if immediate {
            let window_guard = self
                .gdi_window
                .lock()
                .map_err(|e| format!("无法获取窗口锁: {}", e))?;

            if let Some(ref window) = *window_guard {
                unsafe {
                    let hwnd = window.hwnd();
                    let parent = GetParent(hwnd);
                    if parent == 0 || IsWindow(parent) == 0 {
                        drop(window_guard);
                        // 窗口未挂载，重新挂载
                        let _ = self.window_wrapper.remount();
                    }
                }
            }
        }

        Ok(())
    }

    fn cleanup(&self) -> Result<(), String> {
        eprintln!("[DEBUG] GdiWallpaperManager::cleanup: 开始清理");
        // 销毁窗口
        if let Ok(mut window_guard) = self.gdi_window.lock() {
            eprintln!("[DEBUG] GdiWallpaperManager::cleanup: 获取窗口锁成功，准备设置为 None");
            *window_guard = None;
            eprintln!("[DEBUG] GdiWallpaperManager::cleanup: 窗口已设置为 None");
        } else {
            eprintln!("[WARN] GdiWallpaperManager::cleanup: 无法获取窗口锁");
        }
        eprintln!("[DEBUG] GdiWallpaperManager::cleanup: 完成");
        Ok(())
    }

    fn refresh_desktop(&self) -> Result<(), String> {
        // GDI 窗口模式不需要刷新桌面
        Ok(())
    }

    fn init(&self, _app: AppHandle) -> Result<(), String> {
        println!("初始化 GDI 壁纸管理器");
        // GDI 窗口在 set_wallpaper_path 时按需创建，这里不做任何操作
        Ok(())
    }
}
