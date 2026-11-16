# L1 — 编译会话与对象片段（子计划）

> 上级：[../phase-live-scene.md](../phase-live-scene.md)「L1」。前一步 [phase-l0-baselines.md](phase-l0-baselines.md)：编译产物摘要两遍 233 张全同（`ignore/live/l0/bundle-base-1.json`）。
> 字段清单出自 P6d4 盘点 `ignore/p6/d4/inventory.md` §1、§2、§6、§7。行号以函数名为准。
> 在主工作区做（2026-11-16 用户：其他工作都已停下），不开独立工作树。

## 总体设计思路

这一步是纯重构加两个新函数，产品行为不变：宿主照旧调 `compileScene`，Worker 照旧一次性编整场。

**会话就是现在 `compileScene` 的闭包作用域。**
- `openCompileSession(input)` 的函数体，就是现在 `compileScene` 从开头到对象循环之前的全部代码，加上全部内部函数。原样不搬，只改三处：
  - 对象循环体包成内部函数 `compileOne(index)`，`continue` 改 `return`；
  - 循环之后的收尾包成 `finalize()`；
  - 返回一个会话对象，而不是 bundle。
- `compileScene` 变成三行：开会话 → 逐个 `compileObject` → `finalize`。
- 全库编译产物必须和 L0 基线逐字节相同，这是本步的第一个判据。

**运行中编一个对象：`compileFragment`。** 只能在 `finalize` 之后调。它把新对象放进会话的 `scene.objects`，按整场编译的顺序做一遍单对象版的收集：
1. 脚本（带绑定）；
2. 灯；
3. 关键帧；
4. 能力检查；
5. `compileOne`；
6. 收尾里和这个对象有关的部分。

然后按调用前后各表的长度切出两样东西：
- 片段（`ObjectFragment`，这个对象自己的产物）；
- 增量（`FragmentDelta`，只增的场景级表：程序、纹理、用户纹理来源、场景级绑定、资源路径）。

会话的表会继续增长：整场 bundle 交出去之后，`compileFragment` 还会往同一批数组里追加。L2 起 bundle 经 Worker 结构化克隆、和会话分开；L1 里只有测试调 `compileFragment`，测试要先取完整场的摘要再编片段。

**片段只装和位置无关的东西。** 组归属、组的子树、挂点、灯的遗留槽位都取决于对象在运行中的父链与别的对象，由 L3 的运行时派生量现算，片段里一律是空值：
- `group: null`；
- `subtree: []`；
- 没有 `attachment`；
- 灯 `legacySlot: -1`；
- effect 的 `unsupported` 里没有 `GROUP_CHILD_FRAMEBUFFER`。

这样同一个配置在任何位置的片段都一样，片段缓存（L5）才能按规整配置命中。

**两条路互为判据。** 同一个配置的片段有两种来源：
- `compileFragment` 真编；
- `rekeyFragment(fragmentOf(bundle, i), 新下标)`，从整场 bundle 里取出来再改键，也就是 P6d4 的克隆。

两者是两份独立实现，在全语料上逐字段相等，就同时验证了「会话能编单对象」和「改键没漏字段」。改键的字段清单不靠人工列全，靠这个对照兜底。

**不支持项与场景级不变量。**
- 会话的 `unsupported` 被 `ShaderCompiler`、`EffectIssues`、文本、体积光等处直接持有，换不掉。所以把它做成「能记录的 Set」：`compileFragment` 期间每次 `add` 都另记一份，编完把这次新增、调用前没有的键从会话里删掉。之后编片段不受影响，`settled()` 也不会误判。
- 会翻转场景级不变量的情况记进 `sceneFlips`，由宿主整场重载（L5）。会话这边只负责判，不修。包括：
  - 用了 `getEffect` 而场景没有 `usesEffectAccess`；
  - 模型读反射图而场景没有平面反射；
  - 读 mip 帧缓冲；
  - 第一次出现光照 / 遗留灯程序；
  - 会画的体积光灯。

## 现状锚点

**a. `compileScene` 的开场与对象循环**（`compile/bundle.ts` `compileScene`）
```ts
export async function compileScene(input: CompileSceneInput): Promise<SceneBundle> {
  const fs = new SceneFs(input.projectDir, input.sceneAssets, input.reader);
  const unsupported = new Set<string>();                 // 现状：被 ShaderCompiler / EffectIssues / compileText 等直接持有
  const bindings = new BindingCollector();
  …
  const properties = currentProperties(project, input.userProperties ?? {});   // 现状：const，闭包读它
  const scripts = await collectScripts(scene, properties, bindings.list);      // 现状：整场一次收全部脚本
  const animations = collectAnimations(scene);                                  // 现状：整场一次
  checkScriptFeatures(scripts.list, unsupported, scene.objects);
  checkSceneFeatures(scene, unsupported);                                       // 现状：内部逐对象 checkObjectFeatures
  …
  const lightObjects = compileLightObjects(scene.objects, (value, object, field) => bindings.bind(…), unsupported);
  …（约 1400 行内部函数：getTexture、compilePass、compileEffect、compileImageModel、compileParticle…）
  const progressTotal = …;
  let progressDone = 0;
  for (const [index, object] of scene.objects.entries()) {
    if (settled()) break;
    if (!isSceneObject(object)) continue;
    input.onProgress?.(progressDone, progressTotal);
    progressDone += progressWeight(object);
    …                                                    // 现状：约 280 行循环体，多处 continue
  }
  input.onProgress?.(progressTotal, progressTotal);
  // 现状：收尾约 150 行——挂点、子表与 assignGroups、组内问题、反射、体积光、泛光、动画层字段脚本过滤、unsupported、audio、media
  return bundle;
}
```

**b. 单对象收集现状**
```ts
// compile/scripts.ts：已有单对象同步版（P6d3b），bindings 缺省 []，运行时调用时不登记
export function collectObjectScriptsSync(object, index, properties, bindings: SceneBinding[] = []): SceneScript[];
// compile/animations.ts：只有整场版；联动只在同一属主内（属主属于一个对象），可以按对象拆
export function collectAnimations(scene: SceneJson): CollectedAnimations;
// compile/lights.ts：只有整场版；legacySlot 按 objects 顺序取第一个空槽
export function compileLightObjects(objects, bind, issues?): SceneLightObject[];
// compile/features.ts：整场版内部逐对象调 checkObjectFeatures(object, unsupported, parent)，透视场景另调 perspectiveObjectIssues(object)
export function checkSceneFeatures(scene: SceneJson, unsupported: Set<string>): void;
```

## 点 1 — `compileScene` 拆成会话（`compile/bundle.ts`）

- **新增**
```ts
/** 编译会话（L1）：`compileScene` 的闭包作用域。整场编译 = 开会话 → 逐个 `compileObject` → `finalize`；之后可以反复 `compileFragment`。 */
export interface SceneCompileSession {
  /** 开会话时 `scene.objects` 的项数（含运行中建的、被删的置 null） */
  readonly objectCount: number;
  /** 已确定退回且不列全时为真：整场编译的循环在这里停 */
  settled(): boolean;
  /** 编一个对象（原循环体），并按原样报进度 */
  compileObject(index: number): Promise<void>;
  /** 原收尾，只调一次；之后才能 `compileFragment` */
  finalize(): Promise<SceneBundle>;
  /** 点 2 */
  compileFragment(request: FragmentRequest): Promise<FragmentDelta>;
}
export async function openCompileSession(input: CompileSceneInput): Promise<SceneCompileSession>;
```
- **修改**
```ts
export async function compileScene(input: CompileSceneInput): Promise<SceneBundle> {
  const session = await openCompileSession(input);
  for (let index = 0; index < session.objectCount; index++) {
    if (session.settled()) break;
    await session.compileObject(index);
  }
  return session.finalize();
}
```
- **修改**（会话内部）
  - 循环体搬进 `async function compileOne(index: number): Promise<void>`：开头 `const object = scene.objects[index]; if (!isSceneObject(object)) return;`，其余 `continue` 全改 `return`。
  - `compileObject(index)` = 原循环里的进度两行（不是对象时不报）+ `compileOne(index)`。
  - `finalize()` = 原 `input.onProgress?.(progressTotal, progressTotal)` 加原收尾，返回 `bundle`；第二次调用抛错。
  - `unsupported` 改成 `RecordingSet`（同文件新增的小类，见下），类型仍是 `Set<string>`，传给各处的照旧是它。
  - `properties` 由 `const` 改 `let`（点 2 按请求换成当前属性全集）。

  > 说明：只包这两层、不搬内部函数，`bundle.ts` 的改动集中在循环前后几十行。
```ts
/** 会话的不支持项集合（L1）：`recorder` 非空时，每次 `add` 另记一份（键已在也记），`compileFragment` 据此得到这个对象带来的键。 */
class RecordingSet extends Set<string> {
  recorder: Set<string> | null = null;
  override add(key: string): this {
    this.recorder?.add(key);
    return super.add(key);
  }
}
```

## 点 2 — 编一个对象的片段（`compile/fragment.ts` 新增类型；实现在 `bundle.ts` 会话里）

- **新增**（`compile/fragment.ts`）
```ts
/** 运行中编一个对象的请求（L1；L2 起经 Worker 传）。 */
export interface FragmentRequest {
  /** `objects` 下标。L1 只收新下标（≥ 会话里的对象数，中间空位补 null）；已有下标（单对象重编译）L6 再做，现在抛错 */
  object: number;
  /** 配置原文（JSON 文本）。数组配置编成分组节点，同 P6d3b 的 `structure.created` */
  config: string;
  /** 单对象重编译的覆盖（L6），路径同 `scriptOverrides`；L1 只透传、不用 */
  overrides?: Record<string, number[] | boolean | string>;
  /** 运行中的父（`objects` 下标）与挂点骨骼名：父写进 `parents[object]`，骨骼名写进对象 JSON 的 `attachment`（同 `structure.parents`） */
  parent: number | null;
  bone: string | null;
  /** 当前属性全集（用户值）：会话按它重算 `properties`，绑定按它取值 */
  properties: Record<string, unknown>;
}

/** 一个对象的编译产物（L1）。下标都是全局的；键是绝对路径 `objects/<object>/…`，克隆由 `rekeyFragment` 改。 */
export interface ObjectFragment {
  object: number;
  /** 规整配置（`normalizeConfig`，去顶层 id、键排序）：片段缓存的键 */
  config: string;
  /** 和位置无关：`group` null、`subtree` []、没有 `attachment`、effect 的 `unsupported` 不含 `GROUP_CHILD_FRAMEBUFFER` */
  layer: SceneLayer;
  /** 对象级绑定（目标指向这个对象的），按登记顺序；`user-texture` 这种按属性名全场去重的不在这里，在 `FragmentDelta.bindings` */
  bindings: SceneBinding[];
  /** 定型后的脚本条目：材质常量目标已补 uniforms / members，动画层字段脚本已按 `animationLayerDefs` 过滤 */
  scripts: SceneScript[];
  /** 关键帧；`parent` 是片段内的下标 */
  animations: SceneAnimation[];
  sound?: SceneSound;
  /** 灯；`legacySlot` 为 -1，由 L3 的登记表按「排在最后取第一个空槽」分配 */
  light?: SceneLightObject;
  /** 反射名单用：场景平面反射开着、`reflected` 不为 false、自己不是读反射图的模型 */
  reflected: boolean;
  /** 会翻转场景级不变量的原因（`effect-access`、`reflection:planar`、`mip-framebuffer`、`lights`、`legacy-lights`、`volumetrics`）；非空时宿主整场重载 */
  sceneFlips: string[];
  /** 只会从假变真、宿主可以运行中补订阅的场景位 */
  audio: boolean;
  media: boolean;
  /** 这个对象带来的不支持项（排序）；`fragmentOf` 取不到，给 [] */
  unsupported: string[];
}

/** 随片段发给主线程的场景级新表项：都只增，`from` 是第一项的下标。 */
export interface FragmentDelta {
  fragment: ObjectFragment;
  programs: { from: number; list: TranslateResult[] };
  textures: { from: number; list: SceneTexture[] };
  userTextures: { from: number; list: UserTextureSource[] };
  /** 场景级绑定（`user-texture`，第一次出现的属性） */
  bindings: SceneBinding[];
  /** 新出现的、在 WPE assets 里存在的脚本资源路径 */
  assetPaths: string[];
}
```
- **新增**（会话的 `compileFragment`，按顺序）：
  1. **检查**：`finalize` 之后才能调；`object` 小于对象数时抛「单对象重编译在 L6」。
  2. **放进场景**：
     - `scene.objects` 补 null 到 `object`，放解析后的配置。数组配置放 `{}`，`configs[object]` 存数组的规整文本。
     - `configs[object] = normalizeConfig(…)`；`parents[object] = request.parent`。
     - `bone` 非空时写 JSON `attachment`，为空时删掉。
     - `properties = currentProperties(project, request.properties)`。
  3. **开记录**：`unsupported.recorder = new Set()`；记下各表的长度：
     - `bundle.programs` / `textures` / `userTextures` / `bindings.list` / `sounds` / `animations` / `scripts.list`；
     - `reflectionReaders`、`mipReaders`；
     - `bundle.lights`、`legacyLights` 有没有。
  4. **脚本**：`collectObjectScriptsSync(config, object, properties, bindings.list)`，推进 `scripts.list`。
     - 对新条目跑 `checkScriptFeatures`。
     - 新条目里有用 `getEffect` 的（`usesEffectAccess(source)`，跳过有 errors 的），而 `scripts.usesEffectAccess` 为假：记 `effect-access`。
  5. **灯**：从 `compileLightObjects` 抽出单对象版 `compileLightObject(object, index, bind, issues)`，整场版改成调它、再按原规则分配 `legacySlot`。
     - 片段用单对象版，`legacySlot = -1`。
     - `wantsVolumetrics([light])` 为真时记 `volumetrics`（体积光运行中增删属 L8）。
  6. **关键帧**：从 `collectAnimations` 抽出单对象版 `collectObjectAnimations(scene, index)`，整场版改成按对象调它再拼接（`parent` 加偏移）。
     - 片段的条目推进 `bundle.animations`；照报的键进 `unsupported`。
  7. **能力**：`checkObjectFeatures(config, unsupported, parents[object])`；透视场景再加 `perspectiveObjectIssues`。
  8. **编**：`compileOne(object)`。
  9. **单对象收尾**（和 `finalize` 共用抽出来的小函数，不复制）：
     - **反射读者**（本次新增的 `reflectionReaders`）：
       - 模型读者、场景没有平面反射：记 `reflection:planar`；
       - 非模型读者、没有平面反射：改绑棋盘格，同 `finalize`；
       - 场景反射开着：`reflected` 照 `finalize` 的规则求（登记 `reflected` 的重编译绑定、报 `reflectionKind`）。
     - **mip 帧缓冲**：新增 mip 读者而 `bundle.mipFramebuffer` 不为真，记 `mip-framebuffer`。
     - **光照位**：`bundle.lights` / `legacyLights` 由无变有，记 `lights` / `legacy-lights`。
     - **动画层字段脚本**：本对象的动画层字段脚本按 `animationLayerDefs` 过滤（同 `finalize`）。
     - **audio**：`project.general?.supportsaudioprocessing === true` 且（粒子 `particleUsesAudio`，或这个图层任一 pass 的程序 `readsAudioUniforms`）。
     - **media**：新脚本导出媒体回调，或新增了 `system` 来源。
     - **组内问题**：不跑 `groupChildIssues`、不标 `GROUP_CHILD_FRAMEBUFFER`。组归属是运行时派生的，L3 / L7 进组时再判。
  10. **切片**：按第 3 步记的长度切出片段与增量。
      - 片段的 `layer` 是 `bundle.layers` 里 `object === request.object` 的那一项。
      - `bindings` 按目标分到片段（对象级）与增量（`user-texture`）。
      - `unsupported` 取记录器内容（排序），之后把「记录器里有、调用前会话里没有」的键从会话删掉，关记录器。
      - 增量的 `assetPaths`：新脚本的 `scriptAssetCandidates` 里、`fs.existsInAssets` 为真、`bundle.assetPaths` 里还没有的，同时补进 `bundle.assetPaths`。
- 依赖名字表只含加载时的对象（rea-p6d-layers 11）：新对象不会被依赖、不进名字表，`isDepended` 对它恒假。这条照旧。

## 点 3 — 从 bundle 取片段、改键（`compile/fragment.ts`，纯函数）

- **新增**
```ts
/** 取不了片段的原因；null 表示能取。 */
export function fragmentBlocker(bundle: SceneBundle, object: number): string | null;
// - "missing"：`bundle.layers` 里没有这个对象；
// - "depended"：`layer.dependedOn`。克隆不被依赖，计划不同（盘点 §7.3）；
// - "hdr-layer-composites"：HDR 场景且某个 pass 有 `layerComposites`。`TEX<n>FORMAT` 按 `entry.object < owner` 定，随下标变（盘点 §1.2）；
// - "group-upload"：`layer.groupUpload` 非空。模板带子层，克隆没有；L7 起每个组合层都编，这条删掉。

/**
 * 从整场 bundle 里取一个对象的片段。各表按「属于这个对象」过滤：
 * - 图层按 `object`；
 * - 绑定按目标里的 `object`、`objects/<i>/` 前缀的 `pass` / `path`、`script-property` 的脚本路径；
 * - 脚本按属主；
 * - 关键帧按 `object`，`parent` 换成片段内下标；
 * - 声音、灯按 `object`。
 * 位置相关的字段清成和 `compileFragment` 相同的空值；`reflected` 取 `bundle.reflection?.list` 是否含它；`unsupported`、`sceneFlips` 为 []；
 * `audio`、`media` 按点 2 第 9 步同一规则现算。有 `fragmentBlocker` 时返回 null。
 */
export function fragmentOf(bundle: SceneBundle, object: number): ObjectFragment | null;

/**
 * 改键（克隆）。规则：
 * - 字符串里的 `objects/<from>/` 前缀换成 `objects/<to>/`：pass 键、绑定的 pass / path、脚本 id / 属主 / 目标、`script-property` 的脚本路径、
 *   关键帧 id / 目标、文本的 `backgroundTarget`、puppet 的 upload / texchan / clip 键；
 * - 数字字段 `object` 换成新下标，`id` 换成新 id，`parent` 取新父；
 * - 位置相关的字段保持空值。
 * 只读入参、返回新对象。字段清单以盘点 §1–§2、§6 为起点，以点 4 的对照为准。
 */
export function rekeyFragment(fragment: ObjectFragment, to: { object: number; id: number; parent: number | null }): ObjectFragment;
```
  > 说明：执行时先把 `SceneLayer` 及嵌套类型、`BindingTarget` 各分支、`SceneScript` / `SceneAnimation` 的字段逐个过一遍，列出带对象下标或 `objects/<i>/` 键的字段，写进 `fragment.ts` 文件头注释，再实现。

## 点 4 — 验收

**全库编译产物不变**
- 用 `ignore/live/l0/bundlehash.test.ts` 跑改后的源码，结果和 `bundle-base-1.json` 逐张相同（233 张）。

**片段一致性**（新，`ignore/live/l1/fragments.test.ts`，全语料，跑法同 bundlehash）
- 每张场景开会话，整场编完 `finalize`，先存摘要（必须等于基线）。
- 再对每个有图层、配置不是数组、`fragmentBlocker` 为 null 的对象 i，取新下标 N（从对象数起递增）、新 id（从 900000 起递增），父取模板的 `parent`，比较两种片段：
  - A = `compileFragment({ object: N, config: 带新 id 的 configs[i], parent, bone: null, properties: {} })` 的片段；
  - B = `rekeyFragment(fragmentOf(bundle, i), { object: N, id, parent })`。

  A、B 规范化后（同 bundlehash 的 `normalize`）逐字段比，`unsupported` 不比。另查三条：
  - A 的 `unsupported` ⊆ 整场的 `unsupported`；
  - A 的 `sceneFlips` 为空：同场景的配置不会翻转不变量；
  - 增量的 `programs` / `textures` / `userTextures` / `bindings` 为空：配置都编过，按缓存全命中。
- 输出每张场景：比了几个对象、跳过几个（按 blocker 分）、不同几个（字段路径）。
- 判据：
  - 不同为 0；
  - 增量非空的逐条登记原因（预期 0）；
  - 跳过数与原因列进验收报告。

**现有测试**
- `apps/wpe-scene/src/compile/` 下全部测试照过。只跑这个目录，按 memory「只跑自己的 vitest」：`cd /D/Codes/kabegame/apps/wpe-scene && node ../../node_modules/vitest/vitest.mjs run src/compile --config D:/Codes/kabegame/apps/wpe-scene/vite.config.ts`，以实际配置文件为准。

**新单测**（`compile/fragment.test.ts`）
- 内存工程，每种对象各一个，比 A 与 B，同上：
  - 图像层、带两个 effect；
  - 粒子（含子系统与两个 renderer）；
  - 文本；
  - 声音；
  - 普通灯；
  - 静态模型；
  - 带 `script-property` 与材质常量脚本；
  - 带关键帧（含联动）。
- 另测：
  - 片段的 `unsupported` 正确，而且编完后会话的 `unsupported` 恢复原样（`settled()` 仍为假）；
  - `fragmentBlocker` 的四条；
  - 用 `getEffect` 的脚本让 `sceneFlips` 含 `effect-access`；
  - 已有下标抛错。

**变异**（`kbp mutate` 工作区模式，按原字节还原，每条都要被上面某个判据抓到）：
- 改键漏 pass 键里的一类（例：文本 `background`）；
- `fragmentOf` 少取一张表（例：关键帧）；
- `compileFragment` 漏登记脚本的 `script-property` 绑定；
- 编完不从会话删新增的不支持键；
- 单对象版灯槽仍按顺序分配（不是 -1）；
- `compileOne` 里某个 `continue` 改成 `return` 时漏一处（`camera` 分支）。

**检查**
- `deno task check -c kabegame`：前端类型；cargo 那一半不涉及。
- Prettier。

## 交付与审阅

- 由 sonnet 执行代理在主工作区实现（memory「执行代理用 sonnet」）。动手前先 `git status`，只改：
  - `apps/wpe-scene/src/compile/` 下的 `bundle.ts`、`fragment.ts`、`fragment.test.ts`、`lights.ts`、`animations.ts`；
  - 必要时 `features.ts`、`scripts.ts`；
  - `ignore/live/l1/`。
- 我独立验收：
  - 先查越界改动；
  - 重跑全库摘要与片段一致性；
  - 抽查变异。
- 文档：`cocs/wpe/WPE_SCENE.md` 加一条「编译会话与对象片段（活的场景图 L1）」；`cocs/README.md` 的主题与适用场景各补一句。按用户要求，这项工作不写 changelog。
