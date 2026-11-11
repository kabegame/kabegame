"""造工程（kbp-tools 点 2）：确定性测试工程的生成库，加上 `kbp gen <模块> [工程…]`。

从 `ignore/p4/gen.py`、`gen_b.py`、`gen_c.py` 抽出通用部分，名字和签名照旧，现有生成器只改 import 行就能用：

    from kbp import gen              # 原来的 import gen
    from kbp import gen as gen_b     # 原来的 import gen_b（gen_b 的通用部分也在这里）
    from kbp import gen as gen_c     # 原来的 import gen_c

实验定义（哪些系统、什么参数）是数据，留在数据目录 `<data>/defs/<模块>.py`，模块里有 `PROJECTS = {工程名: 无参函数}`；
`kbp gen` 按它生成到 `<data>/proj/<工程>`。

库里有：
- 写文件：`write`、`write_json`（制表符缩进、不转义中文、LF、末尾不加换行，同旧脚本）；
- 固定图层：`FR_COLOR`（帧号进颜色、每 50 帧写 `[kbp]` 日志）、`FR_CURSOR`（同 FR_COLOR，条目另加屏幕光标两列、每 10 帧写）、
  `CLK_VERT` / `CLK_FRAG`（时钟）、`CLK_PTR_VERT`（带指针）、`layer`；
- 模块与系统：`fixed`、`move`、`FADE`、`OSC_ALPHA`、`CAP`、`OSC_POS`、`numbered`、`system`（gen_b 版）、`particle_object`、
  `material`、`particle_material`、`image_layer`、`image_assets`、`GENERAL`；
- P4c 起的：`at`、`ring`、`with_cps`、`CENTER`、脚本片段 `MOVE_ORIGIN` / `SPIN_ANGLES`（脚本里图层的 `angles` 是度，
  scene.json 里静态的 `angles` 是弧度；SPIN_ANGLES 每秒转 0.3 度）；
- `write_project`：gen_b 与 gen_c 的合并版（见函数说明），另有可选的 `track`、`bbox`、`cursor`；
- 路径：`HERE`（= 数据目录，旧写法 `os.path.join(gen.HERE, 'proj', 名字)` 照旧落在 `<data>/proj`）、`MODELS`（随库的
  `assets/models`，两行版 `solidlayer.json`）、`ASSETS`（`<KABEGAME_WPE_ROOT>/assets`）、`SHIMMER`（默认工程
  shimmering_particles 的 shaders）、`TEXSRC`（`<data>/texsrc`，从创意工坊导出的纹理不入库）。`HERE`、`TEXSRC` 跟着
  `configure` 走，是惰性属性。
"""

import contextlib
import importlib.util
import json
import os
import shutil
import sys
import time

from . import common
from .common import KbpError

ASSET_DIR = os.path.join(common.SKILL_DIR, "assets")
MODELS = os.path.join(ASSET_DIR, "models")

# configure() 设的输出位置：data 缺省 KBP_DATA → ignore/p4；out 缺省 <data>/proj
_config = {"data": None, "out": None, "overwrite": True, "written": []}


def configure(data=None, out=None, overwrite=True):
    """设数据目录与工程输出目录。overwrite 为 False 时 write_project 遇到已有工程报错（kbp gen 缺省如此）。"""
    _config["data"] = data
    _config["out"] = out
    _config["overwrite"] = overwrite
    _config["written"] = []


def data_dir():
    return common.data_dir(_config["data"])


def proj_dir():
    """工程输出目录：configure 的 out，缺省 <data>/proj。"""
    return os.path.abspath(_config["out"]) if _config["out"] else os.path.join(data_dir(), "proj")


def written():
    """本次 configure 以来 write_project 写过的工程目录。"""
    return list(_config["written"])


def __getattr__(name):
    """惰性属性（PEP 562）：随 configure 与环境变量变。"""
    if name == "HERE":
        return data_dir()
    if name == "TEXSRC":
        return os.path.join(data_dir(), "texsrc")
    if name == "ASSETS":
        return os.path.join(common.wpe_dir(), "assets")
    if name == "SHIMMER":
        return os.path.join(common.wpe_dir(), "projects", "defaultprojects", "shimmering_particles", "shaders")
    raise AttributeError("module 'kbp.gen' has no attribute %r" % name)


# ==================== 写文件（gen.py） ====================


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def write_json(path, obj):
    write(path, json.dumps(obj, indent="\t", ensure_ascii=False))


# ==================== 固定图层（gen.py、gen_c.py） ====================

# 帧号写进颜色（R 低 8 位，G 高 8 位），每 50 帧把帧号、engine.frametime、engine.runtime 写进 log.txt。
# console.log 不写文件，要用 console.error（p3 实测）
FR_COLOR = r"""'use strict';
let frame = 0;
let buffer = [];
export function update(value) {
	frame++;
	value.x = (frame % 256) / 255;
	value.y = (Math.floor(frame / 256) % 256) / 255;
	value.z = 1;
	buffer.push(frame + ',' + engine.frametime.toFixed(6) + ',' + engine.runtime.toFixed(6));
	if (buffer.length >= 50) {
		console.error('[kbp] ' + buffer.join(' '));
		buffer = [];
	}
	return value;
}
"""

# 帧号写进颜色（同 FR_COLOR），每帧另记 input.cursorScreenPosition 的 x、y（String() 原样），每 10 帧刷一次 log.txt：
#   [kbp] 帧号,帧时间,累计时间,屏幕x,屏幕y
# 屏幕光标是壁纸窗口内的像素（原点左上、y 朝下；窗口外为负或超出尺寸、不钳制）；g_PointerPosition 逐位等于
# float32(屏幕光标 / 窗口尺寸)，脚本第 f 帧记下的就是粒子第 f 帧用的（ignore/p5/cur 实测，p5a-cur / p5a-cur3）。
# 读光标包 try：Kabegame 还没有 input（P6），读不到时两列写 nan，不让整个 update 被禁用。每 10 帧刷一次，fps 低时尾巴丢得少
FR_CURSOR = r"""'use strict';
let frame = 0;
let buffer = [];
export function update(value) {
	frame++;
	value.x = (frame % 256) / 255;
	value.y = (Math.floor(frame / 256) % 256) / 255;
	value.z = 1;
	let cursor = 'nan,nan';
	try {
		const s = input.cursorScreenPosition;
		cursor = String(s.x) + ',' + String(s.y);
	} catch (e) {
		cursor = 'nan,nan';
	}
	buffer.push(frame + ',' + engine.frametime.toFixed(6) + ',' + engine.runtime.toFixed(6) + ',' + cursor);
	if (buffer.length >= 10) {
		console.error('[kbp] ' + buffer.join(' '));
		buffer = [];
	}
	return value;
}
"""

# 输出要真的依赖 g_Time、g_Frametime：着色器没读的常量 referenced 为 false，值是垃圾
CLK_VERT = r"""uniform mat4 g_ModelViewProjectionMatrix;
uniform float g_Time;
uniform float g_Frametime;

attribute vec3 a_Position;

varying vec3 v_Value;

void main() {
	gl_Position = mul(vec4(a_Position, 1.0), g_ModelViewProjectionMatrix);
	v_Value = vec3(frac(g_Time), frac(g_Time / 256.0), g_Frametime);
}
"""
CLK_FRAG = r"""varying vec3 v_Value;

void main() {
	gl_FragColor = vec4(v_Value, 1.0);
}
"""

# CLK_PTR（P4c 起）：同时读 g_PointerPosition / g_PointerPositionLast，提取器从常量里读出 WPE 当帧用的指针
CLK_PTR_VERT = r"""uniform mat4 g_ModelViewProjectionMatrix;
uniform float g_Time;
uniform float g_Frametime;
uniform vec2 g_PointerPosition;
uniform vec2 g_PointerPositionLast;

attribute vec3 a_Position;

varying vec3 v_Value;

void main() {
	gl_Position = mul(vec4(a_Position, 1.0), g_ModelViewProjectionMatrix);
	v_Value = vec3(frac(g_Time) + g_PointerPosition.x * 0.001, frac(g_Time / 256.0) + g_PointerPosition.y * 0.001,
		g_Frametime + (g_PointerPositionLast.x + g_PointerPositionLast.y) * 0.001);
}
"""


def clk_audio_vert(resolutions):
    """CLK_PTR_VERT 加读 g_AudioSpectrum<n>Left / Right（P4e 起）：每个数组的和乘 1e-6 加进输出，让常量被读到、值不影响时钟读数
    （提取器只读常量，不读像素）。kbp rdc track 把它们原样记进帧的 `audio`。"""
    decls = "".join("uniform float g_AudioSpectrum%d%s[%d];\n" % (n, side, n) for n in resolutions for side in ("Left", "Right"))
    sums = "".join("\tfor (int i%d = 0; i%d < %d; i%d++) s += g_AudioSpectrum%dLeft[i%d] + g_AudioSpectrum%dRight[i%d];\n"
                   % (n, n, n, n, n, n, n, n) for n in resolutions)
    return CLK_PTR_VERT.replace("attribute vec3 a_Position;", decls + "\nattribute vec3 a_Position;").replace(
        "\tgl_Position = mul(", "\tfloat s = 0.0;\n" + sums + "\tgl_Position = mul(").replace(
        "g_Frametime + (g_PointerPositionLast.x", "g_Frametime + s * 0.000001 + (g_PointerPositionLast.x")


def layer(oid, name, origin, size, image="models/util/solidlayer.json", color="1 1 1"):
    return {"id": oid, "name": name, "image": image, "origin": origin, "scale": "1 1 1", "angles": "0 0 0",
            "size": size, "color": color, "alpha": 1, "brightness": 1, "visible": True, "colorBlendMode": 0,
            "parallaxDepth": "0 0", "copybackground": True}


# ==================== 模块与系统（gen.py、gen_b.py） ====================


def fixed(name, value, **extra):
    return {"name": name, "min": value, "max": value, **extra}


def move(gravity="0 0 0"):
    return {"name": "movement", "gravity": gravity}


FADE = {"name": "alphafade", "fadeintime": 0.25, "fadeouttime": 0.25}
OSC_ALPHA = {"name": "oscillatealpha", "frequencymin": 0.5, "frequencymax": 0.5, "phasemin": 0, "phasemax": 0,
             "scalemin": 0.5, "scalemax": 0.5}
CAP = {"name": "capvelocity", "maxspeed": 100}
OSC_POS = {"name": "oscillateposition", "frequencymin": 0.5, "frequencymax": 0.5, "phasemin": 0, "phasemax": 0,
           "scalemin": 50, "scalemax": 50, "mask": "1 0 0"}


def numbered(items, start):
    return [dict(item, id=start + i) for i, item in enumerate(items)]


GENERAL = {"ambientcolor": "0.3 0.3 0.3", "bloom": False, "camerafade": False, "cameraparallax": False,
           "clearcolor": "0 0 0", "clearenabled": True, "hdr": False,
           "orthogonalprojection": {"width": 1920, "height": 1080}, "skylightcolor": "0.3 0.3 0.3", "zoom": 1}


def system(rgb, origin, *, emitter=None, initializers=(), operators=None, lifetime=8, size=40, velocity="100 0 0",
           rate=1, maxcount=1, material="white", starttime=None, flags=0, **top):
    """一个粒子系统（gen_b 版）。rgb 写进 colorrandom（min = max），提取器按它认系统；rgb 为 None 时不写 colorrandom（要按顺序认）。
    emitter 缺省是 distancemax 0 的 sphererandom。operator 从 id 20 编号，renderer 是 id 40 的 sprite（top 里给 renderer 时覆盖）。"""
    emit = emitter or {"name": "sphererandom", "origin": origin, "distancemin": 0, "distancemax": 0, "rate": rate}
    initializer = [fixed("lifetimerandom", lifetime), fixed("sizerandom", size), fixed("velocityrandom", velocity)]
    if rgb is not None:
        initializer.append(fixed("colorrandom", rgb))
    initializer += list(initializers)
    spec = {
        "children": None,
        "controlpoint": [{"id": i} for i in range(8)],
        "emitter": numbered([emit], 1),
        "flags": flags,
        "initializer": numbered(initializer, 2),
        "material": f"materials/particle/{material}.json",
        "maxcount": maxcount,
        "operator": numbered(list(operators) if operators is not None else [move()], 20),
        "renderer": [{"id": 40, "name": "sprite"}],
    }
    if starttime:
        spec["starttime"] = starttime
    spec.update(top)
    return spec


def particle_object(oid, name):
    return {"id": oid, "name": name, "particle": f"particles/{name}.json", "origin": "0 0 0", "scale": "1 1 1",
            "angles": "0 0 0", "parallaxDepth": "0 0", "visible": True, "locktransforms": False}


def material(shader, textures=None):
    single = {"shader": shader, "cullmode": "nocull", "depthtest": "disabled", "depthwrite": "disabled",
              "blending": "translucent" if textures else "normal"}
    if textures:
        single["textures"] = textures
    return {"passes": [single]}


# .tex 头：偏移 22 是标志，34 / 38 是图像宽高（rea-p4b-render.md 1.1、「assets 候选纹理」）
TEX_FLAGS, TEX_IMAGE_W, TEX_IMAGE_H = 22, 34, 38


def particle_material(textures, *, blending="translucent", combos=None, constants=None):
    single = {"shader": "genericparticle", "cullmode": "nocull", "depthtest": "disabled", "depthwrite": "disabled",
              "blending": blending, "textures": list(textures)}
    if combos:
        single["combos"] = combos
    if constants:
        single["constantshadervalues"] = constants
    return {"passes": [single]}


def image_layer(origin, size, model):
    return layer(0, "", origin, size, image=f"models/{model}.json")


def image_assets(name, texture):
    """图像层的模型与材质（genericimage4，和 kabegame-sample 的写法相同）。"""
    return {
        f"models/{name}.json": {"material": f"materials/kbi/{name}.json"},
        f"materials/kbi/{name}.json": {"passes": [{
            "blending": "translucent", "combos": {}, "cullmode": "nocull", "depthtest": "disabled",
            "depthwrite": "disabled", "shader": "genericimage4", "textures": [texture]}]},
    }


# ==================== P4c 起的（gen_c.py） ====================

CENTER = "960 540 0"

# 对象随时间平移、旋转（engine.runtime 是钳过的场景时间，回放时按日志的时间算 W）。脚本里图层的 angles 是度：
# SPIN_ANGLES 每秒转 0.3 度（scene.json 里静态的 angles 才是弧度）
MOVE_ORIGIN = r"""'use strict';
export function update(value) {
	value.x = 960 + 300 * Math.sin(engine.runtime * 0.5);
	value.y = 540 + 150 * Math.sin(engine.runtime * 0.3);
	return value;
}
"""
SPIN_ANGLES = r"""'use strict';
export function update(value) {
	value.z = engine.runtime * 0.3;
	return value;
}
"""


def at(origin, angles=None):
    """粒子对象的位置（和角度，弧度）：系统挂在对象上，发射器原点为 0。"""
    out = {"origin": origin}
    if angles:
        out["angles"] = angles
    return out


def ring(distance=100, sign="1 0 0", controlpoint=0, origin="0 0 0", rate=1):
    """出生点确定：控制点 + (distance, 0)（sign 定符号），速度 0。rea-p4c-sim.md「建议的确定性实验」的通用发射。"""
    return {"name": "sphererandom", "origin": origin, "distancemin": distance, "distancemax": distance,
            "directions": "1 0 0", "sign": sign, "speedmin": 0, "speedmax": 0, "rate": rate, "controlpoint": controlpoint}


def with_cps(spec, **cps):
    """改控制点数组：cps 是 {'cp1': {...}}，按下标替换。"""
    for key, value in cps.items():
        index = int(key[2:])
        spec["controlpoint"][index] = {"id": index, **value}
    return spec


# ==================== 写工程（gen_b.py + gen_c.py） ====================


def _project_root(name):
    if not isinstance(name, str) or not name or name in (".", "..") or any(c in name for c in "/\\:"):
        raise KbpError("kbp", "工程名不合法：%r" % (name,))
    return os.path.join(proj_dir(), name)


def _vec(text, n=3):
    parts = [float(v) for v in str(text).split()]
    return (parts + [0.0] * n)[:n]


def layer_bbox(obj):
    """图像层对象（origin、size、scale；不看 angles）的场景包围盒 [x0, y0, x1, y1]（y 向上）。"""
    ox, oy, _ = _vec(obj.get("origin", "0 0 0"))
    w, h = _vec(obj.get("size", "0 0"), 2)
    sx, sy, _ = _vec(obj.get("scale", "1 1 1"))
    hw, hh = abs(w * sx) / 2, abs(h * sy) / 2
    return [ox - hw, oy - hh, ox + hw, oy + hh]


def bbox_around(origin, half_width, half_height=None):
    """以 origin（"x y z" 或 (x, y)）为中心、半宽半高的场景包围盒 [x0, y0, x1, y1]。"""
    x, y = (_vec(origin)[:2] if isinstance(origin, str) else origin[:2])
    hh = half_width if half_height is None else half_height
    return [x - half_width, y - hh, x + half_width, y + hh]


def write_project(name, title, systems, *, images=(), materials=None, ident=None, overrides=None, files=None,
                  order=None, patches=None, version=3, properties=None, meta=None, object_meta=None, pointer=True,
                  track=None, bbox=None, cursor=False, audio=None):
    """写一个测试工程到 <proj_dir>/<name>（先删再写；configure(overwrite=False) 时已有就报错）。

    gen_b 的参数：systems：{名字: 粒子 JSON}；images：[(名字, 图层对象)]；order：对象顺序（名字列表），缺省图像在前、粒子在后；
    materials：{相对路径: 材质 JSON}；ident：{系统名: 'order'}，颜色会变的系统按绘制顺序认（没有 colorrandom 的自动按顺序）；
    overrides：{系统名: 对象上要并入的键}；files：{相对路径: 源文件}；patches：{相对路径: [(偏移, u32 值)]}，拷完后改写；
    version：scene.json 根的 version，None 时不写这个键；properties：并进 project.json 的用户属性。
    gen_c 的参数：meta：并入 kbp-meta.json 顶层（如 `corners: True` 让提取器读四角）；object_meta：{系统名: 并入该对象的键}
    （如 `draws: 2`，一个系统两个 renderer）。
    pointer：True（缺省，gen_c 起）CLK 用带指针的 CLK_PTR_VERT；False 是 gen_b 的 CLK_VERT。
    track：只在显式给出时写进 kbp-meta.json 的顶层 `track`；`"draws"` 让 `kbp rdc track` 自动按绘制原样保存（P4d 的绳与模块工程）。
    bbox（第 3 批）：{对象名: [x0, y0, x1, y1] | "auto"}，只在给出时写进 kbp-meta.json 对应对象的 `bbox`（场景坐标、y 向上，
    `kbp cmp frame --meta` 按它归类像素差）；"auto" 只对图像层：按 origin、size、scale 算（不看 angles）。粒子会动，包围盒要按实验
    自己估（`bbox_around(origin, 半宽, 半高)`）。不给时文件和旧生成器的逐字节相同。
    audio（P4e 起）：频谱分辨率的序列（如 (16, 64)）。给了时 CLK 用 clk_audio_vert（要 pointer 为 True），project.json 的 general
    声明 supportsaudioprocessing（WPE 才采集；写在 scene.json 里 Kabegame 会整张报不支持，p3c 的教训）。不给时文件和以前逐字节相同。
    cursor（P5a 收尾）：True 时 FR 用 FR_CURSOR（[kbp] 条目多两列屏幕光标，每 10 帧刷一次），回放可传 cursors: "log" 按每一帧的
    光标复现；缺省 False 用 FR_COLOR，文件和以前逐字节相同。注意 Kabegame 还没有 input（P6），这种工程编译报
    script:api:input.cursorScreenPosition（dev 探针强制渲染不受影响，kbp replay 的案例要放行）。"""
    root = _project_root(name)
    if os.path.isdir(root):
        if not _config["overwrite"]:
            raise KbpError("data", "工程已存在（不覆盖，要覆盖加 --overwrite）：%s" % root)
        shutil.rmtree(root)
    os.makedirs(root)
    shutil.copytree(MODELS, os.path.join(root, "models"))
    write_json(os.path.join(root, "models", "kbp_clk.json"), {"material": "materials/kbp_clk.json"})
    write_json(os.path.join(root, "materials", "kbp_clk.json"), material("kbp_clk"))
    if audio and not pointer:
        raise KbpError("kbp", "%s：audio 要和 pointer=True 一起用" % name)
    write(os.path.join(root, "shaders", "kbp_clk.vert"),
          clk_audio_vert(audio) if audio else (CLK_PTR_VERT if pointer else CLK_VERT))
    write(os.path.join(root, "shaders", "kbp_clk.frag"), CLK_FRAG)
    write_json(os.path.join(root, "materials", "particle", "white.json"), material("genericparticle", ["util/white"]))
    for path, value in (materials or {}).items():
        write_json(os.path.join(root, path), value)
    for path, source in (files or {}).items():
        target = os.path.join(root, path)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.copyfile(source, target)
    for path, edits in (patches or {}).items():
        target = os.path.join(root, path)
        with open(target, "r+b") as f:
            for offset, value in edits:
                f.seek(offset)
                f.write(value.to_bytes(4, "little"))

    objects = [layer(1, "FR", "1820 40 0", "80 60"), layer(2, "CLK", "1700 40 0", "80 60", image="models/kbp_clk.json")]
    objects[0]["color"] = {"script": FR_CURSOR if cursor else FR_COLOR, "value": "0 0 1"}
    data = {"order": [], "objects": {}}
    image_table = dict(images)
    names = order or [*image_table, *systems]
    if sorted(names) != sorted([*image_table, *systems]):
        raise KbpError("data", "%s：顺序表要正好覆盖全部对象" % name)
    for i, item in enumerate(names):
        if item in image_table:
            objects.append(dict(image_table[item], id=10 + i, name=item))
            data["order"].append(item)
            data["objects"][item] = {"kind": "image"}
            continue
        spec = systems[item]
        write_json(os.path.join(root, "particles", item + ".json"), spec)
        obj = particle_object(100 + i, item)
        obj.update((overrides or {}).get(item, {}))
        objects.append(obj)
        color = next((m for m in spec["initializer"] if m["name"] == "colorrandom"), None)
        how = (ident or {}).get(item, "color" if color else "order")
        data["order"].append(item)
        data["objects"][item] = {"kind": "particle", "ident": how,
                                 "rgb": [float(v) / 255 for v in color["min"].split()] if how == "color" else None}
    scene = {"camera": {"center": "0 0 -1", "eye": "0 0 0", "up": "0 1 0"}, "general": GENERAL, "objects": objects}
    if version is not None:
        scene["version"] = version
    write_json(os.path.join(root, "scene.json"), scene)
    write_json(os.path.join(root, "project.json"), {
        "file": "scene.json", "type": "scene", "title": title,
        "general": {**({"supportsaudioprocessing": True} if audio else {}),
                    "properties": {"schemecolor": {"order": 0, "text": "ui_browse_properties_scheme_color",
                                                   "type": "color", "value": "0 0 0"}, **(properties or {})}}})
    data.update(meta or {})
    for key, extra in (object_meta or {}).items():
        data["objects"][key].update(extra)
    for key, box in (bbox or {}).items():
        if key not in data["objects"]:
            raise KbpError("data", "%s：bbox 给了不存在的对象 %s" % (name, key))
        if box == "auto":
            if key not in image_table:
                raise KbpError("data", "%s：bbox 的 auto 只对图像层，%s 是粒子系统（用 bbox_around 估）" % (name, key))
            box = layer_bbox(image_table[key])
        if not (isinstance(box, (list, tuple)) and len(box) == 4 and box[0] <= box[2] and box[1] <= box[3]):
            raise KbpError("data", "%s：%s 的 bbox 要是 [x0, y0, x1, y1]（x0 ≤ x1、y0 ≤ y1）" % (name, key))
        data["objects"][key]["bbox"] = [float(v) for v in box]
    if track is not None:
        data["track"] = track
    write_json(os.path.join(root, "kbp-meta.json"), data)
    _config["written"].append(root)
    return root


# ==================== kbp gen ====================


def _load_defs(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def cli(args):
    data = common.data_dir(args.data)
    defs = os.path.abspath(args.defs) if args.defs else os.path.join(data, "defs")
    path = os.path.join(defs, args.module + ".py")
    if not os.path.isfile(path):
        raise KbpError("data", "找不到实验定义 %s（--defs 指定目录，缺省 <data>/defs）" % path)
    configure(data=data, out=args.out, overwrite=args.overwrite)
    started = time.time()
    # 实验定义同目录的模块可互相 import（旧生成器 gen_d → gen_c）；它们的 print 转到 stderr，stdout 只留摘要
    sys.path.insert(0, defs)
    with contextlib.redirect_stdout(sys.stderr):
        try:
            module = _load_defs(path, args.module)
        except KbpError:
            raise
        except Exception as e:  # 实验定义本身的错
            raise KbpError("data", "加载 %s 失败：%s: %s" % (path, type(e).__name__, e))
    projects = getattr(module, "PROJECTS", None)
    if not isinstance(projects, dict):
        raise KbpError("data", "%s 里没有 PROJECTS 字典" % path)
    if args.list:
        return {"ok": True, "module": args.module, "defs": path, "projects": list(projects)}
    names = args.projects or list(projects)
    unknown = [n for n in names if n not in projects]
    if unknown:
        raise KbpError("kbp", "%s 里没有工程 %s（有 %s）" % (args.module, "、".join(unknown), "、".join(projects)))
    out = proj_dir()
    existing = [n for n in names if os.path.exists(os.path.join(out, n))]
    if existing and not args.overwrite:
        raise KbpError("data", "工程已存在（不覆盖，要覆盖加 --overwrite）：%s" % "、".join(
            os.path.join(out, n) for n in existing[:5]))
    done = []
    with contextlib.redirect_stdout(sys.stderr):
        for n in names:
            try:
                projects[n]()
            except KbpError:
                raise
            except Exception as e:
                raise KbpError("data", "生成 %s 失败：%s: %s" % (n, type(e).__name__, e))
            target = os.path.join(out, n)
            if not os.path.isdir(target):
                raise KbpError("data", "%s 没写到 %s（旧写法按 gen.HERE/proj，即 <data>/proj 写；不要和 --out 混用）"
                               % (n, target))
            done.append(n)
    return {"ok": True, "module": args.module, "defs": path, "out": out, "projects": done,
            "seconds": round(time.time() - started, 3)}
