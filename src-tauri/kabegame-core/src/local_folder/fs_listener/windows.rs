use std::collections::HashMap;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::ptr;
use std::thread::{self, JoinHandle};
use tokio::sync::mpsc;
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, HANDLE, INVALID_HANDLE_VALUE, WAIT_FAILED, WAIT_OBJECT_0,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, ReadDirectoryChangesW, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OVERLAPPED,
    FILE_LIST_DIRECTORY, FILE_NOTIFY_CHANGE_ATTRIBUTES, FILE_NOTIFY_CHANGE_DIR_NAME,
    FILE_NOTIFY_CHANGE_FILE_NAME, FILE_NOTIFY_CHANGE_LAST_WRITE, FILE_NOTIFY_CHANGE_SIZE,
    FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
};
use windows_sys::Win32::System::Threading::{
    CreateEventW, ResetEvent, SetEvent, WaitForMultipleObjects, INFINITE,
};
use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};

use super::{PathHint, PlatformWatcher, RawMsg};

struct ThreadSlot {
    stop_event: HANDLE,
    join: JoinHandle<()>,
}

pub(super) struct PlatformImpl {
    threads: HashMap<String, ThreadSlot>,
    out_tx: mpsc::UnboundedSender<RawMsg>,
}

impl PlatformImpl {
    pub fn new(out_tx: mpsc::UnboundedSender<RawMsg>) -> Self {
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
            return Err(format!("CreateEventW(stop) failed: {}", unsafe {
                GetLastError()
            }));
        }
        let path = path.to_path_buf();
        let thread_path = path.clone();
        let out_tx = self.out_tx.clone();
        let join = thread::Builder::new()
            .name(format!("kabegame-rdcw-{album_id}"))
            .spawn(move || read_directory_changes_loop(thread_path, stop_event, out_tx))
            .map_err(|err| format!("spawn ReadDirectoryChangesW thread: {err}"))?;
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
        for id in self.threads.keys().cloned().collect::<Vec<_>>() {
            self.remove(&id);
        }
    }
}

fn read_u32(buffer: &[u8], offset: usize) -> Option<u32> {
    let bytes: [u8; 4] = buffer.get(offset..offset + 4)?.try_into().ok()?;
    Some(u32::from_le_bytes(bytes))
}

fn emit_entries(buffer: &[u8], root: &Path, out_tx: &mpsc::UnboundedSender<RawMsg>) {
    let mut offset = 0usize;
    loop {
        let Some(next) = read_u32(buffer, offset) else {
            break;
        };
        let Some(name_len) = read_u32(buffer, offset + 8).map(|value| value as usize) else {
            break;
        };
        let Some(name_bytes) = buffer.get(offset + 12..offset + 12 + name_len) else {
            break;
        };
        let name = name_bytes
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .collect::<Vec<_>>();
        let _ = out_tx.send(RawMsg::Change {
            path: root.join(String::from_utf16_lossy(&name)),
            hint: PathHint::Unknown,
        });
        if next == 0 {
            break;
        }
        offset += next as usize;
    }
}

fn read_directory_changes_loop(
    path: PathBuf,
    stop_event: HANDLE,
    out_tx: mpsc::UnboundedSender<RawMsg>,
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
        let _ = out_tx.send(RawMsg::Change {
            path,
            hint: PathHint::Dir,
        });
        return;
    }
    let ready_event = unsafe { CreateEventW(ptr::null(), 0, 0, ptr::null()) };
    if ready_event == 0 {
        unsafe { CloseHandle(dir) };
        return;
    }
    let mut buffer = [0u8; 8192];
    let filter = FILE_NOTIFY_CHANGE_FILE_NAME
        | FILE_NOTIFY_CHANGE_DIR_NAME
        | FILE_NOTIFY_CHANGE_SIZE
        | FILE_NOTIFY_CHANGE_LAST_WRITE
        | FILE_NOTIFY_CHANGE_ATTRIBUTES;
    loop {
        unsafe { ResetEvent(ready_event) };
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
            let _ = out_tx.send(RawMsg::Change {
                path: path.clone(),
                hint: PathHint::Dir,
            });
            break;
        }
        let handles = [ready_event, stop_event];
        let wait = unsafe { WaitForMultipleObjects(2, handles.as_ptr(), 0, INFINITE) };
        if wait == WAIT_OBJECT_0 + 1 {
            unsafe { CancelIoEx(dir, &mut overlapped) };
            break;
        }
        if wait == WAIT_FAILED || wait != WAIT_OBJECT_0 {
            break;
        }
        let mut bytes = 0u32;
        let got = unsafe { GetOverlappedResult(dir, &mut overlapped, &mut bytes, 0) };
        if got == 0 {
            let _ = out_tx.send(RawMsg::Change {
                path: path.clone(),
                hint: PathHint::Dir,
            });
            break;
        }
        if bytes == 0 {
            let _ = out_tx.send(RawMsg::Overflow {
                detail: format!(
                    "ReadDirectoryChangesW returned 0 bytes for {}",
                    path.display()
                ),
            });
        } else {
            emit_entries(&buffer[..bytes as usize], &path, &out_tx);
        }
    }
    unsafe {
        CloseHandle(ready_event);
        CloseHandle(dir);
    }
}
