/**
 * 风险 7 的验收工具（P4a 步骤 4，dev 专用，经 `window.__kabegameSceneProbe.particleCorners` 调用）：拿到「我们翻译出的粒子
 * 顶点着色器」对当前粒子算出的四角，和 WPE 几何着色器的 `gs_out` 比。
 *
 * WebGPU 没有几何着色器，也没有变换反馈，顶点阶段的输出读不回来。翻译器产出的顶点 WGSL（naga 的 GLSL 前端输出）结构固定：
 * 着色器主体在 `main_1()` 里，读写模块级的 `var<private>`；入口 `@vertex fn main(@location(n) …) -> VertexOutput` 只是把输入
 * 抄进私有变量、调 `main_1()`、把输出打包返回，`VertexOutput` 里有一个 `@builtin(position)` 成员。所以：
 * 1. 入口改成普通函数：去掉 `@vertex`、参数与返回类型上的 IO 属性，改名 `kb_corner_vertex`；
 * 2. 加一个 `@compute` 入口：按顶点布局从存储缓冲读出各输入，调用它，把 `@builtin(position)` 那一项写回存储缓冲；
 * 3. uniform 与纹理的绑定照旧在 group 0（布局可见性换成 COMPUTE），两个存储缓冲在 group 1。
 * 改写只动入口，着色器主体逐字不变，算的就是渲染时的同一段代码、同一块 uniform。
 */
import type { SceneBundle } from "../compile/bundle";
import { compileSceneInWorker } from "../compile/client";
import { TextureDecodeCache } from "../compile/decode";
import { FetchSceneReader } from "../compile/fs";
import type { ScenePostprocessSetting } from "../compile/postprocess";
import { injectedR } from "../particles/random";
import { particleSnapshot, type ParticleTrackParticle } from "../particles/track";
import { CORNER_UVS } from "../particles/vertices";
import { acquireGpu } from "../render/device";
import type { PackedVertexAttribute } from "../render/programs";
import { bindGroupLayoutEntries, WGSL_PRELUDE } from "../render/programs";
import { GpuScene, type ParticleOptions } from "../render/scene";
import { SceneState } from "../render/state";

/** 计算入口从顶点缓冲读一个输入：location、在顶点里的 float 偏移、分量数与标量类型。 */
export interface CornerInput {
  location: number;
  offset: number;
  components: number;
  kind: "f32" | "i32" | "u32";
}

/** 由顶点打包结果（`vertexPacking`）得到计算入口的输入表（字节偏移换成 float 偏移）。 */
export function cornerInputs(attributes: readonly PackedVertexAttribute[]): CornerInput[] {
  return attributes.map(({ location, offset, components, kind }) => ({
    location,
    offset: offset / 4,
    components,
    kind,
  }));
}

/** 改写用的名字前缀：翻译器自己的名字以 `kb_` 开头（`kb_max`、`kb_sampler_*`），再加一段避开。 */
const PREFIX = "kb_corner_";

/** 从 `open` 处的 `(` 找到匹配的 `)`。 */
function matchParen(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "(") depth++;
    else if (source[i] === ")" && --depth === 0) return i;
  }
  throw new Error("入口参数表的括号不匹配");
}

/** 按顶层逗号切开（跳过 `<…>` 与 `(…)` 里的逗号），去掉空项。 */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "<" || c === "(") depth++;
    else if (c === ">" || c === ")") depth--;
    else if (c === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

const ATTRIBUTE = /@(\w+)\s*(?:\(([^)]*)\))?\s*/g;

/** 一段声明前面的属性（`@location(0)`、`@builtin(position)`……）与去掉属性后的正文。 */
function takeAttributes(text: string): { attributes: Map<string, string>; rest: string } {
  const attributes = new Map<string, string>();
  const rest = text.replace(ATTRIBUTE, (_, name: string, value: string | undefined) => {
    attributes.set(name, (value ?? "").trim());
    return "";
  });
  return { attributes, rest: rest.trim() };
}

/**
 * 把翻译器输出的顶点 WGSL 改写成计算着色器（字符串层面，纯函数）。`entryPoint` 是顶点入口名（`TranslateResult.vertex.entryPoint`），
 * `inputs` 是顶点布局（`cornerInputs`），`stride` 是每顶点的 float 数。计算入口 `kb_corner_main`，
 * group 1 binding 0 是输入顶点（`array<f32>`），binding 1 是输出的裁剪坐标（`array<vec4<f32>>`，一个顶点一项）。
 * 结构不认识时抛错（说明翻译器输出变了，要重看改写规则）。
 */
export function rewriteVertexAsCompute(
  wgsl: string,
  entryPoint: string,
  inputs: readonly CornerInput[],
  stride: number,
): string {
  if (wgsl.includes(PREFIX)) throw new Error(`顶点着色器里已经有 ${PREFIX} 开头的名字`);
  const escaped = entryPoint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const head = new RegExp(String.raw`@vertex\s+fn\s+${escaped}\s*\(`).exec(wgsl);
  if (!head) throw new Error(`找不到顶点入口 ${entryPoint}`);
  const open = head.index + head[0].length - 1;
  const close = matchParen(wgsl, open);
  const brace = wgsl.indexOf("{", close);
  if (brace < 0) throw new Error("顶点入口没有函数体");
  const between = wgsl.slice(close + 1, brace).trim();
  if (!between.startsWith("->")) throw new Error("顶点入口没有返回类型");
  const returns = takeAttributes(between.slice(2));

  // 参数：去掉 IO 属性，记下每个参数从哪里取值
  const params = splitTopLevel(wgsl.slice(open + 1, close)).map((text) => {
    const { attributes, rest } = takeAttributes(text);
    const colon = rest.indexOf(":");
    if (colon < 0) throw new Error(`读不懂入口参数：${text}`);
    return {
      name: rest.slice(0, colon).trim(),
      type: rest.slice(colon + 1).trim(),
      location: attributes.has("location") ? Number(attributes.get("location")) : null,
      builtin: attributes.get("builtin") ?? null,
    };
  });

  // 位置输出：返回值本身（`-> @builtin(position) vec4<f32>`），或返回结构里带 `@builtin(position)` 的成员
  let output = `${PREFIX}result`;
  if (returns.attributes.get("builtin") !== "position") {
    const struct = new RegExp(String.raw`struct\s+${returns.rest}\s*\{([^}]*)\}`).exec(wgsl);
    if (!struct) throw new Error(`找不到返回结构 ${returns.rest}`);
    const member = splitTopLevel(struct[1])
      .map(takeAttributes)
      .find((item) => item.attributes.get("builtin") === "position");
    if (!member) throw new Error(`返回结构 ${returns.rest} 里没有 @builtin(position)`);
    output += `.${member.rest.slice(0, member.rest.indexOf(":")).trim()}`;
  }

  const args = params.map((param) => {
    if (param.builtin === "vertex_index") return `${PREFIX}index`;
    if (param.builtin === "instance_index") return "0u";
    if (param.location === null) throw new Error(`入口参数 ${param.name} 既不是 location 也不是认得的 builtin`);
    const input = inputs.find((item) => item.location === param.location);
    if (!input) throw new Error(`顶点布局里没有 location ${param.location}（${param.name}）`);
    const components = Array.from({ length: input.components }, (_, k) => {
      const read = `${PREFIX}in[${PREFIX}base + ${input.offset + k}u]`;
      return input.kind === "f32" ? read : `bitcast<${input.kind}>(${read})`;
    });
    return input.components === 1 ? components[0] : `${param.type}(${components.join(", ")})`;
  });

  const signature = `fn ${PREFIX}vertex(${params.map((p) => `${p.name}: ${p.type}`).join(", ")}) -> ${returns.rest} `;
  const body = wgsl.slice(0, head.index) + signature + wgsl.slice(brace);
  return `${body}
@group(1) @binding(0) var<storage, read> ${PREFIX}in: array<f32>;
@group(1) @binding(1) var<storage, read_write> ${PREFIX}out: array<vec4<f32>>;

@compute @workgroup_size(64)
fn ${PREFIX}main(@builtin(global_invocation_id) ${PREFIX}id: vec3<u32>) {
    let ${PREFIX}index = ${PREFIX}id.x;
    if (${PREFIX}index >= arrayLength(&${PREFIX}out)) {
        return;
    }
    let ${PREFIX}base = ${PREFIX}index * ${stride}u;
    let ${PREFIX}result = ${PREFIX}vertex(${args.join(", ")});
    ${PREFIX}out[${PREFIX}index] = ${output};
}
`;
}

export interface ParticleReplay {
  /** 每帧的 `g_Frametime`，`dts[0]` 是第 1 帧（对齐 WPE 脚本帧号）；最后一帧是读回的那一帧。 */
  dts: number[];
  /**
   * 每帧的 `g_Time`（场景时间 `T`，P4b 步骤 4），和 `dts` 等长；和 WPE 比时填日志的 `runtime` 列。不给时按 `dts` 累加（double）。
   */
  times?: number[];
  /** 随机种子：第 i 个粒子层用 `seed + i`（同 `particleTrack`）。缺省 1。 */
  seed?: number;
  /** operator 遍数：WPE 设置 `fps` 在 1–20 时两遍，否则一遍。缺省 1。 */
  passes?: 1 | 2;
  /**
   * 按 `objects` 下标、按出生顺序顶替这个系统抽到的 `R`，用完退回种子随机数（P4b 步骤 2）。`randomframe` 的 frame 就是 `R`，
   * 和 WPE 抓帧逐像素比时填从 WPE 轨迹读出的 frame（`rd-*.json` 的 `TEXCOORD1.w`）。只改 `R`，别的抽取照旧。
   */
  random?: Record<number, number[]>;
}

/** 建场景用的粒子选项：种子缺省 1、遍数缺省 1，`random` 换成每个粒子层一个 `injectedR`。 */
export function replayParticleOptions(replay: ParticleReplay | undefined): ParticleOptions {
  const random = replay?.random;
  return {
    seed: replay?.seed ?? 1,
    passes: replay?.passes ?? 1,
    rOverride: random ? (object) => (random[object] ? injectedR(random[object]) : undefined) : undefined,
  };
}

/**
 * 按 dt 序列回放粒子：前 n−1 帧只步进粒子，返回最后一帧的 `g_Time` 与 `g_Frametime`，由调用方先 `stepParticles` 步进最后一帧、
 * 再 `update`（P4c 步骤 4 起 `update` 不步进粒子）。
 * 每帧的 `g_Time` 取 `times`，没给时是 dt 的累计值（double）；同一个值也作粒子的场景时间 `T`。没有回放时时间取 `time`、
 * 帧时间 0（不步进，就是预热后的状态）。`cursor` 是每帧光标下的场景纹理坐标（控制点跟随指针用，P4c 步骤 2），缺省场景中心。
 */
export function replayParticles(
  scene: Pick<GpuScene, "stepParticles">,
  state: SceneState,
  replay: ParticleReplay | undefined,
  time = 0,
  cursor: readonly [number, number] = [0.5, 0.5],
): { time: number; frametime: number } {
  if (!replay?.dts.length) return { time, frametime: 0 };
  const { dts, times } = replay;
  if (times && times.length !== dts.length)
    throw new Error(`times 有 ${times.length} 项，dts 有 ${dts.length} 项，应等长`);
  let elapsed = 0;
  const timeAt = (i: number) => (times ? times[i] : (elapsed += dts[i]));
  for (let i = 0; i < dts.length - 1; i++) scene.stepParticles(dts[i], timeAt(i), state, cursor);
  return { time: timeAt(dts.length - 1), frametime: dts[dts.length - 1] };
}

export interface ParticleCornersOptions {
  projectDir: string;
  sceneAssets: string[];
  postprocess?: ScenePostprocessSetting;
  userProperties?: Record<string, unknown>;
  /** 粒子层：`objects` 下标或对象名；缺省为全部粒子层。 */
  layer?: number | string;
  particles?: ParticleReplay;
  /** 每层只取前这么多个粒子（按槽序）；缺省全部。 */
  limit?: number;
  /** 结果里带上改写后的 WGSL（排查用）。 */
  wgsl?: boolean;
}

export interface ParticleCornersLayer {
  object: number;
  name: string;
  perspective: boolean;
  /** 存活粒子数（顶点里的粒子数，不受 `limit` 影响）。 */
  count: number;
  /** 每个角点的 UV，顺序同 `corners` 里每个粒子的 4 个角：`(0,0)`、`(0,1)`、`(1,1)`、`(1,0)`。 */
  uv: [number, number][];
  /** 每粒子 4 个角的裁剪坐标 `[x, y, z, w]`（顶点着色器的 `@builtin(position)`，和 WPE `gs_out` 同一空间）。 */
  corners: number[][][];
  /** 同一角的场景像素坐标 `[x, y]`：透视除法后按场景目标尺寸换算，原点左上、y 向下。 */
  pixels: number[][][];
  /** 写进顶点的粒子输入，按槽序，与 `corners` 一一对应。 */
  particles: ParticleTrackParticle[];
  wgsl?: string;
}

/**
 * 编译（强制渲染）、建场景、按 `particles.dts` 回放，然后对每个选中的粒子层：把它的顶点着色器改写成计算着色器，用这一帧的
 * uniform 缓冲与顶点跑一遍，读回每个顶点的裁剪坐标。
 */
export async function particleCorners(options: ParticleCornersOptions): Promise<ParticleCornersLayer[]> {
  const reader = new FetchSceneReader();
  const cache = new TextureDecodeCache(reader);
  const bundle: SceneBundle = await compileSceneInWorker({
    projectDir: options.projectDir,
    sceneAssets: options.sceneAssets,
    userProperties: options.userProperties,
    postprocess: options.postprocess ?? "disabled",
    force: true,
    textureCache: cache,
    reader,
  });
  const gpu = await acquireGpu();
  const device = gpu.device;
  try {
    const state = SceneState.fromBundle(bundle);
    const scene = await GpuScene.build(device, bundle, state, gpu.features, [], {
      ignoreUnsupported: true,
      particles: replayParticleOptions(options.particles),
    });
    try {
      const { time, frametime } = replayParticles(scene, state, options.particles);
      // 最后一帧先步进再写 uniform（顺序同渲染器，P4c 步骤 4）。四角读的是 draw 的 uniform 缓冲（`particleProbe`），世界空间系统
      // 的模型矩阵已是单位阵（`GpuScene.uniformValues`），这里不另算
      scene.sync(state);
      scene.stepParticles(frametime, time, state, [0.5, 0.5]);
      scene.update(
        { time, frametime, daytime: 0.5, pointer: [0.5, 0.5], pointerLast: [0.5, 0.5], cursor: [0.5, 0.5] },
        state,
      );
      const wanted = scene
        .particleStats()
        .filter(
          (item) =>
            options.layer === undefined ||
            (typeof options.layer === "number" ? item.object === options.layer : item.name === options.layer),
        );
      const out: ParticleCornersLayer[] = [];
      for (const { object, name } of wanted) {
        const probe = scene.particleProbe(object);
        if (!probe) continue;
        const { program, layout } = probe;
        const limit = Math.min(probe.count, options.limit ?? probe.count);
        const code = rewriteVertexAsCompute(
          program.result.vertex?.wgsl ?? "",
          program.result.vertex?.entryPoint ?? "main",
          cornerInputs(program.vertexPacking.attributes),
          layout.stride,
        );
        const clip = limit ? await runCorners(device, probe, code, limit) : new Float32Array(0);
        const corners: number[][][] = [];
        const pixels: number[][][] = [];
        for (let p = 0; p < limit; p++) {
          const quad: number[][] = [];
          const screen: number[][] = [];
          for (let k = 0; k < 4; k++) {
            const [x, y, z, w] = clip.subarray((p * 4 + k) * 4, (p * 4 + k) * 4 + 4);
            quad.push([x, y, z, w]);
            screen.push([((x / w + 1) / 2) * scene.width, ((1 - y / w) / 2) * scene.height]);
          }
          corners.push(quad);
          pixels.push(screen);
        }
        out.push({
          object,
          name,
          perspective: probe.perspective,
          count: probe.count,
          uv: CORNER_UVS.map(([u, v]) => [u, v]),
          corners,
          pixels,
          particles: particleSnapshot(probe.system).slice(0, limit),
          wgsl: options.wgsl ? code : undefined,
        });
      }
      return out;
    } finally {
      scene.destroy();
    }
  } finally {
    for (const texture of bundle.textures) for (const mip of texture.mips) mip.bitmap?.close();
    cache.clear();
    device.destroy();
  }
}

/** 跑一遍改写后的计算着色器，返回前 `particles` 个粒子每个顶点的裁剪坐标（每顶点 4 个 float）。 */
async function runCorners(
  device: GPUDevice,
  probe: NonNullable<ReturnType<GpuScene["particleProbe"]>>,
  code: string,
  particles: number,
): Promise<Float32Array> {
  const COMPUTE = 0x4; // GPUShaderStage.COMPUTE
  const module = device.createShaderModule({ label: "particle corners", code: WGSL_PRELUDE + code });
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter((message) => message.type === "error");
  if (errors.length)
    throw new Error(
      `改写后的计算着色器编译失败：${errors.map((m) => `${m.lineNum - 1}:${m.linePos} ${m.message}`).join("；")}`,
    );
  const vertices = particles * 4;
  const groupLayout = device.createBindGroupLayout({
    label: "particle corners group 0",
    entries: bindGroupLayoutEntries(probe.program.result, COMPUTE),
  });
  const storageLayout = device.createBindGroupLayout({
    label: "particle corners group 1",
    entries: [
      { binding: 0, visibility: COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 1, visibility: COMPUTE, buffer: { type: "storage" } },
    ],
  });
  const pipeline = await device.createComputePipelineAsync({
    label: "particle corners",
    layout: device.createPipelineLayout({ bindGroupLayouts: [groupLayout, storageLayout] }),
    compute: { module, entryPoint: `${PREFIX}main` },
  });
  const inputData = probe.vertices.subarray(0, vertices * probe.layout.stride);
  const input = device.createBuffer({
    label: "particle corners in",
    size: Math.max(4, inputData.byteLength),
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(input, 0, inputData.buffer, inputData.byteOffset, inputData.byteLength);
  const output = device.createBuffer({
    label: "particle corners out",
    size: vertices * 16,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    label: "particle corners readback",
    size: vertices * 16,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  try {
    const encoder = device.createCommandEncoder({ label: "particle corners" });
    const pass = encoder.beginComputePass({ label: "particle corners" });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, device.createBindGroup({ layout: groupLayout, entries: probe.entries }));
    pass.setBindGroup(
      1,
      device.createBindGroup({
        layout: storageLayout,
        entries: [
          { binding: 0, resource: { buffer: input } },
          { binding: 1, resource: { buffer: output } },
        ],
      }),
    );
    pass.dispatchWorkgroups(Math.ceil(vertices / 64));
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, vertices * 16);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const result = new Float32Array(readback.getMappedRange().slice(0));
    readback.unmap();
    return result;
  } finally {
    input.destroy();
    output.destroy();
    readback.destroy();
  }
}
