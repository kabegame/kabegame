"""Read-only desktop window tree inspection (no injection, no target modification).

Enumerates top-level windows in z-order, plus the desktop (Progman/WorkerW) subtree,
and prints class, title, styles, rect, parent, and Wallpaper Engine properties.
"""

from __future__ import annotations

import ctypes
import ctypes.wintypes as wt
import json

user32 = ctypes.WinDLL("user32", use_last_error=True)

EnumWindowsProc = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)

GWL_STYLE = -16
GWL_EXSTYLE = -20

user32.EnumWindows.argtypes = [EnumWindowsProc, wt.LPARAM]
user32.EnumChildWindows.argtypes = [wt.HWND, EnumWindowsProc, wt.LPARAM]
user32.GetClassNameW.argtypes = [wt.HWND, wt.LPWSTR, ctypes.c_int]
user32.GetWindowTextW.argtypes = [wt.HWND, wt.LPWSTR, ctypes.c_int]
user32.GetWindowLongPtrW.restype = ctypes.c_void_p
user32.GetWindowLongPtrW.argtypes = [wt.HWND, ctypes.c_int]
user32.GetParent.argtypes = [wt.HWND]
user32.GetParent.restype = wt.HWND
user32.GetPropW.restype = ctypes.c_void_p
user32.GetPropW.argtypes = [wt.HWND, wt.LPCWSTR]
user32.IsWindowVisible.argtypes = [wt.HWND]


class RECT(ctypes.Structure):
    _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                ("right", ctypes.c_long), ("bottom", ctypes.c_long)]


def cls(hwnd: int) -> str:
    buf = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(hwnd, buf, 256)
    return buf.value


def title(hwnd: int) -> str:
    buf = ctypes.create_unicode_buffer(512)
    user32.GetWindowTextW(hwnd, buf, 512)
    return buf.value


def rect(hwnd: int):
    r = RECT()
    if not user32.GetWindowRect(hwnd, ctypes.byref(r)):
        return None
    return [r.left, r.top, r.right, r.bottom]


def info(hwnd: int, depth: int) -> dict:
    style = user32.GetWindowLongPtrW(hwnd, GWL_STYLE) or 0
    exstyle = user32.GetWindowLongPtrW(hwnd, GWL_EXSTYLE) or 0
    parent = user32.GetParent(hwnd)
    return {
        "hwnd": f"0x{hwnd:08X}",
        "depth": depth,
        "class": cls(hwnd),
        "title": title(hwnd),
        "style": f"0x{style & 0xFFFFFFFF:08X}",
        "exstyle": f"0x{exstyle & 0xFFFFFFFF:08X}",
        "visible": bool(user32.IsWindowVisible(hwnd)),
        "rect": rect(hwnd),
        "parent": f"0x{parent:08X}" if parent else None,
        "prop_parent": user32.GetPropW(hwnd, "WallpaperEngineParent"),
        "prop_wallpaper": user32.GetPropW(hwnd, "WallpaperEngineWallpaper"),
    }


def children(hwnd: int, depth: int, max_depth: int, out: list):
    if depth > max_depth:
        return
    kids: list[int] = []

    @EnumWindowsProc
    def cb(child, _lp):
        kids.append(child)
        return True

    user32.EnumChildWindows(hwnd, cb, 0)
    for k in kids[:200]:
        out.append(info(k, depth))
        children(k, depth + 1, max_depth, out)


top: list[dict] = []
top_hwnds: list[int] = []


@EnumWindowsProc
def top_cb(hwnd, _lp):
    top_hwnds.append(hwnd)
    top.append(info(hwnd, 0))
    return True


user32.EnumWindows(top_cb, 0)

result: dict = {"top_level": top, "desktop_subtree": [], "we_processes": []}

for hwnd in top_hwnds:
    if cls(hwnd) in ("Progman", "WorkerW"):
        result["desktop_subtree"].append(info(hwnd, 0))
        children(hwnd, 1, 3, result["desktop_subtree"])

import subprocess
try:
    ps = subprocess.run(
        ["powershell", "-NoProfile", "-Command",
         "Get-Process wallpaper64,wallpaper32,webwallpaper64,edgewallpaper64,"
         "wallpaperui,kabegame -ErrorAction SilentlyContinue | "
         "Select-Object Id,ProcessName,MainWindowTitle | ConvertTo-Json -Compress"],
        capture_output=True, text=True, timeout=30)
    result["we_processes_raw"] = ps.stdout.strip()
except Exception as exc:  # noqa: BLE001
    result["we_processes_raw"] = f"error: {exc}"

print(json.dumps(result, ensure_ascii=False, indent=1))
