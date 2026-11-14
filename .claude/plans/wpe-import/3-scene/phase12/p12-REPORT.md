# P12 步骤 0 实测报告：骨骼与 puppet

> 上级：[phase-12-puppet.md](phase-12-puppet.md)「步骤 0 — 调研」。读码见 [rea-p12-mdl](rea-p12-mdl.md)（段格式与加载）、[rea-p12-runtime](rea-p12-runtime.md)（每帧更新、混合、蒙皮）、[rea-p12-attach-physics](rea-p12-attach-physics.md)（挂点、物理、脚本）。
> 2026-11-14。WPE 2.8.42，用户常驻的那个，设置 fps 20，没改设置。抓帧在 `A:\p12\`，工程、日志、提取的常量在 `ignore/p12/`，分析脚本在 `ignore/p12/meas/`。第一、二部分由两个实测代理做，主会话重跑抽查过（见「复核」）。

## 总述

读码的结论基本都被实测证实，三份读码的 python 模型和 WPE 抓到的常量逐帧对上：
- **动画**：时钟、模式、采样、三种混合、淡入淡出、绑定字段的生效帧、骨骼透明度、变形，和 WPE 差 ≤ 5 ulp，多数逐位相同。差来自 `rsqrtps` 硬件近似，模型用的是精确值。
- **物理**：照读码对上，最大差 6.8e-3 px；不算物理时差 23 px。剩下的差来自 `rotTo` 的点积阈值：差 1 ulp 就会翻转判定，`re` 没有回弹，一次翻转会一直留着。P12d 的验收要按误差包络定，不要求逐位一致。
- **挂点**：30 个语料挂点子对象，加生成工程里的图像子对象和粒子子对象，平移差 ≤ 2.6e-4 px。
- **绘制组与裁切遮罩**：画法查清了，可以直接照着实现。

有 14 处读码要更正或补充，最要紧的是：
- 裁切记录的两组下标里，哪组是遮罩、哪组是被裁切的，读码说反了；
- 静止姿势不用 `MDLE`（rea-p5-mesh 记错了偏移）；
- 不带 effect 时，UV 按 GPU 纹理尺寸缩放；
- 带 effect 时，合成 RT 按图像尺寸，不按图层 `size`；
- 变形目标按权重从大到小排；
- 没有绘制顺序轨道时不重排。

逐条见第一部分「更正读码清单」、第二部分「更正读码」。

**WPE 崩溃一次。** 生成工程里有一个 puppet 带骨骼透明度轨道，但网格没开 bit2。打开它时，WPE 往空指针写，进程退出。WPE 是用户常驻的那个，所以桌面壁纸和别的会话的测试窗口也一起断了。

之后 WPE 被重新拉起（`-silent`，PID 576736），主会话核过：已重新注入，桌面壁纸窗口在。肇事的 puppet 已经从工程定义和生成的工程里删掉。同一模式的「有绘制顺序轨道、没有 bit3」读码推断也会崩，没有跑。

实现时这两种组合不能照抄 WPE，处理办法见计划的步骤 0 实施记录。语料里没有这两种组合。

## 翻译器预检（主会话）

`ignore/p12/pre/src/precheck.test.ts`：用 HEAD 快照的翻译器 wasm，把 WPE 自带的四个 puppet 着色器按骨骼相关的组合键各译一次，结果在 `ignore/p12/out/precheck.json`（`ignore/p12/pre/show.py` 汇总）。

| 着色器 | 组合 | 结果 |
|---|---|---|
| `genericimage4` | 无；`SKINNING` + `BONECOUNT` 16 / 32 / 64 / 128；加 `SKINNING_ALPHA`、`MORPHING`、`MORPHING_NORMALS`、`MORPHING_MODIFIERS`、全开；只 `MORPHING` | 全部通过 |
| `genericimage2` | 同上 | 全部通过（没有 `MORPHING` 分支） |
| `clippingmaskimage4` | 同上 | 全部通过 |
| `puppettexturechannels` | 不给 `BLENDROWCOUNT` | 解析失败（`g_BlendMap[BLENDROWCOUNT]` 长度为 0） |
| `puppettexturechannels` | `BLENDROWCOUNT` 4，加不加 `SKINNING` | 通过 |

- `g_Bones` 翻译成普通 uniform 块里的 `array<mat4x3<f32>, N>`，每项 64 字节（WGSL 的 `mat4x3` 按 4 个 vec4 列排）。WPE 是单独的常量缓冲 b2、每项 48 字节，所以写 uniform 时要按我们自己的布局重新排，不能整块拷贝。
- `g_BonesAlpha`、`g_MorphWeights` 是 `array<vec4<f32>, N>`，`g_MorphOffsets` 是 `array<vec4<u32>, 12>`，都按 P7 的「第 1 种形态」，每个元素占一个 vec4。
- 变形纹理在槽 5（`g_Texture5`），顶点着色器采样。
- 还没在真 WebGPU 上建过管线（Node 没有 WebGPU），留到 P12a。

## 语料真值（主会话抓的）

| 场景 | 标签 / 目录 | 用途 | 看到的 |
|---|---|---|---|
| `3203778110` | `A:\p12\corpus\3203778110`（原工程，没有帧时间）、`A:\p12\3203778110-kbp-fps20-1920x1080` | 3 个 puppet 各 1 个动画层（覆盖、`blend` 0.58、0.21），HEAD 上只差 P12 | `g_Bones` 逐帧平滑变化；读码模型从第 1 帧推进时最大差 1.9e-6，从第 2 帧推进时差 5.4e-3 |
| `3811424158` | `…-kbp-fps20-1920x1080` | 有骨骼、没有动画层（另有纹理通道网格） | `g_Bones` 是单位阵（绑定姿势）。这份副本的 FR 日志是空的，原因没查 |
| `3354366708` | 同上 | 没有骨骼的静态 puppet | 没有一次绘制读 `g_Bones` |
| `3463520581` | 同上 | 挂点、加法层 | 第二部分第 2 节 |
| `2345214324` | 同上 | 骨骼物理 | 第二部分第 1 节 |
| `3351072238` | `A:\p12\corpus\3351072238` | 第一次试抓 | puppet 默认被用户属性隐藏，没画，不能用 |

两个实测代理另抓了 `3491865410`（裁切遮罩）、`3426865175`（重力、挂在 puppet 上的粒子）和 13 个生成工程，见下文。

## 复核（主会话）

- `ignore/p12/rea/runtime/posemodel.py check3203`：最大差 1.9e-6，和读码代理报的相同。
- `ignore/p12/rea/mdl/run_corpus.py`：语料 137 个 mdl 里 136 个恰好读到末尾，1 个末尾是 0 填充，和读码代理报的相同。
- `ignore/p12/meas/combo.py phys`：物理骨骼最大差 6.8e-3 px，不算物理时差 23 px，和实测代理报的相同。
- `ignore/p12/meas/case_clock.py p12-modes …`：12 种播放模式各 100 帧，最大差 2 ulp，和实测代理报的相同。
- 抓帧里直接看：
  - 1 根骨骼的 puppet，`g_bufAnimation` 是 48 字节，即 `BONECOUNT` 等于真实骨骼数，不取 2 的幂；
  - 带 effect 的 puppet，最后一次绘制用 puppet 网格采样 750×800 的合成 RT；
  - 不带 effect 的 puppet 直接采样纹理。
- 读码代理的一处结论在全量反汇编里核过：骨骼 JSON 只有 `se`/`re`（`0x3000`）与 `r`/`t`（`0x3`）同时有，才读物理参数（`0x140265f0d`–`0x140265f27`）。两者不同时成立、又没开 IK 时，到 `0x140266559` 把标志清零。

## 一、确定性用例（生成的测试工程）

### 环境与约定

- **WPE**：用户常驻的 `wallpaper64.exe`（2.8.42），设置 fps 20，没改任何设置、没调 `restart_wpe`。测试窗口一律 **1856×1044**：同期 P11 的会话占着 1920×1080（MCP 拒绝相差 8 像素以内的两个窗口），另一个 P12 代理用 1600×900。场景是正交 1920×1080，窗口尺寸只影响后备缓冲，不影响读的常量。
- **工程**：`ignore/p12/defs/p12.py`（`PROJECTS`，13 个工程）+ 编码器 `ignore/p12/defs/puppet.py`，`python -X utf8 -I .claude/skills/kbp-tools/kbp.py gen p12 --data ignore/p12` 生成到 `ignore/p12/proj/p12-*`。每个 puppet 是一个图像层：模型 JSON 写 `puppet`，材质 WPE 自带的 `genericimage4`（纹理缺省 `util/white`）。生成后把 FR 脚本的日志改成每帧写（只改生成出的 `scene.json`，同 P10）。
- **读法**：`kbp rdc consts`（每次绘制的 VS / PS 常量，含 b2 的 `g_Bones`、`g_BonesAlpha`、`g_MorphOffsets` / `g_MorphWeights`），按 `g_ModelViewProjectionMatrix` 的平移认对象；索引顺序、UV、变形后的顶点用 MCP 的 `get_mesh_data`。骨骼 0 的绑定姿势是单位阵，所以 `g_Bones[0]` 的平移就是采样出的局部平移；动画把帧号写进平移 x（T.x = 帧号），读回 T.x 就是 `lo + frac`。
- **预测**：rea-RT 的 `posemodel.py`（时钟、采样、混合、蒙皮，float32），按 `[kbp] @f64` 日志的逐帧 dt 从第 1 帧推进；物理 / 挂点用 `combo.py`。
- **日志混行**：`log.txt` 各会话共用，P11 会话的窗口同时在写 `[kbp]` 行（帧号上千）。`meas/ana.py` 的 `mylog` 只认从帧 1 起连续的那一串；`logcheck.py check` 列出了每份日志的混行（都不和本会话的帧号重叠）。
- **一次 WPE 崩溃**：第一次打开 `p12-am`（含「有骨骼透明度轨道、网格没有 bit2」的 puppet）时 WPE 进程退出（共享的 WPE，桌面壁纸与别的会话同时受影响；之后 WPE 被重新拉起，PID 576736）。原因与证据见用例 5；那个 puppet 与同类的「有绘制顺序轨道、没有 bit3」都从工程里去掉了，没有再触发。
- **回放进程**：另一个代理收尾时 `close_capture` 关过本会话打开的 `p12-fx-…-frame167.rdc`。本文用到的 `get_mesh_data` / `get_texture_data` 结果都是本会话工程的几何（能逐顶点对上编码时的坐标）；`p12-fx` 的 `fx-ev108`、`fx-ev202` 两项在重新 `open_capture` 后重读，和初读逐字节相同（`out/fx-ev108-vsin-reread.json`、`fx-ev202-vsin-reread.json`）；`p12-am` 的骨骼透明度 vs_out 是重开后读的。

### 结论速览

| # | 用例 | 结论 | 残差（WPE vs 预测） |
|---|---|---|---|
| 0 | 编码器往返 | 语料 137 个 mdl：136 个 `encode(parse(x)) == x` 逐字节相同；1 个（2345214324 `catgirl1 minimalist_puppet.mdl`，v13）只差空标签之后 925 464 个尾随 0 | — |
| 1 | 模式 | loop / mirror / single、非整数 fps（7.5、19.8、27.27）、rate 1.7 / −0.5 / 2.3 / 0.3 全部**成立**；single 到头停在第 length 帧、mirror 两端换向、负 rate 的 loop 回绕都在抓帧窗口里 | 12 个 puppet × 100 帧：≤ 2 ulp（最大 1.2e−7） |
| 2 | 淡入淡出 | `min(D/2, blendtime)` 线性、非 single 只淡入一次、淡出只在 single 有效、blendtime 0 / 缺省 **成立**；single 带淡出播完后权重恒 0 | 10 个 × 100 帧：逐位相同 |
| 3 | 多层混合 | 覆盖 / 混合 / 加法、层序、visible false 不参与、找不到 animation 的层整层丢掉、负 blend、缺轨道取来源 **成立**；缺轨道时静止分解的四元数不是单位长 → 0.7 rad 的静止骨骼带 0.031% 缩放（rea-RT 7 推断，**成立**，量级更正） | ≤ 5 ulp（`rsqrtps` 近似，模型用精确值） |
| 4 | 字段绑定生效帧 | 用户属性：从脚本第一次看到新值的那一帧起生效（帧间应用）；脚本返回值：**下一帧**生效（同一时间表的普通图层 alpha 当帧生效）；**成立** | 生效帧选对时逐位相同，错 ±1 帧差 0.36 帧位置 / 0.003–186 |
| 5 | 骨骼透明度 | bit2 → `SKINNING_ALPHA`；`g_BonesAlpha` = 透明度轨道的 lerp（`(1−f)·a + b·f`），混合 `lerp(1, v, w)`、加法 `clamp(1 + (v−1)·w, …)`、每帧先置 1，`v_VertexAlpha` = `g_BonesAlpha[骨骼]`；**有轨道没有 bit2 时 WPE 写空指针崩溃**（新发现） | 逐位相同 |
| 6 | 变形 | 纹理打包（纹素 0 = (0,0,0,32767)，目标 t 第 v 个变形顶点在 `1 + t·nv + v`）、`a_PositionVec4.w` 从 1 起、`g_MorphWeights[0]` = 缩放、`g_MorphOffsets[1+k]` = 目标 × nv **成立**；生效目标**按权重从大到小**排（新）；混合层 `lerp(0, v, w)`；没有 bit12 时纹理全 0：不位移，但变形顶点的 alpha 每个生效目标乘 `(1 − w)`（新） | 逐位相同；变形后顶点和手算一致 |
| 7 | 绘制组 | bit3 + 绘制顺序轨道：一次绘制、动态索引缓冲按键**升序**重写，键 = trunc(基数 + 轨道) + 组偏移；**没有轨道时保持文件顺序**（基数、组偏移都不起作用，新）；键相同时不按组表顺序 | 索引序列与预期逐个相同 |
| 8 | effect 与 UV | 带 effect：基础 pass 画图像尺寸的四边形进合成 RT（RT = **图像尺寸**，不是图层 `size`），effect 在平面上做，最后 puppet 网格（UV 不缩放）采样合成 RT、蒙皮上屏 **成立**；不带 effect 的 UV 乘「图像宽 / **GPU 纹理宽**」**成立**（DXT 192×256 / 130×230 → 0.6771、0.8984；FreeImage 纹理按图像尺寸上传，比例 1）；静态 puppet 也缩放、没有 `g_Bones` | UV 逐值相同 |
| 9 | 脚本 | `getAnimationLayer`（下标 / 名字取最后一个 / 查不到、非整数、非 puppet、静态 puppet → `null`）、`getAnimationLayerCount`、全部成员、`play` / `pause` / `stop` / `setFrame` 下一帧生效、`setFrame` 抑制当次播完回调、`addEndedCallback`（loop 每次回绕、mirror 每次换向、single 一次，可多个）、MDLA 事件 → `animationEvent`（事件 JSON 的全部字段）**成立**；动画层字段脚本里 `thisObject` 是 `IAnimationLayer`、`thisLayer` 是图像层（新） | 100 帧里 g_Bones 与脚本的 getFrame 只在动作帧不等，下一帧全部相等 |
| 10 | 物理 | `re` 被甩开后**不回弹**、`se` 有弹簧、只有 `r` 不开物理、`t + se` 平移弹簧与 `tm` 钳制、重力 **成立** | 组合模型 ≤ 3.6e−4 px、转角 ≤ 3.8e−6 rad（多数逐位相同） |
| 11 | 挂点 | `W_子 = W_父 · Pose[骨骼] · Att · T·R·S`（本帧姿势）、子在父前时挂点丢失、名字查不到按普通父子、重名取第一个、粒子子对象跟挂点 **成立** | 图像 ≤ 6.8e−5 px；粒子中心与预测一致到 0.01 px |

---

### 0. 编码器与往返核对

- **编码器**：`ignore/p12/defs/puppet.py` 的 `encode(结构) -> bytes`，结构就是 `mdl12.parse` 的输出（照 rea-MDL 第 1–8 节：网格、可选块 1 / 2、v23 记录表、`MDLS` v1–v4、`MDLA` v1–v6、`MDAT`、`MDMP`、`MDLE`），段末偏移现算。`build(...)` 用它造测试 mdl（v23、`MDLS0004`、`MDLA0006`，可选 `MDAT` / `MDMP` / 绘制组 / 每骨骼绘制顺序），造完再用 `mdl12.parse` 读一遍、没有 issue 才写。
- **往返**：`ignore/p12/meas/roundtrip.py`（结果 `meas/roundtrip.txt`）：语料 137 个文件（`ignore/p12/rea/mdl/corpus/`）里 **136 个逐字节相同**。唯一不同的是 2345214324 的 v13 文件：编码结果（123 112 字节）等于原文件前缀，原文件在空标签之后另有 925 464 个 0（rea-MDL 第 10 节：WPE 读到空标签即停），编码器不补尾巴。
- 顺带：`MDLA` 里三处「读了不用」的 u32（v≥3 的 n3 条轨道、骨骼透明度、绘制顺序轨道前各一个）在语料里全是 0（编码器写 0 也逐字节相同）。语料段序：`MDAT` 在 `MDLA` 之前、`MDMP` / `MDLE` 在之后（`meas/secorder.py`），编码器按结构里的顺序写。

### 1. 模式（`p12-modes`，抓帧 186–285，t ≈ 9.3–14.4 s）

- **设置**：12 个单骨骼 puppet，帧值 `T = (f, 0, 0)`、`rz = 0.02·f`。loop10（fps 10、len 20）、mirror10、single95（D 9.5 s）、single105、single1（D 1 s，早已结束）、loop75（fps 7.5）、loop198（fps 19.8、len 33）、mirror2727（fps 27.27、len 50）、loopr17（rate 1.7）、loopneg（rate −0.5）、mirr23（rate 2.3）、single_r03（len 40、rate 0.3，t ≈ 13.33 s 到头）。
- **数据**：`A:\p12\p12-modes-fps20-1856x1044`，`out/wpe-p12-modes-fps20-1856x1044-consts.json`，结果 `out/case-p12-modes.txt`（`meas/case_clock.py p12-modes p12-modes-fps20-1856x1044 [--rows 名字]`）。
- **残差**：全部 1200 个数里逐位相同 968–1200 个，最大 2 ulp（single_r03 1.2e−7，single1 旋转部分 2.98e−8）。consts 的 dt 与日志逐帧相等。
- **看到的事件**：single_r03 在帧 229–231 之间到头，之后 `T.x` 恒 40.000000（`lo = len−1`、`hi = len`、`frac` 让结果落在第 length 帧）；single95 / single1 整窗停在末帧；loop / mirror 在窗口里各回绕 / 换向 2–5 次；负 rate 的 loop 每帧 `t` 减小、回绕时 `fmodf(t + D, D)`。
- **结论**：rea-RT 第 3、4 节（时钟、模式在 MDLA、帧号 `t / spf`、回绕处不插值）**成立**，补上了 rea-RT「没查清」7 里 mirror / single 没有实测的缺口。

### 2. 淡入淡出（`p12-fade`，抓帧 173–272，t ≈ 8.67–18.5 s）

- **设置**：帧值 `T = (f, 100, 0)`，静止 T.y = 0，所以读回 `T.y / 100` 就是权重 w。
- **数据**：`A:\p12\p12-fade-fps20-1856x1044`，`out/case-p12-fade.txt`（g_Bones 残差）、`out/case-p12-fade-w.txt`（每个 puppet 的 t 与 w，`meas/fade_rows.py`）。
- **残差**：10 个 puppet × 100 帧逐位相同。
- **读回的权重**：

| puppet | 设置 | 窗口里的 w | 说明 |
|---|---|---|---|
| sgl_inout | single D 20，in + out，bt 15 | t 8.67 → 0.867 … t 18.50 → 0.150 | 时长 `min(D/2, bt)` = 10 s，前段 t/10、后段 (D−t)/10 |
| loop_in | loop D 2，in，bt 0.5 | 恒 1（含回绕后 t = 0.0034 的帧） | 非 single 第一次到 1 后清掉 blendin |
| loop_out | loop D 2，out，bt 0.5 | 恒 1（含 t = 1.964 的帧） | blendout 只在 single 有效 |
| mir_in | mirror D 2，in | 恒 1 | 同 loop_in |
| loop_in_long | loop D 30，in，bt 20 | t/15：0.578 → 1 | `min(D/2, bt)` = 15 |
| sgl_out | single D 9.5，out，bt 1 | 0.826 → 0（t = 9.5 后恒 0） | **播完的 single + blendout 层权重恒 0**，对姿势没有贡献 |
| sgl_in_b06 | single D 20，in，bt 15，blend 0.6 | 0.6·t/10 | 淡入乘 blend |
| loop_in_bt0 | loop，in，bt 0 | 恒 1 | `min(D, bt) ≤ ε` 时淡入 = 1 |
| sgl_inout_def | single D 20，in + out，bt 缺省 | 恒 1 | 缺省 0.5 |
| sgl_out_bt20 | single D 12，out，bt 20 | (12 − t)/6 | |

- **结论**：rea-RT 5.1 **成立**（含「非 single 只淡一次」「淡出只在 single」）。

### 3. 多层混合（`p12-mix`，抓帧 170–229）

- **设置**：动画 A（loop 4 s，T.x = f、rz = 0.02f）、B（loop 3 s，T = (0, 50 + 0.5f)、rz 0.5）、C（离谱值）。puppet：A 覆盖 + B 加法 0.5、A 覆盖 + B 混合 0.5、A + C（visible false）、只有 C（false）、只有 B 加法 0.7、A 0.4 + B 0.6、B 加法在前 + A 覆盖在后、A blend −0.5、两层加法；2 骨的缺轨道（层 m1 缺骨骼 1、层 m0 缺骨骼 0；骨骼 1 静止局部带 0.7 rad 旋转）、只有缺骨骼 1 的覆盖层、没有层、animation 指向不存在的 id。
- **数据**：`A:\p12\p12-mix-fps20-1856x1044`，`out/case-p12-mix.txt`，`out/case-p12-mix-missrest.txt`（`meas/miss_rest.py`）。
- **残差**：混合 / 加法类 ≤ 5 ulp（ovr_mix、mix_two 最大 2.98e−7），其余逐位相同。差都来自 `rsqrtps`（模型用精确倒数平方根，rea-RT 7 已说明）。
- **缺轨道的缩放**：miss_rest 的 `g_Bones[1]` 列长 `|c0| = 0.9996891`（不是 1），nolayer_rot（没有层，不经分解）是 1.0000000；模型逐位复现。rea-RT 7 推断「约 0.2%」，0.7 rad 实测是 **0.031%**（量级随静止角度变）。
- **结论**：rea-RT 第 5 节三种叠法、层序、visible、`FUN_1401fcc20` 找不到 animation 时整层丢掉（badanim 与没有层逐位相同）**成立**。

### 4. 字段绑定的生效时机（`p12-bind`）

- **设置**：b_rate / b_blend / b_vis 的 `rate` / `blend` / `visible` 绑用户属性 `prate` / `pblend` / `pvis`；s_rate / s_blend / s_vis 挂脚本（按 `engine.runtime` 每 0.7 / 0.45 / 0.6 s 切换，返回值变化的那一帧记一行）；参照：普通图层 `alpha` 绑 `pblend`（ref_ublend）、普通图层 `alpha` 挂同一时间表的脚本（ref_salpha）；mark 每帧记脚本看到的 `engine.userProperties`。动画 loop 60 s、T.x = 帧号（rate 的变化会累积进 T.x，可以反推生效帧）。
- **流程**：`open_wallpaper` → 抓 30 帧（`p12-bind-a`，帧 95–124）→ `apply_properties {prate 0.25, pblend 0.4, pvis false}` → 抓 30 帧（`-b`，274–303）→ `apply_properties {prate 1, pblend 1, pvis true}` → 抓 30 帧（`-c`，440–469）→ 关窗。日志从开窗前的字节偏移截出（`meas/logcheck.py cut 2369906`）→ `out/p12-bind-raw-log.txt`。
- **数据**：`A:\p12\p12-bind-{a,b,c}`，`out/wpe-p12-bind-{a,b,c}-consts.json`，结果 `out/case-p12-bind.txt`（`meas/case_bind.py`）。
- **做法**：K = 脚本第一次看到新用户属性的帧（192、421）/ 脚本返回新值的帧；模型分别假设新值从 K−1、K、K+1、K+2 帧的 puppet 更新起生效，看哪个和 90 帧的 `g_Bones` 逐位对上。

| 绑定 | K−1 | **K** | **K+1** | K+2 |
|---|---|---|---|---|
| 用户属性 rate | 差 0.365 | **逐位相同** | 差 0.368 | 差 0.714 |
| 用户属性 visible | 差 3.0e−3 | **逐位相同** | 差 1.1e−2 | 差 6.1e−2 |
| 用户属性 blend | 都相同（抓帧没覆盖到切换那一帧，分不开） | | | |
| 脚本 rate | 差 1.48 | 差 0.95 | **逐位相同** | 差 0.86 |
| 脚本 blend | 差 186 | 差 186 | **逐位相同** | 差 184 |
| 脚本 visible | 差 134 | 差 134 | **逐位相同** | 差 135 |

- 参照：ref_salpha 的 `g_Alpha` 在脚本返回新值的**同一帧**变（帧 98、102、106 …，和 sblend 的返回帧逐个相同），而 s_blend 的 puppet 晚一帧。
- **结论**：rea-RT 1.5「描述符没有改值回调，下一次每帧更新才读到」**成立**，细化为：用户属性在帧之间应用，puppet 与脚本在同一帧看到新值；脚本写回比普通图层属性晚一帧。

### 5. 骨骼透明度（`p12-am` 前半，抓帧 173–212）

- **设置**：2 根骨骼（都是根）、两个四边形各绑一根；网格标志 bit2；MDLA v6 的骨骼透明度轨道 b0 = f/20、b1 = 1 − f/20（loop fps 10、len 20）。alpha（覆盖）、alpha_b05（混合 0.5）、alpha_add05（加法 0.5）、alpha_notrack（bit2、动画没有透明度轨道）、alpha_nolayer（bit2、没有层）。
- **数据**：`A:\p12\p12-am-fps20-1856x1044`，结果 `out/case-p12-am.txt`（`meas/case_am.py`）。
- **残差**：40 帧 × 2 个值，三种叠法都逐位相同。公式：标量插值是 `FUN_140178e00` = `(1 − f)·a + b·f`；覆盖 `lerp(lo, hi, frac)`；混合 `lerp(1, v, w)`；加法 `clamp(1 + (v − 1)·w, min(1, v), max(1, v))`（cur 每帧先置 1）。notrack / nolayer 恒 1。`g_BonesAlpha` 在 VS 常量里（packed，前 2 个有效）；`v_VertexAlpha`（vs_out TEXCOORD1）就是 `g_BonesAlpha[骨骼]`（帧 173：0.351261 / 0.648739）。
- **崩溃（新）**：第一次 `p12-am` 里另有 alpha_nobit（**有透明度轨道、网格没有 bit2**），打开它时 WPE 进程退出（`capture_sweep` 报窗口已不在，`status` 里 WPE 进程没了，`log.txt` 在开窗前就停了）。去掉这个 puppet、其余不变（含没有 bit12 的变形）之后正常 → 排除法认定是它。读码佐证：`0x1401fe22a`–`0x1401fe248` 只有 bit2 时才 `resize(P+0x268, 骨骼数)`，否则清空；轨道写入 `0x1401ff24c` → `FUN_1400e4aa0`（`mov rax, [rcx]; lea rax, [rax + 4*rdx]`，不判空、不判界）→ 写空指针。绘制顺序同一模式：`0x1401feb15`–`0x1401feb36` 只有 bit3 时才分配 `P+0x280`，所以「有绘制顺序轨道、没有 bit3」推断也会崩溃（**没跑**，避免再弄崩共享的 WPE）。

### 6. 变形（`p12-am` 后半）

- **设置**：一个 60×60 四边形，格式 `0x181000e`（`a_PositionVec4`），顶点 0、1 变形（w = 1、2），2、3 不变形（w = 0）；MDMP 3 个目标、nv 2、缩放 40；目标 0：((30,0), (0,30))、alpha (0.5, 1)；目标 1：((−20,−20), (10,0))；目标 2：((0,−25), (−25,0))、alpha (0.25, 0.75)。MDLA v6 每目标权重：t0 = f/20、t1 = 0、t2 = 0.5。puppet：morph（bit12）、morph_nobit12（标志 0）、morph_b05（层 blend 0.5）、morph_nolayer。
- **数据**：同上；变形纹理 `out/case-p12-am-morphtex.txt`（`get_texture_data` 解码，`meas/b64tex.py`），vs_out 见下。
- **纹理**（3×3，`R16G16B16A16_SNORM`，VS 槽 0、点采样）：纹素 0 = (0, 0, 0, 32767)；纹素 1、2 = 目标 0 的顶点 0、1（(24575, 0, 0, 16384)、(0, 24575, 0, 32767)）；3、4 = 目标 1；5、6 = 目标 2；7、8 = 0。即「目标 t 第 v 个变形顶点在 `1 + t·nv + v`」，xyz = 位置差（snorm），w = alpha。**成立**。
- **uniform**（帧 173，lo 7、frac 0.025）：`g_MorphOffsets = [2, 4, 0, …]`、`g_MorphWeights = [40, 0.5, 0.351261, …]`：生效数 2（t1 权重 0 不生效）、`[0]` = 缩放、`[1+k]` = 目标 × nv。**顺序是按权重从大到小**：t0 的权重超过 0.5 的帧（177–187）变成 `[2, 0, 4]` / `[40, 0.547, 0.5]`。照「先按目标号收集生效目标（最多 11 个，`0x14020d0a0`–`0x14020d230`，满 11 就停），再 `FUN_140215600` 按权重排序」写预测，40 帧逐位相同（只测了正权重；比较用不用绝对值、并列时的顺序没测）。
- **混合层**：morph_b05 的权重是 `lerp(0, v, 0.5)`（0.25、0.175631）：cur 从 0 开始，不是 1。
- **顶点**（帧 173 vs_out，`get_mesh_data`）：morph 的顶点 0 = (−30, 30) + 40·(0.75·0.351261, −0.625·0.5) = (−19.462, 17.5)，NDC (−0.853607, 0.439815)，实测 (−0.8536065, 0.4398152)；顶点 1 同样对上；`v_VertexAlpha` 顶点 0 = (0.5·0.351 + 0.649)·(0.25·0.5 + 0.5) = 0.515237，实测 0.5152373。
- **没有 bit12**（新）：morph_nobit12 的 uniform 与 morph 相同、`MORPHING` 照样编，纹理只写了纹素 0（其余全 0）→ 顶点不位移，但 `v_VertexAlpha` 顶点 0、1 = `(1 − 0.351)·(1 − 0.5)` = 0.3243694（实测 0.3243694）：**每个生效目标都把变形顶点的 alpha 乘 (1 − w)**，是个看得见的副作用。rea-MDL 6.3「只有 bit12 时才写目标数据」**成立**。
- morph_nolayer：`g_MorphOffsets[0] = 0`、`[1]` 残留 4（上一个 puppet 的值，没被清；生效数 0 时不读）。

### 7. 绘制组与绘制顺序（`p12-order` 抓帧 170–229、`p12-order2` 抓帧 122–125）

- **设置**：2 根骨骼、两个四边形 A（骨骼 0、左、索引 0–5）与 B（骨骼 1、右、索引 6–11），可选块 2 两组 `{骨骼, 偏移, 起点, 数}`；MDLS v4 带每骨骼绘制顺序基数。
- **数据**：`get_mesh_data(vs_in)` 的索引序列：`out/order-rdc185-ev50-vsin.json`、`order-rdc186-ev{52,71,90,109}-vsin.json`、`order2-ev{50,69,88,107}-vsin.json`，摘要 `out/case-p12-order2-vsin.txt`；层时钟 `meas/order_clock.py`。

| puppet | 设置 | 实测（先画的组） | 说明 |
|---|---|---|---|
| ord_anim | bit3，基数 0/0，轨道 b0 前半 0 后半 200、b1 100 | 前半 A（帧 186，lo 19）；后半 B（帧 187，lo 20） | 升序；轨道**不插值**（lo 19、frac 0.41 时仍是前半）；只在顺序变化的帧多两个 API 事件（帧 187、211，事件号整体后移 2），即只在变化时重写索引缓冲 |
| ord_static_rev | bit3，基数 100/0，**没有轨道** | A（文件顺序） | 基数不起作用 |
| ord_offset | bit3，基数 0，组偏移 +50/−50，没有轨道 | A（文件顺序） | 组偏移不起作用 |
| ord_nobit3 | 没有 bit3，基数 100/0 | A（文件顺序） | |
| off_track | bit3，组偏移 −60/0，轨道 100/50（常量） | A | 键 40 < 50：**组偏移计入**（不计入时 B 在前） |
| base_track | bit3，基数 100/0，轨道 0/50（常量） | **B**（索引 6–11 在前） | 基数计入；常量轨道也从第一帧起重排（证明重排会发生） |
| tie_trunc | 轨道 50.9/50.2 | A | trunc 后键相同 |
| frac_order | 同上，但组表里 B 组在前 | **A** | 键相同时**不按组表顺序**；次序是骨骼号还是索引起点没分开（两者都是 A 小） |

- 每个 puppet 一帧只画一次（`DrawIndexed` 12 个索引）。
- **结论**：rea-MDL 7.2 / rea-RT 6.4 的「键 = trunc(基数 + 轨道) 按升序重写索引」**成立**，补：组偏移计入；**没有绘制顺序轨道的动画层写入时不重排**（加载时按基数排出的节点不会写进 GPU 索引缓冲）。

### 8. effect、UV 与静态 puppet（`p12-fx` 抓帧 168–177、`p12-fx2` 抓帧 121–124）

- **设置**：8 顶点的 puppet 网格（两个四边形，UV 0..0.5 / 0.5..1）、1 根转动的骨骼；项目 effect `kbinv`（反色）。`p12-fx` 用 3203778110 的 `18手.tex`（头里纹理 1024²、图像 750×800、FreeImage）；`p12-fx2` 用 3811424158 的 `zuoerhuan.tex`（DXT5，纹理 192×256、图像 130×230，`meas/texscan.py` 挑的）。图层 `size` 一律 200×100。
- **数据**：`out/case-p12-fx-vsin.txt`、`out/case-p12-fx2-vsin.txt`（`get_mesh_data(vs_in)` 的 UV 与位置）、`dump_draws.py` 列的常量。

| puppet | 绘制 | UV / 几何 |
|---|---|---|
| dxt（不带 effect） | 1 次，puppet 网格 + `g_Bones` | UV 乘 (0.6771, 0.8984) = (130/192, 230/256) |
| dxt_auto（autosize true） | 同上 | 同上 |
| dxt_static（没有 MDLS、格式 0xf） | 1 次，puppet 网格，**没有** `g_Bones` | 同样缩放 |
| dxt_fx / dxt_static_fx（带 effect） | 3 次：基础 pass → effect → 上屏 | 基础 pass 是普通图像四边形（6 索引，位置 0..130 × 0..230、UV 0..0.677/0.898），画进 **130×230** 的合成 RT（viewport 130×230，不是图层 `size` 200×100）；上屏是 puppet 网格（12 索引）、UV **不缩放**（0..1）、PS 槽 0 = 合成 RT、线性采样、VS 读 `g_Bones`（静态的不读） |
| np2 / np2_auto / static_np2（FreeImage） | | UV 不变：GPU 纹理是 750×800（按图像尺寸上传），比例 1 |
| fx_white（util/white，32²） | 3 次 | 基础 pass 四边形 0..32 |

- **结论**：rea-MDL 9.2、9.4 **成立**，更正两处：比例里的「纹理宽 / 高」是 **GPU 纹理（mip 0）的宽高**，FreeImage 纹理（PNG / JPG）按图像尺寸上传，等于不缩放；带 effect 的合成 RT 按**图像尺寸**（实测 130×230，`size` 200×100 不起作用）。

### 9. 脚本（`p12-script`，抓帧 152–251，t ≈ 7.7–13.1 s；日志 `out/p12-script-fps20-1856x1044-log.txt`）

- **设置**：一个 4 骨骼 puppet（`main`），4 层各只驱动一根骨骼（其余轨道缺失）：walk（loop 2 s）、dup（single 1.5 s）、dup（mirror 2 s，同名）、ev（loop 2 s，MDLA 事件：1.0 s `{"frame":10,"name":"ev1"}`、1.55 s `{"frame":15.5,"name":"ev2","extra":"x"}`）。ev 层的 `blend` 挂字段脚本；图层 `color` 挂主脚本（init 里查找与成员、按 `engine.runtime` 的时间表调方法、每帧记各层 `getFrame:isPlaying`、`animationEvent`）；另有一个普通图层与一个静态 puppet 调 `getAnimationLayer`。
- **数据**：`A:\p12\p12-script-fps20-1856x1044`，`out/case-p12-script.txt`（`meas/case_script.py`：同帧 g_Bones 的 T.x 与脚本 getFrame 比）。
- **查找**（init）：

| 调用 | 结果 |
|---|---|
| `getAnimationLayerCount()` | 4（非 puppet 图层、**静态 puppet** 都是 0） |
| `getAnimationLayer(0…3)` | 4 层；`(4)`、`(−1)`、**`(1.5)`**、**`("1")`**、`("nosuch")`、`("")`、`("WALK")` → `null` |
| `("dup")` | 第 2 层（最后一个匹配） |
| 同一性 | `get(0) === get(0)`、`get(0) === get("walk")` 都是 true |
| 非 puppet / 静态 puppet 上 `getAnimationLayer('x').play()` | `TypeError: Cannot read properties of null (reading 'play')` |

- **成员**：for-in 可枚举 `duration、frameCount、fps、blend、name、blendout、blendin、rate、additive、visible、blendtime、addEndedCallback、play、isPlaying、stop、pause、setFrame、getFrame、getAnimation`（多一个 `getAnimation`，没有 `id`）；walk 的 `fps` 10、`frameCount` 20（= MDLA length）、`duration` 2；写 `fps` 抛 `TypeError: Cannot assign to read only property 'fps'`，值不变。
- **方法的生效帧**：动作帧上 `g_Bones` 是动作之前的值，下一帧才反映（pause、play、stop、setFrame(5)、rate = 2、blend = 0.5、visible = false / true、dup1 播完后 play() 从 0 重来）；100 帧里只有动作帧与 walk 被隐藏 / 半混合的帧不等，全部符合「脚本动作下一帧生效」。隐藏期间 walk 的 getFrame 停在 3.3145，重新可见后从 3.3145 接着走、不再淡入。
- **播完回调**：walk（loop）每 2 s 一次、dup2（mirror）每次换向（到 D、到 0）、dup1（single）只一次（frame 15、isPlaying false），play() 重来后再播完又一次；一个层加两个回调两个都调；回调参数个数 0、`this` 为 undefined（严格模式）。帧 196 `setFrame(19.9)` 之后下一帧回绕，**那次没有回调**，下一次回调在 2 s 后的 14.749 s。
- **事件**：`animationEvent(event, value)` 在层时钟越过 1.0 s / 1.55 s 的帧触发，每轮一次；`event` 的字段就是事件 JSON 的全部字段（`frame=10|name=ev1`、`frame=15.5|name=ev2|extra=x`）；`value` 是接收脚本自己属性的值（`1 1 1`）；`thisObject` 是图像层。挂在**动画层字段**上的脚本也收到。同一帧里事件与播完回调都在 `update` 之前。
- **动画层字段脚本里的 `thisObject`**（新）：是那个 `IAnimationLayer`（`name` = 层名、有 `getFrame`、没有 `getAnimationLayer`），`thisObject !== thisLayer`，`thisLayer` 是 puppet 图像层。
- **结论**：rea-AP 4.2–4.4、rea-RT 3.3–3.4 **成立**；补：非整数下标与数字字符串返回 `null`、静态 puppet 计数 0、只读属性赋值抛错、回调无参数。

### 10. 物理（`p12-phys` 抓帧 153–252、`p12-phys2` 抓帧 142–241）

- **设置**：两骨骼 puppet，根骨骼动画 4 s 一轮：0–0.5 s 移动后保持、回绕时跳回；子骨骼 tail（局部 (100, 0)）带物理 JSON。`p12-phys`：根骨骼沿 x（顺着子骨骼）移动——re / se / ronly 的转动物理**没被激起**（尖端落后方向和骨骼同向，`rotTo` 是单位），只有 tse（`t + se`，ts 300、tf 5、ti 30、tm 200）与 re_ge（重力）有动作；`p12-phys2` 改成沿 y（垂直）移动或根骨骼转 0.6 rad。
- **数据**：`A:\p12\p12-phys{,2}-fps20-1856x1044`，`out/case-p12-phys.txt`、`out/case-p12-phys2.txt`（`meas/case_phys.py <工程> <标签>`，逐帧列骨骼 1 的物理转角 = 骨骼 1 转角 − 骨骼 0 转角，以及组合模型的残差）。
- **残差**（组合模型 `combo.PhysPuppet`，按日志 dt 从第 1 帧跑）：re、se、ronly、tse、se_y、ronly_y 逐位相同；re_ge 1.5e−5 px / 1.2e−7 rad；re_y 4.6e−5 px / 5.3e−7 rad；re_rot 1.1e−4 px / 1.3e−6 rad；se_rot 3.6e−4 px / 3.8e−6 rad。
- **现象**：
  - **re_y**：回绕跳变后（帧 158）甩到 1.01 rad，之后停在 **0.91736 rad 不回来**（帧 176–241 不变），上一轮留下的 0.48866 rad 也是一直保持到下一次跳变；re_rot 停在 1.25155。→ **`re` 没有回弹，成立**。
  - **se_y**：甩到 0.54 rad，0.6 s 内摆回 0（−0.116 过冲后收敛到 1e−5 以内）；se_rot（rs 50、rf 3）振荡衰减。→ **`se` 有弹簧，成立**。
  - **ronly / ronly_y**：转角恒 0（只有 `r`，物理不开）。
  - **tse**：平移偏移随跳变来回，`|off|` 钳在 `s·tm = 200`（尖端落在 −50）。
- 数据留给 P12d：两组 100 帧的 `g_Bones`（两骨骼）与逐帧 dt 都在上述文件里。

### 11. 挂点（`p12-att`，抓帧 151–190）

- **设置**：父 puppet（origin (700, 500)）：骨骼 0 平移 2f、骨骼 1（局部 (80, 0)）转 0.05f rad；MDAT：tipA@骨骼 1 = T(40, 10)、tipB@骨骼 0 = T(0, −30)·Rz(0.3)、第二个 tipA@骨骼 1 = T(−999, −999)（重名）。子：c_before（在 `objects` 里排在父**前面**，挂 tipA）、c_img（tipA，origin (5, 7)、angles z 0.2）、c_img2（tipB，scale (2, 1)）、c_missing（`nosuch`）、c_part（粒子，tipB，origin (3, 4)）。
- **数据**：`A:\p12\p12-att-fps20-1856x1044`，`out/case-p12-att.txt`（`meas/case_att.py`：投影 P 由父自己的 MVP 反推，预测 `P · W_子`）。

| 子 | 预测 | 40 帧最大差 |
|---|---|---|
| c_img | `W_父 · Pose[1] · Att(tipA 第一个) · L` | 平移 6.8e−5 px、线性 8.7e−7 |
| c_img2 | `W_父 · Pose[0] · Att(tipB) · L` | 6.2e−5 px |
| c_missing | `W_父 · L` | 3.8e−5 px |
| c_before | `W_父 · L`（挂点丢失） | 3.8e−5 px；当作挂上的反例差 126 px |
| c_img 反例 | 用上一帧的 Pose | 差 16.6 px |
| c_part（粒子，帧 151 一个粒子的四角中心，gs_out） | `W_父 · Pose[0] · Att(tipB) · T(3, 4)` = (773.882, 474.708) | 实测 (773.88, 474.71) |

- **结论**：rea-AP 1.1–1.4 **成立**（本帧姿势、子在父前挂点丢失、重名取第一个、查不到按普通父子、粒子跟挂点）。

---

### 更正读码清单

**rea-p12-mdl.md**
1. **第 8 节 bit2 / 8.1、rea-RT 6.4 的透明度行**：补「骨骼透明度轨道 + 网格没有 bit2 → `P+0x268` 为空、`FUN_1400e4aa0` 写空指针，WPE 进程崩溃」（实测 + `0x1401fe22a`、`0x1401ff24c`）。实现时这种组合要退回或忽略轨道，不能照抄。同理 bit3 / 绘制顺序轨道（`0x1401feb15`，静态推断，没跑）。
2. **第 9.2 节 / 11.3**：`uScale = 图像宽 / 纹理宽` 的「纹理宽」是 **GPU 纹理（mip 0）的宽**：DXT 纹理 192×256 / 图像 130×230 → (0.6771, 0.8984)；FreeImage 纹理按图像尺寸上传（RenderDoc 里 750×800），比例 1。静态 puppet 也缩放，`autosize` 不影响。
3. **第 9.2 / 9.4 节**：带 effect 的 puppet，合成 RT 是**图像尺寸**（130×230），不是图层 `size`；基础 pass 是普通图像四边形（UV 照样乘比例）。「合成 RT 的尺寸照旧按 size / 图像尺寸」的推断改成「按图像尺寸」（只测了 puppet）。
4. **第 6.3 节**：`g_MorphOffsets[1+k]` / `g_MorphWeights[1+k]` 的顺序是**按权重从大到小**（先按目标号收集、最多 11 个，再 `FUN_140215600` 排序），不是目标号顺序。补「没有 bit12 时纹理全 0：不位移，但每个生效目标把变形顶点的 `v_VertexAlpha` 乘 (1 − w)」。
5. **第 7.2 节**：排序键 = trunc(基数 + 轨道值) + 组偏移，升序；**只有绘制顺序轨道写入时才重写 GPU 索引缓冲**（没有轨道时，基数与组偏移都不起作用、保持文件顺序）；键相同时不按组表顺序（A 在前，骨骼号或索引起点）。只在顺序变化的帧重写。
6. **第 12 节「没查清」**：「MDLA v≥6 的绘制顺序轨道怎样和 mdl+0x1e8 合成排序键」由上一条回答；「静态 puppet 的格式 0xf」：genericimage4 能编、能画（UV 也缩放）。

**rea-p12-runtime.md**
7. **第 6.4 节**：变形权重的 cur 初值是 **0**（混合层 `lerp(0, v, w)`，实测 0.25 / 0.1756）；骨骼透明度的 cur 初值 1（表里已写）。标量插值 `FUN_140178e00` = `(1 − f)·a + b·f`。绘制顺序轨道「不插值，取 lo 帧」实测成立（lo 19、frac 0.41 仍按前半）。
8. **第 7 节**：「带旋转的静止骨骼在覆盖层缺轨道时约 0.2% 的缩放」：现象成立、量级随角度变，0.7 rad 实测 0.031%（`|c0| = 0.9996891`），模型逐位复现。
9. **第 1.5 节 / 第 2 节「帧内时序」**：用户属性的新值在帧之间应用，puppet 更新与脚本在**同一帧**读到（实测 K + 0）；脚本 `update` 返回的新值**下一帧**才进 puppet（K + 1），而同一时间表挂在普通图层 `alpha` 上的脚本当帧生效。
10. **「没查清」7**：mirror / single、淡入淡出、绑定字段的生效帧都已实测，全部和读码一致（见用例 1、2、4）。

**rea-p12-attach-physics.md**
11. **第 4.2 节**：`getAnimationLayer(1.5)`（非整数）和 `getAnimationLayer("1")`（数字字符串按名字找）都返回 `null`；静态 puppet（没有 MDLS）上计数 0、查找 `null`。
12. **第 4.3 节 / 「没查清」9**：只读属性（`fps`）赋值**抛 TypeError**，不是静默忽略；`IAnimationLayer` 另有可枚举的 `getAnimation`；`addEndedCallback` 的回调**不带参数**、`this` 为 undefined。
13. **第 4.4 节**：`animationEvent` 的 `event` 是事件 JSON 的全部字段（含 `name`、`frame` 之外的键）；动画层字段上的脚本也收到；`thisObject` 在动画层字段脚本里是 `IAnimationLayer`、在图层属性脚本里是图像层。
14. **「没查清」11**：`re` 没有回弹——实测成立（用例 10）。

### 没测的 / 没测成的

- **用户属性绑 `blend` 的生效帧**：抓帧没覆盖到切换那一帧（rate、visible 的同一机制已逐位定到 K + 0）。
- **「有绘制顺序轨道、没有 bit3」**：读码推断同样写空指针崩溃，为了不再弄崩共享的 WPE 没跑。
- **变形**：负权重的排序（按值还是绝对值）、权重相等时的顺序、超过 11 个生效目标、`MORPHING_MODIFIERS`（bit13）、法线 / 切线差（bit10 / 11）。
- **绘制组**：键相同时的次序是骨骼号还是索引起点；v23 记录表 / 裁切遮罩（另一个代理在 `phys-attach.md` 第 3 节测了）。
- **对象不可见时动画照常推进**（rea-RT 第 2 节）、**壁纸暂停**：没测（本轮只测了层的 `visible`）。
- **`autosort` / `index`**、`createAnimationLayer` / `playSingleAnimation` / `destroyAnimationLayer`、骨骼 / 混合形状 / 挂点的脚本 API、`resetBonePhysicsSimulation` / `applyBonePhysicsImpulse`：语料 0 处，没测。
- **物理**：`la` / `lt` / 轴锁的实测（语料里的 `la` 由另一个代理在 3426865175 上核过）、不同 fps 下的积分比例（WPE 设置 fps 20，没改设置）、首帧不算物理与「第 2 帧也不算」的区分。
- **挂点**：粒子只核了一帧一个粒子的位置；子在父前时「用上一帧姿势」的情形（挂点本身已丢失，测不到）。
- **`perspective: true` 的 puppet**、带 `alignment` 的 puppet、纹理通道（bit1）、精灵表纹理：没测。

### 文件

- 定义与编码：`ignore/p12/defs/p12.py`（13 个工程：p12-modes、-fade、-mix、-bind、-am、-order、-fx、-script、-phys、-att、-phys2、-fx2、-order2）、`ignore/p12/defs/puppet.py`。
- 工程：`ignore/p12/proj/p12-*`（WPE 写的 `shaders/blobsSM40` 已用 `cleanup_project` 清掉）。
- 抓帧：`A:\p12\p12-<工程>-fps20-1856x1044\`、`A:\p12\p12-bind-{a,b,c}\`（`A:\p12\p12-modes-probe\` 是第一次探测）。
- 提取：`ignore/p12/out/wpe-<标签>-consts.json`、`<标签>-log.txt`（`[kbp]` 日志；bind 的是 `p12-bind-raw-log.txt`）、`case-*.txt`（各用例的结果）、`*-vsin.json`（`get_mesh_data` 输出）。
- 分析脚本（`ignore/p12/meas/`，`python -X utf8 -I <脚本>`）：`ana.py`（公共）、`roundtrip.py`、`secorder.py`、`case_clock.py`、`fade_rows.py`、`miss_rest.py`、`case_bind.py`、`case_am.py`、`b64tex.py`、`order_clock.py`、`vsin.py`、`texscan.py`、`case_script.py`、`case_phys.py`、`case_att.py`、`dump_draws.py`、`logcheck.py`。同目录的 `combo.py`、`physv.py` 等是另一个代理的，只 import 不改。

## 二、语料核对：骨骼物理、挂点、裁切遮罩与绘制组

### 结论速览

| 项 | 结论 | 残差 |
|---|---|---|
| 1 物理（`re`，2345214324） | rea-AP 2.4 的公式接上 rea-RT 的姿势模型、按 WPE 逐帧 dt 从第 1 帧跑到 216–220 帧，和 WPE 的 `g_Bones` 对上；不开物理时差 23 px。剩下的差全部来自 `rotTo` 的点积阈值（`d ≥ 1 − 2⁻²³` 判为单位四元数）在个别帧上差 1 ulp 的翻转，翻转单个判定就能把 3 号骨骼对到 1e−7 rad。 | `g_Bones` 每骨骼最大差 ≤ 6.8e−3 px（1、2、4 号 ≤ 5.5e−4）；物理转角差 ≤ 8.7e−6 rad |
| 1′ 物理（`re + ge + la`，3426865175，加测） | 重力、`s` 含 z 列、惯性用上一帧物理之后的世界矩阵、图层在动（脚本跟光标、带旋转与缩放）全部照读码；物理用的图层 W 是**上一帧脚本**写的 origin。 | ≤ 3.1e−5 px，转角差 ≤ 1.2e−7 rad（第 192 帧逐位相同） |
| 2 挂点（3463520581） | `W_子 = W_父(基类) · Pose[骨骼] · Att · T·R·S` 对上 30 个挂点子对象（图像四边形、puppet 网格、三层嵌套）；用本帧姿势。加测粒子子对象（3426865175，父是 `perspective: true` 的 puppet）也对上。语料没有挂点上的文本。 | 图像 ≤ 2.6e−4 px、线性部分 ≤ 1.7e−7；粒子 ≤ 1.4e−4 px |
| 3 裁切遮罩与绘制组（3491865410，新抓） | 有记录的 puppet 一帧画 6 次：普通段 → [清遮罩 RT → 遮罩组画进半分辨率 R8 RT → 目标组用 `CLIPPINGUVS`/`CLIPPINGTARGET` 变体画并乘遮罩] ×每条记录 → 普通段。**list2 是遮罩、list1 是被裁切的目标**，和 rea-MDL 7.3 的叫法相反。记录名就是 `g_Texture1` 的遮罩纹理。 | 每次绘制的索引序列与 mdl 绘制组逐个相同 |

---

### 1. 骨骼物理

#### 1.1 方法

- **组合模型** `combo.py`：`PhysPuppet` 每帧先调 `posemodel.Puppet.step(dt)`（动画层时钟、采样、混合），再按骨骼下标逐根做 rea-RT 6.1 的父链（`mul_affine`），每根算完 `Mw = W · B_i` 后调 `physmodel.solve`，有增量就 `B_i ← B_i · D`、重算 `Mw`；`P+0x340/0x348` 的交换照 rea-AP 2.2。`g_Bones` = `B_i · 绑定逆` 的前三行（同 rea-RT 6.3）。
- **输入**：2345214324 的 `catgirl1 minimalist`（对象 67，7 根骨骼，两层覆盖 `Head1` / `Tail`），图层 `origin (1920, 1080)`、无父、不动；WPE 的逐帧 dt 取 `ignore\p12\out\2345214324-kbp-fps20-1920x1080-log.txt`（从第 1 帧起，第 217–220 帧是被抓的长帧，dt 已钳到 0.25）。
- **真值**：`wpe-2345214324-kbp-fps20-1920x1080-consts.json` 帧 216–220 的 `vs.g_Bones`（事件 152）。
- **反推物理转角**（`combo.wpe_ang`，`run_wpeang.py`）：由 WPE 的 `K` 还原 `B_i = K_i · 绑定_i`，`D_i = L_动画⁻¹ · B_父⁻¹ · B_i`（float64），读 `D_i` 的 z 转角，和模型状态 `ang.z` 比。动画部分 rea-RT 已对到 ≤ 2 ulp，所以 `D_i` 就是 WPE 的物理增量。
- **反例**（`variants.py`、`physv.py`、`prevpre.py`）：积分比例不钳 1、`re` 也加弹簧、去掉惯性、物理从第 3 帧开始、惯性用上一帧物理**之前**的矩阵。
- **灵敏度**（`sens.py`）：每帧给 `ang`、`q` 加 ±6e−8 相对扰动，8 个种子看 216 帧的离散度。
- **阈值翻转**（`flip.py`）：记录每帧每根骨骼 `rotTo` 的点积离阈值多近，把最近的判定逐个翻过来重跑。

#### 1.2 残差（2345214324，帧 216–220）

`g_Bones` 每骨骼 12 个数的最大绝对差（平移以场景像素计）：

| 帧 | dt | b0 | b1 | b2 | b3 | b4 | b5 | b6 |
|---|---|---|---|---|---|---|---|---|
| 216 | 0.0523 | 0 | 5.5e−4 | 5.2e−4 | 6.6e−3 | 5.7e−5 | 4.6e−5 | 6.1e−5 |
| 217 | 0.25 | 0 | 5.5e−4 | 5.3e−4 | 6.8e−3 | 4.6e−5 | 4.6e−5 | 5.3e−5 |
| 218 | 0.25 | 0 | 5.2e−4 | 4.8e−4 | 6.7e−3 | 4.6e−5 | 5.5e−5 | 4.6e−5 |
| 219 | 0.25 | 0 | 5.5e−4 | 4.8e−4 | 6.8e−3 | 3.1e−5 | 3.1e−5 | 1.5e−5 |
| 220 | 0.25 | 0 | 5.2e−4 | 5.0e−4 | 6.7e−3 | 3.8e−5 | 5.5e−5 | 4.4e−5 |
| 不算物理 | | 0 | 5.4 | 23.1 | 12.2 | 5.0 | 5.0 | 5.0 |

物理转角（rad）：

| 帧 | b1 WPE / 差 | b2 WPE / 差 | b3 WPE / 差 | b4 WPE / 差 | b5、b6（WPE 反推） |
|---|---|---|---|---|---|
| 216 | −0.0106855 / −1.2e−6 | −0.0297966 / +1.3e−7 | +0.0139742 / −8.4e−6 | +0.0078939 / −1.4e−7 | ≤ 1e−17 |
| 217 | −0.0116689 / −1.2e−6 | −0.0327515 / +1.5e−7 | +0.0150348 / −8.7e−6 | +0.0111950 / −1.2e−7 | ≤ 1.7e−8 |
| 220 | −0.0114835 / −1.2e−6 | −0.0321709 / +1.7e−7 | +0.0148789 / −8.6e−6 | +0.0129871 / −1.1e−7 | ≤ 3.6e−9 |

反例（各骨骼 216–220 帧的最大差，px）：

| 写法 | b1 | b2 | b3 | b4 |
|---|---|---|---|---|
| 照读码 | 5.5e−4 | 5.3e−4 | 6.8e−3 | 5.7e−5 |
| 积分比例不钳到 1（`k = 60·dt`） | 53 | 182 | 1050 | 59 |
| `re` 也加弹簧（`rs 200`） | 5.5 | 23.1 | 12.2 | 4.9 |
| 去掉惯性 | 5.4 | 23.1 | 12.2 | 5.0 |
| 惯性用上一帧物理**之前**的矩阵 | 2.5 | 12.2 | 6.3 | 1.9 |
| 物理从第 3 帧才开始 | 5.8e−4 | 2.9e−3 | 1.0e−3 | 5.7e−5 |

#### 1.3 剩下的差在哪

- **不是公式差**：反例都差到像素级；照读码的写法 1、2、4 号骨骼在 float32 舍入级（平移 300 px 量级处 ≤ 9 ulp），3 号（最短的骨骼，`tp` 长 100 px）6.8e−3 px。
- **`rotTo` 的阈值**（`FUN_1402167c0`，`0x14021682b`：`comiss d, 0.999999881; jb` → 不低于阈值就返回单位四元数）：float32 里 `≥ 0.999999881` 只有 `1 − 2⁻²³`、`1 − 2⁻²⁴`、`1` 三个值，等价于「尖端落后不到约 4.9e−4 rad 就完全不转」。这个场景里 215 次求解有 23（b1）/ 16（b2）/ 35（b3）/ 23（b4）次判成单位，而且点积经常**正好落在** `1 − 2⁻²³` 上。`re` 没有回弹，每次判定差一点就永久留在 `ang` 里。
- **翻转实验**（`flip.py`）：把 3 号骨骼第 188 帧那一次判定翻过来，216 帧的 `ang` 从 +0.0139826 变成 +0.0139743（WPE +0.0139742）；1 号骨骼单次翻转把 `ang` 移动 ±1.2e−6 到 ±3.8e−6，WPE 的 −1.2e−6 落在这个量级里（大概是两三次翻转的组合，没逐个凑）。
- **灵敏度**：每帧 6e−8 的相对扰动下，3 号骨骼 216 帧的 `ang` 散布 0.0139691–0.0139804（标准差 3.5e−6），2 号 9.3e−7，1、4 号 < 1e−9（1 号恰好没碰上翻转，所以它那 1.2e−6 是一个确定的偏移，不是随机噪声）。
- **为什么不追到逐位**：阈值判定依赖 `dl`、`tgt` 的逐位值，而它们的上游有动画采样里 `rsqrtps`（硬件近似，rea-RT 第 7 节模型用精确值，差 ≤ 2 ulp）和 `A⁻¹` 的 SIMD 叉积写法（physmodel 用双精度求逆）。前者在 Intel / AMD 上本来就不同，所以逐位复刻做不到也没意义。
- **误差包络建议**（P12d 验收）：`re` 骨骼的物理转角每 200 帧 ≤ 2e−5 rad 量级（单次翻转最大见到 2.2e−5，3 号骨骼第 84 帧），换成像素是「骨骼长度 × 2e−5」再随子骨骼累加；没有回弹，长时间运行时按翻转次数的平方根增长。`se` 骨骼有回弹，预计更小（没测）。

#### 1.4 读码逐条核对

| rea-AP 的结论 | 实测 |
|---|---|
| `(r‖t) && (se‖re)` 才开物理 | 5 号骨骼只写 `r`（`re: false`）、6 号只写 `re`（`r: false`）：WPE 反推的物理转角 ≤ 1.7e−8 rad，两根都不动。3426865175 的 1–3 号骨骼只有 `r`，WPE 的 `g_Bones` 四根完全一样（子骨骼相对父不转）。**成立** |
| `re` 没有回弹 | 加弹簧的反例差 23 px（等于不算物理）。**成立** |
| 积分比例 `min(60·dt, 1)`，dt 是帧时间（钳到 `[0.0001, 0.25]`） | 不钳的反例差到上千像素；217–220 帧 dt = 0.25 的长帧照样对上。**成立** |
| 惯性取上一帧物理**之后**的世界骨骼矩阵 | 「之前」的反例差 2.5–12 px（2345214324）、173 px（3426865175）。**成立** |
| 首帧不算物理 | 和「第 2 帧也不算」的反例在这组数据里分不开（第 2 帧的物理增量只有 1.9e−6 rad，淹没在阈值翻转里）。**不矛盾，没区分开** |
| 重力只取垂直于骨骼的分量，强度 `m·s`，`s = (|c1| + |c0| + |c2|)/3` | 3426865175 骨骼 0（`ge`、`m 20`、`gd (0, −1, 0)`）：照读码对到 3e−5 px；`s` 只取 x、y 两列（该图层 `scale` 是 `0.3 0.3 1`，z 列长 1）差 23 px，不算重力差 261 px。**成立**，并且 `s` 确实把 z 列算进去 |
| 图层在动时惯性用世界矩阵 | 3426865175 的图层 origin 由脚本跟随光标，抓帧前光标动过四段（第 58–65、87–90、99–104、117–119 帧），图层还带 `angles 1.27915`、`scale 0.3`：照读码对上。**成立** |
| 不可见也算（rea-AP 2.6） | 没测（两个场景的物理图层都可见；3426865175 原本不可见，加测时改了属性让它可见） |
| `la`、轴锁 | 3426865175 的 `la ±1.5708`、x/y 锁住：本次转角 −1.33 rad 没碰到限位，轴锁在二维场景里本来不起作用。**没覆盖到** |

#### 1.5 加测：3426865175（重力 + 运动图层）

- **工程**：`ignore\p12\proj\3426865175-kbp`（解包）→ 副本 `3426865175-kbp-p2`，只把 `project.json` 的 `newproperty1` 改成 `"2"`，让带物理骨骼的「苍月草2」（对象 193，`图层 2_puppet.mdl`，4 根骨骼，没有动画层）可见。抓帧 `A:\p12\3426865175-kbp-p2-fps20-1600x900\`（RenderDoc 帧 189–191 → 脚本帧 190–192），日志与常量 `ignore\p12\out\3426865175-kbp-p2-fps20-1600x900-*`。
- **光标 → 世界**：`[kbp]` 日志的 `cursorScreenPosition` 是窗口像素（光标在窗口外时超出 1600×900），`cursorWorldPosition = (2.4·sx, 2160 − 2.4·sy)`；用第 190、192 帧绘制的 MVP 两点标定，斜率正好 ±2.4、截距 0 / 2160。
- **时机**：图层 origin 是脚本 `update` 写的，脚本在对象更新（puppet 动画与物理）之后跑，所以**第 k 帧物理用的 W 是第 k−1 帧脚本写的 origin**（第 1 帧用 JSON 里的值），而第 k 帧绘制用的是第 k 帧脚本写的（`phys2.py` 的「绘制 W 差」列 ≤ 1.2e−4 px）。用同一帧 origin 的反例：第 190、191 帧差 0.15 px，第 192 帧（光标在抓帧那一刻跳了 1500 px）差 126 px。这正是 rea-RT 第 2 节「脚本移动图层，挂点 / 物理晚一帧」的推断，现在实测成立。
- **残差**（`phys2.py base`）：

| 帧 | dt | 每骨骼最大差（px） | 骨骼 0 物理转角 WPE / 模型 |
|---|---|---|---|
| 190 | 0.0514 | 1.9e−5 2.3e−5 2.7e−5 2.3e−5 | −1.327397 / −1.327397（差 −1.1e−7） |
| 191 | 0.1087 | 1.9e−5 1.9e−5 3.1e−5 3.1e−5 | −1.328530 / −1.328530（差 −1.2e−7） |
| 192 | 0.25 | 0 0 0 0 | −1.329634 / −1.329634（差 +5.6e−9） |

### 2. 挂点

#### 2.1 方法

- `attach.py`：3463520581 每个 puppet 用 `combo.PhysPuppet`（这张没有物理骨骼）按日志 dt 从第 1 帧推进到 142–146 帧；每个对象按 rea-AP 1.2 递归求世界矩阵：`L = T(origin)·Rz·Ry·Rx(angles)·S(scale)`，父是 puppet、`attachment` 是字符串、父 mdl 的 `MDAT` 里找到第一个同名项、父的 `P+0x2c8` 非空（网格 0 带 `a_BlendIndices` 且有骨骼）时 `L ← Pose_父[骨骼] · Att · L`，再 `W = W_父(基类) · L`。
- **相机**：这张开着 `camerashake`，不建模；每帧用不带父对象的 `ASUNA PUPPET`（对象 30）那次绘制反推 `VP = MVP · W₃₀⁻¹`，其余每次绘制 `W_绘制 = VP⁻¹ · MVP`。
- **对照**：每个可见图像对象取 `W_绘制` 离预测最近的那次绘制，分别比平移（像素）与 2×2 线性部分。两个全屏组合层（`blur`、`bloom`）不是挂点对象，排除。
- **反例**：不乘挂点（普通父子）、用绑定姿势、用蒙皮矩阵 `K`、用上一帧的姿势。
- **粒子**（加测，`attach3.py`）：3426865175 的粒子「重力」（对象 137，`magic_gravity`，ropetrail，局部空间）挂在 puppet「芙丽莲」（对象 22，`perspective: true`，两层动画、5 个 effect）的 `Attachment` 上。粒子的 MVP 在几何着色器里，`kbp rdc consts` 只收 vs / ps，所以从 wpe-renderdoc 的 `get_shader_info(492, geometry)` 读 `g_ModelMatrixInverse` 再求逆得 `W_粒子`。

#### 2.2 残差（3463520581，帧 142–146 的最大值）

| 对象 | 名字 | 父 | 挂点 / 骨骼 | 画法 | 平移差 px | 线性差 |
|---|---|---|---|---|---|---|
| 270 | hair extra | 30 | hair back / 0 | 四边形 | 1.7e−4 | 7.8e−8 |
| 70 | HAIR BACK (BIG) | 30 | hair back / 0 | puppet 网格 | 8.9e−5 | 8.0e−8 |
| 82 / 74 / 78 | hair back c3 等 | 70 | hair back / 1 | 四边形 | ≤ 1.6e−4 | 8.0e−8 |
| 134 | main hair back c2 | 70 | hair back / 1 | puppet 网格 | 1.5e−4 | 8.0e−8 |
| 54 / 62 / 58 / 42 / 38 / 50 / 46 / 66 / 106 | c2 part … | 134 | hair back 2 / 1 | 四边形 | ≤ 2.6e−4 | 8.0e−8 |
| 16 | asuna body bottom | 30 | Attachment / 0 | puppet 网格 | 1.9e−4 | 8.0e−8 |
| 22 | asuna body | 16 | Attachment bottom / 2 | puppet 网格 | 1.2e−4 | 8.0e−8 |
| 86 / 90 / 94 / 110 / 114 | hair c1 … | 22 | head / 2 | 四边形 | ≤ 2.4e−4 | ≤ 1.0e−7 |
| 26 | back mantle（`angles −0.171`、`scale 0.825 1.232`） | 34 | Attachment / 0 | 四边形 | 1.2e−4 | 1.6e−7 |
| 130 / 98 / 102 / 122 | kirito … | 34 | Attachment / 0 | 四边形 | ≤ 2.1e−4 | 1.4e−7 |
| 126 / 118 | kirito face / arm | 34 | Attachment / 0 | puppet 网格 | ≤ 1.5e−4 | 1.4e−7 |
| 不挂点的 6 个（sky、云、两个根 puppet 等） | | | | | ≤ 7.7e−5 | ≤ 1.7e−7 |

反例（全部挂点对象 × 5 帧的最大差）：

| 写法 | 平移差 px | 线性差 |
|---|---|---|
| 照读码 | 2.6e−4 | 1.7e−7 |
| 不乘 `Pose·Att`（普通父子） | 341 | 4.5e−2 |
| `Pose` 换成绑定姿势 | 14.8 | 1.1e−2 |
| `Pose` 换成蒙皮矩阵 `K = Pose·绑定逆` | 288 | 3.1e−2 |
| 用上一帧的 `Pose` | 3.8 | 3.0e−3 |

粒子子对象（3426865175，对象 137）：

| 帧 | 预测 W 平移 | WPE（`g_ModelMatrixInverse` 求逆） | 平移差 px | 线性差 |
|---|---|---|---|---|
| 190 | (568.698, 982.897) | (568.698, 982.897) | 2.3e−5 | 9.2e−8 |
| 191 | (570.465, 990.354) | (570.465, 990.354) | 6.0e−5 | 3.7e−8 |
| 192 | (570.897, 994.736) | (570.897, 994.735) | 1.4e−4 | 3.6e−8 |

粒子的反例：普通父子差 1660 px，绑定姿势差 9–11 px，上一帧姿势差 4–7 px。

#### 2.3 结论

- 公式 `W_子 = W_父(基类) · Pose[骨骼] · Att · T·Rz·Ry·Rx·S` 成立，`Att` 就是相对骨骼的局部矩阵（rea-AP「没查清的」第 1 条可以关掉）。
- `Pose` 是本帧（子对象排在父之后时）、模型空间、动画之后的骨骼矩阵，不是蒙皮矩阵、不是绑定姿势。
- **没有动画层但带蒙皮属性的 puppet 照样提供 `Pose`**（= 绑定姿势沿父链）：对象 70、16 都没有 `animationlayers`，它们的子对象照样要乘 `Pose·Att`（不乘时差 341 px）。
- 不乘 `size`：图像四边形的绘制 MVP 就是 `VP · W`，四边形顶点本身是 `±size/2`。
- 嵌套（puppet 挂在 puppet 上、再挂第三层）就是递归，`W_父` 取父自己带挂点的世界矩阵。
- 父是 `perspective: true` 的 puppet 时，子对象（粒子）的 W 照样按这个公式，不受父的透视影响。
- 粒子子对象：局部空间系统的模型矩阵就是 `W_子`（加测只核了模型矩阵，没核发射点与轨迹）。
- 没覆盖：父有 `alignment` 偏移（这几张都是缺省 `center`）、子在父之前、挂点骨骼开着物理（物理之后的 `Pose`）、文本子对象（语料没有）。

### 3. 裁切遮罩与绘制组（3491865410）

#### 3.1 方法

- 解包 `ignore\p12\proj\3491865410-kbp`，抓帧 `A:\p12\3491865410-kbp-fps20-1600x900\`（RenderDoc 帧 184–186，1600×900 窗口），日志与常量 `ignore\p12\out\3491865410-kbp-fps20-1600x900-*`、`wpe-3491865410-kbp-fps20-1600x900-consts.json`。
- 对象「12眼睛」（88）：`12眼睛_puppet.mdl` v23，网格 0 标志 0、格式 `0x180000f`、25 根骨骼、2052 个索引；可选块 2 有 24 个绘制组；两条记录同名 `masks/clipping_mask_47aeb4f7`，`list1` 分别是 `[2]`、`[3]`，`list2` 都是 `[0, 1]`（`showmdl.py`）。
- `get_draw_calls`、`get_pipeline_state`、`get_shader_info` 看每次绘制；索引缓冲读不出来（MCP 的 `get_buffer_contents` 对它返回空，`pick_pixel` 读遮罩 RT 全 0、`save_texture` 报读回失败；收尾时发现本会话的回放进程同时被另一个代理用来开 `p12-fx` 的抓帧，这几次读取很可能落到了别人的抓帧上），改用 `get_mesh_data(vs_out)` 的 uv 逐顶点反查 mdl 顶点，还原每次绘制的索引序列，再和绘制组的拼接逐个比（`ibcheck2.py`）。遮罩 RT 的内容用 `kbp rdc frame --event N` 导出（`maskstat.py`）。WPE 自带的 `genericimage4.frag/.vert`、`clippingmaskimage4.frag` 对照源码。

#### 3.2 观察到的绘制（三帧相同）

| 事件 | 动作 | 索引 = 绘制组 | 着色器 | 目标 | 混合 |
|---|---|---|---|---|---|
| 837 | DrawIndexed 429 | 组 0–1（骨骼 3、4，键 100） | 基础材质（genericimage4 `SKINNING`，`BONECOUNT 25`） | 场景 RT 1600×900 | SrcAlpha / InvSrcAlpha |
| 839 | ClearRenderTargetView | | | 遮罩 RT（R8_UNORM 800×450） | 清成 0 |
| 858 | DrawIndexed 429 | 组 0–1 | `clippingmaskimage4`（`g_Texture0` 反照率、`g_Texture1` = 遮罩纹理、`g_RenderVar0 = (0, 10, 0, 0)`） | 遮罩 RT，视口 800×450 | SrcAlpha / InvSrcAlpha，写掩码 RGB |
| 878 | DrawIndexed 147 | 组 2（骨骼 1，键 200）= 记录 1 的 list1 | 基础材质 + `CLIPPINGUVS` + `CLIPPINGTARGET`（遮罩 RT 绑在 `g_Texture8`，线性、钳制采样器） | 场景 RT | SrcAlpha / InvSrcAlpha |
| 881 | ClearRenderTargetView | | | 遮罩 RT | 清成 0 |
| 900 | DrawIndexed 429 | 组 0–1 | 同 858 | 遮罩 RT | 同 858 |
| 920 | DrawIndexed 162 | 组 3（骨骼 2，键 200）= 记录 2 的 list1 | 同 878 | 场景 RT | 同 878 |
| 937 | DrawIndexed 1314 | 组 4–23（键 400×10、500×8、2300、2400）合成一次 | 基础材质 | 场景 RT | 同 837 |

- 六次绘制的 MVP 与 `g_Bones`（25 根）相同；每次都绑自己的一块索引缓冲（资源 1120–1125，起点都是 0，资源号按绘制顺序递增，字节数正好是该次的索引数 × 2；是不是 IMMUTABLE 没查），索引内容 = 上表那几个组按组号顺序拼接。
- 同一场景里没有记录的 puppet（`14主体上`、`13耳坠1/2`、`08左手`、`09右手`）每帧只画一次整网格。
- 遮罩 RT 在 858 之后只有眼睛区域（x 421–465、y 128–146，209 个非零像素，148 个为 255）非零，其余为 0；900 之后和 858 之后逐像素相同。
- `g_Texture1`（资源 1574）是 450×500 的 R8，就是 `materials/masks/clipping_mask_47aeb4f7.tex`（头：格式 9 = R8、450×500，和反照率 `12眼睛.tex` 同尺寸）。

#### 3.3 着色器读的常量（照抓帧的反汇编与 WPE 源码）

- **遮罩**（`clippingmaskimage4`）：VS 只读 `g_ModelViewProjectionMatrix` 与 `g_Bones`（b2）；PS：
  ```glsl
  a = texture(g_Texture0, uv).a;  m = texture(g_Texture1, uv).r;
  color = vec4(m, 0, 0, mix(pow(a, 4), a, m));   // MORPHING / SKINNING_ALPHA 时 color.a *= v_VertexAlpha
  color.r *= color.a;
  color.r = mix(color.r, 1 - color.r, g_RenderVar0.x);  // 取反；本场景 x = 0（y = 10 不读）
  ```
  混合是 SrcAlpha / InvSrcAlpha、只写 RGB，所以清成 0 的 RT 里第一层得到 `color.r · color.a`。源码注释说「color max blending」，实测混合状态不是 max。
- **目标**（genericimage4 + `CLIPPINGUVS` + `CLIPPINGTARGET`）：VS 多输出 `v_ScreenPos = (clip.x, −clip.y, clip.w)`（HLSL 才翻 y）；PS 在最后 `gl_FragColor.a *= texture(g_Texture8, v_ScreenPos.xy / v_ScreenPos.z · 0.5 + 0.5).r`，读 `g_Color4`。源码另有 `CLIPPINGCOMPOSE`（`rgb = mix(rgb, g_Texture8.rgb, g_Texture8.a)`），本场景没用到。

#### 3.4 实现步骤（给 P12b）

1. **加载**：网格 0 有 v23 记录（或网格标志 bit3）时建绘制组：键 = 每骨骼绘制顺序基数（MDLS 的 `bone_idx_b`，mdl+0x1e8）+ 组的偏移；按键升序稳定排序（语料 5 个带记录的网格与唯一的 bit3 网格，原顺序都已按键有序，静态网格上排序是恒等的，排序规则本身没实测到）。
2. **分段**：沿排序后的组走，不在任何记录 `list1` 里的组（包括 `list2` 的遮罩组）归入「普通段」，相邻的合成一次绘制；`list1` 里的组单独成「裁切段」，带上它所属记录的 `list2`。每段一份索引（组按顺序拼接）。
3. **每帧绘制**（顺序照段）：
   - 普通段：基础材质（和没有记录时一样的组合键）。
   - 裁切段：
     1. 遮罩 RT 清成 0；遮罩 RT 是 R8、**当前渲染目标的一半分辨率**（1600×900 → 800×450），视口同 RT。
     2. 用 `clippingmaskimage4`（`SKINNING`、`BONECOUNT`、按网格标志加 `SKINNING_ALPHA` / `MORPHING`；rea-MDL 9.3）画记录的 `list2` 组，`g_Texture1` = `materials/<记录名>.tex`，`g_RenderVar0 = (0, 10, 0, 0)`，同一个 MVP 与 `g_Bones`。
     3. 用「基础材质 + `CLIPPINGUVS` + `CLIPPINGTARGET`」画 `list1` 组，遮罩 RT 绑 `g_Texture8`（线性、钳制），其余同基础材质。
   - 每条记录各做一次清 + 画遮罩，即使两条记录的 `list2` 相同也不合并。
4. **翻译器**：`CLIPPINGTARGET` 的 `g_Texture8` 是隐藏槽，翻译器要给它出绑定；`v_ScreenPos` 的 y 翻转按目标 API 定（WebGPU 的 NDC 与 D3D 一样 y 向上、纹理 y 向下，照 HLSL 分支翻）。

#### 3.5 没查清的

- 同一条记录的 `list1` 有多个组（`3577990983` 的 `[74, 75]`）时，是合成一次目标绘制、还是逐组各配一次遮罩。
- 记录 flags（语料全 0）的 bit0、bit3（rea-MDL 7.3：`list1` 再置 4）与 `g_RenderVar0.x`（取反）、`CLIPPINGCOMPOSE` 的对应；`g_RenderVar0.y = 10` 的来源。
- 带 effect 的 puppet（合成路径 `FUN_140208c80`）上的裁切：遮罩 RT 是否按合成 RT 的一半。
- 网格标志 bit3（动态索引、动画驱动的绘制顺序）没抓：只有 `3577990983`。
- 遮罩 RT 尺寸「一半」是对窗口还是对场景 RT：这次两者都是 1600×900，分不开。

---

### 更正读码

- **更正 rea-p12-mdl 第 7.3 节**（与概括第 7 条）：「list1 的组标 1（遮罩），list2 的组标 8（被裁切）」的叫法反了。实测 **list2 的组是遮罩**（画进遮罩 RT，并且照常作为普通组画一次），**list1 的组是被裁切的目标**（只用 `CLIPPINGTARGET` 变体画，不再作为普通组画）。标志值（list1 `|= 1`、list2 `|= 8`）本身没测到，按读码保留。同节「推断：记录名是 `g_Texture1` 的遮罩纹理」实测成立；「分段画（推断按索引区间画）」实际是每段一块自己的索引缓冲（起点 0）。
- **补充 rea-p12-attach-physics 第 2.4 节**：`rotTo` 的「点积 ≥ 0.999999881 返回单位」在 float32 里等价于尖端落后小于约 4.9e−4 rad 时惯性项完全为零，物理逐位一致性主要卡在这里（不是公式错，是实现上要照抄这个比较）。
- **补充 rea-p12-runtime 第 2 节**「脚本之后再移动图层的话，挂点会晚一帧（推断）」：物理这一半实测成立（3426865175，第 k 帧物理用第 k−1 帧脚本写的 origin）；挂点那一半这次没有脚本驱动的父对象，没测。

### 没查清的（汇总）

1. 物理逐位一致：卡在 `rotTo` 阈值翻转，上游的 `rsqrtps` 与 SIMD 求逆没复刻；误差包络见 1.3。
2. 首帧不算物理 vs 前两帧不算：数据分不开。
3. `se` 模式、`la` 碰到限位、`lt`、平移物理（`t`）、轴锁：这两张场景都没覆盖（`3554161528` 的 `t + se`、`3577990983` 的 `r + se + la` 还没抓）。
4. 物理图层不可见时照算：没测。
5. 挂点：父的 `alignment` 偏移、子在父之前、挂在开物理的骨骼上、脚本驱动的父对象、文本子对象（语料没有）。
6. 粒子子对象只核了模型矩阵，没核发射点与轨迹。
7. 裁切：见 3.5。

### 文件

- 脚本（`ignore\p12\meas\`）：`combo.py`（姿势 + 物理组合模型、2345214324 对照）、`run_wpeang.py`（WPE 物理转角反推）、`physv.py`（solve 的拷贝，加反例开关）、`variants.py`、`prevpre.py`、`sens.py`、`flip.py`、`traj.py`、`phys2.py`（3426865175 重力加测）、`attach.py` / `attach_sum.py`（3463520581 挂点）、`attach2.py` / `attach3.py`（3426865175 粒子挂点）、`showbones.py`、`showmdl.py`、`ibcheck2.py`、`bbox.py`、`maskstat.py`、`eyeconsts.py`、`pupdraws.py`、`dgcorpus.py`、`texhdr.py`、`curs.py` / `curs2.py` / `p2draws.py`。
- 中间数据：`ignore\p12\meas\ib\vsout*.json`（眼睛 6 次绘制的 vs_out）、`rt837` / `rt858` / `rt900`（事件后的渲染目标）。
- 新抓帧：`A:\p12\3491865410-kbp-fps20-1600x900\`、`A:\p12\3426865175-kbp-p2-fps20-1600x900\`；工程 `ignore\p12\proj\3491865410-kbp`、`3426865175-kbp`、`3426865175-kbp-p2`（只改 `project.json` 的 `newproperty1`）。
