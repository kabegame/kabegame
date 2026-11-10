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

**顺带确认的事实（给后面几节）：**
- 正交 2D 场景里 WPE 也绑着深度目标；深度开时比较函数是 GREATER；光栅状态 `front_ccw` 为真（P5d）。
- 场景里普通绘制的颜色写掩码是 7，即不写 alpha。rea-p5-modelflags 的「未查清」里有这一条，留给 P5b。
- `p5a-kinds` 的 tint effect 报「`materials/effects/tint.json` 第 1 行语法错误」，没有画出 effect pass。这是测试工程的写法问题，不影响结论：上屏那一步在真实样本里已经核对过。

**脚本里的用法（`ignore/p5/a0/out/scan_scripts.txt`）：**
- 字段脚本挂在 `parallaxDepth` 上的有 2582765611、2896608544。
- `bar.parallaxDepth = new Vec2(0, 0)` 出现在 3304642534、3549863808、3570308528 的音频条脚本里，它们还要 `createLayer`（P6）。
- 写 `cameraparallax*` 的只有 2887099508 的一段混淆脚本。
- p3-script-REPORT I3：`parallaxDepth` 改值只改字段、没有回调；视差每次绘制都重读，下一帧生效。
