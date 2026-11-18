"""`kbp rdc track` scene 认法的自测（不起 RenderDoc）：计划（py/scene_track.py）、[kbp] 日志的时钟、按计划分槽与起名（rdc/track.py）；
以及 `kbp cmp random` 出注入表的配对（py/cmp.py 的 build_random）。

    python -X utf8 -I .claude/skills/kbp-tools/tests/scene_track.py

工程在系统临时目录里现造，跑完删掉。每项一行打到 stdout，有失败时退出码 1。
"""

import json
import os
import shutil
import sys
import tempfile

sys.dont_write_bytecode = True
SKILL = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, SKILL)

from kbp import scene_track  # noqa: E402
from kbp.cmp import ENCODE, build_random  # noqa: E402
from kbp.common import KbpError  # noqa: E402
from rdc.track import assign_scene, name_scene  # noqa: E402

FAILED = []


def check(name, got, want):
    ok = got == want
    print("%s %s" % ("ok  " if ok else "FAIL", name))
    if not ok:
        print("     got  %r\n     want %r" % (got, want))
        FAILED.append(name)


def write(root, rel, obj):
    path = os.path.join(root, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(obj if isinstance(obj, str) else json.dumps(obj, ensure_ascii=False))


def particle(material="materials/p.json", children=None, renderers=1, maxcount=None):
    spec = {"material": material, "renderer": [{"name": "sprite"}] * renderers}
    if children is not None:
        spec["children"] = children
    if maxcount is not None:
        spec["maxcount"] = maxcount
    return spec


def keys(plan):
    return [(s["key"], s["kind"], s["renderers"]) for s in plan["slots"]]


def names(counts, plan):
    assigned, reason = assign_scene(counts, plan["slots"])
    return name_scene(assigned) if assigned else reason


def main():
    root = tempfile.mkdtemp(prefix="kbp-scene-track-")
    try:
        write(root, "project.json", {"file": "scene.json", "type": "scene"})
        write(root, "particles/a.json", particle(children=[
            {"name": "particles/b.json"},                          # 缺 type 当 static
            {"name": "particles/e.json", "type": "eventdeath", "maxcount": 3},
            {"name": "particles/b.json", "type": "Static"},        # 大小写不同：不认，不占下标
            {"name": "particles/missing.json"},                    # 读不到：不占下标
            {"name": "particles/c.json", "type": "static"},
        ], maxcount=50))
        write(root, "particles/b.json", particle(maxcount=20))
        write(root, "particles/c.json", particle(renderers=2))
        # 事件子系统的 maxcount 要给：不给时末尾那次 9 个粒子的绘制也可能是第 3 个实例，分法就不唯一了
        write(root, "particles/e.json", particle(maxcount=2))
        write(root, "particles/nomat.json", {"renderer": [{"name": "sprite"}]})
        write(root, "scene.json", {"objects": [
            {"id": 1, "name": "叶子", "particle": "particles/a.json"},
            {"id": 2, "name": "图", "image": "models/x.json"},
            {"id": 3, "name": "叶子", "particle": "particles/b.json"},
            {"id": 4, "name": "藏", "particle": "particles/b.json", "visible": {"user": "p", "value": False}},
            {"id": 5, "name": "组", "visible": False},
            {"id": 6, "name": "组里", "particle": "particles/b.json", "parent": 5},
            {"id": 7, "name": "无材质", "particle": "particles/nomat.json"},
            {"id": 9, "name": "kbp-FR", "image": "models/kbp/fr.json"},
        ]})
        check("认出 --instrument 的工程", scene_track.instrumented(root), True)
        plan = scene_track.build_plan(root)
        # 先序：父 → static 子树（按认得的条目编号）→ 事件；同名第二个起带 objects 下标（不是 id）；隐藏的（含父链）与无材质的不画
        check("计划的槽", keys(plan), [
            ("叶子", "static", 1), ("叶子/0", "static", 1), ("叶子/2", "static", 2), ("叶子/1", "event", 1),
            ("叶子#2", "static", 1),
        ])
        check("事件槽的上限取条目 maxcount", [s.get("cap") for s in plan["slots"]], [None, None, None, 3, None])
        check("对象表", [(o["key"], o["visible"]) for o in plan["objects"]],
              [("叶子", True), ("叶子#2", True), ("藏", False), ("组里", False), ("无材质", True)])
        check("读不到的子系统记一条说明", any("missing.json" in n for n in plan["notes"]), True)

        # 全都活着：两个 renderer 的槽连着两次，事件实例 #k
        check("全都活着", names([5, 4, 7, 7, 1, 1, 9], plan),
              ["叶子", "叶子/0", "叶子/2", "叶子/2@2", "叶子/1", "叶子/1#2", "叶子#2"])
        # 两次 renderer 粒子数不同：不是同一个系统，对不上
        check("两个 renderer 粒子数不同就对不上", isinstance(names([5, 4, 7, 6, 1, 9], plan), str), True)
        # maxcount 消歧：只剩一次 30 个粒子的绘制，只有「叶子」（50）装得下，b（20）装不下
        solo = {"slots": [{"key": "a", "kind": "static", "renderers": 1, "maxcount": 50},
                          {"key": "b", "kind": "static", "renderers": 1, "maxcount": 20}]}
        check("maxcount 消歧", names([30], solo), ["a"])
        check("两种分法就不起名", "不止一种分法" in names([10], solo), True)
        check("多出来的绘制对不上", "对不上计划" in names([10, 10, 10], solo), True)
        events = {"slots": [{"key": "p", "kind": "static", "renderers": 1, "maxcount": 5},
                            {"key": "p/0", "kind": "event", "renderers": 1, "maxcount": None, "cap": 2}]}
        check("事件实例数封顶", "对不上计划" in names([5, 1, 1, 1], events), True)
        check("事件实例", names([5, 1, 1], events), ["p", "p/0", "p/0#2"])
        tree = {"slots": [{"key": "p", "kind": "static", "renderers": 1, "maxcount": None},
                          {"key": "p/0", "kind": "event-tree", "renderers": 1, "maxcount": None}]}
        check("带子系统的事件子系统整帧不起名", "带子系统" in names([1], tree), True)

        # [kbp] 日志：@f64 与旧的 toFixed(6) 都读，五列的光标不要
        write(root, "log.txt", "x [kbp] @f64 221,0.05064940080046654,11.056136131286621,2246,1036 222,0.05,11.1,1,2\n"
                               "y [kbp] 223,0.050000,11.150000\nz 无关\n")
        clock = scene_track.read_log_clock(os.path.join(root, "log.txt"))
        check("日志时钟", clock, {221: [0.05064940080046654, 11.056136131286621], 222: [0.05, 11.1],
                                223: [0.05, 11.15]})
        write(root, "empty.txt", "没有条目\n")
        try:
            scene_track.read_log_clock(os.path.join(root, "empty.txt"))
            check("没有条目的日志报错", "没报错", "KbpError")
        except KbpError:
            check("没有条目的日志报错", "KbpError", "KbpError")
        write(root, "scene.json", {"objects": [{"id": 1, "name": "a", "particle": "particles/b.json"}]})
        check("没有 kbp-FR 的工程不认", scene_track.instrumented(root), False)
    finally:
        shutil.rmtree(root, ignore_errors=True)

    # kbp cmp random：按数组顺序配对，我们第一遍的出生序号 k = round(frame · ENCODE)，WPE 的 R 取 TEXCOORD1 的 w
    def ours(frame, ks, xs=None):
        return {"frame": frame, "systems": {"s": [{"pos": [x, 0, 0], "thick": [0, 0, 0, k / ENCODE]}
                                                  for k, x in zip(ks, xs or range(len(ks)))]}}

    def theirs(frame, rs, xs=None):
        return {"frame": frame, "systems": {"s": [{"pos": [x, 0, 0], "TEXCOORD1": [0, 0, 0, r]}
                                                  for r, x in zip(rs, xs or range(len(rs)))]}}

    table, notes = build_random({"frames": [ours(5, [7, 3]), ours(6, [3, 9])]},
                                {"frames": [theirs(5, [0.7, 0.3]), theirs(6, [0.3, 0.9])]}, "s")
    check("两帧合并成出生序号 → R", table, {7: 0.7, 3: 0.3, 9: 0.9})
    check("每帧的配对数与位置差", [(n["frame"], n["pairs"], n["pos"]) for n in notes], [(5, 2, 0.0), (6, 2, 0.0)])

    def raises(name, *args, **kwargs):
        try:
            build_random(*args, **kwargs)
            check(name, "没报错", "KbpError")
        except KbpError as error:
            check(name, "KbpError", "KbpError")
            print("     %s" % error)

    raises("位置对不上就拒绝（数组顺序不同）",
           {"frames": [ours(5, [1, 2], [0, 1])]}, {"frames": [theirs(5, [0.1, 0.2], [1, 0])]}, "s")
    raises("同一出生序号两帧对到不同的 R",
           {"frames": [ours(5, [1]), ours(6, [1])]}, {"frames": [theirs(5, [0.1]), theirs(6, [0.2])]}, "s")
    raises("粒子数不同就拒绝", {"frames": [ours(5, [1, 2])]}, {"frames": [theirs(5, [0.1])]}, "s")
    table, notes = build_random({"frames": [ours(5, [1])]}, {"frames": [theirs(5, [0.1]), theirs(6, [0.2])]}, "s",
                                frames={5})
    check("--frames 只用指定的帧", table, {1: 0.1})
    print("%d 项失败" % len(FAILED) if FAILED else "全部通过")
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
