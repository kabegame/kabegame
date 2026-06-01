use libc::{self, c_int};
use std::collections::HashMap;
use std::ffi::CString;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::io::RawFd;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tokio::sync::mpsc as tokio_mpsc;

use super::{ManagerMsg, PlatformWatcher, WatchEvent};

pub(super) struct PlatformImpl {
    fd: RawFd,
    stop: Arc<AtomicBool>,
    wd_to_id: Arc<Mutex<HashMap<c_int, String>>>,
    id_to_wd: HashMap<String, c_int>,
    reader: Option<JoinHandle<()>>,
}

impl PlatformImpl {
    pub fn new(out_tx: tokio_mpsc::Sender<ManagerMsg>) -> Self {
        let fd = unsafe { libc::inotify_init1(libc::IN_CLOEXEC | libc::IN_NONBLOCK) };
        let stop = Arc::new(AtomicBool::new(false));
        let wd_to_id = Arc::new(Mutex::new(HashMap::<c_int, String>::new()));
        let reader = if fd >= 0 {
            let stop_for_thread = Arc::clone(&stop);
            let map_for_thread = Arc::clone(&wd_to_id);
            Some(
                thread::Builder::new()
                    .name("kabegame-inotify-reader".into())
                    .spawn(move || reader_loop(fd, stop_for_thread, map_for_thread, out_tx))
                    .expect("spawn inotify reader"),
            )
        } else {
            eprintln!(
                "[local_folder.watch.linux] inotify_init1 failed: {}",
                std::io::Error::last_os_error()
            );
            None
        };

        Self {
            fd,
            stop,
            wd_to_id,
            id_to_wd: HashMap::new(),
            reader,
        }
    }
}

fn reader_loop(
    fd: RawFd,
    stop: Arc<AtomicBool>,
    wd_to_id: Arc<Mutex<HashMap<c_int, String>>>,
    out_tx: tokio_mpsc::Sender<ManagerMsg>,
) {
    let mut buf = [0u8; 8192];
    while !stop.load(Ordering::Relaxed) {
        let n = unsafe { libc::read(fd, buf.as_mut_ptr() as *mut _, buf.len()) };
        if n <= 0 {
            let err = std::io::Error::last_os_error();
            if matches!(
                err.raw_os_error(),
                Some(code) if code == libc::EAGAIN || code == libc::EWOULDBLOCK
            ) {
                thread::sleep(Duration::from_millis(100));
                continue;
            }
            break;
        }

        let mut offset = 0usize;
        let total = n as usize;
        let event_size = std::mem::size_of::<libc::inotify_event>();
        while offset + event_size <= total {
            let event = unsafe { &*(buf.as_ptr().add(offset) as *const libc::inotify_event) };
            let album_id = wd_to_id
                .lock()
                .ok()
                .and_then(|map| map.get(&event.wd).cloned());
            if let Some(album_id) = album_id {
                let _ = out_tx.try_send(ManagerMsg::Event(WatchEvent {
                    album_id,
                    kind: "inotify",
                }));
            }
            offset += event_size + event.len as usize;
        }
    }
}

impl PlatformWatcher for PlatformImpl {
    fn add(&mut self, album_id: &str, path: &Path) -> Result<(), String> {
        if self.fd < 0 {
            return Err("inotify is not available".to_string());
        }

        self.remove(album_id);

        let c_path = CString::new(path.as_os_str().as_bytes())
            .map_err(|err| format!("path contains null byte: {err}"))?;
        let mask = libc::IN_CREATE
            | libc::IN_DELETE
            | libc::IN_MOVED_FROM
            | libc::IN_MOVED_TO
            | libc::IN_CLOSE_WRITE
            | libc::IN_ATTRIB;
        let wd = unsafe { libc::inotify_add_watch(self.fd, c_path.as_ptr(), mask) };
        if wd < 0 {
            return Err(format!(
                "inotify_add_watch({}): {}",
                path.display(),
                std::io::Error::last_os_error()
            ));
        }

        if let Ok(mut map) = self.wd_to_id.lock() {
            map.insert(wd, album_id.to_string());
        }
        self.id_to_wd.insert(album_id.to_string(), wd);
        Ok(())
    }

    fn remove(&mut self, album_id: &str) {
        let Some(wd) = self.id_to_wd.remove(album_id) else {
            return;
        };

        if self.fd >= 0 {
            unsafe {
                libc::inotify_rm_watch(self.fd, wd);
            }
        }
        if let Ok(mut map) = self.wd_to_id.lock() {
            map.remove(&wd);
        }
    }

    fn shutdown(&mut self) {
        let ids: Vec<String> = self.id_to_wd.keys().cloned().collect();
        for id in ids {
            self.remove(&id);
        }

        self.stop.store(true, Ordering::Relaxed);
        if self.fd >= 0 {
            unsafe {
                libc::close(self.fd);
            }
            self.fd = -1;
        }

        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}
