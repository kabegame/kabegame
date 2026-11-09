"""
`wallpaper64.exe -control <命令>`。

控制进程是 WPE 的第二个实例：找到主实例的 WPEEventWindow 就把命令经 WM_COPYDATA 发过去，然后退出。
主实例不在时它会自己变成主实例并弹出浏览界面；主实例在但事件窗口还没建好（正在启动或正在退出）时，
它甚至会结束主实例（rea-wpe-exit.md Q5）。所以发命令前必须确认：恰好一个主实例，且它的事件窗口在。
命令行不能带 -silent：已有实例时带 -silent 的第二实例直接退出，命令不会发出去。
"""

from __future__ import annotations

import subprocess
import time
from typing import Any

from .. import paths
from . import process
from .common import WpeError


def control(command: str, timeout: float = 30.0) -> dict[str, Any]:
    pid = process.main_pid()
    if pid is None:
        raise WpeError("WPE 没在跑，不发 -control（否则控制进程会自己变成主实例并弹出界面）。先 ensure_running")
    if not process.event_window(pid):
        raise WpeError(f"WPE {pid} 的事件窗口不在（可能正在启动或退出），不发 -control")
    line = f'"{paths.wpe_exe()}" -control {command}'
    t0 = time.monotonic()
    # 整串交给 CreateProcess，引号与 RAW~(...)~END 原样保留
    result = subprocess.run(line, stdin=subprocess.DEVNULL, capture_output=True, timeout=timeout,
                            cwd=paths.wpe_dir())
    took = round(time.monotonic() - t0, 2)
    if result.returncode != 0:
        raise WpeError(f"-control 返回 {result.returncode}：{line}")
    return {"wpe_pid": pid, "command": command, "took_s": took}
