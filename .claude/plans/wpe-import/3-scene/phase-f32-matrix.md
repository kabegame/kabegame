# 矩阵按 WPE 的 float32 运算顺序、图层四边形按 WPE 的对角线

> 来由：`2903412088` 走查（`phase6/phase-6b-text.md`「走查 `2903412088`」）。`e3clock-nofx2130` 只剩两处和 WPE 不同：MVP 平移差 1–3 个 ulp，图层四边形的对角线不同。两样都换成 WPE 的之后整帧 0 差异。读码见 `rea-matrix-order.md`（下文「读码 x.y」指它的节号）。
> 2026-11-14 用户定：按推荐做。实现交给子代理（Sonnet），Claude 验收。

## 总体设计思路

WPE 的矩阵运算全部是 float32 的单步运算：每个乘积舍入一次，每次加法舍入一次，没有 FMA，也没有 double 中间值。我们的 `multiply` 在 JS double 里把 4 个乘积加完才舍入一次，所以末位和 WPE 不同。这一步把 MVP 链上的每个运算换成 WPE 的写法，并逐步 `Math.fround`。WPE 有四种写法，求和顺序各不相同，要照抄：
- **glm 乘法**：`FUN_14005ecb0`，k 从 0 到 3 依次相加；
- **仿射乘法**：`FUN_1400d4200` 算 VP、MVP 用的；
- **glm::translate**；
- **对齐偏移**：只改平移列。

结构上最大的变化是**视图和投影分开存**。WPE 每次 draw 先在 V 上做视差平移，再算 `VP = P ⊗ V`、`MVP = VP ⊗ M`（⊗ 是仿射乘法）。我们现在先把 P·V 合成一个矩阵，视差再右乘 `T(o)`。这在数学上相同，舍入却不同。所以 `GpuScene` 改成存一对 `{ projection, view }`，每个 draw 现算。其余组件仍拿一个合成好的 `viewProjection`，接口不变：剔除、指针反投影、粒子模拟、组的局部正交，以及透视粒子那一份。

`multiply` 本身也改成逐步舍入。WPE 的父链、粒子、模型等 30 多处用的就是 glm 乘法，k 的顺序和我们循环里的顺序相同（读码 1.1、第 7 节），所以只需逐步舍入，不用改调用方。

四边形只改 `layerQuad` 的顶点顺序：从「左下、右下、左上、右上」改成「左上、左下、右上、右下」，仍是三角形带。按带的规则，这样排出来的两个三角形是（左上、左下、右上）和（右上、左下、右下），和 WPE 的索引 `0,2,1, 1,2,3` 在 `FUN_1401ede30` 的顶点顺序下画出的两个三角形相同，连三角形内的顶点顺序也相同（D3D 带规则：奇数三角形是 (v2, v1, v3)）。实验时用的就是这个顺序，整帧 0 差异。泛光链 WPE 画的是一个盖满屏幕的大三角形（读码 5.2），我们改成同样的 3 个顶点。

**不在这一步做**（登记为已知差异，走查碰到时再做）：
- 求逆：WPE 是 `FUN_14005f730` 的标量余子式，我们的 `invert` 运算顺序不同，只影响读 `g_*Inverse` 的着色器；
- `lookAtRH` 仍在 double 里算：正交场景没有相机对象时它退化成平移，结果精确；有相机对象或透视场景时差几个 ulp；
- `perspective: true` 图层的透视覆盖、透视粒子那份视图投影（`particleViewProjection`）：WPE 的顺序没读；
- 组的局部正交（`groupViewProjection`，里面有求逆）、合成 RT 基础 pass 的 `fill` 正交、effect 中间 pass 的单位阵：WPE 的写法另有出入（读码 2.4），这次不动。

## 现状锚点

**a. 乘法在 double 里累加**（`render/math.ts:18`）
```ts
export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + r] * b[c * 4 + k]; // 现状：double 累加，写进 Float32Array 时舍入一次
      out[c * 4 + r] = sum;
    }
  return out;
}
```

**b. 本地矩阵用矩阵连乘、对齐偏移用整块乘法**（`render/layout.ts:167`、`:283`）
```ts
const rotation = multiply(multiply(multiply(translation(x, y, z), rotationZ(az)), rotationY(ay)), rotationX(ax));
return multiply(rotation, scaling(sx, sy, sz === 0 ? 1 : sz));          // 现状：T·Rz·Ry·Rx·S 连乘
// drawMatrixOf
return ox === 0 && oy === 0 ? world : multiply(world, translation(ox, oy, 0));   // 现状：整块乘 T(offset)
```

**c. 缩放直接左乘**（`render/layout.ts:303`）
```ts
const projection = orthographic(0, general.width, 0, general.height, ORTHO_DEPTH, -ORTHO_DEPTH);
return zoom === 1 ? projection : multiply(scaling(zoom, zoom, 1), projection);   // 现状：WPE 是绕中心的三步
```

**d. 视图投影合成好再右乘视差、抖动**（`render/scene.ts:2616`、`:2654`）
```ts
return x === 0 && y === 0 ? base : multiply(base, translation(x, y, 0));                  // viewProjectionOf
this.viewProjection = still ? this.baseViewProjection : multiply(this.baseViewProjection, translation(-x, -y, 0)); // setCamera
```

**e. MVP 用 `multiply`**（`render/uniforms.ts:331`、`:464`、`:474–475`、`:610`；`render/camera.ts:293`、`:405`）
```ts
const layerMvp = multiply(viewProjection, model);                            // drawMatrices
return { modelViewProjection: multiply(projection, model), ... };            // textMatrices 画进合成 RT
const model = x === 0 && y === 0 ? world : multiply(world, translation(x, y, 0)); // textMatrices 直接上屏
const modelViewProjection = multiply(input.viewProjection, input.world);     // particleUniformValues
viewProjection: multiply(projection, view),                                   // perspectiveCamera
viewProjection: multiply(sceneViewProjection(general, zoom), view),           // orthographicCameraObjectFrame
```

**f. 视差偏移在 double 里算**（`render/parallax.ts:142`）
```ts
return [amount * dx * ((origin[0] ?? 0) - point[0]), amount * dy * ((origin[1] ?? 0) - point[1])]; // 现状：WPE 是 ((origin − P)·amount)·depth 三步 f32
```

**g. 四边形**（`render/layout.ts:82`；`render/bloom.ts:354`、`:445`）
```ts
return [ // 现状：带顺序 左下、右下、左上、右上，对角线右下–左上
  { position: [-hw, -hh, 0], texCoord: [left, bottom] },
  { position: [hw, -hh, 0], texCoord: [right, bottom] },
  { position: [-hw, hh, 0], texCoord: [left, top] },
  { position: [hw, hh, 0], texCoord: [right, top] },
];
const quad = layerQuad([2, 2], [1, 1]);   // bloom：现状画 4 顶点的带
pass.draw(4);
```

## 点 1 — WPE 的四种矩阵写法（`render/math.ts`）

- **修改** `multiply`：逐步舍入，顺序不变（= `FUN_14005ecb0`，读码 1.1）。
```ts
const f = Math.fround;

/** `a * b`（先作用 b，再作用 a）。照 WPE 的 glm 乘法（`FUN_14005ecb0`，rea-matrix-order 1.1）：k 从 0 到 3 依次相加，每个乘积、每次加法都舍入成 f32。 */
export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = f(a[r] * b[c * 4]);                       // 修改：第一项直接取乘积（保留 −0，同 WPE）
      s = f(s + f(a[4 + r] * b[c * 4 + 1]));
      s = f(s + f(a[8 + r] * b[c * 4 + 2]));
      s = f(s + f(a[12 + r] * b[c * 4 + 3]));
      out[c * 4 + r] = s;
    }
  return out;
}
```
- **新增** `mulAffine`、`translateGlm`、`alignOffset`（照抄读码第 7 节，注释写明地址）：
```ts
/**
 * WPE 算 VP、MVP 的仿射乘法（`FUN_1400d4200`，`FUN_1401e8aa0` 内联同样写法；rea-matrix-order 2.1）：`a · b`，但 b 的第 3 行
 * （内存 3、7、11、15）不读、当作 (0, 0, 0, 1)。每列 c < 3：k = 2 → 1 → 0；平移列：k = 2 → a 的平移列 → 1 → 0。逐步 f32。
 */
export function mulAffine(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 3; c++)
      out[c * 4 + r] = f(f(f(b[c * 4 + 2] * a[8 + r]) + f(b[c * 4 + 1] * a[4 + r])) + f(b[c * 4] * a[r]));
    out[12 + r] = f(f(f(f(b[14] * a[8 + r]) + a[12 + r]) + f(b[13] * a[4 + r])) + f(b[12] * a[r]));
  }
  return out;
}

/** glm::translate 的内联（zoom、视差、字形平移、画进合成 RT 的平移；rea-matrix-order 1.3）：`m · T(t)`，只改平移列，`((m0·x + m4·y) + m8·z) + m12`。 */
export function translateGlm(m: Mat4, t: readonly number[]): Mat4 {
  const out = Float32Array.from(m);
  const [x = 0, y = 0, z = 0] = t;
  for (let r = 0; r < 4; r++) out[12 + r] = f(f(f(f(m[r] * x) + f(m[4 + r] * y)) + f(m[8 + r] * z)) + m[12 + r]);
  return out;
}

/** 图像 / 文本层世界矩阵虚函数 +0x80 的对齐偏移（`FUN_1401fd3f0`、`FUN_140256e10`；rea-matrix-order 3.3）：`W · T(a)`，只改平移列的 x、y、z，`((a.x·W0 + W12) + a.y·W4) + a.z·W8`，W15 不动。 */
export function alignOffset(w: Mat4, a: readonly number[]): Mat4 {
  const out = Float32Array.from(w);
  const [x = 0, y = 0, z = 0] = a;
  for (let r = 0; r < 3; r++) out[12 + r] = f(f(f(f(x * w[r]) + w[12 + r]) + f(y * w[4 + r])) + f(z * w[8 + r]));
  return out;
}
```
- `orthographic` 不改：参数是整数或 f32 时，double 算完再舍入，和 WPE 的 f32 `divss` 逐位相同（读码第 0 节：两个 f32 做除法，double 再 `fround` 是正确舍入）。注释补一句。

## 点 2 — 本地矩阵、世界矩阵、对齐偏移（`render/layout.ts`）

- **修改** `layerLocalMatrix`：照 `FUN_1401850a0` + `FUN_1401dd630` 按元素填（读码 3.1、3.2），不再连乘。
```ts
export function layerLocalMatrix(layer: Pick<LayerTransform, "origin" | "angles" | "scale">): Mat4 {
  const f = Math.fround;
  const [x = 0, y = 0, z = 0] = layer.origin;
  const [sx = 1, sy = 1, sz = 1] = layer.scale;
  const [ax = 0, ay = 0, az = 0] = layer.angles;
  // sinf / cosf：CRT 在 double 里算、舍入一次；参数是 f32 的角度。角度为 0 时精确为 0、1
  const cz = f(Math.cos(f(az))), szn = f(Math.sin(f(az)));
  const cy = f(Math.cos(f(ay))), syn = f(Math.sin(f(ay)));
  const cx = f(Math.cos(f(ax))), sxn = f(Math.sin(f(ax)));
  // R[3k..3k+2] 是第 k 列（FUN_1401dd630，每个括号一次 f32 运算）
  const R = [
    f(cy * cz), f(cy * szn), f(-syn),
    f(f(f(syn * cz) * sxn) - f(cx * szn)), f(f(f(syn * szn) * sxn) + f(cx * cz)), f(sxn * cy),
    f(f(f(cx * cz) * syn) + f(sxn * szn)), f(f(f(cx * szn) * syn) - f(sxn * cz)), f(cx * cy),
  ];
  const scale = [sx, sy, sz === 0 ? 1 : sz];
  const m = new Float32Array(16);
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) m[c * 4 + r] = f(f(scale[c]) * R[c * 3 + r]);
  m[12] = x; m[13] = y; m[14] = z; m[15] = 1;
  return m;
}
```
  > 说明：`sz === 0` 按 1 的兜底保留（P1，WPE 没测过）。`Math.cos` 与 CRT `cosf` 在个别参数上可能差 1 ulp（读码 3.2 未确认），不在这一步处理。
- `worldMatrixOf` 不改（`multiply(base, local)` 就是 `FUN_14005ecb0(W_parent, L)`，点 1 已经逐步舍入）。
- **修改** `drawMatrixOf`：`multiply(world, translation(ox, oy, 0))` → `alignOffset(world, [ox, oy, 0])`。偏移为 0 时仍原样返回 `world`。
- **修改** `sceneViewProjection(general, zoom)`：返回投影 P，照帧函数的三步 zoom（读码 2.2）。名字和签名不变（P 和单位视图的仿射乘积就是 P），注释改成「场景投影」。
```ts
export function sceneViewProjection(general: Pick<SceneGeneral, "width" | "height">, zoom = 1): Mat4 {
  const f = Math.fround;
  const { width: w, height: h } = general;
  const p = orthographic(0, w, 0, h, ORTHO_DEPTH, -ORTHO_DEPTH);
  if (zoom === 1) return p;                       // z = 1、l = 0 时三步逐位不变（rea-matrix-order 2.2 数值核对）
  const z = f(zoom);
  const moved = translateGlm(p, [f(w * 0.5), f(h * 0.5), 0]);
  const scaled = Float32Array.from(moved);
  for (let i = 0; i < 8; i++) scaled[i] = f(moved[i] * z);   // glm::scale：第 0、1 列 ×z，第 2 列 ×1
  return translateGlm(scaled, [f(w * -0.5), f(h * -0.5), -0]);
}
```
- `layerQuad` 见点 6；`particleViewProjection`、`groupViewProjection` 不改（只是里面的 `multiply` 随点 1 逐步舍入）。

## 点 3 — 视差偏移（`render/parallax.ts`）

- **修改** `parallaxOffset`：照绘制循环 `0x14018b00c`，`((origin − P) · amount) · depth`，三步 f32（读码 2.3）。
```ts
const f = Math.fround;
return [
  f(f(f((origin[0] ?? 0) - point[0]) * amount) * dx),
  f(f(f((origin[1] ?? 0) - point[1]) * amount) * dy),
];
```
  > 说明：子代理先 grep `parallaxOffset` 的全部调用方（指针、粒子跟随等），确认都是 WPE 同一处的量；不是的话报告，不改它们。

## 点 4 — 场景相机分开存 P 与 V（`render/scene.ts`、`render/camera.ts`）

- **新增** `GpuScene` 字段：
```ts
/**
 * 本帧场景相机的投影与视图（WPE 分开存：每次 draw 先在 V 上做视差平移，再 `P ⊗ V`；rea-matrix-order 2.1、2.3）。
 * 正交、无相机对象时 V 是单位阵或抖动的 `T(−s)`（lookAt 在这种输入下正好是平移）。`viewProjection` 恒等于 `mulAffine(projection, view)`。
 */
private sceneCamera: { projection: Mat4; view: Mat4 };
```
- **修改** 建场景处（`:1932`）：`const projection = sceneViewProjection(general, this.zoom); this.sceneCamera = { projection, view: identity() };`，`viewProjection` / `baseViewProjection` 仍是 `projection`。
- **修改** `setCamera` 的正交分支（`:2654`）：
```ts
const view = still ? identity() : translation(-x, -y, 0);
this.sceneCamera = { projection: this.baseViewProjection, view };
this.viewProjection = still ? this.baseViewProjection : mulAffine(this.baseViewProjection, view);
// 透视粒子那一份照旧（multiply，随点 1 逐步舍入）
```
- **修改** `applyPerspective`、`applyCameraObject`：同时记下 `sceneCamera = { projection: frame.projection, view: frame.view }`。`OrthographicCameraFrame` **新增** `projection: Mat4`（= `sceneViewProjection(general, zoom)`）。
- **修改** `camera.ts` 两处：`multiply(projection, view)` → `mulAffine(projection, view)`（`:293`、`:405`，后者的投影存一份进 `projection`）。
- **修改** `viewProjectionOf`：
```ts
if (x === 0 && y === 0) return base;
// 场景视图投影：照 WPE 在 V 上平移再 P ⊗ V（rea-matrix-order 2.3）；透视粒子那一份没有分开的 V，照旧右乘
if (base === this.viewProjection) {
  const { projection, view } = this.sceneCamera;
  return mulAffine(projection, translateGlm(view, [x, y, 0]));
}
return multiply(base, translation(x, y, 0));
```
  > 说明：子代理核对 `viewProjectionOf` 的全部调用方传的 `base` 是不是 `this.viewProjection` 本身（同一个对象）；如果有拷贝，改成按「是不是透视那一份」判断，不要靠对象相等碰运气，并在报告里说明。

## 点 5 — MVP 与文本矩阵（`render/uniforms.ts`）

- **修改** `drawMatrices`：`const layerMvp = mulAffine(viewProjection, model);`。`effect` / `final` 的 `multiply(…, half)` 不改：每个元素只有一个非零乘积，和 WPE 的逐元素缩放逐位相同（读码 4.2）。
- **修改** `textMatrices`：
  - 画进合成 RT：`modelViewProjection: mulAffine(projection, model)`（V 是单位阵，`mulAffine(P, I) = P`）；
  - 直接上屏：`const model = x === 0 && y === 0 ? world : translateGlm(world, [x, y, 0]);`，`modelViewProjection: mulAffine(viewProjection, model)`。
- **修改** `particleUniformValues`：`const modelViewProjection = mulAffine(input.viewProjection, input.world);`（uniform 的 MVP 一律由 `FUN_1400d4200` 算，读码 2.1）。
- 注释里引用 `rea-matrix-order` 的节号；顶部「`direct`：…」那段说明补一句「MVP 是仿射乘法 `mulAffine(VP, M)`」。

## 点 6 — 四边形（`render/layout.ts`、`render/bloom.ts`）

- **修改** `layerQuad` 的顶点顺序与注释：
```ts
/**
 * 图层四边形，三角形带顺序：左上、左下、右上、右下。带的两个三角形 (左上, 左下, 右上)、(右上, 左下, 右下) 就是 WPE `FUN_1401ede30`
 * 的顶点（左上、右上、左下、右下）配索引 `0,2,1, 1,2,3` 画的两个，三角形内的顶点顺序也相同（D3D 带规则），对角线是右上–左下
 * （rea-matrix-order 5.1；`2903412088` 走查：换成这个顺序后双线性采样的边缘像素和 WPE 逐位相同）。…（其余说明保留）
 */
return [
  { position: [-hw, hh, 0], texCoord: [left, top] },
  { position: [-hw, -hh, 0], texCoord: [left, bottom] },
  { position: [hw, hh, 0], texCoord: [right, top] },
  { position: [hw, -hh, 0], texCoord: [right, bottom] },
];
```
- **新增** `layout.ts`：
```ts
/**
 * 泛光链的全屏三角形（WPE 渲染器 `R+0x58`，rea-matrix-order 5.2）：(−1, 1)、(−1, −3)、(3, 1)，UV (0, 0)、(0, 2)、(2, 0)
 * （纹理原点在左上，同我们 `layerQuad` 的 v = 0 在顶边）。画 3 个顶点、没有索引。
 */
export function fullscreenTriangle(): QuadVertex[] {
  return [
    { position: [-1, 1, 0], texCoord: [0, 0] },
    { position: [-1, -3, 0], texCoord: [0, 2] },
    { position: [3, 1, 0], texCoord: [2, 0] },
  ];
}
```
- **修改** `bloom.ts`：`layerQuad([2, 2], [1, 1])` → `fullscreenTriangle()`，`pass.draw(4)` → `pass.draw(3)`。顶点缓冲大小按顶点数算的地方一并核对。管线的拓扑保持带（3 个顶点的带就是一个三角形）。
- 其余用 `layerQuad` 的地方（`scene.ts:2345–2350`、`shapeQuad` 的退回）不改调用，只是顶点顺序变了。子代理 grep 有没有代码按下标取 `layerQuad` 的某个顶点（比如取 `[0]` 当左下）；有的话改成按位置找，并在报告里列出。

## 单测

- `render/math.test.ts`（没有就新建）：
  - `multiply`：随机 f32 矩阵 1000 组，和「每步 `fround`、k 从 0 到 3」的参考实现逐位相同；
  - `mulAffine`：和读码 2.1 伪代码逐位相同；b 的第 3 行随便填，结果不变；
  - `translateGlm`、`alignOffset`：各一组手算例子，`alignOffset` 和 `translateGlm` 在带旋转时结果不同（说明顺序有意义）；
  - **WPE 抓帧值**：对象 179、67 与画字形那一个 draw（输入见 `rea-matrix-order.md` 第 6 节），走 `layerLocalMatrix` → `alignOffset` → `sceneViewProjection` → `mulAffine` 的产品代码路径，平移分量逐位等于 WPE：179 (0.8629395961761475, 0.8874444961547852)、67 (0.8645793199539185, 0.8890844583511353)、字形 ty 0.2091503143310547。
- `render/layout.test.ts`（或现有的层级测试）：
  - `layerLocalMatrix` 角度为 0 时等于 `diag(scale)` + origin；
  - 三轴旋转时和旧的连乘结果差 ≤ 2 ulp；
  - `sceneViewProjection` zoom 1 时等于 `orthographic`，zoom 1.5 时线性项 = `f32(z)·f32(2/W)`（P5a 步骤 4 的实测）。
- `layerQuad` 的顶点顺序；`fullscreenTriangle` 覆盖 NDC [−1, 1]² 且 UV 在角上是 (0, 0)、(1, 1)。
- 已有测试：凡是对 WPE 抓帧值（fixture、`closeRelative`）的断言，**一律不许放宽**。挂了就停下来查原因并报告：说明产品算法和 WPE 不一致，或者 fixture 解读有误。只对「用 `multiply` 自己算期望值」或「按旧的顶点顺序写死」的断言改期望，并在报告里逐条列出改了哪些、为什么。

## 验证

子代理：
- 宿主 tsc 0 error：在 `apps/wpe-scene` 下跑 `node ../../node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`；
- vitest 全过：在 `/D/Codes/kabegame/apps/wpe-scene` 下（大写盘符）跑 `node ../../node_modules/vitest/vitest.mjs run`，带 `KABEGAME_WPE_ROOT`；
- Prettier。

Claude 独立验收：
1. `git status` 与 diff 只在上面列的文件（含测试）里；自跑 tsc、vitest；变异检查：
   - `mulAffine` 把 k 的顺序换成 0 → 2；
   - `alignOffset` 把 `W[12+r]` 挪到最后加；
   - `multiply` 去掉逐步 `fround`；
   - `layerQuad` 换回旧顺序。
2. `e3clock-nofx2130` 用轨迹渲染：6 个 draw 的 MVP 逐位等于 WPE；整帧对 WPE 0 差异；两层合成 RT 0 差异。
3. 用已经和 WPE 逐像素比过的确定性工程重跑，结果不能比回归文档记的差：
   - `p6b-geom` / `-align` / `-wrap` / `-fx` / `-fallback` / `-extra`、`p6b-tiny` / `-tiny2` / `-tiny3`；
   - `p5c-*` 10 个；
   - `p5b-autosize`、`p5b-nopad-v2`、`p5b-cl`、`p5b-proj`、`p5b-fs` / `-fsnofx` / `-fsmvp`、`p5b-inst` / `-inst2`；
   - P5a 视差 / 抖动 / 缩放各挑两个；
   - 泛光 `ctl-ldr`、`ctl-hdr`、`q4-n8`；P8 的对齐与形状工程。
4. `kbp regress --corpus` 看编译期是否有变化（应当没有：这一步只改渲染）。
5. 走查继续：`e3clock-nofx`（先画 2160 再裁）、`e3clock`（foliagesway）重新比，剩下的差异按原方法定位。

## 风险

1. **逐字节基线会变。** 所有以前存下来的「我们自己的」画面哈希、`kbp regress` 的粒子回放逐字节结果都会在末位变化。验收以 WPE 为准，不以旧基线为准。
2. **透视粒子与相机对象**这次只把最后一步换成仿射乘法，前面的 V、P 仍是旧算法，末位可能仍和 WPE 不同（登记）。
3. **`Math.cos` / `Math.sin` 与 CRT 的 `cosf` / `sinf`** 在个别参数上可能差 1 ulp，带旋转的图层仍可能有末位差（登记，读码 3.2 未确认）。
4. **三角形带规则**：Vulkan / Metal 后端的奇数三角形顶点顺序可能和 D3D 不同（同一个三角形、顶点轮换），只可能影响 Linux / macOS 上的插值末位。在 `layerQuad` 上标 `TODO:[WPE_SCENE] 在 macOS、Linux 上测试：…`。

## 实施记录

### 2026-11-14 实施（Sonnet 子代理）

**改动文件**：`apps/wpe-scene/src/render/` 下的 `math.ts`、`layout.ts`、`parallax.ts`、`scene.ts`、`camera.ts`、`uniforms.ts`、`bloom.ts`；新增 `math.test.ts`；改了测试 `layout.test.ts`（追加）、`hierarchy.test.ts`、`p5b-fullscreen.test.ts`、`p8.test.ts`、`render.test.ts`、`text.test.ts`、`p5d-camera.test.ts`、`zoom.test.ts`；回归文档 `versions/latest/regression.md` 文末追加一节（状态全留 `[ ]`）。

**点 1–6 都按计划目标代码实现**，没有偏离计划的算法。小处补充：
- `GpuScene.sceneCamera` 用带初值的字段声明（`{ projection: new Float32Array(16), view: identity() }`），建场景时立刻覆盖；
- `applyPerspective`、`applyCameraObject` 把 `sceneCamera` 的赋值放在「没变就返回」**之前**，保证它始终和 `viewProjection` 对得上；
- `OrthographicCameraFrame` 新增 `projection`，`orthographicCameraObjectFrame` 里先算 `projection` 再 `mulAffine(projection, view)`；
- `uniforms.ts` 里 `effect` / `final` 的 `multiply(…, half)` 与 `multiply(model, half)` 没动，按计划。

**三项 grep 核对**
1. `parallaxOffset` 的生产调用方只有 `scene.ts` 的 `viewProjectionOf`（别的都是测试：`parallax.test.ts`、`p5b*.test.ts`、`p5c-mesh.test.ts`，拿它算期望的平移）。粒子跟随等没有用它。
2. `viewProjectionOf` 的四处调用（`scene.ts` 约 2547、2563、2581、2603 行）传的 `base` 全是 `this.viewProjection` 或 `this.perspectiveViewProjection` 字段本身（同一个对象，没有拷贝），`base === this.viewProjection` 判断可靠；两个字段在任何路径下都不是同一个对象。
3. 按下标取 `layerQuad` 顶点的代码：生产代码没有。测试里有三处按下标：`render.test.ts`（解构 `[bl, , , tr]`）、`render.test.ts` 的顶点布局 `data[21 + 3]`、`p8.test.ts` 的 `alignQuad(...)[3]` 两处；已改成按新顺序取（见下）。`hierarchy.test.ts`、`p5d-depth.test.ts` 的绕序测试对顶点顺序不敏感，没动。

**新增测试**
- `math.test.ts`（新）：`multiply` 随机 1000 组逐位等于逐步 fround 参考实现，且和 double 累加确有末位差；`mulAffine` 1000 组逐位等于读码 2.1 伪代码、右乘数第 3 行任意不变、单位 V 时等于 P；`translateGlm`、`alignOffset` 手算例子与带旋转时二者不同；WPE 抓帧值三条（对象 179、67 的 MVP 平移、字形 draw 的 ty）走 `layerLocalMatrix` → `drawMatrixOf`（对齐偏移）→ `sceneViewProjection` → `mulAffine` 逐位等于 WPE。
- `layout.test.ts`（追加）：`layerLocalMatrix` 零角度等于 diag(scale) + origin、`scale.z = 0` 按 1、三轴旋转和旧连乘差 ≤ 2 ulp；`sceneViewProjection` zoom 1 等于 `orthographic`、zoom 1.5 线性项等于 WPE 实测 0.0015625001396983862 / 0.00277777761220932。
- `render.test.ts`：`fullscreenTriangle` 顶点、覆盖 NDC [−1, 1]²、UV 线性。`layerQuad` 的顺序测试在原有用例里改了期望（见下）。

**改了期望的已有测试**（全部是「用我们自己的 multiply / 旧顶点顺序写死」的期望，没有一处是 WPE 抓帧值，没有放宽任何 WPE 断言的容差）
- `hierarchy.test.ts`「angles 的 x、y 为 0 时与旧矩阵逐位相同」：期望是我们自己旧的连乘。WPE 的 `R[2] = −sin(ay)` 在 ay = 0 时是 −0，现在也是 −0，比较前统一 `+ 0`；z 轴角度不为 0 的用例（π/2 等）角度先取 f32 再算 sin / cos，和旧 double 算法差 1e-7 量级，改成 1e-6 容差；z 轴角度为 0 的仍逐位。
- `p5b-fullscreen.test.ts` 的 `NDC_QUAD`（5 个用例共用）：按旧顶点顺序写死，改成新顺序。
- `p8.test.ts`：`screenQuadSize` 用例与 `QUAD_101` 按旧顺序写死，改新顺序；两处 `alignQuad(...)[3]`（取右上角）改下标 2。
- `render.test.ts`：「四边形：三角形带顺序」、eagleflag 用例的 UV 内缩列表与解构下标、顶点布局用例的 `data[21 + 3]`（改 `data[42 + 3]`），都是按旧顶点顺序写死。
- `text.test.ts`：直接上屏的世界矩阵 `[...world]` 对 `multiply(translation…)` 的期望统一 `+ 0`（世界矩阵里现在有 −0）；小文字用例上屏四边形顶点顺序改新顺序。
- `p5d-camera.test.ts`：朝向向量 `[0, 0, 1, 0, 1, 0]` 里出现 −0（矩阵里有 −0 带来），`toEqual` 区分 ±0，统一 `+ 0` 后比较；数值没变。注释原文「p5d-ptc 的读数」只指数值，没有 −0 的依据。
- `zoom.test.ts`：平移项 `m[12]`、`m[13]` 原来断言 `=== −f32(zoom)`，这一项**不在** WPE 实测读数里（`MEASURED` 只有 `m00`、`m11` 与透视粒子的几项），是写测试时的推导。照 WPE 三步 f32 写后得 −1.5000001192092896（zoom 1.5）、−0.8000000715255737（zoom 0.8），和 −f32(zoom) 差 1 ulp，改成绝对误差 < 1e-6。同一用例里的线性项 `m[0]`、`m[5]` 仍 `toBe` WPE 实测值，通过（可作为三步顺序正确的旁证）。**这一条用户验收时请留意**：它是唯一一个「期望里有 WPE 相关推导」的改动，但不是抓帧原值。

**验证**
- 改动前基线：vitest 130 个文件、3080 个用例全过（304 s）。
- 改动后：`tsc --noEmit` 0 error；vitest 131 个文件、3099 个用例全过（新增 19 个）；Prettier 通过。
- 没有 WPE 抓帧类断言失败。

**未做 / 已知**
- 没做点 6 之外的「不改」项（`invert`、`lookAtRH`、`particleViewProjection`、`groupViewProjection`、`fill` 与 effect 中间 pass 的矩阵）。
- 独立验收清单里的真机项（走查工程 MVP 逐位、整帧 0 差异、各确定性工程对 WPE）没有做，按约定由验收的人在 dev 里跑。
- `layerQuad` 上已标 `TODO:[WPE_SCENE] 在 macOS、Linux 上测试：…`（风险 4）。

### 2026-11-14 验收（Claude）

- **范围**：子代理只改了计划列的文件。`scene.ts`、`p8.test.ts` 里另有别的会话的 P8 步骤 5（A2C、`writeState.ts`）改动，与本步无关，提交时只取本步的块。
- **自跑**：tsc 0 error；vitest 131 个文件、3135 个用例全过，含别的会话新增的用例。
- **变异检查**（`scratchpad\f32\mutate.mjs`，跑完按原字节还原）：下面 6 个变异都被测试抓到：
  - `mulAffine` 的 k 顺序改成 0 → 2；
  - `mulAffine` 的平移最后加；
  - `alignOffset` 的 `W12` 挪到最后加；
  - `multiply` 不逐步 `fround`；
  - `layerQuad` 换回旧顺序；
  - zoom 平移项退回 `−f32(z)`。
- **zoom 平移项按 WPE 抓帧核对**：`A:\p5a\zoom15\zoom15-frame102.rdc` 事件 18（FR 图层，origin (1820, 40)，zoom 1.5）的 MVP 平移是 (1.3437501192092896, −1.3888888359069824)。
  - 照三步 f32 算出的 P12 = −1.5000001、P13 = −1.4999999（两个方向舍入方向相反），代入后逐位相等；
  - 旧的 `−f32(zoom)` 在 x 方向差 1 ulp。
  - `zoom.test.ts` 补了这一条逐位用例。子代理改成的 1e-6 容差那条仍保留，作为两个档位的粗检。
- **走查工程**：`e3clock-nofx2130` 重建宿主后带轨迹渲染。
  - 6 个 draw 的 MVP 逐位等于 WPE；
  - 整帧对 WPE 第 240、241 帧 0 差异；
  - 两层合成 RT 对 WPE 事件 59、117 0 差异。
- **宿主产物被覆盖**：重建后别的会话从它自己的源码树又构建了一次（没有本步、也没有 P8 步骤 5 的代码），第一次渲染因入口脚本被删而失败。这一步的产物用泛光三角形的字面量 `position:[-1,-3,0]` 认。
- **确定性工程对 WPE 的回归**：子代理（Sonnet）重跑，Claude 复核，结果见 `ignore/f32-regress/RESULTS.md`。
  - p6b 9 个、p5c 10 个、p5a 6 个都是 0 差异；
  - p5b 9 个里 `nopad-v2` 从 1845 降到 0，`cl` 从 32 降到 0，`fs` 最大差仍是 1；
  - P8：`align` 最大差 1 降到 0，`shape` / `shape2` / `align2` F1 / `alpha` X 组同以前；
  - `p8-dep2` 子代理用外推时刻比出 B10、B11 两块差 3。这两块的颜色是 `frac(g_Time)`，Claude 按抓帧读出的 `g_Time` 7.935568809509277 重渲后 0 差异，不是回归。
  - **没有一个工程比以前差。**
- **没验到的**：
  - P5d 的相机对象与透视；
  - 带粒子的确定性工程、`kbp regress --corpus`；
  - macOS / Linux。

### 2026-11-14 泛光补测（Claude，提交 `c482182b` 之后）

- **抓帧**：WPE 后处理档位由用户切到 `ultra`，1920×1080 窗口重抓 `ctl-ldr`、`ctl-hdr`、`q4-n8`、`q4-n3`，存在 `A:p3c32-bloom`。抓帧里 WPE 的泛光 pass 都是 3 个索引，即一个三角形，和读码 5.2 一致。
- **LDR**：`ctl-ldr` 的上屏帧（R8G8B8A8）对我们 `render_scene`（`ultra`、画布 1920×1080）整帧 0 差异，同以前。
- **HDR**：交换链是 `R16G16B16A16_FLOAT`，抓帧里存的不是屏幕上的 8 位值，改用 `kbp sample grab`（PrintWindow）截窗口。
  - 比较时排除左上 600×128。那里是 RenderDoc 的叠加层，抓过帧后它会多出几行，比平时大。
  - `ctl-hdr`：最大差 1，平均 0.0056，D28 记的是 0.025；
  - `q4-n8`：最大差 1，平均 0.0023，D28 记的是 0.028；
  - `q4-n3`：只有 60 个像素差 1，D28 记的平均是 0.001。
- 图与脚本在 `ignore/f32-regress/bloom/`。测试行已移除。WPE 的档位仍是用户切的 `ultra`，没有动。
