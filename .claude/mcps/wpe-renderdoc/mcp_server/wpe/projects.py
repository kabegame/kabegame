"""解析工程。照 .claude/skills/wpe-renderdoc/driver.py 的 resolve_project 拷来（旧的不动）。"""

from __future__ import annotations

import os

from .. import paths
from .common import WpeError


def resolve_project(name: str) -> str:
    """接受工程目录、project.json、工坊 ID、默认工程名或 myprojects 里的名字；返回 project.json 的绝对路径。"""
    wpe = paths.wpe_dir()
    for item in (name, os.path.join(wpe, "projects", "defaultprojects", name),
                 os.path.join(wpe, "projects", "myprojects", name), os.path.join(paths.workshop_dir(), name)):
        path = os.path.join(item, "project.json") if os.path.isdir(item) else item
        if os.path.isfile(path):
            return os.path.abspath(path)
    raise WpeError(f"找不到工程 {name}（试过：目录或 project.json、defaultprojects、myprojects、工坊 ID）")
