# P13j — 预光照（`PRELIGHTING`）

总计划：[phase-13ij-spot-prelighting.md](phase-13ij-spot-prelighting.md)（决定 4：触发条件照 WPE 改成 `LIGHTING` 或 `REFLECTION`）。读码线索：[lighting-REPORT.md](../lighting-REPORT.md) 第 2、4 节，[../phase12/rea-p12-mdl.md](../phase12/rea-p12-mdl.md) 9.3「预光照」一行，[rea-p13-lights.md](rea-p13-lights.md) 雾一节；本节补读的汇编在 `ignore/p13/j/rea/asm/`。

## 总体设计思路

开了光照（或反射）的图层走合成路径时（有 effect、colorBlendMode 混合、被依赖、开雾），WPE 不在上屏时算光，而是在基础 pass 画进合成 RT 时就算：基础材质加 `PRELIGHTING=1`，着色器的世界位置、法线、反射用的屏幕坐标改用三个「图层在场景里」的矩阵 `g_AltModelMatrix` / `g_AltNormalModelMatrix` / `g_AltViewProjectionMatrix`，写进 RT 的位置仍用 RT 的 MVP。effect 处理的是打过光的画面，上屏 pass（effect 的末 pass 或 passthrough）本来就不带光照。

实现照这个形状：编译期对这类图层的基础 pass 另编一个 `PRELIGHTING=1` 的变体；渲染器画这个基础 pass 时多写三个矩阵：AltModel = 图层世界矩阵，AltNormal = 它逐行快速归一化（同 `g_NormalModelMatrix`），AltVP = 这个图层上屏用的场景视图投影（含视差与相机）。puppet 另有一处：WPE 预光照时基础 pass 画的不是四边形而是 puppet 网格——光照按蒙皮后的姿势算，写进 RT 的位置用没蒙皮的原始位置（`genericimage2` 直接用 `a_Position`，`genericimage4` 用 `PRELIGHTINGDUALVERTEX` 读 `a_PositionC1`，WPE 给它的就是原始位置的拷贝），上屏仍按骨骼用网格采样 RT。

关键决策：
- 拆两步：P13j-1 普通图层（`3662790108` 的 L、`3400241651` 的 R 都是这类），P13j-2 puppet（`2515018199`）。P13j-1 做完先报。
- 雾不动：预光照的基础 pass 没有 `FOG_COMPUTED`，genericimage 系在 `LIGHTING` 分支里不算雾，雾仍在上屏 passthrough 上（P13f），步骤 0 实测确认。
- 纹理降级系数 `g_TextureReductionScale` 我们恒为 1，AltModel 的「乘降级系数」分支不做；instanced 层（模型标志 `0x800`）的「乘 size / 纹理尺寸」照做。

## 步骤 0：读码（2026-11-18）

- **AltVP**（`FUN_140206430` = 图像层绘制入口，`0x14020652a`）：`+0x4b0`（预光照标志）为真时，把此刻的 `ctx+0x930`（场景 VP，脏了先 `FUN_1400d4200` 重算）拷进 `ctx+0xab0`，然后进基类绘制 `FUN_1401e8aa0`。所以是这个图层上屏用的 VP（含逐对象视差）。
- **AltModel**（`FUN_140207b50` 画进合成 RT 的分支，`0x140207da7`）：`ctx+0xa70` = 图层世界矩阵（虚函数 `+0x80`）；模型标志 `0x800`（instanced）时行 0、行 1 再乘 `size.x / 图像宽`、`size.y / 图像高`；`ctx+0x1218`（`g_TextureReductionScale`）> 1 且纹理不是视频时行 0、行 1 再乘它。
- **AltNormal**（`FUN_1400d8300` 的 0x10，`0x1400d8aab`）：AltModel 三行各自快速倒数平方根归一化（`0x5f375a86` + 一次牛顿），同 `g_NormalModelMatrix`。
- **预光照材质**（`FUN_140209563`，`0x140209822` 写 `PRELIGHTING`）：基础材质 + `PRELIGHTING=1`；蒙皮 puppet 另加 `SKINNING`、`BONECOUNT`、`PRELIGHTINGDUALVERTEX`、网格格式含 `0x10000` 时 `MORPHING`（再看网格标志 bit13 加 `MORPHING_MODIFIERS`），没有 `SKINNING_ALPHA`，`cullmode: nocull`（rea-p12-mdl 9.3）。条件：材质标志 `+0x1fc & 0x18`（LIGHTING / REFLECTION）且走合成路径。
- **着色器**（WPE `genericimage2/3/4.vert`）：`PRELIGHTING` 时 `M_MDL/M_NML/M_VP` 换成三个 Alt 矩阵，光照与 `v_ScreenPos` 按它们算，最后 `gl_Position = position · g_ModelViewProjectionMatrix`（`genericimage4` 的 `PRELIGHTINGDUALVERTEX` 时 `position = a_PositionC1`）；片元着色器没有预光照专属代码。

## 步骤 0：实测

- **语料分布**（探测快照 `ignore/p13/j/probe`，`probe_keys.py` 把照报细分，`corpus-probe.json`）：`3662790108` 普通图层 LIGHTING + effect；`3400241651` 普通图层只有 REFLECTION + effect + colorBlendMode（现在不报，卡在 `script:api:layer.getTextureAnimation`）；`2515018199` puppet LIGHTING + REFLECTION + effect。
- **Artorias 抓帧**（`A:\p13j\artorias\`，`ignore/p13/j/consts/artorias.json`）：部件 5 的基础 pass（事件 332）画 26391 个索引的网格进 2811×1725 的合成 RT，顶点缓冲步长 64，`POSITION1` 与 `POSITION0` 逐字节相同、`genericimage2` 没用它；`g_AltModelMatrix` = 世界矩阵（平移 1872.46, 853.25），`g_AltNormalModelMatrix` 对角 0.998308（快速归一化），`g_AltViewProjectionMatrix` = 场景 VP，上屏（事件 398）的 MVP = AltVP · W 逐位对上。
- 待测（确定性工程 `ignore/p13/j/gen_j.py`）：普通图层 LIGHTING / 只有 REFLECTION / 遗留灯，effect / colorBlendMode / 开雾三种合成原因，带父对象的旋转缩放；与去掉 effect 的同一图层对照。

## 实施（P13j-1 普通图层）

### 点 1 — 编译：基础 pass 的预光照变体（`compile/bundle.ts`）
- **修改** 触发条件：基础 pass 程序开 `LIGHTING` 或 `REFLECTION`、且走合成路径，并且不是 puppet（puppet 在 P13j-2 前仍照报 `lighting:prelighting:puppet`）。
- **新增** `SceneLayer.prelit?: ScenePass`：基础材质 + `PRELIGHTING=1` 编的变体（同 key 加后缀）。
- **删除** `lighting:prelighting`（普通图层）与那条 `TODO:[WPE_SCENE]`。

### 点 2 — 渲染：基础 pass 用变体、写三个 Alt 矩阵（`render/graph.ts`、`render/uniforms.ts`、`compile/features.ts`）
- **修改** 合成路径的基础步骤：图层有 `prelit` 时用它代替 `layer.passes[0]`。
- **新增** `drawMatrices` 的 `base` 角色在预光照时多给 `altModel`（世界矩阵，instanced 乘 size / 图像尺寸）、`altViewProjection`（图层上屏的视图投影）；`staticBuiltins` 写 `g_AltModelMatrix`、`g_AltNormalModelMatrix = normalMatrix(altModel)`、`g_AltViewProjectionMatrix`；进 `LAYER_UNIFORMS`（随变换就地刷新）。
- **修改** 三个名字从 `UNREAD_UNIFORMS` 移进引擎 uniform 表。

## 实施记录

### P13j-1 普通图层（2026-11-18）

- 按点 1、点 2 实现：编译期 `imageMaterials` 留下每个图像层基础材质 pass 0 的原文，触发时同 key 重编 `SceneLayer.prelit`（`PassContext.prelit` 放行 `PRELIGHTING`，重复登记的绑定截掉）；渲染图的基础步骤用它并标 `DrawStep.prelit`；渲染器给这一步的四边形与整面正交按 `compositeSizeOf`，`drawUniformValues` 带 `alt`（`prelitModel`：instanced 乘 size / 图像尺寸），`staticBuiltins` 写三个 Alt 矩阵、`LAYER_UNIFORMS` 随变换刷新。puppet 仍报 `lighting:prelighting`。
- 确定性工程 `ignore/p13/j/gen_j.py`（tint 的 `alpha` 设 0.3，缺省 1 会把颜色整个换掉、看不出光照）+ `gen_j_inst.py`，抓帧 `A:\p13j\{fx2,tilt2,cbm,fog2,legacy2,inst}`：fx、cbm、legacy、inst 与 WPE **逐像素相同**，tilt 3 个、fog 2 个孤立像素差 1。普通图层的光照按图像尺寸（这里 32×32）的四边形算，画面上明暗变化很小（WPE 同样）；instanced 的 `p13j-inst` 光照铺满整个图层，验证了 AltModel 的缩放。抓帧常量：AltModel = 含父链的世界矩阵、不乘 `size`，AltNormal = 0.9542453 / 0.2951826 / 0.9983081（快速归一化）。
- 单测 `compile/p13j.test.ts`（变体的编法与触发条件、Alt 矩阵的写法），`lights.test.ts` 两个旧的照报用例改成「编了变体」；相关 13 个测试文件全过，tsc 0 error。
- 语料（「HEAD」与「HEAD + P13j-1」两份快照，`ignore/p13/j/corpus-{head,mine}.json`）：只有 `3662790108` 去掉 `lighting:prelighting`（还缺 9 个材质文件），没有新增键；干净 223 不变。`3400241651` 的只开反射的图层现在会走预光照（没有法线图，画面不变）。
