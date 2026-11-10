"""产品源码快照（kbp-tools 点 4）：`kbp snapshot export <rev|WORKTREE> <目录>`、`kbp snapshot diff <基线> <副本> --out x.patch`。

快照目录的样子（就是 P4c 步骤 1 手工搭的 `ignore/p4/c1/ov`）：
    <目录>/src/            apps/wpe-scene/src 的拷贝（回放、回归的 --src 指它）
    <目录>/tsconfig.json   extends 仓库根的 tsconfig.json，types 照 apps/wpe-scene/tsconfig.json 再加 node
    <目录>/vitest.config.ts root 是本文件所在目录，只跑 src/ 下的产品测试
    <目录>/snapshot.json   来源（提交 / 工作区）、文件数、翻译器 wasm 的哈希、tsc 结果（diff 只比 src/，不看它）
    <目录>/tsc.log、vitest.log、vitest.json

- `<rev>`：`git archive` 导出该提交的 apps/wpe-scene/src（只读，不碰索引与工作区）；再拷入未入库的翻译器 wasm
  （工作区的 apps/wpe-scene/src/wpesl2wgsl/wpesl2wgsl.wasm）。
- `WORKTREE`：原样拷当前工作区的 apps/wpe-scene/src（含未入库的文件），用来冻结并行会话正在改的代码。
- 目录要在仓库里：tsc 与 vitest 沿目录向上找 node_modules（仓库根的）。
- 导出后跑一次 tsc（`--no-tsc` 跳过），`--vitest` 另跑产品 vitest，报文件数与用例数。
- diff：两边 src/ 逐文件比，写成 git 格式的补丁，路径改写成 `apps/wpe-scene/src/…`，可以 `git apply --check` / `git apply --3way`
  直接打在仓库上。只收文本；二进制文件（如 wasm）不同时报错。
"""

import datetime
import difflib
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import tarfile
import time

from . import common
from .common import KbpError

SRC_REL = "apps/wpe-scene/src"
WASM_REL = "wpesl2wgsl/wpesl2wgsl.wasm"
MARKER = "snapshot.json"

VITEST_CONFIG = """import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// kbp snapshot export 写的：root 是本文件所在目录（快照根），只跑 src/ 下的产品测试（同 apps/wpe-scene/vitest.config.ts）
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
"""


def _git(args, binary=False):
    proc = subprocess.run(["git", "-C", common.REPO_ROOT] + args, capture_output=True)
    if proc.returncode != 0:
        raise KbpError("src", "git %s 失败：%s" % (" ".join(args), proc.stderr.decode("utf-8", "replace").strip()))
    return proc.stdout if binary else proc.stdout.decode("utf-8")


def _inside_repo(path):
    repo = os.path.normcase(os.path.abspath(common.REPO_ROOT)) + os.sep
    return os.path.normcase(os.path.abspath(path)).startswith(repo)


def _sha256(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def _count_files(root):
    return sum(len(names) for _, _, names in os.walk(root))


def _prepare_dir(directory, overwrite):
    if os.path.exists(directory) and os.listdir(directory):
        if not overwrite:
            raise KbpError("data", "目录已存在且非空（要覆盖加 --overwrite）：%s" % directory)
        if not os.path.isfile(os.path.join(directory, MARKER)):
            raise KbpError("data", "%s 不是 kbp snapshot 写的快照（没有 %s），不删" % (directory, MARKER))
        shutil.rmtree(directory)
    os.makedirs(directory, exist_ok=True)


def _extract_rev(commit, target):
    """git archive 导出 apps/wpe-scene/src，去掉前缀解到 target。"""
    data = _git(["archive", "--format=tar", commit, SRC_REL], binary=True)
    prefix = SRC_REL + "/"
    count = 0
    with tarfile.open(fileobj=io.BytesIO(data)) as tar:
        for member in tar.getmembers():
            if not member.name.startswith(prefix):
                continue
            rel = member.name[len(prefix):]
            if not rel or ".." in rel.split("/") or rel.startswith("/"):
                continue
            dest = os.path.join(target, *rel.split("/"))
            if member.isdir():
                os.makedirs(dest, exist_ok=True)
            elif member.isfile():
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                with tar.extractfile(member) as src, open(dest, "wb") as f:
                    f.write(src.read())
                count += 1
    if not count:
        raise KbpError("src", "%s 里没有 %s" % (commit, SRC_REL))
    return count


def _tsconfig(directory, base_text):
    try:
        base = json.loads(base_text)
    except ValueError as e:
        raise KbpError("src", "apps/wpe-scene/tsconfig.json 不是纯 JSON：%s" % e)
    options = dict(base.get("compilerOptions") or {})
    types = list(options.get("types") or [])
    if "node" not in types:
        types.append("node")
    options["types"] = types
    root_tsconfig = os.path.join(common.REPO_ROOT, "tsconfig.json")
    extends = os.path.relpath(root_tsconfig, directory).replace("\\", "/")
    return {"extends": extends, "compilerOptions": options, "include": ["src/**/*.ts", "src/**/*.d.ts"]}


def run_tsc(directory):
    tsc = os.path.join(common.REPO_ROOT, "node_modules", "typescript", "bin", "tsc")
    started = time.time()
    proc = subprocess.run(["node", tsc, "--noEmit", "-p", os.path.join(directory, "tsconfig.json")],
                          cwd=common.REPO_ROOT, capture_output=True)
    text = (proc.stdout + proc.stderr).decode("utf-8", "replace")
    with open(os.path.join(directory, "tsc.log"), "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    errors = len(re.findall(r"error TS\d+", text))
    return {"errors": errors, "exit": proc.returncode, "seconds": round(time.time() - started, 1),
            "log": os.path.join(directory, "tsc.log")}


def run_vitest(directory):
    vitest = os.path.join(common.REPO_ROOT, "node_modules", "vitest", "vitest.mjs")
    report = os.path.join(directory, "vitest.json")
    started = time.time()
    proc = subprocess.run(["node", vitest, "run", "--config", os.path.join(directory, "vitest.config.ts"),
                           "--reporter=default", "--reporter=json", "--outputFile.json=" + report],
                          cwd=common.REPO_ROOT, capture_output=True)
    with open(os.path.join(directory, "vitest.log"), "wb") as f:
        f.write(proc.stdout + proc.stderr)
    out = {"exit": proc.returncode, "seconds": round(time.time() - started, 1), "log": os.path.join(directory, "vitest.log")}
    try:
        data = common.read_json(report)
        out.update(files=len(data.get("testResults") or []), tests=data.get("numTotalTests"),
                   passed=data.get("numPassedTests"), failed=data.get("numFailedTests"),
                   pending=data.get("numPendingTests"), todo=data.get("numTodoTests"))
    except KbpError as e:
        out["error"] = str(e)
    return out


def export(rev, directory, overwrite=False, tsc=True, vitest=False):
    directory = os.path.abspath(directory)
    if not _inside_repo(directory):
        raise KbpError("kbp", "快照目录要在仓库里（tsc / vitest 沿目录向上找 node_modules）：%s" % directory)
    worktree_src = os.path.join(common.REPO_ROOT, *SRC_REL.split("/"))
    started = time.time()
    if rev.upper() == "WORKTREE":
        if not os.path.isdir(worktree_src):
            raise KbpError("src", "找不到 %s" % worktree_src)
        _prepare_dir(directory, overwrite)
        shutil.copytree(worktree_src, os.path.join(directory, "src"))
        info = {"kind": "worktree", "rev": "WORKTREE", "head": _git(["rev-parse", "HEAD"]).strip()}
        with open(os.path.join(common.REPO_ROOT, "apps", "wpe-scene", "tsconfig.json"), encoding="utf-8") as f:
            base_tsconfig = f.read()
    else:
        commit = _git(["rev-parse", "--verify", rev + "^{commit}"]).strip()
        _prepare_dir(directory, overwrite)
        _extract_rev(commit, os.path.join(directory, "src"))
        info = {"kind": "rev", "rev": rev, "commit": commit}
        base_tsconfig = _git(["show", "%s:apps/wpe-scene/tsconfig.json" % commit])
    wasm = os.path.join(directory, "src", *WASM_REL.split("/"))
    if not os.path.isfile(wasm):
        source = os.path.join(worktree_src, *WASM_REL.split("/"))
        if os.path.isfile(source):
            os.makedirs(os.path.dirname(wasm), exist_ok=True)
            shutil.copyfile(source, wasm)
            info["wasm_from"] = "worktree"
    info["wasm"] = _sha256(wasm) if os.path.isfile(wasm) else None
    tsconfig = _tsconfig(directory, base_tsconfig)
    with open(os.path.join(directory, "tsconfig.json"), "w", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(tsconfig, ensure_ascii=False, indent=2) + "\n")
    with open(os.path.join(directory, "vitest.config.ts"), "w", encoding="utf-8", newline="\n") as f:
        f.write(VITEST_CONFIG)
    info.update(created=datetime.datetime.now().isoformat(timespec="seconds"),
                files=_count_files(os.path.join(directory, "src")))
    # 先写标记：tsc 中途失败时目录也认得出是本工具写的
    common.write_json(os.path.join(directory, MARKER), info, indent=1)
    if tsc:
        info["tsc"] = run_tsc(directory)
    if vitest:
        info["vitest"] = run_vitest(directory)
    common.write_json(os.path.join(directory, MARKER), info, indent=1)
    summary = {"ok": True, "dir": directory, "src": os.path.join(directory, "src")}
    summary.update({k: info[k] for k in ("kind", "rev", "commit", "head", "files", "wasm", "tsc", "vitest") if k in info})
    if info["wasm"] is None:
        summary["warning"] = "快照里没有翻译器 wasm（%s），编译着色器的回放会失败" % WASM_REL
    summary["seconds"] = round(time.time() - started, 1)
    return summary


# ==================== diff ====================


def _src_of(path):
    path = os.path.abspath(path)
    inner = os.path.join(path, "src")
    if os.path.isdir(inner):
        return inner
    if os.path.isdir(path):
        return path
    raise KbpError("data", "不是目录：%s" % path)


def _files(root):
    out = {}
    for base, dirs, names in os.walk(root):
        dirs.sort()
        for name in sorted(names):
            path = os.path.join(base, name)
            out[os.path.relpath(path, root).replace("\\", "/")] = path
    return out


def _range(start, stop):
    """difflib 的 unified 区间写法。"""
    beginning = start + 1
    length = stop - start
    if length == 1:
        return "%d" % beginning
    if not length:
        beginning -= 1
    return "%d,%d" % (beginning, length)


def _line(prefix, line):
    if line.endswith("\n"):
        return prefix + line
    return prefix + line + "\n\\ No newline at end of file\n"


def _hunks(a, b):
    out = []
    for group in difflib.SequenceMatcher(None, a, b, autojunk=False).get_grouped_opcodes(3):
        first, last = group[0], group[-1]
        out.append("@@ -%s +%s @@\n" % (_range(first[1], last[2]), _range(first[3], last[4])))
        for tag, i1, i2, j1, j2 in group:
            if tag == "equal":
                out.extend(_line(" ", l) for l in a[i1:i2])
                continue
            if tag in ("replace", "delete"):
                out.extend(_line("-", l) for l in a[i1:i2])
            if tag in ("replace", "insert"):
                out.extend(_line("+", l) for l in b[j1:j2])
    return out


def _text(path, rel):
    with open(path, "rb") as f:
        data = f.read()
    if b"\0" in data:
        return None
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return None


def diff(base, copy, out, overwrite=False):
    base_src, copy_src = _src_of(base), _src_of(copy)
    out = os.path.abspath(out)
    if os.path.exists(out) and not overwrite:
        raise KbpError("data", "补丁已存在（要覆盖加 --overwrite）：%s" % out)
    a, b = _files(base_src), _files(copy_src)
    chunks, changed, added, deleted, binary = [], [], [], [], []
    plus = minus = 0
    for rel in sorted(set(a) | set(b)):
        if rel in a and rel in b:
            with open(a[rel], "rb") as f1, open(b[rel], "rb") as f2:
                if f1.read() == f2.read():
                    continue
        old = _text(a[rel], rel) if rel in a else ""
        new = _text(b[rel], rel) if rel in b else ""
        if old is None or new is None:
            binary.append(rel)
            continue
        path = "%s/%s" % (SRC_REL, rel)
        head = ["diff --git a/%s b/%s\n" % (path, path)]
        if rel not in a:
            head.append("new file mode 100644\n")
            added.append(rel)
        elif rel not in b:
            head.append("deleted file mode 100644\n")
            deleted.append(rel)
        else:
            changed.append(rel)
        old_lines, new_lines = old.splitlines(True), new.splitlines(True)
        hunks = _hunks(old_lines, new_lines)
        if hunks:
            head.append("--- %s\n" % ("a/" + path if rel in a else "/dev/null"))
            head.append("+++ %s\n" % ("b/" + path if rel in b else "/dev/null"))
        plus += sum(1 for h in hunks if h.startswith("+"))
        minus += sum(1 for h in hunks if h.startswith("-"))
        chunks.append("".join(head + hunks))
    if binary:
        raise KbpError("data", "二进制文件不同，补丁只收文本：%s" % "、".join(binary))
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    with open(out, "w", encoding="utf-8", newline="") as f:
        f.write("".join(chunks))
    return {"ok": True, "out": out, "base": base_src, "copy": copy_src, "changed": changed, "added": added,
            "deleted": deleted, "lines": {"+": plus, "-": minus},
            "apply": "git apply --check %s（再 git apply --3way 打进工作区）" % out}


def cli(args):
    if args.action == "export":
        return export(args.rev, args.dir, overwrite=args.overwrite, tsc=not args.no_tsc, vitest=args.vitest)
    if args.action == "diff":
        return diff(args.base, args.copy, args.out, overwrite=args.overwrite)
    raise KbpError("kbp", "未知的动作 %s" % args.action)
