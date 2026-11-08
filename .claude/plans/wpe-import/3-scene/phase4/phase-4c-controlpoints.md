# P4c — 控制点、世界空间与拖尾（子计划）

> 上级：[phase-4-particles.md](phase-4-particles.md)「P4c」。底座沿用 P4a、P4b（[phase-4a-base.md](phase-4a-base.md)、[phase-4b-tier2.md](phase-4b-tier2.md)），已有语义见 [p4-particles-REPORT.md](p4-particles-REPORT.md) 与 `rea-*.md`，本节新增的语义由步骤 0 写进 `rea-p4c-sim.md`、`rea-p4c-render.md` 和报告。
> 语料是 P4b 步骤 3 之后的重扫（152 个工程，`ignore/p4/b3/out/after.json`），能渲染 20 张。P4b 步骤 4–6 还在进行，下文的现状锚点取自已提交的代码（`36e6f29a`）。
> 分六步：步骤 0 只调研，步骤 1–5 每步能单独验收、单独提交。

## 总体设计思路

P4a、P4b 的粒子系统是封闭的：控制点 0 当单位阵、平移 0，粒子都在对象本地空间里，绘制时乘对象的世界矩阵。P4c 给系统接上外部输入。

**控制点是系统的一份状态。** 每个系统 8 个控制点，各存本帧和上一帧的变换（平移加 3×3），按 WPE 的帧内顺序在「死亡处理之后、发射之前」更新（报告 O1）。更新的输入有四类：
- JSON 的 `offset`、`angles`；
- `instanceoverride` 的 `controlpoint0..7`、`controlpointangle0..7`；
- 指针（控制点 `flags` bit0、`locktopointer`）；
- 父系统的控制点（`flags` bit2、`parentcontrolpoint`）。

读控制点的模块只经一个取值接口拿平移和 3×3。`sphererandom`、`boxrandom`、`vortex`、`turbulentvelocityrandom` 已经在这个位置写着「按单位阵」，P4c 把单位阵换成真实值。所以接口一旦定下，P4d 的映射类、距离类模块直接复用。

**世界空间是坐标系的切换，不是新模块。** 系统 `flags` bit0 时，粒子位置存世界坐标：出生时经对象世界矩阵变换，绘制时不再乘对象矩阵（rea-p4a C3）。渲染器每帧已经按父链算出世界矩阵（P4a 层级），只要把它作为输入交给模拟器。之后对象移动、旋转，已经发出的粒子留在原地。

**指针要换算到场景坐标。** 宿主已经把画布上的指针按壁纸样式换算成 `g_PointerPosition`（预览和桌面都有，暂停时不转发输入）。控制点要的是场景坐标，以及透视粒子下的深度，换算规则由步骤 0 读出，放在渲染器里统一算，模拟器只收场景坐标。

**拖尾和朝向是几何，不是模拟。** `spritetrail` 和 `sprite` 共用同一个解析函数（`FUN_1401c22e0`），拖尾靠着色器按速度拉长四边形（`TRAILRENDERER`，`g_RenderVar0 = (length, maxlength, minlength)`，rea-p4b-render 2.2）。厚格式顶点 P4b 步骤 2 已经接好，拖尾只差宏和 uniform。`sprite` 的 `orientation`、`axis`、`flags` 同属这段几何，一起做。

几个关键决定：

- **步骤 0 一次做完。** 和 P4b 一样：两个 REA 代理并行读完全部条目，写进 `rea-p4c-sim.md`、`rea-p4c-render.md`；一次 WPE 会话抓完确定性工程，后面各步只回放。
- **指针用记录的值回放，不动用户的鼠标。** 测试工程里加一个图层，把 WPE 每帧的 `g_PointerPosition` 写进颜色，和帧号、时钟图层同一种做法。回放时喂同一串指针，不需要把光标移到固定位置。
- **父控制点只做顶层能做的部分。** `flags` bit2、`parentcontrolpoint` 如果只在子系统里才有意义，就留给 P4e（子系统），本节继续报不支持。步骤 0 判定。
- **验收照旧靠回放。** 控制点、吸引、世界空间比轨迹；拖尾和朝向比整帧像素和四角。

## 范围与解锁

| 步骤 | 内容 | 解锁 |
|---|---|---|
| 0 | 调研：REA 读码、确定性工程抓帧 | — |
| 1 | 控制点底座：`offset`、`angles`、`instanceoverride` 的 `controlpoint*` / `controlpointangle*`、模块的 `controlpoint` 下标 | — |
| 2 | 指针：控制点 `flags` bit0、`locktopointer`，指针换算到场景坐标 | `1838478131` |
| 3 | `controlpointattract` | — |
| 4 | 世界空间（系统 `flags` bit0） | — |
| 5 | `spritetrail`；`sprite` 的 `orientation`、`axis`、`flags` | `3832772446`（还要步骤 1–3） |

P4c 解锁 2 张，能渲染的场景从 20 张到 22 张。`1923929928` 做完本节只差 `object:perspective`，不算本节验收。

各项挡住的场景数（一张场景可以被多项挡住）：控制点有内容 48、`spritetrail` 29、`controlpointattract` 28、世界空间 21、`instanceoverride` 的控制点 7。字段的用法（含 kabegame-sample）：
- 控制点：`flags` 88 处（1 有 45 张，2、4、16 各 1–2 张）、`offset` 86、`angles` 18、`locktopointer` 2、`parentcontrolpoint` 2；
- `controlpointattract`：`scale` 64、`threshold` 60、`origin` 53、`controlpoint` 46、`flags` 1；
- `spritetrail`：`length` 35、`maxlength` 33、`minlength` 8；
- `sprite`：`flags` 7、`orientation` 5、`axis` 2。

**本节不做，继续报不支持：**
- 读控制点的 P4d 模块：`mapsequence*`、`maintaindistance*`、`reducemovementnearcontrolpoint`、`vortex_v2`；
- 子系统（P4e）。父控制点如果依赖子系统，也留给 P4e；
- 带 `audioprocessing*` 的字段（P4e）；
- 脚本写控制点（P4f）。

## 现状锚点

**a. 控制点只要有内容就整张退回**（`compile/features.ts:597`）
```ts
function controlPointsUsed(raw: unknown): boolean {
  if (!Array.isArray(raw)) return false;
  return raw.slice(0, 8).some((entry) => {
    // …
    return Object.entries(entry as Record<string, unknown>).some(([key, value]) => {
      if (value === null || value === undefined || key === "id") return false;
      if (key === "offset" || key === "angles") return nonZeroVector(value); // 现状：非零就算内容
      if (key === "flags" || key === "parentcontrolpoint") return value !== 0 && value !== false;
      if (key === "locktopointer") return value !== false; // 现状：读取点没找到，保守算内容
      return true;
    });
  });
}
// …
if (flags & 1) unsupported.add("particle:flags:world"); // 现状：世界空间没实现（:641）
if (controlPointsUsed(system.controlpoint)) unsupported.add("particle:controlpoint"); // :644
```

**b. `instanceoverride` 的控制点直接报**（`compile/features.ts:418`）
```ts
} else if (/^controlpoint(?:angle)?[0-7]$/.test(key)) unsupported.add("particle:instance:controlpoint");
```

**c. 模块的控制点下标只认 0**（`particles/modules.ts:249`、`:275`、`:493`）
```ts
// 控制点（上限 7）属 P4c：非 0 时发射位置过控制点矩阵
controlpoint: int(0, zeroOnly), // sphererandom、boxrandom、vortex 三处都是这样
```

**d. 发射按单位阵**（`particles/emitters.ts:9`）
```ts
/** 控制点（`controlpoint ≠ 0`、世界空间）属 P4c，能力表已拦住，这里控制点矩阵按单位阵、平移按 0。 */
```

**e. `sprite` 只认缺省朝向**（`particles/modules.ts:509`）
```ts
// 非 `screen` 朝向（upright = 1、fixed = 2）的几何没读；`axis`、`flags` 的作用没读
orientation: { type: "string", default: "screen", supported: (value) => value === "screen" },
axis: { type: "vec3", default: "0 0 0", supported: (value) => (value as number[]).every((v) => v === 0) },
flags: int(0, zeroOnly),
```
`spritetrail` 不在模块表里，报 `particle:renderer:spritetrail`。

**f. `g_RenderVar0` 写死 0**（`render/uniforms.ts:380`）
```ts
g_RenderVar0: [0, 0, 0, 0], // 现状：拖尾的 length、maxlength、minlength 没写
```

**g. 粒子绘制总乘对象世界矩阵**（`render/scene.ts:1189`）
```ts
world: worldMatrixOf(layer.object, state.layers, worlds), // 现状：世界空间的系统也乘
// …
viewProjection: step.perspective ? this.perspectiveViewProjection : this.viewProjection,
```

**h. 指针只换算成着色器用的归一化坐标**（`render/renderer.ts:286`）
```ts
/** 画布上的指针位置（0…1，左上为原点、y 向下），按样式换算成 `g_PointerPosition`（见 `scenePointer`）。 */
setPointer(x: number, y: number): void {
  // …
  this.pointer = scenePointer(this.style, this.placement, this.canvas.width, this.canvas.height, x, y);
  // 现状：模拟器拿不到指针
}
```

## 步骤 0 — 调研

不改产品代码。

### 0a — REA 读码（子代理）

两个代理并行，结果分别写成 `phase4/rea-p4c-sim.md`（第 1–5 项）和 `phase4/rea-p4c-render.md`（第 6、7 项），格式同 `rea-p4a.md`，每条标地址和证据等级。已知线索：控制点更新在 `FUN_14022e3e0`，bit0 读 `ctx+0x8c` 和 `1 − ctx+0x90`，bit2 取 `[cp+0xc4]`，bit3 在 `0x14022e6b3`，bit1、bit4 在这个函数里没读到（sample-gaps §2.8）；世界空间见 rea-p4a C3。

1. **控制点：**
   - 存储布局：本帧和上一帧各存什么（平移、3×3、角度），初值是不是单位阵加 `offset`（rea-p4a 未查完一项）。
   - 每帧更新的完整顺序和公式：`offset`、`angles`（欧拉角顺序、单位）、`flags` 每一位（1、2、4、8、16）、`locktopointer`、`parentcontrolpoint`。
   - 指针的来源和换算：`ctx+0x8c` / `ctx+0x90` 是什么坐标，怎么变成场景坐标；透视粒子（`flags & 4`）和透视场景下的深度。
   - 父控制点：顶层系统有没有「父」，还是只对子系统有意义。
2. **`instanceoverride` 的控制点：** `controlpoint0..7`、`controlpointangle0..7` 覆盖什么（绝对位置还是加到 `offset` 上，在对象本地空间还是场景空间），运行时改值的反应。
3. **读控制点的模块：** `sphererandom`、`boxrandom`、`vortex`、`turbulentvelocityrandom` 用的是哪一份（本帧还是上一帧、平移还是 3×3）；全部读控制点的模块列个表，标出 P4d 的那几个。
4. **`controlpointattract`：** 字段和正交 / 透视缺省值、公式、`threshold`、`scale` 为负、`origin`、`flags` bit0 与「上一步位置」列（rea-framework 的列标志 bit2 条件）、两遍模式下用 `h` 还是 `k`。
5. **世界空间：**
   - 出生位置、速度怎么进世界空间（只乘发射时的世界矩阵，还是控制点乘模型矩阵后再发射）。
   - 绘制时的 `ctx+0xaf0` 是什么矩阵。
   - `movement` 的 `flags` bit0 与重力变换。
   - 对象不可见、父链变化、透视粒子下的行为。
6. **`spritetrail`：**
   - 字段缺省值（`length`、`maxlength`、`minlength`）。
   - 宏（`TRAILRENDERER`、`THICKFORMAT`）、顶点布局和 `g_RenderVar0` 的写入（rea-p4b-render 2.2 已读到一半）。
   - 和 `ropetrail` 的环形历史缓冲有没有关系（rea-framework Q5 提过 `sys+0x230`）。
7. **`sprite` 的 `orientation`、`axis`、`flags`**：`upright`、`fixed` 的几何，`axis` 的作用，`flags` 每一位。

### 0b — 确定性工程与实测（Claude）

- **新增** 生成器 `ignore/p4/gen_c.py`，复用 `gen_b.py` 的骨架，出这几个工程：
  - `proj/p4c-cp`：控制点 `offset`、`angles`、`flags` 各位、`locktopointer`、`instanceoverride` 的 `controlpoint1` / `controlpointangle1`，以及 `sphererandom`、`boxrandom`、`vortex` 用非 0 控制点；
  - `proj/p4c-attract`：`controlpointattract` 的吸引、排斥（`scale` 为负）、`threshold`、`origin`、`flags 1`；
  - `proj/p4c-world`：世界空间系统挂在会动的对象上（对象的 `origin`、`angles` 由脚本随时间改），对照组是同样设置的本地空间系统；
  - `proj/p4c-trail`：`spritetrail` 的 `length`、`minlength`、`maxlength` 几种组合，速度不同；
  - `proj/p4c-sprite`：`orientation` 三种、`axis`、`flags`。
- **指针记录图层 `PTR`：** 着色器把 `g_PointerPosition`（和 `g_PointerPositionLast`）写进颜色，`rdc_track_b.py` 读出来，给回放用。抓帧时光标在哪都行；光标在窗口外时 WPE 的取值本身也是要核对的一点。
- 用 `wpe-renderdoc` 一次会话抓完，fps 60 全抓，`p4c-attract` 另抓 fps 10（`h` / `k`）。开会话前确认另一个会话没有在用这个工具（`rd status`），WPE 不是我们启动的就请用户退出，结束后还原设置。
- 结论写进报告新节「P4c 语义的实测核对」。

**验收：**
- 两份逆向文档覆盖上面各项，模块都有字段表、缺省值、公式和证据等级。
- 父控制点归 P4c 还是 P4e 有结论。
- 指针换算有实测：记录的 `g_PointerPosition` 换算后和跟随指针的粒子出生位置吻合。
- 步骤 1–5 要回放的数据都已抓到。

## 步骤 1 — 控制点底座

> 2026-11-08 按步骤 0 的读码（[rea-p4c-sim.md](rea-p4c-sim.md) 第 1–3 节）、实测（报告「P4c 语义的实测核对」）和语料扫描（`ignore/p4/c1/scan_cp.py`，结果 `scan_cp.txt`）重写，写成可以直接派发的版本。

### 思路

控制点成为粒子系统的一份状态。每个系统有 `n` 个控制点，`n` 是模块 `controlpoint` 字段的最大值加 1（1.1）；没被模块引用的控制点不存在，JSON 里给它写什么都不起作用。每个控制点存 `base`、`current`、`previous` 三份仿射变换（3×3 加平移）：
- **建系统时**：`base` 是单位阵加 `offset`，再按静态的 `instanceoverride` 覆盖（`controlpointN` 替换平移，`controlpointangleN` 替换 3×3），`current = previous = base`（1.3、第 2 节）。
- **每帧**：在序列帧之后、发射之前更新一次 `current`（两遍模式也只一次），全部 operator 之后 `previous ← current`（1.5）。
- **预热前**：按加载时的对象世界矩阵 `W` 先更新一次，`previous ← current`；预热的每一步照常更新（1.3）。

模块经执行上下文读控制点。发射器读自己那个控制点的 `current`：出生点加上平移；3×3 只在「世界空间或 `controlpoint ≠ 0`」时旋转出生点，但总是交给 initializer 当 `M`，`velocityrandom`、`turbulentvelocityrandom` 乘它。`vortex` 的中心加控制点平移。

`flags 2` 要用 `W`：本地系统里 `current = inverse(W)·base`。渲染器每帧按 `SceneState` 算 `W`（父链、脚本改变换都跟上），预热和轨迹工具用编译期的变换。`ControlPointSet` 照 WPE 同一个函数把世界空间分支也写上（`current = W·base`），但世界空间整体在步骤 4，能力表照报。

按步骤 0 的结论，这些是中性的，不进数据、不报：JSON 控制点的 `angles`、`locktopointer`、`parentcontrolpoint`；顶层系统上 `flags` 的 4（只让实例覆盖不生效）、8、16；下标 ≥ `n` 的控制点。

**本步不做：**
- **指针（`flags` bit0）**：键改名为 `particle:controlpoint:pointer`，步骤 2 放开。`ControlPointSet` 里指针分支先写成 `current = base`，能力表在前面拦住。
- **世界空间**：照报 `particle:flags:world`（步骤 4）。
- **`instanceoverride` 控制点的运行时绑定**：语料 17 处全是静态值（`controlpoint` 15、`controlpointangle` 2），绑属性和挂脚本都是 0 处。只做静态值，`{user}` 报 `particle:instance:controlpoint:user`。这样本步不碰 `ParticleInstanceValues`、`BindingTarget`、`SceneState.write`，和 P4b 步骤 6（`colorn`）改的绑定代码不重叠。

**和 P4b 步骤 6 并行的做法**（风险 4）：另一个会话正在做 P4b 步骤 6，会改 `particles/system.ts`、`compile/particles.ts`、`compile/features.ts` 的其它段落。步骤 1 在快照 `ignore/p4/c1/ov`（`d938e75f` 的 `apps/wpe-scene/src`，加上未入库的翻译器 wasm）里开发和验收，不碰 `apps/wpe-scene`；验收后由 Claude 生成补丁移进工作区，再在工作区重跑一遍。快照的基线：tsc 0 error，vitest 42 个文件、1114 个用例全过。

**语料**（`scan_cp.txt`，按 `n` 区分有没有被引用）：
- 被引用的控制点：`flags` 1 有 67 处、2 有 3 处（都在 `3832133196` 的 `thunderbolt.json`，本地系统），其余 331 处是 0；`offset` 非零 15 处，`angles` 非零 24 处，`locktopointer` 3 处，`parentcontrolpoint` 6 处。
- 没被引用的控制点：`angles` 非零 203 处、`offset` 非零 25 处、`flags 1` 2 处，现在都在报，本步起中性。
- 模块的 `controlpoint`：`controlpointattract` 写了 1、2、3、6、7（步骤 3），`reducemovementnearcontrolpoint` 写了 1（P4d），`sphererandom` 写 0 的 3 处，其余用缺省 0。

### 现状锚点

见上文「现状锚点」的 a–d。另有：

**i. 帧内顺序没有控制点**（`particles/system.ts`，`advance`）
```ts
private advance(dt: number, frameDt: number, passes: 1 | 2): void {
  if (!(dt > 0)) return;
  this.ageAndKill(dt);
  this.sequenceFrames();
  this.emit(dt); // 现状：发射前没有控制点更新，帧尾没有 previous ← current
  // … operator 一遍或两遍
}
```

**j. initializer 的 `M` 按单位阵省掉**（`particles/initializers.ts`）
```ts
/** 三轴独立，**抽取顺序 z、y、x**，经控制点矩阵（P4a 为单位阵）后加到速度。 */
export function velocityRandom(fields: ParticleFields, { columns, random, slot }: ParticleRunContext): void {
  // …
  for (let i = 0; i < 3; i++)
    columns.velocity[i][slot] = f32(columns.velocity[i][slot] + lerp(min[i], f32(max[i] - min[i]), t[i])); // 现状：不乘 M
}
// turbulentVelocityRandom：「`M` 是发射器的控制点 3×3：控制点 0 无旋转时是单位阵，乘上是精确的，省掉」
```

**k. 模拟器拿不到对象的世界矩阵**（`render/scene.ts`，`createParticles` / `stepParticles`；`particles/track.ts`）
```ts
system.prewarm();                      // 现状：没有 W
particles.system.step(frametime, time); // 现状：没有 W
// particleTrack 的 layers 只取 "object" | "name" | "particle"
```

**l. 实例覆盖的控制点只取静态值、整个报掉**（`compile/particles.ts` `parseParticleInstance`、`compile/features.ts` `checkParticleInstance`）
```ts
controlpoints: Array.from({ length: 8 }, (_, i) => instanceVector(source[`controlpoint${i}`])),
controlpointAngles: Array.from({ length: 8 }, (_, i) => instanceVector(source[`controlpointangle${i}`])),
// features.ts：
} else if (/^controlpoint(?:angle)?[0-7]$/.test(key)) unsupported.add("particle:instance:controlpoint");
```

### 点 1 — 控制点状态（新增 `particles/controlpoints.ts`）

- **新增**
```ts
/** 一个控制点的仿射变换（WPE 每份存 4×4，第 4 行恒为 0 0 0 1，这里只存前三行）。 */
export interface ControlPoint {
  /** 3×3，列主序：`basis[c * 3 + r]` 是第 c 列第 r 个分量（同 rea-p4b-modules 的 Mij）。 */
  readonly basis: Float32Array;
  readonly translation: Float32Array;
}
export interface ControlPointInputs {
  /** 对象世界矩阵 `W`（`render/layout.ts` 的 `worldMatrixOf`，含父链）。顶层系统模拟时的模型矩阵 `M` 就是它（1.4）。 */
  world: Mat4;
}
/** `n = max(controlpoint + 1)`：遍历三类模块里模块表有 `controlpoint` 字段的项，取解析后的值（0–7）。没有这样的模块时为 0。 */
export function controlPointCount(def: Pick<SceneParticle, "emitters" | "initializers" | "operators">): number;
/** `controlpointangleN` 的 3×3（第 2 节，`R = Rz·Ry·Rx`，弧度；三列照伪代码逐项、逐步 f32）。 */
export function eulerBasis(angles: readonly number[]): Float32Array;
export class ControlPointSet {
  readonly count: number;
  /** base = I + offset，再按静态实例覆盖（`flags & 0x10005` 的点跳过）；current = previous = base。 */
  constructor(def: SceneParticle);
  /** `FUN_14022e3e0`（1.5），每帧一次，在发射之前。 */
  update(inputs: ControlPointInputs): void;
  /** 帧尾 `previous ← current`（`0x140237798`），全部 operator 之后。 */
  endFrame(): void;
  current(index: number): ControlPoint;
  previous(index: number): ControlPoint;
}
```
- `update` 照 1.5 的分支写，位的优先级 `0x10000` > bit0 > bit2 > 缺省：
```
for i < count:
  f = flags[i]
  f & 0x10000：跳过（remap 输出的点，P4d；JSON 写这一位时 current 一直是 base）
  f & 1：current = base（步骤 2 换成指针分支；能力表报 particle:controlpoint:pointer）
  其余（含 f & 4：顶层系统没有父，走缺省，1.8）：
    世界：!(f & 2) 或 i == 0 → current = W·base；否则不动
    本地：f & 2 → current = inverse(W)·base；否则不动
```
- 矩阵用 `render/math.ts`（列主序 `Mat4`、`multiply`、`invert`）。`W` 奇异时 `invert` 返回 null，WPE 是除以 0 得 inf / NaN，这里写 NaN（粒子不画），注释写明。
- 实例覆盖（第 2 节）：`angle` 已设（`instanceVector` 非 null）时 `base.basis = eulerBasis(angle)`；`pos` 已设时 `base.translation = pos`（替换，不加 `offset`）。只在建系统时做一次，之后不变（本步没有运行时绑定）。加载时的 `FUN_14022bd40` 还会按当时的 `W`（单位阵）写一次 `current`，紧接着加载时的那次 `update` 会按真实 `W` 重算，结果相同，所以构造里直接 `current = base`。

### 点 2 — 解析（`compile/particles.ts`）

- **新增**
```ts
/** 控制点数组的一项（1.2）。`angles`、`parentcontrolpoint`、`locktopointer`、`id` 不读：运行时没有读者或 WPE 不认这个键。 */
export interface SceneControlPoint {
  /** `flags`：数字取整，其余 0。bit0 指针、bit1 base 是场景坐标、bit2 父控制点（顶层只让实例覆盖不生效），其余位没有读者。 */
  flags: number;
  /** `offset`：只在是字符串时解析，按空白切、前三段各自 `atof`（`parseFloat`，NaN 取 0），缺的分量 0；否则 `0 0 0`。 */
  offset: [number, number, number];
}
/** 只在 `controlpoint` 是数组时读；按数组下标取前 8 项，不是对象的项取缺省。总是 8 项。 */
export function readControlPoints(json: JsonObject): SceneControlPoint[];
```
- **修改** `SceneParticle` 加 `controlpoints: SceneControlPoint[]`，`parseParticle` 填。
- **修改** `ParticleInstance.controlpoints`、`controlpointAngles` 的注释去掉「属 P4c」，写清「静态值，`{user}` 由能力表报」。

### 点 3 — 模块表与执行上下文（`particles/modules.ts`）

- **修改** `sphererandom`、`boxrandom`、`vortex` 的 `controlpoint` 去掉 `zeroOnly`，取值改成「取整后按无符号与 7 取小」（负数变 7；`controlpointattract` 的「上限 7、无符号比较」读到了，这三个按同一写法【推】，派发后先在 `ignore/p4/rea/wp.asm` 里核对各自的解析段）。
- **修改** `ParticleRunContext` 加三项：
```ts
  /** 本系统的控制点（P4c）。模块读 `current`；P4d 的模块还读 `previous`。 */
  controlPoints: ControlPointSet;
  /** 系统 `flags` bit0（世界空间）：发射器据此决定出生点旋不旋。步骤 4 之前能力表拦住，恒为 false。 */
  world: boolean;
  /** 发射这个粒子的 emitter 的控制点 3×3（`mat3(current)`，无条件，rea-p4c-sim 第 3 节）：emitter 写，initializer 当 `M` 用。 */
  basis: Float32Array;
```

### 点 4 — 读控制点的模块（`particles/emitters.ts`、`particles/initializers.ts`、`particles/operators.ts`）

- **修改** `sphereRandom`、`boxRandom`：
```
cp     = controlPoints.current(controlpoint);  context.basis = cp.basis
base   = cp.t + origin                          （逐分量一次加法）
rotate = world || controlpoint ≠ 0
q 照现状算；rotate 时 q = basis·q
pos    = q + base
回退方向（sphererandom 的 |q|² < 1e-4、boxrandom 的 fastInvSqrt 判定）另抽的 3 个分量，rotate 时同样乘 basis
boxrandom：d = pos − base（写进列的 float 重新减）
```
  - `basis·q` 的加法结合顺序、`|q|²` 判的是旋转前还是旋转后的 `q`，照反编译逐条核对：`sphererandom` 看 `ignore/p4/rea/p4b-mod/emit_1402378a0.c` 第 465–676 行，`boxrandom` 看第 802–826 行与 rea-p4b-modules A4 的伪代码（`X = (qx·M00 + qy·M10) + qz·M20`、`Y = (qy·M11 + qx·M01) + qz·M21`、`Z = (qx·M02 + qy·M12) + qz·M22`）。
  - 文件头和两个函数的注释去掉「按单位阵、平移按 0」。
- **修改** `velocityRandom`：加到速度之前乘 `M`（`context.basis`），加法顺序照 `0x14023bbce` 起的汇编（`ignore/p4/rea/wp.asm`）。
- **修改** `turbulentVelocityRandom`：`v += M·(…)`，`M·v` 照现有注释里的 `FUN_140184440` 顺序，去掉「省掉」那条。
- **修改** `vortex`：`C = cp[controlpoint].t + offset`，轴、`offset` 不旋转（B7）。注释去掉「控制点 0 平移按 0」。

### 点 5 — 模拟器（`particles/system.ts`）

- **修改**
```ts
const IDENTITY_INPUTS: ControlPointInputs = { world: identity() };

constructor(/* 不变 */) {
  // …
  this.controlPoints = new ControlPointSet(def); // 新增
  this.context = { /* 现有各项 */, controlPoints: this.controlPoints, world: (def.flags & 1) !== 0, basis: IDENTITY_BASIS };
}

/** 加载（1.3）：控制点按加载时的 W 更新一次、previous ← current，再预热；预热每步照常更新控制点。starttime 为 0 时也做前两步。 */
prewarm(inputs: ControlPointInputs = IDENTITY_INPUTS): void;
step(frameDt: number, time?: number, inputs: ControlPointInputs = IDENTITY_INPUTS): void;

private advance(dt: number, frameDt: number, passes: 1 | 2, inputs: ControlPointInputs): void {
  if (!(dt > 0)) return;
  this.ageAndKill(dt);
  this.sequenceFrames();
  this.controlPoints.update(inputs); // 新增：O1 第 5 步（0x1402376fe），序列帧（0x140237022）之后、发射之前
  this.emit(dt);
  // … operator 一遍或两遍，不变
  this.controlPoints.endFrame(); // 新增：全部 operator 之后
}
```
- `setInstance` 不变（只有标量）。`suspend` 不变：WPE 不可见时控制点照常更新（5.6），但可见后的第一帧发射前会重算 `current`，本步没有读 `previous` 的模块，注释写明这点差异只影响 P4d。
- 文件头的「控制点（P4c）、子系统不在这里」改成控制点的一句话说明。

### 点 6 — 世界矩阵输入（`render/scene.ts`、`particles/track.ts`）

- **修改** `createParticles`：`W = worldMatrixOf(layer.object, state.layers, new Map())`，`system.prewarm({ world: W })`，`ParticleDraw` 加 `world`（加载时的 `W`）。
- **修改** `stepParticles`：有 `state` 时每帧 `worldMatrixOf(draw.object, state.layers, cache)`（一次调用共用一个 `cache`），没有 `state`（dev 探针回放）时用 `particles.world`。
- **修改** `particleTrack`：`layers` 的 Pick 加 `origin`、`angles`、`scale`、`parent`，用全部图层建变换表、按 `worldMatrixOf` 算每个粒子层的 `W`（静态，不跑脚本），传给 `prewarm` 和 `step`。`dev/probe.ts` 传进来的就是编译后的全部图层，确认类型对上即可。

### 点 7 — 能力表（`compile/features.ts`）

- **删除** `controlPointsUsed`、`nonZeroVector`（没有别的调用时），键 `particle:controlpoint`、`particle:instance:controlpoint`。
- **新增**
```ts
/**
 * 控制点（P4c 步骤 1，rea-p4c-sim.md 第 1 节，实测见报告「P4c 语义的实测核对」）：只看下标 < n 的项（n 见 `controlPointCount`，
 * 模块按模块表读）。`flags` bit0（指针）报 `particle:controlpoint:pointer`（步骤 2）；其余位、`offset`、`angles`、
 * `parentcontrolpoint`、`locktopointer` 和别的键都不报（理由同 `SceneControlPoint`）。关键帧照旧由 `scanValue` 报。
 */
function checkControlPoints(system: JsonObject, orthographic: boolean, unsupported: Set<string>): void;
```
- **修改** `checkParticleInstance`：`controlpointN`、`controlpointangleN` 静态值不报，`{user}` 报 `particle:instance:controlpoint:user`，`{script}` 照旧 `particle:binding:instance:<键>`。注释同步。

### 验收

**单测**（新增 `particles/controlpoints.test.ts`，改 `emission.test.ts`、`simulator.test.ts`、`compile/particles.test.ts`）：
- 初值：`offset` 平移；JSON `angles` 不起作用；`offset` 不是字符串、分量不足、有非数字时的取值。
- 实例覆盖：平移替换不叠加；`eulerBasis` 按 `Rz·Ry·Rx`（`(0, 0, π/2)` 把 x 轴转到 y 轴，再用一组三轴都非零的角度钉住每个分量）；`flags` 1、4、`0x10000` 的点不覆盖；`n` 之外的点不建。
- `update`：本地 `flags 2` 是 `inverse(W)·base`，`flags 0` 不动；世界分支 `W·base`、控制点 0 忽略 bit1；`0x10000` 跳过；`endFrame` 之后 `previous` 是这一帧的 `current`；更新在序列帧之后、发射之前（发射读到的是本帧值）。
- 发射：`controlpoint ≠ 0` 旋转出生点和回退方向；控制点 0 带角度时出生点不旋，`velocityrandom` 的速度旋了；`turbulentvelocityrandom` 乘 `M`；`vortex` 中心加控制点平移、轴不旋。
- 能力表：上面列的中性项不报，指针点报新键，`n` 之外的指针点不报，实例覆盖三种写法。

**回放**（新增 `ignore/p4/c1/replay.test.ts`，照 `b3/replay.test.ts` 的骨架，`KB_SRC` 指向快照）：
- `p4c-cp` 抓帧（`tracks/rd-p4c-cp-fps60.json`，4 帧，dt 用 `out/p4c-cp-fps60-log.txt`）里不含指针的 11 个系统逐粒子比：`cp-angles`、`cp-io-angle`、`cp-io-pos`、`cp0-angle`、`cp-flag2`、`cp-flag2-ref`、`cp-flag4`、`cp-flag16`、`cp-flag16-ref`、`ptr-lock`、`vortex-cp`。限值同 P4b（1e-3，坐标过 1000 时 2e-3；`vortex-cp` 加 `rsqrt` 包络）。`ptr-*` 三个不比。
- P4a、P4b 的回放在快照上改动前后各跑一遍，结果逐字相同：`b3/replay.test.ts`（P4a 的 9 个 tag、`p4b`、`p4b-emit`）、`b4/replay.test.ts`（噪声）。这些系统都只用控制点 0、没有实例覆盖，`basis` 是单位阵，结果不该变。

**变异检查**（每处都要有用例或回放失败）：
- 控制点更新挪到发射之后；`endFrame` 挪到 operator 之前，或不做；
- 欧拉角按 `Rx·Ry·Rz`；
- 实例平移加到 `offset` 上；实例覆盖不跳过 `flags 4` 的点；
- 读 JSON 的 `angles`；
- `flags 2` 用 `W` 而不是 `inverse(W)`；世界分支不对控制点 0 例外；
- 旋转条件写成「总是旋」或「只看 `controlpoint ≠ 0`、不看世界」；回退方向不旋；
- `basis` 不交给 initializer（`velocityrandom` 不乘 `M`）；
- `vortex` 中心不加控制点平移；
- `n` 按 8 算（能力表把 `n` 之外的指针点也报了）。

**语料**（`b4/corpus.test.ts` 的做法，快照改动前后各跑一遍，逐条解释）：
- 去掉的键应只有 `particle:controlpoint`、`particle:instance:controlpoint` 和模块的 `…:controlpoint` 字段问题；新增的键只有 `particle:controlpoint:pointer`（应正好是被引用的 `flags 1` 点所在的场景）。`particle:instance:controlpoint:user` 应为 0 张。
- 干净场景数和新解锁的场景逐张列出，各自说明为什么解锁。

**移进工作区之后**（Claude 做）：补丁用 `git apply --3way` 打进工作区；tsc、vitest、Prettier 在工作区重跑；10 张干净场景三档的画面哈希和 P4b 最近一轮（`b5v/out/hash-after.json`）相同，需要 dev 在跑，没在跑就记下没做。

## 步骤 2 — 指针

> 2026-11-08 按 rea-p4c-sim 1.6、1.7、步骤 0 的实测和步骤 2 补测（报告「P4c 语义的实测核对」末尾，`proj/p4c-ptr` 三种窗口）写成可以直接派发的版本。P4b 已收尾（`58b4e8c6`），本步直接在 `apps/wpe-scene` 里做，不用快照。

### 思路

指针点每帧的平移是「光标下的场景点」：
- **WPE 的做法**（1.6）：`current = base`，再用 `inverse(P·V)` 把窗口归一化指针 `(px, py)` 反投影到 z = 0，丢掉 `offset`（3×3 是单位阵，实例覆盖不作用在指针点上）。世界系统直接用 `(X, Y, 0)`，本地系统再乘 `inverse(W)`。用的是本帧指针（补测：指针每帧在动，跟随点和当帧值吻合）。
- **窗口和场景比例不同时**：WPE 把居中盖满的裁切做进投影 `P·V`（补测：1920×800、1440×1080 两种窗口），所以跟随点是光标下的场景点，不是 `px·W`。
- **Kabegame 的对应**：场景渲染在场景分辨率的目标里，`P·V` 是不裁的正交投影，裁切和留白在上屏时按样式做（`scenePlacement`）。所以先按铺放把画布指针反算成光标下的场景纹理坐标 `cursor`（0…1，左上原点、y 向下），再用不裁的 `P·V` 照 WPE 的同一串运算反投影。`fill` 的铺放就是 WPE 的居中盖满，结果和 WPE 一致；`fit`、`center` 是 Kabegame 自己的样式，按同一个原则（光标下的点），留白处线性外推；`stretch` 是恒等；`tile` 取所在那一块（取小数部分）。

这和 `g_PointerPosition` 不是一个量。`g_PointerPosition` 照 P2a 不变：`fill` / `stretch` 是画布归一化坐标（WPE 就是窗口归一化坐标），其余样式换算到场景上。本步不改它。

数据流：宿主 `pointermove` → `SceneRenderer.setPointer` 只记画布上的原始坐标 → 每帧按当前样式和铺放算 `cursor`，放进 `FrameInput` → `GpuScene` 每帧用 `sceneViewProjection` 反投影一次，得到跟随点 `F = (X, Y)`（场景坐标）→ 每个系统的 `ControlPointInputs.pointer`。模拟器只收场景坐标，不知道样式。加载时的那次更新和预热用加载时刻的 `cursor`（WPE 加载时也读当时的指针）。

透视粒子（系统 `flags & 4`）不用另算：WPE 模拟时栈上是场景的正交投影，透视投影只在绘制时压栈（1.6），透视粒子的 z = 0 平面和正交画面重合（rea-p4a C4）。透视场景（`camera:perspective`）、相机视差（`general:cameraparallax`）、`zoom ≠ 1` 都照报，所以 `P·V` 只有正交一种。

**已知差别，不处理：** WPE 用全局光标（`GetCursorPos`），光标在窗口外也跟踪；Kabegame 只在宿主收到 `pointermove` 时更新（预览里是光标在 iframe 上时，桌面是鼠标转发时），之外保持最后的值。没收到过事件时 `cursor` 取场景中心 `(0.5, 0.5)`。

**本步不做：** 世界空间（`particle:flags:world`，步骤 4）。`ControlPointSet` 的世界分支照 1.6 写上（`(X, Y, 0)`，不乘 `W`），能力表照报。

### 现状锚点

见上文「现状锚点」h。另有：

**m. 指针点先按 `base` 处理**（`particles/controlpoints.ts`，`update`）
```ts
if (f & CONTROL_POINT_FLAGS.pointer) {
  copyPoint(point.current, point.base); // 现状：步骤 1 的占位，能力表报 particle:controlpoint:pointer
  return;
}
```

**n. 控制点的输入只有世界矩阵**（`particles/controlpoints.ts`、`particles/system.ts`）
```ts
export interface ControlPointInputs {
  world: Mat4; // 现状：没有指针
}
const IDENTITY_INPUTS: ControlPointInputs = { world: identity() };
```

**o. 指针换算成 `g_PointerPosition` 发生在事件里**（`render/renderer.ts`，`setPointer`；`render/layout.ts`，`scenePointer`）
```ts
setPointer(x: number, y: number): void {
  this.pointerLast = this.pointer;
  // …
  this.pointer = scenePointer(this.style, this.placement, this.canvas.width, this.canvas.height, x, y);
}
// scenePointer：fill / stretch 原样返回（g_PointerPosition 的取法），其余按铺放反算，tile 取小数
if (style === "fill" || style === "stretch") return [x, y];
```

**p. 能力表报指针点**（`compile/features.ts`，`checkControlPoints`）
```ts
for (let i = 0; i < count; i++)
  if ((points[i].flags & (CONTROL_POINT_FLAGS.remap | CONTROL_POINT_FLAGS.pointer)) === CONTROL_POINT_FLAGS.pointer)
    unsupported.add("particle:controlpoint:pointer");
```

### 点 1 — 反投影与指针分支（`particles/controlpoints.ts`）

- **修改**
```ts
export interface ControlPointInputs {
  world: Mat4;
  /** 新增：指针的跟随点（场景坐标，z = 0，`pointerScenePoint` 算），每帧由渲染器给。 */
  pointer: readonly [number, number];
}
```
- **新增**
```ts
/**
 * 光标下的场景纹理坐标（0…1，左上原点、y 向下）→ 跟随点的场景坐标（rea-p4c-sim.md 1.6，`0x14022e47b` 起）。
 * `viewProjection` 是场景的正交 `P·V`（`render/layout.ts` 的 `sceneViewProjection`），函数内求逆。
 */
export function pointerScenePoint(viewProjection: Mat4, cursor: readonly [number, number]): [number, number];
```
  照 1.6 逐步 float32：`px`、`py` 先舍入；`x = ((px − 0) + (px − 0)) − 1`，`y = (((1 − py) − 0) + ((1 − py) − 0)) − 1`；`w = (A03·x + A13·y) + (A23·0 + A33)`；`X = ((A00·x + A10·y) + (A20·0 + A30)) / w`，`Y` 同理（`Aij` 是第 i 列第 j 个分量）。`invert` 失败（不会发生，正交投影可逆）时返回 NaN。
- **修改** `update` 的指针分支（位的优先级不变：`0x10000` > bit0 > bit2 > 缺省）：
```
f & 1：current = base（3×3 是单位阵：指针点不吃实例覆盖），平移整体覆盖：
  世界：current.t = (X, Y, 0)
  本地：B = inverse(W)；current.t = ((B00·X + B10·Y) + (B20·0 + B30), (B01·X + B11·Y) + (B21·0 + B31), (B02·X + B12·Y) + (B22·0 + B32))
        B 和 flags 2 共用一次求逆；W 奇异时写 NaN（同 flags 2）
```
  逐步 float32，`offset` 被丢弃。文件头和 `update` 注释去掉「步骤 2」的占位说明。

### 点 2 — 光标下的场景点（`render/layout.ts`）

- **新增**
```ts
/**
 * 画布上的指针（0…1，左上原点）→ 光标下的场景纹理坐标（P4c 步骤 2，控制点跟随指针用）。所有样式都按铺放反算：
 * `fill` 等于 WPE 投影里的居中盖满裁切（步骤 2 补测），`fit` / `center` 留白处线性外推，`stretch` 恒等，`tile` 取所在那一块。
 */
export function sceneCursor(
  style: SceneStyle,
  placement: ScenePlacement,
  canvasWidth: number,
  canvasHeight: number,
  x: number,
  y: number,
): [number, number];
```
- **修改** `scenePointer`：非 `fill` / `stretch` 时调 `sceneCursor`（两者在这些样式下相同），`fill` / `stretch` 仍原样返回。结果逐位不变。

### 点 3 — 渲染器（`render/renderer.ts`、`render/uniforms.ts`）

- **修改** `FrameInput` 加一项：
```ts
  /** 新增：光标下的场景纹理坐标（`sceneCursor`），控制点跟随指针用（P4c 步骤 2）。和 `pointer`（`g_PointerPosition`）不是一个量。 */
  cursor: [number, number];
```
  `frameBuiltins` 不读它。
- **修改** `SceneRenderer`：
  - 新增 `canvasPointer: [number, number] | null`，`setPointer` 记下原始坐标（`g_PointerPosition` 的算法不变）。
  - `render` 里 `syncPlacement` 之后算 `cursor`：有 `canvasPointer` 时 `sceneCursor(this.style, this.placement, canvas.width, canvas.height, …canvasPointer)`，否则 `(0.5, 0.5)`。每帧现算，所以改样式、改尺寸之后下一帧就对，不用等下一次 `pointermove`。
  - `load`：按新场景的尺寸（`bundle` 的场景分辨率，宽高比和 `GpuScene.width/height` 相同）现算一次铺放和 `cursor`，经 `GpuScene.build` 的 `particles` 选项传给加载时的更新和预热。
- 暂停：`setPointer` 照常记坐标，不画；恢复后的第一帧用最新值。WPE 暂停时指针冻结、恢复后读当时的光标，效果相同。

### 点 4 — `GpuScene`（`render/scene.ts`）

- **修改** `build` 的 `particles` 选项加 `cursor?: [number, number]`（缺省 `(0.5, 0.5)`）；`createParticles` 用 `pointerScenePoint(this.viewProjection, cursor)` 和加载时的 `W` 调 `prewarm`。
- **修改** `update` 把 `frame.cursor` 交给 `stepParticles`；`stepParticles(frametime, time, state?, cursor = [0.5, 0.5])` 每次调用只反投影一次，`{ world, pointer }` 传给每个系统。没有粒子层时不算。
- `stepParticles` 的注释写清指针输入。

### 点 5 — 模拟器、轨迹工具与 dev 探针

- **修改** `particles/system.ts`：`IDENTITY_INPUTS` 加 `pointer: [0, 0]`（只给单测）；`step`、`prewarm` 注释里的输入说明加上指针。
- **修改** `particles/track.ts`：`ParticleTrackOptions` 加
```ts
  /** 新增：每帧光标下的场景纹理坐标，和 `dts` 等长；回放 WPE 时填轨迹里的 `g_PointerPosition`（抓帧窗口和场景同尺寸时两者相同）。缺省场景中心。第 1 项也用于预热。 */
  cursors?: readonly (readonly [number, number])[];
  /** 新增：场景的投影尺寸（`general.width/height`），算 `sceneViewProjection`。给了 `cursors` 时必填。 */
  size?: readonly [number, number];
```
  预热和每帧都按它算跟随点。
- **修改** `dev/probe.ts`：`renderFrame` 的 `pointer` 同时作 `cursor`（`FrameInput` 两项都填，加载时也用它），注释写明「抓帧窗口和场景同尺寸时两者相同」；调 `particleTrack` 的地方传 `size`。`dev/particleCorners.ts` 的 `FrameInput` 补 `cursor: [0.5, 0.5]`。

### 点 6 — 能力表与解析注释（`compile/features.ts`、`compile/particles.ts`）

- **删除** `checkControlPoints` 和键 `particle:controlpoint:pointer`；不再用到的 import（`readControlPoints`、`controlPointCount`、`CONTROL_POINT_FLAGS` 等）一并删掉。`checkParticleFeatures` 注释的控制点一条改成「控制点全部支持或中性（P4c 步骤 1、2），父控制点归 P4e」。
- **修改** `SceneControlPoint.flags` 的注释：bit0 已实现（步骤 2）。

### 验收

**单测**（改 `particles/controlpoints.test.ts`、`render/layout.test.ts`（没有就新增）、`compile/particles.test.ts` 或能力表的测试、`render` / `dev` 里手写 `FrameInput` 的测试）：
- `pointerScenePoint`：1920×1080 时等于 `(px·1920, (1 − py)·1080)`；`py` 不翻转的写法会失败；窗口外（`px > 1`、负数）线性外推；非方形场景（3441×2465）。
- 指针分支：`offset` 被丢弃；实例覆盖（`controlpointN`、`controlpointangleN`）不作用；本地系统是 `inverse(W)·F`（带旋转、缩放的 `W`）；世界系统是 `(X, Y, 0)`、不乘 `W`；`flags 1|2`、`1|4` 走指针分支；`0x10000|1` 跳过；`W` 奇异写 NaN；更新在发射之前（本帧发射读到本帧的跟随点）。
- `sceneCursor`：`fill` 在 1920×800、1440×1080 画布上和补测的 `P·V` 裁切一致（用 `out/ana_ptr2.txt` 里几组指针和跟随点当用例）；`fit` 留白外推；`center`；`stretch` 恒等；`tile` 取小数。`scenePointer` 的结果逐位不变。
- 渲染器：`cursor` 每帧现算（改样式后不经 `setPointer` 也变）；没事件时是中心。能做成纯函数测试就不起 GPU。
- 能力表：`flags 1` 的点不再报；1838478131 的粒子 JSON（照抄进测试）没有不支持项。

**回放**（新增 `ignore/p4/c2/`，骨架照 `c1/replay.test.ts`，dt 同样取日志累计时间差分，抓到的帧用轨迹的 float32 dt）：
- `p4c-ptr-fps60`（FR 919–928 的 10 帧）：`p-loc`、`p-xform`、`p-off`、`p-io`、`p-cp1`、`p-persp`、`p-ref` 逐粒子比，跟随点用轨迹里每帧的 `pointer`，窗口之前的帧用第一帧的值。**只比窗口内出生的粒子**（按年龄判断；窗口之前出生的粒子用的指针没有记录）。`p-world` 不比（步骤 4）。限值同步骤 1（含 `rcpps` 包络）。
- `p4c-ptr-fps60-1920x800`、`-1440x1080`：同样的系统，跟随点按 Kabegame 的 `fill` 算：`sceneCursor("fill", scenePlacement("fill", 1920, 1080, 窗口宽, 窗口高), …, 轨迹指针)` 再 `pointerScenePoint`。这一组验证 `fill` 等于 WPE 的裁切。
- 编译 `p4c-ptr` 的不支持项应正好是 `particle:flags:world`。
- 以前的回放在改动前后各跑一遍（改动前用 HEAD 导出的源码），输出逐字相同：`b3`、`b4` 的拷贝（`c1/replay-b3.test.ts`、`replay-b4.test.ts`）、`c1/replay-b6.test.ts`、`c1/replay.test.ts`（`p4c-cp` 的 11 个系统；它断言不支持项是 `particle:controlpoint:pointer`，在 `c2` 里拷一份把断言改成空集再跑，`c1` 原文件不动）。这些系统没有指针点，结果不该变。

**变异检查**（每处都要有用例或回放失败）：
- `y` 用 `py` 不翻转；跟随点取上一帧的指针；
- `offset` 不丢（加到跟随点上）；指针点吃实例覆盖；
- 本地系统不乘 `inverse(W)`；乘 `W`；世界系统乘 `W`；
- 指针优先于 `0x10000`；
- `fill` 用原始画布坐标（`scenePointer` 的取法）；`tile` 不取小数；`cursor` 只在 `setPointer` 里算（改样式后不变）；
- 加载时的更新 / 预热不用指针。

**语料**（`c1/corpus.test.ts` 的做法，HEAD 导出对工作区）：去掉的键应只有 `particle:controlpoint:pointer`（32 张）；`1838478131` 变干净，干净场景 20 → 21，其余变干净的逐张解释。

**画面哈希**（Claude 做，需要 dev 在跑，没在跑就记下没做）：10 张干净场景三档和步骤 1 的 `c1/out/hash-after.json` 相同（这些场景没有指针点；注意宿主要重建）。

**真机**（用户）：`1838478131` 在预览和桌面上粒子跟着鼠标；桌面若不是 3441∶2465 的比例，`fill` 下粒子仍在光标下；切到 `fit` / `center` 再看一次。

## 步骤 3 — `controlpointattract`

> 2026-11-08 按 rea-p4c-sim 第 4 节、步骤 0 的实测和语料扫描（`ignore/p4/c3/scan_attract.py`，结果 `scan_attract.txt`；挡住的场景 `attract_unlock.py`）写成可以直接派发的版本。直接在 `apps/wpe-scene` 里做。Claude 对过 `ignore/p4/rea/p4c-sim/cpa.asm`、`cpa_blend.asm` 和解析段里 `deletethreshold` 的平方（`0x1401ccbef` `mulss xmm6, xmm6`，float 平方）。

### 思路

`controlpointattract` 是一个普通 operator：每遍对 `[0, count)` 的槽，按粒子到控制点的距离改速度，不改位置。它加进模块表之后，解析、能力表和控制点个数 `n` 都按表自动跟上。只被它引用的控制点从此存在，指针和实例覆盖在这些点上生效。语料里它引用的大多是跟随指针的控制点 1，效果是粒子躲开光标。

公式照 4.2 的汇编逐条写。普通版（`0x140241554`）和 blend 版（`0x14024172d`）的运算顺序相同，blend 版只在钳制之后多乘 `b`：
```
C  = cp[controlpoint].current.t
ks = k·scale                    （scale 已乘 instanceoverride.speed）
rT = rcp(threshold)
每槽：dx = x − Cx，dy、dz 同；L2 = (dz² + dy²) + dx²；L = sqrt(L2)；inv = rcp(L)
      active = (L < threshold) 且 (FLT_MIN < L)
      f = (1 − L·rT)·ks；flags & 2 且 L < f 时 f = L；[blend 版：f = f·b]
      active 时 vy −= (inv·dy)·f，vz −= (inv·dz)·f，vx −= (inv·dx)·f
flags & 1：删除判定（4.3）
```
乘的是 drag 系数 `k`，不是步长 `h`。两遍模式下每遍用 `k/2`，删除判定每遍都做。

删除判定（`flags` bit0）读「上一步位置」列。`movement` 每遍开头把位置抄进这一列，所以 `[上一步位置, 位置]` 是这一遍的位移线段。线段上离 `C` 最近的点到 `C` 的距离平方不大于 `deletethreshold²` 时，令 `age = life`：本帧照常画，下一帧判死。这一列只在 bit0 时分配（WPE 解析期 `def+0xc |= 4`），所以模块的列标志要按字段算。

几个关键决定：
- **`origin`、`offset` 登记成不参与计算的字段。** WPE 不读 `origin`（解析段里没有这个键）；`offset` 解析了，但两个执行段和删除判定都不读。语料里 50 处 `origin` 都是 `"0 0 0"` 一类的静态串，登记成 `vec3` 就不会按表外字段报。做法同 `turbulentvelocityrandom` 的 `up`。
- **列标志按字段算。** 模块表加可选的 `columnFlagsOf(fields)`，和静态的 `columnFlags` 按位或。只有本模块用。
- **近似倒数照旧不复刻**（`rcp`），回放用包络放宽。
- **不解锁新场景。** 报 `controlpointattract` 的 28 张场景都还有别的不支持项；`3832772446` 做完只剩 `particle:renderer:sprite:flags`（步骤 5）。语料里 62 处全用缺省 `flags`（钳制开），没有 blend 和 `deletethreshold`；43 处 `scale < 0`（排斥）；`controlpoint` 写了 1、2、3、6、7；4 处在世界空间系统里（步骤 4）。上文「范围与解锁」里的字段计数含 kabegame-sample，和这里的数不同。
- **删除判定和 blend 没有补抓。** 语料里没人用，读码已经确定。`p4c-attract` 的两轮抓帧里有 `a-blend`；`a-delete` 只能核对粒子数：窗口之前出生的那个粒子已经被删掉，窗口里新出生一个。删除发生在哪一帧没有抓到，由单测按读码钉住。

### 现状锚点

**q. 表外模块整张退回**（`compile/features.ts:640`）
```ts
const reading = readParticleModule(category, entry, orthographic);
if (!reading.known) {
  unsupported.add(`particle:${module}`); // 现状：controlpointattract 报 particle:operator:controlpointattract
```

**r. 列标志是模块的静态值**（`particles/system.ts:130`）
```ts
export function particleColumnFlags(def: Pick<SceneParticle, "emitters" | "initializers" | "operators">): number {
  // …
  for (const module of modules) flags |= particleModuleDef(category, module.name)?.columnFlags ?? 0; // 现状：不看字段
}
```

**s. `n` 只数表内模块**（`particles/controlpoints.ts:113`）
```ts
 * 表外模块（`controlpointattract` 等）不计：场景已因 `particle:<类别>:<名字>` 退回，它们也不执行。
```

**t. `movement` 已经会刷新上一步位置**（`particles/operators.ts:58`）
```ts
if (columns.previousPosition)
  for (let i = 0; i < 3; i++) columns.previousPosition[i].set(columns.position[i].subarray(0, count));
```
出生时 `spawn` 也把上一步位置写成出生位置（`particles/system.ts:420`）。

**u. 单测拿它当表外模块的例子**（`compile/particles.test.ts:611`、`:850`，`particles/simulator.test.ts:725`，`particles/controlpoints.test.ts:61`）。

### 点 1 — 模块表（`particles/modules.ts`）

- **新增** `ParticleModuleDef` 一项：
```ts
  /**
   * 按字段追加的列标志（和 `columnFlags` 按位或）。只有 `controlpointattract`：`flags` bit0 时置 bit2（上一步位置），
   * rea-p4c-sim.md 4.1「`flags & 1` 时 `def+0xc |= 4`」。
   */
  columnFlagsOf?: (fields: Readonly<Record<string, ParticleFieldValue>>) => number;
```
- **新增** 模块记录（放在 `vortex` 之前或之后均可，注释写依据）：
```ts
  {
    // rea-p4c-sim.md 4.1（operator 10，blend 0x20，解析 `0x1401cc9c8`–`0x1401ccdb5`，缺省 `FUN_1401bdee0`）
    category: "operator",
    name: "controlpointattract",
    fields: {
      // 乘 `speed`（条目类型 5，只登记这一项；系统 flags bit4 时不登记）
      scale: by("speed", num({ orthographic: 512, perspective: 20 })),
      threshold: num({ orthographic: 512, perspective: 5 }),
      // 解析期按 float 平方存（`mulss`），执行函数里平方
      deletethreshold: num({ orthographic: 15, perspective: 0.5 }),
      // 缺省 2（钳制开，`0x1401be245`）；bit0 删除，bit1 钳制，其余位没有读者
      flags: int(2),
      // 读这个控制点 current 的平移；解析期钳到 0–7
      controlpoint: CONTROL_POINT_FIELD,
      // 解析了，执行不读
      offset: vec3("0 0 0"),
      // WPE 不读这个键（解析段没有它），中性：登记成不参与计算的字段，免得按表外字段报（语料 50 处）
      origin: vec3("0 0 0"),
      ...BLEND,
    },
    columns: ["age", "life", "position", "velocity", "previousPosition"],
    columnFlags: 0,
    columnFlagsOf: (fields) => ((fields.flags as number) & 1 ? COLUMN_FLAGS.previousPosition : 0),
    normalize(fields) {
      fields.controlpoint = clampControlPoint(fields.controlpoint as number);
    },
    run: controlPointAttract,
  },
```
- **修改** `PARTICLE_MODULES` 上面的清单注释加上 P4c 步骤 3。`clampControlPoint` 注释里引用 `controlpointattract` 的那句保留。
- 派发后先核对：`flags`、`controlpoint` 的解析段（`cpa_parse.asm` 第 129–200 行附近，几处 `FUN_140085f70`）是不是只在键存在时读；`scale`、`threshold`、`deletethreshold` 是 `FUN_140086220`（float）读。和计划不符时按汇编改，并记下来。

### 点 2 — 执行函数（`particles/operators.ts`）

- **新增**
```ts
/** `FLT_MIN`（`0x00800000`，`0x1404e9960` / `0x1404e9980`）：`L` 不大于它时这个粒子不受影响，避免 `rcp(0)`。 */
const FLT_MIN = 2 ** -126;

/**
 * `controlpointattract`（operator 10，`0x140241554`；blend 版 0x20，`0x14024172d`，rea-p4c-sim.md 4.2【确】）。公式见上面
 * 「思路」；写法要点：
 * - `L2 = (dz² + dy²) + dx²`，`L = sqrtps`（精确）；`rcp(threshold)`、`rcp(L)` 是 `rcpps`，按精确值算；
 * - `active = L < threshold && FLT_MIN < L`，两个都是严格小于；`L` 为 NaN 时不生效；
 * - `f = (1 − L·rT)·ks`；`flags & 2` 且 `L < f` 时 `f = L`（`scale < 0` 时 `f < 0`，永远不钳）；blend 版钳制之后 `f *= b`；
 * - 速度按 y、z、x 的顺序减 `(inv·d)·f`，逐步 float32；
 * - 死槽照常处理；`flags & 1` 时接着做删除判定（`attractDelete`）。
 */
export function controlPointAttract(fields: ParticleFields, context: ParticleRunContext): void;

/**
 * 删除判定（`FUN_14022a150`，rea-p4c-sim.md 4.3）：线段 `[上一步位置, 位置]` 上离 `C` 最近的点到 `C` 的距离平方不大于
 * `deletethreshold²` 时 `age = life`（比较是 `dt² < |e|²` 保留年龄，所以 NaN 也删）。
 */
function attractDelete(/* … */): void;
```
- 删除判定逐步 float32：
```
d = P1 − P0；L = sqrt((dz² + dy²) + dx²)；r = L > 0 ? rcp(L) : 1
s = C 在线段方向上的投影；s = s ≥ 0 ? s : 0（NaN 得 0）；s = s ≤ L ? s : L
e = C − (s·r·d + P0)；!(deletethreshold² < |e|²) 时 age = life
```
  加法结合顺序 rea-p4c-sim 4.3 是按 Ghidra 写的【推】。实现前到 `ignore/p4/rea/wp.asm` 里找 `0x14022a150` 起的汇编，逐条核对 `s`、`e`、`|e|²` 的运算顺序，注释写地址。
- 上一步位置列一定存在（`flags & 1` 时 `columnFlagsOf` 已经开列）。防御性地写成「列为 null 时跳过删除判定」，注释写明正常路径不会发生。
- 文件头的依据加上 P4c 步骤 3。

### 点 3 — 列标志（`particles/system.ts`）

- **修改** `particleColumnFlags`：
```ts
for (const module of modules) {
  const def = particleModuleDef(category, module.name);
  if (def) flags |= def.columnFlags | (def.columnFlagsOf?.(module.fields) ?? 0); // 修改：加上按字段算的部分
}
```
  `module.fields` 是解析值（没乘 `instanceoverride`），`flags` 不受覆盖影响，可以直接用。注释同步。

### 点 4 — 注释与旧单测

- **修改** `particles/controlpoints.ts` `controlPointCount` 的注释：表外模块的例子换成 P4d 的 `reducemovementnearcontrolpoint`，写明 `controlpointattract` 从步骤 3 起计入。
- **修改** 把 `controlpointattract` 当表外模块的单测（锚点 u）换成仍在表外的模块（`reducemovementnearcontrolpoint` 或 `maintaindistancetocontrolpoint`），用意不变；`controlpoints.test.ts:61` 那条改成断言 `controlpointattract` 的下标计入 `n`。
- `compile/features.ts` 不用改代码。`checkParticleFeatures` 的注释里如果有「控制点读者」或表外模块的举例，同步一下。

### 验收

**单测**（`particles/operators` 相关的测试文件，没有合适的就新增 `particles/attract.test.ts`；`compile/particles.test.ts`、`simulator.test.ts`、`controlpoints.test.ts` 按需补）：
- 模块表：正交、透视两套缺省；`flags` 缺省 2；写了 `origin`、`offset` 不报；`scale` 乘 `instanceoverride.speed`，系统 `flags` bit4 时不乘，`threshold`、`deletethreshold` 不乘；`controlpoint` 钳制（−1 得 7，9 得 7）；列标志只在 `flags` bit0 时含上一步位置（`flags 1`、`3` 有，`0`、`2` 没有）；`controlPointCount` 计入本模块的下标。
- 公式（单粒子单步，和手算比）：吸引、排斥、阈值外不动；恰在阈值上不动：挑一个 `T` 使 `f32(T·f32(1/T)) < 1`，配很大的 `scale`，写成 `<=` 时会动；`L = 0` 不产生 NaN；钳制开时 `f = L`；`scale < 0` 时不钳；blend 乘在钳制之后（钳制开、`b < 1` 时结果是 `L·b`）；用 `k` 不用 `h`（两者不同的帧）；读控制点的 current 不读 previous（控制点 1 带 `offset`、跟随指针各一组）。
- 删除：线段扫过 `C` 时删（两端离 `C` 都比阈值远）；端点在阈值内删；偏离大于阈值不删；按平方比较（偏离 10、阈值 20 删）；`|e|²` 为 NaN 时删；删的那一帧粒子仍存活（`alive` 不变、`age = life`、当帧顶点照写），下一帧判死；两遍模式每遍都判（第一遍的半段就扫过 `C` 时删）；没有 `movement` 时线段起点是出生位置。

**回放**（新增 `ignore/p4/c3/replay.test.ts`，骨架照 `c2/replay.test.ts`）：
- `p4c-attract-fps60`（帧 955–960，1 遍；956 起抓帧拖慢了帧时间，dt ≈ 0.074，所以 `k ≠ h`）和 `p4c-attract-fps10`（帧 156–161，2 遍）：10 个系统全部粒子逐个比，每帧粒子数相同。限值同步骤 1、2（含 `rcp` / `rsqrt` 的包络）。`a-flags0`、`a-default` 对出生点的抖动很敏感，靠包络覆盖；如果包络盖不住，先查是不是公式问题，再把实际情况写进结果，不要私自放宽限值。
- 编译 `p4c-attract` 的不支持项应为空。
- 另用产品代码的 `particleTrack` 跑同一组输入，输出和手写循环逐位相同。
- 旧回放在改动前后各跑一遍（改动前用 HEAD 导出的源码），输出逐字相同：`b3`、`b4`、`b6` 的拷贝，`c1` 的 `p4c-cp`，`c2` 的 `p4c-ptr`。这些系统都没有本模块，结果不该变。

**变异检查**（每处都要有用例或回放失败）：
- 不判 `threshold`；`L < threshold` 写成 `<=`；去掉 `FLT_MIN < L`；
- 用 `h` 代替 `k`；`scale` 不乘 `instanceoverride.speed`；`scale` 取绝对值；
- `flags` 缺省 0；钳制条件写成 `f < L`，或对 `f < 0` 也钳；
- blend 乘在钳制之前；blend 不乘；
- 中心加上 `offset` 或 `origin`；读控制点 previous；
- 不做删除判定；`deletethreshold` 不平方；只看端点不看线段；删除时直接 `life = 0`；
- 列标志总是带上一步位置（`particleColumnFlags` 的单测要能发现）；`controlPointCount` 不计本模块。

**语料**（`c2/corpus.test.ts` 的做法，HEAD 导出对工作区）：去掉的键应只有 `particle:operator:controlpointattract`（28 张），不新增键。干净场景 21 → 21，`3832772446` 只剩 `particle:renderer:sprite:flags`。`n` 变大以后，只被本模块引用的控制点上的指针、实例覆盖开始生效，逐个系统列出来（`c1/scan_cp.py` 的 `cp-flags-used`、`io` 两类）。

**画面哈希**（Claude 做，需要 dev 在跑，没在跑就记下没做）：10 张干净场景三档和步骤 2 的 `c2/out/hash-after.json` 相同（这些场景没有本模块）。

**真机**：不解锁场景，不需要。dev 下可以用 `kabegame-dev-scene-force-render` 强制渲染 `3812887609`（只差 `object:shape`、`particle:children`）看萤火虫躲光标，可选。

## 步骤 4 — 世界空间

> 2026-11-08 按 rea-p4c-sim 第 5 节、步骤 0 的实测和预研回放（`ignore/p4/c4/prestudy.test.ts`，结果 `out/prestudy.txt`；挡住的场景 `world_unlock.py`）写成可以直接派发的版本。直接在 `apps/wpe-scene` 里做。

### 思路

世界空间是坐标系的切换。步骤 1、2 已经把模拟侧写好了大半：
- 控制点的世界分支 `current = W·base`（控制点 0 忽略 `flags 2`）；
- 指针点的世界分支 `(X, Y, 0)`，不乘 `W`；
- 发射器在世界系统里用控制点的 3×3 旋转出生点，`origin` 不经 `W`；
- initializer 的 `M` 是控制点的 3×3。

预研把这些直接放进模拟器回放，静态对象上的世界空间系统都和 WPE 对上（差 ≤ 0.02，`vortex` 0.11）。`p4c-ptr` 里的 `p-world`（世界空间 + 跟随指针，窗口内出生的 49 个粒子）差 ≤ 0.025。本步补上剩下的四件事。

**一、WPE 先模拟粒子、后跑脚本。** 预研里 `w-stay-*` 的对象由脚本每帧平移、旋转。按「第 N 帧用第 N 帧的对象变换」回放，世界空间粒子差 2.54 像素，正好是对象一帧的位移。按「用第 N − 1 帧的」回放，差 0.016。同时两件事已经确认：
- 日志里脚本读到的 `engine.runtime` 和同一帧着色器的 `g_Time` 完全相等（929 帧都是 15.488633）；
- P3b 测过，脚本写的变换当帧就作用到图层上。

所以不是脚本时钟慢一帧，而是 WPE 在一帧里先模拟粒子，再跑脚本。粒子拿到的是本帧脚本运行之前的对象变换。我们现在的顺序相反（`beforeFrame` 跑脚本，`GpuScene.update` 里步进粒子）。本步把粒子步进挪到脚本之前。

这个顺序对本地系统同样成立：模拟用的 `W` 只在 `flags 2` 和指针点上起作用；绘制照旧用当帧（脚本之后）的对象矩阵。可见性判断也跟着用脚本之前的状态，和「先模拟」一致（没有实测）。属性改值的延迟不变：步进之前先 `sync` 一次，把两帧之间写进 `SceneState` 的属性改值推给模拟器，脚本跑完再 `sync` 一次。

**二、绘制时模型矩阵是单位阵。** WPE 绘制世界空间系统时，把模型矩阵栈顶整个换成 `ctx+0xaf0`（5.3），平时是单位阵，所以只乘 `V`、`P`。`particleUniformValues` 里和模型有关的量（`g_ModelMatrix`、`g_ModelViewProjectionMatrix` 及其逆）都从传入的 `world` 派生，世界空间系统传单位阵即可。对象之后移动、旋转，已经发出的粒子留在原地。

**三、`movement` 的 `flags` bit0。** 本地系统里，重力在用之前先变换成 `g = Mᵀ·g`（5.4），`M` 是模拟用的 `W`，含缩放、不归一化。世界系统不变换。预研里 `w-grav1-l` 差 1.7e3，就是因为这一项没做。语料里没人写这个字段，按读码实现，靠 `w-grav1-l` 回放核对。

**四、能力表放开** `particle:flags:world` 和 `movement` 的 `flags` bit0。

几个关键决定：
- **改顺序，不锁存矩阵。** 另一种做法是脚本之前把每个粒子层的 `W` 存一份，模拟时用存下的。改顺序更贴近实测到的机制，可见性也自然一致，也不用多存状态。代价是 `GpuScene.update` 不再步进粒子，调用方要显式先调 `stepParticles`：渲染器一处，dev 探针两处。
- **组合层里的世界空间系统不处理。** WPE 在组合层离屏渲染时把 `ctx+0xaf0` 临时设成当时的模型矩阵（5.3）。我们没有这条路径（`model:passthrough` 等照报）。
- **加载时的预热照旧用建场景时的 `W`。** 加载期脚本 `init` 和预热谁先谁后没有实测。
- **不解锁新场景。** 报 `particle:flags:world` 的 21 张场景各自还有 18 项以上别的不支持项。`movement` 的 `flags` 语料里 0 处。

### 现状锚点

**v. 粒子在脚本之后步进**（`render/renderer.ts`，`render`）
```ts
if (live) this.options.beforeFrame?.(frametime); // 现状：脚本先跑，写回 SceneState
// …
scene.sync(state);
scene.update({ time, frametime, /* … */ cursor: this.cursorOf(this.placement) }, state); // 现状：update 里步进粒子，读的是脚本之后的 W
scene.encode(encoder, state);
```
```ts
// render/scene.ts
update(frame: FrameInput, state?: SceneState): void {
  this.stepParticles(frame.frametime, frame.time, state, frame.cursor); // 现状：步进在 update 里
  // … 写每帧 uniform
}
```

**w. 绘制总乘对象世界矩阵**（`render/scene.ts`，`uniformValues`）
```ts
const common = {
  world: worldMatrixOf(layer.object, state.layers, worlds), // 现状：世界空间系统也乘
```

**x. `movement` 的 `flags` 只认 0**（`particles/modules.ts`）
```ts
// bit0：系统非世界空间时重力按模型矩阵转置变换，没实测
flags: int(0, zeroOnly),
```
执行上下文里也没有模拟用的 `W`（`ParticleRunContext` 只有控制点、`world` 标志和发射器的 `basis`）。

**y. 能力表报世界空间**（`compile/features.ts`）
```ts
if (flags & 1) unsupported.add("particle:flags:world");
```

### 点 1 — 帧顺序（`render/renderer.ts`、`render/scene.ts`、`dev/`）

- **修改** `GpuScene.update`：去掉开头的 `stepParticles` 调用，只写每帧 uniform。注释写明「粒子由调用方在脚本之前先 `stepParticles`」。
- **修改** `SceneRenderer.render`（都在原 `try` 里）：
```ts
const cursor = this.cursorOf(this.placement);
scene.sync(state);                                                       // 新增：两帧之间的属性改值先推给模拟器
scene.stepParticles(frametime, time % TIME_WRAP_SECONDS, state, cursor); // 新增：粒子先于脚本（P4c 步骤 4 预研）
if (live) this.options.beforeFrame?.(frametime);                         // 修改：挪到步进之后
scene.sync(state);                                                       // 不变：脚本写回
scene.update({ /* … */ cursor }, state);                                 // 修改：不再步进
```
  补画帧 `frametime` 为 0，`stepParticles` 照旧只记 `cursor` 就返回。`beforeFrame` 抛错的处理和现在一样（它原本在 `try` 外，挪进来后不能让脚本错误走 `render:frame` 退回；保持在 `try` 外也可以，前提是顺序对）。
- **修改** `dev/probe.ts`（三处 `scene.update`）、`dev/particleCorners.ts`（`scene.update` 那一处）：先 `stepParticles` 再 `update`，顺序同渲染器。探针没有脚本，结果不变。
- **修改** `stepParticles` 的注释：写明调用时机（脚本之前）和依据（预研：`w-stay-w` 本帧 2.54、上一帧 0.016，`engine.runtime` 等于 `g_Time`）。

### 点 2 — 绘制矩阵（`render/scene.ts`）

- **修改** `uniformValues`：粒子 draw 且系统 `flags & 1` 时 `world` 传单位阵，注释引 5.3（`ctx+0xaf0`）。本地系统不变。
- 对象变换改了会标脏、重写 uniform。世界空间系统重写后仍是单位阵，不用特判。
- `dev/particleCorners.ts` 如果自己用对象矩阵算四角，世界空间系统同样换成单位阵。

### 点 3 — `movement` 的 `flags` bit0（`particles/modules.ts`、`particles/operators.ts`、`particles/system.ts`）

- **修改** `ParticleRunContext` 加一项：
```ts
  /**
   * 模拟用的模型矩阵 `M` 的 3×3（列主序，同 `ControlPoint.basis`），即本帧控制点输入的 `W`（rea-p4c-sim.md 1.4：顶层系统模拟时
   * 模型矩阵栈顶就是 `W`）。`movement` 的 `flags` bit0 用（P4c 步骤 4）。
   */
  model: Float32Array;
```
  `ParticleSystem.advance` 每次从 `inputs.world` 取前三列的 xyz 写进去（预热每步同样）。
- **修改** `movement`：
```
g = gravity（已乘 instanceoverride.speed）
flags & 1 且 !world：g = Mᵀ·g   （FUN_1401f87e0：x' = (g.y·m1 + g.x·m0) + g.z·m2，y' = (g.x·m3 + g.y·m4) + g.z·m5，z' = (g.x·m6 + g.y·m7) + g.z·m8）
之后照旧 gh = g·h …
```
  派发后先到 `ignore/p4/rea/wp.asm` 核对 `0x14023fde2`–`0x14023fe31`、`FUN_1400dd7d0`（取 3×3【推】）、`FUN_1401f87e0`：矩阵确实是模型栈顶、取的是哪 9 个分量、加法顺序；变换在乘 `h` 之前；两遍模式每遍都变换。和计划不符时按汇编改，并记下来。
- **修改** 模块表 `movement.flags`：去掉 `zeroOnly`，改成 `(value & ~1) === 0`（其余位没有读者）。注释去掉「没实测」，写依据。

### 点 4 — 能力表与注释（`compile/features.ts`、`particles/`）

- **删除** `particle:flags:world` 那一行。系统 `flags` 的其它位按现状处理。
- **修改** 注释里说「世界空间属步骤 4、能力表拦住」的地方（`ParticleRunContext.world`、`emitters.ts`、`controlpoints.ts` 的世界分支、`system.ts` 文件头、`checkParticleFeatures`），改成已实现。

### 验收

**单测：**
- 帧顺序：渲染器在一帧里先步进粒子、再调 `beforeFrame`。在 `beforeFrame` 里改对象变换，这一帧模拟用的是改之前的 `W`，下一帧才用新的。能做成不起 GPU 的测试最好（假的 `GpuScene` 记录调用顺序，或者直接测 `GpuScene` 加脚本写回的组合）。属性改值（两帧之间写进 `SceneState` 的 `instanceoverride`）这一帧就进模拟器。
- 绘制：世界空间系统的 `g_ModelMatrix` 是单位阵、`g_ModelViewProjectionMatrix` 等于视图投影；本地系统不变；对象变换改了以后世界空间系统的矩阵仍是单位阵。
- `movement`：本地系统 `flags 1` 时重力是 `Mᵀ·g`（带旋转和缩放的 `W`，钉住每个分量和加法顺序）；世界系统 `flags 1` 不变换；`flags 0` 不变换；两遍模式每遍都变换。
- 模拟（补现有用例里没覆盖的）：世界系统出生点 `= mat3(W·base)·q + (W·base.t + origin)`，`origin` 不经 `W`；`velocityrandom` 乘 `mat3(W·base)`（含缩放）；已发出的粒子在 `W` 变化后不动；`vortex` 的轴在世界系统里不随对象转。
- 能力表：世界空间系统不再报；`movement` 的 `flags 1` 不报、`flags 2` 报。

**回放**（新增 `ignore/p4/c4/replay.test.ts`，骨架照 `c3/replay.test.ts`，预研的 `prestudy.test.ts` 可以参考）：
- `p4c-world-fps60`（帧 929–934，1 遍）：除 `w-ptr-w`、`w-ptr-l`（窗口之前的指针没有记录）外 13 个系统全部粒子逐个比，粒子数逐帧相同，限值和包络同前几步。`w-stay-*` 的对象变换按脚本公式逐帧算：`origin = (960 + 300·sin(0.5t), 540 + 150·sin(0.3t))`，`angles.z = 0.3t` 度；`t` 取日志的 `engine.runtime`，窗口内取轨迹的 `time`。第 N 帧给模拟器第 N − 1 帧的变换（第 1 帧给加载时的），就是渲染器新顺序下的输入。另跑一遍「第 N 帧用第 N 帧」的变体，确认它在 `w-stay-w` 上超限（钉住顺序）。
- `p4c-ptr` 三组抓帧：把 `p-world` 加进比较（只比窗口内出生的），编译不支持项应为空。
- 编译 `p4c-world` 的不支持项应为空。
- 另用产品代码的 `particleTrack` 跑静态对象的系统，输出和手写循环逐位相同。
- 旧回放在改动前后各跑一遍（改动前用 HEAD 导出的源码），输出逐字相同：`b3`、`b4`、`b6` 的拷贝，`c1` 的 `p4c-cp`，`c2` 的 `p4c-ptr`，`c3` 的 `p4c-attract`。这些系统都是本地空间、对象静态，结果不该变。

**变异检查**（每处都要有用例或回放失败）：
- 渲染器先跑脚本再步进；步进之前不 `sync`（属性改值晚一帧）；
- 世界空间系统绘制时仍乘对象矩阵；
- 发射器的 `origin` 经 `W`；旋转条件不看世界空间（只看 `controlpoint ≠ 0`）；`velocityrandom` 在世界系统里不乘 `M`；
- `movement` 的 `flags 1` 对世界系统也变换；不变换；用 `M` 而不是 `Mᵀ`；`model` 不随帧更新（只用加载时的）；
- 能力表仍报世界空间。

**语料**（`c3/corpus.test.ts` 的做法，HEAD 导出对工作区）：去掉的键应只有 `particle:flags:world`（21 张），不新增键；干净场景 21 → 21。

**画面哈希**（Claude 做，需要 dev 在跑）：10 张干净场景三档和步骤 3 的 `c3/out/hash-after.json` 相同。哈希走 dev 探针的固定时刻渲染，不经渲染器的帧循环，所以另外要在 dev 应用里确认带脚本的场景照常播放（Claude 用屏外宿主或预览看一张有脚本的干净场景，确认没有报错、画面在动）。

**真机**：不解锁场景，不需要。dev 下可以用 `kabegame-dev-scene-force-render` 强制渲染一张世界空间场景看拖尾和跟随，可选。

## 步骤 5 — 拖尾与 `sprite` 几何

> 2026-11-08 按 rea-p4c-render 第 6、7 节、步骤 0 的实测（报告「P4c 语义的实测核对」）和语料扫描（`ignore/p4/c5/step5_unlock.py`）写成可以直接派发的版本。范围：一个系统多个 renderer 继续报不支持（2026-11-08 用户定，见「关键决定」第一条）。

### 思路

拖尾和朝向都是几何，不碰模拟。模拟器已经把速度写进厚格式顶点（P4b 步骤 2），着色器也是 WPE 原件翻译的。所以本步只在三处补输入：材质宏、两组 uniform、一处「不画」的处理。

**拖尾。** `spritetrail` 进模块表（renderer 类别），字段 `length` 0.05、`maxlength` 10、`minlength` 0。它和 `sprite` 共用 `orientation`、`axis`、`flags` 三个字段的解析，但拖尾的几何不读朝向。材质变体写 `THICKFORMAT = 1`、`TRAILRENDERER = 1`，带帧表时照旧再写 `SPRITESHEET*`。绘制前写 `g_RenderVar0 = (length, maxlength, minlength, 0)`。之后着色器按 `L = max(minlength, min(|v|·length, maxlength))` 把四边形以粒子为中心、沿速度拉长，宽向是 `normalize(cross(p − eyeLocal, v))`。这些都在翻译后的着色器里，步骤 0 已经逐角核对过公式。

**朝向。** `g_OrientationForward / Right / Up` 现在写死单位基。改成每个粒子层按 7.2 在 CPU 上算：
- 输入是 `orientation`、`axis`（解析期归一化，精确零换成 `(0,1,0)`）、派生的 `t`、`flags` bit0 和绘制用的模型矩阵 `M`；
- 本地系统的 `M` 是对象世界矩阵，世界空间系统是单位阵；
- 相机的 `vf`、`vup` 在正交场景里恒为 `(0,0,−1)`、`(0,1,0)`。透视粒子的覆盖只改视图平移和投影，透视场景照报。

`M` 只在对象变换变化时变，变化会标脏、重写 uniform，所以朝向放进静态 uniform（`particleUniformValues`）就够，不用每帧算。

**NaN 不画。** WPE 里有两种情形算出 NaN、不画：
- 拖尾速度为 0，或者速度恰好平行于视线；
- `upright` 的轴平行于视线（三个朝向向量都是 NaN）。

WGSL 没有可靠的 NaN 判断（`isNan` 已从规范里删掉），`normalize(0)` 的结果各后端不同，所以都在 CPU 上处理：
- 拖尾系统写顶点时，跳过退化的粒子。判断照着色器的式子在 float32 里算，`|v|² == 0`，或 `|cross(p − eyeLocal, v)|² == 0`；`eyeLocal` 由 `g_EyePosition` 和 `M` 的逆矩阵算。
- 朝向算出 NaN 时，整个绘制跳过。

几个关键决定：
- **一个系统多个 renderer 继续报 `particle:renderers`（用户定）。** WPE 对多个 renderer 是各画一次、共用一份顶点（6.3）。语料里这样的系统一个都没有（`particle:renderers` 0 张），而支持它要把「一个粒子层一次绘制」拆成「一个系统多次绘制」：要考虑顶点布局能不能共用、每次绘制各自的 uniform、快照「每对象至多一次」的规则、四角探针按绘制输出。所以本步只支持单个 `sprite` 或单个 `spritetrail`。步骤 0 抓到的 `T8`、`T8r` 数据留着，以后做多 renderer 时用。
- **退化粒子在写顶点时跳过，不靠 GPU 丢 NaN 图元。** 单个 renderer 时顶点只给这一次绘制用，跳过最简单。以后支持多 renderer 时，拖尾那次绘制要改用自己的索引。
- **朝向算在静态 uniform 里。** 依据同上：`M` 变化时 uniform 本来就会重写。
- **`flags` 只有 bit0 有读者**，其余 7 位中性，全部放开；`orientation` 只认精确的 `"upright"`、`"fixed"`，其它字符串都是 `screen`。
- **解锁 1 张**：`3832772446`，干净场景 21 → 22。语料里 `spritetrail` 29 张、`sprite:flags` 6 张、`sprite:orientation` 2 张；`1923929928` 做完只差 `object:perspective`。

### 现状锚点

**z. renderer 只认缺省朝向，`spritetrail` 是表外模块**（`particles/modules.ts`）
```ts
// 非 `screen` 朝向（upright = 1、fixed = 2）的几何没读；`axis`、`flags` 的作用没读
orientation: { type: "string", default: "screen", supported: (value) => value === "screen" },
axis: { type: "vec3", default: "0 0 0", supported: (value) => (value as number[]).every((v) => v === 0) },
flags: int(0, zeroOnly),
```

**aa. 朝向与 `g_RenderVar0` 写死**（`render/uniforms.ts`，`particleBuiltins`）
```ts
g_OrientationUp: [0, 1, 0],
g_OrientationRight: [1, 0, 0],
g_OrientationForward: [0, 0, 1],
// …
g_RenderVar0: [0, 0, 0, 0], // 现状：拖尾的 length、maxlength、minlength 没写
```

**ab. 粒子材质的宏只看帧表**（`compile/bundle.ts`，`particleSheetDefines`）
```ts
if (!sheet) return {};
return { THICKFORMAT: "1", SPRITESHEET: "1", SPRITESHEETBLEND: …, SPRITESHEETBLENDNPOT: … };
```

**ac. 多个 renderer 报不支持**（`compile/features.ts`）
```ts
if (category === "renderer" && entries.length > 1) unsupported.add("particle:renderers");
```

**ad. 写顶点只跳过空槽**（`particles/vertices.ts`，`writeVertices`）：按槽序写存活粒子，厚格式时写速度与 frame。

### 点 1 — 模块表与解析（`particles/modules.ts`、`compile/particles.ts`）

- **新增** `particles/orientation.ts`（或并进现有文件，代理定）：
```ts
/** renderer 的朝向（`FUN_1401c22e0`，rea-p4c-render.md 7.1）：解析期一次算好。 */
export interface ParticleOrientation {
  /** 0 screen、1 upright、2 fixed：只认精确的 "upright" / "fixed"，其它都是 0。 */
  mode: 0 | 1 | 2;
  /** 归一化后的 axis；精确的 (0,0,0) 换成 (0,1,0)。 */
  axis: [number, number, number];
  /** 派生的 t（`fixed` 用）。 */
  t: [number, number, number];
  /** flags 低 8 位；只有 bit0 有读者。 */
  flags: number;
}
export function readOrientation(fields: ParticleFields): ParticleOrientation;
/**
 * `g_OrientationForward / Right / Up`（`FUN_1402298b0`，7.2）：M 是绘制用的模型矩阵（列主序 Mat4，取 3×3），vf / vup 是相机
 * 的视线与上方向。逐步 float32，运算顺序照 7.2；任一结果是 NaN 时返回 null（这次绘制不画）。
 */
export function orientationBasis(o: ParticleOrientation, model: Mat4, vf: Vec3, vup: Vec3):
  { forward: Vec3; right: Vec3; up: Vec3 } | null;
```
  - 注意记号：7.2 里 `M` 是行主序、「第 i 行 = 本地第 i 轴在世界里的向量」，等于我们列主序 `Mat4` 的第 i 列。`(0,1,0)·M` 就是我们的第 1 列。实现前对着 `ignore/p4/rea/p4c-render/orient_298b0.asm`、`orient_tail.asm` 逐条核对 `v·M`、`M·v` 的分量和加法顺序。
  - `axis` 的解析：WPE 按空格切三段、各自 `atof`。模块表现有的 `vec3` 解析对非数字分量报字段问题，比 WPE 严，保留（语料里没有这种写法）。
- **修改** 模块表 `sprite`：`orientation`、`axis`、`flags` 去掉 `supported` 限制（`flags` 取低 8 位）。注释改成依据 7.1、7.4、7.6。
- **新增** 模块表 `spritetrail`（renderer）：
```ts
{
  // rea-p4c-render.md 6.1（renderer 类型 2，分支 0x1401cfe16）：缺省 FUN_1401c0af0，正交透视一套，不钳制、不排序
  category: "renderer",
  name: "spritetrail",
  fields: {
    length: num(0.05),
    maxlength: num(10),
    // 缺省函数不补这个键，asFloat(null) 得 0
    minlength: num(0),
    // 和 sprite 共用的解析（FUN_1401c22e0），拖尾的几何不读朝向（6.4、7.7）
    orientation: …, axis: …, flags: …,
  },
  columns: [/* 同 sprite，另有速度 */],
  columnFlags: 0,
  run: null,
},
```

### 点 2 — 材质宏（`compile/bundle.ts`）

- **修改** `particleSheetDefines`，或在它旁边加一个按 renderer 的宏函数：系统唯一的 renderer 是 `spritetrail` 时写 `THICKFORMAT = 1`、`TRAILRENDERER = 1`；有帧表时照旧加 `SPRITESHEET*`。值为 0 的宏也写键，规则同现状。`sprite` 的宏不变（7.8：朝向不进宏）。
- `SceneParticle` 记下渲染用的东西：renderer 种类、`g_RenderVar0` 三个值、`ParticleOrientation`。字段名代理定。

### 点 3 — uniform（`render/uniforms.ts`、`render/scene.ts`）

- **修改** `particleBuiltins` / `particleUniformValues`：
  - 朝向按 `orientationBasis(o, world, [0,0,−1], [0,1,0])` 算，`world` 就是这次绘制的模型矩阵（世界空间系统是单位阵，步骤 4）。
  - 拖尾写 `g_RenderVar0 = (length, maxlength, minlength, 0)`，`sprite` 照旧 0。
  - 朝向是 null 时这次绘制跳过：在 `encode` 里不发 `drawIndexed`，uniform 照常写。
- 依据与记号写进注释。`vf`、`vup` 写成常量并注明「正交场景，透视场景照报」。

### 点 4 — 拖尾的退化粒子（`particles/vertices.ts`、`render/scene.ts`）

- **修改** `writeVertices`：拖尾系统跳过退化粒子，返回实际写的粒子数。参数加上判断要用的 `eyeLocal`（`(g_EyePosition, 1)` 乘绘制模型矩阵的逆，按着色器的写法），由 `GpuScene` 每次上传前给。判断照着色器的式子在 float32 里算：
```
v = 速度列；s2 = (vx² + vy²) + vz²（顺序照着色器翻译后的写法，代理核对）
d = p − eyeLocal；c = cross(d, v)
跳过：s2 == 0 或 (cx² + cy²) + cz² == 0
```
- 非拖尾系统不变。注释写明为什么不靠 GPU：NaN 判断在 WGSL 里不可靠。

### 点 5 — 能力表（`compile/features.ts`）

- `spritetrail` 进表后，`particle:renderer:spritetrail` 自然消失；`sprite` 三个字段不再报。
- `particle:renderers` 保留（用户定），注释写明 WPE 的行为（6.3）和保留的理由。
- `rope`、`ropetrail` 照报（P4d）。

### 点 6 — 四角探针（`dev/particleCorners.ts`）

- 拖尾系统退化粒子不写顶点后，探针的 `count` 和 `particles` 跟着变；朝向是 null 的层标出「不画」。确认改写成计算着色器的那段对 `TRAILRENDERER` 变体照样能跑。

### 验收

**单测：**
- 解析：
  - `spritetrail` 三个缺省值，`minlength` 不写时为 0、负值和 `minlength > maxlength` 原样存；
  - `orientation` 只认精确的 `"upright"` / `"fixed"`（`"Upright"`、`"foo"` 都是 0）；
  - `axis` 精确零换成 `(0,1,0)`、`"0 0 0.000001"` 归一化成 `(0,0,1)`；
  - `t` 的两条分支（`axis.x == axis.z == 0` 与一般情形）；
  - `flags` 只留低 8 位。
- 朝向：
  - 7.4 的表逐行算（正交、对象无旋转）；
  - 对象转 0.5 弧度时三种朝向各配 `flags` 0、1（S13 的六组）；
  - `upright` 轴 `"0 0 1"` 返回 null；`fixed` 缺省轴躺平（`Up = (0,0,−1)`）；
  - 世界空间系统用单位阵；
  - 运算顺序钉一组三个分量都非零的输入。
- 拖尾：
  - 宏（`THICKFORMAT`、`TRAILRENDERER`，带帧表时再加 `SPRITESHEET*`）；
  - `g_RenderVar0` 的值；
  - 速度为 0 的粒子不写顶点；速度平行于视线的不写；其余照写，计数对；`sprite` 系统速度为 0 也照写。
- 能力表：三个 `sprite` 字段的各种取值不报；`spritetrail` 不报；两个 renderer 仍报 `particle:renderers`。

**四角**（新增 `ignore/p4/c5/`，照 `ignore/p4/step4/corners-offline.test.ts` + `corners-offline.ts` 的离线做法：vitest 用产品代码编译工程、按日志 dt 回放到抓帧的帧、备好改写的计算着色器与 uniform / 顶点缓冲，Deno 的 WebGPU 跑出裁剪坐标，和轨迹里 WPE 的 `gs_out` 四角比）：
- `p4c-trail`（帧 921–923）：`T1`–`T5`、`T7`、`T7r`、`T9`、`T10` 逐角比，差不超过 0.01 像素。`T6`（速度 0）我们不写顶点，WPE 四角是 NaN。`T8`、`T8r`（两个 renderer）不比，编译时应只报 `particle:renderers`。
- `p4c-sprite`（帧 920–922）：24 组全部逐角比，差不超过 0.01 像素。`S7`（`upright` 轴平行视线）我们整次绘制跳过，WPE 四角是 NaN。`S8`（`fixed` 缺省轴，高度为 0）照常比四角。
- 透视粒子加拖尾（`T10`）：步骤 0 留的项，看我们用场景眼位算出的四角是否和 WPE 一致。

**回放与语料**（照 c4）：
- 旧回放（b3、b4、b6、c1 `p4c-cp`、c2 `p4c-ptr`、c3 `p4c-attract`、c4 `p4c-world`）在改动前后逐字节相同。本步不改模拟器。
- 语料：去掉的键只有 `particle:renderer:spritetrail`、`particle:renderer:sprite:flags`、`particle:renderer:sprite:orientation`（以及 `axis` 若有），不新增键；干净场景 21 → 22，新解锁 `3832772446`。

**变异检查**（每处都要有用例或四角对比失败）：
- 宏漏 `TRAILRENDERER`；`g_RenderVar0` 分量顺序错（`maxlength`、`minlength` 对调）；
- 朝向用行而不是列（`M` 转置）；`flags` bit0 的两个分支对调；`fixed` 的 bit0 分支不拷原值；`upright` 的 bit0 仍读 `axis`；
- `axis` 零向量不换成 `(0,1,0)`，或按「长度 < 0.001」换；
- `t` 的特例分支条件写错；
- 退化粒子不跳过；`sprite` 系统也跳过速度为 0 的粒子；
- 世界空间系统的朝向用对象矩阵。

**Claude 做（kabegame-dev）：**
- 真机四角：用 `projects_import` 把 `proj/p4c-trail`、`proj/p4c-sprite` 导入 dev 库，在屏外宿主里跑 `particleCorners`，和离线结果、WPE 四角比；验收后 `projects_remove` 移除。
- 画面哈希：10 张干净场景三档和步骤 4 的 `c4/out/hash-after.json` 相同；`3832772446` 另记一份基线，用 `render_scene` 看一眼画面。
- `3832772446` 和 WPE 比画面：要抓 WPE，留到收尾时一起做，或由用户在真机上看。

## P4c 收尾

和 P4a、P4b 一样，最后统一写 `cocs/wpe/WPE_SCENE.md`、changelog 和回归文档，并更新总计划的覆盖数（总计划写的是 34 张，步骤 0 用能力表重算）。

## 决定

1. `sprite` 的 `orientation`、`axis`、`flags` 纳入 P4c 步骤 5（2026-11-08 用户）。它们和 `spritetrail` 是同一个解析函数、同一段几何；语料里 `flags` 7 张、`orientation` 5 张，原先不归任何一节；纳入后 `3832772446` 能在本节解锁。
2. `controlpointattract` 的 `a-default` 长程回放超限接受（2026-11-08 用户）：单步核对已经确定公式，不改包络、不重抓。
3. 一个系统多个 renderer（如 `sprite` + `spritetrail`）在步骤 5 继续报 `particle:renderers`（2026-11-09 用户）。语料 0 张，支持它要把一个粒子层拆成多次绘制；步骤 0 的 `T8`、`T8r` 数据留给以后。

## 风险

1. **指针换算牵涉宿主。** 预览（iframe 事件）和桌面（Windows 鼠标转发）两条来源、壁纸样式和透视粒子的深度都要对，真机验收离不开用户。
2. ~~**父控制点可能拖进子系统。**~~ 步骤 0 确认：控制点 `flags` 4、8 和 `parentcontrolpoint` 只对子系统有意义，归 P4e；顶层系统上只复刻「`flags 4` 时忽略 `instanceoverride` 的控制点」。
3. **世界空间改的是坐标系。** 所有模块在世界空间下都要对，尤其是读控制点和读模型矩阵的（`movement` 的重力、`vortex` 的轴）。只靠几组确定性工程覆盖不全，要靠语料场景的统计量补。
4. **和 P4b 步骤 4–6 并行。** P4b 还在改模拟器和模块表。P4b 步骤 4、5 已提交；步骤 6（`colorn`）和步骤 1 同时进行（2026-11-08 用户），步骤 1 在快照里开发、验收后以补丁移进工作区，并避开步骤 6 要改的绑定代码（见步骤 1「本步不做」）。

## 实施记录

### 步骤 0 — 调研（2026-11-08）

两个子代理读码，Claude 设计并抓取确定性工程、独立核对。没有改产品代码。

- **读码：** [rea-p4c-sim.md](rea-p4c-sim.md)（控制点、指针、`controlpointattract`、世界空间）、[rea-p4c-render.md](rea-p4c-render.md)（`spritetrail`、`sprite` 朝向）。控制点代理中途被 API 用量上限打断一次，续跑后写完。Claude 抽查：`g_Orientation*` 的唯一写入者 `FUN_1402298b0` 开头读朝向与 `flags`（`not` 再 `and 1`），调用点正是 4 个 renderer 分支；`locktopointer` 在二进制里一次都没出现；`deletethreshold` 存在。
- **实测：** 结论写在[报告](p4-particles-REPORT.md)「P4c 语义的实测核对」，22 条全部成立，没有推翻。5 个工程、6 组抓帧，时钟图层同时记录 WPE 当帧的指针。
- **生成工程时的一处失误：** 世界空间工程用脚本旋转对象时，我按弧度写了 `angles`，WPE 脚本里图层 `angles` 是度（P3b 已记录）。核对时按度换算后全部吻合，结论不受影响；以后写脚本驱动的工程要按度。

对后续各步的影响：

- **步骤 1（控制点底座）：**
  - 控制点只有被模块引用到的才存在（`max(·, controlpoint + 1)`）；没被引用的控制点上的设置不起作用，能力表也不该报。
  - 初值是「单位阵 + `offset`」。JSON 的 `angles` 不读，`locktopointer` 不存在，`flags 16` 没有读者：这三项改成中性。
  - `instanceoverride.controlpointN` 替换平移、`controlpointangleN` 替换 3×3（Z·Y·X，弧度，CRT `cosf` / `sinf`）；指针点、`flags 4` 的点上不生效。运行时改值从基值重算，不动上一帧。
  - `flags 2`：基准点是场景坐标，本地系统乘 `inverse(W)`；世界系统里控制点 0 忽略这一位。
  - 发射器的 3×3 只在「世界空间或 `controlpoint ≠ 0`」时作用到出生点；传给 `velocityrandom`、`turbulentvelocityrandom` 的 `M` 总是控制点的 3×3。
  - 控制点 `flags 4`、`8` 和 `parentcontrolpoint` 归 P4e，顶层系统上照报，或按「忽略实例覆盖」实现。
- **步骤 2（指针）：**
  - `g_PointerPosition` 就是 WPE 的客户区归一化坐标，y 向下、不钳制，跟随点是 `inverse(P·V)` 反投影到 z = 0。铺满时 X = px·W、Y = (1 − py)·H。Kabegame 要按壁纸样式把画布指针换成场景坐标，留白和窗口外都线性外推。
  - 指针点丢弃 `offset`，3×3 是单位阵；本地系统再乘 `inverse(W)`，世界系统不乘 `W`。
- **步骤 3（`controlpointattract`）：**
  - 字段是 `scale`、`threshold`、`deletethreshold`、`flags`、`controlpoint`，加 `offset`（解析但不读）。没有 `origin`，语料里写的 `origin` 是中性的。
  - 缺省：`flags 2`（钳制开），`scale` 512 / 20，`threshold` 512 / 5，`deletethreshold` 15 / 0.5（存平方）。`scale` 乘 `instanceoverride.speed`。
  - 公式：只改速度，乘 `k`，有 blend 变体；`flags` bit0 用「上一步位置」那段线段做删除判定。
- **步骤 4（世界空间）：** 控制点是 `W·base`，粒子存世界坐标；发射器 `origin` 不经 `W`；绘制时模型矩阵是单位阵；`movement` `flags 1` 只在本地系统变换重力；`vortex` 的轴固定在世界。
- **步骤 5（拖尾与朝向）：** 公式和四角全部实测吻合。实现要显式处理 NaN（速度为 0、轴平行视线）为不画；同系统两个 renderer 画两次；朝向的三个 uniform 每个 renderer 每帧在 CPU 上算。

工具在 `ignore/p4/`：`gen_c.py`、`ana_c.py`、`ana_c2.py`、`ana_ptr.py`、`ana_c_render.py`；`rdc_track_b.py` 加了指针记录、四角读取和同系统多次绘制，对 P4b 的工程兼容。

### 步骤 1 — 控制点底座（2026-11-08）

子代理在快照 `ignore/p4/c1/ov`（`d938e75f` 的 `apps/wpe-scene/src`）里实现，Claude 独立验收。当时工作区里 P4b 步骤 6 正在进行；步骤 6 提交（`a7d12df9`）后，Claude 用补丁 `ignore/p4/c1/out/step1.patch`（19 个文件）三方合并进 `apps/wpe-scene`，见本节末「移进工作区」。

- **新增** `particles/controlpoints.ts`：`ControlPointSet`（`base` / `current` / `previous`，`update` 照 1.5 的分支，世界分支也写了，`W` 奇异写 NaN）、`controlPointCount`、`eulerBasis`、`CONTROL_POINT_FLAGS`、`IDENTITY_BASIS`、`identityControlPoints`（单测用）。
- **修改** `particles/f32.ts`：`mulBasis`（3×3 乘向量）。放这里而不放 `controlpoints.ts`，是为了避开 controlpoints → modules → emitters → controlpoints 的循环导入。
- **修改** `particles/modules.ts`：执行上下文加 `controlPoints`、`world`、`basis`；`asUInt32`、`clampControlPoint`；三个模块的 `controlpoint` 去掉 `zeroOnly`，在 `normalize` 里钳制。
- **修改** `particles/emitters.ts`、`initializers.ts`、`operators.ts`：两个发射器读控制点、按条件旋转出生点和回退方向、无条件交出 `basis`；`velocityrandom`、`turbulentvelocityrandom` 乘 `M`；`vortex` 中心加控制点平移。
- **修改** `particles/system.ts`：更新在序列帧之后、发射之前，`endFrame` 在全部 operator 之后；`prewarm(inputs)` 先更新一次再拷 `previous`；`step(dt, time, inputs)`。
- **修改** `particles/track.ts`、`render/scene.ts`：按编译期变换 / `SceneState` 沿父链算 `W` 传给模拟器，dev 探针回放用加载时的 `W`。
- **修改** `compile/particles.ts`：`SceneControlPoint`、`readControlPoints`、`controlPointOffset`，`SceneParticle.controlpoints`。
- **修改** `compile/features.ts`：删 `controlPointsUsed`、`nonZeroVector`；新增 `checkControlPoints`，键 `particle:controlpoint:pointer`；实例控制点静态值不报，`{user}` 报 `particle:instance:controlpoint:user`。
- **测试**：新增 `particles/controlpoints.test.ts`；`emission`、`simulator`、`render/particles`、`compile/particles`、`p4a5` 补用例，手写执行上下文的测试补三项新字段。

和计划不同、或计划没写、由代理按证据定的：

- **控制点 `flags`** 按 jsoncpp 取无符号整数（`FUN_140085f70`）：布尔取 1 / 0，数字取整后取低 32 位，所以 −1 是 `0xFFFFFFFF`；字符串在 WPE 里抛异常，这里取 0。
- **`offset` 的切分**照 `0x1401d061c`–`0x1401d0680` 逐字复刻：第一个分量从串首 `atof`，之后先跳过非空格、再跳过空格（只认 0x20）再 `atof`。所以 `" 5 6 7"` 是 (5, 5, 6)，`"1,2,3"` 是 (1, 0, 0)。Claude 核对过这段汇编。
- **`sphererandom` 的 `|q|²`** 判的是旋转后的 `q`，求和顺序改成汇编的 `(y² + w²) + (x² + z²)`（`0x140237f76` 起）。速度的 `|dir|²` 只进 `rsqrtps`，保留旧顺序，P4a / P4b 回放才能逐字不变。
- **`basis·q` 的加法顺序**：`boxrandom`、`FUN_140184440`、`sphererandom` 的 SIMD 写法都是 `(x·M0j + y·M1j) + z·M2j` 的交换形式，逐位等价，共用 `mulBasis`。
- **`controlpoint` 取值**：三个模块都是 `FUN_140085f70` 后 `cmp eax, 7; cmovb`（无符号，负数得 7），Claude 核对过 `sphererandom` 那处（`0x1401c5ff7`–`0x1401c600d`）。
- **能力表报指针点时排除 `0x10000`**，和 `update` 的位优先级一致。
- **`n` 只算模块表里的模块**（照计划）：只被表外模块引用的点现在算在 `n` 之外，加进模块表后自动计入。（步骤 3 更正：原先这里举的 thunderbolt `flags 2` 点不是被 `controlpointattract` 引用，而是被 P4d 的 `reducemovementnearcontrolpoint` 引用，步骤 3 之后 `n` 仍是 1。）

验收结果：

| 项 | 结果 |
|---|---|
| tsc、vitest、Prettier（快照） | tsc 0 error；43 个文件、1148 个用例全过（基线 42 个、1114 个）；改过和新增的 ts 文件格式通过 |
| `p4c-cp` 回放（fps 60，帧 924–927，11 个系统各 16 个粒子） | 全部在限内。位置差 7.9e-3–1.8e-2，`vortex-cp`（坐标到 4747）0.39；差 / 限 0.21–0.48。size、color、alpha、rot 差 0。限值主要由 `sphererandom` 归一化的 `rcpps` 包络（100 × 3.7e-4）决定，WPE 第一个粒子是 99.990、我们 100.000 |
| P4a、P4b 回放 | b3（P4a 9 个 tag、`p4b`、`p4b-emit`）和 b4（噪声）的拷贝在改动前、改动前（基线源码）、改动后三份输出逐字节相同 |
| 语料（152 个场景，改动前后都没有出错） | 去掉 `particle:controlpoint` 48 张、`particle:instance:controlpoint` 7 张；新增只有 `particle:controlpoint:pointer` 32 张，和按 JSON 推算的「被引用的点带 bit0」完全一致；`particle:instance:controlpoint:user` 0 张。干净场景 20 → 20，不解锁新场景（`1838478131` 改报 pointer，等步骤 2）。逐张解释在 `ignore/p4/c1/out/corpus-diff.txt` |
| 变异检查（代理，17 + 3 处） | 计划列的 17 处和另加的 3 处（`|q|²` 用旋转前、`turbulentvelocityrandom` 不乘 `M`、`n` 恒为 8）全部检出，结果在 `out/mutate.txt` |

Claude 独立验收：

| 项 | 结果 |
|---|---|
| 改动范围 | 快照对 `d938e75f` 只改了上面 19 个文件；`apps/wpe-scene` 没动，没有 git 写操作 |
| 读码对照 | `ControlPointSet` 的初值、实例覆盖（跳过 `0x10005`）、`update` 分支、`eulerBasis` 三列逐项，发射器的 `base`、旋转条件、回退方向、`basis` 交接，`vortex` 中心，都和 rea-p4c-sim 1.3、1.5、第 2、3 节一致 |
| tsc、vitest（快照，自跑） | 0 error；43 个文件、1148 个用例全过 |
| 变异检查（Claude 13 处，和代理的不重复，`mutate_claude.py`） | 12 处检出：欧拉角第二列 x 分量符号、`offset` 不跳过当前段、本地系统所有点都乘 `inverse(W)`、`stepParticles` 不按状态算 `W`、预热不传 `W`、钳制按有符号、能力表指针点不排除 `0x10000`、预热前不更新、`boxrandom` 的 `d` 减 `origin`、轨迹工具不算 `W`、实例角度被忽略、`{user}` 不报。`flags` 布尔取 0 那处原文出现两次（另一处是 `instanceScalar`），没跑。源码整树哈希前后一致，结果在 `out/mutate-claude.txt` |
| 三方合并预演（临时目录，对工作区当前文件） | 19 个文件里 16 个自动合入；`compile/features.ts`、`compile/particles.ts`、`particles/system.ts` 有冲突，都是和步骤 6 相邻的注释与构造函数行，手工合并 |

**移进工作区**（P4b 步骤 6 提交后，HEAD `a7d12df9`）：

`git apply --3way` 打进 `apps/wpe-scene`。16 个文件自动合入；`compile/features.ts`、`compile/particles.ts`、`particles/system.ts` 有冲突，都是和步骤 6 相邻的注释、import 与构造函数行，两边内容都保留。合并后撤下暂存区，改动只留在工作区。对照组是 `a7d12df9` 的源码导出（`ignore/p4/c1/head/src`），结果在 `out/run-merge.log`，比较脚本 `cmp_merge.py`。

| 项 | 结果 |
|---|---|
| tsc、vitest、Prettier（工作区） | 0 error；45 个文件、1188 个用例全过；19 个文件格式通过 |
| `p4c-cp` 回放 | 输出和快照上的逐字相同，全部通过 |
| P4a、P4b 回放（HEAD 对工作区） | b3、b4 的拷贝和 P4b 步骤 6 的 `p4b-color`、`p4b-colorp`、`p4b-colorp2` 三组 `colorn` 回放（`replay-b6.test.ts`），12 份输出逐字节相同，`colorn` 三组仍全部通过 |
| 语料（HEAD 对工作区） | 增减和快照上逐条相同：去掉 `particle:controlpoint` 48 张、`particle:instance:controlpoint` 7 张，新增 `particle:controlpoint:pointer` 32 张；干净场景 20 → 20 |
| 画面哈希（dev 应用，宿主按 `--mode development` 重建，入口 `index-COPBXizU.js`） | 10 张干净场景 × 三档，30 组和 P4b 步骤 6 的记录（`b6/out/hash-after.json`，入口 `index-CY0tK-L-.js`）全部相同 |

工具在 `ignore/p4/c1/`：`scan_cp.py`、`replay.test.ts`、`replay-b3.test.ts`、`replay-b4.test.ts`、`replay-b6.test.ts`、`corpus.test.ts`、`corpus_diff.py`、`mutate.py`、`mutate_claude.py`、`run_merge.sh`、`cmp_merge.py`、`vitest.config.ts`；快照 `ov/`、基线源码 `base/`、HEAD 源码 `head/`，结果在 `out/`（画面哈希 `out/hash-after.json`）。

### 步骤 2 — 指针（2026-11-08）

P4b 已收尾，本步直接在 `apps/wpe-scene` 里做。Claude 先补测、写计划，子代理实现，Claude 独立验收。

**补测**：步骤 0 的指针系统要么在抓帧前就生满了（`p4c-cp`），要么抓帧期间只出生一个（`p4c-world`），逐帧回放不了。新工程 `proj/p4c-ptr`（`gen_c.py`），8 个系统 rate 60、寿命 0.05 s。窗口 1920×1080、1920×800、1440×1080 各抓 10 帧，抓帧时用户在窗口里移动鼠标，指针每帧都变。结论写进报告「步骤 2 补测」：
- 跟随点用本帧指针。
- 窗口和场景比例不同时，WPE 把居中盖满裁切做进 `P·V`，跟随点是光标下的场景点；`g_PointerPosition` 仍是窗口坐标。
- 这一点决定了 Kabegame 的 `fill` 要按铺放反算（`sceneCursor`），而不是沿用 `g_PointerPosition`。1838478131 是 3441×2465，桌面 16:9 下正好裁切。

**改动**（`apps/wpe-scene/src`，20 个文件，新增 `render/layout.test.ts`）：
- **新增** `particles/controlpoints.ts`：`pointerScenePoint`（照 1.6 逐步 float32 反投影）；指针分支 `current = base` 后覆盖平移，本地系统乘 `inverse(W)`（和 `flags 2` 共用一次求逆），世界系统 `(X, Y, 0)`。
- **新增** `render/layout.ts`：`sceneCursor`（所有样式按铺放反算，`stretch` 原样，`tile` 取小数）；`scenePointer` 逐位不变。
- **修改** `render/uniforms.ts`：`FrameInput.cursor`。
- **修改** `render/renderer.ts`：`setPointer` 记下画布原始坐标，每帧按当前样式现算 `cursor`；`load` 按新场景尺寸算加载时的 `cursor`。
- **修改** `render/scene.ts`：`ParticleOptions.cursor`；`stepParticles` 每次调用反投影一次，交给每个系统。
- **修改** `particles/system.ts`、`particles/track.ts`（`cursors`、`size`）、`dev/probe.ts`、`dev/particleCorners.ts`。
- **删除** `compile/features.ts` 的 `checkControlPoints` 和键 `particle:controlpoint:pointer`。

和计划不同、或计划没写、由代理按证据定的：
- **`W` 奇异时只把平移写 NaN，3×3 保持单位阵。** 1.6 的指针分支只覆盖平移，3×3 来自 `base`。计划写「同 flags 2」不准确。
- **求逆没按 float32 复刻**（用现有 `invert`），回放里 y 轴最大差 6.9e-5。
- **`load` 的铺放尺寸用 `sceneTargetSize`**，和 `GpuScene.width/height`、`syncPlacement` 一致，加载时的 `cursor` 等于首帧的。
- **`GpuScene` 记下最近的 `cursor`，新建粒子系统预热时用它。** 代理原说「单图层重建时生效」，Claude 让它补用例时它自己查明粒子层现在不会单独重建（编译期没有 effect，`planParticleLayer` 不看 effect，签名不变）。这行留作防御，有用例用内部字段强制重建守着；Claude 把字段注释改准确了。
- **`particleTrack` 只给 `size` 没给 `cursors` 时是场景中心；两者都不给时是 (0, 0)**，同 `ParticleSystem` 单测的缺省。
- **`c2/replay-cp.test.ts`**（c1 p4c-cp 回放的拷贝）的不支持项断言改成按环境变量，写进 `-meta.txt`，主输出才能在 HEAD 与工作区之间逐字比较。

验收结果：

| 项 | 结果 |
|---|---|
| tsc、vitest、Prettier | 0 error；46 个文件、1211 个用例全过（改动前 45 个、1188 个）；改过和新增的文件格式通过 |
| `p4c-ptr` 回放（三组窗口，跟随的 6 个系统只比窗口内出生的粒子，`p-ref` 比全部） | 全部在限内。1920×1080 每系统 49 个，两种非等比窗口按 Kabegame 的 `fill` 反算，各 41、38 个；差 / 限 0.43–0.72，x 向的差是 `sphererandom` 归一化的 `rcpps` 抖动，y 向 ≤ 6.9e-5；size、color、alpha、rot 差 0。WPE 跟随点和我们的逐帧对上（差 ≤ 0.02）。编译 `p4c-ptr` 只报 `particle:flags:world` |
| 旧回放（HEAD 导出对工作区） | b3、b4、b6 的拷贝和 c1 的 `p4c-cp` 11 个系统，输出逐字节相同 |
| 变异检查（代理，17 处） | 计划列的 15 处和另加的 2 处全部检出，`out/mutate.txt` |
| 语料 | 只去掉 `particle:controlpoint:pointer`（32 张，和按 JSON 推算的一致），没有新增；干净场景 20 → 21，新解锁的只有 `1838478131`，`out/corpus-diff.txt` |

Claude 独立验收：

| 项 | 结果 |
|---|---|
| 改动范围 | 只有 `apps/wpe-scene/src` 和 `ignore/p4/c2/`；没有 git 写操作。工作区里 `.claude/plans/tools/` 是别的会话的 |
| 读码对照 | `pointerScenePoint` 的运算顺序、指针分支（丢 `offset`、不吃实例覆盖、本地乘 `inverse(W)`、世界不乘 `W`、位的优先级）和 rea-p4c-sim 1.6 一致；`viewProjection` 在建粒子之前赋值 |
| 「改动前」源码 | `head/src` 和 `git archive HEAD` 逐文件相同（只多一个本就不在 git 里的翻译器 wasm） |
| tsc、vitest、Prettier（自跑） | 0 error；46 个文件、1210 个用例全过，补用例、改注释后再跑 1211 个全过；格式通过 |
| `p4c-ptr` 回放（自跑） | 输出和代理的逐字相同 |
| 变异检查（Claude 8 处，和代理不重复，`mutate_claude.py`） | 7 处检出：反投影 Y 取错列、本地 `inverse(W)·F` 的 X、Y 对调、渲染器把 `g_PointerPosition` 当 `cursor`、`update` 传 `pointer` 而不是 `cursor`、加载时用旧场景的铺放、`sceneCursor` 的 v 用画布宽、重建不用最近的 `cursor`（补用例后检出，`out/mutate-claude-partial.txt`）。未检出 1 处：dev 探针回放帧的 `cursor` 固定在中心，探针没有单测，和以前一样靠用的时候核对。源码树哈希前后相同，`out/mutate-claude.txt` |
| 旧回放（自跑改后一侧，对代理的改动前输出） | 10 份逐字节相同 |
| 语料（自跑工作区，对代理的 HEAD） | 只去掉 `particle:controlpoint:pointer` 32 张，干净场景 20 → 21，新解锁 `1838478131` |
| 画面哈希（dev 应用，屏外宿主，宿主按 `--mode development` 重建，入口 `index-DzNQaqDP.js`） | 10 张干净场景 × 三档，30 组和步骤 1 的记录（`c1/out/hash-after.json`）全部相同。主窗口开着预览，没有接管，前后路由不变 |

真机（用户，2026-11-08）：`1838478131` 在预览和桌面上看过，没有问题。

工具在 `ignore/p4/c2/`：`replay.test.ts`、`replay-cp.test.ts`、`replay-b3.test.ts`、`replay-b4.test.ts`、`replay-b6.test.ts`、`corpus.test.ts`、`corpus_diff.py`、`run_old.sh`、`cmp_old.py`、`mutate.py`、`mutate_claude_gen.py`（生成 `mutate_claude.py`）、`cmp_hash.py`、`cmp_corpus_claude.py`、`pkg_extract.py`、`vitest.config.ts`；HEAD 源码 `head/src`，结果在 `out/`。补测工具在 `ignore/p4/`：`gen_c.py` 的 `p4c_ptr`、`ana_ptr2.py`，抓帧 `A:\p4b\p4c-ptr-fps60[-<尺寸>]`。

### 步骤 3 — `controlpointattract`（2026-11-08）

Claude 扫语料、写计划，子代理实现，Claude 独立验收。没有补抓：语料里没人用删除判定和 blend，现有两组抓帧够回放。

**改动**（`apps/wpe-scene/src`，7 个文件，新增 `particles/attract.test.ts`）：
- **新增** `particles/modules.ts`：模块记录 `controlpointattract`（字段、两套缺省、`flags` 缺省 2、`scale` 乘 `speed`、`controlpoint` 钳制）；`ParticleModuleDef.columnFlagsOf`。
- **新增** `particles/operators.ts`：`controlPointAttract`（普通版与 blend 版共用）、`attractDelete`、`FLT_MIN`。
- **修改** `particles/system.ts`：`particleColumnFlags` 按位或上 `columnFlagsOf(module.fields)`。
- **修改** `particles/controlpoints.ts` 注释；三处把本模块当表外例子的单测换成 `reducemovementnearcontrolpoint`。

和计划不同、或计划没写、由代理按证据定的：
- **删除判定的乘法结合**（`0x14022a150`–`0x14022a2fb`，Claude 逐条核对过）：先算 `u = r·d`，`s = ((Cz − P0z)·uz + (Cy − P0y)·uy) + (Cx − P0x)·ux`，`e = C − (s·u + P0)`。rea 4.3 按 Ghidra 写的 `((C − P0)·r)·d`、`(s·r)·d` 不对，有 1 ulp 的边界用例钉住。
- **`origin` 登记成 `vec3str`**（写成数字也不报），不是计划写的 `vec3`：WPE 根本不读这个键。
- **缺省值和 `FLT_MIN` 从 exe 读过**（`ignore/p4/c3/consts.py`）：两处比较用的常量是函数内静态，运行时从 `0x140492cd0` 拷入，四个分量都是 `0x00800000`。
- **键在而值为 null 时 WPE 读成 0**（jsoncpp `find` 认它存在）。这里照模块表的统一规则当缺键处理，语料 0 处，注释写明。
- **fps10 的日志只记到第 150 帧**（每 50 帧写一批，抓帧结束时下一批没写出），151–155 帧的 dt 按总时长平均分。

验收结果：

| 项 | 结果 |
|---|---|
| tsc、vitest、Prettier | 0 error；47 个文件、1239 个用例全过（改动前 46 个、1211 个）；改过和新增的文件格式通过 |
| `p4c-attract` 回放（fps60 帧 955–960 一遍，956 起抓帧拖慢、dt ≈ 0.074 所以 `k ≠ h`；fps10 帧 156–161 两遍） | 编译不支持项为空；两组逐帧粒子数全部相同（`a-delete` 窗口前出生的粒子已被删、窗口里新出生一个）。10 个系统里 9 个在限内，差 / 限 0.12–0.97；size、color、alpha、rot 差 0。`particleTrack` 与手写循环逐位相同。**`a-default` 两组都超出包络**：fps60 差 / 限 1.15，fps10 28.7，原因见下 |
| `a-default` 超限的排查 | 单步核对（只用 WPE 自己相邻帧的位置预测下一帧，不依赖长历史）残差 4.6e-3 / 3.8e-3，在 rcpps 量级内；不钳制的假设残差 1.7e3、1.4e3，所以公式成立。这个系统钳制后每帧速度减掉整个 `L`，近似倒数的逐值误差一路累积：fps60 那组把出生和 attract 两处 rcpps 分开取符号，四种组合包得住 WPE，现有包络让所有 rcpps 同号，漏了异号的情形；fps10 那组还叠上 151–155 帧 dt 没有记录，只改这 5 帧的分法 `a-default` 就差 ±0.06 到 ±10，定不了 |
| 旧回放（HEAD 导出对工作区） | b3、b4、b6 的拷贝，c1 的 `p4c-cp`，c2 的 `p4c-ptr`，13 对输出逐字节相同，各自全部通过 |
| 变异检查（代理，24 处） | 计划列的 20 处和另加的 4 处全部检出，`out/mutate.txt` |
| 语料 | 只去掉 `particle:operator:controlpointattract`（28 张），没有新增；干净场景 21 → 21，`3832772446` 只剩 `particle:renderer:sprite:flags`。`n` 变大后开始生效的控制点 42 处（指针 30 处、实例覆盖 12 处），所在场景都还因别的键退回，`out/corpus-diff.txt` |

Claude 独立验收：

| 项 | 结果 |
|---|---|
| 改动范围 | 只有 `apps/wpe-scene/src` 和 `ignore/p4/c3/`；没有 git 写操作。工作区里 `.claude/plans/tools/`、`scripts/kabegame-dev/` 是别的会话的 |
| 读码对照 | 执行函数和 `cpa.asm`、`cpa_blend.asm` 逐条一致；删除判定对 `wp.asm` 的 `0x14022a1c0`–`0x14022a2fb` 逐条核对，`u = r·d` 先算、`s` 两次钳制、`!(dt² < |e|²)` 时删，和实现一致 |
| 「改动前」源码 | `head/src` 和 `git archive HEAD` 逐文件相同（只多翻译器 wasm） |
| tsc、vitest、Prettier（自跑） | 0 error；47 个文件、1239 个用例全过；格式通过 |
| `p4c-attract` 回放（自跑） | 输出和代理的逐字节相同 |
| 单步核对（Claude 自写，不用代理的代码，`claude_onestep.py`，`out/claude-onestep.txt`） | 两组抓帧 10 个系统残差都在 rcpps 量级内（`a-default` 4.6e-3、`a-flags0` 0.17（坐标 4 万以上，相对 2.3e-4），其余 ≤ 1e-4）；用 `h` 代替 `k` 的对照在 `a-basic`、`a-repel`、`a-speed`、`a-blend` 上残差 1.5e-2–0.56，不钳制的对照在 `a-default` 上 1.7e3。结论和代理的诊断一致 |
| 变异检查（Claude 5 处，和代理不重复，`mutate_claude.py`） | 全部检出：删除判定去掉 `s ≥ 0` 钳制、去掉 `s ≤ L` 钳制、比较写成 `≤`、`origin` 登记成 `vec3`、中心固定读控制点 0。源码树哈希前后相同，`out/mutate-claude.txt` |
| 旧回放（自跑改后一侧，对代理的改动前输出） | 13 对逐字节相同，`out/run-old-claude.log` |
| 语料（自跑工作区，对代理的 HEAD） | 输出和代理的工作区结果逐字节相同；只去掉 `particle:operator:controlpointattract` 28 张，干净场景 21 → 21 |
| 画面哈希（dev 应用，屏外宿主，宿主按 `--mode development` 重建，入口 `index-Dv_24C0e.js`） | 10 张干净场景 × 三档，30 组和步骤 2 的记录（`c2/out/hash-after.json`）全部相同。主窗口开着预览，没有接管，前后路由不变 |

`a-default` 的长程超限用户接受（2026-11-08）：单步核对已经确定公式，不改包络、不重抓。

工具在 `ignore/p4/c3/`：`scan_attract.py`、`attract_unlock.py`、`replay.test.ts`、`diag.test.ts`、`replay-b3/b4/b6/cp/ptr.test.ts`、`run_old.sh`、`cmp_old.py`、`corpus.test.ts`、`corpus_diff.py`、`mutate.py`、`mutate_default.py`、`consts.py`、`final.sh`、`claude_onestep.py`、`mutate_claude.py`、`run_old_claude.sh`、`cmp_corpus_claude.py`、`cmp_hash.py`、`vitest.config.ts`；HEAD 源码 `head/src`，结果在 `out/`（画面哈希 `out/hash-after.json`）。

### 步骤 4 — 世界空间（2026-11-08）

Claude 先用现有抓帧做预研回放，定下「粒子先于脚本」，再写计划；子代理实现，Claude 独立验收。没有补抓。

**预研**（`ignore/p4/c4/prestudy.test.ts`，`out/prestudy.txt`）：`p4c-world` 的 `w-stay-*` 由脚本每帧平移、旋转对象。按「第 N 帧用第 N 帧的变换」回放，世界空间粒子差 2.54 像素，正好是对象一帧的位移；按「用第 N − 1 帧的」回放，差 0.016。日志里脚本读到的 `engine.runtime` 和同帧 `g_Time` 完全相等，P3b 测过脚本写的变换当帧作用到图层。所以 WPE 一帧里先模拟粒子、后跑脚本。静态对象上的世界空间系统，现有模拟侧已经对上。

**改动**（`apps/wpe-scene/src`，20 个文件）：
- **修改** `render/renderer.ts`：一帧的顺序改成 `sync` → `stepParticles` → 脚本（`beforeFrame`）→ `sync` → `update` → `encode`。前两步在一个 `try` 里，脚本仍在 `try` 外。
- **修改** `render/scene.ts`：
  - `update` 不再步进粒子；
  - `uniformValues` 对世界空间系统用单位阵作模型矩阵；
  - `stepParticles` 注释写明调用时机和预研依据。
- **修改** `dev/probe.ts` 三处、`dev/particleCorners.ts` 一处：先 `stepParticles` 再 `update`。
- **修改** `particles/`：
  - 执行上下文加 `model`（模拟用 `W` 的 3×3），`advance` 每次（含预热每步）从控制点输入的 `W` 取前三列；
  - `movement` 的 `flags` bit0：本地系统 `g = Mᵀ·g`；
  - 模块表 `movement.flags` 放开 bit0。
- **删除** `compile/features.ts` 报 `particle:flags:world` 那一行；各处「世界空间属步骤 4」的注释改成已实现。
- **测试**：`render/particles.test.ts` 加 4 条（帧顺序、`beforeFrame` 里改变换这一帧用旧 `W`、帧间属性改值当帧生效、世界空间绘制矩阵），旧的步进写法换成 `stepFrame`；`simulator.test.ts` 加 6 条（`movement` 3 条、世界空间模拟 3 条）；其余手写执行上下文补 `model`。

和计划不同、或计划没写、由代理按证据定的：
- **重力变换核对过汇编**：
  - `0x14023fde2` 测 `movement` 的 bit0，`0x14023fde9` 测系统 bit0；
  - `0x14023fdef`–`0x14023fdf9` 取模型栈顶 `*(ctx+0x30)`；
  - `FUN_1400dd7d0` 取 4×4 的 `[0..2]`、`[4..6]`、`[8..10]`（前三列 xyz，原先的【推】改为【确】）；
  - `FUN_1401f87e0` 的加法顺序和计划一致，变换在乘 `h`（`[rbp+0x2008]`）之前，在 operator 解释器里，两遍模式每遍都做。

  Claude 对过这几段。
- **`movement.flags` 的解析**是 jsoncpp 无符号整数（`0x1401cb3ce`），执行段只测 bit0，其余位没找到读者，保守报。
- **`GpuScene.update(frame, _state?)` 留了不再使用的参数**，`FrameInput.cursor` 也留着（`update` 不读），所有调用处不用改；以后可以删。
- **`hostRenderFrame` 多调一次 `stepParticles(0, …)`**，保住以前 `update` 顺带记下 cursor 的副作用。
- **c4 的 `replay-ptr.test.ts` 拷贝**把不支持项断言改成按环境变量，主输出才能在改动前后逐字节比较（同 c2 的 `replay-cp`）。

验收结果：

| 项 | 结果 |
|---|---|
| tsc、vitest、Prettier | 0 error；47 个文件、1249 个用例全过（改动前 1239 个）；格式通过 |
| `p4c-world` 回放（帧 929–934，第 N 帧用第 N − 1 帧的变换） | 编译不支持项为空；13 个系统（`w-ptr-*` 窗口前的指针没有记录，不比）各 30 个粒子，粒子数逐帧相同，差 / 限 0–0.587；`w-grav1-l` 从预研时的 1.73e3 降到 2.29e-2。「本帧变换」变体在 `w-stay-w` 上差 2.54、差 / 限 236，顺序被钉住。`particleTrack` 对照 390 个粒子逐位相同 |
| `p4c-ptr` 回放（三组窗口，加上 `p-world`） | 编译不支持项为空；`p-world` 49 / 41 / 38 个粒子，差 / 限 0.62–0.67；其余系统和步骤 2 相同 |
| 旧回放（HEAD 导出对工作区） | b3、b4、b6、c1 的 `p4c-cp`、c2 的 `p4c-ptr`、c3 的 `p4c-attract`，15 对输出逐字节相同（`p4c-attract` 两侧都有已接受的 `a-default` 超限） |
| 变异检查（代理，15 + 4 处） | 全部检出，`out/mutate.txt` |
| 语料 | 只去掉 `particle:flags:world`（21 张，34 个世界空间系统），没有新增；`movement` 的 `flags` 两侧 0 张；干净场景 21 → 21 |

Claude 独立验收：

| 项 | 结果 |
|---|---|
| 改动范围 | `apps/wpe-scene/src` 20 个文件和 `ignore/p4/c4/`；没有 git 写操作。工作区里 skills、`apps/kabegame-dev-mcp`、`scripts/`、`cocs/`、`AGENTS.md`、`deno.lock` 等的改动是别的会话的 |
| 读码对照 | 渲染器顺序、绘制矩阵、`model` 取列、`movement` 的条件与运算顺序和计划、rea 5.3 / 5.4 及汇编一致 |
| tsc、vitest、Prettier（自跑） | 0 error；47 个文件、1249 个用例全过；格式通过 |
| `p4c-world` / `p4c-ptr` 回放（自跑） | 输出和代理的逐字节相同 |
| 变异检查（Claude 4 处，和代理不重复，`mutate_claude.py`） | 绘制判断写成 `flags & 4`、`movement` 判断写成 `flags & 2`、渲染器步进时光标固定在中心，3 处检出；「预热时不更新 `model`」起初没检出（那条单测名为「预热按加载时的」，实际没钉住），Claude 在 `simulator.test.ts` 那条用例里补了预热断言（`starttime 0.1` 两步，第一个粒子速度 `Mᵀ·g·0.1`，用例数不变）后检出。源码树哈希前后相同，`out/mutate-claude.txt` |
| 旧回放（自跑改后一侧，对代理的改动前输出） | 14 对逐字节相同，`out/run-old-claude.log` |
| 语料（自跑工作区，对代理的 HEAD） | 和代理的工作区结果逐字节相同 |
| 画面哈希（kabegame-dev 任务表，屏外宿主，宿主按 `--mode development` 重建，入口 `index--c4joQgu.js`） | 10 张干净场景 × 三档，30 组和步骤 3（`c3/out/hash-after.json`）全部相同；没碰主窗口，前后路由不变 |
| 应用里的帧循环 | **没确认成**：屏外宿主里 `requestAnimationFrame` 不发（1 秒 0 次，Chromium 停发视口外 iframe 的 rAF），时钟停在第一帧，解除暂停也一样，和改动无关。帧顺序由驱动真实 `SceneRenderer.render`（假 GPU）的单测钉住。要在应用里看，得开主窗口预览 |

工具在 `ignore/p4/c4/`：`prestudy.test.ts`、`world_unlock.py`、`replay.test.ts`、`replay-b3/b4/b6/cp/ptr/attract.test.ts`、`run_old.sh`、`cmp_old.py`、`corpus.test.ts`、`corpus_diff.py`、`mutate.py`、`movement_parse.py`、`mutate_claude.py`、`run_old_claude.sh`、`cmp_corpus_claude.py`、`scripted_clean.py`、`hash_run.ts`、`cmp_hash.py`、`live_check.ts`、`live_gate.ts`、`live_unpause.ts`、`live_raf.ts`、`vitest.config.ts`；HEAD 源码 `head/src`，结果在 `out/`（画面哈希 `out/hash-after.json`）。

### 步骤 5 — 拖尾与 `sprite` 几何（2026-11-09）

子代理实现，Claude 独立验收。范围按用户定：一个系统多个 renderer 继续报 `particle:renderers`。

**改动**（`apps/wpe-scene/src`，15 个文件，其中新增 `particles/orientation.ts`、`particles/orientation.test.ts`）：
- **新增** `particles/orientation.ts`：`readOrientation`（`FUN_1401c22e0`）、`orientationVectors` / `orientationBasis`（`FUN_1402298b0`，NaN 时为 null）、正交场景的 `VIEW_FORWARD`、`VIEW_UP`。
- **修改** `particles/modules.ts`：`sprite` 三个字段放开，`flags` 取低 8 位；新增 `spritetrail`（`length` 0.05、`maxlength` 10、`minlength` 0，加共用的朝向字段）。
- **修改** `compile/particles.ts`：`SceneParticle.renderer`（种类、拖尾的 `g_RenderVar0` 三个值、朝向），取第一个表内的 renderer。
- **修改** `compile/bundle.ts`：`particleRendererDefines`（拖尾 `THICKFORMAT`、`TRAILRENDERER`，带帧表另加 `SPRITESHEET*`）、`particleTex0Format`。
- **修改** `render/uniforms.ts`：朝向按 renderer 与这次绘制的模型矩阵算；拖尾写 `g_RenderVar0 = (length, maxlength, minlength, 0)`；`PARTICLE_REFRESH_UNIFORMS`（对象变换就地刷新时重写朝向）。
- **修改** `render/scene.ts`：`particleModel`（世界空间系统单位阵）；`refreshParticleGeometry` 算 `hidden`（朝向 NaN）与拖尾眼位，建 draw 与就地刷新时都调；`hidden` 的层整次绘制跳过；拖尾眼位变了标 `stale`。
- **修改** `particles/vertices.ts`：`trailEye`、`trailDrawable`，拖尾写顶点时跳过退化粒子（速度为 0、速度平行于视线）。
- **修改** `particles/track.ts`、`dev/particleCorners.ts`：拖尾输出速度与 frame；探针多给 `drawn`。
- **修改** `compile/features.ts`：只改注释（`particle:renderers` 的 WPE 行为与保留理由）。

和计划不同、或计划没写、由代理按证据定的：
- **`TEX0FORMAT`**：计划写「`sprite` 的宏不变」。汇编里非厚格式的 `sprite` 只要朝向不是 screen，就对任何格式都写 `TEX0FORMAT`（`0x1401d3189`），照汇编做了；厚格式仍只在格式 8–11 时写。对 `genericparticle` 不影响画面。
- **朝向的就地刷新**：`refreshLayer` 原本只重写 `LAYER_UNIFORMS`，所以另加 `PARTICLE_REFRESH_UNIFORMS`，材质值照样优先。
- **汇编核对**：`v·M`、`M·v` 的分量与加法顺序（`0x14022997d`、`0x140229ac1`、`0x140229d55`）、`R' = U' × F'`（`0x140229eb1`）、归一化先 `sqrtss` 再除；screen 分支乘数向量 `0x140492e30` 是 (1,1,1,1)；解析的精确零判断（`0x1401c2759`，−0 也算零）、特例 `t = (0,0,−1)`（`0x1401c27aa`）、`flags` 只存一个字节（`0x1401c29b2`）。和 rea 7.1、7.2 一致，常量见 `ignore/p4/c5/out/consts.txt`。
- **NaN 时的 uniform** 照写原值，只跳过绘制和顶点上传。
- **没改的边界**：`renderer: []` 仍按缺省 sprite 画（WPE 不画）；`orientation` 写成非字符串照报（比 WPE 严）；`g_RenderVar0.w` 写 0（WPE 保留上一次绘制的值，`genericparticle` 不读）。

**行为变化**：朝向改成现算以后，挂在带 x / y 旋转对象上的 screen sprite 不再是写死的单位基。干净场景里只有 `shimmering_particles` 的 3 个 `small_motes_copy1` 层受影响（透视粒子，和单位基最大差 0.391，`ignore/p4/c5/out/orient-scan.txt`），它们在默认样式下不可见，画面哈希不变；`style` 改成 1 时这几层会朝向相机。步骤 0 的 S13 只有 z 旋转，这条路径（screen 朝向的 Gram-Schmidt 真正起作用）当时没对过，同日补测（见下「旋转补测」）：WPE 里 x 旋转对象上的 screen sprite 确实朝向相机，和现算一致，写死单位基是错的。

验收结果：

| 项 | 结果 |
|---|---|
| tsc、vitest、Prettier | 0 error；48 个文件、1284 个用例全过（改动前 47 个、1249 个）；格式通过 |
| 离线四角（输入取 WPE 的顶点列，Deno WebGPU 跑我们翻译的顶点着色器） | 32 个系统 × 3 帧全部吻合，最大差 1.14e-4 像素（限 0.01）；`T6` 不写顶点、`S7` 整次跳过，WPE 四角都是 NaN；`p4c-trail` 只报 `particle:renderers`（`T8`、`T8r`），`p4c-sprite` 为空 |
| 旧回放（HEAD 导出对工作区） | b3、b4、b6、c1 `p4c-cp`、c2 `p4c-ptr`、c3 `p4c-attract`、c4 `p4c-world`，18 对输出逐字节相同 |
| 语料 | 去掉 `particle:renderer:spritetrail` 29 张、`sprite:flags` 6 张、`sprite:orientation` 2 张，没有新增；干净场景 21 → 22，新解锁 `3832772446`；`1923929928` 只剩 `object:perspective` |
| 变异检查（代理，23 处） | 全部检出，`out/mutate.txt` |

Claude 独立验收：

| 项 | 结果 |
|---|---|
| 改动范围 | `apps/wpe-scene/src` 15 个文件和 `ignore/p4/c5/`；没有 git 写操作。工作区里 `.claude/plans/tools/kabegame-chromium-lib.md` 是别的会话的 |
| 读码对照 | `orientationVectors` 的三个分支、bit0 的取向、公共尾和 rea 7.2 逐行一致 |
| tsc、vitest、Prettier（自跑） | 0 error；48 个文件、1284 个用例全过；格式通过 |
| 离线四角（自跑） | 输出和代理的逐字节相同 |
| 变异检查（Claude 4 处，和代理不重复，`mutate_claude.py`） | 全部检出：`length` 缺省写成 0.5、`upright` 的叉乘次序反了、就地刷新不重算 `hidden` / 拖尾眼位、退化判断只看速度。源码树哈希前后相同 |
| 旧回放（自跑改后一侧） | 18 对和代理的改动前输出逐字节相同 |
| 语料（自跑工作区） | 和代理的工作区结果逐字节相同 |
| 画面哈希（kabegame-dev `hash_baseline`，宿主按 `--mode development` 重建，入口 `index-zvkIAUZN.js`） | 10 张干净场景 × 三档，30 组和步骤 4（`c4/out/hash-after.json`）全部相同 |
| 真机四角（kabegame-dev：`projects_import` 导入两个工程，屏外宿主里按 WPE 日志帧时间回放，dev 探针 `particleCorners` 读回真实 GPU 的四角，`live_corners.ts`） | 32 个系统 × 3 帧和 WPE 最大差 1.14e-4 像素；`T6`、`S7` 不画；之后 `projects_remove` 移除，核对没有残留行与任务 |
| `3832772446`（`render_scene`） | 能渲染，没有不支持项；画面见 `out/render-3832772446-t3.png`（`render_scene` 不步进粒子，图里没有粒子）。和 WPE 比画面留到收尾 |

**旋转补测（2026-11-09，用户要求当场做）**：新工程 `proj/p4c-rot`（`gen_c.py` 的 `p4c_rot`，17 个系统，λ 纹理，每系统一个粒子）：
- 对象绕 x、y、三轴旋转上的 `screen` sprite（`flags` 0、1），粒子自身带 x 旋转（Forward 进几何），旋转对象上的 `upright`、`fixed`（含 `flags` 1），非均匀缩放，旋转对象上的拖尾；
- 照抄 `shimmering_particles` 三个 `small_motes_copy1` 的角度、z 偏移与缩放（透视粒子）。

WPE 在用户退出后由 `wpe-renderdoc` 注入启动，工程开在 1920×1080 窗口，fps 60 抓 3 帧（`A:\p4b\p4c-rot-fps60`，19 次绘制 = 2 个图层 + 17 个系统），日志 `out/p4c-rot-fps60-log.txt`（`c5/grab_log.py` 取）；`stop --relaunch` 按字节还原 `config.json`（临时改了 `fps=60`），桌面壁纸经 `openWallpaper` 放回。

| 项 | 结果 |
|---|---|
| WPE 的四边形（`c5/rot_shape.py`） | x 旋转 0.6 的 `screen` sprite（R1、R2）是 40×40 的正方形，朝向相机；跟随对象的 `fixed`（R10）躺在旋转平面里，高宽比 0.825 = cos 0.6；P1–P3 也是朝相机的正方形。写死单位基时 R1 会像 R10 一样被压扁 |
| 离线四角（输入取 WPE 的顶点列，`corners-offline.*` 加 `KB_CORNERS_PROJECTS`，结果 `out/rot/corners.txt`） | 17 个系统 × 3 帧全部吻合，最大差 1.90e-4 像素 |
| 真机四角（kabegame-dev 导入 → 屏外宿主回放 → `particleCorners`，`live_corners.ts` 加 `KB_LIVE_PROJECTS`，结果 `out/live-corners-p4c-rot.txt`） | 17 个系统 × 3 帧全部吻合，最大差 6.87e-4 像素（含我们自己模拟的累积）；之后 `projects_remove` 移除，核对没有残留 |

所以 `shimmering_particles` 在 `style = 1` 时三层朝向相机是对的。

工具在 `ignore/p4/c5/`：`step5_unlock.py`、`consts.py`、`corners-offline.test.ts`、`corners-offline.ts`、`orient-scan.test.ts`、`replay-b3/b4/b6/cp/ptr/attract.test.ts`、`replay.test.ts`、`run_old.sh`、`cmp_old.py`、`corpus.test.ts`、`corpus_diff.py`、`mutate.py`、`mutate_claude.py`、`run_old_claude.sh`、`cmp_corpus_claude.py`、`live_corners.ts`、`vitest.config.ts`；HEAD 源码 `head/src`，结果在 `out/`（画面哈希 `out/hash-after.json`，导入清单 `out/import-manifest.json`）。
