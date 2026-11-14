> 逆向原始记录，代理写的，dll 地址按基址 `0x180000000`（Ghidra），exe 地址按 `0x140000000`，全部没有实测。P6c 步骤 0c 实测核对后以报告为准。范围是 `scenescript64.dll` 侧与两边的接口：`CursorEvent`、`input`、`solid` 的脚本读写、`cursorHitTest`、回调的调用与跳过、`openUserShortcut`。输入来源、命中测试、派发时序归并行的 `rea-p6c-dispatch.md`；本文顺带看到的 exe 侧事实都标了「exe 侧」，重叠处以那份为准。

# WPE 2.8.42 场景脚本的光标接口静态逆向（dll 侧）

**概括**
1. **`CursorEvent`：** 每次调用都新建。光标回调 7–13 在 `CallCallback`（引擎虚表 `+0x40`，`0x18164e4d0`）里共用一段参数构造 `0x18164ec5f`：`Object::New` 建一个普通对象（原型是 `Object.prototype`，JS 里没有 `CursorEvent` 类），按顺序 `Set` 四个成员：`button` 恒为整数 0；`worldPosition`、`localPosition` 都是**原型设成 `Vec3.prototype` 的新对象**，自有属性 `x`、`y`、`z` 是 float32 扩成的 double（`instanceof Vec3` 为真，构造函数不跑）；`hitBox` 只在 exe 传来的名字指针非空时加，是字符串。**没有 `screenPosition`**（dll 里连这个字符串都没有）。值来自 exe 栈上的 0x20 字节结构 `D = {float world[3]; float local[3]; const char *hitBox}`。事件对象和两个向量每次调用都新建，脚本改了不影响别的脚本或别的回调。【确】
2. **回调调用：** exe 按「脚本实例 × 回调编号」调：`CallCallback(引擎, dll 脚本, thisLayer 对象, 编号, &D, 0)`。exe 每派发一种事件就遍历场景的全部脚本绑定，**凡是 `thisLayer` 等于该对象（或 `thisObject` 为空）、导出了该回调、`init` 已跑过的绑定都调**，所以一个图层上不同字段的几段脚本每段都调。导出掩码在模块求值后按命名空间取一次（值是函数才算），exe 拷进绑定 `+0x40` 做门。回调抛错只禁用这一段脚本的这一个回调（与 `update` 同一套）。**光标回调的返回值一律丢弃**；`cursorHitTest`（编号 7）在 2.8.42 的 exe 里**没有任何调用点**，导出它只会打开每帧拾取，返回值从来没人解释。回调的 `this` 是模块命名空间对象。【确；`cursorHitTest` 无调用点为【确，有界】】
3. **`input`：** 全局普通属性，值是一个模板实例，三个成员是**只读的原生数据属性，每次读都调取值器现问 exe**，不是每帧写进去的值，dll 里没有缓存。`cursorWorldPosition` 是 Vec3（`Vec3.prototype`），`cursorScreenPosition` 是 Vec2（`Vec2.prototype`，只有 `x`、`y`），`cursorLeftDown` 是布尔。取值器先看作用域栈顶：模块顶层（栈顶 0）访问抛 **`SyntaxError: cursorWorldPosition cannot be accessed from global scope.`**（另两个同式），`init`、`update`、全部回调、计时器、`applyUserProperties` 里都能用。世界坐标 = 把客户区归一化光标按深度 0.5 反投影（正交场景 `z` 置 0），屏幕坐标 = 归一化光标 × 渲染目标宽高（左上原点、`y` 向下），左键 = `ctx+0xa4` 的 bit0（宿主接口只认参数 3，dll 恒传 3），和拾取、`g_PointerState` 用的是同一位。【确；反投影函数身份、V8 API 身份为【推】】
4. **`solid`：** 不在图像层表里，而在**全部场景对象共用的根描述符表** `0x1404e8250`（和 `origin`、`scale`、`angles`、`name`、`disablepropagation` 同表），位是 `obj+0x120` 的 bit13。**根构造函数把 `+0x120` 初始化成 `0x2001`，所以 `solid` 缺省为 true，对所有对象类型都是**；exe 里没有别处清这一位。脚本读回布尔，写入只收布尔（别的类型不写），**没有改值回调**；拾取每帧读这一位，拾取在脚本之前跑，所以回调或 `update` 里写的值下一帧的拾取才生效。文本、粒子、声音层上都能读写这个字段，但拾取只对类型 1（图像）、4（文本）、5 做命中测试，粒子、形状等对象设了也没用。【确；各类的查找链回落到根表为【推】】
5. **`openUserShortcut`：** dll 只看「当前回调编号」`E+0x62c` 是否属于 11–13，即**只在 `cursorClick` / `cursorDown` / `cursorUp` 里能调**（`cursorEnter` / `Leave` / `Move` / `HitTest`、计时器里都抛 `Cannot execute user command outside of cursor callbacks.`）。「每次点击最多一次」靠 exe 场景 `+0xe0` 的 bit28：按下沿置位，宿主每次调用先清这一位再执行，清过再调返回 2，dll 据此抛 `Cannot execute more than one user command per cursor click.`；松开沿（派发之后）清掉。参数不是字符串返回 false。【确；token 的置位 / 清位时序为 exe 侧【推】】
6. **别的：** dll 里光标相关的只有上面这些（三个 `input` 名、七个回调名、四个事件键、两条用户命令报错、顶层访问报错的后缀）；`models/util/solidlayer*.json` 是 `createLayer` 的缺省模型，与 `solid` 无关。exe 里另有 `disablepropagation`（同表 bit14，缺省 false：命中它且可见时，拾取不再处理下面的对象）、`g_PointerState`、`-hideCursor`、`GetCursorPos`。【确】

**和计划硬约束的对照**
- 544 段挂在没写 `solid` 的图像 / 文本层上：`solid` 缺省 true，这些图层能被命中，**不用猜**。【确】
- `CursorEvent` 只用 `worldPosition`：我们照建全部四个成员（`button` 恒 0、`hitBox` 只在木偶命中框时有），代价很小。
- 没有场景导出 `cursorHitTest`：WPE 自己也从不调它，照 WPE 不调即可；但导出它会打开拾取（见 2.3），能力表上它不该再报缺口。
- 75 段挂在 `visible: false` 的图层上：拾取循环里**没看到对象可见位的检查**（只在 `disablepropagation` 的中断条件里看可见），但遍历的对象表由 `0x1401865c0` 预先建出，过滤条件没读，以 exe 侧文档为准。

**元数据**
- 目标：`D:\Applications\Steam\steamapps\common\wallpaper_engine\bin\scenescript64.dll`，SHA-256 `58039ef912fcd51cd833540476e3798268158a06f63003fe94bff1b1cbeaad08`；`wallpaper64.exe`，SHA-256 `40e2ce021e9352324fadb3b8f72b8ba2a7ee95b71cc571d5b9f84be75cd993b0`。都拷到工作目录后再分析，开工时核对一致。
- 没运行、没附加 WPE，没写 Steam / WPE 目录；没用 REA。只读了 WPE 的 `assets/scripts/jsclasses/baseclasses.js`、`ui/dist/monaco/autocomplete/lib.sceneScript.d.ts`、`log.txt`（grep）。
- 方法：`llvm-objdump` 反汇编 dll 宿主区 `0x181600000`–`0x181680000`（`host.asm`）；exe 用 `ignore/p4/rea/wp.asm` 切片；字符串、rip 相对交叉引用、跳转表、虚表、`.pdata` 函数边界用自写脚本读副本。
- 工作文件 `ignore/p6/rea/cursor/script/`：
  - 脚本：`pe.py`（dll / exe 两份 PE）、`fn.py`（`.pdata` 边界，`-l` 列区间）、`xref.py`（numpy 扫 rip 相对引用，含带立即数的指令）、`strs.py` / `dumpstr.py`（字符串）、`rd.py`（常量）、`jt.py`（dll 跳转表，带回调名）、`vt.py`（虚表）、`vtfind.py`（找含某函数指针的虚表）、`vt48.py`（找写在对象 `+0x48` 的虚表）、`typeid.py`（找类型号函数）、`sl.py`（切 `host.asm`）、`wsl.py` / `wgrep.py`（切 / grep `wp.asm`）、`findcb.py` / `findcb2.py`（找 exe 调 `CallCallback` 的点和回调编号）。Python 一律 `python -X utf8 -I`；本机 `python` 是 pyenv 的 bat 垫片，带 `|` 的正则要写进 `@文件` 或直接用 `versions/3.10.11/python.exe`。
  - dll 摘录：`callcb_e4d0.asm`（`CallCallback` 全文）、`loadscript_c139.asm`（`LoadScript` 主体）、`dll_vec3.asm`、`dll_input_getters.asm`、`dll_input_tpl_ctor.asm`（`input` 模板与字符串句柄）、`dll_openUserShortcut.asm`、`dll_err_scope.asm`（异常处理头、作用域压栈）、`exc_ctors.txt`（8 个 `Exception::*` 的原生上下文槽）。
  - exe 摘录：`exe_cursor_189e10.asm`（拾取与派发全文）、`exe_bind_175880.asm`（脚本绑定）、`exe_host_iface.asm`（宿主接口方法）、`exe_solid_frame.asm`（`solid` / `disablepropagation` 存取器、根构造、帧内顺序、通用派发）、`exe_desc_1e0530.asm`（根描述符表登记）、`exe_hit_19dbb0.asm`（图像类命中测试开头）。
- 标记：【确】反汇编直接看到；【推】由代码推出，或依赖 V8 上游行为 / API 身份；【确，有界】在注明范围内搜过。

**命名**
- `E`：dll 引擎对象（0x678 字节，虚表 `0x1819a3f78`）。用到的字段：`+0x1d8` isolate、`+0x1e0` context、`+0x1e8..+0x228` 预建的字符串句柄（`x` `y` `z` `w` `m` `button` `worldPosition` `localPosition` `hitBox`，构造函数 `0x1816482fc`–`0x181648525`）、`+0x348` / `+0x350` 全局 `_Vec2` / `_Vec3`（即 `Vec2.prototype` / `Vec3.prototype`，`0x18164a4ca`、`0x18164a55c`）、`+0x398..+0x3a8` 作用域栈（int）、`+0x490` 场景、`+0x498` 宿主接口 `H`、`+0x4a8` / `+0x4d0` / `+0x4f8` thisObject / thisLayer / 当前脚本三个 deque、`+0x628` 当前回调位、`+0x62c` 当前回调编号（空闲为 `0x13`）、`+0x95` 终止标志。
- `Sd`：dll 脚本对象（0x178 字节，`LoadScript` 建）：`+0x0` 模块、`+0x8` 模块命名空间、`+0x10` thisObject 的 exe 对象、`+0x18` 字段描述符、`+0x40 + 8i` 第 i 个回调的函数句柄、`+0xd8` 导出掩码、`+0xdc` 禁用掩码。
- `B`：exe 脚本绑定：`+0x8` thisObject 对象、`+0x10` 描述符、`+0x38` = `Sd`、`+0x40` 导出掩码副本、`+0x44` 状态（2 = `init` 已跑）、`+0x48` thisLayer 对象。全部绑定在脚本管理器 `S = R+0x1718` 的 `+0xd8` 链表（`ctx+0x17e0`），引擎在 `S+0x128`（`ctx+0x1830`）。
- `H`：exe 场景里 `+0x48` 处的宿主接口（虚表 `0x14048ea50`，`0x140186cfb` 写入），`X = [H+0x90]` 即 `ctx`（= 渲染器 `R+0x10`）。绑定场景时 exe 把 `场景+0x48` 交给引擎槽 3（`0x1401765ec`）。
- `D`：光标数据，exe 拾取函数 `0x140189e10` 栈上 `[rsp+0x68]`，0x20 字节。

---

## 1. `CursorEvent`

### 1.1 构造（`CallCallback` 光标分支 `0x18164ec5f`–`0x18164ee13`）【确】
- `CallCallback` 是引擎虚表槽 8（`+0x40`，`0x18164e4d0`），参数 `(E, Sd, layer, idx, D*, 第 6 参)`；`idx` 经跳转表 `0x18164f7b4`（19 项）分派，**7–13 全部落到 `0x18164ec5f`**。第 6 参在函数里没读到。
- 分支内容，按顺序：
  1. `Object::New(isolate)`（`0x18002a680`，`0x18164ec67`）→ 事件对象。**每次调用新建**，原型是 `Object.prototype`；`baseclasses.js` 没定义 `CursorEvent`，脚本里 `typeof CursorEvent === "undefined"`。
  2. `button` = `Integer::New(isolate, 0)`（`0x180033d00`，`r8d = 0`，`0x18164ec7c`；函数体是 Smi 快路径），`Object::Set(event, E+0x210, 值)`（`0x18001b770`）。**恒为 0，与哪个键无关。**
  3. `worldPosition`：拷 `D+0x0..+0xc`（`0x18164ecbd`–`0x18164ecca`），调 `0x181624910` 建向量，`Set(event, E+0x218, …)`。
  4. `localPosition`：拷 `D+0xc`、`+0x10`、`+0x14`（`0x18164ecf4`–`0x18164ed21`），同样建向量，`Set(event, E+0x220, …)`。
  5. `hitBox`：`D+0x18` 非空时 `String::NewFromUtf8(isolate, p, kNormal, -1)`（`0x180029c50`），`Set(event, E+0x228, …)`；为空就不加这个键（`0x18164ed51`）。
- 所以 `Object.keys(event)` 是 `button, worldPosition, localPosition[, hitBox]`，都是普通可写可枚举的数据属性【推：`Object::Set` 的 V8 语义】。
- **没有 `screenPosition`**：dll 里小写开头的 `screenPosition` 一次都没出现（只有 `cursorScreenPosition`）【确，有界：dll 全文字符串扫描】。与 `d.ts` 里被注释掉的 `//screenPosition`、`// button`（「Currently always 0」）一致，只是 `button` 实际上是有的。

### 1.2 向量的类型（`0x181624910`）【确】
- `Object::New` → `Object::SetPrototype(context, E+0x350)`（`0x18001e0c0`）→ 依次 `x`、`y`、`z` = `Number::New(isolate, (double)float)`（`0x180033e80`，`cvtps2pd`），键是 `E+0x1e8/+0x1f0/+0x1f8`。
- `E+0x350` 是建引擎时从全局取的 `_Vec3`（`0x18164a51a`–`0x18164a58e`），`baseclasses.js` 第 1376 行 `this._Vec3 = Vec3.prototype`。所以：
  - `event.worldPosition instanceof Vec3` 为真，`constructor === Vec3`，`add`、`length` 等原型方法都能用；
  - 构造函数**没跑**，对象只有 `x`、`y`、`z` 三个自有属性；
  - 数值是 float32 精确扩成的 double（`Math.fround(v) === v`）。
- `localPosition.z` 照传 `D+0x14`，不是固定 0（`d.ts` 说「只支持 x、y」只是用法说明）。

### 1.3 值从哪来（exe 侧，顺带看到）【确】
- `D` 是拾取函数 `0x140189e10` 栈上的 `[rsp+0x68]`：
  - `world`：拾取开头调一次 `H` 的 `+0xa8`（`0x140189e88`，`r8d = 0`，即世界坐标），存 `rbp-0x60..-0x58`，再拷进 `D`（`0x140189f2c`–`0x140189f79`）。和脚本读 `input.cursorWorldPosition` 调的是**同一个宿主方法、同一个参数**（第 3.3 节），同帧内值相同【推：两次读之间 `ctx+0x8c/0x90` 不变】。
  - `local`：每个对象命中测试的输出 `[rsp+0x58..0x60]`（测试前清 0，`0x14018a216`），无论命中与否都拷进 `D+0xc`（`0x14018a2ea`–`0x14018a308`）。图像 / 文本走 `0x14019dbb0`，类型 5 走 `0x140185520`；含义归 exe 侧文档。
  - `hitBox`：对象虚表 `+0x88` 返回真时取它写出的 `std::string` 的 `c_str`（`0x14018a2bb`–`0x14018a2da`）。图像层是 `0x1401fd690`（遍历 `[obj+0x4b8]` 木偶模型的命中框），文本、粒子、形状是 `0x1400a36d0`（恒 false）。与 `d.ts`「点在木偶变形模型上时的命中框名，自定义名或骨骼序号」一致。
- 同一个 `D` 交给这一轮的每段脚本；dll 每次都从 `D` 重新建对象，**脚本改事件或向量不会传到下一段脚本或下一个回调**。共享的只有 `Vec3.prototype` 本身（改原型会影响全场）。

### 1.4 调用【确】
- `Function::Call(fn = Sd+0x40+8·idx, context, recv = Sd+0x8, argc = 1, argv = [event])`（`0x180023410`，`0x18164ee08`）。
- `Sd+0x8` 是 `LoadScript` 里 `Module::GetModuleNamespace`（`0x18000df10`，断言串 `v8::Module::GetModuleNamespace must be used on an instantiated module` 确认身份）的结果（`0x18164c4fb` → `0x18164c58a`）。所以回调里的 `this` 是**本模块的命名空间对象**，不是 `undefined`，也不是图层。`update`、`init` 同样如此（同一个 `recv`）。

---

## 2. 回调怎么被调

### 2.1 exe → dll 的接口【确】
- exe 每派发一种事件跑一遍同样的循环（光标派发的 7 处：`0x14018a3c7` Move、`0x14018a5dc` Enter、`0x14018a695` Move、`0x14018a766` Down/Up（`r9d = 0xc | !左键`）、`0x14018a84e` Click、`0x14018a95f` Up、`0x14018aa89` Leave）：
  ```
  if ([ctx+0x1710]+0x118 & 0xc000000) 跳过整轮          ; 与推迟 init 的条件相同（p3 D 节）
  for B in S+0xd8 链表:
      if !(B+0x48 == obj || B+0x8 == 0) continue        ; thisLayer 是该对象，或 thisObject 为空
      if !(B+0x40 & (1 << idx)) continue                 ; 导出了这个回调
      if B+0x44 != 2 continue                            ; init 已跑
      第一次命中时 E.vtbl+0x20（Enter，加锁）
      E.vtbl+0x40(E, B+0x38, B+0x48, idx, &D, 0)         ; CallCallback
  命中过就 E.vtbl+0x28（Leave）
  ```
- 所以按「脚本实例 × 编号」调，带图层（第 3 参 `B+0x48`，dll 压进 thisLayer 栈）。**同一图层上挂在不同字段的几段脚本每段都调**，顺序是绑定链表的顺序（`0x140176718` 在绑定时插入 `S+0xd8`；是否尾插没核对）【确：每段都调；顺序【推】】。挂在该图层 effect / 材质字段上的脚本，`thisLayer` 也是这个图层，同样会收到【推：`B+0x48` 的含义由 dll 的 thisLayer 取值器 `0x1816468c0` 读它推出】。
- `B+0x8 == 0` 的绑定收到**每个对象**的事件。哪类脚本的 thisObject 为空没查清：挂在 general 上的脚本实测 `thisObject` 是对象（p3 L14），不是这一类。
- 另有通用派发 `0x140177ad0`（同样遍历，三项条件里 thisObject 的比较对象是参数而不是 0，对象参数为空时全场都调），它的 9 个调用点只传 1、6、14–18，不传光标编号。

### 2.2 导出掩码与跳过【确】
- `LoadScript` 求值完模块后（`0x18164c5a0`–`0x18164c662`）：对 19 个回调名逐个 `namespace.Get(名字)`，值 `IsFunction` 才把函数存成 `Sd+0x40+8i` 的全局句柄并置 `Sd+0xd8` 的 bit i。**只取这一次**：之后再给 `export let cursorClick` 赋新函数，调的仍是加载时那个【推：句柄语义】。
- exe 绑定时 `B+0x40 = E.槽 14(Sd)`（`0x181650d80` 返回 `Sd+0xd8`；`0x1401766da`）。exe 的循环只看这个副本，没导出的不进 `CallCallback`。
- dll 侧 `CallCallback` 开头只再看两件事（`0x18164e51c`、`0x18164e529`）：`Sd+0xdc` 的禁用位、`E+0x95` 终止标志，任一成立直接返回（连锁都不加）。

### 2.3 拾取只在有光标脚本时跑【确】
- 绑定时掩码 `& 0x3f80`（编号 7–13，**含 `cursorHitTest`**）非 0 就置 `S+0x130 = 1`（`0x140176700`–`0x14017670a`，即 `R+0x1848`）。
- 帧函数只在它为真时调拾取 `0x140189e10`（`0x1401802af`–`0x1401802d5`），紧接着是脚本帧函数 `0x140171440`（`0x1401802e5`：媒体事件、`animationEvent`、计时器、`update`）。拾取函数开头也再判一次 `ctx+0x1838`（同一字节）。
- 所以：没有任何脚本导出光标回调时整个拾取都不跑；**光标回调在同一帧里先于计时器与 `update` 执行**，回调里写的字段 `update` 当帧读得到、当帧画出【推：渲染在 `0x14018031a` 之后】。`input.*` 不依赖拾取，任何时候都现问宿主。

### 2.4 进出状态（`0x18164e55c`–`0x18164e65a`、收尾 `0x18164f736`–`0x18164f797`）【确】
- 进：`E.vtbl+0x20`（Enter）；压 thisObject（`Sd+0x10`）、thisLayer（第 3 参）、当前脚本三个 deque；`E+0x628 = 1 << idx`、`E+0x62c = idx`；作用域栈压 1（`0x181644010`）；看门狗计数（`0x181653c90`，`E+0x90` 加一，从 0 变 1 时唤醒看门狗，同 p3 E 节【推：唤醒函数身份】）。
- 出：看门狗出（`0x181653d20`），累计耗时进 `E+0x130`，三个 deque 各弹一个，作用域栈弹一个，`E+0x62c = 0x13`、`E+0x628 = 0`，`E.vtbl+0x28`（Leave）。

### 2.5 抛错【确】
- `Function::Call` 返回空（有异常）→ `0x181651ab0(E, message, 0)`。错误级别是 error（`Message::ErrorLevel & 8`）且 `E+0x628 ≠ 0` 时，把当前脚本（脚本 deque 栈顶）的 `+0xdc |= E+0x628`（`0x181651bb0`–`0x181651bff`），即**只禁用这一段脚本的这一个回调**，之后整个场景生命周期都不再调；再按 `"<message> (line L, col C)"` 写 `log.txt`。与 `update` 完全同一条路径。
- 同一图层上别的脚本、同一脚本的别的回调不受影响；exe 的循环继续调下一段。

### 2.6 返回值与 `cursorHitTest`【确；无调用点为【确，有界】】
- 调用后（`0x18164f719`）：只有 `idx ≤ 1`（`init`、`update`）或 `idx == 6`（`animationEvent`）把返回值交给写回函数 `0x181620e10`；**编号 7–13 的返回值直接丢弃**。`CallCallback` 本身返回 void，exe 拿不到任何值。
- `cursorHitTest`（编号 7）：
  - 扫了 exe 全部调 `[reg+0x40]` 的点（`findcb.py`：整个 `wp.asm` 里 `mov r9d, 常数` 0–18；`findcb2.py`：带引擎指针的调用点逐个列出编号），常数里没有 7；变量编号的两处是 `0x14018a766`（只能是 12 / 13）和通用派发 `0x140177b9c`（调用者只传 1、6、14–18）。`0x140170000`–`0x1401a0000` 里也没有 `mov r9d, 7`。
  - dll 里 `Function::Call` 的 8 个调用点（`0x181633a38` `createLayer`、`0x181644300`、`0x181644810`、`CallCallback` 三处、`0x181650280` 计时器、`0x181651788`）没有一个是专门调回调 7 并解释返回值的。
  - `d.ts` 不声明它，WPE 的 `ui/` 与 `assets/` 里也搜不到这个名字，只在 dll 的回调名表里。
  - 结论：2.8.42 里 `cursorHitTest` 是死回调。导出它的唯一效果是第 2.3 节的「打开拾取」；返回值是布尔还是真值都无从谈起。

---

## 3. `input`

### 3.1 对象怎么装【确；V8 API 身份【推】】
- `0x181649d99`–`0x181649f47`：`ObjectTemplate::New`（`0x18000a790`）→ 三次 `0x18000a810(模板, 名字, 取值器, 设值器 = 0, data = 空, 属性 = 1, 0, 0)` → `NewInstance`（`0x180029060`）→ `Global()->Set(context, "input", 实例)`。
- `0x18000a810` 的参数形状与 V8 14 的 `Template::SetNativeDataProperty(name, getter, setter, data, attribute, getter_side_effect, setter_side_effect)` 一致，属性 1 = `ReadOnly`【推】。对 JS 来说三个成员是**只读数据属性，读时调取值器**：每次读都新算；严格模式（模块）里赋值应抛 `TypeError`；`'cursorLeftDown' in input` 不调取值器【推：V8 上游行为】。
- `input` 本身是全局对象上的普通属性，各脚本共享同一个实例。

| 成员 | 取值器 | 宿主调用 | 结果 |
|---|---|---|---|
| `cursorWorldPosition` | `0x181657ee0` | `H.vtbl+0xa8(out, 0)` | 新的 Vec3（原型 `Vec3.prototype`，同 1.2 的 `0x181624910`） |
| `cursorScreenPosition` | `0x181658110` | `H.vtbl+0xa8(out, 1)` | 新的 Vec2（原型 `E+0x348` = `Vec2.prototype`，自有 `x`、`y`，`0x1816582fa`–`0x18165841e`） |
| `cursorLeftDown` | `0x181658470` | `H.vtbl+0xc0(3)` | 布尔（isolate 根表 `+0x380` true / `+0x388` false，`0x18165863e`–`0x18165866a`） |

- 每次读都建新对象，`input.cursorWorldPosition === input.cursorWorldPosition` 为假【确】。

### 3.2 顶层访问的报错【确；错误类型由日志旁证】
- 三个取值器开头都是 `if ([[E+0x3a0] − 4] == 0)`（作用域栈顶）→ 用 stringstream 拼 `成员名 + " cannot be accessed from global scope."`（后缀 `0x1819a30d0`），`Exception::?(msg)`（`0x1800387a0`）→ `ThrowException`。
- `0x1800387a0` 是 **`SyntaxError`**：
  - 8 个同形的 `Exception::*` 构造函数只差取原生上下文的槽（`exc_ctors.txt`）：`0x477`、`0x47b`、**`0x493`**、`0x497`、`0x49f`、`0x4a3`、`0x4ab`、`0x4a7`，与 V8 `NATIVE_CONTEXT_FIELDS` 里 range、reference、（`set_*` 等 5 项）、syntax、type、（uri）、wasm 三四项的排布吻合【推】；
  - 宿主 53 处抛错全部调它，别的 7 个没有宿主调用点【确】；
  - WPE `log.txt` 有一行别的会话的测试：`throw:SyntaxError: getAnimation cannot be called from global scope.`（`thisScene` 方法同一套抛法）【确：日志原文】。
- 原文：`SyntaxError: cursorWorldPosition cannot be accessed from global scope.`，另两个把成员名换成 `cursorScreenPosition` / `cursorLeftDown`。顶层不 `try` 时异常逃出模块求值，**整段脚本失效**（p3 D 节「模块求值失败」）。
- 作用域栈压入的值：引擎构造压 0（`0x1816480bf`，`edi = 0`）；`LoadScript` 求值模块前压 0（`0x18164c31d` → `0x18164c39b`），结束弹出（`0x18164c51a`）；`CallCallback` 压 1（`0x18164e60c`）；计时器 Tick 压 1（`0x18164faeb`）；`0x1816507e3`、`0x1816515f8` 两处也压 1。所以只有模块顶层（和顶层同步调用到的函数）是「global scope」【确】。

### 3.3 值从哪来（宿主接口 `H`，虚表 `0x14048ea50`，exe 侧）【确；反投影函数身份【推】】
- **世界**（`+0xa8`，`0x14018e070`，`r8b = 0` 分支 `0x14018e106`）：`out = unProject((ctx+0x8c, 1 − ctx+0x90, 0.5), *[ctx+0x38], *[ctx+0x40], viewport (0, 0, 1, 1))`（`0x14019df90`：矩阵乘、求逆、`(win − vp.xy) / vp.zw × 2 − 1`、除 w，形状与 `glm::unProject` 一致），**`ctx+0x118 & 0x400`（正交）时 `z = 0`**。窗口深度 0.5 即 NDC z = 0，与 P4c 控制点的指针反投影（rea-p4c-sim「反投影到 NDC z = 0」）是同一个量。
- **屏幕**（同一方法 `r8b = 1`）：`(ctx+0x8c · ctx+0x74, ctx+0x90 · ctx+0x78, 0)`；`ctx+0x118 & 0x800` 时 `x = (1 − ctx+0x8c) · ctx+0x74`（这一位在视差点 `0x140189cd5` 和投影 `0x1401e5c4a` 里也翻 x，像是镜像开关，来源没查）。按 rea-p4c-sim：`ctx+0x8c/0x90` 是客户区归一化坐标（左上原点、`y` 向下、不钳制），`ctx+0x74/0x78` 是渲染目标宽高（float，`max(2, ·)`）。`engine.screenResolution` 读的正是 `ctx+0x74`（`H.vtbl+0x80` = `0x14018dc50`）。所以 **`cursorScreenPosition` 是渲染目标像素、左上原点、`y` 向下，和 `engine.screenResolution` 同一套单位**。
- **左键**（`+0xc0`，`0x14018e380`）：参数等于 3 才返回 `ctx+0xa4 & 1`，否则 false；dll 恒传 3（`0x181658645`）。拾取判按下 / 抬起用的也是 `ctx+0xa4 & 1`（`0x140189ef4`），`g_PointerState` 也取自 `ctx+0xa4` 的 bit0 / bit1（p2-REPORT）。所以 `cursorLeftDown` 只反映这一位，按命名与 `d.ts` 是左键；哪个物理键置这一位归 exe 侧文档。
- dll 不存这些值，也不按帧快照；读到的就是那一刻 `ctx` 里的字段。

---

## 4. `solid`

### 4.1 描述符【确】
- 根描述符表 `0x1404e8250`（`0x1401e0530` 登记，静态初始化）里依次有 `origin`、`scale`、`angles`、`parallaxDepth`、`sortorder`、`name`、**`solid`**、**`disablepropagation`**；同函数另建方法表 `0x1404e8290`（`getTransformMatrix`、`setParent`、`getAttachment*` 等）。查找函数 `0x1401e1500`、列举函数 `0x1401e1390`。
- `solid`（`0x1401e1272`–`0x1401e12fa`）：类型 6（位），偏移 `0x120`，JSON setter `0x14019c3f0`（布尔，或带 `value` 的对象 → 登记用户属性绑定 `0x1401a4db0`），`+0x40` `0x14019c4c0`（转 JSON），脚本写 `0x14019c5c0`，脚本读 `0x14019c600`，**改值回调 `+0x58 = 0`**。位是 **bit13（`0x2000`）**（存取器里的 `bts/btr 0xd`、`shr 0xd`）。
- **更正 rea-p6b-layout 1.2**：那里说 `solid` 在图像层基类表 `0x1404e8360`；`solid` 串在 exe 里只有两处引用，都在 `0x1401e0530`，登记进的是根表 `0x1404e8250`。

### 4.2 缺省值【确；「没别处清」为【确，有界】】
- 根构造函数 `0x1401ddbb0` 写 `word [obj+0x120] = 0x2001`（`0x1401ddc72`）：bit0（`visible`）与 bit13（`solid`）都置位。调用者是图像层基类构造 `0x1401e6980`（`0x1401e698a`）、对象工厂 `0x14018ff60` 里的 6 处、`0x140256576`，即全部对象类型。
- 扫了 exe 全部对 `+0x120` 的立即数 `and` / `mov`：清的只有 bit0（`0x1401905fa`，工厂里某一类）、bit5（`0x14020b220`）、bit8（`0x140225246`）、bit4 与 bit7（`0x14022b424`），**没有清 bit13 的**；动态清只有 `solid` 自己的 setter。
- 所以**没写 `solid` 的对象一律 `solid = true`**，544 段挂在没写 `solid` 的图层上的脚本能被命中。

### 4.3 各类对象上有没有【推】
- 各类自己的「按名找属性」查不到时回落到根表的查找 `0x1401e1500`：调用者有 `0x1401ef6f0`、`0x1401f3f10`、`0x1401f81f0`、`0x140227de0`、`0x14024d1b0`（粒子，rea-p4f 的 `FUN_14024cb00` 同一带）、`0x14025f030`、`0x1401e1e20`。文本经图像基类再回落。所以文本、粒子、声音等**全部对象都有 `thisLayer.solid`**【推：由调用图推出，没逐类核对查找顺序】。
- `d.ts` 只在 `IEffectLayer`（图像类）里声明了 `solid`。

### 4.4 脚本读写【确】
- 读：dll 取值转换 `0x1816208e0` 的类型 6 分支（`0x181620d63`）：字节非 0 → `true`，否则 `false`。图层代理读字段走这一个转换（调用者 `0x18162b89b` 一带）【推】。
- 写：dll 写回 `0x181620e10` 的类型 6 分支（`0x181621415`）：`IsBoolean`（`0x180016fe0`）为真才 `ToBoolean` 后调描述符 `+0x48`（`0x14019c5c0`，置 / 清 bit13）；数字、字符串等**不写、不报错**。
- 没有改值回调，生效只看谁来读这一位：拾取循环 `0x14018a02d` 每帧对每个对象 `test word [obj+0x120], 0x2000`，**为 0 就跳过这个对象的全部处理**（命中测试与所有事件）。拾取在脚本之前跑（第 2.3 节），所以回调或 `update` 里写的 `solid` **下一帧的拾取才生效**。`0x2000` 掩码在 exe 别处没有对 `+0x120` 的测试【确，有界：`test … +0x120` 的立即数与寄存器掩码扫描】。

### 4.5 哪些对象真的参与拾取（exe 侧，顺带看到）【确】
- 循环对每个 `solid` 对象取类型号（虚表 `+0x60`，`0x14018a041`）：1（图像，`0x140050790`）或 4（文本，`0x1400fde90`）→ 命中测试 `0x14019dbb0`；5 → `0x140185520`；其它（粒子 2 `0x140118a50`、形状 10 `0x14025fa30`、声音、灯等）直接跳过。类型 5 是虚表 `0x140491338` 的类（工厂 `0x14019015e` 建），是哪种对象没查。
- 所以粒子、声音层上的 `solid` 读写正常，但对事件没有作用。

---

## 5. `openUserShortcut`（`0x181656b70`）

- 作用域：`E+0x62c − 11 ≤ 2`，即当前回调编号是 11（`cursorClick`）、12（`cursorDown`）、13（`cursorUp`）才往下走，否则抛 `SyntaxError: Cannot execute user command outside of cursor callbacks.`（`0x1819a3c28`）。`E+0x62c` 在每次 `CallCallback` 结束时复位成 `0x13`，所以计时器、`update`、`cursorEnter` / `Leave` / `Move` / `HitTest` 里都不行；`d.ts` 只说「光标回调里」，实际是这三个【确】。
- 参数：`argc < 1` 或第 0 个不是字符串（实例类型 ≥ `0x80`）→ 返回 `false`【确】。
- 执行：`String::Utf8Value` 后调 `H.vtbl+0xf0`（`0x14018f7d0`）：
  - 看场景 `+0xe0`（`H+0x98`）的 bit28；**没置位直接返回 2**，dll 抛 `SyntaxError: Cannot execute more than one user command per cursor click.`（`0x1819a3c68`）；
  - 置位就**先清掉这一位**（`0x14018f80f`），再按名字找用户属性执行，成功返回 1、否则 0 → JS `true` / `false`；返回值大于 2 时 JS 得到 `undefined`【确】。名字不存在也会用掉这次机会【确：清位在查找之前】。
- token 的来回（exe 侧）：拾取开头左键状态由松变按时 `bts 0x1c`（`0x140189f7f`–`0x140189f8c`）；拾取结尾由按变松时清掉（`0x14018a455`–`0x14018a45e`），这在本帧的 `cursorUp` / `cursorClick` 派发**之后**。所以一次按下—抬起之间，全场所有脚本合计只能成功调一次，`cursorDown`、`cursorUp`、`cursorClick` 里调都算【推：由代码位置推出时序】。
- P6c 不实现，只记录。

---

## 6. 别的光标相关串与 API

| 位置 | 串 / 符号 | 用途 |
|---|---|---|
| dll `0x1819a37a0`–`0x1819a37e0` | `cursorWorldPosition` `cursorScreenPosition` `cursorLeftDown` `input` | 第 3 节 |
| dll `0x1819a3970`–`0x1819a39d0` | `cursorHitTest` … `cursorUp` | 回调名表 `0x1819a3ee0` 的 7–13 |
| dll `0x1819a3434`–`0x1819a3460` | `button` `worldPosition` `localPosition` `hitBox` | 事件键（第 1 节）；前面的 `x` `y` `z` `w` `m` 是向量 / 矩阵键 |
| dll `0x1819a30d0` / `0x1819a30f8` | ` cannot be accessed from global scope.` / ` cannot be called from global scope.` | 顶层访问属性 / 调方法的报错后缀，`input.*` 用前者 |
| dll `0x1819a3c28` / `0x1819a3c68` | 两条用户命令报错 | 第 5 节；`0x18165a770` / `0x18165a7a0` 是只建这两条字符串的小函数，没找到 rel32 调用者 |
| dll `0x1819a3140` / `0x1819a3168` | `models/util/solidlayer_depthtest.json` / `solidlayer.json` | `createLayer` 的缺省模型（`0x1816337d4`–`0x1816337f9`，按某个 exe 对象虚函数 `+0x90` 的返回选深度版），与 `solid` 无关 |
| exe `0x14049032c` | `solid` | 第 4 节 |
| exe `0x140490338` | `disablepropagation` | 根表，`+0x120` bit14，缺省 false（`0x2001` 不含它），存取器 `0x14019bb40` / `0x14019bd10` / `0x14019bd50`，同样无改值回调。拾取里对象处理完后，若它置位且对象连同父链可见（`0x140185010`），**跳出对象循环，下面的对象不再处理**（`0x14018a86f`–`0x14018a899`）。缺省下重叠的多个对象都能收到事件。`d.ts` 没声明；p6b 的对象键统计（`ignore/p6/out/objects-new.json`）里它只以 `false` 出现 |
| exe `0x14048dae8` | `g_PointerState` | 着色器 uniform（槽 `0x6a`），取 `ctx+0xa4`，与 `cursorLeftDown` 同源；Kabegame 现在恒 0（PLAN 517 行），P6c 有了左键输入可以一起喂 |
| exe `0x1404899c0` | `-hideCursor` | 命令行开关，没读 |
| exe 导入 | `GetCursorPos` `ShowCursor` `LoadCursorW` | 输入来源归 exe 侧文档 |

dll 里搜 `hit`、`mouse`、`pointer`、`propagation`、`solid` 的其余命中都是 V8 内部串【确，有界：`strs.py` 全文扫描】。

---

## 未查清

1. `B+0x8 == 0`（thisObject 为空）的绑定是哪类脚本；它们会收到每个对象的光标事件。
2. 类型 5 对象（虚表 `0x140491338`）是哪种对象，它的命中测试 `0x140185520` 怎么算 `local`。
3. `cursorLeave`、「松开在外面」的 `cursorUp` 时 `D.local` 是什么（命中测试未命中时写不写输出）；图像层命中测试的 `local` 原点、是否经过旋转缩放、是否除以尺寸——归 exe 侧文档。
4. `0x18000a810` 是 `SetNativeDataProperty` 还是别的模板 API（决定 `Object.getOwnPropertyDescriptor(input, …)` 的形状和赋值是否抛错）。
5. `0x1800387a0` 是 `SyntaxError` 由原生上下文槽排布与日志旁证得出，没对 V8 14.7 源码逐项核对。
6. 绑定链表 `S+0xd8` 的插入位置（决定同层多段脚本的调用顺序）。
7. `ctx+0x118 & 0x800`（翻转 x）由什么设置。
8. 一个光标回调里同步触发了另一次 `CallCallback`（例如脚本销毁图层引出 `destroy`）时，`E+0x62c` 会被内层复位成 `0x13`，外层再调 `openUserShortcut` 会抛错——只是由代码推出，没找到实际会嵌套的路径。

## 建议的实测

测试工程的脚本都用 `console.error('[kbp]', …)` 写进 `log.txt`；场景 1920 × 1080 正交，测试窗口同比例。

1. **事件对象的形状**（最优先，一段 `cursorClick` 就够）：
   ```js
   export function cursorClick(e) {
     console.error('[kbp] evt', typeof CursorEvent, Object.getPrototypeOf(e) === Object.prototype,
       Object.keys(e).join(','), typeof e.button, e.button, 'screenPosition' in e, typeof e.hitBox,
       e.worldPosition instanceof Vec3, Object.getPrototypeOf(e.localPosition) === Vec3.prototype,
       Object.keys(e.worldPosition).join(','), Math.fround(e.worldPosition.x) === e.worldPosition.x,
       e.localPosition.z, this === undefined, this && Object.keys(this).join(','));
   }
   ```
   预期：`undefined true button,worldPosition,localPosition number 0 false undefined true true x,y,z true <数> false cursorClick,…`。
2. **复用与隔离**：同一图层的 `origin`、`scale`、`alpha` 三个字段各挂一段导出 `cursorClick` 的脚本；第一段把 `e.worldPosition.x = 12345` 并存 `shared.e = e`，后两段打印 `e.worldPosition.x`、`e === shared.e`。预期三段都打印、顺序固定、后两段看不到 12345、`false`。
3. **抛错禁用**：`cursorClick` 第一次 `throw`，之后每次点击打印；同脚本的 `cursorMove` 也打印。预期 `cursorClick` 只出现一次报错行、之后不再进入，`cursorMove` 照常。
4. **`input` 顶层**：模块顶层 `try { input.cursorLeftDown } catch (x) { console.error('[kbp] top', x.name, x.message) }` 与 `console.error('[kbp] in', 'cursorLeftDown' in input)`；另一段脚本顶层不加 `try` 直接读。预期 `SyntaxError cursorLeftDown cannot be accessed from global scope.`、`in true`；不加 `try` 的那段之后 `init` / `update` 都不跑。
5. **`input` 的类型与取值**：`update` 里每 30 帧打印 `input.cursorWorldPosition instanceof Vec3`、`input.cursorScreenPosition instanceof Vec2`、`Object.keys(input.cursorScreenPosition)`、`input.cursorWorldPosition === input.cursorWorldPosition`、`engine.screenResolution`、两个坐标；光标分别停在窗口左上角与右下角。预期屏幕坐标左上约 (0, 0)、右下约等于 `screenResolution`、`y` 向下；正交场景世界坐标 `z === 0`，左下角世界坐标约 (0, 0)。再在 `cursorMove` 里同时打印 `e.worldPosition` 与 `input.cursorWorldPosition`，预期相等。
6. **只读**：`update` 里 `try { input.cursorLeftDown = true } catch (x) { … }` 与 `Object.getOwnPropertyDescriptor(input, 'cursorWorldPosition')`。预期 `TypeError`、`writable: false`。
7. **`cursorLeftDown` 只看左键**：按住右键、中键时打印，预期 false；左键按住时 true。
8. **`solid`**：没写 `solid` 的图像层、文本层、粒子层、声音层各打印 `typeof thisLayer.solid, thisLayer.solid`，预期全是 `boolean true`；`thisLayer.solid = 1` 后读回仍 `true`；在 `cursorClick` 里写 `false`，再点不再触发、`cursorMove` 也停；粒子层导出 `cursorEnter` 并 `solid: true`，预期永远不触发。
9. **`disablepropagation`**：两个重叠的图像层都导出 `cursorClick`，上层分别不写 / 写 `"disablepropagation": true`。预期不写时两层都触发，写了只有上层触发。
10. **`cursorHitTest` 是死回调**：一段脚本只导出 `cursorHitTest`（打印并返回 `false`），另一个图层导出 `cursorClick`。预期 `cursorHitTest` 从不打印，`cursorClick` 照常；再让那个图层上的脚本同时导出两者、`cursorHitTest` 返回 `false`，`cursorClick` 仍触发。
11. **导出只取一次**：`export let cursorClick = () => console.error('[kbp] A'); export function init() { cursorClick = () => console.error('[kbp] B'); }`。预期打印 `A`。
12. **`openUserShortcut`**（P11 再做，这里只留用例）：`cursorEnter` 里调 → 抛 `outside of cursor callbacks`；`cursorDown` 调一次、`cursorClick` 再调 → 第二次抛 `more than one user command per cursor click`；参数传数字 → `false`；不存在的名字 → `false`，同一次点击里再调 → 抛错。

## REA 重核（2026-11-14）

**方法与结果**
- REA 6.9.0，后端 Ghidra 12.1.4，`ghidra.startup_timeout_ms` 生效值 900000。exe 先做完（见 `rea-p6c-dispatch.md` 末节），之后不带快照打开副本 `ignore/p6/rea/cursor/script/scenescript64.dll`（SHA-256 `58039ef9…aad08` 一致，28.7 MB）。
- 第一次查询（`decompile_all` 取 `0x18164e4d0`，15:35 起）触发全量自动分析，**900 s 内没做完**，REA 报 `provider_timeout`（`ghidra.startup_timeout_ms`）。截到的 Ghidra 输出末尾是在对 `0x180e227c0` 一带的 V8 函数做反编译类分析，大量 `Unable to resolve constructor` 警告【推：慢在 Decompiler Parameter ID / Switch Analysis 一类分析器】。没加时重试，`close_binary` 关掉；没有快照、没有 `dec-rea/` 产物。
- 所以**本文 dll 内部的结论这次都没用 REA 重核**：第 1 节事件对象的构造（`0x18164ec5f` 一段、`0x181624910`）、2.2 导出掩码、2.4 进出状态、2.5 抛错禁用、2.6 返回值丢弃、第 3 节 `input` 模板与三个取值器、顶层报错、第 5 节 `openUserShortcut` 的 dll 侧，原结论维持原标记。
- 要在 dll 上用 REA：把 `ghidra.startup_timeout_ms` 再调大（需要远超 15 分钟，具体多少不知道），或在 REA 启动环境里用 `REA_GHIDRA_DISABLED_ANALYZERS` 关掉反编译类分析器、以较低覆盖换取能打开。

**exe 侧部分（同一轮 `wallpaper64.exe` 的 REA 反编译顺带核到）**
- 1.3 `D` 的来历：**成立**。`FUN_140189e10` 栈上 `local_1b0..local_198`：world xyz（每帧算一次）、local xyz（每个对象先清 0，再由命中函数写）、`const char*`（每个对象先置空，`vt[0x88]` 返回真才指向那个 `std::string` 的缓冲）。补充：`vt[0x88]` 只在「帧初按下集合非空，或本帧左键变了」时调；图像层的 `FUN_1401fd690` 遍历 `O+0x4b8` 木偶的命中框表，名字为空时用下标十进制串，与本文一致。
- 2.1 exe 循环：**成立**（七处派发条件、Enter / Leave 每批一次、`CallCallback(E, B+0x38, B+0x48, 编号, &D, 0)`、销毁期整批跳过）。**回答「未查清」6**：绑定时插链表的 `FUN_140178e20` 是 `std::list::push_back`（新节点挂到尾部），所以同一对象上多段脚本的调用顺序 = 链表顺序 = 各段 `LoadScript` 成功的先后。
- 2.3：**成立**（`mask & 0x3f80` → `S+0x130 = 1`；帧函数 `R+0x1848` 门；紧接着 `FUN_140171440(R+0x1718, dt)`）。
- 2.6 `cursorHitTest`：命中函数里的派发编号只有 8–13，没有 7，成立；全 exe 的搜索没重做。
- 3.3 宿主接口：世界 / 屏幕两支**成立**（`FUN_14018e070`）。反投影 `FUN_14019df90` 经 REA 汇编确认是 `FUN_14005ecb0(tmp, P, V)` 相乘、`FUN_14005f730` 求逆，再乘 `(2·win − 1, 1)` 除 w，即 glm::unProject，「反投影函数身份【推】」可改【确】。左键 `+0xc0`（`0x14018e380`）Ghidra 没识别成函数，没重核。
- 5 令牌时序：**成立**，原文的【推】可改【确】：命中函数开头 `cur && cur != prev` 时置 `G+0xe0` bit28；帧末 `cur == 0 && prev != 0` 时清，在本帧全部派发之后；`FUN_14018f7d0` 没有令牌返回 2，有令牌先清位再按名字查用户属性，查不到返回 0（也已用掉）。
- 「未查清」2：类型 5 的 `local` **不是模型空间命中点本身**，而是「模型空间命中点 − 包围盒半尺寸」，且盒子按 `[0, max − min]` 测、不要求 `t ≥ 0`，详见 dispatch 文档 3.4 的重核。
- 「未查清」3：**已回答**：图像 / 文本未命中时，交点在射线前方（`t ≥ 0`）就照写外推的 `local`；平行或交点在后方时不写，保持每对象清的 0。`cursorLeave` 与「松开在外面」的 `cursorUp` 带的就是这个值。原点、旋转缩放、是否除以尺寸：`local = (u·size.x, (1 − v)·size.y, 0)`，`u`、`v` 是四边形参数（已除以 `det`），四边形经过世界矩阵（含父链、`alignment`、文本 `anchor`）与视差偏移。
