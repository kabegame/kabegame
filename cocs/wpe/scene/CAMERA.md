# 场景壁纸：相机

> [场景壁纸文档](../WPE_SCENE.md) 的一章：视差 / 抖动 / 缩放、透视相机与相机对象、深度、脚本的相机基准、相机关键帧（P5a、P5d、P5e、P5i）。总体形态、各阶段状态与全部章节的索引在总览里。

## 相机：视差、抖动与缩放（P5a）

视差、抖动和缩放都只改相机，不碰几何，也不新增图层种类：
- 每帧在帧开头求一次相机：抖动偏移 s、缩放 `zoom`、视差点 P。
- 每次绘制在视图投影上右乘一个平移。图像层（直接上屏、合成链的每个 pass、passthrough 上屏）和正交 / 透视粒子都经同一个入口 `GpuScene.uniformValues`。
- 同一节还有几条能力表的前置修正：材质 JSON 的注释、深度写入、`cropoffset` 与对象 `config`、模型 JSON 的布尔键。

依据：
- 读码：[rea-p5-camera](../../../.claude/plans/wpe-import/3-scene/phase5/rea-p5-camera.md) 5、6 节（抖动、视差）与 `p3-script-REPORT.md` L2（`zoom`）；前置几条在 [rea-p5-mesh](../../../.claude/plans/wpe-import/3-scene/phase5/rea-p5-mesh.md) 3 节、[rea-p5-modelflags](../../../.claude/plans/wpe-import/3-scene/phase5/rea-p5-modelflags.md) 4、7 节。
- 确定性工程的实测：[报告](../../../.claude/plans/wpe-import/3-scene/phase5/p5-REPORT.md)「P5a 语义的实测核对」（读码公式全部成立，补了 float32 临界与「P 不钳制」两处）与「收尾走查」（推翻一处：视差点初值）。
- 逐步的验收数据：[子计划](../../../.claude/plans/wpe-import/3-scene/phase5/phase-5a-parallax.md)「实施记录」「P5a 收尾」。下面每条只点出依据是读码还是实测，数字和例外以子计划为准。

验收照 P4：
- 确定性工程的方块是纯色的，按 `g_Color` 认；CLK 层另读 `g_ParallaxPosition`、`g_EyePosition`。
- 按 WPE 日志的时间线回放到同一帧，和 `kbp rdc frame` 的整帧逐像素比；跟随指针的粒子另用 `particle_track` 逐个比。
- 结果：视差 7 组、抖动 5 组、缩放 5 组整帧 0 差异；真实样本按图层位置和相位相关比（见下「语料与解锁」）。
- 抓帧不移动用户的鼠标，指针从 CLK 层读；光标在动的抓帧用逐帧光标日志（见下「dev 探针与对比台的增补」）。

### 一帧里的顺序

`SceneRenderer.render`（`render/renderer.ts`）一帧：
1. 按本帧 `g_Time` 和**脚本之前**的 general 字段算抖动 s（`render/shake.ts`）、取 `zoom`；
2. 推进视差点 P（目标点以 s 作 eye），更新 `g_ParallaxPosition`（`render/parallax.ts`）；
3. `sync` → `stepParticles`：粒子模拟（跟随指针的控制点反投影）用的还是**上一帧**交给场景的相机，带上一帧的 s 与 `zoom`，不带视差；
4. `setCamera({ shake, zoom })`：改场景级视图投影、透视粒子视图投影与眼位；
5. 脚本（`beforeFrame`）；
6. `setParallax`：按**脚本之后**的开关与 `amount` 交本帧视差。视差或相机有一个变了，就把全部 draw 由图层与相机算出的 uniform 重写一遍，一帧至多一次；
7. `sync` → `update`（`g_ParallaxPosition` 随每帧 uniform 写）→ `encode`。

依据：
- 读码：WPE 一帧里先更新对象（粒子模拟，`FUN_1401891a0`），再更新相机（抖动、视差点），最后才跑脚本。
- 实测 `p5a-shakepar`：跟随指针的新生粒子，按「当帧指针 + 上一帧 s」误差 0，按当帧 s 差 0.3 像素。
- 实测 `p5a-wk-zoom3`：脚本写 `zoom` 后画面晚一帧、粒子模拟晚两帧。
- 实测 `p5a-wk-script`：脚本写 `cameraparallaxamount`、`parallaxDepth`，同一帧就画出来。

### 视差

| 项 | 规则 | 依据 |
|---|---|---|
| 目标点 | 指针先钳到 0…1、y 翻成向上（`mx = clamp(ptr.x)`、`my = clamp(1 − ptr.y)`），再在场景中心与指针之间按 `mi = cameraparallaxmouseinfluence` 插值：`P* = s + (W·(0.5(1 − mi) + mx·mi), H·(0.5(1 − mi) + my·mi))`。`mi` 不钳制，可以为负（语料有 −2、−0.21、−0.22）。W、H 是场景的正交尺寸，不是渲染目标 | 读码 6；实测 `p5a-ptr`：`mi` 1、0.5 时 P 为 (1920, 0)、(1440, 270)，各层偏移误差 0；`mi −2` 时反推 P = (−960, 1620)，在场景外 |
| 指针 | 用 `g_PointerPosition`（已按壁纸样式换算，`scenePointer`），和它同源，不是控制点跟随用的反投影。`fill` 下就是窗口归一化坐标，和 WPE 相同；`fit` / `center` / `tile` 换算到场景上，光标落在画面上，留白处被钳到边 | 读码；实测 `2381978484`（8192×5479 的场景放进 16:9 窗口，偏移仍按场景单位）；样式由真机走查 |
| 平滑 | `delay > 0` 时 `k = min(1, (1 − delay/3)·10·dt)`，`P ← P + (P* − P)·k`。dt 是本帧的帧时间（钳过的 `g_Frametime`），k 钳到 1 的帧照用。`delay ≤ 0` 时 P 直接取目标；补画帧 dt 为 0，P 不动。P 不钳制 | 实测 `p5a-delay27` / `29`：逐帧 k 和公式差 < 1e-5，用上一帧的 dt 对不上 |
| 精度 | 目标点、k、P 的推进都逐步 float32，结合顺序照汇编：目标 x = `((W·0.5)·(1 − mi) + (W·mx)·mi) + eye.x`（y 项是 `my·H`），`k = ((1 − delay/3)·10)·dt` 再 `1 > k ? k : 1`，`P = ((P* − P)·k) + P`，每步 `fround`（`render/parallax.ts`） | 汇编 `0x140189b67`–`0x140189cea`，常量 0.5、3、1、10 从可执行文件读出；P10b 全屏走查 `clk61-w0` 第 76 帧（平滑途中）在 double 里算时文字 MVP 差 1 ulp、181 个像素 ±1，改后第 76–78 帧逐像素相同 |
| 开关绑属性 | `cameraparallax` 等布尔 general 字段（及 `bloom` / `hdr`）写成 `{user, value}` 时，加载先按 `value` 的布尔设位，属性值只有布尔才改位，数字、字符串加载与运行中都不改（`compile/postprocess.ts` 的 `flagValue`） | 读码 `0x14019b4e0`（JSON 布尔直接设位、对象读 `value`）；实测 `ignore/p5/pb/` E1–E6（滑块 −0.22 / 0 不关、`value: false` 时滑块 0.5 不开、复选框 false 能关、下拉 `"1"` 不改、运行中改成数字保持原位）；真实样本 3253330537（`newproperty16` 滑块 −0.22，WPE 视差开），复制工程逐像素相同 |
| `g_ParallaxPosition` | `clamp(P / (W, H), 0, 1)`，只进 uniform，和对象平移无关；在 `ENGINE_UNIFORMS` 里，每帧写 | 实测 `3818481122`：`depthparallax` 读到 (0.75, 0.25)，它的图层深度 0、不动；`mi −2` 时为 (0, 1) |
| 对象平移 | `o = amount · depth(根) ⊙ (origin(根).xy − P)`，z 为 0。根是沿父链走到顶的对象（`layout.ts` 的 `rootObject`，父对象不在图层表里时当根）；`origin` 取当前值（属性、脚本写回之后）；缺省深度 (1, 1)。指针在中心时，原点不在中心的层也有偏移 | 实测 `p5a-static`（`mi 0`，P 恒为中心）7 个方块误差 0：(1460, 540) 深度 (1, 1) 偏 250，(460, 540) 深度 (−0.7, −0.7) 偏 175；根分组深度 (0, 0) 下深度 (1, 1) 的子方块不动 |
| 乘在哪 | 一个对象的每次绘制都把视图投影换成 `VP · T(o)`（`GpuScene.viewProjectionOf`）：直接上屏、effect 的中间 pass（它读的效果矩阵也带视差）、上屏 pass、正交与透视粒子。画进合成 RT 的基础 pass 用自己的整面矩阵，本来就不读 VP。粒子模拟与控制点的指针反投影用不带视差的视图 | 实测 `p5a-fx`：`cursorripple` 第一个 pass 读的 `g_EffectTextureProjectionMatrixInverse` 平移 −25，不带视差应为 −16.67；透视粒子的偏移和正交相同。`p5a-kinds`：跟随粒子的出生点正好是不含视差的反投影点 |
| 初值 | 加载时 P = (W/2 + 2, H/2 + 2)，`g_ParallaxPosition` = (0.5, 0.5)，开场从这里按 k 滑向目标。多出的 2 是 WPE 相机的缺省 eye：加载末尾按 `[G+0xf0]` + (W, H)·0.5 写初值（`0x14018870c`），那时场景的相机还没套进 `G+0xf0`，用的是函数开头写的缺省 (2, 2, 2)（`0x140186db3`）。之后每帧的目标点用真实的 eye，所以这 2 像素只在开场、按 k 衰减。P 归渲染器：重编译保留，渲染器第一次加载时才取初值 | **推翻读码**（读码是场景中心）：收尾走查 `p5a-wk-prop` 把开场残差按各帧 k 折回第 0 帧，四次都是 (2.00, 2.00)，再由 REA 反汇编查清。对齐后 P 和 WPE 反推值差 ≤ 0.001；步骤 2 的 `delay 2.9` 回放差 1 像素就是它 |
| 开关关掉 | `cameraparallax` 关着时 P 不推进（冻结），`g_ParallaxPosition` 保留上一次的值（加载时是 (0.5, 0.5)），不加平移。再打开时 P 从冻结的值接着走，不回中心 | 实测 `p5a-wk-noplx`：没开视差时 `g_ParallaxPosition` 恒为 (0.5, 0.5)。`p5a-wk-prop` 运行中关、开：关着时偏移 0、uniform 不变；「关着照常推进」差 78 像素，「再开时回中心」差 778 像素 |
| 属性与脚本 | `cameraparallax*` 四个字段在 `GENERAL_FIELDS` 里，渲染器每帧读 `SceneState.general`，绑属性就地写。推进 P 用脚本之前的值；绘制时的开关与 `amount` 取脚本之后的值（WPE 绘制时才读，读码 6.3）。`parallaxDepth` 是图层字段：编译期缺省 (1, 1) 并登记绑定，绑属性就地写，挂 `{script}` 的字段脚本写回到它，`thisLayer.parallaxDepth` 读写是 `Vec2`。它和 `origin` 一样整棵子树标脏（子孙的偏移看根）；绑单个数字的属性时铺满两个分量 | 实测 `p5a-wk-script`：6 帧都用这一帧写的 `amount` 与深度画；`p5a-wk-prop`：绑滑块 0.6 时深度 (0.6, 0.6)，运行中改成 0.3 就地生效、不重新加载 |

能力表不再报 `general:cameraparallax`、`uniform:g_ParallaxPosition`，`thisLayer.parallaxDepth` 从脚本 API 缺口表里删掉。

### 抖动

| 项 | 规则 | 依据 |
|---|---|---|
| 公式 | `e = powf(roughness, 3)`；`T = speed²·g_Time`（场景时间，已回绕）；`v = (cos T, sin 1.333T)`（正交时 z 清零）；`0.001f < e` 且 `e ≠ 1` 时把 v 的长度 L 换成 `L^e`、方向不变；`s = v · 0.01·amplitude·H`（`render/shake.ts` 的 `shakeOffset`）。没有随机源，也没有跨帧状态，给定 `g_Time` 就能复现 | 读码 5（`FUN_140199580`）；实测 5 组各 4 帧，`g_EyePosition` 的偏移和公式差 ≤ 1e-4；`roughness 2`（e = 8）改了长度，0.05 不改 |
| float32 | 每步按 `Math.fround` 取整，比较的常量也是 `0.001f`。`roughness 0.1` 时 `powf(0.1f, 3)` 正好等于 `0.001f`，「e > 0.001」为假，不改长度；按 double 算会进改长度的分支，差约 2.5 像素 | 实测 `p5a-shaker01`；单测 `render/shake.test.ts` 能区分两种算法 |
| s 进哪里 | eye 和 center 加同一个 s，正交视图就是 `T(−s)`。每次绘制的视图投影是 `VP · T(o − s)`（没开视差时 `VP · T(−s)`），透视粒子也一样。`g_EyePosition` 是 `(W/2 + sx, H/2 + sy, 2000)`，拖尾判退化的眼位（`trailEye`）读同一个值；视差目标点的 eye 就是 s | 实测 `p5a-shake*`：图层整体平移 −s；`3830255100` 的 `g_EyePosition` 偏 (8.717, 10.165)，17 个对象按「抖动 + 视差点」预测全部吻合 |
| 时机 | 帧开头按本帧 `g_Time` 和脚本之前的字段算，脚本写 `camerashake*` 下一帧生效。粒子步进之后才交给场景（`setCamera`），所以粒子模拟用上一帧的 s；加载后第一帧的模拟与预热用 s = (0, 0) | 读码帧顺序；实测 `p5a-shakepar`（见「一帧里的顺序」）。预热那一条是推断，见「已知差异」 |
| 刷新 | `setCamera` 只改场景级的视图投影、透视粒子视图投影与眼位；全部 draw 的重写和视差合在一次，在 `setParallax` 里。`g_EyePosition` 为此进了 `LAYER_UNIFORMS`。关着时 s 恒为 0，矩阵与眼位逐字节同以前 | — |
| 透视场景 | 透视下幅度是 `0.1·amplitude` 个世界单位、偏移是三维的，P5d 步骤 2 实现（`shakeOffset3`，加在相机 eye 上），不再报 `general:camerashake`，见「透视相机、相机对象与深度（P5d）」 | 读码 5；实测 `p5d-shakep` / `-shakep-r` |

### 缩放

| 项 | 规则 | 依据 |
|---|---|---|
| 投影 | 正交投影绕场景中心缩放，即 `S(zoom) · P`：x、y 的线性项是 `zoom·2/W`、`zoom·2/H`，按 float32 乘（`layout.ts` 的 `sceneViewProjection(general, zoom)`）。视差偏移与抖动都是场景单位，在缩放之前加，方块的矩阵 = 缩放后的正交投影 · `T(o − s)` | 读码 p3-script-REPORT L2（`0x14017fd50`）；实测 `p5a-zoom15` / `zoom08` 线性项逐位相等，`zoompar` 偏移误差 0，`zoomx*` 差 1e-7 |
| 相机 zoom | WPE 乘的是 `general.zoom × 相机 zoom`。P5a 没有相机对象，相机 zoom 恒为 1；P5d 步骤 3 接上相机对象后正交场景里乘上它的 `zoom`（透视场景不起作用） | 读码；实测 `p5d-camo-r` |
| 透视粒子 | 相机距离随缩放变：`d = (H/(2·zoom))/tan(fov/2)`，far 仍是 `max(15000, d + 1000)`（`particleViewProjection(general, zoom)`） | 读码 7.2；实测 `p5a-zoomx15` / `zoomx08`：3 帧 MVP 和 WPE 逐项差 < 1e-4，按不带缩放的 d 差上百 |
| 不随缩放变 | `g_EyePosition`（只带抖动）、视差点与 `g_ParallaxPosition`（按场景宽高）、`g_PointerPosition` | 实测，同上 |
| 跟随指针 | 控制点的指针反投影用带缩放的投影，同样是上一帧交给场景的 | 实测：跟随粒子出生点误差 ≤ 3e-4，不带缩放差几百像素 |
| 时机 | 和 s 同一时刻取（脚本之前），一起交给 `setCamera`，`zoom` 变了才重算两份基准矩阵。脚本在第 f 帧写 `zoom`：第 f + 1 帧的画面用它，第 f + 2 帧的粒子模拟才用它。建场景时取编译期的值，预热的反投影带上它 | 实测 `p5a-wk-zoom3`（`zoom` 按帧号 mod 3 轮换）：画面 9 帧都是上一帧写的，跟随粒子 12 个新生点都按两帧前写的 `zoom` 反投影，差 ≤ 2e-4 |
| 字段与能力表 | `zoom` 进 `GENERAL_FIELDS`（float，缺省 1），绑属性就地写，`thisScene.zoom` 能读写（从脚本 API 缺口表删掉）。能力表只在正交场景、不绑属性、解析出的值 ≤ 0 时报 `general:zoom`（投影退化、反投影是 NaN），绑属性时不看值；透视场景里 `zoom` 不起作用（读码 1.4：读取点都在正交分支），不报 | 读码；语料最小 1.0 |

### 开场指针

视差点、`g_ParallaxPosition` 和跟随指针的粒子都要从第一帧起就用真实光标。WPE 每帧 `GetCursorPos`，加载第一帧就用真实光标。我们的宿主原来只在收到 `pointermove` 时更新指针：预览 iframe 开场收不到，桌面鼠标转发只在光标移动时注入。所以打开后视差停在中间，鼠标动一下才滑过去（2026-11-11 真机走查发现，跟随指针的粒子同样受影响）。现在让宿主一开始就拿到一次真实光标：
- **只在可交互时**：应用页 `WpeSceneView`（预览与桌面共用）在 `interactive` 时，于 iframe `load` 与宿主 ready 各调一次 `wpe_scene_cursor`。非 `interactive`（应用背景、不交互的预览）照旧不给指针，视差目标点就是场景中心加 s，只剩静止偏移。
- **Rust**：`wpe_scene_cursor` 在 `src-tauri/kabegame/src/commands/wpe_scene.rs`，`wpe` feature 下注册。换算在 `tauri-plugin-cursor` 的 `position_in_window`（2026-11-15 起）：Windows 用 `GetCursorPos` + `ScreenToClient`，再除以 `dpi/96`，得到光标在调用方窗口客户区的 CSS 像素，和鼠标注入同一套坐标；macOS 也有（未实测），Linux 返回 `null`。问 Rust 而不只用父页面记的鼠标位置，是因为桌面壁纸窗口的页面收不到鼠标事件，只有注入给 iframe 的。
- **应用页**：按 iframe 的显示矩形换成 iframe 内的归一化坐标，不钳制（`wpeSceneStyle.ts` 的 `scenePointerIn`），经 `kabegame:wpe-scene-pointer` 交给宿主。命令返回 `null`、出错，或在 Web / Android 上时，退回本页最近一次 `pointermove` / `pointerdown`，也没有就不发；等命令期间换了宿主也不发。
- **宿主**：`sceneStyle.ts` 只认父窗口发来的可信消息，当一次 `setPointer`；收到过真实 `pointermove` 之后，初值作废（`scenePointerFeed`）。`SceneHost` 记住最近的指针，渲染器建好时先于 `load` 带进去，`load` 按新场景的铺放换成 `g_PointerPosition`，所以预热与第一帧就用它。

实测：
- 主窗口：`wpe_scene_cursor` 返回 (355.3333, 436)，和页面最后一次 `pointermove` 相同。
- 预览 iframe（「超市冰箱八奈见」）：按初值算法算出 (0.500042, 0.499611)，宿主收到的真实 `pointermove` 是 (0.499999, 0.499092)，差 < 0.4 物理像素。

数据流的其它部分见 [PARTICLES.md](PARTICLES.md)「粒子（P4c）」的「指针」。

### 前置几条

| 项 | 规则 | 依据 |
|---|---|---|
| JSON 注释 | WPE 用 jsoncpp 读 JSON，缺省允许注释。`parseWpeJson`（`compile/model.ts`）严格解析失败时先去 `//` 行注释与 `/* */` 块注释（字符串里的原样保留），再去尾逗号 | 实测：带 `//` 注释行的材质照常加载（步骤 0）；整行与行内的 `/* */` 同样（收尾走查 `p5a-wk-prop` 的方块 F）。语料只有 fantasticcar 的 `materials/car/glass.json` 一处 |
| 深度写入 | translucent / additive 的 pass 一律不写深度，`depthtest: disabled` 也连带不写。这两种情况下 `depthwrite: enabled` 中性、不报（`features.ts` 的 `writesDepth`）；其余原先照报 `depthwrite:*`，P5d 步骤 1 起有深度附件、统一实现，不再报 | 读码 rea-p5-mesh 3.4；实测：translucent / additive 写 `enabled` 时深度开、不写、GREATER，normal 时开、写，`depthtest: disabled` 时深度关 |
| `cropoffset`、对象 `config` | 中性。`cropoffset` 是编辑器裁掉透明边后的偏移，导入时已经并进 `origin`（`wallpaper64.exe` 里没有这个字符串）；对象 `config` 只在托盘与播放列表代码里读 | 实测：写了 `cropoffset "100 100"` 的层、带 `config.passthrough` 的层都画在原点，和对照层相同 |
| 模型 JSON 的布尔键 | `fullscreen`、`nopadding`、`autosize`、`passthrough`、`solidlayer`、`projectlayer`、`instanced` 只认 JSON `true`（`modelFlag`），写成 1 或字符串等于没写；能力表和 `bundle.ts` 读 `solidlayer` 用同一个判断 | 读码 rea-p5-modelflags §7；实测：`fullscreen: 1` 的层照常按 60×60 画在原点 |

语料里模型布尔键全写成 `true`，带注释的 JSON 只有 fantasticcar 一个，所以收紧与注释支持都不改变已有结果。

### 已知差异与只记不补

- **`delay > 3`**：k 为负，P 越走越远。照公式实现，没有实测；语料的 `delay` 最大 2.0。
- **预热时的抖动**：预热与加载后第一帧的粒子模拟用 s = (0, 0)。依据是推断：模拟用上一帧的相机，加载时还没有更新过相机。t = 0 时抖动偏移是 (amp, 0)，不是 0；语料里同时开抖动和跟随指针的场景很少，只记不补。
- **重编译时的 `zoom`**：预热与第一帧的模拟用编译期的 `zoom`。属性改 `zoom` 是就地写、不重编译，只有因别的原因整场重编译、而状态里的 `zoom` 已经改过时才碰得到。只记不补。
- **`zoom` ≤ 0**：运行中改成 ≤ 0 时投影退化、出现 NaN，不处理；能力表只拦编译期的常量（语料最小 1.0）。
- **`alignmentfliph`**：水平镜像时 WPE 把 `mx` 换成 `1 − mx`、`g_ParallaxPosition.x` 翻转。没实现，语料 0 张。
- **命中测试的视差偏移**：WPE 按对象自身（不按根）算，没做，归 W4 的按图层命中。
- **透视场景开视差**：WPE 不移动对象（读码，语料 0 张）。P5d 步骤 2 已核对：不移动对象，`g_ParallaxPosition` 开视差时是 NaN（不是钳成 0，推翻读码的推断），见「透视相机、相机对象与深度（P5d）」。
- **壁纸属性 `cameraparallax`**：WPE 设置里给单张壁纸的开关，只把 `mouseinfluence` 归零，静止偏移不变。Kabegame 没有这个开关，按缺省（开）处理。
- **首帧的 `g_PointerPositionLast`**：开场指针之后，首帧的 `g_PointerPositionLast` 仍是 (0.5, 0.5)，和初值之间有一次跳变；WPE 首帧没有核对。
- **P 的精度**：我们用 double 算 P，WPE 存 float32；按 float32 复算差为 0（`fit_delay.py`），接受。

### 语料与解锁

| 步骤 | 去掉的键 | 能渲染 | 新解锁 |
|---|---|---|---|
| 1 前置 | `model:cropoffset` 34 张、`object:config` 14、`depthwrite:enabled` 5 | 23 → 24 | `3778549173` |
| 2 视差 | `general:cameraparallax` 41、`uniform:g_ParallaxPosition` 16、`script:api:layer.parallaxDepth` 1 | 24 → 35 | `2272499163`、`2279259068`、`2381978484`、`2382002554`、`2382120706`、`2382121137`、`2570822804`、`2955749185`、`3000769374`、`3445915391`、`3818481122` |
| 3 抖动 | 正交场景的 `general:camerashake` 7 | 35 → 36 | `3830255100` |
| 4 缩放 | `general:zoom` 6 | 36 | 不单独解锁：这 6 张还被别的键挡着（`2887099508` 的 `zoom` 是关键帧，报 `value:animation`） |

- 每步都不新增键，没有场景不再能渲染。起点是 23 而不是子计划开头写的 22，因为同期 P4d 解锁了 `2254685070`。去掉 `depthwrite:enabled` 的 5 张逐个材质核对过，都属于中性情况。
- **解锁的场景**：
  - 步骤 2 的前 10 张是同一类模板：1–2 个图像层，其中一个带 effect，深度 `0 1` 或 `0 2`，只在纵向动；原点都在场景中心，静止时没有偏移。
  - `3818481122` 的唯一图层深度 (0, 0)、不动，它的 `depthparallax` effect 读 `g_ParallaxPosition`。
  - `3830255100` 有 14 个图像层和 3 个粒子，原点偏离中心几百像素、深度 0.44–1.87，`mouseinfluence` 只有 0.04。它是检验「静止偏移」与抖动的真实样本。
  - `3778549173` 只差一个粒子 pass 的 `depthwrite: enabled`：这个 pass 是 translucent、`depthtest: disabled`。
- **和 WPE 比**：
  - `3778549173`（2560×1440 窗口、fps 20）：静态部分没有一个像素比 WPE 暗，96.86% 完全相同，更亮的 2.65% 是粒子；按均匀帧时间回放粒子，灰烬 2306 对 2306–2316，尺寸、透明度、颜色范围逐位相同，雪花、光晕相近。
  - `2381978484`、`3445915391`、`3818481122`（步骤 0 的 1344×756 抓帧）：按回放渲染整幅场景，照 WPE 的居中裁切缩到同一尺寸，相位相关估计的平移都是 (0, 0)，平均像素差 0.6–2.3（缩放重采样）。`2381978484` 的视差偏移在这个尺寸下约 67 像素，所以这个比较能检出视差错误。
  - `3830255100`（1920×1080）：按 WPE 各层的偏移反推，17 个对象给出同一个视差点（离散 0.001 像素），抖动和 `g_EyePosition` 差 1e-4；按同一 `g_Time` 回放渲染，平均差 0.96，大于 32 的像素占 0.038%（只在轮廓线），5 块区域的平移都在 0.08 像素以内。
- **真机走查**（2026-11-11 用户）：预览里移动鼠标、壁纸样式、桌面壁纸跟随、暂停与应用背景都和预期一致；桌面上光标停在别的窗口上移动时也跟随，和 WPE 相同（Windows 的鼠标转发是轮询光标）。开场原先停在中间，补了上面的「开场指针」后在预览里确认。
- **基线**：10 张原本能渲染的场景 × 三档后处理，共 30 个画面哈希，在步骤 2、3、4、视差点初值对齐与逐帧光标之后各量一次，都和之前的基线相同。基线里没有开视差的场景，所以初值对齐只能说明没改坏别的，对不对靠上面的数值核对。

### dev 探针与对比台的增补

| 探针 | P5a 增补 |
|---|---|
| `renderFrame` | 从加载起逐帧推进视差点与抖动：每帧按 `g_Time` 现算 s，粒子先用上一帧的相机步进，再设本帧的，读回帧带视差与 `g_ParallaxPosition`（步骤 2–4）。收逐帧指针 `pointers`（和 `particles.dts` 等长，不能和 `pointer` 同给）与抓帧窗口 `window`：第 i 帧的 `g_PointerPosition` 取 `pointers[i]`，`g_PointerPositionLast` 取 `pointers[i − 1]`，视差点逐帧用它；控制点光标按 `fill` 从窗口换到场景上，窗口和场景同尺寸或没给 `window` 时原样用（收尾前） |
| `particleCorners` | 同 `renderFrame`。两者「回放到读回帧」的部分合成一处（`replayReadback`），窗口指针的换算在 `dev/replayPointers.ts` |
| `particleTrack` | 跟随点带上一帧的 s 与 `zoom`；`cursors` 收 `window`，按 `fill` 换到场景上 |
| 不给新字段时 | 三个接口逐字节同以前（`kbp regress --corpus` 与画面哈希核对过） |

**回放逐帧光标**（收尾前补的工具）。起因：WPE 开窗后光标在动，跟随指针的粒子、视差点都复现不了，而 RenderDoc 轨迹只有被抓的那几帧有指针。所以光标从测试工程自己的脚本日志取，和 WPE 的帧天然对齐：
- **日志**：kbp-tools 生成库 `write_project(…, cursor=True)` 时，FR 用 `FR_CURSOR`，`[kbp]` 条目是五列 `帧号,帧时间,累计时间,屏幕x,屏幕y`。屏幕坐标是 `input.cursorScreenPosition`，每 10 条刷一次，取不到写 `nan`。缺省仍是三列，旧工程逐字节相同。这类工程在 Kabegame 里编译报 `script:api:input.cursorScreenPosition`（`input` 留给 P6），dev 强制渲染不受影响。
- **时间线**（kabegame-dev MCP 的 `apps/kabegame-dev-mcp/src/timeline.ts`）：新增 `cursors: "log"`，第 f 帧光标 = float32(日志第 f 帧的屏幕光标 / 窗口尺寸)，缺的帧沿用相邻帧并列出来，抓到的帧上和轨迹的 `pointer` 逐帧核对。`window` 缺省从轨迹或日志标签末尾的 `-<宽>x<高>` 读。`"track"`、整串、`cursor` 的单位统一成 `g_PointerPosition`（窗口归一化）。`render_scene`、`particle_corners` 把光标作 `pointers` 连同 `window` 交给探针，`particle_track` 交 `cursors` + `window`。`kbp replay` 案例的 `inputs.cursors` 同样收 `"log"`。
- **依据**：`p5a-cur` / `p5a-cur3` 实测 `cursorScreenPosition` 是壁纸窗口内的像素、y 朝下、不钳制，`g_PointerPosition` 逐位等于 float32(屏幕光标 / 窗口尺寸)。脚本、uniform、粒子模拟用的是同一帧的同一次采样：按日志第 f 帧回放第 f 帧，491–495 个跟随粒子差 ≤ 2.4e-4，错一帧差 340 像素。
- **端到端**：`p5a-shakepar2`（用户在窗口上画圈时抓帧）经 `render_scene`（`cursors: "log"`）整帧和 WPE 比，FR 块外 0 差异，跟随粒子与透视粒子 1800 个白色像素全部相同。

对比台在 `ignore/p5/`：
- 确定性工程：`a0/gen_a.py`（步骤 0 的 `p5a-*`，之后各步按 1920×1080 窗口重抓）、`cur/gen_cur.py`（`p5a-cur*`）、`wk/gen_wk.py`（收尾走查的 `p5a-wk-*`），工程放在 `proj/`。
- 读数：`a0/rdc_dump.py` 在 `qrenderdoc --python` 下无界面导出整批抓帧的常量，`ana_a.py` / `ana_pre.py` / `ana_real.py` 核对。
- 各步的快照、补丁、语料比较与整帧比对在 `s1/`–`s4/`（`cmp_frames.py`、`follow_cmp.py` 等），逐帧光标在 `cur/`，开场指针在 `ptr/`，收尾走查在 `wk/`。
- WPE 参照：步骤 0、1 在 `A:\p5a\`，之后在 `A:\p5a2\`（wpe-renderdoc MCP 的 `capture_wallpaper` / `capture_sweep`）。

## 透视相机、相机对象与深度（P5d）

P5d 改的是整场的投影与深度，分三块，依赖方向是单向的：深度与剔除是底座，透视相机在它上面，相机对象再在相机上面；透明排序（步骤 4）是透视场景里绘制顺序的一处规则，单独成步。核心做法有三点：
- **深度与剔除对所有对象一套规则**，不分正交与透视、不分图层种类：场景目标挂一张 `depth32float`，缺键时 `depthtest`、`depthwrite` 为开、`cullmode` 为 normal。画进合成 RT、effect fbo、泛光的 pass 不挂深度，所以同一个材质按「目标有没有深度」各建一份管线。
- **透视场景没有场景分辨率**：按画布尺寸渲染、整张铺满、壁纸样式不起作用；画布分辨率变了就整场重新加载，不给 `GpuScene` 写 resize。相机每帧求值，来源是「相机对象 > 路径 > 基准字段」再加抖动；透视只换场景级的视图投影，图像层、粒子、模型、合成链用的矩阵与正交场景同一套。
- **相机对象不是新的图层种类**：它没有内容键，编译期本来就作为分组节点进 `layers`，层级、可见性、`origin` 上的脚本都现成可用，P5d 只让它每帧驱动相机。

依据：
- 读码：[rea-p5-camera](../../../.claude/plans/wpe-import/3-scene/phase5/rea-p5-camera.md) 1–5、8 节（透视、路径、相机对象、uniform）与 [rea-p5-mesh](../../../.claude/plans/wpe-import/3-scene/phase5/rea-p5-mesh.md) 3、4 节（深度、剔除、排序）。
- 实测：[报告](../../../.claude/plans/wpe-import/3-scene/phase5/p5-REPORT.md)「P5d 语义的实测核对」及其后的步骤 2、3、4 补测。20 个确定性工程加三张目标样本，读码的结论全部成立，推翻一处（透视开视差时 `g_ParallaxPosition` 是 NaN，不是钳成 0）、更正一处（sprite 面向相机）、补了两条读码没写的规则（带 effect 的上屏 pass 剔除取 effect 材质、`clearenabled: false` 时深度也不清）。
- 逐步的验收数据：[子计划](../../../.claude/plans/wpe-import/3-scene/phase5/phase-5d-camera-depth.md)「步骤 1–4 实施记录」「步骤 3 补充」「收尾」。下面每条只点出依据，数字和例外以子计划为准。

验收：确定性工程按 WPE 日志回放到抓到的那一帧，和 WPE 抓帧整帧逐像素比（`kbp cmp frame`）；真实壁纸做复制工程（`kbp content isolate`）后同样比；每步另做变异检查与 10 张基线场景 × 三档后处理的画面哈希。

### 深度与剔除（步骤 1）

| 项 | 规则 | 依据 |
|---|---|---|
| 深度附件 | 场景目标一张 `depth32float`（`SCENE_DEPTH_FORMAT`），每帧清 0、比较 GREATER（反向 Z）；`clearenabled: false` 时颜色与深度都不清。两张交替的场景目标共用这一张，尺寸在 `populate` 定死，改尺寸整场重建 | 实测 `p5d-depth`（12 组）、`p5d-depth2`（6 组）；`p5d-noclear`：静止的写深度模型第二帧起不再画 |
| pass 的深度状态 | `depthtest: disabled` 不测不写；否则测，只有 normal / alphatocoverage 且 `depthwrite` 不是 disabled 才写（translucent / additive 只测不写）。缺键为开，非法值取 disabled（`compile/` 的 `normalizeDepthKeys`，`programs.ts` 的 `depthFlags`）。管线标签带 `depth:<t\|-><w\|->` | 实测 `p5d-depth`：每次绘制的深度状态逐个对上，屏幕上重叠的几组遮挡对上；`depthtest: "yes"` 落到不测 |
| 画到哪里才挂深度 | 只有画进场景目标的 pass：图像层直接上屏、带 effect 图层的上屏 pass（深度键借基础材质）、粒子、文本、模型。合成 RT、effect fbo、泛光不挂；组的局部正交里的子孙也不挂。null 混合（`base` / `compose`）按 normal 算，深度两项对它们不起作用 | 实测 `p5d-depth-o`：基础 pass 画进合成 RT 时没有深度，带 tint 的图层末 pass 测不写 |
| 剔除 | 缺键与 `normal` 剔背面、正面逆时针，只看屏幕绕序（镜像的被剔，不补偿）；非法值取 normal；`nocull` 不剔。图像层、粒子、模型一样；带 effect 的图层基础 pass 用基础材质的剔除（画进合成 RT 的四边形不镜像、照常画），上屏 pass 用 effect 材质自己的 `cullmode`。`frontFace` 不用改：图层四边形、合成 RT 里的基础 pass、全屏 / NDC 四边形、组的局部正交、形状、粒子四角未镜像时都是逆时针 | 实测 `p5d-cull`：`scale −1`、镜像父层、绕 y 转 180° 的图层与镜像的粒子系统被剔；`p5d-depth2`：透视场景同样 |
| 能力表 | 删 `cull:normal`、`depthtest:enabled`、`depthwrite:enabled`；ricepod 拼错的 `depthtesting` / `depthwriting` 不是已知键，照报 `material:*`（WPE 不认、等于缺键，没测）。`ScenePass` 的三个字段仍是 `string`，窄类型在 `normalizeDepthKeys` 的返回值里 | — |

### 透视相机（步骤 2）

| 项 | 规则 | 依据 |
|---|---|---|
| 投影类型 | 一处判定：`general.orthogonalprojection` 是对象且 `auto: true` 或宽高都非 0 才是正交，结果进 `SceneGeneral.perspective`，能力表、`SCENE_ORTHO` 宏、粒子缺省值、渲染器都读它。透视场景的 `SceneGeneral.width/height` 是 WPE 的 0（脚本 `engine.canvasSize` 读到 (0, 0)，没测，语料 0 处）；`auto: true` 的正交场景仍是占位 1920×1080，没动 | 读码 rea-p5-camera 2.1 |
| 透视矩阵 | `PerspectiveFovRH`：竖直 fov（度，缺省 50，钳到 [0.1, 179.9]）、反向深度（m22 = n/(f − n)、m23 = −1、m32 = n·f/(f − n)）、宽高比取场景目标（就是画布）；`nearz` 缺省 0.1、`farz` 缺省 10000，三者每帧读（`GENERAL_FIELDS`，属性与脚本写入就地生效）。`zoom` 在透视里不起作用 | 实测 `p5d-persp`：m00 1.206285、m11 2.144507；1280×1024 窗口 m00 = 1.715605、m11 不变；`p5d-persp-b`（fov 30、nearz 1、farz 100）：m11 3.732051、m22 1/99 |
| 精度 | 透视相机三段都逐步 float32，结合顺序照汇编：路径段内插值是 Hermite 四项 `((m0·h10 + h00·p0) + m1·h11) + h01·p1`（切线 (p1 − p0)·0.5，s = (t − t0)/(t1 − t0)）；lookAt 先求 `1/√((x² + y²) + z²)` 再乘，叉积与平移的点积按固定顺序，长度为 0 时得 NaN（同 WPE）；投影的 sin / cos 是 DirectXMath `XMScalarSinCos` 的多项式（sin 11 次、cos 10 次，常量按 exe 位模式，`render/camera.ts` 的 `xmScalarSinCos`），不是 `Math.sin/cos`，Height = cos/sin、Width = Height/aspect、`range = n/(f − n)`、`m32 = range·f` | 汇编 `0x14019d920`（lookAt）、`0x14009a360`（投影，调用方 `0x140183edf` 核对 n / f）、`0x1401894b5`–`0x1401899b1`（路径，符号执行出运算树）；P13c 走查 ricepod 时 VP 差到 131 ULP、改后第 2223 帧逐 draw 0 ULP，5 帧没有差 > 1 的像素；`p5d-path` / `-persp` / `-persp-b` / `-tilt` 回归逐像素相同 |
| 按画布尺寸渲染 | 场景目标取画布像素（2026-11-19 起含显示缩放，和正交场景同一个口径；之前是显示缩放为 1 的 `fullResolution`），超设备上限时等比缩；`engine.screenResolution` 仍是显示缩放为 1 的画布尺寸。上屏整张铺满、样式不起作用，指针按窗口坐标原样用（同 `fill`）。fullscreen 图层的合成 RT 槽 0 是运行时 RT 或没有纹理时 `fullscreenSize` 记成 `"scene"`，渲染时取场景目标尺寸 | 已定 6；实测 `p5d-2d` |
| 分辨率变化 | 2026-11-19 起同 WPE：尺寸稳定 300 ms 后 `GpuScene.resize` 原地换（只重建 RT，粒子、脚本接着跑），失败才整场重新加载（`onResizeFailed`）。之前是 `onRenderSizeChange` 整场重新加载、粒子重新预热 | 单测（`render/productSize.test.ts`、`p5d-camera.test.ts`）；全库探针「建 A 换 B」=「建 B」 |
| 基准相机与路径 | `scene.json` 顶层 `camera`（`compile/camera.ts`）：`eye` / `center` / `up` 是字符串时按空格 `atof` 三次、缺分量为 0，不是字符串保留构造值 (2, 2, 2) / (0, 0, 0) / (0, 1, 0)；`paths` 指向的文件容错照读码（不是对象或 `transforms` 空就 `break`、`disabled` 跳过、缺 `timestamp` 按 i/(n−1)·duration 铺开、缺向量为 0、缺 `zoom` 为 1）。求值是纯函数（`render/camera.ts` 的 `stepCameraPath`）：段内 `p0 + (p1 − p0)·(−s³ + 1.5s² + 0.5s)`，两端切线 (p1 − p0)/2、不乘段长；每帧先求值再 `t += dt`；切到下一条时 t 归零、余量丢掉；按文件顺序循环。路径状态归渲染器，整场重编译保留，补画帧 dt 为 0、不推进 | 实测 `p5d-path`：第一圈按 t = `g_Time` − dt 闭式求，和 `g_EyePosition` 逐位相同；第二圈（两次切换之后）按日志里逐帧的 dt 推状态机，能核对的 6 帧差 ≤ 3.7e-6（float32 累加） |
| 三维抖动 | 偏移 = `0.1·amplitude·v`，v = (cos T, sin 1.333T, sin T)（`shakeOffset3`），长度指数作用在三维长度上，float32 逐步（`roughness 0.1` 同 P5a 在临界上）；eye 与 center 同移，`g_EyePosition` 含它。正交的 `shakeOffset` 不动 | 实测 `p5d-shakep`、`p5d-shakep-r`；`p5d-shakep-r` 与单测覆盖三维抖动 |
| 视差 | 透视场景不移动对象；`g_ParallaxPosition` 照 WPE 的算式（W = H = 0、P 初值 0，`clamp01` 保留 NaN）：开视差时是 (NaN, NaN)，不是钳成 0；不开时是加载时的 (0.5, 0.5)。eye.xy 用透视相机的 eye | 实测 `p5d-persp-b`：`zoom 2`、开视差、对象 `parallaxDepth 1 1`，VP 只随 fov 变、各对象 MVP 没有平移；推翻读码的「钳成 0」 |
| 视图向量与 `g_EyePosition` | `g_ViewForward` / `Right` / `Up` 进 `ENGINE_UNIFORMS`，所有 pass 都写：世界空间的 V 列（行向量约定下 V 的第 2 列取负、第 0 列、第 1 列；正交下常量 (0, 0, −1) / (1, 0, 0) / (0, 1, 0)）。`g_EyePosition` 是 eye（含路径、相机对象、抖动）。粒子的 `g_ViewUp` / `g_ViewRight` 与 screen 朝向（`F = −视线`）都用相机的，**sprite 面向相机**（更正步骤 0「按对象朝向」的说法）；upright 朝向用相机视线算 | 实测 `p5d-tilt`（斜相机 eye (6, 4, 10)）：三个视图向量逐项对上；dna_fragment 抓帧里 `g_OrientationForward` = (0.691, 0.494, 0.528) 正是 eye − center 的单位向量 |
| 透视场景里的对象 | 普通图像层、粒子、模型、合成链和正交场景同一套矩阵，只把场景视图投影换成 `P·V`：图像层 MVP = VP · W，合成链基础 pass 用合成 RT 自己的正交（z 系数 1/2000）、末 pass 用场景 VP · W，fullscreen 与相机无关（NDC 正交）。模型的视锥剔除、粒子的指针反投影都从同一个 `GpuScene.viewProjection` 取 | 实测 `p5d-persp`、`p5d-2d`、`p5d-ptc` |
| 求值时刻 | 同 P5a 的抖动：帧开头算、粒子步进之后交给场景（`setCamera`），粒子模拟用上一帧的相机；建场景时先按加载时的相机（路径起点、`g_Time` 0）算一份给预热与第一批 uniform，第一帧就换成当帧的 | 读码帧顺序 |
| `SceneCamera` | 两种：`orthographic`（`kind` 可省，现状的一份）与 `perspective`（V、P、eye、视图向量一份预先算好的帧）；`SceneGeneral.perspective` / `camera` 写成可选，不动手写的测试夹具 | — |

照报的细分（只在透视场景报）：
- `camera:perspective:particle`（粒子系统树里有 `flags & 4`，宽高是 0 时覆盖的 fov 退化，步骤 0 只测了 MVP）、`camera:perspective:image`（图像层 / 模型 `perspective: true`）、`camera:perspective:projectlayer`（`autosize` + `projectlayer`，W = H = 0）、`camera:perspective:shape`（形状对象）；文本（`…:text`）与带子层的组合层（`…:group`）P13h 起支持，见「透视场景的余项（P13h）」；
- `camera:paths:unreadable`（路径文件读不到或不是 JSON）、`camera:paths:orthographic`（正交场景 `camera.paths` 非空：读码说不重置相机、视图会平移，没测）。

### 相机对象（步骤 3）

| 项 | 规则 | 依据 |
|---|---|---|
| 判定 | 对象的 `camera` 键是字符串即相机（WPE 工厂的判定）。`SceneLayer.camera` 是 `{ fov, zoom } \| null`，编出来的图层一律填，缺省 50 / 1；`fov`、`zoom` 绑用户属性或挂字段脚本时登记成就地目标（`{ kind: "camera"; object; field }`，值落在 `SceneState.cameras`）。`path` 指向的条目动画文件读出非空 `paths` 或读不到报 `camera:path`（语料 22 个相机都是空表），`queuemode` 中性 | 读码 4.2；实测 `p5d-camp-*` |
| 选相机 | 共享函数 `sceneCameraFrame`（渲染器与 dev 探针都调，`cameraObjectLayers` 加载时取一次）：按 `object` 下标取最大的、自身与父链都可见的相机对象，与倒序遍历等价、不依赖 `layers` 顺序。eye = 世界矩阵平移列，center = eye − 第 2 列（看本地 −Z），up = 第 1 列。有活动相机时路径不推进；都不可见时回到步骤 2 的来源（路径 / 基准；正交场景是单位视图）。求值时刻同步骤 2 | 实测 `p5d-camp-2`：JSON 里靠后的 CB 生效；`p5d-camp-1`（CB `visible: false`）：CA 生效 |
| 正交场景 | 视图 V = `lookAtRH(eye + s, center + s, up)`（s 是正交抖动）、VP = `sceneViewProjection(general, general.zoom × 相机 zoom) · V`；平移是 −eye（**不是**内容在 0..W 的想法：11 张模板场景的图层本来就摆在 (W/2…3W/2, H/2…3H/2)，相机的 −(W/2, H/2) 正好挪回画面中间）；`g_EyePosition` = (eye.x + s.x + W/2, eye.y + s.y + H/2, 2000)；视图向量取 V；对象 `zoom` 绕场景中心缩放。整份预先算好的帧是 `OrthographicCameraFrame`（正交 `SceneCamera.cameraObject`）。没有可见相机对象时一行不变，仍走原来的分支保证字节不变 | 实测 `p5d-camo-c`（相机 (960, 540, 500)：VP 平移 (−2, −2)、深度 0.375、`g_EyePosition` (1920, 1080, 2000)）、`-o`、`-r`（`angles` 转视图、`zoom 2`）、`-0`（和没有相机时相同）；`p5d-camo-s4k`：相机放在 3840×2160 场景中心，WPE 的画面就是偏半屏，5 个色块的 NDC 与「视图平移 −eye」逐个相同 |
| 透视覆盖 | 透视粒子与 `perspective: true` 的图像层 / 模型在相机 V 上做：旋转不变，平移换成 (t.x − W/2, t.y − H/2, −d)，d 按含缩放的可见高算（`zoom 2` 时减半） | 实测 `p5d-camo-pp`（原点投到 NDC (−0.5, −0.5)、w = d = 494.82）、`-ppr`（旋转与 `zoom 2` 都保留）；按「覆盖不看相机」会落在 (+0.5, +0.5) |
| 视差点与抖动 | 视差点的 eye.xy 是相机的 eye.xy + s；抖动加在相机的 eye 上 | 实测 `-par`（5 个色块的 MVP 与 `o = amount·depth·(origin − P)` 差 ≤ 1.2e-7）、`-shake`（差 ≤ 1.3e-7） |
| 透视场景 | 来源姿态换成相机的（`perspectiveCamera` 只换 pose），fov 取相机对象的 `fov`（钳制），`zoom` 不起作用 | 实测 `p5d-camp-*`（eye (2, 0, 8)、m11 = cot 30°） |
| 能力表 | 删 `object:camera`、`object:fov`、`object:zoom`、`object:path`、`object:queuemode`。相机对象同时带别的内容键（图像、模型、粒子、声音、文本、灯、形状）时报 `object:camera:mixed`（不进 `cameras`、不登记 `fov` / `zoom` 目标，只读 `path`）；`camera:path` 的边界（空串、不是字符串、根不是对象都报，`paths` 不是数组按空表）；`fov` / `zoom` 挂关键帧仍报 `value:animation:camera`（P5i 起支持，见「相机对象上的关键帧（P5i）」）；图层上的 `fov` / `zoom` 字段访问仍在缺口表（`getCameraTransforms` / `setCameraTransforms` 由 P5e 实现） | 读码；语料 0 处 |
| 渲染器 | `scene.ts` 新增 `objectCamera` 标志：离开相机对象时不提前返回、视图向量复位；`same` 提成模块级函数 | 变异检查（「离开相机对象时提前返回」补用例后检出） |

### 透明排序（步骤 4）

WPE 的场景绘制只有一个开关会改顺序：透视场景里 `general.transparentsorting` 为 true 时分两遍。实现只落在 `GpuScene.encode` 顶层那一轮，组画子树、模型内部的网格顺序、粒子树先序、被依赖图层都不另处理（被依赖的图层跟着它自己在新顺序里的位置画）。

| 项 | 规则 | 依据 |
|---|---|---|
| 两遍 | 第一遍按 `objects` 顺序画不是半透明的对象；第二遍把半透明的按「**局部** `origin` · 视线方向」从大到小（由远到近）稳定排序后画（`render/sortOrder.ts` 的 `transparentDrawOrder`，键按 float32 算）。前向是当帧透视相机的视线（center − eye，带抖动、相机对象、路径）；`origin` 取脚本写回之后的当帧值。正交场景、开关关时逐字不变 | 读码 rea-p5-mesh 4.2；实测 `p5d-sort-a`（两遍的划分、脚本写的 `origin` 当帧生效）、`-off`、`-rot`（相机在 +x 看向 −x：J、L、K）、`-par`（局部 z −6 的 F 排在 H 前：用局部不是世界）、`-eq`（键相同保持原顺序）、`-ortho` |
| 键 −∞ | `fullscreen` / `projectlayer` 标志的半透明图像键是 −∞，排在最后，两者之间保持原顺序（组合层没有 effect 时本来就不画，所以实测用的是带标志的纯色模型） | 实测 `p5d-sort-fs` |
| 分类（`SceneLayer.sortClass`，编译期按 WPE 加载末尾置位的规则定，之后不变） | 粒子：`translucent`。图像层：基础材质第一个 pass 的 blending 是 normal / alphatocoverage 时 `opaque`，否则 `translucent`；模型标志 `fullscreen` 或 `projectlayer` 为真且是 `translucent` 时 `last`。模型：任一网格第一个 pass 的 blending 是 normal / alphatocoverage 时 `opaque`，否则 `translucent`（`isOpaqueBlending`，网格排序也改用它，结果不变）。不画的对象（分组、灯、声音、相机）不填。组合层、fullscreen、instanced、带 effect 的图层只看基础材质第一个 pass，effect、colorBlendMode、`copybackground` 不参与 | 实测 `p5d-sort-a`：normal 图像、normal 网格的模型在第一遍；translucent / additive 图像、网格全 translucent 的模型、粒子在第二遍 |
| 文本与形状 | 文本无条件 `translucent`（构造函数直接置位，rea-p6b-layout 1.1），形状记 `opaque`（形状工厂只调基类构造、加载路径不置位，读码 `factory_14018ff60` 等）。文本 P13h 起在透视场景照画（`p13h-text`）；形状仍照报 | 读码、P13h |
| 体积光的灯（P13h） | 灯构造即置半透明位，第二遍和半透明对象一起按局部 `origin` 排序；合成照旧在下一个可见的非灯对象之前或列表末尾（`FUN_14018aac0` 两遍各一处判定，末尾一处）。`encode` 把顶层图层与可见的体积光灯按对象表顺序合成一个序列交给 `transparentDrawOrder` | 实测 `p13h-vol`（局部键与世界键会排出不同顺序） |
| 开关 | `SceneGeneral.transparentSorting`（可选，`compileScene` 总会填）只认 JSON 布尔。绑属性、挂脚本时照报 `general:transparentsorting`，除布尔外的写法照报、正交场景也照报（保守）；`customsortorder` 照报 | 语料 0，没测运行中改开关 |

### 透视场景的余项（P13h）

P5d 照报的三项（透视场景里的文本、带子层的组合层、透明排序下的体积光）P13h 起支持，子计划 [phase-13h-perspective-rest](../../../.claude/plans/wpe-import/3-scene/phase13/phase-13h-perspective-rest.md)：

| 项 | 规则 | 依据 |
|---|---|---|
| 文本 | 透视场景、对象 `depthtest` 不是 disabled 时，字形 / 彩色字形 / 背景换成 `basefont_depth` / `basefontrgba_depth` / `fontbackground_depth`（`compile/texts.ts` 的 `TEXT_DEPTH_MATERIALS`）：只多测深度，translucent 不写；带 effect 的合成上屏借字形材质的深度键，同样测、不写；`composelayer_clearalpha` 不换。正交场景不读这个键 | rea-p13-lights 5.2；`p13h-text` 的四种用法整帧 0 差 |
| 组 | 照正交时的画法：子树按 `inverse(W_组)` 与组的局部正交画进合成 RT，组的基础 pass 与上屏用场景的透视相机，上屏深度借基础材质（`composelayer_depthtest` 测、不写）；`camera:perspective:group` 不再报（编译期与运行中成组都去掉） | rea-p13-lights 5.3；`p13h-group` 整帧 0 差 |
| 体积光 | 见上「透明排序」的「体积光的灯」 | `p13h-vol` / `-off` 整帧 0 差 |

走查：`3453730450` 复制工程（文本、组、体积光都在）10 帧整帧逐像素相同；`3509243656`（HDR）只有泛光光晕渐变上 ±1（WPE 后备缓冲 f16 量化）。

### 已知差异与只记不补

- **相机挂在每帧移动又每帧被画的父对象下时，WPE 隔帧刷新相机（有意不同，2026-11-16 用户定不修）**：
  - **WPE 的做法**：相机对象自己不被画，只在帧开头（脚本之前）按世界矩阵缓存戳（规则同 `render/worldStamps.ts`）求一次。父对象被脚本写变换时戳清 0，在脚本之后被画时重算，戳变成本帧号。下一帧开头，相机「戳 ≥ 父戳」判命中，返回上一次算的整份矩阵（平移和旋转都是旧的），于是相机每两帧才刷新一次。
  - **我们的做法**：相机每帧用当帧的父变换。
  - **触发条件**：相机父链上有对象每帧被脚本或关键帧移动，并且这个对象每帧被画。
  - **依据**：`3706286085` 的复制工程（P13f 走查，`phase-13f-fog-lights.md`「走查」）。奇数帧视点与 VP 逐位相同；偶数帧 WPE 的视点 = 第 f−2 帧末的父位置 + 本帧抖动，380–396 帧 6 位小数全同。
  - **为什么不复刻**：这是 WPE 的缓存缺陷，效果是镜头按半帧率顿挫，语料画面不依赖它。
- **产品先按场景分辨率画再缩**（2026-11-14 到 11-18，`FINAL_CHECK.md` 当时登记、不复刻；2026-11-19 方案 A 起产品按画布分辨率画，这一项不再有）：正交场景里场景分辨率 ≠ 窗口分辨率时，锐利边缘（月亮轮廓、图层硬边）缩小采样有差，最大差 35–90；放大采样（`zoom` 2 / 2.87）时最大差只有 12。dev 探针按窗口尺寸画时（[phase-render-size](../../../.claude/plans/wpe-import/3-scene/phase-render-size.md)「步骤 2」）：`3605722997` 三个相机整帧 0 差异；`3462279189` 四组每帧剩 49–117 个像素差 1，地板 effect 的 `g_EffectTextureProjectionMatrixInverse` 原先差 1 ulp（求逆的写法），2026-11-15 改成 WPE 的单精度求逆后常量逐位相同、这些像素一个没少（[phase-f32-inverse](../../../.claude/plans/wpe-import/3-scene/phase-f32-inverse.md)），归着色器求值的舍入，没有逐像素分开。
- **透视场景里图像层的视锥剔除只记不补**：WPE 在透视场景对图像层做视锥剔除（相机背后与视野两侧外的剔掉，远过 farz 的照样画），正交场景不剔；着色器乘 MVP 时这些图层本来就不在画面里，没有画面差别（`p5d-imgcull`、`-imgcull-p`）。只在不乘 MVP 的着色器（如插桩 FR / CLK、`p5d-imgcull-p`）下看得出来，真实壁纸走查里 `p5d-camp-1` 的 FR / CLK 块就是这一条。
- **槽 0 没有纹理的 fullscreen 模型**：几何不改成 2×2，WPE 用对象 `size`（`p5d-2d` 的探针层，±960 × ±540）；语料里 fullscreen 模型的槽 0 全是 `_rt_FullFrameBuffer`，没做。
- **画布分辨率变化时重新加载**：粒子重新预热，WPE 只重建 RT、粒子接着跑。
- **neon_sunset 的残差**：去粒子后超过 2 的像素 0.13%、超过 32 的 20 个，逐层拆开（12 个变体）太阳单层 0 差，残差只在带 neongrid（顶点着色器 `frac(sin(...)·43758.5453)` 哈希）或 filmgrain 的图层，没有继续查。techno 最大差 4，dna_fragment 去粒子最大差 8。
- **脚本读到的向量分量**（已修）：步骤 3 补充走查发现 WPE 交给字段脚本的向量分量是 float32（日志里 z 是 `500.0000305175781`，当时我们是 `500.00003`），转给 P3b。`8da6fb54`（P3b 补测）已让字段脚本 `init` / `update` 的入参不分目标一律取单精度（`script/f32.ts`），相机原点也在内；相机目标没有逐个实测，代码里标了 `TODO:[WPE_SCENE]`。

### 语料与解锁

| 步骤 | 去掉的键 | 新增的键 | 能渲染 | 新解锁 |
|---|---|---|---|---|
| 1 深度与剔除 | `cull:normal` 12 张、`depthwrite:enabled` 10、`depthtest:enabled` 6 | — | 57 → 57 | — |
| 2 透视相机 | `camera:perspective` 11 张、透视的 `general:camerashake` 3 | `camera:perspective:text` 2 张、`:group` 1 | 66 → 69 | dna_fragment、techno、neon_sunset |
| 3 相机对象 | 18 张的 `object:camera` / `fov` / `zoom` / `path` / `queuemode` | — | 69 → 69（提交基点 `5889b490` 上 78 → 78） | —（18 张都还差别的能力） |
| 4 透明排序 | 3 张的 `general:transparentsorting` | — | 90 → 90 | — |

- 各步的起点不同，是同期别的 Phase 也在解锁；语料从 173 张变成 183 张。没有场景因 P5d 不再能渲染。
- 画面影响扫描（步骤 1）：能渲染的 57 张里没有「镜像且剔背面」的图层；会建深度附件的只有 retro（模型缺键测深度）与 shimmering_particles（4 个 additive 粒子缺 `depthtest`），都没有写深度的 pass。
- **基线**：10 张原本能渲染的场景 × 三档后处理的画面哈希，步骤 1、2、3 都不变（步骤 1 的 `targetBytes` 正好多一张深度）；步骤 3 提交树（`5889b490` + 步骤 3）与步骤 4 没有重测，原因见下面的清单。

### 和 WPE 比

- **确定性工程逐像素相同（差 0）**：步骤 1 的 `p5d-depth-o`、`p5d-cull`、`p5c-depth`；步骤 2 的 `p5d-persp`（含 1280×1024）、`-persp-b`、`-depth2`、`-path` w1 / w6、`-shakep-r`、`-tilt`、`-2d-nofs`；步骤 3 的 `p5d-camo-c` / `-o` / `-r` / `-pp` / `-ppr` / `-par` / `-shake`、`p5d-camp-2`（`-camo-0` 只有 CLK 块差 34，CLK 取自光标、回放用缺省光标，排除后 0；`-camp-1` 只有 FR / CLK 两块不同，是上面的视锥剔除）；步骤 4 的 7 个工程（窗口 1600×900）除 CLK 块（颜色取自光标，这批日志没记光标）外相同。
- **真实壁纸复制工程走查**（步骤 3 补充，`kbp content isolate`，脚本照常跑，WPE 窗口 1920×1080 与 1600×900）：
  - `3462279189`（模板：原点脚本按 `canvasSize` 定位、`zoom` 绑属性、开视差）：全部 draw 的 MVP、视差点、`g_Time` 逐位相同；缺省属性、`zoom` 2、镜头位置改后相机原点与 WPE 相同。整帧差只在锐利边缘（上面的采样差），按窗口尺寸画时只剩上面那几十个 ±1。
  - `3605722997`（三个相机按属性切换、`zoom` 2.87、原点不在零点）：三个相机各录一段，最大差 12–35，超过 32 的 1 像素；按窗口尺寸画时三段整帧 0 差异。
  - `3453730450`（透视，相机原点脚本用 `Date.now()` 缓入）：全部 draw 的 MVP 和 WPE 相同；步骤 4 实现透明排序后，原来黑色纯色层盖住 125 的 292 像素差消失（录制时 WPE 后处理开着，按开启档回放后整帧逐像素相同；关排序的对照在两种档位下都是 0 差）。
  - 脚本自己跑（工具第 7 批）：挂脚本相机的五组和塞值逐字节相同；`p5d-camo-s`、`p5d-camo-s4k`（场景 3840×2160、窗口 1920×1080，脚本日志 `canvasSize 3840 2160 screen 1920 1080 origin 1920 1080` 与 WPE 相同）整帧不排除任何区域逐像素相同。
- **语料真实样本**：techno、dna_fragment、neon_sunset 解包加日志按 WPE 回放（见「已知差异」）；预览里三张都实时渲染，场景目标 3840×2160（主屏全分辨率）、铺满。
- 变异检查（`kbp mutate`，快照模式，按原字节还原）：步骤 1 16 处、步骤 2 32 处、步骤 3 21 处、步骤 4 3 处（加子代理自己的 13 / 28 / 31 / 18 处）全部检出；个别要补用例后才检出（步骤 2 的「宿主不重新加载」、步骤 3 的「离开相机对象时提前返回」）。

### 未实测与照报清单

下面汇总各步实施记录里「没做 / 留给后面」「没测」的条目，没有新做测试。

| 项 | 状态 | 出处 |
|---|---|---|
| `alignmentfliph` | 语料 0 张，照报 `general:alignmentfliph`，没测 | 步骤 0 |
| 拼错的 `depthtesting` / `depthwriting`（ricepod） | 照报 `material:*`，WPE 应当不认，没测 | 步骤 1 |
| `clearenabled: false` 的整帧对比 | 没和 WPE 比：WPE 不清屏的后备缓冲在 RenderDoc 回放里是未定义内容；「不清深度、第二帧起不再画」由单测锁住 | 步骤 1 |
| 路径表的边界（第 0 条没有关键帧整表清空、两个关键帧同一时刻 s 取 1、状态越界从头开始） | 语料 0，只有单测；`p5d-path` 其余几组日志不全，只核对了 6 帧 | 步骤 2 |
| `p5d-shakep` | 日志到第 150 帧、抓帧在 180，没比；`p5d-shakep-r` 与单测已覆盖三维抖动 | 步骤 2 |
| 样本里粒子层的 MVP 与朝向 | 没逐绘制比；斜相机的朝向由 `p5d-tilt` 锁住 | 步骤 2 |
| 桌面壁纸窗口、「改画布尺寸只重载一次」 | 桌面壁纸窗口没看；重载只有单测，没在真机上拖窗口 | 步骤 2 |
| `camera:perspective:*` 的细分与 `camera:paths:*` | 照报：透视粒子（`flags & 4`）、图像层 `perspective: true`、`projectlayer`、形状、正交场景带路径、路径文件读不到；语料 0 或只在还差 20 项以上的场景里 | 步骤 2 |
| 透视场景里脚本 `engine.canvasSize` | 照读码读到 (0, 0)，没测，语料 0 处 | 步骤 2 |
| 跟随粒子的指针反投影 | 透视场景、带相机对象的场景里没接相机视图，`particleTrackProbe` 给了 `cursors` 时直接抛错（语料 0） | 步骤 2、3 |
| 加载时的预热与视差点初值 | 不看相机对象；WPE 这时的 eye 没测（`-par` 用的是 delay 0），带相机对象的模板场景开场可能不同 | 步骤 3 |
| 相机对象的其它写法 | `object:camera:mixed`（语料 0）、`camera:path`（22 个相机都是空表）、图层 `fov` / `zoom` 访问（语料 0 处；`getCameraTransforms` / `setCameraTransforms` 由 P5e 实现）、`fov` / `zoom` 挂关键帧（`value:animation:camera`，P5i 起支持）；每个相机对象多读一次 `path` 文件，计进请求数 | 步骤 3 |
| 步骤 3 提交树的画面哈希 | `5889b490` + 步骤 3 没重测：共享宿主产物当时正被别的会话的临时插桩使用；变基前后步骤 3 的增删行按文件逐行相同 | 步骤 3 |
| `3706286085` 的透视走查 | 做不了：它的相机都挂在带骨骼动画的模型下（`CameraBoneMoveMesh` 等，`mdl:skeleton` / `mdl:animation` 没实现），相机的世界矩阵依赖这些模型，复制工程去不掉；换成 `3453730450` | 步骤 3 补充 |
| 走查里去掉的内容 | `3462279189` 的人物（纹理标志 0x22 视频，视频时刻对不上，属 P9a 的特性）与 `3605722997` 的主图（视频）；走查里的 `shared.*` 写入方删掉了，两边读到的都是 undefined | 步骤 3 补充 |
| 脚本向量 float32 | `8da6fb54` 已改成单精度，相机目标没逐个实测 | 步骤 3 补充 |
| `transparentsorting` 绑属性、挂脚本 | 照报 `general:transparentsorting`；WPE 每帧读这一位，语料 0、没实测，没做运行中改 | 步骤 4 |
| `customsortorder` | 照报，语料 0 | 步骤 4 |
| 文本、形状的排序类别 | 只读码，没测（文本 rea-p6b-layout 1.1，形状读码 `factory_14018ff60` 等）；两者在透视场景都照报 | 步骤 4 |
| 步骤 4 的画面哈希与提交树 | 画面哈希没跑成（共享宿主产物每一两分钟被别的会话重建，按用户的意见不再抢；10 张基线都没开 `transparentsorting`，关闭时的调用序列有假设备单测锁住）；「HEAD + 步骤 4」提交树没单独跑测试（用户叫停） | 步骤 4 |
| 透视场景里的光照、反射等 | 不在 P5d：透视 3D 的光照、反射、阴影、体积光归 P13；骨骼、动画、变形归 W6 | 总计划 |

### 对比台

在 `ignore/p5/` 下：
- 步骤 0：确定性工程 `d0/gen_d.py`（`proj/p5d-*`，20 个），读数 `rdc_dump_c.py`、`ana_d.py`、`ana_path.py`、`sim_path.py`，语料键 `d0/p5d_keys.py` → `out/p5d_keys.txt`，非模型 pass 的深度与剔除用法 `scan_depth.py`；
- 步骤 2：`d2/gen_d2.py`（`p5d-tilt`）、`mk_layers.py`（neon_sunset 逐层拆开）；步骤 3：`d3/gen_d3.py` / `gen_d3b.py`、`ana_par.py`、`ana_s4k.py`、走查 `walk_sv.ts`、`peek_draws.py`（WPE 侧）/ `peek_trace.py`（我们这边）；步骤 4：`d4/gen_d4.py`、`ana_order.py`；
- 各步的快照、补丁、变异清单（`mutate_d1.py`–`mutate_d4.py`）、语料比较与整帧比对在 `d1/`–`d4/`；
- WPE 参照在 `A:\p5d\`。

## 脚本的相机基准（P5e）

WPE 的场景有两套相机字段：基准（eye、center、up、zoom，`G+0x118`…`+0x13c`）和每帧算出的当前值。每帧按「可见的相机对象 >
镜头路径 > 基准」选来源，基准只在前两者都没有时生效。脚本的 `thisScene.getCameraTransforms()` / `setCameraTransforms(t)` 读写的是
基准。我们把基准从编译期常量改成运行时状态 `SceneState.cameraBase`：脚本写进去，渲染器每帧求相机时读出来；重编译时随脚本写回重放恢复。
正交场景没有相机对象时，基准改过就和相机对象走同一个 `orthographicCameraObjectFrame`（视图 lookAt、`g_EyePosition` = eye.xy +
(W/2, H/2)、视差中心 eye.xy、总缩放 `general.zoom × 基准 zoom`）；基准是加载完成的重置值、zoom 为 1 时保留原来的快路径，现有场景
逐字节不变。透视场景没有路径时基准取状态，zoom 不起作用。

计划与实测见 [phase-5e](../../../.claude/plans/wpe-import/3-scene/phase5/phase-5e-camera-transforms.md)「步骤 0 结果」；读码补充见
[rea-p5-camera](../../../.claude/plans/wpe-import/3-scene/phase5/rea-p5-camera.md)「更正与补充」。

| 项 | 规则 | 依据 |
|---|---|---|
| `get` | 每次返回新的普通对象（原型 `Object.prototype`），键序 `eye, center, up, zoom`；前三个是新的 `Vec3`，zoom 是 number。读的是基准当前值（含本帧之前 set 过的），不是路径、抖动、相机对象或 `general.zoom`；改返回值不影响基准 | dll `0x181635540`；`p5e-a` 日志 |
| `set` | 没有参数或参数不是对象（`null` 也算不是）返回 `false`、不改；否则返回 `true`，四项各自处理：`eye` / `center` / `up` 是对象就取 x / y / z（number 转 float32，不是 number 记 0），不是对象跳过；`zoom` 是 number 才写（float32）。NaN、Infinity 照写 | dll `0x1816359e0`、`0x181620090`；`p5e-a` 第 2–8 帧 |
| 时序 | `set` 后 `get` 当场读回；画面下一帧才变（WPE 先求相机、后跑脚本，我们的渲染器同序） | `p5e-a` 第 161 / 162 帧的 `g_EyePosition` 与方块颜色编码的帧号 |
| 加载顺序 | 脚本 `init` 早于读 `scene.json` 的 `camera`：`init` 期间基准是构造缺省 (2,2,2) / (0,0,0) / (0,1,0)、zoom 1（`beginScriptInit`）；全部 `init` 之后正交场景 eye / center / up 重置成 (0,0,0) / (0,0,−1) / (0,1,0)，透视场景只有 JSON 里是字符串的项覆盖（`SceneCameraJson.given`），zoom 不受影响（`finishScriptInit`）；被覆盖的字段把脚本写入从重放表里去掉，重编译不复活 | `p5e-init-o` / `p5e-init-p`；exe 加载函数 `0x140186d51` 写基准 zoom 1 |
| 相机对象 / 路径 | 有可见相机对象时基准（含 zoom）不参与；透视场景有路径时基准不参与。`set` 照样写进去，`get` 读回写入的值 | `p5e-cam`（总缩放 1.25 = `general.zoom`、`g_EyePosition` (960, 540)） |
| dev 探针 | `probeCameraObjects` 没有相机对象时也给（图层表为空），回放每帧都经 `sceneCameraFrame`，脚本改过的基准才进探针的视图；基准没改过时结果和以前逐项相同 | 单测 `p5e-camera-base.test.ts` |
| 缺口表 | `MISSING_SCRIPT_API.thisScene` 去掉这两项 | — |

**验收**（`ignore/p5/e/`，WPE 抓帧 `A:\p5e\`）：生成工程 `p5e-a`（正交、每帧 set eye / center / zoom、`general.zoom` 1.25）与
`p5e-cam`（有相机对象）整帧和 WPE 逐像素相同；`p5e-persp`（透视、每帧 set）屏蔽 FR / CLK 后逐像素相同；`p5e-par`（视差 delay 0.3 +
抖动）的 `g_EyePosition` 与缩放逐位相同，只有视差点差 7e-5（日志只到第 150 帧，第 151–159 帧的 dt 是平分的，视差平滑按 dt 累积），
120 个像素是一个方块的上下两条边。工坊场景 2887099508 的解包副本按日志回放（逐帧光标）：开场镜头随 52 号对象滑动，第 263、319、419 帧
和 WPE 的整体位移都是 0（相位相关），剩下的差异来自樱花粒子的随机数和视频纹理的时刻。

## 相机对象上的关键帧（P5i）

相机对象的变换（`origin` / `angles` / `scale`，相机 eye 取它的世界矩阵平移）是图层字段，`fov` / `zoom` 是 P5d 的就地目标
`{ kind: "camera" }`，两者都已有运行时状态，属性绑定和脚本都写它们。P5i 让关键帧（P10a）成为第三种写入方：`compile/animations.ts`
不再把相机对象整体照报 `value:animation:camera`，而是像灯对象（P13f2）那样经 `targetOf` 按字段给目标——变换走图层、`fov` / `zoom`
走 `camera`，`camera` / `path` / `queuemode` 等没有目标的落到 `value:animation:other`；联动照常。

时序照 WPE：相机在帧开头求（脚本、关键帧之前），关键帧写的相机 `origin` 与 `zoom` **下一帧**才进视图，和关键帧写 `general.zoom` 晚一帧
同理。我们的渲染器本来就是「先求相机、后跑关键帧」，写进状态后自然晚一帧，播放器（`animation/player.ts`）不用改。

| 帧 | 相机 zoom 反算的关键帧位置 | 相机 eye 反算的关键帧位置 | REF 本帧的关键帧位置 |
|---|---|---|---|
| 206 | 8.27 | 8.27 | 9.70 |
| 207 | 9.70 | 9.70 | 12.24 |
| 208 | 12.23 | — | 15.01 |

（`p5i-cam`：相机 `origin` x 与 `zoom` 挂同一时钟的关键帧，REF 方块挂同一份 `origin` 关键帧，它这一帧画在哪就是这一帧的值。）

计划与实测见 [phase-5i](../../../.claude/plans/wpe-import/3-scene/phase5/phase-5i-camera-keyframes.md)。`path` 的条目动画（`camera:path`）不在本节。

**验收**（`ignore/p5/h/`，WPE 抓帧 `A:\p5i\cam\`）：`p5i-cam` 按 WPE 日志与轨迹回放到 206、207、208 帧，三帧都和 WPE 逐像素相同（屏蔽 FR / CLK；
相邻帧交叉比 95% 的像素不同，比较是灵敏的）。语料 `3554161528` 变干净，`3841310696`（myprojects）只剩 P12 的 `puppet:draw-order`。
