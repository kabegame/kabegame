> 逆向原始记录，代理写的，地址按 llvm-objdump / Ghidra（基址 `0x140000000`）。**除报告「P4b 语义的实测核对」已测的两项（控制点 0 `flags 1` 跟随指针、`offset "100 50 0"` 平移）外，全部没有实测。** P4c 步骤 0b 实测核对后，结论以报告为准。

# WPE 2.8.42 P4c 控制点、指针、`controlpointattract`、世界空间静态逆向

**概括**
- **控制点：** 每个控制点 0xd0 字节，存 current、previous、base 三个 4×4 矩阵。初值是单位阵加 `offset`，**不含 `angles`**。JSON 控制点的 `angles` 解析了但运行时不读；`locktopointer` 这个字符串在二进制里根本不存在。
- **`flags`：** bit0 指针；bit1「base 是场景坐标」；bit2 父控制点；bit3 父控制点不做坐标换算；bit4 没有任何读取点。顶层系统的父指针是空的，bit2 只剩一个副作用（`instanceoverride` 的控制点被忽略），bit2、bit3、`parentcontrolpoint` 归 P4e。
- **指针：** `ctx+0x8c/0x90` 是光标在客户区的像素坐标除以渲染目标宽高，左上为原点、y 向下、不钳制。控制点用 `inverse(P·V)` 把它反投影到 NDC z = 0，丢掉 z，再按需乘 `inverse(M)`。指针分支丢弃 `offset`，也不应用 `instanceoverride`。
- **`instanceoverride`：** `controlpointN` 替换 base 的平移（不加到 `offset` 上），`controlpointangleN` 替换 base 的 3×3（Z·Y·X，弧度）。坐标空间和 `offset` 相同。指针、父控制点、remap 输出的点上不生效。
- **读控制点的模块：** 全部读 current；只有 `inheritcontrolpointvelocity`、`maintaindistance*` 还读 previous。发射器的 3×3 只在「世界空间或 `controlpoint ≠ 0`」时作用到出生点，但传给 initializer 的 `M` 总是 `mat3(current)`。
- **`controlpointattract`：** 字段是 `offset`、`scale`、`threshold`、`deletethreshold`、`flags`、`controlpoint`，**没有 `origin`**，`offset` 解析了但执行时不读。**`flags` 缺省是 2**（钳制开）。速度沿 `p − C` 减去 `(1 − L·rcpps(threshold))·scale·k`，乘的是 `k`。`flags` bit0 是「路径扫过控制点附近就删除」，这是「上一步位置」列的唯一用途。
- **世界空间：** 模拟时控制点乘对象世界矩阵 `W`（`current = W·base`），粒子存世界坐标；绘制时模型矩阵换成 `ctx+0xaf0`，平时是单位阵。发射器 `origin` 在世界空间下**不经 `W` 变换**。

**元数据**
- 目标 `wallpaper64.exe`，SHA-256 `40e2ce021e9352324fadb3b8f72b8ba2a7ee95b71cc571d5b9f84be75cd993b0`，开工核对前缀 `40e2ce021e935232` 一致。只分析 scratchpad 副本，未运行 WPE，没动 Steam 目录。
- 方法：REA（Ghidra 12.1.4，从 `p4b-mod` 快照的副本打开）反编译，`ignore/p4/rea/wp.asm` 读汇编。复制来的快照用完已删，没有另存（没做标注）。
- 工作文件在 `ignore/p4/rea/p4c-sim/`：`cpparse.asm`（控制点数组解析）、`cpa_parse.asm` / `cpa.asm` / `cpa_blend.asm`（`controlpointattract`）、`f_14022a150.c`（删除判定）、`opjt.txt`（operator 跳转表）、脚本 `findi.py`、`imp.py`、`jtfind.py`、`pair.py`、`scanpair.py`、`f4.py`、`dump.py`。
- 标记：【确】读到代码；【推】由代码推出、没逐行确认；【未知】没读到。【确，有界】表示在注明的地址范围里搜过，范围外没排除。

**命名**
- `sys`：粒子系统（`obj+0x2c0`）。`obj`：粒子对象。`ctx`：`R+0x10`，`*sys` 就是 `ctx`。`R`：渲染器。
- `cp[i]`：`sys+0x400` 指向的控制点数组第 i 项，`i < sys+0x44`。
- `current` / `previous` / `base`：控制点里的三个 4×4，见 1.1。`t` 指矩阵第 3 列（平移），`3×3` 指前三列的 xyz。
- `W`：对象世界矩阵，`obj` 虚函数 `+0x80`（`FUN_1401850a0`，含父链，rea-p4a A1），每帧抄到 `sys+0x3a0`。
- `M`：模拟期间的模型矩阵栈顶 `*(ctx+0x30)`。`P`、`V`：投影、视图栈顶 `*(ctx+0x40)`、`*(ctx+0x38)`。
- `h`、`k`、`uA`、`uB`、`R`：同 rea-p4b-modules。`Mij`：第 i 列第 j 个分量（列主序）。
- 矩阵乘：`FUN_14005ecb0(out, A, B)` 与 `FUN_14024f0e0(out, A, B)` 都是 `A·B`；`FUN_14005f730`、`FUN_1402290d0` 都是 4×4 求逆（伴随矩阵除行列式，前者 `1.0/det` 后乘，后者 `divps`）。

---

## 1. 控制点

### 1.1 存储布局（`FUN_14022c3c0` 尾部、`FUN_14022e3e0`）【确】

| 位置 | 内容 |
|---|---|
| `sys+0x400` | 数组指针，`_aligned_malloc(n·0xd0, 16)`；`n = 0` 时为空指针 |
| `sys+0x44` | 个数 `n`（u32） |
| `cp+0x00..0x3f` | **current** 4×4，第 3 列 `+0x30..0x38` 是平移 |
| `cp+0x40..0x7f` | **previous** 4×4 |
| `cp+0x80..0xbf` | **base** 4×4：`offset`、`instanceoverride` 写这里 |
| `cp+0xc0` | `flags`（u32）：JSON 原值，外加内部位 `0x10000` |
| `cp+0xc4` | `parentcontrolpoint`（u32） |
| `cp+0xc8..0xcf` | 没看到读写【推：对齐填充】 |

**个数 `n` 不是 8：**
- `sys+0x44` 来自 def `+0x2c`（sys 偏移 = def 偏移 + 0x18）。解析开头置 0（`0x1401c5b06`），每个用到控制点的模块做 `max(已有, controlpoint + 1)`（`0x1401c6ab8`、`0x1401c8734`、`0x1401ca179`、`0x1401ccd99` 等）。
- 没被任何模块引用的控制点**不存在**，JSON 里给它的 `flags`、`offset` 都不起作用。顶层系统按「总是 8 个」实现结果相同，因为没人读多出来的。
- 事件子系统（子系统条目 `+0x64` bit0）强制 `n = 8`（`FUN_14022c3c0` `0x14022ccbf` 附近），P4e。

**def 里的控制点**（解析写入，`FUN_14022c3c0` 拷进 `sys+0xbc + i·0x20`）：每项 0x20 字节，`+0` flags、`+4` parentcontrolpoint、`+8` offset xyz、`+0x14` angles xyz。

### 1.2 解析（`FUN_1401c5490` 段 `0x1401d04d8`–`0x1401d080e`）【确】
- 只在 `controlpoint` 是数组时读；下标 0–7；不是对象的项跳过。每项：
  - `offset`：缺省值 `"0 0 0"` 写回 JSON；**只在是字符串时**解析（`0x1401d05c5`），三次 `atof`、空格分隔，缺的分量是 0。
  - `flags`、`parentcontrolpoint`：`asInt`，缺省 0。`parentcontrolpoint` 不钳制，运行时和父系统的个数比较。
  - `angles`：只在是字符串时解析，存进 def `+0x14`。
  - `id`：不读。
- **`angles` 运行时不读【确，有界】：** 初值段、`FUN_14022e3e0`、`FUN_14022bd40` 都只读 flags、parent、offset。在 `0x140220000`–`0x140260000` 搜 `+0xd0/+0xd4/+0xd8` 的读取，只有对象拷贝函数（`0x14022bb0a` 起）。
- **`locktopointer` 不存在【确】：** 全二进制按 ASCII 和 UTF-16LE、大小写不敏感搜 `locktopoint`、`topointer`、`lockto`，都没有结果。WPE 2.8.42 不读这个键。
- **内部位 `0x10000`（`0x1401d0860`–`0x1401d087e`）：** 解析完数组后，遍历一个下标集合，对 `< 8` 的下标 `flags |= 0x10000`。集合在 `remapinitialvalue`（`0x1401cafce`）和 `remapvalue`（`0x1401cf069`）的输出是控制点时插入（`FUN_1401bc470` 判断输出类型，插入 `outputcontrolpoint` 下标）。【推：名字按解析段位置判断】带这个位的控制点由 remap 模块写，`FUN_14022e3e0` 和 `FUN_14022bd40` 都跳过它（P4d / P4e）。

### 1.3 初值【确】

`FUN_14022c3c0`（`0x14022cd88` 起，分配后逐项）：
```
cp.flags  = def.flags
cp.parent = def.parent
base      = I;  base.t = def.offset        // base 第 3 列 w 仍是 1
previous  = base
current   = base
```
- rea-p4a「未查完」里的「cp 初值是单位阵加 `offset`」成立，但不含 `angles`。

加载顺序：
1. `FUN_14022af30`（粒子对象加载）：`FUN_14022c3c0` → 解析 `instanceoverride` → `FUN_14022bd40(sys, 1)`（`0x14022b86f`）。这时 `sys+0x3a0` 还是构造函数 `FUN_1402293a0` 写的单位阵。
2. `FUN_14022feb0`：`sys+0x3a0 = W` → `FUN_14022ebe0`：压模型矩阵（`FUN_140229760`）→ `FUN_14022e3e0` 一次（`0x14022f243`）→ 所有控制点 `previous = current` → 预热，每步 `FUN_140236cd0` 照常更新控制点并拷 previous → 弹栈。

### 1.4 模型矩阵栈与 `M`【确 / 推】
- `ctx+0x30` 模型、`ctx+0x38` 视图、`ctx+0x40` 投影，各是栈顶指针，每层 0x40 字节，压栈 `+0x40`【确：`FUN_1401e5b60` 改 `*(ctx+0x38)` 的平移（`0x1401e5b8f`、`0x1401e5bf7`），即视图；构造函数 `FUN_14017c6d0` 在三个栈顶写单位阵（`0x14017d560`–`0x14017d5f7`）】。
- `FUN_140229760(sys)`（`0x140229760`）：
  ```
  新栈顶 = 旧栈顶
  若 sys.flags & 1（世界空间）：新栈顶 = sys+0x3a0（W）
  否则：                        新栈顶 = 旧栈顶 · W
  ```
- `FUN_140230650` 每帧：先在脏时调 `FUN_14022bd40`，再 `sys+0x3a0 = W`，压栈，模拟（`FUN_1402308a0`），弹栈。
- **顶层系统模拟时 `M = W`**，本地、世界都一样【推：前提是更新阶段旧栈顶是单位阵。构造时是单位阵，push/pop 成对，没逐帧核对】。子系统是「父栈顶 · 子条目的局部变换」（P4e）。
- 脏时的 `FUN_14022bd40` 跑在刷新 `W` 之前，用的是**上一帧的 `W`**。

### 1.5 每帧更新 `FUN_14022e3e0`【确】

时机：O1 第 5 步，死亡处理之后、发射之前（`0x1402376fe`）；**每帧一次**，两遍模式也只一次。帧尾 `previous ← current`（4×4 整体，`0x140237798`–`0x1402377dd`），在全部 operator 之后。

```
for i in 0 .. sys.n − 1:
    f = cp[i].flags                                    // 0x14022e461
    if f & 0x10000: continue                           // 0x14022e468，remap 输出的点
    if f & 1:   指针分支（1.6）; continue              // 0x14022e472
    if f & 4:                                          // 0x14022e66e
        parent = sys+0x10
        if parent ≠ null 且 cp[i].parent < parent.n: 父分支（1.8）; continue
        缺省更新; continue                             // 0x14022eb4c
    if (sys+0x3f6 & 1) 且 i ≥ sys+0x3f5: continue      // 事件子系统由父粒子写的点（P4e）
    缺省更新                                           // FUN_14022a070(sys, i, M)，0x14022eb59
```

**缺省更新 `FUN_14022a070`：**
```
world = sys.flags & 1                                  // sys+0x20 bit0
if world:
    if !(f & 2) 或 i == 0: current = M · base         // FUN_14024f0e0
    else:                  不动                        // current 保持 base
else:
    if f & 2:              current = inverse(M) · base // FUN_1402290d0 求逆
    else:                  不动                        // current 保持 base
```
- **bit1 的含义：** base（`offset` / `instanceoverride` 平移和角度）是场景坐标。本地系统把它换回对象本地；世界系统直接用。
- **怪处：** 世界系统里控制点 0 忽略 bit1，照样 `M · base`。
- 本地系统、无 bit1 时这里不写 current。current 只在初值和 `FUN_14022bd40` 里被设成 base。

### 1.6 指针分支（`0x14022e47b`–`0x14022e669`）【确】

```
current = base                                         // 整个 4×4，平移下面覆盖
px = ctx[0x8c];  py = ctx[0x90]
A  = inverse(P · V)                                    // FUN_14005ecb0(P, V) 再 FUN_14005f730
x  = ((px − 0) + (px − 0)) − 1                         // subss 0、addss 自身、subss 1
y  = (((1 − py) − 0) + ((1 − py) − 0)) − 1
w  = (A03·x + A13·y) + (A23·0 + A33)
X  = ((A00·x + A10·y) + (A20·0 + A30)) / w             // divss
Y  = ((A01·x + A11·y) + (A21·0 + A31)) / w
if world:
    current.t = (X, Y, 0)
else:
    B = inverse(M)                                      // FUN_14005f730
    current.t = ((B00·X + B10·Y) + (B20·0 + B30),
                 (B01·X + B11·Y) + (B21·0 + B31),
                 (B02·X + B12·Y) + (B22·0 + B32))
```
- **`offset` 被丢弃：** 平移整体覆盖。`FUN_14022bd40` 也跳过指针点，所以 3×3 实际总是单位阵。
- **反投影的 z 被丢掉：** 只算 X、Y、w，再按 z = 0 进对象本地。
- **不钳制：** 光标在窗口外时照样外推，和实测 (3195, 1174) 一致。
- **世界系统里 3×3 不乘 `W`**：发射形状不随对象旋转、缩放（非指针点在世界系统里是 `W · base`，会随）。
- **用的是模拟时栈上的 `P`、`V`：** 透视粒子（系统 `flags & 4`）的透视投影只在绘制时由 `FUN_1401e5b60` 临时压栈，不影响这里，所以指针落在正交视图的 z = 0 平面上；透视粒子的 z = 0 平面与正交画面重合（rea-p4a C4），粒子仍出现在光标下【推】。
- **模拟时 `P`、`V` 是哪一帧的：** 对象更新在 `FUN_1401891a0` 开头，相机处理在其后（`m_1401891a0.c`），栈上大概率是上一帧留下的场景相机【推】。静止相机下无差别；相机视差、抖动会让指针差一帧【推】。
- **透视场景：** 反投影点取 NDC z = 0，X、Y 依赖投影的深度约定（`[ctx+0x1518]` 虚函数 `+0x10` 构造，没读）【未知】。正交场景里 `P·V` 是仿射的，z 项乘 0，与深度约定无关【确】。

### 1.7 指针的来源和换算【确】
- **写入（渲染循环，`FUN_140111xxx`）：**
  1. `GetCursorPos`（`0x1401115a8`，屏幕坐标）。
  2. `ScreenToClient(hwnd = [session+0x1c8], &pt)`（`0x14011161a`）。返回 0 时不写，保留上一帧的值。
  3. `R+0x9c = (float(pt.x), float(pt.y)) / (R+0x84, R+0x88)`（`divps`，`0x14011163b`–`0x14011164b`）。`R+0x9c` 就是 `ctx+0x8c`。
- **`R+0x84/0x88`：** 渲染目标宽高的 float。调整大小时写（`0x14017f1f6`–`0x14017f22d`）：整数宽高各取 `max(2, ·)` 存 `R+0x8c/0x90`，再转 float。`ctx+0x74/0x78` 就是它们（rea-p4a C4 的 `aspect`）。
- **结论：** `ctx+0x8c/0x90` 是客户区归一化坐标，左上 (0, 0)、右下 (1, 1)，y 向下，不钳制，鼠标在任何位置都跟踪（`GetCursorPos` 是全局的）。
- **时机：** 每个非暂停帧、帧函数之前（帧函数 `FUN_14017fa70` 在 `0x1401131cc` 调用）。暂停时那一段不跑，指针冻结。没有看到「鼠标输入开关」之类的门（`0x140111518`–`0x14011160f` 的分支都汇合到 `ScreenToClient`）。
- **上一帧指针：** 帧尾 `R+0xa4 ← R+0x9c`（`0x140181615`），即 `ctx+0x94/0x98`。
- **全局 uniform 编号：** `g_PointerPositionLast` 0x68、`g_PointerPosition` 0x69、`g_PointerState` 0x6a（注册表 `0x140003eb7`–`0x140003ef7`）。**写 uniform 值的地方没找到**【未知】，见「未解决」。
- **Kabegame 的换算（读码推出）：** 场景坐标 = `inverse(P·V)` 作用在 `(2px − 1, 1 − 2py, 0, 1)` 上再除 w，`P`、`V` 是 WPE 当时把场景铺到窗口的矩阵。Kabegame 里应等价于「画布像素 → 场景坐标」的逆映射，包含 `fit` / `center` 的留白，留白和窗口外都线性外推、不钳制【推】。

### 1.8 父控制点（bit2、bit3、`parentcontrolpoint`）【确】
- **父是谁：** `sys+0x10`。顶层系统构造时置 0（`FUN_1402293a0` 的 `param_1[2] = 0`），只有建子系统时写成父系统（`FUN_14022ebe0` 建 static 子系统处 `plVar15[2] = param_1`）。
- **顶层系统上的 bit2：** 父为空，走缺省更新，和 `flags 0` 一样；唯一差别是 `FUN_14022bd40` 跳过它（`f & 0x10005`），`instanceoverride` 的 `controlpointN` / `controlpointangleN` 对它不生效。
- **bit3（`0x14022e6b3`）：** 只在父分支里有用，见下。
- **判定：** bit2、bit3、`parentcontrolpoint` 只对子系统有意义，**归 P4e**。P4c 对顶层系统只需复刻「bit2 时忽略 `instanceoverride` 控制点」。

父分支（P4e 用）：
```
pcp = parent.cp[cp.parent].current
selfW = sys.flags & 1;  parW = parent.flags & 1
Mprev = *(ctx+0x30) − 0x40                              // 栈上一层：父系统的模型矩阵
if (!selfW 或 !parW) 且 !(f & 8):
    !selfW 且 !parW:  current = inverse(M) · (Mprev · pcp)
    !selfW 且  parW:  current = inverse(M) · pcp
     selfW 且 !parW:  current = Mprev · pcp
else:                 current = pcp                     // 两边都是世界空间，或 bit3
```

### 1.9 `flags` 位表

| 位 | 含义 | 证据 |
|---|---|---|
| 1 | 跟随指针（1.6） | 【确】，实测一致 |
| 2 | base 是场景坐标（1.5）；世界系统的控制点 0 忽略它 | 【确】 |
| 4 | 父控制点（1.8）；顶层系统上等于 0，但忽略 `instanceoverride` 控制点 | 【确】 |
| 8 | 父分支不做坐标换算 | 【确】 |
| 16 | **没有读取点** | 【确，有界：`0x140150000`–`0x140260000` 所有 `+0xc0` 读取只测 1、2、4、8、0x10005】 |
| 0x10000 | 内部：remap 模块写这个点 | 【确】，来源名字【推】 |

位的优先级：`0x10000` > bit0 > bit2 > 缺省。bit0 和 bit2 同时置位时指针赢。

---

## 2. `instanceoverride` 的 `controlpoint0..7`、`controlpointangle0..7`

**属性（`FUN_14024d940`）【确】：** `controlpointN` 偏移 `0xf0 + 12N`，`controlpointangleN` 偏移 `0x150 + 12N`（基址 `obj+0x778`）。类型 2（vec3，和 `colorn` 同一套 getter `FUN_1401a4230`），setter 回调 `LAB_14022ab30`（置脏 `obj+0x928`）。缺省 FLT_MAX 表示未设。

**写入（`FUN_14022bd40`，`0x14022bf26`–`0x14022c17d`）【确】：**
```
FUN_140229760(sys)                                     // 压栈，M = 栈顶的拷贝
for i in 0 .. sys.n − 1:
    if cp[i].flags & 0x10005: continue                 // 指针、父、remap 的点不管
    a = angle[i]                                       // obj+0x8c8 + 12i
    if a.x ≠ FLT_MAX:                                  // 只比较 x 分量
        cz, sz = cos(a.z), sin(a.z);  cy, sy = …a.y;  cx, sx = …a.x   // CRT cosf / sinf
        base.col0 = (cy·cz, cy·sz, −sy)
        base.col1 = ((sy·cz)·sx − cx·sz, (sy·sz)·sx + cx·cz, sx·cy)
        base.col2 = ((cx·cz)·sy + sx·sz, (cx·sz)·sy − sx·cz, cx·cy)
    t = pos[i]                                         // obj+0x868 + 12i
    if t.x ≠ FLT_MAX: base.t = t                       // 替换，不加 offset
    elif a.x == FLT_MAX: continue                      // 两个都没设：不碰 current
    if (!(f & 2) 或 i == 0) 且 world: current = M · base
    elif !(f & 2) 或 world:          current = base
    else:                            current = inverse(M) · base
弹栈
```
- **角度：** 弧度，`R = Rz·Ry·Rx`，和对象 `angles` 同一套公式（rea-p4a A1）。乘法结合顺序取自 Ghidra，没对汇编逐条核对【推】。
- **覆盖什么：** 替换 base 的平移和 3×3，不是加到 `offset` 上。两者没设的那一半保持原值（平移保持 `offset` 或上次覆盖的值）。
- **坐标空间：** 和 `offset` 相同。本地系统、无 bit1 是对象本地；有 bit1 是场景坐标；世界系统是对象本地，再乘 `W`（控制点 0 或无 bit1）。
- **和指针同时存在：** 指针赢，覆盖完全不生效（连角度也不应用）。bit2 的点同样不生效。
- **运行时改值：** setter 置脏，下一帧 `FUN_140230650` 在刷新 `W` **之前**调 `FUN_14022bd40(sys, 1)`：
  - 从 base 重写，不累乘；不碰 previous（`inheritcontrolpointvelocity` 会看到一个跳变）。
  - 本地、无 bit1 的点 current 立刻等于新 base；其余在同帧 `FUN_14022e3e0` 里用本帧 `W` 重算。
  - 参数 1 会重新打开已结束且 `rate > 0` 的发射器（rea-p4a C5），并递归到子系统。
  - FLT_MAX 是「保持」，改不回「未设」。
- **加载时：** `FUN_14022af30` 里调一次，早于预热（1.3）。

---

## 3. 读控制点的模块

| 模块 | 类 / 类型号 | 读哪一份 | 用哪部分 | 备注 | 地址 | 归属 |
|---|---|---|---|---|---|---|
| `sphererandom` | emitter 1 | current | `t` + 3×3 | 3×3 只在「世界空间或 `controlpoint ≠ 0`」时作用到出生点；`origin` 不经 3×3；传给 initializer 的 `M = mat3(current)` 无条件 | `emit_1402378a0.c` 第 465–676 行 | P4c |
| `boxrandom` | emitter 2 | current | `t` + 3×3 | 同上（rea-p4b A4） | 同文件第 802–826 行 | P4c |
| `layerimage` | emitter 3 | 不读 | — | `M` 本地为单位阵，世界为 `mat3(模型栈顶)`【`FUN_1401a27f0` 是单位阵为推】 | 同文件第 1053–1090 行 | — |
| `velocityrandom` | init 7 | 发射器的 `M` | 3×3 | 无条件乘（`0x14023bbce`） | `0x14023bac6` | 已实现 |
| `inheritcontrolpointvelocity` | init 8 | current 与 previous | `t` | `(cur.t − prev.t) / ctx+0x150`；世界系统且无 bit1 时再变换一次；再乘 `M` | `0x14023bc32` | P4d |
| `turbulentvelocityrandom` | init 9 | 发射器的 `M` | 3×3 | 无条件 | `0x14023bdbc` | P4c |
| `mapsequencearoundcontrolpoint` | init 13 | current | `t` + 矩阵 | | `0x14023c4fd` | P4d |
| `mapsequencebetweencontrolpoints` | init 14 | 两个点的 current | `t` | | `0x14023cac1` | P4d |
| `controlpointattract` | op 10 / blend 0x20 | current | `t` | 见第 4 节 | `0x140241554` / `0x14024172d` | P4c |
| `maintaindistancetocontrolpoint` | op 11 / 0x21 | current 与 previous | `t` + 矩阵 | `FUN_14005f0a0(当前, 上一帧)` | `0x14024197a` / `0x140241ccf` | P4d |
| `maintaindistancebetweencontrolpoints` | op 12 / 0x22 | 两个点的 current，一个点的 previous | `t` | | `0x140242058` / `0x140242352` | P4d |
| `reducemovementnearcontrolpoint` | op 13 / 0x23 | current | `t` | | `0x14024268f` / `0x1402427b8` | P4d |
| `vortex` | op 15 | current | 只用 `t` | 轴和 `offset` 不旋转（rea-p4b B7） | `0x1402431be` | P4c |
| `vortex_v2` | op 16 / 0x25 | current | `t` + 3×3【3×3 为推，`FUN_14019d450` / `FUN_140216600` 没读】 | | `0x1402433ea` / `0x140243a17` | P4d |
| `remapvalue` | op 19 | current | `t`（输入） | 输出写控制点、打 `0x10000`【推】 | `0x140244bd4` 起 | P4d / P4e |
| `collisionplane` / `collisionsphere` / `collisionquad` | op 21 / 22 / 25 | current | `t`（plane、quad 另有 3×3【推】） | | `0x14024afb2` / `0x14024b0f4` / `0x14024b653` | 未排期 |

- 「current」是本帧 `FUN_14022e3e0` 算完的值；所有 operator 在同一帧的控制点更新之后跑。
- 发射器分支细节【确】：`旋转 = (sys.flags & 1) 或 controlpoint ≠ 0`（`emit` 第 496、825 行）。所以**本地系统的控制点 0 即使有 `controlpointangle0`，出生点也不旋转**，但 `velocityrandom` / `turbulentvelocityrandom` 的方向会被 `mat3(current)` 旋转。
- 出生点：`pos = M_cp·q + (cp.t + origin)`；速度方向（`sphererandom`）是旋转后的 `q`（rea-p4a B）。

---

## 4. `controlpointattract`（operator 10，blend 0x20）

### 4.1 解析（`0x1401cc9c8`–`0x1401ccdb5`，缺省 `FUN_1401bdee0`）【确】

记录：`FUN_1401d8b30` 分配，类型 0xa、长度 0xc0，负载 `p = rec + 0x10`。

| 字段 | 正交 | 透视 | 偏移 | 说明 |
|---|---|---|---|---|
| `offset` | `"0 0 0"` | 同 | p+0x00 / +0x10 / +0x20（各 ×4） | 字符串；**执行时不读** |
| `scale` | 512 | 20 | p+0x30（×4） | 乘 `instanceoverride.speed`（条目类型 5，`flags & 0x10` 时不登记） |
| `threshold` | 512 | 5 | p+0x40（×4） | |
| `deletethreshold` | 15 | 0.5 | p+0x50（×4） | **存平方** |
| `flags` | **2** | **2** | p+0xa0 | 缺省是 jsoncpp 整数 2（`0x1401be245`）。bit0 删除，bit1 钳制 |
| `controlpoint` | 0 | 同 | p+0xa4 | `min(·, 7)`，无符号比较，负数变 7 |
| blend 四键 | 同 rea-p4a | | p+0x60 | `FUN_1401c2a40`，blend 记录类型 0x20 |

- **没有 `origin`：** 解析段只读上面六个键加 blend 键。语料里 53 处 `origin` 都被忽略【确】。
- `offset` 解析后存了，但两个执行段、`FUN_14022a150` 都不读它【确】。
- 其它副作用：`def+0x2c = max(·, controlpoint + 1)`；`flags & 1` 时 `def+0xc |= 4`，即系统列标志 bit2（「上一步位置」列，rea-framework Q5）。
- 覆盖条目类型 5（`FUN_1401d15a0` case 5）：`scale×4 = json.scale · instance.speed`，只登记这一条，`threshold`、`deletethreshold` 不受覆盖。
- 两套缺省按 `ctx+0x118 & 0x400`（正交）选，同 rea-p4b。

### 4.2 执行（`0x140241554`；blend `0x14024172d`）【确】
```
C   = cp[controlpoint].current.t                         // FUN_14024f2d0 拷贝 + FUN_14022a120 广播 +0x30/+0x34/+0x38
ks  = k · scale                                          // xmm8 = k（第三参数，0x14023fc11 / 0x140240290）
rT  = rcpps(threshold)                                   // 近似倒数
clampMask = (flags & 2) ? 全 1 : 0
每 4 个槽（0 .. 高水位，死槽也算）：
    dx = x − Cx;  dy = y − Cy;  dz = z − Cz
    L2 = (dz·dz + dy·dy) + dx·dx
    L  = sqrtps(L2)                                       // 精确
    inv = rcpps(L)                                        // 近似
    active = (L < threshold) 且 (FLT_MIN < L)             // 两个都是严格小于；FLT_MIN = 0x00800000
    f  = (1 − L·rT) · ks
    if clampMask 且 L < f: f = L                          // blendvps
    [blend 版：f = f · b]                                 // b 由 FUN_14022a530 算，乘在钳制之后
    vy −= active ? (inv·dy)·f : 0
    vz −= active ? (inv·dz)·f : 0
    vx −= active ? (inv·dx)·f : 0
if flags & 1: 删除判定 FUN_14022a150（4.3）
```
- **改速度，不改位置。** `scale > 0` 吸引，`< 0` 排斥。
- **用 `k`：** fps ≥ 40 时等于 `dt'`；更低时被压弱；两遍模式每遍 `k/2`。
- **`threshold`：** `L < threshold` 才生效，严格小于。`f` 在边界处趋于 0。
- **钳制（bit1，缺省开）：** 只在 `L < f` 时把 `f` 换成 `L`。`scale` 为负时 `f < 0`，永远不钳。
- 近似：`rcpps(threshold)`、`rcpps(L)` 相对误差约 3.7e-4。

### 4.3 删除判定 `FUN_14022a150`（`flags` bit0）【确】
```
C = cp.current.t
每 4 个槽：
    P0 = 上一步位置（sys+0x2e0/0x2e8/0x2f0）;  P1 = 位置
    d  = P1 − P0;  L = sqrtps(d·d)
    r  = (L > 0) ? rcpps(L) : 1
    s  = (Cz − P0z)·(r·dz) + (Cy − P0y)·r·dy + (Cx − P0x)·r·dx    // C 在路径方向上的投影
    s  = (s ≥ 0) ? s : 0
    s  = (s ≤ L) ? s : L
    e  = C − (s·r·d + P0)                                          // 线段上离 C 最近的点到 C
    age = (|e|² > deletethreshold²) ? age : life                   // 不满足就把年龄设成寿命
```
- 置 `age = life` 后，下一帧 `age += dt'` 严格大于 `life`，粒子死亡；本帧还会画一次。
- 加法结合顺序取自 Ghidra，没对汇编逐条核对【推】。
- **「上一步位置」列：** 出生时等于位置，`movement` 每遍开头把位置抄进去（rea-p4a）。本模块是它在 P4c 范围里的唯一读者，另一个读者是 `collisionquad`。线段就是最近一次 `movement` 的位移。

### 4.4 两遍模式与顺序
- 每遍都完整跑一次 4.2 和 4.3，参数是这一遍的 `k`。
- 按 JSON 顺序执行，读的是前面 operator 刚改过的位置和速度。

---

## 5. 世界空间（系统 `flags` bit0）

### 5.1 标志【确】
`sys+0x20` bit0 = 粒子 JSON `flags` bit0（rea-p4a C3）。

### 5.2 模拟【确】
- 控制点：缺省更新 `current = W · base`（1.5，`M = W`）。所以 `cp.t` 是世界坐标，3×3 含 `W` 的旋转和缩放。
- 出生点：`pos = mat3(W·base)·q + (W·base.t + origin)`。**`origin` 不经 `W`**：本地系统里 `origin` 在对象空间、绘制时乘 `W`；世界系统里它是世界坐标的直接偏移【确，`sphererandom`、`boxrandom`】。
- 出生速度：`sphererandom` 的方向是旋转后的 `q`；`velocityrandom`、`turbulentvelocityrandom` 乘 `M = mat3(W·base)`，**含缩放**。
- 指针点：`(X, Y, 0)`，3×3 单位阵，不随对象旋转缩放（1.6）。
- 已发出的粒子存世界坐标，对象之后移动、旋转不影响它们。
- `W` 每帧从虚函数 `+0x80` 重取，含父链（`FUN_140230650`），父链变化下一帧就生效。

### 5.3 绘制（`FUN_1402366f0`，`0x14023670c`–`0x140236748`）【确】
```
if sys.flags & 1:
    *(ctx+0x30) 当前栈顶 = ctx+0xaf0                     // 整个 4×4 覆盖
```
- **`ctx+0xaf0` 是单位阵：** 构造函数 `FUN_14017c6d0` 写成单位阵（`0x14017cbbf` 起）。组合层离屏渲染时临时设成当时的模型矩阵（`0x1401ecd0a`、`0x1402083e4`），渲染完复位成单位阵（`0x1401ececb`、`0x14020858b`）【确】；这两处属于哪种图层路径【推：组合层 / passthrough 的子对象渲染】。
- 所以普通场景里世界空间粒子只乘 `V`、`P`。
- 覆盖在透视覆盖之前（透视在 `0x140236761` 起压栈），透视粒子照常工作。

### 5.4 `movement` 的重力（`0x14023fde2`–`0x14023fe31`）【确】
```
g = gravity
if movement.flags & 1 且 !(sys.flags & 1):
    g = Mᵀ · g          // FUN_1400dd7d0 取 mat3(M)【推】，FUN_1401f87e0 做乘法
```
- `FUN_1401f87e0(v, m3)`：`x' = (v.y·m[1] + v.x·m[0]) + v.z·m[2]`，`y' = (v.x·m[3] + v.y·m[4]) + v.z·m[5]`，`z' = (v.x·m[6] + v.y·m[7]) + v.z·m[8]`，`m` 列主序，即 `Mᵀ·v`。
- 本地系统：把世界方向转进对象本地（有缩放时不归一化）。世界系统：`g` 直接是世界方向。
- `movement.flags & 1 = 0` 时两种系统都不变换：本地系统的重力随对象转，世界系统的固定在世界。

### 5.5 其它受影响的模块【确，按代码推出效果】
- `vortex`：中心 `cp.t`（世界）加 `offset`（不旋转）；轴不变换，**世界系统里轴固定在世界**，本地系统里轴随对象转。
- `turbulence`、`positionoffsetrandom`：噪声输入是存储的位置，世界系统里就是世界坐标。
- `controlpointattract`：`C` 是世界坐标的 `cp.t`。
- `layerimage`：世界系统 `M = mat3(模型栈顶)`，本地是单位阵。

### 5.6 其它情形
- **对象不可见：** 和本地系统一样，`emit = 0`、清空粒子（rea-framework Q3）；模拟照跑，控制点照常更新。
- **透视粒子：** 绘制先换模型矩阵再压透视，世界坐标照常投影【确】。
- **预热：** `W` 在 `FUN_14022feb0` 里先写好，预热按加载时的 `W` 发射【确】。

---

## 未查完 / 未解决

- **`g_PointerPosition` 的写入点【未知】。** 只确认了编号 0x69（`Last` 0x68）。在 `R+0x9c`、`ctx+0x8c` 的所有读取点、按编号分派的跳转表（`0x1400f7065` 那张只返回分量数）、「编号→偏移」数据表里都没找到。`ctx+0x8c/0x90` 是二进制里唯一存的指针状态，`ctx+0x94/0x98` 是它的上一帧，和 `g_PointerPosition` / `g_PointerPositionLast` 成对，【推】是同一个量，y 方向是否翻转不知道。
- **透视场景的指针深度：** 投影构造在图形设备虚函数里，深度约定（`[-1,1]` 还是 `[0,1]`）没读，NDC z = 0 对应的深度【未知】。正交场景不受影响。
- **模拟时的 `P`、`V`：** 是上一帧还是本帧的相机，相机视差（`obj+0x178`）、缩放有没有留在栈上【推，未核对】。
- **更新阶段模型栈底是单位阵：** 构造时是，push/pop 成对，没逐帧核对【推】。
- **`R+0x84/0x88` 等于窗口客户区大小：** 只读到调整大小时写入，渲染分辨率缩放设置下是否不同【未知】。
- **加载时的指针初值**：构造函数里 `R+0x9c` 的初值没找【未知】，影响预热期跟随指针的出生点。
- `vortex_v2`、`collisionplane`、`collisionquad` 是否用 3×3（`FUN_14019d450`、`FUN_140216600` 没读）【推】。
- `remapvalue` / `remapinitialvalue` 怎么写控制点、`0x10000` 的完整语义【推】。
- `inheritcontrolpointvelocity` 用的 `ctx+0x150`（`R+0x160`）是不是上一帧 dt，世界系统里那次变换（`FUN_14005f0d0` + `FUN_14019d470`）是什么【推 / 未知】。
- 事件子系统的 `sys+0x3f5` / `sys+0x3f6`、`FUN_14022a580`（父粒子位置写进子系统控制点）留给 P4e。
- `FUN_14022bd40` 角度和 `FUN_14022a150` 的乘加结合顺序按 Ghidra 写，没对汇编逐条核对。

---

## 建议的确定性实验

通用设置：正交场景 1920×1080，铺满窗口；粒子对象 `origin "960 540 0"`、无旋转缩放；`movement` 无重力、`drag 0`；`maxcount` 小、`rate` 低，便于逐个认粒子。发射用 `sphererandom` `distancemin = distancemax = 100`、`directions "1 0 0"`、`sign "1 0 0"`、`speedmin = speedmax = 0`，出生点就是确定的「中心 + (100, 0)」。下文「出生点」都是场景坐标。

### `proj/p4c-cp`

| 名 | 设置 | 预测 |
|---|---|---|
| `cp-angles` | 控制点 1 `angles "0 0 1.5708"`，发射 `controlpoint 1` | 出生点 (1060, 540)：JSON `angles` 不起作用。若起作用会是 (960, 640) |
| `cp-io-angle` | 同上，但改用 `instanceoverride.controlpointangle1 "0 0 1.5708"` | (960, 640)：控制点 ≠ 0，旋转作用到出生点 |
| `cp-io-pos` | 控制点 1 `offset "100 0 0"`，`instanceoverride.controlpoint1 "0 200 0"` | (1060, 740)：替换 offset，不是 (1160, 740) |
| `cp0-angle` | 控制点 0，`controlpointangle0 "0 0 1.5708"`；另加 `velocityrandom` `min = max = "50 0 0"` | 出生点 (1060, 540)（控制点 0 本地不旋转出生点），速度 (0, 50)（`M` 旋转了） |
| `cp-flag2` | 控制点 1 `offset "100 100 0"`、`flags 2`；对象 `scale "2 2 1"`、`angles "0 0 0.5"` | 出生中心固定在 (100, 100)，与对象变换无关；对照组 `flags 0` 跟着对象走 |
| `cp-flag4` | 顶层系统控制点 1 `flags 4`、`parentcontrolpoint 0`、`offset "100 0 0"`，`instanceoverride.controlpoint1 "0 300 0"` | 中心 (1060, 540)：缺省更新，覆盖被忽略 |
| `cp-flag16` | 控制点 1 `flags 16`、`offset "100 0 0"` | 和 `flags 0` 逐位相同 |
| `ptr-offset` | 控制点 0 `flags 1`、`offset "100 50 0"` | 出生在光标处，`offset` 不起作用 |
| `ptr-io` | 控制点 0 `flags 1`，`instanceoverride.controlpoint0 "0 0 0"`、`controlpointangle0 "0 0 1"` | 仍在光标处，覆盖不起作用 |
| `ptr-xform` | `flags 1`，对象 `angles "0 0 0.7"`、`scale "2 2 1"` | 中心仍在光标处（本地系统乘了 `inverse(W)`）；出生点相对光标的偏移是 `W` 作用后的 (200, 0) 旋转 0.7 |
| `ptr-lock` | 控制点 0 `flags 0`、`locktopointer true` | 不跟随，出生在 (1060, 540) |
| `ptr-out` | `flags 1`，抓帧时光标移到窗口外 | 坐标外推、不钳制，和记录的 `g_PointerPosition` 按下式吻合 |
| `vortex-cp` | `vortex` `controlpoint 1`，控制点 1 `offset "200 0 0"`，`instanceoverride.controlpointangle1 "1.5708 0 0"` | 中心偏 (200, 0)，轴仍是 z（旋转不作用到 `vortex`） |

**指针换算核对：** 本场景铺满窗口时，跟随点 `X = px·1920`、`Y = (1 − py)·1080`（`px, py` 是 `ctx+0x8c/0x90`）。PTR 图层每帧写出 `g_PointerPosition`（和 `Last`）：
- 若 `g = (px, py)`：`X = g.x·1920`、`Y = (1 − g.y)·1080`。
- 若着色器里已经翻过 y：`Y = g.y·1080`。
- 用同一帧跟随粒子的出生点在两式之间二选一。注意出生点用的是**本帧**的指针（`FUN_14022e3e0` 在帧函数里，指针在帧函数之前写），和 `g_PointerPosition` 同帧。

### `proj/p4c-attract`

出生点 `C + (300, 0)`，速度 0；控制点 0 在对象原点。`L = 300`。

| 名 | 设置 | 预测（每帧速度变化） |
|---|---|---|
| `a-basic` | `scale 100`、`threshold 500`、`flags 0` | `Δvx = −(1 − 300·rcpps(500))·100·k ≈ −40k`，`L` 变小后按公式递推 |
| `a-default` | 不写 `flags`，`scale 1e6`、`threshold 500` | 缺省 bit1 钳制：`f = L`，`Δvx = −L` |
| `a-flags0` | 同上，`flags 0` | 不钳制：`Δvx = −(1 − L/500)·1e6·k`，一帧冲过去 |
| `a-repel` | `scale −100` | `Δvx ≈ +40k` |
| `a-thresh` | `threshold 250` | 不受影响 |
| `a-thresh-eq` | `threshold 300` | 第一帧不受影响（严格小于） |
| `a-origin` | 在 `a-basic` 上加 `origin "200 0 0"`、`offset "200 0 0"` | 与 `a-basic` 逐位相同 |
| `a-speed` | `instanceoverride.speed 2` | 吸引加倍（`scale` 乘 `speed`），`threshold` 不变 |
| `a-delete` | `scale 0`、`flags 1`、`deletethreshold 20`，粒子以 300/s 沿 +x 穿过控制点（出生在 `C − (300, 0)`） | 线段经过 `C` 附近的那一帧之后消失；`deletethreshold 0` 时只在恰好穿过时删 |
| `a-k` | `a-basic` 抓 fps 10 | 每遍 `k/2`，`k = pow(0.025/dt, 0.7)·dt'`，明显弱于按 `dt` 的预期 |
| `a-blend` | `blendinstart 0`、`blendinend 0.5` | 吸引在前半生命按 `b` 渐入，钳制之后再乘 `b` |

### `proj/p4c-world`

对象 `origin` 由脚本随时间平移、`angles.z` 随时间旋转；世界空间系统与同设置的本地系统各一个。

| 名 | 设置 | 预测 |
|---|---|---|
| `w-stay` | `speed` 0 发射 | 世界系统：已发粒子留在原地；本地系统：跟着对象走 |
| `w-origin` | 发射器 `origin "100 0 0"`，对象 `angles "0 0 1.5708"` 固定 | 世界系统出生在 (1060, 540)（`origin` 不经 `W`）；本地系统在 (960, 640) |
| `w-scale` | 对象 `scale "2 2 1"`，发射 `distance 100` | 两组半径都是 200（世界系统经 `mat3(W)`，本地经绘制） |
| `w-vel` | `velocityrandom` `min = max = "50 0 0"`，对象旋转 90° | 两组速度方向都是世界 +y |
| `w-grav` | `movement` `gravity "0 −100 0"`，`flags 0` 与 `flags 1` 各一组，对象旋转 90° | 本地 `flags 0`：重力随对象转；本地 `flags 1`、世界两组：沿世界 −y |
| `w-vortex` | `vortex` 轴缺省 z，对象绕 x 旋转 | 世界系统轴固定，本地系统轴随对象转 |
| `w-ptr` | 世界系统 + 指针跟随，对象 `scale 2` | 出生在光标处，形状半径 100（指针点 3×3 是单位阵，不乘 `W`）；本地对照组 200 |

### 最想用实测核对的读码结论
1. JSON 控制点的 `angles` 不起作用（`cp-angles`）。语料里 18 处，影响能力表。
2. `controlpointattract` 的 `flags` 缺省是 2（钳制开），以及 `origin` / `offset` 都不起作用（`a-default`、`a-origin`）。
3. 指针分支丢弃 `offset`、不应用 `instanceoverride`，反投影不钳制（`ptr-offset`、`ptr-io`、`ptr-out`）。
4. `g_PointerPosition` 与 `ctx+0x8c/0x90` 的关系和 y 方向（指针换算核对）。
5. 世界空间下发射器 `origin` 不经 `W`（`w-origin`）。
6. 本地系统控制点 0 的角度不作用到出生点，但作用到 `velocityrandom`（`cp0-angle`）。
7. `controlpointattract` 乘 `k`（`a-k`）。
