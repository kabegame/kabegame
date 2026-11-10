"""提取器共用的小件：列抓帧、取帧号、写 JSON。要兼容 Python 3.8。"""

import json
import os
import re

FRAME_RE = re.compile(r"frame(\d+)")


class DataError(Exception):
    """抓帧或工程数据不符合约定（对应旧脚本里的 SystemExit / ValueError）。main.py 报成 [data]。"""


def rdc_frame(name):
    """文件名里的 RenderDoc 帧号（`<标签>-frame<帧号>.rdc`）。"""
    match = FRAME_RE.search(name)
    if not match:
        raise DataError("抓帧文件名里没有 frame<帧号>：%s" % name)
    return int(match.group(1))


def rdc_names(folder):
    """目录里的 .rdc，按帧号排序（同旧脚本）。"""
    if not os.path.isdir(folder):
        raise DataError("抓帧目录不存在：%s" % folder)
    names = sorted((n for n in os.listdir(folder) if n.endswith(".rdc")), key=rdc_frame)
    if not names:
        raise DataError("目录里没有 .rdc：%s" % folder)
    return names


def save_json(path, obj, indent=None):
    """同 ignore/p4/track.py 的 save：LF、ensure_ascii=False；先写 .tmp 再替换。
    用 dumps 一次写出：文本和 json.dump 相同，但 dump 总走纯 Python 编码器，几 MB 的绳轨迹在内嵌 Python 里要十几秒。"""
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    tmp = path + ".tmp"
    text = json.dumps(obj, ensure_ascii=False, indent=indent)
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    os.replace(tmp, path)
