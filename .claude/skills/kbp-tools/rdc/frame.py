"""整帧图：ignore/p4/step4/wpe_rt.py 加 ignore/p3b/compare/wpe_export.py。

三种取法（job.params.mode）：
- last（缺省，wpe_rt.py）：最后一次绘制之后的渲染目标 0；
- event：指定事件之后的渲染目标 0（各抓帧用同一个事件号）；
- present（wpe_export.py）：Present 时的后备缓冲。LDR 存 PNG，浮点格式存 DDS（原始数据）。

文件名按脚本帧号（= RenderDoc 帧号 + 1）：<out_dir>/wpe-<标签>-f<脚本帧>.png（present 的浮点格式为 .dds），
另写索引 <out_dir>/wpe-<标签>.json（last / event 的行同 wpe_rt.py：rdc、frame、event、target、png、result）。
要兼容 RenderDoc 内嵌的 Python 3.8。
"""

import json
import os
import re
import time

from .util import DataError, rdc_frame, rdc_names, save_json


def _flat(items):
    for x in items:
        yield x
        if x.get("children"):
            for y in _flat(x["children"]):
                yield y


def _render_target(bridge, name, event):
    state = bridge.call("get_pipeline_state", {"event_id": event})
    targets = state.get("render_targets") or []
    if not targets:
        raise DataError("%s 事件 %s 没有绑定渲染目标" % (name, event))
    return targets[0]["resource_id"]


def is_float_format(info):
    """同 wpe_export.py 的判断。"""
    fmt = json.dumps(info)
    return "16_FLOAT" in fmt or "R16G16B16A16" in fmt or "Float" in str(info.get("format", ""))


def run(bridge, job, log):
    params = job["params"]
    mode = params.get("mode") or "last"
    folder, tag, out_dir = job["folder"], job["tag"], job["out"]
    os.makedirs(out_dir, exist_ok=True)
    rows, items = [], []
    for name in rdc_names(folder):
        start = time.time()
        bridge.call("open_capture", {"capture_path": os.path.join(folder, name)})
        frame = rdc_frame(name) + 1
        if mode == "present":
            actions = bridge.call("get_draw_calls", {"include_children": True})["actions"]
            presents = [a for a in _flat(actions) if "Present" in a.get("flags", "")]
            if not presents:
                raise DataError("%s 里没有 Present" % name)
            present = presents[-1]
            match = re.search(r"ResourceId::(\d+)", present["name"])
            if not match:
                raise DataError("%s 的 Present 名字里没有 ResourceId：%s" % (name, present["name"]))
            target = "ResourceId::" + match.group(1)
            info = bridge.call("get_texture_info", {"resource_id": target})
            ext = "dds" if is_float_format(info) else "png"
            path = os.path.join(out_dir, "wpe-%s-f%d.%s" % (tag, frame, ext))
            result = bridge.call("save_texture", {"resource_id": target, "output_path": path,
                                                  "event_id": present["event_id"], "alpha": "preserve"})
            rows.append({"rdc": name, "frame": frame, "event": present["event_id"], "target": target, "file": path,
                         "present": present, "texture": info, "result": result})
            event = present["event_id"]
        else:
            if mode == "event":
                event = int(params["event"])
            else:
                actions = bridge.call("get_draw_calls", {"only_actions": True, "flags_filter": ["Drawcall"]})["actions"]
                if not actions:
                    raise DataError("%s 里没有绘制" % name)
                event = actions[-1]["event_id"]
            target = _render_target(bridge, name, event)
            path = os.path.join(out_dir, "wpe-%s-f%d.png" % (tag, frame))
            result = bridge.call("save_texture", {"resource_id": target, "output_path": path, "event_id": event,
                                                  "mip": 0, "slice": 0, "sample": 0, "alpha": "preserve"})
            rows.append({"rdc": name, "frame": frame, "event": event, "target": target, "png": path, "result": result})
        seconds = round(time.time() - start, 3)
        log("%s 脚本帧 %d 事件 %s %s → %s（%.3f s）" % (name, frame, event, target, os.path.basename(path), seconds))
        items.append({"rdc": name, "frame": frame, "event": event, "file": path, "seconds": seconds})
    index = os.path.join(out_dir, "wpe-%s.json" % tag)
    save_json(index, rows, indent=1)
    return {"out": out_dir, "index": index, "mode": mode, "frames": len(rows), "items": items}
