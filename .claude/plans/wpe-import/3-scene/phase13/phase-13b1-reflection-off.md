# P13b1 — 反射设置与「反射关」的路径（子计划）

> 上级：[phase-13-3d-lighting.md](phase-13-3d-lighting.md)「P13b」与「实施记录 / 步骤 0」的「P13b 拆两步」。依据：[rea-p13-passes.md](rea-p13-passes.md) 第 1 节（平面反射）、第 4 节（`_rt_MipMappedFrameBuffer`）、第 5 节（一帧的顺序），[p13-REPORT.md](p13-REPORT.md) 第 3、4、6、14 条。
> 现状行号按 2026-11-14 的工作区（HEAD `91d3edec` 加别的会话没提交的改动）。`compile/bundle.ts`、`render/graph.ts`、`render/scene.ts`、`host.ts` 是共享文件，其中 `scene.ts`、`host.ts` 别的会话正改着（工作区有未提交改动），在 HEAD 快照里实现再三方合并，按块暂存。
> 执行交 sonnet 子代理，验收由 Claude 独立做。

## 总体设计思路

WPE 的平面反射有一个用户设置 `reflection`（`config.json` 的 `general.user.reflection`，缺键当开），它同时管两样东西：平面反射 pass（`_rt_Reflection`）和屏幕空间反射用的 mip 帧缓冲（`_rt_MipMappedFrameBuffer`）。设置关着时两样都不画，只剩两张内容固定的纹理：`_rt_Reflection` 每帧清成场景清屏色（alpha 1），`_rt_MipMappedFrameBuffer` 加载时清成 (0, 0, 0, 1)、之后不再更新。用户现在的 WPE 就是关着的。所以只做「关」这条路径，跟随 WPE 的设置下 arsenal、audiophile、fantasticcar 就和 WPE 画得一样，能渲染 +3 张，不用先建场景视图。P13b2 再做「开」。

P13b1 做三件事：

**一个设置。** Kabegame 加「场景反射」`wpeSceneReflection`：`follow`（缺省，读 WPE `config.json` 的 `reflection`，缺键当开）/ `disabled` / `enabled`，照「场景后处理」的做法接：Rust 设置键与命令、前端 descriptor 与设置页、场景宿主随 `setting-change` 重新加载。编译时解析成一个布尔值「反射开」。

**编译期认出两张 RT。** `_rt_Reflection` 与 `_rt_MipMappedFrameBuffer` 进运行时 RT 表（`bindRuntime`），不再报 `texture:rendertarget:*`。WPE 建 `_rt_Reflection` 的条件是「有模型的某个网格材质的纹理槽解析到它」，所以编译期在全部对象编完之后看：有模型读它，bundle 记 `reflection.planar`；只有图像层或粒子读它而没有模型读时，WPE 根本不建这张 RT，那一槽绑的是 6×6 黄黑棋盘格占位（步骤 0 R3），我们照做。反射开且 `planar` 时报 `reflection:planar`（P13b2 去掉），整张退回。

**渲染器给两张常量纹理。** 新模块 `render/reflection.ts` 持有这两张 RT。`_rt_Reflection` 用场景目标尺寸、`rgba8unorm`（HDR 下也是），每帧在主 pass 之前清成 `(clearcolor, 1)`，`clearenabled` 不管（WPE 每帧都清）。用整张 RT、每帧清，而不是 1×1 纹理，是因为 P13b2 正要在这张 RT 上画反射 pass，而且读它的着色器拿到的 `g_Texture<n>Resolution` 应该是 RT 尺寸。渲染图里加一种纹理来源 `{ kind: "reflection" }`，模型、图像层、粒子、文本、形状几处把运行时名字翻成纹理来源的地方改用一个共用函数。

**关键决策：**
- **只做「关」，「开」照报。** 设置开着时退回预览图，而不是画一张清屏色的假反射：那样画面和 WPE 不同又不报，违反「没实现的照报」。
- **设置只加反射一项。** 阴影、体积光的画质设置（「决定」3 的另两项）分别在 P13d、P13e 加，那时才有东西可调。见「待定」2。
- **清屏色就是主 pass 的清屏色。** 我们每帧从 `state.general.clearcolor` 取（脚本写入同帧生效），WPE 在脚本之后、反射之前设清屏色，所以同帧生效也一致。
- **尺寸取场景目标。** WPE 取窗口尺寸；我们离屏渲染，透视场景的场景目标就是画布尺寸，正交场景是场景分辨率。和 `_rt_FullFrameBuffer` 的取法相同（p5-REPORT「`_rt_FullFrameBuffer` 的尺寸」）。

`_rt_MipMappedFrameBuffer` 的「关」路径（P13g 的第一步）要不要一起做，见「待定」1。下面按「一起做」写，标了〔g1〕的部分在不一起做时整块去掉。

## 现状锚点

**a. 运行时 RT 只认快照与 effect 的 fbo**（`apps/wpe-scene/src/compile/bundle.ts:1579`、`:1620`、`:1711`）
```ts
    const bindRuntime = (slot: number, name: string): boolean => {
      if (name === FRAMEBUFFER_RT) runtime[slot] = name;
      else if (context.fbos?.has(name)) runtime[slot] = name;
      else return false; // 现状：_rt_Reflection、_rt_MipMappedFrameBuffer 走到这里
      return true;
    };
    // 材质 textures 里的 `_rt_*`
      if (name.startsWith("_rt_")) {
        if (bindRuntime(slot, name))
          formats.push({ slot, format: FBO_FORMATS[context.fbos?.get(name)?.format ?? "rgba8888"].tex });
        else issues.add(`texture:rendertarget:${name}`); // 现状：arsenal、audiophile、fantasticcar 只剩这一条
        continue;
      }
    // 着色器注解缺省（generic2 的 g_Texture2 缺省就是 _rt_Reflection）
        if (fallback.startsWith("_rt_")) {
          if (!bindRuntime(binding.slot, fallback)) issues.add(`texture:rendertarget:${fallback}`);
          continue;
        }
```

**b. 后处理档位每次编译时解析，跟随时读 WPE 的 `config.json`**（`compile/bundle.ts:1083`；`compile/postprocess.ts:44`、`:222`）
```ts
  const setting = input.postprocess ?? "follow";
  const wpeSetting = setting === "follow" ? await readWpePostprocessing(input.reader, input.sceneAssets) : null;
// postprocess.ts
export function wpePostprocessingOf(configText: string): string | null {
  // …遍历顶层用户，取 general.user.postprocessing（现状：只认这一个键）
}
export async function readWpePostprocessing(reader: SceneReader, sceneAssets: readonly string[]): Promise<string | null>;
```

**c. 宿主读设置、随 `setting-change` 重新加载**（`host.ts:255`、`:1058`、`:1100`）
```ts
      if (!delta || !("wpeScenePostprocess" in delta)) return; // 现状：只认这一个键
      const next = asPostprocess(delta.wpeScenePostprocess);
// readPostprocess
      return asPostprocess(await invoke<string>("get_wpe_scene_postprocess"));
// reload → compileSceneInWorker({ …, postprocess: setting, … })
```

**d. 渲染图把运行时名字翻成纹理来源，五处各写一遍**（`render/graph.ts:462`、`:475`、`:556`、`:591`、`:678`）
```ts
    for (const [slot, name] of Object.entries(pass.runtime)) {
      if (name === FRAMEBUFFER_RT) inputs[Number(slot)] = { kind: "framebuffer" };
      else reasons.push(`render:texture-rt:${name}`); // 现状：模型（planModelLayer）、形状、粒子只认快照
    }
// staticInputs（图像层 / 文本）多一个 fbo 分支
      else if (effect !== null && fboNames[effect].has(name)) inputs[Number(slot)] = { kind: "fbo", effect, name };
```

**e. 纹理来源的种类**（`render/graph.ts:85`；`render/scene.ts:2437`）
```ts
export type TextureRef =
  | { kind: "texture"; index: number }
  | { kind: "composite"; index: number }
  | { kind: "fbo"; effect: number; name: string }
  | { kind: "framebuffer" }
  | { kind: "atlas"; color: boolean }
  | { kind: "layer"; object: number }
  // …（现状：没有反射 RT）
  private resolveTexture(ref: TextureRef, resources: LayerResources): RenderTarget | null {
    if (ref.kind === "composite") return resources.composites[ref.index] ?? null;
    if (ref.kind === "fbo") return this.targets[resources.fbos.resolve(ref.effect, ref.name)] ?? null;
    if (ref.kind === "framebuffer") return this.snapshot;
```

**f. 主 pass 的清屏色每帧从状态取**（`render/scene.ts:4066`）
```ts
    const { clearcolor, clearenabled } = state.general;
    const [r, g, b] = clearcolor;
    // …第一个 pass：开着清成 clearcolor（alpha 1），关着接着上次的成品画
```

**g. 设置的 Rust 侧与前端**（`src-tauri/kabegame-core/src/settings/mod.rs:1064`、`:1464`、`:1552`；`src-tauri/kabegame/src/commands/settings.rs:113`、`:463`；`lib.rs:792`；`permissions/wpe-scene-host.toml:4`；`apps/kabegame/src/stores/settingsDescriptors.ts:216`；`views/Settings.vue:368`、`:569`；`packages/kabegame-i18n/src/locales/{zh,zhtw,en,ja,ko}/settings.json`）
```rust
    pub fn get_wpe_scene_postprocess(&self) -> String { /* 读键，不合法回 "follow" */ }
    pub fn set_wpe_scene_postprocess(&self, value: String) -> Result<(), String> { /* 校验后写，发 setting-change */ }
fn is_wpe_scene_postprocess(value: &str) -> bool { /* follow | disabled | enabled | ultra */ }
```
```toml
commands.allow = ["get_wpe_scene_postprocess", "wpe_scene_target", "wpe_scene_report"] # 现状：场景宿主只能读后处理设置
```

## 步骤 0 — 确定性工程（Claude，实现之前）

WPE 现在就是 `reflection: false`、`postprocessing: ultra`，不用改 WPE 设置。工程用 `ignore/p13/a0/gen_a13.py` 的做法（`generic` 网格 + 工程自带着色器）生成到 `ignore/p13/proj/p13b1-*`，抓帧放 `A:\p13b1\<用途>\`，常量用 `kbp rdc consts --no-clock` 提取。读反射图的网格材质用工程自带的着色器：直接输出 `texSample2D(g_Texture0, 屏幕 UV)`，并声明 `g_Texture0Resolution`（`g_Texture0` 由材质 `textures` 绑 `_rt_Reflection`）。

| # | 工程 | 预测（读码） |
|---|---|---|
| R1 | 正交，清屏色 (0.2, 0.4, 0.6)，一个读反射图的网格 + 一个普通图像层 | `_rt_Reflection` 窗口尺寸、RGBA8、1 级 mip，整张 (0.2, 0.4, 0.6, 1)，本帧没有绘制画进去；采样器 Clamp + Linear；`g_Texture0Resolution` = (W, H, W, H)（RT 的宽高，同 RT 的规则） |
| R2 | R1 + 一个图像层的材质也读 `_rt_Reflection` | 图像层绑的是同一张 RT，读到清屏色 |
| R3 | 只有读 `_rt_Reflection` 的图像层，没有模型读它 | RT 不建；看 WPE 实际绑了什么（决定这种情况是照报还是照做） |
| R4 | R1 + `clearenabled: false` | 场景不清，`_rt_Reflection` 仍每帧清成清屏色 |
| R5 | R1，清屏色绑属性，运行中 `apply_properties` 改 | RT 跟着变 |
| R6 | R1 + `hdr: true`、`bloom: true`，清屏色 (2, 0.5, 0.25) | 场景目标是 RGBA16F，`_rt_Reflection` 仍是 RGBA8，内容 (1, 0.5, 0.25, 1) |
| R7〔g1〕 | 图像层读 `_rt_MipMappedFrameBuffer` 与 `g_Texture0MipMapInfo`；窗口 1920×1080 与 1280×720 各抓一次 | 整张 (0, 0, 0, 1)、不随清屏色；mip 数 8 / 7（`max(1, min(log2(npot(w)/2), log2(npot(h)/2)) − 2)`），`g_Texture0MipMapInfo` 等于 mip 数（看是标量还是向量） |

R3 若 WPE 绑的是别的东西（缺省纹理、上一张 RT），照报不变；若读到的也是清屏色，再定要不要照做（语料 0 处，倾向照报）。

### 步骤 0 的结果（2026-11-14）

工程 `ignore/p13/b1/gen_b1.py` → `ignore/p13/proj/p13b1-*`；抓帧 `A:\p13b1\<r1|r3|r4|r5|r6|r7-1080|r7-900>\`；常量 `ignore/p13/b1/out/wpe-*-consts.json`（`show_consts.py` 打印）。WPE 设置没动（`reflection: false`、`postprocessing: ultra`）。

| # | 结果 |
|---|---|
| R1 | 成立。`_rt_Reflection` 1920×1080 R8G8B8A8_UNORM、1 级 mip，整张 (0.2, 0.4, 0.6, 1)，本帧没有绘制写它；采样器 ClampEdge + Linear（mip Linear）；`g_Texture0Resolution` = (1920, 1080, 1920, 1080)。帧里两次颜色清屏（反射图、场景）加一次深度清屏 |
| R2 | 成立。网格（event 50）与图像层（67）绑同一张 RT |
| R3 | **和预测不同**：RT 不建（帧里只有场景一次清屏），图像层的槽绑的是 6×6 黄黑棋盘格（(0, 0) 黑、(3, 0) 黄，同 P8 的占位），采样器 Wrap + Point，`g_Texture0Resolution` = (6, 6, 6, 6)。→ 照做：绑棋盘格，不报 |
| R4 | 成立。`clearenabled: false` 时帧里只剩反射图那一次颜色清屏（场景颜色、深度都不清），内容仍是清屏色 |
| R5 | 成立。`apply_properties` 把 `p_cc` 改成 (0.8, 0.1, 0.3) 后反射图是 (204, 25, 76)/255（`0.1·255`、`0.3·255` 的半数向下取，8 位换算由驱动做，我们同一块 GPU 上的清屏走同样的换算） |
| R6 | 成立。HDR 下场景目标 R16G16B16A16_FLOAT，`_rt_Reflection` 仍是 RGBA8，清屏色 (2, 0.5, 0.25) 存成 (255, 127, 64)/255 |
| R7 | 成立。只有图像层读 `_rt_MipMappedFrameBuffer` 也建 RT：1920×1080 时 8 级、1600×900 时 7 级，整张 (0, 0, 0, 1)（各级都是），采样器 ClampEdge + 三线性；`g_Texture0MipMapInfo` 是 float，= mip 数（8.0 / 7.0）；`Resolution` 是 RT 尺寸 |

**对实现的改动**：
- 「只有图像层或粒子读 `_rt_Reflection`、没有模型读」改成绑棋盘格（`checkerIndex()`，同 P8 的 `_rt_imageLayerComposite_*` 占位），不再照报。编译期在全部对象编完之后回头改这些 pass：删掉 `runtime[slot]`，改成 `slots[slot] = checkerIndex()`。
- `_rt_MipMappedFrameBuffer` 的采样器 Clamp + 三线性（mip 过滤 linear），`_rt_Reflection` 的 Clamp + Linear（单级，mip 过滤无所谓）。
- `g_Texture<n>MipMapInfo` 是 `float`。

## 点 1 — 设置「场景反射」（Rust、前端、i18n）

- **新增** `kabegame-core/src/settings/mod.rs`：键 `wpeSceneReflection`，取值 `follow` / `disabled` / `enabled`，缺省 `follow`；`get_wpe_scene_reflection`、`set_wpe_scene_reflection`、`is_wpe_scene_reflection`，写法照 `wpeScenePostprocess`（含 `get_settings` 快照里的那一项与单测）。
- **新增** `kabegame/src/commands/settings.rs` 两个命令，`lib.rs` 注册；`permissions/wpe-scene-host.toml` 的 `commands.allow` 加 `get_wpe_scene_reflection`。
- **新增** 前端 `stores/settings.ts` 的类型、`settingsDescriptors.ts` 的 descriptor、`Settings.vue` 里「场景后处理」下面一项单选（跟随 WPE / 关 / 开），五种语言的 `settings.json` 加 4 个词条。说明文字照后处理那条写明「现在只能渲染关闭时的画面，开着时读反射的场景显示预览图」。

## 点 2 — 读 WPE 设置与解析（`compile/postprocess.ts`，或新文件 `compile/quality.ts`）

- **修改** `wpePostprocessingOf` 改成通用的「取第一个有该键的用户的 `general.user.<键>`」，`readWpePostprocessing` 同样带键名；后处理调用方式不变。
- **新增**
```ts
/** 设置「场景反射」的取值；默认 `follow`。 */
export type SceneReflectionSetting = "follow" | "disabled" | "enabled";
/**
 * 反射开不开（rea-p13-passes 1.2）：WPE 的 `general.user.reflection` 是布尔，缺键补 true（`0x140047457`），
 * 读不到 `config.json` 也按 true。不认识的设置值按跟随处理。
 */
export function resolveReflection(setting: string | null | undefined, wpeValue: unknown): boolean;
```

## 点 3 — 编译期（`compile/bundle.ts`、`compile/features.ts`）

- **新增** `bundle.ts` 导出常量 `REFLECTION_RT = "_rt_Reflection"`、`MIP_FRAMEBUFFER_RT = "_rt_MipMappedFrameBuffer"`〔g1〕。
- **修改** `bindRuntime`：这两个名字也记进 `runtime`；`formats` 里 `_rt_Reflection` 按 RGBA8（`FBO_FORMATS.rgba8888.tex`），`_rt_MipMappedFrameBuffer` 按场景目标（HDR 时 `rgba16161616f`）〔g1〕。
- **新增** 编译时记下谁读了它们：`reflectionReaders: { model: boolean; others: Set<string /* pass key */> }`。全部对象编完之后：
```ts
// 平面反射（rea-p13-passes 1.1、1.4）：只有模型的网格读 `_rt_Reflection` 时 WPE 才建这张 RT、才有反射 pass
if (reflectionReaders.model) {
  bundle.reflection = { planar: true };
  if (input.reflection) unsupported.add("reflection:planar"); // 反射开：P13b2 再做，照报
} else for (const { pass, slot } of reflectionReaders.others) {
  // RT 不建：WPE 绑 6×6 黄黑棋盘格占位（步骤 0 R3）
  delete pass.runtime[slot];
  pass.textures[slot] = checkerIndex();
}
// 〔g1〕屏幕空间反射（rea-p13-passes 4.1）：任何对象读到就建
if (mipReaders) {
  bundle.mipFramebuffer = true;
  if (input.reflection) unsupported.add("reflection:screen"); // 反射开：P13g 再做
}
```
- **修改** `CompileSceneInput` 加 `reflection?: SceneReflectionSetting`，在后处理档位旁边解析（跟随时读 `config.json`）；`SceneBundle` 加 `reflection?: { planar: boolean }`、`mipFramebuffer?: boolean`〔g1〕。
- **修改**〔g1〕`features.ts`：`g_Texture<n>MipMapInfo` 在这个槽绑的是 `_rt_MipMappedFrameBuffer` 时是引擎 uniform，其余槽照旧报（写法照步骤 0 R7 的形状）。

## 点 4 — 渲染（`render/reflection.ts` 新文件，`render/graph.ts`、`render/scene.ts` 接线）

- **新增** `render/graph.ts` 的纹理来源与共用的翻译函数，五处改用它：
```ts
  /** 平面反射 RT（P13b1，`render/reflection.ts`）：场景目标尺寸、RGBA8，反射关时每帧清成清屏色。 */
  | { kind: "reflection" }
  /** 〔g1〕mip 帧缓冲（`_rt_MipMappedFrameBuffer`）：反射关时加载时清成 (0, 0, 0, 1)，之后不更新。 */
  | { kind: "mip-framebuffer" }

/** 运行时名字 → 纹理来源；effect 自己的 fbo 由调用方先判。认不出返回 null，调用方报 `render:texture-rt:<名>`。 */
function runtimeInput(name: string): TextureRef | null;
```
- **新增** `render/reflection.ts`：
```ts
/** 反射用的两张 RT（P13b1 只有「反射关」）。P13b2 在这里加反射 pass。 */
export class ReflectionTargets {
  /** `bundle.reflection.planar` 时建 `_rt_Reflection`；〔g1〕`bundle.mipFramebuffer` 时建带 mip 的 RT 并清一次。 */
  static create(device: GPUDevice, bundle: SceneBundle, width: number, height: number, hdr: boolean): ReflectionTargets;
  /** 每帧主 pass 之前：`_rt_Reflection` 清成 (clearcolor, 1)，不看 clearenabled（rea-p13-passes 1.1）。 */
  encode(encoder: GPUCommandEncoder, clearcolor: readonly [number, number, number]): void;
  resize(width: number, height: number): void; // 透视场景随画布变（P5d 步骤 2）
  destroy(): void;
}
```
- **修改** `render/scene.ts`：建场景时建 `ReflectionTargets`，`resolveTexture` 加两个分支，`encode` 开头（主 pass 之前、清屏色取到之后）调 `reflection.encode`，尺寸变化与销毁接上。采样器 Clamp + Linear（步骤 0 R1 核对）。〔g1〕mip 数照公式，按场景目标尺寸算；`g_Texture<n>MipMapInfo` 写进绘制的 uniform（照 `g_Texture<n>Resolution` 的写法）。

## 点 5 — 宿主（`host.ts`）

- **修改** `setting-change` 的监听同时认 `wpeSceneReflection`，变了就 `reload()`（`stats.recompiled` 记 `settings`）；`reload` 并行读两个设置，`compileSceneInWorker` 带上 `reflection`。
- **修改** 测试替身（`host.test.ts` 等）的 `invoke` 认 `get_wpe_scene_reflection`。

## 点 6 — 测试

- `compile/postprocess.test.ts`（或 `quality.test.ts`）：`resolveReflection` 的表（三种设置 × WPE 值 true / false / 缺键 / 读不到 / 非布尔）；`config.json` 多用户、BOM。
- `compile/` 新测试 `p13b1.test.ts`：
  - 模型读 `_rt_Reflection`（材质 `textures`、注解缺省两种）：反射关时 `bundle.reflection.planar`、不报；反射开时报 `reflection:planar`；
  - 只有图像层读：不报，那一槽绑棋盘格、`runtime` 里没有它，没有 `bundle.reflection`；
  - 〔g1〕读 `_rt_MipMappedFrameBuffer` 与 `g_Texture<n>MipMapInfo`：关时不报、开时报 `reflection:screen`；别的槽的 `MipMapInfo` 照报。
- `render/graph.test.ts`：五处翻译出 `{ kind: "reflection" }`；`render:texture-rt` 只剩真的认不出的名字。
- `render/` 假设备测试：有 `planar` 时建一张场景尺寸的 `rgba8unorm`，每帧一次清屏，清屏色随 `state.general.clearcolor`，`clearenabled: false` 照清；没有反射的场景命令轨迹与改动前逐项相同。〔g1〕mip 数公式（1920×1080 → 8、1280×720 → 7、小尺寸至少 1），只清一次。
- `host.test.ts`：推 `wpeSceneReflection` 触发一次重新加载，值不变不加载。
- Rust：`is_wpe_scene_reflection` 拒绝未知值。

## 验收

子代理：宿主 tsc 0 error，vitest（带 `KABEGAME_WPE_ROOT`）全过，Prettier；`cargo check`、`cargo test -p kabegame-core` 的设置单测（`CARGO_TARGET_DIR=D:/Codes/kabegame/target-check`）；前端 `vue-tsc`。

Claude 独立验收：
1. `git status` 查越界，共享文件只含本节的块；tsc、vitest 自跑。变异检查：`bindRuntime` 不认 `_rt_Reflection`、去掉「只有模型读才算」、`encode` 不清、清屏色写死黑、反射开时不报。
2. 语料：改动前后 `kbp corpus scan` + `diff`。预期去掉的只有 arsenal、audiophile、fantasticcar 的 `texture:rendertarget:_rt_Reflection`（〔g1〕另有 `3453730450` 的 `_rt_MipMappedFrameBuffer` / `g_Texture3MipMapInfo` 两条，它还差别的键），能渲染 +3 张，其余逐张不变；另跑一遍「反射开」，这几张报 `reflection:*`。
3. 没有反射的场景逐字节不变：`kbp regress --corpus` 与几张基线场景的画面哈希。
4. 步骤 0 的确定性工程：和 WPE 整帧逐像素比，并比 `_rt_Reflection` 的内容与 `g_Texture0Resolution`。
5. **按 FINAL_CHECK 走查**：arsenal、audiophile、fantasticcar 各做复制工程（`kbp content isolate --instrument`，留读反射图的模型与它的父链），WPE 抓一段（`capture_sweep` 带日志）、按日志回放、`kbp cmp frames` 逐帧逐像素比，每一处差异解释到绘制与数值；有相机路径 / 抖动的按日志回放。
6. 真机：设置页切三档，场景宿主重新加载、退回与恢复符合预期；没有 WebGPU 错误。
7. 恢复测前状态（当前壁纸、设置），测试行用 `projects_remove` 移除，写进实施记录。过后才请用户提交。

文档：`cocs/wpe/WPE_SCENE.md` 加「反射」一条（设置、两张 RT 在「关」时的内容、照报的键），`versions/latest/regression.md` 与 changelog 各加一条，总计划的实施记录加 P13b1。

## 风险

1. **共享文件冲突**：`render/scene.ts`、`host.ts` 工作区里有别的会话没提交的改动。在 HEAD 快照里实现，再三方合并到工作区；接线只加几处，冲突面小。
2. **正交场景的尺寸**：WPE 的 RT 是窗口尺寸，我们是场景分辨率。反射关时内容是常量，只影响 `g_Texture<n>Resolution`，读它的着色器（generic 系列在 SM4 下不加 `g_TexelSizeHalf`）不用它做别的；步骤 0 R1 核对。
3. **设置开着时三张退回**：跟随 WPE 且用户以后打开了 WPE 的反射，这三张会显示预览图，直到 P13b2。设置说明里写明。
4. **棋盘格的回改**：编译期在全部对象编完之后回头改已编好的 pass（删 `runtime`、填 `textures`），要保证这些 pass 还没被别处拷走（变体、缓存键）。测试覆盖材质 `textures` 与注解缺省两种来源。

## 待定（2026-11-14 用户：「按你的推荐开始」，三条都按推荐：〔g1〕并进、只加反射一项设置、整张 RT）

1. **`_rt_MipMappedFrameBuffer` 的「关」路径（P13g 的第一步）要不要并进本节**（上文标〔g1〕的部分）。推荐并进：同一个设置管着它，「反射关」时它只是一张加载时清黑的 RT 加一个 mip 数 uniform，和 `_rt_Reflection` 走同一套接线；分开做要再动一次同样的几个共享文件。现在并进不解锁场景（用到它的 `3453730450` 还差别的节），只是把「反射关」做完整。另一种：留到 P13g 和「开」一起做，本节更小。
2. **画质设置只加反射一项，还是三项一起加**（「决定」3 的阴影、体积光）。推荐只加反射：阴影和体积光在 P13d、P13e 之前没有任何东西可调，先加出来是空开关；那两节各自加一项，写法相同。另一种：现在一起加，设置页一次成形。
3. **`_rt_Reflection` 用整张 RT 还是 1×1 纹理**。推荐整张（场景目标尺寸）：P13b2 就画在这张上，`g_Texture<n>Resolution` 也和 WPE 同义；代价是 4K 下多 33 MB 显存和每帧一次清屏，只在有模型读反射图的场景里（语料 3 张）。另一种：1×1 纹理只在清屏色变时写，`Resolution` 另报一个假尺寸，P13b2 再换。

## 没做

- 反射开（场景视图、反射 pass）：P13b2。
- 〔g1 不并进时〕`_rt_MipMappedFrameBuffer`：P13g。
- WPE 运行中改 `reflection` 不重建渲染器（`FUN_140115a90`），我们随设置变化整场重新加载，结果一样。

## 实施记录（2026-11-14）

**实现**：sonnet 执行代理在独立工作树 `ignore/p13/b1/wt`（基于 HEAD `69dc573f`）里改 `apps/wpe-scene`，在主工作区改 Rust 设置、设置页与 i18n；Claude 验收后三方合并进主工作区（祖先取工作树基点）。`compile/bundle.ts`、`compile/features.ts` 和 P12a 的未提交改动冲突在同一处（`checkProgramFeatures` 的第 4 个参数 `allowedCombos`），两边都留，`mipSlots` 排第 5。和子计划的出入：
- `ReflectionTargets.create` 没有读者时返回 null；`resize` 写了、`GpuScene` 没接（场景目标与快照同样不原地换尺寸，透视场景画布变了整场重新加载），P13b2 要原地换时再接；提前返回的判断由 Claude 改正（原来只要任一张对得上就返回）。
- 用户纹理槽落在 `_rt_Reflection` 上而没有模型读时，照报的仍是 `usertextures:rendertarget:runtime`，没随棋盘格改成 `placeholder`（都照报、语料 0 处）。
- 跟随时只在场景里有读者才读 `config.json`，没有反射的场景不多读文件。

**验收**（Claude 独立做）：
1. 范围：工作树 16 个文件、主工作区 12 个设置文件，没有越界。
2. tsc 0 error；vitest 工作树 155 / 156 个文件通过，主工作区与「撤掉本节的同一份工作区副本」同时跑，两边都只有 `pipeline.test.ts` 失败（单独跑是 `3293687972` 的读取上限，并行跑是超时），本节新增的测试全过。主工作区第一次跑时 `host*` 失败一百多条，是 P6c 会话正在改 `host.ts` 的瞬时状态，几分钟后重跑两边都全过。
3. 变异 13 / 13 检出（`ignore/p13/b1/mutations.py`，`kbp mutate --mode workspace`，源码按原字节还原）。
4. 语料（197 个工程，`ignore/p13/b1/corpus-{head,after}.json`）：干净 100 → 108；去掉的只有 `texture:rendertarget:_rt_Reflection`（7 张）、`_rt_MipMappedFrameBuffer`（3 张）、`uniform:g_Texture3MipMapInfo`（2 张）、`uniform:g_Texture0MipMapInfo`（1 张），没有新增键。
5. 确定性工程对 WPE（`render_scene` 画布 1920×1080，`kbp cmp frame --kbp-layers`）：r1、r3（棋盘格）、r5（运行中改的清屏色，半数向下取的 25、76 也一样）、r7 整帧 0 差异；r4 只差 RenderDoc 叠在没画到区域的文字；r6（HDR）反射图 (255, 127, 64, 255) 与泛光前的场景目标（FP16）和 WPE 逐值相同（只差 FR、CLK），上屏的 ≤ 4 级差在两个四边形里外都有、背景最大，来自泛光链。
6. **按 FINAL_CHECK 走查**（三张都是只有几个模型的小场景、全部对象都和反射图有关，用 `kbp content unpack --instrument` 整张复制，不删对象）：WPE fps 20、后处理超高、反射关，1920×1080 各录 5 帧（`A:\p13b1\<名>-kbp-fps20-1920x1080`），`renderFrames.ts` 按日志逐帧回放（`--scripts --postprocess ultra`，audiophile 加 `--audio` 录到的频谱）：

| 场景 | 帧 | > 0 | > 2 | 最大 | 判定 |
|---|---|---|---|---|---|
| arsenal | 232–236 | 2459–7542 | 1–11 | 74 | 已解释 |
| audiophile | 236–240 | 188–645 | 14 | 18 | 已解释 |
| fantasticcar | 232–236 | 229–1615 | 0–3 | 75 | 已解释 |

- 读反射图的地面（arsenal 的 planks、另两张的 grid）内部逐像素相同；arsenal 的 `LIGHTMAP` 第二套 UV 也就此核对（P13a 风险 3）。
- 逐 draw 对常量（`trace_vs_wpe.py`，我们的轨迹对 `kbp rdc consts`）：三张场景每个 draw 的绘制顺序一一对上，除相机矩阵外全部逐值相同（音频数组、材质常量、灯）；`g_ViewProjectionMatrix` / MVP 差 2.4e-7（audiophile）、4.8e-7（fantasticcar）、1.3e-6（arsenal），`g_EyePosition` 差 ≤ 2.4e-7，来自相机路径的单精度求值（P5d）。
- > 2 级的像素全是孤立单点，落在局部对比度 ≥ 27 的几何边上（`edge_test.py`：24 + 70 + 8 个里 80 个能用「边界挪一点」直接解释，其余在混色的边上或细线断开处）。audiophile 的 14 个点每帧相同：没有声音时 `audiophile.vert` 把柱子压成零高度，留下退化的细三角形，由 1 ulp 量级的顶点差决定盖不盖像素中心。三类都归已知差异「网格边上的覆盖翻转」（P13a 的 A）。这次没有逐像素重建顶点位置（P13a 的 `edge_check.py` 做过一次），依据是常量逐值比对与差异只在边上。
- 1–2 级的差（每帧几百到几千个像素）散在光照与泛光的渐变上，归「着色与泛光的舍入」（P13a 的 B、P2b 的泛光）。

7. 恢复：测试行 14826–14833 已用 `projects_remove` 移除并核对；WPE 设置没改（`reflection: false`、fps 20、后处理超高都是用户原值）；对照用的副本 `ignore/p13/b1/chk` 先拆联接、复查为 0 再删。

**没做**：
- 设置页切三档（回归 R4）：运行中的 dev 构建还没有 `get_wpe_scene_reflection`（Rust 改动要重新构建，不重启别人的进程），宿主读失败按跟随处理。等用户重启 dev 后看。
- 原壁纸整张的走查在 P13 收尾统一做。
