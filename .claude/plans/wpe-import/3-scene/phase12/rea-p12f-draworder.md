# REA：P12f 步骤 0 —— puppet 绘制顺序的重排与裁切命令表（WPE 2.8.42 `wallpaper64.exe`）

> 读码代理产出。只做静态分析，没有运行、附加或改动 WPE。
> 置信度：
> - **静态确认**：汇编直接看到。
> - **推断**：由代码推出，但缺一环（没实测、某个库函数的身份按形态认定、后果靠 CRT / D3D 行为推）。
> - **未知**：查到某处为止，没有结论。
>
> 地址以 `0x140000000` 为基址。汇编、字符串只当数据看。
> 结构叫法沿用 [rea-p12-mdl](rea-p12-mdl.md) / [rea-p12-runtime](rea-p12-runtime.md)：**L** 图像层、**P** = `L+0x4b8` puppet 运行时、**A** mdl 动画记录（`AL+0x128`）、**AL** 动画层、**K** = `AL+0xf8` 时钟；mdl 拷贝在 `P+0x008..+0x228`，所以 `P+0x1f0` = mdl+0x1e8 = MDLS 每骨骼绘制顺序基数（i32 向量，下文记作 `base[]`）。**节点** = `P+0x298` 向量里的 0x1c 字节绘制组节点；**位置** = 节点在 `P+0x298` 里的下标；**项号** = 节点在可选块 2 组表里的下标（`节点+0x14`）。

## 方法

- **分析副本**：`ignore\p9\rea\wallpaper64.exe`（2.8.42）。REA 的已有快照 `ignore\p12\rea\mdl\wallpaper64-2.8.42-p12-mdl.rea-snapshot` 打不开（`evidence_integrity_mismatch`：分析配置摘要不同），重新做 Ghidra 分析以前就超时过，所以没开 REA，全部来自全量反汇编 `ignore\p4\rea\wp.asm`。
- **复用的脚本**：`ignore\p12\rea\mdl\` 的 `slice.py` `fn.py` `pe.py` `xr.py` `gall.py` `grepfn.py` `f32.py` `ptr.py`，拷到 `ignore\p12\f\rea\`（目录深度相同，路径不用改）；`mdl12.py` 按路径引用。
- **本轮新写的脚本**（`ignore\p12\f\rea\`）：`vt.py`（打印虚表槽）、`sl_order.py` / `sl_order2.py`（按本文读码对 `3577990983` 的 `sl_puppet` 逐帧模拟重排）、`order_cases.py`（按本文读码预测 `p12-order` / `p12-order2` 每个 puppet 先画哪组，对照 p12-REPORT 第 7 节）。
- **本轮新存的汇编**（`ignore\p12\f\rea\asm\`）：
  - `draworder_14020b720.asm`：`FUN_14020b720` 全函数（已有摘录只到 `0x14020bbfc`）；
  - `reorder_140205360.asm`：蒙皮矩阵循环尾 + 重排段 `0x140205507`–`0x14020566d`；
  - `imgupd_layers_1401fec00.asm`：图像层更新的 `P+0x280` 复位与逐层循环（`0x1401fec00`–`0x140200560`，含事件、播完回调、删层）；
  - `puppetgeo_nodes_14020b220.asm`：`FUN_14020ae00` 建节点、打标志、调 `FUN_14020b720`；
  - `sort_1402154d0.asm`：`std::stable_sort` 入口；`sorthelpers_1401fac30.asm`：两个比较器、`is_sorted_until`、插入排序、标量插值、GPU 网格的 Map / Unmap 虚函数、两个向量小函数；
  - `segresize_140218fd0.asm`：裁切段结构的缺省值；`emitnormal_14020c710.asm`（含 `0x14020c850`）与 `emitclip_14020cab0.asm`：建段索引缓冲、写命令；
  - `recchain_140261fc0.asm`：加载期记录 `+0x48`（嵌套父记录）的计算；`clipdraw_140208870.asm`：绘制侧读命令表（已有摘录的拷贝，便于对照）。
- **沿用的结论**：rea-p12-mdl 7.2–7.4、9.2、9.4；rea-p12-runtime 1.3、2、5.1、6.4；rea-p12e 第 4、5 节；p12-REPORT 一·7、二·3。

## 概括

| # | 问题 | 结论 | 置信度 |
|---|---|---|---|
| 1 | 节点怎么排序 | **重排时**用 MSVC **`std::stable_sort`**（`0x1402154d0`：≤ 32 个插入排序，否则带临时缓冲的归并，栈上内联 512 个指针），作用在**节点指针向量** `P+0x298` 上、**原地**；比较器 `0x1401fac30` = `a->key < b->key`（`+0x0` 的 **有符号 i32、严格小于**），**只比键**，不比骨骼、起点、项号。所以并列时**保持排序前的顺序**。这和 `meshDrawOrder`（`std::sort`，> 32 个时不稳定）**不是同一个算法**，不能复用。 | 静态确认 |
| 1b | `FUN_14020b720` 排不排节点 | **不排**。它只在网格 0 有 v23 记录时工作（没有记录直接返回），读当前节点顺序建**裁切命令表**（`P+0x430`）与每段一块索引缓冲；它内部另外用 `std::stable_sort` + 比较器 `0x1401fac40`（`a.+4 < b.+4`）给**每条记录的段结构**按「最小目标位置」排序。加载时（`FUN_14020ae00`）节点**按组表顺序**建好就直接交给它，**加载时不按基数排序**。 | 静态确认 |
| 2 | 重排时的键 | `key = cvttss2si( (float)(节点+4) + P+0x280[骨骼] )`。`节点+4` = 加载时的 `base[骨骼] + 组偏移`（i32 加法）；`P+0x280` 每帧（网格 0 有 bit3 时）先复位成 `(float)base[i]`，再被各层改写。全程 float32：`cvtdq2ps` 把 i32 转 float（就近舍入），`addss` 相加，`cvttss2si` **向零取整**成 i32（NaN / 越界得 `0x80000000`）。**基数会算两次**：覆盖层（权重恰好 1、非加法）把 `P+0x280` 整个换成轨道值，基数只在 `节点+4` 里出现一次；但没被写到的骨骼、混合层、加法层，`P+0x280` 里还带着复位来的基数（权重 0 的层得 `2·base + 偏移`）。 | 静态确认 |
| 2b | 排序前的顺序 / 何时重写 | 重排**只在本帧有层写过绘制顺序**（`r14 & 4`）时做：先按当前节点顺序重算全部键，再 `std::is_sorted_until`（`0x140216a40`，`cmp(后, 前)`）——**当前顺序已经是非降序就什么都不做**（不排、不写 GPU、不重建命令表）；否则 `stable_sort` 原地排、`Map(WRITE_DISCARD)` 整块重写主索引缓冲（按新顺序拼接各节点的 `[起点, 起点+数)`，源是 CPU 上的文件索引）、再调 `FUN_14020b720` 重建裁切命令表。排序前的顺序 = **上一次真正排过之后的顺序**（跨帧保留），从没排过时 = 组表顺序。**所以并列的次序依赖历史**：`sl_puppet` 的动画 `h` 逐帧走三圈的 180 帧里有 44 帧（都在第二圈起）、`眼` 900 帧里有 59 帧，和「每帧从组表顺序重新稳定排序」不同。GPU 索引缓冲初始是**文件顺序**，在第一次真正重排之前和节点顺序可以不一致（`frac_order` 就是这样：组表 B 在前、键相同、从不重写，画的是文件顺序 A 在前）。 | 静态确认；语料模拟与 p12-order 全部 8 个 puppet 的实测吻合 |
| 2c | 帧内时机 | 都在图像层更新 `FUN_1401fdf90` 里：复位 `P+0x280` → 逐层循环写 `P+0x280`、置 `r14 & 4` → 派发 MDLA 事件 → 播完回调 → 删标了 `0x10000000` 的层 → 约束 / 物理 / 父链 / 蒙皮矩阵 → **重排**（`0x140205507`）→ 挂点子对象等。脚本 `update` 在全部对象更新之后，所以脚本对层的改动**下一帧**才影响顺序；事件与播完回调里删层、改层同样从下一帧起才进 `P+0x280`。重排当场 Map 写 GPU，同一帧的绘制就用新顺序。 | 静态确认（地址先后 + rea-p12-runtime 第 2 节） |
| 3 | `A+0x108` 轨道的写入 | 每个**可见**层（`AL+0xd0 & 1`）、动画有这一段（`size(A+0x108) > 0`）时，对 `i < size(A+0x108)` 且**该骨骼 TRS 轨道 `(A+0x90[i].flags & 3) != 1`** 的骨骼写，`v = A+0x108[i][lo]`（**只取 lo 帧，三种叠法都不插值**）：**覆盖**（`w == 1.0f` 且非加法）`cur = v`；**混合** `cur = (1−w)·cur + v·w`（`FUN_140178e00` 的运算顺序）；**加法** `cur = clamp(cur + (v − (float)base[i])·w, min(cur, v), max(cur, v))`。`w` = `FUN_14026c8b0` = blend × 淡入淡出。**只要写了一根骨骼就置 `r14 |= 4`**：权重 0、blend 0、暂停、单次层播完停在末帧，都照写、照置位；只有不可见层跳过。 | 静态确认 |
| 3b | 没有 bit3 | 这段没有任何门控：`P+0x280` 在没有 bit3 时只 `clear()`（`0x1400efc50`，`end = begin`），起点仍是构造时的空指针，第一次写就写空指针附近（覆盖 `0x1401ff303`、混合先读 `0x1401ff7e6`、加法先读 `0x1401fffe0`）→ **WPE 崩溃**。 | 静态确认（写入点）；崩溃为推断（P 构造时把 `+0x280` 清零） |
| 4 | 没有层写绘制顺序的帧 | 不重算键、不排、不写：GPU 索引缓冲、节点顺序、裁切命令表**都保持上一次重排的结果**，**不回到**文件顺序 / 组表顺序。带轨道的层被隐藏、被 `destroyAnimationLayer` / 单次层删掉之后都是这样；再出现写入时，从那个保留的顺序开始比。 | 静态确认 |
| 5 | 模型对象 | 不处理：模型更新 `0x14021c480`–`0x140222040` 里没有读 `A+0x108`（只有 `A+0x138` 变形），比较器、`stable_sort` 入口、`FUN_14020b720` 只被图像层引用。 | 静态确认（有界搜索） |
| 6 | 裁切命令表（`FUN_14020b720`） | 沿**当前节点顺序**的位置走：不在任何 `list1` 的节点进「普通段」累积；目标节点（`list1`）不进普通段；**遮罩节点在本记录「末遮罩位置」那一格触发**：先把累积的普通段（含这个遮罩节点）落成一段，再按段结构的排序（最小目标位置升序、稳定）对每条末遮罩位置等于这一格的记录各落一个裁切段。裁切段的**遮罩 = 位置区间 [首遮罩位置, 末遮罩位置] 里除本记录目标以外的全部节点**（不只是 `list2`），**目标 = 本记录 `list1` 的节点按当前顺序拼成一段**（所以 `[74, 75]` 是一次目标绘制）。末遮罩位置沿嵌套父记录链（记录 `+0x48`）取最大。命令流是 u32：`0` 普通段；`1, 记录` 裁切；`2, n, (记录_k, 遮罩段_k)×n, 记录` 嵌套裁切；段号按出现顺序从 0 起，每段一块自己的动态索引缓冲。和 p12-REPORT 二·3 的实测、现有 `buildClipping` 一致；`buildClipping` 只差「位置 = 组号」这一个假设。 | 静态确认 |
| 6b | 其它细节 | `节点+0x18` 标志只在 `FUN_14020b720` 里用（bit0 目标、bit3 遮罩、bit2 记录 flags bit3 的目标），重排不看；`+0x14` 项号只用于查「在不在某记录的 `list1` / `list2`」；`+0x0` 键加载时为 0、只在重排时写；主索引缓冲的 Map 是 `WRITE_DISCARD` 并把绘制索引数设成总数，节点没铺满时剩下的内容未定义（语料都铺满）。记录 flags bit2（遮罩不再作普通段画）、bit3（目标在自己的位置落段，那条路径有一处 WPE 缺陷）语料 0 处。 | 静态确认；bit3 路径的缺陷为推断 |

---

## 1. 加载：节点与初始顺序（`FUN_14020ae00`，`0x14020b24d`–`0x14020b672`，静态确认）

```c
mesh0 = P+0x18[0];
if (!(mesh0.flags & 8) && mesh0.records 为空) { 释放全部节点; P+0x298 清空; goto call_b720; }   // 0x14020b24d–0x14020b2b8
释放旧节点; P+0x298 清空; reserve(组数);
for (item = 0; item < 组数; item++) {            // 组表 = 可选块 2，mesh0+0xa8，每项 {u32 骨骼, i32 偏移, u32 起点, u32 数}
    n = new 0x1c;
    n->key   = 0;                                // +0x00
    n->base  = P+0x1f0[g.bone] + g.offset;       // +0x04，i32 加法；P+0x1f0 不检查下标（基数数组为空时读空指针）
    n->bone  = g.bone;   n->start = g.start;  n->count = g.count;   // +0x08 / +0x0c / +0x10（+0x10 先写 1 再覆盖）
    n->item  = item;                             // +0x14
    n->flags = 0;                                // +0x18
    P+0x298.push_back(n);                        // 组表顺序
}
for (r of mesh0.records) {                       // 0x14020b5c0–0x14020b669；按项号下标，此时位置 == 项号
    for (i of r.list1) P+0x298[i]->flags |= 1;
    for (i of r.list2) P+0x298[i]->flags |= 8;
    if (r.flags & 8) for (i of r.list1) P+0x298[i]->flags |= 4;
}
call_b720: FUN_14020b720(L);                      // 0x14020b672：不排序
```
- 两个比较器、`stable_sort` 入口都不在这里出现（`xr.py 1401fac30 1401fac40 1402154d0`：只有重排段和 `FUN_14020b720` 引用）。**加载后节点顺序 = 组表顺序**。
- GPU 网格（`L+0x490`）在同一函数前面用网格 0 的文件索引建（rea-p12-mdl 9.2），bit3 时索引缓冲是动态的。**初始 GPU 索引 = 文件顺序**。语料 92 个网格的组都是「起点连续、首尾相接」，组表顺序和文件顺序一致；p12-order2 的 `frac_order` 故意把组表倒过来，两者才不同。

## 2. 每帧：`P+0x280` 的复位与写入（`FUN_1401fdf90`，静态确认）

### 2.1 分配与复位
- 第一次更新（骨骼数与 `P+0x2c8` 大小不等）的重建块里：网格 0 有 bit3 → `P+0x280.resize(骨骼数)`（`0x1401aa940`，新元素 0）；没有 → `P+0x280.clear()`（`0x1400efc50`，只把 `end` 拉回 `begin`，不释放、起点仍是空指针）。`0x1401feb12`–`0x1401feb36`。
- **每帧**（`0x1401fec12`–`0x1401fec8b`，在逐层循环之前）：
  ```c
  if (mesh0.flags & 8)
      for (i = 0; i < size(P+0x1f0); i++) P+0x280[i] = (float)(int)P+0x1f0[i];   // cvtdq2ps
  ```
  循环次数取基数数组的长度（不是骨骼数）。
- 同时 `r14 = 0`（`0x1401feca6`，`[rbp−0x50]` 也清 0）。`r14` 在逐层循环里累积：bit0 = 已处理过一个可见层，bit1 = 有层播完待派发，**bit2 = 有层写过绘制顺序**。

### 2.2 逐层写入
层循环 `0x1401fed50`–`0x1402001d1`，每层：`if (!(AL+0xd0 & 1)) continue;`（不可见跳过，**唯一的跳过条件**）→ 推进时钟（`0x1401a9f60`，暂停只是不推进）→ `FUN_140170580` 取 `lo` / `hi` / `frac` → 播完检测 → `w = FUN_14026c8b0(AL)`（blend × 淡入淡出，rea-p12-runtime 5.1）→
```c
sil = !(w == 1.0f /*ucomiss，NaN 算不等*/ && !(AL+0xd0 & 2));   // 0x1401fee15–0x1401fee2b：sil = 0 走覆盖
```
三条路径最后都处理 `A+0x108`（覆盖 `0x1401ff280`–`0x1401ff322`，混合 `0x1401ff762`–`0x1401ff82c`，加法 `0x1401fff35`–`0x1402001b9`）：
```c
n = size(A+0x108);                    // 8 字节元素：每骨骼一个 float*，指向 (length+1) 个 float
for (i = 0; i < n; i++) {
    if ((A+0x90[i].flags & 3) == 1) continue;      // TRS 轨道表，16 字节一项；只跳过「bit0 有、bit1 无」
    v   = A+0x108[i][lo];                          // 只取 lo
    cur = P+0x280[i];                              // 不检查 i < 骨骼数
    if (覆盖)      cur = v;                                            // 0x1401ff2e6–0x1401ff303
    else if (混合) cur = (1 − w)·cur + v·w;                            // FUN_140178e00(a=cur, b=v, f=w)
    else {         // 加法，0x1401fff9d–0x14020019a
        d  = (v − (float)P+0x1f0[i]) · w;           // 减的是骨骼基数（不是 1）
        s  = d + cur;
        hi = (cur > v) ? cur : v;                   // 相等取 v
        lo_ = (v > cur) ? cur : v;
        t  = (hi > s) ? s : hi;
        cur = (lo_ > t) ? lo_ : t;                  // = clamp(cur + (v − base)·w, min(cur, v), max(cur, v))
    }
    P+0x280[i] = cur;
    r14 |= 4;                                       // 0x1401ff2ff / 0x1401ff809 / 0x140200196
}
```
- 浮点：`FUN_140178e00` 是 `t = 1 − f; b·f; t·a; t + b·f`，即 `fround(fround(fround(1 − w)·cur) + fround(v·w))`；加法是 `fround(fround(v − fround(base))·w)`、`fround(d + cur)`。
- 和骨骼透明度那一行（rea-p12-runtime 6.4）同构，只是加法的「静止值」是骨骼基数而不是 1。`(flags & 3) != 1` 的门和骨骼透明度相同；注意加载期被或上 `3` 的骨骼（文件 flags bit1 且 `bone+0xd4 == −1`，物理路径）**照写**，只有单纯「缺失」（`1`）的不写。
- 覆盖层不看 `cur`，所以**排在后面的覆盖层把前面所有层的绘制顺序都盖掉**（语料 `sl_puppet` 的 86 条轨道全都 `flags & 3 != 1`）。
- 各种层状态：
  | 层 | 写不写 `P+0x280` | 置不置 `r14 & 4` |
  |---|---|---|
  | 不可见 | 不写 | 不置 |
  | blend 0 / 淡变到权重 0 | 写（混合得 `cur`、加法得 `cur`，值不变） | **置** |
  | 暂停 | 写（`lo` 不动） | 置 |
  | 单次层播完、停在末帧 | 写 | 置 |
  | `playSingleAnimation` 的层播完那一帧 | 本帧照写（删层在写之后），下一帧起不在层表 | 本帧置 |
  | 动画没有这一段（`size(A+0x108) == 0`） | 不写 | 不置 |
  | 全部骨骼 `(flags & 3) == 1` | 不写 | 不置 |

## 3. 重排（`0x140205507`–`0x14020566d`，静态确认）

在蒙皮矩阵循环（`0x140205360`–`0x1402054d6`，`P+0x2f8 = 模型矩阵 · 绑定逆`）之后，`r14` 从 `[rbp−0x50]` 取回（`0x14020530b`）。
```c
if (r14 & 4) {
    for (n of P+0x298)                                      // 当前顺序；0x140205540–0x140205572
        n->key = cvttss2si( (float)n->base + P+0x280[n->bone] );   // cvtdq2ps + addss + cvttss2si
    if (is_sorted_until(begin, end, cmp) != end) {          // 0x140216a40：对相邻 (前, 后) 判 cmp(后, 前)
        stable_sort(begin, end, cmp);                       // 0x1402154d0；cmp = 0x1401fac30
        mesh0 = P+0x18[0];  dst = null;
        if (L+0x490->vt[0x20](&dst, (int)mesh0.ibBytes / 2)) {       // Map(WRITE_DISCARD) 主索引缓冲，并把绘制索引数设成总数
            src = mesh0.indices;                                       // mesh0+0x58，CPU 上的文件索引
            for (n of P+0x298) { memcpy(dst, src + n->start, n->count·2); dst += n->count; }
            L+0x490->vt[0x28]();                                       // Unmap
        }
        FUN_14020b720(L);                                   // Map 失败也调
    }
}
// cmp(a, b) = a->key < b->key        // 0x1401fac30：mov eax,[rdx]; cmp [rcx],eax; setl al
```
- **键**：`(float)(base[骨骼] + 偏移) + P+0x280[骨骼]`，在 float32 上相加后向零取整。负数照样向零（`−0.9 → 0`、`−1.5 → −1`），NaN 与 `|x| ≥ 2³¹` 得 `−2147483648`。没有 double。
- **比较**：有符号 i32 严格小于，只比键。`is_sorted_until` 用的是同一个比较器，所以「已排好」= **非降序**（相等算排好）。
- **「只在顺序变化时重写」**就是这里：`is_sorted_until` 到末尾 ⇔ 稳定排序是恒等变换 ⇔ 顺序不变。比较对象是**当前节点顺序**（上一次排过的结果），不是 GPU 缓冲的内容、也不是上一帧的键。
- **写什么**：只写一块主索引缓冲（GPU 网格虚表 `0x140486f38`：`+0x20` = `Map(..., D3D11_MAP_WRITE_DISCARD)` 并把 `mesh+0x2c`（整网格的绘制索引数）设成参数，`+0x28` = `Unmap`；ID3D11DeviceContext 虚表 `+0x70` / `+0x78`）。整块重写，不是只写变了的段。有 v23 记录时实际画的是 `FUN_14020b720` 建的分段缓冲（第 5 节），主缓冲写了也不画。
- 实测「只在顺序变化的帧多两个 API 事件」= 这一对 Map / Unmap。

## 4. 排序算法（静态确认）

- `0x1402154d0` 是 MSVC `std::stable_sort<Node**, bool(*)(Node*, Node*)>`：`count = last − first`；`count ≤ 32` 调 `_Insertion_sort_unchecked`（`0x14019fde0`，比较器常量传播成 `0x1401fac30`）；否则 `_Optimistic_temporary_buffer` 申请 `count − count/2` 个指针（栈上内联 4096 字节 = 512 个，不够时 `operator new(nothrow)` 逐次减半），再调 `_Stable_sort_unchecked`（`0x14019fec0`：`≤ 32` 插入排序，否则两半递归 + 缓冲归并）。
- 插入排序 `0x14019fde0`：`if (cmp(val, *first)) 整段后移、放到最前; else { for (prev = hole−1; cmp(val, *prev); --prev) 后移; }`——严格小于才移动，稳定。
- 稳定排序的结果只由「输入顺序 + 键」决定，和内部是插入还是归并无关：**按键升序，键相等的保持输入（= 当前节点）顺序**。复刻时用任何正确的稳定排序即可（JS `Array.prototype.sort` 自 ES2019 稳定）。
- **不是 `meshDrawOrder` 的算法**：那是 `std::sort`（内省排序，> 32 个元素时不稳定）。绘制组用的是 `stable_sort`，`sl_puppet` 78 个组、一帧最多 28 处并列，用 `std::sort` 的移植会把并列打乱。

## 5. `FUN_14020b720`：裁切命令表与分段索引（`draworder_14020b720.asm`，静态确认）

### 5.1 入口
```c
if (!P || !P+0x8) return;
mesh0 = P+0x18[0];
if (mesh0.records 为空) return;            // 0x14020b779：没有 v23 记录什么都不做（也不清 P+0x430）
P+0x430.clear();                           // 命令表（u32 向量）
R = 记录数;
segs = vector<Seg>(R);                     // 0x40 字节：{+0 rec, +4 minTarget = 0x7fffffff, +8 first = −1, +0xc last = −1,
                                           //            +0x10 vector<int> masks, +0x28 vector<int> targets}（0x140218fd0）
map  = unordered_map<int,int>();           // 位置 → 记录（FNV-1a 散列）
S    = unordered_set<int>();               // 记录 flags bit2 的遮罩位置
```

### 5.2 第一遍：逐记录扫位置（`0x14020b840`–`0x14020bc2d`）
```c
for (r = 0; r < R; r++) {
    seg = &segs[r]; seg->rec = r; rec = mesh0.records[r];
    for (pos = 0; pos < N; pos++) {                       // N = 节点数，位置按当前顺序
        n = P+0x298[pos];
        if ((n->flags & 1) && find(rec.list1, n->item)) {  // 按项号查
            seg->targets.push_back(pos);
            seg->minTarget = min(seg->minTarget, pos);
            map[pos] = r;                                  // 同一节点在多条记录的 list1 里时后写的胜出
        }
        if (find(rec.list2, n->item)) {
            if (seg->first < 0) seg->first = pos;
            seg->last = pos;
            if (rec.flags & 4) S.insert(pos);
        }
    }
    for (pos = 0; pos < N; pos++)                          // 0x14020baa0–0x14020bc0d
        if (seg->first <= pos && pos <= seg->last && !find(seg->targets, pos))
            seg->masks.push_back(pos);                     // 区间里除本记录目标外的全部位置
}
```

### 5.3 嵌套链（`0x14020bc33`–`0x14020bcad`）
```c
for (r = 0; r < R; r++)
    for (j = records[r].parent; j != −1; j = records[j].parent)   // 记录 +0x48
        segs[r].last = max(segs[r].last, segs[j].last);           // 下标按记录号（还没排序）
```
记录 `+0x48`（加载末尾 `0x14026203c`–`0x14026229c`，`recchain_140261fc0.asm`）：对每条 `list2` 非空的记录 d，找**第一条** b ≠ d 使 `d.list2` 的每一项都在 `b.list1` 里，`d.+0x48 = b`，否则保持缺省 −1；随后沿链用 `unordered_set` 查环（成环时跳到 `0x1402622c9`，没细读，推断报错）。即「d 的遮罩本身被 b 裁切」。语料 5 个网格都是 −1。

### 5.4 段排序（`0x14020bcbd`–`0x14020bdae`）
`std::stable_sort(segs, cmp2)`，`cmp2 = 0x1401fac40`：`a.minTarget < b.minTarget`（有符号）。`≤ 32` 插入排序（`0x140216ac0`，按值移动 0x40 字节），否则缓冲归并（内联 64 个）。并列按记录号。

### 5.5 沿位置走（`0x14020be4f`–`0x14020c57a`）
```c
normal = [];  counter = 0;
for (pos = 0; pos < N; pos++) {
    n = P+0x298[pos]; f = n->flags;
    if (f & 1) { if (!(f & 8) && !(f & 4)) continue; }           // 纯目标：跳过（只在裁切段里画）
    else if (!(f & 4) && !S.contains(pos)) normal.push_back(pos); // 非目标进普通段，包括遮罩节点
    if (f & 8) {                                                  // 遮罩节点（0x14020c051）
        for (seg of segs /*已排序*/) {
            if (records[seg.rec].flags & 8) continue;
            if (seg.last != pos) continue;
            if (normal 非空) { emitNormal(counter++, normal); P+0x430.push(0); normal.clear(); }
            emitClip(seg.rec, &seg, seg.targets);
        }
    } else if (f & 4) {                                           // 记录 flags bit3 的目标（0x14020c11e）
        if (!map.contains(pos)) continue;
        list = [pos];
        for (k = pos + 1; k < N; k++) {                           // 缺陷：每次都查 map[pos] 而不是 map[k]
            if (!map.contains(pos) || map[pos] != map[pos]) break;   // 恒不成立 → 收进 pos..N−1 全部位置
            list.push_back(k);
        }
        seg = segs 里 rec == map[pos] 的那个（线性查）;
        if (找到) { if (normal 非空) { emitNormal…; push 0; clear; } emitClip(map[pos], seg, list); }
    }
}
if (normal 非空) { emitNormal(counter++, normal); P+0x430.push(0); }
```
- bit3 路径里内层查找用的散列和键都是外层的 `pos`（`0x14020c2a0` 起：`r8 = r14 & mask`，`r14` 恒为 `hash(pos)`；`cmp r15d, [rax+0x10]`，`r15d` 是外层位置），所以目标表是 `pos` 到末尾的全部位置——推断是 WPE 源码把 `find(k)` 写成了 `find(pos)`。语料记录 flags 全 0，走不到。

### 5.6 落段与命令格式（`0x14020c710` / `0x14020c850` / `0x14020cab0`）
```c
emitNormal(idx, positions):                      // 0x14020c710
    total = Σ P+0x298[p]->count;
    mesh->vt[0x38](idx);  mesh->vt[0x30](idx, 0, total, 2);   // 第 idx 块段索引缓冲：先释放再建（动态）
    if (mesh->vt[0x50](idx, &dst, total)) {                     // Map(WRITE_DISCARD)，并记段的绘制数
        for (p of positions) { n = P+0x298[p]; memcpy(dst, mesh0.indices + n->start, n->count·2); dst += n->count; }
        mesh->vt[0x58](idx);
    }
emitClip(r, seg, targets):                       // 0x14020cab0
    chain = []; for (j = records[r].parent; j != −1; j = records[j].parent) chain.push(j);
    emitNormal(counter, seg->masks);   maskSeg[r]   = counter++;   // 遮罩段
    emitNormal(counter, targets);      targetSeg[r] = counter++;   // 目标段
    if (chain 空) P+0x430.push(1);
    else { P+0x430.push(2); P+0x430.push(chain.length);
           for (j of chain) { P+0x430.push(j); P+0x430.push(maskSeg[j]); } }   // 还没落段的 j 取 0（operator[] 缺省）
    P+0x430.push(r);
```
- 段号在一次 `FUN_14020b720` 里从 0 连续编号，普通段与裁切段共用；每次重建都重新建全部段缓冲（实测「每段一块自己的索引缓冲、起点 0、资源号按绘制顺序递增」）。

### 5.7 绘制侧（`clipdraw_140208870.asm`，`0x140208890`–`0x140208beb`，摘要）
`c = 0`；读一个命令：`0` → 用基础材质画段 `c`，`c += 1`；`1` → 读记录 `r`（`r ≥ 记录数` 时跳过但 `c += 2`），清遮罩 RT 并画段 `c`（遮罩材质，`FUN_14020d6a0`），再用 `P+0x428`（`CLIPPINGTARGET`）画段 `c+1`（目标材质的 `+0x1f0` 取记录 `+0x40`），`c += 2`；`2` → 读 `n` 与 `n` 对 `(j, 遮罩段)`，第一对清 RT、之后叠画，再不清 RT 画自己的遮罩段 `c`，目标段 `c+1`，`c += 2`。和 p12-REPORT 二·3.2 的六次绘制一一对应。

### 5.8 对照
- **实测**（`3491865410` 眼睛，组 0–1 遮罩、组 2 / 3 目标、组 4–23 普通）：位置 1 是两条记录的末遮罩位置 → 落普通段 {0, 1}（命令 0）→ 记录 0 的裁切（遮罩 {0, 1}、目标 {2}）→ 记录 1（普通段已空，不落）→ 位置 2、3 纯目标跳过 → 4–23 末尾落一段。与 837 / 839–878 / 881–920 / 937 完全一致。
- **`buildClipping`（`apps\wpe-scene\src\compile\puppet.ts`）**：区间遮罩、末遮罩位置触发、嵌套链取最大、按最小目标稳定排序、遮罩节点进普通段、目标不进普通段，都和本节一致。唯一的差别是它把**组号当位置**（`groups[p]`、`record.list1.includes(p)`）——只在节点顺序 = 组表顺序时成立。支持绘制顺序时要改成按当前节点顺序：位置 `p` 的节点是 `order[p]`，成员判断用 `order[p]`（项号），段内容取 `groups[order[p]]`，每次重排后重建。
- **`sl_puppet`**（`list1 [74, 75]`，`list2 [35, 37, 39, 41, 63]`）：`list2` 在组表里就不相邻，遮罩段是位置 35–63 里除目标外的全部 29 组；目标两组拼成**一次**目标绘制（回答 p12-REPORT 二·3.5 第一问）；裁切段落在第 63 格之后，不在目标自己的位置。

## 6. 没有层写绘制顺序的帧（静态确认）
`r14 & 4` 为 0 时第 3 节整段跳过：不重算键、不排、不 Map、不调 `FUN_14020b720`。`P+0x280` 照样每帧复位成基数（第 2.1 节），但没人读它。所以 GPU 主索引缓冲、`P+0x298` 的顺序、`P+0x430` 与段缓冲都保持上一次重排时的样子，**不会回到文件顺序或组表顺序**。只有几何重建（`L` 虚函数 `+0xb0` 再调 `FUN_14020ae00`）才把节点恢复成组表顺序、GPU 索引恢复成文件顺序（什么时候会重建没查，推断只在加载 / 重新加载时）。

## 7. 模型对象（静态确认，有界搜索）
模型更新 `FUN_14021c480`（`0x14021c480`–`0x140222040`）里找不到 `add rcx, 0x108` / `[reg+0x108]` 形式的动画记录访问（只有 `[rbx+0x138]` 变形），也没有引用 `0x1401fac30`、`0x1401fac40`、`0x1402154d0`、`0x14020b720`。和已有结论一致：模型不处理绘制顺序轨道。

## 8. 语料与实测核对

### 8.1 p12-order / p12-order2（`order_cases.py`，按本文的模型预测先画的组）
| puppet | 预测 | p12-REPORT 实测 |
|---|---|---|
| `ord_anim` | lo 20 时重写成 B 在前，回绕到 lo 0 再写回 A | 前半 A（lo 19）、后半 B（lo 20），只在变化帧多两个事件 |
| `ord_static_rev`（没有轨道） | 从不重写，文件顺序 A | A |
| `ord_nobit3`（动画没有这一段） | 不写，A | A |
| `ord_offset` | 不写，A | A |
| `off_track` | 键 −60+100 = 40 < 50，已排好，A | A |
| `tie_trunc` | 键 50 / 50，已排好，A | A |
| `frac_order`（组表 B 在前） | 节点 [B, A] 键 50 / 50 已非降序，**从不重写**，GPU 仍是文件顺序 A | A |
| `base_track` | 键 100 / 50，第一帧就重写成 B 在前 | B |

8 个全部吻合。`frac_order` 的「A 在前」不是并列规则，而是「没重写」：GPU 停在文件顺序。

### 8.2 `3577990983` 的 `sl_puppet`（`sl_order.py` / `sl_order2.py`）
- 网格 0 标志 `0x100c`（bit3），78 个组（偏移全 0，组表 = 文件顺序），86 根骨骼的基数 −1700 … 8600（−1700 有 3 个、3300 有 5 个等），一条记录。
- 两个动画都有绘制顺序段（`h` loop 30 fps 长 60、`眼` loop 30 fps 长 300），86 条轨道全部 `flags & 3 != 1`；第 0 帧轨道值使键恰好等于 `base + 偏移`，即**轨道存的是相对基数的增量**（0 = 不动），覆盖层下 `key = base + 偏移 + v`。
- 只用一个覆盖层、`lo` 逐帧走三圈：`h` 每圈在 lo 22、56 重写；`眼` 每圈在 16、135、151、191、223、230、232 重写；一帧最多 28 处并列。
- **历史相关**：`h` 第二圈 lo 0 起，位置 35 / 36 是组 36、35（键都是 3300，组 35 是遮罩组），而从组表顺序重新稳定排序是 35、36。180 帧里 44 帧不同，`眼` 900 帧里 59 帧不同。**实现必须跨帧保留节点顺序**。
- 场景里这个 puppet 实际挂了哪些层、blend 多少没核（没读 `scene.json`），上面的模拟只说明算法性质。

## 对实现的含义

### 数据
```ts
interface DrawNode {
  key: number;     // i32，只在重排时写
  base: number;    // i32：drawOrder[bone] + offset（加载时算一次，| 0）
  bone: number; start: number; count: number;
  item: number;    // 组表下标
  flags: number;   // 1 目标 / 8 遮罩 / 4 记录 flags bit3 的目标
}
// 只有 mesh0.flags & 8 或 mesh0 有 v23 记录时才建；顺序 = 组表顺序，加载时不排序
let order: DrawNode[];                 // 跨帧保留（重编译时按 WPE 恢复成组表顺序即可）
let indices: Uint16Array;              // 初值 = 文件索引（不是按 order 拼接）
let clip = buildClipping(order);       // 有记录才建；没有记录时 null
```
网格 0 没有 bit3 却有绘制顺序轨道（可见层）时 WPE 崩溃，照「崩溃组合照报」处理，不复刻。

### 每帧（puppet 推进里，和骨骼透明度同一个逐层循环）
```ts
const f = Math.fround;
const p280 = state.drawOrderValues;                       // Float32Array(骨骼数)，只在 bit3 时存在
if (meshFlags & 8) for (let i = 0; i < drawOrder.length; i++) p280[i] = f(drawOrder[i]);
let wrote = false;
for (const L of layers) {
  if (!L.visible) continue;
  /* 推进、lo/hi/frac、播完检测、w = weight(L) ——同 P12a */
  const A = L.animation; if (!A.drawOrderTrack) continue;
  const override = w === 1 && !L.additive;                 // w 是 float32
  for (let i = 0; i < A.drawOrderTrack.length; i++) {
    if ((A.trackFlags[i] & 3) === 1) continue;
    const v = A.drawOrderTrack[i][lo];                     // 不插值
    const cur = p280[i];
    if (override) p280[i] = v;
    else if (!L.additive) p280[i] = f(f(f(1 - w) * cur) + f(v * w));
    else {
      const s = f(f(f(v - f(drawOrder[i])) * w) + cur);
      const hi = cur > v ? cur : v, lo2 = v > cur ? cur : v;
      const t = hi > s ? s : hi;
      p280[i] = lo2 > t ? lo2 : t;
    }
    wrote = true;
  }
}
/* 事件、播完回调、删层、约束 / 物理 / 蒙皮 ——同 P12a–e */
if (wrote) {
  for (const n of order) n.key = cvttss2si(f(f(n.base) + p280[n.bone]));
  let sorted = true;
  for (let k = 1; k < order.length; k++) if (order[k].key < order[k - 1].key) { sorted = false; break; }
  if (!sorted) {
    order.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));   // 稳定；不要用 meshDrawOrder
    indices = concat(order.map((n) => fileIndices.subarray(n.start, n.start + n.count)));
    if (records.length) clip = buildClipping(order);
    markIndexBufferDirty();                                // 只有这一帧上传
  }
}
function cvttss2si(x: number): number {
  return x !== x || x >= 2147483648 || x < -2147483648 ? -2147483648 : Math.trunc(x) | 0;
}
```
- `buildClipping` 改成吃 `order`：第 5 节的伪代码逐行照写，位置 `p` 处的节点 `order[p]`，`list1` / `list2` 查 `order[p].item`，段内容按 `order[p].start/count`。
- 时机：在 puppet 推进内、脚本之前；本帧的绘制用新顺序。脚本对层的改动下一帧才进。
- 没有写入的帧什么都不做（不要「回到文件顺序」）。

## 建议实测（按优先级）

1. **并列的历史相关**：3 个组 A、B、C（组表顺序），一个覆盖层的轨道让 B 先比 A 小（重写成 B、A），再让 A、B 相等。预期仍是 B、A（不回到 A、B）。这是复刻里唯一只能靠「跨帧保留顺序」得到的行为，`sl_puppet` 真实会遇到。
2. **权重 0 也触发重排 + 基数算两次**：组 A {骨骼 0, 起点 0, 偏移 0}、B {骨骼 1, 起点 6, 偏移 150}，基数 100 / 0，只挂一个 blend 0 的带轨道层（轨道值任意）。预期键 `2·100 + 0 = 200`、`0 + 150 = 150` → 重写，**B 在前**；若基数只计一次（100 / 150）或权重 0 不触发，都是 A 在前。
3. **混合公式**：同上的组，偏移改成 0 / 120，blend 0.5 混合、轨道 0 / 0。预期 A = 100 + (0.5·100 + 0) = 150、B = 120 → **B 在前**；若复位成 0 则 A = 100 → A 在前。
4. **加法的钳制**：组表与文件里 B 在前（B {骨骼 1, 起点 0, 偏移 75}、A {骨骼 0, 起点 6, 偏移 0}），基数 0 / 0，加法层 blend 2（blend 不钳）、轨道 A 50 / B 0。预期 A 的 `cur = clamp(0 + 50·2, 0, 50) = 50` → 键 50 < 75 → 重写，**A 在前**；不钳时 A = 100，已非降序、不重写，B 在前。
5. **隐藏 / 删除带轨道的层后保持**：`ord_anim` 在后半（B 在前）时由脚本把层 `visible` 设成 false 或 `destroyAnimationLayer`，预期一直 B 在前，不回 A。
6. **组表顺序 ≠ 文件顺序时第一次重写**：`frac_order` 加一帧让键不等再相等，验证第一次重写后 GPU 跟着节点顺序走（而不是文件顺序）。
7. **带记录 + bit3 的重排**（`3577990983` 或生成工程）：重排帧之后遮罩段 / 目标段的索引是否按新顺序重建、遮罩区间是否按新位置算（`list2` 不相邻时遮罩段含中间的组）。
8. 负键与小数：轨道 −0.9 / −1.5 → 0 / −1（向零），验证 `cvttss2si`。

## 对已有文档的更正

- **rea-p12-runtime 6.4 绘制顺序一行**：「`0x140205507` 按 `trunc(基值 + P+0x280[骨骼])` 重排」补全为：键 = `cvttss2si((float)(base[骨骼] + 组偏移) + P+0x280[骨骼])`；`P+0x280` 复位成基数，所以非覆盖情形基数计两次；加法是 `clamp(cur + (v − base[i])·w, min(cur, v), max(cur, v))`（减的是骨骼基数），混合 `(1−w)·cur + v_lo·w`；排序是 `std::stable_sort`（比较器 `0x1401fac30` 只比键），只在当前顺序不是非降序时才排、才重写，重写后调 `FUN_14020b720`。「带钳制」两处都指上面的 clamp。
- **rea-p12-mdl 7.2**：「然后 `FUN_14020b720` 排序」改为：`FUN_14020b720` **不排节点**，只建裁切命令表（没有记录时直接返回）；加载时节点保持组表顺序，不按 `mdl+0x1e8 + 偏移` 排。
- **rea-p12-mdl 7.3**：记录 `+0x48` 不是「list2 有多少项在别的 list1 里」的计数，而是**嵌套父记录下标**（第一条 `list1` 包含本记录全部 `list2` 的记录，否则 −1）；裁切命令表的建法见本文第 5 节；`P+0x430` 是 u32 命令流（`0` / `1, r` / `2, n, (j, 段)×n, r`），不是「遮罩列表」。
- **p12-REPORT 一·7 结论**「键相同时不按组表顺序」：`frac_order` 实际**从没重写**（节点顺序 [B, A] 键相同，已非降序），画的是 GPU 的文件顺序，所以测不到并列规则。并列规则是「保持当前节点顺序」（稳定排序），而当前顺序是历史的结果。
- **p12-REPORT 二·3.4 第 1 步**「加载：…按键升序稳定排序」：加载时**不排序**，节点按组表顺序；语料带记录的网格组表本来就按键有序，所以结果相同，但规则应写成「组表顺序，只有绘制顺序轨道写入时才稳定排序」。
- **p12-REPORT 二·3.5 第一问**：同一记录 `list1` 多个组时**合成一次**目标绘制（按当前顺序拼接），遮罩也只画一次。
- **p12-REPORT 二·3.2 / 3.4 第 2 步**「list2 的组画遮罩」：遮罩段是 `[首遮罩位置, 末遮罩位置]` 区间里除本记录目标外的**全部**组，`list2` 不相邻时（`sl_puppet`）会包含中间的非遮罩组；`buildClipping` 已经这样实现。

## 没查清的

1. 记录 `+0x48` 链成环时 `0x1402622c9` 做什么（推断报错终止），以及命令 2 里还没落段的父记录取到段号 0 的后果；语料 0 处。
2. 记录 flags bit3 路径的「目标收进 pos 到末尾」是读码推断的 WPE 缺陷，没实测；bit2（遮罩不画普通段）、绘制侧命令 2 的混合标志（`FUN_14020d6a0` 的两个布尔参数）没细读。
3. `L` 虚函数 `+0xb0`（几何重建，重置节点顺序）除加载外何时调用：没查。若运行中会被调（比如换纹理、改尺寸），节点顺序会回到组表顺序。
4. `P+0x280` 初值为空指针（没有 bit3 时崩溃）依赖 P 的构造把它清零，没读构造函数；`P+0x1f0` 为空（MDLS 没有绘制顺序块）而网格有 bit3 或记录时，加载就读空指针（推断崩溃）。
5. `sl_puppet` 所在场景的 `animationlayers`（几层、blend、是否加法）没读，第 8.2 节只说明算法性质。
6. 主索引缓冲 `WRITE_DISCARD` 时节点没铺满整块缓冲的情形（剩余内容未定义），语料没有。
