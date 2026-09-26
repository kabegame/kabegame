use core_foundation::array::CFArray;
use core_foundation::base::TCFType;
use core_foundation::runloop::{kCFRunLoopDefaultMode, CFRunLoop};
use core_foundation::string::CFString;
use std::collections::HashMap;
use std::ffi::c_void;
use std::path::{Path, PathBuf};
use std::ptr;
use std::sync::mpsc as std_mpsc;
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tokio::sync::mpsc;

use super::{PathHint, PlatformWatcher, RawMsg};

type FSEventStreamRef = *mut c_void;
type FSEventStreamCallback =
    unsafe extern "C" fn(FSEventStreamRef, *mut c_void, usize, *mut c_void, *const u32, *const u64);

#[repr(C)]
struct FSEventStreamContext {
    version: isize,
    info: *mut c_void,
    retain: Option<unsafe extern "C" fn(*const c_void) -> *const c_void>,
    release: Option<unsafe extern "C" fn(*const c_void)>,
    copy_description: Option<unsafe extern "C" fn(*const c_void) -> *const c_void>,
}

#[link(name = "CoreServices", kind = "framework")]
extern "C" {
    fn FSEventStreamCreate(
        allocator: *const c_void,
        callback: FSEventStreamCallback,
        context: *const FSEventStreamContext,
        paths_to_watch: *const c_void,
        since_when: u64,
        latency: f64,
        flags: u32,
    ) -> FSEventStreamRef;
    fn FSEventStreamScheduleWithRunLoop(
        stream: FSEventStreamRef,
        run_loop: *const c_void,
        run_loop_mode: *const c_void,
    );
    fn FSEventStreamStart(stream: FSEventStreamRef) -> u8;
    fn FSEventStreamStop(stream: FSEventStreamRef);
    fn FSEventStreamInvalidate(stream: FSEventStreamRef);
    fn FSEventStreamRelease(stream: FSEventStreamRef);
}

const SINCE_NOW: u64 = u64::MAX;
const CREATE_USE_CF_TYPES: u32 = 0x01;
const CREATE_NO_DEFER: u32 = 0x02;
const CREATE_WATCH_ROOT: u32 = 0x04;
const CREATE_FILE_EVENTS: u32 = 0x10;
const EVENT_MUST_SCAN_SUBDIRS: u32 = 0x01;
const EVENT_USER_DROPPED: u32 = 0x02;
const EVENT_KERNEL_DROPPED: u32 = 0x04;
const EVENT_ROOT_CHANGED: u32 = 0x20;
const EVENT_ITEM_IS_FILE: u32 = 0x0001_0000;
const EVENT_ITEM_IS_DIR: u32 = 0x0002_0000;

struct CallbackCtx {
    watched: PathBuf,
    out_tx: mpsc::UnboundedSender<RawMsg>,
}

struct StreamSlot {
    stop_tx: std_mpsc::Sender<()>,
    join: JoinHandle<()>,
}

pub(super) struct PlatformImpl {
    streams: HashMap<String, StreamSlot>,
    out_tx: mpsc::UnboundedSender<RawMsg>,
}

impl PlatformImpl {
    pub fn new(out_tx: mpsc::UnboundedSender<RawMsg>) -> Self {
        Self {
            streams: HashMap::new(),
            out_tx,
        }
    }
}

unsafe extern "C" fn fs_callback(
    _stream: FSEventStreamRef,
    info: *mut c_void,
    num_events: usize,
    event_paths: *mut c_void,
    event_flags: *const u32,
    _event_ids: *const u64,
) {
    if info.is_null() || event_paths.is_null() || event_flags.is_null() {
        return;
    }
    let ctx = &*(info as *const CallbackCtx);
    let paths: CFArray<CFString> = TCFType::wrap_under_get_rule(event_paths as *const _);
    let count = num_events.min(paths.len().max(0) as usize);
    for index in 0..count {
        let flags = *event_flags.add(index);
        if flags & (EVENT_MUST_SCAN_SUBDIRS | EVENT_USER_DROPPED | EVENT_KERNEL_DROPPED) != 0 {
            let _ = ctx.out_tx.send(RawMsg::Overflow {
                detail: format!("FSEvents flags=0x{flags:x}"),
            });
        }
        if flags & EVENT_ROOT_CHANGED != 0 {
            let _ = ctx.out_tx.send(RawMsg::Change {
                path: ctx.watched.clone(),
                hint: PathHint::Dir,
            });
            continue;
        }
        let Some(path) = paths.get(index as isize) else {
            continue;
        };
        let path = PathBuf::from(path.to_string());
        if path.parent() != Some(ctx.watched.as_path()) {
            continue;
        }
        let hint = if flags & EVENT_ITEM_IS_DIR != 0 {
            PathHint::Dir
        } else if flags & EVENT_ITEM_IS_FILE != 0 {
            PathHint::File
        } else {
            PathHint::Unknown
        };
        let _ = ctx.out_tx.send(RawMsg::Change { path, hint });
    }
}

impl PlatformWatcher for PlatformImpl {
    fn add(&mut self, album_id: &str, path: &Path) -> Result<(), String> {
        self.remove(album_id);
        let key = album_id.to_string();
        let watched = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        let out_tx = self.out_tx.clone();
        let (stop_tx, stop_rx) = std_mpsc::channel();
        let join = thread::Builder::new()
            .name(format!("kabegame-fsevents-{album_id}"))
            .spawn(move || {
                let ctx_ptr = Box::into_raw(Box::new(CallbackCtx {
                    watched: watched.clone(),
                    out_tx,
                }));
                let cf_path = CFString::new(&watched.to_string_lossy());
                let paths = CFArray::from_CFTypes(&[cf_path]).into_untyped();
                let context = FSEventStreamContext {
                    version: 0,
                    info: ctx_ptr as *mut c_void,
                    retain: None,
                    release: None,
                    copy_description: None,
                };
                let stream = unsafe {
                    FSEventStreamCreate(
                        ptr::null(),
                        fs_callback,
                        &context,
                        paths.as_concrete_TypeRef() as *const c_void,
                        SINCE_NOW,
                        0.5,
                        CREATE_USE_CF_TYPES
                            | CREATE_NO_DEFER
                            | CREATE_WATCH_ROOT
                            | CREATE_FILE_EVENTS,
                    )
                };
                if stream.is_null() {
                    unsafe { drop(Box::from_raw(ctx_ptr)) };
                    return;
                }
                unsafe {
                    let run_loop = CFRunLoop::get_current();
                    FSEventStreamScheduleWithRunLoop(
                        stream,
                        run_loop.as_concrete_TypeRef() as *const c_void,
                        kCFRunLoopDefaultMode as *const c_void,
                    );
                    if FSEventStreamStart(stream) == 0 {
                        FSEventStreamInvalidate(stream);
                        FSEventStreamRelease(stream);
                        drop(Box::from_raw(ctx_ptr));
                        return;
                    }
                }
                loop {
                    CFRunLoop::run_in_mode(
                        unsafe { kCFRunLoopDefaultMode },
                        Duration::from_millis(500),
                        false,
                    );
                    if stop_rx.try_recv().is_ok() {
                        break;
                    }
                }
                unsafe {
                    FSEventStreamStop(stream);
                    FSEventStreamInvalidate(stream);
                    FSEventStreamRelease(stream);
                    drop(Box::from_raw(ctx_ptr));
                }
            })
            .map_err(|err| format!("spawn FSEvents thread: {err}"))?;
        self.streams.insert(key, StreamSlot { stop_tx, join });
        Ok(())
    }

    fn remove(&mut self, album_id: &str) {
        if let Some(slot) = self.streams.remove(album_id) {
            let _ = slot.stop_tx.send(());
            let _ = slot.join.join();
        }
    }

    fn shutdown(&mut self) {
        for id in self.streams.keys().cloned().collect::<Vec<_>>() {
            self.remove(&id);
        }
    }
}
