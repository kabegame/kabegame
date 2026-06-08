use core_foundation::array::CFArray;
use core_foundation::base::TCFType;
use core_foundation::runloop::{kCFRunLoopDefaultMode, CFRunLoop};
use core_foundation::string::CFString;
use std::collections::HashMap;
use std::ffi::c_void;
use std::path::{Path, PathBuf};
use std::ptr;
use std::sync::mpsc;
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tokio::sync::mpsc as tokio_mpsc;

use super::{ManagerMsg, PlatformWatcher, WatchEvent};

type FSEventStreamRef = *mut c_void;
type FSEventStreamCallback = unsafe extern "C" fn(
    stream_ref: FSEventStreamRef,
    info: *mut c_void,
    num_events: usize,
    event_paths: *mut c_void,
    event_flags: *const u32,
    event_ids: *const u64,
);

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

const KFS_EVENT_STREAM_EVENT_ID_SINCE_NOW: u64 = u64::MAX;
const KFS_EVENT_STREAM_CREATE_FLAG_USE_CF_TYPES: u32 = 0x01;
const KFS_EVENT_STREAM_CREATE_FLAG_NO_DEFER: u32 = 0x02;
const KFS_EVENT_STREAM_CREATE_FLAG_FILE_EVENTS: u32 = 0x10;

struct CallbackCtx {
    album_id: String,
    watched: PathBuf,
    out_tx: tokio_mpsc::Sender<ManagerMsg>,
}

struct StreamSlot {
    stop_tx: mpsc::Sender<()>,
    join: JoinHandle<()>,
}

pub(super) struct PlatformImpl {
    streams: HashMap<String, StreamSlot>,
    out_tx: tokio_mpsc::Sender<ManagerMsg>,
}

impl PlatformImpl {
    pub fn new(out_tx: tokio_mpsc::Sender<ManagerMsg>) -> Self {
        Self {
            streams: HashMap::new(),
            out_tx,
        }
    }
}

unsafe extern "C" fn fs_callback(
    _stream_ref: FSEventStreamRef,
    info: *mut c_void,
    num_events: usize,
    event_paths: *mut c_void,
    _event_flags: *const u32,
    _event_ids: *const u64,
) {
    if info.is_null() || event_paths.is_null() {
        return;
    }

    let ctx = &*(info as *const CallbackCtx);
    let cf_arr: CFArray<CFString> = TCFType::wrap_under_get_rule(event_paths as *const _);
    let count = num_events.min(cf_arr.len().max(0) as usize);
    for i in 0..count {
        let Some(cf_str) = cf_arr.get(i as isize) else {
            continue;
        };
        let path = PathBuf::from(cf_str.to_string());
        if path
            .parent()
            .is_some_and(|parent| parent == ctx.watched.as_path())
        {
            let _ = ctx.out_tx.try_send(ManagerMsg::Event(WatchEvent {
                album_id: ctx.album_id.clone(),
                kind: "fsevents",
            }));
        }
    }
}

impl PlatformWatcher for PlatformImpl {
    fn add(&mut self, album_id: &str, path: &Path) -> Result<(), String> {
        self.remove(album_id);

        let album_id = album_id.to_string();
        let album_id_key = album_id.clone();
        let watched = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        let out_tx = self.out_tx.clone();
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let thread_name = format!("kabegame-fsevents-{album_id}");

        let join = thread::Builder::new()
            .name(thread_name)
            .spawn(move || {
                let ctx_ptr = Box::into_raw(Box::new(CallbackCtx {
                    album_id,
                    watched: watched.clone(),
                    out_tx,
                }));

                let cf_path = CFString::new(&watched.to_string_lossy());
                let paths_arr = CFArray::from_CFTypes(&[cf_path]).into_untyped();
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
                        paths_arr.as_concrete_TypeRef() as *const c_void,
                        KFS_EVENT_STREAM_EVENT_ID_SINCE_NOW,
                        0.5,
                        KFS_EVENT_STREAM_CREATE_FLAG_USE_CF_TYPES
                            | KFS_EVENT_STREAM_CREATE_FLAG_NO_DEFER
                            | KFS_EVENT_STREAM_CREATE_FLAG_FILE_EVENTS,
                    )
                };

                if stream.is_null() {
                    eprintln!(
                        "[local_folder.watch.macos] FSEventStreamCreate returned null for {}",
                        watched.display()
                    );
                    unsafe {
                        drop(Box::from_raw(ctx_ptr));
                    }
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
                        eprintln!(
                            "[local_folder.watch.macos] FSEventStreamStart failed for {}",
                            watched.display()
                        );
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

        self.streams
            .insert(album_id_key, StreamSlot { stop_tx, join });
        Ok(())
    }

    fn remove(&mut self, album_id: &str) {
        if let Some(slot) = self.streams.remove(album_id) {
            let _ = slot.stop_tx.send(());
            let _ = slot.join.join();
        }
    }

    fn shutdown(&mut self) {
        let ids: Vec<String> = self.streams.keys().cloned().collect();
        for id in ids {
            self.remove(&id);
        }
    }
}
