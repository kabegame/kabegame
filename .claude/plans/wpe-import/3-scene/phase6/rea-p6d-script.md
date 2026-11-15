> 逆向原始记录，代理写的，dll 地址按基址 `0x180000000`（Ghidra），exe 地址按 `0x140000000`，全部没有实测。P6d 步骤 0c 实测核对后以报告为准。范围是 `scenescript64.dll` 侧与两边的接口：`thisScene` 的建层 / 删层 / 排序 / 查找方法、`engine.registerAsset`、`__workshopId` 路径改写、`engine.isObjectValid`、图层对象的 JS 包装、经通用方法桩调到的层级与 effect 方法。图层怎么建、插在哪、什么时候真正删掉、当帧画不画归并行的 `rea-p6d-layers.md`；本文顺带看到的 exe 侧事实都标了「exe 侧」，重叠处以那份为准。

# WPE 2.8.42 场景脚本的动态图层与层级 API 静态逆向（dll 侧）

**概括**
1. **`createLayer(arg)`**（回调 `0x181633290`）：模块顶层调抛 `SyntaxError: createLayer cannot be called from global scope.`，此外**从不抛错，失败一律返回 `null`**。dll 把参数一律整理成**一段 JSON 文本**交给宿主接口 `H+0x30`（exe 用场景对象工厂 `0x14018ff60` 按 `scene.json` 的对象格式解析，exe 侧），拿回的对象经通用包装 `W` 返回。分四种：
   - **参数个数不是 1**（含 0 个、2 个以上）：直接用 `{"image": <缺省模型>}`，**建一个纯色层**；缺省模型由 `H+0x90`（场景 `+0xe0` bit3）在 `models/util/solidlayer_depthtest.json` 与 `models/util/solidlayer.json` 间选。
   - **对象**：内部字段 2 是 `'MODL'` 的 `IModelData` 先包成 `{model: 它}`；然后调 baseclasses 的 `_Internal.stringifyConfig(obj)`（`JSON.stringify(obj, stringifyAdapter)`，Vec / Mat 经 `toConfigString` 变成 `"x y z"` 串，`IModelData` 变成它的 `__modelDataToken`），jsoncpp 解析，不是 JSON 对象或抛了异常（被 TryCatch 吞掉）就返回 `null`。
   - **字符串**：先当 JSON 文本解析，是对象就同上；否则当**资源路径**：去掉开头的 `/` `\`，按第一段目录与小写扩展名定键（`models/*.json` → `image`，`models/` 其它 → `model`，`particles/` → `particle`，`materials/` → `sprite`，`sounds/` → `sound`，第一段区分大小写），别的目录直接返回 `null`，**dll 自己不读文件**。
   - **配置对象里**有 `color`、却没有 `model` `particle` `sprite` `image` `text` `light` `sound` `camera` 任何一个键时，补 `image: <缺省模型>`（纯色层）。

   返回的包装与 `getLayer`、`thisLayer`、`enumerateLayers` 是**同一套、同一个对象**：`W` 按 exe 对象指针缓存（`E+0x528` 表），同一图层永远返回同一个 JS 对象；对象的字段 / 方法按该 exe 对象自己的反射表现建。【确；`+0x368` = `undefined`、`+0x378` = `null` 的根值身份【推】，与 p6c、p10 的实测一致】
2. **`__workshopId`**：`LoadScript` 在模块求值完、取完回调掩码后读一次导出的 `__workshopId`（`0x18164c67c`），**只认字符串**（数字被忽略），存进脚本对象 `Sd+0x140`，之后再改导出变量不生效。改写函数 `RP`（`0x181653460`）取「当前正在执行的脚本」的 id，**先问 exe「原路径在不在」（引擎配置里的第二个 `std::function`，exe `0x140177cd0` → 资源文件系统 `vtbl+0x28`），在就原样不改**；不在才改写，**改写后不再检查**：
   - 一般规则：`第一段/workshop/<id>/其余`；第二段已经是 `workshop` 时先去掉 `workshop/<旧 id>` 再插当前 id；
   - 键是 `textures` 时：`workshop/<id>/<路径>`（不保留第一段）；
   - 结果把 `\` 换成 `/`、合并 `//`。

   用到它的有：`createLayer` 的字符串路径（键为空）；配置对象里的 `particle` `sprite` `image` `font` `path` `sound`（串或串数组）、`effects[].file`、`effects[].passes[].textures[]`（**不含 `model`、`text`**）；`registerAsset` 登记表（键是路径第一段）；`IModelData` 形状的 `material`。没有 id、没有当前脚本时一律不改。【确；「`vtbl+0x28` 是存在性查询」【推】】
3. **`engine.registerAsset(path[, precache])`**（`0x181655810`）：作用域栈顶不是 0（不在模块顶层）就抛 `SyntaxError: registerAsset can only be called from global scope.`。参数不是字符串返回 `null`；第二个参数是布尔才算 precache。**返回值就是传入的路径字符串本身**（`String::NewFromUtf8` 重建），没有 `IAssetHandle` 类，`createLayer` 与文本层 `font` 认它就是因为它是普通字符串。路径与 precache 位追加到当前脚本的列表 `Sd+0xe8`（元素 0x28 字节）；**同一脚本里登记同一路径第二次返回 `null`**、不重复加。模块求值完后，若 `__workshopId` 是字符串，`LoadScript` 对列表里每条做 `RP` 并**只改列表里存的那份**，脚本手里的字符串仍是原路径。引擎槽 25（`+0xc8`）把列表（改写后的路径、precache）交给宿主，exe 里没找到调用者。【确；exe 无调用者为【确，有界】】
4. **`destroyLayer(layer)`**（`0x181632fc0`）：参数可以是对象、名字串、数字下标（同 `getLayer` 的解析 `R`）；解析不到返回 `false`，否则返回宿主 `H+0x28` 的布尔。exe 的 `H+0x28` 只是把对象放进场景的「待删集合」`G+0x210`（对象在 `G+0x158` 表里就返回 `true`，重复删也是 `true`）（exe 侧）。**dll 当场不碰旧包装**：包装作废发生在 exe 真正析构对象时（基类析构 `0x1401a3b60` 调登记的监听，dll 侧 `0x181653eb0` 把它从 `E` 的两张表里删掉）。作废之后读字段得 `undefined`、写字段静默忽略、调方法返回 `undefined`（都不抛错），`engine.isObjectValid` 返回 `false`；作废之前（同一帧里）这些都照常。【确；「析构在帧尾」按 d.ts「after all scripts on that frame updated」，归 exe 侧】
5. **下标与查找**：`getLayer(数字)`、`getLayerIndex`、`sortLayer` 用的都是 exe 场景对象表 `G+0x158` 的**原始下标**（待删的对象仍占位）；`getLayerCount`、`enumerateLayers` 走 `H+0x20`，**扣掉待删集合**。宿主接口用法：
   - 名字串：`H+0x8`（按名，取第一个同名对象，它待删就 `null`）→ 找不到再 `strtol(名字, 10)` 走 `H+0x10`（按 ID）；
   - 数字：`ToInt32` 后走 `H+0x18`（按下标）；
   - 对象：直接取内部字段 0 的指针（**不校验是否已作废**）。

   `getLayerByID` **只收字符串**（数字直接 `null`），`strtol` 后走 `H+0x10`；`getLayerIndex` 走 `H+0x40`，找不到 `-1`；`sortLayer(layer, index)` 要求第二个参数是 Number（数字字符串不行），`ToInt32` 后走 `H+0x38`；exe 把对象从表里摘出再插到 `index`，`index` 按无符号与长度比、越界（含负数）插到末尾（exe 侧）。【确】
6. **`getInitialLayerConfig(layer)`**（`0x181634980`）：参数解析同 `R`；宿主 `H+0x48` 把对象加载时存的 jsoncpp 原 JSON（`obj+0x1b0`）去掉 `id` 键后写成文本（exe 侧），dll 对它 `JSON.parse`，**每次新建、普通可改的对象**；解析不到或宿主返回假就 `null`。【确；去掉的键是 `id` 为 exe 侧【推：`removeMember`】】
7. **层级**（exe 根方法表 `0x1404e8290`，经 dll 通用方法桩 `M` 调用，没有作用域检查）：
   - `getParent()` 返回父的包装，**没有父时是 `null`**（不是 d.ts 说的 `undefined`）；
   - `getChildren()` 每次新建 Array，顺序是 exe 子表 `obj+0x198` 的顺序，跳过空指针；
   - `setParent(parent, attachment|adjust, adjust)` 第一参收图层对象 / 名字 / 下标，解析不到就**解除父子**（`undefined`、不存在的名字、已作废的包装都如此）；第二参是布尔时当 `adjustTransforms`，是字符串或整数时当挂点，第三参是 `adjustTransforms`；失败时 exe 报 `Invalid parent configuration.`，dll 把它当普通 `Error` 抛出；
   - `getTransformMatrix()` 返回新建的对象，原型是 `Mat4.prototype`（构造函数没跑），自有属性 `m` 是 16 个 float32 扩成的 double，exe 内存顺序（glm 列主序，平移在 `m[12..14]`）。exe 取的是 `obj+0xe0` 的缓存矩阵，会沿父链重算，按 d.ts 是世界矩阵（exe 侧【推】）。

   【确；世界 / 本地归 exe 侧】
8. **effect**：
   - `getEffect` / `getEffectCount` 登记在图像层类方法表 `0x1404e83a0`；`getEffect(整数)` 越界或负数返回 `null`，`getEffect(字符串)` 返回**最后一个**同名的 effect（空串 `null`），非整数的数字、缺参数都是 `null`；`getEffectCount` 是 effect 表长度。
   - `IEffect`（exe 表 `0x1404e83e0` / `0x1404e8420`）字段：`visible`（位，`+0x118`，有改值回调）、`name`（字符串，`+0x120`，**可写**、没有回调）。方法：`getMaterial(整数|字符串)`、`getMaterialCount()`、`setMaterialProperty(字符串, 数|Vec2|Vec3|Vec4)`、`executeMaterialFunction(字符串)`。
   - `getMaterial(i)` 返回第 i 个 pass 的材质对象 `pass+0x8` 的包装，它的字段就是该材质的常量（同一套描述符、同一个 dll 读写路径），所以和挂在该 pass 常量上的脚本的 `thisObject` 多半是**同一个 JS 对象**【推】。
   - `setMaterialProperty` 对每个 pass 的材质按常量名找描述符，类型对得上才写（整数可写进 float，float 可截断写进 int；带角度标志的常量 ×0.0174533），对不上静默忽略。

   【确；与 `thisObject` 同一对象为【推】】
9. **作用域**：`thisScene` 的 14 个方法在模块顶层都抛 `SyntaxError … cannot be called from global scope.`，回调、计时器、`init` 里都能用，dll 里没有「`init` 之前不能建层」一类的门。文案有两处抄错：`getLayerByID` 报的是 `getLayer cannot be called…`，`getInitialLayerConfig` 报的是 `destroyLayer cannot be called…`。`registerAsset` 反过来**只能**在模块顶层（含顶层同步调用到的函数）。图层对象上经 `M` 调的方法（`getParent` 等）没有作用域检查。【确】
10. **别的**：
    - 包装的实现：每个 exe 对象一个 ObjectTemplate，2 个内部字段（0 = exe 指针带标签 2，1 = 包装序号），字段是 `SetNativeDataProperty`（只读字段不给 setter），方法是各自的 FunctionTemplate，另挂 `getAnimation`。
    - 包装用强引用 `Global` 存着，作废时**没有 `Reset`**（每建删一个图层泄漏一个包装，只影响内存）。
    - `thisScene` 各方法用的 `R` 对对象参数**不查作废**，旧包装传进 `getLayer` 会拿已析构的指针建新包装（未定义行为）；传进 `destroyLayer` / `sortLayer` / `getLayerIndex` / `getInitialLayerConfig` 时只做指针比较，若分配器复用了地址，会命中新建的图层。
    - `createLayer(thisLayer)` 一类直接传图层对象的写法，会把包装的全部可枚举字段 `JSON.stringify` 成配置（图像层没有 `image` 字段但有 `color`，于是补出纯色层）。

    【确；后两条的实际效果【推】】

**和计划问题的对照**（子计划 0b 的 9 问；dll 能回答的部分）
- 问 1 参数：字符串 / 句柄（就是字符串）/ 配置对象 → 一段 JSON 交给 exe 工厂；缺省模型只在「无参数或多参数」与「只有 `color` 没有类型键」两种情况下补；文件找不到时 dll 不管，由 exe 工厂失败返回 `null`（exe 侧）；`__workshopId` 见概括 2。
- 问 2 新图层：dll 只拿回对象并包装；id、name、插入位置、当帧画不画、配置里的 `script` 字段、用户属性绑定、能建的类型——**全在 exe 侧**。dll 的路径分类说明字符串参数只能建 `image` / `model` / `particle` / `sprite` / `sound` 五种，对象参数里另认 `text`、`light`、`camera`（只用于判断要不要补缺省模型）。
- 问 3 `destroyLayer`：返回值、待删集合、旧包装作废时机见概括 4；删 `scene.json` 里的图层 dll 不区分。
- 问 4 下标：语料 `sortLayer(bar, thisScene.getLayerIndex(thisLayer))` 用的是 `G+0x158` 的原始下标，exe 摘掉 `bar` 再插到该下标，`bar` 落在 `thisLayer` 之前（`bar` 原来在后面时）；`G+0x158` 是不是绘制顺序、含不含灯 / 相机归 exe 侧。**我们现在返回 `objects` 下标，是否等价取决于 `G+0x158` 的组成。**
- 问 5 `getInitialLayerConfig`：见概括 6；对新建图层返回什么取决于 exe 有没有给它存 `obj+0x1b0`（exe 侧）。
- 问 6 `registerAsset`：见概括 3；precache 是否真的预加载，exe 里没找到消费者。
- 问 7 层级与 `getLayerByID`：见概括 5、7。
- 问 8 effect：见概括 8。
- 问 9 时机：作用域见概括 9；建、排、删之后渲染与命中什么时候看到归 exe 侧。
- 语料约束：
  - 8 张字面量路径：`createLayer('models/bar.json')` 在 `init` 里调，`RP` 用的是调用者脚本的 id；`models/bar.json` 不存在就改成 `models/workshop/<id>/bar.json`，存在就不改。
  - 字体：`fonts/...` 在原路径存在，登记表里的那份也不改；脚本拿到的始终是原串，赋给 `font` 时 dll 不做改写。
  - dino_run：`registerAsset('models/coin_0.json')` / `('particles/coinget.json')` 返回原串，运行中反复 `createLayer(handle)` 每次都按字符串路径重新分类、改写。
  - 克隆：`getInitialLayerConfig` 的结果改完 `origin` / `alpha` 再交给 `createLayer`，走对象分支；`image` 等路径键会经 `RP`，存在就不改。
  - 对象字面量 `{text, color, pointsize, font: thisLayer.font}`：有 `text` 键，不补缺省模型，`font` 经 `RP`。

**元数据**
- 目标：`scenescript64.dll` 副本 `ignore/p10/rea/scenescript64.dll`，SHA-256 `58039ef912fcd51cd833540476e3798268158a06f63003fe94bff1b1cbeaad08`；`wallpaper64.exe` 副本 `ignore/p9/rea/wallpaper64.exe`，SHA-256 `40e2ce021e9352324fadb3b8f72b8ba2a7ee95b71cc571d5b9f84be75cd993b0`。开工时拷进工作目录后核对，两者一致。
- 没运行、没附加 WPE，没写 Steam / WPE 目录，没用 REA。只读了 WPE 的 `assets/scripts/jsclasses/baseclasses.js`、`ui/dist/monaco/autocomplete/lib.sceneScript.d.ts`。
- 方法：dll 宿主区沿用 P6c 的 `host.asm`（`0x181600000`–`0x181680000` 的 `llvm-objdump` 反汇编），区外的 V8 API 小函数临时用 `llvm-objdump --start-address` 看；exe 用 `ignore/p4/rea/wp.asm` 切片；字符串、rip 相对交叉引用、虚表、`.pdata` 函数边界用 P6c 的脚本。
- 工作目录 `ignore/p6/rea/layers/script/`：
  - 脚本：拷自 P6c 的 `pe.py` `fn.py` `xref.py` `strs.py` `dumpstr.py` `rd.py` `vt.py` `vtfind.py` `sl.py` `wsl.py` `wgrep.py` 等；新写 `efields.py`（引擎构造里「字符串句柄 → `E` 字段」）、`mtab.py`（粗扫 exe 方法登记，结果要人工核对）、`vtfind_dll.py`（在 dll 数据段找函数指针）。正则文件 `pat1..4.txt`、`pc8.txt`。
  - dll 摘录：`thisScene_311d0.asm`（`thisScene` 模板与 14 个方法的回调）、`cb_*.asm`（`getLayer` `getLayerByID` `getLayerCount` `enumerateLayers` `destroyLayer` `createLayer` `sortLayer` `getLayerIndex` `getInitialLayerConfig` `registerAsset` `isObjectValid`）、`resolve_372d0.asm`（`R`）、`resolve_53460.asm`（`RP`）、`walker_2efa0.asm`（配置对象路径遍历）、`wrap_52380*.asm`（`W`）、`unwrap_20620.asm`（`U`）、`fieldacc_2b830.asm`（字段读写与方法入口）、`methodcall_214a0.asm`（通用方法桩 `M`）、`loadscript*.asm`（`LoadScript` 全文）、`engine_ctor_48000.asm`、`eng_slots.asm`（引擎槽 17–27）、`rdata_strs.txt`（宿主区字符串）。
  - exe 摘录：`exe_H2.asm`（第二接口的 6 个方法）、`exe_bind_175880.asm`（脚本绑定）、`exe_desc_1e0530.asm`（根方法表登记）、`exe_imagelayer_reg.asm`（图像层表）、`exe_effect_reg.asm`（`IEffect` 表）、`c8.txt` / `c8b.txt`（exe 全部 `+0xc8` 虚调用点）。
- 标记：【确】反汇编直接看到；【推】由代码推出，或依赖 V8 上游行为 / API 身份；【确，有界】在注明范围内搜过。

**命名**（沿用 `rea-p6c-script.md` 的 `E`、`Sd`、`H`，新增的如下）
- `E` 新用到的字段：`+0x2d0` 字符串句柄 `__workshopId`、`+0x340` `model`、`+0x318` `getAnimation`、`+0x208` `m`（`efields.py` 列全）；`+0x358/+0x360/+0x368` = `Vec4/Mat3/Mat4.prototype`；`+0x370` `_Internal`、`+0x378` `convertUserProperties`、`+0x380` `updateScriptProperties`、`+0x388` `stringifyConfig`；`+0x400` exe 反射助手（引擎配置 `+0`）；`+0x410..+0x448`、`+0x450..+0x488` 两个 `std::function`（配置 `+0x10`、`+0x50`，exe `0x140177c10` 读文件、`0x140177cd0` 问存在）；`+0x4f8` 当前脚本 deque（`+0x518` 个数）；`+0x528..+0x558` 「exe 对象 → 包装记录」表；`+0x5a0` 包装序号计数；`+0x5b0..+0x5e0` 「序号 → 记录」表。
- `Sd` 新用到的字段：`+0xe8..+0xf8` 登记资源 vector（元素 `{std::string 路径; bool precache}`，0x28 字节）、`+0xe0` 引擎槽 26 返回的 dword、`+0x140` `__workshopId`（`std::string`）。
- `G`：exe 场景对象（虚表 `0x14048eb48`），`H = G+0x48`，`H2 = G+0x50`（虚表 `0x14048ea08`）。`O` = `G+0x158` 对象表（vector，`H+0x110` / `H2+0x108`）；`Pd` = `G+0x210` 待删集合（unordered_set，`H+0x1c8` / `H2+0x1c0`）。
- `A`：`thisScene` 适配器（0x38 字节，`0x1816311d0` 构造）：`+0` `E`，`+8` `&E.isolate`，`+0x10` 场景，`+0x18` `H`，`+0x20` `E+0x400`；存在 `thisScene` 对象内部字段 0（标签 1）。
- `W`：`0x181652380`，exe 对象 → JS 包装（缓存）。`U`：`0x181620620`，包装 → exe 对象（按序号表校验）。`R`：`0x1816372d0`，`thisScene` 方法的图层参数解析。`RP`：`0x181653460`，`__workshopId` 路径改写。`M`：`0x1816214a0`，exe 反射方法的通用调用桩（入口 `0x18162baf0`）。
- 回调信息 `info`（V8 14 `FunctionCallbackInfo`）：`[info]` = argc，`+0x28` isolate，`+0x30` 返回值槽，`+0x48` this，`+0x50 + 8i` 第 i 个参数。根值 `[isolate+0x368]` = `undefined`、`+0x378` = `null`、`+0x380` = `true`、`+0x388` = `false`【推：V8 ≥ 11 的根表顺序 undefined、hole、null、true、false，`true` / `false` 由 p6c 实测对上】。返回值槽写 `-2` 即 Smi(−1)。

---

## 1. `thisScene` 与 `createLayer`

### 1.1 `thisScene` 的装法（`0x1816311d0`）【确】
- 引擎槽 3（绑定场景，`0x18164bca0`）：`E+0x490 = 场景`，`E+0x498 = H`，然后 `new 0x38` → `0x1816311d0(A, E, &E+0x1d8, 场景, H, E+0x400)` → `E+0x4a0 = A`。
- `ObjectTemplate::New` → `SetInternalFieldCount(1)` → 14 个 `FunctionTemplate::New(isolate, 回调, data = 空)` + `Template::Set(名字, ft)`：

| 方法 | 回调 | 宿主接口 |
|---|---|---|
| `getLayer` | `0x181632350` | `R` |
| `getLayerByID` | `0x181632620` | `H+0x10`（按 ID） |
| `getLayerCount` | `0x181632950` | `H+0x20` |
| `enumerateLayers` | `0x181632c00` | `H+0x20` ×2 |
| `destroyLayer` | `0x181632fc0` | `R` + `H+0x28` |
| `createLayer` | `0x181633290` | `H+0x90`、`H+0x30` |
| `sortLayer` | `0x181634eb0` | `R` + `H+0x38` |
| `getLayerIndex` | `0x181635200` | `R` + `H+0x40` |
| `getInitialLayerConfig` | `0x181634980` | `R` + `H+0x48` |
| `getCameraTransforms` / `setCameraTransforms` | `0x181635540` / `0x1816359e0` | `H+0x68` / `H+0x70` |
| `getAnimation` | `0x181635ee0` | `H+0x78`（p10） |
| `createModelData` / `destroyModelData` | `0x1816361f0` / `0x181636890` | `H+0x50` / … |

- 47 个场景字段：对 `E+0x400` 列出的每个名字 `SetNativeDataProperty(取值 0x181631d00, 设值 0x181632030)`；`NewInstance` 后 `SetAlignedPointerInInternalField(0, A, 标签 1)`，`global.thisScene = 实例`。另建 `IModelData` 的 `applyData` / `replaceData` 模板。
- 每个回调开头同一段：从 `this`（`info+0x48`）取内部字段 0（标签 1）得 `A`，`[A]` = `E`，看 `[[E+0x3a0] − 4]`（作用域栈顶），为 0 就用 stringstream 拼 `名字 + " cannot be called from global scope."`（后缀 `0x1819a30f8`）抛 `SyntaxError`（`0x1800387a0`）。
  - `getLayerByID` 拼的名字是 `getLayer`（`0x181632704` 引用 `0x1819a2f70`）；
  - `getInitialLayerConfig` 拼的是 `destroyLayer`（`0x181634a64` 引用 `0x1819a2fb0`）；
  - 其余 7 个用自己的名字（`getLayerCount` `0x181632a39`、`enumerateLayers` `0x181632cf6`、`destroyLayer` `0x1816330a5`、`createLayer` `0x18163338e`、`sortLayer` `0x181634f97`、`getLayerIndex` `0x1816352e7`、`getLayer` `0x181632435`）。

### 1.2 `createLayer` 的流程（`0x181633290`–`0x1816348b1`）【确】
```
if 顶层: throw SyntaxError("createLayer cannot be called from global scope.")
types = unordered_set{"model","particle","sprite","image","text","light","sound","camera"}   // 0x181633511–0x18163377b
def = H+0x90() ? "models/util/solidlayer_depthtest.json" : "models/util/solidlayer.json"  // 0x1816337d4
json = ""
if argc != 1:                                   // 0x18163382c → 0x181634584
    json = write({"image": def})
elif arg0.IsObject():                           // 0x181633858
    if 内部字段 2 存在且非 undefined 且 IsUint32 且 == 'MODL':   // 0x181633874–0x181633933
        arg0 = {model: arg0}                    // Object::New + Set(E+0x340 "model", arg0)
    TryCatch {
        s = _Internal.stringifyConfig.call(_Internal, arg0)   // E+0x388 / E+0x370，0x181633a38
    }
    if 没抛 && s 非空:
        root = parse(Utf8(s))
        if 解析成功 && root 是对象: json = 整理(root)          // 见下
    // 抛了异常：TryCatch 析构不重抛，json 仍为空
elif arg0 是字符串:                              // 0x181633c00
    root = parse(Utf8(arg0))
    if 解析成功 && root 是对象: json = 整理(root)
    else: json = 按路径(arg0)                    // 1.3；分类失败直接 return null
// 其它类型（数字、布尔、undefined、null）：json 为空
if json == "": return null                      // 0x1816347d2
obj = H+0x30(json.c_str())
return obj ? W(obj) : null                      // W 返回空句柄时为 undefined
```
- `整理(root)`（`0x181633aa9`–`0x181633bb2`，字符串分支同形 `0x181633cb6`–`0x181633d99`）：
  1. `root` 有 `color`、却没有 `types` 里任何一个键 → `root["image"] = def`；
  2. 遍历 `0x18162efa0(root, 访问器)`：对指定键调 `RP` 改写（第 2.3 节）；
  3. jsoncpp 写成文本（`0x18162e730`）。
- `H+0x90` 是 exe `0x1401853a0`：`return ([H+0x98] >> 3) & 1`，即场景 `G+0xe0` 的 bit3（exe 侧，含义没查；同一个字的 bit28 是 P6c 的用户命令令牌）。
- `IModelData` 判定：`0x18162e580(obj, 2)` = 「内部字段数 > 2 且字段 2 不是 `undefined`」，再 `IsUint32`（`0x1800170a0`）、`Int32Value == 0x4d4f444c`（`'MODL'`）。包成 `{model: md}` 后经 `stringifyAdapter` 变成 `{"model":"<__modelDataToken>"}`。直接写 `{model: md, …}` 效果一样。
- `stringifyConfig`（`baseclasses.js` 1419 行）是 `JSON.stringify(obj, stringifyAdapter)`，适配器对有 `toConfigString` 的值调它：
  - `Vec2/3/4` → `x+' '+y[+' '+z[+' '+w]]`（JS 数字转字符串，全精度）；
  - `Mat3/4` → 9 / 16 个数空格分隔；
  - `IModelData` → token。

  所以 `origin: thisLayer.origin`（读回的是 `Vec3`）进 JSON 是 `"x y z"` 串。数组、`Vec3` 本身作参数会得到 JSON 数组 / 字符串，不是对象 → `null`。

### 1.3 字符串当路径（`0x181633e1e`–`0x181634487`）【确】
1. 拷一份，循环删掉开头的 `/` 或 `\`（`0x181633e40`–`0x181633eba`）。
2. `std::filesystem::path`：
   - 第一段 `first`：`0x18162e480`，有根时取根，否则 `*begin()`，转 UTF-8；
   - 扩展名 `ext`：MSVC `_Parse_extension` 的内联，`0x181633f16`–`0x181633faa`，转 UTF-8 后逐字 `tolower`。
3. 先对原路径做 `RP(E, out, key = null, &p)`（`0x18163420d`），结果替换 `p`。分类用的是**改写前**的 `first` 与 `ext`。
4. 分类（`memcmp` 定长比较，`first` 区分大小写）：

| `first` | `ext` | 键 |
|---|---|---|
| `models` | `.json` | `image` |
| `models` | 其它（含无扩展名） | `model` |
| `particles` | 任意 | `particle` |
| `materials` | 任意 | `sprite` |
| `sounds` | 任意 | `sound`（值是字符串，不是数组） |
| 其它 | — | **返回 `null`**（`0x181634487`），不调宿主 |

5. `json = write({键: p})`，不补缺省模型、不经第 1.2 节的遍历。

### 1.4 返回的对象【确】
- `H+0x30` 是 exe `0x14018ba00`（exe 侧，顺带看到）：`O` 长度 ≥ 2048（`0x4000` 字节）直接返回 0；否则 jsoncpp 解析，成功就调场景对象工厂 `0x14018ff60(G, &json)`（与加载 `scene.json` 的对象同一个工厂），返回对象或 0。
- 非空对象经 `W` 包装（第 6 节），与 `getLayer` / `thisLayer` / `enumerateLayers` 是同一函数、同一缓存。

---

## 2. `__workshopId`

### 2.1 读取（`LoadScript`，`0x18164c67c`–`0x18164c75b`）【确】
- 模块求值成功、取完 19 个回调掩码之后：`namespace->Get(context, E+0x2d0)`。值必须是堆对象且实例类型 < `0x80`（字符串），才 `ToString` → `Utf8Value` → `Sd+0x140 = 串`。
  - 数字（`export let __workshopId = 2652493753`，超 Smi 是 HeapNumber）、`undefined` 都不认，`Sd+0x140` 保持空串（`0x18164c29a` 初始化）。
- 只读这一次，之后再给 `__workshopId` 赋值不影响。
- 同一段里接着处理登记资源表（2.4）。整段在「当前脚本」deque 仍压着本脚本时执行：`LoadScript` 在 `0x18164c2f1` 压、成功路径在 `0x18164df0e` 弹。

### 2.2 改写函数 `RP(E, out, key, &value)`（`0x181653460`）【确；存在性查询的身份【推】】
```
Sd = E 当前脚本 deque 栈顶；没有 → out = value，返回
if Sd+0x140 为空串 → out = value，返回
if E+0x450 的 std::function 为空 → std::_Xbad_function_call
if E+0x450(value.c_str()) → out = value，返回        // 原路径「在」就不改
p = path(value)
if key != null && key == "textures":                  // strcmp，0x181653533
    if 第一段 == "workshop": 去掉前两段
    p = path("workshop") / Sd+0x140 / p
else:
    first = 第一段(p); 去掉第一段
    if 新的第一段 == "workshop": 再去掉两段
    p = first / "workshop" / Sd+0x140 / p
out = UTF8(p)，把 '\' 全换成 '/'，再把连续的 '//' 并成一个
```
- 「去掉第一段」是 `0x181644d70`：相对路径时 `++begin()` 之后把余下各段重新拼回去；**只有一段时不变**。所以单段路径 `bar.json` 会被改成 `bar.json/workshop/<id>/bar.json`。只在原路径不存在时发生，算边角。
- `E+0x450` 是引擎配置第二个 `std::function`（`0x181647e09` 从配置 `+0x50` 拷来）。exe 在脚本绑定 `0x140176501`–`0x14017654c` 用 `0x140177cd0` 建它：`return [[S+8]+0x1898]->vtbl+0x28(path)`，`R+0x1898` 是渲染器上的资源文件系统对象。同一对象的 `vtbl+0x30` 在着色器缓存里当文件时间（double）用，所以 `+0x28` 多半是「资源存在」【推】。它查的范围（工程目录、`scene.pkg`、WPE `assets`）归 exe 侧。
- 「改写后不再检查」：改出来的路径不存在时 dll 不回退原路径，原样交给 exe。

### 2.3 哪些地方用 `RP`【确】
全部 6 个调用点（`xref.py` 全 dll）：

| 调用点 | 场合 | `key` |
|---|---|---|
| `0x18163420e` | `createLayer` 字符串路径 | 空 → 一般规则 |
| `0x18163ac5c`（`std::function` 的 `_Do_call`，虚表 `0x1819a32e8`，由遍历 `0x18162efa0` 调） | `createLayer` 配置对象 | 键名 |
| `0x18164c86e` | `LoadScript` 处理登记资源 | 路径第一段（如 `fonts`） |
| `0x181630e88` | `IModelData` 形状的 `material` | 空 |
| `0x1816348db`、`0x18163c05b` | 两个 lambda，找不到引用（疑为死代码） | — |

- 配置对象的遍历 `0x18162efa0`：
  - 顶层 `particle`、`sprite`、`image`、`font`、`path`：值是字符串才改（`0x18162f010` 的 5 项循环）；
  - `sound`：字符串，或数组里的每个字符串；
  - `effects` 数组 → 每项的 `file`（字符串）→ 每项的 `passes` 数组 → 每个 pass 的 `textures` 数组的**每个元素**，键 `textures`，走 textures 规则。元素不查类型，`null` 会被 `asString` 成 `""` 再改写【推】。
  - **`model`、`text`、`material`（顶层）不在表里**，所以 `{model: 'models/x.mdl'}` 不改写，而字符串 `createLayer('models/x.mdl')` 会改。
- 属性写入（`thisLayer.font = …` 等，dll `0x181620e10`）不经 `RP`。

### 2.4 `registerAsset` 登记表的改写（`0x18164c75b`–`0x18164c925`）【确】
- 只在 `__workshopId` 是字符串时进入：对 `Sd+0xe8` 的每条，`first` = 路径第一段，`条目.路径 = RP(E, out, first.c_str(), &条目.路径)`。
- 改的是表里的副本；脚本里 `registerAsset` 早已返回原串（第 3 节）。若第一段恰好是 `textures`，走 textures 规则。

---

## 3. `engine.registerAsset`（`0x181655810`）【确；exe 消费者为【确，有界】】
```
E = isolate 数据槽 0
if [[E+0x3a0] − 4] != 0:                 // 不在模块顶层
    throw SyntaxError("registerAsset can only be called from global scope.")   // 0x1819a3b60，长 0x33
if argc < 1 || arg0 不是字符串: return null
path = Utf8Value(arg0)
precache = argc > 1 && arg1.IsBoolean() ? arg1.BooleanValue() : false
Sd = 当前脚本 deque 栈顶
if path 已在 Sd+0xe8 表里（长度 + memcmp 全等）: return null                 // 0x1816559dd → 0x181655d68
Sd+0xe8.push_back({path, precache})
return String::NewFromUtf8(path)          // 原路径串
```
- **没有 `IAssetHandle`**：返回值是普通 JS 字符串，`typeof` 为 `string`，与传入的值相等（`===` 也成立）。`createLayer(句柄)` 等于 `createLayer(原路径串)`；`thisLayer.font = 句柄` 等于写原路径串。
- 同一脚本两次登记同一路径，第二次返回 `null`。不同脚本各有自己的表，互不影响。
- 「模块顶层」按作用域栈判断：模块顶层同步调用的函数里也算顶层；`init` 等回调里调就抛错。不 `try` 的话异常逃出模块求值、整段脚本失效（p6c 3.2）。
- 引擎槽 25（`+0xc8`，`0x1816519f0`）：`(E, Sd, i, sink, &precache)` 按下标把（改写后的）路径交给 sink、写出 precache，越界返回假。槽 26（`+0xd0`）返回 `Sd+0xe0`，没查是什么。
- exe 全部 25 处 `call [reg+0xc8]`（`c8b.txt`）逐个看过，参数形状都不是「引擎槽 25」，**没找到读登记表的调用者**。所以 2.8.42 的 precache 可能没接上，或者调用方式不在搜索范围内。

---

## 4. 图层参数解析 `R`、`destroyLayer` 与包装作废

### 4.1 `R(A, &arg, isolate)`（`0x1816372d0`）【确】
```
if arg 是字符串:
    s = Utf8Value(arg)
    o = H+0x8(s)                      // = H2[0] 按名
    if !o: o = H+0x10(strtol(s, 0, 10))   // = H2[1] 按 ID
elif arg.IsNumber():                  // Smi 或 HeapNumber
    o = H+0x18(arg.Int32Value())      // = H2[2] 按下标（ToInt32：截断、NaN → 0）
elif arg.IsObject() && 内部字段数 > 0 && 字段 0 不是 undefined:
    o = GetAlignedPointerFromInternalField(0, 标签 2)   // 标签不符得 0
else o = 0
```
- 对象分支**不经序号表校验**：已作废的旧包装照样取出（已析构的）指针。
- exe 侧的 `H2`（`exe_H2.asm`，顺带看到）：
  - `[0]` `0x1401966d0`：遍历 `O`，`obj+0x1d8` 名字全等的**第一个**对象，在 `Pd` 里就返回 0，不再往后找；
  - `[1]` `0x140196840`：`obj+8` == ID 的对象，在 `Pd` 里返回 0；
  - `[2]` `0x140196980`：无符号下标 < `O` 长度才取 `O[i]`，在 `Pd` 里返回 0；
  - `[3]` `0x140196ac0`：按参数类型码分派（`0x200` 名字再 ID、`8` 下标、`0x800` 对象须在 `O` 里），给 `setParent` 用。

### 4.2 `destroyLayer`（`0x181632fc0`）【确】
```
if 顶层: throw SyntaxError("destroyLayer cannot be called from global scope.")
if argc < 1: return false
o = R(arg0); if !o: return false
return H+0x28(o)
```
- exe 的 `H+0x28`（`0x14018b730`，exe 侧，顺带看到）：`o` 在 `O` 里就插进 `Pd`（已在也照样）并返回 `true`，不在返回 `false`。dll 不改包装、不压 `destroy` 回调。
- d.ts：「The layer is removed after all scripts on that frame updated」，即真正删除在帧尾（exe 侧）。

### 4.3 包装何时作废【确】
- `W` 建包装时向 exe 对象登记两个监听（第 6 节）。其中 `obj->vtbl+0x30(std::function)`（exe `0x1401a3be0`，存进 `obj+0x18` 的 vector）绑的是 `std::bind(&SceneScriptEngine::…, E, _1)`（RTTI `_Binder<…SceneScriptEngine…IPropertyObject…>`），实体 `0x181653eb0`：
  - 按对象指针在 `E+0x528` 表里找到记录；
  - 从序号表 `E+0x5b0` 删掉记录的序号；
  - 释放记录（`0x18162c380` 只 `delete`，**不 `Reset` 里面的 `Global`**）；
  - 从 `E+0x528` 表删掉。
- exe 基类析构 `0x1401a3b60`（`IPropertyObject`，虚表 `0x14048b760`）逐个调 `obj+0x18` 的监听。所以作废发生在**对象真正析构时**。
- 作废后，经 `U`（`0x181620620`：内部字段数 ≥ 2 → 字段 1 序号在 `E+0x5b0` 表里 → 再取字段 0 指针）的入口都拿到 0：

| 入口 | 作废后 |
|---|---|
| 字段读（`0x18162b830`） | 不设返回值 → `undefined` |
| 字段写（`0x18162b9a0`） | 什么也不做 |
| 方法（`0x18162baf0`） | 不调 exe，返回 `undefined` |
| `engine.isObjectValid(x)`（`0x181656a30`） | `false` |
| 作 `0x800` 参数传给别的方法（`M`） | 转换失败，按「缺参数」处理 |

- `isObjectValid` 的完整规则：
  - 没参数 → `false`；
  - 不是对象 → `false`；
  - 否则 `ToObject` 后 `U(obj, E) != 0`。

  所以 `thisScene`（只有 1 个内部字段）、普通对象都是 `false`，effect / 材质包装是 `true`。
- 待删但还没析构的对象（同一帧里）：包装仍有效，字段可读写、`isObjectValid` 为真；`getLayer(名字)`、`getLayer(下标)` 已返回 `null`，`getLayerCount` / `enumerateLayers` 已扣掉它，`getLayerIndex(对象)` 仍返回它的下标。
- 旧包装的风险【推】：作废后传给 `thisScene` 方法时，`R` 取出已析构的指针：
  - `getLayer(旧)` → `W(野指针)`：表里查不到，会对已释放内存调 `vtbl+0x30` 建新包装，未定义行为；
  - `destroyLayer` / `sortLayer` / `getLayerIndex` / `getInitialLayerConfig` 只拿指针跟 `O` 比较。分配器把同一地址给了新建的图层时，会命中那个新图层。

  我们不必复刻，按作废处理即可。

---

## 5. 下标、计数与排序

### 5.1 各方法用的表【确】
| 方法 | dll | 宿主 | exe 实现（顺带） | 结果 |
|---|---|---|---|---|
| `getLayer(名字串)` | `R` | `H+0x8` → `H+0x10` | `H2[0]` / `H2[1]` | 第一个同名对象（待删 → `null`），找不到再按 `strtol` 当 ID |
| `getLayer(数字)` | `R` | `H+0x18` | `H2[2]` | `O[ToInt32(n)]`，待删或越界 `null` |
| `getLayer(对象)` | `R` | — | — | 对象本身（不查是否在 `O`） |
| `getLayer()` | — | — | — | **`undefined`**（argc < 1 不设返回值） |
| `getLayerByID(串)` | `strtol` | `H+0x10` | `H2[1]` | ID 匹配；**数字参数直接 `null`**，无参数 `undefined` |
| `getLayerCount()` | — | `H+0x20(0, 0)` | `0x14018b570` | `O` 长度 − `Pd` 大小 |
| `enumerateLayers()` | — | `H+0x20` ×2 | 同上 | 新 Array，`O` 顺序，跳过 `Pd` 里的对象 |
| `getLayerIndex(x)` | `R` | `H+0x40` | `0x14018c580` | `O` 里的下标（含待删），找不到 `-1`；无参数 / 其它类型 `-1` |
| `sortLayer(x, i)` | `R` + `ToInt32(i)` | `H+0x38` | `0x14018bbd0` | 布尔 |

- `getLayerIndex` 先判参数是对象 / Number / 字符串，否则直接 `-1`（`0x181635525` 写 Smi(−1)）。数字参数等于先按下标取对象，再问它的下标，所以 `getLayerIndex(5)` 在 `O[5]` 存在时得 5。
- `sortLayer`：
  - argc < 2 → `false`；
  - 第一参不是对象 / Number / 字符串 → `false`；
  - **第二参必须 `IsNumber`**（`'3'` → `false`）；
  - `R` 失败 → `false`；
  - 否则 `H+0x38(o, ToInt32(i))`。
- exe 的 `H+0x38`（顺带看到）：在 `O` 里找 `o`，找不到返回 `false`；找到就摘出（memmove），`if (长度 <= (unsigned)i) i = 长度`，插到 `i`，之后重建一张派生表（`+0x180` 的集合，含义归 exe 侧）并返回 `true`。负数下标经无符号比较等于插到末尾。
- 所以语料的 `sortLayer(bar, thisScene.getLayerIndex(thisLayer))`：`bar` 在 `O` 里位于 `thisLayer` 之后时，摘出不影响 `thisLayer` 的下标，`bar` 被插到 `thisLayer` 原来的位置，即**紧挨在 `thisLayer` 前面**。`O` 的顺序是否就是绘制顺序归 exe 侧。
- `getLayer(i)`、`getLayerIndex`、`sortLayer` 是同一套原始下标；`getLayerCount`、`enumerateLayers` 扣掉待删的。同一帧里删过图层之后两者对不上（例如 `for (i < getLayerCount()) getLayer(i)` 会碰到 `null`、漏掉末尾几个）。

### 5.2 `strtol` 的细节【确；函数身份【推】】
`0x1817465c4` 以 `(串, 0, 10)` 调用，形状是 CRT 的 `strtol` / `strtoul`（没区分）。`'12abc'` → 12；`'abc'`、`''` → 0，即按 ID 0 找。

---

## 6. 包装 `W` 与对象的形状（`0x181652380`）【确】
```
W(E, out, obj):
  if !obj: out = null（[isolate+0x378]），返回
  rec = E+0x528 表[obj]
  if rec: out = rec.Global（Global 为空时 out = 空句柄 → 调用方给 undefined），返回
  obj->vtbl+0x30(监听 0x181653eb0)                        // 析构通知，见 4.3
  id = E+0x5a0++（跳过已占用的）
  rec = new 0x30 {虚表 0x1819a2b58, &E.isolate, E+0x400, obj, id, Global = 0}
  tpl = ObjectTemplate::New; SetInternalFieldCount(2)
  for d in obj 的字段表（E+0x400 助手 + obj->vtbl+0x10）:
      tpl.SetNativeDataProperty(d.名字, 取值 0x18162b990,
            设值 = (d+0x30 & 2) ? 空 : 0x18162bae0, data = External(d, 标签 3),
            属性 = (d+0x30 & 2) ? ReadOnly : None)
  for m in obj 的方法表（obj->vtbl+0x18）:
      tpl.Set(m.名字, FunctionTemplate(0x18162baf0, data = External(m, 标签 4)))
  tpl.Set("getAnimation", FunctionTemplate(0x18162bbe0))   // E+0x318
  inst = tpl.NewInstance(context)
  inst.SetAlignedPointerInInternalField(0, obj, 标签 2); inst.SetInternalField(1, Integer(id))
  rec.Global = Global(inst)；登记进 E+0x5b0（id → rec）与 E+0x528（obj → rec）
  obj->vtbl+0x38(监听 0x18162c490)                         // exe 增删字段时同步增删属性
```
- 每个 exe 对象一个模板。字段与方法按**该对象自己的**反射表（本类表 → 基类表回落，p4f 1.2）建出，所以文本层、粒子层、图像层、effect、材质各有各的成员。原型是 `Object.prototype`（p3 L14 的 `constructor.name` 为空与此一致）。
- 同一 exe 对象永远返回同一个 JS 对象：`getLayer('a') === getLayer('a')`、`thisLayer === getLayer(thisLayer.name)`、`createLayer` 的返回值与之后 `enumerateLayers` 里的那个相同。`thisLayer` / `thisObject` 的取值器同样调 `W`（`0x181646845`、`0x181646945`）。
- `Global` 是强引用、从不 `Reset`：包装对象永远不被 GC 回收。
- 字段描述符是 exe 条目 `+0x30` 起的指针，`+0x30` 标志的 bit1 = 只读、bit2 = 角度（p4f、p10）。只读字段没有 setter、属性 `ReadOnly`，模块（严格模式）里赋值应抛 `TypeError`【推：V8 行为】。
- 字段都是可枚举的数据属性：`JSON.stringify(图层包装)` 会调全部取值器，得到当前值的配置。所以 `createLayer(thisLayer)`（直接传图层对象）会建一个「当前字段值」的新对象：图像层没有 `image` 字段、有 `color`，于是补出纯色层；文本层有 `text`，建出文本层【推】。

---

## 7. `getInitialLayerConfig`（`0x181634980`）【确；exe 侧细节【推】】
```
if 顶层: throw SyntaxError("destroyLayer cannot be called from global scope.")   // 文案抄错
if argc < 1: return null
o = R(arg0); if !o: return null
sink = std::string; if !H+0x48(o, sink{0x181623450}): return null
TryCatch { v = JSON.parse(context, String::NewFromUtf8(sink)) }    // 0x180014a00
return v ?? null
```
- 每次调用重新解析，得到**新的、普通的、可改的**对象，改它不影响图层，也不影响下次调用。
- exe 的 `H+0x48`（`0x14018c5c0`，顺带看到）：
  - `o` 不在 `O` 里返回 `false`；
  - 在就拷贝 `obj+0x1b0` 的 jsoncpp 值，调 `0x1400878f0(拷贝, "id")`（多半是 `removeMember`）去掉 `id`；
  - 用 `0x140004d00(…, 0)` 写成紧凑文本（与 p10 事件串同一个 writer：无缩进、`emitUTF8`、精度 8），交给 sink。
- 内容是加载时的 JSON 原文：`{script}`、`{user}`、`{animation}` 绑定，`image` 原路径，`effects` 等都原样保留。新建图层有没有 `obj+0x1b0`、是不是传入的配置，归 exe 侧。

---

## 8. 层级方法（exe 根方法表 `0x1404e8290`，`exe_desc_1e0530.asm`）

### 8.1 登记【确】
| 方法 | exe 函数 | 返回类型 | 参数类型 |
|---|---|---|---|
| `getTransformMatrix` | `0x1401df5e0` | `0x80`（Mat4） | 无 |
| `rotateObjectSpace` | `0x1401df620` | 1（无） | `0x20` |
| `lookAt` / `lookAtYaw` | `0x1401dfc00` / `0x1401dfe30` | 1 | `0x20`、`0x20` |
| `setParent` | `0x1401e00b0` | 1 | `0xa08`、`0x20a`、`0x2` |
| `getParent` | `0x1401e0180` | `0x800`（对象） | 无 |
| `getChildren` | `0x1401e0190` | `0x1000`（对象数组） | 无 |
| `getAttachmentIndex` | `0x1401e01d0` | 8 | `0x200` |
| `getAttachmentMatrix` / `Origin` / `Angles` | `0x1401e01f0` / `0x1401e02c0` / `0x1401e0390` | `0x80` / `0x20` / `0x20` | `0x208` |

类型码：2 布尔、4 float、8 整数、`0x10/0x20/0x40` Vec2/3/4、`0x80` Mat4、`0x100` Mat3、`0x200` 字符串、`0x400` 对象转 JSON、`0x800` 图层对象、`0x1000` 对象数组、`0x2000` 函数。

### 8.2 通用方法桩 `M`（`0x1816214a0`）【确】
- 入口 `0x18162baf0`：`U(this)` 失败就直接返回（`undefined`）。
- 每个形参按类型码位逐个尝试，第一个成功的就用：

| 顺序 | 类型码 | 判定 / 转换 |
|---|---|---|
| 1 | `0x200` | 是字符串 → `ToString` |
| 2 | `2` | `IsBoolean` |
| 3 | `8` | **`IsInt32`**（`0x180017040`：有限、整数、不是 −0） |
| 4 | `4` | `IsNumber` → float |
| 5 | `0x400` | 对象 → `JSON::Stringify` |
| 6 | `0x10/0x20/0x40` | 对象取 `x y z w` |
| 7 | `0x80/0x100` | 矩阵 |
| 8 | `0x800` | `IsObject` 且 `U` 成功 |
| 9 | `0x2000` | 函数 |

- 都不成功、或缺这个参数时，按掩码里优先级最高的类型放一个零值，类型码带最高位（如 `0x80000200` 空串、`0x80000008` 整数 0），exe 据此知道「没给」。
- 调 exe 函数 `(obj, argc, 类型码数组, 值数组, &返回, &错误槽)`。错误槽是 dll 的小对象（虚表 `0x1819a2708`，写 `+0x28` 标志与消息）。exe 写了消息，dll 调用后用 `0x180034ab0` 构造异常并 `ThrowException`；它取原生上下文槽 `0x427`，与 `SyntaxError` 的 `0x493` 不同，多半是普通 `Error`【推】。
- 返回值：

| 返回类型码 | 转换 |
|---|---|
| 1 | 不设（`undefined`） |
| 2 | 布尔 |
| 4 | float → Number |
| 8 | 整数 → Smi |
| `0x10/0x20/0x40` | 新建原型为 `Vec2/3/4.prototype` 的对象 |
| `0x80` | Mat4，见 8.3 |
| `0x100` | Mat3（`0x181625090`） |
| `0x800` | `W(ptr)`，空指针 → **`null`**（`0x181622f13`） |
| `0x1000` | exe 经回调给出指针区间，dll 建 Array，按顺序对非空指针 `W` 后依次 `Set` |

### 8.3 各方法【确；exe 侧细节为顺带】
- **`getParent()`**：exe 返回 `obj+0x180`。没有父 → dll 返回 `null`。
- **`getChildren()`**：exe 把 `obj+0x198..+0x1a0`（vector）交给 sink。dll 每次新建 Array，顺序同 vector，跳过空指针。
- **`setParent`**（exe `0x1401e00b0`，顺带看到）：
  - `parent = G->vtbl+0x18(类型码₀, 值₀)`，即 `H2[3]`：名字（找不到按 `strtol` 当 ID）/ 下标 / 对象（须在 `O` 里）。缺参数、`undefined`、`null`、作废的包装都得到空。
  - `adjust = (类型码₁ 是布尔 && 值₁) || (类型码₂ 是布尔 && 值₂)`。
  - `parent` 为空 → `0x1401de750(obj, null, adjust, -1)`，**解除父子**。
  - 否则挂点 = 第二参是整数时取它；是字符串（含缺省的空串）时 `parent->vtbl+0x70(串)`；都不是时 −1。然后调 `0x1401de750(obj, parent, adjust, 挂点)`，失败时把 `Invalid parent configuration.`（`0x1404902a8`）写进错误槽 → JS 抛 `Error`。
  - 注意：传一个不存在的名字会先 `strtol` 成 0、按 ID 0 找；找不到也是解除父子。
- **`getTransformMatrix()`**（exe `0x1401df5e0`）：`obj->vtbl+0x80()`（`0x1401850a0`：帧计数过期或父链变了就重算，返回 `obj+0xe0`）拷 64 字节。dll `0x181624c20`：
  - `Object::New`，原型设成 `E+0x368`（`Mat4.prototype`），构造函数不跑；
  - `Array::New(16)`，`m[i]` = 第 i 个 float 扩成 double；
  - `Set("m", 数组)`。

  布局就是 exe 的内存顺序，与 `baseclasses.js` 的 `Mat4.fromTranslation`（`m[12..14]` 是平移）一致，即 glm 列主序。按 d.ts 是世界矩阵，含不含 `alignment`、视差等归 exe 侧。每次调用新建对象。

---

## 9. effect

### 9.1 图层上的 `getEffect` / `getEffectCount`【确】
- 登记在图像层类方法表 `0x1404e83a0`（`exe_imagelayer_reg.asm`，同表还有 `transformAttachmentToTexture`）：
  - `getEffect` 是 `0x1401ecfe0`，返回 `0x800`，参数 `0x208`；
  - `getEffectCount` 是 `0x1401ed0b0`，返回 8。
- 文本层的方法表为空，回落到图像基类，所以也有这两个方法【推，同 p6c 4.3】。粒子层回落到根表，没有它们，在粒子层上调会是 `TypeError: … is not a function`【推】。
- `getEffect`（exe，顺带看到）：
  - 类型码含 8（整数）：`0 ≤ i < 长度` 才返回 `obj+0x308[i]`，负数、越界不写返回值 → dll 得 `null`；
  - 类型码含 `0x200`：空串 → `null`；否则遍历全部 effect，`effect+0x120`（名字）相等就覆盖输出，**最后一个同名的胜出**；
  - `getEffect(1.5)`：1.5 不过 `IsInt32`、也不是字符串 → 缺省空串 → `null`。`getEffect()` 也是 `null`。
- `getEffectCount`：`obj+0x308` vector 的长度。

### 9.2 `IEffect`（`exe_effect_reg.asm`，`0x1401efca0`）【确；exe 实现为顺带】
- 字段表 `0x1404e83e0`：
  - `visible`：类型 6（位），`effect+0x118`，存取器与图层 `visible` 同一套，改值回调 `0x1401e6300`（p3 J5 那条重建链）；
  - `name`：类型 5（字符串），`effect+0x120`，有 JSON setter / 原生 setter `0x1401a4d00` / 取值 `0x1401a4d60`，**没有只读位、没有改值回调**，脚本可写，写了会影响之后按名字的 `getEffect`。
- 方法表 `0x1404e8420`：

| 方法 | exe 函数 | 返回 | 参数 | 行为（顺带看到） |
|---|---|---|---|---|
| `getMaterial` | `0x1401ee0c0` | `0x800` | `0x208` | `effect+0xd0..0xd8` 是每个 pass 0x30 字节的条目，`条目+8` 是材质对象。整数：越界或负数 → `null`。字符串：材质 `+0x200` 串相等的覆盖输出（最后一个胜出），**空串匹配每一个**（得到最后一个材质） |
| `getMaterialCount` | `0x1401ee1a0` | 8 | 无 | 条目数 |
| `setMaterialProperty` | `0x1401ee1d0` | 1 | `0x200`、`0x7c` | 见下 |
| `executeMaterialFunction` | `0x1401ee3a0` | 1 | `0x200` | 见 `rea-p7d-fluid.md` |

- `setMaterialProperty(名, 值)`：对每个条目的材质 `mat->vtbl+0x20(名)`（按名找字段描述符）。找到时：
  - 值的类型码与描述符类型（0 int、1 vec2、2 vec3、3 vec4、4 float）配对：float → float / int（截断），int → int / float；
  - 带角度标志（描述符 `+0x30 & 4`）的乘 `0.0174533`；
  - vec2/3/4 只配同维；
  - 然后调描述符 `+0x18`（原生 setter，带改值回调）。

  没找到或类型对不上静默跳过。所以它会写**这个 effect 所有 pass** 里同名的常量。
- `getMaterial(i)` 返回的材质对象经 `W` 包装，字段就是它的常量描述符（`vtbl+0x20` 用的那张表），读写走 dll 的通用字段存取（`0x1816208e0` / `0x181620e10`），与挂在常量上的脚本写 `thisObject.<常量>` 同一条路。p10 说 effect 常量的绑定「归所在 pass」；若那个属主就是 `条目+8` 的材质对象，`thisObject === thisLayer.getEffect(k).getMaterial(i)`【推】。
- `getMaterial` 的参数类型码是 `0x208`，`getMaterial('名')` 按材质 `+0x200` 的串找。这个串是材质名还是材质文件路径没查（d.ts 只写了 `index: Number`）。

---

## 10. 别的相关串与发现

| 位置 | 内容 | 说明 |
|---|---|---|
| dll `0x1819a3120`–`0x1819a3138` | `model` `text` `light` `camera` | `createLayer` 类型键（另 4 个在 `0x1819a2bb8`–`0x1819a2be4`：`particle` `sprite` `image` `sound`） |
| dll `0x1819a3140` / `0x1819a3168` | 两个缺省模型 | 第 1.2 节 |
| dll `0x1819a3184`–`0x1819a31b4` | `models` `.json` `particles` `materials` `sounds` | 字符串路径分类 |
| dll `0x1819a2bd4` `0x1819a2bdc` `0x1819a2bf0` `0x1819a2bf8` `0x1819a2c00` `0x1819a2c08` | `font` `path` `effects` `file` `passes` `textures` | 配置遍历的键 |
| dll `0x1819a3a80` | `workshop` | `RP`（另有两个静态初始化把它转成宽串，没被用到） |
| dll `0x1819a3b60` | `registerAsset can only be called from global scope.` | 第 3 节 |
| dll `0x1819a31c0`、`0x1819a2d00`–`0x1819a2f60` | `__modelDataToken`、`IModelData` 的报错串 | `createModelData` 一族，P6d 不做 |
| dll `0x181aaa160` | RTTI `<lambda_1>@CallbackCreateLayer@SceneScriptAdapter` | 遍历用的 `std::function`（虚表 `0x1819a32e8`），证实回调类名 `SceneScriptAdapter` |
| exe `0x14048e5bc` | `id` | `getInitialLayerConfig` 去掉的键 |
| exe `0x1404902a8` | `Invalid parent configuration.` | `setParent` 失败 |

- `createLayer` 能建的类型由 exe 工厂决定。dll 的字符串分支只产出 5 种键；对象分支只在「无类型键」时补纯色层，`text` / `light` / `camera` 键原样交出去。
- 2048 个对象的上限在 exe 的 `H+0x30`（`O` 长度 × 8 ≥ `0x4000` 返回空 → `null`）。
- `stringifyConfig` 是 `_Internal` 上的普通属性，脚本可以改写它，从而影响 `createLayer` 的对象分支——仅作记录。

---

## 未查清

1. exe 资源文件系统 `[R+0x1898]->vtbl+0x28` 是不是「存在」查询、查哪些位置（工程目录、`scene.pkg`、`assets`）。它决定 `__workshopId` 改不改写。
2. 登记资源表（引擎槽 25）在 exe 里的消费者：25 处 `+0xc8` 虚调用都不是，precache 到底有没有效果。
3. `G+0x158`（`O`）的组成与顺序：是不是全部对象（含灯、相机、子对象）、是不是绘制顺序。决定我们的 `getLayerIndex` 现返回 `objects` 下标对不对——归 exe 侧文档。
4. 新建图层的 `obj+8`（ID）、`obj+0x1d8`（名字）、`obj+0x1b0`（初始配置）由谁赋值；配置里 `script` 字段何时 `LoadScript` / `init`——exe 侧。
5. `getTransformMatrix` 的 `obj+0xe0` 是世界还是本地、含不含 `alignment` 与视差——exe 侧。
6. `getMaterial('串')` 比较的材质 `+0x200` 是材质名还是路径。
7. 场景 `G+0xe0` bit3（选 `solidlayer_depthtest`）由什么置位。
8. 引擎槽 26 返回的 `Sd+0xe0` 是什么（推测是 `requestFeatures` 的结果）。
9. `0x180034ab0` 是 `v8::Exception::Error` 还是别的构造函数（原生上下文槽 `0x427`）。
10. `0x1817465c4` 是 `strtol` 还是 `strtoul`（只影响负数 ID 串）。
11. `textures` 数组里的 `null` 元素经遍历会不会被改成字符串（`asString` 前没看到类型检查，只在原路径不存在且有 id 时才会改）。

## 建议的实测

工程用 `kbp gen`，场景 1920 × 1080 正交。脚本一律 `console.error('[kbp]', …)` 写进 `log.txt`；跨帧的项在 `update` 里用帧计数分段，第 1、2、3 帧各打印一次。

1. **返回值与参数形态**（最优先）
   ```js
   export function init() {
     const L = (...a) => console.error('[kbp]', ...a);
     const n0 = thisScene.getLayerCount();
     const a = thisScene.createLayer();                        // 预期：对象（纯色层）
     const b = thisScene.createLayer(1, 2);                    // 预期：对象（也是纯色层）
     L('arg', a !== null, b !== null, thisScene.getLayerCount() - n0,
       thisScene.createLayer(5), thisScene.createLayer(undefined), thisScene.createLayer('fonts/x.ttf'),
       thisScene.createLayer([1]), thisScene.createLayer(new Vec3(1, 2, 3)));   // 预期：2 null null null null null
     const c = thisScene.createLayer({ color: '1 0 0' });       // 预期：纯色红层
     const d = thisScene.createLayer({ origin: '100 100 0' });  // 不补缺省模型，看 exe 怎样
     L('cfg', c !== null, d, JSON.stringify(thisScene.getInitialLayerConfig(c)));
     const e = thisScene.createLayer('{"image":"models/util/solidlayer.json","color":"0 1 0"}');
     L('jsonstr', e !== null, e && e.color);
     L('same', thisScene.getLayer(thisLayer.name) === thisLayer, thisScene.enumerateLayers().includes(a));
     L('undef', thisScene.getLayer(), thisScene.getLayer('nope'), thisScene.getLayerByID(),
       thisScene.getLayerByID(1), thisScene.getLayerByID('1') !== null, thisLayer.getParent());
     // 预期：undefined null undefined null true（场景里有 id 1 的对象时）null
   }
   ```
   抓帧看 `a`、`b`、`c` 是否当帧出现、是什么样子；`depthtest` 版与否由场景 `G+0xe0` bit3 决定，打印不出来，看抓帧的材质。
2. **`__workshopId` 改写**：建 `models/workshop/123/bar.json`（引用一张已知纹理），工程根下**不放** `models/bar.json`。6 段脚本分别：
   - (a) `export let __workshopId = '123'` + `createLayer('models/bar.json')`；
   - (b) 同 (a) 但 id 写成数字 `123`；
   - (c) 同 (a) 但工程根下也放一份不同颜色的 `models/bar.json`；
   - (d) `createLayer({ image: 'models/bar.json' })`；
   - (e) `createLayer('models/workshop/999/bar.json')`；
   - (f) 不写 `__workshopId`。

   每段打印返回值是否为 `null`、`getInitialLayerConfig(返回值).image`。预期：
   - (a) (d) (e) 建出、`image` 为 `models/workshop/123/bar.json`；
   - (b) (f) `null`；
   - (c) 用根下那份（颜色区分）、`image` 不改。

   另加 `createLayer('models/bar.mdl')` 看分类成 `model`。
3. **`registerAsset`**：模块顶层
   ```js
   const h = engine.registerAsset('models/util/solidlayer.json', true);
   const h2 = engine.registerAsset('models/util/solidlayer.json');
   let t; try { (() => engine.registerAsset('x'))(); } catch (e) { t = e.name; }
   export function init() {
     console.error('[kbp] ra', typeof h, h, h2, t);
     try { engine.registerAsset('y'); } catch (e) { console.error('[kbp] ra-init', e.name, e.message); }
     console.error('[kbp] ra-create', thisScene.createLayer(h) !== null);
   }
   ```
   预期 `string models/util/solidlayer.json null undefined`（顶层的函数里能调），`SyntaxError registerAsset can only be called from global scope.`，`true`。
4. **`destroyLayer` 的时间线**：`init` 里建 `x = createLayer({color:'0 0 1', name:'tmp'})`；第 1 帧 `update` 里 `ok = thisScene.destroyLayer(x)`、`ok2 = destroyLayer(x)`，紧接着打印：
   - `isObjectValid(x)`、`x.name`、`x.alpha = 0.5` 之后再读、`getLayer('tmp')`、`getLayerIndex(x)`、`getLayerCount()`、`enumerateLayers().map(l => l.name)`；
   - 第 2、3 帧再打印同样几项。

   预期第 1 帧 `true true`、`isObjectValid` 真、名字可读、写入生效、`getLayer('tmp')` 为 `null`、`getLayerIndex` ≥ 0、计数已减；第 2 帧起 `isObjectValid` 假、`x.name` 为 `undefined`、`getLayerIndex(x)` 为 `-1`。另测 `destroyLayer('不存在')`、`destroyLayer()` 都是 `false`；`destroyLayer(数字下标)` 能删。抓第 1、2 帧看 `x` 当帧是否还画（exe 侧）。
5. **下标一致性**：打印加载时 `enumerateLayers().map(l => l.name + ':' + thisScene.getLayerIndex(l))` 与 `getLayer(i).name`（i 从 0 到 `getLayerCount() − 1`）。场景里放灯、相机、带子层的组、声音、粒子，看 `O` 含不含它们、顺序是否就是 `scene.json` 顺序。

   再测 `sortLayer`：
   - `sortLayer(y, 0)`、`(y, -1)`、`(y, 1.7)`、`(y, '1')`、`(y)` 的返回值与之后的名字序列。预期 `'1'` 与缺参数为 `false`，`-1` 插到末尾，1.7 当 1。
   - 语料写法 `sortLayer(bar, getLayerIndex(thisLayer))` 之后的序列，并抓帧看 `bar` 在 `thisLayer` 上面还是下面。
6. **`getInitialLayerConfig` 的形状**：对一个带 `{script}`、`{user}` 绑定和 effect 的图层，打印：
   - `JSON.stringify(cfg)`、`'id' in cfg`；
   - `cfg === getInitialLayerConfig(同一层)`；
   - 改 `cfg.origin` 后再取一次是否不变；
   - 对 `createLayer` 返回的图层取一次。

   预期没有 `id`、每次新对象、带原样绑定。
7. **层级与矩阵**：父子两层（子层 `origin` `100 0 0`，父层 `origin` `500 300 0`、`angles` `0 0 90`）。打印：
   - `child.getParent() === parent`、`parent.getParent()`（预期 `null`）、`parent.getChildren().map(c => c.name)`（新数组、顺序）；
   - `child.getTransformMatrix().m.join(' ')`、`Object.getPrototypeOf(m) === Mat4.prototype`、`Object.keys(m)`；
   - 设了 `alignment` 的图层的矩阵。

   再测：
   - `child.setParent(undefined)` 后 `getParent()`；
   - `child.setParent(parent, true)` 前后的 `getTransformMatrix`；
   - `try { child.setParent(child) } catch (e) { e.name, e.message }`，预期 `Error Invalid parent configuration.`。
8. **effect**：图像层挂两个同名 effect 加一个别名的。打印：
   - `getEffectCount()`、`getEffect(0).name`、`getEffect('同名') === getEffect(1)`（预期取最后一个）、`getEffect(1.5)`、`getEffect(-1)`、`getEffect('')`；
   - 写 `getEffect(0).name = 'zz'` 后 `getEffect('zz') === getEffect(0)`；
   - `getEffect(0).getMaterialCount()`、`getMaterial(0)`；
   - 在该 effect 某个常量上挂脚本打印 `thisObject === thisLayer.getEffect(0).getMaterial(0)`；
   - `setMaterialProperty('常量名', 0.5)` 与整数 `1`、`new Vec2(1, 1)`（类型不符）后读回 `getMaterial(0).<常量名>`。

   粒子层上 `typeof thisLayer.getEffect`（预期 `undefined`）。
9. **顶层报错文案**：模块顶层分别 `try` 调 `getLayerByID('1')`、`getInitialLayerConfig(0)`、`createLayer()`，打印 `e.name + ' ' + e.message`。预期 `getLayer cannot be called…`、`destroyLayer cannot be called…`、`createLayer cannot be called…`，都是 `SyntaxError`。
10. **克隆写法**：`createLayer(thisLayer)`（图像层上、文本层上各一次），打印返回值与 `getInitialLayerConfig(返回值)`，抓帧看建出什么。预期图像层得到纯色层、字段值来自原层。
