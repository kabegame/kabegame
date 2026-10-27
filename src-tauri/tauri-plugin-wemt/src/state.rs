//! Per-window bookkeeping.

use std::collections::HashMap;
use std::sync::Mutex;

use crate::models::{MonitorInfo, Rect};
use crate::platform::WindowSnapshot;

/// One mounted window plus everything needed to restore it.
#[derive(Debug, Clone, Copy)]
pub struct Mounted {
    pub host: isize,
    pub snapshot: WindowSnapshot,
    pub monitor: MonitorInfo,
    pub rect: Rect,
    pub style: u32,
    pub ex_style: u32,
}

/// Plugin state: one entry per window that this process mounted.
#[derive(Default)]
pub struct WemtState {
    mounted: Mutex<HashMap<isize, Mounted>>,
    failures: Mutex<HashMap<isize, String>>,
}

impl WemtState {
    pub fn insert(&self, hwnd: isize, mounted: Mounted) -> Result<(), ()> {
        let mut map = self.mounted.lock().map_err(|_| ())?;
        map.insert(hwnd, mounted);
        if let Ok(mut failures) = self.failures.lock() {
            failures.remove(&hwnd);
        }
        Ok(())
    }

    pub fn remove(&self, hwnd: isize) -> Result<Option<Mounted>, ()> {
        let mut map = self.mounted.lock().map_err(|_| ())?;
        Ok(map.remove(&hwnd))
    }

    pub fn get(&self, hwnd: isize) -> Result<Option<Mounted>, ()> {
        let map = self.mounted.lock().map_err(|_| ())?;
        Ok(map.get(&hwnd).copied())
    }

    pub fn has_host(&self, host: isize) -> bool {
        self.mounted
            .lock()
            .is_ok_and(|mounted| mounted.values().any(|entry| entry.host == host))
    }

    pub fn record_failure(&self, hwnd: isize, message: String) {
        if let Ok(mut failures) = self.failures.lock() {
            failures.insert(hwnd, message);
        }
    }

    pub fn clear_failure(&self, hwnd: isize) {
        if let Ok(mut failures) = self.failures.lock() {
            failures.remove(&hwnd);
        }
    }

    pub fn failure(&self, hwnd: isize) -> Option<String> {
        self.failures
            .lock()
            .ok()
            .and_then(|failures| failures.get(&hwnd).cloned())
    }
}
