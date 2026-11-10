"""kbp-tools 第 1 批的验收自测：重跑 `kbp rdc` 与 `kbp content`，和旧脚本的产物逐项比较。

    python -X utf8 -I .claude/skills/kbp-tools/tests/accept1.py [--out ignore/kbp/accept1] [--only 名字…] [--skip-run]

- 现有真值（ignore/p4/tracks、ignore/p4/step4/out、ignore/p4/b3/out、ignore/p3b/compare）只读；全部输出写 --out。
- track：JSON 解析后逐项比，数值逐位（struct 打包比较，NaN 与 NaN 相等、0.0 与 -0.0 不等）。
- frame：PNG 解码后逐像素比（PIL；不比 PNG 字节）；--present 的浮点后备缓冲是 DDS，逐字节比。
- stats：JSON 逐项比。
- content：projects 与 scan_misc_lib.projects() 同筛选相同；cat 与 pkg_extract.py 逐字节相同；resolve 四种写法与旧 driver.py 相同。
- 全程看着：新出现的 qrenderdoc 进程有没有可见窗口（界面）、跑完是否都退出；已有的 qrenderdoc / wallpaper64 进程前后不变。
--skip-run 只比较 --out 里已有的产物（不重新提取）。结果写 <out>/report.json，每项一行打到 stdout。
"""

import argparse
import ast
import ctypes
import ctypes.wintypes as wt
import importlib.util
import json
import math
import os
import struct
import subprocess
import sys
import threading
import time

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL = os.path.dirname(HERE)
REPO = os.path.normpath(os.path.join(SKILL, "..", "..", ".."))
KBP = os.path.join(SKILL, "kbp.py")
P4 = os.path.join(REPO, "ignore", "p4")

TRACKS = [
    # (标签, 抓帧目录, 工程, 额外参数, 说明)
    ("p4b-fps60", r"A:\p4b\p4b-fps60", None, [], "points"),
    ("p4b-color-fps60", r"A:\p4b\p4b-color-fps60", None, [], "points，颜色按顺序认"),
    ("p4c-cp-fps60", r"A:\p4b\p4c-cp-fps60", None, [], "points，控制点"),
    ("p4c-sprite-fps60", r"A:\p4b\p4c-sprite-fps60", None, [], "points，四角"),
    ("p4c-world-fps60", r"A:\p4b\p4c-world-fps60", None, [], "points，指针"),
    ("p4d-rope-fps60", r"A:\p4b\p4d-rope-fps60", None, ["--draws"], "draws（绳）"),
    ("fps60", r"A:\p4-0\fps60", "p4-0", [], "legacy（p4-0，无 kbp-meta）"),
    ("p4a2", r"A:\p4a\p4a2", "p4a2", [], "legacy（p4a2，无 kbp-meta）"),
]
FRAMES = [
    # (标签, 抓帧目录, 额外参数, 真值目录, 真值文件名 = f(脚本帧))
    ("p4b-color", r"A:\p4b\p4b-color-fps60", [], os.path.join(P4, "step4", "out"), "wpe-p4b-color-f{frame}.png"),
    ("b1-2854083091", r"A:\p4b\2854083091-fps60", [], os.path.join(P4, "step4", "out"), "wpe-b1-2854083091-f{frame}.png"),
    # --event：p4b-color 的最后一次绘制是事件 181，结果应和缺省取法、wpe_rt.py 的真值相同
    ("p4b-color-ev", r"A:\p4b\p4b-color-fps60", ["--event", "181"], os.path.join(P4, "step4", "out"),
     "wpe-p4b-color-f{frame}.png"),
    # present：wpe_export.py 的产物按 RenderDoc 帧号命名（= 脚本帧 − 1）
    ("bb-enabled", r"A:\bedroom\enabled", ["--present"], os.path.join(REPO, "ignore", "p3b", "compare"),
     "wpe-bb-enabled-{rdc}.png"),
    # present 的浮点后备缓冲（R16G16B16A16_FLOAT）存 DDS：逐字节比
    ("bb-highres", r"A:\bedroom\highres", ["--present"], os.path.join(REPO, "ignore", "p3b", "compare"),
     "wpe-bb-highres-{rdc}.dds"),
]
STATS = [
    ("b3-1504316159", r"A:\p4b\1504316159-fps60", os.path.join(P4, "b3", "out", "wpe-b3-1504316159-stats.json")),
    ("b4-3778549173", r"A:\p4b\3778549173-fps60", os.path.join(P4, "b3", "out", "wpe-b4-3778549173-stats.json")),
]


# ==================== 比较 ====================


def same_number(a, b):
    return struct.pack("<d", float(a)) == struct.pack("<d", float(b)) or (math.isnan(a) and math.isnan(b))


def deep_diff(a, b, path="$", out=None, limit=20):
    """逐项比较两份解析后的 JSON；返回 [(路径, 新, 旧)]（最多 limit 条）与差异总数。"""
    if out is None:
        out = {"items": [], "count": 0}

    def add(p, x, y):
        out["count"] += 1
        if len(out["items"]) < limit:
            out["items"].append((p, _short(x), _short(y)))

    if isinstance(a, bool) or isinstance(b, bool):
        if type(a) is not type(b) or a != b:
            add(path, a, b)
    elif isinstance(a, (int, float)) and isinstance(b, (int, float)):
        if type(a) is not type(b) or not same_number(a, b):
            add(path, a, b)
    elif isinstance(a, dict) and isinstance(b, dict):
        for k in a.keys() | b.keys():
            if k not in a or k not in b:
                add("%s.%s" % (path, k), a.get(k, "<缺>"), b.get(k, "<缺>"))
            else:
                deep_diff(a[k], b[k], "%s.%s" % (path, k), out, limit)
    elif isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            add(path + ".length", len(a), len(b))
        for i, (x, y) in enumerate(zip(a, b)):
            deep_diff(x, y, "%s[%d]" % (path, i), out, limit)
    elif a != b or type(a) is not type(b):
        add(path, a, b)
    return out


def _short(value):
    text = json.dumps(value, ensure_ascii=False) if not isinstance(value, str) else value
    return text if len(text) <= 160 else text[:160] + "…"


def load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def compare_png(new, old):
    from PIL import Image

    a, b = Image.open(new), Image.open(old)
    a.load()
    b.load()
    info = {"size": [a.size, b.size], "mode": [a.mode, b.mode]}
    if a.size != b.size or a.mode != b.mode:
        return False, info
    ra, rb = a.tobytes(), b.tobytes()
    if ra == rb:
        return True, info
    import numpy as np

    x = np.frombuffer(ra, dtype=np.uint8).astype(np.int16)
    y = np.frombuffer(rb, dtype=np.uint8).astype(np.int16)
    d = np.abs(x - y)
    info.update({"differing_bytes": int((d > 0).sum()), "max_abs": int(d.max())})
    return False, info


# ==================== 运行 kbp ====================


def kbp(args, capture_stderr=True):
    start = time.time()
    proc = subprocess.run([sys.executable, "-X", "utf8", "-I", KBP] + args, cwd=REPO, capture_output=True)
    seconds = round(time.time() - start, 3)
    lines = proc.stdout.decode("utf-8", "replace").strip().splitlines()
    try:
        summary = json.loads(lines[-1]) if lines else None
    except ValueError:
        summary = None
    return proc.returncode, summary, proc.stderr.decode("utf-8", "replace"), seconds


# ==================== 界面与进程的看守 ====================

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
EnumProc = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
user32.EnumWindows.argtypes = [EnumProc, wt.LPARAM]
user32.GetWindowThreadProcessId.argtypes = [wt.HWND, ctypes.POINTER(wt.DWORD)]
user32.IsWindowVisible.argtypes = [wt.HWND]
user32.GetWindowTextW.argtypes = [wt.HWND, wt.LPWSTR, ctypes.c_int]
kernel32.OpenProcess.restype = wt.HANDLE
kernel32.QueryFullProcessImageNameW.argtypes = [wt.HANDLE, wt.DWORD, wt.LPWSTR, ctypes.POINTER(wt.DWORD)]
kernel32.CloseHandle.argtypes = [wt.HANDLE]


def image_of(pid):
    handle = kernel32.OpenProcess(0x1000, False, pid)
    if not handle:
        return None
    try:
        buf = ctypes.create_unicode_buffer(1024)
        size = wt.DWORD(1024)
        if kernel32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
            return os.path.basename(buf.value).lower()
    finally:
        kernel32.CloseHandle(handle)
    return None


def processes():
    """[{pid, name, cmd}]：qrenderdoc 与 wallpaper64（经 PowerShell 读命令行，只读）。"""
    script = ("Get-CimInstance Win32_Process -Filter \"Name='qrenderdoc.exe' or Name='wallpaper64.exe'\" | "
              "Select-Object ProcessId, Name, CommandLine | ConvertTo-Json -Compress")
    out = subprocess.run(["powershell", "-NoProfile", "-Command", script], capture_output=True).stdout
    text = out.decode("utf-8", "replace").strip()
    if not text:
        return []
    rows = json.loads(text)
    if isinstance(rows, dict):
        rows = [rows]
    return sorted(({"pid": r["ProcessId"], "name": r["Name"], "cmd": r.get("CommandLine")} for r in rows),
                  key=lambda r: r["pid"])


class WindowWatch(threading.Thread):
    """每 100 ms 枚举可见顶层窗口：属于不在 baseline 里的 qrenderdoc 进程的，记下来（= 弹出了界面）。"""

    def __init__(self, baseline):
        threading.Thread.__init__(self, daemon=True)
        self.baseline = set(baseline)
        self.hits = []
        self.seen_pids = set()
        self.stop = False

    def run(self):
        while not self.stop:
            def callback(hwnd, _):
                pid = wt.DWORD()
                user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
                p = pid.value
                if p in self.baseline:
                    return True
                if image_of(p) == "qrenderdoc.exe":
                    self.seen_pids.add(p)
                    if user32.IsWindowVisible(hwnd):
                        title = ctypes.create_unicode_buffer(256)
                        user32.GetWindowTextW(hwnd, title, 256)
                        self.hits.append({"pid": p, "title": title.value, "t": time.time()})
                return True
            user32.EnumWindows(EnumProc(callback), 0)
            time.sleep(0.1)


def mcp_logs():
    root = os.path.join(REPO, ".kabegame", "debug", "wpe-renderdoc-mcp", "ipc")
    out = {}
    if os.path.isdir(root):
        for d in os.listdir(root):
            p = os.path.join(root, d, "worker.log")
            if os.path.isfile(p):
                out[d] = os.path.getsize(p)
    return out


# ==================== 各项 ====================


def check_tracks(out_dir, only, skip_run, report):
    for tag, folder, project, extra, note in TRACKS:
        if only and tag not in only:
            continue
        new = os.path.join(out_dir, "tracks", "rd-%s.json" % tag)
        old = os.path.join(P4, "tracks", "rd-%s.json" % tag)
        row = {"kind": "track", "tag": tag, "note": note, "folder": folder}
        if not skip_run:
            args = ["rdc", "track", folder, tag] + ([project] if project else []) + extra + [
                "--data", P4, "--out", new, "--overwrite", "--quiet"]
            code, summary, err, seconds = kbp(args)
            row.update({"exit": code, "summary": summary, "wall": seconds})
            if code != 0:
                row.update({"ok": False, "stderr": err[-2000:]})
                report.append(row)
                print(json.dumps(row, ensure_ascii=False), flush=True)
                continue
        d = deep_diff(load_json(new), load_json(old))
        row.update({"ok": d["count"] == 0, "diff_count": d["count"], "diffs": d["items"]})
        report.append(row)
        print(json.dumps({k: v for k, v in row.items() if k != "summary"} | {
            "seconds": (row.get("summary") or {}).get("seconds")}, ensure_ascii=False), flush=True)


def check_frames(out_dir, only, skip_run, report):
    for tag, folder, extra, truth_dir, pattern in FRAMES:
        if only and tag not in only:
            continue
        target = os.path.join(out_dir, "frames")
        mode = "present" if "--present" in extra else ("event" if "--event" in extra else "last")
        row = {"kind": "frame", "tag": tag, "folder": folder, "mode": mode}
        if not skip_run:
            code, summary, err, seconds = kbp(["rdc", "frame", folder, tag] + extra + [
                "--data", P4, "--out", target, "--overwrite", "--quiet"])
            row.update({"exit": code, "summary": summary, "wall": seconds})
            if code != 0:
                row.update({"ok": False, "stderr": err[-2000:]})
                report.append(row)
                print(json.dumps(row, ensure_ascii=False), flush=True)
                continue
        index = load_json(os.path.join(target, "wpe-%s.json" % tag))
        results = []
        for item in index:
            frame = item["frame"]
            new = item.get("png") or item.get("file")
            old = os.path.join(truth_dir, pattern.format(frame=frame, rdc=frame - 1))
            if not os.path.isfile(old):
                results.append({"frame": frame, "ok": False, "error": "没有真值 %s" % old})
                continue
            if new.lower().endswith(".dds") or old.lower().endswith(".dds"):
                with open(new, "rb") as f:
                    a = f.read()
                with open(old, "rb") as f:
                    b = f.read()
                ok, info = a == b, {"bytes": [len(a), len(b)]}
            else:
                ok, info = compare_png(new, old)
            results.append({"frame": frame, "ok": ok, "new": os.path.basename(new), "old": os.path.basename(old),
                            "event": item["event"], **info})
        row.update({"ok": all(r["ok"] for r in results), "frames": results})
        report.append(row)
        print(json.dumps({k: v for k, v in row.items() if k != "summary"} | {
            "seconds": (row.get("summary") or {}).get("seconds")}, ensure_ascii=False, default=str), flush=True)


def check_stats(out_dir, only, skip_run, report):
    for tag, folder, truth in STATS:
        if only and tag not in only:
            continue
        new = os.path.join(out_dir, "stats", "wpe-%s-stats.json" % tag)
        row = {"kind": "stats", "tag": tag, "folder": folder}
        if not skip_run:
            code, summary, err, seconds = kbp(["rdc", "stats", folder, tag, "--data", P4, "--out", new,
                                               "--overwrite", "--quiet"])
            row.update({"exit": code, "summary": summary, "wall": seconds})
            if code != 0:
                row.update({"ok": False, "stderr": err[-2000:]})
                report.append(row)
                print(json.dumps(row, ensure_ascii=False), flush=True)
                continue
        d = deep_diff(load_json(new), load_json(truth))
        row.update({"ok": d["count"] == 0, "diff_count": d["count"], "diffs": d["items"]})
        report.append(row)
        print(json.dumps({k: v for k, v in row.items() if k != "summary"} | {
            "seconds": (row.get("summary") or {}).get("seconds")}, ensure_ascii=False), flush=True)


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def old_resolve():
    """旧 driver.py 的 resolve_project（driver.py 导入即运行 main，所以只取这个函数的源码来执行）。"""
    path = os.path.join(REPO, ".claude", "skills", "wpe-renderdoc", "driver.py")
    with open(path, encoding="utf-8") as f:
        tree = ast.parse(f.read())
    node = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "resolve_project")

    def die(message):
        raise LookupError(message)

    scope = {"os": os, "die": die,
             "WPE_DIR": os.environ.get("KABEGAME_WPE_ROOT", r"D:\Applications\Steam\steamapps\common\wallpaper_engine")}
    exec(compile(ast.Module(body=[node], type_ignores=[]), path, "exec"), scope)
    return scope["resolve_project"]


def check_content(out_dir, report):
    sys.path.insert(0, SKILL)
    import kbp as kbp_module  # noqa: F401 —— 让 kbp 成为包
    from kbp import content

    # projects：scan_misc_lib.projects() = 默认工程（不筛）+ 创意工坊里有 scene.pkg 的
    lib = load_module("scan_misc_lib", os.path.join(REPO, "ignore", "hdr-macro", "scan_misc_lib.py"))
    old = lib.projects()
    code1, s1, _, _ = kbp(["content", "projects", "--source", "default"])
    code2, s2, _, _ = kbp(["content", "projects", "--source", "workshop", "--pkg"])
    cli = (s1 or {}).get("projects", []) + (s2 or {}).get("projects", [])
    library = content.projects("default") + content.projects("workshop", pkg=True)
    row = {"kind": "content", "check": "projects", "ok": code1 == 0 and code2 == 0 and cli == old and library == old,
           "count": len(old), "cli": len(cli), "library": len(library),
           "only_old": [p for p in old if p not in cli][:5], "only_new": [p for p in cli if p not in old][:5]}
    report.append(row)
    print(json.dumps(row, ensure_ascii=False), flush=True)

    # cat：和 pkg_extract.py 逐字节相同（3 个条目，含二进制的 .tex）
    project = "3832772446"
    pkg_path = os.path.join(content.workshop_dir(), project, "scene.pkg")
    pkg = content.read_pkg(pkg_path)
    names = [n for n, _, _ in pkg.entries]
    picks = ["scene.json"]
    picks.append(next(n for n in names if n.endswith(".tex")))
    picks.append(next(n for n in names if n.startswith("materials/") and n.endswith(".json")))
    extract_dir = os.path.join(out_dir, "content", "pkg_extract")
    os.makedirs(extract_dir, exist_ok=True)
    for entry in picks:
        target = os.path.join(extract_dir, entry.replace("/", "__"))
        if os.path.exists(target):
            os.remove(target)
        subprocess.run([sys.executable, "-X", "utf8", "-I", os.path.join(P4, "c2", "pkg_extract.py"), pkg_path, entry,
                        extract_dir], capture_output=True, check=True)
        mine = os.path.join(out_dir, "content", "kbp_cat", entry.replace("/", "__"))
        code, summary, err, _ = kbp(["content", "cat", project, entry, "--from", "pkg", "--out", mine, "--overwrite"])
        with open(target, "rb") as f:
            a = f.read()
        b = open(mine, "rb").read() if code == 0 else None
        # 不给 --out 时写 stdout 的原始字节也要相同
        raw = subprocess.run([sys.executable, "-X", "utf8", "-I", KBP, "content", "cat", project, entry, "--from", "pkg"],
                             cwd=REPO, capture_output=True).stdout
        row = {"kind": "content", "check": "cat", "entry": entry, "ok": code == 0 and a == b and raw == a,
               "size": len(a), "stdout_same": raw == a, "summary": summary}
        report.append(row)
        print(json.dumps(row, ensure_ascii=False), flush=True)

    # resolve：目录、project.json、工坊 ID、默认工程名，与旧 driver.py 相同
    resolve_old = old_resolve()
    wdir = os.path.join(content.workshop_dir(), project)
    forms = [("目录", wdir), ("project.json", os.path.join(wdir, "project.json")), ("工坊 ID", project),
             ("默认工程名", "shimmering_particles"), ("myprojects 名", "kabegame-sample")]
    for label, name in forms:
        expected = resolve_old(name)
        code, summary, err, _ = kbp(["content", "resolve", name])
        got = (summary or {}).get("project_json")
        library = content.resolve(name)
        row = {"kind": "content", "check": "resolve", "form": label, "name": name,
               "ok": code == 0 and got == expected and library == expected, "got": got, "expected": expected}
        report.append(row)
        print(json.dumps(row, ensure_ascii=False), flush=True)
    code, summary, err, _ = kbp(["content", "resolve", "no-such-project-kbp"])
    row = {"kind": "content", "check": "resolve-missing", "ok": code != 0 and err.startswith("[data]"),
           "stderr": err.strip()}
    report.append(row)
    print(json.dumps(row, ensure_ascii=False), flush=True)


def check_guard(report):
    """不给 --out 时缺省写 <data>/tracks/rd-<标签>.json，那里是现有真值：必须拒绝、文件不变、不拉起 qrenderdoc。"""
    import hashlib

    truth = os.path.join(P4, "tracks", "rd-p4c-cp-fps60.json")
    with open(truth, "rb") as f:
        before = hashlib.sha256(f.read()).hexdigest()
    code, summary, err, seconds = kbp(["rdc", "track", r"A:\p4b\p4c-cp-fps60", "p4c-cp-fps60", "--data", P4])
    with open(truth, "rb") as f:
        after = hashlib.sha256(f.read()).hexdigest()
    row = {"kind": "guard", "check": "overwrite", "ok": code != 0 and err.startswith("[data]") and before == after
           and seconds < 5, "stderr": err.strip(), "wall": seconds}
    report.append(row)
    print(json.dumps(row, ensure_ascii=False), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=os.path.join(REPO, "ignore", "kbp", "accept1"))
    parser.add_argument("--only", nargs="*", help="只跑这些标签（track / frame / stats 的标签，或 content、guard）")
    parser.add_argument("--skip-run", action="store_true", help="不重新提取，只比较 --out 里已有的产物")
    args = parser.parse_args()
    out_dir = os.path.abspath(args.out)
    os.makedirs(out_dir, exist_ok=True)
    only = set(args.only or [])

    before = processes()
    logs_before = mcp_logs()
    watch = WindowWatch([p["pid"] for p in before])
    watch.start()
    report = []
    start = time.time()
    check_tracks(out_dir, only, args.skip_run, report)
    check_frames(out_dir, only, args.skip_run, report)
    check_stats(out_dir, only, args.skip_run, report)
    if not only or "content" in only:
        check_content(out_dir, report)
    if not only or "guard" in only:
        check_guard(report)
    watch.stop = True
    watch.join(1)
    after = processes()
    leftover = [p for p in after if p["pid"] not in {q["pid"] for q in before}]
    env = {"kind": "env", "ok": not watch.hits and not leftover and before == after,
           "ui_windows": watch.hits, "new_qrenderdoc_seen": sorted(watch.seen_pids), "leftover_processes": leftover,
           "processes_before": before, "processes_after": after,
           "mcp_worker_logs_before": logs_before, "mcp_worker_logs_after": mcp_logs(),
           "seconds": round(time.time() - start, 1)}
    report.append(env)
    print(json.dumps({k: env[k] for k in ("kind", "ok", "ui_windows", "new_qrenderdoc_seen", "leftover_processes",
                                          "seconds")}, ensure_ascii=False), flush=True)
    with open(os.path.join(out_dir, "report.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(report, f, ensure_ascii=False, indent=1, default=str)
    failed = [r for r in report if not r.get("ok")]
    print(json.dumps({"ok": not failed, "checks": len(report), "failed": [(r["kind"], r.get("tag") or r.get("check"))
                                                                        for r in failed]}, ensure_ascii=False))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
