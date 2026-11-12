> 逆向原始记录，代理写的，地址按 Ghidra（基址 `0x140000000`）。只读码，没有实测；实测核对写进 p4-particles-REPORT.md「P4f 语义的实测核对」。本文件覆盖子计划步骤 0a。

# WPE 2.8.42 P4f 粒子脚本接口（`IParticleSystem`）与实例覆盖静态逆向

**概括**
- **方法表：** 粒子对象的反射表由静态初始化函数 `FUN_14024cb00` 登记（`0x1400047d0` 调用）。字段表 `0x1404e87e0` 只有两项：`visible`（`obj+0x120`，和基类同一套存取器）和 `instance`（`obj+0x778`，类型 7、只读，取值器返回子对象指针）。方法表 `0x1404e8820` 有五项：`play` `0x14024c5b0`、`pause` `0x14024c670`、`stop` `0x14024c680`、`isPlaying` `0x14024ca10`（返回布尔）、`emitParticles` `0x14024cac0`（一个参数，类型掩码 8 = 整数）。它们挂在粒子对象虚表 `0x1404915b0` 上（JSON 对象类型字节为 4 时由 `FUN_14018ff60` 建），查不到时回退基类图层表。`instance` 子对象有自己的虚表 `0x140491570` 和字段表 `0x1404e8860`（`FUN_14024d940`），共 24 个字段、没有方法：`d.ts` 里的 7 个系数、`controlpoint0..7`，另外还有 `brightness` 和 `controlpointangle0..7`。子系统和事件实例只是 `sys` 结构，没有虚表也没有描述符，脚本拿不到【确】。
- **`play` / `pause` / `stop`：** `pause` 只做一件事：置 `sys+0x3f7` bit0（下称「暂停位」）。发射函数开头遇到这个位、且脚本数量 ≤ 0 时整段返回，所以发射、`delay` / `duration` / 周期计时、事件实例的建立全部冻结；已有粒子照常模拟。子系统每帧从父拷贝这个字节，所以整棵树都暂停【确】。`play` 清暂停位；只有系统完全不活跃时，才把 `starttime` 置 0 并调 `FUN_14022f5b0`，清掉全部发射器的结束位、重数 `sys+0x3f4`，并递归 static 子系统。它**不复位计时、不预热**【确】。`stop` 把全部发射器标成结束（含 static 子孙）、`sys+0x3f4 = 0`、`layertime = 0`、复位计时（`FUN_14022f6c0`）、清全部粒子（含 static 子孙）、销毁全部活跃事件实例、清跟随表。它比不可见复位多了「标结束」，而且无条件执行【确】。发射门里的 `flags & bit31` 是「已结束」位，不是脚本暂停位；`stop` 借用它，`pause` 不用它。
- **由此推出：** `stop` 之后 `play` 等于不预热地从头开始，`instantaneous`、`delay`、`duration` 都回到初值。自然结束之后调 `play`，结束位会被清掉，但计时没复位：`duration` 型发射器留在 −1，永远不再连续发射，`sys+0x3f4 > 0` 却一直成立，`isPlaying()` 恒为真；只有 `instantaneous` 的发射器（`rate 0`）下一帧又被标成结束，不会再爆发一次【确：代码路径；画面效果是推论】。
- **`isPlaying`：** 等于 `!暂停位 && isActive(sys)`，其中 `isActive` 内联了 `FUN_14022c310` 的同一套条件：任一 static 子系统活跃，或任一活跃事件实例活跃，或 `sys+0x3f4 > 0`，或存活数 > 0。所以暂停期间即使粒子还在也返回假【确】。
- **`emitParticles(n)`：** `n = int(参数)`；`n == 0` 当 1，`n < 0` 直接返回，然后**当场**调 `FUN_1402378a0(sys, dt = 0, n)`。全二进制只有两个调用者：模拟里第三参数恒为 0，这里传 `n`【确】。每个发射器各发 `n` 个，不乘 `instanceoverride.count`，和 `rate` 无关。容量满的发射器什么也不发，其余最多发 `容量 − 存活`。会越过暂停位、结束位（含 `stop` 之后）、`delay > 0`、对象不可见，**不越过容量**。对没被这些门挡住的发射器，`n` 和待发的 `instantaneous` 一起进 `n0`，累积余数 `acc -= n0`，相当于向之后的连续发射**借**了 `n` 个；被门挡住的发射器不记欠账【确】。新粒子在脚本阶段出生，`age = 0`。本帧顶点已经写完，所以下一帧才画，届时 `age = dt′`，比同帧常规出生的粒子大一帧。照常触发 eventspawn / eventfollow，但建实例时模型栈顶是单位阵（`0x140180113` 在脚本前重置）【确】，所以父或子为世界空间时，实例位置不对【推】。
- **`instance` 对象：** 系数是 float、`colorn` 与控制点是 vec3。脚本写入（DLL `0x181620e10` → 描述符 `+0x48`）写字段后调改值回调。除 `rate` 外，回调都是 `0x14022ab30`（置脏 `obj+0x928`），**`rate` 没有回调**【确】。脏位在**下一帧**对象更新开头消费：`rate = max(0.01, rate)`，然后 `FUN_14022bd40(sys, 1, 1)` 从基值重算，并**重开 `rate > 0` 的已结束发射器**（只清 bit31，不加 `sys+0x3f4`、不复位计时），递归 static 子系统；事件实例只重算、不重开【确】。`controlpointN` 写的是实例覆盖的静态值 `io+0xf0+12N`；取值器读回的是这个覆盖值，没设时 x 为 FLT_MAX，不是控制点的实际位置【确】。
- **字段脚本挂在 `instanceoverride` 上：** 加载时 `instanceoverride` 走通用的绑定解析 `FUN_1401730d0`，所以 `{script, value}` 会建脚本绑定【确】。回调返回值写回走的是 DLL 里同一个写入函数（`0x18164f731` → `0x181620e10` → 描述符 `+0x48`），和脚本赋值是同一个 setter，**不比较新旧值**，每次都调回调【确：exe 侧不比较；DLL 侧没逐行读】。帧序是「对象更新（`0x14017fd26`）→ 脚本（`0x1401802e5`）→ 渲染（`0x14018031a`）」，所以第 N 帧写的值在第 N+1 帧的模拟里生效，和我们现在的「粒子先于脚本、脚本后 `sync`」一致，不用挪写回点【确】。
- **HDR 下的 `brightness`：** `k = (*(ctx+0x1a60)+0x118 & 0x2000) && !(sys.flags & 8) ? io.brightness : 1`；`instColor = (0x200000 && colorn 生效) ? colorn·k : (k, k, k)`，写进 `sys+0x3e0..0x3e8`；`sys+0x3ec = io.alpha`，**不乘** `k`【确】。粒子出生时拷进 rgb（与 rgb0），颜色 initializer 再乘到上面（`colorrandom` `mulss`），所以有没有颜色模块都乘 `k`。运行中改值经脏位在下一帧重算，只影响之后出生的粒子【确】。`brightness` 只有这一个读者【确，有界】。
- **一个系统多个 renderer：** 每条 renderer 记录有自己的变体材质，存在记录 `+4`，由 `FUN_1401d2340` 按类型加宏，基础材质相同。厚格式由全部 renderer 的 `need & 2` 决定。顶点缓冲每个系统最多三份：`+0x1f8` 给 sprite / spritetrail 共用，`+0x200` 给 ropetrail，`+0x208` 给 rope；每帧各写一次，和 renderer 个数无关。绘制按记录顺序：每条都先用**自己的**记录调 `FUN_1402298b0`（朝向），再写自己那一类的 `g_RenderVar0` 分量、绑自己的材质、画对应缓冲。`g_RenderVar1` 在循环前按系统写一次。`g_RenderVar0` 是 ctx 全局，没写的分量保留上一次绘制的值（跨系统、跨对象）。速度为 0 的粒子在共用缓冲里照常存在：sprite 画它，spritetrail 的着色器出 NaN、被丢弃【确：CPU 侧；GPU 丢弃是推】。子系统和事件实例走同一个函数，同样适用【确】。

**元数据**
- 目标 `wallpaper64.exe`，SHA-256 `40e2ce021e9352324fadb3b8f72b8ba2a7ee95b71cc571d5b9f84be75cd993b0`，开工核对一致。只分析工作目录里的副本，没有运行或附加 WPE，没有写 Steam 目录。
- 辅助核对 `scenescript64.dll`（WPE `bin/`，SHA-256 `58039ef912fcd51cd833540476e3798268158a06f63003fe94bff1b1cbeaad08`，与 `ignore/p6/rea/sound/` 里的副本一致）。用 `llvm-objdump` 反汇编了 `0x181620000`–`0x181623000` 一段，看完已删掉副本。
- 方法：按地址切片读 `ignore/p4/rea/wp.asm` 的汇编，没开 REA。所有结论都来自汇编。
- 工作目录 `ignore/p4/rea/p4f-script/`：
  - 脚本：`pe.py`（改指本目录的 exe 副本）、`d.py`、`fn.py`、`xr.py`、`grepfn.py`、`slice.py`、`strs.py`、`s.py`、`strref.py`、`vtscan.py`、`vtdump.py`、`rd.py`、`jt.py`、`jt3.py`（借自 p4e-children 与 p6/sound），以及本次新写的：
    - `xrr.py`：按地址区间找引用；
    - `rtti.py`：读 COL（本二进制没有 RTTI，没用上）；
    - `ptypes.py`：列方法登记的参数类型；
    - `dllcall.py`：在 DLL 里找 rel32 调用；
    - `dllstr.py`：在 DLL 里搜字符串。
  - 正则文件：`pat1..8.txt`、`dpat.txt`。
  - 切片：
    - `desc_cb00.asm`：粒子对象描述符 `FUN_14024cb00`；
    - `desc_d940.asm`：`instance` 描述符 `FUN_14024d940`；
    - `methods.asm`：五个方法 `0x14024c5b0`–`0x14024caff`；
    - `f_17fa70.asm`：帧函数到渲染前；
    - `f_171440.asm`：脚本帧函数开头；
    - `f_d2340_br.asm`：renderer 变体分支 `0x1401d25b7`–`0x1401d3000`；
    - `host_vt.txt`：场景对象虚表；
    - `dll_620000.asm`、`dll_620e10.asm`：DLL 属性读写。
  - 另用了 `ignore/p4/rea/p4e-children/` 的 `emit.asm`、`f_bd40.asm`、`obj.asm`、`draw.asm`。
- 标记：【确】读到代码；【推】由代码推出、没逐行确认；【未知】没读到。【确，有界】表示在注明的地址范围里搜过。

**命名**
- `sys`、`ctx`、`obj`、`def`、`R`、`E`、`cp[i]`、`W`、`M`、`uA`、`top` 同 rea-p4e-children。`sys = obj+0x2c0`，所以 `obj+X = sys+(X−0x2c0)`；`R` 是渲染器，`ctx = R+0x10`。
- `io`：实例覆盖子对象 `obj+0x778`（脚本里的 `instance`）。
- `rec`：发射器记录。偏移：`+0x10` rate，`+0x14` 当前 duration，`+0x18` 当前 delay，`+0x1c` / `+0x20` 二者初值，`+0x24` 累积余数 `acc`，`+0x3c` 连发计数，`+0x40` 周期计时，`+0x44` 待发 `pending`，`+0x48` instantaneous 初值，`+0x4c` flags（bit31 已结束）。同 rea-p4b-modules A0–A3。
- 系统状态：
  - `alive` = `sys+0x344` 存活数，`hw` = `sys+0x340` 高水位，`cap` = `sys+0x348` 容量；
  - `open` = `sys+0x3f4` 未结束发射器数（u8）；
  - 「暂停位」= `sys+0x3f7` bit0；
  - `St` = `sys+0x3f0` 系统时间；
  - `layertime` = `obj+0x770`（rea-p4d-modules 的 remap 输入 12）；
  - `starttime` = `sys+0x28`（`FUN_14022f430` 读它做预热时长，`0x14022f436`）。
- `desc`：描述符条目。exe 内部条目从 `+0x30` 起是 `{类型, 偏移, 存取器…}`，查找函数返回 `entry+0x30`，DLL 拿到的就是这个指针，所以 DLL 里的 `[desc+0x18]` = `entry+0x48`。
- `n`：`emitParticles` 的脚本数量（发射函数第三参数）。

---

## 1. `IParticleSystem` 的方法表

### 1.1 登记（`FUN_14024cb00`，静态初始化 `0x1400047d0`）【确】
同 `ISoundLayer`（rea-p6a-sound 第 7 节，`FUN_1401f7090`）的写法：`FUN_140153760` 建两张 `unordered_map`；字段用 `FUN_14015a000` 插入，方法用 `FUN_140178e90` 插入，然后按偏移写条目。

**字段表 `0x1404e87e0`：**

| 名字 | 地址 | 类型 `+0x30` | 偏移 `+0x34` | 存取器 | 回调 `+0x58` | `+0x60` |
|---|---|---|---|---|---|---|
| `visible` | `0x14024cbac`–`0x14024cc17` | 6（位） | `0x120` | `+0x38` `0x1401e1a90`、`+0x40` `0x1401e1b60`、`+0x48` `0x1401e1c60`、`+0x50` `0x1401e1c90`（与基类相同） | 0 | — |
| `instance` | `0x14024cc7d`–`0x14024ccc8` | 7（子对象） | `0x778` | 只有 `+0x50` `0x1401a4da0`：`*out = obj + 0x778` | — | 2（只读） |

**方法表 `0x1404e8820`（条目 `+0x30` 函数、`+0x38` 名字、`+0x58` 参数类型向量、`+0x70` 返回类型）：**

| 名字 | 地址 | 函数 | 返回 | 参数 |
|---|---|---|---|---|
| `play` | `0x14024cd3d` | `0x14024c5b0` | 1（无） | 无 |
| `pause` | `0x14024cde6` | `0x14024c670` | 1 | 无 |
| `stop` | `0x14024ce85` | `0x14024c680` | 1 | 无 |
| `isPlaying` | `0x14024cf3a` | `0x14024ca10` | 2（布尔） | 无 |
| `emitParticles` | `0x14024cfe3` | `0x14024cac0` | 1 | `[8]`（`0x14024cffd`–`0x14024d004`） |

- 参数类型是位掩码（`ptypes.py` 扫全部方法登记）：4 float（`setFrame`、`setCurrentTime`），8 整数（`emitParticles`、视频纹理的 `setFrame`），0x20 vec3（`lookAt`），0x200 字符串（`getBoneIndex`），0x208 字符串或整数（`getEffect`），0x2000 函数（`addEndedCallback`）。所以 `emitParticles` 只收整数【确：掩码；DLL 怎么把 JS 值转成整数、缺参数时传什么没读，见 4.1】。
- 方法实现的调用约定（与声音层相同）：`rcx` = 对象，`r9` = 参数数组（`*r9` 指向第一个参数），第 5 个参数是返回值地址（`isPlaying` 写 `[rsp+0x50]`，压栈 0x28 之后）。

### 1.2 对象类型与查找链【确】
- **建立：** 场景对象工厂 `FUN_14018ff60`，在 `0x1401901df` 判断 JSON 对象类型字节等于 4（粒子）。之后 `new 0x960` → 基类构造 `FUN_1401ddbb0` → 虚表 `0x1404915b0`（`0x14019020b`）→ `obj+0x240` 建一张 map → `FUN_1402293a0(obj+0x2c0)`（系统本体）→ `obj+0x770 = 0` → `FUN_14024d760(obj+0x778, ctx+0x1c88)`（`instance` 子对象）。
- **虚表 `0x1404915b0`**（槽号按 8 字节）：
  - 0 析构 `0x14022ab40`；
  - 2 字段枚举 `0x14024d1b0`、3 方法枚举 `0x14024d590`；
  - 4 字段查找 `0x14024d030`、5 方法查找 `0x14024d4b0`；
  - 8 加载完成 `FUN_14022feb0`、9 每帧更新 `FUN_140230650`、10 绘制 `FUN_140236600`。

  布局与声音层虚表 `0x140490ae8` 逐槽对应（2–5 是反射接口，8、9 是加载与更新）。
- **查找：**
  - 字段：本类表 `0x1404e87e0` → 对象自己的 map `obj+0x240`【未知：内容】→ 基类 `FUN_1401e1390`；
  - 方法：本类表 `0x1404e8820` → … → 基类 `FUN_1401e17e0`（`0x14024d58b`）。

  所以粒子对象上能用基类图层的全部成员；`play` 等五个名字只在粒子对象上有粒子语义，同名的声音层方法在声音层自己的表里。

### 1.3 `instance` 子对象（`FUN_14024d940`，静态初始化 `0x1400047f0`）【确】
- **构造：** `FUN_14024d760`：虚表 `0x140491570`、`io+0x10 = ctx+0x1c88`、`io+0x48` 一张 map。缺省值：
  - `io+0xc8..0xe0` 七个 1.0：alpha、size、count、speed、lifetime、rate、brightness；
  - `io+0xe4..0xec` 为 −1（`colorn` 未设）；
  - 16 个控制点（`controlpoint0..7`、`controlpointangle0..7`）的 **x 分量**为 FLT_MAX（`0x14024d813`–`0x14024d8a9`），y、z 构造时不写【推：多半是 0】；
  - `io+0x1b0 = 0`（脏位，即 `obj+0x928`）。
- **虚表 `0x140491570`**（8 槽）：0 析构 `0x14024d8d0`；2–5 是 `0x14024eae0` / `0x14024eeb0` / `0x14024e970` / `0x14024edc0`，查 `0x1404e8860` / `0x1404e88a0`。方法表是空的：`FUN_14024d940` 里没有 `FUN_140178e90`，24 次全是 `FUN_14015a000`。
- **字段**（全部在 `0x1404e8860`，偏移相对 `io`）：

| 名字 | 偏移 | 类型 | 存取器（`+0x38` / `+0x48` / `+0x50`） | 回调 `+0x58` |
|---|---|---|---|---|
| `alpha` | `0xc8` | 4 float | `0x1401a4b00` / `0x1401a49f0` / `0x1401a4a10` | `0x14022ab30` |
| `size` | `0xcc` | 4 | 同上 | `0x14022ab30` |
| `count` | `0xd0` | 4 | 同上 | `0x14022ab30` |
| `speed` | `0xd4` | 4 | 同上 | `0x14022ab30` |
| `lifetime` | `0xd8` | 4 | 同上 | `0x14022ab30` |
| `brightness` | `0xe0` | 4 | 同上 | `0x14022ab30` |
| `rate` | `0xdc` | 4 | 同上 | **无**（`0x14024de51`–`0x14024de84` 只写 `+0x38/+0x48/+0x50`，新条目由 `FUN_14015a000` 清零） |
| `colorn` | `0xe4` | 2 vec3 | `0x1401a4230` / `0x1401a4530` / `0x1401a4560` | `0x14022ab30` |
| `controlpointN` | `0xf0 + 12N` | 2 | 同 `colorn` | `0x14022ab30` |
| `controlpointangleN` | `0x150 + 12N` | 2 | 同 `colorn` | `0x14022ab30` |

- 都没有写 `+0x60`：不是只读，也没有角度换算位（DLL 读取器只对 `+0x60 & 4` 做角度换算，`0x1816209d6`），所以 `controlpointangleN` 在脚本里就是弧度【确：标志位；换算行为按 DLL 的分支推】。
- `d.ts` 的 `IParticleSystemInstance` 没写 `brightness` 和 `controlpointangle0..7`，exe 里有。

### 1.4 存取器的语义【确】
| 存取器 | 函数（float / vec3） | 做什么 | 谁调 |
|---|---|---|---|
| `+0x38` JSON setter | `0x1401a4b00` / `0x1401a4230` | 从 jsoncpp 值读数；值是对象时取 `value` 键，并经 `FUN_1401a4db0` 登记绑定（script / user / animation）；写字段；调回调 | 加载期 `FUN_1401730d0`，运行时用户属性 `FUN_1401731d0`（P3 I3） |
| `+0x48` native setter | `0x1401a49f0` / `0x1401a4530` | `*(float*)(io+偏移) = *值`（vec3 拷 12 字节）；有回调就 `jmp` 回调 | DLL `0x181620e10`（`0x181621403`、`0x181621455` 的 `call [desc+0x18]`） |
| `+0x50` getter | `0x1401a4a10` / `0x1401a4560` | `*out = 字段`（vec3 拷 12 字节） | DLL `0x1816208e0`（`call [desc+0x20]`） |
| 回调 `0x14022ab30` | — | `io+0x1b0 = 1`，即 `obj+0x928`（脏） | 以上 setter |

- DLL `0x181620e10` 有三处调用：
  - `0x18162ba6d`：和取值 `0x18162b8fc` 成对，是 JS 属性存取的拦截器【推：按成对结构判断】；
  - `0x18163231b`【未知：用途】；
  - `0x18164f731`：紧跟回调异常处理 `0x181651ab0`，即 P3 D 节说的回调返回值写回。

  所以**脚本赋值和字段脚本的返回值写回，在 exe 里走的是同一个 `+0x48`**【确：两处都落到 `0x181620e10` 的 `call [desc+0x18]`】。
- setter 不比较新旧值，写了就调回调【确】。

### 1.5 子系统、事件实例脚本拿不到【确】
- static 子系统和事件实例都是 `FUN_1402293a0` 构造的 `sys` 结构，`[sys+0]` 是 `ctx`，没有虚表，也不在场景对象表里（rea-p4e-children 第 2 节）。反射接口只在 `obj` 上，五个方法都只拿 `obj+0x2c0`（顶层系统）。
- 方法内部会顾及子孙：`play` / `isPlaying` 查 static 与事件实例是否活跃，`play` 递归重开 static，`stop` 递归清空，`pause` 经每帧拷贝传给全部子孙。`emitParticles` 只发顶层（第 2–4 节）。

---

## 2. `play` / `pause` / `stop`

### 2.1 `pause`（`0x14024c670`）【确】
```
pause(obj):  sys+0x3f7 |= 1;  return          // or byte ptr [rcx+0x6b7], 1
```
暂停位的全部作用（在 `0x140150000`–`0x140260000` 里搜 `+0x3f7` / `+0x6b7` 的全部读写，【确，有界】）：
- **发射函数整段返回**（`FUN_1402378a0` `0x1402378c8`–`0x1402378e4`）：`if (sys+0x3f7 & 1) && n <= 0: return`，跳到 `0x14023b312` 的函数尾。模拟里 `n` 恒为 0，所以暂停时这一帧：
  - 不发射；
  - **不走帧尾**（rea-p4b-modules A2）：`delay`、`duration` 不递减，发射器不会在暂停期间结束；
  - 周期计时、`acc`、`pending` 都不动；
  - eventspawn / eventfollow 不建（建实例的代码在发射函数尾部 `0x14023ae9a` 之后）。
- **不影响模拟：** 判死、eventdeath 建实例、控制点、operator 照常，已有粒子继续运动、死亡。
- **传给子孙：** 子系统更新里 `f = sys+0x3f7（整字节） | (emit ? 0 : 1)`，写进每个 static 子系统和活跃事件实例的 `+0x3f7`（`0x1402363aa`–`0x14023641b`、`0x1402364bc`）。新建、复用的事件实例在建立时拷父的字节（`FUN_14022f890` `0x14022f8a3`；复用 `0x140237563`、`0x14023b098`）。所以整棵树一起暂停，而且是同一帧（子系统更新在父模拟之后）。暂停期间因父粒子死亡建出的 eventdeath 实例带着暂停位，预热也发不出粒子。

### 2.2 `play`（`0x14024c5b0`）【确】
```
play(obj):
  sys+0x3f7 &= ~1                                         // 0x14024c5b4
  for (E, child) in static 表:  if FUN_14022c310(child): return     // 0x14024c5be–0x14024c5e5
  for E in 事件表, for inst in E.活跃表:  if FUN_14022c310(inst): return   // 0x14024c5e7–0x14024c62c
  if sys+0x3f4 > 0: return                                // 0x14024c62e
  if alive > 0:     return                                // 0x14024c638
  starttime = 0                                           // 0x14024c649：sys+0x28
  FUN_14022f5b0(sys)                                      // 0x14024c658 尾调用
```
`FUN_14022f5b0`（`0x14022f5b0`）：
```
sys+0x3f4 = 0
for rec in 发射器流（类型 1–3）:  rec.flags &= 0x7fffffff;  sys+0x3f4 += 1
for (E, child) in static 表:  FUN_14022f5b0(child)       // 不碰事件实例
```
- 只在**整棵树都不活跃**时重开，否则只清暂停位。
- **不复位计时**：`duration`、`delay`、`pending`、`acc`、周期计时都保持原值（`FUN_14022f6c0` 不在这条路径上）。
- **不预热**：`FUN_14022f5b0` 不调 `FUN_14022f430`；还把 `starttime` 清 0，以后即使对这个系统重跑 `FUN_14022ebe0`，也不再预热。顶层系统运行中没有别的路径调它，所以这一点在画面上看不出来【推】。

### 2.3 `stop`（`0x14024c680`）【确】
```
stop(obj):
  sys+0x3f4 = 0                                           // 0x14024c69a
  for rec in 发射器流:  rec.flags |= 0x80000000            // 0x14024c6a6–0x14024c6cd（遇到类型 1–3 以外就提前跳出，连带跳过下一步）
  for (E, child) in static 表:  FUN_14022f640(child)      // 0x14024c6dd–0x14024c6f5：子孙 +0x3f4 = 0、全部标结束，递归
  layertime = 0                                           // 0x14024c701：obj+0x770
  FUN_14022f6c0(sys)                                      // 0x14024c708：St = 0，发射器计时回初值，mapsequence 序号清零，递归 static
  if hw > 0:                                              // 0x14024c70d
      memset(寿命列 sys+0x260, 0, sys+0x34c·4);  hw = alive = 0;  sys+0x350 = 0
      rope 表清空（sys+0x220 = sys+0x218）
  for (E, child) in static 表:  FUN_14022fd90(child)      // 0x14024c754–0x14024c770：清粒子、递归、销毁子孙的事件实例
  for E in 事件表:  销毁全部活跃实例（FUN_14022ac60 析构 + 释放 0x4b0），清空活跃表   // 0x14024c772–0x14024c7db
  清空跟随计数表 sys+0x438                                 // 0x14024c7dd 起，内联
```
- `FUN_14022f6c0`（`0x14022f6c0`）：对每个发射器 `+0x14 ← +0x1c`（duration）、`+0x18 ← +0x20`（delay）、`+0x44 ← +0x48`（pending = instantaneous 初值）、`acc = 0`、`+0x3c`/`+0x40` 清零；initializer 13、14 的序号 `+8 = 0`；递归 static。**不动 `flags`**（rea-p4b-modules A3 末条）。
- 空闲实例池保留（同不可见复位，rea-p4e-children 4.1）。
- 不清暂停位。
- 当帧就看不到：脚本在对象更新之后、渲染之前（6.3），绘制函数只在 `alive > 0` 时画（rea-p4e-children 第 6 节），`stop` 之后存活数为 0，所以本帧不画；static 子孙同理，事件实例已经销毁。

### 2.4 结束位 bit31 的含义【确】
`rec.flags` bit31 是「已结束」。置位的地方：
- 帧尾自然结束（`0x14023ae67`，第一次置位时 `sys+0x3f4 -= 1`）；
- `stop`；
- `FUN_14022f640`（eventfollow 父粒子死亡、`stop` 递归）。

清位的地方：
- `FUN_14022f5b0`（`play`、周期复位 `FUN_14022f790`、复用实例）；
- `FUN_14022bd40` 在 `p2 = 1` 时（5.3）。

**它不是脚本暂停位**：脚本暂停用的是 `sys+0x3f7` bit0（2.1）。发射门里 `!(flags & bit31)` 挡的是「已结束」，`stop` 借用它。

### 2.5 组合起来的结果
| 场景 | 结果 | 证据等级 |
|---|---|---|
| `pause` → `play` | 清暂停位，下一帧接着发；计时从暂停时冻结的值继续 | 【确】 |
| `stop` → `play` | 不活跃，于是重开。计时已被 `stop` 复位，所以 `instantaneous` 再爆发一次，`delay` / `duration` 从头算，连续发射重新开始；不预热 | 【确】 |
| 系统还活跃时 `play` | 只清暂停位 | 【确】 |
| 自然结束（全部粒子死光）后 `play`，`duration` 型发射器（`rate > 0`） | 结束位清掉、`sys+0x3f4` 重数；但当前 `duration` 是 −1（`0x14023ae3f`），每帧都走「`duration < 0`：`acc = x − n0`」，**不发连续粒子**；帧尾三支都不成立，不会再结束，`sys+0x3f4 > 0` 一直成立，`isPlaying()` 恒为真 | 【确：路径】【推：画面】 |
| 自然结束后 `play`，只有 `instantaneous` 的发射器（`rate 0`，非周期） | `pending` 已经是 0，下一帧发 0 个，帧尾 `rate ≤ 0` 且非周期，再次标结束（`sys+0x3f4` 减一），**不会再爆发** | 【确：路径】 |
| `stop` 之后改 `instance` 的任一系数（`rate` 除外，含字段脚本每帧写回、用户属性改值） | 下一帧 `FUN_14022bd40(sys, 1)` 清掉 `rate > 0` 发射器的结束位（5.3），**发射重新开始**（计时已被 `stop` 复位）；`sys+0x3f4` 没加。之后这个发射器靠 `duration` 结束时，`sys+0x3f4` 从 0 减成 255（u8），从此 `isActive` 恒真、`play()` 不再重开、`isPlaying()` 恒真，直到下一次 `stop` | 【确：路径】【推：画面】 |
| 暂停期间 `emitParticles(n)` | 照发（第 4 节） | 【确】 |

### 2.6 与对象不可见时的复位叠加【确】
不可见复位：`FUN_140230650` `0x14023068e`–`0x1402307b8`，只在顶层 `alive > 0` 时做，见 rea-p4e-children 3.6。
- 不可见时模拟传 `emit = 0`，`FUN_140236cd0` 根本不调发射函数，和暂停位效果相同（不发射、计时冻结）。暂停位跨不可见保留：重新可见后若仍暂停，照样不发。
- `stop` 与不可见复位的差别：`stop` 无条件执行，并且把发射器标成结束（含 static 子孙）、`sys+0x3f4 = 0`；不可见复位只在有存活粒子时做，不动结束位。所以重新可见后：不可见复位过的系统接着发（计时从头）；`stop` 过的系统不发，要 `play`。
- `stop` 之后存活数为 0，不可见复位就不会再触发。
- 不可见期间 `play`：清暂停位，系统不活跃就重开；可见之后才真正发射。
- 不可见期间 `isPlaying`：不可见复位只清粒子、不标结束，只要还有没结束的发射器且没暂停，就返回真【推：按条件推出】。

---

## 3. `isPlaying`（`0x14024ca10`）【确】
```
isPlaying(obj):
  if sys+0x3f7 & 1: return false                         // 0x14024ca14
  for (E, child) in static 表:  if FUN_14022c310(child): return true
  for E in 事件表, for inst in E.活跃表:  if FUN_14022c310(inst): return true
  if sys+0x3f4 > 0: return true                          // 0x14024ca8e
  if alive > 0:     return true                          // 0x14024ca98
  return false
```
- 后四个条件与 `FUN_14022c310`（`0x14022c310`–`0x14022c3b9`）逐条相同，即 `isPlaying = !暂停位 && isActive(sys)`。`isActive` 递归 static 子系统与**活跃**事件实例，不看空闲池。
- 和 `d.ts` 的说法（「正在发射，或有粒子在模拟」）不完全一样：**暂停时即使还有粒子也返回假**；发射器都结束、粒子都死光、子孙都不活跃时才算停。2.5 里的两种「卡住」情况会让它一直返回真。

---

## 4. `emitParticles(count)`

### 4.1 方法体（`0x14024cac0`）【确】
```
emitParticles(obj, …, args):
  n = *(int32*)args[0]                    // mov rax,[r9]; mov r8d,[rax]
  if n == 0:  n = 1                       // 0x14024cacb
  elif n < 0: return                      // 0x14024cae0 jle → ret
  FUN_1402378a0(obj+0x2c0, dt = 0.0, n)   // xorps xmm1, xmm1；两处 jmp
```
- 缺参数（`undefined`）时 `n` 是多少，取决于 DLL 把它转成什么整数。按「0 当 1」的写法和 `d.ts` 的 `count?`，**多半是 0 → 发 1 个**【推】。非整数（如 2.7）是截断还是舍入同样没读 DLL【未知】。

### 4.2 发射函数的调用者【确，全二进制】
`FUN_1402378a0` 只有三处引用：
- 模拟 `FUN_140236cd0` 的 `0x14023771b`，第三参数 `xor r8d, r8d` = 0，`dt` = `dt′`；
- 本方法的两处 `jmp`（`0x14024cadb`、`0x14024caec`）。

所以 rea-p4e-children 末条那个「第三参数 > 0」就是 `emitParticles`。

### 4.3 发射函数在 `n > 0`、`dt = 0` 时怎么走【确】
```
FUN_1402378a0(sys, dt = 0, n):
  if (sys+0x3f7 & 1) && n <= 0: return           // n > 0 时越过暂停位
  dil = sys+0x41 & 0xc                            // 要不要记新粒子表（事件）
  for rec in 发射器流（JSON 顺序）:                // 循环头 0x1402379aa
    k_n = 0                                       // 0x1402379af
    if alive >= cap: 跳到帧尾                      // 0x1402379c6：这一条一个也不发
    k_n = n                                       // 0x1402379d6
    if rec 已结束 或 暂停位 或 delay > 0:          // 0x1402379d9 / 0x1402379e1 / 0x1402379ea
        跳到发射（发 k_n = n 个），不动 acc、pending、周期计时
    // 门内（常规路径，dt = 0）
    rate = rec.rate (· 音频系数)                   // 有音频时照常取一次系数（0x140237a09）
    周期发射（flags & 4）：P −= 0 / P += 0，可能把 rate 乘 0；只有 P 恰为 0 时开新周期（初值，或刚被 FUN_14022f6c0 复位、还没发射过）
    k_n = pending + n;  pending = 0               // 0x140237acd
    x = rate·0 + acc = acc
    if x < 1 或 duration < 0:  acc = x − f32(k_n)   // 0x140237b62：欠账
    else: …（acc ≥ 1 只可能出现在 duration < 0 的系统上，这里不会走到）
  发射：本条发 min(k_n, cap − alive)              // 球 0x140237c99–0x140237cb5，盒 0x1402384a1–0x1402384b9，图层图像 0x140238c4d–0x140238c6c
  帧尾（A2，dt = 0）：delay −= 0；duration −= 0；rate ≤ 0 且（instantaneous 初值 == 0 或非周期）且尚未结束 → 标结束、sys+0x3f4 −= 1
  事件：eventspawn / eventfollow 照 rea-p4e-children 4.3 建实例（0x14023ae9a 起）
```
- **从哪些发射器、各发几个：** 顶层系统的全部发射器，按流顺序**各发 `n` 个**。不乘 `instanceoverride.count`（`count` 只乘 `rec.rate` 和 `maxtoemitperperiod`，rea-p4b-modules），和 `rate` 无关（`dt = 0`），也不受 `flags & 2`、`maxtoemitperperiod` 限制（它们只限制 `k`）。门内的发射器会把待发的 `instantaneous`（`pending`）一并发掉，但运行中 `pending` 一般已经是 0。
- **越过的门：** 暂停位、结束位（含 `duration` 用完和 `stop`）、`delay > 0`；对象不可见也越过，因为方法直接调发射、不经模拟的 `emit`。
- **不越过的门：** 容量。每条发射器轮到时现算 `cap − alive`，前面的发射器发完，后面的可用量变少；容量满了就丢，不覆盖槽位。门内发射器的欠账照 `k_n` 全额记，被容量砍掉的那部分也算在内。
- **欠账：** 没被门挡住的发射器 `acc` 减 `n`，之后要等 `n / rate` 秒的连续发射才补回来。所以在一个正常连续发射的系统上，`emitParticles(n)` **不增加总粒子数**，只是把 `n` 个提前到现在发；在暂停、已结束、`delay` 中的系统上才是净增加。我们的 `instantaneous` 欠账（P4a 实测）是同一条代码路径。
- **当场发射，不记到下一次模拟：** 新粒子在脚本执行时由 initializer 写好（4.4）。

### 4.4 在帧里的位置与新粒子的初值
- **帧序【确】：** `FUN_14017fa70`：
  - `0x14017fd26` 调 `FUN_1401891a0`，逐对象调虚函数 `+0x48`（粒子 `FUN_140230650`：模拟、写顶点、子系统）；
  - `0x140180108`–`0x14018014b` 把模型栈顶 `*(ctx+0x30)`（`R+0x40`）写成单位阵；
  - `0x1401802e5` 调 `FUN_140171440`（脚本：媒体事件、`animationEvent`、计时器、`update`）；
  - `0x14018031a` 渲染。

  所以 `emitParticles` 在本帧粒子模拟**之后**、渲染之前执行。
- **年龄：** initializer 照常跑（同一套 `FUN_14023b340`），出生 `age = 0`。下一帧模拟开头 `age += dt′` 再判死，然后照常 operator。到下一帧末，脚本粒子 `age = dt′`；而下一帧常规出生的粒子 `age = 0`（出生帧不增龄，rea-framework Q3）。位移都只走过一次 operator【确】。
- **当帧不画：** 本帧顶点已经在 `FUN_1402308a0` 里写完，缓冲的顶点数是写入时的 `alive`（`FUN_140261480` 映射时定）。绘制只看 `alive > 0`，画的是缓冲里原来那批，新粒子下一帧才画【确：顺序；绘制数来自缓冲是推】。
  - 推论【推】：如果写顶点时 `alive = 0`（例如 `stop` 之后，或一直暂停、粒子死光的系统），那帧不写缓冲；同一帧脚本 `emitParticles` 之后 `alive > 0`，绘制会把缓冲里上一次写入的旧顶点画出来一帧。从没写过的缓冲顶点数是 0，什么也不画。
- **位置：**
  - 发射器读控制点 `current`，它是本帧模拟里算好的（世界系统已含 `W`），所以位置与同帧常规发射一致【确】。
  - 图层图像发射器（类型 3）在 `0x140238c96` 读模型栈顶，脚本时它是单位阵不是 `W`，位置会不同【推】。
- **`previous = current` 已经做过**（模拟末 `0x140237798`）。`inheritcontrolpointvelocity` 用的是 `(cur − prev) / ctx+0x150`，所以脚本发出的粒子继承的控制点速度是 0【推：按读取的列推出】。
- **同一段脚本里先写的 `instance` 系数，对这批粒子不生效：** 脏位要到下一帧对象更新才消费（5.3）。例如 `instance.alpha = 0.5; emitParticles(10)`，这 10 个用的还是旧 alpha；控制点覆盖同理，出生点仍是旧位置【确：顺序】。
- **随机数：** 每个新粒子的 `R`、各 initializer 的 `uA` 在脚本阶段从流 A 抽，插在本帧全部粒子模拟之后、下一帧之前【确】。

### 4.5 事件子系统【确 / 推】
- `dil = sys+0x41 & 0xc` 在脚本时是正常值（只有预热期间清零），新粒子照常记进 `sys+0x408`，尾部照常对 eventspawn / eventfollow 条目逐个抽 `uA`、按 `maxcount` 建或复用实例。所以 **`emitParticles` 会触发 eventspawn / eventfollow**【确】。eventdeath 与发射无关，不触发。
- 建实例时 `FUN_14022a360` 用调用时的栈顶 `top`，脚本时它是单位阵。对照 rea-p4e-children 4.5 的表：
  - 本地子 + 本地父：`X = T(p)·L`，与 `top` 无关，正确；
  - 世界子 + 世界父：同样与 `top` 无关，正确；
  - 本地子 + 世界父：常规是 `top⁻¹·T(p)·L = W⁻¹·T(p)·L`，脚本时得 `T(p)·L`，模拟时 `M = W·X`，**多乘一个 `W`**；
  - 世界子 + 本地父：常规 `W·T(p)·L`，脚本时 `T(p)·L`，**少一个 `W`**。

  eventspawn 的 `X` 只算一次，所以偏差一直存在；eventfollow 下一帧起每帧按正确的 `top` 重算，只错建立当帧和预热【确：代码路径】【推：画面】。`W = I` 的对象没有差别。
- 新建实例的 `FUN_14022ebe0`（建孙辈、控制点初值、按 `starttime` 预热）也在脚本时执行，`push(inst)` 同样基于单位阵。实例要到下一帧子系统更新才第一次步进。

### 4.6 不可见对象上【确】
`emitParticles` 照发，`alive > 0`；下一帧 `FUN_140230650` 一开头因「不可见且 `alive > 0`」整套复位（rea-p4e-children 3.6），这批粒子还没画就被清掉。留下的副作用只有随机数消耗，事件实例也随之销毁。

---

## 5. `instance` 对象

### 5.1 写入与读出【确】
- **写：** 脚本 `layer.instance.<键> = v` → DLL `0x181620e10`（数字、`Vec3`、`{x,y,z}`、单个数字铺满，转换规则同 P3 D 节）→ `+0x48` native setter：写 `io+偏移`，然后调回调。除 `rate` 外回调都是 `0x14022ab30`：`obj+0x928 = 1`。
- **读：** `+0x50` getter 原样读 `io` 字段。**当场**就能读回新值（还没进模拟）。读到的是覆盖值，不是模拟器里的有效值：
  - `controlpointN` / `controlpointangleN` 没设过时 x 为 FLT_MAX（3.4028235e38），y、z 是构造时没写的值；
  - `colorn` 没设过时是 (−1, −1, −1)；
  - 系数没写过时是 JSON 值或缺省 1。
- **`instance` 本身只读：** 字段 `+0x60 = 2`。给 `layer.instance` 整体赋值会被拒或忽略【推：按 P3 I3「只读位」推断，DLL 侧没读】。

### 5.2 何时生效：下一帧对象更新开头【确】
`FUN_140230650`（`obj.asm`）：
```
[不可见且 alive > 0：复位]                                 // 0x14023068e–0x1402307b8
if obj+0x928:                                              // 0x1402307bd
    io.rate = max(0.01, io.rate);  obj+0x928 = 0          // 0x1402307c7–0x1402307f1
    FUN_14022bd40(sys, p2 = 1, p3 = 1)                     // 0x1402307fa
dt′ = dt · io.rate                                         // 0x1402307ff，每帧都读，不看脏位
if 可见: layertime += dt′
sys+0x3a0 = W; push; FUN_1402308a0(sys, dt′, emit); pop
```
脚本在对象更新之后跑（4.4），所以第 N 帧脚本写的系数在第 N+1 帧模拟开头生效，影响第 N+1 帧起出生的粒子和每帧现算的量（`dt′`、控制点）。已有粒子的颜色、尺寸、寿命不变（rea-p4a C8）。

### 5.3 `FUN_14022bd40(sys, p2, p3)` 做什么【确】
（rea-p4b-render 7.3、rea-p4c-sim 2、rea-p4e-children 3.4 已分段读过，这里补齐尾部。）
```
push(sys)
active = colorn 已设 且 与系统颜色差 ≥ 0.9/255 且 !(flags & 8);  按 p3 处理父子传递      // 0x14022bd7f–0x14022be4f
FUN_1401d15a0(ctx+0x1a60, def, io, {colorn, active}, sys)   // 实例颜色、alpha、各绑定记录从基值重算（第 7 节）
sys+0x3f7 bit1 = active
for i < sys+0x44（控制点数）:  跳过 flags & 0x10005；按 io 的 controlpointangleN / controlpointN（x 为 FLT_MAX 视为未设）写 base，再按 flags bit1 / 世界位写 current
for (E, child) in static 表:  FUN_14022bd40(child, p2, p3 & ~1)       // 0x14022c1d0–0x14022c207
for E in 事件表:  活跃与空闲实例  FUN_14022bd40(inst, 0, p3 & ~1)     // 0x14022c220–0x14022c267
pop;  ctx+0x1ca = 1
if p2:                                                                 // 0x14022c29a
    for rec in 发射器流（类型 1–3）:
        if (rec.flags & bit31) 且 rec.rate > 0:  rec.flags &= ~bit31   // 0x14022c2d2–0x14022c2e8
```
- **会重开已结束的发射器：** 条件是 `p2 = 1`（顶层与 static 子孙），且 `rate > 0`（`rec.rate` 已乘 `count`）。
- **重开只清位：** 不加 `sys+0x3f4`，不复位计时。`duration` 用完的发射器 `duration` 仍是 −1，重开后不连续发射（2.5），所以自然结束的系统看不出变化；`stop` 过的系统计时已复位，会真的重新发射，之后有 `sys+0x3f4` 下溢（2.5）。
- 只有 `instantaneous` 的发射器 `rate = 0`，不重开。
- 事件实例 `p2 = 0`，只重算不重开。

### 5.4 `rate` 例外【确】
- `rate` 没有回调：写 `rate` 不置脏，不触发 `FUN_14022bd40`。
- 下一帧 `dt′ = dt · rate` 直接用新值，子孙共享 `dt′`。
- **不钳制：** 钳到 0.01 只发生在置脏时，所以单写 `rate = 0` 或负数，`dt′ ≤ 0`，`FUN_1402308a0` 里 `dt′ > 0` 才模拟，整棵树冻结（不增龄、不发射、不移动），但存活粒子照画。同一帧还写了别的系数（置脏）时才钳到 0.01。
- **`FUN_1401d15a0` 里的 `rate` 条目**（类型 2：`turbulence` / `turbulentvelocityrandom` 的 `timescale` 乘 `rate`，rea-p4b-modules、rea-p4e-children 3.4 更正）只在重算时更新。所以只改 `rate` 时，`dt′` 变了，`timescale` 仍是上一次重算时的值，要等别的系数被写才跟上【确：路径】【推：画面】。
- 用户属性改 `rate`（P3 I3 已记「`rate` 无回调」）同样如此。

### 5.5 控制点【确】
- `controlpointN` setter 写 `io+0xf0+12N`（12 字节），`controlpointangleN` 写 `io+0x150+12N`（弧度）。下一帧 `FUN_14022bd40` 把它们写进 `cp[N]` 的 **base**：平移替换（不加 `offset`），角度换 3×3（Z·Y·X），然后按 rea-p4c-sim 2 的规则写 `current`。
- 跳过带 `0x10005` 的点（指针、父控制点、remap 输出），不碰 `previous`。
- 也递归写进 static 子系统和池里的事件实例（rea-p4e-children 3.4）。
- `N ≥ sys+0x44`（系统控制点数）的覆盖不起作用。
- 判断「未设」只看 x 分量是否等于 FLT_MAX（`0x14022bf47`、`0x14022c07d`）。一旦写过，base 就被改了；之后把 x 写回 FLT_MAX 只会让它不再被覆盖，不会恢复成 `offset`。

---

## 6. 字段脚本挂在 `instanceoverride` 上

### 6.1 加载：走通用绑定解析【确】
`FUN_14022af30`：`instanceoverride` 是 JSON 对象（类型字节 7）时，先 `FUN_1401a38f0(io+8, json)`，再 `FUN_1401730d0(ctx+0x1708, io, json)`（`0x14022b75f`–`0x14022b786`）。这就是 P3 I3 的加载期解析：逐键找 `0x1404e8860` 里的描述符，调 JSON setter；值是对象时取 `value` 写字段（`0x1401a4b51` 取 `"value"`），并经 `FUN_1401a4db0` 按 `script` / `user` / `animation` 建绑定。随后 `rate` 钳到 0.01、清脏位、`FUN_14022bd40(sys, 1, 1)`（`0x14022b840`–`0x14022b86f`）。所以 `{"rate": {"script": "…", "value": 1}}` 加载时用 `value`，同时登记成脚本绑定。

### 6.2 写回：同一个 setter，不比较【确】
- 回调返回值在 DLL 的 `CallCallback` 里写回：`0x18164f731` → `0x181620e10` → `call [desc+0x18]`，即 `+0x48` native setter。脚本赋值走的也是 `0x181620e10`（1.4），所以两条路是**同一个 setter**，都在写完后调回调。
- exe 侧不比较新旧值。只要 `update` 返回能转换的值，就每帧写一次、每帧置脏一次（`rate` 除外）。DLL 那一侧有没有先比较，没逐行读【推：P3 实测「同值重发也会再执行一遍」是用户绑定那条路，这里按同样处理】。
- 只有 `init`、`update`、`animationEvent` 的返回值写回，返回 `undefined` 或类型不符时不写（P3 D 节）。

### 6.3 时机：下一帧生效【确】
- 一帧里是：对象更新（含模拟、写顶点、子系统）→ 脚本（`update` 返回值当场写进 `io`、置脏）→ 渲染。第 N 帧写的值在第 N+1 帧对象更新开头经 5.2 进入模拟。加载后第一帧用 JSON 的 `value`，第一次 `update` 的返回值从第二帧起生效。
- 我们现在的帧序（`sync` → `stepParticles` → 脚本 → `sync` → `update`）里，脚本写的值在下一次 `stepParticles` 前才推给模拟器，**与 WPE 等价**。plan 风险 2「WPE 若当场生效要挪写回点」不成立。

### 6.4 每帧置脏的副作用【确：路径】
- 每帧做一次 `FUN_14022bd40(sys, 1, 1)`：实例颜色和各绑定记录从基值重算（结果不变就等于没做）；控制点覆盖每帧重写一次 base 与 `current`；`rate` 每帧钳到 0.01（脚本写的 `rate` 再小也被抬到 0.01）。
- 每帧都重开 `rate > 0` 的已结束发射器（5.3）。对自然结束的系统看不出来；对 `stop` 过的系统等于重新开始（2.5）。
- 字段脚本只挂在 `rate` 上时不置脏（5.4）：`dt′` 跟着变，`timescale` 不跟，也不钳制。

---

## 7. HDR 下的 `instanceoverride.brightness`（`FUN_1401d15a0` 开头）【确】
```
// rcx = ctx+0x1a60（构造时存的是宿主 ctx 指针，0x14017d4c5 → FUN_1401c30a0 写 [rcx] = rdx），rdx = def，r8 = io，r9 = {colorn.rgb, active}
k = ((*(ctx+0x1a60))+0x118 & 0x2000) && !(def+0x8 & 8) ? io.brightness : 1.0     // 0x1401d15ec–0x1401d1609；def+0x8 = sys.flags
if (sys.flags & 0x200000) && active:                                              // 0x1401d160d、0x1401d1634
    instColor = (colorn.r·k, colorn.g·k, colorn.b·k)                               // mulss，colorn 在前
else:
    instColor = (k, k, k)
sys+0x3e0..0x3e8 = instColor                                                       // 0x1401d168b–0x1401d169b
sys+0x3ec        = io.alpha                                                        // 0x1401d16a3–0x1401d16aa，不乘 k
```
- **乘在哪：** 出生时 `FUN_14023b340` 开头把 `sys+0x3e0..0x3e8` 写进 rgb 列（`sys+0x318/0x320/0x328`），有 rgb0 列（`sys+0x24 & 8`）时也写进去；`sys+0x3ec` 写进 a 列（与 a0 列）（`0x14023b3c6`–`0x14023b44f`）。之后颜色 initializer 乘到 rgb 上，例如 `colorrandom` `0x14023b713`–`0x14023b739` 是 `rgb = 抽到的颜色 · rgb`。所以：
  - 只乘颜色三通道，alpha 不乘；
  - 没有颜色模块时是 `colorn·k`（或 `k`）；有颜色模块时，模块颜色（含 `colorn` 的 HSV 平移，rea-p4b-render 7.3）再乘上 `instColor`。两种情况都乘 `k`，乘法都在 `colorn` 之后（逐通道 `mulss`，顺序不影响结果）。
- **HDR 位** `0x2000` 只在加载时判定（P3 K3），运行中切 HDR 不会重算。系统 `flags & 8` 时 `k = 1`。
- **运行中改值：** `brightness` 有回调，置脏 → 下一帧 `FUN_14022bd40` → `FUN_1401d15a0` 重写 `instColor`，只影响之后出生的粒子，已有粒子不变。static 子系统、事件实例在递归里各用自己的 `flags & 8` 重算；新建子系统在 `FUN_14022f890` 里算（rea-p4e-children 3.4）。
- **唯一读者：** `io+0xe0`（`obj+0x858`）只在 `0x1401d15fe` 被读【确，有界：`0x1401c0000`–`0x140260000`】。
- 与 rea-p4a C5、rea-p4b-render 7.3 的写法一致，没有冲突。

---

## 8. 一个系统多个 renderer（补 rea-p4c-render 6.3）

### 8.1 每条 renderer 一个变体材质【确】
`FUN_1401d2340` 先扫一遍 renderer 流算 `need`（`0x1401d2531`–`0x1401d256b`：sprite 按有没有帧序列取 2 或 1，spritetrail 2，rope 8，ropetrail 4），再逐条按类型分支（`0x1401d2590`）建变体：`FUN_140150110(基础材质名, 宏表, 着色器)`，写回**该记录**的 `+4`。

| 类型 | 写回点 | 宏 | 着色器 |
|---|---|---|---|
| 1 sprite | `0x1401d2f78` 分支 | 厚格式时 `THICKFORMAT`，有帧序列时再加 `SPRITESHEET` / `SPRITESHEETBLEND` / `SPRITESHEETBLENDNPOT`；`TEX0FORMAT` 视格式与朝向（rea-p4b-render 2.4） | 基础材质的 |
| 2 spritetrail | `0x1401d2f30` | `THICKFORMAT`、`TRAILRENDERER`，帧序列同上，`TEX0FORMAT` | 基础材质的 |
| 3 rope | `0x1401d2bf9` | `THICKFORMAT`、`TRAILSUBDIVISION`、`TEX0FORMAT`、`ORIENTATION = rec+0xc` | `genericropeparticle` |
| 4 ropetrail | `0x1401d29aa` | `TRAILSUBDIVISION`、`TEX0FORMAT`、`ORIENTATION`、`TRAILRENDERER`、`TRAILSCROLLALPHA` / `TRAILFADEALPHA` / `TRAILFADESIZE` | `genericropeparticle` |

- 「厚格式」由全部 renderer 合起来的 `need & 2` 决定：有 spritetrail 时同系统的 sprite 也走厚格式（rea-p4b-render 2.4）。
- 两个 `sprite` 的朝向不同时，变体最多差一个不影响画面的 `TEX0FORMAT`；朝向本身走 uniform（8.3）。
- blend、深度等 pass 状态来自同一个基础材质。
- 变体是否按（材质名，宏表）缓存、在子系统之间共享，没追 `FUN_140150110`【未知】。

### 8.2 顶点缓冲：每系统最多三份，各写一次【确】
- 建立（`FUN_1401d2340` 尾部，`0x1401d3522` 起）：`need & 3` → `sys+0x1f8`（sprite / spritetrail 共用）；`need & 4` → `sys+0x200`（ropetrail）；`need & 8` → `sys+0x208`（rope）。renderer 再多也只有这三份。
- 每帧写入（`FUN_1402308a0`，`alive > 0` 时）按固定顺序：rope 缓冲（`0x140230919` 起，按 rope 表）→ ropetrail 缓冲（`0x140232c9f` 起，含历史位置更新）→ sprite 缓冲（`0x14023582a` 起）。每份写一次，和 renderer 个数无关。
- sprite 缓冲的格式：厚 / 薄看系统 `flags & 0x3000000`（`0x14023588d`，`0x2000000` 是解析到 spritetrail 时置的，`0x1000000` 是帧序列）。GS 还是四顶点展开看系统 `flags` bit23（`FUN_140229750`，`0x140229750`），也是整个系统一个值。
- **写顶点和 renderer 无关：** 每个存活粒子按槽号写一份，不看速度，不为拖尾跳过任何粒子（rea-p4c-render 6.4「模拟侧没有为拖尾多做任何事」）。
- 两个 `ropetrail` 共用一份历史，段数与间隔取第一个 ropetrail 记录（rea-p4c-render 6.5）。

### 8.3 绘制循环（`FUN_1402366f0`，`0x1402368ef`–`0x140236aa5`）【确】
```
if alive > 0:
  if sys.flags & 0x1000000 且基础材质槽 0 有帧表:                      // 0x140236827–0x1402368e7
      g_RenderVar1 = 帧表第一帧的两个尺寸、帧数、比例（定义见 rea-p4b-render）   // ctx+0xb8..0xc4，按系统写一次，循环里不再写
  for rec in renderer 流（JSON 顺序）:                                   // 0x140236931
    case 1 sprite:      FUN_1402298b0(ctx, rec+4)                                   // 0x140236a6d
    case 2 spritetrail: FUN_1402298b0(ctx, rec+4); RV0.x/y/z = length/maxlength/minlength   // 0x140236a3b–0x140236a65
    case 3 rope:        if alive <= 1: continue（不写任何东西）                     // 0x1402369ed
                        FUN_1402298b0(ctx, rec+4); RV0.z = 0; RV0.w = alive
    case 4 ropetrail:   FUN_1402298b0(ctx, rec+4); RV0.z = 1 − max(计时, 0)/间隔
                        RV0.w = 段数 − 0.5；uvscrolling（0x80000）时 RV0.w = (段数 − 1)·sys+0x30、RV0.x = 段数 − 1
    FUN_140155fc0(rec 的材质)                                            // 绑定
    画：1、2 → sys+0x1f8；3 → sys+0x208；4 → sys+0x200                   // call [*buf]+8
    FUN_140157430(rec 的材质)
```
- **朝向：** 每条记录都用**自己的** `rec+4`（`orientation`、`axis`、`flags`）调 `FUN_1402298b0`，所以两个朝向不同的 `sprite` 各自拿到自己的 `g_Orientation*`。
- **`g_RenderVar0`（`ctx+0xa8..0xb4`）在两次绘制之间：**
  - 是 ctx 全局，不按系统、不按帧复位；
  - sprite 什么都不写；spritetrail 只写 x、y、z；rope 写 z、w（存活数 ≤ 1 时连写都不写）；ropetrail 写 z、w，`uvscrolling` 时再写 x；
  - 没写的分量是上一次绘制留下的，可能来自别的系统或对象。按 rea-p4c-render 6.3，`genericparticle` 不读 `RV0.w`，非 `TRAILRENDERER` 的变体不读 `RV0`，所以残值不影响画面【推】。
- **sprite + spritetrail：** 两次绘制，用同一个 `sys+0x1f8`、同一批顶点、各绑自己的变体，按数组顺序先后画（P4c 步骤 0 已实测两种顺序）。
- **速度为 0 的粒子：** 在共用缓冲里照常存在。sprite 那次画它；spritetrail 那次在着色器里 `v / |v|`、`normalize(cross(…, 0))` 得 NaN，四角无效，被光栅化丢弃【确：CPU 侧不过滤；GPU 丢弃是推，rea-p4c-render 6.4】。
- **rope / ropetrail 与 sprite 混挂：** 各画各的缓冲，互不影响，顺序仍按数组。
- 折射快照、透视覆盖在循环之前，按对象一次（rea-p4e-children 第 6 节），和 renderer 个数无关。

### 8.4 子系统、事件实例【确】
- 绘制递归对每个 `sys` 调同一个 `FUN_1402366f0`，各用自己的 renderer 流、自己的三份缓冲（`FUN_14022c3c0` → `FUN_1401d2340` 每个子系统一份）、自己的变体材质。规则相同。
- `g_RenderVar0/1` 照旧是全局，父子之间同样互相残留。

---

## 9. 和已有读码的冲突与需要更正的地方

1. **rea-p4b-modules A1：** 原文写「`sys+0x3f7` bit0 由子系统更新写入，顶层系统应为 0【推】」。更正：顶层的 bit0 是**脚本暂停位**，由 `pause()`（`0x14024c670`）置位、`play()`（`0x14024c5b4`）清除，每帧经子系统更新传给子孙。另外，bit0 不只是逐发射器的门：`n ≤ 0` 时发射函数**在开头整段返回**，A2 帧尾不跑，所以暂停期间 `delay`、`duration`、周期计时都冻结。
2. **rea-p4e-children 末条：** 「第三参数 > 0（推测是脚本 `emitParticles`）」已确认，见 4.2。那里说的「不受 bit0 挡」要补全：`n > 0` 还越过结束位和 `delay`，但不越过容量；对没被挡住的发射器会把 `n` 记成欠账（4.3）。
3. **rea-p4d-modules：** 原文写「`FUN_14024c680`（复位并清空，调用者未知）」。它就是脚本 `stop()`（`FUN_14024cb00` 在 `0x14024ce85` 登记）。它对 static 子系统递归，对事件实例是销毁（2.3）。
4. **rea-p4a C5「已结束 emitter：`param_2=1` 时 `rate>0` 的已结束 emitter 会被重新打开」：** 要补两点。
   - 重开只清 bit31：不加 `sys+0x3f4`，不复位计时（`duration` 留在 −1）。所以对自然结束的系统看不出效果，对 `stop` 过的系统会真的重新发射，之后有 u8 下溢（2.5、5.3）。
   - 只有 `p2 = 1` 的顶层与 static 子孙重开，事件实例不重开（rea-p4e-children 3.4 已有）。
5. **rea-p4a C5「运行时改值：属性 setter 回调 `0x14022ab30` 置 `obj+0x928`」：** `rate` 例外，没有回调（P3 I3 也记了）。连带两点：单改 `rate` 不钳制 0.01，也不更新 `timescale` 一类类型 2 条目（5.4）。
6. **P4f 子计划的说法：**
   - 「`emitParticles` 是越过常规发射门的一次性发射」：不越过容量；在正常发射的系统上不是净增加，是向累积余数借（4.3）。
   - 「`instance` 对象（7 个系数和 `controlpoint0..7`）」：exe 里还有 `brightness` 与 `controlpointangle0..7`，共 24 个字段（1.3）。
   - 风险 2「字段脚本若当场生效要挪写回点」：WPE 也是下一帧生效，不用挪（6.3）。
   - 但 `emitParticles`、`stop` 是**当场**作用于模拟器的：
     - `stop` 当帧不画；
     - `emitParticles` 的粒子当帧不画（顶点已写），下一帧带一帧年龄出现。

     我们的帧序里脚本之后才 `update` 写顶点，实现时要注意别让脚本发出的粒子当帧就画出来（4.4）。
7. **`d.ts` 的 `isPlaying` 说明**与代码不符：暂停时即使粒子在模拟也返回假（第 3 节）。

---

## 未查完 / 未解决
- **`emitParticles()` 缺参数与非整数参数**【推 / 未知】：exe 里 0 当 1；DLL 把 `undefined`、`2.7`、`"3"` 转成什么整数没读。参数掩码 8 的转换在 DLL 的方法调用桩里，没定位到。
- **DLL 写回前是否比较新旧值**【推】：exe 侧确定不比较；`0x181620e10` 只读了转换与调用 setter 的部分。
- **`0x181620e10` 的第二个调用者 `0x18163231b`** 的用途【未知】（可能是 `thisScene` 或 `scriptProperties` 路径）。
- **`obj+0x240` 这张对象级描述符 map 的内容**【未知】：字段查找在类表与基类之间会查它，粒子对象构造时建空表，谁往里登记没追。
- **缓冲旧顶点那一帧**（4.4 推论）【推】：没逐行追 `FUN_140261480` / 绘制虚函数 `+8` 的顶点数来源。
- **图层图像发射器（类型 3）在脚本时的位置**【推】：只看到它读栈顶（`0x140238c96`），没算脚本时（栈顶为单位阵）的具体偏差。
- **`FUN_140150110` 变体缓存**【未知】：多个子系统、多个对象是否共享同一份编译好的变体。
- **`stop` 遇到未知发射器类型时提前跳出、连带跳过 static 子孙的标结束**（`0x14024c6b6` → `0x14024c8e4`）：流里只有 1–3 和结尾 0，正常不会发生，记一笔。
- `play` 把 `starttime` 清 0 在运行中看不出效果（2.2），没找到运行中重跑顶层 `FUN_14022ebe0` 的路径【推】。

---

## 建议的确定性实验
通用设置同 rea-p4e-children：正交 1920×1080，对象在 (960, 540)，`sphererandom` 距离 0，速度 `velocityrandom min = max`，无重力、无阻力，fps 60（标了 fps 20 的另抓一份）。脚本按 `engine.runtime` 在已知时刻调方法，用一个标记图层的颜色记录 `isPlaying()` 的结果。

| 名 | 设置 | 预测 |
|---|---|---|
| `api-emit-open` | `rate 10`（连续）、`maxcount` 足够；2 s 时 `emitParticles(5)` | 2 s 那一帧之后多出 5 个（下一帧才画，年龄比同帧出生的多一帧）；之后约 0.5 s 不出连续粒子（欠账），4 s 时总数与对照组（不调）相同 |
| `api-emit-paused` | 同上，1 s `pause()`，2 s `emitParticles(5)`，3 s `play()` | 1–3 s 无连续发射；2 s 多出 5 个；3 s 起连续发射立即恢复，没有欠账空窗 |
| `api-emit-default` | 两个发射器；`emitParticles()`、`emitParticles(0)`、`emitParticles(-3)`、`emitParticles(2.7)` 分在不同时刻 | 前两个各发 2 个（每发射器 1 个）；`-3` 不发；`2.7` 看 DLL 截断成 2 还是舍入成 3（每发射器） |
| `api-emit-cap` | `maxcount 8`、`rate 0`、`instantaneous 6`；`emitParticles(5)` | 只多 2 个；容量满时调用什么也不发，不挤掉旧粒子 |
| `api-emit-delay` | 发射器 `delay 3`；1 s `emitParticles(4)` | 1 s 出 4 个；3 s 起 `instantaneous` / 连续发射照常，不受影响 |
| `api-emit-inst` | 1 s 写 `instance.alpha = 0.3` 后同一段脚本 `emitParticles(5)`；对照组 `alpha` 在 0.9 s 写 | 前者这 5 个 alpha 仍是旧值、之后出生的才是 0.3；对照组 5 个都是 0.3 |
| `api-emit-event` | 父 `rate 0`；eventspawn 子系统；对象 `scale 2`、`angles`；子系统本地 / 世界各一份，父本地 / 世界各一份 | 本地 + 本地、世界 + 世界的实例在父粒子处；本地子 + 世界父、世界子 + 本地父的实例偏一个 `W`（4.5） |
| `api-stop-play` | `rate 10`、`instantaneous 5`、`delay 0.5`、`duration 2`；1 s `stop()`、3 s `play()` | 1 s 当帧粒子全消失（RenderDoc 看 1 s 那帧没有该对象的绘制）；3 s 后 0.5 s 先爆发 5 个，再连续发 2 s，然后自然结束；`isPlaying` 1–3 s 为假 |
| `api-play-after-end` | `rate 10`、`duration 1`、寿命 0.5；3 s `play()`；另一组 `rate 0`、`instantaneous 5`，3 s `play()` | 都不再出粒子；第一组 3 s 后 `isPlaying()` 一直为真，第二组为假（2.5） |
| `api-pause-timer` | `duration 2`；0.5 s `pause()`、2 s `play()` | 发射在 2 s 恢复，持续到 3.5 s（暂停冻结了 `duration`）；暂停期间 `isPlaying()` 为假，粒子照常移动 |
| `api-stop-dirty` | `rate 10`、`duration 1`；0.5 s `stop()`；2 s 写 `instance.alpha = 1`（同值） | 2.016 s 起发射重新开始、持续 1 s；之后 `isPlaying()` 恒为真，再调 `play()` 不再有效果（u8 下溢） |
| `api-children` | 带 static 子系统与 eventspawn 子系统；`pause` / `stop` / `play` | `pause` 时子系统也停发、已有粒子继续；`stop` 时全部清掉，空闲池里的实例之后复用；`play` 后 static 子系统一起重开 |
| `api-hide` | 1 s `pause()`，2–3 s 隐藏，4 s `play()`；另一组 2–3 s 隐藏时调 `emitParticles(5)` | 隐藏不清暂停位；隐藏期间 `emitParticles` 的粒子看不到 |
| `inst-rate` | `instance.rate` 由脚本在 1 s 写成 0；`turbulence` 系统写成 2 | 写 0：1 s 后整棵树冻结、粒子不动不死；写 2：运动加快，但湍流的时间比例不变，同时再写一次 `instance.size`（同值）后才跟上 |
| `inst-cp` | 读 `instance.controlpoint1`（没设）；写 `instance.controlpoint1 = (0, 200, 0)` 后同帧读 | 先读到 x = 3.4028235e38；写后当场读回新值；出生点下一帧才变 |
| `inst-script-every` | 字段脚本每帧返回同一个 `alpha`；系统 `duration 1` | 和不挂脚本时一样（重开的发射器 `duration = −1`，不发连续粒子） |
| `bright-hdr` | HDR 场景；`brightness 2`，带 / 不带 `colorrandom`，`flags 8` 对照；关闭档对照 | HDR 下 rgb ×2（有颜色模块也乘），alpha 不变；`flags 8` 与非 HDR 不变 |
| `multi-r` | `sprite` + `spritetrail`；两个朝向不同的 `sprite`；速度为 0 的粒子；`rope` + `sprite` | 两次绘制共用一批顶点；速度为 0 的粒子只有 sprite 那次画；两个 sprite 的 `g_Orientation*` 各不相同 |

### 最想用实测核对的读码结论
1. `emitParticles` 的欠账：在正常连续发射的系统上不增加总数（`api-emit-open`），暂停时才是净增加（`api-emit-paused`）。
2. `emitParticles` 的粒子下一帧才画、年龄多一帧（`api-emit-open` 按帧号判定）。
3. 自然结束后 `play()` 不重新发射，而 `isPlaying()` 一直为真（`api-play-after-end`），这和 `d.ts` 的说明相反。
4. 暂停冻结 `duration` 计时（`api-pause-timer`）。
5. `stop()` 当帧消失（`api-stop-play`）。
6. `stop()` 之后写 `instance` 任一系数会重新开始发射（`api-stop-dirty`）。
7. 单写 `instance.rate` 不钳制、不更新湍流时间比例（`inst-rate`）。
8. 缺参数时发 1 个，以及非整数怎么截（`api-emit-default`）。
