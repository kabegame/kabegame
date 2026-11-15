# REA：P12d-2 步骤 0 —— puppet 骨骼的脚本 API（WPE 2.8.42 `wallpaper64.exe` / `scenescript64.dll`）

> 读码代理产出。只做静态分析，没有运行、附加或改动 WPE。
> 置信度：
> - **静态确认**：汇编直接看到。
> - **推断**：由代码推出，但缺一环（例如没实测、某个分支的寄存器初值按形态认定）。
> - **未知**：查到某处为止，没有结论。
>
> exe 地址以 `0x140000000` 为基址，`scenescript64.dll` 地址以 `0x180000000` 为基址。汇编、字符串只当数据看。
> 结构叫法沿用 [rea-p12-runtime](rea-p12-runtime.md) / [rea-p12-attach-physics](rea-p12-attach-physics.md) / [rea-p12c-script](rea-p12c-script.md)：**L** 图像层、**P** = `L+0x4b8` 的 puppet 运行时、`P+0x2c8` 模型空间姿势 `Pose`、`P+0x2b0` 绑定逆、`P+0x2f8` 蒙皮矩阵 `K`、`P+0x310` 局部矩阵、`P+0x340` / `P+0x348` 本帧 / 上一帧的世界骨骼矩阵、`P+0x3b8` 物理状态 S（每骨骼 0x50）。矩阵按列向量写，`f(out, A, B)`（`FUN_14005ecb0`）= `A·B`。

## 方法

- **分析副本**：`ignore\p9\rea\wallpaper64.exe`（SHA-256 `40e2ce02…5d993b0`）、`ignore\p6\rea\layers\script\scenescript64.dll`（`58039ef9…eaad08`）。开工时与安装目录原件 `sha256sum` 复核，一致。
- **没有开 REA**：前几份 rea 都记录 Ghidra 在本机启动分析超时；这一轮只用全量反汇编 `ignore\p4\rea\wp.asm`（exe）和已有的 dll 方法桩反汇编 `ignore\p6\rea\layers\script\methodcall_214a0.asm`。没有可存的 REA 快照。
- **工作目录** `ignore\p12\d\rea\`：脚本从 `ignore\p12\c\rea\` 原样拷来（`pe` `fn` `slice` `methods` `keys` `xr` `ptr` `rd` `strs` `grepfn`）；汇编摘录在 `asm\`，清单见 `README.txt`：
  - `bones_14020f190.asm`：`getBoneCount` 到 `resetBonePhysicsSimulation` 的全部原生实现。
  - `img_world_1401fd3f0.asm`（图像层虚表 `+0x80`）、`quatmul_140215380.asm`、`streq_14000d010.asm`。
  - `upd_swap_1402003da.asm`、`upd_nolayer_bones_1402037ef.asm`、`upd_nolayer_tse_1402061b1.asm`、`upd_nolayer_writeback_140204fd2.asm`：图像层更新 `FUN_1401fdf90` 里与本题有关的几段（交换、无可见动画层的姿势路径、第二份物理的 t+se 段与写回）。
  - `dll_arg_mat4_181621f56.asm`、`dll_arg_defaults_1816228b7.asm`、`dll_ret_dispatch_181622bac.asm`：dll 方法桩的 Mat4 实参转换、缺参零值、按返回类型调原生。
- **沿用的已有材料**：rea-p12-attach-physics 第 1.2、1.3、2.2–2.6、4.1、4.5 节；rea-p12-runtime 第 2、6 节；rea-p6d-script 8.1–8.3（类型码、方法桩、Mat4 返回）；rea-p6c-dispatch 第 5 节（光标回调的时机）；语料 `ignore\p12\d\corpus\report.txt` 第 4 节与 `scripts\3359451610_objects_{0,2}_visible.js`（两段逐字相同，只当数据读）；WPE 自带 `assets\scripts\jsclasses\baseclasses.js` 的 `Mat4`。

## 概括

| # | 问题 | 结论 | 置信度 |
|---|---|---|---|
| 1 | `getBoneCount()` | `count(P+0x38)`，即 mdl 的骨骼数（MDLS）。门只看 `P` 与 `P+8`（mdl）非空，**不看蒙皮门** `FUN_1402076e0`：静态 puppet（第一个网格没有 `a_BlendIndices`）照样返回骨骼数；非 puppet 图层原生不写槽，dll 的整数槽初值是 0，所以返回 **0**。 | 静态确认；dll 槽初值 0 为推断（`ebx` 在各路径上为 0） |
| 2 | `getBoneTransform(bone)` | 参数 `0x208`：整数按下标（负数、`≥ count(P+0x2c8)`、`P+0x340` 为空都不写槽）；字符串按骨骼名（`std::string ==`，区分大小写）取**第一个**匹配，空串不查。返回 **`P+0x340[i]` 原样拷贝**，即 `W·Pose`（`W` = 图层虚表 `+0x80`，含 `alignment` 偏移；`Pose` 是本帧动画、父链、物理之后的模型空间姿势）。脚本在 puppet 更新之后跑，所以是**本帧推进之后**的值。失败时 dll 的 Mat4 槽初值是**单位阵**，所以返回单位阵（不是 `null`）。每次调用新建 `Mat4`（原型 `Mat4.prototype`，`m` 是 16 个 float32 扩成的 double，glm 列主序，`m[12..14]` 平移）。 | 静态确认 |
| 3 | `setBoneTransform(bone, mat)` | 选骨同上（名字取第一个匹配）。写三处：`P+0x340[i] = M`、`P+0x2c8[i] = W⁻¹·M`（`W` 是此刻的 `+0x80`，`FUN_14005f730` 求逆）、`P+0x2f8[i] = P+0x2c8[i]·P+0x2b0[i]`。**不碰** `P+0x310`（局部）、子骨骼、物理状态 S。**当帧生效**：绘制在脚本之后读 `P+0x2f8`，这根骨骼的蒙皮当帧就是 `M`；子骨骼当帧不跟（它们的 `Pose`/`K` 早已算好）。**只持续一帧**：下一帧更新先交换 `P+0x340 ↔ P+0x348`，再按动画（或静止来源）重算全部 `P+0x310`/`P+0x2c8`/`P+0x340`/`P+0x2f8`，脚本写的姿势被冲掉。唯一的残留是 **`M` 成了下一帧的 `Mp`**（上一帧物理之后的世界矩阵）：开了物理的骨骼下一帧按 `Mp` 算惯性，于是被「拉向」脚本写的位置——`t` 骨骼下一帧的平移偏移按 `(1 − ti/100)` 的比例追到 `M` 的平移（2.4 的 `e`），转动骨骼按 `Mp·tp` 的尖端算 `qa`。没开物理的骨骼 `Mp` 不读，写入没有任何后续影响。 | 静态确认（三处写入、交换、无动画层路径重算、第二份物理读 `P+0x348`）；挂点子对象的当帧行为为推断 |
| 4 | `applyBonePhysicsImpulse(bone, dir, ang)` | 三个形参 `0x208, 0x20, 0x20`（Vec3）。**只传两个参数时不抛错**：dll 对缺的形参放零值 `Vec3(0, 0, 0)`（类型码 `0x80000020`），exe 不看类型码直接读，`q = q ⊗ eulerQuat(0)`，`cosf(0) = 1`、`sinf(0) = 0`，四元数是精确单位，`q` 不变。`dir`：对象读 `x y z` 转 float32，原样加到 `S.vel`（世界坐标，px/s）。**不检查骨骼开没开物理**：S 对每根骨骼都有，写进去但只有 `Q & 0x2000`（`t`）的骨骼在求解里读 `vel`、`Q & 0x1000`（`r`）读 `q`，所以对没开物理的骨骼没有效果。选骨：整数按 `count(P+0x3b8)` 判界；名字取**第一个**匹配，**空串（含缺省第一个参数）落到骨骼 0**。第一次更新之前 S 为空，什么都不做。 | 静态确认 |
| 5 | `resetBonePhysicsSimulation(bone)` | 选骨同 4（第一个匹配，空串 = 骨骼 0，**不是**全部骨骼——更正 rea-p12-attach-physics 2.6）；把那根骨骼的 S 写成 `q = (1, 0, 0, 0)`、其余 0；不清 `Mp`。语料 0 处。 | 静态确认 |
| 6 | 模型对象上有没有 | 没有。`getBoneCount` / `getBoneTransform` / `setBoneTransform` / `applyBonePhysicsImpulse` / `resetBonePhysicsSimulation` 的名字字符串与原生函数都只被图像层登记 `FUN_1402110be` 引用（`xr.py`），模型登记 `FUN_140227470` 只有 5 个动画层方法。 | 静态确认 |

**对已有文档的更正 / 补充**：
- **rea-p12-attach-physics 2.6**「`resetBonePhysicsSimulation` 名字为空串时作用于所有骨骼」**不成立**：名字循环找到第一根就返回（`0x14021102d`），空串跳过比较，所以是骨骼 0。`applyBonePhysicsImpulse` 同理（`0x140210da7`）。
- **rea-p12-attach-physics 4.5**「`getBoneTransform` / `setBoneTransform` 世界骨骼矩阵」补：失败返回单位阵；`set` 同时改 `Pose` 与蒙皮，只持续一帧，但进下一帧物理的 `Mp`。
- `methods.py` 给 `resetBonePhysicsSimulation` 抽出的原生地址 `0x1404e85e0` 是误抽（那条登记用 `lea rcx`），实际原生是 `0x140210e10`（`0x14021221e`）。

---

## 1. 登记与调用约定（静态确认）

图像层方法表（登记 `FUN_1402110be`，`methods.py` 抽 `ignore\p12\rea\attach\asm\imagelayer_methods_1402110be.asm`）：

| 方法 | 原生 | 返回 | 参数 |
|---|---|---|---|
| `getBoneCount` | `0x14020f190` | `0x8`（整数） | — |
| `getBoneTransform` | `0x14020f1d0` | `0x80`（Mat4） | `0x208` |
| `setBoneTransform` | `0x14020f350` | `0x1`（无） | `0x208`, `0x80` |
| `applyBonePhysicsImpulse` | `0x140210990` | `0x1` | `0x208`, `0x20`, `0x20` |
| `resetBonePhysicsSimulation` | `0x140210e10` | `0x1` | `0x208` |

（同表还有 `getLocalBoneTransform` `0x14020f6b0` 等 9 个，语料 0 处，本文只顺带看了 `getLocalBoneTransform`：返回 `P+0x310[i]`。）

dll 方法桩 `0x1816214a0`（rea-p6d-script 8.2）与本题有关的几条：
- **实参转换顺序**：`0x200` 字符串 → `2` → `8` IsInt32 → `4` → … → `0x10/0x20/0x40` 对象取 `x y z w` → `0x80` 矩阵 → …；第一个成功的就用。所以 `bone = 1.5` 不是 Int32、不是字符串，落到缺省。
- **缺参或转换失败**（`dll_arg_defaults_1816228b7.asm`）：按掩码优先级最高的类型放零值并在类型码上置最高位。`0x208` → 空串 `0x80000200`（字符串优先，`0x181621b0a`）；`0x20` → `Vec3(0, 0, 0)`（`0x1816229db`，12 字节清零）；`0x80` → **单位阵**（`0x181622a4b`，对角 `0x3f800000`）。
- **Mat4 实参**（`dll_arg_mat4_181621f56.asm`）：是对象时先在 64 字节缓冲里写单位阵，取一个属性（`[r13+0x30]` 的键，按 `baseclasses.js` 应是 `m`【推断】），是数组就对 `i = 0..15` 取元素、是数就 `cvtsd2ss` 写到第 `i>>2` 列第 `i&3` 行，不是数的元素保留单位阵的值。不是对象 → 缺省单位阵。exe 不看类型码。
- **返回槽初值**（`dll_ret_dispatch_181622bac.asm`）：整数槽 `mov [rbp+0x190], ebx`（`ebx` = 0，`0x181622bda`）；Mat4 槽先拷 `0x1819a5180` 起的 64 字节 = **单位阵**（`0x181622f81`），调原生后经 `0x181624c20` 建 `Mat4`；`0x1` 返回 `undefined`。
- 这几个原生都**不写错误槽**（第 6 个参数），所以不会抛错。

## 2. `getBoneCount`（`0x14020f190`，静态确认）

```c
if (!P || !*(P+8)) return;                                 // 槽不写 → 0
*ret = (int)((P+0x40 − P+0x38) / 0xf0);                     // mdl 骨骼表（每骨骼 0xf0）
```
- 不看蒙皮门、不看 `P+0x2c8` 是否已建：静态 puppet、第一次更新之前都返回骨骼数。
- 非 puppet 图层（`P` 为空）返回 0【dll 槽初值为推断】。

## 3. `getBoneTransform`（`0x14020f1d0`，静态确认）

```c
if (!P || !*(P+8)) return;                                  // → 单位阵
if (argType & 8) {                                          // 整数
    i = int; if (i < 0 || i >= count64(P+0x2c8) || !P+0x340) return;
    *ret = P+0x340[i];
} else if (argType & 0x200) {                               // 字符串
    if (s[0] == 0) return;
    for (i = 0; i < count(P+0x38); i++)
        if (bone[i].name == s && i < count64(P+0x2c8) && P+0x340) { *ret = P+0x340[i]; break; }
}
```
- **界**看 `P+0x2c8`（姿势数），不看骨骼数：第一次更新之前（`P+0x2c8` 为空）、静态 puppet（更新整段跳过，`P+0x2c8` 永远为空）都失败 → **单位阵**。所以脚本 `init` 里读到的是单位阵【推断：`init` 在第一帧更新之前】。
- **取的矩阵**：`P+0x340[i]`。它在图像层更新里写两次：先 `W · Pose[i]`（物理之前，`0x1402011cb` / 第二份 `0x140203ab0`），物理之后再 `W · Pose[i]`（第一份 `0x140202449` 起，第二份 `0x1402051d5` 起，`upd_nolayer_writeback_140204fd2.asm`）。所以是**动画 + 父链 + 物理（+ IK）之后**的世界骨骼矩阵。
- `W` 是更新时刻图层虚表 `+0x80` = `FUN_1401fd3f0`：基类世界矩阵（`FUN_1401850a0`），`L+0x4b1` 置位时再把对齐偏移加进平移（`img_world_1401fd3f0.asm`）。和物理用的 `W`（`0x140200456`）是同一次调用的结果。
- **时机**：图像层更新在对象更新循环 `FUN_1401891a0`（`0x14017fd26`）；光标回调在相机之后、`FUN_140171440` 之前（`0x1401802d5`，rea-p6c-dispatch 5）；`engine.setTimeout` 回调与 `update` 在 `FUN_140171440` 里。三者都在 puppet 更新之后，**读到的都是本帧推进后的值**（本帧早先被脚本 `set` 过的除外，见 4）。
- 脚本在本帧早些时候移动了图层的话，`P+0x340` 仍是更新时刻 `W` 下的值（不随之更新）。
- **返回对象**：dll `0x181624c20` 建 `Mat4`：原型 `Mat4.prototype`、构造函数不跑、`m` = 16 个 float32 扩成 double（glm 列主序，第 i 列在 `m[4i..4i+3]`）。每次调用新对象（rea-p6d-script 8.3）。
- 名字：骨骼名比较 `FUN_14000d010`（`std::string == const char*`，先比长度再 `memcmp`）。语料 `3359451610` 的骨骼名全是空串，只能按下标取。

## 4. `setBoneTransform`（`0x14020f350`，静态确认）

### 4.1 写入

```c
M = 实参 1（Mat4，dll 转好的 64 字节）
选 i（同 getBoneTransform：整数界看 P+0x2c8、P+0x340 非空；名字取第一个合格匹配）
P+0x340[i] = M;                                            // 0x14020f40a
Wi = inverse(L->vtbl[0x80]());                             // 0x14020f423 → FUN_14005f730（余子式、一次 divss，glm::inverse 形态）
P+0x2c8[i] = Wi · M;                                       // 0x14020f448 → FUN_14005ecb0（完整 4×4 乘法）
P+0x2f8[i] = P+0x2c8[i] · P+0x2b0[i];                      // 0x14020f4a2：蒙皮矩阵（完整 4×4 乘法）
```
- **不改**：`P+0x310[i]`（`getLocalBoneTransform` 读回的仍是动画的局部矩阵）、子骨骼的 `P+0x2c8`/`P+0x340`/`P+0x2f8`、物理状态 S、骨骼透明度、变形。
- 不检查 `M` 是否仿射、`W` 是否可逆（缩放为 0 时求逆得到 inf / NaN）。
- 数值：每帧更新里蒙皮用的是只取仿射部分的简化乘法（rea-p12-runtime 6.2），这里两次都是完整 4×4 乘法，舍入不同。

### 4.2 当帧

- **这根骨骼的蒙皮当帧生效**：渲染阶段的图像层绘制 `FUN_140206430` 才映射常量缓冲、写 `P+0x2f8`（rea-p12-runtime 6.3），在脚本之后。所以 `update` / 光标回调 / 计时器里的 `set`，当帧就画出来。
- **子骨骼当帧不跟**：它们的 `K` 在更新里按旧的父姿势算好，`set` 不重算父链。子骨骼的网格和被移动的父骨骼当帧会脱开（语料 `3359451610` 的骨骼全是根，不涉及）。
- **挂点子对象**【推断】：挂点用 `P+0x2c8[骨骼]`（rea-p12-attach-physics 1.2），带挂点的对象世界矩阵每帧第一次被要时算并缓存到帧末（1.3）。粒子在自己的 `+0x48` 里就要（在脚本之前）→ 当帧看不到 `set`；图像层在绘制时才要（在脚本之后）→ 当帧看得到 `set`；下一帧姿势被重算，都看不到了。语料没有这种组合。
- 同一帧之后再 `getBoneTransform(i)` 读到的就是 `M`。

### 4.3 下一帧

图像层更新（`upd_swap_1402003da.asm`、`upd_nolayer_bones_1402037ef.asm`）：
1. `0x1402003f0` `FUN_1402154c0`：交换 `P+0x340 ↔ P+0x348`。于是 **`P+0x348[i]` = 上一帧脚本之后的 `P+0x340[i]` = `M`**（被 `set` 过的骨骼），其它骨骼是上一帧物理之后的 `W·Pose`。
2. 取 `W`，`0x140200504` 按有没有可见动画层分两条路。没有可见层时（`3359451610` 就是：没有动画层），`0x140203840` 起每根骨骼：`P+0x310[i]` = 静止来源（`P+0x50` 或骨骼 `+0x20`），`P+0x2c8[i]` = 父的 `P+0x2c8` · 局部（根骨骼直接取局部），`P+0x340[i] = W·P+0x2c8[i]`。有可见层时走第一份，同样从 SoA 重算全部骨骼。**脚本写的 `Pose`、`K` 都被覆盖**，动画采样、父链完全不知道上一帧被 `set` 过。
3. 物理（`Q & 0x3000` 且 `P+0x348` 非空）：`Mp = P+0x348[i]`。第二份（无可见层）入口 `0x140203c32`：`Mw` 的四列取自 `P+0x340[i]`（`[rbp+0xb0]`/`+0xa0`/`+0x90` 是前三列，`[rbp+0x60]` = `o`），`Mp` 的平移是 `[rbp+0x10]`（`0x140203d31`）。平移段 `0x1402061b1`（`upd_nolayer_tse_1402061b1.asm`）：
   ```text
   e    = (o + off − Mp.o) · Q.ti'          // Q+0x18 = 1 − ti/100（[rdi+0x80]）
   off1 = off − e
   vel -= (dt · ts) · off1                   // [rdi+0x70] = ts
   off  = off1 + dt · vel
   （轴锁、tm 钳制、vel *= 1 − min(dt·tf, 1)，同 rea-p12-attach-physics 2.4）
   ```
   写回（`0x140204ff4` 起）：`P+0x2c8[i] = P+0x2c8[i] · D`，`P+0x340[i] = W · P+0x2c8[i]`。和第一份逐项同构（2.4 记的是第一份）。
4. 蒙皮 `P+0x2f8` 照常从 `P+0x2c8` 重算。

**所以 `set` 对物理骨骼的作用是「改写上一帧的结果」**：
- `t` 骨骼：`Mp.o` 被换成 `M` 的平移 `d`，下一帧 `off1 = (1 − k)·off + k·(d − o)`（`k = 1 − ti/100`），即偏移有 `k` 的比例追到「脚本位置相对动画位置的差」，之后弹簧（`se`）或惯性（`re`）照常。连续每帧 `set` 时，物理状态每帧都被拉向脚本位置、弹簧一直在积累反向速度，但画面被脚本当帧覆盖；停止 `set` 的那一帧起画面才是物理的输出——从接近脚本位置出发、带着积累的速度回弹。
- `r` 骨骼：`dl = A⁻¹·(Mp·tp − o)` 用 `M` 的整个矩阵乘 `tp`，脚本写的转动也会产生惯性。
- 没开物理的骨骼：`Mp` 不读，`set` 下一帧完全消失。
- `M` 含 NaN（例如脚本对零长度向量做了 `divide`）时，开了物理的骨骼下一帧 `e`、`off`、`vel` 都变成 NaN 并留在 S 里，之后一直是 NaN，直到 `resetBonePhysicsSimulation`【推断：按公式逐项推出，没看 NaN 下各个 `comiss` 的走向】。

## 5. `applyBonePhysicsImpulse`（`0x140210990`，静态确认）

```c
if (!P || !*(P+8)) return;
dir = (float3*) r9[1];  ang = (float3*) r9[2];             // dll 转好的 Vec3；缺参时是 (0, 0, 0)
选 i：整数 → 0 ≤ i < count(P+0x3b8)（S 的个数）；
      字符串 → 遍历骨骼表，名字为空串时不比较，取第一个 i < count(P+0x3b8) 的（即骨骼 0），否则第一个全名匹配
S = P+0x3b8 + i·0x50;
S.vel += dir;                                               // +0x28..+0x30，三次 addss
h = ang · 0.017453292 · 0.5;                                // 0x140492628、0x1404926c0
S.q = S.q ⊗ eulerQuat(h);                                   // cosf/sinf 各三次，FUN_140215380 就地 a ⊗= b
```
- **只传两个参数**：dll 的形参循环按形参个数走，第 3 个下标 ≥ `argc`（`0x181621f62` 一类的 `cmp [r15], eax; jle`）→ 缺省分支放 `Vec3(0, 0, 0)`、类型码 `0x80000020`；exe 不看类型码。`h = 0`，`eulerQuat` 的 w 分量是三个 `cosf(0)` 的积 = 1，其余分量都带一个 `sinf(0) = 0` 的因子 = 0（可能是 −0），`q ⊗ (1, 0, 0, 0) = q`。**不抛错、`q` 不变**。
- 传了一个不是对象的第 3 参数（数字、字符串）同样落到缺省零值。
- **`dir`**：对象取 `x y z`（`baseclasses.js` 的 `Vec3`，`3359451610` 里是 `releaseDistance.multiply(k)`，`z = 0`），按 float32 加进 `S.vel`。单位与 `vel` 相同：世界坐标的像素 / 秒，在下一帧求解里乘 `dt` 进 `off`（2.4）。
- **不检查物理开关**：exe 不读骨骼 `+0x68`。S 按骨骼数建（第一次更新时），所以对任何骨骼都能写；只有 `Q & 0x2000`（`t`）的骨骼在求解里读 `vel`，只有 `Q & 0x1000`（`r`）的读 `q`。`3359451610` 的骨骼 1（物理关）收到冲量没有效果，骨骼 0、2（`t + se`）`vel += dir`。【静态确认：写入；没有效果是由求解的门推出】
- 冲量在下一帧的物理里起作用（计时器在 puppet 更新之后跑）。
- 第一次更新之前（S 为空）、`bone` 越界：什么都不做。

## 6. `resetBonePhysicsSimulation`（`0x140210e10`，静态确认）

选骨规则同 5（第一个匹配，空串 = 骨骼 0）；`S[i]` 的 0x50 字节写成 `(1, 0, 0, 0)`（`0x140492a60`）加 64 字节 0。不清 `Mp`，下一帧惯性照常。语料 0 处。

## 7. 模型对象（静态确认）

`xr.py` 查 `getBoneCount`（`0x140490e68`）、`setBoneTransform`（`0x140490e90`）、`resetBonePhysicsSimulation`（`0x140490fc8`）、`applyBonePhysicsImpulse`（`0x140491050`）四个字符串和五个原生函数：引用全部在图像层登记 `FUN_1402110be` 里。模型登记 `FUN_140227470` 的方法表只有 5 个动画层方法（rea-p12c-script 1.1）。模型对象上调这些方法是 `TypeError`（不是函数）。

## 8. `3359451610` 按 WPE 的语义走一遍（推断，由以上结论推出）

| 时刻 | 脚本 | WPE 的结果 |
|---|---|---|
| 按下那一帧 | `cursorDown`：`getBoneCount()` = 3；`getBoneTransform(b).translation()` 是本帧物理之后的世界位置 | 选 400 px 内最近的骨骼（0–2 都可能） |
| 拖动中每帧 | `update`：先读 `getBoneTransform(i)`（本帧物理的输出，即上一帧 `set` 位置被物理拉回一部分之后的位置），与目标差 > 5 px 置 `shouldBounce`；再 `set` 成目标 | 画面当帧就是目标位置；物理状态每帧被拉向目标、弹簧积累反向速度 |
| 抬起那一帧 | `cursorUp`（在 `update` 之前）：读到的是本帧物理输出；`activeDragBone = -1`，本帧不再 `set` | 画面是物理输出：从接近目标处出发回弹（骨骼 0、2）；骨骼 1 没开物理，直接跳回静止位置 |
| 100 ms 后 | 计时器：对其余骨骼 `applyBonePhysicsImpulse(b, dir)` | 骨骼 0、2 的 `vel += dir`，下一帧起被推开再弹回；骨骼 1 没有效果；不抛错 |

拖动的「手感」全由 4.3 决定：`k = 1 − ti/100 = 0.7`、`ts 300`、`tf 5`、`tm 200`（× `s`）。

---

## 对实现的含义

### 帧内数据
- puppet 运行时需要一份**每帧的世界骨骼矩阵缓冲** `world[i] = W·Pose[i]`（物理之后），和一份**上一帧**的 `prevWorld`。帧开头交换两者，**交换的对象必须是上一帧脚本之后的缓冲**：脚本的 `setBoneTransform` 写进当前 `world`，下一帧它就是物理的 `Mp`。P12d 的物理若另存「上一帧物理输出」而不经这份缓冲，`3359451610` 的拖动会完全不起作用。
- `W` 用图层画自己的矩阵（含对齐偏移）——Kabegame 的 `drawMatrixOf`，与物理用的是同一个。
- 蒙皮上传（`g_Bones`）在脚本之后取，脚本改过的那根骨骼当帧生效；子骨骼不重算。

### 方法
```ts
getBoneCount(): number
  // puppet 的 mdl 骨骼数（静态 puppet 也算）；非 puppet 0
getBoneTransform(bone: number | string): Mat4
  // 整数：0 ≤ i < 本帧姿势数（第一次更新前 / 静态 puppet 为 0）；字符串：第一个全名相等的骨骼，空串不查
  // 命中：new Mat4(world[i] 的 16 个 float32)；否则单位阵；参数既不是 Int32 也不是字符串 → 当空串 → 单位阵
setBoneTransform(bone, m: Mat4): void
  // 选骨同上，没选中什么都不做
  // world[i] = m；pose[i] = inverse(W_now)·m；skin[i] = pose[i]·invBind[i]（都 float32）
  // 不改 local[i]、子骨骼、物理状态；下一帧由动画重算 pose/skin/world，m 只作为 prevWorld 进物理
  // m 不是对象 → 单位阵；m.m 不是数组 → 单位阵；m.m 里不是数的元素 → 用单位阵对应位置的值
applyBonePhysicsImpulse(bone, dir: Vec3, ang = Vec3(0,0,0)): void
  // 选骨：整数按物理状态数判界；字符串取第一个匹配，空串 → 骨骼 0；第一次更新前 no-op
  // state.vel += dir（float32）；state.q = state.q ⊗ eulerQuat(ang·DEG·0.5)
  // 不看物理开关；dir / ang 不是对象 → (0,0,0)；不抛错
resetBonePhysicsSimulation(bone): void
  // 选骨同上；state = { q: (1,0,0,0), 其余 0 }；不清 prevWorld
```
- 只挂在图像层的脚本对象上；模型对象不要加。
- 返回 `undefined` 的三个方法不抛错；`getBoneTransform` 永不返回 `null`。
- 能力键：语料只用到 `getBoneCount`、`getBoneTransform`、`setBoneTransform`、`applyBonePhysicsImpulse`；做完这四个就把 `3359451610` 的 `script:api:layer.*` 清掉，其余 9 个（`getLocalBone*` 6 个、`getBoneIndex`、`getBoneParentIndex`、`resetBonePhysicsSimulation`）语料 0 处，可以先照报。

### 时序
- 光标回调、计时器、`update` 都必须在 puppet 更新（动画 + 物理）之后跑——Kabegame 已经是（P12b1：puppet 先于粒子、脚本）。确认光标派发也在 puppet 之后，否则 `cursorDown` 会读到上一帧的骨骼位置。

## 没查清的

1. **`init` 里调 `getBoneTransform`**：按「`init` 在第一帧更新之前」推出返回单位阵，没核对 `init` 与第一次 `FUN_1401fdf90` 的先后。
2. **挂点子对象在 `set` 当帧的行为**（4.2）：按 rea-p12-attach-physics 1.3「图像层在绘制时才要世界矩阵」推出，没逐个核对子对象类型。语料 0 处。
3. **Mat4 实参的属性键**：`[r13+0x30]` 的键按 `baseclasses.js` 认定是 `m`，没在 dll 里找到字符串核对。
4. **dll 整数返回槽的初值**：`ebx` 在方法桩各路径上为 0 是按代码形态认定（`0x18162217b` 等处 `xor ebx, ebx`），没逐条走完所有转换分支。
5. **NaN 在物理里的走向**（4.3 末）：只按公式推出；`tm` 钳制等 `comiss` 遇 NaN 的分支没逐条核对。
6. **第一份物理（有可见动画层）的 `Mp` 读取**：只看了第二份的列来源；第一份在 rea-p12-attach-physics 2.4 已逐条读过，同一个 `P+0x348`。

## 建议实测的用例（主会话：kbp gen 的 puppet mdl 编码 + wpe-renderdoc）

1. **读回与失败值**：非 puppet 图层 `getBoneCount()`（预期 0）、`getBoneTransform(0)`（预期单位阵，不是 `null`）；puppet 上 `getBoneTransform(99)`、`getBoneTransform(1.5)`、`getBoneTransform('')`（预期单位阵）；`init` 里 `getBoneTransform(0)`（预期单位阵）、第一次 `update` 里（预期 `W·Pose`）。和 `g_Bones`、图层 `getTransformMatrix()` 对一下：`getBoneTransform(i) = getTransformMatrix()（含 alignment）· Pose[i]`。
2. **只持续一帧**：没开物理的骨骼，只在第 N 帧 `update` 里 `setBoneTransform(i, 平移 +100 px)`。预期 RenderDoc 的 `g_Bones[i]` 只有第 N 帧变、第 N+1 帧回到动画值；它的子骨骼第 N 帧不变。
3. **进物理的 `Mp`**：`t + se` 骨骼（照 `3359451610`：`ts 300`、`tf 5`、`ti 30`、`tm 200`），只在第 N 帧 `set` 平移 +100 px。预期第 N+1 帧偏移约 `0.7 × 100` 再加 `dt·vel`，随后弹回；同一骨骼去掉 `t`（物理关）则第 N+1 帧直接回去。用 `physmodel.py` 把 `Mp` 换成 `set` 值即可算期望。
4. **冲量两参数**：`applyBonePhysicsImpulse(0, new Vec3(500, 0, 0))` 不传第三个参数——预期不抛错、`t` 骨骼被推开再弹回；同一调用打在物理关的骨骼上没有变化；`applyBonePhysicsImpulse('', v)` 只推骨骼 0。
5. **`resetBonePhysicsSimulation('')`**：两根 `t` 骨骼都在摆动时调用，预期只有骨骼 0 停下（更正 2.6 的说法）。
6. **复制工程整帧对照**：`3359451610` 的 `kbp content isolate` 复制工程，用 `input_play` 喂一段拖动（按下 → 拖 60 px → 抬起），逐帧比 `g_Bones` 与画面。
