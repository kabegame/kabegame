"""复制工程（`kbp content isolate`，最终走查的工具 1，`.claude/plans/wpe-import/3-scene/FINAL_CHECK.md` 原则第 5 条）。

真实壁纸是多个阶段的特性叠在一起，各阶段的会话走查时要把别的阶段的特性排除掉：给要留的对象，自动带上它们的整条父链与引用到的
依赖、合成 RT、按名字找的对象，删掉其余对象，可选把指定字段换成固定值。产物和 `content unpack` 是同一套（散文件 + 包内条目解成散文件，
可选加只写日志的 FR），WPE（wpe-renderdoc 的 capture_sweep）与 Kabegame（kabegame-dev 的 projects_import）两边用同一个目录。

库：`isolate(工程, keep, drop=(), fixes=(), name=None, out=None, instrument=False, data=None, overwrite=False)` → 摘要 dict。
纯函数（自测与别的脚本可直接用）：`plan(scene, keep, drop, fixes, resolver)`、`js_scan(源码)`、`parse_fix(文本)`、`apply_pointer(…)`。

保留闭包（每个保留的对象记原因，新加入的对象再展开，直到不动点）：
1. `requested`：`--keep` 给的 id（整数）或名字（唯一）；
2. `parent`：整条父链（`parent` 是 id）；
3. `dependency`：`dependencies` 里的 id（数组或对象的值；元素是数字，或带整数 `id` 的对象：粒子的发射图 / 碰撞模型）；
4. `rt-ref`：对象 JSON 以及从它的字符串能走到的工程内 `.json`（散文件、scene.pkg；不进 WPE assets）里的
   `_rt_imageLayerComposite_<id>_…`；
5. `script-name`：对象里每个 `script` 键的源码中的字符串字面量（以及同一层 `scriptproperties` 里的字符串值：脚本经
   `scriptProperties.x` 拿到的名字，见下）恰好等于某个其它对象的 `name`；
6. `light`、`camera`：灯（`light` 不为 null）与相机对象（`camera` 是字符串，同 features.ts 的 isCameraObject）缺省保留；
7. `kbp-FR`：`--instrument` 加的 FR（或源里已有的 kbp-FR）。
`--drop` 显式去掉的对象不进闭包、也不从它展开，闭包要它时记一条警告。
"""

import datetime
import json
import os
import re

from . import common, content
from .common import KbpError

ISOLATE_MARKER = "kbp-isolate.json"
RT_COMPOSITE = re.compile(r"_rt_imageLayerComposite_(\d+)_")
FULL_FRAME = "_rt_FullFrameBuffer"
# 按下标用图层的 IScene 接口（scriptApi.ts 的 IScene 方法表）：删对象会改下标或枚举结果
INDEX_APIS = ("getLayerIndex", "enumerateLayers", "getLayerCount", "sortLayer", "createLayer", "destroyLayer")


# ==================== JS 源码：字符串字面量与去掉字面量后的代码 ====================


def _read_escape(src, i):
    """src[i] 是反斜杠：返回 (下标, 解出的字符)。"""
    if i + 1 >= len(src):
        return i + 1, ""
    c = src[i + 1]
    simple = {"n": "\n", "t": "\t", "r": "\r", "b": "\b", "f": "\f", "v": "\v", "0": "\0"}
    if c in simple:
        return i + 2, simple[c]
    if c == "x" and re.match(r"[0-9a-fA-F]{2}", src[i + 2:i + 4]):
        return i + 4, chr(int(src[i + 2:i + 4], 16))
    if c == "u":
        m = re.match(r"\{([0-9a-fA-F]+)\}|([0-9a-fA-F]{4})", src[i + 2:])
        if m:
            return i + 2 + len(m.group(0)), chr(int(m.group(1) or m.group(2), 16))
    if c == "\r" and src[i + 2:i + 3] == "\n":
        return i + 3, ""
    if c in "\n\r\u2028\u2029":  # 续行
        return i + 2, ""
    return i + 2, c


def js_scan(src):
    """扫一段 JS 源码，返回 (去掉注释、字面量换成 'S' 的代码, 字符串字面量列表)。

    认单引号、双引号字符串（解转义）、模板字符串（没有 ${} 的整段算一个字面量；${} 里的代码照常扫，里面的字面量也收）、
    行注释与块注释。不认正则字面量（/'/ 这种会让后面错位；场景脚本里少见，只影响警告与 script-name 的精度）。"""
    code, literals = [], []
    n = len(src)

    def quoted(i, quote):
        buf = []
        i += 1
        while i < n:
            c = src[i]
            if c == "\\":
                i, ch = _read_escape(src, i)
                buf.append(ch)
            elif c == quote:
                return i + 1, "".join(buf)
            elif c == "\n":  # 没闭合：到行尾为止
                return i, "".join(buf)
            else:
                buf.append(c)
                i += 1
        return i, "".join(buf)

    def template(i):
        buf, plain = [], True
        i += 1
        while i < n:
            c = src[i]
            if c == "\\":
                i, ch = _read_escape(src, i)
                buf.append(ch)
            elif c == "`":
                if plain:
                    literals.append("".join(buf))
                return i + 1
            elif c == "$" and src.startswith("${", i):
                plain = False
                i = scan(i + 2, True)
            else:
                buf.append(c)
                i += 1
        return i

    def scan(i, in_expr):
        depth = 0
        while i < n:
            c = src[i]
            if src.startswith("//", i):
                j = src.find("\n", i)
                i = n if j < 0 else j
                continue
            if src.startswith("/*", i):
                j = src.find("*/", i + 2)
                i = n if j < 0 else j + 2
                code.append(" ")
                continue
            if c in "'\"":
                i, text = quoted(i, c)
                literals.append(text)
                code.append("'S'")
                continue
            if c == "`":
                i = template(i)
                code.append("'S'")
                continue
            if in_expr:
                if c == "{":
                    depth += 1
                elif c == "}":
                    if depth == 0:
                        return i + 1
                    depth -= 1
            code.append(c)
            i += 1
        return i

    scan(0, False)
    return "".join(code), literals


def index_usages(code, named_props=()):
    """去掉字面量后的代码里可能按下标用图层的地方（去重、按出现顺序）：getLayer( 的参数不是单个字符串字面量（可能是下标），
    以及 INDEX_APIS。参数是 `scriptProperties.<名>` 且这个脚本属性的值是字符串（named_props）时按名字找，不算。"""
    found = []
    for m in re.finditer(r"\bgetLayer\s*\(", code):
        rest = code[m.end():]
        if re.match(r"\s*'S'\s*\)", rest):
            continue
        prop = re.match(r"\s*scriptProperties\s*\.\s*([A-Za-z_$][\w$]*)\s*\)", rest)
        if prop and prop.group(1) in named_props:
            continue
        found.append("getLayer(%s)" % rest[:40].split(")")[0].strip())
    for api in INDEX_APIS:
        if re.search(r"\b%s\b" % api, code):
            found.append(api)
    return list(dict.fromkeys(found))


# ==================== JSON：遍历、宽松解析、指针 ====================


def _walk(node, path=""):
    """深度优先产出 (JSON 指针, 值)。"""
    yield path, node
    if isinstance(node, dict):
        for k, v in node.items():
            yield from _walk(v, "%s/%s" % (path, str(k).replace("~", "~0").replace("/", "~1")))
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield from _walk(v, "%s/%d" % (path, i))


def _strings(node):
    return [v for _, v in _walk(node) if isinstance(v, str)]


def _scripts(node):
    """[(指针, 源码, scriptproperties 里的字符串, 字符串值的属性名)]：每个 `script` 键是字符串的字典。
    属性值是字符串，或 {value: 字符串}（带 user 绑定的写法）时算字符串值的属性。"""
    out = []
    for path, value in _walk(node):
        if isinstance(value, dict) and isinstance(value.get("script"), str):
            props = value.get("scriptproperties")
            strings = _strings(props) if props is not None else []
            named = set()
            if isinstance(props, dict):
                for key, v in props.items():
                    if isinstance(v, str) or (isinstance(v, dict) and isinstance(v.get("value"), str)):
                        named.add(key)
            out.append((path + "/script", value["script"], strings, named))
    return out


def _strip_json_comments(text):
    """去掉字符串之外的 // 与 /* */ 注释和尾逗号（材质 JSON 有带注释的，P5a 前置修正）。"""
    out, i, n = [], 0, len(text)
    while i < n:
        c = text[i]
        if c == '"':
            j = i + 1
            while j < n and text[j] != '"':
                j += 2 if text[j] == "\\" else 1
            out.append(text[i:j + 1])
            i = j + 1
        elif text.startswith("//", i):
            j = text.find("\n", i)
            i = n if j < 0 else j
        elif text.startswith("/*", i):
            j = text.find("*/", i + 2)
            i = n if j < 0 else j + 2
        else:
            out.append(c)
            i += 1
    return re.sub(r",(\s*[}\]])", r"\1", "".join(out))


def _parse_lenient(data):
    """严格 JSON，失败再去注释与尾逗号；仍失败返回 None。"""
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        return None
    try:
        return json.loads(text)
    except ValueError:
        pass
    try:
        return json.loads(_strip_json_comments(text))
    except ValueError:
        return None


def _pointer_tokens(pointer):
    if not pointer.startswith("/"):
        raise KbpError("kbp", "JSON 指针要以 / 开头：%r" % pointer)
    return [t.replace("~1", "/").replace("~0", "~") for t in pointer[1:].split("/")]


def apply_pointer(node, pointer, value):
    """按 RFC 6901 把 node 里 pointer 处的值换成 value，返回旧值；路径不存在报 [data]（不新建键）。"""
    tokens = _pointer_tokens(pointer)
    cur = node
    for depth, token in enumerate(tokens):
        last = depth == len(tokens) - 1
        if isinstance(cur, dict):
            if token not in cur:
                raise KbpError("data", "JSON 指针 %s 不存在：没有键 %r" % (pointer, token))
            if last:
                old = cur[token]
                cur[token] = value
                return old
            cur = cur[token]
        elif isinstance(cur, list):
            if not re.fullmatch(r"0|[1-9][0-9]*", token) or int(token) >= len(cur):
                raise KbpError("data", "JSON 指针 %s 不存在：数组下标 %r 越界或不是数字（长度 %d）" % (pointer, token, len(cur)))
            if last:
                old = cur[int(token)]
                cur[int(token)] = value
                return old
            cur = cur[int(token)]
        else:
            raise KbpError("data", "JSON 指针 %s 不存在：%r 之前已是标量" % (pointer, token))
    raise KbpError("kbp", "JSON 指针不能是整个对象：%r" % pointer)


def parse_fix(text):
    """`<对象id|名字>:<JSON 指针>=<JSON 值>` → (对象, 指针, 值)。对象与指针之间按第一个「:/」切，指针与值按其后第一个「=」切
    （所以名字里可以有冒号、指针里不能有等号）。"""
    m = re.match(r"^(.+?):(/[^=]*)=(.*)$", text, re.S)
    if not m:
        raise KbpError("kbp", "--fix 的写法是 <对象id|名字>:<JSON 指针>=<JSON 值>：%r" % text)
    try:
        value = json.loads(m.group(3))
    except ValueError as e:
        raise KbpError("kbp", "--fix 的值不是 JSON（字符串要带引号）：%r（%s）" % (m.group(3), e))
    return m.group(1), m.group(2), value


# ==================== 闭包 ====================


class _Objects(object):
    """scene.json 的 objects：按下标存，另建 id → 下标、名字 → 下标。"""

    def __init__(self, objects):
        self.items = objects
        self.by_id, self.by_name = {}, {}
        for i, o in enumerate(objects):
            oid = o.get("id")
            if isinstance(oid, int) and not isinstance(oid, bool):
                self.by_id.setdefault(oid, []).append(i)
            name = o.get("name")
            if isinstance(name, str) and name:
                self.by_name.setdefault(name, []).append(i)

    def id_of(self, i):
        oid = self.items[i].get("id")
        return oid if isinstance(oid, int) and not isinstance(oid, bool) else None

    def label(self, i):
        name = self.items[i].get("name")
        return "%s「%s」" % (self.id_of(i) if self.id_of(i) is not None else "#%d" % i, name if isinstance(name, str) else "")

    def ref(self, token, what):
        """--keep / --drop / --fix 的对象：整数先按 id、没有这个 id 再按名字；名字必须唯一。"""
        token = str(token).strip()
        if re.fullmatch(r"-?[0-9]+", token):
            hits = self.by_id.get(int(token), [])
            if len(hits) == 1:
                return hits[0]
            if len(hits) > 1:
                raise KbpError("data", "%s %s：id 不唯一（objects 下标 %s）" % (what, token, hits))
        hits = self.by_name.get(token, [])
        if len(hits) == 1:
            return hits[0]
        if len(hits) > 1:
            raise KbpError("data", "%s %r：名字不唯一（id %s），改用 id" % (what, token, [self.id_of(i) for i in hits]))
        raise KbpError("data", "%s %r：找不到这个 id 或名字" % (what, token))


def _dependency_ids(obj):
    value = obj.get("dependencies")
    elements = value if isinstance(value, list) else list(value.values()) if isinstance(value, dict) else []
    out = []
    for e in elements:
        if isinstance(e, dict):
            e = e.get("id")
        if isinstance(e, int) and not isinstance(e, bool) and e >= 0:
            out.append(e)
    return out


def _union(objs, indices):
    """这些对象的 dependencies 并集：{id: [列它的对象下标]}（同 dependencies.ts 的 dependencyIds，只收数字元素）。"""
    out = {}
    for i in indices:
        value = objs.items[i].get("dependencies")
        elements = value if isinstance(value, list) else list(value.values()) if isinstance(value, dict) else []
        for e in elements:
            if isinstance(e, int) and not isinstance(e, bool) and e >= 0:
                out.setdefault(e, []).append(i)
    return out


def _is_light(obj):
    return obj.get("light") is not None


def _is_camera(obj):
    return isinstance(obj.get("camera"), str)


def plan(scene, keep, drop=(), fixes=(), resolver=None, fr_name=content.FR_NAME):
    """算保留集合（不写盘）。scene 就地改：先套 fixes，再按闭包删 objects。

    resolver(相对路径, 来自哪个 JSON 的相对路径或 None, 允许 assets) → (来源, 相对路径, 字节) 或 None：找对象 JSON 里引用的 .json。
    返回 {kept: [{id, name, reasons}], removed: [{id, name}], fixes: [...], warnings: [{kind, object, message}]}。"""
    if not isinstance(scene, dict) or not isinstance(scene.get("objects"), list):
        raise KbpError("data", "入口场景的顶层不是 {objects: [...]}")
    raw = scene["objects"]
    bad = [i for i, o in enumerate(raw) if not isinstance(o, dict)]
    if bad:
        raise KbpError("data", "objects 里有不是对象的元素（下标 %s），不处理" % bad)
    objs = _Objects(raw)
    if not keep:
        raise KbpError("kbp", "--keep 至少给一个对象")
    warnings = []

    def warn(kind, i, message):
        warnings.append({"kind": kind, "object": objs.id_of(i) if i is not None else None, "message": message})

    # 1. 字段换成固定值（在闭包之前：闭包按换完的 JSON 算，换掉的脚本不再拉对象进来）
    fixed, fixed_at = [], []
    for spec in fixes:
        ref, pointer, value = parse_fix(spec) if isinstance(spec, str) else spec
        i = objs.ref(ref, "--fix")
        fixed.append({"object": objs.id_of(i), "name": raw[i].get("name"), "pointer": pointer, "value": value})
        fixed[-1]["old"] = apply_pointer(raw[i], pointer, value)
        fixed_at.append(i)

    dropped = {objs.ref(t, "--drop") for t in drop}
    seeds = []
    for t in keep:
        i = objs.ref(t, "--keep")
        if i in dropped:
            raise KbpError("kbp", "%s 同时在 --keep 与 --drop 里" % objs.label(i))
        seeds.append((i, {"reason": "requested"}))
    for i, o in enumerate(raw):
        if _is_light(o):
            seeds.append((i, {"reason": "light"}))
        if _is_camera(o):
            seeds.append((i, {"reason": "camera"}))
        if o.get("name") == fr_name:
            seeds.append((i, {"reason": "kbp-FR"}))

    # 对象引用到的文档：对象 JSON 本身 + 能走到的工程内 .json（rt-ref 只看这些）+ assets 里的 .json（只用于读帧缓冲的警告）
    doc_cache = {}

    def reachable(i):
        if i in doc_cache:
            return doc_cache[i]
        project_strings, all_strings, unreadable = list(_strings(raw[i])), list(_strings(raw[i])), []
        seen = set()
        queue = [(None, raw[i], "project")]
        while queue:
            base, node, origin = queue.pop(0)
            for s in _strings(node):
                if not s.lower().endswith(".json") or resolver is None:
                    continue
                hit = resolver(s, base, True)
                if hit is None:
                    continue
                source, rel, data = hit
                key = (source, rel.lower())
                if key in seen:
                    continue
                seen.add(key)
                parsed = _parse_lenient(data)
                child_origin = "project" if origin == "project" and source != "assets" else "assets"
                if parsed is None:
                    text = data.decode("utf-8", "replace")
                    unreadable.append("%s:%s" % (source, rel))
                    if child_origin == "project":
                        project_strings.append(text)
                    all_strings.append(text)
                    continue
                if child_origin == "project":
                    project_strings.extend(_strings(parsed))
                all_strings.extend(_strings(parsed))
                queue.append((rel, parsed, child_origin))
        doc_cache[i] = (project_strings, all_strings, unreadable)
        return doc_cache[i]

    def edges(i):
        o = raw[i]
        me = objs.id_of(i)
        parent = o.get("parent")
        if isinstance(parent, int) and not isinstance(parent, bool):
            hits = objs.by_id.get(parent, [])
            if not hits:
                warn("parent-missing", i, "%s 的 parent %s 在 objects 里找不到" % (objs.label(i), parent))
            for j in hits:
                yield j, {"reason": "parent", "from": me}
        for dep in _dependency_ids(o):
            for j in objs.by_id.get(dep, []):
                yield j, {"reason": "dependency", "from": me}
        project_strings, _, _ = reachable(i)
        for s in project_strings:
            for m in RT_COMPOSITE.finditer(s):
                rid = int(m.group(1))
                hits = objs.by_id.get(rid, [])
                if not hits:
                    warn("rt-missing", i, "%s 引用了 %s…，但 objects 里没有 id %d" % (objs.label(i), m.group(0), rid))
                for j in hits:
                    if j != i:
                        yield j, {"reason": "rt-ref", "from": me, "rt": m.group(0)}
        for path, source, props, _ in _scripts(o):
            _, literals = js_scan(source)
            for via, values in (("script", literals), ("scriptproperties", props)):
                for literal in values:
                    for j in objs.by_name.get(literal, []):
                        if j != i:
                            yield j, {"reason": "script-name", "from": me, "literal": literal, "via": via, "at": path}

    kept, blocked = {}, {}
    queue = []

    def add(i, reason):
        if i in dropped:
            blocked.setdefault(i, [])
            if reason not in blocked[i]:
                blocked[i].append(reason)
            return
        if i in kept:
            if reason not in kept[i]:
                kept[i].append(reason)
            return
        kept[i] = [reason]
        queue.append(i)

    for i, reason in seeds:
        add(i, reason)
    while queue:
        i = queue.pop(0)
        for j, reason in edges(i):
            add(j, reason)

    for i in fixed_at:
        if i not in kept:
            raise KbpError("data", "--fix 的对象 %s 不在保留集合里（换了也会被删）" % objs.label(i))

    removed = [i for i in range(len(raw)) if i not in kept]
    removed_set = set(removed)

    # ---------- 警告 ----------
    def why(reasons):
        parts = []
        for r in reasons:
            text = r["reason"]
            if "from" in r:
                text += "（来自 %s）" % r["from"]
            if "literal" in r:
                text += "：%s %r" % (r["via"], r["literal"])
            if "rt" in r:
                text += "：%s" % r["rt"]
            parts.append(text)
        return "、".join(parts)

    for i in sorted(blocked):
        warn("drop", i, "--drop 去掉了 %s，但闭包要它，因为 %s" % (objs.label(i), why(blocked[i])))
    if removed:
        for i in sorted(kept):
            for path, source, _, named in _scripts(raw[i]):
                code, _ = js_scan(source)
                uses = index_usages(code, named)
                if uses:
                    warn("script-index", i, "%s 的脚本（%s）可能按下标或枚举用图层（%s）：删了 %d 个对象，下标与枚举结果会变" % (
                        objs.label(i), path, "、".join(uses), len(removed)))
    before = _union(objs, range(len(raw)))
    after = _union(objs, kept)
    for dep in sorted(before):
        for j in objs.by_id.get(dep, []):
            if j in kept and dep not in after:
                listers = [objs.label(k) for k in before[dep] if k in removed_set]
                warn("dependency-union", j, "%s 原来被 %s 依赖（dependencies 并集里有它），这些对象删了以后它不再「被依赖」：合成链第 0 张"
                     "不再是独占 RT、不可见时不再照画（dependencies.ts）" % (objs.label(j), "、".join(listers)))
    for i in sorted(kept):
        _, all_strings, unreadable = reachable(i)
        if any(FULL_FRAME in s for s in all_strings):
            earlier = [k for k in removed if k < i]
            if earlier:
                warn("fullframebuffer", i, "%s 的 effect / 材质读 %s：它前面删了 %d 个对象（%s），帧缓冲快照的输入变了" % (
                    objs.label(i), FULL_FRAME, len(earlier), "、".join(objs.label(k) for k in earlier[:6])
                    + ("…" if len(earlier) > 6 else "")))
        for item in unreadable:
            warn("unreadable", i, "%s 引用的 %s 解析不了（严格与去注释都不行），只按原文找了 RT 名字，里面的 .json 引用没展开" % (
                objs.label(i), item))
    kept_names = {raw[i].get("name"): i for i in kept if isinstance(raw[i].get("name"), str) and raw[i].get("name")}
    for i in removed:
        for path, source, props, _ in _scripts(raw[i]):
            _, literals = js_scan(source)
            hits = sorted({x for x in literals + props if x in kept_names})
            if hits:
                warn("removed-script-name", i, "（信息）被删的 %s 的脚本（%s）用名字引用了保留对象 %s" % (
                    objs.label(i), path, "、".join(objs.label(kept_names[x]) for x in hits)))

    scene["objects"] = [raw[i] for i in range(len(raw)) if i in kept]
    return {
        "kept": [{"id": objs.id_of(i), "name": raw[i].get("name"), "reasons": kept[i]} for i in sorted(kept)],
        "removed": [{"id": objs.id_of(i), "name": raw[i].get("name")} for i in removed],
        "fixes": fixed,
        "warnings": warnings,
    }


# ==================== 命令 ====================


def _project_resolver(src):
    """在源工程（散文件 → scene.pkg，allow_assets 时再 WPE assets/）里找 .json：先按工程根，再按引用它的 JSON 所在目录。"""
    def resolve(rel, base, allow_assets):
        candidates = []
        for item in (rel, os.path.join(os.path.dirname(base), rel).replace("\\", "/") if base else None):
            if not item:
                continue
            try:
                candidates.append(content.normalize(item))
            except KbpError:
                continue
        for sources in (("project", "pkg"),) + ((("assets",),) if allow_assets else ()):
            for cand in candidates:
                where = content.locate(src, cand, sources)
                if where is not None:
                    data, _ = content.read(src, cand, sources)
                    return where["source"], cand, data
        return None
    return resolve


def _short_name(tokens):
    text = "-".join(str(t).strip() for t in tokens)
    text = re.sub(r'[<>:"/\\|?*\s]+', "_", text).strip("._") or "iso"
    return text[:40]


def _next(out, data, instrument, name):
    tag = os.path.basename(out)
    logs = os.path.join(common.data_dir(data), "out")
    lines = [
        "WPE：wpe-renderdoc 的 capture_sweep(jobs=[{project: \"%s\", size: \"1920x1080\", tag: \"%s-fps<N>-1920x1080\"}], "
        "out_root: \"A:\\<项目>\"%s)，WPE 的图用 kbp rdc frame --present；" % (
            out, tag, (", log_dir: \"%s\"" % logs) if instrument else ""),
        "Kabegame：kabegame-dev 的 projects_import 导入这个目录，再 deno run -A apps/kabegame-dev-mcp/src/renderFrames.ts --image <id> "
        "%s--frames <帧> --canvas 1920x1080 --out <目录>（见 kabegame-chromium SKILL.md「批量渲染」）；" % (
            ("--timeline-log %s --cursors log " % os.path.join(logs, tag + "-fps<N>-1920x1080-log.txt")) if instrument
            else "--fps <N> "),
        "比较：kbp cmp frames <我们的目录> <WPE 的目录>；用完 projects_remove。",
    ]
    if not instrument:
        lines.append("没加 FR：抓帧没有 [kbp] 日志，回放只能按名义时间（--fps）；要按 WPE 实际帧时间加 --instrument --overwrite 重做。")
    return "".join(lines)


def isolate(project, keep, drop=(), fixes=(), name=None, out=None, instrument=False, data=None, overwrite=False):
    src = content.project_dir(project)
    name = name or _short_name(keep)
    if not re.fullmatch(r"[^<>:\"/\\|?*\s]+", name):
        raise KbpError("kbp", "--name 不能有空白与 <>:\"/\\|?*：%r" % name)
    base = os.path.basename(src.rstrip("\\/"))
    out = os.path.abspath(out) if out else os.path.join(common.data_dir(data), "proj", "%s-iso-%s" % (base, name))
    result = {}

    def rewrite(src_dir, info, entry, scene):
        result.update(plan(scene, keep, drop, fixes, _project_resolver(src_dir)))
        info["title"] = info["title"] + " (iso %s)" % name
        marker = {
            "tool": "kbp content isolate", "source": src_dir, "entry": entry, "name": name, "title": info["title"],
            "keep": list(keep), "drop": list(drop), "instrument": bool(instrument),
            "kept": result["kept"], "removed": result["removed"], "fixes": result["fixes"], "warnings": result["warnings"],
            "time": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
        }
        return {"files": {ISOLATE_MARKER: marker}, "summary": {}}

    summary = content.unpack_with(src, out, instrument, data, overwrite, rewrite=rewrite)
    summary.update({
        "action": "isolate", "name": name, "kept": len(result["kept"]), "removed": len(result["removed"]),
        "kept_objects": [[k["id"], k["name"]] for k in result["kept"]], "fixes": len(result["fixes"]),
        "warnings": [w["message"] for w in result["warnings"]], "marker": os.path.join(summary["out"], ISOLATE_MARKER),
        "next": _next(summary["out"], data, instrument, name),
    })
    return summary


def _split(values):
    """--keep a,b --keep c → [a, b, c]（逗号分隔，可重复）。"""
    out = []
    for v in values or []:
        out.extend(t for t in (x.strip() for x in v.split(",")) if t)
    return out


def cli(args):
    return isolate(args.project, _split(args.keep), _split(args.drop), args.fix or [], args.name, args.out,
                   args.instrument, args.data, args.overwrite)
