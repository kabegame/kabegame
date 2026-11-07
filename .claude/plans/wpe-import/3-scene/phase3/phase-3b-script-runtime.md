# P3b — SceneScript 运行时（最小 API + 骨架）

> 上级：[PLAN.md](PLAN.md)「P3 — SceneScript」。前置：[phase-3a-bindings.md](phase-3a-bindings.md)（绑定表、`SceneState`、宿主应用函数）已验收。
> 下一步：[phase-3c-runtime-graph.md](phase-3c-runtime-graph.md)。
> 依据：[p3-script-REPORT.md](p3-script-REPORT.md)（A 引擎、B 宿主结构、C API、D 生命周期与时序、E 运行环境、F 样本统计、I4 脚本侧的属性更新、I10 实测）。下文引用写节号。

## 总体设计思路

WPE 给每个场景一个 V8 Isolate 加一个 Context，场景里所有脚本都是这个 Context 里的 ES 模块，共享全局（`shared`、`Vec3` 等基类、模块注册表），在渲染线程上与渲染同步执行：每帧先推进计时器、再调各脚本的 `update` 并当帧写回返回值，然后渲染（B、D）。场景宿主（P3-0）就是为了照这个模型做而抽出来的：宿主是每个场景实例独占的 `file:` iframe，编译在 Worker、渲染在宿主主线程。P3b 把脚本也放在宿主主线程上同步执行（已定 1），脚本拿到的 `thisLayer`、`thisScene.getLayer()` 是直接作用于渲染状态（3a 的 `SceneState`）的真对象，不需要消息往返和代理。

**realm。** 宿主里建一个同源 `about:blank` 子 frame，当作脚本的独立 realm（已定 2）：同进程、同线程，宿主可以同步调用其中的函数；脚本改内置原型、污染全局碰不到渲染器。它对应 WPE「渲染线程上的一个独立 V8 Context」：每个场景实例一个 realm，场景里全部脚本共用它。realm 里先以经典脚本执行 WPE 的 `baseclasses.js`（`class Vec2/Vec3/…` 成为全局词法绑定，`shared`、`createScriptProperties`、`_Internal` 成为全局对象属性），再把每段脚本作为一个独立的 ES 模块加载（每段一个新的 blob URL，同一份源码出现三次就是三个实例，各有自己的模块级状态）；裸模块名照 WPE 转小写映射到 `scripts/jsmodules/`，同一个模块在一个 realm 里只求值一次（B）。子 frame 与宿主同源同权限，这只是隔离、不是安全边界。这条路能不能走通先做探针（步骤 0），任一项不成立就停下汇报，不自行换方案。

**数据从哪来。** 脚本表在 Worker 里随 bundle 一起编出来：每段脚本的稳定 id（scene.json 坐标）、源码、写回目标（3a 的绑定目标，或者「暂不支持的目标」）、值形状、JSON 里的初值、`scriptproperties`，以及它所属的图层与 `thisObject`。`baseclasses.js` 与用到的 jsmodules 也在 Worker 里按 `SceneFs` 的顺序（项目散文件 → `scene.pkg` → WPE `assets/`）读出来放进 bundle，与 WPE「经宿主资源读取」一致，也沿用现有的读文件通路。脚本表只看 JSON、不看属性值，所以跨重编译不变。

**时序（已定 8，D、I4）。** 加载：模块按脚本表顺序逐个 `import()` 求值（顺序决定 `shared` 的先后写入；一段失败不影响后面的）→ 套用 JSON 的 `scriptproperties` → 对每段调 `init(value)` 并写回 → 用全集调一次 `applyUserProperties` → 首帧（计时器、`update`、渲染）→ 报 `ready`。每帧：计时器按本帧 dt 递减并触发 → 各段 `update(value)` 写回 → `SceneState` 刷进 GPU → 渲染。改属性：宿主的应用函数（3a）依次做直接绑定、`updateScriptProperties`、`applyUserProperties(增量)`，全部在两帧之间同步完成，下一帧生效；`init` 不重跑。暂停时帧循环停，脚本与计时器一起停。

**跨重编译保留脚本（已定 7 末句）。** 重编译（3a 里仍有几类）只换 bundle、`SceneState` 与 GPU 场景，realm、模块实例、`shared`、计时器、`init` 状态都不动。脚本写过的值记在一张「目标稳定键 → 最后一次写入」的覆盖表里，新 `SceneState` 建好、首帧之前重放一遍；用户绑定之后又写了同一目标的，以用户绑定为准（谁最后写谁赢，同 WPE 一个字段只有一份值）。

**出错与卡住（已定 3、5）。** 回调抛错只禁用这段脚本的这个回调（D「异常」）；模块求值失败这段整段不用；不做静态扫描，未实现的 API 就让它在调用时报错，可能画出半成品（2026-11-07 改为静态扫描未实现 API、报 `script:api:*` 整张退回，见「已定」5 的注记）。错误按 `"<message> (line L, col C)"` 写应用日志。每个回调都计时，单次超过 15 s 就在它返回后停掉本场景全部脚本、画面按最后的值继续、写应用日志；真正的死循环接受卡住，由现有 ping / 看门狗 / CEF 处理。脚本相关不再进 `unsupported`：`value:script` 与 D10 的 `isStaticScript` 在本阶段删除，渲染能力的 `unsupported` 与 D4 照旧。

**环境对齐（已定 4）。** realm 里遮掉 WPE 没有的东西（`fetch`、`XMLHttpRequest`、`WebSocket`、全局计时器等，E），`console` 只有 `log` / `error`。另有一项是我们特有的：realm 与网页壁纸同为 `file://` 来源，`localStorage` 会落到与全部网页壁纸共用的 Web Storage 上，而 WPE 的 `localStorage` 是另一套 API（`set` / `get` / `delete` / `clear`，P6），所以本阶段一并遮掉 Web Storage。这些只为画面一致，不是安全边界（`parent` / `top` / `document` 删不掉）。

**API 先做最小集加骨架（已定 6）。** 回调 `init` / `update` / `applyUserProperties` / `destroy`；`engine` 的计时、`userProperties`、画布 / 屏幕尺寸、计时器、`is*`；`console`、`shared`、`createScriptProperties` 与 `scriptProperties`；`thisObject` / `thisLayer` 读写 3a 已支持的目标（变换、`alpha`、`color`、`visible`、材质常量、泛光参数）；`thisScene` 只读查询 `getLayer` / `getLayerCount` / `getLayerIndex` / `enumerateLayers`。做完用本机语料跑一遍，列出哪些场景的 `unsupported` 变空、每段脚本有没有报错、报错集中在哪些缺失的 API，据此排后续 API 阶段（步骤 6）。

## 现状锚点

**a. 脚本按 `value` 静态处理，带 `update` / `init` 的整张退回**（`apps/wpe-scene/src/compile/model.ts:172`、`:195`；`compile/features.ts:203`）
```ts
export function isStaticScript(source: unknown): boolean {
  if (typeof source !== "string") return false;
  return scriptExports(source).every((name) => name === "applyUserProperties");   // 现状：D10，只看导出名
}
// resolveValue：
    if ("script" in value) return value.value;   // 现状：脚本绑定一律取 JSON 的 value
// scanValue：
  if ("script" in value && !isStaticScript((value as { script: unknown }).script)) unsupported.add("value:script");
```
本机语料（2026-11-03，38 张，`exhaustive`）里报 `value:script` 的：razer_bedroom（唯一阻塞项）、dino_run、工坊 3146703458、3549863808、3637191856（都另有阻塞）。razer_vortex 的 3 段只导出 `applyUserProperties`，按 D10 已解锁，但切「模式」不变色；shimmering_particles 的 `bloomstrength` 取 `value` 1.12，WPE 抓帧是 1.0（PLAN D10「推翻」、P2b 遗留）。

**b. 帧里没有脚本的位置**（`render/renderer.ts:284`）
```ts
    const seconds = this.clock.seconds();
    const frametime = this.lastTime === null ? 0 : Math.max(0, seconds - this.lastTime);
    this.lastTime = seconds;
    scene.update({ time: seconds % TIME_WRAP_SECONDS, frametime, /* … */ });   // 现状：直接写帧内置量
    // …（3a 起这里先 scene.sync(state)）
    const encoder = device.createCommandEncoder({ label: "scene frame" });
    scene.encode(encoder);
```

**c. `load` 换上场景就画首帧，宿主随即报 `ready`**（`render/renderer.ts:158`、`host.ts:214`）
```ts
  async load(bundle: SceneBundle, options: SceneLoadOptions = {}): Promise<void> {
    // …
    const scene = await GpuScene.build(/* … */);
    // …换上
    this.render();                                      // 现状：没有「首帧之前」的时机给 init / 首次 apply
    await this.gpu.device.queue.onSubmittedWorkDone();
```
```ts
      await current.load(bundle, { ignoreUnsupported: force });
      // …
      if (this.state !== "ready") {
        this.state = "ready";
        // …
        this.options.report.ready();                    // 现状：首帧画完即 ready
      }
```

**d. WPE 自带的基类与内部函数**（只读，`<WPE>/assets/scripts/jsclasses/baseclasses.js:1375`，2.8.42）
```js
this._Vec2 = Vec2.prototype;   // 宿主据此取回原型（B「注入」）
this._Vec3 = Vec3.prototype;
// …
this._Internal = {
	updateScriptProperties(script, vars) {   // vars 是 JSON 串；只改 script.scriptProperties 里已有的键，原值是 Vec3 时重建 Vec3
		// …
	},
	convertUserProperties(p) {               // p 是 JSON 串；按 type 转换：color → new Vec3(value)，usershortcut → {isbound, commandtype, file}，其余取 value
		// …
	},
	stringifyConfig(obj) { /* … */ }
};
this.createScriptProperties=function(){ /* addSlider / addCheckbox / addText / addCombo / addColor … finish() */ }
this.shared = {};
```
`jsmodules/wevector.js` 里 `import * as WEMath from 'WEMath';`（模块之间也用裸名、大小写与文件名不同）。

**e. 三张样本的脚本**（只读，`<WPE>/projects/defaultprojects/*/scene.json`）
```js
// razer_vortex：objects/{0,1,2}/effects/0/passes/0/constantshadervalues/colormode，{ script, value: 0 }，三段相同
export function applyUserProperties(userProperties) {
	if (userProperties.hasOwnProperty('ui_editor_properties_mode')) {
		thisObject.colormode = parseInt(userProperties.ui_editor_properties_mode);   // thisObject = 该 pass 的材质常量
	}
}
// razer_bedroom：objects/{10..15}/effects/0/passes/0/constantshadervalues/color，6 段，rainbowSpeed 0.07–0.2
import * as WEColor from 'WEColor';
export function update(value) {
	value = WEColor.hsv2rgb({ x: Date.now() / 2000 * rainbowSpeed % 1, y: rainbowSaturation, z: rainbowBrightness });
	return value;                                                                    // 墙钟驱动，与 WPE 同一时刻同色
}
// shimmering_particles：general/bloomstrength，{ script, value: 1.12 }
export function applyUserProperties(changedUserProperties) {
	if (changedUserProperties.hasOwnProperty('glow')) {
		thisObject.bloomstrength = changedUserProperties.glow * 0.5;                 // thisObject = general；glow 默认 2 → 1.0
	}
}
```
vortex 的 `ui_editor_properties_mode` 是 combo、默认 `"0"`，与 JSON 的 `value: 0` 相同，脚本真跑后默认画面不变。

**f. 宿主子 frame 的现状**（P3-0 实测，`phase-3-0-scene-host.md`、`cocs/wpe/WPE_SCENE.md`「场景宿主」）
- 宿主里建的 `about:blank` 子 frame 继承宿主来源（`file://`），IPC 权限同宿主（CEF 补丁 19 给每个子 frame 注入桥）。
- 垫片 `wpe_shim.js` 只在「顶层的直接子 `file:` frame」里启用（`window.parent === window.top && location.protocol === "file:"`），宿主的子 frame 不满足，不会再起一份垫片。
- `file:` 文档没有 CSP，`import(blob:)` / `new Function` 在宿主里可用；宿主 `fetch(file:)` 能读 WPE `assets/`。
- CEF 09 后，同一 local root 下的 local 子 frame 与宿主各 145 次 rAF/秒，不重复派发。

## 点 0 — 可行性探针（`ignore/p3b/probe.mjs`，CDP 驱动；不进仓库）

在 dev 主窗口的宿主 frame 里逐项实测，结果表写回本文件「实施记录」。任一项不成立就停下汇报。
1. **建 realm**：宿主 `document` 里建隐藏的 `about:blank` iframe（`display: none` 与 `hidden` 两种都试），`contentWindow` 同步可用、`origin` 为 `file://`、`isSecureContext` 为 true。
2. **经典脚本**：把 `baseclasses.js` 原文作为内联 `<script>`（`textContent`）插进子 frame 的文档并同步执行。确认 `Vec3` 是全局词法绑定（`typeof` 在随后的模块里可见，但不是 `globalThis` 的属性）、`_Vec3` / `_Internal` / `shared` / `createScriptProperties` 是全局属性。对照：`child.eval(…)` 不行（eval 代码里的 `class` 不成为全局词法绑定），记下来。
3. **blob 模块**：`new child.Function("u", "return import(u)")(url)`，`url` 由 `child.URL.createObjectURL(new child.Blob([src], { type: "text/javascript" }))` 产生。确认模块在子 frame 的 realm 里求值（模块里 `globalThis === child`）、两个不同 URL 的同一源码是两个实例、`export function` 可从宿主同步调用。
4. **裸模块名**：
   - (a) 子 frame 文档在首次 `import()` 前插入 `<script type="importmap">`，`"WEColor"`、`"WEMath"` 等原样大小写映射到小写模块的 blob URL；模块里再 `import 'WEMath'`（`wevector.js`）也能解析；同一个模块被多段脚本导入只求值一次（模块里放一个计数器）。
   - (b) (a) 不行时：编译期把源码里的说明符改写成 blob URL，记下改写对列号的影响。
5. **跨 realm 调用**：宿主同步调用子 frame 里的函数；子 frame 抛的错误在宿主里 `instanceof Error` 为 false（只能按 `message` / `stack` 鸭子类型读）；`error.stack` 里能读出 `blob:…:<行>:<列>`；模块解析期的 `SyntaxError` 由 `import()` 的 rejection 给出且带行列；脚本里 `value instanceof Vec3` 在宿主用子 frame 的 `_Vec3.constructor` 构造时为 true、用宿主的普通对象时为 false。
6. **遮蔽**：`delete` 或 `Object.defineProperty(child, name, { value: undefined, configurable: false })` 能否去掉 `fetch` / `XMLHttpRequest` / `WebSocket` / `setTimeout` / `localStorage` / `indexedDB` 等（点 3 表）；`console` 能否整体替换；`__TAURI_INTERNALS__` 是否存在、能否遮掉；`document` / `parent` / `top` 删不掉（预期）。
7. **帧与性能**：子 frame 存在时宿主 rAF 仍约 144.5 次/秒、vortex 宿主 `GPUQueue.submit` 约 60 次/秒（CEF 09 下子 frame 不影响）；顺序 `import()` 100 个小模块的总用时；宿主 dispose（`pagehide`）时子 frame 随之销毁、没有残留。

## 点 1 — 脚本收集（新增 `compile/scripts.ts`；修改 `compile/bundle.ts`、`compile/bindings.ts`）

- **新增** 脚本表类型：
```ts
/** thisObject：脚本绑定所在的对象（B、C「图层与对象成员」：其余属性就是 scene.json 的属性名）。 */
export type ScriptOwner =
  | { kind: "layer"; object: number }                       // 图层属性（origin、visible…）上的脚本
  | { kind: "material"; pass: TargetKey; layer: number }    // 材质常量上的脚本：属性 = 该 pass 的材质常量名
  | { kind: "effect"; object: number; effect: number }      // effect visible 上的脚本
  | { kind: "general" };                                    // general（bloomstrength…）上的脚本

export interface SceneScript {
  /** scene.json 坐标，如 "objects/10/effects/0/passes/0/constantshadervalues/color"：跨重编译的稳定 id。 */
  id: string;
  source: string;
  /** 写回目标：3a 的绑定目标；文本、粒子、声音等还没有就地写入的为 unsupported（写回忽略，日志记一次）。 */
  target: BindingTarget | { kind: "unsupported"; path: string };
  valueType: ValueType | "string";
  /** JSON 里的 value：init / 首帧 update 的参数初值。 */
  initial: SceneScalar;
  owner: ScriptOwner;
  /** thisLayer：所属图层的 objects 下标；general 上的为 null（推断）。 */
  layer: number | null;
  /** JSON 的 scriptproperties，按当前属性解析过（{user} 取当前值，带 condition 的取布尔）；没有为 null。 */
  scriptProperties: Record<string, SceneScalar> | null;
  /**
   * 导入说明符（原样大小写，es-module-lexer 扫出，含字面量动态 `import('…')`；注释与字符串里的不算）。
   * 非裸名（./、/、带 scheme）记进 errors、不进 import map：解析失败，这段整段不用（B：只能导入 jsmodules）。
   */
  imports: string[];
  errors: string[];
}
export interface SceneScripts {
  /** 遍历顺序：general → objects 依序（对象自身属性 → 基础材质常量 → effect 的 visible 与各 pass 常量）。 */
  list: SceneScript[];
  // 修改（2026-11-03 用户定）：bundle 不再带 jsmodules / baseclasses 源码——两者在 realm 里直接以 `file:` 加载（点 2），
  // jsmodules 的说明符扫描结果由宿主内存缓存（点 2 `JsModuleIndex`）。
}
export interface SceneBundle {
  // …
  scripts: SceneScripts;   // 新增
}
```
- **新增** 收集遍历整份 scene.json（包括当前未启用的 effect 与不可见图层：WPE 解析期给全部对象建绑定），与属性值无关。
- **新增** 说明符扫描用 es-module-lexer（Vite 自带依赖，约 14 KB、内嵌 wasm；Worker 与宿主各初始化一次）。本机语料 206 份源码 3.2 ms、0 失败；正则在语料里有 1 处误报（注释掉的 `// import * as WEVector …`），不用正则。
- **修改** `bindings.ts` 加一类目标，供 `scriptproperties` 的用户绑定（I3 `scriptproperties` 364 处）：
```ts
  | { kind: "script-property"; script: string; key: string }   // 新增：属性名 → 某段脚本的 scriptProperties 键（可带 condition）
```

## 点 2 — 脚本 realm（新增 `script/realm.ts`）

```ts
/** 一个场景实例一个；宿主同步调用其中的函数。 */
export interface ScriptRealm {
  /** 子 frame 的 globalThis。 */
  readonly global: Record<string, any>;
  /** baseclasses 取回的原型（B「注入」）。 */
  readonly prototypes: { Vec2: object; Vec3: object; Vec4: object; Mat3: object; Mat4: object };
  readonly internal: { updateScriptProperties: Function; convertUserProperties: Function };
  /**
   * 用户脚本：每次一个新的 blob URL → 新的模块实例（用户脚本只是 scene.json 里的字符串，不落文件，2026-11-03 用户定）；
   * 求值失败 reject（错误来自子 frame realm）。语法错误时再补拿一次位置（见下）。
   */
  importModule(source: string, label: string): Promise<Record<string, unknown>>;
  dispose(): void;
}

/**
 * 建 about:blank 子 frame → 环境对齐（点 3）→ 按场景生成的 import map（见下）→ `<script src="file:…/jsclasses/baseclasses.js">`
 * 作经典脚本执行（等 onload；读不到则整套脚本不运行，日志记一次）。
 */
export async function createIframeRealm(input: {
  document: Document;
  scripts: SceneScripts;
  /** wpe_scene_target 的 sceneAssets（WPE assets 目录）；jsmodules / baseclasses 从这里按 `file:` 加载。 */
  sceneAssets: readonly string[];
  modules: JsModuleIndex;
  console: { log(text: string): void; error(text: string): void };
}): Promise<ScriptRealm>;

/**
 * 新增：jsmodules 的扫描缓存，宿主内存里一份（模块级单例，跟着宿主 iframe 走；同一宿主重编译、换属性都不再读不再扫）。
 * 不放 localStorage：它与全部网页壁纸共用 `file://` 存储区，且 WPE 升级后模块内容会变、拿不到文件时间判断失效。
 */
export interface JsModuleIndex {
  /**
   * 小写模块名 → `{ url, imports }`：按 sceneAssets 顺序 `fetch(file:…/scripts/jsmodules/<小写名>.js)`，第一个读到的为准，
   * 顺带用 es-module-lexer 扫它自己的说明符（如 wevector.js 的 `'WEMath'`）；都读不到为 null。结果（含 null）缓存。
   */
  lookup(name: string): Promise<{ url: string; imports: string[] } | null>;
}
```
- **import map 按场景动态生成**（2026-11-03 用户定）：从脚本表的 `imports` 出发，每个裸说明符原样作键、转小写后经 `JsModuleIndex.lookup` 找到文件，
  写 `"WEColor": "file:///…/scripts/jsmodules/wecolor.js"`；再对找到的模块的 `imports` 递归补齐（缓存里有就不再扫）。
  - 同一文件的不同写法映射到同一 URL，模块只求值一次（探针 4a 与主会话实测：同一 URL 单例）。
  - 找不到的名字不写进 map：导入它的脚本解析失败、整段不用（同 WPE 模块求值失败）。非裸名同样不写。
  - 在第一次 `import()` 之前插入一份 `<script type="importmap">`。realm 跨重编译保留，脚本表不变则 map 不变；
    万一后来出现新说明符，追加一份新的 import map（探针 4a：首次 import 之后追加的映射也能解析）。
  - 不改写源码：行列号与作者原文一致，报错信息保留原写法。
  - 只认 WPE `assets` 里的 jsmodules。WPE 经资源系统读 `scripts/jsmodules/`，工程自带同名模块时可能优先用工程的；本机 36 张场景的 pkg 里都没有 `.js`，遇到再说（后续）。
- **语法错误的位置**（2026-11-03 主会话实测）：`import()` 的 rejection 只有 `SyntaxError: Unexpected token ';'`、不带行列；
  在子 frame 里用 `<script type="module" src=blob:>` 加载同一份源码，`error` 事件给 `lineno` / `colno`（实测 3 / 11，1 起）。
  只在 `import()` 已因 `SyntaxError` 失败后补拿一次：这时源码必然仍解析 / 链接失败，不会被执行第二次。不引入 acorn / babel（解析器只为报错位置，体积 233 / 513 KB）。
- 模块按脚本表顺序**逐个** `await importModule`：动态 `import()` 各自成图，并行时求值顺序不定；用一个入口模块静态导入全部又会因一段失败而整体失败。
- 逻辑单测用 `FakeRealm`（同一接口，`importModule` 返回手写的导出对象，`prototypes` 用测试里的类），不在 Node 里模拟真正的 realm。

## 点 3 — 环境对齐（新增 `script/environment.ts`）

realm 建好、执行 baseclasses 之前做。

| 处理 | 名字 | 依据 |
| --- | --- | --- |
| 遮掉（`delete`，删不掉就定义成不可配置的 `undefined`） | `fetch`、`XMLHttpRequest`、`WebSocket`、`EventSource`、`setTimeout`、`setInterval`、`clearTimeout`、`clearInterval`、`requestAnimationFrame`、`cancelAnimationFrame`、`requestIdleCallback`、`Worker`、`SharedWorker` | E：WPE 没有网络与 DOM、没有全局计时器 |
| 遮掉 | `localStorage`、`sessionStorage`、`indexedDB`、`caches` | 我们的 realm 与网页壁纸共用 `file://` 存储；WPE 的 `localStorage` 是另一套 API（C，P6 实现） |
| 待定 4 | `Intl`、`WebAssembly` | A：推断 WPE 编译时关了 |
| 替换 | `console` → 只有 `log`、`error` 的普通对象；调 `console.warn` 照 WPE 抛 `TypeError` | C、H |
| 尽量遮掉（探针 6 看能否） | `__TAURI_INTERNALS__` | 子 frame 有 IPC 桥；脚本不该误用，删不掉就接受（不是安全边界） |
| 删不掉，保留 | `window`、`self`、`document`、`parent`、`top`、`frames`、`location` | 不可伪造属性 |

## 点 4 — 暴露给脚本的 API（新增 `script/api.ts`）

API 对象建在 realm 里（`realm.global.Object.create(null)` 再 `defineProperty` 存取器），存取器与方法是宿主函数；返回给脚本的值一律用 realm 的构造器造（`new prototypes.Vec3.constructor(x, y, z)`），脚本里 `instanceof Vec3` 才成立；宿主收到的值按鸭子类型读（`typeof v.x === "number"`）。

- **全局**：`engine`、`console`、`thisScene`；`thisLayer` / `thisObject` 是全局对象上的 getter，取「当前正在执行的脚本」（D、G4），计时器回调执行时取所属脚本。`input`、`localStorage`（WPE API）本阶段不提供。
- **`engine`**：
  - 属性：`frametime`（本帧 dt，秒）、`runtime`（场景运行秒数，暂停不走，同 `g_Time` 的时钟）、`timeOfDay`（同 `g_Daytime`）、`canvasSize`（`Vec2`，场景正交尺寸）、`screenResolution`（`Vec2`，待定 5）、`userProperties`（累计全集经 `convertUserProperties` 转换，缓存到下一次应用为止；保留全部键，不复刻 I4 的丢键缺陷）。
  - 函数：`setTimeout(fn, ms)` / `setInterval(fn, ms)` 返回取消函数，`clearTimeout(cancel)`（E）；`isRunningInEditor()` false、`isPortrait()` / `isLandscape()` 按 `screenResolution`、`isMobileDevice()` false、`isDesktopDevice()` true、`isWallpaper()` true、`isScreensaver()` false、`isObjectValid(o)`（是本场景现存的图层 / 对象）。
  - 不提供：`registerAudioBuffers`、`registerAsset`、`openUserShortcut`、`requestFeatures`、`AUDIO_RESOLUTION_*`（调用照常报错，已定 5）。
- **作用域限制**（C）：模块求值期间访问计时器、`isPortrait` / `isLandscape`、`screenResolution`、`canvasSize`、`userProperties`、`timeOfDay`、`frametime`、`runtime`、`thisScene` 的方法时抛错（措辞是我们的，WPE 原文未摘录）。
- **`thisScene`**：`getLayer(name | index)`（按名字取第一个，或按下标；取不到返回 null，开工时对照官方文档 `reference/class/IScene`）、`getLayerCount()`、`getLayerIndex(layer)`、`enumerateLayers()`（按场景顺序的数组，realm 的 `Array`）。
- **图层对象**：每个 objects 下标一个、跨重编译不变（脚本可能存进 `shared` 再比较）。属性：`name`、`id`（只读）；`origin` / `scale` / `angles`（`Vec3`，读返回新对象、改分量不生效，要整体赋值；`angles` 以度计，写入时 × 0.017453292 存成弧度，D）；`size`（`Vec2` 只读，写入照 WPE 不生效）；`alpha`、`color`（`Vec3`）、`visible`、`brightness`。写入走 3a 的 `SceneState.write`，当帧生效。
- **`thisObject`**：按 `SceneScript.owner`——图层对象；材质常量对象（属性 = 该 pass 的材质常量名，按 uniform 形状换成数字或 `VecN`，写入即就地改常量）；effect 对象（只有 `visible`，写入见待定 6）；general 对象（`bloomstrength` / `bloomthreshold` / `bloomtint` / `bloomhdr*` 就地改泛光参数；`clearcolor` 等 3a 里重编译的项按待定 6 同样处理）。
- **`console`**：`log` / `error`，去向见待定 3。

## 点 5 — 脚本运行时（新增 `script/runtime.ts`）

```ts
type Callback = "init" | "update" | "applyUserProperties" | "destroy";

interface ScriptRecord {
  script: SceneScript;
  exports: Record<string, unknown> | null;   // null = 求值失败或没加载
  state: "pending" | "loaded" | "inited" | "failed";
  disabled: Set<Callback>;
}

export class ScriptRuntime {
  constructor(realm: ScriptRealm, options: {
    report: SceneReporter;
    /** 写回目标；返回 false = 目标在当前场景里做不了，按待定 6 处理。 */
    write(target: ScriptTarget, values: number[] | boolean, source: string): boolean;
    read(target: ScriptTarget): number[] | boolean | null;
    now?: () => number;   // 计时用；单测注入
  });

  /** 加载：逐个 import → 套用 scriptproperties → init(value) 写回。不调 apply，不画帧。 */
  async load(scripts: SceneScripts): Promise<void>;
  /** 首次全量或增量：updateScriptProperties（命中的段）→ applyUserProperties（convertUserProperties(同一份 JSON 串)）。 */
  applyUserProperties(delta: Record<string, SceneProperty>, full: ReadonlyMap<string, SceneProperty>): void;
  /** 每帧：计时器按 dt 递减并触发 → 各段 update(value) 写回。 */
  frame(dt: number): void;
  /** 重编译后：把脚本写过、之后没被用户绑定覆盖的目标重放到新状态上。 */
  replayWrites(): void;
  /** 用户绑定写了某目标：从覆盖表里去掉（谁最后写谁赢）。 */
  forgetWrite(target: TargetKey): void;
  destroy(): void;   // 调各段 destroy，再 realm.dispose()
}
```
- **调用包装**（每个回调、计时器都经它）：设当前脚本 → `now()` 计时 → 调用 → 恢复当前脚本；抛错时禁用该回调（计时器回调出错就取消该计时器）、按 `"<message> (line L, col C)"` 记 `warn`（行列从 `stack` 的 blob URL 位置读，读不到只记消息）；用时 > 15 000 ms 就在返回后置 `halted`，之后不再调任何脚本，记 `error`「脚本执行超过 15 秒，已停止本场景全部脚本」（E 看门狗，已定 3）。
- **写回**（D）：只写回 `init` / `update` 的返回值；数字原样；向量接受 `{x, y[, z, w]}` 或单个数字展开到各分量；布尔要求真布尔；`angles` 度转弧度；类型不符或 `undefined` 不改。写回经 `options.write`，同时记进覆盖表。
- **`value` 参数**：当前目标值按 `valueType` 换成 realm 值（向量 → `VecN`、颜色 → `Vec3`、角度为度）；目标不可读（unsupported）时给 JSON 初值。
- **计时器**（E）：毫秒存成秒；在 `frame(dt)` 开头用 dt 递减，到期按登记顺序触发；`setInterval` 触发后剩余时间加一个周期（待定 9）；暂停没有帧，计时器自然停。
- **`scriptproperties`**：加载时（求值后、`init` 前）对每段调一次 `updateScriptProperties(exports, JSON(scriptProperties))`（待定 1）；运行时由 3a 的 `script-property` 绑定组装 `{键: 值或布尔}`，只对命中的段调用（I4）。
- **`applyUserProperties`**：只对状态为 `inited`、导出了该函数的段调用；参数是增量里同时带 `type` 与 `value` 的项组成的 JSON 串（一次序列化、全部段共用），经 realm 的 `convertUserProperties` 转成对象（I4）；组装结果为空也照调（I4）。
- **微任务**：宿主一次同步调用内的 Promise 回调在本任务结束时才跑（WPE 推断每个最外层回调后冲刷）；样本不用 Promise，记作已知差异。

## 点 6 — 渲染器接入（`render/renderer.ts`）

- **新增** 帧钩子，在 `sync` / `update` 之前调：
```ts
export interface SceneRendererOptions {
  // …
  /** 新增：每个渲染帧开头调用（dt 秒，暂停不走）；脚本的计时器与 update 在这里跑，写进 SceneState，同一帧画出。 */
  beforeFrame?: (dt: number) => void;
}

  private render(): void {
    // …算 seconds / frametime
    this.options.beforeFrame?.(frametime);      // 新增
    scene.sync(this.state!);                    // 3a
    scene.update({ /* … */ });
    // …
  }
```
- **修改** `load` 拆出首帧之前的时机：
```ts
  async load(bundle: SceneBundle, options: SceneLoadOptions & {
    /** 新增：新场景与状态已建好、首帧之前同步调用（首次加载：init → 全量 apply；重编译：重放脚本写入）。 */
    beforeFirstFrame?: (state: SceneState) => void;
  } = {}): Promise<void>;
```
- dev 探针的 `renderFrame` 不跑脚本（固定 `g_Time` 的哈希回归只对无脚本或脚本不随墙钟变的场景有意义；bedroom 用 `Date.now()`）。

## 点 7 — 宿主（`host.ts`）

- **修改** 加载：bundle 可渲染（`unsupported` 为空或 dev 强制）且 `scripts.list` 非空时，第一次建 `ScriptRuntime`（建 realm、`load`），之后的重编译、设备丢失重建都复用它；`baseclasses` 读不到时不建，日志记一次，场景照常渲染（脚本绑定保持初值）。
- **修改** 首次加载顺序：`ScriptRuntime.load`（求值、`scriptproperties`、`init`）→ `renderer.load(bundle, { beforeFirstFrame: () => runtime.applyUserProperties(全集, 全集) })` → 首帧里 `beforeFrame` 跑 `update` → `ready`。
- **修改** 3a 的应用函数：直接绑定（`SceneState.write`，并 `runtime.forgetWrite`）→ `runtime.applyUserProperties(增量, 全集)`（含 `updateScriptProperties`）→ 需要重编译时再 `reload()`；`init` 不重跑。
- **修改** 重编译：`beforeFirstFrame` 里 `runtime.replayWrites()`；realm 与脚本状态不动。
- **修改** `setPaused(true)`：渲染器停帧即脚本停；`dispose()` 调 `runtime.destroy()`（各段 `destroy` 后移除子 frame）。
- **修改** 场景里有脚本时，全部有材质的图层都建 GPU 资源（3a 只建 `visibleBound` 的不可见图层）：脚本可以 `getLayer(…).visible = true` 打开任何图层。

## 点 8 — 删除脚本静态规则（`compile/model.ts`、`compile/features.ts`、测试）

- **删除** `isStaticScript`、`scriptExports` 与 `p2a.test.ts`「脚本静态规则（D10）」；`scanValue` 不再报 `value:script`。
- **修改** `resolveValue` 对 `{script}` 仍返回 `value`（编译期初值），运行时由脚本写回覆盖；注释改写。
- **修改** 语料测试：`unlocked` 加 `razer_bedroom`，删「bedroom 只剩 `value:script`」的断言；`p2a.test.ts` / `p2b.test.ts` 里断言 `value:script` 的用例改成断言 `unsupported` 为空。

## 点 9 — 日志

- target 照旧 `kabegame::wpe_scene_host`（经 `wpe_scene_report`）。
- `warn`：回调出错并被禁用、模块求值失败、写回到不支持的目标（每段一次）；`error`：15 s 停止全部脚本、`baseclasses.js` 缺失；`info`：脚本加载完成（段数、成功 / 失败数、用时）；`debug`：每段的导出掩码。
- 回调计时不进日志；最长用时在探针里看。

## 点 10 — dev 探针（`dev/install.ts`）

```ts
  host: {
    // 3a 的 state / stats / renderFrame 之外，新增：
    /** 每段脚本：id、状态、导出、被禁用的回调、错误、各回调累计次数与最长用时。 */
    scripts(): unknown;
    /** 读一个目标的当前值（如 "general/bloomstrength"、"objects/10/effects/0/passes/0/constantshadervalues/color"）。 */
    read(path: string): unknown;
  },
  /** 语料：对给定的场景 id 逐个编译（exhaustive、强制）、建独立 realm、跑求值 + init + 全量 apply + 120 帧（dt = 1/60），
   *  不建 GPU 场景，返回每张的 unsupported、每段脚本的错误，以及错误按「缺失的 API」归类的计数。 */
  scriptCorpus(imageIds: string[]): Promise<unknown>;
```

## 点 11 — 文档、回归与 changelog

- `cocs/wpe/WPE_SCENE.md`：新增「场景脚本（P3b）」一节：realm 的建法与环境对齐表、模块解析、脚本表、生命周期与每帧顺序、写回规则、出错与 15 s、跨重编译保留、API 清单与「未提供」清单；「能力表」删 `value:script` 与 D10 段；「场景宿主」的 rAF 注记里「P3 脚本的 `update` 挂在渲染器的帧上」改成已实现；`cocs/README.md` 的 WPE_SCENE 条目摘要加脚本运行时。
- `versions/latest/regression.md` 新增「场景壁纸 P3b：脚本运行时」小节，用例见验收。
- `versions/latest/changelog.md` 用户侧 Added：「场景壁纸支持 Wallpaper Engine 场景脚本（SceneScript）的基础部分：Razer Bedroom 现在可实时渲染（彩虹灯带），Razer Vortex 的『模式』属性生效；脚本出错只停用出错的那一段，其余照常」。

## 实施步骤

每步都能单独验收；codex 只改仓库内文件，独立验收时先 `git status` 查越界，不采信自报。验收不包含任何让宿主或脚本死循环、忙等、卡住的测试（已定 3）。

**步骤 0 — 可行性探针**（Claude，CDP，沙箱外）：按点 0 逐项测，结果写进本文件「实施记录」。**任一项不成立就停下汇报，等用户定。** 4(a) 不行而 4(b) 可行、或 6 里个别名字删不掉，属于点内的备选，记下即可继续。

**步骤 1 — 脚本收集**（codex：点 1）
- 验收：单测 1；语料测试照跑，bundle 的 `scripts` 对本机 38 张都能生成（不执行），`unsupported` 不变（`value:script` 到步骤 5 才删）。

**步骤 2 — 运行时逻辑**（codex：点 5，配 `FakeRealm`）
- 验收：单测 2–7。

**步骤 3 — iframe realm 与环境对齐**（codex：点 2、点 3，按步骤 0 的结论选 4a / 4b）
- 验收：CDP 复跑探针里与实现相关的几项（经典脚本、模块实例、裸名、遮蔽表）全部符合；宿主 `typecheck` 0 error。

**步骤 4 — API 对象**（codex：点 4）
- 验收：单测 8–9；CDP 在 realm 里逐项读写 API，结果写进实施记录。

**步骤 5 — 接入与删除静态规则**（codex：点 6、点 7、点 8、点 9、点 10）
- 验收：语料测试 bedroom 解锁、其余结论不变；`deno task test -c kabegame --skip cargo` 两个前端目录全过；`check-kabegame` 与宿主 `typecheck` 0 error；无脚本场景（eagleflag / deep_space / beach）与 vortex（默认属性）在固定 `g_Time` 下的哈希与 3a 基线相同。

**步骤 6 — 语料与解锁清单**（Claude，CDP 调 `scriptCorpus`）
- 在应用页按 `x-wpe/scene` 取库里全部场景 id，交给宿主探针。
- 产出写进本文件「实施记录」：
  - **解锁清单**：`unsupported` 由非空变空的场景（按 2026-11-03 的语料预期只有 razer_bedroom；其余报过 `value:script` 的 dino_run、3146703458、3549863808、3637191856 都另有阻塞），以及与 3a 结束时的逐张对比；
  - **脚本运行表**：每张有脚本的场景的段数、求值失败数、各回调报错数；
  - **缺失 API 排行**：把报错按缺失的名字归类（如 `engine.registerAudioBuffers is not a function`、`input` 未定义、`thisLayer.getParent`），按壁纸数 / 段数排序；
  - **后续 API 阶段建议**：据排行给出建议（见「后续」的初排），交用户定。

**步骤 7 — 真机验收**（Claude 经 CDP；需要的窗口状态由用户摆好，不改用户的壁纸设置；WPE 一侧按 D12，临时改的设置用完恢复）：见验收「真机」。

**步骤 8 — 文档**（codex：点 11；Claude 填实测数值并核对文档与代码一致）。

## 验收

**单测**（`apps/wpe-scene`，`FakeRealm` 与注入时钟）
1. 脚本收集：vortex 3 段，`owner` 为各自的 tint pass、目标是 `colormode` 常量、`initial` 0；bedroom 6 段，目标 `color` 常量（vec3）、`imports` 为 `["WEColor"]`（bundle 不带模块源码，模块由宿主的 `JsModuleIndex` 按 `file:` 找）；shimmering 1 段，`owner` general、目标 `bloom.strength`；`wevector` 的依赖 `wemath` 被一起读入；非裸名说明符记错、这段不加载；未启用的 effect 里的脚本也在表里。
2. **加载顺序**：求值按脚本表顺序、一段求值失败后面照常；`scriptproperties` 在 `init` 之前；`init` 写回在首次 `applyUserProperties` 之前；首次 apply 是全集、颜色转成 `Vec3`；首帧里计时器先于 `update`。
3. **增量顺序**：直接绑定 → `updateScriptProperties`（只对命中的段）→ `applyUserProperties`（只含增量、同一份 JSON 串）；`engine.userProperties` 在 apply 时已是新值、保留全部键；`init` 不重跑。
4. **返回值转换**：数字；`{x,y,z}` 与单个数字展开；布尔要求真布尔；`angles` 度转弧度；类型不符与 `undefined` 不改；`applyUserProperties` 与 `destroy` 的返回值不写回。
5. **计时器**：按注入的 dt 推进（不看墙钟）；同一帧多个到期按登记顺序；`setInterval` 的周期；取消函数与 `clearTimeout`；暂停（不调 `frame`）时不前进；计时器回调里的 `thisLayer` 是登记它的脚本的图层。
6. **出错禁用**：某段 `update` 抛错一次后不再调它的 `update`，它的其它回调与别的段照常；模块求值失败整段不用；错误日志带行列。
7. **15 s 规则**（注入时钟）：回调用时 14 999 ms 不触发；15 001 ms 时该回调返回后全部脚本停止（之后 `frame` 不再调任何脚本）、日志一条 `error`，`SceneState` 保持最后的值。不运行任何真实的长时间回调。
8. API：作用域限制（模块求值期间访问 `engine.frametime` 抛错、`init` 里不抛）；`thisLayer` / `thisObject` 跟随当前脚本；图层对象跨重编译同一个；`origin` 读出新对象、改分量不写、整体赋值写；`size` 写入不生效；`console.warn` 抛 `TypeError`。
9. **跨重编译**：脚本写过 `colormode` 后发生一次重编译，新状态里 `colormode` 仍是脚本写的值、`init` 计数仍为 1、计时器剩余时间不变；之后用户绑定写同一目标，再重编译以用户值为准。

**语料**：步骤 6 的产出（解锁清单、脚本运行表、缺失 API 排行）写进实施记录；本机全部有脚本的场景里，除样本自身的错（F：3326873240、3470764447 的 `scene.getLayer` 伪代码，WPE 也报 `ReferenceError`）与归入「缺失 API」的报错外没有别的报错；有报错的逐条解释。

**真机**（Windows dev，主窗口预览；壁纸窗口为窗口模式时一并验，不是就记未测）
- **razer_vortex**：属性面板切「模式」0 → 1 → 2 → 0，三层颜色模式跟着变、应用日志没有「重新编译」；与 WPE 对照——在 WPE 界面里由用户切同样的模式（WPE 的 `-control applyProperties` 不带 `type`，脚本收不到，I4），两边截图同模式下颜色模式一致；默认模式下固定 `g_Time` 的哈希与 3a 基线相同。
- **razer_bedroom**：不再退回预览图，彩虹灯带按各自速度循环；脚本用墙钟，与 WPE 在同一时刻同色——两边同一后处理档位（用户当前为「关闭」）、同一时刻各截一张，比较 6 条灯带的色相（容差记进回归表）；`light_speed` 仍控制滚动速度（3a）；切「场景后处理」触发重编译后灯带颜色不跳回初值、不重新 `init`（探针 `scripts()` 的 init 计数仍为 1）。
- **shimmering_particles**（dev 强制渲染，粒子不画）：探针 `read("general/bloomstrength")` 首次 apply 后为 1.0（`glow` 默认 2 × 0.5，与 WPE 抓帧一致）；属性面板把 `glow` 改成 3 后为 1.5，改回。
- **暂停**：预览暂停时脚本不跑（探针 update 计数不增），恢复后接着跑、计时器不跳。
- **帧时间**：bedroom 预览时探针 `stats().frameMs` 的均值与 p95，和宿主 rAF / `GPUQueue.submit` 次数（预期约 144.5 / 60 次每秒），记进回归表。
- **日志**：在 realm 里经 CDP 注入一段会抛错的 `update`（只抛一次错、不循环）或用语料里本来就报错的场景，确认应用日志出现带行列的 `warn`、之后不再重复。

## 风险

1. **realm 探针**：已成立（实施记录「步骤 0」）。经典脚本、blob 模块、`file:` 模块与 import map 都可用，不需要说明符改写。
2. **跨 realm 的类型判断**：宿主侧不能用 `instanceof`；脚本侧的值必须用 realm 的构造器造，漏一处就会出现「脚本里 `instanceof Vec3` 为 false」这类与 WPE 不同的行为。
3. **模块加载是异步的**：首次加载多了 N 次顺序 `import()`（步骤 0 量用时）；加载期间 Worker 编译与模块求值不能重叠（求值要在 bundle 到达之后）。工坊场景动辄几十到上百段。
4. **同步脚本拖慢帧**：脚本每帧在渲染之前同步跑，写得重的脚本直接拉长帧时间、拖慢同一进程里的其它宿主（同窗口的宿主同进程，3-0c）；只能靠 15 s 规则兜住极端情况，平时没有预算控制（WPE 同样如此）。
5. **墙钟脚本与回归哈希**：bedroom 一类用 `Date.now()` 的脚本让固定 `g_Time` 的哈希失去意义；哈希回归只用无脚本或不随墙钟变的场景。
6. **未实现 API 的大面积报错**：`engine.registerAudioBuffers` 在 10 张壁纸的 125 段里于模块顶层调用（F），这些段会整段求值失败；它们所在的场景目前都另有阻塞，所以不影响画面，但语料表里会很显眼。
7. **微任务时机**：WPE 推断在每个最外层回调后冲刷微任务，我们要到本任务结束才跑；样本没用 Promise（F），差异只在理论上。
8. **共享渲染进程**：同一窗口的宿主共用一个渲染进程，一个场景的脚本卡死会连带同窗口的另一个宿主（预览与应用背景）；与网页壁纸卡住同一处理（已定 3）。

## 已定（2026-11-03 用户）

1. **同步执行，不用 Worker**：把场景抽到 iframe 宿主就是为了在里面同步跑脚本。顺序同 WPE：每帧计时器 → `update`（返回值当帧写回）→ 渲染；`thisLayer` / `thisScene.getLayer()` 等是直接作用于渲染状态的真对象。
2. **脚本 realm**：宿主内建一个同源 `about:blank` 子 frame 作独立 realm（同进程同线程，宿主同步调用其中函数），对应 WPE「渲染线程上一个独立 V8 Context」；只是隔离不是安全边界。可行性先做探针（步骤 0），不成立就停下汇报，不自行改方案。
3. **卡住**：记录每个回调的耗时；单次超过 15 s 就在它返回后停掉本场景全部脚本，画面按最后的值继续，写应用日志；真正的死循环接受卡住（靠现有 ping / CEF 机制）。验收不包含让宿主或脚本死循环 / 忙等 / 卡住的测试，15 s 规则只用注入时钟的单测验证。
4. **环境对齐 WPE**：遮掉 WPE 没有的东西，`console` 只有 `log` / `error`（`console.warn` 照 WPE 抛错）；只为画面一致，不是安全边界。（2026-11-05 用户改为「不遮蔽、只改写同名全局」，由 3c 点 0 实施，见 3c 已定 4。）
5. **未实现的 API 不做静态扫描**：照常运行，调用时报错只禁用那个回调，可能画出半成品；脚本相关不再进 `unsupported`（`value:script` 随本阶段删除；渲染能力的 `unsupported` 与 D4 照旧）；报错写应用日志。（2026-11-07 用户改定：能力表静态扫描会执行的脚本，用到 WPE 有、我们没实现的 API 就报 `script:api:<分组>.<成员>`、整张退回预览图；表来自 WPE 自带的 `lib.sceneScript.d.ts` 减去已实现部分，见 `compile/scriptApi.ts`，提交 `c8ebf098`。起因是工坊 3304642534 的 `init` 调 `thisScene.createLayer` 失败后音频条静默缺失。运行期的普通脚本错误仍只禁用回调、写日志，不进 `unsupported`。）
6. **API 分阶段**：本阶段先做「最小 + 骨架」（见总体设计思路末段）；做完用本机语料验证能解锁哪些新壁纸、脚本运行有无报错，据此再排后续 API 阶段。
7. **重编译时保留脚本 realm 与脚本状态**，不重跑 `init`。
8. **默认照 WPE**（D / I 节）：加载顺序、增量顺序与转换、两帧之间处理下一帧生效、`init` 不重跑、返回值写回规则、`thisLayer` / `thisObject` 的全局 getter 与计时器归属、出错只禁用该回调、模块求值失败整段不用、暂停时脚本也停、计时器按帧 dt 推进、裸模块名转小写映射到 `assets/scripts/jsmodules/`、`baseclasses.js` 先作经典脚本执行；不照搬 `engine.userProperties` 改值后丢内置键、CLI 改颜色后成字符串两个缺陷。
9. D10（脚本静态规则）于 2026-11-02 推翻，本阶段删除其实现；D1 细化为「同线程、独立 realm（同源子 frame）」。

10. **模块加载**（步骤 0 之后定）：用户脚本不落文件，仍用 blob 模块；WPE 的 jsmodules 与 `baseclasses.js` 直接以 `file:` 加载。
    import map 按场景动态生成：扫到的每个说明符原样作键，转小写找到 `jsmodules/<小写名>.js` 后映射过去；jsmodules 自己的说明符扫描结果由宿主内存缓存，不每次扫（点 2）。不改写源码。
11. **按推荐**（用户 2026-11-03「其他问题按推荐」）：说明符扫描用 es-module-lexer；语法错误的位置用 `<script type="module" src=blob:>` 的 `error` 事件补拿（零依赖，不引入 acorn / babel）；参数是变量的动态 `import()`（理论上能加载远程模块，且 `import()` 是语法遮不掉）本阶段不处理，记入后续——与已定 4「环境对齐不是安全边界」一致。

## 待定（附推荐）

1. **`init` 时 `scriptProperties` 里绑了用户属性的键取什么值**：报告没有直接证据（I10 的样本默认值与脚本默认值相同，分不出）。WPE 首次加载先把配置里的属性写进全集、再构造场景（I1），解析期读到的就是用户当前值。**推荐**：求值之后、`init` 之前，用「JSON 的 `scriptproperties`，`{user}` 取用户当前值」调一次 `updateScriptProperties`；首次全量 apply 时再写一遍同一值（幂等）。
2. **WPE 注入的 14 个内置伪属性**（`rate`、`alignment*`、`wec_*`、`wcc_*`，I4 / I10 第 1 步）：首次 apply 与 `engine.userProperties` 里要不要有。**推荐不注入**：我们不实现对齐与颜色校正（I7 第 11 条）；WPE 自己在第一次改值后也会把它们从全集里丢掉，脚本无法依赖。工程自己声明的 `schemecolor` 照常作为普通属性。
3. **`console` 去向**：**推荐** `console.log` 只进宿主 DevTools 控制台（WPE 壁纸模式下 `console.log` 也不写 `log.txt`，I4；本机有 6 张壁纸 50 段调用，不少在每帧里）；`console.error` 进应用日志 `warn`，同一段脚本每分钟最多 10 条，超出的计数在下一条里带上。
4. **`Intl` / `WebAssembly` 要不要遮掉**：A 推断 WPE 两者都没有，样本都没用。**推荐遮掉**，与 WPE 一致；`Date.prototype.toLocaleString` 等仍会走 Chromium 自带的 ICU，输出与 WPE 可能不同，记作已知差异。
5. **`engine.screenResolution` 取什么**：WPE 是显示器分辨率。**推荐** 取宿主画布的像素尺寸（桌面壁纸窗口即显示器尺寸，预览为预览画布尺寸），`isPortrait` / `isLandscape` 随之；`canvasSize` 固定为场景正交尺寸。
6. **脚本写 3a 里只能重编译的目标**（effect `visible`，本机 3 张壁纸 13 段脚本挂在 `effects[].visible` 上；general 的 `clearcolor` 等）：3c 之前每次写都重编译会让每帧返回值的脚本每帧重编译。**推荐**：值真正变化时才触发，合并在途的重编译（同一时刻最多一个，结束后若又变了再来一次），日志 `debug`；3c 起 effect 可见性改单图层重算、不再重编译。
7. **general 上的脚本里 `thisLayer` 是什么**：报告没有证据。**推荐** `null`（推断），开工时若官方文档有说法以文档为准。
8. **语料求值放在哪里跑**：**推荐** 在真机 dev 宿主里经探针跑（点 10 的 `scriptCorpus`，与运行时同一套 realm 实现）；Node 里只做逻辑单测（`FakeRealm`），不在 Node 里模拟 realm（`vm.SourceTextModule` 要实验开关，且与 Chromium 的模块加载不同）。
9. **`setInterval` 的周期补偿**：**推荐** 触发后「剩余时间 += 周期」（长期平均频率不漂，同 `FrameThrottle` 的固定节拍）；若一帧 dt 跨过多个周期，只触发一次、剩余时间对齐到下一周期（避免卡顿后连发）。属推断，WPE 实际行为未查。
10. **有脚本的场景里，初始隐藏的图层要不要预建 GPU 资源**（步骤 4 复核时发现，步骤 5 接入前定）：3a 只给 `{user}` 绑了 `visible` 的图层预建资源（`visibleBound`），其余 `visible: false` 的图层不建。脚本能经 `thisScene.getLayer(…).visible = true` 显示任意图层，也有脚本直接挂在 `visible` 上（F：19 段）；不预建的话写入落在 `SceneState` 上、画面不出现。本机 dino_run 36 个对象里 25 个初始隐藏、1 个 `visible` 挂脚本（P6 样本），P3 的三张样本没有这种情况。**推荐**：`bundle.scripts.list` 非空时，全部图层按 `visibleBound` 处理（预建、`encode` 时按状态跳过），WPE 本来就给全部对象建资源；代价是隐藏图层的合成 RT 与管线占显存。
11. **材质常量 owner 的 `thisObject` 暴露哪些名字**：步骤 4 只暴露「同一 pass 上挂了脚本的常量」（vortex 的 `colormode` 够用）。计划点 4 写的是「该 pass 的材质常量名」。**推荐**：步骤 5 改为暴露该 pass 全部带 `meta.material` 的 uniform（与 3a 绑定表同一来源），脚本读其它常量不再是 `undefined`。
12. **`thisScene.getLayer(下标)` / `getLayerIndex` 的下标**：步骤 4 用 `bundle.layers` 的顺序。本机能渲染的场景对象全是图片、bundle 层数等于 `objects` 数（bedroom 18 = 18），两者一致；粒子、文本、声音对象进不了 bundle（它们所在的场景现在都退回预览图）。**推荐**：步骤 5 改为按 `scene.json` 的 `objects` 下标（与 WPE 的图层顺序一致），bundle 里没有的对象返回 null，留到 P4 / P6 补全。

## 后续

- **材质 JSON 内的脚本**：本机工坊 3549863808 的 `materials/workshop/2778900105/bar.json` 有 1 段脚本；本步只收集 `scene.json`，该场景另有渲染阻塞，后续再定材质脚本的收集与 owner。
- **3c**：effect 可见性单图层重算（脚本写 effect `visible` 不再重编译）及其余能就地改的类别。
- **动态 `import()` 与远程模块**：脚本 realm 是 `file:` 来源、没有 CSP，参数为变量的 `import()` 能加载任意 URL。可选的收口是给子 frame 文档插一条只放行 `blob:` / `file:` 的 CSP（未测）。
- **工程自带的 jsmodules**：若遇到工程目录或 pkg 里带 `scripts/jsmodules/*.js` 的场景，核对 WPE 的查找顺序；pkg 里的条目没法用 `file:` 地址，要退回 blob。
- **后续 API 阶段（初排，步骤 6 的语料排行出来后修订，交用户定）**：
  - 音频：`engine.registerAudioBuffers` / `AUDIO_RESOLUTION_*`（F：10 张壁纸 125 段，模块顶层调用）→ 随 W2 / W3 的音频订阅；
  - 光标与命中：`input.*`、`cursor*` 回调 → W4；
  - 层级：`thisLayer.getParent` / `getChildren`（3 张 39 段）→ W1 / W5；
  - 动画：`thisObject.getAnimation`、`thisLayer.getTextureAnimation`（7 张 / 3 张）→ W5 / P6；
  - 建层删层与排序：`createLayer` / `destroyLayer` / `sortLayer`、`registerAsset` → P6；
  - `localStorage`（WPE API）→ P6；文本 `thisLayer.text` 等 → P6；声音 `play / pause / stop / isPlaying` → P6 / W4；
  - 媒体事件 `media*Changed` → W5。

## 实施记录

### 步骤 0 探针结果（2026-11-03，Windows Kabegame dev / CEF 149）

在图库 `/gallery` 打开图片 12889（razer_vortex）预览，确认 CDP 目标为 `file:///D:/Codes/kabegame/target/debug/resources/wpe-scene/index.html?kbScene=12889&…` 后，在该宿主求值。原始完整结果见 `ignore/p3b/result.json`，驱动与注入代码为 `ignore/p3b/probe.mjs`、`ignore/p3b/probe-host.js`。

| 项 | 结论 | 证据摘要 |
| --- | --- | --- |
| 1. 建 realm | 成立 | `display:none` 与 `hidden` 两种子 frame 均 `sync:true`、`origin:"file://"`、`secure:true`、计算样式 `display:"none"`；`location.origin` 均为 `"null"`，不能把它当成同一个字符串判据。 |
| 2. 经典脚本 | 成立 | `fetch(baseclasses.js)` 为 HTTP 状态 200、长度 38646；内联执行后 `_Vec3` / `_Internal` / `shared` / `createScriptProperties` 均为全局属性，`"Vec3" in child === false`，随后模块的 `typeof Vec3 === "function"`。对照 `child.eval(base)` 后 `eval('typeof Vec3') === "undefined"`。 |
| 3. blob 模块 | 成立 | 子 frame 自造两个同源码 URL：模块内 `globalThis === child` 为 true；两份实例各自的模块级计数调用结果为 `[1,2,1]`，顶层全局计数依次为 1、2；宿主同步调用导出函数得到 3。 |
| 4a. import map | 成立，大小写需逐种登记 | `wecolor` / `wemath` / `wevector` 原文均读到状态 200；预先映射 `WEColor` / `WEMath` / `WEVector` 后，`WEVector` 内部的 `import 'WEMath'` 成功，导出含 `angleVector2` / `vectorAngle2`。两个入口引用同一模块 URL 的求值计数为 1。小写 `wecolor` 未登记时报 `Failed to resolve module specifier "wecolor". Relative references must start with either "/", "./", or "../".`。首次 import 后新增映射 `P3BLate` 仍解析为 1，故“必须首次 import 之前登记”在本环境不成立。 |
| 4b. 改写说明符 | 未测（按计划） | 4a 已成立，未走回退路径。 |
| 5. 跨 realm | 部分 | 抛错在宿主 `instanceof Error === false`，运行时报错栈含 `blob:file:///…:1:31`；模块语法错误由 `import()` rejection 给出 `SyntaxError: Unexpected token ';'`，但其 `stack` 只有这一行，**不含行列**。子 frame `_Vec3.constructor` 构造的值在模块里 `instanceof Vec3 === true`，宿主普通对象为 false。 |
| 6. 遮蔽 | 部分 | 表中每个名字分别在独立 frame 做 `delete`、`defineProperty(...undefined, configurable:false)` 和随后模块的 `typeof`。网络、全局计时器、Web Storage、`indexedDB`、`caches`、`Intl`、`WebAssembly` 均得到 `undefined`；`console` 可替换，模块调用 `console.warn` 报 `TypeError: console.warn is not a function`。`__TAURI_INTERNALS__`、`window`、`document`、`top`、`location` 的 `delete` 为 false，重定义报 `TypeError: Cannot redefine property: <name>`，模块仍见 `object`。与预期不同，`parent`、`self`、`frames` 的 `delete` 为 true，随后模块见 `undefined`。 |
| 7. 帧与性能 | 部分 | 仅留一个隐藏子 frame 时，1.1 s 内宿主 rAF 160 次（约 145.5/s），临时包装的 `GPUQueue.submit` 67 次（约 60.9/s），包装已恢复。100 个小 blob 模块顺序导入全部成功，合计 **302.1 ms**、均值 **3.021 ms**。移除 frame 后持有的 window 引用 `closed === true`，但其旧函数仍可调用并返回 42；这不能证明 realm 已被回收。 |

**对后续步骤的影响。** 采用 4a import map；构造映射时须扫描脚本与 jsmodules 的原样说明符，将不同大小写的写法都映射到小写文件对应的同一 blob URL。4b 不需要。错误格式不能假定模块语法错误的 `stack` 有行列，应把“行列未知”作为可记录结果，若后续要求精确位置需另找证据来源。环境对齐无法遮掉 `__TAURI_INTERNALS__`、`window`、`document`、`top`、`location`；`parent` / `self` / `frames` 与点 3 表的预期相反，但子 frame 同源同权限，遮蔽仍不是安全边界。顺序导入的最后一轮实测为 302.1 ms / 100 个模块，属此机器此轮测量，不作为固定性能预算。

**临时改动与恢复。** 只打开了 12889 的图库预览并在其宿主新建子 frame、blob URL、一次临时 `GPUQueue.prototype.submit` 包装；探针撤销 URL、移除全部测试 frame，`remainingFrames:0`、`global:false`，并在 `finally` 里恢复原 `submit`。随后关闭预览，CDP 目标中只剩原有 12888 壁纸宿主；主窗口路由由 `/gallery` 回到 `/gallery`。未更改壁纸、图库数据、设置或产品代码。

### 步骤 0 补充（2026-11-03，主会话）

`file:` 模块（主窗口应用背景宿主 12888 里建隐藏子 frame 实测，脚本 `ignore/p3b/filetest.js`，结果 `ignore/p3b/filetest-result.json`；临时测试模块写在宿主目录、测完删除）：

| 项 | 结果 |
| --- | --- |
| `<script src="file:…/jsclasses/baseclasses.js">` 作经典脚本 | 成立：随后模块里 `typeof Vec3 === "function"`、`"Vec3" in child === false`、`_Internal` 在 |
| 直接 `import("file:…/jsmodules/wemath.js")` | 成立 |
| import map 映射到 `file:`，`wevector.js` 内部的 `import 'WEMath'` | 成立；同一 URL 只求值一次 |
| 宿主目录里的 `.js`（代表「脚本落成文件」） | 成立；运行时报错栈为真实路径 `kbtest-ok.js:9:8`。用户定：用户脚本不落文件 |
| 同一文件不同 query | 两个独立实例 |
| 语法错误的 `file:` 模块 | 同 blob，rejection 只有 `SyntaxError: Unexpected token ';'`，无行列 |
| 范围外的 `file:` | 闸门拒绝（`deny file: … OutsideRoot`） |
| blob 模块 import `file:` 模块 | 成立，可混用 |
| 语法错误补位置：`<script type="module">` 的 `error` 事件 | 内联与 `src=blob:` 都给 `lineno: 3, colno: 11`（1 起）；blob 那种带 `filename` |

说明符扫描（`ignore/p3b/specifiers.mjs`，本机默认工程 + 工坊抽取，206 份不同源码 = 203 段用户脚本（共出现 652 次）+ 3 个 jsmodules）：
- 导入共 19 处，全部是静态 `import * as X from '…'`；没有动态 `import()`、`export … from`、副作用导入。写法只有 `WEColor` 9、`WEMath` 9、`WEVector` 1，都是标准大小写。
- es-module-lexer 3.2 ms、0 失败；正则 0.95 ms、1 处误报（注释掉的导入）；acorn / @babel/parser 都能解析全部 206 份（约 36 ms），语法错误给 `(3:10)`（列 0 起）。
- 等长改写成小写（对照）：0.06 ms，改写后长度不变、重新扫描结果正确。按用户方案不改写源码，只按场景生成 import map。

### 步骤 1–2 实施记录（2026-11-03）

- 新增 `compile/scripts.ts`：在编译早期遍历完整 `scene.json`，不受图层可见性、effect 开关与快速回退影响；用 es-module-lexer 扫原样说明符，非裸名记入脚本错误。稳定 id 使用 JSON 坐标。`scriptproperties` 的用户属性引用登记为 `script-property` 绑定。材质常量的 uniform 名和类型在对应 pass 成功编译后补齐；没有编译出的 pass 保留脚本与目标坐标，uniform 列表为空，待后续步骤的宿主写入接口判为不可写。bundle 不带 jsmodules / baseclasses 源码；`value:script` 与 `isStaticScript` 保持原状。
- 新增 `script/runtime.ts`：`ScriptRealm` 只定义接口，真实 iframe realm 留待步骤 3；读写目标、日志、时钟、当前脚本上下文和用户属性全集均由宿主注入。模块按表顺序求值，随后按表顺序初始化；属性增量依次更新命中的 `scriptProperties`、调用 `applyUserProperties`；每帧计时器先于 `update`。回调出错只禁用该回调；计时器出错取消该计时器；超过 15 秒在回调返回后停止所有脚本，保留本次返回值写回。重编译接口重放最后脚本写入，用户直接绑定可按稳定目标键撤销覆盖。
- 新增 FakeRealm 单测及本机语料测试。38 张场景中 23 张含 `scene.json` 脚本，共 638 段；说明符为 `WEColor` / `WEMath` / `WEVector`，扫描错误 0。报告 F 节的 639 段还包含 1 段材质 JSON 中的脚本，本步骤按指定范围仅收集 `scene.json`。根目录已有 es-module-lexer 1.7.0，仅登记应用依赖并手动同步 `deno.lock` workspace 条目，未安装依赖。
- **主会话复核（2026-11-03）**：`git status` 无越界（只有 `apps/wpe-scene` 与 `deno.lock` 的 workspace 依赖登记）；宿主 tsc 0 error、vitest 12 文件 182 项全过（含本机语料）；临时编译 vortex / bedroom / shimmering 核对脚本写回目标：vortex 3 段 → `g_CMode`（float）、bedroom 6 段 → `g_TintColor`（vec3）、shimmering → 泛光 `strength`，pass 键与 3a 一致。
  - **修正**：`setInterval` 的周期补偿原为 `ceil(超出 / 周期 + 1)` 个周期，只要触发时有超出就多加一个周期（60 fps 下 `setInterval(1000)` 跑 10 s 只触发 5 次）；改为 `floor(超出 / 周期) + 1`。补了两条断言：一帧跨多个周期后按次数核对，以及 60 fps 跑 10 s 触发 10 次。换回旧公式两条都失败。
  - **遗留**：材质 json 里的 1 段脚本（报告 F 节）本次没收集，步骤 5 接入前确认它在哪张场景、是否要收。

### 步骤 3 实施记录（2026-11-04）

- 新增 `script/realm.ts`：宿主内存按 `sceneAssets` 缓存 `JsModuleIndex`（含缺失结果），以 `file:` 顺序读取并用 es-module-lexer 扫 jsmodules；按脚本原样说明符及模块递归依赖生成 import map。每个场景建隐藏 `about:blank` frame，先遮蔽环境并插 import map，再从 assets 加载 `baseclasses.js`，取回原型与 `_Internal`。用户源码在子 frame 的 blob 模块中求值，语法解析失败时以第二份 blob 的模块脚本 `error` 事件补行列，1 秒超时回退；释放时移除 frame 并主动断开宿主侧引用。
- 新增 `script/environment.ts`：按点 3 遮蔽表处理网络、全局计时器、Web Storage、`Intl`、`WebAssembly`，并根据步骤 0 实测一并删除 `parent` / `self` / `frames`。不可配置的五项尝试后保留并记 debug；`console` 换为仅有 `log` / `error` 的普通对象，输出由调用方提供。
- 新增 dev `host.realmCheck()`：从当前 bundle 与 `wpe_scene_target` 建独立 realm，逐段只求值不调用回调，返回 import map、每段状态与导出、环境实测、模块缓存两轮读取数、耗时和释放后剩余测试 frame 数。未接入正式宿主加载或渲染。
- Node 逻辑单测覆盖映射大小写与递归、首个 assets 命中及成功/缺失缓存、遮蔽表。步骤 3 的真机 `realmCheck()` 由主会话后续执行；本次仅完成 TypeScript、Vitest、Prettier 与 development 构建检查。
- 与点 2 的细化：`baseclasses.js` 按 `sceneAssets` 顺序尝试，全部失败才 reject 一次；`SyntaxError` 若已有 blob 行列栈，视为模块运行时抛错，不二次加载源码，避免副作用重复执行。
- **主会话复核与真机验证（2026-11-04）**：`git status` 无越界、未写 `target/`；宿主 tsc 0 error、vitest 13 文件 185 项全过、Prettier 通过。主会话给 dev 探针加了可选参数 `realmCheck(extraSources?)`（额外求值几段测试源码，覆盖语法 / 链接错误的行列补拿），以 development 模式重建宿主后经 CDP 在主窗口预览宿主里跑（脚本与结果 `ignore/p3b/step3/`）：

  | 场景 | 结果 |
  | --- | --- |
  | razer_vortex 12889 | 3 段求值成功（导出 `applyUserProperties`），import map 为空；额外源码：语法错误 → `Unexpected token ';' (line 3, col 11)`，顶层运行时错误 → `Cannot read properties of null (reading 'play') (line 2, col 6)`；遮蔽表 22 个名字为 `undefined`，`__TAURI_INTERNALS__` / `window` / `document` / `top` / `location` 仍为 `object`（预期）；`console.warn` 抛 `TypeError`；`Vec3` 在模块里为 `function`、不在全局对象上；用时 31 ms；释放后测试 frame 0 |
  | razer_bedroom 12888（dev 强制渲染） | import map 只有 `"WEColor": "file:///…/assets/scripts/jsmodules/wecolor.js"`；6 段求值成功（导出 `update`）；额外源码：导入 `WEColor` 成功，导入不存在的导出名 → `The requested module 'WEColor' does not provide an export named 'nope' (line 1, col 10)`，导入不存在的模块 `WENope` → `Failed to resolve module specifier "WENope"…`；模块缓存首次读 1 个文件、再生成 map 读 0 个、命中 11 次；用时 46 ms；frame 0 |
  | shimmering_particles 12892（dev 强制渲染） | `general/bloomstrength` 1 段求值成功（导出 `applyUserProperties`）；用时 13 ms；frame 0 |

  - `WEVector` → `WEMath` 的递归补齐只有单测与步骤 0 探针覆盖：本机唯一用 `WEVector` 的是 1 段工坊脚本，其场景另有渲染阻塞，bundle 建不出来。
  - 临时改动：强制渲染标志（测前为 null）测完删除；预览依次切过 12889、12888、12892 后按 Esc 关闭，主窗口回到 `/gallery`，只剩原有的应用背景宿主。

### 步骤 4 实施记录（2026-11-04）

- 新增 `script/api.ts`：在脚本 realm 内创建 `engine`、`thisScene`、图层、材质常量、effect 与 general 对象；`thisLayer` / `thisObject` 为全局 getter，随 runtime 当前脚本切换。向量与数组用 realm 构造器创建；图层对象按 `objects` 下标缓存，重编译后仍是同一对象。状态通过注入的 bundle / `SceneState` 访问层读写；重编译目标通过注入的 `write` 回调交宿主，API 只抑制重复值并提供 `forgetRecompile` 供用户绑定覆盖后失效。步骤 5 尚未把这些回调接进正式宿主。
- runtime 增加模块求值阶段通知；原有 `enterScript`、`setProperties` 与按帧计时器接口连接 API。`engine.userProperties` 从累计全集经 realm 的 `convertUserProperties` 转换，下一次 `setProperties` 才重建缓存，颜色保留 `Vec3`，也不丢其它键。
- `realmCheck` 新增 `api` 结果：`topLevelFrametimeThrows`、`frametime`、`count`、`enumerated`、`firstName`、`vec3Instance`、`alphaBefore`、`alphaAfter`。它在独立 realm 中求值，图层写入仅修改从当前 bundle 新建的 `SceneState`；本次未连 CDP，真机返回值仍待步骤 5 之前的独立验收。
- FakeRealm 单测覆盖 API 作用域、属性、图层查找及跨重编译身份、向量复制、角度、只读 size、四类 owner、材质 uniform 形状、泛光参数及未提供 API 的调用错误。官方 `IScene.getLayerIndex` 签名为 `String|ILayer`，同时支持两者；`getLayer` 未命中时官方文档未注明返回值，按计划返回 `null`。`general` 中无法从当前 `SceneGeneral` 读出的相机参数暂返回 `undefined`，写入仍交重编译回调；`bloomhdr*` 按现有 `BloomParams` 的实际字段（feather、scatter、iterations）提供。
- 自检：宿主 TypeScript 0 error；Vitest 14 文件 189 项全过；development Vite build 成功，输出在 `ignore/p3b/build-check`；修改过的 TS 文件 Prettier `--check` 通过。正式宿主加载、渲染及真机行为仍属步骤 5。
- **主会话复核与真机验证（2026-11-04，步骤 4）**：`git status` 无越界；宿主 tsc 0 error、vitest 14 文件 189 项全过、Prettier 通过。以 development 模式重建宿主后经 CDP 跑 `realmCheck()`（结果 `ignore/p3b/step3/api-*.json`）：
  - razer_vortex：`topLevelFrametimeThrows: true`（模块求值期间读 `engine.frametime` 抛错），调用时 `frametime` 0.016；`getLayerCount()` 3、`enumerateLayers()` 3、`getLayer(0).name` 为 `vortex`；`origin instanceof Vec3` 为 true；`alpha` 写 0.25 后读回 0.25（只写探针自己的状态副本）；3 段求值成功，测试 frame 0。
  - razer_bedroom（dev 强制渲染）：同上各项，层数 18、首层 `backgroundclear`；6 段求值成功。
  - 临时改动：强制渲染标志测完删除；预览按 Esc 关闭，主窗口回到 `/gallery`。
  - 复核时发现三处要在步骤 5 接入前定，见「待定」第 10–12 条。

### 步骤 5 实施记录（2026-11-04）

- 渲染器在实际渲染帧同步状态前调 `beforeFrame(dt)`，`load` 在首帧前交出新 `SceneState`；暂停或隐藏时不推进脚本。宿主仅在可渲染且有脚本时建 realm / API / runtime，依次求值、初始化、全量 apply、首帧 update、绘制、ready。realm 在属性重编译与设备重建时复用；直接写入与返回值都登记稳定目标键，重编译前重放，用户直接绑定覆盖时撤销该键。退回时保留 realm、停止帧，恢复时全量 apply，保留 3a 的加载期间增量补差。
- 删除 `isStaticScript` / `scriptExports` 与 `value:script` 裁决。38 张本机语料的 `exhaustive` 测试通过；相对 3a，razer_bedroom 由仅 `value:script` 变空，dino_run、3146703458、3549863808、3637191856 各删去 `value:script`，仍有其它不支持项；其余 33 张的结论未变。有脚本时全部材质图层预建资源；材质 owner 暴露同 pass 全部 `meta.material` 常量；图层数字查询按 `objects` 下标。
- 增加脚本诊断与 `scriptCorpus` dev 探针。后者顺序逐张强制、穷尽编译，独立 realm 运行 120 个固定 dt 帧，不建 GPU，逐张释放 realm、纹理 bitmap，并返回残留测试帧数。production 构建不含探针标识。`console.error` 每段每分钟最多上报 10 条，多余条数随下一条上报；`console.log` 仅写控制台。
- 与计划的实现细化：脚本写需重编译的目标通过 Worker 的 `scriptOverrides` 按 scene.json 稳定坐标覆盖编译输入；脚本重编译同一时刻最多一项在途，期间的后续变化再发一次。脚本从 API 直接写的值同回调返回值一起进入重放表。`scriptCorpus` 的资源读取使用现有 `SceneFs` 与 Worker 通道。
- Node 自检：TypeScript 0 error；Vitest 原三条宿主退回用例及新增生命周期 / 重编译用例均通过。development、production Vite build 成功；production JS 搜索不到 `__kabegameSceneProbe`、`scriptCorpus`、`realmCheck`。本次未做真机脚本渲染验收，留给步骤 6–7。
- **主会话复核（2026-11-04，步骤 5）**：`git status` 无越界；宿主 tsc 0 error、vitest 15 文件 193 项全过、Prettier 通过。dev 宿主以 development 模式重建、重载后，应用日志 `main: 场景脚本加载完成：6 段，成功 6 段，失败 0 段，用时 22 ms` → `场景壁纸 12888 开始渲染：18 层、7 个程序…`（bedroom 不再退回预览图）。
- **bedroom 与 WPE 抓帧对照（2026-11-04，代理，产物 `ignore/p3b/compare/`，汇总 `results.json`）**：
  - 公式：`A:\bedroom\{disabled,enabled,highres}` 共 9 帧 54 个 `g_TintColor`，按 `hsv2rgb(Date.now()/2000*speed%1,1,1)` 在整数毫秒 T 上逐位相等（highres-1463 有 1 段比其余早 1 ms：每段各自调 `Date.now()`）。T 只能确定到模 200 s，取离抓帧文件修改时间最近的解（前 0.3–2.0 s）。
  - 画面：把 WPE 每帧的 6 个 tint 与 `g_Time` 注入预览宿主后读回，与后备缓冲逐像素比较（HDR 档按 sRGB 编码成 8 位）：关闭 / 开启档通道平均差 0.038/255、p99 2、差值 > 4 的像素 0.24%；超高档 0.055/255、p99 2、0.24%。灯带区域平均色各通道差 ≤ 0.26/255；随 tint 变色的像素内平均差 0.35–0.62/255（tint 错开约 0.5 s 时为 13–29）。残差集中在细线与高对比边缘（最大 51；超高档桌垫细线 112），三档相同、与 tint 和泛光无关；±0.5 px 平移不能减小，推断是对象 FBO 合成进场景时的采样差，未查。
  - 实时：update 约 60 次/秒、色相速度与 speed/2 相符、相位差不超过一帧；rAF 144 次/秒、submit 60 次/秒；探针 frameMs 均值 0.19 ms、p95 0.4 ms；6 段无报错。
  - 测量方法上的缺口：dev 探针没有「写目标」入口，代理临时改写 `SceneState.constants` 并借原型包装让 `sync` 刷新、截取读回缓冲（测完全部还原）。后续给探针加 `host.write(path, value)` 更稳妥。
  - 临时改动：「场景后处理」由 `disabled` 依次改为 `enabled` / `ultra` 再改回 `disabled`（连带应用背景与壁纸窗口宿主各重载 3 次，realm 未重建）；预览宿主暂停后已恢复。qrenderdoc 停在 `highres-frame1463.rdc`（桥接没有关闭抓帧的方法）。

### 步骤 6 语料（2026-11-04）

**做法。** 环境为 Windows dev（CEF 149），宿主产物是 2026-11-04 的 development 构建，已含 `scriptCorpus`，本步骤未重建。

- **取 id**：在主窗口应用页经 `pathql_fetch("images://gallery/media-type/image/scene/_kb_x500x/1")` 只读取得 38 行，`type` 全为 `x-wpe/scene`。`pathql_all` 计数 38，与 `media-type/image` 格式列举里的 `scene` 38 一致。
- **调用**：在主窗口应用背景的 bedroom 宿主（12888）里逐张调 `scriptCorpus([id])`。每张异步启动、1 s 轮询结果；宿主 90 s 无应答即停，没有触发。
- **防卡住**：开跑前静态扫了 638 段源码里的循环，只有 3286859278 一处 `while`（随机换歌，`audioLayers.length > 1` 时按概率结束）。计时器回调里新登记的计时器不会在同一帧触发。据此判断不会卡住。
- **数据**：驱动与数据在 `ignore/p3b/corpus/`，包括 `ids.json`、`raw/<id>.json`、`summary.json`、`table.json`、`errors.json`、`ranking.json`、`runtable.json`、`static-api.json`；归类脚本为 `analyze.mjs` / `rank.mjs` / `runtable.mjs` / `staticapi.mjs`。

结果：
- 38 张全部跑完，共约 42 s，单张编译加运行 37–1847 ms。单个回调最长 1.4 ms，没有触发 15 s 停止。`update` 每段 120 次（出错被禁用的除外），`init` 与首次 `applyUserProperties` 各 1 次；计时器 3 段共触发 5 次。
- 宿主里 `iframe[data-kb-script-realm="1"]` 调用前为 1（宿主自己的 realm），每张跑完与全部结束后都是 1，没有残留测试 frame。临时全局 `window.__kbCorpus6` 已删除。
- 交叉核对：宿主 Worker 编译（`postprocess: "follow"`，本机 WPE 为 `disabled`）的 `unsupported` 与 Node 语料测试（`pipeline.test.ts`，`postprocess: "disabled"`）逐张相同，38/38。

**解锁清单。** `unsupported` 为空的有 5 张：beach、deep_space、eagleflag（这三张无脚本）、razer_vortex（3 段）、razer_bedroom（6 段）。相对 3a 结束时，新解锁的只有 **razer_bedroom**，与本步骤的预期一致。其余报过 `value:script` 的 4 张都只少了这一项，仍然退回。

逐张对比如下。3a 列是本次结果加上步骤 5 记录里删去的 `value:script`，没有重新运行 3a 的代码。

| 场景 | 脚本段 | 3a 结束 | 现在 | 变化 |
| --- | --- | --- | --- | --- |
| arsenal（12878） | — | 5 项 | 5 项 | 不变 |
| audiophile（12879） | — | 5 项 | 5 项 | 不变 |
| beach（12880） | — | 空 | **空** | 不变 |
| deep_space（12881） | — | 空 | **空** | 不变 |
| demon_core（12882） | — | 6 项 | 6 项 | 不变 |
| dino_run（12883） | 3 | 22 项（含 `value:script`） | 21 项 | 删去 `value:script`，仍退回 |
| dna_fragment（12884） | — | 3 项 | 3 项 | 不变 |
| eagleflag（12885） | — | 空 | **空** | 不变 |
| fantasticcar（12886） | — | 3 项 | 3 项 | 不变 |
| neon_sunset（12887） | — | 6 项 | 6 项 | 不变 |
| razer_bedroom（12888） | 6 | 1 项（含 `value:script`） | **空** | **新解锁** |
| razer_vortex（12889） | 3 | 空 | **空** | 不变 |
| retro（12890） | — | 1 项 | 1 项 | 不变 |
| ricepod（12891） | — | 6 项 | 6 项 | 不变 |
| shimmering_particles（12892） | 1 | 2 项 | 2 项 | 不变 |
| techno（12893） | — | 2 项 | 2 项 | 不变 |
| 2932157836（12894） | 44 | 31 项 | 31 项 | 不变 |
| 3146703458（12895） | 37 | 25 项（含 `value:script`） | 24 项 | 删去 `value:script`，仍退回 |
| 3219908811（12896） | 40 | 42 项 | 42 项 | 不变 |
| 3351072238（12897） | 67 | 46 项 | 46 项 | 不变 |
| 3351163962（12898） | 99 | 38 项 | 38 项 | 不变 |
| 3409595232（12899） | 3 | 40 项 | 40 项 | 不变 |
| 3429479356（12900） | 7 | 30 项 | 30 项 | 不变 |
| 3470764447（12901） | 51 | 38 项 | 38 项 | 不变 |
| 3524852519（12902） | 68 | 47 项 | 47 项 | 不变 |
| 3554161528（12903） | 5 | 50 项 | 50 项 | 不变 |
| 3600630828（12904） | 7 | 30 项 | 30 项 | 不变 |
| 3611425904（12905） | 9 | 37 项 | 37 项 | 不变 |
| 3656079027（12906） | — | 18 项 | 18 项 | 不变 |
| 3062029089（13102） | — | 1 项 | 1 项 | 不变 |
| 3326873240（13103） | 105 | 46 项 | 46 项 | 不变 |
| 3336377291（13104） | 13 | 33 项 | 33 项 | 不变 |
| 3445915391（13105） | — | 8 项 | 8 项 | 不变 |
| 3460973721（13106） | 9 | 30 项 | 30 项 | 不变 |
| 3637191856（13107） | 2 | 21 项（含 `value:script`） | 20 项 | 删去 `value:script`，仍退回 |
| 3286859278（13108） | 51 | 48 项 | 48 项 | 不变 |
| 3451555874（13109） | 7 | 29 项 | 29 项 | 不变 |
| 3549863808（13110） | 1 | 10 项（含 `value:script`） | 9 项 | 删去 `value:script`，仍退回 |

**脚本运行表。** 23 张有脚本，共 638 段（与步骤 1 的统计相同；材质 json 里的 1 段未收集）：
- 444 段求值与回调都没有报错；
- 127 段求值失败；
- 67 段有回调报错，共 98 条，每条都禁用了对应回调；计时器回调没有报错；
- 123 段把返回值写到不支持的目标：`text` 115、`maxwidth` 6、`instanceoverride/colorn` 2；
- 另有 209 段导出了本阶段不会调用的 `cursor*` / `media*` 回调。这一项来自静态扫描，运行时不报错。

| 场景 | 段 | 无报错 | 求值失败（构成） | 回调报错 = 被禁用的回调（根因） | 写回到不支持目标 | 导出未调用的 cursor* / media* | 渲染阻塞项 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| dino_run（12883） | 3 | 1 | 1（registerAsset 1） | applyUserProperties 1（thisObject.getMaterial 1） | 0 | 1 | 21 |
| razer_bedroom（12888） | 6 | 6 | 0 | 0 | 0 | 0 | 0 |
| razer_vortex（12889） | 3 | 3 | 0 | 0 | 0 | 0 | 0 |
| shimmering_particles（12892） | 1 | 1 | 0 | 0 | 0 | 0 | 2 |
| 2932157836（12894） | 44 | 43 | 1（registerAudioBuffers 1） | 0 | 6 | 8 | 31 |
| 3146703458（12895） | 37 | 37 | 0 | 0 | 0 | 37 | 24 |
| 3219908811（12896） | 40 | 22 | 16（registerAudioBuffers 16） | update 1、init 1（value 是布尔 1、thisObject.getAnimation 1） | 4 | 15 | 42 |
| 3351072238（12897） | 67 | 36 | 31（registerAudioBuffers 31） | 0 | 17 | 0 | 46 |
| 3351163962（12898） | 99 | 90 | 6（registerAudioBuffers 6） | update 3（input 1、isPlaying 2） | 29 | 61 | 38 |
| 3409595232（12899） | 3 | 3 | 0 | 0 | 2 | 0 | 40 |
| 3429479356（12900） | 7 | 6 | 0 | init 1、update 1（声音 2） | 2 | 0 | 30 |
| 3470764447（12901） | 51 | 32 | 18（scene 1、registerAudioBuffers 17） | update 1（getVideoTexture 1） | 14 | 2 | 38 |
| 3524852519（12902） | 68 | 41 | 9（registerAudioBuffers 9） | init 17、update 13（localStorage 1、getParent 12、连带 13、getTextureAnimation 4） | 8 | 22 | 47 |
| 3554161528（12903） | 5 | 4 | 0 | init 1（localStorage 1） | 2 | 4 | 50 |
| 3600630828（12904） | 7 | 6 | 0 | init 1、applyUserProperties 1（声音 2） | 3 | 0 | 30 |
| 3611425904（12905） | 9 | 9 | 0 | 0 | 3 | 6 | 37 |
| 3326873240（13103） | 105 | 64 | 21（scene 1、registerAudioBuffers 20） | init 17、update 15（localStorage 1、getParent 12、连带 13、getTextureAnimation 4、input 1、getVideoTexture 1） | 19 | 22 | 46 |
| 3336377291（13104） | 13 | 10 | 0 | init 3（thisObject.getAnimation 3） | 2 | 9 | 33 |
| 3460973721（13106） | 9 | 4 | 0 | init 5（localStorage 5） | 3 | 5 | 30 |
| 3637191856（13107） | 2 | 1 | 0 | update 1（value 是布尔 1） | 1 | 1 | 20 |
| 3286859278（13108） | 51 | 21 | 20（registerAudioBuffers 20） | init 10、update 5（localStorage 2、getChildren 1、getParent 5、连带 4、getTextureAnimation 3） | 5 | 15 | 48 |
| 3451555874（13109） | 7 | 4 | 3（registerAudioBuffers 3） | 0 | 3 | 1 | 29 |
| 3549863808（13110） | 1 | 0 | 1（registerAudioBuffers 1） | 0 | 0 | 0 | 9 |

表中「连带」指二次错误，有两种：同一段的 `init` 失败后，`update` 读到 `undefined`；或者读取另一段本该写进 `shared` 的值。归因见下表。

**缺失 API 排行。** 运行时报错按根因归类，按壁纸数、再按段数排序。连带错误已归到根因，没有无法归因的报错。

| # | 名字 | 归类 | 壁纸 | 段（报错条数） | 出错位置 | 涉及场景 / 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `engine.registerAudioBuffers`（连同 `AUDIO_RESOLUTION_*`） | 未实现的 WPE API | 10 | 124 段求值失败 + 2 段连带 | 模块顶层 | 2932157836、3219908811、3351072238、3351163962、3470764447、3524852519、3326873240、3286859278、3451555874、3549863808。失败的段整段不用。连带的 2 段是 3524852519 / 3326873240 的 `objects/{14,15}/color`：它们读 `shared.miTextContainerScale`，而写它的两段因本项求值失败。报告 F 节的 125 段里另有 1 段在材质 json，未收集 |
| 2 | `localStorage`（WPE 版，`get` / `set` / `delete` / `clear`） | 未实现（计划 P6） | 5 | 10 | `init` | 3524852519、3554161528、3326873240、3460973721、3286859278；都是拖拽脚本读 `localStorage.get("miDragable")` |
| 3 | `thisLayer.getParent` | 未实现 | 3 | 29（29 + 28 条连带） | `init` | 3524852519、3326873240（同一作者的时钟 UI）、3286859278。`update` 里读 `parent.scale`、`parent.origin`、`initValue.x` 等的 28 条报错都由此而来 |
| 4 | `thisLayer.getTextureAnimation` | 未实现 | 3 | 10（11） | `init` / `update` | 3524852519、3326873240、3286859278 |
| 5 | 声音图层 `play` / `stop` / `isPlaying` | 未实现 | 3 | 4（6） | `init` / `update` / `applyUserProperties` | 3351163962（脚本挂在 sound 对象的 `volume` 上，调 `thisLayer.isPlaying`）、3429479356（`cachedSongs[i].play`）、3600630828（`audioLayer.stop` / `play`） |
| 6 | `thisObject.getAnimation` | 未实现 | 2 | 4 | `init` | 3219908811、3336377291 |
| 7 | `input`（`cursorWorldPosition`） | 未实现 | 2 | 2 | `update` | 3351163962、3326873240 |
| 8 | `<图层>.getVideoTexture` | 未实现 | 2 | 2 | `update` | 3470764447、3326873240 |
| 9 | `engine.registerAsset` | 未实现 | 1 | 1 | 模块顶层 | dino_run `objects/22/visible` |
| 10 | `thisObject.getMaterial` | 未实现 | 1 | 1 | `applyUserProperties` | dino_run `objects/33/effects/0/visible` |
| 11 | `thisLayer.getChildren` | 未实现 | 1 | 1 | `init` | 3286859278 `objects/31/angles`；前面提到的 `while` 也因此不会执行 |
| 12 | `scene.getLayer` 伪代码 | 样本自身的错 | 2 | 2 | 模块顶层 | 3470764447、3326873240 的 `objects/0/visible`；WPE 也报 `ReferenceError: scene is not defined`（报告 F、H 节） |
| 13 | 拖拽脚本挂在 `visible` 上 | 样本自身的错 | 2 | 2 | `update` | 3219908811 `objects/13/visible`、3637191856 `objects/5/visible`。脚本是给 `origin` 写的拖拽脚本（注释写着「附加到图像层的原点属性」），却挂在了 `visible` 上：`init` 收到布尔，`update` 里 `value.x = …` 在严格模式下抛 `TypeError`。WPE 的 `visible` 同样是布尔，推断也会报错 |

**实现偏差。** 运行时报错里没有发现我们实现有偏差。另有两点行为与 WPE 不同，目前不影响画面：
- API 对象是可扩展的 `Object.create(null)`。给没有存取器的名字赋值（如 `thisLayer.text = …`），会在对象上新建一个普通属性，之后读回的就是这个值，既不报错也不生效；WPE 会写到真实属性。补文本等 API 时一并收紧。
- bundle 给 `scene.json` 的每个对象都建了图层项，包括 sound / text / particle。所以 `thisLayer` / `getLayer` 对这些对象返回的是带通用图层字段的对象，报的错是 `isPlaying is not a function`，而不是读 null。这与待定 12 写的「粒子、文本、声音对象进不了 bundle」不同。补声音、文本 API 时，要按对象类型给不同的图层对象。

**静态补充。** 下列各项运行时不报错，或在这 120 帧里没有走到。数字为「壁纸 / 段」。
- **不会被调用的回调**：`cursorDown` 13 / 71、`cursorUp` 12 / 69、`cursorMove` 11 / 61、`cursorClick` 10 / 86、`cursorEnter` / `cursorLeave` 8 / 45、`mediaThumbnailChanged` 7 / 32、`mediaPropertiesChanged` 6 / 12、`mediaPlaybackChanged` 4 / 19、`mediaTimelineChanged` 3 / 3。
- **文本图层**：返回值写 `text` 的 115 段（17 张），写 `maxwidth` 的 6 段；`thisLayer.text` / `horizontalalign` / `verticalalign` 的读写见于 2–3 张。
- **没走到的成员**：
  - `getTransformMatrix` 2 / 4（所在段求值已失败）；
  - `localStorage.set` 6 / 22；
  - `thisScene.createLayer` / `sortLayer` 2 / 2，`destroyLayer` 1；
  - `<图层>.setFrame` 3 / 10（纹理动画）；
  - `getEffect` 1 / 2、`emitParticles` 1、`getAnimationLayer` 1、`input.cursorLeftDown` 1。
- **样本自身的错（未触发）**：`localStorage.remove` 2 / 6（WPE 没有 `remove`）、`console.warn` 1 / 1、`thisLayer.originalOrigin` 2 / 6（报告 C 节：推断不是 API）。

**渲染阻塞。** 有脚本却仍然退回的 21 张都另有渲染阻塞，单做 API 一张也解锁不了。按出现张数：
- 文本 `object:text`：19 张（除 shimmering_particles、3549863808 外全部）；
- 着色器失败 `shader:*`：18 张；
- 声音 `object:sound`：16 张；
- 粒子 `object:particle`：15 张；
- 父子层级 `object:parent`：14 张；
- 视频纹理 `tex:video`：10 张；
- 音频频谱 uniform：6 张；
- 纹理动画 `tex:animation`：4 张；
- puppet：3 张。

所以下面各项的收益是两类：一是这些阻塞逐步解除之后画面正确；二是减少日志里的报错。

**后续 API 阶段建议**（修订「后续」的初排，交用户定）：
1. **音频缓冲与 `localStorage`**：量小，可以单列一个阶段，或并入 3c。
   - `engine.registerAudioBuffers` 先返回全零缓冲：`{left, right, average}` 各为 16 / 32 / 64 长的 realm 数组，只许在模块顶层调用，同时提供 `AUDIO_RESOLUTION_*`。只这一个函数，就能让 10 张里的 124 段恢复求值，连带的 2 段也随之消失。全零对应「没有声音」，不改变画面；接上 W2 / W3 的音频订阅后再换成真数据。
   - WPE 版 `localStorage`：提供 `get` / `set` / `delete` / `clear` 与 `LOCATION_GLOBAL` / `LOCATION_SCREEN`，不提供 `remove`。可以先做内存版，消掉 5 张 10 段的 `init` 失败；按壁纸持久化留到 P6，或这次一并做。
   - `registerAsset` 只有 1 段，维持报错，随 P6。
2. **层级与变换**：随渲染侧的父子层级做（W1 / W5）。
   - 内容：`getParent` / `getChildren` / `setParent` / `getTransformMatrix`。
   - 涉及 3 张 30 段，另有 28 条连带。这 3 张与另外 11 张都报 `object:parent`。
   - 要与渲染器的父子变换放在同一阶段，否则 `getParent().scale` 读到的值与画面不一致。
3. **光标与输入**（W4）：`input.*` 与 `cursor*` 回调。
   - 运行时只有 2 段报错，但 13 张壁纸有 209 段导出了 cursor / media 回调，主要是拖拽、双击切换这类交互。这是不报错的缺口里最大的一项。
   - 需要宿主把指针事件与命中测试（`cursorHitTest`、按图层的 enter / leave）交给脚本。
4. **纹理动画与视频**：随 `tex:animation` / `tex:video` 的渲染支持做（W5 / P6）。涉及 `getTextureAnimation` 3 / 10、`thisObject.getAnimation` 2 / 4、`getVideoTexture` 2 / 2、`setFrame`。
5. **声音、文本、媒体、建层**（P6 / W5）：
   - 声音 `play` / `stop` / `isPlaying`：3 张 4 段；
   - 文本属性写回：17 张 121 段；
   - `media*Changed`：7 张；
   - `createLayer` / `sortLayer` / `destroyLayer` / `registerAsset`：2 张。
   - 做声音、文本时，同时给非图片对象正确类型的图层对象（见「实现偏差」第二条）。
6. **`thisObject.getMaterial`**：只有 dino_run 1 段，随 3c 或材质 API。

**`scriptCorpus` 本身的问题。**
- 返回的 `remainingTestFrames` 不是残留测试 frame 数，而是 120 帧循环的倒计数，`finally` 里总被置 0，所以恒为 0。残留要数 DOM 里的 `iframe[data-kb-script-realm="1"]`，本次由驱动自己数。
- `missingApis` 只认 `engine|thisLayer|thisObject|thisScene|input` 前缀和 `X is not defined`，因此：
  - 漏掉经变量调用的 6 条：`video.getVideoTexture`、`cachedSongs[i].play` / `isPlaying`、`audioLayer.stop` / `play`；
  - 30 条连带的 `Cannot read properties of undefined` 与 2 条 `Cannot create property` 没有归因；
  - 把样本伪代码里的 `scene` 也计成了缺失 API。

  本记录的排行由 `rank.mjs` 另行计算。
- 诊断里没有每段的写回目标类型，也不统计写到重编译目标（effect `visible`、general 的重编译项）的次数。正式宿主里这类写入会触发重编译（待定 6），而语料看不出哪些段每帧都在写。
- 属性用的是 `project.json` 的作者默认值，不是图库里用户改过的值；按设计不调用 `cursor*` / `media*` 回调。这两点作语料用可以接受。

**临时改动与恢复。**
- 在 bedroom 宿主里加的 `window.__kbCorpus6` 用完已删。
- 没有切换路由：主窗口自始至终为 `/gallery?pvwimgid=12892`，宿主仍是 12888 / 12892 两个。
- Node 侧只读跑了一次 `pipeline.test.ts` 的语料用例。
- 没有改动图库、属性、设置与代码。
- 应用背景的 bedroom 宿主 `update` 计数在开跑前后都是 32119。说明它在本步骤开始前就已暂停，与本次测量无关。

### 步骤 7 真机（2026-11-04）

**做法。** 环境为 Windows dev（CEF 149），使用 2026-11-04 构建的 development 版宿主，没有重建。测试用裸 CDP 脚本，连 2331 端口，脚本与数据在 `ignore/p3b/step7/`。
- **公共部分**：`lib.mjs`、`common2.mjs`、`applog.mjs`；`applog.mjs` 按 UTC 日期定位应用日志，并按偏移读取新增行。
- **各项脚本**：`test1.mjs` / `test1b.mjs` 对应 D6，`test2.mjs` 对应 D7，`test3.mjs` 对应 D8，`test4.mjs` 对应 D9，`test5.mjs` 对应 D10，`wprate.mjs` 对应 D11，`final.mjs` 用于收尾核对。
- **采样器**：宿主里的采样器（`sampler.js`、`pausesampler.js`）只读，每个 rAF 读一次 `__kabegameSceneProbe.host.read()` / `scripts()`，到时间自行停止，全局变量用完即删。
- **runtime 的读法**：探针没有暴露 `runtimeSeconds`。改为从宿主读 realm 里的 `engine.runtime` getter：作用域检查只在模块求值期间生效，所以平时可以读，而且这个读取没有副作用。
- **设置与属性**：设置经主窗口应用页 IPC `set_wpe_scene_postprocess` 修改；属性经属性面板的同一命令 `set_wpe_web_user_properties` 修改；预览经 ImageGrid 的 `openPreviewById` 打开，按 Esc 关闭。
- **窗口状态**：开测时主窗口被 VSCode 完全遮挡，Chromium 原生遮挡检测把它判为 `visibilityState: hidden`，宿主 rAF 为 0。D6 因此先在壁纸窗口宿主上只读观测（当时为窗口模式，桌面是 bedroom）。主窗口恢复可见后，D6 在预览上补测了一遍，D7–D10 都在主窗口预览上完成。

结果（明细见回归表 P3b D6–D11）：

| 项 | 结论 | 关键数字 |
| --- | --- | --- |
| D6 bedroom 跨重编译 | 通过 | 「场景后处理」`disabled` → `enabled` → `disabled`，壁纸窗口与预览各测一轮。宿主控制台记录 `重新判定` → `重新加载`，用时 414–482 ms。realm 是同一个对象；update 计数不归零，每 10 s 增加 601 / 602，即 60.1 次/秒；`engine.runtime` 每 10 s 前进 10.0 s。6 个颜色按墙钟公式反推的滞后为 0–16 ms，没有倒退，也没有跳回初值。bedroom 不导出 `init`，`calls` 里没有 init 项 |
| D7 shimmering 泛光强度 | 通过 | 首次 apply 后为 1.0；`glow` 改 3 后为 1.5（207 ms 内，就地更新）；恢复默认后为 1.0。recompiled 为空。metadata id 20067 → 20073 → 20074，属性与改动前逐项相同 |
| D8 暂停 | 通过（入口为模拟） | 暂停 5000 ms 共 721 个 rAF 采样，update 恒为 216，`engine.runtime` 冻结在 3.5766 s；恢复后从 3.5766 接着走，update 60 次/秒；恢复后 1 s 内 dt 最大 0.0219 s |
| D9 出错日志 | 部分通过 | 13110：1 条 `求值失败：engine.registerAudioBuffers is not a function (line 67, col 24)`，该段 `failed`。12903（补选）：1 条 `init 出错：localStorage is not defined (line 46, col 25)`，`disabled: ["init"]`。两张约 12 s 内都没有重复。13107 的 update 报错没有触发：强制渲染下 GPU 场景也建不出来，所以没有帧 |
| D10 vortex 切模式 | 通过；与 WPE 对照未测 | `colormode` 依次为 0 → 1 → 2 → 0（3 层同步）；控制台只有 3 条 `就地更新`，recompiled 为空，应用日志没有新增行。metadata id 20064 → 20077，属性与改动前逐项相同 |
| D11 壁纸窗口 | 通过（只读） | 窗口模式、bedroom。6 段 `inited`，update 60.1 次/秒，单次最长 0.1 ms；宿主 rAF 144.5 次/秒；frameMs 均值 0.22 ms、p95 0.4 ms；没有错误或重编译 |

**发现的问题与疑点。**
1. **重编译在应用日志里看不到。** `SceneHost.reload` 的「重新加载」与「后处理设置 … 重新判定」都走 `report.debug`，而 `report.debug` 只写宿主控制台、不上报。所以验收里「日志有重新编译 / 没有重新编译」只能看宿主控制台（CDP `Runtime.consoleAPICalled`）与 `stats().recompiled`；应用日志里只有重编译时按查找顺序试探资源产生的 `deny file:` INFO。此外，`stats().recompiled` 不记设置变化（以及退回状态下，见 P3a D9）引起的重载。
   - **建议**：把 `report.debug` 也上报为应用日志的 `debug` 级（dev 默认就输出 debug），或者把「重新加载」升为 `info`。
   - **复现**：预览任一能渲染的场景，切「场景后处理」，再看当天的应用日志：没有 `kabegame::wpe_scene_host` 的新行。
2. **`init` 计数这条验收对 bedroom 不适用。** bedroom 的 6 段只导出 `update`；`runtime` 只在回调存在并被调用时才建 `calls[name]`，所以 `scripts()` 里没有 init 项。「不重新 init」改用三条判据：realm 是同一个对象、`calls.update` 不归零、`场景脚本加载完成` 不再出现。本机能渲染的 3 张都没有 `init`；有 `init` 的语料场景都建不出 GPU 场景，所以「重编译后 init 仍为 1」在真机上没有直接样本，只有单测 9 覆盖。
3. **现有 UI 里没有能暂停场景宿主的路径。**
   - 现状：预览固定传 `video-playing`；应用背景隐藏时整层卸载；`WallpaperWindow` 不传 `paused`。D8 是从父页面按 `WpeSceneView` 的消息协议投递 `paused`，这条链路（垫片 → `wallpaperPropertyListener.setPaused` → `SceneHost.setPaused`）本身成立。
   - 实际会让宿主停下来的是 `document.hidden`。主窗口被其它窗口完全遮挡时，Chromium 原生遮挡检测把页面判为 hidden，渲染循环与脚本都停（本次开测时应用背景宿主的 update 停在 38187）。步骤 6 记录里「应用背景宿主开跑前就已暂停」的原因也是这个。
   - **与 WPE 可能不同**：WPE 按「其它程序获得焦点 / 最大化 / 全屏」等设置决定暂停；我们只按遮挡与隐藏，触发条件不一样。暂停期间 `engine.runtime` 不前进（不含暂停时段），WPE 在暂停期间的 `engine.runtime` 语义未查。
   - 相关细节：在被遮挡的窗口里加载场景时，首帧不调用 `update`（`beforeFrame` 要求 `!document.hidden`），`init` 与首次全量 apply 照常执行，要等窗口可见后才开始 update。
4. **「update 报错 → 禁用」在真实宿主里没有样本。** 语料里有 update 报错的场景（如 13107），加上强制渲染也建不出 GPU 场景（`render:no-program` / `texture-missing`），退回后就没有帧。这一项目前只由单测 6 与步骤 6 的 `scriptCorpus` 覆盖。init 报错与求值失败已在真机确认，都只记一次、带行列。
5. **退回之前，脚本已经求值并执行了 init。** 强制渲染下（以及 `unsupported` 为空、但建 GPU 场景失败的生产情形），脚本 realm 会先建好，求值与 `init` 都执行，之后才退回预览图；realm 保留到宿主销毁。这与步骤 5「退回时保留 realm、停止帧」的设计一致，记作已知行为：退回场景里 `init` 的副作用（日志、计时器登记）照样发生。
6. **测量工具上的缺口。** 探针没有 `runtimeSeconds`、计时器列表和「写目标」入口（步骤 5 已提出）。本次用 realm 的 `engine.runtime` 代替前者。建议给 `host` 增加 `clock()`，返回 runtime、frametime、paused、hidden 和计时器数。
7. **宿主实例被重建（与测试无关）。** 收尾核对（11-05）时，dev 进程仍是 11-03 22:39 启动的那个，但壁纸窗口在 11-04 23:50 和 11-05 09:33 两次重新就绪，主窗口页面在 23:51 和 09:34 重新初始化，宿主都换了新实例。这些都发生在本步骤最后一次操作（11-04 02:53）之后，原因未查。

**临时改动与恢复**（收尾核对于 2026-11-05 实测，见 `final-check.json`）：
- **「场景后处理」**：一共改了 6 次（3 个来回）。其中第一个来回是因为采样器注入写错（`return` 后面跟注释行，触发了 ASI），没有采到数据，重跑了一次。现为 `disabled`，与改动前相同，`get_wpe_scene_postprocess` 与 `get_settings` 都已复核。
- **dev 强制渲染开关**：开关过 3 次，测前都是 null。现在两个宿主（壁纸窗口、应用背景）读到的都是 null。
- **属性**：
  - 12892：`glow` 3 → 恢复默认，metadata id 20067 → 20074；
  - 12889：「模式」1 / 2 / 0，metadata id 20064 → 20077。
  - 这两张的值与 `modified` 都与改动前逐项相同。
  - 13107 / 13110 的 metadata id 与改动前相同（20018 / 20021），属性也相同。
  - 12888（20057，与 P3a 结束时 `ignore/p3a/props-after.json` 的记录相同）与 12903（19670）这次没有写入。两者的 id 都小于本步骤第一次写入前的 20064，说明没有被改写，`modified` 为空。
- **预览**：12892 → 12888 → 13107 → 13110 是在同一个预览里依次切换的，看完 13110 后按 Esc 关闭；12903、12889 各自打开、各自按 Esc 关闭。现在路由为 `/gallery`，与开始时相同；页面上没有预览容器；宿主只剩应用背景与壁纸窗口两个（都是 12888）。
- **暂停**：已发 `paused: false`（音量按设置为 1）恢复。
- **宿主里的临时全局**：`__kbStep7Sampler` / `__kbStep7Pause` 用完已删，收尾核对时没有残留。
- **未改动的内容**：壁纸、壁纸模式、WPE 安装目录，以及代码、`cocs/`、changelog、`AGENTS.md`。
