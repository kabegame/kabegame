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

## P5b 语义的实测核对（2026-11-12）

读码在 [rea-p5-modelflags.md](rea-p5-modelflags.md)，子计划见 [phase-5b-modelflags.md](phase-5b-modelflags.md)「步骤 0」。

**工具：**
- **工程**：`ignore/p5/b0/gen_b.py` 生成 21 个，放在 `ignore/p5/proj/p5b-*`。复用 P5a 的骨架（FR、CLK 两个图层），测试纹理是自写的 RGBA8 单层 `.tex`，自写 effect `kbfx`（g、b 减半，alpha 不变）与 `kbmask`（alpha 乘槽 1 遮罩的 r）。
- **抓帧**：`capture_sweep`，窗口 1920×1080（`p5b-fs` 另抓 1344×756），fps 20，各 3 帧，放在 `A:\p5b\<tag>`。全部成功，日志没有报错行。
- **读数**：`ignore/p5/b0/rdc_dump_b.py` 在 `qrenderdoc --python` 下无界面导出每个 action 的着色器、纹理、RT 尺寸、视口、混合与写掩码、变换后的顶点和常量，画进离屏 RT 的内容另存 PNG（`out/dump_b.json`、`out/png/`）；`ana_b.py` 打摘要。像素值、几何着色器的输出用 MCP 的 `pick_pixel`、`get_mesh_data` 补读。

| 读码结论 | 实测 | 结果 |
|---|---|---|
| `nopadding` 只关直接上屏的 0.15 texel 内缩，带 effect 时末 pass 照旧内缩 | `p5b-nopad`：直接上屏 UV 0–1（不写时 0.0003–0.9997，= 0.15/480、0.15/270）；带 effect 的两个末 pass 都是 0.0003–0.9997 | 成立 |
| 【推】纹理标志 0x20 对应「未补边」（rea 5.1） | 步骤 1 验收时发现：0x20 是视频位（`compile/tex.ts` 的 `TEX_FLAGS.video`），语料里写 `nopadding` 的纹理带它，是因为那些本来就是视频纹理 | **推翻**。`p5b-nopad` 第一版的测试纹理误写 0x22，步骤 1 改成 2 重抓（`p5b-nopad-v2`） |
| `autosize` 在纹理就绪时覆盖对象 `size`（取图像尺寸）；三者都缺时 1×1 | `p5b-autosize`：`size 24 20`、`300 300` 与模型宽高 100×50 都被覆盖成 48×40；没有 `autosize` 时模型宽高 100×50 生效；什么都没写的画成 1×1 | 成立 |
| `projectlayer` 的尺寸取正交投影宽高 | `p5b-proj`：`size 500 300` 变成 1920×1080，合成 RT 1920×1080；正交投影 1280×720 时合成 RT 1280×720 | 成立 |
| composelayer 基础 pass：composelayer 着色器从快照铺满合成 RT（尺寸 = `size`），MVP = `W` 与场景相机 | `p5b-cl`：合成 RT 600×300，基础 pass 关混合、写掩码 RGBA、顶点铺满 RT，槽 0 是 1920×1080 的快照，MVP 带旋转 | 成立 |
| 末 pass 画世界四边形、借基础材质的 translucent、UV 不内缩 | 同上：上屏是旋转的矩形，SrcAlpha / InvSrcAlpha，写掩码 RGB，UV 0–1 | 成立 |
| `copybackground: false`：清成 (0, 0, 0, 0)、不画基础材质 | `p5b-cl` 的 CL2：一次 Clear，没有基础 draw，直接跑 effect | 成立 |
| 无 effect、无子层、`colorBlendMode` 0 / 31 时整层不画 | CL3、CL5（`copybackground` true）只有层开始时的快照，没有 draw | 成立。快照照拷，看不出来 |
| `colorBlendMode` 混合：effect 全留在合成 RT，passthrough 材质上屏 | CL4（cbm 2）：基础 pass → effect（单位阵、整面）→ 混合着色器（槽 0 合成 RT、槽 1 快照）画世界四边形 | 成立 |
| fullscreen 带 effect：不画基础材质，合成 RT 0 = 当前目标的整张拷贝，末 pass 单位阵 + NDC | `p5b-fs`：一次 Resolve 拷进合成 RT，effect 直接画 ±1 的四边形，MVP 是 `ortho(−1, 1, −1, 1, −1, 1)`，`origin` / `scale` / `angles` / `size` 都不起作用 | 成立 |
| fullscreen 无 effect：没有 draw（组合层）；非组合层的 2×2 四边形靠着色器决定铺不铺满 | `p5b-fsnofx` 没有 draw；`p5b-fsmvp`：不乘 MVP 的着色器铺满全屏，乘 MVP 的是 `W` 变换的 2×2 方块（`scale 50` → 100×100） | 成立 |
| 【推】fullscreen 走拷贝路径时 `g_Color4` 是上一个设置过颜色的层的 | `p5b-fs`：effect 拿到 (0, 1, 0, 0.5)，正是前面绿层的颜色 | **成立**，见下「`g_Color4`」 |
| 【未查清】`_rt_FullFrameBuffer` 的尺寸 | 1920×1080 窗口里是 1920×1080，1344×756 窗口里是 1344×756（后备缓冲） | **窗口尺寸**。我们离屏按场景分辨率渲染，对应场景目标的尺寸 |
| 组合层子孙不在顶层画，按先序画进组的合成 RT；模型 `inverse(W)`、单位视图、`ortho(±w/2, ±h/2, ±1000)`，矩形外裁掉 | `p5b-grp-*`：三个子层只画进 800×400 的合成 RT，位置按组的本地坐标（R 在 x 130–430），伸出的黄块在 RT 外的部分被裁掉；组之后的顶层层照常画 | 成立 |
| `copybackground: false` 的组：子层写 RGBA、alpha 取 MAX | `p5b-grp-cb0`：子层 alpha 混合 One / One / Max、写掩码 RGBA；红蓝重叠处 (0.25, 0, 0.5, 0.5)，空白 (0, 0, 0, 0) | 成立 |
| 【推】无 effect、带子层的组直接上屏会铺满全屏并拉伸 | `p5b-grp-nofx` / `nofx0`：上屏画的是世界四边形（和带 effect 时同一块），着色器是「采样 × `g_Color4`」的透传（带 `TRANSFORM`），`g_Color4` = 1，UV 0–1；`copybackground` true 时**不混合**，false 时 translucent | **推翻**：不拉伸 |
| 【推】嵌套组的基础 pass 换回场景相机，采外层开始时的快照 | `p5b-nest`：内层基础 pass 的 MVP 是场景相机，槽 0 和外层用的是同一张快照，不含外层里先画的绿方块；内层上屏按外层的局部正交画进外层的合成 RT | 成立 |
| 组里的粒子：本地系统按组的局部坐标，世界空间系统用 `ctx+0xaf0`（组的模型矩阵） | `p5b-grpptc`：本地系统画在本地 (150, 50)；世界空间系统的顶点是世界坐标 (1220.9, 511.3)，经 `inverse(W_组)` 回到本地 (250, −80)；带 effect 的子层在组里照常走合成路径，末 pass 画进组的 RT | 成立 |
| 视差（未写） | `p5b-grp-par`：组的基础 pass 与上屏都带偏移 (150, 50)（按组自己的原点和深度算），子层在组里不受视差影响 | 视差只作用在组本身 |
| 场景普通绘制不写 alpha | `p5b-alpha`：translucent、additive 图层画完后，组采到的快照 alpha 都是 1 | 成立。和我们的写掩码 7、清屏 alpha 1 一致 |
| 图像层 `perspective`：上屏换成透视，`z = 0` 平面和正交画面重合 | `p5b-persp*`：直接上屏与带 effect 的末 pass 是透视 MVP，基础 pass 仍是合成 RT 的正交；只绕 z 转的层和正交一样；`perspectiveoverridefov 30` 时相机距离 2015.3 = 540 / tan 15°；`zoom 1.5` 时距离除以 1.5 | 成立。和透视粒子同一套矩阵（P4、P5a 已实测），步骤 1 逐元素比 |
| 视差和透视的先后 | `p5b-persp-par`：偏移 o = (−130, 80) 落在 z = 0 平面上正好是屏幕上的 o 像素，即先平移再投影 | 先乘视差平移再换投影 |
| `instanced`：合成 RT 按纹理图像尺寸（`util/white` 32×32） | `p5b-inst`：实例层的基础 pass 画进 32×32，对照组（不带 `instanced` 的 solidlayer）画进 900×1000；`instance.textures` 换成棋盘后槽 0 是棋盘；颜色 (1, 0.6, 0.2) 在基础 pass 照常生效 | 成立 |
| 【推】带 effect 时遮罩会明显变糊 | 单个 effect 时末 pass 直接上屏，槽 0 是拉伸的 32×32，遮罩按自己的分辨率采样，边缘清楚 | **部分推翻**：只有多 pass 的 effect，中间 pass 才在 32×32 上跑 |

**`g_Color4`：** effect pass 不设颜色，拿到的是这一帧里最后一次设置的值（B10）。所以：
- 普通带 effect 的层、无子层的组：是层自己的颜色（基础 pass 刚设过）；
- fullscreen 走拷贝路径（不画基础材质）：是前一个画过的层的颜色；
- 带子层的组：是最后画的那个子层的颜色（`p5b-grp-*` 的上屏拿到黄块的 (1, 1, 0, 1)，`p5b-nest` 拿到蓝块的）。
只有读 `g_Color4` 的 effect 着色器受影响。

**对步骤 1–5 的影响：** 读码的流程全部成立，只改两处：无 effect 带子层的组怎么上屏（透传着色器画世界四边形，`copybackground` true 时不混合），以及 effect pass 的 `g_Color4` 取值。`instanced` 的 32×32 只影响多 pass 的 effect。

## P5c 语义的实测核对（2026-11-12）

读码在 [rea-p5-mesh.md](rea-p5-mesh.md) 1、2、3、4 节。子计划见 [phase-5c-mesh.md](phase-5c-mesh.md)。

**工具：**
- **mdl**：`ignore/p5/c0/mdl_enc.py` 照 rea 1.2–1.7 编码；对语料里 46 个不带段的静态 mdl 解析再编码，逐字节一致（`enc_check.py`），所以对格式的理解和 WPE 写出的文件同构。
- **工程**：`ignore/p5/c0/gen_c.py` 生成 `ignore/p5/proj/p5c-*`（场景正交 1920×1080，最前面 FR、CLK 两层）。除了专门测缺省的，材质都显式关深度、不剔除。
- **抓帧**：`wpe-renderdoc` MCP 的 `capture_sweep`，窗口 1920×1080（视锥剔除的补测是 1600×900，别的会话占着 1920×1080），fps 20、后处理关闭（用户设置，没改）。放在 `A:\p5c\<tag>`，日志在 `ignore/p5/c0/out/logs/`。retro 另抓一份 2520×1080（和场景同尺寸）留作步骤 2 的对照。
- **读数**：`rdc_dump_c.py` 无界面导出每个绘制的输入布局、顶点 / 索引缓冲、深度与光栅状态、混合、被读到的常量、`vs_in` / `vs_out`（`out/dump_c.json`），`ana_c.py` 逐个工程核对（`out/ana_c.txt`），`sim_sort.py` 复现排序，`ana_frustum3.py` 看补测的视锥剔除。

| 读码结论 | 实测 | 结果 |
|---|---|---|
| 顶点按 26 位掩码的表序交错，stride 是置位属性大小之和，除 `a_BlendIndices` 外都是 float（1.4） | `p5c-layout` 两个网格各用一半宽度（`0x344988f` stride 156、`0xa34460` stride 104）：输入布局每个元素的语义、格式、偏移和表序算的逐项相同，`BLENDINDICES` 是 `R32G32B32A32_UINT`；顶点输入解出的值就是编码进去的「表序 + 分量」 | 成立 |
| 索引 bit0 置位是 u32，否则 u16；三角形列表（1.5） | 输入装配都是 `TriangleList`，索引 stride 2；`p5c-ver` 的 U32 是 4 | 成立 |
| 所有版本走同一个加载函数，按版本门槛读（1.2、1.3、1.7） | v4、v14、v16、v17、v21、v23 的同一个四边形都画在原处；网格标志 bit1 多读一个 u32；尾部带不认识的段（`ZZZZ0001`、`MDLX0001`）照常显示；`visible: false` 不画 | 成立 |
| 同语义不同宽度共用一个槽，少了截断、多了补 (0, 0, 0, 1)（1.4【推】） | 网格只有 `a_TexCoordVec4`、着色器声明 `vec2 a_TexCoord`：读到 xy；网格只有 `vec2` uv、着色器声明 `vec4 a_TexCoordVec4`：读到 (u, v, 0, 1) | 成立 |
| 着色器声明了网格没有的属性（1.4【未知】） | 声明了却没读的（`a_Normal`）：fxc 把它从输入签名里去掉，输入布局正常、画面正常。读了的（`a_Normal`、`a_Color`）：WPE 建不出输入布局（RenderDoc 里是空的），照样发绘制，属性值是未定义的，画面是一块乱的渐变；日志不报错 | **只有「读了」才是问题**。语料里 fantasticcar、audiophile 的 `grid` 声明 `a_Normal` 但不读，WPE 正常 |
| 模型不读 `color`、`alpha`、`brightness`，`g_Color4` 等固定为 1（2.5） | 模型对象写 `color 1 0 0`、`alpha 0.5`、`brightness 3`：`g_Color4` = (1, 1, 1, 1)、`g_Color` = (1, 1, 1)、`g_Alpha` = 1，和缺省的模型相同；对照的图像层是 (1, 0, 0, 0.5) | 成立 |
| `skin` 选第 min(skin, N − 1) 个材质，负数按无符号落到最后一项（2.4） | 2 个皮肤：缺省、0 → 0；1、5、`1.0` → 1；**−1 → 0**；`"1"`、`true` → 0 | 上限成立，**负数不成立**：只认非负整数（含 `1.0` 这样的整数值），其余一律 0 |
| `g_ModelMatrix` 是世界矩阵，`g_ModelMatrixInverse` 是它的逆（2.3） | 带 3D 旋转、非均匀缩放、挂在带变换的父层下的三个模型，和按 `W = W_parent · T · Rz·Ry·Rx · S` 算的差 ≤ 5.4e-5，逆矩阵差 ≤ 9.5e-5（float 误差） | 成立 |
| `g_NormalModelMatrix` 是 3×3 各轴归一化，不是逆转置，快速倒数平方根加一次牛顿迭代（2.3） | 三个模型：按「`0x5f375a86` + 一次牛顿迭代、float32」归一化各轴，和实测差 ≤ 1.2e-7；精确归一化差 0.9e-3–1.7e-3（就是快速倒数平方根的误差）；逆转置差 0.4–0.67 | 成立，**要照搬快速倒数平方根**才逐位对上 |
| MVP、视图投影、眼位与其他对象共用（2.5） | MVP = VP · W；正交 VP 线性项 (2/W, 2/H, 1/4000)、z 平移 0.5；`g_EyePosition` = (960, 540, 2000) | 成立 |
| 视差对模型同样适用（4.2） | 开视差（amount 0.5，P 在中心）：子模型按根对象（分组）的 `origin` 偏移，根模型和同位置同深度的图像层偏移相同；`g_ViewProjectionMatrix` 里就带着这次绘制的偏移 | 成立 |
| 模型 `perspective` 临时换透视投影（2.2） | `perspective: true` 的模型 VP 是透视的（`[11] = −1`），和 P5b 的透视图层同一套：视差平移在投影之前，`zoom 1.5` 时相机距离 ÷ 1.5（494.82 → 329.88） | 成立 |
| `zoom` 对模型同样适用 | 正交 VP 线性项 × 1.5、绕中心缩放 | 成立 |
| 模型内网格不透明在前，比较器是「a 不透明且 b 半透明」，introsort 不稳定（2.4、4.3） | 5 个网格（translucent、normal、additive、normal、alphatocoverage）画的顺序是 1、3、4、0、2；40 个网格（偶数 translucent、奇数 normal）不透明全在前，但同类内部不是原顺序（`39, 1, 11, 3, 19, …`） | 成立。照 MSVC STL 的 `std::sort` 移植（≤ 32 个插入排序，否则三数取中 / ninther 划分），40 个的顺序逐个复现；≤ 32 个时等于稳定排序 |
| 缺 `cullmode` 是 normal，剔背面，`FrontCounterClockwise` 为真（3.3、3.4） | 缺键与 `normal`：`CullMode.Back`、`front_ccw = true`，屏幕上逆时针的三角形可见、顺时针的被剔；`nocull` 两个都可见；x 镜像（`scale −1`）的对象不翻转正面，镜像后变成逆时针的那个可见 | 成立。只看屏幕上的绕序，镜像变换不补偿 |
| 视锥剔除：两个包围盒角经世界矩阵变换，中点为球心、半对角线为半径；v < 17 不剔（4.4、1.6） | 正交场景里生效：包围盒在场景外（F1）、xy 在内但 z 远在深度范围外（F5）不画；同几何的 v14（F2）、包围盒在内（F3）、跨边缘（F4）、对象平移回场景内（F6）画。补测：盒子在外、外接球伸进场景的（F8 立方体、F9 扁盒）画；扁盒的球半径（不含 z 厚度）够不到的（F10）不画 | 成立。半径按三维盒子的半对角线，z 厚度为 0 时就小 |
| 正交场景里模型也测深度、写深度（3） | 缺深度键、normal 的近方块先画、远方块后画：重叠处是近的；远先近后：近的；近的是 translucent：远的盖上来（translucent 不写深度）。深度状态 GREATER、写；translucent 只测不写 | 成立，归 P5d |
| retro 的 `bgfade` | 输入布局 `POSITION`（没读）、`TEXCOORD`；深度测试开（缺键）、不写（translucent）、GREATER；不剔除；混合 translucent、写掩码 7；`g_TexelSize` = 1 / 窗口尺寸；顶点着色器输出带 HLSL 的半纹素偏移 | 成立 |

**只记不补：** 着色器读了引擎写的 `g_UserAlpha`、`g_Brightness`（不带 `"material"` 注解）时，WPE 给的是 0，图像层和模型都一样；我们给 alpha 和 1。语料 157 个工程里这两个名字全部带 `"material"` 注解（取材质值），WPE 自带的着色器也是，所以没有画面差别。

**对 P5c 各步的影响：** 读码的结论全部成立，推翻一处：`skin` 为负数时取 0，不是最后一项。另外三条读码没写全的规则定下来了：只有着色器读了网格没有的属性才报不支持；网格排序要照搬 MSVC 的 `std::sort`；`g_NormalModelMatrix` 要照搬快速倒数平方根。视锥剔除在正交场景里生效，会改变画面（retro 这种不乘矩阵的着色器），所以 P5c 要做。

## P5d 语义的实测核对（2026-11-13）

读码在 [rea-p5-camera.md](rea-p5-camera.md) 1–5、8 节与 [rea-p5-mesh.md](rea-p5-mesh.md) 3、4 节。子计划见 [phase-5d-camera-depth.md](phase-5d-camera-depth.md)。

**工具：**
- **工程**：`ignore/p5/d0/gen_d.py` 生成 `ignore/p5/proj/p5d-*`（20 个）。正交工程沿用 P5a 的骨架；透视工程的 FR、CLK 用裁剪空间的着色器、原点放在相机看得到的地方（第一批放在 (1820, 40, 0) 时没画，见下「补充」）。相机相关的常量由探针网格（v14，不受视锥剔除）与探针图像层读出。
- **抓帧**：`capture_sweep`，窗口 1920×1080（宽高比另抓 1280×1024），fps 20、后处理关闭、MSAA 关（用户设置，没改）。放在 `A:\p5d\<tag>`，日志在 `ignore/p5/d0/out/logs/`。真实样本 neon_sunset、techno、dna_fragment 用 `kbp content unpack --instrument` 解包（`ignore/p5/proj/<名>-kbp`），另抓了一张模板相机场景 3462279189。
- **读数**：`../c0/rdc_dump_c.py` 导出（`out/dump1-3.json`），`ana_d.py` 逐绘制摘要，`ana_path.py` / `sim_path.py` 核对路径，几何着色器的常量用 `wpe-renderdoc` 的 `get_shader_info` 直接读。

| 读码结论 | 实测 | 结果 |
|---|---|---|
| 透视投影是 `PerspectiveFovRH`：竖直 fov（度）、反向深度、宽高比取窗口；缺省 fov 50、nearz 0.1、farz 10000（1.1–1.3） | `p5d-persp`：VP 的 m00 = cot 25°/(16/9) = 1.206285、m11 = 2.144507、m22 = n/(f − n) = 1.00001e-5、m23 = −1；1280×1024 窗口的 m00 = 2.144507/1.25 = 1.715605，m11 不变。`p5d-persp-b`（fov 30、nearz 1、farz 100）：m11 = cot 15° = 3.732051、m22 = 1/99 | 成立 |
| 透视下 `zoom` 不生效、视差不移动对象（1.4、6.1） | `p5d-persp-b`（`zoom 2`、开视差、对象 `parallaxDepth 1 1`）：VP 只随 fov 变，各对象的 MVP 没有平移 | 成立 |
| 透视下 `g_ParallaxPosition` 除以 0 后被钳成 0（6.2【推】） | 透视开视差时是 (NaN, NaN)；不开时是加载时的 (0.5, 0.5) | **推翻**：不钳制，是 NaN |
| 普通图像层与模型共用同一个 VP、按世界单位画；`g_EyePosition` 就是 eye；`g_ViewForward` / `Right` / `Up` 取 V 的列；`g_Screen` 是窗口（2、8） | `p5d-persp`：图像层 MVP = VP · W（`size 256`、`scale 0.01`）；`g_EyePosition` = (0, 0, 10)；三个视图向量 (0, 0, −1)、(1, 0, 0)、(0, 1, 0)；`g_Screen` = (1920, 1080, 1.778) | 成立 |
| 路径：段内 Hermite、两端切线 (p1 − p0)/2、不乘段长；每帧先求值再 t += dt；切到下一条时 t 归零、余量丢掉；按文件顺序循环（3.2） | `p5d-path`（两条路径，8 个时刻共 24 帧）：第一圈按 t = `g_Time` − 本帧 dt 闭式求，和 `g_EyePosition` 逐位相同；按日志里逐帧的 dt 推状态机，第二圈（两次切换之后）差 ≤ 3.6e-6（float32 累加） | 成立 |
| 透视抖动：偏移 = 0.1·amplitude·v，v = (cos T, sin 1.333T, sin T)，三维、eye 与 center 同移（5） | `p5d-shakep`：`g_EyePosition` 偏移和公式相同（T = `g_Time`）；`p5d-shakep-r`（roughness 0.1）不做长度指数，同 P5a 正交里按 float32 的临界 | 成立 |
| 相机对象：倒序找最后一个自身与父链都可见的；eye = 世界矩阵平移、看本地 −Z；透视场景 fov 取相机的（4.2） | `p5d-camp-2`：JSON 里靠后的 CB 生效（eye (2, 0, 8)、m11 = cot 30°）；`p5d-camp-1`（CB `visible: false`）：CA 生效（eye (0, 0, 8)、fov 40） | 成立 |
| 正交相机对象：视图平移 −eye，正交投影仍是 0..W；`g_EyePosition` = eye + (W/2, H/2)、z = 2000；`angles` 转视图；对象 `zoom` 绕场景中心缩放（4.3） | `p5d-camo-c`（(960, 540, 500)）：VP 平移 (−2, −2)、深度 0.5 − 500/4000 = 0.375，`g_EyePosition` = (1920, 1080, 2000)；`-o`（(200, 100, 0)）：平移 (−1.208, −1.185)；`-r`（`angles 0 0 0.3`、`zoom 2`）：`g_ViewRight` = (cos 0.3, sin 0.3, 0)、线性项 ×2；`-0`：和没有相机时相同。模板脚本读到的 `engine.canvasSize` = (1920, 1080)，等于正交尺寸 | **成立，冲突解开**：模板场景 3462279189 的抓帧画面正常，它的图层本来就摆在 (W/2…3W/2, H/2…3H/2)，相机的 −(W/2, H/2) 正好挪回画面中间（图层 MVP 的平移在 0 附近、深度 0.375）。读码没错，是我们当时按「内容在 0..W」去想 |
| 深度：后备缓冲 D32F、每帧清 0、GREATER；`depthtest: disabled` 不测不写；translucent / additive 只测不写；normal / alphatocoverage 按 `depthwrite` 写；缺键为开（rea-p5-mesh 3.1–3.4） | `p5d-depth` 12 组、`p5d-depth2` 6 组：每次绘制的深度状态逐个对上，屏幕上重叠的几组遮挡对上（缺键的两个模型、近处半透明不挡后画的、关测试的不写、共面时后画的不显示、图像层写深度挡住后画的模型、图像层与粒子测深度时被前面的模型挡住） | 成立 |
| 非法值取表的第一项：`depthtest` / `depthwrite` 落到 disabled，`cullmode` 落到 normal（3.3） | `depthtest: "yes"` → 不测；`cullmode: "back"` → 剔背面 | 成立 |
| 缺键规则对图像层、粒子、模型相同（3.6） | 缺全部深度键的图像层：测、写、剔背面；缺 `depthtest` 与 `cullmode` 的粒子：测、不写（additive）、剔背面 | 成立 |
| 正交场景同样测深度；带 effect 的图像层只在上屏时对主深度测（末 pass 借基础材质的深度键）（3.6） | `p5d-depth-o`：z = 100 的模型写深度，之后 z = 0 的图像层、带 tint 的图像层（末 pass 测、不写）、缺 `depthtest` 的粒子在重叠处都被挡；基础 pass 画进合成 RT 时没有深度 | 成立 |
| 剔除只看屏幕绕序、正面逆时针（3.4、3.5） | `p5d-cull`：图像层四边形是逆时针（正面）；自身 `scale −1`、挂在镜像父层下、绕 y 转 180° 的都被剔；粒子（几何着色器把点展开成三角形带）也是逆时针，镜像的粒子系统被剔；`p5d-depth2`：透视场景里也一样 | 成立。**补充**：带 effect 的图像层，基础 pass 用基础材质的剔除（画进合成 RT 的四边形不镜像，照常画），上屏 pass 用 effect 材质自己的 `cullmode`（tint 是 nocull，所以镜像的图层照样显示） |
| `clearenabled: false` 时颜色和深度都不清（3.7【推】） | `p5d-noclear`：整帧没有清屏调用；静止的写深度模型在画之前，深度缓冲里已经是它自己上一帧写的 0.5，GREATER 严格不通过，所以第二帧起不再画；不写深度的那块照常画 | 成立 |
| 透视场景里的普通粒子：用场景 VP；sprite 按对象朝向展开，不面向相机（rea-p5-camera 2、rea-p4c） | `p5d-ptc`：MVP = VP · W；几何着色器读 `g_OrientationRight` / `Up` / `Forward`（单位轴），不是视图向量 | 成立 |
| 透视场景里的透视粒子（`flags & 4`）：fov = 2·atan(1/(P11·2000))，视图 z 平移强制 −2000（7.2、7.3） | `p5d-ptc`：m11 = 4289 = cot(fov/2)、原点处 w = 2000、near 5 / far 15000 | 成立。语料 0 个（`scan_persp_ptc.py`），照报 |
| 透视场景里的合成链与 fullscreenlayer | `p5d-2d`：基础 pass 画进合成 RT 用 RT 自己的正交（z 系数 1/2000），末 pass 用场景 VP · W；fullscreenlayer 的末 pass 用 NDC 正交 | 成立，和正交场景同一套 |

**补充：**
- **图像层的视锥剔除**（读码只说了模型）：正交场景不剔，场景外、z 超出深度范围的图像层照样发绘制（`p5d-imgcull`）；透视场景剔掉相机背后与视野两侧外的，远过 farz 的照样画（`p5d-imgcull-p`）。着色器乘 MVP 时这些图层本来就不在画面里，没有画面差别，只记。
- **fullscreen 模型的几何**：槽 0 没有纹理时不经过纹理就绪回调，几何不改成 2×2，用的是对象 `size`（`p5d-2d` 的探针层，±960 × ±540）。语料里 fullscreen 模型的槽 0 全是 `_rt_FullFrameBuffer`，只记。
- **插桩 FR 在透视场景里**：`kbp content unpack --instrument` 把 FR 放在 (−100000, −100000, 0)。neon_sunset 的相机在原点看 −Z，FR 落在相机平面上被剔掉；dna_fragment 的照样发绘制（远过 farz、被深度裁掉）。透视样本的帧号改按抓帧的帧号对日志：`p5d-path` 实测脚本帧号 = 抓帧的帧号 + 1。

**对 P5d 各步的影响：** 读码的结论全部成立，推翻一处推断（透视开视差时 `g_ParallaxPosition` 是 NaN），正交相机对象的冲突解开（照读码实现），补了两条读码没写到的规则：带 effect 的上屏 pass 剔除取 effect 材质；`clearenabled: false` 时深度也不清。深度与剔除对全部对象同一套规则，正交场景同样生效，所以步骤 1 不分投影；透视场景里的透视粒子与文本对象语料 0 个 / 只在还差 20 项以上的场景里，照报。
