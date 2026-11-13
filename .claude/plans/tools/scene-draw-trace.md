# 场景渲染器的逐 draw 轨迹（2026-11-13 用户）

起因：`FINAL_CHECK.md` 的走查要求每一处和 WPE 的像素差都落到具体的 draw 与具体的值。WPE 那边有 RenderDoc 逐 draw 的数据（顶点、常量、渲染目标、管线），我们这边只有最终图、`host.texts()` / `host.state()` 的汇总和单测里的假设备。`2903412088` 的走查（`ignore/p6/b1e/make_e3clock.mjs`）停在这里：去掉 effect 的变体仍差 12 个像素，WPE 的上屏 draw（`A:\p6b\e3clock-nofx\e3clock-nofx-frame240.rdc` 事件 59）的 MVP、顶点、UV 都拿到了，我们这边拿不到对应的数。

用户定的做法（按推荐）：
- 轨迹放进探针的结果，REST / MCP 存成 JSON 文件；
- 用 GPU 调用代理记录，不在渲染路径里埋点；
- 先做探针 `renderFrame` 的读回帧，实时宿主的「下一帧记一次」顺带。

## 总体设计思路

探针渲染一帧时，把交给 `GpuScene.build` 和编码用的 `GPUDevice` 换成一层记录用的代理（`render/trace.ts`）。代理只做两件事：
- 把调用原样转给真对象，返回真对象；
- 把看到的东西记进登记表。

真对象照常交给 WebGPU，所以渲染路径、着色器、资源一个都不变。没要轨迹时探针不包设备，读回的像素逐字节同以前。

登记表按真对象存（`WeakMap`）：
- **缓冲**：描述，加上一份影子字节。`queue.writeBuffer` 与 `mappedAtCreation` 写进去的都同步到影子里；
- **纹理**：描述。追踪期间给每张纹理补上 `COPY_SRC`，pass 结束后才能读回；
- **视图**：属于哪张纹理、哪一级 mip、哪一层；
- **采样器、着色器模块、管线**：管线记标签、拓扑、各目标的混合、顶点缓冲布局、深度；
- **绑定组**：每个 binding 是哪个缓冲（偏移、大小）、视图或采样器。

命令编码器与渲染 pass 也包一层，记录：
- pass 的目标、load / store、清屏值；
- 每个 draw 当时的管线、绑定组（含动态偏移）、顶点 / 索引缓冲、视口、裁剪；
- `copyTextureToTexture` 等拷贝。

draw 引用的缓冲内容**在 `queue.submit` 那一刻**从影子里取：WebGPU 的语义是提交前的写入对这次提交里的全部 draw 可见，编码之后、提交之前的写入也算。

解码有两路：
- **uniform**：按反射解码成「名字 → 值」。反射在建 uniform 缓冲的地方登记：`scene.ts`、`bloom.ts` 各一处，调 `traceUniforms(buffer, entries)`，非 dev 构建是空操作；
- **顶点**：按管线的顶点缓冲布局解码，索引也解码。条数有上限，缺省取前 64 个被引用的顶点，同 RenderDoc 的 `vs_in`。

字段名尽量对齐 `wpe-renderdoc` 读 WPE 抓帧时的输出（`render_targets`、`viewports`、`color_blends`、常量的名字与值、`vs_in` 的逐属性列），以后好做「两边逐 draw 对齐、报第一处不同」（`kbp cmp draws`，不在本次范围）。

可选的读回：按 pass 下标，或按 pass 标签 / 目标纹理标签的子串，选中的 pass 结束后在同一个编码器里把目标拷出来，和最终图一起存进探针的结果区。rgba8 存 PNG；rgba16float 存原始 float32，同 `scheduleReadback`。

## 现状锚点

a. 探针拿设备、建场景、编码读回帧，设备原样传下去（`dev/probe.ts` `renderFrame`）
```ts
const gpu = await acquireGpu();
// …
const scene = await GpuScene.build(gpu.device, bundle, state, gpu.features, [], { /* … */ });
// …（profile 帧、回放帧都在同一个设备上编码）
const encoder = gpu.device.createCommandEncoder({ label: "probe frame" });
scene.encode(encoder, state);            // 现状：读回那一帧，没有任何逐 draw 的记录
```

b. draw 分发集中在一处（`render/scene.ts` 约 3436–3454），pass 的标签已带图层与步骤
```ts
pass.setPipeline(item.pipeline);
pass.setBindGroup(0, this.bindGroupOf(item));
pass.setVertexBuffer(0, item.vertexBuffer);
// mesh / text：setIndexBuffer + drawIndexed；rope：draw(maxVertices, count)；粒子：drawIndexed(count·6)；其余 draw(4)
const pass = encoder.beginRenderPass({ label: item.label, colorAttachments: [/* 合成 RT / fbo */] }); // 标签如 `layer 179 VHS Time and Date text glyphs`
```

c. uniform 缓冲建在两处，反射（`UniformEntry[]`，名字、类型、偏移、数组步长）只在 `UniformBlock` 里，GPU 缓冲上没有（`render/scene.ts` 约 2317–2337、`render/bloom.ts` 约 386–395）
```ts
block = new UniformBlock((program.result.uniforms ?? []) as UniformEntry[], program.uniformSize);
uniformBuffer = this.own(device.createBuffer({ label, size: block.data.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
device.queue.writeBuffer(uniformBuffer, 0, block.data);   // 现状：缓冲上看不出各字段在哪
```

d. 探针结果的大块数据走存放区，REST 按键分块取回（`dev/probe.ts` `storeProbeBytes` / `probeChunk`，`scripts/kabegame-dev/scene.ts` `renderFrame` 末尾 `probeBytes(s, handle, \`${key}.png\`)`）。

## 点 1 — 记录器（新增 `render/trace.ts`、`render/trace.test.ts`）

- **新增**
```ts
export interface TraceOptions {
  /** 选哪些 pass 在结束后读回目标：pass 下标，或 pass 标签 / 目标纹理标签里的子串；缺省不读回。 */
  readback?: (number | string)[];
  /** 每个 draw 解码多少个被引用的顶点（缺省 64）。 */
  maxVertices?: number;
}
export interface DrawTracer {
  /** 包过的设备：建资源、编码都用它；返回的都是真对象。 */
  device: GPUDevice;
  /** 从现在起记 pass 与 draw（之前的只进登记表）；探针在读回帧编码之前调。 */
  startFrame(): void;
  /** 停止记录，等读回完成，给出这一帧的轨迹与读回的图。 */
  finish(): Promise<{ trace: DrawTrace; readbacks: TraceReadback[] }>;
}
export function createDrawTracer(device: GPUDevice, options?: TraceOptions): DrawTracer;
/** 建 uniform 缓冲处登记反射（非 dev 构建是空操作）。 */
export function traceUniforms(buffer: GPUBuffer, entries: readonly UniformEntry[]): void;
```
- **轨迹的形状**（JSON，ID 在一次 `renderFrame` 里按创建顺序编号，标签照抄）：
```ts
interface DrawTrace {
  version: 1;
  resources: {
    textures: Record<string, { label: string; size: number[]; format: string; mipLevelCount: number; usage: number }>;
    samplers: Record<string, { label: string } & GPUSamplerDescriptor>;
    pipelines: Record<string, { label: string; topology: string; vertex: VertexLayout[]; targets: { format: string; blend?: GPUBlendState; writeMask: number }[]; depth?: object; shaders: { stage: string; module: string; entryPoint: string }[] }>;
  };
  passes: {
    index: number;
    label: string;
    colorAttachments: { texture: string; mip: number; layer: number; loadOp: string; storeOp: string; clearValue?: number[] }[];
    depthAttachment?: object;
    draws: {
      index: number;               // 帧内全局序号
      pipeline: string;
      viewport?: number[]; scissor?: number[]; blendConstant?: number[];
      call: { kind: "draw" | "drawIndexed"; count: number; instances: number; first: number; baseVertex?: number; firstInstance: number };
      bindings: { group: number; binding: number; kind: "buffer" | "texture" | "sampler"; id: string; label: string; offset?: number; size?: number; view?: { mip: number; layer: number } }[];
      uniforms?: Record<string, number | number[]>;   // 登记过反射的 uniform 缓冲，按名字解码
      rawUniforms?: { binding: number; f32: number[] }[]; // 没登记的：按 float32 原样给
      indices?: number[];                              // 前 maxVertices 个
      vertices?: Record<string, number[][]>;           // 按属性（location / 格式）解码，前 maxVertices 个被引用的顶点
    }[];
    readback?: string;            // 存放区的键
  }[];
  copies: { order: number; kind: string; src: string; dst: string; size: number[] }[];
}
```
- 代理覆盖的调用：
  - `GPUDevice`：`createBuffer` / `createTexture` / `createSampler` / `createShaderModule` / `createRenderPipeline(Async)` / `createBindGroup` / `createCommandEncoder` / `queue`；
  - `GPUQueue`：`writeBuffer` / `writeTexture` / `copyExternalImageToTexture` / `submit`；
  - `GPUTexture.createView`；
  - `GPUBuffer` 的 `getMappedRange` / `unmap`；
  - `GPUCommandEncoder`：`beginRenderPass` / `copy*` / `finish`；
  - `GPURenderPassEncoder`：各 `set*`、`draw*`、`end`。

  不认识的方法原样转发。代理绝不能被当参数交给 WebGPU：WebGPU 会做品牌检查，代理会被拒。
- **说明**：不改全局原型，只包传进来的那个设备，同一页面里的实时宿主不受影响。

## 点 2 — 反射登记（修改 `render/scene.ts`、`render/bloom.ts`）

- **修改** 两处建 uniform 缓冲之后各加一行 `traceUniforms(uniformBuffer, entries)`，`entries` 就是传给 `UniformBlock` 的那份。不改别的。

## 点 3 — 探针（修改 `dev/probe.ts`）

- **修改** `RenderFrameOptions` 加 `trace?: boolean | TraceOptions`：
  - 给了就在 `acquireGpu()` 之后建 `createDrawTracer(gpu.device, …)`，`build`、profile 帧、回放帧、读回帧、画布上屏都用 `tracer.device`；
  - 读回帧（含 `encodeCanvasBlit`）编码之前 `startFrame()`，读回完成后 `finish()`；
  - 轨迹 JSON 存成 `<key>.trace.json`，读回的图存成 `<key>.pass<下标>.png`（或 `.f32`）。
- **修改** `RenderFrameResult` 加 `trace?: { key: string; passes: number; draws: number; readbacks: { pass: number; key: string; width: number; height: number; format: string }[] }`，只在要了轨迹时给。没要时设备不包，逐字节同以前。

## 点 4 — 实时宿主（修改 `host.ts` / `dev/install.ts`，可选）

- 宿主加载时 `localStorage["kabegame-dev-scene-trace"] === "1"` 才把渲染器的设备包上（只在 dev 构建）。
- `host.traceNextFrame(options)` 记下一帧，返回同样的结果、存进存放区；没包设备时报错，说明要先设开关再加载。
- 不值得的话这一点可以不做，在实施记录里说明。

## 点 5 — vite REST（修改 `scripts/kabegame-dev/replay.ts`、`scene.ts`、`types.ts`，测试 `replay.test.ts`、`rest.test.ts`）

- **修改** 渲染请求收 `trace`：`true`，或 `{ readback?: (非负整数 | 非空字符串)[], maxVertices?: 1–4096 的整数 }`，不认识的字段照旧 400。
- **修改** `renderFrame`：
  - 原样转给探针；
  - 要了轨迹而 `meta.trace` 不在时回 409（宿主产物没重建）；
  - 用 `probeBytes` 取 `<key>.trace.json` 与各读回图，响应加 `trace`（解析后的 JSON）与 `traceImages: { pass, format, width, height, data(base64) }[]`；
  - 总量超过 64 MB 回 413。

## 点 6 — MCP（修改 `apps/kabegame-dev-mcp/src/tools.ts`，测试 `particles.test.ts` 或新文件）

- **修改** `render_scene` / `host_render` 加 `trace: { save: <目录，相对仓库根>, readback?: (number | string)[], maxVertices?: number }`：
  - 把 `trace.json` 和 `pass-<下标>.png` / `.f32` 写进这个目录；
  - 结果里加一行：pass 数、draw 数、读回了哪些 pass、目录；
  - 轨迹内容不放进会话。

## 点 7 — 文档

- `.claude/skills/kabegame-chromium/SKILL.md`：REST 表的 `render` 行与 MCP 两个工具的说明，加一节「逐 draw 轨迹」（字段、怎么和 RenderDoc 对照、读回）。
- `cocs/wpe/WPE_SCENE.md`：dev 探针那几处提一句。
- `.claude/plans/wpe-import/3-scene/FINAL_CHECK.md`：「工具」表「差异解释」一行，把「我们这边的绘制轨迹」从缺的挪到有的；`kbp cmp draws` 仍缺。
- `versions/latest/changelog.md` 开发侧一行；`versions/latest/regression.md` 一节，行先留 `[ ]`，我真机后勾。

## 验收

- 单测（`render/trace.test.ts`，假 GPU 对象）：
  - 代理返回真对象、转发参数原样；
  - 登记表：缓冲、纹理、视图、管线、绑定组；
  - 影子字节：`writeBuffer` 带偏移与 `dataOffset`、`mappedAtCreation` + `unmap`；
  - **提交时取值**：编码后、提交前的写入可见，提交之后的写入不进这一帧；
  - `startFrame` 之前的 pass / draw 不记；
  - uniform 解码：标量、`vec3` 的 16 字节对齐、`mat4`、数组步长、没登记时给原始 float32；
  - 顶点格式：`float32x2/x3/x4`、`unorm8x4`、`uint32`；
  - 索引：`uint16` / `uint32`，按 `firstIndex` / `baseVertex` 取；
  - 读回的选择：下标、标签子串，以及给纹理补 `COPY_SRC`；
  - 不认识的方法原样转发。
- 探针：没要轨迹时不建记录器（可以抽一个判断函数单测）。
- REST（`deno test -A --no-check scripts/kabegame-dev/`）：`trace` 的校验、409、取回与 413。MCP：写文件与结果行。
- 变异检查：提交时取值改成编码时取、uniform 偏移差一、`startFrame` 不生效、读回不补 `COPY_SRC`、代理对象漏给 WebGPU。
- tsc 0 error、vitest 全过（已知的 `pipeline.test.ts` 那条除外，失败明细不变）、Prettier。
- **真机（我）**：`e3clock-nofx` 渲染一帧带轨迹：
  - 黑字层上屏那个 draw 的 MVP、顶点、UV 和 WPE 事件 59 对照；
  - 读回黑字层的合成 RT，和 WPE 的 RT 7128 逐像素比；
  - 用这些把那 12 个像素落到具体的 draw 与值，接着把 `2903412088` 的走查做完。

## 实施方式

在工作区快照里做（`kbp snapshot export WORKTREE`）：工作区里有还没提交的 1e-3 和别的会话的改动，`probe.ts` 等文件都在里面。宿主之外的文件（`scripts/kabegame-dev/`、`apps/kabegame-dev-mcp/`、SKILL.md、文档）拷一份工作副本、再留一份祖先。子代理实现，我复核、三方合并、真机验收；提交等你同意。

## 实施记录（2026-11-13，子代理实现）

计划：`.claude/plans/tools/scene-draw-trace.md`。宿主改动在快照 `ov/src`（祖先 `base/src`），宿主之外在工作副本 `x/`（祖先 `xbase/`）。
补丁：`trace.patch`（`kbp snapshot diff base ov`，7 个文件，+3124 / −13）、`trace-x.patch`（`make_x_patch.py`：`git diff --no-index xbase x`，去掉 `node_modules`
联接带出来的 2 块，路径改成相对仓库根，13 个文件）。

### 做了什么

### 点 1 — 记录器（新增 `render/trace.ts`、`render/trace.test.ts`）

- **新增** `createDrawTracer(device, { readback?, maxVertices? })` → `{ device, startFrame(), finish() }`，`traceUniforms(buffer, entries)`，以及测试与探针用的纯函数
  `decodeUniforms`、`readVertexAttribute`、`convertReadback`。
  - 包的方式：
    - 设备与队列是 `Proxy`（`forwardingProxy`）：认识的调用先原样转给真对象、再记；不认识的方法以真对象为 `this` 调用（缓存绑定后的函数），
      getter / setter 的接收者也是真对象（`device.label = …`、`onuncapturederror` 照常）。
    - 建出来的纹理、缓冲、命令编码器、render pass、命令缓冲都是**真对象**原样返回；要记的方法（`createView`、`getMappedRange` / `unmap`、
      `beginRenderPass`、`copyBufferToBuffer` / `copyBufferToTexture` / `copyTextureToBuffer` / `copyTextureToTexture`、`clearBuffer`、`finish`，
      pass 的 `setPipeline` / `setBindGroup` / `setVertexBuffer` / `setIndexBuffer` / `setViewport` / `setScissorRect` / `setBlendConstant` /
      `setStencilReference` / `draw` / `drawIndexed` / `draw*Indirect` / `end`）用 `Object.defineProperty` 加在**这个实例**上，转调原型上的原方法。
      不改全局原型。
    - 记录出错都进 `errors`，不影响转发（`guard`）；不在记录时（建场景、profile 帧）出的错攒着（最多 100 条），下一次 `finish()` 并进去、带「（记录之外）」
      前缀。先转发、后记录（`unmap` 例外：先把映射区拷进影子再转发，转发后 ArrayBuffer 会被分离）。
  - 登记表（`WeakMap`，按真对象）：缓冲（描述 + 影子字节，第一次写时建）、纹理、视图（纹理 / mip / 层）、采样器、着色器模块、管线（标签、拓扑、
    剔除、正面、顶点缓冲布局、各目标的格式 / 补齐缺省值的混合 / `writeMask`、深度、着色器）、bind group layout（带动态偏移的 binding）、
    bind group（每个 binding 是哪个缓冲 + 偏移 + 大小、视图或采样器）。不经记录器建的纹理 / 缓冲按对象自己的属性补登记（没有影子）。
  - 影子：`queue.writeBuffer`（`dataOffset` / `size` 对 TypedArray 按元素、对 ArrayBuffer 与 DataView 按字节）、`mappedAtCreation` / 映射写入；
    命令缓冲里的 `copyBufferToBuffer` / `clearBuffer` 记成编码器事件，`submit` 时按顺序应用。`MAP_READ` 缓冲不进影子。
  - **提交时取值**：`submit` 时按命令缓冲、按编码顺序处理事件，pass 里的 draw 当场从影子解码成数组（视图读、不拷贝），之后影子再变也不影响。
  - `startFrame` 之前只进登记表；之后才记 pass、draw、拷贝（含队列上的 `writeTexture` / `copyExternalImageToTexture`）与引用到的资源。
  - 解码：uniform 按登记的反射（规则同 `UniformBlock`：偏移、数组步长、矩阵列步长、声明分量数；`parseShape` / `declaredComponents` 从
    `uniforms.ts` 引），没登记的按 float32；顶点按管线布局（`float*` 含半精度、`(u|s)int`、`(u|s)norm` 8/16/32 位与 x2/x3/x4、`unorm10-10-10-2`、
    `unorm8x4-bgra`），索引按 `uint16` / `uint32` 从 `firstIndex` 起、行 = 索引 + `baseVertex`，按实例步进的属性按实例号取；都只取前 `maxVertices` 个。
  - 读回：选中的 pass（下标，或 pass 标签 / 颜色附件 0 的纹理标签的子串）`end()` 之后，用原型上的 `copyTextureToBuffer` 在同一个编码器里把颜色附件 0
    当时那一级 mip、那一层拷进真设备直接建的读回缓冲；`finish()` 映射取出（带行填充 → 紧排，bgra 换 rgba，半精度查表展开）。格式不认识、附件纹理
    不是经记录器建的、没有 COPY_SRC、命令缓冲没提交时不拷，pass 写 `readbackError`。
  - `traceUniforms`：`typeof __SCENE_DEV__ === "undefined" || !__SCENE_DEV__` 时直接返回。
- **轨迹 JSON**：见下「和计划不同处」第 4 条的扩展；其余字段同计划。

### 点 2 — 反射登记（`render/scene.ts`、`render/bloom.ts`）

- **修改** 两处建 uniform 缓冲之后各加一行 `traceUniforms(uniformBuffer, (program.result.uniforms ?? []) as UniformEntry[])`（就是传给 `UniformBlock` 的那份），
  外加一行 import。别的没改。

### 点 3 — 探针（`dev/probe.ts`，新增 `dev/drawTrace.ts`、`dev/drawTrace.test.ts`）

- **新增** `dev/drawTrace.ts`：`traceOptionsOf`（没要轨迹时 null：不建记录器、设备不包；形状不对抛错）、`encodeRgbaPng`（逐字节保真的 RGBA PNG，
  `CompressionStream("deflate")` + CRC32，每行过滤 0）、`traceArtifacts`（读回图编码、写进 pass 的 `readback`、轨迹 JSON、摘要）、`isTraceKey`。
- **修改** `probe.ts`：
  - `RenderFrameOptions.trace?: boolean | TraceOptions`；参数先查（编译之前）。
  - 取到设备后 `tracer = traceOptions ? createDrawTracer(gpu.device, …) : null`，`device = tracer?.device ?? gpu.device`；`GpuScene.build`、profile 帧、
    读回帧、`encodeCanvasBlit`、`scheduleReadback`、`queue.submit` / `onSubmittedWorkDone`、读回画布的错误作用域都用 `device`。没要轨迹时它就是
    `gpu.device`，调用序列逐个相同。`limits`、`destroy` 仍用 `gpu.device`。
  - 读回帧编码之前 `startFrame()` 并压一层 `validation` 错误作用域；读回完成后弹出、`finish()`，校验错误记进轨迹的 `errors`（不抛）。
  - 存 `<key>.trace.json`、`<key>.pass<下标>.png` / `.f32`；每次渲染先清掉同键旧的轨迹文件（`dropTraceBytes`）。
  - `RenderFrameResult.trace?: RenderFrameTrace`（`key`、`bytes`、`passes`、`draws`、`errors`、`readbacks[{ pass, key, width, height, format, bytes }]`、
    `readbackErrors`），只在要了轨迹时有。

### 点 4 — 实时宿主

没做，见「没做」。

### 点 5 — vite REST（`x/scripts/kabegame-dev/`）

- `replay.ts`：`checkTrace`（`true` 或 `{ readback?, maxVertices? }`；`readback` 是非负整数或非空字符串、最多 64 项；`maxVertices` 是 1–4096 的整数；
  不认识的字段 400，`field` 指到那一项），`checkRenderReplay` 收 `trace`；常量 `TRACE_FIELDS`、`MAX_TRACE_READBACKS`、`MAX_TRACE_VERTICES`。
- `scene.ts`：`renderFrame` 原样转 `trace`；要了而 `meta.trace` 不是摘要时 409 `[host]`（`traceMeta`）；按摘要报的大小先判 64 MB（`MAX_TRACE_BYTES`），超了
  413 不取；取回轨迹 JSON 与各读回图（取回后按实际大小再判一次），响应加 `trace`（解析后的 JSON）与 `traceImages`。
- `types.ts`：`RenderTraceRequest`、`RenderTraceMeta`、`RenderDrawTrace`、`RenderTraceImage`，`RenderRequest.trace`、`RenderMeta.trace`、
  `RenderResponse.trace` / `traceImages`。
- `rest.ts` 不用改：渲染路由把请求体交给 `checkRenderReplay` 与后端，`shapeRender` 展开整个响应、`trace` 照回。

### 点 6 — MCP（`x/apps/kabegame-dev-mcp/src/tools.ts`）

- `RENDER_FIELDS.trace`（zod：`save` 非空字符串、`readback` 最多 64 项、`maxVertices` 1–4096，`strict`）；`traceRequestOf`（只给 `save` 时发 `true`，
  `save` 不发）；`renderBody` 两条路径都带；`writeTrace` 把 `trace.json`（紧凑 JSON）与 `pass-<下标>.png` / `.f32` 写进 `save` 目录，结果加一行摘要；
  REST 没回轨迹（vite 是旧的）报 `[local]`。两个工具的描述与文件头。

### 点 7 — 文档（`x/` 下）

- `SKILL.md`：工具表的 `host_render` / `render_scene` 两行、新增「逐 draw 轨迹」一节（文件、字段、取值时刻、uniform、顶点、读回、和 RenderDoc 对照、
  护栏、没做的）、REST 表 `render` 行。
- `WPE_SCENE.md`：「链路隔离验证（dev 探针）」的 `renderFrame` 一条与「dev 探针与对比台」表各加一句。
- `FINAL_CHECK.md`：「工具」表「差异解释」一行，我们这边的绘制轨迹挪到「有的」；缺的剩 `kbp cmp draws` 与实时宿主的「下一帧」。
- `changelog.md` 开发侧 Added 一行；`regression.md` 顶部一节 T1–T7，全部 `[ ]`。

### 和计划不同处

1. **实例上加方法，不是每个对象都套代理。** 计划写「代理返回真对象」「命令编码器与渲染 pass 也包一层」。真对象要能照常交给 WebGPU，又要拦
   `createView`、`beginRenderPass`、pass 的 `set*` / `draw*`，只能在实例上加同名自有方法（原型不动）。只有设备和队列是 `Proxy`：它们从不作为参数
   交给 WebGPU（探针里没有 `context.configure`）。
2. **COPY_SRC 只在要读回时、只补给带 RENDER_ATTACHMENT 的单采样颜色纹理。** 计划写「追踪期间给每张纹理补上」。读回只读 pass 的颜色附件，别的纹理补了
   没用、只多一份副作用；深度不读回。场景现有的颜色目标（场景目标、合成 RT、fbo、泛光 RT、读回画布）本来都带 COPY_SRC，实际会被补的只有
   `render/textures.ts` 里为 `copyExternalImageToTexture` 带 RENDER_ATTACHMENT 的图片 / 视频纹理。轨迹里的 `usage` 记渲染器要的那份。
3. **读回只拷颜色附件 0。** 场景里没有多目标 pass；多附件要另起键名，没做。
4. **轨迹 JSON 比计划多的字段**（都是对照时要用的，计划的字段都在）：
   - `resources.buffers`（绑定、顶点 / 索引缓冲引用的缓冲）；`resources` 只列这一帧引用到的资源；
   - 管线的 `cullMode`、`frontFace`，`blend` 补齐缺省值（`add` / `one` / `zero`），`depth` 给 `depthCompare` / `depthWriteEnabled` / `depthBias`；
   - pass 的 `encoder`（编码器标签）、`submit`（帧内第几次提交，没提交为 null）、`readbackError`，颜色附件带纹理 `label`；
   - draw 的 `stencilReference`、`dynamicOffsets`、`vertexBuffers`、`indexBuffer`；`viewport` / `scissor` 总给生效值（没设时是附件那一级整张，便于和
     RenderDoc 的 `viewports` 比）；
   - `rawUniforms` 带 `group`；一个 draw 绑了几块登记过的 uniform 时名字前加「组.绑定.」（场景里没有）；
   - `vertices` 的键是 `loc<location>:<格式>`，按实例步进的加 `@instance`；
   - `copies[].order` 定义为「这次拷贝之前帧内已开始了几个 pass」，队列上的纹理写入 `kind` 带 `queue.` 前缀；
   - 顶层 `errors`（记录器自己的错、读回帧的 WebGPU 校验错误）。
5. **PNG 不走画布。** 探针原有的 `encodePng` 经 2D 画布，画布按预乘存，半透明像素的颜色会被量化、alpha 为 0 的颜色直接丢。合成 RT 带 alpha，要和
   RenderDoc 存的 RT 逐像素比，所以另写了逐字节保真的 `encodeRgbaPng`。主帧 PNG 仍用原来的，不变。
6. **摘要多 `bytes`。** `meta.trace.bytes` 与每张读回图的 `bytes`：vite 据此在取回之前判 64 MB、超了不取（取回后按实际大小再判一次）。另有 `errors`
   条数与 `readbackErrors`，MCP 的结果行用。
7. **读回帧多一层错误作用域（只在要轨迹时）。** 读回帧的校验错误不抛、记进轨迹 `errors`：这一帧本身画坏了正是要查的东西。读回画布那层原有的作用域
   照旧抛。
8. **探针每次渲染都清掉同键旧的轨迹文件**（不论要没要轨迹）：vite 固定用 `kbdev-<句柄>` 作键，否则旧的读回图会一直留在宿主内存里。只删本功能建的键，
   不影响读回的字节。
9. **参数：`trace: false` 回 400**（计划只说收 `true` 或对象）；`readback` 最多 64 项（计划没写上限）；探针也查同样的形状（`maxVertices` 1–4096），记录器
   内部钳到 0–4096。
10. **MCP 的 `trace.json` 写紧凑 JSON、同名文件覆盖**，目录里别的旧文件不删，结果行列出这次写了哪些文件。REST 没回轨迹时整次报 `[local]`（画面已渲染、没落盘）。
11. **`traceImages` 每项多 `kind`（`png` / `f32`）与 `bytes`。**
12. **测试另加在 `scene.test.ts`**（计划写 `replay.test.ts`、`rest.test.ts`）：转发、取回、409、413 是 `scene.ts` 的 `renderFrame` 做的，它的单测在这里，
    同第 5、6 批。
13. **`decodeUniforms` 抄了 `UniformBlock` 的列步长规则**，没改 `uniforms.ts` 去导出：点 2 要求「不改别的」。两份规则有互逆单测（`UniformBlock.set`
    写、`decodeUniforms` 读，逐值相等）。
14. **读取不拷贝。** 提交时按视图从影子读（粒子的顶点缓冲可能几 MB，每个 draw 拷一份太贵）；半精度读回查表（4K HDR 目标三千多万个分量）。

### 测试

| 项 | 结果 |
|---|---|
| tsc（`ov/tsconfig.json`） | 0 error（`tsc-after.log` 为空） |
| vitest（`KABEGAME_WPE_ROOT` 设好；`ov` / `base` 里自带的 `wpefont.wasm` 两边相同，没另拷，也就没删） | `base`：122 个文件、2917 条，1 败；`ov` 改前：同 `base`；`ov` 改后：124 个文件、2945 条，1 败。失败的都是 `pipeline.test.ts`「全部场景编译、P1 / P2a 解锁、读取及请求次数有界」（`2251857160: 读取 82208839 字节`、`2251857160: 553 次请求`、`3413921910: 335 次请求`、`3830255100: 219 次请求`），改后与 `base` 的失败明细逐行相同。多出的 28 条全是新增的（日志 `vitest-base.log`、`vitest-ov-before.log`、`vitest-ov-after.log`） |
| deno test（`x/`） | 改前：47 组 195 步过、1 败（`main.test.ts` 读不到 `x/.mcp.json`，x 里没有这个文件）；改后：48 组 202 步过、同一处 1 败。临时拷入 `.mcp.json` 再跑（跑完删掉）：改前 48 组 197 步全过，改后 49 组 204 步全过（`x-test-before*.log`、`x-test-after*.log`） |
| deno check | `tools.ts`、`scene.ts`、`replay.ts` 等通过；对 `x` 全部 TS 跑时只有没动过的 `resources.ts` 报 7 个 TS7006（SDK 回调参数隐式 any）。把 `xbase` 原样拷一份、建同样的 `node_modules` 联接再查，同样 7 个，所以是工作副本经联接解析 SDK 类型的环境问题；仓库里同一组文件 `deno check` 通过。拷贝查完先 `rmdir` 联接、确认仓库依赖还在，再删拷贝 |
| Prettier（`--ignore-path ignore/p6/b1e/empty.prettierignore --check`） | 15 个改动 / 新增的 TS 文件通过（md 不在仓库的 Prettier 范围） |
| 生产构建 | `prod-build/check.mjs`：用宿主的 vite 按 `__SCENE_DEV__` 构建一个只调 `traceUniforms` 的入口。`false`：入口函数成了 `function aB(I) { return I; }`，记录器独有的字符串一个都没有；`true`：调 `aB(I, […])`、`aB` 是 `ZB.set(I, g)`（WeakMap） |
| 变异（宿主） | `mutations.py`，`kbp mutate` 快照模式：15 处全部检出、全部还原，`ov/src` 整树哈希前后相同（`mutate-host.txt` / `.json`）。含计划的五条：提交时取值改成编码时取（另加「改成 finish 时取」）、uniform 偏移差一（一个分量、一个字节两种）、startFrame 不生效（从不开始记、一开始就在记两种）、读回不补 COPY_SRC、代理对象漏给 WebGPU（不认识的方法 `this` 是代理、`createBuffer` 返回代理两种）；另有 unmap 先转发、漏加 `baseVertex`、实例属性按顶点取、`traceUniforms` 不看 `__SCENE_DEV__`、记录之外的错丢掉、探针把 `false` 当成要了轨迹 |
| 变异（x） | `mutate_x.py`：11 处全部检出、按原字节还原，`x` 整树哈希（不含 `node_modules`）前后相同（`mutate-x.txt` / `.json`）：`trace` 不认识的字段不拒、`maxVertices` 收 0、渲染请求不查 `trace`、不转给探针、旧宿主不报 409、不先判 64 MB、读回图不进响应、MCP 把 `save` 发给 REST、不写读回图、旧 vite 不报 `[local]`、不把 `trace` 交给 REST |
| 补丁 | `git apply --check trace.patch` / `trace-x.patch` 对当前工作区：`probe.ts`、`changelog.md`、`regression.md` 打不上——快照之后别的会话改了它们（`probe.ts` 多了 P5d 透视相机 +52 / −15，`changelog.md` +20 行，`regression.md` +245 行），其余文件干净。要三方合并 |

新增用例：

- `render/trace.test.ts`（21 条）：
  - 代理：返回真对象、参数原样（含不读回时纹理描述原样）；不认识的方法与属性原样转发、`this` 是真对象（自定义方法、`limits` getter、`label` setter、
    `pushErrorScope`、队列 `onSubmittedWorkDone`、编码器 / pass 的调试方法、管线的 `getBindGroupLayout`）；`createRenderPipelineAsync` 的结果照样登记。
  - 登记表：纹理 / 视图 / 采样器 / 缓冲 / 管线 / bind group / 附件逐字段；登记出错不影响转发、记录之外的错在 `finish` 时并进 `errors`；动态偏移按
    layout 的 `hasDynamicOffset` 升序；`startFrame` 之前的 pass、draw、拷贝不记、也不读回，写入照常进影子。
  - 影子与提交时取值：`writeBuffer` 的缓冲偏移与 `dataOffset` / `size`；`mappedAtCreation`（假缓冲 `unmap` 时分离 ArrayBuffer）；编码后提交前的写入可见、
    提交后的不进；同一命令缓冲里 `copyBufferToBuffer` 前后的 draw；没提交的 pass。
  - uniform：`decodeUniforms` 与 `UniformBlock` 互逆（标量、vec3 对齐、mat4、数组步长、mat3 列步长、i32）；登记过的按名字解码；`__SCENE_DEV__` 为假时
    `traceUniforms` 是空操作。
  - 顶点与索引：`float32x2/x3`、`unorm8x4`、`uint32`、实例步进；`uint16` / `uint32` 索引、`firstIndex`、`baseVertex`、索引缓冲偏移、`maxVertices`；
    `readVertexAttribute` 的半精度 / snorm / 10-10-10-2 / bgra / 越界 / 不认识的格式。
  - 读回：下标与标签子串选中、补 COPY_SRC（深度、非附件不补，轨迹记原用途）、mip 1 那一级、rgba16float 展开、读回缓冲用完销毁；格式不认识 / 附件纹理
    不经记录器 / 没提交时写原因不拷；`convertReadback` 去行填充、bgra。
  - 假 GPU 带品牌检查：对象登记在 `WeakSet`，方法的 `this` 和对象参数不在里面就抛 TypeError；假队列 `submit` 时执行拷贝，源纹理没有 COPY_SRC 时命令缓冲无效。
- `dev/drawTrace.test.ts`（7 条）：`traceOptionsOf`（不给 / `false` 为 null、`true` 与对象、形状不对抛错）、`encodeRgbaPng`（用 `node:zlib` 解开逐字节相同，
  alpha 为 0 的颜色保留）、`traceArtifacts`（键、pass 的 `readback`、摘要）、`isTraceKey`。
- `replay.test.ts`：`checkTrace` 的合法写法与各项 400（1 步）；`scene.test.ts`：转发、取回、没给不带、400 不碰页面、409、413 不取（1 步）；
  `rest.test.ts`：路由转发、`trace` / `traceImages` 原样回（带 `resize` 也回）、400、409、413（1 步）；
  `particles.test.ts`：新增一组 4 步（落盘与结果行、只给 `save` 发 `true`、`host_render`、旧 vite 报 `[local]`、SDK 拒绝坏形状、`traceRequestOf`）。

### 没做

- **点 4（实时宿主「下一帧记一次」）**：渲染器的设备在 `SceneRenderer` 里（`renderer.ts`），`context.configure({ device })` 要真设备（代理会被品牌检查拒），
  画布的 `getCurrentTexture()` 不经记录器、读不回，还要在 `render()` 里插开始 / 结束的钩子——要改 `renderer.ts` 这条生产路径，不只是计划写的
  `host.ts` / `install.ts`。计划允许不做，探针的读回帧已经覆盖走查要的确定性对照。SKILL 与 `FINAL_CHECK.md` 里写明没有。
- `kbp cmp draws`（两边逐 draw 对齐、报第一处不同）：不在本次范围。
- 真机全部没验（约定由用户做），regression 的 T1–T7 都留 `[ ]`：
  - 代理在真 WebGPU 上会不会被品牌检查拒（单测用的是自己写的品牌检查）；
  - 补 COPY_SRC 的副作用（只在要读回时、只给颜色附件类纹理，实际只波及图片 / 视频纹理）；
  - `createRenderPipelineAsync`：探针每次新建 `GpuScene`，程序与管线缓存都在场景实例上、都经记录器建，应当都登记得上；Dawn 内部若对相同描述的管线去重、
    返回同一个 JS 对象，登记表里那一项会被后一次覆盖（描述相同，内容不变）——真机看轨迹里 draw 的 `pipeline` 是否都不为 null；
  - 带轨迹时画面与不带时逐字节相同（T3）。
- 没有改 `x/apps/kabegame-dev-mcp/package.json`、`x/scripts/vite-debug-server.ts`（不需要）。

### 产物

`ignore/tools/draw-trace/` 下：`trace.patch`、`trace-x.patch`、`make_x_patch.py`、`mutations.py`、`mutate-host.txt` / `.json`、`mutate_x.py`、`mutate-x.txt` / `.json`、
`prod-build/`（生产构建核对）、`check_eol.py`（LF / UTF-8 核对）、`tsc-after.log`、各测试日志、本记录。

## 复核（Claude，2026-11-14）

**越界**：真实工作区里子代理没动任何文件。

**复跑**：
- 快照 tsc 0 error；
- `render/trace.test.ts`、`dev/drawTrace.test.ts`、`render/text.test.ts`、`render/bloom.test.ts` 104 条全过。

**合并**：快照之后 HEAD 进了 P5d 步骤 2（透视相机，改了 `probe.ts`）与 P8 步骤 4（改了 `scene.ts`），另有用户的界面改动。按文件三方合并（祖先取快照基线 `base` / `xbase`），冲突三处，都是两边在同一处各加了东西：
- `probe.ts` 的导入：取 HEAD 的多行 `particleCorners` 导入，加上本次的 `drawTrace` 一行；
- changelog、回归：两边都留，用户的在前。

合并后：
- 工作区 tsc 0 error；
- `deno test -A --no-check scripts/kabegame-dev/ apps/kabegame-dev-mcp/src/` 49 组 204 步全过。

**真机**（重建宿主产物）：
- **vite 读到旧 `scene.ts`**：写回文件时 vite 中途自己重载了插件，读到的是旧的 `scene.ts`。表现是带 `trace` 的请求既没有轨迹，也没回 409。更新一下这个文件的修改时间、让 vite 再重载一次就好了。以后合并 `scripts/kabegame-dev/` 后要确认 vite 重载的是全部新文件。
- **`e3clock-nofx`（图片 14504）带 `trace: { readback: ["layer 179"] }`**：
  - 8 个 pass、7 个 draw，`errors` 为空；
  - 画面 SHA-256 和旧产物不带轨迹时相同（`5c3077…`）。

  结构和 WPE 一一对应，每层三步：清合成 RT、画字形、拷快照后上屏。
- **对照 WPE**：
  - 黑字层画完字形的合成 RT 和 WPE RT 7128（事件 59）RGBA 0 差异；
  - 上屏 draw 的顶点与 UV 逐位相同；
  - MVP 的 x 平移差 1 个 float32 ulp，y 按各自视口：我们画进 3840×2160 再 blit 裁 15 行，WPE 直接画 3840×2130；
  - 三角形对角线不同：我们是三角形带，对角线右下–左上；WPE 是索引列表，对角线左下–右上；
  - 四个顶点按 1/256 子像素对齐后，落在窗口上两边重合。

点 4（实时宿主）没做，理由见实施记录；`kbp cmp draws` 不在本次范围。
