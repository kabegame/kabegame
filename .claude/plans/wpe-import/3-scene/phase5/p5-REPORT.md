# P5 实测报告

> 上级：[phase-5-camera-mesh.md](phase-5-camera-mesh.md)。读码在 `rea-p5-*.md`，那里的结论没有实测；这里记实测核对，结论以本文件为准。每节写清工程、抓帧位置、读数脚本和结果。

## P5a 语义的实测核对（2026-11-10）

读码在 [rea-p5-camera.md](rea-p5-camera.md) 5、6 节与 p3-script-REPORT L2（`zoom`），前置几条在 [rea-p5-mesh.md](rea-p5-mesh.md) 3 节与 [rea-p5-modelflags.md](rea-p5-modelflags.md) 4、7 节。

**工具：**
- **工程**：由 `ignore/p5/a0/gen_a.py` 生成，放在 `ignore/p5/proj/p5a-*`。每个工程最前面有 FR、CLK 两个图层，CLK 的着色器读 `g_Time`、`g_Frametime`、`g_PointerPosition`、`g_ParallaxPosition`、`g_EyePosition`。测试方块是纯色的，按 `g_Color` 认。
- **抓帧**：用 `wpe-renderdoc` MCP 的 `capture_sweep`，窗口 1344×756，fps 20（用户设置，没改）。抓帧放在 `A:\p5a\<tag>`，日志在 `ignore/p5/a0/out/logs/`。
- **读数**：
  - `ignore/p5/a0/rdc_dump.py` 在 `qrenderdoc --python` 下复用 MCP 工作进程的服务层，无界面导出每个 draw 的常量和深度、光栅状态，输出 `out/dump.json`、`out/dump_real.json`；
  - `ana_a.py` 核对视差、抖动、缩放（`out/ana_a.txt`），`ana_pre.py` 核对前置几条，`ana_real.py` 核对 `3830255100`（`out/ana_real.txt`）。
- **指针**：没有移动用户的鼠标。抓帧时光标在每个测试窗口的右下方外面，`g_PointerPosition` 在 (1.9–2.4, 1.1–2.0)，钳制后是 (1, 0)。

| 读码结论 | 实测 | 结果 |
|---|---|---|
| 对象偏移 `o = amount · depth(根) ⊙ (origin(根).xy − P)`，乘在这次绘制的视图上 | `p5a-static`（`mouseinfluence 0`，P 恒为中心）7 个方块的偏移逐个吻合，误差 0：(1460, 540) 深度 (1, 1) 偏 250，(460, 540) 深度 (−0.7, −0.7) 偏 175，(960, 840) 深度 (0, 1) 只在纵向偏 150 | 成立。**静止时原点不在中心的层也有偏移** |
| 不写 `parallaxDepth` 的对象缺省 (1, 1) | 方块 E 偏 (250, 150) | 成立 |
| 只看根对象：子对象跟根走，自己的深度不参与 | 根分组 (400, 250) 深度 (1, 1) 下的子方块偏 (−280, −145)；根分组深度 (0, 0) 下深度 (1, 1) 的子方块不动 | 成立 |
| 视差点 `P = eye.xy + (W·(0.5(1 − mi) + mx·mi), H·(0.5(1 − mi) + my·mi))`，`mx = clamp(ptr.x)`、`my = clamp(1 − ptr.y)` | `mouseinfluence` 1、0.5：P 为 (1920, 0)、(1440, 270)，各层偏移误差 0 | 成立。指针先钳到 0…1、y 翻成向上 |
| `mouseinfluence` 不钳制；`g_ParallaxPosition = clamp(P / (W, H))` | `mouseinfluence −2`：按各层偏移反推 P = (−960, 1620)，在场景外；`g_ParallaxPosition` 是 (0, 1) | 成立。**P 不钳制，只有 uniform 钳制** |
| 平滑 `k = min(1, (1 − delay/3)·10·dt)`，`P ← P + (目标 − P)·k` | `delay` 2.7、2.9 各连续 6 帧：实测 k 和公式差 < 1e-5，dt 取本帧的 `g_Frametime` | 成立 |
| 视差点初值是场景中心，开场从中心滑向指针 | `delay 2.9` 开窗 4 s 后 P 还在 (1683, 134) → (1705, 122) 途中 | 成立 |
| 带 effect 的图层：偏移作用在上屏那一下 | `p5a-kinds`、`2381978484`、`3830255100`：画进合成 RT 的基础 pass 是 (−1, −1) 的整面矩阵，上屏 draw 带偏移 | 成立 |
| 粒子绘制同样乘偏移 | 静止粒子的绘制矩阵带 (250, −120)，跟随指针的系统带 (−480, −270) | 成立 |
| 整个对象画的时候视图都换成带视差的（步骤 2 前补测 `p5a-fx`：内置 effect 照编辑器的做法连材质、着色器打包进工程） | `cursorripple` 第一个 pass 画进 `_rt_EightBuffer1`，它读的 `g_EffectTextureProjectionMatrixInverse` 平移 −25，按带视差的图层矩阵算正好是 −25，不带视差应为 −16.67；`depthparallax`（单 pass）、`godrays` 的末 pass 上屏矩阵都带偏移 | 成立。**effect 的中间 pass 读到的效果矩阵也带视差**，只有画进合成 RT 的基础 pass 用自己的整面矩阵 |
| 透视粒子（系统 `flags 4`）也带偏移 | 原点 (460, 840) 深度 (1, 1) 的透视粒子，绘制矩阵把原点投到 (210, 990)，偏移 (−250, 150) 和正交时相同 | 成立。平移加在世界坐标里，z = 0 平面上和正交一致 |
| 跟随指针的控制点不含视差（模拟用的视图没偏移） | 跟随粒子出生在 (4441.43, −962.86)，正好是不含视差的反投影点 | 成立 |
| `zoom`：正交投影绕场景中心乘 `zoom` | `zoom` 1.5、0.8：线性项是 `zoom·2/W`、`zoom·2/H`，7 个方块的平移逐个吻合 | 成立 |
| 视差偏移是场景单位，缩放之前加 | `zoom 1.5` 加视差：按场景单位换回后偏移误差 0 | 成立 |
| 抖动：`T = speed²·g_Time`，`v = (cos T, sin 1.333T, sin T)`，正交时 `v.z = 0`、幅度 `0.01·amplitude·H`；`e = roughness³` 在 `0.001 < e ≠ 1` 时把长度改成 `L^e`；eye、center 加同一个偏移 | 5 组各 4 帧：`g_EyePosition` 的偏移和公式差 ≤ 1e-4，图层整体平移 −偏移。`roughness 2`（e = 8）改了长度；`roughness 0.05` 不改 | 成立 |
| `roughness 0.1` 的临界值 | 实测不改长度：`powf(0.1f, 3)` 正好等于 `0.001f`，「e > 0.001」为假 | 成立，**要按 float32 算** |
| 视差点含抖动后的 eye | `3830255100`：`g_EyePosition` 偏 (8.717, 10.165)，和抖动公式一致；17 个对象（深度 0.44–1.87，含 3 个粒子、11 个带 effect 的层）按 P = 抖动 + 视差点、指针 (1, 0) 预测，第 253 帧全部误差 0，第 252 帧最大 0.12 像素 | 成立。252 帧的残差是平滑还没到位；253 帧的 dt 是 0.25 s（被抓的长帧），k 取到 1，P 一步到位 |
| 场景比例和窗口不同时，P 用场景宽高，偏移按场景单位 | `2381978484`（8192×5479 的场景放进 16:9 窗口，WPE 上下各裁 435.5）：偏移 410.9 = 0.15·2739.5 | 成立 |
| `g_ParallaxPosition` 只进 uniform | `3818481122` 的 `depthparallax` 读到 (0.75, 0.25) = `clamp(0.5·0.5 + 0.5·1, 0.5·0.5 + 0.5·0)`，它的图层深度 0、不动 | 成立 |
| 前置：材质 JSON 允许 `//` 注释 | 带注释行的材质照常加载、画出来，日志没有报错 | 成立 |
| 前置：translucent / additive 不写深度，`depthtest: disabled` 连带不写 | translucent、additive 写 `depthwrite: enabled` 时深度开、不写、GREATER；normal 时开、写；`depthtest: disabled` 时深度关 | 成立 |
| 前置：`cropoffset`、对象 `config` 运行时不读 | 写了 `cropoffset "100 100"` 的层、带 `config.passthrough` 的层都画在原点，和对照层相同 | 成立 |
| 前置：模型 JSON 的布尔键只认 `true` | `fullscreen: 1` 的层照常按 60×60 画在原点，没有铺满 | 成立 |
| 粒子模拟（指针反投影）用的视图带不带抖动（步骤 3 端到端补测 `p5a-shakepar`：抖动 speed 1 / amplitude 1 / roughness 1，视差 mouseinfluence 1、delay 0，系统 `pf` 的控制点 0 跟随指针、粒子速度 0） | 第 119、120 帧的新生粒子在 (1701.07, 127.796)、(1728.371, 32.687)：按「当帧指针 + **上一帧**的 s」两帧误差都是 0.000；按「当帧指针 + 当帧 s」差 (−0.30, 0.11)、(−0.28, 0.36)；按「上一帧指针 + 当帧 s」差几十像素 | **粒子模拟用上一帧的相机**（带上一帧的抖动、不带视差），指针用当帧的。和读码的帧顺序一致：`FUN_1401891a0` 先对 `G+0x158` 的对象调更新（粒子模拟在这里），之后才选相机来源、加抖动、算 lookAt。绘制、`g_EyePosition`、视差点都用当帧的 s |

| 缩放时透视粒子的相机距离（步骤 4 动工前补测 `p5a-zoomx15` / `zoomx08`：缩放 1.5 / 0.8 加视差、抖动，透视粒子出生在本地 z = 300，另有跟随指针的系统） | 透视粒子的 MVP 按 `d = (H/(2·zoom))/tan(fov/2)`、far `max(15000, d + 1000)` 算，两档 3 帧和 WPE 逐项差 < 1e-4；按不带缩放的 d 差上百 | 成立。读码 7.2「d 取已含正交缩放的投影的可见高」 |
| 缩放下的跟随点与几个不变量（同上） | 跟随粒子出生点按「带缩放的投影反投影 + 上一帧 s」误差 ≤ 3e-4，不带缩放差几百像素；`g_EyePosition` 只带抖动；`g_ParallaxPosition` 与视差点按不缩放的场景宽高；方块矩阵 = 绕中心缩放的正交投影 · `T(o − s)`，差 1e-7 | 成立 |
| 脚本的光标与 `g_PointerPosition`、粒子是不是同一次采样（收尾前补测 `p5a-cur` / `p5a-cur3`，工具改进的依据，见子计划「收尾前：回放逐帧光标」） | `engine.screenResolution` 报测试窗口的 1920x1080；`g_PointerPosition` 逐位等于 float32(`cursorScreenPosition` / 窗口尺寸)，共 12 帧；`p5a-cur3` 用户在窗口上晃鼠标，按日志第 f 帧的光标回放第 f 帧，491–495 个跟随粒子逐个差 ≤ 2.4e-4，错一帧差 340 像素；`cursorWorldPosition` = (x, H − y) 带 float32 误差 | 成立。`cursorScreenPosition` 是壁纸窗口内像素、y 朝下、不钳制；**脚本、uniform、粒子模拟用的是同一帧的同一次采样**；`cursorWorldPosition` 是反投影（留给 P6） |

**收尾走查（未实测清单，2026-11-11）：** 工程由 `ignore/p5/wk/gen_wk.py` 生成（FR 都带逐帧光标），抓帧在 `A:\p5a2\p5a-wk-*`，读数是 `ana_wk.py`（`out/ana_wk.txt`）、`ana_zoom3.py`、`p0_back.py`。

| 读码结论 | 实测 | 结果 |
|---|---|---|
| 没开视差时 `g_ParallaxPosition` 恒为 (0.5, 0.5)（`p5a-wk-noplx`） | 光标在窗口右下方外面（`g_PointerPosition` (1.53, 0.96)），`g_ParallaxPosition` 两帧都是 (0.5, 0.5)，方块偏移 0 | 成立 |
| `parallaxDepth` 绑单个数字的用户属性时铺满两个分量（`p5a-wk-prop`：方块 A 绑滑块 `pd`，属性值 0.6，scene.json 缺省写 "1 1"） | 由深度 (1, 1) 的方块 B 反推视差点，A 的深度两帧都是 (0.6000, 0.6000) | 成立 |
| 运行中改 `parallaxDepth`（用户属性）就地生效（同上，`apply_properties` 把 `pd` 改成 0.3） | 回调在第 326 帧，之后第 345、346 帧 A 的深度 (0.3000, 0.3000)；FR 帧号连续，没有重新加载 | 成立 |
| 运行中开关 `cameraparallax`：关时 P 冻结、`g_ParallaxPosition` 留旧值、偏移撤掉，再开时 P 从旧值续（同上，`cameraparallax` 绑开关 `plx`，delay 2.95；回调在第 501 帧关、765 帧开） | 关着的第 519–629 帧：A、B 偏移 0，`g_ParallaxPosition` 一直是 (0.984697, 0.096059)。按日志逐帧光标模拟 P：「关掉期间冻结、再开时接着走」各帧差 ≤ 0.03（开场初值差衰减剩下的，见下一行）；「关着照常推进」差到 78 像素；「再开时回中心」差 778 像素 | 成立 |
| P 的初值 = eye.xy + (W/2, H/2)（读码 `0x14018870c`） | 同上，开场各帧差 (0.457, 0.457)、(0.110, 0.111)…，按各帧 k 折回第 0 帧四次都是 (2.00, 2.00) | **不成立：初值是 (W/2 + 2, H/2 + 2)**。回 REA 查清（llvm-objdump 反汇编 `FUN_140186c90`）：开头 `0x140186db3`–`0x140186dc9` 把 `G+0xf0..0xf8` 写成 (2, 2, 2)（同处 `+0x118..0x120` 也是 (2, 2, 2)，`+0x148` fov 50、`+0x14c` near 0.1、`+0x150` far 10000，是相机的缺省值）；加载末尾 `0x14018870c` 算 P0 = `[G+0xf0]` + (W, H)·0.5（常量 `0x140492dd0` 是 0.5，W、H 在 `0x14018759e` / `0x1401875c0` 取自 `orthogonalprojection` 的整数宽高），这时场景的 `camera.eye` 还没套进 `G+0xf0`，用的是缺省的 (2, 2)。每帧的目标点用当帧真实的 eye（场景的 (0, 0) 加抖动），所以这 2 像素只在开场，按 k 衰减，和实测相符。常数，不随窗口、场景尺寸或场景 eye 变；透视场景初值 0（`0x140188733`）。步骤 2 的 `delay 2.9` 复算把起点改成中心加 (2, 2) 后残差从 (0.37, 0.37) 归零，当时记的「回放差 1 像素」就是它。已对齐（子计划「P5a 收尾」） |
| 脚本写 `thisScene.cameraparallaxamount` 与 `thisLayer.parallaxDepth`（`p5a-wk-script`：FR 脚本逐帧交替写 amount 0.5 / 0.25、`getLayer('A').parallaxDepth` (1, 1) / (0.5, 0.5)） | 6 帧都是画的时候用这一帧写的值；第 3 帧读回 depth (1, 1)、amount 0.5，正是刚写的 | 成立：同帧生效，读写都通 |
| 运行中改 zoom（脚本写 `thisScene.zoom`）：画面与粒子模拟各用哪一帧的（`p5a-wk-zoom3`：zoom 按帧号 mod 3 轮换 1 / 1.25 / 1.5，周期 2 分不开 f 与 f − 2） | 画面 9 帧都是第 f − 1 帧写的；跟随粒子 12 个新生点都是按第 f − 2 帧写的 zoom 反投影，差 ≤ 2e-4 | 成立：相机在帧开头、脚本之前读 zoom，粒子模拟用上一帧的相机。和实现相同 |
| 材质 JSON 的 `/* */` 块注释（`p5a-wk-prop` 的方块 F） | 带整行与行内块注释的材质照常加载，F 每帧画在 (960, 840)，日志没有报错 | 成立 |

**顺带确认的事实（给后面几节）：**
- 正交 2D 场景里 WPE 也绑着深度目标；深度开时比较函数是 GREATER；光栅状态 `front_ccw` 为真（P5d）。
- 场景里普通绘制的颜色写掩码是 7，即不写 alpha。rea-p5-modelflags 的「未查清」里有这一条，留给 P5b。
- `p5a-kinds` 的 tint effect 报「`materials/effects/tint.json` 第 1 行语法错误」，没有画出 effect pass。这是测试工程的写法问题，不影响结论：上屏那一步在真实样本里已经核对过。

**脚本里的用法（`ignore/p5/a0/out/scan_scripts.txt`）：**
- 字段脚本挂在 `parallaxDepth` 上的有 2582765611、2896608544。
- `bar.parallaxDepth = new Vec2(0, 0)` 出现在 3304642534、3549863808、3570308528 的音频条脚本里，它们还要 `createLayer`（P6）。
- 写 `cameraparallax*` 的只有 2887099508 的一段混淆脚本。
- p3-script-REPORT I3：`parallaxDepth` 改值只改字段、没有回调；视差每次绘制都重读，下一帧生效。
