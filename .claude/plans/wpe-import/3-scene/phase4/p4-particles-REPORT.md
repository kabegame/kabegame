# P4 粒子报告

WPE 2.8.42，`wallpaper64.exe` SHA-256 前缀 `40e2ce02`。工程和工具在 `ignore/p4/`（不入库），抓帧在 `A:\p4-0\`。计划见 [phase-4-0-tools.md](phase-4-0-tools.md)。逆向的完整记录和地址在 [rea-framework.md](rea-framework.md)（框架）和 [rea-p4a.md](rea-p4a.md)（层级和档 1 模块），快照在 `ignore/p4/rea/`。

证据等级：**实测**是抓帧读到的值；**读码**是 REA 读到代码，代理做的，其中 5 个常量和两遍判断的指令我直接从 exe 核对过。LWE 不算证据。

## 框架结论（2026-11-07）

| # | 问题 | 结论 | 证据 |
|---|---|---|---|
| T1 | dt 的来源 | 粒子用当帧的 `g_Frametime` 乘 `instanceoverride.rate`：`pos[f] = pos[f-1] + v·dt[f]`，不错帧 | 实测：差不超过 3e-7；读码 |
| T2 | dt 上限 | 帧时钟钳到 `[0.0001, 0.25]`，`g_Time`、`g_Frametime` 都是钳后的值。粒子路径不再钳。**LWE 的 `min(dt, 0.1)` 不存在** | 实测：dt 到 0.2084 都走满；`fps=5` 启动时连续三帧恰好 0.250000，`runtime` 严格加 0.25；读码 |
| T3 | 暂停 | `-control pause` 全局，只遍历普通壁纸表，`-playInWindow` 不受影响，`-location` 无效。暂停时 `pauseRate` 指数淡出，之后不再走帧。恢复时重置计时器，不补暂停时长，第一帧 dt 很小，然后爬回全速 | 实测：`g_Time` 在 9 s 以上的暂停里没有前进，恢复后第一帧 dt 0.000175，粒子每步仍等于 dt。爬升过程被抓帧的长帧打断，没有测到；其余读码 |
| T4 | 积分与步进 | `movement` 是半隐式欧拉：`v += g·h`、`x += v·h`、再按 drag 衰减。**设置 `fps` 在 1–20 时，整段 operator 每帧跑两遍，`h = dt/2`；否则一遍**。由设置决定，和当帧 dt 无关 | 实测：c = 0.75（fps 5、10、15、20）、1.0（21、30、60）；读码 |
| O1 | 帧内顺序 | 年龄增长与判死 → 序列帧 → 死亡处理 → 控制点 → 发射与 initializer → operator（一或两遍）→ 写顶点 → 子系统。新粒子出生当帧 `age = 0`，走完整个 dt | 新粒子首帧是实测；全序是读码 |
| O2 | 模块顺序 | operator、initializer 都保持 JSON 数组顺序，解析成字节流后原样执行 | 实测：`movement` + `capvelocity` 两种顺序第一步 300·dt 和 100·dt；两遍时 200·dt 和 100·dt，正好是预测值；两个 `lifetimerandom` 后写的生效；读码 |
| F1 | 每粒子字段 | 没有结构体，是 SoA：每列连续 float32，基础 17 列加 5 组按标志开关的列。没有加速度列 | 读码；顶点布局实测 |
| F2 | 模块私有状态 | 没有逐粒子的模块状态。`oscillate*` 的频率、相位、幅度都由**同一列每粒子随机数 `R`** 现算。模块级状态（发射累积余数等）在流记录里，每实例一份 | 读码 |

**风险 7：** 无旋转时，`genericparticle` 的几何着色器和项目 `particle` 的顶点展开，最终几何相同：`POSITION` 完全相同，四角 x 差严格为 0，只有角点顺序不同。旋转时两者本来就不同：`shimmering_particles` 的 `particle.vert` 把旋转乘了 `1 − smoothstep(−1, 1, z)`，z = 0 时是一半，屏幕角 -23.23° 对 -52.37°。这是着色器自己的算法，不是路径差异。P4a 要比的是我们翻译出的 `genericparticle` 顶点路径和 WPE 的 `gs_out`。

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

## 读码结论的实测核对（2026-11-07）

代理读码的结论，我逐项做了实验。**有一条被推翻：** 预热不受 `fps` 分支影响。

| 项 | 读码 | 实测 | 结果 |
|---|---|---|---|
| `movement` 的 drag | `k0 = pow(min(1, 0.025 / dt), 0.7) · dt`，每遍 `v *= 1 - min(drag · k, 0.99999988)` | `fps=15`、`fps=60` 残差 2.5e-4、1.7e-4。遍数写错 0.049、0.018；普通写法 `1 - drag·dt` 差 15、2.9 | 成立 |
| `oscillateposition` 两遍 | `sin(ω·t) − sin(ω·(t−h))`，两遍时 `t` 不变、`h` 减半 | `fps=10` 按两遍残差 1.5e-4，按一遍 2.5e-3 | 成立 |
| `oscillateposition` 的 ω | 没有明说 | **ω 就是 `frequency`，没有乘 2π**：按 2π·f 算残差 5–13 | 新事实 |
| `starttime` 步长 | `maxcount < 500` 时 0.05，否则 0.2 | 两档都对上 | 成立 |
| `starttime` 遍数 | 同样受 `fps` 分支影响 | **预热固定一遍**：按一遍差 0.001–0.009，按两遍差 2、9。推断是加载时 `fps` 还没抄过来，值为 0 | **读码错了** |
| 暂停 | 见 T3 | 见 T3 | 成立 |

**`starttime` 的步数要按 float32 算：** `starttime 2.5`、`rate 1` 时，粒子比 `g_Time` 多走 1.6（`maxcount 1`）和 1.8（`maxcount 500`）。按 float32 模拟 `while t < starttime` 正好得到这两个数：`0.05` 累加 50 次还小于 2.5，所以走 51 步，出生在第 20 步，受力 32 步；`0.2` 走 13 步，出生在第 5 步，受力 9 步。出生那一步也受力。模拟器的累加要用 `Math.fround`，否则差一步。

**还没测：** 旋转时我们翻译的顶点路径和 WPE 几何着色器的一致性，要等 P4a 有模拟器。`rot-gs` 的 `gs_out` 就是真值。

## P4a 语义的实测核对（2026-11-07）

工程 `ignore/p4/proj/p4a`、`p4a-fov60`，抓帧 `A:\p4a\`，读数脚本 `ana_a.py`。

| 读码结论 | 实测 |
|---|---|
| 世界矩阵 `W = W_parent · T · Rz·Ry·Rx · S`，弧度 | 5 个图层四角最大差 0.0001 像素，含三轴旋转、非均匀缩放、三层父链 |
| `alpha`、`color` 不继承，`visible` 继承 | 子层 alpha 1（父 0.25）；不可见分组的子层没有绘制 |
| 绘制按 `objects` 数组顺序，无内容分组不绘制 | 顺序一致，子在父前没有影响 |
| `parent` 指向不存在的 id 时当根节点 | 正常绘制 |
| 透视粒子 `d = (H/2) / tan(fov/2)`，`fov` 取 `perspectiveoverridefov`，默认 95 | `w` = 494.819、935.307，逐位相符 |
| 透视时 z = 0 平面和正交画面重合，相机在场景中心 | z = 0 位置和尺寸都不变；z = 300 放大 `d / (d − z)` = 2.5399，屏幕位置吻合。+z 朝向相机 |
| `instanceoverride`：`size`、`alpha`、`count`、`lifetime`、`speed`、`rate` | 尺寸 ×2、alpha 0.5、粒子数 48、跑到 x = 1900，全部吻合。`rate` 确实是整个模拟的时间缩放 |
| `instantaneous` 从累积余数里扣，之后要还债 | 突发 3 个后停 2.0 s，等于 `(1 + 3) / rate`，之后每 0.5 s 一个 |
| `oscillateposition` 的 ω 就是 `frequency` | y 振荡按 ω = 1 残差 2.9e-4，按 2π 残差 5 |
| 场景的风、重力键（`gravitydirection`、`gravitystrength`、`windenabled`、`winddirection`、`windstrength`）粒子路径不读 | 中性。`proj/p4a-wind` 是 `p4-0` 只改这 5 个键（重力 `0 1 0` × 50、风开、`-1 0 0` × 80），同一会话各抓 6 帧（`A:\p4a\wind\`）：两份对解析模型最大差 6.7e-5、1.9e-5（没有场景重力项）；16 个系统的 y 都不漂移，含 `drag`、预热、模块重力。场景重力若生效，每帧就会偏约 0.08 像素 |

| `oscillateposition` 的 y 比 x、z 多 `2π·R` 的时间偏移 | 成立。`proj/p4a2` 的 `osc-r`（频率 1、相位 0、`scale` 0–100、mask `1 1 0`）4 个粒子，由 x 的幅度反推 `R`（0.386、0.357、0.598、0.125），y 按 `T = 2π·R` 预测残差 3.4e-4–1.8e-3；`T = 0` 是 5.6–92，`T = π·R` 是 1.6–35。抓帧 `A:\p4a\p4a2`，读数脚本 `ana_oscr.py`。残差略过 1e-3 是因为年龄由日志的 6 位小数 dt 累加了 800 多帧 |

| 粒子对象运行中被隐藏：清空存活粒子；重新显示后照常发射、不重新预热（C8） | 成立。`proj/p4a-life` 的 `vis`（`starttime 10`、rate 2、v 100）`visible` 绑属性，经 `-control applyProperties` 隐藏再显示：隐藏前 42 个，显示约 3 秒后只有 7 个新粒子，年龄 0.13–3.13、间隔 0.5；重新预热的话会立刻有 20 个排到 x≈1100 |
| 运行中改 `instanceoverride`：存活粒子保留已有值，新粒子用新值，`rate` 每帧现算（C5） | 成立。`inst` 改 size ×2、alpha 0.5、rate 3、count 2、speed 2：已有 54 个仍是尺寸 10、alpha 1、出生时的速度；新的 10 个尺寸 20、alpha 0.5、速度 ×2；`rate` 立刻作用于全部粒子（旧 300、新 600 像素/秒，对照 100）；新粒子间距 50，对应发射率 rate×count。抓帧 `A:\p4a\life`，读数脚本 `ana_life.py` |

`sprite` 的 `upright`、`fixed` 朝向没读到，先报不支持。

`proj/p4a2` 同时带日志重抓了 `burst`、`inst`、`inst0`、`osc-y`（`tracks/rd-p4a2.json`、`out/p4a2-log.txt`），给步骤 3 的模拟器从加载开始回放。
