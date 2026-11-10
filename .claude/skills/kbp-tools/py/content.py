"""语料与 scene.pkg 读取：ignore/hdr-macro/scan_misc_lib.py 加 ignore/p4/c2/pkg_extract.py 收成库。

WPE 目录经 KABEGAME_WPE_ROOT（缺省 D:\\Applications\\Steam\\steamapps\\common\\wallpaper_engine）；创意工坊目录是
<WPE>\\..\\..\\workshop\\content\\431960（同 wpe-renderdoc MCP）。

库（新脚本 `from kbp import content`）：
- projects(source, type, pkg)：枚举工程目录；
- resolve(名字)：同 wpe-renderdoc 的工程解析（目录、project.json、工坊 ID、默认工程名、myprojects 里的名字）→ project.json；
- read_pkg(路径)：scene.pkg 的目录表（同名条目先出现的算，同 Kabegame 的 ScenePkg）；
- files(工程)：散文件加 scene.pkg 条目；
- locate / read(工程, 相对路径)：散文件 → scene.pkg → WPE assets/（同 Kabegame 编译管线 SceneFs 的查找顺序）；
- scene_files(工程)：scan_misc_lib.scene_files 的原样版本（迁移旧脚本用）；
- grep(正则, 工程…)：在工程文件里搜文本。
"""

import fnmatch
import json
import hashlib
import os
import re
import struct
import sys

from . import common
from .common import KbpError

SOURCES = ("default", "workshop", "my")
FROM = ("project", "pkg", "assets")


def wpe_dir():
    return common.wpe_dir()


def defaults_dir():
    return os.path.join(wpe_dir(), "projects", "defaultprojects")


def my_dir():
    return os.path.join(wpe_dir(), "projects", "myprojects")


def workshop_dir():
    return os.path.normpath(os.path.join(wpe_dir(), "..", "..", "workshop", "content", "431960"))


def assets_dir():
    return os.path.join(wpe_dir(), "assets")


def source_dir(source):
    if source == "default":
        return defaults_dir()
    if source == "workshop":
        return workshop_dir()
    if source == "my":
        return my_dir()
    raise KbpError("kbp", "未知的工程来源 %s（可选 %s）" % (source, "、".join(SOURCES)))


def project_type(project):
    """project.json 的 type（小写）；没有或读不了为 None。"""
    try:
        with open(os.path.join(project, "project.json"), encoding="utf-8-sig") as f:
            value = json.load(f).get("type")
    except (OSError, ValueError, AttributeError):
        return None
    return value.lower() if isinstance(value, str) else None


def projects(source=("default", "workshop"), type=None, pkg=None):  # noqa: A002 —— 同计划的签名
    """工程目录的绝对路径，按来源顺序、每个来源内按 os.listdir 的顺序（不另排序，同 scan_misc_lib）。

    source：'default' / 'workshop' / 'my'，或它们的序列；type：只要 project.json 的 type 等于它的（不分大小写）；
    pkg：True 只要有 scene.pkg 的，False 只要没有的，None 不筛。
    scan_misc_lib.projects() = projects('default') + projects('workshop', pkg=True)。"""
    if isinstance(source, str):
        source = [s for s in source.split(",") if s]
    out = []
    for s in source:
        base = source_dir(s)
        if not os.path.isdir(base):
            raise KbpError("wpe", "工程目录不存在：%s" % base)
        for name in os.listdir(base):
            path = os.path.join(base, name)
            if not os.path.isdir(path):
                continue
            if pkg is not None and os.path.exists(os.path.join(path, "scene.pkg")) != pkg:
                continue
            if type is not None and project_type(path) != type.lower():
                continue
            out.append(path)
    return out


def resolve(name):
    """接受工程目录、project.json、工坊 ID、默认工程名或 myprojects 里的名字；返回 project.json 的绝对路径。
    同 .claude/skills/wpe-renderdoc/driver.py 与 wpe-renderdoc MCP 的 resolve_project。"""
    for item in (name, os.path.join(defaults_dir(), name), os.path.join(my_dir(), name),
                 os.path.join(workshop_dir(), name)):
        path = os.path.join(item, "project.json") if os.path.isdir(item) else item
        if os.path.isfile(path):
            return os.path.abspath(path)
    raise KbpError("data", "找不到工程 %s（试过：目录或 project.json、defaultprojects、myprojects、工坊 ID）" % name)


def project_dir(name):
    """工程目录：已是目录就直接用（不要求有 project.json，ignore/ 里的测试工程也行），否则按 resolve。"""
    if os.path.isdir(name):
        return os.path.abspath(name)
    return os.path.dirname(resolve(name))


# ==================== scene.pkg ====================


class Pkg(object):
    """scene.pkg 的目录表：version（头部串，如 PKGV0024）、entries（[(名字, 偏移, 长度)]，按包内顺序）、
    base（数据区起点）、by_name（同名条目先出现的算）。偏移相对 base。"""

    def __init__(self, path, version, entries, base):
        self.path = path
        self.version = version
        self.entries = entries
        self.base = base
        self.by_name = {}
        for name, offset, length in entries:
            self.by_name.setdefault(name, (offset, length))

    def read(self, name):
        offset, length = self.by_name[name]
        with open(self.path, "rb") as f:
            f.seek(self.base + offset)
            data = f.read(length)
        if len(data) != length:
            raise KbpError("data", "scene.pkg 条目被截断：%s（要 %d 字节，读到 %d）" % (name, length, len(data)))
        return data


def read_pkg(path):
    """读 scene.pkg 的目录表（格式同 apps/wpe-scene/src/compile/pkg.ts）。"""
    try:
        with open(path, "rb") as f:
            def u32():
                raw = f.read(4)
                if len(raw) != 4:
                    raise KbpError("data", "scene.pkg 目录表被截断：%s" % path)
                return struct.unpack("<I", raw)[0]

            def sized():
                n = u32()
                raw = f.read(n)
                if len(raw) != n:
                    raise KbpError("data", "scene.pkg 目录表被截断：%s" % path)
                return raw.decode("utf-8", "replace")

            version = sized()
            if not version.startswith("PKGV"):
                raise KbpError("data", "不是 scene.pkg（头部 %r）：%s" % (version[:16], path))
            count = u32()
            entries = []
            for _ in range(count):
                name = sized()
                offset, length = u32(), u32()
                entries.append((name, offset, length))
            base = f.tell()
    except FileNotFoundError:
        raise KbpError("data", "找不到 %s" % path)
    return Pkg(path, version, entries, base)


def _pkg_of(project):
    path = os.path.join(project, "scene.pkg")
    return read_pkg(path) if os.path.isfile(path) else None


def normalize(rel):
    """同 SceneFs 的 normalizeScenePath：禁止绝对路径与越界，反斜杠改正斜杠，去掉开头的 ./ 与 /。"""
    if re.match(r"^(?:[a-zA-Z]:|\\\\|//)", rel):
        raise KbpError("data", "禁止绝对路径：%s" % rel)
    out = re.sub(r"^(?:\./|/)+", "", rel.replace("\\", "/"))
    if not out or any(part in ("..", "") for part in out.split("/")):
        raise KbpError("data", "禁止越界路径：%s" % rel)
    return out


def files(project, sources=("project", "pkg")):
    """[{path, source, size}]：散文件（全部，相对工程目录、正斜杠）在前，scene.pkg 条目（包内顺序，同名只取第一个）在后。"""
    project = project_dir(project)
    out = []
    if "project" in sources:
        for d, _, fs in os.walk(project):
            for f in fs:
                p = os.path.join(d, f)
                out.append({"path": os.path.relpath(p, project).replace(os.sep, "/"), "source": "project",
                            "size": os.path.getsize(p)})
    if "pkg" in sources:
        pkg = _pkg_of(project)
        if pkg is not None:
            seen = set()
            for name, _, length in pkg.entries:
                if name in seen:
                    continue
                seen.add(name)
                out.append({"path": name, "source": "pkg", "size": length})
    return out


def locate(project, rel, sources=FROM):
    """找文件：散文件 → scene.pkg → WPE assets/。返回 {source, path, offset, size}（pkg 条目的 path 是 scene.pkg），
    找不到为 None。"""
    project = project_dir(project)
    rel = normalize(rel)
    if "project" in sources:
        path = os.path.join(project, rel.replace("/", os.sep))
        if os.path.isfile(path):
            return {"source": "project", "path": path, "offset": 0, "size": os.path.getsize(path)}
    if "pkg" in sources:
        pkg = _pkg_of(project)
        if pkg is not None and rel in pkg.by_name:
            offset, length = pkg.by_name[rel]
            return {"source": "pkg", "path": pkg.path, "offset": pkg.base + offset, "size": length, "entry": rel}
    if "assets" in sources:
        path = os.path.join(assets_dir(), rel.replace("/", os.sep))
        if os.path.isfile(path):
            return {"source": "assets", "path": path, "offset": 0, "size": os.path.getsize(path)}
    return None


def read(project, rel, sources=FROM):
    """(字节, 位置)；位置同 locate。找不到抛 [data]。"""
    where = locate(project, rel, sources)
    if where is None:
        raise KbpError("data", "工程 %s 里找不到 %s（查了 %s）" % (project, rel, "、".join(sources)))
    with open(where["path"], "rb") as f:
        f.seek(where["offset"])
        data = f.read(where["size"])
    if len(data) != where["size"]:
        raise KbpError("data", "%s 被截断（要 %d 字节，读到 %d）" % (rel, where["size"], len(data)))
    return data, where


def scene_files(project):
    """scan_misc_lib.scene_files 的原样版本：{相对路径: 读取函数}。pkg 条目在前，散文件里 .json / .frag / .vert / .h / .tex
    覆盖同名条目。"""
    out = {}
    pkg_path = os.path.join(project, "scene.pkg")
    if os.path.exists(pkg_path):
        pkg = read_pkg(pkg_path)
        for name in pkg.by_name:
            out[name] = (lambda n=name: pkg.read(n))
    for d, _, fs in os.walk(project):
        for f in fs:
            p = os.path.join(d, f)
            rel = os.path.relpath(p, project).replace(os.sep, "/")

            def reader(path=p):
                with open(path, "rb") as fh:
                    return fh.read()
            if rel.endswith((".json", ".frag", ".vert", ".h", ".tex")):
                out[rel] = reader
    return out


def grep(pattern, targets, glob=None, sources=("project", "pkg"), ignore_case=False, limit=200):
    """在工程文件里搜正则。targets：工程（名字或目录）列表；glob：只看相对路径匹配的（fnmatch，可多个）；
    跳过开头 8 KiB 里有 NUL 的二进制文件。返回 (匹配列表, 是否截断, 看过的文件数)。"""
    regex = re.compile(pattern, re.IGNORECASE if ignore_case else 0)
    globs = [g for g in (glob or []) if g]
    matches, scanned = [], 0
    for target in targets:
        project = project_dir(target)
        pkg = _pkg_of(project) if "pkg" in sources else None
        for item in files(project, sources):
            if globs and not any(fnmatch.fnmatch(item["path"], g) for g in globs):
                continue
            if item["source"] == "pkg":
                data = pkg.read(item["path"])
            else:
                with open(os.path.join(project, item["path"].replace("/", os.sep)), "rb") as f:
                    data = f.read()
            if b"\0" in data[:8192]:
                continue
            scanned += 1
            for number, line in enumerate(data.decode("utf-8", "replace").splitlines(), 1):
                if regex.search(line):
                    if len(matches) >= limit:
                        return matches, True, scanned
                    matches.append({"project": project, "path": item["path"], "source": item["source"],
                                    "line": number, "text": line.strip()[:300]})
    return matches, False, scanned


# ==================== 命令行（kbp content …） ====================


def _write_or_summary(args, summary, key, rows):
    if args.out:
        common.write_json(os.path.abspath(args.out), rows, indent=1)
        summary["out"] = os.path.abspath(args.out)
    else:
        summary[key] = rows
    return summary


def cli(args):
    action = args.action
    if action == "projects":
        pkg = True if args.pkg else (False if args.no_pkg else None)
        rows = projects(args.source, args.type, pkg)
        summary = {"ok": True, "action": "projects", "source": args.source, "type": args.type, "pkg": pkg,
                   "count": len(rows)}
        return _write_or_summary(args, summary, "projects", rows)
    if action == "resolve":
        path = resolve(args.name)
        folder = os.path.dirname(path)
        source = None
        for s in SOURCES:
            if os.path.normcase(os.path.dirname(folder)) == os.path.normcase(os.path.abspath(source_dir(s))):
                source = s
        try:
            with open(path, encoding="utf-8-sig") as f:
                info = json.load(f)
        except (OSError, ValueError):
            info = {}
        return {"ok": True, "action": "resolve", "project_json": path, "dir": folder, "id": os.path.basename(folder),
                "source": source, "type": info.get("type"), "title": info.get("title"), "file": info.get("file"),
                "pkg": os.path.isfile(os.path.join(folder, "scene.pkg"))}
    if action == "ls":
        sources = args.sources.split(",")
        rows = [r for r in files(args.project, sources) if r["path"].startswith(args.prefix or "")]
        summary = {"ok": True, "action": "ls", "project": project_dir(args.project), "count": len(rows)}
        return _write_or_summary(args, summary, "files", rows)
    if action == "cat":
        sources = args.sources.split(",")
        data, where = read(args.project, args.entry, sources)
        if not args.out:
            sys.stdout.flush()
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
            return None
        out = os.path.abspath(args.out)
        if os.path.exists(out) and not args.overwrite:
            raise KbpError("data", "输出已存在（不覆盖，要覆盖加 --overwrite）：%s" % out)
        directory = os.path.dirname(out)
        if directory:
            os.makedirs(directory, exist_ok=True)
        with open(out, "wb") as f:
            f.write(data)
        return {"ok": True, "action": "cat", "entry": normalize(args.entry), "source": where["source"],
                "from": where["path"], "offset": where["offset"], "size": len(data),
                "sha256": hashlib.sha256(data).hexdigest(), "out": out}
    if action == "grep":
        if args.projects:
            targets = args.projects
        else:
            pkg = True if args.pkg else None
            targets = projects(args.source, args.type, pkg)
        rows, truncated, scanned = grep(args.pattern, targets, args.glob, args.sources.split(","), args.ignore_case,
                                        args.max)
        summary = {"ok": True, "action": "grep", "pattern": args.pattern, "projects": len(targets), "files": scanned,
                   "count": len(rows), "truncated": truncated}
        return _write_or_summary(args, summary, "matches", rows)
    raise KbpError("kbp", "未知的动作 content %s" % action)
