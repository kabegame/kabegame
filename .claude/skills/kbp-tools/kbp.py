"""kbp-tools 唯一入口（WPE 场景对比工具链）。用法与协议见同目录 SKILL.md。

    python -X utf8 -I .claude/skills/kbp-tools/kbp.py <分类> <动作> …

第 1 批实现：
- rdc track|frame|stats <抓帧目录> <标签> …：在 `qrenderdoc --python rdc/main.py` 里无界面读抓帧，写轨迹 / 整帧图 / 统计量；
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
                       help="按绘制原样保存（rdc_rope.py 的格式：vs_in、gs_out / vs_out、maxout、常量），P4d 工程用")
    track.add_argument("--limit", type=int, default=20000, help="--draws 时每次绘制最多读的顶点数，缺省 20000")

    frame = rdc_sub.add_parser("frame", help="整帧图：写 <data>/out/wpe-<标签>-f<脚本帧>.png 与 wpe-<标签>.json")
    rdc_common(frame)
    frame.add_argument("--out", help="输出目录，缺省 <data>/out")
    frame.add_argument("--event", type=int, help="取这个事件之后的渲染目标 0（缺省最后一次绘制之后）")
    frame.add_argument("--present", action="store_true", help="取 Present 时的后备缓冲；浮点格式存 DDS")

    stats = rdc_sub.add_parser("stats", help="粒子统计量：写 <data>/out/wpe-<标签>-stats.json")
    rdc_common(stats)
    stats.add_argument("--out", help="输出文件，缺省 <data>/out/wpe-<标签>-stats.json")

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
        if args.category == "rdc":
            from kbp import rdc_host

            summary = rdc_host.run(args.action, args)
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
