"""kbp-tools 第 5 批的验收自测：kbp content unpack（真实场景解包加日志）。

    python -X utf8 -I .claude/skills/kbp-tools/tests/accept5.py [--out ignore/kbp/accept5] [--only mini,guard,real]
                                                             [--real 3830255100] [--proto ignore/p5/proj/3830255100-kbp]

全部输出在 --out 下（要在仓库 ignore/ 下）；WPE 安装目录、工坊目录只读（拒绝类检查只验证没有写出任何东西）。
- mini：在 <out>/src/ 下造小工程（自己写 scene.pkg），核对：散文件与包内同名时散文件优先；包内重名取第一个；条目名过 normalize
  （`./`、反斜杠）、Windows 上大小写不同算同名；scene.json 在包里时也能加 FR；FR 追加在末尾、id 是全部整数 id 的最大值 + 1
  （effect / pass / instanceoverride 的 id 比对象大时也不撞）、脚本就是生成库的 FR_CURSOR；project.json 只改标题；
  kbp-unpack.json 的计数；缺省输出 <data>/proj/<名>-kbp；工坊 ID（目录名是纯数字时）。
- guard：拒绝写到仓库 ignore/ 之外（含 ignore/ 本身）、真实 WPE 安装目录与工坊目录；经 KABEGAME_WPE_ROOT 指向 <out>/fake 下的假 WPE，
  分别核对「落在 WPE 安装目录」「落在工坊目录」「包含了 WPE 安装目录」由哪条规则拒的；拒绝写进源工程、拒绝包含源工程；
  --overwrite 只删带标记的目录；源 scene.json 已有 kbp-FR 报错；scene.json 带注释报 [data]（不加 FR 时照拷）。每次失败后
  不留输出目录与临时目录。
- real：真实工坊场景 `unpack <ID> --instrument --out <out>/real`，和原型产物逐文件比：除 kbp-unpack.json（原型不写）、
  原型里 WPE 运行时写的 shaders/blobsSM40、scene.json 里 FR 的 id（原型只看对象的 id，和 effect 撞号；本命令看全部整数 id）外
  逐字节相同；scene.json 把原型 FR 的 id 换成本命令的值后逐字节相同。前后核对工坊目录的文件哈希不变。
结果写 <out>/report.json（--only 时 report-<段>.json），每项一行打到 stdout。
"""

import argparse
import hashlib
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import time

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL = os.path.dirname(HERE)
REPO = os.path.normpath(os.path.join(SKILL, "..", "..", ".."))
KBP = os.path.join(SKILL, "kbp.py")

sys.path.insert(0, SKILL)
import kbp as _kbp  # noqa: E402  （充当包 kbp）

_kbp._register()
from kbp import content as libcontent  # noqa: E402
from kbp import gen as libgen  # noqa: E402

MARKER = "kbp-unpack.json"


# ==================== 公共 ====================


def kbp(args, env=None, timeout=600):
    """跑一次 kbp.py，返回 (退出码, 摘要 JSON, stderr)。env：在当前环境上覆盖的变量。"""
    full_env = dict(os.environ)
    full_env.update(env or {})
    proc = subprocess.run([sys.executable, "-X", "utf8", "-I", KBP] + args, cwd=REPO, capture_output=True,
                          timeout=timeout, env=full_env)
    lines = [l for l in proc.stdout.decode("utf-8", "replace").splitlines() if l.strip()]
    try:
        summary = json.loads(lines[-1]) if lines else None
    except ValueError:
        summary = {"raw": lines[-1]}
    return proc.returncode, summary or {}, proc.stderr.decode("utf-8", "replace").strip()


def add(report, row):
    report.append(row)
    mark = "ok " if row.get("ok") else "✗  "
    detail = {k: v for k, v in row.items() if k not in ("kind", "check", "ok") and not k.startswith("_")}
    print("%s%-6s %s  %s" % (mark, row["kind"], row.get("check", ""), json.dumps(detail, ensure_ascii=False)[:600]),
          flush=True)


def rmtree_own(path, out_dir):
    """只删 --out 下本自测建的目录。"""
    full = os.path.abspath(path)
    if not full.startswith(os.path.abspath(out_dir) + os.sep):
        raise RuntimeError("拒绝删除 --out 之外的目录：%s" % full)
    if os.path.isdir(full):
        shutil.rmtree(full)
    elif os.path.exists(full):
        os.remove(full)


def write_bytes(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)


def read_bytes(path):
    with open(path, "rb") as f:
        return f.read()


def load_json(path):
    with open(path, encoding="utf-8-sig") as f:
        return json.load(f)


def tree(root):
    """{相对路径（正斜杠）: sha256}。"""
    out = {}
    for d, _, names in os.walk(root):
        for name in names:
            p = os.path.join(d, name)
            out[os.path.relpath(p, root).replace(os.sep, "/")] = hashlib.sha256(read_bytes(p)).hexdigest()
    return out


def leftovers(parent):
    """unpack 的临时目录（.<名>.kbp-unpack-*）有没有残留。"""
    if not os.path.isdir(parent):
        return []
    return [n for n in os.listdir(parent) if ".kbp-unpack-" in n]


def all_ids(node, path="$", out=None):
    """[(id, JSON 路径)]：全部整数 id。"""
    out = [] if out is None else out
    if isinstance(node, dict):
        value = node.get("id")
        if isinstance(value, int) and not isinstance(value, bool):
            out.append((value, path))
        for k, v in node.items():
            all_ids(v, "%s.%s" % (path, k), out)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            all_ids(v, "%s[%d]" % (path, i), out)
    return out


def write_pkg(path, entries, version="PKGV0024"):
    """写 scene.pkg（格式同 content.read_pkg / apps/wpe-scene/src/compile/pkg.ts）：sizedString 头、u32 条数、
    每条 {sizedString 名字, u32 偏移, u32 长度}，数据区按顺序首尾相接。entries：[(名字, 字节)]。"""
    def sized(text):
        raw = text.encode("utf-8")
        return struct.pack("<I", len(raw)) + raw

    table = sized(version) + struct.pack("<I", len(entries))
    offset = 0
    for name, data in entries:
        table += sized(name) + struct.pack("<II", offset, len(data))
        offset += len(data)
    write_bytes(path, table + b"".join(data for _, data in entries))


def expect_refused(report, kind, check, args, created, layer, needle=None, env=None):
    """跑一次应被拒绝的 unpack：退出码非 0、错误以 [layer] 开头（含 needle）、created 里的路径都没出现、没有临时目录残留。"""
    before = {p: os.path.lexists(p) for p in created}
    code, summary, err = kbp(args, env=env)
    appeared = [p for p in created if os.path.lexists(p) and not before[p]]
    stray = sorted({n for p in created for n in leftovers(os.path.dirname(os.path.abspath(p)))})
    ok = code != 0 and err.startswith("[%s]" % layer) and (needle is None or needle in err) and not appeared \
        and not stray and summary.get("ok") is False
    add(report, {"kind": kind, "check": check, "ok": ok, "code": code, "error": err[-300:], "appeared": appeared,
                 "leftovers": stray})


# ==================== mini ====================

MINI_PROJECT = {"file": "scene.json", "type": "scene", "title": "mini", "description": "accept5",
                "general": {"properties": {"schemecolor": {"order": 0, "text": "ui_browse_properties_scheme_color",
                                                           "type": "color", "value": "0 0 0"}}}}
# effect / pass / instanceoverride 的 id（40、41、50）比对象的（5、7）大：FR 的 id 应是 51
MINI_SCENE = {
    "camera": {"center": "0 0 -1", "eye": "0 0 0", "up": "0 1 0"},
    "general": {"orthogonalprojection": {"width": 1920, "height": 1080}, "clearcolor": "0 0 0"},
    "objects": [
        {"id": 5, "name": "bg", "image": "models/c.json", "origin": "960 540 0", "size": "1920 1080",
         "effects": [{"id": 40, "file": "effects/x/effect.json", "passes": [{"id": 41}]}]},
        {"id": 7, "name": "fx", "particle": "particles/p.json", "origin": "960 540 0",
         "instanceoverride": {"id": 50, "count": 1.0}},
    ],
    "version": 3,
}
BIN = bytes(range(256)) * 3 + b"\0tail"


def mini_entries():
    """(包内条目, 期望)。期望：路径 → 字节；同名 / 被散文件盖住的条目不出现。"""
    scene = json.dumps(MINI_SCENE, indent="\t").encode("utf-8")
    entries = [
        ("scene.json", scene),
        ("materials/a.json", b'{"from": "pkg"}'),        # 散文件有同名 → 跳过
        ("materials/b.json", b'{"n": 1}'),                # 包内第一个
        ("materials/b.json", b'{"n": 2}'),                # 包内重名 → 跳过
        ("./textures/d.tex", BIN),                        # normalize：去掉 ./
        ("textures\\e.tex", b"TEXV0005-e"),               # normalize：反斜杠
        ("Materials/A.JSON", b'{"from": "pkg-upper"}'),  # Windows 上和散文件 materials/a.json 同名 → 跳过
        ("models/c.json", b'{"material": "materials/b.json"}'),
    ]
    want = {"scene.json": scene, "materials/a.json": b'{"from": "loose"}', "materials/b.json": b'{"n": 1}',
            "textures/d.tex": BIN, "textures/e.tex": b"TEXV0005-e", "models/c.json": b'{"material": "materials/b.json"}',
            "preview.jpg": b"\xff\xd8\xff\xe0fake-jpeg"}
    skipped = 3
    if os.name != "nt":  # 大小写敏感的文件系统上 Materials/A.JSON 是另一个文件
        want["Materials/A.JSON"] = b'{"from": "pkg-upper"}'
        skipped = 2
    return entries, want, skipped


def make_mini(root):
    """造带 scene.pkg 的小工程：散文件 project.json、materials/a.json、preview.jpg，scene.json 只在包里。"""
    entries, _, _ = mini_entries()
    write_bytes(os.path.join(root, "project.json"), json.dumps(MINI_PROJECT, indent="\t").encode("utf-8"))
    write_bytes(os.path.join(root, "materials", "a.json"), b'{"from": "loose"}')
    write_bytes(os.path.join(root, "preview.jpg"), b"\xff\xd8\xff\xe0fake-jpeg")
    write_pkg(os.path.join(root, "scene.pkg"), entries)


def check_mini(out_dir, report):
    src_root = os.path.join(out_dir, "src")
    for name in ("src", "data", "u1", "u2"):
        rmtree_own(os.path.join(out_dir, name), out_dir)
    mini = os.path.join(src_root, "4242")
    make_mini(mini)
    entries, want, skipped = mini_entries()
    src_tree = tree(mini)

    # u1：不加 FR，缺省输出 <data>/proj/<名>-kbp
    data = os.path.join(out_dir, "data")
    code, summary, err = kbp(["content", "unpack", mini, "--data", data])
    u1 = os.path.join(data, "proj", "4242-kbp")
    got = tree(u1) if code == 0 else {}
    files_ok = set(got) == set(want) | {"project.json", MARKER} and "scene.pkg" not in got
    content_ok = files_ok and all(read_bytes(os.path.join(u1, *p.split("/"))) == b for p, b in want.items())
    add(report, {"kind": "mini", "check": "缺省输出位置、散文件优先、包内重名取第一个、条目名归一化、不拷 scene.pkg",
                 "ok": code == 0 and os.path.normcase(summary.get("out", "")) == os.path.normcase(u1) and files_ok
                 and content_ok and summary.get("loose") == 3 and summary.get("extracted") == len(want) - 2
                 and summary.get("skipped") == skipped,
                 "files": sorted(got), "summary": {k: summary.get(k) for k in ("loose", "extracted", "skipped", "fr_id")},
                 "stderr": err[-300:] if code else None})
    if code == 0:
        project = load_json(os.path.join(u1, "project.json"))
        expect = dict(MINI_PROJECT, title="mini (kbp)")
        add(report, {"kind": "mini", "check": "project.json 只改标题，scene.json 不加 FR 时原样",
                     "ok": project == expect and list(project) == list(expect)
                     and read_bytes(os.path.join(u1, "scene.json")) == entries[0][1], "title": project.get("title")})
        marker = load_json(os.path.join(u1, MARKER))
        size = sum(os.path.getsize(os.path.join(d, n)) for d, _, ns in os.walk(u1) for n in ns if n != MARKER)
        add(report, {"kind": "mini", "check": "kbp-unpack.json：来源、工坊 ID、计数、字节数、时间",
                     "ok": os.path.normcase(marker.get("source", "")) == os.path.normcase(mini)
                     and marker.get("workshop") == "4242" and summary.get("workshop") == "4242"
                     and marker.get("loose") == 3 and marker.get("extracted") == len(want) - 2
                     and marker.get("skipped") == skipped and marker.get("instrument") is False
                     and marker.get("fr_id") is None and marker.get("bytes") == size == summary.get("bytes")
                     and marker.get("pkg") == "PKGV0024" and "T" in (marker.get("time") or "")
                     and summary.get("next"), "marker": marker})

    # u2：加 FR（scene.json 在包里）
    u2 = os.path.join(out_dir, "u2")
    code, summary, err = kbp(["content", "unpack", mini, "--out", u2, "--instrument"])
    if code != 0:
        add(report, {"kind": "mini", "check": "--instrument", "ok": False, "stderr": err[-500:]})
        return
    scene = load_json(os.path.join(u2, "scene.json"))
    objects = scene.get("objects") or []
    fr = objects[-1] if objects else {}
    others = [v for v, _ in all_ids(dict(scene, objects=objects[:-1]))]
    want_fr = libgen.layer(51, "kbp-FR", "-100000 -100000 0", "1 1", image="models/kbp/fr.json")
    want_fr["color"] = {"script": libgen.FR_CURSOR, "value": "0 0 1"}
    add(report, {"kind": "mini", "check": "FR 追加在末尾、id = 全部整数 id 最大值 + 1（不撞 effect / pass / instanceoverride）、"
                                          "脚本是 FR_CURSOR",
                 "ok": fr == want_fr and fr.get("id") not in others and summary.get("fr_id") == 51
                 and objects[:-1] == MINI_SCENE["objects"] and {k: v for k, v in scene.items() if k != "objects"}
                 == {k: v for k, v in MINI_SCENE.items() if k != "objects"} and fr["color"]["script"] is not None
                 and "input.cursorScreenPosition" in fr["color"]["script"],
                 "fr_id": fr.get("id"), "objects_max": max(o["id"] for o in MINI_SCENE["objects"]), "all_max": max(others),
                 "names": [o.get("name") for o in objects]})
    fr_model = load_json(os.path.join(u2, "models", "kbp", "fr.json"))
    marker = load_json(os.path.join(u2, MARKER))
    add(report, {"kind": "mini", "check": "models/kbp/fr.json 与标记的 FR 字段",
                 "ok": fr_model == {"material": "materials/util/solidlayer.json"} and marker.get("instrument") is True
                 and marker.get("fr_id") == 51 and marker.get("fr_name") == "kbp-FR", "model": fr_model})
    add(report, {"kind": "mini", "check": "源工程没有被改", "ok": tree(mini) == src_tree})


# ==================== guard ====================


def check_guard(out_dir, report):
    mini = os.path.join(out_dir, "src", "4242")
    if not os.path.isdir(mini):
        make_mini(mini)
    src_tree = tree(mini)

    # 仓库 ignore/ 之外、ignore/ 本身、真实 WPE / 工坊目录：只验证被拒、没有写出东西
    outside = [os.path.join(REPO, "kbp-accept5-outside"), os.path.join(tempfile.gettempdir(), "kbp-accept5-outside")]
    for path in outside:
        expect_refused(report, "guard", "拒绝 ignore/ 之外：%s" % path, ["content", "unpack", mini, "--out", path],
                       [path], "kbp", "ignore/")
    expect_refused(report, "guard", "拒绝 ignore/ 本身", ["content", "unpack", mini, "--out", os.path.join(REPO, "ignore"),
                                                     "--overwrite"], [], "kbp", "ignore/")
    for label, base in (("WPE 安装目录", libcontent.wpe_dir()), ("工坊目录", libcontent.workshop_dir())):
        path = os.path.join(base, "kbp-accept5-should-not-exist")
        expect_refused(report, "guard", "拒绝真实的%s（被 ignore/ 规则先拒，不写）" % label, ["content", "unpack", mini, "--out", path], [path], "kbp")

    # 假 WPE（在 ignore/ 下）：核对具体是哪条规则拒的
    fake = os.path.join(out_dir, "fake")
    rmtree_own(fake, out_dir)
    fake_wpe = os.path.join(fake, "steamapps", "common", "wallpaper_engine")
    fake_ws = os.path.join(fake, "steamapps", "workshop", "content", "431960")
    os.makedirs(os.path.join(fake_wpe, "projects", "myprojects"))
    os.makedirs(fake_ws)
    env = {"KABEGAME_WPE_ROOT": fake_wpe}
    for check, path, needle in (
            ("落在 WPE 安装目录", os.path.join(fake_wpe, "projects", "myprojects", "x-kbp"), "落在WPE 安装目录"),
            ("落在工坊目录", os.path.join(fake_ws, "x-kbp"), "落在Steam 工坊目录"),
            ("包含了 WPE 安装目录", os.path.join(fake, "steamapps"), "包含了WPE 安装目录")):
        expect_refused(report, "guard", "假 WPE：%s" % check, ["content", "unpack", mini, "--out", path, "--overwrite"],
                       [path] if not os.path.exists(path) else [], "kbp", needle, env=env)
    # 工坊 ID 解析：假工坊里的 777 → 缺省输出 <data>/proj/777-kbp
    shutil.copytree(mini, os.path.join(fake_ws, "777"))
    fake_tree = tree(os.path.join(fake_ws, "777"))
    data = os.path.join(out_dir, "data")
    rmtree_own(os.path.join(data, "proj", "777-kbp"), out_dir)
    code, summary, err = kbp(["content", "unpack", "777", "--data", data, "--instrument"], env=env)
    add(report, {"kind": "guard", "check": "按工坊 ID 解析（假工坊）、工坊 ID 记进摘要、源不变",
                 "ok": code == 0 and summary.get("workshop") == "777" and os.path.normcase(summary.get("src", ""))
                 == os.path.normcase(os.path.join(fake_ws, "777")) and summary.get("fr_id") == 51
                 and tree(os.path.join(fake_ws, "777")) == fake_tree, "summary": {k: summary.get(k) for k in
                                                                                 ("src", "out", "workshop", "fr_id")},
                 "stderr": err[-300:] if code else None})

    # 源工程
    expect_refused(report, "guard", "拒绝写进源工程（子目录）", ["content", "unpack", mini, "--out", os.path.join(mini, "sub")],
                   [os.path.join(mini, "sub")], "kbp", "落在源工程")
    expect_refused(report, "guard", "拒绝写到源工程本身", ["content", "unpack", mini, "--out", mini, "--overwrite"], [],
                   "kbp", "源工程")
    expect_refused(report, "guard", "拒绝包含源工程的目录", ["content", "unpack", mini, "--out", os.path.dirname(mini),
                                                    "--overwrite"], [], "kbp", "包含了源工程")

    # --overwrite：只删带标记的目录
    u2 = os.path.join(out_dir, "u2")
    if not os.path.isfile(os.path.join(u2, MARKER)):
        kbp(["content", "unpack", mini, "--out", u2, "--instrument"])
    before = tree(u2)
    expect_refused(report, "guard", "已存在、不加 --overwrite：拒绝且不动",
                   ["content", "unpack", mini, "--out", u2, "--instrument"], [], "data", "已存在")
    unchanged = tree(u2) == before
    write_bytes(os.path.join(u2, "extra.txt"), b"stale")
    code, summary, err = kbp(["content", "unpack", mini, "--out", u2, "--instrument", "--overwrite"])
    add(report, {"kind": "guard", "check": "带标记的目录 --overwrite：整个换掉（旧的多余文件不在了）",
                 "ok": unchanged and code == 0 and not os.path.exists(os.path.join(u2, "extra.txt"))
                 and os.path.isfile(os.path.join(u2, MARKER)) and not leftovers(out_dir),
                 "unchanged_before": unchanged, "stderr": err[-300:] if code else None})
    nomark = os.path.join(out_dir, "nomark")
    rmtree_own(nomark, out_dir)
    write_bytes(os.path.join(nomark, "keep.txt"), b"keep")
    expect_refused(report, "guard", "没有标记的目录 --overwrite：拒绝", ["content", "unpack", mini, "--out", nomark,
                                                                 "--overwrite"], [], "data", MARKER)
    add(report, {"kind": "guard", "check": "没有标记的目录原样保留", "ok": tree(nomark) == {"keep.txt": hashlib.sha256(
        b"keep").hexdigest()}})
    afile = os.path.join(out_dir, "afile")
    rmtree_own(afile, out_dir)
    write_bytes(afile, b"x")
    expect_refused(report, "guard", "输出是文件：拒绝", ["content", "unpack", mini, "--out", afile, "--overwrite"], [],
                   "data", "不是目录")

    # 源已有 kbp-FR：防重复解包加过日志的工程
    u3 = os.path.join(out_dir, "u3")
    rmtree_own(u3, out_dir)
    expect_refused(report, "guard", "源 scene.json 已有 kbp-FR：报错", ["content", "unpack", u2, "--out", u3, "--instrument"],
                   [u3], "data", "kbp-FR")

    # scene.json 带注释：--instrument 报 [data]；不加 FR 时照拷
    commented = os.path.join(out_dir, "src", "mini-comment")
    rmtree_own(commented, out_dir)
    write_bytes(os.path.join(commented, "project.json"), json.dumps(MINI_PROJECT).encode("utf-8"))
    text = b'{\n\t// \xe6\xb3\xa8\xe9\x87\x8a\n\t"objects": [{"id": 1, "name": "a"}]\n}'
    write_bytes(os.path.join(commented, "scene.json"), text)
    u4, u5 = os.path.join(out_dir, "u4"), os.path.join(out_dir, "u5")
    rmtree_own(u4, out_dir)
    rmtree_own(u5, out_dir)
    expect_refused(report, "guard", "scene.json 带注释、--instrument：[data]", ["content", "unpack", commented, "--out", u4,
                                                                         "--instrument"], [u4], "data", "注释")
    code, summary, err = kbp(["content", "unpack", commented, "--out", u5])
    add(report, {"kind": "guard", "check": "scene.json 带注释、不加 FR：照拷、工坊 ID 为 null",
                 "ok": code == 0 and read_bytes(os.path.join(u5, "scene.json")) == text and summary.get("workshop") is None
                 and summary.get("fr_id") is None, "stderr": err[-300:] if code else None})
    add(report, {"kind": "guard", "check": "源工程没有被改、--out 下没有临时目录残留",
                 "ok": tree(mini) == src_tree and not any(leftovers(d) for d, _, _ in os.walk(out_dir)),
                 "leftovers": [os.path.join(d, n) for d, _, _ in os.walk(out_dir) for n in leftovers(d)]})


# ==================== real ====================


def check_real(out_dir, report, workshop_id, proto):
    src = libcontent.project_dir(workshop_id)
    before = tree(src)
    real = os.path.join(out_dir, "real")
    t0 = time.time()
    code, summary, err = kbp(["content", "unpack", workshop_id, "--instrument", "--out", real, "--overwrite"])
    seconds = round(time.time() - t0, 1)
    add(report, {"kind": "real", "check": "unpack %s --instrument" % workshop_id, "ok": code == 0,
                 "summary": {k: summary.get(k) for k in ("loose", "extracted", "skipped", "fr_id", "bytes", "workshop")},
                 "seconds": seconds, "stderr": err[-500:] if code else None})
    if code != 0:
        return
    add(report, {"kind": "real", "check": "工坊目录前后不变（只读）", "ok": tree(src) == before, "files": len(before)})
    if not os.path.isdir(proto):
        add(report, {"kind": "real", "check": "原型产物不在，跳过逐文件比", "ok": False, "proto": proto})
        return
    ours, theirs = tree(real), tree(proto)
    only_ours = sorted(set(ours) - set(theirs))
    only_proto = sorted(set(theirs) - set(ours))
    wpe_written = [p for p in only_proto if p.startswith("shaders/blobsSM40/")]
    differ = sorted(p for p in set(ours) & set(theirs) if ours[p] != theirs[p])
    add(report, {"kind": "real", "check": "文件集合：只多 kbp-unpack.json；原型多出的只有 WPE 运行时写的 shaders/blobsSM40",
                 "ok": only_ours == [MARKER] and only_proto == wpe_written, "only_ours": only_ours,
                 "only_proto": only_proto, "common": len(set(ours) & set(theirs))})
    add(report, {"kind": "real", "check": "共有文件除 scene.json 外逐字节相同", "ok": differ in ([], ["scene.json"]),
                 "differ": differ})
    scene_raw = read_bytes(os.path.join(real, "scene.json"))
    proto_raw = read_bytes(os.path.join(proto, "scene.json"))
    scene, proto_scene = json.loads(scene_raw), json.loads(proto_raw)
    fr, proto_fr = scene["objects"][-1], proto_scene["objects"][-1]
    rewritten = json.dumps(proto_scene, indent="\t", ensure_ascii=False).encode("utf-8") == proto_raw
    proto_scene["objects"][-1] = dict(proto_fr, id=fr["id"])
    same_after = json.dumps(proto_scene, indent="\t", ensure_ascii=False).encode("utf-8") == scene_raw
    ids = all_ids(dict(scene, objects=scene["objects"][:-1]))
    proto_clash = [p for v, p in ids if v == proto_fr["id"]]
    add(report, {"kind": "real", "check": "scene.json：只有 FR 的 id 不同（原型 %s 与 effect 撞号，本命令取全部 id 的最大值 + 1）"
                                          % proto_fr["id"],
                 "ok": rewritten and same_after and fr["id"] == max(v for v, _ in ids) + 1
                 and fr["id"] not in [v for v, _ in ids] and fr["name"] == "kbp-FR" and fr == dict(proto_fr, id=fr["id"]),
                 "fr_id": fr["id"], "proto_fr_id": proto_fr["id"], "proto_clash": proto_clash,
                 "objects_max": max(o["id"] for o in scene["objects"][:-1])})
    marker = load_json(os.path.join(real, MARKER))
    add(report, {"kind": "real", "check": "计数同原型实测（18 个散文件、67 个包内条目）",
                 "ok": summary.get("loose") == 18 and summary.get("extracted") == 67 and marker.get("workshop") == workshop_id,
                 "marker": {k: marker.get(k) for k in ("loose", "extracted", "skipped", "fr_id", "bytes", "pkg")}})


# ==================== 入口 ====================

SECTIONS = ["mini", "guard", "real"]


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", default=os.path.join(REPO, "ignore", "kbp", "accept5"))
    parser.add_argument("--only", help="逗号分隔：" + ",".join(SECTIONS))
    parser.add_argument("--real", default="3830255100", help="real 段的工坊 ID")
    parser.add_argument("--proto", default=os.path.join(REPO, "ignore", "p5", "proj", "3830255100-kbp"),
                        help="real 段对照的原型产物")
    args = parser.parse_args()
    out_dir = os.path.abspath(args.out)
    if not os.path.normcase(out_dir).startswith(os.path.normcase(os.path.join(REPO, "ignore")) + os.sep):
        sys.stderr.write("[kbp] --out 要在仓库 ignore/ 下：%s\n" % out_dir)
        return 2
    os.makedirs(out_dir, exist_ok=True)
    only = args.only.split(",") if args.only else SECTIONS
    report, timings, started = [], {}, time.time()
    for section in SECTIONS:
        if section not in only:
            continue
        t0 = time.time()
        try:
            if section == "real":
                check_real(out_dir, report, args.real, os.path.abspath(args.proto))
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
