---
name: kbp-tools
description: WPE 场景对比工具链（kbp-tools）：测试工程协议（FR 帧号图层、CLK 时钟图层、[kbp] 日志、kbp-meta.json、轨迹 JSON）的唯一属主，以及一个入口 kbp.py 下的子命令。第 1 批有：从 WPE 的 RenderDoc 抓帧（.rdc）无界面提取粒子轨迹、整帧图、粒子统计量（kbp rdc track|frame|stats，替代 ignore/p4 里的 rdc_track_b.py、rdc_rope.py、rdc_track.py、wpe_rt.py、wpe_export.py、wpe_stats_b.py），以及读 WPE 语料与 scene.pkg（kbp content projects|resolve|ls|cat|grep，替代 scan_misc_lib.py、pkg_extract.py）。凡是要从抓帧取 WPE 真值写成文件、读测试工程的轨迹 / 帧号 / 时钟约定、枚举或搜索创意工坊与默认工程、从 scene.pkg 取文件时都用它。抓帧本身用 wpe-renderdoc MCP，驱动 Kabegame 用 kabegame-dev MCP。
---

# kbp-tools

WPE 场景对比的中间一层：认识我们的测试工程约定、把 WPE 与 Kabegame 两边的数据对上。两头由 MCP 负责：
`wpe-renderdoc` 拿 WPE 的真值（开窗、抓帧、日志、交互式回放），`kabegame-dev` 驱动 Kabegame（渲染、粒子回放、四角、哈希）。
计划见 `.claude/plans/tools/kbp-tools.md`。

**本 skill 是测试工程协议的唯一属主**：帧号图层、时钟图层、`[kbp]` 日志、`kbp-meta.json`、轨迹 JSON 的格式以本文件为准。
两个 MCP 不认识这些约定，唯一的例外是 `kabegame-dev` 的 `apps/kabegame-dev-mcp/src/timeline.ts`（按 `[kbp]` 日志与轨迹组时间线），
本 skill 不另做一份。

> 第 1 批只有 `rdc` 与 `content`。`gen`、`replay`、`regress`、`snapshot`、`corpus`、`mutate`、`cmp`、`corners`、`sample`
> 在后续批次，届时补进本文件；在那之前照旧用 `ignore/p4/` 里的脚本。

## 用法与输出约定

```bash
python -X utf8 -I .claude/skills/kbp-tools/kbp.py <分类> <动作> …
```

- stdout 只有一行 JSON 摘要（`ok`、产物路径、要点），细节写文件。`content cat` 不给 `--out` 时例外：原始字节写 stdout。
- 失败：退出码非 0，stderr 一行错误、stdout 一行 `{"ok": false, "error": …}`；错误以层开头：
  `[data]`（输入数据、工程、抓帧不符合约定，输出已存在）、`[renderdoc]`（qrenderdoc 起不来、超时、服务层报错）、
  `[wpe]`（WPE 目录不对）、`[kbp]`（参数）。
- 只用 `python -X utf8 -I`，不要 `python -c`。脚本里要用库时：把 `.claude/skills/kbp-tools` 放进 `sys.path`，再
  `from kbp import content`（`kbp.py` 本身充当包 `kbp`，`__path__` 指向 `py/`）。

### 路径与环境变量

| 变量 | 缺省 | 用途 |
|---|---|---|
| `--data` → `KBP_DATA` | `ignore/p4` | 数据目录：`proj/`（工程）、`tracks/`（轨迹）、`out/`（日志、整帧图、统计量） |
| `KABEGAME_WPE_ROOT` | `D:\Applications\Steam\steamapps\common\wallpaper_engine` | WPE 安装目录；创意工坊是 `<WPE>\..\..\workshop\content\431960` |
| `RENDERDOC_DIR` | `C:\Program Files\RenderDoc` | `qrenderdoc.exe` 所在目录 |

抓帧照旧在 `A:\<项目>\<用途>\`（wpe-renderdoc MCP 的约定），文件名 `<标签>-frame<RenderDoc 帧号>.rdc`。

## 命令（第 1 批）

### `kbp rdc` — 从抓帧取真值

```bash
kbp.py rdc track <抓帧目录> <标签> [工程] [--draws] [--limit N] [--out 文件] [--data 目录]
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
- **`track` 的认法**按工程自动选，摘要里的 `mode` 报出来：
  - 有 `kbp-meta.json` 是 `points`；
  - 加 `--draws` 是 `draws`，P4d 的绳与模块工程（`gen_d.py` 生成的 `p4d-*`）用它；
  - 没有 meta 的老工程（`p4-0`、`p4a*`）是 `legacy`。
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

### `kbp-meta.json`（P4b 起，`gen_b.py` / `gen_c.py` 写，提取器读）

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
- 计划中（第 2 批）：每个对象加 `bbox`（场景包围盒），给 `cmp frame` 按对象归类像素差；旧工程没有时只报整帧。

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
