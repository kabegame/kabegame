"""
测试窗口的输入驱动：用 Frida 按帧给 WPE 的测试窗口喂光标位置与左键（play），或逐帧录下真实的光标与左键（record）。

原理：WPE 的场景每帧在渲染线程上调一次 GetCursorPos、一次 GetKeyState(VK_LBUTTON)，左键刚按下时再调
WindowFromPoint。驱动子进程（`frida_input/driver.py`，独立的小 uv 工程）挂进 WPE，只在「对本窗口的渲染窗口
调 ScreenToClient 的那条线程」上改这三个函数的返回值；桌面壁纸、别的测试窗口在别的线程上，不受影响。
子进程退出时 Frida 自动卸掉脚本，钩子随之撤销。Frida 不进 MCP 自己的依赖（MCP 由 uv run 启动、按锁文件同步）。

时间线：[[x, y, down] 或 [x, y, down, n], …]，x / y 是渲染窗口客户区的归一化坐标（左上原点、y 向下），
down 是左键是否按下，n 是重复帧数（缺省 1）。第 i 帧给目标线程的第 i 次 GetCursorPos；放完停在最后一项。

内部函数（launch / Driver）只认 pid 与渲染窗口 hwnd，不依赖窗口表；start / status / stop / play 是包上窗口表检查
（只能操作本会话自己的窗口）的薄层。
"""

from __future__ import annotations

import atexit
import json
import math
import os
import queue
import shutil
import subprocess
import threading
import time
from typing import Any

from .. import paths
from . import log as wlog
from . import windows as win
from .common import WpeError

RENDER_CLASS = "WPEDesktopDX11Window"
FRIDA_DIR = os.path.join(paths.PROJECT_DIR, "frida_input")
MAX_FRAMES = 100000
READY_TIMEOUT = 60.0  # uv 同步 + 启动 + attach + 认线程（第一次会下载 Frida）
STOP_TIMEOUT = 30.0
PLAY_FPS_FLOOR = 5.0  # 等待上限按「帧数 / 5 帧每秒 + 30 s」
SUMMARY_FRAMES = 3
RECORD_INLINE_ITEMS = 400  # record 的结果里最多内联多少个（压缩后的）时间线项


# ==================== 时间线 ====================


def validate_timeline(timeline: Any) -> tuple[list[list[float]], int]:
    """校验时间线，返回（规整后的项, 展开后的帧数）。项是 [x, y, down] 或 [x, y, down, n]。"""
    if not isinstance(timeline, list) or not timeline:
        raise WpeError("timeline 要是非空数组，每项 [x, y, down] 或 [x, y, down, n]")
    items: list[list[float]] = []
    total = 0
    for i, item in enumerate(timeline):
        if not isinstance(item, (list, tuple)) or len(item) not in (3, 4):
            raise WpeError(f"timeline[{i}] 要是 [x, y, down] 或 [x, y, down, n]，收到 {item!r}")
        x, y, down = item[0], item[1], item[2]
        for name, v in (("x", x), ("y", y)):
            if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
                raise WpeError(f"timeline[{i}] 的 {name} 要是有限数，收到 {v!r}")
        if not (isinstance(down, bool) or down in (0, 1)):
            raise WpeError(f"timeline[{i}] 的 down 要是布尔或 0 / 1，收到 {down!r}")
        n = 1
        if len(item) == 4:
            n = item[3]
            if isinstance(n, bool) or not isinstance(n, int) or n < 1:
                raise WpeError(f"timeline[{i}] 的 n 要是正整数，收到 {n!r}")
        total += n
        if total > MAX_FRAMES:
            raise WpeError(f"时间线展开后超过 {MAX_FRAMES} 帧")
        items.append([float(x), float(y), 1 if down else 0] + ([n] if len(item) == 4 else []))
    return items, total


def compress(log: list[list[float]]) -> list[list[float]]:
    """record 的逐帧 [x, y, down] → 连续相同的帧合成 [x, y, down, n]（坐标取 6 位小数，n == 1 不带）。"""
    runs: list[list] = []
    for x, y, down in log:
        key = [round(x, 6), round(y, 6), 1 if down else 0]
        if runs and runs[-1][0] == key:
            runs[-1][1] += 1
        else:
            runs.append([key, 1])
    return [key + [n] if n > 1 else key for key, n in runs]


# ==================== 渲染窗口 ====================


def find_render_window(top_hwnd: int) -> tuple[int, int]:
    """测试窗口 hwnd 下类名为 WPEDesktopDX11Window 的子窗口 → (渲染窗口 hwnd, WPE pid)。"""
    for child in win.enum_children(top_hwnd):
        if win.class_of(child) == RENDER_CLASS:
            return child, win.pid_of(child)
    raise WpeError(f"窗口 {top_hwnd} 下找不到类名为 {RENDER_CLASS} 的渲染子窗口（窗口还没建好，或不是测试窗口）")


# ==================== 驱动子进程 ====================


def _kill_tree(proc: subprocess.Popen) -> None:
    """uv 会再起一层 python：连子树一起结束。"""
    try:
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True, timeout=10)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass


class Driver:
    """一个驱动子进程。方法串行（内部锁）。"""

    def __init__(self, proc: subprocess.Popen, pid: int, hwnd: int, mode: str, frames_expected: int | None):
        self.proc = proc
        self.pid = pid
        self.hwnd = hwnd
        self.mode = mode
        self.frames_expected = frames_expected
        self.tid: int | None = None
        self.started = time.monotonic()
        self.stderr_tail: list[str] = []
        self._events: "queue.Queue[dict | None]" = queue.Queue()
        self._lock = threading.Lock()
        self._done = False
        threading.Thread(target=self._read_stdout, daemon=True).start()
        threading.Thread(target=self._read_stderr, daemon=True).start()

    def _read_stdout(self) -> None:
        for raw in self.proc.stdout:  # type: ignore[union-attr]
            line = raw.decode("utf-8", "replace").strip()
            if not line:
                continue
            try:
                self._events.put(json.loads(line))
            except ValueError:
                self.stderr_tail.append(line)
        self._events.put(None)  # EOF：进程退出

    def _read_stderr(self) -> None:
        for raw in self.proc.stderr:  # type: ignore[union-attr]
            self.stderr_tail.append(raw.decode("utf-8", "replace").rstrip())
            del self.stderr_tail[:-30]

    def _send(self, obj: dict) -> None:
        try:
            self.proc.stdin.write((json.dumps(obj) + "\n").encode("utf-8"))  # type: ignore[union-attr]
            self.proc.stdin.flush()  # type: ignore[union-attr]
        except (OSError, ValueError):
            pass  # 进程已经没了，之后 _wait 会报

    def _wait(self, kinds: tuple[str, ...], timeout: float) -> dict:
        deadline = time.monotonic() + timeout
        while True:
            try:
                event = self._events.get(timeout=max(0.05, deadline - time.monotonic()))
            except queue.Empty:
                event = None
                if time.monotonic() >= deadline:
                    raise WpeError(f"驱动子进程 {timeout:g} s 内没回 {'/'.join(kinds)}")
                continue
            if event is None:
                self._done = True
                self._events.put(None)  # 让后续等待也看到 EOF
                raise WpeError("驱动子进程已退出" + (f"：{'；'.join(self.stderr_tail[-5:])}" if self.stderr_tail else ""))
            if event.get("event") == "error":
                self._done = True
                raise WpeError(f"驱动子进程报错：{event.get('message')}")
            if event.get("event") in kinds:
                return event

    def wait_ready(self) -> dict:
        event = self._wait(("ready",), READY_TIMEOUT)
        self.tid = event.get("tid")
        return event

    @property
    def alive(self) -> bool:
        return not self._done and self.proc.poll() is None

    def state(self) -> dict:
        with self._lock:
            self._send({"cmd": "state"})
            return self._wait(("state",), 10)

    def stop(self) -> dict:
        """停：卸载脚本、detach；返回 stopped 事件（frames、log）。子进程在 STOP_TIMEOUT 内没退就结束它。"""
        with self._lock:
            if not self.alive:
                _kill_tree(self.proc)
                raise WpeError("驱动子进程已经退出（WPE 重启过、窗口关了，或之前出错）")
            self._send({"cmd": "stop"})
            try:
                event = self._wait(("stopped",), STOP_TIMEOUT)
            finally:
                self._done = True
                try:
                    self.proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    _kill_tree(self.proc)
            return event

    def kill(self) -> None:
        """退出路径上用：不取结果，直接结束子进程（Frida 随进程退出卸掉脚本）。"""
        self._done = True
        try:
            self._send({"cmd": "stop"})
            self.proc.wait(timeout=3)
        except Exception:
            _kill_tree(self.proc)


def launch(pid: int, render_hwnd: int, mode: str, timeline: list | None = None) -> Driver:
    """拉起驱动子进程并等到 ready（认出渲染线程）。不依赖窗口表。"""
    if mode not in ("play", "record"):
        raise WpeError(f"mode 要是 play 或 record，收到 {mode!r}")
    frames = None
    if mode == "play":
        timeline, frames = validate_timeline(timeline)
    elif timeline:
        raise WpeError("record 不要传 timeline")
    uv = shutil.which("uv")
    if not uv:
        raise WpeError("找不到 uv（驱动子进程用 uv 跑 frida_input 工程）")
    if not os.path.isfile(os.path.join(FRIDA_DIR, "driver.py")):
        raise WpeError(f"缺少 {FRIDA_DIR}\\driver.py")
    env = {k: v for k, v in os.environ.items() if k not in ("VIRTUAL_ENV", "UV_PROJECT_ENVIRONMENT")}
    cmd = [uv, "--directory", FRIDA_DIR, "run", "python", "-X", "utf8", "driver.py",
           "--pid", str(pid), "--hwnd", str(render_hwnd), "--mode", mode]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env,
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    driver = Driver(proc, pid, render_hwnd, mode, frames)
    try:
        first = {"timeline": timeline} if mode == "play" else {}
        driver._send(first)
        driver.wait_ready()
    except BaseException:
        _kill_tree(proc)
        raise
    with _live_lock:
        _live.add(driver)
    return driver


_live: "set[Driver]" = set()
_live_lock = threading.Lock()


def summarize(event: dict, mode: str) -> dict[str, Any]:
    """stopped 事件 → 摘要。play：首末几帧的应用值 [帧, 屏幕 x, 屏幕 y, down]；record：压缩后的时间线。"""
    log = event.get("log") or []
    result: dict[str, Any] = {"mode": mode, "frames": event.get("frames"), "logged": len(log)}
    if mode == "play":
        result["log_first"] = log[:SUMMARY_FRAMES]
        result["log_last"] = log[-SUMMARY_FRAMES:] if len(log) > SUMMARY_FRAMES else []
    else:
        timeline = compress(log)
        result["timeline_items"] = len(timeline)
        if len(timeline) <= RECORD_INLINE_ITEMS:
            result["timeline"] = timeline
        else:
            result["timeline_head"] = timeline[:RECORD_INLINE_ITEMS]
            result["note"] = f"时间线项太多，只内联前 {RECORD_INLINE_ITEMS} 项；完整的要给 out"
    return result


def write_out(event: dict, mode: str, out: str) -> str:
    """完整 log 写成 JSON。record 写压缩后的时间线（可直接当 timeline 回放），play 写逐帧应用值。"""
    if not isinstance(out, str) or not os.path.isabs(out):
        raise WpeError("out 要是绝对路径")
    real = os.path.normcase(os.path.realpath(out))
    wpe = os.path.realpath(paths.wpe_dir())
    steam = os.path.realpath(os.path.join(wpe, "..", "..", ".."))  # wallpaper_engine → common → steamapps → Steam
    for label, base in (("WPE 安装目录", wpe), ("Steam 目录", steam)):
        base_norm = os.path.normcase(base)
        try:
            inside = os.path.commonpath([real, base_norm]) == base_norm
        except ValueError:  # 不同盘
            inside = False
        if inside:
            raise WpeError(f"out 不能写在{label}（{base}）下")
    log = event.get("log") or []
    data = compress(log) if mode == "record" else log
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(data, f, separators=(",", ":"))
    return out


def run_play(pid: int, render_hwnd: int, timeline: list, tail: float = 1.0, log_grep: str | None = None,
             out: str | None = None) -> dict[str, Any]:
    """取日志游标 → 拉起 play → 等放完再等 tail 秒 → 停 → 读日志。不依赖窗口表。"""
    items, frames = validate_timeline(timeline)
    cursor = wlog.mark()
    driver = launch(pid, render_hwnd, "play", items)
    t0 = time.monotonic()
    limit = frames / PLAY_FPS_FLOOR + 30
    try:
        while True:
            state = driver.state()
            if state.get("played"):
                break
            if time.monotonic() - t0 > limit:
                raise WpeError(f"{limit:g} s 内没放完（已 {state.get('frame')} / {frames} 帧）：WPE 暂停了或窗口没在渲染？")
            time.sleep(0.2)
        time.sleep(max(0.0, float(tail)))
        event = driver.stop()
    except BaseException:
        driver.kill()
        raise
    finally:
        with _live_lock:
            _live.discard(driver)
    result = summarize(event, "play")
    if out:
        result["out"] = write_out(event, "play", out)
    result["took_s"] = round(time.monotonic() - t0, 2)
    result["log"] = wlog.since(cursor, grep=log_grep)
    return result


# ==================== 窗口表这一层 ====================

_by_window: dict[str, Driver] = {}


def _own_target(window: str) -> tuple[int, int]:
    """本会话的窗口 → (渲染窗口 hwnd, WPE pid)。检查同 apply_properties。"""
    from . import session  # 延迟导入：session.close_wallpaper 会反过来停驱动

    session._own_entry(window)
    found = win.find_test_window(window, session._main_pids())
    if not found:
        raise WpeError(f"{window} 的窗口已经不在了")
    return find_render_window(found["hwnd"])


def _alive_driver(window: str) -> Driver | None:
    driver = _by_window.get(window)
    if driver is not None and not driver.alive:
        _by_window.pop(window, None)
        with _live_lock:
            _live.discard(driver)
        return None
    return driver


def start(window: str, mode: str = "play", timeline: list | None = None) -> dict[str, Any]:
    render, pid = _own_target(window)
    if _alive_driver(window) is not None:
        raise WpeError(f"{window} 已经有一个驱动在跑（{_by_window[window].mode}），先 input_stop")
    driver = launch(pid, render, mode, timeline)
    _by_window[window] = driver
    return {"window": window, "mode": mode, "render_hwnd": render, "wpe_pid": pid, "tid": driver.tid,
            "frames": driver.frames_expected, "ready_after_s": round(time.monotonic() - driver.started, 2)}


def status(window: str) -> dict[str, Any]:
    from . import session

    session._own_entry(window)
    driver = _alive_driver(window)
    if driver is None:
        return {"window": window, "running": False}
    state = driver.state()
    return {"window": window, "running": True, "mode": driver.mode, "tid": driver.tid,
            "frame": state.get("frame"), "frames_total": driver.frames_expected, "played": state.get("played"),
            "running_s": round(time.monotonic() - driver.started, 2)}


def stop(window: str, out: str | None = None) -> dict[str, Any]:
    from . import session

    session._own_entry(window)
    driver = _alive_driver(window)
    if driver is None:
        raise WpeError(f"{window} 没有在跑的驱动")
    try:
        event = driver.stop()
    finally:
        _by_window.pop(window, None)
        with _live_lock:
            _live.discard(driver)
    result = summarize(event, driver.mode)
    result["window"] = window
    if out:
        result["out"] = write_out(event, driver.mode, out)
    return result


def play(window: str, timeline: list, tail: float = 1.0, log_grep: str | None = None,
         out: str | None = None) -> dict[str, Any]:
    if _alive_driver(window) is not None:
        raise WpeError(f"{window} 已经有一个驱动在跑，先 input_stop")
    render, pid = _own_target(window)
    result = run_play(pid, render, timeline, tail, log_grep, out)
    result["window"] = window
    return result


def stop_window(window: str) -> bool:
    """close_wallpaper 之前停掉该窗口的驱动（不取结果）。有驱动就返回 True。"""
    driver = _by_window.pop(window, None)
    if driver is None:
        return False
    with _live_lock:
        _live.discard(driver)
    driver.kill()
    return True


def stop_all() -> None:
    """MCP 退出时：停掉全部驱动。"""
    with _live_lock:
        drivers = list(_live)
        _live.clear()
    _by_window.clear()
    for driver in drivers:
        try:
            driver.kill()
        except Exception:
            pass


atexit.register(stop_all)
