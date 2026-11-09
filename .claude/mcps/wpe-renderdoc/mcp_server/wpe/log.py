"""
WPE 的 log.txt：游标与增量。

- 日志各会话共用，行里不带窗口名，log_since 只能按时间段截；多个会话同时开窗时会混进别人的行。
- 游标 `{size, created, head, head_len}`：
  - size：读到哪里（只算到最后一个完整行）；
  - created：文件创建时刻（ns）；
  - head：文件开头 head_len 个字节的摘要。
  文件变小、创建时刻变了或开头变了，就是日志被重写了（WPE 重启后重写、被删掉重建、被截断）：
  报出来，不静默从头读。创建时刻有 NTFS 的「隧道」效应（删掉后 15 s 内同名重建会沿用旧的创建时刻），
  所以另加开头摘要。
"""

from __future__ import annotations

import hashlib
import os
import re
from typing import Any

from .. import paths
from .common import WpeError

HEAD_BYTES = 256
MAX_LINES = 400
ERROR_RE = re.compile(r"error|fail", re.IGNORECASE)


def _created_ns(st: os.stat_result) -> int:
    # Windows 上 3.12 以前 st_ctime 就是创建时刻；3.12 起有 st_birthtime
    return getattr(st, "st_birthtime_ns", None) or st.st_ctime_ns


def _head(f, length: int) -> str:
    f.seek(0)
    return hashlib.sha256(f.read(length)).hexdigest()[:16]


def mark(path: str | None = None) -> dict[str, Any]:
    """当前游标：文件末尾（只算到最后一个完整行）。文件不在时 size 为 0、created 为 None。"""
    path = path or paths.wpe_log()
    try:
        with open(path, "rb") as f:
            st = os.fstat(f.fileno())
            size = st.st_size
            # 停在最后一个换行之后：半行留给下一次
            tail_start = max(0, size - 65536)
            f.seek(tail_start)
            tail = f.read(size - tail_start)
            cut = tail.rfind(b"\n")
            end = tail_start + cut + 1 if cut >= 0 else tail_start if tail_start else 0
            head_len = min(HEAD_BYTES, size)
            return {"path": path, "size": end, "created": _created_ns(st), "head": _head(f, head_len),
                    "head_len": head_len}
    except FileNotFoundError:
        return {"path": path, "size": 0, "created": None, "head": None, "head_len": 0}


def since(cursor: dict[str, Any], grep: str | None = None, errors: bool = False,
          max_lines: int = MAX_LINES) -> dict[str, Any]:
    """游标之后新增的完整行。grep 是正则（区分大小写）；errors 只回含 error / fail 的行（不区分大小写）。"""
    if not isinstance(cursor, dict) or "size" not in cursor:
        raise WpeError("mark 要传 log_mark / open_wallpaper 返回的游标对象")
    path = cursor.get("path") or paths.wpe_log()
    pattern = None
    if grep:
        try:
            pattern = re.compile(grep)
        except re.error as e:
            raise WpeError(f"grep 不是合法的正则：{e}") from None
    now = mark(path)
    result: dict[str, Any] = {
        "note": "log.txt 各会话共用、行里不带窗口名，同时开着别的窗口时会混进别人的行",
        "mark_now": now,
    }
    reasons = []
    if now["created"] is None:
        reasons.append("log.txt 不在了")
    else:
        if cursor.get("created") is not None and now["created"] != cursor["created"]:
            reasons.append("文件创建时刻变了")
        if now["size"] < cursor["size"]:
            reasons.append(f"文件变小了（{cursor['size']} → {now['size']} 字节）")
        head_len = cursor.get("head_len") or 0
        if cursor.get("head") and head_len:
            with open(path, "rb") as f:
                if _head(f, head_len) != cursor["head"]:
                    reasons.append("文件开头变了")
    if reasons:
        result.update(valid=False, rewritten=True, lines=[], count=0, next=now,
                      message="WPE 重启过或日志被重写，旧游标失效（" + "；".join(reasons)
                              + "）。没有从头读；要读新日志请用 mark_now / next 重新开始")
        return result
    with open(path, "rb") as f:
        f.seek(cursor["size"])
        data = f.read(now["size"] - cursor["size"])
    lines = [line.rstrip("\r") for line in data.decode("utf-8", "replace").split("\n")]
    if lines and lines[-1] == "":
        lines.pop()
    total = len(lines)
    if errors:
        lines = [line for line in lines if ERROR_RE.search(line)]
    if pattern is not None:
        lines = [line for line in lines if pattern.search(line)]
    matched = len(lines)
    truncated = matched > max_lines
    if truncated:
        lines = lines[:max_lines]
    result.update(valid=True, rewritten=False, lines=lines, count=matched, total_new_lines=total,
                  truncated=truncated, next=now)
    return result
