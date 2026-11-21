# P4j — `layerimage` 发射器与粒子的 `emitterimage` 依赖（子计划）

> 上级：[phase-4-particles.md](phase-4-particles.md)。2026-11-21 用户指出 myprojects 的 `3834803915`（战锤 40k 雨景）报 `particle:dependencies`，让 P4 接手；同一张另报 `particle:emitter:layerimage`，两项是一回事。233 张缺省语料里没有别的场景用它。
> 步骤 0 只调研；之后每步能单独验收、单独提交。数据放 `ignore/p4/j0/` 起。
> 用户要求（2026-11-21）：对照**最好注入 WPE 的随机数**做（逐粒子比），不只靠确定性设计。

## 总体设计思路

`layerimage` 是发射器类型 3：粒子的出生点不在球 / 盒里随机，而是在**另一个图层的图像**上按像素抽。被抽的图层由粒子对象的 `dependencies` 指定（元素 `{id, type: "emitterimage", index, mask}`，`type` 另有 `collisionmodel`），发射器记录里的一个下标（`rec+0x78`）选用第几个依赖。之前读码顺带看到的形状：
- 发射前从 `ctx+0x1a60` 的一个服务按依赖取一张**候选像素表**（每项 8 字节，高 32 位是两个 `short` 坐标，y 取负），表为空就不发射；
- 每颗粒子用场景随机数 `ctx+0x1cd0` 做无偏的整数抽样（乘法加拒绝）选一项，可选地按 `flags 0x80000` 加三维抖动；
- 依赖的图层是 puppet 时，每项还带一个部件 / 骨骼号（表项第 3 字节），出生点先乘那块的矩阵（`FUN_1401d4360`）；
- `flags 0x20000` 时按累计时间周期性刷新表（`rec+0x7c` 过 1 就重来）。

所以这件事分三块：**表从哪来**（CPU 解码纹理还是读回图层渲染结果、阈值 / 通道 / mip、刷新时机，决定我们在编译期还是运行时建表）、**每颗粒子怎么落点**（抽样、抖动、像素到粒子空间的映射、puppet 部件矩阵），以及**怎么验收**。前两块靠读码加确定性工程，第三块按用户的要求做随机数注入：发射是随机的，真实场景只能目视，确定性工程也只能把表压到一个像素。要逐粒子比，就让 WPE 和我们吃同一串随机数——用 Frida 在测试窗口的场景上顶替 WPE 的 MT19937 输出（同 `frida_input` 喂光标的做法），我们这边 `SeededRandom` 本来就收任意 32 位来源。这条工具对以后所有随机发射的对照都有用，作为步骤 0 的一部分先做可行性，再决定放进 `wpe-renderdoc` MCP 还是 kbp。

## 范围与解锁

- 场景：`D:\Applications\Steam\steamapps\common\wallpaper_engine\projects\myprojects\3834803915`（`scene.pkg`，正交 5120×2160，无 hdr / bloom）。
  - 粒子对象 id 188「Rain_Splash」：`particles/workshop/3374860211/Rain_Splash_copy2.json`，唯一的发射器 `{"id":10,"name":"layerimage","rate":500}`，`flags 2`、`maxcount 1000`、sprite `upright`、`animationmode sequence`，`eventspawn` 子系统 `Rain_Splash_Drops_copy1`（`maxcount 350`、`scale 0.2`）；材质 `materials/workshop/3374860211/particle/halo_1_1.json`。
  - 对象上：`"dependencies": [{"id": 229, "index": 0, "type": "emitterimage"}]`，`origin 2560 1080`，`instanceoverride.rate` 挂脚本（0.5），可见性绑用户属性 `rainsplash`。
  - 被依赖的图层 id 229「Warhammer 40k-M1.Mask」：`genericimage4` translucent、`autosize`、纹理 `Warhammer 40k-M1.Mask`（tex 573,688 字节）、`origin 2560 1080`、`size 4025×2460`、可见。
- 扫描：`kbp corpus scan --project <myprojects> --only 3834803915` 只报 `particle:dependencies`、`particle:emitter:layerimage`；做完预计能渲染 +1。

## 现状锚点

**a. 依赖检查**（`compile/features.ts` 约 857 行、`compile/dependencies.ts`）：
```ts
// features.ts：粒子对象的 dependencies 只要有非整数元素就整项报
if (hasNonNumericDependency(object)) unsupported.add("particle:dependencies");
```
`dependencyIds` 只收非负整数（图层依赖，P8 的合成 RT 依赖）；粒子的 `{id, type, index, mask}` 形式注释里写明未做。

**b. 发射器**（`particles/modules.ts`、`particles/emitters.ts`）：模块表只有 `sphererandom`（1）、`boxrandom`（2），`layerimage` 不在表里，由能力表报 `particle:emitter:layerimage`。

**c. 随机数**（`particles/random.ts`）：`SeededRandom(source: number | Uint32Source)` 收任意 32 位来源，`a()` / `b()` 照 WPE 的 `(u32 >> 8)·2⁻²⁴·(hi − lo) + lo`；现有的注入只顶替出生时的 `R` 列（`injectedR`、`kbp cmp random`，给 `randomframe` 用），顶替不了抽像素那一路。

## 步骤 0 — 调研

不改产品代码。

### 0a — 读码（一个子代理）

写 **`rea-p4j-layerimage.md`**，格式同 [rea-p4h-boids.md](rea-p4h-boids.md)，每条标地址和证据等级。要回答：
1. **解析**：`layerimage` 发射器自己的键（公共字段之外）、缺省、记录偏移（`+0x78` 依赖下标、`+0x7c` 计时、`+0x88..0x9c` 抖动、`+0xa0` 部件矩阵缓存、`+0xb8`、`flags` 的 `0x20000` / `0x80000` 及其它位）；粒子对象 `dependencies` 的解析（`FUN_14022af30`）：`id` / `type` / `index` / `mask` 各自的含义、存到哪、`index` 与发射器下标的关系、`mask` 是什么（纹理？通道？）、`collisionmodel` 顺带记一笔、依赖的图层不存在 / 不是图像层时怎样。
2. **候选表**：`ctx+0x1a60` 服务（`FUN_1401d3ae0` / `FUN_1401d42b0` / `FUN_1401d42e0` / `FUN_1401d4330`）怎么建表：读纹理文件的 CPU 像素还是读回 GPU（图层合成 RT？场景目标？）、哪一级 mip、哪个通道、阈值或权重（alpha > 0？> 某值？按亮度？每像素一项还是按值重复）、是否降采样 / 步长、表项 8 字节的布局（低 32 位是什么、x / y 的原点与单位、第 3 字节）、什么时候建（加载时、第一次发射时、异步——表没好之前的帧发不发、欠账怎样）、`0x20000` 的刷新周期与 `FUN_14041d0c0`。
3. **每颗粒子**：发射数（`min(maxcount − alive, n)`，表为空时 `local_80c = 0` 的欠账语义）、抽表项（`FUN_14007d8f0` 的无偏抽样逐行，表长 `n − 1` 的那个边界）、抖动（`FUN_1401f4bc0` 三次、`+0x88..0x9c` 的 min / 范围）、出生点公式：表项坐标 → 图层空间（图层尺寸 / 纹理尺寸 / `autosize` / 居中 / `alignment`）→ 粒子空间（`FUN_14005f730(ctx+0x30)`、`local_6e8` / `local_348` 是哪个矩阵、`FUN_14005ecb0(…, rec+0xb8)`、`FUN_1401842d0(local_6e8, 依赖对象+0x18)`），本地 / 世界系统的差别（rea-p4c-sim：本地 `M` 单位阵、世界 `mat3(模型栈顶)`），puppet 部件矩阵（`FUN_1401d4360`，`+0xa0` 每项 0x84 字节、每帧清的标志），出生速度 / 方向（`directions` / `speed` 用不用）、传给 initializer 的 `M`；每颗粒子按什么顺序抽随机数（表项、抖动、之后的公共字段）。
4. **运行时**：依赖图层运行中移动 / 缩放 / 隐藏 / 换纹理时表与映射跟不跟（每帧重取矩阵？），粒子对象与依赖图层的父链，子系统 / 事件实例里的 `layerimage`。
5. **随机数（为注入做准备）**：
   - 粒子模拟用到的全部随机入口（`FUN_14007f5b0`、`FUN_14007d8f0`、`FUN_1401f4bc0`、`FUN_14041d0c0` 若是，以及别的发射器 / initializer 用的），是否全部最终落到 `ctx+0x1cd0` 那一个 MT19937 的「取下一个 u32」函数；给出那个函数的地址、调用约定（状态指针在哪个寄存器）、是否有内联的副本（内联了就钩不全）。
   - `ctx` 是不是每个场景（每个窗口）一份；粒子更新与 `starttime` 预热跑在哪条线程（渲染线程？加载线程？）；同一个 `ctx+0x1cd0` 还被谁用（声音 `random`、抖动、脚本 `Math.random`、`hsvcolorrandom` 的 CRT `rand()` 已知是另一路）。
   - 播种：按时间播的那一处（地址），能不能在那里换成固定种子（另一种注入方式）。

### 0b — 随机数注入的可行性（Claude，按 0a 第 5 条）

- 目标：WPE 那边，本会话测试窗口的场景每次「取下一个 u32」返回一串约定的值（比如 mulberry32(种子) 的输出，或按调用序号查表）；我们这边 `SeededRandom` 用同一串。两边对同一工程的抽取顺序一致时，粒子逐个相同。
- 先手写一个 Frida 脚本（`ignore/p4/j0/rng/`）试：只钩本窗口的场景（按线程或按状态指针区分，桌面壁纸与别的会话的窗口不碰），记下每帧的调用次数与线程，确认预热与发射都在钩子之内；拿现成的确定性 `sphererandom` 工程（P4a / P4b 的）先验证一次逐粒子相同，再用到 `layerimage`。
- 可行就定落点：`wpe-renderdoc` MCP 加一个工具（同 `input_play` 的进程模型，`TODO:[WPE_SCENE_MCP]` 的形式记进它的 README）或 kbp 子命令，写进 kbp-tools skill；不可行就写明原因，退回确定性设计。
- 不动桌面壁纸、不动工坊内容；钩子随子进程退出卸掉。

### 0c — 确定性工程与实测（Claude）

- **新增** `ignore/p4/defs/p4j0.py`（`kbp gen p4j0`），遮罩图自己生成（几个不透明像素 / alpha 渐变 / 不同尺寸），按 0a 的结论覆盖：
  - 单像素遮罩：出生点钉死，核对像素 → 粒子空间的映射（图层平移、缩放、旋转、`autosize`、尺寸和纹理不同、父链）；
  - 多像素、alpha 不同：看是按阈值还是按权重（统计量，或注入随机数后逐粒子）；
  - 本地 / 世界系统；抖动开 / 关；依赖下标与多个依赖；依赖图层隐藏 / 运行中移动（脚本或关键帧）；
  - 依赖 puppet 的一组（若 0a 说要支持）。
- 抓帧（`wpe-renderdoc` MCP，`kbp rdc track`），0b 可行的组注入随机数逐粒子比；结论写进报告新节「P4j 语义的实测核对」。
- 雨景：WPE 里开一次（只读打开）抓帧，作真实场景的参照。

**验收：** 读码覆盖上面各项，都有地址、公式和证据等级；确定性工程的实测和读码逐条对上（对不上的以实测为准、写明）；随机数注入可行与否有结论（可行就有一个逐粒子相同的例子）；步骤 1 以后的划分写进本文件。

### 步骤 0 实施记录（2026-11-21）

**0a 读码。** 一个子代理（REA + `wp.asm`）写成 [rea-p4j-layerimage.md](rea-p4j-layerimage.md)，临时文件在 `ignore/p4/j0/rea/`。要点：
- **解析**：发射器多 4 个键（`speedmin` / `speedmax` / `offsetmin` / `offsetmax`），`flags` 缺省 0x10000；`flags` 的四个位：0x10000 颜色乘像素、0x20000 每秒重建表、0x40000 出生速度取像素点的移动速度、0x80000 三轴抖动。
- **依赖**：`dependencies` 的 `index` 是本系统里同类型槽的序号；`mask` 是纹理路径；`id` 也进对象的依赖集合，被引用的图层因此强制走合成路径、隐藏也画。这一条更正了 rea-p8-render。
- **候选表**：GPU 读回，依赖图层的合成 RT 用 `downsample_quarter` 降到约 1/4，alpha ≥ 127 的像素按列优先入表。三步状态机（过门 / 渲染拷贝 / 读回建表），前两个发射帧丢粒子、不欠账。`(id, mask)` 相同的依赖共享一张表。
- **随机数**：每个场景一个 MT19937，取数只有两个函数、没有内联副本，播种只在渲染器构造里一处。

**0b 随机数注入：可行，已在用。**
- WPE 侧：`ignore/p4/j0/rng/seed.py` 用 Frida 在 `wallpaper64.exe+0x17d6bc` 换种子，一次性、命中即退出，读回 `x[0]`、`x[1]` 核对。
- 我们这边：`kbp replay` 的钩子换成同一种子的 `std::mt19937`。
- 结果：`p4j-rng-a` / `p4j-rng-b` 逐粒子对上，位置差在近似倒数的包络内。
- 两个坑：
  - 第一版在命中后的 `script.unload()` 里卡住了，改成命中就输出、`os._exit`。
  - 换种子必须在开窗之前装好，因为渲染器构造、加载、预热紧跟建线程；`frida_input` 那种开窗后认线程的做法来不及。

**0c 实测。** 工程 `ignore/p4/defs/p4j0.py`（`p4j-li-map` / `-xform` / `-large` / `-jit` / `-move` / `-flags0`），种子 1001–1006，参考模型 `ignore/p4/j0/model.py`，结论见报告「P4j 语义的实测核对」。
- 读码各条都成立。
- 一处更正：有 `starttime` 预热时只丢 1 个发射帧，因为预热在加载那一帧已经过了门；读码实验 2 的预测是 2 个。
- 降采样的推算：读码建议的「4×4 对齐块」出不了表项（四个对角样本各只有 1/4 在块里，alpha 64）。8×8 对齐块出 2×2 项，系数 0.5625。
- 提取器补了「图像层 `draws: n`」，因为被依赖的图层每帧画两次；老工程重新提取逐字节相同。
- 雨景副本注入种子 1007 抓帧，留给走查。

## 步骤 1 以后（提议，待定）

| 步骤 | 内容 | 验收 |
|---|---|---|
| 1 | **编译期**：粒子 `dependencies` 的解析与绑定（读码 1.4 / 1.5 的门与同类型槽序号，子系统与事件实例用同一个对象的列表）；被引用的图层置「被依赖」（P8 的强制合成 + 独占 RT，隐藏也画）；模块表加 `layerimage`（4 个键、`flags` 缺省 0x10000）；`mask` 纹理进 bundle；能力表：依赖 puppet 图层报 `particle:layerimage:puppet`，`collisionmodel` 报 `particle:dependency:collisionmodel` | 单测；语料：雨景只剩运行时缺口 |
| 2 | **运行时的表**：GPU 上照 `downsample_quarter`（四个对角双线性样本、`mask.r` 乘 alpha）画到 `w4 × h4` 的 RGBA8 并读回，列优先收 alpha ≥ 127；三步状态机（共享记录、同帧后调的接着推进、预热只过门）；`0x20000` 每秒重建、合成 RT 尺寸变了重建，重建期间用旧表 | dev 探针读出表，和 `model.py` 的预测逐项相同（`li-map` / `li-large`） |
| 3 | **发射**：`emitters.ts` 的 `layerimage` 分支：数量与丢弃、Lemire 下标（`ParticleRandom` 要能取 u32）、抖动、`A = M⁻¹·L`（`L` 是图层本帧的绘制矩阵，含父链与 `alignment` 偏移）、颜色、`0x40000` 速度（`rec[0xb8]` 从单位阵起）、传给 initializer 的 `M3` | 回放案例：0c 的 6 个工程注入种子逐粒子比 |
| 4 | **注入工具落地与走查**：换种子进 `wpe-renderdoc` MCP、MT19937 进 kbp 回放库与 dev 探针（探针里整场共用一个随机源，按 WPE 的更新顺序）；雨景副本逐粒子比（三个粒子系统共用一串） | 雨景 `render_scene` 与 WPE 整帧比 |
| 收尾 | 文档、回归、changelog、覆盖数 | |

读回是异步的（WebGPU `mapAsync`），WPE 是第 3 个发射帧同步 `Map`。产品里表晚到时就晚几帧开始发射（已知差异，只影响开场几帧）；dev 探针回放时等读回，保证和 WPE 同帧。

**用户 2026-11-21：** 按上面的建议来：注入工具进 MCP 与回放库 / 探针，四步划分，产品里表晚到就晚几帧，puppet 依赖与 `collisionmodel` 照报。开始步骤 1。

## 步骤 1 — 编译期：依赖的解析与绑定、模块表

### 总体设计思路

这一步只动编译期，把 WPE 加载粒子对象时做的三件事照搬进 bundle，发射仍不做：

1. **依赖集合**：粒子对象 `dependencies` 的对象元素过三道门后，`id` 进对象的依赖集合（rea 1.4 第 8 条）。被引用的图层因此和 P8 的数字依赖一样「被依赖」：强制合成、独占 RT、隐藏也画。步骤 2 要读的合成 RT 由此已经存在，正好是 WPE 读回的那张。
2. **槽位绑定**（rea 1.5）：
   - 第 k 个 `layerimage` 发射器配 `type emitterimage`、`index k` 的依赖；同一个槽匹配多条时，后面的覆盖前面的。
   - 子系统与事件实例用同一个对象的列表，从 0 重新数。
   - 绑定结果按系统存在 `SceneParticle.emitterImages`：每个 `layerimage` 发射器一项，`{ id, mask, maskTexture }` 或 null。
   - 不建场景级的记录表，运行时（步骤 2）再按 `(id, mask)` 合并共享。这样片段编译（L1–L7）不用新增场景级增量，`mask` 纹理照常进 `bundle.textures`。
3. **模块表**：`layerimage` 进表，带 4 个自己的键，`flags` 缺省 0x10000；能力表按表生成。
   - 发射到步骤 3 才有，期间报过渡键 `particle:layerimage:pending`。
   - 系统步进照 WPE「没有表」时的行为：照常算发射数、推进计时与欠账，但一颗不生（rea 3.1：取不到表时要发的直接丢）。

依赖指向的对象：
- **照报**：
  - puppet 图层报 `particle:layerimage:puppet`，骨骼号分配没读全（2.6）；
  - 文本层报 `particle:layerimage:text`，文本层的 `L+0x2c8` 是不是独占 RT 没读（第 7 节）。
- **中性**：
  - 不存在或别的类型的对象：WPE 永远不发，我们运行时同样找不到；
  - `collisionmodel` 依赖：只进集合，用到它的 operator 本来就报 `particle:operator:collisionmodel`。

`particle:dependencies` 不再报。

### 现状锚点

**a. 依赖并集只收数字元素**（`compile/dependencies.ts`）
```ts
export function dependencyIds(objects: readonly SceneObject[]): Set<number> {
  const ids = new Set<number>();
  for (const object of objects)
    if (isSceneObject(object))
      for (const element of dependencyElements(object.dependencies))
        if (typeof element === "number" && Number.isInteger(element) && element >= 0) ids.add(element);  // 现状：对象元素跳过
  return ids;
}
export function hasNonNumericDependency(object: SceneObject): boolean { … }  // 现状：只给能力表报 particle:dependencies 用
```

**b. 能力表**（`compile/features.ts` 约 857 行）
```ts
if (hasNonNumericDependency(object)) unsupported.add("particle:dependencies");   // 现状：有对象元素就整张退回
```

**c. 模块表**（`particles/modules.ts`）：emitter 只有 `sphererandom`、`boxrandom`，`layerimage` 由 `checkParticleFeatures` 报 `particle:emitter:layerimage`。

**d. 发射循环**（`particles/system.ts` 约 1602 行）
```ts
for (const emitter of this.emitters) {
  const count = emissionCount(emitter.state, emitter.fields, dt, this.alive, capacity, this.random, this.context.audio, script);
  if (emitter.state.periodStarted) { … }
  for (let n = 0; n < count; n++) this.spawn(emitter);   // 现状：每条发射器都生
}
```

**e. 粒子系统的编译**（`compile/bundle.ts` 的 `compileParticleSystem`）：顶层与子系统共用，`parseParticle` 之后编材质、递归 `children`；没有读对象的 `dependencies`。

### 点 1 — 依赖的解析、并集与绑定（`compile/dependencies.ts`）

- **新增**
```ts
/** 粒子对象 `dependencies` 的一项（rea-p4j-layerimage.md 1.4，`FUN_14022af30`）。 */
export interface ParticleDependency {
  /** 1 发射图（`emitterimage`）、3 碰撞模型（`collisionmodel`）。 */
  type: 1 | 3;
  id: number;
  /** u32；本系统同类型槽的序号（1.5）。 */
  index: number;
  /** 纹理路径；不是字符串时为空串。 */
  mask: string;
  /** `id != 0`：0 进集合但永远绑不上。 */
  valid: boolean;
}

/**
 * 粒子对象的依赖（1.4）：元素是对象（非数组）才读；三道门 `id` 非负整数（< 2⁶⁴）、`index` 是 [0, 2³²) 的整数（缺了不过）、
 * `type` 是字符串；`type` 只认 "emitterimage" / "collisionmodel"（大小写敏感），其余跳过。JSON 顺序。
 * 不是对象的元素（数字等）WPE 这里怎么处理没读到【推：jsoncpp 的 operator[] 对非对象断言】，跳过；数字元素照旧进并集。
 */
export function particleDependencies(object: SceneObject): ParticleDependency[];

/**
 * 一个系统里每个 `layerimage` 发射器配到的依赖（1.5）：第 k 个 `layerimage`（只数 `layerimage`，别的发射器不占序号）配
 * `type 1`、`valid`、`index === k` 的最后一条（后面的覆盖前面的），没有为 null。
 */
export function bindLayerImages(
  emitters: readonly { name: string }[],
  dependencies: readonly ParticleDependency[],
): ({ id: number; mask: string } | null)[];
```
- **修改** `dependencyIds`：
  - 粒子对象（`objectKind(object) === "particle"`，同能力表）的 `particleDependencies` 每项 `id` 也进并集：两种类型都进，`id 0` 也进（1.4 第 8 条）。
  - 头注释补这一条，并更正 rea-p8-render「对象元素不进集合」的说法。
- **删除** `hasNonNumericDependency`。

### 点 2 — 模块表的 `layerimage`（`particles/modules.ts`、`particles/emitters.ts`）

- **新增**（表里 `boxrandom` 之后）
```ts
{
  // `FUN_1401b9930` 缺省（先调公共 `FUN_1401b8df0`），解析 `0x1401c6af1`，rea-p4j-layerimage.md 1.1–1.3
  category: "emitter",
  name: "layerimage",
  fields: {
    // 乘 `speed`（类型 6，`rec+0x80` / `+0x84`）；只在 flags 0x40000 时读（3.7）
    speedmin: by("speed", num(0.1)),
    speedmax: by("speed", num(0.2)),
    // 0x80000 的抖动（3.4）；缺省按正交 / 透视
    offsetmin: vec3({ orthographic: "-5 -5 0", perspective: "0 0 0" }),
    offsetmax: vec3({ orthographic: "5 5 0", perspective: "0 0 0" }),
    ...EMITTER_FIELDS,
    // 缺省 0x10000（`0x1401b999c`；公共缺省不补 flags，写了就是写的值）。bit0（sign）不读、bit1 / bit2 公共，
    // 0x10000 颜色乘像素、0x20000 每秒重建表、0x40000 速度、0x80000 抖动（1.3）；其余位没读到含义，照报
    flags: int(0x10000, (value) => (Number(value) & ~(7 | 0xf0000)) === 0),
    ...AUDIO_FIELDS,
  },
  columns: ["position", "velocity"],
  columnFlags: 0,
  normalize(fields) {
    normalizeEmitter(fields);
    normalizeAudio(fields);
  },
  run: layerImage,
},
```
- **新增**（`emitters.ts`）：`export function layerImage(): void {}`，注释写明：步骤 3 实现；步骤 1 起系统不调它，`system.ts` 的发射循环对 `layerimage` 不生粒子。

### 点 3 — 发射循环（`particles/system.ts`）

- **修改**：`layerimage` 照常算 `emissionCount`（计时、欠账、周期、`newPeriod` 照走），不生粒子。
```ts
for (const emitter of this.emitters) {
  const count = emissionCount(…);
  if (emitter.state.periodStarted) { … }
  // layerimage（P4j 步骤 1）：候选表是运行时读回的，步骤 3 之前一直当作「没有表」——要发的直接丢，不欠账（rea-p4j 3.1）
  if (emitter.name === "layerimage") continue;   // 新增（名字从模块定义取，按 ResolvedEmitter 的实际字段写）
  for (let n = 0; n < count; n++) this.spawn(emitter);
}
```

### 点 4 — 绑定进 bundle（`compile/particles.ts`、`compile/bundle.ts`）

- **新增** `SceneParticle.emitterImages`（`particles.ts`）：
```ts
/**
 * `layerimage` 发射器的依赖（P4j 步骤 1，rea-p4j-layerimage.md 1.5、1.6）：每个 `layerimage` 发射器一项，按它们在 `emitters` 里的
 * 先后；没配上依赖为 null（运行时永远不发）。`maskTexture` 是 `mask` 纹理在 `bundle.textures` 的下标（`mask` 为空串时 null）。
 * 运行时（步骤 2）按 `(id, mask)` 合并成一张共享的表。`parseParticle` 给空数组，`compileParticleSystem` 填。
 */
emitterImages: ({ id: number; mask: string; maskTexture: number | null } | null)[];
```
- **修改** `compileParticleSystem`（`bundle.ts`）：
  - 解析之后调 `bindLayerImages(particle.emitters, particleDependencies(object))`；
  - `mask` 非空时用 `getTexture(mask, …)` 取下标；读不到照 `getTexture` 报 `texture:missing:…`，下标记 null；
  - 顶层与子系统都按自己的发射器数，子系统从 0 数（1.5）。
- **新增**（`bundle.ts`，全部图层编完之后）：对所有系统（含子系统）`emitterImages` 里的 `id`，找 `id` 相同的对象。
  - 对应的图层是 puppet（`layer.puppet` 非空），报 `particle:layerimage:puppet`；
  - 是文本层，报 `particle:layerimage:text`；
  - 其它情况中性。

### 点 5 — 能力表（`compile/features.ts`）

- **删除**：
  - `particle:dependencies` 那一行和 `hasNonNumericDependency` 的导入；
  - 头注释（约 292 行）改成「对象元素是发射图 / 碰撞模型依赖，进并集并绑到 `layerimage`（P4j）」。
- **新增**（`checkParticleFeatures` 的模块循环里）：`module === "emitter:layerimage"` 时报过渡键 `particle:layerimage:pending`，注释写「P4j 步骤 3 删」。

### 测试（新文件 `compile/p4j1.test.ts`，另改旧用例）

- **`particleDependencies`**：
  - 三道门：负 id、小数 id、缺 `index`、`index` 2³²、`type` 非字符串，都跳过；
  - `type` 大小写敏感（`"EmitterImage"` 跳过）；
  - `collisionmodel` 映射成 3；`mask` 非字符串得空串；`id 0` 得 `valid false`；
  - 非对象元素跳过；`dependencies` 是对象（非数组）时按值遍历。
- **`dependencyIds`**：粒子对象的对象元素进并集（两种类型、`id 0` 都算）；非粒子对象的对象元素不进；数字元素照旧。
- **`bindLayerImages`**：
  - 两个 `layerimage` 中间夹一个 `sphererandom`，分别配 `index 0` / `1`；
  - 同一 index 有两条，取后一条；
  - `id 0` 不配、`collisionmodel` 不配，没配上为 null。
- **模块表 / 能力表**：
  - 缺省：正交 `offsetmin -5 -5 0`、透视 `0 0 0`；`flags` 0x10000；
  - 写 `flags 0x90006` 不报字段问题，写 `flags 0x100000` 报 `particle:emitter:layerimage:flags`；
  - 只报 `particle:layerimage:pending`；粒子对象的对象依赖不再报 `particle:dependencies`。
- **系统步进**：`layerimage` 系统 `rate 10` 步进 1 s，一颗不生；`emitter.state` 的累积与没有 `continue` 时相同。
- **bundle**（照 `p8.test.ts` 的写法编一个小场景）：
  - 被引用的图层 `dependedOn`；
  - 顶层与 `static` 子系统各自的 `emitterImages`，子系统从 0 数；
  - `mask` 纹理进 `bundle.textures`；
  - 引用 puppet、文本层各报一个键。
- **旧用例**：
  - `p8.test.ts` 的「particle:dependencies」那条改成「不再报」；
  - 别处期望 `particle:emitter:layerimage`、或拿 `layerimage` 当表外模块例子的，换成别的名字。

### 验收

- `apps/wpe-scene` 的 tsc；vitest 只跑相关文件（`compile/p4j1.test.ts`、`compile/p8.test.ts`、`compile/features*.test.ts`、`particles/` 里碰到的）；Prettier。
- 语料：
  - 缺省 233 张 `kbp corpus scan` 与 HEAD 比 0 变化；
  - myprojects 的 `3834803915` 只剩 `particle:layerimage:pending`。
- 变异（工作区模式），下面每处都要被测试检出：
  - 并集不收粒子依赖；
  - 绑定不取最后一条；
  - `layerimage` 照常生粒子；
  - `flags` 缺省写成 0；
  - 子系统不从 0 数。

### 步骤 1 实施记录（2026-11-21）

执行代理（sonnet）在工作区里实现，Claude 独立验收。

**和设计的出入：**
- puppet / 文本层的照报在 `finalize` 里做，按 id 对所有同 id 对象都报，不套「重复 id 后者胜出」。多报是保守的，正常场景 id 不重复。
- 运行中建的对象（`compileFragment`）不查这两项。
- `dependencies.ts` 改从 `features.ts` 取 `objectKind`；`features.ts` 不再导入 `dependencies.ts`，没有环。
- `particle:dependency:collisionmodel` 没加：用到它的 operator 本来就报 `particle:operator:collisionmodel`，依赖本身只进并集，中性。

**验收：**
- **测试**：`compile/p4j1.test.ts` 19 个用例；改了 `p8.test.ts`（不再报 `particle:dependencies`、并集收粒子依赖）与 `particles.test.ts`（表外模块的例子换名）。相关 6 个文件 342 过、5 跳过；tsc 0 error；Prettier 通过。
- **变异**（`ignore/p4/j1/mutate_j1.py`，工作区模式）：9 处全部检出、按原字节还原，工作区逐字节一致。
  - 并集不收粒子依赖；
  - 同槽取第一条；
  - `id 0` 能绑；
  - `type` 不分大小写；
  - `layerimage` 照常生粒子；
  - `flags` 缺省 0；
  - 子系统接着父系统的序号；
  - 不报过渡键；
  - 不报 puppet。
- **语料**（改动前后的工作区各扫一遍，`ignore/p4/j1/`；myprojects 分 8 段，`scan_my.py`）：
  - 缺省 233 张 0 变化。
  - myprojects 659 张里，`3834803915` 从 `particle:dependencies` + `particle:emitter:layerimage` 变成只剩 `particle:layerimage:pending`。
  - 另一张 `3816948983` 去掉了 `tex:format:12`，是别的会话在两次扫描之间做进工作区的纹理格式 12，和本步无关。
- **文档**：
  - `cocs/wpe/WPE_SCENE.md`「图层依赖」：被依赖一行补粒子的那套，照报一行去掉 `particle:dependencies`；
  - changelog 一行；
  - 回归「场景壁纸 P4j」J0–J3。

**用户 2026-11-21：** 步骤 1 可以提交（`82e63fa0`），开始步骤 2。

## 步骤 2 — 运行时的候选表

### 总体设计思路

WPE 的候选表要走「过门 → 渲染拷贝 → 读回建表」三步（rea 2.1）。三步都在**发射调用里**同步推进：第 2 步在更新阶段把被依赖图层合成 RT 里**上一帧末的画面**降采样、拷进 staging；第 3 步同步 `Map` 读回。我们的模拟在 CPU 上同步跑，WebGPU 读回只能异步，所以把「GPU 画面」和「状态机」拆开。

**快照（GPU，`render/emitterImages.ts`）。** 每帧编码的末尾，对需要快照的记录做三件事：
- 用 WPE 原件 `downsample_quarter`（`WRITEALPHA = 1`，有 `mask` 再加 `OPACITYMASK = 1`）把被依赖图层的独占 RT 画到 `w4 × h4` 的 RGBA8；
- `copyTextureToBuffer` 进一块可读的缓冲；
- 提交之后 `mapAsync`，读完把紧凑的像素存成这条记录的「最新快照」。

这正是「本帧末的合成 RT」，也就是下一帧更新阶段 WPE 降采样时读到的内容。需要快照的记录：
- 状态还没到 2 的；
- 带 `0x20000` 的；
- 合成 RT 尺寸变了的。

**状态机（纯 TS，`particles/layerImage.ts`）。** 照 2.1 逐条：门、状态 0 / 1 / 2、同一帧不连做、共享记录、尺寸变了回 0、`0x20000` 的重建。
- 状态 0 那次调用不再「当场渲染」，改为**锁定快照**：
  - 上一帧末有快照就锁它；
  - 没有就锁「本帧末的那份」。这种情况只出在加载后的第一帧：预热在加载时就过了门，WPE 的第一帧更新读的是加载那一帧画出的内容，我们没有那一帧。
- 状态 1 的调用：锁定的快照已读回就在 CPU 上建表（列优先、alpha ≥ 127、坐标照 2.3 的 float32 截断），进状态 2；
  - 还没读回就留在状态 1、返回假，下一个发射帧再试。
  - WPE 这里是阻塞等 GPU。产品里表晚到就晚几帧开始发射，记为已知差异。

**确定性。** dev 探针的逐帧回放在每帧提交之后等读回完成（`replayEncoded` 改成异步），保证同一帧里「0 → 1 → 2」（共享记录、后调用的接着推进，`p4j-li-xform` 实测）和 WPE 一样当帧成立；产品靠帧间隔，`mapAsync` 通常一帧之内就回来。

步骤 2 里系统仍不生粒子：发射循环只在要发的帧（`n > 0`）调一次取表，推进状态机与 `0x20000` 计时；出生点是步骤 3。验收靠 dev 探针读出每条记录的表，和 `ignore/p4/j0/model.py` 的预测逐项比（`p4j-li-map`、`p4j-li-large`）；状态机的时序用单测按 WPE 实测的计数核对（无预热丢 2 个发射帧、有预热丢 1 个、共享记录后调用的早一帧）。

### 现状锚点

**a. 发射循环**（`particles/system.ts`，步骤 1）
```ts
for (const emitter of this.emitters) {
  const count = emissionCount(…);
  if (emitter.state.periodStarted) { … }
  if (emitter.name === "layerimage") continue;   // 现状：一直当作没有表
  for (let n = 0; n < count; n++) this.spawn(emitter);
}
```

**b. 绑定**（`compile/particles.ts`，步骤 1）
```ts
emitterImages: ({ id: number; mask: string; maskTexture: number | null } | null)[];   // 现状：编译期定，运行时没人读
```

**c. 帧号与步进**（`render/scene.ts`）
```ts
stepParticles(frametime, time, state?, cursor?) {
  this.sheetFrameNo++;            // 现状：WPE ctx+0x144，每帧开头加 1；预热在建树时，帧号为 0
  if (!(frametime > 0)) return;
  … root.step(frametime, time, tree.inputs) …
}
private readonly layerTargets = new Map<number, RenderTarget>();   // 现状：被依赖图层的独占 RT，按 objects 下标
```

**d. 泛光的原件材质**（`compile/bloom.ts`）：`materials/util/*.json` 经 `parseMaterial` + 翻译器编成 `ScenePass`，放在 `bundle.bloom.passes`，渲染器在 `render/bloom.ts` 里画。

**e. 探针的逐帧回放**（`dev/particleCorners.ts`）：`replayReadback` / `replayEncoded` 是同步循环，前 n − 1 帧每帧 `encodeFrame(i)`（编码并提交），帧之间不让出事件循环。

### 2a — 状态机、绑定到系统、降采样材质（纯 TS 与编译期）

**点 1 — 候选表的状态机（新文件 `particles/layerImage.ts`）**

- **新增**
```ts
/** 候选表（rea 2.3）：列优先，每项一个像素。x / y 是 int16（合成 RT 像素，原点在中心，y 向下），rgb 是降采样后的 8 位值。 */
export interface EmitterImageTable {
  count: number;
  x: Int16Array;
  y: Int16Array;
  rgb: Uint8Array;        // 3 × count
}

/** 一次快照：降采样后紧凑的 RGBA8（w4 × h4，行优先）与源合成 RT 的尺寸。 */
export interface EmitterImageSnapshot {
  pixels: Uint8Array;
  w4: number;
  h4: number;
  /** 合成 RT 的宽高（u16），`s` 与坐标偏移用。 */
  width: number;
  height: number;
}

/** 按 2.2 / 2.3 建表：s = f32(W) / f32(w4)，hs = s·0.5，x 外层 y 内层，alpha < 127 跳过，坐标 cvttss2si 的截断。 */
export function buildEmitterImageTable(snapshot: EmitterImageSnapshot): EmitterImageTable;

/** 2.2 的尺寸：大于 3840×2160 先按宽高比压，w4 = max(2, W'/4)，h4 = max(2, H'/4)（有符号整除）。 */
export function emitterImageSize(width: number, height: number): { w4: number; h4: number };

/**
 * 一条记录（rea 1.6）：按 (图层 id, mask) 共享。状态机照 2.1：
 * - 图层不存在、不是图像层、没有独占 RT：返回 null，不过门；
 * - 门：started 为假或 startFrame === frame 时记 started、startFrame = frame，返回 null；
 * - 状态 0：锁定快照（上一帧末有就锁它，否则锁本帧末的那份），进状态 1；返回旧表（没有为 null）；
 * - 状态 1：锁定的快照已到就建表、记下 W / H，进状态 2、返回表；没到就返回旧表（同 WPE 重建期间照用旧表；第一次时为 null）；
 * - 状态 2：当前合成 RT 尺寸和建表时不同就回状态 0；返回表（表为空时返回 null，同 WPE「表非空才发」）。
 */
export class EmitterImageRecord { … }

/** 场景里全部记录与快照的来源（渲染器实现 GPU 那半，单测用假的）。 */
export interface EmitterImageSource {
  /** 第 frame 帧、某个发射器取表（`n > 0` 的帧才调）；返回可用的表或 null。 */
  acquire(binding: { id: number; mask: string }, frame: number): EmitterImageTable | null;
  /** `0x20000` 计时过 1 时调（2.5）：记录状态不是 1 就置 0。 */
  refresh(binding: { id: number; mask: string }): void;
}
```
- 头注释写明 2.1–2.5 的对应、「锁定快照」代替「当场渲染」的理由，以及产品里表晚到的已知差异。

**点 2 — 发射循环接上取表（`particles/system.ts`、`emitters.ts`）**

- **新增**：`ParticleSystem` 的构造选项 `emitterImages?: EmitterImageSource`，子系统与事件实例沿用父的（同 `audio` 经 `link` 传下去）。每个 `layerimage` 发射器在建系统时按序号取到自己的绑定（`def.emitterImages[k]`）。
- **修改**：发射循环在 `count > 0` 时：
  - `0x20000`：`timer = f32(dt' + timer)`；`timer > 1` 时 `timer = timer % 1`（`fmodf`），再 `refresh(binding)`；
  - `acquire(binding, frame)`（帧号由渲染器经 `setEmitterImageFrame` 或步进参数给，预热时为 0）；
  - 照旧 `continue`，不生粒子（步骤 3 才生）；`count === 0` 的帧什么都不做（2.5、3.1：非发射帧不动状态）。
- 计时器放进发射器状态（`EmitterState` 加一个可选字段，或 `layerimage` 专用的状态），复位规则同 WPE（解析时 0）。

**点 3 — 降采样材质（`compile/emitterImages.ts`，新）**

- 照 `compile/bloom.ts`：场景里有任何绑上的 `layerimage` 时，编 `materials/util/downsample_quarter.json` 的两个变体：
  - `WRITEALPHA = 1`；
  - 有任何 `mask` 时，另编 `WRITEALPHA = 1` + `OPACITYMASK = 1`。
  - 进 `bundle.emitterImagePasses: { plain?: ScenePass; masked?: ScenePass }`，缺材质照报 `material:missing:…`。
- 引擎 uniform `g_Texture0Texel` 由渲染器按合成 RT 尺寸写；不读 `g_RenderVar0`。读码 2.2 写了槽 0 合成 RT、槽 1 `mask`。

**2a 的测试（`particles/layerImage.test.ts`、`compile/p4j2.test.ts`）**
- `emitterImageSize`：
  - 96×64 → 24×16；4025×2460 → 883×540；
  - 3840×2160 不压；5000×1000 → 3840×768 → 960×192；1×1 → 2×2。
- `buildEmitterImageTable`：
  - 手写 4×4 快照，核对列优先、alpha 126 / 127、坐标的截断与 y 用 x 方向的 `s`；
  - 用 `ignore/p4/j0/model.py` 对 `map_mask()` 的预测作夹具，逐项相同（夹具 JSON 进 `particles/fixtures/`）。
- 状态机（假快照源）：
  - 无预热：第 1 个发射帧过门、第 2 个锁定、第 3 个出表，前两帧返回 null；
  - 有预热（帧号 0 过门）：第 1 帧锁定「本帧末」、第 2 帧出表；
  - 两个发射器共享记录：同一帧里后调的接着推进，早一帧出表；
  - 快照没到：留在状态 1、下一帧再试；
  - 尺寸变了回状态 0、期间返回旧表；`refresh` 在状态 1 时不动；
  - 空表返回 null；图层不存在不过门。
- 系统：`layerimage` 系统 `count > 0` 的帧才调 `acquire`，`0x20000` 的计时（`fmodf`、严格大于 1）。
- 编译：有绑定时 bundle 带两个 pass（有 `mask` 时），没有时不带。

### 2b — GPU 快照与读回、探针

**点 4 — GPU 快照（`render/emitterImages.ts`，新；`render/scene.ts` 接线）**

- **新增** `GpuEmitterImages implements EmitterImageSource`：
  - 建场景时按全部系统（含子系统）的 `emitterImages` 建记录（按 `(id, mask)` 去重），找到 `id` 对应的图像层（`layer.object`）；
  - `encode(encoder)`：在 `GpuScene.encode` 的最末尾（全部图层画完之后），对需要快照的记录：
    - 用 `bundle.emitterImagePasses` 把 `layerTargets.get(object)` 的颜色纹理画到 `w4 × h4` 的 `rgba8unorm`（采样器照这个图层的 `compositeSampling`；槽 1 绑 `mask` 纹理）；
    - `copyTextureToBuffer` 进 `MAP_READ` 缓冲（`bytesPerRow` 按 256 对齐，读的时候去掉行尾填充）；
  - `afterSubmit()`：对本帧拷过的缓冲 `mapAsync`，完成后转成紧凑像素交给记录，作为「最新快照」；
  - `settled(): Promise<void>`：等全部在途的读回（探针用）。
- **修改** `GpuScene`：
  - 构造时建 `GpuEmitterImages`，交给建树（预热之前）；
  - `stepParticles` 把帧号交给它；
  - `encode` 末尾调它的 `encode`；
  - 新增 `afterSubmit()` 转调。
- **修改** 渲染器（`render/renderer.ts`）与探针的每个 `queue.submit` 之后调 `scene.afterSubmit()`。
- 缓冲与目标按记录复用，尺寸变了重建；释放场景时销毁。

**点 5 — 探针（`dev/particleCorners.ts`、`dev/probe.ts`）**

- **修改** `replayEncoded` / `replayReadback` 改成 `async`：`encodeFrame` 可以返回 Promise，每帧 `await`。
- 探针的 `encodeFrame`：提交 → `scene.afterSubmit()` → `await scene.emitterImagesSettled()`。
- 调用点（`probe.ts`、`particleCorners.ts` 内部）与三个测试文件（`replayAnimations.test.ts`、`replayEncoded.test.ts`，以及别处的调用）跟着改 `await`。
- **新增** 宿主探针 `host.emitterImages()`：每条记录的 `id`、`mask`、状态、`W` / `H`、`w4` / `h4`、表项数，以及按 `includeEntries` 给出全部表项 `[x, y, r, g, b]`，供和 `model.py` 比。

**2b 的验收**
- 单测：`replayEncoded` 异步化后原有用例照过；`GpuEmitterImages` 的去重、需要快照的判定、行尾填充去除（假设备或纯函数部分）。
- dev 实测（Claude）：`p4j-li-map`、`p4j-li-large` 导入 dev（`projects_import`），屏外宿主回放若干帧（强制渲染），`host.emitterImages()` 的表和 `model.py` 的预测逐项相同；表出现的帧号和单测的时序一致。
- tsc、相关 vitest、Prettier；变异：
  - 不锁定快照（状态 0 直接用最新的）；
  - 行优先建表；
  - 阈值 128；
  - `s` 按 y 方向；
  - 不去行尾填充；
  - 回放不等读回。
- 语料扫描不变（步骤 2 不改能力表）。

### 2a 实施记录（2026-11-21）

执行代理（sonnet）实现，Claude 验收时改了一处。

- **更正：`0x20000` 计时器的位置。**
  - 代理把计时器放在共享的依赖记录上；反编译里是 `pcVar10 + 0x7c`，`pcVar10` 是**发射器记录**（同记录 `+0x78` 是槽号）。所以计时器每个发射器各一个，共享的只是被它重置的那张表。
  - 放在共享记录上的话，两个发射器共用一条依赖时会累加成两倍速。
  - 改成发射器上的 `imageTimer`：严格大于 1 时取 `fmodf`、调共享记录的 `refresh`。接口里的 `tick` 换成 `refresh`。
  - 补了「两个发射器共享一条记录，各自计时」的用例。
- **其余照计划做的：**
  - `particles/layerImage.ts`：状态机；`ScriptedEmitterImageView` 给单测与 Node 回放用。
  - `ParticleSystem.setEmitterImages` / `setEmitterImageFrame`：只在根上起作用，子系统沿 `parent` 找根。
  - `compile/emitterImages.ts` 与 `SceneBundle.emitterImagePasses`。
  - 运行中新建的、场景里第一个用发射图的粒子对象报 `particle:layerimage:runtime`：片段没有场景级增量通道，同 `bloom`；代码里标了 `TODO:[WPE_SCENE]`。
  - `p4f4.test.ts` 的粒子键清单补 `emitterImages`：步骤 1 漏了这个断言，那时没跑这个文件。
- **测试：**
  - `layerImage.test.ts` 22 例、`p4j2.test.ts` 7 例，`src/particles` 全目录与相关编译测试全过，tsc 0 error，Prettier 通过。
  - `compile/materialValues.test.ts`（7 个）与 `compile/pipeline.test.ts`（1 个）失败，但在 HEAD（`82e63fa0`）和它的前一个提交（`82176594`，不含 P4j）的快照上同样失败。是别的会话的 P11e / BC7 提交带来的，和 P4j 无关。

### 2b 实施记录（2026-11-21）

执行代理（sonnet）实现，Claude 独立验收。

**实现**
- `render/emitterImages.ts`：`GpuEmitterImages`。
  - 每条记录一个降采样目标与 bind group；uniform 用泛光链同一套内置量，`g_Texture0Texel` 按合成 RT 尺寸算。
  - 读回缓冲按大小池化，`unmap` 之后才还池。
  - 纯逻辑拆成可单测的函数：`compactRows`、`needsSnapshot`、`SnapshotLedger`。
- `GpuScene`：建树后、预热之前把来源交给根；`stepParticles` 写帧号；`encode` 最末尾拍快照；新增 `afterSubmit` / `emitterImagesSettled` / `emitterImageRecords`。
- 渲染器与探针的每次提交之后都调 `afterSubmit`；`replayEncoded` / `replayReadback` 改成异步，探针每帧等读回。
- 宿主探针 `host.emitterImages()`。

**和计划的出入**
- **只拍过门之后的记录**：从没过门的不读回。门在更新阶段、早于本帧编码，所以第一个发射帧末就开始拍，下一个发射帧的状态 0 正好锁到它。
- **找图层用 `SceneLayer.id`**：就是 JSON id，同独占 RT 的命名。
- **`mask` 纹理读不到时退回不带遮罩的变体。**
- **预热时 `layerTargets` 已经有独占 RT**：`populate` 先放独占 RT 再建树，没有改顺序。
- **mask 纹理要上传**：没有图层材质引用它，代理在 `uploadableTextures` 里补了。

**验收**
- **测试**：相关 54 个文件 1281 过，tsc 0 error。
  - 新增：`render/emitterImages.test.ts` 16 例；`layerImage.test.ts` 补了「取了 `fmodf` 之后不再重建」一帧，原来的用例走的帧数不够，计时不取余的变异漏检。
  - Prettier：改动的文件都通过。`scene.ts` 有一行没格式化，那行在 HEAD 里就有、不在本步的块里，没动。
- **变异**（`ignore/p4/j2/mutate_j2.py`）：7 处全部检出。「回放不等读回」只有 GPU 实测能检出，没列进去。
- **dev 实测**（图库预览，强制渲染，产品路径的异步读回）：
  - `p4j-li-map`：36 项和 `model.py` 的预测逐项相同。
  - `p4j-li-large`：8381 项的位置与顺序逐项相同（坐标的 SHA-256 一致）。颜色只有边缘两档不同：我们是 127 / 64，模型是 128。0.5 × 255 = 127.5 在舍入分界上，模型的 numpy 取了 128；WPE 抓帧里这两档的粒子颜色是 127，和我们一致。
  - 探针按 WPE 时间线回放 `p4j-li-map` 201 帧（每帧等读回）正常走完。
- **语料**：缺省 233 张 0 变化。
- **别的会话带来的已有失败**，和 P4j 无关：
  - `compile/materialValues.test.ts` 7 个、`compile/pipeline.test.ts` 1 个：HEAD（`82e63fa0`）与不含 P4j 的 `82176594` 的快照上同样失败；
  - `render/render.test.ts` 1 个（BC3 行跨度）、`render/p3a.test.ts` 2 个（泛光脏项）：HEAD 快照上同样失败（只在 HEAD 上跑过；P4j 步骤 1 没碰 `render/`）。

**用户 2026-11-21：** 步骤 2 可以提交（`d63088b3`）。

## 步骤 3 — 发射

### 总体设计思路

有了表，`layerimage` 每颗粒子照 rea 第 3 节逐行生，抽取顺序同 3.10：表项下标 → 抖动 x / y / z（`0x80000`）→ 速率（`0x40000`）→ 照常的 `R` 与各 initializer。随机数全部来自系统的同一个随机源：
- 下标用 MSVC `uniform_int_distribution` 的 Lemire 乘法加拒绝，每次取一个原始 u32（`FUN_14007d8f0`）；
- 抖动和速率用 `uA`（`[0, 1)`，即 `random.a()`）；
- 两者推进的是同一串（WPE 也是同一个 MT19937）。

所以 `ParticleRandom` 要多一个取原始 u32 的入口，`SeededRandom` 从同一个来源取。

**出生点**：`P = A·p`，`p = (x′ + jx, −y′ + jy, jz)`。`A` 本地系统是 `M⁻¹·L`、世界系统是 `L`，按 3.5 的 float32 乘加顺序算。
- `L` 是被依赖图层**本帧**的绘制矩阵：世界矩阵含父链、`angles`、`scale`，再右乘 `alignment` 偏移。由取表的来源一起给出（`acquire` 返回 `{ table, matrix }`）。
- 记录的 `L` 只在状态 2 与建表时刷新（2.1），重建期间照用旧的。
- 渲染器按 `state.layers` 现算 `L`；回放由调用方给。

**颜色**（`0x10000`）：这颗粒子的实例颜色先乘 `像素 / 255`（float32），再进 initializer。
**速度**（`0x40000`）：
- 用上一次取到表时的 `L`（`rec[0xb8]`，每个发射器一份，解析时单位阵，取到表的发射帧末尾写回）算出生点在这一帧里的移动，除以不含实例 `rate` 的帧时间，再乘 `uA·(max − min) + min`。
- 第一次取到表那帧 `rec[0xb8]` 还是单位阵，速度会异常大：这是 WPE 的原样，照做。

**`M3`**：传给 initializer 的 3×3，本地系统单位阵、世界系统 `mat3(M)`。

步骤 1 的过渡键 `particle:layerimage:pending` 删掉，雨景从此能渲染。验收靠回放逐粒子比：
- 用步骤 0 注入种子抓的 WPE 帧（`A:\p4j\`），`kbp replay` 的钩子把系统随机源换成同一种子的 `std::mt19937`；
- 一个工程里几个系统共用**一个**随机源，按 WPE 的更新顺序抽；
- 候选表来自 `ignore/p4/j0/snap/`。那是参考模型的快照，已和 dev 的 GPU 读回逐项相同：`li-large` 整表 SHA-256 一致。

### 现状锚点

**a. 发射循环**（`particles/system.ts`，步骤 2）
```ts
if (emitter.name === "layerimage") {
  if (count > 0 && emitter.image) {
    … 0x20000 计时 …
    source.acquire(emitter.image, root.emitterImageFrame);   // 现状：只推进状态机，结果丢掉
  }
  continue;                                                   // 现状：一颗不生
}
```

**b. 出生**（`particles/system.ts` 的 `spawn`）：`emitter.run(fields, context)` 写位置与速度 → 抽 `R` → 缺省值 → `c.color0 = this.instanceColor` → initializer（JSON 顺序）。

**c. 随机源**（`particles/random.ts`）：`ParticleRandom` 只有 `a()` / `b()`（和可选的 `hueRand`），`SeededRandom` 的 32 位来源是私有的。

**d. 取表**（`particles/layerImage.ts`）：`acquire` 返回 `EmitterImageTable | null`，记录不存 `L`；`EmitterImageView` 只有 `layerSize` / `lock`。

### 点 1 — 原始 u32 与 Lemire 下标（`particles/random.ts`）

- **新增**：
  - `ParticleRandom.u32?(): number`：从 `a()` / `b()` 的同一个来源取一个原始 u32；没实现的（单测手写的）退到 `Math.floor(a() * 2³²)` 并注释。
  - `SeededRandom` 实现它。
  - `uniformIndex(random, n)`：照 rea 3.3。
    - `m = u32 · n`（64 位，乘法拆成 16 位两半或 BigInt，保证高低 32 位精确）；
    - `(m mod 2³²) < n` 时 `t = (2³² − n) mod n`，`while ((m mod 2³²) < t)` 重抽；
    - 返回 `⌊m / 2³²⌋`。

### 点 2 — 记录给出 `L`（`particles/layerImage.ts`、`render/emitterImages.ts`）

- **修改**：
  - `EmitterImageView` 加 `layerMatrix(id): Mat4 | null`；
  - 记录在状态 2 与建表时刷新 `matrix`（2.1）；
  - `acquire` 返回 `{ table, matrix } | null`。
- `GpuEmitterImages.layerMatrix`：按当前 `state.layers` 现算图层的绘制矩阵，同图层画自己用的 `drawMatrixOf`（世界矩阵 × 自身偏移）。`GpuScene.stepParticles` 每帧把 `state` 交给它。
- `ScriptedEmitterImageView` 加 `layerMatrix(id, frame)` 回调。

### 点 3 — 出生点、颜色、速度（`particles/emitters.ts` 的 `layerImage`、`particles/system.ts`）

- **修改** 发射循环：取到表时把 `{ table, matrix }` 交给这个发射器的这一帧，照常 `spawn` `count` 次；全部生完后 `emitter.prevLayer = matrix`（`rec[0xb8]`，初值单位阵）。没取到表时照旧丢掉。
- **新增** `layerImage(fields, context)`，照 3.2–3.7 逐行：
  - `A`：世界系统 `L`，本地系统 `inverse(M)·L`（`M` 是本系统的 `inputs.world`，`inverse` 照 GLM 的 4×4 求逆，float32）；`Ap` 世界单位阵、本地 `inverse(M)`；`Bprev = Ap·prevLayer`。
  - 下标 `uniformIndex(random, count)`，`ix = x[i]`、`iy = −y[i]`。
  - `0x80000` 时 `jx/jy/jz = f32(f32(uA·range) + min)`，按 x、y、z 顺序各抽一个 `a()`。
  - 位置按 3.5 的括号顺序写进位置列。
  - 颜色（`0x10000`）：在 context 上记一个 `colorScale = [r/255, g/255, b/255]`（float32），`spawn` 写 `color0` 时乘上去，写完清掉。
  - 速度：没有 `0x40000` 写 0；有时按 3.7：`prev = Bprev·(p, 1)`，`d = frameDt`，`k = f32(uA·(speedmax − speedmin) + speedmin)`（`fields` 的 speed 已乘过 `instanceoverride.speed`），`v = k·(P − prev)/d`。
  - `context.basis`：世界系统 `mat3(M)`、本地单位阵（3.2，传给 initializer）。
- `sphererandom` / `boxrandom` 不受影响。

### 点 4 — 能力表与文档（`compile/features.ts`）

- **删除** 过渡键 `particle:layerimage:pending` 和 `p4j1.test.ts` 里期望它的用例（改成「`layerimage` 不报任何键」）。

### 点 5 — 回放（`.claude/skills/kbp-tools/ts/replayLib.ts`、`ignore/p4/cases/`）

- **修改** `replayLib`：
  - `SimOptions` 加 `emitterImages?: (layer) => EmitterImageSource | undefined`，建系统后、预热之前 `setEmitterImages`；
  - 每步之前 `setEmitterImageFrame(帧号)`：预热 0，第 i 帧 i，同渲染器的 `sheetFrameNo`；
  - 加 `sharedRandom?: () => RandomLike`：全部系统共用一个随机源，按回放的系统顺序抽。
  - 写进 kbp-tools SKILL.md。
- **新增** 钩子 `ignore/p4/cases/j3.hook.ts`（复用 `j0rng.hook.ts` 的 `mt19937`）：
  - 共用的 `SeededRandom(mt19937(种子))`；
  - `ScriptedEmitterImageView`：`layerSize` 与快照取 `ignore/p4/j0/snap/<名字>.json/.rgba`，帧 ≥ 1 都返回同一份，内容是静态的；
  - `layerMatrix` 照图层的 `origin` / `angles` / `scale` 算，`p4j-li-move` 按脚本 `MOVE_ORIGIN` 用上一帧的 `engine.runtime` 算 origin，写法同 `d5.hook.ts`。
- **新增** 案例 `ignore/p4/cases/j3.json`：`p4j-li-map`、`p4j-li-jit`、`p4j-li-flags0`、`p4j-li-xform`、`p4j-li-large`、`p4j-li-move`，各用步骤 0 的抓帧（种子 1001–1006、`passes: 2`）。
  - 案例里 `envelope.approx` 照近似倒数的惯例。
  - `p4j-li-move` 的速度、`liw` / `li` 的共享记录一帧差，都在逐粒子比里体现。

### 测试与验收

- **单测**（`particles/layerImage.test.ts` 或新文件）：
  - `uniformIndex`：拒绝分支，手造一个会被拒的 u32 序列；
  - 位置公式的括号顺序；
  - 颜色只在 `0x10000` 时乘；
  - 速度用上一帧的 `L`，第一次是单位阵；
  - 抽取顺序与个数：每颗 下标 1、抖动 3、速率 1，再 `R`；
  - 世界 / 本地系统的 `basis`。
- **回放**：`kbp replay j3` 逐粒子对上 WPE，位置差在近似倒数的包络内，颜色、尺寸逐位相同。
- **变异**：
  - 下标不做拒绝；
  - 抖动顺序 y、x；
  - 本地不乘 `M⁻¹`；
  - 颜色不乘；
  - 速度用本帧 `L`；
  - `prevLayer` 不写回。
- **语料**：缺省不变；雨景 `3834803915` 变干净。

### 步骤 3 实施记录（2026-11-21）

执行代理（sonnet）实现，Claude 独立验收（自己跑回放、语料、变异）。

**和计划的出入：**
- `layerMatrix(id, frame)` 多了帧号参数：`p4j-li-move` 的钩子要按帧算脚本移动的 origin，GPU 实现忽略它。
- 回放选项 `emitterImages` / `sharedRandom` 是工厂：包络与 `fork` 的多轮模拟各要一份带状态的记录与随机源。
- `A·L`、`Ap·prev` 按 `multiply(左, 右)`（rea 3.2）。回放逐位相同，证明顺序对。
- 代理担心的「只在 `count > 0` 时取表」不是偏差：WPE 的 A1 段同样是「存活 < 容量」才算数量（rea-p4b A1），容量没满时 `count > 0` ⇔ `n > 0`。
- 没核对：`instanceoverride.speed` 时速度范围是「`max·s − min·s`」还是「`(max − min)·s`」，两者只差 float32 舍入，语料不涉及。

**参考模型的一处校准：** 降采样后正好 `.5` 的值，GPU 往下取（`li-large` 的边缘 127.5 → 127）。`model.py` 改成 `ceil(x·255 − 0.5)` 之后，和 dev 读出的 `li-large` 整表（8381 项，连颜色）SHA-256 一致。快照 `ignore/p4/j0/snap/` 由它生成；夹具 `p4j-map-table.json` 只变了一个被阈值排除的像素。

**验收：**
- **回放**：`kbp replay j3`，6 个工程 8 个系统、7778 颗（三帧合计）逐粒子对上，逐帧粒子数相同，位置、颜色、尺寸逐位相同。
  - 例外是 `li-move`：位置差 1.2e-4（限值的 0.12），来自脚本移动图层的 `sin`。
  - `liw` 比 `li` 早一帧拿到表（共享记录），同样照出。
- **测试**：相关 53 个文件 1162 过，tsc 0 error，Prettier 通过。
- **变异**（`ignore/p4/j3/mutate_j3.py`，检出方单测 + 回放案例）：6 处全部检出。
  - 「下标不做拒绝」只有单测能检出：表长几十到几千时拒绝概率约 1e-8，抓帧里没发生过。
- **语料**：缺省 233 张 0 变化；`3834803915` 0 项。

**遗留：** 执行代理误建了一个空文件 `D:\tmp_edit.py`，它删的时候被权限拒了，已告诉用户手动删。

**用户 2026-11-21：** 步骤 3 可以提交（`033a195d`），做步骤 4。

## 步骤 4 — 注入工具落地与雨景走查

### 总体设计思路

步骤 0 证明了 WPE 的随机数可以换成约定种子：Frida 在渲染器构造里换种子，我们用同一种子的 `std::mt19937`。当时是手工流程：
- WPE 侧：一个独立脚本，先挂钩再开窗；
- 我们侧：每个回放案例自己写钩子。

这一步把它做成工具，三处各自从「种子」这一个参数出发，下游都不用知道 Frida 或 MT19937 的细节：

- **WPE 侧**（`wpe-renderdoc` MCP）：`open_wallpaper`、`capture_wallpaper`、`capture_sweep` 的 job 加 `seed`。
  - 给了就在开窗**之前**挂上一次性的换种子钩子，命中后读回 `x[0]`、`x[1]` 核对，结果里报出（线程号、种子、核对结果）。
  - 没命中或核对失败照报、不静默。
  - Frida 驱动放在 `frida_input/` 那个已有的 uv 工程里。
- **回放侧**：
  - 产品源码的 dev 部分：`GpuScene` 与 `particleTrack` 收 `mt19937` 种子，**全场所有粒子系统共用一个** `SeededRandom(mt19937(种子))`。它们在预热（建树）与 `stepParticles` 里都按对象表顺序推进，和 WPE 一个场景一个引擎、按对象顺序更新相同。
  - `kabegame-dev` MCP 的 `render_scene` / `particle_track` / `particle_corners` 与 `renderFrames.ts` 把 `replay.mt19937` 转给探针。
  - kbp 回放的 run 加 `mt19937: 种子`，内置成共用随机源，步骤 0、3 的钩子里手写的那份可以去掉。

**雨景走查**用步骤 0 抓的 `3834803915-kbp-fps20-1920x1080-s1007`（解包副本、注入种子 1007、三帧），按 FINAL_CHECK 的做法：
- 探针按日志时间线、种子 1007、跑脚本，回放到抓帧那一帧；
- 整帧和 WPE 比，有差就定位到 draw 和数值。

场景里三个粒子系统共用一串：两层透视雨 197、215，与水花 188（`eventspawn` 子系统）。所以这一步也验证多系统共用随机源的顺序，以及事件子系统里的抽取。

### 现状锚点

**a. 回放的随机源**（`render/scene.ts` 建树处）
```ts
new SeededRandom((this.particleSeed + ordinal) >>> 0)   // 现状：每个粒子层一个种子 seed + i，互不相干
```
`particles/track.ts` 同样 `new SeededRandom(seed + systems.length)`。

**b. 钩子里的 MT19937**（`ignore/p4/cases/j0rng.hook.ts`）：`mt19937(seed)` 只在 kbp 钩子里。

**c. WPE 侧**：`ignore/p4/j0/rng/seed.py` 是手工脚本，命中即 `os._exit`（在 `unload` 里卡住过一次）。

### 4a — 回放侧

- **新增** `particles/random.ts` 的 `mt19937(seed): Uint32Source`：标准 `std::mt19937`，挪自钩子，自检值 `mt19937(5489)` 第一个是 3499211612、第 10000 个是 4123659995。
- **修改** `GpuScene` 构造选项：加 `particleMt19937?: number`。给了时全部粒子树共用一个 `SeededRandom(mt19937(种子))`，不给时照旧 `seed + i`。
- **修改** dev 探针：`renderFrame` / `particleTrack` / `particleCorners` 的回放选项加 `mt19937`，和 `seed` 互斥；结果里写一行用的随机源。
- **修改** `particles/track.ts`：同样共用一个源。
- **修改** `apps/kabegame-dev-mcp`：
  - `tools.ts` 的 `replay` schema 加 `mt19937`（0 … 2³² − 1 的整数）、写进说明；
  - `renderFrames.ts` 加 `--mt19937`；
  - `scripts/kabegame-dev` 的 REST 若有逐键白名单，照样放行。
- **修改** kbp：
  - `replayLib` 的 run 选项加 `mt19937`：等于 `sharedRandom: () => new SeededRandom(mt19937(种子))`；
  - SKILL.md 写进「注入 WPE 的随机数」一节，包括 WPE 侧怎么抓。
- **测试**：
  - `mt19937` 的自检值；
  - 共用随机源时两个系统按对象顺序交替抽（单测里用两个系统核对抽取序列）；
  - MCP 的 schema 测试（`mcp.test.ts` 一类）。

### 4b — WPE 侧（`.claude/mcps/wpe-renderdoc`）

- **新增**：
  - `frida_input/seed.py`：照 `ignore/p4/j0/rng/seed.py`，协议同 `frida_input/driver.py`（stdout 一行一个 JSON：`armed` / `hit` / `error`）；
  - `mcp_server/wpe/seed.py`：启动驱动、等 `armed`、交出句柄，开窗后等 `hit`（超时报错），结束进程。
- **修改**：
  - `open_wallpaper(seed=None)`、`capture_wallpaper(seed=None)`、`capture_sweep` 的 job `seed`。给了时，在开窗前、拿着开窗的锁的那段里挂钩，结果加 `seed: { value, tid, ok }`。
  - 别的会话同时开窗会被同一把锁挡在外面，否则会被误换种子；锁的范围照现有代码核对，写进说明。
  - README 与工具说明各补一段。
- **测试**：驱动协议的纯函数部分（种子解析、递推的 `x[1]`）；真机由 Claude 用 MCP 重连后验证。

### 4c — 雨景走查（Claude）

- `projects_import` 导入 `ignore/p4/proj/3834803915-kbp`。
- `render_scene`：
  - `replay.timeline` 取日志与轨迹；
  - `replay.mt19937: 1007`、`scripts: true`、`canvas: [1920, 1080]`。
- 同一帧用 `kbp rdc frame --present` 出 WPE 的图，`kbp cmp frame` 比，有差的块定位到 draw（`trace`）。
- 结果写进报告与回归；差异解释不了的，按 FINAL_CHECK 记下。

### 步骤 4 实施记录（2026-11-21）

4a、4b 各一个执行代理（sonnet）并行实现，Claude 独立验收；4c 由 Claude 做。

**4a 回放侧（和计划的出入）：**
- 选项名是 `ParticleOptions.mt19937`，不是计划写的 `GpuScene.particleMt19937`：现有的粒子选项都在 `ParticleOptions` 里。
- 合法性（0…2³²−1、和 `seed` 互斥）在探针的 `replayParticleOptions` 里查，`GpuScene` 构造器只保留「同给就抛错」。
- `particleCorners` 的返回是图层数组，放不下「用了哪个随机源」，这一行在 MCP 摘要里。
- kbp 的 `replayLib.ts` 另留一份 `mt19937`（带自检）：`kbp regress` 的旧源码快照没有产品那份导出。`j0rng.hook.ts`、`j3.hook.ts` 去掉手写的一份，`prepare` 返回 `{ mt19937 }`。
- REST 有逐键白名单（`scripts/kabegame-dev/replay.ts`），`mt19937` 加进了 `REPLAY_FIELDS` / `TRACK_FIELDS`。
- 验收时补的：`particles/track.ts` 不接 `layerimage` 的候选表（纯 TS、表要 GPU 读回），这类系统在 `particleTrack` 里一颗不生、不抽随机数，全场共用一串时排在它后面的系统会和 WPE 错开。标了 `TODO:[WPE_SCENE_MCP]`，kabegame-chromium SKILL 写明改用 `render_scene` 的 `trace` 逐颗比。kbp-tools SKILL 的「前提」更正两句（`hueRand` 的名字；多个粒子系统全部保留也对得上，不必先 `isolate`）。

**4b WPE 侧（和计划的出入）：**
- 原来的 `open_wallpaper` 只在「查重 + 登记」时握窗口表锁，发 `openWallpaper` 与等窗口时不握，挡不住别的会话同时开窗。给了 `seed` 时把「挂钩 → 发 `openWallpaper` → 窗口出现 → 命中」整段握在锁里（`ensure_running` 在拿锁之前做完，锁次序不变；锁同线程可重入）。
- 挡不住不走窗口表的开窗（用户在 WPE 里开的、旧脚本、桌面壁纸重建渲染器）：开窗前后比屏幕上的测试窗口，新冒出的别人的窗口写进 `seed.others_opened`，只报不判失败。
- 驱动挂钩前核对 `wallpaper64.exe+0x17D6BC` 的 6 个字节，不对就报错不挂；MCP 不采信驱动自报的 `seed_ok`，按 `x0` / `x1` 再算一遍；换种子失败时关掉自己开的窗口再报错，`capture_sweep` 里只让那个 job 报错。
- 验收时改了一处：`mcp_server/wpe/seed.py` 报错文字里的 `"\s"` 是非法转义（Python 3.12 的 SyntaxWarning），改成拼好的路径。
- **真机没测**：要用户重连 MCP 后才有 `seed` 参数（回归 J8）。

**4c 雨景走查（FINAL_CHECK）：** 解包副本 `ignore/p4/proj/3834803915-kbp` 导入 dev（图片 16250），`renderFrames.ts --mt19937 1007 --scripts --canvas 1920x1080` 按日志时间线回放到 252–254 帧，和 WPE 的 Present 比（`ignore/p4/j0/rain/`）；数据在 `ignore/p4/j4/`。
- **数量**：三帧逐系统相同。透视雨 1999 / 2002 / 2047 与 1038，水花 999 / 1000 / 1000，水花的事件实例 59 / 63 / 63。缺省种子（`seed + i`）时水花 978、实例 76。
- **整帧**：缺省种子时头部以外最大差 233、> 8 的像素 77090 个；换成 `mt19937 1007` 后三帧分别是最大差 10 / 7 / 28，> 8 的像素 18 / 0 / 18。剩下的差异逐个落到 draw 与数值：
  1. **头部一块**（(896, 32)–(1280, 448)，三帧都有）：对象 10「Warhammer 40k-M5」的 `rotate2dmask`，常量 `noisevalue` 读 `SharedNoise.angles.x`，SharedNoise（对象 0）的可见性脚本每隔几秒用 `Math.random()` 定头部转速。场景脚本的 `Math.random` 是 V8 自己的随机数，不在 MT19937 这一串里（探针按 `scripts.seed` 固定，WPE 每次不同），对不上是预期。
  2. **252 帧右边缘一条雨丝**（1911–1919, 809–833，差 ≤ 10，一正一负的条纹）：一颗离镜头很近的透视雨滴错开不到 1 像素。`trace` 逐颗配对两层透视雨（抓到的 683 颗都能唯一配上）：尺寸、alpha 逐位相同，位置差 ≤ 0.23、相对 |p| ≤ 4.3e-4，属近似倒数不复刻，透视把它放大。
  3. **254 帧一个水花环**（784–790, 150–153，差 ≤ 28，我们暗）：水花 (−345, 776)，WPE 的帧表 `w = 1.49996`（`sequencemultiplier 3`，t = w / 3 = 0.49999），正好卡在 `fadeintime` 0.5 的边上。`alphafade` 在 `fadein > fadeout` 且两段同时命中时取两个浮点数的按位或（照抄的 WPE 缺陷），WPE 的 `rcpps` 让 t < 0.5、进了按位或，alpha 0.9997；我们是精确倒数，t ≥ 0.5 只走淡出分支，系数约 0.505。
- **水花逐颗**（`trace` 抓到的 682 颗）：全部能在 WPE 里找到，位置、颜色（乘候选表像素）、旋转逐位相同；帧表 `w` 的相对差 ≤ 2.87e-4（`rcpps` 包络 3.7e-4 以内）；alpha 的大差只在按位或区间（0.01 < t < 0.5，298 颗，最大 0.077），区间外只在 t ≈ 0.999、alpha ≈ 0.001 的粒子上相对大，绝对 7.5e-5。
- 用时：一帧回放 252 帧约 7 s。

**验收：**
- **测试**：vitest `random.test.ts`、`render/particles.test.ts`、`layerImageEmit.test.ts`、`layerImage.test.ts` 118 过；deno `kabegame-dev-mcp` 的 `particles.test.ts`、`renderFrames.test.ts` 与 `scripts/kabegame-dev/replay.test.ts` 13 个 84 步全过；wpe-renderdoc `tests/test_seed.py` 6 例过；tsc 0 error。
- **回放**：`kbp replay j0rng`、`j3` 全部通过（钩子改成内置的 `mt19937` 之后）。
- **变异**（`ignore/p4/j4/mutate_j4.py`，工作区模式）：4 处全部检出、按原字节还原。twist 偏移、回火少一步（单测与回放都检出）；`GpuScene` / `particleTrack` 不共用一串（单测检出；j0rng / j3 走 kbp 自己的一份，检不出）。
- **语料**：步骤 4 不改编译期，`3834803915` 仍 0 项。
