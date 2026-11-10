"""粒子统计量：ignore/p4/b3/wpe_stats_b.py。不依赖测试工程，真实场景也能用。

每次粒子绘制的粒子数、尺寸 / 位置 / 颜色 / alpha 的范围、混合，以及每帧的 g_Time（第一个读了 g_Time 的绘制）。
粒子绘制按顶点输入认：
- 几何着色器路径：PointList，有 TEXCOORD（厚格式是 TEXCOORD0 + TEXCOORD1），每粒子 1 个顶点；
- 顶点展开路径：TriangleList，有 TEXCOORD0、TEXCOORD2、COLOR，vs_in 按索引展开，每粒子 6 个。
写 <out>（缺省 <data>/out/wpe-<标签>-stats.json），indent=1。要兼容 RenderDoc 内嵌的 Python 3.8。
"""

import os
import time

from .bridge import BridgeError
from .util import rdc_names, save_json


def scene_time(bridge, event):
    for stage in ("vertex", "geometry", "pixel"):
        try:
            info = bridge.call("get_shader_info", {"event_id": event, "stage": stage})
        except BridgeError:
            continue
        for buffer in info.get("constant_buffers", []) or []:
            for variable in buffer["variables"]:
                if variable["name"] == "g_Time" and variable.get("referenced") is not False:
                    return variable["value"][0]
    return None


def _axis(rows, i):
    return [r[i] for r in rows]


def _rng(xs):
    return [min(xs), max(xs)] if xs else None


def summarize(columns, per):
    pos = columns["POSITION"][::per]
    tex = (columns.get("TEXCOORD") or columns.get("TEXCOORD0"))[::per]
    color = columns["COLOR"][::per]
    return {"count": len(pos), "x": _rng(_axis(pos, 0)), "y": _rng(_axis(pos, 1)), "z": _rng(_axis(pos, 2)),
            "size": _rng(_axis(tex, 3)), "alpha": _rng(_axis(color, 3)), "rgb": [_rng(_axis(color, i)) for i in range(3)]}


def run(bridge, job, log):
    folder, out_path = job["folder"], job["out"]
    rows, items = [], []
    for name in rdc_names(folder):
        start = time.time()
        bridge.call("open_capture", {"capture_path": os.path.join(folder, name)})
        actions = bridge.call("get_draw_calls", {"only_actions": True, "flags_filter": ["Drawcall"]})["actions"]
        frame = {"rdc": name, "time": None, "draws": []}
        for action in actions:
            event = action["event_id"]
            if frame["time"] is None:
                frame["time"] = scene_time(bridge, event)
            state = bridge.call("get_pipeline_state", {"event_id": event})
            inputs = {v["name"] for v in state["input_assembly"]["vertex_inputs"]}
            topology = state["input_assembly"]["topology"]
            # 厚格式（帧表）是 TEXCOORD0 + TEXCOORD1
            geometry = ("TEXCOORD" in inputs or "TEXCOORD0" in inputs) and topology.endswith("PointList")
            expanded = {"TEXCOORD0", "TEXCOORD2", "COLOR"} <= inputs and topology.endswith("TriangleList")
            if not (geometry or expanded):
                continue
            mesh = bridge.call("get_mesh_data", {"event_id": event, "stage": "vs_in", "max_vertices": 400000})
            per = 1 if geometry else 6  # 顶点展开的 vs_in 按索引展开，每粒子 6 个
            row = summarize(mesh["columns"], per)
            row.update({"event": event, "path": "gs" if geometry else "vs",
                        "blend": state["color_blends"][0]["color"] if state["color_blends"] else None})
            frame["draws"].append(row)
        rows.append(frame)
        seconds = round(time.time() - start, 3)
        log("%s g_Time %s %s（%.3f s）" % (name, frame["time"], [(d["path"], d["count"], d["size"]) for d in frame["draws"]],
                                         seconds))
        items.append({"rdc": name, "draws": len(frame["draws"]), "seconds": seconds})
    save_json(out_path, rows, indent=1)
    return {"out": out_path, "frames": len(rows), "items": items}
