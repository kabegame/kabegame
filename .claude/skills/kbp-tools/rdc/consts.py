"""逐帧常量（P10 起）：每张抓帧的时钟（FR、CLK，同 track）和其余每次绘制被着色器读到的常量。

属性关键帧、脚本写回这类「每帧写一个字段」的实验靠它读 WPE 当帧写进去的值：图层字段看顶点阶段的
`g_ModelViewProjectionMatrix` / `g_Color4`，effect 常量看材质常量（`g_bufStatic`）。没被读到的常量（referenced 为 false）是垃圾值，不收。
- `params.names`：只收这些名字（缺省全收）；
- 每次绘制记 `event`、顶点 / 像素阶段的常量（名字 → 值，矩阵是 16 个数）。
写 <out>（缺省 <data>/out/wpe-<标签>-consts.json），indent=1。要兼容 RenderDoc 内嵌的 Python 3.8。
"""

import os
import time

from .bridge import BridgeError
from .track import clock
from .util import rdc_names, save_json


def _stage(bridge, event, stage, names):
    try:
        info = bridge.call("get_shader_info", {"event_id": event, "stage": stage})
    except BridgeError:
        return None
    out = {}
    for buffer in info.get("constant_buffers", []) or []:
        for variable in buffer["variables"]:
            if variable.get("referenced") is False:
                continue
            if names and variable["name"] not in names:
                continue
            value = variable["value"]
            if not value and variable.get("members"):
                # 数组：RenderDoc 把每个元素放在 members 里，按顺序展开
                value = [x for member in variable["members"] for x in member["value"]]
            out[variable["name"]] = value
    return out


def run(bridge, job, log):
    folder, out_path = job["folder"], job["out"]
    names = set(job["params"].get("names") or [])
    rows, items = [], []
    for name in rdc_names(folder):
        start = time.time()
        bridge.call("open_capture", {"capture_path": os.path.join(folder, name)})
        frame, rest = clock(bridge, os.path.join(folder, name), True)
        frame["rdc"] = name
        frame["draws"] = []
        for action in rest:
            event = action["event_id"]
            row = {"event": event}
            for stage, key in (("vertex", "vs"), ("pixel", "ps")):
                consts = _stage(bridge, event, stage, names)
                if consts:
                    row[key] = consts
            frame["draws"].append(row)
        rows.append(frame)
        seconds = round(time.time() - start, 3)
        log("%s 帧 %d 绘制 %d（%.3f s）" % (name, frame["frame"], len(frame["draws"]), seconds))
        items.append({"rdc": name, "frame": frame["frame"], "draws": len(frame["draws"]), "seconds": seconds})
    save_json(out_path, rows, indent=1)
    return {"out": out_path, "frames": len(rows), "items": items}
