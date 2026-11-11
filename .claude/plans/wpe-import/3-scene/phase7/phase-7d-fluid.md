# P7d — 流体与渲染器缺口（子计划）

> 上级：[P7 总计划](phase-7-effects-shaders.md)「P7d」。依据：[p2-REPORT](../p2-REPORT.md) B6（fbo、`swap`、`fit`）与 I4（uniform ID → 取值）、[vector-constant-REPORT](../vector-constant-REPORT.md) 2.1–2.3（材质常量的槽位与上传）、[rea-p7-shader](rea-p7-shader.md)（常量缓冲的划分）。
> 语料基准：`ignore/p7/out/corpus-p7c.json`（P7c 收尾的扫描，能渲染 42 张；P4–P6 先做完的口径 62 张）。

## 总体设计思路

P7d 有两组互不相关的活，共同点是都要先查清 WPE 的行为，再照做：
- **流体 effect**（`effects/fluidsimulation`）：它的着色器 P7a–P7c 已经能翻译。剩下的是 effect 结构上的四个键：
  - pass、fbo、bind 上的 `conditions`；
  - effect 实例上的 `combos`；
  - effect.json 的 `functions`；
  - 模拟 RT 跨帧保留。
- **P7c 之后露出来的四个渲染器缺口**：
  - 两个引擎 uniform：`g_LayerModelMatrix`、`g_FrameTime`；
  - 两个材质常量的存储问题：`constant:mixed-type`、`constant:slots`。

**条件在编译期求值。** `conditions` 写的是 COMBO 的取值（`{ "LIGHTING": 1 }`）。COMBO 在 WPE 里不能绑用户属性（我们照报 `combo:user-binding`），加载时就定了，所以条件也在加载时一次定下：
- 编译 effect 时，被条件去掉的 pass、fbo、bind 不进 bundle；
- 渲染图 `graph.ts` 和 `scene.ts` 看到的是一个普通 effect，不用改。

这样 P7d 不碰 P4–P6 正在改的渲染图和场景编码，只改 `compile/bundle.ts` 的 `compileEffect` 和能力表。

**实例 `combos` 合进条件与 pass。** 工坊场景把编辑器里选的 COMBO 写在 effect 实例顶层（`3286859278`：`"combos": {"RENDERING": 1}`），同时也抄进了相关 pass 的覆盖里。它在条件求值里用哪份集合、和 pass 覆盖谁优先，步骤 0 读码定。

**`functions` 只是声明。** 它定义一组具名动作（流体的 `clearVelocity` / `clearDye`：清两张 fbo），调用方是脚本 `IEffect.executeMaterialFunction`。语料 157 个工程里没有一处调用。
- 声明本身对画面没有影响，按中性放开；
- 脚本调用仍照报 `script:api:effect.executeMaterialFunction`；
- 如果步骤 0 读码发现 WPE 在别处（属性变化、可见性切换）也会调用它，就改成实现。

**跨帧保留多半已有。** P2a / P3c 的 fbo 只在创建时、effect 开关时按 `clear` 清，`swap` 的对应跨帧保留。`fit`、`rg1616f` / `r16f` / `rgba_backbuffer`、`previous` 也都在。步骤 0 只核对 WPE 的清除时机，不预设要改。

**两个引擎 uniform 按 WPE 的取值写。**
- `g_LayerModelMatrix` 在 WPE 的名字表里（ID 0x18，取 ctx+0xa30），但 I4 没查谁写这个位置。工坊的 `rounded_mask`、`frame_builder_by_gariam` 拿它取图层缩放（`length(m[0].xy)`），推断是图层的世界矩阵。
- `g_FrameTime`（大写 T）不在名字表里（表里是 `g_Frametime`），推断 WPE 把它当普通的常量缓冲成员、从不写，恒为 0。

两条都由步骤 0 读码加读常量缓冲定。

**材质常量照 WPE 的存储。** WPE 给每个 pass 一份 48 个 float 的存储，只给本阶段反射里「被使用」的材质键分配槽位（vector-constant-REPORT 2.1），上传时每格按自己的类型从槽位起点拷（2.2）。我们的翻译器反射不分有没有被用到，宿主把没被引用的 uniform 也算进去，所以两类报错有一部分是假的：
- `frame_builder` 的 `REF_RES` 缺省 0，`u_refResolution` 两个阶段都没读；
- 流体的 `POINTEMITTER` 为 1 时，其余三个发射器、全部线发射器都不读。

做法分两层：
- 翻译器反射标出没被引用的 uniform，宿主只给被引用的键分配槽位。只改反射 JSON，WGSL 逐字节不变。
- 剩下真实的同键不同类型（`frame_builder_by_gariam` 开 `REF_RES`：顶点 `vec2`、片元 `float`），照 WPE 读进下一个键的存储。这和 P7b「打包数组越界照 D3D11 读下一个成员」是同一个取舍。下一个键是谁，取决于合并表的遍历顺序，步骤 0 定。

P7d 在两种口径下都解锁不了场景：
- 流体那张（`3286859278`）还差 P4–P6、P8、P11 的 47 个键；
- 四个缺口所在的另外 4 张场景，去掉这几个键后各自还剩 28–58 个别的键。

这一节补的是正确性。验收全部用确定性测试工程和 WPE 自带的流体预览工程，和 WPE 抓帧比。

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

**b. 编译 effect：fbo、pass、bind 全收，pass 的 COMBO 只合材质与实例 pass 覆盖**（`apps/wpe-scene/src/compile/bundle.ts:953`–`:987`）
```ts
    const fbos = new Map(
      (effect.fbos ?? [])
        .map((item) => parseFbo(item, postprocess.hdr))   // 现状：不看 conditions
        .filter((item) => item.name)
        .map((item) => [item.name, item]),
    );
    // …
      const override = instance.passes?.[overrideIndex++];   // 现状：每个绘制 pass 占一个实例覆盖
      // …
      const binds = Array.isArray(pass.bind)
        ? pass.bind
            .filter((bind) => typeof bind?.name === "string" && Number.isInteger(bind?.index))   // 现状：不看 conditions
            .map((bind) => ({ name: String(bind.name), index: Number(bind.index) }))
        : null;
      // …
          combos: { ...materialPass.combos, ...override?.combos },   // 现状：实例顶层的 combos 不参与
```

**c. fbo 只在创建时清**（`apps/wpe-scene/src/render/scene.ts:1009`–`:1031`）
```ts
              const key = fbo.unique
                ? `unique|${layer.id}|${effect.id}|${fbo.name}`
                : `${fbo.name}|${fw}x${fh}|${fboFormat}|${fbo.repeat}`;
              // …
                // 创建后清成 `clear` 色；没写时 WebGPU 纹理本来就是全 0
                if (fbo.clear) this.clearTarget(setup, target, fbo.clear, `clear ${key}`);
```
另有 effect 开关时清本图层全部带 `clear` 的 fbo（`clearLayerFbos`，P3c J6）。之后内容与 `swap` 的对应跨帧保留。

**d. 引擎 uniform 表**（`apps/wpe-scene/src/compile/features.ts:53`–`:88`）：有 `g_Frametime`，没有 `g_LayerModelMatrix`、`g_FrameTime`，翻译结果里出现就报 `uniform:<名>`。取值在 `render/uniforms.ts` 的 `staticBuiltins` / `frameBuiltins`，两边由 `render.test.ts` 核对一致。

**e. 槽位按全部材质 uniform 数**（`apps/wpe-scene/src/compile/shader.ts:63`、`compile/materialValues.ts:150`）
```ts
    // WPE 每个键一份存储；拆开的两半共用片元那一半的
    floats += slot.members[0]?.components ?? 0;   // 现状：没被引用的键也算
  }
  if (floats > MATERIAL_SLOT_FLOATS) issues?.add("constant:slots");
```
```ts
      const count = u.array ? 0 : own;
      if (count > components) issues.add(`constant:mixed-type:${material}`);   // 现状：顶点那一半比片元宽就报，不看有没有被读
```

**f. 翻译器的 uniform 反射没有「被引用」**（`src-tauri/wpesl2wgsl/src/lib.rs:154`）
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

**g. 语料里的键**（`corpus-p7c.json`）：

| 键 | 场景 | 来源 |
|---|---|---|
| `effect:fluidsimulation:{combos, functions, pass:conditions, fbo:conditions}` | `3286859278` | WPE 自带 `effects/fluidsimulation`（pkg 里的副本与 assets 逐字节相同）；`combos` 在场景的 effect 实例上 |
| `constant:slots` | `3286859278`、`3643916956` | 流体的 `vorticity` / `advection` 片元（32 / 31 个材质 uniform）；`3643916956` 的待查 |
| `constant:mixed-type:Reference resolution` | `3577990983`、`3643916956`、`3660962877` | 工坊 `frame_builder`（`REF_RES` 缺省 0）与 `frame_builder_by_gariam`（`REF_RES` 1） |
| `uniform:g_LayerModelMatrix` | `3577990983`、`3643916956`、`3660962877`、`3837478759` | 工坊 `rounded_mask`、`frame_builder_by_gariam`：取图层缩放 |
| `uniform:g_FrameTime` | `3643916956` | 工坊 `procedural_noise` |

## 步骤

### 步骤 0 — 调研

**读码**（交给代理，REA 看 `wallpaper64.exe` 2.8.42，产出 `rea-p7d-fluid.md`）：
1. **`conditions`：**
   - 在哪里解析，pass、fbo、bind 三处是否同一个函数；
   - 比较规则：等于，还是也认 `gizmos` 里那种 `{op, value}`；
   - 数组里多个对象、一个对象里多个键，各是与还是或；
   - 拿哪份 COMBO 求值：实例顶层 `combos`、实例 pass 覆盖、材质 pass、着色器注解缺省；
   - 被去掉的绘制 pass 还占不占实例 `passes` 的位置；
   - fbo 被去掉、bind 还引用它时怎样。
2. **实例顶层 `combos`：** 是否合进每个 pass 的 COMBO，和实例 pass 覆盖谁优先。
3. **`functions`：**
   - 解析点与全部调用方：只有脚本 `executeMaterialFunction`，还是属性变化、可见性切换、编辑器也会调；
   - `clear` 清的是 `swap` 之后名字对应的实体，还是初始实体。
4. **fbo 生命周期：** `clear` 在什么时候执行（创建、resize、effect 开关、每帧），和锚点 c 对一遍。
5. **`g_LayerModelMatrix`：** 谁写 ctx+0xa30、写什么：
   - 图层世界矩阵，还是含 `size` 缩放；
   - 带不带父链、视差；
   - 基础 pass、effect 中间 pass、上屏 pass 是否相同。
6. **`g_FrameTime`：** 名字表认不出的、没有 `material` 注解的 uniform，进哪个常量缓冲、写不写。
7. **材质常量槽位：**
   - 合并表的容器与遍历顺序（按键排序的 `std::map`，还是插入顺序），这决定了越界读到哪个键；
   - 「本阶段反射里有」的判据，`&2` 是不是「被使用」；
   - 超过 48 个 float 时后面的键落在哪（报告 5 节推断是槽位 0）。

**实测**（`wpe-renderdoc` MCP，测试工程 `ignore/p7d/proj/`，抓帧放 `A:\p7d\<用途>\`）：
1. **流体预览工程：** WPE 自带的 `effects/fluidsimulation/preview` 复制到 `ignore/p7d/proj/fluid-preview`（不动安装目录）。
   - 抓连续几帧，记 pass 序列、fbo 尺寸与格式、每帧 dt 与光标。
   - 再造两个变体：开 `LIGHTING`、`RENDERING` 3，看条件去掉、加上的 pass 与 bind。
   - 同一条光标轨迹跑两次，看 WPE 自己的逐帧差异有多大，用来定验收的容差（流体对 dt 与初值敏感）。
2. **`g_LayerModelMatrix`：** 读常量缓冲。
   - 图层带缩放、旋转、`size` 不等于纹理、有父对象、开视差；
   - effect 两个 pass 以上。
3. **`g_FrameTime`：** 读常量缓冲。
4. **槽位：**
   - 两阶段同键不同类型（顶点 `vec2`、片元 `float`），后面跟几个名字排序与声明顺序不同的键，读顶点的常量缓冲，定「下一个存储」是哪个键；
   - 同一个 uniform 声明了、只在关掉的 `#if` 里读，看它占不占槽位；
   - 读码说能出现时，再造超过 48 个 float 的工程。

**我们这边：**
1. 用现在的 wasm 统计：语料里 `constant:slots`、`constant:mixed-type` 去掉没被引用的 uniform 之后还剩几处（引用判据先用改写后源码里的名字粗算，步骤 1 换成 IR 上的判据）。
2. 流体预览工程在 Kabegame 里现在报哪些键；用 dev 的强制渲染看现在画成什么样。

**产出：** `rea-p7d-fluid.md`、`p7-REPORT.md` 加「P7d」一节、本文件「实施记录 / 步骤 0」。下面步骤 1–3 的方案按结论改定。

### 步骤 1 — 材质常量照 WPE 的存储

**点 1 — 翻译器标出没被引用的 uniform**（`src-tauri/wpesl2wgsl/src/lib.rs`、`src/naga_stage.rs`）
- **新增** `Uniform.unused`。
  > 说明：只改反射 JSON，WGSL 不变，逐字节基线照常过。缺省（字段缺失）当被引用，手写的测试数据不用改。
```rust
pub struct Uniform {
    // …
    pub original: Option<String>,
    /// 两个阶段入口可达的代码都没读这一格（naga IR 里没有对 uniform 块这个成员的 `AccessIndex`）。WPE 只给反射里被使用的
    /// 材质常量分配槽位（vector-constant-REPORT 2.1），宿主据此算槽位。拆开的两半各看自己的阶段。
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub unused: bool, // 新增
}
```
- **新增** `naga_stage.rs`：编译完一个阶段后，在入口可达的函数里收集对 uniform 块全局变量的 `AccessIndex` 成员下标，随 `Compiled` 返回；`lib.rs` 合两个阶段。
- **修改** `apps/wpe-scene/src/wpesl2wgsl/index.ts` 的 `UniformLayout` 加 `unused?: true`。
- **修改** README「反射」一节写这个字段与依据。

**点 2 — 宿主按被引用的键分配槽位**（`compile/materialValues.ts`、`compile/shader.ts`）
- **修改** `materialSlots` 跳过两个阶段都 `unused` 的键（不进槽位、不报 `constant:*`；值照旧填，反正着色器不读）。
- **新增** 槽位起点：照步骤 0 的遍历顺序累加被引用的键。
```ts
export interface MaterialSlot {
  material: string;
  members: MaterialMember[];
  /** WPE 存储里的起始 float 下标（`+0x45`）：按合并表的遍历顺序累加被引用的键；没被引用的键为 null。 */
  offset: number | null; // 新增
  issues: string[];
}
```
- **修改** `shaderUniforms` 的 `floats` 只数被引用的键。

**点 3 — 同键不同类型照 WPE 读下一个存储**（`compile/materialValues.ts`、`render/state.ts`）
- **新增** `MaterialMember.spill`：本格多出来的分量从哪个键的哪个分量取（越过 48 或后面没有键时为 0）。
```ts
export interface MaterialMember {
  // …
  /** 本阶段类型比合并类型宽时多读的分量（vector-constant-REPORT 2.2）：第 i 个取 `material` 键存储的第 `component` 个 float，null 为 0。 */
  spill?: ({ material: string; component: number } | null)[]; // 新增
}
```
- **修改** 加载时填值、就地写 `constant` 目标时，被溢读的键改值要连带重写读它的那一格（`state.ts` 的 `constantMembers` 一处）。
- **删除** `constant:mixed-type` 的报错（溢读能复刻之后）。
- 步骤 0 若发现超过 48 个 float 的真实样本，再按同一份存储处理；否则 `constant:slots` 照报。

**验收：**
- 翻译器：Rust 单测（被引用、只在关掉的 `#if` 里、只在没调用的函数里、两半各自的阶段）；请求夹具全部通过，逐字节基线 0 差异（WGSL）；wasm 重建。
- 宿主：单测核对槽位起点、溢读的分量、就地写与整场重编译一致。
- 语料：`constant:*` 只剩真实情况，其余键与基线逐张相同。
- WPE：步骤 0 的槽位工程在 Kabegame 里与 WPE 颜色相同。

### 步骤 2 — 两个引擎 uniform

**点 1 — `g_LayerModelMatrix`**（`compile/features.ts`、`render/uniforms.ts`、`render/scene.ts`）
- **新增** `ENGINE_UNIFORMS` 加 `g_LayerModelMatrix`；`StaticBuiltinInput` 加 `layerModel`，`LAYER_UNIFORMS` 加它（图层或祖先变化时一起重写）。
```ts
export interface StaticBuiltinInput {
  // …
  /** `g_LayerModelMatrix`（ID 0x18，ctx+0xa30）：步骤 0 定（推断：图层世界矩阵，基础、effect、上屏 pass 相同）。 */
  layerModel: Mat4; // 新增
}
// staticBuiltins
    g_LayerModelMatrix: Array.from(input.layerModel), // 新增
```
- **修改** `scene.ts` 建绘制与刷新图层时传图层的世界矩阵（`worldMatrixOf`）。

**点 2 — `g_FrameTime`**（`compile/features.ts`、`render/uniforms.ts`）
- **新增**（步骤 0 证实 WPE 不写时）`ENGINE_UNIFORMS` 加 `g_FrameTime`，`staticBuiltins` 写 `[0]`，注释写依据。
  > 说明：只认这一个名字，不把「认不出的引擎 uniform 一律给 0」做成通配，别的名字照报，免得漏掉真缺口。

**验收：**
- `render.test.ts` 两张表一致；单测核对矩阵（缩放、旋转、父链、effect pass）。
- 步骤 0 的测试工程在 Kabegame 里与 WPE 逐像素比；`rounded_mask` 的圆角在缩放过的图层上和 WPE 相同。

### 步骤 3 — 流体 effect

**点 1 — 条件求值**（新文件 `compile/conditions.ts`）
```ts
/**
 * effect.json 的 `conditions`（pass、fbo、bind 三处），照 WPE（步骤 0）对 COMBO 集合求值。COMBO 不能绑用户属性
 * （`combo:user-binding`），所以条件在编译期一次定下，渲染图看到的是去掉之后的 effect。
 * 认不出的写法返回 null，调用方报 `effect:<名>:conditions-form`。
 */
export function conditionsHold(conditions: unknown, combos: Readonly<Record<string, number>>): boolean | null;
```

**点 2 — 编译 effect**（`compile/bundle.ts` 的 `compileEffect`）
- **修改** fbo、绘制 pass、bind 先过 `conditionsHold`；实例顶层 `combos` 按步骤 0 的优先级并进求值集合与 pass 的 COMBO。
```ts
    // 新增：条件求值用的 COMBO（实例顶层 combos，来源与优先级照步骤 0）
    const effectCombos = comboValues(instance.combos);
    const fbos = new Map(
      (effect.fbos ?? [])
        .filter((item) => holds(item.conditions)) // 新增
        .map((item) => parseFbo(item, postprocess.hdr))
        // …
    );
    // …
      const override = instance.passes?.[overrideIndex++]; // 被去掉的 pass 是否占位：步骤 0 定，必要时挪到判断之后
      if (!holds(pass.conditions)) continue; // 新增
      const binds = Array.isArray(pass.bind)
        ? pass.bind
            .filter((bind) => typeof bind?.name === "string" && Number.isInteger(bind?.index))
            .filter((bind) => holds(bind.conditions)) // 新增
      // …
          combos: { ...materialPass.combos, ...effectCombos, ...override?.combos }, // 修改：优先级照步骤 0
```

**点 3 — 能力表**（`compile/features.ts`）
- **修改** 四个白名单：
```ts
const SUPPORTED_EFFECT = new Set([
  // …
  // 新增：具名动作的声明，调用方只有脚本 `executeMaterialFunction`（照报 `script:api:effect.executeMaterialFunction`），
  // 语料 0 处调用（步骤 0 读码证实没有别的调用方）
  "functions",
]);
const SUPPORTED_EFFECT_PASS = new Set(["material", "command", "source", "target", "compose", "bind", "conditions"]); // 修改
const SUPPORTED_FBO = new Set([/* … */ "uvs", "conditions"]); // 修改
const SUPPORTED_EFFECT_INSTANCE = new Set(["file", "id", "name", "passes", "visible", "combos"]); // 修改
```
- **新增** bind 数组逐项查键（现在没人查）：`name`、`index`、`conditions` 之外的键报 `effect:<名>:bind:<键>`；实例顶层 `combos` 绑用户属性报 `combo:user-binding`（同实例 pass 的规则）。

**点 4 — fbo 生命周期**：按步骤 0 的结论核对锚点 c；不同才改，改动只在 `scene.ts` 的 fbo 创建处，和 P4–P6 错开。

**验收：**
- 单测：`conditionsHold` 的各种写法；流体 effect 在 `LIGHTING` 0 / 1、`RENDERING` 1 / 3 下的步骤序列、fbo 集合、bind 槽位。
- 流体预览工程（及两个变体）：按 WPE 抓帧的 dt 与光标逐帧回放（kabegame-dev 的时间线），和 WPE 比整帧与模拟 RT（速度、染料）。容差按步骤 0 测出的 WPE 自身逐帧差异定。
- 语料：`3286859278` 不再报四个 effect 键与 `constant:slots`，其余键不变；别的场景与基线逐张相同。

### 步骤 4 — 收尾

- 全语料扫描，与 P7c 基线逐张比；改了 wasm 的话请求夹具重录、Tint 再过一遍。
- 文档：
  - 翻译器 README：`unused` 字段；
  - `cocs/wpe/WPE_SCENE.md`：能力表、材质常量、effect 图三处；
  - 回归与 changelog。
- 本文件与总计划的实施记录。

## 和 P4–P6 的交界

- **共享文件：** 步骤 2、3 改 `compile/features.ts`、`compile/bundle.ts`，步骤 2 还改 `render/scene.ts`。这三个文件现在都有别的会话没提交的改动。做法同 P7b、P7c：
  - 在 HEAD 的产品源码快照里实现、验收（`kbp snapshot export`）；
  - 合进工作区时三方合并，提交时只暂存自己的块（`ignore/p7/stage_hunks.py`）。
- **不碰：** `render/graph.ts`（条件在编译期求值）。`render/state.ts`、`render/uniforms.ts`、`compile/materialValues.ts`、`compile/shader.ts` 现在没有别的会话在改。
- **翻译器 wasm：** 步骤 1 改反射、重建 wasm。WGSL 逐字节不变，别的会话只会看到少报的 `constant:*`。

## 决定

**已定（2026-11-12 用户，按推荐）：**
1. **`executeMaterialFunction`：** 不在 P7d 实现。`functions` 声明按中性放开，脚本调用照报。语料 0 处调用，实现了也没有样本可以和 WPE 比。
2. **同键不同类型：** 照 WPE 读进下一个键的存储（步骤 1 点 3），和 P7b 打包数组越界的取舍一致。只影响 `frame_builder_by_gariam` 开 `REF_RES` 的两张场景。
3. **翻译器反射加 `unused`：** 加。这是 WPE 分配槽位的依据，也去掉了两类假报。只改反射 JSON，WGSL 不变。

**待定：**
4. **流体的验收：** 流体模拟对 dt 与初值敏感，逐像素相同不现实。步骤 0 先测 WPE 自己两次运行的差异，再按它定容差，到时请用户定。

## 风险

1. **流体的逐帧对比：** 模拟 RT 是半精度浮点，多次迭代后误差放大，`g_Frametime` 每帧不同。回放 WPE 的 dt 与光标只能压住输入的差异，压不住浮点实现的差异（Tint 与 fxc 的指令选择不同）。验收可能只能比前几帧加统计量。
2. **「被引用」的判据：** WPE 看的是 fxc 优化之后的反射，我们看 naga IR 里的语法引用。优化能删掉的读（乘 0、结果没被用）两边会不同，这时我们多分配一个槽位，后面的键的槽位和溢读来源就错开了。语料里先统计这种情况有没有。
3. **合并表的遍历顺序：** 如果是按键排序，`Reference resolution` 的下一个键随作者给别的常量起的名字变化。步骤 0 只能用几个构造的名字验证排序规则，推广到语料靠读码。
4. **四个缺口各只有 1–4 张样本，所在场景都还有很多别的键：** 在真实场景里看不到修好的效果，只能靠测试工程和 WPE 比。

## 实施记录

（未开始）
