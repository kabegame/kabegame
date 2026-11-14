# P13 实测报告

> 读码见 [rea-p13-passes.md](rea-p13-passes.md)（反射、阴影、体积光、mip 帧缓冲、一帧的顺序）与 [rea-p13-lights.md](rea-p13-lights.md)（遗留灯、雾、灯的运行时、sprite 对象、透视场景余项、材质细节）。总计划见 [phase-13-3d-lighting.md](phase-13-3d-lighting.md)。

## P13 语义的实测核对（2026-11-14）

WPE 2.8.42，窗口 1920×1080。用户设置（`config.json` 的 `general.user`）：`preset: low`、`reflection: false`、`resolution: full`、`shadows: low`、`volumetrics: low`、`postprocessing: ultra`、`msaa: none`。别的档位用 `capture_sweep` 临时改、扫完自动改回（两次扫描结束后 `config.json` 的 SHA-256 都回到 `14911078…`）。抓帧：真实样本在 `A:\p13\samples\`，扫描在 `A:\p13\sweep\`；常量批量提取 `ignore/p13/out/wpe-*-consts.json`（`kbp rdc consts --no-clock`，汇总 `ignore/p13/consts_uniq.py`）；原始笔记 `ignore/p13/out/notes-step0.md`。

这一轮只用了真实样本（5 张默认工程、4 张工坊场景），没有做确定性工程；读码里只有确定性工程才测得到的条目列在「没有实测的」。

| # | 读码结论 | 抓帧 | 结果 |
|---|---|---|---|
| 1 | 遗留灯：`g_LightsPosition[槽]` = 世界平移，`g_LightsColorRadius[槽]` = (color × intensity, radius)；空槽 (0, 100, 0) / (0, 0, 0, 1) | demon_core event 23：[0] = 灯 origin (3.106, 2.692, −0.204)、(0.67, 0.67, 0.67, 17.13)；[1–3] = (0, 100, 0) / (0, 0, 0, 1) | 成立 |
| 2 | `genericimage2` 读 `g_LightsColorPremultiplied[3]`，不读 `g_LightsColorRadius`（总计划写错） | WPE 着色器原文 `genericimage2.frag:31` | 成立，总计划已改 |
| 3 | `reflection: false`：`_rt_Reflection` 照建、每帧清成清屏色（alpha 1），反射 pass 不画 | arsenal：RT 46741 清成 (0, 0, 0, 1)，之后没有绘制画进去，planks 照读 | 成立 |
| 4 | `_rt_Reflection` 是窗口尺寸的 RGBA8，读它的采样器 Clamp + Linear | arsenal、fantasticcar：1920×1080 R8G8B8A8_UNORM、1 级 mip；ClampEdge + Linear | 成立 |
| 5 | 反射 pass：镜面恒为世界 y = 0，视图换成 `S·V`、投影 `P[1][1]` 取反（透视下等于 `S·VP·S`，S = diag(1, −1, 1, 1)）；`g_EyePosition` 的 y 取反；剔除不变 | fantasticcar（reflection true）同一网格 event 35 / 158：`g_ModelMatrix` 相同，VP 恰是 `S·VP·S`，eye y 取反，两边都是 CullMode.Back、front_ccw | 成立 |
| 6 | 反射名单：可画对象缺省进；模型只要有一个网格的材质读 `_rt_Reflection`，整个对象排除 | fantasticcar（Shadow 没写 `reflected` 也画、读反射图的 Grid 不画）、arsenal（唯一的模型带读反射图的 planks，反射 pass 一次都不画）、audiophile（flow、glow 没写也画，grid 不画） | 成立 |
| 7 | 读反射图的着色器屏幕 UV 不翻 y，所以反射图上下颠倒地画 | fantasticcar Grid（event 251）：UV = clip.xy / clip.w × 0.5 + 0.5 | 成立 |
| 8 | 阴影图集边长：low / medium 256、high 512、ultra 1024，R32_TYPELESS，每帧清；`disabled` 不建 | 3287715210 四档 + disabled：256、256、512、1024；disabled 没有图集清屏 | 成立 |
| 9 | 点光阴影投影近平面：正交场景 1，远平面 max(radius, near + 0.01) | 3287715210（正交，半径 700.22）：`g_RenderVar3` = (0.00143, 1.00143, −1, 0) = (1/699.22, 700.22/699.22, …) | 成立 |
| 10 | 比较采样器：比较 + 三线性、BORDER、边框 0、GREATER | ultra / medium：ClampBorder、Linear、Comparison、Greater、border 0 | 成立 |
| 11 | 体积光：low / medium 1/8 分辨率、合成前两次模糊（3 次全屏）；high / ultra 1/4、1 次全屏；加法混合；`disabled` 整段跳过 | 3287715210：low / medium 240×135 + 3 次；high / ultra 480×270 + 1 次；SrcAlpha / One；disabled 没有体积光绘制 | 成立 |
| 12 | 体积光常量：半径 × 0.99、cos 内外锥缺省、intensity、origin、density、颜色、volumetricsexponent | `g_RenderVar1` = (693.22 = 700.22 × 0.99, cos20°, cos30°, 4.58)，`g_RenderVar2` = (origin, 0.65 = 场景写的 `density`)，`g_RenderVar4` = (1, 1, 1, 1.7) | 成立 |
| 13 | 体积光在 `objects` 里灯的位置画、到下一个非灯对象前合成 | 3287715210：体积光夹在图像层之间（event 246–337），之后才是剩下的对象 | 成立 |
| 14 | `_rt_MipMappedFrameBuffer`：`reflection: false` 时只在加载时清成 (0, 0, 0, 1)、不再更新；mip 数 = max(1, min(log2(npot(w)/2), log2(npot(h)/2)) − 2)，`g_Texture3MipMapInfo` = mip 数 | 3453730450（reflection false）：RT 456 1920×1080、8 级 mip，整张 (0, 0, 0, 1)，本帧没人写；`g_Texture3MipMapInfo` = 8 | 成立 |
| 15 | `reflection: true` 时主 pass 画完、泛光之前拷 0 级再 `GenerateMips`，主 pass 读到的是上一帧 | 3453730450（reflection true）：event 985 ResolveSubresource、986 GenerateMips，之后是泛光的 4 次全屏；读它的绘制都在帧开头 | 成立 |
| 16 | 雾：`g_FogDistanceParams` / `g_FogHeightParams` = (start, end − start, startdensity, enddensity − startdensity)，颜色原值 | 3706286085：(−5, 225, 0, 0.5) / (−8.35, 83.35, 0, 0.6)，颜色 (0.635, 0.745, 0.753) / (0.631, 0.804, 1.0)，同 JSON | 成立 |
| 17 | V1 灯的 uniform 每帧算：字段脚本、关键帧当帧生效 | 3706286085：平行光 `g_LDirectional_Color` = sunlight × 3.34（`intensity` 挂脚本）；3465215190：`intensity` 关键帧在相邻两帧的体积光常量里是 −1.3076 → −0.4751 | 成立 |
| 18 | sprite 对象：画两次，本体的两个轴 × 2k（k 来自上一帧的遮挡查询）、遮挡测试的轴 × 0.2、z 写死；顶点位置是写死的 (−1, 0, 1)，视图平移清零 | ricepod event 179（轴为 0，k = 0）、194（轴长 0.2，z = 0）；6 个顶点都是 (−1, 0, 1) | 成立（k 的公式没实测） |
| 19 | 工坊 `cursorripple` 的 `REFLECTION` 是波纹在边界反弹的开关，不要引擎数据 | 着色器原文 `cursorripple_simulate_force.frag` | 成立 |
| 20 | 材质 combo 键名加载时转大写 | arsenal 的小写 `lightmap` 在 HEAD 上已按 `LIGHTMAP` 生效（翻译器报的是宏别名，不是缺宏） | 成立 |

**没有实测的**（要确定性工程，排进各节子计划的步骤 0 补测）：
- 遗留灯的槽位分配（第 5 盏起落到槽 0、隐藏的灯写 (0, 0, 0, 1) 盖掉同槽）、`lpoint` 也占槽、写入比脚本晚一帧；
- V1 灯超配时的排序键（类型升序 → `flags & 3` 降序 → 局部 origin 在 `g_ViewForward` 上的投影升序）；
- 投射者（模型）画进图集：剔除实际是 NONE、SlopeScaledDepthBias −4、`[PASS] shadow` 注解；平行光三级级联；多盏投影灯的图集打包；
- 体积光的灯体网格缩放、合成的混合方式；
- sprite 的 k 公式与遮挡查询的延迟；
- 雾开关在运行中改动、`FOG` 的组合缺省值；
- 灯挂父对象（父是模型）的世界矩阵；
- `transparentsorting`、透视场景里的文本 `_depth`、透视场景里带子层的组合层；
- 正交场景的反射（语料里读反射图的三张都是透视）。

## P13a 的实测（2026-11-14）

工程 `ignore/p13/proj/p13a-slots`（`ignore/p13/a0/gen_a13.py` 生成）：正交，左边 `generic` 网格、右边 `genericimage2` 图像层（`LIGHTING: 1`、不带法线图）。灯按 `objects` 顺序：`lpoint`（没有 `lightconfig`）、`point` A、B（隐藏）、C、D、E（`visible` 绑属性 `p_f`，缺省 false）。抓帧 `A:\p13a\slots\off-frame155.rdc`、`on-frame289.rdc`（`apply_properties` 把 `p_f` 改成 true 之后），常量 `ignore/p13/out/wpe-p13a-slots-consts.json`（`kbp rdc consts --no-clock`）。

| # | 预测 | 抓帧 | 结果 |
|---|---|---|---|
| A1 | `lpoint` 占槽 0、不写；A 1、B 2、C 3、D 0、E 0，同槽后写的覆盖先写的 | 槽 1 / 2 / 3 = A / B / C 的 origin；槽 0 的位置是 E 的 (1600, 300, 150)，D 被盖掉 | 成立 |
| A2 | 隐藏的遗留灯写 `(0, 0, 0, 1)`，位置照写 | 槽 2 = B 的 origin + (0, 0, 0, 1)；`p_f` false 时槽 0 = E 的 origin + (0, 0, 0, 1) | 成立 |
| A3 | `visible` 绑属性，运行中改了就跟 | `p_f` true 后槽 0 = (0.75, 0.075, 0.75, 650) = (1, 0.1, 1) × 0.75、半径 650 | 成立 |
| A4 | 颜色半径 = (color × intensity, radius)，不乘 scale | A：(1.5, 0.3, 0.15, 600) = (1, 0.2, 0.1) × 1.5；C：(0.25, 0.375, 1.25, 700) | 成立 |
| A5 | `g_LightsColorPremultiplied[i].rgb = c_i·r_i²`，`[i].w = c_3[i]·r_3²` | `[1].rgb` = (540000, 108000.0078, 54000.0039)，`[0..2].w` = (122500, 183750, 612500) = C 的 (0.25, 0.375, 1.25) × 700² | 成立 |
| A6 | `genericimage2` 也读 `g_LightsPosition`（顶点段），与 `generic` 同值 | event 65 与 48 的 `g_LightsPosition` 相同 | 成立 |

**单精度**：`108000.0078` 是 `0.2f × 1.5f = 0.30000001f` 再乘 `360000` 后舍入到单精度的结果；按双精度算再存成单精度得 `108000.0`，差 1 ulp。所以颜色乘强度、半径平方、两者相乘都要逐步按单精度舍入（`Math.fround`）。

**两条读码更正**（读码代理顺带查出）：
- rea-p5-mesh 第 5 节：`FUN_14017e180` 是剔除状态栈的 push，不是镜像视图；反射 pass 的触发位是 `G+0xe0` bit0，不是 `0x20000`；渲染标志 bit0 在壁纸进程里一直置位。
- rea-p5-mesh 4.1 的「作用未知」`FUN_140198d00` 是体积光的模糊与合成。

## P13b1 的实测（2026-11-14）

「反射关」时两张 RT 的内容。工程 `ignore/p13/b1/gen_b1.py` → `ignore/p13/proj/p13b1-*`（正交 1920×1080，自带着色器按屏幕 UV 采 `g_Texture0`），抓帧 `A:\p13b1\`，常量 `ignore/p13/b1/out/`。WPE 设置没动（`reflection: false`、`postprocessing: ultra`）。

| # | 预测 | 抓帧 | 结果 |
|---|---|---|---|
| B1 | 有模型读 `_rt_Reflection` 时建窗口尺寸 RGBA8、每帧清成清屏色（alpha 1），Clamp + Linear；`g_Texture<n>Resolution` 是 RT 尺寸 | r1：1920×1080、1 级，整张 (0.2, 0.4, 0.6, 1)；ClampEdge + Linear；(1920, 1080, 1920, 1080) | 成立 |
| B2 | 同一场景里图像层读它也绑同一张 | r1 event 50 与 67 同一张 RT | 成立 |
| B3 | 只有图像层读、没有模型读时 RT 不建 | r3：帧里只有场景的清屏；图像层绑 6×6 黄黑棋盘格，Wrap + Point，`Resolution` (6, 6, 6, 6) | RT 不建成立；绑的是棋盘格占位（新事实） |
| B4 | 反射图的清屏不看 `clearenabled` | r4：场景不清，反射图仍清成清屏色 | 成立 |
| B5 | 清屏色运行中改了，反射图跟着变 | r5：`p_cc` → (0.8, 0.1, 0.3)，反射图 (204, 25, 76)/255 | 成立 |
| B6 | HDR 下仍是 RGBA8，清屏色截到 [0, 1] | r6：场景目标 RGBA16F；反射图 (255, 127, 64)/255（清屏色 2 0.5 0.25） | 成立 |
| B7 | `_rt_MipMappedFrameBuffer` 图像层读也建；整张 (0, 0, 0, 1)；mip 数 = max(1, min(log2(npot(w)/2), log2(npot(h)/2)) − 2)，`g_Texture<n>MipMapInfo`（float）= mip 数 | r7：1920×1080 8 级、1600×900 7 级，各级全黑 alpha 1，ClampEdge + 三线性；MipMapInfo 8.0 / 7.0 | 成立 |
