"""kbp-tools 第 2 批的验收自测：gen、snapshot、replay、regress。

    python -X utf8 -I .claude/skills/kbp-tools/tests/accept2.py [--out ignore/kbp/accept2] [--only gen,track,snapshot,replay,regress,c5]

只读：ignore/p4（proj、tracks、out、各步骤目录）、apps/。全部输出写 --out（缺省 ignore/kbp/accept2）：
- gen：把 ignore/p4/gen.py、gen_b.py、gen_c.py、gen_d.py 拷到 <out>/gen/，只改 import 行（改成 `from kbp import gen [as gen_b | gen_c]`），
  texsrc 拷到 <out>/texsrc，`kbp gen` 重新生成全部 p4b*、p4c*、p4d* 工程到 <out>/proj/，和 ignore/p4/proj/ 逐文件逐字节比（不比 WPE
  写进去的 shaders/blobsSM40）。另做「替换模式」：把 gen_b / gen_c 拷贝里的通用函数换成库的，生成到 <out>/proj-lib/ 再比一遍
  （库的 write_project 处理 meta、object_meta、pointer=False 的路径）。
- track：带 `track: "draws"` 的小例子（<out>/defs/trackdemo.py）：只看 `kbp rdc` 的认法选择（不跑 qrenderdoc）；再把 p4d-rope 以
  track: draws 生成到 <out>/track/proj，在 A:\\p4b\\p4d-rope-fps60 上跑 `kbp rdc track`（不加 --draws），和 ignore/p4/tracks 的
  rd-p4d-rope-fps60.json 逐字节比；--points 覆盖时认法是 points。
- snapshot：export HEAD（tsc 0 error、vitest 全过、数用例）、export WORKTREE；在 HEAD 副本里改一行，diff 出补丁，`git apply --check`。
- replay：旧回放脚本拷到 <out>/old/（只改输出路径；b3、b4 另把已算好的统计写进 JSON），和新案例在同一份冻结快照上各跑一遍，
  逐系统比最大差、包络、差/限、超限数、是否通过等（数值逐位）。P4c 及以前用 HEAD 快照，d1 用 WORKTREE 快照。
- c5：HEAD 快照上的新案例结果和 ignore/p4/c5/out 里同名回放（*-head*）的记录比。
- regress：同一份快照传两次（全部相同）；拷一份快照、在模拟器里改一个常数，和原快照比（报出不同的案例与第一处不同）。
结果写 <out>/report.json，每项一行打到 stdout。
"""

import argparse
import hashlib
import json
import math
import os
import re
import shutil
import struct
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

sys.path.insert(0, SKILL)
import kbp as _kbp  # noqa: E402  （充当包 kbp）

_kbp._register()
from kbp import gen as libgen  # noqa: E402


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
    return proc.returncode, summary, proc.stderr.decode("utf-8", "replace")


def same_number(a, b):
    return struct.pack("<d", float(a)) == struct.pack("<d", float(b)) or (math.isnan(a) and math.isnan(b))


def deep_diff(a, b, path="$", out=None, limit=20):
    """逐项比较两份解析后的 JSON（数值逐位）；返回 {"items": [(路径, 新, 旧)], "count": n}。"""
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
        if not same_number(a, b):
            add(path, a, b)
    elif isinstance(a, dict) and isinstance(b, dict):
        for k in list(a.keys()) + [k for k in b.keys() if k not in a]:
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
        return json.loads(re.sub(r"(?<=[\[,:\s])-?(?:NaN|Infinity)(?=\s*[,\]}])", "null", f.read()))


def sha(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def tree_files(root, skip=None):
    out = {}
    for base, dirs, names in os.walk(root):
        dirs.sort()
        for name in sorted(names):
            path = os.path.join(base, name)
            rel = os.path.relpath(path, root).replace("\\", "/")
            if skip and skip(rel):
                continue
            out[rel] = path
    return out


def compare_trees(new_root, old_root, skip=None):
    """逐文件逐字节比；返回 (同, 不同, 只在新, 只在旧)。"""
    a = tree_files(new_root, skip)
    b = tree_files(old_root, skip)
    same, differ = [], []
    for rel in sorted(set(a) & set(b)):
        with open(a[rel], "rb") as f1, open(b[rel], "rb") as f2:
            (same if f1.read() == f2.read() else differ).append(rel)
    return same, differ, sorted(set(a) - set(b)), sorted(set(b) - set(a))


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


# ==================== gen ====================

GEN_IMPORTS = {
    # 文件: [(原行, 新行)]——只改 import 行
    "gen.py": [],
    "gen_b.py": [("import gen  # noqa: E402", "from kbp import gen  # noqa: E402  （kbp-tools 第 2 批验收：改用库）")],
    "gen_c.py": [("import gen  # noqa: E402", "from kbp import gen  # noqa: E402  （kbp-tools 第 2 批验收：改用库）"),
                 ("import gen_b  # noqa: E402", "from kbp import gen as gen_b  # noqa: E402")],
    "gen_d.py": [("import gen  # noqa: E402", "from kbp import gen  # noqa: E402  （kbp-tools 第 2 批验收：改用库）"),
                 ("import gen_b  # noqa: E402", "from kbp import gen as gen_b  # noqa: E402"),
                 ("import gen_c  # noqa: E402", "from kbp import gen as gen_c  # noqa: E402")],
}
GEN_PROJECTS = {"gen_b": "p4b", "gen_c": "p4c", "gen_d": "p4d"}
BLOBS = re.compile(r"(^|/)shaders/blobsSM40(/|$)")


def copy_generators(out_dir):
    target = os.path.join(out_dir, "gen")
    rmtree_own(target, out_dir)
    os.makedirs(target)
    changed = {}
    for name, edits in GEN_IMPORTS.items():
        with open(os.path.join(P4, name), encoding="utf-8") as f:
            text = f.read()
        lines = text.split("\n")
        count = 0
        for old, new in edits:
            hits = [i for i, l in enumerate(lines) if l == old]
            if len(hits) != 1:
                raise RuntimeError("%s 里 %r 出现 %d 次" % (name, old, len(hits)))
            lines[hits[0]] = new
            count += 1
        write_text(os.path.join(target, name), "\n".join(lines))
        changed[name] = count
    # texsrc 属于数据目录（从创意工坊导出的纹理不入库）
    tex = os.path.join(out_dir, "texsrc")
    rmtree_own(tex, out_dir)
    shutil.copytree(os.path.join(P4, "texsrc"), tex)
    return target, changed


def compare_projects(out_proj, names, report, kind):
    for name in names:
        new_root = os.path.join(out_proj, name)
        old_root = os.path.join(P4, "proj", name)
        row = {"kind": kind, "project": name}
        if not os.path.isdir(new_root):
            row.update(ok=False, error="没有生成")
        else:
            same, differ, only_new, only_old = compare_trees(new_root, old_root, skip=lambda rel: BLOBS.search(rel))
            row.update(ok=not (differ or only_new or only_old), files=len(same), differ=differ, only_new=only_new,
                       only_old=only_old)
        report.append(row)
        print("%-6s %-14s %s" % (kind, name, "ok %d 个文件" % row.get("files", 0) if row["ok"] else row))


def check_gen(out_dir, report):
    defs, changed = copy_generators(out_dir)
    report.append({"kind": "gen", "check": "import 行", "ok": True, "changed": changed})
    proj = os.path.join(out_dir, "proj")
    rmtree_own(proj, out_dir)
    expected = {}
    for module, prefix in GEN_PROJECTS.items():
        code, summary, err = kbp(["gen", module, "--data", out_dir, "--defs", defs], timeout=600)
        ok = code == 0 and summary and summary.get("ok")
        report.append({"kind": "gen", "check": "kbp gen %s" % module, "ok": bool(ok), "summary": summary,
                       "stderr": err[-2000:] if not ok else None})
        print("gen    kbp gen %s → %s" % (module, summary))
        if ok:
            expected[module] = summary["projects"]
    names = sorted(n for ps in expected.values() for n in ps)
    old = sorted(n for n in os.listdir(os.path.join(P4, "proj")) if re.match(r"p4[bcd]", n))
    missing = [n for n in old if n not in names]
    # 只核对这几个生成器自己声明的工程都生成了、且在 proj/ 里有对应；proj/ 里由别的生成器建的工程（p4b-vec 由 vec/gen_vec.py、
    # 并行会话后来加的 d3/gen_around.py 等）只列出来，不算失败
    absent = [n for n in names if n not in old]
    report.append({"kind": "gen", "check": "覆盖", "ok": bool(names) and not absent, "generated": len(names),
                   "not_generated": missing, "absent_in_proj": absent,
                   "note": "not_generated 是 proj/ 里由别的生成器建的工程（如 p4b-vec 由 ignore/p4/vec/gen_vec.py 生成），不归 gen_b/c/d"})
    compare_projects(proj, names, report, "gen")
    # 第二次不带 --overwrite 应被拒绝
    code, summary, err = kbp(["gen", "gen_c", "p4c-cp", "--data", out_dir, "--defs", defs])
    report.append({"kind": "gen", "check": "拒绝覆盖", "ok": code != 0 and "已存在" in (summary or {}).get("error", ""),
                   "summary": summary})

    # 替换模式：gen_b / gen_c 拷贝里的通用函数换成库的（实验定义不动），生成到 proj-lib/
    proj_lib = os.path.join(out_dir, "proj-lib")
    rmtree_own(proj_lib, out_dir)
    driver = os.path.join(out_dir, "defs-lib")
    rmtree_own(driver, out_dir)
    write_text(os.path.join(driver, "replaced.py"), REPLACED_DEFS % {"gen": defs.replace("\\", "/")})
    code, summary, err = kbp(["gen", "replaced", "--data", out_dir, "--defs", driver, "--out", proj_lib], timeout=600)
    ok = code == 0 and summary and summary.get("ok")
    report.append({"kind": "gen-lib", "check": "kbp gen replaced", "ok": bool(ok), "summary": summary,
                   "stderr": err[-2000:] if not ok else None})
    print("gen    替换模式 → %s" % summary)
    if ok:
        compare_projects(proj_lib, [n for n in summary["projects"]], report, "genlib")


# 替换模式的实验定义：载入 gen_b / gen_c 的拷贝，把它们自己定义的通用函数换成库里的同名函数，再调原来的 PROJECTS。
# gen_b 的 write_project 是不带指针的 CLK（pointer=False），gen_c 的是带指针的（库的缺省）。写到 --out（库的 write_project 认它）。
REPLACED_DEFS = r'''"""替换模式（accept2）：gen_b / gen_c 的实验定义原样，通用函数用库的。"""
import functools
import importlib.util
import os
import sys

from kbp import gen

GEN_DIR = %(gen)r
sys.path.insert(0, GEN_DIR)


def _load(name):
    spec = importlib.util.spec_from_file_location("replaced_" + name, os.path.join(GEN_DIR, name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


gen_b = _load("gen_b")
gen_c = _load("gen_c")
COMMON = ["GENERAL", "fixed", "system", "particle_material", "image_layer", "image_assets", "TEX_FLAGS", "TEX_IMAGE_W",
          "TEX_IMAGE_H", "at", "ring", "with_cps", "CENTER", "MOVE_ORIGIN", "SPIN_ANGLES", "CLK_PTR_VERT"]
replaced = {}
for module, write_project in ((gen_b, functools.partial(gen.write_project, pointer=False)), (gen_c, gen.write_project)):
    names = [n for n in COMMON if n in vars(module)]
    for n in names:
        setattr(module, n, getattr(gen, n))
    module.write_project = write_project
    replaced[module.__name__] = names + ["write_project"]
# gen_c 自己的实验函数还经 gen_b.system / gen_b.particle_material 调：gen_b 已换成库的
gen_c.gen_b = gen_b
sys.stderr.write("替换：%%r\n" %% (replaced,))
PROJECTS = {**gen_b.PROJECTS, **gen_c.PROJECTS}
'''


# ==================== track: "draws" ====================

ROPE_CAPTURES = r"A:\p4b\p4d-rope-fps60"
TRACK_DEFS = r'''"""accept2：带 track: "draws" 的工程。kbp-mini-rope 是一个绳系统的小工程；p4d-rope 用 gen_d 拷贝的定义原样生成、只多 track。"""
import importlib.util
import os

from kbp import gen

GEN_DIR = %(gen)r


def mini_rope():
    rope = gen.system("255 0 0", "0 0 0", velocity="200 0 0", lifetime=1.6, rate=4, maxcount=8,
                      renderer=[{"id": 40, "name": "rope", "subdivision": 3}])
    gen.write_project("kbp-mini-rope", "kbp-mini-rope", {"R": rope}, overrides={"R": gen.at("200 540 0")},
                      track="draws")


def p4d_rope():
    spec = importlib.util.spec_from_file_location("trackdemo_gen_d", os.path.join(GEN_DIR, "gen_d.py"))
    gen_d = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(gen_d)
    original = gen.write_project
    gen.write_project = lambda *args, **kwargs: original(*args, track="draws", **kwargs)
    try:
        gen_d.p4d_rope()  # gen_d 拷贝里的 gen_c 就是库
    finally:
        gen.write_project = original


PROJECTS = {"kbp-mini-rope": mini_rope, "p4d-rope": p4d_rope}
'''


class _Args(object):
    def __init__(self, **kw):
        self.__dict__.update(dict(data=None, project=None, draws=False, points=False, out=None, limit=20000), **kw)


def check_track(out_dir, report):
    from kbp import rdc_host

    defs = os.path.join(out_dir, "defs")
    rmtree_own(defs, out_dir)
    write_text(os.path.join(defs, "trackdemo.py"), TRACK_DEFS % {"gen": os.path.join(out_dir, "gen").replace("\\", "/")})
    data = os.path.join(out_dir, "track")
    rmtree_own(data, out_dir)
    code, summary, err = kbp(["gen", "trackdemo", "--data", data, "--defs", defs])
    ok = code == 0 and summary and summary.get("ok")
    report.append({"kind": "track", "check": "kbp gen trackdemo", "ok": bool(ok), "summary": summary,
                   "stderr": err[-2000:] if not ok else None})
    if not ok:
        print("track  生成失败", summary, err[-800:])
        return
    proj = os.path.join(data, "proj")
    mini_meta = load_json(os.path.join(proj, "kbp-mini-rope", "kbp-meta.json"))
    rope_meta = load_json(os.path.join(proj, "p4d-rope", "kbp-meta.json"))
    old_meta = load_json(os.path.join(P4, "proj", "p4d-rope", "kbp-meta.json"))
    same, differ, only_new, only_old = compare_trees(os.path.join(proj, "p4d-rope"), os.path.join(P4, "proj", "p4d-rope"),
                                                     skip=lambda rel: BLOBS.search(rel))
    expect = dict(old_meta, track="draws")
    row = {"kind": "track", "check": "meta 只多 track", "ok": mini_meta.get("track") == "draws"
           and rope_meta == expect and list(rope_meta)[-1] == "track" and differ == ["kbp-meta.json"]
           and not only_new and not only_old, "differ": differ}
    report.append(row)
    print("track  meta 只多 track：%s" % row["ok"])
    # 认法选择（只算 job，不跑 qrenderdoc）
    cases = [
        ("kbp-mini-rope", {}, ("draws", "meta")),
        ("kbp-mini-rope", {"points": True}, ("points", "flag")),
        ("p4d-rope", {}, ("draws", "meta")),
        (os.path.join(P4, "proj", "p4d-rope"), {}, ("points", "auto")),
        (os.path.join(P4, "proj", "p4d-rope"), {"draws": True}, ("draws", "flag")),
        (os.path.join(P4, "proj", "p4a2"), {}, ("legacy", "auto")),
    ]
    for project, flags, want in cases:
        args = _Args(folder=ROPE_CAPTURES, tag="demo-fps60", data=data, project=project, **flags)
        job, _, _ = rdc_host.plan("track", args)
        got = (job["params"]["mode"], job["mode_source"])
        report.append({"kind": "track", "check": "认法 %s %s" % (os.path.basename(project), flags), "ok": got == want,
                       "got": got, "want": want})
        print("track  认法 %-14s %-18s → %s（应为 %s）" % (os.path.basename(project), flags, got, want))
    # 真跑：p4d-rope 带 track: draws，不加 --draws，输出和 ignore/p4/tracks 的 --draws 真值逐字节相同
    target = os.path.join(data, "rd-p4d-rope-fps60.json")
    code, summary, err = kbp(["rdc", "track", ROPE_CAPTURES, "p4d-rope-fps60", "--data", data, "--out", target,
                              "--quiet"], timeout=1800)
    truth = os.path.join(P4, "tracks", "rd-p4d-rope-fps60.json")
    same = code == 0 and os.path.isfile(target) and sha(target) == sha(truth)
    report.append({"kind": "track", "check": "rdc track 自动 draws", "ok": bool(same and summary.get("mode") == "draws"
                   and summary.get("mode_source") == "meta"), "summary": summary,
                   "stderr": err[-2000:] if code else None})
    print("track  rdc track（meta 定 draws）：mode %s/%s，和真值逐字节相同 %s，%s s" % (
        (summary or {}).get("mode"), (summary or {}).get("mode_source"), same, (summary or {}).get("seconds")))


# ==================== snapshot ====================


def check_snapshot(out_dir, report):
    snap = os.path.join(out_dir, "snap")
    for name, rev, vitest in (("head", "HEAD", True), ("ws", "WORKTREE", False)):
        args = ["snapshot", "export", rev, os.path.join(snap, name), "--overwrite"] + (["--vitest"] if vitest else [])
        code, summary, err = kbp(args, timeout=1800)
        ok = code == 0 and summary and summary.get("tsc", {}).get("errors") == 0
        if vitest:
            v = (summary or {}).get("vitest") or {}
            ok = ok and v.get("exit") == 0 and v.get("failed") == 0 and (v.get("tests") or 0) > 0
        report.append({"kind": "snapshot", "check": "export %s" % rev, "ok": bool(ok), "summary": summary,
                       "stderr": err[-2000:] if not ok else None})
        print("snap   export %-8s → %s" % (rev, json.dumps({k: (summary or {}).get(k) for k in
                                                           ("commit", "head", "files", "tsc", "vitest", "seconds")},
                                                          ensure_ascii=False)))
    # 快照只读：拷一份 HEAD 快照改一行，diff 出补丁，git apply --check（工作区里这个文件和 HEAD 相同才说明「打在 HEAD 上」）
    head = os.path.join(snap, "head")
    edit = os.path.join(snap, "edit")
    rmtree_own(edit, out_dir)
    shutil.copytree(os.path.join(head, "src"), os.path.join(edit, "src"))
    target_rel = "particles/f32.ts"
    target = os.path.join(edit, "src", *target_rel.split("/"))
    with open(target, encoding="utf-8") as f:
        text = f.read()
    old_line = "export const f32 = Math.fround;"
    if text.count(old_line) != 1:
        raise RuntimeError("找不到要改的那一行")
    with open(target, "w", encoding="utf-8", newline="\n") as f:
        f.write(text.replace(old_line, old_line + "  // kbp accept2：改一行"))
    patch = os.path.join(out_dir, "snapshot-edit.patch")
    code, summary, err = kbp(["snapshot", "diff", head, edit, "--out", patch, "--overwrite"])
    report.append({"kind": "snapshot", "check": "diff", "ok": code == 0 and summary.get("changed") == [target_rel],
                   "summary": summary})
    clean = subprocess.run(["git", "-C", REPO, "diff", "--quiet", "HEAD", "--", "apps/wpe-scene/src/" + target_rel]).returncode == 0
    check = subprocess.run(["git", "-C", REPO, "apply", "--check", patch], capture_output=True)
    report.append({"kind": "snapshot", "check": "git apply --check", "ok": check.returncode == 0 and clean,
                   "worktree_file_equals_head": clean, "stderr": check.stderr.decode("utf-8", "replace")})
    with open(patch, encoding="utf-8") as f:
        print("snap   diff → %s；git apply --check 退出码 %d（工作区该文件与 HEAD 相同：%s）\n%s" % (
            summary.get("changed"), check.returncode, clean, f.read()))
    # 对照：工作区快照对 HEAD 快照的补丁也应能干净打在 HEAD 上（--3way 的前提）；只报告
    ws_patch = os.path.join(out_dir, "snapshot-ws.patch")
    code, summary, err = kbp(["snapshot", "diff", head, os.path.join(snap, "ws"), "--out", ws_patch, "--overwrite"])
    check = subprocess.run(["git", "-C", REPO, "apply", "--check", "--cached", ws_patch], capture_output=True)
    report.append({"kind": "snapshot", "check": "工作区快照对 HEAD 的补丁（只报告）", "ok": True,
                   "summary": summary, "apply_cached_check": check.returncode,
                   "stderr": check.stderr.decode("utf-8", "replace")[-1000:]})
    print("snap   工作区快照对 HEAD：%s；git apply --check --cached 退出码 %d" % (
        {k: summary.get(k) for k in ("changed", "added", "deleted", "lines")}, check.returncode))


# ==================== replay：新案例 vs 旧脚本 ====================

# (案例, 旧脚本（ignore/p4 下）, 拷贝名, 环境变量, 输出文件前缀, 快照)
OLD = [
    ("b3", "c5/replay-b3.test.ts", "replay-b3.test.ts", {"KB_OUT": "b3-old"}, "b3-old", "head"),
    ("b4", "c5/replay-b4.test.ts", "replay-b4.test.ts", {"KB_OUT": "b4-old"}, "b4-old", "head"),
    ("b6", "c5/replay-b6.test.ts", "replay-b6.test.ts",
     {"KB_OUT": "old", "KB_TAGS": "p4b-color-fps60,p4b-colorp-fps60,p4b-colorp2-fps60"}, "b6-old-replay-multi", "head"),
    ("c1", "c5/replay-cp.test.ts", "replay-cp.test.ts", {"KB_REPLAY_OUT": "replay-cp-old"}, "replay-cp-old", "head"),
    ("c2", "c5/replay-ptr.test.ts", "replay-ptr.test.ts", {"KB_REPLAY_OUT": "replay-ptr-old"}, "replay-ptr-old", "head"),
    ("c3", "c5/replay-attract.test.ts", "replay-attract.test.ts", {"KB_REPLAY_OUT": "replay-attract-old"},
     "replay-attract-old", "head"),
    ("c4", "c5/replay.test.ts", "replay-world.test.ts", {"KB_REPLAY_OUT": "replay-world-old"}, "replay-world-old", "head"),
    ("d1", "d1/replay.test.ts", "replay-rope.test.ts", {"KB_REPLAY_OUT": "replay-rope-old"}, "replay-rope-old", "ws"),
    # 另看 d1 的旧脚本在 HEAD 快照上能不能跑、和新案例是否相同（只报告：绳在 b721f636 已入库）
    ("d1", "d1/replay.test.ts", "replay-rope.test.ts", {"KB_REPLAY_OUT": "replay-rope-old-head"}, "replay-rope-old-head",
     "head-d1"),
]
# c5/out 里 HEAD 一侧的同名回放记录
C5 = {"b3": "b3-head", "b4": "b4-head", "b6": "b6-head-replay-multi", "c1": "replay-cp-head", "c2": "replay-ptr-head",
      "c3": "replay-attract-head", "c4": "replay-world-head"}

# 旧脚本拷贝：只改输出路径；b3、b4 另把已经算好的统计写进 JSON（原脚本只写进文字或没写），不改计算
OLD_EDITS = {
    "*": [('const OUT = join(P4, "c5/out");', 'const OUT = join(REPO, "ignore/kbp/accept2/old/out"); // accept2：只改输出路径'),
          ('const OUT = join(P4, "d1/out");', 'const OUT = join(REPO, "ignore/kbp/accept2/old/out"); // accept2：只改输出路径')],
    "replay-b3.test.ts": [
        ("    const caps: string[] = [];",
         "    const caps: string[] = [];\n    const p4aStats: Record<string, unknown> = {}; // accept2：P4a 段每个系统的统计另写进 JSON"),
        ("      const s = compare(truth, name, reference);",
         "      const s = compare(truth, name, reference);\n      p4aStats[name] = s; // accept2"),
        ("    for (const cap of caps) lines.push(`  ${cap}`);",
         "    for (const cap of caps) lines.push(`  ${cap}`);\n    summary[`P4A:${item.tag}`] = p4aStats; // accept2"),
    ],
    "replay-b4.test.ts": [
        ("      forcedRows[name] = { v0: r.v0, worst: r.worst };",
         "      forcedRows[name] = { v0: r.v0, worst: r.worst };\n"
         "      tagSummary[`B:${name}`] = { fit: r.fit, worst: r.worst, limit: r.limit, n: r.n, h: h.worst, noTurb: noTurb.worst, worstAt: r.worstAt }; // accept2"),
        ("      tagFixture.snoise3 = rows;",
         "      tagFixture.snoise3 = rows;\n      tagSummary.snoise3 = { count: rows.length, worst }; // accept2"),
        ("      lines.push(`  turb 与 turb-ph5 的位置逐位相同：我们 ${ours}（速度也逐位相同），WPE ${wpe}`);",
         "      lines.push(`  turb 与 turb-ph5 的位置逐位相同：我们 ${ours}（速度也逐位相同），WPE ${wpe}`);\n"
         "      tagSummary.turbPh5 = { ours, wpe }; // accept2"),
        ("        const s = compare(truth, \"turb-ovr\", v.out, v.history);",
         "        const s = compare(truth, \"turb-ovr\", v.out, v.history);\n"
         "        ((tagSummary.turbOvrVariants ??= {}) as Record<string, number>)[label] = s.fields.pos.diff; // accept2"),
    ],
}


def copy_old(out_dir):
    target = os.path.join(out_dir, "old")
    rmtree_own(target, out_dir)
    os.makedirs(os.path.join(target, "out"))
    shutil.copyfile(os.path.join(P4, "c5", "vitest.config.ts"), os.path.join(target, "vitest.config.ts"))
    changed = {}
    for _, source, name, _, _, _ in OLD:
        if os.path.exists(os.path.join(target, name)):
            continue
        with open(os.path.join(P4, *source.split("/")), encoding="utf-8") as f:
            text = f.read()
        count = 0
        # 输出路径跟着 --out 走（OLD_EDITS 里写的是缺省目录 ignore/kbp/accept2）
        out_rel = os.path.relpath(os.path.join(out_dir, "old", "out"), REPO).replace("\\", "/")
        for old, new in OLD_EDITS["*"]:
            if old in text:
                text = text.replace(old, new.replace("ignore/kbp/accept2/old/out", out_rel))
                count += 1
        for old, new in OLD_EDITS.get(name, []):
            if text.count(old) != 1:
                raise RuntimeError("%s 里 %r 出现 %d 次" % (name, old, text.count(old)))
            text = text.replace(old, new)
            count += 1
        if count < 1:
            raise RuntimeError("%s 没改到输出路径" % name)
        write_text(os.path.join(target, name), text)
        changed[name] = count
    return target, changed


def run_old(out_dir, name, env_extra, snap):
    rel = lambda p: os.path.relpath(p, REPO).replace("\\", "/")  # noqa: E731
    env = dict(os.environ)
    env.update(env_extra)
    env["KB_TEST"] = rel(os.path.join(out_dir, "old", name))
    env["KB_SRC"] = rel(os.path.join(out_dir, "snap", snap.split("-")[0], "src"))
    t0 = time.time()
    proc = subprocess.run(["node", NODE_VITEST, "run", "--config", os.path.join(out_dir, "old", "vitest.config.ts")],
                          cwd=REPO, env=env, capture_output=True)
    with open(os.path.join(out_dir, "old", "out", name + ".log"), "wb") as f:
        f.write(proc.stdout + proc.stderr)
    return proc.returncode, round(time.time() - t0, 2)


def old_ok(stats, require_particles=True):
    return (stats["frames"] > 0 and (not require_particles or stats["particles"] > 0) and not stats["countMismatch"]
            and all(f["over"] == 0 for f in stats["fields"].values()))


def stats_diff(new, old):
    """位置模式：比旧统计里有的键（新的是超集）；worst 只比两边都有的子键。"""
    keys = [k for k in old if k != "worst"]
    d = deep_diff({k: new.get(k, "<缺>") for k in keys}, {k: old[k] for k in keys})
    if "worst" in old or "worst" in new:
        ow, nw = old.get("worst") or {}, new.get("worst") or {}
        common = [k for k in ow if k in nw]
        deep_diff({k: nw[k] for k in common}, {k: ow[k] for k in common}, "$.worst", d)
        if bool(ow) != bool(nw):
            d["count"] += 1
            d["items"].append(("$.worst", _short(nw), _short(ow)))
    return d


def section_map(case, new):
    """新报告：标签 → 段。"""
    return {s["label"]: s for s in new["sections"]}


def pairs_for(case, old, new):
    """旧 JSON 与新报告里一一对应的 (说明, 新统计, 新 ok, 旧统计, 旧 ok, 比较方式)。"""
    secs = section_map(case, new)
    out = []

    def pos(label_old, sys_old, sec_label, sys_new=None, require=True):
        sec = secs.get(sec_label)
        if sec is None or (sys_new or sys_old) not in sec["systems"]:
            out.append(("%s / %s" % (label_old, sys_old), None, None, sys_stats, None, "缺"))
            return
        r = sec["systems"][sys_new or sys_old]
        out.append(("%s / %s" % (label_old, sys_old), r["stats"], r["ok"], sys_stats, old_ok(sys_stats, require), "stats"))

    if case == "b3":
        mapping = {"p4b-fps60": "模块 p4b-fps60", "p4b-fps10（平分）": "模块 p4b-fps10（平分）",
                   "p4b-fps10（反推拆分）": "模块 p4b-fps10（反推拆分）", "p4b-emit-fps60": "发射 p4b-emit-fps60"}
        for key, systems in old.items():
            if key.endswith(":implied"):
                sec = secs.get("模块 p4b-fps10（平分）")
                out.append((key, (sec or {}).get("extra", {}).get("implied"), None, systems, None, "value"))
                continue
            label = mapping.get(key) or ("P4a " + key.split(":", 1)[1] if key.startswith("P4A:") else None)
            for name, sys_stats in systems.items():
                if name.endswith(":speed"):
                    sec = secs.get(label) or {}
                    out.append(("%s / %s" % (key, name), (sec.get("extra", {}).get("capSpeeds") or {}).get(name[:-6]),
                                None, sys_stats, None, "value"))
                    continue
                pos(key, name, label)
    elif case == "b4":
        for tag, parts in old.items():
            for part, systems in parts.items():
                if part in ("A:cur", "A:prev"):
                    for name, both in systems.items():
                        key = name if part == "A:cur" else name + "@prev"
                        r = secs[tag]["systems"].get(key)
                        out.append(("%s %s / %s" % (tag, part, name), r and r["stats"], r and r["ok"], both["withEnvelope"],
                                    old_ok(both["withEnvelope"]), "stats"))
                        out.append(("%s %s / %s（不加包络）" % (tag, part, name), r and r["stats"].get("plain"), None,
                                    both["plain"], None, "stats"))
                elif part.startswith("B:"):
                    r = secs[tag]["systems"].get(part)
                    out.append(("%s / %s" % (tag, part), r and r["stats"], r and r["ok"], systems,
                                systems["worst"] <= systems["limit"], "value"))
                elif part == "C":
                    out.append(("%s / C" % tag, secs[tag]["extra"].get("C"), None, systems, None, "value"))
                else:
                    out.append(("%s / %s" % (tag, part), secs[tag]["extra"].get(part), None, systems, None, "value-opt"))
    elif case == "b6":
        for tag, rows in old.items():
            for row in rows:
                r = secs[tag]["systems"].get(row["name"])
                out.append(("%s / %s" % (tag, row["name"]), r and r["stats"], r and r["ok"], row, row["ok"], "value"))
    elif case == "c1":
        for name, sys_stats in old.items():
            pos("p4c-cp-fps60", name, "p4c-cp-fps60")
    elif case in ("c2", "c3"):
        for tag, systems in old.items():
            for name, sys_stats in systems.items():
                pos(tag, name, tag, require=case != "c3")
    elif case == "c4":
        mapping = {"p4c-world-fps60:prev": "新顺序 p4c-world-fps60", "p4c-world-fps60:same": "旧顺序 p4c-world-fps60"}
        for key, systems in old.items():
            for name, sys_stats in systems.items():
                pos(key, name, mapping.get(key, key))
    elif case == "d1":
        for tag, systems in old.items():
            for name, stat in systems.items():
                r = secs[tag]["systems"].get(name)
                out.append(("%s / %s" % (tag, name), r and r["stats"], r and r["ok"], stat,
                            not stat["mismatch"] and stat["over"] == 0, "value"))
    return out


def compare_case(case, old, new):
    rows = []
    bad = 0
    for label, new_stats, new_ok, old_stats, old_ok_, how in pairs_for(case, old, new):
        if how == "缺" or new_stats is None:
            rows.append({"item": label, "ok": False, "error": "新报告里没有"})
            bad += 1
            continue
        if how == "stats":
            d = stats_diff(new_stats, old_stats)
        elif how == "value-opt":
            d = deep_diff(new_stats, old_stats)
        else:
            d = deep_diff({k: new_stats.get(k, "<缺>") for k in old_stats} if isinstance(old_stats, dict) and isinstance(new_stats, dict) else new_stats, old_stats)
        same_ok = old_ok_ is None or new_ok is None or bool(old_ok_) == bool(new_ok)
        ok = d["count"] == 0 and same_ok
        if not ok:
            bad += 1
        row = {"item": label, "ok": ok}
        if d["count"]:
            row["diff"] = d
        if not same_ok:
            row["ok_new"], row["ok_old"] = new_ok, old_ok_
        rows.append(row)
    return rows, bad


def verdict_of_txt(path):
    with open(path, encoding="utf-8") as f:
        text = f.read()
    if "有失败" in text.splitlines()[-1] or "全部有失败" in text:
        return False
    return "全部通过" in text


def track_checks_of_txt(path):
    with open(path, encoding="utf-8") as f:
        text = f.read()
    return re.findall(r"particleTrack[^\n]*?对照[^：\n]*：(\d+) 个粒子，(逐位相同|\d+ 处不同)", text)


def track_checks_of_new(report):
    out = []
    for sec in report["sections"]:
        for check in sec["checks"]:
            if check["name"].startswith("particleTrack（"):
                m = re.match(r"(\d+) 个粒子，(逐位相同|\d+ 处不同)", check.get("detail", ""))
                out.append(m.groups() if m else ("?", check.get("detail")))
    return out


def check_replay(out_dir, report):
    target, changed = copy_old(out_dir)
    report.append({"kind": "replay", "check": "旧脚本拷贝（只改输出路径；b3、b4 另写已算好的统计）", "ok": True,
                   "changed": changed})
    # 新案例：HEAD 快照上 b3…c4，工作区快照上 d1；另在 HEAD 快照上跑一遍 d1（只报告）
    timings = {}
    new_out = {}
    for snap, cases in (("head", ["b3", "b4", "b6", "c1", "c2", "c3", "c4"]), ("ws", ["d1"]), ("head-d1", ["d1"])):
        src = os.path.join(out_dir, "snap", snap.split("-")[0], "src")
        out = os.path.join(out_dir, "new-" + snap)
        rmtree_own(out, out_dir)
        code, summary, err = kbp(["replay"] + cases + ["--src", src, "--out", out, "--quiet"], timeout=3600)
        new_out[snap] = out
        report.append({"kind": "replay", "check": "kbp replay（%s 快照）%s" % (snap, " ".join(cases)),
                       "ok": code == 0 or snap == "head-d1", "summary": summary, "stderr": err[-1500:] if code else None})
        print("replay 新案例 %-7s → %s" % (snap, json.dumps((summary or {}).get("cases") or summary, ensure_ascii=False)))
        for name, row in ((summary or {}).get("cases") or {}).items():
            timings.setdefault(name, {})["new-" + snap] = row.get("seconds")
    # 旧脚本，同一份快照
    for case, _, name, env, prefix, snap in OLD:
        code, seconds = run_old(out_dir, name, env, snap)
        timings.setdefault(case, {})["old" if snap != "head-d1" else "old-head"] = seconds
        old_json = os.path.join(target, "out", prefix + ".json")
        old_txt = os.path.join(target, "out", prefix + ".txt")
        new_json = os.path.join(new_out[snap], case + ".json")
        row = {"kind": "replay", "case": case, "snapshot": snap, "old_exit": code, "seconds": timings[case]}
        if snap == "head-d1":
            row["informational"] = True
        if not (os.path.isfile(old_json) and os.path.isfile(new_json)):
            row.update(ok=False, error="缺输出：%s" % [p for p in (old_json, new_json) if not os.path.isfile(p)])
            report.append(row)
            print("replay %-3s 缺输出" % case, row["error"])
            continue
        old = load_json(old_json)
        new = load_json(new_json)
        rows, bad = compare_case(case, old, new)
        old_pass = verdict_of_txt(old_txt)
        # 案例 JSON 的 systems.informational 照比照报、不判定。有的旧脚本本来就不判定它们（b4 的 turb、c4 的 w-stay-w），
        # 有的是案例后来才列进去的（2026-11-10 起 c3 的 a-default，旧脚本仍记失败）。所以结论相同即可；「旧有失败、新全部通过」
        # 时，要求差别正好来自列出的 informational 系统的失败
        spec = load_json(os.path.join(P4, "cases", case + ".json"))
        listed = set((spec.get("systems") or {}).get("informational") or [])
        for run in spec.get("runs") or []:
            listed |= set((run.get("systems") or {}).get("informational") or [])
        informational_failed = sorted({name for sec in new["sections"] for name, r in sec["systems"].items()
                                       if name in listed and r.get("judged") is False and not r.get("ok")})
        raw_pass = new["ok"] and not informational_failed
        same_verdict = old_pass == new["ok"] or (not old_pass and new["ok"] and bool(informational_failed))
        tc_old, tc_new = track_checks_of_txt(old_txt), track_checks_of_new(new)
        same_track = [tuple(x) for x in tc_old] == [tuple(x) for x in tc_new]
        row.update(ok=(bad == 0 and same_verdict and same_track) or snap == "head-d1", items=len(rows), differ=bad,
                   verdict={"old": old_pass, "new": new["ok"], "new_with_informational": raw_pass,
                            "informational_failed": informational_failed},
                   particle_track={"old": tc_old, "new": tc_new}, rows=[r for r in rows if not r["ok"]][:20])
        report.append(row)
        print("replay %-3s %s 快照：%d 项逐项比，不同 %d；结论 旧 %s / 新 %s；particleTrack 对照 %s；耗时 旧 %s s 新 %s s" % (
            case, snap, len(rows), bad, "全部通过" if old_pass else "有失败", "全部通过" if new["ok"] else "有失败",
            "相同" if same_track else "不同 %s / %s" % (tc_old, tc_new), seconds, timings[case].get("new-" + snap)))
        if snap == "head-d1":
            print("       （只报告：d1 的旧脚本与新案例都在 HEAD 快照上跑）")
        for r in rows:
            if not r["ok"]:
                print("       ✗", r["item"], json.dumps(r.get("diff") or r, ensure_ascii=False)[:400])
    report.append({"kind": "replay", "check": "耗时（秒）", "ok": True, "seconds": timings})


def check_c5(out_dir, report):
    """HEAD 快照上的新案例和 ignore/p4/c5/out 里同名回放（*-head*）的记录比。"""
    # d1 另和 ignore/p4/d1/out/replay-rope.json（d1 的最新记录）比，用工作区快照上的结果
    for case, old_json, new_json in [(c, os.path.join(P4, "c5", "out", p + ".json"), os.path.join(out_dir, "new-head", c + ".json"))
                                     for c, p in C5.items()] + [("d1", os.path.join(P4, "d1", "out", "replay-rope.json"),
                                                                 os.path.join(out_dir, "new-ws", "d1.json"))]:
        if not os.path.isfile(new_json):
            report.append({"kind": "c5", "case": case, "ok": False, "error": "先跑 replay"})
            continue
        rows, bad = compare_case(case, load_json(old_json), load_json(new_json))
        row = {"kind": "c5", "case": case, "ok": bad == 0, "items": len(rows), "differ": bad,
               "rows": [r for r in rows if not r["ok"]][:40]}
        report.append(row)
        print("c5     %-3s：%d 项，不同 %d" % (case, len(rows), bad))
        for r in rows:
            if not r["ok"]:
                print("       ✗", r["item"], json.dumps(r.get("diff") or r, ensure_ascii=False)[:300])


# ==================== regress ====================


def check_regress(out_dir, report):
    head = os.path.join(out_dir, "snap", "head", "src")
    # 1. 同一份快照传两次：全部案例（含 d1；绳在 HEAD 的 b721f636 已入库）逐字节相同
    out = os.path.join(out_dir, "regress-same")
    code, summary, err = kbp(["regress", "--src", head, "--src", head, "--out", out, "--overwrite", "--quiet"], timeout=3600)
    report.append({"kind": "regress", "check": "同一份快照两次", "ok": code == 0 and summary.get("same") is True,
                   "summary": summary, "stderr": err[-1500:] if code else None})
    print("regress 同一份快照两次 → %s" % json.dumps(summary, ensure_ascii=False))
    # 2. 拷一份快照，在模拟器里改一处常数
    mutant = os.path.join(out_dir, "snap", "mutant")
    rmtree_own(mutant, out_dir)
    shutil.copytree(os.path.join(out_dir, "snap", "head", "src"), os.path.join(mutant, "src"))
    target = os.path.join(mutant, "src", "particles", "system.ts")
    with open(target, encoding="utf-8") as f:
        text = f.read()
    # drag 系数 k0 = pow(min(1, 0.025 / frameDt), 0.7)·dt' 的指数：0.7 → 0.71（vortex、turbulence、带 drag 的 movement 都乘 k）
    anchor, mutated = "const DRAG_EXPONENT = f32(0.7);", "const DRAG_EXPONENT = f32(0.71); // accept2：故意改坏"
    if text.count(anchor) != 1:
        raise RuntimeError("system.ts 里找不到 %s" % anchor)
    with open(target, "w", encoding="utf-8", newline="\n") as f:
        f.write(text.replace(anchor, mutated))
    out = os.path.join(out_dir, "regress-mutant")
    code, summary, err = kbp(["regress", "--src", head, "--src", os.path.join(mutant, "src"), "--out", out, "--overwrite",
                              "--quiet"], timeout=3600)
    detail = load_json(os.path.join(out, "regress.json")) if os.path.isfile(os.path.join(out, "regress.json")) else {}
    firsts = {row["case"]: {ext: f.get("first") for ext, f in row["files"].items() if not f["same"]}
              for row in detail.get("cases", []) if not row["same"]}
    report.append({"kind": "regress", "check": "改一处常数（system.ts 的 DRAG_EXPONENT 0.7 → 0.71）",
                   "ok": code == 0 and summary.get("same") is False and bool(summary.get("differ")),
                   "summary": summary, "first": firsts})
    print("regress 改常数 → %s" % json.dumps(summary, ensure_ascii=False))
    for case, f in firsts.items():
        print("        %s：%s" % (case, json.dumps(f, ensure_ascii=False)[:400]))


# ==================== 入口 ====================

SECTIONS = ["gen", "track", "snapshot", "replay", "c5", "regress"]


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", default=os.path.join(REPO, "ignore", "kbp", "accept2"))
    parser.add_argument("--only", help="逗号分隔：" + ",".join(SECTIONS))
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
        globals()["check_" + section](out_dir, report)
        timings[section] = round(time.time() - t0, 1)
    path = os.path.join(out_dir, "report.json" if not args.only else "report-%s.json" % "-".join(only))
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump({"seconds": timings, "total": round(time.time() - started, 1), "checks": report}, f,
                  ensure_ascii=False, indent=1, default=str)
    failed = [r for r in report if not r.get("ok")]
    print(json.dumps({"ok": not failed, "checks": len(report), "failed": [
        (r["kind"], r.get("check") or r.get("project") or r.get("case")) for r in failed], "report": path,
        "seconds": timings}, ensure_ascii=False))
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
