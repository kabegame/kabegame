> 逆向原始记录，代理写的，dll 地址按基址 `0x180000000`（Ghidra），全部没有实测。范围是 `scenescript64.dll` 侧的 `IModelData` 一族：`thisScene.createModelData` / `destroyModelData`、`IModelData` 对象的 `applyData` / `replaceData`、`createLayer` 对 `IModelData` 参数的处理，以及 dll 调宿主接口 `H+0x50` / `H+0x58` / `H+0x60` 时传出去的参数形状。exe 怎么用这些参数（建 `MDLV0011`、token 怎么生成、错误码何时返回、拷贝与上传时机、引用计数）归并行的 `rea-p14-exe.md`，接口重叠处以那份为准。沿用 `rea-p6c-script.md` / `rea-p6d-script.md` 的命名（`E`、`A`、`H`、`RP`）。

# WPE 2.8.42 场景脚本 `IModelData` 一族的静态逆向（dll 侧）

**概括**
1. **`createModelData(config)`**（回调 `0x1816361f0`）：
   - **作用域**：模块顶层调抛 `SyntaxError: createModelData cannot be called from global scope.`；`init`、`update`、别的回调里都能调（没有 `E+0x62c` 检查）。【确】
   - **参数**：`argc < 1` 或第一个参数不是对象（`IsObject`，`0x180016c40`：数组、函数也算对象）**返回 `null`、不抛错**；多余参数忽略。【确】
   - **两种写法都收**：先取 `config.shapes`，**是数组**（`IsArray`）就逐个元素当形状；不存在、取值抛错或不是数组，就把 `config` **本身当成一个形状**（`0x18162fd40`）。数组为空 → 抛 `Shapes missing.`。数组元素取值包在 `TryCatch` 里，取某个元素抛错就**静默停在那里**（前面的照收）。【确】
   - **包围盒**：`boundingBoxMins`、`boundingBoxMaxs` **两个都是对象**才生效，读各自的 `.x .y .z`，是 Number 才取（转 float），否则该分量为 0——**不要求是 `Vec3`**，`{x,y,z}` 也行；只给一个、或不是对象，就当没给（`desc+0xc = 0`），没有报错。【确；`.x` 的 getter 抛错会让 `ToLocalChecked` 直接致命】
   - **每个形状**（`0x181630720`）：
     - 形状**不是对象**：是 `null` 只置「删形状」标志（`+0x12c`）；其它（`undefined`、数字、空洞）什么都不填。**两者都算成功、创建模式下也不报错**，交给 exe 一个全零的形状。【确】
     - `vertexBuffer` **必须是 `Float32Array`**（`JSTypedArray::type() == 8`，`0x180016a40`），否则创建模式抛 `Vertex buffer missing.`。**dll 不查长度与 stride 的关系**，只交字节长度。【确】
     - `indexBuffer`：`Uint16Array` → `+0x18` 指针，`Uint32Array` → `+0x10` 指针，两者共用 `+0x20` 字节长度；`null` → `+0x24` 标志；**别的类型（`Int16Array`、普通数组等）和不写一样，静默忽略**；可省。【确】
     - `vertexFormat`：数组，元素按字符串**精确匹配（区分大小写）**查表 `position→0x1`、`normal→0x2`、`tangentSigned→0x4`、`uv→0x8`、`color→0x8000`，**按位或**进 `+0x28`。**不查顺序、不查重复**（或运算）；不认识的字符串静默跳过；遇到第一个非字符串元素就停止扫描（不报错）；不是数组等于没给。创建模式下结果为 0（含空数组、全是不认识的串）抛 `Vertex format missing.`。报错串 `Vertex format in incorrect order.` 只在表值为 0 时抛，五个表值都非零，**走不到**。stride 与布局由 exe 按位算（归 exe）。【确；「表只在静态初始化时建」由引用点推出】
     - `material`：**只收字符串**（`registerAsset` 的返回值本来就是字符串），否则创建模式抛 `Material missing.`；**没有缺省值**（空串 `""` 是字符串，能过 dll）。按 UTF-8 写进 `+0x2c` 的 256 字节缓冲（最多 255 字节 + NUL，`WriteUtf8V2`），再经 `RP(E, key = null)` 做 `__workshopId` 改写（`0x181630e87`），结果截到 255 字节写回。【确；`WriteUtf8V2` 的 API 身份【推】】
     - `isVertexBufferDynamic` / `isIndexBufferDynamic`：**只认 JS 布尔**（`IsBoolean`），值进 `+0x0c` / `+0x25`；缺省或不是布尔（如 `1`）时置「未给」标志 `+0x0d` / `+0x26`，值保持 0。【确】
   - **失败**：上面的 dll 校验抛 `SyntaxError`（与作用域错误同一个 `Exception::SyntaxError`，`0x1800387a0`），返回值槽不写；exe 返回非 0 错误码时按 14 项表取文字（第 9 节），同样抛 `SyntaxError`。都不返回 `null`。【确】
   - **字节怎么交给 exe**：`H+0x50(H, &desc, &err)` → `uint32 token`。`desc` 是 dll 栈上的 0x28 字节结构，`desc.shapes` 指向 dll 自己的 `std::vector<Shape>`（元素 0x130 字节，第 5 节）。**顶点 / 索引是借用指针**：`BackingStore::Data() + ByteOffset`，取完就释放 `shared_ptr<BackingStore>`，dll 不拷贝；调用返回后 vector 立即释放，dll 不保留任何指针——所以 exe 必须在这次同步调用里自己拷走（或当场上传）。【确；「exe 必须当场拷」【推】】
   - **返回对象**：`ObjectTemplate::NewInstance`（模板 `A+0x28`：3 个内部字段，实例自有属性 `applyData`、`replaceData`）；
     - 内部字段 0 = `A`（thisScene 适配器指针，标签 1），字段 1 = `Integer::NewFromUnsigned(token)`，字段 2 = `Integer::New(0x4d4f444c 'MODL')`；
     - 自有属性 `__modelDataToken` = `Integer::New((int32)token)`——**是 Number，不是字符串**，属性特性 7（只读、不可枚举、不可删）；
     - 原型 = 构造 `thisScene` 那一刻取的全局 `IModelData.prototype`（baseclasses 的类，`toConfigString()` 返回 `this.__modelDataToken`）；
     - token 的格式、是否全局递增：dll 只是原样用 exe 返回的 `uint32`（归 exe）。
     
     【确】
2. **`applyData(arg)` / `replaceData(arg)`**（`0x181636b60` / `0x181636ef0`）：
   - **挂法**：IModelData 实例模板上的**自有属性**（`Template::Set`，特性 None：可写、可枚举、可删），不在原型上。【确】
   - **没有作用域检查、没有 `'MODL'` 检查**：只看 `this` 的内部字段数 ≥ 1，token 读**内部字段 1**（`Uint32Value`），与 `__modelDataToken` 属性无关。【确】
   - **参数**：与 `createModelData` 同一个解析函数，但传「更新模式」（第 6 参 0）：数组 / 单个形状两种写法同上；**缺 `vertexBuffer` / `vertexFormat` / `material` 都不报错**，对应字段留空（指针 0、格式 0、材质空串、动态标志「未给」）。`vertexBuffer` 不是 `Float32Array` 也只是当没给。`null` 形状、`indexBuffer: null` 照样只置标志交给 exe。参数不是对象时**不先检查**：`applyData()` / `applyData(null)` 会在 `Object::Get` 上留下 V8 的 `TypeError`，并照样交给 exe 一个空形状（`null` 时带删形状标志）。【确；`TypeError` 的产生【推：V8 `Runtime::GetObjectProperty` 对 null / undefined 抛错】】
   - **长度 / 格式 / 形状数不符**：dll 不比较，全由 exe 返回错误码，dll 按表抛 `SyntaxError`（`Vertex buffer size cannot increase`、`Cannot add shapes in IModelData.update` 等，第 9 节）。【确；哪个码何时返回归 exe】
   - **`replaceData` 在 `update` 里抛错**：看引擎的「当前回调编号」`E+0x62c`（`CallCallback` `0x18164e4d0` 进入时设、结束时复位成空闲值 `0x13`），**等于 1（`update`，含字段脚本的 `update`）就抛 `SyntaxError: IModelData.replace cannot be called in update.`**（文字是 `replace`）；别的回调、`init`、空闲时都放行。`applyData` 没有这个检查。【确】
   - **宿主接口**：两者都调 `H+0x58(H, &desc, token, replace, &err)`，`applyData` 传 `replace = 0`，`replaceData` 传 `1`；`desc` 与 `createModelData` 同形（包围盒也照读）。同样是借用指针、同步调用。【确】
   - 返回值一律 `undefined`。【确】
3. **`destroyModelData(x)`**（`0x181636890`）：
   - 模块顶层抛 `SyntaxError: destroyModelData cannot be called from global scope.`。【确】
   - **只认 Uint32 数字**（`IsUint32`，`0x1800170a0`：非负 Smi，或值恰为 uint32 的 HeapNumber），取值后调 `H+0x60(H, token)`，返回值不看。**传 `IModelData` 对象本身（d.ts 的写法，也是 Karin 的写法）→ `IsUint32` 为假 → 什么都不做、不报错**；要真正释放得传 `md.__modelDataToken`。其它类型、负数、小数、缺参数同样静默。返回 `undefined`。【确】
   - **作废后的句柄**：dll 不记任何状态，JS 对象的内部字段 1 与 `__modelDataToken` 永远保留；`destroyModelData(token)` 之后再 `applyData` 照样带旧 token 调 `H+0x58`，再 `createLayer({model: md})` 照样写出旧 token——结果归 exe（错误表里有 `Invalid model data token`）。【确：dll 侧无检查】
   - **GC**：`createModelData` 不为返回的对象建 `Global`、不 `SetWeak`，没有弱回调；JS 对象被回收时 dll 不通知 exe，模型数据不会被释放。【确】
4. **`createLayer` 的 `IModelData` 参数**（`0x181633290`，流程见 rea-p6d-script 1.2）：
   - **单参数 `IModelData`**：内部字段数 > 2 且字段 2 不是 `undefined`（`0x18162e580`）、`IsUint32` 且 `== 'MODL'` → 包成 `{model: md}`（`0x181633874`–`0x181633933`），再走对象分支。【确，沿用 p6d】
   - **配置对象里 `model: md`**：不特殊处理，和上面同一条路。【确】
   - 两种写法都经 `_Internal.stringifyConfig` → `stringifyAdapter` 调 `md.toConfigString()` → `__modelDataToken`（**Number**），所以 `model` 在 JSON 里是**整数**；然后 jsoncpp 解析、整理（`model` 不经 `RP`，有 `model` 键就不补缺省纯色层）、写回文本：`StreamWriterBuilder`（`commentStyle "None"`、`indentation ""`、`emitUTF8`、`precision 8`，`0x18162e730`）→ 紧凑 JSON、键按字典序。例：单参数是 `{"model":7}`；Karin 的普通部件是 `{"id":1000,"model":7,"name":"…","origin":"x y z","perspective":false,"scale":"x y z"}`。这段文本交给 `H+0x30`。【确；示例数字是假设的 token】
   - **`getInitialLayerConfig`**：dll 只对 `H+0x48` 返回的文本 `JSON.parse`；若 exe 存的就是工厂收到的这份 JSON（去掉 `id`），读回的 `model` 是那个**整数 token**，不是 `IModelData` 对象；拿它再 `createLayer` 等于用同一个 token。【推：exe 存什么归 exe】
5. **与 d.ts / baseclasses 的出入**（以二进制为准）：
   - d.ts `destroyModelData(modelDataHandle: IModelData)`：二进制只收数字 token，传对象是空操作（上面第 3 条）。
   - d.ts「顺序必须严格是 POSITION、NORMAL、TANGENT_SIGNED、UV、COLOR」：dll 只做按位或，不查顺序；顶点缓冲里的实际布局由 exe 按位决定。
   - d.ts 把 `POSITION` 等写成 `IModelData` 的实例只读成员：baseclasses 里是类的 `static`，`IModelData.POSITION` 有，`md.POSITION` 是 `undefined`。
   - d.ts「默认模型材质」：dll 创建时 `material` 必填（字符串），没有缺省。
   - d.ts 包围盒写 `Vec3`：任何带数字 `x/y/z` 的对象都行，两个都给才生效。
   - d.ts 说 `applyData` / `replaceData` 收 `Object|Array`：顶层直接传数组时，数组被当成「一个形状」（读的是数组自己的 `vertexBuffer` 等键）——`createModelData` 抛 `Vertex buffer missing.`，`applyData` / `replaceData` 等于交一个什么都没给的形状；多个形状只能写成 `{shapes: [...]}`。
   - 报错文字里的方法名是旧名：`IModelData.update`（即 `applyData`）、`IModelData.replace`（即 `replaceData`）。

**元数据**
- 目标：`D:\Applications\Steam\steamapps\common\wallpaper_engine\bin\scenescript64.dll`，SHA-256 `58039ef912fcd51cd833540476e3798268158a06f63003fe94bff1b1cbeaad08`（与 rea-p6d 同一份）。
- 工具：REA（Ghidra 12.1.4 headless，不带快照新开），`procedure_pseudo_code` / `procedure_assembly` / `read_bytes` / `search_bytes` / `xrefs`。没运行、没附加 WPE。只读了 WPE 的 `assets/scripts/jsclasses/baseclasses.js`、`ui/dist/monaco/autocomplete/lib.sceneScript.d.ts` 与样本脚本 `ignore/p14/0/karin.js` 的几处上下文。
- 导出：`ignore/p14/0/rea/dll/`
  - `1816361f0-createModelData.c`、`18162fd40-parseModelDataConfig.c`、`181630720-parseShape.c`、`181636b60-applyData.c`、`181636ef0-replaceData.c`、`181636890-destroyModelData.c`、`1816311d0-thisSceneCtor-modelData.c`（伪代码，关键处注了汇编地址；map 构造的内联代码略去）；
  - `v8-helpers.txt`（用到的 V8 API 小函数的身份与依据，含类型化数组 `Is*` 的 `ExternalArrayType` 对照）。
- 标记：【确】伪代码 / 汇编直接看到；【推】由代码推出，或依赖 V8 上游行为 / API 身份。

**命名**
- `E`：dll 引擎对象；`+0x1d8` isolate、`+0x1e0` context、`+0x1e8..` 预建串 `x` `y` `z`、`+0x3a0` 作用域栈、`+0x62c` 当前回调编号（空闲 `0x13`）。
- `A`：`thisScene` 适配器（0x38 字节，`0x1816311d0` 构造）：`[0]` `E`、`[1]` `&E.isolate`（= `E+0x1d8`）、`[2]` 场景、`[3]` `H`、`[4]` `E+0x400`、`[5]` IModelData 实例模板（`Global<ObjectTemplate>`）、`[6]` `IModelData.prototype`（`Global`）。存在 `thisScene` 与每个 IModelData 对象的内部字段 0（标签 1）。
- `H`：宿主接口（exe 场景 `G+0x48`，虚表 `0x14048ea50`）。
- `desc`：交给 `H+0x50` / `H+0x58` 的模型数据描述（第 5 节）；`Shape`：其中每个形状（0x130 字节）。
- `P(…)`：配置解析 `0x18162fd40`；`S(…)`：形状解析 `0x181630720`；`RP`：`0x181653460`。

---

## 1. 模板与原型（`thisScene` 构造 `0x1816311d0`）【确】
```
thisScene 模板：… createModelData → 0x1816361f0，destroyModelData → 0x181636890（FunctionTemplate，data 为空）
t = ObjectTemplate::New(isolate)          // FUN_18000a790
t.SetInternalFieldCount(3)                // FUN_18000c050
t.Set("applyData",   FunctionTemplate(0x181636b60), None)    // FUN_1800090f0(.., attrs 0)
t.Set("replaceData", FunctionTemplate(0x181636ef0), None)
A[5] = Global(t)
ctor = global.Get("IModelData")
if ctor && IsFunction(ctor):              // 0x180016480：map bit_field 的 is_callable 位
    A[6] = Global(ctor.Get("prototype"))
```
- 原型只在构造 `thisScene` 时取一次；baseclasses 是 `this.IModelData = class IModelData {…}`，所以 `md instanceof IModelData` 为真（除非脚本之后改了全局 `IModelData`，不影响已取的原型）。
- `applyData` / `replaceData` 每个实例都有，同一 context 里多半是同一个函数对象【推：V8 对 FunctionTemplate 按 context 缓存实例】。`Object.keys(md)` 是 `["applyData","replaceData"]`，`__modelDataToken` 不可枚举。

## 2. `createModelData`（`0x1816361f0`）【确】
```
A = this.内部字段0（标签 1）
if [[E+0x3a0] − 4] == 0: throw SyntaxError("createModelData cannot be called from global scope.")   // 名字串 0x1819a3048 + 后缀 0x1819a30f8
if argc < 1: return null
if !IsObject(arg0): return null
desc = {0}; vector<Shape> v
if !P(E, &E.isolate, arg0, &desc, &v, create = 1): return            // 已抛异常，返回值不写
if desc.count <= 0: return                                           // P 成功时不会发生
err = 0
token = H+0x50(H, &desc, &err)                                       // 0x181636558
if err != 0: throw SyntaxError(err < 14 ? TABLE[err] : "")           // 0x181636705..0x1816367ed
obj = A[5].NewInstance(ctx)                                          // 空 → 致命
obj.DefineOwnProperty(ctx, "__modelDataToken", Integer::New((int32)token), ReadOnly|DontEnum|DontDelete)   // 0x181636628，attrs 7
obj.SetPrototype(ctx, A[6])                                          // 0x181636682
obj.SetAlignedPointerInInternalField(0, A, 1)
obj.SetInternalField(1, Integer::NewFromUnsigned(token))
obj.SetInternalField(2, Integer::New(0x4d4f444c))
return obj
```
- 调用前后 dll 不登记这个对象（没有表、没有 `Global`、没有弱回调），之后所有方法只凭对象自己的内部字段工作。

## 3. 配置解析 `P`（`0x18162fd40`）【确】
签名：`bool P(E, &E.isolate, Local<Value>* arg, desc*, vector<Shape>*, bool create)`（Ghidra 只认 5 个参数，第 6 参在 `[rsp+0x30]`；`createModelData` 在 `0x181636514` 写 1，`applyData` 在 `0x181636d1d` 写 0）。
```
static unordered_map<string, uint32> MAP = {position:1, normal:2, tangentSigned:4, uv:8, color:0x8000}   // 线程安全静态初始化
s = arg.Get("shapes")                         // 不在 TryCatch 里；arg 不是对象时 V8 会抛 TypeError 并返回空
if s 空 || !IsArray(s):                       // IsArray = 实例类型 0x849
    if !S(ctx, arg): return false             // arg 本身当一个形状
else:
    for i in 0 .. s.length-1:
        TryCatch { e = s.Get(i) }             // 0x180012630 / 0x1800126a0：吞掉取值异常
        if e 空: break
        if !S(ctx, e): return false
lo = arg.Get("boundingBoxMins")
if lo 是对象:
    hi = arg.Get("boundingBoxMaxs")
    if hi 是对象:
        desc.mins = Vec3(lo); desc.maxs = Vec3(hi); desc.hasBounds = 1   // 0x181620090：x/y/z 是 Number 才取，否则 0
if v 为空: throw SyntaxError("Shapes missing."); return false
desc.shapes = v.data(); desc.count = v.size()   // (end−begin)/0x130，乘 0x286bca1b = 19⁻¹ mod 2³²
return true
```
- 形状解析上下文 `ctx`：`[0]` vector、`[1]` &context、`[2]` &isolate、`[3]` &create、`[4]` &E。
- 包围盒在更新模式里也照读，交给 `H+0x58`。

## 4. 形状解析 `S`（`0x181630720`）【确】
先 `emplace_back` 一个清零的 `Shape`（`+0x00/+0x08/+0x10/+0x18/+0x20` qword、`+0x28` dword、`memset(+0x2c, 0, 0x100)`、`+0x12c..+0x12f` 字节），再按参数填：

| 键 / 情况 | 接受 | 写到 | 不符时（创建模式） | 不符时（更新模式） |
|---|---|---|---|---|
| 形状本身不是对象 | `null` | `+0x12c = 1` | 不报错 | 不报错 |
| 同上 | 其它（`undefined`、数字、空洞…） | 什么都不写 | 不报错（全零形状） | 不报错 |
| `vertexBuffer` | `Float32Array`（含 RAB/GSAB 视图，实例类型 0x80d/0x80e） | `+0x00` 指针、`+0x08` 字节长 | `Vertex buffer missing.` | 当没给 |
| `indexBuffer` | `Uint16Array` | `+0x18` 指针、`+0x20` 字节长 | 静默忽略 | 静默忽略 |
| 同上 | `Uint32Array` | `+0x10` 指针、`+0x20` 字节长 | 同上 | 同上 |
| 同上 | `null` | `+0x24 = 1` | — | — |
| `vertexFormat` | 字符串数组 | `+0x28 |= 表值` | 结果 0 → `Vertex format missing.` | 不报错 |
| `material` | 字符串 | `+0x2c` char[256]，经 `RP` | `Material missing.` | 当没给 |
| `isVertexBufferDynamic` | 布尔 | `+0x0c` 值 | 不是布尔 → `+0x0d = 1` | 同左 |
| `isIndexBufferDynamic` | 布尔 | `+0x25` 值 | 不是布尔 → `+0x26 = 1` | 同左 |

- 判定函数的身份按实现核对过（`v8-helpers.txt`）：`0x180016a40` 是 `type() == 8`（Float32，因为 `0x180016b40` 是带 flag 检查的 Float16 = 7），`0x1800166c0` 是 `== 4`（Uint16），`0x1800167c0` 是 `== 6`（Uint32）。
- 取键用普通 `Object::Get`（走原型链与 getter）。除 `vertexFormat` 元素外，取值抛错不会被吞：异常留着、该键按「没有」处理、解析继续【推：V8 API 在异常挂起时照常返回空句柄】。
- `vertexFormat` 循环（`0x181630ad0`–`0x181630cc9`）：元素取值在 `TryCatch` 里；元素不是字符串（实例类型 ≥ 0x80）就 `break`；`Utf8Value` → `std::string` → FNV-1a 查表；命中则表值为 0 时抛 `Vertex format in incorrect order.`（`0x181630c94` `TEST EAX,EAX` / `JZ 0x181630d48`），否则 `OR [S+0x28], EAX`（`0x181630ca0`）。表值只有五个非零常量，该错误不可达。

## 5. 交给宿主的参数形状【确】

### 5.1 `desc`（dll 栈上，0x28 字节；`createModelData` 在 `rsp+0x70`，`applyData` 在 `rsp+0x30`）
| 偏移 | 类型 | 含义 |
|---|---|---|
| `+0x00` | `Shape*` | 形状数组（`std::vector` 的 data，连续，步长 0x130） |
| `+0x08` | `int32` | 形状数（> 0） |
| `+0x0c` | `uint8` | 包围盒有效（两个都是对象） |
| `+0x10` | `float[3]` | `boundingBoxMins` |
| `+0x1c` | `float[3]` | `boundingBoxMaxs` |

### 5.2 `Shape`（0x130 字节）
| 偏移 | 类型 | 含义 |
|---|---|---|
| `+0x000` | `const void*` | 顶点数据（`Float32Array` 的 `Data()+ByteOffset`，借用）；没给为 0 |
| `+0x008` | `uint32` | 顶点字节长（`ByteLength`） |
| `+0x00c` | `uint8` | `isVertexBufferDynamic` 的值 |
| `+0x00d` | `uint8` | `isVertexBufferDynamic` 未给（缺或不是布尔）= 1 |
| `+0x010` | `const void*` | `Uint32Array` 索引数据（借用）；否则 0 |
| `+0x018` | `const void*` | `Uint16Array` 索引数据（借用）；否则 0 |
| `+0x020` | `uint32` | 索引字节长（两种共用） |
| `+0x024` | `uint8` | `indexBuffer === null` |
| `+0x025` | `uint8` | `isIndexBufferDynamic` 的值 |
| `+0x026` | `uint8` | `isIndexBufferDynamic` 未给 = 1 |
| `+0x028` | `uint32` | 顶点格式位（`0x1` position、`0x2` normal、`0x4` tangentSigned、`0x8` uv、`0x8000` color 的或） |
| `+0x02c` | `char[256]` | 材质路径（UTF-8，NUL 结尾，≤ 255 字节，已经 `RP` 改写）；没给为空串 |
| `+0x12c` | `uint8` | 形状为 `null`（删形状） |
| `+0x12d..+0x12f` | — | 清零，dll 不用 |

### 5.3 三个槽
| 槽 | 调用者 | 参数 | 返回 |
|---|---|---|---|
| `H+0x50` | `createModelData`（`0x181636558`） | `(H, desc*, uint32* err)` | `uint32 token`；`*err != 0` 时 dll 不用 token、按表抛错 |
| `H+0x58` | `applyData`（`0x181636d7d`）/ `replaceData` | `(H, desc*, uint32 token, uint32 replace = 0 / 1, uint32* err)`（第 5 参在 `[rsp+0x20]`） | 不看；只看 `*err` |
| `H+0x60` | `destroyModelData` | `(H, uint32 token)` | 不看 |

- 三个调用都是同步的。调用返回后 dll 立刻释放 vector，顶点 / 索引指针指向的 `ArrayBuffer` 也不再被 dll 持有（`shared_ptr<BackingStore>` 在解析时就已释放；调用期间缓冲靠 JS 参数对象活着）。所以 exe 若要在调用之后使用字节，必须在调用里拷贝。【确；结论【推】】
- 「当场拷贝 / 帧尾上传 / 替换时的死锁」都在 exe 侧。

## 6. `applyData` / `replaceData`（`0x181636b60` / `0x181636ef0`）【确】
```
A = this.内部字段0（标签 1）          // 先于字段数检查执行：this 不是带内部字段的对象时慢路径会走到 V8 的 API 检查【推：致命】
if InternalFieldCount(this) < 1: return
[replaceData] if E+0x62c == 1: throw SyntaxError("IModelData.replace cannot be called in update."); return   // 0x181636fe0
token = this.内部字段1.Uint32Value(ctx)          // Nothing → 致命
arg = argc > 0 ? arg0 : undefined
desc = {0}; v = []
if P(E, &E.isolate, arg, &desc, &v, create = 0) && desc.count > 0:
    err = 0
    H+0x58(H, &desc, token, replace, &err)       // applyData: 0；replaceData: 1
    if err: throw SyntaxError(err < 14 ? TABLE[err] : "")
return                                           // undefined
```
- `E+0x62c` 的写入点（`search_bytes 2c060000`，`.text` 全段）：引擎构造 `0x18164807d` 置 `0x13`；`CallCallback`（`0x18164e4d0`）`0x18164e64e` 设为本次编号、`0x18164f752` 复位 `0x13`；读点只有 `replaceData`（`0x181636fe0`）与 `openUserShortcut`（`0x181656b88`），另 `0x18162fc32` 是没有引用的取值小函数。回调编号 1 = `update`（p3 报告的 0–3：`init`、`update`、`resizeScreen`、`destroy`）。
- `replaceData` 的限制只看编号，所以 `update` 里经同步调用链到达的 `replaceData` 一律抛错；`init`、`applyUserProperties`（4）、`destroy`（3）、光标与媒体回调里放行。
- `applyData` 的「只传部分键」：没给的键在 `Shape` 里是 0 / 空 / 「未给」，exe 据此判断哪些要改（归 exe）。在 `{shapes: [...]}` 里放 `undefined` 或空洞，得到的是全零形状，可用来「跳过第 i 个」【推：exe 把全零形状当不改】。

## 7. `destroyModelData`（`0x181636890`）【确】
```
if [[E+0x3a0] − 4] == 0: throw SyntaxError("destroyModelData cannot be called from global scope.")
if argc >= 1 && IsUint32(arg0):                  // 0x1800170a0
    H+0x60(H, arg0.Uint32Value(ctx))
return                                           // undefined
```
- `IsUint32` 对对象一律为假，所以 `thisScene.destroyModelData(md)` 不调宿主。Karin 两个 `destroy()` 里的四处调用（`karin.js` 字节偏移 2647973、2685243、2685352、2685468）都传 `IModelData` 对象：在 WPE 里这些模型数据**从不释放**（只影响内存，画面不受影响，图层本身由 `destroyLayer` 删）。
- 作废的句柄、重复 destroy、不存在的 token：dll 都照传，结果归 exe。

## 8. `createLayer` 与 `getInitialLayerConfig`
- `'MODL'` 判定与包装：rea-p6d-script 1.2（`0x181633874`–`0x181633933`），判定函数 `0x18162e580(obj, 2)` = `InternalFieldCount > 2` 且字段 2 不是 Oddball kind 4（`undefined`）；再 `IsUint32`、`Int32Value == 0x4d4f444c`。【确】
- 之后 `_Internal.stringifyConfig({model: md})`：`JSON.stringify` 的替换器对 `md` 调原型上的 `toConfigString()` → `this.__modelDataToken`（Number）→ `"model": <整数>`。若脚本改掉了原型的 `toConfigString`，或原型没取到（`A[6]` 为 0），`md` 会按普通对象序列化（自有可枚举属性只有两个函数，被跳过）成 `{}`。【确；后半句【推】】
- 整理与写回：有 `model` 键，不补 `image`；`model` 不在 `RP` 遍历表里；`0x18162e730` 写成紧凑 JSON（`precision 8` 只影响浮点，token 是整数原样）。交给 `H+0x30`。【确】
- `getInitialLayerConfig`（rea-p6d-script 第 7 节）：dll 只 `JSON.parse(H+0x48 的文本)`，`model` 是什么取决于 exe 存的 JSON【推：整数 token】。

## 9. 报错串（`.rdata`，全部经 `Exception::SyntaxError` 抛出）

### 9.1 exe 错误码 → 文字（`createModelData` / `applyData` / `replaceData` 共用一张 14 项的表；码 ≥ 14 或 0 时文字为 `""`，`0x1819a33f7`）
| 码 | 地址 | 原文 |
|---|---|---|
| 1 | `0x1819a2c30` | `Invalid material` |
| 2 | `0x1819a2c48` | `Shader expecting more vertex data.` |
| 3 | `0x1819a2c70` | `Inconsistent vertex buffer size` |
| 4 | `0x1819a2c90` | `Invalid model data token` |
| 5 | `0x1819a2cb0` | `Vertex buffer size cannot increase` |
| 6 | `0x1819a2cd8` | `Index buffer size cannot increase` |
| 7 | `0x1819a2d00` | `Model data not created as dynamic` |
| 8 | `0x1819a2d28` | `Buffer lock failed` |
| 9 | `0x1819a2d40` | `Incorrect index buffer type` |
| 10 | `0x1819a2d60` | `Cannot add shapes in IModelData.update` |
| 11 | `0x1819a2d88` | `Cannot delete shape or buffers in IModelData.update` |
| 12 | `0x1819a2dc0` | `Material cannot be changed in IModelData.update` |
| 13 | `0x1819a2df0` | `Vertex format cannot be changed in IModelData.update` |

另有一个同形的取文字小函数在 `0x18162fc70`（没有引用，三个回调都是内联的表）。

### 9.2 dll 自己的校验
| 地址 | 原文 | 何时 |
|---|---|---|
| `0x1819a2e38` | `Vertex buffer missing.` | 创建模式，`vertexBuffer` 不是 `Float32Array` |
| `0x1819a2e70` | `Vertex format in incorrect order.` | 不可达（表值为 0 时） |
| `0x1819a2e98` | `Vertex format missing.` | 创建模式，格式位为 0 |
| `0x1819a2ec0` | `Material missing.` | 创建模式，`material` 不是字符串 |
| `0x1819a2f60` | `Shapes missing.` | 任何模式，一个形状都没解析出来 |
| 运行时拼接 | `createModelData cannot be called from global scope.` | 模块顶层 |
| 运行时拼接 | `destroyModelData cannot be called from global scope.` | 模块顶层 |
| `0x1819a31d8` | `IModelData.replace cannot be called in update.` | `replaceData`，当前回调编号 1（判定在 `0x181636fe0`） |

### 9.3 键名串
`vertexBuffer` `0x1819a2e28`、`indexBuffer` `0x1819a2e50`、`vertexFormat` `0x1819a2e60`、`material` `0x1819a2eb0`、`isVertexBufferDynamic` `0x1819a2ed8`、`isIndexBufferDynamic` `0x1819a2ef0`、`position` `0x1819a2f08`、`tangentSigned` `0x1819a2f18`、`uv` `0x1819a2f28`、`color` `0x1819a2f2c`、`shapes` `0x1819a2f34`、`boundingBoxMins` `0x1819a2f40`、`boundingBoxMaxs` `0x1819a2f50`、`__modelDataToken` `0x1819a31c0`；`normal` 是立即数（`0x6c616d726f6e`），不在串表里。

---

## 实测对照（2026-11-20）

背景：测试工程 `ignore/p14/0/proj/p14-api` 跑到 S14 的 `replaceData` 一段（第一轮最后的日志是 S14t，第二轮是 S14p / S14s；日志是缓冲写出的）时 WPE 两次崩溃。转储 `ignore/p14/0/crash/wallpaper64.exe.880540.dmp`：`c0000374` 堆损坏，在 `ntdll!RtlFreeHeap` 检测到。按 Ghidra 地址的栈（从内到外）：`0x18178f9ac`（free）← `0x1801154be` ← `0x180114ae1` ← `0x1801155e6` ← V8 内置 ← `0x18013a110` ← `0x180139231` ← `0x1800232bd` ← `0x180023458` ← exe `0x140172bd3`（场景构造里跑脚本 `init`）。S1–S12、S14a–S14n 两轮都跑到，结果和上文的读码一致。下面两问只读了 dll，没运行 WPE。

### 1. 释放点是 V8 的惰性编译，不是脚本 API
- `0x1801154be` 是 `FUN_180115050` 末尾 `call 0x1816b3a40`（`operator delete`，`0x1801154b9`）的返回地址，释放的是这个函数的局部 `std::vector`：begin 在 `[rsp+0x60]`、cap 在 `[rsp+0x70]`（`0x180115489`–`0x1801154b9`）。【确】
- 这个 vector 一开始只 `push_back` 了一个 8 字节元素 `parse_info->literal()`（`param_3+0x78`，`FUN_180122b20`），之后循环 `pop_back` 并编译每个 `FunctionLiteral`，编译中可能再压入需要立即编译的内层函数。与 V8 `compiler.cc` 的 `IterativelyExecuteAndFinalizeUnoptimizedCompilationJobs` 逐段对应：开头 `DeclarationScope::AllocateScopeInfos`（`FUN_18069c6c0`），`functions_to_compile.push_back(parse_info->literal())`，执行 / 收尾编译任务（`FUN_180122a10` / `FUN_18011edd0`，返回 0 / 1 / 2 对应 SUCCEEDED / FAILED / RETRY_ON_MAIN_THREAD），最后析构 vector。**所以「8 字节的 vector」就是 `std::vector<FunctionLiteral*> functions_to_compile`，只装了一个函数字面量的指针。**【确：vector 的形状与释放点；函数身份【推】，依据是结构逐段对应】
- `0x180114ae1` 在 `FUN_1801144c0`（`Compiler::Compile(Isolate*, Handle<SharedFunctionInfo>, …)`【推】），`0x1801155e6` 在 `FUN_180115530`（`Compiler::Compile(Isolate*, Handle<JSFunction>, …)`【推】：内有 `Check failed: !code->is_optimized_code()`，并把代码写进 JS 分派表 `isolate+800`）。上面一串 V8 内置是 `CompileLazy` → `Runtime_CompileLazy`【推】。
- 也就是说：**这一刻 JS 正在第一次调用一个还没编译的函数**（测试脚本里每个 `safe('…', () => …)` 的箭头函数都是在第一次被调时才惰性编译的），V8 为编译分配又释放一个 8 字节块，`RtlFreeHeap` 在这个块上发现堆已经坏了。**这里没有任何脚本 API 的原生代码**，`createModelData` / `applyData` / `replaceData` 的辅助函数都不在栈上。破坏发生在更早，这次释放只是第一个碰到它的地方。【确：栈上没有 `0x1816xxxxx` 的宿主帧；「更早」【推】】
- 按 LFH 的分档，8 字节请求落在最小的块档里。这类「刚分配就被检测到坏」的情况，通常是更早有代码写过了同档里一块相邻小块的末尾，或者往一块已释放、随后被复用的小块里写过（释放后写入）。【推】

### 2. dll 侧的 `IModelData` 代码没有越界写堆
- **形状 vector**：每次形状解析 `S`（`0x181630720`）正好一次 `emplace_back`。快路径在 `end != cap` 时就地清零 0x130 字节；满了走 `FUN_18163a020`，这是标准的 MSVC `_Emplace_reallocate`：新容量取 max(size+1, cap×1.5)，按 0x130 计算、整体 memcpy、清零新元素，旧块按容量释放。之后只往 `S = end − 0x130` 这一个元素里写，偏移都在 `+0x00`…`+0x12f` 以内。形状数取 `(end−begin)/0x130`；三个回调释放时按 `(cap−begin)` 计算大小（`0x181636816`–`0x18163681e`、`0x181636e8d`–`0x181636e95`），一致。【确】
- **几条分支**：「顶层传数组」（S4）和「`shapes` 不是数组」（S3c）都只把参数本身当一个形状，调一次 `S`；「`vertexFormat` 遇到非字符串就停」（S8d）只是 `break` 出格式循环；乱序和重复（S8a / S8b）只是对 `+0x28` 做 `OR`。这几条都不改变「一个形状一次 `emplace`」，也没有别的写入。【确】
- **材质截断**（S9d）：`FUN_180024c80` 把 isolate 的 VM 状态临时设成 5，再调 `i::String::WriteUtf8(isolate, str, buf = S+0x2c, capacity = 0x100, flags & 3, nullptr)`，也就是 `WriteUtf8V2`。带 `kNullTerminate` 时最多写 255 字节加 NUL，落在 `S+0x2c`…`S+0x12b`。`RP` 的结果再按 `min(len, 0xff)` 拷回，NUL 写在 `S+0x2c+len ≤ S+0x12b`（`0x181630f54`–`0x181630f70`）。【确；V8 那一侧「先给 NUL 留位」【推：V8 源码】】
- **`RP` 改写**：只用 `std::string` / `std::filesystem::path`，外加一次 exe 的存在性查询，没有定长缓冲。测试工程没有导出 `__workshopId` 时，`RP` 在「当前脚本 id 为空」处直接把原串拷给输出。【确：rea-p6d-script 2.2；「测试工程没有 id」【推】】
- **格式解析**：`String::Utf8Value`（V8 自己按长度 + 1 分配）→ `strlen` → `std::string`，没有定长缓冲。【确】
- **其它写入都在栈上**：`desc` 0x28 字节；`Vec3` 读出的 12 字节写进 16 字节的局部变量；错误串表也在栈上。每个类型化数组的 `GetBackingStore` 只拿一次 `shared_ptr`，也只释放一次，计数没有多减。【确】
- 其余几条：S2e 的多余参数从不读取；S12i 是对只读属性赋值，由 V8 在严格模式下自己抛 `TypeError`，dll 不参与。【确】
- **结论：在这些调用里，dll 侧没有越界写堆的地方。**
- **给 exe 侧的线索**【推】：dll 交出去的顶点 / 索引指针，指向的是 V8 的 `ArrayBuffer` 后备存储。测试里常见的小数组（`new Float32Array(12)` 48 字节、`new Uint16Array([0,1,2])` 6 字节）原本放在 V8 堆内（不超过 V8 的 `typed_array_max_size_in_heap`，缺省 64）；第一次 `Buffer()` 时才物化到 CRT 堆上，大小与那个 8 字节 vector 是同一档的小块。dll 在调用之后不再持有这些块：参数对象没人引用以后，GC 就会把它们释放，地址可以被复用。exe 若在 `H+0x50` / `H+0x58` 返回之后还保留这些指针并往里写，或按别的长度（例如把 16 位索引当 32 位）往里写，正好会破坏这档小块。这条要 exe 那份核对，dll 这边看不出来。

---

## 未查清
1. **exe 侧的一切**（归 rea-p14-exe）：token 的生成规则与取值范围（dll 把它当 `uint32`，`__modelDataToken` 用 `Integer::New((int32)…)`，≥ 2³¹ 时属性会是负数而内部字段 1 是正数——只在 token 很大时有影响）；格式位 → stride / 顶点布局；全零形状、`null` 形状、`indexNull`、「未给」标志在创建 / 更新 / 替换三种情形下各怎么处理；每个错误码的触发条件；拷贝与上传时机；`destroyModelData` 后图层与数据的引用计数。
2. **计时器与 Promise 续体里的 `E+0x62c`**：只在 `CallCallback` 里改它。计时器回调若不经 `CallCallback` 派发，编号保持 `0x13`、`replaceData` 放行；若 V8 的微任务在 `update` 的 `Function::Call` 返回前跑（`kAuto` 策略），`update` 里排的 `async` 续体里调 `replaceData` 也会抛错。两者都没核对。
3. **异常挂起时的连锁行为**：`applyData()` / `applyData(null)` 这类参数不是对象的调用，V8 `Object::Get` 抛的 `TypeError` 与随后 exe 返回错误码时 dll 再抛的 `SyntaxError` 哪个最终留给脚本，没核对（V8 的 `ThrowException` 会覆盖挂起的异常【推】）。
4. **`A[6]` 为空时**：全局 `IModelData` 在构造 `thisScene` 时不存在（baseclasses 未加载或被改）的话，`SetPrototype` 收到空句柄的结果没查；正常加载顺序下不会发生【推】。
5. **`this` 不是 IModelData 时**：`md.applyData.call(其它对象)` 在字段数检查之前就取内部字段 0，可能触发 V8 的 API 检查致命；`call(thisScene)`（1 个内部字段）会读越界的字段 1。都只由代码推出。
6. **`material` 为 `""` 时的 `RP`**：空路径经「原路径在不在」查询后的改写结果没细推（只在有 `__workshopId` 时发生）。
7. **`0x181638520` 等对静态 map 的其它引用**：看了一个（从初始化列表重建同一张表），其余（`0x1816397c4`、`0x18163a363` 等）按位置判断是 map 的插入 / rehash / 析构实例，没逐个核对；不影响「顺序错误不可达」的结论，除非有代码往表里写 0。
