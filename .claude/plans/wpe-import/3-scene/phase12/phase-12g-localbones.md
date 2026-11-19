# P12g 子计划 — puppet 骨骼的局部读写脚本 API（`getBoneIndex`、`get/setLocalBone*`）

> 总计划：[phase-12-puppet.md](phase-12-puppet.md)。前一步：[phase-12f-draworder.md](phase-12f-draworder.md)。
> 语义依据：
> - 读码：[rea-p12g-localbones](rea-p12g-localbones.md)（概括表、第 1–8 节、「对实现的含义」），沿用 [rea-p12d-bones](rea-p12d-bones.md) 1、3、4.3，[rea-p12-runtime](rea-p12-runtime.md) 6.1；
> - 实测：`ignore/p12/g/meas/REPORT.md`（工程 `ignore/p12/g/proj/p12g-local`、`p12g-args`，生成脚本 `ignore/p12/g/defs/p12g.py`，抓帧 `A:\p12g\local\`、`A:\p12g\args\`）。
> 起因：语料清扫会话（2026-11-20）转来：myprojects `3820240793` 只差 `script:api:layer.getBoneIndex`、`getLocalBoneTransform`、`setLocalBoneTransform`。
> [phase-12d-physics.md](phase-12d-physics.md) 当时把这 8 个方法定为「语料 0 处，照报」，这是第一次有语料用到。
> 现状锚点取自 HEAD `60c0588e` 的工作区。

## 总体设计思路

WPE 的 puppet 运行时每根骨骼有一份局部矩阵 `Local`（`P+0x310`）。每次推进都对全部骨骼重写它：
- 没有可见动画层时，取静止来源矩阵；
- 有可见动画层时，取混合后姿势的 TRS 矩阵。

然后沿父链算模型空间姿势 `Pose`、蒙皮 `K`、世界骨骼矩阵 `World = W·Pose`。

脚本的 `setLocalBone*` 只做两件事：
- 改 `Local[i]`；
- 当场重算骨骼 i 及其子孙的 `Pose`、`K`、`World`。三处都是完整 4×4 乘法；`W` 取调用那一刻的图层矩阵。

所以：
- 写入当帧就进 `g_Bones`；
- 下一次推进就被盖掉，写一次只管一帧；
- 不进动画混合，也不进下一帧的静止来源。

实测全部吻合：
- 一帧写入只出现在那一帧的 `g_Bones` 里；
- 事件回调里的写入在同一帧就被推进盖掉；
- 子树里的物理骨骼看不到摆动；
- 原样写回会让低位按完整乘法变化。

所以实现是「加一份持久的 `local` 缓冲 + 一个子树重算函数 + 8 个读写方法」，不改动画、混合与物理的算法。

**数据流**
- `skinMatrices` 每次推进把每根骨骼的局部矩阵留在 `runtime.local`（今天它只是一个临时格）。
- 脚本 API 经宿主的 puppet 视图调到 `ScenePuppets`：
  - 读：拷 `local[i]`，`Angles` 由它分解，`Origin` 取平移列；
  - 写：改 `local[i]` 后调 `recomputeSubtree`，按下标从 i 往后扫，父在脏集合里的才算。它写 `world`（`Pose`）、`skin`（`K`）、`physics.cur`（`World`）三份，并清掉静止捷径。
- 下一帧推进时：
  - `cur` 先和 `prev` 交换，所以脚本重算出的 `World` 成了物理的上一帧矩阵，这是写入唯一的跨帧痕迹；
  - 然后 `local` / `world` / `skin` 全部重写。

`getBoneIndex` / `getBoneParentIndex` 不依赖推进（WPE 只看骨骼表），在 API 一侧用编译期的骨骼名与父表回答，`init` 里、静态 puppet 上都能用。

**关键决策**
- **`W` 取调用时刻**：实测同帧先改图层 `origin` 再写，被重算的子树用新 `W`，其余骨骼仍是推进时的。宿主的 `PuppetSink.world` 本来就是「调用那一刻的状态」，`ScenePuppets` 留住本帧的 sink，写入时现取。
- **子树重算用完整乘法**：与推进的仿射乘法结合顺序不同，原样写回也会变低位（实测 1e-6 级），必须照抄。新函数用 `math.ts` 的 `mulFull`，推进照旧用 `mulAffine`。
- **事件与播完回调挪到蒙皮之前**（待定 1）：WPE 在逐层循环之后、交换与重写局部矩阵之前派发（rea-p12g 8.5、实测 le4）。我们现在是推进完、蒙皮之后才派发，回调里写的局部矩阵会留到绘制。挪到前面之后：
  - 回调里读到的骨骼矩阵也是上一帧的，同 WPE；
  - 回调里的写入被本帧推进盖掉；
  - 姿势、混合、建删层的时机都不变，层循环已经结束。
- **Angles 的三角函数用 `Math.atan2` / `sin` / `cos` 再 `fround`**：WPE 是 CRT 的 `atan2f` / `sinf` / `cosf`。实测的几组读回值进夹具比对，对不上的按 1 ulp 记为已知差异，不移植 CRT。

## 步骤 0 结论（2026-11-20，读码与实测已完成）

| 问题 | 结论（读码 + 实测） |
|---|---|
| 写到哪、何时生效 | 只写 `Local[i]`，当场重算子树（`Pose`、`K`、`World`，完整乘法，调用时刻的 `W`），当帧进 `g_Bones`（实测 lb：写入帧的 `g_Bones` 平移、前后帧复位） |
| 保持多久 | 到下一次推进为止。无层时推进取静止来源，有层时取动画（实测 le1 / le2：每帧读到的都是纯动画值） |
| 读到什么 | `Local[i]` 的拷贝。第一帧即 MDLS 局部（逐字节），同帧 set 之后读回新值，`init` 里返回单位阵 |
| Angles | 弧度，`R = Rz·Ry·Rx`。get 不去缩放，set 重写前三列，丢掉缩放、保留平移。读回值见实测表 7、8 |
| Origin | `c3.xyz`，set 只改这三个数 |
| 选骨与失败 | 同 `getBoneTransform`：Int32 下标或名字（第一个、区分大小写），空串、1.5、越界、没推进过都失败。get 返回单位阵 / (0,0,0)，set 不做事，都不抛错。第二个参数缺省或类型不对时照写单位阵 / (0,0,0)（实测表 10） |
| `getBoneIndex` | 只收字符串，失败 −1。不依赖推进，`init`、静态 puppet 都能用 |
| `getBoneParentIndex` | 整数按骨骼数判界，根返回 −1；名字取第一个同名且有父的骨骼。失败 −1 |
| 物理 | 子树里的物理骨骼当帧的增量被丢，画面不摆（实测 lf1）。`World` 成为下一帧物理的上一帧矩阵（lf3 的状态演化因此不同） |
| `setBoneTransform` 先后 | 它不写 `Local`。之后对它的子骨骼 setLocal 会以它写的姿势为父；对它或祖先 setLocal 会把它冲掉（实测 t16 / t17） |
| 事件回调 | 写入被本帧推进盖掉（实测 le4） |
| 没查清、不做 | IK 是否另写 `Local`（语料 0 条 IK 链）；混合形状 3 个方法（语料 0 处，照报） |

## 现状锚点

**a. 缺失表**（`compile/scriptApi.ts:113`）：这 8 个方法和混合形状 3 个都还在表里，用到就报 `script:api:layer.<名>`。
```ts
    ...methods(
      "any",
      [
        "getLocalBoneTransform",
        "setLocalBoneTransform",
        "getLocalBoneAngles",
        "setLocalBoneAngles",
        "getLocalBoneOrigin",
        "setLocalBoneOrigin",
        "getBoneIndex",
        "getBoneParentIndex",
        "getBlendShapeIndex",
        "getBlendShapeWeight",
        "setBlendShapeWeight",
      ],
      UNIQUE,
    ),
```

**b. 编译期的骨骼名**（`compile/puppet.ts:676`）：骨骼名与骨骼数静态 puppet 也有；父表只在 skinned 的 `skeleton.parents` 里，越界的父已规整成 −1。
```ts
    names: (skeleton?.bones ?? []).map((bone) => bone.name),
    boneCount: skeleton?.bones.length ?? 0,
```

**c. 蒙皮**（`puppet/pose.ts:235`）：局部矩阵只在临时格 `scratch.local` 里，算完就丢；`Pose` 与 `K` 都是仿射乘法。
```ts
export function skinMatrices(pose, skeleton, world, out, afterBone?): void {
  ...
  for (let i = 0; i < bones; i++) {
    if (pose) trsMatrix(pose, i * POSE_STRIDE, local, 0);
    else for (let k = 0; k < 16; k++) local[k] = restMatrices[i * 16 + k];   // 现状：local 是 scratch，不留
    const parent = parents[i];
    if (parent < 0) world.set(local, i * 16);
    else { mulAffine(world, parent * 16, local, 0, temp, 0); world.set(temp, i * 16); }
    afterBone?.(i);
  }
  for (let i = 0; i < bones; i++) { mulAffine(world, i * 16, inverseBind, i * 16, temp, 0); /* 取 12 个数进 out */ }
}
```

**d. 一帧的顺序**（`puppet/player.ts:621`）：先推进加蒙皮，再派发事件和播完回调。
```ts
  frame(dt: number, state?: PuppetSink | null, hooks?: PuppetHooks | null): void {
    const d = f(dt);
    for (const runtime of this.runtimes) {
      this.evaluate(runtime, d, state ?? null);   // 现状：层循环 → 交换 → skinMatrices → 重排
      this.dispatch(runtime, hooks ?? null);       // 现状：蒙皮之后才派发
    }
  }
```

**e. `setBoneTransform` 的 `W`**（`puppet/player.ts:673`）：用推进时存下的 `physics.layerWorld`，不是调用时刻的。
```ts
    const inverse = new Float32Array(16);
    inverse4(physics.layerWorld, 0, inverse, 0);   // 现状：推进时的 W
    mulFull(inverse, 0, matrix, 0, physics.temp, 0);
```

**f. 静止捷径**（`puppet/player.ts:1203`）：没有可见层、上次也是静止时跳过蒙皮。脚本写过局部矩阵之后必须让它失效。
```ts
    if (!posed) {
      if (runtime.restSkin && !runtime.physics?.active) {
        this.restWorldBones(runtime, d, state);
        return;
      }
```

**g. 脚本 API**（`script/api.ts:1576` 的 `installBones`、`:120` 的 `PuppetLayersView`）：只装了 P12d-2 的 5 个方法。选骨规整（Int32 → 下标，字符串 → 名字，其余 → 空串）与 Mat4 实参转换写在方法里。宿主在 `host.ts:1564` 把视图接到 `ScenePuppets`。

## 点 1 — 编译期（`compile/puppet.ts`、`compile/scriptApi.ts`）

- **新增**
  - `ScenePuppet.parents?: number[]`：MDLS 的原始父下标（`0xffffffff` 记 −1，不规整越界），与 `names` 同在，静态 puppet 也有。只给 `getBoneParentIndex` 用。
```ts
    names: (skeleton?.bones ?? []).map((bone) => bone.name),
    boneCount: skeleton?.bones.length ?? 0,
    parents: (skeleton?.bones ?? []).map((bone) => bone.parent),   // 新增：getBoneParentIndex（P12g），原样
```
- **修改**
  - 缺失表删掉 8 个方法，只留 `getBlendShapeIndex`、`getBlendShapeWeight`、`setBlendShapeWeight`；注释补一句「`getBoneIndex` / `getBoneParentIndex` / `get/setLocalBone*` 已实现（P12g）」。

## 点 2 — 局部矩阵的纯函数（新 `puppet/localBones.ts`）

按 rea-p12g 第 2、4 节逐条写，全部 float32（`Math.fround`），结合顺序照汇编。

- **新增**
```ts
/** getLocalBoneAngles（rea-p12g 4.1）：对 Rz·Ry·Rx 求逆，不去缩放；返回 [x, y, z]（弧度）。 */
export function localAngles(m: ArrayLike<number>, o: number): [number, number, number];
/** setLocalBoneAngles（4.2）：重写前三列（w 写 0），平移列不动。 */
export function writeLocalAngles(local: Float32Array, o: number, v: readonly [number, number, number]): void;
/**
 * 子树重算（rea-p12g 2，FUN_14020db40）：从 i 起按下标往后扫，父在脏集合里的才算；Pose[j] = 父 < 0 ? Local[j] : Pose[父]·Local[j]，
 * K[j] = Pose[j]·绑定逆[j]（取 12 个数），World[j] = W·Pose[j]。三处都是 mulFull。world / skin / cur 原地写。
 */
export function recomputeSubtree(i: number, parents: Int32Array, local: Float32Array, inverseBind: Float32Array,
  W: Float32Array, world: Float32Array, skin: Float32Array, cur: Float32Array): void;
```

## 点 3 — 运行时（`puppet/pose.ts`、`puppet/player.ts`）

- **修改** `skinMatrices` 加可选参数 `localOut`：每根骨骼的局部矩阵另拷一份进去（`P+0x310`），其余不变。
```ts
export function skinMatrices(pose, skeleton, world, out, afterBone?, localOut?: Float32Array): void {
  ...
    else for (let k = 0; k < 16; k++) local[k] = restMatrices[i * 16 + k];
    localOut?.set(local, i * 16);   // 新增：留下 Local（P12g）
```
- **新增**
  - `PuppetRuntime.local: Float32Array`（骨骼数 × 16），`evaluate` 的两处 `skinMatrices` 都传它。静止捷径不重写它：上次静止之后没人写过，它本来就是静止来源。
  - `ScenePuppets` 留住本帧的 sink（`frame` / `refresh` 里记下），给写入现取调用时刻的 `W`：`sink.world(object) ?? physics.layerWorld`。
  - 6 个方法：
    - 读：`localBoneTransform(object, b)`、`localBoneAngles(object, b)`、`localBoneOrigin(object, b)`，返回拷贝或 `null`，由 API 换成单位阵或 (0,0,0)；
    - 写：`setLocalBoneTransform(object, b, m)`、`setLocalBoneAngles(object, b, v)`、`setLocalBoneOrigin(object, b, v)`，写 `local[i]` 后调 `recomputeSubtree`，再置 `restSkin = false`。
    - 选骨都用现有的 `selectBone(runtime, b, false)`：要求推进过，空串失败。
- **修改**
  - `setBoneTransform` 的 `W` 改成调用时刻的（待定 2），求逆处换成同一个取 `W` 的函数。
  - 派发挪到蒙皮之前（待定 1）：`evaluate` 在层循环结束、物理交换之前调 `dispatch`，`frame` 里不再另调；`refresh`（`d` 为 null）不派发，同现状。
```ts
  frame(dt: number, state?: PuppetSink | null, hooks?: PuppetHooks | null): void {
    const d = f(dt);
    this.sink = state ?? null;                                    // 新增：写入现取 W
    for (const runtime of this.runtimes) this.evaluate(runtime, d, state ?? null, hooks ?? null);   // 修改：派发进 evaluate
  }
  private evaluate(runtime, d, state, hooks = null): void {
    ... // 层循环（不变）
    if (d !== null) this.dispatch(runtime, hooks);               // 新增：逐层循环之后、交换与重写 Local 之前（WPE 0x14020028a 之前）
    ... // 静止捷径、交换、skinMatrices(…, runtime.local)、重排（不变）
  }
```

## 点 4 — 脚本 API 与宿主（`script/api.ts`、`host.ts`）

- **新增**（`installBones`，只图像层，模型、文本、粒子、声音层上没有，调用照 JS 抛 `TypeError`）
  - `getBoneIndex(name)`：只收 JS 字符串，非空且在 `puppet.names` 里取第一个，否则 −1。不看运行时，非 puppet 为 −1。
  - `getBoneParentIndex(b)`：规整同选骨。整数要求 `0 ≤ b < names.length`，返回 `parents[b]`（−1 原样）；字符串取第一个同名且父 ≠ −1 的骨骼的父；其余 −1。
  - `getLocalBoneTransform(b)` 返回新 `Mat4`；`getLocalBoneAngles(b)` / `getLocalBoneOrigin(b)` 返回新 `Vec3`（原型 `Vec3.prototype`，自有键 `x y z`），失败为单位阵或 (0,0,0)。
  - `setLocalBoneTransform(b, mat)`：Mat4 实参转换抽成函数，和 `setBoneTransform` 共用（不是对象或 `m` 不是数组 → 单位阵；非数元素保留单位阵对应位）。
  - `setLocalBoneAngles(b, v)` / `setLocalBoneOrigin(b, v)`：`vec3Arg(v, [0, 0, 0])`，缺省也照写。
  - 都返回 `undefined`、不抛错。
- **修改**
  - `PuppetLayersView` 加 6 个可选方法（同名、去掉 object），`host.ts` 的视图接到 `ScenePuppets` 的同名方法；
  - `installBones` 的头注释补 8 个方法。

## 行为对照表（实测值进夹具）

| 场景 | 预期 |
|---|---|
| `init` 里 `getBoneIndex('b1')` | 1；`getLocalBoneTransform(0)` 为单位阵 |
| 第 1 帧 `getLocalBoneTransform(1)` | MDLS 局部逐字节 |
| 只在第 n 帧写 b0 原点 | 第 n 帧 `g_Bones[b0..b2]` 平移、c0 不动，第 n+1 帧复位 |
| 有动画层每帧写 | 每帧读到的是纯动画值，写入不累积 |
| 事件回调里写 | 回调里读回新值，同帧 update 里已复位 |
| 物理骨骼在子树里 | 不摆；停写后从积累的状态出发 |
| 原样写回 | 子树 `g_Bones` 按完整乘法变低位（lh / li） |

## 有意不同与已知差异（进 WPE_SCENE.md）

- `Angles` 用 `Math` 三角函数，可能与 CRT 的 `atan2f` / `sinf` / `cosf` 差 1 ulp（夹具里对不上的列出来）。
- 子树只按「父下标比子小」扫，同 WPE；语料的 mdl 全部父在前。

## 执行代理拆分

一个 sonnet 执行代理，在独立工作树（HEAD 快照）里按点 1 → 4 做，最后三方合并进主工作区。
- 夹具：
  - `puppet/fixtures/p12g-local.json`：由 `ignore/p12/g/fix/mkfix_g.py` 从两份日志与 `wpe-local-bones.json` / `wpe-args-consts.json` 生成。内容有 mdl 的 base64、每个 puppet 的 WPE 帧时间线（`@f64`）、日志读回值、抓帧的 `g_Bones`。
  - 生成脚本由姐姐写好交给代理。
- 单测：
  - `puppet/localBones.test.ts`：纯函数，用实测的 Angles 读回值、t7 / t8 矩阵；
  - `puppet/p12g.test.ts`：按夹具逐帧回放 lb / lc / ld / lh / li / le1–le4 / lf1–lf3 / lg / lr，比 `g_Bones` 与日志读回值；
  - `script/p12gBonesApi.test.ts`：API 形状、失败值、缺参、非 puppet。

## 验证

- **代码检查**：tsc 0 错误；只跑相关 vitest（`puppet/`、`script/p12*`、`compile/puppet` / `scriptApi`）。
- **夹具对照**：p12g-local / p12g-args 的日志读回值与抓帧 `g_Bones` 逐位相同（Angles 允许 1 ulp）。
- **dev 真 GPU 路径**：`render_scene` 按 WPE 时间线渲染 p12g-local，trace 里的 `g_Bones` 与抓帧比（同 P12f）。
- **真实壁纸**：
  - `kbp content isolate 3820240793` 只留对象 0（带脚本），WPE 抓帧加日志，Kabegame 按日志回放，100 帧整帧对照；
  - 抽一帧比 `g_Bones`。
- **语料**：`kbp corpus scan` 同 P12f 的范围，只去掉这 3 个键，`3820240793` 变干净，没有新键。
- **回归**：P12a–f 的生成工程按原时间线重渲，和当时的帧逐字节比（派发挪位置要靠它兜底）。
- **变异**：
  - 子树重算换成仿射乘法；
  - `W` 取推进时的；
  - 写后不清静止捷径；
  - 派发挪回蒙皮之后；
  - Angles 不丢缩放；
  - `getBoneIndex` 收数字；
  - 缺参不写。

## 文档

- `cocs/wpe/WPE_SCENE.md`：新节「puppet 骨骼的局部读写（P12g）」，P12d 一节补指向。
- `cocs/README.md`：主题与适用场景。
- `versions/latest/changelog.md`：一行。
- `versions/latest/regression.md`：新节。
- `PLAN.md`、`phase-12-puppet.md`：进度。
- `phase-12d-physics.md`：「语料 0 处，照报」那句注明 P12g 已做。

## 待定

2026-11-20 用户同意，三项都按推荐。

1. **事件与播完回调的派发挪到蒙皮之前**：推荐挪。
   - **理由**：WPE 就是这个顺序，实测 le4 吻合。挪了之后回调里读写骨骼的语义都对上 WPE，姿势与建删层不受影响。
   - **代价**：P12c / P12e 的派发时机在代码上变了，靠 P12a–f 回归逐字节兜底。
   - **不挪的话**：回调里的 `setLocal*` / `setBoneTransform` 会留到绘制，记为有意不同（语料 0 处）。
2. **`setBoneTransform` 的 `W` 一起改成调用时刻的**：推荐改。rea-p12d-bones 本来写的就是调用时刻，现状只在「同帧先改图层变换再写」时有差别；改了以后两个写入口用同一个取 `W` 的函数。
3. **夹具放 `puppet/fixtures/`**：推荐，同 P12f。

## 实施记录

2026-11-20。

- **执行**：sonnet 执行代理在独立工作树 `ignore/p12/g/wt`（基点 `aeebf031`）里按点 1–4 实现。
  - 夹具 `puppet/fixtures/p12g-local.json` 由 `ignore/p12/g/fix/mkfix_g.py` 生成。lb、le1、le2、lg 的逐帧日志只留一部分，时间线截到最后一个抓帧之后 6 帧，共 154 KB。
  - 新增：`puppet/localBones.ts`、`localBones.test.ts`（13 个用例）、`p12g.test.ts`（11）、`script/p12gBonesApi.test.ts`（17）。
  - 改动：`compile/puppet.ts`、`compile/scriptApi.ts`、`puppet/pose.ts`、`puppet/player.ts`、`script/api.ts`、`host.ts`、`script/p12dBonesApi.test.ts`（缺失表的用例改成只剩混合形状）。
- **偏离与补充**：
  - **P12g-1**：dev 探针的脚本环境 `dev/probeScripts.ts` 另有一份 puppet 视图，计划只写了 `host.ts`，代理没改到。dev 真 GPU 路径上第一次回放时写入全部空操作（lb 读回 0、lf1 的物理还在摆）。合并后由主会话补上 6 个方法与 `Pick` 类型，重渲后吻合。
  - **P12g-2**：`refresh()` 也记 sink（`state ?? null`），之后的写入退回推进时的 `W`；`frame` 每帧先记，所以脚本阶段总是调用时刻的 `W`。
  - **P12g-3**：共用的 `vec3Arg` 对分量用 `Number()`，数字字符串（`"5"`）会转成 5，WPE 的 `IsNumber` 当 0。实测的 `'a'`、`Vec2` 都吻合，没改（会影响 P6d1a 的别的方法）。
  - 测试细节：两个变异（`World` 改仿射、子树把兄弟算进去）起初存活，代理把用例的 `W` 换成带旋转缩放的仿射矩阵，并先让兄弟的世界矩阵过期，之后检出。
  - le1–le4 夹具里有 64 个分量不逐位，是动画四元数转矩阵不复刻 `rsqrtps` 的已有差异，用 1e-6（日志）/ 1e-4 px（`g_Bones`）容差。
- **验收**（主会话独立复核）：
  - 工作树 `git status` 只有计划内的文件；tsc 0 错误；相关 vitest 30 个文件 570 过（主工作区 573 过，多出的是本机语料用例）。
  - 变异抽查 5 个全部检出：派发挪回蒙皮之后、`World` 用仿射乘法、写后不清静止捷径、父下标的名字路径不跳过根、写入的 `W` 取推进时的。脚本 `ignore/p12/g/impl/mutate.py`，按原字节还原、sha256 复核。
  - dev 真 GPU 路径：`p12g-local` 跑脚本回放到第 129、528 帧，13 个 puppet 的 `g_Bones` 全部与 WPE 逐位相同（`ignore/p12/g/meas/cmp_trace.py`），挂点子图层的 MVP 逐位相同（`cmp_child.py`）。
  - 真实壁纸复制工程 `3820240793-iso-pup`：100 帧（271–370）最大差 2，没有 > 2 的像素；第 300 帧 `g_Bones` 逐位相同。
  - P12a–e 回归：P12e 走查的 8 个生成工程按原时间线重渲（`ignore/p12/g/impl/reg_p12.py`），22 帧与 P12f 回归的帧逐字节相同，派发挪位置没有改变它们的画面。
  - 语料：同一基点有无 P12g 两份源码各扫一次（`ignore/p12/g/impl/corpus_scan.py`，`--src` 指向 `ignore/p12/g/base` 与工作树），294 张，干净 293 → 294，只去掉 3 个键，没有新键。
- **合并**：HEAD 期间走到 `277fbfd1`，那几个提交与主工作区别的会话的未提交改动都不碰 P12g 的文件，直接拷入，主工作区 tsc 0 错误。
- **文档**：
  - `WPE_SCENE.md` 新节「puppet 骨骼的局部读写（P12g）」，另改 P12c 的派发时机、P12d 的 `setBoneTransform` 与照报那句；
  - `cocs/README.md`、changelog、regression（PG0–PG6）、`PLAN.md`、`phase-12-puppet.md`、`phase-12d-physics.md`。
- **待用户**：回归 PG5（预览里看 `3820240793`）、提交。
