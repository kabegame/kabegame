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
