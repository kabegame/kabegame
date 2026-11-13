# P11a — 音频 uniform（子计划）

> 上级：[phase-11-audio-media.md](phase-11-audio-media.md)「P11a — 音频 uniform」。步骤 0 已做完（整节一次）：读码 [rea-p11-textures.md](rea-p11-textures.md) 第 6 节、[rea-p4e-audio.md](../phase4/rea-p4e-audio.md) 3.4 / 4.3；实测 [p11-REPORT.md](p11-REPORT.md)「音频 uniform」。
> 开发在 HEAD 快照的副本里做（`ignore/p11/a/head` 基线、`ignore/p11/a/ov` 副本，HEAD `005de3cb`），做完 `kbp snapshot diff` 出补丁，`git apply --3way` 移进工作区（2026-11-13 用户：「你可以和其他会话一样在 ignore 里另起一个目录改」）。
> 现状行号按 HEAD `005de3cb`。

## 总体设计思路

WPE 的六个 `g_AudioSpectrum{16,32,64}{Left,Right}` 就是渲染线程每帧归一化后的三块频谱（rea-p4e-audio 3.4：常量填充函数把 `ctx` 里的数组按 `4n` 字节拷进常量缓冲；p11-REPORT：32 / 16 段由 64 段逐级取最大、左右各自、没声明开关时全 0）。P4e 已经把这三块做成了渲染器的 `SceneSpectrum`，每帧在粒子步进之前推进一次，粒子与脚本缓冲都读它。所以 P11a 只是把同一份数组再交给 uniform：
- **每帧内置量**：`FrameInput` 加一个可选的频谱（`L16 … R64` 六个数组，`SceneSpectrum` 本身就满足这个形状），`frameBuiltins` 照它写六个名字；没给时写全 0。渲染器把自己的 `spectrum` 交给 `GpuScene.update`。值的打包交给已有的 `UniformBlock.set`：翻译器把 `uniform float g_AudioSpectrum16Left[16]` 反射成 `array<vec4<f32>, 16>`、`declared: "float"`（每个元素只用 `.x`，步长 16，步骤 0 用真翻译器确认），`set` 按 `declared` 每个元素写一个值。
- **能力表**：六个名字进 `ENGINE_UNIFORMS`，`checkProgramFeatures` 不再报 `uniform:g_AudioSpectrum*`。`p2a.test.ts` 的「内置表与渲染器写的值一一对应」照旧成立（`frameBuiltins` 不给频谱时也写这六个名字）。
- **订阅**：`bundle.audio` 从「声明了开关且有音频粒子」扩成「声明了开关，且有音频粒子或有程序读这六个 uniform（翻译结果里没标 `unused`）」。宿主照旧按它订阅 `WpeMediaHub`；被拒（没声明开关、非 Windows）时频谱全 0，和 WPE 没声明开关时一致。非 Windows 是待做项，代码里已标 `TODO:[WPE_SCENE]`。
- **帧里的位置**：频谱在帧开头推进，`update` 在脚本之后写每帧内置量，所以 uniform、粒子、脚本这一帧读的是同一份值，同 WPE（rea-p4e-audio 3.5：音频段紧挨在帧函数之前，帧内不变）。补画帧帧时间为 0、频谱不推进，uniform 写的还是上一次的值。

不另做的：麦克风输入、WPE 的 `audioinputthreshold` / `audioinputvolume`（P4e 已定只开回环）；平均声道（WPE 没有对应 uniform）。

## 现状锚点

**a. 引擎 uniform 表没有音频**（`apps/wpe-scene/src/compile/features.ts:67`）
```ts
export const ENGINE_UNIFORMS: ReadonlySet<string> = new Set([
  "g_ModelViewProjectionMatrix",
  // …
  "g_PointerState",
  "g_ParallaxPosition", // 现状：没有 g_AudioSpectrum*，读到就报 uniform:g_AudioSpectrum16Left 等
]);
```

**b. 每帧内置量没有频谱**（`render/uniforms.ts:634`）
```ts
export function frameBuiltins(frame: FrameInput): Record<string, number[]> {
  return {
    g_Time: [frame.time],
    // … g_Frametime、g_Daytime、g_PointerPosition、g_PointerPositionLast、g_PointerState
    g_ParallaxPosition: frame.parallax ?? [0.5, 0.5], // 现状：到此为止
  };
}
```

**c. 渲染器有频谱，但不交给 `update`**（`render/renderer.ts:581`、`:609`）
```ts
    this.spectrum.advance(this.options.audioFrame?.() ?? null, frametime); // 现状：粒子与脚本读它
    // …
      scene.update(
        { time: wrapped, frametime, daytime: daytimeOf(new Date()), pointer: this.pointer, pointerLast: this.pointerLast,
          cursor, parallax: this.parallax.position }, // 现状：没有频谱
        state,
      );
```

**d. 订阅判定只看粒子**（`compile/bundle.ts:1879`）
```ts
  bundle.audio =
    project.general?.supportsaudioprocessing === true &&
    bundle.layers.some((layer) => layer.particle !== null && particleUsesAudio(layer.particle)); // 现状：读 uniform 的程序不算
```

**e. 探针回放只注入 16 段给粒子**（`particles/audio.ts:40`、`dev/particleCorners.ts:383`）
```ts
export interface ParticleAudioFrame {
  left: ArrayLike<number>; // 现状：只有 16 段左右，写进粒子频谱；uniform 不读它
  right: ArrayLike<number>;
}
// replayReadback：读回帧
  if (particles?.dts.length) replayAudio(scene, particles, particles.dts.length - 1);
  // … scene.update({ time, frametime, … }) —— 现状：没有频谱
```

## 步骤 1 — 接线（能力表、每帧内置量、订阅）

- **修改** `compile/features.ts`：新增 `AUDIO_UNIFORMS`（六个名字，导出），并进 `ENGINE_UNIFORMS`。
```ts
/** 音频频谱（P11a，rea-p4e-audio 3.4）：渲染器每帧从场景频谱写（`frameBuiltins`），没有音频时全 0。 */
export const AUDIO_UNIFORMS: readonly string[] = [
  "g_AudioSpectrum16Left", "g_AudioSpectrum16Right",
  "g_AudioSpectrum32Left", "g_AudioSpectrum32Right",
  "g_AudioSpectrum64Left", "g_AudioSpectrum64Right",
];
export const ENGINE_UNIFORMS: ReadonlySet<string> = new Set([
  // …
  "g_ParallaxPosition",
  ...AUDIO_UNIFORMS, // 新增
]);
```
- **修改** `render/uniforms.ts`：`FrameInput` 加 `audio?: SpectrumUniforms`（`L16 R16 L32 R32 L64 R64`，`ArrayLike<number>`）；`frameBuiltins` 返回值的类型放宽成 `Record<string, ArrayLike<number>>`，六个名字照频谱写，没给时写共享的全 0 数组。
```ts
export interface SpectrumUniforms {
  L16: ArrayLike<number>; R16: ArrayLike<number>;
  L32: ArrayLike<number>; R32: ArrayLike<number>;
  L64: ArrayLike<number>; R64: ArrayLike<number>;
}
export function frameBuiltins(frame: FrameInput): Record<string, ArrayLike<number>> {
  const audio = frame.audio ?? SILENT_SPECTRUM; // 新增
  return {
    // … 原有七项
    g_AudioSpectrum16Left: audio.L16, // 新增：直接给数组引用，UniformBlock.set 按反射逐个写
    // … 其余五项
  };
}
```
- **修改** `render/scene.ts`：`frameValues` 与 `applyFrame` 的类型跟着放宽（`block.set` 本来就收 `ArrayLike`）。
- **修改** `render/renderer.ts`：`scene.update({ …, audio: this.spectrum })`。
- **修改** `compile/bundle.ts`：`bundle.audio` 加上「有程序读音频 uniform」；判定函数 `readsAudioUniforms(result)` 放 `features.ts`（和 `checkProgramFeatures` 同一处读反射，`unused` 的不算）。
- **测试**：
  - `p2a.test.ts`：原来拿 `g_AudioSpectrum16Left` 当「没实现的引擎 uniform」的两处换成别的名字；新增「音频 uniform 不报」。
  - `uniforms` 的单测：`frameBuiltins` 给频谱时六个名字的值就是那六个数组、不给时全 0、长度 16 / 32 / 64；用步骤 0 的真实反射（`array<vec4<f32>, 16>`、`declared: "float"`）建 `UniformBlock`，写进去后第 i 个值在 `offset + 16 i`。
  - `bundle.audio`：声明开关 + 只有程序读音频 → true；没声明 → false；读了但标 `unused` → false；P4e 原有的粒子用例照旧。
- **语料**：`kbp corpus scan` 新旧两份比，去掉的只有 `uniform:g_AudioSpectrum*`，其余场景逐张不变；能渲染数照实写（只做 P11a 时预计 49 → 49，HEAD 有变化以实测为准）。

## 步骤 2 — 走查（按 `FINAL_CHECK.md`：先补工具，再对着录制的 WPE 帧逐帧逐像素比）

2026-11-14 改写。原来的验收里有「放音乐时频谱条跟着动（真机，人眼）」，按 `FINAL_CHECK.md` 原则第 1 条不算结论，只当接线的冒烟检查
（2026-11-14 已做，见实施记录）。走查样本是步骤 1 新解锁的三张真实壁纸，各做一份复制工程（原则第 5 条），外加步骤 0 的生成工程。

**样本与复制工程**（`ignore/p11/a/walk/make_copy.py`：从 `kbp content unpack --instrument` 的解包目录复制，只留下面的对象、它们的整条父链与 FR，
留下的对象一字不改，属性取缺省值）：

| 壁纸 | 留的对象 | 读音频 uniform 的 draw（WPE 抓帧） |
|---|---|---|
| `3502090109` Liberty | 80 `Audio bar`（composelayer + Simple_Audio_Bars + blurprecise） | Simple_Audio_Bars 读 64 段左右 |
| `3585875739` Miku Monitoring | 17（6 个 effect，`lens_distortion` 的 `chromaticAberration` 挂着读 16 段音频缓冲、带平滑的字段脚本） | 色差 / pulse / shake 读 16 段，示波器读 32 段 |
| `3825170583` 少女 | 153 `音阶`，119 `整体` 下的 476 `后3`、395 `前3` | Simple_Audio_Bars 读 32 段（`test_shader` 的音频在 combo 外，没读） |

Liberty 另外三个对象的 `shake` 没开 `AUDIOPROCESSING`、不读音频，不留。

**要补的工具**（录制与回放的输入要齐：时间、光标已有；缺频谱与脚本写的材质常量）：

- **T1 录制**：`kbp rdc consts` 加 `--no-clock`。真实壁纸解包的工程只有末尾一个只写日志的 FR、没有 CLK，原来的 `clock` 认前两个绘制是 FR / CLK
  会报错；`--no-clock` 时帧号取 RenderDoc 帧号 + 1（同 unpack 的约定），时间与光标从 `[kbp]` 日志取，全部绘制都收常量。
- **T2 探针**：`ParticleAudioFrame` 加可选的 `left32` / `right32` / `left64` / `right64`（粒子照旧只读 16 段）；`replayReadback` 读回帧把截至这一帧的
  频谱（null 沿用前一帧）交给 `update` 的 `audio`，16 段取 `left` / `right`，32 / 64 段取新字段，没给的为 0；不给 `audio` 时和以前逐字节相同。
- **T3 REST**：`render` 的 `replay.timeline` 收 `audio`（录制文件路径：`kbp rdc consts` 的输出，或带 `frames[].audio` 的 `kbp rdc track` 轨迹）。按帧号对齐成
  逐帧的 `audio`：录到的帧取当帧被读到的数组（同一帧各 draw 的同名数组要相同，不同就报错），没读到的段按 WPE 的取法往下推（32 段 = 64 段两两取大，16 段 =
  32 段两两取大，步骤 0 实测），推不出的为 0；没录到的帧为 null（沿用前一帧）。读回帧必须录到，否则报错。`meta.audio` 写明录到的帧，以及读回帧每个数组是
  录到的、推出来的还是没有。
- **T4 MCP**：`render_scene` 的 `replay.timeline.audio` 原样转给 REST，结果里写一行频谱的来源。
- **T5 材质常量的脚本值**：`scriptValues` 多一种写法 `{ object, constant: <材质键>, effect?: <effects 下标>, value }`，按 `owner.kind === "material"`、同图层、同材质键
  找字段脚本（同一图层多个 effect 都有这个键时必须给 `effect`），经它的 `constant` 绑定目标写进状态，同宿主的脚本写回。WPE 那边的值从抓帧的材质常量读
  （Miku 是 `u_aberration`）。

**走查**：每张复制工程 WPE 连抓 4 帧（20 fps、1920×1080、后处理关闭，同 WPE 当前设置）；我们这边用 `render_scene` 按日志的帧时间与光标、录制的频谱、
（Miku）录制的 `u_aberration` 逐帧回放到每一个抓到的帧，`canvas` 取抓帧窗口尺寸；WPE 的图用 `kbp rdc frame --present`；每帧整帧逐像素比（`kbp cmp frame`），
每处差异定位到 draw 与值（我们这边用 `render_scene` 的 `trace`，WPE 那边用抓帧），归到已知差异或 bug。

**验收：** 三张复制工程的 12 帧和步骤 0 的生成工程，每帧逐像素相同，或差异逐处有解释（写进实施记录）；工具的单测；`kbp regress --corpus` 两份源码只差
`uniform:g_AudioSpectrum*`。

## 收尾

- `cocs/wpe/WPE_SCENE.md` 的场景频谱一段补 uniform；回归文档与 changelog（「新增可渲染的场景壁纸」按实际解锁数写）。
- 和别的会话的交界：步骤 1 改 `features.ts`、`uniforms.ts`、`scene.ts`、`renderer.ts`、`bundle.ts`，都是共享文件，只加接线；补丁移进工作区前先看这几个文件的工作区状态。

## 实施记录

### 步骤 1 — 接线（2026-11-13，在 `ignore/p11/a/ov` 里做完，补丁 `ignore/p11/a/step1.patch`，未移进工作区）

**改动**（9 个文件，照上面的步骤 1）：`features.ts` 的 `AUDIO_UNIFORMS` 进 `ENGINE_UNIFORMS`、新增 `readsAudioUniforms`；`uniforms.ts` 的 `FrameInput.audio` / `SpectrumUniforms`、`frameBuiltins` 写六个数组（直接给数组引用，没给时全进程共用的全 0 数组）；`scene.ts` 两处类型放宽；`renderer.ts` 把 `this.spectrum` 交给 `update`；`bundle.ts` 的 `bundle.audio` 加上读音频 uniform 的程序。

**反射核对（步骤 0 补）：** 用真翻译器翻 `p11-audio` 的 CLK 着色器，六个 uniform 都是 `array<vec4<f32>, N>`、`declared: "float"`、`stride 16`（顶层声明仍是补齐的形态，P7b 的打包只作用于 `main` 之前的文本），`UniformBlock.set` 每个元素写 `.x`，不用改。

**测试：**
- `p2a.test.ts`：原来拿 `g_AudioSpectrum16Left` 当「没实现的引擎 uniform」的两处换成遗留灯的 `g_LightsPosition`（P13 才写）；新增「六个音频 uniform 不报、`readsAudioUniforms` 只认被读且不是材质常量的」。「内置表与渲染器写的值一一对应」照旧通过。
- `render.test.ts`：`frameBuiltins` 不给频谱时六个全 0、长度 16 / 32 / 64；给 `SceneSpectrum` 时值就是它的六个数组（同一个引用），按步骤 0 的真实反射写进 `UniformBlock` 后第 i 个值在 `offset + 16 i`、`.yzw` 为 0。
- `children.test.ts`：程序读音频 uniform 且声明了开关 → `bundle.audio` 为真；标了 `unused` → 假；没声明开关 → 假；都不报不支持。
- `pipeline.test.ts` 的请求次数上限 200 → 240：3825170583 不再在音频 uniform 处提前退回、编到底要 216 次；HEAD `005de3cb` 上 3830255100 已经是 219 次（这条在 HEAD 上本来就失败）。两张都逐条记过请求，路径与区间全不重复，是资源本身多。
- 工作副本：tsc 无错；带 `KABEGAME_WPE_ROOT` 全量 111 个文件、2739 个用例通过。基线快照不带语料是 2509 个通过。

**语料**（183 个工程，`kbp corpus scan` 两份源码，`ignore/p11/a/corpus-diff.txt`）：去掉的只有六个音频键（32 段 40 张、64 段 34 张、16 段 21 / 20 张），没有新增的键；能渲染 66 → 69，新增 `3502090109`（Liberty）、`3585875739`（Miku Monitoring）、`3825170583`（少女）。两个默认工程 `audiophile`、`demon_core` 还差透视相机（P5d）与反射 / 遗留灯（P13）。

**踩到的坑：** 在这台机器上，工具的工作目录有时是小写盘符 `d:\`，vitest 会把同一个文件按 `d:/` 与 `D:/` 认成两个模块，测试文件拿到第二份没初始化的 vitest，报 `Cannot read properties of undefined (reading 'config')` 或 `failed to find the current suite`。用 `cd /D/…` 进目录、`--config` 给大写盘符的绝对路径就稳定。

**还没做：** 移进工作区与提交（等用户同意）；真机核对（放音乐时频谱条跟着动，要把补丁移进工作区、跑 dev）；步骤 2。

**更正（2026-11-14）：** `3585875739`（Miku）只是编译期判成能渲染：示波器 effect 的顶点输出超过 16 个（`audioValue_16` 在 location 16），建管线时
WebGPU 报 `infringes limits`，要等 P7e 步骤 2（超过 16 个时打包）。语料扫描不建管线，所以没看出来。步骤 1 实际新解锁 2 张（Liberty、少女）。
2026-11-14 真机冒烟时以为 Miku 在实时渲染，其实看到的是退回的预览图（`host.stats()` 的帧时间是 0 就是信号）。

### 步骤 1 移进工作区与冒烟（2026-11-14）

- 补丁去掉 `pipeline.test.ts` 一处（HEAD 上别的会话已把上限放到 450）后移进工作区（只改文件、不进暂存区），`deno task --cwd apps/wpe-scene build
  --mode development` 重建宿主。
- 冒烟（不算验收，`FINAL_CHECK.md` 原则第 1 条）：用户放着音乐，Liberty（13597）的预览订阅成功、频谱非 0，三张截图里频谱条高度不同。

### 步骤 2 — 工具（2026-11-14，独立工作树 `ignore/p11/a/wt` 里做，HEAD `5889b490` + 步骤 1；补丁 `ignore/p11/a/tools-v2.patch`，已三方合并进工作区）

- **T1** `kbp rdc consts --no-clock`（`kbp.py`、`py/rdc_host.py`、`rdc/consts.py`）。走查中又补一条：反汇编里 `dynamicIndexed` 的常量缓冲整个收、
  名字另记 `dynamic`。起因是少女的 `test_shader` 在 `main` 之前的循环里读 `g_AudioSpectrum64*[i]`，RenderDoc 把这两个数组标 `referenced: false`，
  录制缺了它们，回放时 64 段是 0、光环整个没画（第一次比 48% 的像素不同）。补上后差异全部消失（见下）。
- **T2 探针**：`ParticleAudioFrame` 加 32 / 64 段；`replayReadback` 读回帧把截至这一帧最后一个非 null 的频谱交给 `update`（`readbackSpectrum` /
  `replaySpectrum`，没给的段 0，舍入 float32）；回放之前先查段数。
- **T3 REST**：`particles.audio`（渲染、四角、轨迹三处）按段数与键校验，`SPECTRUM_BANDS`。
- **T4 MCP**：`timeline.audio` 读录制（consts 或带 `frames[].audio` 的轨迹），按帧号对齐、往下推 32 / 16 段（两两取大）、同帧各绘制要相同、读回帧
  必须录到；时间线摘要写来源。`render_scene` / `host_render` / `particle_corners` / `particle_track` 都转。
- **T5 材质常量的脚本值**：探针与 REST 的 `scriptValues` 收 `{ object, constant, effect? }`，按图层与材质键找 `kind: "constant"` 的字段脚本，同
  宿主的脚本写回；同图层多个 effect 有同名键时要给 `effect`。
- 文档：kbp-tools 与 kabegame-chromium 的 SKILL.md。
- 测试：`replayPointers.test.ts`（读回帧的 uniform、段数报错）、`scriptValues.test.ts`（材质常量四项）、`replay.test.ts`（REST 两项）、
  `timeline.test.ts`（解析、推段、对齐、报错、buildTimeline）、`particles.test.ts`（MCP 转发）。工作树：宿主 tsc 无错、vitest 2716 个通过，
  两层 `deno test` 50 组通过，`deno check` 通过；合并进工作区后同样通过（工作区里 `probe.ts` 有别的会话的 `DEBUG` 插桩报一处 tsc 错，不是本次的）。
- 本会话的 MCP 进程还是旧代码（要重连才有 `timeline.audio`），走查用 `ignore/p11/a/walk/render.ts` 直接调 REST，时间线用新的 `buildTimeline`。

### 步骤 2 — 走查（2026-11-14，进行中）

复制工程先用 `ignore/p11/a/walk/make_copy.py` 手写，之后和别的会话新加的 `kbp content isolate` 比过，三张的对象与 `general` 完全相同。WPE 20 fps、
后处理关闭、1920×1080 窗口各抓 4 帧（`A:\p11a\audio-<id>-fps20-1920x1080`），频谱与常量用 `kbp rdc consts --no-clock` 取
（`ignore/p11/a/walk/out/wpe-<标签>-consts.json`），帧时间与光标取 FR 日志。

| 壁纸 | 结果 | 差异与解释 |
|---|---|---|
| Liberty `3502090109`（场景 3840×2160） | 第 198 帧：整帧 35846 个像素差（最大 15）；逐 draw：compose 0、音频条 pass 7 个像素差 1、横向模糊 16 个差 1 | 音频条 pass 的 7 个：照着色器用 numpy 复算整张 pass，两边各自离精确值的偏差分布完全相同（超出 0.5 级的部分最大 0.058，>0.02 的 4047 个分量、>0.05 的 330 个，两边一样），离舍入中点 < 0.05 级的 20158 个分量里只有这 7 个取整不同，它们离中点 0.010–0.044 级：fxc 与 Tint 编出来的浮点求值顺序不同，只在舍入中点上分叉。模糊 pass：8 个是那 7 个的传播（距离 ≤ 2），另 8 个离中点 0.024–0.057 级（按小数位置的双线性采样，同一类）。整帧的大差在最后上屏：WPE 按窗口分辨率直接画（RT 1920×1080），我们先画 3840×2160 的场景目标再缩（已知差异，`FINAL_CHECK.md` 的例子）；想在同分辨率下比，WPE 开不出 3840×2160 的测试窗口（被屏幕夹到 3840×2130，抓到的后备缓冲对不上，工具丢弃）。**已定（2026-11-14 用户）**：接受为已知差异，不另做模拟 WPE 上屏的证明 |
| 少女 `3825170583`（场景 1920×1080，和窗口同尺寸） | 4 帧整帧 45 / 56 / 51 / 90 个像素差，最大 1 | 第 198 帧逐 draw：音频条 pass（ev35）**0 差**；最早的差在 waterripple（ev55）的 alpha，35 个像素差 1；之后 scroll 上屏 13 个、compose 拷背景、`test_shader`、opacity 都是它的传播（`test_shader` 输出的差异全部落在输入差异的同一位置）。waterripple 的输出是按扰动后的小数坐标对音频条结果做双线性采样，35 个都在条的 alpha 边缘，和模糊同一类；**还没量化**（要解码法线贴图复算扰动）。`g_Time` 两边 float32 相同（10.064929962158203） |
| Miku `3585875739` | 建不了管线 | 见上面的更正，等 P7e 步骤 2 |

**待办：** waterripple 35 个像素的量化；Miku 等 P7e；测试行（14522–14524）走查完用 `projects_remove` 删；
生成工程（步骤 0 的 `p11-audio`）按同一套工具走一遍。
