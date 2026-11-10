"""kbp-tools 本机 Python 部分的公共件：路径、错误分层、输出约定。

- 路径全部参数化：数据目录 `--data` → 环境变量 `KBP_DATA` → `ignore/p4`；WPE 读 `KABEGAME_WPE_ROOT`；RenderDoc 读 `RENDERDOC_DIR`。
- 错误一律抛 `KbpError(layer, message)`，`str()` 以 `[层]` 开头：`[data]`、`[wpe]`、`[renderdoc]`、`[src]`、`[node]`、`[env]`、`[kbp]`。
- stdout 只打一行 JSON 摘要（`emit`），细节写文件。
"""

import json
import os
import sys

SKILL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO_ROOT = os.path.normpath(os.path.join(SKILL_DIR, "..", "..", ".."))
DEFAULT_DATA = os.path.join(REPO_ROOT, "ignore", "p4")
DEFAULT_WPE = r"D:\Applications\Steam\steamapps\common\wallpaper_engine"
DEFAULT_RENDERDOC = r"C:\Program Files\RenderDoc"
# rdc/bridge.py 复用的服务层（renderdoc_worker 的 ReplayContext、RenderDocFacade、RequestHandler）
MCP_DIR = os.path.join(REPO_ROOT, ".claude", "mcps", "wpe-renderdoc")


class KbpError(Exception):
    """带层的错误：str() 为「[层] 说明」。"""

    def __init__(self, layer, message):
        super().__init__(message)
        self.layer = layer
        self.message = message

    def __str__(self):
        return "[%s] %s" % (self.layer, self.message)


def data_dir(arg=None):
    """数据目录：参数 → KBP_DATA → 仓库的 ignore/p4。相对路径按当前目录解析。"""
    return os.path.abspath(arg or os.environ.get("KBP_DATA") or DEFAULT_DATA)


def wpe_dir():
    return os.environ.get("KABEGAME_WPE_ROOT") or DEFAULT_WPE


def renderdoc_dir():
    return os.environ.get("RENDERDOC_DIR") or DEFAULT_RENDERDOC


def emit(summary):
    """stdout 的一行 JSON 摘要。"""
    sys.stdout.write(json.dumps(summary, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def write_json(path, obj, indent=None):
    """LF 换行、不转义中文；先写 .tmp 再替换。"""
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        json.dump(obj, f, ensure_ascii=False, indent=indent)
    os.replace(tmp, path)


def read_json(path, layer="data"):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        raise KbpError(layer, "找不到文件 %s" % path)
    except ValueError as e:
        raise KbpError(layer, "%s 不是 JSON：%s" % (path, e))
