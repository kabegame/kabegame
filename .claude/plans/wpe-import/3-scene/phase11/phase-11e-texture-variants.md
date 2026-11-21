# P11e：按用户属性切换的纹理变体（TEXB0004 条件）

> 起因：语料新增的 `3817265356`（myprojects，パンスト）整张退回，`tex:parse:materials/1_0002_图层-5.tex:Error: 纹理数据越界`（语料清扫会话转来，2026-11-21）。
> 读码：[rea-p11e.md](rea-p11e.md)（`wallpaper64.exe` 2.8.42，与本机安装的同一个二进制；资源编译器核对了字段来源）。

## 总体设计思路

WPE 的 `.tex` 可以带「变体」：资源编译器把一张底图和若干张按用户属性条件生效的补丁图编进同一个 `.tex`。`TEXB0004` 头里那个我们照 LWE 当成 `isVideoMp4` 的字段其实是**条件数**，后面跟着条件表；条件数大于 0 时，每级 mip 的底图数据之后还跟着这一级的变体块。WPE 加载纹理时按用户属性的当前值逐条判定，把命中的变体按顺序贴到底图上（覆盖、按 alpha 混合，或整张替换），再上传 GPU；运行中改了相关属性，WPE 在下一帧前原地重载这张纹理、重新判定。

我们照这个形状做，分三层。**解析**放在 Worker 的 `parseTex`：读出条件表与每级 mip 的变体条目（只记区间，不读字节，同现有 FreeImage 形态），删掉照 LWE 写的「字段为 1 时每级 mip 前多读一段」的分支——那个布局在 WPE 里不存在、语料也一张没有。**选择**是一个纯函数，照 WPE 的判定器写（条件对象的属性值必须是 JSON 字符串且逐字节相等；条件写成字符串时属性值必须是布尔 true；属性不存在为假；同一组只认第一条命中的），编译期用属性全集算一次，宿主运行中用当前全集再算。**合成**放在主线程上传 GPU 那一步：底图与各变体位图照常由 `TextureDecodeCache` 解码，上传时先写底图、再按 WPE 的规则把命中的变体用 `copyExternalImageToTexture` 写到 (x, y)，整张替换的直接写变体。

运行中换图不走重编译。变体不改纹理尺寸与格式，所以换选择只要把这张 GPU 纹理的内容重写一遍：编译期给每个出现在条件里的属性名登记一条就地绑定 `{ kind: "texture-variant", path }`，宿主应用属性增量时对受影响的纹理重新选择，选择变了就重写内容，绑定组与着色器都不动，下一帧生效，和 WPE 的时机一致。纹理按文件路径去重（`textureIndex`），同 WPE 只按文件名缓存，所以同一个 `.tex` 被几个材质用时选择相同、一起换。为了换图当帧完成，加载时把全部变体位图一起解码（语料这张 3127×2000、每级 3 张图，内存可接受）。

关键取舍：
- **判定照 WPE 的严格类型**，不和 `visible` 等绑定的判定共用：WPE 这两处本来就不同（绑定用 `asString` 能命中数字值，纹理变体只认字符串值），照它的才能和 WPE 一致。
- **合成在 GPU 上**：`copyExternalImageToTexture`（`premultipliedAlpha: false`，位图按 `premultiplyAlpha: "none"` 解码）逐字节写进目标区域，等价于 WPE `FUN_14015c480` 的逐行覆盖；不经 2D canvas（预乘会改半透明像素）。
- **WPE 的两个副作用不复刻**：没有命中时记 `$__default` 导致每次应用属性都白白重载一次、每次重载重复登记绑定。都不改画面。
- **纹理降级时变体块没读走的 WPE 缺陷不复刻**：我们没有纹理降级。

## 现状锚点

**a. `parseTex` 把条件数当 `isVideoMp4`**（`compile/tex.ts:289-323`）
```ts
let freeImageFormat = -1,
  videoMp4 = 0;
if (containerVersion >= 3) freeImageFormat = await c.i32();
if (containerVersion === 4) videoMp4 = await c.u32();   // 现状：其实是条件数 N
// 现状：照 LWE，字段为 1 时每级 mip 前多读 u32、u32、zstr、u32（WPE 里没有这种布局，语料 0 张）
const mipLayoutVersion = containerVersion === 4 && videoMp4 === 1 ? 4 : Math.min(containerVersion, 3);
…
for (let i = 0; i < mipCount; i++) {
  if (mipLayoutVersion === 4) { await c.u32(); await c.u32(); await c.zstr(); await c.u32(); }
  const mipWidth = await c.u32(), mipHeight = await c.u32();
  …                                                      // 现状：N > 0 时 mip 之后的变体块没读，下一级从变体块里读出头 → 越界
}
```

**b. 纹理进 bundle、按文件路径去重**（`compile/bundle.ts:1893-1930`）
```ts
const existing = textureIndex.get(file.path);           // 现状：同一个文件只解析一次，所有材质共用一个下标
…
bundle.textures.push({ path, source: file.source, format: tex.format, …, encoded: tex.encoded, video: tex.video });
```

**c. FreeImage 形态的解码与上传**（`compile/decode.ts`、`render/textures.ts:118-140`）
```ts
// decodeEncodedTextureList：按 encoded.mips 的区间读、createImageBitmap 解码，填进 texture.mips
texture.mips = bitmaps.map((bitmap) => ({ width: bitmap.width, height: bitmap.height, bitmap }));
// uploadTexture：每级 mip 整张 copyExternalImageToTexture 到左上角
device.queue.copyExternalImageToTexture({ source: mip.bitmap! }, { texture: gpu, mipLevel: level, premultipliedAlpha: false }, { width: mip.width, height: mip.height });
```

**d. 就地绑定目标**（`compile/bindings.ts:271-346`）：已有 `layer`、`constant`、`user-texture` 等，没有纹理变体。

## 格式与判定（读码结论，详见 rea-p11e）

- **头**：`TEXB0004` 的 imageCount、FreeImage 格式之后是条件数 N；N 条 `[u32 组号, u32 变体号, u32 标志, 以 0 结尾的 JSON]`，JSON 是 `{"condition": variantcondition}`。组号 = 源 JSON `variants[]` 的下标 + 1，变体号跨组从 1 连续编号。
- **每级 mip**（N > 0 时）：底图数据之后 `u32 组数`，每组 `u32 条数`，每条 `[u32 组号, u32 变体号, x, y, w, h, u32 FreeImage 格式, u32 长度, 数据]`；x、y、w、h 是这一级 mip 上的矩形。
- **判定**（`FUN_140174a60`）：`condition` 是对象 `{name, condition}`（两个都是字符串）时，属性全集里 `name` 的 `value` 必须是 JSON 字符串且与 `condition` 逐字节相等；`condition` 是字符串时它就是属性名，`value` 必须是布尔 true；属性不存在、类型不对为假。同一组只认第一条命中的，命中的记 `变体号 → 标志`。
- **贴图**：每级按文件里的条目顺序取命中的变体；最后一条带标志位 2 的之前的都丢掉；位 2 = 整张替换，位 1 且 RGBA8888 = 按变体 alpha 混合（rgb `dst + ((src − dst)·a >> 8)`，alpha 取较大），否则逐行覆盖。
- **运行中**：每个出现过的属性名一个绑定，值变了就在帧间原地重载整张纹理、重新判定，下一帧画新的。
- **3817265356**：底图是 `newproperty = "2"`（白丝，没有命中），`"1"`、`"3"` 各贴一张满尺寸变体（标志 0，覆盖）。缺省值 `"1"`。

## 实施方案

### 点 0 — WPE 实测（`ignore/p11/e/`）

读码有几处是【推】，先在 WPE 上测，结果写进本文件「实施记录」。生成工程用 kbp 生成库，`.tex` 写入器自己写（`make_variant_tex.py`，字段照资源编译器）：底图 + 两组变体（局部矩形、不同 mip 级不同矩形），属性有 combo（字符串值）、combo（数字值）、bool。
- **E1 加载时的选择**：每个取值各开一次窗口抓帧，核对哪几张变体生效、贴的位置与顺序、同组两条都命中时取哪条。
- **E2 运行中换值**：`apply_properties` 改值后连抓几帧，核对哪一帧换、换回底图（没有命中）是否正确。
- **E3 数字值与 bool 形式**：数字值的 combo 判假（读码【确】，确认画面）；`"condition": "<bool 属性>"` 只在 true 时生效。
- **E4 标志位 1 与 2**：手工写标志，核对混合公式与整张替换（资源编译器不产生位 2，来源未知，只确认读入端的行为）。

### 点 1 — 解析（`compile/tex.ts`）
- **修改** `parseTex`：读条件数与条件表；删掉 `mipLayoutVersion === 4` 分支；条件数 > 0 时每级 mip 之后读变体块，只记区间。
```ts
export interface TexVariantCondition {
  group: number;
  id: number;
  flags: number;
  /** 对象形式：属性名与条件串；字符串形式：只有属性名、要求布尔 true。JSON 不合规的条件不进表（同 WPE：什么都不做）。 */
  test: { name: string; equals: string } | { name: string; bool: true };
}
export interface TexVariantPatch {
  group: number; id: number; x: number; y: number; width: number; height: number;
  freeImageFormat: number; offset: number; length: number;
}
export interface TexResult {
  …
  /** 新增：TEXB0004 的条件表与每级 mip 的变体条目（第 l 项是第 l 级）；没有条件时不写。 */
  variants?: { conditions: TexVariantCondition[]; mips: TexVariantPatch[][] };
}
```
- **新增** 能力键：变体不是 FreeImage 形态（原格式 / LZ4）报 `tex:variant:raw`，标志位 1 报 `tex:variant:alphablend`（见「待定 1」），多图像（imageCount > 1）带条件报 `tex:variant:multi-image`。语料 0 处，标 `TODO:[WPE_SCENE]`。

### 点 2 — 选择（`compile/textureVariants.ts`，新增）
- **新增** 纯函数，编译期与宿主共用：
```ts
/** 照 WPE FUN_140174a60 判一条条件；properties 是属性全集（属性名 → 值）。 */
export function variantConditionHolds(test: TexVariantCondition["test"], properties: Readonly<Record<string, unknown>>): boolean;
/** 命中表：同一组只认第一条命中的。返回 变体号 → 标志。 */
export function selectVariants(conditions: readonly TexVariantCondition[], properties: Readonly<Record<string, unknown>>): Map<number, number>;
/** 一级 mip 要贴的条目：按文件顺序过滤命中的，最后一条整张替换（位 2）之前的丢掉。 */
export function variantPlan(patches: readonly TexVariantPatch[], selected: ReadonlyMap<number, number>): { patch: TexVariantPatch; flags: number }[];
```
  > 说明：属性全集里值的类型照原样（来自 `project.json` 与用户值），数字不转字符串。属性定义里没有 `value` 键的（WPE 在这里空指针崩溃）按假处理并报 `tex:variant:no-value`（崩溃组合照报）。

### 点 3 — 进 bundle 与绑定（`compile/bundle.ts`、`compile/bindings.ts`）
- **修改** `SceneTexture` 加 `variants?`（条件表 + 每级变体的磁盘区间与 mime），`encoded` 照旧是底图。
- **新增** 绑定目标 `{ kind: "texture-variant"; path: string }`：每张带条件的纹理给条件里出现的每个属性名登记一条（同属性同纹理只登记一次）。`planApply` 把它归到就地写。

### 点 4 — 解码与合成（`compile/decode.ts`、`render/textures.ts`、`render/scene.ts`）
- **修改** `decodeEncodedTextureList`：带 `variants` 的纹理，底图与全部变体位图一起解码（同一个缓存、同一套键），记在纹理上。
- **新增** `writeTextureContents(device, gpu, texture, selected)`：每级先写底图（或整张替换的变体），再按 `variantPlan` 把覆盖类变体 `copyExternalImageToTexture` 到 `origin: { x, y }`。`uploadTexture` 建纹理后调它。
- **新增** `GpuScene.applyTextureVariants(paths, properties)`：对受影响的纹理重新 `selectVariants`，命中表变了才重写内容。宿主应用属性增量时，在就地写之后、下一帧之前调。

### 点 5 — 文档、回归、语料
- `cocs/wpe/WPE_SCENE.md` 新增一节「纹理变体（P11e）」，FreeImage 一节改正 `isVideoMp4` 的说法；`cocs/README.md` 主题与适用场景各补一句。
- `versions/latest/regression.md` 新增一节，`changelog.md` 用户侧一行、开发侧一行。
- 语料：`kbp corpus scan` 前后比较，预期只有 `3817265356` 变化。

## 验证

- **单测**（只跑相关文件）：
  - `compile/tex.test.ts`：手工拼的带条件 `.tex` 逐字段解析；`layer5.tex` 的头与 4 级 × 3 张的区间；条件数 0 的语料样本与以前逐字节相同；
  - `compile/textureVariants.test.ts`：判定的各种类型、同组第一条、位 2 截断、混合与原格式照报；
  - `render/` 的假设备测试：上传时写入的顺序与 origin、换选择只重写内容、选择不变不写。
- **变异**：判定不看类型、同组不去重、位 2 不截断、换选择不重写。
- **WPE 对照**（FINAL_CHECK）：点 0 的生成工程整帧比；`3817265356` 用 `kbp content isolate` 只留对象 #1，三个取值各录一段、按日志回放逐像素比；运行中换值那一帧另抓。
- **真机**：预览 `3817265356`，在属性面板切换「腿」的三个选项，画面当场换，桌面同样。

## 待定（请定）

1. **标志位 1（按 alpha 混合）与原格式变体**：语料 0 处（唯一一张是 FreeImage、标志 0）。推荐先照报（`tex:variant:alphablend`、`tex:variant:raw`），等语料出现再做；也可以这次一起做（混合要在 GPU 上写一个小 pass，原格式在 Worker 里按 `FUN_14015c480` 的格式表逐行拷）。
2. **属性定义没有 `value` 键时**：WPE 空指针崩溃。推荐照报 `tex:variant:no-value`（崩溃组合照报的惯例）。

## 实施记录

### 决定（2026-11-21 用户）

- 待定 1、2 都按推荐：标志位 1（按 alpha 混合）、原格式变体、属性定义没有 `value` 键都照报，代码里标 `TODO:[WPE_SCENE]`。

### 点 0：WPE 实测（2026-11-21）

生成器 `ignore/p11/defs/p11e.py`（`kbp gen p11e --data ignore/p11`），写 `materials/kbv/var.tex`：底图三级 mip（512×256 / 256×128 / 128×64），8 条条件、6 组。参考实现 `ignore/p11/e/ref_variants.py` 照读码解析、选择、逐级合成，和 WPE 抓帧里图像层 `g_Texture0` 存下的各级 mip 逐像素比（抓帧在 `A:\p11e\`，存图在 `ignore/p11/e/wpe/`）。

| 工程 / 操作 | 属性 | 命中 | 和参考实现比 |
|---|---|---|---|
| `p11e-var`（运行中开窗即抓） | leg "2"、flag false、num 2（数字）、mode "n" | 无 | 0 差（只有底图） |
| `p11e-var-l1` | leg "1"、flag true | 1（不是同组的 3）、4、8 | 三级 0 差 |
| `p11e-var-l3b` | leg "3"、mode "b" | 2、6（标志 1 混合） | 三级 0 差 |
| `p11e-var-s` | num 是字符串 "2" | 5 | 三级 0 差 |
| `p11e-var-r` | leg "1"、mode "r" | 1、7（标志 2）、8 | **不同**，见下 |
| `p11e-var` 运行中 `apply_properties` | leg "3"、flag true | 2、4 | 0 差 |
| 再改回 | leg "2"、flag false | 无 | 0 差（回到底图） |

结论：
- **加载时选择**：同一组只认第一条命中的（id 3 和 id 1 条件相同，不生效）；不同组按文件顺序先后覆盖（D 盖在 A 上）；每级 mip 用它自己的矩形（第 1 级的 A 故意不按比例，WPE 照它贴）。
- **判定**：数字值的 combo 判假、同值的字符串判真；字符串形式的条件要布尔 true。
- **标志位 1**：按读码的打包整数公式（rgb `dst + ((src − dst)·a >> 8)`，r、b 两个通道打在一个 32 位里算，alpha 取较大）逐像素相同。按决定照报，参考实现留在 `ref_variants.py` 的 `blend`，将来做时直接对照。
- **标志位 2 是 WPE 缺陷**：变体是 PNG 时，WPE 把编码后的 PNG 字节当像素上传，三级 mip 开头都是 PNG 原文（`89 50 4e 47…`），后面接着读到文件里下一组变体的头，是越界读（`replace_bytes.py`）。资源编译器不产生标志位 2，语料 0 处：按「语料不依赖的缺陷不复刻」，我们解码后照整张替换的本意贴，记为有意不同。
- **运行中换值**：改值后抓到的帧已经是新选择，改回没有命中的值回到底图；每次重载后纹理的 RenderDoc 资源号变了（WPE 新建了纹理对象），和读码「原地重载」的说法不矛盾（重建 GPU 资源）。具体哪一帧生效没测（`apply_properties` 和抓帧之间的帧数不受控），按读码是下一帧。

### 点 1–5：实现（2026-11-21）

- **点 1 解析**（`compile/tex.ts`）：读条件数与条件表，删掉照 LWE 的 `mipLayoutVersion === 4` 分支；条件数 > 0 时每级 mip 之后读变体块，只记区间（`TexResult.variants`，第 0 张图像）。照报 `tex:variant:raw`（底图或变体不是浏览器能解的 FreeImage 格式）、`tex:variant:alphablend`、`tex:variant:multi-image`，都标 `TODO:[WPE_SCENE]`。`FREE_IMAGE_MIME` 导出给 bundle 用。
- **点 2 选择**（`compile/textureVariants.ts`，新增）：`parseVariantCondition`、`variantHolds`、`selectVariants`、`sameSelection`、`variantPlan`（含 WPE 的出界检查，整张替换同样查）、`variantPropertyNames`。
- **点 3 进 bundle 与绑定**：`SceneTexture.variants`（条件表、每级条目带 `mime`、编译时的值 `values`）；绑定目标 `{ kind: "texture-variant"; path; name }`（`BindingCollector.bindTextureVariant`）；`planApply` 本来就把非 recompile 的归到就地写；宿主 `targetPath` 与脚本运行时 `targetKey` 加上这一类（`texturevariants/<路径>/<属性>`，不加会落进 default 和同纹理的别的属性撞键）。属性定义没有 `value` 键、条件是对象形式时照报 `tex:variant:no-value`。
- **点 4 解码与合成**：`decodeEncodedTextureList` 把变体位图一起解码（失败或尺寸不符的跳过、不让整张失败）；`render/textures.ts` 新增 `writeBitmapMips` / `initialVariantSelection`，`uploadTexture` 多一个 `selected` 参数；`SceneState.variantValues` + `DirtyState.textureVariants`；`GpuScene` 建场景时接过 `variantValues`，`uploadAt` 按当前值选，`syncTextureVariants` 在 `syncUserTextures` 之后、命中表变了才重写。
- **点 5 文档**：`WPE_SCENE.md` 新增「纹理变体（P11e）」、改正 `scene.pkg` 一节里 `isVideoMp4` 的说法；`cocs/README.md` 主题与适用场景；回归 V0–V8；changelog 两行。

### 验证（2026-11-21）

- **单测**：tsc 0 error；`compile/textureVariants.test.ts`（11 条：判定、命中表、贴图计划、解析、编译期绑定与 `no-value`）、`compile/tex.test.ts`、`render/p11b.test.ts`（借它的假设备加 2 条：上传顺序与位置、换选择只重写同一张纹理）、`host.usertextures.test.ts`，96 个用例全过。
- **变异**（`ignore/p11/e/mutate_p11e.py`，按原字节还原）：同组不去重、判定不看类型、整张替换不截断、选择不变也重写、不读每级变体块，5 处全部检出。
- **语料**：`kbp regress --corpus --no-cases`（HEAD `94d5b4fc` 快照对工作区，工作区的 `apps/wpe-scene` 只有本步的改动）0 张变化；`kbp corpus scan --project …/myprojects/3817265356`：没有不支持项（之前 `tex:parse:materials/1_0002_图层-5.tex:Error: 纹理数据越界`）。

### 走查（FINAL_CHECK，2026-11-21）

- **生成工程在我们这边**：`p11e-var-l1`、`p11e-var-s` 在 1920×1080（窗口等于场景分辨率、图层 1:1）和 WPE 同尺寸抓帧整帧比（屏蔽 FR / CLK），各 2 帧逐像素相同。说明我们写进 GPU 纹理的内容和 WPE 的一致（点 0 已证明参考实现和 WPE 的纹理逐 mip 相同）。
- **`3817265356` 复制工程**：`kbp content isolate --keep 91 --instrument`，属性「腿」"1" / "2" / "3" 各一份（`make_leg_copies.py`），WPE 各抓 2 帧（1920×1080、fps 20、ultra），`renderFrames.ts` 按日志回放（单开宿主）后 `kbp cmp frames`：

  | 取值 | 命中 | 最大差 | 有差像素（每帧） |
  |---|---|---|---|
  | "1" 黑丝 | 变体 1 | 2 | 12 / 76 |
  | "2" 白丝 | 无（底图） | 1 | 67 / 595 |
  | "3" 无 | 变体 2 | 1 | 617 / 307 |

  没有命中、只画底图的 "2" 和贴了变体的两份是同一量级，差异来自 3127×2000 的纹理在 1920×1080 上缩小采样，不来自变体；生成工程在 1:1 下 0 差也排除了合成本身。**未解释**：无。
- **工具上的坑**：dev 应用这次从 `target-dev/debug/resources/wpe-scene` 读宿主产物，`buildSceneHost.ts` 缺省按调用方的 `CARGO_TARGET_DIR`（没设就是 `target/`）写，第一次换进了 `target/`、应用还在用旧产物（报的是旧解析的「图片区间被截断」）。用 `--out-dir` 写进 `target-dev` 后正常。
- 测试工程（16223–16227）已用 `projects_remove` 移除。
