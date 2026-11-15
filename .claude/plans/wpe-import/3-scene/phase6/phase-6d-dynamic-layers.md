# P6d — 动态图层与层级 API（子计划）

> 上级：[phase-6-script-text-sound.md](phase-6-script-text-sound.md)「P6d — 动态图层与层级 API」。P6a、P6b、P6c 已提交（P6c 最后一笔 `00e0b99c`）。
> 语料是 2026-11-15 在 HEAD `00e0b99c` 快照上的扫描（`ignore/p6/d0/corpus-head.json`，233 个工程，能渲染 156 张），脚本用法的粗扫在 `ignore/p6/d0/`（`ana.py`、`usage.py` → `usage.txt`、`templates2.py`、`fnsrc.py`）。现状锚点取自 HEAD `00e0b99c`。
> 分步：步骤 0 只调研；之后每步能单独验收、单独提交。各实现步骤的细节在步骤 0 之后补写。P9d、P11c、P12b、P13c、渲染尺寸在别的会话进行，`render/scene.ts`、`script/api.ts`、`compile/bundle.ts` 工作区里有别人没提交的改动，实现步骤动工前再核对一次共享文件。

## 总体设计思路

P6d 是两块难度差很多的东西。

**层级与 effect 访问**：`getParent` / `getChildren` / `getTransformMatrix`、`getEffect` / `getEffectCount`，以及 effect 对象上的 `getMaterial` 等。P4a 已经有父链与世界矩阵，P3c 已经有 effect 对象（`visible`）与材质常量的脚本对象，这一块是把现成的数据按 WPE 的形状交给脚本。它单独解锁不了场景（用到的 20 来张都还差别的），但清掉的键多。

**动态图层**：`createLayer` / `destroyLayer` / `sortLayer`、`getInitialLayerConfig`、`registerAsset`、`getLayerByID`。只差 P6d 的 4 张全是同一种：音频条可视化脚本在 `init` 里 `createLayer('models/bar.json')` 造 63 根条、再 `sortLayer` 到自己下面。难点在同步：WPE 的 `createLayer` 当场返回图层，脚本紧接着就写它的字段、排它的顺序；我们的编译（着色器翻译、纹理解码）在 Worker 里异步做。

动态图层的方向是**编译期备好模板，运行时同步实例化**：
- 编译期扫描脚本里 `createLayer` 的参数，能静态定下来的（字符串字面量、`registerAsset` 的字面量、`getInitialLayerConfig(现有图层)`、模型 / 文本键是字面量的对象字面量）各编一份模板，进 bundle 但不画。
- 运行时 `createLayer` 从模板实例化：分配新的对象键、建 `SceneState` 里的图层状态与 GPU 资源（WebGPU 建资源是同步的），按 WPE 的规则插进渲染顺序；`sortLayer` 改顺序；`destroyLayer` 摘掉并释放。
- 定不下来的参数（模型路径是运行时拼出来的等）照报 `script:createLayer:dynamic`，整张退回。也可以改成「图层先建出来、编译完再画」，取决于步骤 0 查出 WPE 是不是当帧就画。

今天的代码处处以 `scene.json` 的 `objects` 下标为稳定键（状态、绑定、脚本、动画、父链、命中）。新建的图层没有这个下标，计划给它们分配 `objects.length` 之后的键、只增不复用，现有的表都不用改形状；渲染顺序从 `bundle.layers` 的顺序拆出来，变成运行时的一张表。

步骤 0 要先查清 WPE 的语义，计划里先不猜。语料给了几条硬约束（0a）：
- `createLayer` 的参数有四种形态，见「范围与解锁」；8 张用字面量模型路径，而且路径要经过 `__workshopId` 改写才找得到文件。
- `registerAsset` 除了给 `createLayer` 用的模型、粒子（dino_run），还登记字体，返回的句柄直接赋给文本层的 `font`（`3570755196`、`3643916956`）。
- `getInitialLayerConfig` 的结果被脚本当普通对象读（`Object.keys` 找 `image` / `text` / `size`，`3808922316`），也直接交给 `createLayer` 克隆现有图层（3 张）。
- 我们的 `getLayerIndex` 现在返回 `objects` 下标；`sortLayer(bar, thisScene.getLayerIndex(thisLayer))` 依赖它和 WPE 渲染顺序的下标一致。

## 范围与解锁

用到 P6d 的 29 张（报下表任一键）：

| 键 | 场景数 |
|---|---|
| `script:api:thisScene.createLayer` | 14 |
| `script:api:layer.getParent` | 11 |
| `script:api:thisScene.sortLayer` | 10 |
| `script:api:layer.getTransformMatrix` | 6 |
| `script:api:layer.getEffect` / `getChildren` | 4 / 4 |
| `script:api:thisScene.getInitialLayerConfig` | 4 |
| `script:api:engine.registerAsset` / `thisScene.destroyLayer` | 3 / 3 |
| `script:api:effect.getMaterial` | 2 |

缺口表里另有 `getLayerByID`、`setParent`、`lookAt`、`rotateObjectSpace`、`lookAtYaw`、`getEffectCount`、`effect.getMaterialCount` / `setMaterialProperty` / `executeMaterialFunction` / `name`，语料里没有场景用到。

**只差 P6d 的 4 张**（能渲染 156 → 160）：`3304642534`、`3549863808`、`3570308528`、`3812487163`，都是 `createLayer('models/bar.json')` + `sortLayer`。

**再差 1–2 项的**：
- dino_run：还差 P6e（帧表）与 `text:anchor:topright`；
- `2887099508`：差 `getAnimationLayer`（P12）；
- `3509243656`：差 `camera:perspective:text`；
- `3570755196`：差 `openUserShortcut`、`usertextures:usershortcut`（P11）；
- `3799462430`、`3812473896`：差 `usertextures:particle-sheet`；
- `3832133196`：差 `object:attachment`、`puppet:alpha`。

**`createLayer` 的参数形态**（`ignore/p6/d0/usage.txt`）：

| 形态 | 场景 |
|---|---|
| 字面量模型路径（`'models/bar.json'`，实际文件在 `models/workshop/<__workshopId>/bar.json`） | `3304642534`、`3549863808`、`3570308528`、`3799462430`、`3812473896`、`3812487163`、`3818053626` |
| `registerAsset` 句柄（模型 `models/coin_0.json`、粒子 `particles/coinget.json`，两个都不在 `scene.json` 里），运行中反复建删 | dino_run |
| `getInitialLayerConfig(现有图层)`，克隆后改 `origin` / `alpha` | `3560756264`、`3643916956`、`3662390671` |
| 对象字面量：文本层（`text`、`color`、`pointsize`、`font: thisLayer.font`）或图像层（`image` 来自 `getInitialLayerConfig(thisLayer)`、`size`、`perspective`） | `3348595482`、`3509243656`、`3808922316` |

**P6d 不做：**
- `getTextureAnimation`：P6e。
- `getAttachment*`、动画层与骨骼：P12。
- `createModelData` / `destroyModelData`、`getCameraTransforms` / `setCameraTransforms`：语料 0 处，照报。

## 现状锚点

**a. 建层、排序与层级 API 都在缺口表里**（`compile/scriptApi.ts:63`、`:122`）
```ts
  thisScene: [
    // 建层删层与排序、模型数据 → P6；相机变换本机语料 0 处（L15）
    ...methods("root", ["getLayerByID", "createLayer", "destroyLayer", "sortLayer", "getInitialLayerConfig", /* … */]),
  engine: methods("root", ["registerAsset", "openUserShortcut", "requestFeatures"]),
  layer: [
    ...methods("any", ["getTransformMatrix", "rotateObjectSpace", "lookAtYaw"], UNIQUE),
    ...methods("any", ["setParent", "getParent", "getChildren"], /* … */),
    // effect 访问（3c 待定 3）
    ...methods("any", ["getEffect", "getEffectCount", "transformAttachmentToTexture"], UNIQUE),
```

**b. `getLayerIndex` 返回 `objects` 下标**（`script/api.ts:947`）
```ts
    this.method(
      this.thisScene,
      "getLayerIndex",
      (value: unknown) =>
        this.access.bundle().layers.find((layer) => this.layer(layer.object) === value || layer.name === value)
          ?.object ?? -1, // 现状：是 scene.json 的下标，不是渲染顺序的下标；被跳过的对象（灯、相机等）也占号
      true,
    );
```

**c. 图层以 `objects` 下标为稳定键**（`compile/bundle.ts:441`）
```ts
export interface SceneLayer {
  id: number;
  /** scene.json 的 `objects` 下标（稳定键；`layers` 下标会随被跳过的对象移位）。 */
  object: number;
  parent: number | null; // 现状：父也是 objects 下标
```

**d. 渲染顺序在建场景时定死**（`render/scene.ts:1193`、`:5004`）
```ts
  /** 按图层分组的步骤：不可见图层整段跳过（含它的快照），泛光的 op 单独放在最后（P3a）。 */
  private readonly layers: LayerRuntime[] = []; // 现状：`build` 按 bundle.layers 的顺序建好，之后不增不减不换序
    } else for (const layer of this.layers) if (layer.layer.group == null) runLayer(layer);
```

**e. 脚本里的资源路径没有 `__workshopId` 改写**：`compile/scriptApi.ts` 只在注释里提到 `__workshopId` 是导出变量、不是回调；运行时不读它。

## 步骤 0 — 调研

### 0a — 语料（Claude，已做）

见上「范围与解锁」与「总体设计思路」的硬约束。

### 0b — 读码（两个代理并行）

- `rea-p6d-script.md`（`scenescript64.dll` 侧与两边的接口）：工作文件 `ignore/p6/rea/layers/script/`。只用 `llvm-objdump` 与脚本，不占 REA 会话。
- `rea-p6d-layers.md`（exe 侧）：工作文件 `ignore/p6/rea/layers/exe/`。用 REA（拷一份最新的 exe 快照来开），REA 不可用时用 `ignore/p4/rea/wp.asm` 切片。

目标 `wallpaper64.exe` 2.8.42（SHA-256 前缀 `40e2ce021e935232`）、`bin/scenescript64.dll`（`58039ef912fcd51c`）。要回答：
1. **`createLayer` 的参数：** 字符串、资产句柄、配置对象各怎么认；配置对象是按 `scene.json` 的对象格式解析吗，缺键怎么补（`models/util/solidlayer*.json` 是缺省模型）；文件找不到时怎样；`__workshopId` 怎么改写路径（什么时候改、改哪些资源、改了找不到是否回退原路径）。
2. **新图层：** id 与 `name` 怎么定；插在渲染顺序与 `enumerateLayers` 的哪里；父是谁；资源（纹理、着色器、粒子）是当场同步加载吗；**当帧画不画**；配置里带脚本字段（克隆的 `getInitialLayerConfig` 会带）时脚本跑不跑、`init` 什么时候跑；绑了用户属性的字段怎样；能建哪些类型（图像、文本、粒子、声音、组？）。
3. **`destroyLayer`：** 立即还是帧尾删；返回值；子对象怎样；删掉后脚本手里的对象（读写字段、`isObjectValid`）怎样；能不能删 `scene.json` 里的图层；删掉的图层上的脚本还调不调。
4. **`sortLayer(layer, index)`：** 下标是哪张表的（全部对象、顶层、同级），和 `getLayerIndex` 的返回值是不是同一套；越界怎样；`getLayerIndex` 现在的返回值（我们返回 `objects` 下标）对不对。
5. **`getInitialLayerConfig(layer)`：** 返回什么（加载时的 JSON 原文？带 `id`、`script`、`{user}` 吗？深拷贝吗）；对新建的图层返回什么；参数是名字还是对象。
6. **`registerAsset(path)`：** 只能在模块顶层调（p3-script-REPORT C）；返回的句柄长什么样；预加载了什么（模型、粒子、字体）；句柄赋给文本层 `font` 时怎样；同一路径登记两次。
7. **`getLayerByID(id)`**、**层级**：`getParent`（根返回什么）、`getChildren`（顺序、是不是新数组）、`setParent`（世界变换保不保持）、`getTransformMatrix`（本地还是世界，含不含 `alignment` 与父链，返回 `Mat4` 的布局）。
8. **effect 访问：** `getEffect(名字或下标)`、`getEffectCount`；`IEffect` 的 `name`、`visible`、`getMaterial(下标)` / `getMaterialCount`（材质对象和我们现在挂在 pass 上的材质常量对象是不是同一个东西）、`setMaterialProperty`、`executeMaterialFunction`（只记下来，语料 0 处）。
9. **时机：** 这些调用在 `init`、`update`、属性回调、光标回调里都能用吗；一帧里建、排、删之后，渲染与命中测试（P6c）在什么时候看到。

产出照以前的读码文档：概括、元数据（目标哈希、方法、工作文件）、逐题结论带地址与置信度（【确】/【推】）、未查清的列表、建议的实测。

### 0c — 确定性工程与实测（Claude）

按 0b 的结论定题，工程用 `kbp gen`，脚本用 `console.error` 把返回值、字段、`enumerateLayers` 的名字序列写进 WPE 的 `log.txt`；绘制顺序与当帧画不画用 wpe-renderdoc 抓帧看。预计要测：
- 字面量路径、`__workshopId` 改写、句柄、克隆、对象字面量四种 `createLayer`，新图层当帧在不在画面里；
- `sortLayer` / `getLayerIndex` 的下标，`enumerateLayers` 在建、排、删前后的序列；
- `destroyLayer` 之后读写旧对象、`isObjectValid`；
- `getInitialLayerConfig` 的 JSON 形状；`getTransformMatrix` 带父链与 `alignment` 的值；`getEffect` / `getMaterial` 的读写。

### 0b 实施记录（2026-11-15）

- exe 侧 `rea-p6d-layers.md`：REA 用上了（带 p12 快照打开被拒，改为不带快照打开，分析另存 `ignore/p6/rea/layers/exe/wallpaper64-2.8.42-p6d.rea-snapshot`）。结论见该文概括，0c 逐条实测核对（下节）。
- dll 侧 `rea-p6d-script.md`：进行中。

### 0c 实测记录（2026-11-15，wpe-renderdoc，工程 `ignore/p6/d0/make_tests.py` → `ignore/p6/d0/proj/`，抓帧 `A:\p6d\`）

四个工程：`p6d-order`（下标、排序、id、初始配置）、`p6d-frame`（建删的一次性事件）、`p6d-cycle`（每 4 帧建删一次，核对当帧）、`p6d-tree`（层级、矩阵、effect）。日志前缀 `[kbp6d]`。和 exe 读码逐条对得上，另有三处读码没覆盖到的事实（标 ★）。

**下标与排序（p6d-order）**
- `getLayerIndex` / `enumerateLayers` / `getLayerCount` 看全部对象：灯、分组节点、子对象都占下标，加载完时下标 = `objects` 下标（A 0、灯 1、B 2、B 的子 K 3 …）。`getLayerIndex('C')` 收名字。
- `sortLayer(x, i)`：先摘掉 x 再插到 i，`i` 是最终下标；−1、999 都到末尾；0 到最前；2.7 取 2；字符串 `'3'` 不动、返回 false；`sortLayer('X', 1)` 收名字；成功返回 true。绘制顺序 = 这张表的顺序（抓帧：X 排在 C 后面时画在 C 上面）。
- `createLayer` 的新层追加在表尾；`createLayer('models/util/solidlayer.json')` 的初始配置是 `{"image": "models/util/solidlayer.json"}`（dll 把字符串包成 `image`），名字是空串。
- ★ **图层对象没有 `id` 字段**（`thisLayer.id` 是 `undefined`；p6d-tree 列出的自有键里也没有 `id`）。我们现在有，要删。
- ★ **`getLayerByID` 只收字符串**：`getLayerByID('10')` 找到，`getLayerByID(10)` 与 0–80 的数字全是 null。
- `getInitialLayerConfig`：去掉顶层 `id` 的 JSON，键按字母排序，`script`、`{user}`、`effects`（effect 与 pass 的 `id` 保留）、`parent`（id）都在；每次调用新对象；收名字；对新建的层返回建它时的配置（对象字面量原样、字符串包成 `image`）；灯也有。

**建删的当帧行为（p6d-cycle、p6d-frame）**
- **当帧画、当帧删**：p6d-cycle 连抓 8 帧，黄层 Y 在不在与标记 M 的位置 8 帧全部一致（两帧一翻）。在 `update` 里建的层当帧就画，删的层当帧就不画。
- `destroyLayer`：返回 true；计数、枚举、`getLayer(名字)` 立即不含它；同帧 `getLayerIndex` 仍是原下标、`isObjectValid` 仍为真、字段照常读、再删一次仍返回 true、`getInitialLayerConfig` 照常；同帧排在后面的脚本（B）照收 `update`，帧末收 `destroy`。下一帧：`isObjectValid` 假、字段读出 `undefined`、写入无效、下标 −1。收名字字符串；`null` 返回 false；灯、分组节点、`thisLayer` 自己都能删（删自己后本帧剩下的照跑，帧末收 `destroy`，之后不再 `update`）。
- 删父对象：子对象保留本地 `origin`，`getParent()` 变 null，不保持世界变换。
- 克隆 `createLayer(getInitialLayerConfig(T))`：新层的 `init` 在 `createLayer` 返回之前跑（`before` → `T init` → `after`），名字同原层，`init` 里 `getLayerIndex(thisLayer)` 已是表尾；同一帧新层收到第一次 `update`（排在原有脚本之后）。

**层级、矩阵、effect（p6d-tree）**
- `getTransformMatrix()` 返回 `Mat4`（自有键只有 `m`），是**世界矩阵**：父链累乘、含自己的 `alignment` 偏移、子层不继承父层的 `alignment` 偏移（同 P8）；平移在 `m[12..14]`。（JSON 的 `angles` 是弧度，`0 0 30` 是 30 弧度。）
- `getParent()` 返回同一个对象，根返回 null；`getChildren()` 每次新数组，`setParent` 之后新子层排在末尾。
- `setParent(p)` 不保持世界变换（本地 `origin` 不变）；`setParent(p, true)` 保持世界变换（本地 `origin` 改写成相对新父，不计 `alignment`）；`setParent(null)` / `setParent(undefined, true)` 同理。
- `getEffect(名字)` 区分大小写、同名取最后一个；`getEffect(下标)` 越界、负数、空串、不存在的名字都是 null；同一个 effect 每次返回同一对象。effect 的自有键：`name`、`visible`、`getMaterial`、`executeMaterialFunction`、`getMaterialCount`、`setMaterialProperty`、`getAnimation`。
- `getMaterialCount()` = pass 数（tint 1、blur 4）；`getMaterial(i)` 越界 null，收材质文件名；同一 pass 每次同一对象。★ 材质对象除了常量（`color` 读出 `Vec3`、`alpha`），还有 pass 状态字符串 `depthwrite` / `depthtest` / `cullmode` / `alphawriting` / `blending`。
- `setMaterialProperty('color', new Vec3(0, 1, 0))` 读回与画面都没变（维数对也没变），具体规则没查清；语料 0 处用，照报。**（已被「P6d1 前的补充实测」推翻：标量写 float 常量生效，只有向量没生效。）**

**资源路径、参数形态、对象身份（p6d-asset，`ignore/p6/d0/make_asset.py`）**
- `registerAsset(路径)` 返回的就是这个路径字符串；同一脚本第二次登记同一路径返回 null；模块顶层的函数里能调，`init` 里抛 `SyntaxError: registerAsset can only be called from global scope.`。`createLayer(返回值)` 就是按路径建。
- **`__workshopId` 改写**（脚本导出字符串 `'123'`）：
  - `createLayer('models/bar.json')`、配置里的 `image: 'models/bar.json'` → `models/workshop/123/bar.json`；
  - ★ 工程根目录里**有** `models/both.json` 也照样改写成 `models/workshop/123/both.json`（读码说「原路径存在就不改」，实测工程目录里的文件不算存在）；
  - `models/util/solidlayer.json`（在 WPE `assets` 里）不改；
  - 两处都没有的 `models/nothere.json` 也改写（改写后不再检查）；
  - 已带 `workshop/999/` 的换成当前 id；
  - 数字形式的 `__workshopId = 123`、不导出 `__workshopId`：不改写，图层照样建出来（模型读不到，`image` 留原路径）。
  - 结论：只有在 WPE `assets` 里存在的路径保持原样，其余一律改写。`scene.pkg` 里的文件算不算存在没测（语料里要改写的路径在 pkg 里都只有 workshop 那份，结论一样）。
- 参数形态：`createLayer()`、`createLayer(1, 2)` 建纯色层，配置是 `{"image": "models/util/solidlayer_depthtest.json"}`；`{color}` 补同一个模型；`{origin, name}`（没有类型键）建出一个分组节点；JSON 文本字符串照配置建；数字、`undefined`、`Vec3`、`'fonts/…'` 返回 null；数组 `[1]` 建出一个空名对象。
- ★ 不存在的粒子文件 `createLayer('particles/nothere.json')` 让 WPE 的测试窗口直接崩掉（日志停在调用前）。
- `getLayer()`、`getLayerByID()` 无参返回 `undefined`；`getLayer(1)` 按原始下标取；`getLayerByID('3')` 按字符串找到 A；`getLayer('A') === thisLayer`、`enumerateLayers()[0] === thisLayer`（同一个包装）；`sortLayer(层)` 缺下标返回 false。
- ★ `getEffect(0).getMaterial(0)` **就是**挂在这个材质常量上的脚本的 `thisObject`；`getEffect(0)` 就是挂在 effect `visible` 上的脚本的 `thisObject`；`getMaterial()` 无参等于 `getMaterial(0)`。
- effect 的 `name` 可写，写后按新名字找得到、旧名字找不到。
- `setMaterialProperty('g_TintColor', …)`（按 uniform 名）同样不生效；直接写材质对象的字段 `getMaterial(0).color = new Vec3(0, 0, 1)` 生效。

## 后续步骤（步骤 0 之后补写）

每步单独验收、单独提交（2026-11-15 按「已定」1、2 改定）：
1. **P6d1 层级、变换与 effect / 材质访问**：[phase-6d1-hierarchy-effects.md](phase-6d1-hierarchy-effects.md)。分 P6d1a（查询、转向、effect / 材质读与常量写、`getLayerByID`、删 `id`）与 P6d1b（材质状态字段运行中改管线）。
2. **P6d2 脚本改成同步工厂加载**（「已定」2）：[phase-6d2-script-factory.md](phase-6d2-script-factory.md)。改写用 acorn（2026-11-15 用户「方案1可以」）。
3. **P6d3 动态图像层与结构**：[phase-6d3-runtime-layers.md](phase-6d3-runtime-layers.md)。运行时渲染顺序表、`sortLayer`、`destroyLayer`、`setParent`（含挂点与组深度检查、组归属变化）、`__workshopId`、模板实例化、克隆（含脚本）、逐实例属性绑定。解锁 4 张音频条。
4. **P6d4 文本层与粒子模板、运行中新模型的兜底**（兜底的形态待用户定 B：异步编完再画、作为已知差异）。
5. 走查（按 FINAL_CHECK）与文档随各步做。

## 已定

1. **P6d 不照报**（2026-11-15 用户：「不报。报了就有不支持的欠债」）：`createLayer` 的全部形态都要支持，包括克隆带脚本的图层、文本层配置、类型键不是字面量的配置；不新增 `script:createLayer:*` 一类的退回键。推翻了步骤 0 之后的推荐（克隆带脚本、文本配置、动态配置先照报）。图层对象删掉 `id`、粒子模板放在 P6d 里（按推荐）。
   - `setMaterialProperty`：实测确认在 WPE 上没有效果，就按中性实现（方法存在、什么都不改）；`executeMaterialFunction` 照报（2026-11-15 用户）。0c 那次 `color` 常量挂着脚本，结论有干扰，P6d1 前重测。
3. **运行中第一次出现的模型晚几帧出现，作为已知差异**（2026-11-15 用户「那个动态模型晚几帧可以接受」，B）：`createLayer` 当场返回对象（字段、下标、排序、删除、脚本都正常），加载时没备好模板的配置异步编译，编完再画；`init` 里建的在首帧之前等完，和 WPE 没有区别；`update` 里建的晚几帧出现，记日志、写进文档。
2. **全部场景脚本改成同步工厂加载**（2026-11-15 用户「接受A」）：模块源码在加载时改写成工厂函数、在 realm 里用 `Function` 编一次，每调一次得到一份新的模块状态；`import` 的库加载时异步备好、作参数传入。一条加载路径，不按「是否会被克隆」分两种。改写覆盖 `es-module-lexer` 能认出的全部写法，不只语料用到的三种；验收要求全语料脚本诊断逐张不变。

### 步骤 0 之后的补充核对（2026-11-15，`ignore/p6/d0/scriptsrc.py`、`scriptstats.py`、`exportforms.py`）

- **克隆带脚本的只有 1 张**：`3560756264` 克隆的 `playerbarsexception` 上挂两段 15 行的材质常量脚本（`update` 返回 `shared.accentColor` / `shared.secondaryColor`，没有 `init`、没有模块级状态）。`3643916956`、`3662390671` 里没有叫 `playerbarsexception` 的对象，`getLayer` 返回 null，脚本直接 `return`，一根都不克隆。
- **语料的模块语法只有三种**（5118 段）：`export function` 5009 段、`export let/var/const` 3760 段、`import * as X from 'Y'` 384 段（`WEMath` 363、`WEColor` 19、`WEVector` 2）。`export default`、`export { … }`、`export *`、具名 / 默认 `import`、`import()`、`import.meta`、顶层 `await` 都是 0。600 段没写 `'use strict'`（模块本来就是严格模式）。
- **脚本的样子**：138 张场景带脚本，行数中位 39、P90 160、最长 6793；挂在 `scale` 1033、`text` 924、`origin` 916、`visible` 654、材质常量 631、`alpha` 365 段等；导出 `update` 4532、`init` 1609；2912 段（57%）有模块级 `let` / `var` 状态（不算 `scriptProperties`）。
- **`createLayer` 的调用时机**：4 张音频条、`3560756264`、`3348595482`、`3808922316` 在 `init` 里建；dino_run（`registerAsset` 字面量）、`3818053626`（字面量 `models/cav_default_texture.json`）、`3509243656`（对象字面量，`image: "models/ta.json"` 是字面量，`origin` / `color` / `scale` 是运行时的 `Vec3`，对象池复用、不删）在运行中建。`3808922316` 的 `image` 是 `getImageName(getInitialLayerConfig(thisLayer))`，即自己那一层已经编译过的模型；文本分支的 `font` 是 `thisLayer.font`。
- **我们的加载顺序**（`host.ts` 约 1418–1445 行）：编译完、建 GPU 资源（`current.load`）之前跑脚本 `init`，状态是 `SceneState.fromBundle(bundle)`。`init` 里建的层可以在建 GPU 资源之前编完，首帧之前就齐。

### P6d1 前的补充实测（2026-11-15，`ignore/p6/d0/make_p6d1.py` → `proj/p6d1-mat`、`proj/p6d1-xform`，抓帧 `A:\p6d\p6d1-mat`、`A:\p6d\p6d1-xform`）

**`setMaterialProperty` 不是不生效**（常量不挂脚本、不绑属性，f==3 写一次，读回与抓帧中心像素一致）：

| 层 | 写法 | 读回 | 像素 |
|---|---|---|---|
| E1 | `('color', new Vec3(0, 1, 0))` | 不变 `1 0 0` | 红 |
| E2 | `('alpha', 0.25)` | 0.25 | 粉 (1, 0.749, 0.749)，生效 |
| E3 | `('alpha', 0)`（整数） | 0 | 白，生效 |
| E4 | 对照：`getMaterial(0).color = new Vec3(0, 0, 1)` | `0 0 1` | 蓝 |
| E5 | `('g_TintColor', new Vec3(0, 1, 0))` | 不变 | 红 |
| E6 | `('Color', new Vec3(0, 1, 0))` | 不变 | 红（和 E1 一样被 Vec3 干扰，大小写没测出来） |
| E7 | `('color', new Vec4(0, 1, 0, 1))` | 不变 | 红 |
| E8 | `('color', 0.5)` | 不变 | 红 |

- 标量写进 float 常量生效、当场读回就变；`Vec3` 写进 vec3 常量不生效。返回 `undefined`。
- 0c 那次的「不生效」是因为只测了 `Vec3`。向量为什么不生效、按 uniform 名 / 大小写变体用标量写会不会生效、int 常量与带角度标志的常量，等读码（`rea-p6d1-xform.md`）后补测。
- 结论：**不按中性处理，照 WPE 实现**（用户的条件「确认没生效」不成立）。

**变换方法**（全部在 `init` 里，`d()` 打全精度；`getTransformMatrix().m` 列主序）：
- `rotateObjectSpace(v)` 的分量是**弧度**（`angles` 字段在脚本里是度）：`(0, 0, 30)` → 矩阵 `cos 30 = 0.15425145`、`sin 30 = −0.98803163`，读回 `angles.z = −81.12662`（30 rad 折回 ±180°）；连调两次 `(0, 0, 30)` = 60 rad；`(90, 0, 0)` 绕 X、`(0, 90, 0)` 绕 Y。返回 `undefined`。
- `(10, 20, 30)` 读回 `angles (−147.0422, 65.91559, −81.12662)`、矩阵 `[0.06294725, −0.403198, −0.91294527, 0, −0.90563995, 0.3612893, −0.22200526, 0, 0.4193494, 0.84077436, −0.34241003, 0, …]`，轴顺序待读码核对。
- **3×3 与角度是两份状态**：R5 先 `rotateObjectSpace(10, 20, 30)` 再 `l.angles = l.angles`，矩阵各元素差 1e-8 量级（`0.06294725 → 0.062947236` 等）。转完画面用直接乘出来的 3×3，写 `angles` 才按角度重建。
- `lookAt(p)`：本地 **+Z** 指向 `p − origin`，up 取世界 Y（`(700, 600) → (1500, 1000)`：第 2 列 `(0.894, 0.447, 0)`，第 1 列 `(−0.447, 0.894, 0)`，第 0 列 `(4e−8, 4e−15, −1)`，读回 `angles (153.43495, 90, 180)`）；带 z 的目标（R9）第 0 列 y 分量为 0。目标与自身重合时不变。**目标按父空间解释**（与 `origin` 同一空间）：C 在转 45°、缩放 2 的 P 下，`lookAt(1500, 150, 0)` 的方向是本地 `(1400, 150, 0)`。
- `lookAtYaw(p)`：只绕 Y：R7 读回 `angles (0, 90, 0)`、矩阵第 2 列 `(1, 0, −4e−8)`。
- 全精度读回存在 `ignore/p6/d0/out/p6d1-xform.log`（本节只摘了几条），做单测时逐位对照。

**第二轮（读码 [rea-p6d1-xform.md](rea-p6d1-xform.md) 之后，`make_p6d1b.py` → `p6d1-mat2/3/4`、`p6d1-xform2`、`p6d1-cam`，全精度读回 `ignore/p6/d0/out/p6d1-round2.log`）：读码的预测逐项对上。**
- `setMaterialProperty(名, 值)`：
  - 名字按材质键（着色器注解的 `material`）全等、区分大小写查，`g_` uniform 名、`Alpha` 查不到；五个状态字段（`blending` 等）不收。对这个 effect 的**每个 pass**里同名的常量都写（blur 的 pass 1、2）。
  - 值：数 → float 常量（2.7 不钳）、int 常量；带 `rad2deg` 的常量收**度**（transform `angle` 设 45 读回 45，`chromaticaberration` 方向同）。**任何对象**（`Vec2/3/4`、`{x, y}`、数组）只取 x、y、只写 vec2 常量（数组的 x、y 是 undefined → 0 0）；vec3 / vec4 常量永远写不进。字符串、布尔、`null`、不传值都把 float 常量写成 **0**；数写 vec2 常量跳过。返回 `undefined`。
  - 当场读回就变，画面当帧生效（第一轮 E2、E3 的像素）。
- 材质对象**只登记编译后着色器实际用到的常量**：chromaticaberration 缺省 `MODE 0` 不用 `u_Direction`，材质对象里就没有 `ui_editor_properties_direction` 这个键，`MODE 1` 才有。键的顺序既不是声明顺序也不是字典序（`color, alpha`；`scale, offset, angle`），疑似哈希表顺序。
- `rotateObjectSpace(v)`：`M ← M · Rz(v.z) · Ry(v.y) · Rx(v.x)`（弧度，绕自身轴，glm `rotate` 逐运算 f32），直接写 3×3，再按 ZYX 反算角度（归一化：JSON `400°` 转零向量后读回 `40.000004`）；参数不是对象时只做归一化。读回 `R1`、`R2` 的矩阵是**乘出来的**那组（`m[2] = −0.19866932928562164`，按角度重建会是 `…31438446045`）。子对象当场跟随（`R5`）。
- `lookAt(target, up = (0, 1, 0))`：目标与 `origin` 同在父空间；非相机对象本地 +Z、相机对象本地 −Z 对着目标（`L6`）；经 `lookAtRH` 取角度再走角度 setter（重建 3×3），不改 `origin`；`|d|² ≤ 1.1920929e−07` 什么都不做；视线与 up 平行时 NaN（`L3b`、`KN`）；up 不归一化（`Y3`）；不传目标或目标不是对象 = 看 (0, 0, 0)（`L7`、`L9`）。
- `lookAtYaw(target, up)`：先 `d′ = d − up·(up·d)`，其余同 `lookAt`；看正上方不动（`Y2`，不是 NaN）。

## 实施记录
