# P3a — 属性绑定表与快速路径（不含脚本）

> 上级：[PLAN.md](PLAN.md)「P3 — SceneScript」。前置：[phase-3-0c-frame-process.md](phase-3-0c-frame-process.md) 已提交（44f2dd97）。
> 下一步：[phase-3b-script-runtime.md](phase-3b-script-runtime.md)（脚本运行时）、[phase-3c-runtime-graph.md](phase-3c-runtime-graph.md)（做到 WPE 程度的不重编译）。
> 依据：[p3-script-REPORT.md](p3-script-REPORT.md) I 节（I1 入口与时机、I2 哪些会重建、I3 逐类绑定、I7 建议、I10 动态实验）。

## 总体设计思路

现在宿主把用户属性当成编译输入：垫片推来任何变化，`SceneHost` 合并后整场重编译——Worker 重新解析与翻译、渲染器重建整个 GPU 场景，再换上。WPE 不是这样：加载期把每个 `{user}` 绑定登记成「属性名 → 目标对象 + 反射描述符 + condition」，运行时按增量逐键调同一个 setter 就地写字段，再调描述符的改值回调（I3）；只有 effect 可见性、用户纹理、颜色校正这几类才局部重建（I2），材质常量只标脏、重传常量缓冲。P3a 照这个形状做，但先不碰脚本。

做法分三层。**编译**在产出 `SceneBundle` 的同时产出绑定表：编译期每处解析 `{user}` 的地方都登记一条「属性名（可带 condition）→ 目标」，目标是可就地写的五类（图层变换、图层颜色 / 透明度、图层可见性、材质常量、泛光参数）之一，或者一条「需要重编译」及其原因。**宿主**只保留一个应用函数：首次加载传全集、运行时传增量，增量先并进累计全集，再按绑定表分成就地写与重编译两组，有任何一条要重编译就整场重编译（带全集），否则全部就地写。**渲染**新增一个 CPU 侧的场景状态 `SceneState`，就地写落在它上面并标脏；`GpuScene` 每帧在写内置 uniform 之前把脏项刷进对应 draw 的 uniform 块、图层可见性或泛光链参数，一帧之内生效。

几个关键决策：

- **目标用 JSON 坐标做稳定键**（`objects/<i>`、`objects/<i>/effects/<j>/passes/<k>`、`general`），不用 bundle 下标。未启用的 effect 不进 bundle，下标会随属性值移位；3b 的脚本 realm 跨重编译保留，脚本手里的图层对象也要按这个键在新场景里找回。
- **`SceneState` 独立于 GPU。** 它只是数据加脏集合；draw 的 uniform 组装改成纯函数，单测在 Node 里就能核对「就地改值后的 uniform 字节 = 用新值整场重编译得到的字节」，这是本阶段最主要的正确性判据。3b 的脚本写的也是这个状态，P3b 的语料检查因此可以不建 GPU 场景。
- **绑定表的完整性由单测兜底。** 漏登记的后果是「改了没反应」（既不就地写，也不重编译）。单测把编译用的属性表包成 `Proxy`，记下编译期读过的属性名，断言每个都在绑定表里；对本机全部语料各跑一遍。
- **可见性运行时可变。** 绑了 `visible`（含条件可见）的图层即使当前不可见也建 GPU 资源；ops 改成按图层分组，`encode` 跳过不可见图层的全部步骤（包括它的快照）。没有绑定、写死 `false` 的图层照旧不建。
- **就地失败可退回。** 少数就地写可能在 GPU 侧做不了（例如泛光级数变了，金字塔要重排），这时返回「需要重编译」，宿主照重编译路径走，不报错。
- **加载期间到达的增量不丢。** 每次编译记下所用属性的快照；新场景换上后与当前全集比较，差异再走一次应用函数。

范围（已定 7 第一步）：就地 = 材质常量、图层 `origin` / `scale` / `angles`、`alpha`、`color`（`brightness` 是同一组 uniform，顺带）、`visible`（含条件可见）、泛光参数（级数不变时）；仍重编译 = effect `visible`、`hdr`、泛光开关（`general.bloom`）、`colorBlendMode`、`clearcolor` / `ambientcolor` / `skylightcolor` / 相机、泛光级数、`size`（已定 5：不照 WPE 的「运行中改了不生效」）。COMBO 绑用户属性按不支持（已定 8）；用户纹理本来就报 `material:usertextures`，不变。effect 可见性等的不重编译由 3c 完成。

**Kabegame 侧这条链不改。** 读代码的结论：属性面板的滑块每次 `@input` 都更新草稿，但写库是尾随 300 ms 去抖、同一时刻只有一个在途，颜色要在取色器确认后才发；所以拖动过程中不会逐次写库，宿主收到的是停顿 ≥ 300 ms 或松手之后的一次增量。写库后 `image-changed { metadataId }` → 垫片重拉 → 垫片按 `{type, value}` 的 JSON 比较只推变了的键，正是应用函数要的增量。代价是拖动中画面不跟手（WPE 拖动时每帧发一次值），接受（已定 6）。快速路径本身按「逐帧调用」设计（已定 8 末句）：一次就地应用是 O(该键的绑定数) 的 CPU 计算加下一帧每个脏 draw 一次 `writeBuffer`，3b 的脚本每帧写常量也走它。

## 现状锚点

**a. 任何属性变化都整场重编译**（`apps/wpe-scene/src/host.ts:82`）
```ts
  applyUserProperties(changed: Record<string, SceneProperty>): void {
    let dirty = !this.receivedProperties;
    for (const [key, property] of Object.entries(changed)) {
      if (property.type === "group" || property.type === "text") continue;
      if (property.value === undefined || property.value === null) continue;
      if (!Object.is(this.values[key], property.value)) {
        this.values[key] = property.value;   // 现状：只存裸值，丢掉 type
        dirty = true;
      }
    }
    this.receivedProperties = true;
    if (dirty) void this.reload();           // 现状：不管改的是什么，一律重编译
  }
```
```ts
// host.ts:194（reload 内）
      const bundle = await compileSceneInWorker({
        projectDir: target.path,
        sceneAssets: target.sceneAssets,
        userProperties: { ...this.values },  // 现状：属性只作为编译输入
        // …
      });
      // …
      await current.load(bundle, { ignoreUnsupported: force });   // 现状：建整套新 GpuScene 再换上
// host.ts:237
      } else
        this.options.report.debug(          // 现状：重编译只打宿主控制台，应用日志看不到
          `场景壁纸 ${this.options.imageId} 重新加载：${detail}，用时 ${Math.round(performance.now() - started)} ms`,
        );
```

**b. 编译期把 `{user}` 解析成值，不留来源**（`compile/bundle.ts:431`、`:484`；`compile/shader.ts:14`）
```ts
    const layer: SceneLayer = {
      id: object.id ?? bundle.layers.length,
      name: object.name ?? "",
      origin: numbers(resolveValue(object.origin, properties), [0, 0, 0]),   // 现状：值，没有「来自哪个属性」
      // … scale / angles / size / alpha / color / brightness 同样
      visible: resolveValue(object.visible, properties) !== false,
      // …
    };
    // …
      // 未启用的 effect 整步跳过（B11），也不检查它的能力
      if (resolveValue(instance.visible, properties) === false) continue;   // 现状：effect 下标随属性值移位
```
```ts
export function shaderUniforms(result, pass, properties): Record<string, number[]> {
  // …
    const property = Object.entries(pass.usershadervalues ?? {}).find(([, target]) => target === material)?.[0];
    const raw =
      (property ? properties[property] : undefined) ??                       // 现状：usershadervalues 优先
      resolveValue(pass.constantshadervalues?.[material], properties) ??      // 再 constantshadervalues（含 {user}）
      (uniform.meta?.default as SceneScalar | undefined);
    if (raw !== undefined) values[uniform.name] = numbers(raw);               // 现状：只剩 uniform 名 → 值
```
`general` 的 `clearcolor` / `ambientcolor` / `skylightcolor` / 相机、`postprocess.ts` 的 `scenePostprocessState`（`bloom` / `hdr`）与 `bloomParams` 同样只给出解析后的值。

**c. 条件绑定整张退回**（`compile/features.ts:196`、`:246`）
```ts
export function scanValue(value: unknown, unsupported: Set<string>): void {
  // …
  if ("script" in value && !isStaticScript((value as { script: unknown }).script)) unsupported.add("value:script");
  if ("user" in value && typeof (value as { user: unknown }).user === "object") unsupported.add("visible:condition");   // 现状：任何带 condition 的绑定
  for (const v of Object.values(value)) scanValue(v, unsupported);
}
// checkObjectFeatures 末尾对 object.visible 再报一次 visible:condition
```
本机语料（2026-11-03，38 张，`exhaustive`）：报 `visible:condition` 的有 shimmering_particles、工坊 3549863808、3637191856，三张都另有别的阻塞。

**d. GPU 场景只建可见图层，uniform 只在建 draw 时写一次**（`render/scene.ts:239`、`:528`、`:635`）
```ts
    const visible = bundle.layers.filter((layer) => layer.visible && layer.passes.length);   // 现状：不可见图层不建
    const plans = visible.map((layer) => planLayer(layer, bundle.textures));
```
```ts
    // uniform：内置值打底，材质常量 / 用户属性覆盖
    if (program.uniformSize) {
      block = new UniformBlock((program.result.uniforms ?? []) as UniformEntry[], program.uniformSize);
      const matrices = drawMatrices(step, layer, viewProjection);   // 现状：变换、颜色在这里算一次
      const builtins = staticBuiltins({ ...matrices, /* … */ layer, colorScale: /* … */ });
      for (const [name, values] of Object.entries(builtins)) block.set(name, values);
      for (const [name, values] of Object.entries(pass.uniforms)) block.set(name, values);
      frameNames = /* 每帧内置量里没被材质值覆盖的 */;
      // …
      device.queue.writeBuffer(uniformBuffer, 0, block.data);
    }
```
```ts
  /** 写每帧变化的 uniform（`g_Time` 等）。 */
  update(frame: FrameInput): void {
    const values = frameBuiltins(frame);
    for (const draw of this.draws) {
      if (!draw.block || !draw.uniformBuffer || !draw.frameNames.length) continue;   // 现状：静态 draw 永不重写
      for (const name of draw.frameNames) draw.block.set(name, values[name]);
      this.device.queue.writeBuffer(draw.uniformBuffer, 0, draw.block.data);
    }
  }
```
`ops` 是全场一条平铺数组（`private readonly ops: Op[] = []`），不知道哪个 op 属于哪个图层。

**e. 泛光链不保留 uniform 块**（`render/bloom.ts:301`）
```ts
          if (program.uniformSize) {
            const block = new UniformBlock((program.result.uniforms ?? []) as UniformEntry[], program.uniformSize);
            const values = { ...screenBuiltins([width, height]), ...textureBuiltins(/* … */), ...pass.uniforms,
              ...materialUniforms(program, step.constants) };   // 现状：参数在建链时算一次
            // …
            device.queue.writeBuffer(uniformBuffer, 0, block.data);   // 现状：之后没有引用，改不了
            entries.push({ binding: 0, resource: { buffer: uniformBuffer } });
          }
```

**f. 属性面板：草稿逐次更新、写库尾随去抖**（`apps/kabegame/src/composables/useWpeWebProperties.ts:78`、`:125`；`components/common/form/KbNumber.vue:33`、`KbColor.vue:2`）
```ts
  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void flush(activeId);            // 现状：300 ms 内没有新改动才写库；同一时刻最多一个 set_wpe_web_user_properties 在途
    }, 300);
  }
  function set(key: string, value: unknown) {
    draft.value = { ...draft.value, [key]: value };   // 现状：滑块每个 @input 都到这里
    schedule();
  }
```
```vue
<!-- KbNumber.vue：滑块拖动中每步都 emit -->
@input="(v) => onSliderInput(Array.isArray(v) ? v[0] : v)"
<!-- KbColor.vue：取色器确认后才 emit -->
<el-color-picker :model-value="hex" :show-alpha="false" @change="onChange" />
```

**g. 垫片只推变了的键**（`src-tauri/kabegame/src/webview_js/wpe_shim.js:485`）
```js
  function changedUser(prev, next) {
    var out = null;
    Object.keys(next).forEach(function (key) {
      if (JSON.stringify(prev[key]) !== JSON.stringify(next[key])) {   // 现状：按 {type, value} 比较
        (out || (out = {}))[key] = clone(next[key]);
      }
    });
    // …
    return out;
  }
```

## 点 1 — 绑定表（新增 `compile/bindings.ts`；修改 `compile/bundle.ts`、`compile/shader.ts`、`compile/postprocess.ts`、`compile/model.ts`）

- **新增** `compile/bindings.ts`：类型、登记器与取值换算。
```ts
/** 目标的稳定键：scene.json 里的坐标，不随 bundle 下标变（未启用的 effect 不进 bundle）。 */
export type TargetKey = string;   // "general" | "objects/3" | "objects/3/passes/0" | "objects/3/effects/1/passes/0"

/** 目标值的形状：决定字符串 / 数字 / 布尔怎么换成 uniform 分量（3b 的脚本取值、写回也按它换算）。 */
export type ValueType = "float" | "vec2" | "vec3" | "vec4" | "bool" | "angles";

export type LayerField = "origin" | "scale" | "angles" | "alpha" | "color" | "brightness" | "visible";
export type RecompileReason =
  | "effect-visible"      // effect 可见性：未启用的不进 bundle（3c 改为单图层重算）
  | "postprocess"         // general.bloom / general.hdr：泛光链有无、目标格式
  | "general"             // clearcolor / ambientcolor / skylightcolor / camera.*
  | "layer-structure";    // colorBlendMode（passthrough 有无）、size（已定 5：重编译生效）

export type BindingTarget =
  | { kind: "layer"; object: number; field: LayerField }
  | { kind: "constant"; pass: TargetKey; material: string; uniforms: string[]; type: ValueType }
  | { kind: "bloom"; field: keyof BloomParams }
  | { kind: "recompile"; reason: RecompileReason; path: string };

export interface SceneBinding {
  /** 用户属性名。 */
  property: string;
  /** `{user: {name, condition}}`：值换成 `String(当前值) === condition`（I3）。 */
  condition?: string;
  target: BindingTarget;
}

/** 编译期登记：每处解析 `{user}` 的地方调一次，返回解析后的值（与 resolveValue 相同）。 */
export class BindingCollector {
  readonly list: SceneBinding[] = [];
  bind(value: SceneValue | undefined, properties: Record<string, SceneScalar>, target: BindingTarget): SceneScalar | undefined;
}

/** 属性值 → 目标分量（条件先换成布尔）；与编译期 `numbers(resolveValue(…))` 同一规则，单测核对两边一致。 */
export function bindingValue(raw: SceneScalar, condition: string | undefined, type: ValueType | LayerField): number[] | boolean;
```
- **修改** `SceneBundle` / `SceneLayer` / `ScenePass` / `SceneEffect`：
```ts
export interface ScenePass {
  key: TargetKey;          // 新增：本 pass 的稳定键（基础材质 objects/<i>/passes/<k>、effect objects/<i>/effects/<j>/passes/<k>、passthrough objects/<i>/passthrough）
  program: number | null;
  // …其余不变
}
export interface SceneLayer {
  object: number;          // 新增：scene.json 的 objects 下标（稳定键）
  visibleBound: boolean;   // 新增：visible 绑了用户属性（含 condition），运行时可能变，不可见也要建 GPU 资源
  // …其余不变
}
export interface SceneEffect {
  source: number;          // 新增：图层 effects[] 里的下标（JSON 坐标）
  // …其余不变
}
export interface SceneBundle {
  // …
  bindings: SceneBinding[];   // 新增：按登记顺序；同一属性可以有多条
}
```
- **修改** 登记点（`bundle.ts` 的图层、effect、基础 / effect / passthrough pass；`shader.ts` 的 `shaderUniforms`；`postprocess.ts` 的 `scenePostprocessState` / `bloomParams`；`general` 的清屏色、环境光、相机）：
```ts
    const at = (field: LayerField) => ({ kind: "layer", object: index, field }) as const;
    const layer: SceneLayer = {
      object: index,                                                                       // 新增
      origin: numbers(bindings.bind(object.origin, properties, at("origin")), [0, 0, 0]),  // 修改：经登记器
      // … scale / angles / alpha / color / brightness / visible 同样
      size: numbers(bindings.bind(object.size, properties, recompile("layer-structure", `objects/${index}/size`))),
      colorBlendMode: Math.trunc(asNumber(bindings.bind(object.colorBlendMode as SceneValue, properties,
        recompile("layer-structure", `objects/${index}/colorBlendMode`)), 0)),
      visibleBound: isUserBinding(object.visible),                                         // 新增
      // …
    };
    // effect 可见性：仍在编译期跳过未启用的，但登记成重编译
    if (bindings.bind(instance.visible, properties,
        recompile("effect-visible", `objects/${index}/effects/${j}/visible`)) === false) continue;   // 修改
```
```ts
// shader.ts：usershadervalues 与 constantshadervalues 的 {user} 都登记成 constant 目标
export function shaderUniforms(result, pass, properties, key: TargetKey, bindings: BindingCollector) {   // 修改：多两个参数
  // 同一个材质常量名可能对应多个 uniform：先按 meta.material 分组
  // usershadervalues 命中 → bindings.list.push({ property, target: { kind: "constant", pass: key, material, uniforms, type } })
  // constantshadervalues[material] 是 {user} → 经 bindings.bind 登记同样的目标
  // type 由 uniform 的 WGSL 形状（parseShape）与声明类型推出：f32 → float，vec2/3/4 → vecN
}
```
  - 同一属性既在 `usershadervalues` 又在 `constantshadervalues` 时照现在的优先级（前者赢）只登记前者。
  - `general.bloom` / `general.hdr` 登记 `recompile("postprocess")`；`bloom*` 调节项登记 `{ kind: "bloom", field }`；`clearcolor` / `ambientcolor` / `skylightcolor` / `camera.eye|center|up` 登记 `recompile("general")`。
- **修改** COMBO：材质 / effect 实例 `combos` 的值是对象时报 `combo:user-binding`（`checkPassFeatures` 与 effect 实例 pass 各一处），不再把对象交给翻译器。WPE 遇到会断言中止整个进程（I3、I10 第 5 步），本机 0 处。
- **修改** `compile/protocol.ts` 无需改：`bindings` 是纯数据，随 bundle 结构化克隆。

## 点 2 — 场景状态 `SceneState`（新增 `render/state.ts`）

- **新增** CPU 侧可变状态与脏集合，不依赖 GPU：
```ts
export interface LayerState {
  origin: number[]; scale: number[]; angles: number[];   // angles 为弧度（同 scene.json）
  alpha: number; color: number[]; brightness: number; visible: boolean;
}
export type WriteResult = "applied" | "recompile";

export class SceneState {
  /** 按 objects 下标；只含进了 bundle 的图层。 */
  readonly layers = new Map<number, LayerState>();
  /** pass 稳定键 → 材质常量覆盖（uniform 名 → 分量）；起始值 = 编译期的 pass.uniforms。 */
  readonly constants = new Map<TargetKey, Record<string, number[]>>();
  bloom: BloomParams;

  static fromBundle(bundle: SceneBundle): SceneState;

  /** 一条绑定的写入；目标不在当前 bundle 里（如被排除的 effect）返回 "applied" 且不做事，重编译类目标返回 "recompile"。 */
  write(binding: SceneBinding, raw: SceneScalar): WriteResult;

  /** 渲染器每帧取走脏项。 */
  takeDirty(): { layers: Set<number>; passes: Set<TargetKey>; bloom: boolean };
}
```
  > 说明：3b 的脚本写回与 `thisLayer` / `thisObject` 的 setter 复用 `write` 的目标形状（只是值不经 `bindingValue` 而按 3b 的返回值规则换算）。

## 点 3 — draw 的 uniform 组装改纯函数，GPU 场景按状态刷新（`render/uniforms.ts`、`render/scene.ts`、`render/bloom.ts`）

- **新增**（`uniforms.ts`）组装函数，`createDraw` 与就地刷新共用：
```ts
/** 一个绘制步骤的全部静态 uniform：内置值（变换、颜色、纹理尺寸…）打底，材质常量覆盖。 */
export function drawUniformValues(input: {
  step: Pick<DrawStep, "role" | "inputs">;
  layer: LayerState & { size: number[] };
  constants: Record<string, number[]>;       // SceneState.constants.get(pass.key)
  viewProjection: Mat4; colorScale: number; screenSize: [number, number];
  textures: readonly (TextureSize | undefined)[]; eye: readonly number[];
  ambient?: readonly number[]; skylight?: readonly number[];
}): Record<string, number[]>;
```
- **修改**（`scene.ts`）`GpuScene`：
```ts
interface LayerRuntime {
  object: number;           // 新增：稳定键
  ops: Op[];                // 修改：原全场平铺的 ops 按图层分组；泛光 op 单独放在最后
  draws: Draw[];
}
interface Draw {
  // …
  passKey: TargetKey;       // 新增
  dirty: boolean;           // 新增：静态 uniform 被就地改过，下一次 update 要整块重写
}

  private async populate(bundle: SceneBundle, state: SceneState, warnings: string[]): Promise<void> {
    // 修改：可见的、或 visibleBound 的图层都建（后者当前可能不可见）
    const built = bundle.layers.filter((layer) => (layer.visible || layer.visibleBound) && layer.passes.length);
    // …createDraw 改调 drawUniformValues(…state.layers.get(layer.object)…, state.constants.get(pass.key) ?? {})
  }

  /** 新增：泛光参数能否就地改（级数不变）；其它目标都能。 */
  canApply(params: BloomParams): boolean;

  /** 新增：把 SceneState 的脏项刷进 uniform 块 / 泛光链。 */
  sync(state: SceneState): void {
    const dirty = state.takeDirty();
    for (const object of dirty.layers)
      for (const draw of this.drawsOfLayer(object)) this.refresh(draw, state);   // 只重写变换 / 颜色那组名字，跳过被材质值覆盖的
    for (const key of dirty.passes)
      for (const draw of this.drawsOfPass(key)) this.refresh(draw, state);
    if (dirty.bloom) this.bloom?.setParams(state.bloom);
  }

  update(frame: FrameInput): void {
    // 修改：frameNames 非空 或 dirty 时整块写；写后清 dirty
  }

  encode(encoder: GPUCommandEncoder, state: SceneState, afterBloomStep?): void {
    for (const layer of this.layers) {
      if (!state.layers.get(layer.object)?.visible) continue;   // 新增：不可见图层整段跳过（含它的快照）
      for (const op of layer.ops) /* 原逻辑 */;
    }
    // 泛光 op 照旧在最后
  }
```
  - `checkRenderable` 同样检查 `visibleBound` 的不可见图层（它们随时可能显示）。
  - 只重写变换 / 颜色相关的名字：`g_ModelViewProjectionMatrix(Inverse)`、`g_ModelMatrix(Inverse)`、`g_NormalModelMatrix`、`g_ViewProjectionMatrix`、`g_Effect*`、`g_Color` / `g_Color4` / `g_Alpha` / `g_UserAlpha` / `g_CompositeColor`；`pass.uniforms` 里有的名字一律不动（例如 passthrough 的 `g_Color4 = (1,1,1,1)`、材质自带的 `g_UserAlpha`）。
- **修改**（`bloom.ts`）`BloomChain`：
```ts
interface BloomDraw {
  // …
  block: UniformBlock | null;          // 新增：保留，供改参数
  uniformBuffer: GPUBuffer | null;     // 新增
}
  /** 新增：HDR 级数（bloomIterations）是否不变。 */
  sameLevels(params: BloomParams): boolean;
  /** 新增：按新参数重算常量并重写各 pass 的 uniform（调用方已确认级数不变）。 */
  setParams(params: BloomParams): void;
```

## 点 4 — 渲染器接口（`render/renderer.ts`）

- **修改** `SceneRenderer`：
```ts
  private state: SceneState | null = null;   // 新增：当前场景的状态，load 时由 bundle 建

  async load(bundle: SceneBundle, options: SceneLoadOptions = {}): Promise<void> {
    const state = SceneState.fromBundle(bundle);                                   // 新增
    const scene = await GpuScene.build(this.gpu.device, bundle, state, /* … */);   // 修改：传 state
    // …换上时 this.state = state
  }

  /**
   * 新增：就地应用一批绑定写入；需要重编译时返回 false（调用方整场重编译）。写之前先问 GPU 场景能不能做
   * （`scene.canApply`：泛光的 `hdrIterations` 改变级数时不能），做不了就一条都不写。暂停时补画一帧（同 resize），画面立即反映。
   */
  applyBindings(writes: { binding: SceneBinding; value: SceneScalar }[]): boolean;

  private render(): void {
    // …
    scene.sync(this.state!);                 // 新增：刷脏项（能不能做已在 applyBindings 里判过）
    scene.update({ /* frame builtins */ });
    // …encode 传 state
  }
```

## 点 5 — 宿主的应用函数（`host.ts`）

- **修改** 属性入口：一个应用函数，加载传全集、运行时传增量（I7 第 1 条）。
```ts
  /** 累计全集（I1 的 +0x1728）：键 → { type, value }；保留 type，不学 WPE 的整项覆盖（I4）。 */
  private readonly properties = new Map<string, SceneProperty>();     // 修改：原 values 只存裸值
  /** 当前场景编译时用的裸值快照；场景换上后与全集比较，补上加载期间到达的增量。 */
  private compiledWith: Record<string, unknown> = {};
  private bundle: SceneBundle | null = null;                          // 新增：取绑定表

  applyUserProperties(changed: Record<string, SceneProperty>): void {
    this.apply(changed);                                              // 修改：垫片入口只转调
  }

  private apply(delta: Record<string, SceneProperty>): void {
    const changes = mergeProperties(this.properties, delta);          // 新增：返回值真正变了的键（跳过 group / text / 空值）
    if (!this.receivedProperties) { this.receivedProperties = true; void this.reload(); return; }   // 首包 = 全集
    if (!changes.size || this.state !== "ready" || !this.bundle) return;   // 加载中：落地后按 compiledWith 补
    const plan = planApply(this.bundle.bindings, changes);            // 新增：{ writes, recompile: { key, reason }[] }
    if (plan.recompile.length || !this.renderer?.applyBindings(plan.writes)) {
      this.options.report.debug(`场景壁纸 ${this.options.imageId} 重新编译：${describe(plan)}`);   // 修改：带键与原因；保持 debug（已定 8），是否走快速路径看探针 stats()
      void this.reload();
      return;
    }
    this.options.report.debug(`场景壁纸 ${this.options.imageId} 就地更新：${[...changes.keys()].join(",")}`);
  }
```
  - `reload()` 成功换上场景后：`this.bundle = bundle`，按 `compiledWith` 与当前全集的差异再调一次 `apply`（这时状态已是 ready）。
  - 没有任何绑定引用的属性（只给脚本用、或作者声明了却没绑）：P3a 什么都不做，不再重编译。
- **新增**（`compile/bindings.ts`）纯函数 `mergeProperties` / `planApply`，单测覆盖分类。

## 点 6 — 能力表（`compile/features.ts`）

- **删除** `scanValue` 与 `checkObjectFeatures` 里的 `visible:condition`。
- **新增** `combo:user-binding`（点 1）。
- `value:script` 与 `isStaticScript` 不动（3b 删）。

## 点 7 — Kabegame 侧属性面板与垫片

- 不改，理由见总体设计思路末段与现状锚点 f / g：拖动不逐次写库；垫片推的是带 `type` 的增量。
- 在 `cocs/wpe/WPE_SCENE.md` 写明「面板写库尾随 300 ms 去抖，拖动中场景不跟手；宿主快速路径能扛逐帧调用」。

## 点 8 — dev 探针（`dev/install.ts`、`dev/probe.ts`、`main.ts`）

- **修改** `installSceneDevProbe(host)`：探针拿到当前 `SceneHost`，新增
```ts
  host: {
    /** 当前 SceneState 的快照（图层、常量、泛光参数）与绑定表。 */
    state(): unknown;
    /** 计数：就地应用次数、重编译次数（含原因），以及 render() 的 CPU 用时统计（均值 / p95，最近 600 帧）。 */
    stats(): { applied: number; recompiled: { reason: string; keys: string[] }[]; frameMs: { mean: number; p95: number } };
    /** 按固定 g_Time 渲染**当前**场景（含就地改过的状态）并读回、给 SHA-256，与 renderFrame 的整场重编译结果对比。 */
    renderFrame(time: number): Promise<{ sha256: string; width: number; height: number }>;
  },
```

## 点 9 — 文档、回归与 changelog

- `cocs/wpe/WPE_SCENE.md`：
  - 「编译管线」的 bundle 字段表加 `bindings`，pass 的 `key`、图层的 `object` / `visibleBound`；
  - 「能力表」删 `visible:condition`、加 `combo:user-binding`；
  - 「渲染器」加 `SceneState`、按图层分组的 ops、`sync`；
  - 「场景宿主」改写属性入口：应用函数、就地 / 重编译分类与重编译原因表、加载期间增量的补差、面板去抖与跟手问题；
  - `cocs/README.md` 的 WPE_SCENE 条目摘要同步一句。
- `versions/latest/regression.md` 新增「场景壁纸 P3a：属性绑定与快速路径」小节，用例见验收。
- `versions/latest/changelog.md` 用户侧 Optimized 一行：「场景壁纸改颜色、透明度、位置、滑块类属性时即时生效，不再整场重新加载；按属性条件显示 / 隐藏的图层也能正确切换」。

## 实施步骤

每步都能单独验收；codex 只改仓库内文件，独立验收时先 `git status` 查越界，不采信自报。

**步骤 0 — 基线**（Claude）：dev 主窗口经探针 `renderFrame` 记下 eagleflag / deep_space / beach / razer_vortex 与 razer_bedroom（强制渲染）在固定 `g_Time` 下的 SHA-256（关闭档），存 `ignore/p3a/baseline.txt`。

**步骤 1 — 绑定表**（codex：点 1、点 6）
- 验收：新单测通过（见验收「单测」1–3）；语料测试照跑，`unsupported` 的变化只有：shimmering_particles、3549863808、3637191856 少了 `visible:condition`；没有新出现的 `combo:user-binding`；解锁名单不变。

**步骤 2 — `SceneState` 与 uniform 组装纯函数**（codex：点 2、点 3 的 `drawUniformValues`）
- 验收：单测 4–5；`createDraw` 改用 `drawUniformValues` 后基线哈希逐字节不变。

**步骤 3 — GPU 场景按图层分组、可见性跳过、`sync` 与泛光 `setParams`**（codex：点 3 其余、点 4）
- 验收：基线哈希逐字节不变；单测 6。

**步骤 4 — 宿主应用函数与探针**（codex：点 5、点 8）
- 验收：单测 7–8；`check-kabegame` 与宿主 `typecheck` 0 error；`deno task test -c kabegame --skip cargo` 两个前端目录全过。

**步骤 5 — 真机验收**（Claude 经 CDP；需要的窗口状态由用户摆好，不改用户的壁纸设置）：见验收「真机」。

**步骤 6 — 文档**（codex：点 9；Claude 填实测数值并核对文档与代码一致）。

## 验收

**单测**（`apps/wpe-scene`）
1. 绑定表生成（本机语料，`KABEGAME_WPE_ROOT`）：
   - razer_vortex：`ui_editor_properties_brightness` / `_length` / `_speed` 各自登记到对应图层 tint pass 的 constant 目标（brightness 两层、length 两层、speed 三层）；
   - razer_bedroom：`light_speed` 登记 17 条（9 个 scroll pass 的 `speedx`、8 个的 `speedy`，以 JSON 为准），全部 constant；
   - eagleflag：材质 `usershadervalues` 的三条（`flagcolor1` → `color2`、`flagcolor2` → `color3`、`schemecolor` → `color1`）登记到 flag pass；
   - shimmering_particles：`style` 5 条带 condition 的 layer visible、`backgroundcolor` 一条 layer color、`glow` 一条 `bloom.hdrStrength`。
2. **完整性**：对每张语料场景，编译时把属性表包成 `Proxy` 记下读到的属性名，断言都在 `bundle.bindings` 里（就地或重编译）。
3. 取值换算：`bindingValue` 与编译期 `numbers(resolveValue(…))` 对数字、`"r g b"`、布尔、condition 逐项相同；COMBO 写成对象报 `combo:user-binding`。
4. **就地 = 重编译（字节级）**：对 vortex 的 brightness、eagleflag 的 `flagcolor1`、一个合成用例的 origin / angles / color / alpha，「旧值编译 → `SceneState.write(新值)` → `drawUniformValues`」得到的每个 draw 的 uniform 块，与「用新值整场编译 → `drawUniformValues`」逐字节相同；passthrough 的 `g_Color4` 与材质自带 `g_UserAlpha` 不被覆盖。
5. 条件可见：`style` 由 `"0"` 改 `"1"`，object 0 不可见、1–4 可见；改回复原；condition 为数字时按 `String(值)` 比较。
6. 可见性与泛光：`encode` 对不可见图层不发任何 pass（用假编码器计数），包括它的快照；`BloomChain.sameLevels` 在级数变化时为 false、`applyBindings` 随之返回 false 且一条都不写，级数不变时 `setParams` 重写的常量与重新建链相同。
7. 分类：`planApply` 对每类目标给出就地 / 重编译——effect visible、`general.bloom`、`general.hdr`、`colorBlendMode`、`clearcolor` / `ambientcolor` / `skylightcolor` / 相机重编译；材质常量、图层五类、泛光参数就地；没被引用的属性两者都不是。
8. 加载期间的增量：首包加载未完成时再来一条增量，场景换上后补应用（就地或重编译各一例），最终状态与「一次性用最终全集编译」相同。

**真机**（Windows dev，主窗口预览；壁纸窗口为窗口模式时一并验，不是就记未测）
- eagleflag：属性面板改 `flagcolor1` / `flagcolor2` / `schemecolor`，旗帜颜色跟着变；探针 `stats().applied` 增加、`recompiled` 不增加（重编译日志是 debug、不进应用日志，以探针计数为准）。
- razer_vortex：改亮度、长度、速度，画面跟着变、不重新编译；切「模式」照旧不变色（脚本要 3b），也不重新编译。
- razer_bedroom（dev 强制渲染）：改 `light_speed`，灯带滚动速度跟着变、不重新编译。
- shimmering_particles（dev 强制渲染）：切 `style`，按条件显隐的图像层随之切换、不重新编译（粒子本身不画，P4）。
- **就地 = 重编译（真机）**：vortex 就地改亮度后，探针 `host.renderFrame(t)` 的哈希等于以同一属性值走 `renderFrame` 整场编译的哈希。
- **逐帧调用**：CDP 在宿主 frame 里以 rAF 频率连续 10 s 调 `wallpaperPropertyListener.applyUserProperties({ ui_editor_properties_brightness: { type: "slider", value } })`（值来回变），记录：宿主 rAF 与 `GPUQueue.submit` 次数（预期与不调用时相同，约 144.5 / 60 次每秒）、`stats().frameMs` 的均值与 p95、重编译次数为 0。测完调回原值。
- **仍重编译的类别**：找一张有 effect visible 用户绑定且能渲染的场景（本机默认样本没有，见风险 4）——没有就用单测 7 代替，真机记未测。
- 面板实际拖动：拖 vortex 亮度滑块不停顿，松手后数据库只新增一行 metadata（`metadataId` 只变一次），宿主只收到一次增量。
- 不回归：未改属性时基线五张的哈希与步骤 0 相同；预览暂停时就地改值画面也更新（补画一帧，`g_Time` 不动）。

## 风险

1. **漏登记**：编译期某处读了属性却没登记，改了既不就地写也不重编译。完整性单测（验收 2）覆盖本机语料；新增读取点时必须同时登记，写进 WPE_SCENE.md 的约定。
2. **不可见图层也建资源**：`visibleBound` 的图层（如 shimmering 的 4 个备选层）会多建合成 RT、fbo 与管线，纹理本来就全量上传（`scene.ts` 现在对全部 `bundle.textures` 上传）。显存增量记进回归表。
3. **就地与重编译语义分叉**：内置 uniform 的取值散在 `staticBuiltins`、`drawMatrices` 与 `pass.uniforms` 覆盖三处，就地刷新漏了任何一处都会与重编译不同。字节级对比（验收 4 与真机哈希）是主判据。
4. **样本覆盖**：本机能实时渲染的默认样本没有 effect visible、`general.bloom` 的用户绑定；这几类只能靠单测。可选用 I10 的 `kbprops-test` 工程（已存到 `ignore/p3-userprops/dyn-test/kbprops-test`，含颜色 / 透明度 / 条件可见 / 位置 / 尺寸 / effect 可见与常量 / 脚本属性 / 泛光）拷到 `ignore/p3a/`、在 Kabegame 里「添加壁纸目录」导入，对照 I10 的 WPE 现象逐项验；工程用 WPE assets 的 tint，不进仓库。
5. **拖动不跟手**：面板 300 ms 去抖，场景在停顿或松手后才变，与 WPE 不同；已接受（已定 6）。

## 已定（2026-11-03 用户）

1. 属性快速路径分两步，本阶段是第一步：材质常量、图层变换、`alpha`、`color`、`visible`（含条件可见）、泛光参数直接改值、不重编译；effect 可见性、纹理、`hdr`、泛光开关等仍重编译。第二步见 3c。
2. 默认照 WPE（报告 D / I 节）：运行时与首次加载走同一个应用函数，加载传全集、运行时传增量；改属性只传变化项、按 `type` 转换；两帧之间处理、下一帧生效；COMBO 绑用户属性按不支持；拖滑块时 WPE 每帧发一次值且不去重，快速路径要扛得住逐帧调用。
3. 不照搬 WPE 实验暴露的缺陷：全集保留 `type`、不因增量没给就丢掉内置键（I4）。
4. 推翻 D10 的部分（脚本静态规则）在 3b 执行；P3a 不动 `value:script`。
5. **`size` 绑定改了要生效**（2026-11-03 用户）：WPE 运行中改 `size` 画面不变、下次加载才生效（I3、I10 4d），这是 WPE 的问题，不照搬；按 `layer-structure` 登记，改了就重编译。
6. **拖动不跟手**（同上）：面板保持 300 ms 去抖写库，不加不落库的实时预览通道，以后也不单开阶段。
7. **宿主侧去重保留**（同上）：垫片已按 JSON 去重，宿主再按 `Object.is` 去一次；对绑定幂等，3b 的脚本也不会收到重复的 `applyUserProperties`。
8. **重编译日志保持 `debug`**（同上）：用户不关心这类细节；验收看探针 `stats()` 的 `applied` / `recompiled` 计数，不看应用日志。

## 待定（附推荐）

（无：原 1–4 已于 2026-11-03 由用户定为上面的已定 5–8。）

## 后续

- 3b：脚本运行时；`value:script` 删除；脚本写回与 `thisLayer` / `thisObject` 复用本阶段的目标与 `SceneState`；重编译时保留脚本状态并把脚本写过的值重放到新状态上。
- 3c：effect 可见性单图层重算、泛光开关与级数、清屏色 / 环境光 / 相机就地，重编译只剩档位与 `hdr` 等少数情况。
- 之后各 Phase 新增的可绑定属性（粒子 `instanceoverride`、文本、声音音量……）一律先登记绑定目标并给出就地处理，不再走重编译。

## 实施记录（2026-11-03）

- **点 1**：新增 `compile/bindings.ts`（`TargetKey` / `ValueType` / `LayerField` / `RecompileReason` / `BindingTarget` / `SceneBinding` / `BindingCollector` / `bindingValue` / `mergeProperties` / `planApply` / `pendingChanges` / `describeApply` / `isUserBinding` / `valueTypeOf`）。`bundle.ts` 的 `general`（清屏色、相机、环境光、天光）、图层七类字段、effect 可见性、基础 / effect / passthrough pass、`shader.ts` 的材质常量、`postprocess.ts` 的泛光开关 / HDR / 泛光参数全部经登记器；`SceneBundle.bindings`、`ScenePass.key`、`SceneLayer.object` / `visibleBound`、`SceneEffect.source` 按计划加上。
- **点 2**：新增 `render/state.ts`（`SceneState` / `LayerState` / `writeBloomParam` / `previewBloom` / `takeDirty`）。
- **点 3**：`drawMatrices` 挪进 `render/uniforms.ts` 并新增 `drawUniformValues`、`LAYER_UNIFORMS`、`layerRefreshNames`；`GpuScene` 的 ops 按图层分组（泛光单独在最后）、`visibleObjects` 决定本帧执行的图层、`sync` / `refreshLayer` / `refreshPass` / `canApply` / `update` 的 dirty 整块重写；`BloomChain` 保留 uniform 块并新增 `sameLevels` / `setParams`。
- **点 4**：`SceneRenderer` 持 `SceneState`，`applyBindings`（先过 `canApply`，一条不能就一条不写）、`render()` 里 `sync` → `update` → `encode(state)`、暂停时补画一帧、`frameCosts` 供探针统计。
- **点 5**：宿主累计全集 `properties`（保留 `type`）、`apply` → `applyChanges` → `planApply` → `applyBindings`，重编译保持 `debug` 日志（带键与原因）；`compiledWith` + `pendingChanges` 补加载期间的增量；没有任何绑定引用的属性不动作；`stats` 记 `applied` / `recompiled`。
- **点 6**：`visible:condition` 从 `scanValue` 与 `checkObjectFeatures` 删除；`combo:user-binding` 在 `checkPassFeatures`（合并后的 pass）与 `checkEffectFeatures`（实例覆盖）各一处；`ShaderCompiler.compile` 另外过滤掉对象 COMBO，绝不交给翻译器。
- **点 8**：`installSceneDevProbe(host)` 增加 `host.state()` / `host.stats()` / `host.renderFrame(t)`。
- **与计划的差异**：
  - `size` 按已定 5 登记 `layer-structure`（重编译生效），不照 WPE。
  - `resolveValue` 的 condition 比较改成两边 `String(...)`（原先 condition 写成数字时恒 false）；`bindingValue` 与它规则一致。
  - `scenePostprocessState` 不再因档位不是超高而跳过 `general.hdr` 的求值，否则该绑定会漏登记。
  - 为无 GPU 的单测抽出 `visibleObjects`、`layerRefreshNames` 两个纯函数；泛光用桩设备（`GPUBufferUsage` / `GPUTextureUsage` 也打桩）核对 `setParams` 与重新建链的字节。
  - 完整性检查用 `model.ts` 的 `observePropertyReads`：`currentProperties` 返回属性表的 `Proxy`，`p3a.test.ts` 记下编译期读过的名字。生产不装观察者，恒为 null。
- **测试**：新增 `src/compile/p3a.test.ts`（绑定表生成 / 全语料完整性 / 取值换算 / COMBO / `mergeProperties` / `planApply`）与 `src/render/p3a.test.ts`（合成用例与 vortex / eagleflag 的「就地 = 重编译」字节比、passthrough 的材质值优先、条件可见、可见性跳过、`checkRenderable`、泛光脏项与 `setParams`、加载期间增量）。`apps/wpe-scene` 全量 **167 项通过**（含 38 张语料，`KABEGAME_WPE_ROOT`）；`typecheck` 0 error；prod / dev 两种模式 Vite 构建通过。
- **语料变化**（`exhaustive`，38 张）：shimmering_particles、3549863808、3637191856 少了 `visible:condition`；解锁名单不变（eagleflag / deep_space / beach / razer_vortex 仍为空，razer_bedroom 仍只剩 `value:script`）；没有新出现的 `combo:user-binding`。
- **未做（2026-11-03 用户指示：不走回归、只写 changelog）**：步骤 0 的基线哈希与步骤 5 的真机验收（`host.stats()` 的 `applied` / `recompiled`、`host.renderFrame(t)` 与整场重编译的哈希对比、逐帧调用与拖动去抖实测）留待下次真机；`versions/latest/regression.md` 未加小节；用户侧 changelog 已加一行（Optimized）。（同日稍后已补做，见下条。）
- **退回路径回归（主会话修复）**：初版 `apply()` 在场景退回预览图后没有 bundle，增量被直接丢掉，改了属性也不会重新判定能否渲染；加载以退回告终时，编译期间并进全集的增量同样丢失。修复：`state === "fallback"` 时任何变化都整场重编译一次；`fallbackAfterLoad` 在退回后比较 `compiledWith` 与当前全集，有差异就按新全集再编译一次（第二次用的就是当前全集，不循环）。单测 `src/host.test.ts`。
- **真机验收（2026-11-03，Windows dev，主窗口预览，详见 `versions/latest/regression.md`「场景壁纸 P3a」）**：
  - 步骤 0 基线：提交 44f2dd97 的宿主经 `git archive` 解到 `ignore/p3a/base/` 构建后，用旧探针按 `g_Time` 3.25 s 渲染五张（bedroom 强制），存 `ignore/p3a/baseline.txt`；「场景后处理」为跟随 WPE（解析为关闭档）。工作区构建下五张 × 五组参数共 25 个哈希逐字节相同；`host.renderFrame(t)` 与整场编译相同。
  - 就地写：eagleflag 三个 `usershadervalues`、vortex 亮度 / 长度 / 速度、bedroom `light_speed`（强制）、shimmering `style` / `backgroundcolor` / `glow`（强制）全部就地，`recompiled` 为 0，`host.renderFrame` 与同值整场编译逐一相同；shimmering `style: "1"` 的就地结果还与改动前整场编译相同。暂停时每次写入恰好补画一帧，`g_Time` 冻结（相隔 40 s 的两帧逐像素相同）。
  - 面板拖动（CDP 合成鼠标）：连续拖 4.3 s 只写一次库、宿主一个增量（松手后 284 ms）；中途停 3 次则 4 次写入，各在停下后约 0.26–0.29 s。逐帧调用 10 s（1440 次）rAF / 提交与不调用时相同，单次调用 CPU 均值 0.06 ms；帧 CPU 均值 0.13 → 0.14 ms。
  - 退回路径：退回预览图的 bedroom 改一项只重编译一次、仍退回、不循环；连写两次时加载中到达的增量在退回后又补编译一次后停止（修复生效）。「关掉 effect 就能渲染」的样本本机没有，由单测覆盖。
  - 未测：重编译类属性（能渲染的样本里没有，有的 7 张工坊场景强制也建不出 GPU 场景）；壁纸窗口（本次没有壁纸窗口 target）。
  - 发现：`stats().applied` 按批计数，只改了没有绑定的键（vortex「模式」）也 +1（读代码：`applyBindings([])` 返回 true，暂停时也会补画一帧，未实测）；`stats().recompiled` 不记退回状态下的重编译与退回后的补编译，那两种要看宿主控制台 / 应用日志的「退回预览图」warn。已在 `cocs/wpe/WPE_SCENE.md` 的「属性与快速路径」写明。

