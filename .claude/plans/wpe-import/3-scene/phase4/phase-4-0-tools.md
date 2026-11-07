# P4-0 — 对比台与框架问题

> 上级：[phase-4-particles.md](phase-4-particles.md)。不改产品代码，工具放 `ignore/p4/`（不入库），结论写进新建的 `p4-particles-REPORT.md`。
> 这里只做各节共用的部分，模块公式、发射规律留给各节的步骤 0。

## 总体设计思路

P4-0 做两件事：搭好后面每节都要用的对比台，查清决定模拟器形状的三个问题（帧内和模块的执行顺序、每个粒子存哪些字段、时间步进）。

对比台的中心是轨迹文件。WPE 和我们两边都落成同一种文件，比较工具只比轨迹，不比图片。轨迹逐帧记 `g_Time`、dt，以及每个粒子的位置、尺寸、颜色、透明度和旋转。P4-0 还没有模拟器，我们这边先用解析模型：几十行公式，算匀速和匀加速粒子在给定 dt 序列下的轨迹。P4a 有了模拟器后只换来源，工程和比较工具都不变。

WPE 一侧有两个来源，各管一段。RenderDoc 读绘制时的顶点和常量，数值精确，但一次只有十来帧。PrintWindow 从窗口出现起连续采样，能覆盖全程，但只能从像素反推。测试放在 `-playInWindow` 窗口里，两个来源看的是同一次运行，再用 `FR` 帧号对齐。这样同一批帧上有真值，图像测量的误差是量出来的，长程对比的阈值按它定。

第一个关键决策是**按 dt 序列重放，不按时间对齐**。发射量化取决于每帧的 dt，两边 dt 不同就不可能逐帧一致。所以轨迹带上这次运行的 dt 序列，我们这边按同一个序列计算，也就不再需要相位扫描。

第二个决策是**一个工程装全部测试系统**：每个系统一种颜色、一次绘制，一组抓帧回答全部问题，用户不用反复换工程。系统默认用内置 `genericparticle`，走 WPE 的几何着色器路径；再放一个项目着色器的系统走顶点展开路径，两条路径的几何比一次，这对应总计划风险 7。

框架问题以 REA 读 `wallpaper64.exe` 定答案，LWE 只给假设，抓帧给判据。这里不造卡帧内容：长帧用抓帧本身带来的停顿，暂停用 `-control pause`。

## 现状锚点

**a. 抓帧已能读到每个粒子**（2026-11-07 经实际桥接读，`get_mesh_data`）

| 路径 | 样本 | 拓扑 | 顶点 | 其它 |
|---|---|---|---|---|
| 项目自定义 `particle`（`#if HLSL_GS40_DISABLED`，未定义） | `A:\shimmering-particles\enabled\enabled-frame1282.rdc`，事件 22 | `TriangleList`，1200 个索引 = 200 个粒子 × 6 | 步长 52，每粒子 4 个顶点，索引 `0 1 2 0 2 3` | 无几何着色器；深度测试开、不写深度、`Greater`；不剔除 |
| 内置 `genericparticle`（`#if GS_ENABLED`） | `A:\32868-ghost-rider\highres\highres-frame137.rdc`，事件 141 | `PointList`，8 个粒子 | 步长 44，每粒子 1 个顶点 | 几何着色器展开成 48 个顶点 = 8 × 6，不带索引 |

```text
顶点展开：POSITION 偏移 0，TEXCOORD0 偏移 12（角点 UV、旋转 z、尺寸），TEXCOORD2 偏移 28（旋转 x、y），COLOR 偏移 36
几何着色器：POSITION 偏移 0，TEXCOORD 偏移 12（旋转 xyz、尺寸，`particle.vert` 的 `in_ParticleRotation`），COLOR 偏移 28
角点 UV 的顺序不同：顶点展开 (0,0)(0,1)(1,1)(0,0)(1,1)(1,0)，几何着色器 (0,0)(0,1)(1,0)(0,1)(1,1)(1,0)
```
现有抓帧都是不连续的帧，所以读不到连续 dt。样本也不是确定性工程，判不了顺序和积分。

**b. 帧号已有现成做法**（`ignore/p3c/wpe-general/gen.py:66`）
```python
FR_COLOR = r"""'use strict';
let frame = 0;
export function update(value) {
	frame++;
	value.x = (frame % 256) / 255;       # 现状：帧号写进色块，低 8 位在 R，高 8 位在 G
	value.y = (Math.floor(frame / 256) % 256) / 255;
	value.z = 1;
	return value;
}
"""
```

**c. 采样工具**（`ignore/p3c/wpe-general/wpe.py`、`sampler_pw.py`、`ignore/p3c/step4/accept/w1080.py`）
```python
MAIN_PID = 36548                         # 现状：写死，WPE 重启后要改
def open_win(project, name, w=960, h=540):
    path = os.path.join(HERE, project, 'project.json')
    ctl(f'-control openWallpaper -file "{path}" -playInWindow "{name}" -width {w} -height {h}')
```
`w1080.py` 已能开 1920×1080 客户区、窗口一出现就采样、画面变了才留。

**d. 我们的 dt**（`apps/wpe-scene/src/render/renderer.ts:393`；探针 `dev/probe.ts:216`）
```ts
const seconds = this.clock.seconds();
const frametime = this.lastTime === null ? 0 : Math.max(0, seconds - this.lastTime); // 现状：没有上限
```
```ts
scene.update({ time, frametime: 0, daytime: 0.5, pointer: [0.5, 0.5], pointerLast: [0.5, 0.5] }); // 现状：探针是单帧，没有步进
```

**e. LWE 的线索**（`ignore/linux-wallpaperengine/src/WallpaperEngine/Render/Objects/CParticle.cpp:191`，只作假设）
```cpp
float dt = g_Time - static_cast<float> (m_time);
dt = std::min (dt, 0.1f);                // 注释写的是防止模拟不稳定，不一定来自 WPE
// update(dt)：发射 → age += dt → 按数组顺序跑 operator → 动画帧
```

## 前置 — RenderDocMCP 修复（已完成）

本地 `ignore/RenderDocMCP`，2026-11-07 改完，扩展已安装，上面两张抓帧经实际桥接读过（包括 `gs_out`）。

- **新增** `get_mesh_data`（`vs_in`、`vs_out`、`gs_out`，可写 JSON）；`get_pipeline_state` 带顶点布局、顶点和索引缓冲、深度和光栅状态；`list_captures` 支持递归；常量带 `referenced`。
- **修改** `get_buffer_contents` 加 `event_id`、`output_path`。动态缓冲在帧内会变，要按事件读，超过 64 KiB 必须写文件。
- **修复** 整数和布尔常量被吞；客户端不核对响应 id；服务端非原子写；UAV 字段和 `slot` 的错误。

## 点 1 — 测试工程（`ignore/p4/gen.py` → `ignore/p4/proj/p4-0/`）

- **新增** `gen.py`，复用 `ignore/p3c/wpe-general/gen.py` 的 `write_json` 和 `FR_COLOR`。场景 1920×1080，`bloom: false`、`hdr: false`，黑底清屏。
  > 说明：全部随机范围 min = max。纹理用 `util/white`，硬边，图像测量能定到亚像素。
```python
def fixed(name, value):
    return {'name': name, 'min': value, 'max': value}

def system(rgb, origin, *, lifetime=8, size=40, velocity='100 0 0', rate=1, maxcount=1,
           operators=({'name': 'movement', 'gravity': '0 0 0'},), material='white'):
    return {
        'maxcount': maxcount,
        'material': f'materials/particle/{material}.json',
        'emitter': [{'name': 'sphererandom', 'origin': origin, 'distancemin': 0, 'distancemax': 0, 'rate': rate}],
        'initializer': [fixed('lifetimerandom', lifetime), fixed('sizerandom', size),
                        fixed('velocityrandom', velocity), fixed('colorrandom', rgb)],
        'operator': list(operators),
        'renderer': [{'name': 'sprite'}],
    }
```
- **新增** 测试系统。行距要足够大，轨迹互不重叠：

| 系统 | 颜色 | 配置 | 回答 |
|---|---|---|---|
| `linear` | 红 | 默认 | T1、T2、T3；解析模型的对照 |
| `birth` | 绿 | `lifetime 0.2`、`rate 20`、`maxcount 8`、尺寸 12、速度 `400 0 0` | O1：`fps=60` 的 10 帧只有 0.17 s，`rate` 要够高才抓得到出生帧 |
| `gravity` | 蓝 | 初速 0，`gravity '100 0 0'`（沿 x，留在自己这一行），寿命 6 |
| `gfirst` | 淡蓝 | 初速 0，重力 1000，寿命 0.3：新粒子第一步直接给出 c，不用解初速度 | T4 |
| `o2-cap-ab` / `-ba` | 绿 / 粉 | `movement`、`capvelocity` 两种顺序，初速 300，上限 100 | O2 |
| `o2-init-ab` / `-ba` | 紫 / 暗绿 | 两个 `lifetimerandom` 两种顺序 | O2 | T4：积分方式和子步 |
| `order-fade-ab` / `-ba` | 黄 / 青 | `alphafade`、`oscillatealpha` 两种顺序 | O2 |
| `order-move-ab` / `-ba` | 品红 / 橙 | `movement`、`oscillateposition` 两种顺序 | O2 |
| `custom` | 白 | 同 `linear`，材质用项目着色器 | 顶点展开和几何着色器的几何是否一致 |

- **新增** 两个辅助图层：
  - `FR`：`solidlayer` + `FR_COLOR`，帧号进色块。
  - `CLK`：小图层，项目着色器让 `g_Time`、`g_Frametime` 真的参与输出。
    > 说明：着色器没读的常量 `referenced` 为 false，值是垃圾，不能当数据。
- **新增** 脚本每帧记 `engine.frametime`、`engine.runtime`，每 50 帧用 `console.error` 写一批到 `log.txt`（`console.log` 不写文件，p3 已验证）。

## 点 2 — 轨迹格式与 WPE 提取器（`ignore/p4/track.py`、`rdc_track.py`、`pw_track.py`）

- **新增** 轨迹格式。缺的字段写 `null`，比较时跳过。
```json
{
  "source": "renderdoc",
  "project": "p4-0",
  "fps": 60,
  "frames": [
    {
      "frame": 1234,
      "time": 123.4567,
      "dt": 0.0167,
      "systems": {
        "linear": [{ "pos": [300.5, 200, 0], "size": 40, "color": [1, 0, 0], "alpha": 1, "rot": [0, 0, 0] }]
      }
    }
  ]
}
```
- **新增** `rdc_track.py`：逐个打开 `A:\p4-0\<fps>\*.rdc`，读全部系统的绘制。
  - 批量经 `ignore/RenderDocMCP/mcp_server/bridge/client.py` 的 `RenderDocBridge.call`，不逐个手调工具。
  - 顶点用 `get_mesh_data` 的 `vs_in`，写 `output_path`。两条路径分开解码：几何着色器每粒子 1 个顶点，顶点展开 4 个顶点折成 1 个粒子。
  - 风险 7 比最终几何：几何着色器读 `gs_out`，顶点展开读 `vs_out`，都转回场景坐标，按角点 UV 配对（两边的角点顺序不同）。
  - 绘制到系统的对应靠图层顺序，用颜色复核。
  - `g_Time`、`g_Frametime` 读 `CLK` 的常量，只认 `referenced: true`；帧号读 `FR` 的颜色常量。
- **新增** `pw_track.py`：按颜色分割，取连通块。
  - 质心 → `pos`，边长 → `size`，峰值 → `color`、`alpha`，`rot` 为 `null`。
  - 窗口图转场景坐标沿用 `layout.py` 的做法，偏移用 1920×1080 窗口重新标定。
  - `FR` 色块给帧号，`log.txt` 给 dt。

## 点 3 — 解析模型与比较工具（`ignore/p4/model.py`、`cmp_track.py`）

- **新增** `model.py`：读工程 JSON 和一条轨迹的 dt 序列，输出同格式轨迹。只算 `linear`、`gravity`，起点取轨迹第一帧，只推算之后的帧。`gravity` 给显式欧拉、半隐式两种预测，供 T4 比较。
```python
def linear_track(first, velocity, dts):
    pos = first
    for dt in dts:
        pos = pos + velocity * dt
        yield pos
```
- **新增** `cmp_track.py`：按 `frame` 配对，同一系统内按数组顺序配对。
```text
cmp_track.py a.json b.json --pos 0.001 --size 0.001 --color 0.002 --alpha 0.002
```
  > 说明：输出每个字段的最大差、平均差和第一处超限的帧，超限时退出码非 0。P4a 的粒子多于一个时，配对规则随数组顺序的结论调整。

## 点 4 — 框架问题

- **新增** 查下面八项，结论写进 `p4-particles-REPORT.md` 的「框架结论」。每条写结论、证据来源、置信度，查不到就写未知。

| # | 问题 | LWE 假设 | 判据 |
|---|---|---|---|
| T1 | dt 的来源，粒子时钟和 `g_Time` 是不是同一个 | `g_Time` 之差 | `linear` 的 Δx / v 和 `g_Frametime`、Δ`g_Time` 逐帧比 |
| T2 | dt 上限 | 0.1 s | 抓帧造成的长帧上，Δ`g_Time` 超过 0.1 时 Δx / v 是否被截断；REA 找常量 |
| T3 | 暂停 | 无 | `-control pause` 3 s 后 `play`：`g_Time` 是否冻结，恢复后第一帧的 Δx |
| T4 | 帧率与积分 | 显式步进 | `gravity` 在 fps 10、60 下的位置差，和显式欧拉、半隐式、定长子步三种预测比 |
| O1 | 帧内顺序 | 发射 → age → operator | `birth` 新粒子第一帧的位置和 alpha；REA 读更新函数 |
| O2 | operator 顺序 | JSON 顺序 | `order-*` 两组顶点是否不同；REA 读构建函数 |
| F1 | 每粒子字段 | `ParticleInstance` | REA 读粒子结构的步长和偏移，对照顶点布局 |
| F2 | 模块私有状态 | `oscillate*` 的参数存在粒子上 | REA：固定字段，还是按模块分配 |

P4a 依据这些结论定三件事：TypedArray 的字段划分、`update` 的顺序、时钟怎么接。

REA 从 `C:\Users\Lenovo\AppData\Local\Temp\claude\D--Codes-kabegame\c8271d84-73cd-4aa5-9671-97463ce1e6cd\scratchpad\wallpaper64-2.8.42-sync.rea-snapshot` 接着做，入口是名称表 `0x14048fa00`。先核对二进制的 SHA-256 前缀仍是 `40e2ce02`。

## 点 5 — 文档

- **新增** `p4-particles-REPORT.md`：框架结论、误差标定、工具用法。

## 抓帧（已完成，2026-11-07）

手工步骤换成了 skill `wpe-renderdoc`（`.claude/skills/wpe-renderdoc/`），用户只需要在开始前退出 WPE。

| 数据 | 位置 | 内容 |
|---|---|---|
| `fps=10` | `A:\p4-0\fps10\`，帧 198–207 | 10 帧连续，10 个绘制，1920×1080 |
| `fps=60` | `A:\p4-0\fps60\`，帧 800–809 | 10 帧连续，10 个绘制，1920×1080 |
| PrintWindow 序列 | `ignore/p4/out/fps10.bin`、`fps60.bin`，日志 `*-log.txt` | 和抓帧同一次运行，含一次 3 s 暂停（`pause-fps*.json`） |

读数和结论见 [p4-particles-REPORT.md](p4-particles-REPORT.md)。

## 执行顺序

全部完成（2026-11-07），结果在报告里。

1. 工程和抓帧。
2. 点 2、点 3 的提取器、解析模型和比较工具。
3. 扫 `fps` 5、15、20、21、30 定两遍模式的边界（T4）；加不可交换的组合测 O2。工程把 `FR`、`CLK` 挪到了右下角。
4. REA 交子代理，常量和判断指令我从 exe 核对过。

5. 读码结论逐项实测核对：drag、`oscillateposition`、`starttime`、暂停，结果在报告「读码结论的实测核对」，其中预热的遍数被实测推翻。

## 验收

1. `p4-0` 在 WPE 里全部系统都出现，`log.txt` 没有着色器错误。
2. `linear`、`gravity` 的 RenderDoc 轨迹和解析模型逐帧比，位置差不超过 1e-3。超限要解释清楚才算过。
3. 变异自检：解析模型的速度改 1%、dt 序列错开一帧，比较工具都要报失败。
4. 同一次运行的同一批帧，PrintWindow 轨迹和 RenderDoc 轨迹相比，目标是位置差不超过 0.5 场景像素、颜色差不超过 1/255。实测误差写进报告，作为 P4a 起长程对比的阈值。
5. T1–T4、O1、O2、F1、F2 每条都有结论、证据来源和置信度，或明确写未知。
6. 恢复：WPE 正常运行，壁纸和 `config.json` 回到会话开始时的状态。

## 不做

- `rate`、`maxcount`、`starttime` 和发射量化的规律，归 P4a 步骤 0。
- 模块公式和默认值，归各节步骤 0。
- 我们这边的轨迹探针，随 P4a 的模拟器一起做。

## 风险

1. **RenderDoc 的活动窗口：** 新实例可能自动加载桌面壁纸，出现两个交换链。所以先关桌面壁纸再开测试窗口。还抓错的话，退回把测试工程放到桌面，这时抓帧是 3840×2160，图像测量改用抓帧的后备缓冲做标定。
2. **抓帧打乱时序：** 被抓的帧本身是长帧，不代表正常 dt。T2 正好要用这些长帧，T1 的基线要用 PrintWindow 的长程序列和脚本日志。
3. **首次发射时刻未知：** `rate: 1` 的第一个粒子什么时候出现要等 P4a。所以解析模型从轨迹第一帧起算，不从场景加载起算。
4. **`movement` 可能带默认阻力：** 匀速公式对不上时先查字段默认值。公式属于 P4a，但差异要在这里解释掉。
5. **极端配置可能走特殊分支：** `sphererandom` 距离为 0、`maxcount` 1 都不是常见写法。`linear` 不符合直觉时，加一个普通配置的系统对照。
