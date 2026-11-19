# REA：P12g 步骤 0 —— puppet 骨骼的局部读写脚本 API（WPE 2.8.42 `wallpaper64.exe` / `scenescript64.dll`）

> 读码代理产出。只做静态分析，没有运行、附加或改动 WPE，没有读 WPE 安装目录与工坊内容。
> 置信度：
> - **静态确认**：汇编直接看到。
> - **推断**：由代码推出，但缺一环（没实测、某个分支按形态认定、后果靠帧内时序推）。
> - **未知**：查到某处为止，没有结论。
>
> exe 地址以 `0x140000000` 为基址，`scenescript64.dll` 地址以 `0x180000000` 为基址。汇编、字符串、脚本源码只当数据看。
> 结构叫法沿用 [rea-p12-runtime](rea-p12-runtime.md) / [rea-p12-attach-physics](rea-p12-attach-physics.md) / [rea-p12d-bones](rea-p12d-bones.md)：**L** 图像层、**P** = `L+0x4b8` puppet 运行时、`P+0x38` 骨骼表（每骨骼 0xf0：`+0` 名字 `std::string`、`+0x20` MDLS 局部矩阵、`+0x60` 父下标、`+0x68` 物理参数块 Q）、`P+0x50` 静止来源矩阵（mdl+0x48）、`P+0x2b0` 绑定逆、`P+0x2c8` 模型空间姿势 **Pose**、`P+0x2f8` 蒙皮矩阵 **K**、`P+0x310` 局部矩阵 **Local**、`P+0x340` / `P+0x348` 本帧 / 上一帧的世界骨骼矩阵 **World** / **Mp**、`P+0x3b8` 物理状态 S。矩阵按列向量写，内存里第 c 个 16 字节是第 c 列（`cN.x/y/z/w`），`m[12..14]` 是平移。**W** = 图层虚表 `+0x80`（`FUN_1401fd3f0`，含 `alignment` 偏移）。下文 `f(·)` 表示 float32 舍入。

## 方法

- **分析副本**：`ignore\p9\rea\wallpaper64.exe`（`sha256sum` 复核为 `40e2ce02…5d993b0`，与 rea-p12d-bones 记录的一致）、dll 方法桩沿用 `ignore\p6\rea\layers\script\methodcall_214a0.asm`。安装目录原件**没有复核**：本轮约束不碰 WPE 安装目录（前几轮已复核过同一哈希）。
- **没有开 REA**：前几轮 Ghidra 导入超时、快照打不开，本轮直接用全量反汇编 `ignore\p4\rea\wp.asm`；没有快照可存。
- **工作目录** `ignore\p12\g\rea\`（清单见 `README.txt`）：
  - 脚本从 `ignore\p12\f\rea\`（`slice` `fn` `pe` `xr` `grepfn` `ptr` `f32` `gall` `vt`）与 `ignore\p12\d\rea\`（`methods` `keys` `rd` `strs`）原样拷来；`methods_imagelayer.txt` 是图像层方法登记的抽取结果。
  - 新存的汇编（`asm\`）：`localbones_14020f6b0.asm`（8 个方法 + 3 个混合形状方法）、`localrecalc_14020db40.asm`（子树重算）、`upd_nolayer_local_1402037ef.asm` / `upd_layer_local_140200a58.asm`（两条推进路径写 `P+0x310` 的地方）、`vec_empty_1401d76a0.asm`、`stricmp_1402c10d0.asm`、`dll_ret_switch_1816221e3.asm`。
- **沿用的已有材料**：rea-p12d-bones 第 1–4 节（选骨、dll 实参转换、`setBoneTransform`、交换与无层路径）、rea-p12-runtime 1.2 / 2 / 5.2 / 6.1–6.3 / 7、rea-p12-attach-physics 1.2 / 1.3 / 2.2–2.5、rea-p12f 概括 2c（帧内顺序）、rea-p6d-script 8.1–8.3（类型码、方法桩）、rea-p6d1-xform（Vec3 实参逐分量 `IsNumber`）、rea-p6e-script（图层类表 `0x1404e8620` 与文本层回落）。
- **全函数核对**：`FUN_14020db40` 的调用点用 `xr.py` 查过，只有三个 setLocal* 方法的 6 处；图像层更新 `FUN_1401fdf90` 全段（`ignore\p12\rea\attach\asm\imagelayer_update_1401fdf90.asm`）里访问 `+0x310` 的只有 4 处（`0x1401fe0e3` 重建尺寸、`0x140200877` 特殊骨骼、`0x140200b4a` 有层路径、`0x14020387d` 无层路径）。
- **场景数据**：只读 `ignore\p6\f5\scene.json` 对象 0 的 `visible` 字段脚本（数据）。puppet 的 mdl（`models/bride_backgr_v4_puppet.mdl`）在工坊内容里，本轮**没有读**，所以骨骼层级、有没有物理骨骼、`P+0x50` 是否非空都不知道（见第 10 节与「未知」）。

## 概括

| # | 问题 | 结论 | 置信度 |
|---|---|---|---|
| 1 | `setLocal*` 写到哪、当帧还是下一帧 | **只写 `P+0x310[i]`**（Transform 整个 64 字节；Angles 只写前三列、第 4 列不动；Origin 只写 `c3.xyz`），然后尾调 `FUN_14020db40(L, i)` **当场重算骨骼 i 及其子孙**：`Pose[j] = 父 < 0 ? Local[j] : Pose[父]·Local[j]`、`K[j] = Pose[j]·绑定逆[j]`、`World[j] = W·Pose[j]`，三处都是**完整 4×4 乘法**（不是每帧更新用的仿射乘法），`W` 取**调用此刻**的图层 `+0x80`。绘制在脚本之后上传 `P+0x2f8`，所以**当帧生效、子骨骼当帧跟着动**。**不写 `P+0x50`**：`P+0x50` 是 mdl+0x48（MDLS v≥2 文件里的可选每骨骼矩阵），加载后只读。 | 静态确认 |
| 2 | 写入能保持多久 | **只到下一次推进为止**。下一帧图像层更新对**每一根**骨骼重写 `P+0x310`：没有可见动画层时取静止来源（`P+0x50[i]` 非空用它，否则骨骼 `+0x20`），有可见层时取 `[mat4_cast(q)·diag(S) | T]`（来自本帧从静止 SoA 起逐层混合的结果）。静止 SoA 只在加载后第一次更新时从 `P+0x50` / 骨骼 `+0x20` 分解一次，从不读 `P+0x310`。所以**写入不进动画混合，也不进下一帧的静止来源**；有动画层时就是「本帧动画之后再覆盖一次、只管这一帧」。唯一的残留是写入重算出的 `World[j]` 在下一帧交换后成为物理的 `Mp`（同 `setBoneTransform`）。WPE 没有类似「静止捷径」的跳过：无层路径每帧都全量重算，`FUN_14020db40` 与上传都不设条件。 | 静态确认 |
| 3 | `getLocalBoneTransform` 读什么 | 原样拷贝 `P+0x310[i]`。第一次 `update`（推进过一次之后）：无层时是静止来源矩阵（`P+0x50` 为空时就是 **MDLS 局部矩阵，逐字节**）；有层时是本帧动画的局部矩阵（没轨道的骨骼是静止 SoA 重组的矩阵，单位旋转时与 MDLS 相同，带旋转时有快速倒数平方根带来的 ~0.2% 偏差）。同一帧 `set` 之后再 `get`：读回刚写的值（Transform 逐字节；Angles / Origin 读回改过的那几项）。`init` 里（第一次推进之前）失败 → 单位阵。 | 静态确认；`init` 先于第一次推进沿用 rea-p12d-bones 的推断 |
| 4 | Angles / Origin | 都是**弧度**、全 float32、无度弧换算。`get` 分解：`z = atan2f(c0.y, c0.x)`，`y = atan2f(−c0.z, sqrtss(f(c1.z²) + f(c2.z²)))`，`x = atan2f(f(sz·c2.x) − f(cz·c2.y), f(cz·c1.y) − f(sz·c1.x))`，返回 `Vec3(x, y, z)`，正是 `R = Rz·Ry·Rx` 的逆（同物理的 `euler(M)`）；不先去缩放，均匀缩放不影响，非均匀缩放会让 x / y 失真。`set` 用 `sinf` / `cosf` 重建 `Rz(z)·Ry(y)·Rx(x)` 写进前三列（各列 w = 0），**原有缩放丢掉**，第 4 列（平移与 w）保留。`Origin` 就是 `c3.xyz`，`set` 只改这三个 float（w、旋转、缩放都不动）。 | 静态确认 |
| 5 | 选骨与失败 | `get/set*` 参数 `0x208`：整数 `0 ≤ i < count(P+0x2c8)` 且 `P+0x340` 非空；字符串取**第一个**全名相等（`std::string ==`，区分大小写）的骨骼，空串不查；其它类型（`1.5`、布尔、对象、缺省）dll 换成空串 → 失败。失败时 `get` 返回**单位阵** / **`Vec3(0, 0, 0)`**，`set` 什么都不做；都不抛错。**第二个参数缺省或类型不对时照样写**：Transform 写单位阵、Angles 写 `(0,0,0)`（旋转归零、缩放丢掉）、Origin 写 `(0,0,0)`。`getBoneIndex(name)` 只收字符串（`0x200`），槽**先写 −1**；遍历 `P+0x38` 全部骨骼取第一个全名相等的下标，区分大小写，空串 / 数字 / 找不到 → −1；不看 `P+0x2c8`，所以 `init` 里、静态 puppet 上都能用。`getBoneParentIndex` 同样先写 −1；整数按骨骼表（`count(P+0x38)`）判界、返回父下标（根骨骼 −1）；字符串取**第一个名字相等且有父**的骨骼的父（同名根骨骼被跳过）。非 puppet 图像层：`getBoneIndex` / `getBoneParentIndex` −1，其余单位阵 / 零向量 / 无操作。静态（非蒙皮）puppet 与第一次推进之前：两个索引方法正常，其余同失败。模型对象、文本 / 粒子 / 声音层：没有这些方法（`TypeError`）。 | 静态确认；非图像层的 `TypeError` 为推断（同 rea-p6e） |
| 6 | 和已有功能的交互 | **物理**：重算不经物理，子树里开物理（`Q & 0x3000`）的骨骼当帧的物理增量 `D` 被丢掉（`P+0x310` 里没有 `D`），`World` 也是不含 `D` 的值并成为下一帧的 `Mp`；物理状态 S 不动。**`setBoneTransform`**：它不写 `P+0x310`，之后对它或祖先的 `setLocal*` 会把它冲掉；之后对它的**子骨骼**的 `setLocal*` 会以它写的 `Pose` 为父（子骨骼随之动）。**挂点**：挂点读 `P+0x2c8`，在 `set` 之后才求世界矩阵的子对象看得到（图像层绘制时求，推断看得到；粒子在推进循环里就求，推断永远看不到每帧重写的姿势）。**骨骼透明度、变形、绘制顺序、裁切**：不碰。IK / 约束同物理（语料 0 处）。 | 静态确认（写哪些缓冲）；挂点子对象为推断 |
| 7 | `3820240793` 逐帧 | `init` 的 5 次 `getBoneIndex` 正常（不依赖推进）；第 1 帧推进后 `update` 读到的基准就是静止来源；之后每帧推进把局部复位成静止、`update` 再按 `t` 重写 5 根（3 根原样写回），**第 1 帧起画出脚本姿势、不晚一帧、不累积**。原样写回的 3 根也会触发子树重算，子树的 `g_Bones` 改成完整 4×4 乘法的舍入（和不写时差 1 ulp 级）。若某根被写的骨骼下面有物理骨骼，那些骨骼在 WPE 里**看不到物理摆动**。 | 推断（由 1–6 推出；层级与物理未知） |
| 8 | 建议实测 | 见文末 12 个用例：读回 / 失败值、当帧 vs 下一帧、只写一次、有动画层、Angles 单位与顺序与缩放、Origin、缺参写入、物理骨骼被丢 `D`、与 `setBoneTransform` 的先后、挂点、调用时刻、`g_Bones` 舍入。 | — |

**对已有文档的更正 / 补充**（不改旧文档，只列出）：
- **rea-p12d-bones 第 1 节表下注与「能力键」一段**：「`getLocalBone*` 6 个、`getBoneIndex`、`getBoneParentIndex` 语料 0 处」已过时：`3820240793` 用到 `getBoneIndex`、`getLocalBoneTransform`、`setLocalBoneTransform`（补充，不是读码错误）。
- **rea-p12d-bones 4.3 / rea-p12-runtime 1.2 的「静止来源（`P+0x50` 或骨骼 `+0x20`）」**：成立；补：`P+0x50` = mdl+0x48，只在 mdl 加载（`0x14026273b`–`0x14026284a`，rea-p12-mdl 1.3）写，`FUN_1401fdf90` 里 4 处（`0x1401fe2d3`、`0x1401fea32`、`0x1402037ef`、`0x140203866`）全是读，`setLocal*` 不碰它。
- **rea-p12-attach-physics 1.2「`Pose` 是物理之后的姿势」**：补：脚本 `setLocal*` 之后，被重算的子树里 `Pose` 是不含物理增量的值（本文 8.1）。
- **rea-p12d-bones「对实现的含义 / 方法」`setBoneTransform` 的 `W`**：读码写的是「此刻的 `+0x80`」（调用时刻），正确；但现有实现（`player.ts` `setBoneTransform` 用 `physics.layerWorld`，即推进时刻的 `W`）与之不同，只在脚本同一帧里先改了图层变换再 `set` 时有差别。本文的 setLocal* 同样用调用时刻的 `W`。

---

## 1. 登记与调用约定（静态确认）

图像层类表 `0x1404e8620`（登记 `FUN_1402110be`，`methods_imagelayer.txt`）：

| 方法 | 原生 | 返回 | 参数 |
|---|---|---|---|
| `getLocalBoneTransform` | `0x14020f6b0` | `0x80`（Mat4） | `0x208` |
| `setLocalBoneTransform` | `0x14020f840` | `0x1` | `0x208`, `0x80` |
| `getLocalBoneAngles` | `0x14020fa10` | `0x20`（Vec3） | `0x208` |
| `setLocalBoneAngles` | `0x14020fce0` | `0x1` | `0x208`, `0x20` |
| `getLocalBoneOrigin` | `0x1402100d0` | `0x20` | `0x208` |
| `setLocalBoneOrigin` | `0x140210250` | `0x1` | `0x208`, `0x20` |
| `getBoneIndex` | `0x140210790` | `0x8`（整数） | `0x200` |
| `getBoneParentIndex` | `0x140210860` | `0x8` | `0x208` |
| `getBlendShapeIndex` | `0x140210400` | `0x8` | `0x200` |
| `getBlendShapeWeight` | `0x1402104b0` | `0x4`（float） | `0x208` |
| `setBlendShapeWeight` | `0x1402105c0` | `0x1` | `0x208`, `0x4` |

- 只登记在图像层类表上（与 `getTextureAnimation` 同表）。文本层回落到图像基类表 `0x1404e83a0`，粒子 / 声音 / 模型回落到根表，都没有这些方法 → `TypeError: … is not a function`【推断，同 rea-p6e-script】。模型登记 `FUN_140227470` 只有 5 个动画层方法（rea-p12d-bones 7）【静态确认】。
- **dll 实参**（rea-p6d-script 8.2、rea-p12d-bones 1）：
  - `0x208`：先「是字符串 → ToString」，再「`IsInt32`」；都不是（`1.5`、`-0`、布尔、对象、`undefined`、缺参）→ 空串，类型码 `0x80000200`。
  - `0x200`（`getBoneIndex`）：只认 JS 字符串；数字也换成空串。
  - `0x20`（Vec3）：是 JS 对象（JSReceiver）才逐分量取 `x` `y` `z`，每个分量 `IsNumber` 才 `NumberValue → cvtsd2ss`，否则 0（rea-p6d1-xform，`0x181620090`）；不是对象或缺参 → `(0, 0, 0)`。
  - `0x80`（Mat4）：对象的 `m` 数组逐元素 `cvtsd2ss`，非数元素保留单位阵的值；不是对象或缺参 → 单位阵（rea-p12d-bones 1）。
  - exe 一律不看第二个参数的类型码，**缺参也照写默认值**（见 3.2、4.2、5.2）。
- **返回槽初值**（`dll_ret_switch_1816221e3.asm`，`0x1816221e3` 起按返回类型分派）：`0x20` → `0x181622d07` 把 12 字节清零后调原生，再 `0x181624910` 建 `Vec3`（原型 `Vec3.prototype`，每次新对象）；`0x80` → `0x181622f81` 单位阵；`8` → `0x181622bda` 写 0；`4` → `0x181622c48` 写 0。`getBoneIndex` / `getBoneParentIndex` / `getBlendShapeIndex` 的原生**第一条指令就把槽写成 −1**（`0x1402107a0`、`0x14021086d`、`0x140210410`），所以它们的失败值是 −1 而不是 0。
- 都不写错误槽，**不抛错**。

## 2. 子树重算 `FUN_14020db40(L, i)`（静态确认）

只被 `setLocalBoneTransform`（`0x14020f8f8` 尾跳、`0x14020f9db`）、`setLocalBoneAngles`（`0x14020fe9f`、`0x140210063`）、`setLocalBoneOrigin`（`0x1402102fb`、`0x1402103c4`）调用。

```c
W = L->vtbl[0x80](L);                    // 0x14020dba6：调用此刻的图层矩阵（指针，含 alignment），整个函数共用
std::set<uint32> dirty;                  // 0x14020dbcb：空红黑树
n = count(P+0x38);                       // 骨骼表
for (j = i; j < n; j++) {                // 0x14020dc16 / 0x14020e5ac
    p = bone[j].parent;                  // +0x60，u32
    if (j != i && !dirty.contains(p)) continue;        // 0x14020dc1c–0x14020dc95（lower_bound）
    dirty.insert(j);                                   // 0x14020dc9b–0x14020df5c
    if (p == -1) Pose[j] = Local[j];                   // 0x14020df7a：拷贝
    else         Pose[j] = Pose[p] · Local[j];         // 0x14020dfb1–0x14020e1b9
    K[j]     = Pose[j] · invBind[j];                   // 0x14020e1bf–0x14020e421
    World[j] = W · Pose[j];                            // 0x14020e427–0x14020e59a（写 P+0x340）
}
```
- **乘法**：三处都是完整 4×4，每列 `c = f(f(f(f(A0·b.x) + f(A1·b.y)) + f(A2·b.z)) + f(A3·b.w))`（`mulps` / `addps`；`K` 的 `c2` 用 `mulss` / `addss` 逐分量算，加法顺序相同）。这就是现有 `mulFull`（`puppet/math.ts`）的顺序。每帧推进里的 `Pose`、`K` 用的是仿射乘法（rea-p12-runtime 6.1：列 j<3 为 `(m.y·A1 + m.z·A2) + m.x·A0`），**加法结合顺序不同**，所以即使写回原值，重算后的子树也会有 1 ulp 级差异。
- **子树**：从 `i` 起往后扫，父在集合里的才算——即「下标大于 `i` 的子孙」。父下标比子大的骨骼不会被重算（语料 129 个 mdl 全部父在前，rea-p12-runtime 1.1）。不检查 `j < count(P+0x2c8)`（调用前已判过 `i`，各缓冲在第一次推进时按骨骼数建好）。
- **不碰**：`P+0x310`（只读）、`P+0x348`、物理状态 `P+0x3b8`、约束 / IK、骨骼透明度 `P+0x268`、变形 `P+0x398` / `P+0x3a0`、绘制顺序 `P+0x280` / `P+0x298`、记录矩阵 `P+0x2e0`。
- `W` 是调用时刻的：脚本同一帧里先改图层 `origin` 等再 `set`，子树的 `World` 用新 `W`，其它骨骼仍是推进时的 `W`。
- 不检查 `Local` 是否仿射、有没有 NaN；非仿射的第 4 行会被完整乘法带进 `Pose` / `K`（只到下一次推进）。

## 3. `get/setLocalBoneTransform`（静态确认）

### 3.1 `getLocalBoneTransform`（`0x14020f6b0`）

```c
if (!P || !P+8) return;                                  // 槽：单位阵
if (type & 8) { i = int;  if (i < 0 || i >= count(P+0x2c8) || !P+0x340) return; *ret = Local[i]; }   // 0x14020f6d4–0x14020f740
else if (type & 0x200) {                                 // 0x14020f74a
    if (s[0] == 0) return;
    for (i = 0; i < count(P+0x38); i++)
        if (bone[i].name == s && i < count(P+0x2c8) && P+0x340) { *ret = Local[i]; break; }   // 0x14020f7a1–0x14020f810
}
```
- 判界与 `getBoneTransform` 相同（看 `P+0x2c8` 与 `P+0x340`），所以第一次推进之前、静态 puppet 上都失败 → 单位阵。
- 读的是**此刻**的 `P+0x310`：推进之后到下一次推进之前，被 `setLocal*` 改过就读回改过的值。

### 3.2 `setLocalBoneTransform`（`0x14020f840`）

```c
M = *(mat4*)arg[1];                                      // 0x14020f86e：dll 转好的 64 字节；缺参 / 非对象 = 单位阵
选 i（同 3.1）；Local[i] = M（64 字节原样，0x14020f8d6 / 0x14020f9c8）；FUN_14020db40(L, i)
```

## 4. `get/setLocalBoneAngles`（静态确认）

### 4.1 `getLocalBoneAngles`（`0x14020fa10`），`M = Local[i]`

```text
z  = atan2f(M.c0.y, M.c0.x)                                  // 0x14020fa9f（atan2f = 0x14041c460，第一参 y）
n  = f(f(M.c1.z·M.c1.z) + f(M.c2.z·M.c2.z))                  // 0x14020fac1–0x14020fac9
y  = atan2f(−M.c0.z, sqrtss(n))                              // 取反是 xorps 0x140492ff0（−0.0），精确；n < 0 时改调 CRT 0x14041ad10（不会发生）
sz = sinf(z); cz = cosf(z)                                   // 0x14041a9c0 / 0x14041a2e0
x  = atan2f(f(f(sz·M.c2.x) − f(cz·M.c2.y)), f(f(cz·M.c1.y) − f(sz·M.c1.x)))   // 0x14020fb09–0x14020fb2c
返回 Vec3(x, y, z)                                           // 0x14020fb39：[0] x、[4] y、[8] z
```
- **单位**：弧度（没有乘 `57.29578`）。范围 `z ∈ (−π, π]`、`y ∈ [−π/2, π/2]`、`x ∈ (−π, π]`。
- **顺序**：对 `R = Rz·Ry·Rx` 是精确的逆（`R.c0 = (cy cz, cy sz, −sy)`，`R.c1.z = sx cy`，`R.c2.z = cx cy`，`sz R02 − cz R12 = sx`，`cz R11 − sz R01 = cx`），与物理的 `euler(M)`（rea-p12-attach-physics 2.4）相同。`|y| > π/2` 的输入读回成等价的另一组角：`(0, 2, 0)` 读回 `y = π − 2`、`z = π`、`x ≈ −π`（`sinf(f(π))` 约 −8.7e−8 的残差决定 x 的符号）。
- **缩放**：不归一化。列缩放 `(S0, S1, S2)` 时 `z` 不变，`y = atan2(S0·sy, cy·√(S1²·sx² + S2²·cx²))`，`x = atan2(S2·sx, S1·cx)`：均匀缩放不影响，非均匀缩放让 x / y 失真；负缩放会翻转。
- 名字路径（`0x14020fbe4` 起）逐条相同。

### 4.2 `setLocalBoneAngles`（`0x14020fce0`），`v = arg[1]`（缺参 = `(0,0,0)`）

```text
cz = cosf(v.z); sz = sinf(v.z); cy = cosf(v.y); sy = sinf(v.y); cx = cosf(v.x); sx = sinf(v.x)    // 0x14020fd8c–0x14020fdcb
Local[i].c0 = ( f(cy·cz),                    f(cy·sz),                    −sy,       0 )
Local[i].c1 = ( f(f(f(sy·cz)·sx) − f(cx·sz)), f(f(f(sy·sz)·sx) + f(cx·cz)), f(sx·cy), 0 )
Local[i].c2 = ( f(f(f(cx·cz)·sy) + f(sx·sz)), f(f(f(cx·sz)·sy) − f(sx·cz)), f(cx·cy), 0 )
Local[i].c3 不动
FUN_14020db40(L, i)
```
- 地址：整数路径 `0x14020fdd0`–`0x14020fe9a`，名字路径 `0x14020ff97`–`0x14021005e`，运算与结合顺序逐条相同（乘法交换不影响 float32 结果，结合顺序已按汇编写出）。
- 就是 `Rz(v.z)·Ry(v.y)·Rx(v.x)`，单位弧度。**原来的缩放与剪切丢掉**（前三列整个重写，w 写 0）；平移与 `c3.w` 保留。

## 5. `get/setLocalBoneOrigin`（静态确认）

- `getLocalBoneOrigin`（`0x1402100d0`）：返回 `Vec3(Local[i].c3.x, c3.y, c3.z)`（`0x14021013a`–`0x140210159`）。
- `setLocalBoneOrigin`（`0x140210250`）：`v = arg[1]`（缺参 `(0,0,0)`），`Local[i].c3.xyz = v`（`0x1402102e5`–`0x1402102f1`），`c3.w`、旋转、缩放不动，再 `FUN_14020db40(L, i)`。

## 6. `getBoneIndex` / `getBoneParentIndex`（静态确认）

```c
// getBoneIndex（0x140210790）
*ret = -1;                                                // 0x1402107a0，在一切判断之前
if (!P || !P+8 || !(type & 0x200) || s[0] == 0) return;
for (i = 0; i < count(P+0x38); i++) if (bone[i].name == s) { *ret = i; return; }   // FUN_14000d010：先比长度再 memcmp

// getBoneParentIndex（0x140210860）
*ret = -1;                                                // 0x14021086d
if (!P || !P+8) return;
if (type & 8) { i = int; if (i < 0 || i >= count(P+0x38)) return; p = bone[i].parent; if (p != -1) *ret = p; }
else if (type & 0x200 && s[0] != 0)
    for (i = 0; i < count(P+0x38); i++)
        if (bone[i].name == s && bone[i].parent != -1) { *ret = bone[i].parent; return; }   // 0x14021094d–0x14021096f
```
- 两个都不看 `P+0x2c8` / `P+0x340`：**`init` 里、第一次推进之前、静态 puppet 上都能用**。
- `getBoneIndex`：区分大小写、取第一个、骨骼名是 MDLS 里的原文（`3359451610` 全是空串，这时任何名字都 −1，空串本身也 −1）。
- `getBoneParentIndex`：整数按**骨骼数**判界（不是姿势数）；名字路径跳过同名的根骨骼、继续找下一个同名的（只在同名骨骼并存时可见）。父下标是 u32 原样返回。

## 7. 下一帧：推进怎么覆盖（静态确认）

图像层更新 `FUN_1401fdf90`（rea-p12-runtime 2；只在 `FUN_1402076e0` 通过时，即有蒙皮的 puppet）：
1. 惰性重建（骨骼数 ≠ `count(P+0x2c8)`，即第一次）：重建全部缓冲；**静止 SoA**（`P+0x230`）从 `P+0x50[i]`（非空）或骨骼 `+0x20` 分解（`0x1401fe2d3`–`0x1401fe65d`）。以后不再重建，**不读 `P+0x310`**。
2. 每帧：`P+0x398 = 0`、`P+0x3a0` 全清 0（`0x1401fecba`–`0x1401fecf9`，两条分支在 `0x1401fec8d` 汇合后无条件执行）→ 逐层推进与混合（来源是静止 SoA，不是上一帧的任何结果）→ 事件、播完回调、删层 → 交换 `P+0x340 ↔ P+0x348`（`0x1402003f0`）→ 取 `W` →
3. 分叉 `0x140200504`（`r14 & 1` = 本帧有可见层处理过）：
   - **无可见层**（`0x1402037ef` 起）：`dil = P+0x50.empty()`（`FUN_1401d76a0`），每根骨骼 `Local[i] = dil ? bone[i]+0x20 : P+0x50[i]`（`0x140203852`–`0x1402038a6`，64 字节拷贝），再仿射父链、`World = W·Pose`、物理（第二份）。
   - **有可见层**（`0x1402006c0` 起，逐骨骼）：`Local[i] = mat4_cast(q)`（`0x140215200`）三列各乘 `S`（`FUN_14005eb60` ×3）、第 4 列 `(T, 1)`（`0x14019d450`），拷进 `P+0x310[i]`（`0x140200b4a`–`0x140200c2a`），再仿射父链、约束、`World`、物理、IK。`bone+0x64 & 2` 且 `+0xd4 < 0` 的骨骼走 `0x1402006dc` 另算 `P+0x310`（语料 0 根）。
4. 蒙皮 `K = Pose·绑定逆`（仿射，`0x140205360`）。

所以：
- 上一帧 `setLocal*` 写的 `P+0x310`、重算出的 `Pose` / `K`，**全部被覆盖**，与有无动画层无关。
- 有动画层时写入**不参与混合**：既不是第一层的来源（来源是静止 SoA），也不叠进层。效果是「本帧推进之后再覆盖一次」。脚本每帧 `get → 改 → set` 时，`get` 读到本帧动画的局部，所以效果是**叠在动画之上**；脚本用固定基准（如 `3820240793` 在第一帧取的 `base`）每帧 `set` 时，被写的骨骼**完全盖掉动画**，没被写的子骨骼仍按自己的动画局部、但挂在被写的父姿势上。
- 唯一跨帧的残留：`setLocal*` 重算写进 `P+0x340` 的 `World[j]`，经第 2 步的交换成为本帧物理的 `Mp`（第 8.1 节）。
- WPE 没有「上次是静止就跳过」的逻辑：无层路径每帧全量重算，绘制每帧上传整个 `P+0x2f8`（rea-p12-runtime 6.3）。

## 8. 和已有功能的交互

### 8.1 物理（静态确认 + 推断）
- 推进里物理把增量右乘在 `Pose` 上（`Pose[i] = Pose[i]·D`），**不写 `P+0x310`**（`FUN_1401fdf90` 里 `+0x310` 只有第 7 节列的写点）。`FUN_14020db40` 只从 `Local` 重算，所以**子树里开物理的骨骼当帧画的是不含 `D` 的姿势**，它的子孙也跟着回到无物理的位置【静态确认】。
- 物理状态 S 不变（本帧已在推进里更新过）；`World[j]` 是不含 `D` 的 `W·Pose`，下一帧成为 `Mp`。效果同 rea-p12d-bones 4.3 的「改写上一帧的结果」：`t` 骨骼下一帧 `e = (o + off − Mp.o)·k`，`Mp.o` 是脚本姿势的位置；`r` 骨骼按脚本姿势的尖端算惯性【推断，按公式推】。
- 脚本每帧对某根骨骼（或其祖先）`setLocal*` 时，那根骨骼的物理**每帧都在算、但永远画不出来**；停写的那一帧起才看到物理输出，从积累的状态出发【推断】。
- `getLocalBoneTransform` 读到的物理骨骼局部不含 `D`（`P+0x310` 本来就没有 `D`）【静态确认】。
- IK（`+0xd4 ≥ 0`）、约束（`+0xd8`）的结果同样在重算子树里丢掉（语料 0 处）【推断：IK 函数没读，按「重算只读 `Local`」推出】。

### 8.2 `setBoneTransform`（静态确认）
- `setBoneTransform(i, M)` 写 `World[i]`、`Pose[i] = W⁻¹·M`、`K[i]`，不写 `Local[i]`（rea-p12d-bones 4.1）。
- 之后 `setLocal*(i 或其祖先)`：从 `Local` 重算，`setBoneTransform` 的效果被冲掉。
- 之后 `setLocal*(i 的子孙 c)`：`Pose[c] = Pose[parent(c)]·Local[c]` 读的是 `setBoneTransform` 写的 `Pose[i]`（若 `parent(c) = i`），**子孙跟着 `M` 走**——单独 `setBoneTransform` 做不到这一点。
- 先 `setLocal*(i)` 再 `setBoneTransform(i, M)`：`i` 是 `M`，子孙停在 `setLocal*` 的重算结果（不跟 `M`）。
- `getBoneTransform(j)` 在 `setLocal*` 之后读到重算的 `World[j]`（用调用时刻的 `W`）。

### 8.3 挂点（推断）
- 挂点子对象读 `Pose[骨骼]`（`FUN_1401fd5c0`，rea-p12-attach-physics 1.2），世界矩阵每帧第一次被要时算并缓存到帧末（1.3）。
- 图像层 / 文本子对象在绘制时才要 → 看得到本帧 `setLocal*` 的姿势。粒子子对象在推进循环里（父 puppet 之后、脚本之前）就要 → 看到的是推进刚复位的静止 / 动画姿势，**每帧重写的脚本姿势永远看不到**，只写一次的也看不到。
- 脚本 `getAttachmentMatrix` 在 `set` 之后调，读到新 `Pose`。

### 8.4 骨骼透明度、变形、绘制顺序、裁切（静态确认）
`FUN_14020db40` 与三个 `set` 都不碰 `P+0x268`、`P+0x398` / `P+0x3a0`、`P+0x280` / `P+0x298` / `P+0x430`。骨骼局部的改动不触发重排。

### 8.5 调用时刻（推断，由帧内时序推出）
| 在哪调 | 帧内位置 | 结果 |
|---|---|---|
| `update`、计时器、光标回调、媒体回调 | 全部对象推进之后、渲染之前（`0x1401802d5` / `FUN_140171440`） | 当帧画出，下一帧推进复位 |
| `animationEvent`、`addEndedCallback` 回调 | 在 puppet 自己的推进里，交换与逐骨骼循环**之前**（rea-p12f 概括 2c） | 写的 `P+0x310` / `Pose` / `K` 随即被本帧的逐骨骼循环覆盖，画面上看不到；重算写进 `P+0x340` 的 `World` 经交换成为**本帧**物理的 `Mp`。第一帧时 `P+0x340` 还没分配，直接失败 |
| `applyUserProperties`（若在 `0x140180d0c` 的排队改值里派发） | 渲染之后 | 下一帧推进先覆盖，画面上看不到 |
| `init` | 第一次推进之前 | 失败（`getBoneIndex` / `getBoneParentIndex` 除外） |

## 9. 混合形状（只记入口，静态确认）

- `getBlendShapeIndex(name)`（`0x140210400`，`0x200`）：槽先 −1；遍历网格 0（`*(P+0x18)`）`+0x68` 的变形目标表（每项 0x40，`+0x8` 是 `char*` 名字），**`_stricmp`（`0x1402c10d0`，不区分 ASCII 大小写）**，取第一个。
- `getBlendShapeWeight(x)`（`0x1402104b0`，返回 float，失败 0）：整数 `0 ≤ i < count(P+0x3a0)` → `P+0x3a0[i]`；名字同上（名字指针为空的项跳过），**不对 `P+0x3a0` 判界**。
- `setBlendShapeWeight(x, w)`（`0x1402105c0`）：`P+0x3a0[i] = w`；`|w| ≥ FLT_EPSILON`（`0x1404925e0`，NaN 也算）置、否则清 `P+0x398` 的位 `1 << (i & 31)`——32 位移位后 `cdqe` 符号扩展，`i % 32 == 31` 时置位会连带置上 bit 31–63、清位会连带清掉 bit 31–63，`i ≥ 32` 落到 `i − 32` 位。不重算任何东西。
- 每帧推进在层循环之前把 `P+0x398` 清 0、`P+0x3a0` 全清 0（第 7 节第 2 步），所以和骨骼局部一样**只管到下一次推进**；绘制在脚本之后读权重（rea-p5-mesh 2.5）【推断】。
- 不做本题，照报 `script:api:layer.getBlendShape*` 即可。

## 10. `3820240793` 按 WPE 的语义走一遍（推断）

脚本（对象 0 `visible` 的字段脚本，数据）：`init` 对 `Character_Root`、`Breathing_Chest`、`Head_Sway`、`Blink_Left`、`Blink_Right` 调 `getBoneIndex`；`update` 第一次对 `idx ≥ 0` 的取 `getLocalBoneTransform(idx).copy()` 作 `base`，之后每帧 `m = base[i].copy()`，`i == 1`、`i == 2` 再 `translate` / `rotate(弧度, Vec3(0,0,1))` / `scale`，5 根全部 `setLocalBoneTransform(idx[i], m)`。图层没有 `animationlayers`。

| 时刻 | WPE |
|---|---|
| 加载、`init` | 5 次 `getBoneIndex` 按 MDLS 名字给出下标（找不到的 −1，脚本跳过）。 |
| 第 1 帧推进 | 惰性重建；无层路径：`Local = 静止来源`、`Pose` 仿射父链、`K`、`World`；物理第一帧不算（`Mp` 为空）。 |
| 第 1 帧 `update` | `base[j] = Local[idx]` = 静止来源（`P+0x50` 为空时就是 MDLS 局部）。随后 5 次 `set`：每次写 `Local` 并重算该骨骼子树（完整 4×4、调用时刻的 `W`）。最终每根被覆盖的骨骼都是「父的当前 `Pose` · 自己当前的 `Local`」，与 5 次调用的先后无关。 |
| 第 1 帧渲染 | 画出脚本姿势：**第 1 帧就是 `pose(t₁)`，没有一帧滞后**。 |
| 第 n 帧 | 推进把 5 根的 `Local` 复位成静止来源 → `update` 用同一个 `base` 重写 → 画 `pose(tₙ)`。`base` 从不更新，没有累积。 |
| 原样写回的 3 根（`Character_Root`、两个 `Blink`） | 画面上与不写相同，但子树的 `Pose` / `K` 从仿射乘法换成完整乘法，`g_Bones` 有 1 ulp 级差异；若 `Character_Root` 是全部骨骼的祖先，整个骨架每帧都按完整乘法重算。 |
| 子树里有物理骨骼时 | 那些骨骼每帧被重算丢掉 `D`，**画面上没有物理摆动**（8.1）。 |

**两种脚本 × 三种实现语义**：

| 脚本 | WPE（当帧生效、下一次推进覆盖） | 若实现成「写入一直保持」 | 若实现成「写进 `Local`、下一次推进才重算」 |
|---|---|---|---|
| 每帧重写（本场景） | 第 1 帧起每帧 `pose(tₙ)` | 同左 | 第 1 帧画静止，之后晚一帧（`pose(tₙ₋₁)`）；而且推进照 WPE 重写 `Local` 的话写入根本到不了画面 |
| 只在第 N 帧写一次 | 只有第 N 帧是脚本姿势，第 N+1 帧回静止 / 动画 | 第 N 帧起一直停在脚本姿势 | 第 N 帧不变、第 N+1 帧也被覆盖（看不到） |

本场景只靠「每帧重写」，三种语义里前两种画面相同；区别只在「只写一次」的脚本、`g_Bones` 的舍入与物理骨骼。

---

## 对实现的含义

### 运行时数据
- 给图像层 puppet 运行时加一份**持久的局部矩阵** `local`（每骨骼 16 个 f32，WPE `P+0x310`）。`skinMatrices` 现在用的是临时 `scratch.local`，要改成每次推进对**全部**骨骼写进 `local`：无可见层时拷 `restMatrices[i]`，有可见层时是 `trsMatrix(pose[i])`；之后的父链、物理照旧（物理增量只进 `world`，不进 `local`）。
- **静止捷径**（`restSkin && !physics.active`）照旧，但任何 `setLocal*` 之后必须 `runtime.restSkin = false`，让下一帧走完整推进、把 `local` / `world` / `skin` / `cur` 全部复位（WPE 每帧复位；不清这个标志的话「只写一次」的脚本姿势会一直留着）。
- 推进不读 `local` 做混合，`local` 也不进静止 SoA。

### 方法（只挂图像层，`installBones` 旁边；模型对象、文本层等不加）
```ts
getBoneIndex(name: unknown): number
  // typeof name === "string" && name !== "" 才查；骨骼表第一个全名相等的下标（区分大小写）；否则 −1
  // 不要求推进过：init 里、静态 puppet 上都能用（静态 puppet 的骨骼名也要编进来）；非 puppet −1
getBoneParentIndex(bone: unknown): number
  // Int32：0 ≤ i < 骨骼数 → parent[i]（根 −1）；非空字符串：第一个名字相等且 parent ≠ −1 的骨骼的 parent；其余 −1
getLocalBoneTransform(bone): Mat4         // 选骨同 getBoneTransform（推进过、Int32 判界、名字取第一个、空串失败）；local[i] 的拷贝；失败单位阵
getLocalBoneAngles(bone): Vec3            // 第 4.1 节，弧度；失败 Vec3(0,0,0)
getLocalBoneOrigin(bone): Vec3            // local[i] 的 12..14；失败 Vec3(0,0,0)
setLocalBoneTransform(bone, m)            // m 缺省 / 非对象 → 单位阵（照写）；local[i] = m；recompute(i)
setLocalBoneAngles(bone, v)               // v 缺省 / 非对象 → (0,0,0)（照写）；第 4.2 节重写 0..11（3、7、11 写 0），12..15 不动；recompute(i)
setLocalBoneOrigin(bone, v)               // 同上缺省；local[i][12..14] = v；recompute(i)
// 都不抛错；选骨失败什么都不做
```
```ts
function recompute(rt, i, W /* 调用此刻图层画自己的矩阵（drawMatrixOf，含 alignment） */) {
  const dirty = new Set<number>();
  for (let j = i; j < rt.bones; j++) {
    const p = rt.skeleton.parents[j];
    if (j !== i && !dirty.has(p)) continue;
    dirty.add(j);
    p < 0 ? rt.world.set(local[j]) : mulFull(rt.world, p, local, j, → rt.world[j]);   // 完整乘法，不是 mulAffine
    mulFull(rt.world[j], invBind[j]) → rt.skin[j] 的 12 个 f32
    mulFull(W, rt.world[j]) → physics.cur[j]                                      // 下一帧的 prev
  }
  rt.restSkin = false;
}
```
- `mulFull` 的结合顺序已与 WPE 相同（`((A0·b0 + A1·b1) + A2·b2) + A3·b3`）。
- 子树里物理骨骼的增量自然丢掉（从 `local` 重算），这正是 WPE 的行为；不要在重算里补跑物理。
- `W` 要调用时刻的：宿主需要给一个「此刻的图层矩阵」入口（`PuppetSink.world` 现在在推进时调，脚本阶段再调一次即可）。现有 `setBoneTransform` 用的是推进时的 `physics.layerWorld`，与 WPE 有同样的细小差别，可顺手改。
- 蒙皮上传在脚本之后取（`setBoneTransform` 已依赖这一点），`setLocal*` 当帧生效不需要额外处理。
- Angles 的数学：`Math.atan2` / `Math.sin` / `Math.cos` 后 `fround`，`sqrtss` 用 `fround(Math.sqrt(x))`（float 输入的平方根经双精度再舍入不会出错）；CRT 的 `atan2f` / `sinf` / `cosf` 偶有 1 ulp 不同，按 P4 的「近似不复刻」处理。
- Vec3 实参：对象逐分量 `typeof === "number" ? fround : 0`，非对象 `(0,0,0)`；Mat4 实参沿用 `setBoneTransform` 的转换。
- 能力表：从 `compile/scriptApi.ts` 的缺失表删掉这 8 个；`getBlendShapeIndex` / `getBlendShapeWeight` / `setBlendShapeWeight` 继续照报。
- 挂点：粒子子对象若在脚本之前就取父骨骼姿势，现有实现自然得到 WPE 的结果（看不到脚本姿势）；图像层子对象若在推进时就缓存了挂点矩阵，需要在 `setLocal*` 后失效（看实现的缓存点，未核对）。

## 未知与建议实测

### 没查清的
1. **`3820240793` 的 mdl**（工坊内容，本轮不读）：5 个名字是否都在、骨骼层级（`Character_Root` 是否全体祖先）、有没有物理骨骼、`P+0x50` 是否非空。请主会话用 `kbp content` 查；有物理骨骼时第 10 节最后一行是关键差异。
2. **`init` 先于第一次推进**：沿用 rea-p12d-bones 的推断，没核对 `init` 与第一次 `FUN_1401fdf90` 的先后；对本场景无影响（`init` 只调 `getBoneIndex`）。
3. **挂点子对象**（8.3）：图像层 / 粒子子对象何时第一次求世界矩阵，沿用 rea-p12-attach-physics 1.3 的推断。
4. **事件回调、`applyUserProperties` 里调 `set`**（8.5）：按帧内地址推出，`applyUserProperties` 是否在 `0x140180d0c` 派发没核对。
5. **IK 函数**（`FUN_14026f4c0` 等）是否另写 `P+0x310`：没读（语料 0 条 IK 链）。
6. **CRT `atan2f` / `sinf` / `cosf` 的逐位行为**：没逐位复刻，按 1 ulp 内处理。
7. 混合形状的绘制读取时机只按 rea-p5-mesh 推断。

### 建议实测（主会话：`kbp gen` 的 puppet mdl 编码 + wpe-renderdoc；日志用 `console.log` 打 `[kbp]` 行，`g_Bones` 从抓帧取）
测试 puppet：3 根骨骼 `b0`（根）→ `b1` → `b2`，另一根独立的根 `c0`；MDLS 局部各带平移，`b1` 带 30° 旋转与缩放 `(2, 1, 1)`；无动画层（另一份带一条 loop 动画，见用例 4）。

1. **读回与失败值**：非 puppet 图像层上 `getBoneIndex('b0')`、`getBoneParentIndex(0)`（预期 −1、−1）、`getLocalBoneTransform(0)`（单位阵）、`getLocalBoneAngles(0)` / `Origin(0)`（`(0,0,0)`）。puppet 上：`init` 里 `getBoneIndex('b1')`（1）、`getLocalBoneTransform(0)`（单位阵）；第一次 `update` 里 `getLocalBoneTransform(1)`（与 mdl 的 MDLS 局部逐字节相同）；`getBoneIndex('B1')`、`getBoneIndex(1)`、`getBoneIndex('')`（−1）；`getBoneParentIndex(0)`（−1）、`(2)`（1）、`('b2')`（1）、`(99)` / `(1.5)`（−1）；`getLocalBoneTransform(99)` / `(1.5)` / `('')` / `(-1)`（单位阵）。区分：失败返回单位阵 vs `null`、−1 vs 0。
2. **当帧 vs 下一帧、只管一帧**：只在第 N 帧 `update` 里 `setLocalBoneOrigin(0, 原点 + (100, 0, 0))`，紧接着打 `getLocalBoneOrigin(0)`、`getBoneTransform(2)`。预期：同帧读回新原点、`b2` 的世界矩阵已平移（子树当场重算）；抓第 N 帧 `g_Bones[0..2]` 全部平移、`c0` 不变；第 N+1 帧 `getLocalBoneOrigin(0)` 回到 MDLS、`g_Bones` 回到静止。
3. **每帧写的首帧**：同上但每帧都写，抓第 1 帧：预期第 1 帧就是平移后的姿势（无一帧滞后）。
4. **有动画层**：`b1` 一条 loop 旋转动画。(a) 每帧 `get → rotate 0.1 → set`：预期动画 + 恒定偏移；(b) 第一帧取 `base` 之后每帧 `set(base)`：预期 `b1` 动画被冻住，`b2` 若有自己的轨道仍在动；(c) 只在第 N 帧 `set`：第 N+1 帧动画接着播、时钟没停。同时打 `getLocalBoneTransform(1)` 与 `posemodel.py` 的 `trsMatrix` 比。
5. **Angles 单位与顺序**：`setLocalBoneAngles(0, new Vec3(0, 0, 1.5707964))`，预期转 90°（不是 1.57°）；`new Vec3(0.3, 0.4, 0.5)` 后读 `getLocalBoneTransform(0).m`，与 `Rz·Ry·Rx` 逐项比（区分 XYZ / ZYX）；`(0, 2, 0)` 读回 `getLocalBoneAngles`，预期 `y = π − 2`、`z = π`、`x ≈ −π`。
6. **Angles 丢缩放、读回失真**：对 `b1`（30° 旋转、缩放 `(2,1,1)`）先 `getLocalBoneAngles(1)`（预期 `(0, 0, 0.5235988)`，缩放不影响 z）；再 `setLocalBoneTransform(1, Rx(0.5)·S(1, 2, 1))` 后读 Angles（预期 `x = atan2(sin 0.5, 2·cos 0.5) ≈ 0.2667` 而不是 0.5）；最后 `setLocalBoneAngles(1, new Vec3(0.5, 0, 0))`：预期缩放没了（`g_Bones` 各列长度为 1）、平移不变。
7. **Origin 只改平移**：`setLocalBoneOrigin(1, v)` 后读 `getLocalBoneTransform(1)`：旋转 / 缩放列逐字节不变、`m[15]` 不变。
8. **缺参照写**：`setLocalBoneTransform(0)`（预期 `b0` 局部变单位阵、骨架跳到 puppet 原点）、`setLocalBoneTransform(0, 5)`（同）、`setLocalBoneAngles(0)`（旋转归零）、`setLocalBoneOrigin(0)`（原点归零）、`setLocalBoneTransform('', m)` / `(1.5, m)`（无变化）；全部不抛错。
9. **物理骨骼被丢 `D`**：`b2` 开 `t + se`（照 `3359451610`：`ts 300`、`tf 5`、`ti 30`、`tm 200`），图层用关键帧来回平移激发物理。(a) 每帧 `setLocalBoneTransform(0, base0)`：预期 `g_Bones[2]` 没有物理偏移；(b) 只写不相关的 `c0`：物理照常；(c) (a) 在第 M 帧停写：第 M 帧起物理输出出现、从积累的状态出发。
10. **与 `setBoneTransform` 的先后**：同一帧 `setBoneTransform(1, M)` 再 `setLocalBoneTransform(2, getLocalBoneTransform(2))`：预期 `b2` 跟着 `M`；反过来先 `setLocal(2)` 再 `setBoneTransform(1, M)`：`b2` 不跟。
11. **挂点**：`b1` 上挂一个小图像层与一个粒子发射器，每帧 `setLocalBoneOrigin(1, …)` 摆动：预期图像层跟、粒子发射点停在静止位置。
12. **调用时刻与 `W`**：(a) 在 `animationEvent` 回调里 `set`：预期画面不变；(b) 同一帧先 `thisLayer.origin = …` 再 `set`：预期子树 `getBoneTransform` 用新原点、子树外的骨骼用旧的。另外用无脚本与「每帧原样写回」两份工程逐位比 `g_Bones`：预期后者在子树上有 1 ulp 级差异（完整乘法 vs 仿射乘法），用来确认实现必须用 `mulFull`。
