# P4c — 控制点、世界空间与拖尾（子计划）

> 上级：[phase-4-particles.md](phase-4-particles.md)「P4c」。底座沿用 P4a、P4b（[phase-4a-base.md](phase-4a-base.md)、[phase-4b-tier2.md](phase-4b-tier2.md)），已有语义见 [p4-particles-REPORT.md](p4-particles-REPORT.md) 与 `rea-*.md`，本节新增的语义由步骤 0 写进 `rea-p4c.md` 和报告。
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

- **步骤 0 一次做完。** 和 P4b 一样：一个 REA 代理读完全部条目，写进 `rea-p4c.md`；一次 WPE 会话抓完确定性工程，后面各步只回放。
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

结果写成 `phase4/rea-p4c.md`，格式同 `rea-p4a.md`，每条标地址和证据等级。已知线索：控制点更新在 `FUN_14022e3e0`，bit0 读 `ctx+0x8c` 和 `1 − ctx+0x90`，bit2 取 `[cp+0xc4]`，bit3 在 `0x14022e6b3`，bit1、bit4 在这个函数里没读到（sample-gaps §2.8）；世界空间见 rea-p4a C3。

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
- `rea-p4c.md` 覆盖上面各项，模块都有字段表、缺省值、公式和证据等级。
- 父控制点归 P4c 还是 P4e 有结论。
- 指针换算有实测：记录的 `g_PointerPosition` 换算后和跟随指针的粒子出生位置吻合。
- 步骤 1–5 要回放的数据都已抓到。

## 步骤 1 — 控制点底座

- **新增** `particles/controlpoints.ts`：每个系统 8 个控制点，本帧和上一帧各一份。
```ts
export interface ControlPoint {
  translation: Float32Array; // 3
  basis: Float32Array; // 3×3，列主序，同 rea-p4b-modules 的 Mij 约定
}
export interface ControlPointInputs {
  /** 指针的场景坐标（步骤 2）；没有指针时为 null。 */
  pointer: [number, number, number] | null;
  /** 对象的世界矩阵（步骤 4 用）。 */
  world: Float32Array;
}
export class ControlPoints {
  constructor(def: SceneControlPoint[], instance: ParticleInstance);
  /** O1 的「控制点」一步：上一帧 ← 本帧，再按输入算本帧。 */
  update(inputs: ControlPointInputs): void;
  current(index: number): ControlPoint;
  previous(index: number): ControlPoint;
}
```
- **修改** `compile/particles.ts`：解析控制点数组（`offset`、`angles`、`flags`、`parentcontrolpoint`、`locktopointer`），按数组下标前 8 项，照 `controlPointsUsed` 注释里读到的规则。
- **修改** 模拟器：在 O1 的位置调 `update`；`sphererandom`、`boxrandom`、`vortex`、`turbulentvelocityrandom` 改用 `current(controlpoint)`，去掉「按单位阵」。
- **修改** `instanceoverride` 的 `controlpoint*`、`controlpointangle*` 走 P4a 的 `particle-instance` 绑定，就地生效，语义按步骤 0。
- **修改** 能力表：去掉 `offset`、`angles` 的内容判定和模块 `controlpoint` 的 `zeroOnly`；`particle:instance:controlpoint` 只在步骤 0 没读清的写法上报。指针相关的位留到步骤 2 才放行。

**验收：**
- `proj/p4c-cp` 里不含指针的系统回放，和 WPE 逐帧比，限值同 P4b（1e-3，坐标过 1000 时 2e-3）。
- 变异检查：控制点更新时机、角度顺序、`offset` 叠加方式、本帧 / 上一帧取错，各有测试失败。
- 语料变化逐条解释，现有画面哈希不变。

## 步骤 2 — 指针

- **修改** 控制点 `flags` bit0 与 `locktopointer`：本帧平移取指针的场景坐标，公式按步骤 0。
- **修改** `render/renderer.ts`：`setPointer` 之外再算一份场景坐标（含壁纸样式、透视粒子的深度），每帧交给各粒子系统。暂停时不转发输入，指针保持最后的值。
- **修改** 能力表：放开 `flags` bit0、`locktopointer`。

**验收：**
- `proj/p4c-cp` 的指针系统按记录的指针回放，和 WPE 逐帧比。
- `1838478131` 没有不支持项。用户在真机上看预览和桌面：粒子跟着鼠标，`fit` / `center` 样式下位置也对。
- 现有画面哈希不变。

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
2. **父控制点可能拖进子系统。** 如果 `flags` bit2 只对子系统有意义，`parentcontrolpoint` 的 2 张要等 P4e。
3. **世界空间改的是坐标系。** 所有模块在世界空间下都要对，尤其是读控制点和读模型矩阵的（`movement` 的重力、`vortex` 的轴）。只靠几组确定性工程覆盖不全，要靠语料场景的统计量补。
4. **和 P4b 步骤 4–6 并行。** P4b 还在改模拟器和模块表，P4c 的步骤 1 要等 P4b 收尾后再动手，避免同一批文件两头改。
