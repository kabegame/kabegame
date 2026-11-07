# `#require LightingV1` 调查与实现

WPE 2.8.42，`wallpaper64.exe` SHA-256 `40e2ce02…93b0`（与 p2-REPORT 同一二进制）。地址都是 Ghidra 虚拟地址。

置信度：**已确认** = 反编译 / 汇编直接读到，且有 WPE 实测；**静态** = 只读到代码，没有单独实测；**实测** = 只有实验，没读到代码；**推断** = 由前两者推出。

## 结论

- `#require LightingV1` 是**预处理期现场生成源码**的指令，不是文件引用。`LIGHTING` 为 0 时什么都不插，这解释了 78 张场景为什么只是被一行空指令挡住。
- 库里只有灯光 uniform 和 `PerformLighting_V1`，逐灯计算全部在公开的 `common_pbr_2.h`。我们按公式另写了生成器，**没有用到二进制里的字符串**。
- 灯数来自 `general.lightconfig`，**不是数灯对象**。本机 117 个场景工程全部没有这个键。
- **语料里没有一张真的开了光照**。这次改动的实际效果是去掉一个假阻塞，真实光照路径是按 WPE 实现并对比通过的，但目前没有真实场景走到。
- **没有场景因此完全解锁**：78 张里每张至少还差 6 项，其中非中性项最少 1 项（`tex:format:9`）。

## 1. `#require` 的处理流程

| 结论 | 置信度 | 证据 |
|---|---|---|
| 预处理器 `FUN_14016b0e0` 遇到 `require` 调生成器 `FUN_140169140(名字, 宏表, 输出)`，输出非空时原地插进源码 | 已确认 | `FUN_14016b0e0.c` 的 `memcmp(…,"require",7)` 分支 |
| 生成器只认 `LightingV1`，并要求宏表里 `LIGHTING` 存在且 `atoi` 非 0；否则输出为空 | 已确认 | `FUN_140169140` 开头；`lt-tex`（`LIGHTING=0`）与 WPE 逐像素一致 |
| **`LIGHTING=0` 时没有副作用**：不注入宏、uniform、varying | 已确认 | 生成器在条件不成立时不写任何东西；p2-REPORT 把这条记为推断，这里转正 |
| 其它库名：WPE 同样静默生成空串 | 静态 | 同上。我们照报 `phase: "require"`，不跟随 |
| `#require` 在 `#if` 无效分支里时，插入的文本随分支一起消失 | 推断 | 插入发生在条件求值之前的文本上；`genericparticle` 的 require 在 `#if LIGHTING` 内，结果一样 |

## 2. 库的内容与公式

生成器按宏 `LIGHTS_*` 输出（`FUN_140169140`）：

- `g_LPoint_Color[N]` / `g_LPoint_Origin[N]`
- `g_LSpot_Color` / `_Origin` / `_Direction` / `_Exponent`
- `g_LTube_Color` / `_OriginA` / `_OriginB`
- `g_LDirectional_Color` / `_Direction`
- 有阴影或 cookie 时另有 `g_LFeature_Shadow*`

`PerformLighting_V1(worldPos, color, normal, viewVector, specularTint, ambient, roughness, metallic)`：第 6 个参数名义上是 `ambient`，各着色器传的是 **f0**。函数体逐灯累加，不是循环：每盏灯展开成一段 `{ const uint i = N; … }`。

| 灯 | 计算 | 灯对象 → uniform（`FUN_140190c80`） |
|---|---|---|
| 点光 | `ComputePBRLightShadow(N, Origin - P, V, albedo, Color.rgb, Color.w, Origin.w, tint, f0, r, m, 1)` | `Color = (color·intensity, radius)`；`Origin = (世界位置, exponent)` |
| 聚光 | 同上，颜色乘 `smoothstep(Direction.w, Origin.w, dot(normalize(P - Origin), Direction))`，指数取 `Exponent.x` | `Origin.w = cos(innercone°)`；`Direction = (世界矩阵列 0, cos(outercone°))`；`Exponent = (exponent, 0, 0, 0)` |
| 管光 | `ComputePBRLightShadow(N, PointSegmentDelta(P, A, B), …, Color.w, OriginA.w, …)` | `OriginA = (世界位置, exponent)`；`OriginB = (controlpoint · 世界矩阵, 0)` |
| 平行光 | `ComputePBRLightShadowInfinite(N, Direction, V, albedo, Color.rgb, tint, f0, r, m, 1)` | `Color = (color·intensity, 1)`；`Direction = (-列 0, 0)` |

`CombineLighting` 是公开函数（`common_pbr_2.h`）：HDR 下 `saturate(ambient + light) + light·overbright`，`overbright = saturate(|light| - 2) · 0.5 / max(0.01, |light|)`；LDR 下 `ambient + light`。

引擎数据：

- **灯数**：`general.lightconfig { point, spot, tube, directional, spotshadowcookie, spotshadow, spotcookie, directionalshadow, pointshadow }`，写进 `ctx+0x121c` 的位字段（`FUN_140186c90`），前四项各 4 位。最终 `LIGHTING` 非 0 才写成宏（`FUN_1401a5c40`）。
- **上限**：每种灯 15 盏（4 位）。多出来的灯丢掉，少了的槽位全 0（半径 0，不发光）。
- **灯类型**（`FUN_14025da80`）：`lpoint` 0、`lspot` 1、`ltube` 2、`ldirectional` 3，**`point` 是 5**：遗留灯，写 `g_LightsPosition` / `g_LightsColorRadius`（`FUN_14025d1f0`），只有 `generic` / `generic2` / `genericimage2` 读。
- **坐标空间**：世界空间。世界矩阵 `T · R · S`（`FUN_1401850a0`），`R = Rz · Ry · Rx`，`angles` 是弧度（`FUN_1401dd630`）。局部 +X 是灯的朝向。
- **默认值**（`FUN_14018ff60`）：颜色 0、强度 0、半径 1、指数 2、内锥 20、外锥 30、控制点 (2, 0, 0)、类型 5。
- **隐藏的灯**不进数组（`FUN_140185010`，含父链）。
- **光照走哪个 pass**（`FUN_140206ae0` / `FUN_140209540`）：无 effect 时在上屏 pass；带 effect 时挪到基础 pass 并开 `PRELIGHTING=1`，世界坐标改用 `g_Alt*`，上屏 pass 关光照。
- **其它引擎宏**（`FUN_1401a5c40`）：`SCENE_ORTHO`（正交）、`HDR`（`ctx+0x118 & 0x2000`）、`FOG_DIST` / `FOG_HEIGHT`、`REVERSEDEPTH`。
- **`SHADERVERSION`**：`genericimage3` / `generic3` 用它在 `PerformLighting_Deprecated` 里选公式。值没有逆向到，实测 WPE 走 `>= 62` 的分支（置信度：实测）。

## 3. 语料分类

全量原文搜索了每个工程目录与 `scene.pkg` 里的 JSON 和着色器，并用解析结果对照。基线 103 张，当前语料 117 张（多出的 14 张不含 `genericimage4` 基础层）。

| 类别 | 场景数 | 样本 |
|---|---|---|
| `#require` 但没用到（`genericimage4` 无条件 require，`LIGHTING` 缺省或为 0） | 78 | 12895、3799426930 |
| `genericparticle` 材质（require 在 `#if LIGHTING` 内，从未开启） | 68 张有这个材质 | 与上一类大量重叠 |
| 项目自带 `#require` | 1 | 3286859278 `fluidsimulation_combine`：默认 `LIGHTING=0`，effect.json 的 `LIGHTING: 1` 只出现在 `conditions` 里，实例没有设它 |
| **`LIGHTING=1`** | **0** | 全部写明的值都是 0 |
| `lightconfig` | 0 | |
| `lpoint` / `lspot` / `ltube` / `ldirectional` 灯对象 | 0 | |
| 遗留 `point` 灯 | 2 张共 3 盏 | arsenal、demon_core，只有 `.mdl` 的 `generic` 读 |
| `REFLECTION=1` | 2 | 3400241651、arsenal `planks`，与 LightingV1 无关 |

## 4. 真用到时缺什么

语料里没有场景用到。按 WPE 语义实现后的边界：

| 路径 | 状态 |
|---|---|
| 无 effect 的图层 + `LIGHTING=1` | 已实现，对比通过 |
| 四种灯、空槽、超配、隐藏灯 | 已实现，对比通过 |
| 法线图、PBR 遮罩、自发光、HDR overbright | 已实现，对比通过 |
| `genericimage3` 的旧公式 | 已实现，对比通过 |
| 带 effect 或 passthrough 的图层 | 报 `lighting:prelighting`：要改两个 pass 的 COMBO 并实现 `g_Alt*` |
| effect 自己开光照 | 报 `lighting:effect`：世界坐标取法没有和 WPE 对比 |
| 阴影、cookie | 报 `lightconfig:*`：要阴影图集 `_rt_shadowAtlas` 与 `_alias_lightCookie` |
| 体积光 | 报 `object:castvolumetrics` |
| `genericimage2` 开光照 | 报 `uniform:g_LightsPosition`：读遗留灯 |

## 5. 实现

- **翻译器**：`src/library.rs` 按上面的语义展开 `#require`；请求新增 `litDefines`，只在最终 `LIGHTING` 非 0 时生效。
- **宿主**：`compile/lights.ts` 读 `lightconfig`、算灯光 uniform；`bundle.ts` 把它们并进开了光照的 pass；`features.ts` 放行灯对象与 `lightconfig`。
- 灯光 uniform 是编译期常量：绑了 `{user}` 的字段登记重编译。脚本改灯还不支持，宿主没有灯对象。

## 6. 和 WPE 的对比

工程在 `ignore/lighting/`，WPE 窗口 1920×1080，与离屏目标 1:1 逐像素比。全部不是 `solidlayer` 的工程都只用 `util/white`，不受 UV 内缩影响。

| 工程 | 内容 | 最大差 | 均差 |
|---|---|---|---|
| lt-amb | 只有环境光；有灯对象、没有 `lightconfig` | 0 | 0 |
| lt-point | 两盏点光 + 隐藏灯 + 遗留 `point` | 1 | 0.0000 |
| lt-spot | 聚光，三个角非 0，配置 2 盏只有 1 盏 | 1 | 0.0000 |
| lt-tube | 管光，控制点走世界矩阵 | 1 | 0.0000 |
| lt-dir | 平行光，三个角都非 0 | 0 | 0 |
| lt-mat | 旋转缩放图层、半透明、金属 / 粗糙 / 高光色 | 1 | 0.0001 |
| lt-over | 灯数超配 | 1 | 0.0000 |
| lt-nrm | 法线图（`solidlayer`） | 1 | 0.0000 |
| lt-pbr | 金属 / 粗糙 / 自发光遮罩（`solidlayer`） | 1 | 0.0000 |
| lt-hdr | HDR、灯强 9、`bloomhdrstrength=0`（`ultra`） | 1 | 0.0501 |
| lt-gi3 | `genericimage3` 旧公式 | 1 | 0.0000 |
| lt-gi2 | `genericimage2`：如实报不支持，画面只有环境光 | 0 | 0 |
| lt-cbm9 / lt-cbm21 | `version 3` 的 passthrough（`genericimage4`，`LIGHTING=0`） | 1 | 0.0000 |
| lt-tex | `genericimage4`，`LIGHTING=0`，普通图层 | 2 | 0.0849 |

真实壁纸：**3811798465**（`genericimage4`，只差粒子，force 渲染）：与 WPE 差大于 8 的像素 0.46%，WPE 自身隔 1 秒两帧是 0.56%。这张不是因此解锁的，语料里没有这样的场景。

### 过程中排除的假象

- 早期 960×540 的比较差到 83：先是 PrintWindow 的客户区从 x=11 开始（不是 2），修正后只剩旋转图层边缘（全部在距边 0.82 个场景像素内），改成 1:1 后最大差 1。
- `lt-nrm` / `lt-pbr` 最大差 10：不是光照，是普通图层的 UV 内缩（phase-3c 已记录，`0.15 / 纹理尺寸`）。用调试着色器直接输出纹理通道同样有差，把模型设成 `solidlayer` 后最大差 1。**所以普通图层上带法线图的光照会继续有这项差异**（实测最大 10），要修的是 UV 内缩，不是光照。
- `lt-gi3` 第一版是静默错误：`unsupported` 为空而画面全错，因为 `SHADERVERSION` 没定义。这是审查旧着色器路径时查出来的，语料里没有场景会暴露它。

## 7. 全语料

- `require:LightingV1` 清零（基线 78）。
- 新解锁：**0 张**。78 张最少还差 6 项：`3799426930`、`3812822229`（`tex:format:9` + 5 项中性 general）。
- 新暴露：`combo:SPRITESHEET` 8 张（`genericimage4` 翻译通过后才看到）。3605510527 的 `effects/video` 报错文本与基线的差异是逗号切分造成的，不是新问题。
- `pipeline.test.ts` 的「意外解锁」现在有 5 张：2077883354、2077888249、2418800402、2833452727、2961807954。**都和本次无关**：它们不含 `#require` 也没有灯对象，HEAD 的 TS 代码配新 wasm 同样报这 5 张。没有真机确认，没有加进 `unlocked`，这条测试继续失败。

## 8. 还不确定的

| 项 | 现状 |
|---|---|
| 灯数超配时留哪几盏 | WPE 按类型、标志和某个投影排序（`FUN_140186990`），排序键没逆向完。`lt-over` 里留下的是文件靠前的那盏，和我们一致，但只测了一组 |
| `SHADERVERSION` 的确切值 | 只知道 `>= 62`，用 62 |
| `#require` 在无效分支里的行为 | 推断，没有样本 |
| 灯的 `scale` 非 1 | 代码按读到的公式实现，没有实测 |
| 灯对象带 `parent` | 报 `object:parent`，世界矩阵没有接父链 |
| 脚本改灯 | 不支持 |

## 顺带发现

**宿主从未传 `HDR` 宏**，这和光照无关但影响画面：`common_blending.h` 的 `RGBToHSL` 在 HDR 下要先 `saturate`，`ccsimple` 的 LUT、`generic*` 也按它分支。HDR 场景里用这些路径的画面可能和 WPE 不同。这次只在光照路径传了，没有扩大范围，要全局传时要重跑基线。
