/**
 * 探针 `renderFrame` 的逐 draw 轨迹（`.claude/plans/tools/scene-draw-trace.md` 点 3）：参数规整、读回图的编码、要存进存放区的东西。
 * 记录器本身在 `render/trace.ts`。
 *
 * 存放区的键（`<key>` 是 `renderFrame` 的结果键）：
 * - `<key>.trace.json`：轨迹（`DrawTrace`，UTF-8 JSON；NaN 成了 null）；
 * - `<key>.pass<下标>.png`：8 位目标的读回，RGBA 原值（alpha 不改、不预乘，逐字节就是纹理内容）；
 * - `<key>.pass<下标>.f32`：浮点目标（`rgba16float` / `rgba32float`）的读回，RGBA 单精度、小端，同 `scheduleReadback`。
 */
import { MAX_TRACE_VERTICES, type DrawTrace, type TraceOptions, type TraceReadback } from "../render/trace";

/** `renderFrame` 结果里的轨迹摘要：轨迹与读回图的键、大小（vite 据此在取回之前判断是否超限）。 */
export interface RenderFrameTrace {
  /** 轨迹 JSON 的存放键（`<key>.trace.json`）。 */
  key: string;
  /** 轨迹 JSON 的字节数。 */
  bytes: number;
  passes: number;
  draws: number;
  /** 记录器自己出的错与读回帧的 WebGPU 校验错误条数（详见轨迹的 `errors`）。 */
  errors: number;
  readbacks: { pass: number; key: string; width: number; height: number; format: string; bytes: number }[];
  /** 选中了却没读回的 pass 与原因。 */
  readbackErrors: { pass: number; error: string }[];
}

/**
 * `renderFrame` 的 `trace` → 记录器参数；没要轨迹（`undefined` / `false`）时 null，探针不建记录器、设备不包。形状不对时抛错：
 * `true`，或 `{ readback?: (非负整数 | 非空字符串)[], maxVertices?: 1–4096 的整数 }`，不认识的字段报错（同 vite 的校验）。
 */
export function traceOptionsOf(trace: boolean | TraceOptions | undefined): TraceOptions | null {
  if (trace === undefined || trace === false) return null;
  if (trace === true) return {};
  if (!trace || typeof trace !== "object" || Array.isArray(trace))
    throw new Error("trace 要是 true 或 { readback?, maxVertices? }");
  const unknown = Object.keys(trace).filter((key) => key !== "readback" && key !== "maxVertices");
  if (unknown.length) throw new Error(`trace 不认识 ${unknown.join("、")}（只收 readback / maxVertices）`);
  const options: TraceOptions = {};
  if (trace.readback !== undefined) {
    if (!Array.isArray(trace.readback)) throw new Error("trace.readback 要是数组");
    trace.readback.forEach((item, i) => {
      const ok =
        (typeof item === "number" && Number.isInteger(item) && item >= 0) || (typeof item === "string" && item !== "");
      if (!ok) throw new Error(`trace.readback[${i}] 要是 pass 下标（非负整数）或标签子串（非空字符串）`);
    });
    options.readback = [...trace.readback];
  }
  if (trace.maxVertices !== undefined) {
    const n = trace.maxVertices;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_TRACE_VERTICES)
      throw new Error(`trace.maxVertices 要是 1–${MAX_TRACE_VERTICES} 的整数`);
    options.maxVertices = n;
  }
  return options;
}

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let crcTable: Uint32Array | null = null;
function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** zlib 格式压缩（PNG 的 IDAT 要的就是它，`CompressionStream("deflate")`）。 */
async function zlibDeflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * RGBA 字节 → 8 位 RGBA PNG，逐字节保真（每行过滤类型 0）。不走 2D 画布：画布按预乘存，半透明像素的颜色会被量化，alpha 为 0 的
 * 颜色直接丢掉，合成 RT 这类带 alpha 的目标和 RenderDoc 存的图就对不上了。
 */
export async function encodeRgbaPng(rgba: Uint8Array, width: number, height: number): Promise<Uint8Array> {
  const stride = width * 4;
  if (rgba.length !== stride * height) throw new Error(`像素长度 ${rgba.length} 与 ${width}×${height}×4 不符`);
  const filtered = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) filtered.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8; // 位深
  header[9] = 6; // RGBA
  const parts = [
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("IDAT", await zlibDeflate(filtered)),
    pngChunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** 一次轨迹要存的东西：读回图编码好，轨迹里的 pass 写上读回键，再把轨迹编成 JSON。 */
export async function traceArtifacts(
  key: string,
  traced: { trace: DrawTrace; readbacks: TraceReadback[] },
): Promise<{ files: { key: string; bytes: Uint8Array }[]; summary: RenderFrameTrace }> {
  const { trace } = traced;
  const files: { key: string; bytes: Uint8Array }[] = [];
  const readbacks: RenderFrameTrace["readbacks"] = [];
  for (const readback of traced.readbacks) {
    const png = readback.kind === "rgba8";
    const fileKey = `${key}.pass${readback.pass}.${png ? "png" : "f32"}`;
    const data = readback.data;
    const bytes = png
      ? await encodeRgbaPng(data as Uint8Array, readback.width, readback.height)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    files.push({ key: fileKey, bytes });
    const pass = trace.passes.find((item) => item.index === readback.pass);
    if (pass) pass.readback = fileKey;
    readbacks.push({
      pass: readback.pass,
      key: fileKey,
      width: readback.width,
      height: readback.height,
      format: readback.format,
      bytes: bytes.length,
    });
  }
  const json = new TextEncoder().encode(JSON.stringify(trace));
  const traceKey = `${key}.trace.json`;
  files.push({ key: traceKey, bytes: json });
  return {
    files,
    summary: {
      key: traceKey,
      bytes: json.length,
      passes: trace.passes.length,
      draws: trace.passes.reduce((n, pass) => n + pass.draws.length, 0),
      errors: trace.errors?.length ?? 0,
      readbacks,
      readbackErrors: trace.passes.flatMap((pass) =>
        pass.readbackError ? [{ pass: pass.index, error: pass.readbackError }] : [],
      ),
    },
  };
}

/** 存放区里属于结果键 `key` 的轨迹文件（换一次渲染就清掉旧的，免得同键越积越多）。 */
export function isTraceKey(key: string, stored: string): boolean {
  return stored === `${key}.trace.json` || (stored.startsWith(`${key}.pass`) && /\.pass\d+\.(png|f32)$/.test(stored));
}
