"""比较（kbp-tools 点 7）：`kbp cmp track|frame|stats`，把真机结果和 WPE 真值对上，只报差、不做包络判定（判定在 replay）。

- track：`dev4/cmp-wpe.ts` 的通用版。我们（kabegame-dev 的 `particle_track` 结果，或任何轨迹形状的 JSON）对 WPE 轨迹
  （`tracks/rd-*.json`）：WPE 的每一帧、两边系统的并集，同帧同系统按数组顺序配对，报 pos / size / color / alpha / rot 的最大差；
  粒子数不同的帧只记次数不配对；我们缺的帧列出来。
- frame：收 `step4/cmp_real.py`、`b1/cmp.py`、`b6/px/cmp.py`、`c5/cmp_scene.py`、`b1/heat.py`。逐像素比两张 PNG：
  - 尺寸：`--crop 上,下,左,右` 先裁我们的；仍不同、同比例时居中裁成 WPE 的大小（c5/cmp_scene.py：窗口高被屏幕压到 2130）；
    比例不同或 `--resize` 时按 cover 取中间一块再 BOX 缩到 WPE 的大小（b1/cmp.py、b1/heat.py）；
  - 差值是每像素三通道绝对差的最大值；测试工程（给 `--meta` 或 `--kbp-layers`）排除右下角 FR / CLK（场景 x ≥ 1640、图片 y ≥ 990，
    同 step4/cmp_real.py）；
  - 报直方图（> 0 / 2 / 8 / 32 的像素数）、最大差、平均差；超过 `--threshold`（缺省 32）的像素按 `--cell`（缺省 32）格子聚成连通块，
    列包围盒（同 c5/cmp_scene.py）；
  - `--meta` 的对象带 `bbox`（场景坐标、y 向上，[x0, y0, x1, y1]）时按对象归类差异像素（按 order 顺序取第一个包含它的对象，其余算
    other；b6/px/cmp.py 的写法）；
  - `--heat <png>`：差异图转灰度（PIL 的 L）乘 `--heat-gain`（缺省 8）；`--zoom x,y,w,h` 另存我们 / WPE 并排放大图。
- stats：`b3/cmp_stats.py`、`b4v/cmp_stats.py`。我们（屏外宿主回放的 `real.json` 样本：`particles[]` 每层 `alive`、`capacity`、
  `summary`）对 WPE 统计量（`kbp rdc stats` 的 `wpe-*-stats.json`）：层按绘制顺序一一对应，WPE 各帧合并取范围，报粒子数、尺寸、x、y、
  alpha 的范围；WPE 多出的绘制单列。
"""

import json
import math
import os
import re

from . import common
from .common import KbpError

FIELDS = ("pos", "size", "color", "alpha", "rot")
SCENE_W, SCENE_H = 1920, 1080
# FR、CLK 在场景右下角：x 1660–1860、y（向上）10–70；step4/cmp_real.py 排除 diff[990:, 1640:]（1920×1080 图片坐标）
KBP_LAYERS_BOX = (1640, 990)


def _tolerant(text):
    return json.loads(re.sub(r"(?<=[\[,:\s])-?(?:NaN|Infinity)(?=\s*[,\]}])", "null", text))


def _read_tolerant(path):
    try:
        with open(path, encoding="utf-8") as f:
            return _tolerant(f.read())
    except FileNotFoundError:
        raise KbpError("data", "找不到文件 %s" % path)
    except ValueError as e:
        raise KbpError("data", "%s 不是 JSON：%s" % (path, e))


def _prepare(path, overwrite):
    if not path:
        return None
    path = os.path.abspath(path)
    if os.path.exists(path) and not overwrite:
        raise KbpError("data", "输出已存在（要覆盖加 --overwrite）：%s" % path)
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    return path


def _write_text(path, lines):
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines) + "\n")


def _e(v):
    """同 JS 的 toExponential(2)。"""
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return "NaN"
    text = "%.2e" % v
    mantissa, exp = text.split("e")
    return "%se%s%d" % (mantissa, "-" if int(exp) < 0 else "+", abs(int(exp)))


# ==================== track ====================


_UNDEFINED = object()


def _num(v):
    """JS 语义：算术里 null 是 0（NaN 读成了 null，同 cmp-wpe.ts），undefined（数组越界）是 NaN。"""
    if v is _UNDEFINED:
        return float("nan")
    return 0.0 if v is None else float(v)


def _field_diff(va, vb):
    """cmp-wpe.ts：数组取各分量 |a − b| 的最大值（Math.max，有 NaN 即 NaN），标量直接相减。"""
    if isinstance(va, list):
        vb = vb if isinstance(vb, list) else []
        out = 0.0
        first = True
        for k, x in enumerate(va):
            d = abs(_num(x) - _num(vb[k] if k < len(vb) else _UNDEFINED))
            if math.isnan(d):
                return float("nan")
            out = d if first else max(out, d)
            first = False
        return out if not first else float("-inf")
    return abs(_num(va) - _num(vb))


def compare_tracks(ours, wpe, skip=()):
    ours_frames = {f["frame"]: f for f in ours.get("frames", [])}
    wpe_frames = [(f["frame"], f) for f in wpe.get("frames", [])]
    stats = {}
    missing = []
    skip = set(skip)
    for frame, w in wpe_frames:
        o = ours_frames.get(frame)
        if o is None:
            missing.append(frame)
            continue
        names = list(dict.fromkeys(list((w.get("systems") or {}).keys()) + list((o.get("systems") or {}).keys())))
        for name in names:
            if name in skip:
                continue
            s = stats.setdefault(name, {"pairs": 0, "countMismatch": 0, "frames": 0, "max": {k: 0.0 for k in FIELDS}})
            a = (w.get("systems") or {}).get(name) or []
            b = (o.get("systems") or {}).get(name) or []
            if not isinstance(a, list) or not isinstance(b, list):
                raise KbpError("data", "系统 %s 不是逐粒子数组（按绘制认的轨迹不能这样比）" % name)
            s["frames"] += 1
            if len(a) != len(b):
                s["countMismatch"] += 1
                continue
            for p, q in zip(a, b):
                s["pairs"] += 1
                for key in FIELDS:
                    va, vb = p.get(key), q.get(key)
                    if va is None or vb is None:
                        continue
                    d = _field_diff(va, vb)
                    if d > s["max"][key]:  # NaN 不更新（同 JS 的比较）
                        s["max"][key] = d
    return {"frames": [f for f, _ in wpe_frames], "missing": missing, "skip": sorted(skip), "systems": stats}


def track(args):
    ours = _read_tolerant(args.ours)
    wpe = _read_tolerant(args.wpe)
    skip = [s for s in (args.skip or "").split(",") if s]
    result = compare_tracks(ours, wpe, skip)
    lines = []
    for frame in result["missing"]:
        lines.append("第 %d 帧：我们没有" % frame)
    lines.append("帧 %s；跳过 %s" % (",".join(str(f) for f in result["frames"]), ",".join(skip) or "无"))
    for name, s in result["systems"].items():
        lines.append("  %s 配对 %3d%s  pos %s  size %s  color %s  alpha %s  rot %s" % (
            name.ljust(14), s["pairs"], "（%d 帧粒子数不同）" % s["countMismatch"] if s["countMismatch"] else "",
            _e(s["max"]["pos"]), _e(s["max"]["size"]), _e(s["max"]["color"]), _e(s["max"]["alpha"]), _e(s["max"]["rot"])))
    out = _prepare(args.out, args.overwrite)
    if out:
        _write_text(out, lines)
        common.write_json(out + ".json", dict(result, ours=os.path.abspath(args.ours), wpe=os.path.abspath(args.wpe)),
                          indent=1)
    summary = {"ok": True, "systems": {n: {"pairs": s["pairs"], "countMismatch": s["countMismatch"],
                                           **{k: s["max"][k] for k in FIELDS}} for n, s in result["systems"].items()},
               "missing": result["missing"]}
    if out:
        summary["out"] = out
    else:
        summary["text"] = lines
    return summary


# ==================== frame ====================


def _image(path):
    from PIL import Image

    if not os.path.isfile(path):
        raise KbpError("data", "找不到图片 %s" % path)
    return Image.open(path).convert("RGB")


def _fit(ours, wpe, crop=None, resize=False):
    """把我们的图对到 WPE 的大小；返回 (图, 说明)。"""
    from PIL import Image

    notes = []
    if crop:
        top, bottom, left, right = crop
        ours = ours.crop((left, top, ours.width - right, ours.height - bottom))
        notes.append("裁掉 上 %d 下 %d 左 %d 右 %d" % (top, bottom, left, right))
    if ours.size == wpe.size:
        return ours, notes
    same_ratio = ours.width * wpe.height == ours.height * wpe.width
    if not resize and ours.width >= wpe.width and ours.height >= wpe.height and (
            ours.width == wpe.width or ours.height == wpe.height or same_ratio):
        if ours.width != wpe.width and ours.height != wpe.height:
            raise KbpError("data", "尺寸不同（我们 %s，WPE %s）：同比例要缩放，加 --resize" % (ours.size, wpe.size))
        left, top = (ours.width - wpe.width) // 2, (ours.height - wpe.height) // 2
        notes.append("居中裁成 %d×%d（左 %d、上 %d）" % (wpe.width, wpe.height, left, top))
        return ours.crop((left, top, left + wpe.width, top + wpe.height)), notes
    if ours.width * wpe.height != ours.height * wpe.width:
        scale = max(wpe.width / ours.width, wpe.height / ours.height)
        w, h = round(wpe.width / scale), round(wpe.height / scale)
        left, top = (ours.width - w) // 2, (ours.height - h) // 2
        ours = ours.crop((left, top, left + w, top + h))
        notes.append("cover 取中间 %d×%d" % (w, h))
    notes.append("BOX 缩到 %d×%d" % wpe.size)
    return ours.resize(wpe.size, Image.BOX), notes


def _blobs(mask, cell):
    """超阈值像素按 cell×cell 格子聚类成 8 连通块；返回 [(x0, y0, x1, y1, 格数)]，按格数降序、再按位置。"""
    import numpy as np

    ys, xs = np.nonzero(mask)
    cells = set(zip((xs // cell).tolist(), (ys // cell).tolist()))
    seen, blobs = set(), []
    for start in sorted(cells):
        if start in seen:
            continue
        stack, members = [start], []
        seen.add(start)
        while stack:
            cx, cy = stack.pop()
            members.append((cx, cy))
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    n = (cx + dx, cy + dy)
                    if n in cells and n not in seen:
                        seen.add(n)
                        stack.append(n)
        bx = [m[0] for m in members]
        by = [m[1] for m in members]
        blobs.append((min(bx) * cell, min(by) * cell, (max(bx) + 1) * cell, (max(by) + 1) * cell, len(members)))
    blobs.sort(key=lambda b: (-b[4], b[1], b[0]))
    return blobs


def _bboxes(meta, width, height):
    """kbp-meta.json 的对象 bbox（场景坐标、y 向上）→ 图片坐标的 [x0, y0, x1, y1)。"""
    scene_w, scene_h = (meta.get("scene") or [SCENE_W, SCENE_H])[:2]
    sx, sy = width / scene_w, height / scene_h
    out = []
    for name in meta.get("order") or []:
        box = ((meta.get("objects") or {}).get(name) or {}).get("bbox")
        if not box:
            continue
        x0, y0, x1, y1 = box
        out.append((name, (int(math.floor(x0 * sx)), int(math.floor((scene_h - y1) * sy)),
                           int(math.ceil(x1 * sx)), int(math.ceil((scene_h - y0) * sy)))))
    return out


def compare_frames(ours, wpe, *, exclude_kbp=False, meta=None, threshold=32, cell=32):
    import numpy as np

    a = np.asarray(ours, dtype=np.int16)
    b = np.asarray(wpe, dtype=np.int16)
    diff = np.abs(a - b).max(axis=2)
    h, w = diff.shape
    excluded = None
    if exclude_kbp:
        x0 = int(round(KBP_LAYERS_BOX[0] * w / SCENE_W))
        y0 = int(round(KBP_LAYERS_BOX[1] * h / SCENE_H))
        diff[y0:, x0:] = 0
        excluded = [x0, y0, w, h]
    total = w * h
    counts = {str(t): int((diff > t).sum()) for t in (0, 2, 8, 32)}
    hist = np.bincount(diff.ravel(), minlength=256)
    result = {
        "size": [w, h],
        "excluded": excluded,
        "counts": counts,
        "fractions": {k: v / total for k, v in counts.items()},
        "max": int(diff.max()),
        "mean": float(diff.mean()),
        "histogram": [int(x) for x in hist],
        "threshold": threshold,
        "cell": cell,
        "blobs": [list(x) for x in _blobs(diff > threshold, cell)],
    }
    boxes = _bboxes(meta, w, h) if meta else []
    if boxes:
        owner = np.full(diff.shape, -1, dtype=np.int32)
        for i in range(len(boxes) - 1, -1, -1):  # 先列的对象优先：倒着覆盖
            x0, y0, x1, y1 = boxes[i][1]
            owner[max(0, y0):max(0, y1), max(0, x0):max(0, x1)] = i
        objects = {}
        nonzero = diff > 0
        for i, (name, box) in enumerate(boxes + [("other", None)]):
            sel = nonzero & (owner == (i if box else -1))
            n = int(sel.sum())
            objects[name] = {"pixels": n, "max": int(diff[sel].max()) if n else 0, "box": list(box) if box else None}
        result["objects"] = objects
    return result, diff


def frame(args):
    from PIL import Image, ImageChops

    ours, wpe = _image(args.ours), _image(args.wpe)
    crop = [int(x) for x in args.crop.split(",")] if args.crop else None
    if crop and len(crop) != 4:
        raise KbpError("kbp", "--crop 是 上,下,左,右 四个数")
    fitted, notes = _fit(ours, wpe, crop, args.resize)
    meta = common.read_json(args.meta) if args.meta else None
    if meta and not any("bbox" in (o or {}) for o in (meta.get("objects") or {}).values()):
        notes.append("kbp-meta.json 没有 bbox：只报整帧")
    result, diff = compare_frames(fitted, wpe, exclude_kbp=bool(args.meta or args.kbp_layers), meta=meta,
                                  threshold=args.threshold, cell=args.cell)
    result.update(ours=os.path.abspath(args.ours), wpe=os.path.abspath(args.wpe), fit=notes,
                  ours_size=list(ours.size))
    w, h = result["size"]
    lines = ["%s 对 %s：%d×%d%s" % (os.path.basename(args.ours), os.path.basename(args.wpe), w, h,
                                  "（%s）" % "；".join(notes) if notes else "")]
    if result["excluded"]:
        lines.append("  排除 FR / CLK：x ≥ %d、y ≥ %d" % tuple(result["excluded"][:2]))
    lines.append("  " + "，".join("> %s：%d（%.3f%%）" % (t, n, 100 * result["fractions"][t]) for t, n in result["counts"].items())
                 + "，最大 %d，平均 %.3f" % (result["max"], result["mean"]))
    lines.append("  > %d 的连通块 %d 个（格子 %dpx）：" % (args.threshold, len(result["blobs"]), args.cell))
    for x0, y0, x1, y1, n in result["blobs"][:30]:
        lines.append("    (%d, %d)–(%d, %d)，%d×%d，%d 格" % (x0, y0, x1, y1, x1 - x0, y1 - y0, n))
    if "objects" in result:
        lines.append("  按对象（不同像素 / 最大差）：")
        for name, o in sorted(result["objects"].items(), key=lambda kv: -kv[1]["pixels"]):
            lines.append("    %-14s %7d / %3d" % (name, o["pixels"], o["max"]))
    out = _prepare(args.out, args.overwrite)
    heat = _prepare(args.heat, args.overwrite)
    zoom = _prepare(args.zoom_out, args.overwrite) if args.zoom else None
    if heat:
        d = ImageChops.difference(fitted, wpe)
        if result["excluded"]:
            x0, y0 = result["excluded"][:2]
            d.paste((0, 0, 0), (x0, y0, w, h))
        gain = args.heat_gain
        d.convert("L").point(lambda v: min(255, v * gain)).save(heat)
        result["heat"] = heat
    if args.zoom:
        x, y, zw, zh = [int(v) for v in args.zoom.split(",")]
        if not zoom:
            raise KbpError("kbp", "--zoom 要配 --zoom-out <png>")
        tile = Image.new("RGB", (zw * 2, zh))
        tile.paste(fitted.crop((x, y, x + zw, y + zh)), (0, 0))
        tile.paste(wpe.crop((x, y, x + zw, y + zh)), (zw, 0))
        tile.resize((zw * 4, zh * 2), Image.NEAREST).save(zoom)
        result["zoom"] = zoom
    if out:
        _write_text(out, lines)
        common.write_json(out + ".json", result, indent=1)
    summary = {"ok": True, "size": result["size"], "counts": result["counts"], "max": result["max"],
               "blobs": len(result["blobs"]), "fit": notes}
    if "objects" in result:
        summary["objects"] = {k: v["pixels"] for k, v in result["objects"].items()}
    for key in ("heat", "zoom"):
        if key in result:
            summary[key] = result[key]
    if out:
        summary["out"] = out
    else:
        summary["text"] = lines
    return summary


# ==================== stats ====================


def _merge(ranges, digits=None):
    ranges = [r for r in ranges if r]
    if not ranges:
        return None
    lo, hi = min(r[0] for r in ranges), max(r[1] for r in ranges)
    return [round(lo, digits), round(hi, digits)] if digits is not None else [lo, hi]


def _ours_sample(data, label):
    samples = data.get("samples") if isinstance(data, dict) else None
    if samples is None:
        if isinstance(data, dict) and "particles" in data:
            return label or "sample", data
        raise KbpError("data", "我们的统计不是 real.json 的形状（samples.<名字>.particles[] 或 particles[]）")
    if label:
        if label not in samples:
            raise KbpError("data", "没有样本 %s（有 %s）" % (label, "、".join(samples)))
        return label, samples[label]
    if len(samples) != 1:
        raise KbpError("kbp", "real.json 里有多个样本（%s），用 --label 选一个" % "、".join(samples))
    name = next(iter(samples))
    return name, samples[name]


def compare_stats(sample, wpe):
    layers = sample.get("particles") or []
    rows = []
    for i, layer in enumerate(layers):
        s = layer.get("summary") or {}
        draws = [frame["draws"][i] for frame in wpe if i < len(frame.get("draws") or [])]
        pos = s.get("position") or {}
        ours = {
            "size": [s["size"]["min"], s["size"]["max"]] if s.get("size") else None,
            "x": [pos["min"][0], pos["max"][0]] if pos else None,
            "y": [pos["min"][1], pos["max"][1]] if pos else None,
            "alpha": [s["alpha"]["min"], s["alpha"]["max"]] if s.get("alpha") else None,
        }
        theirs = {key: _merge([d.get(key) for d in draws], 3) for key in ("size", "x", "y", "alpha")}  # 同 b3/cmp_stats.py：先舍入到 3 位
        rows.append({"index": i, "name": layer.get("name"), "alive": layer.get("alive"), "capacity": layer.get("capacity"),
                     "wpe_counts": [d.get("count") for d in draws], "ours": ours, "wpe": theirs})
    most = max((len(frame.get("draws") or []) for frame in wpe), default=0)
    extra = [[frame["draws"][j]["count"] for frame in wpe if j < len(frame.get("draws") or [])]
             for j in range(len(layers), most)]
    return {"time": sample.get("time"), "wpe_time": [f.get("time") for f in wpe], "layers": rows, "wpe_extra": extra}


def stats(args):
    data = common.read_json(args.ours)
    wpe = common.read_json(args.wpe)
    if not isinstance(wpe, list):
        raise KbpError("data", "%s 不是 kbp rdc stats 的结果（每帧一项的数组）" % args.wpe)
    name, sample = _ours_sample(data, args.label)
    result = compare_stats(sample, wpe)
    show = lambda r, d: "%.*f–%.*f" % (d, r[0], d, r[1]) if r else "—"  # noqa: E731
    lines = ["== %s（我们 %d 层，WPE %d 次粒子绘制）  我们回放到 %s s，WPE g_Time %s" % (
        name, len(result["layers"]), len(wpe[0]["draws"]) if wpe else 0,
        "%.1f" % result["time"] if isinstance(result["time"], (int, float)) else "?",
        [round(t, 2) if t else None for t in result["wpe_time"]])]
    for row in result["layers"]:
        lines.append("  %-8s 粒子数 我们 %s（容量 %s）/ WPE %s" % (row["name"], row["alive"], row["capacity"], row["wpe_counts"]))
        for key in ("size", "x", "y", "alpha"):
            digits = 3 if key == "alpha" else 1
            lines.append("    %-6s 我们 %s  WPE %s" % (key, show(row["ours"][key], digits), show(row["wpe"][key], digits)))
    for j, counts in enumerate(result["wpe_extra"]):
        lines.append("  WPE 多出的第 %d 次绘制（我们没有的层）：粒子数 %s" % (len(result["layers"]) + j + 1, counts))
    out = _prepare(args.out, args.overwrite)
    if out:
        _write_text(out, lines)
        common.write_json(out + ".json", dict(result, sample=name), indent=1)
    summary = {"ok": True, "sample": name, "layers": len(result["layers"]), "wpe_extra": len(result["wpe_extra"])}
    if out:
        summary["out"] = out
    else:
        summary["text"] = lines
    return summary


def cli(args):
    if args.action == "track":
        return track(args)
    if args.action == "frame":
        return frame(args)
    if args.action == "stats":
        return stats(args)
    raise KbpError("kbp", "未知的动作 %s" % args.action)
