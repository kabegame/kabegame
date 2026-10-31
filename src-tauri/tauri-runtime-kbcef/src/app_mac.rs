use cef::application_mac::{CefAppProtocol, CrAppControlProtocol, CrAppProtocol};
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Bool, NSObject, NSObjectProtocol, ProtocolObject, Sel};
use objc2::{define_class, msg_send, ClassType, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSApplication, NSApplicationActivationPolicy, NSApplicationDelegate, NSEvent, NSEventMask,
};
use objc2_foundation::NSDefaultRunLoopMode;
use std::sync::atomic::{AtomicBool, Ordering};

static HANDLING_SEND_EVENT: AtomicBool = AtomicBool::new(false);

/// Dock 图标点击(`applicationShouldHandleReopen`)的待处理标记。
///
/// delegate 回调在主线程发生,但主循环要在下一次 drain 时才消费,所以用 atomic
/// 暂存而不是直接回调 —— runtime 的 `callback` 是泛型 `FnMut`,拿不进 delegate。
static PENDING_REOPEN: AtomicBool = AtomicBool::new(false);
static REOPEN_HAS_VISIBLE_WINDOWS: AtomicBool = AtomicBool::new(false);

define_class!(
    #[unsafe(super(NSApplication))]
    #[thread_kind = MainThreadOnly]
    #[name = "KabegameCefApplication"]
    struct KabegameCefApplication;

    impl KabegameCefApplication {
        #[unsafe(method(sendEvent:))]
        fn send_event(&self, event: &NSEvent) {
            let was = HANDLING_SEND_EVENT.swap(true, Ordering::AcqRel);
            let _: () = unsafe { msg_send![super(self), sendEvent: event] };
            HANDLING_SEND_EVENT.store(was, Ordering::Release);
        }
    }

    unsafe impl CrAppProtocol for KabegameCefApplication {
        #[unsafe(method(isHandlingSendEvent))]
        unsafe fn is_handling_send_event(&self) -> Bool {
            Bool::new(HANDLING_SEND_EVENT.load(Ordering::Acquire))
        }
    }

    unsafe impl CrAppControlProtocol for KabegameCefApplication {
        #[unsafe(method(setHandlingSendEvent:))]
        unsafe fn set_handling_send_event(&self, handling_send_event: Bool) {
            HANDLING_SEND_EVENT.store(handling_send_event.as_bool(), Ordering::Release);
        }
    }

    unsafe impl CefAppProtocol for KabegameCefApplication {}
);

/// 转发用 ivars:保存安装前已存在的 delegate(通常是 tao 在 `EventLoop::build`
/// 里装的那个),未实现的选择子仍交回它处理。
struct AppDelegateIvars {
    previous: Option<Retained<ProtocolObject<dyn NSApplicationDelegate>>>,
}

define_class!(
    /// 只拦 `applicationShouldHandleReopen:`、其余全部转发的代理型 app delegate。
    ///
    /// windowed CEF 路径不跑 tao 的事件循环,tao delegate 收到的 `Event::Reopen`
    /// 会烂在它自己的队列里,`RunEvent::Reopen` 永远发不出来 —— 点 Dock 图标只激活
    /// App、隐藏的主窗口不恢复。这里补上这一跳。
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "KabegameCefAppDelegate"]
    #[ivars = AppDelegateIvars]
    struct KabegameCefAppDelegate;

    impl KabegameCefAppDelegate {
        /// 自己没实现的选择子按前一个 delegate 的能力如实回答,否则 AppKit 根本不会
        /// 发过来,转发也就无从谈起。
        #[unsafe(method(respondsToSelector:))]
        fn responds_to_selector(&self, selector: Sel) -> bool {
            let handled: bool = unsafe { msg_send![super(self), respondsToSelector: selector] };
            handled
                || self
                    .ivars()
                    .previous
                    .as_ref()
                    .is_some_and(|previous| previous.respondsToSelector(selector))
        }

        #[unsafe(method(forwardingTargetForSelector:))]
        fn forwarding_target_for_selector(&self, selector: Sel) -> *mut AnyObject {
            match self.ivars().previous.as_ref() {
                Some(previous) if previous.respondsToSelector(selector) => {
                    Retained::as_ptr(previous) as *mut AnyObject
                }
                _ => std::ptr::null_mut(),
            }
        }
    }

    unsafe impl NSObjectProtocol for KabegameCefAppDelegate {}

    unsafe impl NSApplicationDelegate for KabegameCefAppDelegate {
        #[unsafe(method(applicationShouldHandleReopen:hasVisibleWindows:))]
        fn applicationShouldHandleReopen_hasVisibleWindows(
            &self,
            _sender: &NSApplication,
            has_visible_windows: bool,
        ) -> bool {
            REOPEN_HAS_VISIBLE_WINDOWS.store(has_visible_windows, Ordering::Release);
            PENDING_REOPEN.store(true, Ordering::Release);
            true
        }
    }
);

/// 装上 app delegate。必须在 tao `EventLoop` 建好之后调用 —— tao 会在构建时装自己的
/// delegate,顺序反了会被它覆盖掉。
pub(crate) fn install_app_delegate() {
    let mtm = MainThreadMarker::new().expect("app delegate must install on the main thread");
    let app = NSApplication::sharedApplication(mtm);
    let previous = app.delegate();
    let delegate = mtm
        .alloc::<KabegameCefAppDelegate>()
        .set_ivars(AppDelegateIvars { previous });
    let delegate: Retained<KabegameCefAppDelegate> = unsafe { msg_send![super(delegate), init] };
    // NSApplication 只弱引用 delegate,泄漏一份让它活到进程结束。
    let delegate = ProtocolObject::from_retained(delegate);
    app.setDelegate(Some(&delegate));
    std::mem::forget(delegate);
}

/// 取走待处理的 Dock 点击,返回 `applicationShouldHandleReopen` 报告的可见窗口状态。
pub(crate) fn take_pending_reopen() -> Option<bool> {
    PENDING_REOPEN
        .swap(false, Ordering::AcqRel)
        .then(|| REOPEN_HAS_VISIBLE_WINDOWS.load(Ordering::Acquire))
}

pub(crate) fn init_cef_app_mac() {
    let _mtm = MainThreadMarker::new().expect("CEF application must initialize on the main thread");
    let app: Retained<KabegameCefApplication> =
        unsafe { msg_send![KabegameCefApplication::class(), sharedApplication] };
    app.finishLaunching();
}

pub(crate) fn pump_events() -> bool {
    let mtm = MainThreadMarker::new().expect("CEF application events must run on the main thread");
    let app = NSApplication::sharedApplication(mtm);
    let mut did_work = false;
    while let Some(event) = unsafe {
        app.nextEventMatchingMask_untilDate_inMode_dequeue(
            NSEventMask::Any,
            None,
            NSDefaultRunLoopMode,
            true,
        )
    } {
        app.sendEvent(&event);
        did_work = true;
    }
    did_work
}

pub(crate) fn set_activation_policy(policy: tauri_runtime::ActivationPolicy) {
    let mtm = MainThreadMarker::new().expect("activation policy must change on the main thread");
    let policy = match policy {
        tauri_runtime::ActivationPolicy::Regular => NSApplicationActivationPolicy::Regular,
        tauri_runtime::ActivationPolicy::Accessory => NSApplicationActivationPolicy::Accessory,
        tauri_runtime::ActivationPolicy::Prohibited => NSApplicationActivationPolicy::Prohibited,
        _ => NSApplicationActivationPolicy::Regular,
    };
    NSApplication::sharedApplication(mtm).setActivationPolicy(policy);
}

pub(crate) fn set_dock_visibility(visible: bool) {
    set_activation_policy(if visible {
        tauri_runtime::ActivationPolicy::Regular
    } else {
        tauri_runtime::ActivationPolicy::Accessory
    });
}

pub(crate) fn show() {
    let mtm =
        MainThreadMarker::new().expect("application visibility must change on the main thread");
    NSApplication::sharedApplication(mtm).unhide(None);
}

pub(crate) fn hide() {
    let mtm =
        MainThreadMarker::new().expect("application visibility must change on the main thread");
    NSApplication::sharedApplication(mtm).hide(None);
}
