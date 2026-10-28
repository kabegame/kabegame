"""Read-only: current desktop subtree + Wallpaper Engine related processes."""

from __future__ import annotations

import ctypes
import ctypes.wintypes as wt
import json

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
TH32CS_SNAPPROCESS = 0x2


class PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [("dwSize", wt.DWORD), ("cntUsage", wt.DWORD),
                ("th32ProcessID", wt.DWORD), ("th32DefaultHeapID", ctypes.c_void_p),
                ("th32ModuleID", wt.DWORD), ("cntThreads", wt.DWORD),
                ("th32ParentProcessID", wt.DWORD), ("pcPriClassBase", ctypes.c_long),
                ("dwFlags", wt.DWORD), ("szExeFile", wt.WCHAR * 260)]


def procs():
    snap = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    entry = PROCESSENTRY32W()
    entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
    out = []
    if kernel32.Process32FirstW(snap, ctypes.byref(entry)):
        while True:
            out.append((entry.th32ProcessID, entry.th32ParentProcessID, entry.szExeFile))
            if not kernel32.Process32NextW(snap, ctypes.byref(entry)):
                break
    kernel32.CloseHandle(snap)
    return out


def pid_of(hwnd):
    pid = wt.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return pid.value


def cls(hwnd):
    buf = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(hwnd, buf, 256)
    return buf.value


rows = []


def walk(hwnd, depth, max_depth=3):
    rows.append({"hwnd": f"0x{hwnd:08X}", "depth": depth, "class": cls(hwnd), "pid": pid_of(hwnd)})
    if depth >= max_depth:
        return
    child = user32.GetWindow(hwnd, 5)
    while child:
        walk(child, depth + 1, max_depth)
        child = user32.GetWindow(child, 2)


for hwnd in (0x00010172,):
    walk(hwnd, 0)

we = [p for p in procs() if any(k in p[2].lower() for k in
      ("wallpaper", "webwall", "edgewall", "scene", "wpe"))]

print(json.dumps({"progman_subtree": rows, "we_processes": we}, ensure_ascii=False, indent=1))
