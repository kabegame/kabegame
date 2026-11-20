# P14 — 脚本自定义几何（`IModelData`）

> 上级：[../PLAN.md](../PLAN.md)「P14」。样本：3834692798（Karin，把 Live2D Cubism 运行时整个写进场景脚本的移植壁纸）。
> 相关：P5c 静态网格（[phase-5c-mesh.md](../phase5/phase-5c-mesh.md)）、P6d3b 运行时建层（[phase-6d3-runtime-layers.md](../phase6/phase-6d3-runtime-layers.md)）、
> L5 建层走片段（[phase-l5-create-layer.md](../live/phase-l5-create-layer.md)）。
> 已有读码：[rea-p6d-layers.md](../phase6/rea-p6d-layers.md) 第 1 节（宿主接口 `H+0x50` / `+0x60`、`general.precache`）、
> [rea-p6d-script.md](../phase6/rea-p6d-script.md)（回调地址、`'MODL'` 判定、形状 `material` 的 `RP` 改写）、[rea-p5-mesh.md](../phase5/rea-p5-mesh.md)
> （模型加载、顶点格式表、`model` 为数字的分支）。工作目录 `ignore/p14/`。

## 总体设计思路

`IModelData` 让场景脚本把顶点 / 索引缓冲直接交给 WPE：`thisScene.createModelData({ shapes: [...] })` 返回句柄，`createLayer({ model: 句柄 })`
建模型层，之后每帧 `applyData` 换顶点（和索引），`replaceData` 整体换形状，`destroyModelData` 释放。步骤 0 双向验证过：WPE 建的就是 mdl 文件
加载出来的同一种模型资源，形状的格式就是 mdl 的 26 位掩码、按表序交错（E1），模型层和 mdl 模型层走同一个绘制函数（E7、E14）。所以我们
**把 `IModelData` 当成「内存里的 mdl」**：模型层照旧是 P5c 的模型层，顶点布局、属性配对、占位属性、视锥剔除都用 `render/mesh.ts`，不另写一套；
新的只有「字节从哪来」和「怎么在运行中当帧建出来」。

数据分三处，方向是「脚本 → 主线程数据仓 → GPU」，编译只看描述：
- **数据仓 `ModelDataStore`**（宿主主线程，新模块 `modeldata/`）：按 token 存每个形状的格式、材质、顶点 / 索引字节（调用时拷一份，E3b）、
  索引格式、动态标志、包围盒、版本号与引用计数（脚本一份 + 每个图层一份）。脚本 API 只和它打交道；`applyData` 改字节、记版本。
- **编译按描述**：对象 JSON 里的 `model` 是整数 token（S16）。编译时宿主把 token 的**描述**（每个形状的格式、顶点数、索引格式与个数、材质；
  包围盒）随开会话输入或片段请求带进 Worker，`compileModel` 按描述建 `SceneModel`，每个形状照 mdl 网格编一个材质 pass；`SceneMesh` 不带字节，
  只记来源 `{ token, shape }`。字节不进 Worker、不进 bundle。
- **GPU 动态缓冲**：GPU 场景按 `(token, 形状)` 建自己的顶点 / 索引缓冲（多个图层共用，E9），每帧在 `encode` 开头按版本 `writeBuffer`，
  当帧生效（E3）。

运行中建层用**方案甲**（用户定）：WPE 当帧建好，Karin 又在第一次 `update` 里一口气建出全部部件，所以模型数据层不走 L5 的片段缓存，
而是**在主线程同步拼片段**：
- 加载时按 `general.precache` 把列出的材质编成「模型材质模板」（`finalize` 里编，程序排在程序表尾，同泛光的做法），这正是 WPE 预载材质的用意；
- `createLayer({ model: token })` 时，配置只有平常字段（没有绑定、脚本、关键帧、effect）且每个形状的材质都有模板，就用编译期同一个纯函数
  拼出图层字面量与 `SceneModel`、把模板 pass 改键成 `objects/<i>/meshes/<m>/passes/<k>`，照 L5 命中缓存那条路当场接进场景并同步装上 GPU；
- 不满足的（材质没预编、配置带绑定等）走 Worker：片段请求带上描述，异步编、晚几帧出现（同 L5 没命中）。整场重载、L6 单对象重编也带描述，
  所以这些层在重载之后仍在。

**两条路必须等价**：主线程拼出的片段与 Worker 对同一配置、同一描述编出的片段逐字段相同，用对照测试守住（同 L5 的会话对照）。

关键决策（步骤 0 之后定稿）：
- **只照做双向验证过的行为**（「步骤 0 的结论」）；WPE 缺陷 D1–D12 不复现，记成「和 WPE 有意不同」。
- **模型层不参与光标命中**，同 mdl 模型层（用户定，记为差异）。
- **包围盒只在建时定一次**（同 WPE）：给了用给的，没给按位置分量算（D6）；`applyData` / `replaceData` 都不改。
- **报错时机**：材质有模板时 `createModelData` 当场按模板查着色器输入、照 WPE 抛错；材质没预编时当场不知道着色器，创建照常成功，
  编出来缺属性时那个图层不画、经看板娘提示（运行中的不支持项，L5b）——已知差异，Karin 的材质都预编了。
- **微任务时机**：WPE 在 `update` 返回前跑完它排出的微任务（`update` 里的 `async` 续体也算在 `update` 里，S13）；我们的 realm 是浏览器的微任务，
  在整帧脚本之后才跑，这时 `replaceData` 放行——记为差异，不为它改运行时。
- **能力表**：`createModelData` / `destroyModelData` 从 `MISSING_SCRIPT_API` 删掉，`general.precache` 进解析表不再报；`model` 是对象等其它类型照旧报 `model:id`。

## 样本与用法（3834692798，步骤 0 之前的静态阅读）

扫描（`ignore/p14/0/scan.json`，HEAD `af726345`，本机语料 234 张）：只有这一张有不支持项，就是本节的三个键
（`general:precache`、`script:api:thisScene.createModelData`、`script:api:thisScene.destroyModelData`）。

工程结构：
- 32 个对象：3 张背景图像层、1 个控制层 "Karin native Scene controller"（图像层 `models/input.json`，`visible` 上挂 2.6 MB 的脚本）、
  10 个声音层、18 个字幕图像层（`cue_*`）。Live2D 的部件全部由脚本运行中建。
- 自带着色器 `karin_clip`、`karin_clip_multiply`、`karin_mesh`、`karin_original_fx_0..4`、`karin_input`、`karin_sway_6`；材质 `mesh_0/1`
  （普通部件）、49 个 `clip_*`（带遮罩的部件）、`original_fx_0..4`（游戏特效粒子）。`general.precache` 列的就是这些材质。
- 脚本的调试常量 `IDLE_ONLY=false, FIXED_FRAME=0, PROFILE_SECONDS=0`：改成 `FIXED_FRAME=N` 时脚本按固定 1/60 推进 N 帧并打印
  `KARIN_SCENE_SAMPLE {modelHash …}`；`PROFILE_SECONDS` 打印每帧脚本耗时。走查时在复制工程里改这两个常量，两边比日志。

脚本里的用法：

| 用途 | 建法 | 每帧 |
|---|---|---|
| 普通部件（每个部件一个） | 格式 `[POSITION, NORMAL, UV, COLOR]`（12 个 float），`Uint16Array` 索引（静态），材质 `MATERIALS[纹理]`，`isVertexBufferDynamic`；`createLayer({ id: 1000+i, name, model, origin, scale, perspective: false })` | 写位置与 `a_Color.w`（不透明度）→ `applyData({ vertexBuffer })` |
| 带遮罩的部件（49 个） | 格式 `[POSITION, NORMAL, TANGENT_SIGNED, UV, COLOR]`（16 个 float），容量按实测最大值留余量，`Uint16Array` 或 `Uint32Array` 索引（≥ 65536 时），两个缓冲都动态；材质 `clip_*`（`MASK_COUNT` / `INVERTED` 组合） | 遮罩坐标塞进法线、切线、颜色通道；不用的三角形填 0；`applyData({ vertexBuffer, indexBuffer })` |
| 合批（同纹理、相邻的普通部件） | 同普通部件，`visible: false` 建出 | 合批有效时写合批缓冲、`applyData` |
| 扩容（遮罩部件超出容量） | 新建一份更大的 `createModelData` + `createLayer`（id 30000+），旧的隐藏、留到 `destroy` 才删 | — |
| 游戏特效粒子 | 格式 `[POSITION, UV, COLOR]`（9 个 float），`Uint16Array` 索引，材质 `original_fx_*`，`solid: false`，id 5100+ | 填四边形 → `applyData({ vertexBuffer })` |

另有：每帧 `sortLayer` 调整部件顺序（绘制顺序变了时）、改 `layer.origin` / `scale` / `visible`；`destroy()` 里逐个 `destroyLayer` +
`destroyModelData`；不用 `replaceData`。脚本注释记了两条 WPE 行为，步骤 0 要核对：
- 「Dynamic model layers do not bind their alpha field to g_Color4」——所以遮罩部件把不透明度放进模型矩阵 z 轴的缩放（`karin_clip.vert`
  里 `v_Opacity = length(mul(vec4(0,0,1,0), g_ModelMatrix).xyz)`）；
- 「Replacing a live GPU buffer from a deferred SceneScript callback can deadlock the native renderer」——所以扩容时不 `replaceData`，另建一份。

## 现状锚点

**a. 两个方法在缺口表里，整张退回**（`compile/scriptApi.ts:75`）
```ts
thisScene: [
  // 模型数据 → P6；`createLayer` 由 P6d3b、`getCameraTransforms` / `setCameraTransforms` 由 P5e 实现
  ...methods("root", ["createModelData", "destroyModelData"]),   // 现状：报 script:api:thisScene.createModelData / destroyModelData
  …
],
```

**b. `general.precache` 落进「其余 general 键」的兜底**（`compile/features.ts:497-508`）
```ts
for (const [key, value] of Object.entries(g))
  if (
    !NEUTRAL_GENERAL.has(key) &&
    !PARSED_GENERAL.has(key) &&
    …
    active(value)
  )
    unsupported.add(`general:${key}`);   // 现状：非空的 precache 数组报 general:precache
```

**c. `registerAsset` 的 precache 位不用**（`script/api.ts:1350-1361`）
```ts
// 否则记进这段脚本的登记表（P6d3b 的 `__workshopId` 改写用）并返回路径本身。WPE 的 exe 不读这张表，所以 precache 什么都不做
this.method(this.engine, "registerAsset", (path?: unknown, _precache?: unknown) => {
  if (!this.evaluating) throw this.syntaxError("registerAsset can only be called from global scope.");
  if (typeof path !== "string") return null;
  …
  return path;   // 现状：返回路径本身（同 WPE），precache 参数丢掉
});
```

**d. `createLayer` 不认单个 `IModelData` 参数**（`script/createConfig.ts:141`）
```ts
export function createLayerConfig(args, ctx) {
  if (args.length !== 1) return { image: defaultLayerModel(ctx.orthographic) };
  const arg = args[0];
  if (typeof arg === "object" && arg !== null) {
    let text: string | undefined;
    try {
      text = ctx.stringify(arg);   // 现状：IModelData 本身经 stringifyAdapter 变成 token 串 → 解析出字符串、不是对象 → null
    } catch { return null; }
    …
    return isPlainObject(parsed.value) ? tidy(parsed.value, ctx) : null;
  }
  …
}
```
WPE 的 dll 先判内部字段 2 是 `'MODL'`、包成 `{ model: 句柄 }` 再序列化（rea-p6d-script 1.2）。配置对象里写 `model: 句柄` 的形式现在能走通
序列化（`IModelData.toConfigString` 返回 `__modelDataToken`），但编译期不认（下一条）。

**e. 编译期 `model` 只认路径**（`compile/bundle.ts:2141-2150`）
```ts
async function compileModel(index: number, object: SceneObject, layer: SceneLayer): Promise<void> {
  layer.perspective = object.perspective === true;
  // 数字是脚本 `createModelData` 建的模型（rea 2.1），语料 0 个
  const path: unknown = object.model;
  if (typeof path !== "string") {
    unsupported.add("model:id");   // 现状：不是字符串就报
    return;
  }
  const file = await readMdl(path);   // 现状：token 串会被当路径读、报 mdl:missing:<token>
  …
```

**f. 网格的字节来自 mdl 文件、建一次**（`compile/bundle.ts:852` 的 `SceneMesh`，`render/scene.ts:4533`）
```ts
export interface SceneMesh {
  format: number;
  stride: number;
  vertices: Uint8Array;   // 现状：mdl 文件缓冲上的视图
  indices: Uint8Array;
  vertexCount: number;
  indexFormat: "uint16" | "uint32";
  indexCount: number;
  material: string;
  passes: ScenePass[];
  shadow?: ScenePass;
}
```
```ts
if (step.kind === "mesh") {
  const mesh = layer.model?.meshes[step.mesh];
  …
  vertexBuffer = this.meshBuffer(mesh.vertices, GPUBufferUsage.VERTEX, `${name} vertices`);   // 现状：静态缓冲，没有 COPY_DST
  meshDraw = {
    indexBuffer: this.meshBuffer(mesh.indices, GPUBufferUsage.INDEX, `${name} indices`),
    indexFormat: mesh.indexFormat,
    count: mesh.indexCount,
    …
  };
}
```

**g. 顶点格式表已有这五项，表序就是 d.ts 要求的顺序**（`compile/mdl.ts:57-72`）
```ts
export const MDL_ATTRIBUTES: readonly MdlAttribute[] = [
  attr(0x1, "a_Position", "POSITION", 0, 3),   // IModelData.POSITION
  attr(0x10000, "a_PositionVec4", "POSITION", 0, 4),
  attr(0x2000000, "a_PositionC1", "POSITION", 1, 3),
  attr(0x2, "a_Normal", "NORMAL", 0, 3),        // IModelData.NORMAL
  attr(0x4, "a_Tangent4", "TANGENT", 0, 4),     // IModelData.TANGENT_SIGNED
  …
  ...texcoords(0, [0x8, 0x10, 0x20]),           // 0x8 = IModelData.UV
  …
  attr(0x8000, "a_Color", "COLOR", 0, 4),       // IModelData.COLOR
];
```

**h. 运行中建层只有 L5 一条路**（`host.ts:963`）
```ts
private onCreateLayer(config: string, parent: number | null): number | null {
  …
  const object = createStructureObject(state, this.structure, this.allocator, config, parent);   // 壳状态
  if (object === null) return null;
  const live = this.runtimeTask ? this.loadingLive : this.live;
  …
  live.create(object, config, state.layers.get(object)?.parent ?? null);   // 现状：按规整配置查片段缓存，命中同步、没命中排队进 Worker
  return object;
}
```
片段缓存的键是规整配置（`fragmentCache.ts:20`，名字、`origin` 都在键里），Karin 每个部件名字不同，全都命不中。

**i. 片段请求不带模型数据**（`compile/fragment.ts:46`）
```ts
export interface FragmentRequest {
  object: number;
  config: string;
  overrides?: Record<string, number[] | boolean | string>;
  parent: number | null;
  bone: string | null;
  properties: Record<string, unknown>;   // 现状：没有 modelData，Worker 不知道 token 对应什么
}
```

## 步骤 0 — 逆向与实测（先做）

产出：[rea-p14-script.md](rea-p14-script.md)（dll 侧）与 [rea-p14-exe.md](rea-p14-exe.md)（exe 侧），两份并行写，格式同 rea-p6d-*（每条标
【确】/【推】、给地址，接口重叠处以 exe 那份为准）；WPE 实测记录写进本文件「步骤 0 的结论」一节，之后按结论改写步骤 1–4 并请用户定
待定项。二进制与 P6d 时相同（2.8.42，`bin/scenescript64.dll` 与 `wallpaper64.exe` 都是 2026-10-25 的版本），rea-p6d 的地址仍然有效；
REA 旧快照已失效（REA 升级），不带快照重新打开。

### 0a — dll 侧（`scenescript64.dll`）
1. `createModelData`（`0x1816361f0`）：
   - 作用域限制（模块顶层能不能调）、参数个数与类型；
   - `shapes` 与「直接传一个形状」两种写法、`boundingBoxMins` / `boundingBoxMaxs`（只收 `Vec3`？）；
   - 每个形状的校验：`vertexBuffer` 必须是 `Float32Array`？长度是不是 stride 的整数倍；`indexBuffer` 收 `Uint16Array` / `Uint32Array`、
     可省；`vertexFormat` 的元素与顺序规则（重排、重复、未知值、空数组）；`material` 的类型、缺省与 `RP` 改写（`0x181630e88`）；
     两个 `is*Dynamic`；
   - 失败时抛什么（错误类型与文字，报错串在 `0x1819a2d00`–`0x1819a2f60`）还是返回 null；
   - 字节怎么交给 exe（`H+0x50` 的参数形状）：拷贝还是借用；
   - 返回对象：内部字段（字段 2 = `'MODL'`）、`__modelDataToken` 的格式与生成规则、原型（baseclasses 的 `IModelData`）、`applyData` /
     `replaceData` 模板怎么挂上。
2. `applyData` / `replaceData`：参数写法（数组 / 单个、`null` 删形状或索引）、只传部分键、长度 / 格式不符时的处理、`replaceData` 在
   `update` 里抛错的判定方式与文字、调到 exe 的哪个槽（`H+0x58` → `FUN_1401d6400`【推】）。
3. `destroyModelData`（`0x181636890`）：参数校验、作废句柄后再用（`applyData`、`createLayer`）的行为、JS 对象被回收而没调
   `destroyModelData` 时有没有释放。
4. `createLayer` 的 `'MODL'` 包装（rea-p6d-script 1.2 已有）补全：`{ model: 句柄, … }` 与单参数两种写法的配置原文；`getInitialLayerConfig`
   读到的 `model` 是什么。

### 0b — exe 侧（`wallpaper64.exe`）
1. `FUN_14018c720`（建 `MDLV0011`）：形状 → 网格的对应、格式位怎么由 `vertexFormat` 算、stride、索引格式、没有索引时怎么画、材质加载
   （同 mdl 的皮肤材质？`skin` 怎么取）、缺省材质、包围盒缺省（按顶点算还是固定值）、动态缓冲的 D3D 用法。
2. 更新路径：`applyData` 什么时候真正上传（当场 / 帧尾 / 绘制时）、形状数或长度不符时、`replaceData` 重建哪些东西（和注释说的
   「延迟回调里替换会死锁」对上）。
3. 模型对象工厂里 `model` 是 token 时怎么找到模型数据（rea-p5-mesh：「为数字时按 id 取脚本创建的模型数据」），同一份数据被多个图层用、
   `destroyModelData` 后图层还在时的引用计数（`FUN_14018d8b0`）。
4. 模型层的 `alpha` / `color` / `brightness` 是否进 `g_Color4`（P5c 结论是固定 1，对照脚本注释），`g_ModelMatrix` 是否就是世界矩阵；
   视锥剔除用的包围盒；模型层能不能被光标命中（P6c 只做了图像 / 文本层）。
5. `general.precache`（场景构造 `0x140187d15` 一带）：只认 `materials…`？预载进 `ctx+0x1630` 之外有没有别的效果；编辑器怎么生成这张表
   （`registerAsset(路径, true)`，对照 ui 的 `scripts.js`）。

### 0c — 反向验证（测试工程）

**双向验证**：读码是正向（从代码推出行为），测试工程是反向（在 WPE 里实测行为、回头核对代码）。
- 0a / 0b 的每条结论（尤其【推】与「未查清」）都在下面的对照表里有一个用例，「预期」写读码推出的结果，实测后填「实际」。
- 实测出的、读码没预言的现象，回到读码找原因，两边一致才算定论；读码解释不了的实测结果不直接当规则用。
- 认定为 WPE 缺陷的行为也要实测确认它真是这样，再按「缺陷不复现」的原则定做法（见「步骤 0 的结论」的缺陷清单）。

工程：`kbp gen` 新模块 `p14`，输出 `ignore/p14/0/proj/`，WPE 抓帧与日志放 `A:\p14\<用途>\`。
- **`p14-api`**：只验脚本 API 的返回值与报错，不看画面。一个图像层挂脚本，在模块顶层、`init`、`update`（第 1 帧、第 N 帧）、
  `applyUserProperties`、`setTimeout`、`async` 续体里按编号逐条调用，每条打一行 `[kbp] S<编号> <结果>`（返回值的类型 / 值、抛出的
  错误类型与原文）。两边各跑一次，日志逐行比。
- **画面类**（每个工程只验一件事，抓帧比像素，必要时读 RenderDoc 的顶点 / 常量）：`p14-format`、`p14-index`、`p14-apply`、`p14-bounds`、
  `p14-fields`、`p14-cursor`、`p14-share`、`p14-precache`，具体用例随 0b 的结论补。

**dll 侧对照表**（rea-p14-script，S = script）：

| 编号 | 读码结论（预期） | 用例 | 实际 |
|---|---|---|---|
| S1 | `createModelData` 在模块顶层抛 `SyntaxError: createModelData cannot be called from global scope.`；`init` / `update` / 其它回调里都能调 | 顶层、`init`、`update`、`cursorClick` 各调一次合法配置 | 顶层原文一致 ✓；`init`、`update`、`setTimeout`、`cursorClick` 里都能建 ✓（`p14-api2`） |
| S2 | 没有参数、参数不是对象 → `null`，不抛 | `()`、`(1)`、`("x")`、`(null)` | 四种都返回 `null` ✓；另：两个参数时第二个忽略、照常建出 |
| S3 | 有 `shapes` 数组就逐个当形状，否则整个配置当一个形状；`shapes: []` 抛 `Shapes missing.` | 两种写法各建一个并 `createLayer` 画出来；`shapes: []` | ✓：单形状写法建出；`shapes: []` → `Shapes missing.`；`shapes` 不是数组 → `Vertex buffer missing.`（整个配置当一个形状） |
| S4 | 顶层传数组 → 当成一个形状（数组没有 `vertexBuffer` → `Vertex buffer missing.`） | `([形状])` | ✓ `Vertex buffer missing.` |
| S5 | 包围盒只要两个都是对象，读 `.x .y .z`，非数字分量记 0；`{x,y,z}` 普通对象也生效 | 与 0b 的剔除用例合并：`Vec3` / 普通对象 / 只给一个 | 四种都建出，字符串包围盒也不报错 ✓；剔除画面未验 |
| S6 | `vertexBuffer` 不是 `Float32Array` → `Vertex buffer missing.`；dll 不查长度 | `Float64Array`、普通数组、长度不是 stride 整数倍（看 exe 码 3） | ✓：`Float64Array` / 普通数组 → `Vertex buffer missing.`；长度 7 → 码 3 `Inconsistent vertex buffer size`（exe 侧报错，走释放路径，见下「两次崩溃」） |
| S7 | `indexBuffer` 收 `Uint16Array` / `Uint32Array`，别的类型静默忽略（当无索引） | `Int32Array`、`Uint8Array` 的画面 | 四种都建出 ✓；画面未验 |
| S8 | `vertexFormat` 区分大小写按位或，不查顺序 / 重复，未知串跳过，遇非字符串元素停；结果为 0 抛 `Vertex format missing.`；`Vertex format in incorrect order.` 不可达 | 乱序（看画面错位）、重复、`'Position'`、`[UV, 1, NORMAL]`、`[]` | ✓：乱序、重复都建出（确认不查顺序）；`'Position'` / `[]` / `['foo']` / 非数组 → `Vertex format missing.`；遇非字符串停；着色器要 `a_Color` 而格式没有 → 码 2 |
| S9 | `material` 必须是字符串，否则 `Material missing.`；没有缺省材质；路径无效 → exe 码 1 `Invalid material`；超过 255 字节截断 | 缺省、数字、不存在的路径、带 `__workshopId` 的脚本 | 缺 / 数字 → `Material missing.` ✓；registerAsset 返回值 ✓；**不存在、超长 → 码 2 `Shader expecting more vertex data.` ✗**（预测码 1；WPE 另打材质 JSON 解析错误），已回 exe 读码 |
| S10 | `is*Dynamic` 只认 JS 布尔，其它当「未给」 | `1`、`"true"`、不给，之后 `applyData`（看 exe 码 7） | ✓ 只有 `true` 算动态；`false` / `1` / `"true"` / 不给 → `applyData` 报码 7 |
| S11 | 形状是 `null` 打删除标志、`undefined` / 数字交全零形状，创建时 dll 都不报 | `shapes: [合法, null]`、`[合法, 5]` | 未跑（risky） |
| S12 | 返回对象：`__modelDataToken` 是只读、不可枚举的 Number；原型是 `IModelData.prototype`；`applyData` / `replaceData` 是实例自有属性；`md.POSITION` 为 `undefined` | 打印描述符、`Object.keys`、`getPrototypeOf`、`hasOwnProperty`、连建三个看 token 序列 | ✓：token 从 1 起连续、失败的创建不占号；描述符 `{writable: false, enumerable: false, configurable: false}`；`Object.keys` = `applyData,replaceData`；原型 ✓；`applyData` 是自有属性，**所有实例是同一个函数对象**；`md.POSITION` 为 `undefined`；严格模式写 token 抛 `TypeError`；`toConfigString()` 返回数字 |
| S13 | `replaceData` 只在回调编号为 `update` 时抛 `IModelData.replace cannot be called in update.`；`applyData` 不限 | `update`、字段脚本的 `update`、`applyUserProperties`、`setTimeout`、`update` 里排的 `async` 续体（未查清 2） | ✓（`p14-api2`）：`update`、字段脚本的 `update`、**`update` 里排的 `async` 续体**都抛 `IModelData.replace cannot be called in update.`（未查清 2：微任务在 `update` 返回前跑）；`init`、`applyUserProperties`（加载时 WPE 也调一次）、`setTimeout`、`cursorClick` 里放行；`applyData` 在 `update` 里放行 |
| S14 | `applyData` / `replaceData` 缺键不报错，长度、格式、形状数不符由 exe 返回码 2–13 | 变长、加形状、删形状、换材质、换格式，各在 `applyData` 与 `replaceData` 下调一次 | `applyData` 全部和 exe 伪代码一致：a–d、j、n 不报（变短不报）；e、m 码 7（变长报 7 不报 5）；f 码 10；g、h 码 11；i 码 12；k 码 13；l 码 9。`replaceData`：p（带全参数变长）、s、t 不报；u 未确认 |
| S15 | `destroyModelData` 只收 Uint32 数字：传对象静默无效；传 token 生效；模块顶层抛错 | 传对象后继续 `applyData` 与画面；传 `md.__modelDataToken` 后 `applyData`（看 exe 码 4）与图层画面 | ✓（`p14-api2`）：传对象 / 字符串 / `-1` 都静默无效，之后照常 `applyData`；传 token 后 `applyData` 报码 4 `Invalid model data token`，再 `createLayer` 照样建出（不画）；有图层在用时传 token 一次，资源留着、`applyData` 照常；`destroyLayer`（返回 `true`）当帧 `applyData` 照常、下一帧报码 4（帧尾删层时释放） |
| S16 | `createLayer(md)` 与 `{model: md}` 同路，配置里 `model` 是整数 token；`getInitialLayerConfig(layer).model` 是那个整数 | 两种写法各建一个，打印初始配置 | ✓（`p14-api2`）：`createLayer(md)` 建出名字为空的层，初始配置 `{"model":1}`；`{model: md, name, origin}` → `{"model":1,"name":"ML","origin":"0 0 0"}`（键按字典序、`model` 是整数）；直接写数字 token、查不到的 99999、字符串 token 都建出层 |
| S17 | 未查清 3：`applyData()` / `applyData(null)` 留给脚本的是 `TypeError` 还是 `SyntaxError` | 两种调用各一次 | `applyData()` / `replaceData()` → V8 的 `TypeError: Cannot read properties of undefined (reading 'boundingBoxMins')`；`applyData(null)` → 当成一个 `null` 形状 → 码 11；`applyData(5)` → 当成全零形状、不报不改（`p14-api2`） |

**两次崩溃（2026-11-20）**：`p14-api` 在用户常驻的 WPE 里跑了两轮，两轮都在 `init` 中途让 WPE 崩溃（桌面壁纸随后由
`ensure_running` 拉起）。日志停在不同位置（S14t / S14s），转储（`ignore/p14/0/crash/wallpaper64.exe.880540.dmp`）是 `c0000374` 堆损坏、
在 dll 的一次 `RtlFreeHeap` 里检测到，所以出事点更早、日志是缓冲写出的。回读码的结论（rea-p14-exe 第 7 节、rea-p14-script「实测对照」）：
- 没有双重释放：「未查清 8」否定，建失败、`destroyModelData` 减到 0、图层析构、场景卸载（关窗、换壁纸）都只释放一次。
- 检测到损坏的是 V8 惰性编译（`CompileLazy` → `IterativelyExecuteAndFinalizeUnoptimizedCompilationJobs`）释放的一个 8 字节局部 vector，
  只是第一个撞上坏堆的地方；被写坏的是同一档（LFH 16 字节）的小块。
- S14p → S14s → S14t 在 exe 侧没有越界写；dll 侧的形状解析、材质截断、`RP` 改写也没有。写坏堆的人两边读码都没找到。
- 读码确认会写坏堆的只有：`replaceData` 让形状数变多之后再给旧形状换材质（材质串缓冲释放后使用）；以及【推】`destroyModelData`
  调用次数多于脚本那份引用而图层还在用（资源在图层底下释放）。测试一律避开。

**第三轮（`p14-api2`，2026-11-20）**：只用正常输入跑 S13、S15、S16、S17（不做 exe 侧报错的创建、`replaceData` 只就地上传、每个 token
最多 `destroyModelData` 一次），没有崩溃，关窗后 WPE 正常。

**exe 侧对照表**（rea-p14-exe，E = exe）。画面类工程 `make_draw.py` 生成 `p14-format` / `p14-apply`，WPE 抓帧 `A:\p14\format\`、`A:\p14\apply\`
（1920×1080，与场景一比一），只用正常输入。按「壁纸依赖才验」挑选：Karin 依赖的都验，缺陷区与 Karin 不用的不验（表末）。

| 编号 | 读码结论（预期） | 用例 | 实际 |
|---|---|---|---|
| E1 | 格式就是 mdl 的 26 位掩码：POSITION 0x1、NORMAL 0x2、TANGENT_SIGNED 0x4、UV 0x8、COLOR 0x8000，按表序交错，stride 为各项字节和 | `p14-format` 四个三角形：`[P,N,U,C]`、`[P,N,T,U,C]`、`[P,U,C]`、`[P,N,U]`，每个属性填不同常量，读 vs_in 与像素 | ✓ stride 48 / 64 / 36 / 32，偏移 0/12/24/32、0/12/24/40/48、0/12/20、0/12/24，语义 POSITION / NORMAL / TANGENT / TEXCOORD / COLOR；着色器输出按预期编码（如格式 A 读出 0.2627 = n.x + 0.01·n.y + 0.01·n.z） |
| E2 | 有 `Uint16` / `Uint32` 索引按索引画，没有索引就 `Draw(顶点数)`，恒为三角形列表 | `p14-apply` 的 `IDX_NONE` / `IDX_U16` / `IDX_U32` | ✓ `Draw(3)` / `DrawIndexed(3)` / `DrawIndexed(3)` |
| E3 | `applyData` 当场 `Map` + `memcpy`，当帧生效 | 每帧 `applyData` 写 x = 100 + k，同时写图层 `origin.y = k` | ✓ 抓到的帧 vs_in x = 240、vs_out 换算的 `origin.y` = 140，同一个 k |
| E3b | 调用时拷贝，之后改数组不影响本帧 | `applyData` 之后同一帧把数组改成 y = 900 | ✓ 画的是 y = 400 |
| E6 | 给了包围盒就按它剔除（两角变换后的外接球） | 顶点在画面里，包围盒一个在 (5000, 5000) 外、一个罩住顶点 | ✓ `BBOX_OUT` 没有绘制，`BBOX_IN` 画出 |
| E7 | 模型层的 `g_Color4` / `g_Alpha` / `g_Color` 写死 1，图层 `alpha` / `color` / `brightness` 不进着色器；`g_ModelMatrix` 含 `scale.z` | `GCOLOR`（alpha 0.2、color 红、brightness 0.5，着色器输出这三个 uniform）；`ZSCALE`（`scale.z` 0.5 / 0.25，输出 z 轴长度） | ✓ 纯白；127/255 与 64/255 |
| E9 | 多个图层共用一份数据：同一组 D3D 缓冲 | 一份数据两个图层，每帧 `applyData` | ✓ 两次绘制是同一个顶点缓冲资源，内容相同、同一个 k |
| E11 | `replaceData` 重建网格并同步通知图层，同一帧换新网格 | `setTimeout` 里把三角形换成带 6 个索引的四边形（形状数不变、参数给全） | ✓ 抓帧里是 6 个索引的四边形 |
| E14 | 材质加载不加引擎 COMBO；材质 JSON 自己的 `combos` 照常生效（Karin 的 `MASK_COUNT`） | 材质 `combos: {P14C: 1}`，着色器 `#if P14C == 1` 画红、否则蓝 | ✓ 红 |
| E15 | id 从 1 起连续、只在成功时分配；查不到的 id 建出不画的层；引用计数 = 脚本一份 + 每图层一份 | 见 S12、S15、S16 | ✓（`p14-api` / `p14-api2`） |
| E16 | 模型网格的 pass 读 `_rt_FullFrameBuffer`：模型绘制不拷快照（rea-p5-mesh 2.6），读到什么没测 | `make_fb.py`：`p14-fb1`（红底 → 左半绿 → 读帧缓冲的模型层）、`p14-fb2`（多一个先拷快照的图像层 SNAP），抓帧 `A:\p14b1b\`、`A:\p14b2\` | ✓ 模型绘制前没有拷贝；fb1 槽里的 `_rt_FullFrameBuffer` 全 0、模型画成黑；fb2 读到 SNAP 在红底时拷的旧快照（底下是绿也画红）。**3834692798 依赖**：全场只有 `clip_119`（`karin_clip_multiply`，用帧缓冲做正片叠底）读它，没有别的层拷快照，所以 WPE 里这个部件是带透明度的黑色。**用户定不照**（WPE 把它画坏了，不是作者的效果建立在缺陷上）：补拷快照、让正片叠底生效，记有意不同 |

不验（缺陷区或 Karin 不用，按「缺陷不复现」原则实现时不照抄，见「步骤 0 的结论」）：没给包围盒时的乱算、无索引网格 `applyData` 后只画 1/4、
`applyData` 数组变短时的多读、`replaceData` 加形状后的释放后使用、`destroyModelData` 多于引用数、只比语义名不比语义号、模型层的光标命中、
precache 的帧时间。

真实场景（不是反向用例，是最终对照的基准）：
- 3834692798 本体抓几个时刻的整帧，读 WPE 日志里的 `KARIN_*` 行与报错（WPE 测试窗口会放它自带的语音与音乐）；
- 复制工程改 `FIXED_FRAME`（固定帧的 `modelHash`）与 `PROFILE_SECONDS`（WPE 每帧脚本耗时），留作步骤 4 的对照基准。

## 步骤 0 的结论（2026-11-20）

读码（rea-p14-script、rea-p14-exe）与测试工程（`p14-api`、`p14-api2`、`p14-format`、`p14-apply`）两边一致的，就是要照做的行为：
- **形状**：`createModelData` 收 `{ shapes: [...] }` 或单个形状；顶点必须是 `Float32Array`、字节数是 stride 的整数倍；索引收
  `Uint16Array` / `Uint32Array`（别的类型当没有）；格式按位或成 mdl 掩码、按表序交错（E1）；材质必填。报错一律 `SyntaxError`，文字见
  rea-p14-script 第 9 节；只有模块顶层不能调。
- **句柄**：`IModelData.prototype` 上的实例，`__modelDataToken` 是只读、不可枚举的数字，从 1 起、只在成功时分配；`applyData` /
  `replaceData` 是自有属性、所有实例共用同一个函数；`toConfigString()` 返回 token；`createLayer` 的配置原文里 `model` 是整数。
- **更新**：`applyData` 当场拷贝、当帧生效（E3、E3b），不许加 / 删形状、删缓冲、换材质、换格式、写非动态缓冲（码 7、9–13）；有索引时
  绘制数 = 这次的索引个数。`replaceData` 可以重建，同一帧换网格（E11），在 `update`（含字段脚本的 `update` 与它排出的 `async` 续体）里抛错。
- **绘制**：和 mdl 模型层同一条路；材质只带自己的 `combos`（E14）；`g_Color4` / `g_Alpha` / `g_Color` 恒为 1，`g_ModelMatrix` 含 `scale.z`（E7）；
  给定包围盒按外接球剔除（E6）；多个图层共用缓冲（E9）。
- **生命周期**：引用计数 = 脚本一份 + 每个图层一份；最后一个用它的图层删掉后、帧尾释放（S15）；查不到的 token 建出不画的层（S16）。
- **`general.precache`**：只是加载时预载 `materials` 开头的材质进缓存，不改语义、`createLayer` 照样同步。我们用它在加载时预编这些材质。

**WPE 缺陷**（语料只有 3834692798 用这套 API，它都不依赖；按「缺陷不复现」，建议都按文档意图做、记成「和 WPE 有意不同」）：

| # | WPE 的行为 | 依据 | 建议的做法 |
|---|---|---|---|
| D1 | `destroyModelData` 只收数字 token，传 `IModelData` 对象静默无效（d.ts 与 Karin 都传对象，Karin 的模型数据因此从没释放过） | S15 | 对象与数字 token 都收 |
| D2 | 格式顺序不查，`Vertex format in incorrect order.` 走不到；乱序时顶点数据与布局错位 | S8a | 乱序抛这条报错 |
| D3 | `applyData` 变长报码 7 `Model data not created as dynamic`，码 5 / 6 走不到 | S14e、S14m | 报 `Vertex buffer size cannot increase` / `Index buffer size cannot increase` |
| D4 | `applyData` 数组比建时短，按建时容量从源数组多读 | rea-p14-exe 3.2 | 只拷给出的长度，其余保持 |
| D5 | 无索引网格 `applyData` 后绘制数 = float 数 ÷ stride 字节数（只画 1/4） | rea-p14-exe 3.2 | 绘制数 = 顶点数 |
| D6 | 没给包围盒时把整段交错 float 当 xyz 三元组求 min / max | rea-p14-exe 2.6 | 只取位置分量 |
| D7 | `replaceData` 让形状数变多后，旧形状的材质串指向已释放的缓冲（释放后使用） | rea-p14-exe 3.4 | 正确实现 |
| D8 | `replaceData` 没写 `vertexFormat` 又要重建时 stride 0 除零（崩溃） | rea-p14-exe 3.4 | 没写格式就沿用原格式 |
| D9 | `destroyModelData` 次数多于脚本那一份引用时，资源会在图层底下被释放 | rea-p14-exe 4.3 | 每个句柄只释放一次 |
| D10 | 创建时 `undefined` / 数字形状交全零形状、`null` 形状打删除标志，都不报错 | rea-p14-script 4 | 创建时按缺 `vertexBuffer` 报错；`applyData` 里照 WPE（数字是空操作、`null` 报码 11） |
| D11 | 材质加载失败不报码 1：换成 `error` 着色器，格式没有 UV 报码 2，有 UV 就用 error 着色器画出来 | S9c、rea-p14-exe 7.2 | 报 `Invalid material` |
| D12 | 材质路径截到 255 字节 | rea-p14-script 4 | 不截 |
| D13 | `applyData` / `replaceData` 的顶层数组被当成一个形状（静默无效）；d.ts 写的是收 `Object|Array` | rea-p14-script 6、S14b | 数组逐个当形状（步骤 1 实施时定，同 d.ts） |
| D14 | `replaceData` 换索引类型（`Uint16` ↔ `Uint32`）不重建、报码 9；d.ts 说 `replaceData` 可以换成不兼容的数据 | rea-p14-exe 3.1 | 重建（步骤 1 实施时定） |

**已定（用户，2026-11-20）**：缺陷 D1–D12 全部照建议做（不复现，记「和 WPE 有意不同」）；模型层不参与光标命中（同 mdl 模型层，记为差异）；
建层用方案甲（主线程同步拼模型数据层，没预编的材质才异步）；3834692798 本体的基准抓帧留到步骤 4。

原来的待定项（留作记录）：
1. 上面的缺陷清单逐条照建议做，还是有要照抄的。
2. **模型层的光标命中**：WPE 里模型层参与命中（包围盒 slab）。Karin 的模型层不挂脚本、不挡传播，不依赖；P6c 现在只做了图像 / 文本层。
   做不做（不做就和 mdl 模型层一样不参与命中）。
3. **建层同步还是异步**：WPE 当帧建好，Karin 在第一次 `update` 里建全部部件。L5 没命中片段缓存时异步编片段，部件会晚几帧、分批出现。
   - 方案甲：模型数据层在主线程同步拼片段（材质用 precache 预编好的程序，顶点布局现算），第一帧就全部画出，同 WPE；没预编的材质才走异步。
   - 方案乙：照 L5 走异步，签名缓存命中后的部件当帧出现，只有开场有几帧不全。
4. 3834692798 本体的基准抓帧（会放它自带的语音与音乐）现在抓，还是等实现完再抓。

## 步骤 1 — 数据仓与脚本 API（`modeldata/`、`script/modelData.ts`）

可单独验收：只有单测，场景行为不变（缺口表这一步不动，能力表照旧整张退回）。

### 点 1 — 描述与数据仓（`modeldata/types.ts`、`modeldata/store.ts`，新增）
- **新增**
```ts
// modeldata/types.ts
/** 一个形状的描述（编译用，不带字节）。stride 由格式算（`mdlStride`，E1）。 */
export interface ModelDataShapeDesc {
  format: number;
  vertexCount: number;
  /** null：没有索引，`draw(顶点数)`（E2） */
  indexFormat: "uint16" | "uint32" | null;
  indexCount: number;
  /** 经 `__workshopId` 改写后的路径（不截断，D12） */
  material: string;
}
export interface ModelDataDesc {
  token: number;
  shapes: ModelDataShapeDesc[];
  /** min xyz、max xyz：给了用给的，没给按位置分量算（D6）；建时定一次，之后不改 */
  bounds: number[];
}
```
```ts
// modeldata/store.ts
export class ModelDataStore {
  /** E15：从 1 起，只在成功时分配，不复用 */
  private next = 1;
  private readonly entries = new Map<number, ModelDataEntry>();
  /** 结构变了（形状数、格式、材质、容量）时通知：GPU 场景重建缓冲，宿主重拼用它的图层 */
  onStructure: ((token: number) => void) | null = null;
  onRelease: ((token: number) => void) | null = null;

  /** 校验通过的输入（`script/modelData.ts` 已按 dll 规则整理）；拷贝字节。失败抛 `ModelDataError`（文字见 rea-p14-script 第 9 节） */
  create(input: ModelDataInput, check: MaterialCheck): number;
  /** applyData：码 4、7、9–13 的规则；变长报 5 / 6 的正确文字（D3）；数组变短只拷给出的长度（D4）；绘制数 = 这次的索引数，无索引 = 顶点数（D5） */
  apply(token: number, shapes: ModelDataUpdate[]): void;
  /** replaceData：可重建、加删形状；没写格式就沿用原格式（D8）；不改包围盒 */
  replace(token: number, shapes: ModelDataUpdate[], check: MaterialCheck): void;
  /** 引用：脚本一份（每个 token 只释放一次，D9）+ 每个图层一份；减到 0 释放、调 `onRelease` */
  releaseScript(token: number): void;
  retainLayer(token: number, object: number): boolean;   // 查不到返回 false：图层照建、不画（S16）
  releaseLayer(token: number, object: number): void;
  desc(token: number): ModelDataDesc | null;
  shape(token: number, shape: number): ModelDataShape | null;   // { vertices: Uint8Array; indices: Uint8Array | null; drawCount; version }
}
```
  > 说明：`check` 是「材质有模板时查着色器输入」的回调（步骤 2 的模板表），步骤 1 先传恒通过的桩。

### 点 2 — 脚本 API（`script/modelData.ts` 新增，`script/api.ts` 修改）
- **新增** `installModelData(api)`：
  - `thisScene.createModelData` / `destroyModelData` 用 `sceneMethod`（模块顶层抛 `... cannot be called from global scope.`，S1）。
  - 参数整理照 rea-p14-script 第 2–4 节：没有参数或不是对象返回 `null`（S2）；`shapes` 是数组就逐个、否则整个配置当一个形状（S3、S4）；
    创建时非对象形状按缺 `vertexBuffer` 报错（D10）；`vertexFormat` 区分大小写、遇非字符串停、乱序抛 `Vertex format in incorrect order.`（D2）；
    包围盒两个都是对象才生效、读 `.x .y .z`（S5）；`is*Dynamic` 只认 JS 布尔（S10）；`material` 经 `__workshopId` 改写（`createConfig.ts` 已有的
    `rewriteWorkshopPath`，键为空）。
  - 句柄：realm 里 `Object.create(IModelData.prototype)`，`__modelDataToken` 不可写、不可枚举、不可配置；`applyData` / `replaceData` 是可枚举的
    自有属性、全部实例共用同一个函数（S12）；`toConfigString` 来自 baseclasses。
  - `applyData(x)`：`x` 是数组就逐个、否则当一个形状；参数是 `undefined` 时照 V8 抛 `TypeError`（读 `boundingBoxMins`，S17）；数字形状不改、
    `null` 形状报码 11（D10 只改创建）。
  - `replaceData`：运行时当前回调是 `update`（含字段脚本的 `update`）时抛 `IModelData.replace cannot be called in update.`（S13）。
  - `destroyModelData(x)`：`x` 是 `IModelData` 句柄或 Uint32 token 都收（D1），其余静默；同一句柄只释放一次（D9）。
- **修改** `createLayerConfig`（`script/createConfig.ts:141`）：单参数是 `IModelData` 句柄时先包成 `{ model: 句柄 }`（S16）。
```ts
if (typeof arg === "object" && arg !== null) {
  const value = ctx.isModelData?.(arg) ? { model: arg } : arg;   // 新增：单参数句柄包成 { model }
  let text: string | undefined;
  try {
    text = ctx.stringify(value);   // 修改：序列化包好的值，model 经 toConfigString 变成整数 token
  } catch { return null; }
  …
}
```
- **修改** `ScriptRuntime`：对外给出「当前是不是 `update` 回调」（`replaceData` 用），字段脚本的 `update` 同算。
- 验收：单测覆盖 S1–S17 的每条（S11 换成 D10 的新规则）与 D1–D12 中属于 API 的条目；报错文字逐字照 rea-p14-script 第 9 节；变异按原字节还原。

### 步骤 1 实施记录（2026-11-20）
- 执行代理（sonnet）实现，越界检查只动了计划内的文件。新增 `src/modeldata/types.ts`、`store.ts`、`store.test.ts`、`src/script/modelData.ts`、
  `modelData.test.ts`；修改 `script/api.ts`（`ScriptApiState.modelData` / `materialCheck`、`installModelDataApi`、`createLayer` 接句柄判定）、
  `script/createConfig.ts`（`isModelData`）与它的测试。
- 验收时改了一处：**宿主给了数据仓才装这两个方法**。没接时 `thisScene` 的成员与以前相同，和缺口表里仍登记着它们不矛盾（否则 `api.test.ts`
  的成员快照与缺口表核对会红到步骤 3b）。
- 代理自己定的细节：realm 的 `IModelData` 原型第一次建句柄时从 `realm.global` 取；跨 realm 的类型化数组用 `%TypedArray%` 的 `toStringTag` 认；
  码 9 照 exe 先传顶点、处理完其余形状再抛；`material: ""` 创建时算字符串（交给材质检查），更新时当没给；D13、D14 见缺陷表。
- 验证：`src/modeldata` + `src/script` 32 个文件 601 通过、2 跳过；`tsc --noEmit` 无错。变异（`ignore/p14/1/mutate.py`，按原字节还原）13 处杀掉 12 处，
  活下来的「脚本引用只释放一次」的守卫是等价变异（脚本引用是布尔、图层引用是集合，重复释放本来减不到负数）。

## 步骤 2 — 编译：按描述建模型对象、预编材质模板（`compile/bundle.ts`、`compile/fragment.ts`、`compile/features.ts`）

可单独验收：会话带描述时数字 `model` 编得出；不带描述的场景编译产物逐字节不变（全语料摘要比较）。

### 点 3 — 描述进编译输入
- **修改** `FragmentRequest`（`compile/fragment.ts:46`）与开会话输入：
```ts
export interface FragmentRequest {
  …
  /** 新增：配置里 `model` 是整数 token 时，宿主带上它的描述（P14）；查不到的 token 不带，编出不画的层（S16） */
  modelData?: Record<number, ModelDataDesc>;
}
```
  开会话输入同样加 `modelData`（整场编译时 `structure.created` 里引用到的 token），L6 单对象重编的请求也带。

### 点 4 — `compileModel` 的数字分支（`compile/bundle.ts:2141`）
- **修改**
```ts
async function compileModel(index: number, object: SceneObject, layer: SceneLayer): Promise<void> {
  layer.perspective = object.perspective === true;
  const path: unknown = object.model;
  if (typeof path === "number") {                                   // 新增：脚本 createModelData 的 token（P14）
    const desc = modelDataDescs[Math.trunc(path)];                    // 开会话 / 片段请求带进来的描述
    layer.model = desc ? compileModelData(index, desc) : null;        // 查不到：不画（S16）
    if (layer.model) layer.sortClass = …;                            // 同 mdl 分支
    return;
  }
  if (typeof path !== "string") {
    unsupported.add("model:id");                                      // 现状保留：对象等其它类型
    return;
  }
  …
}
```
- **新增** `compileModelData(index, desc)`：每个形状建一个 `SceneMesh`（`{ format, stride: mdlStride(format), vertices: 空视图, indices: 空视图,
  vertexCount, indexFormat, indexCount, material, passes, source: { token, shape } }`），pass 走 `compileMesh` 同一段（`compilePass(…, { key:
  objects/<i>/meshes/<m>/passes/<k>, material, model: true })` + `checkMeshAttributes`）；`bounds = desc.bounds`、`order = meshDrawOrder(…)`、
  `version: 0`、`path: ""`。图层字面量与 `SceneModel` 的组装抽成纯函数（`modeldata/layer.ts` 的 `modelDataModel`），步骤 3a 的主线程拼装用同一份。
- **修改** `SceneMesh`（`compile/bundle.ts:852`）：
```ts
export interface SceneMesh {
  …
  /** 新增：脚本模型数据的来源（P14）；有它时 vertices / indices 是空视图，字节在宿主的数据仓、GPU 缓冲按它取 */
  source?: { token: number; shape: number };
}
```
- **修改** `compileOne` 的图层字面量（`compile/bundle.ts:3043`）抽成 `layerLiteral(object, index, parent, shell, colorBlendMode)`，编译期与步骤 3a 共用；
  编译产物逐字节不变。

### 点 5 — 模型材质模板（`finalize`）与 `general.precache`
- **新增**：`finalize` 里在泛光之后，对 `general.precache` 中以 `materials` 开头（不分大小写）的字符串，各编一份模板：
```ts
export interface ModelMaterialTemplate {
  /** pass 键是 `modeldata/<n>/passes/<k>`，拼装时改成 objects/<i>/meshes/<m>/passes/<k> */
  passes: ScenePass[];
  shadow?: ScenePass;
  /** 编它时登记了绑定、翻了场景位、有不支持项或 A2C：不能同步拼，按 Worker 路走 */
  usable: boolean;
}
// SceneBundle 新增（只在有内容时写，别的场景字节不变）
modelMaterials?: Record<string, ModelMaterialTemplate>;   // 键是材质路径
```
  不支持项记进私有集合，不污染整场；程序排在程序表尾（同 `flushGroupUploads` 的约定）。
- **修改** `PARSED_GENERAL`（`compile/features.ts:247`）加 `precache`，不再报 `general:precache`。
- 验收：单测——带描述的数字 `model` 编出的 `SceneModel` 字段、查不到的 token 编出 `model: null`、模板的 `usable` 判定；`kbp corpus scan` 全语料
  除 3834692798 外结果不变，3834692798 只剩两个 `script:api:*`（缺口表在步骤 3b 删）。

## 步骤 3a — 主线程同步拼装（`modeldata/assemble.ts`、`host.ts`、`script/createLayerChange.ts`）

可单独验收：对照测试（拼装 = Worker 编），不碰 GPU。

### 点 6 — 拼装
- **新增** `assembleModelDataFragment({ object, id, parent, config, desc, templates, programs }) → ObjectFragment | null`：
  - 同步条件：配置的键都在白名单（`id name model origin angles scale visible alpha color brightness perspective parent solid parallaxDepth`）、
    值都是平常值（不是 `{ user | script | animation }` 对象）、每个形状的材质都有 `usable` 模板；不满足返回 null（走 Worker）。
  - 图层：`layerLiteral(object, …, layerShellValues(object), colorBlendModeOf(…))` + `modelDataModel(desc, passes)`；pass 由模板改键；
    `checkMeshAttributes(programs[pass.program], format)` 照编译期报不支持项（进 `fragment.unsupported`，L5 规则：不画、提示）。
  - 片段的其余字段：`bindings: []`、`scripts: []`、`animations: []`、`sceneFlips: []`、`reflected` 照 `compile/reflection.ts` 的判定、`config = normalizeConfig(…)`。
- **修改** `onCreateLayer`（`host.ts:963`）：
```ts
const live = this.runtimeTask ? this.loadingLive : this.live;
…
const token = modelTokenOf(config);                                  // 新增：配置里 model 是整数
if (token !== null) {
  const desc = this.modelData.desc(token);
  const fragment = desc
    ? assembleModelDataFragment({ object, id, parent, config, desc, templates: bundle.modelMaterials, programs: bundle.programs })
    : null;
  if (fragment) { live.landAssembled(fragment); return object; }    // 新增：同步装上（同 L5 命中缓存那条路）
  live.create(object, config, parent, { modelData: desc ? { [token]: desc } : {} });   // 修改：Worker 路带上描述
  return object;
}
live.create(object, config, state.layers.get(object)?.parent ?? null);   // 现状
```
- **修改** `LiveObjects`：`landAssembled(fragment)` = `this.land({ fragment }, true, "create")`；`create` / 重编请求把描述放进 `FragmentRequest.modelData`；
  整场重载开会话时宿主按 `structure.created` 收集描述。
- **修改** 引用计数：模型数据层装进状态时 `retainLayer`，`removeObjectEverywhere` / 帧尾删层时 `releaseLayer`（S15 的时机）。
- **修改** `replaceData` 结构变了（形状数、格式、材质）：对每个用这个 token 的图层重新拼装、`replaceObject`；拼不了的走 L6 的单对象重编（带新描述）。
- 验收：对照测试——3834692798 的三种部件配置、`p14-format` / `p14-apply` 的配置，主线程拼出的片段与 `compileFragment` 编出的逐字段相同（改键后
  深比较）；改一个白名单外的键、去掉一个材质的模板，都退回 Worker 路。

### 步骤 3a 实施记录（2026-11-20）
- 执行代理（sonnet）实现：新增 `src/modeldata/assemble.ts`（`assembleModelDataFragment`、`ASSEMBLE_KEYS`、`modelTokenOf`）与对照测试
  `assemble.test.ts`（18 例）、宿主测试 `src/host.p14.test.ts`（8 例）；修改 `host.ts`（数据仓随脚本运行时建与丢、`access.modelData` /
  `materialCheck`、`createOn` 两条路、`collectModelData` 让整场重载带描述、建壳时 `retainLayer`、`removeObjectEverywhere` 里 `releaseLayer`、
  `onStructure` → `rebuildModelObject`：已接进来的层能拼就按替换接回、拼不了走 L6 重编，Worker 片段还在路上的到达时用 `modelFragmentStale`
  核对过期）、`script/createLayerChange.ts`（`LiveTarget.modelData` 钩子：发请求时现取描述，L6 重编同一处；`landAssembled(fragment, mode)`）、
  `modeldata/store.ts`（`layersOf`）、`compile/bundle.ts`（模板加 `castsShadows`，拼装据此算 `castShadow`）。
- 白名单最终是 `id name model origin angles scale visible alpha color brightness perspective parent solid parallaxDepth colorBlendMode castshadow`，
  值只收数字 / 布尔 / 字符串；透视场景、有平面反射（`bundle.reflection.enabled`，只在有模型读 `_rt_Reflection` 时才有，Karin 没有）、token 与描述不符
  也退回 Worker。
- 验收时改了一处：「数字 model 不进片段缓存」从 `createLayerChange.ts` 的两处读写守卫收进 `fragmentKey`（返回 null）与 `seed`（跳过）。原来整场重载后
  `seed` 会把这类对象预置进缓存（只是读不到），变异「读侧不跳过」因此杀不死；收进一处后补了 `fragmentCache.test.ts` 的两条用例。
- 真实数据对照（`ignore/p14/3a/karin-parity.test.ts`，3834692798 解包工程 + 真翻译器）：普通部件、遮罩部件、合批、游戏特效四种配置拼装与
  `compileFragment` 逐字段相同、Worker 不加新程序；`clip_119`（读帧缓冲）拼不了、Worker 报 `mdl:framebuffer`（3b 的 E16 改）。
- 验证：相关 117 个测试文件 2355 通过；`tsc` 无错；变异（`ignore/p14/3a/mutate.py`）9 处杀掉 8 处，活下来的就是上面收进 `fragmentKey` 的那条。

## 步骤 3b — GPU 动态缓冲与收尾（`render/scene.ts`、`compile/scriptApi.ts`、`dev/probe.ts`）

### 点 7 — 缓冲与每帧上传
- **修改** `createDraw` 的 mesh 分支（`render/scene.ts:4533`）：
```ts
if (step.kind === "mesh") {
  const mesh = layer.model?.meshes[step.mesh];
  if (!mesh) throw new SceneRenderError([`render:mesh:${step.mesh}`]);
  if (mesh.source) {                                                   // 新增：脚本模型数据（P14）
    const gpu = this.modelDataBuffers(mesh.source);                     // (token, 形状) 一份，多个图层共用（E9）
    vertexBuffer = gpu.vertices;
    meshDraw = { indexBuffer: gpu.indices, indexFormat: mesh.indexFormat, count: gpu.drawCount, source: mesh.source, … };
  } else {
    vertexBuffer = this.meshBuffer(mesh.vertices, GPUBufferUsage.VERTEX, `${name} vertices`);   // 现状
    …
  }
}
```
- **新增** `modelDataBuffers(source)`：按数据仓的容量建 `VERTEX | COPY_DST`（与 `INDEX | COPY_DST`）缓冲，建时写入当前字节；无索引网格 `draw(顶点数)`。
- **新增** `syncModelData()`：在 `encode` 开头（`syncPuppetIndices` 旁）对每个用到的 `(token, 形状)` 比版本，变了就 `writeBuffer`（4 字节对齐）并更新共用它的
  draw 的绘制数；一帧多次 `applyData` 只写一次。
- **新增** 数据仓的 `onStructure` → 释放旧缓冲、重建用到它的图层（`rebuildLayer`）；`onRelease` → 释放缓冲。
- 视锥剔除照旧用 `model.bounds`（E6）；`g_Color4` 等照旧固定 1（E7）。
- **修改** 模型网格读 `_rt_FullFrameBuffer`（E16，用户定不照 WPE）：编译期不再报 `mdl:framebuffer`（mdl 模型与脚本模型同一条，语料里 mdl 模型 0 个），
  模板也不再因它判不可用；渲染时读帧缓冲的模型图层在画之前**拷一次快照**（同图像层的层首拷贝，每图层至多一次），正片叠底按作者意图生效。
  和 WPE 有意不同：WPE 画模型不拷，读到最近一次别的层拷下的内容（没人拷过是 0）。
- **修改** GPU 场景建场景时把模板的程序加进 `used`（同泛光、体积光，`render/scene.ts:3634`），同步拼出的层第一次 `prepareObjectSync` 就有程序
  （原在步骤 2，`render/scene.ts` 当时有别的会话的改动，挪到这里）。

### 点 8 — 能力表与探针
- **删除** `MISSING_SCRIPT_API.thisScene` 里的 `createModelData` / `destroyModelData`（`compile/scriptApi.ts:75`），同步 `api.test.ts` 的双向核对。
- **修改** dev 探针 `createProbeLive` / `renderFrame`：同一套拼装与数据仓，`prewarmFragments` 跳过模型数据层（它们本来就同步）。
- 验收：`p14-format` / `p14-apply` 在 dev 应用里渲染，和 WPE 抓帧（`A:\p14\format\`、`A:\p14\apply\`）逐像素比（`kbp cmp frame`）；`p14-api` /
  `p14-api2` 两边日志逐行比（D1–D12 与微任务差异处按预期不同）；全语料 234/234 干净。

### 步骤 3b 实施记录（2026-11-20）
- 执行代理（sonnet）实现：
  - **数据仓进 GPU 场景**：`SceneLoadOptions.modelData` 与 `GpuScene.build` 的 `modelData` 都是「取当前数据仓」的函数，清空脚本存储会换数据仓。
    只读接口 `ModelDataReader` 放在 `modeldata/types.ts`。
  - **缓冲组**：`render/scene.ts` 新增 `ModelBufferSet`（键 `token:形状`，多图层共用），配套 `modelBufferSet` / `releaseMeshModel` / `syncModelData`。
    `syncModelData` 在 `encode` 开头、`syncPuppetIndices` 之后。
  - **无索引绘制**：`MeshDraw.indexBuffer` 改为可空，主 pass `draw`，阴影 pass `draw(count, 1, 0, view)`。
  - **E16 快照**：`planModelLayer` 在任一网格读帧缓冲时加层首 `snapshot` 步骤，模型 op 带 `snapshot`，编码时没被剔除才拷。
  - **编译**：`compileMesh` 与模板不再报 `mdl:framebuffer`；建场景时 usable 模板的程序进 `used`。
  - **缺口表**：删两个键。
  - **探针**：自己持有数据仓，建层先走同步拼装，片段请求带描述，结构变化能拼就替换。
  - **共用**：宿主与探针共用 `modelMaterialCheck`（挪进 `modeldata/assemble.ts`）。
- 和点 7 的写法不同：释放不靠数据仓的 `onStructure` / `onRelease`（宿主已经占用 `onStructure` 做重拼），改成两条规则：
  - 缓冲组按引用它的 draw 计数，最后一个 draw 摘掉时销毁。
  - 数据仓里这个形状的字节数组换了（`replaceData`），新图层另建一组，旧组留给还没重拼的图层。容量不符的旧组不再写入，先画旧的。
  - token 释放后绘制数归零。
- 验收时改了一处：`shadowCasterSteps` 原来跳过 `!mesh.indexCount` 的网格（P13d 写的，当时 mdl 网格都有索引），无索引形状因此建不出投射者，阴影 pass 的
  无索引分支是死代码。改成 `!mesh.indexCount && !mesh.source` 才跳过。WPE 里无索引形状投不投影没实测，语料 0 个，按和有索引的一样投影。
- 变异（`ignore/p14/3b/mutate.py`）：头一轮 27 处活下来 12 处，执行代理补了 9 处的测试：
  - 两层共用时逐个重拼；
  - 模板程序预建；
  - 读帧缓冲的模板 usable；
  - 渲染器与宿主交出数据仓；
  - `modelMaterialCheck` 四种返回；
  - 探针脚本的数据仓、retain / release。

  剩下的处理：
  - 「阴影无索引」那条随上面的改动补上。
  - 探针 `probe.ts` 里的三处（传数据仓、同步拼、请求带描述）在闭包里、要 GPU，由真机 `render_scene` 覆盖。
- 语料：233/233 干净（`ignore/p14/3b/after.json`），带 3834692798 时 234/234（`karin.json`），与步骤 2 相比没有键变化。
- 变异第二轮 28 处杀掉 25 处。活下来的是 `probe.ts` 里的三处，由下面的真机渲染覆盖：
  - 少了「探针传数据仓」或「探针请求带描述」，p14-format 一个三角形都画不出来；
  - 「探针同步拼」由 `-pc` 变体的「同步 N」覆盖。
- 真机（dev 应用、探针 `render_scene` + `scripts`，`kbp cmp frame` 比 `ignore/p14/0/wpe-frames/`）：
  - **步骤 0 的原工程**都没写 `precache`，建层全走 Worker。
    - `p14-format` 和 WPE 整帧 0 差异。
    - `p14-apply` 回放 140 帧对 WPE 第 140 帧：只差 REPLACE。原因是 `replaceData` 改结构后拼不了，探针又没有单对象重编译（宿主走 L6）。其余各项 0 差异：
      TIMING（E3）、COPY（E3b）、SHARE（E9）、三种索引（E2）、BBOX（E6）。
  - **`-pc` 变体**由 `ignore/p14/3b/make_pc.py` 生成，是同样的工程加上 `general.precache` 列全部材质，建层全走同步拼装、当帧装上：
    - format 同步 8 个，像素摘要与 Worker 路相同；
    - apply 同步 10 个，和 WPE 第 140 帧整帧 0 差异，含 REPLACE 的四边形（E11）。
  - **`p14-fb1` / `fb2`（E16，有意不同）**：两条路都画出「三角形隐形」，即模型读到的是当前画面、原样输出。
    - 逐 draw 轨迹：红底、绿半边 → 快照 `t0 → t6` → 模型两个 `drawIndexed`，绑的 `_rt_FullFrameBuffer` 是 `t6`。
    - 和 WPE 的差异只在三角形上：fb1 两个，WPE 是黑的；fb2 只有左边那个，WPE 读到旧的红快照。
  - 应用日志没有新的告警。
- Karin（`ignore/p14/3b/karin-parity.test.ts`）：`clip_119`（正片叠底，读帧缓冲）现在能同步拼装，和 `compileFragment` 逐字段相同。

## 步骤 4 — 走查、性能与文档

- 3834692798：用户同意后抓 WPE 基准（会放语音与音乐）；复制工程改 `FIXED_FRAME`，两边 `KARIN_SCENE_SAMPLE` 的 `modelHash` 相同、整帧对照；
  正常运行的画面与部件出现时机（第一帧就全）。
- 性能：`PROFILE_SECONDS` 的每帧脚本耗时、2.6 MB 脚本的加载与改写耗时、每帧上传字节，和 WPE 比；`host.scripts()` 的 `totalMs`。
- 文档：`WPE_SCENE.md` 新增「脚本自定义几何（P14）」一节（行为、缺陷清单、两条建层路、差异），`cocs/README.md` 主题与适用场景，
  `versions/latest/regression.md` 一节，changelog 一行。

### 步骤 4 实施记录（2026-11-21）
- **复制工程**（`ignore/p14/4/make_karin.py`）：`karin-fixed`（`FIXED_FRAME=120`）、`karin-profile`（`PROFILE_SECONDS=10`）。
  - 两份都把 10 个声音层的文件换成 1 秒静音 wav，WPE 抓帧不出声。
  - `FIXED_FRAME` 下第一次 `update` 之后画面冻结，`features.update` 不调，换声音不影响对照。
- **固定帧**：
  - **`modelHash`**：WPE（`A:\p14\karin-fixed\`，1920×1080，第 538–540 帧）与 dev 探针的 `KARIN_SCENE_SAMPLE` 相同，`modelHash 3b2a47a2`、321 个 drawable。
  - **整帧**：按 WPE 那一帧的 `g_Time`（`kbp rdc consts`，只有一个 draw 读它，26.54088）用探针渲染，和 WPE 整帧比。207 万像素里只差 128 个，全在勺子边缘。
  - **差异来源**：抓帧里 event 719（顶点格式 PNTUC、像素着色器独一份）是 `clip_119`，它槽 2 的 `_rt_FullFrameBuffer` 在差异像素处是全 0，即 E16（`ignore/p14/4/zoom-karin-fixed.png`）。
- **性能**：`karin-profile` 各跑 10 s。WPE 是测试窗口、帧率设置 20，Kabegame 是 dev 应用图库预览（真宿主）、帧率 30：

  | | Kabegame | WPE |
  |---|---|---|
  | `update` 平均 / p95 / 最大 | 12.3 / 13 / 211 ms | 18.0 / 30 / 243 ms |
  | 部件数 | 315 | 315 |

  - **整帧**（宿主 `stats().frameMs`）：平均 15.7 ms、p95 18 ms。
  - **加载**（「开始渲染」日志）：7.2 s，其中编译 1.8 s、准备 0.7 s、首帧 3.1 s（第一次 `update` 建 Cubism 运行时与 358 个层），建层同步 358、异步 0。
  - **每帧上传**：从脚本 realm 的 `shared.karinScene.runtime.raw.drawables` 估，321 个部件、7513 个顶点（遮罩部件 49 个、1128 个顶点），约 0.39 MB 起；遮罩部件按容量传，实际更多。
- **`p14-api2` 日志对照**（计划点 8 的验收）：探针跑 120 帧加一次点击，和 WPE 日志（`log.txt` 2026-11-20T01:09 那一轮）逐行比。只差三处，见 `ignore/p14/4/api/README.md`：
  - S15d / S15d2：D1；
  - S13d：微任务时机；
  - 输入时机。
- **文档**：
  - `WPE_SCENE.md` 新增「脚本自定义几何（P14）」，P5c 一节的 `model:id`、`mdl:framebuffer` 两处同步改；
  - `cocs/README.md` 主题与适用场景；
  - `versions/latest/regression.md` 的 PM0–PM8；
  - changelog 用户侧一行。
- **没做的**：
  - PM7（在预览里看 3834692798 本体，会放语音与音乐）留给用户；
  - 上传量没按改过的范围优化，「风险」一节的上传量在 Karin 上不是瓶颈（脚本 12 ms、整帧 16 ms）。

## 风险

- **脚本体量**：2.6 MB 源码经 acorn 改写与间接 `eval`（P6d2）的加载耗时没测过；Cubism 每帧在 JS 里跑，我们的 API 封装更厚。
- **上传量**：遮罩部件按容量整段上传（Karin 每帧传满容量），每帧字节数可能不小；必要时按版本只传改过的形状。
- **两条路漂移**：之后改编译期的图层或模型字段时，主线程拼装要同步改；靠步骤 3a 的对照测试守住。
- **整场重载**：描述要跟着 `structure.created` 进开会话输入，漏了这些层会在重载后消失。
