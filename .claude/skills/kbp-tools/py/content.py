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
- grep(正则, 工程…)：在工程文件里搜文本；
- unpack(工程, out, instrument, data, overwrite)：把真实场景解包成测试工程（散文件 + 包内条目），可选在末尾加只写日志的
  FR 图层（第 5 批，kbp content unpack；原型 ignore/p5/inst/unpack_proto.py）。
"""

import datetime
import fnmatch
import json
import hashlib
import os
import re
import shutil
import struct
import sys
import tempfile

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


# ==================== 解包（kbp content unpack，第 5 批） ====================
#
# 真实工坊场景没有 FR 图层，回放只能手写 dt。这里把场景复制、解包成测试工程，可选在 scene.json 的 objects 末尾加一个
# 只写 [kbp] 日志的 FR（画面外、1×1、视差深度 0，不改一个像素；加在末尾不让按下标 getLayer 的脚本错位）。
# 拿副本去 WPE 抓帧，日志照常截出来，回放写 timeline: { log, frame, cursors: "log" }。源工程只读。
# 不加 CLK、不写 kbp-meta.json：不满足「前两个对象是 FR、CLK」的约定，kbp rdc track 不管这种工程。

UNPACK_MARKER = "kbp-unpack.json"  # 本命令的标记：--overwrite 只删带它的目录（同 snapshot 的 snapshot.json）
FR_NAME = "kbp-FR"
FR_MODEL = "models/kbp/fr.json"
FR_MATERIAL = "materials/util/solidlayer.json"  # WPE 自带的 assets/ 材质


def _real(path):
    """解析链接（含 junction）后的绝对路径，normcase 过，只用来比较包含关系。"""
    return os.path.normcase(os.path.realpath(os.path.abspath(path)))


def _within(child, parent):
    """child 等于 parent 或在它里面；两者都要先过 _real。"""
    parent = parent.rstrip("\\/")
    return child == parent or child.startswith(parent + os.sep)


def _check_unpack_out(src, out, overwrite):
    """输出目录的安全检查：解析后必须在仓库 ignore/ 之下；和 WPE 安装目录、Steam 工坊目录、源工程互不包含；
    已存在时缺省拒绝，--overwrite 只认带标记文件的普通目录（链接、junction 一律不删）。"""
    ignore_root = _real(os.path.join(common.REPO_ROOT, "ignore"))
    target = _real(out)
    if not target.startswith(ignore_root + os.sep):
        raise KbpError("kbp", "输出目录必须在仓库 ignore/ 之下（按解析链接后的路径判断）：%s" % out)
    for label, path in (("WPE 安装目录", wpe_dir()), ("Steam 工坊目录", workshop_dir()), ("源工程", src)):
        guarded = _real(path)
        if _within(target, guarded):
            raise KbpError("kbp", "输出目录落在%s里（%s），不写：%s" % (label, path, out))
        if _within(guarded, target):
            raise KbpError("kbp", "输出目录包含了%s（%s），不写：%s" % (label, path, out))
    if not os.path.lexists(out):
        return
    if not os.path.isdir(out):
        raise KbpError("data", "输出已存在且不是目录：%s" % out)
    if not overwrite:
        raise KbpError("data", "输出目录已存在（要覆盖加 --overwrite，只删带 %s 的目录）：%s" % (UNPACK_MARKER, out))
    linked = os.path.islink(out) or target != os.path.join(_real(os.path.dirname(os.path.abspath(out))),
                                                           os.path.normcase(os.path.basename(os.path.abspath(out))))
    if linked:
        raise KbpError("data", "输出目录是链接或 junction，不删：%s" % out)
    if not os.path.isfile(os.path.join(out, UNPACK_MARKER)):
        raise KbpError("data", "%s 不是 kbp content unpack 写的目录（没有 %s），不删" % (out, UNPACK_MARKER))


def _entry_dest(root, rel):
    """相对路径 rel（已过 normalize）落在 root 下的绝对路径，和判断落盘撞名的键（normcase 后的相对路径：Windows 上不分大小写、
    末段结尾的点与空格会被去掉，所以用 abspath 的结果算）。只由点和空格组成的段、解出去会越出 root 的，报 [data]。"""
    parts = rel.split("/")
    if any(not part.rstrip(" .") for part in parts):
        raise KbpError("data", "路径里有只由点和空格组成的段，不解：%r" % rel)
    base = os.path.abspath(root)
    dest = os.path.abspath(os.path.join(base, *parts))
    if not os.path.normcase(dest).startswith(os.path.normcase(base) + os.sep):
        raise KbpError("data", "解出来会落到输出目录之外，不解：%r" % rel)
    return dest, os.path.normcase(os.path.relpath(dest, base))


def _strict_json(data, what):
    """严格 JSON（utf-8-sig）；带注释、尾逗号的报 [data]，不猜。"""
    try:
        return json.loads(data.decode("utf-8-sig"))
    except UnicodeDecodeError as e:
        raise KbpError("data", "%s 不是 UTF-8：%s" % (what, e))
    except ValueError as e:
        raise KbpError("data", "%s 不是严格 JSON（多半带注释或尾逗号；不猜，先手工改成严格 JSON）：%s" % (what, e))


def _max_id(node):
    """scene.json 里全部整数 id 的最大值，没有为 0。对象、effect、pass、instanceoverride、animationlayers 用的是编辑器的
    同一个计数器（语料 163 个场景里 77 个的最大 id 不在对象上），只看对象的话 FR 会和 effect / pass 撞号。"""
    best = 0
    stack = [node]
    while stack:
        item = stack.pop()
        if isinstance(item, dict):
            value = item.get("id")
            if isinstance(value, int) and not isinstance(value, bool):
                best = max(best, value)
            stack.extend(item.values())
        elif isinstance(item, list):
            stack.extend(item)
    return best


def _add_fr(scene, entry):
    """在 objects 末尾追加 FR（FR_CURSOR：[kbp] 五列，帧号、帧时间、累计时间、屏幕光标）；返回它的 id。"""
    from . import gen

    if not isinstance(scene, dict) or not isinstance(scene.get("objects", []), list):
        raise KbpError("data", "%s 的顶层不是 {objects: [...]}" % entry)
    objects = scene.setdefault("objects", [])
    if any(isinstance(o, dict) and o.get("name") == FR_NAME for o in objects):
        raise KbpError("data", "%s 里已经有 %s：源工程加过日志了（多半是解包过的副本），不重复加" % (entry, FR_NAME))
    fr_id = _max_id(scene) + 1
    fr = gen.layer(fr_id, FR_NAME, "-100000 -100000 0", "1 1", image=FR_MODEL)
    fr["color"] = {"script": gen.FR_CURSOR, "value": "0 0 1"}
    objects.append(fr)
    return fr_id


def _unpack_next(out, data, instrument):
    if not instrument:
        return ("没加 FR，抓帧不会有 [kbp] 日志，回放只能手写 dts；要按 WPE 实际的帧时间与光标回放，加 --instrument --overwrite "
                "重新解包（见 kbp-tools SKILL.md「真实场景的回放」）。")
    name = os.path.basename(out)
    logs = os.path.join(common.data_dir(data), "out")
    return ("抓帧：wpe-renderdoc 的 capture_sweep(jobs=[{project: \"%s\", size: \"1920x1080\", tag: …}], "
            "out_root: \"A:\\<项目>\", log_dir: \"%s\")，标签 %s-fps<N>-1920x1080，N 写 WPE 当前设置的帧率（get_settings 看；"
            "不必改设置，改了 capture_sweep 会重启 WPE）；回放：kabegame-dev 的 projects_import 导入这个目录，"
            "render_scene 传 replay: { timeline: { log: \"%s\", frame: <RenderDoc 帧号 + 1>, cursors: \"log\" } }，"
            "WPE 的图用 kbp rdc frame --present（见 kbp-tools SKILL.md「真实场景的回放」）。"
            % (out, logs, name, os.path.join(logs, name + "-fps<N>-1920x1080-log.txt")))


def unpack(project, out=None, instrument=False, data=None, overwrite=False):
    """把工程（工坊 ID、目录、project.json …，同 resolve）解包成测试工程，返回摘要 dict。

    - 输出缺省 <data>/proj/<工程目录名>-kbp；安全检查见 _check_unpack_out；先在旁边的临时目录写全，成功才换上，失败不留半成品。
    - 散文件照拷（不拷 scene.pkg 与源里的 kbp-unpack.json）；scene.pkg 的条目解成散文件：条目名过 normalize，散文件已有的不覆盖
      （同 Kabegame 编译管线「散文件 → 包」的优先级），包内同名取第一个（同 Pkg.by_name）。
    - project.json 标题加「 (kbp)」，其余原样（按生成库的 write_json 重新写出）。
    - instrument：入口文件（project.json 的 file，缺省 scene.json）末尾追加 FR，见 _add_fr；入口不是严格 JSON 报 [data]。
    - 写 kbp-unpack.json（标记与来源、计数），不写 kbp-meta.json。"""
    from . import gen

    src = project_dir(project)
    name = os.path.basename(src.rstrip("\\/"))
    out = os.path.abspath(out) if out else os.path.join(common.data_dir(data), "proj", name + "-kbp")
    _check_unpack_out(src, out, overwrite)

    # 先读、先校验，全部通过才动手写
    info = _strict_json(read(src, "project.json", ("project", "pkg"))[0], "project.json")
    if not isinstance(info, dict):
        raise KbpError("data", "project.json 的顶层不是对象：%s" % src)
    entry = info.get("file") or "scene.json"
    if not isinstance(entry, str):
        raise KbpError("data", "project.json 的 file 不是字符串：%r" % (entry,))
    entry = normalize(entry)
    title = info.get("title")
    info["title"] = (title if isinstance(title, str) and title else name) + " (kbp)"
    scene = fr_id = None
    if instrument:
        scene = _strict_json(read(src, entry, ("project", "pkg"))[0], entry)
        fr_id = _add_fr(scene, entry)
    loose = [f for f in files(src, ("project",)) if f["path"] not in ("scene.pkg", UNPACK_MARKER)]
    pkg = _pkg_of(src)
    workshop = name if re.fullmatch(r"[0-9]+", name) else None

    parent = os.path.dirname(out)
    os.makedirs(parent, exist_ok=True)
    tmp = tempfile.mkdtemp(prefix=".%s.kbp-unpack-" % os.path.basename(out), dir=parent)
    try:
        have = set()
        for item in loose:
            dest, key = _entry_dest(tmp, item["path"])
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            shutil.copyfile(os.path.join(src, *item["path"].split("/")), dest)
            have.add(key)
        extracted = skipped = 0
        if pkg is not None:
            for raw, _, _ in pkg.entries:
                dest, key = _entry_dest(tmp, normalize(raw))
                if key in have:  # 散文件已有，或包内前面已有同名条目
                    skipped += 1
                    continue
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                with open(dest, "wb") as f:
                    f.write(pkg.read(raw))
                have.add(key)
                extracted += 1
        gen.write_json(os.path.join(tmp, "project.json"), info)
        if instrument:
            gen.write_json(os.path.join(tmp, *entry.split("/")), scene)
            gen.write_json(os.path.join(tmp, *FR_MODEL.split("/")), {"material": FR_MATERIAL})
        total = sum(os.path.getsize(os.path.join(d, f)) for d, _, fs in os.walk(tmp) for f in fs)
        common.write_json(os.path.join(tmp, UNPACK_MARKER), {
            "tool": "kbp content unpack", "source": src, "workshop": workshop, "title": info["title"], "entry": entry,
            "loose": len(loose), "extracted": extracted, "skipped": skipped, "pkg": pkg.version if pkg else None,
            "instrument": bool(instrument), "fr_id": fr_id, "fr_name": FR_NAME if instrument else None, "bytes": total,
            "time": datetime.datetime.now().astimezone().isoformat(timespec="seconds")}, indent=1)
        if os.path.lexists(out):
            _check_unpack_out(src, out, overwrite)  # 写的这段时间里可能被动过，删之前再核一遍
            shutil.rmtree(out)
        os.rename(tmp, out)
    except OSError as e:
        shutil.rmtree(tmp, ignore_errors=True)
        raise KbpError("data", "写 %s 失败：%s" % (out, e))
    except BaseException:
        shutil.rmtree(tmp, ignore_errors=True)
        raise
    return {"ok": True, "action": "unpack", "src": src, "out": out, "workshop": workshop, "entry": entry,
            "loose": len(loose), "extracted": extracted, "skipped": skipped, "fr_id": fr_id, "bytes": total,
            "next": _unpack_next(out, data, instrument)}


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
    if action == "unpack":
        return unpack(args.project, args.out, args.instrument, args.data, args.overwrite)
    raise KbpError("kbp", "未知的动作 content %s" % action)
