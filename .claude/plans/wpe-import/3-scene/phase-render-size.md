# 按指定尺寸渲染（验收用的 dev 探针）

> 2026-11-14 用户提出：「预览里用固定尺寸再放缩没问题，因为用户可能放缩；但验收、桌面上需要按指定尺寸画。」「三种情况下没有动态变化，不用考虑尺寸变化。」
> 同日改定：「桌面确实有点问题，还是改成和预览一样，只在 dev 探针的时候能指定。」产品里的画法（预览、桌面、应用背景）一律不变，按指定尺寸画只给 dev 探针。
> 本文件先定设计与步骤 0；实现步骤的细节在步骤 0 之后补写。

## 总体设计思路

正交场景现在只有一种画法：先画进场景分辨率（`general.orthogonalprojection`）的离屏目标，再在上屏时按壁纸样式缩放、裁切、留白（`render/layout.ts` 的 `scenePlacement`）。WPE 不是这样：它的场景目标就是窗口（后备缓冲），对齐方式（cover / fit / stretch / center）只改正交投影的四个边界（`FUN_140183a70`：`ortho(L, W−cropR, cropB, H−cropT, ±2000)`），露出来的地方就是清屏色，没有单独的视口或上屏缩放。两种画法在场景尺寸 ≠ 窗口尺寸时结果不同：WPE 的图层边缘是窗口分辨率下的硬边，我们是缩小 / 放大采样后的过渡；`_rt_FullFrameBuffer`、泛光链这些按目标尺寸分配的 RT 和 `g_Screen` / `g_TexelSize` 也跟着不同。各节走查里「按窗口分辨率画」是最大的一类已知差异，验收只能靠「窗口开成场景尺寸」绕开，场景比显示器大（6080×3420）时根本绕不开。

这次给 dev 探针加第二种画法：**按指定尺寸画**。
- 场景目标就是指定尺寸，样式落到投影的边界上。
- 清屏色照 WPE 在 `clearcolor` 与 `schemecolor` 之间选。
- 读回的就是场景目标本身，不再经上屏缩放。
- 指定尺寸在建场景时定下，之后不变。

用途是验收：和 WPE 测试窗口同一种画法，任意窗口尺寸都能逐像素比，「窗口开成场景尺寸」这个限制没有了，场景比显示器大时也能比。产品里的画法（预览、桌面、应用背景）一律不变，场景分辨率 + 上屏缩放（用户定）。

关键决策：
- **只动探针与 `GpuScene` 的建场景选项。** 产品代码路径不调新选项，字节不变。渲染器（`SceneRenderer`）、宿主、应用页都不改。
- **样式进投影，不进上屏。** 这是 WPE 的做法（静态确认）。光标也随之简化：画布坐标就是目标坐标，「光标下的场景点」直接用 VP 的逆求，不再经 `sceneCursor` 的铺放反算。WPE 的 `fill` 本来就是这么算的（P4c 步骤 2 补测）。
- **探针的样式缺省 fill。** WPE 测试窗口的对齐方式缺省是 0（cover），正好是 Kabegame 的 fill。fit / stretch / center 按 WPE 的对齐方式 1 / 2 / 3 算，用来在步骤 0 对照；tile 在这种画法下不收。
- **透视场景不变。** P5d 起透视场景在探针里本来就按画布尺寸画（`canvas ?? window ?? [1920, 1080]`），它是「按指定尺寸画」的一个特例。

数据流：探针 `renderFrame` 收到 `canvas`（和可选的 `style`）→ 算投影边界 → `GpuScene.build` 按指定尺寸建场景目标、按边界建投影。下游本来就跟着场景目标尺寸走：快照、泛光、反射、深度、fullscreen 合成 RT、`g_Screen`。读回场景目标。

## 范围

| 场合 | 画法 |
|---|---|
| 图库预览、桌面壁纸、应用背景 | 场景分辨率 + 上屏缩放（不变，用户定） |
| dev 探针 `renderFrame`（`render_scene`、`renderFrames.ts`、`host_render`）给了 `canvas` | 按 `canvas` 尺寸画，读回场景目标 |
| dev 探针没给 `canvas` | 场景分辨率，读回场景目标（字节不变） |

不在范围：网页壁纸、视频（不经场景宿主）；透视场景（已经是指定尺寸）；产品里的任何画法。

## 分步

| 步骤 | 内容 | 谁做 |
|---|---|---|
| 0 | 0a 读码（对齐方式各分支的裁切公式等）、0b 生成工程在 WPE 里实测、0c 重跑清单 | 读码交代理，实测 Claude |
| 1 | 点 1–3：投影边界、`GpuScene` 按指定尺寸建场景、探针与工具；单测；生成工程和 WPE 逐像素比 | Sonnet 子代理，Claude 验收与比对 |
| 2 | 0c 重跑、文档、回归 | Claude |

步骤 1 动的 `render/scene.ts`、`render/layout.ts`、`dev/probe.ts` 别的会话也在改，动工前再核对一次工作区。

## 现状锚点

**a. 场景目标尺寸**（`render/scene.ts:2269` `populate`）
```ts
// 透视场景按画布尺寸（P5d 步骤 2，已定 6）；正交场景按场景尺寸
const [width, height] = general.perspective
  ? sceneTargetSize(size?.[0] ?? 1920, size?.[1] ?? 1080, device.limits.maxTextureDimension2D)
  : sceneTargetSize(general.width, general.height, device.limits.maxTextureDimension2D); // 现状：正交场景只按场景分辨率
```

**b. 正交投影**（`render/layout.ts:337`）
```ts
export function sceneViewProjection(general: Pick<SceneGeneral, "width" | "height">, zoom = 1): Mat4 {
  const projection = orthographic(0, w, 0, h, ORTHO_DEPTH, -ORTHO_DEPTH); // 现状：边界固定是整张场景，没有裁切量
  if (zoom === 1) return projection;
  // translate(W/2, H/2) → scale(z, z, 1) → translate(−W/2, −H/2)
}
```

**c. 样式只在上屏**（`render/renderer.ts:670` `syncPlacement`；`render/layout.ts:438` `scenePlacement`）
```ts
this.placement = scenePlacement(style, scene.width, scene.height, this.canvas.width, this.canvas.height, ratio);
this.gpu.device.queue.writeBuffer(this.placementBuffer, 0, placementUniform(this.placement)); // 现状：fill 裁、fit 留白、center、tile 都在这一步
```

**d. 光标下的场景点按铺放反算**（`render/renderer.ts:681`）
```ts
private cursorOf(placement: ScenePlacement, style: SceneStyle = this.placementStyle): [number, number] {
  return sceneCursor(style, placement, this.canvas.width, this.canvas.height, pointer[0], pointer[1]); // 现状：画布坐标 → 场景纹理坐标
}
```

**e. 透视场景的指定尺寸**（`render/renderer.ts:386` `load`）
```ts
const perspective = !!bundle.general.perspective;
const size: [number, number] | undefined = perspective ? [...this.fullResolution] : undefined; // 现状：只有透视场景按画布
const placementStyle: SceneStyle = perspective ? "stretch" : this.style;
```

**f. 探针的 `canvas` 只改读回**（`dev/probe.ts:22`）
```ts
// 读回画布：`renderFrame` 收 `canvas: [宽, 高]` 时，读回那一帧编码完场景之后，用产品上屏的同一份着色器与采样器按 `fill`
// 把场景目标铺进这么大的 `rgba8unorm` 纹理、读回它。只改读回、不改渲染（`g_Screen` 等仍按场景目标算）。  ← 现状
```

## 步骤 0 — 调研（读码 + 实测）

### 已知的（各节的读码与实测汇总，2026-11-14）

路径简写：S = 本目录，W = `cocs/wpe/WPE_SCENE.md`。【测】实测，【码】读码，【推】推断。

- **按窗口尺寸**：
  - 后备缓冲与图层直接上屏 / 末 pass 的视口【测】：kabegame-chromium SKILL「读回画布」的 `3830255100-kbp`、`phase10/phase-10b-script.md` 步骤 4b、`phase7/p7-REPORT.md:302`；
  - `_rt_FullFrameBuffer`【测】：`phase5/p5-REPORT.md:95`，1344×756 的窗口里就是 1344×756；
  - 泛光链：【码】`p2-REPORT.md:45,76`，【测】`phase10/phase-10a-curves.md:488`，泛光的 `g_TexelSize` 差一倍；
  - `_rt_MipMappedFrameBuffer`：【码】`phase13/rea-p13-passes.md:313`，【测】`phase13/p13-REPORT.md:76`；
  - `_rt_Reflection`：【码】`rea-p13-passes.md:11,51`，只测过窗口 = 场景；
  - fullscreen 图层的合成 RT【测】：W「P5b」`p5b-fs-1344`；
  - 深度【码】：`phase5/rea-p5-mesh.md:249-258`；
  - 体积光 RT【码】：`rea-p13-passes.md:248`。
- **按对象尺寸**：图层合成 RT（槽 0 图像尺寸，没有纹理时取 `size`），【码】`p2-REPORT.md:178`、【测】`FINAL_CHECK.md:52`；effect fbo = 合成 RT ÷ `scale`，【码】`p2-REPORT.md:192`。
- **内置量**：
  - `g_Screen` / `g_TexelSize` 取窗口：【码 + 推】`p2-REPORT.md:538`，【测】`p5-REPORT.md:145` 与 phase-10a:488。合成 RT / fbo 的 pass 里、窗口 ≠ 场景时没测。
  - `g_Texture<n>Resolution` 取 RT 尺寸【测】。
  - `g_PointerPosition` 是窗口归一化坐标，裁切时不变：【码】`p2-REPORT.md:539`，【测】`phase4/p4-particles-REPORT.md:211`。
  - `g_ParallaxPosition` = P / (场景 W, H)【测】：W「视差」2381978484。
  - `g_EyePosition` 按场景尺寸【码】：`phase5/rea-p5-camera.md:40,113`。
- **映射**：
  - 对齐方式 0 就是 cover：整屏 clear，裁切做进正交投影 `ortho(E0, W−E2, E3, H−E1, −2000, 2000)`，每步 f32【码】：`rea-matrix-order.md:148-167`。窗口 1920×800、7680×2160 场景进 3840×2130 窗口都实测过：p4-particles-REPORT:210，phase-10a:488。
  - zoom 在 P 上绕场景中心再乘 `z = G.zoom × G+0x114`【码】：`rea-matrix-order.md:170`。
  - 场景比窗口小时同样由投影放大【测】：p7-REPORT:302。
  - 对齐方式不是 0 / 2 时清屏用 `schemecolor`：【码】`phase3/p3-script-REPORT.md:1180`，【测】同文件 4g（alignment 1 背景变红）。
  - 注意 WPE 的 alignment 1 叫「fill」，和 Kabegame 的 fill（= cover）不是一回事。
- **脚本**：`engine.screenResolution` = 渲染目标（窗口），`engine.canvasSize` = 场景尺寸【测】：`phase5/phase-5d-camera-depth.md:686`。
- **透视场景**：宽高比取窗口，不读对齐与 zoom【码】：`rea-p5-camera.md:57,88`。
- **光标**：WPE 的粒子跟随点 = 裁切过的 P·V 的逆作用在窗口 NDC 上【测】：p4-particles-REPORT:211。我们现在的 `sceneCursor("fill")` 先反算到场景再用不裁的 P·V，结果相同，但差 1 ulp（P6c 记录，没登记成已知差异），按指定尺寸画后自然消失。

### 0a — 读码（代理，REA / `wp.asm`）
1. `FUN_140183a70` 从 `0x140183b47` 起的对齐方式 switch，逐支写出 E0..E3 的公式（0 cover、1 fill、2 stretch、3 center、4 free），f32 运算顺序照汇编。输入取的是哪个宽高（客户区 `R+0x84/0x88`？）；`alignmentfliph` 与 `alignmentz`（是不是 `G+0x114`）怎么进去。
2. center 的单位：一个场景单位对一个窗口物理像素，还是别的。
3. 透视粒子（正交场景里的 `flags & 4`，`particleViewProjection`）在裁切下用不用 E。
4. 合成 RT / fbo 的 pass 里 `g_Screen` / `g_TexelSize` 有没有改写点（`p2-REPORT.md:538` 的「没发现」再查一次）。
5. P6b 的文本 `anchor` 边距与 E0..E3 是不是同一组值（`phase6/rea-p6b-layout.md:195`）。

### 0a 读码结论（2026-11-14，代理，[rea-render-size.md](rea-render-size.md)，全部来自 `wp.asm` 静态读码）

- **E0..E3**（左、上、右、下；`ortho(E0, Ws−E2, E3, Hs−E1, ±2000)`）每帧在 `FUN_140183a70` 里算。
  - 输入只有窗口客户区 `Ww/Hw`（`R+0x84/0x88`）、场景 `Ws/Hs`、对齐方式，加四个比例：`alignmentposition`、`alignmentx`、`alignmenty`、`alignmentz`，各 ×0.01，缺省 0.5 / 0.5 / 0.5 / 1。
  - 各分支每步 f32 的伪代码见读码第 1 节：0（及 1–4 以外的值）铺满裁切、1 装下留边、2 拉伸全 0、3 居中（一个场景单位对一个客户区像素）、4 自由。
  - 缺省比例下四边对称，和 0b 的实测一致。
- **`alignmentz`** 只在自由模式里用。zoom 的另一个因子 `G+0x114` 是相机自己的 zoom，不是它。
- **透视粒子**（`flags & 4`）的相机用到裁切（读码第 5 节）：
  - `d` 由裁切并乘过 zoom 的 P 的 `P[5]` 算；
  - 相机 xy 在可见区中心：`Wi·R108`、`Hi·R10c`，R108 = (Ws/2 − (E2−E0)/2)/Ws；
  - 宽高比取窗口。旧读码 rea-p5-camera 7.2「场景比例」不对。
- **`g_Screen` / `g_TexelSize`** 只读 `R+0x84/0x88`，合成 RT、fbo、泛光 pass 里都是窗口尺寸（有界搜索）。
- **`engine.screenResolution`** 读同一个字段。
- **视差的指针**不经过裁切：窗口归一化坐标 × 场景尺寸。

### 0b — 实测（Claude，wpe-renderdoc + `kbp gen`）
- **工程**：
  - `prs-grid`：场景 1920×1080，硬边方块网格，四角标记，一块图层超出场景边界、一个 `fullscreen` 层读 `_rt_FullFrameBuffer`，一层带泛光；
  - `prs-small`：场景 960×540，同样布局。
- **窗口**：1920×1080（同尺寸对照）、1280×720（同比例缩小）、1920×800（更宽）、1440×1080（更高）；`prs-small` 另开 1920×1080（场景比窗口小）。
- **对齐**：每个窗口用 `apply_properties` 设 `alignment` 0 / 1 / 2 / 3，`alignmentz` 两档。
- **读**：
  - `kbp rdc consts` 取 MVP、`g_Screen`、`g_TexelSize`、各 RT 尺寸、清屏色；
  - `input_play` 喂几处光标，取 `g_PointerPosition` 与跟随点；
  - 整帧上屏图留作点 1–3 的逐像素真值。
- **要回答**：
  - 读码的 E0..E3 与实测 MVP 逐位相同吗；
  - fit / center 下超出场景边界的图层在留白里看得见吗（推断：看得见，因为没有视口）；
  - 场景区域本身的底色在 alignment 1 / 3 下是 `schemecolor` 还是 `clearcolor`；
  - `g_PointerPosition` 在 1 / 3 下是不是仍是窗口坐标。

### 0b 实测记录（2026-11-14）

- **工程**：`ignore/prs/defs/prs.py`（`kbp gen prs --data ignore/prs`），三个工程：
  - `prs-grid`：场景 1920×1080。硬边方块网格（小数位置与尺寸）、旋转长条、1 / 3 像素竖线、角标、越出左 / 上边界的方块、`clouds_256` 纹理两块。清屏色深灰，`schemecolor` 蓝；
  - `prs-small`：同布局按 0.5 缩，场景 960×540；
  - `prs-fx`：泛光开、一个 fullscreen 图层带工程自带的 effect `kbtint`（读合成 RT 0、乘一个颜色）。WPE 自带的 `effects/tint` 放在测试工程里报材质语法错（`materials/effects/tint.json` Line 1, Column 1），原因没查，换成自带的。
- **录制**：WPE `ultra` 档、fps 20，每段 2 帧。
  - `A:\prs\s0\`：对齐方式 0，`capture_sweep`，`prs-fx` 重录的是 `fx2-*`；
  - `A:\prs\s1\`：对齐方式 1 / 2 / 3，开窗后 `apply_properties({"alignment": N})` 再抓。
  - 共 26 段，上屏图与逐 draw 常量在 `ignore/prs/out/`（`kbp rdc frame --present`、`kbp rdc consts --no-clock`）。
  - 这轮 WPE 是别人重启过的实例，桌面壁纸没有注入，可抓窗口只有测试窗口一个。
- **投影边界**（`bounds.py`：从 `corner_tl` 的 MVP 反推 l、r、b、t）：15 段全部符合下面的规则。各边对称：E0 = E2 = (W − w/s)/2，E1 = E3 = (H − h/s)/2，正数是裁切，负数是留白。

  | 对齐方式 | s | 例 |
  |---|---|---|
  | 0 cover | max(w/W, h/H) | 1920×800 窗口：b 140、t 940 |
  | 1（WPE 叫「fill」，即 fit） | min(w/W, h/H) | 1920×800：l −336、r 2256；1440×1080：b −180、t 1260 |
  | 2 stretch | 不裁 | (0, W, 0, H) |
  | 3 center | 1 | 1280×720：l 320、r 1600、b 180、t 900；960×540 场景放进 1920×1080 窗口：l −480、r 1440 |

  f32 的确切运算顺序以 0a 读码为准，单测逐位比 MVP。
- **清屏色**：对齐方式 1 / 3 时**整个目标**都清成 `schemecolor`，场景区域的底色也是它，不是 `clearcolor`；0 / 2 是 `clearcolor`。这和读码一致：帧首选一个清屏色，没有单独的留白。
- **越界内容**：fit / center 下越出场景边界的图层在留白里完整可见（左边、上边的两块），因为只是投影、没有视口。产品现在的 fit / center 在上屏时把场景矩形之外裁掉、场景区域底色是 `clearcolor`，和 WPE 不同。这次不改产品（用户定），记成产品的已知差异。
- **泛光**：bloom 三个 pass 的 `g_TexelSize` 是 1 / 窗口：1920×1080 下 (1/1920, 1/1080)，1280×720 下 (1/1280, 1/720)，1920×800 下 (1/1920, 1/800)。
- **fullscreen**：`kbtint` 在三种窗口下都画了（画面整体偏红），合成 RT 尺寸留到步骤 1 的逐像素比里核对。
- **`g_PointerPosition`**：1920×800 窗口、对齐方式 1 与 3，`input_start` 把光标固定在窗口 (0.25, 0.75)，抓到的 `g_PointerPosition` 与 `Last` 都是 [0.25, 0.75]。窗口归一化坐标、左上原点，不随对齐方式变（`A:\prs\s2\`）。

### 0c — 重跑清单
各节里归成「按窗口分辨率画」的走查样本，步骤 1 之后用探针按新画法重跑，能逐像素相同的就从已知差异里删掉：
- **P5a**：3 张样本 1344×756（`phase5/phase-5a-parallax.md:519`）。
- **P5b**：fullscreen 合成 RT 与 `g_Texture0Resolution`（W「P5b」）。
- **P5d**：`3462279189-tmpl2` 月亮轮廓、`tmpl2pos`、`3605722997`（`phase5/phase-5d-camera-depth.md:718-727`）。
- **P6b**：`2391389126` 1600×900（`phase6/phase-6b-text.md:1525`）、同文件 :1640、:1910。
- **P6c**：`3637191856` 字形边缘（`phase6/phase-6c-interaction.md:388`）。
- **P7**：256² 场景 768² 窗口（`phase7/p7-REPORT.md:302`）、`3822495444`（`phase7/phase-7c-hlsl-implicit.md:218`）。
- **P9**：视频缩放边缘（`phase9/phase-9a-playback.md:288`）。
- **P10a**：`frostp`、`rings`、`sun` / `whale` / `grad`、`intro`（`phase10/phase-10a-curves.md:438-488`）。
- **P10b**：两张时钟壁纸 1920×1080，`2887099508` 书页。
- **P11a**：Liberty（`phase11/phase-11a-audio.md:210`）。
- **P11b**：图层上下边（`phase11/phase-11b-usertextures.md:476`）。
- **P12a**：K1（`phase12/phase-12a-mesh-animation.md:659`）。
- **P13a**：`3498150384`（`phase13/phase-13a-legacy-lights.md:283`）。
- **P13b1**：Reflection 尺寸（`phase13/phase-13b1-reflection-off.md:254`）。
- **P2**：shimmering_particles 的泛光核（`PLAN.md:621`）。

优先 P10a 的 sun / whale / grad / intro、P5d、P6b：结论里写了「待按窗口分辨率画之后重跑」。

## 实现

### 点 1 — 投影边界与两个投影（`render/layout.ts`）
- **新增** `alignEdges(mode, Ws, Hs, Ww, Hw)` → `[E0, E1, E2, E3]`：
  - 照读码第 1 节的伪代码逐步 f32；
  - 只做 0–3，比例固定为缺省值（`alignmentposition` / `x` / `y` 都是 0.5，Kabegame 没有这些属性）。
- **新增** `ALIGNMENT_OF_STYLE`：fill → 0、fit → 1、stretch → 2、center → 3，tile 不在表里。
- **新增** `clearsWithSchemeColor(mode)`：照 `(mode & ~2) != 0`。
- **修改** `sceneViewProjection(general, zoom, edges?)`：给了 `edges` 时用 `orthographic(E0, W−E2, E3, H−E1, …)`，zoom 仍绕场景中心 (W/2, H/2)，三步照旧。不给时字节不变。
  - 现在的 `orthographic` 只在 E = 0 时逐位核对过，要按读码 rea-matrix-order 第 7 节核对每一步是 f32。
- **修改** `particleViewProjection(general, zoom, view?, crop?)`：
  - `crop = { edges, window: [Ww, Hw] }` 时照读码第 5 节：d = 1 / (tan(fov/2) / (1/P[5]))，P 是裁切并乘过 zoom 的正交投影；宽高比 Ww/Hw；相机 xy 减 `Wi·R108`、`Hi·R10c`。
  - 不给时字节不变。

### 点 2 — `GpuScene` 按指定尺寸建场景（`render/scene.ts`、`render/camera.ts`）
- **新增** `GpuScene.build` 的选项 `target?: { size: [w, h]; edges: Edges; clear: [r, g, b] | null }`，只对正交场景：
  - 场景目标按 `size` 建；超设备上限时报错，不缩；
  - 每处 `sceneViewProjection` / `particleViewProjection` 都带上 `edges`（建场景、`setCamera` 的 zoom 重算、正交相机对象 `orthographicCameraObjectFrame`）；
  - `clear` 非空时每帧清屏用它代替 `clearcolor`（对齐方式 1 / 3 的 `schemecolor`），`clearenabled` 照旧决定清不清。
  - 产品不传这个选项，字节不变。
- 核对按场景单位取值的地方保持场景单位：视差（`g_ParallaxPosition`、偏移）、`g_EyePosition`、抖动、`engine.canvasSize`。按目标像素的随场景目标走：`g_Screen`、`g_TexelSize`、快照、泛光、反射、mip 帧缓冲、深度、fullscreen 合成 RT。
- 反射 pass 的清屏色仍是 `clearcolor`：WPE 的设备清屏色是共享状态，读码推断反射也会拿到 `schemecolor`，没测。标 `TODO:[WPE_SCENE]`。

### 点 3 — dev 探针与工具（`dev/probe.ts`、`scripts/kabegame-dev/`、`apps/kabegame-dev-mcp/`）
- **修改** `renderFrame`：正交场景给了 `canvas`（且没给 `renderMode: "scene"`）时：
  - 场景目标就是 `canvas`，`edges = alignEdges(ALIGNMENT_OF_STYLE[style], W, H, canvas…)`；
  - `clear` 按对齐方式取 `schemeColor(属性全集)` 或 null；
  - 读回场景目标本身，不经上屏铺放。
- **光标**：都从窗口坐标来。
  - `g_PointerPosition` 原样是窗口归一化坐标（0b 实测：不随对齐方式变）；
  - 控制点跟随点与光标命中用 `pointerScenePoint` 对裁切后的 VP 反投影窗口坐标（同 WPE），不再经 `sceneCursor`；
  - 视差的指针照旧：窗口归一化 × 场景尺寸。
- **新增** `style`（缺省 `fill`；`tile` 报错）与 `renderMode: "scene"`（旧的「场景分辨率 + 读回时按 fill 铺进画布」，字节不变）。
  - 透视场景不受影响：本来就按 `canvas` 画；
  - 不给 `canvas` 时同以前。
- **工具**：
  - vite REST（`scripts/kabegame-dev/scene.ts`）与 MCP `render_scene` 收 `style`、`renderMode`；
  - `renderFrames.ts` 加 `--style`、`--render-mode`；
  - 结果里注明这次用的画法。
  - kabegame-chromium SKILL「读回画布」改写。

### 点 4 — 文档
- `cocs/wpe/WPE_SCENE.md`「链路隔离验证（dev 探针）」与铺放一节。
- `FINAL_CHECK.md`：已知差异「先按场景分辨率画再缩」改写成「产品按场景分辨率画再缩（不复刻，用户定）；验收用探针按窗口尺寸画，不再计入走查差异」。同时写明产品的 fit / center 和 WPE 的两处不同：越界内容被裁掉；场景区域底色是 `clearcolor`。
- 回归加一节。changelog 不加：只有 dev 工具。

## 已定（2026-11-14 用户：「开始」，桌面改回和预览一样）

1. 产品里的画法一律不变，按指定尺寸画只给 dev 探针。
2. 探针里的样式照 WPE 的对齐方式：fill = 0、fit = 1、stretch = 2、center = 3；tile 不收。
3. 探针给了 `canvas` 默认按指定尺寸画，`renderMode: "scene"` 取旧行为。

## 验收

1. **单测**：
   - `sceneBounds` 每种对齐方式、各窗口形状，算出的 MVP 和步骤 0 抓帧的常量逐位相同；
   - 探针的 `canvas` / `style` / `renderMode` 参数校验；
   - 宿主 tsc 0 error、vitest 全过、Prettier；kabegame-dev 与 MCP 的测试。
2. **生成工程**：`prs-grid`、`prs-small` 在 0b 的每个窗口 × 每种对齐方式下，探针按指定尺寸画，和 WPE 整帧逐像素相同。
3. **字节不变**：
   - 产品路径：`hash_baseline` 的样本，加上 bedroom / vortex 三档，用宿主页面实际渲染比；
   - 探针不给 `canvas` 时；
   - 给 `renderMode: "scene"` 时和改动前「读回画布」逐字节相同。
4. **重跑清单**：0c 每项重跑，结果逐项记进实施记录；剩下的差异必须另有解释，否则不通过（FINAL_CHECK 原则 4）。
5. **语料**：`kbp corpus scan` 前后 `unsupported` 不变（本节不改能力表）。
6. **变异检查**：边界公式、清屏色来源、目标尺寸、光标取法各去掉一处，单测或生成工程要能抓到。

## 风险

1. **共享文件**：`render/scene.ts`、`render/layout.ts`、`dev/probe.ts` 别的会话（P6c、P11、P12、P13）在改，按块暂存，必要时在 HEAD 快照里实现再三方合并。
2. **验收与产品画法不同**：探针按窗口尺寸画通过，只说明渲染语义和 WPE 一致；产品（预览、桌面）仍按场景分辨率画再缩，这条差异留在产品里，`FINAL_CHECK.md` 的已知差异照写（用户定）。真机对照时仍会看到它。
3. **基线**：给了 `canvas` 的探针结果全部改变（这正是目的），以前按「读回画布」记的走查结论要按新画法重跑一遍才能删掉已知差异。

## 实施记录

### 步骤 0（2026-11-14）
- 0a、0b 的结论记在上面「0a 读码结论」「0b 实测记录」。
- 读码代理只新建了 `rea-render-size.md`。它对 rea-p6b-layout、rea-p5-camera 各一处的更正写在新文档里，原文档没动。

### 步骤 1（2026-11-14，Sonnet 子代理实现，Claude 验收）
- **改动**：
  - `render/layout.ts`：`alignEdges`、`ALIGNMENT_OF_STYLE`、`clearsWithSchemeColor`，只给 edges 路径用的 `orthoWpe` / `zoomed`；`sceneViewProjection` / `particleViewProjection` 的可选参数，透视粒子在裁切下照读码第 5 节。
  - `render/camera.ts`：正交相机对象带 `crop`。
  - `render/scene.ts`：`GpuScene.build` 的 `target`，场景目标按尺寸建，超上限报 `render:target-size`；各处投影带 edges；主目标清屏色。反射 pass 没改，标了 `TODO:[WPE_SCENE]`。
  - `dev/renderTarget.ts`（新）、`dev/probe.ts`：`style` / `renderMode`，结果的 `render`。
  - `dev/particleCorners.ts`：透传 `crop`。
  - `scripts/kabegame-dev/`（`replay.ts`、`types.ts`、`scene.ts`）、`apps/kabegame-dev-mcp/src/`（`tools.ts`、`renderFrames.ts`）：参数透传、关系校验；宿主产物过期时回 409。
  - 产品文件（`render/renderer.ts`、`host.ts`、`main.ts`、`apps/kabegame/`）没动。
- **代理自己定的**：
  - 参数关系校验：`style` 要有 `canvas`；`renderMode: "target"` 要有 `canvas`；`scene` 不收非 fill 的 `style`；
  - 结果的 `render.mode` 有三种：`target` / `scene` / `perspective`；
  - 工程没声明 `schemecolor` 时取 0.5 灰。
- **验收**（Claude）：
  - **范围**：`git status` 查过，改动都在上面的文件里；`host.ts` 那 3 行是 P13b2 的。
  - **检查**：tsc 0 error；vitest 168 个文件 3941 条全过；deno 55 个全过。Prettier：dev 工具的 7 个文件代理没排版（HEAD 时都合），我补了 `--write`，重跑 deno 全过。
  - **逐像素**：`cmp_target.py` 经宿主求值直接调探针。跑着的 vite 插件与 MCP 是改动前加载的，不重启 dev。18 段遮掉帧号 / 时钟两层后全部和 WPE 相同。`prs-fx` 两段的残差是这两层被泛光晕开，遮罩外扩 80 像素后为 0（`fx_check.py`）。
  - **改动前对照**：旧画法在 1:1 裁切（1920×800、1440×1080 的 cover）下本来就相同；`prs-fx` 1280×720 差 61684 个像素、最大 110。
  - **旧路径**：`renderMode: "scene"` 3 段与不给画布 1 段，和改动前记的读回逐像素相同、sha256 相同。
  - **产品路径**：`hash_baseline` 10 张 × 3 档里 beach、deep_space、razer_vortex 变了。归因是同期 P12a 的 B1 把单级 mip 纹理的采样器改成 8 倍各向异性（`textures.ts` 12:37Z，基线是 12:05Z）：
    - 这 3 张都有这种绑定（`trace_samplers.py`），eagleflag 没有、没变；
    - bedroom 有但都是 1:1 或放大采样，没变；
    - 产品路径不传 `target`，本次新代码不生效。
    - 没有用「只撤掉 B1」的产物复核：会替换各会话共用的宿主产物。
  - **变异**：8 处，第一轮漏了「场景目标宽高对调」「主目标不用 `schemecolor`」两处。探针单测替换了 `GpuScene.build`，碰不到它们。补了 `GpuScene` 假设备的 5 条用例后 8 / 8（`ignore/prs/mutations.py`）。
- **基线与数据**：`ignore/prs/base/`（hash-before / after、旧读回 PNG）、`ignore/prs/ours/`、`ignore/prs/cmp/`。
- **没做**：
  - dev 重启后的工具参数（回归 RS5）；
  - 0c 重跑（步骤 2）；
  - 光标命中在裁切下的透视覆盖图层：`GpuScene.cursorCamera` 的 override 宽高仍是场景尺寸，没测。

### 步骤 2（2026-11-14）— 0c 重跑
- **做法**：
  - 用各节当时的录制与 WPE 上屏图，不重抓；
  - 探针给 `canvas` = 抓帧窗口，按新画法直接画（`render.mode` 都是 `target`、`fill`）；
  - 回放、脚本、塞值的参数照当时的。
  - 工具在 `ignore/prs/rerun/`：
    - `walk_rerun.py`：按时间线回放、逐帧比；
    - `p5d.sh`、`p6b.py`、`render_one.ts`：单帧；
    - `where.py`：差异像素的分布；
    - `inv_check.ts`、`inv_check2.ts`：求逆的归因；
    - `book_rerun.py`：P10b 书页。
  - 结果在 `ignore/prs/rerun/<组>/`。
  - 宿主产物期间换过几次（别的会话重建、dev 重启：`index-XuxhpPBz` → `Czk5Km5Q` → `OzPhIX5D` → `BhHTn-1J` → `CiX8Xjue`），每段记了当时的产物，都带本节代码。
- **P10a**（4K 场景、3840×2130 窗口；括号里是改动前）：

| 样本 | 段 × 帧 | 结果 |
|---|---|---|
| `intro`（7680×2160，`ultra`） | 4 × 3 | **12 帧逐像素相同**（以前场景比窗口大，没法逐像素比） |
| `rings` | 3 × 3 | **9 帧逐像素相同**（以前 1–3 个边缘像素，最大 255） |
| `post` | 5 × 3 | 15 帧逐像素相同（以前也相同） |
| `frostp` | 6 × 3 | 每帧 0–18 个像素差 1，w03 三帧相同（以前每帧 5–7 万个，最大 93–219） |
| `sun` | 2 × 3 | 每帧 1013–3507 个像素差 1（以前约 1.6–1.7 万个） |
| `gradt` | 3 × 3 | 每帧 17–1166 个像素差 1（以前 44–1411 个） |
| `whale` | 3 × 3 | 每帧 2–64 个像素，最大 1–2（以前最多 2513 个） |

  剩下的 ±1 逐项定位，都不是尺寸：
  - **`sun` 第 161 帧**：
    - 合成 RT 和 WPE 逐像素相同；
    - 差异全在镜头光晕上屏那次绘制（WPE 事件 45），这次绘制的 MVP 0 ulp；
    - `g_ModelViewProjectionMatrixInverse` 有 5 个分量差 1 ulp，另有 6 个 ±0 的符号不同；
    - `invertF32`（照 WPE `FUN_14005f730` 搬运的那份）对同一个 MVP 求逆，和 WPE 逐位相同（`inv_check.ts`）；uniform 现在用 `math.ts` 的 `invert`；
    - 这是 `phase-f32-matrix.md` 登记的「求逆」已知差异（「走查碰到时再做」），走查碰到了，要不要改待用户定。
  - **`gradt` 第 99 帧**：
    - 4 个绘制里上屏的 3 个常量全同；合成 RT（WPE 事件 22）逐像素相同；
    - 1166 个差异像素全部只经过第一个上屏绘制（flow effect，事件 46，按 `g_Time` 算三角函数），之后的绘制没碰它们；
    - 输入和常量都相同，归着色器求值（fxc 与 Tint 的浮点顺序，同 P11a Liberty 音频条那一类）。
  - **`frostp` 第 360 帧**：
    - 背景、霜冻合成 RT、霜冻 effect 输出逐像素相同（WPE 事件 82、99、118）；
    - 18 个差异出在霜冻层上屏（事件 142），这次绘制常量全同。同上一类。
  - **`whale` 第 96 帧**：
    - 40 个绘制里上屏的常量全部 0 ulp。4c 时组 187 下 13 个子层 MVP `[12]` 差的 1 ulp 没有了；
    - 鲸鱼层的合成 RT 与 shake effect 输出逐像素相同；
    - 剩 2 个像素差 1，没再逐层定位。
  - 合成 RT 与 effect pass 的 MVP 两边写法不同（平移 −1 对 0、深度项 0.0005 对 1），是登记过的约定，输出逐像素相同。
- **P5d**（脚本自己跑，1920×1080 / 1600×900）：
  - `camsA` / `camsB` / `camsC` **整帧 0 差异**（以前分别有 35.6 万、26.1 万、35.6 万个像素差，最大 35 / 12 / 35）。
  - `tmpl2` 各组：
    - 1080 第 278 帧 117 个像素差 1（以前 58.7 万个，最大 68，月亮轮廓 > 32 的 138 个）；
    - 900 第 291 帧 100 个（以前 31.6 万个，最大 90）；
    - `zoom` 2 第 144 帧 49 个（以前 41.5 万个，最大 12）。
  - `tmpl2pos` 第 238 帧 50 个像素差 1（以前 54.6 万个，最大 101，> 32 的 2829 个）。
  - `tmpl2` 第 278 帧逐 draw（`kbp rdc consts` 对探针轨迹）：
    - 7 个绘制配上，上屏常量除下面一处外逐位相同；
    - 树丛1 effect 的 `g_Speed` 看着不同（我们 1、WPE 3.53），其实是翻译器把两阶段同名、材质键不同的 uniform 拆开了，片元那份 `kb_fs_g_Speed` 是 3.53，和 WPE 像素着色器的相同；
    - 地板 effect 上屏（WPE 事件 117）的 `g_EffectTextureProjectionMatrixInverse` 差 1 ulp，`invertF32` 对我们的矩阵求逆和 WPE 逐位相同（`inv_check2.ts`），同 `sun` 的「求逆」；
    - 117 个像素没有逐个分到绘制。
- **P6b**：
  - **`3429-text` 1920×1080 整帧 0 差异**（以前两个 `blurprecise` 层差 1493 / 9059 个像素，最大 58 / 50）。
  - **`2391389126` 1600×900 时钟文字区域 0 差异**（以前 805 个像素）。整帧背景随时间在动，同当时只比文字。
  - `e3clock`（4 帧）、`e3clock-nofx`（2 帧）、`e3clock-nofx2130`（2 帧）保持 0 差异。nofx 走的是 3840×2160 场景、3840×2130 窗口的裁切（`edges` [0, 15, 0, 15]）。
- **P6c**：`3637191856-iso-clockv` 1920×1080（场景 3936×2208），拖动中 3 帧、松开后 3 帧，**6 帧逐像素相同**（以前每帧 960–1139 个像素、最大 41，字形边缘）。产物同时带着 P6c 修复 2（光标按裁切投影反投影）。
- **P7c**：`3822495444`（整张工坊场景、3840×2130 窗口、按抓帧的 `g_Time`）772 个像素差 1（以前按 3840×2160 画再居中裁，9546 个，最大 2）。没有逐 draw 定位。
- **P10b**：
  - 两张时钟（`3336377291-iso-61`、`3427691867-iso-164`）1920×1080 各 4 段，**24 帧逐像素相同**（以前文字上每帧 1500–2400 个像素、最大 47）；
  - `2887099508` 书页（6080×3420 场景、1920×1080 窗口、`ultra`、带脚本与点击时间线，`book_rerun.py`）第 1019、1025、1033、1040、1047 帧 **5 帧逐像素相同**（以前每帧约 1.4 万个像素、最大 55–70）。
- **P11a**：Liberty `3502090109`（3840×2160 场景、1920×1080 窗口、按录制回放频谱）**4 帧逐像素相同**（以前 35846 个像素、最大 15）。当时归 fxc 与 Tint 舍入中点的音频条 7 个、模糊 16 个像素，在窗口分辨率下也没出现。
- **P11b**：`p11b-npot` + `ut-b.jpg` 1600×900（工程复制到 `ignore/prs/rerun/proj/`、图片放进工程目录设成属性缺省值，原工程与库里的属性都没动）。去掉帧号 / 时钟块后剩 12024 个像素，全在 36 列上，即条纹边界每处 2–3 列的 JPEG 色度上采样（已知）。以前的「图层上下边缘各 1 行」没有了：第一行和最后一行也只有这 36 列。
- **P12a K1**：3840×2130 窗口那组（`…-iso-pup-bl`，文件夹名写 3840×2160、实际后备缓冲 3840×2130）：
  - `3203778110` 6 帧里 **5 帧逐像素相同**，第 280 帧 32 个像素差 1，就是走查报告里证实为 `rsqrtps`（K2）的那 32 个（以前每帧 286–776 个，一帧有 49 级的覆盖翻转）；
  - `2896608544` 每帧 178–1990 个、最大 2（以前 3820–7706 个），和报告里「只换骨骼 → 1606」同量级，K1 的部分没有了。
- **P13a**：`3498150384` 第二轮（3840×2130 窗口）每帧 2–309 个、最大 ≤ 4（以前 6–8 万个、最大 26），和同尺寸窗口那一轮（≤ 41 个、最大 8，已归「8 位反馈 RT 的舍入翻转」）同一类。
- **P13b1**：`p13b1-r7` 1600×900：`_rt_MipMappedFrameBuffer` 的 `g_Texture0Resolution` (1600, 900) 与 `g_Texture0MipMapInfo` 7 和 WPE 相同（产品按场景分辨率是 1920×1080、8 级）。画面只有帧号 / 时钟块不同（这组没有日志，按固定时刻）。
- **P5b**：`p5b-fs` 1344×756：fullscreen 合成 RT 是 1344×756（WPE 的窗口尺寸；产品按场景分辨率）。WPE 这帧没画 FR / CLK，其余 4 个绘制的常量逐位相同（F1 的 `g_Color4` 两边不同，画面里没有对应的颜色，应是没被读、WPE 那份是残值）。整帧只有蓝通道 12425 个像素 +1，散在 fullscreen effect 覆盖的整屏，没有逐 draw 定位。
- **RS5**（dev 22:48 重启后）：MCP `render_scene` 的 `style: "fit"`（`prs-grid` 1280×720）与 `renderMode: "scene"`（1920×800）、`renderFrames.ts --style center`（1280×720），和步骤 1 经宿主求值得到的图文件 sha256 相同；`renderMode: "scene"` 配 `style: "fit"`、`--style` 不给 `--canvas` 都在本地拒绝。宿主产物过旧时的 409 没法现场造，只有单测。
- **没重跑**：
  - P5a 三张真实样本（1344×756）：整张工坊场景，日志是构造的定长帧时间，当时只用相位相关比位置，不是逐像素对照的录制；
  - P7 流体 768² 画布（「参考，不算验收项」，要从清空状态整段模拟）；
  - P9a 视频区域对照：当时在宿主里算统计、比较工具没留下；P9d 正在换视频解码，留给它的走查；
  - P2 shimmering_particles 的泛光核：说的是三屏 5760×1080 场景，没有录制；
  - P4e 细雨丝变暗（`WPE_SCENE.md`「细雨丝变暗」）：不在 0c 清单里，没跑。
- **剩下的差异的归类**：
  - **求逆的写法**（**2026-11-15 更正**：照下面改成 WPE 的单精度求逆后，`sun`、`tmpl2` 的常量逐位相同、像素差一个没少，这两处其实归下一条「着色器求值的舍入」；受影响的是 P13a 的反馈 RT，见 [phase-f32-inverse.md](phase-f32-inverse.md)）：`sun` 的 `g_ModelViewProjectionMatrixInverse`、`tmpl2` 的 `g_EffectTextureProjectionMatrixInverse`，uniform 用 `math.ts` 的 `invert`（double 余子式），WPE 是单精度的 `FUN_14005f730`。`phase-f32-matrix.md` 登记过、说「走查碰到时再做」，P13a 也记过一次。改法是 uniform 的几处逆改用现成的 `invertF32`，会改变读这些 uniform 的场景的产品输出，**要不要改待用户定**。
  - **着色器求值的舍入**：`gradt`、`frostp` 已定位到输入与常量都相同的单次绘制；`whale`、`3822495444`、`p5b-fs` 同量级，没有逐 draw 定位。
  - 其余是各节已登记的：`rsqrtps`（P12a K2）、8 位反馈 RT（P13a）、JPEG 色度上采样（P11b）。
- **文档**：`WPE_SCENE.md` 各节归到「按窗口分辨率画」的已知差异按上面改写（P5b 合成 RT 尺寸、P5d、P9、P10a、P10b 时钟与书页、P11a、P12a K1、P6b `3429479356`）；`FINAL_CHECK.md` 的「按窗口分辨率画」一段补重跑结论；回归 RS5、RS6 勾选。各节自己的计划文件（历史记录）没改，结论记在这里。
- **测试行**：本轮导入的 29 个测试行都用 `projects_remove` 移除并核实（`ignore/prs/rerun/*-import.json`）。中途 22:44 dev 的 app 进程退出过（不是本会话操作），22:48 重启后继续。
