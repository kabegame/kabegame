# P12d 子计划 — 骨骼物理

> 总计划：[phase-12-puppet.md](phase-12-puppet.md)「P12d — 骨骼物理」。
> 语义依据：
> - 读码 [rea-p12-attach-physics](rea-p12-attach-physics.md) 第 2 节（骨骼 JSON、帧内位置、状态、求解、写回、初始化与复位、`applyBonePhysicsImpulse` / `resetBonePhysicsSimulation`）；
> - 实测 [p12-REPORT](p12-REPORT.md) 第一部分用例 10（`p12-phys` / `p12-phys2`）、第二部分第 1 节（`2345214324`、`3426865175` 的组合模型对照与误差包络）；
> - python 模型 `ignore/p12/rea/attach/physmodel.py`（`solve`）与组合模型 `ignore/p12/meas/combo.py`（`PhysPuppet`）；
> - 语料 `ignore/p12/d/corpus/report.txt`（2026-11-15，HEAD `f26e8de9`）。

## 总体设计思路

物理是 puppet 运行时（`ScenePuppets`）里的又一步：
- **位置**：每帧动画层推进、采样、混合得到局部姿势之后，按骨骼下标逐根沿父链算模型空间矩阵 `Pose[i]` 时，算完一根就对它解一次物理，得到增量 `D = T(offl)·R(ang)`，`Pose[i] ← Pose[i]·D`。后面的子骨骼用改过的 `Pose`，蒙皮矩阵、挂点都自然跟着走。
- **状态**：每根开物理的骨骼一份 `{ q, ang, off, vel }`，外加上一帧物理之后的世界骨骼矩阵 `Mp`（WPE 的 `P+0x348`，每帧与 `P+0x340` 交换）。
- **惯性**：来自 `Mp` 与本帧 `W·Pose[i]` 的差，所以运行时要知道图层本帧的世界矩阵 `W`（含对齐偏移）与它三列长度的平均 `s`。

`W` 由宿主经 `PuppetSink` 交进来。我们的 puppet 推进排在脚本之前，状态里的 `W` 是上一帧脚本写下的，正是 WPE 的时序（p12-REPORT 第二部分 1.5：第 k 帧物理用第 k−1 帧脚本写的 origin）。

**求解**：照 python 模型逐行改写成 TS，全程 float32（`Math.fround`），数学函数用 `Math.*` 再 `fround`（WPE 是 CRT 双精度再转 float）。
- 首帧不算物理（没有 `Mp`）。
- 图层隐藏照算，壁纸暂停冻结。
- 重编译按（对象，骨骼）接回状态与 `Mp`，同 P10 / P12a 的 `carryOver`。

**验收**：逐位一致做不到，`rotTo` 的阈值附近差 1 ulp 就翻转判定，`re` 又不回弹。按 p12-REPORT 给的误差包络验收：`re` 骨骼物理转角每 200 帧 ≤ 2e−5 rad 量级；`se` 有回弹，应更小。

**关键决定**：
- 骨骼 JSON 在编译期解析成参数块 `BonePhysics`（照读码 2.1 的键、换算与缺省），运行时只读数值。
- 只做图像层 puppet。模型对象的骨骼 JSON 在语料里全空；模型更新路径里的物理也没读码，模型上开物理继续报 `puppet:physics`。
- 不复刻 `rotTo` 阈值附近的逐位行为：上游有 `rsqrtps` 与 SIMD 求逆的差，本来就不可能逐位。
- 骨骼脚本 API 另成一步 P12d-2，见「待定」1。

## 步骤 0 结论（2026-11-15）

**读码与实测**（P12 步骤 0 已做，这里只摘要，细节见上面的文档）：
1. **开关**：`(r‖t) && (se‖re)` 才开物理，否则 `r`、`t` 一起清掉。`re` 优先于 `se`。
2. **帧内位置**：动画采样之后、按骨骼下标逐根：`Pose[i]`（用父的、已经过物理的 `Pose`）→ `P+0x340[i] = W·Pose[i]` → 物理 → IK（语料不跑）→ 蒙皮。图像层更新不判可见性，所以隐藏照算。
3. **`W` 与 `s`**：`W` 是图层的世界矩阵含对齐偏移（`+0x80`），`s = ((|c1| + |c0|) + |c2|) / 3`（z 列也算，实测 3426865175 成立）。
4. **求解**：读码 2.4 的伪代码，python 模型逐位对上 6 组生成工程与两张语料（残差在 float32 / 阈值翻转级）。
   - 积分比例 `min(60·dt, 1)`；
   - 惯性用上一帧物理**之后**的矩阵；
   - 重力只取垂直分量、强度 `m·s`；
   - `re` 没有回弹。
5. **初始化**：加载后第一帧不算物理，第二帧起才有 `Mp`（和「第 2 帧也不算」在数据里分不开，按读码）。
6. **两份代码**：没有可见动画层时 WPE 走第二份代码，结构相同（推断）。`3426865175` 正是没有动画层的，组合模型照第一份写法对上了（1.5）。

**语料**（`ignore/p12/d/corpus/report.txt`）：
- **范围**：5 张场景、6 个对象、12 根骨骼开物理，全是 skinned 图像层 puppet。
  - 开关组合：`r + re` 5 根（含重力 1 根）、`r + se` 2 根、`t + se` 5 根；
  - 用到的参数：`la` 3 根，转动轴锁 3 根，`tm` 5 根；
  - 语料 0 处：`lt`、平移轴锁、`t + re`、IK、`resetBonePhysicsSimulation`；
  - 模型对象 0 根，没有挂点子对象挂在物理骨骼上。
- **驱动**：
  - `2345214324`、`3554161528`、`3577990983`：动画带动；
  - `3577990983`：另有脚本晃动图层；
  - `3426865175`：脚本让图层跟光标，加重力，没有动画层；
  - `3359451610`：只靠脚本拖骨骼与冲量。
- **解锁**（HEAD 233 张能渲染 182）：
  - 物理做完：`2345214324`、`3426865175`，182 → 184；
  - 再做 4 个骨骼 API（`getBoneCount`、`getBoneTransform`、`setBoneTransform`、`applyBonePhysicsImpulse`）：`3359451610`，→ 185；
  - 还差别的：`3554161528` 差 `value:animation:camera`，`3577990983` 差精灵表帧动画等 5 个键。
- **`3359451610` 的用法**：对象 0、2 的 `visible` 字段脚本。
  - `cursorDown`：`getBoneCount` + `getBoneTransform(b).translation()`，选最近的骨骼；
  - `update`：拖动时 `setBoneTransform(i, …)` 把骨骼移到光标处；
  - `cursorUp`：100 ms 后对其余骨骼 `applyBonePhysicsImpulse(b, 向量)`，只传两个参数。

## 现状锚点

**a. 物理骨骼报 `puppet:physics`**（`compile/puppet.ts:398`、`:249`）
```ts
function skeletonIssues(skeleton, file, used, issues): void {
  for (const bone of skeleton.bones) {
    const flags = boneJsonFlags(bone.json);
    if ((flags & 0x3000 && flags & 0x3) || bone.flags & 2) issues.add("puppet:physics"); // 现状：开物理就整张退回
    if (flags & 0xc000) issues.add("puppet:ik");
  }
  // …
}
export function boneJsonFlags(json: string): number {
  // 现状：只认 se / re / r / t / ik / ikce 六个布尔位，参数（ri、rf、rs、gd、m、tp、la …）不读
}
```

**b. 模型空间矩阵一遍算完，中间没有插入点**（`puppet/pose.ts:232`）
```ts
export function skinMatrices(pose, skeleton, world, out): void {
  for (let i = 0; i < bones; i++) {
    if (pose) trsMatrix(pose, i * POSE_STRIDE, local, 0);
    else for (let k = 0; k < 16; k++) local[k] = restMatrices[i * 16 + k];
    const parent = parents[i];
    if (parent < 0) world.set(local, i * 16);
    else { mulAffine(world, parent * 16, local, 0, temp, 0); world.set(temp, i * 16); } // 现状：算完直接给子骨骼用
  }
  for (let i = 0; i < bones; i++) { /* K_i = B_i · 逆绑定_i → out */ }
}
```

**c. 没有可见层时的捷径**（`puppet/player.ts` 的 `evaluate` 末尾）
```ts
    if (!posed) {
      if (runtime.restSkin) return; // 现状：上次也是静止就不重算——有物理骨骼时状态每帧在变，不能跳
      if (!model) reset();
    }
    // …
    skinMatrices(posed ? pose : null, skeleton, runtime.world, runtime.skin);
```

**d. `PuppetSink` 只给动画层字段与可见性**（`puppet/player.ts:62`）
```ts
export interface PuppetSink {
  animationLayer(object: number, layer: number): PuppetLayerFields | undefined;
  visible?(object: number): boolean; // 现状：没有图层世界矩阵
}
```

## P12d-1 — 物理

### 点 1 — 编译期：骨骼物理参数（`compile/puppet.ts`）

- **新增**
  - 照读码 2.1 解析骨骼 JSON：开关位、公共参数、`phys` 时的参数（含换算与缺省；`la` 只认 JSON `true`；`lamin` / `lamax` 只在 `la` 时读；三个轴锁三个都在且都是布尔才读；`gd` / `tp` 是空格分隔的三个数）。
    ```ts
    /** 一根骨骼的物理参数（rea-AP 2.1，WPE 骨骼 +0x68 的参数块 Q）。只在 `(r‖t) && (se‖re)` 时有，否则 null。 */
    export interface BonePhysics {
      rotate: boolean;      // r（0x1000）
      translate: boolean;   // t（0x2000）
      spring: boolean;      // se（0x1）；re 优先：re 为真时 spring 为 false
      gravity: boolean;     // ge（0x4）
      rs: number; ts: number; rf: number; tf: number;
      ri: number;           // 1 − ri/100（缺省 1）
      ti: number;           // 1 − ti/100（缺省 1）
      gd: [number, number, number];
      m: number;            // 缺省 1000
      tp: [number, number, number];
      tm: number;
      limitAngles: [number, number, number, number, number, number] | null; // la：lamin xyz、lamax xyz（弧度）
      limitTurn: number | null;                                             // lt：ltmax（度）
      lockRotate: [boolean, boolean, boolean];                              // rax / ray / raz 为假 → 锁
      lockTranslate: [boolean, boolean, boolean];
    }
    ```
  - `ScenePuppet.skeleton.physics: (BonePhysics | null)[]`（按骨骼下标），全 null 时省掉（字节同以前）。
- **修改**
  - `skeletonIssues`：图像层 puppet 不再因物理报 `puppet:physics`。下面三种情况仍报：
    - 模型对象开物理；
    - 骨骼文件 flags bit1（`0x1402006dc` 的物理路径，语料 0 根）；
    - 用到语料 0 处又没实测的 `lt`、平移轴锁、`t + re`：报 `puppet:physics:<键>`，或者照读码一起做（「待定」2）。

### 点 2 — 运行时：求解（`puppet/physics.ts` 新文件、`puppet/pose.ts`、`puppet/player.ts`）

- **新增**
  - `puppet/physics.ts`：读码 2.4 的一根骨骼求解，照 `physmodel.py` 的 `solve` 逐行改写；辅助函数 `slerp` / `rotTo` / `⊗` / `quatMat` / `euler` / `eulerQuat` 照读码的常数与分支（阈值 `0.999999881`、`DEG = 0.017453292`、`RAD = 57.29578`）。
    ```ts
    export interface BoneState { q: Float32Array /* w x y z */; ang: Float32Array; off: Float32Array; vel: Float32Array }
    /** 解一根骨骼：mw = W·Pose[i]（本帧、物理之前），mp = 上一帧物理之后的世界骨骼矩阵；返回增量 D（写进 out，16 个 f32），没有增量时返回 false。 */
    export function solveBone(params: BonePhysics, state: BoneState, mw: Float32Array, mp: Float32Array, s: number, dt: number, out: Float32Array): boolean;
    ```
  - `PuppetSink.world?(object): Float32Array | null`：图层本帧（脚本之前）的世界矩阵，含对齐偏移（同 `drawMatrixOf` 的平移部分）。不给或返回 null 时物理不跑（单测、`refresh`）。
- **修改**
  - `skinMatrices` 拆出插入点：每根骨骼算完 `world[i]`（模型空间）之后调一个可选回调，回调可改写 `world[i]`，再继续给子骨骼用。没有回调时逐字节同以前。
  - `ScenePuppets`：
    - 每个运行时加物理状态：每根物理骨骼一份 `BoneState`，以及 `prev` / `cur` 两份世界骨骼矩阵（每帧交换，首帧 `prev` 为空）。
    - `frame` 推进时在 `skinMatrices` 的回调里解：`mw = W·world[i]`，`solveBone`，有增量就 `world[i] ← world[i]·D`，并写 `cur[i] = W·world[i]`。
    - 首帧不解；`refresh` 不解（不是 WPE 的更新）。
  - `evaluate` 的「静止捷径」：有物理骨骼的运行时不走捷径。
  - `carryOver`：同一对象、骨骼数相同时接回物理状态与 `prev`。
- **注意**：WPE 在推进时把 `cur` 与 `prev` 交换，`cur` 每帧对所有骨骼都写 `W·Pose[i]`，不只是物理骨骼。我们只需要物理骨骼的那几根，但写全套也无妨，两种取舍执行代理选一，注释写明。

### 点 3 — 宿主与探针（`host.ts`、`dev/particleCorners.ts`、`dev/probe.ts`）

- **修改**：
  - 宿主 `stepPuppets` 的 `stateSink` 给 `world`：按 `drawnState` 现算图层的世界矩阵含对齐，同 `getTransformMatrix` 用的 `drawMatrixOf`。不走挂点：语料没有物理骨骼的 puppet 挂在别的骨骼上，有挂点的 puppet 先照报 `puppet:physics:attached` 或沿用挂点钩子，执行代理按代码现状选简单的一种，注释写明。
  - 探针的确定性回放同样给 `world`。

### 点 4 — 测试

- **`puppet/physics.test.ts`**：
  - **用例 10**：用 `p12-phys` / `p12-phys2` 的 WPE `g_Bones` 与逐帧 dt（`ignore/p12/out/` 下的 consts 与日志）做夹具，从第 1 帧回放，逐帧比；re / se / ronly / tse / se_y / ronly_y 预期逐位或 ≤ 几 ulp，re_ge / re_y / re_rot / se_rot 在 p12-REPORT 用例 10 的残差量级以内。
  - **语料**：`2345214324`（帧 216–220）与 `3426865175-kbp-p2`（帧 190–192）的夹具，在第二部分 1.2 / 1.5 的残差量级以内。`3426865175` 的图层 origin 来自日志里的光标（`phys2.py` 的做法）。
  - **反例**（防回归）：积分比例不钳、`re` 加弹簧、去掉惯性、惯性用物理之前的矩阵，各自都要被夹具抓住。
  - **开关**：只有 `r`、只有 `re` 的骨骼不动；隐藏照算；首帧不算；`refresh` 不解；`carryOver` 接回。
- **`compile/`**：骨骼 JSON 解析的每个键、换算、缺省、`la` 只认 `true`、轴锁三个都在才读。

## P12d-2 — 骨骼脚本 API（「待定」1 选做时）

- `getBoneCount`、`getBoneTransform`、`setBoneTransform`、`applyBonePhysicsImpulse` 四个方法（语料只用到这四个），图像层 puppet 上。
- 要先补读码与实测（语料代理列的没查清项）：
  - `getBoneTransform` 返回什么矩阵（世界还是模型空间、含不含物理）；
  - `setBoneTransform` 写进哪里、和动画与物理谁先谁后、持续多久（一帧还是一直）；
  - `applyBonePhysicsImpulse` 少传第三个参数时的行为；
  - 对没开物理的骨骼调冲量的效果。
- `3359451610` 的拖动还要光标回调在 puppet 上命中（P6c 已有）。

**读码结论**（2026-11-15，[rea-p12d-bones](rea-p12d-bones.md)，静态）：
- `getBoneCount()`：mdl 的骨骼数，不看蒙皮门，所以静态 puppet 也返回骨骼数；非 puppet 返回 0（推断）。
- `getBoneTransform(b)`：
  - 选骨：整数下标按姿势数判越界；字符串取第一个全名匹配，空串不查。
  - 返回 `P+0x340[i]`（`W·Pose`，含物理）的拷贝，每次新建 `Mat4`。
  - 失败（越界、非整数、第一次更新之前、静态 puppet）返回**单位阵**，不是 `null`。
- `setBoneTransform(b, M)`：
  - 写三处：`P+0x340[i] = M`、`P+0x2c8[i] = W⁻¹·M`、这根骨骼的蒙皮矩阵。当帧就画在 `M`，子骨骼当帧不跟。
  - 只持续一帧：下一帧交换后全部重算。
  - 唯一残留是 `M` 成为下一帧物理的 `Mp`。所以物理的 `prev` 必须是脚本之后的那份缓冲，`t` 骨骼会按 `1 − ti/100` 追向脚本位置，`3359451610` 的回弹靠这个。
- `applyBonePhysicsImpulse(b, dir, ang)`：
  - 只传两个参数不抛错，缺的 `ang` 当 `Vec3(0, 0, 0)`，`q` 不变；
  - `dir` 原样加进 `vel`；不检查物理开关（没开 `t` 的骨骼加了也不起作用）；
  - 名字取第一个匹配，空串落到骨骼 0；第一次更新之前不做事。
- `resetBonePhysicsSimulation`：空串只作用于骨骼 0（更正 rea-p12-attach-physics 2.6）。
- 模型对象没有这些方法。
- **P12d-1 的接口改定**（已告知执行代理）：世界缓冲 `cur` 每帧对所有骨骼写，推进开头交换，P12d-2 的 `setBoneTransform` 直接改 `cur`。

### P12d-2 的实现要点

- **编译期**：
  - `ScenePuppet` 带上骨骼名（`names`）与 mdl 骨骼数（`boneCount`，静态 puppet 也有）。
  - 缺失表删掉 `getBoneCount`、`getBoneTransform`、`setBoneTransform`、`applyBonePhysicsImpulse`、`resetBonePhysicsSimulation`。其余 11 个（`getLocalBone*`、`getBoneIndex`、`getBoneParentIndex`、混合形状）照报。
- **运行时**（`ScenePuppets`）：
  - 选骨：整数下标（越界 → 失败）或名字（第一个全名匹配，空串失败）。冲量与复位的空串落到骨骼 0。
  - `boneTransform(object, b)`：`cur[i]` 的拷贝；失败或还没推进过时返回 null，由 API 换成单位阵。
  - `setBoneTransform(object, b, M)`：
    - 写三处：`cur[i] = M`、模型空间 `world[i] = W⁻¹·M`（`W` 是这一帧推进时用的那份，存下来）、`skin[i] = world[i]·绑定逆`；
    - 子骨骼与物理状态不动；
    - 下一帧推进开头交换后，`M` 进了 `prev`。
  - `applyBonePhysicsImpulse(object, b, dir, ang)`：`vel += dir`；`q = q ⊗ eulerQuat(ang·DEG·0.5)`；`ang` 缺省 (0, 0, 0)；没开物理的骨骼没有状态，空操作（WPE 写了也不起作用）。
  - `resetBonePhysicsSimulation(object, b)`：状态置初值，不清 `prev`。
  - 静止捷径：有 `W` 的帧照样交换缓冲、写 `cur`（只省掉蒙皮重算），否则 `getBoneTransform` 会读到过期的值。
- **脚本 API**（图像层对象上；模型与别的图层没有这些方法）：
  - `getBoneCount()` 返回 `boneCount`，非 puppet 返回 0；
  - `getBoneTransform(b)` 每次新建 realm 的 `Mat4`，失败返回单位阵；
  - `setBoneTransform(b, mat)` 收 `Mat4`（读 `m` 的 16 个数），不合法的忽略；
  - `applyBonePhysicsImpulse(b, dir, ang?)` 的 `dir` / `ang` 按 `Vec3` 读 `x y z`。
  - 写入当帧生效：`GpuScene.update` 在脚本之后写 `g_Bones`。
- **验证**：rea-p12d-bones 的实测用例（尤其第 3 个：第 N 帧 `set` 一根 `t + se` 骨骼、看之后几帧的回弹）由我在 WPE 上做，对照数据回来后补夹具。

## 真机对照与收尾（我自己做）

- **生成工程**：`p12-phys`、`p12-phys2` dev 回放，整帧与 `g_Bones` 比 WPE（现成抓帧）。
- **语料**：`2345214324`、`3426865175`（复制工程，后者要把属性改成可见），按 WPE 帧时间回放比 `g_Bones` 与整帧；抓一段更长的（≥ 200 帧）看包络。
- **不变**：`kbp corpus scan` 只去掉 `puppet:physics`；P12a–c 的生成工程逐字节不变。
- **收尾**：`WPE_SCENE.md`、cocs 索引、回归表、changelog、PLAN.md 与总计划的进度。

## 待定（向用户确认）

1. **骨骼脚本 API 做不做**：
   - **背景**：4 个方法只解锁 `3359451610` 一张（拖动小鸡 / 角色的骨骼、松手后弹回）。要先补一轮读码，`setBoneTransform` 与动画、物理的先后没读过；还要补实测。
   - **推荐**：先做 P12d-1（物理，解锁 2 张），P12d-2 紧接着做，同一节里交付。
   - **另一种**：P12d 只做物理，骨骼 API 照报，以后再说。
2. **语料 0 处的物理参数**：`lt`（每轴角速度限幅）、平移轴锁、`t + re` 读码都有公式，但没实测。
   - **推荐**：照读码一起实现，各写单测，文档标「未实测」。代码量很小，不实现的话只会让将来的场景静默画错。
   - **另一种**：照报 `puppet:physics:<键>`，等语料出现再测。

## 实施记录

### 决定（2026-11-15 用户：可以，开始）
- 待定 1：做 P12d-2，先物理、后骨骼 API，同一节里交付。
- 待定 2：`lt`、平移轴锁、`t + re` 照读码一起实现，写单测，文档标「未实测」；不报 `puppet:physics:<键>`。

### P12d-1 — 物理（2026-11-15）
- 执行代理（sonnet）实现：
  - `compile/puppet.ts` 的 `BonePhysics` / `parseBonePhysics`，`skeleton.physics`；
  - 新文件 `puppet/physics.ts`（`solveBone`）；
  - `skinMatrices` 的每骨骼回调；
  - `ScenePuppets` 的物理运行时：两份世界缓冲每帧交换、`cur` 写全部骨骼、`worldBones` / `physicsStates`；
  - `stateSink` 的 `world`（`drawMatrixOf`，不走挂点）。
  宿主与探针都经 `stateSink`，没改 `host.ts` 和 `dev/*`。
- 夹具（`puppet/physics.test.ts`，WPE 抓帧）：
  - `p12-phys`：re / se / ronly / tse 逐位相同，re_ge 1.53e−5；
  - `p12-phys2`：ronly_y / se_y 逐位相同，re_y 5.3e−5、re_rot 4.6e−5、se_rot 3.59e−4；
  - `2345214324`：帧 216–220 4.83e−3；
  - `3426865175`：帧 190–192 为 0。
  都在 p12-REPORT python 模型的量级以内或更好。
- 主会话审查：求解器对照读码 2.4 逐段一致。
- 主会话变异：
  - 第一轮 16 个杀死 14 个：
    - 「`refresh` 也解」等价（dt 0 时求解是空操作）；
    - 「`la` 不扣角速度」存活（语料两张带 `la` 的都没碰到限位）。
  - 补测 `puppet/physics.branches.test.ts`：夹具 `phys-branches.json`，由 `ignore/p12/d/impl1/mkfix_branches.py` 用 `physmodel.solve` 在构造输入上生成；覆盖 `la` 撞限位、`lt`、`t + re`（带 `ts`，区分加不加弹簧）、平移轴锁，相对 1e−5 一致。
  - 对这几个分支的 5 个变异全部杀死。这些分支只证明与读码模型一致，没有 WPE 实测。
### P12d-2 — 骨骼脚本 API（2026-11-15）
- 执行代理（sonnet）实现：
  - `ScenePuppet.names` / `boneCount`；
  - 缺失表删 5 个方法；
  - `physics.ts` 的 `applyBoneImpulse`；
  - `ScenePuppets` 的 `boneTransform` / `setBoneTransform` / `applyBonePhysicsImpulse` / `resetBonePhysicsSimulation` / 选骨，静止捷径的 `restWorldBones`；
  - `api.ts` 的 `installBones`（图像层，沿用 `alignment !== undefined` 的判定）；
  - 宿主 / 探针的 `puppetLayers` 接上骨骼方法。
- 自己拿主意的几处（审查后保留）：
  - `setBoneTransform` 置 `restSkin = false`：否则静止 puppet 下一帧不重算，`set` 的值会一直留在画面上；
  - 缺矩阵或元素不是数时写单位阵（照读码）；
  - `names` / `boneCount` 可选。
- **WPE 实测**（主会话）：生成工程 `p12-bones`（`ignore/p12/d/defs/p12d.py`），抓帧 `A:\p12d\p12-bones-fps20-1920x1080\`（帧 199–298），日志 `ignore/p12/d/out/`。读码推断的几处全部成立：
  - `init` 里取骨骼矩阵全是单位阵；
  - `Mat4` 自有键只有 `m`；
  - 越界 / `1.5` / 空串 / 查不到返回单位阵；
  - `set` 当帧读回就是新值、子骨骼不跟；
  - 按名字 `set`、两参数冲量不抛错；
  - 静态 puppet（没有 `MDLS`）`getBoneCount()` 为 0。
- **夹具** `puppet/p12bones.test.ts`（真 `baseclasses.js`，读不到 WPE 安装目录时跳过）：
  - 355 行脚本日志、200 个 `g_Bones` draw 与 WPE **逐位相同**；
  - 覆盖 `set` 后的回弹、只持续一帧、空串只作用于骨骼 0、复位、两参数冲量、对没开物理的骨骼无效、按名字 `set`。
- 主会话变异：8 个全部杀死（失败值、缺省 `ang`、骨骼参数转换、`set` 的三处写入、推进前取矩阵、名字匹配、静止捷径写 `cur`）。

### 语料（2026-11-15，工作区快照）
- 233 张能渲染 182 → 185，解锁 `2345214324`、`3359451610`、`3426865175`。
- 去掉的键只有 `puppet:physics` 5 张，`getBoneCount` / `getBoneTransform` / `setBoneTransform` / `applyBonePhysicsImpulse` 各 1 张；没有新增键，`clean_lost` 0。

### 真机对照（2026-11-15）
- **整帧与 `g_Bones`**（dev 按 WPE 帧时间回放）：
  - `p12-phys2` 第 200 帧：最大差 1 级。
  - `2345214324` 第 220 帧：只有 5 个像素差、最大 2 级。
  - `3426865175` 第 192 帧：带物理的「苍月草2」`g_Bones` 与 WPE **逐位相同**；另两个 puppet 只差平移分量的 `rsqrtps`；整帧差在随机粒子、泛光、文字上。
  - `p12-phys` 的日志里混着两次运行，时间线解析不了，由夹具逐帧覆盖。
- **回归**：P12 的 8 个生成工程 22 帧逐字节相同。
- **期间插曲**：dev 应用（16:17 启动，不是本会话起的）一度「未响应」，导入失败；没有碰它，自己恢复后继续。
- **没做**：`3359451610` 的拖动（读码建议的用例 6）留给人工，回归表 PE3。

- 顺带修了 P12c 漏跑的 `render/p12b.test.ts`：它按源码文本断言探针里 puppet 先于粒子推进，P12c 把调用收进 `stepPuppets` 后文本变了，断言改成检查 `stepPuppets` 的调用位置。
