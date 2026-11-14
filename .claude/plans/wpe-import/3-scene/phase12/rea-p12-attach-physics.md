# REA：P12 步骤 0 —— 挂点、骨骼物理（含 IK 的中性判断）与脚本 API（WPE 2.8.42 `wallpaper64.exe` / `scenescript64.dll`）

> 读码代理产出。只做静态分析，没有运行、附加或改动 WPE。
> 置信度三档：
> - **静态确认**：汇编直接看到。
> - **推断**：由代码推出，但缺一环（例如没逐个核对调用点、没实测）。
> - **未知**：查到某处为止，没有结论。
>
> exe 地址以 `0x140000000` 为基址，`scenescript64.dll` 地址以 `0x180000000` 为基址。汇编、字符串只当数据看。
> 本文的「矩阵」一律按列向量写：WPE 内存里 4×4 的第 i 行是矩阵的第 i 列（与 rea-p4a A1、rea-p5-mesh 2.3 同一约定），`f(out, A, B)`（`FUN_14005ecb0`）= `A·B`。

## 方法

- **分析副本**：`ignore\p9\rea\wallpaper64.exe`，SHA-256 `40e2ce021e9352324fadb3b8f72b8ba2a7ee95b71cc571d5b9f84be75cd993b0`；`ignore\p10\rea\scenescript64.dll`，SHA-256 `58039ef912fcd51cd833540476e3798268158a06f63003fe94bff1b1cbeaad08`。开工时与安装目录原件逐个 `sha256sum`，一致。
- **REA 没用上**：从 `ignore\p10\rea\wallpaper64-2.8.42-p10.rea-snapshot` 打开后，三次反编译请求都因 Ghidra 启动分析超时（330 s，每次都重新全量分析）失败，随后 `close_binary`（没有可存的分析，所以**没有另存** `wallpaper64-2.8.42-p12-attach.rea-snapshot`）。全部结论来自全量反汇编 `ignore\p4\rea\wp.asm` 和 `llvm-objdump`（dll 只反汇编了 `0x181600000`–`0x181680000`）。
- **脚本**（`ignore\p12\rea\attach\`）：
  - 从 `ignore\p10\rea\` 拷来、改成绝对路径的：`pe.py` `fn.py` `strs.py` `xr.py` `slice.py` `grepfn.py` `gall.py` `ptr.py` `rd.py` `vtdump.py` `dpe.py` `dxref.py` `jt.py` `f32.py` `wstrs.py`。
  - 新写的：`keys.py`（列一段汇编里 `lea r8/rdx` 引用的字符串）、`methods.py`（从方法登记函数抽「名字 → 原生函数、返回类型、参数类型」）、`physcorpus.py`（用 mdl 代理的 `ignore\p12\rea\mdl\mdl12.py` 扫语料里的物理骨骼、IK 记录、挂点 → `physcorpus.json`）、`showphys.py` / `showbones.py`、`attcheck.py`（挂点子对象与父的先后、`origin` → `attcheck.txt`）、`mdatshow.py`（挂点矩阵与所挂骨骼的绑定姿势）、`physmodel.py`（第 2 节的 float32 模型，输出 `physmodel_out_30.json` / `physmodel_out_60.json`）。
- **汇编摘录**（`asm\`）：`worldmat_1401850a0.asm`（基类世界矩阵）、`imagelayer_load_1401fbae0.asm` / `imagelayer_load2_1401fc260.asm`（图像层加载 puppet）、`bonejson_140265c30.asm`（骨骼 JSON）、`imagelayer_update_1401fdf90.asm`（图像层每帧更新全段，7500 行）、`phys_14020134a.asm`（物理第一份）、`phys2_140203c32.asm`（物理第二份）、`imagelayer_methods_1402110be.asm`（图像层脚本方法登记）、`ianimlayer_register_14026c980.asm`（`IAnimationLayer` 登记）、`animlayer_json_1401fcc20.asm`（`animationlayers` 一项）、`baseobj_attach_methods.asm`（对象挂点方法登记）、`createlayer_14020ea30.asm`、`dll_1816.asm`（dll 一段）。
- **锚点**：
  - 字符串 `attachment`（`0x140490258`）只被基类加载 `FUN_1401de470` 引用；`getAttachment*` 只被基类登记 `FUN_1401e0530` 引用。
  - 骨骼 JSON：`FUN_140265c30` 唯一调用点 `0x1402625a9`（MDLS 段每根骨骼一次）。
  - 物理：全二进制只有四处 `test [骨骼+0x68], 0x3000`：图像层更新 `0x14020136e`、`0x140203c32`，模型对象 `0x14021d702`、`0x14021fd4b`（`0x14021b4dc` 在模型加载里）。本文读的是图像层的两份。
  - 脚本：`getAnimationLayer` 等名字只被图像层登记 `FUN_1402110be` 和模型登记 `FUN_140227470` 引用；`addEndedCallback` / `blendtime` 引向 `IAnimationLayer` 登记 `FUN_14026c980`。
- **结构的叫法**（没有 RTTI，名字按行为起）：
  - **L**：图像层对象。`L+0x180` 父对象，`L+0x188` 父 id，`L+0x190` 挂点下标（-1 = 没有），`L+0x198`..`+0x1a0` 子对象向量，`L+0xd0` 世界矩阵缓存的帧号，`L+0xe0` 世界矩阵缓存，`L+0x4b8` puppet 对象 P。
  - **P**：puppet 对象（图像层 `+0x4b8`）。`P+0x8` 起是 mdl 加载结果（mdl 代理的 `mdl+…` = `P+8+…`）：`P+0x38` 骨骼向量（每根 0xf0）、`P+0xb0` 挂点向量（每项 0x68）、`P+0xc8` 动画定义（每项 0x158）。运行时：`P+0x2b0` 绑定姿势的逆、`P+0x2c8` 当前姿势（模型空间）、`P+0x2f8` 蒙皮矩阵、`P+0x340` / `P+0x348` 本帧 / 上一帧的世界骨骼矩阵、`P+0x3b8` 物理状态（每骨骼 0x50）、`P+0x3d0` 动画层指针向量。
  - **B**：骨骼（0xf0）。`+0` 名字，`+0x20` 局部矩阵，`+0x60` 父下标，`+0x64` u32，`+0x68` 物理参数块 Q（见 2.1），`+0xd4` IK 记录下标（-1 = 没有）。
  - **S**：物理状态（0x50）。
  - **A**：动画层对象（0x198，构造 `FUN_14026c680`）。

## 概括

| # | 问题 | 结论 | 置信度 |
|---|---|---|---|
| 1 | 挂点在哪读、怎么解析 | 基类加载 `FUN_1401de470` 在找到父对象之后读 `attachment`：**必须是 JSON 字符串**，经父对象虚函数 `+0x70` 按名字查，结果存 `L+0x190`。图像层的 `+0x70`（`FUN_1401fd510`）在 `P+0xb0` 的挂点表里**逐项全名比较、取第一个**；没有 puppet、名字查不到都返回 -1。粒子、文本、分组等用基类 `+0x70` 的对象恒返回 -1。-1 时就是普通父子关系。**父在 `objects` 里排在子后面时挂点丢失**：第一遍找不到父，第二遍补父时（`0x140188035`）挂点下标直接写 -1。语料 161 个挂点子对象全部排在父后面。 | 静态确认；语料先后为样本 |
| 2 | 子对象世界矩阵 | `W_子 = W_父 · Pose[骨骼] · Att · L_子`。`W_父` 是父的**基类**世界矩阵（不含图像层 `alignment` 偏移，也不含 `size`）；`Pose` = `P+0x2c8[骨骼]`，即骨骼在 puppet 网格空间里的**当前姿势**（父链乘过、物理之后），不是蒙皮矩阵；`Att` 是 `MDAT` 里该挂点的矩阵（相对骨骼）；`L_子 = T·Rz·Ry·Rx·S`。没有任何 `size / 纹理尺寸` 换算。`P+0x2c8` 为空（puppet 还没更新过、或没有骨骼）时这一步整个跳过。有挂点的对象世界矩阵缓存只在本帧内有效，每帧重算。 | 静态确认；`Att` 相对骨骼为推断（语料取值相符） |
| 3 | 子对象是粒子 / 别的 | 粒子、文本、分组都用基类 `FUN_1401850a0`，所以发射器、局部控制点、文本、分组的子孙都跟着挂点走；声音没有画面。粒子不能当挂点的父（`+0x70` 恒 -1）。模型对象也有自己的挂点查找（`+0x70` = `0x1402248c0`）。 | 静态确认（虚表）；粒子的发射细节为推断 |
| 4 | 时机 | puppet 的动画、物理都在图像层更新 `FUN_1401fdf90` 里，即场景对象更新循环 `FUN_1401891a0`（粒子模拟同一个循环、脚本之前）。子对象的世界矩阵在本帧第一次被要时算：子对象在更新列表里排在父 puppet 之后时用本帧姿势，之前时整帧用上一帧的姿势。 | 位置静态确认；更新列表即 `objects` 顺序为推断 |
| 5 | 骨骼 JSON | `FUN_140265c30` 读 30 个键（表见 2.1）。**`a`、`s`、`ikcp`、`ikcpn`、`ikrmin`、`ikrmax` 不读**（exe 里没有后四个字符串；JSON 文本解析完即丢）。**物理只有在 `(r 或 t) 且 (se 或 re)` 时才开**；否则（又不是 `ik`）连 `r`、`t` 一起清零。`lamin` / `lamax` 只在 `la` 为真时读，`ltmax` 只在 `lt` 为真时读，`rax/ray/raz`、`tax/tay/taz` 三个都在且都是布尔时才读、为假的那根轴锁住。 | 静态确认 |
| 6 | 语料里实际开着的物理 | 14 根 `r`/`t` 骨骼里只有 **8 根**真的开：`2345214324` 的 1–4（`r`+`re`）、`3426865175` 的 0（`r`+`re`+`ge`+`la`）、`3554161528` 的 30（`t`+`se`）、`3577990983` 的 82、83（`r`+`se`+`la`）。`3829467967` 的 12 号、`2345214324` 的 5 号、`3426865175` 的 1–3、`3577990983` 的 11 号都只有 `r`，物理不开。**P12d 只涉及 4 张场景**。 | 静态确认 + 语料 |
| 7 | 求解器 | 每根骨骼一个状态：角速度四元数 `q`、相对动画姿势的欧拉角 `ang`、世界平移偏移 `off`、平移速度 `vel`。每帧在动画采样、父链之后、蒙皮之前，按骨骼下标顺序逐根算。输入是本帧的动画世界矩阵 `Mw = W·Pose` 和**上一帧物理之后**的世界矩阵 `Mp`。转动：惯性（上一帧尖端在本帧骨骼坐标里的位置）、可选的重力（`ge`）、可选的弹簧（`se`，强度 `rs`）都以「向某方向转一部分」的方式累加到 `q`，再 `slerp(I, q, min(60·dt, 1))` 积分到 `ang`；`re` **没有回弹项**。平移：`re` 只有惯性滞后，`se` 有弹簧 `ts`，半隐式欧拉。阻尼是每帧 `slerp(q, I, min(dt·rf, 1))`、`vel *= 1 − min(dt·tf, 1)`。没有子步、没有固定步长，dt 就是帧时间（`[0.0001, 0.25]`）。公式见 2.4。 | 静态确认（第一份代码全读；第二份按分支结构核对） |
| 8 | 物理状态的生命周期 | 第一次更新（骨骼数变化）时状态全部置初值、上一帧矩阵清空，**第一帧不算物理**。对象不可见照算（更新函数不看可见性），壁纸暂停时帧函数不跑、状态冻结。`resetBonePhysicsSimulation` 把状态置初值；`applyBonePhysicsImpulse` 把方向冲量直接加到 `vel`、把角冲量（度）乘进 `q`。 | 静态确认 |
| 9 | 结果写到哪 | `Pose[i] ← Pose[i] · T(Mw⁻¹·off) · R(ang)`，之后本帧的世界矩阵、子骨骼、蒙皮矩阵（`P+0x2f8 = Pose·绑定逆`）、挂点子对象都用改过的 `Pose`。 | 静态确认 |
| 10 | IK | IK 求解（`FUN_14026f4c0`）只看骨骼 `+0xd4`：MDLS v≥2 段里的 IK 链记录（mdl 代理 `mdl12.py` 的 `jlist`）点名了这根骨骼才跑，**和 JSON 的 `ik` 无关**；`ik` 只决定解析不解析 `ikd/ikg/ikr/ikrd/ikse/ikfe`（物理开着时这些一律不解析）。语料 0 条 IK 链记录，所以 IK 一次都不跑，`ik*` 键完全中性。 | 静态确认 + 语料 |
| 11 | `getAnimationLayer` | 整数：按 `P+0x3d0` 的下标（从 0）；字符串：按层的 `name`（`A+0xd8`）全名比较，**取最后一个**匹配；空串、越界、负数、没有 puppet：原生不写返回槽，dll 把空指针换成根值 `+0x378`，即 **`null`**（同一条路的 `getVideoTexture` 实测为 `null`）。所以在非 puppet 图层上 `getAnimationLayer("x").play()` 抛 TypeError。`getAnimationLayerCount` 在非 puppet 上返回 0。 | 静态确认；`null` 由同路实测推出 |
| 12 | `IAnimationLayer` | 时钟就是 P10 的 K（`A+0xf8` 起：`spf`、`t`、`D`、`flags`、`length`、事件），推进用同一个 `FUN_1401a9f60`。`fps`/`frameCount`/`duration`/`play`/`pause`/`stop`/`isPlaying`/`getFrame` 与 P10 的 `IAnimation` 逐条相同；`setFrame` 另置一位让本帧不判「播完」；`rate`/`blend`/`blendtime` 是 float 字段、`visible`/`additive`/`blendin`/`blendout` 是 `A+0xd0` 的位、`name` 是字符串，和 JSON 键、用户属性、脚本绑定走同一张描述符表。`play()` 不重新触发淡入（循环层淡入一次就清掉 `blendin` 位）。还有 d.ts 没写的 `additive`、`blendin`、`blendout`、`blendtime`。 | 静态确认 |
| 13 | `AnimationEvent` | 会发。事件来自 `MDLA` 动画定义里的事件表（建层时整表拷进 `A+0x110`），推进时按 P10 的规则收集，在 puppet 更新里逐个经 `FUN_140177ad0(…, 作用域 = 图层, 对象 = 图层, 6, json)` 派发，接收者是同一图层上导出了 `animationEvent` 的脚本。`addEndedCallback` 的回调在每次播完（循环回绕、mirror 换向、single 结束）时调。 | 静态确认；事件 JSON 的内容归 mdl 代理 |

**对 Kabegame 的直接含义**（推断，供 P12b / c / d 子计划参考）：
- 挂点就是在 P4a 的 `W_parent · L` 中间插一个 `Pose[骨骼]·Att`；父的 `W` 用不带对齐偏移的那个。
- P12d 只做 4 张场景、8 根骨骼；`r` 为真但 `se`、`re` 都假的骨骼按「物理关」处理，不要报 `puppet:physics`。
- `re` 模式没有回弹：动起来以后停在偏离的角度上，这是读码的结论，第一个实测就该验它（见「实测建议」1）。
- IK 在语料里中性，能力表只在 mdl 带 IK 链记录时报。
- `getAnimationLayer` 在非 puppet 图层上返回 `null`。

---

## 1. 挂点

### 1.1 读取与解析（静态确认）

`FUN_1401de470`（基类虚表 `0x1404903b8` 的 `+0x40`，图像层的加载 `FUN_1401fbae0` 也调它）：
```c
// 0x1401de4a7 起
pid = json["parent"]（数）；L->parentId (+0x188) = pid；L->parent (+0x180) = 场景按 id 找(pid)
if (L->parent == 0 || L->parent == L) goto 收尾;
// 组合层嵌套限制（rea-p4a A5）：祖先里 +0x120 bit2 的个数 + 子树深度 > 3 时拒绝设父：parent = 0、parentId = 0
a = json["attachment"]（缺省 ""）                     // 0x1401de5b7
if (a 的类型 == 4 /*字符串*/)
    L->attachIndex (+0x190) = L->parent->vfunc[0x70](L->parent, a.c_str())
FUN_1401dda60(L)                                     // 挂进父的子对象向量
```
- **只认字符串**：数字、`null`、对象都不写 `+0x190`，保持构造时的值（构造见 `FUN_1401de750` 等写 -1 的地方，语料 161 个全是字符串，没核对构造初值）。
- **父不是 puppet 图层**：
  - 基类 `+0x70` = `0x140014c60`：`return -1`。粒子（虚表 `0x1404915b0`）、文本（虚表 `0x140491680`，表后紧跟 `materials/fonts/fontbackground…` 字符串）、分组节点都是它；声音对象的虚表没核对。
  - 图像层 `+0x70` = `FUN_1401fd510`：`P == 0` 或 `P+8 == 0`（没有 puppet 或 mdl 没读到）返回 -1。
  - 模型对象 `+0x70` = `0x1402248c0`（模型自己的挂点查找，没读）。
- **按名字查**（`FUN_1401fd510`）：
  ```c
  for (i = 0; i < count(P+0xb0); i++)          // 每项 0x68：+0 名字 std::string，+0x20 4×4，+0x60 u32 骨骼下标
      if (strlen(name) == att[i].name.size && memcmp(...) == 0) return i;   // 第一个匹配，区分大小写
  return -1;
  ```
- **加载顺序**：
  - 对象按 `objects` 顺序逐个建立、加载。子对象排在父之后时，`FUN_1401de470` 能找到已加载好 puppet 的父，挂点正常解析。
  - 子对象排在父之前时，第一遍找不到父（`parent == 0`，跳过挂点）；加载末尾第二遍补父（`0x140187fb0`–`0x140188035`）调 `FUN_1401de750(子, 父, 0, -1)`，**挂点下标写 -1**，名字不再查。效果：退化成普通父子。
  - 语料（`attcheck.txt`）：161 个挂点子对象全部排在父之后。
- **挂点下标查不到（-1）**：`FUN_1401850a0` 在 `+0x190 < 0` 时不调 `+0x78`，按普通父子算。

### 1.2 世界矩阵公式（静态确认）

`FUN_1401850a0`（基类 `+0x80`，粒子、文本、分组也用它；图像层的 `+0x80` 是 `FUN_1401fd3f0`，只在 `L+0x4b1` 置位时在它的结果上加对齐偏移，P8）：
```c
L_local = T(origin) · Rz·Ry·Rx(angles) · S(scale)       // rea-p4a A1，存 L+0xe0
if (L->parent) {
    if (L->attachIndex >= 0)
        L->parent->vfunc[0x78](L->parent, L->attachIndex, &L_local);   // 0x1401852a6，就地改 L_local
    W = FUN_1401850a0(L->parent) · L_local;                            // 0x1401852b0：直接调基类，不走虚函数
}
```
图像层 `+0x78` = `FUN_1401fd5c0`：
```c
if (P && P+8 && idx >= 0 && idx < count(P+0xb0) && P+0x2c8 非空) {
    bone = att[idx].bone (+0x60)
    tmp  = Pose[bone] (P+0x2c8 + bone*0x40) · att[idx].matrix (+0x20)   // 0x14005ecb0
    L_local = tmp · L_local                                             // 0x14005ecb0
}
```
所以 **`W_子 = W_父(基类) · Pose[bone] · Att · T·R·S`**。

- `Pose = P+0x2c8[bone]`：骨骼在 puppet 网格空间里的当前姿势。依据：蒙皮矩阵 `P+0x2f8[i] = P+0x2c8[i] · P+0x2b0[i]`（`0x140205360` 起，`P+0x2b0` 是加载时算好的绑定姿势的逆，rea-p5-mesh 1.7）；物理把增量右乘在 `P+0x2c8` 上（2.5）。所以挂点跟着动画和物理走。
- `Att`：`MDAT` 每项的 64 字节矩阵（mdl 代理 `mdl12.py` 读进 `att[i].mat`）。语料里旋转部分都是单位阵、平移是几十到几百像素（`mdatshow.py`：例如 `3463520581` `asuna body` 的 `head` 挂在骨骼 2 上，`Att.t = (−32.5, 116.4)`，绑定姿势 `(77.5, 252.6)`，相加落在身体图内），和「相对骨骼的局部矩阵」相符【推断】。
- **没有 `size` 或纹理尺寸换算**：`FUN_1401fd5c0` 只做两次矩阵乘。`Pose` 与 puppet 网格同单位（场景像素）。
- **父的对齐偏移不传给子**：子对象调的是父的基类 `FUN_1401850a0`，不是 `+0x80`（同 P8 的结论）。脚本的 `getAttachmentMatrix` 用的却是 `+0x80`（1.6），两者在有 `alignment` 时差一个对齐偏移。
- `P+0x2c8` 为空（puppet 第一次更新之前、没有骨骼的静态 puppet）时 `Att` 也不乘，子对象按普通父子算。

### 1.3 缓存与时机

- **缓存**（`0x1401850a9`–`0x1401850ff`，静态确认）：
  - `L+0x190 >= 0`：缓存只在 `L+0xd0 == ctx+0x144`（本帧帧号，`0x14017fca7` 每帧 +1）时有效，所以有挂点的对象每帧至少重算一次。
  - 没有挂点：沿用 rea-p4a 的版本号缓存。挂点对象的子孙因为父的版本号每帧变，也每帧重算【推断】。
- **骨骼姿势在帧里的位置**（静态确认）：图像层 `+0x48`（`FUN_1401fdf90`）在场景对象更新循环 `FUN_1401891a0`（`0x1401891f0` 逐个调 `+0x48`）里跑：动画层推进与采样 → 父链 → 物理 → IK → 蒙皮矩阵。这个循环在 P10 的动画与脚本（`FUN_140171440`，`0x1401802e5`）之前（rea-p10 第 1 节）。
- **子对象什么时候取 `Pose`**【推断】：子对象的世界矩阵在本帧第一次被要时算并缓存到帧末。
  - 粒子在自己的 `+0x48`（同一个循环）里就要世界矩阵；图像层在绘制时才要。
  - 更新循环的列表 `scene+0x158` 按建立顺序排，所以子在父后时用本帧姿势；子在父前时这一帧都用上一帧的姿势（语料没有这种情况）。

### 1.4 子对象类型（静态确认 + 推断）

| 子对象 | 世界矩阵 | 跟不跟挂点 |
|---|---|---|
| 图像层（145 个） | 基类 `FUN_1401850a0`（自己的 `+0x80` 只多加对齐偏移） | 跟 |
| 粒子（9 个） | 虚表 `0x1404915b0` 的 `+0x80` 就是 `FUN_1401850a0` | 跟：发射器原点、局部空间系统、局部控制点都经 `W`（rea-p4c 的规则不变）【推断：粒子侧没重读】 |
| 分组等（7 个，语料里都是没有 `image` 的对象） | 基类 | 跟，子孙经父链继承 |
| 文本 | 虚表 `0x140491680` 的 `+0x80` 是基类 | 跟 |
| 声音 | 虚表没核对，没有画面 | 无影响 |

### 1.5 `transformAttachmentToTexture` 与 `+0x4a0/+0x4a8/+0x4b0`（只记结论）

- `transformAttachmentToTexture(attachmentLayer, attachmentName)` 是图像层方法（登记在 `FUN_1401ee520`，原生 `0x1401ed0d0`，返回 `Mat3`）。它找到另一个图层，经那个图层的 `+0x70` / `+0x78` 取挂点矩阵，再换算到本图层的纹理空间。只读，不改任何渲染状态。语料 0 处【静态确认：只看了入口与 `+0x70/+0x78` 的调用】。
- rea-p5-modelflags 把 `+0x4a0/+0x4a8/+0x4b0` 归为「木偶附件 / `transformAttachmentToTexture` 的替代材质与渲染到纹理」。这一轮查到的是：`transformAttachmentToTexture` 不碰这三个字段；`+0x4b1` 是图像层世界矩阵 `FUN_1401fd3f0` 的对齐偏移开关；`+0x4a0`/`+0x4a8` 由构造清零、在组合键函数 `FUN_140209563` 和绘制 `0x140207c47` 里读写。它们和挂点有没有关系**没查**【未知】。

### 1.6 脚本的挂点方法（语料 0 处，只记结论）

基类方法表（登记 `FUN_1401e0530`）：
| 方法 | 原生 | 做法 |
|---|---|---|
| `getAttachmentIndex(name)` | `0x1401e01d0` | `this->vfunc[0x70](name)` |
| `getAttachmentMatrix(name\|index)` | `0x1401e01f0` | `M = I`；整数直接、字符串先 `+0x70`；`+0x78(idx, &M)`；返回 `this->vfunc[0x80]() · M`（含图层对齐偏移） |
| `getAttachmentOrigin` | `0x1401e02c0` | 上式的平移 |
| `getAttachmentAngles` | `0x1401e0390` | 上式分解出的角度（没读分解细节） |

---

## 2. 骨骼物理

### 2.1 骨骼 JSON（`FUN_140265c30`，静态确认）

解析器是 rapidjson（成员值 `+0x1e` 是类型标志：`0x8` 布尔、`0x10` 数、`0x400` 字符串）。结果写骨骼 `+0x68` 起的参数块 Q。缺省值来自骨骼构造 `FUN_14026b860`。

**第一步：开关**（`0x140265c85`–`0x140265f2b`）

| 键 | Q 的位 | 说明 |
|---|---|---|
| `ik` | `0x4000` | 只决定解析不解析 IK 参数 |
| `ikce` | `0x8000` | IK 求解器读（`0x140271fbf`） |
| `r` | `0x1000` | 转动物理 |
| `t` | `0x2000` | 平移物理 |
| `se` | `0x1` | 弹簧模式（见 2.4） |
| `re` | `0x2` | 无弹簧模式（见 2.4） |

```c
phys = (Q.flags & 0x3000) && (Q.flags & 0x3)        // 0x140265f0d
if (!phys && !(Q.flags & 0x4000)) {
    if (Q.flags & 0x8000) { 读 ikrminl → Q+0x64, ikrmaxl → Q+0x68; return true; }
    Q.flags = 0; return false                          // 0x140266559：r、t 一起清掉
}
```
**所以 `r` 或 `t` 为真、但 `se` 和 `re` 都假的骨骼，物理完全不开。**

**第二步：公共参数**（`phys` 或 `ik` 时，`0x140265f31` 起）

| 键 | 写到 | 读法 |
|---|---|---|
| `ge` | `flags |= 0x4` | 布尔 |
| `gd` | `Q+0x1c..+0x24` | 字符串，三个数用空格隔开（`strtod`）；在场时先清零 |
| `m` | `Q+0x28` | 数 |
| `tf` | `Q+0x10` | 数（只有 `ik` 没有 `phys` 时改成 `clamp((tf/100)², 0, 1)`） |

**第三步 A：`phys` 时**（`0x140266587` 起；读完即返回，**IK 参数不读**）

| 键 | 写到 | 读法 / 换算 | 缺省（骨骼构造） |
|---|---|---|---|
| `rs` | `Q+0x4` | 数 | 0 |
| `ts` | `Q+0x8` | 数 | 0 |
| `rf` | `Q+0xc` | 数 | 0 |
| （`tf`） | `Q+0x10` | 第二步已读 | 0 |
| `ri` | `Q+0x14` | `1 − ri/100` | 1 |
| `ti` | `Q+0x18` | `1 − ti/100` | 1 |
| （`gd`） | `Q+0x1c` | | (0, 0, 0) |
| （`m`） | `Q+0x28` | | 1000 |
| `tp` | `Q+0x2c..+0x34`，另 `Q+0x38 = |tp|/100`（`tp` 缺时 1；运行时没有读者） | 三个数 | (0, 0, 0) |
| `tm` | `Q+0x3c` | 数 | 0 |
| `la` | `flags |= 0x8` | **只认 JSON `true`**（`cmp cx, 0xa`） | |
| `lamin` / `lamax` | `Q+0x40` / `Q+0x4c` | 三个数（弧度），**只在 `la` 为真时读** | 0 |
| `lt` | `flags |= 0x10` | 布尔 | |
| `ltmax` | `Q+0x58` | 数（度），**只在 `lt` 为真时读** | 0 |
| `rax` `ray` `raz` | 为假时 `flags |= 0x100000` / `0x200000` / `0x400000` | 三个都在且都是布尔才读 | 不锁 |
| `tax` `tay` `taz` | 为假时 `flags |= 0x800000` / `0x1000000` / `0x2000000` | 同上 | 不锁 |

**第三步 B：只有 `ik` 时**（`0x1402661c7` 起）：`ikd`（整数，≥1 → `Q+0x5c`，缺省 2）、`ikg`（`0x20`）、`ikr`（`0x40`）、`ikrd`（数，`max(x, 1)` → `Q+0x60`，缺省 50）、`ikse`（`0x80`）、`ikfe`（`0x100`）。

**不读的键**：`a`、`s`（单字母，解析器里没有；JSON 文本解析完即释放，别处拿不到）；`ikcp`、`ikcpn`、`ikrmin`、`ikrmax`（exe 里没有这些字符串，只有 `ikrminl` / `ikrmaxl`）。

骨骼 `+0xd4`（不在 JSON 里）：缺省 -1，MDLS v≥2 的 IK 链记录在加载时写（`0x140262d07`），见第 3 节。

### 2.2 每帧位置与输入（静态确认）

图像层更新 `FUN_1401fdf90`（`+0x48`）开头只判 `+0xd0`（`0x1402076e0`：有 puppet、首个网格格式带 `0x800000` 骨骼下标、骨骼非空），**不判可见性**（函数里没有 `0x140185010` 也没有 `+0x120` bit0 的判断）。

和物理有关的帧内顺序：
1. 骨骼数与 `P+0x2c8` 的大小不同（首次）：释放 `P+0x340`、`P+0x348` 置空，`P+0x3b8` 清空后按骨骼数重建（每项初值见 2.3）（`0x1401feb3b`–`0x1401febaa`）。
2. 动画层推进、采样（runtime 代理）。
3. 交换 `P+0x340` ↔ `P+0x348`（`0x1402003f0` `FUN_1402154c0`）；`P+0x340` 为空就按骨骼数分配。于是 `P+0x348` = **上一帧**的世界骨骼矩阵，首帧为空。
4. `W` = 图层 `+0x80`（含对齐偏移）；`s` = `W` 三列长度的平均：`((|c1| + |c0|) + |c2|) / 3`（`0x1402004d2`）。
5. 按骨骼下标顺序逐根（`0x1402006c0` 起；没有可见动画层时走第二份 `0x140203840` 起）：
   1. 算这根骨骼的 `Pose[i]`（模型空间，用父的 `Pose`，父已经过物理）【父链细节归 runtime 代理】；
   2. `P+0x340[i] = W · Pose[i]`（`0x14020120b`–`0x140201357`）；
   3. 物理（Q 的 `0x3000` 位，且 `P+0x348` 非空）；
   4. IK（`+0xd4 >= 0`）。
6. 蒙皮矩阵 `P+0x2f8 = Pose · 绑定逆`。

dt 是更新函数的第二个参数（`[rbp+0x11c8]`），就是 `FUN_1401891a0` 收到的 dt（`g_Frametime`，`[0.0001, 0.25]`，已含场景 rate 与暂停淡变，rea-framework Q2）。

### 2.3 状态 S（`P+0x3b8 + i·0x50`，构造 `FUN_140215ba0`，静态确认）

| 偏移 | 内容 | 初值 |
|---|---|---|
| `+0x00` | 角速度四元数 `q`（w, x, y, z），含义是「每 1/60 s 转多少」 | (1, 0, 0, 0) |
| `+0x10` | 欧拉角 `ang`（x, y, z，弧度），相对本帧动画姿势的转动，`R = Rz·Ry·Rx`（与对象 `angles` 同一公式） | 0 |
| `+0x1c` | 平移偏移 `off`（世界坐标） | 0 |
| `+0x28` | 平移速度 `vel`（世界坐标） | 0 |
| `+0x34`–`+0x4f` | 物理代码没读到 | 0 |

### 2.4 求解（第一份 `0x14020136e`–`0x14020364e`，静态确认）

记号：`Mw = W·Pose[i]`（本帧动画，物理之前），`o` 是它的平移，`A = Mw` 的 3×3，`A⁻¹` 用叉积 / 行列式求（`0x140201446`）；`Mp = P+0x348[i]`（上一帧，物理之后）。常数：`DEG = 0.017453292`、`RAD = 57.29578`。所有乘加都是 float32。辅助函数：`slerp` = `FUN_140216070`（点积 < 0 时翻转，> 0.999999881 时线性插值不归一，否则 `acos`/`sin` 标准式）；`rotTo(a, b)` = `FUN_1402167c0`（把 a 转到 b 的最短弧，点积 ≥ 0.999999881 时单位四元数）；`⊗` = `FUN_140215380`（Hamilton，`a ⊗ b`）；`quatMat` = `FUN_140216280`；`euler(M)` = `0x140201e04`–`0x140201fd5`（`z = atan2(M10, M00)`，`y = atan2(−M20, √(M22² + M21²))`，`x = atan2(sz·M02 − cz·M12, cz·M11 − sz·M01)`）；`eulerQuat(h)` = 半角 h 对应 `Rz·Ry·Rx` 的四元数（`0x140202108` / `0x140202b25`）。

```text
// 准备（0x14020138d–0x1402019de）
dl   = A⁻¹·(Mp·tp − o)                 // 上一帧的尖端，表达在本帧动画骨骼里
offl = A⁻¹·off
tip  = R(ang)·tp
tgt  = tip + offl
if ge:                                   // flags & 4
    g   = (A⁻¹·gd) · (m·s)
    n   = tip / |tip|
    g  -= (n·g)·n                        // 只留垂直于骨骼的分量
    tgt -= g
    if t: vel += gd · (m·dt·1000)        // 世界坐标，不乘 s
dist = min(|tgt − dl|, 900·dt)
qa   = rotTo(tgt/|tgt|, dl/|dl|)         // 把「当前 + 重力」的方向转向上一帧尖端

// 转动（r 为真时；re 走 0x140201a37，se 走 0x140202a44）
q = q ⊗ slerp(I, qa, min(dist·(1−ri/100)·DEG, 1))           // 惯性 + 重力：距离（像素）当作度数折成插值比例
if se:
    q = q ⊗ slerp(I, eulerQuat(−ang/2), min(rs·DEG·dt, 1))   // 弹簧：拉回 ang = 0
if lt:                                                         // 每轴角速度限幅
    对 c ∈ (x, y, z)：deg = clamp(2·atan(c/w)·RAD, −ltmax, ltmax)；c' = tan(deg·DEG·0.5)
    q = normalize(1, x', y', z')
qs  = slerp(I, q, min(dt / (1/60), 1))                         // 积分：每 1/60 s 转一个 q，60 fps 以下每帧最多转一个 q
ang = euler(quatMat(qs) · R(ang))                              // 在动画骨骼坐标里左乘
if se:  每轴：锁住 → 0；否则折回 (−π, π]：x<0 ? fmodf(x−π, 2π)+π : fmodf(x+π, 2π)−π
if la:                                                         // 角度钳制
    old = ang；ang = min(max(ang, lamin), lamax)
    q = conj(eulerQuat((old − ang)/2)) ⊗ q                     // 扣掉角速度里越界的那一份
if re:  每轴：锁住 → 0                                        // rax/ray/raz 为假
q = slerp(q, I, min(dt·rf, 1))                                 // 阻尼

// 平移（t 为真时；re 走 0x140202254，se 走 0x1402034a9）
e = (off + o − Mp.o)·(1 − ti/100)          // = 动画骨骼本帧的位移 × (1 − ti/100)
re: off = off − e + dt·vel
se: off1 = off − e；vel −= (dt·ts)·off1；off = off1 + dt·vel        // 弹簧，半隐式欧拉
每轴：tax/tay/taz 为假时去掉沿 Mw 该列的分量：off −= (off·c / c·c)·c
if s·tm > 0 且 |off| > s·tm：off *= s·tm / |off|
vel *= 1 − min(dt·tf, 1)
offl = A⁻¹·off

// 写回（0x140202449–0x140202a25）
D = T(offl) · R(ang)
Pose[i] = Pose[i] · D；P+0x340[i] = W · Pose[i]
```

要点：
- **`re` 和 `se` 二选一**：`re` 优先（先判 `flags & 2`）。`re` 的转动**没有回弹**，只有惯性、重力和阻尼；平移也没有弹簧。`se` 多一个回弹到 `ang = 0`（转动）或 `off = 0`（平移）的弹簧。
- **惯性**：`dl` 是上一帧物理之后的尖端在本帧动画骨骼里的位置，所以图层（或它的父链、动画）一动，尖端就落后，`qa` 往回转。图层平移、旋转、缩放都会带动。
- **惯性的量纲**：`dist` 是骨骼坐标里的像素（已经除掉 `W` 的缩放），乘 `DEG` 当作插值比例：尖端落后 57 px 就整个转过去，几个像素只转百分之几。
- **步长**：没有子步，没有固定步长。积分比例 `min(60·dt, 1)`：60 fps 以上按真实时间，60 fps 以下每帧最多走一个 `q`（比真实时间慢）。插值、阻尼的比例都乘 dt 后钳到 1。
- **重力**：只在 `ge` 时，而且只取垂直于骨骼的分量；转动部分的强度乘 `s`，平移部分不乘。
- **数学函数**：`cosf` `0x14041a2e0`、`sinf` `0x14041a9c0`、`atanf` `0x140419da0`、`tanf` `0x14041b0d0`、`atan2f` `0x14041c460`、`acosf` `0x14041c220`、`fmodf` `0x14041d0c0`，都是 CRT 的双精度实现再转 float，`Math.*` 再 `fround` 基本能对上。归一化用 `sqrtps` + `divps`（精确），不是 `rsqrt`。

**第二份代码**（`0x140203c32`，没有可见动画层的那条分支）：结构相同，`re` 段在函数内，`se` 段放在冷块 `0x14020573d`。只核对了分支与字段访问的对应【推断：与第一份相同】。

### 2.5 写回与下游（静态确认）

- `Pose[i]` 被物理改过之后，后面的子骨骼用它（父链），本帧的 `P+0x340[i]`（下一帧的 `Mp`）、蒙皮矩阵 `P+0x2f8`（`g_Bones`）、挂点子对象（1.2）都随之改变。
- 物理在 IK 之前（`0x140203660`）。

### 2.6 初始化、复位、暂停、隐藏

- **初始化**（静态确认）：首次更新时状态置初值、`P+0x348` 为空，**加载后第一帧不算物理**（`0x140201387`），第二帧起才有 `Mp`。
- **重载**：整场重建时 P 重建，同上【推断：沿用 rea-p10 第 12 节】。
- **不可见**：照常更新与求解（2.2）。可见性变化不复位。
- **壁纸暂停**：帧函数不跑，状态冻结；恢复后第一帧 dt = 0.0001（rea-framework Q6），不复位【推断】。
- **`resetBonePhysicsSimulation(bone)`**（`0x140210e10`）：整数下标或名字；名字为空串时作用于所有骨骼，否则全名匹配的骨骼；把 S 置成初值（`q = I`，其余 0）。不清 `Mp`，所以下一帧的惯性照常按上一帧的矩阵算【静态确认】。
- **`applyBonePhysicsImpulse(bone, dir, ang)`**（`0x140210990`）：同样的选骨规则；`vel += dir`（世界坐标，原样相加）；`q = q ⊗ eulerQuat(ang·DEG·0.5)`（`ang` 是度）。不检查这根骨骼开没开物理【静态确认】。语料 0 处。

### 2.7 语料（`physcorpus.json`，静态确认 + 语料）

| 场景 | mdl | 骨骼 | 生效的开关 | 参数 |
|---|---|---|---|---|
| `2345214324` | MDLS v1 | 1、2、3、4 | `r` + `re` | `ri 30`、`rf 10`、`ge` 假、`la` 假、没有 `rax/ray/raz`（不锁）；`tp` 正好是子骨骼的局部原点 |
| `2345214324` | | 5 | 关（只有 `r`） | |
| `3426865175` | `图层 2`，MDLS v4 | 0 | `r` + `re` + `ge` + `la` | `m 20`、`gd (0, −1, 0)`、`lamin/lamax z ±1.5708`、x、y 锁住、`rf 29` |
| `3426865175` | | 1、2、3 | 关（只有 `r`） | |
| `3554161528` | `人物`，v4 | 30 | `t` + `se` | `ts 300`、`tf 5`、`ti 30`、`tm 200` |
| `3577990983` | `sl`，v4 | 82、83 | `r` + `se` + `la` | `rs 300`、`rf 7` / `5`、`la z ±π`、x、y 锁住 |
| `3577990983` | | 11 | 关（只有 `r`） | |
| `3829467967` | `身体`，v4 | 12 | 关（只有 `r`） | |

所有带物理参数的 mdl 都没有 IK 链记录。

### 2.8 python 模型（`ignore\p12\rea\attach\physmodel.py`）

- 按 2.1–2.5 写：`parse_bone_json` 照解析规则（含「物理开关」），`solve` 是 2.4 的一根骨骼，`Puppet.frame(W, 局部矩阵, dt)` 是一帧（父链 → 物理 → 世界矩阵 → 交换缓冲）。numpy float32，运算顺序尽量照汇编；`A⁻¹` 用双精度求逆再转 float32，和汇编的叉积写法差在舍入级。
- 驱动是**合成的**（动画采样归 runtime 代理）：`2345214324` 的骨骼局部矩阵与物理参数，根骨骼绕 z 摆 ±0.15 rad、0.5 Hz，第 2 秒起图层右移 100 px（阶跃）。dt 1/30 和 1/60 各跑 8 秒，输出 `physmodel_out_30.json` / `physmodel_out_60.json`（每帧每根骨骼的 `ang.z`、`q`、尖端世界坐标）。
- 读码预测的现象（可以直接拿来设计实测）：
  - 5 号骨骼（物理关）`ang` 恒为 0；
  - 阶跃之后 1–4 号骨骼甩开后**停在偏离的角度**上（30 fps：t = 3 s 时 1 号 0.310、2 号 −0.537、3 号 −0.378、4 号 −0.289 rad），不回到 0，只随根骨骼的摆动继续漂；
  - 30 fps 与 60 fps 的结果不同（积分比例 `min(60·dt, 1)`）。
- 接 WPE 抓帧对照时，把驱动换成真实的动画姿势（runtime 代理的采样）和 WPE 的逐帧 dt 即可。

---

## 3. IK（中性判断）

- **IK 跑不跑只看骨骼 `+0xd4`**（静态确认）：
  - `+0xd4` 由 MDLS v≥2 段的 IK 链记录写（`0x140262c85`–`0x140262d07`：每条记录第一个 u32 是骨骼下标，那根骨骼的 `+0xd4` = 记录下标；mdl 代理 `mdl12.py` 的 `jlist`）。没有记录的骨骼保持 -1。
  - 每帧物理之后：`+0xd4 >= 0` 才调 `FUN_14026f4c0`（`0x140203660`–`0x1402036b5`）。
  - JSON 的 `ik`（`0x4000`）全二进制只在解析器里用到（只决定读不读 `ikd` 等）；`ikce`（`0x8000`）在 IK 求解器 `FUN_140271910` 里读（`0x140271fbf`、`0x140272bbd`）。
- **`ik` 为假时**：IK 参数不解析（保持缺省 `ikd 2`、`ikrd 50`）。如果骨骼没有 IK 链记录，IK 不跑，也没有别的副作用；物理开着时 IK 参数本来就不解析。
- **语料**：所有 puppet mdl 的 IK 链记录数都是 0（`physcorpus.py`），所以 IK 一次都不跑，9 根骨骼上的 `ik*` 键完全中性【静态确认 + 语料】。
- **为真时的大致做法**【只看入口】：沿 IK 链记录的骨骼（`ikd` 节）求解，参数是 `ikg`、`ikr`、`ikrd`、`ikse`、`ikfe`、`ikrminl/ikrmaxl`；写回 `P+0x2c8` / `P+0x2e0`（调用参数），之后还会碰物理状态 `P+0x3b8`（`0x1402036f0`）。没读。

---

## 4. 脚本 API

### 4.1 方法桥（静态确认）

- 图像层方法表 `0x1404e8620`（登记 `FUN_1402110be`），模型对象另有一份（`FUN_140227470`）。条目 `+0x30` 原生函数、`+0x38` 名字、`+0x58` 参数类型、`+0x70` 返回类型（与 rea-p4f 第 1 节相同）。
- 原生调用约定：`rcx` 对象、`r8` 实参类型数组、`r9` 实参值数组，第 5 个参数是返回值槽。
- 返回类型 `0x800`（对象）：dll 在 `0x181622ec4` 把槽清零后调原生；槽仍为 0 时返回根值 `[isolate+0x378]`（`0x181622f13`），否则经 `0x181652380` 包装。包装按原生指针查缓存表，同一个原生对象每次给同一个 JS 对象【推断】。
- 根值 `+0x378`：rea-p10 实测 `thisScene.getAnimation()` 为 `null`；P9 实测 `getVideoTexture()` 在非视频图层上为 `null`，它的原生写 0 后走的正是这条路。所以这里是 `null`【推断，两处实测支持】。

### 4.2 `getAnimationLayer` / `getAnimationLayerCount`（静态确认）

`getAnimationLayer` = `0x14020e910`（参数类型 `0x208` = 字符串 | 整数，返回 `0x800`）：
```c
if (!P || !P+8) return;                            // 槽不写 → null
if (实参是整数 (0x8))   { i = int; if (i >= 0 && i < count(P+0x3d0)) *ret = P+0x3d0[i]; }
else if (字符串 (0x200)) { if (s 非空) for (A : P+0x3d0) if (A->name (+0xd8) == s) *ret = A; }   // 不 break：最后一个匹配
```
- 下标从 0，顺序是 `P+0x3d0` 的顺序：`animationlayers` 数组顺序，`index` / `autosort`、`createAnimationLayer` 会插队（`FUN_1401fcc20` 读这两个键，插入位置没读）。
- 名字是层的 `name` 属性（JSON 的 `name`，脚本可写），区分大小写，空串查不到。
- 非 puppet 图层（`3326873240`）：`null`，`.play()` 抛 TypeError。
- `getAnimationLayerCount` = `0x14020e9f0`：`count(P+0x3d0)`，非 puppet 返回 0。

### 4.3 `IAnimationLayer`（登记 `FUN_14026c980`：属性表 `0x1404e8a60`、方法表 `0x1404e8aa0`，静态确认）

动画层 A 的时钟 K 在 `A+0xf8`，布局与 P10 的 K 相同：`+0xf8` `spf = 1/fps`、`+0xfc` `t`、`+0x100` `D = length/fps`、`+0x104` `flags`、`+0x108` `length`、`+0x110` 事件。建层时用 `FUN_1401a8c10(mode, fps, length, K, random=0, startpaused=0)`（`0x1401fcd77`），`mode` / `fps` / `length` 取自 `MDLA` 动画定义（`+0x28`、`+0x48`、`+0x4c`）。每帧推进 `FUN_1401a9f60(rate × dt, K, events)`（`0x1401fed89`），与 P10 共用。

属性（描述符：类型、偏移、JSON setter、类型化 setter、getter）：

| 成员 | 类型 | 字段 | 存取 | 语义 |
|---|---|---|---|---|
| `fps` | float，只读 | — | getter `0x14026c3e0` | `1 / spf`（float32 往返，同 P10） |
| `frameCount` | int，只读 | `+0x108` | `0x14026c400` | `length` |
| `duration` | float，只读 | `+0x100` | `0x14026c410` | `D` |
| `name` | string | `+0xd8` | `0x1401a4bc0` / `0x1401a4d00` / `0x1401a4d60` | 改了以后按新名字查 |
| `rate` | float | `+0xc8` | `0x1401a4b00` / `0x1401a49f0` / `0x1401a4a10`（同 P10 `IAnimation.rate`） | `t += rate × dt`，不钳制 |
| `blend` | float | `+0xcc` | 同上 | 权重 |
| `blendtime` | float | `+0x18c` | 同上 | d.ts 没写 |
| `visible` | bool | `+0xd0` bit0 | `0x1401e1a90` / `0x1401e1c60` / `0x1401e1c90`（与对象 `visible` 同一套存取器） | 为假时这一层不推进、不采样（`0x1401fed54`） |
| `additive` | bool | `+0xd0` bit1 | `0x14019b4e0` / `0x14019b6b0` / `0x14019b6e0` | d.ts 没写 |
| `blendin` | bool | `+0xd0` bit2 | `0x14019bfa0` / `0x14019c170` / `0x14019c1a0` | d.ts 没写 |
| `blendout` | bool | `+0xd0` bit3 | `0x14025aca0` / `0x14025ae70` / `0x14025aea0` | d.ts 没写 |

方法：

| 方法 | 原生 | 语义 |
|---|---|---|
| `play()` | `0x14026c420` | 结束位（`0x40000000`）在时 `t = 0`；清暂停、结束位（同 P10） |
| `pause()` | `0x14026c450` | 置 `0x20000000` |
| `stop()` | `0x14026c460` | 置暂停位，`t = 0`，清结束位与 mirror 方向位（同 P10） |
| `isPlaying()` | `0x14026c480` | `(flags & 0x60000000) == 0` |
| `getFrame()` | `0x14026c4d0` | `t / spf`（float32，带小数） |
| `setFrame(f)` | `0x14026c4a0` | `t = spf × f`，**另置 `0x02000000`**：本帧不判「播完」（不触发 `addEndedCallback`、`playSingleAnimation` 不因此删层），推进后清掉（`0x1401fedff`）。不钳制、不清别的位 |
| `addEndedCallback(fn)` | `0x14026c4f0` | 把函数追加到 `A+0x130` 的向量，可以加多个 |

- **权重**（`FUN_14026c8b0`）：`blend × 淡入 × 淡出`。
  - `blendin`：`淡入 = min(t / min(D·0.5, blendtime), 1)`（`min(D, blendtime)` 不大于一个很小的常数时为 1）；**非 single 层淡入到 1 时把 `blendin` 位清掉**，之后循环、`play()` 都不再淡入；single 层保留。
  - `blendout`：`淡出 = min((D − t) / min(D·0.5, blendtime), 1)`。
  - 所以 `play()` 本身不触发淡入；single 层播完后 `play()` 把 `t` 归零，淡入因 `t` 从 0 开始而重新生效。
- **写 `rate` / `blend` / `visible` 与 JSON 绑定是同一个字段**：属性表就是 `animationlayers` 一项的 JSON 键表，建层时 `FUN_1401a38f0(A+8, json)` 按它套用（含用户属性、脚本绑定）【套用细节为推断，沿用 P3a / P10 的绑定机制】。这些属性没有改值回调。
- **生效时机**：puppet 的推进与采样在对象更新阶段，早于脚本（4.4），所以脚本在 `update` 或光标回调里调 `play()` / `setFrame()` / 写 `rate`，**下一帧**才进画面。

### 4.4 `AnimationEvent` 与播完回调（静态确认）

- **事件来源**：`FUN_1401fcc20` 建层时把动画定义的事件表（`anim+0x120`，每项 0x28：float 时间 + JSON 串，同 P10 的格式）整个拷进 `A+0x110`。事件表从 `MDLA` 来，内容归 mdl 代理。
- **收集**：`FUN_1401a9f60` 推进时照 P10 第 8 节的规则收进本帧的列表 `[rbp+0x470]`（只收可见层）。
- **派发**（`0x140200201`–`0x14020023a`）：每个事件调 `FUN_140177ad0(脚本管理器, 作用域 = 图层, 对象 = 图层, 6, json)`。接收者是同一图层上导出了 `animationEvent` 的脚本（P10 的作用域规则）；`event` 是事件 JSON 解析出的对象，`value` 是接收脚本自己属性的当前值。
- **时机**：在对象更新阶段派发（P10 的属性动画在之后的 `FUN_140171440` 里派发）。都在脚本 `update` 之前。
- **播完**（`0x1401fedb0`–`0x1401fedfb`）：推进前 `flags` 没有暂停、结束、`setFrame` 位时判断：single 看结束位新置、mirror 看方向位翻转、loop 看 `t` 变小（回绕；负 `rate` 下每帧都成立）。成立就置 `0x04000000`。
  - 之后（`0x14020028a`）清掉这一位，层有回调时调 `FUN_140177bf0(…, 回调, 个数)`（转到脚本引擎虚表 `+0x60`，参数个数没读）；
  - 带 `0x08000000`（`playSingleAnimation` 建的层）时再置 `0x10000000`，同一帧稍后（`0x14020035d`）把层删掉。

### 4.5 语料 0 处的方法（只记入口与一句话）

| 方法 | 原生 | 结论 |
|---|---|---|
| `createAnimationLayer(animation, config)` | `0x14020ea30` | 按动画名或 JSON 建层，读 `config.blendin` / `blendout`（`autosort` 在建层函数里），返回新层 |
| `playSingleAnimation(...)` | `0x14020ef40` | 调上面的函数，再给新层置 `0x08000000`：播完自动删除 |
| `destroyAnimationLayer(名字 \| 下标 \| 对象)` | `0x14020ef80` | 返回布尔 |
| `getBoneCount` / `getBoneIndex` / `getBoneParentIndex` | `0x14020f190` / `0x140210790` / `0x140210860` | |
| `getBoneTransform` / `setBoneTransform` | `0x14020f1d0` / `0x14020f350` | 世界骨骼矩阵 |
| `get/setLocalBoneTransform`、`get/setLocalBoneAngles`、`get/setLocalBoneOrigin` | `0x14020f6b0` / `0x14020f840`、`0x14020fa10` / `0x14020fce0`、`0x1402100d0` / `0x140210250` | |
| `getBlendShapeIndex` / `get/setBlendShapeWeight` | `0x140210400` / `0x1402104b0` / `0x1402105c0` | |
| `applyBonePhysicsImpulse` / `resetBonePhysicsSimulation` | `0x140210990` / `0x140210e10` | 见 2.6 |

---

## 对实现的含义

### 挂点（P12b）
```ts
// 加载期：child.attachment 是字符串、父是 puppet 图层、父在 objects 里排在子前面时
//   attachIndex = 父 mdl 的 MDAT 里第一个全名相等的项；否则 -1（按普通父子）
// 每帧（骨骼姿势算完之后）：
W_child = W_parentBase /* 不含 alignment 偏移、不含 size */ · Pose[att.bone] /* 动画 + 物理之后、模型空间 */ · att.matrix · T·Rz·Ry·Rx·S
// Pose 还没有（puppet 首帧前）时去掉中间两项
```
- 子对象排在父之前（语料没有）：一律按普通父子，不要报键。
- 粒子子对象：发射器跟 `W_child` 走，沿用 P4c 的世界 / 局部空间规则。

### 物理（P12d）
- 解析：照 2.1。`(r || t) && (se || re)` 才开；`la` / `lt` / 轴锁的读法照表。
- 每帧：在动画采样与父链之后、蒙皮之前，按骨骼下标顺序逐根照 2.4 算；需要的输入是本帧 `W`（图层 `+0x80`，含对齐）、`Pose`、上一帧物理后的世界骨骼矩阵（首帧没有，不算物理）、dt。
- 状态在重编译时保留（WPE 只在整场重建时清），不可见照算。
- `physmodel.py` 的 `solve()` 可以直接改写成 TS。
- 能力键：语料里生效的只有 `re`、`se`、`ge`、`la`、轴锁；`lt`、`tm` 生效但语料都没用到（`lt` 全假，`tm 200` 在 `t` 骨骼上有效）。

### 脚本（P12c）

| 成员 | 实现 |
|---|---|
| `thisLayer.getAnimationLayerCount()` | puppet 动画层个数，非 puppet 0 |
| `thisLayer.getAnimationLayer(x)` | 整数按下标、字符串按 `name`（最后一个匹配）；查不到、非 puppet 返回 `null`；同一层每次返回同一个对象 |
| `fps` / `frameCount` / `duration` | 同 P10 `IAnimation` |
| `name` / `rate` / `blend` / `blendtime` / `visible` / `additive` / `blendin` / `blendout` | 可读写，就是层的绑定字段，下一帧生效 |
| `play` / `pause` / `stop` / `isPlaying` / `getFrame` | 同 P10 |
| `setFrame(f)` | 同 P10，另加「本帧不判播完」 |
| `addEndedCallback(fn)` | 每次播完（loop 回绕、mirror 换向、single 结束）调 |
| `AnimationEvent` | 接 P10b 的 `animationEvent` 派发，作用域是 puppet 图层 |

---

## 没查清的

1. **`MDAT` 矩阵是相对骨骼的局部矩阵**：代码只说明它右乘在 `Pose[bone]` 上；「相对骨骼」是按语料取值推断的。
2. **子对象排在父 puppet 之前、或在更新循环里比父先要世界矩阵时用上一帧姿势**：更新列表 `scene+0x158` 的顺序没逐条核对。
3. **`+0x190` 的构造初值**、`attachment` 不是字符串时的行为：没核对（语料全是字符串）。
4. **`Pose[i]` 的父链与动画采样细节**：归 runtime 代理；本文只用到「父先于子算完、父已经过物理」。
5. **第二份物理代码**（没有可见动画层时）只核对了分支结构，没逐条读。
6. **`A⁻¹`、点积等的逐位舍入**：模型用双精度求逆、numpy 点积，和汇编的 SIMD 写法差在舍入级。
7. **IK 求解器 `FUN_14026f4c0` / `FUN_140271910` 的内容**：没读（语料不跑）。
8. **`+0x4a0/+0x4a8/+0x4b0` 与挂点有没有关系**：没查（1.5）。
9. **dll 的细节**：返回值槽在所有路径上都清零（只看了 `0x181622ec4` 这一支）；`getAnimationLayer(1.5)` 这类非整数的转换；`addEndedCallback` 回调的参数个数；只读属性被写时是忽略还是抛错。
10. **`animationlayers` 的 `index` / `autosort`** 决定的插入位置（影响 `getAnimationLayer(下标)`）：没读，归 runtime 代理。
11. **`re` 模式没有回弹**：是读码结论，和直觉不符，需要实测确认（「实测建议」1）。

## 实测建议（主会话：kbp gen 的 puppet mdl 编码 + wpe-renderdoc）

1. **`re` 没有回弹**：一根骨骼 `{"r":true,"re":true,"ri":30,"rf":10,"tp":"100 0 0"}`，图层在第 2 s 用关键帧（P10）右移 100 px。预期骨骼甩开后停在偏离的角度上，不回到 0。同工程换成 `se` + `rs 200`：预期摆回 0。
2. **开关规则**：同一根骨骼只写 `"r": true`（不写 `re`/`se`），预期图层平移时完全不动。
3. **积分比例**：同一工程分别用 30 fps 与 120 fps 抓，`g_Bones` 的摆动幅度、周期按 2.4 不同（`physmodel.py` 改 fps 即可算期望）。
4. **重力**：`ge` + `gd "0 -1 0"` + `m 20`，骨骼水平，预期向下垂并停在竖直方向（`re`）。
5. **挂点**：父 puppet 一根骨骼带旋转动画，挂一个小图像层（`origin` 非零）和一个粒子；比四角与发射点。再把子对象移到 `objects` 里父的前面，预期挂点失效、按普通父子。
6. **`getAnimationLayer`**：非 puppet 图层上 `console.log(thisLayer.getAnimationLayer('x'))` 预期 `null`；两个同名层预期拿到后一个；`getAnimationLayer(0) === getAnimationLayer(0)` 预期为真。
7. **`setFrame` 与播完回调**：loop 层 `addEndedCallback` 记日志，每回绕一次一条；在回调里或 `update` 里 `setFrame(0)`，那一帧不记。

## 字段速查

**骨骼 B（0xf0，构造 `FUN_14026b860`）**

| 偏移 | 内容 |
|---|---|
| `+0x00` | 名字 |
| `+0x20` | 局部矩阵（缺省单位阵） |
| `+0x60` | 父下标（缺省 -1） |
| `+0x64` | u32（mdl 代理） |
| `+0x68` | 参数块 Q：`+0` 标志、`+4` rs、`+8` ts、`+0xc` rf、`+0x10` tf、`+0x14` 1−ri/100、`+0x18` 1−ti/100、`+0x1c` gd、`+0x28` m、`+0x2c` tp、`+0x38` |tp|/100、`+0x3c` tm、`+0x40` lamin、`+0x4c` lamax、`+0x58` ltmax、`+0x5c` ikd、`+0x60` ikrd、`+0x64` ikrminl、`+0x68` ikrmaxl |
| `+0xd4` | IK 链记录下标（缺省 -1） |

**Q 的标志位**：`0x1` se、`0x2` re、`0x4` ge、`0x8` la、`0x10` lt、`0x20` ikg、`0x40` ikr、`0x80` ikse、`0x100` ikfe、`0x1000` r、`0x2000` t、`0x4000` ik、`0x8000` ikce、`0x100000` / `0x200000` / `0x400000` 锁 x / y / z 转动、`0x800000` / `0x1000000` / `0x2000000` 锁 x / y / z 平移。

**物理状态 S（0x50）**：见 2.3。

**挂点项（`P+0xb0`，0x68）**：`+0` 名字、`+0x20` 4×4、`+0x60` 骨骼下标。

**动画层 A（0x198）**：`+0xc8` rate、`+0xcc` blend、`+0xd0` 位（visible / additive / blendin / blendout）、`+0xd8` name、`+0xf8` K（spf、t、D、flags、length）、`+0x110` 事件、`+0x128` 动画定义、`+0x130` 播完回调、`+0x18c` blendtime。`flags` 另有 `0x02000000`（setFrame）、`0x04000000`（本帧播完）、`0x08000000`（单次层）、`0x10000000`（待删除）。

**图像层**：`+0x180` 父、`+0x188` 父 id、`+0x190` 挂点下标、`+0x4b1` 对齐偏移开关、`+0x4b8` puppet。
