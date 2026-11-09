"""
机器级窗口表与文件锁。

- 窗口表：`.kabegame/debug/wpe-renderdoc-mcp/windows/<窗口名>.json`，一个测试窗口一个文件，记所属 MCP 的
  进程号与创建时刻、工程、尺寸、hwnd、开窗时刻。窗口名 `kb-<MCP 进程号>-<序号>`。
- 表锁 `windows.lock`：「查重 + 登记」、关陈旧窗口、restart_wpe 都在锁里做。
- 进程锁 `wpe.lock`：启动、注入、重启 WPE 在锁里做，免得两个会话同时启动或重复注入。
  两把锁的次序固定为先 wpe.lock 后 windows.lock，不会互相等死。
- 锁用 msvcrt.locking 锁住锁文件的第一个字节，持有进程死了系统自动放开。同一进程同一线程可重入。
- 陈旧：所属进程号不在，或进程号在但创建时刻对不上（进程号被复用）。
"""

from __future__ import annotations

import json
import msvcrt
import os
import re
import threading
import time
from typing import Any

from .. import paths
from ..replay import current_process_created, process_alive
from .common import WpeError, now_iso

NAME_RE = re.compile(r"^kb-(\d+)-(\d+)$")

SELF_PID = os.getpid()
SELF_CREATED = current_process_created()


class FileLock:
    """机器级的文件锁，进程内可重入（同一线程）。"""

    def __init__(self, path: str, what: str):
        self.path = path
        self.what = what
        self._rlock = threading.RLock()
        self._depth = 0
        self._file = None

    def acquire(self, timeout: float) -> float:
        """拿到锁返回等待秒数；超时报错。"""
        t0 = time.monotonic()
        if not self._rlock.acquire(timeout=timeout):
            raise WpeError(f"等{self.what}超时（{timeout:g} s，本进程别的线程占着）")
        if self._depth > 0:
            self._depth += 1
            return 0.0
        try:
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            f = open(self.path, "a+b")
            deadline = t0 + timeout
            while True:
                try:
                    f.seek(0)
                    msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
                    break
                except OSError:
                    if time.monotonic() >= deadline:
                        f.close()
                        raise WpeError(f"等{self.what}超时（{timeout:g} s，别的会话占着 {self.path}）")
                    time.sleep(0.1)
        except BaseException:
            self._rlock.release()
            raise
        self._file = f
        self._depth = 1
        return round(time.monotonic() - t0, 2)

    def release(self) -> None:
        self._depth -= 1
        if self._depth == 0:
            f, self._file = self._file, None
            try:
                f.seek(0)
                msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)
            except OSError:
                pass
            f.close()
        self._rlock.release()

    def held(self, timeout: float = 60.0):
        lock = self

        class _Ctx:
            def __enter__(self_inner):
                self_inner.waited = lock.acquire(timeout)
                return self_inner

            def __exit__(self_inner, *exc):
                lock.release()
                return False

        return _Ctx()


windows_lock = FileLock(paths.WINDOWS_LOCK, "窗口表锁")
wpe_lock = FileLock(paths.WPE_LOCK, "WPE 进程锁")


# ==================== 表项 ====================


def _entry_path(name: str) -> str:
    return os.path.join(paths.WINDOWS_DIR, name + ".json")


def entries() -> list[dict[str, Any]]:
    """全部表项（按名字排序）。读不了的文件报成 `{"name", "broken": 原因}`。"""
    if not os.path.isdir(paths.WINDOWS_DIR):
        return []
    found = []
    for file in sorted(os.listdir(paths.WINDOWS_DIR)):
        if not file.endswith(".json"):
            continue
        name = file[:-5]
        try:
            with open(os.path.join(paths.WINDOWS_DIR, file), "r", encoding="utf-8") as f:
                entry = json.load(f)
            entry["name"] = name
        except (OSError, json.JSONDecodeError) as e:
            entry = {"name": name, "broken": str(e)}
        found.append(entry)
    return found


def get(name: str) -> dict[str, Any] | None:
    for entry in entries():
        if entry["name"] == name:
            return entry
    return None


def write(entry: dict[str, Any]) -> None:
    os.makedirs(paths.WINDOWS_DIR, exist_ok=True)
    path = _entry_path(entry["name"])
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(entry, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def delete(name: str) -> bool:
    try:
        os.remove(_entry_path(name))
        return True
    except FileNotFoundError:
        return False


def new_entry(name: str, project: str, size: tuple[int, int]) -> dict[str, Any]:
    return {"name": name, "owner_pid": SELF_PID, "owner_created": SELF_CREATED, "project": project,
            "size": f"{size[0]}x{size[1]}", "hwnd": None, "opened_at": now_iso(), "state": "opening"}


# ==================== 所属 ====================


def is_mine(entry: dict[str, Any]) -> bool:
    return entry.get("owner_pid") == SELF_PID and entry.get("owner_created") == SELF_CREATED


def is_stale(entry: dict[str, Any]) -> bool:
    """所属 MCP 进程已不在（或进程号被复用、创建时刻对不上）。坏掉的表项也算。"""
    if "broken" in entry:
        return True
    pid = entry.get("owner_pid")
    if not isinstance(pid, int):
        return True
    return not process_alive(pid, entry.get("owner_created"))


def owner_kind(entry: dict[str, Any]) -> str:
    """mine（本会话）/ other（别的会话，所属进程在）/ stale（陈旧）。"""
    if is_mine(entry):
        return "mine"
    return "stale" if is_stale(entry) else "other"


_seq_lock = threading.Lock()
_seq = 0


def next_name(taken: set[str]) -> str:
    """kb-<本 MCP 进程号>-<序号>，跳过表里或屏幕上已有的名字。"""
    global _seq
    with _seq_lock:
        while True:
            _seq += 1
            name = f"kb-{SELF_PID}-{_seq}"
            if name not in taken and not os.path.exists(_entry_path(name)):
                return name
