"""语料（kbp-tools 点 5）：`kbp corpus scan`（拉起 node … vitest 跑 ts/corpus.test.ts）、`kbp corpus diff`（比两次结果），以及
`kbp regress --corpus` 用的逐场景比较。

- scan：照 `ignore/p4/c5/corpus.test.ts`，对默认工程与创意工坊工程跑 `compileScene(exhaustive)`，行格式
  `{ sample, unsupported[], …附加字段 }`，出错 `{ sample, error }`。附加字段是插件（`--extra`，可重复）：
  `modules:<category:name,…|@b3|@b4>`、`controlpoints[:norenderer]`、`sheets`。
- diff：照 `b5/diff_corpus.py`、`c5/corpus_diff.py` 的通用部分：场景数与出错、干净场景增减、每个键去掉 / 新增了哪些场景、
  变化的场景逐张列出之后还剩的键，加上「去掉某些键后还剩什么」（`b6/corpus_colorn.py`，`--without`）；`--explain <模块.py>` 挂
  各步自己的解释脚本（模块里的 `explain(before, after, diff) -> [行]`，before / after 是 {sample: 行}）。
"""

import collections
import importlib.util
import json
import os

from . import common
from .common import KbpError
from . import replay_host

TEST = "corpus.test.ts"


# ==================== scan ====================


def parse_extras(values):
    """--extra 的值：`名字[:参数,参数…]`。modules 的参数是 `category:name`（含冒号），所以只按第一个冒号切。"""
    out = []
    for value in values or []:
        name, _, rest = value.partition(":")
        name = name.strip()
        if name not in ("modules", "controlpoints", "sheets"):
            raise KbpError("kbp", "没有附加字段插件 %r（有 modules、controlpoints、sheets）" % name)
        args = [a.strip() for a in rest.split(",") if a.strip()] if rest else []
        if name == "modules" and not args:
            raise KbpError("kbp", "modules 要给名单：modules:category:name,…（或预置 @b3、@b4）")
        out.append({"name": name, "args": args})
    return out


def run_scan(src, out_file, extras=(), only=None, dirs=None, timeout=3600, quiet=True, label=""):
    """拉起一次 vitest 跑语料扫描；返回 {exit, seconds, log, rows}。日志写 <out_file>.log。"""
    os.makedirs(os.path.dirname(out_file) or ".", exist_ok=True)
    log_path = out_file + ".log"
    if os.path.exists(out_file):
        os.remove(out_file)
    env = {
        "KBP_TEST": TEST,
        "KBP_SRC": src,
        "KBP_CORPUS_OUT": out_file,
        "KBP_CORPUS_EXTRA": json.dumps(list(extras), ensure_ascii=False),
        "KABEGAME_WPE_ROOT": common.wpe_dir(),
    }
    if only:
        env["KBP_CORPUS_ONLY"] = ",".join(only)
    if dirs:
        env["KBP_CORPUS_DIRS"] = json.dumps(dirs, ensure_ascii=False)
    result = replay_host.run_vitest(env, log_path, timeout, quiet, label)
    if not os.path.isfile(out_file):
        raise KbpError("src", "语料扫描没写出结果（vitest 退出码 %s，日志 %s）" % (result["exit"], log_path))
    rows = common.read_json(out_file)
    result["rows"] = rows
    return result


def scan(args):
    src = replay_host.check_src(args.src)
    out = os.path.abspath(args.out)
    if os.path.exists(out) and not args.overwrite:
        raise KbpError("data", "结果已存在（要覆盖加 --overwrite）：%s" % out)
    extras = parse_extras(args.extra)
    dirs = []
    for item in args.project or []:
        path = os.path.abspath(item)
        if not os.path.isfile(os.path.join(path, "project.json")):
            raise KbpError("data", "--project 不是工程目录（没有 project.json）：%s" % path)
        dirs.append([os.path.basename(path.rstrip("\\/")), path])
    only = args.only.split(",") if args.only else None
    result = run_scan(src, out, extras, only, dirs, args.timeout, args.quiet)
    rows = result["rows"]
    errors = [r["sample"] for r in rows if "error" in r]
    clean = [r["sample"] for r in rows if "error" not in r and not r.get("unsupported")]
    return {"ok": True, "src": src, "out": out, "samples": len(rows), "errors": len(errors), "clean": len(clean),
            "extra": [e["name"] for e in extras], "seconds": result["seconds"], "log": result["log"]}


# ==================== diff ====================


def load_rows(path):
    rows = common.read_json(path)
    if isinstance(rows, dict) and "rows" in rows:
        rows = rows["rows"]
    if not isinstance(rows, list):
        raise KbpError("data", "%s 不是语料结果（应为行数组）" % path)
    table = collections.OrderedDict()
    for row in rows:
        if not isinstance(row, dict) or "sample" not in row:
            raise KbpError("data", "%s 里有不是 {sample, …} 的行" % path)
        table[row["sample"]] = row
    return table


def compare(before, after):
    """两次语料的通用比较；返回可 JSON 化的 dict。before / after 是 {sample: 行}。"""
    err_b = {s: r["error"] for s, r in before.items() if "error" in r}
    err_a = {s: r["error"] for s, r in after.items() if "error" in r}
    ok_b = {s: set(r.get("unsupported") or []) for s, r in before.items() if "error" not in r}
    ok_a = {s: set(r.get("unsupported") or []) for s, r in after.items() if "error" not in r}
    clean_b = sorted(s for s, v in ok_b.items() if not v)
    clean_a = sorted(s for s, v in ok_a.items() if not v)
    removed = collections.defaultdict(list)
    added = collections.defaultdict(list)
    changed = []
    for s in sorted(ok_b):
        if s not in ok_a:
            continue
        gone, new = ok_b[s] - ok_a[s], ok_a[s] - ok_b[s]
        for key in gone:
            removed[key].append(s)
        for key in new:
            added[key].append(s)
        if gone or new:
            changed.append({"sample": s, "removed": sorted(gone), "added": sorted(new), "after": sorted(ok_a[s])})
    order = lambda table: sorted(table, key=lambda k: (-len(table[k]), k))  # noqa: E731
    # 去掉的键所在、但仍不干净的场景：之后剩下的键按场景数（c5/corpus_diff.py 的「去掉了…但仍不干净」）
    touched = sorted({s for k in removed for s in removed[k]} - set(clean_a))
    rest = collections.Counter()
    for s in touched:
        rest.update(ok_a[s])
    return {
        "samples": [len(before), len(after)],
        "only_before": sorted(set(before) - set(after)),
        "only_after": sorted(set(after) - set(before)),
        "errors": [len(err_b), len(err_a)],
        "new_errors": {s: err_a[s] for s in sorted(set(err_a) - set(err_b))},
        "fixed_errors": sorted(set(err_b) - set(err_a)),
        "clean": [len(clean_b), len(clean_a)],
        "clean_after": clean_a,
        "clean_gained": sorted(set(clean_a) - set(clean_b)),
        "clean_lost": sorted(set(clean_b) - set(clean_a)),
        "removed": {k: removed[k] for k in order(removed)},
        "added": {k: added[k] for k in order(added)},
        "changed": changed,
        "remaining": {"samples": touched, "keys": dict(sorted(rest.items(), key=lambda kv: (-kv[1], kv[0])))},
    }


def without(table, keys):
    """`b6/corpus_colorn.py`：带这些键的场景，去掉它们之后还剩什么。"""
    keys = set(keys)
    hit = [(s, r) for s, r in table.items() if "error" not in r and keys & set(r.get("unsupported") or [])]
    rest = collections.Counter()
    only, near = [], []
    for s, r in hit:
        left = [k for k in r.get("unsupported") or [] if k not in keys]
        if not left:
            only.append(s)
        elif len(left) <= 2:
            near.append([s, left])
        rest.update(left)
    near.sort(key=lambda x: len(x[1]))
    return {"keys": sorted(keys), "hit": len(hit), "only": only, "near": near, "rest": dict(rest.most_common())}


def text_lines(diff, extra=None):
    lines = []
    n_b, n_a = diff["samples"]
    lines.append("场景数 %d / %d，出错 %d / %d" % (n_b, n_a, diff["errors"][0], diff["errors"][1]))
    for s, e in diff["new_errors"].items():
        lines.append("  新出错 %s：%s" % (s, e[:300]))
    if diff["fixed_errors"]:
        lines.append("  不再出错：%s" % " ".join(diff["fixed_errors"]))
    if diff["only_before"] or diff["only_after"]:
        lines.append("  只在前：%s；只在后：%s" % (diff["only_before"], diff["only_after"]))
    lines.append("干净 %d → %d；新增 %s；掉出 %s" % (diff["clean"][0], diff["clean"][1], diff["clean_gained"] or "无",
                                              diff["clean_lost"] or "无"))
    lines.append("")
    lines.append("== 去掉的键")
    for key, samples in diff["removed"].items():
        lines.append("  %s：%d 张 %s" % (key, len(samples), " ".join(samples)))
    if not diff["removed"]:
        lines.append("  无")
    lines.append("== 新增的键")
    for key, samples in diff["added"].items():
        lines.append("  %s：%d 张 %s" % (key, len(samples), " ".join(samples)))
    if not diff["added"]:
        lines.append("  无")
    lines.append("")
    lines.append("== 变化的场景 %d 张：去掉 / 新增 / 之后还剩" % len(diff["changed"]))
    for c in diff["changed"]:
        lines.append("  %s：去掉 %s 新增 %s；之后 %d 项 %s%s" % (
            c["sample"], c["removed"], c["added"], len(c["after"]), " ".join(c["after"][:6]),
            " …" if len(c["after"]) > 6 else ""))
    lines.append("")
    rest = diff["remaining"]
    lines.append("== 去掉了键但仍不干净的场景 %d 张，剩下的键按场景数（前 14）" % len(rest["samples"]))
    lines.append("  " + "，".join("%s %d" % kv for kv in list(rest["keys"].items())[:14]))
    if extra:
        lines.append("")
        lines.append("== 带 %s 的场景（之后的结果）：%d 张，去掉后干净 %d 张" % (" ".join(extra["keys"]), extra["hit"],
                                                                 len(extra["only"])))
        lines.append("  只差这些键：%s" % (extra["only"] or "无"))
        lines.append("  去掉后只差 1–2 项：")
        for s, left in extra["near"]:
            lines.append("    %s %s" % (s, left))
        lines.append("  剩余键（前 30）：")
        for k, n in list(extra["rest"].items())[:30]:
            lines.append("    %d %s" % (n, k))
    return lines


def _load_explain(path):
    path = os.path.abspath(path)
    if not os.path.isfile(path):
        raise KbpError("data", "找不到解释脚本 %s" % path)
    spec = importlib.util.spec_from_file_location("kbp_corpus_explain", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if not callable(getattr(module, "explain", None)):
        raise KbpError("data", "%s 里没有 explain(before, after, diff) 函数" % path)
    return module


def diff_cmd(args):
    before, after = load_rows(args.before), load_rows(args.after)
    result = compare(before, after)
    extra = without(after, args.without.split(",")) if args.without else None
    lines = text_lines(result, extra)
    explained = None
    if args.explain:
        module = _load_explain(args.explain)
        try:
            explained = list(module.explain(before, after, result) or [])
        except Exception as e:  # 解释脚本自己的错
            raise KbpError("data", "解释脚本 %s 出错：%s: %s" % (args.explain, type(e).__name__, e))
        lines += [""] + [str(l) for l in explained]
    out = os.path.abspath(args.out) if args.out else None
    if out:
        if (os.path.exists(out) or os.path.exists(out + ".json")) and not args.overwrite:
            raise KbpError("data", "结果已存在（要覆盖加 --overwrite）：%s" % out)
        os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
        with open(out, "w", encoding="utf-8", newline="\n") as f:
            f.write("\n".join(lines) + "\n")
        common.write_json(out + ".json", {"before": os.path.abspath(args.before), "after": os.path.abspath(args.after),
                                          "diff": result, "without": extra, "explain": explained}, indent=1)
    summary = {"ok": True, "samples": result["samples"], "errors": result["errors"], "clean": result["clean"],
               "clean_gained": result["clean_gained"], "clean_lost": result["clean_lost"],
               "removed": {k: len(v) for k, v in result["removed"].items()},
               "added": {k: len(v) for k, v in result["added"].items()}, "changed": len(result["changed"])}
    if out:
        summary["out"] = out
    else:
        summary["text"] = lines
    return summary


# ==================== regress --corpus ====================


def regress_rows(rows_a, rows_b):
    """两份源码上的语料逐场景比：unsupported 集合与附加字段（整行解析后比）。返回 (same, 报告)。"""
    a, b = collections.OrderedDict((r["sample"], r) for r in rows_a), collections.OrderedDict((r["sample"], r) for r in rows_b)
    affected = []
    for s in list(a) + [s for s in b if s not in a]:
        ra, rb = a.get(s), b.get(s)
        if ra == rb:
            continue
        item = {"sample": s}
        if ra is None or rb is None:
            item["missing"] = "a" if ra is None else "b"
        else:
            ua, ub = set(ra.get("unsupported") or []), set(rb.get("unsupported") or [])
            if ua != ub:
                item["only_a"], item["only_b"] = sorted(ua - ub), sorted(ub - ua)
            if ("error" in ra) != ("error" in rb) or ra.get("error") != rb.get("error"):
                item["error"] = [ra.get("error"), rb.get("error")]
            fields = sorted(k for k in set(ra) | set(rb) if k not in ("sample", "unsupported", "error") and ra.get(k) != rb.get(k))
            if fields:
                item["fields"] = fields
        affected.append(item)
    diff = compare(a, b)
    return not affected, {"samples": [len(a), len(b)], "affected": affected,
                          "removed": {k: v for k, v in diff["removed"].items()},
                          "added": {k: v for k, v in diff["added"].items()},
                          "clean": diff["clean"], "errors": diff["errors"]}


def cli(args):
    if args.action == "scan":
        return scan(args)
    if args.action == "diff":
        return diff_cmd(args)
    raise KbpError("kbp", "未知的动作 %s" % args.action)
