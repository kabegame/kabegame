# P6d1 — 层级、变换与 effect / 材质访问（子计划）

> 上级：[phase-6d-dynamic-layers.md](phase-6d-dynamic-layers.md)（P6d 总子计划，「已定」1、2 与「P6d1 前的补充实测」）。
> 依据：读码 [rea-p6d-layers.md](rea-p6d-layers.md)（9、10 节）、[rea-p6d-script.md](rea-p6d-script.md)、[rea-p6d1-xform.md](rea-p6d1-xform.md)；WPE 实测 `ignore/p6/d0/out/p6d1-xform.log`、`p6d1-round2.log`（工程 `ignore/p6/d0/make_p6d1.py`、`make_p6d1b.py`）。
> 现状锚点取自 HEAD `2fc14669` 的工作区。`script/api.ts`、`render/state.ts`、`compile/bundle.ts`、`render/scene.ts` 工作区里有别的会话没提交的改动，动工前再核对一次共享文件。

## 总体设计思路

P6d1 把 WPE 已经有、我们也已经有数据的东西，按 WPE 的形状交给脚本：层级（父、子、世界矩阵）、三个转向方法（`rotateObjectSpace` / `lookAt` / `lookAtYaw`）、effect 与材质对象（`getEffect` / `getEffectCount` / `name` / `getMaterial` / `getMaterialCount` / `setMaterialProperty`），外加 `getLayerByID` 和删掉图层对象上多出来的 `id`。改结构的 `setParent`、`sortLayer`、建删层归 P6d3；`executeMaterialFunction` 照报（P6d「已定」1）。

**旋转的真值。** WPE 每个对象存两份旋转：角度（`O+0x140`）和 3×3（`O+0x14c`）。画面、子孙、`getTransformMatrix` 只读 3×3。角度写入（JSON、脚本、属性、关键帧、`lookAt`）先存角度、再按 `Rz·Ry·Rx` 重建 3×3，所以两份平时一致；只有 `rotateObjectSpace` 直接乘 3×3、再把角度反算回去，两份在末位上分开（`R1` 实测矩阵是乘出来的那组）。我们照搬这个结构：`LayerState` 加一个可选的 `rotation`（9 个 f32，列主序），为 `null` 时 `layerLocalMatrix` 照今天按角度现算，逐字节不变；`rotateObjectSpace` 写它和反算的角度；任何角度写入都把它清成 `null`。世界矩阵、绘制、命中、子孙全部经 `layerLocalMatrix`，不用逐处改。`lookAt` / `lookAtYaw` 对状态来说只是一次角度写入（算出角度、走角度 setter）。脚本写入要能跨重编译重放，所以 `rotateObjectSpace` 记成一种新的写入目标 `rotation`，带 3×3 与角度，重放时原样恢复。

**`getTransformMatrix` 现算。** WPE 的世界矩阵缓存在任何变换写入时清戳，读到的总是当前值（`R5`：父 `rotateObjectSpace` 之后立刻读子的矩阵已经变了）。所以它不读渲染器上一帧的缓存，按当前 `SceneState` 沿父链现算世界矩阵、再乘图层自身偏移（`drawMatrixOf`，同 WPE 虚函数 `+0x80`）。挂在骨骼上的子树按 P12b1 的影子缓存规则取（`render/worldStamps.ts`），和绘制看到的一致。

**effect 都要有脚本对象。** WPE 加载时把每个 effect 都放进列表，`getEffectCount` 数全部、`getEffect` 能拿到写死关闭的 effect，脚本可以把它打开。我们今天跳过写死关闭、没绑定的 effect（`bundle.ts` 的 B11），它们连壳都不在 bundle 里。改法：场景脚本里出现 `getEffect` 时（编译期扫描，同 `scriptApi.ts` 的词法），所有 effect 都按「`visible` 可变」编进 bundle（同挂脚本的 effect，P3c 的就地开关与预建变体）；没出现时维持现状。effect 的 `name` 存在脚本 API 这边（WPE 没有改值回调，只影响 `getEffect(名字)`），API 对象跨重编译保留，名字也就保留。

**材质对象照 WPE 的那一份。** `getMaterial(i)` 返回的就是挂在材质常量上的脚本的 `thisObject`（0c 实测），我们的 `material(pass)` 本来就按 pass 键缓存，直接复用。差两处：键只登记编译后着色器实际读到的常量（chromaticaberration 缺省 `MODE 0` 没有方向键，实测），而我们今天把没读到的也登记了；键的顺序是 WPE 实例表（MSVC `unordered_map`，FNV-1a）的迭代顺序，不是声明顺序。另有五个状态字段（`blending` / `alphawriting` / `depthtest` / `depthwrite` / `cullmode`）是字符串，可读可写，写了当场改管线（`p6d1-mat5`：写 `cullmode` 后上屏那次绘制剔除变成 Back）。读写状态字段要在运行中换管线，渲染侧改动大，单独成 P6d1b；P6d1a 先让它们可读。`setMaterialProperty` 走和字段写入同一个 setter，只是 dll 把值转成三类：数、Vec2（任何对象只取 x、y）、缺省整数 0，规则照实测抄。

## 分步

- **P6d1a**：点 1–7。层级、变换、effect / 材质的读与常量写、`getLayerByID`、删 `id`、能力表。状态字段只读。
- **P6d1b**：点 8。材质状态字段运行中改管线。动工前补一个实测：中间 pass（blur pass 0）的 `blending` 写入在画面上的效果，确认不只是剔除生效。

各自单独验收、单独提交。

## 现状锚点

**a. 图层对象带 `id`**（`script/api.ts:279`）
```ts
    this.define(api, "name", () => this.findLayer(index)?.name ?? "");
    this.define(api, "id", () => this.findLayer(index)?.id ?? -1); // 现状：WPE 的图层对象没有 id（0c 实测 undefined）
```

**b. effect 对象只有 `visible`**（`script/api.ts:1004`）
```ts
  private effect(object: number, effect: number): ApiObject {
    // …
    this.define(api, "visible", () => this.access.state().effectEnabled(object, effect),
      (value) => this.write({ kind: "effect", object, effect }, value, "bool"));
    this.installGetAnimation(api, () => `objects/${object}/effects/${effect}`);
    // 现状：没有 name / getMaterial / getMaterialCount / setMaterialProperty / executeMaterialFunction
```

**c. 材质对象登记全部材质键**（`script/api.ts:959`）
```ts
    for (const slot of materialSlots(program?.uniforms ?? []))
      if (slot.material) names.set(slot.material, constantTargetFields(slot)); // 现状：不看 slot.used；顺序是声明顺序；没有五个状态字段
```

**d. 写死关闭的 effect 不进 bundle**（`compile/bundle.ts:2486`）
```ts
      // 写死关闭、没有绑定的整步跳过（B11），也不检查它的能力
      if (!enabled && !visibleBound) continue; // 现状：getEffect 拿不到它，脚本也打不开它
```

**e. 旋转只有角度一份**（`render/state.ts:70`、`render/layout.ts:185`）
```ts
export interface LayerState {
  /** angles 为弧度（同 scene.json）。… */
  angles: number[]; // 现状：没有 3×3；世界矩阵按角度现算
```
```ts
export function layerLocalMatrix(layer: Pick<LayerTransform, "origin" | "angles" | "scale">): Mat4 {
  // …按 Rz·Ry·Rx 逐元素 f32 现算 R（FUN_1401dd630）
```

**f. `ScenePass` 没有材质文件路径**（`compile/bundle.ts:360`）：`getMaterial('材质文件名')` 要按 pass 的材质路径（不分大小写）找，现在 pass 上只有 `key` / `program` / 状态字段。

**g. 缺口表**（`compile/scriptApi.ts:72`、`:121`–`:129`、`:166`、`:179`–`:184`）：`getLayerByID`、`getTransformMatrix` / `rotateObjectSpace` / `lookAtYaw` / `lookAt`、`getParent` / `getChildren`、`getEffect` / `getEffectCount`、`effect` 的四个方法与 `name` 都还在表里。

## 点 1 — 旋转的 3×3（`render/state.ts`、`render/layout.ts`、`script/runtime.ts`）

- **新增** `LayerState.rotation?: number[] | null`：9 个 f32，列主序，`R[3c + r]`。`null` / 缺省 = 按角度现算。
- **修改** `layerLocalMatrix`：`rotation` 有值时用它代替按角度算的 `R`，其余（`L[c][r] = f(scale[c] · R[c][r])`、平移）不变。
```ts
export function layerLocalMatrix(layer: Pick<LayerTransform, "origin" | "angles" | "scale" | "rotation">): Mat4 {
  // …
  const R = layer.rotation ?? anglesRotation(layer.angles); // 修改：rotateObjectSpace 写过就用乘出来的 3×3（rea-p6d1-xform 2.5）
```
  > 说明：把现在按角度算 `R` 的那段抽成 `anglesRotation`（逐运算不变），`rotateObjectSpace` 也要用它取起点。
- **修改** `SceneState.write` 的图层分支：`angles` 写入（属性、关键帧、脚本同一条路）一律清 `rotation`。
- **新增** 写入目标 `{ kind: "rotation", object, rotation: number[], angles: number[] }`：只由 `rotateObjectSpace` 产生；`write` 把两者原样存进状态、记 `transformWrites`、子树标脏（同 `angles`）。脚本写入表（`runtime.ts` 的 `writes`）按对象记，重编译后 `replayWrites` 原样恢复；之后的 `angles` 写入覆盖它（同一个 `targetKey`：`objects/<i>/angles`，后写的胜出）。
- **新增** `render/rotation.ts`（纯函数，单测逐位对照实测）：
  - `rotateObjectSpace(R, v)`：`R ← R · Rz(v.z) · Ry(v.y) · Rx(v.x)`，每步照 glm `rotate(M, a, e_i)` 逐运算 f32（轴向对角元是 `(1−c)+c`，rea-p6d1-xform 1.3），`cosf` / `sinf` 用 `Math.cos` / `Math.sin` 再舍入（同 `layerLocalMatrix`）。
  - `extractEulerZYX(R)`：`z = atan2f(M01, M00)`、`y = atan2f(−M02, sqrtf(M22² + M12²))`、`x = atan2f(sz·M20 − cz·M21, cz·M11 − sz·M10)`（1.4），返回弧度。
  - `lookAtAngles(eye, target, up, camera)` / `lookAtYawAngles(…)`：`|d|² ≤ 1.1920929e−07` 返回 `null`（不动）；非相机先把目标镜像到 `eye − d`；`lookAtRH` → 从 Vᵀ 按 ZYX 取角度（3.2–3.4）；`lookAtYaw` 先 `d′ = d − up·(up·d)`，up 不归一化。视线与 up 平行时照算出 NaN（不防护，同 WPE）。
  > 说明：`sim.py`（`ignore/p6/rea/layers/xform/`）是读码时的 f32 复刻，实测 `R1`、`R2`、`L2`、`Y1`、`Y3`、`L6` 全部对上；单测把 `p6d1-xform.log`、`p6d1-round2.log` 的全精度读回当真值。

## 点 2 — 层级与变换方法（`script/api.ts`）

- **删除** 图层对象的 `id`（锚点 a）。
- **新增** 图层方法（所有对象类型都有，WPE 是基类方法）：
  - `getParent()`：父的 API 对象，根返回 `null`。
  - `getChildren()`：每次新数组，按状态里的子表顺序（加载时 = `objects` 顺序，`fromBundle` 的 `children`）。
  - `getTransformMatrix()`：新的 `Mat4`（realm 的 `_Mat4` 原型，自有键 `m`，16 个 f32 读成 double），值 = `drawMatrixOf(当前状态)`，按当前状态现算、不读渲染器缓存；挂点子树走 `worldStamps` 的同一份缓存规则。
  - `rotateObjectSpace(v)`：`v` 是对象时取 `x / y / z`（缺的当 0，dll 只转 f32），否则只做归一化（等于转零向量）；起点 `R` 取 `rotation ?? anglesRotation(angles)`；写目标 `rotation`。返回 `undefined`。
  - `lookAt(target?, up?)` / `lookAtYaw(target?, up?)`：目标不是对象当 `(0, 0, 0)`，up 缺省 `(0, 1, 0)`；相机对象（`SceneLayer.camera` 不为空）用 −Z；算出角度后走普通的 `angles` 写入（`kind: "layer"`），`null` 时不写。返回 `undefined`。
  > 说明：`origin` 与目标同在父空间，不读父链（3.1）。读回的 `angles` 是度（现有 `radiansToScript`）。
- **新增** `thisScene.getLayerByID(id)`：只收字符串，照 dll `strtol`（十进制、跳前导空白、取到第一个非数字为止）解析，按 JSON `id`（`SceneLayer.id`）找；数字、`undefined` 返回 `null`，无参返回 `undefined`（0c）。

## 点 3 — 编译期：用到 `getEffect` 时全部 effect 进 bundle（`compile/bundle.ts`、`compile/scripts.ts`）

- **新增** `SceneScripts.usesEffectAccess: boolean`：任一会执行的脚本里有 `getEffect` 成员访问（复用 `scriptApi.ts` 的词法与「`any` 匹配」规则）。
- **修改** 锚点 d：`usesEffectAccess` 为真时，写死关闭的 effect 也按 `visibleBound` 编（能力照查，`unsupported` 照 `enabled ? unsupported : null` 的现有规则只在启用时计入；关着的坏 effect 维持「进空壳，打开时整场重编译」）。
```ts
      const visibleBound = isUserBinding(instance.visible) || isScriptValue(instance.visible) || scripts.usesEffectAccess; // 修改
```
- **新增** `ScenePass.material: string`：pass 的材质文件路径（effect pass 取 effect.json 里的 `material`，基础材质取模型的 `material`），给 `getMaterial(名字)` 用。

## 点 4 — effect 对象（`script/api.ts`）

- **新增** 图层方法：
  - `getEffectCount()`：JSON 里的 effect 个数（`object.effects.length`，含写死关闭的）。
  - `getEffect(i | 名字)`：整数取第 i 个（越界、负数 `null`）；字符串按当前名字**区分大小写**全等、同名取最后一个，空串 `null`；别的类型 `null`。按 `SceneEffect.source` 对应 JSON 下标；JSON 里有、bundle 里没有的（`usesEffectAccess` 为假时不会被访问到；为真时都在）返回 `null` 兜底。
- **修改** `effect(object, effect)` 加：
  - `name`：可读可写字符串，初值 `SceneEffect.name`，写入只改这里的表（不进状态、不重编译），`getEffect(名字)` 读它。
  - `getMaterialCount()`：这个 effect 的绘制 pass 数（条件过滤之后，同 WPE `effect+0xd0` 向量）。
  - `getMaterial(i | 名字)`：整数取第 i 个 pass 的 `material(passKey)`（越界、负数 `null`，无参 = 0）；字符串按 `ScenePass.material` 不分大小写全等、空串匹配每一个，最后一个胜出（`FUN_1401ee0c0`）。
  - `setMaterialProperty(名, 值)`：见点 5。
  - `executeMaterialFunction` 不装（照报，`scriptApi.ts` 留着）。
  > 说明：`getEffect(0)` 与挂在 effect `visible` 上的脚本的 `thisObject` 是同一个对象（0c），现有 `effect()` 按 `object/effect` 缓存，满足。

## 点 5 — 材质对象（`script/api.ts`、`compile/materialValues.ts`）

- **修改** 锚点 c：只登记 `slot.used` 的材质键。
- **修改** 键顺序：材质常量照 WPE 实例表的迭代顺序，之后五个状态字段（`depthwrite, depthtest, cullmode, alphawriting, blending`），最后 `getAnimation`（`p6d1-round2.log` 的 `S0` / `S7*keys`）。
  - **新增** `wpeMaterialKeyOrder(keys)`：复刻 MSVC `unordered_map<string, …>` 的插入与迭代（FNV-1a 散列、初始桶数与扩容规则、新节点插在所在桶的哪一端），插入顺序 = 着色器合并常量表的顺序（`vector-constant-REPORT` 2.1）。用三组实测核对：tint `color, alpha`；transform `scale, offset, angle`；chromaticaberration `MODE 1` `ui_editor_properties_center_falloff, ui_editor_properties_center, ui_editor_properties_direction, ui_editor_properties_strength`。**三组对不上就停下报告，不猜。**
- **新增** 五个状态字段的读：值取 pass 的 `blending` / `alphaWriting`（缺省 `default`）/ `depthtest` / `depthwrite` / `cullmode`，字符串照 WPE 的名字。P6d1a 写入不生效（属性 setter 什么都不做）；P6d1b 接上。
- **新增** `setMaterialProperty(名, 值)`（`FUN_1401ee1d0` + dll `0x7c` 转换，rea-p6d1-xform 4.1–4.3，实测 `S1`–`S7`）：
  - 值先按 dll 归成三类：数 → `{ kind: "number", value, integer: Number.isInteger(value) }`；任何对象（含数组、`Vec3`、`Vec4`）→ `{ kind: "vec2", x: f32(Number(o.x) || 0), y: … }`（`NaN` 当 0，数组得 0 0）；其余（字符串、布尔、`null`、不传）→ 整数 0。
  - 名字不是字符串：什么都不做。对这个 effect 的**每个 pass**：按名字全等（区分大小写）找材质键（只在登记了的键里找，状态字段不收）；类型配对：数 → float 常量（带 `rad2deg` 的按度乘 `0.017453292f` 写弧度，同字段写入）；vec2 → vec2 常量；别的组合跳过。
  - 写入走和 `getMaterial(i).<键> = 值` 同一个目标（`{ kind: "constant", pass, material, … }`），只是值已按上面换好。当帧生效，重编译重放同字段写入。返回 `undefined`。

## 点 6 — 能力表（`compile/scriptApi.ts`）

- **删除** 缺口表里：`thisScene.getLayerByID`；`layer` 的 `getTransformMatrix`、`rotateObjectSpace`、`lookAtYaw`、`getParent`、`getChildren`、`lookAt`、`getEffect`、`getEffectCount`；`effect` 的 `getMaterial`、`getMaterialCount`、`setMaterialProperty`、`name`。
- **保留** `setParent`（P6d3）、`executeMaterialFunction`（照报）、`transformAttachmentToTexture` 与挂点四个方法（P12）。

## 点 7 — 文档

- `cocs/wpe/WPE_SCENE.md`：脚本接口一节加层级、变换、effect / 材质访问；`cocs/README.md` 对应条目的主题与适用场景。
- P6d 子计划的实施记录。

## 点 8 — P6d1b：材质状态字段运行中改管线（`render/state.ts`、`render/scene.ts`、`render/graph.ts`）

**补测**（2026-11-15，`make_p6d1b.py` 的 `p6d1-mat7`、`p6d1-mat8`，抓帧 `A:\p6d\p6d1-mat7`、`A:\p6d\p6d1-mat8`，读回在 `ignore/p6/d0/out/p6d1-round2.log` 之外的本节）：
- **写入当场进管线，按加载时同一套角色规则**（blur 四个 pass，`init` 里写，读帧里每次绘制的管线）：
  - pass 0 `blending = 'additive'` → 混合 SrcAlpha / One（中间 pass 的混合当场改了）；
  - pass 1 `cullmode = 'normal'` → 剔除 Back；
  - pass 2 `alphawriting / depthtest / depthwrite = 'enabled'` → 深度开、比较 GREATER、写深度（这个 RT 没挂深度缓冲，实际不起作用），写掩码本来就是 15；
  - pass 3（最后上屏）`blending = 'additive'` 没进管线（仍 SrcAlpha / InvSrcAlpha，上屏混合借基础材质，P2a），`cullmode = 'normal'` 进了（剔除取 effect 材质，P5d）；
  - 中间 pass 的 `normal` 是不混合（One / Zero），同我们的 `blendState`。
- **取值规则**（`p6d1-mat8`，tint 的 pass 0 上依次写）：每个字段只认自己表里的名字、区分大小写，**非法值复位成表的第一项**（不是保持原值），同编译期 `normalizeDepthKeys`：
  - `blending`：`normal` / `translucent` / `additive`（`alphatocoverage` 没测，枚举 3，hdr-macro-REPORT）；`bogus` / `Additive` / `disabled` / `3` / `null` → `normal`；
  - `alphawriting`：`enabled` / `disabled` / `default`；非法 → `default`；
  - `depthtest`、`depthwrite`：`enabled` / `disabled`；非法 → `disabled`（`less` 也非法）；
  - `cullmode`：`normal` / `nocull`；非法（`back` / `front` / `none` / `Normal`）→ `normal`。
- **还要读码**：五个字段的 setter（`FUN_1401577e0` 一带）的完整枚举表（`blending` 有没有第 5 项以后的名字）、改值回调做什么——特别是写成 `alphatocoverage` 时着色器的 `ALPHATOCOVERAGE` 组合键（P8 编译期加）会不会重编着色器，还是只改管线。读完再定实现。

方向：
- 状态字段写入成为 `SceneState` 里按 pass 键的覆盖（只收 WPE 认得的值，`bogus`、数字不改，实测 `M2`）；
- `GpuScene.sync` 发现某 pass 的覆盖变了，就给用到它的绘制换管线（按状态组合缓存，WebGPU `createRenderPipeline` 同步可用）；哪个 pass 的哪个字段真正进哪次绘制，照现有规则（上屏混合借基础材质、剔除取 effect 材质，P2a / P5d）。
- 重编译重放同普通字段写入。

## 验收

**P6d1a**
- 子代理：宿主 tsc 0 error，只跑相关 vitest 文件，Prettier。
- 单测：
  - `render/rotation.test.ts`：`p6d1-xform.log` 与 `p6d1-round2.log` 的 R1–R11、`C`、R1c、R2、R4、L1–L9、Y1–Y3、`L6` 的角度与矩阵逐位相同（NaN 按 NaN 比）；
  - `layerLocalMatrix`：`rotation` 为 null 时与改动前逐字节相同；
  - `script/api.test.ts`：`id` 不在自有键里；`getLayerByID` 的字符串 / 数字 / 无参；`getEffect` 的下标 / 名字 / 同名取最后 / 空串 / 越界；`name` 写后按新名字找得到；`getMaterial` 的下标 / 文件名 / 空串；`getMaterial(0)` 与材质常量脚本的 `thisObject` 同一个；`setMaterialProperty` 照 `S1`–`S7` 的全部情形；材质对象的键与顺序照三组实测；
  - 重编译：`rotateObjectSpace` 之后重编译，`replayWrites` 恢复 3×3 与角度；之后写 `angles` 清掉 3×3。
- Claude 独立验收：
  1. `git status` 查越界；tsc、相关 vitest 自跑。变异检查：去掉角度写入清 `rotation`、`rotateObjectSpace` 左乘、`setMaterialProperty` 不按 Vec2 截断、材质键不看 `used`、`getEffect` 同名取第一个。
  2. 语料扫描与 HEAD 比：`unsupported` 只少本步删掉的键；没用 `getEffect` 的场景 bundle 逐字节相同；用了的场景只多出原来跳过的 effect。
  3. 真机：`p6d1-xform`、`p6d1-xform2`、`p6d1-mat`、`p6d1-mat2/3/4` 导入 dev 库，`render_scene` 跑同一份脚本，`[kbp6d]` 读回与 WPE 日志逐行相同（`kabegame-dev` 的应用日志），`p6d1-mat` 的八块颜色与 WPE 抓帧相同；`p6d1-xform` 的画面和 WPE 抓帧比（三个转向方法真的改了画面）。测完 `projects_remove`。
  4. 过后才请用户提交。

**P6d1b** 在补测之后补写。

## 待定

1. **材质对象键的顺序**（推荐：复刻 MSVC `unordered_map` 的迭代顺序，用三组实测核对，对不上再报）。另一种是当已知差异记下、保留声明顺序：只有枚举材质对象键的脚本看得出区别，语料里没有。
2. **用到 `getEffect` 时全部 effect 进 bundle**（推荐）。另一种是只在脚本真把关着的 effect 打开时整场重编译：省一点编译，但打开那一下会重新加载，和 WPE 当帧打开不同。

## 已定

1. **材质对象键照 WPE 的顺序**（2026-11-15 用户「同意」，待定 1 推荐项）：复刻 MSVC `unordered_map` 的迭代顺序，三组实测核对，对不上停下报告。第一次按声明顺序插入没对上（P6d1a 提交时保留声明顺序），用户同意再读码（「同意」），查清后补提交，见实施记录「材质键顺序（补提交）」。
2. **用到 `getEffect` 时全部 effect 进 bundle**（同上，待定 2 推荐项）。

## 实施记录

### P6d1a 实施（2026-11-15，独立工作树 `ignore/p6/d1/wt`，基点 HEAD `868d1711`，sonnet 分三段）

- 第一段：点 1（`LayerState.rotation`、`rotation` 写入目标、`render/rotation.ts`），实测全部逐位相同（−0 与 0 视同：WPE 日志印不出符号）。
- 第二段前半：点 2（`installHierarchy`、`getLayerByID`、删 `id`）、能力表对应条目。
- 第二段后半：点 3–6；三处修正：`getTransformMatrix` 在有挂点缓存（`WorldStamps`）的场景里先清本帧已有的变换写入的戳、再按戳求值（WPE 的 `getTransformMatrix` 就是那个带戳的函数，调用会改写缓存，之后的绘制沿用），取到写入时作废 `drawPhase` 的预置；`getLayer()` / `getLayerByID()` 无参返回 `undefined`；`strtol` 的空白照 `isspace`。

**材质键顺序没能复刻（「已定」1 的「对不上停下报告」）**：照 MSVC `xhash`（FNV-1a 64 位、初始 8 桶、负载因子 1、空桶追加到链表末尾、非空桶插在桶链最前）以「着色器声明顺序」为插入顺序，三组都对不上（tint 算出 `alpha, color`、实测 `color, alpha`；transform 算出 `offset, scale, angle`、实测 `scale, offset, angle`；chromaticaberration 算出 `center, strength, direction, center_falloff`、实测 `center_falloff, center, direction, strength`）；换反序、字典序、桶数、前插 / 后插都凑不出。WPE 往实例表里插的顺序不是声明顺序，要读合并常量表的代码（`FUN_1400d39f0`、遍历 `FUN_1400d5070`）才能定。代码保留声明顺序，待用户定。

**`rad2deg` 材质常量的单位**（实施中发现现有代码完全没处理 `conversion: "rad2deg"`；补测 `p6d1-mat6`，读回 `ignore/p6/d0/out/p6d1-round2.log` 末段）：
- JSON `constantshadervalues` 的值、用户属性的值：**弧度**，原样进状态（写 0.5 读回 28.647890°；属性 30 读回 1718.8734°）。
- 脚本一侧一律**度**：材质对象字段的读写（`getMaterial(i).<键>`、常量脚本的 `thisObject.<键>`）、`setMaterialProperty`、常量上挂的字段脚本 `update` 收到的 `value`（28.647890）与返回值（返回 45 读回 45）。
- 第二段后半已做字段读写与 `setMaterialProperty` 的换算（`MaterialSlot.rad2deg`，存 `f32(f32(度)·f32(0.017453292))`）；字段脚本的参数与返回值随后补上（`ScriptTarget` 常量变体的 `rad2deg`，`runtime.ts` 的 `value()` / `writeReturn()`）。

**Claude 独立验收**（2026-11-15，回归 F1–F9）：
- tsc 0 error；相关 10 个测试文件工作树 361 条、合并进主工作区后 372 条全过。
- 变异检查 12 + 1 处全部检出（一处原清单是等价变异，改写后检出）。
- 语料（233 张，同一份翻译器 wasm）：只去掉本步的 5 个键，没有新增；干净 159 → 160（`3243449890`）。
- 合并：工作树基点 `868d1711`，主工作区当时的 HEAD 已到 `6d46439b`（P12b2-1），按块三方合并（祖先取基点）无冲突，合并前的文件留在 `ignore/p6/d1/merge/pre/`。
- 真机（dev 探针跑脚本，`[kbp6d]` 读回逐行对 WPE 日志）：转向三个工程 68 行、材质五个工程全部数值逐位相同；画面与 WPE 抓帧一致；只有材质对象键的顺序不同（上面的待定）。
- 真机发现并修了一处：`lookAt` 视线与 up 平行时 WPE 写进 NaN，我们经图层向量字段写入被丢掉（读回 0 0 0）。改为 `rotation` 写入目标允许 3×3 为 `null`（等于角度 setter：原样存角度、3×3 按角度重建），`lookAt` / `lookAtYaw` 用它；补单测 L3b。工作树与主工作区同步改。
- `3243449890` 能渲染；`objects/48/visible` 的 `update` 报错是作者把拖拽脚本挂在 `visible` 上，WPE 同样会抛。
- 解锁场景的实时画面（F9）：用户手测「和 WPE 差不多」（2026-11-15）。
- 提交：`89722d0d`（31 个文件；工作树先对齐到 `baa6a591` 重验，临时索引提交，文档只带本步的段落）。

### 材质键顺序（补提交，2026-11-15）

- 读码 [rea-p6d1-keyorder.md](rea-p6d1-keyorder.md)：模型（FNV-1a + MSVC `unordered_map`）本身对，错在两处——插入顺序是材质键的 **UTF-8 字节序**（合并常量表 `+0x20` 是 `std::map`，`FUN_140154480` 中序遍历），V8 装访问器（`AppendUniqueCallbacks` 从后往前收、同名留后一个）又把整串**倒序**。静态表链表顺序 `blending, alphawriting, cullmode, depthtest, depthwrite`，倒过来正是实测。复刻脚本 `ignore/p6/rea/layers/keyorder/`。
- WPE 实测扩容（`p6d1-keys`：fire、pulse 9 个键，lightshafts 12 个键）：三组和读码预测逐项相同（fire 以 `threshold` 开头，不扩容会以 `scale` 开头）。读回在 `ignore/p6/d0/out/p6d1-round2.log` 末段。
- 实现 `script/materialKeyOrder.ts`（`materialConstantOrder` / `materialObjectKeys`），`material()` 按它交错定义常量与状态字段。单测七组逐项相同；变异 3 处全部检出；真机 `p6d1-mat2/3/4`、`p6d1-keys` 的 `Object.keys` 和 WPE 相同（回归 F10）。
