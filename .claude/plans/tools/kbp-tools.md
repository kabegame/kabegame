# kbp-tools：WPE 场景对比工具链

> 来源：2026-11-08 的 `ignore/` 基建工具盘点（本地存档 `ignore/tools-inventory.md`）。范围是 [wpe-renderdoc-mcp.md](wpe-renderdoc-mcp.md)「本计划不做」里的全部：测试工程生成、帧号 / 时钟图层解码、`kbp-meta.json`、`[kbp]` 日志转 dt、轨迹提取、回放对比、语料扫描、变异检查、像素与统计比较，加上推迟到这里的 PrintWindow 采样、语料与 `scene.pkg` 读取。
> 用户定（2026-11-10）：
> - **读抓帧用方案 b：** 提取脚本在 `qrenderdoc --python` 里无界面运行，直接调 `.claude/mcps/wpe-renderdoc/renderdoc_worker` 的服务层，不经 MCP，也不经旧桥。
> - **旧 skill 的 `control`（pause / play / mute / unmute）不迁：** 只作用于桌面壁纸，抓帧已经在测试窗口里做。记在 [wpe-renderdoc-mcp.md](wpe-renderdoc-mcp.md)「完全迁移」。

## 总体设计思路

P4 的每一步都在 `ignore/p4/` 下开一个新目录，把上一步的工具整套拷过来，改输出路径、加一点逻辑。到 P4c 步骤 5，同一个回放脚本已经有 6 份拷贝，每一步还要把之前所有回放在「改动前 / 改动后」两份源码上各跑一遍当回归；语料扫描拷了 10 次，变异检查 17 次。拷来拷去的同时，写死的路径（`D:\…`、`A:\p4b`）、跨目录 import（`hdr-macro`、`p3c/wpe-general`）和旧的 RenderDoc 桥（要开着 RenderDoc 界面）也跟着扩散。两个 MCP 已经把两头收走：`kabegame-dev` 驱动 Kabegame（渲染、粒子回放、四角、哈希、导入测试工程），`wpe-renderdoc` 拿 WPE 的真值（窗口、抓帧、日志、无界面回放）。剩下的是中间这一层：认识我们测试工程约定、把两边的数据对上并下结论的工具。

`kbp-tools` 是一个 skill（`.claude/skills/kbp-tools/`），只有一个入口 `kbp.py`，按数据流向分五类子命令：

- **造工程（`gen`）：** 确定性测试工程的生成库。帧号、时钟、指针图层与 `[kbp]` 日志、`kbp-meta.json`、工程和属性的写出都在库里；每一步的实验定义（哪些系统、什么参数）仍是 `ignore/` 里的数据脚本，只 import 这个库。
- **取真值（`rdc`）：** 从 WPE 的抓帧提取轨迹、整帧图、统计量，写成文件。
- **算我们的（`replay`）：** 在 Node 里直接用产品源码按 WPE 的时间线回放模拟器。真机那一半（GPU、Tint、宿主）已经由 `kabegame-dev` 的 `particle_track` / `particle_corners` / `render_scene` 提供，这里只负责比。
- **比（`replay` 的判定、`cmp`、`corpus diff`）：** 逐粒子按限值与近似运算包络判定，整帧和统计量比较，语料能力键的增减。
- **守（`regress`、`mutate`、`snapshot`）：** 把全部登记过的回放案例当回归套件，在两份源码上跑并逐字节比较；变异检查；源码快照（HEAD 导出、与并行会话隔离的开发副本）。

**数据和代码分开放。** 仓库里只有通用代码和协议文档；数据目录 `KBP_DATA`（缺省 `ignore/p4`）里是生成的工程（`proj/`）、轨迹（`tracks/`）、日志与结果（`out/`）、回放案例（`cases/`）和各步的实验定义。抓帧照旧在 `A:\<项目>\<用途>\`。仓库不收任何从创意工坊导出的内容（如 `texsrc/dxt*.tex`）；我们自己写的两行 `solidlayer.json` 夹具随库入库。

**`kbp-tools` 是测试工程协议的唯一属主。** 帧号图层（FR）、时钟图层（CLK，带指针的 CLK_PTR）、`kbp-meta.json`、`[kbp]` 日志行、轨迹 JSON 的格式都写在它的 `SKILL.md` 里。两个 MCP 不认识这些约定，只有一个例外：`kabegame-dev` 的 `timeline.ts` 已经按 `[kbp]` 日志和轨迹组 dt、`g_Time`、逐帧光标，规则是从 P4 各步回放脚本里核对出来的。`kbp-tools` 直接 import 它，不做第二份；协议文档里写明实现在那里。

**读抓帧（方案 b）。** `rdc` 的提取脚本在 RenderDoc 内嵌的 Python 3.8 里运行（`qrenderdoc --python`，脚本不返回就没有界面），import `renderdoc_worker` 的 `ReplayContext`、`RenderDocFacade`、`RequestHandler`，包一个和旧 `RenderDocBridge` 同签名的本地桥 `call(method, params)`。现有提取脚本（`rdc_track_b.py`、`rdc_rope.py`、`wpe_stats_b.py`、`wpe_rt.py`）几乎原样移植，返回的 JSON 形状也和旧桥一致。它不占界面、不经 MCP、不和用户的 RenderDoc 或 MCP 的回放进程共享状态；一次启动处理一批 `.rdc`，结果写文件（内嵌 Python 看不到 stdout）。

**回放是一个库加一张案例表。** 案例是数据目录里的一个 JSON：工程、抓帧标签、遍数、比哪些系统、比位置还是颜色、输入从哪来（对象世界矩阵、光标、运行中改属性），以及可选的钩子模块（处理「出生方向符号随机、要先定符号」这类个案）。库负责：从磁盘编译工程、时间线、模拟循环、近似运算包络（照现在的写法 `vi.doMock` 产品的 `particles/f32`）、输入精度包络、按限值比较、写报告。`kbp regress` 在两份源码上跑全部案例再逐字节比较，取代每一步手写的 `run_old.sh` + `cmp_old.py`。

几个关键决定：
- **一个入口、子命令都是原子的。** `kbp.py` 用本机 Python 写，按子命令转给 Python、`node … vitest`、`deno` 或 `qrenderdoc --python`。每个子命令只做一件事、输出 JSON 摘要、结果写文件；组合留给调用方。
- **不改 `ignore/` 里现有的脚本。** 它们照旧能跑；只有依赖旧桥的那几个，要等完全迁移删掉 `ignore/RenderDocMCP` 后才失效，那时 `kbp rdc` 已经能替代。新步骤改用 `kbp-tools`。
- **路径全部参数化：** WPE 读 `KABEGAME_WPE_ROOT`，RenderDoc 读 `RENDERDOC_DIR`，数据读 `KBP_DATA`；vitest 的 `root` 由配置文件位置推出，不写死 `D:/Codes/kabegame`。
- **产品测试数据的生成脚本不进 `kbp-tools`，进产品目录。** 产品代码有 7 处注释指向 `ignore/p4/b4/`、`b6/` 下的生成脚本（噪声表、`colorn` 参考实现、`make_fixtures.py`），这关系到产品自己的可复现性，放 `apps/wpe-scene/scripts/`。

## 现状锚点

**a. 每一步拷一整套回放，再当回归跑**（`ignore/p4/c5/run_old.sh`）
```bash
# P4c 步骤 5：旧回放（b3、b4、b6 的拷贝，c1 的 p4c-cp，c2 的 p4c-ptr，c3 的 p4c-attract，c4 的 p4c-world）在改动前（HEAD 导出
# ignore/p4/c5/head/src）与改动后（apps/wpe-scene/src）各跑一遍，输出写 ignore/p4/c5/out/，再由 cmp_old.py 逐字节比较。
run "b3 $side" KB_TEST=ignore/p4/c5/replay-b3.test.ts KB_SRC=$SRC KB_OUT=b3-$side     # 现状：c2–c5 每步各有一份 replay-b3/b4/b6/cp/ptr/attract
run "world $side" KB_TEST=ignore/p4/c5/replay.test.ts KB_SRC=$SRC KB_REPLAY_OUT=replay-world-$side
```

**b. 读抓帧经旧桥，要开着 RenderDoc 界面**（`ignore/p4/rdc_track_b.py:16`）
```python
CLIENT = os.path.normpath(os.path.join(track.HERE, '..', 'RenderDocMCP', 'mcp_server', 'bridge', 'client.py'))
spec = importlib.util.spec_from_file_location('rd_client', CLIENT)
client = importlib.util.module_from_spec(spec)
spec.loader.exec_module(client)
bridge = client.RenderDocBridge()   # 现状：经界面里的扩展；rdc_rope.py、wpe_stats_b.py、step4/wpe_rt.py、rdc_*.py 同样
```

**c. 新 MCP 的服务层可以直接当库用**（`.claude/mcps/wpe-renderdoc/renderdoc_worker/request_handler.py:43`、`context.py`）
```python
def handle(self, request):                 # 现状：worker.py 把 IPC 请求交给它；返回 {"id", "result"} 或 {"id", "error"}
    method = request.get("method")
    params = request.get("params", {})
    ...
# context.py：ReplayContext 是「服务层用到的 CaptureContext 子集，背后是一个裸 ReplayController」，兼容 Python 3.8
```

**d. 包络靠 `vi.doMock` 替换产品的 `f32`**（`ignore/p4/c5/replay.test.ts:264`）
```ts
vi.doMock(`${SRC}/particles/f32`, async (importOriginal) => {
  const original = await importOriginal<{ f32: …; rcp: …; rsqrt: … }>();
  return {
    ...original,
    rcp: (x: number) => original.f32(original.rcp(x) * (1 + bias.rcp)),     // 现状：每份回放脚本各写一遍
    rsqrt: (x: number) => original.f32(original.rsqrt(x) * (1 + bias.rsqrt)),
  };
});
```

**e. 生成器写死路径、跨目录引用夹具**（`ignore/p4/gen.py:10`、`gen_b.py:237`）
```python
ROOT = os.path.join(HERE, 'proj', 'p4-0')
MODELS = os.path.normpath(os.path.join(HERE, '..', 'p3c', 'wpe-general', 'base-kbprops-test', 'models'))   # 现状：跨目录
SHIMMER = r'D:\Applications\Steam\steamapps\common\wallpaper_engine\projects\defaultprojects\shimmering_particles\shaders'
ASSETS = r'D:\Applications\Steam\steamapps\common\wallpaper_engine\assets'                                # gen_b.py
```
夹具里的 `models/util/solidlayer.json` 是我们自己写的两行（只有 `material`），和 WPE 自带的那份（另有 `"solidlayer": true`）不同。

**f. vitest 的 `root` 写死，每步一份配置**（`ignore/p4/c5/vitest.config.ts`）
```ts
export default defineConfig({
  root: "D:/Codes/kabegame",                                            // 现状：写死；b3、b4、b6、c1–c5、d0、d1 各一份
  test: { environment: "node", globals: true, include: [process.env.KB_TEST ?? "ignore/p4/c5/*.test.ts"], testTimeout: 3_600_000 },
});
```

**g. 时间线已经在 `kabegame-dev` 里**（`apps/kabegame-dev-mcp/src/timeline.ts:1`）
```ts
/**
 * 粒子回放的时间线（第 4 批）：按 WPE 日志与 RenderDoc 轨迹组出 dev 探针要的 `dts`、`times`、逐帧光标。MCP 的
 * `render_scene` / `host_render` / `particle_track` / `particle_corners` 用它，脚本也能 import。   // 现状：只用 node:fs，vitest 能直接 import
 */
```

**h. 产品注释指向 `ignore/`**（`apps/wpe-scene/src/particles/noiseTables.ts:2`）
```ts
 * 噪声常量表（P4b 步骤 4）。由 `ignore/p4/b4/gen_tables.py` 从 `ignore/p4/rea/p4b-mod/noise-tables.json` 生成，**不要手改**；
```
同样的还有 `noise.test.ts`（`b4/make_fixtures.py`、`gen_tables.py`）、`colorn.test.ts`（`b6/colorn_ref.py`），共 7 处。

## 点 1 — skill 骨架与入口（新增 `.claude/skills/kbp-tools/`）

- **新增** 目录：
```text
.claude/skills/kbp-tools/
  SKILL.md        协议（图层、kbp-meta、[kbp] 日志、轨迹格式）、命令表、限值与包络、新步骤的标准流程、快照流程
  kbp.py          唯一入口：python -X utf8 -I .claude/skills/kbp-tools/kbp.py <分类> <动作> …
  py/             本机 Python：gen、content、mutate、cmp、sample、snapshot、regress 的比较部分
  rdc/            RenderDoc 内嵌 Python 3.8：bridge.py（本地桥）、main.py（入口）、track.py、frame.py、stats.py
  ts/             Node：replayLib.ts、replay.test.ts、corpus.test.ts、vitest.config.ts（root 按本文件位置推出）
  assets/         models/util/solidlayer.json（我们的两行版）
```
- **新增** `kbp.py`：解析 `<分类> <动作>`，按子命令转给本机 Python 模块、`node node_modules/vitest/vitest.mjs run --config .claude/skills/kbp-tools/ts/vitest.config.ts`（参数经环境变量）、`deno` 或 `qrenderdoc --python`。统一的输出约定：
  - stdout 是一行 JSON 摘要（`ok`、产物路径、要点），细节写进 `--out` 指定的文件；
  - 失败退出码非 0，错误开头标出层：`[wpe]`、`[renderdoc]`、`[data]`、`[src]`、`[node]`；
  - 公共参数：`--data`（缺省 `KBP_DATA`，再缺省 `ignore/p4`）、`--src`（产品源码，缺省 `apps/wpe-scene/src`）。
- 命令一览（各点展开）：

| 分类 | 动作 | 做什么 |
|---|---|---|
| `gen` | `<模块> [工程…]` | 运行 `<data>/defs/<模块>.py` 里的实验定义，生成到 `<data>/proj/` |
| `rdc` | `track` / `frame` / `stats` | 从一个抓帧目录批量提取轨迹、整帧图、统计量 |
| `replay` | `<案例…>` / `--all` | 跑回放案例，写报告 |
| `regress` | `--src A --src B` | 全部案例和语料在两份源码上各跑一遍，逐字节比较 |
| `snapshot` | `export <rev> <目录>` / `diff <基线> <副本>` | 导出某个提交的 `apps/wpe-scene/src`（带翻译器 wasm 和独立的 tsconfig / vitest 配置）；把副本相对基线的改动做成补丁 |
| `corpus` | `scan` / `diff` | 跑语料编译、比两次结果 |
| `mutate` | `--spec <文件> [id…]` | 变异检查 |
| `cmp` | `track` / `frame` / `stats` | 比真机结果和 WPE 真值 |
| `corners` | `offline` | 用 WPE 的顶点输入跑我们的顶点 / 几何着色器翻译，比四角 |
| `sample` | `grab` / `series` / `read` | PrintWindow 采样 |
| `content` | `projects` / `resolve` / `ls` / `cat` / `grep` | 语料与 `scene.pkg` 读取 |

## 点 2 — 造工程（`py/gen.py`，`kbp gen`）

- **新增** 生成库，从 `gen.py`、`gen_b.py`、`gen_c.py` 抽出通用部分，函数名和签名照旧（`system`、`material`、`fixed`、`numbered`、`write_json`、`write_project` 等），让现有实验定义只改一行 import 就能用：
  - 帧号图层 FR（每 50 帧经 `console.error('[kbp] 帧,帧时间,累计时间')` 写 WPE 的 `log.txt`）、时钟图层 CLK 与带指针的 CLK_PTR；
  - `write_project`：图像层、材质、拷文件、改写 `.tex` 头、`version`、用户属性、`kbp-meta.json`（对象顺序、种类、认法 `color` / `order`、`rgb`，`corners`、`draws`）；
  - 脚本驱动对象的常用片段（`MOVE_ORIGIN`、`SPIN_ANGLES`，注明图层 `angles` 是度）；
  - 模型夹具从 `assets/` 拷，WPE 资源经 `KABEGAME_WPE_ROOT`。
- **新增** `kbp-meta.json` 加一项 `bbox`（每个对象的场景包围盒），给 `cmp frame` 按对象归类像素差用；旧工程没有这一项时 `cmp frame` 只报整帧。
- **新增** `kbp gen <模块> [工程…]`：import `<data>/defs/<模块>.py`，调用它的 `PROJECTS` 表，写到 `<data>/proj/<工程>`，先删再写。
```python
# <data>/defs/p4c.py（实验定义是数据，留在 ignore/）
from kbp import gen          # 新增：库在 .claude/skills/kbp-tools/py/，kbp.py 负责 sys.path
def p4c_cp():
    spec = gen.system('255 0 0', None, emitter=ring(controlpoint=1), …)
    gen.write_project('p4c-cp', 'kbp4c-cp', systems, overrides=overrides)
PROJECTS = {'p4c-cp': p4c_cp, …}
```
- 现有的 `gen_b.py`、`gen_c.py`、`gen_d.py` 不动、照旧能跑。

## 点 3 — 取真值（`rdc/`，`kbp rdc`）

- **新增** `rdc/bridge.py`：本地桥，和旧 `RenderDocBridge` 同签名。
```python
# 在 qrenderdoc --python 里运行（RenderDoc 内嵌的 Python 3.8：不用 match、不用运行期求值的 `X | None`）
import sys
sys.path.insert(0, MCP_DIR)                        # .claude/mcps/wpe-renderdoc，由 main.py 从环境变量取
from renderdoc_worker.context import ReplayContext
from renderdoc_worker.renderdoc_facade import RenderDocFacade
from renderdoc_worker.request_handler import RequestHandler

class LocalBridge(object):
    """旧 RenderDocBridge.call 的替身：同一套服务层，返回同样形状的 JSON，不经 IPC、不要界面。"""
    def __init__(self):
        self._handler = RequestHandler(RenderDocFacade(ReplayContext()))
    def call(self, method, params=None):
        response = self._handler.handle({"id": 1, "method": method, "params": params or {}})
        if "error" in response:
            raise RuntimeError("%s：%s" % (method, response["error"]["message"]))
        return response["result"]
```
- **新增** `rdc/main.py`：入口。从环境变量读动作和参数，跑完把结果和日志写进指定文件，任何退出路径都走 `os._exit`（同 `renderdoc_worker/worker.py`，否则 qrenderdoc 会接着打开界面）。`kbp.py` 负责启动 `qrenderdoc --python rdc/main.py`、等结果文件、转成 stdout 的摘要。
- **新增** 三个提取器，从现有脚本移植，输出格式不变：
  - `track.py`：合并 `rdc_track_b.py` 与 `rdc_rope.py`。
    - 按 `kbp-meta.json` 认系统（`color` / `order`）；
    - 时钟图层读 `g_Time`、`g_Frametime`、`g_PointerPosition`、`g_PointerPositionLast`；
    - 其余顶点列原样保存（厚格式的 `TEXCOORD1`、绳的每段数据）；
    - meta 有 `corners` 时读 `gs_out` / `vs_out` 四角；
    - 同一系统多次绘制记成 `名字#2`；
    - 绳额外记几何着色器的 `dcl_maxout` 与被读到的常量。
    - 没有 meta 的老工程（`p4-0`、`p4a*`）退回 `rdc_track.py` 的颜色表认法。
  - `frame.py`：`step4/wpe_rt.py` 加 `p3b/compare/wpe_export.py`。指定事件或最后一次绘制之后的渲染目标、`Present` 时的后备缓冲；LDR 存 PNG，浮点存 DDS。
  - `stats.py`：`b3/wpe_stats_b.py`。每次粒子绘制的数量，尺寸、位置、颜色、alpha 的范围，`g_Time`；按顶点布局认粒子绘制，不依赖测试工程。
- **新增** `kbp rdc track|frame|stats <抓帧目录> <标签> [工程]`：一次启动处理目录里全部 `.rdc`，写 `<data>/tracks/rd-<标签>.json`、`<data>/out/wpe-<标签>-f<帧>.png`、`<data>/out/wpe-<标签>-stats.json`（和现在的位置、文件名相同）。
- 轨迹格式照 [phase-4-0-tools.md](../wpe-import/3-scene/phase4/phase-4-0-tools.md)「点 2」，后来加的字段（`pointer`、`pointer_last`、`corners`、额外顶点列、`#2`）一并写进 `SKILL.md`。

## 点 4 — 回放、回归与快照（`ts/`，`kbp replay` / `regress` / `snapshot`）

- **新增** `ts/replayLib.ts`：把 `b3`、`b4`、`b6`、`c1`–`c4` 回放脚本的公共部分收成库。
```ts
export interface ReplayCase {
  name: string;                       // 案例名，也是报告文件名
  project: string;                    // <data>/proj/<project>
  tags: string[];                     // 抓帧标签：轨迹 <data>/tracks/rd-<tag>.json，日志 <data>/out/<tag>-log.txt
  passes?: 1 | 2;                     // 缺省按标签里的 fps 推（timeline.ts 的 passesFromTag）
  systems?: { only?: string[]; skip?: string[] };
  mode?: "position" | "color";        // color：b6 的逐粒子 rgb、按线段拟合
  inputs?: {
    world?: "static" | { hook: string };            // 对象世界矩阵：编译期变换，或钩子按帧给（脚本驱动的对象，c4）
    cursors?: "track" | [number, number];           // 同 timeline.ts
    changes?: string;                               // 运行中改属性的文件（b6 的 KB_CHANGES）
  };
  gap?: "error" | "split";            // 日志缺帧：报错或平分（timeline.ts）
  envelope?: { approx?: boolean; input?: number };  // 近似运算包络（rcp / rsqrt ±3.7e-4）；输入精度包络的遍数（b4）
  limits?: Partial<Limits>;           // 缺省：位置 1e-3（坐标过 1000 取 2e-3，按粒子出生以来的最大坐标）、size 1e-3、color / alpha 2e-3、rot 1e-3
  hook?: string;                      // 个案钩子模块（<data>/cases/<name>.hook.ts）：定符号、注入 R、反推缺帧 dt 等
}
export function loadCase(data: string, name: string): ReplayCase;
export async function runCase(src: string, data: string, c: ReplayCase, out: string): Promise<CaseReport>;
```
  - 编译：`nodeReader` 加 WPE `assets/`，`fileUrl` 替换为恒等（同现状）；
  - 时间线：import `apps/kabegame-dev-mcp/src/timeline.ts`，不另写；
  - 模拟：产品的 `ParticleSystem` / `particleTrack`，第 i 个粒子层种子 `1 + i`；
  - 包络：照锚点 d 的 `vi.doMock`，四种偏置组合各跑一遍；
  - 报告：`<out>/<案例>.txt` 和 `.json`，每个系统的最大差、限值、差 / 限、是否通过。
- **新增** 案例表：`<data>/cases/<名字>.json`。把现在会被当回归跑的回放都登记成案例：`b3`（P4a 的 9 个标签、`p4b`、`p4b-emit`）、`b4`（噪声）、`b6`（三组 `colorn`）、`c1`（`p4c-cp`）、`c2`（`p4c-ptr`）、`c3`（`p4c-attract`）、`c4`（`p4c-world`）、`d1`（绳）。个案逻辑放钩子，钩子从原脚本搬，原脚本不动。
- **新增** `kbp replay <案例…>|--all [--src] [--out]`。
- **新增** `kbp regress --src A --src B [--out]`：全部案例和语料扫描在两份源码上各跑一遍，逐字节比较报告，列出不同的文件和第一处不同；同时核对各自是否全部通过（取代 `run_old.sh` + `cmp_old.py`）。
- **新增** `kbp snapshot export <rev> <目录>`：`git archive` 导出 `apps/wpe-scene/src`，拷入未入库的翻译器 wasm，写独立的 `tsconfig.json`（带 `node` 类型）和 `vitest.config.ts`，导出后跑一次 tsc 报告是否干净（就是 P4c 步骤 1 手工搭的 `c1/ov`）。`kbp snapshot diff <基线> <副本> --out x.patch`：把路径改写成 `apps/wpe-scene/src/…`，补丁可直接 `git apply --3way`。

## 点 5 — 语料（`ts/corpus.test.ts`、`py/content.py`，`kbp corpus` / `content`）

- **新增** `kbp corpus scan [--src] --out <文件> [--extra modules:<名单>|controlpoints|sheets]`：照 `c5/corpus.test.ts`，对默认工程与创意工坊工程跑 `compileScene(exhaustive)`，行格式 `{ sample, unsupported[], …附加字段 }`；附加字段做成插件，不再每步改测试文件。
- **新增** `kbp corpus diff <前> <后> [--explain <模块>]`：照 `b5/diff_corpus.py`，报出错、干净场景增减、每个键增减了哪些场景，加上「去掉某键后还剩什么」（`b6/corpus_colorn.py`）；`--explain` 挂各步自己的解释脚本。
- **新增** `py/content.py`：`hdr-macro/scan_misc_lib.py` 加 `c2/pkg_extract.py` 收成库，WPE 目录经 `KABEGAME_WPE_ROOT`。
  - `projects(source, type)`、`resolve(名字)`（同 wpe-renderdoc 的工程解析）、`files(工程)`（散文件加 `scene.pkg` 条目）、`read(工程, 相对路径)`（散文件 → `scene.pkg` → WPE `assets/`，同 Kabegame 编译管线的查找顺序）；
  - 命令行 `kbp content projects|resolve|ls|cat|grep`；
  - 现在 import `scan_misc_lib` 的 11 个脚本不动；新脚本 `from kbp import content`。

## 点 6 — 变异检查（`py/mutate.py`，`kbp mutate`）

- **新增** 通用跑器，照 `c1/mutate.py`（快照里改）与 `b5`、`b6` 的反向替换（在工作区里改，不覆盖并行会话的改动）：
```python
# 变异清单（数据，留在各步目录）：<step>/mutations.py
MUTATIONS = [
    {"id": "euler-xyz", "file": "particles/controlpoints.ts", "old": "…", "new": "…", "count": 1,
     "tests": ["src/particles/controlpoints.test.ts"],        # vitest 子集（相对 --src 的上一级）
     "cases": ["p4c-cp"],                                      # 回放案例，可空
     "commands": []},                                          # 其它命令（如离线四角），退出码非 0 算检出
]
```
  - `kbp mutate --spec <文件> [--src] [--mode snapshot|workspace] [id…]`；
  - 每处改坏 → 跑测试与案例 → 解析失败数 → 还原：快照模式按原字节写回，工作区模式做反向替换；
  - 每处还原后核对文件哈希；开头和结尾各求一次整树哈希，必须相同；
  - 结果写 `--out`（缺省 `<spec 所在目录>/out/mutate.txt`）。

## 点 7 — 比较与离线四角（`py/cmp.py`、`ts/`，`kbp cmp` / `corners`）

- **新增** `kbp cmp track <我们.json> <rd-*.json> [--skip]`：`dev4/cmp-wpe.ts` 的通用版。真机 `particle_track` 的结果对 WPE 轨迹，同帧同系统按数组顺序配对，报各字段最大差；不做包络判定（判定在 `replay`）。
- **新增** `kbp cmp frame <我们.png> <wpe.png> [--meta <kbp-meta.json>] [--crop 上,下,左,右] [--heat <png>]`：收 9 份像素比较拷贝（`step4/cmp_real.py`、`b1/cmp.py`、`b6/px/cmp.py`、`c5/cmp_scene.py` 等）。
  - 排除 FR / CLK 图层；有 `bbox` 时按对象归类；
  - 报差值直方图、超阈值连通块；`--heat` 出热图与局部放大（`b1/heat.py`）。
- **新增** `kbp cmp stats <我们.json> <wpe-stats.json>`：`b3/cmp_stats.py`，给真实场景比统计量（粒子数、尺寸、位置、颜色范围）。
- **新增** `kbp corners offline <标签> [--src]`：收 `step4/corners-offline*`、`c5/corners-offline*`、`d1/corners-offline*`。取 WPE 轨迹里的顶点输入，跑我们翻译出的顶点 / 几何着色器（WGSL 经 Deno），比 `gs_out` 四角，限值 0.01 像素。

## 点 8 — 画面采样（`py/sample.py`，`kbp sample`）

- **新增** 收 `p3c/wpe-general/sampler_pw.py`、`p4/run.py`、`p3c/step4/accept/w1080.py`、`wread.py`，只做采样，不开关窗口。窗口由 `wpe-renderdoc` MCP 的 `open_wallpaper` 开，这里按标题找（`kb-<进程号>-<序号>`），只读不碰。
  - `kbp sample grab <窗口标题> --out x.png`：PrintWindow 抓一帧；
  - `kbp sample series <窗口标题> --seconds N (--grid 步长,x0,y0 --out x.bin | --changed-only --out <目录>)`：定时采网格点，或画面变了才存；
  - `kbp sample read <bin>`：解码。
- 不再有写死的 PID：要用到 WPE 进程时动态查。左上角 RenderDoc 叠加文字（约 340×40）写进说明，网格起点缺省避开。

## 点 9 — 产品测试数据的生成脚本入库（新增 `apps/wpe-scene/scripts/`）

- **新增**：
  - `fixtures/gen_noise_tables.py`（`b4/gen_tables.py`）+ `fixtures/noise-tables.json`（`rea/p4b-mod/noise-tables.json`，见「决定 3」）；
  - `fixtures/make_noise_fixtures.py`（`b4/make_fixtures.py`）、`fixtures/noise_ref.py`；
  - `fixtures/colorn_ref.py`（`b6/colorn_ref.py`）；
  - `fixtures/README.md`：每个脚本生成产品里的哪个文件、输入从哪来、怎么重新生成。
- **修改** 7 处产品注释（`noiseTables.ts`、`noise.test.ts`、`colorn.test.ts`），路径改成 `apps/wpe-scene/scripts/fixtures/…`。

## 点 10 — 旧 skill 的完全迁移

点 3 验收后，[wpe-renderdoc-mcp.md](wpe-renderdoc-mcp.md)「完全迁移」的条件都满足了。按那一节做：
- 删除 `.claude/skills/wpe-renderdoc/` 的 `driver.py`、`target.py`，把新 MCP 的用法写进 skill；
- 删除 `.mcp.json` 的 `renderdoc`；
- 用户确认后删掉 `ignore/RenderDocMCP`；
- 更新 memory 里 RenderDoc MCP 的位置。

依赖旧桥的 `ignore/` 脚本从此失效，用 `kbp rdc` 代替。

## 分批

每批子代理在独立的工作区副本里实现（并行会话还在改 `ignore/p4/` 和产品代码），Claude 独立验收后再提交。

- **第 1 批 — 骨架与取真值：** 点 1（只放 `kbp.py`、`SKILL.md` 的协议部分）、点 3、点 5 的 `content`。完成后旧 skill 的迁移条件满足，点 10 可以随后做。
- **第 2 批 — 造工程与回放：** 点 2、点 4（库、案例表、`regress`、`snapshot`）。
- **第 3 批 — 语料、变异、比较、采样：** 点 5 的 `corpus`、点 6、点 7、点 8。
- **第 4 批 — 产品脚本与迁移：** 点 9、点 10。

## 验收

新工具用现有数据重放出现有结论，以「和旧脚本的产物一致」为准：

- **`gen`：**
  - 把 `gen_b.py`、`gen_c.py`、`gen_d.py` 拷到临时目录，只改 import 行，重新生成全部 `p4b*`、`p4c*`、`p4d*` 工程；
  - 和 `ignore/p4/proj/` 逐字节相同（不比 WPE 写进去的 `shaders/blobsSM40`）；
  - 新加的 `bbox` 另行核对。
- **`rdc`：**
  - `track` 在 `p4b`、`p4b-color`、`p4c-cp`、`p4c-sprite`（四角）、`p4c-world`（指针）、`p4d-rope`（绳）的抓帧上重跑，和 `ignore/p4/tracks/rd-*.json` 逐项相同（JSON 解析后比，数值逐位）；
  - `frame`、`stats` 各挑两组，和 `step4/out/wpe-*.png`、`out/wpe-*-stats.json` 相同；
  - 全程不开 RenderDoc 界面；`wpe-renderdoc` MCP 的回放进程开着时也互不影响。
- **`replay` / `regress`：**
  - 全部案例在 HEAD 上跑，每个系统的最大差、限值、是否通过，和 `c5/out` 里同名回放的最新结果逐项相同；
  - `d1` 的绳和 `d1/out` 相同；
  - `regress --src <HEAD 快照> --src apps/wpe-scene/src` 的结论和 `c5/cmp_old.py` 一致。
- **`snapshot`：**
  - `export HEAD` 出来的副本 tsc 0 error、vitest 与工作区同数全过；
  - `diff` 出的补丁能干净打在 HEAD 上。
- **`corpus`：** HEAD 的 `scan` 和最近一轮（`d1/corpus-after`）逐场景相同；`diff` 复现 `c5/corpus_diff.py` 的增减与解释。
- **`mutate`：** 用新跑器重跑 `c5` 的变异清单，检出结果相同；整树哈希前后一致。
- **`cmp` / `corners`：**
  - `cmp frame` 在 3832772446 的数据上复现 `c5/cmp_scene.py` 的差异统计；
  - `cmp track` 复现 `dev4/cmp-wpe.ts`；
  - `corners offline` 复现 `c5`、`d1` 的四角结论。
- **`sample`：** 在 MCP 开的测试窗口上 `grab` 出正确尺寸的 PNG；`series` 跑 5 s，采样数合理。
- **`content`：** `projects` 和 `scan_misc_lib.projects()` 相同；`cat` 取出的 `scene.pkg` 条目和 `c2/pkg_extract.py` 逐字节相同。
- **产品脚本：** 重新生成的 `noiseTables.ts`、`fixtures/*.json` 和仓库里的逐字节相同；产品 vitest 全过。
- **迁移：** 全仓库 grep 不再有 `wpe-renderdoc/driver.py`、`RenderDocMCP` 的引用（`ignore/` 除外）。
- **格式与类型：** TS 过 `deno check` 或 tsc；Python 3.8 部分在 qrenderdoc 里实际跑过；Prettier。

## 决定

1. 读抓帧用方案 b：`qrenderdoc --python` 无界面，直接调 `renderdoc_worker` 的服务层（2026-11-10 用户）。
2. 旧 skill 的 `control` 不迁（2026-11-10 用户）。
3. `noise-tables.json` 入库（2026-11-10 用户）。它是从 WPE 二进制读出来的常量表；由它生成的 `noiseTables.ts` 已经在仓库里，入库只是让生成过程可复现。
4. 位置 `.claude/skills/kbp-tools/`，入口 `kbp.py`（2026-11-10 用户）。
5. `ignore/` 里现有的实验定义、步骤目录不迁（2026-11-10 用户）：它们照旧能跑，新步骤在 `<data>/defs/` 里用新库写。验收时只在临时副本里改 import 核对。

## 风险

1. **qrenderdoc 的 Python 是 3.8。** 移植过去的提取脚本要去掉 3.9 以上的写法，验收必须在 qrenderdoc 里实际跑，不能只在本机 Python 里测。
2. **服务层接口随 MCP 变。** `rdc/bridge.py` 依赖 `renderdoc_worker` 的 `ReplayContext`、`RenderDocFacade`、`RequestHandler`；改这三个时要同步，MCP 的 README 写明这层依赖。
3. **案例表收不住个案。** 有些回放的特殊处理（定符号、注入 R、反推缺帧的 dt、世界矩阵公式）是一次性的，硬塞进通用参数会让库变复杂；所以留了钩子，钩子从原脚本搬，不改写。
4. **并行会话还在拷工具。** P4d、P5 的会话在用旧做法；这个计划不改它们的目录，新工具落地后新步骤改用，旧目录留着。
5. **回放和产品内部 API 绑得紧。** 模拟器接口一改（比如 P4c 步骤 1 的 `prewarm({ world })`），案例和钩子都要跟着改；`regress` 能第一时间报出来，但修要人做。
6. **删 `ignore/RenderDocMCP` 不可逆。** 只在用户确认、`kbp rdc` 验收通过之后做。

## 实施记录

### 第 1 批 — 骨架、取真值、语料读取（2026-11-10）

子代理实现，Claude 独立验收。只新建了 `.claude/skills/kbp-tools/`，另由 Claude 在 `.claude/mcps/wpe-renderdoc/README.md`「结构」后补一段 `kbp-tools` 对服务层的依赖（风险 2）。

- **新增**
  - `SKILL.md`：协议（数据目录、FR / CLK / CLK_PTR、`[kbp]` 日志、`kbp-meta.json`、轨迹三种形状、整帧图与统计量、时间线规则摘要并指向 `timeline.ts`）与本批命令。
  - `kbp.py`：唯一入口，同时充当包 `kbp`（`__path__` 指向 `py/`），脚本可 `from kbp import content`。
  - `py/common.py`（路径、带层的错误、一行 JSON 摘要）、`py/rdc_host.py`（本机侧：算输出、拒绝覆盖、拉起无窗口的 qrenderdoc、转进度、超时只结束自己拉起的那个）、`py/content.py`。
  - `rdc/main.py`（qrenderdoc 里的入口，全部退出走 `os._exit`，看门线程握着 `kbp.py` 的进程句柄）、`rdc/bridge.py`（`LocalBridge.call`，返回值先过一遍 JSON，同旧桥）、`rdc/track.py`、`rdc/frame.py`、`rdc/stats.py`、`rdc/util.py`。
  - `tests/accept1.py`：可重复的验收自测。
- **命令：** `kbp rdc track|frame|stats <抓帧目录> <标签> …`（公共参数 `--data`、`--out`、`--overwrite`、`--timeout`、`--quiet`、`--keep-work`），`kbp content projects|resolve|ls|cat|grep`。

和计划不同、或计划没写、由子代理按证据定的：

- **`track` 保留两种输出形状：** 现有 `rd-p4d-*.json` 是逐次绘制原样保存（`rdc_rope.py`），其余是每粒子一行；`kbp-meta.json` 里没有能区分的标记（`gen_d.py` 注明 P4d 全部用 `rdc_rope.py`，含不是绳的模块工程），所以 P4d 工程要显式加 `--draws`。没有 meta 的老工程自动退回 `rdc_track.py` 的认法。第 2 批的生成库在 meta 里写一个标记，让它自动选。
- **`[工程]` 可省略**，从标签 `<工程>-fps<N>` 推出。
- **缺省拒绝覆盖**：缺省数据目录 `ignore/p4` 里是真值，覆盖要 `--overwrite`。
- **统计量的真值在 `ignore/p4/b3/out/`**（`ignore/p4/out/` 下没有 `wpe-*-stats.json`）；缺省输出位置仍是 `<data>/out/`。
- **`frame --present` 的文件名统一成 `wpe-<标签>-f<RenderDoc 帧号 + 1>`**，缺省取法的索引行与 `wpe_rt.py` 的键相同。
- **写 JSON 用 `json.dumps` 一次写出**：内嵌 Python 的 `json.dump` 走纯 Python 编码器，3 MB 的绳轨迹要写约 19 s；改后整组 30.8 s → 12.2 s，文本相同。
- **`content projects` 按 `source` / `type` / `pkg` 筛**；旧 `scan_misc_lib.projects()` 等于 `--source default` 加 `--source workshop --pkg`。

验收结果（输出在 `ignore/kbp/accept1/`，汇总 `report.json`）：

| 项 | 结果 |
|---|---|
| `track` | 8 组和 `ignore/p4/tracks/rd-*.json` 文件逐字节相同：按粒子认的 `p4b`、`p4b-color`、`p4c-cp`、`p4c-sprite`（四角，含 NaN）、`p4c-world`（指针），按绘制认的 `p4d-rope`，老认法的 `p4-0`（`fps60`）、`p4a2`。新旧服务层源码本来逐字节相同 |
| `frame` | 缺省取法 `p4b-color`、`b1-2854083091` 各 3 帧逐像素相同；`--event 181` 相同；`--present` 的 4K PNG（`A:\bedroom\enabled`）与 `p3b/compare` 的结果相同，浮点 DDS（`A:\bedroom\highres`）逐字节相同 |
| `stats` | `b3-1504316159`、`b4-3778549173` 文件逐字节相同 |
| `content` | `projects` 与 `scan_misc_lib.projects()` 相同（155 个、顺序一致）；`cat` 的 3 个 `scene.pkg` 条目（含二进制 `.tex`）与 `pkg_extract.py` 逐字节相同；`resolve` 五种写法与旧 `driver.py` 的 `resolve_project` 相同 |
| 不影响别的进程 | 起的 qrenderdoc 没有任何窗口；用户开着的 RenderDoc 界面、MCP 的回放进程、WPE 前后不变；两个 `kbp rdc` 并行互不影响 |
| 耗时 | qrenderdoc 就绪 2.0–3.2 s；每张抓帧 `track` 0.6–2.0 s、`frame` 0.8–2.1 s、`stats` 0.8–1.7 s；完整自测约 2 分钟 |

Claude 独立验收：

| 项 | 结果 |
|---|---|
| 改动范围 | 只有 `.claude/skills/kbp-tools/` 新文件；`ignore/` 已有文件、`apps/`、`.claude/mcps/` 子代理都没碰 |
| 读码 | 本地桥只调 `RequestHandler.handle`、错误照旧桥抛；qrenderdoc 入口全部 `os._exit`、父进程没了自己退；超时按 `Popen` 句柄只结束自己的进程；输出存在时拒绝 |
| 另挑两组没验过的抓帧 | `p4c-attract-fps10`（两遍模式，按粒子认）、`p4d-ropetrail-fps10`（`--draws`）提取到 scratchpad，和 `ignore/p4/tracks/` 里的文件逐字节相同；耗时 7.6 s、12.2 s |
| 自测重跑（输出到 `ignore/kbp/accept1-claude/`） | 27 项全过，用时约 127 s；没有出现界面窗口、没有残留进程，覆盖保护拒绝写 `ignore/p4/tracks/` |
