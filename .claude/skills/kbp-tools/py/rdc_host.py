"""`kbp rdc track|frame|stats` 的本机一侧：算好输入输出、写 job.json、拉起 `qrenderdoc --python rdc/main.py`、
等结果、转成一行摘要。

- 一次启动处理一个抓帧目录里的全部 .rdc；进程没有界面（脚本不返回、os._exit），不经 MCP、不和用户的 RenderDoc
  或 wpe-renderdoc MCP 的回放进程共享任何状态（job 目录在系统临时目录，按本进程私有）。
- 输出已存在时拒绝，除非 --overwrite（数据目录缺省是 ignore/p4，里面是现有真值）。
- 进度：RenderDoc 侧写 job 目录的 log.txt，这里转到 stderr（--quiet 关掉）。
- 超时（--timeout，缺省 1800 s）只结束本次自己拉起的那个 qrenderdoc（按 Popen 句柄），别的进程一律不碰。
"""

import ctypes
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

from . import common
from .common import KbpError

RDC_DIR = os.path.join(common.SKILL_DIR, "rdc")
MAIN_SCRIPT = os.path.join(RDC_DIR, "main.py")
FRAME_RE = re.compile(r"frame(\d+)")

CREATE_NO_WINDOW = 0x08000000
STARTF_USESHOWWINDOW = 0x00000001
SW_HIDE = 0
POLL = 0.05


def _process_created():
    """本进程的创建时刻（FILETIME），给 RenderDoc 侧的看门线程防进程号复用。"""
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.GetCurrentProcess.restype = ctypes.c_void_p
    kernel32.GetProcessTimes.argtypes = [ctypes.c_void_p] + [ctypes.POINTER(ctypes.c_uint64)] * 4
    times = [ctypes.c_uint64() for _ in range(4)]
    if not kernel32.GetProcessTimes(kernel32.GetCurrentProcess(), *[ctypes.byref(t) for t in times]):
        return None
    return times[0].value


def _rdc_names(folder):
    if not os.path.isdir(folder):
        raise KbpError("data", "抓帧目录不存在：%s" % folder)
    names = [n for n in os.listdir(folder) if n.endswith(".rdc")]
    if not names:
        raise KbpError("data", "目录里没有 .rdc：%s" % folder)
    for n in names:
        if not FRAME_RE.search(n):
            raise KbpError("data", "抓帧文件名里没有 frame<帧号>：%s" % n)
    return sorted(names, key=lambda n: int(FRAME_RE.search(n).group(1)))


def resolve_project(data, project, tag):
    """[工程]：现有目录 → 直接用；名字 → <data>/proj/<名字>；没给 → 从标签的「<工程>-fps<N>…」推。"""
    if project and os.path.isdir(project):
        path = os.path.abspath(project)
        return os.path.basename(path.rstrip("\\/")), path
    if not project:
        match = re.match(r"^(.+?)-fps\d+", tag)
        if not match:
            raise KbpError("data", "没给工程，标签 %s 里也推不出（约定 <工程>-fps<N>…）" % tag)
        project = match.group(1)
    path = os.path.join(data, "proj", project)
    if not os.path.isdir(path):
        raise KbpError("data", "找不到工程目录 %s" % path)
    return project, path


def plan(action, args):
    """算出 job（不含进程相关字段）与这次会写的文件。"""
    folder = os.path.abspath(args.folder)
    names = _rdc_names(folder)
    data = common.data_dir(args.data)
    tag = args.tag
    job = {"action": action, "folder": folder, "tag": tag, "params": {}}
    outputs = []
    if action == "track":
        project, project_dir = resolve_project(data, args.project, tag)
        meta_path = os.path.join(project_dir, "kbp-meta.json")
        has_meta = os.path.isfile(meta_path)
        points = getattr(args, "points", False)
        if args.draws and points:
            raise KbpError("kbp", "--draws 与 --points 只能给一个")
        # 认法：命令行优先；否则 kbp-meta.json 的 track（第 2 批的生成库只在显式给出时写）；再否则有 meta 按粒子、没有按老工程
        meta_track = common.read_json(meta_path).get("track") if has_meta else None
        if (args.draws or points) and not has_meta:
            raise KbpError("data", "%s 要工程有 kbp-meta.json：%s" % ("--draws" if args.draws else "--points", project_dir))
        if args.draws:
            mode, source = "draws", "flag"
        elif points:
            mode, source = "points", "flag"
        elif meta_track is not None:
            if meta_track not in ("draws", "points"):
                raise KbpError("data", "%s 的 track 只能是 draws 或 points，收到 %r" % (meta_path, meta_track))
            mode, source = meta_track, "meta"
        else:
            mode, source = ("points", "auto") if has_meta else ("legacy", "auto")
        job["mode_source"] = source
        if mode == "legacy" and not os.path.isfile(os.path.join(project_dir, "scene.json")):
            raise KbpError("data", "工程没有 kbp-meta.json 也没有 scene.json：%s" % project_dir)
        out = os.path.abspath(args.out) if args.out else os.path.join(data, "tracks", "rd-%s.json" % tag)
        job["params"] = {"project": project, "project_dir": project_dir, "mode": mode, "limit": args.limit}
        outputs = [out]
    elif action == "frame":
        out = os.path.abspath(args.out) if args.out else os.path.join(data, "out")
        if args.present and args.event is not None:
            raise KbpError("kbp", "--present 与 --event 只能给一个")
        mode = "present" if args.present else ("event" if args.event is not None else "last")
        job["params"] = {"mode": mode, "event": args.event}
        exts = ("png", "dds") if mode == "present" else ("png",)
        for n in names:
            frame = int(FRAME_RE.search(n).group(1)) + 1
            outputs += [os.path.join(out, "wpe-%s-f%d.%s" % (tag, frame, e)) for e in exts]
        outputs.append(os.path.join(out, "wpe-%s.json" % tag))
    elif action == "stats":
        out = os.path.abspath(args.out) if args.out else os.path.join(data, "out", "wpe-%s-stats.json" % tag)
        outputs = [out]
    elif action == "shaders":
        out = os.path.abspath(args.out) if args.out else os.path.join(data, "out", "wpe-%s-shaders.json" % tag)
        outputs = [out]
    elif action == "consts":
        out = os.path.abspath(args.out) if args.out else os.path.join(data, "out", "wpe-%s-consts.json" % tag)
        job["params"] = {"names": [n for n in (args.names or "").split(",") if n], "clock": not args.no_clock}
        outputs = [out]
    else:
        raise KbpError("kbp", "未知的动作 %s" % action)
    job["out"] = out
    return job, outputs, len(names)


def _tail(path, pos, quiet):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            f.seek(pos)
            text = f.read()
            pos = f.tell()
    except FileNotFoundError:
        return pos
    if text and not quiet:
        sys.stderr.write(text)
        sys.stderr.flush()
    return pos


def _log_tail(path, lines=15):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return "\n".join(f.read().splitlines()[-lines:])
    except OSError:
        return "（没有日志）"


def run(action, args):
    job, outputs, count = plan(action, args)
    existing = [p for p in outputs if os.path.exists(p)]
    if existing and not args.overwrite:
        raise KbpError("data", "输出已存在（不覆盖，要覆盖加 --overwrite）：%s" % "、".join(existing[:5])
                       + ("…" if len(existing) > 5 else ""))
    qrenderdoc = os.path.join(common.renderdoc_dir(), "qrenderdoc.exe")
    if not os.path.isfile(qrenderdoc):
        raise KbpError("renderdoc", "找不到 %s（可用环境变量 RENDERDOC_DIR 指定 RenderDoc 安装目录）" % qrenderdoc)
    if not os.path.isdir(os.path.join(common.MCP_DIR, "renderdoc_worker")):
        raise KbpError("renderdoc", "找不到服务层 %s" % os.path.join(common.MCP_DIR, "renderdoc_worker"))

    work = tempfile.mkdtemp(prefix="kbp-rdc-")
    job.update({
        "mcp_dir": common.MCP_DIR,
        "skill_dir": common.SKILL_DIR,
        "parent_pid": os.getpid(),
        "parent_created": _process_created(),
        "result": os.path.join(work, "result.json"),
        "log": os.path.join(work, "log.txt"),
    })
    job_file = os.path.join(work, "job.json")
    with open(job_file, "w", encoding="utf-8") as f:
        json.dump(job, f, ensure_ascii=False)

    # 内嵌 Python 不该看到本机 Python 的 PYTHON* 变量
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith("PYTHON")}
    env["KBP_RDC_JOB"] = job_file
    startup = subprocess.STARTUPINFO()
    startup.dwFlags |= STARTF_USESHOWWINDOW
    startup.wShowWindow = SW_HIDE
    spawned = time.time()
    proc = subprocess.Popen([qrenderdoc, "--python", MAIN_SCRIPT], env=env, cwd=common.renderdoc_dir(),
                            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            startupinfo=startup, creationflags=CREATE_NO_WINDOW)
    pos = 0
    deadline = spawned + args.timeout
    keep = args.keep_work
    try:
        while proc.poll() is None:
            pos = _tail(job["log"], pos, args.quiet)
            if time.time() > deadline:
                proc.kill()
                try:
                    proc.wait(10)
                except subprocess.TimeoutExpired:
                    pass
                keep = True
                raise KbpError("renderdoc", "qrenderdoc 超过 %g s 没完成，已结束本次拉起的进程 %d。日志 %s 末尾：\n%s"
                               % (args.timeout, proc.pid, job["log"], _log_tail(job["log"])))
            time.sleep(POLL)
        pos = _tail(job["log"], pos, args.quiet)
        finished = time.time()
        try:
            with open(job["result"], encoding="utf-8") as f:
                result = json.load(f)
        except (OSError, ValueError):
            keep = True
            raise KbpError("renderdoc", "qrenderdoc 退出（退出码 %s）但没有结果。日志 %s 末尾：\n%s"
                           % (proc.returncode, job["log"], _log_tail(job["log"])))
        if not result.get("ok"):
            keep = True
            message = result.get("error") or "未知错误"
            layer, _, rest = message.partition("] ")
            raise KbpError(layer.lstrip("[") if rest else "renderdoc", (rest or message) + "（日志 %s）" % job["log"])
    finally:
        if not keep:
            shutil.rmtree(work, ignore_errors=True)

    summary = {"ok": True, "action": action, "tag": job["tag"], "folder": job["folder"], "out": result.get("out")}
    for key in ("index", "mode", "project", "frames"):
        if key in result:
            summary[key] = result[key]
    if "mode_source" in job:
        summary["mode_source"] = job["mode_source"]  # flag：命令行；meta：kbp-meta.json 的 track；auto：按有没有 meta
    summary["seconds"] = {
        "startup": round(result["ready_at"] - spawned, 3),
        "total": round(finished - spawned, 3),
        "captures": [item["seconds"] for item in result.get("items", [])],
    }
    summary["renderdoc"] = result.get("renderdoc")
    if keep:
        summary["work"] = work
    return summary
