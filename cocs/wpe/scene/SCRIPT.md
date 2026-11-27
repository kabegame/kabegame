# 场景壁纸：场景脚本

> [场景壁纸文档](../WPE_SCENE.md) 的一章：脚本运行时、交互、层级 / 转向 / effect 访问、对象表与结构 API、运行时建层。总体形态、各阶段状态与全部章节的索引在总览里。

## 场景脚本（P3b）

`SceneHost` 在可渲染且有脚本的场景里创建一个隐藏的、同源 `about:blank` 子 frame，作为该场景全部脚本共享的 realm。同进程同线程，宿主在渲染帧里同步调用脚本；子 frame 隔开脚本修改的全局和原型，但同源同权限，**不是安全边界**。场景退回预览图时不推进脚本；属性重编译、GPU 设备重建和再恢复渲染沿用原 realm、模块实例、`shared`、计时器和 `init` 状态。

| 脚本环境 | 实际处理 |
|---|---|
| 浏览器全局 | 照常保留，`fetch`、`setTimeout`、`window`、`document`、`__TAURI_INTERNALS__` 都可见。这里只对齐语义，不是安全边界；计时请用 `engine` 的方法 |
| `console` | 改写成只有 `log`（宿主 DevTools 控制台）和 `error`（应用日志 warn）；`console.warn()` 抛 `TypeError` |
| `localStorage` | 改写成 WPE 的形状：`get` / `set` / `delete` / `clear` 加 `LOCATION_GLOBAL` / `LOCATION_SCREEN`，没有 `remove`，默认位置是屏幕 |

模块按每个场景动态生成 import map：`compile/scripts.ts` 用 `es-module-lexer` 扫描脚本里的原样说明符；宿主按 `sceneAssets` 顺序查找 WPE 的 `scripts/jsmodules/<说明符小写>.js`，递归扫描模块自身的依赖，把**原样大小写的说明符**映射到相应 `file:` 地址。扫描结果连同缺失结果按 `sceneAssets` 缓存在宿主内存；同一个文件 URL 在 realm 里只求值一次。`scripts/jsclasses/baseclasses.js` 先由 `file:` 作为经典脚本加载，提供 `Vec2` / `Vec3` 等全局词法类、`shared`、`createScriptProperties` 和 `_Internal`；非裸说明符在收集期记为脚本错误（只看静态导入与再导出，P6d2 起动态 `import()` 与 `import.meta` 不扫）。

**用户脚本的加载（P6d2，同步工厂）**：用户源码不再各自作 blob 模块求值，改成编一次、按需同步实例化（`script/moduleRewrite.ts`、`script/moduleFactory.ts`、`ScriptRealm.prepareModule`），给 P6d3 克隆带脚本的图层用：
- **加载期**（每种源码一次，按源码文本缓存）：
  - 先按真模块检查：源码前加一行导入「哨兵」blob 模块，哨兵求值时抛一个固定值，所以整张图链接完、用户代码一行不执行。reject 的不是哨兵值，就是以前会得到的错误：`SyntaxError` 没有行列时照旧用 `<script type="module" src=blob:>` 的 `error` 事件按原文补位置。合法与否由浏览器判，不由解析器判。
  - 再用 acorn 把源码原地改写成工厂函数的函数体：`import` 语句、`export` 关键字、`export { … }` 换成等长空白，`import.meta`、`import(`、顶层 `this` 换成等长标识符，每个原有字符的行列不变；导入绑定写在前一行。在 realm 全局作用域以间接 `eval` 编成箭头函数，箭头函数没有自己的 `arguments`，顶层访问照样 `ReferenceError`。acorn 不认、或改写后编不过的，这段报「场景脚本改写失败」、不求值。
  - 它导入的库在 realm 里原生 `import()`，按说明符缓存，所有脚本共用一份（同 WPE）。
- **求值**：每段脚本调一次工厂，同步执行模块顶层，得到自己的一份模块状态；源码相同的两段各有一份。顶层有 `await` 的编成 async 工厂，加载期等它。
- **命名空间**照 WPE 实测（`ignore/p6/d2/wpe-forms.log`）：
  - realm 里的 `Proxy`：键按码元序、活绑定、原型为 null、不可扩展、`[object Module]`；
  - 描述符是 `writable: true, configurable: false` 的数据属性，写入抛 `TypeError: Cannot assign to property '<键>' of [object Module]`；
  - 回调的 `this` 是它；运行时取回调走取值函数，不经 `Proxy`。
  - 具名导入取求值时的值，不是活绑定。WPE 三个库导出的 `let`（`deg2rad`、`rad2deg`）模块里不再赋值，结果相同。
- **和以前不同、照 WPE 的两处**：动态 `import()` 一律返回 reject 的 Promise（`Error: Not supported`）；`import.meta` 是每个模块实例一个没有键、原型为 null 的对象。语料里两者都没有。
- **报错位置**：工厂源码的 `sourceURL` 是 `kabegame-script:<序号>`，原文第 1 行在第 3 行，`messageOf` 减 2。`realmCheck` 带 14 段错误源码（语法、链接、缺库、顶层 `return`、HTML 注释、`await` 作变量名、求值期报错）前后对照，报错文字与行列逐字相同。
- **用时**：每种源码检查、编译各一次，之后每段只调一次函数。能渲染的场景里脚本最多的是 `3660962877`（252 段、27 种源码），加载 176–189 ms；同一宿主里照旧方式逐段 `import(blob)` 约 1 s。

脚本表只扫描 `scene.json`，用 JSON 坐标作稳定 id，收集 `general`、图层字段、effect 字段、pass 的 `constantshadervalues` 四种来源，并记 owner、图层、初值、值类型、`scriptproperties` 和导入。未启用的 effect 里的脚本也入表，材质 JSON 内的脚本目前不收集。`thisObject` 随 owner 分别是 general、图层、effect 或该 pass 的材质常量对象；general 脚本的 `thisLayer` 为 `null`。后者暴露该 pass 全部有 `meta.material` 的常量，没编译出的 pass 则无法写入。`thisLayer` 与 `thisScene.getLayer(数字)` 按 `scene.json` 的 `objects` 下标定位，图层 API 对象跨重编译保持身份；非图片对象当前也有通用图层项，尚无声音、文本等专用 API。

- **首次加载**：按脚本表顺序逐段求值，再按顺序更新 JSON `scriptproperties`（其中 `{user}` 已解析为当前属性值）并调用 `init(value)` 写回；`init` 之后、首帧之前以属性全集为增量走一次直接绑定（`script/initialApply.ts` 的 `applyScriptedProperties`，宿主 `beforeFirstFrame` 与 dev 探针共用，用 `applyChanges` 同一份属性表、含 WPE 内置项）：编译期不挂脚本的字段本来就取属性值，挂脚本的字段取 JSON 的 `value` 给 `init`（`init` 与写回都拿到它），这一次绑定再把属性值盖上去并忘掉脚本记下的 `init` 写回（2026-11-14 修复：此前挂脚本又绑属性的字段停在 JSON `value`，如 `3637191856` 的「Show」打开后时钟仍隐藏）；目标被 `needsRecompile` 挡下或属于重编译类的条目忽略（编译期已按当前属性编过，不再触发重编译）；重编译时同一规则只补脚本没有写入记录的目标，有记录的照脚本最近一次写回重放；之后才是 `updateScriptProperties` 与 `applyUserProperties`；首帧先推进计时器、逐段调用 `update(value)` 并写回，再同步 `SceneState` 到 GPU、渲染，最后报 `ready`。
- **属性增量**：在两帧之间按「直接绑定 → `updateScriptProperties` → `applyUserProperties(增量)`」处理，下一帧生效，`init` 不重跑。只有同时带 `type` 和 `value` 的项会传给 `applyUserProperties`（`text` / `group` 也算，见 P3a「全集里有哪些项」）；`engine.userProperties` 读累计全集，`init` 里就是（含 WPE 的 14 个内置项与没写 `type` 的项，同 WPE）。交给脚本的这两个对象（`applyUserProperties` 的参数、`engine.userProperties`）键按字节序排（大写 < `_` < 小写，`compile/bindings.ts` 的 `scriptPropertyEntries`），与声明顺序、`order`、是不是内置项都无关（2026-11-15 `p3am-order` 实测）。用户直接绑定覆盖旧脚本写入时撤销该目标的重放值。暂停或 `document.hidden` 时不推进帧脚本和计时器；恢复后继续。
- **返回值与写回**：`init` / `update` 的非 `null`、非 `undefined` 返回值按目标类型转换：布尔只收布尔，数字可展开为向量各分量，向量读取 `x` / `y` / `z` / `w`，角度由度转弧度；类型不符不写，字符串目标目前不写。可写图层变换、透明度、颜色、可见性、亮度、材质常量、effect `visible`、泛光开关与参数、`GENERAL_FIELDS` 的字段；`hdr` 等重编译目标仅在值变化时请求重编译。宿主用 `scriptOverrides` 按稳定路径覆盖 Worker 的编译输入，同一时刻最多一项在途，期间再变化则下一轮合并。返回值写到 `text`、`maxwidth` 等不支持目标时只对该段告警一次，不写画面；这类运行期告警不进 `unsupported`（脚本里直接访问 `thisLayer.text` 这类未实现字段，由下面的「脚本 API 检查」在编译期报）。
- **数值是单精度**（2026-11-14 补测，`ignore/p3b-f32`）：WPE 交给脚本的数都是 float32，`init` / `update` 的入参（vec2 / vec3 / float、材质常量）、`thisLayer.<字段>` 与从别的图层读的字段、`size`、材质对象的 `thisObject.<键>` 都是（`100.1` 读成 `100.0999984741211`）。`SceneState` 照旧存 double，只在脚本读取时取单精度（`script/f32.ts`）：每次读都取一次，「读 → 改 → 写回」每一轮和 WPE 同值，累加逐帧逐位相同。角度读写都是 f32 乘法：读 `f32(f32(弧度) × f32(57.29578))`，写 `f32(f32(度) × f32(0.017453292))`（double 除法、读结果再取 f32、× π/180、写回 `f32(度 × 0.017453292)` 等都被实测排除）。入参取单精度不分目标；`thisObject` 读 general、泛光、声音 `volume`、粒子实例覆盖时还是 double（没实测）。
- **错误与保留**：模块导入或求值失败，整段不调用；回调抛错只禁用该段的这个回调，计时器抛错只取消该计时器，其余继续。单个回调超过 15 秒时，等它返回后停掉本场景全部脚本并保留已写画面；死循环仍可能卡住宿主，由既有 ping / 看门狗处理。`console.error` 每段每分钟最多向应用日志报 10 条，超出的数量随下一条可上报日志附带。跨重编译保留 realm 与脚本状态，新 `SceneState` 首帧前由 `replayWrites()` 重放脚本最后一次写入。有脚本时，所有**带材质 pass** 的图层即使初始隐藏也预建 GPU 资源，编码时仍按当前可见性跳过。

- **持久存储**：WPE `localStorage` 存在宿主 `file:` 来源的浏览器 `Storage` 里，键前缀 `kabegame:wpe-scene:ls:<图片 id>:<g|s>:`，所以场景之间、场景与网页壁纸互相看不到，但共用这个来源的配额。值按 JSON 存取，超配额抛错，由回调包装禁用那一段。`LOCATION_*` 的数值是推断的 0 / 1，脚本拿到的是不透明的值。「清空脚本存储」（只在预览的右键菜单与工具条）只清当前场景，清完重建 realm，`init` 重跑；没有宿主存活时广播没人收、不生效，所以画廊的右键菜单里没有这一项。
- **音频缓冲**：`engine.registerAudioBuffers(16 | 32 | 64)` 只能在模块顶层调，返回 `{ left, right, average }`。宿主第一次收到注册时订阅 `WpeMediaHub`，订阅方式同网页壁纸，Windows 与 macOS（14.2+）有数据源；每帧原地写，脚本持有的数组不变。分辨率 n 的每段取对应 64 / n 个原始段的最大值，含义是推断。着色器的 `g_AudioSpectrum*` 读同一份场景频谱（P11a，见 [AUDIO_MEDIA.md](AUDIO_MEDIA.md)「音频频谱 uniform（P11a）」）。

**已提供的脚本 API**（以 `script/api.ts` 为准）：

| 对象 | 成员 |
|---|---|
| 全局 | `engine`、`thisScene`、`localStorage`、按当前脚本切换的 `thisLayer` / `thisObject`；`baseclasses.js` 的 `shared`、`createScriptProperties`、向量 / 矩阵类 |
| `engine` | `frametime`、`runtime`、`timeOfDay`、`canvasSize`、`screenResolution`（按显示缩放 1 算的画布像素尺寸，预览缩小显示时仍与桌面一致）、`userProperties`；`setTimeout` / `setInterval` / `clearTimeout`（按渲染帧 dt 推进）；`isRunningInEditor`、`isMobileDevice`、`isDesktopDevice`、`isWallpaper`、`isScreensaver`、`isPortrait`、`isLandscape`、`isObjectValid`；`registerAudioBuffers`、`AUDIO_RESOLUTION_16 / 32 / 64`。时序属性及计时器不能在模块求值时访问 / 登记 |
| `thisScene` | `getLayer`（名称或 `objects` 下标）、`getLayerCount`、`getLayerIndex`（名称或图层对象）、`enumerateLayers`，未命中返回 `null` / `-1`；general 的字段同下一行 |
| 图层对象 | `name`、`id`、`size`（只读写入无效）、`origin`、`scale`、`angles`、`alpha`、`color`、`visible`、`brightness`、`parallaxDepth`（`Vec2`，P5a） |
| `thisObject` 的其它 owner | general 的 `bloom`、`bloom*` 泛光参数、`GENERAL_FIELDS` 的 17 个字段（含 P5a 的 `zoom`），以及写入走重编译的 `hdr`；effect 的 `visible`；材质 pass 中全部带 `meta.material` 的常量。`fog*`、`wind*`、`gravity*` 等还没有 |

**本机语料里出现、当前未提供的 API**：运行时报错最多的是 `thisLayer.getParent` / `getChildren` / `getTextureAnimation`、声音图层 `play` / `stop` / `isPlaying`、`input.cursorWorldPosition`、图层 `getVideoTexture`；还有 `engine.registerAsset`、`thisObject.getMaterial`。静态扫描另见 `getTransformMatrix`、`thisScene.createLayer` / `sortLayer` / `destroyLayer`、图层 `setFrame` / `getEffect` / `getAnimationLayer`、`input.cursorLeftDown`；文本字段 `text`、`maxwidth`、`horizontalalign`、`verticalalign` 及 `cursor*` / `media*Changed` 回调也未接通（`media*Changed` 在 P11c 接通，见 [AUDIO_MEDIA.md](AUDIO_MEDIA.md)「媒体（P11c）」）。语料中的 `scene.getLayer` 是样本伪代码自身的未定义变量；`localStorage.remove`、`console.warn`、`originalOrigin` 也不是应补的 WPE API。

**脚本 API 检查**（2026-11-07 用户改定，提交 `c8ebf098`，`compile/scriptApi.ts`）：改定前不做静态扫描，未实现的 API 在调用时报错、只禁用那个回调，可能画出半成品。工坊 3304642534 就是这样：可视化脚本在 `init` 里调 `thisScene.createLayer` 造另外 63 根音频条，`init` 报错被禁用，`update` 每帧抛错又被脚本自己的 `try/catch` 吞掉，画面静默缺了整组条。现在编译期扫描每段会执行的脚本，用到下表成员就报 `script:api:<分组>.<成员>`、整张退回预览图；运行期的普通错误仍只进脚本诊断。

- **表**（`MISSING_SCRIPT_API`）：WPE 2.8.42 自带的编辑器补全声明 `ui/dist/monaco/autocomplete/lib.sceneScript.d.ts`，加逆向报告 `p3-script-REPORT.md` 的 C、L1、L14 节，逐项减去 `script/api.ts`、`script/environment.ts` 与 `baseclasses.js` 已提供的成员。**实现一个 API 就从表里删一个**：`script/api.test.ts` 双向核对表里的成员确实不在 `ScriptApi` 上、`ScriptApi` 上的成员也不在表里；`scriptApi.test.ts` 核对表里的名字都出自声明或报告（本机测试）。
- **分组**：`thisScene`、`engine`、`input`、`localStorage`、`console` 按根对象匹配；`layer`（图层及声音、文本、粒子、模型等接口）、`effect`、`object`（所有对象都有的 `getAnimation`；P10b 实现后组为空）按类型分组，不看接收者变量。`thisObject` 按脚本挂在哪里解析：图层 → `layer`、effect → `effect`、材质常量 → 只认 `object`、general → 场景字段（键写 `thisScene.<字段>`）。
- **匹配**：词法扫描成员访问（`a.b`、`a?.b`、`a["b"]`，跳过注释、字符串和正则），不是完整解析器。`root` 项只认根对象直接访问（`play`、`stop`、`text`、`volume` 这类通用名字只认 `thisLayer.` / `thisObject.`）；`any` 项任意接收者都算，只收名字足够独特的，每项写明理由。子对象（纹理动画、视频纹理、动画层等）只能经表里的入口方法拿到，不另收。
- **范围**：只扫 `collectScripts` 收集的 scene.json 脚本；导入说明符无效、整段不会求值的不扫。场景的风、重力字段在能力表里中性，但脚本读写它们照报（脚本读到 `undefined` 会算出 NaN）。
- **3304642534**：报 `script:api:thisScene.createLayer`、`script:api:thisScene.sortLayer`，整场只剩这两项（加检查之前能渲染）。
- **导出回调**（P6 前置，2026-11-11）：WPE 按固定的 19 个回调名调脚本的导出函数（`WPE_SCRIPT_CALLBACKS`，报告 C 节），运行时只调 `init`、`update`、`applyUserProperties`、`destroy`、`animationEvent`（`script/runtime.ts` 的 `RUNTIME_CALLBACKS`；`animationEvent` 是 P10b 加的，见 [ANIMATION.md](ANIMATION.md)「关键帧动画」；之后光标、媒体回调与 `resizeScreen` 陆续加入）。脚本导出了其余回调（`MISSING_SCRIPT_CALLBACKS`：`cursor*` 七个、`media*Changed` 五个、`resizeScreen`、`applyGeneralSettings`）时报 `script:callback:<名>`、整张退回，否则场景会静默缺交互。导出名由 `scriptExports` 用同一套词法认出（函数、类、`const` / `let` / `var` 含解构、`export { … }`，宁可多认；`export default` 与 `export * from` 不认），2026-11-11 对语料 3491 段与 TypeScript 解析器逐段比对，导出名全部一致。实现一个回调就从表里删一个、加进 `RUNTIME_CALLBACKS`，`api.test.ts` 核对两者合起来恰好是 19 个。语料 165 张里 53 张因此多报（光标 45 张、媒体 28 张，这些场景都另有阻塞），能渲染的 36 张不变。P11c 起五个 `media*Changed` 从表里删掉、由运行时的 `mediaEvent` 调（见 [AUDIO_MEDIA.md](AUDIO_MEDIA.md)「媒体（P11c）」）。2026-11-19 起 `resizeScreen` 也删掉、由运行时的 `resizeScreen` 调（见「画布尺寸」），表里只剩 `applyGeneralSettings`。
- **登记顺序**（P10b，2026-11-14 实测 `p10b-order`）：WPE 的脚本列表按「`general` 的字段 → 按 `objects` 数组顺序，每个对象先自己的字段、再它的 `effects`（每个 effect 先 `visible`，再按 pass 顺序的常量）」登记，同一层按键名排序（jsoncpp 的字节序），`init`、`update`、事件派发都按这个顺序；关键帧动画的登记顺序相同。`collectScripts` 与 `collectAnimations` 共用 `compile/registration.ts` 的 `registrationKeys`。WPE 写的 `scene.json` 键本来就按字母序，和按书写顺序遍历的差别只在 effect 的位置（书写顺序里 `effects` 在 `origin`、`visible` 之前）；语料 27 张的脚本先后因此改变。`instanceoverride` 在字段里的位置按字母序是推断。
- **Unicode 空白**：分词时 U+00A0、U+3000、U+FEFF 等是分隔符、不进标识符。语料有脚本写成 `export` + U+00A0 + `function`（3409595232 等），以前整串被切成一个词，导出与成员访问都认不出。

本机 2026-11-04 的 38 张场景中，5 张 `unsupported` 为空、可完整渲染：beach、deep_space、eagleflag、razer_vortex、razer_bedroom；相对 P3a 新解锁的只有 razer_bedroom。23 张含脚本，共收集 638 段（另有 1 段在材质 JSON，未收集）：444 段求值与回调无报错，127 段求值失败，67 段有回调报错；123 段尝试写回不支持目标，209 段导出尚未调用的 `cursor*` / `media*` 回调。仍退回预览图的含脚本场景另有文本、着色器、声音、粒子等渲染阻塞，补 API 本身不等于解锁渲染。

**真机**（2026-11-04 Windows dev）：
- **bedroom 帧开销**：预览与壁纸窗口里 `update` 约 60 次/秒，单次最长 0.1 ms；`frameMs` 均值 0.19–0.22 ms、p95 0.4 ms。
- **与 WPE 抓帧比较**：灯带颜色与 WPE 逐位相等；整帧通道平均差 0.038/255（超高档 0.055/255），残差只在细线与边缘。
- **切「场景后处理」**：三个宿主各重载一次，用时 414–482 ms。重载后 realm 不变、`update` 计数不归零，颜色按墙钟连续、不跳回初值。
- **vortex 切模式**：就地写入，`recompiled` 为空。
- **shimmering**：`bloomstrength` 首次 apply 为 1.0，`glow` 改为 3 后为 1.5，也是就地写入。
- **暂停**：经 `wallpaperPropertyListener` 暂停后，`update` 计数与 `engine.runtime` 都冻结；恢复后接着走，不跳。
- **出错日志**：求值失败与 `init` 报错各记一条带行列的 `warn`，不重复。

宿主的「重新判定 / 重新加载 / 就地更新」是 `debug`，只进宿主自己的 DevTools 控制台，不进应用日志。窗口被完全遮挡时 Chromium 判页面为 hidden、不出帧，脚本随渲染一起停（WPE 按焦点、最大化等设置暂停，触发条件不同）。场景在建 GPU 场景时才失败而退回预览图时，脚本此前已经求值并跑过 `init`。

development 构建的 `window.__kabegameSceneProbe` 提供 `host.scripts()`（逐段状态、导出、禁用回调、错误与调用统计）、`host.read(path)`（读当前目标）、`host.realmCheck(extraSources?)`（另建 realm 检查导入、环境、错误位置与缓存），以及 `scriptCorpus(imageIds, { frames?, dt?, clock?, seed?, postprocess? })`（逐张独立 realm、不建 GPU；生产构建无这些探针）。P6d2 起脚本环境用 dev 探针的 `createProbeScripts`（固定时钟与 `Math.random` 种子、写回读取同宿主、`localStorage` 只在内存、用户属性含 WPE 内置项），缺省按 1/60 s 跑 120 帧；每张返回逐段诊断（去掉计时）、跑完之后的状态摘要 `stateDigest`（`SceneState` 里脚本写得到的各张表）与 console 行数和摘要。同样的请求两次结果逐张相同，P6d2 在改动前后各对库里全部场景跑一遍比对（驱动 `ignore/p6/d2/corpus_run.mjs`、比较 `corpus_diff.mjs`）。`remainingTestFrames` 是 `{ before, after }`，数的是 `iframe[data-kb-script-realm="1"]`，两者相等才说明没有残留子 frame。`missingApis` 是条目数组（类型、名字、场景数、段数、报错数），连带错误按属性名列出，没有归到根因。不派发 `cursor*` / `media*` 回调。

**性能（2026-11-20，3662790108）**：944 段脚本、九百多个对象，脚本每帧按名字取几百次图层、把位置与可见性写回几百个图层，原先预览只有约 2 fps（WPE 正常）。CPU profile（经 CDP 在屏外宿主上抓，`ignore/p6/f4/prof/`）的热点与修法：
- **按名字取图层**：`lookup` 沿对象表逐个取名字，`nameOf` 里的 `findLayer` 又对 `bundle().layers` 线性 `find`，一次 `getLayer('名字')` 是 O(n²)，脚本每帧 541–653 ms。`findLayer` 改走按 `object` 的索引（「`layers` 数组、长度、`SceneState`、`structureVersion`」任一变了就重建：登记表原地增删 `layers` 时宿主同一步改状态），`lookup` 的字符串分支再加一层「字符串 → 第一个同名 / 按 id 的对象」缓存（索引换了、脚本改名、待编对象增删时清空；待删照常每次判断）。脚本降到约 5 ms/帧。
- **同值写入不标脏**：`SceneState.write` 的图层字段原先无条件标脏（继承字段整棵子树），每个脏 draw 重算全部静态 uniform（`staticBuiltins` 的二十多个矩阵、求逆）。现在存下的值没变（逐分量 `Object.is`）就不标脏；`origin` / `angles` / `scale` 的变换写入照记（WPE 每写一次都清挂点缓存的戳），带 `rotateObjectSpace` 的 3×3 时同值的 `angles` 仍算变了。开场推镜头期间 `sync` 从约 36 降到 19 ms/帧。
- **结果**：预览 29 fps（帧率上限 30），脚本约 4 ms/帧。`staticBuiltins` 按程序实际用到的 uniform 才算，留作以后（镜头一直在动的场景仍要每帧全量重算）。
- **诊断**：运行时的回调统计多了累计耗时 `totalMs`（`host.scripts()` 的 `calls`，`scriptCorpus` 比对时照旧只留 `count`），`(totalMs − maxMs) / (count − 1)` 估每帧稳态开销。

**已知差异与后续**：realm 无 CSP，用户代码经 `eval` / `Function` 拼出来的 `import()` 不经改写，仍是原生的，可能加载远程模块（P6d2 起源码里直接写的 `import()` 一律 reject）；API 对象可加任意属性，写入未提供字段可能读回成功但画面无变化；回调里排的微任务（Promise）时机不同：WPE 推断在每个最外层回调返回后冲刷，我们要到本帧任务结束才跑（本机样本没用 Promise）；`thisObject.constructor.name` 我们是 `Object`，WPE 是空串，`String(thisObject)` 两边都是 `[object Object]`。不清屏的场景暂停时改属性，补画的那一帧会推进累加链（回归 D46，用户定为不动）。HDR 不清屏累加时，分界线上有约 1 像素宽的残余差异（回归 D37），推断是 FP16 舍入，没有抓帧证实。单层 mip 纹理的差异和非整数 `size` 的四边形（WPE 截断）没有处理，见 3c 计划「后续」。后续按渲染能力阶段补音频、层级、输入、纹理动画、声音和文本 API，并处理材质 JSON 脚本。当前有意不照搬 WPE 两个缺陷：属性增量不会从 `engine.userProperties` 的已有全集中丢键（WPE 注入的 14 个内置项首包补进全集后一直保留，见 [HOST.md](HOST.md)「属性与快速路径」的取值规则）；CLI 颜色改值也不降成字符串。

## 交互（P6c）

场景脚本的光标交互：六个导出回调 `cursorEnter` / `Leave` / `Move` / `Down` / `Up` / `Click`、全局 `input`、图层 `solid`。规则读码在 `.claude/plans/wpe-import/3-scene/phase6/rea-p6c-dispatch.md` 与 `rea-p6c-script.md`（含 REA 重核），0c 用 wpe-renderdoc 的 `input_play` 逐帧喂光标实测，结论全部成立。实现是纯逻辑的 `render/cursor.ts`（命中、追踪器、可拾取对象表），渲染器每个实时帧在相机更新之后、脚本之前调一次（`SceneRenderer.stepCursor`），把回调交给宿主，宿主调 `ScriptRuntime.cursorEvent`。

### 规则（和 WPE 一致的怪处）

- 只有图像层与文本层参与命中（`SceneLayer.pick`，`cursorPickKind`）；粒子、形状、声音、分组节点、灯、相机不参与。模型（类型 5）不做命中：模型上有脚本导出光标回调、或模型可见且 `disablepropagation` 为真时报 `cursor:model`（语料 0 张）。`cursorHitTest` WPE 自己也不调用，导出它只打开拾取（`ScriptRuntime.hasCursorCallbacks`），返回值没人解释。
- **不看可见性**：`visible: false`、父层隐藏、`alpha` 为 0 的图层照样收事件，语料靠隐藏图层当按钮。`solid` 缺省真，`solid: false` 的对象什么事件都没有；运行中改 `solid` 下一帧的命中才生效。
- 命中是射线对平行四边形（双面，不看纹理 alpha，不要求 `u + v ≤ 1`）；四边形取画自己的矩阵（含对齐、文字框偏移、父链）；`fullscreen` 图层恒命中、不发 `cursorLeave`，`localPosition` 是窗口像素。
- `localPosition` 以四边形左上角为原点、y 向下、单位是 `size`（不乘缩放）；没命中也算（外推到 `[0, size]` 之外），射线平行或交点在后方时是 0。`worldPosition` 是本帧相机下光标的反投影（正交 z 置 0，透视落在远平面）。
- 层叠时全部命中的对象都收事件（自上而下，同一帧里按对象依次）；只有命中一个「自身与父链都可见且 `disablepropagation` 为真」的对象才挡住下面的，被挡住的这一帧不处理，也不发 `cursorLeave` / `cursorUp`。
- `cursorMove` 比的是**世界坐标**：光标不动、相机在动（抖动、视差、缩放）时每帧都发；第一帧上一次是 (0, 0)。
- 子层的视差命中用自己的本地 `origin` 与自己的 `parallaxDepth`（绘制用根对象的），命中区和画出来的位置可以错开。
- 按下只登记命中的对象；按住期间只给按下集合里的对象发 `cursorMove`（外推坐标），不发进出；`cursorClick` 要松开那一帧命中、且按下那一帧在它上面；松开处命中的全部对象收 `cursorUp`，另加按下集合里没命中的；按下集合在每个松开帧末清空。一帧里同一对象的顺序：`Enter → Move → Down`、`Enter → Move → Up → Click`、没命中时 `Up → Leave`。
- 一帧只采一次左键：两帧之间完整的一次按下抬起整个丢掉。暂停时不采样、不派发。

### 帧内位置与数值

渲染器一帧：相机（`setCamera`）→ 光标命中派发 → 声音 → 关键帧动画 → 计时器 → `update`。所以同一帧的回调先于 `update`，回调里写的字段当帧画出。数值逐步 float32：反投影用 WPE 的 float32 求逆（`render/inverseF32.ts`，从反汇编 `0x14005f730` 生成，`ignore/p6/c1/gen_inv.py`；double 余子式的 `invert` 在正交矩阵上差 1 ulp），射线对四边形照 `FUN_14019d5a0`。`perspective: true` 的图层用透视覆盖相机的射线（`perspectiveLayerRay`，`FUN_14018fc40`）。`GpuScene.cursorCamera` 交出本帧的 `P·V`、眼位与覆盖输入。

### `fill` 裁切（P6c 修复 2）

> 2026-11-19 起产品按画布分辨率画、投影本身带裁切（「铺放与帧循环」），光标在所有按画布画的样式下都直接用窗口指针按裁过的 `P·V` 反投影，
> 下面这个只给 `fill` 打的补丁（`cursorCrop` / `fillCropEdges`）产品不再用，只剩 dev 探针的旧画法（`renderMode: "scene"`）与 `replayPointers`。

WPE 渲染到窗口，居中盖满的裁切做进投影的四个边界（`ortho(E0, W − E2, E3, H − E1)`，`alignEdges` 的模式 0），光标直接用窗口归一化指针按这份 `P·V` 反投影；我们的场景目标是场景分辨率、`P·V` 不裁。所以样式是 `fill` 且窗口与场景比例不同（`fillCropEdges`，整数交叉相乘判，精确）时，光标反投影改用**裁过的 `P·V`**（`croppedCursorViewProjection` = `mulAffine(sceneViewProjection(general, 总缩放, edges), V)`，zoom 三步照 WPE 无条件做）和窗口指针，不再先过 `sceneCursor`（double）：命中与世界坐标（`CursorCamera.windowCursor`）、粒子跟随指针（`GpuScene.cursorCrop` 让 `pointerScenePoint` 用它）都走它。别的样式与比例相同时逐字节同以前。

- 依据：`clockv-drag` 抓帧里 FR（`T(−100000, −100000)`）的 MVP，`m0 = 0.0005095108645036817`、`m5 = 0.0009057971183210611`、`m12 = −51.95380401611328`、`m13 = −91.5797119140625` 与这样算出的逐位相同；走查日志 969 帧里 968 帧的 `origin` 逐位复现（另 1 帧光标已移出窗口、`origin` 不再变），之前 1 ulp 的差（如 `1340.35546875` 对 `1340.3555908203125`）消失。投影的构造沿用 render-size 已核对的 `alignEdges` + `orthoWpe`（每步 f32）+ zoom 三步，缩放、V（抖动、相机对象的 lookAt）在其后相乘，和不裁时同序；缩放、抖动、相机对象与裁切的组合没有单独抓帧，只按读码与不裁时的组合顺序推定（单测只对了 zoom 与 V 的平移方向）。
- 没做：透视场景（本来按画布尺寸画、不裁）；`perspective: true` 图层的覆盖相机射线（`perspectiveLayerRay`）仍用按铺放换算的场景坐标与不裁的投影，WPE 的覆盖相机在裁切下 `d` 与相机位置也变（`croppedParticleViewProjection` 的算法，没接到光标上）；`pointerScenePoint` 仍是 double 求逆（比例不同时与 WPE 末位可能差 1 ulp，没有抓帧核对，同比例的 P4c 回归要求逐字节不变所以没改）。

### `input`

全局对象，三个只读成员，每次读现取、建新对象：`cursorWorldPosition`（`Vec3`，同回调的 `worldPosition`）、`cursorScreenPosition`（`Vec2`，`ptr × 窗口像素`，左上原点、y 向下、不钳制，和 `engine.screenResolution` 同一套单位）、`cursorLeftDown`（登记的左键）。模块顶层读抛 realm 的 `SyntaxError: <成员名> cannot be accessed from global scope.`；`init`、回调、计时器里都能读。快照由渲染器每个实时帧给（没有脚本导出光标回调时也算）。

### `solid`

所有图层都有，读回布尔，写入只收布尔（别的类型不写、不报错），没有改值回调、不标脏。JSON 的 `{user}` 绑定走就地路径（`LayerField` 的 `solid`），`solid` 上的字段脚本写回到它。`disablepropagation` 只认 JSON 布尔，绑属性、挂脚本报 `object:disablepropagation`。事件对象每个接收者各建一个 `{ button: 0, worldPosition, localPosition }`（`Vec3`，没有 `hitBox`，木偶命中框是 P12）。

### 宿主左键

`main.ts` 的 `pointerdown` / `pointerup`（只认主键，`pointercancel` 与窗口失焦当抬起）→ `SceneHost.setButton` → `SceneRenderer.setButton`。按下门由 `tauri-plugin-cursor` 的点击规则负责（桌面：光标下是桌面或图标；预览：光标下是本窗口），宿主不另加；应用背景不交互。宿主把 `blur` 当抬起，所以预览要等真实左键松开后才把焦点从 iframe 还给父页面（`framePointer.ts` 的 `keepFocusOutOfFrames`），否则拖动会断。

### dev 探针

`renderFrame` 新增 `inputTimeline`（wpe-renderdoc 的时间线格式 `[x, y, down, n]`，要同时给 `window`，指针按 WPE 的取法量化到整数像素，`expandInputTimeline`）与 `buttons`（逐帧左键）；要有 `particles.dts` 与 `scripts`，每帧在设好相机之后、脚本之前命中派发（`ProbeScripts.cursor`）。`scripts: { consoleGrep }` 收脚本 `console` 里匹配的全部行（`console.matched`，不带 `error: ` 前缀，同 WPE 日志）。对比工具：`ignore/p6/c0/cmp_logs.py`（我们的 `[kbp6c]` 行对 WPE 日志，自动找帧偏移）、`ignore/p6/c1/run_ours.py`（经 vite REST 回放）。

### 对比结果与已知差异

五个确定性工程（`ignore/p6/c0/proj/p6c-*`）：`hit` 回调 98 / 98 与 `upd` 169 / 169 逐字相同，`par` 13 / 13；`shake` 回调序列 42 / 42 相同，数值差 ≤ 0.13（WPE 当时的 `g_Time` 取不到，用 `(帧 + 偏移) × 0.05`）；`zoom`（`perspective: true` 图层）35 / 49 逐字相同，其余 `localPosition` 差 ≤ 4.6e-5（覆盖相机的 float32 链没有逐步搬）；`persp` 序列相同，世界坐标差 ≤ 1e-3（远平面上 1 ulp，来自透视相机矩阵的 float32 组合）。窗口与场景比例不同的 `fill` 下 `origin` 的 1 ulp 差已按上节修掉（走查 `clockv` 1080p 968 / 968 帧逐位相同）。已知没做：模型命中、木偶 `hitBox`、透视场景里 bit9 层的命中排序（`TODO:[WPE_SCENE]`）；`openUserShortcut` 在 P11d 实现，见 [AUDIO_MEDIA.md](AUDIO_MEDIA.md)「快捷方式（P11d）」。语料能渲染 +11（`3146703458`、`3173418061`、`3340707146`、`3451555874`、`3460973721`、`3605722997`、`3637191856`、`3809965824`、`3810092560`、`3817779853`、`3832004152`）。

## 层级、转向与 effect / 材质访问（P6d1a）

脚本拿到的层级（父、子、世界矩阵）、三个转向方法、effect 与材质对象，外加 `getLayerByID`。读码见 `.claude/plans/wpe-import/3-scene/phase6/rea-p6d-layers.md`（9、10 节）、`rea-p6d-script.md`、`rea-p6d1-xform.md`；WPE 实测的工程由 `ignore/p6/d0/make_p6d1.py`、`make_p6d1b.py` 生成，全精度读回在 `ignore/p6/d0/out/p6d1-xform.log`、`p6d1-round2.log`；计划与记录见 [phase-6d1-hierarchy-effects.md](../../../.claude/plans/wpe-import/3-scene/phase6/phase-6d1-hierarchy-effects.md)。改结构的 `setParent`、`sortLayer`、建删层是 P6d3。

### 层级

- `getParent()` 返回父的图层对象，根返回 `null`；`getChildren()` 每次新数组，按子表顺序（P6d3a 起读状态：加载时 `objects` 顺序，换父挂上的追加在尾）。
- `getTransformMatrix()` 返回新的 `Mat4`（自有键 `m`，16 个 f32，平移在 12–14），值是**当前状态**的世界矩阵乘图层自身偏移（`drawMatrixOf`，含父链、自己的对齐偏移，子层不继承父的对齐偏移），当场读到刚写的变换（父 `rotateObjectSpace` 之后立刻读子已经跟着变）。场景有挂点缓存（`WorldStamps`，P12b1 的 B1）时照 WPE 走那个带戳的函数：先给本帧已有的变换写入清戳、再按戳求值，求值会改写戳与缓存，之后的绘制沿用（`GpuScene.transformMatrix`）。
- 图层对象**没有 `id`**（WPE 实测 `undefined`）。`thisScene.getLayerByID(id)` 只收字符串，照 C `strtol` 解析（前导空白按 `isspace`）后按 JSON `id` 找；数字返回 `null`。`getLayer()` / `getLayerByID()` 不传参数返回 `undefined`。

### 旋转的两份状态与转向方法

WPE 每个对象存角度与 3×3 两份旋转，画面、子孙、`getTransformMatrix` 只读 3×3；角度写入（JSON、脚本、属性、关键帧、`lookAt`）先存角度再按 `Rz·Ry·Rx` 重建 3×3。`LayerState.rotation`（9 个 f32，列主序）照搬：`null` 时 `layerLocalMatrix` 按角度现算（`anglesRotation`，逐字节同以前），任何 `angles` 写入都清成 `null`。写入目标 `rotation` 只由脚本 API 产生，路径键同 `angles`（`objects/<i>/angles`），后写的胜出，重编译重放原样恢复。公式在 `render/rotation.ts`，逐运算 f32，对 WPE 读回逐位相同（`render/rotation.test.ts`）。

- `rotateObjectSpace(v)`：`R ← R · Rz(v.z) · Ry(v.y) · Rx(v.x)`，分量是**弧度**（`angles` 字段在脚本里是度），绕自身轴；每步照 glm `rotate` 通式（轴向对角元是 `(1−c)+c`）。乘出来的 3×3 直接写进状态，角度按 glm `extractEulerAngleZYX` 反算（读回会被归一化：`400°` 读回 `40.000004`）；参数不是对象时只做归一化。转完再把读回的角度写回去，矩阵末位会变（改按角度重建）。
- `lookAt(target, up = (0, 1, 0))` / `lookAtYaw(...)`：目标与 `origin` 同在父空间（不读父链）；普通对象本地 +Z、相机对象 −Z 对着目标；`lookAtRH` 后从视图矩阵按 ZYX 取角度，交给角度 setter（写入目标 `rotation`、3×3 为 `null`）。`|d|² ≤ 1.1920929e−07` 什么都不做；视线与 up 平行时写进 NaN（图层不画，WPE 同）；up 不归一化；`lookAtYaw` 先 `d′ = d − up·(up·d)`；不传目标或目标不是对象 = 看原点。返回 `undefined`。

### effect 与材质对象

- `getEffectCount()` 数 JSON 里全部 effect（含写死关闭的）；`getEffect(i | 名字)`：整数按 JSON 下标，名字按当前 `name` **区分大小写**、同名取最后一个，空串、越界、别的类型 `null`。返回的就是挂在 effect `visible` 上的脚本的 `thisObject`。
- **编译期**：场景里会执行的脚本有 `getEffect` 成员访问时（`SceneScripts.usesEffectAccess`，词法同能力表），写死关闭的 effect 也按「`visible` 可变」编进 bundle（WPE 加载时全部 effect 都在列表里，脚本能当帧打开），`SceneLayer.effectCount` 记 JSON 个数；没有时维持跳过（B11），bundle 不变。
- effect 对象：`name` 可读写（只存在脚本 API 这边，没有改值回调，跨重编译保留）、`getMaterialCount()`（条件过滤后的绘制 pass 数）、`getMaterial(i | 文件名)`（无参 = 0；文件名按 `ScenePass.material` 不分大小写全等，空串匹配每一个，最后一个胜出），返回的就是挂在材质常量上的脚本的 `thisObject`。`executeMaterialFunction` 照报（`script:api:effect.executeMaterialFunction`）。
- 材质对象的键：编译后着色器**实际读到的**材质常量（`MaterialSlot.used`；chromaticaberration 缺省 `MODE 0` 没有方向键），然后是五个状态字段 `depthwrite, depthtest, cullmode, alphawriting, blending`（字符串，可读写，写入见下面「材质状态字段的写入（P6d1b）」），再是 `getAnimation`。常量键的顺序照 WPE（`script/materialKeyOrder.ts`，读码 `rea-p6d1-keyorder.md`）：材质键按 UTF-8 字节序（WPE 的合并常量表是有序 `std::map`）依次插入 MSVC `std::unordered_map`（FNV-1a、8 桶起、`(size+1)/桶数 > 1` 扩容、非空桶插在桶首），取链表顺序，前面拼上静态表的链表顺序，再整串倒序（V8 装访问器时倒了一次）、同名去重，末尾 `getAnimation`。tint、transform、chromaticaberration 两种组合键、fire / pulse（9 个键，触发扩容）、lightshafts（12 个键）七组和 WPE 逐项相同。
- `setMaterialProperty(名, 值)`：值按 dll 归三类——数；任何对象（`Vec2/3/4`、`{x, y}`、数组）只取 x、y（非有限数当 0）当 Vec2；其余（字符串、布尔、`null`、不传）当整数 0。对这个 effect 的**每个 pass** 按名字全等（区分大小写，`g_` uniform 名不收，状态字段不收）找常量：数写 float 常量（不钳），Vec2 写 vec2 常量，别的组合跳过，所以 vec3 / vec4 常量永远写不进、非数值把 float 写成 0。和字段写入同一个 setter，当帧生效。返回 `undefined`。
- **`rad2deg` 常量的单位**（注解 `"conversion": "rad2deg"`，`MaterialSlot.rad2deg`）：状态与 uniform 是弧度；JSON 值、用户属性原样当弧度；脚本一侧一律度——材质对象字段读写、`setMaterialProperty`、常量上字段脚本收到的 `value` 与返回值（`p6d1-mat6`：JSON 0.5 读回 28.647890°，属性 30 读回 1718.8734°，字段脚本收到 28.647890、返回 45 读回 45）。度 → 弧度存 `f32(f32(度) · f32(0.017453292))`，同图层 `angles`。

### 材质状态字段的写入（P6d1b）

读码 `rea-p6d1-matstate.md`；实测工程 `p6d1-mat7`（blur 四个 pass 各写一项）、`p6d1-mat8`（五个字段的取值）由 `make_p6d1b.py` 生成，`p6d1-a2c`（自写的探针 effect，八组）由 `make_p6d1c.py` 生成。

- **取值**：一张表（`compile/passState.ts` 的 `PASS_STATE_TABLES`），编译期的 `normalizeDepthKeys`、`SUPPORTED.blending` 与运行中的写入共用。`blending` normal / translucent / additive / alphatocoverage，`alphawriting` default / disabled / enabled，`depthtest`、`depthwrite` disabled / enabled，`cullmode` normal / nocull。脚本写入先 `ToString`、按全等查（区分大小写，空白也算），查不到复位成**表的第一项**（所以 `depthtest` / `depthwrite` 写错会关深度）；`null` / `undefined` 不写。读回是当前的规范名。
- **状态**：写入目标 `{ kind: "pass-state", pass, field }` 进 `SceneState.passStates`（只存写过的字段），写入当场把图层记进 `dirty.passStates`（同值也记、不每帧）；脚本写入表的键 `<pass>/state/<字段>`，重编译后重放。没有改值回调（WPE 每次绑定材质现读这五个字节）。
- **渲染**：`GpuScene.planOf` 先 `applyPassStates`（`render/passState.ts`）把基础材质与 effect 绘制 pass 换成「bundle 值 + 覆盖」，现有的角色规则一条不改：中间 pass 的 normal 是不混合，最后一个 effect 的上屏 pass 借基础材质的混合与深度、剔除用自己的，translucent / additive 不写深度，写掩码与 A2C 入口照 `writeState.ts` / `alphaToCoverageEntry`。所以在上屏 pass 上写 `blending` / `depthtest` / `depthwrite` 不影响画面（读回是写的值），写基础材质的这三项上屏 pass 跟着变。`sync` 对写过的图层 `rebuildLayer(…, { force: true })`。**程序不换**：组合键 `ALPHATOCOVERAGE`（与 WPE 的 `ADDITIVE`）只在加载时按 JSON 拼，运行中切到 A2C 只开丢弃、着色器不锐化（`p6d1-a2c` 的 M1、M2a / M2b）。
- **新组合的管线**：加载时只备了 bundle 值的管线，运行中写出的新组合在后台建（`createRenderPipelineAsync`），建好之后的下一次 `sync` 换上，期间这一层保持旧状态；已备好的组合（写回加载时的值）当帧换上。和 WPE 当帧生效不同（已知差异，语料 233 张没有脚本写这五个字段）。dev 探针读回前结清（`settlePassStates`，同文本重排），所以探针的画面是当帧生效的。
- **深度附件**：脚本用到 `getEffect`（拿得到材质对象）时场景目标加载就挂深度附件（WPE 恒有），运行中写 `depthtest = 'enabled'` 才有效；加载时没有 pass 测深度，比较恒为 always、不写，画面不变。
- **透明排序**：透视场景的透明排序类别仍按编译期的 `blending`，运行中改了不重新分类（WPE 怎么做没读码，`TODO:[WPE_SCENE]`）。

### 对比结果

dev 探针跑 `p6d1-xform`、`p6d1-xform2`、`p6d1-cam`、`p6d1-mat`、`p6d1-mat2/3/4/6` 的脚本，`[kbp6d]` 读回和 WPE 逐位相同（材质对象键的顺序另用 `p6d1-keys` 核对扩容）；`p6d1-mat` 八块颜色与 `p6d1-xform`、`p6d1-xform2` 的画面和 WPE 抓帧一致。语料能渲染 +1（`3243449890`）。

P6d1b：`p6d1-mat8` 五个字段 36 次写入的读回和 WPE 实测的规则逐项一致；`p6d1-mat7` blur 四个 pass 的混合、写掩码、剔除、深度和 WPE 抓帧相同；`p6d1-a2c` 八组中心像素 7 组相同，C3（加载时 additive）WPE 是 (255, 255, 0)、我们 (255, 0, 0)：加载期没加 `ADDITIVE` 组合键，WPE 自带着色器只在雾效里读它，雾效现在照报，语料的工坊着色器没有读它的，随雾效一起补。语料不变（干净 160 → 160）。

## 对象表与结构 API（P6d3a）

脚本改场景结构：`sortLayer`、`destroyLayer`、`setParent`，以及下标 API、`getInitialLayerConfig`、`registerAsset`。建层（`createLayer`）见下一节「运行时建层（P6d3b）」。

- **依据**：
  - 读码：`rea-p6d-layers.md`（第 3、5–9 节）、`rea-p6d-script.md`（第 1、3–7 节）、`rea-p6d3-adjust.md`（`setParent` 的 adjust、组判定、组深度）。
  - WPE 实测：工程由 `ignore/p6/d3/make_step0.py` 生成（`p6d3-struct`、`p6d3-parent`、`p6d3-attach`），加上 `ignore/p6/d0/proj/p6d-tree`；日志夹具在 `ignore/p6/d3/out/wpe-*.log`。
  - 计划：[phase-6d3-runtime-layers.md](../../../.claude/plans/wpe-import/3-scene/phase6/phase-6d3-runtime-layers.md)。

### 对象表

- **`SceneState.order`**：WPE 的对象表（`G+0x158`），装全部对象键，包括灯、声音、相机、分组节点、子对象。加载时就是 `bundle.layers` 的顺序。读它的有：
  - 脚本的原始下标；
  - 顶层绘制与透明排序的输入；
  - 平面反射 pass；
  - 体积光的插入点；
  - 粒子的步进顺序；
  - 相机对象的选择（取**最后一个**可见的，`sortLayer` 相机会换掉当前相机）；
  - 光标命中（正交按它倒序）。

  渲染侧按 `structureVersion` 缓存派生表（`render/structure.ts`）。
- **组内顺序跟子表走**，不跟对象表：把组里的子层排到组前面，它照样由组画。子表初值是编译产物 `bundle.children`（加载时按 `objects` 顺序，换父挂上的追加在尾）；`assignGroups` 的组内先序按它排。
- **下标 API**（照 dll 的表）：
  - `getLayerCount` = 表长 − 待删；
  - `enumerateLayers` 跳过待删；
  - `getLayerIndex` 是原始下标，含待删；
  - `getLayer(数字)` 按原始下标，待删或越界返回 `null`；
  - `getLayer(名字)` 取第一个同名的，它待删就返回 `null`、不再往后找，找不到再按 `strtol` 当 id。
  - **对象参数不看待删**（dll 的对象分支直接取指针）：同一帧用对象再删一次仍返回 `true`，`sortLayer` 照样排。`setParent` 的父例外，走 exe 侧的解析，待删的父当没有。
- **`sortLayer(x, i)`**：
  - 少于两个参数、第二参不是 Number（`'3'` 也算）返回 `false`；
  - 否则 `ToInt32`，先摘掉再插到 `i`，`i` 按无符号与表长比，越界和负数都到末尾。
- **作用域门**：`thisScene` 的下标与结构方法在模块顶层调用，抛 `SyntaxError: <名字> cannot be called from global scope.`。文案照 dll，有两处抄错的名字：`getLayerByID` 报 `getLayer`，`getInitialLayerConfig` 报 `destroyLayer`。语料里没有脚本在顶层调它们。

### 删除

- **生效时机**：`destroyLayer` 只记待删（`SceneState.markDestroy`），所有脚本跑完之后、绘制之前一次生效（`script/structure.ts` 的 `settleDestroyed`，宿主 `beforeFrame` 与 dev 探针共用）。所以同一帧排在后面的脚本照收 `update`，这一帧不画。
- **生效时做的事**：
  - 从 `order`、`layers`、父的子表里摘掉；
  - 子对象变成根，本地字段不动，世界变换跳变；
  - 挂在它上面的脚本条目（图层字段、effect、材质常量、动画层）先收 `destroy` 再摘除，计时器与写入重放表一并清掉；
  - 声音停播，光标的悬停 / 按下集合摘掉它，不发 `cursorLeave` / `cursorUp`；
  - 渲染侧在 `sync` 里释放它独有的 GPU 资源（`GpuScene.releaseRemoved`）。
- **作废**：之后这个对象，以及它的 effect、材质对象都作废：读字段得 `undefined`、写入忽略、方法返回 `undefined`、`engine.isObjectValid` 为假。
- **删组**：被删的是组合层，或在组里时，请求一次重编译（组归属是编译产物）。WPE 当帧就把剩下的子层改由顶层画；我们要等重编译完才画，这一段不画它们，是已知差异。

### 换父

`setParent(parent, attachment | adjust, adjust)`：

- **解析**：
  - 第一参：对象、名字、id 字符串、下标都收；解析不到（含待删）就解除父子。
  - `adjust` = 第二参或第三参是 `true`。
  - 第二参是整数或字符串时当挂点，按新父 puppet 的挂点表找，找不到当没有挂点。
  - 父与挂点都没变直接返回。
- **成环**：WPE 没有成环检测，实测整个进程崩溃。我们拒绝这个调用、记一条 warn。
- **组深度**：
  - 「组」是模型 JSON 里 `passthrough: true` 的图像层，没有子层也算；
  - 先从旧父摘掉，再检查 `up(新父) + down(自己) ≥ 4`；
  - 失败时父置空、本地字段不动，抛 `Error("Invalid parent configuration.")`。
- **adjust**（`render/adjust.ts`，逐位移植 `rea-p6d3-adjust.md` 第 1 节）：
  - 平移取 `inverse(W_新父) · W_旧`；
  - 局部旋转取「父链刚体旋转的逆 × 自身链刚体旋转」，按 `extractEulerAngleZYX` 写角度，再重建 3×3；
  - 缩放让新世界矩阵每列长度等于旧的，所以新父有非均匀缩放时剪切会丢掉（WPE 同）；
  - 带挂点时本地变换归零。
- **结构记录**：宿主把换父记进结构（`SceneStructure.parents`，按先后），每次编译都带上。改了组归属或挂点的（自己子树、旧父链、新父链上有组合层，或挂点前后有一边不为空）请求一次重编译。WPE 当帧生效，我们晚到重编译完，是已知差异，语料里 `setParent` 是 0 处。

### 结构跨重编译

- **编译输入**：`SceneStructure { destroyed, parents }`（`compile/protocol.ts`）。编译时：
  - 删掉的项当作不存在，不进 `bundle.layers`，下标不移；
  - 父覆盖在 `resolveParents` 之后套用；
  - 带挂点覆盖的对象不要求父排在前面。
- **接续**：渲染器新建的状态在首帧前 `adoptStructure(旧的脚本状态)`，接过对象表、待删、父与子表，再重放脚本写入。首次加载时 `init` 里的排序、换父、删除也经这一步落到首帧。
- 「清空脚本存储」时结构清空，回到 `scene.json` 原样。

### 配置原文与登记资源

- **`getInitialLayerConfig(x)`**：返回加载时的配置原文（`bundle.configs`，`compile/config.ts`，在套用脚本写入覆盖之前取），每次在 realm 里新解析一份。按 jsoncpp writer 规整：
  - 去掉顶层 `id`；
  - 所有层级的键按字典序；
  - 非整数按 8 位有效数字，整数原样。
- **`engine.registerAsset(path)`**：
  - 只能在模块顶层调，否则抛 `SyntaxError: registerAsset can only be called from global scope.`；
  - 返回路径字符串本身；
  - 同一段脚本重复登记同一路径返回 `null`。

  登记表只用来判重复。P6d3b 的 `__workshopId` 改写不读它，查的是宿主的场景文件表（见下一节）。

### 对比结果

**脚本日志**：dev 探针跑 900 帧（dt 1/60），`[kbp6d3]` 输出和 WPE 日志逐行比：

| 工程 | 结果 |
|---|---|
| `p6d3-struct` | 27 行全部相同 |
| `p6d3-parent` | 前 40 行相同，只有成环那一步不同：WPE 崩溃，我们拒绝后继续 |
| `p6d-tree` | 51 行中 48 行相同。另 3 行是图层 / effect 对象的自有键集合与原型，P6d1 起就有，P6d3a 前后不变 |
| `p6d3-attach` | 换父的结构与字段对上。挂点要等重编译（探针不做重编译），挂点的世界位置又依赖 puppet 姿势，所以矩阵不同 |

**画面**：`p6d3-struct` 按 WPE 抓帧的帧号回放读回 1280×720。
- 第 1、2 阶段（组内排序）和 WPE 逐像素相同。
- 第 5、6 阶段（相机排序与删除）只差左下角的 G1：删组之后 WPE 当帧由顶层画，我们等重编译，是已知差异。

**语料**：解锁 `2887099508`（`destroyLayer`）、`3570755196`（`registerAsset` 登记字体）。`2887099508` 的开场镜头还没有：`objects/52/visible` 是混淆脚本，用解码出的字符串调 `thisScene.getCameraTransforms` / `setCameraTransforms`，让相机跟着 52 号对象的 `origin` 关键帧滑动。编译期的缺口扫描认不出这种写法，运行时撞到就停用了 `update`。这两个 API 转交 P5（相机）实现，P5e 已实现（见 [CAMERA.md](CAMERA.md)「脚本的相机基准（P5e）」）。点书翻页用的 `playSingleAnimation`（`objects/18/visible` 的 `cursorClick` / `animationEvent`，同样是混淆字符串）转交 P12（`TODO:[WPE_SCENE]`）；全部脚本解码后对照缺口表，这张场景没实现的只剩它一个。`scriptCorpus` 全库的变化全部来自去掉的四个缺口键：`registerAsset` 3 张、`sortLayer` 10 张、`getInitialLayerConfig` 4 张、`destroyLayer` 3 张。没有新增的键，也没有作用域门带来的新报错。

## 运行时建层（P6d3b）

`thisScene.createLayer(...)`：当场建出对象、返回图层对象。P6d3b 时新对象靠整场重编译画出来；活的场景图 L5 起改成经编译会话编成片段接进场景（见 [COMPILE.md](COMPILE.md)「编译会话与对象片段（活的场景图 L1）」的「运行中建层走片段（L5）」），原计划的 P6d4 并入了那条线。本节讲参数、待编对象与脚本，接进场景的部分见下面「编译与首帧」。

- **依据**：
  - 读码：`rea-p6d-script.md`（第 1.2、1.3、2.2、2.3 节：参数分支、缺省模型、`__workshopId` 的路径改写）、`rea-p6d-layers.md`（第 3–5、11 节）。
  - WPE 实测：工程由 `ignore/p6/d3/make_step0b.py` 生成（`p6d3b-default`、`p6d3b-bars`、`p6d3b-clone`），加上 `ignore/p6/d0/proj/p6d-asset`、`p6d-order`；日志夹具 `ignore/p6/d3/out/wpe-*.log`，画面 `out/wpe-bars.png`。
  - 计划：[phase-6d3-runtime-layers.md](../../../.claude/plans/wpe-import/3-scene/phase6/phase-6d3-runtime-layers.md)「P6d3b」。

### 参数整理（`script/createConfig.ts`）

纯函数，参数 → 一份和 `scene.json` 里一个对象同形的配置；建不出来返回 `null`。

- **参数个数不是 1**：缺省纯色层 `{ image: 缺省模型 }`。缺省模型正交场景是 `models/util/solidlayer_depthtest.json`，透视场景是 `models/util/solidlayer.json`。
- **对象**（含数组）：先过调用那一刻 realm 里的 `_Internal.stringifyConfig`（`Vec` → `"x y z"`），再解析：
  - 普通对象走整理；
  - 数组原样返回，建出空名的分组节点，配置原文就是这个数组；
  - 别的（`Vec3` 本身等）返回 `null`。
- **字符串**：先当 JSON，是普通对象就走整理；否则当资源路径，按第一段目录定键（`models` 下 `.json` 是 `image`、其它是 `model`，`particles` → `particle`，`materials` → `sprite`，`sounds` → `sound`），别的目录返回 `null`。路径分支不补缺省模型、不整理。
- **其它类型**：`null`。
- **整理**：
  - 有 `color`、没有任何内容键（`model` / `particle` / `sprite` / `image` / `text` / `light` / `sound` / `camera`）时补缺省模型；
  - 资源键过 `__workshopId` 改写：顶层字符串的 `particle` / `sprite` / `image` / `font` / `path`，`sound`（字符串或数组），`effects[].file`，`effects[].passes[].textures[]`。
- **`__workshopId` 改写**：
  - 用的是**当前脚本**的导出 `__workshopId`，模块求值完读一次，只认字符串；
  - 路径在场景查找范围里存在就不改。范围同场景读资源的三处：工程散文件、`scene.pkg` 条目、WPE `assets`（读码推测 WPE 的存在查询也是这三处，没在 WPE 上实测）。宿主每次加载经命令 `wpe_scene_files` 拉一次表（按来源分开，同一份也交给编译的 `SceneFs`，见 [COMPILE.md](COMPILE.md)「编译管线」的场景文件表），三处的键并成一个集合，按 `sceneFileKey`（`compile/fileIndex.ts`：`\` 换成 `/`、去开头的 `/`、ASCII 不分大小写，同 `pkgKey`）查；缓存在后端（`kabegame_core::wpe::scene_files`：assets 一次运行、工程目录 LRU 100，都不失效，目录不存在时不缓存），拉取失败或形状不对是空集（全部改写）。
    - 2026-11-23 之前查的是编译期名单 `bundle.assetPaths`：只扫脚本源码里的资源路径字面量、只查 `assets`，克隆 `getInitialLayerConfig` 得到的路径不在名单里，自带资源被误改成 `…/workshop/<id>/…`（69031「Girl and Cat」的 `playerbarsexception` 报 `model:missing:models/workshop/3200298808/util/solidlayer.json`）；
  - 缺省模型本来就是 WPE 自带资源，补在改写之后、不改；
  - 其余改成 `<第一段>/workshop/<id>/<其余>`（已带 `workshop/<旧 id>` 的先去掉），纹理是 `workshop/<id>/<路径>`。

### 待编对象

- **下标与位置**：新对象的 `objects` 下标从加载时的对象数往后发，只增不复用、跨重编译保留，「清空脚本存储」时清零。新对象追加在对象表尾。
- **名字与父**：名字取配置的 `name`，缺省空串。父按配置的 JSON `parent` id，在当时存在、没待删的对象里找（含之前建的）。
- **编译前**它是「待编对象」：
  - 图层字段（`origin`、`scale`、`visible` 等）按配置取值建在 `SceneState` 上，取值与编译期同一个纯函数（`compile/layerShell.ts`）；
  - 脚本的读写、`sortLayer`、`setParent`、`destroyLayer` 照常，`engine.isObjectValid` 为真（同 WPE 建出即有效；同帧删掉后到删除生效前仍为真，`p6d-frame` 实测）；
  - 按类别装的成员（声音、粒子、对齐、文本、图像层的骨骼方法）看配置的内容键。
- **id**：配置里有非 0 的数字 `id` 照用，否则取「现有最大 id + 1」起第一个没被占的。这个 id 写进结构里的配置原文，编译按它发 `SceneLayer.id`，所以重编译前后 `getLayerByID` 找到的是同一个，也不和已有图层撞号。
- **`getInitialLayerConfig(新对象)`**：返回建出时的配置，同样去掉 `id`、按 jsoncpp 规整。
- **已知差异**：编译期才知道的东西编译前读不到。`size` 的自动尺寸，WPE 当场就是纹理尺寸（`p6d3b-bars` 的 `{4, 4}`），我们是 `{0, 0}`；effect、材质、puppet 骨骼同理。L5 起只在没命中片段缓存、片段到达之前才有这个差异：命中时 `createLayer` 返回前就换成了编好的对象，`init` 读到的是编好的 `size`。

### 新对象上的脚本

- 配置里带的字段脚本，即克隆 `getInitialLayerConfig(T)` 的常见写法，在 `createLayer` 返回之前当场求值、跑完 `init`。顺序是 `before` → 新层各段 `init` → `after`，同 WPE。
- 源码是加载时备好的模块（realm 的 `preparedModule`），同步实例化，每个实例各自一份模块状态。没备过的源码先异步备好、再求值与 `init`，晚一段（语料 0 处）。
- 新条目追加在条目表尾，同一轮 `update` 就跑到它：`p6d3b-clone` 第 60 帧建的 C3 当帧收到第一次 `update`，同 WPE。

### 编译与首帧

- **接进场景**（L5 起，细节见 [COMPILE.md](COMPILE.md)「编译会话与对象片段（活的场景图 L1）」的「运行中建层走片段（L5）」）：
  - 按规整配置查片段缓存，命中就在 `createLayer` 返回前改键接进登记表、状态与 GPU，当帧画出；文本层要等排版，至少晚一帧（已知差异）；
  - 没命中的照上面建壳，会话异步编片段，下一帧开头装上并进缓存，所以同一配置第一次出现时晚几帧，之后命中；
  - `init` 里建的同样走这两条路，首次加载不再二次编译；
  - 带不支持项的新对象不画、其余照常，看板娘提示一次，场景不退回。
- **结构**：`SceneStructure.created` 按建出顺序存 `{ object, config }`，只在还要整场编译时（整场重载、场景级重编译）作编译输入：把它当作 `objects` 在新下标上多出的一项，模型、材质、属性绑定、脚本、关键帧都按新下标登记；数组配置编成分组节点；依赖标记（`dependencies`）只看加载时的对象。同一配置建了又删的记录只留一条（`recordDestroyed`），建删循环下长度不涨。
- **P6d3b 时的做法**（已去掉）：`init` 里建的放弃本次加载、带结构重编，首次加载多编译一次（`3304642534` 多约 0.2 s）；运行中建的请求整场重编译，新对象晚一段才出现。
- **dev 探针**：和宿主共用两条路。探针的回放是同步的，没命中的片段赶不上读回帧（结果的 `liveCreate.pending`）；和 WPE 逐帧比时给 `prewarmFragments`，先空跑一遍把建出的配置编进缓存，第一轮就命中。P6d4 收尾的对照：`p6d-cycle` 8 帧与 WPE 逐像素相同、`p6d-frame` 56 行与 WPE 逐行相同（开不开预跑都相同）。

### 图层 `name` 与 effect 键序

P6d3b 对照时顺带改的两处：

- **图层对象的 `name` 可写**，同 effect 的 `name`：按类型 5 的 `ToString` 取值，`null` / `undefined` 不写；影响之后按名字的查找与 `enumerateLayers`；存在 API 这边，跨重编译保留。依据是 `wpe-clone.log` 里克隆体改名 `C1` / `C2` 之后的结果。
- **effect 对象的自有键序**是 `name`、`visible`（`wpe-asset.log` 的 `fx name write`）。

### 对比结果

**脚本日志**：dev 探针（dt 1/60）的输出和 WPE 日志逐行比：

| 工程 | 结果 |
|---|---|
| `p6d3b-bars` | 24 行中 22 行相同。`bar1 keys` WPE 59、我们 30：图层对象的自有键集合，已编译的图层也是这样，P6d1 起就有。`bar1 size` 是上面的自动尺寸差异 |
| `p6d3b-clone` | 42 行全部相同，包括克隆的配置原文、新层 `init` 的时机与当帧 `update` |
| `p6d-order` | 48 行全部相同 |
| `p6d-asset` | 36 行中 35 行相同。`arg origin` 的键数 WPE 21、我们 24，同上是 P6d1 起的成员差异 |
| `p6d3b-default` | WPE 的 4 行相同。我们多 2 行：透视场景里对数组配置建出的节点取 `getInitialLayerConfig`，WPE 整段 `init` 中止（多半是 jsoncpp 对数组 `removeMember` 出错），语料 0 处，不复刻 |

**画面**：`p6d3b-bars` 跑 30 帧读回 1280×720，和 WPE 抓帧逐像素相同。7 根新条是用户属性的红色（逐实例绑定）、底边对齐、排在 TOP 之前画。

**语料**：`scriptCorpus` 全库与 P6d3a 比：
- 14 张去掉 `script:api:thisScene.createLayer`，解锁 4 张音频条（`3304642534`、`3549863808`、`3570308528`、`3812487163`）。它们都是在 `init` 里建条再 `sortLayer` 排到自己前面，当时首帧前多编一次（L5 起不再多编）；
- 没有新增的键。

**编译产物**：本机全语料 233 张，在 HEAD 与 HEAD + P6d3b 两份源码上各编一次（同一个翻译器 wasm，`ignore/p6/d3/bundlehash.test.ts`）。新字段 `assetPaths` 不计，219 张 bundle 逐字节相同。另外 14 张都是去掉 `createLayer` 缺口键的，差别只在：
- `unsupported`；
- 纹理的 `mips` 与视频时长。编译只在 `unsupported` 为空时解码纹理（`shouldDecode`），改前这些场景一开始就因 `createLayer` 判了退回，所以没有解码。

所以 `layerShellValues` 的抽取没有改变任何编译结果。
