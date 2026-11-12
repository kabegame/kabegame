> 逆向原始记录，代理写的，地址按 Ghidra（基址 `0x140000000`）。只读码，没有实测；实测核对写进 p4-particles-REPORT.md「P4e 语义的实测核对」。本文件覆盖子计划步骤 0a 的子系统一份，音频见 `rea-p4e-audio.md`。

# WPE 2.8.42 P4e 粒子子系统（`children`）静态逆向

**概括**
- **条目解析：** 键是 `name`（子系统文件）、`type`、`origin`、`angles`、`scale`、`flags`、`controlpointstartindex`、`probability`、`maxcount`；`id` 不读。`type`：`static` = 1、`eventfollow` = 2、`eventspawn` = 3、`eventdeath` = 4，**其它字符串 = 0，运行时整条忽略**；缺 `type` 时缺省值函数写回 `"static"`。`static` 条目不读 `probability`、`maxcount`。局部矩阵 `L = T(origin)·Rz·Ry·Rx·S(scale)`，弧度、CRT `sinf/cosf`，与对象变换同一套公式；三个向量都只认字符串，缺的分量是 **0**（`scale "2"` 得到 `(2, 0, 0)`）。
- **条目 `flags` 只有两位有读者：** bit0「父粒子位置写子系统控制点」（强制子系统 `n = 8`，从 `controlpointstartindex` 起逐个写父系统**全部存活粒子**的位置，`static` 和事件类都生效）；bit1「父系统周期发射进入新周期时复位这个 static 子系统」。`controlpointstartindex` 只在 bit0 时有用。
- **结构：** 系统里两张表：`sys+0x480` 是 static 子系统 `(条目, sys)` 对；`sys+0x498` 是事件条目，每条带「活跃实例」和「空闲实例」两个向量。定义按文件名缓存（渲染器级），每个系统拷一份流。嵌套深度 `sys+0x3f8 < 10` 才建子系统，最多 10 层。
- **帧内顺序：** 父系统 `FUN_1402308a0`：系统时间 → 模拟（判死 → eventdeath 建实例、eventfollow 停跟随 → 控制点 → 发射 → eventspawn / eventfollow 建实例 → operator → previous）→ 写顶点 → 子系统更新：先全部 static（条目顺序），再各事件条目的活跃实例（条目顺序、实例按建立先后）。每个子系统用**父的 `dt'`**（已乘 `instanceoverride.rate`）和父的 `emit`，自己的两遍模式照全局 fps。父存活数为 0 时照样更新子系统。
- **static：** 父加载（`FUN_14022ebe0`）时建，建完立即按**自己的** `starttime` 预热；父系统的预热不步进子系统。模拟和绘制的模型矩阵都是 `父栈顶 · L`（**不看子系统的世界空间位**，世界子系统只是把粒子存成世界坐标、绘制用单位阵）。`instanceoverride` 的标量与颜色在子系统建立时作用到子系统（受子系统自己的 `flags` bit3–7 约束）；控制点覆盖只在运行时改值（脏标志）之后才递归到子系统，加载时不作用。
- **事件实例：** 条目 `maxcount` 是**同时活跃的实例数上限**（子系统 JSON 的 `maxcount` 才是每个实例的粒子容量）；满了新事件直接丢，不挤掉旧实例。实例在「自身发射器全部结束、存活数 0、子孙都不活跃」时回收进空闲池（后进先出），复用时 `FUN_14022f6c0` 复位并重开发射器、按 `starttime` 再预热。
- **实例的位置：** 实例的对象矩阵 `X = sys+0x3a0` 由 `FUN_14022a360` 算，等于「平移到父粒子位置 · L」（父本地时含对象 `W`，父世界时不含 `W` 的旋转缩放）。`eventspawn` 取新粒子过完 initializer、operator 之前的位置；`eventdeath` 取死粒子上一帧末的位置；二者只写一次。`eventfollow` 每帧在子系统更新时用父粒子本帧末的位置重写，**本地子系统已发出的粒子跟着父粒子一起走**。
- **父粒子死后的 eventfollow：** 同一帧判死时停跟随（`+0x478 = −1`，矩阵冻结在最后位置）、把实例及其 static 子孙的发射器全部标结束，已有粒子照常活完，然后回收。
- **随机数：** 没有每实例的流。`probability` 用的就是流 A（`ctx+0x1cd0` 的 MT19937，全场景所有系统共用），比较是 `uA ≤ probability` 才建；每个（条目，新粒子）或（死粒子，eventdeath 条目）**无论概率多少都抽一次**，条目满了才不抽。子系统粒子的 `R` 和各模块的 `uA` 也从同一流抽，所以逐粒子回放必须复刻整个帧内的抽取顺序（第 8 节）。
- **绘制：** `FUN_1402366f0` 先序递归：父自己的 renderer → static 子系统（条目顺序）→ 事件条目（条目顺序）的活跃实例（建立先后）。**每个实例单独绘制**、各有自己的顶点缓冲；存活数 0 只跳过自己的绘制、照常递归；折射快照位在对象上，父子共用。static 永远排在事件类前面，和 JSON 里的先后无关。
- **预热与两遍模式：** 事件实例只在模拟函数里每帧建一次，两遍模式不影响。预热期间 `sys+0x41` 清零，eventspawn / eventfollow 不建；eventdeath 只在**父系统带 rope 类 renderer** 时仍会在预热里建（死亡表因 rope 照建）。

**元数据**
- 目标 `wallpaper64.exe`，SHA-256 `40e2ce021e9352324fadb3b8f72b8ba2a7ee95b71cc571d5b9f84be75cd993b0`，开工核对一致。只分析 scratchpad 副本，未运行 WPE，没动 Steam 目录。
- 方法：`ignore/p4/rea/wp.asm` 按地址切片读汇编为主；REA（Ghidra 12.1.4，从 `p4b-mod` 快照的副本打开）反编译 `FUN_1401c1430`、`FUN_14022ebe0` 作对照。
- 工作文件在 `ignore/p4/rea/p4e-children/`：
  - 脚本：`pe.py`、`d.py`、`fn.py`、`jt.py`、`rd.py`、`strref.py`（借自 p4d-mod，`pe.py` 改指本会话的副本）、`s.py`（找字符串地址）、`jt3.py`（死亡索引入表的掩码跳转表）。
  - 切片：`parse_children.asm`（条目解析 `0x1401d0880`–`0x1401d1520`）、`f_ebe0.asm`（`FUN_14022ebe0`）、`f_c3c0_head.asm`（`FUN_14022c3c0` 前段）、`ctor.asm`（系统构造 `FUN_1402293a0`）、`f_08a0_head.asm`（`FUN_1402308a0` 开头）、`upd_children.asm`（子系统更新 `0x140236396`–`0x1402365f4`）、`sim_head.asm`（模拟 `FUN_140236cd0` 到发射前）、`emit.asm`（发射 `FUN_1402378a0` 全文）、`f_a580.asm`、`f_a360.asm`、`draw.asm`（`FUN_1402366f0`）、`obj.asm`（对象层 `FUN_140230650`）、`f_bd40.asm`、`f_f990.asm`、`init16.asm`。
- 标记：【确】读到代码；【推】由代码推出、没逐行确认；【未知】没读到。【确，有界】表示在注明的地址范围里搜过。

**命名**
- `sys`、`ctx`、`obj`、`def`、`cp[i]`、`current` / `previous` / `base`、`W`、`M`、`R`、`h` / `k`、`uA` 同 rea-p4c-sim、rea-p4d-modules。`sys` 偏移 = `def` 偏移 + 0x18。
- `E`：子系统条目记录（0x78 字节，第 1 节）。`L`：条目的局部矩阵 `E+0x20`。
- `child`：static 子系统；`inst`：事件实例；二者都是完整的 `sys`（0x4b0 字节，`FUN_1402293a0` 构造）。`parent = child+0x10`。
- `X`：子系统 / 实例的「对象矩阵」`sys+0x3a0`（顶层系统里这一格是 `W`）。`T(p)`：平移矩阵。
- `top`：模型栈顶 `*(ctx+0x30)`；`push` / `pop` 指压一层拷贝 / 弹一层。
- `FUN_14005ecb0(o, A, B) = A·B`，`FUN_14005f730` 求逆，`FUN_1401842d0(A, B): A = A·B`。
- 随机数取值 `uA = lo + (hi − lo)·((u32 >> 8)·2⁻²⁴)`，`lo/hi = ctx+0x20/0x24 = 0/1`，状态 `ctx+0x1cd0`（rea-p4b-modules）。

---

## 1. 解析

### 1.1 键与缺省（`FUN_1401c1430`、`0x1401d0880`–`0x1401d1455`）【确】

`children` 用 `operator[]` 取（`0x1401d0891`），只在是数组（jsoncpp 类型 6）时逐项处理。每项先调 `FUN_1401c1430` 把缺省值写回 JSON，再读进栈上的条目记录（`FUN_1401d1530` 初始化），最后 `push_back` 进 `def+0x1c8`（即 `sys+0x1e0`，`0x1401d141d`）。

| 键 | 缺省（写回 JSON） | 记录偏移 | 记录初值 | 读法 |
|---|---|---|---|---|
| `name` | 无 | `E+0x00` std::string | 空串 | `asString`（`0x1401d095e`），子系统文件名 |
| `type` | `"static"` | `E+0x60` | **0** | 见 1.2 |
| `flags` | 0 | `E+0x64` | 0 | `asInt`，见 1.3 |
| `controlpointstartindex` | 0 | `E+0x68` | 0 | `asInt`，不钳制 |
| `origin` | `"0 0 0"` | 进 `L` 的平移 | — | 1.4 |
| `angles` | `"0 0 0"` | 进 `L` 的旋转 | — | 1.4 |
| `scale` | `"1 1 1"` | 进 `L` 的缩放 | — | 1.4 |
| `probability` | 1.0 | `E+0x6c` float | 1.0 | `asFloat`，**只在非 static 时读** |
| `maxcount` | 10 | `E+0x70` u32 | 10 | `asInt`，**只在非 static 时读** |
| —（局部矩阵 `L`） | | `E+0x20..0x5f` | 单位阵 | |

- `id` 不读【确，有界：解析段只引用上表这些键】。
- 非 static 条目还做 `def+0x29 |= 1 << type`（`0x1401d13fd`–`0x1401d140b`，按字节存），即 `sys+0x41` 的「事件类型位集」：bit2 eventfollow、bit3 eventspawn、bit4 eventdeath，未知类型置 bit0（无读者）。
- 三个向量键的读法是「取字符串指针 + 跳 4 字节长度前缀」，**不查 JSON 类型**；写成数字时会把数值当指针读【推：未定义行为，语料都是字符串】。

### 1.2 `type` 编号【确】
```
if strcmp(type, "static") == 0: E.type = 1;  不读 probability、maxcount，不改 def+0x29   // 0x1401d1220 逐字节比 7 字节
elif type == "eventfollow": 2      // 0x1401d1354，ebx 此时是 2
elif type == "eventspawn":  3
elif type == "eventdeath":  4
else:                        保持初值 0
（非 static）读 probability、maxcount；def+0x29 |= 1 << E.type
```
- 运行时 `FUN_14022ebe0` 只认 1（static）与 2/3/4（事件），**类型 0 的条目既不建也不画**（`0x14022ec60`–`0x14022ec7a`）。大小写不同的写法（如 `"Static"`）落到 0。
- 缺 `type` 键时缺省值函数先写回 `"static"`，所以缺省类型是 static（sample-gaps 2.5 的推测成立）。

### 1.3 条目 `flags`【确，有界】
- JSON `flags` 原值直接存 `E+0x64`，不做位变换。
- 读取点（在 `0x140228000`–`0x140250000` 里搜 `+0x64` 的全部读，排除 initializer 记录的同偏移）只有三处：
  - bit0：`FUN_14022c3c0`（`0x14022cccb`，分配时强制 `n = 8`、写 `sys+0x3f5/0x3f6`）、`FUN_14022a580`（`0x14022a593`，每帧写控制点）。见第 5 节。
  - bit1：`FUN_14022f790`（`0x14022f7b7`），父系统周期发射进入新周期时复位这个 static 子系统。见 3.7。
- 其它位没有读者。

### 1.4 局部矩阵 `L`（`0x1401d09e1`–`0x1401d1211`）【确】

```
o = parse3(origin);  a = parse3(angles);  s = parse3(scale)        // 各自先清零，空格分隔 atof 转 float，缺的分量是 0
cz, sz = cosf(a.z), sinf(a.z);  cy, sy = …a.y;  cx, sx = …a.x       // FUN_14041a2e0 = cosf，FUN_14041a9c0 = sinf
R.c0 = (cy·cz, cy·sz, −sy)
R.c1 = ((sy·cz)·sx − cx·sz, (sy·sz)·sx + cx·cz, sx·cy)
R.c2 = (sx·sz + sy·(cx·cz), sy·(cx·sz) − sx·cz, cx·cy)
L.c0 = R.c0·s.x;  L.c1 = R.c1·s.y;  L.c2 = R.c2·s.z;  L.c3 = (o, 1)   // 逐分量 mulss
```
- 即 `L = T·Rz·Ry·Rx·S`，**弧度**，没有度换算。和对象世界矩阵（rea-p4a A1，`FUN_1401dd630`）同一套公式，但这里是解析段内联，不是同一个函数；乘法结合顺序如上（`mulss` 可交换，`sy·(cx·cz)` 与 `(cx·cz)·sy` 逐位相同）。
- 语料的 `angles "0 0 -50"` 就是 −50 弧度。
- **缺分量是 0**：`scale "2"` 得 `S = diag(2, 0, 0)`，子系统的 y、z 被压成 0；`origin "100"` 得 `(100, 0, 0)`。
- `L` 在解析期算好存进条目，运行时不再读这三个键。

### 1.5 子系统文件的加载与缓存（`FUN_14022c3c0`）【确 / 推】
- `FUN_14022c3c0(sys, name, E)`：先 `FUN_14022f990` 清空旧状态，再按 `name` 的 FNV-1a 在 `ctx+0x1aa8` 的哈希表查已解析的定义（`0x14022c4c3`–`0x14022c575`）。
  - 命中：`FUN_1401c4220` 把缓存的定义拷进 `sys+0x18`（五条流各一份）【确】。
  - 未命中：读 JSON、`FUN_1401c5490` 解析、拷进 `sys`、按名字插入缓存（`0x14022cca1`–`0x14022ccb7`）【推：中间加载段没逐行读】。
- 所以**同一文件被多个条目、多个对象引用时共享解析结果**，每个系统（每个 static 子系统、每个事件实例）各有自己的一份流（发射器计时、mapsequence 序号、碰撞状态都是每实例一份）。
- 拷完之后：`E` 非空且 `E.flags & 1` 时 `sys+0x3f6 |= 1`、`sys+0x44 = 8`、`sys+0x3f5 = (u8)E.controlpointstartindex`；否则 `sys+0x3f6 &= ~1`（`0x14022ccbf`–`0x14022ccf8`）。之后照常分配粒子列（`FUN_1401d3780`）和缓冲（`FUN_1401d2340`）、初始化控制点（rea-p4c-sim 1.3）。
- 定义缓存键只有文件名，条目上的 `flags`、`L` 都在拷贝之后作用到 `sys`，不污染缓存。

### 1.6 嵌套深度【确】
- `sys+0x3f8` 是深度字节：构造时 0（`0x1402295ec`），`FUN_14022f890` / 复用路径写 `parent.depth + 1`。
- `FUN_14022ebe0` 只在 `depth < 10` 时建子系统（`0x14022ec04`），所以顶层下面最多 10 层；第 10 层的 `children` 被忽略。自引用的文件因此不会无限递归。

---

## 2. 系统里的子系统字段【确】

| 位置 | 内容 | 写入 |
|---|---|---|
| `sys+0x10` | 父系统指针，顶层为 0 | 建 static / 事件实例时（`0x14022ef8f`、`0x14023749f`、`0x14023afc7`） |
| `sys+0x1e0..0x1e8` | 条目向量（`def+0x1c8` 的拷贝），步长 0x78 | 解析 |
| `sys+0x360..0x39f` | `L` 的拷贝 | 建立时 |
| `sys+0x3a0..0x3df` | `X`：顶层是 `W`；static 子系统是 `L`（建后不变）；事件实例由 `FUN_14022a360` 写 | |
| `sys+0x3f4` | 未结束发射器数（u8） | `FUN_14022ebe0` 置为发射器个数；结束时减一；`FUN_14022f5b0` / `FUN_14022f640` 重算 / 清零 |
| `sys+0x3f5` | 父粒子写控制点的起始下标（u8） | 1.5 |
| `sys+0x3f6` bit0 | 条目 `flags` bit0 | 1.5 |
| `sys+0x3f7` bit0 | 「父本帧不发射」：父的 `emit = 0` 时置位 | 子系统更新（`0x14023641b`、`0x1402364bc`），每帧从父拷 |
| `sys+0x3f7` bit1 | `colorn` 生效位 | `FUN_14022bd40`；子系统每帧被父的值覆盖（只用于孙辈建立时的生效判定） |
| `sys+0x3f8` | 深度 | 1.6 |
| `sys+0x408..0x418` | 本帧新粒子槽号表 | 发射时（`0x140238c0d`），用完清空 |
| `sys+0x420..0x428` | 本帧死粒子槽号表，升序 | 判死时（`jt3.py` 的跳转表，每 4 个一组升序入表） |
| `sys+0x438` | 跟随计数表：父粒子槽号 → 跟随它的 eventfollow 实例数（FNV-1a 哈希表） | 建立 +1、判死与回收 −1、清空 |
| `sys+0x478` | 实例对应的父粒子槽号，−1 表示无（构造 −1，`0x1402296f6`） | 建实例时；eventfollow 父粒子死时改 −1 |
| `sys+0x480..0x490` | static 子系统表，每项 `(E*, child*)` 16 字节 | `FUN_14022ebe0` |
| `sys+0x498..0x4a8` | 事件条目表，每项 0x38：`+0` `E*`，`+0x08..0x18` 活跃实例 `vector<sys*>`，`+0x20..0x30` 空闲实例 `vector<sys*>` | `FUN_14022ebe0` 建空表 |
| `sys+0x41` | 事件类型位集（`def+0x29`） | 解析；预热期间临时清零 |

- 跟随计数表 `sys+0x438` 只有维护者（建立、判死、回收、清空、析构），没找到影响模拟或绘制的读者【确，有界：`0x140228000`–`0x140250000`】。

---

## 3. `static`

### 3.1 建立（`FUN_14022ebe0`，`0x14022ef43`–`0x14022f201`）【确】
`FUN_14022ebe0(sys)` 是系统的（重新）初始化，加载完成（`FUN_14022feb0`）和事件实例新建时调用：
```
FUN_14022f990(sys)                         // 销毁已有子系统、清粒子
push(sys)                                   // FUN_140229760：世界 top = X，本地 top = top·X
if sys.depth < 10:
  for E in 条目（JSON 顺序）:
    if E.type == 1:
      child = new sys(ctx, obj = sys.obj)                 // 同一 obj：折射位、instanceoverride 共用
      child.L = child.X = E.L;  child.parent = sys
      push;  top = top · child.X                           // 加载期 M = 父 M · L
      FUN_14022c3c0(child, E.name, E)                      // 拷定义、分配、控制点初值
      FUN_14022cfa0(child, obj+0x940)                      // 【未知】按名字的绑定
      FUN_14022f890(sys, child, 1)                         // 深度、+0x3f7、instanceoverride 标量与颜色（3.4）
      pop
      FUN_14022ebe0(child)                                 // 递归：建孙辈、控制点、按 child 自己的 starttime 预热
      static 表追加 (E, child)
    elif E.type in (2, 3, 4):
      事件表追加 (E, 空活跃表, 空空闲表)
sys+0x3f4 = 发射器个数
FUN_14022e3e0(sys);  所有控制点 previous = current
if starttime > 0:  预热（关 sys+0x41，步长 0.05 / 0.2，只调 FUN_140236cd0）
pop
```
- **static 子系统在父系统的控制点初始化和预热之前就建好并预热完**。孙辈同理（深度优先）。
- 子系统预热时读父控制点（`flags 4`）读到的是父系统的初值（`current = base`），父的 `FUN_14022e3e0` 还没跑【确，按调用顺序】。

### 3.2 每帧更新（`FUN_1402308a0`，`0x140236380`–`0x140236445`）【确】
```
FUN_1402308a0(sys, dt', emit):
  sys+0x3f0 += dt'
  if dt' > 0: FUN_140236cd0(sys, dt', emit)       // 模拟（含事件建实例，第 4 节）
  if 存活数 > 0: 写顶点                           // 存活数 0 直接跳到子系统更新（0x140230913）
  if static 表或事件表非空:
    f = sys+0x3f7;  if !emit: f |= 1
    for (E, child) in static 表:
      FUN_14022a580(sys, E, child, 父列)           // 条目 flags bit0 时写控制点（第 5 节）
      push;  top = top · child.X                    // FUN_140229810：不看 child 的世界位
      child+0x3f7 = f
      FUN_1402308a0(child, dt', emit)               // 递归
      pop
    事件实例（4.6）
```
- 先父模拟、再父写顶点、再子系统；子系统读到的父粒子是本帧 operator 之后的。
- **`dt`：** 子系统拿父的 `dt'`（对象层已乘 `instanceoverride.rate`，rea-framework Q2），没有别的缩放；两遍模式按全局 `fps` 由子系统自己的 `FUN_140236cd0` 判定。
- **`emit`：** 子系统拿父的 `emit`（对象可见性）。`sys+0x3f7` bit0 另在发射函数开头挡住常规发射（`0x1402378c8`–`0x1402378e4`：bit0 且第三参数 ≤ 0 时直接返回；模拟里调发射总传 0），和 `emit = 0` 效果重叠。
- 父系统存活数为 0 照样更新子系统。

### 3.3 模型矩阵【确】
| 场合 | `M` |
|---|---|
| 运行时模拟 | `父栈顶 · L`（`FUN_140229810`，**本地、世界子系统都一样**） |
| 加载期（`FUN_14022c3c0` 等） | `父 M · L` |
| 自己的预热、控制点初值（`FUN_14022ebe0(child)` 里 `FUN_140229760`） | 本地：`父 M · L`；**世界：`L`** |
| `instanceoverride` 重算（`FUN_14022bd40(child)` 里 `FUN_140229760`） | 同上：世界子系统是 `L` |
| 绘制 | 本地：`父绘制栈顶 · L`；世界：单位阵 `ctx+0xaf0`（第 6 节） |

- 顶层父系统的栈顶在模拟和绘制里都是 `W`（本地父 `top·W`，世界父 `top = W`，绘制时世界父画完自己后把栈顶恢复成 `W` 再画子系统，`0x140236ae9`）。所以顶层父下面的 static 子系统，`M = W · L`，**父是世界空间也一样带 `W`**。
- 本地子系统：控制点缺省更新不乘 `M`（`current = base`），粒子存子系统本地坐标，绘制乘 `W·L`。
- 世界子系统：控制点 `current = M·base = W·L·base`，粒子存世界坐标，绘制单位阵；发射器 `origin` 不经 `M`（rea-p4c-sim 5.2）。
- **两处不一致【确，效果为推】：**
  - 世界 static 子系统的预热和 `instanceoverride` 控制点重算用 `M = L`（不含父 `W`），运行时用 `W·L`。带 `starttime` 的世界子系统，预热发出的粒子出生在 `L` 的位置（场景原点附近），不在对象下面；第一帧控制点从 `L·base` 跳到 `W·L·base`，读 previous 的模块（`inheritcontrolpointvelocity`、`maintaindistance*`）会看到一次跳变。
  - 世界 static 子系统绘制完自己后把栈顶恢复成 `X = L`，它的**本地**孙辈绘制时 `M = L·L₂`，模拟时却是 `W·L·L₂`。

### 3.4 `instanceoverride`【确】
- 建立时 `FUN_14022f890(parent, child, 1)`（`0x14022f890`）：
  - `child.depth = parent.depth + 1`；`child+0x3f7 = parent+0x3f7`。
  - 用同一个对象的 `instanceoverride`（`obj+0x778`）调 `FUN_1401d15a0(ctx+0x1a60, child 定义部分, io, 颜色信息, child)`，即对子系统应用 `count`、`speed`、`size`、`lifetime`、`alpha`、`brightness`、`colorn`。各项是否登记由子系统**自己 JSON 的 `flags`** bit3–7 决定（解析期，rea-p4a C3）。
  - **更正（P4e 步骤 1 实测，2026-11-12）：** 写回的还有解析期无条件登记的 `rate` 条目（类型 2），所以子系统 `turbulence` / `turbulentvelocityrandom` 的 `timescale` 也乘对象的 `rate`（`dt′` 另由父共享，不再乘）。实测 `p4e-rate`：对象 `rate 0.5` 下 static 子系统的 `turbulentvelocityrandom` 粒子与同参数的顶层系统逐粒子位置完全相同（`ignore/p4/e1/ana_rate.py`）。
  - `colorn` 生效 = 已设 且 与**子系统自己的系统颜色**差 ≥ 0.9/255 且 子系统无 `flags 8` 且 **父的 `+0x3f7` bit1**（父生效）。
- 运行时改值：`FUN_14022bd40(sys, p2, p3)` 递归到 static 子系统（传原 `p2`、`p3 & ~1`）和事件条目的**活跃与空闲实例**（`p2 = 0`、`p3 & ~1`，`0x14022c1d0`–`0x14022c26d`）。所以 `p2 = 1` 重开已结束发射器只对 static 子系统生效，不对事件实例。
- **控制点覆盖只在运行时改值后到达子系统：** `FUN_14022bd40(child)` 读的是同一对象的 `controlpointN` / `controlpointangleN`，写子系统 `cp[N]`（跳过 `flags & 0x10005` 的点）。但加载时 `FUN_14022af30` 先清脏标志 `obj+0x928` 再调 `FUN_14022bd40(sys, 1)`（`0x14022b85b`–`0x14022b86f`），这时 static 子系统还没建（`FUN_14022ebe0` 在之后的 `FUN_14022feb0` 里）；建立路径 `FUN_14022f890` 只应用标量与颜色，不碰控制点。所以**加载后子系统的控制点不受对象覆盖**，直到运行时有属性 setter 置脏（`LAB_14022ab30`），下一帧的递归才写进 static 子系统和当时池里的实例；之后新建的实例仍不带。
- `rate` 经共享的 `dt'` 作用到全部子孙，没有位能关掉。
- 语料里子系统的 `flags 248` = `0xF8` = bit3–7，即「这个子系统不受对象的 `colorn`/`brightness`、`speed`、`count`、`lifetime`、`size` 覆盖」，是低 8 位的既有语义，不是高位。

### 3.5 预热【确】
- 子系统**不跟父系统一起预热**：父的预热循环只调 `FUN_140236cd0`，子系统更新在 `FUN_1402308a0` 里（`FUN_140236cd0` 的调用表里没有 `FUN_1402308a0`，`sim_head.asm`）。
- 每个子系统在建立时按**自己 JSON 的 `starttime`** 和自己 `maxcount` 定的步长（< 500 用 0.05，否则 0.2）预热，早于父的预热（3.1）。
- 预热不累加系统时间 `sys+0x3f0`（`+= dt'` 只在 `FUN_1402308a0` 开头，`0x1402308c2`）。这顺带回答 rea-p4d-modules「未查完」里「预热期 `St` 是否累加」：**不累加**。

### 3.6 不可见（`FUN_140230650`，`0x14023068e`–`0x1402307b8`）【确】
只在**顶层**系统存活数 > 0 时做：
1. `obj+0x770 = 0`；`FUN_14022f6c0(sys)`：系统时间、发射器计时、mapsequence 序号复位，**递归 static 子孙**（不碰事件实例）。
2. 清顶层粒子（`sys+0x340/0x344/0x350` 归零、寿命列清零、rope 表清空）。
3. 每个 static 子系统调 `FUN_14022fd90`：清粒子，递归 static 子孙，**销毁**各事件条目的活跃实例（析构 + 释放），清跟随计数表。
4. 销毁顶层自己的活跃事件实例；清顶层跟随计数表。空闲池不动。

之后照常每帧模拟，`emit = 0`，子系统不发射。重新可见时不预热。
- 顶层存活数为 0 时整段不做：子系统或事件实例里还活着的粒子保留，继续模拟到自然死亡【确】。
- `FUN_14022f6c0` 不清发射器结束位：已结束的 static 子系统重新可见后仍不发射（同顶层，rea-p4b-modules A2）。

### 3.7 周期复位（条目 `flags` bit1，`FUN_14022f790`）【确】
父系统某个周期发射器（发射器 `flags` bit2）进入新周期时，对 **static 表**里 `E.flags & 2` 的每个子系统：
```
FUN_14022f6c0(child)                       // 系统时间 0、发射器计时复位、mapsequence 归零，递归 static 子孙
child+0x3f4 = 0;  每个发射器清结束位、+0x3f4 加一
static 孙辈 FUN_14022f5b0                   // 同样重开
```
- 不清子系统的粒子。父有几个周期发射器，每个的新周期各触发一次。事件实例不受影响。

---

## 4. 事件子系统

### 4.1 实例池【确】
- 每个事件条目一个池：活跃表（`+0x08`）和空闲表（`+0x20`）。
- **条目 `maxcount` 是活跃实例数的上限**，和子系统 JSON 的 `maxcount`（每实例的粒子容量）无关。
- **满了丢弃新事件**，不复用最老的、不挤占。
- 实例在子系统更新里步进后判定（4.6）；不活跃就移进空闲表并从活跃表删除（`erase`，其余保序）。
- 新事件优先从空闲表**尾部**取（后进先出），空闲表空才 `new`。
- 池只增不减；对象不可见时活跃实例被销毁（3.6），空闲表保留。

### 4.2 eventdeath（模拟函数判死后，`0x140237129`–`0x1402376f6`）【确】
`sys+0x41 & 0x14`（有 eventfollow 或 eventdeath）或系统有 rope 表（`sys+0x208`）时，判死循环把死粒子槽号升序记进 `sys+0x420`。之后：
```
sys+0x350 += 死亡数
cap = Σ_{eventdeath 条目} (E.maxcount − 活跃数)                 // 本帧开头算一次
for d in 死亡表（升序）:
    跟随计数表[d] 减一，到 0 删除
    for eventfollow 条目, for 活跃实例 inst（表序）:
        if inst+0x478 == d:  停跟随（4.5）
    if cap == 0: continue
    for E in 事件表（条目顺序）, E.type == 4:
        if uA > E.probability: continue                        // 0x14023740d：抽一次 uA
        inst = 取空闲或新建（4.7），inst+0x478 = d，X 用死粒子的位置
        活跃表追加 inst;  cap −= 1
        if 活跃数 == E.maxcount: break                          // 跳到下一个死粒子
```
- 位置：判死在模拟最开头、operator 之前，所以是死粒子**上一帧末**的位置。
- 抽随机数：每个死粒子、每个 eventdeath 条目各抽一次（`cap > 0` 时），在该条目建实例之前；`probability ≥ 1` 也抽。
- 嵌套是「死粒子在外、条目在内」，和 4.3 相反。
- **多个 eventdeath 条目时上限会失守【确，效果为推】：** `cap` 是所有条目剩余量之和，循环里不再逐条检查「已满」；某条目满了而别的条目没满时，满的条目照样建新实例（之后 `活跃数 == maxcount` 的相等判断也不再成立），`cap` 还会减到负数而继续非零。单条目时上限严格成立。

### 4.3 eventspawn、eventfollow（发射函数尾部，`0x14023ae9a`–`0x14023b28c`）【确】
- 发射开头 `dil = sys+0x41 & 0xc`；非零时每个新粒子在 initializer、拖尾初值、存活数加一之后把槽号追加进 `sys+0x408`（`0x140238bf8`）。
- 全部发射器发完之后：
```
for E in 事件表（条目顺序）, E.type in (2, 3):
    if 活跃数 == E.maxcount: continue                            // 满了：本帧不抽、不建
    for b in 新粒子表（出生先后）:
        if uA > E.probability: continue                           // 0x14023af23
        inst = 取空闲或新建（4.7），inst+0x478 = b，X 用新粒子当前位置
        活跃表追加 inst
        if E.type == 2: 跟随计数表[b] += 1
        if 活跃数 == E.maxcount: break
清空新粒子表
```
- 位置：新粒子过完 initializer、**本帧 operator 之前**的位置（发射在 operator 前，rea-framework Q3）。
- 嵌套是「条目在外、新粒子在内」：第一个条目先把本帧全部新粒子抽完，再轮到下一个条目。
- 两个都只在新粒子出生时触发；已有粒子不会补建（比如之前因池满被丢的）。

### 4.4 `probability`【确】
- 抽取与 `FUN_1401f4bc0(ctx)` 逐指令相同（内联：`FUN_14007f5b0(ctx+0x1cd0)` 取 MT19937，`>> 8`，乘 `2⁻²⁴`，乘区间宽再加下界），就是**流 A 的 `uA`**，和父系统、子系统、场景里其它粒子系统共用同一状态。
- 比较 `comiss uA, probability; ja 跳过`：`uA ≤ probability` 才建。`probability 1` 必建；`0` 只在 `uA` 恰为 0 时建（每次 2⁻²⁴）；`0.5` 是 `uA ≤ 0.5`。
- static 条目不抽、不读 `probability`。

### 4.5 实例的对象矩阵 `X`（`FUN_14022a360(parent, b, inst)`）【确】
`p` = 父粒子 `b` 的位置列（`+0x2b0/0x2b8/0x2c0`）当时的值，`top` = 调用时的模型栈顶（父系统的模拟栈顶，顶层父即 `W`）：

| 子系统 | 父系统 | `X` | 模拟 / 绘制时的 `M` |
|---|---|---|---|
| 本地 | 本地 | `T(p)·L` | `top·X = W·T(p)·L` |
| 本地 | 世界 | `top⁻¹·T(p)·L` | `top·X = T(p)·L`（`p` 是世界坐标） |
| 世界 | 本地 | `top·T(p)·L` | `X = W·T(p)·L` |
| 世界 | 世界 | `T(p)·L` | `X = T(p)·L` |

- 实例模拟时压栈用 `FUN_140229760(inst)`（本地 `top·X`、世界 `X`），绘制同理（第 6 节），两边一致。
- 结果：实例原点在父粒子的世界位置。**父是本地系统时**，实例还带对象 `W` 的旋转缩放（`L` 被 `W` 转）；**父是世界系统时**不带。
- eventspawn、eventdeath：只在建立（或复用）时算一次。eventfollow：此后每帧再算（4.6）。

### 4.6 每帧更新与跟随（`0x140236447`–`0x1402365c0`）【确】
在 static 子系统之后：
```
for E in 事件表（条目顺序）:
  for inst in E.活跃表（表序，含本帧刚建的）:
    FUN_14022a580(sys, E, inst, 父列)                  // 条目 flags bit0（第 5 节）
    inst+0x3f7 = f（3.2）
    if E.type == 2 且 inst+0x478 != −1:
        FUN_14022a360(sys, inst+0x478, inst)            // 用父粒子本帧 operator 之后的位置重算 X
    push(inst);  FUN_1402308a0(inst, dt', emit);  pop
    if !FUN_14022c310(inst):                            // 不活跃
        if E.type == 2 且 inst+0x478 != −1: 跟随计数表[inst+0x478] 减一
        移进空闲表，从活跃表删除
```
- **本帧新建的实例当帧就步进一次完整的 `dt'`**：它先在建立时初始化（新建）或复位（复用）、按 `starttime` 预热，再在这里走正常一帧，首批粒子出生当帧 `age = 0`。
- eventfollow 建立当帧：预热用出生位置（operator 前），这一步用 operator 之后的位置。
- **本地 eventfollow 实例的已有粒子跟着父粒子一起平移**（粒子存实例本地坐标，绘制乘随父粒子变化的 `X`）；世界实例的已有粒子留在世界里，只是新粒子从父粒子处发出。
- 活跃判定 `FUN_14022c310(sys)` 为真的条件（任一）：任一 static 子系统活跃、任一事件子实例活跃、`sys+0x3f4 > 0`（还有没结束的发射器）、存活数 > 0。
  - 只有连续 `rate`、没有 `duration` 的发射器永远不结束：这样的 eventspawn / eventdeath 实例永不回收，池满后该条目不再有事件。周期发射器同样不结束。

**父粒子死亡时的 eventfollow（4.2 循环里，`0x140237320`–`0x1402373bb`）：**
```
inst+0x478 = −1                     // 停跟随，X 冻结在最后一次的值
inst+0x3f4 = 0;  inst 的每个发射器 flags |= 0x80000000      // 全部标结束
inst 的 static 子孙：FUN_14022f640（同样全部标结束，递归）
```
- 发生在父系统模拟开头，所以**父粒子死亡那一帧实例就不再发射**；已有粒子照常活到寿命，本地实例的粒子停在最后的位置。粒子全死后在子系统更新里被回收。
- 实例自己的事件子实例不被停掉。
- 跟随计数表在死亡时只减一次（即使有多个 eventfollow 条目跟着同一粒子），没有读者，不影响行为。

### 4.7 新建与复用【确】
| 步骤 | 新建（`0x14023744f` / `0x14023af69`） | 复用（`0x140237524` / `0x14023b04b`） |
|---|---|---|
| 构造 | `new sys(ctx, obj)`，`L` 拷进 `+0x360`，`parent`、`+0x478` | 从空闲表尾部取，写 `+0x478` |
| 定义 | `FUN_14022c3c0(inst, E.name, E)`：拷定义、分配、控制点初值、`flags` bit0 | 不重新拷：流里的模块状态由下面复位 |
| `X` | `FUN_14022a360` | `FUN_14022a360` |
| 复位 | — | `FUN_14022f6c0`：系统时间 0、发射器计时（`duration`、`delay`、`pending` 回初值，累积余数、连发、周期计时清零）、mapsequence 序号 0，递归 static 子孙 |
| 深度、`+0x3f7` | `FUN_14022f890`（含 `instanceoverride`） | 直接写 `parent.depth + 1`、`parent+0x3f7`；**不重新应用 `instanceoverride`**（池里的实例在 `FUN_14022bd40` 递归里照样被更新） |
| 发射器 | 新拷的流 | 清全部结束位，`+0x3f4` = 发射器数；static 子孙同样重开 |
| 初始化 | `FUN_14022ebe0(inst)`：建孙辈、`FUN_14022e3e0`、`previous = current`、预热 | 只在 `starttime > 0` 时压栈 + `FUN_14022f430` 预热 |
| 预热 | 实例自己的 `starttime`、自己的步长，期间 `inst+0x41 = 0` | 同左 |

- **都从头开始：** 发射器计时、系统时间、mapsequence 序号都是初值。
- **复用不做的事：** 不重新初始化控制点，`previous` 是上次使用结束时的值（世界实例第一帧 `Δcp` 会是两次位置之差）；不清高水位 `sys+0x340`、死亡计数 `sys+0x350`（存活数本来就是 0）。
- 预热发生在父系统的模拟里（判死或发射之后），会消耗流 A。
- **预热读到的场景时间**是这一帧的 `g_Time`（不是 0）。P4e 收尾 A 实测（`p4e-close` fps 20：子系统粒子全在实例预热里出生、出生方向只由 `T` 决定，按本帧 `T` 回放位置差 3.05e-5，`T` 取 0 差 9.51 像素）；读码没写，实现原按推断。图层时间同样按这一帧的值实现，仍是推断（测试工程不读它）。

### 4.8 两遍模式与预热【确】
- 事件只在 `FUN_140236cd0` 每帧建一次（判死在两遍 operator 之前，发射每帧一次），两遍模式不会重复触发。实例自己的模拟照全局 `fps` 决定遍数。
- 预热（`FUN_14022ebe0` 尾部、`FUN_14022f430`）期间 `sys+0x41 = 0`：
  - 发射不记新粒子表，**eventspawn / eventfollow 不建**。
  - 判死表只在 `sys+0x41 & 0x14` 或有 rope 表时建；**父系统带 rope 类 renderer 时，预热里的死亡照样建 eventdeath 实例**（建实例循环只看死亡表和 `cap`，不看 `sys+0x41`）。没有 rope 时不建。
- 预热期间不步进任何子系统（3.5），新建的实例要到预热结束后的第一个正常帧才进子系统更新。

---

## 5. 父粒子写子系统控制点（条目 `flags` bit0，`FUN_14022a580`）【确】

static 子系统和事件实例在子系统更新里每帧各调一次，压子系统矩阵之前（栈顶是父的模拟 `M`）：
```
if !(E.flags & 1): return
childW = child.flags & 1;  parW = parent.flags & 1
X = parW ? (childW ? I : inverse(top)) : (childW ? top : I)
j = E.controlpointstartindex                                  // 有符号 int
for i in 0 .. parent 高水位 − 1:
    if j ≥ 8: break
    if parent.life[i] == 0: continue                          // 空槽不占控制点
    if child.cp[j].flags & 0x10005: continue                  // 指针 / 父控制点 / remap 点：这个粒子被跳过，j 不变
    p = parent.pos[i]
    child.cp[j].current.t = ((X00·px + X10·py) + (X20·pz + X30),
                             (X01·px + X11·py) + (X21·pz + X31),
                             (X02·px + X12·py) + (X22·pz + X32))
    j += 1
```
- 写的是**父系统全部存活粒子按槽号的前几个**（不是触发事件的那个粒子），只写 `current` 的平移，3×3 与 `previous` 不动（`previous` 帧尾照常从 `current` 拷）。
- 坐标空间：子系统本地时是「父的本地空间」（父世界时乘 `top⁻¹`），子系统世界时是世界坐标。**不补偿 `L`**，事件实例也不补偿 `T(p)`：`L` 非单位阵时，本地子系统里这些点与父粒子的实际位置差一个 `L`（事件实例差 `T(p)·L`）。
- 子系统自己的 `FUN_14022e3e0` 对 `i ≥ sys+0x3f5` 且 `sys+0x3f6 & 1` 的点不做缺省更新（rea-p4c-sim 1.5），所以写入值保留；父粒子不够时多出的点保留上次的值（初始是 `base`）。
- `n = 8` 由 `FUN_14022c3c0` 强制，所以写 `cp[0..7]` 不越界。`controlpointstartindex` 为负时循环从负下标写，越界【推】；≥ 8 时什么都不写。
- 预热期间不调（只在子系统更新里），子系统预热时这些点是 `base`。
- bit0 为 0 时 `controlpointstartindex` 完全不起作用。

---

## 6. 绘制（`FUN_1402366f0`）【确】

```
FUN_140236600(obj):                        // 对象绘制
  obj+0x93d &= ~1;  sys+0x3a0 = W（重取）
  push;  if !世界: top = top · W
  FUN_1402366f0(sys);  pop

FUN_1402366f0(sys):
  if sys+0x358（基础材质）== 0: return     // 整棵子树都不画
  if 世界: top = ctx+0xaf0（就地覆盖）
  if 存活数 > 0:
      透视覆盖、折射快照（obj+0x93d 防重）、g_RenderVar1、逐 renderer 画
  if 世界: top = sys+0x3a0                  // 恢复成 X
  for (E, child) in static 表:               // 条目顺序
      push;  if !child 世界: top = top · child.X
      FUN_1402366f0(child);  pop
  for E in 事件表:                           // 条目顺序
      for inst in E.活跃表:                   // 建立先后
          push;  if !inst 世界: top = top · inst.X
          FUN_1402366f0(inst);  pop
```
- **递归顺序：** 先序，父自己的全部 renderer → static 子系统 → 事件实例。static 一律在事件类前面，和 JSON 里的先后无关；同类之间按 JSON 顺序。
- **每个实例一次绘制**（每个 renderer 一次），不合并；每个系统有自己的顶点 / 索引缓冲（`FUN_1401d2340` 在每次 `FUN_14022c3c0` 里建）。
- **模型矩阵：** 本地子系统 `父绘制栈顶 · X`（static `X = L`，事件实例见 4.5），世界子系统 `ctx+0xaf0`（平时单位阵）。与模拟一致，例外见 3.3。
- **折射快照：** 子系统构造时传入父的 `obj`（`FUN_1402293a0(…, ctx, sys[1])`），共用 `obj+0x93d`，一次对象绘制最多拷一次，由先序里第一个需要的系统触发（rea-p4b-render 6.1 不变）。
- **存活数为 0：** 只跳过自己的绘制，照常递归子系统和实例。基础材质为空则整棵子树不画。

---

## 7. 其它

### 7.1 子系统的控制点【确】
- 子系统（static、事件实例）在自己的 `FUN_140236cd0` 里照常 `FUN_14022e3e0`，`M` 是子系统的栈顶（3.3、4.5）。本地子系统缺省更新 `current = base`（子系统本地），世界子系统 `current = M·base`。
- 指针分支、`flags 2` 都按子系统自己的 `M` 与世界位（rea-p4c-sim 1.5、1.6）。
- **父分支（`flags 4`、`flags 8`、`parentcontrolpoint`）对 static 和事件实例都适用：** 二者的 `sys+0x10` 都是父系统；`Mprev = *(ctx+0x30) − 0x40` 是父的 `M`（模拟、预热、复用预热时栈上都是父 `M` 在下一层）。公式见 rea-p4c-sim 1.8，例如本地子 + 本地父：`current = inverse(M)·(Mprev·pcp) = L⁻¹·pcp`（static）。读到的是父系统本帧已更新的控制点（子系统在父模拟之后）；但 static 子系统建立时的预热读到的是父的初值（3.1）。
- 条目 `flags` bit0 写入的点见第 5 节，优先级：`0x10000` > 指针 > 父分支 > 「`i ≥ 0x3f5` 跳过」> 缺省。

### 7.2 `inheritinitialvaluefromevent`（initializer 16）依赖 `+0x478`【确】
执行段 `0x14023f445`：`inst+0x478 != −1`、父存在、`+0x478 <` 父高水位时，从父粒子 `+0x478` 读颜色等列（14 个分支，没逐个读）。所以 eventspawn、eventdeath 实例能读到触发粒子（eventdeath 读到的是死粒子留在列里的值）；eventfollow 父粒子死后（`−1`）、static 子系统（构造 `−1`）读不到。operator 20 `inheritvaluefromevent` 应同理【推】。语料的子系统没用到这两个模块（0b 扫描没带出新键）。

### 7.3 帧内总顺序与流 A 的消耗顺序（一个粒子对象）【确】
```
FUN_140230650(obj):
  [不可见且顶层存活 > 0：清空（3.6）]
  [脏：FUN_14022bd40 递归，含实例池]
  push W;  FUN_1402308a0(sys, dt', emit):
    a. 系统时间 += dt'
    b. 模拟 sys：
       判死 → 死亡表（升序）
       → 逐死粒子：eventfollow 停跟随；eventdeath 逐条目抽 uA、建 / 复用实例（新建：初始化 + 预热，消耗 uA）
       → 控制点
       → 发射：各发射器按流顺序（周期计时、每个新粒子的 R、initializer 的 uA …）
       → eventspawn / eventfollow：逐条目、逐新粒子抽 uA，建 / 复用实例（预热消耗 uA）
       → operator 一或两遍 → previous = current
    c. 写顶点
    d. static 子系统（条目顺序），各自递归 a–d
    e. 事件条目（条目顺序）的活跃实例（建立先后），各自递归 a–d，步进后判回收
  pop
```
- 一个场景所有粒子系统共用一个 MT19937；子系统、实例没有独立的流。同一对象内的消耗顺序就是上面的先序。
- 对回放的影响：
  - 有事件子系统时，父系统每个新粒子（或死粒子）都会多抽一次 `uA`，**即使 `probability 1`**；池满后不再抽。所以父系统自身后续帧的随机数也取决于池的状态。
  - 实例预热在父的模拟里、发射之后插入抽取。
  - 逐粒子对上 WPE 需要：同一帧内先父（判死事件 → 发射 → 出生事件）、后子（static → 实例）的完整先序，以及池的满 / 空状态。

---

## 未查完 / 未解决

- **`FUN_14022cfa0(sys, obj+0x940)`**【未知】：每个子系统建立时都调，按名字（FNV-1a）在 `sys+0x1c8` 与对象的 `obj+0x940` 之间做查找、写入。`obj+0x940` 在对象加载 `0x14022b25a` 一带由 `particle` 键附近的代码填充，用途没追。
- **定义缓存未命中路径**【推】：`FUN_14022c3c0` 中间的读文件、解析、插入没逐行读；命中路径与插入点读到了。
- **`name` 缺失或文件加载失败**【未知】：没读失败分支。基础材质为空时整棵子树不画（第 6 节）是确定的。
- **多个 eventdeath 条目的上限失守**（4.2）：代码确定，实际会不会出现超额实例需要实测；语料里同一系统有两个 eventdeath 条目的情况没统计。
- **世界 static 子系统的两处不一致**（3.3）：代码路径确定，画面效果【推】。语料里子系统 `flags 1`、`3` 都有，是否同时带 `starttime` 或本地孙辈没查。
- **`controlpointstartindex` 为负**：按代码会写负下标【推】，没实测、语料没有。
- **非字符串的 `origin` / `angles` / `scale`**：按代码会把数值当指针读【推】。
- **`sys+0x3f7` bit0 的另一条路径**：发射函数第三参数 > 0 时（推测是脚本 `emitParticles`，P4f）不受 bit0 挡，没追调用者。
- **MT19937 的播种**：不在本节范围，流 A 是否每次加载同种子决定了跨次运行能否逐粒子复现，见 rea-p4b-modules。
- `FUN_14024c680`（复位并清空，调用者未知，rea-p4d-modules）对子系统是否递归没看。

---

## 建议的确定性实验

通用设置：正交 1920×1080 铺满窗口，粒子对象 `origin "960 540 0"`、无旋转缩放；`movement` 无重力、`drag 0`；发射用 `sphererandom` `distancemin = distancemax = 0`（或 100 + `directions "1 0 0"`、`sign "1 0 0"`，出生点确定为「中心 + (100, 0)」），速度用 `velocityrandom min = max`。子系统粒子用和父不同的颜色或尺寸，便于在抓帧里按绘制分开。fps 60，标 fps 10 的另抓一份。下文坐标是场景坐标。

### `p4e-static`

| 名 | 设置 | 预测（能逐帧 / 逐粒子判定） |
|---|---|---|
| `st-L` | static 子系统发射在「中心 + (100, 0)」；条目 `origin "200 0 0"` | 子粒子出生 (1260, 540) |
| `st-ang` | 条目 `angles "0 0 1.5708"` | 子粒子出生 (960, 640)：弧度、Rz。按度换算会在 (1060, 541.7) |
| `st-scale` | 子系统出生点改成「中心 + (100, 100)」；条目 `scale "2 2 1"`、`scale "2"` 各一份 | 前者出生 (1160, 740)；后者 y 缩放为 0，出生 (1160, 540)。缺分量若按 1 补会是 (1160, 640) |
| `st-type` | 条目 `type "Static"`（大写）；另一份不写 `type` | 前者子系统完全不出现；后者等同 static |
| `st-world` | 子系统 `flags 1`，对象脚本匀速平移；对照组本地 | 世界组已发粒子留在原地，本地组跟着对象走；两组出生点相同（`W·L·cp`） |
| `st-world-warm` | 子系统 `flags 1`、`starttime 1`，条目 `origin "200 0 0"`，对象在 (960, 540) | 第一帧已有一批粒子在 (300, 0) 附近（预热用 `M = L`），之后新粒子在 (1260, 540)。若预热也用 `W·L`，第一帧的粒子都在 (1260, 540) 附近 |
| `st-dt` | `instanceoverride.rate 2` | 父子都按 2 倍时间走（子粒子位移 = 父的两倍速率规律） |
| `st-io` | `instanceoverride.count 2`；子系统 `flags 248` 的副本 | 前者子系统发射数 ×2；后者子系统不变、父 ×2 |
| `st-io-cp` | 子系统控制点 1 `offset "100 0 0"`、发射 `controlpoint 1`；对象 `instanceoverride.controlpoint1 "0 200 0"`；脚本 3 s 时把这个覆盖改写成同值 | 0–3 s 子系统出生在 (1060, 540)（加载时覆盖不到子系统）；3 s 后出生在 (960, 740) |
| `st-warm` | 父 `starttime 2`、子 `starttime 0`；另一份反过来 | 前者第一帧子系统没有粒子（不跟父预热），后者第一帧子系统已有 2 s 的粒子、父没有 |
| `st-period` | 父发射器 `flags 4`（周期 `minduration = maxduration = 1`、间歇 1）；子系统发射器 `duration 0.3`；条目 `flags 2` 与 `flags 0` 各一份 | `flags 2`：每 2 s 子系统重发 0.3 s；`flags 0`：只在开头发 0.3 s |
| `st-hide` | 脚本 3 s 隐藏、4 s 显示 | 隐藏帧父子粒子全清；4 s 后子系统重新发射，不预热；子系统 `duration` 发射器若已结束则不再发 |
| `st-parent0` | 父 `rate 0`（无粒子），子系统持续发射 | 子系统照常模拟、绘制 |
| `st-depth` | 一个文件 `children` 引用自己（static） | 共 11 层（顶层 + 10 层子系统），绘制数 11 |

### `p4e-follow`

| 名 | 设置 | 预测 |
|---|---|---|
| `ef-local` | 父 `rate 1`、寿命 2、速度 (100, 0)；子系统 eventfollow，`rate 10`、速度 0、寿命 1、出生距离 0，本地 | 子粒子全部叠在父粒子上随它移动（本地实例整体平移） |
| `ef-world` | 同上，子系统 `flags 1` | 子粒子在父粒子身后留下一条 1 s 长的拖尾（世界坐标不动） |
| `ef-first` | 同 `ef-world`，看父粒子出生帧 | 子系统第一个粒子在父粒子 operator 之后的位置（出生点 + v·dt），`age = 0` |
| `ef-death` | `ef-world`，看父粒子死亡帧 | 父粒子判死那一帧子系统停止发射；已有子粒子各活满 1 s；本地组的子粒子停在父粒子最后位置 |
| `ef-max` | 条目 `maxcount 2`，父 `rate 5`、寿命 1，子系统持续发射、寿命 0.2 | 只有当前跟随数 < 2 时出生的父粒子带子系统；被跳过的父粒子之后也不补；实例在父粒子死后约 0.2 s 回收，下一个新粒子才能被跟随 |
| `ef-prob` | `probability 0` | 没有子系统（每次 2⁻²⁴ 的例外忽略） |
| `ef-draw-rng` | 父 `rate 1`、`colorrandom`（或 `sizerandom`）；三份：无子系统、eventfollow `probability 0`、eventfollow `maxcount 0` | `probability 0` 那份：第一个父粒子颜色与无子系统相同，第二个起不同（概率 0 也抽 `uA`，又没有实例消耗别的随机数）；`maxcount 0` 那份与无子系统逐位相同（池满不抽） |
| `ef-cpstart` | `controlpointstartindex 1`、条目 `flags 0` | 与 `controlpointstartindex 0` 逐位相同 |
| `ef-rot` | 对象 `angles "0 0 1.5708"`，条目 `origin "50 0 0"`；父本地 / 父世界（`flags 1`）各一份 | 父本地：子系统原点在父粒子 + 旋转后的 (0, 50)；父世界：在父粒子 + (50, 0) |
| `ef-start` | 子系统 `starttime 0.5` | 每个实例一出现就带 0.5 s 的粒子，分布在父粒子出生点（operator 前）附近 |
| `ef-fps10` | `ef-world` 抓 fps 10 | 每帧仍只建一次实例；子粒子运动按两遍模式（rea-framework Q1） |

### `p4e-event`

| 名 | 设置 | 预测 |
|---|---|---|
| `es-pos` | 父 `rate 1`、速度 (100, 0)；eventspawn 子系统 `instantaneous 5`、`rate 0`、速度 (0, 50)、寿命 1 | 子粒子从父粒子**出生点**（operator 之前）出发，不随父粒子移动 |
| `es-max` | eventspawn 子系统持续 `rate 10`（永不结束），条目 `maxcount 3` | 只有前 3 个父粒子触发；之后再也不触发 |
| `es-recycle` | `es-pos` 加子系统 `mapsequencearoundcontrolpoint count 7` | 第 3 批起复用第 1 个实例（第 2 批时第 1 个实例的粒子还没死）；复用实例序号从 0 开始，每批 5 个粒子的角度都相同。不复位时复用批会从序号 5/7 接着排 |
| `ed-pos` | 父寿命 1、速度 (100, 0)；eventdeath 子系统 `instantaneous 5` | 判死帧子粒子出现在父粒子最后一次被 operator 移动后的位置（判死帧父粒子不再前进） |
| `ed-max2` | 两个 eventdeath 条目各 `maxcount 1`，子系统持续发射（永不结束），父 `rate 5` | 读码预测第一个条目的实例数超过 1（上限失守）；单条目对照组严格 ≤ 1 |
| `ed-rope-warm` | 父带 `rope` renderer、`starttime 2`、寿命 0.5；eventdeath 子系统 | 第一帧已有预热期间建的实例；把 renderer 换成 `sprite` 后第一帧没有实例 |
| `ed-order` | 两个父粒子同帧死亡（`instantaneous 2`，出生点不同），两个 eventdeath 条目，子系统颜色不同 | 绘制顺序按条目、条目内按建立先后：条目 1 的 A、B，条目 2 的 A、B。抽 `uA` 的顺序是 A-1、A-2、B-1、B-2（死粒子在外），只能在逐流回放里核对 |

### `p4e-draw`

| 名 | 设置 | 预测 |
|---|---|---|
| `dr-order` | `children` 依次为 eventfollow（蓝）、static（绿），父红；三者重叠、`translucent` | 绘制顺序：父 → static → eventfollow 各实例（按建立先后），每实例一个 draw |
| `dr-refract` | 父不折射、子系统折射；父子都折射 | 前者快照在子系统绘制前一次（含父粒子）；后者只在父之前一次 |
| `dr-zero` | 父的粒子全死、static 子系统仍有粒子 | 父没有 draw，子系统照常画 |
| `dr-world` | 世界父（`flags 1`）+ 本地 static 子系统，对象 `scale 2` | 子系统粒子按 `W·L` 画（随对象缩放），与本地父时相同 |

### 最想用实测核对的读码结论
1. 条目 `maxcount` 是实例上限、满了丢弃，实例在发射器结束且粒子全死后回收（`ef-max`、`es-max`）。
2. 本地 eventfollow 实例的已有粒子跟着父粒子走，世界实例不跟（`ef-local`、`ef-world`）。
3. eventspawn 用 operator 之前的位置，eventdeath 用上一帧末的位置（`es-pos`、`ed-pos`）。
4. 每个新粒子都多抽一次 `uA`，与 `probability` 无关（`ef-draw-rng`），这决定回放能否逐粒子对上。
5. 条目 `angles` 是弧度、`scale` 缺分量补 0（`st-ang`、`st-scale`）。
6. static 子系统不跟父预热，按自己的 `starttime`（`st-warm`）。
7. 绘制按「父 → static → 事件实例」，每实例一次（`dr-order`）。
8. 父粒子死亡那一帧 eventfollow 停发射（`ef-death`）。
9. 对象的控制点覆盖加载后不到子系统，运行时改值后才到（`st-io-cp`）。
