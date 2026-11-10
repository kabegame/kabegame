"""kbp-tools 唯一入口（WPE 场景对比工具链）。用法与协议见同目录 SKILL.md。

    python -X utf8 -I .claude/skills/kbp-tools/kbp.py <分类> <动作> …

已实现：
- gen <模块> [工程…]：按 <data>/defs/<模块>.py 的 PROJECTS 生成测试工程（第 2 批）；
- rdc track|frame|stats|shaders <抓帧目录> <标签> …：在 `qrenderdoc --python rdc/main.py` 里无界面读抓帧，写轨迹 / 整帧图 / 统计量 / 着色器清单；
- replay <案例…>|--all、regress --src A --src B：回放案例（node + vitest）、两份源码的回归（第 2 批）；
- snapshot export <rev|WORKTREE> <目录>、snapshot diff <基线> <副本>：产品源码快照与补丁（第 2 批）；
- content projects|resolve|ls|cat|grep …：WPE 语料与 scene.pkg 读取；
- corpus scan|diff：语料编译扫描与两次结果的比较，regress --corpus 用它（第 3 批）；
- mutate --spec <清单>：变异检查（快照模式按原字节还原，工作区模式反向替换）（第 3 批）；
- cmp track|frame|stats、corners offline：比真机结果与 WPE 真值、离线四角（第 3 批）；
- sample grab|series|read：PrintWindow 采样 MCP 开的测试窗口（第 3 批）。

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

    shaders = rdc_sub.add_parser("shaders", help="着色器清单：每次绘制的顶点 / 像素着色器、材质常量名、是否编译失败回退；"
                                                 "写 <data>/out/wpe-<标签>-shaders.json，反汇编存同名目录")
    rdc_common(shaders)
    shaders.add_argument("--out", help="输出文件，缺省 <data>/out/wpe-<标签>-shaders.json")

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
    regress.add_argument("--corpus", action="store_true", help="同时在两边各跑一遍语料扫描，逐场景比 unsupported 与附加字段")
    regress.add_argument("--extra", action="append", help="--corpus 的附加字段插件（同 corpus scan --extra，可重复）")
    regress.add_argument("--no-cases", action="store_true", help="只比语料（要和 --corpus 一起用）")
    src_data(regress)

    # ---------- corpus ----------
    corpus = top.add_parser("corpus", help="语料：跑编译管线记录 unsupported（scan）、比两次结果（diff）")
    corpus_sub = corpus.add_subparsers(dest="action", required=True)
    scan = corpus_sub.add_parser("scan", help="对默认工程与创意工坊工程跑 compileScene(exhaustive)，行 { sample, unsupported[], … }")
    scan.add_argument("--src", help="产品源码目录（快照的 src/），缺省 apps/wpe-scene/src")
    scan.add_argument("--out", required=True, help="结果文件（JSON）；vitest 日志写 <out>.log")
    scan.add_argument("--extra", action="append",
                      help="附加字段插件，可重复：modules:<category:name,…|@b3|@b4>、controlpoints[:norenderer]、sheets")
    scan.add_argument("--only", help="只跑这些场景（逗号分隔的目录名）")
    scan.add_argument("--project", action="append", help="另加的工程目录（排在语料之后，sample 是目录名），可重复")
    scan.add_argument("--overwrite", action="store_true")
    scan.add_argument("--timeout", type=float, default=3600)
    scan.add_argument("--quiet", action="store_true", help="不把 vitest 的输出转到 stderr")
    cdiff = corpus_sub.add_parser("diff", help="比两次语料结果：出错、干净场景增减、每个键增减了哪些场景、剩余键")
    cdiff.add_argument("before")
    cdiff.add_argument("after")
    cdiff.add_argument("--out", help="文字报告（另写 <out>.json）；不给就把行放进摘要的 text")
    cdiff.add_argument("--without", help="逗号分隔的键：之后的结果里带这些键的场景，去掉它们后还剩什么")
    cdiff.add_argument("--explain", help="解释脚本（.py，导出 explain(before, after, diff) -> [行]）")
    cdiff.add_argument("--overwrite", action="store_true")

    # ---------- cmp ----------
    cmpp = top.add_parser("cmp", help="比真机结果和 WPE 真值：轨迹（track）、整帧（frame）、统计量（stats）")
    cmp_sub = cmpp.add_subparsers(dest="action", required=True)
    ctrack = cmp_sub.add_parser("track", help="我们的轨迹（particle_track）对 WPE 轨迹：同帧同系统按顺序配对，报各字段最大差")
    ctrack.add_argument("ours")
    ctrack.add_argument("wpe", help="WPE 轨迹（tracks/rd-<标签>.json）")
    ctrack.add_argument("--skip", help="不比的系统（逗号分隔）")
    ctrack.add_argument("--out", help="文字报告（另写 <out>.json）；不给就把行放进摘要")
    ctrack.add_argument("--overwrite", action="store_true")
    cframe = cmp_sub.add_parser("frame", help="逐像素比两张 PNG：直方图、连通块、按对象归类、热图")
    cframe.add_argument("ours")
    cframe.add_argument("wpe")
    cframe.add_argument("--meta", help="测试工程的 kbp-meta.json：排除 FR / CLK，对象有 bbox 时按对象归类")
    cframe.add_argument("--kbp-layers", action="store_true", help="没有 meta 时也排除右下角 FR / CLK")
    cframe.add_argument("--crop", help="先裁我们的图：上,下,左,右（像素）")
    cframe.add_argument("--resize", action="store_true", help="按 cover 取中间一块再 BOX 缩到 WPE 的大小")
    cframe.add_argument("--threshold", type=int, default=32, help="连通块的阈值（缺省 32）")
    cframe.add_argument("--cell", type=int, default=32, help="连通块的格子边长（缺省 32 像素）")
    cframe.add_argument("--heat", help="热图 PNG（差异转灰度乘 --heat-gain）")
    cframe.add_argument("--heat-gain", type=int, default=8)
    cframe.add_argument("--zoom", help="局部放大 x,y,w,h（对齐后的图片坐标），配 --zoom-out")
    cframe.add_argument("--zoom-out", help="局部放大图 PNG（我们 | WPE 并排，放大 2 倍）")
    cframe.add_argument("--out", help="文字报告（另写 <out>.json）；不给就把行放进摘要")
    cframe.add_argument("--overwrite", action="store_true")
    cstats = cmp_sub.add_parser("stats", help="我们的粒子统计（real.json 样本）对 WPE 统计量（kbp rdc stats）")
    cstats.add_argument("ours", help="real.json（samples.<名字>.particles[]）或单个样本")
    cstats.add_argument("wpe", help="wpe-<标签>-stats.json")
    cstats.add_argument("--label", help="real.json 里的样本名（多个样本时必给）")
    cstats.add_argument("--out", help="文字报告（另写 <out>.json）；不给就把行放进摘要")
    cstats.add_argument("--overwrite", action="store_true")

    # ---------- corners ----------
    corners = top.add_parser("corners", help="离线四角：WPE 轨迹的顶点输入跑我们翻译的顶点 / 几何着色器（Deno WebGPU），比 gs_out")
    corners_sub = corners.add_subparsers(dest="action", required=True)
    coff = corners_sub.add_parser("offline", help="备料（vitest）+ 比较（Deno），写 <out>/corners.txt")
    coff.add_argument("tags", nargs="+", help="抓帧标签（轨迹 <data>/tracks/rd-<标签>.json）")
    coff.add_argument("--src", help="产品源码目录（快照的 src/），缺省 apps/wpe-scene/src")
    coff.add_argument("--data", help="数据目录，缺省 KBP_DATA，再缺省 ignore/p4")
    coff.add_argument("--project", help="工程（名字或目录），只能配一个标签；缺省取轨迹的 project")
    coff.add_argument("--out", help="输出目录，缺省 <data>/out/corners/<标签…>")
    coff.add_argument("--skip", help="不比的系统名（逗号分隔，如 c5 的两个 renderer 的 T8,T8r）")
    coff.add_argument("--expect-hidden", help="应该不画的系统（<标签或工程>/<系统>，逗号分隔）；给了时不画的必须在名单里")
    coff.add_argument("--limit", type=float, default=0.01, help="像素限值，缺省 0.01")
    coff.add_argument("--strict", action="store_true", help="有不符时退出码非 0（变异检查用）")
    coff.add_argument("--overwrite", action="store_true", help="输出目录里已有本工具的产物时先删（别的文件不碰）")
    coff.add_argument("--timeout", type=float, default=1800)
    coff.add_argument("--quiet", action="store_true")

    # ---------- mutate ----------
    mutate = top.add_parser("mutate", help="变异检查：逐处改坏产品源码 → 跑单测 / 案例 / 命令 → 还原并核对哈希")
    mutate.add_argument("ids", nargs="*", help="只跑这些 id（缺省全部）")
    mutate.add_argument("--spec", required=True, help="变异清单（.py 的 MUTATIONS / DEFAULTS，或 .json）")
    mutate.add_argument("--src", help="产品源码目录（快照的 src/），缺省 apps/wpe-scene/src")
    mutate.add_argument("--mode", choices=("snapshot", "workspace"), default="snapshot",
                        help="snapshot（缺省）：在 kbp 快照里改、按原字节写回；workspace：在工作区里改、反向替换还原")
    mutate.add_argument("--data", help="数据目录（案例、命令的 {data}），缺省 KBP_DATA，再缺省 ignore/p4")
    mutate.add_argument("--out", help="结果（文字，另写 .json），缺省 <spec 所在目录>/out/mutate.txt")
    mutate.add_argument("--overwrite", action="store_true")
    mutate.add_argument("--no-baseline", action="store_true", help="不先在没改的源码上跑一遍检出方")
    mutate.add_argument("--timeout", type=float, default=1800, help="每个检出方的超时（秒）")
    mutate.add_argument("--quiet", action="store_true", help="不把每处的结果转到 stderr")

    # ---------- sample ----------
    sample = top.add_parser("sample", help="PrintWindow 采样 MCP 开的测试窗口（只读：不开关窗口、不发 WPE 命令）")
    sample_sub = sample.add_subparsers(dest="action", required=True)
    sgrab = sample_sub.add_parser("grab", help="抓一帧客户区，存 PNG")
    sgrab.add_argument("title", help="窗口标题（open_wallpaper 的 kb-<进程号>-<序号>；先精确再唯一前缀）")
    sgrab.add_argument("--out", required=True, help="PNG 文件")
    sgrab.add_argument("--overwrite", action="store_true")
    sseries = sample_sub.add_parser("series", help="定时采样：网格点（--grid）或画面变了才存整帧（--changed-only）")
    sseries.add_argument("title")
    sseries.add_argument("--seconds", type=float, required=True)
    sseries.add_argument("--grid", help="步长,x0,y0（客户区像素；左上约 340×40 是 RenderDoc 叠加文字，起点要避开，如 20,10,50）")
    sseries.add_argument("--changed-only", action="store_true", help="CRC32 变了才存整帧，写 <out>/frames.bin 与 meta.json")
    sseries.add_argument("--interval", type=float, help="两次抓取之间睡多久（秒）；网格缺省不睡，整帧缺省 0.002")
    sseries.add_argument("--out", required=True, help="--grid：.bin 文件；--changed-only：目录")
    sseries.add_argument("--overwrite", action="store_true")
    sread = sample_sub.add_parser("read", help="解码采样结果（grid、frames、w1080 三种格式）")
    sread.add_argument("file", help=".bin 或 --changed-only 的目录")
    sread.add_argument("--fr", action="store_true", help="整帧：按测试工程的 FR 图层读帧号")
    sread.add_argument("--png", help="整帧：把帧存成 PNG 到这个目录（配 --frames 只存几张）")
    sread.add_argument("--frames", help="逗号分隔的帧序号（0 起）")
    sread.add_argument("--point", help="网格：取这个点（x,y，要在网格上）的逐样本 RGB")
    sread.add_argument("--limit", type=int, default=50, help="--point 最多返回几个样本")
    sread.add_argument("--out", help="逐帧明细写到这个 JSON")
    sread.add_argument("--overwrite", action="store_true")

    # ---------- snapshot ----------
    snapshot = top.add_parser("snapshot", help="产品源码快照（apps/wpe-scene/src）与补丁")
    snapshot_sub = snapshot.add_subparsers(dest="action", required=True)
    export = snapshot_sub.add_parser("export", help="导出 <rev> 或 WORKTREE 的 apps/wpe-scene/src 到 <目录>/src，写独立 tsconfig / vitest 配置并跑 tsc")
    export.add_argument("rev", help="提交（HEAD、哈希、分支…）或 WORKTREE（原样拷当前工作区）")
    export.add_argument("dir", help="快照目录（要在仓库里，模块解析沿目录向上找 node_modules）")
    export.add_argument("--overwrite", action="store_true", help="目录已存在且非空时先删（只删本工具写的快照）")
    export.add_argument("--no-tsc", action="store_true", help="不跑 tsc")
    export.add_argument("--vitest", action="store_true", help="另在快照里跑一遍产品 vitest，报文件数与用例数")
    export.add_argument("--wasm", help="翻译器 wasm 从这个文件拷（缺省：提交里没有时拷工作区的）；老提交要配当时的 wasm")
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
        elif args.category == "corpus":
            from kbp import corpus

            summary = corpus.cli(args)
        elif args.category == "cmp":
            from kbp import cmp

            summary = cmp.cli(args)
        elif args.category == "corners":
            from kbp import corners

            summary = corners.cli(args)
        elif args.category == "mutate":
            from kbp import mutate

            summary = mutate.cli(args)
        elif args.category == "sample":
            from kbp import sample

            summary = sample.cli(args)
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
