use std::collections::HashMap;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::ptr;
use std::thread::{self, JoinHandle};
use tokio::sync::mpsc as tokio_mpsc;
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, HANDLE, INVALID_HANDLE_VALUE, WAIT_FAILED, WAIT_OBJECT_0,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, ReadDirectoryChangesW, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OVERLAPPED,
    FILE_LIST_DIRECTORY, FILE_NOTIFY_CHANGE_ATTRIBUTES, FILE_NOTIFY_CHANGE_FILE_NAME,
    FILE_NOTIFY_CHANGE_LAST_WRITE, FILE_NOTIFY_CHANGE_SIZE, FILE_SHARE_DELETE, FILE_SHARE_READ,
    FILE_SHARE_WRITE, OPEN_EXISTING,
};
use windows_sys::Win32::System::Threading::{
    CreateEventW, ResetEvent, SetEvent, WaitForMultipleObjects, INFINITE,
};
use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};

use super::{ManagerMsg, PlatformWatcher, WatchEvent};

struct ThreadSlot {
    stop_event: HANDLE,
    join: JoinHandle<()>,
}

pub(super) struct PlatformImpl {
    threads: HashMap<String, ThreadSlot>,
    out_tx: tokio_mpsc::Sender<ManagerMsg>,
}

impl PlatformImpl {
    pub fn new(out_tx: tokio_mpsc::Sender<ManagerMsg>) -> Self {
        Self {
            threads: HashMap::new(),
            out_tx,
        }
    }
}

impl PlatformWatcher for PlatformImpl {
    fn add(&mut self, album_id: &str, path: &Path) -> Result<(), String> {
        self.remove(album_id);

        let stop_event = unsafe { CreateEventW(ptr::null(), 1, 0, ptr::null()) };
        if stop_event == 0 {
            return Err(format!(
                "CreateEventW(stop) failed: {}",
                std::io::Error::last_os_error()
            ));
        }

        let album_id = album_id.to_string();
        let path_buf = path.to_path_buf();
        let out_tx = self.out_tx.clone();
        let thread_name = format!("kabegame-rdcw-{album_id}");
        let album_id_for_loop = album_id.clone();
        let join = match thread::Builder::new().name(thread_name).spawn(move || {
            read_directory_changes_loop(album_id_for_loop, path_buf, stop_event, out_tx);
        }) {
            Ok(join) => join,
            Err(err) => {
                unsafe {
                    CloseHandle(stop_event);
                }
                return Err(format!("spawn ReadDirectoryChangesW thread: {err}"));
            }
        };

        self.threads
            .insert(album_id.to_string(), ThreadSlot { stop_event, join });
        Ok(())
    }

    fn remove(&mut self, album_id: &str) {
        if let Some(slot) = self.threads.remove(album_id) {
            unsafe {
                SetEvent(slot.stop_event);
            }
            let _ = slot.join.join();
            unsafe {
                CloseHandle(slot.stop_event);
            }
        }
    }

    fn shutdown(&mut self) {
        let ids: Vec<String> = self.threads.keys().cloned().collect();
        for id in ids {
            self.remove(&id);
        }
    }
}

fn read_directory_changes_loop(
    album_id: String,
    path: std::path::PathBuf,
    stop_event: HANDLE,
    out_tx: tokio_mpsc::Sender<ManagerMsg>,
) {
    let path_w: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let dir = unsafe {
        CreateFileW(
            path_w.as_ptr(),
            FILE_LIST_DIRECTORY,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OVERLAPPED,
            0,
        )
    };
    if dir == INVALID_HANDLE_VALUE {
        eprintln!(
            "[local_folder.watch.windows] CreateFileW({}) failed: {}",
            path.display(),
            unsafe { GetLastError() }
        );
        return;
    }

    let ready_event = unsafe { CreateEventW(ptr::null(), 0, 0, ptr::null()) };
    if ready_event == 0 {
        eprintln!(
            "[local_folder.watch.windows] CreateEventW(ready) failed: {}",
            unsafe { GetLastError() }
        );
        unsafe {
            CloseHandle(dir);
        }
        return;
    }

    let mut buffer = [0u8; 8192];
    let filter = FILE_NOTIFY_CHANGE_FILE_NAME
        | FILE_NOTIFY_CHANGE_SIZE
        | FILE_NOTIFY_CHANGE_LAST_WRITE
        | FILE_NOTIFY_CHANGE_ATTRIBUTES;

    loop {
        unsafe {
            ResetEvent(ready_event);
        }
        let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
        overlapped.hEvent = ready_event;

        let ok = unsafe {
            ReadDirectoryChangesW(
                dir,
                buffer.as_mut_ptr() as *mut _,
                buffer.len() as u32,
                0,
                filter,
                ptr::null_mut(),
                &mut overlapped,
                None,
            )
        };
        if ok == 0 {
            eprintln!(
                "[local_folder.watch.windows] ReadDirectoryChangesW({}) failed: {}",
                path.display(),
                unsafe { GetLastError() }
            );
            break;
        }

        let handles = [ready_event, stop_event];
        let wait = unsafe { WaitForMultipleObjects(2, handles.as_ptr(), 0, INFINITE) };
        if wait == WAIT_OBJECT_0 + 1 {
            unsafe {
                CancelIoEx(dir, &mut overlapped);
            }
            break;
        }
        if wait == WAIT_FAILED || wait != WAIT_OBJECT_0 {
            break;
        }

        let mut bytes = 0u32;
        let got = unsafe { GetOverlappedResult(dir, &mut overlapped, &mut bytes, 0) };
        if got != 0 && bytes > 0 {
            let _ = out_tx.try_send(ManagerMsg::Event(WatchEvent {
                album_id: album_id.clone(),
                kind: "read_directory_changes",
            }));
        }
    }

    unsafe {
        CloseHandle(ready_event);
        CloseHandle(dir);
    }
}
