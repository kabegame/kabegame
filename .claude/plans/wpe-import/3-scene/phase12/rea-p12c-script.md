# REA：P12c 步骤 0 —— puppet 动画层的脚本 API 补查（WPE 2.8.42 `wallpaper64.exe` / `scenescript64.dll`）

> 读码代理产出。只做静态分析，没有运行、附加或改动 WPE。
> 置信度：
> - **静态确认**：汇编直接看到。
> - **推断**：由代码推出，但缺一环（例如没实测、某个 V8 内部函数的身份按形态认定）。
> - **未知**：查到某处为止，没有结论。
>
> exe 地址以 `0x140000000` 为基址，`scenescript64.dll` 地址以 `0x180000000` 为基址。汇编、字符串只当数据看。
> 结构叫法沿用 [rea-p12-runtime](rea-p12-runtime.md) / [rea-p12-attach-physics](rea-p12-attach-physics.md)：**L** 图像层、**P** = `L+0x4b8` 的 puppet 运行时、**O** 模型对象（虚表 `0x140491338`）、**S** = `O+0x2d8` 模型的骨骼运行时、**AL** 动画层（0x198 字节，虚表 `0x1404921f8`）、**K** = `AL+0xf8` 时钟、`ctx` = 对象 `+0xc8`、脚本管理器 = `ctx+0x1708`、引擎 **E** = `[ctx+0x1830]`（= 脚本管理器 `+0x128`）、dll 脚本对象 **Sd**、exe 脚本绑定 **B**（脚本管理器 `+0xd8` 链表的节点）。

## 方法

- **分析副本**：`ignore\p9\rea\wallpaper64.exe`（SHA-256 `40e2ce02…5d993b0`）、`ignore\p6\rea\layers\script\scenescript64.dll`（`58039ef9…eaad08`，与 `ignore\p10\rea\` 那份相同），与前几份 rea 用的是同一对文件。
- **没有开 REA**：前几份 rea 都记录 Ghidra 在本机启动分析超时；这一轮直接用全量反汇编 `ignore\p4\rea\wp.asm`（exe）和 `ignore\p6\rea\layers\script\host.asm`（dll `0x181600000`–`0x181680000`），dll 在这一段之外的 V8 内部函数用 `llvm-objdump` 按地址补反汇编。没有可存的 REA 快照。
- **脚本**（`ignore\p12\c\rea\`）：从 `ignore\p12\rea\attach\` 拷来、改成绝对路径的 `pe.py` `fn.py` `slice.py` `grepfn.py` `gall.py` `xr.py` `keys.py` `methods.py` `ptr.py` `rd.py` `vtdump.py`；dll 侧从 `ignore\p6\rea\layers\script\` 拷来的 `dll\pe.py` `dll\vt.py` `dll\sl.py` 等；新写 `dll\jt9.py`（读 dll 跳转表）、`alfields.py`（语料里动画层字段上的绑定与脚本导出的回调）。
- **汇编摘录**（`ignore\p12\c\rea\asm\`、`ignore\p12\c\rea\dll\`）：
  - exe：`model_register_140227470.asm`（模型属性 / 方法表登记）、`model_getlayer_140226bc0.asm`（模型 `getAnimationLayer` / `getAnimationLayerCount`）、`model_create_destroy_140226d00.asm`（模型 `createAnimationLayer` / `playSingleAnimation` / `destroyAnimationLayer`）、`img_getlayer_14020e910.asm`、`img_create_14020ea30.asm`、`img_destroylayer_14020ef80.asm`、`mdlupd_clock_14021c600.asm`（模型更新的层循环开头：推进与播完检测）、`mdlupd_post_14021cd30.asm`（模型更新：事件、播完回调、销毁）、`imgupd_post_1402001c0.asm`（图像层更新的同一段）、`al_methods_14026c3e0.asm`（`IAnimationLayer` 方法原生实现）、`scope_140172830.asm`（脚本绑定定归属 + `init`）、`unbind_140176f70.asm`（按对象解绑脚本、`destroy` 回调）。
  - dll：`slot12_181650660.asm`（引擎槽 12：调播完回调）、`writeback_181620e10.asm`（JS 值 → 原生字段的写入转换）、`callasfn_180022050.asm` / `fncall_180023410.asm`（两个 V8 调用入口的开头）。
- **沿用的已有材料**：rea-p12-runtime 第 1.4、1.5、3.3、3.4 节；rea-p12-attach-physics 第 4 节；p12-REPORT 用例 9；`ignore\p12\b\rea\texchan-model.txt`（P12b2 的模型对象读码，第 4、6、7 节）；rea-p10-keyframes 第 8 节（`FUN_140177ad0` 的派发条件）；rea-p6c-script 第 2.4、2.5 节（`CallCallback` 的进出状态与抛错禁用）、rea-p6c-dispatch（光标派发条件）、rea-p6d-script 第 4.3 节（字段写入口）、p3-script-REPORT I4（`applyUserProperties` 的遍历）、rea-p11-media（媒体回调广播）。

## 概括

| # | 问题 | 结论 | 置信度 |
|---|---|---|---|
| 1 | 模型对象的方法表 | 模型登记 `FUN_140227470`：属性表 `0x1404e8760`（`visible`、`perspective`、`castshadow`、`rootmotion`），方法表 `0x1404e87a0` 只有 5 个方法：`getAnimationLayer`（`0x140226bc0`）、`getAnimationLayerCount`（`0x140226cb0`）、`createAnimationLayer`（`0x140226d00`）、`playSingleAnimation`（`0x140227220`）、`destroyAnimationLayer`（`0x140227260`），参数 / 返回类型与图像层逐项相同。**没有**骨骼、混合形状、骨骼物理的方法。原生实现是图像层那几个的逐指令同构副本，只把层表从 `P+0x3d0` 换成 `S+0x78`、门控换成「`S` 非空且 mdl 非空」。层对象是同一个 AL 类（同一个构造 `FUN_14026c680`、同一张属性表 `0x1404e8a60` 与方法表 `0x1404e8aa0`），所以模型上拿到的 `IAnimationLayer` 与图像层的完全一样。没有骨骼（`S` 为空）的模型：计数 0、查找 `null`。 | 静态确认 |
| 2 | 模型更新 `FUN_14021c480` 的事件与播完 | 和图像层一样：推进时收 MDLA 事件（`[rbp+0x3b8]`）、做同一个播完检测（置 `0x4000000`，`0x14021c732`）、每层推进后清 `setFrame` 位 `0x2000000`（`0x14021c743`）；层循环之后依次 **事件**（`FUN_140177ad0(脚本管理器, O, O, 6, json)`，`0x14021cdbf`）→ **播完回调**（清 `0x4000000`、单次层置 `0x10000000`、`AL+0x130` 非空就调引擎槽 12，`0x14021ce00`–`0x14021ce66`，是 `FUN_140177bf0` 的内联）→ **销毁**带 `0x10000000` 的层（`0x14021ceb0`）。顺序与图像层相同。差别只在门：对象或父链不可见时整个更新不跑，事件、回调都不发，`setFrame` 位也不清。 | 静态确认 |
| 3 | 播完回调的上下文与异常 | 回调登记时 dll 存一个 0x18 字节的结构 `{函数, 登记时的当前脚本 Sd, 登记时的 thisLayer}`。引擎槽 12（`0x181650660`）逐个调：压 `thisObject = Sd 的 thisObject`、`thisLayer = 登记时的 thisLayer`、当前脚本 = Sd，`this` = Sd 的**模块命名空间对象**，`argc = 0`。当前回调位 `E+0x628` 置 0，所以**抛错只写日志、什么都不禁用**，下一次播完照样再调；同一批里后面的回调照常调（只看引擎终止标志 `E+0x95`）。回调是在 exe 的层循环里同步调的，这时本帧所有层已经推进、采样、混合完，所以回调里对任何层的 `play` / `setFrame` / `rate` / `visible` 等写入**都在下一帧生效**；`destroyAnimationLayer` 立即把层从表里摘掉（对象延后析构）。 | 静态确认；`this` 的身份另有实测旁证 |
| 4 | 动画层字段脚本的归属 | 字段脚本的绑定 `B+8`（「名字来源对象」，决定 `thisObject`）是 AL，`B+0x48`（作用域，决定 `thisLayer`）是**图像层 L**：L 加载完后 `FUN_140172830(脚本管理器, L)` 把所有还没归属的绑定的 `+0x48` 写成 L（`0x14017297c`）。由此：光标回调（条件 `B+0x48 == 命中对象`）**会收到 L 的**；`applyUserProperties`（遍历全部已 init 的脚本）、媒体回调（`FUN_140177ad0(…, 0, 0, n)` 全场景广播）**都会收到**；`destroy` 在 AL 析构时由 `FUN_140176f70(脚本管理器, AL, 0)` 发（`B+8 == AL` 的脚本），也就是 `destroyAnimationLayer`（帧尾延后析构）、单次层播完被删、图层 L 析构（`0x1401fb5c0` 逐个删 AL）时。语料 26 段动画层字段脚本只导出 `init` / `update`，这些都中性。 | 归属、各派发条件静态确认；「会收到」由条件推出，没实测 |
| 5 | 可写属性的类型转换 | dll 字段写入口 `0x18162b9a0` 把 JS 值交给通用写入函数 `0x181620e10`，按描述符类型分派后调 exe 的类型化 setter（只存值、不钳制、不调改值回调）。float（`rate` / `blend` / `blendtime`）：**只收 JS number**（含 `NaN`、`±Infinity`），按 `cvtsd2ss` 转 float32；字符串、布尔、对象、`null`、`undefined` **静默忽略**——和 P10 的 `IAnimation.rate` 是同一个函数、同一个分支。bool（`visible` / `additive` / `blendin` / `blendout`）：**只收 `true` / `false`**，数字、字符串、`null` 忽略。string（`name`）：字符串原样；`null` / `undefined` 忽略；数字、布尔、对象先 `ToString` 再写（`2` → `"2"`、`true` → `"true"`）。`blendin = true` 能把位重新置上，但淡入因子按**当前 `t`** 算：`t ≥ min(D/2, blendtime)` 的层下一帧因子就是 1、位又被清掉，看不出淡入；`t` 小（刚回绕、`stop()` / `setFrame(0)` 之后）才会从当时的 `t` 淡入。 | 静态确认（类型分派、setter）；`null` / `undefined` 对应的 Oddball 种类号为推断 |
| 6 | `IAnimationLayer.getAnimation` | 不在 exe 的方法表里。它是 dll 给所有属性对象包装挂的通用 `getAnimation`（本地回调 `0x18162bbe0`，P10 的「对象上的 `getAnimation`」）：按属主（AL）找 P10 关键帧动画，参数是非空字符串时按 `options.name` 或属性名找，否则用当前脚本所挂属性的属性名；找不到时不设返回值，JS 得到 **`undefined`**。语料动画层字段上没有关键帧动画，所以实际总是 `undefined`。 | 入口静态确认（复用 P10）；返回 `undefined` 为推断 |
| 7 | `index` / `autosort` | 照 rea-p12-runtime 1.4 复核成立：`autosort` 必须是 JSON 布尔 `true`，插在从尾往前第一个非加法层之后（没有非加法层时下标 −1，越界写）；否则 `index` 是数时下标 = `idx`（0 ≤ idx ≤ 层数−1），负数或 ≥ 层数−1 都算层数−1，**插在该位置之前**，永远插不到末尾；空表时只有 0 正常；都没有就追加。`createAnimationLayer(…, config)` 走同一个函数，`config` 里的这两个键同样生效。模型的 `FUN_1402230c0` 逐条相同。 | 静态确认 |

**对已有文档的更正 / 补充**：
- **p12-REPORT 用例 9「回调 `this` 为 undefined」**：日志原文是 `this=obj:undefined`，按测试脚本的 `d()`（`ignore\p12\defs\p12.py` 第 459 行）这是「一个 `name` 为 `undefined` 的对象」，不是 `undefined`。读码给出 `this` = 登记回调那段脚本的模块命名空间对象（第 3 节），与日志相符。
- **rea-p12-runtime 3.2 / 5.1「淡出只在 single 模式有效」**：只在加载时成立（`FUN_1401fcc20` 套完属性后对非 single 层清 `blendout` 位）。权重函数 `FUN_14026c8b0` 的淡出分支不看模式，之后脚本或用户属性再把 `blendout` 写成真，循环 / mirror 层也会在每轮末尾淡出（第 5.3 节）。
- **rea-p12-attach-physics 4.5「`destroyAnimationLayer` 返回布尔」**：补「按名字时删掉**所有**同名层；从表里立即摘掉，对象放进 `ctx+0x1478` 延后析构」。

---

## 1. 模型对象的方法表

### 1.1 登记（`FUN_140227470`，静态确认）

`methods.py` 抽 `asm\model_register_140227470.asm`（方法条目：`+0x30` 原生、`+0x38` 名字、`+0x58` 参数类型、`+0x70` 返回类型，同 rea-p4f）：

| 方法 | 原生 | 返回 | 参数 | 图像层对应 |
|---|---|---|---|---|
| `getAnimationLayer` | `0x140226bc0` | `0x800` | `0x208` | `0x14020e910` |
| `getAnimationLayerCount` | `0x140226cb0` | `0x8` | — | `0x14020e9f0` |
| `createAnimationLayer` | `0x140226d00` | `0x800` | `0x600`, `0x600` | `0x14020ea30` |
| `playSingleAnimation` | `0x140227220` | `0x800` | `0x600`, `0x600` | `0x14020ef40` |
| `destroyAnimationLayer` | `0x140227260`（`lea rcx`，`0x140227c0d`） | `0x2` | `0xa08` | `0x14020ef80` |

- 属性表 `0x1404e8760`：`visible`、`perspective`、`castshadow`、`rootmotion`（与 rea-p5-mesh 2.2 一致）。
- 字符串 `getBoneCount`、`getBlendShapeWeight`、`applyBonePhysicsImpulse` 等只被图像层登记 `FUN_1402110be` 引用，模型没有这些方法。

### 1.2 原生实现（静态确认）

- `getAnimationLayer`（`asm\model_getlayer_140226bc0.asm`）与图像层 `0x14020e910` 逐指令同形：
  ```c
  if (!O->S (+0x2d8) || !O->mdl (+0x2e8) || !*(u64*)O->mdl) return;   // 图像层：!P || !P+8
  if (实参类型 & 0x8) { i = int; if (i >= 0 && i < count(S+0x78)) *ret = S+0x78[i]; }
  else if (实参类型 & 0x200) { if (s[0]) for (AL : S+0x78) if (AL->name == s) *ret = AL; }   // 最后一个匹配
  ```
- `getAnimationLayerCount`：`count(S+0x78)`，门不过返回 0。
- `createAnimationLayer`：读 `config.blendin` / `blendout`、`animation` 与图像层同一套（`keys.py` 两边的字符串引用一一对应），建层调模型自己的 `FUN_1402230c0`；`playSingleAnimation` 调它再 `or [AL+0x104], 0x8000000`（`0x140227247`）；`destroyAnimationLayer` 在 `S+0x78` 上按名字 / 下标 / 对象删。
- 层对象：`FUN_1402230c0`（`0x1402231bc`）与图像层 `FUN_1401fcc20`（`0x1401fcd1d`）都调 `FUN_14026c680` 构造，虚表 `0x1404921f8`，属性 / 方法表都是 `FUN_14026c980` 登记的那两张。所以模型上 `getAnimationLayer` 返回的包装成员、读写规则、`addEndedCallback` 与图像层完全相同。
- `S` 只在 mdl 有骨骼时建（texchan-model 第 4 节）：没有 MDLS 的模型 `getAnimationLayerCount()` 为 0、`getAnimationLayer(x)` 为 `null`（同图像层静态 puppet 的实测）。

## 2. 模型更新里的事件、播完与销毁

### 2.1 层循环（`asm\mdlupd_clock_14021c600.asm`，静态确认）

```c
for (i = 0; i < count(S+0x78); i++) {                     // 0x14021c630
    AL = S+0x78[i];
    if (!(AL->bits (+0xd0) & 1)) continue;                 // visible 为假：不推进、不检测、不清 setFrame 位
    old = K.flags; t_old = K.t;
    FUN_1401a9f60(dt * AL->rate, &K, &events /*rbp+0x3b8*/);   // 0x14021c68d：收 MDLA 事件
    FUN_140170580(&K, &lo, &hi, &f);
    if (!(old & 0x62000000)) {                              // 0x14021c6e6
        ended = single ? (K.flags & 0x40000000) : mirror ? ((old ^ K.flags) >> 31) : (t_old > K.t);
        if (ended) { K.flags |= 0x4000000; anyEnded (rbp+0xb90) = 1; }   // 0x14021c732
    }
    K.flags &= ~0x2000000;                                  // 0x14021c743：清 setFrame 位
    w = FUN_14026c8b0(AL);                                  // 权重；w == 0 的层在这之后才跳过
    ...                                                     // 采样、混合、变形权重（texchan-model 第 4 节）
}
```
- 推进、事件收集与播完检测都在算权重之前，所以 **`w == 0` 的层照样推进、照样发事件和播完回调**，只是不参与姿势（texchan-model 第 7 节第 2 条）。

### 2.2 层循环之后（`asm\mdlupd_post_14021cd30.asm`，静态确认）

```c
for (e : events) FUN_140177ad0(ctx+0x1708, O, O, 6, e.json);         // 0x14021cd92–0x14021cdcb
if (anyEnded) {
    for (i = 0; i < count(S+0x78); i++) {                             // 每轮重读 S+0x78
        AL = S+0x78[i];
        if (!(K.flags & 0x4000000)) continue;
        K.flags &= ~0x4000000;
        if (K.flags & 0x8000000) K.flags |= 0x10000000;
        if (AL+0x130 != AL+0x138 && E = [ctx+0x1830])
            E->vtbl[0x60](E, AL+0x130 的首址, 个数);                  // 0x14021ce66
    }
    for (i = 0; i < count(S+0x78); i++)
        if (S+0x78[i]->K.flags & 0x10000000) { delete AL; 从 S+0x78 删; i--; }   // 0x14021cec7：立即 delete
}
交换 S+0x90 / S+0x98 → 姿势、父链、蒙皮 ……
```
- 图像层 `imgupd_post_1402001c0.asm` 是同一结构：事件 `0x140200201`（脚本管理器取自 `FUN_1400eb120(ctx) = ctx+0x1708`），回调经 `FUN_140177bf0(ctx+0x1708, 首址, 个数)`，而 `FUN_140177bf0` 就是 `mov rcx, [rcx+0x128]; jmp [vtbl+0x60]`（`[ctx+0x1708+0x128] = [ctx+0x1830]`），所以两条路调的是同一个引擎槽，参数相同。
- **顺序**：两边都是「全部事件 → 逐层播完回调 → 销毁单次层」，然后才算骨骼矩阵。
- **差别**：
  - 模型更新开头的门（texchan-model 第 4 节）：`O+0x120 bit0` 为假或父链不可见就整个返回——时钟、事件、回调、`setFrame` 位都冻结；图像层不看可见性。
  - 动画层自己的 `visible` 两边规则相同：为假的层不推进、不检测，`setFrame` 的 `0x2000000` 位一直留着，直到它重新可见的那一帧推进后才清，那一帧也因此不判播完。

## 3. 播完回调

### 3.1 登记：`addEndedCallback(fn)`（静态确认）

- exe 方法表里 `addEndedCallback` 的参数类型是 `0x2000`（函数），原生 `0x14026c4f0` 只把 `r9[0]`（dll 给的指针）`push_back` 到 `AL+0x130`，**不看实参类型码**。
- dll 方法桩 `M`（`0x1816214a0`）的 `0x2000` 分支（`0x18162264c` 起）：
  - 实参要过 `0x180016480`：堆对象且 map 的 `bit_field` bit1（可调用）为真，即「可调用对象」【推断：按 V8 map 布局认定】。
  - 通过时 `new 0x18` 字节：`+0` 函数的 `Global` 句柄（`0x18162c800`）、`+8` = `0x18162b7d0(E)` = 「当前正在执行的脚本」deque（`E+0x4f8`）栈顶，即**登记它的脚本 Sd**、`+0x10` = `0x181643fb0(E)` = thisLayer deque（`E+0x4d0`）栈顶，即**登记时的 thisLayer**；再登记进 `E+0x560` 表（按原生对象分组，AL 析构时引擎槽 13 `0x181650b10` 按对象指针找到它们释放）。
  - 不可调用或缺参数：落到缺省分支（`0x181622b4d`），值是 **空指针**、类型码 `0x80002000`；exe 照样 push 进去。到播完时引擎槽 12 对它解引用（`mov rax, [r14]`，`0x181650756`）——`addEndedCallback(123)` / `addEndedCallback()` 之后层一播完就访问空指针【静态确认：push 0 与解引用；推断：WPE 会崩溃】。

### 3.2 调用：引擎槽 12（`0x181650660`，`dll\slot12_181650660.asm`，静态确认）

```c
void E::CallEndedCallbacks(E, Cb** cbs, uint n) {
    Locker / Isolate::Enter / HandleScope；Context::Scope(E+0x1e0)       // 全部脚本共用一个 context
    for (i = 0; i < n && !E->terminate (+0x95); i++) {                  // 0x181650743
        Cb* c = cbs[i];
        fn = Local(c->fn)；Sd = c->script；
        TryCatch；QueryPerformanceCounter 计时
        作用域栈压 1（E+0x398）                                          // 不是模块顶层：registerAsset 抛错、input 可用
        thisObject 栈压 Sd+0x10；thisLayer 栈压 c->thisLayer；当前脚本栈压 Sd   // 0x18165090c–0x181650938
        E+0x628 = 0                                                      // 当前回调位：0
        看门狗计数 +1（0x181653c90）
        recv = Sd+0x8 ? Local(Sd+0x8) : 空                                // Sd+0x8 = 模块命名空间（rea-p6c 2.4）
        r = 0x180022050(fn, context, recv, argc = 0, argv = null)        // 0x1816509a8
        看门狗计数 −1；累计脚本耗时到 E+0x130
        if (r 为空) 0x181651ab0(E, TryCatch.Message(), 0)                 // 0x181650a0f：报错
        E+0x628 = 0；弹出三个栈；作用域栈弹出
    }
}
```
- **上下文**：`thisObject` = 登记脚本的 `thisObject`、`thisLayer` = 登记那一刻的 `thisLayer`、`this` = 登记脚本的模块命名空间对象、没有参数。不是图层的作用域，也不是动画层。p12-REPORT 用例 9 的主脚本挂在图层 `color` 上，所以回调里 `thisLayer` 是 puppet 图层、`thisObject` 也是它；`this=obj:undefined` 正是没有 `name` 导出的命名空间对象。
- **调用函数**：`0x180022050` 的参数排布是 `(this, &ret, context, recv, argc, argv)`，和 `Function::Call`（`0x180023410` → `0x180023040`）不是同一个入口【推断：是 `Object::CallAsFunction`；对普通函数两者结果相同】。
- **当前回调编号 `E+0x62c` 不改**：保持空闲值 `0x13`（`CallCallback` 每次结束都复位它），所以回调里 `openUserShortcut` 照样抛「只能在光标回调里调用」（rea-p6c 第 5 节）【推断：没有嵌套时】。
- **抛错**：`0x181651ab0` 只在 `E+0x628 ≠ 0` 时把当前脚本的 `Sd+0xdc` 或上禁用位（`0x181651bb0`–`0x181651bff`），这里 `E+0x628 = 0`，所以**只写 `log.txt`、不禁用任何东西**：这个回调下次播完照样调，同一段脚本的 `update` 等也不受影响；同一批后面的回调照常调。
- **不检查**：登记脚本是否已禁用（`Sd+0xdc`）、是否已卸载；exe 侧的 `[ctx+0x1710]+0x118 & 0xc000000`（`FUN_140177ad0` 会看）`FUN_140177bf0` 也不看。
- **回调里改回调表**：槽 12 拿的是调用时的首址和个数（`[rbp+0x6f]` / `[rbp+0x77]`），回调里再对**同一层** `addEndedCallback` 让 `AL+0x130` 扩容时，后面几次读的是已释放的旧数组【推断：未定义行为；Kabegame 不必复刻】。

### 3.3 回调里改别的层（静态确认）

- 回调在 exe 的层循环里同步调用（图像层 `0x1402002f1`、模型 `0x14021ce66`），这时**本帧所有层的推进、采样、混合都已做完**（姿势 SoA 已写好，只差父链与蒙皮）。所以回调里对任何层（包括自己）调 `play` / `pause` / `stop` / `setFrame`、写 `rate` / `blend` / `visible` / `blendin` 等，**本帧画面不变，下一帧推进时才读到**——和脚本 `update` 里写的生效帧相同。
- 在回调里 `setFrame(f)`：置 `0x2000000`，下一帧推进前 `old` 带这一位，所以下一帧不判播完（用例 9 的 `setFrame(19.9)` 现象），推进后清掉。
- 单次层（`playSingleAnimation`）在回调里 `play()` 救不回来：`0x10000000` 已在调回调之前置上，回调之后的销毁循环照删。
- `destroyAnimationLayer` 在回调里（`img_destroylayer_14020ef80.asm`）：按名字时删**所有**同名层，`erase` 立即生效，对象 `push_back` 到 `ctx+0x1478`（延后析构，`0x14020f02b`），返回 `true`。播完回调的循环按下标、每轮重读层数，所以删掉排在后面的层会让紧随其后的那一层这帧被跳过：它的 `0x4000000` 位留着，要等以后某一帧又有层播完时才清位、调它的回调【推断：迟到的回调；语料 0 处】。
- `createAnimationLayer` 在回调里：插进层表（可能扩容），循环每轮重新取首址，不会读到旧数组；新层没有 `0x4000000` 位，这帧不调。

## 4. 动画层字段脚本的归属与收到的回调

### 4.1 归属（静态确认）

- `animationlayers` 一项由 `FUN_1401fcc20`（模型 `FUN_1402230c0`）经 `FUN_1401730d0(脚本管理器, AL, json)` 套描述符；`{"script": …}` 建脚本绑定 B，`B+8` = AL（属性的属主）。
- 图像层（模型同理）加载完后，对象工厂 `FUN_14018ff60` 调 `FUN_140172830(脚本管理器, L)`（rea-p10 第 8 节）：
  ```c
  for (B : 脚本管理器+0xd8)                                   // 0x140172970
      if (B->state (+0x44) == 0) { B->scope (+0x48) = L; B->state = 1; }   // 0x14017297c
  for (B : state == 1 且 B->scope == L) 跑 init：CallCallback(E, B+0x38, B+0x48, 0, …)   // 0x140172bd0
  ```
  AL 的字段绑定在 L 加载过程中建，那时还没有归属，于是 `B+0x48 = L`。
- dll 侧：`thisObject` 取 `Sd+0x10`（加载脚本时由 `B+8` 定，即 AL）、`thisLayer` 取 `CallCallback` 的第 3 参 `B+0x48`（即 L）。与实测「`thisObject` 是 `IAnimationLayer`、`thisLayer` 是 puppet 图层」一致。
- 运行时 `createAnimationLayer(animation, config)` 里如果带 `{"script": …}`，绑定建好后没有再调 `FUN_140172830`，`B+0x48` 停在 0【推断：这种绑定的 `init` 何时跑、`thisLayer` 是什么没查；语料 0 处】。

### 4.2 各回调的派发条件与结论

| 回调 | 派发 | 条件 | 动画层字段脚本 |
|---|---|---|---|
| `animationEvent` | `FUN_140177ad0(…, scope = L/O, object = L/O, 6)` | `B+0x48 == scope` 或 `B+8 == object` | 收到（实测） |
| 光标 7–13 | 七处循环（rea-p6c-dispatch 4.1） | `B+0x48 == 命中对象 \|\| B+8 == 0` | **收到 L 的**光标事件，`thisLayer` = L【由条件推出】 |
| `applyUserProperties`（4） | `FUN_1401731d0` 遍历 `脚本管理器+0xd8` 全部 `state == 2` 的脚本（p3-script-REPORT I4） | 导出即调 | **收到**【由条件推出】 |
| 媒体 14–18 | `FUN_140177ad0(…, 0, 0, n)`（rea-p11-media） | scope 为 0：全场景 | **收到**【由条件推出】 |
| `destroy`（3） | `FUN_140176f70(脚本管理器, 对象, 0)`：找 `B+8 == 对象` 的绑定，导出 `destroy`（掩码 `0x8`）且 `[ctx+0x1710]+0x118 & 0xc000000` 为 0 时 `CallCallback(E, B+0x38, B+0x48, 3)`，然后卸载脚本（`0x1401779a0`–`0x140177a45`） | AL 析构时（`FUN_14026c7e0` 在 `0x14026c829` 调） | **AL 析构时收到**，`thisLayer` = L；时机见下 |
| `init` / `update` | `FUN_140172830` / 每帧脚本段 | — | 收到（实测） |

AL 析构的时机（静态确认）：
- `destroyAnimationLayer`：从层表摘掉、对象进 `ctx+0x1478`，延后到帧尾析构（rea-p6d 4.2 的同一个队列）。
- 单次层播完：更新里当场 `delete`（图像层 `0x140200371`、模型 `0x14021cecf`）。
- 图层 L 析构：`0x1401fb5c0` 逐个 `delete` `P+0x3d0` 里的 AL。L 自己的 `FUN_140176f70(…, L)` 只匹配 `B+8 == L`，动画层字段脚本是经各自 AL 的析构收到 `destroy` 的。
- 场景卸载期间 `0xc000000` 那两位可能已置上，`destroy` 不一定发【推断：没核对卸载时这两位的状态】。

语料（`alfields.py` 扫 `ignore\p12\out\scan.json`）：动画层字段上 26 段脚本（`rate` 13、`visible` 13），导出只有 `init`（23）、`update`（11）；用户属性绑定 `visible` 41、`rate` 27、`blend` 12；没有关键帧动画。上表除 `init` / `update` / `animationEvent` 外都中性。

## 5. `IAnimationLayer` 可写属性的类型转换

### 5.1 写入链（静态确认）

`layer.rate = v` → dll 字段写入口 `0x18162b9a0`（取原生对象 `U`、取描述符）→ `0x181620e10(E+0x1d8, v, 原生对象, 描述符)`。`0x181620e10` 就是 `update` / `animationEvent` 返回值写回用的那个函数（rea-p3、rea-p6c 2.6），按描述符类型（`[desc]`，exe 节点 `+0x30`）查跳转表 `0x181621474`：

| 类型 | 分支 | 判定 | 转换 | exe 类型化 setter（节点 `+0x48`） |
|---|---|---|---|---|
| 4 float（`rate` `blend` `blendtime`） | `0x181620f0c` | `0x180016c70`：Smi 或 map 是 HeapNumber（`0x515`）→ **IsNumber** | `Number::Value` → `cvtsd2ss`；描述符标志 `+0x30 & 4` 时再乘 `0.017453292`（这三项没有） | `0x1401a49f0`：原样存 4 字节，有改值回调才调（这三项没有） |
| 6 bool（`visible` `additive` `blendin` `blendout`） | `0x181621415` | `0x180016fe0`：Oddball 且种类 `& ~1 == 0` → **IsBoolean** | `ToBoolean` → `Boolean::Value` | `0x1401e1c60` / `0x14019b6b0` / `0x14019c170` / `0x14025ae70`：置 / 清 `AL+0xd0` 的 bit0 / 1 / 2 / 3 |
| 5 string（`name`） | `0x181621338` | 是字符串就直接用；Oddball 种类 3、4 跳过；其它 `ToString` | `WriteUtf8` 进缓冲 | `0x1401a4d00`：`strlen` 后赋给 `AL+0xd8` |
| 其它类型不涉及 | | | | |

判定不过时整段跳过：不写、不报错。只读属性（`fps` / `frameCount` / `duration`）没有 setter，严格模式下赋值抛 `TypeError`（实测）。

### 5.2 各种写法的结果

| 写法 | 结果 | 依据 |
|---|---|---|
| `rate = 2` / `0.5` / `-1` / `1e9` | 存 float32，不钳制 | 静态确认 |
| `rate = NaN` / `Infinity` | 照存（HeapNumber 也是 number）；下一帧 `t += NaN·dt` | 静态确认；P10 `IAnimation.rate = NaN` 实测相同 |
| `rate = '2'` / `true` / `{}` / `null` / `undefined` | 忽略，读回原值 | 静态确认；与 P10 实测「`'2'`、`{x: 3}` 读回仍是 1、`true` 读回 1」一致——`true` 是忽略，不是转成 1 |
| `blend`、`blendtime` | 同 `rate` | 同一分支 |
| `visible = 0` / `1` / `'x'` / `null` | 忽略 | 静态确认 |
| `visible = true` / `false` | 置 / 清位，下一帧生效 | 静态确认；实测（用例 9） |
| `name = 5` / `1.5` / `true` / `{}` | `"5"` / `"1.5"` / `"true"` / `"[object Object]"`，之后按新名字查 | 静态确认（`ToString`）；数字的具体格式照 JS |
| `name = null` / `undefined` | 忽略 | 静态确认分支；种类号 3、4 = null、undefined 为推断（V8 现行 Oddball 编号） |
| `name = 'a\0b'` | 存成 `"a"`（setter 用 `strlen`） | 静态确认 |

**和 P10 `IAnimation.rate` 是否同一套**：是。两者的字段写入都经 `0x18162b9a0` → `0x181620e10` 的类型 4 分支，exe 侧也是同一组 float 存取器（`0x1401a4b00` / `0x1401a49f0` / `0x1401a4a10`，rea-p12-attach-physics 4.3）【静态确认】。

### 5.3 `blendin` / `blendout` 再写一次（`FUN_14026c8b0`，静态确认）

```c
w = blend;
if (bits & 4 /*blendin*/) {
    k = (min(D, blendtime) > 1.19e-7) ? min(t / min(D * 0.5, blendtime), 1) : 1;
    w *= k;
    if (!(K.flags & 2 /*single*/) && k >= 1) bits &= ~4;          // 0x14026c923
}
if (bits & 8 /*blendout*/ && min(D, blendtime) > 1.19e-7)
    w *= min((D - t) / min(D * 0.5, blendtime), 1);                // 不看模式
```
- `blendin = true` 写到已经清过位的非 single 层：位回来了，下一帧按当时的 `t` 算 `k`。`t ≥ min(D/2, blendtime)` 时 `k = 1`、位当场又清掉，画面不变；`t` 小于它时从这个 `t` 开始淡入到 1。想要完整的淡入要配合 `stop()` / `setFrame(0)`（`play()` 不归零 `t`，除非层已结束）。
- `blendout = true` 写到非 single 层：加载时的「非 single 清 `blendout`」只做一次，权重函数的淡出不看模式，所以循环层会在每轮末尾 `D − t < min(D/2, blendtime)` 时淡到 0、回绕后跳回 1；mirror 层同理按 `t` 走。
- `blendtime = 0`：`min(D, 0) = 0` 不大于阈值，淡入淡出都按 1（非 single 层的 `blendin` 位同时被清掉）。`blendtime = NaN`：`minss` 遇 NaN 取第二操作数，比较无序走「不大于」分支，同样按 1。

## 6. `IAnimationLayer.getAnimation`

- exe 的方法表 `0x1404e8aa0` 只有 7 项（`play` `pause` `stop` `isPlaying` `setFrame` `getFrame` `addEndedCallback`），没有 `getAnimation`；实测 for-in 列出的 `getAnimation` 是 dll 给属性对象包装统一挂的方法（本地回调 `0x18162bbe0`，rea-p10 第 11 节「对象上的 `getAnimation`」）【静态确认】。
- 行为照 P10：`owner = 对象 vtbl+8()`（AL 的槽 1 是 `0x140031a50`：`return [this+8]`），在动画绑定表里找属主相同、`options.name` 或属性名等于名字的第一条；名字取非空字符串实参，否则取当前脚本所挂属性的属性名（`Sd` 描述符 `+0x38`）；找到返回 `IAnimation`，**找不到不设返回值 → `undefined`**【推断：AL 的属主值与 P10 的绑定属主对得上，没核对】。
- 动画层字段写成 `{"animation": …, "value": …}` 时，`FUN_1401730d0` 会照常建 P10 动画绑定（`FUN_1401a4db0` 依次建 user / animation / script 三种），属主是这个 AL，于是 `layer.getAnimation('rate')` 能拿到它【推断；语料 0 处】。
- 对照：`IVideoTexture.getAnimation` 我们返回 `undefined`，动画层也返回 `undefined` 即可。

## 7. `index` / `autosort`（`FUN_1401fcc20` `0x1401fd078`–`0x1401fd2e4`，静态确认）

```c
a = json["autosort"];
if (a.type == booleanValue (5) && a.asBool()) {
    i = count - 1;
    while (i >= 0 && (layers[i]->bits & 2 /*additive*/)) i--;     // 从尾往前跳过加法层
    pos = i + 1;            // 找到非加法层：插在它后面；一个都没有：i 停在 −1 → pos 实际按 −1 走（0x1401fd0d2 跳过 inc），越界
    vector.insert(begin + pos, AL);
} else if (json["index"].type ∈ {1, 2, 3}) {
    idx = asInt();  n1 = count - 1;                                 // 无符号比较
    pos = (idx == 0) ? 0 : (idx 无符号 ≤ n1 ? idx : n1);           // 负数、≥ n1 → n1
    vector.insert(begin + pos, AL);                                 // FUN_140215a00：插在 pos 之前
} else
    push_back(AL);
```
- `index` 永远插不到末尾：`index = 层数` 或更大都落到「最后一个之前」。空表时 `n1 = −1`（无符号最大），只有 `index = 0` 正常，其它值越界。
- `autosort` 只认 JSON 布尔 `true`；`1`、`"true"` 都不算，落到 `index` / 追加。
- 一个非加法层都没有（含空表）时 `pos = −1`：`insert(begin − 1)`，越界写【静态确认：下标；后果未知】。
- 模型 `FUN_1402230c0` 与 `createAnimationLayer(…, config)` 走同一段逻辑（texchan-model 第 4 节、`keys.py` 两边字符串一致）。语料 219 项都没有这两个键。

---

## 对实现的含义

### 模型对象
- `IModelLayer`（模型的脚本对象）补 `getAnimationLayer` / `getAnimationLayerCount` / `createAnimationLayer` / `playSingleAnimation` / `destroyAnimationLayer`，直接复用图像层 puppet 的实现，层表换成模型运行时的；**不要**给模型加骨骼 / 混合形状 / 物理方法。没有骨骼的模型：计数 0、查找 `null`。
- 模型的动画层与图像层是同一个 `IAnimationLayer`。
- 模型更新照图像层发事件、调播完回调、删单次层，顺序相同；唯一差别是模型或父链不可见时整段冻结（不推进、不发、不清 `setFrame` 位）。

### 播完回调
```ts
// 登记：只收可调用对象；记下登记时的「当前脚本」与 thisLayer
addEndedCallback(fn) {
  if (typeof fn !== "function") return;   // WPE 会存空指针、播完时访问空指针；我们按忽略处理（有意不同）
  this.al.ended.push({ fn, script: currentScript(), thisLayer: currentThisLayer() });
}
// 调用：在更新里、事件之后、删单次层之前，逐层逐个
for (const cb of al.ended) {
  withScriptContext(cb.script /* thisObject、模块命名空间 */, cb.thisLayer, () => {
    try { cb.fn.call(cb.script.namespace); }   // argc 0；this = 登记脚本的模块命名空间
    catch (e) { log(e); }                     // 不禁用任何东西
  });
}
```
- 回调里不在模块顶层（`registerAsset` 抛错、`input` 可用），也不在光标回调里（`openUserShortcut` 抛错）。
- 回调里对层的一切写入下一帧生效；在回调里 `destroyAnimationLayer` 立即从表里摘、对象帧尾再销毁（我们不必复刻「紧随其后的层回调迟到」）。

### 动画层字段脚本
- 作用域（`thisLayer`、派发匹配）= 所属图像层 / 模型；`thisObject` = `IAnimationLayer`。所以它们和图层自身的属性脚本一样收光标回调（按所属图层命中）、`applyUserProperties`、媒体回调；`destroy` 在动画层被删（`destroyAnimationLayer` 帧尾、单次层播完、所属图层销毁）时发。语料里这些都没用到，按同一套派发实现即可，不用另开分支。

### 属性写入
- `rate` / `blend` / `blendtime`：`typeof v === "number"` 才写（`NaN`、`Infinity` 照写），`Math.fround`；其它忽略。与 P10 `IAnimation.rate` 共用一个落点函数。
- `visible` / `additive` / `blendin` / `blendout`：`typeof v === "boolean"` 才写。
- `name`：`null` / `undefined` 忽略；字符串原样（截到第一个 `\0`）；其它 `String(v)`。
- 只读属性严格模式下赋值抛 `TypeError`（已实测）。
- 权重函数的 `blendout` 不看模式：允许脚本 / 用户属性在非 single 层上重新打开淡出，不要在写入时按模式过滤。

### `getAnimation`
- 动画层对象上 `getAnimation` 沿用 P10 的「对象上的 `getAnimation`」，属主是动画层；语料下恒为 `undefined`。

### `index` / `autosort`
- `autosort === true`：插在从尾往前第一个非加法层之后；没有非加法层时 WPE 越界，我们插在开头并照报或忽略（语料 0 处）。
- `index` 是数：`idx === 0 ? 0 : (0 < idx ≤ n−1 ? idx : n−1)`（负数也是 `n−1`），插在该位置之前；空表时只有 0 有意义，其它按追加处理（WPE 越界）。

## 没查清的

1. **`addEndedCallback(非函数)` 的后果**：静态看是空指针进表、播完时解引用；WPE 是否有异常处理兜住、进程是否崩溃没实测（不建议在共享的 WPE 上测）。
2. **`0x180022050` 的身份**：参数排布与 `Object::CallAsFunction` 一致，没找到断言串确认；对函数值与 `Function::Call` 同效。
3. **`null` / `undefined` 的 Oddball 种类号**（`name` 写入跳过种类 3、4）：按 V8 现行编号认定，没在这份 dll 里找到常量表核对。`name = null` 实测一次即可定。
4. **动画层 `getAnimation` 的属主值**：AL 的 `vtbl+8` 返回 `[AL+8]`，它与 P10 动画绑定登记的属主是否同一个值没核对；语料 0 处。
5. **运行时 `createAnimationLayer` 的 `config` 里带 `{"script": …}`**：绑定的作用域、`init` 时机没查。
6. **场景卸载时 AL 字段脚本的 `destroy`**：`FUN_140176f70` 在 `[ctx+0x1710]+0x118 & 0xc000000` 置位时不调 `destroy`，卸载期间这两位的状态没核对。
7. **回调里删 / 加层导致的迟到回调、同层 `addEndedCallback` 让回调数组扩容**：只由代码推出，没有实测；属于 WPE 的未定义行为，不建议复刻。
8. 第 4.2 节光标、`applyUserProperties`、媒体、`destroy` 四项对动画层字段脚本的「会收到」都只由派发条件推出，没有实测（语料 0 处）。

## 实测建议（主会话，可选）

1. `p12-script` 加一段：主脚本 `layer.addEndedCallback(function () { log(this === (导出的某个函数所在模块)), typeof this.update, thisLayer.name, thisObject.name })`——确认 `this` 是命名空间（`typeof this.init === "function"`）；回调里 `throw` 一次，确认之后每轮仍有日志。
2. `rate = true`、`visible = 1`、`name = 5`、`name = null` 各写一次，读回：预期 `rate` 不变、`visible` 不变、`name === "5"`、`name` 不变。
3. 循环层上 `blendout = true`：预期每轮末尾权重降到 0（`g_Bones` 回到静止姿势一侧）。
4. 动画层字段脚本导出 `cursorClick`、`applyUserProperties`：点 puppet 图层、改一次用户属性，预期两者都收到，`thisLayer` 是图层。
5. 带骨骼的模型对象（`3706286085` 的复制工程）脚本里 `getAnimationLayerCount()` / `getAnimationLayer(0).getFrame()`、`addEndedCallback`：预期与图像层相同；把模型 `visible` 设假后回调停发。

## 字段速查（本文新增）

**回调结构**（dll，0x18 字节，`addEndedCallback` 建）：`+0` 函数 `Global`、`+8` 登记脚本 Sd、`+0x10` 登记时的 thisLayer。

**引擎槽**：12（`+0x60`，`0x181650660`）调播完回调 `(E, Cb**, n)`；13（`+0x68`，`0x181650b10`）按原生对象释放登记过的回调结构（AL 析构时调）。

**AL**：`+0x130` 回调指针向量（begin / end / cap = `+0x130` / `+0x138` / `+0x140`）。

**脚本绑定 B**：`+8` 属主对象（动画层字段脚本是 AL）、`+0x40` 回调掩码（bit3 `destroy`、bit4 `applyUserProperties`、bit6 `animationEvent`）、`+0x44` 状态（0 未归属、1 已归属、2 已 init）、`+0x48` 作用域（动画层字段脚本是所属图层）。
