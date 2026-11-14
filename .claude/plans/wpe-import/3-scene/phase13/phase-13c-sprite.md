# P13c — sprite 对象（ricepod 的太阳）

总计划：[phase-13-3d-lighting.md](phase-13-3d-lighting.md)「P13c」。读码：[rea-p13-lights.md](rea-p13-lights.md) 第 4 节；实测：[p13-REPORT.md](p13-REPORT.md) 第 18 行。

## 总体设计思路

WPE 的 `sprite` 对象不是图像层，是「带遮挡测试的太阳光斑」：一块写死在相机方向 (−1, 0, 1) 上的公告板，大小由**上一帧**的遮挡查询决定——上一帧有多少像素能看见太阳中心那一小块，这一帧光斑就画多大、多亮（`k = min(512 · ((n/2) >> s) / Hs², 1)`，边长 `k`、`g_Alpha = k²`）。它不读对象自己的 `origin` / `angles` / `scale` / `parent`，视图去掉平移，所以光斑只随相机转、不随相机移，像天空盒里的太阳。每帧画两次：先用 sprite 材质画光斑本体，再用 `materials/util/occlusiontest` 画一块 0.1 单位的小方块并做遮挡查询（深度 z 写死成 1e−7，只有深度缓冲还是清屏值的像素能通过，即没有写深度的东西挡住的地方）。

我们照这个形状实现：`sprite` 成为一种新的图层（`SceneLayer.sprite`），编译期建常量网格、编两份材质（sprite 与 occlusiontest），渲染图给它一个 `sprite` op，按 `objects` 顺序和别的对象混排。uniform 每帧按当前相机现算（视图去平移、两个轴乘 `2k` 或 `0.2`、`g_Alpha = k²`）。

**难点是 n。** WebGPU 有遮挡查询，但 Chrome 在 Windows 上走的 Dawn D3D12 后端用的是 `D3D12_QUERY_TYPE_BINARY_OCCLUSION`（本机源码 `third_party/dawn/src/dawn/native/d3d12/CommandBufferD3D12.cpp:84`），只给「有没有样本通过」，没有个数；WPE 的公式要个数，部分遮挡时光斑渐隐全靠它。所以我们自己数：画到 sprite 时先结束场景 pass，开一个计数 pass，用同一块遮挡方块、同一套顶点着色器光栅化，片元着色器读场景深度纹理、按 GREATER 自己比较，通过的 `atomicAdd` 进一个存储缓冲；再接着画遮挡方块本身（WPE 只往 alpha 里写 1、不写 RGB，S3，照画）。计数缓冲拷进读回缓冲、异步映射，`k` 用「最近一次读回的结果」（WPE 用上一帧，GetData 不等待）；dev 探针回放时每帧等读回，结果确定。比较必须在 sprite 这个位置做，而不是整帧画完再做：深度是「画到 sprite 时」的深度，排在 sprite 后面的对象挡不住它（ricepod 的太阳排在最后，船体在前，所以会被船挡住）。

关键决策：
- **计数用片元原子加手工比较深度**，不用硬件遮挡查询：硬件查询在主力平台上只有布尔；也不用 CPU 估算（光栅化规则对不上，k 的渐隐段全在边缘像素上）。手工比较之所以等价：片元的 `position.z` 就是硬件深度测试比较的那个值（遮挡方块的 z 是常量 1e−7 除以 w，插值在屏幕空间线性），场景深度是 `depth32float`。
- **计数 pass 不挂深度附件**，深度作纹理读：同一张纹理不能在同一个 pass 里既作附件又被采样，所以必须拆 pass；场景深度纹理加 `TEXTURE_BINDING` 用途。
- **反射 pass 里的 sprite 照报** `reflection:planar:sprite`：WPE 在反射 pass 里也画 sprite，而且「谁先画谁做测试」会让测试落在反射图的深度上；矩阵怎么镜像读码没查清，语料里 sprite 只有 ricepod，ricepod 没有读反射图的模型。
- **拼错的 `depthtesting` / `depthwriting` 中性**：WPE 完全不读（exe 里没有这两个串），按缺省处理，即测深度。

## 现状锚点

**a. 对象类型表里没有 `sprite`**（`compile/features.ts:571`）
```ts
const OBJECT_KINDS = ["image", "model", "particle", "sound", "text", "light"] as const;
// 现状：`sprite` 键不在表里，按未知对象键报 `object:sprite`（ricepod 的对象 7）
```

**b. 拼错的深度键照报**（`compile/features.ts:1251`）
```ts
for (const [key, value] of Object.entries(pass))
  if (!SUPPORTED_PASS.has(key) && !["alphawriting", "keepaspect", "usertextures", "usertexturereference"].includes(key) && active(value))
    unsupported.add(`material:${key}`);   // 现状：ricepod `orbital_*` 的 depthtesting / depthwriting 报 material:depthtesting / depthwriting
```

**c. ricepod 现在只差这三个键**（`ignore/p13/b2/corpus-after.json`）
```json
{ "sample": "ricepod", "unsupported": ["material:depthtesting", "material:depthwriting", "object:sprite"] }
```

## 步骤 0 — 补测（WPE，先做）

工程用 kbp-tools 生成（`ignore/p13/c/gen_c.py` → `ignore/p13/proj/p13c-*`），透视场景，相机固定或按路径平移。

| # | 问题 | 做法 | 预测 |
|---|---|---|---|
| S1 | `k` 的公式（含 `s`、`Hs`） | 一个 sprite + 一个可移动的挡板模型；挡板按关键帧 / 脚本扫过太阳，`capture` 连续 5 帧，读每帧光斑绘制的 `g_ViewUp` 长度（= 2k）与遮挡方块的通过像素（我们按同一几何算） | `k = min(512 · ((n/2) >> 0) / Hs², 1)`，无 MSAA 时 `s = 0`；用的是上一帧的 n |
| S2 | 查询没就绪时 `k` 取什么 | 运行中 PrintWindow 采样（`kbp sample series`）看光斑会不会偶发消失 | 不闪：结果按上一帧；若会闪，照做「没就绪当 0」 |
| S3 | 遮挡方块往颜色里写不写白 | 读遮挡测试那次绘制的输出目标 | 写 RGB 白（主场景普通绘制写掩码 RGB） |
| S4 | 拼错的深度键 | ricepod 抓帧读 `orbital_*` 的深度状态 | 测深度（GREATER）、不写深度 |
| S5 | 对象变换无效、视图去平移 | sprite 写 `origin` / `scale`，相机平移 | 光斑位置与大小都不变 |
| S6 | 正交场景里的 sprite | 正交工程放一个 sprite | 同一套公式（视图本来就只有平移，去掉后是单位阵）；不同则照报 `object:sprite:orthographic` |

### 步骤 0 的结果（2026-11-14，已做，p13-REPORT「P13c 的实测」）

- S1 公式成立：`s = 0`，`Hs` = 后备缓冲高；half 工程的 n = 3362（几何算出），k = 0.737888，和抓帧逐位相同。
- S2 不闪：运行中采 10 s，太阳亮度恒定，查询结果总能在下一帧拿到。
- S3 **推翻推测**：遮挡方块的写掩码只有 A（写 1），RGB 不变。我们照这样建它的管线（写掩码 ALPHA）。
- S4、S5、S6 成立：拼错的键不读；对象变换无效、视图去平移；正交场景同一套公式（k = 0）。

## 点 1 — 编译期（`compile/sprite.ts` 新文件，`compile/bundle.ts`、`compile/features.ts` 接线）

- **新增** `compile/sprite.ts`：
```ts
/** sprite 对象（P13c，rea-p13-lights 第 4 节）：常量网格 + 两份材质。对象自己的变换不参与。 */
export interface SceneSprite {
  /** sprite 材质（对象 `sprite` 键）的 pass，键 `objects/<i>/sprite/passes/<k>` */
  passes: ScenePass[];
  /** `materials/util/occlusiontest.json` 的 pass，键 `objects/<i>/sprite/occlusion` */
  occlusion: ScenePass;
}
/** 4 个顶点位置都是 (−1, 0, 1)、uv 四角、索引 0,1,2, 0,2,3（WPE 常量 0x140492b60 起）。 */
export const SPRITE_VERTICES: Float32Array;
export const SPRITE_INDICES: Uint16Array;
```
- **修改** `OBJECT_KINDS` 加 `sprite`（分派顺序照 WPE 工厂：model → particle → image → **sprite** → text → light → sound，`sprite` 的值必须是字符串）；`SceneLayer` 加 `sprite?: SceneSprite`。
- **修改** 对象的 `origin` / `angles` / `scale` / `parent` 在 sprite 上中性（WPE 不读），`visible`（含父链）照常。
- **修改** `depthtesting` / `depthwriting` 进中性键（WPE 不读），按缺省规整深度状态（S4）。
- **修改** `compile/reflection.ts` 的 `reflectionKind`：sprite 返回 `"sprite"`（照报 `reflection:planar:sprite`）。
- 能力表去掉 `object:sprite`。

## 点 2 — 渲染（`render/sprite.ts` 新文件，`render/graph.ts`、`render/scene.ts` 接线）

- **新增** `render/sprite.ts`：
```ts
/** 光斑的尺寸系数：WPE `FUN_140256780`。`samples` 是遮挡方块通过的样本数，`height` 是场景目标高（WPE 的后备缓冲高）。 */
export function spriteScale(samples: number, height: number, shift = 0): number {
  const h = Math.trunc(Math.trunc(samples / 2) / 2 ** shift);
  return Math.min((h / (height * height)) * 512, 1);
}
/** 遮挡计数：计数缓冲、读回环（2–3 个 MAP_READ 缓冲）、最近一次读回的结果。 */
export class SpriteOcclusion { /* encodeCount(encoder, depthView, draw)、afterSubmit()、latest */ }
```
- **新增** 渲染图的 `sprite` op：两个 draw（光斑、遮挡方块），按 `objects` 顺序；不在半透明名单里（`transparentsorting` 下属于第一遍）。
- **新增** uniform：`g_ModelViewProjectionMatrix = P · V'`（V' 是场景视图去掉平移，`sceneCamera.view` 的第 3 列置 (0, 0, 0, 1)）、`g_ViewUp` / `g_ViewRight` 乘 `2k`（光斑）或 `0.2`（遮挡方块）、`g_Alpha = k²`；每帧按当前相机与最近的 `k` 刷新。
- **修改** `encode`：画到 sprite op 时：画光斑 → 结束场景 pass → 计数 pass（无深度附件，读场景深度纹理，GREATER，`atomicAdd`）→ 接着场景 pass（load）画遮挡方块。场景深度纹理加 `TEXTURE_BINDING`。
- **修改** dev 探针：回放的每一帧提交后等读回（`await scene.settleSprites()`），结果确定；`host.sprites()` 给 `k` 与样本数。

## 点 3 — 测试

- `spriteScale` 对 WPE 公式逐值；`Hs` 用场景目标高。
- 假设备：sprite op 的绘制顺序与 pass 拆分（光斑 → 计数 pass → 遮挡方块），计数 pass 不挂深度附件、绑深度纹理；uniform（V' 无平移、轴长 2k / 0.2、`g_Alpha`）；首帧 k = 0；读回后 k 变。
- 编译期：分派顺序（`sprite: null` 不建）、中性键、`reflection:planar:sprite`、ricepod 不再报键。

## 验收

1. tsc、本节相关的 vitest、Prettier；变异（公式取整、`2k` 写成 `k`、不去平移、计数 pass 比较方向、首帧不是 0）。
2. 语料：只去掉 ricepod 的三个键，别的场景不变。
3. 步骤 0 的确定性工程：和 WPE 整帧逐像素（遮挡前、部分遮挡、全遮挡三种状态，k 落在 0、0–1、1）。
4. ricepod 按日志逐帧回放和 WPE 比（FINAL_CHECK）；能渲染 +1。
5. 恢复测试行与 WPE 设置。

## 风险

1. **读回延迟**：我们的读回比 WPE 的「上一帧」可能晚 1–2 帧，太阳被挡住 / 露出的那几帧渐变时机不同；静止时一致。
2. **计数 pass 的开销**：每帧拆一次场景 pass、多一个小 pass；只在有 sprite 的场景。
3. **反射里的 sprite 没做**：语料 0 处，照报。

## 待定

1. **计数方式**：推荐片元原子计数 + 手工比较深度（精确，部分遮挡的渐隐和 WPE 一致）。另两种：用硬件遮挡查询（Windows 上只有布尔，k 只能是 0 或 1，部分遮挡时光斑整块跳变）；CPU 按几何估算（边缘像素对不上）。
2. **k 用哪一帧的结果**：推荐「最近一次读回的」（产品，晚 1–3 帧），探针回放每帧等读回（等于 WPE 的上一帧）。另一种是产品也每帧等读回（确定但会拖帧）。

## 实施记录（2026-11-14）

**实现**：Claude 在主工作区直接实现（执行代理用不了；按块编辑，别的会话同时在改 `render/scene.ts` 等文件）。新文件 `compile/sprite.ts`、`render/sprite.ts`；接线在 `compile/bundle.ts`（`compileSprite`）、`compile/features.ts`（对象类型、`sprite:*` 键、拼错的深度键中性、组里照报）、`compile/reflection.ts`、`compile/lights.ts`（`REVERSEDEPTH`）、`render/graph.ts`（`MeshStep.occlusion`）、`render/scene.ts`（`encodeSprite`、光斑缓冲带 STORAGE、深度带 TEXTURE_BINDING）、`render/programs.ts`（只写 alpha 的写掩码）、`render/uniforms.ts`（`UniformBlock.offsetOf`）。和上文的出入：
- **k 在 GPU 上算，不读回 CPU**（替代待定 2 的推荐）：回放链路 `replayReadback` 是同步的（十几处调用、多在别的会话的测试里），等读回要改成异步。改成每帧画光斑前跑一个计算 pass，从计数缓冲读上一帧的 n、算 k、直接写进光斑的 uniform 缓冲。产品与探针都正好用上一帧的结果（= WPE），没有延迟、回放确定，探针也不用改。`settleSprites` / 读回环都不要了。
- **sprite 编成两网格的常量模型**（`layer.model` + `layer.sprite`），复用模型的网格路径（顶点布局、管线、深度、刷新、可建判定），不另起一类 op；`encode` 的 model 分支按 `layer.sprite` 分派到 `encodeSprite`，不做视锥剔除。
- **补了 `REVERSEDEPTH`**：第一次真机比对光斑整片过亮（k 恒为 1），原因是我们从没定义这个宏，遮挡方块走了 `z = 0.999·w` 的分支、对任何深度都能通过。WPE 用反向深度、恒定义它；语料工程着色器没有用它的，WPE 自带的另外两处（体积光、级联阴影）属于 P13d / P13e。`p4f4.test.ts`、`particles.test.ts`、`lights.test.ts` 里断言完整宏表的用例补上这一项。
- 遮挡方块只写 alpha（S3），`PipelineSpec.alpha` 加 `"only"`。

**验收**（Claude）：
1. tsc 0 error（别的会话的 `puppet/player.test.ts` 除外）；本节新测 `compile/p13c.test.ts`（4）、`render/p13c-sprite.test.ts`（7），连同 p5c、p13b1/b2、features、lights、p4f4、particles 等相关测试全过；Prettier 通过。
2. 变异 11 / 11 检出（`ignore/p13/c/mutations_c.py`，快照模式，结果 `ignore/p13/c/mutate.txt`）。
3. 语料（238 个工程，`ignore/p13/c/corpus-{head,after,after2}.json`）：属于本节的只去掉 `object:sprite`（ricepod 与 5 个测试工程）、`material:depthtesting` / `depthwriting`（ricepod），ricepod 变干净；其余增减是 P11c / P12 会话的；加 `REVERSEDEPTH` 前后能力表的差全部归 P12（puppet 场景的 attachment）。
4. 确定性工程对 WPE（`render_scene` 回放 3 帧、画布 1920×1080，`kbp cmp frame --kbp-layers`）：open、half、full、moved、ortho 整帧 0 差异；moved 与 open 的像素摘要相同（S5）。
5. **按 FINAL_CHECK 走查 ricepod**：`kbp content isolate ricepod --keep 2,3,4,5,6,7,9 --instrument`（去掉粒子，`ignore/p13/proj/ricepod-iso-sun`）；WPE fps 20、后处理超高、1920×1080。第一次在开窗约 9 s 处录的 5 帧太阳不在画面里（比较 0 差但不说明问题）；按相机路径（`ignore/p13/c/sun_times.py`）找到太阳在视野里的第 3 段，开窗 110 s 后再录 5 帧（`A:\p13c\ricepod-sun-t110-fps20-1920x1080`，太阳正被船体部分挡住），`renderFrames.ts` 按日志回放（`--scripts --postprocess ultra --gap split`）：每帧 > 0 的像素 529–6288、> 2 的 0–3 个、最大 48，都是孤立的网格边像素。
6. 恢复：测试行 15056–15061 已用 `projects_remove` 移除；WPE 设置本节没改。

**没做**：预览 Rice Pod 实时看太阳（回归 RC4）；反射 pass 里的 sprite（照报）。
