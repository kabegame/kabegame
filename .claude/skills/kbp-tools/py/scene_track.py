"""`kbp rdc track` 的 scene 认法（真实壁纸的解包 / 复制工程）在本机一侧要备的料：认工程、绘制计划、[kbp] 日志里的时钟。

`kbp content unpack --instrument` / `kbp content isolate --instrument` 出的工程只有 `objects` 末尾一个只写日志的 `kbp-FR`，没有 CLK、
没有 `kbp-meta.json`。按绘制认系统靠的是这里出的**计划**：`scene.json` 的粒子对象按 `objects` 顺序，每个对象一棵系统树（粒子 JSON 的
`children`），和产品的 `ParticleSystem.forEachDrawn` 同一个先序（父 → 全部 static 子系统（各带子树）→ 各事件条目的实例），每个系统按
`renderer` 数组各画一次。键和 kabegame-dev 的 `particle_track`（`particles/track.ts` 的 `drawnSystems`）一致，`kbp cmp track` 能直接配：
- 顶层是对象名，同名的第二个起 `名字#<objects 下标>`（不是对象 id）；
- 子系统 `<父键>/<下标>`，下标是认得的条目（类型是小写的四种之一、文件读得到）里的序号，不是 JSON 下标；
- 同一模板第 k 次出现（事件实例，k ≥ 2）加 `#k`；
- 第 r 个 renderer 的那次绘制（r ≥ 2）另加 `@r`（`particle_track` 每个系统只出一份，这几项在它那边没有）。

要兼容 Python 3.10（本机），不在 RenderDoc 里跑。
"""

import json
import os
import re

from . import content
from .common import KbpError

FR_NAME = content.FR_NAME
CHILD_TYPES = ("static", "eventfollow", "eventspawn", "eventdeath")
# 子系统嵌套上限（产品 `MAX_CHILD_DEPTH`，rea-p4e-children 1.6）：深度 < 10 的系统才读自己的 children
MAX_CHILD_DEPTH = 10
# 事件条目的 `maxcount` 缺省（产品 `parseChildEntry`）：同时活跃的实例上限
EVENT_MAXCOUNT = 10
# [kbp] 条目：帧号,帧时间,累计时间（五列的另有屏幕光标）
_ENTRY = re.compile(r"^(\d+),([^,]+),([^,]+)(?:,|$)")


def _json(project_dir, rel, what):
    try:
        data, _ = content.read(project_dir, rel)
    except KbpError:
        return None
    try:
        return json.loads(data.decode("utf-8-sig"))
    except ValueError as error:
        raise KbpError("data", "%s 不是严格 JSON（%s）：%s" % (what, error, rel))


def entry_of(project_dir):
    """入口场景文件：project.json 的 file，缺省 scene.json。"""
    project = _json(project_dir, "project.json", "project.json") or {}
    entry = project.get("file")
    return entry if isinstance(entry, str) and entry else "scene.json"


def load_scene(project_dir):
    scene = _json(project_dir, entry_of(project_dir), "入口场景")
    if not isinstance(scene, dict) or not isinstance(scene.get("objects"), list):
        raise KbpError("data", "工程 %s 的入口场景没有 objects 数组" % project_dir)
    return scene


def instrumented(project_dir):
    """有没有 `--instrument` 加的 kbp-FR（只认入口场景读得出来的工程）。"""
    try:
        scene = load_scene(project_dir)
    except KbpError:
        return False
    return any(isinstance(o, dict) and o.get("name") == FR_NAME for o in scene["objects"])


def _visible(value):
    """对象 `visible`：布尔，或 `{value, user}`（取 value，缺省真）；别的写法当可见。"""
    if isinstance(value, bool):
        return value
    if isinstance(value, dict):
        inner = value.get("value", True)
        return inner if isinstance(inner, bool) else True
    return True


def _count(value):
    """非负的数按 asInt 截断；别的写法（缺键、绑属性的对象）不知道，返回 None。"""
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value != value or value < 0:
        return None
    return int(value)


def _system(project_dir, rel, key, depth, notes):
    """一个系统模板：{key, renderers, maxcount, statics: [模板], events: [模板]}；读不到的文件返回 None。"""
    spec = _json(project_dir, rel, "粒子 JSON")
    if not isinstance(spec, dict):
        notes.append("%s：读不到 %s，这个系统不画" % (key, rel))
        return None
    renderers = spec.get("renderer")
    node = {
        "key": key,
        "renderers": max(1, len(renderers) if isinstance(renderers, list) else 0),
        "maxcount": _count(spec.get("maxcount")),
        # 基础材质为空的系统（连同子树）不画（产品的 particle-tree op，rea-p4e-children 第 6 节）
        "drawn": isinstance(spec.get("material"), str) and spec.get("material") != "",
        "statics": [],
        "events": [],
    }
    children = spec.get("children")
    if depth >= MAX_CHILD_DEPTH or not isinstance(children, list):
        return node
    index = 0
    for entry in children:
        if not isinstance(entry, dict):
            continue
        kind = entry.get("type")
        kind = "static" if kind is None else kind
        if kind not in CHILD_TYPES or not isinstance(entry.get("name"), str):
            continue
        child = _system(project_dir, entry["name"], "%s/%d" % (key, index), depth + 1, notes)
        if child is None:
            continue
        index += 1
        if kind == "static":
            node["statics"].append(child)
        else:
            child["cap"] = _count(entry.get("maxcount"))
            if child["cap"] is None:
                child["cap"] = EVENT_MAXCOUNT
            node["events"].append(child)
    return node


def _flatten(node, out, notes):
    """先序摊平成槽：父 → static 子树 → 事件模板。事件模板下面还有要画的子系统时整个计划不能按绘制对上（实例与子树交错，
    `kind: "event-tree"`，对上时整帧退回按序号）。"""
    if not node["drawn"]:
        return
    out.append({"key": node["key"], "renderers": node["renderers"], "maxcount": node["maxcount"], "kind": "static"})
    for child in node["statics"]:
        _flatten(child, out, notes)
    for child in node["events"]:
        if not child["drawn"]:
            continue
        nested = []
        for grand in child["statics"] + child["events"]:
            _flatten(grand, nested, notes)
        if nested:
            notes.append("%s：事件子系统下面还有要画的子系统，scene 认法对不上，整帧按绘制序号记" % child["key"])
            out.append({"key": child["key"], "renderers": child["renderers"], "maxcount": child["maxcount"],
                        "kind": "event-tree"})
            continue
        out.append({"key": child["key"], "renderers": child["renderers"], "maxcount": child["maxcount"],
                    "kind": "event", "cap": child["cap"]})


def build_plan(project_dir):
    """计划：{slots: [{key, renderers, maxcount, kind, cap?}], objects: [{index, id, name, key, visible}], notes: [...]}。
    `slots` 是每帧绘制的先后（存活数为 0 的系统 WPE 不画，所以每一槽都可能缺）。"""
    scene = load_scene(project_dir)
    by_id = {o.get("id"): o for o in scene["objects"] if isinstance(o, dict) and "id" in o}
    names = set()
    slots, rows, notes = [], [], []
    for index, obj in enumerate(scene["objects"]):
        if not isinstance(obj, dict) or not isinstance(obj.get("particle"), str):
            continue
        name = obj.get("name") if isinstance(obj.get("name"), str) else ""
        # 同名对象加 objects 下标区分（同 particles/track.ts 的 `layer.object`，不是对象 id）；隐藏的对象也占名字
        key = "%s#%d" % (name, index) if name in names else name
        names.add(name)
        visible = True
        seen = set()
        cursor = obj
        while isinstance(cursor, dict) and id(cursor) not in seen:
            seen.add(id(cursor))
            if not _visible(cursor.get("visible", True)):
                visible = False
                break
            cursor = by_id.get(cursor.get("parent"))
        rows.append({"index": index, "id": obj.get("id"), "name": name, "key": key, "visible": visible})
        if not visible:
            continue
        root = _system(project_dir, obj["particle"], key, 0, notes)
        if root is not None:
            _flatten(root, slots, notes)
    return {"slots": slots, "objects": rows, "notes": notes}


def read_log_clock(path):
    """[kbp] 日志 → {帧号: [帧时间, 累计时间]}。`@f64` 的条目是 String() 原样（WPE 的 float32 值），旧的 toFixed(6) 照读。"""
    out = {}
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            text = f.read()
    except OSError as error:
        raise KbpError("data", "读不了 [kbp] 日志 %s：%s（换个位置用 --log）" % (path, error))
    for line in text.splitlines():
        at = line.find("[kbp]")
        if at < 0:
            continue
        for item in line[at + 5:].split():
            if item == "@f64":
                continue
            match = _ENTRY.match(item)
            if not match:
                continue
            try:
                out[int(match.group(1))] = [float(match.group(2)), float(match.group(3))]
            except ValueError:
                continue
    if not out:
        raise KbpError("data", "日志 %s 里没有 [kbp] 条目（工程要 --instrument 解包）" % path)
    return out
