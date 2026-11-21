# 场景壁纸：图像层与材质

> [场景壁纸文档](../WPE_SCENE.md) 的一章：图像模型标志、组与组合层、perspective、全屏组、P8 补全、图像层帧表（P5b、P5f–P5h、P5j、P8、P6e）。总体形态、各阶段状态与全部章节的索引在总览里。

## 图像模型标志（P5b）

P5b 的标志都作用在图像层上，不新增图层种类，改的是一个图像层「画什么、画多大、画到哪」。按改动的深浅分三类：
- **只改编译期的量**：`autosize` / `projectlayer` 改尺寸来源，`nopadding` 改 UV 内缩，`instanced` 改材质与合成 RT 尺寸。
- **只改一次绘制的矩阵**：图像层 `perspective: true` 在上屏时换透视；`fullscreen` 画 NDC 四边形，带 effect 时不画基础材质、改拷贝当前画面。
- **结构变化只有组合层**：passthrough 模型画进自己的合成 RT；带子层的组合层（「组」）把子孙画进去，子孙不在顶层画。

依据：
- 读码：[rea-p5-modelflags](../../../.claude/plans/wpe-import/3-scene/phase5/rea-p5-modelflags.md)（全部没有实测），透视图层另见 [rea-p5-camera](../../../.claude/plans/wpe-import/3-scene/phase5/rea-p5-camera.md)。
- 实测：[报告](../../../.claude/plans/wpe-import/3-scene/phase5/p5-REPORT.md)「P5b 语义的实测核对」。21 个确定性工程，读码的流程全部成立，推翻两处推断：无 effect 带子层的组怎么上屏；`instanced` 的遮罩只在多 pass effect 时变糊。
- 逐步的验收数据：[子计划](../../../.claude/plans/wpe-import/3-scene/phase5/phase-5b-modelflags.md)「实施记录」「P5b 收尾」。下面每条只点出依据，数字和例外以子计划为准。

验收：
- 确定性工程按固定时刻渲染，和 WPE 抓帧整帧逐像素比（`kbp cmp frame`），各步最大差 1–2；
- 真实样本按 WPE 日志回放到抓到的那一帧，比对应区域；
- 10 张基线场景 × 三档后处理的画面哈希每步不变。

### 尺寸、UV 内缩与透视图层

| 项 | 规则 | 依据 |
|---|---|---|
| 尺寸来源 | 照 WPE 的顺序（`bundle.ts` 的 `imageLayerSize`）：<br>1. 模型 `width` / `height`（数字，缺了是 1，逐分量）；<br>2. 对象 `size` 逐分量覆盖；<br>3. `autosize` 在「纹理就绪」时再覆盖：`projectlayer` 取正交投影宽高（取整），否则取槽 0 纹理的图像尺寸，没有纹理时不覆盖。<br>三者都缺时是 1×1（原来取纹理尺寸） | 读码 §7；实测 `p5b-autosize`、`p5b-proj`。语料里同时写 `autosize` 和 `size` 的 1514 个对象，两种顺序取值全部一致，所以改顺序对现有场景中性；精灵表的帧尺寸随图像层帧动画（P6） |
| `fullscreen` 的尺寸 | 排在 `autosize` 之前，几何固定 2×2，合成 RT 另取 `fullscreenSize`（见「fullscreen」） | 读码 §7 |
| UV 内缩 | 直接上屏（WPE `+0x490`）在模型 `fullscreen`、`nopadding`、`passthrough`、`solidlayer` 时不内缩；末 pass 与 passthrough 上屏（`+0x2e8`）不看 `nopadding`（`graph.ts` 的 `directInset` / `finalInset`）。`solidLayer` 只表示模型那一位，instanced 也不内缩 | 实测 `p5b-nopad-v2`（1845 个像素差 1）、`p5b-inst2` |
| 透视图层 | 图像层 `perspective: true` 时（文本层同一套，P5g，见「文本层的 perspective（P5g）」），画到场景目标的绘制（直接上屏、末 pass、passthrough 上屏）把视图投影换成透视粒子那一份 `perspectiveViewProjection`，已带抖动与缩放，相机距离随 `perspectiveoverridefov` 与 `zoom` 变。视差平移照旧右乘：`P_persp · T(o − s) · W`。画进合成 RT 的 pass、effect 中间 pass 不变 | 读码；实测 `p5b-persp*`：fov 30 时距离 2015.3 = 540 / tan 15°，`zoom 1.5` 时距离除以 1.5，视差偏移落在 z = 0 平面上正好是屏幕上的 o 像素；平滑纹理的 `p5b-persp-smooth` 最大差 1 |

**更正读码：** rea-p5-modelflags 推断纹理标志 `0x20` 表示「未补边」，实际 `0x20` 是视频位（`compile/tex.ts` 的 `TEX_FLAGS.video`）。语料里写了 `nopadding` 的纹理带 `0x20`，是因为编辑器给视频纹理写了 `nopadding`。

### 组合层（passthrough 模型）

`composelayer`、`composelayer_depthtest`、`fullscreenlayer`、`projectlayer` 都是 passthrough 模型（`SceneLayer.passthroughModel`）。渲染图的形状同带 effect 的图层：基础 pass → effect 链 → 借基础材质的 blend 上屏（`colorBlendMode` 混合时用 passthrough 上屏）。

| 项 | 规则 | 依据 |
|---|---|---|
| 基础 pass | `copybackground` 缺省 true，只有 JSON `false` 才关（`SceneLayer.copyBackground`）。<br>true：画材质本身（composelayer 着色器），角色 `compose`，MVP 是图层的 `VP · T(o − s) · W`，关混合、写 RGBA。着色器按 UV 铺满合成 RT，按 MVP 算这块在屏幕上的位置去采快照。<br>false：不画基础材质，合成 RT 0 清成 (0, 0, 0, 0)（`clear` 步骤） | 实测 `p5b-cl`（旋转、`copybackground: false`、无 effect 两种、cbm 2 五个层，32 个像素差 1） |
| 不画 | 没有启用的 effect、`colorBlendMode` 是 0 / 31、没有子层时整层是空计划。WPE 照拷一次快照，看不出来，我们不拷 | 实测 |
| 合成 RT 与内缩 | 合成 RT 按 `round(size)`，上屏不内缩 | 实测：600×300，上屏 UV 0–1 |
| `projectlayer` | 尺寸取正交投影宽高（`autosize`）；排序键 −∞ 只在透视场景的透明排序里起作用（P5d 步骤 4 已实现，见 [CAMERA.md](CAMERA.md)「透视相机、相机对象与深度（P5d）」） | 实测 `p5b-proj`，0 差异 |
| 组合层 + `perspective: true` | P5h 起支持：基础 pass 仍用正交场景相机，末 pass 与组的上屏换透视（见「脚本 `layer.perspective` 与组合层的 perspective（P5h）」） | 实测 `p5h-a` |

### fullscreen

| 项 | 规则 | 依据 |
|---|---|---|
| 直接上屏 | 没有启用的 effect、cbm 是 0 / 31、不是组合层：几何是 2×2 的 NDC 四边形，MVP 照常算。着色器不乘 MVP 就铺满全屏（neon_sunset 的 `cloudsbg`），乘了是一块被 `W` 变换的 2×2 方块 | 实测 `p5b-fsmvp`，0 差异 |
| 合成路径 | 不画基础材质：先拍快照，再整张拷进合成 RT 0（`copy`，源是 `framebuffer`），之后照常跑 effect 链。上屏与 effect pass 的模型、视图是单位阵，投影是 `ortho(−1, 1, −1, 1, 1, −1)`（`FULLSCREEN_VIEW_PROJECTION`），`origin` / `scale` / `angles`、视差、抖动都不起作用 | 实测 `p5b-fs`，最大差 1 |
| 合成 RT 尺寸 | `fullscreenSize` 取槽 0 静态纹理的图像尺寸；槽 0 是 `_rt_FullFrameBuffer`（fullscreenlayer 都是）或没有纹理时取场景目标尺寸。WPE 取的是窗口尺寸；产品离屏按场景分辨率渲染，对应的是场景目标，dev 探针按窗口尺寸画时就是窗口尺寸；两份都不内缩 | 实测 `p5b-fs-1344`（1344×756 窗口）；按指定尺寸复核：合成 RT 1344×756，四个绘制的常量和 WPE 逐位相同 |
| fullscreenlayer | 组合层加 `fullscreen`：没有 effect、cbm 是 0 / 31 时同组合层整层不画；带子层是全屏组，P5j 起支持（见「全屏组（P5j）」） | 读码 §2.5；实测 `p5j-a` |

### 组（带子层的组合层）

| 项 | 规则 | 依据 |
|---|---|---|
| 归属 | 编译期定（`bundle.ts` 的 `assignGroups`）：`group` 是最近的组合层祖先；`subtree` 按先序展开，子层按 `objects` 下标排，嵌套组只收它本身。顶层循环跳过 `group` 非空的图层，缺这个字段（手写的图层）当顶层 | 读码 §2.5 |
| 画子树 | 基础 pass（`compose` / `clear`）之后紧跟 `subtree` 步骤：结束当前 pass，对可见的子孙依次跑它们的 ops，「场景目标」换成组的合成 RT。`subtree` 不算一次合成链的写入 | 实测 `p5b-grp-cb1` / `cb0` |
| 视图投影 | 子孙画到「场景」的绘制（含粒子）换成 `groupViewProjection = ortho(±w/2, ±h/2, 1000, −1000) · inverse(W_组)`（w、h 取组的 `size`），所以子层落在组的本地坐标系，组矩形外的部分裁掉。组里没有视差、抖动、透视，这些作用在组本身的上屏上。世界空间粒子的顶点乘 `inverse(W_组)` 回到本地（P14d 起由模型矩阵乘，见下）。图像层的 MVP 照 WPE 的结合顺序算（2026-11-20，P8 步骤 7 走查）：WPE 画子树时模型栈是 `inverse(W_组)`（`FUN_14005f730`），子层并进模型栈再乘局部正交，`MVP = P ⊗ (inverse(W_组) ⊗ W)`（`groupMvpParts` + `drawMatrices` 的 `group`，组的逆用 `invertF32`）；先拼好再乘平移会差 1 ulp，压在光栅化 1/256 像素的对齐分界上时边缘的 texel 整个翻转。图像层（P14c）与网格（P14b）的 `g_ModelMatrix` 是组内局部的 `inverse(W_组) ⊗ W`（图像层仿射乘法、网格 glm 乘法）、`g_ViewProjectionMatrix` 是 P 本身；图像层的 `g_EffectModelMatrix`、`g_LayerModelMatrix` 仍是世界矩阵 W，效果投影矩阵和 WPE 有意不同（见「组里图像层的矩阵（P14c）」）；粒子（P14d）的绘制栈从 `inverse(W_组)` 起，本地系统 `inverse(W_组) · W`、世界系统 `inverse(W_组)`，视图投影是 P（见「组里的粒子（P14d）」）；文本仍用先拼好的 `groupViewProjection`。嵌套组的 `compose` 用**不带视差**的场景视图投影采快照（缩放、抖动带；顶层组合层的 compose 带视差，P5j 更正），采到的是外层开始时那份。全屏组的子孙不换局部正交（见「全屏组（P5j）」） | 实测 `p5b-grp-par`、`p5b-grpptc`（最大差 2）、`p5b-nest`；`p5j-cam`（G 里的 M） |
| 写 alpha | 直接画的子层写 RGBA；组里的上屏（带 effect 子层的末 pass、嵌套组画回外层）只写 RGB。组 `copybackground: false` 时 alpha 用 One / One / Max，颜色照绘制自己的混合（`programs.ts` 的 `groupBlendState`，管线键加 `\|max`） | 实测：`p5b-grp-cb1` 子层写掩码 15，`p5b-grpptc`、`p5b-nest` 的上屏是 7；`p5b-grp-cb0` 重叠处 alpha 0.5 |
| 无 effect 的组 | 基础 pass → 子树 → 上屏：用 `effectpassthrough` 材质（`version` > 2 用 `_4`，`BLENDMODE 0`，`SceneLayer.groupUpload`，`g_Color4` 置 1）画世界四边形，UV 0–1；`copybackground` 为 true 时用材质的 normal（不混合），false 时 translucent | 实测 `p5b-grp-nofx` / `nofx0`，**推翻读码**（读码推断是 composelayer 着色器铺满全屏并拉伸） |
| 合成 RT 池 | 组里的图层按父链上组的层数另分一池（键加 `\|k<层数>`），不然和组同尺寸的子孙会共用组的合成 RT | 步骤 4 实现时发现 |
| 照报 | `features.ts` 的 `groupChildIssues`：`fullscreen` 报 `…:fullscreen`；透视图层、透视粒子报 `…:perspective`。子孙读快照 P5b 时照报 `model:passthrough:children:framebuffer`，P5f 起支持、不再报（见「组里读快照（P5f）」） | 读码 |
| 快照（P5f） | 拷「当前目标」：组里是组的合成 RT，只拷左上角重叠部分；层首拷贝在直接父是组时跳过，effect 前、粒子前照拷，组里的上屏不拷 | `p5f-a`..`p5f-e`，见「组里读快照（P5f）」 |

### instanced（纯色图层）

| 项 | 规则 | 依据 |
|---|---|---|
| 模型 | 编辑器的「纯色图层」：`{instanced, solidlayer, material: materials/util/solidlayer_instance*.json}`，材质是 translucent 的 genericimage2 / 4，槽 0 是 `util/white`（32×32） | 语料 167 个对象 |
| 材质覆盖 | 编译材质前，对象的 `instance` 覆盖每个 pass：`combos` 合并，`textures` 按槽合并，规则同 effect 实例覆盖（`bundle.ts` 的 `instanceOverride`）。语料 167 个对象的 `textures` 都是一个非空字符串（94 个 `util/white`、73 个工程纹理），`combos` 都是 `{"version": 2}` | 实测 `p5b-inst` I2、`p5b-inst2` J2：槽 0 换成覆盖的那张 |
| 合成 RT | 按槽 0 纹理的图像尺寸，不按 `size`（`compositeSize` 的条件是 `solidLayer && !instanced`）。`util/white` 时是 32×32，fbo 跟着它：多 pass effect 的中间结果在 32×32 上，遮罩变糊；单 pass effect 的末 pass 直接上屏，遮罩按自己的分辨率采样 | 实测 `p5b-inst2`：J1 合成 RT 与 fbo 都是 32×32，对照组 900×1000；`instance.textures` 换成补边纹理时取图像尺寸 48×40。整帧 0 差异 |
| 内缩与颜色 | 不内缩（`solidlayer` 那一位）；颜色照常进基础 pass | 实测：J1、J2 末 pass UV 0–1，J3 直接上屏 UV 正好是图像 / 纹理；`p5b-inst` 的 `g_Color4` = (1, 0.6, 0.2, 1) |
| 照报 | `features.ts` 的 `checkInstanceFeatures`：<br>- `usertextures`：P11b 起按槽并进基础 pass，用户属性纹理已实现（参考尺寸取对象 `size`、换图后合成 RT 跟着变、强制 `g_Color4 = 1`），媒体封面 P11c 起支持（见 [AUDIO_MEDIA.md](AUDIO_MEDIA.md)「媒体（P11c）」），快捷方式图标 P11d 起支持（见 [AUDIO_MEDIA.md](AUDIO_MEDIA.md)「快捷方式（P11d）」）；<br>- `instance` 缺失或不是对象 → `model:instanced:instance`；<br>- 对象 `size` 不是字符串 → `model:instanced:size`（WPE 按 `"w h"` 读）；<br>- `textures` 不是非空字符串的数组、`combos` 不是对象、其它键 → `object:instance:<键>`。<br>`id` 是编辑器键，不是 instanced 的对象上 `instance` 不读 | 语料：只有 `usertextures` 出现过 |

### 已知差异与只记不补

- **effect pass 的 `g_Color4`**：WPE 是这一帧最后设置的值。fullscreen 拷贝路径、`copybackground: false` 的组合层拿到前一个画过的层的颜色，组拿到最后一个子层的颜色；我们给层自己的颜色。语料 2190 个着色器文件和 WPE 自带的 46 个 effect 都不读 `g_Color4`。
- **组里 alpha 的写开关**：WPE 的写开关是全局状态，一个子层的合成链结束后，同组之后的普通绘制也只写 RGB（`p5b-grpptc` 的粒子写掩码是 7）。这取决于运行时的可见性与 effect 开关，没照搬，只影响组 `copybackground` 为 true、排在带 effect 子层之后的绘制的 alpha。另外，`copybackground: false` 的组里，WPE 的 alpha MAX 也作用到子孙自己合成链里开了混合的 pass，我们没照搬。
- **effect 中间 pass 的矩阵**：组里按局部正交算、透视图层按正交算。WPE 的规则见 [effect-matrices-REPORT](../../../.claude/plans/wpe-import/3-scene/effect-matrices-REPORT.md)，归 P7d。收尾时统计过语料：组里带多 pass effect 的子层有 17 个，在 3 张场景里，都还有 20 项以上别的不支持项；透视图层的 effect 合计多于一个 pass 的有 3 张，能渲染的 `1923929928` 的三个 effect 各 1 个 pass，前两个是「非最后一个 effect」（WPE 的 MVP 也是 `ortho(±1)`），最后一个是上屏，没有差异。
- **组里跟随指针的粒子**：控制点仍按场景坐标反投影。语料 0 个。
- **fullscreen**：
  - 非组合层带 effect、槽 0 是静态纹理时，合成 RT 是纹理图像尺寸，我们只拷快照左上角那一块，WPE 两边尺寸不同时怎么拷没测（语料 0 个）；
  - 带 cbm 混合上屏没测（语料 1 个对象，`3554161528`，另有 38 项不支持）；
  - 脚本读 `thisLayer.size` 得 (2, 2)，WPE 可能给图像尺寸；
  - `g_Texture0Resolution` 等按场景目标尺寸，WPE 是窗口尺寸。窗口和场景比例或尺寸不同时，按纹素算偏移的 effect（如模糊）相对画面内容和 WPE 不一样。
- **尺寸**：`size` 绑属性同时 `autosize` 时，WPE 运行中改 `size` 不重跑纹理回调，我们整场重编译会重新按 `autosize` 覆盖；对象 `size` 只写一个分量时另一个取模型值或 1（推断）。语料都是 0 个。
- **组合层**：`copybackground` 绑属性或挂脚本时按 true、不报；无 effect 组的 `groupUpload` 在 cbm 31 时取 additive（读码）。语料都是 0 个。
- **instanced**：`instance.textures` 按槽合并还是整键替换、`combos` 合并还是替换，语料里两种结果相同；null 槽、比材质短的数组在 WPE 里什么样没测。
- **原归 P5d，现状**：深度测试按 P5d 步骤 1 的统一规则；透视场景里的透明排序（`projectlayer` 与 `fullscreen` 的排序键 −∞）步骤 4 已实现；透视场景里 `projectlayer` 的尺寸来源（W = H = 0）照报 `camera:perspective:projectlayer`，没测。见 [CAMERA.md](CAMERA.md)「透视相机、相机对象与深度（P5d）」。

### 语料与解锁

| 步骤 | 去掉的键 | 新增的键 | 能渲染 | 新解锁 |
|---|---|---|---|---|
| 1 尺寸、内缩、透视图层 | `model:nopadding` 40 张、`object:perspective` 5 | — | 39 → 40 | `1923929928` |
| 2 组合层：无子层 | `model:passthrough` 68、`model:projectlayer` 12 | `model:passthrough:children` 9 | 43 → 43 | `1333579536` 加上同期 P4e 的粒子子系统，两步合起来能渲染 |
| 3 fullscreen | `model:fullscreen` 27 | — | 43 → 43 | — |
| 4 组 | `model:passthrough:children` 9 | `model:passthrough:children:framebuffer` 1（`3465215190`，组里的雨滴粒子要读快照） | 45 → 45 | — |
| 5 instanced | `model:instanced` 30、`object:instance` 30 | `material:usertextures` 9（它们的 instance 带用户纹理） | 46 → 46 | — |

- 各步的起点不同，是同期 P4e、P6、P7 也在解锁。没有场景因 P5b 不再能渲染。
- 去掉这些键之后，剩下的场景大多还差文本（P6b）、木偶动画（`model:puppet`，P12）、视频纹理（P9）、光标回调（P6）。`3822149301`、`3824550659`、`3828359750` 去掉 `model:nopadding` 后只差 `tex:video`，原因见上「更正读码」；`3810092560` 去掉 instanced 后只差两个光标回调。
- **和 WPE 比**：
  - 确定性工程：`p5b-autosize`、`p5b-proj`、`p5b-fsnofx`、`p5b-fsmvp`、`p5b-inst`、`p5b-inst2` 0 差异，`p5b-nopad-v2`、`p5b-cl`、`p5b-fs`、组的 6 个工程最大差 1，`p5b-grpptc` 最大差 2；
  - `1923929928`：透视网格的线位、汇聚方向、间距、颜色一致，其余是随机星空粒子与缩放；
  - `1333579536`：整屏组合层一致；
  - `3340707146`：28 个子层的人物组，位置和形状一致；
  - `3810092560`：差异只在细线条的边缘（2560 → 1920 缩放与 waterwaves 采样），instanced 白色背景露出的地方 0 差异。
- **基线**：10 张原本能渲染的场景 × 三档后处理，共 30 个画面哈希，每步都和之前相同。基线里没有用到这些标志的场景，所以这只能说明没改坏别的，对不对靠上面的整帧比较。

### 对比台

在 `ignore/p5/` 下：
- 确定性工程：`b0/gen_b.py`（步骤 0 的 `p5b-*`，自写 `.tex` 与 `kbfx` / `kbmask` effect）、`b5/gen_b5.py`（`p5b-inst2`，两 pass 遮罩的中间 pass 不乘 MVP，同 WPE 自带 effect），工程放在 `proj/`；
- 读数：`b0/rdc_dump_b.py` 在 `qrenderdoc --python` 下导出每次绘制的 RT、混合、顶点、UV 与常量，`ana_b.py` / `b5/ana_b5.py` 摘要；单测的真值由 `b2/fixture_compose.py`、`b3/fixture_fs.py`、`b4/fixture_grp.py` 从导出里抄出；
- 各步的快照、补丁、变异清单、语料比较与整帧比对在 `b1/`–`b5/`，收尾的语料统计是 `b5/walk_scan.py`；
- WPE 参照在 `A:\p5b\`。

## 组里读快照（P5f）

组（带子层的组合层）里的子孙读 `_rt_FullFrameBuffer` 时，WPE 的拷快照函数拷的是**当前绑定的渲染目标**：顶层是场景目标，整张拷；组里是组的
合成 RT。两者尺寸不同时只拷重叠的**左上角** `min(宽) × min(高)`，快照其余部分保持上一次拷贝的内容。读快照的着色器照常按 `gl_Position` 算
屏幕坐标，组里的投影是组的局部正交，所以它们按「组矩形 = 整个 0–1」去采整张快照：组 RT 的内容只占左上角，其余采到的是更早拍下的场景。
我们照做：编译期不再报 `model:passthrough:children:framebuffer`（P5b 照报），计划层（`render/graph.ts` 的 `isDirectGroupChild`）按下表决定拷不拷，
渲染器（`render/scene.ts` 的 `snapshot`）拷当前目标，组里用 `copyTextureToTexture` 拷到快照的 (0, 0)。着色器、uniform、组的局部正交都不动。

计划与实测见 [phase-5f](../../../.claude/plans/wpe-import/3-scene/phase5/phase-5f-group-framebuffer.md)「步骤 0 结果」。

| 拷贝点 | 组里的规则 | 依据 |
|---|---|---|
| 层首（基础材质读快照，或 colorBlendMode 混合；含文本层的 `composelayer_clearalpha`） | **直接父**是组合层就不拷；组里隔着分组节点的孙子层照拷，拷组 RT | `FUN_1401e8aa0` 的 `0x1401e8f63`（`+0x180` 父、`+0x120 & 4`）；`p5f-a` 的 FB、CB，`p5f-e` 的 FBg（Resolve 96） |
| effect 前 | 照拷，拷组 RT | `0x1401e9b12`，不看父；`p5f-a` Resolve 144 |
| 粒子前（`REFRACT` 等） | 照拷，拷组 RT | `FUN_1402366f0`；`p5f-a` Resolve 164 |
| passthrough / 组的上屏 | 不拷（顶层的混合层已由层首拷过，顶层计划不变） | `0x1401ea06d` 起没有拷贝调用；`p5f-a` 的 CB、组的上屏 |
| 拷贝的范围 | 组 RT 左上角 `min(组 RT, 快照)`，到快照的 (0, 0)，其余不动 | `p5f-a` 拷后快照（900×500）、`p5f-e`（2400×600 截成 1920×600）逐像素核对 |
| 嵌套组 | 内组直接父是组，层首不拷，它的 composelayer 采的是当时的快照（可能已被外组里先画的兄弟改过左上角） | `p5f-e` 的 I |
| 每层至多一次 | 保留。WPE 的 effect 前标志在 effect 循环开头清 0，层首拷过还会再拷，但两次之间当前目标不被本层改动，内容相同 | `0x1401e9a25` |
| 结构变化 | 登记表的位置派生量（`structureKey`）含「直接父是不是组」，组内换到分组节点下面时重排 | — |

**已知差异来源**：WPE 用 `ResolveSubresource` 拷（两边都不是 MSAA、尺寸也不同，按 D3D11 规范不合法）。这台机器（NVIDIA）上测试窗口的真实画面
和 RenderDoc 回放逐像素相同，行为就是「拷左上角重叠部分」；别的驱动上 WPE 自己可能不同，我们照这台机器做。

**验收**（`ignore/p5/f/`，WPE 抓帧 `A:\p5f\`）：生成工程 `p5f-a`（组 900×500）、`p5f-b`（`copybackground: false`）、`p5f-c`（组与屏幕同尺寸）、
`p5f-e`（组 2400×600、分组节点下的孙子、嵌套组）整帧和 WPE 逐像素相同（屏蔽 FR / CLK）；`p5f-d`（组转 0.3 弧度）只有 1 个像素差 1 级。
工坊场景 `3465215190`（组「路面雨滴」里两个 `REFRACT` 的雨滴溅射粒子）不再退回；语料里只差这个键的 `3465215190`、`3233141951` 解锁。

## 文本层的 perspective（P5g）

文本层是图像层的子类，绘制走同一个基类函数 `FUN_1401e8aa0`：直接上屏分支里对 `perspective`（`+0x120 & 0x80`）的图层先压透视相机
（`0x1401e92b3` 调 `FUN_1401e5b60`），再调文本的直接上屏 `+0xf0`（背景、字形、彩色字形）；合成路径的上屏（末 pass、passthrough）也在同一个
基类里压透视相机（`0x1401e9eb3`）。所以规则和图像层「透视图层」一样：画到场景目标的绘制换成透视粒子那一份视图投影，画进合成 RT 的字形不变
（`textMatrices` 用 RT 像素的正交）。实现：编译期文本层取 `layer.perspective`（只认 JSON true），能力表放行，渲染器的 `text` 步骤传
`viewProjectionOf(…, layer.perspective)`；光标命中、反射名单、组里照报都按 `layer.perspective` 自动跟上。

画面和图像层看起来不一样：文本的字形与背景着色器（`basefont` 一族）把顶点当二维点 `(x, y, 1)`、只取 MVP 的 x、y、w 三列，丢掉 z 列
（RenderDoc 反汇编 `dp3 … g_ModelViewProjectionMatrix[i].xywx`），绕 x 轴转的文本在透视下塌成一条线；走合成路径的末 pass / passthrough
用四维乘法，是正常的透视。我们的文本着色器是同一份 WPESL 翻译的，MVP 相同画面就相同，不用另做。

计划与实测见 [phase-5g](../../../.claude/plans/wpe-import/3-scene/phase5/phase-5g-text-perspective.md)「步骤 0 结果」。

**验收**（`ignore/p5/g/`，WPE 抓帧 `A:\p5g\`）：生成工程 `p5g-a`（直接上屏、带背景、带 effect、colorBlendMode 2、`perspective: false` 对照、
透视图像层对照，全部绕 x 轴转 −0.9 弧度）与 `p5g-par`（同上加相机视差）整帧和 WPE 逐像素相同（屏蔽 FR / CLK）。语料 `3841256486` 变干净，
`3348595482` 只剩翻译器的 `float2` 解析问题。

## 脚本 `layer.perspective` 与组合层的 perspective（P5h）

`perspective` 是 WPE 图像层属性表（`FUN_1401ee520`，`0x1401ee9a4`）里的一项，读写对象标志 `+0x120` 的 bit7；文本层继承图像层的表。绘制函数
`FUN_1401e8aa0` 每次画都现读这一位，所以脚本写了**当帧生效**。

| 项 | 规则 | 依据 |
|---|---|---|
| 键在哪些对象上 | 图像层（含组合层、带子层的组）与文本层；粒子、分组节点、声音没有（`typeof` 为 `undefined`）。WPE 的键序是 `…,castshadow,perspective,visible,…`，我们装在 `alignment` 之后、不逐键对齐 | 实测 `p5h-a` 的键序日志 |
| 读 | 总是布尔：脚本写过取状态（`LayerState.perspective`），没写过取编译期的 `layer.perspective`（JSON 只认 true），待编对象（P6d3b）取 `createLayer` 配置里的值 | 实测 |
| 写 | 只收 JS 布尔；`1`、`0`、`'true'`、`''`、`null`、`undefined`、`{}`、`[1]`、`2.5`、`-1`、`'false'` 都不写、不抛错，保留原值 | 实测（`init` 里逐项写再读回） |
| 生效 | 当帧：写进 `SceneState`、标这一个图层脏（uniform 只在标脏时重写），渲染器取视图投影（文本、图像、预光照的 `alt`、上屏）与光标命中都读状态 | 实测：`update` 按帧号奇偶写，偶数帧的 MVP 是正交、奇数帧是透视 |
| 组合层 / 组 + `perspective: true` | 不再照报 `object:perspective`。compose 基础 pass 仍用正交场景相机（画进合成 RT），末 pass 与组的上屏换透视，组里的子层仍用组的局部正交——正是「透视图层」现有的规则（画到场景目标的绘制换透视），渲染器不用改 | 实测 `p5h-a`：CL（无子层带 effect）基础 pass 正交、末 pass 透视；GP（带子层）上屏透视 |
| 不在本节 | JSON 里 `perspective` 绑属性、挂脚本仍报 `object:perspective`（语料 0）；组里的图层运行中写 `perspective` 仍按组的局部正交画（`groupChildIssues` 只照报 JSON 写死的）；反射名单（`reflection:planar:*`）按编译期值判。运行中写入这几种语料 0 处 | — |

计划与实测见 [phase-5h](../../../.claude/plans/wpe-import/3-scene/phase5/phase-5h-perspective-runtime.md)。

**验收**（`ignore/p5/h/`，WPE 抓帧 `A:\p5h\`）：生成工程 `p5h-a`（组合层带 effect、组、脚本按帧号奇偶切 `perspective` 的棋盘层、透视对照层、
键序用的文本 / 粒子 / 分组节点）跑脚本回放到第 199 帧，整帧和 WPE 逐像素相同（屏蔽 FR / CLK），脚本日志里的读写结果与键序和 WPE 一致。
语料 `3808922316` 变干净（`objects/181` 的组合层在 `init` 里写 `thisLayer.perspective = true`，并 `createLayer` 一个带 `perspective: true`
的组合层影子）。

## 全屏组（P5j）

fullscreenlayer 带子层（全屏组）是「把一段子树按场景坐标画进一张屏幕大小的 RT，再整张贴回屏幕」。和普通组（P5b 步骤 4）只差三处：
子孙不换局部正交、开头一律拷屏幕、没有 effect 时的上屏画基础材质。

| 项 | 规则 | 依据 |
|---|---|---|
| 基础 pass | 快照 + 把当前画面整张拷进合成 RT 0，**不看 `copybackground`**（同有 effect 的 fullscreenlayer） | `p5j-a` 事件 46/47；`p5j-b`：F1 与 F2（`copybackground: false`）之间的顶层方块进了 F2 的 RT、上屏后还在 |
| 合成 RT | 场景目标尺寸（`fullscreenSize` 为 `scene`） | 实测 1920×1080 |
| 子孙的矩阵 | 和顶层对象相同：场景视图投影（缩放、抖动）、视差按根对象（全屏层自己）算、世界矩阵含全屏层的变换；不用 `groupViewProjection`（`render/scene.ts`） | `p5j-a` 的 A：缩放 0.8、角度 0.5 = 0.2 + 0.3、平移逐位对上；`p5j-cam` 的 A、N 末 pass 带 F1 的视差 |
| 子孙的混合 | 照普通组：写 RGBA，`copybackground: false` 时 alpha One / One / Max | 事件 64、148 |
| 嵌套组 | 照普通组：子层用嵌套组的局部正交，末 pass 画回全屏 RT（矩阵同上一行）；compose 用不带视差的场景视图投影，读全屏组开头的快照（P5f：直接父是组，层首不拷） | 事件 80、96、115；`p5j-cam` 的 N |
| 上屏（无 effect） | 画基础材质本身（`fullscreenlayer.json`：`passthrough` 着色器，不乘 `g_Color4`，translucent），槽 0 换成合成 RT，2×2 NDC，不拷快照；不看 `copybackground`；colorBlendMode 31 改 additive（读码 §2.6，未实测）（`render/graph.ts`） | 事件 128、161：顶点原样输出、像素只采样，SrcAlpha / InvSrcAlpha，写掩码 RGB |
| 上屏（有 effect） | 照 fullscreen 的 effect 链（NDC 正交） | 事件 200 |

**顺带更正（通用）**：嵌套在组里的组合层（普通组、全屏组一样），它的 compose 基础 pass 用不带视差的场景视图投影（缩放、抖动照带）；
顶层组合层的 compose 带视差（`p5j-cam` 的 CLP、G）。P5b 的 `p5b-nest` 没开视差、`p5b-grp-par` 的组在屏幕正中，都测不出来。语料里没有
「组里套组合层又开视差」的场景，画面不变。

计划与实测见 [phase-5j](../../../.claude/plans/wpe-import/3-scene/phase5/phase-5j-fullscreen-children.md)。

**验收**（`ignore/p5/j/`，WPE 抓帧 `A:\p5j\`）：`p5j-b`（164 帧）、`p5j-cam`（zoom 1.25、抖动、视差，204 / 205 帧）和 WPE 整帧逐像素相同
（屏蔽 FR / CLK）；`p5j-a`（209 / 210 帧）2.6% 的像素差 1：全部来自 effect pass 的 `g_Color4` 残留值（WPE 沿用上一个设过颜色的层，我们
写本层颜色，P5b `p5b-fs` 起的已知差异），测试 effect `kbfx` 加了 `g_Color4 × 0.0001` 才露出来，逐 draw 轨迹与 WPE 取像素核对过。语料
myprojects/`3814353826` 变干净；全库 233 张全部干净。

## 图像层与材质补全（P8）

P8 补的是图像层上几处还没对齐 WPE 的地方，五件事互不依赖，但都落在图像层的同一条渲染路径上：合成 RT 怎么采样、四边形怎么摆、effect 能读到哪些别的图层、管线写哪些通道。所以 P8 不新增图层种类，只在现有的图像层管线（P2a 的渲染图、P5b 改过的几何与合成 RT）上补规则。形状对象是唯一的例外：WPE 把它当图像类的子类，我们也把它接进图像层管线，而不是另写一套绘制。

依据：
- 读码：[rea-p8-layer](../../../.claude/plans/wpe-import/3-scene/phase8/rea-p8-layer.md)（形状、对齐、采样）、[rea-p8-render](../../../.claude/plans/wpe-import/3-scene/phase8/rea-p8-render.md)（依赖、自引用、写入状态）。
- 实测：[报告](../../../.claude/plans/wpe-import/3-scene/phase8/p8-REPORT.md)，11 个确定性工程加 6 张语料场景，读码覆盖到的全部吻合。推翻了三处旧说法：形状不是正方形、图像层读 `alignment`、`clampuvs` 缺省为真。
- 逐步的验收数据：[子计划](../../../.claude/plans/wpe-import/3-scene/phase8/phase-8-image-material.md)「实施记录」。下面每条只点出依据，数字和例外以子计划为准。

验收：确定性工程按 WPE 日志回放到抓到的那一帧，和 WPE 抓帧整帧逐像素比（`kbp cmp frame`，屏蔽 FR / CLK）；几何类（形状、对齐）另比四角，限值 0.01 像素；写入状态另用探针的逐 draw 轨迹读每次绘制的管线状态。

### 合成 RT 的采样（步骤 1）

| 项 | 规则 | 依据 |
|---|---|---|
| 寻址 | 只看对象的 `clampuvs`（`SceneLayer.clampUVs`）：不是 `false` 就钳制，缺键、`true`、`null` 都钳制；和基础纹理 `.tex` 的 ClampUVs 无关（原来跟着纹理，是 LWE 的做法） | 读码 §3；实测 `p8-clamp`、`p8-clamp2` |
| 过滤 | 对象 `nointerpolation: true` 或基础纹理带 NoInterpolation 时最近邻，否则线性（`graph.ts` 的 `compositeSampling`） | 同上 |
| 范围 | 池化的合成 RT 与被依赖图层的独占 RT 同一套；文本层、形状、组合层没有基础纹理，只看对象。文本的 `clampuvs` 按同一规则放行 | 读码 §3（文本、形状的虚表 +0x128 给 0） |
| 基础纹理 | 采样器不变，仍按 `.tex` 标志。WPE 用 8 倍各向异性，我们线性，只记不补 | `p8-align2` 的 F1：竖直缩放的纹理在两色交界处差到 11 |

语料里只有 `3832772446` 的一个图层因此从重复变成钳制。

### 形状对象（步骤 2）

`shape: "quad"` 的对象（`features.ts` 的 `isShapeObject`）没有基础 pass、没有合成 RT，只画最后一个 effect 的唯一绘制 pass、直接上屏（`graph.ts` 的 `planShapeLayer`）。

| 项 | 规则 | 依据 |
|---|---|---|
| 几何 | 第一个 effect 第一个 pass 的材质常量 `point0`–`point3`（含实例覆盖，`bundle.ts` 的 `shapePoints`）：顶点 `(Sx·p.x − Sx/2, Sy·(1 − p.y) − Sy/2, 0)`，uv = p，索引 (0, 2, 1, 0, 3, 2)（`layout.ts` 的 `shapeQuad`）。`Sx×Sy` 是对象 `size`，缺省是正交高 × 正交高（`shapeLayerSize`）。四个点找不到时退回以原点为中心的方块 | 读码 §1；实测 `p8-shape`、`p8-shape2`（推翻 sample-gaps §2.1 的「正方形」） |
| 画哪个 | 最后一个 effect 的那个 pass，不看 effect 的 `visible`；前面的 effect 永远不画，不预备变体 | `p8-shape2`：SA 几何取第一个、画第二个；SB 第二个写死不可见照画 |
| 强制改写 | 每个绘制 pass 的组合键在实例覆盖之后写 `DIRECTDRAW = 1`，最后一个 pass 混合强制 additive。槽 0 不预留：形状没有当前合成 RT，`previous` 等 bind 跳过，其余槽照材质的纹理与注解缺省编 | 读码 §1.5–1.7；`p8-shape` 的 S9 实例写 0 也被改成 1 |
| 矩阵 | MVP = 场景视图投影 · 视差（根对象）· 世界矩阵，不带对齐偏移；效果矩阵按读码（单位阵，`g_EffectTextureProjectionMatrix = diag(Sx/2, Sy/2, 1, 1)`） | 四角对 RenderDoc `vs_out`，最大差 8.1e-5 像素 |
| 中性 | 对象的 `alpha`、`color`、`brightness`、`colorBlendMode`、`clampuvs`、`nointerpolation`，值为 false 的 `castshadow` / `disablepropagation` | 读码；语料 24 个形状都没写前三个 |
| 照报（`features.ts` 的 `shapeIssues`，语料都是 0） | `shape:effects`（没有 effect）；`shape:effect-passes`（最后一个 effect 不是恰好一个绘制步骤，或有 fbo；WPE 的非末 pass 会解引用空指针）；`shape:uniform:<名字>`（画的程序读 `g_Color4` / `g_Alpha` / `g_Color`，WPE 不写，读到的是上一次绘制留下的值）；`shape:texture0`（读槽 0 而没有静态纹理）；透视场景里的形状 | 读码 §1.4–1.8 |

`shape:texture0` 看输出的 WGSL 判断槽有没有被读（`features.ts` 的 `textureSlotRead`）：翻译器的纹理反射不带 `unused`，`lightshafts` 在 `DIRECTDRAW = 1` 时只剩声明的 `g_Texture0` 照样列出。

### 对齐（步骤 3）

| 项 | 规则 | 依据 |
|---|---|---|
| 取值 | 9 种字符串（`compile/alignment.ts`，下标同 WPE 的跳转表）；不是字符串（含 `{user, value}`）按 `center` | 读码 §2 |
| 偏移 | `a = (±trunc(w)/2, ±trunc(h)/2)`，left +、right −、top −、bottom +（场景 y 向上，四个角两个分量都有），`size` 取 autosize / fullscreen 之后的尺寸（`layout.ts` 的 `alignmentOffset`）。偏移在模型空间：图层画自己的矩阵在本地矩阵之后右乘 `T(a)`（`drawMatrixOf`），所以 `scale` 放大它、旋转带着它转 | 实测 `p8-align`（9 种 × 有无 effect、旋转、非均匀缩放），四角最大差 1.9e-4 像素 |
| 作用到 | 上屏的模型矩阵（直接上屏、末 pass、passthrough、compose、文本）、效果矩阵与 `g_LayerModelMatrix`（缩放按浮点 `size / 2`）、组的局部正交（组的裁剪窗口跟着偏）、图像层 `perspective` | `p8-align2` 的 F2、组 G |
| 不作用到 | 子层（`worldMatrixOf` 不带它，子层只认父的变换）、视差、画进合成 RT 的基础 pass、粒子与模型；文本的子层也不带文本自己的排版偏移 | `p8-align` 的子层、`p8-align2` 的 Xc |
| 四边形边长 | 图像层按 `trunc(size)`（`layout.ts` 的 `screenQuadSize`），文本层按排版尺寸原样 | `p8-align2` 的 F3：101.7 × 50.5 上屏是 ±50.5 / ±25 |
| 运行中改 | 脚本读写 `layer.alignment`（字符串，读回字符串；写数字等落 `center`），同帧生效，重编译后重放写入 | 实测：`p8-par` 的 T 第 8 帧写数字读回 `center string`，日志和 WPE 逐字相同 |
| 照报 | `object:alignment:script`（`alignment` 挂 `{script}`，字段脚本写回枚举没做，语料 0 个） | — |

### 图层依赖（步骤 4）

WPE 的图层依赖是两件事，各自独立：一个图层「被依赖」时，它的合成链第 0 张换成按图层独占、跨帧保留的 RT；材质槽里写的 `_rt_imageLayerComposite_<id>_a` 按名字绑到这张 RT 上。

| 项 | 规则 | 依据 |
|---|---|---|
| 被依赖 | 全部对象（含模型对象）的 `dependencies` 取并集（`compile/dependencies.ts` 的 `dependencyIds`）：值是数组或对象才遍历，元素是非负整数才收；粒子对象另一套同名键的对象元素（发射图 / 碰撞模型，过三道门的 `id`，P4j 步骤 1）也进并集。命中的图像层与文本层（步骤 6）`SceneLayer.dependedOn` | 读码第 1 节；`3509243656` 的两个模型对象就给图像层置了位；粒子的那套见 rea-p4j-layerimage 1.4 第 8 条（更正 rea-p8-render「对象元素不进集合」） |
| 合成路径 | 被依赖的图层一律走合成路径（组合层没有 effect 也画），最后一个 effect 不上屏、留在合成链，最后用 passthrough 上屏：`BLENDMODE` 取 cbm ∉ {0, 31} 时的值、否则 0，混合是 cbm 31 时 additive、否则基础材质的，UV 内缩同末 pass，`g_Color4` = 1。排完后最后一次写入落在合成 RT 1 时整份计划的 0、1 对调（`graph.ts` 的 `swapCompositeIndices`），让它落在第 0 张 | 实测 `p8-dep` 的 A2、A9、A11；`p8-dep` 的上屏 UV 是 0.15 / 64，读码 2.4 写的「不内缩」不对 |
| 独占 RT | 建场景时每个被依赖的图层建一张（`scene.ts` 的 `layerTargets`，尺寸、格式、采样同它的合成 RT），跨帧、跨 effect 开关的重建都保留、不清；它就是本层的合成 RT 0，其余张照旧从池里借 | 读码 2.2；实测 `p8-dep` |
| 不可见 | 自身或祖先不可见时照画进 RT、只跳过画到「场景」的那一步上屏，在组里也一样（`scene.ts` 的 `layerOpsToRun`）；写死不可见也建资源（`buildableLayers` 的例外）；不做视锥剔除 | 实测 `p8-dep2` 的 A11 / A12、`p8-misc` 的 A13（隐藏的组合层）/ A14（放在画面外） |
| 绘制顺序 | 不改。被依赖者排在引用方后面时，引用方读到的是上一帧 | 实测 `p8-dep` 的 B3：第 160 帧读到第 159 帧的颜色 |
| 引用 | 编译期一次定下名字表（每个图像层的 `_rt_imageLayerComposite_<id>_a`），材质 `textures` 或注解 `default` 写的名字指向被依赖图层时记进 `ScenePass.layerComposites`，渲染图给出纹理来源 `{ kind: "layer", object }`，四种计划（图层、形状、粒子、网格）都认。`bind` 占了的槽 `bind` 胜出 | 读码 2.1、第 3 节 |
| 棋盘格 | 解析不到的名字（没被依赖、id 不存在、不是图像层、`_b`）绑 6×6 黄黑棋盘格（`checkerTexture`：第一格黑，点采样、重复） | 实测 `p8-dep` 的 B4–B6 逐格对上 |
| 格式 | 引用槽的 `TEX<n>FORMAT` 取材质创建那一刻纹理表里的格式：经依赖置位的 RT 在全部材质之后才建，是 0；被依赖者自己就有 cbm 混合、排在引用方前面时，HDR 下是 14；LDR 一律 0 | 读码 2.2；语料里都是 0 |
| 文本层（步骤 6） | 同图像层：名字表收文本层，合成链第 0 张是独占 RT。尺寸跟排版（`textCompositeSize`），被依赖时排版加 `padding`（WPE 看 `0x10`，`TextFields.dependedOn`）。重排换尺寸时当帧换新 RT（初值全 0）、当帧重绑引用方（`syncTexts` → `rebindDependents`），排在前面的引用方这一帧读到全 0；空文字不画，RT 换成 4×4 | 实测 `p8-deptext`（50 帧，第 280 帧换宽度与清空）整帧 0 差异；`3837779440` 的复制工程整帧 0 差异 |
| 组（步骤 7） | 被依赖的组（有子层的组合层）同图像层：组的合成链第 0 张是独占 RT，装 compose（拷屏或清空）+ 子树 + effect 链的结果，可见时再上屏。组隐藏（写死或属性）时照画基础 pass 与 effect 链、不上屏，`subtree` 照跑但子层按各自的可见性（祖先隐藏 → 不画），本身被依赖的子层照画进自己的 RT、不画进组的 RT（WPE 子层的 `+0x68`）。没有新代码：渲染图与 `layerOpsToRun` 本来就这么排，只是编译期不再报 `dependency:group` | 实测 `p8-depgroup`（七种组合：可见、写死隐藏、属性隐藏、`copybackground: false` + effect、隐藏 + effect、组 → 纯色层 → 孙子、隐藏组里的被依赖子层）三帧整帧 0 差异；`3811403844` 的复制工程（「蒙版」组整棵子树 + 读它的两张底图，斜线跟光标的脚本保留）按录制光标三段 15 帧：遮罩 RT 0 差异，余下最大差 2 / 1 / 4 都是 foliagesway 舍入（pulse 放大），见 phase-8「走查 `3811403844`」 |
| 照报（语料都是 0） | `dependency:self`（被依赖的图层在自己的 pass 里读自己的 `_a`）、`dependency:passthrough-undeclared`（名字指向没被依赖、但自己有 cbm 混合的图层，WPE 绑得上） | 读码 |

dev 探针只画固定时刻的一帧（不给 `replay`）时，独占 RT 里没有上一帧的内容，排在被依赖者前面的引用方读到全 0；和「排在后面读上一帧」对照时给 `replay`（P10a 起回放的每一帧都编码），两帧就够。

### 写入状态（步骤 5）

WPE 的设备有一个「写不写 alpha」的状态：稳态不写，进合成路径时打开、上屏前关掉；材质 pass 的 `alphawriting` 在绑定时改它。`alphatocoverage`（混合模式 3）是混合关、`AlphaToCoverageEnable` 开，写掩码与深度照 `normal`。

| 项 | 规则 | 依据 |
|---|---|---|
| 写不写 alpha | 在 `stepPipeline` 按目标、组与上屏角色算出的缺省值上叠材质的取值（`render/writeState.ts` 的 `writesAlpha`）：上屏角色（`final` / `passthrough`）不看材质，WPE 绑定后强制改回；`copybackground: false` 的组里强制写；其余 `enabled` 写、`disabled` 不写、`default` 与没写一样。`ScenePass.alphaWriting` 只在 `enabled` / `disabled` 时有 | 读码 4.3–4.4；`p8-alpha` 九种组合、`p8-misc` 的 W1，逐 draw 的写掩码全部对上 |
| `disabled` 的结果 | 不写的 alpha 保留目标原值：fbo 是上一帧或清屏值，合成 RT 是上一个用这张池化 RT 的图层写的 | 实测 `p8-alpha` 的 Z |
| A2C 的状态 | 混合关（`blendState` 对它返回不混合）、写掩码同 `normal`、深度写同 `normal`（`rasterState`） | 读码 4.1、5.2–5.3 |
| A2C 的组合键 | 混合是 `alphatocoverage` 的材质 pass 编译时加 `ALPHATOCOVERAGE = 1`（`compile/writeState.ts` 的 `materialCombos`），`genericimage4` 等据此把 alpha 锐化成以 0.5 为中心的阶跃。WPE 上屏时把基础材质的混合拷给最后一个 effect pass，组合键可能也带上，但 WPE 自带 effect 与语料的着色器没有一处读它，所以只按 pass 自己的混合加 | 读码 5.4 |
| A2C 的覆盖 | WPE 用户设置 `msaa: none` 时场景目标单采样，A2C 实测是「alpha ≥ 0.5 + 2⁻¹²（2049/4096）才写入」的硬阈值。WebGPU 只能在多重采样目标上开 A2C，所以在片元着色器里丢弃：给程序的片元模块追加入口 `kb_a2c_<入口>`（`programs.ts` 的 `alphaToCoverageEntry`，原入口的逐字副本，每个 `return X;` 前判断位置 0 输出的 alpha，`!(a >= 0.500244140625)` 就 `discard`（`A2C_THRESHOLD`）），主体不动、丢弃在导数之后 | 实测 `p8-a2c`：alpha 0.4995 不画、0.5005 画，对象 alpha 0.5 的一列都没画；三条渐变逐像素相同。P13d 的 `p13d-a2cth*` 把阈值细分到 2⁻²²：0.5 + 2⁻¹² 画、再小 2⁻²² 就不画；双线性过滤在 0 / 1 两个纹素正中返回 0.5 ± 2⁻¹⁷，锐化后约 0.500015，原来的 `> 0.5` 会多画格子边（p13-REPORT） |
| 哪一步开 | 步骤的实际混合是 `alphatocoverage` 就开（`alphaToCoverage`），包括借基础材质混合的上屏 pass 与 passthrough、粒子、网格；画进合成 RT 的基础 pass 混合是 null，不开，写的是锐化后的 RGBA。上屏的是哪个 effect pass 要到运行时才定，所以按管线开关：A2C 模块按程序在第一次需要时才建（`GpuProgram.alphaToCoverage()`），管线键加 `\|a2c`，别的管线与模块逐字节不变 | 实测 `p8-misc` 的 W2（整帧 0 差异）；语料 `3783690410` 的 `xray` 末 pass |
| 照报 | `material:alphawriting`：`default` / `enabled` / `disabled` 以外的取值（WPE 映射表只有这三个，语料 0 个）；改写认不出入口结构时 `render:program:<下标>:a2c`（语料与默认工程 522 个片元程序全部认得出） | — |

### 已知差异与只记不补

- **基础纹理的各向异性**：WPE 用 8 倍各向异性，我们线性；只在竖直方向缩小的纹理的颜色交界处有差（`p8-align2` 的 F1，最大 11）。
- **effect 中间 pass 的 MVP**：我们给单位阵（P2a 的做法），WPE 给的值不同。WPE 自带的 effect 中间 pass 都直接用 NDC 坐标、不读它，只有自写的测试工程乘了它（`p8-alpha` 的 X 组：WPE 的 fbo 里一个像素都没画，我们铺满）。
- **被依赖图层的 effect 开关**：WPE 切换时销毁重建独占 RT、新 RT 不清（读码，没实测）；我们跨重建保留。
- **A2C**：`msaa: x2`（WPE 的缺省）下 A2C 按 alpha 分样本，我们没有多重采样，只做单采样的硬阈值；组的 alpha MAX 与 A2C 并存、粒子 A2C 语料都是 0 张，只有单测。
- **形状**：多 pass 的 effect、透视场景照报，没测。

### 语料与解锁

| 步骤 | 去掉的键 | 新增的键 | 能渲染 | 新解锁 |
|---|---|---|---|---|
| 1 合成 RT 的采样 | `object:clampuvs` 15 张、`object:nointerpolation` 3 | — | 47 → 48 | `3668499717` |
| 2 形状对象 | `object:shape` 18 | — | 48 → 53 | `3656079027`、`3811764016`、`3812887609`、`3819646765`、`3821678218` |
| 3 对齐 | `object:alignment` 24、`script:api:layer.alignment` 3 | — | 57 → 57 | — |
| 4 图层依赖 | `object:dependencies` 9、21 个 `texture:rendertarget:_rt_imageLayerComposite_<id>_a`（9 张） | — | 66 → 66 | — |
| 5 写入状态 | `material:alphawriting` 7、`blend:alphatocoverage` 2 | — | 87 → 87 | — |
| 6 被依赖的文本层（2026-11-19） | `dependency:text` 1（myprojects `3837779440`，不在缺省语料） | — | 232 → 232（233 张） | `3837779440` |
| 7 被依赖的组（2026-11-20） | `dependency:group` 1（myprojects `3811403844`，不在缺省语料） | — | 234 → 235（235 张，含 myprojects 两张） | `3811403844` |

- 各步的起点不同，是同期别的 Phase 也在解锁；语料从 173 张变成 183 张。没有场景因 P8 不再能渲染。
- 收尾时（2026-11-14，183 张）用到 P8 任一项的 57 张场景里，能渲染 10 张，和 P8 有关的键一个都不剩；其余 47 张还差场景脚本的回调与 API（三十多张）、关键帧动画（25）、用户纹理（20）、木偶动画（15）、图像层帧动画（13）等。`3812487163` 去掉对齐后还差 P6 的 `thisScene.createLayer` / `sortLayer`。
- **和 WPE 比**：
  - 确定性工程：`p8-clamp`、`p8-clamp2`、`p8-dep2`、`p8-misc` 0 差异；`p8-dep` 只差 B3（探针只编码读回那一帧，先编码上一帧后相同）；`p8-align` 最大差 1，`p8-align2` 只差 F1 一行（各向异性）；`p8-shape` 最大差 6，`p8-shape2` 最大差 2；`p8-a2c` 三条渐变 0 差异；`p8-alpha` 除 X 组（见上）都是 0。
  - 解锁的 6 张各解包加日志、抓一帧按日志回放比：差 > 32 的像素占 0.02%–0.65%，在随机粒子与 4K 缩放的轮廓上；形状光束按 WPE 的 `vs_out` 分里外算，没有缺失或错位。
  - 语料里有依赖的 9 张：引用 pass 全部绑到对应的独占 RT、没有一处是棋盘格；`2251857160`、`3554161528`、`3276911872`（打开引用方后用逐 draw 轨迹核对）强制渲染没有校验错误。A2C 的 `3611425904`、`3783690410` 强制渲染没有校验错误。

### 对比台

在 `ignore/p8/` 下：
- 确定性工程：`gen_p8.py`（自写 `.tex` 与 effect，没走 `kbp gen`），工程在 `proj/`；
- 读数：`rdc_dump_p8.py` 在 `qrenderdoc --python` 下导出每次绘制（含直接读 D3D11 输出合并状态的 `AlphaToCoverage`），`show.py`、`ana_align.py`、`check_align.py` 摘要；
- 语料：`scan_p8.py` → `out/scan.json`（P8 各项的逐条清单），`sum_p8.py`、`ana_p8.py`、`rtref.py`；收尾的覆盖数是 `s5/coverage.py`；
- 各步的快照、补丁、变异清单、语料回归与整帧比对在 `s1/`–`s6/`；
- WPE 参照在 `A:\p8\`。

## 图像层帧表（P6e）

WPE 的图像层帧表（sprite sheet）不是图层的动画，而是**纹理的动画**：帧表纹理自己带一份共享计时器，同一张 `.tex` 的所有材质共用，只在绑定时推进。P6e 照这个做，另带上脚本的 `ITextureAnimation`、一张 `.tex` 里多张图像的帧表，以及文本 `anchor`（anchor 写在 [TEXT.md](TEXT.md)「文本对象」一节的表里）。计划、步骤 0 的 WPE 实测与分步记录见 [phase-6e-sprite-sheets.md](../../../.claude/plans/wpe-import/3-scene/phase6/phase-6e-sprite-sheets.md)，读码见同目录的 `rea-p6e-sheet.md`（exe 侧）、`rea-p6e-script.md`（dll 侧）。

### 编译

| 项 | 规则 | 依据 |
|---|---|---|
| 帧表进 bundle | 头标志带帧表位的纹理都有 `SceneTexture.frames`（`compile/bundle.ts` 的 `sheetFrames`）：TEXS 版本、格尺寸 `cell`、f32 逐帧累加的 `total`，每帧 `{frametime, image, rotation, translation}`。`rotation = (width/W, widthY/H, heightX/W, height/H)`、`translation = (x/W, y/H)`，W、H 是这一帧所在图像的第 0 级 mip，f32 精确除法；`image` 越界或那张图像没有 mip 时 6 个坐标为 0（同 WPE 读入） | 读码 2.2；`p6e-tex` |
| 格尺寸 | TEXS0003 头里的格宽高，版本 < 3 时取图像宽高（WPE `tex+0xb0 / +0xb4`）。槽 0 是帧表时，图层的 `autosize` 与合成 RT 都取它 | 读码 5.3；`p6e-tex` 的 24×24 |
| 四边形 UV | 槽 0 是帧表且版本 ≥ 3 时，直接上屏的 UV 取 (1, 1)（`render/graph.ts` 的 `directUv`）；合成路径的基础 pass 照旧按「图像 / 纹理」缩。读码说带 effect 时也取 (1, 1)，实测相反：NPOT 帧表带 effect 时 WPE 只画出格的左上一块（`p6e-tex` N2），照实测做，语料用不到 | 读码 5.2；实测 |
| 能力表 | 帧表纹理不再报 `tex:animation`；`SPRITESHEET` 移出引擎 COMBO（它是材质 JSON 自己的 COMBO，大小写都有，`genericimage*` 用两个帧 uniform 自己算 UV，引擎只给粒子与 puppet 纹理通道写）；`getTextureAnimation` 移出缺失 API 表。空帧表照报 `tex:animation:empty`；FreeImage 形态的多图像帧表报 `tex:animation:multi-image:freeimage`（语料没有） | 读码 5.1 |

### 共享计时器（`render/sheets.ts` + `GpuScene.bindSheets`）

- **状态**：每张帧表纹理（按 bundle 纹理下标）一个 `SheetClock { frame, time, lastFrame }`，挂在 `GpuScene` 上、第一次画到时建（WPE 纹理基类构造清 0）。单对象重编译与运行中建层不换 `GpuScene`，计时器接着走；整场重新加载时从 0 开始。
- **推进时机**：在编码闭包里所有早退（不可见、空网格、粒子没有存活数等）之后调 `bindSheets`。到这里这个 draw 一定会画，就是 WPE「绑定时推进」的那一刻；「会不会画」和编码用的是同一套判断，不另写一份。本渲染帧第一次绑定（`lastFrame` 不等于本帧号）用本帧的 `g_Frametime` 推进，同帧再绑定不动。没有 draw 画到的帧既不推进也不补时间。所以同一张纹理的两个图层一隐一显时，隐的回来与显的同格；两个都隐时，回来接着隐藏前那一格走（`p6e-shared` 实测）。
- **推进算法**（`advanceSheet`，读码 2.4，全部 f32）：
  - **每次最多一格**：`time += dt`，`time ≥ 当前格帧时长` 才进格，`time -= 旧格帧时长`、越界回 0，最后 `time = min(time, 新格帧时长)`。帧时长小于帧间隔时卡在「每个渲染帧一格」，多出的时间截掉，总是循环；
  - `dt < 0`（只有脚本 `rate` 为负）对称地退格；
  - 帧号越界（脚本 `setFrame` 写进来的）时，判断取第 0 格的帧时长。
- **写 uniform**：draw 上每个帧表纹理槽 `s` 写 `g_Texture<s>Rotation` / `Translation`（程序声明了才写）；`g_Texture<s>Resolution` 仍是头尺寸。效果链、组、puppet 里用到同一张纹理的 pass 同帧共用一格。
- **粒子**：粒子 draw 也走 `bindSheets`（WPE 的粒子材质同样经这一个绑定函数），会推进这张纹理的共享计时器。粒子着色器不读这两个 uniform，粒子各自的格仍由模拟器的 frame 列定（P4b）。
- **`SPRITESHEET` 打开而槽不是帧表**：渲染器给恒等帧（`render/uniforms.ts`）。

### 脚本 `ITextureAnimation`（`script/api.ts` + `SceneState.textureAnimations`）

- **取得**：图像层的 `getTextureAnimation()`。槽 0 是帧表时第一次调用建对象，否则返回 `null`（纯色层也是 `null`），文本层没有这个方法。它和 `getVideoTexture()` 共用一格：先建的那个两边都返回它（帧表图层上先调 `getVideoTexture()` 得 `null`，之后两者是同一个对象）。
- **形状**（`p6e-api` 实测）：
  - 每个对象一个自己的原型，只有不可枚举的 `constructor`（`name` 为空串），再往上 `Object.prototype`；
  - 自有成员按 `frameCount, duration, rate, play, isPlaying, stop, pause, setFrame, getFrame, join, getAnimation` 排；
  - `frameCount` / `duration` 只读，严格模式赋值抛 `TypeError`，文案同 WPE；
  - `rate` 只收 JS number、存 f32（`0.1` → `0.10000000149011612`、`1e40` → `Infinity`）；
  - `setFrame` 只收 int32，`2.5`、`'2'`、`true`、`NaN`、不传等都当 0，`-1`、`999` 原样。
- **脱离与并回**（读码 3.3、3.4）：对象默认跟着共享计时器。`pause` / `stop` / `setFrame` / 写 `rate ≠ 1` 让这个图层脱离：
  - 之后每帧在对象更新循环里（脚本之前，不看可见性）按 `g_Frametime × rate`（f32）推进私有的 `{frame, time}`（`advanceTextureAnimations`）；
  - 画这个图层时，整次绘制里的帧表一律画私有帧号：越界画第 0 格，负数改走共享计时器；脱离的图层不推进共享计时器；
  - `join()` 并回；`rate` 写回 1 不并回。
- **状态**：在 `SceneState.textureAnimations`（WPE 的私有对象 A），跨单对象重编译与整场重载接回（宿主 `adoptTextureAnimations`）；图层删除、槽 0 换成用户纹理时清掉。
- **作废**：图层删除生效后读写都是 `undefined`、方法不调，`isObjectValid` 为假（同 `IAnimationLayer` 的属主作废）。

### 多图像帧表

- **编译**：一张 `.tex` 里有多张图像时，第 0 张仍在 `mips`，其余在 `SceneTexture.images`（`extraImages`），Worker 一起转移（`textureBuffers`）。
- **GPU**：每张图像一张 GPU 纹理（`GpuScene.extraTextures`）。绑多图像帧表的 draw 记下这些槽（`Draw.multiImage`），`bindSheets` 选格后记下这一格的图像号，bind group 按「fbo 状态 + 各槽图像号」缓存（`imageKey`），所以这类 draw 一律是动态的；平面反射的副本同样按图像号取（`reflectionGroupOf`）。
- **显存**：按图像数线性涨，语料里单张约 7680×7920 DXT，`3577990983` 一张有 5 张图像。

### 有意不同与已知差异

- **越界帧号倒播**：WPE 退格后帧号仍越界时读越界内存（未定义），实测每帧减 1；这里按「越界格的帧时长取 0」实现，结果同实测。语料不用。
- **`SPRITESHEET` 配非帧表纹理**：WPE 读上一次绑定留下的 uniform，我们给恒等帧，语料 0 处。
- **`general.spritesheetrefreshsync`**：只影响帧数统计，不做、不报。
- **属性描述**：`frameCount` / `rate` 在 WPE 是数据属性，我们是访问器，为了作废后读到 `undefined`（同 `IAnimationLayer`）。
- **槽 0 换成用户纹理之后**：WPE 的 `getTextureAnimation()` 返回 `null`；我们按 bundle 判断仍是帧表，会再建一个对象。语料没有这种用法。
- **整场重新加载**：共享计时器从 0 开始（脱离状态接回）。
- **文本 `anchor`**：见 [TEXT.md](TEXT.md)「文本对象」一节的已知差异（运行中改的时机、带 effect 的文本）。

### 对照与语料

- **和 WPE 比**（dev 探针，`canvas` 1280×720，dt 取 WPE 日志逐帧的 `engine.frametime`；工程在 `ignore/p6/e0/proj/`，WPE 抓帧与日志在 `A:\p6e\`、`ignore/p6/e0/out/`）：
  - `p6e-rate`（帧时长 0.1 / 0.02 / 0）：帧表图层五帧 0 差异；
  - `p6e-tex` 单图像的五层（NPOT、TEXS0002、旋转帧、`autosize`、带 effect 的 NPOT）0 差异；含两张图像的完整 `p6e-tex` 八帧整帧 0 差异，脚本日志 208 行逐行相同；
  - `p6e-shared` 七帧整帧 0 差异，日志 237 行逐行相同；
  - `p6e-api` 378 行日志 376 行相同（两行见上：模块顶层的 `thisLayer` / `thisObject` WPE 是 `null`，是脚本运行时原有的差异；属性描述）；脱离图层六帧整帧 0 差异；
  - `p6e-anchor`（十种 anchor）在五种窗口尺寸与对齐方式下、`p6e-anchor2` 在两种窗口下，文本全部 0 差异。
- **语料**（233 张）：能渲染 199 → 223，P6e 解锁 21 张，另 3 张是同期别的会话修的。分步：
  - 第 1 步 6 张：`2833017810`、`2916324703`、`3420277613`、`3662390671`、`3811424158`、`3818053626`；
  - 第 2 步 8 张：`3286859278`、`3319542538`、`3326873240`、`3400241651`、`3516174947`、`3524852519`、`3570560686`、`3826860299`；
  - 第 3 步 5 张：`dino_run`、`2981249186`、`3351163962`、`3560756264`、`3643916956`；
  - 第 4 步 2 张：`3000562427`、`3486806915`。`3577990983` 帧表这边全过，只剩 `puppet:draw-order`。

  全库已没有帧表与锚点的键，每一步都没有新增键、没有场景掉出。
- **编译产物**：全语料在「HEAD」与「HEAD 减去 P6e 四个提交」两份源码上各编一次（同一个翻译器 wasm，`ignore/p6/e5/`），101 张不同：
  - 79 张只差帧表纹理上新加的 `frames`（多是粒子的帧表），去掉这个字段后逐字节相同；
  - 另外 22 张是不支持集合变了的（解锁的 21 张与 `3577990983`）。编译照常解码纹理、读视频时长，帧表纹理多了 `frames` / `images`，帧表图层的 `size` 换成格尺寸。
  
  程序、材质、绑定等其余字段全部相同。
- **脚本**（`scriptCorpus`，和 L7 收尾的基线比）：P6e 带来的变化只有 `getTextureAnimation` 能调了。原来报 `is not a function` 的脚本段都跑完 120 帧；`3560756264`、`3826860299` 的 `stateDigest` 因此变了。唯一的新报错在 `3400241651`：puppet 图层「7腿」动画层 `rate` 上的字段脚本调 `thisLayer.getTextureAnimation().getFrame()`，那个图层槽 0 的纹理不是帧表，返回 `null` 后读 `getFrame` 出错。WPE 同样返回 `null`，作者脚本在 WPE 里也报这个错。其余不同的场景都归到同期别的提交（P5f、P13h、P13i、P5g、P7 补漏、P11b2）。
- **画面**（全库画面哈希 3 档，和 L7 收尾的基线比）：对上 216 张，199 张逐字节不变，变了 17 张，每张都有证据：
  - **P6e 解锁的 10 张**：dino_run、`2833017810`、`2916324703`、`3286859278`、`3420277613`、`3570560686`、`3643916956`、`3811424158`、`3818053626`、`3826860299`；
  - **环境与输入**：WPE 的 `reflection` 设置在 L7 之后被改开。`audiophile` 用 `reflection: "disabled"` 渲染，三档逐字节复现 L7；`fantasticcar`、`3808922316` 另有用户改过的属性值，用 L7 时的属性值加反射关同样逐字节复现；
  - **预热封顶**（`bde7b148`）：`1923929928`（星空 `starttime: 100`）、`3829467967`（萤火虫）。编译产物与 WGSL 在 L7 与 HEAD 之间相同；在 Node 里按提交回放粒子，两张都正好从这个提交起变（前者 45 帧后存活 2002 → 1446），P6e 的提交不改变它们；
  - **别的阶段解锁的**：`3453730450`（编译产物在 P13g、P13h 上变）、`2515018199`（P13g、P13j-2）。
  
  P6e 给粒子帧表纹理加了 `frames` 的 79 张里，两边都有记录的 72 张画面不变的 70 张，变了的就是上面最后两张。另有 12 张视频场景两次都因探针 10 s 内等不到视频第一帧而没比，L7 时同样。
