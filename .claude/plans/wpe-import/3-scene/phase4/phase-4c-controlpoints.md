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

- **新增** 模块表记录 `controlpointattract`，字段、缺省值、列标志（含「上一步位置」列的条件）按步骤 0。
- 用到的控制点经步骤 1 的接口取。

**验收：**
- `proj/p4c-attract` 回放（fps 60 和 fps 10），和 WPE 逐帧比。
- 变异检查：`threshold`、负 `scale`、`h` / `k`、`origin` 各有测试失败。
- `3832772446` 只剩 `sprite` 的 `flags`（步骤 5 解锁）。

## 步骤 4 — 世界空间

- **修改** 模拟器：系统 `flags` bit0 时，出生位置、速度、控制点按步骤 0 读到的方式进世界空间；`movement` 的 `flags` bit0 一并放开。
- **修改** `render/scene.ts`：世界空间系统绘制时不乘对象世界矩阵，只乘视图投影。
- **修改** `GpuScene`：每帧把粒子层的世界矩阵交给模拟器（父链变化、脚本改对象变换都要跟上）。
- **修改** 能力表：去掉 `particle:flags:world`。

**验收：**
- `proj/p4c-world` 回放：对象移动、旋转时，世界空间系统已发出的粒子留在原地，本地空间对照组跟着走，两组都和 WPE 逐帧比。
- 变异检查：出生时不乘世界矩阵、绘制时多乘一次、速度不变换，各有测试失败。
- 语料变化逐条解释，现有画面哈希不变。

## 步骤 5 — 拖尾与 `sprite` 几何

- **新增** 模块表记录 `spritetrail`（renderer），字段和缺省值按步骤 0。
- **修改** 粒子材质的宏：拖尾写 `THICKFORMAT`、`TRAILRENDERER`，条件照 rea-p4b-render 2.4（任一 renderer 要厚格式，所有 sprite 一起走厚格式）。
- **修改** `render/uniforms.ts`：拖尾系统写 `g_RenderVar0 = (length, maxlength, minlength, ·)`。
- **修改** `sprite` 的 `orientation`、`axis`、`flags`：几何按步骤 0，能力表放开对应取值。

**验收：**
- 我们翻译的顶点路径和 WPE 的 `gs_out` 四角比（同 P4a 风险 7 的做法），拖尾的几种长度组合和 `sprite` 的三种朝向都比，差不超过 0.01 像素。
- `proj/p4c-trail`、`proj/p4c-sprite` 整帧逐像素比。
- `3832772446` 没有不支持项，真机和 WPE 比统计量。

## P4c 收尾

和 P4a、P4b 一样，最后统一写 `cocs/wpe/WPE_SCENE.md`、changelog 和回归文档，并更新总计划的覆盖数（总计划写的是 34 张，步骤 0 用能力表重算）。

## 决定

1. `sprite` 的 `orientation`、`axis`、`flags` 纳入 P4c 步骤 5（2026-11-08 用户）。它们和 `spritetrail` 是同一个解析函数、同一段几何；语料里 `flags` 7 张、`orientation` 5 张，原先不归任何一节；纳入后 `3832772446` 能在本节解锁。

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
- **`n` 只算模块表里的模块**（照计划）：只被 `controlpointattract` 引用的点（如 thunderbolt 的 `flags 2`）现在算在 `n` 之外，步骤 3 加进模块表后自动计入。

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
