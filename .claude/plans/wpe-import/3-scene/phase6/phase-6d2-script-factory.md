# P6d2 — 场景脚本改成同步工厂加载（子计划）

> 上级：[phase-6d-dynamic-layers.md](phase-6d-dynamic-layers.md)「已定」2（2026-11-15 用户「接受A」）。P6d1a、P6d1b 已提交（`88b0e0a8`）。
> 2026-11-15 用户定：用 acorn 做改写（「方案1可以」），推翻 P3b「不引入 acorn」（当时只为报错位置）。
> 现状锚点取自 HEAD `88b0e0a8`。分两步，各自验收：步骤 1 是对比工具（先跑基线），步骤 2 是加载方式本身。

## 总体设计思路

现在每段脚本在 realm 里是一个 blob 模块，`import()` 一次就求值一次，拿到的命名空间就是这段脚本唯一的一份状态。P6d3 要支持 `createLayer(getInitialLayerConfig(带脚本的图层))`：WPE 在 `createLayer` 返回之前就给新图层编译、求值同一段脚本、跑它的 `init`，也就是**同步地**得到一份新的模块状态。浏览器的模块加载只能异步，所以要换一种加载方式。

新的方式把「编译」和「求值」拆开：
- **加载期（异步，每种源码一次）**：浏览器先按真模块检查一遍这段源码（只链接、不求值），保证语法错误、链接错误的文字和行列和现在逐字相同；再在 realm 里原生 `import()` 它导入的库（`WEMath` 等，所有脚本共用一份，同 WPE 实测）；最后用 acorn 拿到准确的语句结构，把源码改写成一个工厂函数的函数体，在 realm 里用间接 `eval` 编一次。
- **求值（同步，每段脚本一次，P6d3 起克隆时再调）**：调工厂，模块顶层代码在这一刻同步执行，返回一份新的命名空间。顶层有 `await` 的模块编成 async 工厂，加载期等它（克隆这类脚本在 P6d3 另说）。

改写**不改任何一个原有字符的行列**：`import` 语句、`export` 关键字、`export { … }` 列表原地换成等长空白（保留换行），`import.meta`、`import(`、顶层 `this` 换成等长标识符；导入绑定放在函数体前面单独一行，导出的取值函数放在源码之后。所以运行期报错的位置只差一个固定的行偏移，`messageOf` 减掉即可。

命名空间照 WPE 实测（`ignore/p6/d2/wpe-forms.log`）做：键按字典序、活绑定、原型为 null、不可扩展、`Symbol.toStringTag` 为 `Module`、属性描述符是 `writable: true, configurable: false` 的数据属性、写入抛 `TypeError: Cannot assign to property 'x' of [object Module]`；用 realm 里的 `Proxy` 实现。运行时自己取回调不经 `Proxy`，直接调取值函数。和现在不同、改成照 WPE 的两处：动态 `import()` 一律返回 reject 的 Promise（`Error: Not supported`），`import.meta` 是每个模块实例一个没有键、原型为 null 的对象。

工厂在 realm 的全局作用域里以箭头函数编出来：箭头函数没有自己的 `arguments`，顶层访问 `arguments` 照样是 `ReferenceError: arguments is not defined`；箭头函数的 `this` 来自全局，所以顶层的 `this`（不在普通函数、方法、类字段、静态块里的）换成一个绑定为 `undefined` 的常量。

判断语法合法的仍是浏览器自己（按真模块检查），acorn 只负责结构。acorn 不认而浏览器认的写法（比将来的提案语法），以及改写后编不过的情况，这段脚本加载失败并报出原因，不静默。

## 步骤 0 — 实测与语料（Claude，已做）

**WPE 2.8.42**（工程 `ignore/p6/d0/make_p6d2.py` → `proj/p6d2-forms`，日志 `ignore/p6/d2/wpe-forms.log`）：
- 顶层 `this` 是 `undefined`；`arguments` 抛 `ReferenceError: arguments is not defined`。
- `import.meta`：对象，没有键，原型为 null，`url` 是 `undefined`。
- 动态 `import('WEMath')`：同步返回 Promise，之后 reject，`Error: Not supported`。
- 顶层 `await`：求值完（`B before await` → `B after await`）才求值下一段，`init` 照调。
- 库（`WEMath`）跨脚本是同一个命名空间对象。具名导入、改名导入、`export * from`、`export * as`、`export {…} from`、改名导出的 `update`（`export { upd as update }` 被当成 `update` 调）、`export default` 匿名函数（`name` 为 `default`）、字符串导出名都正常。
- 回调里的 `this` 是本模块的命名空间：`[object Module]`，键按字典序，`cnt` 活绑定（`this.cnt` 0 → `this.default()` → 1），不可扩展，写入抛 `TypeError: Cannot assign to property 'cnt' of [object Module]`，描述符 `{"value":1,"writable":true,"enumerable":true,"configurable":false}`。

**语料**（`ignore/p6/d2/dumpscripts.py` → `scripts.json`，`forms.mjs`）：138 张场景 5118 段脚本，acorn 按模块全部解析成功；只用了 `export function`（9246 处）、`export var`（2808）、`export let`（1913）、`import * as`（412）。lexer 与 acorn 的导出名逐段相同。

**es-module-lexer 1.7.0 认不准的写法**（`scratchpad/lexer_probe.mjs` 的结论）：`export let a = 1, b = 2;` 只报 `a`；`export const { x, y: z } = o, [p, ...q] = r;` 报成 `x`、`y`；不给 `import` 子句、`export { … }` 列表的语句范围。所以改写用 acorn。

## 现状锚点

**a. 每段脚本一个 blob 模块**（`script/realm.ts:210`）
```ts
      async importModule(source: string, _label: string): Promise<Record<string, unknown>> {
        // 现状：源码原样放进 blob，`import()` 一次求值一次；命名空间就是这段脚本唯一的一份状态
        const url = activeChild.URL.createObjectURL(new activeChild.Blob([source], { type: "text/javascript" }));
        try {
          const importer = new activeChild.Function("u", "return import(u)") as (url: string) => Promise<Record<string, unknown>>;
          return await importer(url);
        } catch (error) {
          // 现状：SyntaxError 没有行列时，用 <script type=module> 补拿一次（syntaxPosition）
          ...
```

**b. 加载顺序**（`script/runtime.ts:348`）
```ts
  async load(scripts: SceneScripts, afterInit?: () => void): Promise<void> {
    ...
    for (const record of this.records) {
      ...
      try {
        this.active = record;
        this.options.enterScript?.(record.script);
        this.options.setModuleEvaluating?.(true);
        record.exports = await this.realm.importModule(record.script.source, record.script.id); // 现状：异步，求值在这里
        record.state = "loaded";
```
回调经 `record.exports[callback]` 取（`call`、`animationEvent`、`cursorEvent`、`mediaEvent`、`hasCursorCallbacks`、`applyUserProperties`），诊断的 `exports` 是 `Object.keys(record.exports)`，`updateScriptProperties(record.exports, …)`，`callFor` 把 `record.exports` 交给回调当 `this`。

**c. 报错位置只认 blob 地址**（`script/runtime.ts:159`）
```ts
export function messageOf(error: unknown): string {
  ...
  const location = /blob:[^\s)]+:(\d+):(\d+)/.exec(stack); // 现状：blob 模块的行列就是源码行列
  return location ? `${message} (line ${location[1]}, col ${location[2]})` : message;
}
```

**d. 编译期扫描导入**（`compile/scripts.ts:214`）
```ts
        for (const item of parse(raw.script)[0]) {
          if (item.n === undefined) continue; // 现状：import.meta 跳过
          if (item.n === null) continue; // 变量动态 import 无法在编译期确定
          // 现状：静态导入与字面量动态导入都进 imports（import map）；非裸名的（含动态导入）整段报错不求值
          if (/^(?![./]|[a-z][\w+.-]*:)[\w-]+$/i.test(item.n)) imports.push(item.n);
          else errors.push(`不支持的模块说明符：${item.n}`);
        }
```

**e. 语料脚本工具不确定、读写自拼一套**（`dev/scriptCorpus.ts:104`）
```ts
        let elapsed = 0;
        const current = (api = new ScriptApi(realm, {
          ...
          timeOfDay: () => 0.5,
          // 现状：write / read 各自手写一套（没走 P12c 之后共用的 script/stateWrite.ts），时钟与 Math.random 是真的
          write(target, value) { ... state.write({ property: "corpus", target }, …) ... },
```
结果只留诊断的 `id`、`errors`、`targetKind`、`recompileWrites`。

**f. 测试里的假 realm**：23 个测试文件各自实现 `importModule()`（如 `script/api.test.ts:67`、`host.test.ts:296`），返回固定的导出对象。

## 步骤 1 — 语料脚本工具改成确定的，并跑基线

### 点 1 — `dev/scriptCorpus.ts` 改用 `createProbeScripts`

- **修改**
  - 每张场景：编译同现在（Worker、`force`、`exhaustive`），状态 `SceneState.fromBundle`，用户属性取 `readProbeUserProperties`（同 `renderFrame`）；脚本环境整个交给 `createProbeScripts`（固定时钟、`Math.random` 种子，写回读取走 `stateWrite.ts`，和宿主同一套接线），不再手写 `ScriptApi` / `ScriptRuntime`。
    > 说明：两次跑同一个场景得到同一份结果，基线与改后才能逐张比。
  - 选项 `{ frames = 120, dt = 1/60, clock?, seed?, postprocess = "follow" }`；`load()` 之后逐帧 `enterFrame(dt, t)`、`frame(dt, t)`，`t = k·dt`。`consoleGrep` 用匹配一切的正则，收全部输出。
  - 每张一行：
```ts
interface CorpusRow {
  imageId: string;
  unsupported: string[];
  /** createProbeScripts 的诊断，去掉 calls 里的 maxMs（计时，不确定） */
  scripts: unknown[];
  /** 跑完之后的状态摘要：SceneState 里脚本能写到的各张表（图层、材质常量、effect、general、泛光、文本、相机、声音、粒子实例、动画层、材质状态字段）按键排序后 JSON 的 SHA-256 */
  stateDigest: string;
  /** 脚本 console 的行数与全部行的 SHA-256 */
  console: { count: number; digest: string; tail: string[] };
  messages: string[];
  recompile: unknown[];
  unconnected: { sound: number; video: number; particles: number };
  error?: string;
}
```
  - `missingApis` 汇总保留（`classifyScriptError`）。
- **删除**
  - 手写的 `write` / `read` 两份。

### 点 2 — 驱动与比较脚本（`ignore/p6/d2/`，Claude 写）

- **新增**
  - `corpus_run.mjs`：经 vite REST（`/__kabegame_dev`）取库里全部 `x-wpe/scene` 的 id，开一个屏外宿主（`POST /hosts`），每批若干张调 `__kabegameSceneProbe.scriptCorpus`，每张写 `<out>/<id>.json`，最后关宿主。
  - `corpus_diff.mjs`：两个目录逐张比，列出不同的场景与不同的字段。

### 点 3 — 跑基线

- 合并进主工作区、重建 dev 宿主产物（`apps/kabegame-dev-mcp/src/buildSceneHost.ts`），跑两遍基线，确认两遍逐张相同（工具本身确定），存 `ignore/p6/d2/base/`。

## 步骤 2 — 工厂加载

### 点 1 — 改写（`script/moduleRewrite.ts`，新增，纯函数）

- **新增**
```ts
/** acorn（module、ecmaVersion latest、allowHashBang）解析后得到的改写结果；解析失败时抛出 acorn 的错误。 */
export interface ModuleRewrite {
  /** 工厂源码：第 1 行 `'use strict';(<参数> => {`（顶层有 await 时是 async 箭头），第 2 行是导入绑定等前言，第 3 行起是改写后的源码（行列与原文逐字符对齐），之后一行 `return` 命名空间，最后 `})` 与 `//# sourceURL=`。 */
  source: string;
  /** 静态导入与再导出用到的说明符，按源码顺序去重：加载期逐个原生 import()。 */
  specifiers: string[];
  /** 顶层有 await（含 for await）：编成 async 工厂。 */
  async: boolean;
}
export const FACTORY_LINE_OFFSET = 2; // 工厂源码里原文第 1 行之前的行数

export function rewriteModule(source: string, sourceUrl: string): ModuleRewrite;
```
  - 原地替换（等长，换行保留）：
    - `ImportDeclaration`、`ExportAllDeclaration`、带 `source` 的 `ExportNamedDeclaration`、不带声明的 `export { … }`：整条换成空白；
    - 带声明的 `export`：`node.start` 到 `declaration.start` 换成空白（中间的注释一起）；
    - `export default <表达式>`：`node.start` 到表达式开头换成 `<默认值名>=`（再补空白，`export default` 至少 14 字）；表达式的范围和原文一样（`export default` 后面本来就是一个 AssignmentExpression）；
    - 匿名的 `export default function` / `async function` / `function*` / `class`：从 `export` 到关键字末尾这一段换成带默认值名的**声明**（`function <默认值名>`，等长补空白），保持函数声明的提升，也不会因为下一行以 `(` 开头被接成调用；这一段跨行、放不下时报「改写失败」；
    - 匿名的默认值（上面两种里的匿名函数 / 类，含括号里的、async、generator、箭头）在命名空间建好时若 `name` 是默认值名就改成 `"default"`（类自己定义了静态 `name` 的不动），同 WPE 实测；
    - 有名字的 `export default function f` / `class C`：只把 `export default` 换成空白，导出 `default` 指向 `f` / `C`；
    - `import.meta` → 11 字标识符，`import(` 的 `import` → 6 字标识符，顶层 `this` → 4 字标识符（「顶层」= 不在普通函数、方法、getter / setter、类字段初值、静态块里，箭头函数不算边界）；
    - 开头的 `#!` → `//`。
  - 生成的标识符（工厂参数、默认值名、上面三个定长名）都避开源码里出现过的全部标识符名（acorn 收集）：按固定的候选序列挑第一个没出现过的，定长名的候选也定长。
  - 前言（第 2 行）：`const <命名空间导入>=<参数>.lib(i)`；具名 / 默认导入是 `const {<导入名>:<本地名>,…}=<参数>.lib(i)`（字符串导入名带引号）；`import.meta` 的名 = `<参数>.meta()`（每次调工厂一个新对象）；动态导入名 = `<参数>.dynamicImport`；`this` 的名 = `void 0`。
    > 说明：具名导入取的是求值时的值，不是活绑定。WPE 的三个库只有 `wemath.js` 导出了 `let`（`deg2rad`、`rad2deg`），模块里不再赋值，两者结果相同；对导入绑定赋值同样抛 `TypeError: Assignment to constant variable.`。
  - 结尾：`return <参数>.ns({ "<导出名>": () => <本地名>, … }, [<星号再导出的库下标>…], { "<再导出名>": [<库下标>, "<库里的名字>"] | [<库下标>, "*"] })`。导出名取 acorn 的结果（含多个声明、解构模式里的全部绑定名、字符串导出名）。
- **验收（单测）**：每种写法（本文件「步骤 0」与 `lexer_probe.mjs` 的全部用例，加 `export let a = 1, b = 2`、解构、`export { k as "str name" }`、`export default` 的六种、顶层 await、`for await`、hashbang、注释夹在 `export` 与声明之间、标识符撞名）：
  - 原文里没被替换的每个字符，在工厂源码里的行列 = 原文行列 + `FACTORY_LINE_OFFSET` 行；
  - 导出名集合与 acorn 一致，`specifiers` 顺序对。

### 点 2 — 工厂与命名空间（`script/moduleFactory.ts`，新增）

- **新增**
```ts
/** 一段源码编出来的工厂：每调一次 instantiate 就同步求值一次模块顶层、得到一份新的模块状态。 */
export interface ScriptModule {
  readonly async: boolean;
  instantiate(): ModuleInstance | Promise<ModuleInstance>;
}
export interface ModuleInstance {
  /** 照 WPE 的模块命名空间（realm 里的 Proxy）：回调的 this、诊断的导出名、updateScriptProperties 的参数。 */
  readonly namespace: Record<string, unknown>;
  /** 宿主自己取导出（不经 Proxy，现取活绑定）：运行时找回调用它。 */
  read(name: string): unknown;
}
/**
 * 在一个 realm 全局（浏览器 iframe 的 window，或单测里 Node 的 vm 上下文）里编工厂：`global.eval` 间接求值 `rewrite.source`。
 * `libs` 是 `rewrite.specifiers` 对应的库命名空间。命名空间、它抛的 TypeError、`import.meta` 对象、动态导入的 Promise 与 Error
 * 都在这个 realm 里建（辅助函数用 realm 的 eval 编一次、按 realm 缓存）。
 */
export function compileModule(global: Record<string, unknown>, rewrite: ModuleRewrite, libs: readonly object[]): ScriptModule;
```
  - 命名空间：目标对象原型为 null，导出名按码元序各定义一个 `{ value: undefined, writable: true, enumerable: true, configurable: false }`，加 `Symbol.toStringTag: "Module"`（不可写、不可枚举、不可配置），再 `preventExtensions`；`Proxy` 的 `get` / `getOwnPropertyDescriptor` 现取活绑定（暂时性死区照常抛 `ReferenceError`），`set` 抛 realm 的 `TypeError: Cannot assign to property '<键>' of [object Module]`，`defineProperty` 返回 false，`deleteProperty` 对导出名返回 false，`has` / `ownKeys` / 原型 / 可扩展性同目标。
  - 星号再导出：本地与具名再导出优先；多个星号来源都有、又不是同一个库的同名项按「有歧义」去掉；`default` 不经星号导出。
  - 动态导入：先对说明符做一次 `String()`（抛错就返回以它 reject 的 Promise），再返回 `Promise.reject(new Error("Not supported"))`。
- **验收（单测，Node vm 上下文当 realm）**：照 `wpe-forms.log` 逐条：顶层 `this`、`arguments`、`import.meta`、动态导入、命名空间的键序 / 活绑定 / 描述符 / 写入的错误文字 / `toStringTag` / 不可扩展、`export default` 匿名函数的 `name`、字符串导出名、改名导出；再加：同一个 `ScriptModule` 调两次 `instantiate` 状态互不影响、库命名空间两次是同一个对象、async 工厂等到顶层 await 结束才返回。

### 点 3 — realm（`script/realm.ts`）

- **修改**
  - `ScriptRealm.importModule` 换成：
```ts
  /**
   * 加载期：每种源码一次（按源码文本缓存）。1) 按真模块检查：`import "<哨兵模块>";\n` + 源码作 blob 原生 import()，哨兵模块排在第一个、求值时抛
   * 一个固定的值，所以整张图链接完、用户代码一行都不执行；reject 的值就是哨兵 → 合法，否则按现在的规则（SyntaxError 补行列，`syntaxPosition`
   * 用原文）把这个错误原样抛出。2) 依次原生 import() `specifiers`（库求值的报错原样抛出）。3) `rewriteModule` + `compileModule`；acorn 解析失败或
   * 编不过时抛 `Error("场景脚本改写失败：…")`。
   */
  prepareModule(source: string, label: string): Promise<ScriptModule>;
```
  - import map 照旧生成（哨兵检查与原生导入库都要用）。
- **删除**
  - `importModule`。

### 点 4 — 运行时（`script/runtime.ts`）

- **修改**
  - `ScriptRecord` 加 `module: ScriptModule | null`、`instance: ModuleInstance | null`，`exports` 改为 `instance.namespace`（诊断、`updateScriptProperties`、`callFor` 的 `this` 用它）。
  - `load`：`setModuleEvaluating(true)` 之后 `record.module = await realm.prepareModule(…)`，再 `instance = module.instantiate()`（async 的等它），其余顺序不变。
    > 说明：`setModuleEvaluating` 仍括住「库求值 + 本段求值」，同现在。
  - 取回调一律 `instance.read(name)`，调用时 `this` 为 `namespace`。
  - `messageOf`：认 `kabegame-script:<n>:<行>:<列>`，行减 `FACTORY_LINE_OFFSET`；blob 地址照旧（加载期检查出的错误仍来自 blob）。
- **保留**：`record.module` 留给 P6d3 克隆时再 `instantiate`。

### 点 5 — 编译期扫描导入（`compile/scripts.ts`）

- **修改**
  - 只看静态导入与再导出（lexer 的 `t` 为 1、4、6）：动态导入与 `import.meta` 不进 `imports`、不报「不支持的模块说明符」。
    > 说明：WPE 里动态导入一律 reject、不影响加载；现在非裸名的动态导入会让整段不求值。语料 0 处。

### 点 6 — 其余接线

- **修改**
  - `dev/realmProbe.ts`：`importModule` 换成 `prepareModule` + `instantiate`。
  - 测试里的假 realm（现状锚点 f）：新增测试辅助 `script/testing/fakeModule.ts`（`fakeModule(exports)` 返回 `ScriptModule`），各测试改用它；需要真跑源码的（`puppet/p12script.test.ts` 等）改用 Node vm 上下文 + `rewriteModule` / `compileModule`。
  - `apps/wpe-scene/package.json` 加 `"acorn": "8.18.0"`（锁文件里已有这个版本；`deno install` 由用户在 dev 停着时跑一次，提交前完成）。
    > 说明：项目规则禁止动态 `import()`，acorn 静态打进宿主包（约 +100 KB）。realm 里原生 `import()` WPE 的 `jsmodules` 是脚本运行时加载库，不是产品代码分包，同 P3b。

### 点 7 — 文档

- `cocs/wpe/WPE_SCENE.md`「场景脚本（P3b）」：加载方式、命名空间、动态导入 / `import.meta`、报错位置；`cocs/README.md` 对应条目；`versions/latest/regression.md` 一节。

## 验收

- **子代理**：宿主 tsc、相关 vitest、Prettier。
- **Claude 独立验收**：
  - `git status` 查越界；tsc、相关 vitest 自跑。
  - 变异检查：命名空间不排序、多变量导出漏名、顶层 `this` 不换、行偏移错一行、动态导入 resolve、`instantiate` 共用状态（同一源码的两段脚本互相影响）、哨兵检查去掉（语法错误的行列变）、星号歧义不去掉。
  - 真机：
    - `p6d2-forms` 在 dev 探针里跑（`consoleGrep`），逐行和 `wpe-forms.log` 比；写库命名空间（`A ns write`）的错误文字来自浏览器原生的库命名空间，V8 版本不同可能不同，记为已知差异。
    - `realmCheck` 带几段错误源码（语法错误、链接错误、缺库），报错文字与行列和改之前逐字相同。
    - 全语料：步骤 1 的工具改后再跑，和基线逐张相同（诊断、状态摘要、console 摘要）。
    - 带脚本最多的场景加载用时改前改后各量一次。

## 已定

1. 改写用 acorn（2026-11-15 用户「方案1可以」），合法性仍由浏览器按真模块判定。
2. 动态 `import()`、`import.meta`、命名空间形状照 WPE 实测（语料 0 处，诊断不变）。

## 待定

- 无。

## 实施记录

### 2026-11-15（独立工作树 `ignore/p6/d1/wt`，基点 `88b0e0a8`，提交前对齐到 `996012d6`；sonnet 分三段）

- **步骤 1**：`scriptCorpus` 改用 `createProbeScripts`，每张输出逐段诊断（去掉 `maxMs`）、`stateDigest`（`stateSnapshot`：`layers`、`constants`、`effects`、`general`、`bloom`、`bloomEnabled`、`textFields`、`cameras`、`sounds`、`particleInstances`、`animationLayers`、`passStates`、`userTextures`、`userWritten`）、console 摘要。合并进主工作区、重建产物后跑基线两遍（`ignore/p6/d2/base/`、`base2/`）：236 张逐张相同，带脚本 139 张、5119 段。`13529` 缺 `project.json`，两遍同样报错。
- **步骤 2a**（`moduleRewrite.ts`、`moduleFactory.ts`，61 条单测）。执行代理自己定的、我认可的几处：
  - `export default <表达式>` 换的是 `export` 到 `default` 这个 token 的末尾，不到 `declaration.start`。acorn 不保留括号，`export default (function(){})` 按后者会吞掉左括号。
  - 匿名默认函数 / 类的「放不下」只看替换文本那一段原文里有没有换行；后面的换行照样保留。
  - `P.ns` 的参数用数组不用对象字面量，因为导出名可以叫 `__proto__`。
  - 命名空间 `deleteProperty` 对 `Symbol.toStringTag` 也返回 false（Proxy 不变量）。
  - 星号歧义只在「不同库对象的同名项」时去掉；同一个库经两个说明符导入不算。
  - 生成标识符避开原文全部标识符名与子串，定长名的候选也定长（`$T0_`、`$I0____`、`$M0_______`）。
- **步骤 2b**（realm、运行时、编译期扫描、`realmCheck`、22 个测试文件的假 realm 换成 `fakeModule`，新增 `testing/vmRealm.ts`）。
- **Claude 验收时改的**：
  - **realm 的正则**：`realm.ts` 校验分支里的 `/blob:[^\s)]+:\d+:\d+/` 被执行代理的写文件通道吃掉了反斜杠，变成 `/blob:[^s)]+:d+:d+/`，已改回。
  - **新提交的测试**：对齐到 `996012d6` 后，P12d 新提交的 `puppet/p12bones.test.ts`、`script/p12dBonesApi.test.ts` 的假 realm 还在用 `importModule`，同样换成 `fakeModule`。
  - **补测**：编译期只看静态导入这条原来没有测试，补了 `compile/scriptImports.test.ts`。
  - **锁文件**：`deno.lock` 只多一行（`apps/wpe-scene` 的依赖里登记 `npm:acorn@8.18.0`）。这一行是重建产物时 `deno run` 按 `package.json` 自动写进去的，acorn 8.18.0 的包条目本来就在锁文件里，不用另跑 `deno install`。
- **验证**（回归 H1–H8）：
  - 工作树与主工作区 tsc 0 error；主工作区相关 53 个文件 918 条全过。本机语料下 `compile/pipeline.test.ts`「请求次数有界」失败，主工作区不含本步时同样失败，与本步无关。
  - 变异 13 处全部检出。
  - `p6d2-forms` 与 WPE 日志 26 行逐行相同（改前 3 行不同）。
  - `realmCheck` 14 段错误源码改前改后逐字相同。
  - 全语料改后与基线：能比的 236 张里 231 张相同；5 张只有编译期能力键不同（`object:castvolumetrics`，别的会话未提交的体积光改动），脚本诊断、状态、console 相同；10 张是基线之后导入的，不比。
  - 加载用时：`3660962877`（252 段、27 种源码）新 176–189 ms、旧约 1 s。
  - H8（预览与桌面看画面）留给用户。
