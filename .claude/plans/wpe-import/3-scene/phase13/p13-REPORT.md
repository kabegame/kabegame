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

## P13b2 的实测：反射开（2026-11-14）

「反射开」时反射 pass 画什么、怎么画。工程 `ignore/p13/b2/gen_b2.py` → `ignore/p13/proj/p13b2-{persp,noclear,ortho,cull,ptc,ptco}`（地面网格读 `_rt_Reflection`、按屏幕 UV 直接输出），抓帧 `A:\p13b2\<名>-on\`（`capture_sweep` 临时 `reflection: true`，每次扫完改回、哈希复原），常量 `ignore/p13/b2/out/wpe-*-consts.json`，顶点 `ignore/p13/b2/out/*.json`，核对脚本 `ignore/p13/b2/{reproject,trail_axis,mesh_diff}.py`。

| # | 预测（读码） | 抓帧 | 结果 |
|---|---|---|---|
| C1 | 名单 = 可画对象 − `reflected: false` − 读反射图的模型，创建顺序 | persp：反射 pass 画 FR、CLK（图像层）、红、绿、蓝、探针，不画地面与黄片 | 成立 |
| C2 | 透视：VP' = S·VP·S | persp：反射 pass 的 MVP / VP 第 1 行、第 1 列取反，逐值 | 成立 |
| C3 | eye、`g_ViewRight`、`g_ViewUp` 的 y 取反，`g_ViewForward` 不变 | persp 探针：eye (0, 3, 8) → (0, −3, 8)，up、right 取反，forward 不变 | 成立 |
| C4 | 没有斜裁剪面 | 地面以下的蓝片画进反射图 | 成立 |
| C5 | 借后备缓冲的深度，`clearenabled` 时清颜色与深度 | 两段 pass 共用一张 D32F；反射 pass 开头清（清屏色、alpha 1；深度 0），主 pass 再清；写掩码 RGB | 成立 |
| C6 | `clearenabled: false` 时反射图不清 | noclear：一帧里没有任何清屏 | 成立（颜色与深度都不清） |
| C7 | 正交场景走同一段代码 | ortho / ortho2：反射 pass 的 MVP（模型与图像层）和主 pass **逐值相同**，只有 eye、up 的 y 取反 | **不成立**：正交不镜像 VP |
| C8 | 视锥剔除平面由当前 VP 现算（推） | cull：主视图视锥外、镜像后在视锥内的品红片，反射 pass 画、主 pass 剔 | 成立：按镜像 VP 剔 |
| C9 | sprite 粒子 | ptc：反射 pass 四角 = 按**主视图**的 `g_Orientation*` 在世界里展开、再乘镜像 VP（w 8.9714 / 8.6866 手算逐位） | 新事实：朝向不按镜像视图重算 |
| C10 | 拖尾粒子 | ptc：宽度方向与 cross(速度, 中心 − 本 pass 眼位) 平行（|cos| = 1，另一个眼位 0.836），反射 pass 用镜像眼位（`ComputeParticleTrailTangents` 读 `g_EyePosition`） | 新事实 |
| C11 | 正交的粒子与文本 | ptco：反射 pass 与主 pass 的 sprite、文本顶点逐值相同，拖尾差 0.0026（眼位翻了） | 与 C7、C10 一致 |
| C12 | 真实场景 | arsenal（反射开）：反射 pass 没有绘制（名单里两个空模型对象、FR 在透视场景画面外），反射图只是清屏色 | 名单为空的路径在语料里会走到 |

## P13b2 补测：对齐方式与反射 RT 的清屏色（2026-11-14）

渲染尺寸那一节（`../phase-render-size.md`）实测了对齐方式 1 / 3 时 WPE 把整个后备缓冲清成 `schemecolor`，留了一条 `TODO:[WPE_SCENE]`：
反射 RT 是不是也拿到 `schemecolor`（读码推断设备清屏色是共享状态）。

- 工程 `ignore/p13/b2/gen_scheme.py` → `ignore/p13/proj/p13b2-scheme`：同 p13b2-ortho（正交 1920×1080，地面铺下半屏、读 `_rt_Reflection`
  按屏幕 UV 直接输出），清屏色 0.15 灰、`schemecolor` (0, 0, 0.6)。地面所在的下半屏反射图里没有对象。
- 窗口 1920×800，开窗后 `apply_properties({"alignment": 0 | 1 | 3})` 各抓一帧；先在用户原设置（反射关）下抓（`A:\p13b2\scheme\off-a*`），
  再 `restart_wpe({"reflection": true})` 抓一轮（`on-a*`），抓完 `restart_wpe({"reflection": false})` 改回（`config.json` 哈希回到改前的
  `cc5081…`）。
- 读反射 RT 本身（反射关：地面绘制时绑的 `g_Texture0`；反射开：反射 pass 末尾的目标）在 (960, 700) 的值：

| 对齐方式 | 反射关 | 反射开 |
|---|---|---|
| 0 | (0.149, 0.149, 0.149, 1) = `clearcolor` | (0.149, 0.149, 0.149, 1) |
| 1 | (0, 0, 0.6, 1) = `schemecolor` | (0, 0, 0.6, 1) |
| 3 | (0, 0, 0.6, 1) | (0, 0, 0.6, 1) |

**结论**：反射 RT 和主目标用同一个清屏色，反射开、关都一样，读码推断成立。渲染器改成一个 `clear = targetClear ?? clearcolor` 两处共用
（`render/scene.ts` 的 `encode`），去掉那条 TODO。我们这边按指定尺寸画（`renderFrames.ts --canvas 1920x800 --render-mode target --style
fill | fit | center`，dev 覆盖切反射开 / 关）6 组都和 WPE 整帧 0 差异；改之前 fit / center 下地面会是灰色。

## P13c 的实测：sprite 对象（2026-11-14）

工程 `ignore/p13/c/gen_c.py` → `ignore/p13/proj/p13c-{open,half,full,moved,ortho}`：透视，相机看向 (−1, 0, 1)，sprite 去掉视图平移后在屏幕
正中、距离 √2；sprite 材质 = ricepod 的 `sprite.vert` + 输出红色 × `g_Alpha` 的片元（additive）；写深度的灰挡板在相机前 3 个单位，屏幕右方向上
`open` [1.5, 2.5] 不挡、`half` [0, 1.5] 挡右半、`full` [−1.5, 1.5] 全挡；`moved` 同 open 但相机平移、sprite 写 origin / scale / angles；
`ortho` 正交 1920×1080。抓帧 `A:\p13c\<open2|half2|full2|moved2|ortho>`（1920×1080，各 5 / 3 帧），常量 `ignore/p13/c/out/wpe-*-consts.json`。

| # | 问题 | 抓帧 | 结果 |
|---|---|---|---|
| S1 | `k = min(512 · ((n/2) >> s) / Hs², 1)` | open：光斑的 `|g_ViewUp|` = 2、`g_Alpha` = 1（k = 1）；full：0、0；half：`|g_ViewUp|` = 1.475775、`g_Alpha` = 0.5444779 = k²。遮挡方块中心在 (960, 540)、边长 81.9 像素，覆盖 82 × 82 个像素中心；half 的挡板左缘正好在 x = 960，能看见 41 × 82 = 3362 个，n/2 = 1681，512 · 1681 / 1080² = 0.737888 | 成立，`s = 0`（无 MSAA），`Hs` = 后备缓冲高；5 帧都相同 |
| S2 | 查询没就绪时 k 取什么 | half 开 1920×1080 窗口，PrintWindow 采 10 s（269 次）：太阳处 (940, 540) 恒为 (139, 0, 0) = 255 · k² | 不闪：结果总能在下一帧拿到 |
| S3 | 遮挡方块写不写颜色 | 遮挡测试那次绘制（e75）的写掩码 8（只写 A）、不混合；绘制前后 RGB 逐像素相同 | **推翻读码的推测**：只写 alpha（写 1），不写 RGB |
| S4 | 拼错的 `depthtesting` / `depthwriting` | ricepod `orbital_*`（e35）：深度测试开、GREATER、不写深度，additive，剔背面 | 成立：WPE 不读这两个键，按缺省 |
| S5 | 对象变换无效、视图去平移 | moved（相机在 (3, 1, −2)、sprite 写 origin 5 5 5 / scale 3 / angles）：两次绘制的 MVP 与 open 逐值相同 | 成立 |
| S6 | 正交场景 | ortho：MVP 就是场景的正交投影（视图去平移后是单位阵）；光斑 k = 0（遮挡方块在 x = −1 像素外，没有样本） | 成立：同一套公式，不用特判 |

其它：两次绘制的 MVP 相同；光斑的 `g_ViewUp` = (0, 2k, 0)、`g_ViewRight` 长度 2k，遮挡方块的两个轴长 0.2；遮挡方块深度测试 GREATER、不写深度、
不剔除。

### P13c 走查复核：ricepod（2026-11-15）

复制工程 `ignore/p13/proj/ricepod-iso-sun`，抓帧 `A:\p13c\ricepod-sun-t110-fps20-1920x1080`（脚本帧 2221–2225）。

| 项 | WPE | 我们 | 结论 |
|---|---|---|---|
| 光斑的 k | 5 帧都是 1（`|g_ViewUp|` = 2、`g_Alpha` = 1，样本数 ≥ 4556） | 5 帧都是 1（样本数 6204–6395，dev 探针 `sprites`） | 相同 |
| 场景 draw 的 `g_ViewProjectionMatrix` | — | 差 2.4e-7，最多 131 ULP | 透视相机在 double 里算，转 P5d |
| `g_EyePosition` | — | 差 1 ULP | 同上（相机路径插值） |
| 喷口、遮挡方块的 MVP | — | 差 111 ULP | 同上 |

像素差（每帧 529–6288 个差 1 级、5 帧共 7 个 > 2 的三角形边覆盖翻转、光斑光芒整列的舍入翻转）与这些 ULP 差的量级一致。P5d 修完重跑这 5 帧。

P5d 把透视相机改成逐步 float32、遮挡方块的轴长改成 float32 的 0.2 之后：第 2223 帧各 draw 0 ULP；2221 帧逐像素相同，2222–2225 帧各剩 4 / 1 / 134 / 3 个像素、都只差 1 级，
逐级定位到船体 / 喷口的片元舍入（9 个孤立像素）与泛光模糊的 1/255 差（1 个纹素），以及它们经泛光的摊开，归已知差异（详见 `phase-13c-sprite.md`「走查复核」）。

## P13d 的实测：阴影（2026-11-15）

读码 [rea-p13-shadows.md](rea-p13-shadows.md)；工程 `ignore/p13/d/gen_d0.py`、`gen_d8.py`、`gen_d9.py` → `ignore/p13/proj/p13d-*`；抓帧 `A:\p13d\sweep\`（`capture_sweep` 扫 `shadows` 五档，重启 WPE 4 次后改回 `low`，`config.json` 哈希回到 `cc5081…`）、`A:\p13d\spec\`、`A:\p13d\sweep2\`；常量 `ignore/p13/out/wpe-p13d-*-consts.json`。

| # | 预测 | 抓帧 | 结果 |
|---|---|---|---|
| D1 | 点光：方块 256 / 256 / 512 / 1024，fov 94 / 94 / 92 / 91.2°，近平面正交 1、透视 `max(0.05, lightsourcesize)`，远平面 `max(radius, near + 0.01)`；阴影 pass 不偏移 | po / pp / pp-ls 五档：`P11` 0.932515 → 0.979272，`g_LFeature_ShadowPointProjection` = (n/(f−n), n·f/(f−n), −1, 0)；阴影 pass 的 `VP[3][2]` 比 uniform 推算的少 0.00333 | 偏移那条推翻：投影 `P32 − 0.00333f`（读码补上，三组 float32 逐位相同），其余成立 |
| D2 | 平行光三级 `(3, 40)`、`(10, 40)`、`(100, 150)`，防抖，阴影 pass `m32 − 0.0005` | dir / dir-b / dir-cd / dir-high / dir-ultra：uniform 0.5109016、阴影 pass 0.5104015；三块横排（low 768×256） | 成立（R3 的算式复算到 1–2 ULP） |
| D3 | 阴影 pass 不剔除 | cull：主 pass 剔掉的单面平面在地面上有影子 | 成立 |
| D4 | 只有不透明且 castshadow 的模型投射 | who：阴影 pass 只有地面与 CAST 立方体 | 成立；地面本身也是投射者 |
| D5 | 打包一行 `8192/S` 块 | multi-ultra：5 块，5120×1024 | 成立 |
| D6 | 没有投射者时图集照清、不画 | none：只有清图集 | 成立 |
| D7 | `disabled` 不画阴影 | po / pp-disabled：没有阴影 pass | 成立 |
| D8 | 专用投射着色器、A2C、fur 只投一层 | spec：棋盘格孔、影子随风动、fur 主 pass 9 实例 / 阴影 1 层 | 成立（无颜色附件时 A2C 仍生效） |
| 补测 | 配置不一致与图集 | over：投射灯多于 pointshadow 时被普通灯覆盖；hide：隐藏后图集不缩；dir2：6 级 6 块；fur5 / fur21 阴影相同 | 成立 |

另：WPE 对每个模型只给通过视锥测试的视图发实例，视口数组一起压紧（who event 30 视口 0 是 −X 面）。

### 和 WPE 的整帧对照（low 档，进行中）

我们用 `render_scene` 按抓帧的 `g_Time` 渲一帧，WPE 取同一帧，排除右下角 FR / CLK。差异位置图由 `ignore/p13/d/ana/overlay.py` 生成，内容是：WPE 画面压暗作底，差异像素黄（1–2 级）/ 橙（3–32）/ 红（> 32），青框是聚集区，图下方按框放大成「我们 | WPE | 差 ×16」三栏。

| 工程 | 差异像素（> 2 / > 32） | 位置图 | 说明 |
|---|---|---|---|
| p13d-none（只有接收者） | 0 | [none.png](../../../../../ignore/p13/d/overlay/none.png) | |
| p13d-po（正交点光） | 3（0 / 0） | [po.png](../../../../../ignore/p13/d/overlay/po.png) | 三个孤立像素，各差 1 级，不在影子边缘 |
| p13d-pp（透视点光） | 3（0 / 0） | [pp.png](../../../../../ignore/p13/d/overlay/pp.png) | 同上 |
| p13d-dir（平行光三级联） | 4（0 / 0） | [dir.png](../../../../../ignore/p13/d/overlay/dir.png) | 同上 |
| p13d-spec-ns（专用投射者，关阴影，只比主 pass） | 54（43 / 43） | [specns.png](../../../../../ignore/p13/d/overlay/specns.png) | 43 个大差全在两块 A2C 棋盘格平面的格子边上（框 #1–#5）：我们画了，WPE 没画；其余 11 个 1 级 |
| p13d-spec（专用投射者，开阴影） | 12342（11410 / 6285） | [spec.png](../../../../../ignore/p13/d/overlay/spec.png) | 主体是地面上两条横带（#1 7092、#2 5196）：图集第 127 行是 chroma4 棋盘格的格子边界，我们的 A2C 让平面写了深度、WPE 没写，这一行纹素放大到屏幕上成了约 30 像素高的影带；#3–#9 同 spec-ns 的主 pass 像素 |

## 单采样 A2C 的阈值是 0.5 + 2⁻¹²（P13d 附带，2026-11-15）

图集逐行对照（`ignore/p13/d/ana/atlas_rows.py`）：棋盘格在 −Y 面里约 1.8 行一格，第 127 行的纹素中心正好落在 z = 0 那条格子边界上（纹理 v = 0.5）。WPE 这一行整行都没画平面，我们整行都画了，而且两种奇偶的格子都画了。若只是 uv 插值偏了一点，偏差的符号会随格子奇偶翻转，只会画一半，所以差别在「正好在边界上」时的判定。

工程 `ignore/p13/d/gen_d10.py` → `p13d-a2cth` / `a2cth2` / `a2cth3`（只在 WPE 里跑，抓帧 `A:\p13d\a2cth*\`，读数 `ignore/p13/d/ana/a2cth_read.py`）：

| 条 | 内容 | WPE（本机 NVIDIA，D3D11 单采样） |
|---|---|---|
| A | 自写着色器输出 alpha = 0.5 + d，blending alphatocoverage；d = 2⁻²⁴ … 2⁻⁸ 逐段翻倍 | 2⁻¹² 起画，2⁻¹³ 及以下不画 |
| A（a2cth2） | d = i·2⁻¹⁶，i = 0…17 | i = 16（= 2⁻¹²）起画，15 不画 |
| A（a2cth3） | d = 2⁻¹² − j·2⁻²²，j = 0…17 | 只有 j = 0 画 |
| B | alpha = 0.5 − d | 全不画 |
| C | 同一张 64×64 棋盘格在 v 正好 0.5 处采样，输出 (a − 0.5)·2¹⁷ | 读出 ±1（饱和），即过滤值是 0.5 ± 2⁻¹⁷，不是 0.5 |

每段 100×100 像素整片一致，不按像素位置抖动。结论：**单采样 A2C 在 alpha ≥ 0.5 + 2⁻¹² = 2049/4096 时才覆盖**，等价于「乘 4096 截断后大于 2048」；P8 测到的「0.4995 不画、0.5005 画」落在这个阈值两侧，所以当时定成 `> 0.5`。

同一块 GPU 上我们也拿到 0.5 + 2⁻¹⁷（宿主里的 WebGPU 实验，`ignore/p13/d/ana/a2c_probe.js`）。锐化 `(a − 0.5)/max(fwidth(a), 1e-4) + 0.5` 之后约 0.500015：`> 0.5` 判成画，WPE 判成不画。这就是第 127 行，也是 spec-ns 主 pass 里那 43 个格子边像素。

改法：A2C 入口的丢弃条件从 `!(a > 0.5)` 改成 `!(a >= 0.500244140625)`（`render/programs.ts` 的 `A2C_THRESHOLD`，NaN 仍丢），主 pass 与阴影投射者共用。

改后重比（同一时刻、同一张 WPE 帧，宿主产物 `index-DMF0Ix6j.js`）：

| 工程 | 改前 | 改后 | 位置图 |
|---|---|---|---|
| p13d-spec | 12342（> 32：6285） | 14，全部差 1 级 | [spec-a2c.png](../../../../../ignore/p13/d/overlay/spec-a2c.png) |
| p13d-spec-ns | 54（> 32：43） | 11，全部差 1 级 | [specns-a2c.png](../../../../../ignore/p13/d/overlay/specns-a2c.png) |
| p13d-spec 阴影图集 | 35 个纹素差 > 1e-4 | 0 | — |
| p8-a2c 第 162 帧（P8 回归，按日志回放） | 0 | 0 | [p8-a2c.png](../../../../../ignore/p13/d/overlay/p8-a2c.png) |
| p8-misc 第 155 帧（同上） | 0 | 0 | [p8-misc.png](../../../../../ignore/p13/d/overlay/p8-misc.png) |

剩下的 1 级差异是零散的孤立像素（地面光照的舍入），和 po / pp / dir 同一类。P8 两个工程临时导入 dev 库（15140、15141），测完已用 `projects_remove` 移除。

### 五个档位与全部补测工程对照 WPE（2026-11-15）

计划 `ignore/p13/d/ana/plan_cmp.py`（抓帧标签 → 工程、库里的行号、档位、第一帧的 `g_Time`）→ `ignore/p13/d/cmp-plan.json`；WPE 的帧 `kbp rdc frame --present` → `ignore/p13/d/wpe/frames/`；我们的帧按抓帧时刻 `render_scene`（画布 1920×1080），档位用 dev 覆盖 `localStorage["kabegame-dev-scene-shadows"]`（结果里 `shadows.quality` 核对过，测完已删）→ `ignore/p13/d/ours/cmp/`；比较 `ignore/p13/d/ana/cmp_all.py`（排除 FR / CLK，> 2 的出位置图 `ignore/p13/d/overlay/cmp-<标签>.png`）。`hide` 一个目录两次抓帧：`hide-on` 第 151 帧两盏都亮，`hide-off` 第 182 帧运行中把 `p_v` 改成 false 之后。

| 抓帧 | 档位 | > 0 | > 2 | > 32 | 最大差 |
|---|---|---|---|---|---|
| cull-low | low | 9 | 0 | 0 | 1 |
| dir-high | high | 5 | 0 | 0 | 1 |
| dir-low | low | 4 | 0 | 0 | 1 |
| dir-ultra | ultra | 4 | 0 | 0 | 1 |
| dir2-low | low | 28 | 0 | 0 | 1 |
| dirb-low | low | 5 | 0 | 0 | 1 |
| dircd-low | low | 5 | 0 | 0 | 1 |
| fur21-low | low | 3 | 0 | 0 | 1 |
| fur5-low | low | 3 | 0 | 0 | 1 |
| multi-low | low | 29 | 0 | 0 | 1 |
| multi-ultra | ultra | 32 | 0 | 0 | 1 |
| none-low | low | 0 | 0 | 0 | 0 |
| over-low | low | 8 | 0 | 0 | 1 |
| po-disabled | disabled | 4 | 0 | 0 | 1 |
| po-high | high | 4 | 0 | 0 | 1 |
| po-low | low | 3 | 0 | 0 | 1 |
| po-medium | medium | 4 | 0 | 0 | 1 |
| po-ultra | ultra | 5 | 0 | 0 | 1 |
| pp-disabled | disabled | 4 | 0 | 0 | 1 |
| pp-high | high | 3 | 0 | 0 | 1 |
| pp-low | low | 3 | 0 | 0 | 1 |
| pp-medium | medium | 3 | 0 | 0 | 1 |
| pp-ultra | ultra | 3 | 0 | 0 | 1 |
| ppls-low | low | 3 | 0 | 0 | 1 |
| spec-low | low | 14 | 0 | 0 | 1 |
| specgen-low | low | 10 | 0 | 0 | 1 |
| who-low | low | 6403 | 6400 | 6400 | 142 |
| hide-on | low | 10 | 0 | 0 | 1 |
| hide-off | low | 2 | 0 | 0 | 1 |

- 除 `who-low` 外每张最多 32 个像素、都只差 1 级（孤立的光照舍入）。`ppls-low` 与 `pp-low` 我们的像素摘要相同，各自和 WPE 都只差 3 个像素：光源尺寸只改近平面，影子在画面上不变。
- `who-low` 的 6400 个像素是一个 80×80 的白色粒子方块：屏外探针不步进粒子（存活数 0），与阴影无关，方块周围没有影子差异（D4：粒子不投影）。
- `hide-off` 最初整帧发黑（平均亮度 7）：WPE 给没有灯的第 2 个槽写全 0（常量文件逐值核对，我们写的也是全 0），投影 `w` 为 0，坐标是 0/0 的 NaN。硬件比较采样吃掉 NaN、结果有限；`kb_shadowCompare` 越界分支手算双线性的权重 `p − floor(p)` 是 NaN，经 `mix` 进了整个光照和。权重改成 `w >= 0 ? w : 0` 后只剩 2 个像素差 1。WPE 运行中隐藏时图集不缩（方块变换 `(0, 0, 0.5, 1)`），我们整场重编译按一盏灯建图集（`(0, 0, 1, 1)`），画面相同。

## P13f 的实测：雾与灯的运行时（2026-11-15）

工程 `ignore/p13/f/gen_f0.py` → `ignore/p13/proj/p13f-*`，抓帧 `A:\p13f\<名>\`，常量 `ignore/p13/f/out/wpe-p13f-*-consts.json`（`kbp rdc consts --no-clock`），打印 `ignore/p13/f/show_fog.py`、`show_lights.py`、`show_vol.py`，整帧比 `imgdiff.py`。WPE 设置没动（反射关、阴影 low、体积光 low）。

**雾**

| # | 问题 | 抓帧 | 结果 |
|---|---|---|---|
| F1 | 四个 uniform 的打包 | `p13f-fog`（透视，`generic4` 地面 + 方块） | `(start, end − start, startdensity, enddensity − startdensity)`，差值按 float32 减法（0.8 − 0.1 = 0.699999988），`end < start` 时 `.y` 为负；颜色原值 |
| F2 | 宏的条件 | 同工程：缺省 `FOG`、`FOG: 1`、additive、`FOG: 0`、`generic2`；`p13f-fog-off` 两开关都关 | 前三个有雾 uniform，`FOG: 0` 与 `generic2`（不声明 `FOG`）没有；两开关都关时没有任何绘制带雾 uniform |
| F3 | 运行中改开关 | `fogdistance` 绑属性，改成 false | 雾 uniform 照写，整帧与改之前逐像素相同（宏不变） |
| F4 | 运行中改数值 | `fogdistanceend` 改 9 | 下一次抓帧 `.y` = 5，画面跟着变 |
| F5 | 正交场景 | `p13f-fog-ortho` | `g_EyePosition` = (960, 540, 2000)，打包同上 |
| F6 | 粒子 | `p13f-fog-ptc`：translucent、additive、`FOG: 0` 三个 `genericparticle` | 前两个上雾，`FOG: 0` 不上 |
| F7 | 图像层（**新事实**） | `p13f-fog`（FR / CLK）、`p13f-fog-img`、`p13f-fog-fs` | 任一雾开关为真时，**每个**图像层与文本层都走「基础 pass → 合成 RT → passthrough 上屏」，没有 effect 的、FR / CLK 这种自定着色器的、组合层、不带 effect 的全屏层都是（即 p2-REPORT 的「渲染标志 `0x1800000` 强制所有图层走 passthrough」，`0x1800000` 就是两个雾开关）。上屏 pass 的 `FOG_COMPUTED`：图像层取基础材质最终的 `FOG`（缺省 1 的上雾；`FOG: 0`、`genericimage2`、自定着色器、`composelayer` 不声明 `FOG`，上屏定义了 `FOG_DIST` 却不读雾 uniform）；文本层（`font` 不声明 `FOG`）照样上雾，即 passthrough JSON 原样的 1 |

F7 是我们第一次对照时整帧差 25 级的原因：透视工程里 FR 的上屏四边形（80×60 个世界单位）盖住整个画面、关混合写回合成 RT 的透明黑，天空成了 (0, 0, 0)。

**灯的运行时**

| # | 问题 | 抓帧 | 结果 |
|---|---|---|---|
| L1 | V1 与遗留灯的时序 | `p13f-light`（5 帧连抓）：`lpoint` LV 与 `point` LG 挂在 `origin` 关键帧平移的模型下，`intensity` 挂同一条关键帧 | LV 的位置 = 本帧模型平移 + 本地 (0, 1.5, 0)、强度 = 本帧关键帧值；LG 的位置与强度都是**上一帧**的（含循环回绕那一帧） |
| L2 | 字段脚本、脚本对象 | 同工程：LR 的 `radius` 字段脚本、LS 的 `getLayer('LS').intensity = …` | 都当帧进 uniform；写入读回是 float32。灯的脚本对象：`light` 是字符串（`lpoint`），`color` / `controlpoint` / `origin` / `angles` / `scale` 是 Vec3，`castshadow` / `castvolumetrics` / `usecookie` / `visible` 布尔，其余数值，`alpha` / `brightness` 是 undefined |
| L2′ | 排序键 | 同工程 | 局部 origin：挂在父下的 LV 按本地 (0, 1.5, 0) 排在两盏 z = 2 的灯之后 |
| L3 | 超配排序 | `p13f-sort`：`point: 2`、A 带 `castshadow`、B 的 `origin` 绑属性 | 同 P13d 的 `lightFrame`：A 先写槽 0、被后面 key 较小的普通灯覆盖，槽 1 空；B 挪到相机前后留下的换成 B |
| L4 | 体积光灯在运行中变 | `p13f-vol`：L1 挂在 `origin` / `visible` 绑属性的空对象下，两盏灯之间的立方体 `visible` 绑属性 | 隐藏立方体 → 两段并成一段、合成一次；隐藏父对象 → L1 不画、没有它那一段；挪父对象 → L1 的位置 = 父 + 本地 |

**P13f2 实现中补出的一条（2026-11-16）**：`p13f-sort` 第一次对照差 82 级。WPE 选灯时「带阴影」的判定只看用户阴影档 ∧ `castshadow`（`ctx+0x1ac`，同 P13e 的 `SHADOW`），我们从 P13d 起只在 `lightconfig` 有阴影计数时才解析阴影档、否则当 0，带 `castshadow` 的灯就不先写槽 0。改成有带 `castshadow` 的 V1 灯时照样解析档位（图集仍只在有阴影计数时建）后两种状态各差 2 个像素 1 级。
