---
name: kbp-tools
description: WPE 场景对比工具链（kbp-tools）：测试工程协议（FR 帧号图层、CLK 时钟图层、[kbp] 日志、kbp-meta.json、轨迹 JSON）的唯一属主，以及一个入口 kbp.py 下的子命令：造确定性测试工程（kbp gen，生成库 from kbp import gen，收了 ignore/p4 的 gen.py、gen_b.py、gen_c.py 的通用部分）；从 WPE 的 RenderDoc 抓帧（.rdc）无界面提取粒子轨迹、整帧图、粒子统计量（kbp rdc track|frame|stats，替代 rdc_track_b.py、rdc_rope.py、rdc_track.py、wpe_rt.py、wpe_export.py、wpe_stats_b.py）；在 Node 里用产品源码按 WPE 时间线回放粒子并逐粒子比（kbp replay，案例表 <data>/cases/，替代各步拷来拷去的 replay.test.ts）；全部案例在两份源码上跑并逐字节比较（kbp regress，替代 run_old.sh + cmp_old.py）；产品源码快照与补丁（kbp snapshot export|diff，替代手搭的 c1/ov、c5/head）；读 WPE 语料与 scene.pkg（kbp content，替代 scan_misc_lib.py、pkg_extract.py）。凡是要新做一个 P4 / P5 的对照步骤、生成测试工程、从抓帧取 WPE 真值、回放对照、改模拟器前后做回归、在并行会话之外冻结产品源码时都用它。抓帧本身用 wpe-renderdoc MCP，驱动 Kabegame 用 kabegame-dev MCP。
---

# kbp-tools

WPE 场景对比的中间一层：认识我们的测试工程约定、把 WPE 与 Kabegame 两边的数据对上。两头由 MCP 负责：
`wpe-renderdoc` 拿 WPE 的真值（开窗、抓帧、日志、交互式回放），`kabegame-dev` 驱动 Kabegame（渲染、粒子回放、四角、哈希）。
计划见 `.claude/plans/tools/kbp-tools.md`。

**本 skill 是测试工程协议的唯一属主**：帧号图层、时钟图层、`[kbp]` 日志、`kbp-meta.json`、轨迹 JSON 的格式以本文件为准。
两个 MCP 不认识这些约定，唯一的例外是 `kabegame-dev` 的 `apps/kabegame-dev-mcp/src/timeline.ts`（按 `[kbp]` 日志与轨迹组时间线），
本 skill 不另做一份。

> 已有：`gen`、`rdc`、`replay`、`regress`、`snapshot`、`content`（第 1、2 批）。`corpus`、`mutate`、`cmp`、`corners`、`sample`
> 在第 3 批，届时补进本文件；在那之前照旧用 `ignore/p4/` 里的脚本。`ignore/` 里现有的生成器与回放脚本不迁、照旧能跑，新步骤用本工具。

## 用法与输出约定

```bash
python -X utf8 -I .claude/skills/kbp-tools/kbp.py <分类> <动作> …
```

- stdout 只有一行 JSON 摘要（`ok`、产物路径、要点），细节写文件。`content cat` 不给 `--out` 时例外：原始字节写 stdout。
- 失败：退出码非 0，stderr 一行错误、stdout 一行 `{"ok": false, "error": …}`；错误以层开头：
  `[data]`（输入数据、工程、抓帧不符合约定，输出已存在）、`[renderdoc]`（qrenderdoc 起不来、超时、服务层报错）、
  `[wpe]`（WPE 目录不对）、`[src]`（产品源码不对、案例跑不下去）、`[node]`（node / vitest 起不来、超时）、`[kbp]`（参数）。
- 已有的输出（工程、轨迹、报告、快照）缺省拒绝覆盖，要覆盖加 `--overwrite`。
- 只用 `python -X utf8 -I`，不要 `python -c`。脚本里要用库时：把 `.claude/skills/kbp-tools` 放进 `sys.path`，再
  `from kbp import content`（`kbp.py` 本身充当包 `kbp`，`__path__` 指向 `py/`）。

### 路径与环境变量

| 变量 | 缺省 | 用途 |
|---|---|---|
| `--data` → `KBP_DATA` | `ignore/p4` | 数据目录：`proj/`（工程）、`tracks/`（轨迹）、`out/`（日志、整帧图、统计量） |
| `KABEGAME_WPE_ROOT` | `D:\Applications\Steam\steamapps\common\wallpaper_engine` | WPE 安装目录；创意工坊是 `<WPE>\..\..\workshop\content\431960` |
| `RENDERDOC_DIR` | `C:\Program Files\RenderDoc` | `qrenderdoc.exe` 所在目录 |
| `--src` | `apps/wpe-scene/src` | 产品源码（回放、回归用）；并行会话在改产品代码时指向快照的 `src/` |

抓帧照旧在 `A:\<项目>\<用途>\`（wpe-renderdoc MCP 的约定），文件名 `<标签>-frame<RenderDoc 帧号>.rdc`。

## 命令

### `kbp gen` — 造工程

```bash
kbp.py gen <模块> [工程…] [--data 目录] [--defs 目录] [--out 目录] [--overwrite] [--list]
```

- 实验定义是数据：`<data>/defs/<模块>.py`（`--defs` 换目录），里面有 `PROJECTS = {工程名: 无参函数}`；不给工程名就全部生成。
- 生成到 `<data>/proj/<工程>`（`--out` 换目录）；工程已存在时拒绝，`--overwrite` 先删再写。实验定义的 `print` 转到 stderr。
- 同目录的实验定义可以互相 import（`kbp gen` 把 `--defs` 目录放进 `sys.path`）。
- **库**（`py/gen.py`，`from kbp import gen`）：从 `gen.py`、`gen_b.py`、`gen_c.py` 抽出的通用部分，名字和签名照旧，现有生成器只改
  import 行就能用：`import gen` → `from kbp import gen`，`import gen_b` → `from kbp import gen as gen_b`，`import gen_c` →
  `from kbp import gen as gen_c`。
  - 写文件：`write`、`write_json`（制表符缩进、不转义中文、LF、末尾不加换行）；
  - 固定图层：`FR_COLOR`、`CLK_VERT` / `CLK_FRAG`、`CLK_PTR_VERT`、`layer`；
  - 模块与系统：`fixed`、`move`、`FADE`、`OSC_ALPHA`、`CAP`、`OSC_POS`、`numbered`、`system`（gen_b 版：operator 从 id 20、renderer
    id 40）、`particle_object`、`material`、`particle_material`、`image_layer`、`image_assets`、`GENERAL`、`TEX_FLAGS` / `TEX_IMAGE_W` /
    `TEX_IMAGE_H`；gen.py 那个 P4-0 专用的 `system`（operator 从 id 10）不在库里；
  - P4c 起：`at`、`ring`、`with_cps`、`CENTER`、`MOVE_ORIGIN`、`SPIN_ANGLES`（脚本里图层的 `angles` 是度，scene.json 里静态的是弧度）；
  - `write_project(name, title, systems, *, images, materials, ident, overrides, files, order, patches, version=3, properties, meta,
    object_meta, pointer=True, track=None)`：gen_b 与 gen_c 的合并版。`pointer=True`（缺省）CLK 用带指针的 CLK_PTR（gen_c 起），
    `False` 是 gen_b 的 CLK；`meta` 并入 kbp-meta.json 顶层，`object_meta` 并入单个对象；`track` 只在显式给出时写进 kbp-meta.json；
  - 路径：`HERE`（= 数据目录；旧写法 `os.path.join(gen.HERE, 'proj', 名字)` 照旧落在 `<data>/proj`，但不认 `--out`）、`MODELS`（随库的
    `assets/models`，两行版 `solidlayer.json`）、`ASSETS`（`<KABEGAME_WPE_ROOT>/assets`）、`SHIMMER`（默认工程 shimmering_particles 的
    shaders）、`TEXSRC`（`<data>/texsrc`，从创意工坊导出的纹理不入库）；
  - 直接在脚本里用库时可以先 `gen.configure(data=…, out=…, overwrite=…)`。
- 新步骤的实验定义写法：

```python
# <data>/defs/p5x.py
from kbp import gen


def p5x_demo():
    spec = gen.system("255 0 0", None, emitter=gen.ring(controlpoint=1), lifetime=4, maxcount=4, size=16)
    gen.write_project("p5x-demo", "kbp5x-demo", {"demo": spec}, overrides={"demo": gen.at(gen.CENTER)})


PROJECTS = {"p5x-demo": p5x_demo}
```

### `kbp rdc` — 从抓帧取真值

```bash
kbp.py rdc track <抓帧目录> <标签> [工程] [--draws | --points] [--limit N] [--out 文件] [--data 目录]
kbp.py rdc frame <抓帧目录> <标签> [--event N | --present] [--out 目录] [--data 目录]
kbp.py rdc stats <抓帧目录> <标签> [--out 文件] [--data 目录]
# 公共：--overwrite（输出已存在时覆盖，缺省拒绝）、--timeout 秒（缺省 1800）、--quiet、--keep-work
```

| 动作 | 写什么（缺省位置） | 替代 |
|---|---|---|
| `track` | `<data>/tracks/rd-<标签>.json` | `rdc_track_b.py`、`rdc_rope.py`（`--draws`）、`rdc_track.py`（无 meta 时自动退回） |
| `frame` | `<data>/out/wpe-<标签>-f<脚本帧>.png`，索引 `wpe-<标签>.json` | `step4/wpe_rt.py`；`--present` 为 `p3b/compare/wpe_export.py` |
| `stats` | `<data>/out/wpe-<标签>-stats.json` | `b3/wpe_stats_b.py` |

- 一次启动处理目录里全部 `.rdc`（按帧号排序）。
- **`track` 的工程**：
  - 给了现有目录就直接用；给名字查 `<data>/proj/<名字>`；
  - 不给时从标签的 `<工程>-fps<N>…` 推（`p4c-cp-fps60` → `p4c-cp`），老标签（`fps60`）要显式给 `p4-0`。
- **`track` 的认法**按工程自动选，摘要里的 `mode` 报出来，`mode_source` 说明从哪来（`flag` 命令行、`meta`、`auto`）：
  - `kbp-meta.json` 有 `track: "draws"`（生成库的 `write_project(…, track="draws")` 写）是 `draws`；
  - 否则有 `kbp-meta.json` 是 `points`，没有 meta 的老工程（`p4-0`、`p4a*`）是 `legacy`；
  - 命令行优先：`--draws` 强制按绘制（`gen_d.py` 生成的老 `p4d-*` 工程没有 `track`，仍要显式加），`--points` 强制按粒子。
- **`frame` 的取法**：
  - 缺省取最后一次绘制之后的渲染目标 0；
  - `--event N` 取各抓帧同一个事件号之后的；
  - `--present` 取 Present 时的后备缓冲，浮点格式存 DDS（原始数据），LDR 存 PNG。
  - 文件名一律按脚本帧号（= RenderDoc 帧号 + 1）。
- **`stats`** 按顶点布局认粒子绘制，不依赖测试工程，创意工坊场景也能用。
- 摘要里的 `seconds`：`startup` 是拉起 qrenderdoc 到就绪，`captures` 是每张抓帧，`total` 是到进程退出。
  - 本机实测（RenderDoc 1.47）：启动 2.3–3.2 s；
  - `track` 测试工程每张 0.6–1.2 s，绳（`--draws`）每张 1.5–2 s；
  - `frame` 1080p 每张 0.8–1.8 s，4K `--present` 每张 1.2–2.1 s；`stats` 每张 0.8–1.1 s。

### `kbp replay` — 回放案例

```bash
kbp.py replay <案例…> | --all [--src 产品源码] [--data 目录] [--out 目录] [--overwrite] [--timeout 秒] [--quiet]
```

- 案例是 `<data>/cases/<名字>.json`，钩子 `<名字>.hook.ts`（见「回放案例」）。kbp.py 拉起一次
  `node node_modules/vitest/vitest.mjs run --config .claude/skills/kbp-tools/ts/vitest.config.ts`（`root` 由配置文件位置推出），
  每个案例一个 `it`，参数经 `KBP_SRC`、`KBP_DATA`、`KBP_OUT`、`KBP_CASES`。
- 报告写 `<out>/<名字>.txt`、`.json`（缺省 `<data>/out/replay/`），**不含路径与耗时**，两份源码上跑出的报告可以逐字节比较；
  `<名字>.meta.json` 记源码、耗时、错误；vitest 的输出在 `<out>/replay-vitest.log`。
- 摘要：`cases`（每个案例的 `ok`、`seconds`）、`all_passed`。案例「有失败」是结果，退出码仍是 0；案例跑不下去（钩子或产品接口出错）
  报 `[src]`，退出码非 0。
- 现有案例（`ignore/p4/cases/`）：`b3`（P4a 的 9 个标签、`p4b` 模块、`p4b-emit`）、`b4`（噪声）、`b6`（三组 `colorn`）、`c1`（`p4c-cp`）、
  `c2`（`p4c-ptr`）、`c3`（`p4c-attract`，`a-default` 的已知超限照原脚本记失败）、`c4`（`p4c-world`，`p4c-ptr` 加 `p-world`）、`d1`（绳）。
  2026-11-10 在同一份冻结快照上和原脚本（`c5/` 下的最新拷贝、`d1/replay.test.ts`）逐系统逐项比过，数值逐位相同。
- 本机耗时（同一进程里，不含 vitest 启动约 1.5 s）：`b3` 约 16 s、`b4` 约 17 s、`c4` 约 5 s、`d1` 约 4 s、`c2` 约 3 s，其余 1 s 左右。

### `kbp regress` — 两份源码的回归

```bash
kbp.py regress --src A --src B [--cases a,b] [--data 目录] [--out 目录] [--overwrite] [--serial] [--quiet]
```

- 全部案例（或 `--cases`）在 A、B 上各跑一遍（缺省两个 node 并行，`--serial` 依次），报告在 `<out>/a/`、`<out>/b/`
  （缺省 `<data>/out/regress/`）。
- 逐字节比较每个案例的 `.txt`、`.json`，列出不同的文件和第一处不同（行、列、两边那一行）；同时核对两边各自是否全部通过、有没有跑不下去的。
- 结果：`<out>/regress.txt`（给人看）、`regress.json`；摘要里 `same`、`differ`、`all_passed`、`crashed`。全部案例两边并行约 50 s。
- 语料扫描在第 3 批（`--corpus` 留了接口，现在报 `[kbp]`）。

### `kbp snapshot` — 产品源码快照与补丁

```bash
kbp.py snapshot export <rev | WORKTREE> <目录> [--overwrite] [--no-tsc] [--vitest]
kbp.py snapshot diff <基线目录> <副本目录> --out x.patch [--overwrite]
```

- `export <rev>`：`git archive` 导出该提交的 `apps/wpe-scene/src` 到 `<目录>/src`（只读，不碰索引与工作区），拷入未入库的翻译器 wasm
  （工作区的 `apps/wpe-scene/src/wpesl2wgsl/wpesl2wgsl.wasm`）。`WORKTREE` 原样拷当前工作区的 `apps/wpe-scene/src`（含未入库的文件），
  用来冻结并行会话正在改的代码。
- 另写 `<目录>/tsconfig.json`（extends 仓库根的，`types` 照 `apps/wpe-scene/tsconfig.json` 再加 `node`）、`vitest.config.ts`（root
  是快照目录，跑 `src/**/*.test.ts`）、`snapshot.json`（来源、文件数、wasm 哈希、tsc 结果）；导出后跑一次 tsc（`tsc.log`），`--vitest`
  另跑产品测试并报文件数、用例数（`vitest.json`、`vitest.log`）。
- 目录要在仓库里（tsc / vitest 沿目录向上找 `node_modules`），惯例放 `ignore/<步骤>/`；`--overwrite` 只删带 `snapshot.json` 的目录。
- `diff`：两边 `src/` 逐文件比，写成 git 格式的补丁，路径是 `apps/wpe-scene/src/…`，可以 `git apply --check`、`git apply --3way` 直接
  打进仓库；只收文本，二进制文件（如 wasm）不同时报错。
- 2026-11-10 实测（HEAD 95715c09）：tsc 0 error，vitest 50 个文件、1207 个用例（1163 过、44 跳过）；导出约 2 s，tsc 约 8 s，vitest 约 9 s。

### `kbp content` — 语料与 scene.pkg

```bash
kbp.py content projects [--source default,workshop,my] [--type scene] [--pkg | --no-pkg] [--out 文件]
kbp.py content resolve <工程>
kbp.py content ls <工程> [前缀] [--from project,pkg] [--out 文件]
kbp.py content cat <工程> <相对路径> [--from project,pkg,assets] [--out 文件 [--overwrite]]
kbp.py content grep <正则> [工程…] [--source …] [--type …] [--pkg] [--glob '*.json']… [--from project,pkg] [-i] [--max N] [--out 文件]
```

- **工程的写法**同 wpe-renderdoc：
  - 工程目录或 `project.json`；
  - 创意工坊 ID、默认工程名、`myprojects` 里的名字；
  - `ls` / `cat` / `grep` 另收任意目录（如 `ignore/p4/proj/p4c-cp`）。
- **`projects`**：
  - 按来源顺序、来源内按 `os.listdir` 顺序，不另排序；
  - `--type` 比 `project.json` 的 `type`，不分大小写；
  - 旧 `scan_misc_lib.projects()` 等于 `--source default` 加上 `--source workshop --pkg`。
- **`cat`、`read` 的查找顺序**同 Kabegame 编译管线（`apps/wpe-scene/src/compile/fs.ts`）：
  - 散文件 → `scene.pkg` → WPE `assets/`；
  - `--from pkg` 只取包内条目；
  - 同名条目先出现的算。
- **`grep`** 跳过开头 8 KiB 有 NUL 的二进制文件，最多返回 `--max` 条，摘要里 `truncated` 标出是否截断。
- **库**（`from kbp import content`）：
  - `projects(source, type, pkg)`、`resolve(名字)`、`project_dir(名字)`；
  - `read_pkg(路径)` → `Pkg`（`version`、`entries`、`base`、`by_name`、`read(名字)`）；
  - `files(工程)`、`locate(工程, 相对路径)`、`read(工程, 相对路径)` → `(字节, 位置)`；
  - `scene_files(工程)`（`scan_misc_lib` 的原样版本，迁移旧脚本用）、`grep(…)`。

## 协议

### 数据目录（`KBP_DATA`）

| 子目录 | 内容 |
|---|---|
| `proj/<工程>/` | 生成的测试工程（`scene.json`、`project.json`、`particles/`、`materials/`、`shaders/`、`models/`、`kbp-meta.json`） |
| `tracks/rd-<标签>.json` | 从抓帧提取的轨迹（`kbp rdc track`） |
| `out/<标签>-log.txt` | WPE `log.txt` 里截出的 `[kbp]` 行（wpe-renderdoc MCP 的 `capture_sweep(log_dir=…)` 写） |
| `cases/<名字>.json`、`cases/<名字>.hook.ts` | 回放案例与钩子（`kbp replay`、`kbp regress`） |
| `defs/<模块>.py` | 实验定义（`kbp gen`） |
| `texsrc/` | 从创意工坊导出的纹理（生成库的 `TEXSRC`，不入库） |
| `out/wpe-<标签>-f<帧>.png`、`out/wpe-<标签>-stats.json` | 整帧图、统计量 |

标签的约定是 `<工程>-fps<N>[-<宽>x<高>]`。时间线从 `fps<N>` 推 operator 遍数：N 在 1–20 时两遍，否则一遍。

### 测试工程的固定图层

每个测试工程的 `scene.json` 前两个对象固定是 FR、CLK，都放在右下角，左上会被 RenderDoc 的叠加文字盖住。
抓帧里前两个绘制就是它们，提取器按位置取，不认名字。

| 对象 | id | 位置 / 尺寸（场景 1920×1080，y 向上） | 内容 |
|---|---|---|---|
| `FR` | 1 | `1820 40 0` / `80 60` | `models/util/solidlayer.json` + 颜色脚本：帧号进颜色 |
| `CLK` | 2 | `1700 40 0` / `80 60` | `models/kbp_clk.json` → 材质 `kbp_clk`，项目着色器 `shaders/kbp_clk.vert/.frag` |

- **FR（帧号）**：颜色脚本的 `update` 每帧 `frame++`（第一帧是 1），写进颜色：
  - `x = (frame % 256) / 255`；
  - `y = floor(frame / 256) % 256 / 255`；
  - `z = 1`。
  - 读回：FR 绘制的像素着色器常量 `g_Color`，帧号 = `round(r·255) + round(g·255)·256`。
  - 这是 WPE 脚本帧号，等于抓帧的 RenderDoc 帧号 + 1。
- **CLK（时钟）**：顶点着色器让 `g_Time`、`g_Frametime` 真的参与输出。
  - 原因：着色器没读的常量 `referenced: false`，值是缓冲里的垃圾，不能当数据，提取器遇到就报错。
  - **CLK_PTR**（P4c 起，`gen_c.py`）同一个着色器另读 `g_PointerPosition`、`g_PointerPositionLast`，轨迹里多出 `pointer` / `pointer_last`。
  - 读回：CLK 绘制的顶点着色器常量。
- `models/util/solidlayer.json` 是我们自己写的两行（只有 `material`），和 WPE 自带的那份不同（后者另有 `"solidlayer": true`）。
- 对象 id：图像层 `10 + i`，粒子对象 `100 + i`（`gen_b.py` 起；`p4-0` 是 `10 + i`）。
- 场景 `general`：
  - 正交 1920×1080，`hdr` / `bloom` 关，黑底清屏；
  - `version` 缺省 3，可另给，`None` 时不写这个键。

### `[kbp]` 日志

- **写**：FR 的脚本每帧记一条 `帧号,帧时间,累计时间`。
  - 帧时间是 `engine.frametime.toFixed(6)`，累计时间是 `engine.runtime.toFixed(6)`；
  - 每 50 条用 `console.error('[kbp] ' + 条目.join(' '))` 写进 WPE 的 `log.txt`（`console.log` 不写文件）。
  - 日志行形如 `…: Error: [kbp] 1,0.000376,0.000376 2,0.031870,0.032246 …`。
- fps 低时尾巴不满 50 条，最后几帧不在日志里。
- **读**的规则：
  - 只认 `[kbp]` 之后的条目；
  - 两列必须都是 6 位小数（少了多半是行被截断）；
  - 帧号递增不重复（同一个文件里有两次运行就报错，截出一次的）。

### `kbp-meta.json`（P4b 起，生成库的 `write_project` 写，提取器读）

```json
{
  "order": ["sizechange", "colorchange", "…"],
  "objects": {
    "sizechange": { "kind": "particle", "ident": "color", "rgb": [1.0, 0.0, 0.0] },
    "colorchange": { "kind": "particle", "ident": "order", "rgb": null },
    "bg": { "kind": "image" },
    "T8": { "kind": "particle", "ident": "color", "rgb": [0.0, 0.5, 1.0], "draws": 2 }
  },
  "corners": true
}
```

- `order`：FR、CLK 之后的对象顺序（= `scene.json` 顺序 = 绘制顺序）。
- `kind`：`image`（每帧画一次，没有粒子）或 `particle`。
- `ident`：系统怎么认。
  - `color`：按 `rgb` 认，即 `colorrandom` 的 min，0–1；
  - `order`：颜色会变或没有 `colorrandom` 的系统，按绘制顺序认。
- `draws`：一个系统有多个 renderer 时每帧连着画几次，缺省 1。
- `corners`（顶层）：为 true 时提取四角。
- `track`（顶层，可选）：`"draws"` 时 `kbp rdc track` 自动按绘制原样保存（绳与 P4d 模块工程），`"points"` 按粒子；只在
  `write_project(…, track=…)` 显式给出时写，不给时文件和旧生成器的逐字节相同。
- 计划中（第 3 批，和整帧比较一起）：每个对象加 `bbox`（场景包围盒），给 `cmp frame` 按对象归类像素差；旧工程没有时只报整帧。

### 轨迹 JSON（`tracks/rd-<标签>.json`）

Python `json.dump` 写，`ensure_ascii=False`、LF、不缩进；可能含 `NaN` / `Infinity`（如 `rd-p4c-sprite-fps60.json` 的四角），
读的一方要容忍（`timeline.ts` 的 `parseTrackJson` 先换成 null）。

```json
{
  "source": "renderdoc", "project": "p4c-cp", "tag": "p4c-cp-fps60",
  "frames": [
    {
      "frame": 924, "rdc_frame": 923, "time": 15.410229, "dt": 0.01709,
      "systems": { "cp-angles": [{ "pos": [x, y, z], "size": 20.0, "color": [r, g, b], "alpha": 1.0, "rot": [rx, ry, rz] }] },
      "pointer": [px, py], "pointer_last": [px, py],
      "corners": { "S1-0": { "stage": "gs_out", "rows": [[[u, v], [x, y, z, w]], "…"] } }
    }
  ]
}
```

- **帧级字段**：
  - `frame`：FR 帧号（WPE 脚本帧）；`rdc_frame`：文件名里的 RenderDoc 帧号；
  - `time` / `dt`：CLK 的 `g_Time` / `g_Frametime`，float32 原值；
  - `pointer` / `pointer_last`：只有 CLK_PTR 工程有，是 `g_PointerPosition` / `g_PointerPositionLast` 的前两个分量，原值。
- **points 认法**（有 `kbp-meta.json`）：`systems` 是 `{名字: [每粒子一条]}`，每条从 `vs_in` 折出。
  - 几何着色器路径（`PointList`）：每粒子 1 个顶点；
    - `size = TEXCOORD.w`，`rot = TEXCOORD.xyz`；
    - 厚格式（THICKFORMAT）没有 `TEXCOORD`，用 `TEXCOORD0`，另有 `TEXCOORD1`（速度与 frame 原值）。
  - 顶点展开路径（`TriangleList`）：每粒子 6 个索引取第一个；
    - `size = TEXCOORD0.w`，`rot = [TEXCOORD2.x, TEXCOORD2.y, TEXCOORD0.z]`。
  - `pos = POSITION`，`color = COLOR.rgb`，`alpha = COLOR.a`。
  - 其余顶点列原样保存，列名照 RenderDoc，如厚格式的 `TEXCOORD1`；同名列第二个起是 `名字#2`。
  - **认系统**：
    - 按 `order` 走游标；图像层的绘制让游标跳过下一个 `image`；
    - 粒子绘制先在游标之后的 `ident: color` 系统里按首个粒子的颜色找，L1 距离 ≤ 0.03；
    - 找不到取游标之后第一个 `ident: order` 的系统；
    - 某帧没有存活粒子时那次绘制为空，跳过。
  - **`名字#2`**：系统 `draws: n` 时，紧跟着的第 2…n 次粒子绘制记成 `名字#2`…`名字#n`。
  - **`corners`**（meta 有 `corners: true`）：`{名字: {stage, rows} | null}`。
    - 先读 `gs_out`，没有再读 `vs_out`；
    - 前 48 个顶点的 `[UV, 裁剪空间 xyzw]`，UV 取 `TEXCOORD0`（没有取 `TEXCOORD`）。
- **draws 认法**（`--draws`，`gen_d.py` 的 P4d 工程）：`systems` 是 `{名字: 绘制}`，绘制原样保存：
  - `event`、`topology`、`vs_count`；
  - `vs_in`：列名 → 每顶点的值，绳是每段一个点；
  - `consts`：`{vertex: {…}, geometry: {…}}`，只收被读到的常量（`g_RenderVar0`、`g_Orientation*` 等）；
  - `maxout`：几何着色器的 `dcl_maxout`（绳是 `4 + 2·subdivision`）；
  - `gs_out` 或 `vs_out`：`{topology, count, columns}`；
  - 每次最多读 `--limit` 个顶点，缺省 20000。
  - 认系统：
    - 按 `vs_in` 首行 `COLOR*` 在游标之后的 `ident: color` 系统里找；
    - 找不到时，若上一个系统还没画满 `draws` 次，记成它的 `#n`；
    - 否则取下一个 `ident: order`。
- **legacy 认法**（无 meta 的 `p4-0`、`p4a*`）：
  - 颜色表从 `scene.json` 与 `particles/*.json` 的 `colorrandom.min` 读；
  - 每行只有 `pos`、`size`、`color`、`alpha`、`rot`，没有其余顶点列，也没有 `pointer`；
  - 帧里总有 `corners`：只给 `linear` / `custom` / `rot-gs` / `rot-vs`，形如 `{"u,v": [裁剪 x, 裁剪 y]}`（两条路径角点顺序不同，按 UV 配对）。

### 整帧图与统计量

- `wpe-<标签>.json`（`frame` 的索引，indent 1）：每行 `{rdc, frame, event, target, png, result}`，`result` 是 `save_texture` 的回应。
  - `--present` 的行另有 `file`（代替 `png`）、`present`、`texture`。
- `wpe-<标签>-stats.json`（indent 1）：每帧 `{rdc, time, draws: [...]}`。
  - `time`：第一个读了 `g_Time` 的绘制的值，都没读为 null；
  - 每次粒子绘制一项：`{count, x, y, z, size, alpha, rgb: [[min, max]×3], event, path: "gs"|"vs", blend}`，`x` / `y` / `z` / `size` / `alpha` 都是 `[min, max]`。

### 时间线（实现在 `apps/kabegame-dev-mcp/src/timeline.ts`）

回放要的逐帧 `dt`、`g_Time`、光标由日志加轨迹组出。规则摘要，细节和例外以源码注释为准：

- 第 f 帧的 dt = 日志第 f 帧累计时间 − 第 f − 1 帧的（第 1 帧就是它自己的），舍入到 6 位小数；不用帧时间列。
- 抓到的帧（轨迹里有的）：dt 与 `g_Time` 换成轨迹的 float32 原值。
- 日志与轨迹都没有的帧：
  - 缺省报错；
  - `gap: "split"` 时按「后一个已知帧的 g_Time − 它的 dt」减「前一帧的 g_Time」平分，后面没有已知帧时仍报错。
- 光标：`cursors: "track"` 时抓到的帧取轨迹 `pointer`，其余取 `cursor`（缺省 `[0.5, 0.5]`）；也可直接给整串。
- 遍数：标签里 `fps<N>` 的 N 在 1–20 时两遍。

## 回放案例（`<data>/cases/<名字>.json`）

```json
{
  "name": "c4",
  "description": "…",
  "passes": 1,
  "inputs": { "cursors": "track", "time": "none" },
  "envelope": { "approx": true },
  "compare": { "historyUnborn": "pool" },
  "unsupported": { "expect": [] },
  "runs": [
    {
      "label": "新顺序", "project": "p4c-world", "tags": ["p4c-world-fps60"], "inputs": { "world": "hook" },
      "options": { "variant": "prev" }, "systems": { "only": ["w-stay-w", "…"], "skip": ["w-ptr-w", "w-ptr-l"] }
    },
    {
      "project": "p4c-ptr", "tags": ["p4c-ptr-fps60", "p4c-ptr-fps60-1920x800"], "inputs": { "world": "static" },
      "compare": { "windowOnly": ["p-loc", "…"] }
    }
  ]
}
```

- 顶层是缺省值，`runs` 逐项覆盖（`inputs`、`systems`、`compare`、`envelope`、`limits`、`unsupported`、`options` 浅合并）；没有 `runs`
  时顶层就是唯一的一组。每组的每个标签是报告里的一段。
- 字段（除 `name`、`tags` 外都可选）：

| 字段 | 含义 |
|---|---|
| `name` | 案例名，等于文件名，也是报告文件名 |
| `description` | 一句说明（写进报告第一行） |
| `label` | 段名前缀（缺省就是标签） |
| `project` | `<data>/proj/<project>`；缺省取轨迹的 `project`，再缺省从 `<工程>-fps<N>` 推 |
| `tags` | 抓帧标签：轨迹 `tracks/rd-<标签>.json`，日志 `out/<标签>-log.txt`；标签末尾 `-宽x高` 是抓帧窗口尺寸 |
| `passes` / `fps` | operator 遍数（缺省按标签的 fps 推）；绳的 `writeRopeSegments` 读的 fps（缺省标签里的） |
| `mode` | `position`（缺省，逐粒子 pos / size / color / alpha / rot）、`color`（b6：逐粒子 rgb，按线段拟合）、`rope`（d1：绳的段顶点，轨迹是 draws 认法） |
| `systems` | `only`（只比这些，按这个顺序）、`skip`、`skipPattern`（正则）、`source`（`first` 轨迹第一帧 / `union` 全部帧，缺省）、`informational`（照比照报，不算进是否全部通过） |
| `inputs.world` | 控制点输入的对象世界矩阵：`none`（缺省，不传控制点输入，P4b 及以前）、`static`（编译期变换）、`hook`（钩子的 `world`） |
| `inputs.cursors` | 跟随点：`none`、`zero`（pointer `[0, 0]`，c1）、`track`（轨迹指针，窗口之前取窗口第一帧的；窗口比例和场景不同时按 `fill` 反算） |
| `inputs.time` | 传给 `step` 的场景时间：`none`（不传，模拟器自己累加）、`cur`（本帧 g_Time）、`prev`（上一帧的，第 1 帧为 0） |
| `inputs.changes` | 运行中改属性的文件（相对数据目录，`{tag}` 换成标签），`[{ frame, properties }]`（b6） |
| `gap` | 日志与轨迹都缺的帧：`error`（缺省）或 `split`（平分，timeline.ts 的规则） |
| `envelope` | `approx: true` 近似运算包络（`rcp` / `rsqrt` 乘 1 ± 3.7e-4，四种组合）；`input: N` 输入精度包络（日志来的 dt、T 加 ±5e-7 扰动跑 N 遍，b4） |
| `limits` | 覆盖缺省限值：`pos` 1e-3、`posFar` 2e-3（坐标过 `farCoord` 1000）、`size` 1e-3、`color` / `alpha` 2e-3、`rot` 1e-3、`tl` / `tp` 1e-4（绳）；color 模式的限值是 `color` |
| `compare` | `history`（坐标分档用粒子出生以来的最大坐标，缺省 true；P4a 段为 false）、`historyUnborn`（预热出生、没有出生序号的粒子：`ignore` 查不到，b3–c2 的写法；`pool` 合成一份，c3 起）、`windowOnly`（这些系统只比出生帧 ≥ 第一个抓帧的粒子）、`requireParticles`（通过要求比过至少一个粒子，缺省 true；c3 为 false） |
| `unsupported` | 编译的不支持项：`expect`（精确相等，缺省 `[]`）、`allow`（正则，只许出现匹配的）、`report`（只报不判） |
| `options` | 给钩子的自由参数 |
| `hook` | 钩子模块（相对 `cases/`），缺省 `<名字>.hook.ts` 存在就用 |

- 标准流程（每段）：编译工程 → 时间线（`apps/kabegame-dev-mcp/src/timeline.ts`，抓到的帧 dt / g_Time 取轨迹的 float32 原值）→ 钩子
  `timeline` → 跟随点、世界矩阵 → 模拟（第 i 个粒子层种子 `1 + i`、加载时预热、按 dt 步进）加包络 → 逐系统比较 → 钩子 `after`。
  限值 = 基础限值 + 包络（逐粒子逐分量取 |包络模拟 − 精确|）；每个系统报最大差、包络、差 / 限、超限个数、粒子数是否逐帧相同、是否通过。

### 钩子（`<名字>.hook.ts`）

个案逻辑（定符号、注入 R、反推缺帧 dt、脚本驱动的对象、额外核对）放钩子，从原脚本搬，不硬塞进通用参数。钩子导出这些函数（都可选），
`ctx` 是 `CaseContext`、`sec` 是 `Section`（`ts/replayLib.ts`）：

| 导出 | 时机与用途 |
|---|---|
| `timeline(ctx, sec)` | 准备阶段：直接改 `sec.dts`、`sec.times`、`sec.sources`（b4 用定好的拆分、d1 用 R9 反推缺帧的 dt） |
| `world(ctx, sec)` | `inputs.world` 为 `hook` 时：返回 `(layer, frame) => 世界矩阵`，frame 0 是预热（c4、d1 的脚本驱动对象） |
| `section(ctx, sec)` | 完全接管一段（b3 的模块段、b4）；可以调 `ctx.standard(sec)` 走标准流程 |
| `prepare(ctx, sec)` | 标准流程里模拟的额外选项（`r` 注入 R、`random` 包随机源、`patch` 改模块） |
| `compareOptions(ctx, sec, name, ref)` | 标准流程里每个系统的比较选项（`map`、`skip`、`sim`、`history`） |
| `after(ctx, sec, ref)` | 标准流程比完之后：额外核对（`ctx.check`）、变体、particleTrack 对照（`ctx.checkParticleTrack`） |
| `finish(ctx)` | 整个案例跑完 |

- 积木：`ctx.mod("particles/system")`（产品模块）、`ctx.compile(工程)`、`ctx.simulate(sec, 覆盖)`（返回 `out`、`history`、`births`；覆盖项
  `dts`、`times`、`timeMode`、`r`、`random`、`patch`、`vel`、`observe`…）、`ctx.withApprox(fn)`、`ctx.withInput(sec, N, 覆盖)`、
  `ctx.reference(sec, 覆盖)`、`ctx.addParticles(sec, 名字, ref, 选项)`、`ctx.addSystem`、`ctx.check`、`ctx.note`、`ctx.line`、
  `ctx.fork(sec, 标签)`（同一段的输入再比一轮，报告里另起一段）、`ctx.systemsOf(sec)`、`ctx.checkParticleTrack`；纯函数在 `ctx.lib`
  （`compareParticles`、`statsOk`、`perturb`…）。
- 钩子只 `import type` 回放库；运行期要库里的函数一律从 `ctx.lib` 取：每个案例前 `vi.resetModules()`，自己 import 会得到另一份模块实例
  （偏置开关不是同一个）。
- 只有写了 `envelope.approx` 的案例才挂 `particles/f32` 的 mock（mock 让热循环多一层调用：b4 挂着 49 s、不挂 17 s，结果逐字节相同）。
- 类型检查：`node node_modules/typescript/bin/tsc -p .claude/skills/kbp-tools/ts/tsconfig.json`；钩子可以另写一个 extends 它、include
  `<data>/cases/*.ts` 的 tsconfig（放在仓库里）。

## 新步骤的标准流程

1. **冻结源码**（并行会话在改产品代码时）：`kbp snapshot export HEAD ignore/<步骤>/head`，需要时再 `export WORKTREE …`；开发在
   `export HEAD ignore/<步骤>/ov` 出来的副本里做，做完 `kbp snapshot diff ignore/<步骤>/head ignore/<步骤>/ov --out step.patch`，
   `git apply --check` 后 `--3way` 移进工作区。
2. **生成工程**：在 `<data>/defs/<模块>.py` 里用生成库写实验定义，`kbp gen <模块>`；按绘制认的工程写 `track="draws"`。
3. **抓 WPE 真值**：wpe-renderdoc MCP 的 `capture_wallpaper` / `capture_sweep`（抓帧放 `A:\<项目>\<用途>\`，`log_dir` 截 `[kbp]` 日志到
   `<data>/out/<标签>-log.txt`）。
4. **取轨迹**：`kbp rdc track A:\<项目>\<用途> <标签>`（写 `<data>/tracks/rd-<标签>.json`）。
5. **写案例**：`<data>/cases/<名字>.json`，个案逻辑写钩子。
6. **回放**：`kbp replay <名字> --src ignore/<步骤>/ov/src`。
7. **回归**：改动前后 `kbp regress --src ignore/<步骤>/head/src --src ignore/<步骤>/ov/src`：`same` 为 true（或逐条解释 `differ` 里的案例），
   两边都全部通过（c3 的 `a-default` 是已知失败）。

## `kbp rdc` 怎么跑

- `kbp.py` 拉起 `qrenderdoc --python .claude/skills/kbp-tools/rdc/main.py`，参数经 `KBP_RDC_JOB` 指向系统临时目录里的
  `job.json`。
  - `--python` 的脚本在主界面出现之前运行，脚本不返回界面就不会出现；所以 `main.py` 任何退出路径都走 `os._exit`，同 MCP 的 `worker.py`。
  - 内嵌 Python 看不到 stdout：进度写 `log.txt`（转到 stderr），结果写 `result.json`。
  - 成功后删掉 job 目录；失败或 `--keep-work` 时保留并在报错里给出路径。
- 本地桥 `rdc/bridge.py` 直接调 `.claude/mcps/wpe-renderdoc/renderdoc_worker` 的服务层（`ReplayContext`、`RenderDocFacade`、
  `RequestHandler`）。
  - 不经 MCP、不经 IPC、不碰用户开着的 RenderDoc 或别的会话的回放进程；
  - 返回值先过一遍 JSON，形状和旧桥逐项相同。
  - **MCP 改这三个类或 `handle()` 的返回形状时要同步 `rdc/bridge.py`。**
- `rdc/` 下的代码跑在 RenderDoc 内嵌的 Python 3.8：不用 `match`、不用运行期求值的 `X | None`、不用 3.9+ 的标准库新接口。
  - 不写字节码，不在 `renderdoc_worker` 或本目录留 `__pycache__`。
- 看门线程握着 `kbp.py` 进程的句柄，`kbp.py` 没了它就退出。
- 超时只结束本次自己拉起的那个 qrenderdoc，别的进程一律不碰。
- 读的都是本地 `.rdc`，不需要 WPE 在跑；抓帧用 wpe-renderdoc MCP 的 `capture_wallpaper` / `capture_sweep`。

## 验收自测

### 第 2 批（`tests/accept2.py`）

```bash
python -X utf8 -I .claude/skills/kbp-tools/tests/accept2.py [--out ignore/kbp/accept2] [--only gen,track,snapshot,replay,c5,regress]
```

- `gen`：`ignore/p4` 的 `gen.py`、`gen_b.py`、`gen_c.py`、`gen_d.py` 拷到 `<out>/gen/`、只改 import 行，`kbp gen` 重新生成全部 `p4b*`、
  `p4c*`、`p4d*`（`p4b-vec` 由 `vec/gen_vec.py` 生成，不在内），和 `ignore/p4/proj/` 逐文件逐字节比（不比 WPE 写的 `shaders/blobsSM40`）；
  「替换模式」再把 gen_b / gen_c 拷贝里的通用函数换成库的生成一遍比。
- `track`：带 `track: "draws"` 的工程上 `kbp rdc track` 自动选 draws（认法选择只算 job；p4d-rope 真跑一遍，和 `--draws` 的真值逐字节相同）。
- `snapshot`：`export HEAD`（tsc、vitest）与 `export WORKTREE`；HEAD 副本改一行后 `diff`，`git apply --check`。
- `replay`：旧回放脚本拷到 `<out>/old/`（只改输出路径；b3、b4 另把已算好的统计写进 JSON），和新案例在同一份冻结快照上各跑一遍，
  逐系统比最大差、包络、差 / 限、超限数、是否通过（数值逐位），以及 particleTrack 对照与结论。
- `c5`：HEAD 快照上的结果和 `ignore/p4/c5/out/*-head*`、`d1/out/replay-rope.json` 的记录比。
- `regress`：同一份快照传两次（全部相同）；拷一份快照把 `particles/system.ts` 的 `DRAG_EXPONENT` 改成 0.71，和原快照比。
- 结果写 `<out>/report.json`（`--only` 时 `report-<段>.json`）。完整一遍约 6 分钟。

### 第 1 批（`tests/accept1.py`）

```bash
python -X utf8 -I .claude/skills/kbp-tools/tests/accept1.py [--out ignore/kbp/accept1] [--only 标签…|content] [--skip-run]
```

- 现有真值只读：`ignore/p4/tracks`、`step4/out`、`b3/out`、`ignore/p3b/compare`。
- 在这些真值的抓帧上重跑 `kbp rdc`，和旧产物比：
  - 轨迹逐项、数值逐位；
  - 整帧图解码后逐像素（`--present` 的浮点 DDS 逐字节）；
  - 统计量逐项。
- `content` 和 `scan_misc_lib.projects()`、`pkg_extract.py`、旧 `driver.py` 的 `resolve_project` 比。
- 同时看着：新起的 qrenderdoc 有没有可见窗口、是否都退出，已有的 RenderDoc / WPE 进程前后不变。
- 结果写 `<out>/report.json`。
