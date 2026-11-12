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

## P4b 语义的实测核对（2026-11-08）

读码在 [rea-p4b-modules.md](rea-p4b-modules.md)、[rea-p4b-render.md](rea-p4b-render.md)。工程由 `ignore/p4/gen_b.py` 生成：`proj/p4b`（模块）、`p4b-emit`（发射）、`p4b-tex`（纹理与帧表）、`p4b-refract`（折射）、`p4b-color`（`colorn`）、`p4b-cp`（控制点）。抓帧在 `A:\p4b\`，`sweep_b.py` 一次会话抓完。fps 60 每个工程都抓，`p4b` 另抓 fps 10。轨迹在 `tracks/rd-p4b*.json`，由 `rdc_track_b.py` 提取：它按 `kbp-meta.json` 认系统，颜色会变的系统按绘制顺序认，并保存厚格式的 `TEXCOORD1`。帧时间日志在 `out/p4b*-log.txt`。

| 读码结论 | 实测 | 结果 |
|---|---|---|
| alpha-priority（头标志 0x80000）运行时不读 | 同一张 RG88 纹理，复制一份去掉标志位，粒子和图像层各放一对：3 帧都是 0 个像素不同（`cmp_ap.py`） | 成立 |
| R8、RG88 按原格式上传，通道换算靠着色器的 `TEX0FORMAT` | 图像层没有换算：R8 显示 `(r, 0, 0, 1)` 的红色，RG88 显示 `(r, g, 0, 1)`；粒子换算后 R8 白、RG88 灰 | 成立（逐像素比较在步骤 1） |
| NPOT 纹理的粒子 UV 不缩放 | 图像 598×720、纹理 1024² 的 x 光片，只画在四边形左上部分 | 成立 |
| 帧表顶点 `TEXCOORD1 = (速度, frame 原值)`，引擎不取 frac | xyz 是 `130 0 0`；`sequencemultiplier` 为 1、2、3 时同一年龄的 frame 是 0.4692、0.9384、1.4077，大于 1 不回绕；`randomframe` 是 0.897 | 成立 |
| 折射快照在每个折射对象画之前拷一次，存活数为 0 不拷 | 每个 `REFRACT` 对象前面都有一次 `ResolveSubresource`，`CUTOUT` 对象前面没有；第 906 帧 `P0` 没有存活粒子，既没有绘制也没有拷贝（`rdc_events.py`） | 成立。拷贝是 Resolve，说明 WPE 场景目标开了 MSAA，步骤 5 比较边缘时要注意 |
| `colorn`（`ana_color.py`） | 7 组逐位吻合：没有颜色模块时直接作颜色；单色按 HSV 平移；`color` 的 0–255 写法；和系统色差 < 0.0035 不生效；系统 `flags` bit3 不生效；两个 `colorrandom` 取后一个作系统色；区间两端各自平移后再插值（拟合残差 0）。工程是 `version 3`，这 7 组走的都是「平移后再乘 `colorn`」那条路径，乘不乘在这几组里看不出差别（rea-p4b-render.md 7.4 第 4 小节） | 成立 |
| `colorchange` 加 `colorn`：两端各自平移 | 起始色平移后 `(0, 1, 0)`，和预测一致；终止色实测 `(0, 0, 0)`，预测 `(1, 0, 0)`（`ana_cchange.py`，9 个粒子按年龄拟合） | 当时判「推翻」，补读后更正（2026-11-08，rea-p4b-render.md 7.4）：0xc 记录照读码平移，终止色确为 `(1, 0, 0)`；工程是 `version 3`，`version` < 5 时置 `0x200000`，实例颜色 `colorn` = (0, 1, 0) 再乘上去，红通道成 0。步骤 6 补抓 `version 5` 的副本 `p4b-color5` 确认：`c-change` 为 (t, 1 − t, 0)，逐粒子差 ≤ 3e-8（phase-4b-tier2.md 步骤 6 实施记录） |
| `sizechange` 的两个值乘 `instanceoverride.size` | `size 2` 时，只有 `sizerandom` 尺寸 20；加上 `startvalue = endvalue = 1` 的 `sizechange` 后是 40 | 成立：两者叠用时按 `size²` 放大 |
| `turbulence` 不读 `phasemin` | 同一出生点，`phasemin` 0 和 5 的两个系统 6 帧位置逐位相同 | 成立 |
| `capvelocity` 的比例来自 `rsqrtps` | 截后速度 99.993 | 成立 |
| `vortex` 的 `flags` bit0 按到轴的距离 | 出生点 z 偏 100：柱形的轨迹和不偏移时相同，球形明显变小 | 成立 |
| `turbulentvelocityrandom` 用场景时间的一维噪声 | 整秒出生的粒子方向都接近 90°，和噪声在整数处为 0 一致 | 方向一致，定量在步骤 4 回放 |
| `delay`、`duration` | `delay 0.5`、`duration 1`、`rate 10`：10 个粒子，最早 0.6076、最晚 1.5057 出生 | 成立 |
| emitter `flags` bit1 | `rate 200` 时每帧正好 1 个，间隔就是帧时间 | 成立 |
| 周期发射 | 每周期 3 个突发加 4 个连续（`maxtoemitperperiod`），周期间隔 0.80–0.82 s（0.5 + 0.3，按帧量化）；突发后约 0.2 s 才开始连续发射（`instantaneous` 欠账）；`count 2` 时每周期 11 个，即 `instantaneous` 不乘 `count`，`maxtoemitperperiod` 乘 | 成立。满容量时计时冻结、逐帧量化留给步骤 3 回放 |
| `boxrandom` 逐轴独立，角块分布，速度沿出生方向 | `distancemin 50`、`distancemax 100`：100 个粒子全在角块里，横向距离 50.1–99.25；出生距离为 0 时走回退分支，速度沿 x、正负随机 | 成立 |
| 控制点 0 的 `flags 1` 跟随指针 | 跟随组的粒子出生在 (3195, 1174)、(3170, 1805) 等随时间变化的位置（光标在窗口坐标里的位置），参照组都在原点；`offset "100 50 0"` 整体平移 (100, 50) | 成立。`1838478131` 归 P4c |

留给各步回放核对、步骤 0 没有直接判断的：`turbulence`、`vortex` 乘的是 `k` 不是 `dt`（fps 10 的数据已抓）；三个噪声函数；`oscillatesize`；三个 `*change` 的曲线；`positionoffsetrandom`；`vortex` 的定量；周期发射的逐帧量化与满容量冻结；帧表和折射的像素。

## P4c 语义的实测核对（2026-11-08）

读码在 [rea-p4c-sim.md](rea-p4c-sim.md)（控制点、指针、`controlpointattract`、世界空间）和 [rea-p4c-render.md](rea-p4c-render.md)（`spritetrail`、`sprite` 朝向）。工程由 `ignore/p4/gen_c.py` 生成：`proj/p4c-cp`、`p4c-attract`、`p4c-world`、`p4c-trail`、`p4c-sprite`。时钟图层的着色器同时读 `g_PointerPosition`，`rdc_track_b.py` 把 WPE 当帧用的指针记进轨迹；标了 `corners` 的工程另读 `gs_out` 的四角。抓帧在 `A:\p4b\p4c-*`，fps 60 全抓，`p4c-attract` 另抓 fps 10。读数脚本：`ana_c.py`、`ana_c2.py`、`ana_ptr.py`、`ana_c_render.py`。

| 读码结论 | 实测 | 结果 |
|---|---|---|
| JSON 控制点的 `angles` 运行时不读 | 控制点 1 写 `angles "0 0 1.5708"`，出生点 (1060, 540)，即没有旋转 | 成立 |
| `locktopointer` 不存在 | `flags 0` 加 `locktopointer true`，出生点 (1060, 540)，不跟随 | 成立 |
| `instanceoverride.controlpointangleN` 旋转出生点（控制点 ≠ 0） | (960, 640) | 成立 |
| `instanceoverride.controlpointN` 替换 `offset`，不叠加 | `offset "100 0 0"`、覆盖 `"0 200 0"`：出生点 (1060, 740) | 成立 |
| 顶层系统上控制点 `flags 4` 走缺省更新，但忽略 `instanceoverride` 的控制点 | (1160, 540)：用 `offset`，覆盖没生效 | 成立 |
| 控制点 `flags 16` 没有读者 | 和 `flags 0` 的对照组出生点相同（差在发射方向的近似倒数抖动内） | 成立 |
| 本地系统里控制点 0 的角度不转出生点，但转 `velocityrandom` | 出生点本地 x 保持 100，速度变成 (0, 50) | 成立 |
| 控制点 `flags 2`：基准点是场景坐标 | 对象 `scale 2`、`angles 0.5`：出生点在场景 (200, 100)；对照组跟着对象落在 (1215.1, 907.3)，和公式一致 | 成立 |
| 指针：`g_PointerPosition` 就是客户区归一化坐标（y 向下、不钳制），跟随点 X = px·W、Y = (1 − py)·H | 指针 (1.4115, 0.7398) 那一帧，世界空间跟随粒子正好出生在 (2810, 281) = (1.4115·1920 + 100, (1 − 0.7398)·1080)；y 翻转的式子差 518 | 成立。光标在窗口外照样外推 |
| 指针点的 `offset` 被丢弃；本地系统乘 `inverse(W)`，世界系统不乘 `W` | 对象 `scale 2` 时，世界组和本地组的出生点正好差 100（本地组的 (100, 0) 经对象放大成 200）；`angles 0.7`、`scale 2` 的本地组偏移 (152.97, 128.84)，和预测一致 | 成立 |
| 世界空间：粒子存世界坐标，已发出的留在原地 | 对象由脚本平移、旋转，5 个世界空间粒子都落在出生时刻的 `W(t)·(100, 0)` 上（t ≈ 10、11、12、13、15 s，残差 ≤ 0.05）；本地对照组的顶点一直是 (100, 0) | 成立。注意脚本里图层 `angles` 是度 |
| 世界空间：发射器 `origin` 不经 `W` | 对象转 90°、`origin "100 0 0"`：世界组出生在 (1060, 540) | 成立 |
| 世界空间：速度、重力 | 世界组 `velocityrandom (50, 0)` 沿世界 +y 走；`movement` `flags 0` 时本地组的重力随对象转，`flags 1` 和世界组沿世界 −y | 成立 |
| `vortex` 读控制点的平移，不读它的 3×3 | 控制点 1 带 `controlpointangle1 "1.5708 0 0"`，粒子 z 一直为 0 | 成立。中心的定量留给回放 |
| `controlpointattract` 的 `flags` 缺省是 2（钳制开） | 不写 `flags` 和写 `flags 0`（`scale 1e6`）完全不同：前者在控制点附近往返，后者一帧冲到 3.6 万以外 | 成立 |
| `controlpointattract` 没有 `origin`，`offset` 不读 | 加了 `origin`、`offset "200 0 0"` 的组和基本组只差出生时的随机抖动（0.02） | 成立 |
| `controlpointattract` 的 `threshold` 严格小于；`scale` 为负排斥；`scale` 乘 `instanceoverride.speed` | 阈值外不动；排斥组越推越远；`speed 2` 组吸得更快 | 成立。`k`、删除判定、blend 的定量留给回放 |
| `spritetrail`：`L = max(minlength, min(|v|·length, maxlength))`，以粒子为中心沿速度拉长；缺省 `length 0.05`、`maxlength 10`、`minlength 0` | 12 组的长度都吻合（含 `maxlength` 截顶、`minlength` 托底、两者冲突时 `minlength` 胜）；`v = (60, 80)` 那组四角逐位吻合 | 成立 |
| 拖尾宽向依赖 `g_EyePosition`，离开视轴变窄 | 宽度 9.842、9.945 等，正好是 `10·2000/√(2000² + dy²)` | 成立 |
| 速度为 0 的拖尾、轴平行视线的 `upright` 算出 NaN，不画 | `gs_out` 四角是 NaN | 成立 |
| 一个系统同时有 `sprite` 和 `spritetrail` 时画两次，按数组顺序 | 两种顺序都是两次绘制，几何分别是 sprite 和拖尾 | 成立 |
| `sprite` 的朝向（`g_Orientation*`）：`screen`、`upright`、`fixed` 和 `flags` bit0 | 24 组四角全部吻合：`flags` 0、1、2、255 在对象不旋转时相同；`upright` 各轴、`fixed` 各轴（含缺省轴躺平、只认精确零）；对象转 0.5 弧度时 `flags 0` 随对象转、`flags 1` 保持直立 | 成立 |

留给各步回放核对的：`controlpointattract` 乘 `k`（fps 10 已抓）、删除判定、blend；`vortex` 读控制点的定量；透视粒子加拖尾（四角不对称，和「仍用场景眼位」一致）。

**步骤 5 补测（2026-11-09）**：工程 `proj/p4c-rot`（`gen_c.py`），对象带 x / y 旋转时 sprite 的朝向（步骤 0 的 S13 只有 z 旋转）。窗口 1920×1080 抓 3 帧（`A:\p4b\p4c-rot-fps60`），读数 `c5/rot_shape.py`、`c5/corners-offline.*`、`c5/live_corners.ts`。

| 问题 | 实测 | 结论 |
|---|---|---|
| 对象绕 x 转 0.6 时 `screen` sprite 的朝向 | 四边形是 40×40 的正方形，朝向相机；跟随对象的 `fixed` 是 40×33.01（cos 0.6） | 朝向按 7.2 现算（Gram-Schmidt 去掉视线分量），不是单位基 |
| 17 个系统的四角（含 `upright`、`fixed`、非均匀缩放、旋转对象上的拖尾、照抄 `shimmering_particles` 的三层透视粒子） | 我们离线（WPE 顶点输入）最大差 1.90e-4 像素，真机（自己模拟）6.87e-4 | 成立 |

**步骤 2 补测（2026-11-08）**：工程 `proj/p4c-ptr`（`gen_c.py`，8 个系统各 rate 60、寿命 0.05 s，比较帧里的粒子都在抓帧期间出生），窗口 1920×1080、1920×800、1440×1080 各抓 10 帧（`A:\p4b\p4c-ptr-fps60[-<尺寸>]`），抓帧时用户在窗口里移动了鼠标，指针每帧都变。读数 `ana_ptr2.py`，输出 `out/ana_ptr2.txt`。

| 问题 | 实测 | 结论 |
|---|---|---|
| 跟随点用本帧还是上一帧的指针 | 1920×1080：10 帧里每帧新出生粒子的跟随点和**当帧** `g_PointerPosition` 换算的 (px·1920, (1 − py)·1080) 差 ≤ 0.02，和上一帧的差几十像素 | 本帧 |
| 窗口和场景比例不同时，WPE 怎么铺 | 1920×800 的 `P·V` 纵向是 `1/400`、平移 −1.35，只显示场景 y ∈ [140, 940]；1440×1080 横向是 `1/720`、平移 −4/3，只显示 x ∈ [240, 1680] | 投影里居中盖满裁切（和 Kabegame 的 `fill` 相同），渲染目标就是窗口 |
| 裁切时跟随点 | 两种窗口下跟随点都等于 `inverse(P·V)` 作用在窗口 NDC 上（差 ≤ 0.02），即光标下的场景点；朴素的 px·1920 / (1 − py)·1080 差 12–45 像素 | 跟随点是光标下的场景点。`g_PointerPosition` 仍是窗口归一化坐标，和 P2a 对 `fill` 的取法一致 |

## P4d 语义的实测核对（2026-11-09）

读码在 [rea-p4d-rope.md](rea-p4d-rope.md)（`rope`、`ropetrail`）和 [rea-p4d-modules.md](rea-p4d-modules.md)（`mapsequence*`、`remap*`、距离类、`vortex_v2`）。
- **工程：** 由 `ignore/p4/gen_d.py` 生成，共 6 个：`proj/p4d-rope`、`p4d-ropetrail`、`p4d-map`、`p4d-remap`、`p4d-remap2`、`p4d-dist`。
- **抓帧：** fps 60 全抓，`p4d-map` 以外另抓 fps 10，在 `A:\p4b\p4d-*`。
- **读取：** `rdc_rope.py` 原样保存每次粒子绘制的 `vs_in`、`gs_out`、几何着色器的 `dcl_maxout` 和各阶段常量。
- **读数脚本**在 `ignore/p4/d0/`：
  - `ana_rope.py`：`rope_gs.py` 按 WPE 原件 `genericropeparticle.vert` / `.geom` 把 `vs_in` 展开，再和 `gs_out` 逐顶点比；
  - `ana_mod.py`：模块各项，噪声用 `fastnoise2.py`；
  - `rdc_cull.py`：光栅化状态；
  - `v2_variants.py`：`centerforce` 的几种写法。
- **RenderDoc 的格式：** `gs_out` 把三角形带展开成三角形列表，奇数号三角形写成 `(v1, v3, v2)`；颜色在 `TEXCOORD1`。

**rope**

| 读码结论 | 实测 | 结果 |
|---|---|---|
| WPE 画绳是 `POINTLIST` 加几何着色器，每段输出 `4 + 2·subdivision` 个顶点 | 所有绳的绘制都是 `PointList`，`dcl_maxout` 随 `subdivision` 0 / 3 / 4 / 16 / 40 是 4 / 10 / 12 / 36 / 68 | 成立，决定 1 的前提成立 |
| 每段 96 字节，内容按 1.3：<br>起点 + 尺寸、终点 + `TL`、`CP0` + `TP`、`CP1` + 终点尺寸、终点颜色、起点颜色；<br>首段 `CP0` 取起点自身，末段 `CP1` 取终点自身 | 16 个系统、两种 fps、各 6 帧，没有一处不符（`POSITION`、`TEXCOORD0`–`3`、`COLOR`） | 成立 |
| GS 展开按 1.5：<br>右向量；系数 0.15 的贝塞尔；`smoothstep` 之后的 `s`，计数器逐次累加；宽度、颜色、`v` 都按 `s` 插值 | 照 WPE 原件由 `vs_in` 算 `gs_out`：位置最大差 2.3e-4 场景像素，uv 差 1e-6，颜色逐位相同；R9 同帧出生的零长段，NaN 顶点数逐帧相同 | 成立 |
| 表序就是出生序，判死后保序删除 | 稳态下槽位已复用，绳上位置仍严格单调；R8 两个发射器，B 的粒子到 x ≈ 180 被删后，A(247) 直接接到 A(145)；同帧出生的按 emitter 顺序排 | 成立 |
| 缺省 `subdivision 4`、`uvsmoothing true`；平滑时 `TL = (N − 1)·K`，`TP0 ∈ [−1, 0]` | R2（只写名字）`maxout 12`、`TL 5.4`；`TP0` 每帧随最老粒子的年龄以 −4/s 变化，即 `Rf = 4` | 成立 |
| `uvscrolling`：`TL = N − 1`，`TP0` = 累计死亡数 | R3 `TL 5.4`，`TP0` 在有粒子死去的那帧从 54 变成 55；R12 带预热，是 62 → 63 | 成立 |
| `uvscale` 存倒数 | R4 `TL = 2·存活数` | 成立 |
| 存活数 2 的特例；存活数 ≤ 1 不画 | R5b `TL 2`、`TP 0`，`uvscale 0.5` 和平滑都不起作用；R5a（`maxcount 1`）没有绘制，R5b 存活数掉到 1 的帧也没有 | 成立 |
| `upright` / `fixed` 用 `g_OrientationForward`，u 左右对调 | R6u 的 Forward 是 (0, 0, 1)，u = 0 的顶点从下方换到上方，宽度正好 40；三种朝向的光栅化都是 `NoCull`，都画 | 成立，绳不剔除 |
| 离开视轴带宽变窄；世界空间时 `g_ModelMatrix` 是单位阵 | R10、R11 的 `gs_out` 和展开逐顶点吻合 | 成立 |
| 读 `fps`：绳没满时 `Rf = min(fps, R)` | 两种 fps 下抓帧时绳都已满（R9 存活 50–59，不小于 `R·L = 50`），走不到这一支 | 没测到 |

**ropetrail**

| 读码结论 | 实测 | 结果 |
|---|---|---|
| 每个粒子恒写 `segments` 段，76 字节；段 0 是「当前位置 → h[0]」；`CP` 取法按 5.3 | 12 个系统、两种 fps，没有一处不符 | 成立 |
| 计时器每系统一个，`≤ 0` 时重置为间隔，余量丢掉；每帧最多采一次 | `RV0.z` 每帧涨 `dt/间隔`。<br>T1 前一帧还剩 0.0127 s，采样后 `z = 0` 而不是 0.133。<br>fps 10 下 3 帧一采；`length 0` 每帧都采；两遍模式不影响 | 成立 |
| 采样时 `h[0]` = 本帧位置，段 0 零长；已存段数 +1，封顶 `segments` | 采样帧的段 0 零长，`gs_out` 里是 NaN；`C·K` 从出生时的 2 涨到 `segments`；未填满的段零长，也是 NaN | 成立 |
| 钳制：`segments` 到 `[2, 32]`，`subdivision` 到 `[0, 32]`，`length` 至少 0.001 | `segments` 0 / 40 → 2 / 32 段；`subdivision 40` → `maxout 68` | 成立 |
| `RV0.w = n − 0.5`；`uvscrolling` 时 `RV0.w = (n − 1)·K`、`RV0.x = n − 1` | T1 3.5，T4seg0 1.5，T4seg40 31.5；T2 `w 6`、`x 3`；`U` 每次采样 +1 | 成立 |
| `fadealpha` / `fadesize` 只在 `uvscrolling` 时起作用 | T3（开渐隐、不滚动）的 `gs_out` 和不渐隐的展开逐位相同；T2 的渐隐和展开吻合 | 成立 |
| 预热后历史塌缩到当前位置（T7） | T7 只比 T1 多一个 `starttime 1`；T1 正常，T7 在两种 fps 下的 20 帧里都没有存活粒子 | 没测到，原因待查 |

**mapsequence**

| 读码结论 | 实测 | 结果 |
|---|---|---|
| `around`：`θ = 2π(b0 + seq·Δb)`，`θ = 0` 在 +y、往 +x 转；保留出生点到轴的距离 | ma-basic / r40 / r160 的半径是 100 / 40 / 160，圈数正好是 {0, 0.2, …, 0.8}；例如 (0, 100)、(95.1, 30.9) | 成立 |
| 序号先用后加，1.0 不大于 1 所以留着；repeat 用 `fmodf`，mirror 反射；float32 推演见 1.1 | ma-22r、ma-22m 的全部圈数都落在推演序列上（差 ≤ 2e-4） | 成立 |
| 基向量：`axis "0 1 0"` 时 `B1 = (1, 0, 0)`、`B2 = (0, 0, −1)`；基向量乘 `mat3(cp)` | ma-axis 的 `\|y\| = 0`，(x, z) 的圈数吻合；ma-cp 圆心在 (300, 0)，圈数整体减 1/12（30°） | 成立 |
| `speed` 的 x 是切向、y 径向、z 轴向，加到速度上 | ma-speed 残差 0.023 | 成立 |
| `bounds` | ma-bounds 的圈数在 0.3–0.5 | 成立 |
| `between`：`step = 1/(count − 1)`，repeat 超过 1 归零 | mb-basic 正好 5 个 x 值（−300 … 300） | 成立 |
| 本地系统按系统原点量垂直分量，世界系统按起点量 | 本地组 y = −100，世界组 y = +100 | 成立 |
| `flags` 1 / 2 / 4 / 8 与 `w = 1 − (2seq − 1)²` | f1、f8 与公式差 0，f4 的尺寸差 1.9e-7；f2 两端的 y 正好是 100 | 成立 |
| mirror | mb-mirror 的 x ∈ {±100, ±300} | 成立 |
| `flags & 0x20`：周期发射的新周期清零序号 | period32 的 x 到不了 300，对照组 period0 能到 | 成立 |
| 对象不可见时复位、清零序号 | ma-hide 只看到粒子被清空（15 个对 20 个）；`count 5` 的序号是周期的，清零看不出来 | 没测到 |
| `around` 不解析 `flags`，记录 `rec+0x58` 是暂存区的残留值，bit0 决定 `count` 乘不乘 `instanceoverride.count`（2026-11-10 补测，wpe-renderdoc MCP 的测试窗口） | 工程 `p4d-around-ic` 照抄 `Cherry_Blossoms_2.json` 在 `around` 之前的模块序列，三个系统的 `count` 覆盖分别是 0.02、0.5、不覆盖。<br>先行解析了三种不同内容：用过一天的 WPE、刚开过 3487328036、刚开过 kabegame-sample。<br>三次里三个系统按出生先后的方向都是相邻差 0.2：乘了的话 0.02 那组会全在 θ = 0，0.5 那组相邻差 0.4 | 这三种情况下都是不乘。bit1（周期发射的新周期清零）没测，干净重启后的情况没测（`restart_wpe` 被权限拦下） |

**距离类与 `vortex_v2`**

| 读码结论 | 实测 | 结果 |
|---|---|---|
| `maintaindistancetocontrolpoint`：硬约束；`T = inverse(mat3(cp))` | md-hard 半径 200 ± 0.05；对象 `scale "2 1 1"` 时落在 400 × 200 的椭圆上（±3e-4） | 成立 |
| `Δcp = current − previous`，每遍都平移完整的 `Δcp` | md-move（世界系统，`variablestrength 0.001`，几乎只剩平移）跟着对象走：fps 60 每帧一倍，晚一帧；fps 10 约两倍（40/s），粒子越跑越靠前；对照组不动 | 成立 |
| `between` 两个控制点重合时整条跳过 | mb2-same 的轨迹是直线（残差 0.015） | 成立 |
| `reducemovementnearcontrolpoint` 的公式 | rm-basic 停在 L ≈ 48.2，正是 `h = 1/60` 时 `r·h ≥ 1` 的边界 | 成立 |
| `reductionouter == reductioninner` 时差存成 1.0 | rm-eq 按 0 实现也是 `100·h > 1`，照样一出生就停 | 分辨不了 |
| `vortex_v2` 切向是 `(r̂ × a)·spd·k` | sphere、cyl 每个粒子的 Δv 和公式差 ≤ 1.4e-3；换成 `h` 差 2.1–2.7 | 成立，sample-gaps 写的方向要更正 |
| 柱形掩码 | v2-cyl 出生点 z = 50，`spd` 按到轴的距离算 | 成立 |
| `centerforce`：`P′` 用 `h`，系数 `cf/h`；环形拉力 | 残差 0.4–1.8，在 `rsqrtps` 的误差包络里（`\|P′\|·3.7e-4/h`，约 1.3–2.2）；换成 `k` 的写法更差 | 成立（在包络内） |
| 轴乘控制点的 3×3 | v2-axis 的 `\|y\| ≤ 0.004` | 成立 |
| WPE 不可见时照常更新控制点 | dist-hide 重新可见后 1 s 才发出第一个粒子，第一帧没有粒子可拽 | 没测到 |

**remap**

| 读码结论 | 实测 | 结果 |
|---|---|---|
| `remapvalue` 的 `particlesystemtime` 就是场景时间 `T`，和 `runtime` 相同 | rv-time（对象 `instanceoverride.rate 2`）和用 `runtime` 的对照组，alpha 逐帧相同，都按 `T` 的 10 s 周期变 | 成立，语料 3 个系统用它 |
| `remapinitialvalue` 的 `particlesystemtime` 是系统时间 `sys+0x3f0`（乘 `rate`） | ri-time 的出生尺寸按 `T` 预测差 35；按系统时间拟合差 0.02，拟合出的系统时间每帧涨 `2·dt` | 成立 |
| `remapvalue` 的噪声是 FastNoise2 二维 Simplex：输入 `(v·s, 0)`，种子取每粒子 `R` 的位，y、z 分量的种子再异或两个常量 | rv-noise 输出速度三分量，每个粒子只有年龄一个未知数，用 frame 列读出的 `R` 算：两种 fps 下三分量的残差都 ≤ 4e-4（量程 ±100，年龄按 1 µs 细化搜索） | 成立 |
| FBm 的倍频（种子 +1、坐标 ×2、振幅 ×0.5、归一） | rv-fbm1 / rv-fbm3 输出的是标量 `speed`，年龄又未知，各种写法都拟合到 3e-4，没有区分力 | 没测到，留给步骤 4 的回放 |
| `remapinitialvalue` 的噪声是 `snoise1`，和 `R` 无关 | ri-noise / ri-fbm 同一时刻出生的粒子尺寸相同；`flags` 缺省夹到 1 后输入是整数 10，`snoise1(10) = 0`，尺寸正好 22.5 | 成立 |
| op 的 `square`、`saw` 用 `trunc`，init 用 `floorf`；init 的 `lifetimefraction` 读 frame 列（出生时为 0） | rv-square / rv-saw 的年轻粒子归一化后是负数，实测尺寸 40 / 29.5，用 `floor` 会是 75 / 64.5；ri-square / saw / triangle 恒为 40 / 40 / 5 | 成立 |
| `positionbetweentwocontrolpoints` 读的是 `outputcontrolpoint0` / `1` | 按 ocp 预测差 0.013，按 icp 差 10 | 成立 |
| 输出 `controlpoint`：该点不再按 `offset` 更新，只被 remap 改写 | rv-cpout 新粒子的出生点跟着 remap 的值走（残差 0.125），和 1 号点的 `offset (300, 0)` 无关 | 成立 |
| `remapinitialvalue` 输入 `controlpoint` 会把控制点写成 0（WPE 的 bug） | ri-cpbug 用 1 号点（`offset (300, 0)`）发射，出生点 x ∈ [40, 290]，即从 0 出发 | 成立，照做 |
| `distancetocontrolpoint` 输入、`multiply` | ri-dist 发射半径 25、`inputrangemax 50`，尺寸正好减半（4） | 成立 |
| 两遍模式下持久输出列的 `add`、`subtract` 一帧叠两次 | fps 60 每帧 Δrot 是 ±0.0308，正好是一遍的预测；fps 10 是 ±0.0632，是一遍预测 0.0316 的两倍；`remap` 只等于一遍的值 | 成立 |
| blend：`old + (op − old)·b` | rv-blend 寿命比例 0.5 以前 alpha 是 1，0.6 以后等于 rv-time 的值 | 成立 |
| op 的标量输入只用 x 分量归一化再铺满，init 按分量各自归一化 | rv-vec / ri-vec 设计时漏写了 `flags 0`，归一化被夹到 1，两种算法都得 50 | 没测到，留给步骤 4 |
| `remap2` 的全取值扫描（20 个输入、13 个输出，op 和 init 各一套） | 66 个系统每帧都画，没有加载报错 | 数据已抓，步骤 4 回放 |

**留给各步回放核对的：**
- `mb2-move` 的定量（fps 10 已抓）、`md-soft` 的收敛、`reducemovement` 在 fps 10 下的停止位置、`vortex_v2` 的两遍模式；
- FBm 的倍频细节、op 标量输入的归一化、`remap2` 的全部取值；
- R9 的读 `fps` 分支、T7 的预热（WPE 里一直没有存活粒子，原因待查）。

## P4e 语义的实测核对（2026-11-12）

读码在 [rea-p4e-children.md](rea-p4e-children.md)（子系统）和 [rea-p4e-audio.md](rea-p4e-audio.md)（`audioprocessing*`）。
- **工程：** `ignore/p4/defs/p4e0.py`（`kbp gen p4e0`），子系统 6 个：`proj/p4e-static`、`p4e-follow`、`p4e-event`（第一轮），`p4e-static2`、`p4e-follow2`、`p4e-event2`（第二轮，按读码的建议实验补）。子系统 JSON 另写进 `particles/`，`kbp-meta.json` 按绘制先序（父 → static → 事件实例）给子系统颜色条目，事件子系统给 `draws`。
- **抓帧：** 全部 fps 60，`p4e-static`、`p4e-follow`、`p4e-follow2` 另抓 fps 10，在 `A:\p4e\<标签>`，开窗约 12 s 后连抓 5 帧；`kbp rdc track` 按绘制认（`track: "draws"`），轨迹 `ignore/p4/tracks/rd-p4e-*.json`。
- **读数脚本**在 `ignore/p4/e0/`：`ana_draws.py`（每次绘制的粒子数、位置范围）、`ana_consts.py`（几何着色器的 `g_ModelViewProjectionMatrix`）、`ana_ages.py`（速度 (0, v) 的子系统按 y / v 读年龄，并换出实例的平移）。
- 子粒子的 `vs_in` 是子系统坐标，子系统的变换都在模型矩阵里；下文「平移」由 MVP 第 4 行换回场景坐标。

**static**

| 读码结论 | 实测 | 结果 |
|---|---|---|
| 局部矩阵 `L = T·Rz·Ry·Rx·S`，角度是弧度 | `s-xf` 条目 `angles "0 0 30"`、`scale "2 2 1"`、`origin "200 0 0"`：子系统 MVP 的 x 轴长 2.0、转 −81.13°（30 rad = 278.87°），平移 +200 | 成立 |
| 向量缺分量补 0 | `st-scale1` 条目 `scale "2"`：MVP 的 y、z 列全为 0 | 成立 |
| `type` 只认小写 `static` 等四个，其余整条忽略；缺 `type` 即 static | `st-type` 的 `"Static"` 条目没有绘制，同系统缺省类型的条目照画 | 成立 |
| static 不读 `probability`、`maxcount` | `s-p0`（`probability 0`）、`s-max`（`maxcount 3`）与缺省条目逐帧相同 | 成立 |
| 模拟与绘制 `M = 父栈顶 · L`；本地子系统粒子存子系统坐标 | `s-def` 等：子粒子在子系统原点发射，MVP 与父相同（`L` 为单位阵时）；父世界、子本地（`s-pw`）时子系统仍乘 `W` | 成立 |
| 世界子系统的预热用 `M = L`（不含 `W`） | `st-wwarm`（子 `flags 1`、`starttime 1`、`origin "200 0 0"`，对象在 (960, 540)）：预热出的粒子在场景 x = 200，运行时的在 1160 | 成立 |
| 子系统不跟父预热，按自己的 `starttime` | 子发射器 `duration 3`、速度 (0, 10)：`st-warmp`（父 2 s、子 0）子粒子年龄 9.82–12.63，发射窗口是运行时 0.19–3.0 s；`st-warmc`（子 2 s）年龄 11.87–14.72，窗口是预热 −1.9 s 到运行时 0.95 s，`duration` 把预热算在内 | 成立 |
| `instanceoverride` 作用到子系统，受子系统自己 `flags` bit3–7 约束 | `s-io`（`count 2`、`size 2`）子粒子 16 个、比缺省多；`st-io248`（子 `flags 248`）子系统不变、父 8 个 | 成立 |
| （读码没列）对象的 `rate` 是否也乘子系统的 `timescale` | `p4e-rate`（步骤 1 补测，fps 20，FR 每 10 帧刷日志）：对象 `rate 0.5` 下 static 子系统的 `turbulentvelocityrandom` 粒子与同参数顶层系统逐粒子位置完全相同（差 0），`rate 1` 的对照差几百像素 | 乘，rea-p4e-children 3.4 已更正 |
| 加载时对象的控制点覆盖到不了子系统 | `st-iocp`：子 cp1 `offset (100, 0)`、对象覆盖 `controlpoint1 (0, 200)`，子粒子全在 x = 100 | 成立（运行时改值后能到，没测） |
| 条目 `flags` bit1：父周期发射进入新周期时复位子系统 | `st-per2`（子 `duration 0.3`）每 2 s 重发一批，共 21 个；`st-per0` 只有开头 3 个 | 成立 |
| 父系统存活数为 0 照常更新、绘制子系统 | `st-parent0`（父 `rate 0`）子系统照画 | 成立 |
| 条目 `flags` bit0：父存活粒子按槽号写进子 `cp[startindex..]`，父本地坐标、不补偿 `L` | `st-cpw`（读 cp1、`origin "0 100 0"`）子粒子沿父的第二个存活粒子出生，画出来整体再上移 100 | 成立 |
| 嵌套上限 10 层 | `st-depth` 自引用：11 次绘制。第 8 层起平移跳到画面外（MVP 平移 (2, 2.33)），像是 WPE 的矩阵栈到深度上限；语料最深 2 层，不复刻 | 层数成立 |

**事件子系统**

| 读码结论 | 实测 | 结果 |
|---|---|---|
| 每个实例单独一次绘制，按建立先后；static 一律在事件实例之前 | `f-*` 每个实例一次绘制；`st-order` 的 JSON 先写 eventfollow，绘制仍是父 → static → 实例 | 成立 |
| 实例矩阵 `X = T(p)·L`；本地父时外面乘 `W`（带对象旋转），世界父时不带 | `f-base` 实例平移等于父粒子位置；`f-xf` 加 `origin` 偏移；`ef-rotl`（对象转 90°）实例矩阵带旋转、`origin (50, 0)` 转成向上 50；`ef-rotw`（父世界）不带旋转、`origin` 不转 | 成立 |
| 本地 eventfollow 实例的已有粒子跟着父粒子走，世界实例留在原地 | `f-base`（本地、速度 0）子粒子顶点全在 (0, 0)；`f-cw`、`ef-world`（世界）在父粒子身后排成一串 | 成立 |
| 条目 `maxcount` 是活跃实例上限，满了丢弃 | `f-max`（父 12 个存活）3 个实例；`ef-max`（上限 2）2 个；`es-max`（持续发射的 eventspawn，永不回收）只有前 3 个父粒子触发 | 成立 |
| `probability` 按 `uA ≤ p` 建 | `f-prob`（0.5）父 12 个存活、实例 8 个 | 成立（统计） |
| 父粒子死亡那一帧 eventfollow 停跟随、停发射，已有粒子活完后回收 | `f-death`、`ef-death`：死亡父粒子的实例停在死亡点，最新的子粒子就在死亡位置，此后不再出新粒子 | 成立 |
| 实例出现时按自己的 `starttime` 预热，位置是父粒子出生点 | `ef-start`（子 `starttime 0.5`、世界）刚建的实例已有 5 个粒子，年龄 0.1–0.5，都在出生点 | 成立 |
| 条目 `flags` bit0 在实例里同样写控制点，不补偿 `T(p)` | `ef-cpw`（startindex 2、读 cp2）子粒子在实例坐标里位于父的第一个存活粒子处，画出来再叠一个 `T(p)` | 成立 |
| 多个 eventdeath 条目时上限失守 | `ed-max2` 两条目各 `maxcount 1`、子系统永不结束：12 s 后分别 60、59 个实例（每个死粒子各建一个），两个条目都失守 | 成立，比读码的预测更彻底（第二个条目也失守，照代码推下去是对的） |
| 父带 rope 时预热里的死亡也建 eventdeath 实例；实例要到预热后的第一帧才步进 | `ed-rope`（父 `starttime 2`）比 `ed-sprite` 多 1 个实例，粒子年龄 12.899 = 运行时间，位置是父粒子活满 0.5 s 的死亡点 | 成立 |

**留给步骤 1–3 回放核对的：** 每帧的出生 / 死亡时刻（`ef-world` 的首个子粒子位置、`es-*` / `ed-*` 的出生点）、复用实例时 mapsequence 序号归零（`es-recycle`）、fps 10 下每帧只建一次实例，以及 `s-hide` 的递归复位。随机数流（`uA` 的消耗顺序）不核对：回放把随机范围收成 min = max，不复刻 WPE 的 MT19937。

**音频**

- **工程：** `proj/p4e-audio` 自带一个立体声循环音（左 1 kHz、右 250 Hz，节奏不同，一圈 4 s），`project.json` 声明 `supportsaudioprocessing`；CLK 着色器另读 `g_AudioSpectrum16` / `64` 的左右声道（`gen.write_project(audio=(16, 64))`，`kbp rdc track` 记进帧的 `audio`）。8 个发射系统 `rate 200`、速度 (0, 100)、寿命 0.5，每帧出生数由 y ≈ 100·dt 数出；另有带音频的 `vortex`。`proj/p4e-audio-off` 是去掉开关的副本。
- **抓帧：** fps 20 连抓 30 帧、fps 60 连抓 40 帧，`p4e-audio-off` fps 20 抓 5 帧。测试窗口出声，期间没有别的声音。
- **读数：** `ignore/p4/e0/ana_audio.py`。
- **RenderDoc 的格式：** WPE 把 `uniform float x[16]` 打包成 `float4[4]`，值在常量的 `members` 里，按顺序展开就是 16 个。

| 读码结论 | 实测 | 结果 |
|---|---|---|
| 粒子读的就是 `g_AudioSpectrum16Left` / `Right` 那份数组 | 下一行的公式直接用同一帧 CLK 读到的这两个数组 | 成立 |
| `f = clamp01(smoothstep(clamp01((v − lo)/(hi − lo)))^exponent)`；mode 1 左、2 右、3 是 `0.5·max(L + R)`；发射数 `acc += rate·f·dt`，`f` 乘在加余数之前 | 8 个系统、两种 fps：存在余数初值让每一帧的出生数都对上；「不乘 `f`」全部对不上；「mode 3 取 (L + R)/2 的平均」在 `a-m3` 上对不上 | 成立（出生数 0–58，是一致性检查；定量回放在步骤 4） |
| `bounds "1 1"` 是 v ≥ 1 才为 1 的阶跃；缺省 `bounds "0.8 1"`、`exponent 2`、频段 0–1 | `a-step`、`a-def` 两种 fps 都没有出生，按读到的频谱算 `f` 恒为 0 | 成立 |
| 没声明 `supportsaudioprocessing` 时频谱全 0、系数为 0 | `p4e-audio-off`：CLK 读到的 4 个数组全 0，带音频的发射系统没有粒子 | 成立 |

**留给步骤 4 的：** `vortex` 与 `turbulence` 的速度缩放、`turbulentvelocityrandom` 的相位范围；Kabegame 这边 16 段归一化频谱的来源（宿主现在拿到的是 `WpeMediaHub` 的原始值，归一化与 64 → 16 的归并要在宿主里照 rea-p4e-audio 第 6 节做）。

## P4f 语义的实测核对（2026-11-13）

读码在 [rea-p4f-script.md](rea-p4f-script.md)（`IParticleSystem`、`instance` 对象、字段脚本、HDR 下的 `brightness`、一个系统多个 renderer）。
- **工程：** `ignore/p4/defs/p4f0.py`（`kbp gen p4f0`）。第一轮 `p4f-instance`（7 个系数挂字段脚本）、`p4f-api`（方法与 `instance` 的 API 写入）、`p4f-bright`（`brightness`，场景 `bloom`、`hdr` 都开）、`p4f-multi`（多 renderer，读四角）；读码回来后第二轮 `p4f-api2`、第三轮 `p4f-api3` 照读码的建议补测。
- **读法：** 粒子匀速直线、寿命长，抓帧时每个粒子的 x 编码出生时刻；脚本按 `engine.runtime` 的 4 s 周期做事件，做的那一帧用 `console.error('[kbpx] …')` 记进 WPE 的 log.txt（日志在 `ignore/p4/f0/log/<标签>-errors.txt`）；`isPlaying()` 每 6 帧记一次。
- **抓帧：** `A:\p4f\<标签>`，fps 20 全部、fps 60 第一轮三个；`p4f-bright` 抓「关闭」与「超高」两档（`capture_sweep` 改设置、跑完改回）。轨迹 `ignore/p4/tracks/rd-p4f-*.json`（points 认法；`p4f-api2`、`p4f-api3` 另有 `-draws.json` 读 MVP）。读数脚本在 scratchpad（`ana_f0.py`、`ana_raw.py`、`ana_bright.py`、`ana_multi.py`），结论如下。

| 读码结论 | 实测 | 结果 |
|---|---|---|
| 字段脚本挂在 `instanceoverride` 上，7 个系数都生效；新值影响之后出生的粒子（`rate` 影响整个系统的步进） | `p4f-instance`：`count` 1 ↔ 3 出生间距 8 ↔ 2 px，切到 0 整段不发；`size`、`alpha`、`speed`、`lifetime`、`colorn` 按出生时刻分两档 | 成立 |
| 每帧写同一个值和静态写死相同（写回不比较、每帧置脏，只重算） | `i-count-const` 与 `i-count-static` 逐粒子相同 | 成立 |
| `stop`：清全部粒子、全部发射器标结束、计时复位，递归 static 子系统；`play` 在整棵树不活跃时重开 | `a-stop`：只剩 `play` 之后出生的粒子，第一个在约一个发射间隔后；`a-tree` 的 static 子系统同样清掉、复位后重新发 | 成立 |
| `pause`：只停发，粒子照常，发射计时冻结 | `a-pause`：出生时刻在 [1.05, 2.0) 有空档，旧粒子都在；`play` 后 0.12 s 就出下一个（计时接着走）；`b-pause-dur`（`duration 2`，0.5 暂停、1.5 恢复）发射到 3.0 才停 | 成立 |
| `stop` → `play` 时 `instantaneous` 再爆发一次 | `b-stop-inst`：每个周期 `play` 后 5 个 | 成立 |
| `isPlaying` = 没暂停 且 活跃；暂停时即使有粒子也返回假 | `a-pause` 暂停后 `false`（粒子还在）；`a-done`（`duration 1`、寿命 2）粒子死光的 3.0 s 前一直 `true` | 成立 |
| 自然结束后 `play()`：不再发射，但 `isPlaying()` 恒为真 | `b-end-play`：1.5 s 时 `false`，2.0 s `play()` 之后一直 `true`，没有新粒子 | 成立（和 `d.ts` 的说明相反）；**Kabegame 不复刻**，`play()` 复位计时后重新发射（子计划已定 5） |
| `stop` 之后写任一实例系数（同值也算）发射重新开始 | `b-stop-write`：只写 `instance.count = 1`、不调 `play`，约 0.2 s 后 `isPlaying` 变真、重新出粒子 | 成立；**Kabegame 不复刻**，`stop` 的结束只由 `play()` 解除（已定 6） |
| `instance.rate = 0` 不钳制，整棵树冻结 | `b-rate0`：周期内 [1, 2) 没有出生 | 成立；冻结期间不移动由回放核对 |
| `emitParticles(n)` 各发射器各发 `n` 个，不乘 `count`，受容量限制；`n == 0` 当 1、`n < 0` 不发 | `a-emit` 3 / 1（缺参数）/ 1；`a-emit-count`（`count 2`）发 3；`a-emit-cap`（`maxcount 8`）`emitParticles(20)` 得 8；`b-args`：`()` 1、`(0)` 1、`(-3)` 0、`(2.7)` 1 | 成立；缺参数与非整数读码没定，实测都是 1 |
| 暂停、停止时照发 | `a-emit-paused`、`a-emit-stopped` 都多 2 个 | 成立 |
| 连续发射的系统上是欠账，总数不变 | `b-debt`（`rate 5`）：1.0 s 爆发 3 个，之后 0.75 s 没有出生（跳过 3 个间隔） | 成立 |
| 同一段脚本里先写的 `instance` 系数对这批粒子不生效 | `b-emit-alpha`：写 `alpha 0.3` 再发的那批是 1.0，写回 1 再发的那批是 0.3 | 成立 |
| 脚本时建 eventspawn 实例用的栈顶是单位阵：父或子是世界空间时偏一个 `W` | `p4f-api3`（对象旋转、缩放 2）：世界子系统常规发射在对象附近，脚本发射在世界原点；世界父系统脚本发射的实例 MVP 多乘一个 `W`（平移 (1283, 423)，算出的 `W·p` 正好是它）；父子都本地时（`b-spawn`）两种相同 | 成立；**Kabegame 不复刻**，用对象的 `W`（已定 7） |
| `instance.controlpointN` 写的是实例覆盖值，没设时读回 x 为 FLT_MAX | `a-inst-cp` 读回 `3.4028234663852886e+38 0 0`；写 (0, ±40, 0) 后出生点在 y = ±40 切换 | 成立 |
| HDR（「超高」且场景 `bloom`、`hdr` 都开）下 `brightness` 乘在颜色三通道、不乘 alpha，`flags 8` 不乘，在 `colorn` 之后、不钳制；LDR 不乘 | `p4f-bright`：超高档 0.5 / 2 得 0.235 / 0.941（基色 0.471），`colorn` 的 (0.25, 1, 0.25) 乘 2 得 (0.5, 2, 0.5)，`alpha 0.5` 不变，`flags 8` 不变；关闭档全部不变 | 成立 |
| 一个系统多个 renderer：sprite 与 spritetrail 共用一份顶点、按数组顺序各画一次、各按自己的朝向；速度为 0 的粒子拖尾那次不画 | `p4f-multi`：`m-st-zero` 的拖尾绘制四角全是 NaN、sprite 照画；`m-ss` 第二个 sprite（`fixed`、`axis 1 0 0`）四角 x 恒定；子系统上同样两次；sprite 那次的顶点输入也带速度列 | 成立 |

**留给实现步骤的：** 字段脚本当帧还是下一帧生效（读码：下一帧，与我们的帧序等价）、单写 `rate` 时湍流的 `timescale` 不跟（`rt-1` / `rt-2`）、脚本发出的粒子下一帧才画且年龄多一帧，都由回放逐粒子核对。
