> 逆向原始记录，代理写的，dll 地址按基址 `0x180000000`，exe 地址按 `0x140000000`，全部没有实测。范围是 `scenescript64.dll` 侧：`layer.getTextureAnimation()` 怎样从 JS 走到 exe、返回对象 `ITextureAnimation` 的 JS 包装（身份、成员、顺序、读写转换、方法桩、作废）。帧表动画本身怎么推进、怎么画、共享计时器是什么归并行的 `rea-p6e-sheet.md`（exe 侧）；本文顺带看到的 exe 事实都标了「exe 侧」，重叠处以那份为准。

# WPE 2.8.42 `getTextureAnimation` / `ITextureAnimation` 的静态逆向（dll 侧）

**概括**
1. **入口不是 dll 回调，没有宿主接口槽**：dll 里没有 `getTextureAnimation` 这个串。它是 exe 图像层类（虚表 `0x1404911a8`）方法表 `0x1404e8620` 里的反射方法（原生 `0x14020e670`，返回类型 `0x800`，无参数），JS 调用走 dll 的通用方法入口 `0x18162baf0` → 通用方法桩 `M`（`0x1816214a0`），`M` 直接调方法条目里的 exe 函数指针，**不经 `H` 的任何槽**。`ITextureAnimation` 的 7 个方法、3 个字段同样是 exe 反射表里的函数指针，经 `M` / 通用字段存取调用。整套里唯一经宿主接口的是 dll 给所有包装统一挂的 `getAnimation`（`H+0x78`，见 9）。【确】
2. **返回 `null` / `undefined` / 抛错的情形**：
   - 槽 0 不是帧表（exe：图层还没有 `L+0x4c0`，且基础材质 `L+0x498` 的纹理槽 0 为空或纹理标志没有 `0x4`）→ exe 写空指针 → `M` 的 `0x800` 分支给 **`null`**（`0x181622f13` 写根值 `+0x378`）。【确；`+0x378` = `null` 与 P9 实测「非视频图层 `getVideoTexture()` 为 `null`」一致】
   - 图层类型不对：方法只登记在图像层的类表 `0x1404e8620`；文本层的方法表回落到图像基类 `0x1404e83a0`（p6c 4.3），粒子、声音、模型等回落到根表，都没有这个方法 → `typeof layer.getTextureAnimation === 'undefined'`，调用抛 `TypeError: … is not a function`。【确：登记位置；文本层等的结果【推】】
   - 图层包装已作废：`U(this)` 失败，入口直接返回，JS 得 **`undefined`**，不抛错。【确】
   - **没有作用域检查**：`M` 一族不看作用域栈，模块顶层调也不抛 `SyntaxError`。但 `LoadScript` 求值模块时只压「当前脚本」栈（`E+0x4f8`），不压 `thisLayer` / `thisObject` 栈，`thisLayer` 的取值器（`0x1816468c0`）栈空时给 `null`；`thisScene.getLayer` 等在顶层又抛 `SyntaxError`。所以正常场景里模块顶层根本拿不到图层对象，`thisLayer.getTextureAnimation()` 在顶层是 `TypeError: Cannot read properties of null`。【确：代码；「顶层 `thisObject` 为 `null`」P10 实测过，`thisLayer` 同理【推】】
3. **身份**：exe 把对象缓存在图层 `L+0x4c0`（第一次调用时 `new 0xf0`，以后原样返回），dll 的包装 `W` 再按 exe 指针缓存在 `E+0x528` 表（强引用 `Global`，从不 `Reset`）。所以**同一图层每次调用都是同一个 JS 对象**；两个图层即使共用同一张纹理，也是两个对象。`L+0x4c0` 与 `getVideoTexture()` **共用**：先调了哪个，后调的那个原样拿到前一个的对象（同一个 JS 对象），帧表图层上先 `getTextureAnimation()` 再 `getVideoTexture()` 会得到 `ITextureAnimation`，而不是 `null`。【确；共用槽是 exe 侧，P9 已记】
4. **成员与顺序**：包装是普通对象（原型 `Object.prototype`，2 个内部字段），11 个**自有、可枚举**成员，没有从基类继承的任何东西（没有 `getParent`、`name`、`id`，也**没有 `loop`**——d.ts 里注释掉了，exe 也没登记）。`Object.keys` 顺序按 rea-p6d1-keyorder 的模型推出：

   `frameCount, duration, rate, play, isPlaying, stop, pause, setFrame, getFrame, join, getAnimation`

   同一模型对 `IVideoTexture` 算出的 11 项与 P9 实测逐项相同，方法段与 P10 `IAnimation`、P12 `IAnimationLayer` 实测的同名方法顺序也相同（第 3.2 节）。【确：登记顺序、桶号；顺序本身【推，模型已用两组实测核过】】
5. **字段**（exe 字段表 `0x1404e8660`，dll 通用字段读 `0x1816208e0` / 写 `0x181620e10`）：
   - `frameCount`：类型 0（int）、只读位 → 读出 **JS 整数**（`Integer::New`）；值是帧表条目数（exe 侧）。
   - `duration`：类型 4（float）、只读 → 读出 **float32 扩成的 double**（如 `0.3333333432674408`）。
   - `rate`：类型 4、可写，缺省 `1.0` → 读出 float32 扩成的 double。写入**只收 JS number**（Smi 或 HeapNumber，含 `NaN`、`±Infinity`、`-0`），`cvtsd2ss` 转 float32（超出范围变 `±Infinity`，`0.1` 读回 `0.10000000149011612`）；字符串、布尔、`null`、`undefined`、对象（含 `new Number(2)`）**静默忽略**，不写、不调 exe、不抛错。和 P10 `IAnimation.rate`、P12 `IAnimationLayer.rate` 同一个分支。【确】
   - 只读字段没有 setter、属性标 `ReadOnly`，模块（严格模式）里赋值抛 `TypeError: Cannot assign to read only property 'frameCount' of object '#<Object>'`，值不变。【推：V8 行为；P9 `duration`、P12 `fps` 同一机制已实测抛 `TypeError`】
   - `rate` 每次写入（不论值变没变）exe setter 都调改值回调 `0x1401fa4a0`：新值 **≠ 1.0f**（含 `NaN`、`0`、`-0`、负数；比较前已是 float32，所以 `1.00000001` 算 1）且对象还「跟随共享计时器」时，把共享的当前帧拷进自己、**脱离共享**；写 `1` 不脱离，已脱离的写回 `1` 也不重新加入。（exe 侧，顺带看到）
6. **`setFrame(x)` 的参数**：exe 登记的形参类型是 `0x8`（int），`M` 对类型 8 只做 **`IsInt32`**（Smi，或 [−2³¹, 2³¹−1] 内的整数值 HeapNumber，`-0` 不算）：通过就原值；**不通过一律按「缺参数」传 0**（类型码 `0x80000008`），exe 的 `setFrame` 不看类型码，于是 `setFrame(2.5)`、`setFrame('2')`、`setFrame(true)`、`setFrame(NaN)`、`setFrame(2**31)`、`setFrame()` 全都等于 **`setFrame(0)`**——不是截断，也不是 `ToInt32`。负数、超过 `frameCount` 的整数原样交给 exe（`setFrame` 自己不钳制，怎么画归 exe 侧）。多余实参忽略。这与 `IAnimation` / `IAnimationLayer` 的 `setFrame`（形参 float，`setFrame(2.5)` 就是 2.5）**不同**。【确】
7. **方法**（exe 方法表 `0x1404e86a0`，全部经 `M`，没有参数的忽略全部实参）：

   | 方法 | exe 原生 | 返回 | dll 转换 | exe 行为（顺带，以 rea-p6e-sheet 为准） |
   |---|---|---|---|---|
   | `play()` | `0x1401fa330` | 1 | `undefined` | 置「播放」位 `A+0xe0 = 1`，**不改跟随 / 脱离** |
   | `pause()` | `0x1401fa340` | 1 | `undefined` | 跟随时先把共享的当前帧（`T+0x9c` 8 字节）拷进 `A+0xe8`；然后清播放位、置脱离 `A+0x48 = 1` |
   | `stop()` | `0x1401fa3a0` | 1 | `undefined` | `A+0xe8` 8 字节清 0（帧 0、计时 0）、置脱离、清播放位 |
   | `isPlaying()` | `0x1401fa3d0` | 2 | **布尔** | `!脱离 \|\| 播放位`：跟随共享时**恒为 `true`** |
   | `setFrame(n)` | `0x1401fa400` | 1 | `undefined` | `A+0xe8 = n`、`A+0xec = 0`；跟随时另外置脱离**并置播放位**（所以在播放中的动画上调接着播，在暂停的上调保持暂停） |
   | `getFrame()` | `0x1401fa430` | 8 | **JS 整数** | 脱离：`A+0xe8`；跟随：当前材质槽 0 纹理的 `T+0x9c`（取不到时退回 `A+0xe8`） |
   | `join()` | `0x1401fa490` | 1 | `undefined` | 清脱离位 `A+0x48 = 0`，`rate` / 播放位不动 |

   【确：dll 转换、exe 函数与字段读写；字段含义【推】，归 exe 侧】
8. **作废**：exe 的 `ITextureAnimation` 是 `IPropertyObject` 派生（析构 `0x140213130` 调基类析构 `0x1401a3b60`），`W` 建包装时登记的析构监听 `0x181653eb0` 会把它从 `E` 的两张表删掉。对象在两种时候被删：
   - 图层析构（图像层析构 `0x1401fb4e0` 先删 `L+0x4c0`）——`destroyLayer` 之后要到帧尾真正析构（rea-p6d-script 4.2）；
   - 图层槽 0 换成另一张纹理时（exe `0x140209360`：`L+0x4c0` 非空且其 `+0x50` 不是新纹理就删掉并清空）。之后再 `getTextureAnimation()` 会按新纹理重建（新 JS 对象，`!==` 旧的）或返回 `null`。

   作废后：读字段得 `undefined`、写字段静默忽略、7 个方法与 `getAnimation` 都返回 `undefined`（`isPlaying()` 也是 `undefined`，不是 `false`），都不抛错；`engine.isObjectValid(动画对象)` 为 `false`（有效时为 `true`）；`Object.keys` 仍列出 11 个名字（属性还在，只是取值器给 `undefined`）。`destroyLayer` 当帧（析构之前）一切照常。【确；`Object.keys` 一条【推】】
9. **`getAnimation`**：不在 exe 表里，是 `W` 给每个包装挂的 `0x18162bbe0`，调 `H+0x78`（exe `0x14018db00`）时属主取 `对象 vtbl+8()` = `[A+8]`。`ITextureAnimation` 构造时 `A+8 = 0`，而 exe 查找把属主 0 当「全场景」（P10 第 11 节：`thisScene.getAnimation` 就是传 0），所以 **`anim.getAnimation('名字')` 等于在全场景按 `options.name` 或属性名找关键帧动画**，找到返回 `IAnimation`，找不到返回 **`undefined`**（`thisScene.getAnimation` 找不到是 `null`）；不给字符串时名字取当前脚本所挂属性的属性名（如脚本挂在 `alpha` 上就找全场景第一条 `alpha` 动画）。`IVideoTexture` 同样 `V+8 = 0`，行为相同（P9 的测试场景里没有关键帧动画，所以只看到 `undefined`）。【确：dll 代码与 `A+8 = 0`；exe 查找语义沿用 P10【确】】
10. **与 `getVideoTexture` / `IAnimation` / `IAnimationLayer` 共用一套桩**：dll 里没有任何 `ITextureAnimation` 专用代码，包装、字段读写、方法调用、`getAnimation`、作废全是同一套通用路径（`W` `0x181652380`、`U` `0x181620620`、字段 `0x18162b990` / `0x18162bae0` → `0x1816208e0` / `0x181620e10`、方法 `0x18162baf0` → `M`、`0x18162bbe0`）。差异全部来自 exe 的登记表（第 7 节表格）：`setFrame` / `getFrame` 是 int（其余两类是 float）；有 `join`、没有 `addEndedCallback` / `loop` / `fps` / `name`；`rate` 有改值回调（`IAnimation` 没有）。【确】
11. **边角**：
    - `frameCount` / `duration` 的 exe 取值函数只在「当前材质槽 0 是帧表」时写输出；dll 的读函数把第 5 个栈参数（描述符指针）的槽位直接当输出缓冲，int / float 分支**没有预先清零**，所以取不到时读出的是描述符地址的低 32 位（`frameCount` 是一个任意整数，`duration` 是这 32 位当 float 解释）。exe 取材质按 `L+0x4a0` → `L+0x4a8` → `L+0x498`（预光照 / puppet 直接上屏变体 → 基础材质，rea-p12-mdl），变体与基础材质共用纹理时不会走到这条路。【确：dll 代码；实际能否触发【推：基本不会】】
    - 方法与字段都靠 `this` 找 exe 对象：`const { play } = anim; play()`（`this` 为 `undefined`）静默什么都不做；`anim.play.call(别的图层包装)` 会把别的类型的 exe 对象交给 `ITextureAnimation` 的原生函数（未定义行为，不必复刻）。【确：入口只做 `U(this)`】
    - 每个包装各自一个模板，所以两个不同对象的 `play` 不是同一个函数对象；同一对象上 `anim.play === anim.play`。【确】

**和任务问题的对照**
- 问 1：回调地址见概括 1（`0x18162baf0` → `M`，exe `0x14020e670`）；没有 `H` 槽、没有参数；`null` / `undefined` / 顶层见概括 2。
- 问 2：同一个 JS 对象，缓存在 exe `L+0x4c0` 与 dll `E+0x528`，见概括 3。
- 问 3：成员与顺序见概括 4；只读赋值、`rate` 转换、三个读出类型见概括 5；`setFrame` 见概括 6；各方法的 exe 函数见概括 7（都不经宿主接口槽，除 `setFrame` 外都没有参数）。
- 问 4：见概括 8。
- 问 5：见概括 10。

**元数据**
- 目标：`scenescript64.dll`，SHA-256 `58039ef912fcd51cd833540476e3798268158a06f63003fe94bff1b1cbeaad08`。`ignore/p10/rea/`、`ignore/p6/rea/sound/`、`ignore/p11/rea/media/`、`ignore/p6/rea/layers/script/` 四份副本与 WPE 的 `bin/scenescript64.dll`、`distribution/bin/scenescript64.dll` 全部一致，拷了一份到工作目录。为读登记表另用了 `wallpaper64.exe`（SHA-256 `40e2ce021e9352324fadb3b8f72b8ba2a7ee95b71cc571d5b9f84be75cd993b0`，与 WPE 安装目录那份一致，副本 `ignore/p9/rea/wallpaper64.exe`）。
- **没有用 REA**：开工时 `binary_session` 显示 REA 会话正绑着并行代理的 `wallpaper64.exe`（Ghidra）。REA 是一个共享会话，换成这份 28.7 MB 的 dll 会让对方的 Ghidra 分析作废，而前几份 rea（p6d、p12c 等）都记录过 Ghidra 在这份 dll 上分析超时，所以没有打开、也没有关闭别人的文档，没有快照可存。改用和 rea-p6d-script 相同的路线：dll 宿主区用现成的 `llvm-objdump` 全文 `host.asm`（`0x181600000`–`0x181680000`），区外的 V8 小函数用 `llvm-objdump --start-address` 现反汇编；exe 用 `ignore/p4/rea/wp.asm` 切片。
- 没运行、没附加 WPE，没写 Steam / WPE 目录。读了 `ui/dist/monaco/autocomplete/lib.sceneScript.d.ts`（只读）。
- 工作目录 `ignore/p6/rea/sheet/script/`：
  - `scenescript64.dll`（副本）；`dll/`：拷自 `ignore/p6/rea/layers/script/` 的 `pe.py` `fn.py` `xref.py` `strs.py` `rd.py` `vt.py` `sl.py` `jt.py` 等与 `ignore/p12/c/rea/dll/jt9.py`，另放 `host.asm`、dll 与 exe 副本供脚本读；`exe/`：拷自 `ignore/p12/c/rea/` 的 `pe.py` `fn.py` `slice.py` `grepfn.py` `xr.py` `strs.py` `rd.py` `vtdump.py` `methods.py` 等，`pat_members.txt` `pat_4c0.txt`。
  - 新写：`order.py`（按 rea-p6d1-keyorder 的 FNV-1a / 8 桶 / 桶首插入模型算 JS 自有属性顺序，内置 `IVideoTexture` 核对组）、`rdf64.py`（读 dll 的 double / float 常量）。
  - `asm/` dll 摘录：`dll_fieldread_1816208e0.asm`（字段读，跳转表 `dll_fieldread_jt.txt`）、`dll_fieldwrite_181620e10.asm`（字段写，`dll_fieldwrite_jt.txt`）、`dll_fieldacc_methodentry_18162b830.asm`（字段读写入口与方法入口）、`dll_methodcall_excerpts.asm`（`M` 的类型 8 实参、缺参数缺省、返回分派与 1 / 2 / 4 / 8 / `0x800` 返回）、`dll_isint32_180017040.asm`、`dll_obj_getanimation_18162bbe0.asm`、`dll_thislayer_getter_1816468c0.asm`、`dll_wrap_52380b_from_p6d.asm`（`W`，拷自 p6d）。
  - `asm/` exe 摘录（只为拿类型码与对象布局）：`exe_texanim_reg_1402131a0.asm`（字段 / 方法登记）、`exe_texanim_impl_1401fa2a0.asm`（10 个原生函数与改值回调）、`exe_gettexanim_14020e670.asm`、`exe_texanim_dtor_140213130.asm`、`exe_texanim_enum_140213a00.asm` / `exe_texanim_methods_140213dd0.asm` / `exe_texanim_findfield_140213880.asm`（虚表 +0x10 / +0x18 / +0x20）、`exe_imagelayer_reg_1402110be.asm`、`exe_imagelayer_methods_140212f60.asm`、`exe_videotex_reg_140214050.asm`、`exe_ianimation_reg_140177f70.asm`、`exe_ianimlayer_reg_14026c980.asm`。
- 标记：【确】反汇编直接看到；【推】由代码推出，或依赖 V8 上游行为 / API 身份；【确，有界】在注明范围内搜过。

**命名**（沿用 rea-p6c-script / rea-p6d-script 的 `E`、`Sd`、`H`、`W`、`U`、`M`，新增的如下）
- `L`：exe 图像层（虚表 `0x1404911a8`）。`L+0x498` 基础材质，`L+0x4a0` / `L+0x4a8` 两个材质变体，`L+0x4c0` 纹理控制对象槽（`ITextureAnimation` 与 `IVideoTexture` 共用）。
- `A`：exe 的 `ITextureAnimation` 对象，0xf0 字节，虚表 `0x140491168`。用到的字段：`+8` 属主 / id（恒 0）、`+0x48` 脱离位（0 = 跟随共享计时器）、`+0x50` 建它时的纹理 `T`、`+0x58` 所属图层 `L`、`+0x60..` 空的实例字段表、`+0xe0` 播放位、`+0xe4` `rate`、`+0xe8` 自己的帧（int）、`+0xec` 自己的计时（清 0 用，含义归 exe）。
- `T`：材质纹理槽 0（`材质+0xd0`）。`T+0x1c` 标志（bit2 = 帧表，bit5 = 视频）、`T+0x9c` 共享的当前帧（`+0xa0` 随它一起拷）、`T+0xa8` `duration`、`T+0xb8..+0xc0` 帧表（每项 0x20 字节）。都是 exe 侧，以 rea-p6e-sheet 为准。
- exe 反射条目（rea-p4f、rea-p12c）：字段节点 `+0x30` 类型、`+0x34` 字段偏移、`+0x38` JSON setter、`+0x48` 原生 setter、`+0x50` 取值、`+0x58` 改值回调、`+0x60` 标志（bit1 只读、bit2 角度）、`+0x68` 名字；方法节点 `+0x30` 原生函数、`+0x38` 名字、`+0x58` 形参类型 vector、`+0x70` 返回类型。dll 拿到的「描述符」= 节点 `+0x30`。

---

## 1. 入口：`getTextureAnimation`

### 1.1 登记（exe 侧，`0x1402110be` 是图像层类登记函数的一段）【确】
- 字段表 `0x1404e85e0`（`alignment` 等）、方法表 `0x1404e8620`。`methods.py` 抽出的方法（顺序即登记顺序）：`getTextureAnimation`（`0x14020e670`，返回 `0x800`，无形参）、`getVideoTexture`（`0x14020e7b0`，`0x800`）、`getAnimationLayer` …… `resetBonePhysicsSimulation`。
- 图像层虚表 `+0x18`（`0x140212f60`）先调图像基类的方法枚举 `0x1401efad0`（`0x1404e83a0` 表：`getEffect` 等），再接上自己的 `0x1404e8620`。文本层没有用这个虚表（p6c 4.3：文本层方法表为空、回落到图像基类），所以文本层上没有 `getTextureAnimation`【推】。

### 1.2 调用链（dll）【确】
```
JS: layer.getTextureAnimation(...)
→ FunctionTemplate 回调 0x18162baf0（data = External(方法节点, 标签 4)）
    o = U(this)；o 为 0 → 直接返回（undefined）         // 0x18162bb3b–0x18162bb46，没有作用域检查
→ M(E+0x1d8, E, info, o, 方法描述符)                      // 0x18162bb7e
    形参类型 vector 为空 → 不读任何实参
    返回类型 0x800（0x181622ec4）：
        ret = 0；exe(o, 0, types, values, &ret, &err)     // 0x181622ef5 = call [方法描述符]，即 0x14020e670
        ret ? W(ret) : null                               // 0x181622f09 / 0x181622f13（根值 +0x378）
        W 返回空句柄时给根值 +0x368（undefined）            // 0x18162226a–0x18162227f，正常走不到
```
- exe 函数的调用约定：`(对象, 实参个数, 类型码数组, 值数组, &返回, &错误槽)`（rea-p6d-script 8.2）。`0x14020e670` 不写错误槽，所以永不抛错。

### 1.3 exe 的取 / 建（顺带看到，以 rea-p6e-sheet 为准）【确】
```
if (L+0x4c0) return L+0x4c0                         // 不看类型：getVideoTexture 建的也原样返回
T = (L+0x498)->+0xd0
if (!T || !(T+0x1c & 4)) return L+0x4c0             // 即空
A = new 0xf0；A.vtbl = 0x140491168；A+8 = 0；A+0x10 = ctx+0x1c88；A+0x48 = 0
0x140153760(A+0x60)                                  // 两张空 unordered_map
A+0xe0 = 1；A+0xe4 = 1.0f、A+0xe8 = 0（0x14020e72a 一条 qword 写同时写这两个）；A+0xec = 0
0x1401a38f0(A+8, json = 0)                           // 「id」setter，json 空时不写，A+8 保持 0
L+0x4c0 = A；A+0x58 = L；A+0x50 = T；return A
```
- 初始状态：跟随共享计时器、播放位 1、`rate` 1、自己的帧 0。

### 1.4 顶层与 `thisLayer`【确；`thisLayer` 为 `null` 的结果【推】】
- `LoadScript` 求值模块前只压「当前脚本」deque（`0x18164c2f1`，`E+0x4f8`），不碰 `E+0x4a8`（thisObject）/ `E+0x4d0`（thisLayer）。`thisLayer` 取值器 `0x1816468c0`：deque 空或栈顶为 0 → 根值 `+0x378`（`null`）。P10 实测「模块顶层 `thisObject` 是 `null`」与此同一机制。
- 例外：脚本在别的回调里被加载（如 `createLayer` 的配置带脚本、在 `init` 里调），外层回调压着的 `thisLayer` 还在栈顶，新模块的顶层能拿到外层图层，并且能调 `getTextureAnimation()` 而不报 `SyntaxError`。语料里没见过。

---

## 2. 身份与缓存【确】
- exe：`L+0x4c0` 一个图层一个，第一次调用时建，之后原样返回同一指针（1.3）。
- dll：`W(A)` 按指针查 `E+0x528`；第一次建包装并登记两个监听（`A->vtbl+0x30` = `0x1401a3be0` 析构监听、`+0x38` = `0x1401a3dd0` 字段增删监听），之后返回同一个 `Global`。所以：
  - `thisLayer.getTextureAnimation() === thisLayer.getTextureAnimation()`；
  - 同一图层上 `getTextureAnimation()` 与 `getVideoTexture()` 只要有一个先返回过对象，另一个就返回同一个 JS 对象（exe 共用 `L+0x4c0`）。帧表图层：先 `getVideoTexture()` 得 `null`（`L+0x4c0` 仍空），再 `getTextureAnimation()` 得对象；顺序反过来时 `getVideoTexture()` 得到的是 `ITextureAnimation`（成员是 `frameCount`、`join` 那一套）；
  - 两个图层共用一张纹理：两个 `A`、两个 JS 对象，跟随时读的是同一个 `T+0x9c`。
- 包装是强引用，永不被 GC；`A` 被删后记录删除、`Global` 泄漏（rea-p6d-script 6）。

---

## 3. 包装的形状

### 3.1 模板（`W`，`0x181652380`，rea-p6d-script 第 6 节、rea-p6d1-keyorder 4.1）【确】
- 字段：`A->vtbl+0x10`（`0x140213a00`）把**类静态表** `0x1404e8660` 的链表节点逐个 `push_back`，再接实例表 `A+0x68`（构造后为空，没看到往里插的代码）。dll 按 vector 正序 `SetNativeDataProperty(名字, 取值 0x18162b990, 设值 = 只读 ? 空 : 0x18162bae0, data = External(描述符, 3), 属性 = 只读 ? ReadOnly : None)`。
- 方法：`A->vtbl+0x18`（`0x140213dd0`）只枚举自己的方法表 `0x1404e86a0`，**不接任何基类表**（与图像层的 `0x140212f60` 不同），所以没有 `getParent` 等根方法。dll 逐个 `Template::Set(名字, FunctionTemplate(0x18162baf0, data = External(方法节点, 4)))`。
- 最后 `Template::Set("getAnimation", FunctionTemplate(0x18162bbe0))`。
- 原型 `Object.prototype`；`String(anim)` 为 `[object Object]`【推，同 P9 实测】；对象可扩展，`anim.loop = false` 只是加一个普通属性，没有效果。

### 3.2 顺序【推：模型；输入为【确】】
exe 登记（`0x1402131a0`）的插入顺序与 FNV-1a 桶号（8 桶）：

| 表 | 插入顺序（桶） | 链表 |
|---|---|---|
| 字段 `0x1404e8660` | `rate`(7) `frameCount`(5) `duration`(5) | `rate, duration, frameCount`（`duration` 插到桶 5 首） |
| 方法 `0x1404e86a0` | `play`(3) `pause`(5) `stop`(5) `isPlaying`(5) `setFrame`(0) `getFrame`(4) `join`(1) | `play, isPlaying, stop, pause, setFrame, getFrame, join` |

JS 顺序 = 字段链表倒过来 + 方法链表 + `getAnimation`：

`frameCount, duration, rate, play, isPlaying, stop, pause, setFrame, getFrame, join, getAnimation`

核对（`order.py`）：
- `IVideoTexture`（登记 `0x140214050`：字段 `rate loop duration`，方法 `play pause stop isPlaying setCurrentTime getCurrentTime addEndedCallback`）算出 `duration, loop, rate, addEndedCallback, play, setCurrentTime, isPlaying, stop, pause, getCurrentTime, getAnimation`，与 P9 实测逐项相同。
- 方法段的 `play, isPlaying, stop, pause, setFrame, getFrame` 与 P10 `IAnimation`、P12 `IAnimationLayer` 实测的顺序相同（它们的登记顺序也是 `play pause stop isPlaying setFrame getFrame`）。
- 3 个字段、7 个方法都不到第 9 个键，不扩容。

### 3.3 属性描述【推：V8 对 `AccessorInfo` 的呈现】
- `Object.getOwnPropertyDescriptor(anim, 'frameCount')` 是数据描述 `{value, writable: false, enumerable: true, configurable: true}`，`rate` 的 `writable` 为 `true`；方法是普通数据属性（函数值）。
- `JSON.stringify(anim)` = `{"frameCount":…,"duration":…,"rate":…}`（函数被跳过）。
- `configurable: true` 意味着 `delete anim.rate` 能删掉这个属性（之后读 `undefined`、写成普通属性），exe 不受影响。没在语料里见过。

---

## 4. 字段读写

### 4.1 读（`0x18162b990` → `0x1816208e0`，跳转表 `0x181620de4`）【确】
```
o = U(this)；o 为 0 → 不设返回值（undefined）
r = 0x1816208e0(…, o, 描述符)：
    缓冲 = 第 5 个参数（描述符指针）所在的栈槽 [rbp+0x50]       // 0x181620940 / 0x181620973
    switch 描述符类型:
      0 int:   [描述符+0x20](o, 描述符, &缓冲)；Integer::New(isolate, (int32)缓冲)     // 0x181620973 → 0x180033d00
      4 float: 同上取 float；标志 bit2 时 ×57.29578；Number::New((double)f)          // 0x1816209c9
      6 bool:  true / false；8：字节转 Number；7：对象 → W 或 null（这一支先把缓冲清 0）
```
| 字段 | 类型 | 取值函数（节点 `+0x50`） | JS |
|---|---|---|---|
| `frameCount` | 0 | `0x1401fa2a0`：材质（`L+0x4a0` → `+0x4a8` → `+0x498`）槽 0 是帧表时 `(T+0xc0 − T+0xb8) >> 5` | 整数（Smi / HeapNumber 由 `Integer::New` 决定，JS 看不出） |
| `duration` | 4 | `0x1401fa2f0`：同一条件下 `T+0xa8` | float32 → double |
| `rate` | 4 | `0x1401a4a10`：读 `A+0xe4` | float32 → double，缺省 `1` |

- int / float 分支不清缓冲：取值函数不写时读出描述符指针的低 32 位（概括 11）。
- `rate`、两个只读字段的节点 `+0x60` 都没有 bit2（`rate` 的节点由 `0x14015a000` 建，`+0x60` 清 0；只读两项写的是 2），读写都不做角度换算。

### 4.2 写（`0x18162bae0` → `0x18162b9a0` → `0x181620e10`，跳转表 `0x181621474`）【确】
- 只读字段没有 setter（`W` 不给），赋值由 V8 处理：严格模式 `TypeError`，值不变。
- `rate`（类型 4，`0x181620f0c`）：
  ```
  if !IsNumber(v)（0x180016c70：Smi 或 map == HeapNumber）: return        // 什么都不做
  f = (float)Number::Value(v)                                                // cvtsd2ss，舍入到最近
  if 描述符标志 & 4: f *= 0.017453292                                        // rate 没有
  [描述符+0x18](o, 描述符, &f)                                               // 节点 +0x48 = exe 0x1401a49f0
  ```
- exe `0x1401a49f0`：把 4 字节存进 `o + [描述符+4]`（`A+0xe4`），然后**无条件**尾调改值回调 `[描述符+0x28]`（节点 `+0x58` = `0x1401fa4a0`）。回调（exe 侧，顺带）：
  ```
  if rate == 1.0f（ucomiss；NaN 为无序，算「不等」）: return
  if A+0x48（已脱离）: return
  T = 当前材质槽 0；是帧表就 A+0xe8 = T+0x9c（8 字节）
  A+0x48 = 1                                                                // 脱离，播放位不动
  ```
- 写入转换一览：

| 写法 | 存进 `A+0xe4` | 读回 | 脱离共享（跟随中时） |
|---|---|---|---|
| `2`、`0.5`、`-1`、`0` | float32 | 同值 | 是 |
| `-0` | `-0.0f` | `-0`（`Object.is(r, -0)`） | 是 |
| `0.1` | `0x3dcccccd` | `0.10000000149011612` | 是 |
| `1`、`1.00000001` | `1.0f` | `1` | **否** |
| `NaN` | NaN | `NaN` | 是 |
| `1e40` / `-1e40` | `±inf` | `±Infinity` | 是 |
| `'2'`、`true`、`null`、`undefined`、`{}`、`[2]`、`new Number(2)` | 不写 | 原值 | 否（不调 exe） |

---

## 5. 方法（`0x18162baf0` → `M`）

### 5.1 实参【确】
- 只有 `setFrame` 有形参，类型码 `0x8`。`M` 的类型 8 分支（`0x18162175e`）：`IsInt32`（`0x180017040`：Smi → 真；HeapNumber 要求在 [−2147483648, 2147483647]、不是 `-0`、`cvttpd2dq` 往返相等，`NaN` 因无序比较为假）通过时用 `Int32Value`；**其它一切**（含缺参数）落到缺省分支 `0x18162293a`：值 0、类型码 `0x80000008`。exe `0x1401fa400` 只读 `[values[0]]`，不看类型码。

| 实参 | exe 收到 |
|---|---|
| `3`、`3.0`、`-1`、`1e9`、`2147483647` | 原值 |
| `2.5`、`0.999`、`'2'`、`true`、`null`、`undefined`、`NaN`、`Infinity`、`-0`、`2147483648`、`{}`、缺参数 | **0** |
| `(3, 7)` | 3（多余的忽略） |

- 其余 6 个方法形参表为空，传什么都忽略。

### 5.2 返回【确】
- 类型 1（`play` `pause` `stop` `setFrame` `join`）：`0x181622cd8`，不设返回值 → `undefined`。
- 类型 2（`isPlaying`）：`0x181622c7b`，缓冲预置 0，非 0 → `true`（根值 `+0x380`），否则 `false`（`+0x388`）。是布尔，不是数字。
- 类型 8（`getFrame`）：`0x181622bac`，缓冲预置 0，`int32` 在 ±2³⁰ 内直接成 Smi，否则 `0x180033f70` 建 HeapNumber。JS 里就是整数。
- 都不写错误槽，不抛错。

### 5.3 exe 侧语义（顺带，以 rea-p6e-sheet 为准）
见概括 7 的表。由此能直接推出、不依赖逐帧推进的几条：
- 跟随中：`isPlaying()` 恒 `true`（`pause()` 之前），`getFrame()` 与同纹理的其它跟随对象相同。
- `pause()` → `isPlaying()` 假，`getFrame()` 等于暂停那一刻的共享帧，之后不变（暂停的脱离对象不推进【推】）。
- `play()` 只改播放位：跟随中调用无效果；脱离且暂停时恢复，从 `A+0xe8` 接着走（推进规则归 exe）。
- `stop()` → `getFrame()` 立即 0、`isPlaying()` 假。
- `setFrame(n)` → `getFrame()` 立即 `n`；跟随中调用会同时脱离并播放；脱离暂停中调用保持暂停。
- `join()` → `getFrame()` 立即回到共享帧，`isPlaying()` 立即 `true`（即使之前暂停）；`rate` 保留原值，但不会因为 `rate ≠ 1` 再次脱离，要等下一次写 `rate`（任何 ≠ 1 的数）或 `pause` / `stop` / `setFrame`。
- 跟随中 `rate` 是否参与推进、脱离后 `A+0xe8` / `A+0xec` 怎样按 `rate` 推进、`A+0xe8` 越界或为负时画哪一帧，全归 exe 侧。

---

## 6. 作废与 `isObjectValid`【确】
- 删除点：
  - 图像层析构 `0x1401fb4e0`：设虚表后先 `if (L+0x4c0) L+0x4c0->vtbl[0](1)`（`0x1401fb4f8`–`0x1401fb511`）；
  - 槽 0 换纹理 `0x140209360` 尾部（`0x14020950a`–`0x140209526`）：`L+0x4c0` 非空且 `+0x50 != 新纹理` 就删并清空槽（调用方 `0x1402065e0`，以及 `0x1401fb1b5` 处登记的回调；什么操作会触发归 exe 侧）。
- `A` 的标量删除析构 `0x140213130` 先清两张实例表，再调 `IPropertyObject` 基类析构 `0x1401a3b60` → 逐个调监听 → dll `0x181653eb0` 从 `E+0x5b0`（序号）与 `E+0x528`（指针）两表删掉记录（rea-p6d-script 4.3）。
- 之后经 `U` 的入口全部拿到 0：

| 入口 | 作废后 |
|---|---|
| 读 `frameCount` / `duration` / `rate` | `undefined` |
| 写 `rate` | 忽略 |
| 7 个方法 | `undefined`，exe 不被调用 |
| `getAnimation` | `undefined`（`0x18162bc33`） |
| `engine.isObjectValid(anim)`（`0x181656a30`） | `false`（有效时 `true`） |

- `destroyLayer(图层)` 当帧：图层只进待删集合、还没析构，`anim` 一切照常、`isObjectValid` 为真；帧尾析构之后作废（rea-p6d-script 4.2、4.3）。
- 槽 0 换纹理那一刻就作废（同步删）；再 `getTextureAnimation()` 按新纹理重建（新对象）或得 `null`。

---

## 7. `getAnimation`（`0x18162bbe0`）【确】
```
o = U(this)；o 为 0 → 返回（undefined）
name = (argc ≥ 1 且 arg0 是字符串) ? Utf8(arg0) : ""
if name 空：name = 当前脚本 deque（E+0x500..0x518）栈顶 Sd 的属性描述符 +0x38（脚本所挂属性名）
r = H->vtbl[0x78](H, owner = o->vtbl[1]()（= [A+8] = 0）, name)        // 0x18162bd9e–0x18162bdaa
r ? W(r) : 不设返回值（undefined）
```
- `A->vtbl+8` = `0x140031a50`（`return [this+8]`），`A+8` 构造为 0（1.3）。exe `0x14018db00` 对 `owner == 0` 不过滤属主（rea-p10 第 11 节）。所以它就是「全场景按名字找，找不到给 `undefined`」。
- 拿到的 `IAnimation` 与 `thisScene.getAnimation(同名)` 是同一个 exe 对象（`B+0xf8` 缓存），经 `W` 是同一个 JS 对象【推】。
- 「名字是空串」只在当前脚本栈为空时出现；回调里栈总有脚本，所以无参调用总是按脚本所挂属性名找。

---

## 8. 与其它纹理 / 动画控制对象的对照【确】

| | `ITextureAnimation` | `IVideoTexture` | `IAnimation` | `IAnimationLayer` |
|---|---|---|---|---|
| 怎么拿到 | 图像层 `getTextureAnimation()`（`L+0x4c0`） | 图像层 `getVideoTexture()`（同一槽） | `getAnimation`（`H+0x78`，绑定 `B+0xf8`） | `getAnimationLayer` 等 |
| exe 登记 | `0x1402131a0` | `0x140214050` | `0x140177f70` | `0x14026c980` |
| 字段 | `frameCount`(int, 只读) `duration`(float, 只读) `rate`(float, 有改值回调) | `duration` `loop`(类型 8, 读出数字) `rate`(有回调) | `rate`(无回调) `fps` `frameCount` `duration` `name` | `visible` `additive` … `rate` `blend` |
| `setFrame` 形参 | **`0x8` int**（非整数 → 0） | — | `0x4` float | `0x4` float |
| `getFrame` 返回 | **`0x8` int** | — | `0x4` float | `0x4` float |
| 独有方法 | `join` | `setCurrentTime` `getCurrentTime` `addEndedCallback` | — | `addEndedCallback` |
| `getAnimation` 属主 | 0（全场景） | 0（全场景） | `[W+8]`（W 虚表 `0x14048dfa8` 槽 1 也是 `0x140031a50`；值没查） | `[AL+8]` |
| dll 代码 | 全部通用：`W`、`U`、`0x1816208e0`、`0x181620e10`、`0x18162baf0` → `M`、`0x18162bbe0` | 同 | 同 | 同 |

---

## 未查完 / 未解决
1. **帧怎样推进、画哪一帧**：跟随时共享计时器 `T+0x9c` 由谁推进、跟不跟 `rate`；脱离后 `A+0xe8` / `A+0xec` 的推进、`rate` 为 0 / 负 / NaN 时的结果；`setFrame` 越界或为负时画什么、`getFrame` 读回是否被回绕——全是 exe 侧，看 `rea-p6e-sheet.md`。本文的 exe 语义只来自 10 个原生函数本身。
2. **`T+0x9c` 拷 8 字节**：`pause()` 与改 `rate` 时把 `T+0x9c..+0xa3` 一起拷进 `A+0xe8..+0xef`，后 4 字节是什么（计时累加？）归 exe 侧。
3. **槽 0 换纹理的触发场合**（`0x140209360` 的调用方 `0x1402065e0`、`0x1401fb1b5` 的回调）：用户纹理属性、脚本、异步加载完成中哪些会走到，没查。
4. **文本层等没有 `getTextureAnimation`**：只核了图像层的方法枚举 `0x140212f60`；文本层的虚表 +0x18 沿用 p6c 4.3 的结论，没逐类重核。
5. **`frameCount` / `duration` 的「描述符低 32 位」垃圾值**：要 `L+0x4a0` / `L+0x4a8` 的槽 0 与基础材质不同才可能走到，没核实变体材质是否总共用纹理。
6. **V8 侧细节**：只读赋值的 `TypeError` 文案、属性描述的 `configurable`、`delete` 是否真能删、`anim.play.name` 是什么，按 V8 行为推断，没在 dll 里定位。
7. **`thisLayer` 在嵌套 `LoadScript`（回调里建层带脚本）时的顶层值**：只按 deque 推出。

## 建议的确定性实验

工程用 `kbp gen`，场景 1920 × 1080 正交，下面各项分开跑（第 9 项会删掉 `S2`）。准备：图层 `S1`、`S2` 用**同一张**帧表纹理（例如 4×4 = 16 帧、固定 `fps`，帧号画进图里便于抓帧核对）；`P` 用普通图片；另有文本层 `T`、粒子层 `Q`；在别的图层 `K` 的 `origin` 上放一条 `options.name = 'kfA'` 的关键帧动画。脚本挂在 `S1` 的 `alpha` 上（`thisLayer` = `S1`），一律 `const L = (...a) => console.error('[kbp]', ...a)`；跨帧的项在 `update` 里按帧计数 `n` 分段，每帧打印一行 `n, a.getFrame(), a.isPlaying(), b.getFrame(), b.isPlaying()`（`a` = `S1` 的、`b` = `S2` 的，`b` 全程不动，作「共享计时器」对照）。

1. **形状与身份**（`init`）
   ```js
   const a = thisLayer.getTextureAnimation();
   L('keys', Object.keys(a).join(','));
   L('types', typeof a.frameCount, a.frameCount, typeof a.duration, a.duration, a.rate, typeof a.isPlaying());
   L('same', a === thisLayer.getTextureAnimation(), engine.isObjectValid(a), Object.getPrototypeOf(a) === Object.prototype);
   L('json', JSON.stringify(a), 'loop' in a, a.loop, typeof a.getParent, a.play.length, a.setFrame.length);
   L('desc', JSON.stringify(Object.getOwnPropertyDescriptor(a, 'frameCount')), JSON.stringify(Object.getOwnPropertyDescriptor(a, 'rate')));
   L('nonsheet', thisScene.getLayer('P').getTextureAnimation(), typeof thisScene.getLayer('T').getTextureAnimation, typeof thisScene.getLayer('Q').getTextureAnimation);
   ```
   预期：`frameCount,duration,rate,play,isPlaying,stop,pause,setFrame,getFrame,join,getAnimation`；`number 16 number <float32> 1 boolean`；`true true true`；`{"frameCount":16,"duration":…,"rate":1} false undefined undefined 0 0`；`frameCount` 描述 `writable:false`、`rate` 描述 `writable:true`、都 `enumerable:true`；`null undefined undefined`。
2. **只读字段**：`for (const k of ['frameCount', 'duration']) { try { a[k] = 3; L('ro', k, 'no-throw', a[k]); } catch (e) { L('ro', k, e.name, e.message, a[k]); } }`。预期 `TypeError Cannot assign to read only property 'frameCount' of object '#<Object>'`，值不变。
3. **`rate` 写入转换**：对每个 `v` 依次做 `a.join(); a.rate = 1; a.rate = v; L('rate', 描述(v), Object.is(a.rate, -0) ? '-0' : a.rate)`，`v` 取 `2, 0.5, -1, 0, -0, 0.1, 1, 1.00000001, NaN, 1e40, -1e40, '3', true, null, undefined, {}, [2], new Number(2)`。预期见 4.2 的表（`0.1` → `0.10000000149011612`，`1e40` → `Infinity`，非 number 读回上一个值 1）。
   脱离与否：每个 `v` 写完后接下来 30 帧比 `a.getFrame()` 与 `b.getFrame()`：预期 `1`、`1.00000001` 和全部非 number 的写法始终相同；其余在 `rate ≠ 1` 的推进下与 `b` 分开（推进规则归 exe，`0` 时 `a` 停住而 `b` 继续）。
4. **`setFrame` 参数**：先 `a.pause()`，再对每个 `x` 做 `a.setFrame(x); L('sf', 描述(x), a.getFrame(), a.isPlaying())`，`x` 取 `3, 3.0, 2.5, 0.999, '2', true, null, undefined, NaN, Infinity, -0, -1, 15, 16, 999, 2147483647, 2147483648, 1e9, {}`，外加 `a.setFrame()`、`a.setFrame(5, 7)`。预期 `getFrame` 依次 `3 3 0 0 0 0 0 0 0 0 0 -1 15 16 999 2147483647 0 1000000000 0`、`0`、`5`，`isPlaying` 全为 `false`。各设一次后抓帧，看越界 / 负数画哪一帧（exe 侧）。
5. **方法时间线**（`update` 里按帧号执行，每帧打印上面那一行）：
   - n=10 `a.pause()` → 当帧 `a.isPlaying()` 假、`a.getFrame() === b.getFrame()`；之后 `a` 不变、`b` 照走；
   - n=20 `a.play()` → 真，`a` 从暂停处接着走；
   - n=30 `a.stop()` → 当帧 `getFrame` 0、`isPlaying` 假；n=35 `a.play()`；
   - n=40 `a.join()` → 当帧 `a.getFrame() === b.getFrame()`、`isPlaying` 真；
   - n=45 `a.pause(); a.join()` 同一帧 → `isPlaying` 真；
   - n=50 `a.setFrame(7)`（跟随中）→ `getFrame` 7、`isPlaying` 真，之后自己走；
   - n=60 `a.join(); a.play()`（跟随中 `play`）→ 与 `b` 一致，无变化；
   - n=70 `a.rate = 2` → 之后与 `b` 分开；n=80 `a.rate = 1` → 仍与 `b` 分开（不自动加入）；n=90 `a.join()` → 又一致，`a.rate` 读回 1。
   抓 n=11、21、31、41、51 帧核对画面与 `getFrame` 是否对应（exe 侧）。
6. **共用槽**：在 `S2` 上的另一段脚本（挂 `S2.alpha`）里先 `const t = thisLayer.getTextureAnimation(); const v = thisLayer.getVideoTexture(); L('share', v === t, Object.keys(v).join(','))`，在 `S1` 上反过来先 `getVideoTexture()`（预期 `null`）再 `getTextureAnimation()`（预期对象）。预期 `S2` 那段 `true` 和 `ITextureAnimation` 的键序。
7. **`getAnimation` 全场景**：`L('ga', a.getAnimation('kfA') === thisScene.getAnimation('kfA'), a.getAnimation('nosuch'), thisScene.getAnimation('nosuch'), a.getAnimation() === thisScene.getAnimation('alpha'))`。预期 `true undefined null`，最后一项取决于场景里有没有 `alpha` 关键帧动画（有就 `true`，没有就是 `undefined === null` 为 `false`）。
8. **顶层**：模块顶层 `L('top', thisLayer === null, thisObject === null)`。预期 `true true`。
9. **作废**：`K` 上的脚本 `init` 里 `ax = thisScene.getLayer('S2').getTextureAnimation()`；n=5 `thisScene.destroyLayer('S2')`，紧接着打印 `engine.isObjectValid(ax), ax.frameCount, ax.getFrame(), ax.isPlaying()`；n=6、7 再打印同样几项，并 `ax.rate = 3; L(ax.rate, ax.play(), ax.join(), ax.getAnimation('kfA'), Object.keys(ax).length, JSON.stringify(ax))`。预期 n=5 `true 16 <整数> <布尔>`；n=6 起 `false undefined undefined undefined`、`undefined undefined undefined undefined 11 {}`，都不抛错。
10. **脱离 `this`**：`const { play, getFrame } = a; L('unbound', play(), getFrame())`。预期 `undefined undefined`，`a` 状态不变。
