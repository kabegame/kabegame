"""
顶层窗口与测试窗口。

- 测试窗口：WPE 为 `openWallpaper -playInWindow <名字>` 建的顶层窗口，类名 `WPEOverlappedWallpaper`，标题就是名字。
- 矩形一律按物理像素取：本进程在导入时设成 per-monitor DPI aware（v2），GetWindowRect / ClientToScreen
  不再被 DPI 虚拟化。WPE 自己是 DPI aware 的，`-width W -height H` 就是客户区的物理像素。
"""

from __future__ import annotations

import ctypes
import ctypes.wintypes as wt
import os
import time
from typing import Any, Iterable

from .common import wait_until

TEST_WINDOW_CLASS = "WPEOverlappedWallpaper"

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

HWND = ctypes.c_void_p
ENUM_PROC = ctypes.WINFUNCTYPE(wt.BOOL, HWND, wt.LPARAM)

user32.EnumWindows.argtypes = [ENUM_PROC, wt.LPARAM]
user32.EnumChildWindows.argtypes = [HWND, ENUM_PROC, wt.LPARAM]
user32.GetClassNameW.argtypes = [HWND, wt.LPWSTR, ctypes.c_int]
user32.GetWindowTextW.argtypes = [HWND, wt.LPWSTR, ctypes.c_int]
user32.GetWindowTextLengthW.argtypes = [HWND]
user32.GetWindowThreadProcessId.argtypes = [HWND, ctypes.POINTER(wt.DWORD)]
user32.GetWindowThreadProcessId.restype = wt.DWORD
user32.IsWindow.argtypes = [HWND]
user32.IsWindowVisible.argtypes = [HWND]
user32.IsIconic.argtypes = [HWND]
user32.GetWindowRect.argtypes = [HWND, ctypes.POINTER(wt.RECT)]
user32.GetClientRect.argtypes = [HWND, ctypes.POINTER(wt.RECT)]
user32.ClientToScreen.argtypes = [HWND, ctypes.POINTER(wt.POINT)]
user32.GetForegroundWindow.restype = HWND
user32.GetParent.argtypes = [HWND]
user32.GetParent.restype = HWND
user32.GetAncestor.argtypes = [HWND, wt.UINT]
user32.GetAncestor.restype = HWND
user32.PostMessageW.argtypes = [HWND, wt.UINT, wt.WPARAM, wt.LPARAM]


def _set_dpi_aware() -> str:
    """per-monitor DPI aware（v2），取不到就退到 v1。必须在本进程建任何窗口之前调用。"""
    try:
        user32.SetProcessDpiAwarenessContext.argtypes = [ctypes.c_void_p]
        if user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4)):  # PER_MONITOR_AWARE_V2
            return "per-monitor-v2"
    except AttributeError:
        pass
    try:
        if ctypes.WinDLL("shcore").SetProcessDpiAwareness(2) == 0:  # PROCESS_PER_MONITOR_DPI_AWARE
            return "per-monitor"
    except (AttributeError, OSError):
        pass
    return "unchanged"


DPI_AWARENESS = _set_dpi_aware()


def _hwnd(value) -> int:
    return int(value or 0)


def enum_top() -> list[int]:
    found: list[int] = []

    def cb(hwnd, _):
        found.append(_hwnd(hwnd))
        return True

    user32.EnumWindows(ENUM_PROC(cb), 0)
    return found


def enum_children(parent: int) -> list[int]:
    found: list[int] = []

    def cb(hwnd, _):
        found.append(_hwnd(hwnd))
        return True

    user32.EnumChildWindows(parent, ENUM_PROC(cb), 0)
    return found


def class_of(hwnd: int) -> str:
    buf = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(hwnd, buf, 256)
    return buf.value


def title_of(hwnd: int) -> str:
    length = user32.GetWindowTextLengthW(hwnd)
    buf = ctypes.create_unicode_buffer(max(length + 1, 256))
    user32.GetWindowTextW(hwnd, buf, len(buf))
    return buf.value


def pid_of(hwnd: int) -> int:
    pid = wt.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return pid.value


def exists(hwnd: int | None) -> bool:
    return bool(hwnd) and bool(user32.IsWindow(hwnd))


def window_rect(hwnd: int) -> list[int] | None:
    """[x, y, 宽, 高]，物理像素，含边框。"""
    r = wt.RECT()
    if not user32.GetWindowRect(hwnd, ctypes.byref(r)):
        return None
    return [r.left, r.top, r.right - r.left, r.bottom - r.top]


def client_rect(hwnd: int) -> list[int] | None:
    """客户区在屏幕上的 [x, y, 宽, 高]，物理像素。"""
    r = wt.RECT()
    if not user32.GetClientRect(hwnd, ctypes.byref(r)):
        return None
    p = wt.POINT(0, 0)
    if not user32.ClientToScreen(hwnd, ctypes.byref(p)):
        return None
    return [p.x, p.y, r.right - r.left, r.bottom - r.top]


# ==================== 显示器与边框（无边框测试窗口用） ====================


class _MONITORINFO(ctypes.Structure):
    _fields_ = [("cbSize", wt.DWORD), ("rcMonitor", wt.RECT), ("rcWork", wt.RECT), ("dwFlags", wt.DWORD)]


user32.MonitorFromPoint.argtypes = [wt.POINT, wt.DWORD]
user32.MonitorFromPoint.restype = ctypes.c_void_p
user32.GetMonitorInfoW.argtypes = [ctypes.c_void_p, ctypes.POINTER(_MONITORINFO)]

# WPE 的测试窗口是 WS_OVERLAPPEDWINDOW（标题栏 + 粗边框）
WS_OVERLAPPEDWINDOW = 0x00CF0000


def monitor_at(x: int, y: int) -> dict[str, Any]:
    """点 (x, y) 所在（或最近）的显示器：rect / work 是 [左, 上, 右, 下]，物理像素；dpi 是有效 DPI。"""
    handle = user32.MonitorFromPoint(wt.POINT(int(x), int(y)), 2)  # MONITOR_DEFAULTTONEAREST
    info = _MONITORINFO()
    info.cbSize = ctypes.sizeof(_MONITORINFO)
    if not handle or not user32.GetMonitorInfoW(handle, ctypes.byref(info)):
        raise OSError(f"取不到 ({x}, {y}) 所在显示器的信息")
    dpi_x, dpi_y = wt.UINT(), wt.UINT()
    try:
        if ctypes.WinDLL("shcore").GetDpiForMonitor(ctypes.c_void_p(handle), 0, ctypes.byref(dpi_x),
                                                    ctypes.byref(dpi_y)) != 0:
            dpi_x.value = 96
    except (AttributeError, OSError):
        dpi_x.value = 96
    m, w = info.rcMonitor, info.rcWork
    return {"rect": [m.left, m.top, m.right, m.bottom], "work": [w.left, w.top, w.right, w.bottom],
            "dpi": int(dpi_x.value)}


def frame_extra(dpi: int) -> tuple[int, int]:
    """WS_OVERLAPPEDWINDOW 在这个 DPI 下比客户区多出的宽、高（边框 + 标题栏，AdjustWindowRectExForDpi）。

    WPE 的 -borderless 窗口照样按带边框窗口算尺寸，只是换成无边框样式：请求 -width W -height H 得到的整个窗口
    （= 客户区）是 (W + 宽, H + 高)。2026-11-14 实测 144 DPI 下多出 22×56，和这里算的相同。
    """
    r = wt.RECT(0, 0, 100, 100)
    try:
        user32.AdjustWindowRectExForDpi.argtypes = [ctypes.POINTER(wt.RECT), wt.DWORD, wt.BOOL, wt.DWORD, wt.UINT]
        ok = user32.AdjustWindowRectExForDpi(ctypes.byref(r), WS_OVERLAPPEDWINDOW, False, 0, int(dpi))
    except AttributeError:
        user32.AdjustWindowRectEx.argtypes = [ctypes.POINTER(wt.RECT), wt.DWORD, wt.BOOL, wt.DWORD]
        ok = user32.AdjustWindowRectEx(ctypes.byref(r), WS_OVERLAPPEDWINDOW, False, 0)
    if not ok:
        raise OSError("AdjustWindowRectExForDpi 失败")
    return r.right - r.left - 100, r.bottom - r.top - 100


def image_of(pid: int) -> str | None:
    from ..replay import open_process, process_image  # 进程句柄工具在 replay.py
    handle = open_process(pid)
    if handle is None:
        return None
    try:
        image = process_image(handle)
        return os.path.basename(image) if image else None
    finally:
        kernel32.CloseHandle(ctypes.c_void_p(handle))


def describe(hwnd: int | None) -> dict[str, Any] | None:
    if not hwnd:
        return None
    pid = pid_of(hwnd)
    return {"hwnd": hwnd, "pid": pid, "exe": image_of(pid), "class": class_of(hwnd), "title": title_of(hwnd),
            "rect": window_rect(hwnd)}


def foreground() -> int:
    return _hwnd(user32.GetForegroundWindow())


# ==================== 测试窗口 ====================


def test_windows(wpe_pids: Iterable[int] | None = None) -> list[dict[str, Any]]:
    """WPE 进程的全部测试窗口（WPEOverlappedWallpaper 顶层窗口）。wpe_pids 为 None 时不限进程。"""
    pids = None if wpe_pids is None else set(wpe_pids)
    found = []
    for hwnd in enum_top():
        if class_of(hwnd) != TEST_WINDOW_CLASS:
            continue
        pid = pid_of(hwnd)
        if pids is not None and pid not in pids:
            continue
        found.append(test_window_info(hwnd, pid))
    return found


def test_window_info(hwnd: int, pid: int | None = None) -> dict[str, Any]:
    client = client_rect(hwnd)
    return {
        "name": title_of(hwnd),
        "hwnd": hwnd,
        "pid": pid if pid is not None else pid_of(hwnd),
        "rect": window_rect(hwnd),
        "client": client,
        "size": f"{client[2]}x{client[3]}" if client else None,
        "visible": bool(user32.IsWindowVisible(hwnd)),
        "minimized": bool(user32.IsIconic(hwnd)),
    }


def find_test_window(name: str, wpe_pids: Iterable[int] | None = None) -> dict[str, Any] | None:
    for info in test_windows(wpe_pids):
        if info["name"] == name:
            return info
    return None


def wait_test_window(name: str, timeout: float, wpe_pids: Iterable[int] | None = None) -> dict[str, Any] | None:
    pids = None if wpe_pids is None else list(wpe_pids)
    return wait_until(lambda: find_test_window(name, pids), timeout, 0.1)


def wait_gone(hwnd: int, timeout: float) -> bool:
    return bool(wait_until(lambda: not exists(hwnd), timeout, 0.1))


def settle_foreground(before: int, seconds: float = 0.5) -> dict[str, Any]:
    """开窗前后的前台窗口：before 是开窗前记下的 hwnd；稍等再看一次，报出是否被换掉。"""
    time.sleep(seconds)
    after = foreground()
    return {"changed": after != before, "before": describe(before), "after": describe(after)}
