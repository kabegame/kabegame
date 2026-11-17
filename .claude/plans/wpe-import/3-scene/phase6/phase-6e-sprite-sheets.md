# P6e — 图像层帧表与文本 anchor（子计划）

> 总计划：[phase-6-script-text-sound.md](phase-6-script-text-sound.md)「P6e — 图像层帧表」。读码：[rea-p6e-sheet.md](rea-p6e-sheet.md)（exe 侧）、
> [rea-p6e-script.md](rea-p6e-script.md)（dll 侧）；锚点的 `E0..E3` 公式在 [rea-render-size.md](../rea-render-size.md) 第 1 节。
> 步骤 0b 的实测工程与数据在 `ignore/p6/e0/`（生成器 `make_tests.py`，WPE 抓帧 `A:\p6e\`），结论见文末「步骤 0 记录」。

## 总体设计思路

WPE 的图像层帧表不是「图层的动画」，而是**纹理的动画**：帧表纹理对象自己带一份共享计时器 `{frame, time, lastFrame}`，同一张 `.tex`
的所有材质共用它。计时器只在绑定时推进：每个渲染帧里第一次有 draw 绑到这张纹理时，用本帧的 `g_Frametime` 按 float32 推进一次（每次
最多前进一格、多出来的时间截掉、总是循环），同帧再绑定不动；没有 draw 用到它的帧（图层不可见、被删）就不推进，也不补时间。推进完对
每个用到它的纹理槽 `s` 写 `g_Texture<s>Rotation = (width, widthY, heightX, height) / (W, H, W, H)` 与 `g_Texture<s>Translation = (x/W, y/H)`
（W、H 是该帧所在图像的第 0 级 mip），并把这次绑定的图像换成该帧的 `imageId`。着色器侧什么都不用做：WPE 的 `genericimage*.vert`
在 `SPRITESHEET` 打开时自己用这两个 uniform 把四边形 UV 映射进帧，`SPRITESHEET` 也是材质 JSON 自己写的 COMBO。所以我们这边的改动
集中在三处：bundle 带上完整的帧表、渲染器给每张帧表纹理一份共享计时器并在 draw 上写这两个 uniform、多图像时换绑图像。

脚本的 `getTextureAnimation()` 在图层上建一个控制对象 `A`（和 `getVideoTexture()` 共用同一格），它默认什么都不改，只是「跟随」共享
计时器；`pause` / `stop` / `setFrame` / 写 `rate ≠ 1` 会让它**脱离**：从此这个图层每帧在自己的更新里（脚本之前、不看可见性）用
`dt × rate` 推进私有的 `{frame, time}`，画这个图层时整段绘制里的帧表一律用私有帧号（越界画第 0 格、负数改走共享计时器），也不推进
共享计时器；`join()` 并回。私有状态是 `SceneState` 的一部分（跨单对象重编译保留、随对象删除），脚本对象只是读写它的包装，成员、
键序、原型、类型转换照 WPE 实测。

文本 `anchor` 和帧表无关，但它是 dino_run 与另外 4 张场景解锁的最后一个键，放在这里一起做。`anchor` 是绘制时在**世界空间**加一段
平移 `(ax, ay)`，让对象跟着「可见区域」的边或中心走；可见区域由每帧的 `E0..E3`（四边被裁掉的场景单位）给出，它就是 WPE 正交投影
`ortho(E0, W − E2, E3, H − E1)` 的四个边距——我们按窗口尺寸画的 dev 探针已经在算它（`alignEdges`）。产品的预览与桌面先按场景分辨率
画再铺放（render-size 已定），这时 `E` 按显示的铺放算：铺满裁切时和 WPE 一样把贴边的文字收进可见区域；装下 / 居中留边时被推到场景
之外的部分落在场景目标外、看不到（同 render-size 的已知差异）。

关键决策：
- **计时器挂在纹理上、推进时机是「本帧第一个用到它的 draw」**，而不是挂在图层上按可见性推进。实测（`p6e-shared`）同一张纹理的两个
  图层一个隐藏一个可见时，隐藏的回来与可见的同格；两个都隐藏时回来接着隐藏前那一格走、不补时间。只有挂在纹理上才同时满足这两条。
- **脱离状态进 `SceneState`**，不放在 API 对象里：它影响画面（覆盖帧号），要跨重编译、随删除清理，渲染器要读；API 对象只是外壳（同
  P12c 的 `animationLayers`）。
- **多图像单独成一步**：要把全部图像上传、按帧换绑定组，是唯一碰 GPU 绑定结构的改动；语料只有 3 张，放最后，前面几步不依赖它。

## 步骤 0 记录（2026-11-17）

**读码**：两份报告见开头链接。exe 侧 12 条结论、dll 侧 11 条结论。

**语料**（L7 收尾的全库扫描，238 张；`ignore/p6/e0/keys.py`、`survey.py`）：
- 报帧表键的 20 张：`combo:SPRITESHEET` 20、`tex:animation` 20、`script:api:layer.getTextureAnimation` 12、`tex:animation:multi-image` 3。
- **只差帧表键的 15 张**：13551 13571 13574 13582 13584 13598 13604 13618 13634 13650 14285 14293 14995 15003 15026。
- 加上文本锚点：`text:anchor:*` 5 张，只差它的 2 张（13562、13578），帧表 + 锚点 3 张（13518 dino_run、13602、13608）。另有 13599
  （`model:passthrough:children:framebuffer`）、14316（`puppet:draw-order`）各差一个别的键。
- 帧表的用法：全部在图像层的槽 0（含 1 个 puppet 图层，13618），**effect 槽里没有**；全部 TEXS0003、没有旋转帧，每张帧表帧时长相同
  （0.03–1.0 s）；多图像 3 张（14285 的两张 3 图像、14293 的 2 图像、14316 的 5 图像，单张约 7680×7920 DXT）；NPOT 只有 dino_run 的
  8 张（256×32 纹理里 144×24、24×24 一格，图层都没有 effect）。
- 脚本：12 张调 `getTextureAnimation`，多是按钮的 2–4 格开关（`pause` / `stop` + `setFrame`），3 张在 `update` 里读 `getFrame()` 到末格
  `stop()`，3 张用 `join()`。dino_run 不调它。
- 锚点：用到 `top`、`left`、`right`、`topright`、`bottomleft`、`bottomright`、`topleft`（`3643916956` 一张 6 种），有挂在父对象下的。

**WPE 实测**（fps 20，窗口 1280×720，`ignore/p6/e0/proj/`，抓帧 `A:\p6e\s0b\`，日志与导出图在 `ignore/p6/e0/out/`）：
- `p6e-rate`（帧时长 0.1 / 0.02 / 0 / 0.03 + `rate = 9`）：0.02 与 0 每个渲染帧正好一格（dt ≈ 0.05 也不跳 2.5 格），0.03 × 9 脱离后同样每帧
  一格，0.1 两帧一格且余数累积（偶尔一帧就进一格）。第 1 帧 `engine.frametime` = 0.000168（首帧几乎不推进）。上屏画面：共享计时器
  第 f 帧画的格 = 第 f+1 帧 `update` 读到的 `getFrame()`，脱离的 = 本帧读到的；方向标记全对。**与读码一致。**
- `p6e-shared`：同纹理一隐一显，隐的回来与显的同格；同纹理两个都隐，回来接着隐藏前那格走（不补时间）；脱离且在播的隐藏期间照常推进。
  **与读码一致。**
- `p6e-api`：键序 `frameCount,duration,rate,play,isPlaying,stop,pause,setFrame,getFrame,join,getAnimation`；`frameCount` / `duration`
  只读（严格模式抛 `TypeError: Cannot assign to read only property 'frameCount' of object '[object Object]'`，描述
  `{writable:false, enumerable:true, configurable:true}`）；`rate` 只收 number、float32（`0.1` → `0.10000000149011612`、`1e40` →
  `Infinity`、`1.00000001` → 1、`new Number(2)` 不收）；`setFrame` 只收 int32（`2.5`、`'2'`、`true`、`NaN`、`-0`、`2147483648`、不传都当
  0，`-1`、`999` 原样）；**原型是每个对象自己的一个，只有不可枚举的 `constructor`（`name` 为空串），再往上是 `Object.prototype`**（dll
  读码推测是 `Object.prototype`，实测不是；同 P12c 的 `IAnimationLayer`）；纯色层返回 `null`、文本层没有这个方法（`TypeError`）；
  `getVideoTexture()` 先调返回 `null`、之后与 `getTextureAnimation()` 是同一个对象；`destroyLayer` 当帧仍有效、下一帧读写都是
  `undefined`、`isObjectValid` 假、`Object.keys` 仍 11 个、`JSON.stringify` 为 `{}`。时间线（pause / play / stop / join / 跟随中
  `setFrame` / `rate = 2` / `rate = 1` 不并回 / `rate = -1` 倒播回绕 / `setFrame(99)` / `setFrame(-1)` 倒播跳末格）与读码逐帧一致；
  固定状态图层上屏：`setFrame(2)` 画 2、`setFrame(99)` 画 0、`setFrame(-1)` 画共享格、`stop` 画 0。越界帧号倒播时每帧减 1（读码：读到
  越界的帧时长，未定义），语料不用。
- `p6e-tex`：NPOT TEXS0003 不带 effect 画整格、`autosize` 取格尺寸 24×24、旋转帧按公式转置、多图像第 4 格起换到第二张图像且按它归一化。
  **两处要注意**：TEXS0002 的 NPOT 只画出格的左上 `144/256 × 24/32`（与读码推论一致）；**TEXS0003 的 NPOT 带 effect 时同样只画出左上
  这一块**（读码说 effect 时 UV 取 (1, 1)，实测相反：合成路径的基础 pass 自己按「图像 / 纹理」缩了 UV）。语料用不到（dino_run 的 NPOT
  图层没有 effect），照实测做。线性过滤从相邻格 / 填充渗进边缘一条，照样复现。
- `p6e-anchor`（10 种锚点，900×1600 对齐 0 / 1、2560×1080 对齐 1、960×540 对齐 3、1920×1080 对照，抓帧 `A:\p6e\anchor*`）：贴边的文字收进 /
  推到可见区域的边，方向与读码表一致。`p6e-anchor2`：**平移在世界空间**——自身放大 2 倍的移 E 不是 2E，转 90° 的仍沿世界 x 移，父对象
  缩放 0.5 下的仍移 E（不是 E/2）。

## 现状锚点

**a. 能力表把帧表与锚点报成不支持**（`compile/features.ts:181-190`、`:764-797`）
```ts
 * - `SPRITESHEET`：要逐帧的 `g_Texture0Rotation` / `Translation`（P6），现在只给恒等帧；
const ENGINE_COMBOS = new Set(["SPRITESHEET", "SKINNING", "SKINNING_ALPHA", "MORPHING", "PRELIGHTING"]);   // 现状：SPRITESHEET 照报 combo:SPRITESHEET
…
const NEUTRAL_ANCHORS = new Set(["none", "center"]);
export function checkTextOptions(values, unsupported): void {
  for (const key of TEXT_MSDF_KEYS) if (values[key]) unsupported.add(`text:msdf:${key}`);
  if (!NEUTRAL_ANCHORS.has(values.anchor)) unsupported.add(`text:anchor:${values.anchor}`);   // 现状：其余 8 种照报
}
```

**b. 纹理读入：帧表照报、多图像照报、bundle 只带第 0 张图像**（`compile/tex.ts:299-303`，`compile/bundle.ts:224-261`）
```ts
// 帧表纹理：粒子材质的槽 0 是合法用法（P4b 步骤 2），`bundle.ts` 的 `getTexture` 按用途去掉这个键；图像层的帧动画属 P6，照报
if (flags & TEX_FLAGS.animated) unsupported.push(ANIMATION_ISSUE);
// 粒子路径只采第 0 张图像（rea-p4b-render.md 2.7【推】），帧落在别的图像上会采错
if (flags & TEX_FLAGS.animated && imageCount > 1) unsupported.push("tex:animation:multi-image");
```
```ts
export interface SceneTexture {
  …
  mips: SceneMip[];                 // 现状：只有第 0 张图像的 mip（`tex.images[0]?.mips`，bundle.ts:1801）
  /** 头标志 bit2（帧表）置位、帧表非空时有（`spriteSheet`）。只有粒子材质的槽 0 用它（P4b 步骤 2）。 */
  sheet?: SceneSpriteSheet;         // 现状：只有粒子要的 `renderVar1` 与 `npot`，没有逐帧数据
}
```

**c. 渲染器给恒等帧**（`render/uniforms.ts:264-266`，`staticBuiltins`）
```ts
    // 非 spritesheet 时的恒等帧变换：v = translation + u * rotation.xy + v * rotation.zw
    g_Texture0Rotation: [1, 0, 0, 1],
    g_Texture0Translation: [0, 0],
```

**d. 图层尺寸：`autosize` 取图像尺寸**（`compile/bundle.ts:1102-1117`，`imageLayerSize`）
```ts
  if (modelFlag(model, "autosize")) {
    if (modelFlag(model, "projectlayer")) return [Math.trunc(projection[0]), Math.trunc(projection[1])];
    if (texture) return [texture.width, texture.height];   // 现状：帧表也取整张图像尺寸（WPE 取 TEXS 头的格尺寸）
  }
```

**e. 脚本：`getTextureAnimation` 在缺失表里；`IVideoTexture` 独占一格**（`compile/scriptApi.ts:113`，`script/api.ts:336`、`:749`）
```ts
    ...methods("any", ["getTextureAnimation"], UNIQUE),        // 现状：用到就报 script:api:layer.getTextureAnimation
```
```ts
  /** 图层的 `IVideoTexture`（P9b）：每个图层建一次，之后 `getVideoTexture()` 返回同一个对象（WPE 的 `L+0x4c0`）。 */
  private readonly videoTextures = new Map<number, ApiObject>();
  private videoTexture(object: number): ApiObject | null {
    if (!layerVideoSource(this.access.bundle(), object)) return null;   // 现状：不是视频就 null，和帧表对象不共格
```

**f. 文本的世界矩阵没有 anchor 平移**（`render/uniforms.ts:488-514`，`textMatrices`）
```ts
  // 字形平移是 glm::translate 内联（`FUN_140258050`，rea-matrix-order 3.4）
  const model = x === 0 && y === 0 ? world : translateGlm(world, [x, y, 0]);   // 现状：world 里没有 anchor 的 (ax, ay)
```

**g. 裁切边距已有**（`render/layout.ts:419`，`alignEdges(mode, Ws, Hs, Ww, Hw)`）：dev 探针按窗口尺寸画时算投影用；产品的铺放
（`scenePlacement`）不产出 `E`。

## 点 1 — 编译：完整帧表进 bundle，去掉帧表的不支持键（`compile/tex.ts`、`compile/bundle.ts`、`compile/features.ts`、`compile/scriptApi.ts`）

- **新增**
  - `SceneTexture.frames?: SceneSheetFrames`（帧表纹理都有，不只粒子）：
    ```ts
    export interface SceneSheetFrames {
      version: number;                       // TEXS 版本（1–3）
      /** TEXS0003 头里的格宽高；版本 < 3 时是图像宽高（WPE `tex+0xb0/+0xb4`）。图层合成 RT 尺寸与 autosize 用它。 */
      cell: [number, number];
      total: number;                          // f32 逐帧累加（`duration`）
      frames: {
        frametime: number;                    // f32
        image: number;                        // imageId（越界时 6 个坐标为 0，同读入）
        rotation: [number, number, number, number];   // (width/W, widthY/H, heightX/W, height/H)，f32
        translation: [number, number];                // (x/W, y/H)，f32
      }[];
    }
    ```
  - 多图像的其余图像（点 4 才用；本步只在 `TexResult` 里保留，bundle 先不带）。
- **修改**
  - `tex.ts`：`tex:animation` 不再在读入时报；空帧表 `tex:animation:empty` 照报；`tex:animation:multi-image` 本步照报（点 4 去掉）。
    > 说明：粒子路径的 `getTexture` 按用途去键的逻辑一并删掉（键不再产生）。
  - `features.ts`：`ENGINE_COMBOS` 去掉 `SPRITESHEET`（材质自己的 COMBO，`g_Texture<n>Rotation/Translation` 由渲染器给）；`SPRITESHEET`
    打开而槽 0 不是帧表时 WPE 读残留的 uniform（rea-p6e-sheet 第 1 节推论），我们给恒等帧，语料没有，记有意不同。
  - `imageLayerSize`：槽 0 是帧表时 `autosize` 取 `frames.cell`；图像层合成 RT 尺寸同样取 `cell`（rea-p6e-sheet 5.3）。
  - 四边形 UV 缩放：槽 0 帧表且 `version ≥ 3` 时直接上屏路径取 `(1, 1)`；合成路径的基础 pass 照实测保持「图像 / 纹理」（`p6e-tex` N2）。
  - puppet 图层的槽 0 是帧表时（13618）：`fullscreenlayer` 材质带 `SPRITESHEET = 1`、走合成、UV 不缩放（rea-p6e-sheet 5.1，P12b2 已有的
    路径），核对后补齐。
  - `scriptApi.ts` 的 `getTextureAnimation` 留到点 3 再移出缺失表：调它的 12 张在点 3 之前仍报 `script:api:layer.getTextureAnimation`，
    不会带着缺失的 API 跑脚本。

## 点 2 — 渲染：每张帧表纹理一份共享计时器（`render/scene.ts`、`render/uniforms.ts`、新增 `render/sheets.ts`）

- **新增** `render/sheets.ts`：纯函数与小状态，Node 里可测。
  ```ts
  /** 共享计时器（WPE 纹理对象的 `+0x9c/+0xa0/+0xa4`）。 */
  export interface SheetClock { frame: number; time: number; lastFrame: number }
  /** rea-p6e-sheet 2.4 的推进，f32，每次最多一格：dt > 0 前进并回绕、dt < 0 后退并回绕；越界帧号按第 0 格的时长前进。 */
  export function advanceSheet(clock: { frame: number; time: number }, frames: SceneSheetFrames["frames"], dt: number): void;
  /** 本帧第一次用到时推进（按渲染帧号去重），返回要画的格；`override >= 0` 时不推进、越界取第 0 格（脱离的图层）。 */
  export function sheetFrameFor(clock: SheetClock, sheet: SceneSheetFrames, frameNo: number, dt: number, override: number): number;
  ```
- **修改**
  - `GpuScene`：每张帧表纹理（bundle 纹理下标）一个 `SheetClock`，加载时 `{0, 0, 0}`，跨重编译按纹理路径接回（同一张 `.tex` 一份）。
  - 每帧编码前（`sync` 里、已知本帧要画哪些 draw 之后）：对每个要画的 draw、它材质里每个帧表纹理槽 `s`，按 `sheetFrameFor` 取格，写这个
    draw 的 `g_Texture<s>Rotation` / `Translation`（只有程序声明了的才写，同 WPE 只给用到的槽）；`override` 取这个 draw 所属图层的脱离
    帧号（点 3），没有时 −1。不画的 draw 不碰计时器。
    > 说明：WPE 是在绑定时推进；我们的 uniform 在 `sync` 里写，所以「本帧会画到」要和 `encode` 的判断同一套（可见性、视锥剔除、
    > 组与合成）。实现时把判断收成一个函数两边共用，不另写一份。
  - `g_Frametime` 与渲染帧号取渲染器已有的值（回放时就是 `particles.dts` 的那一项，dev 探针天然确定）。
  - 合成路径（effect 链、puppet、组）里所有用到这张纹理的 pass 共用同一格（同帧只推进一次）。

## 点 3 — 脚本：`ITextureAnimation`（`render/state.ts`、`script/api.ts`、宿主每帧更新）

- **新增** `SceneState.textureAnimations: Map<对象, { detached: boolean; playing: boolean; rate: number; frame: number; time: number }>`
  （WPE 的 `A`，`rate` 存 f32）。建法照 `getTextureAnimation`：第一次调用且槽 0 是帧表时建、初值 `{false, true, 1, 0, 0}`；随对象删除清掉，
  跨单对象重编译保留，槽 0 换成别的纹理（用户纹理）时删掉（WPE `FUN_140209360`）。
- **修改**
  - 每帧推进：渲染器在脚本之前（同 WPE 第 2 步、粒子与相机之前后的同一段）对每个 `detached && playing` 的条目
    `advanceSheet(私有状态, 帧表, g_Frametime × rate)`，**不看可见性**；它的帧号作为点 2 的 `override`（`>= 0` 才生效）。
  - `script/api.ts`：图层上的 `getTextureAnimation()`，和 `getVideoTexture()` 共用一格（先建的那个两边都返回它；没建过时各按自己的条件
    建或返回 `null`）；只登记在图像层上（文本、粒子、声音等没有这个方法）。对象：
    - 原型：每个对象自己一个，只有不可枚举的 `constructor`（`name` 为空串），再往上 `Object.prototype`（实测，同 `IAnimationLayer`）；
    - 自有成员按键序 `frameCount, duration, rate, play, isPlaying, stop, pause, setFrame, getFrame, join, getAnimation`，都可枚举、可配置；
    - `frameCount` / `duration` 只读（严格模式赋值抛 `TypeError`，文案同 WPE），每次现读当前槽 0 帧表；
    - `rate`：只收 JS number，存 f32；写入后 `rate !== 1 && !detached` 时拷共享 `{frame, time}` 并脱离；
    - `play` 置 `playing`；`pause` 未脱离时先拷共享状态，再 `playing = false`、脱离；`stop` 私有 `{0, 0}`、停、脱离；`setFrame(n)` 只收 int32
      （其余当 0），写 `{n, 0}`，未脱离时同时脱离并 `playing = true`；`getFrame` 脱离时返回私有帧号（不夹取），否则返回共享帧号；
      `isPlaying` 为 `!(detached && !playing)`；`join` 只清 `detached`；`getAnimation` 全场景按名字找、找不到 `undefined`（rea-p6e-script 8）；
    - 作废：图层删除生效后读得 `undefined`、写忽略、方法返回 `undefined`，`isObjectValid` 假（同已有的属主作废机制）。
  - 共享帧号要给脚本读：`getFrame()` 未脱离时读点 2 的计时器（上一帧画完后的值），API 经 `ScriptApiState` 取。

## 点 4 — 多图像帧表（`compile/bundle.ts`、`render/textures.ts`、`render/scene.ts`）

- **修改**
  - `SceneTexture` 带全部图像（`images?: SceneMip[][]`，第 0 张仍在 `mips`），渲染器每张图像一张 GPU 纹理。
  - 用到多图像帧表的 draw：每张图像一份绑定组（只在帧表纹理所在的组里变），点 2 取格后按 `frames[k].image` 选；`g_Texture<s>Resolution`
    仍是头尺寸（rea-p6e-sheet 2.3）。
  - `tex:animation:multi-image` 去掉。
  > 说明：语料 3 张，单张图像约 7680×7920 DXT（DXT5 约 58 MiB），14316 有 5 张。显存按图像数线性涨，「开始渲染」日志的渲染目标估算
  > 之外另记纹理字节。

## 点 5 — 文本 `anchor`（`compile/features.ts`、`render/layout.ts`、`render/uniforms.ts`、`render/cursor.ts`）

- **修改**
  - `checkTextOptions`：九种取值都放行（`none` 本来中性）。
  - `E0..E3` 每帧一份，交给文本的矩阵与光标命中：
    - dev 探针给了 `canvas` 时：`alignEdges(对齐方式, W, H, 画布宽, 画布高)`（和投影同一份）；
    - 产品（场景分辨率画再铺放）：按显示铺放算——样式经 `ALIGNMENT_OF_STYLE` 换成对齐方式、窗口取画布尺寸，同样 `alignEdges`；
    - 透视场景：全 0（WPE 不算）。
  - `textMatrices` 的直接上屏与合成上屏：世界矩阵先在**世界空间**加 `(ax, ay, 0)`（rea-p6b-layout 3.4 的表；实测与自身缩放、旋转、父链无关），
    合成 RT 内部的矩阵不动。
  - 光标命中（P6c 的文本命中）同样带这段平移（WPE 拾取时也调 `+0xa8`）。
  - `getTransformMatrix` 不含 anchor（rea-p6d-layers 第 8 条），不动。

## 验收

1. **单测**（只跑相关文件）：`render/sheets.ts` 的推进（按 `p6e-rate` 的 dt 序列逐帧比 WPE 日志的 `getFrame`）、`autosize` / 合成 RT 取格尺寸、
   API 对象（键序、原型、描述、只读抛错、`rate` / `setFrame` 转换表、方法时间线、和 `getVideoTexture` 共格、作废）、锚点平移表与世界空间。
   全部按 `p6e-api` 日志与 rea 报告写期望值。
2. **变异**（按原字节还原）：每次推进多格；不截余量；同帧多次推进；不看去重帧号；隐藏图层也推进共享计时器；脱离图层隐藏时不推进；
   越界覆盖不取 0；负覆盖不回落共享；`rate = 1` 也脱离；`play` 并回；`setFrame` 截断小数；共格失效；anchor 乘进对象矩阵。
3. **真机对 WPE**（dev 探针，`canvas` 1280×720，`particles.dts` 取 WPE 日志里逐帧的 `engine.frametime`、`scripts` 带 `consoleGrep`）：
   - `p6e-rate` / `p6e-shared` / `p6e-api` / `p6e-tex`：脚本日志与 `ignore/p6/e0/out/*-log.txt` 逐行相同；回放到抓帧的帧号读回，和
     `ignore/p6/e0/out/png/wpe-*-f<N>.png` 逐像素比，差异逐处解释；
   - `p6e-anchor` / `p6e-anchor2`：按五种窗口尺寸与对齐方式读回，和 `A:\p6e\anchor*` 的上屏帧逐像素比（文字栅格化已在 P6b 对齐）。
4. **全库**：编译摘要只在报帧表 / 锚点键的场景上变化；能渲染数增加（预期 15–20 张，以扫描为准），新解锁的逐张开预览看一眼；画面哈希
   对没用到帧表的场景不变；`scriptCorpus` 只多 `getTextureAnimation` 的调用结果。
5. **走查**（FINAL_CHECK）：和 P6d 一起做，单列一步（dino_run、音频条、`2887099508`、按钮类帧表场景的复制工程），不在本子计划里。

## 分步与交付

1. 点 1 + 点 2（编译 + 共享计时器）：单独验收（`p6e-rate`、`p6e-shared`、`p6e-tex` 的 N1/N3/R1），提交一次。
2. 点 3（脚本）：`p6e-api` 全量，提交一次。
3. 点 5（anchor）：`p6e-anchor*`，提交一次。
4. 点 4（多图像）：`p6e-tex` 的 M1 + 三张多图像语料，提交一次。
5. 全库扫描与文档（`cocs/wpe/WPE_SCENE.md` 新节「图像层帧表（P6e）」、文本一节补 anchor、README 条目、回归、能力表注释）。

每步由 sonnet 执行代理实现（只改列出的文件与各自测试），我独立复核（git 状态查越界、重跑测试、变异、真机）后再提交。

## 已定（2026-11-18 用户「好，同意」，三条都按推荐）

1. **范围**：P6e 带上文本 `anchor`（解锁 dino_run 等 5 张）与多图像（3 张）。推荐都带，多图像放最后。
2. **产品里的 anchor**：预览 / 桌面按显示铺放算 `E`，铺满时同 WPE；装下 / 居中时推到场景之外的部分看不到（render-size 的已知差异）。推荐这样。
3. **语料不用的边角**：越界帧号倒播（WPE 读越界帧时长，实测每帧减 1）照实测「每帧一格」；`SPRITESHEET` 配非帧表纹理给恒等帧
   （WPE 读残留 uniform）；`general.spritesheetrefreshsync`（只影响帧数）不做、不报。推荐这样，记有意不同。
