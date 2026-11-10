"""离线四角（kbp-tools 点 7）：`kbp corners offline <标签…>`，收 `ignore/p4/step4|c5|d1/corners-offline*`。

取 WPE 轨迹（`<data>/tracks/rd-<标签>.json`）里的顶点输入，跑我们翻译出的顶点 / 几何着色器（改写成计算着色器，Deno 的 WebGPU），
和 WPE 的 `gs_out` 比，限值 0.01 像素：
1. 备料：`node … vitest` 跑 `ts/corners.test.ts`（产品代码编译工程、算 uniform、写顶点、改写着色器），写 `<out>/offline*`；
2. 比较：`deno run --unstable-webgpu ts/corners.ts <out>`，写 `<out>/corners.txt`、`corners-result.json`。

轨迹的形状决定走哪条路：按粒子认（points，P4c 的 sprite / 拖尾，c5 的写法）或按绘制认（draws，P4d 的绳，d1 的写法，另比 uniform）。
「不符」（超限、画不画的判定不符、uniform 超限）是结果：摘要里 `failures`，退出码 0；`--strict` 时有不符退出码非 0（变异检查用）。
"""

import json
import os
import re
import shutil
import subprocess
import time

from . import common
from .common import KbpError
from . import replay_host

DENO_SCRIPT = os.path.join(common.SKILL_DIR, "ts", "corners.ts")
OWN = re.compile(r"^(offline[-.].*|corners\.txt|corners-result\.json|corners-(prep|deno)\.log)$")


def _project_of(data, tag, given=None):
    if given:
        path = given if os.path.isdir(given) else os.path.join(data, "proj", given)
        if not os.path.isdir(path):
            raise KbpError("data", "找不到工程 %s" % given)
        return os.path.abspath(path)
    track = os.path.join(data, "tracks", "rd-%s.json" % tag)
    if not os.path.isfile(track):
        raise KbpError("data", "找不到轨迹 %s" % track)
    project = None
    with open(track, encoding="utf-8") as f:
        head = f.read(4096)
    m = re.search(r'"project"\s*:\s*"([^"]+)"', head)
    if m:
        project = m.group(1)
    if not project:
        m = re.match(r"^(.*)-fps\d+", tag)
        project = m.group(1) if m else None
    path = os.path.join(data, "proj", project or "")
    if not project or not os.path.isdir(path):
        raise KbpError("data", "标签 %s 推不出工程（轨迹的 project 或「<工程>-fps<N>」），用 --project 给" % tag)
    return os.path.abspath(path)


def _prepare_out(out, overwrite):
    if os.path.isdir(out):
        mine = [n for n in os.listdir(out) if OWN.match(n)]
        others = [n for n in os.listdir(out) if not OWN.match(n)]
        if mine and not overwrite:
            raise KbpError("data", "输出已存在（要覆盖加 --overwrite）：%s" % out)
        for n in mine:  # 只删本工具写的文件
            os.remove(os.path.join(out, n))
        if others:
            pass  # 别的文件不碰
    os.makedirs(out, exist_ok=True)


def offline(args):
    data = common.data_dir(args.data)
    src = replay_host.check_src(args.src)
    if args.project and len(args.tags) != 1:
        raise KbpError("kbp", "--project 只能配一个标签")
    tags = [{"tag": t, "project": _project_of(data, t, args.project)} for t in args.tags]
    out = os.path.abspath(args.out) if args.out else os.path.join(data, "out", "corners", "-".join(args.tags)[:120])
    _prepare_out(out, args.overwrite)
    started = time.time()
    env = {"KBP_TEST": "corners.test.ts", "KBP_SRC": src, "KBP_DATA": data, "KBP_CORNERS_OUT": out,
           "KBP_CORNERS_TAGS": json.dumps(tags, ensure_ascii=False), "KABEGAME_WPE_ROOT": common.wpe_dir()}
    prep = replay_host.run_vitest(env, os.path.join(out, "corners-prep.log"), args.timeout, args.quiet)
    if prep["exit"] != 0 or not os.path.isfile(os.path.join(out, "offline.json")):
        tail = _tail(prep["log"])
        raise KbpError("src", "备料失败（vitest 退出码 %s，日志 %s）：%s" % (prep["exit"], prep["log"], tail))
    options = {"limit": args.limit}
    if args.skip:
        options["skip"] = [s for s in args.skip.split(",") if s]
    if args.expect_hidden:
        options["expectHidden"] = [s for s in args.expect_hidden.split(",") if s]
    deno = shutil.which("deno")
    if not deno:
        raise KbpError("deno", "找不到 deno")
    t0 = time.time()
    log_path = os.path.join(out, "corners-deno.log")
    try:
        proc = subprocess.run([deno, "run", "--unstable-webgpu", "--allow-read", "--allow-write", DENO_SCRIPT, out,
                               json.dumps(options)], cwd=common.REPO_ROOT, capture_output=True, timeout=args.timeout)
    except subprocess.TimeoutExpired:
        raise KbpError("deno", "Deno 超过 %g s 没跑完" % args.timeout)
    with open(log_path, "wb") as f:
        f.write(proc.stdout + proc.stderr)
    result_path = os.path.join(out, "corners-result.json")
    if proc.returncode != 0 or not os.path.isfile(result_path):
        raise KbpError("deno", "Deno 出错（退出码 %d，日志 %s）：%s" % (proc.returncode, log_path, _tail(log_path)))
    result = common.read_json(result_path)
    summary = {"ok": True, "src": src, "out": out, "tags": [t["tag"] for t in tags], "systems": result["systems"],
               "pixel": result["pixel"], "failures": result["failures"], "report": os.path.join(out, "corners.txt"),
               "seconds": {"prep": prep["seconds"], "deno": round(time.time() - t0, 1),
                           "total": round(time.time() - started, 1)}}
    if result.get("uniform"):
        summary["uniform"] = result["uniform"]
    if result["failures"]:
        summary["failed"] = result["failed"][:10]
        if args.strict:
            raise KbpError("data", "不符 %d 处（%s）：%s" % (result["failures"], summary["report"],
                                                       "；".join(result["failed"][:3])))
    return summary


def _tail(path, n=600):
    try:
        with open(path, "rb") as f:
            text = f.read().decode("utf-8", "replace").strip()
    except OSError:
        return ""
    lines = [l for l in text.splitlines() if l.strip()]
    for line in reversed(lines):  # 优先给出错误行
        if "Error" in line or "error" in line or "失败" in line:
            return line.strip()[:n]
    return (lines[-1] if lines else "")[:n]


def cli(args):
    if args.action == "offline":
        return offline(args)
    raise KbpError("kbp", "未知的动作 %s" % args.action)
