"""轨迹提取：合并 ignore/p4/rdc_track_b.py（points）、rdc_rope.py（draws）与 rdc_track.py（legacy）。输出格式各自不变。

三种认法（kbp.py 选好后经 job 传进来）：
- points：工程有 kbp-meta.json。系统按 meta 认（color / order），每个粒子一条 {pos, size, color, alpha, rot, 其余顶点列}；
  CLK 有指针常量时记 pointer / pointer_last；meta 有 corners 时读 gs_out / vs_out 四角；同一系统多次绘制记 `名字#2`…
- draws：P4d 绳与模块工程（gen_d.py）。每次粒子绘制原样保存 vs_in、gs_out（没有几何着色器时 vs_out）、几何着色器的
  dcl_maxout 与各阶段被读到的常量。
- legacy：没有 kbp-meta.json 的老工程（p4-0、p4a*）。颜色表从 scene.json 与 particles/*.json 的 colorrandom 读，
  四角只给 linear / custom / rot-gs / rot-vs，按 UV 配对。

前两个绘制固定是 FR（帧号，像素着色器的 g_Color）、CLK（g_Time、g_Frametime，带指针的版本另有 g_PointerPosition*）。
要兼容 RenderDoc 内嵌的 Python 3.8。
"""

import json
import os
import re
import time

from .util import DataError, rdc_frame, rdc_names, save_json

# ==================== 公共 ====================


def constant(info, name):
    """常量值。着色器没读的常量是垃圾值；referenced 只有部分阶段给，缺键时不算没读。"""
    for buffer in info["constant_buffers"]:
        for variable in buffer["variables"]:
            if variable["name"] == name:
                if variable.get("referenced") is False:
                    raise DataError("%s 没被着色器读取，值不能用" % name)
                return variable["value"]
    raise DataError("找不到常量 %s" % name)


def clock(bridge, path, with_pointer):
    """FR、CLK 两个绘制 → frame、rdc_frame、time、dt（以及 pointer / pointer_last）。返回 (字段, 其余绘制)。"""
    actions = bridge.call("get_draw_calls", {"only_actions": True, "flags_filter": ["Drawcall"]})["actions"]
    if len(actions) < 2:
        raise DataError("%s 只有 %d 个绘制，前两个应是 FR、CLK" % (path, len(actions)))
    fr, clk, rest = actions[0], actions[1], actions[2:]
    color = constant(bridge.call("get_shader_info", {"event_id": fr["event_id"], "stage": "pixel"}), "g_Color")
    info = bridge.call("get_shader_info", {"event_id": clk["event_id"], "stage": "vertex"})
    out = {
        "frame": round(color[0] * 255) + round(color[1] * 255) * 256,
        "rdc_frame": rdc_frame(os.path.basename(path)),
        "time": constant(info, "g_Time")[0],
        "dt": constant(info, "g_Frametime")[0],
    }
    if with_pointer:
        # P4c 起（gen_c.py）的 CLK 着色器还读指针：有就记下 WPE 当帧用的 g_PointerPosition / g_PointerPositionLast
        names = {v["name"] for b in info["constant_buffers"] for v in b["variables"]}
        for key, uniform in (("pointer", "g_PointerPosition"), ("pointer_last", "g_PointerPositionLast")):
            if uniform in names:
                out[key] = constant(info, uniform)[:2]
    return out, rest


def load_meta(project_dir):
    with open(os.path.join(project_dir, "kbp-meta.json"), encoding="utf-8") as f:
        return json.load(f)


def color_match(rgb, meta, candidates):
    best, score = None, 1e9
    for name in candidates:
        ref = meta["objects"][name].get("rgb")
        if ref is None:
            continue
        d = sum(abs(a - b) for a, b in zip(ref, rgb))
        if d < score:
            best, score = name, d
    return best if score <= 0.03 else None


# ==================== points（rdc_track_b.py） ====================

KNOWN = {"POSITION", "TEXCOORD", "TEXCOORD0", "TEXCOORD2", "COLOR"}


def decode_points(mesh):
    """折成每粒子一条。几何着色器路径每粒子 1 个顶点，顶点展开路径 6 个索引（取第一个）。"""
    columns = mesh["columns"]
    if mesh["topology"].endswith("PointList"):
        rows = range(mesh["vertex_count"])
        # 厚格式（THICKFORMAT）有两组：TEXCOORD0 是旋转与尺寸，TEXCOORD1 是速度与 frame 原值
        texcoord = columns["TEXCOORD"] if "TEXCOORD" in columns else columns["TEXCOORD0"]
        rotation = [t[:3] for t in texcoord]
    else:
        rows = range(0, mesh["vertex_count"], 6)
        texcoord = columns["TEXCOORD0"]
        rotation = [[c[0], c[1], t[2]] for c, t in zip(columns["TEXCOORD2"], texcoord)]
    extra = {name: values for name, values in columns.items() if name not in KNOWN}
    out = []
    for i in rows:
        row = {"pos": columns["POSITION"][i], "size": texcoord[i][3], "color": columns["COLOR"][i][:3],
               "alpha": columns["COLOR"][i][3], "rot": rotation[i]}
        for name, values in extra.items():
            row[name] = values[i]
        out.append(row)
    return out


def assign_points(draws, meta):
    """draws：[(event, particles)]（图像层的绘制没有粒子，particles 为 None）。按对象顺序配对。
    一个系统有多个 renderer 时（meta 里 `draws: n`），每帧连着画 n 次，第 2 次起记成 `<名字>#2`…"""
    order = meta["order"]
    result = {}
    cursor = 0
    last, repeat = None, 0
    for event, particles in draws:
        if particles and last is not None and repeat < meta["objects"][last].get("draws", 1):
            repeat += 1
            result["%s#%d" % (last, repeat)] = particles
            continue
        if particles is None:
            # 图像层每帧都画：对象表里下一个图像层
            while cursor < len(order) and meta["objects"][order[cursor]]["kind"] != "image":
                cursor += 1
            cursor += 1
            continue
        if not particles:
            continue
        rest = order[cursor:]
        name = color_match(particles[0]["color"], meta,
                           [n for n in rest if meta["objects"][n]["kind"] == "particle"
                            and meta["objects"][n]["ident"] == "color"])
        if name is None:
            # 颜色认不出：取游标之后第一个按顺序认的粒子系统
            name = next((n for n in rest if meta["objects"][n]["kind"] == "particle"
                         and meta["objects"][n]["ident"] == "order"), None)
            if name is None:
                raise DataError("事件 %s 的颜色 %s 对不上任何系统" % (event, particles[0]["color"]))
        result[name] = particles
        cursor = order.index(name) + 1
        last, repeat = name, 1
    return result


def corners_points(bridge, event):
    """几何着色器（没有就顶点着色器）输出的前几个粒子的四角：[(uv, 裁剪空间 xyzw)]。P4c 拖尾与朝向比四角用。"""
    for stage in ("gs_out", "vs_out"):
        try:
            mesh = bridge.call("get_mesh_data", {"event_id": event, "stage": stage, "max_vertices": 48})
        except Exception:  # noqa: BLE001 —— 没有这个阶段时服务层报错
            continue
        columns = mesh.get("columns") or {}
        uv = columns.get("TEXCOORD0") or columns.get("TEXCOORD")
        pos = columns.get("SV_POSITION")
        if uv and pos:
            return {"stage": stage, "rows": [[list(u), list(p)] for u, p in zip(uv, pos)]}
    return None


def extract_points(bridge, path, meta):
    bridge.call("open_capture", {"capture_path": path})
    out, rest = clock(bridge, path, True)
    # 键顺序照 rdc_track_b.py：systems 在 pointer 之前
    out = dict(list(out.items())[:4] + [("systems", {})] + list(out.items())[4:])
    draws = []
    for action in rest:
        event = action["event_id"]
        mesh = bridge.call("get_mesh_data", {"event_id": event, "stage": "vs_in", "max_vertices": 100000})
        is_particle = mesh["topology"].endswith("PointList") or "COLOR" in mesh["columns"]
        draws.append((event, decode_points(mesh) if is_particle else None))
    out["systems"] = assign_points(draws, meta)
    if meta.get("corners"):
        # 四角按系统名存（含 `<名字>#2` 这类第二次绘制）
        by_list = {id(particles): name for name, particles in out["systems"].items()}
        out["corners"] = {by_list[id(p)]: corners_points(bridge, e) for e, p in draws if p and id(p) in by_list}
    return out


# ==================== draws（rdc_rope.py） ====================


def stage_info(bridge, event, stage):
    try:
        return bridge.call("get_shader_info", {"event_id": event, "stage": stage})
    except Exception:  # noqa: BLE001 —— 该阶段没有绑定着色器时服务层报错
        return None


def referenced_constants(info):
    out = {}
    for buffer in (info or {}).get("constant_buffers", []):
        for variable in buffer["variables"]:
            if variable.get("referenced") is False:
                continue
            out[variable["name"]] = variable["value"]
    return out


def color_of(columns):
    for name, values in columns.items():
        if name.startswith("COLOR") and values:
            return values[0][:3]
    return None


def read_draw(bridge, event, limit):
    mesh = bridge.call("get_mesh_data", {"event_id": event, "stage": "vs_in", "max_vertices": limit})
    columns = mesh.get("columns") or {}
    is_particle = mesh["topology"].endswith("PointList") or any(n.startswith("COLOR") for n in columns)
    if not is_particle:
        return None
    draw = {"event": event, "topology": mesh["topology"], "vs_count": mesh["vertex_count"], "vs_in": columns}
    geometry = stage_info(bridge, event, "geometry")
    vertex = stage_info(bridge, event, "vertex")
    draw["consts"] = {"vertex": referenced_constants(vertex)}
    if geometry:
        draw["consts"]["geometry"] = referenced_constants(geometry)
        maxout = re.search(r"dcl_maxout\s+(\d+)", geometry.get("disassembly") or "")
        draw["maxout"] = int(maxout.group(1)) if maxout else None
        out = bridge.call("get_mesh_data", {"event_id": event, "stage": "gs_out", "max_vertices": limit})
        draw["gs_out"] = {"topology": out.get("topology"), "count": out.get("vertex_count"), "columns": out.get("columns")}
    else:
        out = bridge.call("get_mesh_data", {"event_id": event, "stage": "vs_out", "max_vertices": limit})
        draw["vs_out"] = {"topology": out.get("topology"), "count": out.get("vertex_count"), "columns": out.get("columns")}
    return draw


def assign_draws(draws, meta):
    """按颜色认系统，认不出按顺序；同系统连续多次绘制记 `<名字>#n`。"""
    order = meta["order"]
    particles = [n for n in order if meta["objects"][n]["kind"] == "particle"]
    result = {}
    cursor = 0
    last, repeat = None, 0
    for draw in draws:
        rgb = color_of(draw["vs_in"])
        rest = particles[cursor:]
        name = color_match(rgb, meta, [n for n in rest if meta["objects"][n]["ident"] == "color"]) if rgb else None
        if name is None and last is not None and repeat < meta["objects"][last].get("draws", 1):
            repeat += 1
            result["%s#%d" % (last, repeat)] = draw
            continue
        if name is None:
            name = next((n for n in rest if meta["objects"][n]["ident"] == "order"), None)
        if name is None:
            raise DataError("事件 %s 的颜色 %s 对不上任何系统" % (draw["event"], rgb))
        if name == last and repeat < meta["objects"][last].get("draws", 1):
            repeat += 1
            result["%s#%d" % (last, repeat)] = draw
            continue
        result[name] = draw
        cursor = particles.index(name) + 1
        last, repeat = name, 1
    return result


def extract_draws(bridge, path, meta, limit):
    bridge.call("open_capture", {"capture_path": path})
    out, rest = clock(bridge, path, True)
    draws = [d for d in (read_draw(bridge, a["event_id"], limit) for a in rest) if d]
    out["systems"] = assign_draws(draws, meta)
    return out


# ==================== legacy（rdc_track.py + track.py） ====================

CORNERS = {"linear": "gs_out", "custom": "vs_out", "rot-gs": "gs_out", "rot-vs": "vs_out"}


def legacy_systems(project_dir):
    """{名字: {rgb, origin, spec}}，顺序同 scene.json（ignore/p4/track.py 的 systems）。"""
    with open(os.path.join(project_dir, "scene.json"), encoding="utf-8") as f:
        scene = json.load(f)
    out = {}
    for obj in scene["objects"]:
        if "particle" not in obj:
            continue
        with open(os.path.join(project_dir, obj["particle"]), encoding="utf-8") as f:
            spec = json.load(f)
        found = [i for i in spec["initializer"] if i["name"] == "colorrandom"]
        if not found:
            raise DataError("老工程的系统 %s 没有 colorrandom，退回的颜色表认不了它" % obj["name"])
        color = found[0]["min"]
        origin = [float(v) for v in spec["emitter"][0]["origin"].split()]
        out[obj["name"]] = {"rgb": [float(v) / 255 for v in color.split()], "origin": origin, "spec": spec}
    return out


def system_of(rgb, table):
    """按颜色认系统。绘制顺序靠不住：某帧没有存活粒子时那次绘制就没有。"""
    best = min(table, key=lambda name: sum(abs(a - b) for a, b in zip(table[name]["rgb"], rgb)))
    if sum(abs(a - b) for a, b in zip(table[best]["rgb"], rgb)) > 0.03:
        raise DataError("颜色 %s 对不上任何系统" % (rgb,))
    return best


def decode_legacy(mesh):
    """折成每粒子一条。几何着色器路径每粒子 1 个顶点，顶点展开路径 6 个索引。不带其余顶点列。"""
    columns = mesh["columns"]
    if mesh["topology"].endswith("PointList"):
        rows = range(mesh["vertex_count"])
        texcoord = columns["TEXCOORD"]
        rotation = [t[:3] for t in texcoord]
    else:
        rows = range(0, mesh["vertex_count"], 6)
        texcoord = columns["TEXCOORD0"]
        rotation = [[c[0], c[1], t[2]] for c, t in zip(columns["TEXCOORD2"], texcoord)]
    return [{"pos": columns["POSITION"][i], "size": texcoord[i][3], "color": columns["COLOR"][i][:3],
             "alpha": columns["COLOR"][i][3], "rot": rotation[i]} for i in rows]


def corners_legacy(bridge, event, stage):
    """最终四角：{"u,v": 裁剪空间 xy}。两条路径的角点顺序不同，所以按 UV 配对。"""
    mesh = bridge.call("get_mesh_data", {"event_id": event, "stage": stage, "max_vertices": 64})
    columns = mesh["columns"]
    return {"%s,%s" % (_g(uv[0]), _g(uv[1])): position[:2]
            for uv, position in zip(columns["TEXCOORD0"], columns["SV_POSITION"])}


def _g(value):
    return format(value, "g")


def extract_legacy(bridge, path, table):
    bridge.call("open_capture", {"capture_path": path})
    out, rest = clock(bridge, path, False)
    out["systems"] = {}
    out["corners"] = {}
    for action in rest:
        event = action["event_id"]
        mesh = bridge.call("get_mesh_data", {"event_id": event, "stage": "vs_in", "max_vertices": 100000})
        particles = decode_legacy(mesh)
        if not particles:
            continue
        name = system_of(particles[0]["color"], table)
        out["systems"][name] = particles
        if name in CORNERS:
            out["corners"][name] = corners_legacy(bridge, event, CORNERS[name])
    return out


# ==================== 入口 ====================


def _summary(row, mode):
    if mode == "draws":
        return {k: [v["vs_count"], v.get("maxout"), (v.get("gs_out") or v.get("vs_out") or {}).get("count")]
                for k, v in row["systems"].items()}
    return {k: len(v) for k, v in row["systems"].items()}


def run(bridge, job, log):
    params = job["params"]
    mode = params["mode"]
    project_dir = params["project_dir"]
    folder, tag, out_path = job["folder"], job["tag"], job["out"]
    if mode == "legacy":
        table = legacy_systems(project_dir)
    else:
        meta = load_meta(project_dir)
    names = rdc_names(folder)
    frames, items = [], []
    for name in names:
        path = os.path.join(folder, name)
        start = time.time()
        if mode == "points":
            row = extract_points(bridge, path, meta)
        elif mode == "draws":
            row = extract_draws(bridge, path, meta, int(params.get("limit") or 20000))
        elif mode == "legacy":
            row = extract_legacy(bridge, path, table)
        else:
            raise DataError("未知的认法 %s" % mode)
        seconds = round(time.time() - start, 3)
        log("%s FR %s time %.6f dt %.6f %s（%.3f s）" % (name, row["frame"], row["time"], row["dt"],
                                                      json.dumps(_summary(row, mode), ensure_ascii=False), seconds))
        frames.append(row)
        items.append({"rdc": name, "rdc_frame": rdc_frame(name), "frame": row["frame"], "seconds": seconds,
                      "systems": len(row["systems"])})
    start = time.time()
    save_json(out_path, {"source": "renderdoc", "project": params["project"], "tag": tag, "frames": frames})
    log("写出 %s（%.3f s）" % (out_path, time.time() - start))
    return {"out": out_path, "mode": mode, "project": params["project"], "frames": len(frames), "items": items}
