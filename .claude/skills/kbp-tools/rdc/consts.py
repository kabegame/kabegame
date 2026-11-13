"""逐帧常量（P10 起）：每张抓帧的时钟（FR、CLK，同 track）和其余每次绘制被着色器读到的常量。

属性关键帧、脚本写回这类「每帧写一个字段」的实验靠它读 WPE 当帧写进去的值：图层字段看顶点阶段的
`g_ModelViewProjectionMatrix` / `g_Color4`，effect 常量看材质常量（`g_bufStatic`）。没被读到的常量（referenced 为 false）是垃圾值，不收。
例外（P11a 走查）：反汇编里声明成 `dynamicIndexed` 的常量缓冲（`dcl_constantbuffer cbN[..] (名字), dynamicIndexed`，着色器用运行时下标
读它，如 `test_shader` 在 `main` 之前的循环里读 `g_AudioSpectrum64Left[i]`），RenderDoc 认不出读了哪些成员、一律标 false，这时整个缓冲
都收，靠这条规则收进来的名字另记在这次绘制的 `dynamic`（`{阶段: [名字…]}`）里，用的人自己判断哪些是真的被读的。
- `params.names`：只收这些名字（缺省全收）；
- `params.clock`（缺省真）：假时不读 FR / CLK（真实壁纸解包的工程，P11a 走查起），frame 取 RenderDoc 帧号 + 1（同 unpack 的约定），
  time / dt 不收（从 [kbp] 日志取），全部绘制都收常量；
- 每次绘制记 `event`、顶点 / 像素阶段的常量（名字 → 值，矩阵是 16 个数）。
写 <out>（缺省 <data>/out/wpe-<标签>-consts.json），indent=1。要兼容 RenderDoc 内嵌的 Python 3.8。
"""

import os
import re
import time

from .bridge import BridgeError
from .track import clock
from .util import rdc_frame, rdc_names, save_json


DYNAMIC_CB = re.compile(r"dcl_constantbuffer\s+cb\d+\[\d+\]\s+\((\w+)\),\s*dynamicIndexed")


def _stage(bridge, event, stage, names, dynamic=None):
    """这一阶段读到的常量。`dynamic` 给了列表时，动态下标缓冲里 referenced 为 false、按例外收进来的名字追加进去。"""
    try:
        info = bridge.call("get_shader_info", {"event_id": event, "stage": stage})
    except BridgeError:
        return None
    out = {}
    dynamic_buffers = set(DYNAMIC_CB.findall(info.get("disassembly") or ""))
    for buffer in info.get("constant_buffers", []) or []:
        for variable in buffer["variables"]:
            if variable.get("referenced") is False:
                if buffer.get("name") not in dynamic_buffers:
                    continue
                if dynamic is not None and (not names or variable["name"] in names):
                    dynamic.append(variable["name"])
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
        if job["params"].get("clock", True):
            frame, rest = clock(bridge, os.path.join(folder, name), True)
        else:
            frame = {"frame": rdc_frame(name) + 1, "rdc_frame": rdc_frame(name)}
            rest = bridge.call("get_draw_calls", {"only_actions": True, "flags_filter": ["Drawcall"]})["actions"]
        frame["rdc"] = name
        frame["draws"] = []
        for action in rest:
            event = action["event_id"]
            row = {"event": event}
            for stage, key in (("vertex", "vs"), ("pixel", "ps")):
                dynamic = []
                consts = _stage(bridge, event, stage, names, dynamic)
                if consts:
                    row[key] = consts
                if dynamic:
                    row.setdefault("dynamic", {})[key] = dynamic
            frame["draws"].append(row)
        rows.append(frame)
        seconds = round(time.time() - start, 3)
        log("%s 帧 %d 绘制 %d（%.3f s）" % (name, frame["frame"], len(frame["draws"]), seconds))
        items.append({"rdc": name, "frame": frame["frame"], "draws": len(frame["draws"]), "seconds": seconds})
    save_json(out_path, rows, indent=1)
    return {"out": out_path, "frames": len(rows), "items": items}
