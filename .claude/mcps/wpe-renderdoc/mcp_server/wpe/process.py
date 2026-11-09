"""
WPE 进程：列表、完整性级别、是否已注入、崩溃标记、普通启动、注入、正常退出、设置界面、桌面壁纸窗口。

从 ignore/wpe-mcp/exp/exp.py 拷来改写（exp.py 不动）：
- 进程列表改用 toolhelp 快照，不再跑 tasklist；命令行经 NtQueryInformationProcess 读；
- 是否已注入只看进程里有没有加载 renderdoc.dll，不连 RenderDoc 的目标；
- 普通启动经 WMI（Win32_Process.Create），WPE 不在本 MCP 的进程树和作业里，MCP 退出后照常运行；
- renderdoccmd 一律不带控制台起（CREATE_NO_WINDOW + SW_HIDE），否则会弹 Windows Terminal 抢前台；
- 正常退出走托盘「退出」同一条命令：向该 PID 的 WPEEventWindow 发 WM_COMMAND 0x9c4a，只等、不强杀。
- 进程探活一律 OpenProcess + WaitForSingleObject。不能用 os.kill(pid, 0)：Windows 上它会结束对方进程。
"""

from __future__ import annotations

import ctypes
import ctypes.wintypes as wt
import os
import subprocess
import time
import winreg
from typing import Any

from .. import paths
from ..replay import (
    PROCESS_QUERY_LIMITED_INFORMATION,
    SYNCHRONIZE,
    WAIT_TIMEOUT,
    process_command_line,
    process_created,
    process_image,
)
from . import windows as win
from .common import WpeError, filetime_iso, wait_until

WPE_IMAGE = "wallpaper64.exe"
UI_IMAGE = "wallpaperui.exe"
EVENT_WINDOW_CLASS = "WPEEventWindow"
DESKTOP_WINDOW_CLASS = "WPEDesktopDX11Window"
RENDERDOC_DLL = "renderdoc.dll"

REG_KEY = r"Software\WallpaperEngine"
REG_FLAG = "faultyShutdown"

WM_COMMAND = 0x0111
TRAY_QUIT = 0x9C4A  # 托盘菜单「退出」

CREATE_NO_WINDOW = 0x08000000
STARTF_USESHOWWINDOW = 0x1
SW_HIDE = 0

PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_VM_READ = 0x0010
TOKEN_QUERY = 0x0008
TokenIntegrityLevel = 25
TH32CS_SNAPPROCESS = 0x2
TH32CS_SNAPMODULE = 0x8
TH32CS_SNAPMODULE32 = 0x10
ERROR_ACCESS_DENIED = 5
ERROR_BAD_LENGTH = 24
ERROR_PARTIAL_COPY = 299
INVALID_HANDLE = ctypes.c_void_p(-1).value

kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)

kernel32.OpenProcess.restype = ctypes.c_void_p
kernel32.OpenProcess.argtypes = [wt.DWORD, wt.BOOL, wt.DWORD]
kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
kernel32.WaitForSingleObject.restype = wt.DWORD
kernel32.WaitForSingleObject.argtypes = [ctypes.c_void_p, wt.DWORD]
kernel32.CreateToolhelp32Snapshot.restype = ctypes.c_void_p
kernel32.CreateToolhelp32Snapshot.argtypes = [wt.DWORD, wt.DWORD]
advapi32.OpenProcessToken.argtypes = [ctypes.c_void_p, wt.DWORD, ctypes.POINTER(ctypes.c_void_p)]
advapi32.GetTokenInformation.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, wt.DWORD,
                                         ctypes.POINTER(wt.DWORD)]
advapi32.GetSidSubAuthorityCount.argtypes = [ctypes.c_void_p]
advapi32.GetSidSubAuthorityCount.restype = ctypes.POINTER(ctypes.c_ubyte)
advapi32.GetSidSubAuthority.argtypes = [ctypes.c_void_p, wt.DWORD]
advapi32.GetSidSubAuthority.restype = ctypes.POINTER(wt.DWORD)


class PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [("dwSize", wt.DWORD), ("cntUsage", wt.DWORD), ("th32ProcessID", wt.DWORD),
                ("th32DefaultHeapID", ctypes.c_size_t), ("th32ModuleID", wt.DWORD), ("cntThreads", wt.DWORD),
                ("th32ParentProcessID", wt.DWORD), ("pcPriClassBase", ctypes.c_long), ("dwFlags", wt.DWORD),
                ("szExeFile", ctypes.c_wchar * 260)]


class MODULEENTRY32W(ctypes.Structure):
    _fields_ = [("dwSize", wt.DWORD), ("th32ModuleID", wt.DWORD), ("th32ProcessID", wt.DWORD),
                ("GlblcntUsage", wt.DWORD), ("ProccntUsage", wt.DWORD), ("modBaseAddr", ctypes.c_void_p),
                ("modBaseSize", wt.DWORD), ("hModule", ctypes.c_void_p), ("szModule", ctypes.c_wchar * 256),
                ("szExePath", ctypes.c_wchar * 260)]


kernel32.Process32FirstW.argtypes = [ctypes.c_void_p, ctypes.POINTER(PROCESSENTRY32W)]
kernel32.Process32NextW.argtypes = [ctypes.c_void_p, ctypes.POINTER(PROCESSENTRY32W)]
kernel32.Module32FirstW.argtypes = [ctypes.c_void_p, ctypes.POINTER(MODULEENTRY32W)]
kernel32.Module32NextW.argtypes = [ctypes.c_void_p, ctypes.POINTER(MODULEENTRY32W)]


def _open(pid: int, access: int = SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION) -> int | None:
    return kernel32.OpenProcess(access, False, pid) or None


def _close(handle: int | None) -> None:
    if handle:
        kernel32.CloseHandle(handle)


# ==================== 进程列表 ====================


def snapshot_processes() -> list[tuple[int, int, str]]:
    """(进程号, 父进程号, 映像名)。"""
    snap = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if snap in (None, INVALID_HANDLE):
        raise WpeError(f"CreateToolhelp32Snapshot 失败（{ctypes.get_last_error()}）")
    found = []
    try:
        entry = PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(entry)
        ok = kernel32.Process32FirstW(snap, ctypes.byref(entry))
        while ok:
            found.append((entry.th32ProcessID, entry.th32ParentProcessID, entry.szExeFile))
            ok = kernel32.Process32NextW(snap, ctypes.byref(entry))
    finally:
        _close(snap)
    return found


def pids_of(image: str) -> list[int]:
    image = image.lower()
    return sorted(pid for pid, _, exe in snapshot_processes() if exe.lower() == image)


def process_info(pid: int) -> dict[str, Any]:
    """进程号、命令行、创建时刻；打不开的报出来。"""
    handle = _open(pid)
    if handle is None:
        return {"pid": pid, "open_error": ctypes.get_last_error()}
    try:
        alive = kernel32.WaitForSingleObject(handle, 0) == WAIT_TIMEOUT
        created = process_created(handle)
        return {"pid": pid, "alive": alive, "image": process_image(handle),
                "command_line": process_command_line(handle), "created": created,
                "created_at": filetime_iso(created)}
    finally:
        _close(handle)


def classify(command_line: str | None) -> str:
    """wallpaper64 进程的角色：main（主实例）、control（-control 的短命进程）、screensaver。"""
    text = (command_line or "").lower()
    if " -control" in text:
        return "control"
    if "-screensaver" in text:
        return "screensaver"
    return "main"


def wpe_processes() -> list[dict[str, Any]]:
    """全部 wallpaper64.exe：进程号、命令行、创建时刻、角色、完整性级别。"""
    result = []
    for pid in pids_of(WPE_IMAGE):
        info = process_info(pid)
        info["role"] = classify(info.get("command_line"))
        info["integrity"] = integrity_level(pid)
        result.append(info)
    return result


def main_processes() -> list[dict[str, Any]]:
    """主实例（去掉 -control 的短命进程与屏保实例）。正常只有一个。"""
    return [p for p in wpe_processes() if p["role"] == "main"]


def main_pid() -> int | None:
    """唯一的主实例进程号；没有返回 None；多于一个报错（不该发生，不猜）。"""
    mains = main_processes()
    if not mains:
        return None
    if len(mains) > 1:
        raise WpeError(f"有 {len(mains)} 个 wallpaper64 主实例：{[p['pid'] for p in mains]}，不知道该用哪个，停止")
    return mains[0]["pid"]


def alive(pid: int) -> bool:
    handle = _open(pid)
    if handle is None:
        return ctypes.get_last_error() == ERROR_ACCESS_DENIED
    try:
        return kernel32.WaitForSingleObject(handle, 0) == WAIT_TIMEOUT
    finally:
        _close(handle)


def children_of(pid: int) -> list[dict[str, Any]]:
    return [{"pid": p, "image": exe} for p, ppid, exe in snapshot_processes() if ppid == pid]


# ==================== 权限与注入状态 ====================


def integrity_level(pid: int) -> str | None:
    """进程的完整性级别：low / medium / medium-plus / high / system；读不到返回 None。"""
    handle = _open(pid, PROCESS_QUERY_LIMITED_INFORMATION)
    if handle is None:
        return None
    token = ctypes.c_void_p()
    try:
        if not advapi32.OpenProcessToken(handle, TOKEN_QUERY, ctypes.byref(token)):
            return None
        size = wt.DWORD(0)
        advapi32.GetTokenInformation(token, TokenIntegrityLevel, None, 0, ctypes.byref(size))
        buf = ctypes.create_string_buffer(size.value)
        if not advapi32.GetTokenInformation(token, TokenIntegrityLevel, buf, size, ctypes.byref(size)):
            return None
        sid = ctypes.cast(buf, ctypes.POINTER(ctypes.c_void_p))[0]  # TOKEN_MANDATORY_LABEL.Label.Sid
        count = advapi32.GetSidSubAuthorityCount(sid)[0]
        rid = advapi32.GetSidSubAuthority(sid, count - 1)[0]
    finally:
        _close(token.value)
        _close(handle)
    names = {0x0000: "untrusted", 0x1000: "low", 0x2000: "medium", 0x2100: "medium-plus", 0x3000: "high",
             0x4000: "system"}
    return names.get(rid, hex(rid))


def modules_of(pid: int) -> tuple[list[str] | None, str | None]:
    """进程加载的模块名；失败返回 (None, 原因)。权限不够（对方以管理员权限运行）时报出来。"""
    for _ in range(20):
        snap = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid)
        if snap not in (None, INVALID_HANDLE):
            break
        error = ctypes.get_last_error()
        if error == ERROR_BAD_LENGTH:  # 对方正在加载模块，按文档重试
            time.sleep(0.05)
            continue
        if error == ERROR_ACCESS_DENIED:
            return None, "拒绝访问：打不开进程（可能以管理员权限运行）"
        return None, f"枚举模块失败（错误 {error}）"
    else:
        return None, "枚举模块失败（反复 ERROR_BAD_LENGTH）"
    names = []
    try:
        entry = MODULEENTRY32W()
        entry.dwSize = ctypes.sizeof(entry)
        ok = kernel32.Module32FirstW(snap, ctypes.byref(entry))
        while ok:
            names.append(entry.szModule)
            ok = kernel32.Module32NextW(snap, ctypes.byref(entry))
    finally:
        _close(snap)
    return names, None


def injected(pid: int) -> tuple[bool | None, str | None]:
    """是否已加载 renderdoc.dll。None 表示查不了（附原因）。"""
    names, error = modules_of(pid)
    if names is None:
        return None, error
    return any(n.lower() == RENDERDOC_DLL for n in names), None


# ==================== 崩溃标记 ====================


def crash_flag() -> int | None:
    """HKCU\\Software\\WallpaperEngine\\faultyShutdown；没有这个值返回 None。"""
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, REG_KEY) as key:
            return winreg.QueryValueEx(key, REG_FLAG)[0]
    except OSError:
        return None


def set_crash_flag(value: int) -> None:
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, REG_KEY, 0, winreg.KEY_SET_VALUE) as key:
        winreg.SetValueEx(key, REG_FLAG, 0, winreg.REG_DWORD, value)


# ==================== 窗口 ====================


def event_window(pid: int) -> int | None:
    """该 PID 的 WPEEventWindow（不可见、无标题的顶层窗口）。"""
    for hwnd in win.enum_top():
        if win.class_of(hwnd) == EVENT_WINDOW_CLASS and win.pid_of(hwnd) == pid:
            return hwnd
    return None


def desktop_windows(pid: int | None = None) -> list[dict[str, Any]]:
    """桌面壁纸窗口：WorkerW / Progman 下的 WPEDesktopDX11Window。"""
    found = []
    for top in win.enum_top():
        if win.class_of(top) not in ("WorkerW", "Progman"):
            continue
        for hwnd in win.enum_children(top):
            if win.class_of(hwnd) != DESKTOP_WINDOW_CLASS:
                continue
            owner = win.pid_of(hwnd)
            if pid is not None and owner != pid:
                continue
            parent = win.user32.GetParent(hwnd) or 0
            found.append({"hwnd": hwnd, "pid": owner, "title": win.title_of(hwnd), "rect": win.window_rect(hwnd),
                          "parent_class": win.class_of(parent) if parent else None, "top_class": win.class_of(top)})
    return found


def settings_ui() -> list[dict[str, Any]]:
    """开着的设置界面：命令行带 `-window settings` 的 wallpaperui.exe。"""
    found = []
    for pid in pids_of(UI_IMAGE):
        info = process_info(pid)
        command = (info.get("command_line") or "").lower()
        if "-window settings" in command:
            found.append({"pid": pid, "command_line": info.get("command_line")})
    return found


def ui_processes() -> list[dict[str, Any]]:
    """全部 wallpaperui.exe（浏览、设置、编辑器等界面）。"""
    return [{"pid": pid, "command_line": process_info(pid).get("command_line")} for pid in pids_of(UI_IMAGE)]


# ==================== 启动、注入、退出 ====================


def spawn_silent() -> int:
    """经 WMI 普通启动 `wallpaper64.exe -silent`，返回进程号。WPE 不在本进程树里，MCP 退出后照常运行。"""
    command = f'"{paths.wpe_exe()}" -silent'
    script = ('$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments '
              '@{CommandLine=$env:KB_CMD; CurrentDirectory=$env:KB_CWD}; '
              'if ($r.ReturnValue -ne 0) { Write-Output ("ret=" + $r.ReturnValue); exit 1 }; '
              'Write-Output $r.ProcessId')
    env = dict(os.environ, KB_CMD=command, KB_CWD=paths.wpe_dir())
    result = subprocess.run(['powershell', '-NoProfile', '-NonInteractive', '-Command', script],
                            stdin=subprocess.DEVNULL, capture_output=True, env=env, timeout=60,
                            creationflags=CREATE_NO_WINDOW)
    out = result.stdout.decode("utf-8", "replace").strip()
    if result.returncode != 0 or not out.splitlines() or not out.splitlines()[-1].strip().isdigit():
        raise WpeError(f"WMI 启动 WPE 失败（{result.returncode}）：{out[-300:]} "
                       f"{result.stderr.decode('utf-8', 'replace')[-300:]}")
    return int(out.splitlines()[-1].strip())


def inject(pid: int) -> dict[str, Any]:
    """`renderdoccmd inject --PID=<pid> -c <模板>`，不带控制台；注入完 renderdoccmd 就返回。"""
    template = paths.capture_template()
    os.makedirs(os.path.dirname(template), exist_ok=True)
    startup = subprocess.STARTUPINFO()
    startup.dwFlags |= STARTF_USESHOWWINDOW
    startup.wShowWindow = SW_HIDE
    t0 = time.monotonic()
    result = subprocess.run([paths.renderdoccmd(), "inject", f"--PID={pid}", "-c", template],
                            stdin=subprocess.DEVNULL, capture_output=True, timeout=60,
                            creationflags=CREATE_NO_WINDOW, startupinfo=startup, cwd=paths.renderdoc_dir())
    return {"code": result.returncode, "took_s": round(time.monotonic() - t0, 2),
            "stdout": result.stdout.decode("utf-8", "replace")[-400:].strip(),
            "stderr": result.stderr.decode("utf-8", "replace")[-300:].strip()}


def wait_started(pid: int, expect_desktop: bool, timeout: float = 30.0, settle: float = 2.0) -> dict[str, Any]:
    """等刚启动的 WPE：事件窗口出现；选了桌面壁纸时再等桌面壁纸窗口出现；然后再稳 settle 秒。"""
    t0 = time.monotonic()
    report: dict[str, Any] = {"pid": pid, "waited_for": "desktop" if expect_desktop else "event_window"}
    hwnd = wait_until(lambda: event_window(pid) or (None if alive(pid) else -1), timeout, 0.1)
    if hwnd == -1 or not alive(pid):
        raise WpeError(f"WPE {pid} 启动后很快退出了（事件窗口出现前）")
    if not hwnd:
        raise WpeError(f"WPE {pid} 在 {timeout:g} s 内没有建出事件窗口")
    report["event_window_s"] = round(time.monotonic() - t0, 2)
    if expect_desktop:
        desk = wait_until(lambda: desktop_windows(pid), timeout, 0.2)
        if desk:
            report["desktop_s"] = round(time.monotonic() - t0, 2)
        else:
            report["desktop_s"] = None
            report["warning"] = f"{timeout:g} s 内没等到桌面壁纸窗口，按事件窗口继续"
    time.sleep(settle)
    if not alive(pid):
        raise WpeError(f"WPE {pid} 启动后 {round(time.monotonic() - t0, 1)} s 退出了")
    report["settled_s"] = round(time.monotonic() - t0, 2)
    report["desktop"] = desktop_windows(pid)
    return report


def quit_wpe(pid: int, timeout: float = 20.0) -> dict[str, Any]:
    """正常退出：向该 PID 的 WPEEventWindow 发托盘「退出」（WM_COMMAND 0x9c4a），等进程完全退出。不强杀。"""
    handle = _open(pid)
    if handle is None:
        raise WpeError(f"打不开 WPE 进程 {pid}（错误 {ctypes.get_last_error()}）")
    try:
        image = process_image(handle) or ""
        if os.path.basename(image).lower() != WPE_IMAGE:
            raise WpeError(f"进程 {pid} 不是 {WPE_IMAGE}：{image}")
        hwnd = event_window(pid)
        if not hwnd:
            raise WpeError(f"找不到 WPE {pid} 的 {EVENT_WINDOW_CLASS}，发不了退出命令")
        t0 = time.monotonic()
        if not win.user32.PostMessageW(hwnd, WM_COMMAND, TRAY_QUIT, 0):
            raise WpeError(f"PostMessage 失败（错误 {ctypes.get_last_error()}，WPE 以更高权限运行时会被 UIPI 拦下）")
        code = kernel32.WaitForSingleObject(handle, int(timeout * 1000))
        took = round(time.monotonic() - t0, 2)
    finally:
        _close(handle)
    if code == WAIT_TIMEOUT:
        return {"posted": True, "exited": False, "timeout_s": timeout}
    # 界面进程（浏览、设置）随主进程退出，等一会儿再看有没有残留
    leftover = wait_until(lambda: not pids_of(UI_IMAGE), 10, 0.3)
    return {"posted": True, "exited": True, "took_s": took, "ui_left": [] if leftover else pids_of(UI_IMAGE)}


def wait_gone(pid: int, timeout: float) -> bool:
    handle = _open(pid, SYNCHRONIZE)
    if handle is None:
        return True
    try:
        return kernel32.WaitForSingleObject(handle, int(timeout * 1000)) != WAIT_TIMEOUT
    finally:
        _close(handle)
