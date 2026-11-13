"""kbp-tools 第 6 批（最终走查的工具）的验收自测：kbp content isolate（复制工程）与 kbp cmp frames（按帧序列批量比）。

    python -X utf8 -I .claude/skills/kbp-tools/tests/accept6.py [--out ignore/kbp/accept6] [--only js,mini,guard,frames,real]
                                                             [--real 3146703458]

全部输出在 --out 下（要在仓库 ignore/ 下）；WPE 安装目录、工坊目录只读（real 段前后核对源目录哈希）。
- js：js_scan（注释里的不算、转义、模板串与 ${} 里的字面量）、index_usages（getLayer 的非字面量参数、按名字的脚本属性不算、
  IScene 的枚举接口）、parse_fix / apply_pointer。
- mini：在 <out>/src/ 下造小工程（一份材质在 scene.pkg 里、一份带注释），覆盖闭包的每个原因：requested、parent（含新加入对象的父链）、
  dependency（数字与 {id} 对象两种元素）、rt-ref（对象 JSON → effect.json → 包内材质；带注释的材质也能读）、script-name（脚本字面量、
  模板串 ${} 里的字面量、scriptproperties 的字符串；注释里的不算）、light、camera、kbp-FR；--drop 去掉相机；--fix 两条（按名字与 id）；
  五种警告（drop、script-index、dependency-union、fullframebuffer、removed-script-name）；标记、标题、kbp-unpack.json 并存、
  先套 fix 再算闭包（把脚本换掉后它拉进来的对象不再保留）、缺省输出位置、源工程不变。
- guard：名字不唯一、找不到、fix 路径不存在、fix 的对象不保留、fix 不是 JSON、同时 keep 与 drop、没有 keep、输出已存在不加
  --overwrite：都拒绝且不留输出与临时目录；--overwrite 整个换掉。
- frames：自己造 PNG：逐像素相同、有小差、有大块差、两边各缺一帧；配对、汇总、只给有差的帧写热图（覆盖时删掉变相同的帧的旧热图）、
  不覆盖时拒绝、模式匹配到同一帧两个文件报错、--frames 过滤；每帧结果和 cmp frame 的同一张逐项相同。
- real：真实工坊场景（只读）：isolate --keep text1 的保留集合按闭包规则推出（父链、scriptproperties 里的声音对象名、声音对象的父链）、
  名字不唯一报错；产物除 scene.json、project.json、两个标记外和 unpack 逐字节相同，scene.json 里的对象和源里的逐个相同；
  --instrument 的 FR id 和 unpack --instrument 相同。
结果写 <out>/report.json（--only 时 report-<段>.json），每项一行打到 stdout。
"""

import argparse
import json
import os
import sys
import time

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import accept5 as a5  # noqa: E402  （公共件：kbp()、add()、tree()、write_pkg() …；同时把 kbp 登记成包）
from kbp import content as libcontent  # noqa: E402
from kbp import isolate as libiso  # noqa: E402
from kbp.common import KbpError  # noqa: E402

REPO = a5.REPO
kbp, add, tree, rmtree_own, write_bytes, read_bytes, load_json = (a5.kbp, a5.add, a5.tree, a5.rmtree_own, a5.write_bytes,
                                                                   a5.read_bytes, a5.load_json)
ISO_MARKER = "kbp-isolate.json"


def expect_refused(report, kind, check, args, created, layer, needle=None):
    a5.expect_refused(report, kind, check, args, created, layer, needle)


# ==================== js ====================


def check_js(out_dir, report):
    src = r"""'use strict';
// 'commented'
/* "alsocommented" */
import * as X from 'WEMath';
let a = thisScene.getLayer('helper'), b = thisScene.getLayer(idx);
let c = `tmpl-${'inner' + `x${"deep"}`}`, d = thisScene.getLayer(scriptProperties.other);
let e = "esc\"apedA\x42", f = 'it\'s', g = thisScene.getLayer(scriptProperties.num);
let h = thisScene.enumerateLayers(); let i = `plain`;
"""
    code, literals = libiso.js_scan(src)
    add(report, {"kind": "js", "check": "字面量：注释里的不算、转义、模板串（${} 里的也收、有 ${} 的整串不算）",
                 "ok": literals == ["use strict", "WEMath", "helper", "inner", "deep", 'esc"apedAB', "it's", "plain"],
                 "literals": literals})
    uses = libiso.index_usages(code, {"other"})
    add(report, {"kind": "js", "check": "按下标：getLayer(变量)、getLayer(非字符串属性)、enumerateLayers；字面量与字符串属性不算",
                 "ok": uses == ["getLayer(idx)", "getLayer(scriptProperties.num)", "enumerateLayers"], "uses": uses})
    node = {"a": {"b": [1, {"c~/d": 2}]}}
    old = libiso.apply_pointer(node, "/a/b/1/c~0~1d", {"x": 1})
    errors = []
    for pointer in ("/a/zz", "/a/b/5", "/a/b/0/x", "/a/b/-"):
        try:
            libiso.apply_pointer(node, pointer, 0)
            errors.append(None)
        except KbpError as e:
            errors.append(e.layer)
    fix = libiso.parse_fix('名字:含冒号:/origin="1 2 3"')
    add(report, {"kind": "js", "check": "JSON 指针（~0 ~1 转义、路径不存在报 [data]）、--fix 的切分（名字可带冒号）",
                 "ok": old == 2 and node["a"]["b"][1]["c~/d"] == {"x": 1} and errors == ["data"] * 4
                 and fix == ("名字:含冒号", "/origin", "1 2 3"), "errors": errors, "fix": fix})


# ==================== mini ====================

TARGET_SCRIPT = r"""'use strict';
// thisScene.getLayer('commented')
/* "alsocommented" */
export function update(value) {
	let a = thisScene.getLayer('helper');
	let b = thisScene.getLayer(idx);
	let c = `tmpl-${'inner'}`;
	thisScene.getLayer(scriptProperties.other).visible = true;
	return value;
}
"""


def mini_scene():
    img = lambda oid, name, **kw: dict({"id": oid, "name": name, "image": "models/util/solidlayer.json",  # noqa: E731
                                        "origin": "960 540 0", "size": "10 10"}, **kw)
    return {
        "general": {"orthogonalprojection": {"width": 1920, "height": 1080}, "clearcolor": "0 0 0"},
        "objects": [
            img(1, "bg"),
            {"id": 2, "name": "grp", "origin": "0 0 0"},
            img(3, "target", parent=2, dependencies=[4, {"id": 17, "type": "emitterimage"}],
                effects=[{"id": 40, "file": "effects/fx/effect.json",
                          "passes": [{"id": 41, "constantshadervalues": {"k": 0.25}}]}],
                alpha={"script": TARGET_SCRIPT, "scriptproperties": {"other": "prop-target", "n": 3}, "value": 1}),
            dict(img(4, "depended"), image="models/cm.json"),
            img(5, "rtsrc"),
            img(6, "helper", parent=8),
            img(7, "prop-target"),
            {"id": 8, "name": "helperparent", "origin": "0 0 0"},
            {"id": 9, "name": "light1", "light": "point", "origin": "0 0 100"},
            {"id": 10, "name": "cam", "camera": "default", "origin": "0 0 0"},
            img(11, "dropper", dependencies=[3]),
            img(12, "removedscript", color={"script": "thisScene.getLayer('target');", "value": "1 1 1"}),
            dict(img(13, "compose"), image="models/fb.json"),
            img(14, "dup"),
            img(15, "dup"),
            img(17, "emitimg"),
            img(18, "viacomment"),
            img(19, "commented"),
            img(20, "alsocommented"),
            img(21, "inner"),
        ],
        "version": 3,
    }


# 闭包：target（requested）→ grp（parent）、depended（dependency）、emitimg（dependency 的 {id}）、rtsrc（rt-ref，effect.json → 包内材质）、
# helper / inner（脚本字面量）、prop-target（scriptproperties）；depended → viacomment（rt-ref，带注释的包内材质）；helper → helperparent（parent）；
# compose（requested）；light1（light）；cam 是相机但被 --drop
MINI_KEPT = {2: ["parent"], 3: ["requested"], 4: ["dependency"], 5: ["rt-ref"], 6: ["script-name"], 7: ["script-name"],
             8: ["parent"], 9: ["light"], 13: ["requested"], 17: ["dependency"], 18: ["rt-ref"], 21: ["script-name"]}


def make_mini(root):
    rmtree_own(root, os.path.dirname(os.path.dirname(root)))
    write_bytes(os.path.join(root, "project.json"), json.dumps(
        {"file": "scene.json", "type": "scene", "title": "mini6"}, indent="\t").encode("utf-8"))
    write_bytes(os.path.join(root, "scene.json"), json.dumps(mini_scene(), indent="\t", ensure_ascii=False).encode("utf-8"))
    write_bytes(os.path.join(root, "effects", "fx", "effect.json"),
                b'{"passes": [{"material": "materials/fx.json"}]}')
    write_bytes(os.path.join(root, "models", "cm.json"), b'{"material": "materials/cm.json"}')
    write_bytes(os.path.join(root, "models", "fb.json"), b'{"material": "materials/fb.json"}')
    write_bytes(os.path.join(root, "materials", "fb.json"), b'{"passes": [{"textures": ["_rt_FullFrameBuffer"]}]}')
    a5.write_pkg(os.path.join(root, "scene.pkg"), [
        ("materials/fx.json", b'{"passes": [{"shader": "x", "textures": [null, "_rt_imageLayerComposite_5_a"]}]}'),
        ("materials/cm.json", b'{\n\t// note\n\t"passes": [{"textures": ["_rt_imageLayerComposite_18_a",],},],\n}'),
    ])


def check_mini(out_dir, report):
    src = os.path.join(out_dir, "src", "mini6")
    make_mini(src)
    src_tree = tree(src)
    out = os.path.join(out_dir, "iso1")
    rmtree_own(out, out_dir)
    code, summary, err = kbp(["content", "isolate", src, "--keep", "target,13", "--drop", "cam", "--fix",
                              'target:/origin="1 2 3"', "--fix", "3:/effects/0/passes/0/constantshadervalues/k=0.5",
                              "--name", "t1", "--out", out, "--instrument"])
    if code != 0:
        add(report, {"kind": "mini", "check": "isolate 跑通", "ok": False, "stderr": err[-600:]})
        return
    scene = load_json(os.path.join(out, "scene.json"))
    marker = load_json(os.path.join(out, ISO_MARKER))
    ids = [o.get("id") for o in scene["objects"]]
    kept_reasons = {k["id"]: sorted({r["reason"] for r in k["reasons"]}) for k in marker["kept"]}
    want = dict(MINI_KEPT)
    want[42] = ["kbp-FR"]
    add(report, {"kind": "mini", "check": "保留集合与每个对象的原因（含 FR，id 42 = 全部 id 的最大值 + 1），objects 顺序不变",
                 "ok": kept_reasons == {k: sorted(v) for k, v in want.items()}
                 and ids == [o["id"] for o in mini_scene()["objects"] if o["id"] in MINI_KEPT] + [42]
                 and summary.get("kept") == 13 and summary.get("removed") == 8 and summary.get("fr_id") == 42,
                 "kept": kept_reasons, "ids": ids})
    reasons = {k["id"]: k["reasons"] for k in marker["kept"]}
    detail_ok = ({"reason": "script-name", "from": 3, "literal": "prop-target", "via": "scriptproperties",
                  "at": "/alpha/script"} in reasons[7]
                 and {"reason": "rt-ref", "from": 4, "rt": "_rt_imageLayerComposite_18_"} in reasons[18]
                 and {"reason": "parent", "from": 6} in reasons[8]
                 and any(r.get("literal") == "inner" and r.get("via") == "script" for r in reasons[21]))
    add(report, {"kind": "mini", "check": "原因的细节：scriptproperties、带注释材质里的 rt-ref、新加入对象的父链、模板串里的字面量",
                 "ok": detail_ok, "reasons": {k: reasons[k] for k in (7, 8, 18, 21)}})
    kinds = sorted(w["kind"] for w in marker["warnings"])
    by_kind = {w["kind"]: w for w in marker["warnings"]}
    add(report, {"kind": "mini", "check": "警告：drop（相机）、script-index、dependency-union、fullframebuffer、removed-script-name",
                 "ok": kinds == sorted(["drop", "script-index", "dependency-union", "fullframebuffer", "removed-script-name"])
                 and "camera" in by_kind["drop"]["message"] and by_kind["drop"]["object"] == 10
                 and "getLayer(idx)" in by_kind["script-index"]["message"]
                 and "scriptProperties.other" not in by_kind["script-index"]["message"]
                 and by_kind["dependency-union"]["object"] == 3 and "dropper" in by_kind["dependency-union"]["message"]
                 and by_kind["fullframebuffer"]["object"] == 13 and by_kind["removed-script-name"]["object"] == 12
                 and summary.get("warnings") == [w["message"] for w in marker["warnings"]],
                 "warnings": marker["warnings"]})
    target = next(o for o in scene["objects"] if o["id"] == 3)
    add(report, {"kind": "mini", "check": "--fix 两条（按名字、按 id）套上，标记记旧值",
                 "ok": target["origin"] == "1 2 3" and target["effects"][0]["passes"][0]["constantshadervalues"]["k"] == 0.5
                 and marker["fixes"] == [
                     {"object": 3, "name": "target", "pointer": "/origin", "value": "1 2 3", "old": "960 540 0"},
                     {"object": 3, "name": "target", "pointer": "/effects/0/passes/0/constantshadervalues/k", "value": 0.5,
                      "old": 0.25}],
                 "fixes": marker["fixes"]})
    project = load_json(os.path.join(out, "project.json"))
    unpack_marker = load_json(os.path.join(out, "kbp-unpack.json"))
    kept_objects = {o["id"]: o for o in scene["objects"]}
    same_objects = all(kept_objects[o["id"]] == o for o in mini_scene()["objects"] if o["id"] in MINI_KEPT and o["id"] != 3)
    add(report, {"kind": "mini", "check": "标题加「 (iso t1)」；kbp-unpack.json 并存（instrument、fr_id）；别的对象原样；包内材质解出；标记字段",
                 "ok": project["title"] == "mini6 (kbp) (iso t1)" and marker["title"] == project["title"]
                 and unpack_marker["instrument"] is True and unpack_marker["fr_id"] == 42 and same_objects
                 and os.path.isfile(os.path.join(out, "materials", "fx.json")) and not os.path.exists(os.path.join(out, "scene.pkg"))
                 and marker["keep"] == ["target", "13"] and marker["drop"] == ["cam"] and marker["name"] == "t1"
                 and [r["id"] for r in marker["removed"]] == [1, 10, 11, 12, 14, 15, 19, 20]
                 and os.path.normcase(summary.get("marker", "")) == os.path.normcase(os.path.join(out, ISO_MARKER)),
                 "title": project["title"]})

    # 先套 fix 再算闭包：把脚本换掉，它拉进来的 helper / helperparent / inner 不再保留（scriptproperties 还在，prop-target 照留）
    data = os.path.join(out_dir, "data")
    default_out = os.path.join(data, "proj", "mini6-iso-target")
    rmtree_own(default_out, out_dir)
    code, summary, err = kbp(["content", "isolate", src, "--keep", "target", "--fix", 'target:/alpha/script="noop"',
                              "--data", data])
    kept = sorted(o[0] for o in summary.get("kept_objects") or [])
    add(report, {"kind": "mini", "check": "先套 fix 再算闭包；缺省输出 <data>/proj/<名>-iso-<keep>；不 instrument 时没有 FR；相机缺省保留",
                 "ok": code == 0 and os.path.normcase(summary.get("out", "")) == os.path.normcase(default_out)
                 and kept == [2, 3, 4, 5, 7, 9, 10, 17, 18] and summary.get("fr_id") is None,
                 "kept": kept, "stderr": err[-300:] if code else None})
    add(report, {"kind": "mini", "check": "源工程没有被改", "ok": tree(src) == src_tree})


# ==================== guard ====================


def check_guard(out_dir, report):
    src = os.path.join(out_dir, "src", "mini6")
    if not os.path.isdir(src):
        make_mini(src)
    out = os.path.join(out_dir, "g1")
    rmtree_own(out, out_dir)
    base = ["content", "isolate", src, "--out", out]
    for check, extra, layer, needle in (
            ("名字不唯一", ["--keep", "dup"], "data", "不唯一"),
            ("找不到", ["--keep", "nosuch"], "data", "找不到"),
            ("fix 路径不存在", ["--keep", "target", "--fix", "target:/nokey/x=1"], "data", "不存在"),
            ("fix 的对象不保留", ["--keep", "target", "--fix", "bg:/origin=\"0 0 0\""], "data", "不在保留集合"),
            ("fix 的值不是 JSON", ["--keep", "target", "--fix", "target:/origin=0 0 0"], "kbp", "不是 JSON"),
            ("同时 keep 与 drop", ["--keep", "target", "--drop", "3"], "kbp", "同时"),
            ("--drop 找不到", ["--keep", "target", "--drop", "nosuch"], "data", "找不到")):
        expect_refused(report, "guard", check, base + extra, [out], layer, needle)
    code, _, err = kbp(base + ["--keep", "target"])
    before = tree(out) if code == 0 else {}
    expect_refused(report, "guard", "输出已存在、不加 --overwrite：拒绝且不动", base + ["--keep", "target"], [], "data", "已存在")
    write_bytes(os.path.join(out, "stale.txt"), b"x")
    code2, summary, err2 = kbp(base + ["--keep", "13", "--overwrite"])
    add(report, {"kind": "guard", "check": "--overwrite：整个换掉（旧的多余文件不在了，标记换成新的）",
                 "ok": code == 0 and tree(out) != before and code2 == 0 and not os.path.exists(os.path.join(out, "stale.txt"))
                 and load_json(os.path.join(out, ISO_MARKER))["keep"] == ["13"]
                 and not any(".kbp-unpack-" in n for n in os.listdir(out_dir)),
                 "stderr": (err or err2)[-300:] if code or code2 else None})
    nomark = os.path.join(out_dir, "nomark6")
    rmtree_own(nomark, out_dir)
    write_bytes(os.path.join(nomark, "keep.txt"), b"keep")
    expect_refused(report, "guard", "没有 kbp-unpack.json 的目录 --overwrite：拒绝", ["content", "isolate", src, "--keep", "target",
                                                                               "--out", nomark, "--overwrite"], [], "data",
                   "kbp-unpack.json")
    expect_refused(report, "guard", "ignore/ 之外：拒绝", ["content", "isolate", src, "--keep", "target", "--out",
                                                    os.path.join(REPO, "kbp-accept6-outside")],
                   [os.path.join(REPO, "kbp-accept6-outside")], "kbp", "ignore/")


# ==================== frames ====================


def _png(path, size=(64, 48), patch=None):
    from PIL import Image

    im = Image.new("RGB", size, (10, 20, 30))
    px = im.load()
    for y in range(size[1]):
        for x in range(size[0]):
            px[x, y] = ((x * 3) % 256, (y * 5) % 256, 40)
    for (x0, y0, x1, y1, delta) in patch or []:
        for y in range(y0, y1):
            for x in range(x0, x1):
                r, g, b = px[x, y]
                px[x, y] = (min(255, r + delta), g, b)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    im.save(path)


def check_frames(out_dir, report):
    root = os.path.join(out_dir, "frames")
    rmtree_own(root, out_dir)
    ours, wpe = os.path.join(root, "ours"), os.path.join(root, "wpe")
    for f in (1, 2, 3, 4):
        _png(os.path.join(ours, "ours-f%d.png" % f))
    _png(os.path.join(wpe, "wpe-tag-fps20-1920x1080-f1.png"))
    _png(os.path.join(wpe, "wpe-tag-fps20-1920x1080-f2.png"), patch=[(5, 5, 6, 6, 3)])
    _png(os.path.join(wpe, "wpe-tag-fps20-1920x1080-f3.png"), patch=[(0, 0, 40, 40, 90)])
    _png(os.path.join(wpe, "wpe-tag-fps20-1920x1080-f5.png"))
    write_bytes(os.path.join(wpe, "wpe-tag-fps20-1920x1080.json"), b"[]")  # kbp rdc frame 的索引不算帧
    heat = os.path.join(root, "heat")
    write_bytes(os.path.join(heat, "heat-f1.png"), b"stale")  # 上一次 f1 有差留下的
    report_path = os.path.join(root, "report.txt")
    args = ["cmp", "frames", ours, wpe, "--heat-dir", heat, "--out", report_path, "--cell", "8"]
    expect_refused(report, "frames", "热图已存在、不加 --overwrite：拒绝，不写报告", args, [report_path], "data", "热图已存在")
    code, summary, err = kbp(args + ["--overwrite"])
    data = load_json(report_path + ".json") if code == 0 else {}
    rows = {r["frame"]: r for r in data.get("frames", [])}
    add(report, {"kind": "frames", "check": "配对、汇总：相同 1 帧、有差 2、3，最大差最大的是 3，两边各缺的帧",
                 "ok": code == 0 and summary.get("compared") == 3 and summary.get("same") == 1 and summary.get("differ") == [2, 3]
                 and summary.get("worst") == 3 and summary.get("missing") == {"ours": [5], "wpe": [4]}
                 and rows[2]["counts"]["0"] == 1 and rows[2]["max"] == 3 and rows[3]["counts"]["32"] == 1600,
                 "summary": summary, "stderr": err[-300:] if code else None})
    add(report, {"kind": "frames", "check": "只给有差的帧写热图，覆盖时删掉这次相同的帧的旧热图",
                 "ok": sorted(os.listdir(heat)) == ["heat-f2.png", "heat-f3.png"] and summary.get("heats") == 2,
                 "heat": sorted(os.listdir(heat)) if os.path.isdir(heat) else None})
    one = os.path.join(root, "one-f3.txt")
    code1, _, _ = kbp(["cmp", "frame", os.path.join(ours, "ours-f3.png"), os.path.join(wpe, "wpe-tag-fps20-1920x1080-f3.png"),
                       "--cell", "8", "--out", one, "--overwrite"])
    single = load_json(one + ".json") if code1 == 0 else {}
    keys = ("counts", "max", "mean", "blobs", "size", "excluded", "fit")
    add(report, {"kind": "frames", "check": "每帧结果和 cmp frame 的同一张逐项相同（同一份实现）",
                 "ok": code1 == 0 and all(single.get(k) == rows[3].get(k) for k in keys),
                 "differ": [k for k in keys if single.get(k) != rows[3].get(k)]})
    code, summary, _ = kbp(["cmp", "frames", ours, wpe, "--frames", "1-2,9"])
    add(report, {"kind": "frames", "check": "--frames 过滤；不给 --out 时行放进摘要；缺的帧（9）列出来",
                 "ok": code == 0 and summary.get("compared") == 2 and summary.get("missing") == {"ours": [9], "wpe": [9]}
                 and isinstance(summary.get("text"), list), "summary": {k: summary.get(k) for k in ("compared", "missing")}})
    _png(os.path.join(wpe, "wpe-other-f2.png"))
    expect_refused(report, "frames", "模式匹配到同一帧两个文件：[data]", ["cmp", "frames", ours, wpe], [], "data", "两个文件")
    code, summary, _ = kbp(["cmp", "frames", ours, wpe, "--wpe-pattern", "wpe-other-f{frame}.png"])
    add(report, {"kind": "frames", "check": "--wpe-pattern 写具体（另一个标签）", "ok": code == 0 and summary.get("same") == 1
                 and summary.get("missing") == {"ours": [], "wpe": [1, 3, 4]}, "summary": summary})


# ==================== real ====================

# 3146703458（女神异闻录3 音乐播放器）里 --keep text1 按规则推出的保留集合：
# - 59 text1（requested）→ 父 66；
# - 59 的 visible 脚本经 getLayer(scriptProperties.voiceN) 按名字找声音：scriptproperties 里 voice0–7 是 8 个声音对象的名字
#   241、128、20、151、152、153、140、213（script-name，via scriptproperties）；
# - 声音对象的父链：128 → 59、20 → 143 → 171、151 → 91 → 180、152 → 106 → 189、153 → 117 → 197、140 → 80 → 205；
# - 多出来的 text2–6 的脚本属性指向的是同一组声音，不再加人；146 的 pic1「Persona」不在闭包里（146 没被保留）。
REAL_KEPT = {59, 66, 241, 128, 20, 151, 152, 153, 140, 213, 143, 171, 91, 180, 106, 189, 117, 197, 80, 205}


def check_real(out_dir, report, workshop_id):
    src = libcontent.project_dir(workshop_id)
    before = tree(src)
    iso = os.path.join(out_dir, "real-iso")
    unp = os.path.join(out_dir, "real-unpack")
    t0 = time.time()
    code, summary, err = kbp(["content", "isolate", workshop_id, "--keep", "text1", "--out", iso, "--overwrite"])
    code_u, _, err_u = kbp(["content", "unpack", workshop_id, "--out", unp, "--overwrite"])
    seconds = round(time.time() - t0, 1)
    if code or code_u:
        add(report, {"kind": "real", "check": "isolate / unpack 跑通", "ok": False, "stderr": (err or err_u)[-500:]})
        return
    marker = load_json(os.path.join(iso, ISO_MARKER))
    kept = {k["id"] for k in marker["kept"]}
    reasons = {k["id"]: k["reasons"] for k in marker["kept"]}
    add(report, {"kind": "real", "check": "保留集合按闭包规则推出（父链、scriptproperties 的声音名、声音对象的父链），没有警告",
                 "ok": kept == REAL_KEPT and summary.get("removed") == 9 and not marker["warnings"]
                 and {"reason": "parent", "from": 59} in reasons[66]
                 and any(r["reason"] == "script-name" and r["via"] == "scriptproperties" and r["from"] == 59 for r in reasons[128]),
                 "extra": sorted(kept - REAL_KEPT), "missing": sorted(REAL_KEPT - kept), "seconds": seconds})
    a, b = tree(iso), tree(unp)
    differ = sorted(k for k in set(a) & set(b) if a[k] != b[k])
    add(report, {"kind": "real", "check": "产物除 scene.json、project.json、两个标记外和 unpack 逐字节相同",
                 "ok": sorted(set(a) ^ set(b)) == [ISO_MARKER]
                 and differ == ["kbp-unpack.json", "project.json", "scene.json"], "differ": differ,
                 "only": sorted(set(a) ^ set(b))})
    original = load_json(os.path.join(unp, "scene.json"))
    scene = load_json(os.path.join(iso, "scene.json"))
    by_id = {o["id"]: o for o in original["objects"]}
    add(report, {"kind": "real", "check": "scene.json：objects 是源的子序列、每个对象原样，其余顶层键不变",
                 "ok": scene["objects"] == [o for o in original["objects"] if o["id"] in kept]
                 and all(by_id[o["id"]] == o for o in scene["objects"])
                 and {k: v for k, v in scene.items() if k != "objects"} == {k: v for k, v in original.items() if k != "objects"}})
    expect_refused(report, "real", "名字不唯一（多边形 1 有 6 个）：[data]", ["content", "isolate", workshop_id, "--keep", "多边形 1",
                                                                  "--out", os.path.join(out_dir, "real-dup")],
                   [os.path.join(out_dir, "real-dup")], "data", "不唯一")
    iso_fr = os.path.join(out_dir, "real-iso-fr")
    unp_fr = os.path.join(out_dir, "real-unpack-fr")
    c1, s1, _ = kbp(["content", "isolate", workshop_id, "--keep", "16", "--instrument", "--out", iso_fr, "--overwrite"])
    c2, s2, _ = kbp(["content", "unpack", workshop_id, "--instrument", "--out", unp_fr, "--overwrite"])
    fr_iso = load_json(os.path.join(iso_fr, "scene.json"))["objects"][-1] if c1 == 0 else {}
    fr_unp = load_json(os.path.join(unp_fr, "scene.json"))["objects"][-1] if c2 == 0 else {}
    add(report, {"kind": "real", "check": "--instrument：FR 与 unpack --instrument 的逐项相同（id 按整个源场景算），留 16 + FR",
                 "ok": c1 == 0 and c2 == 0 and fr_iso == fr_unp and s1.get("fr_id") == s2.get("fr_id")
                 and [k[0] for k in s1.get("kept_objects")] == [16, s1.get("fr_id")], "fr_id": s1.get("fr_id")})
    add(report, {"kind": "real", "check": "工坊目录前后不变（只读）", "ok": tree(src) == before, "files": len(before)})


# ==================== 入口 ====================

SECTIONS = ["js", "mini", "guard", "frames", "real"]


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", default=os.path.join(REPO, "ignore", "kbp", "accept6"))
    parser.add_argument("--only", help="逗号分隔：" + ",".join(SECTIONS))
    parser.add_argument("--real", default="3146703458", help="real 段的工坊 ID")
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
                check_real(out_dir, report, args.real)
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
