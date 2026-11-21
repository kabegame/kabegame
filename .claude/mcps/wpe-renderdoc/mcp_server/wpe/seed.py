"""
给 WPE 下一个新建的场景渲染器换 MT19937 种子（open_wallpaper / capture_wallpaper / capture_sweep 的 `seed`）。

让 WPE 与 Kabegame 的回放吃同一串随机数，逐粒子对照随机发射：回放侧用 `std::mt19937(种子)`
（kabegame-dev 的 `replay.mt19937`、kbp 的 `mt19937`）。

原理与协议见 `frida_input/seed.py`：驱动子进程（独立的小 uv 工程）挂进 WPE，在渲染器构造里把种子换掉，
一次性、只改挂钩之后第一个构造的渲染器；命中后读回 x[0] / x[1] 核对，随即退出（Frida 随进程退出卸钩）。
桌面壁纸与已经开着的窗口不受影响。

用法（session.open_wallpaper 里）：开窗之前 `arm(pid, seed, timeout)` 挂钩并等 armed，发 openWallpaper，
窗口出现后 `wait_hit()` 等命中。内部函数只认 pid，不依赖窗口表。
"""

from __future__ import annotations

import atexit
import json
import os
import queue
import shutil
import subprocess
import threading
import time
from typing import Any

from .common import WpeError
from .input import FRIDA_DIR, READY_TIMEOUT, _kill_tree

U32 = 0xFFFFFFFF


# ==================== 纯函数 ====================


def parse_seed(value: Any) -> int:
    """种子：0 … 2^32 − 1 的整数，或十进制 / 0x 十六进制字符串。其它（布尔、小数、越界）报错。"""
    if isinstance(value, bool):
        raise WpeError(f"seed 要是 0 … 4294967295 的整数，收到 {value!r}")
    if isinstance(value, str):
        try:
            value = int(value.strip(), 0)
        except ValueError:
            raise WpeError(f"seed 不是整数：{value!r}") from None
    if not isinstance(value, int):
        raise WpeError(f"seed 要是 0 … 4294967295 的整数，收到 {value!r}")
    if not 0 <= value <= U32:
        raise WpeError(f"seed 超出 u32 范围（0 … 4294967295）：{value}")
    return value


def expected_x1(seed: int) -> int:
    """std::mt19937 初始化的 x[1] = 1812433253 · (x0 ^ (x0 >> 30)) + 1 (mod 2^32)。"""
    seed &= U32
    return (1812433253 * (seed ^ (seed >> 30)) + 1) & U32


def check_hit(event: dict[str, Any], seed: int) -> bool:
    """命中事件的读回核对：x[0] 等于种子、x[1] 等于递推值。不信驱动自己报的 seed_ok，在这边再算一遍。"""
    return event.get("x0") == seed and event.get("x1") == expected_x1(seed)


def parse_line(line: str) -> dict[str, Any] | None:
    """驱动 stdout 的一行 → 事件字典；空行、非 JSON、不是对象、没有 event 键都返回 None。"""
    line = line.strip()
    if not line:
        return None
    try:
        obj = json.loads(line)
    except ValueError:
        return None
    if not isinstance(obj, dict) or not isinstance(obj.get("event"), str):
        return None
    return obj


def summarize(event: dict[str, Any], seed: int) -> dict[str, Any]:
    """hit 事件 → 结果里的 seed 项。"""
    return {"value": seed, "tid": event.get("tid"), "x0": event.get("x0"), "x1": event.get("x1"),
            "ok": check_hit(event, seed), "old": event.get("old")}


# ==================== 驱动子进程 ====================


class SeedHook:
    """一个换种子的驱动子进程。"""

    def __init__(self, proc: subprocess.Popen, pid: int, seed: int):
        self.proc = proc
        self.pid = pid
        self.seed = seed
        self.stderr_tail: list[str] = []
        self._events: "queue.Queue[dict | None]" = queue.Queue()
        threading.Thread(target=self._read_stdout, daemon=True).start()
        threading.Thread(target=self._read_stderr, daemon=True).start()

    def _read_stdout(self) -> None:
        for raw in self.proc.stdout:  # type: ignore[union-attr]
            event = parse_line(raw.decode("utf-8", "replace"))
            if event is not None:
                self._events.put(event)
        self._events.put(None)  # EOF：进程退出

    def _read_stderr(self) -> None:
        for raw in self.proc.stderr:  # type: ignore[union-attr]
            self.stderr_tail.append(raw.decode("utf-8", "replace").rstrip())
            del self.stderr_tail[:-30]

    def _wait(self, kind: str, timeout: float) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        while True:
            try:
                event = self._events.get(timeout=max(0.05, deadline - time.monotonic()))
            except queue.Empty:
                if time.monotonic() >= deadline:
                    raise WpeError(f"换种子的驱动 {timeout:g} s 内没回 {kind}") from None
                continue
            if event is None:
                self._events.put(None)
                tail = f"：{'；'.join(self.stderr_tail[-5:])}" if self.stderr_tail else ""
                raise WpeError(f"换种子的驱动已退出（没等到 {kind}）{tail}")
            if event["event"] == "error":
                raise WpeError(f"换种子的驱动报错：{event.get('message')}"
                               + (f" {json.dumps(event['detail'], ensure_ascii=False)}" if event.get("detail") else ""))
            if event["event"] == kind:
                return event

    def wait_armed(self, timeout: float = READY_TIMEOUT) -> dict[str, Any]:
        return self._wait("armed", timeout)

    def wait_hit(self, timeout: float) -> dict[str, Any]:
        """等命中。超时报错（没有新建场景渲染器，钩子没被触发）。"""
        return self._wait("hit", timeout)

    def kill(self) -> None:
        """结束子进程（Frida 随之卸钩）。命中后驱动自己已退出，这时是空操作。"""
        with _live_lock:
            _live.discard(self)
        if self.proc.poll() is None:
            _kill_tree(self.proc)


_live: "set[SeedHook]" = set()
_live_lock = threading.Lock()


def arm(pid: int, seed: int, timeout: float) -> SeedHook:
    """拉起驱动并等到 armed（钩子已挂上）。timeout 是驱动自己等「新建渲染器」的秒数，到点它会报错退出。"""
    seed = parse_seed(seed)
    uv = shutil.which("uv")
    if not uv:
        raise WpeError("找不到 uv（驱动子进程用 uv 跑 frida_input 工程）")
    driver = os.path.join(FRIDA_DIR, "seed.py")
    if not os.path.isfile(driver):
        raise WpeError(f"缺少 {driver}")
    env = {k: v for k, v in os.environ.items() if k not in ("VIRTUAL_ENV", "UV_PROJECT_ENVIRONMENT")}
    cmd = [uv, "--directory", FRIDA_DIR, "run", "python", "-X", "utf8", "seed.py",
           "--pid", str(pid), "--seed", str(seed), "--timeout", f"{timeout:g}"]
    proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env,
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    hook = SeedHook(proc, pid, seed)
    with _live_lock:
        _live.add(hook)
    try:
        hook.wait_armed()
    except BaseException:
        hook.kill()
        raise
    return hook


def stop_all() -> None:
    with _live_lock:
        hooks = list(_live)
        _live.clear()
    for hook in hooks:
        try:
            hook.kill()
        except Exception:
            pass


atexit.register(stop_all)
