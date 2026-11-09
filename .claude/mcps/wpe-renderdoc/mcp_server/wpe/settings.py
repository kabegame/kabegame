"""
WPE 的 config.json：读、校验、照 WPE 自己的格式写回。

依据 .claude/plans/tools/rea-wpe-settings.md：
- WPE 只在启动时读 config.json，运行中外部改文件不生效，还会在它下次保存时被内存里的值覆盖；
  所以写只在 restart_wpe 里、WPE 退出之后做。
- 只读写当前用户段（段名是 Windows 用户名）`general.user` 下清单里的键（报告附录的键清单）。

格式（照 WPE 写出的文件实测，jsoncpp 的 BuiltStyledStreamWriter：indentation "\\t"、commentStyle None）：
- 制表符缩进、`"键" : 值`；非空对象 / 数组的左括号另起一行、与键同缩进；
- 对象的键按字节序排序；
- 数组：元素都是标量、且「4 + 2·(n−1) + 各元素长度」< 74（且 3n < 74）时写成一行 `[ a, b ]`，否则一项一行；
- 字符串只转义 `"`、`\\` 与控制字符，非 ASCII 原样写 UTF-8；
- 换行 CRLF，文件末尾没有换行。
数字按读进来的原文写回（浮点数的位数规则没法从现有文件确定），新写的值用 Python 的最短表示。
读入再写出逐字节相同是写之前的护栏：做不到就拒绝写，不冒险改别的键。
"""

from __future__ import annotations

import ctypes
import ctypes.wintypes as wt
import glob
import hashlib
import json
import os
import time
from typing import Any

from .. import paths
from .common import WpeError

RIGHT_MARGIN = 74
NEWLINE = "\r\n"


# ==================== 键清单 ====================

def _enum(*values):
    return {"type": "enum", "values": list(values)}


BOOL = {"type": "bool"}

# 键 → (general.user 下的路径, 取值, 类别)。类别同读码报告：就地 / 桌面重载 / 启动 / 主进程不读
KEYS: dict[str, dict[str, Any]] = {
    # 渲染 / 画质
    "fps": {"spec": {"type": "int", "min": 10, "max": "display"}, "category": "就地 / 新窗口"},
    "msaa": {"spec": _enum("none", "x2", "x4", "x8"), "category": "桌面重载 / 新窗口"},
    "postprocessing": {"spec": _enum("disabled", "enabled", "ultra", "displayhdr"), "category": "桌面重载 / 新窗口"},
    "resolution": {"spec": _enum("full", "half", "auto"), "category": "桌面重载 / 新窗口"},
    "shadows": {"spec": _enum("disabled", "low", "medium", "high", "ultra"), "category": "桌面重载 / 新窗口"},
    "volumetrics": {"spec": _enum("disabled", "low", "medium", "high", "ultra"), "category": "桌面重载 / 新窗口"},
    "reflection": {"spec": BOOL, "category": "就地 / 新窗口"},
    "preset": {"spec": _enum("low", "medium", "high", "ultra"), "category": "主进程不读（界面标签）"},
    # 播放策略（只作用于桌面壁纸，测试窗口不受影响）
    "playbackfocus": {"spec": _enum("run", "mute", "pause", "pauseall"), "category": "就地"},
    "playbackmaximized": {"spec": _enum("run", "mute", "pause", "pauseall", "stop"), "category": "就地"},
    "playbackfullscreen": {"spec": _enum("run", "mute", "pause", "pauseall", "stop"), "category": "就地"},
    "playbacksleep": {"spec": _enum("run", "pause", "stop"), "category": "就地"},
    "playbackonbattery": {"spec": _enum("run", "pause", "stop"), "category": "就地"},
    "playbackaudio": {"spec": _enum("run", "mute", "pause"), "category": "就地"},
    "apprules": {"spec": {"type": "readonly"}, "category": "就地"},
    "unpauseaero": {"spec": BOOL, "category": "就地"},
    "pausevram": {"spec": BOOL, "category": "就地"},
    # 性能 / 运行
    "processpriority": {"spec": _enum("normal", "belownormal"), "category": "就地"},
    "highprecisiontimer": {"spec": BOOL, "category": "就地"},
    "windowupdaterate": {"spec": {"type": "int", "min": 50, "max": 5000}, "category": "启动"},
    "loglevel": {"spec": _enum("none", "error", "verbose"), "category": "就地"},
    "safemode": {"spec": BOOL, "category": "启动"},
    "anticrash": {"spec": {"type": "bool", "nullable": True}, "category": "启动"},
    "monitordetection": {"spec": _enum("managed", "devicepath", "layout", "shellapi", "gdi"), "category": "启动"},
    "vdesktopenabled": {"spec": BOOL, "category": "启动"},
    "plugindelay": {"spec": {"type": "int", "min": 0, "max": 600000}, "category": "启动"},
    "plugins.ledextensions.enabled": {"spec": BOOL, "category": "界面标为需重启"},
    # 视频 / 音频
    "videoframework": {"spec": _enum("mfEngine", "mf", "dshow.lav.vmr9"), "category": "桌面重载"},
    "webmframework": {"spec": {"type": "enum", "values": ["cef", "native"], "nullable": True}, "category": "桌面重载"},
    "videohardwareacceleration": {"spec": BOOL, "category": "就地（推）"},
    "videoreadmode": {"spec": _enum("fromdisk", "frommemory"), "category": "就地（推）"},
    "videoloopmode": {"spec": _enum("default", "syncclock", "synctopo"), "category": "就地（推）"},
    "videoaudiooutput": {"spec": BOOL, "category": "就地"},
    "videomfstutterhack": {"spec": BOOL, "category": "界面标为需重启"},
    "audioinputdevice": {"spec": {"type": "string"}, "category": "就地"},
    "audioinputvolume": {"spec": {"type": "number", "min": 0, "max": 200}, "category": "就地"},
    "audioinputthreshold": {"spec": {"type": "number", "min": 0, "max": 10, "step": 0.1}, "category": "就地"},
    "reloadaudio": {"spec": BOOL, "category": "就地"},
    "mediaintegration": {"spec": BOOL, "category": "就地"},
    "mediablocklist": {"spec": {"type": "readonly"}, "category": "就地"},
}


def key_path(key: str) -> list[str]:
    return ["general", "user"] + key.split(".")


def describe_spec(spec: dict[str, Any]) -> str:
    kind = spec["type"]
    text = {"bool": "true / false", "string": "字符串", "readonly": "只读（数组或 null，不支持写）"}.get(kind)
    if kind == "enum":
        text = " / ".join(spec["values"])
    elif kind in ("int", "number"):
        top = "显示器最高刷新率" if spec["max"] == "display" else spec["max"]
        text = f"{'整数' if kind == 'int' else '数'} {spec['min']}…{top}" + (f"，步长 {spec['step']}" if "step" in spec else "")
    if spec.get("nullable"):
        text += " / null"
    return text


# ==================== 显示器最高刷新率（fps 上限） ====================


class _DEVMODEW(ctypes.Structure):
    _fields_ = [("dmDeviceName", ctypes.c_wchar * 32), ("dmSpecVersion", wt.WORD), ("dmDriverVersion", wt.WORD),
                ("dmSize", wt.WORD), ("dmDriverExtra", wt.WORD), ("dmFields", wt.DWORD),
                ("dmPositionX", ctypes.c_long), ("dmPositionY", ctypes.c_long),
                ("dmDisplayOrientation", wt.DWORD), ("dmDisplayFixedOutput", wt.DWORD),
                ("dmColor", ctypes.c_short), ("dmDuplex", ctypes.c_short), ("dmYResolution", ctypes.c_short),
                ("dmTTOption", ctypes.c_short), ("dmCollate", ctypes.c_short),
                ("dmFormName", ctypes.c_wchar * 32), ("dmLogPixels", wt.WORD), ("dmBitsPerPel", wt.DWORD),
                ("dmPelsWidth", wt.DWORD), ("dmPelsHeight", wt.DWORD), ("dmDisplayFlags", wt.DWORD),
                ("dmDisplayFrequency", wt.DWORD), ("dmICMMethod", wt.DWORD), ("dmICMIntent", wt.DWORD),
                ("dmMediaType", wt.DWORD), ("dmDitherType", wt.DWORD), ("dmReserved1", wt.DWORD),
                ("dmReserved2", wt.DWORD), ("dmPanningWidth", wt.DWORD), ("dmPanningHeight", wt.DWORD)]


class _DISPLAY_DEVICEW(ctypes.Structure):
    _fields_ = [("cb", wt.DWORD), ("DeviceName", ctypes.c_wchar * 32), ("DeviceString", ctypes.c_wchar * 128),
                ("StateFlags", wt.DWORD), ("DeviceID", ctypes.c_wchar * 128), ("DeviceKey", ctypes.c_wchar * 128)]


def max_refresh_rate() -> int | None:
    """各个接入桌面的显示器在所有显示模式里的最高刷新率（WPE 设置界面 fps 滑块的上限）。"""
    user32 = ctypes.WinDLL("user32")
    best = 0
    index = 0
    while True:
        dev = _DISPLAY_DEVICEW()
        dev.cb = ctypes.sizeof(dev)
        if not user32.EnumDisplayDevicesW(None, index, ctypes.byref(dev), 0):
            break
        index += 1
        if not dev.StateFlags & 0x1:  # DISPLAY_DEVICE_ATTACHED_TO_DESKTOP
            continue
        mode = 0
        while True:
            dm = _DEVMODEW()
            dm.dmSize = ctypes.sizeof(dm)
            if not user32.EnumDisplaySettingsW(dev.DeviceName, mode, ctypes.byref(dm)):
                break
            mode += 1
            best = max(best, dm.dmDisplayFrequency)
    return best or None


# ==================== 校验 ====================


def validate(changes: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """返回 (规范化后的改动, 问题清单)。问题清单不为空就不能写。"""
    if not isinstance(changes, dict):
        return {}, ["settings 要是 {键: 值} 对象"]
    problems = []
    clean: dict[str, Any] = {}
    for key, value in changes.items():
        info = KEYS.get(key)
        if info is None:
            problems.append(f"{key}：不在清单里（可写的键：{', '.join(k for k, v in KEYS.items() if v['spec']['type'] != 'readonly')}）")
            continue
        spec = info["spec"]
        kind = spec["type"]
        if value is None:
            if spec.get("nullable"):
                clean[key] = None
            else:
                problems.append(f"{key}：不能是 null")
            continue
        if kind == "readonly":
            problems.append(f"{key}：只读，不支持写")
        elif kind == "bool":
            if isinstance(value, bool):
                clean[key] = value
            else:
                problems.append(f"{key}：要 true / false，收到 {value!r}")
        elif kind == "enum":
            if isinstance(value, str) and value in spec["values"]:
                clean[key] = value
            else:
                problems.append(f"{key}：要是 {' / '.join(spec['values'])} 之一，收到 {value!r}")
        elif kind == "string":
            if isinstance(value, str) and value:
                clean[key] = value
            else:
                problems.append(f"{key}：要非空字符串，收到 {value!r}")
        elif kind in ("int", "number"):
            ok_type = isinstance(value, int) and not isinstance(value, bool)
            if kind == "number":
                ok_type = ok_type or isinstance(value, float)
            elif isinstance(value, float) and value.is_integer():
                value, ok_type = int(value), True
            if not ok_type:
                problems.append(f"{key}：要{'整数' if kind == 'int' else '数'}，收到 {value!r}")
                continue
            top = spec["max"]
            if top == "display":
                top = max_refresh_rate() or 360
            if not spec["min"] <= value <= top:
                problems.append(f"{key}：要在 {spec['min']}…{top} 之间，收到 {value!r}")
                continue
            if "step" in spec and abs(round(value / spec["step"]) * spec["step"] - value) > 1e-9:
                problems.append(f"{key}：步长 {spec['step']}，收到 {value!r}")
                continue
            clean[key] = value
    return clean, problems


# ==================== 读 ====================


class IntLit(int):
    """记着原文的整数：写回时照原文，保证读入再写出逐字节相同。"""
    raw: str


class FloatLit(float):
    raw: str


def _parse_int(text: str):
    v = IntLit(text)
    v.raw = text
    return v


def _parse_float(text: str):
    v = FloatLit(text)
    v.raw = text
    return v


def parse(text: str) -> dict[str, Any]:
    return json.loads(text, parse_int=_parse_int, parse_float=_parse_float)


def read_config(path: str | None = None) -> tuple[bytes, dict[str, Any]]:
    path = path or paths.wpe_config()
    with open(path, "rb") as f:
        raw = f.read()
    return raw, parse(raw.decode("utf-8"))


def windows_user() -> str | None:
    size = wt.DWORD(256)
    buf = ctypes.create_unicode_buffer(size.value)
    if ctypes.WinDLL("advapi32").GetUserNameW(buf, ctypes.byref(size)):
        return buf.value
    return os.environ.get("USERNAME")


def user_section(data: dict[str, Any]) -> str:
    """当前用户段名：Windows 用户名；文件里没有这一段、而只有一个用户段时用它。"""
    name = windows_user()
    if name and isinstance(data.get(name), dict):
        return name
    candidates = [k for k, v in data.items() if not k.startswith("?") and isinstance(v, dict)]
    if len(candidates) == 1:
        return candidates[0]
    raise WpeError(f"config.json 里找不到当前用户段（Windows 用户名 {name!r}；候选 {candidates}）")


def get_path(data: dict[str, Any], path: list[str]):
    node: Any = data
    for part in path:
        if not isinstance(node, dict) or part not in node:
            return False, None
        node = node[part]
    return True, node


def plain(value: Any) -> Any:
    """IntLit / FloatLit → 普通 int / float，给 JSON 结果用。"""
    if isinstance(value, bool) or value is None or isinstance(value, str):
        return value
    if isinstance(value, int):
        return int(value)
    if isinstance(value, float):
        return float(value)
    if isinstance(value, list):
        return [plain(v) for v in value]
    if isinstance(value, dict):
        return {k: plain(v) for k, v in value.items()}
    return value


def selected_wallpapers(user: dict[str, Any]) -> dict[str, Any]:
    ok, config = get_path(user, ["general", "wallpaperconfig"])
    if not ok or not isinstance(config, dict):
        return {}
    selected = config.get("selectedwallpapers") or {}
    result = {monitor: (item or {}).get("file") for monitor, item in selected.items() if isinstance(item, dict)}
    return {"profile": config.get("profile"), "monitors": result}


def has_desktop_wallpaper(path: str | None = None) -> bool:
    """config 里选了桌面壁纸（任一显示器有 file，或用了 profile）。读不了时当作选了。"""
    try:
        _, data = read_config(path)
        user = data[user_section(data)]
    except (OSError, ValueError, WpeError, KeyError):
        return True
    selected = selected_wallpapers(user)
    return bool(selected.get("profile")) or any(selected.get("monitors", {}).values())


def current_values(data: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    section = user_section(data)
    user = data[section]
    values = {}
    for key in KEYS:
        ok, value = get_path(user, key_path(key))
        values[key] = plain(value) if ok else "<缺失>"
    return section, values


# ==================== 写（序列化） ====================


def _quote(text: str) -> str:
    out = ['"']
    for ch in text:
        if ch == '"':
            out.append('\\"')
        elif ch == "\\":
            out.append("\\\\")
        elif ch == "\b":
            out.append("\\b")
        elif ch == "\f":
            out.append("\\f")
        elif ch == "\n":
            out.append("\\n")
        elif ch == "\r":
            out.append("\\r")
        elif ch == "\t":
            out.append("\\t")
        elif ord(ch) < 0x20:
            out.append("\\u%04x" % ord(ch))
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def _scalar(value: Any) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    raw = getattr(value, "raw", None)
    if raw is not None:
        return raw
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return repr(value)
    if isinstance(value, str):
        return _quote(value)
    raise TypeError(f"不能序列化 {type(value).__name__}")


def _sort_key(name: str) -> bytes:
    # jsoncpp 的对象成员按字节序
    return name.encode("utf-8")


class _Writer:
    """jsoncpp BuiltStyledStreamWriter 的逐行照搬（indentation "\\t"、无注释、无结尾换行）。"""

    def __init__(self):
        self.out: list[str] = []
        self.indent = ""
        self.indented = True
        self.child_values: list[str] = []
        self.add_child_values = False

    def push(self, text: str):
        if self.add_child_values:
            self.child_values.append(text)
        else:
            self.out.append(text)

    def write_indent(self):
        self.out.append("\n" + self.indent)

    def with_indent(self, text: str):
        if not self.indented:
            self.write_indent()
        self.out.append(text)
        self.indented = False

    def value(self, v: Any):
        if isinstance(v, dict):
            if not v:
                self.push("{}")
                return
            self.with_indent("{")
            self.indent += "\t"
            names = sorted(v.keys(), key=_sort_key)
            for i, name in enumerate(names):
                self.with_indent(_quote(name))
                self.out.append(" : ")
                self.value(v[name])
                if i + 1 < len(names):
                    self.out.append(",")
            self.indent = self.indent[:-1]
            self.with_indent("}")
        elif isinstance(v, list):
            self.array(v)
        else:
            self.push(_scalar(v))

    def multiline(self, v: list) -> bool:
        size = len(v)
        multi = size * 3 >= RIGHT_MARGIN
        self.child_values = []
        for child in v:
            if multi:
                break
            multi = isinstance(child, (dict, list)) and len(child) > 0
        if not multi:
            self.add_child_values = True
            length = 4 + (size - 1) * 2
            for child in v:
                self.value(child)
            for text in self.child_values:
                length += len(text.encode("utf-8"))
            self.add_child_values = False
            multi = length >= RIGHT_MARGIN
        return multi

    def array(self, v: list):
        if not v:
            self.push("[]")
            return
        if self.multiline(v):
            self.with_indent("[")
            self.indent += "\t"
            has_child = bool(self.child_values)
            children = self.child_values
            for i, child in enumerate(v):
                if has_child:
                    self.with_indent(children[i])
                else:
                    if not self.indented:
                        self.write_indent()
                    self.indented = True
                    self.value(child)
                    self.indented = False
                if i + 1 < len(v):
                    self.out.append(",")
            self.indent = self.indent[:-1]
            self.with_indent("]")
        else:
            self.out.append("[ " + ", ".join(self.child_values) + " ]")


def serialize(data: Any) -> bytes:
    w = _Writer()
    w.value(data)
    return "".join(w.out).replace("\n", NEWLINE).encode("utf-8")


def roundtrip_ok(raw: bytes) -> bool:
    return serialize(parse(raw.decode("utf-8"))) == raw


# ==================== 备份与写 ====================


def backups() -> list[str]:
    return sorted(glob.glob(os.path.join(paths.STATE_DIR, "config-backup-*.json")))


def latest_backup() -> str | None:
    found = backups()
    return found[-1] if found else None


def ensure_backup(raw: bytes) -> str | None:
    """第一次写之前留一份备份；已经有备份时不再留，返回 None。"""
    if backups():
        return None
    os.makedirs(paths.STATE_DIR, exist_ok=True)
    path = os.path.join(paths.STATE_DIR, "config-backup-" + time.strftime("%Y%m%d-%H%M%S") + ".json")
    with open(path, "wb") as f:
        f.write(raw)
    return path


def changed_since_backup(data: dict[str, Any]) -> dict[str, Any] | None:
    backup = latest_backup()
    if backup is None:
        return None
    try:
        _, old = read_config(backup)
        _, old_values = current_values(old)
    except (OSError, ValueError, WpeError) as e:
        return {"backup": backup, "error": str(e)}
    _, now_values = current_values(data)
    changed = [{"key": k, "backup": old_values[k], "now": now_values[k]}
               for k in KEYS if old_values[k] != now_values[k]]
    return {"backup": backup, "changed": changed}


def write_settings(changes: dict[str, Any], path: str | None = None) -> dict[str, Any]:
    """把已校验的改动写进当前用户段。只在 WPE 不在跑时调用（restart_wpe 负责）。"""
    path = path or paths.wpe_config()
    raw, data = read_config(path)
    if not roundtrip_ok(raw):
        raise WpeError("config.json 读入再按 WPE 格式写出和原文不一致，不敢写（会连带改到别的键）。没有改文件")
    section = user_section(data)
    user = data[section]
    diff = []
    for key, value in changes.items():
        parts = key_path(key)
        node = user
        for part in parts[:-1]:
            if not isinstance(node.get(part), dict):
                node[part] = {}
            node = node[part]
        existed, old = get_path(user, parts)
        node[parts[-1]] = value
        diff.append({"key": key, "old": plain(old) if existed else "<缺失>", "new": value})
    # 只给真正的 config.json 留备份（验收在副本上试写时不留）
    real = os.path.normcase(os.path.abspath(path)) == os.path.normcase(os.path.abspath(paths.wpe_config()))
    backup = ensure_backup(raw) if real else None
    new_raw = serialize(data)
    tmp = path + ".kb-tmp"
    with open(tmp, "wb") as f:
        f.write(new_raw)
    os.replace(tmp, path)
    return {"user": section, "changed": diff, "backup": backup,
            "sha256_before": hashlib.sha256(raw).hexdigest(), "sha256_after": hashlib.sha256(new_raw).hexdigest()}


def file_sha256(path: str | None = None) -> str:
    with open(path or paths.wpe_config(), "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()
