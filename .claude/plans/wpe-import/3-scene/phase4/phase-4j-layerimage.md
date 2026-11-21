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
