"""
ensure_running 与 restart_wpe。

ensure_running（总计划步骤 2 的判定顺序）：
1. 旧 skill 的 state.json 在：拒绝（旧会话正用着它自己注入启动的 WPE，旧 stop 会把它强杀）。
2. 没有 wallpaper64：崩溃标记为 1 就先写 0；WMI 普通启动 -silent；等桌面壁纸窗口出现、再稳 2 s
   （用户没选桌面壁纸时改等事件窗口）；然后注入。
3. 有 wallpaper64、没注入：renderdoccmd inject --PID 原地注入。
4. 已注入：不动。
5. 注入后核对 renderdoc.dll 已加载。
6. 关陈旧窗口。
本批不连 RenderDoc 的抓帧目标，「已注入」只看进程里有没有 renderdoc.dll。

restart_wpe(settings)：正常退出 → 改 config.json → -silent 启动 → 注入。只在没有别的会话的窗口、没有外来窗口、
设置界面没开着、旧 skill 会话不在、settings 合法时做。全程持有 wpe.lock 与 windows.lock，别的会话这段时间开不了窗。
从不强杀 WPE：退不掉就报出来，不改文件。
"""

from __future__ import annotations

import os
import time
from typing import Any

from .. import paths
from . import process, registry, session
from . import settings as cfg
from .common import WpeError, now_iso, wait_until


def old_skill_session() -> dict[str, Any] | None:
    if not os.path.exists(paths.OLD_SKILL_STATE):
        return None
    return {"state_file": paths.OLD_SKILL_STATE}


def _refuse_old_skill() -> None:
    if old_skill_session():
        raise WpeError(f"旧 wpe-renderdoc skill 的会话还在（{paths.OLD_SKILL_STATE}）：它正在用自己注入启动的 WPE，"
                       "旧的 stop 会强杀它。等那边 stop 之后再用")


def _start() -> dict[str, Any]:
    """普通 -silent 启动并等它起来（桌面壁纸或事件窗口），不注入。"""
    expect_desktop = cfg.has_desktop_wallpaper()
    t0 = time.monotonic()
    pid = process.spawn_silent()
    report = process.wait_started(pid, expect_desktop)
    report["started_at"] = now_iso()
    report["took_s"] = round(time.monotonic() - t0, 2)
    mains = [p["pid"] for p in process.main_processes()]
    if mains != [pid]:
        raise WpeError(f"启动后 wallpaper64 主实例是 {mains}，不是刚起的 {pid}")
    # -silent 正常不开任何界面；开了说明进了安全启动或别的分支，报出来
    report["ui_processes"] = process.ui_processes()
    return report


def _inject(pid: int) -> dict[str, Any]:
    result = process.inject(pid)
    loaded = wait_until(lambda: process.injected(pid)[0], 5.0, 0.1)
    result["renderdoc_loaded"] = bool(loaded)
    if not loaded:
        state, error = process.injected(pid)
        raise WpeError(f"注入后 5 s 内没看到 renderdoc.dll（{error or state}）：renderdoccmd 返回 {result}")
    if not process.alive(pid):
        raise WpeError(f"注入后 WPE {pid} 退出了：{result}")
    return result


def _ensure_locked() -> dict[str, Any]:
    report: dict[str, Any] = {"steps": []}
    pid = process.main_pid()
    if pid is None:
        flag = process.crash_flag()
        report["crash_flag_before"] = flag
        if flag == 1:
            process.set_crash_flag(0)
            report["steps"].append("cleared_crash_flag")
            report["cleared_crash_flag"] = True
        else:
            report["cleared_crash_flag"] = False
        report["start"] = _start()
        report["steps"].append("started")
        pid = report["start"]["pid"]
    report["pid"] = pid
    report["integrity"] = process.integrity_level(pid)
    state, error = process.injected(pid)
    if state is None:
        raise WpeError(f"查不了 WPE {pid} 是否已注入：{error}。不提权，也不注入")
    if state:
        report["steps"].append("already_injected")
    else:
        report["inject"] = _inject(pid)
        report["steps"].append("injected")
    report["injected"] = True
    return report


def ensure_running() -> dict[str, Any]:
    _refuse_old_skill()
    t0 = time.monotonic()
    with registry.wpe_lock.held(120) as lock:
        report = _ensure_locked()
        report["wpe_lock_wait_s"] = lock.waited
    report["stale_closed"] = session.close_stale()
    view = session.survey()
    report["foreign_windows"] = view["foreign"]
    report["desktop"] = process.desktop_windows(report["pid"])
    report["took_s"] = round(time.monotonic() - t0, 2)
    return report


def restart_wpe(settings: dict[str, Any] | None = None) -> dict[str, Any]:
    t_all = time.monotonic()
    changes, problems = cfg.validate(settings or {})
    if old_skill_session():
        problems.append(f"旧 wpe-renderdoc skill 的会话还在（{paths.OLD_SKILL_STATE}）")
    if problems:
        raise WpeError("拒绝 restart_wpe：" + "；".join(problems))
    report: dict[str, Any] = {"requested": settings or {}}
    with registry.wpe_lock.held(120) as wlock, registry.windows_lock.held(120) as tlock:
        report["lock_wait_s"] = {"wpe": wlock.waited, "windows": tlock.waited}
        report["stale_closed"] = session.close_stale()
        view = session.survey()
        others = [session._brief(e) for e in view["registered"] if e["owner"] == "other"]
        if others:
            problems.append("别的会话还有测试窗口（重启会把它们一起关掉）："
                            + "，".join(f"{o['name']}（MCP {o['owner_pid']}，{'在' if o['exists'] else '未出现'}）"
                                       for o in others))
        if view["foreign"]:
            problems.append("有不在窗口表里的外来测试窗口（不知道是谁的）："
                            + "，".join(f"{f['name']}（hwnd {f['hwnd']}）" for f in view["foreign"]))
        ui = process.settings_ui()
        if ui:
            problems.append(f"WPE 的设置界面开着（wallpaperui {[u['pid'] for u in ui]}），退出时可能把设置写回文件")
        if problems:
            raise WpeError("拒绝 restart_wpe：" + "；".join(problems))

        # 2. 关本会话自己的窗口
        report["closed_mine"] = []
        for entry in view["registered"]:
            if entry["owner"] == "mine":
                item = {"name": entry["name"], **session._close_by_name(entry["name"])}
                registry.delete(entry["name"])
                report["closed_mine"].append(item)

        # 3. 正常退出
        pid = process.main_pid()
        if pid is not None:
            children = process.children_of(pid)
            sha_before = cfg.file_sha256()
            report["old_pid"] = pid
            report["flag_before_exit"] = process.crash_flag()
            quit_report = process.quit_wpe(pid, 20.0)
            report["exit"] = quit_report
            if not quit_report["exited"]:
                raise WpeError(f"WPE {pid} 20 s 内没有正常退出。没有强杀，也没有改 config.json；"
                               "请从托盘退出或检查 WPE 是否卡住")
            # 4. 退出前后文件哈希（验证「正常退出不写 config.json」）与崩溃标记
            sha_after = cfg.file_sha256()
            report["config_sha256_before_exit"] = sha_before
            report["config_sha256_after_exit"] = sha_after
            report["config_unchanged_by_exit"] = sha_before == sha_after
            report["flag_after_exit"] = process.crash_flag()
            # 注入过的 WPE 有个 renderdoccmd crashhandle 子进程，随它退出，稍等再看
            wait_until(lambda: not any(process.alive(c["pid"]) for c in children), 3.0, 0.1)
            report["children_left"] = [c for c in children if process.alive(c["pid"])]
        else:
            report["old_pid"] = None
            report["exit"] = "WPE 本来就没在跑"
        flag = process.crash_flag()
        if flag == 1:
            process.set_crash_flag(0)
            report["cleared_crash_flag"] = True

        # 5. 写设置（第一次写前留备份）
        if changes:
            report["write"] = cfg.write_settings(changes)
        mtime_before_start = os.stat(paths.wpe_config()).st_mtime_ns

        # 6. 启动、注入
        report["start"] = _start()
        new_pid = report["start"]["pid"]
        report["new_pid"] = new_pid
        report["inject"] = _inject(new_pid)
        report["injected"] = True

        # 7. WPE 起来后再读文件，核对新值还在。读码说启动时的规范化会回写文件，但实测（2026-11-09）
        #    修改时刻没变、没有回写，所以「新值还在」只说明没被覆盖；读没读进去要看新开窗口的实际表现
        if changes:
            _, data = cfg.read_config()
            _, values = cfg.current_values(data)
            report["verify"] = {key: {"wanted": value, "file_now": values.get(key), "ok": values.get(key) == value}
                                for key, value in changes.items()}
            report["verified"] = all(v["ok"] for v in report["verify"].values())
        report["config_rewritten_on_start"] = os.stat(paths.wpe_config()).st_mtime_ns != mtime_before_start
        report["config_sha256_now"] = cfg.file_sha256()
        report["desktop"] = process.desktop_windows(new_pid)
    report["took_s"] = round(time.monotonic() - t_all, 2)
    return report


def status() -> dict[str, Any]:
    stale = session.close_stale()
    wpe = []
    for p in process.wpe_processes():
        item = dict(p)
        if p["role"] == "main":
            state, error = process.injected(p["pid"])
            item["injected"] = state
            if error:
                item["injected_error"] = error
            item["event_window"] = process.event_window(p["pid"])
        wpe.append(item)
    view = session.survey()
    return {
        "mcp": {"pid": registry.SELF_PID, "created": registry.SELF_CREATED},
        "wpe": wpe,
        "faultyShutdown": process.crash_flag(),
        "desktop": process.desktop_windows(),
        "windows": [session._brief(e) for e in view["registered"]],
        "foreign_windows": view["foreign"],
        "stale_closed": stale,
        "settings_ui": process.settings_ui(),
        "ui_processes": process.ui_processes(),
        "old_skill_session": old_skill_session(),
    }


def get_settings() -> dict[str, Any]:
    raw, data = cfg.read_config()
    section, values = cfg.current_values(data)
    ui = process.settings_ui()
    result = {
        "config": paths.wpe_config(),
        "user": section,
        "sha256": cfg.file_sha256(),
        "settings": {key: {"value": values[key], "path": ".".join([section] + cfg.key_path(key)),
                           "allowed": cfg.describe_spec(info["spec"]), "category": info["category"]}
                     for key, info in cfg.KEYS.items()},
        "faultyShutdown": process.crash_flag(),
        "selected_wallpapers": cfg.selected_wallpapers(data[section]),
        "settings_ui_open": bool(ui),
        "settings_ui": ui,
        "since_backup": cfg.changed_since_backup(data),
        "note": "读的是文件；WPE 只在启动时读它，改设置要用 restart_wpe(settings)",
    }
    if ui:
        result["warning"] = "WPE 的设置界面开着：改了还没点「确定」时，文件可能落后于 WPE 内存里的值"
    return result
