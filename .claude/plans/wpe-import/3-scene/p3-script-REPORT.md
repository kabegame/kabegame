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

---

## I. 用户属性的运行时更新（2026-11-03）

对象与上文相同（`wallpaper64.exe` SHA-256 前缀 `40e2ce02`，`scenescript64.dll` 前缀 `58039ef9`）。
- 先做静态分析（I1–I9）；
- 同日经用户同意，按 I8 的手册做了**动态实验**：在 `-playInWindow` 独立窗口里跑测试工程，用 `-control applyProperties` 改值。现象、日志原文与恢复记录见 **I10**；
- 下文已按实验结果修改置信度，与静态推断不符的地方逐条注明。

**工具标注**（每条证据后括注）：
- **REA**：REA MCP（Ghidra 12.1.4 provider）分析副本 `wallpaper64.exe`，从上一轮快照接着做（反编译、交叉引用、字节检索）。主力。
- **OBJ**：上一轮 llvm-objdump 全量反汇编的文本检索。用于小桩函数、被 Ghidra 截断的函数体、批量抽取反射描述符。
- **GH**：上一轮 Ghidra headless 对 `scenescript64.dll` 的反编译文件（这一轮只读，没有重跑）。
- **TXT**：只读文本扫描。WPE 自带的 `assets/scripts/jsclasses/baseclasses.js`、`bin/wallpaperui.exe` 的 UI 脚本 `ui/dist/scripts/scripts.js`、本机样本 JSON。
- **DOC**：官方 CLI 文档 help.wallpaperengine.io/en/functionality/cli.html。

**置信度**：
- 静态确认：代码逻辑直接读出。
- 推断：有静态依据，但缺一环。
- 实测：I10 的动态实验直接观察到（日志或画面）。

**一句话结论**：
- **运行时与首次加载走同一个函数。** 改值经渲染线程的窗口消息 0x466 进入 `FUN_140115280`，再调 `FUN_140181f30`，即首次加载用的那个。
- **改值就地生效，不会整场重载。** 绑定表按属性名找到「对象 + 反射描述符」，调 setter 写字段，再调该描述符的改值回调。会重建的只有：effect 可见性（重算合成、重建图层）、用户纹理（换纹理）、颜色校正后处理材质（运行中会编译新的着色器变体，实测）。
- **`size` 运行中改了没有效果**（实测）。
- **COMBO 不能绑用户属性**：写成 `{user, value}` 时 jsoncpp 断言，**整个 WPE 进程中止**（实测）。**`hdr` 改了不生效**，要重载。
- **脚本的执行顺序**：直接绑定 → `updateScriptProperties` → `applyUserProperties(增量)`；init 不重跑（实测）。
  - `applyUserProperties` **只收「同时带 `value` 与 `type`」的项**。CLI 改值不带 `type`，所以脚本收到空对象（实测，静态结论已更正）。
- **`engine.userProperties` 是累计全集，但有缺陷**：每次运行时改值，都会把这次增量里没给的 WPE 内置伪属性（`alignment*` / `rate` / `schemecolor` / `wec_*` / `wcc_*`）写成 `null`，它们随即从全集里消失（实测 + 静态解释）。
- **生效时机**：在两帧之间同步处理，下一帧就用上新值（实测：apply 在第 N 帧之后，第 N+1 帧的 update 读到新值）。
- **更正**：上文 D 节说 `FUN_1401830a0` 处理排队的属性变化，**不对**。它是资源热重载队列，见 I6。

### I1. 入口与时机（Q1）

**三条入口，最后都调同一个实例虚函数 +0x80**（静态确认，REA）：

| 来源 | 通道 | 窗口过程 `FUN_140021e50` 的分支 | 载荷 |
|---|---|---|---|
| UI 属性面板（`bin/wallpaperui.exe`，CEF） | 主窗口消息 0x401，载荷 `{命令号, 长度, JSON}`；UI 进程到 exe 之间的传输层未查 | 命令 0x6b | `{file, location, properties: {键: 属性对象}}` |
| `-control applyProperties` | 第二个 `wallpaper64` 进程发 `WM_COPYDATA`（`FUN_140008270`，2000 ms 超时）：`dwData`=0x3f0，数据是 16 字节魔数 `0x27977599 c58b644e 3d427e3b 906b6102` 加 JSON；接收端由 `FUN_14001de80` 校验魔数。**没有主实例时，这个控制进程会自己成为新的 WPE 主实例**，并拉起浏览界面（实测，I10） | 命令 0x3f0 | `-properties` 解析后，每个键包成 `{键: {value: v}}`，**不带 `type`**（实测：脚本收到空对象，见 I4） |
| 整份配置下发 | 0x401 | 命令 2：先存配置，再对每个实例调 `FUN_140042e10` 取配置里保存的整份属性，与实例当前全集（虚函数 +0x90）合并 | 全集 |

- **UI 一次只发一项**（静态确认，TXT）：
  - `callbackWallpaperPropertyChanged` 组成 `{file, location, properties: {[key]: 属性对象}}`，经 `callDeferred("browseWallpaperObject", "applySingleProperty", …)` 发出；
  - 滑块只在值变了时才发。
  - 命令 0x6b 的载荷形状与之完全对应；`applySingleProperty` 映射到 0x6b 是推断。
- **CLI 写法**（DOC）：`-control applyProperties -properties RAW~({"rate":10})~END [-location <名字>] [-monitor <n>]`。`-location` 也可以是 `-playInWindow` 指定的窗口名。

**场景实例 +0x80 = `FUN_14010fd60`**（静态确认，REA）。依次做：
1. 加锁（实例 `+0x3d8`）。
2. `FUN_14010c380`：把新值合并进实例配置的 `wproperties`，并通知插件（`FUN_14011cf10`）。合并函数 `FUN_140109f80` **只更新配置里已有键的 `value`**。
3. 解锁。
4. 对渲染窗口（实例 `+0x1c8`）调 `SendMessageTimeoutW(0x466, wParam=原始 JSON, SMTO_BLOCK, 超时 0)`。

**渲染线程**（静态确认，REA + OBJ）：
- 渲染循环 `FUN_140110630` 在新线程上运行：`0x14010eeb5` 处取入口，`0x14010eeeb` 处调用 `0x1402ca17c`。参数形状与 `_beginthreadex` 一致，入口经跳板 `0x140116d60`，函数身份是推断。
- 它自己创建 `WPELiveWallpaper` 窗口，所以这个窗口属于渲染线程。
- 循环里，每帧函数 `FUN_14017fa70` 前后各有一段 `PeekMessageW` / `DispatchMessageW` 泵。
- 渲染窗口过程 `FUN_140115b90` 的分支：0x465 = 加载（`FUN_140113c80`），**0x466 = 应用属性**（`FUN_140115280`），0x40e = 设置插件列表。

**`FUN_140115280` 依次**（静态确认，REA）：
1. 宿主级键：`rate`（÷100，下限 0.1，写实例 `+0x190`）、`volume`（÷100 × 主音量，`FUN_1401816d0`）、`audioprocessing`（开关音频采集位 `+0x1b8` bit3，关闭时清零三块频谱缓冲）。
2. `FUN_140181f30(渲染器, JSON)`，**首次加载在 `0x140114f10` 调的就是它**。
3. `cameraparallax` → `FUN_140115a90` 置 / 清 0x200。

**`FUN_140181f30` 的尾部**（静态确认，REA + OBJ `0x140182eef`–`0x140182f5e`）：
- 渲染器 `+0x1750` ← 本次 JSON（下称**增量**）；
- `+0x1728` ← 合并(`+0x1728`, 增量)（`FUN_140017fb0`；下称**累计全集**）。
  - 合并是**浅合并**：先整份拷贝累计全集（`0x140017fe2` 处拷的是第二个参数），再用增量的每个键**整项覆盖**同名项（静态确认，REA 汇编）。
  - 所以 CLI 改过的键会丢掉 `type`、`text` 等字段（实测：`p_color` 改后在全集里变成字符串）。
  - **缺陷**：`FUN_140115280` / `FUN_140181f30` 用 jsoncpp 的**非 const `operator[]`**（`FUN_140086de0`）读 `rate` / `volume` / `audioprocessing` / `cameraparallax` / `alignment*` / `schemecolor` / `wec_*` / `wcc_*`。增量里没有这些键时会被插成 `null`，随后覆盖进累计全集（静态解释）。实测见 I4。
- 尾调用 `FUN_1401731d0(+0x1718)`。
- 偏移对照：`P = 渲染器+0x1718` 是绑定管理器，`P+0x10` = 累计全集，`P+0x38` = 增量，`P+0x128` = 脚本引擎；场景对象 `S = 渲染器+0x10`，所以累计全集也是 `S+0x1718`。

**首次加载**（静态确认，REA）：
- `FUN_140113c80` 先把配置里的 `wproperties` 写进累计全集，**然后**才构造场景，所以解析期读到的 `usertextures` / `usershadervalues` 初值就是用户当前值；
- 场景构造完，再以全集为增量调一次 `FUN_140181f30`。

**第几帧生效**：
- 0x466 在渲染线程的帧间消息泵里同步处理。绑定写值、改值回调、`updateScriptProperties`、`applyUserProperties` 都在这次处理里完成（静态确认）。
- 下一帧照常 Tick → update → 渲染，所以改动在**下一帧**画出来。
  - **实测**：`p_slider=9` 时，`applyUserProperties` 在 frame=4549 执行，此时 `scriptProperties.speed` 已经是 9；下一次 update 是 frame=4550，读到 9。
  - 首次加载同样如此：init（frame=0）→ apply（frame=0）→ 第一次 update（frame=1）。
- 例外：泛光参数靠脏位，下一帧开头才重算，同样在下一帧可见（I3）。
- `SendMessageTimeoutW` 超时为 0、带 SMTO_BLOCK。发送方随后立即释放 JSON，因此推断它在接收方处理完之前不会返回。实验中十余次改值都正确生效，没有出现内存错误的迹象，但这只是间接旁证。

### I2. 会不会整场重载（Q2）

- **不会。** 属性路径（`FUN_140115280` → `FUN_140181f30` → `FUN_1401731d0`）里没有调用壁纸加载 `FUN_14010df40` 或渲染器重建 `FUN_140113be0`（静态确认，REA）。
- 整场重载只在打开壁纸或改画质设置时发生（`FUN_14010df40`）。HDR 相关位只在加载时重算（p2 G2）。
- **局部重建只有下面几类**（静态确认，REA / OBJ）：
  - effect `visible`：改值回调 `FUN_1401e6300` 重算合成次数与 pass 数。数值变了才调图层虚函数 +0x110（`FUN_1402065e0`），重算尺寸、几何、合成 RT 与 passthrough 材质。**这回答了 p2 B11 / I5 留下的「谁调 `FUN_1401e6300`」。**
  - `usertextures`：纹理槽名字变了，把材质记入场景的待刷新集合（`S+0x1678`），之后换该槽纹理。「之后」在哪里消费，没追，推断。
  - `wec_*` / `wcc_*`：每次应用都重新取后处理材质 `materials/util/ccsimple.json`（COMBO `COL` / `LUT`），见 I5。
    - **实测**：`wec_e=true` 那次 apply（19:13:21Z）的同一秒，工程目录的着色器缓存 `shaders/blobsSM40/` 新增了一个变体（`8434196b….dxs`），即运行中编译了新着色器。
  - 文本：`text` / `font` / `pointsize` 等触发重排（`LAB_140256ad0` → `FUN_140256f20`）。
- **材质常量不重编着色器**，只标脏、重传常量缓冲（I3）。
  - **实测**：改 tint 常量、切 effect 可见、改颜色 / 透明度 / 位置的几次 apply，都没有产生新的着色器缓存文件。
- **实测没有出现整场重载**：每次改值后脚本的帧计数连续，没有新的 init 日志。

### I3. 逐类绑定（Q3）

**机制**（静态确认，REA；调用约定由 OBJ `0x14017337b`–`0x1401733fa` 确认）：
- **反射描述符**：每个可绑定属性一个，注册在类表里。静态注册用 `FUN_14015a000`，运行时动态注册用 `FUN_14015ac40`。两者新建条目时 `+0x30..+0x58` 全部清零。
  - 字段：`+0x30` 类型，`+0x34` 字段偏移，`+0x38` JSON setter，`+0x40..+0x50` 其它存取器，**`+0x58` 改值回调（没设就是空）**。
- **加载期**：`FUN_1401730d0(P, 对象, JSON)` 逐键找描述符（跳过只读位 `+0x60 & 2`），调 setter，并开启「解析绑定」标志。
  - setter 写字段后，属性值是对象时交给 `FUN_1401a4db0` 登记绑定。
  - `user` 为字符串，或为 `{name, condition, type}` 时，建用户绑定（虚表 `0x14048b700`；`+8` 目标对象，`+0x10` 描述符，`+0x20` 名字，`+0x40` 条件）；
  - `animation` 建动画绑定（`0x14048df78`）；`script` + `scriptproperties` 建脚本绑定（`0x14048edf8`）；
  - 都经 `FUN_140175880` 挂到 P 的「属性名 → 绑定列表」哈希表（`P+0xa0` / `+0xb0` / `+0xc8`）。
- **运行时**：`FUN_1401731d0` 按增量里的每个键查表，对每个绑定调 `描述符->setter(&{P, 目标, 不解析}, 描述符, 值)`。
  - 有 `condition` 时，值换成「新值字符串 == condition」的布尔。
  - setter 只写字段，再调 `+0x58` 回调。
  - **加载与运行用同一个 setter。** 不比较新旧值，同值重发也会再执行一遍。

| 绑定目标 | 描述符（类表 / 偏移 / setter） | 改值回调 | 运行时效果 | 置信度 |
|---|---|---|---|---|
| `origin` / `scale` | 基础对象 `0x1404e8250` / `0x128`、`0x134` / `FUN_1401a4230`（vec3，数字会铺满三个分量） | `LAB_1401e0520`：对象 `+0xd0` 清零（变换缓存作废） | 就地 | 静态确认；`origin` **实测**（A 立即下移）；数字铺满三个分量也实测到（首轮把滑块数字绑到 `size` 上，得到正方形） |
| `angles` | 同上 / `0x140` / `FUN_1401df2f0` → `FUN_1401dd630`（描述符 `+0x60 \|= 4`，推断该位表示脚本侧的度↔弧度换算） | 无 | 就地；setter 自己写旋转 | setter 静态确认；矩阵更新与标志位含义为推断 |
| `parallaxDepth`、`sortorder` | `0x170`、`0x124` | 无 | 只改字段 | 静态确认 |
| 图像层 `color` / `alpha` / `brightness` | 图像层 `0x1404e8360` / `0x330`、`0x33c`、`0x340` | 无 | 绘制时读（p2 B10），下一帧可见 | 回调静态确认；`color` / `alpha` **实测**即时生效 |
| 图像层 `size` | `0x2f0` / `FUN_1401a3fc0` | 无 | 只改字段，**不触发** `FUN_1402065e0`，几何不重建 | **实测：运行中改 `size` 画面无变化**（300×300 → 120×120 后仍是 300×300）；只有重载才生效 |
| 图层 `visible`，含 `{user: {name, condition}}` | `+0x120` bit0 / `FUN_1401e1a90` | 0 | 渲染循环逐帧检查 | 静态确认；条件可见**实测**（`p_mode` 改成 `a` 图层消失，改回 `b` 复现） |
| `perspective`、`castshadow`、`copybackground`、`nointerpolation`、`clampuvs`、`ledsource` | `+0x120` / `+0x304` 各位 | 0 | 只改位 | 静态确认 |
| effect `visible` | effect `0x1404e83e0` / `+0x118` bit0 / `FUN_1401e1a90` | **`FUN_1401e6300`** | 立即重算；合成次数变了就重建图层（I2） | 静态确认；**实测**：关掉后图层立即变回白色底，打开立即恢复绿色 tint，画面无异常（没有用 RenderDoc 看 pass 数） |
| `constantshadervalues` 的 `{user}` | 材质解析末尾按着色器常量表**动态建描述符**：名字 = 材质常量名，偏移 = `0x120 + 4×槽位`，类型 1–4 对应 float / vec2 / vec3 / vec4 setter（`FUN_1401a4b00` / `FUN_1401a3fc0` / `FUN_1401a4230` / `FUN_1401a4580`）；再 `FUN_1401730d0` 套用 `constantshadervalues` | `0x1401538c0`：材质 `+0x1f8 \|= 3` | 就地改值、标脏重传，不重编 | 静态确认（OBJ：`0x1401553cb`–`0x1401555d5`，Ghidra 的函数体在 `0x1401553a8` 被截断）；**实测**：tint `color` 改洋红后立即生效，没有新着色器变体 |
| `usershadervalues` | 解析时改写成 `constantshadervalues[常量] = {value: 累计全集里的当前值, user: 属性名}`，之后同上 | 同上 | 同上 | 静态确认（`FUN_140154480`） |
| **COMBO** | 材质 `combos` 逐键转大写后按**整数**读（`FUN_140085ee0`，即 jsoncpp `Value::asInt`），没有 `user` / `value` 分支；effect 实例的 `combos` 只在加载时用于 fbo / pass 的 `conditions` | — | **不能绑**。写成 `{user, value}` 时，**整个 WPE 进程中止**，不只是这张壁纸失败 | **实测**：窗口全黑；随后弹出 VC++ 运行库断言框「`File: D:\dev\we\windows\src\json\src\json_value.cpp Line: 719 Expression: false && oss.str().c_str()`」，点中止后进程退出。同一工程只把 COMBO 改回整数 30 就正常渲染。二进制里唯一以行号 719（0x2cf）调用断言的是 `FUN_140085ee0` 的 `0x140085f4d`（REA 字节检索）。本机 26 张样本 0 处这么写 |
| 纹理 `usertextures` | 材质解析为每个纹理槽建描述符：类型 5，偏移 = 槽号，setter `FUN_1401538d0`。项为字符串时是用户属性名；为 `{name, type: "system"\|"usershortcut", keepaspect}` 时含系统伪属性 | setter：名字变了才写，并把材质加入 `S+0x1678` 待刷新集合 | 换该槽纹理，延后执行 | setter 静态确认；消费点推断 |
| general `bloom` | 场景 `0x1404e81c0` / `+0xe0` bit1 / `FUN_14019b4e0` | 0 | **每帧读**（`FUN_14017fa70`：`R.flags&0x40` 且 bloom 位且有对象），下一帧开 / 关泛光 | 静态确认；本机 WPE 画质设置 `postprocessing="disabled"`（按约定不改），实验中看不到泛光，**未实测** |
| general `hdr` | `+0xe0` bit10 / `FUN_14019b6f0` | 0 | **运行中改不生效**：HDR 渲染位 0x2000 与交换链格式只在加载时判定（p2 G2） | 静态确认 |
| `bloomstrength`、`bloomthreshold`、`bloomhdr*`（含 iterations、tint） | `0x3bc`–`0x3d8` | `LAB_1401863e0`：`+0xe0 \|= 0x80000000` | 下一帧开头 `FUN_140184020` 重算泛光参数后清位 | 静态确认 |
| `clearcolor`；`clearenabled`、`camerafade`、`transparentsorting`、`customsortorder`、`camerashake`、`cameraparallax` 等标志；相机 `fov`、`zoom`、`nearz` 等 | `0x35c`；`+0xe0` 各位；`0x140`… | 无或 0 | 只改字段；逐帧读（推断） | 回调静态确认 |
| `ambientcolor`、`skylightcolor` | `0x368`、`0x374` | `LAB_1401863f0`：拷到渲染上下文（`+0x1298` 起） | 即时 | 静态确认 |
| `fog*` | `0x380`–`0x3b4` 与 `+0xe0` 位 | `FUN_140186440` | 即时 | 静态确认 |
| 粒子 `instanceoverride` 的 `alpha` / `size` / `count` / `speed` / `lifetime` / `brightness` / `colorn` / `controlpoint*` | `0x1404e8860` / `0xc8`… | `LAB_14022ab30`：`+0x1b0 = 1`（脏） | 下次更新时重算（推断）；`rate` 无回调 | 回调静态确认 |
| 文本层 `text`、`font`、`pointsize`、`padding`、`maxwidth`、`anchor`、对齐、`outline` / `dropshadow` 开关等 | `0x1404e88e0` | `LAB_140256ad0` → `FUN_140256f20` | 重排文字 | 静态确认 |
| 文本层描边 / 阴影的颜色与尺寸、`backgroundcolor` | 同上 | 无 | 只改字段 | 静态确认 |
| 声音层 `volume` | `0x1404e8560` / `0x2f0` | `FUN_1401f4c20` | 即时设音量（推断） | 回调静态确认 |
| 声音层 `mintime` / `maxtime` / `attenuation` | 同上 | 无 | 只改字段 | 静态确认 |
| 灯光、模型、人偶动画层 | 见描述符清单 | 灯光 `light` / `castshadow` / `usecookie` 为 `FUN_14025c610`，其余多为无或 0 | — | 静态确认 |

- **完整描述符清单**（类表、名字、偏移、setter、回调）：`notes\descriptors-decomp.txt`（REA 反编译抽取）与 `notes\descriptors.txt`（OBJ 抽取，寄存器跟踪有误差，以前者为准）。
- **本机绑定分布**（TXT，26 张场景、887 个 JSON，`notes\binding-scan.txt`）：
  - 最多的几类：`scriptproperties` 364、`constantshadervalues` 222、图层 `visible` 347（其中带 condition 163）、`color` 141、文本 `pointsize` 102、effect `visible` 107、`alpha` 88、`scale` 27、`text` 25、声音 `volume` 24、`instanceoverride` 34；
  - `general` 只有 `bloom` / `bloomhdrstrength` / `cameraparallax*` 等十几处；
  - **COMBO 写成对象：0 处**；`usertextures` 出现在 5 张工坊壁纸里，多为 `$mediaThumbnail` 一类的系统项。

### I4. 脚本侧（Q4）

**`FUN_1401731d0` 内的顺序**（静态确认，REA + OBJ）：
1. 直接绑定：按增量的键依次写值。
2. 有引擎时，调槽 10（`0x1401734a3`，`call [rax+0x50]`），作废缓存的 `userProperties`。
3. 遍历脚本列表（`P+0xd8`），只处理状态 2（init 已跑）的脚本：
   1. 用脚本自己的「属性名 → scriptProperties 键」表（`FUN_140174dc0` 解析时登记，支持 `condition`），组装 `{键: 值或布尔}`；
   2. 有命中才 Enter（槽 4，只进一次），再调槽 23 `updateScriptProperties`；
   3. 脚本导出了 `applyUserProperties`（回调掩码位 4 = 0x10）时，用增量组装 `{名: {value, type}}`。**只收同时带 `value` 和 `type` 的项**；`usershortcut` 额外带 `isbound` / `commandtype` / `file`。这个 JSON **只序列化一次**，供所有脚本共用。然后经槽 8 `CallCallback(回调 4)` 调用（`0x1401742e2`）。即使组装结果为空也照样调用。
      > **更正**：上一版把条件写成「带 `value` 就放进去」。反编译里两个条件是并列的（`FUN_140087490(…,"value")` 与 `FUN_140087490(…,"type")` 都要非空），实测也证实：CLI 改值时脚本收到 `{}`。
4. Leave（槽 5，`0x140174357`）。
5. 调用挂在 `P+0x150` 的「属性已应用」监听器。目前只看到纹理侧 `FUN_1400ec220` 往里登记。

**各项结论**：

| 问题 | 结论 | 置信度 |
|---|---|---|
| 运行中的参数是否只含变化项 | **取决于来源**：UI 面板每次一项；整份配置下发（命令 2）为全集；首次加载为全集。**CLI 改值时参数是空对象 `{}`**，因为没有 `type`。exe 不做去重，同值重发也会再调一次 | 来源静态确认；UI 只发一项来自 TXT；首次全集与 CLI 为 `{}` **实测** |
| 参数形状 | `_Internal.convertUserProperties` **按 `type` 转换**：`color` → `new Vec3(value)`，`usershortcut` → `{isbound, commandtype, file}`，其余取 `value` | 转换规则静态确认（TXT `baseclasses.js` 1401–1418 行）；首次 apply 里颜色为 `Vec3`、文本为字符串、滑块为数字、开关为布尔，**实测** |
| 首次 apply 包含哪些键 | 工程声明的全部属性，**外加 WPE 注入的 14 个内置项**：`alignment`、`alignmentfliph`、`alignmentposition`、`alignmentx/y/z`、`rate`、`wcc_amt`、`wcc_v`、`wec_brs`、`wec_con`、`wec_e`、`wec_hue`、`wec_sa`。本例共 25 个：10 个 `p_*`、本工程声明的 `schemecolor`、14 个内置项，值都是默认（如 `rate=100`、`wec_*=50`）。工程不声明 `schemecolor` 时是否也会注入，本实验没有验证 | **实测** |
| init 会不会重跑、脚本状态是否保留 | **不会重跑，状态保留**：属性路径只调 `updateScriptProperties` 与 `applyUserProperties`，不卸载、不重载脚本 | 静态确认；**实测**（十余次改值后 `init#` 与 `initOnly#` 计数仍为 1，帧计数连续） |
| `engine.userProperties` 返回什么 | **累计全集**。DLL 取值器 `FUN_181657410`（GH）在缓存 `引擎+0x390` 为空时，调宿主接口 `+0x98`，即 exe 的 `FUN_14018dc70`（REA）。它遍历 `S+0x1718`，输出带 `value` 的项为 `{名: {value, type}}`，再经 `convertUserProperties` 转换后缓存。槽 10（`FUN_181650610`）只把缓存清空，下次访问时重建。合并发生在调用 `FUN_1401731d0` 之前，所以 `applyUserProperties` 里读到的已经是新值 | 静态确认；**实测**（apply 里读到 `p_alpha=0.3` 新值） |
| **全集的缺陷** | 每次运行时改值，增量里没给的 WPE 内置伪属性会被插成 `null`（I1），整项覆盖进全集；`FUN_14018dc70` 跳过没有 `value` 的项，于是它们从 `engine.userProperties` 里消失。例如首次 25 个键，CLI 改一次 `p_alpha` 后只剩 10 个 `p_*`（`schemecolor` 也没了）。这次增量里带了的伪属性会保留，下一次没带又消失。CLI 改过的键整项被 `{value}` 覆盖、丢掉 `type`，所以颜色在全集里变成字符串 | **实测** + 静态解释 |
| `scriptproperties` 的 user 绑定何时更新 | 同一次处理里、**在 `applyUserProperties` 之前**调 `updateScriptProperties`。JS 侧只改 `scriptProperties` 里已有的键，原值是 `Vec3` 时重建 `Vec3`。它不看 `type`，所以 CLI 改值也能更新 | 静态确认（TXT 1389–1400 行）；**实测**（apply 时 `speedNow=9`） |
| 直接绑定与脚本的先后 | 直接绑定 → `updateScriptProperties` → `applyUserProperties` → 监听器；下一帧才 Tick / update | 静态确认；后两段与「下一帧」**实测** |
| `{script}` 绑定的属性，依赖的属性被改后值从哪来 | 脚本的 `scriptProperties` 已就地更新，下一帧 `update` 的返回值写回该属性（D 节）。脚本**没有 update** 时不会重算，init 也不重跑。属性若同时带 `user` 与 `script`，本次先由直接绑定写值，下一帧被 `update` 覆盖 | 前半**实测**（C 的透明度由 0.5 变 0.9）；无 update 时为推断 |
| 日志 | 壁纸模式下 `console.log` **不写** `log.txt`；`console.error` 写入，格式为 `Error: <文本>` | **实测** |
| 系统伪属性 | 每帧脚本函数 `FUN_140171440` 在媒体缩略图变化时，把 `$mediaThumbnail` / `$mediaPreviousThumbnail` 作为单键增量走同一路径（OBJ `0x140171a8d`）。`usertextures` 的 `type:"system"` 绑在它们上面；推断也会出现在 `applyUserProperties` 的参数里 | 路径静态确认；进入 apply 参数为推断 |

### I5. 伪属性（Q5）

都在 `FUN_140181f30` 或 `FUN_140115280` 中处理，每次应用都执行（静态确认，REA；字段用途靠 OBJ 检索读取点）。

| 键 | 写到哪里 | 作用 |
|---|---|---|
| `rate` | 实例 `+0x190`（÷100，下限 0.1） | 播放速率 |
| `volume` | 实例 `+0x178`，`FUN_1401816d0` | 音量 |
| `audioprocessing` | 实例 `+0x1b8` bit3 | 音频频谱开关 |
| `cameraparallax` | `FUN_140115a90` | 视差开关 |
| `alignment` | 渲染器 `+0x124`（整数） | 对齐模式 |
| `alignmentposition` / `alignmentx` / `alignmenty` / `alignmentz` | 渲染器 `+0x31c8` / `+0x31bc` / `+0x31c0` / `+0x31c4`（×0.01） | 对齐位置；`FUN_140183xxx`（`0x140183ac8`）按屏幕尺寸逐帧计算布局，推断 |
| `alignmentfliph` | 渲染标志 `+0x128` 的 0x800 | 翻转（p2 把该位记为投影翻转） |
| `schemecolor` | 渲染器 `+0x31b0..+0x31b8`（`"r g b"`） | 对齐模式非默认（`+0x124 & ~2 ≠ 0`）时，代替 `general.clearcolor` 作清屏色（`0x14017fc4c`）。**实测**：`alignment=1` + `schemecolor="1 0 0"` 后背景整片变红，改回 `alignment=0` 恢复。也作为普通用户属性给脚本用 |
| `wec_e` | `+0x3110` | WPE 颜色校正开关 |
| `wec_con` | `+0x3114`（÷50） | 对比度 |
| `wec_brs` | `+0x3118`（÷50） | 亮度 |
| `wec_sa` | `+0x311c`（÷50） | 饱和度 |
| `wec_hue` | `+0x3120`（÷100 − 0.5） | 色相 |
| `wcc_v` | `+0x3128` | LUT 纹理路径 |
| `wcc_amt` | `+0x3148`（÷100） | LUT 强度 |

**颜色校正的实现**：
- 开启且不是恒等变换时（或有 LUT 且强度 > 0 时），取材质 `materials/util/ccsimple.json`，COMBO `COL=1` / `LUT=0|1`；
- 设 `params` = (f(brs, 2), f(con, 0.5), f(sa, 0.5), hue)，`FUN_14041e350` 推断为 pow；有 LUT 时换纹理、设 `lutparams`；
- 存到 `+0x3188`，每帧在场景之后画一遍全屏（`0x140180bd2`）。
- **实测**：CLI 发 `{"wec_e":true,"wec_brs":80,"wec_sa":0}` 后整画面变亮、去饱和；同一秒编译出一个新着色器变体；发 `{"wec_e":false}` 后恢复。

这些都是 WPE 的壁纸级设置，不在 `scene.json` 里。
- 用户在 WPE 里改过的值存在 `config.json` 的 `wproperties[文件][显示器]` 下，存的是裸值。例如本机工坊 3351163962 存了 `{"schemecolor": …, "volume": 24, "wcc_amt": 42, "wcc_v": "lutx32_bluenavy"}`（TXT，只读）。

### I6. 其它相关行为（Q6）

- **更正 D 节**：`FUN_1401830a0`（每帧 `0x140180d0c` 调用）处理的是 0x50 字节条目的**资源热重载队列**，条目里带外部进程句柄。
  - 等进程退出，且退出码为 0 或大于 0x18 时：类型 0 按名字重载资源；类型 1 对 `image` / `model` 路径匹配的图层调虚函数 +0x40 重载，重算场景标志，再跑一次 `FUN_1401731d0`。
  - 推断是编辑器或资源编译器联动，与属性面板无关（静态确认，REA）。
- **更正 p2 B11**：`FUN_1401a38f0` 不是「通用属性系统」，是给对象分配 `id`。effect `visible` 的运行时重算由描述符回调 `FUN_1401e6300` 触发，已确认（I3）。
- **实例配置只合并已有键**：`FUN_140109f80` 的规则会影响持久化。但渲染线程收到的是原始 JSON，所以 CLI 发工程没声明的键（如 `wec_e`）仍会生效（**实测**）。
- **运行中的 WPE 进程管理**（实测）：
  - WPE 没有退出类 `-control` 命令（二进制命令表与官方文档一致，共 14 个公开命令，另有未公开的 `revealWallpaper` / `aws`）；
  - `getWallpaper` 的结果写到 `CONOUT$`，重定向抓不到；
  - 主实例不在时，任何 `-control` 调用都会自己成为新的主实例；
  - effect 的材质、着色器要放在工程目录里（编辑器会把依赖拷进工程），只放在 `assets/effects/<名>/` 下会报 `Failed opening: materials/effects/tint.json`。
- **插件属性**：渲染窗口 0x40e（`FUN_14010b900`）把插件提供的属性存到 `initalwproperties`，补进 `wproperties` 缺失的键。属性变化时 `FUN_14011cf10` 通知插件。加载前 `FUN_14010df40` 也合并一次。
- **应用顺序**：增量是 jsoncpp 的对象，推断按键名字典序遍历，所以同一批改动里绑定的执行顺序是键名序。
- **场景未加载时**：`FUN_140115280` 仍会执行；`FUN_14010fd60` 只在渲染窗口存在时发 0x466，否则只改实例配置，下次加载时生效（静态确认）。

### I7. 对 Kabegame P3 的影响（代理建议，待用户定）

| # | WPE 行为 | 风险 | 建议 |
|---|---|---|---|
| 1 | 运行时与首次加载用同一个应用函数；先把增量合并进累计全集，再应用增量 | 高 | 宿主只保留一个 `applyUserProperties(delta)`：加载时传全集，运行时传增量；累计全集是唯一事实来源，供 `engine.userProperties` 与解析期初值使用 |
| 2 | 绑定表 = 属性名 → [目标, 描述符, condition]；运行时只写字段再调回调；不比较新旧值 | 高 | bundle 绑定表照这个形状做。回调分几类：无（逐帧读）、变换脏、effect 重算渲染图、材质常量脏、泛光参数脏、文本重排、粒子脏、纹理替换 |
| 3 | 会重建的只有 effect 可见性（重算合成）、纹理、颜色校正材质；常量不重编 | 高 | 只有 effect `visible` 需要重算渲染图（P2a 的合成 RT 数与最后启用 effect）；常量直接改 uniform；`usertextures` 换纹理 |
| 4 | COMBO 不能绑用户属性（WPE 遇到会断言中止整个进程）；`hdr` 运行中改不生效；`size` 运行中改无效 | 中 | COMBO 写成对象时按「不支持」报 unsupported、退回预览图（WPE 自己也跑不了）；`hdr` 变化走现有的 setting-change 重载；`size` 绑定只在加载时取值即可，与 WPE 一致 |
| 5 | `bloom` 每帧读，参数改了下一帧重算 | 中 | P2b 的泛光开关与参数改为运行时可变，不重建；只有 HDR 格式切换才重建 |
| 6 | 脚本顺序：直接绑定 → `updateScriptProperties` → `applyUserProperties(增量)`，再下一帧 update；init 不重跑 | 高 | 宿主每次应用按这个顺序一次性发给脚本 realm，不重建脚本；同一批里 `scriptProperties` 先于 apply 更新 |
| 7 | `engine.userProperties` 返回全集，每次应用后惰性重建；但 WPE 会把增量里没给的内置伪属性写成 `null`，使它们从全集里消失 | 中 | 宿主维护全集；每次 apply 后作废缓存，下次访问时重建。**不复刻**伪属性丢失的缺陷：样本脚本若依赖 `engine.userProperties.schemecolor` 之类，WPE 自己在改值后也会读到 `undefined`，建议我们保持完整。是否复刻待用户定 |
| 8 | 参数转换依赖 `type`（颜色转 `Vec3`）；没有 `type` 的项不进 `applyUserProperties` | 中 | 宿主发给脚本的增量必须带 `type`。Phase 7 的属性拉取已有定义，转换照 `convertUserProperties` 实现；全集里的项也保留 `type`，不学 WPE 的整项覆盖 |
| 9 | 改值在两帧之间同步处理，下一帧画出 | 低 | 属性消息在 rAF 之间处理完，再画下一帧 |
| 10 | 一次只发一项；整份配置下发才是全集 | 低 | 属性面板逐项发；切预设或恢复默认时可以发全集 |
| 11 | 伪属性（`rate` / `alignment*` / `schemecolor` / `wec_*` / `wcc_*`） | 低 | `schemecolor` 当普通属性给脚本；对齐与颜色校正属于 WPE 壁纸级功能，暂不实现，需要时另议 |
| 12 | 媒体缩略图走用户属性通路（`$mediaThumbnail`） | 低 | W5 做媒体集成时沿用同一条通路，`usertextures` 的 system 项绑它 |

### I8. 仍未解决与动态实验

**未解决**（动态实验后更新）：
- UI 进程（`wallpaperui.exe`）到 exe 的传输层，以及 `applySingleProperty` 是否就是命令 0x6b。
  - UI 路径的行为已由第 6 步实测（见 I10 末「第 6 步结果」）；传输层本身仍未查。
- `SendMessageTimeoutW(超时 0, SMTO_BLOCK)` 是否等到渲染线程处理完才返回。实验只有间接旁证（十余次改值都正确生效）。
- `S+0x1678` 待刷新纹理集合的消费点；`usertextures` 没测。
- `FUN_1401dd630`（angles）与 `FUN_1401f4c20`（音量）的内部细节；声音、文本、粒子绑定没测。
- `bloom` / 泛光参数的运行时效果：本机 WPE 后处理设置是关闭档，没有测。
- 伪属性 `$media*` 是否出现在 `applyUserProperties` 参数里。
- 工程不声明 `schemecolor` 时，WPE 是否也会注入它。
- **已解决**：
  - 合并函数是**浅合并、整项覆盖**（REA 汇编 + 实测）；
  - `size` 运行中改**无效**（实测）；
  - COMBO 写成对象会**断言中止整个进程**（实测）。

**实验**（已于 2026-11-03 执行，结果见 I10）：
- 目录：`C:\Users\Lenovo\AppData\Local\Temp\claude\d--Codes-kabegame\96b81c04-c7d5-43ca-8339-57185be782bd\scratchpad\dyn-test\`。
- 内容：
  - 生成脚本 `gen_projects.py`；
  - 常规工程 `kbprops-test`：四个纯色图层，覆盖颜色 / 透明度 / 条件可见 / 位置 / 尺寸绑定、tint effect 的可见性与常量、脚本属性、只有 init 的脚本、泛光；
  - COMBO 风险工程 `kbprops-combo`；
  - 执行手册 `RUNBOOK.txt`：全部用 `-playInWindow` 在独立窗口跑，不接管桌面；含命令、预期、判读与恢复步骤。
- 脚本把帧号、apply 参数、全集与 `scriptProperties` 打到 `log.txt`。实测发现 `console.log` 不写文件，已改成 `console.error`。

### I9. 产物

全部在会话 scratchpad `C:\Users\Lenovo\AppData\Local\Temp\claude\d--Codes-kabegame\96b81c04-c7d5-43ca-8339-57185be782bd\scratchpad\`，不入库：
- REA 快照 `db\wallpaper64-2.8.42-p3-userprops.rea-snapshot`：在上一轮快照基础上，含本轮 52 个工作流条目；
- REA 证据包 `db\evidence-p3-userprops.json`：122 条记录；
- 反编译 `decomp\`（REA 批量反编译拆分）；
- 描述符清单与样本统计 `notes\`；
- 脚本 `scripts\`；
- UI 脚本片段 `untrusted\`（不可信数据）；
- 动态实验 `dyn-test\`：
  - 工程与生成脚本；
  - 截图 `shots\`；
  - 本次新增的 `log.txt` 全文 `log-run-full.txt`；
  - 开工前备份 `backup\`（`config.json`、`log-before.txt`）；
  - 控制脚本 `ctl.ps1` / `shot.ps1` / `wins.ps1`；
- 动态实验后的 REA 快照 `db\wallpaper64-2.8.42-p3-userprops-dyn.rea-snapshot`：126 条证据，含合并函数汇编与断言点检索。

### I10. 动态实验记录（2026-11-03，实测）

**环境**：
- WPE 2.8.42 正在运行，主进程 3:50 启动，Monitor0 壁纸为工坊 2932157836「星浴」；画质设置 `postprocessing="disabled"`，没有改动；
- Kabegame dev 在运行，壁纸窗口挂在 WorkerW 上。
- 测试全部在 `-playInWindow` 独立窗口里进行：窗口名 `KBTest` / `KBCombo` / `KBComboCtrl`。
- 判读依据：
  - 脚本用 `console.error` 写 `log.txt`；
  - 用 `PrintWindow` 截取窗口（窗口在 150% 缩放下只显示渲染结果的左上 2/3，测试图层已按此摆放）；
  - 工程目录里着色器缓存的写入时间。

**现象与日志摘录**（时间为 UTC；`frame` 是脚本自己累加的 update 次数）：

| 步骤 | 操作 | 日志 / 画面 | 判读 |
|---|---|---|---|
| 1 | 打开工程 | `init#1 frame=0 fullKeys=alignment,…,wec_sa`（25 个）；`initOnly#1`；`apply frame=0 n=25 {… p_color=Vec3(1,0,0) … p_mode=string:"b" … rate=number:100 … wec_e=boolean:false …}`；`speed=5 frame=1` | 首次 apply 是全集、在 init 之后、第一次 update 之前；按 `type` 转换；WPE 注入了 14 个内置项 |
| 2 | `{"p_alpha":0.3}` | `apply frame=60 n=0 {}`；`apply full n=10 … p_alpha=number:0.3`；`fullKeys=p_alpha,p_bloom,…,p_tintcolor`；A 变暗 | 直接绑定生效；脚本收到空对象（CLI 没有 `type`）；内置伪属性从全集里消失 |
| 3 | `{"p_color":"0 0 1"}` | `apply … n=0 {}`；`full … p_color=string:"0 0 1"`；A 变暗蓝 | 颜色绑定吃字符串；全集里整项被覆盖、丢了 `type` |
| 4a | `p_mode` = `a`，再改回 `b` | A 消失，再复现 | 条件可见运行时生效 |
| 4b | `{"p_effvis":false}` / `true` | B 由绿变白，再变回绿 | effect 可见性运行时切换正常 |
| 4c | `{"p_tintcolor":"1 0 1"}` | B 立即变洋红；没有新着色器缓存 | 材质常量就地生效 |
| 4d | `p_origin_x` = `"250 550 0"`；`p_size_w` = `"120 120"` | A 下移；**尺寸不变** | `origin` 就地生效；`size` 运行中无效 |
| 4e | `{"p_slider":9}` | `apply frame=4549 n=0 {}`；`apply full … speedNow=9`；`speed=9 frame=4550 runtime=455.075`；C 变亮 | `updateScriptProperties` 先于 apply；新值在下一帧可见；脚本绑定值由 update 写回；init 没重跑 |
| 4f | `{"p_bloom":true,"p_bloomstr":4}` | 只有 apply 日志，画面无变化 | 后处理关闭档下不会有泛光，未判读 |
| 4g | `{"wec_e":true,"wec_brs":80,"wec_sa":0}` | 整画面变亮、去饱和；`fullKeys` 多了 `wec_brs,wec_e,wec_sa`；19:13:21 新增着色器缓存 `8434196b….dxs` | 颜色校正生效，运行中编译新变体；增量里带了的伪属性才保留 |
| 4g | `{"wec_e":false}` | 画面恢复；`fullKeys` 只剩 `…,wec_e`（`wec_brs` / `wec_sa` 又消失） | 伪属性被写成 `null` 的缺陷再次出现 |
| 4g | `{"alignment":1,"alignmentz":60,"schemecolor":"1 0 0"}`，再还原 | 背景整片变红；还原后恢复 | `schemecolor` 在对齐模式下作清屏色 |
| 5 | 打开 `kbprops-combo`（`combos.BLENDMODE = {user, value}`） | 窗口全黑，`log.txt` 无记录；稍后用户看到断言框：「Microsoft Visual C++ Runtime Library — Assertion failed! Program: …\wallpaper64.exe File: D:\dev\we\windows\src\json\src\json_value.cpp Line: 719 Expression: false && oss.str().c_str()」，点中止后 WPE 主进程退出 | COMBO 按整数读，对象值触发 jsoncpp 断言，**整个进程中止**。对照工程 `kbprops-combo-ctrl`（只把它改回整数 30）正常显示绿块 |

**附带发现**：
- 主进程中止后，我接着发出的 `-control closeWallpaper` 找不到主实例，自己成了新的 WPE 主实例（带浏览界面），因此卡在等待。这个实例在本工具的作业对象里，结束后台任务时它随之退出。
- 第 2–3 步之间（04:08:31 本地时间），Kabegame 日志记录了一次 `renderer unresponsive for webview 'wallpaper', terminating for reload`，随后 3 次 ping 未应答，04:09:04「无响应，重新加载」后恢复。
  - 当时没有发 WPE 命令，但 `KBTest` 窗口开着（置顶、约 144 fps）；
  - 开工前 03:48–03:49 已有成串的 ping 未应答；
  - 04:01–04:02 用户也在主窗口预览 4K 场景。
  - 原因无法认定，只记录相关性。

**恢复清单**：

| 项 | 开工前 | 结束时 | 说明 |
|---|---|---|---|
| WPE 进程 | 运行（PID 81344，3:50 启动，带浏览窗口） | 运行（PID 31272，4:19 经 WMI 启动，不在本工具的作业对象里） | 原进程被第 5 步的断言中止；新进程没有自动弹出浏览窗口 |
| Monitor0 壁纸 | 工坊 2932157836「星浴」 | 同一张：`-control openWallpaper -file …\2932157836\project.json -monitor 0` 后出现 `WPEDesktopDX11Window 'WPELiveWallpaper'`（父窗口 WorkerW） | 新进程启动后没有自动加载壁纸，所以手动放回 |
| `config.json` | 哈希 `DF9E3649…` | 与备份只差一处：`general.wallpaperconfig.layout: 0` 被去掉（`openWallpaper -monitor` 重写这项配置所致）。没有回写，因为 WPE 没有退出命令，运行中覆盖会被它再写回 | 推断缺省即 0。备份在 `dyn-test\backup\config.json`，如需严格还原，在 WPE 退出后覆盖 |
| 测试窗口 | — | `KBTest` / `KBCombo` / `KBComboCtrl` 都已不存在 | — |
| Kabegame 壁纸窗口 | 渲染中 | CDP 只读检查（`eval --url wallpaper`）：1 秒 145 帧，`visibilityState=visible`；04:09:18 之后日志没有新的 ping 未应答 | **桌面上 WPE 的「星浴」与 Kabegame 壁纸谁在上层、是否被盖住，我看不到，请用户目视确认** |
| `myprojects\kbprops-test` | 不存在 | 第 6 步后由主会话删除（含 WPE 写入的 `shaders\blobsSM40\*.dxs`），`myprojects` 恢复为空 | — |
| `log.txt` | 5 行 | 73 行；新增部分另存在 `dyn-test\log-run-full.txt` | 追加型日志，不回滚 |

**第 6 步结果（2026-11-03，用户在 WPE 界面操作，主会话读 `log.txt` 判读；实测）**：
- 用户在浏览器里选中 kbprops-test，拖 `p_alpha`（1 → 约 0.17 → 0.21）、在取色器里来回选 `p_color`、拖 `p_slider`（5 → 10 → 8），比约定多了几次操作，不影响判读。
- **首次加载**与 CLI 路径相同：`init#1` → `initOnly#1` → `apply frame=0 n=25`（全集，颜色为 `Vec3(1,0,0)`）→ `speed=5 frame=1`。
- **UI 每次改值都是 `n=1`，并带 `type`**：`apply frame=86 n=1 {p_alpha=number:0.34}`、`apply frame=244 n=1 {p_color=Vec3(0,1,0.9686…)}`、`apply frame=359 n=1 {p_slider=number:6}`。CLI 路径的 `n=0 {}` 只是因为它不带 `type`（I4 结论成立）。
- **拖动中逐帧连发**：一次 `p_alpha` 拖动在 frame 86–93 每帧一条（0.34、0.31、0.29、0.25、0.22、0.21、0.2、0.17）；取色器同样逐帧发，且**同一个值会重复发**（`Vec3(0,0.2431…,1)` 在 frame 259、271、272 各一条），印证「不去重」。
- **脚本属性**：`apply frame=359 … speedNow=6` → `speed=6 frame=360`，每次都是下一帧生效；init 全程只有 1 次。
- **全集缺陷在 UI 路径同样出现**：第一次改值后 `engine.userProperties` 也从 25 个键掉到 10 个（只剩 `p_*`，`alignment*` / `rate` / `schemecolor` / `wec_*` / `wcc_*` 都没了）；但 `p_color` 在全集里保持 `Vec3`（UI 发的是带 `type` 的完整属性对象）。
- 收尾：主会话用 `-control openWallpaper -file …\2932157836\project.json -monitor 0` 放回「星浴」（`config.json` 的 Monitor0 已指回 `2932157836\scene.pkg`），删除 `myprojects\kbprops-test`。`config.json` 里留下 WPE 自己写的两处痕迹：最近使用列表里一条 kbprops-test、`wproperties` 里一份它的属性值；WPE 运行中无法回写备份，未处理。

**第 6 步（原操作说明，已执行）**：工程曾复制到 `D:\Applications\Steam\steamapps\common\wallpaper_engine\projects\myprojects\kbprops-test`。
1. 双击任务栏通知区的 Wallpaper Engine 图标，打开壁纸浏览器。
2. 在「已安装」列表里找到标题为 **kbprops-test** 的壁纸，单击选中。它会被设为 Monitor0 的桌面壁纸，桌面会被它盖住，可以接受。
3. 在右侧属性面板：
   1. 把 **p_alpha** 滑块从 1 拖到约 0.5，松手；再拖到约 0.2，松手。共 2 次拖动。
   2. 点 **p_color** 的色块，选一个明显不同的颜色（如纯绿），确认。1 次。
   3. 可选：把 **p_slider** 从 5 拖到 8，1 次。
4. 告诉协调方做了哪几次操作。之后由协调方：
   - 读 `log.txt` 判读。预期每次改值都有 `[kbt] apply … n=1 {p_alpha=number:…}` 或 `{p_color=Vec3(…)}`；拖动中可能连发多条；全集里 `p_color` 仍是 `Vec3`。
   - 用 `wallpaper64.exe -control openWallpaper -file "D:\Applications\Steam\steamapps\workshop\content\431960\2932157836\project.json" -monitor 0` 放回「星浴」。也可以在浏览器里点回它。
   - 删除 `myprojects\kbprops-test`。

## J. effect 可见性切换的时序（2026-11-06）

对象不变（`wallpaper64.exe` SHA-256 前缀 `40e2ce02`）。目的：用 WPE 的真实行为核对 `rebuildLayer`（后台异步重建、建好前画旧计划）。

**置信度**沿用 I 节：静态确认 / 实测 / 推断 / 未查清。

**一句话结论**：
- **全程同步，没有后台线程、没有队列、没有延后消费。** 切换在渲染线程的 0x466 处理或脚本写回里当场做完，新建 D3D11 资源也是当场。
- **关着的 effect 在加载时就全部备好**（解析材质、编译或读着色器、建 fbo），绑用户属性与写死 `false` 一样。第一次打开不编译。
- **用户属性改值后的第一帧就是新结果；脚本在 `update` 里写，同一帧就按新结构画。** 没有观察到跳帧、闪烁或黑帧。
- **确实要在运行中编译时**（例如 `wec_e` 首次开启），`D3DCompile` 在渲染线程当场阻塞，这一帧晚到。
- **fbo 内容与 swap 状态在关 / 开之间保留**；但带 `clear` 的 fbo **每次重建都被清**，且是图层上全部 effect 的 fbo，不管切的是谁。合成 RT 每次重建都先释放再取，引用归零就销毁。

**实验条件**（数字都在这个条件下得到）：
- 窗口在用户的 WPE 主进程里（`-playInWindow`），每个窗口一条渲染线程，`log.txt` 的线程号随窗口变（如 147388、20412、141128）。
- WPE 设置 `fps=10`（没有改），帧间隔实测 100 ms；`postprocessing=disabled`。
- **没有用 RenderDoc**：PID 36548 没有加载 `renderdoc.dll`（`tasklist /m renderdoc.dll` 只列出 qrenderdoc、renderdoccmd），要抓帧得重启 WPE，约束不允许。pass 数与 RT 清单这轮没有抓帧证据，用染色工程加静态分析代替。
- 画面采样用 `PrintWindow(PW_RENDERFULLCONTENT)`，约 4 次 / 秒，每次耗时约 250 ms，窗口被遮挡也能取。比帧率低，所以靠重复切换和脚本打时间戳。
- 脚本计时用 `Date.now()`，精度 1 ms（`performance` 不存在：`[kbs] start frame=5 perf=false`）。

### J1. Q1：`FUN_1402065e0` 这条链里什么当场做完

**静态确认**（REA + wp.asm），**全部在调用内完成，没有「标脏、之后消费」的环节**：

| 步骤 | 地址 | 做什么 | 时机 |
|---|---|---|---|
| 写位 | `FUN_1401e1a90`（JSON setter）；`0x1401e1c60`（类型化 setter，脚本走这个） | 写 effect `+0x118` bit0，再调描述符 `+0x58` | 当场 |
| 重算 | `FUN_1401e6300` | 遍历图层**全部** effect，统计合成次数与 pass 数；与 `+0x320` / `+0x324` 相同就返回，不同就写回并跳到虚函数 +0x110 | 当场 |
| 入口 | 图像层 +0x110 = `FUN_1402065e0` | 只有 `+0x328`（加载中）置位时跳过；加载结束时 `FUN_1401e6f50` 补调一次 | 当场 |
| 材质变体 | `FUN_140209540`（图层材质槽 0 有纹理时） | 按「是否需要合成」同步释放 / 取得光照、遮罩用的材质与 `_rt_imageLayerAlbedo_`；普通图层基本是空转（推断） | 当场 |
| 尺寸 | `FUN_140209360` | 重算尺寸与 UV 比例，再调 +0xb0、+0xb8 | 当场 |
| 几何 | +0xb0 = `FUN_1402066a0` | 析构旧 mesh，经 `FUN_1401ede30` → 设备 +0x40 新建 | 当场 |
| 合成 RT 与 fbo | +0xb8 = `FUN_1401ea500` | 见 J6 | 当场 |
| passthrough | +0xc0 = `FUN_140206ae0` | 释放后重取 passthrough 材质：重读 JSON，着色器走内存缓存（推断，依据是缓存键查找） | 当场 |

**逐帧读的只有两样**：effect 的启用位与 `+0x320`。渲染循环 `FUN_1401e8aa0` 每帧遍历全部 effect 跳过未启用的，「最后一个启用 effect」也是每帧现算，没有缓存的计划可以作废。

**D3D11 资源当场创建**（静态确认）：
- RT：设备 +0x70 → `FUN_1400d2c60`，`0x1400d2f69` 处 `ID3D11Device::CreateTexture2D`（`pInitialData` 为空，`xor r8d, r8d`）。
- 着色器：设备 +0x38 → `FUN_1400d5070`，构造函数里读 `.dxs` 或调 `D3DCompile`（函数指针 `DAT_1404e52d0`），再 `Create*Shader`，新编译的写回 `blobsSM40/`。
- 清屏：设备 +0x120 = `0x14009b160`，直接调 `ClearRenderTargetView`（`0x14009b191`，立即上下文）。

**没有工作线程参与**（静态确认，有范围限制）：
- 全部 18 处 `_beginthreadex`（`0x1402ca17c`）的入口，用 `.pdata` 函数边界建直接调用图（深度 8，不含虚调用）查可达性，只有 `0x140120790` 能到材质创建。它带 `"DXGI device lost in render loop.\n"`，用 `materials/background.json`，是非场景壁纸自己的渲染循环，不是工作线程。其余入口如媒体播放（`0x1400f3930`，用途是推断）、脚本存储（`0x1401e2bc0`，`LSBK0001`）都到不了。
- 材质 → 着色器链上唯一的锁是 d3dcompiler 懒加载的 `DAT_1404df730`。
- 虚调用边没有逐一排除，但 `FUN_1401a7350` 的调用方只有 `FUN_1401a5c40`，后者只有材质路径调用。

**实测耗时**：1600×1600 图层，脚本写回前后用两个脚本夹住（J5），翻转帧 200 次平均 0.7 ms、最大 9 ms；不翻转的帧 200 次平均 0.045 ms、最大 6 ms（1 ms 时钟的平均值）。
> 日志原文：`[kbs] writeback dt flip n=200 avg=0.7 max=9 | same n=200 avg=0.045 max=6`

### J2. Q2：加载时关着的 effect

**实测 + 静态确认：着色器在加载时就处理完，第一次打开不用补。绑用户属性与写死 `false` 没有区别。** fbo 同样在加载时建，这一点只有静态依据。

四个不带缓存的工程，effect 的着色器有唯一 uniform 名 `g_KbMarkerTint`。打开后 5 秒查 `shaders/blobsSM40`，**全程没有切换**：

| 工程 | effect `visible` | `.dxs` 数 | 含标记的 `.dxs` |
|---|---|---|---|
| `load-none` | 没有 effect | 5 | 无 |
| `load-user` | `{user: p_effvis, value: false}`，属性默认 false | 6 | `b7334ab23b16`（2014 字节），打开后 0.737 s 写入 |
| `load-false` | `false` | 6 | 同一文件，0.723 s |
| `load-true` | `true`（对照） | 6 | 同一文件，0.685 s |

静态依据：
- `FUN_1401e7170` 在读 `visible` 之后，对每个满足 `conditions` 的 pass 无条件调 `FUN_140150770` 取材质（`0x1401e7b04`），没有检查启用位。材质构造里同步取着色器与纹理（`FUN_1401515b0` → `FUN_140154480` → `FUN_1401a5c40`）。
- 启用位只影响末尾两个计数（`+0x320`、`+0x324`）。
- fbo：`FUN_1401ea500` 的 fbo 循环遍历 `+0x308..+0x310` 的全部 effect，不看启用位；加载结束时 +0x110 会调到它，所以关着的 effect 的 fbo 加载时就建好了。
- `FUN_1401e6f50` 也不看 `visible`，只看 `file`。

这回答了 I2 的遗留：「切 effect 没产生新着色器缓存」那次用的 effect 加载时开着；加载时关着也一样不产生。

### J3. Q3：运行中编译是阻塞还是异步

**第一次打开不编译**（实测）。`toggle` 工程不带缓存、effect 默认关：
- 加载后 6 个 `.dxs`，已含标记文件；
- 连续切 16 次，没有新文件：`after 10 toggles: blobs 6 new []`、`after effect-only toggles: blobs 6 new []`；
- 帧间隔无变化：这 16 次切换，上一次 `update` 到改值 99–102 ms，改值到下一次 `update` 0–1 ms，与只改无绑定属性的 5 次对照看不出差别。`fps=10` 下小于 1 ms 的开销本来也看不出。

**真要编译时，在渲染线程当场阻塞**。用运行中必然出新变体的 `wec_e`（I5）当对照，普通切换一次，看帧间隔：

| 情况 | 这一帧 | 下一帧 | `.dxs` 写入 vs `applyUserProperties` |
|---|---|---|---|
| 首次，`D3DCompile`（第 1 轮） | 128 ms | 65 ms | 新文件 `…582921`，apply `…582922` |
| 首次，`D3DCompile`（第 2 轮） | 113 ms | 85 ms | `…450176`，`…450177` |
| 首次，`D3DCompile`（第 3 轮，删 `.dxs` 后） | 112 ms | 85 ms | `…467169`，`…467170` |
| 新窗口，`.dxs` 已在磁盘 | 102 ms | 97 ms | 没有写 |
| 同一窗口第二次开（内存已有） | 101 ms | 99 ms | 没有写 |

- **`.dxs` 都比 `applyUserProperties` 早 1 ms 写完**，而 apply 在同一次 0x466 处理的末尾，所以编译、写文件都发生在消息处理内部。**实测 + 静态确认**（`FUN_1400d44e0` 直接调 `D3DCompile`）。
- 这三次多花 12–28 ms。读 `.dxs` 多花不到 2 ms。
- 这期间不出帧，屏幕保持上一帧（**推断**，依据是帧间隔与单线程结构；没有抓到这段的画面）。下一帧的间隔会缩短，因为节拍按绝对时刻算（`FUN_140110630` 帧尾的 `Sleep` 计算）。在 100 ms 预算下只是晚到；高帧率下会掉帧（**推断**，没有测）。

**可能在切换时编译的例外**（**静态确认，未实测**）：`FUN_140209540` 在「是否需要合成」变化时，对材质标志含 `0x18` 的图层取带 `LIGHTING` 等 COMBO 的材质（如 `0x140209b42`）。0x8 来自 `_rt_MipMappedFrameBuffer`，0x10 来自着色器标志。这是图层基础材质的变体，不是 effect 自己的。

### J4. Q4：切换那一刻的画面

**实测：改值后的第一帧就是新结果，没有观察到跳帧、闪烁或黑帧。**

同一条 `applyProperties` 同时改 B 的 effect（`p_effvis`，要重建）和 A 的 `alpha`（只改字段，I3 已知下一帧可见），共切 30 次，采样 204 次：
- A、B 只出现两种组合：`(255,0,0) + (255,255,255)` 与 `(71,20,20) + (0,255,0)`，**从未出现一新一旧**。
- 全窗口网格只有预期的 7 种颜色，没有黑块或第三种状态。
- 30 次切换都观察到了（31 个状态段）。
- 结束时刻落在改值后 6–100 ms 内的样本有 10 个，即第一帧的存活期，**10 个全是新状态**。最早的新状态样本在改值后 8 ms 结束；旧状态样本最晚在改值后 5 ms 结束。
- 帧间隔：这 30 次里，上一次 `update` 到改值 93–105 ms（平均 100.2），改值到下一次 `update` 0–1 ms（平均 0.07）。

时序（**静态确认 + 实测**）：渲染循环 `FUN_140110630` 帧尾 `Sleep`，醒来后在下一帧之前用 `PeekMessageW` 泵消息。所以消息总在帧与帧之间处理，重建的耗时直接算在下一帧头上。

局限：采样 4 次 / 秒，不能保证看到每一帧。单帧异常的漏检概率靠重复切换压低，J5 的按帧翻转覆盖了更多「切换后第一帧」。

### J5. Q5：脚本写 effect `visible`

**静态确认 + 实测：回调在写回时当场触发，同一帧就按新结构画。**

静态：
- DLL 写回 `FUN_181620e10` 末尾 `(*(desc+0x48))(目标, desc+0x30, 值)`。effect `visible` 的 `+0x48` 是 `0x1401e1c60`（`0x1401efda0` 处注册）。
- 这个函数写完位后 `mov rax,[rdx+0x28]; jmp rax`，尾调用 `+0x58` 即 `FUN_1401e6300`。不比较新旧值，所以每帧都会重算计数，只有计数变了才重建。
- `update` 在 `FUN_14017fa70` 的 `0x1401802e5`，早于渲染。

实测：
- **写回时触发**：夹在 effect 所在图层前后的两个脚本，翻转帧的时间差明显大于不翻转的帧（J1 的 0.7 ms 对 0.045 ms）。说明重建在写回与下一个脚本之间完成。
- **同一帧**：K0 与 effect 同节奏（每 2 帧翻转一次，共 400 帧），K1 故意晚一帧当对照：

| 工程 | 写法 | K0 与 B 同相 | K1（晚一帧的对照）与 B 同相 | 预期外颜色 |
|---|---|---|---|---|
| `script` | `visible: {script}`，`update` 返回值 | **181 / 181** | 102 / 181 | 0 |
| `script-api` | `thisLayer.getEffect('kbmark').visible = x` | **181 / 181** | 103 / 181 | 0 |

对照证明这个采样看得出一帧之差。`getEffect` 这条路是否走同一描述符，没有读 DLL 代码（**推断**），行为与写回一致。

### J6. Q6：fbo、swap 与合成 RT

**fbo 内容保留，除非带 `clear`。**（实测 + 静态确认）

红通道每帧累加约 8 级，一次采样约等于 2–3 帧：

| 图层 | 操作 | fbo | 切换后第一个样本 | 结论 |
|---|---|---|---|---|
| L1 | 关自己 1.2–2.4 s 再开 | 无 `clear` | 关前 → 开后：138→146、75→99、28→44、252→5、189→205、190→198、143→159、128→152 | 接着关之前的值走，1–3 帧的差 |
| L2 | 关自己再开 | 有 `clear` | 8 次都回到 8 或 16 | 清了，从头累加 |
| L3 | accum 不动，切同图层的 tint | 无 `clear` | 8 次开、8 次关都连续 | 合成次数变化不影响 fbo |
| L4 | accum 不动，切同图层的 tint | 有 `clear` | 开关**两个方向**都跳回 8–24（如 138→24、208→8） | **没被切的 effect 的 fbo 也被清** |

静态：
- `FUN_1401ea500` 每次都遍历全部 effect 的全部 fbo：fbo 已存在时调 `FUN_140161f40`，尺寸不变就什么都不做；然后只要带 `clear`（`+0x48` bit1）就绑定并清屏（设备 +0x118、+0x120）。
- 重建只在计数变化时发生，同值重发不会清。
- WPE 自带的 `fluidsimulation` 的速度、压力、染料 fbo 都带 `clear`，所以切同图层任何 effect 都会把模拟清零（静态推出，没有跑）。

**swap 状态保留。**（实测 + 静态确认）
- 静态：`FUN_1401ebf60` 的 swap 分支直接改 pass 数组里的 target / source / bind 下标，跨帧保留；effect 关着时这个分支不执行，切换链也不碰它。
- 实测：`parity` 工程用步长 1/255 的帧计数。Lr 常开，Lp 由脚本在 50 帧内按「开 3 帧、关 2 帧」切 10 轮（每轮翻转一次奇偶），共 20 帧不执行。结束后两层红通道之差**恒为 20**（26 个样本），切换前恒为 0。如果 swap 状态在重开时复位，会多丢帧，差值不会正好是 20。

**合成 RT：每次重建都释放再取，内容不清空也不依赖。**（静态确认，没有抓帧）
- `FUN_1401ea500` 开头无条件把两张 RT（`+0x2c8`、`+0x2d0`）的引用计数减 1，归零就 `FUN_1401ab5f0`：从池的名字表摘掉并析构。然后按新张数重新取。
- `sc.*` 池化 RT 被别的同尺寸图层引用时留着，否则销毁再建。`_rt_imageLayerComposite_<id>_a` 由本图层独占，每次都销毁再建。
- 新 RT 没有初始数据，这里也不清屏。每帧的基础 pass 关混合画满整张（p2 B7），所以旧内容用不上。

### J7. 更正与补充（旧文字未改）

- **p2 B6**「`clear`：创建 / resize 后立即清成该色」**不完整**：是每次 `FUN_1401ea500`，包括 effect 切换导致的重建（J6，实测）。
- **I8 未解决项** `S+0x1678` 待刷新集合的消费点：是 `FUN_140150d60`，每帧开头在 `0x14017fd1a` 调用（静态确认）。
- **I10** 写的 KBTest 窗口「置顶、约 144 fps」与实测不符：本轮帧间隔 100 ms，对应 `fps=10`；I10 自己的 `frame=4550 runtime=455.075` 也是 10 fps。本轮测试窗口也没有置顶，会被其它窗口盖住。
- **I1** 的「帧间消息泵」更具体：消息在帧尾 `Sleep` 之后、下一帧之前处理（J4）。I1 里第 N 帧的 apply 与第 N+1 帧的 update 实际只隔 0–1 ms。
- **p2 B7** 的「其余 pass 仍画全屏四边形到各自 fbo」要补一句：**最后一个启用 effect** 的中间 pass 不是单位矩阵（**实测现象 + 推断原因**）。
  - 现象：第一版测试 effect 的中间 pass 顶点用 `g_ModelViewProjectionMatrix`，它是图层最后一个 effect 时 fbo 始终不更新；后面再加一个 effect 就正常，改成 `vec4(a_Position, 1.0)` 也正常。
  - 原因推断：进入 `LAB_1401e9cc9` 的 final 循环前已切到场景矩阵，全屏四边形被缩到 fbo 中央。
  - 看过的 9 个带 `target` 的自带 effect，中间 pass 都不用这个矩阵（`blurprecise` 按 COMBO 分支；`fluidsimulation` 只看了两个顶点着色器），只有 combine 用。
  - Kabegame 的 `effect` 角色 MVP 为单位阵（`uniforms.ts`）。

### J8. 与 `rebuildLayer` 的行为差异（只列事实）

| 项 | WPE | Kabegame（`scene.ts`） |
|---|---|---|
| 执行方式 | 渲染线程同步，处理完才继续 | `sync` 启动异步任务，不等待 |
| 生效时间 | 用户属性：改值后第一帧；脚本：同一帧 | 程序、管线等齐才换上，注释写「可能晚几帧」 |
| 等待期间 | 没有新旧并存。要编译时这一帧晚到 | 继续画旧计划 |
| 关着的 effect 的着色器 | 加载时全部编译 | `prepareLayer` 只处理计划内步骤，第一次打开才建程序与管线 |
| 关着的 effect 的 fbo | 加载时建 | 加载时建（一致） |
| 关着的 effect 的纹理 | 加载时取 | 加载时上传（`uploadableTextures`；带 unsupported 的除外） |
| fbo 内容 | 保留，带 `clear` 的除外 | 保留 |
| `clear` | 每次重建都清，同图层全部 effect | 只在创建时清一次 |
| swap 状态 | 保留 | 保留（`FboBindings`），一致 |
| 合成 RT | 每次重建释放再取，引用归零即销毁 | 只增不减 |
| 连续切换 | 每次写都处理，计数变了就重建 | 同一图层同时只跑一次，跑完比较签名，中间值跳过 |
| 触发条件 | 合成次数或 pass 数变了 | 计划签名变了 |

### J9. 未查清与局限

- **RenderDoc 没用上**（见开头）：运行中的 pass 数、RT 实际创建与销毁、fbo 是否在加载时已建，都只有静态依据或染色工程的间接证据。
- **`fps=10` 下的帧间隔**只能看出超过 1 ms 量级的影响。高帧率下切换是否掉帧没有测，也不能改用户设置。
- **切换开销的规模**：只测了纯色层（1600×1600，0.7 ms）。真实工坊场景、大纹理层、`colorBlendMode` 层（每次重读 passthrough 材质 JSON，`FUN_140206ae0`）没有测。文本层（+0x110 = `0x140258900`）与另一类图层（+0x110 = `0x140260190`）的重建函数没有读。
- **`FUN_140209540` 的材质变体分支**：只有静态分析，没有构造场景触发。
- **`D3DCompile` 返回后的驱动层**：API 之下的驱动线程不在分析范围。
- **`SendMessageTimeoutW` 是否等处理完才返回**（I8）仍未解决。
- **顺带看到、未实测**：纯色层的 +0x110 走 `FUN_1402065e0` 的另一分支，用当前 `size`（`+0x2f0`）调 +0xb0、+0xb8。所以运行中改 `size` 虽然当场无效（I3），可能在下一次 effect 重建时生效。

### J10. 产物与恢复

实验目录 `ignore/p3c/wpe-sync/`：
- `gen.py` 生成全部工程，`base-kbprops-test/` 是从 `ignore/p3c/kbprops-test` 拷来的基础（去掉了 `blobsSM40`），两个原工程没有改动；
- `exp_load.py`（Q2）、`exp_toggle.py`（Q3）、`exp_dxs.py`（Q3 补充）、`exp_q4.py`、`exp_q5.py`、`exp_q6.py`、`exp_parity.py`；`ana*.py` 判读；`sampler_pw.py` 采样；`wpe.py` 发命令；
- `out/`：采样数据与日志，`out/log-run-full.txt` 是本轮 `log.txt` 新增的全部 190 行，`run-load.txt` 是 Q2 输出；
- `backup/`：开工前的 `config.json` 与 `log.txt`；
- `cap.py` 是弃用的 ddagrab 采样（本机不出帧，ffmpeg 不退出），`exp_toggle.py` 依赖它，只用了那次的 `.dxs` 与日志结果。

恢复情况：

| 项 | 开工前 | 结束时 |
|---|---|---|
| WPE 主进程 | PID 36548，2026/11/04 2:32:57 启动 | 同一进程，没有重启 |
| `wallpaperui`、RenderDoc、Kabegame | 运行 | 仍在运行，都没有动 |
| `config.json` | 哈希 `3a303f18…` | 同一哈希，没有任何变化 |
| 桌面壁纸 | Monitor0 = 工坊 3820104696 | 配置未变；没有发过针对显示器的命令 |
| 测试窗口 | — | 全部已关，按标题查询都不存在 |
| `log.txt` | 362 行 | 追加 190 行（WPE 写的追加型日志，没有回滚） |
| ffmpeg | — | 卡住的两个进程由我结束，没有残留 |

另外，试验屏幕抓取时，`gdigrab` 抓到了测试窗口所在区域的桌面内容（用户的编辑器，因为测试窗口没有置顶）。这几个文件已删除，之后只用 `PrintWindow` 抓测试窗口自身。

## K. 泛光开关与级数的运行中行为（2026-11-06）

对象不变（`wallpaper64.exe` SHA-256 前缀 `40e2ce02`，`scenescript64.dll` 前缀 `58039ef9`）。目的：Phase 3c 步骤 3 要把 `general.bloom` 与 `bloomhdriterations` 改成就地生效，这两项之前只有静态结论（I3 标着「未实测」，当时 WPE 是关闭档）。本轮用户把后处理改成了 `ultra`，LDR 场景与 HDR 场景同时可测。

**置信度**沿用 I、J 节：静态确认 / 实测 / 推断 / 未查清。

**一句话结论**：
- **运行中开关 `bloom`，下一帧生效，不重载**，LDR 与 HDR 都实测。
- **HDR 位运行中不变。** 关掉 HDR 场景的泛光，`brightness` 继续生效，画面与「JSON `value` 为 true、属性为 false」直接加载逐像素相同。
- **HDR 判定读 `scene.json` 里 `general.bloom` 的 `value`，不读属性当前值；泛光位读属性当前值。** 两者可以不一致，这一点与代码现状不同（K3）。
- **级数运行中改值下一帧生效**，8 → 3 → 8 回到原样，每个状态都与同 N 整场加载逐像素相同。
- **`thisScene.bloom`、`thisScene.bloomhdriterations` 存在且可读写，写入同帧生效**，能在 `bloom: false` 的场景里打开泛光，不编译着色器。读到的是场景位，不含档位（档位部分只有静态依据）。

**实验条件**（数字都在这个条件下得到）：
- 窗口在用户的 WPE 主进程里（`-playInWindow`，960×540），PID 36548。`postprocessing=ultra`，`fps=10`，帧间隔实测 100 ms。
- **没有用 RenderDoc**：PID 36548 没有加载 `renderdoc.dll`，要抓帧得重启 WPE，约束不允许。走的是哪条 combine 没有直接观察，靠读数与静态分析。
- 画面采样用 `PrintWindow(PW_RENDERFULLCONTENT)`，节流到约 23 次 / 秒，存整帧。这轮单次抓取约 9 ms（不节流时 112 次 / 秒），比 J 节记录的 250 ms 快得多，原因未查。所以这轮每帧能抓到约 2 次，比 J 节更接近逐帧。
- **窗口坐标**：窗口图 = 场景 × 0.5 + (11, 45)，y 轴朝上。`wpe-sync/cap.py` 注释里的 0.75 是错的（`ana_q4.py` 用的坐标其实也是 0.5）。其中 x 比客户区多 9 px，原因未查，不影响判读。
- **判读量**（场景坐标，版面见 K8）：
  - `hdrp`：判读片，颜色 0.6、`brightness` 0.5。LDR 读 153（0.6），HDR 读 76（0.3）。0.6 低于 LDR 阈值，自己不发光。开泛光时 HDR 还要加上辉光，读 80–90。
  - `dN`：白块右缘外 N 个场景单位的亮度，N = 10…640，无泛光时为 0（`clearcolor` 全黑）。
  - `k`：对照层，红 0.5，alpha 绑 `p_alpha`，与被测属性放在同一条 `applyProperties` 里改。alpha 只改字段，I3 已知下一帧可见。
  - PrintWindow 读 FP16 交换链是准的：HDR 无泛光时 0.3 读 76，亮度 4 的白块截到 255。
- `MON` 脚本用 `Date.now()` 记帧，`applyUserProperties` 时记下墙钟与 `thisScene` 的读数，`init` 计数，用来查重载。

### K1. Q1：LDR，`bloom` 绑属性，运行中关、开

**实测：下一帧生效，没有重载。** 工程 `q1-ldr`，连切 24 次，877 个样本：

| 项 | 结果 |
|---|---|
| 全部样本的读数组合 | **只有 2 种**，没有中间值、黑帧或第三种状态 |
| 辉光与对照层 `k` | 496 个（有辉光 + 亮）、381 个（无辉光 + 暗），**从未一新一旧** |
| 状态段 | 25 段，24 次切换全部看到 |
| apply 之后第一个新状态样本 | 结束时刻在 apply 后 **4–27 ms**（24 / 24）；apply 之后**没有一个旧状态样本** |
| 重载 | 全程 `init` 计数 1，帧号连续 |
| 帧间隔 | 切换前后 12 帧均值 100 ms，最大 105 ms，看不出影响 |
| 着色器 | `.dxs` 5 → 5，没有新文件（第一轮记录） |

读数（G 通道）：

| 状态 | `d10` | `d20` | `d40` | `d80` | `d160` 及更远 | `hdrp` |
|---|---|---|---|---|---|---|
| 开 | 54.2 | 40.2 | 18.6 | 2.2 | 0 | 153 |
| 关 | 0 | 0 | 0 | 0 | 0 | 153 |

运行中的「开」与字面量 `bloom: true` 整场加载（`ctl-ldr`）逐像素相同，「关」与字面量 `false`（`ctl-nobloom`）逐像素相同（比较时去掉标题栏与 `K` 层）。

静态（p2 A1、I3 已有）：`bloom` 没有改值回调，`FUN_14017fa70` 每帧读 `+0xe0` bit1。

### K2. Q2：HDR，`bloom` 绑属性，运行中关、开

**实测：HDR 位保持，下一帧生效，没有重载。** 工程 `q2-hdr`，连切 24 次，847 个样本，统计与 K1 同样干净：2 种读数，508 / 339 个样本，25 段，第一个新状态样本 4–40 ms，apply 之后没有旧状态样本，`init` 1 次，帧间隔最大 103 ms，`.dxs` 7 → 7。

| 状态 | `hdrp` | `k` | `bg` | `d80` | `d160` | `d320` | `d640` | 白块 |
|---|---|---|---|---|---|---|---|---|
| 开 | 90 | 138 | 9 | 153.2 | 75.9 | 33.6 | 12.2 | 255 |
| 关 | **76** | 25 | 0 | 0 | 0 | 0 | 0 | 255 |

- **关着时 `hdrp` 是 76，不是 153**：`brightness` 继续生效，HDR 位没动。24 次切换一次都没有回到 LDR。
- **关着时的画面**：没有任何辉光，背景全黑，其余按 HDR 场景原值输出，超过 1 的部分截断（白块亮度 4 读 255）。**这和「`bloom: false` 整场加载」不是同一个画面**：后者判成 LDR，`hdrp` 读 153（`ctl-nobloom`）。
- 运行中的「关」与 `q3a-jT-pF` 直接加载逐像素相同；「开」与 `ctl-hdr` 逐像素相同。
- 走 `combine_srgb` 是推断：读数相符（A3：`rgb = lin(rgb)`、不 saturate），没有抓帧。

### K3. Q3：HDR 判定读 JSON 的 `value` 还是属性当前值

**实测 + 静态确认：读 `scene.json` 里 `general.bloom` 的 `value`。泛光位读属性当前值。这回答了 p2 J5 没分清的问题。**

四个工程都是 `hdr: true`、`bloom: {user: p_bloom, value: j}`，属性值 `p` 写在 `project.json`，直接加载，读数不经任何运行中改值：

| 工程 | JSON `value` | 属性当前值 | `hdrp` | 判定 | `d80` | 泛光 |
|---|---|---|---|---|---|---|
| `q3a-jT-pF` | true | false | **76** | **HDR** | 0 | **关** |
| `q3b-jF-pT` | false | true | **153** | **LDR** | 2.2 | **开（LDR 链）** |
| `q3c-jT-pT` | true | true | 90 | HDR | 153.2 | 开（HDR 链） |
| `q3d-jF-pF` | false | false | 153 | LDR | 0 | 关 |

- `q3a` 与 `q3b` 是决定性的两组：`hdrp` 跟着 JSON `value` 走，辉光跟着属性走。
- 整帧比较：`q3b` 直接加载 = `ctl-ldr`，`q3c` = `ctl-hdr`，`q3d` = `ctl-nobloom`，都是逐像素相同。
- **运行中再翻属性，判定不变**：
  - `q3a` 翻成 true：`hdrp` 76 → 90，`d80` 153.2，就是 HDR 链的读数。说明这个窗口的 HDR 链已经就绪。
  - `q3b` 翻成 false：`hdrp` 保持 153，`d80` 归零。
  - `q3d` 翻成 true：出现 LDR 辉光（`d80` 2.2），`hdrp` 保持 153。
- **`init` 里读到的是 JSON 的 `value`**，第一次 `update` 起才是属性值。`q3a`：`init` 时 `thisScene.bloom=true`，第 5 帧 `false`。`q3b`：`init` 时 `false`，第 5 帧 `true`。这与 I1 的顺序一致：解析期 setter 写 JSON 的 `value`，场景构造完才以全集为增量走一次绑定。

静态（本轮 REA）：
- `FUN_14010df40` 读 `.json` 文件（`FUN_1400d3f80`）、rapidjson 解析（`FUN_140117060`），用 `FUN_14010d850(general, "bloom")`、`FUN_14010d850(general, "hdr")` 取值。
- `FUN_14010d850`：成员是对象时返回它的 `value` 成员（`FUN_140116800(…, "value")`），否则返回成员本身。**全程不碰属性**，所以 p2 G3 的「属性对象不算」确实是错的，J5 的更正是对的，只是取值来源现在分清了。
- **`general.hdr` 走同一个函数，同样读 JSON 的 `value`**（静态确认，没有构造工程跑）。

局限：这里的「属性当前值」是 `project.json` 的默认值。**用户在界面改过并存进 `config.json` 的值没有测**，因为不能动配置。静态上这条路只读场景文件，推断结论相同。

### K4. Q4：HDR，`bloomhdriterations` 绑属性，8 → 3 → 8

**实测：下一帧生效，回到 8 后与开始完全相同，没有残留。** 工程 `q4-iter`（`bloomhdrstrength` 压到 0.5，让两种级数都不饱和），基准是字面量工程 `q4-n8`、`q4-n3`。切 12 次，721 个样本：

| 项 | 结果 |
|---|---|
| 与整场加载基准整帧比较 | **485 个样本与 N=8 逐像素相同，236 个与 N=3 逐像素相同，例外 0 个** |
| 回到 8 | 与开始、与 `q4-n8` 都逐像素相同（6 次都是） |
| 对照层 `k` | N=8 只配亮、N=3 只配暗，从未一新一旧 |
| 状态段 | 13 段，12 次切换全部看到 |
| apply 之后第一个新状态样本 | 6–30 ms（12 / 12），之后没有旧状态样本 |
| `thisScene.bloomhdriterations` | 切换时读到 3、8 |
| 重载与着色器 | `init` 1 次，帧间隔最大 102 ms，`.dxs` 7 → 7 |

读数（G 通道，字面量工程与运行中相同）：

| N | `d10` | `d20` | `d40` | `d80` | `d160` | `d320` | `d640` | `bg` | `hdrp` |
|---|---|---|---|---|---|---|---|---|---|
| 8 | 116.4 | 92.7 | 65.0 | 38.2 | 18.8 | 8.2 | 3.0 | 2.0 | 80 |
| 3 | 110.4 | 39.8 | 2.6 | 0 | 0 | 0 | 0 | 0 | 76 |

- N=3 辉光很集中，N=8 铺满全屏。两者在 `d10` 处接近，这是归一化压低 N=8 的结果：公式给出强度 0.5 / (1 + 1.619^6) = 0.0263 对 0.5 / (1 + 1.619) = 0.191，约 7.25 倍。
- **公式本身没有单独做数值验证**（要模拟整条链）。这里实测到的是：运行中改 N 与整场加载 N 逐像素相同，所以归一化确实按当前 N 重算。公式来自 A2，N=8 有 p2 J5 的抓帧。
- 这个窗口的可用级数够 8 级：按 A1 的规则，540 连减 7 次半仍不小于 1。
- 安全性（静态）：int setter `FUN_1401a4930` 收 jsoncpp 的 int / uint / real 都直接转换，收 real 不断言，所以滑块绑 `bloomhdriterations` 不会走 I3 的 COMBO 断言。

### K5. Q5：脚本读写 `thisScene`

**实测：API 存在，读到 bool / number，写入当场读回，同帧生效。**

- **成员**：`thisScene` 的自有成员里有 `bloom`、`hdr`、`bloomstrength`、`bloomthreshold`、`bloomtint`、`bloomhdrstrength`、`bloomhdrthreshold`、`bloomhdrfeather`、`bloomhdrscatter`、`bloomhdriterations`、`clearenabled`、`clearcolor`，以及 `fog*`、`camera*`、`wind*`、`fov`、`zoom` 等。这补全了 C 节，C 节只列了方法。
- **读**（`q5-ldr`，`bloom: false`）：`bloom=boolean:false`、`bloomhdriterations=number:8`、`bloomtint=object:1 1 1`、`hdr=boolean:false`。
- **打开泛光**：`thisScene.bloom = true` 在 `bloom: false` 的场景里**能打开**，读回 `true`，辉光读数与 `ctl-ldr` 逐像素相同；写 false 关掉。两轮共 8 次写入，写后第一段读数都在 9–44 ms 内出现。
- **没有编译**：无缓存跑一次，`q5-ldr` 的 5 个 `.dxs` 最晚的比第一次写 `bloom` 早 4.98 s，之后没有新文件。
- **HDR 下**（`q5-hdr`）：
  - `thisScene.bloomhdriterations = 3` 读回 `number:3`，画面逐像素等于 `q4-n3`；写回 8 恢复。
  - `thisScene.bloom = false` 后 `hdrp` 76，HDR 位保持，画面等于属性关掉时（`q2-off`）。
- **同帧**：按 J5 的做法，每 2 帧翻一次共 400 帧，`K0` 与写入同相，`K1` 故意晚一帧当对照：

| 工程 | 写什么 | 翻转期样本 | 与 K0 同相 | 与 K1 同相 | 去重后状态序列 | 与 K0 不同 | 与 K1 不同 |
|---|---|---|---|---|---|---|---|
| `q5-sync` | `thisScene.bloom` | 941 | **941** | 473 | 397 | **0** | 198 |
| `q5-sync-iter` | `thisScene.bloomhdriterations`（3 / 8） | 932 | **932** | 467 | 397 | **0** | 198 |

对照证明这个采样看得出一帧之差。397 接近 400，说明几乎每帧都抓到了。

静态：
- `bloom` 描述符（`FUN_140199780`）：偏移 `0xe0`，`+0x48` = `0x14019b6b0` 改 bit1，`+0x50` = `0x14019b6e0` 读 bit1。**getter 只读这个字段，不碰渲染标志 `R+0x128`。** `+0x38` = `FUN_14019b4e0` 与 `+0x40` = `FUN_14019b5b0` 是 JSON 读写。没有改值回调。
- 脚本走 `+0x48` 是 J5 确认的；读取走 `+0x50` 没有读 DLL 代码，是推断。
- **级数同帧的原因**：`FUN_14017fa70` 里顺序是 `FUN_140171440`（脚本）→ `FUN_14018b390` → 脏位检查 `FUN_140184020` → 渲染与泛光分支。所以脏位在脚本**之后**、渲染**之前**消费。

**不含档位**：
- ultra 下档位恒为允许，这个实验分不出，**只有静态依据**（上面的 getter）。
- 旁证：`ctl-nobloom`（`bloom: false`、`hdr: true`）里 `thisScene.hdr` 读 `true`，而实际渲染是 LDR（`hdrp` 153）。说明 getter 读的是场景位，不是渲染状态。

**日志**：`console.log` 没有进 `log.txt`（每个工程 `init` 里都写了一行，0 命中），`console.error` 进。与 I4 一致。

### K6. 更正与补充（旧文字未改）

- **p2 J5**「取 JSON 的 `value` 还是用户当前值分不出」：已查清，读 JSON 的 `value`（K3）。
- **I3** `general bloom` 的「未实测」：LDR、HDR 都已实测，静态结论成立。
- **I3 / I1** 泛光参数「下一帧开头才重算」不准确：`FUN_140184020` 在脚本之后、渲染之前调用（K5）。属性改值的效果仍是下一帧，脚本写入是同一帧。
- **C 节** `thisScene` 的清单缺全部属性成员（K5）。
- **`cap.py`** 注释的 0.75 比例不对（见实验条件），`ana_q4.py` 用的坐标本身没问题。

### K7. 与计划和代码的差异（只列事实）

下面的文件与行号是 2026-11-06 工作区读到的，另一个代理正在改这几个文件，以实际代码为准。

| 项 | WPE | Kabegame 现状或计划 |
|---|---|---|
| HDR 判定的 `bloom` | JSON 的 `value` | `compile/postprocess.ts` 的 `flagValue` 取属性当前值（`q3a`、`q3b` 两种工程会判反） |
| HDR 判定的 `hdr` | JSON 的 `value`（静态确认，没有跑） | 同上；待定 2 已定改值即重编译，这条与 WPE 的差异是已知的，但加载时的取值来源也不同 |
| 计划风险 1 | 判定不看脚本写入 | 计划写「`thisScene.bloom = true` 重编译后会判成 HDR」；若判定只读 JSON，这条风险随之消失。计划点 5 让 `bloom-enabled` 走 `scriptOverrides` 的 `general/bloom`，要确认这条路不进 HDR 判定 |
| 计划风险 2 | 判定不看属性 | 同上，「就地关泛光后再重编译会判成 LDR」随之消失 |
| `thisScene.hdr` | 场景位，`ctl-nobloom` 读 true 而渲染是 LDR | `script/api.ts` 读 `general.postprocess.hdr`（生效值）。计划只改 `bloom`，`hdr` 写着「不动」 |
| `init` 里的 `thisScene.bloom` | JSON 的 `value` | 待核对 |
| 脚本写级数 | 同一帧画出来 | 计划点 4 的 `setParams` 要赶在这一帧 `encode` 之前 |
| 运行中打开没有链的场景 | 同帧、不编译 | 计划走整场重编译，已知差异（`bloomMissing`） |

计划里其余假设都与实测相符：`bloom` 下一帧生效不重载、HDR 位运行中不变、级数下一帧生效、改 N 无残留、`thisScene.bloom` 读场景位。

### K8. 工程（用于导入 Kabegame 对比）

全部在 `ignore/p3c/wpe-bloom/`，`python -X utf8 -I gen.py` 重新生成（会删掉工程里的 `shaders/` 缓存）。WPE 打开工程后会往工程目录写 `shaders/blobsSM40/`。

**共同版面**（场景坐标 1920×1080，y 朝上，`clearcolor` 全黑、`camerafade: false`）：

| 层 | 位置 / 尺寸 | 内容 |
|---|---|---|
| `GLOW` | (400, 720)，120×120 | 白，`brightness` 4 |
| `HDRP` | (1100, 980)，80×80 | 颜色 0.6，`brightness` 0.5 |
| `K` | (1100, 500)，80×80 | 红 0.5，alpha 绑 `p_alpha` 或脚本 |
| `K1` | (1100, 640)，80×80 | 蓝 0.5，脚本（只有两个同步工程有） |
| `MON` | (1500, 900)，100×100 | 灰 0.2，记录脚本 |
| `S` | (1500, 760)，100×100 | 灰 0.2，被测脚本（只有 `q5-*` 有） |

**判读点**（`layout.py`）：`block` (400, 720)、`hdrp` (1100, 980)、`k` (1100, 500)、`k1` (1100, 640)、`bg` (1250, 1040)，`dN` = (460 + N, 720)，N = 10、20、40、80、160、320、640。

**泛光参数**：`bloomstrength` 2、`bloomthreshold` 0.65、`bloomhdrstrength` 2（标 ★ 的工程是 0.5）、`bloomhdrthreshold` 1、`bloomhdrfeather` 0.1、`bloomhdrscatter` 1.619、`bloomhdriterations` 8。

| 目录 | `general.bloom` | `hdr` | 属性（默认值） | 用途 |
|---|---|---|---|---|
| `ctl-ldr` | `true` | false | `p_alpha`（1） | 字面量对照 |
| `ctl-hdr` | `true` | true | `p_alpha`（1） | 字面量对照 |
| `ctl-nobloom` | `false` | true | `p_alpha`（1） | 字面量对照 |
| `q1-ldr` | `{user: p_bloom, value: true}` | false | `p_bloom`（true）、`p_alpha`（1） | Q1 |
| `q2-hdr` | `{user: p_bloom, value: true}` | true | `p_bloom`（true）、`p_alpha`（1） | Q2 |
| `q3a-jT-pF` | `{user: p_bloom, value: true}` | true | `p_bloom`（**false**）、`p_alpha`（1） | Q3 |
| `q3b-jF-pT` | `{user: p_bloom, value: false}` | true | `p_bloom`（**true**）、`p_alpha`（1） | Q3 |
| `q3c-jT-pT` | `{user: p_bloom, value: true}` | true | `p_bloom`（true）、`p_alpha`（1） | Q3 对照 |
| `q3d-jF-pF` | `{user: p_bloom, value: false}` | true | `p_bloom`（false）、`p_alpha`（1） | Q3 对照 |
| `q4-iter` ★ | `true`，`bloomhdriterations: {user: p_iter, value: 8}` | true | `p_iter`（8，滑块 1–8）、`p_alpha`（1） | Q4 |
| `q4-n8` ★ | `true`，`bloomhdriterations: 8` | true | `p_alpha`（1） | Q4 基准 |
| `q4-n3` ★ | `true`，`bloomhdriterations: 3` | true | `p_alpha`（1） | Q4 基准 |
| `q5-ldr` | `false` | false | `p_alpha`（1） | Q5，脚本按帧写 `bloom`（50、100、150、200 帧） |
| `q5-hdr` ★ | `true` | true | `p_alpha`（1） | Q5，50、100 帧写级数，150、200 帧写 `bloom` |
| `q5-sync` | `false` | false | `p_noop`（0.5） | Q5 同帧，60–460 帧 |
| `q5-sync-iter` ★ | `true` | true | `p_noop`（0.5） | Q5 同帧（级数），60–460 帧 |

**各状态的完整读数**在 `out/summary.json`（RGB 三通道，每点 5×5 窗口像素平均），代表帧是 `out/state-*.png`。

**比较时注意**：
- 这些读数对应 960×540 的渲染尺寸（**推断**：LDR 辉光约 50 px 的范围是窗口像素，泛光 RT 按场景 RT 尺寸算，见 A1）。Kabegame 按其它尺寸渲染时，辉光距离与数值都不能直接比，要么渲染到同一尺寸，要么只比 `hdrp`、有无辉光和切换行为。
- 同 N 相等、开关前后相等这类**自比较**不受尺寸影响，可以直接用。
- 属性切换的工程：`q1-ldr`、`q2-hdr`、`q3*` 用 `p_bloom`，`q4-iter` 用 `p_iter`。

### K9. 未查清与局限

- **RenderDoc 没用上**（见实验条件）：运行中走的 combine、金字塔实际跑几级、`combine_srgb` 分支，都只有读数与静态依据。
- **`thisScene.bloom` 不含档位**：ultra 下分不出，只有静态依据，要用 disabled 档跑才能实测，这轮不能改设置。
- **用户保存在 `config.json` 里的属性值**没有测，见 K3。
- **`general.hdr` 写成 `{user}`** 只有静态结论，这轮没有构造工程。
- **HDR 归一化公式**没有独立的数值验证，见 K4。
- **`fps=10` 下**只能看出超过 1 ms 量级的影响，高帧率下切换开销没有测。
- **窗口 x 方向多出的 9 px** 和 PrintWindow 这轮变快的原因都没查，都不影响判读。
- **displayhdr 档**没有测，真 HDR 显示器的情况也没有测。

### K10. 产物与恢复

实验目录 `ignore/p3c/wpe-bloom/`（`ignore/` 不入库）：
- `gen.py` 生成全部工程；`base-kbprops-test/` 拷自 `ignore/p3c/wpe-sync/`；`wpe.py`、`sampler_pw.py` 同样拷来，`wpe-sync/` 没有改动。
- `sampler.py`（存整帧）、`layout.py`（坐标与判读点）、`run.py`（开窗并保证关窗）、`smoke.py`（标定）。
- `exp_toggle.py`（Q1、Q2）、`exp_q3.py`、`exp_q4.py`、`exp_q5.py`；`ana_toggle.py`、`ana_q4.py`、`ana_q5.py`、`summary.py` 判读。
- `out/`：采样数据（共约 234 MB，可重新生成）、每轮日志、`summary.json`、`state-*.png`。
- `backup/`：开工前的 `config.json` 与 `log.txt` 行数。

重复运行：`python -X utf8 -I exp_toggle.py q1-ldr 24`，`exp_toggle.py q2-hdr 24`，`exp_q3.py`，`exp_q4.py 6`，`exp_q5.py q5-ldr 25`、`q5-hdr 24`、`q5-sync 50`、`q5-sync-iter 50`。`smoke.py ctl-ldr ctl-hdr ctl-nobloom` 产出 `summary.py` 用的对照帧。需要主实例在跑，`wpe.py` 的 `MAIN_PID` 要与当前进程一致。

恢复情况：

| 项 | 开工前 | 结束时 |
|---|---|---|
| WPE 主进程 | PID 36548，2026/11/04 2:32:57 启动 | 同一进程，没有重启 |
| WPE 档位 | `ultra`（用户改的） | **仍是 `ultra`，等用户改回 `disabled`**；`fps` 仍是 10 |
| 测试窗口 | — | 全部已关，按标题前缀 `KBB` 查询不存在 |
| `log.txt` | 552 行 | 737 行，新增 185 行全是 `[kbb]` |
| `config.json` | 哈希 `2cc84151…` | **我没有写过，但被界面操作改过两个键**，见下 |
| REA | — | 只读分析副本，会话已关闭，没有新快照 |

**`config.json` 在实验尾段被 WPE 界面操作改过，不是实验造成的**。与开工前的备份比，最终差两行：
- `wallpaperconfig.selectedwallpapers.Monitor0.file`（第 327 行）：10:08:41 工坊 3451555874 → 2896608544，10:10:13 → 3643916956，10:11:20 → 3810092560；
- 第 72 行浏览界面的排序：`name` → `subscriptiondate`。

依据：
- 10:10:13 与 10:11:20 两次发生时，我的窗口都已关闭，也没有发任何 WPE 命令；
- 排序方式只能来自界面操作；
- 我的命令从不涉及 `Monitor0` 或这几个工坊 ID。只有 10:08:41 那次与我最后一轮开窗在同一秒，来源没有直接证据，现象上与后两次相同；
- 之前 20 多次开窗后哈希都没有变（10:06 之后核对过一次仍是 `2cc84151…`）。

这两个键我没有动，也没有恢复。全部实验数据都在这之前或不受影响：最后一轮 `q5-ldr` 的读数与第一轮相同。`postprocessing` 与 `fps` 没有变。

## L. 清屏、环境光与相机（2026-11-06）

对象不变（`wallpaper64.exe` SHA-256 前缀 `40e2ce02`，`scenescript64.dll` 前缀 `58039ef9`，`bin\` 与 `distribution\bin\` 两份相同）。目的：Phase 3c 步骤 4 要把这些属性改成就地生效，之前的 I3 只有「只改字段」的笼统结论，相机一条是推断。

L1–L8 是静态分析（REA 快照 `wallpaper64-2.8.42-p3-userprops-dyn.rea-snapshot` 配合 `llvm-objdump`，并只读了 `assets/shaders`），没有运行 WPE。**置信度**沿用 I、J 节：静态确认 / 实测 / 推断 / 未查清。

记号：`G` = `*R`（general 结构），`ctx` = `R+0x10` = `G+0xd8`。之前写的 `R+0x35c`、`R+0x368` 实际都在 `G` 上。

**一句话结论**：
- **`camera` 绑不了属性。** 加载时硬读字符串，写成对象就跳过。正交且没有 `paths` 时，加载末尾把三个值重置成默认值，JSON 的值被丢弃。
- **`clearenabled: false` 是颜色和深度都不清**，没有别的地方清主目标。
- **`clearcolor` 与 `clearenabled` 在脚本之后每帧读**，脚本写入同帧生效。
- **`g_LightAmbientColor` / `g_LightSkylightColor` 就是原值**，没有转换，灯光图层不覆盖。脚本写入也走改值回调。
- **`g_EyePosition` 不是 JSON 的 `eye`**，正交场景里是 `(W/2, H/2, 2000)`。

### L1. general 属性全表

**静态确认：47 项，没有 `eye` / `center` / `up`。** `FUN_14015a000` 调用 47 次，逐项列出。`+0x58` 未赋值的项由该函数清零，即无回调。

| 属性 | 偏移 / 位 | 类型 | `+0x58` 回调 |
|---|---|---|---|
| `bloom` / `hdr` | `+0xe0` bit1 / bit10 | bool | 无 |
| `bloomstrength` `bloomthreshold` `bloomhdrstrength` `bloomhdrthreshold` `bloomhdrfeather` `bloomhdrscatter` | `0x3bc`…`0x3d0`（步长 4） | float | `LAB_1401863e0` |
| `bloomhdriterations` / `bloomtint` | `0x3d4` / `0x3d8` | int / vec3 | `LAB_1401863e0` |
| `clearenabled` | `+0xe0` bit5 | bool | 无 |
| `clearcolor` | `0x35c` | vec3 | 无 |
| `ambientcolor` / `skylightcolor` | `0x368` / `0x374` | vec3 | `LAB_1401863f0` |
| `fogdistance` / `fogheight` | `+0xe0` bit14 / bit15 | bool | `FUN_140186440` |
| `fogdistancecolor` / `fogheightcolor` | `0x380` / `0x38c` | vec3 | `FUN_140186440` |
| `fogdistancestart` `fogdistanceend` `fogdistancestartdensity` `fogdistanceenddensity` `fogheightstart` `fogheightend` `fogheightstartdensity` `fogheightenddensity` | `0x398`…`0x3b4` | float | `FUN_140186440` |
| `fov` / `perspectiveoverridefov` | `0x140` / `0x144` | float | 无 |
| `nearz` / `farz` / `zoom` | `0x14c` / `0x150` / `0x154` | float | 无 |
| `camerafade` | `+0xe0` bit2 | bool | 无 |
| `transparentsorting` / `customsortorder` | `+0xe0` bit12 / bit13 | bool | 无 |
| `camerashake` | `+0xe0` bit7 | bool | 无 |
| `camerashakespeed` / `amplitude` / `roughness` | `0x328` / `0x32c` / `0x330` | float | 无 |
| `cameraparallax` | `+0xe0` bit8 | bool | 无 |
| `cameraparallaxamount` / `delay` / `mouseinfluence` | `0x334` / `0x338` / `0x33c` | float | 无 |
| `gravitydirection` / `gravitystrength` | `0x3e4` / `0x3f0` | vec3 / float | 无 |
| `windenabled` | `+0xe0` bit16 | bool | 无 |
| `winddirection` / `windstrength` | `0x3f4` / `0x400` | vec3 / float | 无 |

- 不走描述符、由 `FUN_140186c90` 直接读的键：`orthogonalprojection`（`auto` / `width` / `height`）、`refreshdelay`、`norecompile`、`spritesheetrefreshsync`、`lightconfig`。
- `+0xe0` bit3 = 正交，bit4 = 正交 `auto`。
- 构造默认值：`fov` 50，`perspectiveoverridefov` 95，`nearz` 0.1，`farz` 10000，`zoom` 1。`clearcolor`、`ambientcolor`、`skylightcolor` 全 0。

### L2. 相机

**不能绑属性（静态确认）：**
- 解析在 `FUN_140186c90`：取 `camera` 在 `0x140187426`，`eye` 在 `0x14018821c`，`center` 在 `0x140188323`。写进基准字段 `G+0x118` / `+0x124` / `+0x130`。
- 类型不是字符串（tag 4）就跳过，保留默认值（`eye` 2,2,2；`center` 0,0,0；`up` 0,1,0）。不取 `value`，不建绑定，不断言。`camera` 本身不是对象时整段跳过。
- `camera.paths` 是文件路径数组，交给 `FUN_140198e20`，每帧 Hermite 插值（`FUN_1401891a0`）。
- 运行时只有两条路：脚本 `setCameraTransforms`；相机图层（对象带 `camera` 键，`FUN_14018ff60` 建，进 `G+0x1f8`）。优先级是相机图层 > 路径 > 基准字段。相机图层的 `origin` / `angles` 走基础对象描述符，理论上能间接绑定（推断，没做实验）。

**`get/setCameraTransforms`（静态确认；同帧性未实测）：**
- DLL 的回调在 `0x1816357df` 调 `vt+0x68`，在 `0x181635e9e` 调 `vt+0x70`。对象是 `G+0x48` 接口（虚表 `0x14048ea50`），exe 实现是 `0x14018da30` 和 `0x14018da90`。
- 字段：`G+0x118`（eye）、`+0x124`（center）、`+0x130`（up）、`+0x13c`（第四个 float）。DLL 里 `eye` / `center` / `up` / `zoom` 字符串相邻（`0x1819a35b0`），所以第四个叫 `zoom` 是推断。
- 各项可空。vec3 不是合法对象、zoom 不是数字时跳过该项。没有正交判断。从全局作用域调用报 `cannot be called from global scope`。
- 读取返回基准值，不是当前值 `G+0xf0`，所以读不到路径、抖动、相机图层的结果。
- `FUN_1401891a0` 每帧开头把基准拷到当前值（`0x14018942e`），再算 `lookAt`（`FUN_14019d920`）。只有在没有活动相机图层、也没有路径时才走这条。
- 脚本在 `0x1401802e5`，晚于上面的拷贝，所以 `update` 里写入要到下一帧才进视图矩阵。

**正交场景（静态确认）：**
1. 视图：`V = lookAt(eye, center, up)`，右手系，写到 `*(ctx+0x38)`。
2. 投影：`FUN_140183a70`（`0x140183e95`）调 `ortho(L, W−cropR, cropB, H−cropT, −2000, 2000)`。`W` / `H` 是 `G+0x354` / `+0x358`。`nearz` / `farz` 不参与。
3. 缩放：`FUN_14017fa70`（`0x14017fd50`）在 `P` 上绕场景中心乘 `G.zoom × G+0x114`。`zoom` 只在正交分支有读取点。
4. 合成：`FUN_1400d4200` 算 VP = P×V（`ctx+0x930`，uniform ID 0xb）和 MVP（`ctx+0x8f0`）。

`LAB_140188648`（`0x14018866b`）在加载末尾判断，正交且路径为空时强制写 `eye` = (0,0,0)、`center` = (0,0,−1)、`up` = (0,1,0)，所以 `V` 是单位阵。eagleflag 的 `-378.29 -185.706 0` 被清掉，画面不平移，与计算相符（前提是它有 `orthogonalprojection` 且没有 `paths`，这轮没有重读样本 JSON）。

**`g_EyePosition`（`ctx+0x68`）**：`lookAt` 之后才改写（`FUN_1401891a0` 末尾），值是 `(eye.x + W/2, eye.y + H/2, 2000)`，默认即 `(W/2, H/2, 2000)`，`eye.z` 被丢弃。

**`center` / `up` 的消费者**：场景代码段 `0x140170000–0x1401a4000` 内只有 `lookAt`（`0x140189d04` / `0x140189cf6`），`center` 另被 `camerashake`（`FUN_140199580`）改写。范围外没有逐一排查。`eye.xy` 还是视差中心（`0x140189c18` / `0x140189c24`）。

### L3. `clearenabled` 为 false

**静态确认：**
- `FUN_140183550` 在 `0x14018359d` 调 `clear(color=1, depth=1)`，实现是 `0x14009b160`。关掉时颜色和深度都不清，共用这一个开关。模板没有单独清除。
- 全部 `ClearRenderTargetView` 只有三处：`0x14005a51e`、`0x14005e84a`（初始化 / 重建）和 `0x14009b191`（设备清屏实现）。每帧路径上其余清屏点都不碰主目标（反射 RT、阴影图集、效果 FBO）。
- 绘制目标：开 MSAA 时画进 `_rt_FullFrameBufferMultiSampled`（`R[0x620]`），画完 resolve 到后备缓冲；无 MSAA 时直接画进后备缓冲。`_rt_FullFrameBuffer`（`R[0x613]`）始终是拷出来的快照。本机 `config.json` 的 `msaa` 是 `none`。
- 交换链：`FUN_14012ac60` 的 `CreateSwapChainForHwnd`，`SwapEffect=3`（FLIP_SEQUENTIAL），`BufferCount=2`，`AlphaMode=3`（IGNORE），`Flags=0x800`。
- 泛光开着时：画场景 → 快照到 `_rt_FullFrameBuffer` → `FUN_140183610` → combine 材质 `R[0x62a]` 写回当前默认目标（后备缓冲）。

**推断（未实测）：**
- 无 MSAA 时 flip 模型保留缓冲内容，但两张缓冲交替，手上这张多半是 N−2 帧的成品，不是严格的上一帧。开 MSAA 时是同一张纹理，上一帧的颜色和深度都留着。
- 无 MSAA 时下一轮底图已含泛光；MSAA 时不含。
- 设备清屏色是共享状态，效果 FBO 也会改（如 `0x1401ee49a`）。带反射的场景里，这个共享状态可能影响主 clear。

**清屏色的来源（静态确认，模式含义为推断）**：`FUN_14017fa70` 在帧首判断 `(R+0x124 & ~2) == 0`。`alignment` 为 0 或 2 时用 `G.clearcolor`，否则用 `R+0x31b0`，即 `schemecolor.value`（`FUN_140181f30`，`0x140182311`，无转换，默认 0）。从 `FUN_140183a70` 看，1 / 3 / 4 是可能露底的对齐方式（推断）。alpha 恒为 1.0。

### L4. `clearcolor` 的读取时机

**静态确认（同帧未实测）：每帧读 `G+0x35c`，无缓存。** 一帧的顺序：

| 顺序 | 动作 | 地址 |
|---|---|---|
| 1 | 选清屏色指针 | `0x14017fc4c` |
| 2 | 相机更新 `FUN_1401891a0` | |
| 3 | 投影 `FUN_140183a70` | |
| 4 | 脚本 `FUN_140171440` | `0x1401802e5` |
| 5 | 解引用颜色 | `0x14018033a–34d` |
| 6 | `setClearColor` | `0x140180351` |
| 7 | 反射 pass（有才走） | |
| 8 | `FUN_140183550` 读 `clearenabled` 并清屏 | `0x1401835a7` |

`clearcolor` 与 `clearenabled` 都在脚本之后读，所以同帧生效。相机、`fov`、`zoom` 都在脚本之前算，所以脚本写入晚一帧。

### L5. `g_LightAmbientColor` / `g_LightSkylightColor`

**静态确认：就是回调拷进去的那份，全程无转换，灯光图层不覆盖。**
- ID `0x60` 和 `0x61`（注册在 `0x140003daf` / `0x140003dcf`）。`FUN_1400d8300` 读 `ctx+0x1298` / `ctx+0x12a4`，原样写 vec3。
- 写入点只有三处：初始化清零 `0x14017ce44`、加载时内联拷贝 `0x140187e43`、回调 `LAB_1401863f0`。回调每次两个都拷。读取点只有 `FUN_1400d8300` 这一处（`0x1400d9b82` / `0x1400d9ba8`）。
- `FUN_1401a4230` 只解析 `"r g b"`，单个数字铺满三分量。
- 着色器里：`ambient * color` 在 `genericimage2/3/4.frag` 和两个粒子 frag 的 `#if LIGHTING` 里，`genericimage2` 另带 `max(0.001, …)` 下限；`mix(sky, ambient, n.y*0.5+0.5)` 在 `generic*.vert` 与 `model_vertex_v1.h`；skylight 只出现在这个顶点半球混合里。
- 灯光图层：`FUN_140190c80` 单独打包灯光数组，不碰这两个值。两者在着色器里叠加：LDR 是 `ambient + light`，HDR 是 `saturate(ambient + light) + overbright`。没有 `LIGHTING` combo 的材质不受影响。

### L6. 脚本写入与改值回调

**静态确认（K5 只实测过 bloom，ambient 未实测）：脚本写 `ambientcolor` 会同步执行回调，同帧进渲染上下文。**
1. DLL `FUN_181620e10` 的类型 2 分支（`0x181621046`）：对象要 `x` / `y` / `z` 全是数字，否则放弃写入；单个数字铺满三分量。
2. 跳到 `0x18162144f`，`call [rsi+0x18]`，其中 `rsi = 描述符+0x30`，即调用 `+0x48`。
3. exe 的 `0x1401a4530` 写完字段，执行 `mov rax,[rdx+0x28]`，非空就 `jmp rax`，即尾调用 `+0x58`，`rcx` 仍是 `G`。

float 版 `0x1401a49f0`、bool 版如 `0x14019baf0` 结构相同。所以 `fog*`、`bloom*` 的脚本写入也走回调，`clearcolor` 没有回调但在渲染前读取。

### L7. 更正与补充（旧文字未改）

- **p2 A4**「编辑器状态下改用 `R+0x31b0`」不对：切换条件是 `alignment`，值是 `schemecolor`（L3）。
- **I3**「相机 `fov`、`zoom`、`nearz` 等」成立，但 `eye` / `center` / `up` 不在其中：它们不是描述符，绑不了（L1、L2）。
- **PLAN** 相机一条的「LWE 的 `ortho·translate(eye)` 与 `lookAt` 恰好抵消」是 LWE 的做法；WPE 是加载末尾把三个值重置，视图为单位阵（L2）。结果相同，原因不同。
- **`g_EyePosition`**：p2 I4 只写了 `ctx+0x68`，取值见 L2。

### L8. 未查清

- 无 MSAA 且不清屏时的实际画面（N−2 帧的判断）没有运行验证。
- 每帧 Present 路径上有没有 Discard 类调用，没有专门排查。
- 相机图层属性绑定是否如推断一样可用，没做实验。
- `perspectiveoverridefov` 在正交场景里的下游消费者（`R+0x120`）没有追完。

### L9. 实验条件（2026-11-06，步骤 4.0）

L9 起是运行 WPE 的实验，验证 L1–L8 的静态结论，只测 WPE，没有碰 Kabegame。工程和脚本在 `ignore/p3c/wpe-general/`，版面与判读点见 L17。

**一句话结论**：
- **`clearenabled: false` 残留的是 N−2，不是上一帧。** 两张后备缓冲各走各的链，第 N 帧只含 N、N−2、N−4……（L11）
- **初始底色是黑**，不是 `clearcolor`，`clearcolor` 全程不出现。
- **缺键时的调节项不是 0**：`camerashakespeed` 3、`camerashakeamplitude` 0.5、`camerashakeroughness` 1、`cameraparallaxamount` 0.5、`cameraparallaxdelay` 0.1、`cameraparallaxmouseinfluence` 0.5（L14）。
- `clearcolor`、`clearenabled`、`ambientcolor`、`skylightcolor` 属性改值都是下一帧生效、不重载；脚本写入都是同帧生效；数字铺满三分量；读到的是原值。
- `g_EyePosition` 是 `(W/2, H/2, 2000)`，`eye` 非零或写成 `{user}` 都不影响，图层不平移。
- **样本里顶层 `camera.paths` 在正交场景 0 张，`[gs]etCameraTransforms` 0 处，但有 7 张正交场景用相机图层**（L15），这条路没有实验。
- **开泛光时底图含不含泛光没有测到**：这轮档位是 `disabled`（见下）。

**实验条件**（数字都在这个条件下得到）：
- 窗口在用户的 WPE 主进程里（`-playInWindow`，960×540，名字前缀 `KBG`），PID 36548，2026/11/04 2:32:57 启动。对象版本不变。`fps=10`，帧间隔实测 100 ms（改值前后 12 帧的均值 99.6–100.9，最大 105）。`msaa=none`。
- **`postprocessing` 是 `disabled`，不是 K 节的 `ultra`。** 开工前 `config.json` 就是这个值（K10 记着等用户改回），这轮不能改。实测确认运行中也是关闭档：字面量 `bloom: true` 的 `ctl-bloom` 里 `d10`…`d640` 全 0（K1 的 `ultra` 下 `d10` 是 54.2）。所以 HDR 和泛光相关的都没有测到，其余结论也都是 `disabled` 档下的。
- 画面采样同 K 节：`PrintWindow(PW_RENDERFULLCONTENT)`，23–24 次 / 秒，存整帧，每帧约 2.4 个样本。遮挡不影响。
- **窗口坐标**：窗口图 = 场景 × (960 / W) + (11, 45)，y 轴朝上。1920×1080 时与 K 节相同。
- **帧号**：这轮比 K 节多一个判读量。`FR` 块的颜色由脚本写成帧号（R = 低 8 位，G = 高 8 位，B = 1），每个样本都能读出它是第几帧，不再靠时间对齐。`K0` / `K1` 对照仍然照做。不改值的工程帧号逐帧连续（`q2-false` 339 帧 0 缺失）。个别帧缺样本，集中在 `applyProperties` 那一刻，原因应是起进程占用（推断），不影响判读：改值类实验共缺 3–5 帧。
- **读数取整**：`0.5` 读 127，`0.1` 读 25，`0.3` 读 76，`0.25` 读 64，`0.75` 读 191。`.5` 往下取，其余就近，所以与 Kabegame 比较时留 ±1。原因未查。
- `MON` 脚本同 K 节：`applyUserProperties` 时记 `mark frame`，`init` 计数。**下文「mark+1」指在 `mark` 那一帧之后的第一帧看到新值。**
- 改值是一条 `applyProperties` 同时改被测属性和 `p_alpha`。工程按「共同版面」给 `K` 垫了黑底，读数不受清屏色和残留影响。

### L10. Q1：`clearcolor` 绑属性

**实测：下一帧生效，不重载，读到原值，单个数字铺满三分量。**

| 工程 | 绑定 | 发 / 测到 | 变化帧与 K 同帧 | 变化帧 − mark | `init` | `.dxs` | 帧间隔最大 |
|---|---|---|---|---|---|---|---|
| `q1-clear` | `{user: p_clear, value: "0 0 0"}`，`color` | 24 / 22 | **22 / 22** | **全是 1** | 1 次 | 5 → 5 | 105 ms |
| `q1-clear-num` | `{user: p_clearn, value: 0.25}`，`slider` | 24 / 22 | **22 / 22** | **全是 1** | 1 次 | 5 → 5 | 103 ms |

（「发 / 测到」差的 2 次发生在采样结束之后，不是没生效。）

读数（`bg`）：

| `p_clear` | 读数 | `p_clearn` | 读数 |
|---|---|---|---|
| `0.25 0.5 0.75` | 64, 127, 191 | 0.25（加载时） | 64, 64, 64 |
| `1 0 0` | 255, 0, 0 | 0.75 | 191, 191, 191 |
| `0 0.5 0` | 0, 127, 0 | 0.5 | 127, 127, 127 |
| `0.1 0.2 0.3` | 25, 51, 76 | 0.1 | 25, 25, 25 |
| `1 1 1` | 255, 255, 255 | 1 | 255, 255, 255 |
| `0 0 0` | 0, 0, 0 | 0 | 0, 0, 0 |

一个属性值只配一种 K 状态，全程 6 种组合，没有一新一旧。没有系数和颜色空间转换。

`schemecolor`（`q1-scheme`）：属性 `schemecolor = 0.9 0.1 0.1`、`clearcolor = 0.1 0.1 0.9`，背景读 25, 25, 229，是 `clearcolor`。与 L3 一致（`-playInWindow` 下走 `G.clearcolor` 这一支）。`alignment` 不为 0 的情形没有测。

### L11. Q2：`clearenabled: false` 的实际画面

**实测：N−2。L3 的推断成立。**

**写法**：`false`、`{value: false}`、`{user: p_clearen, value: true}` + 属性 false 三种，画面行为完全相同。

**残留的是哪一帧**。`TRAIL` 每帧挪一格，所以第 f 帧的画面里，每一格都能看出第几帧的内容还在：

| 工程 | 帧数 | 同奇偶的历史格 | 异奇偶的历史格 | 同奇偶缺失 | 颜色与奇偶不符 | `bg` |
|---|---|---|---|---|---|---|
| `q2-false` | 339 | 28561 | **0** | **0** | 0 | 0, 0, 0 |
| `q2-value` | 119 | 3481 | **0** | **0** | 0 | 0, 0, 0 |
| `q2-user-pfalse` | 119 | 3481 | **0** | **0** | 0 | 0, 0, 0 |

（`bloom: true` 的 `q2-bloom-ldr`、`q2-bloom-hdr` 在 `disabled` 档下数字相同，这里不当泛光结论用。）

第 170 帧近 16 帧的残留（左边是当前帧，`#` = 在）：`#.#.#.#.#.#.#.#.`。

**第二个独立判据**：白 alpha 0.1 的 `ACC` 逐帧累加，读数成对上升：

| 帧 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `acc` | 25 | 25 | 48 | 48 | 68 | 68 | 86 | 86 | 103 | 103 | 118 | 118 |

第 3 帧压在第 1 帧上（25 → 48），第 4 帧压在第 2 帧上。两个判据都说明：**第 N 帧的底图是第 N−2 帧的成品，两条链不相交。** 这两张缓冲之间没有复制。屏幕上是两条链逐帧交替，半透明累加的速度是「保留上一帧」的一半。

**加载后第一批帧**：
- 从窗口出现就开始采样，头 2 个样本整窗纯黑（还没有帧），第 3 个样本起是第 1 帧，距开始 0.08–0.11 s。第 1 帧之前的帧不存在，没有漏。
- **背景从第 1 帧起一直是 0, 0, 0。** `clearcolor` 是 `0.1 0.2 0.3`（清屏时读 25, 51, 76），全程 339 帧一次都没出现。两条链的初始内容都是黑（奇偶帧都读 0）。
- `q2-user-pfalse` 的 JSON `value` 是 true、属性是 false：`init` 读到 `true`（K3 的顺序），第 5 帧读到 `false`，而第 1 帧的背景已经是黑、`ACC` 与其余工程相同。所以**第一帧渲染前属性就已生效**，不存在一帧清屏。

**运行中切换**（`q2-user`，6 轮共 12 次，`init` 1 次，`.dxs` 5 → 5，采样覆盖第 9–521 帧）：

| 项 | 结果 |
|---|---|
| K 翻转帧 − mark | **12 / 12 都是 1** |
| true → false 的那一帧 | 6 / 6 带两块，偏移 {0, 2}：当帧就接上了 N−2 的底图 |
| false → true 的那一帧 | 6 / 6 只剩 1 块，下一帧就干净 |
| true 的帧 | 213 帧全是 1 块，没有一帧多于 1 块 |
| `bg` | 全程 25, 51, 76，切换时没有闪黑，也不变化 |

- 切到 false：不闪、不跳，已有内容保留。切换前两张缓冲都是干净的完整帧，所以静态内容不变，之后才开始两条链各自累加（`acc` 从 48 → 68 → 86…）。
- 切回 true：`acc` 下一帧回到 48，累积内容一次清掉。

**泛光**：**没有测到**，`disabled` 档下 `q2-bloom-ldr` / `q2-bloom-hdr` / `q2-bloom-ctl` 的 `d10`…`d640` 全 0。L3 的「无 MSAA 时下一轮底图已含泛光」仍是推断。工程和判读脚本都已备好，档位改成 `ultra` 后运行 `python -X utf8 -I exp.py q2bloom`、`python -X utf8 -I ana_q2bloom.py q2-bloom-ctl q2-bloom-ldr q2-bloom-hdr` 即可（版面与 K 节的 `GLOW`、`dN` 相同）。

### L12. Q3：环境光

**实测：读到原值，没有系数和颜色空间转换；运行中下一帧生效，不重载；单个数字铺满三分量。**

自定义着色器 `AMB`、`SKY` 在顶点里读 uniform 经 varying 输出，`AMBF` 在片元里直接读，全程 `AMB` = `AMBF`。

| 工程 | 发 / 测到 | 变化帧与 K 同帧 | 变化帧 − mark | `init` | `.dxs` | 帧间隔最大 |
|---|---|---|---|---|---|---|
| `q3-light`（`color`） | 24 / 22 | **22 / 22** | **全是 1** | 1 次 | 8 → 8 | 103 ms |
| `q3-light-num`（`slider`） | 18 / 17 | **17 / 17** | **全是 1** | 1 次 | 8 → 8 | 105 ms |

| `ambientcolor` | `AMB` / `AMBF` | `skylightcolor` | `SKY` |
|---|---|---|---|
| `0.2 0.4 0.6`（加载） | 51, 102, 153 | `0.6 0.4 0.2`（加载） | 153, 102, 51 |
| `0.25 0.5 0.75` | 64, 127, 191 | `0.75 0.5 0.25` | 191, 127, 64 |
| `1 0 0` | 255, 0, 0 | `0 1 0` | 0, 255, 0 |
| `0.1 0.2 0.3` | 25, 51, 76 | `0.4 0.6 0.8` | 102, 153, 204 |
| `0 0 0` | 0, 0, 0 | `1 1 1` | 255, 255, 255 |
| 0.25（数字） | 64, 64, 64 | 0.75（数字） | 191, 191, 191 |
| 0.5 | 127, 127, 127 | 0.1 | 25, 25, 25 |
| 0.9 | 229, 229, 229 | 0.6 | 153, 153, 153 |

`0.5` 不被 sRGB 换算（换算过会读 55 或 188）。`0 0 0` 就是 0，没有 `genericimage2` 的 `max(0.001, …)`，那个下限在该着色器里。灯光图层、`LIGHTING` combo 这轮没有测。

### L13. Q4：`g_EyePosition`

**实测：L2 成立。**探针 `EYE` 粗读（除以 `3840, 2160, 4000`），`EYELO` / `EYEHI` 拆成 8 + 8 位还原，精度约 ±1。都在顶点里读（WPE 自带着色器也在顶点读）。

| 工程 | `camera.eye` / `center` | 投影 | `EYE` 读数 | 还原值 | 图层 |
|---|---|---|---|---|---|
| `q4-eye-zero` | `0 0 0` / `0 0 -1` | 1920×1080 | 64, 64, 127 | **960, 540, 2000** | 基准 |
| `q4-eye-nz` | `-378.29 -185.706 0` / `… -1` | 1920×1080 | 64, 64, 127 | **960, 540, 2000** | 不平移 |
| `q4-eye-user` | `{user: p_eye, value: "-378.29 -185.706 0"}` | 1920×1080 | 64, 64, 127 | **960, 540, 2000** | 不平移 |
| `q4-eye-1280` | `0 0 0` / `0 0 -1` | 1280×720 | 42, 42, 127 | **640, 360, 2000** | 按比例 |

（还原值的原始数字 959.7、540.1、1999.8、639.5、360.4，这里按精度取整。）

- `q4-eye-nz` 与 `q4-eye-zero` 整帧比较，**客户区逐像素相同**，差异只有 183 像素，全在标题栏文字（窗口名不同）。
- `q4-eye-user`：能加载，发 8 次 `p_eye`，`init` 1 次、`.dxs` 8 → 8；K 照常翻转（亮 65 帧、暗 56 帧）；`EYE`、`EYELO`、`EYEHI`、`MARK` 的读数全程只有一种。写成对象时 `value` 也被丢弃，符合 L2。
- 另测了 `orthogonalprojection: {auto: true}`（`q4-eye-auto`，不在问题里）：整窗纯白，`FR` 被盖住，g_EyePosition 判读不出来，脚本正常运行。没有追原因，本机 91 张正交场景没有这种写法（L15）。

### L14. Q5：脚本

**成员**：`thisScene` 61 个，47 个字段 + 14 个方法：`getLayer`、`getLayerByID`、`getLayerCount`、`enumerateLayers`、`destroyLayer`、`createLayer`、`sortLayer`、`getLayerIndex`、`getInitialLayerConfig`、`getCameraTransforms`、`setCameraTransforms`、`getAnimation`、`createModelData`、`destroyModelData`。47 个字段就是 L1 的 47 项。

**读**（实测）。`q5-nokeys` 的 `general` 只留 `orthogonalprojection`，读到的就是缺省值。`q5-keys` 写了全部键，`q5-keys-on` 另把三个 bool 打开。三个工程里 `init` 与第 5 帧读到的相同。

| 字段 | 类型 | **缺键缺省值** | `q5-keys` 写 | 读到 |
|---|---|---|---|---|
| `clearcolor` | `Vec3` | **0, 0, 0** | `0.1 0.2 0.3` | 0.10000000149011612, 0.20000000298023224, 0.30000001192092896 |
| `clearenabled` | boolean | **true** | true | true |
| `ambientcolor` | `Vec3` | **0, 0, 0** | `0.2 0.3 0.4` | 0.2…、0.3…、0.4…（float32） |
| `skylightcolor` | `Vec3` | **0, 0, 0** | `0.5 0.6 0.7` | 0.5、0.6000000238418579、0.699999988079071 |
| `fov` | number | **50** | 33 | 33 |
| `nearz` | number | **0.10000000149011612** | 0.5 | 0.5 |
| `farz` | number | **10000** | 5000 | 5000 |
| `camerafade` | boolean | **true** | false / true | false / true |
| `camerashake` | boolean | **false** | false / true | false / true |
| `camerashakespeed` | number | **3** | 1.5 | 1.5 |
| `camerashakeamplitude` | number | **0.5** | 0.25 | 0.25 |
| `camerashakeroughness` | number | **1** | 0.75 | 0.75 |
| `cameraparallax` | boolean | **false** | false / true | false / true |
| `cameraparallaxamount` | number | **0.5** | 0.4 | 0.4000000059604645 |
| `cameraparallaxdelay` | number | **0.10000000149011612** | 0.2 | 0.20000000298023224 |
| `cameraparallaxmouseinfluence` | number | **0.5** | 0.6 | 0.6000000238418579 |
| `zoom`（顺带） | number | 1 | — | — |
| `perspectiveoverridefov`（顺带） | number | 95 | — | — |
| `bloom`（顺带） | boolean | true | — | — |
| `hdr`（顺带） | boolean | false | — | — |

**全部字段都是 float32**：写 0.4 读回 0.4000000059604645，缺省的 0.1 读回 0.10000000149011612。

**写入**（`q5-write`，实测）：
- 全部 16 个字段当场读回，下一帧再读相同，类型都不变。
- `new Vec3(…)`、**单个数字**（`0.5` → 0.5, 0.5, 0.5）、**普通对象** `{x, y, z}` 都能写，读回都是 `Vec3`。
- **读到的是拷贝**：`const c = thisScene.clearcolor; c.x = 0` 之后读回不变。
- 没有写错类型的值（L6 / G4 有静态依据，这轮不做，避免风险）。
- 画面：`clearcolor`、`ambientcolor`、`skylightcolor` 在写入那一帧（f = 30、40、50）就变，读数是原值（0.1 0.2 0.3 → 25, 51, 76；0.2 0.3 0.4 → 51, 76, 102；0.5 0.6 0.7 → 127, 153, 178）。

**同帧**（照 K5：60–460 帧每 2 帧翻一次，`K0` 与写入同相，`K1` 晚一帧）：

| 工程 | 写什么 | 判读点 | 翻转期样本 | 与 K0 同相 | 与 K1 同相 | 去重后序列 | 与 K0 不同 | 与 K1 不同 | 覆盖帧 | 与 `on(f)` 不符的帧 |
|---|---|---|---|---|---|---|---|---|---|---|
| `q5-sync-clear` | `thisScene.clearcolor` | `bg` | 957 | **957** | 475 | 400 | **0** | 200 | 400 / 400 | **0** |
| `q5-sync-amb` | `thisScene.ambientcolor` | `amb`、`ambf` | 947 | **947** | 472 | 400 | **0** | 200 | 400 / 400 | **0** |
| `q5-sync-amb` | `thisScene.skylightcolor` | `sky` | 947 | **947** | 472 | 400 | **0** | 200 | 400 / 400 | **0** |

对照证明这个采样看得出一帧之差。`on(f)` 一列是直接按 `FR` 读出的帧号比，比 K 节的判定更强。`fps=10` 的局限在这里影响不大：判定按帧号，和时间无关；局限只在高帧率下的开销没有测到。

`thisScene.clearenabled` 也是同帧（`q5-clearen`，帧号判定）：f = 40、120 写 false，**当帧**就带上 N−2 的块；f = 80、160 写 true，**当帧**只剩 1 块。4 / 4 次。

**`{script}` 直接挂在 general 上**（实测，本机样本里没有这种写法，见 L15）：

| 项 | 结果 |
|---|---|
| `update` 返回值 | **写回，同帧生效**。`clearcolor` 与 `ambientcolor` 都是 f = 30 起变成 255, 127, 0，f = 60 起变成 0, 127, 255 |
| 改 `value` 后返回 / 返回新 `Vec3` | 两种都写回 |
| 下一帧的 `value` | 上一次写回的值 |
| `init` 的 `value` | JSON `value`（`Vec3`） |
| 同时读 `thisScene.<键>` | 与写回值相同 |
| `clearenabled` 上挂 `{script}` | 返回 bool，同帧生效（f = 40 不清屏、f = 80 恢复），`value` 是 bool |
| `thisObject` | **object，`=== thisLayer`，`!== thisScene`**。`constructor.name` 为空，`String()` 是 `[object Object]`。48 个成员都能在 `thisScene` 上访问，没有 `name`，没有 `getLayerCount` 这类方法 |
| 经 `thisObject` 写字段 | **能写进场景**：`thisObject.skylightcolor = …` 后 `thisScene` 读回相同，`SKY` 当帧变成 229, 25, 25 |

**日志**：`console.log` 0 行，`console.error` 全部进 `log.txt`，与 K5 一致。

### L15. Q6：扫样本（只读）

范围：工坊 91 + 默认 19，共 110 个目录，场景 **99 张**，全部解析成功。其中正交 91、透视 8，`orthogonalprojection` 全是 `{width, height}`，没有 `auto`。扫描对全部字节流式进行：83 个 `scene.pkg`（6.04 GB，含 8 个 200 MB 以上的包，最大 712 MB）与 1911 个散文件。

**`camera.paths`（顶层）**：
- 正交场景：**0 张**。
- 透视场景：6 张，全是默认工程，都是 `["scripts/camera_00.json"]`：arsenal、demon_core、dna_fragment、fantasticcar、neon_sunset、ricepod。另 2 张透视（audiophile、techno）没有这个键。

**`getCameraTransforms` / `setCameraTransforms`**：**0 张、0 处**，assets 脚本里也没有。结果是 0，所以验证过扫描器：同一函数在 `scenescript64.dll` 上命中 2 处，人造文件 4 处全部找到，另用 `grep -a -i cameratransform` 独立复查全部 pkg 也是 0。字符串拼接拆开的写法扫不到。

**相机图层**（这一节在问题之外，但它决定上面两个 0 能不能说明问题）：**7 张正交场景有相机图层**（对象带 `camera` 键，值都是 `"default"`），都是工坊场景，都是 3840×2160。

| 工坊 ID | `origin` | `zoom` | `visible` | `path` 指向的文件 |
|---|---|---|---|---|
| 3326873240 | `{script}` | `{user}` | 缺 | `{"paths": []}` |
| 3351072238 | `{script}` | `{user}` | 缺 | `{"paths": []}` |
| 3354366708 | `{script}` | `{user}` | 缺 | `{"paths": []}` |
| 3400241651 | `{script}` | `{user}` | 缺 | `{"paths": []}` |
| 3470764447 | `{script}` | `{user}` | 缺 | `{"paths": []}` |
| 3524852519 | `{script}` | `{user}` | 缺 | `{"paths": []}` |
| 3554161528 | 关键帧动画 | 关键帧动画 | `{user}` | `{"paths": []}` |

- 都带 `fov: 50`、`queuemode: "random"`、`path: "scripts/camera_paths_<id>.json"`。
- 这些场景的顶层 `camera` 都是默认形态，所以按顶层键统计时看不出来。
- 除 3400241651 外的 6 张都在 Kabegame 语料里，都有大量其它 `unsupported`，目前不会实时渲染。
- **这些图层在 WPE 里实际怎么作用于正交视图、`g_EyePosition` 取什么值，没有实验**（L18）。

**其它计数**：

| 项 | 张数 |
|---|---|
| 正交场景 `eye` 或 `center` 不是默认值 | **30 / 91**，全是字符串，写成对象 0 |
| 其中 `eye.z=0, center.z=-1` / `eye.z=1, center.z=0` | 15 / 15（`center` 都等于 `eye` 减 1，朝向 −z） |
| 其中 xy 非零 | 22 |
| `clearenabled` | true 87，缺键 11，`null` 1（neon_sunset，透视），**false 0**，对象 **0** |
| `clearcolor` / `ambientcolor` / `skylightcolor` 写成对象 | **都是 0** |

eagleflag：`eye` `-378.290 -185.706 0.000`，投影 **2200×1080**（不是 1920×1080），没有 `paths`。L2 的前提成立，对应结果见 L13。

统计局限：只有本机这 99 张，不代表全部工坊。

### L16. 与 L1–L8 和计划的差异（只列事实）

**L8 里被实验解决的项**（旧文字未改）：
- 「无 MSAA 且不清屏时的实际画面（N−2 帧的判断）没有运行验证」：已验证，是 N−2（L11）。
- 「每帧 Present 路径上有没有 Discard 类调用」：静态上仍没有排查，行为上内容能跨 339 帧保留，至少在 `-playInWindow` 下不丢。

**L1–L7 被实测确认的项**：L1 的构造默认值；L2 的 `g_EyePosition`、eagleflag 前提、`{user}` 跳过；L3 的 N−2 推断；L4 的同帧（当时未实测）；L5 的原值；L6 的 ambient 同帧（当时未实测）与数字铺满。

**补充**：
- L1 没有列的 6 个调节项缺省值，见 L14。
- L2「运行时只有两条路」里的相机图层，样本里实际有 7 张（L15）。

**与计划的差异**：

| 项 | 计划 | WPE 实测 |
|---|---|---|
| 不清屏保留哪一帧 | 总体设计「保留场景目标的上一帧（`loadOp: "load"`）」；点 6 `encode` 注释「关着保留上一帧（L3），WebGPU 的 `"load"` 正好是这个语义」 | **N−2，两条不相交的链。** 单张目标 + `load` 是 N−1：移动物体的残留密度是 WPE 的 2 倍且连续，半透明累加速度是 WPE 的 2 倍，`TRAIL` 和 `ACC` 都能直接看出差别。静止不透明的画面两者没有差别 |
| 不清屏的初始底色 | 没写 | 黑，`clearcolor` 不出现。`loadOp: "load"` 的新纹理全 0，RGB 相同，alpha 为 0（WPE 的交换链 `AlphaMode=3` 忽略 alpha，L3） |
| 调节项缺省值 | 点 6 字段表写「同形」，没有给值 | 3 / 0.5 / 1 / 0.5 / 0.1 / 0.5，**都不是 0**（L14）。计划已写的 `fov`、`nearz`、`farz`、`camerafade`、`camerashake`、`clearenabled`、三个颜色都对 |
| 读回精度 | 「只存值、脚本能读回」 | 读回是 float32（0.4 → 0.4000000059604645），`Vec3` 同样 |
| 运行时改相机 | 总体设计「运行时能改相机的只有脚本的 `setCameraTransforms`」 | 样本里脚本调用 0 处；7 张正交场景用相机图层的 `origin {script}` / `zoom {user}` / 动画。这条路 WPE 的实际效果没有实验 |
| `{script}` 挂 general 时的 `thisLayer` | `script/api.ts`：`current.layer === null` 时 `thisLayer` 为 `null` | object，`=== thisObject`。`thisObject` 的形状（只有字段、写入进场景）与 `general` 对象相同 |

计划里其余假设都与实测相符：清屏色 / 环境光下一帧生效、不重载，脚本写入同帧；`{value: false}` 算 false；数字铺满三分量；`g_EyePosition` 公式；`eye` 绑不了；`{script}` 的目标可以是这些字段（WPE 返回值写回）；`thisScene` 上有这些字段。

### L17. 工程（用于导入 Kabegame 对比）

全部在 `ignore/p3c/wpe-general/`，`python -X utf8 -I gen.py` 重新生成（会删掉工程里的 `shaders/` 缓存）。全部从 `base-kbprops-test` 拷 `models/`，本地 `models/util/solidlayer.json` 绕开 Kabegame 不支持的 `model:solidlayer`，不能丢。每个工程都带全部探针着色器。

**共同版面**（场景坐标 1920×1080，y 朝上，`camerafade: false`，缺省 `ambientcolor` / `skylightcolor` 0.3）：

| 层 | 位置 / 尺寸 | 内容 |
|---|---|---|
| `TRAIL` | 第 f 帧在第 `(f−1) % 450` 格：`(80 + 40×(s%45), 60 + 40×⌊s/45⌋)`，40×40 | 奇数帧绿、偶数帧红 |
| `ACC` | (1500, 640)，100×100 | 白，alpha 0.1 |
| `GLOW` | (400, 720)，120×120 | 白，`brightness` 4（只有 `ctl-bloom`、`q2-bloom-*`） |
| `FR` | (100, 1040)，80×60 | 帧号：R = 低 8 位，G = 高 8 位，B = 1 |
| `KB` / `K` | (1100, 500)，100×100 / 80×80 | 黑底 + 红 0.5，alpha 绑 `p_alpha` 或脚本 |
| `KB1` / `K1` | (1100, 640)，100×100 / 80×80 | 黑底 + 蓝 0.5，脚本（只有同帧工程有） |
| `AMB` / `SKY` / `AMBF` | (600 / 760 / 920, 900)，120×120 | 探针，显示 `g_LightAmbientColor` / `g_LightSkylightColor` / 片元读 ambient（只有 `q3-*`、`q5-write`、`q5-sync-amb`、`q5-scr-vec`） |
| `MARK` / `EYE` / `EYELO` / `EYEHI` | (300 / 600 / 760 / 920, 900)，120×120 | 白块 + 探针（只有 `q4-*`） |
| `MON` | (1500, 900)，100×100 | 灰 0.2，记录脚本 |
| `S` | (1500, 760)，100×100 | 灰 0.2，被测脚本（只有 `q5-keys*`、`q5-nokeys`、`q5-write`、`q5-sync-*`、`q5-clearen`） |

**判读点**（`layout.py`）：`fr` (100, 1040)、`k` (1100, 500)、`k1` (1100, 640)、`bg` (1250, 1040)、`bg2` (1700, 500)、`acc` (1500, 640)、`amb` (600, 900)、`sky` (760, 900)、`ambf` (920, 900)、`mark` (300, 900)、`eye` (600, 900)、`eyelo` (760, 900)、`eyehi` (920, 900)，`dN` = (460 + N, 720)。

| 目录 | 被测写法 | 属性（默认值） | 用途 |
|---|---|---|---|
| `ctl-bloom` | `bloom: true` | `p_alpha`（1） | 确认档位 |
| `q1-clear` | `clearcolor: {user: p_clear, value: "0 0 0"}` | `p_clear`（`0 0 0`，`color`）、`p_alpha` | Q1 |
| `q1-clear-num` | `clearcolor: {user: p_clearn, value: 0.25}` | `p_clearn`（0.25，滑块）、`p_alpha` | Q1 数字 |
| `q1-scheme` | `clearcolor: "0.1 0.1 0.9"` | `schemecolor`（`0.9 0.1 0.1`） | 背景读哪个 |
| `q2-false` | `clearenabled: false`，`clearcolor: "0.1 0.2 0.3"` | `p_alpha` | Q2 |
| `q2-value` | `clearenabled: {value: false}`，同上 | `p_alpha` | Q2 |
| `q2-user` | `clearenabled: {user: p_clearen, value: true}`，同上 | `p_clearen`（true）、`p_alpha` | Q2 运行中切换 |
| `q2-user-pfalse` | 同上 | `p_clearen`（**false**）、`p_alpha` | Q2 加载 |
| `q2-bloom-ctl` | `clearenabled: true`，`bloom: true` | `p_alpha` | 泛光对照（要 `ultra`） |
| `q2-bloom-ldr` | `clearenabled: false`，`bloom: true` | `p_alpha` | 泛光累加（要 `ultra`） |
| `q2-bloom-hdr` ★ | `clearenabled: false`，`bloom: true`，`hdr: true` | `p_alpha` | 同上 |
| `q3-light` | `ambientcolor` / `skylightcolor`：`{user, value: 串}` | `p_amb`、`p_sky`（`color`）、`p_alpha` | Q3 |
| `q3-light-num` | 同上，`value` 为数字 | `p_ambn`、`p_skyn`（滑块）、`p_alpha` | Q3 数字 |
| `q4-eye-zero` | `eye: "0 0 0"` | `p_alpha` | Q4 基准 |
| `q4-eye-nz` | `eye: "-378.29 -185.706 0"`，`center: "-378.29 -185.706 -1"` | `p_alpha` | Q4 |
| `q4-eye-user` | `eye: {user: p_eye, value: "-378.29 -185.706 0"}` | `p_eye`（`color`）、`p_alpha` | Q4 |
| `q4-eye-1280` | 投影 1280×720，版面 × 2/3 | `p_alpha` | Q4 |
| `q4-eye-auto` | `orthogonalprojection: {auto: true}` | `p_alpha` | WPE 整窗白，**不用于比较** |
| `q5-keys` | 16 个字段全写，`camerafade`、`camerashake`、`cameraparallax` 为 false | `p_alpha` | Q5 读 |
| `q5-keys-on` ☆ | 同上，`camerashake`、`cameraparallax`、`camerafade` 为 true | `p_alpha` | Q5 读 |
| `q5-nokeys` | `general` 只有投影 | `p_alpha` | Q5 缺省值 |
| `q5-write` | 脚本在 30、40、50、60、70、80 帧写 | `p_alpha` | Q5 写入 |
| `q5-sync-clear` | 脚本写 `clearcolor`，60–460 帧 | `p_noop`（0.5） | Q5 同帧 |
| `q5-sync-amb` | 脚本写 `ambientcolor`、`skylightcolor`，60–460 帧 | `p_noop`（0.5） | Q5 同帧 |
| `q5-clearen` | 脚本写 `clearenabled`，40、80、120、160 帧 | `p_alpha` | Q5 同帧 |
| `q5-scr-vec` | `clearcolor`、`ambientcolor` 挂 `{script}` | `p_alpha` | Q5 `{script}` |
| `q5-scr-bool` | `clearenabled` 挂 `{script}` | `p_alpha` | Q5 `{script}` |

★ `bloomhdrstrength` 0.5。☆ Kabegame 会报 `general:camerashake` / `general:cameraparallax`，只用来读 WPE。

**各状态的完整读数**在 `out/summary.json`（末帧全部判读点、Q2 残留统计、`q2-user` 的 12 次切换），末帧图是 `out/state-*.png`。

**比较时注意**：
- **Q2 按帧号比，不按时间比**：`FR`、`TRAIL` 都是脚本按帧计数，帧率不同不影响。判据：`TRAIL` 只有同奇偶的格子有块；`acc` 序列 25, 25, 48, 48, 68, 68…（底色黑）。Kabegame 没有两条链时序列会是 25, 48, 68, 86…
- 判读点是场景坐标，按实际渲染尺寸换算。这些工程的读数不含泛光，与渲染尺寸无关（`ctl-bloom`、`q2-bloom-*` 除外）。
- 读数比较留 ±1（L9）。
- `q5-scr-*` 依赖步骤 4.1 的 `targetOf`，之前在 Kabegame 里是 `unsupported`。`q4-eye-user` 同理。
- 兼容性：6 个探针着色器用仓库的 `wpesl2wgsl.wasm` 离线翻译全部通过（`check_wgsl.mjs`）；`features.ts` 只读核对过，除 ☆ 外没有会报的键。**没有实际导入 Kabegame**（这轮约束不连）。

### L18. 未查清与局限

- **开泛光时底图含不含泛光、泛光是否逐帧累加**：LDR、HDR 都没有测到，`postprocessing` 是 `disabled`。L3 的这条仍是推断。
- **以上全部结论都在 `disabled` 档**。`ultra` 下、泛光关时是不是同一条路径，这轮分不出。
- **相机图层**：7 张样本在用（L15），WPE 实际效果没有实验。L8 这一项仍未解决。没有做是因为不在这轮的问题里，且这条路只有静态推断，主进程上跑新路径有风险（I10 有断言中止的先例），判断留给用户。
- **`msaa` 不是 `none` 的情形**没有测，不能改设置。L3 的「开 MSAA 时是上一帧」仍是推断。
- **桌面壁纸窗口**没有测：只测了 `-playInWindow`，不能动用户的壁纸。交换链参数是否完全相同没有核对。
- **深度不清**没有测：`clearenabled: false` 时颜色保留已证实，深度保留仍只有静态依据（L3），画面上没有判据。
- **反射 pass** 对共享清屏色的影响（L3）、`alignment` 不为 0 的清屏色没有测。
- **`q5-keys-on` 的画面**没有判读，只读了字段，抖动与视差的效果不在这轮。
- **用户保存在 `config.json` 的属性值**没有测，同 K9。
- **错类型写入**（给 bool 写数字、给 vec3 写字符串）没有测，避免主进程风险。
- **`q4-eye-auto` 整窗白**没有追原因。
- **`thisObject` 比 `thisScene` 字段多的第 48 个成员**：只确认它在 `thisScene` 上也能访问（`in` 为真），名字没有列出来，推断是原型上的成员。
- **读数取整的原因**（L9）没有查。
- **`fps=10`**：同帧和帧序按帧号判定不受影响；高帧率下的切换开销没有测。

### L19. 产物与恢复

实验目录 `ignore/p3c/wpe-general/`（`ignore/` 不入库）：
- `gen.py` 生成全部工程；`base-kbprops-test/`、`wpe.py`、`sampler.py`、`sampler_pw.py` 拷自 `wpe-bloom/`，`wpe-bloom/` 与 `wpe-sync/` 没有改动。
- `run.py`（开窗并保证关窗，改成轮询窗口出现，才抓得到第一帧）、`layout.py`（坐标、判读点、帧号）、`smoke.py`。
- `exp.py`：`q1`、`q1num`、`q1scheme`、`q2`、`q2value`、`q2pfalse`、`q2user`、`q2bloom`、`q3`、`q3num`、`q4`、`q4user`、`q5read`、`q5write`、`q5sync`、`q5clearen`、`q5scrvec`、`q5scrbool`。
- 判读：`ana_q2.py`、`ana_q2user.py`、`ana_step.py`、`ana_sync.py`、`ana_trailrun.py`、`ana_q4.py`、`ana_q2bloom.py`、`summary.py`。
- Q6：`scan_q6.py`（`out/q6.json`）、`check_camlayer.py`（`out/q6-camlayer.json`）。
- `check_wgsl.mjs`（探针翻译）、`final_check.py`（收尾核对）。
- `out/`：采样数据（约 93 MB，可重新生成）、每轮日志、`summary.json`、`state-*.png`。
- `backup/`：开工前的 `config.json`、哈希、`log.txt` 行数。

重复运行：`python -X utf8 -I exp.py <实验名>`，需要主实例在跑，`wpe.py` 的 `MAIN_PID` 要与当前进程一致。

恢复情况：

| 项 | 开工前 | 结束时 |
|---|---|---|
| WPE 主进程 | PID 36548，2026/11/04 2:32:57 启动 | 同一进程，没有重启 |
| WPE 档位 | **`disabled`（任务说明写的是 `ultra`）**，`fps` 10，`msaa` none | 没有改，相同 |
| `config.json` | 哈希 `aea12dd3…` | **相同** |
| `log.txt` | 752 行 | 1069 行，新增 317 行全是 `[kbg]` |
| 测试窗口 | — | 全部已关，按标题前缀 `KBG` 枚举不存在 |
| 工程缓存 | — | 最后重跑了 `gen.py`，WPE 写进工程的 `shaders/blobsSM40/` 已清除，工程是纯生成状态 |
| Kabegame | — | 没有启动或连接。`check_wgsl.mjs` 只读取仓库的 wasm |
| RenderDoc | — | 没有用 |
| 用户壁纸、工程、工坊内容 | — | 只读，没有动 |

实验中途有一次我的命令失误：多写了一个等 stdin 的 `cat`，挂住后已停掉，当时还没有发任何 WPE 命令，留下的空文件已删除。
- `thisScene` 的读取走 `+0x50`，这条没读 DLL 代码。

### L20. 补测：不清屏时的泛光（2026-11-06，`ultra`）

用户把 `postprocessing` 改成 `ultra` 后（`config.json` 23:36:20，哈希 `8e6ad19f…`）补做 L11 没测到的一项。其余条件同 L9：PID 36548，`-playInWindow`，960×540，`fps=10`，`msaa=none`。L3 与 L11 的旧文字未改。

**实测：底图含泛光，按 N−2 成对累加。** L3 的「无 MSAA 时下一轮底图已含泛光」成立。

`q2-bloom-ldr`（`clearenabled: false`，`bloom: true`，LDR）按帧号：

| 帧 | 1 | 2 | 3 | 4 | 5 | 6 | 9 | 10 | 19 | 39 |
|---|---|---|---|---|---|---|---|---|---|---|
| `d10` | 54 | 54 | 108 | 108 | 165 | 165 | 255 | 255 | 255 | 255 |
| `d40` | 19 | 19 | 37 | 37 | 57 | 57 | 111 | 111 | 255 | 255 |
| `d80` | 2 | 2 | 4 | 4 | 7 | 7 | 13 | 13 | 126 | 255 |
| `d160` | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 34 |

- 对照 `q2-bloom-ctl`（`clearenabled: true`）281 个样本只有一种读数：`d10` 54、`d40` 19、`d80` 2。
- 第一对与对照相同，之后每两帧涨一次：辉光写回后备缓冲，N+2 帧在它上面再画一层，快照再从这张底图算泛光。
- LDR 不收敛：11.9 s 时 `d640` 已是 255，`bg` 涨到 149。

`q2-bloom-hdr` 的帧号块被辉光盖住，读数不能用（读成 4114…），下面按采样时间：

| 距开始 | 0.12 s | 0.25 s | 0.46 s | 0.67 s | 0.88 s | 2.09 s | 6.49 s | 11.88 s |
|---|---|---|---|---|---|---|---|---|
| `d10` | 116 | 163 | 215 | 249 | 255 | 255 | 255 | 255 |
| `d40` | 65 | 79 | 87 | 92 | 95 | 103 | 107 | 109 |
| `d80` | 38 | 44 | 46 | 47 | 47 | 48 | 48 | 48 |
| `d160` | 19 | 21 | 21 | 22 | 22 | 22 | 22 | 22 |

HDR 也累加，但趋于收敛，`bg` 停在 2–3。没有逐帧帧号，成对关系只从 LDR 看到，HDR 是同一路径（推断）。

**重复运行**：`python -X utf8 -I exp.py q2bloom`，`python -X utf8 -I ana_q2bloom.py q2-bloom-ctl q2-bloom-ldr q2-bloom-hdr`。HDR 的按时间判读没有存成脚本。

测试窗口已关，主实例仍是 PID 36548。`config.json` 这一轮没有写过。

### L21. HDR 不清屏：底图是线性值（2026-11-07，`ultra`）

步骤 5 验收时发现 Kabegame 的 HDR 不清屏不收敛，补这一节。L20 的 HDR 判读是 960×540、按时间，这里对齐 1920×1080、按帧。L3、L11、L20 的旧文字未改。

**条件**：PID 36548，`ultra`，`fps=10`，`msaa=none`，`-playInWindow`，客户区 1920×1080，`PrintWindow`，画面变了才留，10 fps 下每帧一张（`ignore/p3c/step4/accept/w1080.py`）。读数是 G 通道、5×5 平均。HDR 工程的 `FR` 块带辉光，帧号读不准，这里取 `TRAIL` 最新那一格。没有用 RenderDoc，后备缓冲里的值没有直接读过，下面的「存的是什么」来自着色器源码和读数吻合。

**结论**：HDR 下半透明累加走 `x' = lin(0.9x + 0.1)`，`x` 是后备缓冲里存的线性值，显示的是 `encode(x')`。LDR 的 `x' = 0.9x + 0.1` 不适用。

**依据**：
- 有泛光：`assets/shaders/combine_hdr.frag`，非 `LINEAR` 分支写 `saturate(lin(albedo)) * g_RenderVar0.x`，`lin` 是 sRGB → 线性。
- 没有泛光：`assets/shaders/passthroughsrgb.frag`，`albedo.rgb = lin(albedo.rgb)`，不 saturate。走这条路的静态依据在 `p2-REPORT.md` 第 141 行（`combine_srgb`）。
- 两条都把 `lin` 之后的值写进 RGBA16F 后备缓冲。清屏时这个值下一帧就没了，所以单帧看不出来；`clearenabled: false` 时它是 N−2 的底图，图层在 gamma 空间混合到线性值上，再 `lin` 一次。

**`ACC`（白，alpha 0.1）**，模型从 `x = 0` 起，每步是同一条链的一次：

| 步 | 帧 | 模型 `encode(x')` | WPE `q2-bloom-hdr` |
|---|---|---|---|
| 1 | 1、2 | 25.5 | 25、25 |
| 2 | 3、4 | 27.8 | 28、28 |
| 3 | 5、6 | 28.1 | 28、28 |
| 4 起 | 7… | 28.2 | 28，到第 139 帧不变 |

没有泛光的 `q2-hdr-nobloom`（`hdr: true`、`bloom` 绑属性且属性 false）收敛到同一个 28，第 2 帧 25、第 3 帧起 28，88 帧（第 2–89 帧，第 1 帧没有样本）。所以这一条和泛光无关。

**`q2-bloom-hdr` 的辉光**，按帧：

| 帧 | `d10` | `d40` | `d80` | `d160` | `d320` | `d640` | `bg` |
|---|---|---|---|---|---|---|---|
| 1 | 182.6 | 95.6 | 52.4 | 23.0 | 7 | 1 | 0 |
| 3 | 255 | 127.0 | 62.4 | 25.4 | 8 | 1 | 0 |
| 5 | 255 | 152.4 | 66.0 | 26.0 | 8 | 1 | 0 |
| 9 | 255 | 215.0 | 69.0 | 26.4 | 8 | 1 | 0 |
| 19 | 255 | 255 | 70.4 | 26.5 | 8 | 1 | 0 |
| 79 | 255 | 255 | 71.2 | 26.6 | 8 | 1 | 0 |
| 139 | 255 | 255 | 71.4 | 26.6 | 8 | 1 | 0 |

和 L20 的差别（`d40` 停在 109、`bg` 2–3）是窗口尺寸，形状相同：外圈收敛。靠近 GLOW 的一圈涨到 255，是 `x + bloom` 超过 1 之后被 `saturate` 留住。

**运行中切换**（L11 只测了 LDR）：
- `hdr-scr`：`clearenabled` 挂 `{script}`，第 40–79、120–159 帧不清屏。第 39 帧 `ACC` 25，第 40 帧 28，第 79 帧 28，第 80 帧 25。切到 false 当帧就过了一次 `lin`，切回 true 当帧干净。`hdr-scr-nb`（泛光位关）相同。
- `hdr-user`：`p_clearen` 属性 6 轮 12 次，12 次切换全是：切到 false 块偏移 {0, 2}，`ACC` 25 → 28；切回 true 1 块，`ACC` 28 → 25，`bg` 全程 0。

工程在 `ignore/p3c/step4/accept/proj/`（`q2-hdr-nobloom`、`hdr-scr`、`hdr-scr-nb`、`hdr-user`），帧在 `wpe/`。

**没有查清**：
- 后备缓冲的值没有直接读，存的是线性值是推断，依据是源码和 `ACC` 模型差 0.2 以内。
- `msaa` 不是 none、`disabled` 档、桌面壁纸窗口下没有测。
- `bloom` 绑属性且运行中打开时的 HDR 不清屏没有测。

测试窗口已关，主实例仍是 PID 36548，`config.json` 哈希前后都是 `6263297c…`。
