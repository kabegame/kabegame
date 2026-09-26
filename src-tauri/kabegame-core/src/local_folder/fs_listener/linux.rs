use libc::{self, c_int};
use std::collections::HashMap;
use std::ffi::CString;
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::os::unix::io::RawFd;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tokio::sync::mpsc;

use super::{PathHint, PlatformWatcher, RawMsg};

pub(super) struct PlatformImpl {
    fd: RawFd,
    stop: Arc<AtomicBool>,
    wd_to_path: Arc<Mutex<HashMap<c_int, PathBuf>>>,
    id_to_wd: HashMap<String, c_int>,
    reader: Option<JoinHandle<()>>,
}

impl PlatformImpl {
    pub fn new(out_tx: mpsc::UnboundedSender<RawMsg>) -> Self {
        let fd = unsafe { libc::inotify_init1(libc::IN_CLOEXEC | libc::IN_NONBLOCK) };
        let stop = Arc::new(AtomicBool::new(false));
        let wd_to_path = Arc::new(Mutex::new(HashMap::new()));
        let reader = if fd >= 0 {
            let thread_stop = Arc::clone(&stop);
            let thread_paths = Arc::clone(&wd_to_path);
            Some(
                thread::Builder::new()
                    .name("kabegame-inotify-reader".into())
                    .spawn(move || reader_loop(fd, thread_stop, thread_paths, out_tx))
                    .expect("spawn inotify reader"),
            )
        } else {
            eprintln!(
                "[local_folder.fs_listener.linux] inotify_init1 failed: {}",
                std::io::Error::last_os_error()
            );
            None
        };
        Self {
            fd,
            stop,
            wd_to_path,
            id_to_wd: HashMap::new(),
            reader,
        }
    }
}

fn reader_loop(
    fd: RawFd,
    stop: Arc<AtomicBool>,
    wd_to_path: Arc<Mutex<HashMap<c_int, PathBuf>>>,
    out_tx: mpsc::UnboundedSender<RawMsg>,
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
            let event = unsafe {
                std::ptr::read_unaligned(buf.as_ptr().add(offset) as *const libc::inotify_event)
            };
            if event.mask & libc::IN_Q_OVERFLOW != 0 {
                let _ = out_tx.send(RawMsg::Overflow {
                    detail: "inotify IN_Q_OVERFLOW".to_string(),
                });
                offset += event_size + event.len as usize;
                continue;
            }
            let watched = wd_to_path
                .lock()
                .ok()
                .and_then(|map| map.get(&event.wd).cloned());
            if event.mask & libc::IN_IGNORED != 0 {
                if let Ok(mut map) = wd_to_path.lock() {
                    map.remove(&event.wd);
                }
                offset += event_size + event.len as usize;
                continue;
            }
            if let Some(watched) = watched {
                if event.mask & (libc::IN_DELETE_SELF | libc::IN_MOVE_SELF) != 0 {
                    let _ = out_tx.send(RawMsg::Change {
                        path: watched,
                        hint: PathHint::Dir,
                    });
                    if let Ok(mut map) = wd_to_path.lock() {
                        map.remove(&event.wd);
                    }
                } else if event.len > 0 {
                    let name_start = offset + event_size;
                    let name_end = (name_start + event.len as usize).min(total);
                    let name_bytes = &buf[name_start..name_end];
                    let name_len = name_bytes
                        .iter()
                        .position(|byte| *byte == 0)
                        .unwrap_or(name_bytes.len());
                    if name_len > 0 {
                        let name = std::ffi::OsString::from_vec(name_bytes[..name_len].to_vec());
                        let _ = out_tx.send(RawMsg::Change {
                            path: watched.join(name),
                            hint: if event.mask & libc::IN_ISDIR != 0 {
                                PathHint::Dir
                            } else {
                                PathHint::File
                            },
                        });
                    }
                }
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
            | libc::IN_ATTRIB
            | libc::IN_DELETE_SELF
            | libc::IN_MOVE_SELF
            | libc::IN_ONLYDIR;
        let wd = unsafe { libc::inotify_add_watch(self.fd, c_path.as_ptr(), mask) };
        if wd < 0 {
            return Err(format!(
                "inotify_add_watch({}): {}",
                path.display(),
                std::io::Error::last_os_error()
            ));
        }
        if let Ok(mut map) = self.wd_to_path.lock() {
            map.insert(wd, path.to_path_buf());
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
        if let Ok(mut map) = self.wd_to_path.lock() {
            map.remove(&wd);
        }
    }

    fn shutdown(&mut self) {
        let ids: Vec<_> = self.id_to_wd.keys().cloned().collect();
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
