"""着色器清单：每次绘制用的顶点 / 像素着色器、材质常量名、是否 WPE 的编译失败回退（P7 起）。

WPE 编译失败时顶点、片元各自换成 `assets/shaders/HLSL/dx11fallback.{vert,frag}` 重编（P7 rea-p7-shader.md）：
- 片元回退只有一句 `mov o0.xyzw, l(0.500000, 0.000000, 0.000000, 1.000000)`，没有输入、常量缓冲与纹理；
- 顶点回退只读 POSITION，只有一个 `g_ModelViewProjectionMatrix`；纯色图层的顶点着色器和它指令相同，所以只在配对的像素着色器
  还读插值输入时才算回退。
材质常量在 `g_bufStatic`，按名字认是哪个 effect 的着色器。不同哈希的反汇编各存一份 `<out 目录>/<标签>-shaders/<哈希>.txt`。
写 <out>（缺省 <data>/out/wpe-<标签>-shaders.json），indent=1。要兼容 RenderDoc 内嵌的 Python 3.8。
"""

import os
import re
import time

from .bridge import BridgeError
from .util import rdc_names, save_json

HASH_RE = re.compile(r"Shader hash ([0-9a-f-]+)")
FALLBACK_PS = "mov o0.xyzw, l(0.500000, 0.000000, 0.000000, 1.000000)"


def _code(disassembly):
    """反汇编里的指令行（去掉注释、哈希行与声明）。"""
    lines = []
    for line in disassembly.splitlines():
        text = line.strip()
        if not text or text.startswith("//") or text.startswith("Shader hash") or text.startswith("dcl_"):
            continue
        lines.append(re.sub(r"^\d+:\s*", "", text))
    return lines


def is_fallback(stage, info):
    disassembly = info.get("disassembly") or ""
    code = _code(disassembly)
    if stage == "pixel":
        return FALLBACK_PS in code and len([c for c in code if c not in ("ps_5_0", "ps_4_1", "ps_4_0", "ret")]) == 1
    names = [v["name"] for b in info.get("constant_buffers", []) or [] for v in b["variables"]]
    return names == ["g_ModelViewProjectionMatrix"] and "dcl_input v0.xyz" in disassembly and "v1" not in disassembly


def describe(bridge, event, stage, store, seen):
    try:
        info = bridge.call("get_shader_info", {"event_id": event, "stage": stage})
    except BridgeError:
        return None
    disassembly = info.get("disassembly") or ""
    match = HASH_RE.search(disassembly)
    digest = match.group(1) if match else None
    if digest and digest not in seen:
        seen.add(digest)
        with open(os.path.join(store, digest + ".txt"), "w", encoding="utf-8", newline="\n") as f:
            f.write(disassembly)
    statics = []
    for buffer in info.get("constant_buffers", []) or []:
        if buffer.get("name") == "g_bufStatic":
            statics = [v["name"] for v in buffer["variables"]]
    inputs = len(re.findall(r"dcl_input_ps(?:_siv)? [^\n]*v\d", disassembly)) if stage == "pixel" else None
    return {"hash": digest, "fallback": is_fallback(stage, info), "statics": statics, "inputs": inputs}


def run(bridge, job, log):
    folder, out_path = job["folder"], job["out"]
    store = os.path.splitext(out_path)[0]
    os.makedirs(store, exist_ok=True)
    seen = set()
    rows, items = [], []
    for name in rdc_names(folder):
        start = time.time()
        bridge.call("open_capture", {"capture_path": os.path.join(folder, name)})
        actions = bridge.call("get_draw_calls", {"only_actions": True, "flags_filter": ["Drawcall"]})["actions"]
        frame = {"rdc": name, "draws": []}
        for action in actions:
            event = action["event_id"]
            row = {"event": event, "indices": action.get("num_indices")}
            for stage in ("vertex", "pixel"):
                row[stage] = describe(bridge, event, stage, store, seen)
            # 顶点回退和纯色图层的顶点着色器指令相同（只读 POSITION、只乘 MVP）：配对的像素着色器还读插值输入时才算回退
            if row["vertex"] and row["vertex"]["fallback"] and not (row["pixel"] and row["pixel"]["inputs"]):
                row["vertex"]["fallback"] = False
            frame["draws"].append(row)
        rows.append(frame)
        fallbacks = [d["event"] for d in frame["draws"]
                     if any(d[s] and d[s]["fallback"] for s in ("vertex", "pixel"))]
        seconds = round(time.time() - start, 3)
        log("%s 绘制 %d，回退 %s（%.3f s）" % (name, len(frame["draws"]), fallbacks, seconds))
        items.append({"rdc": name, "draws": len(frame["draws"]), "fallback_events": fallbacks, "seconds": seconds})
    save_json(out_path, rows, indent=1)
    return {"out": out_path, "frames": len(rows), "items": items}
