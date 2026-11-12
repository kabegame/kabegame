# P7d — 流体与渲染器缺口（子计划）

> 上级：[P7 总计划](phase-7-effects-shaders.md)「P7d」。依据：[p2-REPORT](../p2-REPORT.md) B6（fbo、`swap`、`fit`）与 I4（uniform ID → 取值）、[vector-constant-REPORT](../vector-constant-REPORT.md) 2.1–2.3（材质常量的槽位与上传）、[rea-p7-shader](rea-p7-shader.md)（常量缓冲的划分）；步骤 0 的 [rea-p7d-fluid](rea-p7d-fluid.md)（读码）与 [p7-REPORT](p7-REPORT.md)「P7d 的实测」。
> 语料基准：`ignore/p7/out/corpus-p7c.json`（P7c 收尾的扫描，能渲染 42 张；P4–P6 先做完的口径 62 张）。
> 2026-11-12 步骤 0 之后改定：总体设计、步骤 1–3 与「决定」按步骤 0 的结论重写，原方案里被推翻的写在「实施记录 / 步骤 0」。

## 总体设计思路

P7d 有两组互不相关的活，都是先查清 WPE 的行为再照做：
- **流体 effect**（`effects/fluidsimulation`）：着色器 P7a–P7c 已经能翻译，剩下 effect 结构上的三个键：
  - pass、fbo、bind 上的 `conditions`；
  - effect 实例顶层的 `combos`；
  - effect.json 的 `functions`。
  
  模拟 RT 跨帧保留和 `swap` 在 P2a / P3c 已经有了，步骤 0 核对过与 WPE 一致。
- **P7c 之后露出来的四个渲染器缺口**：步骤 0 查明其中三个是误报，起因相同：我们不知道着色器读没读某个 uniform。只有 `g_LayerModelMatrix` 是真缺口。

**条件在编译期求值，规则照抄 WPE 的求值函数。** WPE 只在加载 effect 时求一次（`FUN_1401e63b0`），被去掉的 fbo、pass、bind 根本不进 effect 对象，运行期不再看条件。我们同样在 `compileEffect` 里求值，被去掉的不进 bundle，所以渲染图 `graph.ts` 与 `scene.ts` 都不用改。

规则都是步骤 0 实测加读码定的：
- 求值的 COMBO 只来自 effect 实例**顶层**的 `combos`，实例 pass 覆盖里的 COMBO 不参与。顶层 `combos` 也不并进各 pass 的 COMBO，它只给条件用。
- `conditions` 必须是数组。数组之间、对象里各键之间全是「与」，缺的 COMBO 当 0。右值是数就比相等，是 `{value, op}` 就认 `ge/gt/le/lt`，其它都按相等。
- 被去掉的绘制 pass 仍占实例覆盖的位置。
- `target` 指向被去掉的 fbo 等于没写（画回合成链）；bind 指向它等于 `previous`。

**`functions` 只是声明。** 唯一的调用方是脚本 `executeMaterialFunction`：读码列全了调用点，加载、属性变化、可见性切换都不调它；语料 157 个工程里也没有一处脚本调用。所以：
- `functions` 按中性放开；
- 脚本调用照报 `script:api:effect.executeMaterialFunction`。

读码还发现 WPE 自己的实现有错位：它清的是 fbo 列表里的前 N 个，不是点名的那几个，流体的 `clearDye` 实际清的是速度场。以后要实现时得照这个错位做，记在 rea 报告里。

**翻译器标出没被读到的 uniform，宿主照 WPE 的反射规则用它。** WPE 只把反射里「被使用」的 uniform 当真：只有它们进常量缓冲，材质常量也只有它们分配槽位。实测证实，槽位按材质键名排序累加；两阶段同键时，合并类型取读到它的那个阶段（片元优先）。

我们的翻译器现在不分有没有被读，造成三类误报，在语料里全部是假的：
- 5 处 `constant:*`：流体的 `advection` 与 `procedural_noise` 只数被读的键，分别是 10 与 19 个 float，远低于 48。`frame_builder` 的 `u_refResolution` 两阶段都没读；`frame_builder_by_gariam` 只有顶点读，合并类型就是顶点的 `vec2`。
- 1 处 `uniform:g_FrameTime`：只声明、没读。

做法是翻译器反射加一个 `unused` 标记（只改反射 JSON，WGSL 逐字节不变），宿主在三处用它：
- 槽位只数被读的键；
- 合并类型取读到它的阶段；
- 能力表跳过没被读的 uniform。

真实的同键不同类型（多读的分量来自排序后的下一个键）与超过 48 个 float，语料里都没有样本，照报。

**`g_LayerModelMatrix` 只在 effect pass 里支持。** 实测它在 effect 的每个 pass 里是图层世界矩阵（含父链、不含 size）。基础 pass 与直接上屏的 pass 里，WPE 不写它，读到的是上一个带 effect 的图层留下的值，复刻没有意义。语料里读它的 7 个请求都是 effect 着色器。所以：
- 只把它当作 effect pass 的引擎 uniform，同粒子 pass 的 `PARTICLE_UNIFORMS`；
- 基础材质读到它照报；
- 取值在 `render/uniforms.ts` 用已有的世界矩阵算，不碰 `scene.ts`。

P7d 在两种口径下都解锁不了场景：
- 流体那张（`3286859278`）还差 P4–P6、P8、P11 的 47 个键；
- 四个缺口所在的另外 4 张场景，去掉这几个键后各自还剩 28–58 个别的键。

这一节补的是正确性。验收用确定性测试工程和 WPE 自带的流体预览工程，和 WPE 抓帧比。

## 现状锚点

行号按 HEAD `5237a39e`。

**a. effect 结构的白名单**（`apps/wpe-scene/src/compile/features.ts:265`–`:267`、`:630`）
```ts
const SUPPORTED_EFFECT_PASS = new Set(["material", "command", "source", "target", "compose", "bind"]); // 现状：没有 conditions
const SUPPORTED_FBO = new Set(["name", "format", "scale", "width", "height", "fit", "unique", "clear", "uvs"]); // 现状：没有 conditions
const SUPPORTED_EFFECT_INSTANCE = new Set(["file", "id", "name", "passes", "visible"]); // 现状：没有 combos
// …
    if (!SUPPORTED_EFFECT.has(key) && active(value)) unsupported.add(`effect:${label}:${key}`); // 现状：functions 报这里
```
bind 数组里的 `conditions` 不经过任何检查，现在被静默忽略（流体的 combine pass 照样绑 `_rt_SmokeNormal` 与槽 4）。

**b. 编译 effect：fbo、pass、bind 全收**（`apps/wpe-scene/src/compile/bundle.ts:953`–`:987`）
```ts
    const fbos = new Map(
      (effect.fbos ?? [])
        .map((item) => parseFbo(item, postprocess.hdr))   // 现状：不看 conditions
        .filter((item) => item.name)
        .map((item) => [item.name, item]),
    );
    // …
      const override = instance.passes?.[overrideIndex++];   // 现状：每个绘制 pass 占一个实例覆盖（与 WPE 相同）
      // …
      const binds = Array.isArray(pass.bind)
        ? pass.bind
            .filter((bind) => typeof bind?.name === "string" && Number.isInteger(bind?.index))   // 现状：不看 conditions
            .map((bind) => ({ name: String(bind.name), index: Number(bind.index) }))
        : null;
      // …
          combos: { ...materialPass.combos, ...override?.combos },   // 现状：顶层 combos 不参与（与 WPE 相同）
```

**c. fbo 的 `clear` 写 3 个分量也清**（`apps/wpe-scene/src/compile/bundle.ts:515`、`:524`）
```ts
  const clear = typeof raw.clear === "string" ? numbers(raw.clear) : [];
  // …
    clear: clear.length >= 3 ? [clear[0], clear[1], clear[2], clear[3] ?? 1] : undefined,   // 现状：WPE 要 4 个分量才置清除位
```
清的时机：创建时、effect 开关时（`clearLayerFbos`，P3c J6），之后内容与 `swap` 的对应跨帧保留。和 WPE 一致（rea-p7d-fluid 第 3 节：WPE 在图层 effect 资源重建时清，可见 effect 数变化会触发重建）。

**d. 程序检查不分有没有被读**（`apps/wpe-scene/src/compile/features.ts`、`compile/bundle.ts:900`）
```ts
  for (const uniform of result.uniforms ?? [])
    if (typeof uniform.meta?.material !== "string" && !isEngineUniform(uniform.name) && !extra.has(uniform.name))
      unsupported.add(`uniform:${uniform.name}`);   // 现状：只声明没读的也报（g_FrameTime）
```
```ts
      checkProgramFeatures(result, issues, context.particle ? PARTICLE_UNIFORMS : undefined);   // 现状：只有粒子 pass 带额外表
```

**e. 槽位与合并类型按全部材质 uniform 算**（`apps/wpe-scene/src/compile/shader.ts:63`、`compile/materialValues.ts:140`–`:150`）
```ts
    floats += slot.members[0]?.components ?? 0;   // 现状：没被读的键也算
  }
  if (floats > MATERIAL_SLOT_FLOATS) issues?.add("constant:slots");
```
```ts
    const fragmentHalf = list.find((u) => u.stage === "fragment");   // 现状：片元那一半没被读也拿它当合并类型
    // …
      const record = u.stage && fragmentHalf ? fragmentHalf : u;
      const components = elementComponents(record);
      const count = u.array ? 0 : own;
      if (count > components) issues.add(`constant:mixed-type:${material}`);
```

**f. 翻译器的 uniform 反射没有「被读」**（`src-tauri/wpesl2wgsl/src/lib.rs:154`）
```rust
pub struct Uniform {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: String,
    pub declared: String,
    // …
    pub stage: Option<Stage>,
    pub original: Option<String>,   // 现状：到此为止，没有引用信息
}
```

**g. effect pass 的内置矩阵**（`apps/wpe-scene/src/render/uniforms.ts:283` 起的 `drawMatrices`、`:356` 的 `drawUniformValues`）：`drawUniformValues` 已经拿到图层世界矩阵 `world`（沿父链），`staticBuiltins` 没有 `g_LayerModelMatrix`。

**h. 语料里的键**（`corpus-p7c.json`）与步骤 0 的结论：

| 键 | 场景 | 来源 | 步骤 0 |
|---|---|---|---|
| `effect:fluidsimulation:{combos, functions, pass:conditions, fbo:conditions}` | `3286859278` | WPE 自带 `effects/fluidsimulation`；`combos` 在实例顶层 | 真，步骤 3 |
| `constant:slots` | `3286859278`、`3643916956` | 流体 `advection`、工坊 `procedural_noise` | 误报：只数被读的键是 10、19 个 float |
| `constant:mixed-type:Reference resolution` | `3577990983`、`3643916956`、`3660962877` | 工坊 `frame_builder`、`frame_builder_by_gariam` | 误报：没读或只有顶点读 |
| `uniform:g_FrameTime` | `3643916956` | 工坊 `procedural_noise` | 误报：只声明没读 |
| `uniform:g_LayerModelMatrix` | `3577990983`、`3643916956`、`3660962877`、`3837478759` | 工坊 `rounded_mask`、`frame_builder*` | 真，effect 着色器的顶点读，步骤 2 |

## 步骤

### 步骤 0 — 调研（2026-11-12 完成）

原计划的读码 7 问与实测 4 项都做了，结论见「实施记录 / 步骤 0」。产出：[rea-p7d-fluid](rea-p7d-fluid.md)、[p7-REPORT](p7-REPORT.md)「P7d 的实测」、`ignore/p7d/`。

### 步骤 1 — 翻译器标出没被读到的 uniform，宿主照 WPE 用它

**点 1 — 反射加 `unused`**（`src-tauri/wpesl2wgsl/src/lib.rs`、`src/naga_stage.rs`）
- **新增** `Uniform.unused`：两个阶段入口可达的代码都没读这一格。拆开的两半各看自己的阶段。
  > 说明：只改反射 JSON，WGSL 不变，逐字节基线照常过。字段缺失当被读，手写的测试数据不用改。判据是 naga IR 里的语法引用；fxc 会多删掉一些（如乘 0），两者的差别见风险 2。
```rust
pub struct Uniform {
    // …
    pub original: Option<String>,
    /// 两个阶段入口可达的代码都没读这一格（naga IR 里没有对 uniform 块这个成员的 `AccessIndex`）。WPE 只认反射里被使用的
    /// uniform：没被使用的不进常量缓冲、不分配材质常量槽位（vector-constant-REPORT 2.1，p7-REPORT「P7d 的实测」）。
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub unused: bool, // 新增
}
```
- **新增** `naga_stage.rs`：编译完一个阶段，从入口函数出发沿 `Statement::Call` 收集可达函数，在其中找 `Expression::AccessIndex { base }` 且 `base` 是 uniform 块全局变量的成员下标，随 `Compiled` 返回；`lib.rs` 合两个阶段。
- **修改** `apps/wpe-scene/src/wpesl2wgsl/index.ts` 的 `UniformLayout` 加 `unused?: true`；README「反射」一节写这个字段与依据。

**点 2 — 宿主的槽位与合并类型**（`compile/materialValues.ts`、`compile/shader.ts`）
```ts
export interface MaterialSlot {
  material: string;
  members: MaterialMember[];
  /** 有没有阶段读到这个键：WPE 只给被使用的键分配槽位（p7-REPORT「P7d 的实测」`kbslot`）。 */
  used: boolean; // 新增
  issues: string[];
}

export function materialSlots(uniforms: readonly UniformLayout[]): MaterialSlot[] {
  // …
  for (const [material, list] of groups) {
    const read = list.filter((u) => !u.unused); // 新增
    // 修改：合并表里片元覆盖顶点，但没读到的阶段没有这个键，所以取「读到它的片元一半」，没有再取读到的顶点一半
    const fragmentHalf = read.find((u) => u.stage === "fragment") ?? read.find((u) => u.stage === "vertex")
      ?? list.find((u) => u.stage === "fragment");
    // …
      // 修改：没被读的那一格不比宽度（WPE 不上传它）
      if (!u.unused && count > components) issues.add(`constant:mixed-type:${material}`);
    // …
    slots.push({ material, members, used: read.length > 0, issues: [...issues] });
  }
}
```
```ts
    // 修改：只数被读的键（WPE 的槽位）
    if (slot.used) floats += slot.members[0]?.components ?? 0;
```
- 取值的 setter 与缺省随合并类型走，`frame_builder_by_gariam` 的顶点一半从此按 `vec2` 写（WPE 的行为）。

**点 3 — 程序检查跳过没被读的 uniform**（`compile/features.ts`）
```ts
  for (const uniform of result.uniforms ?? [])
    if (
      !uniform.unused && // 新增：WPE 的反射里没有它，不进常量缓冲
      typeof uniform.meta?.material !== "string" &&
      !isEngineUniform(uniform.name) &&
      !extra.has(uniform.name)
    )
      unsupported.add(`uniform:${uniform.name}`);
```
> 说明：真读到的 `g_FrameTime` 照报，WPE 里是没人写的垃圾值。别的阶段的键（比如只声明没读的音频频谱）也会随之少报，扫描时逐张列出。

**验收：**
- 翻译器：Rust 单测覆盖四种情况：被读、只在关掉的 `#if` 里、只在没调用的函数里、两半各自的阶段。请求夹具全部通过，逐字节基线 0 差异（WGSL）；wasm 重建。
- 宿主：单测覆盖槽位只数被读的键、合并类型取读到的阶段、就地写与整场重编译一致、程序检查跳过 `unused`。
- 语料：5 处 `constant:*` 与 `uniform:g_FrameTime` 消失，其余键的变化逐张列出并说明。
- WPE：`p7d-uni` 的 `kbslot` 在 Kabegame 里与 WPE 颜色相同（不含溢读的分量：那一项照报 `constant:mixed-type:k_m`，要另做一份不溢读的图层）。

### 步骤 2 — `g_LayerModelMatrix`

**点 1 — 只给 effect pass**（`compile/features.ts`、`compile/bundle.ts`）
```ts
/**
 * 只有 effect pass 才写的引擎 uniform（p7-REPORT「P7d 的实测」）：`g_LayerModelMatrix` 在 effect 的每个 pass 里是图层世界矩阵；
 * 基础 pass 与直接上屏时 WPE 不写，读到的是上一个带 effect 的图层留下的值，所以基础材质里照报。
 */
export const EFFECT_UNIFORMS: ReadonlySet<string> = new Set(["g_LayerModelMatrix"]); // 新增
```
```ts
      // 修改：effect pass（有 fbo 表的上下文）带 EFFECT_UNIFORMS
      checkProgramFeatures(result, issues, context.particle ? PARTICLE_UNIFORMS : context.fbos ? EFFECT_UNIFORMS : undefined);
```

**点 2 — 取值**（`render/uniforms.ts`）
- **修改** `drawMatrices` 的 `effect`、`final` 两种角色返回 `layerModel: world`；`staticBuiltins` 有它时写 `g_LayerModelMatrix`；`LAYER_UNIFORMS` 加它（图层或祖先变化时一起重写）。
```ts
    case "effect": {
      // …
      return { /* … */ layerModel: model }; // 新增：图层世界矩阵（含父链、不含 size）
    }
// staticBuiltins
  if (input.layerModel) values.g_LayerModelMatrix = Array.from(input.layerModel); // 新增
```
- `scene.ts` 不用改：`drawUniformValues` 已经拿到 `world`。

**验收：**
- `render.test.ts` 的两张表核对加上 `EFFECT_UNIFORMS`；单测核对矩阵，覆盖缩放、旋转、父链、effect 中间 pass 与上屏 pass。
- `p7d-uni` 的 `kbfx`、`kbchild` 在 Kabegame 里与 WPE 抓帧的常量逐值相同（经 dev 探针读 uniform）。`rounded_mask` 的圆角在缩放过的图层上和 WPE 同形：另做一个确定性工程，两边逐像素比。

### 步骤 3 — 流体 effect

**点 1 — 条件求值**（新文件 `compile/conditions.ts`）
```ts
/**
 * effect.json 的 `conditions`（fbo、pass、bind 三处），照 WPE `FUN_1401e63b0`（rea-p7d-fluid 第 1 节）：
 * - 不是数组 → 真；元素不是对象 → 跳过；
 * - 数组之间、对象各键之间都是「与」；
 * - 左值取实例顶层 `combos[名字]`，数取整（截断），缺失或其它类型当 0；名字区分大小写；
 * - 右值是数 → 相等；是 `{value, op}` → `ge` / `gt` / `le` / `lt`，其它按相等；其它类型 → 这个键不参与。
 */
export function conditionsHold(conditions: unknown, combos: unknown): boolean;
```

**点 2 — 编译 effect**（`compile/bundle.ts` 的 `compileEffect`）
```ts
    // 新增：条件只看实例顶层 combos，且只给条件用，不并进 pass 的 COMBO（`ltop` / `r3top` 实测）
    const holds = (conditions: unknown) => conditionsHold(conditions, instance.combos);
    const removed = new Set((effect.fbos ?? []).filter((item) => !holds(item.conditions)).map((item) => String(item.name)));
    const fbos = new Map(
      (effect.fbos ?? [])
        .filter((item) => holds(item.conditions)) // 新增
        .map((item) => parseFbo(item, postprocess.hdr))
        // …
    );
    // …
      const override = instance.passes?.[overrideIndex++]; // 不变：被去掉的 pass 照样占位（WPE 相同）
      if (!holds(pass.conditions)) continue; // 新增
      const binds = Array.isArray(pass.bind)
        ? pass.bind
            .filter((bind) => typeof bind?.name === "string" && Number.isInteger(bind?.index))
            .filter((bind) => holds(bind.conditions)) // 新增：不满足的 bind 不绑，槽位保持材质原来的纹理
            // bind 指向被条件去掉的 fbo：graph 按「不是本 effect 的 fbo」处理成当前合成 RT，与 WPE 的 −1 相同
      // …
        target: typeof pass.target === "string" && !removed.has(pass.target) ? pass.target : null, // 修改：指向被去掉的 fbo 等于没写
```
- `swap` 的一端被去掉：WPE 什么都不做，这里不收这条命令。`copy` 的一端被去掉：语料 0 处，报 `effect:<名>:command-operands`。

**点 3 — 能力表**（`compile/features.ts`）
```ts
const SUPPORTED_EFFECT = new Set([
  // …
  // 新增：具名动作的声明，唯一调用方是脚本 `executeMaterialFunction`（照报 `script:api:effect.executeMaterialFunction`），
  // 加载、属性变化、可见性切换都不调（rea-p7d-fluid 第 2 节）；语料 0 处调用
  "functions",
]);
const SUPPORTED_EFFECT_PASS = new Set(["material", "command", "source", "target", "compose", "bind", "conditions"]); // 修改
const SUPPORTED_FBO = new Set([/* … */ "uvs", "conditions"]); // 修改
const SUPPORTED_EFFECT_INSTANCE = new Set(["file", "id", "name", "passes", "visible", "combos"]); // 修改
```
- **修改** `checkEffectFeatures` 收 `holds`：被条件去掉的 fbo、pass、bind 不检查；`target` 指向被去掉的 fbo 不报。
- **新增** bind 数组逐项查键（现在没人查）：`name`、`index`、`conditions` 之外的键报 `effect:<名>:bind:<键>`。
- 实例顶层 `combos` 写成对象（绑用户属性）：WPE 在条件里当 0，照做，不报。

**点 4 — fbo 的 `clear` 要 4 个分量**（`compile/bundle.ts` 的 `parseFbo`）
```ts
    clear: clear.length >= 4 ? [clear[0], clear[1], clear[2], clear[3]] : undefined, // 修改：WPE 解析出 4 个数才置清除位（rea-p7d-fluid 第 2 节第 5 条）
```
> 说明：语料里写 `clear` 的只有流体的 6 个 fbo，都是 4 个分量，画面不变。

**验收：**（容差待定，见「决定」4）
- **单测：**
  - `conditionsHold` 的各种写法；
  - 流体 effect 在 `LIGHTING` 0 / 1、`RENDERING` 1 / 3 下的步骤序列、fbo 集合、bind 槽位；
  - 实例覆盖的位置。
- **结构对照：** `p7d-fluid`、`ltop`、`r3both` 三个变体的计划，和 WPE 抓帧逐项比：绘制数、各 pass 的目标尺寸与格式、各槽绑的纹理。
- **单步隔离：** 从 WPE 一帧开始时的模拟 RT 与这一帧的 `g_Frametime` 出发，在 Kabegame 里跑一帧流体链，和 WPE 这一帧结束时的 RT（速度、压力、染料）逐像素比。
  - 要给 dev 探针加一个「把指定 fbo 换成给定内容」的入口，做法同泛光的链路隔离；
  - 差异应只有半精度舍入。
- **长程：** 同一工程在 Kabegame 里跑到第 150 帧左右，与 WPE 三次运行比，差异落在 WPE 自身两次运行之间（平均差 9–12、差 > 16 的像素 22–38%）。
- **语料：** `3286859278` 不再报四个 effect 键，其余键不变；别的场景与基线逐张相同。

### 步骤 4 — 收尾

- 全语料扫描，与 P7c 基线逐张比；请求夹具重录、Tint 再过一遍（wasm 改了反射）。
- 文档：
  - 翻译器 README：`unused` 字段；
  - `cocs/wpe/WPE_SCENE.md`：能力表、材质常量、effect 图三处；
  - p2-REPORT B6 的两处更正：fbo `clear` 要 4 个分量；`swap` 改写的是全部非 swap pass 的下标；
  - 回归与 changelog。
- 本文件与总计划的实施记录。

## 和 P4–P6 的交界

- **共享文件：** 步骤 2、3 改 `compile/features.ts`、`compile/bundle.ts`。这两个文件现在都有别的会话没提交的改动。做法同 P7b、P7c：
  - 在 HEAD 的产品源码快照里实现、验收（`kbp snapshot export`）；
  - 合进工作区时三方合并，提交时只暂存自己的块（`ignore/p7/stage_hunks.py`）。
- **不碰：** `render/graph.ts`、`render/scene.ts`。`render/uniforms.ts`、`compile/materialValues.ts`、`compile/shader.ts` 现在没有别的会话在改。
- **翻译器 wasm：** 步骤 1 改反射、重建 wasm。WGSL 逐字节不变，别的会话只会看到少报的键（步骤 1 验收里逐张列出）。

## 决定

**已定（2026-11-12 用户，按推荐）：**
1. **`executeMaterialFunction`：** 不在 P7d 实现。`functions` 声明按中性放开，脚本调用照报。步骤 0 读码证实没有别的调用方。
3. **翻译器反射加 `unused`：** 加。步骤 0 证实这是 WPE 的规则（槽位与常量缓冲都只认被使用的），去掉了全部 5 处 `constant:*` 与 `uniform:g_FrameTime`。

**步骤 0 后改定（2026-11-12 用户，按推荐）：**
2. **同键不同类型：** 改为照报，不实现溢读（原定照 WPE 读下一个键的存储）。步骤 0 查明语料里没有真实样本，`frame_builder_by_gariam` 也是误报。
   - 实现要在宿主维护一份按键名排序的存储，`state.ts` 的就地写要连带重写溢读它的格子；
   - 规则已经实测清楚（`kbslot`，记在报告里），以后遇到样本再做。
4. **流体的验收：** 三层。结构对照逐项相同；单步隔离只差半精度舍入；长程统计落在 WPE 自身两次运行之间。单步隔离要新做一个 dev 探针入口。
5. **`g_LayerModelMatrix` 在基础 pass 里：** 照报（WPE 读到的是别的图层的残留值），只在 effect pass 支持。
6. **fbo `clear` 写 3 个分量：** 照 WPE 不清（语料 0 处）。
7. **风险 4 的效果矩阵：** 另派代理核对（读码、实测、语料影响），出报告，不随 P7d 改。

## 风险

1. **流体的逐帧对比：** 模拟 RT 是半精度浮点，dt 每帧不同，混沌（WPE 自己两次运行就差很多）。单步隔离能压住输入差异，但 Tint 与 fxc 的指令选择不同，单步也可能有超出舍入的差，要在单步里先量。
2. **「被读」的判据：** WPE 看的是 fxc 优化之后的反射，我们看 naga IR 的语法引用。fxc 删掉的读（乘 0、结果没被用）我们仍算被读。槽位数与「同键不同类型」不会因此出错，因为少一处读既不会多占槽位，也造不出同键不同类型。会出错的只有一种情况：两阶段同键、类型或缺省不同，片元的读被 fxc 删掉了。这时 WPE 取顶点那一半的类型与缺省，我们取片元的。语料里没有这种情况。
3. **四个缺口各只有 1–4 张样本，所在场景都还有很多别的键：** 在真实场景里看不到修好的效果，只能靠测试工程和 WPE 比。
4. **顺带发现，不在 P7d 范围：** 最后一个 effect 的中间 pass（画进 fbo）上，WPE 的 `g_ModelViewProjectionMatrix` 是图层 MVP、效果矩阵不缩放（`p7d-uni` 事件 73，顶点是 ±1 的全屏四边形）。我们按 P2a 的「effect」角色给单位 MVP、缩放过的效果矩阵。WPE 自带 effect 的中间 pass 顶点着色器都不乘 MVP（`gl_Position = vec4(a_Position, 1.0)`），所以没被发现；中间 pass 也乘 MVP 的工坊 effect，两边画面会不同。另开一项核对，不随 P7d 改。

## 实施记录

### 步骤 0 — 调研（2026-11-12）

读码见 [rea-p7d-fluid](rea-p7d-fluid.md)，实测见 [p7-REPORT](p7-REPORT.md)「P7d 的实测」，工具与数据在 `ignore/p7d/`（抓帧 `A:\p7d\cond2`、`det`、`uni`）。

推翻或改定的原方案：
- **顶层 `combos`：** 原以为要并进 pass 的 COMBO。实测只给条件用，不并进去。
- **`g_FrameTime`：** 原以为 WPE 恒写 0、要加进引擎表。实测它只是没人写的垃圾值；语料里的样本没读它，由 `unused` 消掉，真读到照报。
- **`g_LayerModelMatrix`：** 原以为所有 pass 都写。实测只在 effect pass 里写，基础 pass 是残留值。
- **同键不同类型：** 原定照 WPE 溢读。语料里没有真实样本，推荐改为照报，待用户定。
- **fbo 生命周期：** 不用改。另查到 `clear` 要 4 个分量才生效，B6 的「`r g b [a]`」写错了。

几条新信息：
- WPE 找 effect 的材质与着色器只认工程根与 assets 根，不认 effect 目录。我们更宽，不影响结果。
- `executeMaterialFunction` 的错位（清前 N 个 fbo）。
- P2a 效果矩阵的顺带发现（风险 4）。

我的失误：
- 第一版流体测试工程只留了 assets 里的材质，WPE 找不到，全部 effect pass 换成了缺省着色器（日志有 34 行材质报错）。第一轮条件抓帧作废，改成工程根下放现版材质后重抓。是从各 pass 着色器哈希全部相同发现的。
- 读码代理两次卡死（10 分钟无进展被看门狗停掉）：第一次什么都没留下；第二次改成边查边写，报告在卡死前已写完四问。
