"""Read-only: resolve owning process of the Wallpaper Engine windows."""

from __future__ import annotations

import ctypes
import ctypes.wintypes as wt
import json

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

user32.GetWindowThreadProcessId.argtypes = [wt.HWND, ctypes.POINTER(wt.DWORD)]
user32.GetWindow.argtypes = [wt.HWND, wt.UINT]
user32.GetWindow.restype = wt.HWND
user32.GetParent.argtypes = [wt.HWND]
user32.GetParent.restype = wt.HWND
kernel32.OpenProcess.restype = wt.HANDLE
kernel32.OpenProcess.argtypes = [wt.DWORD, wt.BOOL, wt.DWORD]
kernel32.QueryFullProcessImageNameW.argtypes = [
    wt.HANDLE, wt.DWORD, wt.LPWSTR, ctypes.POINTER(wt.DWORD)
]


def pid_of(hwnd: int) -> int:
    pid = wt.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return pid.value


def image(pid: int) -> str:
    h = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not h:
        return f"<open failed {ctypes.get_last_error()}>"
    try:
        buf = ctypes.create_unicode_buffer(1024)
        size = wt.DWORD(1024)
        if kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
            return buf.value
        return f"<query failed {ctypes.get_last_error()}>"
    finally:
        kernel32.CloseHandle(h)


def cls(hwnd: int) -> str:
    buf = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(hwnd, buf, 256)
    return buf.value


# Known handles from the previous snapshot; re-resolve the tree from Progman.
progman = 0x00010172
rows = []


def walk(hwnd: int, depth: int, max_depth: int = 3):
    pid = pid_of(hwnd)
    rows.append({"hwnd": f"0x{hwnd:08X}", "depth": depth, "class": cls(hwnd),
                 "pid": pid, "image": image(pid)})
    if depth >= max_depth:
        return
    child = user32.GetWindow(hwnd, 5)  # GW_CHILD
    while child:
        walk(child, depth + 1, max_depth)
        child = user32.GetWindow(child, 2)  # GW_HWNDNEXT


walk(progman, 0)

print(json.dumps(rows, ensure_ascii=False, indent=1))
