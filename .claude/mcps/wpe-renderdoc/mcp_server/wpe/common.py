"""WPE 模块共用的小工具。"""

from __future__ import annotations

import datetime
import time


class WpeError(Exception):
    """拒绝或失败：消息直接给调用方看，写清原因和下一步。"""


def now_iso() -> str:
    return datetime.datetime.now().isoformat(timespec="milliseconds")


def filetime_iso(filetime: int | None) -> str | None:
    """FILETIME 整数（100 ns，自 1601 年起，UTC）→ 本地时间字符串。"""
    if not filetime:
        return None
    seconds = filetime / 10_000_000 - 11644473600
    return datetime.datetime.fromtimestamp(seconds).isoformat(timespec="seconds")


def wait_until(predicate, timeout: float, interval: float = 0.1):
    """轮询到 predicate() 为真值或超时，返回最后一次的值。"""
    deadline = time.monotonic() + timeout
    while True:
        value = predicate()
        if value or time.monotonic() >= deadline:
            return value
        time.sleep(interval)
