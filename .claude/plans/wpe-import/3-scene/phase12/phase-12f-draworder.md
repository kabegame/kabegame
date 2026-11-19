# P12f 子计划 — puppet 绘制组的绘制顺序轨道（`puppet:draw-order`）

> 总计划：[phase-12-puppet.md](phase-12-puppet.md)。前一步：[phase-12e-createlayer.md](phase-12e-createlayer.md)。
> 语义依据：
> - 读码：[rea-p12f-draworder](rea-p12f-draworder.md)（概括表、第 1–6 节、「对实现的含义」），沿用 [rea-p12-runtime](rea-p12-runtime.md) 6.4、[rea-p12-mdl](rea-p12-mdl.md) 7.2 / 7.3 / 9；
> - 实测：`ignore/p12/f/meas/REPORT.md`（工程 `ignore/p12/f/proj/p12f-order`，生成脚本 `ignore/p12/f/defs/p12f.py`，抓帧 `A:\p12f\order\`），p12-REPORT 第 7 节（`p12-order` / `p12-order2`）。
> 起因：语料清扫会话（2026-11-19，293 张、286 张干净）转来：工坊 `3577990983`、myprojects `3841310696` 只差 `puppet:draw-order`。
> 现状锚点取自 HEAD `5a640e69` 的工作区；`render/scene.ts`、`dev/probe.ts` 有别的会话没提交的改动，动工前再核对一次。

## 总体设计思路

WPE 的绘制顺序轨道只做一件事：在运行中改写 puppet 网格 0 的索引缓冲，让「绘制组」按一个整数键升序排列。加载时每个绘制组建一个节点（键的静态部分 = 骨骼基数 + 组偏移），节点表保持组表顺序，GPU 索引是文件里的原样。每帧推进 puppet 时，先把每骨骼的当前值复位成骨骼基数，再逐个可见动画层用这一层的 lo 帧轨道值去写它（覆盖、混合、加法三种叠法，加法减的是骨骼基数）；只要有一层写过，就在蒙皮之后用 `trunc(静态部分 + 当前值)` 重算每个节点的键，当前节点顺序不是非降序时做一次稳定排序（只比键），按新顺序重写索引缓冲，并按新顺序重建裁切命令表。节点顺序跨帧保留：并列的组保持上一次的相对顺序，不回到组表顺序；没有层写的帧什么都不做，层被隐藏或删掉之后顺序也保持。这些规则读码与 16 个生成 puppet 的实测全部一致（`ignore/p12/f/meas/REPORT.md`）。

我们照这个形状做，状态全部放在 puppet 运行时（`ScenePuppets`）里。编译期把绘制顺序轨道的值（按「帧 × 骨骼」排）和参与掩码转进 `PuppetAnimation`，把节点表、每骨骼基数、裁切记录放进 `ScenePuppet.order`。运行时在现有的逐层循环里、骨骼透明度旁边加一段写入，推进末尾重排；输出一个带版本号的「当前绘制」——整张网格按节点顺序拼出的 u16 索引，与有裁切记录时按当前顺序建出的命令表和分段索引。排序、键、三种叠法、命令表都是纯函数，放在新模块 `puppet/drawOrder.ts`，编译期（初始的组表顺序）与运行时（当前顺序）共用同一个建命令表的函数，现在 `compile/puppet.ts` 里的 `buildClipping` 搬进去并把「位置 = 组号」改成「位置 p 的节点是 `order[p]`」。

渲染器一侧改两处。没有裁切记录的 puppet 只有一次绘制，它的索引缓冲改成这个图层私有的、可写的缓冲（现在是按 mdl 视图全场共用的静态缓冲），版本号变了就 `writeBuffer`。有裁切记录的 puppet，命令表的条数与顺序会在运行中变（实测 `clip_move` 在 3 次与 4 次绘制之间切换，`clip_two` 两条记录换序），所以不能再在计划阶段把命令表展开成固定的步骤：计划改为给每个普通段槽位（最多记录数 + 1 个）和每条记录（遮罩 + 目标）各建一个绘制模板，编码时新的 `puppet-clip` op 按当前命令表现排——和粒子树的 `particle-tree` op 同一个思路。每个模板一块私有索引缓冲，版本变了才重写。静态的裁切 puppet（没有 bit3，语料 5 个网格）走同一条路，命令表就是编译期那一份，画出的绘制序列与 P12b1 逐个相同。

**关键决策与理由**
- 状态放运行时、不进 `SceneState`：绘制顺序没有脚本 API、没有属性绑定，只受动画层驱动；和骨骼透明度、变形权重同一层级。
- 节点顺序跨重编译接回（`carryOver`）：WPE 只有几何重建（`L` 虚函数 `+0xb0`）会重置，补测（`ignore/p12/f/meas/REPORT.md`「补测」，`p12f-rebuild`）证实运行中改 `size` / `colorBlendMode`、对象或动画层 `visible` 关开都不重置，顺序只在加载时回到组表顺序。我们因属性做的对象级重编译与整场重载是自己的产物，所以按对象接回节点顺序（网格 0 的组表与基数没变时），「清空脚本存储」时不接（同 P12e 的层表）。
- 裁切 puppet 统一走动态 op（「待定」1）：一条路径；P12b1 的生成工程逐字节不变作为验收。
- 有意不同只有 WPE 的崩溃与缺陷：有轨道没有 bit3（`puppet:order-track`，照报）、记录 flags bit3 的查表缺陷（`puppet:clipping:flags`，照报）。

## 步骤 0 结论（2026-11-19，读码与实测已完成）

读码 rea-F 概括表 1–6；实测 16 个 puppet 全部与读码模型一致（对照模型「每次重写都从组表顺序重排」0 项吻合）。对实现有影响的：
1. **键**：`cvttss2si(f32(base[骨骼] + 组偏移) + cur[骨骼])`，float32 相加后向零取整（`−0.9 → 0`、`−1.5 → −1`、`−100 + 49.5 → −50`），NaN 与越界得 `−2147483648`。组偏移、基数都在取整之内（实测 `trunc_off` / `trunc_base`）。
2. **`cur`**：每帧先复位成 `f32(base[i])`；覆盖 `cur = v`；混合 `f32(f32(f32(1 − w)·cur) + f32(v·w))`；加法 `clamp(f32(f32(f32(v − f32(base[i]))·w) + cur), min(cur, v), max(cur, v))`。只取 lo 帧。所以非覆盖时基数会算两次（`w0`：blend 0 得键 `2·base + 偏移`；`mix05`：150）；加法会被钳在 `cur` 与 `v` 之间（`add_clamp`、`add_base`、`ovr_add`）。
3. **触发**：只有不可见的层不写；权重 0、暂停、单次层停在末帧都照写、照触发（`w0`）。写入只看骨骼轨道 flags `& 3 != 1`。
4. **排序**：MSVC `std::stable_sort`、只比键（`<`）；先用同一比较器判当前顺序是否非降序，是就什么都不做。输入是上一次排过的顺序（`hist3`、40 组的 `tie40` 四段逐个吻合；不是 `meshDrawOrder` 的 `std::sort`）。
5. **没有写入的帧**：顺序、索引、命令表都保持（`hide` / `destroy` 实测）。
6. **裁切命令表**：按当前节点位置重建，规则同 P12b1（区间遮罩、末遮罩位置触发、按最小目标位置稳定排序），只是位置不再等于组号（`clip_move`、`clip_two` 四段逐个吻合，含绘制数变化）。
7. **模型对象不处理**这条轨道（rea-F 第 7 节；P12b2 已经这样）。

## 现状锚点

**a. mdl 解析只记「有没有」绘制顺序轨道，值跳过**（`compile/mdl.ts:793`–`800`、`:293`）
```ts
    // v5 的动画包围盒：六个 f32（min xyz、max xyz）
    const bounds = version >= 5 ? Array.from({ length: 6 }, () => reader.f32()) : null;
    let drawOrderTrack = false;
    if (version >= 6 && reader.u8()) {
      drawOrderTrack = true;
      scalars(trackCount);          // 现状：读过就丢
    }
```
```ts
  drawOrderTrack: boolean;          // MdlAnimation 上的布尔
```
每骨骼基数已解析：`skeleton.drawOrder: number[] | null`（`:693`，i32）。

**b. 编译期把绘制顺序轨道整条报掉**（`compile/puppet.ts:530`–`541`）
```ts
  if (!ctx.model) {
    if (animation.boneAlpha && !(ctx.meshFlags & 4)) out.push("puppet:alpha-track");
    if (animation.drawOrderTrack) out.push(ctx.meshFlags & 8 ? "puppet:draw-order" : "puppet:order-track");
  } else if (ctx.rootmotion && animation.flags & 0x1f800) out.push("model:rootmotion");
```

**c. 裁切命令表编译期按「位置 = 组号」建一次**（`compile/puppet.ts:760`–`842`，节选）
```ts
  const groups = mesh.drawGroups;
  ...
  const entries: Entry[] = records.map((record, index) => {
    for (let p = 0; p < groups.length; p++) {
      if (target[p] && record.list1.includes(p)) { ... }       // 现状：p 既是位置又是组号
      if (record.list2.includes(p)) { ... }
    }
  ...
  const segment = (positions: readonly number[]): number => {
    for (const p of positions) {
      const { start, count } = groups[p];                       // 现状：段内容按组号取
  ...
  return { commands, segments, records: records.map((record) => ({ mask: `materials/${record.name}.tex` })) };
```
`ScenePuppet.clipping: PuppetClipping | null`（`:217`）是它的结果。

**d. 运行时逐层循环里有骨骼透明度，没有绘制顺序**（`puppet/player.ts:1009`–`1067`，节选）
```ts
    for (const layer of runtime.layers) {
      const fields = state?.animationLayer(runtime.object, layer.id) ?? layer.def;
      if (!fields.visible) continue;                 // WPE 唯一的跳过条件（图像层）
      ...
      const w = layerWeight(layer, layer.clock, fields.blend);
      if (model && w === 0) continue;
      ...
      if (alpha && track.alpha)
        blendScalarAlpha(alpha, track.alpha, track.alphaMask, bones, at.lo, at.hi, at.frac, w, additive);
      // 现状：没有 A+0x108 的写入、没有重排
```
`PuppetRuntime`（`:254`）没有绘制顺序状态；输出访问器有 `skin` / `pose` / `boneAlpha` / `morph` / `bounds` / `blendMap`。

**e. 计划阶段把命令表展开成固定步骤**（`render/graph.ts:784`–`823`）
```ts
  const clipping = puppet.clipping;
  const clip = puppet.clip;
  if (!clipping) return [draw(normal, { kind: "scene" }, inputs(normal), input.blending, input.raster)];
  ...
  for (const command of clipping.commands) {
    if (command.kind === "normal") {
      steps.push(draw(normal, ..., command.segment));      // 现状：段号编译期定死
      continue;
    }
    steps.push({ kind: "clear", target: mask });
    steps.push(draw(maskPass, mask, ..., command.mask));
    steps.push(draw(clip.target, { kind: "scene" }, ..., command.target));
  }
```

**f. puppet 的索引缓冲按 mdl 视图全场共用、静态**（`render/scene.ts:4496`–`4512`）
```ts
      const segment = step.segment === undefined ? undefined : puppet.clipping?.segments[step.segment];
      meshDraw = {
        indexBuffer: segment
          ? this.meshBuffer(new Uint8Array(segment.buffer, ...), GPUBufferUsage.INDEX, `${name} segment ${step.segment}`)
          : this.meshBuffer(puppet.mesh.indices, GPUBufferUsage.INDEX, `${name} indices`),   // 现状：共用、不可写
        indexFormat: "uint16",
        count: segment ? segment.length : puppet.mesh.indexCount,
```
编码时 `item.mesh.count` 为 0 的绘制整次跳过（`:6909`），`particle-tree` op 已有「编码时现排」的先例（`:6986`）。

**g. 测试里对这两个键的断言**：`compile/p12e.test.ts:151`–`161`（`puppet:draw-order` 报进 `issues`）、`compile/mdl.test.ts:658`、`:685`、`:1139`、`:1201`，`compile/p12b2.test.ts:239`、`:305`（模型不处理）。

## 点 1 — mdl：保留绘制顺序轨道的值（`compile/mdl.ts`）

- **修改**：`MdlAnimation.drawOrderTrack: boolean` 改成 `drawOrder: Float32Array | null`，按「帧 × 轨道」排（同 `boneAlpha`），没有这一段为 null。
  > 说明：一个字段一个来源，不留并行的布尔；测试里的 `drawOrderTrack` 机械改成 `drawOrder !== null` / 给数组。
```ts
    let drawOrder: Float32Array | null = null;          // 修改：原 drawOrderTrack 布尔
    if (version >= 6 && reader.u8()) {
      // 每条骨骼轨道一条（u32 读了不用 + f32 块），排成「帧 × 轨道」，同骨骼透明度
      const values = new Float32Array(frames * trackCount);
      for (let b = 0; b < trackCount; b++) {
        reader.u32();
        const track = floatView(checkTrack(reader.block(), 4, frames));
        for (let k = 0; k < frames; k++) values[k * trackCount + b] = track[k];
      }
      drawOrder = values;
    }
```

## 点 2 — 纯函数模块（新 `puppet/drawOrder.ts`）

- **新增**
```ts
/** 绘制组节点（rea-F 第 1 节）：base = 骨骼基数 + 组偏移（i32，加载时算一次）。 */
export interface DrawNode { base: number; bone: number; start: number; count: number }
/** 裁切记录（P12b1 的字段 + 嵌套父记录下标，rea-F 5.3）。 */
export interface DrawRecord { name: string; flags: number; list1: number[]; list2: number[]; parent: number }

/** x86 `cvttss2si`：向零取整，NaN 与 |x| ≥ 2³¹ 得 −2147483648。 */
export function cvttss2si(x: number): number;

/**
 * 一层写一次（rea-F 2.2）：mask[i] 为 0 的骨骼跳过；v = track[lo × tracks + i]；覆盖 / 混合 / 加法三式，全程 float32。
 * 返回有没有写（有任一骨骼写过 = WPE 的 r14 |= 4）。
 */
export function blendDrawOrder(cur: Float32Array, base: Int32Array, track: Float32Array, mask: Uint8Array,
  tracks: number, lo: number, w: number, mode: "override" | "mix" | "add"): boolean;

/**
 * 重排（rea-F 第 3 节）：按 cur 重算 keys；order（节点下标）已非降序时返回 false、什么都不改；否则稳定排序（只比键）并返回 true。
 */
export function reorder(order: Int32Array, nodes: readonly DrawNode[], cur: Float32Array, keys: Int32Array): boolean;

/** 按节点顺序拼整张网格的 u16 索引（WPE 写主索引缓冲）。 */
export function orderedIndices(order: ArrayLike<number>, nodes: readonly DrawNode[], indices: Uint16Array): Uint16Array;

/**
 * 裁切命令表（原 compile/puppet.ts 的 buildClipping 的核心，rea-F 第 5 节）：位置 p 的节点是 order[p]，list1 / list2 按节点下标（= 组表下标）查，
 * 段内容按 nodes[order[p]]。编译期传组表顺序（结果与 P12b1 逐个相同），运行时传当前顺序。
 */
export function clippingTable(order: ArrayLike<number>, nodes: readonly DrawNode[], records: readonly DrawRecord[],
  indices: Uint16Array): Pick<PuppetClipping, "commands" | "segments">;
```

## 点 3 — 编译期（`compile/puppet.ts`）

- **修改** `PuppetAnimation`：加 `drawOrder: Float32Array | null`（「帧 × 骨骼」）与 `drawOrderMask: Uint8Array`（骨骼轨道 `flags & 3 != 1` 为 1，同 `alphaMask`）。只在 skinned 且网格 0 有 bit3 时转，否则 null / 空。`stubAnimation` 同步补这两项。
- **修改** `ScenePuppet`：加
```ts
  /**
   * 绘制组（P12f，rea-F 第 1 节）：网格 0 有 bit3 或有 v23 记录时有，否则 null。nodes 是组表顺序；dynamic = 网格 0 有 bit3（运行时会重排）；
   * base 是 MDLS 每骨骼基数（i32）。records 只在有裁切时非空。
   */
  order: { dynamic: boolean; base: Int32Array; nodes: DrawNode[]; records: DrawRecord[] } | null;
```
  `clipping` 保留（编译期按组表顺序用 `clippingTable` 建，静态 puppet 与第一帧用它）。
- **修改** `buildClipping`：只留校验与报键（`puppet:clipping:flags` / `:groups` / `:nested`），命令表交给 `clippingTable`；`clippingParents` 结果进 `DrawRecord.parent`。
- **修改** `animationIssues`：
```ts
    if (animation.drawOrder && !(ctx.meshFlags & 8)) out.push("puppet:order-track");   // 修改：有 bit3 时不再报 puppet:draw-order
```
- **新增**：网格 0 有 bit3 或有记录、而 `MDLS` 没有每骨骼基数时报 `puppet:draw-order:base`（WPE 加载读空指针，rea-F「没查清」4，推断崩溃；先扫语料确认 0 处，「待定」2）。

## 点 4 — 运行时（`puppet/player.ts`）

- **修改** `PuppetRuntime`：加
```ts
  /**
   * 绘制顺序（P12f）：只在图像层 puppet 的 order.dynamic 时有。cur = WPE 的 P+0x280（每帧复位成基数），order = 当前节点顺序（跨帧保留），
   * version 每次真的重排时 +1；indices / clipping 是按当前顺序拼好的输出。
   */
  readonly drawOrder: { cur: Float32Array; order: Int32Array; keys: Int32Array; version: number;
    indices: Uint16Array; clipping: Pick<PuppetClipping, "commands" | "segments"> | null } | null;
```
- **修改** `evaluate`（只在 `d !== null`，即真的推进时；`refresh` 不写不排，同纹理通道）：
  - 逐层循环之前：`cur` 复位成 `f32(base[i])`，`wrote = false`；
  - 每个可见层（不看权重，模型路径不进）：`track.drawOrder` 在时 `wrote ||= blendDrawOrder(...)`，叠法与 TRS 同一个判断（`w === 1 && !additive` 为覆盖）；
  - 推进末尾（蒙皮之后）：`wrote && reorder(...)` 为真时 `version += 1`，重拼 `indices`，有记录时重建 `clipping`。
- **新增** 访问器 `drawOrder(object)`：返回 `{ version, indices, clipping }` 或 null；没有重排过时 `version` 为 0、`indices` 是文件顺序、`clipping` 是编译期那一份。
- **修改** `carryOver`：按对象接回 `drawOrder.order`（同时重拼 `indices` / `clipping`、`version` 接着旧的 +1），条件是新旧 `ScenePuppet.order` 的节点数、每个节点的 `base` / `bone` / `start` / `count` 与记录都相同（mdl 没换）；不满足时从组表顺序重来。`cur` 不接（每帧复位）。「清空脚本存储」时待用运行时本来就不 `carryOver`，顺序随之回到组表顺序（「总体设计思路」关键决策 2，补测见 `ignore/p12/f/meas/REPORT.md`）。
- 渲染器侧每个模板记「已上传的版本」，建 draw 时记 −1：新建的（含重编译后的）缓冲第一次编码就按当前输出写一次，不假设是文件顺序。

## 点 5 — 渲染器（`render/graph.ts`、`render/scene.ts`、`render/puppet.ts`）

- **修改** `puppetSteps`：有裁切时不再按命令表展开，改为产出模板：普通段槽位 `k = 0 … 记录数`（同一个普通 pass），每条记录 r 一组「清遮罩 + 遮罩绘制 + 目标绘制」；步骤带 `clipSlot: { kind: "normal", slot } | { kind: "mask" | "target", record }`。没有裁切时不变（一个绘制）。
- **修改** `buildOps`：同一个 puppet 的这些模板收成一个新 op
```ts
  /** 有裁切的 puppet（P12f）：编码时按当前命令表现排——普通段画 normals[k]，裁切 r 先清遮罩 RT、再画 masks[r]、targets[r]。 */
  | { kind: "puppet-clip"; layer: SceneLayer; normals: Draw[]; masks: Draw[]; targets: Draw[] };
```
  `drawsToScene` 认它（同 `particle-tree`），`runOps` 与组的子树路径都处理它。
- **修改** puppet 的索引缓冲：`order` 非 null 的图层（dynamic 或有记录）每个绘制模板一块**私有**索引缓冲（容量 = 网格总索引数，空时 4 字节），不进 `meshBuffer` 的共用缓存；编码前比对 `puppets.drawOrder(object).version` 与上次写入的版本，不同就把对应段 `writeBuffer` 进去、改 `mesh.count`（段不存在的槽位 count 0，编码时本来就跳过）。没有 `order` 的 puppet 照旧共用 mdl 视图。
- **修改** `PuppetSource` 加 `drawOrder`（可缺，缺时按编译期的 `clipping` 与文件顺序画，手写的假来源与旧调用方不受影响）。

## 点 6 — 宿主与探针（`host.ts`、`dev/probe.ts`）

- **修改** `puppetProbe` / `host.puppets()`：每个 puppet 多给 `drawOrder: { version, order, commands }`（走查时按帧对 WPE 抓帧的索引顺序）。
- 确认 `renderFrame` 的确定性回放会推进 puppet（走 `advance`，不是只 `refresh`），否则探针按帧回放时绘制顺序不动。

## 行为对照表

| # | 情形 | WPE（读码 + 实测） | 我们 |
|---|---|---|---|
| 1 | 没有 bit3、没有记录 | 不建节点 | `order` 为 null，路径同以前 |
| 2 | 有记录、没有 bit3 | 节点按组表顺序，命令表建一次 | `order.dynamic` 假，命令表 = 编译期那份，经 `puppet-clip` op 画，绘制序列同 P12b1 |
| 3 | bit3、没有任何层写 | GPU 保持文件顺序（基数、偏移不起作用） | 同 |
| 4 | 键并列 | 保持当前节点顺序（稳定排序，输入是上一次的结果） | 同（`hist3`、`tie40`） |
| 5 | 权重 0 / 暂停 / 单次层停在末帧 | 照写照触发 | 同（`w0`） |
| 6 | 层被隐藏 / 删掉 | 不写；顺序保持 | 同（`hide` / `destroy`） |
| 7 | 负数与小数 | 向零取整，偏移与基数在取整内 | 同（`trunc*`） |
| 8 | 加法层 | 减骨骼基数、钳在 cur 与 v 之间 | 同（`add_*`、`ovr_add`） |
| 9 | 重排时的裁切 | 命令表按新位置重建（遮罩区间、段数、记录先后都会变） | 同（`clip_move`、`clip_two`） |
| 10 | 有轨道、没有 bit3 | 写空指针，崩溃 | 照报 `puppet:order-track` |
| 11 | 记录 flags bit3 | 查表缺陷（目标收进后面全部位置） | 照报 `puppet:clipping:flags` |
| 12 | 运行中改属性（`size`、`colorBlendMode`、对象 / 动画层 `visible` 关开） | 不重建几何、不重置顺序（补测 `p12f-rebuild`） | 重编译 / 重载时按对象接回节点顺序，结果同 WPE |
| 13 | 加载 / 清空脚本存储 | 节点 = 组表顺序、GPU = 文件顺序 | 同（不接回） |
| 14 | 模型对象 | 不处理 | 同 |

## 有意不同与已知差异（进 WPE_SCENE.md）

- 对照表 10、11：照报，不复刻。
- 换了 mdl 的重编译（节点表变了）从组表顺序重来；WPE 运行中不会换 mdl，语料 0 处。

## 执行代理拆分

两个执行代理（sonnet），先后做、各自单独验收；每步之后我独立审查（先 `git status` 查越界）、跑 tsc 与相关测试、做变异检查。`render/scene.ts`、`dev/probe.ts` 有别的会话没提交的改动：在 HEAD 的独立工作树里做、三方合并回主工作区。

- **P12f-1 — 解析、编译与运行时（点 1–4）**
  - 改：`compile/mdl.ts`、新 `puppet/drawOrder.ts`、`compile/puppet.ts`、`puppet/player.ts`；测试里 `drawOrderTrack` 的机械改名。
  - 夹具（我在派发前做好）：`puppet/fixtures/p12f-order.json`，由 `ignore/p12/f/fix/mkfix_f.py` 从生成工程、WPE 日志的逐帧 dt 与 `ignore/p12/f/out` 的实测索引抽出（16 个 puppet 的 mdl、`animationlayers`、第 240 / 242 / 248 / 252 帧的绘制序列）。
  - 测试：新 `puppet/drawOrder.test.ts`（键与取整、三种叠法的 float32 结果、`reorder` 的非降序判断与稳定性、`clippingTable` 按组表顺序时与现有 `compile/puppet.test.ts` 的裁切用例逐段相同，另加「位置 ≠ 组号」的用例）；新 `puppet/p12f.test.ts`（按夹具 dt 从第 1 帧推进，四个采样帧的 `drawOrder(object)` 与 WPE 逐个相同，含裁切命令与段；`carryOver` 接回节点顺序、节点表变了从组表顺序重来、清空脚本存储不接）；`compile/p12e.test.ts`、`compile/puppet.test.ts`、`compile/mdl.test.ts`、`compile/p12b2.test.ts` 的断言按新键改。
  - 验收：tsc 0 error；上述测试与 `puppet/` 下既有测试全过、断言不放宽；P12a–P12e 夹具（`p12script`、`p12bones`、`p12create`、`physics*`、`player`）不变。
- **P12f-2 — 渲染器与探针（点 5、6）**
  - 改：`render/graph.ts`、`render/scene.ts`、`render/puppet.ts`、`host.ts`、`dev/probe.ts`。
  - 测试：`render/graph.test.ts` 补「有裁切时产出模板」；新的纯函数测试：给定版本与命令表，算出每个模板该写的段与 count；`render/` 下读 puppet 的既有测试全过。
  - 验收：tsc 0 error；相关 vitest 全过；P12b1 的 `p12-clip` / `p12-clip2` 与 P12a–e 生成工程重渲和改动前逐字节相同（我来跑）。

主会话：审查与变异、真机走查、语料、文档。

## 验证

1. **单测**（只跑相关文件，`cd /D/Codes/kabegame`，`--config` 用大写盘符）：上面两步列的文件，外加 `puppet/*.test.ts`、`compile/p12*.test.ts`、`compile/puppet.test.ts`、`compile/mdl.test.ts`、`render/graph.test.ts`。
2. **变异**（按原字节还原，每个都要被测试杀死）：
   - 键：`Math.trunc` 换 `Math.floor`；偏移移到取整之外；去掉 `f32`；
   - 叠法：加法不减基数（减 0 / 减 1）；去掉钳制；混合的复位值改成 0；覆盖判断去掉 `!additive`；
   - 触发：权重 0 的层不写；不可见的层也写；`refresh` 也写；
   - 排序：非降序判断换成严格升序；稳定排序换成 `meshDrawOrder`；每次从组表顺序重排；没有写入时回到组表顺序；
   - 命令表：位置当组号（回到 P12b1 的写法）；记录按记录号而不是最小目标位置排；
   - 接回：`carryOver` 不接节点顺序；节点表不同也接；
   - 渲染：版本不变也重写（看计数探针）、版本变了不写。
3. **WPE 对照**（我自己做）：
   - 生成工程 `p12f-order`：dev 里按 WPE 帧时间（`kbp` 日志）回放，探针 `host.puppets()` 的顺序与命令表在第 240 / 242 / 248 / 252 帧和 WPE 逐个相同；整帧（`kbp cmp frame`）和 WPE 抓帧比，裁切 puppet 的遮罩 / 目标画面一致。
   - 两张真实壁纸的复制工程（`kbp content isolate`，只留那个 puppet 与它的父链、依赖）：WPE 抓一段（覆盖 `sl` 的「h」两次重写、「眼」加法层的几次重写，`眼睛` 的 8 种顺序里至少 3 种），逐帧比索引顺序（`get_mesh_data` 的 `indices`）与我们的回放；再比整帧。
4. **语料**（`kbp corpus scan`，项目表 `ignore/p6/e0/corpus-now4.json`，myprojects 每个场景目录用 `--project` 加进来；工作区快照对 HEAD）：`3577990983`、`3841310696` 变干净；其余逐张键不变，`clean_lost` 0；`puppet:draw-order:base` 0 处；体积变化（绘制顺序轨道很小）记一笔。
5. **回归**：P12a–P12e 的生成工程（含 `p12-clip` / `p12-clip2`）重渲，和改动前我们的帧逐字节相同。
6. **检查**：`deno task check -c kabegame`（cargo 那半被 dev 占用失败时只看 vue-tsc 与 wpe-scene 的 tsc）、Prettier。

## 文档

- `cocs/wpe/WPE_SCENE.md`：新节「puppet 绘制顺序（P12f）」：节点表与初值、`cur` 的复位与三种叠法、键与取整、触发条件、稳定排序与跨帧保留、裁切命令表随顺序重建、`puppet-clip` op 与私有索引缓冲、对照表、有意不同、走查结果；P12b1 一节里「命令表编译期建一次」改成链到这里；P12 照报清单去掉 `puppet:draw-order`。
- `cocs/README.md`：WPE_SCENE 条目主题加一句 P12f 摘要；适用场景加：puppet 部件前后遮挡和 WPE 不同或随动画该换不换（绘制顺序轨道、并列、加法层、隐藏后保持）、带裁切的 puppet 重排后眼睛等部位遮罩不对、`puppet:order-track` / `puppet:draw-order:base` 键。
- 读码与报告的更正（rea-F「对已有文档的更正」6 条）：`rea-p12-runtime.md` 6.4、`rea-p12-mdl.md` 7.2 / 7.3、`p12-REPORT.md` 一·7、二·3.4 / 3.5。
- `versions/latest/regression.md`：新节「场景壁纸 puppet 绘制顺序（P12f）」：PF0 单测与检查、PF1 语料、PF2 生成工程逐帧顺序、PF3 两张真实壁纸复制工程、PF4 P12a–e 不变、PF5 预览里看 3577990983 / 3841310696（需要人看）、PF6 非 Windows（本机不能测）。
- `versions/latest/changelog.md`：一行。
- `PLAN.md`、[phase-12-puppet.md](phase-12-puppet.md) 进度；本文件的实施记录。

## 待定

1. **有裁切的 puppet 是否统一走动态 op**：推荐统一（含没有 bit3 的静态裁切 puppet），一条路径，靠 `p12-clip` 系列逐字节不变验收；另一个选择是只给 bit3 的走新路径，静态的保留 P12b1 的展开（两条路径并存，改动面小一点）。
2. **网格要绘制组而 `MDLS` 没有每骨骼基数**：推荐报 `puppet:draw-order:base`（WPE 加载就读空指针，推断崩溃，按「崩溃组合照报」）。语料已查：要绘制组的网格 6 个（老语料 5 个 + `3841310696`）都有基数，0 处。
3. **重编译时节点顺序**（用户要求实测，2026-11-19 已测）：WPE 运行中改属性不重置（对照表 12），改为推荐跨重编译接回（点 4 的 `carryOver`），清空脚本存储时不接。
4. **夹具**：推荐把生成工程的 16 个小 mdl（共约几十 KB，base64）与实测序列放进 `puppet/fixtures/p12f-order.json`，单测不依赖 `ignore/`。

## 实施记录

- 2026-11-19：读码（rea-F）与实测（`ignore/p12/f/meas/REPORT.md`）完成，写本计划，等用户定「待定」。
- 2026-11-19：用户要求实测待定 3：`p12f-rebuild` 补测运行中改 `size` / `colorBlendMode` / 可见性，WPE 都不重置顺序，待定 3 改为推荐接回，点 4 补 `carryOver`。
- 2026-11-19：用户同意待定 1、2、4 按推荐、3 改为接回，开工。
  - **夹具**：`ignore/p12/f/fix/mkfix_f.py` 从 `logs/order.log`（WPE 日志里这次开窗的一段）、生成工程与 `out/f*-ev*.json` 抽出 `puppet/fixtures/p12f-order.json`（30.9 KB）。
  - **P12f-1**（sonnet，HEAD `59ee7e06` 的独立工作树 `ignore/p12/f/wt`）：点 1–4。与计划的出入：
    - `drawOrder` / `drawOrderMask` / `order` 做成可选键，没有时不写，bundle 字节同以前；
    - `puppet:draw-order:base` 不要求 skinned，报了仍按基数 0 建节点；
    - `clippingTable` 没有记录时返回整张网格一个普通段（调用方只在有记录时调）。
    
    审查补了一条单测：变异「不可见的层也写」原先存活，夹具的 hide 前后写同一个常量，测不出来。
  - **P12f-2**（sonnet，同一工作树）：点 5、6。与计划的出入：
    - 模板标记叫 `clipSlot`，清遮罩步骤带 `clipRecord`；
    - 私有索引缓冲的条件是「有 `clipSlot` 或 `order.dynamic`」，手写的裁切图层没有 `order`；
    - 探针给 `{ version, commands, segments, indices }`，没给节点顺序（要改 player.ts）；
    - P12b1 的 `p12b.test.ts` 里按命令表展开的断言改成模板形状，编码 trace 的断言没动、仍过。
    
    审查改了一处：已上传的判断加上来源对象（换了运行时而版本号碰巧相同时会漏写）。
  - **验收**：
    - tsc 0 error，相关 vitest 全过；
    - 变异 24 个全部杀死（`ignore/p12/f/impl/mutate1.py`、`mutate2.py`，按原字节还原）；
    - 带 `KABEGAME_WPE_ROOT` 的本机语料用例另有 4 条失败，在 HEAD 上同样失败（P6e 的 `refract`、`pipeline` 语料界限、`scriptApi` 的 3304642534），与本步无关。
  - **合并**：工作树相对 `59ee7e06` 的补丁直接套进主工作区（上游 `1d8eef6d` 只改了 `host.ts` 别处，没冲突），没有碰共享暂存区。Prettier 修了 4 个文件里我们自己那几段的换行。
  - **走查**（回归 PF0–PF4，记录在 `ignore/p12/f/`）：
    - `p12f-order`：夹具与 dev 真渲染器的逐 draw 轨迹都 29 个 puppet-帧与 WPE 逐个相同；
    - 两张真实壁纸的复制工程各 100 帧整帧最大差 2，`sl` 第 220 帧与 `眼睛` 第 230 帧的索引与 WPE 逐个相同；
    - 语料干净 286 → 288，没有新键；
    - P12a–e 生成工程 22 帧逐字节相同。
    
    测试行已用 `projects_remove` 移除。
  - **文档**：WPE_SCENE（新节与 P12a / P12b1 的指向）、cocs/README、读码与报告的 6 条更正（rea-p12-runtime 6.4、rea-p12-mdl 7.2 / 7.3、p12-REPORT 一·7 / 二·3.4 / 3.5）、regression、changelog、PLAN、phase-12-puppet。待用户：回归 PF5（预览里看两张）、提交。
