"""变异检查（kbp-tools 点 6）：`kbp mutate --spec <文件> [--src] [--mode snapshot|workspace] [id…]`。

照 `ignore/p4/c1/mutate.py`（快照里改、按原字节写回）、`c5/mutate.py`（单测 + 离线四角）与 `b5/`、`b6/mutate.py`（工作区里改、
反向替换还原，不覆盖并行会话的改动）。每处：改坏 → 跑检出方（单测、回放案例、其它命令）→ 还原 → 核对；开头和结尾各求一次 src 的
整树哈希。

变异清单（数据，留在各步目录）：`.py`（模块里的 `MUTATIONS`，可选 `DEFAULTS`）或 `.json`（`{"defaults": {…}, "mutations": […]}`）：

    MUTATIONS = [
        {"id": "euler-xyz", "label": "说明",
         "edits": [{"file": "particles/controlpoints.ts", "old": "…", "new": "…", "count": 1}],   # 也可直接写 file/old/new/count
         "tests": ["src/particles/controlpoints.test.ts"],   # vitest 过滤（相对 --src 的上一级，那里要有 vitest.config.ts）
         "cases": ["c1"],                                    # 回放案例（<data>/cases/），有失败或跑不下去算检出
         "commands": [{"label": "四角", "kbp": ["corners", "offline", "p4c-sprite-fps60", "--src", "{src}", "--out",
                                               "{work}/corners", "--strict", "--overwrite", "--quiet"]}]},
    ]
    DEFAULTS = {"tests": […], "cases": […], "commands": […]}   # 变异没写这几个键时用

- 命令：`["argv", …]`、`{"argv": […], "cwd": …, "env": {…}, "label": …}` 或 `{"kbp": [kbp.py 的参数…], "label": …}`；退出码非 0
  算检出。占位符：`{src}`（产品源码）、`{root}`（它的上一级）、`{work}`（本处变异的工作目录）、`{data}`、`{repo}`、`{id}`、`{python}`、
  `{kbp}`。
- 单测：`node vitest run <tests…>`，cwd 是 `{root}`（快照目录或 apps/wpe-scene）；退出码非 0 算检出，另报失败的用例名。
- 基线：先在没改的源码上把用到的检出方各跑一遍；基线就失败的检出方，结论里标出来（这一项的「检出」不可信）。`--no-baseline` 跳过。
- 还原：
  - `snapshot`（缺省）：按原字节写回，核对哈希。要求 src 在 `kbp snapshot export` 的快照里（上一级有 snapshot.json），工作区用 workspace。
  - `workspace`：文件没被别人改过就按原字节写回（等于反向替换）；被改过就把本处的 new 逐条换回 old（new 不能为空、改前文件里不能
    已有 new），别人的改动保留。
- 结果：`--out`（缺省 `<spec 所在目录>/out/mutate.txt`，只跑部分 id 时 `mutate-partial.txt`），另写同名 `.json`；工作目录在
  `<out 去掉扩展名>-work/<id>/`。
"""

import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import time

from . import common
from .common import KbpError
from . import replay_host

WORK_MARKER = ".kbp-mutate-work"
SUMMARY = re.compile(r"^\s*Tests\s+(\d[^\n]*)$", re.M)
FAILED = re.compile(r"×\s+([^\n]+)")


# ==================== 清单 ====================


def load_spec(path):
    path = os.path.abspath(path)
    if not os.path.isfile(path):
        raise KbpError("data", "找不到变异清单 %s" % path)
    if path.endswith(".json"):
        spec = common.read_json(path)
        defaults, mutations = spec.get("defaults") or {}, spec.get("mutations")
    else:
        module_spec = importlib.util.spec_from_file_location("kbp_mutations", path)
        module = importlib.util.module_from_spec(module_spec)
        try:
            module_spec.loader.exec_module(module)
        except Exception as e:
            raise KbpError("data", "加载 %s 失败：%s: %s" % (path, type(e).__name__, e))
        defaults, mutations = getattr(module, "DEFAULTS", {}) or {}, getattr(module, "MUTATIONS", None)
    if not isinstance(mutations, list) or not mutations:
        raise KbpError("data", "%s 里没有 MUTATIONS（或 JSON 的 mutations）列表" % path)
    out, seen = [], set()
    for i, raw in enumerate(mutations):
        if not isinstance(raw, dict) or not raw.get("id"):
            raise KbpError("data", "第 %d 处变异没有 id" % (i + 1))
        mid = raw["id"]
        if mid in seen:
            raise KbpError("data", "变异 id 重复：%s" % mid)
        seen.add(mid)
        edits = raw.get("edits")
        if edits is None:
            edits = [{k: raw[k] for k in ("file", "old", "new", "count") if k in raw}]
        norm = []
        for e in edits:
            if not e.get("file") or "old" not in e or "new" not in e:
                raise KbpError("data", "%s：每处改动要有 file、old、new" % mid)
            if not e["old"]:
                raise KbpError("data", "%s：old 不能为空" % mid)
            norm.append({"file": e["file"].replace("\\", "/"), "old": e["old"], "new": e["new"],
                         "count": int(e.get("count", 1))})
        m = {"id": mid, "label": raw.get("label") or raw.get("description") or "", "edits": norm}
        for key in ("tests", "cases", "commands"):
            m[key] = list(raw[key]) if key in raw else list(defaults.get(key) or [])
        if not (m["tests"] or m["cases"] or m["commands"]):
            raise KbpError("data", "%s：没有任何检出方（tests、cases、commands 都空）" % mid)
        out.append(m)
    return path, out


# ==================== 哈希 ====================


def tree_hash(root):
    """同 c5/mutate.py：相对路径 + 每个文件内容的 sha256，按目录、文件名排序。另返回 {相对路径: sha256}。"""
    h = hashlib.sha256()
    files = {}
    for base, dirs, names in os.walk(root):
        dirs.sort()
        for name in sorted(names):
            path = os.path.join(base, name)
            rel = os.path.relpath(path, root).replace("\\", "/")
            with open(path, "rb") as f:
                digest = hashlib.sha256(f.read()).digest()
            h.update(rel.encode())
            h.update(digest)
            files[rel] = digest.hex()
    return h.hexdigest(), files


def _sha(data):
    return hashlib.sha256(data).hexdigest()


# ==================== 检出方 ====================


def _subst(value, ctx):
    if isinstance(value, str):
        for key, sub in ctx.items():
            value = value.replace("{%s}" % key, sub)
        return value
    if isinstance(value, list):
        return [_subst(v, ctx) for v in value]
    if isinstance(value, dict):
        return {k: _subst(v, ctx) for k, v in value.items()}
    return value


def _command(item, ctx):
    if isinstance(item, list):
        return {"label": " ".join(item[:3]), "argv": _subst(item, ctx), "cwd": ctx["repo"], "env": {}}
    if isinstance(item, dict) and "kbp" in item:
        argv = [sys.executable, "-X", "utf8", "-I", os.path.join(common.SKILL_DIR, "kbp.py")] + _subst(list(item["kbp"]), ctx)
        return {"label": item.get("label") or "kbp " + " ".join(item["kbp"][:2]), "argv": argv,
                "cwd": _subst(item.get("cwd") or ctx["repo"], ctx), "env": _subst(item.get("env") or {}, ctx)}
    if isinstance(item, dict) and "argv" in item:
        return {"label": item.get("label") or " ".join(item["argv"][:3]), "argv": _subst(list(item["argv"]), ctx),
                "cwd": _subst(item.get("cwd") or ctx["repo"], ctx), "env": _subst(item.get("env") or {}, ctx)}
    raise KbpError("data", "看不懂的命令：%r" % (item,))


def _tail(text, n=300):
    lines = [l.strip() for l in text.strip().splitlines() if l.strip()]
    for line in reversed(lines):
        if not line.startswith("{"):
            continue
        try:
            summary = json.loads(line)
        except ValueError:
            continue
        if isinstance(summary, dict) and summary.get("error"):
            return str(summary["error"])[:n]
        if isinstance(summary, dict) and "failures" in summary:  # kbp corners offline 的摘要
            return "不符 %d 处" % summary["failures"]
        if isinstance(summary, dict) and summary.get("ok"):
            return "ok"
    return (lines[-1] if lines else "")[:n]


def _upper_drive(path):
    """Windows 盘符转大写：cwd 或 vitest.mjs 是小写盘符（`d:\\…`）时，快照里的测试经 `node_modules` 解析到大写盘符的 vitest，
    同一个模块加载成两份，`describe` 读不到 config、整个文件 0 个用例（2026-11-12 P4e 步骤 2 的变异基线踩到）。"""
    return path[0].upper() + path[1:] if len(path) > 1 and path[1] == ":" else path


def run_tests(root, tests, timeout):
    root = _upper_drive(root)
    vitest = _upper_drive(os.path.join(common.REPO_ROOT, "node_modules", "vitest", "vitest.mjs"))
    env = dict(os.environ, KABEGAME_WPE_ROOT=common.wpe_dir())
    env.pop("KBP_TEST", None)
    started = time.time()
    try:
        proc = subprocess.run(["node", vitest, "run"] + list(tests), cwd=root, env=env, capture_output=True,
                              timeout=timeout)
    except subprocess.TimeoutExpired:
        return {"exit": None, "summary": "超时", "failed": [], "seconds": round(time.time() - started, 1), "timeout": True}
    out = (proc.stdout + proc.stderr).decode("utf-8", "replace")
    summary = SUMMARY.findall(out)
    return {"exit": proc.returncode, "summary": summary[-1].strip() if summary else "?",
            "failed": [f.strip() for f in FAILED.findall(out)], "seconds": round(time.time() - started, 1)}


def run_cases(src, data, work, names, timeout):
    started = time.time()
    try:
        result = replay_host.run_cases(src, data, os.path.join(work, "cases"), names, timeout, True)
    except KbpError as e:
        return {"detected": True, "error": str(e), "seconds": round(time.time() - started, 1)}
    cases = {n: {"ok": m.get("ok"), "error": (m.get("error") or "").splitlines()[0][:200] if m.get("error") else None}
             for n, m in result["metas"].items()}
    detected = any(c["error"] or c["ok"] is not True for c in cases.values())
    return {"detected": detected, "cases": cases, "seconds": result["seconds"]}


def run_command(cmd, timeout):
    env = dict(os.environ)
    env.update(cmd["env"])
    started = time.time()
    try:
        proc = subprocess.run(cmd["argv"], cwd=cmd["cwd"], env=env, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return {"exit": None, "detected": True, "tail": "超时", "seconds": round(time.time() - started, 1)}
    except OSError as e:
        return {"exit": None, "detected": True, "tail": "起不来：%s" % e, "seconds": round(time.time() - started, 1)}
    text = (proc.stdout + proc.stderr).decode("utf-8", "replace")
    return {"exit": proc.returncode, "detected": proc.returncode != 0, "tail": _tail(text),
            "seconds": round(time.time() - started, 1)}


def detect(m, ctx, src, root, data, work, timeout, cache=None):
    """跑一处变异（或基线）的全部检出方；返回 {tests, cases, commands, detected_by}。cache 用于基线去重。"""
    os.makedirs(work, exist_ok=True)
    out = {"detected_by": []}
    if m["tests"]:
        key = ("tests",) + tuple(m["tests"])
        r = cache.get(key) if cache is not None else None
        if r is None:
            r = run_tests(root, m["tests"], timeout)
            if cache is not None:
                cache[key] = r
        out["tests"] = r
        if r["exit"] != 0:
            out["detected_by"].append("单测")
    if m["cases"]:
        key = ("cases",) + tuple(m["cases"])
        r = cache.get(key) if cache is not None else None
        if r is None:
            r = run_cases(src, data, work, m["cases"], timeout)
            if cache is not None:
                cache[key] = r
        out["cases"] = r
        if r["detected"]:
            out["detected_by"].append("案例")
    out["commands"] = []
    for item in m["commands"]:
        cmd = _command(item, ctx)
        key = ("cmd", json.dumps(item, sort_keys=True, ensure_ascii=False))
        r = cache.get(key) if cache is not None else None
        if r is None:
            r = run_command(cmd, timeout)
            if cache is not None:
                cache[key] = r
        r = dict(r, label=cmd["label"])
        out["commands"].append(r)
        if r["detected"]:
            out["detected_by"].append(cmd["label"])
    return out


# ==================== 改与还原 ====================


def apply_edits(src, m):
    """按文件分组改坏；返回 {相对路径: [原字节, 改后字节, 改前各 new 的出现次数]}。原文出现次数不对时报错（什么都没写）。"""
    touched = {}
    for e in m["edits"]:
        path = os.path.join(src, *e["file"].split("/"))
        if e["file"] not in touched:
            if not os.path.isfile(path):
                raise KbpError("data", "%s：找不到 %s" % (m["id"], path))
            with open(path, "rb") as f:
                data = f.read()
            touched[e["file"]] = [data, data, []]
        text = touched[e["file"]][1].decode("utf-8")
        found = text.count(e["old"])
        if found != e["count"]:
            raise KbpError("data", "%s：%s 里原文出现 %d 次，应为 %d" % (m["id"], e["file"], found, e["count"]))
        touched[e["file"]][2].append(touched[e["file"]][0].decode("utf-8").count(e["new"]) if e["new"] else None)
        touched[e["file"]][1] = text.replace(e["old"], e["new"]).encode("utf-8")
    for rel, (_, data, _) in touched.items():
        with open(os.path.join(src, *rel.split("/")), "wb") as f:
            f.write(data)
    return touched


def restore(src, m, touched, mode):
    """还原；返回 (全部一致, 说明)。snapshot：按原字节写回。workspace：没被别人改过按原字节写回，否则逐条反向替换。"""
    notes, ok = [], True
    for rel, (original, mutated, before_new) in touched.items():
        path = os.path.join(src, *rel.split("/"))
        with open(path, "rb") as f:
            current = f.read()
        if mode == "snapshot" or current == mutated:
            with open(path, "wb") as f:
                f.write(original)
            with open(path, "rb") as f:
                same = _sha(f.read()) == _sha(original)
            ok &= same
            if not same:
                notes.append("%s 写回后哈希不一致" % rel)
            elif mode == "workspace":
                notes.append("%s 按原字节写回（期间没被改过）" % rel)
            continue
        # workspace，期间被别人改过：只把本处的 new 换回 old
        text = current.decode("utf-8")
        edits = [e for e in m["edits"] if e["file"] == rel]
        for e, base in reversed(list(zip(edits, before_new))):
            if not e["new"]:
                raise KbpError("data", "%s：%s 在跑检出方期间被改过，删除型变异无法反向还原，请人工核对（本处的原文：%r）"
                               % (m["id"], rel, e["old"][:200]))
            if base:
                raise KbpError("data", "%s：%s 改前已有 %d 处 new，反向替换会改错，请人工核对" % (m["id"], rel, base))
            found = text.count(e["new"])
            if found != e["count"]:
                raise KbpError("data", "%s：%s 里 new 出现 %d 次（应为 %d），被并发改动碰到了，请人工核对" % (
                    m["id"], rel, found, e["count"]))
            text = text.replace(e["new"], e["old"])
        with open(path, "wb") as f:
            f.write(text.encode("utf-8"))
        notes.append("%s 期间被别的会话改过，按反向替换还原（别人的改动保留）" % rel)
    return ok, notes


# ==================== 主流程 ====================


def _lines_for(r, indent="    "):
    lines = []
    if "tests" in r:
        t = r["tests"]
        lines.append("%s单测：退出码 %s，%s" % (indent, t["exit"], t["summary"]))
        for name in t["failed"][:12]:
            lines.append("%s  失败：%s" % (indent, name[:180]))
        if len(t["failed"]) > 12:
            lines.append("%s  ……另有 %d 条" % (indent, len(t["failed"]) - 12))
    if "cases" in r:
        c = r["cases"]
        if c.get("error"):
            lines.append("%s案例：%s" % (indent, c["error"][:200]))
        else:
            lines.append("%s案例：%s" % (indent, "，".join(
                "%s %s" % (n, "跑不下去" if v["error"] else ("全部通过" if v["ok"] else "有失败")) for n, v in c["cases"].items())))
    for cmd in r.get("commands", []):
        lines.append("%s%s：退出码 %s%s" % (indent, cmd["label"], cmd["exit"], "；" + cmd["tail"] if cmd["tail"] else ""))
    return lines


def _work_dir(out):
    work = os.path.splitext(out)[0] + "-work"
    if os.path.isdir(work):
        if not os.path.isfile(os.path.join(work, WORK_MARKER)):
            raise KbpError("data", "%s 已存在且不是 kbp mutate 的工作目录，不删" % work)
        shutil.rmtree(work)
    os.makedirs(work)
    with open(os.path.join(work, WORK_MARKER), "w", encoding="utf-8") as f:
        f.write("kbp mutate 的工作目录，可删\n")
    return work


def run(args):
    spec_path, mutations = load_spec(args.spec)
    src = replay_host.check_src(args.src)
    root = os.path.dirname(src)
    if not os.path.isfile(os.path.join(root, "vitest.config.ts")) and any(m["tests"] for m in mutations):
        raise KbpError("src", "%s 没有 vitest.config.ts（单测在 --src 的上一级跑）" % root)
    if args.mode == "snapshot" and not os.path.isfile(os.path.join(root, "snapshot.json")):
        raise KbpError("kbp", "快照模式要求 --src 是 kbp snapshot export 的快照（%s 没有 snapshot.json）；在工作区里改用 "
                              "--mode workspace（反向替换还原）" % root)
    wanted = list(args.ids or [])
    unknown = [i for i in wanted if i not in {m["id"] for m in mutations}]
    if unknown:
        raise KbpError("kbp", "清单里没有 %s" % "、".join(unknown))
    chosen = [m for m in mutations if not wanted or m["id"] in wanted]
    default_out = os.path.join(os.path.dirname(spec_path), "out", "mutate.txt" if not wanted else "mutate-partial.txt")
    out = os.path.abspath(args.out or default_out)
    if (os.path.exists(out) or os.path.exists(out + ".json")) and not args.overwrite:
        raise KbpError("data", "结果已存在（要覆盖加 --overwrite）：%s" % out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    work = _work_dir(out)
    data = common.data_dir(args.data)
    ctx = {"src": src, "root": root, "data": data, "repo": common.REPO_ROOT, "python": sys.executable,
           "kbp": os.path.join(common.SKILL_DIR, "kbp.py")}
    started = time.time()
    before_tree, before_files = tree_hash(src)
    lines = ["%s 树哈希（开始）：%s" % (src, before_tree), "模式：%s；清单 %s（%d 处，本次 %d 处）" % (
        args.mode, spec_path, len(mutations), len(chosen))]
    report = {"src": src, "mode": args.mode, "spec": spec_path, "tree_before": before_tree, "baseline": None,
              "mutations": []}

    if not args.no_baseline:
        cache = {}
        base_rows = []
        base_ctx = dict(ctx, id="baseline", work=os.path.join(work, "baseline"))
        for m in chosen:
            base_rows.append(detect(m, base_ctx, src, root, data, base_ctx["work"], args.timeout, cache))
        bad = sorted({d for r in base_rows for d in r["detected_by"]})
        base_detect = bad
        report["baseline"] = {"failed": bad, "seconds": round(sum(v.get("seconds", 0) for v in cache.values()), 1)}
        lines.append("基线（没改的源码）：%s" % ("全部通过" if not bad else "这些检出方在基线上就失败：%s（它们的「检出」不可信）"
                                                                   % "、".join(bad)))
        for key, value in cache.items():
            if key[0] == "tests":
                lines.append("    单测 %s：退出码 %s，%s" % (" ".join(t.split("/")[-1] for t in key[1:]), value["exit"],
                                                       value["summary"]))
            elif key[0] == "cases":
                lines.append("    案例 %s：%s" % (" ".join(key[1:]), "检出（有失败或跑不下去）" if value["detected"] else "全部通过"))
            else:
                label = _command(json.loads(key[1]), base_ctx)["label"]
                lines.append("    %s：退出码 %s%s" % (label, value["exit"], "；" + value["tail"] if value["tail"] else ""))
    else:
        base_detect = []

    all_ok = True
    for m in chosen:
        mwork = os.path.join(work, m["id"])
        c = dict(ctx, id=m["id"], work=mwork)
        t0 = time.time()
        touched = {}
        result = {}
        error = None
        try:
            touched = apply_edits(src, m)
            result = detect(m, c, src, root, data, mwork, args.timeout)
        except KbpError as e:
            error = str(e)
        finally:
            # 原文核对不过时 apply_edits 什么都没写（先全部核对再写），没有要还原的
            restored, notes = restore(src, m, touched, args.mode) if touched else (True, [])
        detected = bool(result.get("detected_by"))
        unreliable = [d for d in result.get("detected_by", []) if d in base_detect]
        row = {"id": m["id"], "label": m["label"], "detected": detected, "detected_by": result.get("detected_by", []),
               "unreliable": unreliable, "restored": restored, "notes": notes, "error": error,
               "edits": [{"file": e["file"], "count": e["count"]} for e in m["edits"]],
               "result": result, "seconds": round(time.time() - t0, 1)}
        report["mutations"].append(row)
        ok = detected and restored and not error and not unreliable
        all_ok &= ok
        head = "== %s：%s → %s；还原 %s" % (m["id"], m["label"], "检出" if detected else ("出错" if error else "未检出"),
                                          "一致" if restored else "不一致！")
        block = [head]
        for e in m["edits"]:
            block.append("    改 %s（%d 处）" % (e["file"], e["count"]))
        if error:
            block.append("    出错：%s" % error)
        block.append("    检出方：%s%s" % ("、".join(result.get("detected_by", [])) or "无",
                                       "（基线就失败：%s）" % "、".join(unreliable) if unreliable else ""))
        block += _lines_for(result)
        block += ["    %s" % n for n in notes if args.mode == "workspace"]
        lines += block
        if not args.quiet:
            sys.stderr.write("\n".join(block) + "\n")
            sys.stderr.flush()
    after_tree, after_files = tree_hash(src)
    changed = sorted(k for k in set(before_files) | set(after_files) if before_files.get(k) != after_files.get(k))
    report.update(tree_after=after_tree, tree_same=after_tree == before_tree, tree_changed=changed,
                  seconds=round(time.time() - started, 1))
    lines.append("%s 树哈希（结束）：%s（%s）" % (src, after_tree, "与开始相同" if after_tree == before_tree else
                                              "与开始不同！变了的文件：%s" % "、".join(changed[:10])))
    tree_ok = after_tree == before_tree or args.mode == "workspace"
    if args.mode == "workspace" and after_tree != before_tree:
        lines.append("  （工作区模式：树哈希不同可能是并行会话的改动；本工具改过的文件都已按上面逐个核对）")
    detected = [r["id"] for r in report["mutations"] if r["detected"]]
    missed = [r["id"] for r in report["mutations"] if not r["detected"]]
    all_ok = all_ok and tree_ok
    lines.append("全部检出、全部还原" if all_ok else "有未检出、出错、基线失败或未还原的变异：%s" % "、".join(
        r["id"] for r in report["mutations"] if not (r["detected"] and r["restored"] and not r["error"] and not r["unreliable"]))
                 or "树哈希不同")
    report.update(all_ok=all_ok, detected=detected, missed=missed)
    with open(out, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines) + "\n")
    common.write_json(out + ".json", report, indent=1)
    return {"ok": True, "out": out, "mode": args.mode, "src": src, "mutations": len(chosen), "detected": len(detected),
            "missed": missed, "restored": all(r["restored"] for r in report["mutations"]),
            "tree_same": after_tree == before_tree, "all_ok": all_ok, "seconds": report["seconds"]}


def cli(args):
    return run(args)
