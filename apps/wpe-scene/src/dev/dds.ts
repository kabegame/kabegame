/**
 * dev 探针读 RenderDoc 存的 DDS（P7d 步骤 3 的流体单步隔离，dev 专用）。
 *
 * RenderDoc `SaveTexture` 存 DDS 时保留原格式：浮点格式写 DX10 扩展头（`DXGI_FORMAT`），`R8G8B8A8_UNORM` 写老式头（`DDPF_RGB |
 * DDPF_ALPHAPIXELS`、32 位、掩码 R=0xff G=0xff00 B=0xff0000 A=0xff000000，`ignore/p7d/fluid_map.py` 读过实物）。这里认得：
 * - DX10 头：`R16G16B16A16_FLOAT`（10）、`R16G16_FLOAT`（34）、`R16_FLOAT`（54）、`R8G8B8A8_UNORM`（28）；
 * - 老式头：上面那组掩码的 RGBA8，以及 D3DFMT 数字 fourCC 113 / 112 / 111（A16B16G16R16F / G16R16F / R16F）。
 * 只取 mip 0；数据按 WebGPU 的格式名给出，可以原样 `queue.writeTexture`（每行 `width × bytesPerTexel` 字节，紧排）。
 */

export type DdsFormat = "rgba16float" | "rg16float" | "r16float" | "rgba8unorm";

export interface DdsImage {
  width: number;
  height: number;
  format: DdsFormat;
  /** 每个纹素几个通道（RGBA 4、RG 2、R 1）。 */
  channels: number;
  bytesPerTexel: number;
  /** mip 0 的纹素，紧排（`width × height × bytesPerTexel` 字节）；独占一份 `ArrayBuffer`，可直接交给 `writeTexture`。 */
  data: Uint8Array<ArrayBuffer>;
}

/** 各格式的通道数与纹素字节数。 */
export const DDS_FORMATS: Readonly<Record<DdsFormat, { channels: number; bytesPerTexel: number }>> = {
  rgba16float: { channels: 4, bytesPerTexel: 8 },
  rg16float: { channels: 2, bytesPerTexel: 4 },
  r16float: { channels: 1, bytesPerTexel: 2 },
  rgba8unorm: { channels: 4, bytesPerTexel: 4 },
};

const DXGI: Readonly<Record<number, DdsFormat>> = {
  10: "rgba16float",
  34: "rg16float",
  54: "r16float",
  28: "rgba8unorm",
};
const D3DFMT: Readonly<Record<number, DdsFormat>> = { 113: "rgba16float", 112: "rg16float", 111: "r16float" };

const MAGIC = 0x20534444; // "DDS "
const DDPF_FOURCC = 0x4;
const DDPF_RGB = 0x40;

/** 解析 DDS 的 mip 0。不认识的格式、截断的文件抛错（消息里带原因）。 */
export function parseDds(bytes: Uint8Array, label = "DDS"): DdsImage {
  if (bytes.length < 128) throw new Error(`${label}：文件太短（${bytes.length} 字节）`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC) throw new Error(`${label}：不是 DDS`);
  const height = view.getUint32(12, true);
  const width = view.getUint32(16, true);
  const flags = view.getUint32(80, true);
  const fourCC = view.getUint32(84, true);
  let format: DdsFormat | undefined;
  let offset = 128;
  if (flags & DDPF_FOURCC && fourCC === 0x30315844 /* "DX10" */) {
    if (bytes.length < 148) throw new Error(`${label}：DX10 头不完整`);
    const dxgi = view.getUint32(128, true);
    format = DXGI[dxgi];
    if (!format) throw new Error(`${label}：不认识的 DXGI_FORMAT ${dxgi}`);
    offset = 148;
  } else if (flags & DDPF_FOURCC) {
    format = D3DFMT[fourCC];
    if (!format) throw new Error(`${label}：不认识的 fourCC 0x${fourCC.toString(16)}`);
  } else if (flags & DDPF_RGB) {
    const bits = view.getUint32(88, true);
    const masks = [92, 96, 100, 104].map((at) => view.getUint32(at, true));
    if (bits === 32 && masks[0] === 0xff && masks[1] === 0xff00 && masks[2] === 0xff0000 && masks[3] === 0xff000000)
      format = "rgba8unorm";
    else throw new Error(`${label}：不认识的 RGB 掩码 ${bits} 位 ${masks.map((m) => `0x${m.toString(16)}`).join(" ")}`);
  } else throw new Error(`${label}：像素格式标志 0x${flags.toString(16)} 不认识`);
  const { channels, bytesPerTexel } = DDS_FORMATS[format];
  const size = width * height * bytesPerTexel;
  if (bytes.length < offset + size)
    throw new Error(`${label}：数据不完整（要 ${size} 字节，只有 ${bytes.length - offset}）`);
  return { width, height, format, channels, bytesPerTexel, data: bytes.slice(offset, offset + size) };
}

/** IEEE 754 半精度 → 单精度（同 `probe.ts` 的 `halfToFloat`；这里另写一份，免得单测拉进编译与 GPU 模块）。 */
export function halfBitsToFloat(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x3ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 31) return fraction ? NaN : sign * Infinity;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

/** 纹素按通道转成单精度：半精度原值、UNORM8 除以 255。长度 `width × height × channels`。 */
export function ddsToFloat(image: Pick<DdsImage, "format" | "data">): Float32Array {
  const { data, format } = image;
  if (format === "rgba8unorm") {
    const out = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) out[i] = data[i] / 255;
    return out;
  }
  const halves = new Uint16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  const out = new Float32Array(halves.length);
  for (let i = 0; i < halves.length; i++) out[i] = halfBitsToFloat(halves[i]);
  return out;
}
