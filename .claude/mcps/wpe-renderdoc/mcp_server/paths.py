"""仓库根、状态目录、qrenderdoc 位置。"""

import os

# .claude/mcps/wpe-renderdoc
PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO_ROOT = os.path.normpath(os.path.join(PROJECT_DIR, "..", "..", ".."))

# 状态目录与旧 skill（.kabegame/debug 下别的目录）、旧 MCP（%TEMP%\renderdoc_mcp）都分开
STATE_DIR = os.path.join(REPO_ROOT, ".kabegame", "debug", "wpe-renderdoc-mcp")
# 每个 MCP 进程一个私有 IPC 目录：ipc/<MCP 进程号>/
IPC_ROOT = os.path.join(STATE_DIR, "ipc")

# 在 qrenderdoc --python 里跑的常驻回放脚本
WORKER_SCRIPT = os.path.join(PROJECT_DIR, "renderdoc_worker", "worker.py")


def renderdoc_dir() -> str:
    """RenderDoc 安装目录：环境变量 RENDERDOC_DIR，缺省同旧 skill。"""
    return os.environ.get("RENDERDOC_DIR") or r"C:\Program Files\RenderDoc"


def qrenderdoc() -> str:
    return os.path.join(renderdoc_dir(), "qrenderdoc.exe")


def renderdoccmd() -> str:
    return os.path.join(renderdoc_dir(), "renderdoccmd.exe")


# ==================== WPE ====================

# 测试窗口表：windows/<窗口名>.json，表锁 windows.lock；WPE 进程操作（启动、注入、重启）另有一把锁 wpe.lock
WINDOWS_DIR = os.path.join(STATE_DIR, "windows")
WINDOWS_LOCK = os.path.join(STATE_DIR, "windows.lock")
WPE_LOCK = os.path.join(STATE_DIR, "wpe.lock")
# 抓帧锁：同一时刻只有一个 MCP 连 RenderDoc 的目标；持有者写在旁边的 target.holder.json
TARGET_LOCK = os.path.join(STATE_DIR, "target.lock")
TARGET_HOLDER = os.path.join(STATE_DIR, "target.holder.json")

# 旧 skill（.claude/skills/wpe-renderdoc/driver.py）的会话文件：在就说明旧会话正用着它自己注入启动的 WPE
OLD_SKILL_STATE = os.path.join(REPO_ROOT, ".kabegame", "debug", "wpe-renderdoc", "state.json")

# cleanup_project 只动这个目录下的测试工程
IGNORE_DIR = os.path.join(REPO_ROOT, "ignore")


def wpe_dir() -> str:
    """WPE 安装目录：环境变量 KABEGAME_WPE_ROOT，缺省同旧 skill。"""
    return os.environ.get("KABEGAME_WPE_ROOT") or r"D:\Applications\Steam\steamapps\common\wallpaper_engine"


def wpe_exe() -> str:
    return os.path.join(wpe_dir(), "wallpaper64.exe")


def wpe_config() -> str:
    return os.path.join(wpe_dir(), "config.json")


def wpe_log() -> str:
    return os.path.join(wpe_dir(), "log.txt")


def workshop_dir() -> str:
    return os.path.normpath(os.path.join(wpe_dir(), "..", "..", "workshop", "content", "431960"))


def capture_template() -> str:
    """注入时给 renderdoccmd 的抓帧路径模板（-c）。和 A:\\<项目>\\ 同盘，第 3 批移动抓帧不用复制。"""
    return os.environ.get("WPE_RD_TEMPLATE") or r"A:\_rdtemp\wallpaper64"
