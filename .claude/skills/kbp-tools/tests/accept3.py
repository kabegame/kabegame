"""kbp-tools 第 3 批的验收自测：corpus、mutate、cmp、corners、bbox、sample。

    python -X utf8 -I .claude/skills/kbp-tools/tests/accept3.py [--out ignore/kbp/accept3] [--only 段,…] [--window kb-…]

只读：ignore/p4（各步骤目录、proj、tracks、out）、apps/。**全部输出、快照、旧脚本拷贝都写在 --out 下**（缺省 ignore/kbp/accept3）：
- snap：`kbp snapshot export` 三份冻结快照：HEAD（语料、回归）、a0a84322（P4c 步骤 5，配当时的翻译器 wasm `c5/head/src/…`）、
  b721f636（P4d 步骤 1）。产品源码只在快照上用，从不改 apps/。
- corpus：旧 `c5/corpus.test.ts`（controlpoints）、`b3`、`b4`（modules）、`b2`（帧表）拷到 <out>/old/、只改输出路径，和新的
  `kbp corpus scan`（四个插件一次挂上）在同一份 HEAD 快照上跑，逐场景比 unsupported 集合、出错与附加字段。
- cdiff：`c5/out` 的 corpus-head / corpus-ws 上，新 `kbp corpus diff` 对 `c5/corpus_diff.py`、`b5/diff_corpus.py` 的通用部分；
  `--without` 对 `b6/corpus_colorn.py`；`--explain` 挂一个示例解释脚本。
- cregress：`regress --corpus --no-cases`：同一份快照两次（语料相同）；快照副本的能力表里把 `camerafade` 从中性表删掉（报出受影响的
  场景，和 scene.json 里写了 general.camerafade 的场景比）。
- mutate：`c5/mutate.py` 的变异清单（AST 取出常量与 MUTATIONS，不运行它）转成新跑器的 JSON spec（单测 + `kbp corners offline` 当
  四角命令），在 a0a84322 快照的副本上：快照模式跑全部、工作区模式（反向替换）跑一部分；逐处和 `c5/out/mutate.txt` 比检出结论、
  检出方、单测摘要与四角不符处数；另演练一次「检出期间文件被并行会话改了」的反向替换。
- cmp：`dev4/cmp-wpe.ts`（p4c-cp）、`c5/cmp_scene.py`（3832772446 的三帧，含热图逐像素）、`b3/cmp_stats.py`（两个场景）各拷一份
  只改输出路径，和新命令在同样输入上比。
- bbox：生成库带 / 不带 bbox 各生成一个小工程（只有 kbp-meta.json 的 bbox 不同）；合成两张图，`cmp frame --meta` 按对象归类。
  「不传时工程字节不变」由重跑 accept2 的 gen 核对。
- corners：新 `kbp corners offline` 在 a0a84322 / b721f636 快照上，和 `c5/out/corners.txt`、`d1/out/corners.txt` 逐行比。
- sample：要 `--window <标题>`（wpe-renderdoc MCP 的 open_wallpaper 开的测试窗口，本脚本不开关窗口）：grab、series 5 s（整帧与网格）、
  read（含 FR 帧号）。不给就跳过。
结果写 <out>/report.json（--only 时 report-<段>.json），每项一行打到 stdout。
"""

import argparse
import ast
import collections
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL = os.path.dirname(HERE)
REPO = os.path.normpath(os.path.join(SKILL, "..", "..", ".."))
KBP = os.path.join(SKILL, "kbp.py")
P4 = os.path.join(REPO, "ignore", "p4")
NODE_VITEST = os.path.join(REPO, "node_modules", "vitest", "vitest.mjs")
C5_WASM = os.path.join(P4, "c5", "head", "src", "wpesl2wgsl", "wpesl2wgsl.wasm")

sys.path.insert(0, SKILL)
import kbp as _kbp  # noqa: E402  （充当包 kbp）

_kbp._register()
from kbp import content as libcontent  # noqa: E402


# ==================== 公共 ====================


def kbp(args, timeout=None):
    """跑一次 kbp.py，返回 (退出码, 摘要 JSON, stderr)。"""
    proc = subprocess.run([sys.executable, "-X", "utf8", "-I", KBP] + args, cwd=REPO, capture_output=True,
                          timeout=timeout)
    lines = [l for l in proc.stdout.decode("utf-8", "replace").splitlines() if l.strip()]
    try:
        summary = json.loads(lines[-1]) if lines else None
    except ValueError:
        summary = {"raw": lines[-1]}
    return proc.returncode, summary or {}, proc.stderr.decode("utf-8", "replace")


def rel(path):
    return os.path.relpath(path, REPO).replace("\\", "/")


def rmtree_own(path, out_dir):
    """只删 --out 下本自测建的目录。"""
    full = os.path.abspath(path)
    if not full.startswith(os.path.abspath(out_dir) + os.sep):
        raise RuntimeError("拒绝删除 --out 之外的目录：%s" % full)
    if os.path.isdir(full):
        shutil.rmtree(full)


def write_text(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def read_text(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.loads(re.sub(r"(?<=[\[,:\s])-?(?:NaN|Infinity)(?=\s*[,\]}])", "null", f.read()))


def copy_edit(source, target, edits, out_dir):
    """旧脚本拷一份，按 (原文, 新文) 改（每处必须恰好出现一次）；返回改了几处。"""
    text = read_text(source)
    for old, new in edits:
        if text.count(old) != 1:
            raise RuntimeError("%s 里 %r 出现 %d 次" % (source, old, text.count(old)))
        text = text.replace(old, new)
    if not os.path.abspath(target).startswith(os.path.abspath(out_dir) + os.sep):
        raise RuntimeError("拷贝目标不在 --out 下：%s" % target)
    write_text(target, text)
    return len(edits)


def run_old_vitest(test_file, env_extra, log_path, timeout=3600):
    """旧 vitest 脚本（拷在 <out>/old/）用拷过去的 c5 vitest 配置跑（root 是仓库根，include 取 KB_TEST）。"""
    env = dict(os.environ)
    env.update(env_extra)
    env["KB_TEST"] = rel(test_file)
    config = os.path.join(os.path.dirname(test_file), "vitest.config.ts")
    t0 = time.time()
    proc = subprocess.run(["node", NODE_VITEST, "run", "--config", config], cwd=REPO, env=env, capture_output=True,
                          timeout=timeout)
    write_text(log_path, (proc.stdout + proc.stderr).decode("utf-8", "replace"))
    return proc.returncode, round(time.time() - t0, 1)


def add(report, row):
    report.append(row)
    mark = "ok " if row.get("ok") else "✗  "
    detail = {k: v for k, v in row.items() if k not in ("kind", "check", "ok") and not k.startswith("_")}
    print("%s%-8s %s  %s" % (mark, row["kind"], row.get("check", ""), json.dumps(detail, ensure_ascii=False)[:600]),
          flush=True)


def snap_src(out_dir, name):
    return os.path.join(out_dir, "snap", name, "src")


# ==================== snap ====================

SNAPS = [("head", "HEAD", None), ("c5", "a0a84322", C5_WASM), ("d1", "b721f636", None)]


def check_snap(out_dir, report):
    for name, rev, wasm in SNAPS:
        args = ["snapshot", "export", rev, os.path.join(out_dir, "snap", name), "--overwrite"]
        if wasm:
            args += ["--wasm", wasm]
        code, summary, err = kbp(args, timeout=1800)
        tsc = summary.get("tsc") or {}
        add(report, {"kind": "snap", "check": "export %s → %s" % (rev, name), "ok": code == 0 and tsc.get("errors") == 0,
                     "commit": summary.get("commit"), "wasm": (summary.get("wasm") or "")[:16], "tsc": tsc.get("errors"),
                     "stderr": err[-800:] if code else None})


def ensure_snaps(out_dir, report, names):
    missing = [n for n in names if not os.path.isfile(os.path.join(out_dir, "snap", n, "snapshot.json"))]
    if missing:
        check_snap(out_dir, report)


# ==================== corpus ====================

CORPUS_OLD = [
    # (名字, 源, 改动, 环境, 结果文件名)
    ("c5", "c5/corpus.test.ts", [('const OUT_DIR = join(REPO, "ignore/p4/c5/out");', 'const OUT_DIR = join(REPO, "%(out)s");')],
     lambda src: {"KB_SRC": rel(src), "KB_OUT": "corpus-c5"}, "corpus-c5.json"),
    ("b3", "b3/corpus.test.ts", [('const OUT_DIR = join(REPO, "ignore/p4/b3/out");', 'const OUT_DIR = join(REPO, "%(out)s");')],
     lambda src: {"KB_SRC": rel(src), "KB_OUT": "corpus-b3"}, "corpus-b3.json"),
    ("b4", "b4/corpus.test.ts", [('const OUT_DIR = join(REPO, "ignore/p4/b4/out");', 'const OUT_DIR = join(REPO, "%(out)s");')],
     lambda src: {"KB_SRC": rel(src), "KB_OUT": "corpus-b4"}, "corpus-b4.json"),
    ("b2", "b2/corpus.test.ts", [('const OUT_DIR = join(REPO, "ignore/p4/b2/out");', 'const OUT_DIR = join(REPO, "%(out)s");')],
     lambda src: {"KB_SRC": src.replace("\\", "/"), "KB_OUT": "corpus-b2"}, "corpus-b2.json"),
]
# 旧脚本的附加字段 → 新扫描里的字段
CORPUS_FIELDS = {"c5": [("systems", "systems")], "b3": [("modules", "modulesB3")], "b4": [("modules", "modulesB4")],
                 "b2": [("animatedUsages", "animatedUsages"), ("sheets", "sheets")]}


def check_corpus(out_dir, report):
    ensure_snaps(out_dir, report, ["head"])
    src = snap_src(out_dir, "head")
    old_dir = os.path.join(out_dir, "old", "corpus")
    rmtree_own(old_dir, out_dir)
    os.makedirs(os.path.join(old_dir, "out"))
    shutil.copyfile(os.path.join(P4, "c5", "vitest.config.ts"), os.path.join(old_dir, "vitest.config.ts"))
    out_rel = rel(os.path.join(old_dir, "out"))
    new_file = os.path.join(out_dir, "corpus", "new.json")
    t0 = time.time()
    code, summary, err = kbp(["corpus", "scan", "--src", src, "--out", new_file, "--overwrite", "--quiet",
                              "--extra", "controlpoints", "--extra", "modules:@b3,key=modulesB3",
                              "--extra", "modules:@b4,key=modulesB4", "--extra", "sheets"], timeout=3600)
    add(report, {"kind": "corpus", "check": "kbp corpus scan（四个插件）", "ok": code == 0, "summary": summary,
                 "seconds": round(time.time() - t0, 1), "stderr": err[-800:] if code else None})
    if code:
        return
    new = {r["sample"]: r for r in load_json(new_file)}
    for name, source, edits, env, result in CORPUS_OLD:
        target = os.path.join(old_dir, os.path.basename(source).replace(".test.ts", "-%s.test.ts" % name))
        copy_edit(os.path.join(P4, *source.split("/")), target, [(a, b % {"out": out_rel}) for a, b in edits], out_dir)
        code, seconds = run_old_vitest(target, env(src), os.path.join(old_dir, "out", "%s.log" % name))
        path = os.path.join(old_dir, "out", result)
        if code or not os.path.isfile(path):
            add(report, {"kind": "corpus", "check": "旧 %s" % source, "ok": False, "exit": code})
            continue
        old = {r["sample"]: r for r in load_json(path)}
        diffs = collections.Counter()
        examples = []
        for sample in sorted(set(old) | set(new)):
            a, b = old.get(sample), new.get(sample)
            if a is None or b is None:
                diffs["场景集合"] += 1
                examples.append(sample)
                continue
            if set(a.get("unsupported") or []) != set(b.get("unsupported") or []):
                diffs["unsupported"] += 1
                examples.append(sample)
            if a.get("error") != b.get("error"):
                diffs["error"] += 1
            for old_key, new_key in CORPUS_FIELDS[name]:
                if a.get(old_key) != b.get(new_key):
                    diffs[old_key] += 1
                    examples.append("%s.%s" % (sample, old_key))
        fields = {k: sum(1 for r in old.values() if k in r) for k, _ in CORPUS_FIELDS[name]}
        add(report, {"kind": "corpus", "check": "旧 %s 对新 scan" % source, "ok": not diffs, "samples": [len(old), len(new)],
                     "rows_with_field": fields, "diffs": dict(diffs), "examples": examples[:10], "seconds_old": seconds})


# ==================== corpus diff ====================


def _parse_c5_diff(text):
    out = {"removed": {}, "added": {}, "rest": {}}
    section = None
    for line in text.splitlines():
        m = re.match(r"场景 (\d+) 个；出错 HEAD (\d+) / 工作区 (\d+)", line)
        if m:
            out["samples"], out["errors"] = int(m.group(1)), [int(m.group(2)), int(m.group(3))]
        if line.startswith("== 去掉的键"):
            section = "removed"
            continue
        if line.startswith("== 新增的键"):
            section = "added"
            continue
        if line.startswith("== "):
            section = None
        m = re.match(r"== 干净场景：HEAD (\d+) 张，工作区 (\d+) 张", line)
        if m:
            out["clean"] = [int(m.group(1)), int(m.group(2))]
        m = re.match(r"  工作区：(.*)$", line)
        if m:
            out["clean_after"] = m.group(1).split()
        m = re.match(r"  变得不干净的：(.*)；新解锁的：(.*)$", line)
        if m:
            parse = lambda s: [] if s == "无" else ast.literal_eval(s)  # noqa: E731
            out["clean_lost"], out["clean_gained"] = parse(m.group(1)), parse(m.group(2))
        m = re.match(r"  剩下的键按场景数：(.*)$", line)
        if m:
            out["rest"] = dict((k, int(v)) for k, v in (p.rsplit(" ", 1) for p in m.group(1).split("，")))
        if section and line.startswith("  ") and "：" in line and not line.startswith("  意外"):
            m = re.match(r"  (\S+)：(\d+) 张 (.*)$", line)
            if m:
                out[section][m.group(1)] = m.group(3).split()
    return out


def _parse_b5(text):
    out = {"removed": {}, "added": {}, "changed": {}}
    section = None
    current = None
    for line in text.splitlines():
        m = re.match(r"场景数 (\d+) (\d+) 出错 (\d+) (\d+)", line)
        if m:
            out["samples"] = [int(m.group(1)), int(m.group(2))]
            out["errors"] = [int(m.group(3)), int(m.group(4))]
        m = re.match(r"干净 (\d+) → (\d+)", line)
        if m:
            out["clean"] = [int(m.group(1)), int(m.group(2))]
        m = re.match(r"  新增 (\[.*\])$", line)
        if m and section is None:
            out["clean_gained"] = ast.literal_eval(m.group(1))
        m = re.match(r"  掉出 (\[.*\])$", line)
        if m and section is None:
            out["clean_lost"] = ast.literal_eval(m.group(1))
        if line.startswith("== 去掉的键"):
            section = "removed"
            continue
        if line.startswith("== 新增的键"):
            section = "added"
            continue
        if line.startswith("== 逐张"):
            section = "changed"
            continue
        if line.startswith("== 变化场景的粒子归因"):
            section = None
            continue
        if section in ("removed", "added"):
            m = re.match(r"(\S+)  (\d+) 张: (.*)$", line)
            if m:
                out[section][m.group(1)] = m.group(3).split(", ")
        elif section == "changed":
            m = re.match(r"(\S+)$", line)
            if m and not line.startswith(" "):
                current = out["changed"].setdefault(m.group(1), {})
                continue
            m = re.match(r"  (去掉|新增): (\[.*\])$", line)
            if m and current is not None:
                current["removed" if m.group(1) == "去掉" else "added"] = ast.literal_eval(m.group(2))
            m = re.match(r"  之后共 (\d+) 项: (\[.*\])$", line)
            if m and current is not None:
                current["after"] = ast.literal_eval(m.group(2))
    return out


def _parse_colorn(text):
    out = {"near": [], "rest": []}
    section = None
    for line in text.splitlines():
        m = re.match(r"总数 (\d+) 干净 (\d+) 带 colorn (\d+)", line)
        if m:
            out["total"], out["clean"], out["hit"] = int(m.group(1)), int(m.group(2)), int(m.group(3))
        m = re.match(r"只差 colorn： (\[.*\])", line)
        if m:
            out["only"] = ast.literal_eval(m.group(1))
        if line.startswith("去掉后只差"):
            section = "near"
            continue
        if line.startswith("剩余键"):
            section = "rest"
            continue
        if section == "near":
            m = re.match(r"\s+(\S+) (\[.*\])$", line)
            if m:
                out["near"].append([m.group(1), ast.literal_eval(m.group(2))])
        elif section == "rest":
            m = re.match(r"\s+(\d+) (\S+)$", line)
            if m:
                out["rest"].append([m.group(2), int(m.group(1))])
    return out


EXPLAIN_DEMO = r'''"""accept3 的 --explain 示例：数「前」里粒子 JSON 原文带 spritetrail renderer 的场景（c5/corpus_diff.py「按粒子 JSON 原文核对」的一角）。"""


def explain(before, after, diff):
    hit = sorted(s for s, r in before.items()
                 if any(isinstance(e, dict) and e.get("name") == "spritetrail"
                        for system in r.get("systems", []) for e in (system.get("renderer") or [])))
    gone = sorted(diff["removed"].get("particle:renderer:spritetrail", []))
    return ["== 示例解释：JSON 里有 spritetrail renderer 的场景 %d 张，去掉 spritetrail 键的 %d 张，%s"
            % (len(hit), len(gone), "一致" if hit == gone else "不一致")]
'''


def check_cdiff(out_dir, report):
    before = os.path.join(P4, "c5", "out", "corpus-head.json")
    after = os.path.join(P4, "c5", "out", "corpus-ws.json")
    work = os.path.join(out_dir, "cdiff")
    rmtree_own(work, out_dir)
    os.makedirs(work)
    write_text(os.path.join(work, "explain_demo.py"), EXPLAIN_DEMO)
    code, summary, err = kbp(["corpus", "diff", before, after, "--out", os.path.join(work, "diff-c5.txt"),
                              "--explain", os.path.join(work, "explain_demo.py"), "--overwrite"])
    if code:
        add(report, {"kind": "cdiff", "check": "kbp corpus diff", "ok": False, "stderr": err[-800:]})
        return
    new = load_json(os.path.join(work, "diff-c5.txt.json"))
    d = new["diff"]
    # 旧 c5/corpus_diff.py：拷到 <out>/old/c5diff/，输入也拷过去（它读写 HERE/out）
    old_dir = os.path.join(out_dir, "old", "c5diff")
    rmtree_own(old_dir, out_dir)
    os.makedirs(os.path.join(old_dir, "out"))
    shutil.copyfile(os.path.join(P4, "c5", "corpus_diff.py"), os.path.join(old_dir, "corpus_diff.py"))
    shutil.copyfile(before, os.path.join(old_dir, "out", "corpus-head.json"))
    shutil.copyfile(after, os.path.join(old_dir, "out", "corpus-ws.json"))
    proc = subprocess.run([sys.executable, "-X", "utf8", "-I", os.path.join(old_dir, "corpus_diff.py")], capture_output=True)
    old = _parse_c5_diff(read_text(os.path.join(old_dir, "out", "corpus-diff.txt")))
    checks = {
        "场景数与出错": (old.get("samples"), old.get("errors")) == (d["samples"][0], d["errors"]),
        "去掉的键与场景": old["removed"] == {k: sorted(v) for k, v in d["removed"].items()},
        "新增的键": old["added"] == {k: sorted(v) for k, v in d["added"].items()},
        "干净场景": old.get("clean") == d["clean"] and old.get("clean_after") == d["clean_after"]
        and old.get("clean_gained") == d["clean_gained"] and old.get("clean_lost") == d["clean_lost"],
        "剩余键（前 14）": old["rest"] == dict(list(d["remaining"]["keys"].items())[:14]),
    }
    add(report, {"kind": "cdiff", "check": "对 c5/corpus_diff.py 的通用部分", "ok": proc.returncode == 0 and all(checks.values()),
                 "checks": checks, "removed": {k: len(v) for k, v in d["removed"].items()}, "clean": d["clean"]})
    explain = new.get("explain") or []
    add(report, {"kind": "cdiff", "check": "--explain 示例", "ok": bool(explain) and "29 张" in explain[0] and "一致" in explain[0]
                 and "不一致" not in explain[0], "line": explain[:1]})
    # 旧 b5/diff_corpus.py：只打印，拷一份照跑
    b5_dir = os.path.join(out_dir, "old", "b5diff")
    rmtree_own(b5_dir, out_dir)
    os.makedirs(b5_dir)
    shutil.copyfile(os.path.join(P4, "b5", "diff_corpus.py"), os.path.join(b5_dir, "diff_corpus.py"))
    proc = subprocess.run([sys.executable, "-X", "utf8", "-I", os.path.join(b5_dir, "diff_corpus.py"), before, after],
                          capture_output=True)
    text = proc.stdout.decode("utf-8", "replace")
    write_text(os.path.join(b5_dir, "diff.txt"), text)
    old = _parse_b5(text)
    changed_new = {c["sample"]: {"removed": c["removed"], "added": c["added"], "after": c["after"]} for c in d["changed"]}
    checks = {
        "场景数与出错": old.get("samples") == d["samples"] and old.get("errors") == d["errors"],
        "干净增减": old.get("clean") == d["clean"] and old.get("clean_gained") == d["clean_gained"]
        and old.get("clean_lost") == d["clean_lost"],
        "去掉的键与场景": old["removed"] == d["removed"],
        "新增的键与场景": old["added"] == d["added"],
        "逐张去掉 / 新增 / 之后": old["changed"] == changed_new,
    }
    add(report, {"kind": "cdiff", "check": "对 b5/diff_corpus.py 的通用部分", "ok": proc.returncode == 0 and all(checks.values()),
                 "checks": checks, "changed": len(changed_new)})
    # 旧 b6/corpus_colorn.py：--without
    source = os.path.join(P4, "step5", "out", "p4b5-after.json")
    b6_dir = os.path.join(out_dir, "old", "b6colorn")
    rmtree_own(b6_dir, out_dir)
    os.makedirs(b6_dir)
    shutil.copyfile(os.path.join(P4, "b6", "corpus_colorn.py"), os.path.join(b6_dir, "corpus_colorn.py"))
    proc = subprocess.run([sys.executable, "-X", "utf8", "-I", os.path.join(b6_dir, "corpus_colorn.py"), source],
                          capture_output=True)
    old = _parse_colorn(proc.stdout.decode("utf-8", "replace"))
    code, summary, err = kbp(["corpus", "diff", source, source, "--without", "particle:instance:colorn",
                              "--out", os.path.join(work, "without-colorn.txt"), "--overwrite"])
    w = load_json(os.path.join(work, "without-colorn.txt.json"))["without"] if code == 0 else {}
    rows = load_json(source)
    checks = {
        "总数 / 干净": old.get("total") == len(rows) and old.get("clean") == sum(1 for r in rows if not r["unsupported"]),
        "带 colorn": old.get("hit") == w.get("hit"),
        "只差 colorn": old.get("only") == w.get("only"),
        "只差 1–2 项": old.get("near") == w.get("near"),
        "剩余键（前 30）": old.get("rest") == [[k, n] for k, n in list((w.get("rest") or {}).items())[:30]],
    }
    add(report, {"kind": "cdiff", "check": "--without 对 b6/corpus_colorn.py", "ok": code == 0 and all(checks.values()),
                 "checks": checks, "hit": w.get("hit")})


# ==================== regress --corpus ====================


def _active(value):
    """同 features.ts 的 active：null、false、0、"" 不算。"""
    return value is not None and value is not False and value != 0 and value != ""


def _general_has(sample_dir, key):
    try:
        project, _ = libcontent.read(sample_dir, "project.json")
        scene_file = json.loads(project.decode("utf-8")).get("file") or "scene.json"
        data, _ = libcontent.read(sample_dir, scene_file)
    except Exception:
        return None
    text = data.decode("utf-8", "replace")
    try:
        scene = json.loads(text)
    except ValueError:  # WPE 的 JSON 可能带注释：去掉整行注释再试，仍不行就按文本找「键: 真值」
        try:
            scene = json.loads(re.sub(r"(?m)^\s*//.*$", "", text))
        except ValueError:
            return re.search(r'"%s"\s*:\s*(true|[1-9]|"[^"])' % key, text) is not None
    general = scene.get("general") or {}
    return key in general and _active(general[key])


def check_cregress(out_dir, report):
    ensure_snaps(out_dir, report, ["head"])
    head = snap_src(out_dir, "head")
    out = os.path.join(out_dir, "cregress")
    code, summary, err = kbp(["regress", "--src", head, "--src", head, "--corpus", "--no-cases", "--extra", "controlpoints",
                              "--out", os.path.join(out, "same"), "--overwrite", "--quiet"], timeout=3600)
    add(report, {"kind": "cregress", "check": "同一份快照两次", "ok": code == 0 and (summary.get("corpus") or {}).get("same") is True
                 and summary.get("same") is True, "summary": summary, "stderr": err[-800:] if code else None})
    feat = os.path.join(out_dir, "snap", "feat")
    rmtree_own(feat, out_dir)
    shutil.copytree(os.path.join(out_dir, "snap", "head", "src"), os.path.join(feat, "src"))
    target = os.path.join(feat, "src", "compile", "features.ts")
    text = read_text(target)
    line = '  "camerafade",\n'
    if text.count(line) != 1:
        raise RuntimeError("features.ts 里 %r 出现 %d 次" % (line, text.count(line)))
    write_text(target, text.replace(line, "", 1))
    code, summary, err = kbp(["regress", "--src", head, "--src", os.path.join(feat, "src"), "--corpus", "--no-cases",
                              "--out", os.path.join(out, "feat"), "--overwrite", "--quiet"], timeout=3600)
    detail = load_json(os.path.join(out, "feat", "regress.json"))["corpus"] if code == 0 else {}
    affected = detail.get("affected") or []
    only_key = all(a.get("only_b") == ["general:camerafade"] and not a.get("only_a") and not a.get("fields") and
                   "error" not in a and "missing" not in a for a in affected)
    # 独立核对：scene.json 的 general 里 camerafade 是真值的场景（能力表只对真值报，同 features.ts 的 active）
    rows = load_json(os.path.join(out, "feat", "a", "corpus.json"))
    projects = {os.path.basename(p): p for p in libcontent.projects(["default", "workshop"])}
    expect = sorted(r["sample"] for r in rows if "error" not in r and r["sample"] in projects
                    and _general_has(projects[r["sample"]], "camerafade"))
    got = sorted(a["sample"] for a in affected)
    add(report, {"kind": "cregress", "check": "能力表删掉 camerafade 的中性项", "ok": code == 0 and summary.get("same") is False
                 and bool(affected) and only_key and got == expect, "affected": len(got), "expect_from_scene_json": len(expect),
                 "only_key": only_key, "missing": sorted(set(expect) - set(got))[:10], "extra": sorted(set(got) - set(expect))[:10],
                 "report": os.path.join(out, "feat", "regress.txt")})


# ==================== mutate ====================

CORNERS_CMD = {"label": "四角", "kbp": ["corners", "offline", "p4c-trail-fps60", "p4c-sprite-fps60", "--src", "{src}",
                                       "--data", "{data}", "--out", "{work}/corners", "--skip", "T8,T8r",
                                       "--expect-hidden", "p4c-trail/T6,p4c-sprite/S7", "--strict", "--overwrite", "--quiet"]}
WORKSPACE_IDS = ["trail-macro-missing", "degenerate-not-skipped", "hidden-still-drawn", "axis-zero-threshold"]


def spec_from_c5(path):
    """c5/mutate.py 的变异清单 → 新跑器的 JSON spec。只取顶层 import 与赋值（常量、TESTS、MUTATIONS）执行，不运行 main()。"""
    tree = ast.parse(read_text(path))
    keep = [n for n in tree.body if isinstance(n, (ast.Import, ast.ImportFrom, ast.Assign))]
    namespace = {}
    exec(compile(ast.Module(body=keep, type_ignores=[]), path, "exec"), namespace)
    mutations = []
    for mid, label, edits in namespace["MUTATIONS"]:
        mutations.append({"id": mid, "label": label,
                          "edits": [{"file": f, "old": old, "new": new, "count": count} for f, old, new, count in edits]})
    return {"source": rel(path), "defaults": {"tests": list(namespace["TESTS"]), "commands": [CORNERS_CMD]},
            "mutations": mutations}


def _parse_old_mutate(text):
    out = collections.OrderedDict()
    current = None
    for line in text.splitlines():
        m = re.match(r"== ([^：\s]+)：(.*) → (检出|未检出)；还原 (\S+)", line)  # 说明里也可能有「：」
        if m:
            current = out.setdefault(m.group(1), {"detected": m.group(3) == "检出", "restored": m.group(4) == "一致"})
            continue
        if current is None:
            continue
        m = re.match(r"\s+检出方：(.*)$", line)
        if m:
            current["by"] = sorted(x for x in m.group(1).split("、") if x and x != "无")
        m = re.match(r"\s+单测（.*）：退出码 (\S+)，(.*)$", line)
        if m:
            current["tests"] = m.group(2).strip()
        m = re.search(r"离线四角：.*不符 (\d+) 处", line)
        if m:
            current["corners"] = int(m.group(1))
        elif re.search(r"离线四角：", line):
            current["corners_line"] = line.strip()
    return out


def _compare_mutate(old, new_report, ids):
    rows = []
    bad = 0
    for row in new_report["mutations"]:
        mid = row["id"]
        if mid not in ids:
            continue
        o = old.get(mid) or {}
        tests = (row["result"].get("tests") or {}).get("summary")
        corners = None
        for cmd in row["result"].get("commands") or []:
            m = re.search(r"不符 (\d+) 处", cmd.get("tail") or "")
            if cmd["label"] == "四角":
                corners = int(m.group(1)) if m else (0 if not cmd["detected"] else None)
        item = {"id": mid, "detected": [o.get("detected"), row["detected"]], "by": [o.get("by"), sorted(row["detected_by"])],
                "tests": [o.get("tests"), tests], "corners": [o.get("corners", 0 if o.get("corners_line") else None), corners],
                "restored": row["restored"]}
        item["ok"] = (o.get("detected") == row["detected"] and o.get("by") == sorted(row["detected_by"]) and row["restored"]
                      and not row["error"])
        item["same_tests"] = o.get("tests") == tests
        item["same_corners"] = item["corners"][0] == item["corners"][1]
        if not item["ok"]:
            bad += 1
        rows.append(item)
    return rows, bad


CONCURRENT_EDIT = r'''"""accept3：在检出期间改动被变异的文件（模拟并行会话在同一个文件里加了一行）。"""
import sys

with open(sys.argv[1], "a", encoding="utf-8", newline="\n") as f:
    f.write("// kbp accept3：模拟并行会话的改动\n")
'''


def check_mutate(out_dir, report):
    ensure_snaps(out_dir, report, ["c5"])
    work = os.path.join(out_dir, "mutate")
    rmtree_own(work, out_dir)
    os.makedirs(work)
    spec = spec_from_c5(os.path.join(P4, "c5", "mutate.py"))
    spec_path = os.path.join(work, "c5-spec.json")
    write_text(spec_path, json.dumps(spec, ensure_ascii=False, indent=1) + "\n")
    add(report, {"kind": "mutate", "check": "c5/mutate.py → spec", "ok": len(spec["mutations"]) == 23,
                 "mutations": len(spec["mutations"]), "tests": spec["defaults"]["tests"]})
    old = _parse_old_mutate(read_text(os.path.join(P4, "c5", "out", "mutate.txt")))

    def copy_snap(name):
        target = os.path.join(out_dir, "snap", name)
        rmtree_own(target, out_dir)
        shutil.copytree(os.path.join(out_dir, "snap", "c5"), target,
                        ignore=shutil.ignore_patterns("tsc.log", "vitest.log", "vitest.json"))
        return os.path.join(target, "src")

    # 快照模式：全部
    src = copy_snap("c5-mut")
    t0 = time.time()
    code, summary, err = kbp(["mutate", "--spec", spec_path, "--src", src, "--out", os.path.join(work, "snapshot.txt"),
                              "--overwrite", "--quiet"], timeout=7200)
    if code:
        add(report, {"kind": "mutate", "check": "快照模式", "ok": False, "summary": summary, "stderr": err[-1500:]})
    else:
        result = load_json(os.path.join(work, "snapshot.txt.json"))
        rows, bad = _compare_mutate(old, result, {m["id"] for m in spec["mutations"]})
        add(report, {"kind": "mutate", "check": "快照模式：逐处检出结论与检出方对 c5/out/mutate.txt", "ok": bad == 0 and
                     result["tree_same"] and len(rows) == 23, "mutations": len(rows), "differ": bad,
                     "tree_same": result["tree_same"], "baseline": result["baseline"], "seconds": round(time.time() - t0, 1),
                     "same_tests": sum(r["same_tests"] for r in rows), "same_corners": sum(r["same_corners"] for r in rows),
                     "rows": [r for r in rows if not (r["ok"] and r["same_tests"] and r["same_corners"])][:30]})
    # 工作区模式（反向替换）：一部分，只在快照副本上演练
    src = copy_snap("c5-ws")
    t0 = time.time()
    code, summary, err = kbp(["mutate", "--spec", spec_path, "--src", src, "--mode", "workspace", "--out",
                              os.path.join(work, "workspace.txt"), "--overwrite", "--quiet"] + WORKSPACE_IDS, timeout=7200)
    if code:
        add(report, {"kind": "mutate", "check": "工作区模式", "ok": False, "summary": summary, "stderr": err[-1500:]})
    else:
        result = load_json(os.path.join(work, "workspace.txt.json"))
        rows, bad = _compare_mutate(old, result, set(WORKSPACE_IDS))
        add(report, {"kind": "mutate", "check": "工作区模式：%s" % " ".join(WORKSPACE_IDS), "ok": bad == 0 and result["tree_same"]
                     and len(rows) == len(WORKSPACE_IDS), "differ": bad, "tree_same": result["tree_same"],
                     "seconds": round(time.time() - t0, 1), "rows": [r for r in rows if not r["ok"]]})
    # 工作区模式：检出期间文件被别人改了 → 反向替换，别人的改动保留
    write_text(os.path.join(work, "concurrent_edit.py"), CONCURRENT_EDIT)
    target_rel = "render/uniforms.ts"
    m = next(x for x in spec["mutations"] if x["id"] == "renderVar0-swap")
    concurrent = {"defaults": {}, "mutations": [dict(m, id="renderVar0-swap-concurrent", tests=spec["defaults"]["tests"],
                                                     commands=[{"label": "并行改动", "argv": [
                                                         sys.executable, "-X", "utf8", "-I",
                                                         os.path.join(work, "concurrent_edit.py"),
                                                         "{src}/" + target_rel]}])]}
    concurrent_spec = os.path.join(work, "concurrent-spec.json")
    write_text(concurrent_spec, json.dumps(concurrent, ensure_ascii=False, indent=1) + "\n")
    path = os.path.join(src, *target_rel.split("/"))
    with open(path, "rb") as f:
        original = f.read()
    code, summary, err = kbp(["mutate", "--spec", concurrent_spec, "--src", src, "--mode", "workspace", "--no-baseline",
                              "--out", os.path.join(work, "concurrent.txt"), "--overwrite", "--quiet"], timeout=3600)
    with open(path, "rb") as f:
        after = f.read()
    expected = original + "// kbp accept3：模拟并行会话的改动\n".encode("utf-8")
    result = load_json(os.path.join(work, "concurrent.txt.json")) if code == 0 else {}
    row = (result.get("mutations") or [{}])[0]
    add(report, {"kind": "mutate", "check": "工作区模式：检出期间被并行改动 → 反向替换", "ok": code == 0 and after == expected
                 and row.get("detected") and any("反向替换" in n for n in row.get("notes") or []),
                 "detected_by": row.get("detected_by"), "notes": row.get("notes"), "kept_concurrent_line": after == expected,
                 "tree_same": result.get("tree_same"), "stderr": err[-800:] if code else None})
    with open(path, "wb") as f:  # 副本还原成干净的（这是本自测自己的副本）
        f.write(original)


# ==================== cmp ====================

CMP_TRACK = ("dev4/out/track-p4c-cp.json", "tracks/rd-p4c-cp-fps60.json", "ptr-offset,ptr-io,ptr-xform")
FRAMES = [2062, 2063, 2064]
STATS = [("w1504316159", "wpe-b3-1504316159-stats.json"), ("w3820104696", "wpe-b3-3820104696-stats.json")]


def check_cmp(out_dir, report):
    work = os.path.join(out_dir, "cmp")
    rmtree_own(work, out_dir)
    os.makedirs(work)
    old_root = os.path.join(out_dir, "old", "cmp")
    rmtree_own(old_root, out_dir)
    os.makedirs(old_root)
    # track：dev4/cmp-wpe.ts（只打印，没有输出路径；照规矩拷一份跑）
    ours, wpe, skip = (os.path.join(P4, *p.split("/")) if i < 2 else p for i, p in enumerate(CMP_TRACK))
    shutil.copyfile(os.path.join(P4, "dev4", "cmp-wpe.ts"), os.path.join(old_root, "cmp-wpe.ts"))
    proc = subprocess.run(["deno", "run", "-A", os.path.join(old_root, "cmp-wpe.ts"), ours, wpe, "--skip", skip],
                          cwd=REPO, capture_output=True)
    old_lines = [l for l in proc.stdout.decode("utf-8", "replace").splitlines() if l.strip()]
    code, summary, err = kbp(["cmp", "track", ours, wpe, "--skip", skip, "--out", os.path.join(work, "track.txt"), "--overwrite"])
    new_lines = [l for l in read_text(os.path.join(work, "track.txt")).splitlines() if l.strip()] if code == 0 else []
    add(report, {"kind": "cmp", "check": "track 对 dev4/cmp-wpe.ts（p4c-cp，逐行）", "ok": proc.returncode == 0 and code == 0
                 and old_lines == new_lines, "lines": len(new_lines), "systems": len((summary or {}).get("systems") or {}),
                 "differ": [(a, b) for a, b in zip(old_lines, new_lines) if a != b][:5]})
    # frame：c5/cmp_scene.py（读 c5/out 的 ours 与 step4/out 的 WPE，写到拷贝旁的 out/）
    scene_dir = os.path.join(old_root, "c5scene")
    os.makedirs(os.path.join(scene_dir, "out"))
    copy_edit(os.path.join(P4, "c5", "cmp_scene.py"), os.path.join(scene_dir, "cmp_scene.py"), [
        ("WPE = os.path.join(HERE, '..', 'step4', 'out')",
         "WPE = %r\nOURS = %r  # accept3：ours 照旧从 c5/out 读，输出写拷贝旁的 out/" % (
             os.path.join(P4, "step4", "out"), os.path.join(P4, "c5", "out"))),
        ("os.path.join(OUT, f'ours-3832772446-f{frame}.png')", "os.path.join(OURS, f'ours-3832772446-f{frame}.png')"),
    ], out_dir)
    proc = subprocess.run([sys.executable, "-X", "utf8", "-I", os.path.join(scene_dir, "cmp_scene.py")], capture_output=True)
    old_text = read_text(os.path.join(scene_dir, "out", "cmp-3832772446.txt")) if proc.returncode == 0 else ""
    old_frames = {}
    current = None
    for line in old_text.splitlines():
        m = re.match(r"帧 (\d+)：(\d+)×(\d+)，> 0：(\d+).*> 2：(\d+).*> 8：(\d+).*> 32：(\d+).*最大 (\d+)", line)
        if m:
            current = old_frames.setdefault(int(m.group(1)), {"size": [int(m.group(2)), int(m.group(3))],
                                                               "counts": [int(m.group(i)) for i in (4, 5, 6, 7)],
                                                               "max": int(m.group(8)), "blobs": []})
            continue
        m = re.match(r"\s+\((\d+), (\d+)\)–\((\d+), (\d+)\)，\d+×\d+，(\d+) 格", line)
        if m and current is not None:
            current["blobs"].append(tuple(int(m.group(i)) for i in range(1, 6)))
    from PIL import Image, ImageChops

    for frame in FRAMES:
        ours_png = os.path.join(P4, "c5", "out", "ours-3832772446-f%d.png" % frame)
        wpe_png = os.path.join(P4, "step4", "out", "wpe-3832772446-f%d.png" % frame)
        heat = os.path.join(work, "heat-f%d.png" % frame)
        code, summary, err = kbp(["cmp", "frame", ours_png, wpe_png, "--out", os.path.join(work, "frame-f%d.txt" % frame),
                                  "--heat", heat, "--overwrite"])
        detail = load_json(os.path.join(work, "frame-f%d.txt.json" % frame)) if code == 0 else {}
        o = old_frames.get(frame) or {}
        new_blobs = sorted(tuple(b) for b in detail.get("blobs") or [])[:]
        old_blobs = sorted(o.get("blobs") or [])
        # 旧脚本只列前 30 个连通块
        blobs_ok = (len(detail.get("blobs") or []) <= 30 and new_blobs == old_blobs) or (
            set(old_blobs) <= set(new_blobs) and len(old_blobs) == 30)
        heat_old = os.path.join(scene_dir, "out", "heat-3832772446-f%d.png" % frame)
        heat_same = os.path.isfile(heat) and os.path.isfile(heat_old) and ImageChops.difference(
            Image.open(heat), Image.open(heat_old)).getbbox() is None
        counts = [detail.get("counts", {}).get(k) for k in ("0", "2", "8", "32")]
        add(report, {"kind": "cmp", "check": "frame f%d 对 c5/cmp_scene.py（3832772446）" % frame, "ok": code == 0 and
                     o.get("size") == detail.get("size") and o.get("counts") == counts and o.get("max") == detail.get("max")
                     and blobs_ok and heat_same, "counts": counts, "max": detail.get("max"),
                     "blobs": len(detail.get("blobs") or []), "heat_pixel_equal": heat_same})
    # stats：b3/cmp_stats.py（读 b3/out 的 real.json 与 WPE 统计量；只打印）
    stats_dir = os.path.join(old_root, "b3stats")
    copy_edit(os.path.join(P4, "b3", "cmp_stats.py"), os.path.join(stats_dir, "cmp_stats.py"), [
        ("STEP5 = os.path.join(HERE, 'out')", "STEP5 = %r  # accept3：输入照旧读 b3/out" % os.path.join(P4, "b3", "out")),
        ("with open(os.path.join(HERE, 'out', 'real.json'), encoding='utf-8') as f:",
         "with open(os.path.join(STEP5, 'real.json'), encoding='utf-8') as f:"),
    ], out_dir)
    proc = subprocess.run([sys.executable, "-X", "utf8", "-I", os.path.join(stats_dir, "cmp_stats.py")], capture_output=True)
    text = proc.stdout.decode("utf-8", "replace")
    write_text(os.path.join(stats_dir, "out.txt"), text)
    blocks = re.split(r"(?m)^== ", text)
    for label, wpe_file in STATS:
        old_block = next((b for b in blocks if b.startswith(label[1:])), "")
        old_lines = [l for l in old_block.splitlines()[1:] if l.strip()]
        code, summary, err = kbp(["cmp", "stats", os.path.join(P4, "b3", "out", "real.json"),
                                  os.path.join(P4, "b3", "out", wpe_file), "--label", label,
                                  "--out", os.path.join(work, "stats-%s.txt" % label), "--overwrite"])
        new_lines = [l for l in read_text(os.path.join(work, "stats-%s.txt" % label)).splitlines()[1:] if l.strip()] \
            if code == 0 else []
        add(report, {"kind": "cmp", "check": "stats %s 对 b3/cmp_stats.py（逐行，表头除外）" % label, "ok": proc.returncode == 0
                     and code == 0 and bool(old_lines) and old_lines == new_lines, "lines": len(new_lines),
                     "differ": [(a, b) for a, b in zip(old_lines, new_lines) if a != b][:5]})


# ==================== bbox ====================

BBOX_DEFS = r'''"""accept3：生成库的 bbox。两个工程只差 bbox：kbp-bbox-plain（不传）与 kbp-bbox-demo（传）。"""
from kbp import gen

SYSTEMS = {
    "A": ("255 0 0", "500 700 0"),
    "B": ("0 255 0", "1300 300 0"),
}


def _write(name, bbox):
    systems = {k: gen.system(rgb, None, emitter=gen.ring(distance=0), lifetime=4, maxcount=1, size=40)
               for k, (rgb, _) in SYSTEMS.items()}
    overrides = {k: gen.at(origin) for k, (_, origin) in SYSTEMS.items()}
    images = [("bg", gen.image_layer("960 540 0", "200 100", "kbi_bg"))]
    materials = gen.image_assets("kbi_bg", "util/white")
    gen.write_project(name, "kbp-bbox", systems, images=images, materials=materials, overrides=overrides, bbox=bbox)


def plain():
    _write("kbp-bbox-plain", None)


def demo():
    _write("kbp-bbox-demo", {"A": gen.bbox_around("500 700 0", 60), "B": gen.bbox_around((1300, 300), 80, 40), "bg": "auto"})


PROJECTS = {"kbp-bbox-plain": plain, "kbp-bbox-demo": demo}
'''


def check_bbox(out_dir, report):
    import numpy as np
    from PIL import Image

    work = os.path.join(out_dir, "bbox")
    rmtree_own(work, out_dir)
    write_text(os.path.join(work, "defs", "bboxdemo.py"), BBOX_DEFS)
    code, summary, err = kbp(["gen", "bboxdemo", "--data", work])
    if code:
        add(report, {"kind": "bbox", "check": "kbp gen bboxdemo", "ok": False, "stderr": err[-800:]})
        return
    plain, demo = (os.path.join(work, "proj", n) for n in ("kbp-bbox-plain", "kbp-bbox-demo"))
    differ = []
    for base, _, names in os.walk(plain):
        for name in names:
            a = os.path.join(base, name)
            r = os.path.relpath(a, plain)
            with open(a, "rb") as f1, open(os.path.join(demo, r), "rb") as f2:
                if f1.read() != f2.read():
                    differ.append(r.replace("\\", "/"))
    meta_plain = load_json(os.path.join(plain, "kbp-meta.json"))
    meta_demo = load_json(os.path.join(demo, "kbp-meta.json"))
    stripped = json.loads(json.dumps(meta_demo))
    for o in stripped["objects"].values():
        o.pop("bbox", None)
    boxes = {k: v.get("bbox") for k, v in meta_demo["objects"].items()}
    add(report, {"kind": "bbox", "check": "带 / 不带 bbox 只差 kbp-meta.json 的 bbox", "ok": differ == ["kbp-meta.json"]
                 and stripped == meta_plain and "bbox" not in json.dumps(meta_plain) and boxes["bg"] == [860.0, 490.0, 1060.0, 590.0],
                 "differ": differ, "bbox": boxes})
    # 合成两张图：A、B 的包围盒里各一块差、外面一块、FR / CLK 区一块（应排除）
    base = np.zeros((1080, 1920, 3), dtype=np.uint8)
    ours = base.copy()
    patches = [("A", (500, 700), (10, 10), 255), ("B", (1300, 300), (20, 5), 40), ("other", (100, 100), (3, 3), 200),
               ("FR", (1820, 40), (6, 6), 255)]
    for _, (sx, sy), (w, h), v in patches:
        y = 1080 - sy
        ours[y:y + h, sx:sx + w] = v
    a_png, b_png = os.path.join(work, "ours.png"), os.path.join(work, "wpe.png")
    Image.fromarray(ours).save(a_png)
    Image.fromarray(base).save(b_png)
    code, summary, err = kbp(["cmp", "frame", a_png, b_png, "--meta", os.path.join(demo, "kbp-meta.json"),
                              "--out", os.path.join(work, "cmp.txt"), "--overwrite"])
    objects = (load_json(os.path.join(work, "cmp.txt.json")) if code == 0 else {}).get("objects") or {}
    got = {k: (v["pixels"], v["max"]) for k, v in objects.items()}
    want = {"A": (100, 255), "B": (100, 40), "bg": (0, 0), "other": (9, 200)}
    add(report, {"kind": "bbox", "check": "cmp frame --meta 按对象归类（FR / CLK 区排除）", "ok": code == 0 and got == want,
                 "got": got, "want": want})
    code, summary, err = kbp(["cmp", "frame", a_png, b_png, "--meta", os.path.join(plain, "kbp-meta.json")])
    add(report, {"kind": "bbox", "check": "没有 bbox 的 meta 只报整帧", "ok": code == 0 and "objects" not in summary
                 and any("没有 bbox" in n for n in summary.get("fit") or []), "counts": summary.get("counts")})


# ==================== corners ====================


def _norm_corner_lines(text, mapping):
    out = []
    for line in text.splitlines():
        if not line.strip() or line.startswith("编译 ") or line.startswith("uniform ") or line.startswith("比了 "):
            continue
        for a, b in mapping:
            line = line.replace(a, b)
        out.append(line)
    return out


def _final(text):
    line = next((l for l in text.splitlines() if l.startswith("比了 ")), "")
    return re.findall(r"\d+(?:\.\d+)?e[-+]\d+|\d+", line)


def check_corners(out_dir, report):
    ensure_snaps(out_dir, report, ["c5", "d1"])
    work = os.path.join(out_dir, "corners")
    runs = [
        ("c5", ["p4c-trail-fps60", "p4c-sprite-fps60"], ["--skip", "T8,T8r", "--expect-hidden", "p4c-trail/T6,p4c-sprite/S7"],
         os.path.join(P4, "c5", "out", "corners.txt"), [("p4c-trail-fps60/", "p4c-trail/"), ("p4c-sprite-fps60/", "p4c-sprite/")]),
        ("d1", ["p4d-rope-fps60", "p4d-rope-fps10"], [], os.path.join(P4, "d1", "out", "corners.txt"), []),
    ]
    for name, tags, extra, old_path, mapping in runs:
        out = os.path.join(work, name)
        code, summary, err = kbp(["corners", "offline"] + tags + ["--src", snap_src(out_dir, name), "--out", out,
                                                                  "--overwrite", "--quiet"] + extra, timeout=1800)
        if code:
            add(report, {"kind": "corners", "check": name, "ok": False, "stderr": err[-1000:]})
            continue
        new_text, old_text = read_text(os.path.join(out, "corners.txt")), read_text(old_path)
        new_lines, old_lines = _norm_corner_lines(new_text, mapping), _norm_corner_lines(old_text, [])
        same_lines = new_lines == old_lines
        add(report, {"kind": "corners", "check": "%s：逐行对 %s" % (name, rel(old_path)), "ok": same_lines
                     and _final(new_text) == _final(old_text) and summary.get("failures") == 0, "lines": len(new_lines),
                     "final": [_final(old_text), _final(new_text)], "uniform": summary.get("uniform"),
                     "seconds": summary.get("seconds"),
                     "differ": [(a, b) for a, b in zip(old_lines, new_lines) if a != b][:5]
                     + ([("行数", len(old_lines), len(new_lines))] if len(old_lines) != len(new_lines) else [])})


# ==================== sample ====================


def check_sample(out_dir, report, window, size=None):
    if not window:
        add(report, {"kind": "sample", "check": "跳过（没给 --window）", "ok": True, "skipped": True})
        return
    work = os.path.join(out_dir, "sample")
    rmtree_own(work, out_dir)
    os.makedirs(work)
    png = os.path.join(work, "grab.png")
    code, summary, err = kbp(["sample", "grab", window, "--out", png])
    from PIL import Image

    got = list(Image.open(png).size) if code == 0 else None
    want = [int(v) for v in size.split("x")] if size else (summary.get("size") if code == 0 else None)
    add(report, {"kind": "sample", "check": "grab", "ok": code == 0 and got == summary.get("size") and got == want
                 and not summary.get("warning"), "png_size": got, "client": summary.get("size"), "want": want,
                 "window": summary.get("window"), "flags": summary.get("flags"), "stderr": err[-500:] if code else None})
    frames = os.path.join(work, "series")
    code, summary, err = kbp(["sample", "series", window, "--seconds", "5", "--changed-only", "--out", frames], timeout=120)
    add(report, {"kind": "sample", "check": "series 5 s（画面变了才存）", "ok": code == 0 and summary.get("kept", 0) >= 25
                 and 4.5 <= summary.get("seconds", 0) <= 7, "samples": summary.get("samples"), "kept": summary.get("kept"),
                 "rate": summary.get("rate"), "seconds": summary.get("seconds"), "stderr": err[-500:] if code else None})
    code, summary, err = kbp(["sample", "read", frames, "--fr", "--png", os.path.join(work, "png"), "--frames", "0,10",
                              "--out", os.path.join(work, "read.json")])
    fr = summary.get("fr") or {}
    add(report, {"kind": "sample", "check": "read（整帧，FR 帧号）", "ok": code == 0 and summary.get("frames", 0) >= 25
                 and fr.get("increasing") and fr.get("decoded", 0) >= summary.get("frames", 0) * 0.9,
                 "frames": summary.get("frames"), "fr": fr, "png": len(summary.get("png") or [])})
    grid = os.path.join(work, "grid.bin")
    code, summary, err = kbp(["sample", "series", window, "--seconds", "5", "--grid", "20,10,50", "--out", grid], timeout=120)
    code2, read, err2 = kbp(["sample", "read", grid, "--point", "30,70"])
    add(report, {"kind": "sample", "check": "series 5 s（网格）+ read", "ok": code == 0 and code2 == 0
                 and read.get("samples") == summary.get("samples") and summary.get("samples", 0) >= 25,
                 "samples": summary.get("samples"), "rate": summary.get("rate"), "grid": [read.get("cols"), read.get("rows")],
                 "grab_ms": read.get("grab_ms")})


# ==================== 入口 ====================

SECTIONS = ["snap", "corpus", "cdiff", "cregress", "mutate", "cmp", "bbox", "corners", "sample"]


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", default=os.path.join(REPO, "ignore", "kbp", "accept3"))
    parser.add_argument("--only", help="逗号分隔：" + ",".join(SECTIONS))
    parser.add_argument("--window", help="sample 段：MCP 开的测试窗口标题（kb-<进程号>-<序号>）")
    parser.add_argument("--window-size", help="sample 段：窗口应有的客户区尺寸，如 960x540")
    args = parser.parse_args()
    out_dir = os.path.abspath(args.out)
    os.makedirs(out_dir, exist_ok=True)
    only = args.only.split(",") if args.only else SECTIONS
    report = []
    started = time.time()
    timings = {}
    for section in SECTIONS:
        if section not in only:
            continue
        t0 = time.time()
        try:
            if section == "sample":
                check_sample(out_dir, report, args.window, args.window_size)
            else:
                globals()["check_" + section](out_dir, report)
        except Exception as e:  # 自测本身出错也记下，接着跑后面的段
            add(report, {"kind": section, "check": "自测出错", "ok": False, "error": "%s: %s" % (type(e).__name__, e)})
        timings[section] = round(time.time() - t0, 1)
    path = os.path.join(out_dir, "report.json" if not args.only else "report-%s.json" % "-".join(only))
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump({"seconds": timings, "total": round(time.time() - started, 1), "checks": report}, f,
                  ensure_ascii=False, indent=1, default=str)
    failed = [r for r in report if not r.get("ok")]
    print(json.dumps({"ok": not failed, "checks": len(report), "failed": [(r["kind"], r.get("check")) for r in failed],
                      "report": path, "seconds": timings}, ensure_ascii=False))
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
