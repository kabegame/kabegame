# P4 粒子报告

WPE 2.8.42，`wallpaper64.exe` SHA-256 前缀 `40e2ce02`。工程和工具在 `ignore/p4/`（不入库），抓帧在 `A:\p4-0\`。计划见 [phase-4-0-tools.md](phase-4-0-tools.md)。逆向的完整记录和地址在 `ignore/p4/rea/findings.md`，快照 `ignore/p4/rea/wallpaper64-2.8.42-p4.rea-snapshot`。

证据等级：**实测**是抓帧读到的值；**读码**是 REA 读到代码，代理做的，其中 5 个常量和两遍判断的指令我直接从 exe 核对过。LWE 不算证据。

## 框架结论（2026-11-07）

| # | 问题 | 结论 | 证据 |
|---|---|---|---|
| T1 | dt 的来源 | 粒子用当帧的 `g_Frametime` 乘粒子 `speed`：`pos[f] = pos[f-1] + v·dt[f]`，不错帧 | 实测：差不超过 3e-7；读码 |
| T2 | dt 上限 | 帧时钟钳到 `[0.0001, 0.25]`，`g_Time`、`g_Frametime` 都是钳后的值。粒子路径不再钳。**LWE 的 `min(dt, 0.1)` 不存在** | 实测：dt 到 0.2084 都走满；`fps=5` 启动时连续三帧恰好 0.250000，`runtime` 严格加 0.25；读码 |
| T3 | 暂停 | `-control pause` 全局，只遍历普通壁纸表，`-playInWindow` 不受影响，`-location` 无效。暂停时 `pauseRate` 指数淡出（时间常数约 1/6 s），之后不再走帧。恢复时重置计时器，不补暂停时长，第一帧 dt = 0.0001，约 0.77 s 爬回全速 | 窗口不受影响是实测；其余只有读码，**恢复行为没有实测成**，见下 |
| T4 | 积分与步进 | `movement` 是半隐式欧拉：`v += g·h`、`x += v·h`、再按 drag 衰减。**设置 `fps` 在 1–20 时，整段 operator 每帧跑两遍，`h = dt/2`；否则一遍**。由设置决定，和当帧 dt 无关 | 实测：c = 0.75（fps 5、10、15、20）、1.0（21、30、60）；读码 |
| O1 | 帧内顺序 | 年龄增长与判死 → 序列帧 → 死亡处理 → 控制点 → 发射与 initializer → operator（一或两遍）→ 写顶点 → 子系统。新粒子出生当帧 `age = 0`，走完整个 dt | 新粒子首帧是实测；全序是读码 |
| O2 | 模块顺序 | operator、initializer 都保持 JSON 数组顺序，解析成字节流后原样执行 | 实测：`movement` + `capvelocity` 两种顺序第一步 300·dt 和 100·dt；两遍时 200·dt 和 100·dt，正好是预测值；两个 `lifetimerandom` 后写的生效；读码 |
| F1 | 每粒子字段 | 没有结构体，是 SoA：每列连续 float32，基础 17 列加 5 组按标志开关的列。没有加速度列 | 读码；顶点布局实测 |
| F2 | 模块私有状态 | 没有逐粒子的模块状态。`oscillate*` 的频率、相位、幅度都由**同一列每粒子随机数 `R`** 现算。模块级状态（发射累积余数等）在流记录里，每实例一份 | 读码 |

**T3 为什么没测成：** 桌面壁纸抓不到帧。窗口在，但 `presenting` 是 false，只在加载时画一帧。`playbackmaximized=run`、`playbackfullscreen=run` 都没用。用户说当时把显示器拔了，这很可能是原因，没有验证。这不影响底座，所以没有继续反复重启 WPE。

**风险 7（无旋转情形）：** 几何着色器和顶点展开的最终几何相同。`POSITION` 完全相同，四角 x 差严格为 0，只有角点顺序不同。旋转的情形没有测。

## 对 P4a 底座的要求

- **粒子存储：** 定长 float 列加标志开关，不需要模块级可变列。列表见下。
- **`R` 共用一列：** 同一粒子的各模块随机量彼此相关。要对齐 WPE 就不能各抽各的。
- **模块表：** 按 JSON 顺序逐条执行，不排序。
- **每帧流程：** 按 O1 的顺序。每遍 operator 开头把 `size`、`rgb`、`a` 重置为初始值，所以乘性模块跑两遍结果不变。
- **两遍模式：** 对应 WPE 的 `fps` 设置，要定 Kabegame 用什么判断（宿主帧上限 `maxFps` 默认 60）。
- **帧时钟：** `render/renderer.ts:393` 的 `frametime` 现在没有上限，要加 `[0.0001, 0.25]`。
- **写顶点：** 按槽序，跳过 `life == 0`，新粒子填洞。不是年龄序。
- **容量：** `maxcount` 向上取到 4 的倍数。

| 列 | 存在条件 | 出生默认值 |
|---|---|---|
| age | 基础 | 0 |
| lifetime（0 表示空槽） | 基础 | 1.0 |
| frame | 基础 | 0；`randomframe` 时等于 `R` |
| size、size0 | 基础 | size0 = 0.5，`sizerandom` 乘上去，所以 `40 → 20` |
| 旋转 x、y、z | x 基础，y、z 要 bit0，否则别名到同一列 | 0 |
| 角速度 x、y、z | bit1 | 0 |
| 位置 x、y、z | 基础 | 发射器写 |
| 速度 x、y、z | 基础 | 发射器写 |
| 上一步位置 | bit2 | 等于位置 |
| 颜色当前值 | bit3，否则别名到初始值 | 实例颜色 |
| alpha 当前值 | bit4，否则别名到初始值 | 实例 alpha |
| 颜色、alpha 初始值 | 基础 | 实例值 |
| `R` | 基础 | 区间随机数 |

标志来源：bit0 `rotationrandom`、`angularmovement`；bit1 `angularvelocityrandom`、`angularmovement`；bit2 `controlpointattract`（有条件）、`collisionquad`；bit3 `colorchange`、`remapvalue`；bit4 `alphafade`、`alphachange`、`oscillatealpha`、`remapvalue`。

## 顶点布局（实测）

| 路径 | 拓扑 | 步长 | 字段 |
|---|---|---|---|
| 内置 `genericparticle` | `PointList`，几何着色器展开成 6 个顶点 | 44 | `POSITION` 0；`TEXCOORD` 12（旋转 xyz、尺寸）；`COLOR` 28 |
| 项目自定义 `particle` | `TriangleList`，每粒子 4 个顶点、索引 `0 1 2 0 2 3` | 52 | `POSITION` 0；`TEXCOORD0` 12（角点 UV、旋转 z、尺寸）；`TEXCOORD2` 28（旋转 xy）；`COLOR` 36 |

## 顺带确认的事实

- **发射按帧成批：** 同帧的新粒子位置完全相同。数量是 `rate·dt + 累积余数`，受容量限制。发射用完整的 dt，不受两遍模式影响。
- **`util/white` 不是全白：** mip 0 是 255，mip 1–3 是 252。不透明粒子上屏是 249/255，因为 RGB 和 alpha 各乘一次：0.9882² = 0.9766。RenderDoc 回放的渲染目标和 PrintWindow 都是这个值，P4a 比颜色时要带这个系数。**没查：** 20 像素的粒子贴 32 像素的纹理，为什么读到的是纯 mip 1。
- **帧号：** 脚本帧号 = RenderDoc 帧号 + 1，对齐用脚本帧号。
- **深度：** 材质 `depthtest: disabled` 时 `depth_enable` 为 false；`shimmering_particles` 的材质没写，抓帧里是开的（`Greater`）、不写深度。归 P4f。

## 对比台验收

| 验收 | 结果 |
|---|---|
| 2 `linear` 对解析模型 | 7 组数据最大差 3.8e-5，限 1e-3，通过 |
| 2 `gravity` 对解析模型 | 6 组不超过 2.4e-4，通过。`fps=10` 是 **1.18e-3，略超**：模型只用一步反解初速度，x≈1900 时 float32 的精度 1.2e-4 除以 0.06 s 的 dt，初速度误差约 0.002，走 0.8 s 累积到这个量级。对全部帧做最小二乘时残差是 8.6e-5。P4a 的模拟器从出生算起，没有这一步 |
| 3 变异自检 | 速度改 1%（0.86）、dt 错一帧（5.1）、子步数写反（0.79、2.1、0.044）都报失败 |
| 4 PrintWindow 对 RenderDoc（同一次运行、同一批帧） | 见下表 |

| 字段 | `fps=10` 最大差 | `fps=60` 最大差 | 说明 |
|---|---|---|---|
| 位置 | 0.498 | 0.499 | 硬边四边形没有抗锯齿，只能精确到 ±0.5 像素 |
| 尺寸 | 0 | 0 | |
| 颜色 | 0 | 0 | |
| 透明度 | 0.0038 | 0.0027 | 除以纹理系数 0.976471 之后，约 1/255 |

**长程对比的阈值：** 位置 0.5 场景像素，尺寸 0，透明度 0.004。

## 工具用法

都在 `ignore/p4/`，用 `python -X utf8 -I` 运行。抓帧用 skill `wpe-renderdoc`。

| 脚本 | 作用 |
|---|---|
| `gen.py` | 生成测试工程 `proj/p4-0` |
| `sweep.py <fps>...` | 每档 fps 一轮：注入启动、开窗采样、抓帧、还原 |
| `run.py sample <标签>` | 开窗并 PrintWindow 采样，存 `out/<标签>.bin` |
| `rdc_track.py <目录> <标签>` | 抓帧 → `tracks/rd-<标签>.json`，要求 RenderDoc 开着 |
| `pw_track.py <标签>` | 采样 → `tracks/pw-<标签>.json` |
| `model.py <输入> <输出> --substeps n` | 按 dt 序列算 `linear`、`custom`、`gravity`。`--v-scale`、`--dt-shift` 用来改坏模型 |
| `cmp_track.py a b` | 按帧比较，超限退出码非 0。图像轨迹加 `--sort-x --alpha-gain 0.976471` |
| `ana_time.py`、`ana_order.py`、`ana_sweep.py`、`ana_o2.py` | 各框架问题的读数 |

## 只读到代码、没有实测

P4a 用到时再测：

- `movement` 的 drag：`k0 = pow(min(1, 0.025 / dt), 0.7) · dt'`，上限 0.99999988。现有测量 drag 都是 0。
- 两遍模式下 `oscillateposition` 的幅度：它用 `sin(ω·t) − sin(ω·(t−h))`，两遍时 `t` 不变、`h` 减半，和一遍结果不同。
- `starttime` 预热：固定步长，`maxcount < 500` 时 0.05，否则 0.2，也走两遍分支。
- T3 的恢复行为。
- 旋转时两条路径的几何。
