"""
本会话的测试窗口：开、关、改属性、列表，以及陈旧窗口回收、MCP 退出时关掉自己的窗口。

所属的四种：
- mine：本 MCP 进程开的；
- other：别的会话开的，所属 MCP 进程还在；
- stale：表里有，但所属 MCP 进程已不在（或进程号被复用），任何 MCP 在 ensure_running / status 时顺手关掉；
- foreign：屏幕上有 WPEOverlappedWallpaper，表里没有（旧脚本、exp.py、用户自己开的），只报告、不碰。
"""

from __future__ import annotations

import json
import os
import re
import shutil
import threading
import time
from typing import Any

from .. import paths
from . import control as ctl
from . import log as wlog
from . import process, projects, registry
from . import windows as win
from .common import WpeError, now_iso

SIZE_RE = re.compile(r"^\s*(\d+)\s*[xX×]\s*(\d+)\s*$")
OWNER_LABEL = {"mine": "本会话", "other": "别的会话", "stale": "陈旧", "foreign": "外来"}

# 同一 MCP 进程里的窗口操作串行（FastMCP 的同步工具本来就在事件循环里排队，这里再保一层）
_op_lock = threading.RLock()

# 尺寸容差（窗口像素）：两个测试窗口的尺寸宽、高都差在这以内就算「同尺寸」，开窗时拒绝；抓帧认窗口时
# 后备缓冲和窗口尺寸差在这以内算对得上。第 3 批实测交换链总等于客户区（差 0），缩略图另有按 8 对齐的规则，
# 见 capture.py；这里留余量。
SIZE_TOL = 8


def sizes_close(a, b, tol: int = SIZE_TOL) -> bool:
    return abs(int(a[0]) - int(b[0])) <= tol and abs(int(a[1]) - int(b[1])) <= tol


def _sizes_of(entry: dict[str, Any]) -> list[tuple[int, int]]:
    """一个表项可能对应的尺寸：登记的请求尺寸，以及屏幕上的客户区（系统可能把窗口缩小过）。"""
    found = []
    m = SIZE_RE.match(entry.get("size") or "")
    if m:
        found.append((int(m.group(1)), int(m.group(2))))
    w = entry.get("window")
    if w and w.get("client"):
        found.append((w["client"][2], w["client"][3]))
    return found


def parse_size(size: str) -> tuple[int, int]:
    m = SIZE_RE.match(size or "")
    if not m:
        raise WpeError(f"size 要写成 宽x高，比如 1280x720，收到 {size!r}")
    w, h = int(m.group(1)), int(m.group(2))
    if not (16 <= w <= 16384 and 16 <= h <= 16384):
        raise WpeError(f"size 超出范围：{w}x{h}")
    return w, h


def _main_pids() -> list[int]:
    return [p["pid"] for p in process.main_processes()]


def survey() -> dict[str, Any]:
    """窗口表与屏幕上的测试窗口，按所属分好。"""
    shown = win.test_windows(_main_pids())
    by_name = {w["name"]: w for w in shown}
    registered = []
    for entry in registry.entries():
        kind = registry.owner_kind(entry)
        registered.append({**entry, "owner": kind, "owner_label": OWNER_LABEL[kind],
                           "window": by_name.get(entry["name"])})
    names = {e["name"] for e in registered}
    foreign = [{**w, "owner": "foreign", "owner_label": OWNER_LABEL["foreign"]}
               for w in shown if w["name"] not in names]
    return {"registered": registered, "foreign": foreign}


def _close_by_name(name: str, timeout: float = 10.0) -> dict[str, Any]:
    """发 closeWallpaper -location <名字>，等窗口消失。窗口不在就不发。"""
    found = win.find_test_window(name, _main_pids())
    if not found:
        return {"window_existed": False}
    t0 = time.monotonic()
    ctl.control(f"closeWallpaper -location {name}")
    gone = win.wait_gone(found["hwnd"], timeout)
    return {"window_existed": True, "hwnd": found["hwnd"], "gone": gone, "took_s": round(time.monotonic() - t0, 2)}


def close_stale() -> list[dict[str, Any]]:
    """关掉陈旧窗口（所属 MCP 已不在），删表项；本会话表项对应的窗口已经没了的也删掉。在表锁里做。"""
    closed = []
    with registry.windows_lock.held(60):
        for entry in registry.entries():
            kind = registry.owner_kind(entry)
            if kind == "stale":
                item = {"name": entry["name"], "owner_pid": entry.get("owner_pid"), "size": entry.get("size"),
                        "project": entry.get("project"), "reason": "所属 MCP 进程已不在"}
                try:
                    item.update(_close_by_name(entry["name"]))
                except WpeError as e:
                    item["close_error"] = str(e)
                if item.get("window_existed") and not item.get("gone"):
                    item["note"] = "窗口没关掉，表项保留"
                else:
                    registry.delete(entry["name"])
                closed.append(item)
            elif kind == "mine" and entry.get("state") == "open":
                if not win.find_test_window(entry["name"], _main_pids()):
                    registry.delete(entry["name"])
                    closed.append({"name": entry["name"], "owner_pid": entry.get("owner_pid"),
                                   "reason": "本会话的窗口已经不在了（WPE 重启过或被别处关掉），删掉表项"})
    return closed


def list_windows() -> dict[str, Any]:
    view = survey()
    return {
        "mcp_pid": registry.SELF_PID,
        "dpi_awareness": win.DPI_AWARENESS,
        "desktop": process.desktop_windows(),
        "test_windows": [_brief(r) for r in view["registered"]] + view["foreign"],
    }


def _brief(entry: dict[str, Any]) -> dict[str, Any]:
    w = entry.get("window")
    return {
        "name": entry["name"], "owner": entry["owner"], "owner_label": entry["owner_label"],
        "owner_pid": entry.get("owner_pid"), "project": entry.get("project"), "size": entry.get("size"),
        "opened_at": entry.get("opened_at"), "state": entry.get("state"),
        "hwnd": w["hwnd"] if w else entry.get("hwnd"), "exists": bool(w),
        "rect": w["rect"] if w else None, "client": w["client"] if w else None,
        "visible": w["visible"] if w else None,
    }


# ==================== 开、关、改属性 ====================


def _size_conflicts(view: dict[str, Any], size: tuple[int, int]) -> list[dict[str, Any]]:
    """和 size 相差不超过 SIZE_TOL 的测试窗口：登记的（请求尺寸或屏幕上的客户区）与外来的（客户区）。"""
    conflicts = []
    for entry in view["registered"]:
        if entry["owner"] == "stale" and not entry.get("window"):
            continue
        if any(sizes_close(s, size) for s in _sizes_of(entry)):
            conflicts.append(_brief(entry))
    for foreign in view["foreign"]:
        client = foreign.get("client")
        if client and sizes_close((client[2], client[3]), size):
            conflicts.append(foreign)
    return conflicts


def check_placement(borderless: Any = None, x: Any = None, y: Any = None) -> None:
    """borderless 是 None（自动）或布尔；x、y 是整数，要么都给、要么都不给。不对就报错（开窗前校验）。"""
    if borderless is not None and not isinstance(borderless, bool):
        raise WpeError(f"borderless 要是 true / false，或者不给（自动），收到 {borderless!r}")
    for key, value in (("x", x), ("y", y)):
        if value is not None and (not isinstance(value, int) or isinstance(value, bool)):
            raise WpeError(f"{key} 要是整数（物理像素），收到 {value!r}")
    if (x is None) != (y is None):
        raise WpeError("x、y 要同时给，或者都不给")


def _placement(w: int, h: int, borderless: bool | None, x: int | None, y: int | None) -> dict[str, Any]:
    """决定发给 openWallpaper 的尺寸与位置参数。

    带边框（缺省）：-width / -height 就是客户区；窗口加上边框放不进显示器时，系统会把窗口压小，客户区跟着变小
    （4K 屏上请求 3840x2160 实得 3840x2130）。
    无边框（-borderless）：WPE 仍按带边框窗口算尺寸，整个窗口 = 客户区 = 请求尺寸 + 边框厚度（frame_extra），
    所以请求时先减掉边框；位置用 -x / -y，缺省放在显示器左上角。
    borderless 为 None 时自动：带边框放不进显示器的工作区就用无边框。
    """
    mon = win.monitor_at(x if x is not None else 0, y if y is not None else 0)
    fx, fy = win.frame_extra(mon["dpi"])
    work = mon["work"]
    fits = w + fx <= work[2] - work[0] and h + fy <= work[3] - work[1]
    auto = borderless is None
    use = (not fits) if auto else borderless
    info: dict[str, Any] = {"borderless": use, "auto": auto, "fits_with_frame": fits, "frame_extra": [fx, fy],
                            "dpi": mon["dpi"], "monitor": mon["rect"], "work": work}
    if use:
        sent = (w - fx, h - fy)
        if sent[0] < 16 or sent[1] < 16:
            raise WpeError(f"无边框窗口 {w}x{h} 扣掉边框 {fx}x{fy} 后太小，换一个尺寸")
        px = x if x is not None else mon["rect"][0]
        py = y if y is not None else mon["rect"][1]
        info.update(x=px, y=py, sent_size=list(sent))
        info["args"] = f"-width {sent[0]} -height {sent[1]} -x {px} -y {py} -borderless"
    else:
        info["sent_size"] = [w, h]
        info["args"] = f"-width {w} -height {h}" + (f" -x {x} -y {y}" if x is not None else "")
        if x is not None:
            info.update(x=x, y=y)
    return info


def open_wallpaper(project: str, size: str = "1280x720", wait: float = 20.0, ensure=None,
                   borderless: bool | None = None, x: int | None = None, y: int | None = None) -> dict[str, Any]:
    with _op_lock:
        check_placement(borderless, x, y)
        ensured = ensure() if ensure else None
        path = projects.resolve_project(project)
        w, h = parse_size(size)
        size_text = f"{w}x{h}"
        placement = _placement(w, h, borderless, x, y)
        with registry.windows_lock.held(60) as lock:
            view = survey()
            conflicts = _size_conflicts(view, (w, h))
            if conflicts:
                raise WpeError(
                    f"拒绝开窗：已有和 {size_text} 相差不超过 {SIZE_TOL} 像素的测试窗口，抓帧时会分不清是谁的。占用方："
                    + json.dumps([{k: c.get(k) for k in ("name", "owner_label", "owner_pid", "project", "size", "hwnd")}
                                  for c in conflicts], ensure_ascii=False)
                    + "。换一个尺寸，或等对方关窗")
            taken = {e["name"] for e in view["registered"]} | {f["name"] for f in view["foreign"]}
            name = registry.next_name(taken)
            entry = registry.new_entry(name, path, (w, h))
            registry.write(entry)
            lock_wait = lock.waited
        cursor = wlog.mark()
        fg_before = win.foreground()
        t0 = time.monotonic()
        try:
            sent = ctl.control(f'openWallpaper -file "{path}" -playInWindow "{name}" {placement["args"]}')
            info = win.wait_test_window(name, wait, _main_pids())
        except BaseException:
            registry.delete(name)
            raise
        if not info:
            # 超时：保底发一次关窗，免得之后才冒出来变成没人管的窗口
            try:
                ctl.control(f"closeWallpaper -location {name}")
            except WpeError:
                pass
            registry.delete(name)
            raise WpeError(f"{wait:g} s 内没等到窗口 {name} 出现（工程 {path}），已撤销登记并补发关窗")
        appeared = round(time.monotonic() - t0, 2)
        # 系统把窗口缩小过（窗口加标题栏超出屏幕）时，实际客户区可能和别的窗口撞上：撞了就关掉、撤销登记
        client = info.get("client")
        if client and (client[2], client[3]) != (w, h):
            with registry.windows_lock.held(60):
                clash = [c for c in _size_conflicts(survey(), (client[2], client[3])) if c.get("name") != name]
            if clash:
                try:
                    _close_by_name(name)
                finally:
                    registry.delete(name)
                raise WpeError(
                    f"开了 {size_text} 的窗口，但系统把客户区缩成了 {client[2]}x{client[3]}，和已有的测试窗口相差不超过 "
                    f"{SIZE_TOL} 像素，抓帧时会分不清，已关掉并撤销登记。占用方："
                    + json.dumps([{k: c.get(k) for k in ("name", "owner_label", "owner_pid", "size")} for c in clash],
                                 ensure_ascii=False))
        fg = win.settle_foreground(fg_before)
        entry.update(hwnd=info["hwnd"], state="open", opened_at=now_iso())
        registry.write(entry)
        result = {
            "window": name, "hwnd": info["hwnd"], "project": path, "size": size_text,
            "rect": info["rect"], "client": info["client"], "wpe_pid": sent["wpe_pid"],
            "appeared_after_s": appeared, "log_mark": cursor, "registry_lock_wait_s": lock_wait,
            "foreground": fg, "placement": {k: v for k, v in placement.items() if k != "args"},
        }
        if info["size"] != size_text:
            if placement["borderless"]:
                result["warning"] = (f"客户区是 {info['size']}，和请求的 {size_text} 不同：无边框窗口按边框厚度 "
                                     f"{placement['frame_extra']}（{placement['dpi']} DPI）扣过，WPE 实际加的不一样")
            else:
                result["warning"] = (f"客户区是 {info['size']}，和请求的 {size_text} 不同（窗口加边框放不进显示器时系统会"
                                     "压小窗口；要准确的客户区用 borderless）")
        if fg["changed"]:
            after = fg["after"] or {}
            result["foreground_taken"] = after.get("hwnd") == info["hwnd"]
        if ensured is not None:
            result["ensure_running"] = ensured
        return result


def _own_entry(window: str) -> dict[str, Any]:
    entry = registry.get(window)
    if entry is None:
        if win.find_test_window(window, _main_pids()):
            raise WpeError(f"{window} 不在窗口表里，是外来窗口（不是本会话开的），不碰")
        raise WpeError(f"没有叫 {window} 的测试窗口")
    kind = registry.owner_kind(entry)
    if kind == "other":
        raise WpeError(f"{window} 属于别的会话（MCP 进程 {entry.get('owner_pid')}），只能关自己的窗口")
    if kind == "stale":
        raise WpeError(f"{window} 属于已不在的会话（MCP 进程 {entry.get('owner_pid')}），"
                       "ensure_running / status 会把它当陈旧窗口关掉")
    return entry


def close_wallpaper(window: str) -> dict[str, Any]:
    with _op_lock:
        entry = _own_entry(window)
        result = {"window": window, "project": entry.get("project"), "size": entry.get("size")}
        result.update(_close_by_name(window))
        if result.get("window_existed") and not result.get("gone"):
            raise WpeError(f"发了 closeWallpaper，但 {window} 10 s 内没消失；表项保留")
        registry.delete(window)
        result["unregistered"] = True
        return result


def apply_properties(window: str, props: dict[str, Any]) -> dict[str, Any]:
    with _op_lock:
        _own_entry(window)
        if not isinstance(props, dict) or not props:
            raise WpeError("props 要是非空的 {属性名: 值} 对象")
        if not win.find_test_window(window, _main_pids()):
            raise WpeError(f"{window} 的窗口已经不在了")
        text = json.dumps(props, separators=(",", ":"), ensure_ascii=False)
        if ")~END" in text:
            raise WpeError("属性值里不能出现 )~END")
        sent = ctl.control(f"applyProperties -location {window} -properties RAW~({text})~END")
        return {"window": window, "properties": props, "took_s": sent["took_s"]}


def close_all_mine() -> list[dict[str, Any]]:
    """MCP 退出时：关掉本会话的全部窗口、删表项。WPE 不动。"""
    done = []
    try:
        mine = [e for e in registry.entries() if registry.is_mine(e)]
    except OSError:
        return done
    for entry in mine:
        item = {"name": entry["name"]}
        try:
            if process.main_pid() is not None:
                item.update(_close_by_name(entry["name"], timeout=5))
        except Exception as e:  # 退出路径上不抛
            item["error"] = str(e)
        if not item.get("window_existed") or item.get("gone"):
            registry.delete(entry["name"])
        done.append(item)
    return done


# ==================== 清理测试工程 ====================


def cleanup_project(path: str) -> dict[str, Any]:
    """删 WPE 写进测试工程的 shaders/blobsSM40。只限仓库 ignore/ 下的工程目录，路径规范化后判断。"""
    if not path or not os.path.isabs(path):
        raise WpeError("path 要是绝对路径（工程目录或它的 project.json）")
    real = os.path.realpath(path)
    if os.path.isfile(real) and os.path.basename(real).lower() == "project.json":
        real = os.path.dirname(real)
    ignore = os.path.realpath(paths.IGNORE_DIR)
    norm_real, norm_ignore = os.path.normcase(real), os.path.normcase(ignore)
    try:
        inside = os.path.commonpath([norm_real, norm_ignore]) == norm_ignore and norm_real != norm_ignore
    except ValueError:  # 不同盘
        inside = False
    if not inside:
        raise WpeError(f"拒绝：{real} 不在仓库的 ignore/ 目录（{ignore}）下")
    if not os.path.isfile(os.path.join(real, "project.json")):
        raise WpeError(f"拒绝：{real} 下没有 project.json，不是工程目录")
    for entry in registry.entries():
        project = entry.get("project") or ""
        if project and os.path.normcase(os.path.dirname(os.path.realpath(project))) == norm_real:
            raise WpeError(f"拒绝：窗口 {entry['name']}（{OWNER_LABEL.get(registry.owner_kind(entry))}）"
                           "正开着这个工程，关窗后再清理")
    target = os.path.join(real, "shaders", "blobsSM40")
    if not os.path.isdir(target):
        return {"project_dir": real, "deleted": False, "reason": "没有 shaders/blobsSM40"}
    files = sum(len(names) for _, _, names in os.walk(target))
    shutil.rmtree(target)
    return {"project_dir": real, "deleted": True, "path": target, "files": files}
