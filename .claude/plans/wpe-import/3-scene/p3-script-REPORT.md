# WPE SceneScript 运行时逆向报告（P3 前置研究，2026-11-02）

对象：WPE 2.8.42 的 `bin\scenescript64.dll`（28,730,352 B，SHA-256 前缀 `58039ef912fcd51c`）与 `wallpaper64.exe`（SHA-256 前缀 `40e2ce02`）。
方法：副本静态分析（REA + Ghidra headless + llvm-objdump）、WPE 官方文档、本机 36 张场景的脚本统计。没有运行或附加 WPE。
DLL 地址以 `0x180000000` 为基址，exe 以 `0x140000000` 为基址。函数名是 Ghidra 自动名。
产物在会话 scratchpad `C:\Users\Lenovo\AppData\Local\Temp\claude\d--Codes-kabegame\4866af0d-85bd-4932-b1f6-a43f6bcc596f\scratchpad\p3-js\`（快照 `db\wallpaper64-2.8.42-p3.rea-snapshot`、反编译 `decomp\`、反汇编与交叉引用 `disasm\`、样本抽取 `pkg-extract\`、统计 `report-agg.txt` / `report-qa.txt`），不入库。

**一句话结论**：
- SceneScript 跑在 **V8 14.7.173.21**（对应 Chrome 147）上，V8 静态链接进 `scenescript64.dll`。
- `wallpaper64.exe` 按需加载它，校验版本串 `"2.8.42.SceneScript"` 后先调 `Init`，再调 `CreateSceneScriptEngine`。
- **每个场景一个 Isolate + 一个 Context**，场景里的所有脚本都是这个 Context 里的 ES 模块，共享全局。
- 引擎在每帧主函数里同步执行，推断在渲染线程上。顺序为：init → 首次 applyUserProperties → 每帧 Tick → update → 渲染。回调返回值同步写回。
- 另有看门狗线程，15 s 超时。

---

## A. 引擎

- **版本**：V8 14.7.173.21。同处还有 `" (candidate)"`、`%d.%d.%d.%d%s%s`、`libv8-…so`，这是 V8 `version.cc` 的特征。
- **语言级别**：等同 Chrome 147。能看到 Iterator helpers、`Float16Array`、`Math.sumPrecise`、`Uint8Array.fromBase64`、`Promise.try`、`Array.fromAsync`、`groupBy`、DisposableStack 等内置；
  `baseclasses.js` 用了类字段 `static X = 0`。
- **Intl / ICU**：没有。实例类型表里没有 `JS_COLLATOR_TYPE` 等 Intl 类型，`zoneinfo64`、`res_index` 都是 0 命中。推断编译时关了 i18n，`Intl` 未定义。推断（强）。
- **WebAssembly**：推断关闭。有 `"WebAssembly support is not enabled"`，没有 wasm-js API 的报错文案。
- **JIT**：宿主不传任何 V8 flag，JIT 层级都编进去了，推断开启。
- **模块**：每段脚本都按 ES 模块处理（`CompileModule` → `InstantiateModule` + 解析回调 → `Evaluate`，要求状态到 kEvaluated），所以等价于强制严格模式。
  `baseclasses.js` 例外，是在全局 Context 里执行的经典脚本。见 `LoadScript` `0x18164bfa0`。
- **证据**：
  - 版本串在 DLL 文件偏移 `0x17eb4c0`；PDB 路径 `D:\dev\we\build\make\x64\scenescript\Release\scenescript64.pdb`；
  - `log.txt` 里是 V8 措辞的报错，如 `Uncaught TypeError: Cannot read properties of null (reading 'play')`。

## B. 宿主结构

- **加载**：`wallpaper64.exe` 的 `FUN_1400c4e80`（应用对象虚表 `0x140485fa8` 第 39 槽）依次做：
  `LoadLibraryExW(L"scenescript64.dll")` → 比对 `GetSceneScriptVersion` → 只在第一次调 `Init` → `CreateSceneScriptEngine(config, int, L"log.txt")`。
  DLL 导出 `CreateSceneScriptEngine` / `GetSceneScriptVersion` / `Init` / `Shutdown`。
- **引擎对象**：大小 0x678，虚表 `0x1819a3f78`，共 28 个方法。主要的槽：

  | 槽 | 作用 |
  |---|---|
  | 3 | 绑定场景（构造 `thisScene`、清终止标志） |
  | 4 / 5 | Enter / Leave（Locker + Isolate::Enter + Context 作用域，可嵌套） |
  | 6 | LoadScript |
  | 7 | Unload |
  | 8 | CallCallback |
  | 9 | Tick(dt) |
  | 10 | 作废缓存的 userProperties |
  | 14 | 取导出回调掩码 |
  | 23 | updateScriptProperties |
  | 27 | 取出并清零累计的脚本耗时 |

- **隔离**：每个引擎自建 ArrayBuffer 分配器、Isolate（`+0x1d8`）、唯一的 Context（`+0x1e0`）。一个场景一个引擎（exe 侧 `R+0x1718` 的 `+0x128`）。
  - 同一场景的全部脚本共享全局对象：`shared`、`class Vec2` 等，以及模块注册表——WEMath 等模块在一个场景里只求值一次，是单例。
  - 多屏、多实例是不同场景，推断各自一个 Isolate。
- **线程**：每帧脚本函数 `FUN_140171440` 由每帧主函数 `FUN_14017fa70` 在 `0x1401802e5` 同步调用，与 D3D 渲染在同一条调用链上，推断就是渲染线程。
  另有看门狗线程 `0x1816476f0`。
- **注入**：
  - `scripts/jsclasses/baseclasses.js` 作为经典脚本执行。顶层的 `class Vec2/Vec3/Vec4/Mat3/Mat4/MediaPlaybackEvent` 与 `const deg2rad` 成为全局词法绑定；
    `this.shared = {}`、`createScriptProperties`、`IModelData`、`_Internal` 成为全局对象的属性。
  - 宿主随后取回 `_Vec2…_Mat4` 原型与 `_Internal.{convertUserProperties, updateScriptProperties, stringifyConfig}`。
- **裸模块名解析**（`0x1816469c0`）：
  1. 名字转小写；
  2. 查缓存；
  3. 未命中时拼成 `"scripts/jsmodules/" + 名字 + ".js"`，经宿主资源读取，再编译、递归 Instantiate。

  所以模块名大小写不敏感，只能导入 jsmodules，脚本之间不能互相 import。

## C. 暴露给脚本的 API

来源：D = DLL 字符串 / 代码，X = wallpaper64 字符串，Doc = 官方文档，S = 样本用法。

- **全局**：`engine`、`input`、`console`、`localStorage`、`thisScene`、`thisLayer`、`thisObject`（宿主装在全局模板上）；
  `shared`、`createScriptProperties`、`IModelData`、`Vec2/3/4`、`Mat3/4`、`MediaPlaybackEvent`（来自 baseclasses.js）。
- **engine**：
  - 属性：`screenResolution`、`canvasSize`、`userProperties`（颜色转成 Vec3）、`timeOfDay`、`frametime`、`runtime`、`AUDIO_RESOLUTION_16/32/64`。
  - 函数：`isRunningInEditor`、`isPortrait`、`isLandscape`、`isMobileDevice`、`isDesktopDevice`、`isWallpaper`、`isScreensaver`、`isObjectValid`、`openUserShortcut`、
    `registerAudioBuffers`（只接受 16 / 32 / 64，返回 `{left, right, average}`）、`registerAsset`、`setTimeout`、`setInterval`、`clearTimeout`、`requestFeatures`（文档里没有）。
- **input**：`cursorWorldPosition`、`cursorScreenPosition`、`cursorLeftDown`。
- **console**：只有 `log`、`error`。样本 3460973721 调的 `console.warn` 在 WPE 里会抛 TypeError。
- **localStorage**：`set` / `get` / `delete` / `clear`，加 `LOCATION_GLOBAL` / `LOCATION_SCREEN`。**没有 `remove`**（3460973721、3554161528 调了）。
  存储文件魔数 `LSKV0001`，exe 侧有 `bin/scenestorage/` 与 `LSBK0001`。
- **thisScene**（`0x1816311d0`）：`getLayer`、`getLayerByID`、`getLayerCount`、`enumerateLayers`、`createLayer`、`destroyLayer`、`sortLayer`、`getLayerIndex`、`getInitialLayerConfig`、
  `get/setCameraTransforms`、`getAnimation`、`createModelData`、`destroyModelData`。`IModelData` 另有 `applyData` 和 `replaceData`（`replaceData` 不能在 update 里调）。
- **图层与对象成员**：由 wallpaper64 反射提供（X），例如：
  - 层级与变换：`getParent/setParent/getChildren`、`getTransformMatrix`、`lookAt`、`getAttachment*`；
  - 材质与 effect：`getMaterial*`、`setMaterialProperty`、`executeMaterialFunction`、`getEffect*`；
  - 纹理与动画：`getTextureAnimation`（`setFrame`）、`getVideoTexture`、动画图层；
  - 骨骼：`Bone*` / `BlendShape*`；
  - 粒子：`emitParticles`；
  - 声音：`play/pause/stop/isPlaying`；
  - 其余属性就是场景 JSON 的属性名。

  `thisLayer.originalOrigin` 在两边二进制里都找不到，推断不是 API。
- **导出回调**按固定表（`0x1819a3ee0`）用位掩码登记，共 19 个：

  | 编号 | 回调 |
  |---|---|
  | 0–3 | `init`、`update`、`resizeScreen`、`destroy` |
  | 4–6 | `applyUserProperties`、`applyGeneralSettings`、`animationEvent` |
  | 7–13 | `cursorHitTest`、`cursorEnter`、`cursorLeave`、`cursorMove`、`cursorClick`、`cursorDown`、`cursorUp` |
  | 14–18 | `mediaStatusChanged`、`mediaPlaybackChanged`、`mediaPropertiesChanged`、`mediaThumbnailChanged`、`mediaTimelineChanged` |

  另外读取导出变量 `scriptProperties` 与 `__workshopId`。
- **scriptProperties**：`createScriptProperties()` 链式调用 `addSlider/Checkbox/Text/Combo/Color`，以 `.finish()` 结束。属性值的覆盖经 `_Internal.updateScriptProperties` 原地改写。
- **作用域限制**（D 中的报错串）：
  - 只能在模块顶层调：`registerAudioBuffers`、`registerAsset`、`requestFeatures`。
  - 在顶层调用或访问会报错：`setTimeout` 等计时器、`isPortrait`、`isLandscape`、`screenResolution`、`canvasSize`、`userProperties`、`timeOfDay`、`frametime`、`runtime`、`input.*`、`localStorage.*`、`thisScene` 的方法。
  - `openUserShortcut` 只能在光标回调里用，每次点击最多一次。

## D. 生命周期与时序

**加载**
1. `CreateSceneScriptEngine`，此时 baseclasses.js 执行。
2. 每个脚本绑定（`FUN_140175880`）：调 LoadScript，**模块立即求值**，所以顶层的 `registerAudioBuffers` 等在这时执行；取回调掩码存到 `+0x40`；状态 `+0x44` 依次为 0 新建、1 待 init、2 init 已跑。
3. 场景构造完：`FUN_140186c90` 调 `FUN_140172830`，对状态 0 或 1 的脚本调 `init(value)`，媒体就绪时补发媒体事件，然后状态置 2。
   前提是场景 `+0x134 == 0` 且标志 `&0xc000000 == 0`，否则推迟。
4. 首次 applyUserProperties：加载函数 `FUN_140113c80` 在 `0x140114f10` 取会话配置里的 `wproperties`，调 `FUN_140181f30`。
   它先处理 `schemecolor`、对齐、`wec_*` 等伪属性，再进 `FUN_1401731d0`，依次：
   1. 改直接的 `{user}` 绑定；
   2. 改 `scriptproperties` 里的 user 绑定；
   3. **只对状态 2 的脚本**调 `applyUserProperties`，参数是 JSON 串经 `_Internal.convertUserProperties` 转成的对象。

   所以对同一个脚本，**init 一定在前**。

**每帧**

`FUN_14017fa70` 先调 `FUN_140171440`（`0x1401802e5`），依次做：
1. 媒体事件 14–17（有变化时）；
2. `animationEvent`；
3. `engine.Tick(dt)`：刷新音频缓冲 16 / 32 / 64，推进并触发计时器；
4. 对导出 update 且状态为 2 的脚本调 `update(value)`。

然后从 `0x14018031a` 起渲染与泛光；`0x140180d0c` 再由 `FUN_1401830a0` 处理排队的属性变化，这时只传变化项。
即脚本在本帧渲染之前同步执行，属性面板的改动下一帧才生效（推断，依据是调用地址的先后）。

**返回值写回**（`0x181620e10`，在 CallCallback 内同步完成）
- 只有 init、update、animationEvent 的返回值写回。
- 转换规则：
  - 数字原样写入；
  - 向量接受 `{x, y[, z, w]}`，或一个数字展开到各分量；
  - 布尔要求 IsBoolean；字符串写成 UTF-8；
  - angles 属性把度转成弧度（×0.017453292）。
- 类型不符或返回 undefined 时不修改（与文档一致）。

**其它**
- `destroy` 在 `FUN_140176f70`，之后卸载。
- `resizeScreen` 在 `0x14017f79b` 附近。

**异常**（`0x181651ab0`）
- 回调抛错：只禁用该脚本的这个回调（掩码 `+0xdc`），按 `"<message> (line L, col C)"` 写 log.txt。
- 模块求值失败：该脚本整段失效。
- 只有看门狗超时才会整场停止。

## E. 运行环境

- **计时器**：只有 `engine.setTimeout` / `setInterval` / `clearTimeout`，没有全局 `setTimeout`。
  - 参数毫秒、存成秒；
  - 在 Tick 里用帧 dt 递减，不是墙钟；在 update 之前触发；
  - 返回值是取消函数；不能在顶层调。
- **没有**：fetch、XHR、WebSocket、DOM。
- **微任务**：推断沿用 V8 默认的 kAuto，每次最外层回调返回时冲刷（没有符号，未确认）。
- **Date / Math.random / eval**：`Date` 走墙钟（bedroom 用 `Date.now()`）；`Math.random` 由 OS 熵播种；`eval` / `Function` 可用（工坊 3286859278 用了 24 次）。
- **看门狗**：执行计数从 0 变 1 时，截止时间设为 now + 15 s（常量 `0x37e11d600` ns，`0x1816477b9`）。
  超时后 `TerminateExecution`、置终止标志 `+0x95`，**整个场景的脚本停止**，日志 `"Script execution has been interrupted because a dead lock was detected."`。
- **内存**：没设 ResourceConstraints，推断使用 V8 默认堆上限。

## F. 本机样本统计（36 张：默认 14 + 工坊 22）

- **规模**：23 张有脚本，共 639 段（去重后 203 段），都在 scene.json 属性上（1 段在材质 json 里），pkg 里没有独立的 .js 文件。
  639 段都能按 ES 模块编译，633 段以 `'use strict'` 开头。
- **导出函数**（壁纸数 / 段数）：

  | 函数 | 壁纸 / 段 | 函数 | 壁纸 / 段 |
  |---|---|---|---|
  | update | 21 / 558 | cursorMove | 11 / 61 |
  | init | 19 / 279 | cursorClick | 10 / 86 |
  | cursorDown | 13 / 71 | cursorEnter / cursorLeave | 8 / 45 |
  | cursorUp | 12 / 69 | 媒体 4 类 | 3–7 张 |
  | applyUserProperties | 12 / 51 | | |

  没有出现：destroy、resizeScreen、applyGeneralSettings、cursorHitTest、animationEvent、mediaStatusChanged。
- **全局使用**（壁纸数 / 次数）：

  | 全局 | 壁纸 / 次 | 全局 | 壁纸 / 次 |
  |---|---|---|---|
  | engine | 20 / 295 | thisObject | 10 / 35 |
  | createScriptProperties | 19 / 377 | console | 8 / 52 |
  | thisLayer | 16 / 154 | shared | 6 / 121（74 个键，含函数值，跨脚本调用） |
  | Vec3 | 14 / 106 | localStorage | 6 / 26 |
  | thisScene | 13 / 34（其中 getLayer 108 次） | input | 4 / 4 |

- **import**：都是 `import * as X from 'WEMath' | 'WEColor' | 'WEVector'`。
- **语言**：没用 async/await、Promise、class、`?.`、BigInt、Intl；少量用 `??`、正则、eval、`RegExp.$1`、改 `Date.prototype`。
- **返回值**：update 535/558 段有返回值，没有返回值的 19 段挂在 `visible` 上、靠副作用起作用；init 有 86 段带返回值。
- **模块顶层调宿主 API**：`engine.registerAudioBuffers` 125 段，另有 `new Vec3`、给 `shared` 赋值、`engine.registerAsset`。
- **razer 两张**：
  - vortex：3 段相同，`applyUserProperties` 里设 `thisObject.colormode = parseInt(userProperties.ui_editor_properties_mode)`，有 `hasOwnProperty` 守卫；
  - bedroom：6 段，update 返回 `WEColor.hsv2rgb({x: Date.now()/2000*speed % 1, y: 1, z: 1})`；`light_speed` 不经过脚本。
- **样本自身的错**：3326873240、3470764447 各有一段伪代码（`scene.getLayer`），WPE 实际报 ReferenceError（log.txt 有记录）。

## G. 对 Kabegame P3 设计的影响（代理建议，待用户定）

| # | 差异 | 风险 | 建议 |
|---|---|---|---|
| 1 | 加载时 init 之后、首帧之前，用完整属性集调一次 applyUserProperties | 高 | 废弃 D10；顺序为：模块求值 → init（写回）→ applyUserProperties(全部) → 首帧；脚本就绪前保持 loading |
| 2 | 一个场景一个 realm：共享全局、`shared`（含函数）、模块单例 | 高 | 一个场景实例一个宿主，不要每段脚本一个；脚本之间在同一 realm 里直接调用 |
| 3 | 同步、同帧：Tick → update → 渲染 | 中 | 维持「等回包再画」，一帧一条批量消息，超出预算就沿用上一帧 |
| 4 | `thisLayer` / `thisObject` 绑定的是当前正在执行的脚本 | 中 | 在全局上用 getter 读当前脚本，不要在每个模块里注入词法常量；计时器触发时取所属脚本 |
| 5 | 只禁用出错的那个回调；看门狗 15 s 后整场停 | 中 | 按回调禁用；死循环必须能中止，倾向在 Worker 里跑、超时 `terminate()` |
| 6 | 计时器按帧 dt 推进、在 update 之前触发 | 中 | 宿主自己实现，不用浏览器计时器 |
| 7 | 应用 CSP 的 `script-src` 没有 `blob:` | 高 | srcdoc 会继承这条 CSP，要实测 `import(blob:)`；不行就用带独立 CSP 的专用宿主页面 |
| 8 | 返回值转换规则 | 中 | 照搬 |
| 9 | API 面：console 只有 log/error，localStorage 没有 remove | 低~中 | 缺的就不提供，抛错照 WPE |
| 10 | WPE 没有 Intl / WebAssembly | 低 | 样本没用到，忽略 |
| 11 | 微任务时机 | 低 | 样本没用 Promise |
| 12 | CEF 补丁 19 给每个子 frame 注入 IPC 桥 | 中 | 宿主必须是不透明源，核对 capability 不匹配它 |
| 13 | 属性变化下一帧生效 | 低 | 只传变化项；`engine.userProperties` 返回合并后的完整集合 |

## 建议用户做的动态实验（需在 WPE 编辑器新建临时测试工程，用完删除）

1. **首次 applyUserProperties 的参数集合**：3 个属性，在 init 和 apply 里各 log 一次。
   预期：先 init，再一次带全部属性的 apply；之后只传变化项。
2. **环境探针**：在 init 里 log `typeof Intl`、`WebAssembly`、`setTimeout`、`globalThis.fetch`、`Object.getOwnPropertyNames(globalThis)`、`eval('1')`。
3. **微任务**：A 的 update 里挂 `Promise.then` 打 log，B 的 update 打 log。kAuto 下 A 的那条在 B 之前。
4. **看门狗**：在 cursorClick 里死循环。预期约 15 s 后出现 dead lock 日志，update 全部停止。
5. **按回调禁用**：cursorClick 抛错一次后不再进入，update 照常。
6. **同帧生效**：update 返回由 `engine.runtime` 驱动的位置，并 log；用 RenderDoc 抓同一帧，变换常量应等于该帧的值。
7. **计时器**：`setTimeout(f, 1000)` 的单位，以及 WPE 暂停时计时器是否随之停。

## 未解决

- 微任务策略（没有符号）。
- `+0x134` 推迟 init 时，首次 apply 会不会漏掉。
- 顶层访问 `thisLayer` 的确切行为。
- 图层反射成员的完整类型表。
- 默认堆上限。
- `TerminateExecution` 的函数身份（按位置推断）。

没有遇到加壳、反分析，也没有可疑的注入内容。

---

## H. 主会话核对（2026-11-02）

| 核对项 | 方法 | 结果 |
|---|---|---|
| 文件身份 | 副本与安装目录 `scenescript64.dll` 的 SHA-256 | 一致（`58039ef912fcd51c…`） |
| 版本与导出 | 字节搜索 | `14.7.173.21` ×2、`2.8.42.SceneScript`、`CreateSceneScriptEngine`、`GetSceneScriptVersion` 均在 |
| 宿主名字表 | 打印 `LOCATION_GLOBAL`、`console` 前后的 C 字符串 | 宿主表依次是 engine 成员、`input` 三项、`set/get/delete/clear`、`LOCATION_GLOBAL/SCREEN`、`localStorage`、`baseclasses.js`、`_Internal` 三个函数、19 个回调名；console 一侧只有 `log`、`error`。DLL 里另一处 `debug/info/warn/…` 是 V8 自带 console 内置的名字表，宿主装的 `console` 不含它们；`remove` 只出现在 V8 内部断言串里。与报告一致 |
| 看门狗 | 搜 15e9 的 8 字节立即数与日志串 | 各 1 处 |
| 模块路径 / WebAssembly / ICU | 字节搜索 | `scripts/jsmodules/`、`scripts/jsclasses/baseclasses.js`、`WebAssembly support is not enabled` 各 1 处；`zoneinfo64` 为 0 |
| 报错格式 | 只读 grep `log.txt` | `Uncaught ReferenceError: scene is not defined (line 2, col 0)` ×2 等，V8 措辞，`(line, col)` 格式 |
| 首次 applyUserProperties | 官方文档 `reference/event/applyUserProperties` | 原文："It will be called once initially when the wallpaper is loaded." / "After the initial wallpaper load event, the parameters will only contain property changes."。文档没写首次是否完整 |
| 首次是否包含未改动的属性 | 推理 | shimmering 的 `glow` 处于默认值（用户没改），抓帧里 bloomstrength 却被脚本改成了 2 × 0.5 = 1.0。所以首次调用**包含用户没改过的属性**，即完整集合。vortex 的脚本有 `hasOwnProperty` 守卫，不能作证据 |
| 应用 CSP | 读 `src-tauri/kabegame/tauri.conf.json` | `script-src 'self' 'unsafe-eval' 'unsafe-inline' 'nonce-kabegame-ejs-bridge'`，确实没有 `blob:`；`frame-src` 有 `blob: data: about: file:` |
| **更正** | 读 `scripts/build-chromium.ts` | 报告说 Kabegame 的 CEF 7827「推断为 Chromium 147」，**不对**：注释写明 CEF_BRANCH 7827 对应 **Chromium 149.0.7827.x**，即 V8 14.9。比 WPE 的 14.7 新两个小版本，语言特性是它的超集，对兼容没有影响 |
