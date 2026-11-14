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
 *
 * rope（P4d 步骤 1）的程序带 `geometry`（翻译器把几何着色器展开进顶点着色器，每段一个实例、`vertex_index` 是第几个输出顶点）：
 * 计算入口的第 `id` 个调用算第 `id / maxVertices` 段的第 `id % maxVertices` 个顶点，按段读输入；除了位置，另把 uv（`v_TexCoord`）、
 * 颜色（`v_Color`）写出，结果按段给出整条带子，和 WPE `gs_out`（还原成带）逐顶点比。几何着色器里 `normalize` 零向量的段整段输出
 * `(2, 2, 2, 1)`（裁剪体外，见翻译器 README），对应 WPE 的 NaN 顶点。
 * ropetrail（P4d 步骤 2）走同一条路：输入里有一个 vec3（`a_TexCoordVec3C2`，按布局的 float 偏移读 3 个分量），段按槽序、每个存活
 * 粒子恒 n 段（`writeTrailSegments`），结果同样按段给出整条带子。
 * 关键帧动画（P10a 步骤 3）：和 `renderFrame` 一样交给 `replayReadback`，沿同一串 dt 推进（没有回放时按第 0 秒写一次），四角看到的
 * `instanceoverride`、图层变换等是动画写过的值。
 * 一个系统多条 renderer（P4f 步骤 4）：每个粒子层按顶层系统的 `draws` 每条各出一项，第 r 项（r ≥ 1）带 `renderer: r`，各用那一条的
 * 变体程序、uniform 与顶点（拖尾那条跳过退化粒子，sprite 那条照写），第 0 项和以前逐字节相同。
 */
import { SceneAnimations, type AnimationHooks } from "../animation/player";
import { stateSink, type ScenePuppets } from "../puppet/player";
import type { SceneBundle, SceneGeneral, SceneLayer } from "../compile/bundle";
import { compileSceneInWorker } from "../compile/client";
import { particleDraws } from "../compile/particles";
import { TextureDecodeCache } from "../compile/decode";
import { FetchSceneReader } from "../compile/fs";
import type { ScenePostprocessSetting } from "../compile/postprocess";
import { writeParticleAudio, type ParticleAudioFrame } from "../particles/audio";
import { injectedR } from "../particles/random";
import type { ParticleSystem } from "../particles/system";
import { particleSnapshot, type ParticleTrackParticle } from "../particles/track";
import { CORNER_UVS, trailDrawable } from "../particles/vertices";
import type { CursorStepInput } from "../render/cursor";
import { acquireGpu } from "../render/device";
import { DEFAULT_CAMERA, type SceneCameraJson } from "../compile/camera";
import {
  cameraObjectLayers,
  initialCameraPathState,
  perspectiveCamera,
  sceneCameraFrame,
  stepCameraSource,
  type CameraPathState,
} from "../render/camera";
import {
  advanceParallax,
  drawParallax,
  initialParallaxState,
  parallaxInput,
  replayParallax,
  type ParallaxState,
} from "../render/parallax";
import { shakeOffset } from "../render/shake";
import type { PackedVertexAttribute } from "../render/programs";
import { bindGroupLayoutEntries, WGSL_PRELUDE } from "../render/programs";
import { GpuScene, type ParticleOptions, type SceneCamera } from "../render/scene";
import { SceneState } from "../render/state";
import type { FrameInput, SpectrumUniforms } from "../render/uniforms";
import { replayPointers, type ReplayPointers } from "./replayPointers";

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

/** `rewriteVertexAsCompute` 的几何着色器展开选项（rope，P4d 步骤 1）。 */
export interface ComputeRewriteOptions {
  /**
   * 程序带 `geometry`（`TranslateResult.geometry.maxVertices`）：第 `id` 个调用是第 `id / maxVertices` 个实例（段）的第
   * `id % maxVertices` 个输出顶点，`vertex_index` / `instance_index` 按此传，输入按实例读（`instance × stride`）。
   */
  maxVertices?: number;
  /**
   * 除 `@builtin(position)` 外另写出的返回结构成员（按名字，如 `v_TexCoord`、`v_Color`）：每个顶点依次占 `1 + outputs.length`
   * 项 vec4，位置在前，不足 4 分量的补 0。
   */
  outputs?: readonly string[];
}

/** 返回结构成员的值转成 vec4（不足 4 分量的补 0）。 */
function asVec4(expression: string, type: string): string {
  const compact = type.replace(/\s+/g, "");
  if (compact === "vec4<f32>") return expression;
  if (compact === "vec3<f32>") return `vec4<f32>(${expression}, 0f)`;
  if (compact === "vec2<f32>") return `vec4<f32>(${expression}, 0f, 0f)`;
  if (compact === "f32") return `vec4<f32>(${expression}, 0f, 0f, 0f)`;
  throw new Error(`输出成员的类型 ${type} 不是 f32 / vec2 / vec3 / vec4<f32>`);
}

/**
 * 把翻译器输出的顶点 WGSL 改写成计算着色器（字符串层面，纯函数）。`entryPoint` 是顶点入口名（`TranslateResult.vertex.entryPoint`），
 * `inputs` 是顶点布局（`cornerInputs`），`stride` 是每顶点的 float 数。计算入口 `kb_corner_main`，
 * group 1 binding 0 是输入顶点（`array<f32>`），binding 1 是输出的裁剪坐标（`array<vec4<f32>>`，一个顶点一项）。
 * `options`（rope）：按几何着色器展开读实例、另写出返回结构的成员（`ComputeRewriteOptions`）；不给时输出与加这一项之前逐字相同。
 * 结构不认识时抛错（说明翻译器输出变了，要重看改写规则）。
 */
export function rewriteVertexAsCompute(
  wgsl: string,
  entryPoint: string,
  inputs: readonly CornerInput[],
  stride: number,
  options: ComputeRewriteOptions = {},
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
  const extras: string[] = [];
  const wanted = options.outputs ?? [];
  if (returns.attributes.get("builtin") !== "position") {
    const struct = new RegExp(String.raw`struct\s+${returns.rest}\s*\{([^}]*)\}`).exec(wgsl);
    if (!struct) throw new Error(`找不到返回结构 ${returns.rest}`);
    const members = splitTopLevel(struct[1]).map(takeAttributes);
    const member = members.find((item) => item.attributes.get("builtin") === "position");
    if (!member) throw new Error(`返回结构 ${returns.rest} 里没有 @builtin(position)`);
    output += `.${member.rest.slice(0, member.rest.indexOf(":")).trim()}`;
    for (const name of wanted) {
      const found = members.find((item) => item.rest.slice(0, item.rest.indexOf(":")).trim() === name);
      if (!found) throw new Error(`返回结构 ${returns.rest} 里没有成员 ${name}`);
      extras.push(asVec4(`${PREFIX}result.${name}`, found.rest.slice(found.rest.indexOf(":") + 1)));
    }
  } else if (wanted.length) throw new Error(`顶点入口只返回位置，没有成员 ${wanted.join("、")}`);

  const perInstance = options.maxVertices;
  const args = params.map((param) => {
    if (param.builtin === "vertex_index") return perInstance ? `(${PREFIX}index % ${perInstance}u)` : `${PREFIX}index`;
    if (param.builtin === "instance_index") return perInstance ? `(${PREFIX}index / ${perInstance}u)` : "0u";
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
  // 每个顶点占 `per` 项：位置在前，另写的成员依次在后
  const per = 1 + extras.length;
  const limit = per === 1 ? `arrayLength(&${PREFIX}out)` : `arrayLength(&${PREFIX}out) / ${per}u`;
  const base = perInstance ? `(${PREFIX}index / ${perInstance}u) * ${stride}u` : `${PREFIX}index * ${stride}u`;
  const writes =
    per === 1
      ? `    ${PREFIX}out[${PREFIX}index] = ${output};\n`
      : [output, ...extras]
          .map((value, j) => `    ${PREFIX}out[${PREFIX}index * ${per}u + ${j}u] = ${value};\n`)
          .join("");
  return `${body}
@group(1) @binding(0) var<storage, read> ${PREFIX}in: array<f32>;
@group(1) @binding(1) var<storage, read_write> ${PREFIX}out: array<vec4<f32>>;

@compute @workgroup_size(64)
fn ${PREFIX}main(@builtin(global_invocation_id) ${PREFIX}id: vec3<u32>) {
    let ${PREFIX}index = ${PREFIX}id.x;
    if (${PREFIX}index >= ${limit}) {
        return;
    }
    let ${PREFIX}base = ${base};
    let ${PREFIX}result = ${PREFIX}vertex(${args.join(", ")});
${writes}}
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
   * WPE 设置的 `fps`（P4d 步骤 1）：rope 绳没满时读它（rea-p4d-rope.md 1.2，`ParticleOptions.fps`）。缺省 60；和 WPE 抓帧比时填
   * 抓帧的 fps，应和 `passes` 一致（1–20 两遍）。
   */
  fps?: number;
  /**
   * 按 `objects` 下标、按出生顺序顶替这个系统抽到的 `R`，用完退回种子随机数（P4b 步骤 2）。`randomframe` 的 frame 就是 `R`，
   * 和 WPE 抓帧逐像素比时填从 WPE 轨迹读出的 frame（`rd-*.json` 的 `TEXCOORD1.w`）。只改 `R`，别的抽取照旧。
   */
  random?: Record<number, number[]>;
  /**
   * 每帧的 16 段频谱（P4e 步骤 4）：`{ left: [16 个], right: [16 个] }`，和 `dts` 等长，第 i 项在第 i + 1 帧步进之前原样写进场景的粒子频谱
   * （`GpuScene.particleAudio`，不经归一化）；某项为 null 时沿用前一帧。回放 WPE 时填抓帧里 CLK 读到的 `g_AudioSpectrum16Left/Right`。
   * 预热时频谱是 0。不给时全程全 0。
   * P11a 起每项还可带 `left32` / `right32` / `left64` / `right64`：读回那一帧的六个音频 uniform 取截至这一帧最后一个非 null 项
   * （`replaySpectrum`，没给的段为 0），全是 null 时和不给一样写全 0。
   */
  audio?: (ParticleAudioFrame | null)[];
}

/** 建场景用的粒子选项：种子缺省 1、遍数缺省 1、`fps` 缺省 60，`random` 换成每个粒子层一个 `injectedR`。 */
export function replayParticleOptions(replay: ParticleReplay | undefined): ParticleOptions {
  const random = replay?.random;
  return {
    seed: replay?.seed ?? 1,
    passes: replay?.passes ?? 1,
    fps: replay?.fps ?? 60,
    rOverride: random ? (object) => (random[object] ? injectedR(random[object]) : undefined) : undefined,
  };
}

/** 一个点，或逐帧的一串点（第一项是数组）。 */
const isPointList = (
  value: readonly [number, number] | readonly (readonly [number, number])[],
): value is readonly (readonly [number, number])[] => Array.isArray(value[0]);

/**
 * 按 dt 序列回放粒子：前 n−1 帧只步进粒子，返回最后一帧的 `g_Time` 与 `g_Frametime`，由调用方先 `stepParticles` 步进最后一帧、
 * 再 `update`（P4c 步骤 4 起 `update` 不步进粒子）。
 * 每帧的 `g_Time` 取 `times`，没给时是 dt 的累计值（double）；同一个值也作粒子的场景时间 `T`。没有回放时时间取 `time`、
 * 帧时间 0（不步进，就是预热后的状态）。`cursor` 是光标下的场景纹理坐标（控制点跟随指针用，P4c 步骤 2），缺省场景中心：一个点时
 * 每帧都用它；逐帧的一串（和 `dts` 等长，P5a 收尾）时第 i 帧用第 i 项，最后一项留给调用方步进读回那一帧。
 * `afterStep` 在这 n−1 帧的每一帧步进之后按这一帧的 `g_Time` 与帧时间调一次（P5a 步骤 3、4：探针在这里设这一帧的相机，`frameCamera`；
 * 同渲染器，粒子先用上一帧的 s 步进，再换上这一帧的。P10a 步骤 3：关键帧动画也在这里按这一帧的帧时间推进；kabegame-chromium 第 7 批：
 * 跑脚本时接着跑这一帧的脚本，见 `replayReadback`）。`beforeStep` 在每一帧步进之前调（第 7 批：跑脚本时在这里 `sync`，上一帧脚本写的
 * 进模拟器，同渲染器每帧开头的 `sync`）；不给时不调。
 */
export function replayParticles(
  scene: Pick<GpuScene, "stepParticles"> & Partial<Pick<GpuScene, "particleAudio">>,
  state: SceneState,
  replay: ParticleReplay | undefined,
  time = 0,
  cursor: readonly [number, number] | readonly (readonly [number, number])[] = [0.5, 0.5],
  afterStep?: (time: number, frametime: number) => void,
  beforeStep?: () => void,
): { time: number; frametime: number } {
  if (!replay?.dts.length) return { time, frametime: 0 };
  const { dts, times } = replay;
  const perFrame = checkReplay(replay, cursor);
  let elapsed = 0;
  const timeAt = (i: number) => (times ? times[i] : (elapsed += dts[i]));
  for (let i = 0; i < dts.length - 1; i++) {
    const at = timeAt(i);
    beforeStep?.();
    replayAudio(scene, replay, i);
    scene.stepParticles(dts[i], at, state, perFrame ? perFrame[i] : (cursor as readonly [number, number]));
    afterStep?.(at, dts[i]);
  }
  return { time: timeAt(dts.length - 1), frametime: dts[dts.length - 1] };
}

/**
 * 回放参数的形状（`replayParticles` 与逐帧都画的 `replayReadback` 共用）：`times`、逐帧 `cursor`、`audio` 要和 `dts` 等长，频谱每一项的
 * 段数先查一遍（P11a：不要回放到一半才在读回帧抛错）。返回逐帧的 cursor（一个点时为 null）。
 */
function checkReplay(
  replay: ParticleReplay,
  cursor: readonly [number, number] | readonly (readonly [number, number])[],
): readonly (readonly [number, number])[] | null {
  const { dts, times } = replay;
  if (times && times.length !== dts.length)
    throw new Error(`times 有 ${times.length} 项，dts 有 ${dts.length} 项，应等长`);
  const perFrame = isPointList(cursor) ? cursor : null;
  if (perFrame && perFrame.length !== dts.length)
    throw new Error(`逐帧 cursor 有 ${perFrame.length} 项，dts 有 ${dts.length} 项，应等长`);
  if (replay.audio && replay.audio.length !== dts.length)
    throw new Error(`audio 有 ${replay.audio.length} 项，dts 有 ${dts.length} 项，应等长`);
  replay.audio?.forEach((frame, i) => frame && replaySpectrum(frame, i));
  return perFrame;
}

/**
 * 第 i 帧（从 0 起）步进之前写这一帧的频谱（P4e 步骤 4，`ParticleReplay.audio`）：原样写进场景的粒子频谱（`GpuScene.particleAudio`），
 * 这一项为 null 时沿用前一帧。场景没有粒子频谱（单测的替身）却给了 `audio` 时抛错。
 */
export function replayAudio(
  scene: Partial<Pick<GpuScene, "particleAudio">>,
  replay: ParticleReplay | undefined,
  i: number,
): void {
  const frame = replay?.audio?.[i];
  if (!frame) return;
  if (!scene.particleAudio) throw new Error("场景没有粒子频谱，不能回放 audio");
  writeParticleAudio(scene.particleAudio, frame);
}

/**
 * 一帧频谱 → 音频 uniform（P11a）：16 段取 `left` / `right`，32 / 64 段取 `left32` … `right64`，没给的段为 0，都舍入成 float32
 * （同 WPE 的 cbuffer）。给了却不是 16 / 32 / 64 个时抛错，`index` 只用于报错。
 */
export function replaySpectrum(frame: ParticleAudioFrame, index = 0): SpectrumUniforms {
  const take = (values: ArrayLike<number> | undefined, count: number, name: string): Float32Array => {
    const out = new Float32Array(count);
    if (values === undefined) return out;
    if (values.length !== count) throw new Error(`audio[${index}].${name} 应 ${count} 个，收到 ${values.length} 个`);
    for (let i = 0; i < count; i++) out[i] = values[i];
    return out;
  };
  return {
    L16: take(frame.left, 16, "left"),
    R16: take(frame.right, 16, "right"),
    L32: take(frame.left32, 32, "left32"),
    R32: take(frame.right32, 32, "right32"),
    L64: take(frame.left64, 64, "left64"),
    R64: take(frame.right64, 64, "right64"),
  };
}

/**
 * 读回那一帧的音频 uniform（P11a）：截至读回帧（`audio` 末项）最后一个非 null 项，同粒子频谱的「null 沿用前一帧」。没给 `audio`、或全是
 * null 时返回 undefined（`update` 写全 0，和 P11a 之前逐字节相同）。
 */
export function readbackSpectrum(replay: ParticleReplay | undefined): SpectrumUniforms | undefined {
  return spectrumAt(replay, (replay?.audio?.length ?? 0) - 1);
}

/** 第 `index` 帧（从 0 起）的音频 uniform：截至这一帧最后一个非 null 项，规则同 `readbackSpectrum`（逐帧都画的回放用）。 */
export function spectrumAt(replay: ParticleReplay | undefined, index: number): SpectrumUniforms | undefined {
  const audio = replay?.audio;
  if (!audio) return undefined;
  for (let i = Math.min(index, audio.length - 1); i >= 0; i--) {
    const frame = audio[i];
    if (frame) return replaySpectrum(frame, i);
  }
  return undefined;
}

/**
 * 透视场景的探针相机（P5d 步骤 2）：基准相机与路径、场景目标尺寸（宽高比，同渲染器按画布尺寸渲染）、起始的路径状态（缺省加载时的）。
 * 正交场景不给（`probePerspective` 返回 undefined）。
 */
export interface ProbePerspective {
  camera: SceneCameraJson;
  size: readonly [number, number];
  path?: CameraPathState;
}

/** 透视场景的探针相机；正交场景为 undefined。`size` 是建场景时交给 `GpuScene.build` 的场景目标尺寸。 */
export function probePerspective(
  bundle: Pick<SceneBundle, "general">,
  size: readonly [number, number],
): ProbePerspective | undefined {
  if (!bundle.general.perspective) return undefined;
  return { camera: bundle.general.camera ?? { ...DEFAULT_CAMERA, paths: [] }, size };
}

/**
 * 探针的相机对象（P5d 步骤 3）：场景里的相机对象图层与 general（正交帧要 W、H 与透视覆盖的 fov）。场景没有相机对象时为 undefined，
 * `frameCamera` 照步骤 2 算（逐字不变）。
 */
export interface ProbeCameraObjects {
  layers: readonly SceneLayer[];
  general: Pick<SceneGeneral, "width" | "height" | "perspectiveOverrideFov">;
}

/** 探针的相机对象（`cameraObjectLayers`）；场景没有相机对象时为 undefined。 */
export function probeCameraObjects(bundle: Pick<SceneBundle, "general" | "layers">): ProbeCameraObjects | undefined {
  const layers = cameraObjectLayers(bundle);
  return layers.length ? { layers, general: bundle.general } : undefined;
}

/**
 * 探针回放的相机（P5a 步骤 3、4）：每一帧按这一帧的 `g_Time` 算 s（`shakeOffset`，`height` 是场景的正交高），连同 `state.general.zoom`
 * 交给 `GpuScene.setCamera`，并记下 s；`eyes` 按帧序就是 `replayParallax` 的每帧 eye。回放的 n−1 帧经 `replayParticles` 的
 * `afterStep` 调，读回的那一帧由调用方在步进之后、`setParallax` 之前调。和渲染器一样，每一帧的粒子先用上一帧的相机步进（第一帧是
 * 加载时的：s 为 0、编译期的 zoom），再换上这一帧的。
 * 透视场景（P5d 步骤 2，给了 `perspective`）：同渲染器，每一帧按路径状态求来源姿态、再按这一帧的 dt 推进（第 k 次调用取 `dts[k]`，
 * 没给时 0），加三维抖动（`g_Time` 是 `time`），交给 `setCamera` 的是透视那一种；`eyes` 记透视相机的 eye.xy（视差点用它，W = H = 0）。
 * `compute` 只算不交（`renderFrame` 的 profile 帧要先步进粒子再交），`path` 是推进之后的路径状态。
 * 相机对象（P5d 步骤 3，给了 `objects`）：同渲染器（`sceneCameraFrame`），每一帧按 `state` 里当时的可见性与变换选生效的相机对象；
 * 有它时透视场景用它的姿态与 fov、路径不推进，正交场景交它的视图，`eyes` 记相机的 eye.xy（加 s）。
 */
export function frameCamera(
  scene: Pick<GpuScene, "setCamera">,
  state: SceneState,
  height: number,
  perspective?: ProbePerspective,
  dts?: readonly number[],
  objects?: ProbeCameraObjects,
): {
  apply: (time: number) => [number, number];
  compute: (time: number, dt?: number) => { camera: SceneCamera; eye: [number, number] };
  eyes: [number, number][];
  readonly path: CameraPathState;
} {
  const eyes: [number, number][] = [];
  let path = perspective?.path ?? initialCameraPathState();
  let index = 0;
  const compute = (time: number, dt?: number): { camera: SceneCamera; eye: [number, number] } => {
    const step = dt ?? dts?.[index] ?? 0;
    index++;
    if (objects) {
      const result = sceneCameraFrame({
        cameraLayers: objects.layers,
        state,
        general: objects.general,
        time,
        perspective: perspective
          ? { camera: perspective.camera, path, dt: step, width: perspective.size[0], height: perspective.size[1] }
          : null,
      });
      if (result.path) path = result.path;
      return { camera: result.camera, eye: result.eye };
    }
    if (!perspective) {
      const shake = shakeOffset(state.general, time, height);
      return { camera: { shake, zoom: state.general.zoom }, eye: shake };
    }
    const { pose, next } = stepCameraSource(perspective.camera, path, step);
    path = next;
    const frame = perspectiveCamera({
      pose,
      fields: state.general,
      time,
      width: perspective.size[0],
      height: perspective.size[1],
    });
    return { camera: { kind: "perspective", frame }, eye: [frame.eye[0], frame.eye[1]] };
  };
  return {
    eyes,
    get path() {
      return path;
    },
    compute,
    apply(time) {
      const { camera, eye } = compute(time);
      scene.setCamera(camera);
      eyes.push(eye);
      return eye;
    },
  };
}

export interface ReadbackReplayOptions {
  particles?: ParticleReplay;
  /** 没有回放时读回那一帧的 `g_Time`；有回放时取 `times` 末项或 dt 累计值。 */
  time: number;
  /** 每一帧的 `g_PointerPosition` 与 `cursor`（`replayPointers`）：下标同 `dts`，没有回放时只有一项。 */
  pointers: ReplayPointers;
  /** 视差点的起点：加载时的状态（`renderFrame` 的 `profile` 帧推进过的接着用）。 */
  parallax: ParallaxState;
  /** 场景的正交尺寸 W、H（视差点的单位；抖动按 H 算）。透视场景是 (0, 0)。 */
  size: readonly [number, number];
  /**
   * 关键帧动画（P10a 步骤 3，`SceneAnimations`）：有回放（`particles.dts`）时，每一帧（前 n − 1 帧与读回帧）在步进粒子、设相机之后按这一帧的
   * 帧时间 `frame`（推进并写进状态），接着 `sync`（同渲染器在脚本之后的第二次 `sync`：下一帧的粒子步进与读回帧的 `update` 才看得到写入）。
   * 没有回放时不推进，由调用方先 `seek` 再 `write`（开头的 `sync` 刷进去）。不给时调用序列同以前。
   */
  animations?: Pick<SceneAnimations, "frame">;
  /**
   * puppet 的骨骼动画（P12a 步骤 4 点 5，`ScenePuppets`）：有回放时每一帧（前 n − 1 帧与读回帧）在步进粒子之后、设相机之前按这一帧的帧时间
   * `frame`（同渲染器 `stepPuppets` 的位置），蒙皮矩阵由 `GpuScene.update` 写进 `g_Bones`（调用方先 `setPuppets`）。没有回放时不推进，由调用方先
   * `seek`。不给时调用序列同以前。
   */
  puppets?: Pick<ScenePuppets, "frame">;
  /** 透视场景的探针相机（P5d 步骤 2，`probePerspective`）：按 `particles.dts` 推路径状态，不移动对象。正交场景不给。 */
  perspective?: ProbePerspective;
  /** 场景里的相机对象（P5d 步骤 3，`probeCameraObjects`）：每帧按状态选生效的。没有相机对象时不给。 */
  cameraObjects?: ProbeCameraObjects;
  /**
   * 前 n − 1 帧每一帧都在 GPU 上画（P10a 走查，FINAL_CHECK「确定性工程能还原全部状态」）：给了且有回放时，每一帧照读回帧的顺序走完
   * （`sync` → 频谱 → 步进粒子 → 相机 → 动画 → 用这一帧的 general 推进视差点 → `setParallax` → `update`），再调它编码、提交这一帧；
   * 读回帧走到 `update` 为止，由调用方编码。跨帧的 GPU 状态因此和渲染器一样：排在前面的图层读被依赖图层的合成 RT 时读到上一帧画的
   * （`2251857160` 的折射读 `_rt_imageLayerComposite_356_a`，只画读回帧时是空的）、`clearenabled: false` 的场景目标照常交替累加。
   * 不给时只画读回帧，调用序列同以前（`particleCorners` 只读 uniform，不给）。跑脚本时每一帧的顺序见 `scripts`。
   */
  encodeFrame?: (index: number) => void;
  /**
   * 场景脚本（kabegame-chromium 第 7 批，`probeScripts.ts`）：每一帧（前 n − 1 帧与读回帧）设好这一帧的相机、推进完关键帧动画之后调一次
   * `frame(g_Frametime, g_Time)`，同渲染器 `beforeFrame` 里的位置（`host.ts`：先 `SceneAnimations.frame`，再 `runtime.frame`）。给了时每一帧
   * 照渲染器 `render` 的完整顺序：`sync` → 频谱 → 步进粒子 → 相机 → 动画 → 脚本 → `setParallax` → `sync` → `update`（动画之后不另
   * `sync`，脚本之后那次一起刷），视差点按这一帧开头（动画、脚本之前）的 general 推进，`g_Daytime` 每帧按 `daytime`。只画读回帧时前 n − 1 帧
   * 没有 `setParallax` / `update`，第二次 `sync` 并进下一帧开头的那次。不给时调用序列逐项同以前。
   */
  scripts?: {
    frame(dt: number, time: number): void;
    /** 这一帧开头把时间交给脚本时钟（P10b）：在推进动画之前调，事件回调读到本帧的 `engine.runtime`。 */
    enterFrame?(dt: number, time: number): void;
    /** 动画事件（P10b）：推进动画时越过的事件在写完那一条之后、下一条之前同步派发（同宿主 `beforeFrame` 的 `event` 钩子）。 */
    animationEvent?(object: number | null, json: string): void;
    /** 光标（P6c，`ProbeScripts.cursor`）：每一帧设好相机之后、动画与脚本之前调，只在每一帧都画的回放里（`encodeFrame`）。 */
    cursor?(input: CursorStepInput): void;
  };
  /**
   * 光标交互（P6c）：每一帧的左键（和 `dts` 等长，缺的项按松开）与窗口客户区像素（`input.cursorScreenPosition`、`fullscreen` 的 `localPosition` 用）。
   * 光标位置取 `pointers`（窗口归一化），要同时给 `scripts.cursor`。只在每一帧都画的回放里生效（`replayEncoded`）。
   */
  cursor?: { buttons: readonly boolean[]; window: readonly [number, number] };
  /**
   * 每一帧的 `g_Daytime`（按这一帧的 `g_Time` 算；第 7 批：跑脚本时跟着脚本的时钟）；缺省 0.5。只画读回帧时只有读回帧用它，每帧都画时
   * 每一帧都用。
   */
  daytime?: (time: number) => number;
}

/** 动画事件的钩子（P10b）：脚本侧接了 `animationEvent` 才给，把越过的事件原样交给脚本；不接时 `undefined`（`frame` 的调用同以前）。 */
function eventHooks(scripts: ReadbackReplayOptions["scripts"]): AnimationHooks | undefined {
  const dispatch = scripts?.animationEvent?.bind(scripts);
  return dispatch ? { event: ({ object, json }) => dispatch(object, json) } : undefined;
}

/**
 * dev 探针从建好的场景回放到读回那一帧并写好这一帧的 uniform（`renderFrame`、`particleCorners` 共用，P5a 收尾）。顺序同渲染器
 * （P4c 步骤 4、P5a 步骤 3、4）：前 n − 1 帧在 `replayParticles` 里步进，每帧先用上一帧的相机步进、再设这一帧的（`frameCamera`）；
 * 读回帧 `sync` → `stepParticles` → 设相机；视差点按同一串帧时间与每帧的 s 从 `parallax` 推进，之后 `setParallax`、`update`。
 * 光标逐帧取 `pointers`：第 i 帧步进用 `cursors[i]`、视差点用 `pointers[i]`；读回帧的 `g_PointerPosition` 是最后一项、
 * `g_PointerPositionLast` 是倒数第二项（只有一帧时取自己，同渲染器每帧末尾 `pointerLast = pointer`）。
 * 每一帧都是同一个点时，与加逐帧指针之前逐字节相同。关键帧动画（P10a 步骤 3，`animations`）在每一帧设完相机之后推进、写入、`sync`
 * （跑脚本时不另 `sync`，见下）。读回帧的音频 uniform 取 `readbackSpectrum`（P11a），没给频谱时写全 0。
 * 场景脚本（第 7 批，`options.scripts`）：每一帧设好相机、推进完动画之后跑一帧脚本，顺序见 `ReadbackReplayOptions.scripts`。
 * 给了 `encodeFrame` 且有回放时走 `replayEncoded`（每一帧都画）。
 * 返回读回帧的 `g_Time`、`g_Frametime`、视差状态，以及交给 `update` 的帧输入（`frame`：探针结清文本重排之后要再写一次时用）。
 */
export function replayReadback(
  scene: Pick<GpuScene, "stepParticles" | "setCamera" | "sync" | "setParallax" | "update"> &
    Partial<Pick<GpuScene, "particleAudio">>,
  state: SceneState,
  options: ReadbackReplayOptions,
): { time: number; frametime: number; parallax: ParallaxState; frame: FrameInput } {
  const { particles, pointers, animations, scripts } = options;
  if (options.encodeFrame && particles?.dts.length) return replayEncoded(scene, state, options, options.encodeFrame);
  const [width, height] = options.size;
  const last = pointers.pointers.length - 1;
  const shake = frameCamera(scene, state, height, options.perspective, particles?.dts, options.cameraObjects);
  // 关键帧动画（P10a 步骤 3）：同渲染器，粒子与相机之后、脚本之前写。不跑脚本时接着 `sync`（同以前）；跑脚本时不另 `sync`，脚本之后
  // 那次（读回帧）或下一帧开头那次一起刷（同渲染器：`beforeFrame` 里动画、脚本连着跑，之后才 `sync`）
  const animate = (frametime: number) => {
    if (!animations) return;
    animations.frame(frametime, state, animationHooks);
    if (!scripts) scene.sync(state);
  };
  // 动画事件的钩子（P10b）：只有跑脚本且脚本侧接了才给；不给时 `frame` 的调用同以前
  const animationHooks = eventHooks(scripts);
  // 跑脚本时：每一帧开头（这一帧动画、脚本之前）的 general，视差点逐帧按它推进（同渲染器帧开头推进视差点）；不改 general 时每一项都相同
  const generals: SceneState["general"][] = [];
  // 一帧里步进粒子之后的部分（同渲染器）：设这一帧的相机 → 动画 → 脚本（`beforeFrame`）
  const afterStep = (at: number, dt: number, animated: boolean) => {
    if (scripts) generals.push(state.general);
    // puppet（P12a 步骤 4 点 5）：粒子之后、相机之前（同渲染器 `stepPuppets`）；没有回放的读回帧不推进（调用方已 `seek`）
    if (animated) options.puppets?.frame(dt, stateSink(state));
    shake.apply(at);
    // 先把本帧时间交给脚本时钟（P10b）：动画事件的回调读到本帧的 `engine.runtime`（同渲染器帧开头就推进 `frameClock`）
    scripts?.enterFrame?.(dt, at);
    if (animated) animate(dt);
    scripts?.frame(dt, at);
  };
  const { time, frametime } = replayParticles(
    scene,
    state,
    particles,
    options.time,
    particles?.dts.length ? pointers.cursors : pointers.cursors[0],
    (at, dt) => afterStep(at, dt, true),
    // 跑脚本时每帧步进之前 `sync`：上一帧动画与脚本写的（`instanceoverride`、变换、可见性……）这一帧就进模拟器
    scripts ? () => scene.sync(state) : undefined,
  );
  scene.sync(state);
  // 读回那一帧的频谱（P4e 步骤 4）：没有回放时不写
  if (particles?.dts.length) replayAudio(scene, particles, particles.dts.length - 1);
  scene.stepParticles(frametime, time, state, pointers.cursors[last]);
  // 读回帧：没有回放时动画不推进（调用方已 seek、写过），脚本照常跑一帧
  afterStep(time, frametime, !!particles?.dts.length);
  // 视差点和粒子互不影响：回放的前 n − 1 帧与读回帧按同一串帧时间与每帧的 s 推进（没有回放时读回帧的帧时间是 0）
  const frametimes = [...(particles?.dts ?? []).slice(0, -1), frametime];
  const parallaxFrame = { pointer: pointers.pointers[0], width, height };
  const parallax = scripts
    ? // 每一帧用这一帧开头的 general 推进一次（同一个推进函数，逐帧调）
      frametimes.reduce(
        (current, dt, i) =>
          replayParallax(current, generals[i], parallaxFrame, [dt], [shake.eyes[i]], [pointers.pointers[i]]),
        options.parallax,
      )
    : replayParallax(options.parallax, state.general, parallaxFrame, frametimes, shake.eyes, pointers.pointers);
  scene.setParallax(drawParallax(parallax, state.general, !!options.perspective), state);
  // 跑脚本时：这一帧脚本写回的状态刷进 uniform 块 / 可见性 / 泛光链（渲染器 `beforeFrame` 之后的第二次 `sync`）。没有脚本时两次 `sync`
  // 之间没有改动，省掉
  if (scripts) scene.sync(state);
  // 读回那一帧的音频 uniform（P11a）：同一帧的粒子频谱上面已经写过
  const audio = readbackSpectrum(particles);
  const frame: FrameInput = {
    time,
    frametime,
    daytime: options.daytime ? options.daytime(time) : 0.5,
    pointer: pointers.pointers[last],
    pointerLast: pointers.pointers[Math.max(0, last - 1)],
    cursor: pointers.cursors[last],
    parallax: parallax.position,
    ...(audio ? { audio } : {}),
  };
  scene.update(frame, state);
  return { time, frametime, parallax, frame };
}

/**
 * 每一帧都画的回放（`ReadbackReplayOptions.encodeFrame`）：第 i 帧的步骤与读回帧相同，只是视差点逐帧推进、每帧用这一帧的 general
 * （只画读回帧时 `replayParallax` 用读回时的 general，两者只在回放中 general 的视差字段变了时不同），频谱 uniform 取截至这一帧的
 * （`spectrumAt`），`g_PointerPositionLast` 是上一帧的。前 n − 1 帧在 `update` 之后调 `encodeFrame(i)`；读回帧不调。
 * 跑脚本时（第 7 批，`options.scripts`）每一帧照渲染器 `render` 的完整顺序：`sync` → 频谱 → 步进粒子 → 相机 → 动画 → 脚本 →
 * `setParallax` → `sync` → `update`（动画之后不另 `sync`），视差点按这一帧开头（动画、脚本之前）的 general 推进，`g_Daytime` 按
 * `options.daytime`。不跑脚本时调用序列同以前。
 */
function replayEncoded(
  scene: Pick<GpuScene, "stepParticles" | "setCamera" | "sync" | "setParallax" | "update"> &
    Partial<Pick<GpuScene, "particleAudio" | "cursorCamera">>,
  state: SceneState,
  options: ReadbackReplayOptions,
  encodeFrame: (index: number) => void,
): { time: number; frametime: number; parallax: ParallaxState; frame: FrameInput } {
  const { pointers, animations, scripts } = options;
  const replay = options.particles!;
  const { dts, times } = replay;
  const [width, height] = options.size;
  checkReplay(replay, pointers.cursors);
  const shake = frameCamera(scene, state, height, options.perspective, dts, options.cameraObjects);
  const animationHooks = eventHooks(scripts);
  let parallax = options.parallax;
  let elapsed = 0;
  let time = 0;
  let frametime = 0;
  let frame: FrameInput | null = null;
  for (let i = 0; i < dts.length; i++) {
    time = times ? times[i] : (elapsed += dts[i]);
    frametime = dts[i];
    // 这一帧开头的 general：渲染器在帧开头推进视差点（`render` 的 `advanceParallax`，在步进粒子与 `beforeFrame` 之前），跑脚本时按它推进；
    // 不跑脚本时照以前，用动画之后的
    const general = state.general;
    // 顺序同渲染器与读回帧：两帧之间写进状态的改值先刷进去，粒子用上一帧的相机步进，再设这一帧的；动画在粒子与相机之后写、再 sync
    scene.sync(state);
    replayAudio(scene, replay, i);
    scene.stepParticles(frametime, time, state, pointers.cursors[i]);
    // puppet（P12a 步骤 4 点 5）：粒子之后、相机之前，同渲染器 `stepPuppets`
    options.puppets?.frame(frametime, stateSink(state));
    const eye = shake.apply(time);
    // 先把本帧时间交给脚本时钟（P10b）：必须在光标派发之前。宿主渲染器 `render` 帧开头就 `frameClock.advance`（`renderer.ts`），
    // 之后才 `stepCursor`，光标回调里的 `engine.runtime` / `frametime` / `Date` 是当帧的值（P6c 走查 `3810092560` 发现这里曾反过来）
    scripts?.enterFrame?.(frametime, time);
    // 光标命中与派发（P6c）：相机更新之后、动画与脚本之前（同渲染器的 `stepCursor`）；视差点要先推进到这一帧（渲染器在帧开头推进），这里算一份给命中用，
    // 帧末照旧推进一次（跑脚本时输入是帧开头的 general，两处相同）
    if (scripts?.cursor && options.cursor && scene.cursorCamera) {
      const early = advanceParallax(
        parallax,
        parallaxInput(general, { pointer: pointers.pointers[i], width, height, frametime, eye }),
      );
      scripts.cursor({
        camera: scene.cursorCamera(options.cursor.window),
        cursor: pointers.cursors[i],
        pointer: pointers.pointers[i],
        window: options.cursor.window,
        down: options.cursor.buttons[i] ?? false,
        parallax: drawParallax(early, general, !!options.perspective),
      });
    }
    if (animations) {
      animations.frame(frametime, state, animationHooks);
      // 跑脚本时不另 sync：同渲染器 `beforeFrame` 里动画、脚本连着跑，脚本之后的 `sync` 一起刷
      if (!scripts) scene.sync(state);
    }
    // 脚本（第 7 批）：动画之后、`setParallax` 之前（同渲染器 `beforeFrame`）
    scripts?.frame(frametime, time);
    parallax = advanceParallax(
      parallax,
      parallaxInput(scripts ? general : state.general, {
        pointer: pointers.pointers[i],
        width,
        height,
        frametime,
        eye,
      }),
    );
    scene.setParallax(drawParallax(parallax, state.general, !!options.perspective), state);
    // 跑脚本时：动画与脚本写回的状态刷进 uniform 块 / 可见性 / 泛光链（渲染器 `beforeFrame` 之后的第二次 `sync`）
    if (scripts) scene.sync(state);
    const audio = spectrumAt(replay, i);
    frame = {
      time,
      frametime,
      daytime: options.daytime ? options.daytime(time) : 0.5,
      pointer: pointers.pointers[i],
      pointerLast: pointers.pointers[Math.max(0, i - 1)],
      cursor: pointers.cursors[i],
      parallax: parallax.position,
      ...(audio ? { audio } : {}),
    };
    scene.update(frame, state);
    if (i < dts.length - 1) encodeFrame(i);
  }
  return { time, frametime, parallax, frame: frame! };
}

export interface ParticleCornersOptions {
  projectDir: string;
  sceneAssets: string[];
  postprocess?: ScenePostprocessSetting;
  userProperties?: Record<string, unknown>;
  /** 粒子层：`objects` 下标或对象名；缺省为全部粒子层。 */
  layer?: number | string;
  particles?: ParticleReplay;
  /**
   * 逐帧的 `g_PointerPosition`（抓帧窗口归一化，P5a 收尾），和 `particles.dts` 等长，规则同 `renderFrame` 的 `pointers`。
   * 不给时光标固定在场景中心 `[0.5, 0.5]`。
   */
  pointers?: [number, number][];
  /** 抓帧窗口尺寸 `[宽, 高]`：和场景不同尺寸时光标按 `fill` 换到场景上（同 `renderFrame`）；缺省或同尺寸时原样。 */
  window?: [number, number];
  /** 每层只取前这么多个粒子（按槽序）；缺省全部。 */
  limit?: number;
  /** 结果里带上改写后的 WGSL（排查用）。 */
  wgsl?: boolean;
}

export interface ParticleCornersLayer {
  object: number;
  name: string;
  /**
   * 顶层系统的第几条 renderer（P4f 步骤 4，`SceneParticle.draws` 的下标）：一个粒子层按它的 `draws` 每条各出一项，第 r 项（r ≥ 1）才带
   * 这个键，第 0 项和以前逐字节相同。对照 WPE 抓帧时，第 r 项对应同一系统的第 r + 1 次绘制（各用自己那条 renderer 的变体）。
   */
  renderer?: number;
  perspective: boolean;
  /**
   * 渲染时画不画这一层（P4c 步骤 5）：朝向是 NaN（`upright` 的轴平行于视线）时 `encode` 整次绘制跳过，这里为 false；四角照算
   * （uniform 里写的是 NaN，结果同 WPE 的 `gs_out`）。
   */
  drawn: boolean;
  /** 写进顶点的粒子数（不受 `limit` 影响）：存活粒子，拖尾系统去掉退化的（速度为 0 或平行于视线，P4c 步骤 5）。 */
  count: number;
  /** 每个角点的 UV，顺序同 `corners` 里每个粒子的 4 个角：`(0,0)`、`(0,1)`、`(1,1)`、`(1,0)`。 */
  uv: [number, number][];
  /** 每粒子 4 个角的裁剪坐标 `[x, y, z, w]`（顶点着色器的 `@builtin(position)`，和 WPE `gs_out` 同一空间）。 */
  corners: number[][][];
  /** 同一角的场景像素坐标 `[x, y]`：透视除法后按场景目标尺寸换算，原点左上、y 向下。 */
  pixels: number[][][];
  /** 写进顶点的粒子输入，按槽序，与 `corners` 一一对应（拖尾系统同样去掉退化的）。 */
  particles: ParticleTrackParticle[];
  /**
   * rope 两类（P4d 步骤 1、2）才有：这时 `count` 是段数，`corners` / `pixels` 的每项是一段的整条带子（`maxVertices` 个顶点，三角形带
   * 顺序，同 WPE `gs_out` 还原成带的顺序），`uv` 为空。rope 的 `particles` 是按 rope 表（出生序）排的全部存活粒子（段 k 连第 k、
   * k + 1 个）；ropetrail 的 `particles` 是按槽序的存活粒子，段 `i·n … i·n + n − 1` 是第 i 个的（`segments` 是 n）。
   * `normalize` 零向量的段整段是 `(2, 2, 2, 1)`（裁剪体外，WPE 是 NaN）。
   */
  rope?: {
    maxVertices: number;
    /** ropetrail（P4d 步骤 2）每个粒子的段数 n；rope 没有。 */
    segments?: number;
    /** 每段每个顶点的 `v_TexCoord`（u、v）。 */
    uvs: number[][][];
    /** 每段每个顶点的 `v_Color`（rgba）。 */
    colors: number[][][];
  };
  wgsl?: string;
}

/** rope 表里的存活粒子（出生序，P4d 步骤 1），字段同 `particleSnapshot`。 */
function ropeParticles(system: ParticleSystem): ParticleTrackParticle[] {
  const order = system.ropeOrder;
  if (!order) return [];
  const c = system.columns;
  return Array.from(order.slots.subarray(0, Math.min(order.length, system.alive)), (slot) => ({
    pos: [c.position[0][slot], c.position[1][slot], c.position[2][slot]],
    size: c.size[slot],
    color: [c.color[0][slot], c.color[1][slot], c.color[2][slot]],
    alpha: c.alpha[slot],
    rot: [c.rotation[0][slot], c.rotation[1][slot], c.rotation[2][slot]],
  }));
}

/** rope 的计算入口另写出的两个成员：几何着色器的 `out vec2 v_TexCoord`、`out vec4 v_Color`。 */
const ROPE_OUTPUTS = ["v_TexCoord", "v_Color"] as const;

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
    const { width, height } = bundle.general;
    // 透视场景（P5d 步骤 2）按窗口尺寸渲染（同渲染器按画布），没给窗口时 1920×1080
    const target: [number, number] | undefined = bundle.general.perspective
      ? [...(options.window ?? [1920, 1080])]
      : undefined;
    // 光标（P5a 收尾）：不给 pointers 时固定在场景中心；给了时逐帧取，窗口和场景不同尺寸时按 fill 换算，同 `renderFrame`
    const pointers = replayPointers(
      { pointers: options.pointers, window: options.window },
      target ?? [width, height],
      options.particles?.dts.length,
    );
    const state = SceneState.fromBundle(bundle);
    const scene = await GpuScene.build(device, bundle, state, gpu.features, [], {
      ignoreUnsupported: true,
      // 预热用第 0 帧的 cursor（不给 pointers 时是场景中心，同 `GpuScene` 的缺省）
      particles: { ...replayParticleOptions(options.particles), cursor: pointers.warmup },
      size: target,
    });
    // 关键帧动画（P10a 步骤 3）：同 `renderFrame`，有回放时沿同一串 dt 推进，没有时按第 0 秒写一次（开头的 `sync` 刷进去）
    const animations = bundle.animations?.length ? new SceneAnimations(bundle.animations) : null;
    const replayed = !!options.particles?.dts.length;
    if (animations && !replayed) {
      animations.seek(0);
      animations.write(state);
    }
    try {
      // 抖动与缩放（P5a 步骤 3、4）：每一帧先用上一帧的相机步进粒子、再设这一帧的（同 `renderFrame` 与渲染器），四角带读回帧的相机。
      // 最后一帧先步进再写 uniform（顺序同渲染器，P4c 步骤 4）。四角读的是 draw 的 uniform 缓冲（`particleProbe`），世界空间系统
      // 的模型矩阵已是单位阵（`GpuScene.uniformValues`），这里不另算。视差（P5a 步骤 2）：从加载时的场景中心起按同一串帧时间、每帧的 s
      // 与每帧的指针推进（同 `renderFrame`），四角带视差。没有脚本，`setParallax` 放在 `sync` 之后不影响结果（相机或视差变了它整体重写）
      replayReadback(scene, state, {
        particles: options.particles,
        time: 0,
        pointers,
        parallax: initialParallaxState(width, height, !!target),
        size: [width, height],
        animations: replayed ? (animations ?? undefined) : undefined,
        perspective: target && probePerspective(bundle, target),
        cameraObjects: probeCameraObjects(bundle),
      });
      const wanted = scene
        .particleStats()
        .filter(
          (item) =>
            options.layer === undefined ||
            (typeof options.layer === "number" ? item.object === options.layer : item.name === options.layer),
        );
      /** 一个粒子层顶层系统的第 `renderer` 条的四角；这一条没有绘制时为 null。 */
      const probeCorners = async (
        object: number,
        name: string,
        renderer: number,
      ): Promise<ParticleCornersLayer | null> => {
        const probe = scene.particleProbe(object, [], 0, renderer);
        if (!probe) return null;
        const { program, layout, rope } = probe;
        // `limit` 对 rope 是段数
        const limit = Math.min(probe.count, options.limit ?? probe.count);
        const code = rewriteVertexAsCompute(
          program.result.vertex?.wgsl ?? "",
          program.result.vertex?.entryPoint ?? "main",
          cornerInputs(program.vertexPacking.attributes),
          layout.stride,
          rope ? { maxVertices: rope.maxVertices, outputs: ROPE_OUTPUTS } : {},
        );
        // 每项（粒子 / 段）的顶点数与每个顶点读回的 vec4 个数（rope 另有 uv、颜色）
        const per = rope ? rope.maxVertices : 4;
        const values = rope ? 1 + ROPE_OUTPUTS.length : 1;
        const clip = limit ? await runCorners(device, probe, code, limit, per, values) : new Float32Array(0);
        const vec4At = (vertex: number, j: number) =>
          Array.from(clip.subarray((vertex * values + j) * 4, (vertex * values + j) * 4 + 4));
        const corners: number[][][] = [];
        const pixels: number[][][] = [];
        const uvs: number[][][] = [];
        const colors: number[][][] = [];
        for (let p = 0; p < limit; p++) {
          const quad: number[][] = [];
          const screen: number[][] = [];
          const uv: number[][] = [];
          const color: number[][] = [];
          for (let k = 0; k < per; k++) {
            const [x, y, z, w] = vec4At(p * per + k, 0);
            quad.push([x, y, z, w]);
            screen.push([((x / w + 1) / 2) * scene.width, ((1 - y / w) / 2) * scene.height]);
            if (rope) {
              uv.push(vec4At(p * per + k, 1).slice(0, 2));
              color.push(vec4At(p * per + k, 2));
            }
          }
          corners.push(quad);
          pixels.push(screen);
          uvs.push(uv);
          colors.push(color);
        }
        return {
          object,
          name,
          // 第 0 条不带这个键，和以前逐字节相同
          ...(renderer ? { renderer } : {}),
          perspective: probe.perspective,
          drawn: !probe.hidden,
          count: probe.count,
          uv: rope ? [] : CORNER_UVS.map(([u, v]) => [u, v]),
          corners,
          pixels,
          particles: rope
            ? probe.system.trail
              ? particleSnapshot(probe.system)
              : ropeParticles(probe.system)
            : particleSnapshot(
                probe.system,
                probe.trailEye ? (slot) => trailDrawable(probe.system.columns, slot, probe.trailEye!) : undefined,
              ).slice(0, limit),
          ...(rope
            ? {
                rope: {
                  maxVertices: rope.maxVertices,
                  ...(probe.system.trail ? { segments: probe.system.trail.segments } : {}),
                  uvs,
                  colors,
                },
              }
            : {}),
          wgsl: options.wgsl ? code : undefined,
        };
      };
      const out: ParticleCornersLayer[] = [];
      for (const { object, name } of wanted) {
        // 顶层系统的每条 renderer 各一项（P4f 步骤 4）：各用自己的变体程序、uniform 与顶点（`particleProbe` 的第 4 个参数）。`draws` 为空
        // （`renderer: []`）时探针本来取不到，照旧试一次
        const particle = bundle.layers.find((layer) => layer.object === object)?.particle;
        const renderers = Math.max(1, particle ? particleDraws(particle).length : 0);
        for (let renderer = 0; renderer < renderers; renderer++) {
          const corners = await probeCorners(object, name, renderer);
          if (corners) out.push(corners);
        }
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

/**
 * 跑一遍改写后的计算着色器，返回前 `particles` 项（粒子；rope 是段）每个顶点读回的值：每项 `per` 个顶点（sprite 4 个，rope
 * `maxVertices` 个），每个顶点 `values` 个 vec4（位置在前；rope 另有 uv、颜色）。rope 按段读输入（每段一个实例），dispatch
 * `段数 × maxVertices` 个调用。
 */
async function runCorners(
  device: GPUDevice,
  probe: NonNullable<ReturnType<GpuScene["particleProbe"]>>,
  code: string,
  particles: number,
  per = 4,
  values = 1,
): Promise<Float32Array> {
  const COMPUTE = 0x4; // GPUShaderStage.COMPUTE
  const module = device.createShaderModule({ label: "particle corners", code: WGSL_PRELUDE + code });
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter((message) => message.type === "error");
  if (errors.length)
    throw new Error(
      `改写后的计算着色器编译失败：${errors.map((m) => `${m.lineNum - 1}:${m.linePos} ${m.message}`).join("；")}`,
    );
  const vertices = particles * per;
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
  // 输入按项读：sprite 每粒子 4 个顶点，rope 每段一个实例
  const inputData = probe.vertices.subarray(0, particles * (probe.rope ? 1 : 4) * probe.layout.stride);
  const input = device.createBuffer({
    label: "particle corners in",
    size: Math.max(4, inputData.byteLength),
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(input, 0, inputData.buffer, inputData.byteOffset, inputData.byteLength);
  const output = device.createBuffer({
    label: "particle corners out",
    size: vertices * values * 16,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    label: "particle corners readback",
    size: vertices * values * 16,
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
    encoder.copyBufferToBuffer(output, 0, readback, 0, vertices * values * 16);
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
