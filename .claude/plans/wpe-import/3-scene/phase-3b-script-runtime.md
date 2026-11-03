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

**出错与卡住（已定 3、5）。** 回调抛错只禁用这段脚本的这个回调（D「异常」）；模块求值失败这段整段不用；不做静态扫描，未实现的 API 就让它在调用时报错，可能画出半成品。错误按 `"<message> (line L, col C)"` 写应用日志。每个回调都计时，单次超过 15 s 就在它返回后停掉本场景全部脚本、画面按最后的值继续、写应用日志；真正的死循环接受卡住，由现有 ping / 看门狗 / CEF 处理。脚本相关不再进 `unsupported`：`value:script` 与 D10 的 `isStaticScript` 在本阶段删除，渲染能力的 `unsupported` 与 D4 照旧。

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
4. **环境对齐 WPE**：遮掉 WPE 没有的东西，`console` 只有 `log` / `error`（`console.warn` 照 WPE 抛错）；只为画面一致，不是安全边界。
5. **未实现的 API 不做静态扫描**：照常运行，调用时报错只禁用那个回调，可能画出半成品；脚本相关不再进 `unsupported`（`value:script` 随本阶段删除；渲染能力的 `unsupported` 与 D4 照旧）；报错写应用日志。
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
