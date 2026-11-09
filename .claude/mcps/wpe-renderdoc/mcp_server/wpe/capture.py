"""
抓帧（第 3 批）：capture、capture_wallpaper、capture_sweep。

连 RenderDoc 注入在 WPE 里的目标（Target Control）在本会话的回放工作进程里做（renderdoc_worker/target.py），
因为 Target Control API 只能在 qrenderdoc --python 里用。目标的连接是独占的：别的客户端连着时不抢占的连接会被拒，
抢占会把对方踢掉。所以：
- 连目标一律不抢占；
- 机器级的抓帧锁 target.lock 保证同一时刻只有一个 MCP 在连。锁只覆盖「找目标号 → 连接 → 选中自己的窗口 → 触发 →
  收文件 → 断开 → 移动文件」这几秒，回放核对与分析都在锁外。

capture(window, out, frames, tag, timeout, overwrite)：
1. 窗口必须是本会话的、且还在；期望尺寸取窗口表里的尺寸。
2. WPE 必须在跑、已注入。目标号按进程号找，缓存到 WPE 的进程（进程号 + 创建时刻）变了为止。
3. 抓帧锁里调工作进程的 target_capture（认窗口、抓 N 帧、逐张核对缩略图），文件从模板目录移到 out，
   命名 <tag>-frame<帧号>.rdc。目标已存在且没给 overwrite 就拒绝，本次的文件也删掉；模板目录里不留本次的文件。
4. 锁外：核对帧号连续（gaps）；另开一个回放读第一张，核对后备缓冲尺寸等于窗口尺寸，报绘制数。
"""

from __future__ import annotations

import os
import re
import shutil
import time
from typing import Any

from .. import paths
from . import ensure as wpe_ensure
from . import log as wlog
from . import process, registry, session
from . import settings as cfg
from . import windows as win
from .common import WpeError, now_iso

CLIENT = f"kabegame-wpe-renderdoc-mcp-{registry.SELF_PID}"
# 缩略图容差（缩略图像素）：抓到的缩略图和按规则（renderdoc_worker/target.py 的 predicted_thumb）预测的差在这以内
# 就算对得上。窗口尺寸的容差是 session.SIZE_TOL。两者都随请求传给工作进程。
THUMB_TOL = 2
TAG_RE = re.compile(r'^[^\\/:*?"<>|\s][^\\/:*?"<>|]*$')
MAX_FRAMES = 100
# 抓帧锁等多久（别的会话一次抓帧通常几秒；它在探测或抓大场景时会更久）
LOCK_TIMEOUT = 120.0

# 目标号缓存：WPE 的（进程号, 创建时刻）→ 目标号
_target_cache: dict[str, Any] = {}


# ==================== 校验 ====================


def _inside(path: str, folder: str) -> bool:
    a = os.path.normcase(os.path.realpath(path))
    b = os.path.normcase(os.path.realpath(folder))
    try:
        return os.path.commonpath([a, b]) == b
    except ValueError:  # 不同盘
        return False


def check_out(out: str, what: str = "out", min_depth: int = 2) -> str:
    """out 必须给：绝对路径，约定 A:\\<项目>\\<用途>\\；不接受仓库里的路径和抓帧模板目录。返回规范化的路径。"""
    if not out or not isinstance(out, str) or not os.path.isabs(out):
        raise WpeError(f"{what} 要是绝对路径，约定 A:\\<项目>\\<用途>\\（不设缺省目录）")
    real = os.path.normpath(os.path.abspath(out))
    if _inside(real, paths.REPO_ROOT):
        raise WpeError(f"拒绝：{what} 在仓库里（{real}）。抓帧放仓库外，约定 A:\\<项目>\\<用途>\\")
    template_dir = os.path.dirname(paths.capture_template())
    if _inside(real, template_dir) or _inside(template_dir, real):
        raise WpeError(f"拒绝：{what}（{real}）和抓帧模板目录 {template_dir} 重叠")
    _, rest = os.path.splitdrive(real)
    depth = len([p for p in re.split(r"[\\/]+", rest) if p])
    if depth < min_depth:
        raise WpeError(f"拒绝：{what}（{real}）太浅。约定 A:\\<项目>\\<用途>\\，项目根下散落的抓帧不算数")
    return real


def check_tag(tag: str) -> str:
    if not isinstance(tag, str) or not TAG_RE.match(tag) or tag in (".", ".."):
        raise WpeError(f"tag 不能含路径分隔符或 Windows 文件名里不允许的字符：{tag!r}")
    return tag


def same_tag_files(out_dir: str, tag: str) -> list[str]:
    """out 里已有的 <tag>-frame<数字>.rdc。"""
    if not os.path.isdir(out_dir):
        return []
    pattern = re.compile(re.escape(tag) + r"-frame\d+\.rdc$", re.IGNORECASE)
    return sorted(os.path.join(out_dir, n) for n in os.listdir(out_dir) if pattern.match(n))


def _size_of(text: str | None) -> list[int] | None:
    if not text:
        return None
    try:
        w, h = session.parse_size(text)
        return [w, h]
    except WpeError:
        return None


def _unique(sizes: list[list[int]]) -> list[list[int]]:
    unique: list[list[int]] = []
    for s in sizes:
        if s not in unique:
            unique.append(s)
    return unique


def other_sizes(own: str) -> tuple[list[list[int]], list[list[int]], int]:
    """别的可能被抓到的窗口：(别的测试窗口尺寸（屏幕上的与表里登记了的）, 桌面壁纸窗口尺寸, 屏幕上的测试窗口数)。"""
    sizes: list[list[int]] = []
    shown = win.test_windows(session._main_pids())
    for w in shown:
        if w["name"] != own and w.get("client"):
            sizes.append([w["client"][2], w["client"][3]])
    for entry in registry.entries():
        if entry.get("name") != own:
            s = _size_of(entry.get("size"))
            if s:
                sizes.append(s)
    desktop = [[d["rect"][2], d["rect"][3]] for d in process.desktop_windows() if d.get("rect")]
    return _unique(sizes), _unique(desktop), len(shown)


def _template_file_ok(path: str, template: str) -> bool:
    """路径在抓帧模板目录里、文件名以模板名开头、以 .rdc 结尾。"""
    norm = os.path.normcase(os.path.abspath(path))
    folder = os.path.normcase(os.path.abspath(os.path.dirname(template)))
    name = os.path.basename(norm)
    return (os.path.dirname(norm) == folder and name.startswith(os.path.basename(template).lower())
            and name.endswith(".rdc"))


def _delete_template_file(path: str, template: str) -> dict[str, Any]:
    if not _template_file_ok(path, template):
        return {"path": path, "deleted": False, "reason": "不在抓帧模板目录里或文件名不对，不删"}
    for i in range(50):
        try:
            os.remove(path)
            return {"path": path, "deleted": True}
        except FileNotFoundError:
            return {"path": path, "deleted": False, "reason": "文件不在"}
        except PermissionError:
            if i == 49:
                return {"path": path, "deleted": False, "reason": "删不掉（被占用）"}
            time.sleep(0.05)
    return {"path": path, "deleted": False}


def _move_file(src: str, dest: str) -> None:
    """同盘直接改名（目标在就替换）；跨盘复制后删源。被占用时稍后再试。"""
    for i in range(50):
        try:
            try:
                os.replace(src, dest)
            except OSError as e:
                if getattr(e, "winerror", None) != 17:  # ERROR_NOT_SAME_DEVICE
                    raise
                shutil.copy2(src, dest)
                os.remove(src)
            return
        except PermissionError:
            if i == 49:
                raise
            time.sleep(0.05)


# ==================== 目标号 ====================


def _wpe_identity() -> tuple[int, int | None]:
    pid = process.main_pid()
    if pid is None:
        raise WpeError("WPE 没在跑。先 open_wallpaper（会 ensure_running）")
    state, error = process.injected(pid)
    if state is None:
        raise WpeError(f"查不了 WPE {pid} 是否已注入：{error}")
    if not state:
        raise WpeError(f"WPE {pid} 没注入 RenderDoc，抓不了。先 ensure_running")
    return pid, process.process_info(pid).get("created")


def _ident(worker, pid: int, created: int | None) -> tuple[int, bool]:
    """目标号与是否来自缓存。在抓帧锁里调：找目标号也要连目标。"""
    key = [pid, created]
    if _target_cache.get("key") == key:
        return _target_cache["ident"], True
    found = worker.call("target_find", {"pid": pid, "timeout": 10, "client": CLIENT}, timeout=60)
    if not found.get("ident"):
        if found.get("error_kind") == "busy":
            raise WpeError(f"连不上 WPE {pid} 的 RenderDoc 目标：{found.get('error')}")
        raise WpeError(f"找不到 WPE {pid} 的 RenderDoc 目标：{found.get('error')}；见过的目标：{found.get('seen')}")
    _target_cache.clear()
    _target_cache.update(key=key, ident=found["ident"])
    return found["ident"], False


# ==================== capture ====================


def capture(worker, window: str, out: str, frames: int = 3, tag: str | None = None, timeout: float = 60,
            overwrite: bool = False) -> dict[str, Any]:
    t_all = time.monotonic()
    if not isinstance(frames, int) or isinstance(frames, bool) or not 1 <= frames <= MAX_FRAMES:
        raise WpeError(f"frames 要是 1…{MAX_FRAMES} 的整数，收到 {frames!r}")
    if not timeout or timeout <= 0:
        raise WpeError(f"timeout 要大于 0，收到 {timeout!r}")
    out_dir = check_out(out)
    tag = check_tag(tag or os.path.basename(out_dir))
    with session._op_lock:
        entry = session._own_entry(window)
        shown_win = win.find_test_window(window, session._main_pids())
        if not shown_win:
            raise WpeError(f"{window} 的窗口已经不在了")
        expect = list(session.parse_size(entry["size"]))
        expect_note = None
        client = shown_win.get("client")
        # 窗口比屏幕大时系统会限制窗口大小，WPE 的交换链跟着实际客户区走（实测 3840×2160 → 3840×2130）
        if client and [client[2], client[3]] != expect:
            expect_note = (f"窗口表里是 {expect[0]}x{expect[1]}，屏幕上的客户区是 {client[2]}x{client[3]}"
                           "（系统限制了窗口大小），按客户区认")
            expect = [client[2], client[3]]
        pid, created = _wpe_identity()
        existing = same_tag_files(out_dir, tag)
        if existing and not overwrite:
            raise WpeError(f"{out_dir} 里已有 {len(existing)} 张 {tag}-frame*.rdc（如 {os.path.basename(existing[0])}），"
                           "没给 overwrite，没有抓。换一个 out / tag，或给 overwrite=True")
        others, desktop, shown = other_sizes(window)
        template = paths.capture_template()
        # 先把工作进程拉起来（第一次要一两秒），不占着抓帧锁等它
        worker.call("ping")

        note = {"window": window, "wpe_pid": pid, "out": out_dir}
        with registry.target_lock.held(LOCK_TIMEOUT, note) as lock:
            t_lock = time.monotonic()
            ident, cached = _ident(worker, pid, created)
            params = {"ident": ident, "frames": frames, "expect_size": list(expect), "template": template,
                      "others": others, "desktop": desktop, "test_windows": shown, "timeout": float(timeout),
                      "client": CLIENT, "size_tol": session.SIZE_TOL, "thumb_tol": THUMB_TOL}
            res = worker.call("target_capture", params, timeout=float(timeout) + 150)
            if not res.get("ok") and res.get("error_kind") in ("gone",):
                _target_cache.clear()
            if not res.get("ok"):
                detail = []
                if res.get("windows") is not None:
                    detail.append(f"可抓窗口 {res.get('windows')}")
                if res.get("probes"):
                    detail.append(f"探测 {[(p.get('thumb'), p.get('judge')) for p in res['probes']]}")
                deleted = [d.get("path") for d in res.get("deleted", []) if d.get("deleted")]
                if deleted:
                    detail.append(f"本次抓的已从模板目录删掉：{deleted}")
                kept = [d for d in res.get("deleted", []) if not d.get("deleted")]
                if kept:
                    detail.append(f"没删掉的：{kept}")
                raise WpeError(f"抓帧失败（{res.get('error_kind')}）：{res.get('error')}"
                               + ("。" + "；".join(detail) if detail else ""))
            moved = _move_captures(res["captures"], out_dir, tag, overwrite, template)
            leftover = [c["path"] for c in res["captures"] if os.path.exists(c["path"])]
            leftover += [p["path"] for p in res.get("probes", []) if p.get("path") and os.path.exists(p["path"])]
            held_s = round(time.monotonic() - t_lock, 2)
            lock_wait = lock.waited

        # 锁外：帧号连续、回放第一张
        numbers = [m["frame"] for m in moved]
        gaps = [b - a for a, b in zip(numbers, numbers[1:]) if b - a != 1]
        single = bool(res.get("single"))
        try:
            first = worker.call("target_inspect", {"path": moved[0]["path"]}, timeout=300)
            ok, why = check_backbuffer(first.get("backbuffers", []), expect, res.get("rivals") or others, single)
            first["backbuffer_ok"] = ok
            first["backbuffer_check"] = why
        except Exception as e:  # 回放出错不丢掉已经移好的文件，报出来
            first = {"path": moved[0]["path"], "error": f"回放核对出错：{e}", "backbuffer_ok": None}
        if first["backbuffer_ok"] is False:
            removed = []
            for m in moved:
                try:
                    os.remove(m["path"])
                    removed.append(m["path"])
                except OSError:
                    pass
            raise WpeError(f"回放核对不过：{first.get('backbuffer_check')}。抓到的不是本窗口，"
                           f"已删掉本次移到 out 的文件：{removed}")
        requested = list(session.parse_size(entry["size"]))
        backbuffer = (first.get("backbuffers") or [None])[0]
        size_note = None
        if backbuffer and backbuffer != requested:
            size_note = (f"实际的后备缓冲是 {backbuffer[0]}x{backbuffer[1]}，请求的是 {requested[0]}x{requested[1]}"
                         + (f"（屏幕上的客户区 {expect[0]}x{expect[1]}）" if expect != requested else ""))
        return {
            "window": window, "out": out_dir, "tag": tag, "expect_size": list(expect),
            "requested_size": requested, "backbuffer": backbuffer,
            **({"size_note": size_note} if size_note else {}),
            **({"expect_note": expect_note} if expect_note else {}),
            "identified_by": "唯一可抓窗口（不看尺寸）" if single else "尺寸（带容差）",
            "files": moved, "frames": numbers, "gaps": gaps,
            "first_frame": first,
            "lock_wait_s": lock_wait, "lock_held_s": held_s,
            "probes": len(res.get("probes", [])), "probe_detail": res.get("probes", []),
            "cycles": res.get("cycles", 0),
            "windows": res.get("windows"), "apis": res.get("apis"), "presenting": any(
                a.get("presenting") for a in res.get("apis", [])),
            "target": {"ident": ident, "cached": cached, "wpe_pid": pid, "backlog": res.get("backlog"),
                       "connect_s": res.get("connect_s"), "settle_s": res.get("settle_s"),
                       "capture_s": res.get("capture_s")},
            "others": others, "desktop_sizes": desktop, "test_windows_on_screen": shown,
            "rivals": res.get("rivals"), "desktop_hooked": bool(res.get("desktop_hooked")),
            "template_leftover": leftover,
            "replaced": [m["path"] for m in moved if m.get("replaced")],
            "took_s": round(time.monotonic() - t_all, 2),
        }


def check_backbuffer(backbuffers: list[list[int]], expect: list[int], rivals: list[list[int]],
                     single: bool) -> tuple[bool, str]:
    """锁外的回放核对，和工作进程里认窗口同一套容差规则：
    - 按「唯一可抓窗口」认的：不看尺寸，只报出来；
    - 其余：后备缓冲和本窗口差在 SIZE_TOL 以内，且没有别的窗口和它一样近或更近。"""
    if not backbuffers:
        return (single, "回放里没有后备缓冲" + ("（按唯一可抓窗口认的，不据此拒绝）" if single else ""))
    bb = backbuffers[0]
    d_mine = max(abs(bb[0] - expect[0]), abs(bb[1] - expect[1]))
    if single:
        return True, (f"按唯一可抓窗口认，不看尺寸；后备缓冲 {bb[0]}x{bb[1]}，与窗口 {expect[0]}x{expect[1]} 差 {d_mine}")
    if d_mine > session.SIZE_TOL:
        return False, (f"后备缓冲 {bb[0]}x{bb[1]} 和窗口 {expect[0]}x{expect[1]} 差 {d_mine}，"
                       f"超出容差 {session.SIZE_TOL}")
    closer = [r for r in rivals if max(abs(bb[0] - r[0]), abs(bb[1] - r[1])) <= d_mine]
    if closer:
        return False, f"后备缓冲 {bb[0]}x{bb[1]} 和别的窗口 {closer} 一样近或更近，分不清"
    return True, f"后备缓冲 {bb[0]}x{bb[1]} 对得上窗口 {expect[0]}x{expect[1]}（差 {d_mine}）"


def _move_captures(caps: list[dict[str, Any]], out_dir: str, tag: str, overwrite: bool,
                   template: str) -> list[dict[str, Any]]:
    """把本次抓的从模板目录移到 out。目标已存在且没给 overwrite：一张都不移，本次的文件全删掉，报错。"""
    plan = []
    for cap in sorted(caps, key=lambda c: c["frame"]):
        if not _template_file_ok(cap["path"], template):
            raise WpeError(f"工作进程报的抓帧路径 {cap['path']} 不在抓帧模板目录里，不动它")
        plan.append((cap, os.path.join(out_dir, f"{tag}-frame{cap['frame']}.rdc")))
    dests = [d for _, d in plan]
    if len(set(os.path.normcase(d) for d in dests)) != len(dests):
        deleted = [_delete_template_file(c["path"], template) for c, _ in plan]
        raise WpeError(f"本次抓帧里有重复的帧号 {[c['frame'] for c, _ in plan]}，没有移动；已删：{deleted}")
    clash = [d for d in dests if os.path.exists(d)]
    if clash and not overwrite:
        deleted = [_delete_template_file(c["path"], template) for c, _ in plan]
        raise WpeError(f"目标已存在：{clash}，没给 overwrite，一张都没移；本次抓的已从模板目录删掉："
                       f"{[d['path'] for d in deleted if d.get('deleted')]}")
    os.makedirs(out_dir, exist_ok=True)
    moved = []
    for cap, dest in plan:
        replaced = os.path.exists(dest)
        _move_file(cap["path"], dest)
        moved.append({"path": dest, "frame": cap["frame"], "bytes": cap["bytes"],
                      "mb": round(cap["bytes"] / 1048576, 2), "thumb": cap["thumb"], "judge": cap.get("judge"),
                      **({"replaced": True} if replaced else {})})
    return moved


def target_status(worker) -> dict[str, Any]:
    """连目标读 API、是否在呈现、可抓窗口数（不抢占，在抓帧锁里）。"""
    pid, created = _wpe_identity()
    worker.call("ping")
    with registry.target_lock.held(LOCK_TIMEOUT, {"what": "status"}) as lock:
        ident, cached = _ident(worker, pid, created)
        res = worker.call("target_status", {"ident": ident, "client": CLIENT}, timeout=60)
        if not res.get("ok") and res.get("error_kind") == "gone":
            _target_cache.clear()
        res["lock_wait_s"] = lock.waited
    res["ident_cached"] = cached
    return res


# ==================== capture_wallpaper ====================


def _capture_wallpaper(worker, project: str, out: str, frames: int = 3, size: str = "1280x720", wait: float = 8,
                       tag: str | None = None, log_grep: str | None = None, open_first: bool = True,
                       ensure=None, overwrite: bool = False) -> tuple[dict[str, Any], list[str]]:
    """返回 (结果, 开窗前到关窗后的全部日志行)。日志行给 capture_sweep 写文件用。"""
    t_all = time.monotonic()
    # 先校验，免得开了窗才发现 out 不对
    out_dir = check_out(out)
    tag = check_tag(tag or os.path.basename(out_dir))
    if not isinstance(wait, (int, float)) or wait < 0:
        raise WpeError(f"wait 要是不小于 0 的秒数，收到 {wait!r}")
    existing = same_tag_files(out_dir, tag)
    if existing and not overwrite:
        raise WpeError(f"{out_dir} 里已有 {len(existing)} 张 {tag}-frame*.rdc，没有开窗。换一个 out / tag")

    opened = session.open_wallpaper(project, size, 20, ensure=ensure)
    window = opened["window"]
    result: dict[str, Any] = {"window": window, "project": opened["project"], "size": opened["size"],
                              "open": {k: opened.get(k) for k in ("hwnd", "client", "appeared_after_s", "wpe_pid",
                                                                  "foreground", "foreground_taken", "warning")}}
    error: BaseException | None = None
    try:
        time.sleep(wait)
        result["capture_log_mark"] = wlog.mark()
        result["capture"] = capture(worker, window, out_dir, frames, tag, overwrite=overwrite)
    except BaseException as e:  # 中途出错也要关掉自己开的窗口
        error = e
    try:
        result["close"] = session.close_wallpaper(window)
    except BaseException as e:
        result["close_error"] = str(e)
        if error is None:
            error = e
    if error is not None:
        if isinstance(error, WpeError):
            closed = "已关窗" if "close" in result else f"关窗也失败了：{result.get('close_error')}"
            raise WpeError(f"{error}（窗口 {window} {closed}）") from None
        raise error

    # 日志从开窗前的游标截起：加载期的报错（着色器编译、JSON 解析）在开窗时打出
    raw = wlog.read_new(opened["log_mark"])
    log = wlog.since(opened["log_mark"], grep=log_grep)
    result["log"] = {"from": "开窗前（open_wallpaper 的 log_mark）", "valid": log.get("valid"),
                     "rewritten": log.get("rewritten"), "lines": log.get("lines"), "count": log.get("count"),
                     "total_new_lines": log.get("total_new_lines"), "truncated": log.get("truncated"),
                     "note": log.get("note"), "message": log.get("message")}
    if open_first:
        first = result["capture"]["files"][0]["path"]
        result["opened"] = worker.call("open_capture", {"capture_path": first}, timeout=300)
    result["took_s"] = round(time.monotonic() - t_all, 2)
    return result, raw.get("lines") or []


def capture_wallpaper(worker, project: str, out: str, frames: int = 3, size: str = "1280x720", wait: float = 8,
                      tag: str | None = None, log_grep: str | None = None, open_first: bool = True,
                      ensure=None) -> dict[str, Any]:
    result, _ = _capture_wallpaper(worker, project, out, frames, size, wait, tag, log_grep, open_first, ensure)
    return result


# ==================== capture_sweep ====================


def _project_name(project: str) -> str:
    path = project.rstrip("\\/")
    if os.path.basename(path).lower() == "project.json":
        path = os.path.dirname(path)
    return os.path.basename(path) or project


def _value_text(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def _read_values(keys: list[str]) -> dict[str, Any]:
    _, data = cfg.read_config()
    _, values = cfg.current_values(data)
    return {k: values.get(k) for k in keys}


KBP_MARK = "[kbp]"


def capture_sweep(worker, jobs: list[dict[str, Any]], out_root: str, log_dir: str | None = None,
                  ensure=None) -> dict[str, Any]:
    t_all = time.monotonic()
    root = check_out(out_root, "out_root", min_depth=1)
    if log_dir is not None:
        if not isinstance(log_dir, str) or not os.path.isabs(log_dir):
            raise WpeError("log_dir 要是绝对路径")
        log_dir = os.path.normpath(log_dir)
    if not isinstance(jobs, list) or not jobs:
        raise WpeError("jobs 要是非空列表：[{project, frames, size?, wait?, settings?, tag?}]")

    # 1. 规范化、校验（全部通过才动手）
    normal = []
    problems = []
    for i, job in enumerate(jobs):
        if not isinstance(job, dict) or not isinstance(job.get("project"), str) or not job["project"]:
            problems.append(f"第 {i + 1} 个 job 要有 project")
            continue
        settings = job.get("settings") or {}
        clean, bad = cfg.validate(settings)
        problems += [f"第 {i + 1} 个 job 的 settings：{b}" for b in bad]
        size = job.get("size")
        tag = job.get("tag") or (_project_name(job["project"])
                                 + "".join(f"-{k}{_value_text(v)}" for k, v in clean.items())
                                 + (f"-{size}" if size else ""))
        try:
            check_tag(tag)
        except WpeError as e:
            problems.append(f"第 {i + 1} 个 job：{e}")
        frames = job.get("frames", 3)
        if not isinstance(frames, int) or isinstance(frames, bool) or not 1 <= frames <= MAX_FRAMES:
            problems.append(f"第 {i + 1} 个 job 的 frames 要是 1…{MAX_FRAMES} 的整数")
        normal.append({"index": i, "project": job["project"], "frames": frames, "size": size or "1280x720",
                       "wait": job.get("wait", 8), "settings": clean, "tag": tag})
    tags = [j["tag"] for j in normal]
    dup = sorted({t for t in tags if tags.count(t) > 1})
    if dup:
        problems.append(f"tag 重复：{dup}（同一次扫描的 tag 要不同）")
    for j in normal:
        existing = same_tag_files(os.path.join(root, j["tag"]), j["tag"])
        if existing:
            problems.append(f"{os.path.join(root, j['tag'])} 里已有 {len(existing)} 张 {j['tag']}-frame*.rdc")
    if problems:
        raise WpeError("拒绝 capture_sweep：" + "；".join(problems))

    # 2. 按设置分组。没给的键取扫描开始时的值；和当前文件一样的那组排最前（省一次重启），其余按第一次出现的顺序
    keys: list[str] = []
    for j in normal:
        for k in j["settings"]:
            if k not in keys:
                keys.append(k)
    baseline = _read_values(keys)
    groups: list[dict[str, Any]] = []
    for j in normal:
        effective = {k: j["settings"].get(k, baseline[k]) for k in keys}
        for g in groups:
            if g["settings"] == effective:
                g["jobs"].append(j)
                break
        else:
            groups.append({"settings": effective, "jobs": [j]})
    groups.sort(key=lambda g: 0 if g["settings"] == baseline else 1)

    report: dict[str, Any] = {"out_root": root, "log_dir": log_dir, "keys": keys, "baseline": baseline,
                              "groups": [{"settings": g["settings"], "tags": [j["tag"] for j in g["jobs"]]}
                                         for g in groups],
                              "restarts": [], "jobs": []}
    changed = False
    stopped = None
    try:
        for g in groups:
            current = _read_values(keys)
            need = {k: v for k, v in g["settings"].items() if current.get(k) != v}
            if need:
                try:
                    r = wpe_ensure.restart_wpe(need)
                except WpeError as e:
                    stopped = f"改设置 {need} 被拒或失败，整次扫描停下：{e}"
                    break
                changed = True
                report["restarts"].append(_restart_brief(r, "group"))
            for j in g["jobs"]:
                report["jobs"].append(_sweep_job(worker, j, root, log_dir, ensure))
    finally:
        if changed:
            current = _read_values(keys)
            restore = {k: baseline[k] for k in keys if current.get(k) != baseline[k]}
            if restore:
                try:
                    report["restore"] = _restart_brief(wpe_ensure.restart_wpe(restore), "restore")
                except WpeError as e:
                    report["restore_error"] = (f"改回扫描开始时的设置 {restore} 失败：{e}。"
                                               f"设置现在停在 {current}")
            report["settings_now"] = _read_values(keys)
    if stopped:
        report["stopped"] = stopped
    report["ok"] = not stopped and "restore_error" not in report and all("error" not in j for j in report["jobs"])
    report["took_s"] = round(time.monotonic() - t_all, 2)
    return report


def _restart_brief(r: dict[str, Any], why: str) -> dict[str, Any]:
    return {"why": why, "requested": r.get("requested"), "old_pid": r.get("old_pid"), "new_pid": r.get("new_pid"),
            "write": r.get("write"), "verified": r.get("verified"),
            "config_unchanged_by_exit": r.get("config_unchanged_by_exit"), "took_s": r.get("took_s"),
            "at": now_iso()}


def _sweep_job(worker, j: dict[str, Any], root: str, log_dir: str | None, ensure) -> dict[str, Any]:
    out = os.path.join(root, j["tag"])
    item: dict[str, Any] = {"index": j["index"], "tag": j["tag"], "project": j["project"], "size": j["size"],
                            "frames_requested": j["frames"], "settings": j["settings"], "out": out}
    try:
        res, lines = _capture_wallpaper(worker, j["project"], out, j["frames"], j["size"], j["wait"], j["tag"],
                                        None, False, ensure)
    except WpeError as e:
        item["error"] = str(e)
        return item
    cap = res["capture"]
    kbp = [line for line in lines if KBP_MARK in line]
    errors = [line for line in lines if "error" in line.lower() and KBP_MARK not in line]
    item.update(files=[f["path"] for f in cap["files"]], frames=cap["frames"], gaps=cap["gaps"],
                first_frame={k: cap["first_frame"].get(k) for k in ("draws", "backbuffers", "backbuffer_ok")},
                backbuffer=cap.get("backbuffer"), **({"size_note": cap["size_note"]} if cap.get("size_note") else {}),
                probes=cap["probes"], lock_wait_s=cap["lock_wait_s"], log_lines=len(kbp), error_lines=len(errors),
                total_log_lines=len(lines), took_s=res["took_s"])
    if log_dir:
        os.makedirs(log_dir, exist_ok=True)
        for suffix, rows in (("log", kbp), ("errors", errors)):
            path = os.path.join(log_dir, f"{j['tag']}-{suffix}.txt")
            with open(path, "w", encoding="utf-8", newline="\n") as f:
                f.write("\n".join(rows) + "\n")
            item[f"{suffix}_file"] = path
    return item
