"""kbp-tools 唯一入口（WPE 场景对比工具链）。用法与协议见同目录 SKILL.md。

    python -X utf8 -I .claude/skills/kbp-tools/kbp.py <分类> <动作> …

已实现：
- gen <模块> [工程…]：按 <data>/defs/<模块>.py 的 PROJECTS 生成测试工程（第 2 批）；
- rdc track|frame|stats <抓帧目录> <标签> …：在 `qrenderdoc --python rdc/main.py` 里无界面读抓帧，写轨迹 / 整帧图 / 统计量；
- replay <案例…>|--all、regress --src A --src B：回放案例（node + vitest）、两份源码的回归（第 2 批）；
- snapshot export <rev|WORKTREE> <目录>、snapshot diff <基线> <副本>：产品源码快照与补丁（第 2 批）；
- content projects|resolve|ls|cat|grep …：WPE 语料与 scene.pkg 读取。

输出约定：stdout 一行 JSON 摘要（ok、产物路径、要点），细节写文件；失败退出码非 0，错误开头标层（[data]、[wpe]、
[renderdoc]、[kbp] …）。

本文件同时是包 `kbp`（`__path__` 指向 py/）：脚本把本目录放进 sys.path 后可 `from kbp import content`。
"""

import argparse
import os
import sys

sys.dont_write_bytecode = True  # 不在 skill 目录里留 __pycache__

HERE = os.path.dirname(os.path.abspath(__file__))
# 让 `from kbp import content` 找到 py/content.py：本模块充当包 kbp
__path__ = [os.path.join(HERE, "py")]


def _register():
    """作为脚本运行时（__main__）也登记成 kbp，py/ 里的模块用相对导入。"""
    module = sys.modules[__name__]
    sys.modules.setdefault("kbp", module)


def _parser():
    parser = argparse.ArgumentParser(prog="kbp", description="WPE 场景对比工具链（kbp-tools），见 SKILL.md")
    top = parser.add_subparsers(dest="category", required=True)

    # ---------- gen ----------
    gen = top.add_parser("gen", help="造工程：按 <data>/defs/<模块>.py 的 PROJECTS 生成测试工程到 <data>/proj/")
    gen.add_argument("module", help="实验定义模块名（<defs>/<模块>.py）")
    gen.add_argument("projects", nargs="*", help="只生成这些工程（PROJECTS 的键），缺省全部")
    gen.add_argument("--data", help="数据目录，缺省环境变量 KBP_DATA，再缺省 ignore/p4")
    gen.add_argument("--defs", help="实验定义所在目录，缺省 <data>/defs")
    gen.add_argument("--out", help="工程输出目录，缺省 <data>/proj（只对库的 write_project 生效）")
    gen.add_argument("--overwrite", action="store_true", help="工程已存在时先删再写（缺省拒绝）")
    gen.add_argument("--list", action="store_true", help="只列出 PROJECTS 的键")

    # ---------- rdc ----------
    rdc = top.add_parser("rdc", help="取真值：从 WPE 的抓帧提取轨迹、整帧图、统计量")
    rdc_sub = rdc.add_subparsers(dest="action", required=True)

    def rdc_common(p):
        p.add_argument("folder", help=r"抓帧目录（A:\<项目>\<用途>），处理里面全部 .rdc")
        p.add_argument("tag", help="标签：输出文件名用它")
        p.add_argument("--data", help="数据目录，缺省环境变量 KBP_DATA，再缺省 ignore/p4")
        p.add_argument("--overwrite", action="store_true", help="输出已存在时覆盖（缺省拒绝）")
        p.add_argument("--timeout", type=float, default=1800, help="秒，缺省 1800；超时只结束本次拉起的 qrenderdoc")
        p.add_argument("--quiet", action="store_true", help="不把进度转到 stderr")
        p.add_argument("--keep-work", action="store_true", help="保留 job 目录（job.json、log.txt、result.json）")

    track = rdc_sub.add_parser("track", help="轨迹：写 <data>/tracks/rd-<标签>.json")
    rdc_common(track)
    track.add_argument("project", nargs="?",
                       help="工程名（<data>/proj/<工程>）或工程目录；缺省从标签的「<工程>-fps<N>…」推")
    track.add_argument("--out", help="输出文件，缺省 <data>/tracks/rd-<标签>.json")
    track.add_argument("--draws", action="store_true",
                       help="按绘制原样保存（rdc_rope.py 的格式：vs_in、gs_out / vs_out、maxout、常量）；"
                            "kbp-meta.json 有 track: draws 时自动如此")
    track.add_argument("--points", action="store_true",
                       help="强制按粒子认（覆盖 kbp-meta.json 的 track: draws）")
    track.add_argument("--limit", type=int, default=20000, help="--draws 时每次绘制最多读的顶点数，缺省 20000")

    frame = rdc_sub.add_parser("frame", help="整帧图：写 <data>/out/wpe-<标签>-f<脚本帧>.png 与 wpe-<标签>.json")
    rdc_common(frame)
    frame.add_argument("--out", help="输出目录，缺省 <data>/out")
    frame.add_argument("--event", type=int, help="取这个事件之后的渲染目标 0（缺省最后一次绘制之后）")
    frame.add_argument("--present", action="store_true", help="取 Present 时的后备缓冲；浮点格式存 DDS")

    stats = rdc_sub.add_parser("stats", help="粒子统计量：写 <data>/out/wpe-<标签>-stats.json")
    rdc_common(stats)
    stats.add_argument("--out", help="输出文件，缺省 <data>/out/wpe-<标签>-stats.json")

    # ---------- replay / regress ----------
    def src_data(p):
        p.add_argument("--data", help="数据目录（cases/、proj/、tracks/、out/），缺省 KBP_DATA，再缺省 ignore/p4")
        p.add_argument("--timeout", type=float, default=3600, help="秒，缺省 3600；超时只结束本次拉起的 node")
        p.add_argument("--quiet", action="store_true", help="不把 vitest 的输出转到 stderr")

    replay = top.add_parser("replay", help="算我们的：跑回放案例（<data>/cases/<名字>.json），写报告")
    replay.add_argument("cases", nargs="*", help="案例名；--all 跑全部")
    replay.add_argument("--all", action="store_true", help="跑 <data>/cases/ 下全部案例")
    replay.add_argument("--src", help="产品源码目录（快照的 src/），缺省 apps/wpe-scene/src")
    replay.add_argument("--out", help="报告目录，缺省 <data>/out/replay")
    replay.add_argument("--overwrite", action="store_true", help="报告已存在时覆盖（缺省拒绝）")
    src_data(replay)

    regress = top.add_parser("regress", help="守：全部案例在两份源码上各跑一遍，逐字节比较报告")
    regress.add_argument("--src", action="append", required=True, help="产品源码目录，给两次：--src A --src B")
    regress.add_argument("--cases", help="只跑这些案例（逗号分隔），缺省全部")
    regress.add_argument("--out", help="输出目录，缺省 <data>/out/regress；下有 a/、b/、regress.json、regress.txt")
    regress.add_argument("--overwrite", action="store_true", help="输出已存在时覆盖（缺省拒绝）")
    regress.add_argument("--serial", action="store_true", help="两边依次跑（缺省两个 node 进程并行）")
    regress.add_argument("--corpus", action="store_true", help="同时比语料扫描（第 3 批，未实现）")
    src_data(regress)

    # ---------- snapshot ----------
    snapshot = top.add_parser("snapshot", help="产品源码快照（apps/wpe-scene/src）与补丁")
    snapshot_sub = snapshot.add_subparsers(dest="action", required=True)
    export = snapshot_sub.add_parser("export", help="导出 <rev> 或 WORKTREE 的 apps/wpe-scene/src 到 <目录>/src，写独立 tsconfig / vitest 配置并跑 tsc")
    export.add_argument("rev", help="提交（HEAD、哈希、分支…）或 WORKTREE（原样拷当前工作区）")
    export.add_argument("dir", help="快照目录（要在仓库里，模块解析沿目录向上找 node_modules）")
    export.add_argument("--overwrite", action="store_true", help="目录已存在且非空时先删（只删本工具写的快照）")
    export.add_argument("--no-tsc", action="store_true", help="不跑 tsc")
    export.add_argument("--vitest", action="store_true", help="另在快照里跑一遍产品 vitest，报文件数与用例数")
    diff = snapshot_sub.add_parser("diff", help="副本相对基线的改动做成补丁，路径改写成 apps/wpe-scene/src/…")
    diff.add_argument("base", help="基线快照目录（或其 src/）")
    diff.add_argument("copy", help="改过的副本目录（或其 src/）")
    diff.add_argument("--out", required=True, help="补丁文件")
    diff.add_argument("--overwrite", action="store_true")

    # ---------- content ----------
    content = top.add_parser("content", help="语料与 scene.pkg 读取（WPE 目录取 KABEGAME_WPE_ROOT）")
    content_sub = content.add_subparsers(dest="action", required=True)

    def filters(p):
        p.add_argument("--source", default="default,workshop",
                       help="工程来源，逗号分隔：default、workshop、my；缺省 default,workshop")
        p.add_argument("--type", help="只要 project.json 的 type 等于它的（scene、web、video…）")
        p.add_argument("--pkg", action="store_true", help="只要有 scene.pkg 的")

    projects = content_sub.add_parser("projects", help="列工程目录")
    filters(projects)
    projects.add_argument("--no-pkg", action="store_true", help="只要没有 scene.pkg 的")
    projects.add_argument("--out", help="列表写到这个 JSON 文件，stdout 只给摘要")

    resolve = content_sub.add_parser("resolve", help="解析工程：目录、project.json、工坊 ID、默认工程名、myprojects 名")
    resolve.add_argument("name")

    ls = content_sub.add_parser("ls", help="列工程文件：散文件加 scene.pkg 条目")
    ls.add_argument("project", help="工程（同 resolve 的写法，或任意目录）")
    ls.add_argument("prefix", nargs="?", help="只列相对路径以它开头的")
    ls.add_argument("--from", dest="sources", default="project,pkg", help="来源，逗号分隔：project、pkg；缺省两者")
    ls.add_argument("--out", help="列表写到这个 JSON 文件，stdout 只给摘要")

    cat = content_sub.add_parser("cat", help="取一个文件：散文件 → scene.pkg → WPE assets/")
    cat.add_argument("project", help="工程（同 resolve 的写法，或任意目录）")
    cat.add_argument("entry", help="相对路径（scene.pkg 条目名）")
    cat.add_argument("--from", dest="sources", default="project,pkg,assets",
                     help="只在这些来源里找，逗号分隔：project、pkg、assets；缺省三者按此顺序")
    cat.add_argument("--out", help="写到这个文件并打印摘要；不给就把原始字节写到 stdout")
    cat.add_argument("--overwrite", action="store_true")

    grep = content_sub.add_parser("grep", help="在工程文件里搜正则（跳过二进制）")
    grep.add_argument("pattern")
    grep.add_argument("projects", nargs="*", help="工程；不给就按 --source / --type / --pkg 枚举")
    filters(grep)
    grep.add_argument("--glob", action="append", help="只看相对路径匹配的（fnmatch，可重复），如 '*.json'")
    grep.add_argument("--from", dest="sources", default="project,pkg", help="来源：project、pkg；缺省两者")
    grep.add_argument("-i", "--ignore-case", action="store_true")
    grep.add_argument("--max", type=int, default=200, help="最多返回几条，缺省 200")
    grep.add_argument("--out", help="结果写到这个 JSON 文件，stdout 只给摘要")
    return parser


def main(argv=None):
    _register()
    from kbp import common  # noqa: E402

    args = _parser().parse_args(argv)
    try:
        if args.category == "gen":
            from kbp import gen

            summary = gen.cli(args)
        elif args.category == "rdc":
            from kbp import rdc_host

            summary = rdc_host.run(args.action, args)
        elif args.category in ("replay", "regress"):
            from kbp import replay_host

            summary = replay_host.cli(args)
        elif args.category == "snapshot":
            from kbp import snapshot

            summary = snapshot.cli(args)
        elif args.category == "content":
            from kbp import content

            summary = content.cli(args)
        else:
            raise common.KbpError("kbp", "未知的分类 %s" % args.category)
    except common.KbpError as e:
        sys.stderr.write(str(e) + "\n")
        common.emit({"ok": False, "error": str(e)})
        return 1
    except KeyboardInterrupt:
        sys.stderr.write("[kbp] 中断\n")
        return 130
    if summary is not None:
        common.emit(summary)
    return 0


if __name__ == "__main__":
    sys.exit(main())
