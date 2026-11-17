# P13g — 屏幕空间反射（反射开时的 mip 帧缓冲）

总计划：[phase-13-3d-lighting.md](phase-13-3d-lighting.md)「P13g」与「实施记录 / 步骤 0」的「P13g 同 P13b 拆两步」。读码：[rea-p13-passes.md](rea-p13-passes.md) 第 4 节（`_rt_MipMappedFrameBuffer`）、第 5 节（一帧的顺序）；实测：[p13-REPORT.md](p13-REPORT.md) 第 14 条、P13b1 的 R7。「反射关」那一半已随 P13b1 做完（[phase-13b1-reflection-off.md](phase-13b1-reflection-off.md)〔g1〕）。

## 总体设计思路

WPE 的「反射」设置同时管平面反射和屏幕空间反射。屏幕空间反射就是一张带 mip 的帧缓冲 `_rt_MipMappedFrameBuffer`：设置关时它只在加载时清成 (0, 0, 0, 1)，之后不动（P13b1 已照做）；设置开时每帧在主 pass 全部画完之后、泛光之前，把后备缓冲拷进它的 0 级，再 `GenerateMips` 生成其余各级。主 pass 里读它的对象（`generic4` 等的 `REFLECTION` 分支：`texSample2DLod(g_Texture3, 偏移后的屏幕 UV, roughness · g_Texture3MipMapInfo)`）拿到的是**上一帧**的场景（泛光前）。所以这一节只多两件事：每帧一次拷贝，加一串逐级缩小的 pass。不用新的视图，也不碰绘制循环。

我们照这个形状接：RT 本身、mip 级数公式、`g_Texture<n>MipMapInfo` 都是 P13b1 的，不变。编译期 bundle 记下「反射开」，渲染器建 RT 时据此多给 `COPY_DST`、不做加载时的清屏。`GpuScene.encode` 在顶层对象（含体积光合成）画完、泛光快照之前，把场景目标 `copyTextureToTexture` 进 0 级，再逐级各开一个 render pass，用全屏三角形从上一级采样写下一级。读它的对象在主 pass 里自然读到上一帧，不用另做「延一帧」。语料里读它的只有两张：`3706286085`（Sonic 眼睛的 `generic4` 开了 `REFLECTION`）与 `3453730450`（三个模型材质），都是跟随 WPE 设置时走「关」路径，所以本节不改语料的能渲染数，只在设置为开（或跟随而 WPE 开着）时不再报 `reflection:screen`。

**关键是缩小的滤波。** `GenerateMips` 的滤波由驱动定，读码只确认了调用（【推】通常是 2×2 盒式）。1920×1080 的 mip 链在高度上会经过奇数（135 → 67），盒式与「在目标纹素中心做一次双线性采样」在奇数级上结果不同；8 位上的「四个数取平均」还有 .5 的取整方向问题。`REFLECTION` 用 `roughness × mip 数` 当 lod 做三线性采样，各级的内容直接进画面，所以滤波必须照 WPE 实测定。步骤 0 抓 WPE 的各级、离线用几种候选算法从上一级推下一级，看哪种逐值相同；实现照它写进缩小 pass 的片元着色器（预案是「目标纹素中心一次双线性采样」，WebGPU 生成 mip 的常规写法；偶数尺寸上它等于 2×2 盒式）。

**步骤 0 定下的规则**（见下「步骤 0 的结果」）：预案在偶数级逐位相同，奇数级有约 1% 的分量差 1 级。逆向报告只确认 WPE 调的是 D3D11 `GenerateMips`，滤波在 NVIDIA 驱动里（2026-11-17 用户：「可以看看逆向报告或者派代理补」——报告里没有，没派代理逆向驱动），改在 dev 宿主里用同一块 GPU 拿 WPE 的上一级逐种试出来：硬件双线性，但采样坐标是定点的——缩放系数 `s/d` 向下截到 2⁻²⁴、乘积精确、纹素坐标再向下截到 1/256（WebGPU 的采样器自己是就近取 1/256）。照此 1920×1080、1366×768、HDR 的各级与 WPE 逐值相同。

关键决策：
- **拷贝源是场景目标本身**，不是另存的快照：WPE 拷的是主 pass 解析后的后备缓冲（泛光前），我们的场景目标在 `encode` 的这个位置就是同一份内容；`clearenabled: false` 的两张交替目标拷当前那张。
- **反射开时加载不清屏**：WPE 只在设置关时清（`0x140181cfd`），开着时 RT 建好不清，D3D11 的新纹理在 NVIDIA 上是 0；WebGPU 的新纹理也是 0。只影响第一帧，抓不到，不另测。
- **运行中切换设置**照旧整场重新加载（P13b1 已定：宿主随 `setting-change` 重载），不做 WPE 的「关掉那一刻原地清黑」。
- **产品里正交场景按场景分辨率画**：RT 跟场景目标同尺寸，mip 数按它算；WPE 跟窗口尺寸。窗口与场景分辨率不同时 `g_Texture3MipMapInfo` 与模糊程度会不同，P13b1 起就是这样（已知差异，dev 探针给了 `canvas` 时按窗口尺寸画、两边一致）。

## 现状锚点

**a. 反射开时照报**（`compile/bundle.ts:3249`、`:3465`）
```ts
if (mipReaders) {
  // 屏幕空间反射（rea-p13-passes 4.1）：任何对象读到就建
  bundle.mipFramebuffer = true;
  if (reflectionOn) unsupported.add("reflection:screen"); // 反射开：P13g 再做，照报
}
// … compileFragment 的收尾（运行中建的对象读到它）
if (mipReads > mipFrom) {
  if (!bundle.mipFramebuffer) flips.add("mip-framebuffer");
  if (await reflectionEnabled()) unsupported.add("reflection:screen");
}
```
`SceneBundle.mipFramebuffer?: boolean`（`compile/bundle.ts:848`），读的地方只有 `ReflectionTargets.create` 与上面两处。

**b. RT 建好清一次、之后不动**（`render/reflection.ts:101`）
```ts
if (this.wantMip) {
  const format: GPUTextureFormat = this.hdr ? "rgba16float" : "rgba8unorm";
  const levels = (this.mipLevelCount = mipLevelCountOf(width, height));
  const texture = device.createTexture({
    label: "_rt_MipMappedFrameBuffer", size: { width, height }, format, mipLevelCount: levels,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,   // 现状：没有 COPY_DST
  });
  // … 采样器 clamp + 三线性
  // 反射关：各级清成 (0, 0, 0, 1) 一次，之后不再碰（WPE 不更新它，步骤 0 R7）
  for (let level = 0; level < levels; level++) encoder.beginRenderPass({ … loadOp: "clear" … }).end();
  device.queue.submit([encoder.finish()]);
}
```

**c. 主 pass 收尾与泛光**（`render/scene.ts:6597`）
```ts
lightsBefore(Infinity);
composite();                                  // 体积光最后一段的合成
if (this.bloom && state.bloomEnabled) {
  // 全部图层画完：整帧快照（只拷这一次）→ 泛光链 → combine 写回场景目标
  if (!started) begin();
  end();
  snapshot(sceneDrawTarget);
  this.bloom.encode(encoder, sceneView, afterBloomStep);
}
if (!started) begin();
end();
// 现状：没有 mip 帧缓冲的每帧更新
```

## 步骤 0 — 补测（WPE 反射开，先做）

工程 `ignore/p13/g/gen_g.py` → `ignore/p13/proj/p13g-*`（正交 1920×1080，骨架同 P13b1 的 `gen_b1.py`：FR、CLK 在右上角）。抓帧用 `capture_sweep` 临时 `reflection: true`（扫完自动改回，核对 `config.json` 哈希），落 `A:\p13g\<工程>-on\`。

| 编号 | 工程 | 看什么 | 预测 |
|---|---|---|---|
| G1 | `p13g-mip`：左半 960×1080 画静态高频图样（逐像素整数哈希，三通道各不相同，浮点运算精确）；右半 y ≥ 120 是读者，屏幕 UV 左移 0.5 读左半，十条横带 lod = 0、0.8、…、7.2 | ①事件表：拷贝是 `ResolveSubresource` 还是 `CopyResource`、`GenerateMips` 的位置（主 pass 之后、泛光之前）；②读者那次 draw 时 0 级里 FR 的颜色是上一帧的帧号、拷贝之后是本帧；③拷贝后 0 级与主 pass 结束时的后备缓冲逐值相同；④各级内容：离线从第 k−1 级推第 k 级，候选「目标纹素中心双线性」「2×2 盒式（就近 / 向偶 / 截断）」，看哪个逐值相同（高度 135 → 67 是奇数级） | ①拷贝在主 pass 之后、泛光之前，每帧一次；②③成立；④偶数级各候选都可能相同，奇数级定胜负 |
| G2 | G1 改窗口 1366×768（宽度奇数级 683 → 341） | 宽度方向的奇数级，mip 数（公式给 7） | 同 G1 ④ 的结论；7 级 |
| G3 | `p13g-hdr`：G1 加 `hdr + bloom`，图样里一条带乘 4（> 1） | 格式 RGBA16F；0 级是泛光前（> 1 的值保留、没有泛光的光晕）；半精度上的缩小取整 | 成立；滤波同 G1 |

做完后两边对照：我们的实现按 dev 探针逐帧回放 G1–G3（`render_scene` 画布同窗口尺寸、连续两帧，第二帧读者读到第一帧），`trace.readback` 读各级（缩小 pass 的颜色附件就是该级），与 WPE 抓帧逐级、整帧比。

## 点 1 — 编译期（`compile/bundle.ts`、`compile/features.ts`）

- **修改** `SceneBundle.mipFramebuffer` 由布尔改成对象：
```ts
/**
 * `_rt_MipMappedFrameBuffer` 被任何对象读到（P13b1〔g1〕，rea-p13-passes 4.1）：渲染器建带 mip 的 RT。
 * `update`：反射开（P13g）——每帧主 pass 之后、泛光之前把场景目标拷进 0 级并逐级缩小，读者读到上一帧；
 * 反射关时加载时清成 (0, 0, 0, 1)，之后不更新。
 */
mipFramebuffer?: { update: boolean };   // 修改：原为 boolean
```
- **修改** `finalize`：`bundle.mipFramebuffer = { update: reflectionOn }`，**删除** `reflection:screen` 照报。
- **修改** `compileFragment` 收尾：只留 `flips.add("mip-framebuffer")`，**删除** `reflection:screen` 照报（场景里已经有这张 RT 时，`update` 跟着场景走）。
- **修改** `features.ts:185` 的注释：`reflection:screen` 不再报，反射开时由渲染器每帧更新。

## 点 2 — 渲染（`render/reflection.ts`、`render/scene.ts`）

- **修改** `ReflectionTargets.create`：`wantMip` 之外记 `updateMip = bundle.mipFramebuffer?.update === true`。
  - `update` 时纹理用途加 `COPY_DST`，**不做**加载时的清屏；建缩小管线（每种格式一条，WGSL 内联：全屏三角形的顶点着色器，片元着色器按步骤 0 定的滤波从上一级取值）与每级的 bind group（上一级的单级视图 + 线性 clamp 采样器）；
  - 不 `update` 时照旧清一次。
- 〔步骤 0 之后〕缩小着色器按定点坐标写，每级另有一个两轴系数的 uniform（见「步骤 0 的结果」「实施记录」）；下面是动工前的写法。
- **新增** `ReflectionTargets.encodeMipFramebuffer(encoder, source: GPUTexture)`：
```ts
/**
 * 反射开（P13g）：主 pass 之后、泛光之前（rea-p13-passes 4.2，帧函数 `0x140180aa0` / `0x140180b87`）。
 * 场景目标整张拷进 0 级（同尺寸同格式），再逐级各一个 pass 从上一级缩小（滤波照步骤 0 实测，WPE 是 D3D11 `GenerateMips`）。
 * 读它的对象在下一帧的主 pass 里读到这一帧（第一帧是新纹理的 0）。
 */
encodeMipFramebuffer(encoder: GPUCommandEncoder, source: GPUTexture): void {
  const target = this.mipFramebuffer;
  if (!target || !this.updateMip) return;
  encoder.copyTextureToTexture({ texture: source }, { texture: target.texture, mipLevel: 0 }, { width: target.width, height: target.height });
  for (let level = 1; level < this.mipLevelCount; level++) {
    const pass = encoder.beginRenderPass({
      label: `_rt_MipMappedFrameBuffer mip ${level}`,
      colorAttachments: [{ view: this.levelViews[level], loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: "store" }],
    });
    pass.setPipeline(this.downsample!);
    pass.setBindGroup(0, this.levelSources[level]);   // 上一级
    pass.draw(3);
    pass.end();
  }
}
```
- **修改** `render/scene.ts` 的 `encode`：`composite()` 之后、泛光之前
```ts
lightsBefore(Infinity);
composite();
// 屏幕空间反射（P13g）：反射开时把这一帧（泛光前）拷进 mip 帧缓冲并逐级缩小；读者下一帧读到
if (this.reflectionTargets?.updatesMip) {
  if (!started) begin();
  end();
  this.reflectionTargets.encodeMipFramebuffer(encoder, sceneTexture);
}
if (this.bloom && state.bloomEnabled) { … }   // 不变
```
- `checkRenderable` 不用加键：缩小管线建不出来是代码错误，不是不支持项（同泛光链按 `render:bloom:*` 报的只是材质缺失）。

## 点 3 — 测试

- `render/reflection.test.ts`：
  - `update: true`：用途带 `COPY_DST`、建好时不清屏、不提交命令；`encodeMipFramebuffer` 先拷 0 级（源、尺寸），再按级数 1…L−1 各一个 pass，颜色附件是该级、采样上一级；
  - `update: false`：`encodeMipFramebuffer` 什么都不记；`updatesMip` 为假；
  - `resize` 之后级数与视图跟着变。
- `compile/p13b1.test.ts`：开时不再报 `reflection:screen`，`mipFramebuffer` 为 `{ update: true }`，关时 `{ update: false }`；运行中建的对象读到它时的 `flips` 不变。
- 滤波算法：步骤 0 的离线脚本给出 WPE 的规则后，挑一组有奇数级的小尺寸（如 5×3 → 2×1）写一条 GPU 无关的参考实现测试，核对着色器里的坐标公式（参考实现与 WGSL 同一组公式）。

## 验收

1. tsc；本节相关的 vitest（`render/reflection.test.ts`、`compile/p13b1.test.ts`，以及直接导入改动模块的测试）。
2. 语料：改动前后 `kbp corpus scan` + `diff`，跟随时不变；`--reflection enabled` 再扫一次，`reflection:screen` 消失、没有新键（`3706286085` 变干净，`3453730450` 还差别的键）。
3. 确定性工程对 WPE：G1–G3 各级 mip 逐值、整帧逐像素（掩掉 FR、CLK），差异逐处解释。
4. 变异检查：拷贝挪到泛光之后、不拷 0 级、缩小用错级、滤波换成另一种候选、加载时照旧清屏、`update` 恒假，各自要被测试或对照检出。
5. **按 FINAL_CHECK 走查** `3706286085`：P13f 的复制工程（`ignore/p13/f/walk/proj/3706286085-iso-p13f`，留着 `RioSonic` 与眼睛材质）用 `capture_sweep` 临时 `reflection: true` 录 5 帧，按日志逐帧回放、逐像素比；眼睛那几个 draw 逐 draw 对常量；差异逐处解释（已知的城市骨骼 K2、偶数帧相机滞后会经上一帧的画面传进反射，要分开）。
6. 文档：`cocs/wpe/WPE_SCENE.md`「反射」一条补屏幕空间反射开、`cocs/README.md` 同步、changelog、回归加一节；总计划实施记录。
7. 恢复：测试行 `projects_remove`；WPE 设置由 `capture_sweep` 改回、核对哈希。过后才请用户提交。

## 风险

1. **滤波对不上任何候选**：驱动的 `GenerateMips` 可能用别的核或别的取整。对不上时按误差包络比，并把差异定位到奇数级 / .5 取整，记进已知差异。
2. **HDR 的半精度缩小**：硬件过滤在 FP16 上的舍入可能和着色器里按 f32 算再写回不同，G3 单独看。
3. **相机滞后会放大**：`3706286085` 偶数帧的相机差（有意不同）会让上一帧画面整体错开一点，眼睛里的反射跟着差；走查要用奇数帧或把这部分单独解释。

## 待定

无。滤波由步骤 0 实测定；运行中切换、第一帧内容、正交场景的尺寸都沿用 P13b1 的已定做法。

## 步骤 0 的结果（2026-11-17，p13-REPORT「P13g 的实测」）

- G1①②③、G2、G3 成立：拷贝（`ResolveSubresource`，源是非多重采样的后备缓冲）在主 pass 之后、泛光之前（HDR 时在 `_rt_FullFrameBuffer` 的拷贝之后），读者读到上一帧，拷贝后 0 级与主 pass 结束时的目标逐值相同，HDR 下 > 1 的值保留。
- G1④ 推翻预案的一半：偶数级就是 2×2 平均（取整是硬件写 RGBA8 的门槛，同 P13e），奇数级的采样坐标是定点的（见上「步骤 0 定下的规则」与报告里逐种的对照数）。
- 对实现的改动：点 2 的缩小着色器按定点坐标写（`MIP_DOWNSAMPLE_WGSL`），每级多一个 8 字节 uniform 放两轴的系数（`mipDownsampleScale`），另导出同式的 TS 实现 `mipSourceCoord256` 给单测与 BigInt 精确值比。

## 实施记录（2026-11-17，Claude 直接在主工作区改，未提交）

**改动**
- `compile/bundle.ts`：`SceneBundle.mipFramebuffer` 改成 `{ update: boolean }`，`finalize` 写 `{ update: reflectionOn }`、去掉 `reflection:screen`；`compileFragment` 的收尾只留 `mip-framebuffer` 翻转。`compile/features.ts` 注释同步。
- `render/reflection.ts`：`updatesMip`；反射开时纹理多 `COPY_DST`、建好不清屏、建缩小管线（`layout: "auto"`）与每级的附件视图、读上一级的 bind group、系数缓冲；`encodeMipFramebuffer`（拷 0 级 + 逐级一个 pass）；`MIP_DOWNSAMPLE_WGSL`、`mipDownsampleScale`、`mipSourceCoord256`；`destroy` 释放系数缓冲。
- `render/scene.ts`：`encode` 在 `composite()` 之后、泛光之前调 `encodeMipFramebuffer`（没画过场景先清一次）。
- 测试：`render/reflection.test.ts`（假设备记拷贝、bind group、draw；反射开的建 / 拷 / 缩小、resize、`GpuScene` 每帧、没画图层时、带泛光时在泛光之前；定点坐标对 BigInt 精确值、实测的那一行）；`compile/p13b1.test.ts`（开时不报、`update` 随设置与跟随）。

**验收**
1. tsc 0 error；`render/reflection.test.ts` + `compile/p13b1.test.ts` 67 例全过。Prettier：本节的文件已格式化；`render/scene.ts` 第 6263 行的报警 HEAD 上就有，不归本节。
2. 变异 13 / 13（`ignore/p13/g/mut/mutations-g.py`，快照模式）：第一轮漏「系数就近取」（单测的尺寸里系数小数部分都小于 ½），补 13 → 6 一组后检出。着色器里的坐标算式单测跑不到，由 GPU 对照兜底。
3. 语料（233 张，HEAD `5c149a4b` 快照对工作区快照，`ignore/p13/g/corpus-{head,wt}.json`）：跟随 197 → 197、0 张变化；把缺省设置换成「开」扫读 mip 帧缓冲的两张（`corpus-{head,wt}-on.json`）：`reflection:screen` 2 张去掉、没有新键，`3706286085` 变干净，`3453730450` 剩 `camera:perspective:group`、`camera:perspective:text`、`volumetrics:transparentsorting`（P13h）。
4. 确定性工程对 WPE：G1–G3 各级与读者画面逐值相同（只差 CLK 块）。
5. 走查见下。
6. 文档：`cocs/wpe/WPE_SCENE.md`「反射」、`cocs/README.md`、changelog、回归「场景壁纸屏幕空间反射开（P13g）」、p13-REPORT、总计划实施记录。
7. 恢复：测试行 15514–15517 已 `projects_remove`；dev 覆盖用完即删（两段期间同源宿主按反射开编译，用户开着的 15030 预览重开即恢复）；WPE 设置三次扫描各自改回、哈希复原（第一次扫描前后是 `f525b774…`，之后两次前后是 `7036108…`，中间的变化不是扫描写的）；扫描关掉过用户开着的 WPE 浏览窗口。

## 走查（2026-11-17，按 `FINAL_CHECK.md`）

| 场景 | 复制工程 | 结果 | 判定 |
|---|---|---|---|
| `3706286085` | P13f 的 `3706286085-iso-p13f`（留着 Sonic 与眼睛的 `REFLECTION` 材质） | 读者（眼睛）常量逐值相同、mip 帧缓冲有内容，但眼睛整个被挡住（WPE 这个 draw 前后后备缓冲 0 变化，我们反射开 / 关逐像素相同）；整帧差异同 P13f：第 261 帧 37 个像素 ≤ 1，其余是偶数帧相机滞后（有意不同）与城市骨骼 K2（已知） | 通过（反射不进这张的画面） |
| `3453730450` | `make_iso_3453.py`：留 TY / LP（`REFLECTION`）、月球背景、纯色底，可见性换 true，三盏灯关体积光 | 10 帧整帧逐像素相同；同一帧反射开 / 关差 109 个像素（最大 57 级） | 通过 |

**还没做**：回归 SR5（设置页切到「开启」看预览）、SR6（非 NVIDIA 显卡）。
