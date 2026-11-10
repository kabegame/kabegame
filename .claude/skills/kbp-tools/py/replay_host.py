"""`kbp replay`、`kbp regress` 的本机一侧：算参数、拉起 `node … vitest`（ts/replay.test.ts）、读结果、比较。

- replay：案例是 `<data>/cases/<名字>.json`（钩子 `<名字>.hook.ts`）；报告写 `<out>/<名字>.txt`、`.json`（不含路径与耗时，两份源码上的
  结果可以逐字节比较）与 `<名字>.meta.json`（源码、耗时、错误）。vitest 的输出写 `<out>/replay-vitest.log`。
- regress：全部案例（或 --cases）在两份源码上各跑一遍（缺省两个 node 并行），`<out>/a/`、`<out>/b/` 逐字节比较 `.txt` 与 `.json`，
  报出不同的文件和第一处不同；同时核对两边各自是否全部通过。`--corpus` 另在两边各跑一遍语料扫描（py/corpus.py），逐场景比
  unsupported 与附加字段，报出受影响的场景（第 3 批）；`--no-cases` 只比语料。
- 案例「有失败」是结果，不算工具出错（退出码 0，摘要里 all_passed 为 false）；案例跑不下去（钩子或产品接口出错）才报 [src]。
- 超时只结束本次拉起的 node 进程树（taskkill /T 按自己的进程号），别的进程一律不碰。
"""

import json
import os
import shutil
import subprocess
import sys
import threading
import time

from . import common
from .common import KbpError

VITEST = os.path.join(common.REPO_ROOT, "node_modules", "vitest", "vitest.mjs")
CONFIG = os.path.join(common.SKILL_DIR, "ts", "vitest.config.ts")
DEFAULT_SRC = os.path.join(common.REPO_ROOT, "apps", "wpe-scene", "src")
REPORT_EXTS = (".txt", ".json")


def case_names(data, wanted=None, all_cases=False):
    folder = os.path.join(data, "cases")
    if not os.path.isdir(folder):
        raise KbpError("data", "找不到案例目录 %s" % folder)
    available = sorted(n[:-5] for n in os.listdir(folder) if n.endswith(".json"))
    if all_cases:
        names = available
    elif not wanted:
        raise KbpError("kbp", "给案例名，或 --all（有 %s）" % "、".join(available))
    else:
        names = list(wanted)
        missing = [n for n in names if n not in available]
        if missing:
            raise KbpError("data", "没有案例 %s（有 %s）" % ("、".join(missing), "、".join(available)))
    for name in names:
        spec = common.read_json(os.path.join(folder, name + ".json"))
        if spec.get("name") != name:
            raise KbpError("data", "案例 %s.json 的 name 是 %r" % (name, spec.get("name")))
    return names


def _src(path):
    src = os.path.abspath(path or DEFAULT_SRC)
    if not os.path.isfile(os.path.join(src, "particles", "system.ts")):
        raise KbpError("src", "不像产品源码目录（没有 particles/system.ts）：%s" % src)
    return src


def _outputs(out, names):
    return [os.path.join(out, n + ext) for n in names for ext in REPORT_EXTS + (".meta.json",)]


def _kill_tree(proc):
    """只结束本次拉起的进程树（vitest 的 fork 子进程也是它拉起的）。"""
    subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True)
    try:
        proc.wait(10)
    except subprocess.TimeoutExpired:
        pass


def check_src(path):
    return _src(path)


def run_vitest(extra_env, log_path, timeout, quiet, label=""):
    """拉起一次 `node … vitest run --config ts/vitest.config.ts`（测试文件由 KBP_TEST 选，缺省 replay.test.ts）；
    输出写 log_path，超时只结束本次拉起的进程树。返回 {exit, seconds, log}。"""
    os.makedirs(os.path.dirname(log_path) or ".", exist_ok=True)
    env = dict(os.environ)
    env.update(extra_env)
    started = time.time()
    with open(log_path, "wb") as log:
        proc = subprocess.Popen(["node", VITEST, "run", "--config", CONFIG], cwd=common.REPO_ROOT, env=env,
                                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)

        def pump():
            for chunk in iter(lambda: proc.stdout.readline(), b""):
                log.write(chunk)
                if not quiet:
                    text = chunk.decode("utf-8", "replace")
                    sys.stderr.write(label + text if label else text)
                    sys.stderr.flush()

        reader = threading.Thread(target=pump, daemon=True)
        reader.start()
        try:
            proc.wait(timeout)
        except subprocess.TimeoutExpired:
            _kill_tree(proc)
            reader.join(5)
            raise KbpError("node", "vitest 超过 %g s 没跑完，已结束本次拉起的进程树 %d（日志 %s）" % (timeout, proc.pid, log_path))
        reader.join(10)
    return {"exit": proc.returncode, "seconds": round(time.time() - started, 1), "log": log_path}


def run_cases(src, data, out, names, timeout, quiet, label=""):
    """拉起一次 vitest 跑这些案例；返回 {名字: meta}。"""
    os.makedirs(out, exist_ok=True)
    log_path = os.path.join(out, "replay-vitest.log")
    env = dict(os.environ)
    env.update(KBP_SRC=src, KBP_DATA=data, KBP_OUT=out, KBP_CASES=",".join(names))
    env.pop("KBP_TEST", None)
    started = time.time()
    with open(log_path, "wb") as log:
        proc = subprocess.Popen(["node", VITEST, "run", "--config", CONFIG], cwd=common.REPO_ROOT, env=env,
                                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)

        def pump():
            for chunk in iter(lambda: proc.stdout.readline(), b""):
                log.write(chunk)
                if not quiet:
                    sys.stderr.write((label + chunk.decode("utf-8", "replace")) if label else chunk.decode("utf-8", "replace"))
                    sys.stderr.flush()

        reader = threading.Thread(target=pump, daemon=True)
        reader.start()
        try:
            proc.wait(timeout)
        except subprocess.TimeoutExpired:
            _kill_tree(proc)
            reader.join(5)
            raise KbpError("node", "vitest 超过 %g s 没跑完，已结束本次拉起的进程树 %d（日志 %s）" % (timeout, proc.pid, log_path))
        reader.join(10)
    metas = {}
    for name in names:
        path = os.path.join(out, name + ".meta.json")
        metas[name] = common.read_json(path) if os.path.isfile(path) else {"case": name, "error": "没有 meta（vitest 没跑到它）"}
    return {"exit": proc.returncode, "seconds": round(time.time() - started, 1), "log": log_path, "metas": metas}


def _case_summary(metas):
    cases = {}
    for name, meta in metas.items():
        row = {"ok": meta.get("ok"), "seconds": meta.get("seconds")}
        if meta.get("error"):
            row["error"] = meta["error"].splitlines()[0][:300]
        cases[name] = row
    crashed = [n for n, r in cases.items() if r.get("error")]
    return cases, crashed


def replay(args):
    data = common.data_dir(args.data)
    src = _src(args.src)
    names = case_names(data, args.cases, args.all)
    out = os.path.abspath(args.out) if args.out else os.path.join(data, "out", "replay")
    existing = [p for p in _outputs(out, names) if os.path.exists(p)]
    if existing:
        if not args.overwrite:
            raise KbpError("data", "报告已存在（要覆盖加 --overwrite）：%s" % "、".join(existing[:5]))
        for p in existing:
            os.remove(p)
    result = run_cases(src, data, out, names, args.timeout, args.quiet)
    cases, crashed = _case_summary(result["metas"])
    if crashed:
        raise KbpError("src", "案例跑不下去：%s（详情见 %s 与各 .meta.json）" % (
            "；".join("%s：%s" % (n, cases[n]["error"]) for n in crashed), result["log"]))
    return {"ok": True, "src": src, "data": data, "out": out, "cases": cases,
            "all_passed": all(r["ok"] for r in cases.values()), "seconds": result["seconds"], "log": result["log"]}


def _first_difference(a, b):
    """两段字节的第一处不同：行号、列号与两边的那一行（截到 300 字）。"""
    ta, tb = a.decode("utf-8", "replace").split("\n"), b.decode("utf-8", "replace").split("\n")
    for i in range(max(len(ta), len(tb))):
        la = ta[i] if i < len(ta) else None
        lb = tb[i] if i < len(tb) else None
        if la != lb:
            col = 0
            if la is not None and lb is not None:
                while col < min(len(la), len(lb)) and la[col] == lb[col]:
                    col += 1
            cut = lambda s: None if s is None else (s if len(s) <= 300 else s[:300] + "…")  # noqa: E731
            return {"line": i + 1, "column": col + 1, "a": cut(la), "b": cut(lb)}
    return None


def regress(args):
    if len(args.src) != 2:
        raise KbpError("kbp", "--src 要给两次：--src A --src B")
    if getattr(args, "no_cases", False) and not args.corpus:
        raise KbpError("kbp", "--no-cases 要和 --corpus 一起用（否则什么都不比）")
    data = common.data_dir(args.data)
    srcs = [_src(s) for s in args.src]
    if getattr(args, "no_cases", False):
        names = []
    else:
        wanted = args.cases.split(",") if args.cases else None
        names = case_names(data, wanted, all_cases=not wanted)
    extras = []
    if args.corpus:
        from . import corpus

        extras = corpus.parse_extras(getattr(args, "extra", None) or [])
    out = os.path.abspath(args.out) if args.out else os.path.join(data, "out", "regress")
    sides = {"a": os.path.join(out, "a"), "b": os.path.join(out, "b")}
    own = [os.path.join(out, n) for n in ("regress.json", "regress.txt")] + list(sides.values())
    if any(os.path.exists(p) for p in own):
        if not args.overwrite:
            raise KbpError("data", "输出已存在（要覆盖加 --overwrite）：%s" % out)
        for p in own:
            if os.path.isdir(p):
                shutil.rmtree(p)
            elif os.path.exists(p):
                os.remove(p)
    started = time.time()
    results = {}
    scans = {}
    errors = {}

    def go(key, src):
        try:
            if names:
                results[key] = run_cases(src, data, sides[key], names, args.timeout, args.quiet, label="[%s] " % key)
            else:
                results[key] = {"metas": {}, "seconds": 0.0}
            if args.corpus:
                from . import corpus

                scans[key] = corpus.run_scan(src, os.path.join(sides[key], "corpus.json"), extras,
                                             timeout=args.timeout, quiet=args.quiet, label="[%s corpus] " % key)
        except KbpError as e:
            errors[key] = e

    if args.serial:
        go("a", srcs[0])
        go("b", srcs[1])
    else:
        threads = [threading.Thread(target=go, args=(k, s)) for k, s in zip("ab", srcs)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
    if errors:
        raise KbpError("node", "；".join("%s：%s" % (k, e.message) for k, e in errors.items()))

    rows = []
    differ = []
    for name in names:
        row = {"case": name, "files": {}}
        for side in "ab":
            cases, crashed = _case_summary({name: results[side]["metas"][name]})
            row[side] = cases[name]
        for ext in REPORT_EXTS:
            pa, pb = os.path.join(sides["a"], name + ext), os.path.join(sides["b"], name + ext)
            if not (os.path.isfile(pa) and os.path.isfile(pb)):
                row["files"][ext] = {"same": False, "missing": [p for p in (pa, pb) if not os.path.isfile(p)]}
                continue
            with open(pa, "rb") as f1, open(pb, "rb") as f2:
                da, db = f1.read(), f2.read()
            row["files"][ext] = {"same": da == db, "bytes": [len(da), len(db)]}
            if da != db:
                row["files"][ext]["first"] = _first_difference(da, db)
        row["same"] = all(f["same"] for f in row["files"].values())
        if not row["same"]:
            differ.append(name)
        rows.append(row)
    passed = {side: all(results[side]["metas"][n].get("ok") is True for n in names) for side in "ab"}
    crashed = {side: [n for n in names if results[side]["metas"][n].get("error")] for side in "ab"}
    corpus_report = None
    if args.corpus:
        from . import corpus

        corpus_same, corpus_report = corpus.regress_rows(scans["a"]["rows"], scans["b"]["rows"])
        corpus_report.update(same=corpus_same, extra=[e["name"] for e in extras],
                             seconds={s: scans[s]["seconds"] for s in "ab"})
        if not corpus_same:
            differ.append("corpus")
    report = {"src": {"a": srcs[0], "b": srcs[1]}, "cases": rows, "same": not differ, "differ": differ,
              "all_passed": passed, "crashed": crashed, "corpus": corpus_report,
              "seconds": {"a": results["a"]["seconds"], "b": results["b"]["seconds"],
                          "total": round(time.time() - started, 1)}}
    common.write_json(os.path.join(out, "regress.json"), report, indent=1)
    lines = ["a：%s" % srcs[0], "b：%s" % srcs[1], ""]
    for row in rows:
        mark = "逐字节相同" if row["same"] else "不同！"
        verdict = "a %s / b %s" % tuple(
            "跑不下去" if row[s].get("error") else ("全部通过" if row[s]["ok"] else "有失败") for s in "ab")
        lines.append("%-10s %s（%s）" % (row["case"], mark, verdict))
        for ext, f in row["files"].items():
            if not f["same"]:
                first = f.get("first")
                lines.append("  %s%s：%s" % (row["case"], ext, "缺文件 %s" % f["missing"] if "missing" in f else
                                            "第 %d 行第 %d 列起不同" % (first["line"], first["column"])))
                if first:
                    lines.append("    a: %s" % first["a"])
                    lines.append("    b: %s" % first["b"])
    lines.append("")
    case_differ = [d for d in differ if d != "corpus"]
    lines.append("案例全部逐字节相同" if not case_differ else "不同的案例：%s" % "、".join(case_differ))
    if names:
        lines.append("两边各自：a %s，b %s" % tuple("全部通过" if passed[s] else "有失败" for s in "ab"))
    if corpus_report is None:
        lines.append("语料扫描：未比（加 --corpus）")
    else:
        c = corpus_report
        lines.append("语料扫描（%d / %d 个场景，附加字段 %s）：%s" % (
            c["samples"][0], c["samples"][1], ",".join(c["extra"]) or "无",
            "逐场景相同" if c["same"] else "%d 个场景不同" % len(c["affected"])))
        lines.append("  干净 a %d / b %d，出错 a %d / b %d" % (c["clean"][0], c["clean"][1], c["errors"][0], c["errors"][1]))
        for key, samples in c["removed"].items():
            lines.append("  b 去掉 %s：%d 张 %s" % (key, len(samples), " ".join(samples)))
        for key, samples in c["added"].items():
            lines.append("  b 新增 %s：%d 张 %s" % (key, len(samples), " ".join(samples)))
        for item in c["affected"][:40]:
            lines.append("  %s：%s" % (item["sample"], json.dumps({k: v for k, v in item.items() if k != "sample"},
                                                                ensure_ascii=False)[:300]))
    with open(os.path.join(out, "regress.txt"), "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines) + "\n")
    summary = {"ok": True, "out": out, "same": not differ, "differ": differ, "all_passed": passed, "crashed": crashed,
               "report": os.path.join(out, "regress.txt"), "seconds": report["seconds"]}
    if corpus_report is not None:
        summary["corpus"] = {"same": corpus_report["same"], "affected": [i["sample"] for i in corpus_report["affected"]],
                             "removed": {k: len(v) for k, v in corpus_report["removed"].items()},
                             "added": {k: len(v) for k, v in corpus_report["added"].items()}}
    return summary


def cli(args):
    if args.category == "replay":
        return replay(args)
    return regress(args)
