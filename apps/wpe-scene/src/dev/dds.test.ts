import { describe, expect, it } from "vitest";
import { ddsToFloat, halfBitsToFloat, parseDds } from "./dds";

/** 拼一个 DDS：老式头 128 字节，`dxgi` 给出时加 DX10 扩展头。 */
function dds(options: {
  width: number;
  height: number;
  data: Uint8Array;
  dxgi?: number;
  fourCC?: number;
  rgb?: { bits: number; masks: [number, number, number, number] };
}): Uint8Array {
  const header = options.dxgi !== undefined ? 148 : 128;
  const bytes = new Uint8Array(header + options.data.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x20534444, true);
  view.setUint32(4, 124, true);
  view.setUint32(12, options.height, true);
  view.setUint32(16, options.width, true);
  view.setUint32(76, 32, true);
  if (options.dxgi !== undefined) {
    view.setUint32(80, 0x4, true);
    view.setUint32(84, 0x30315844, true);
    view.setUint32(128, options.dxgi, true);
    view.setUint32(132, 3, true); // TEXTURE2D
    view.setUint32(140, 1, true); // arraySize
  } else if (options.fourCC !== undefined) {
    view.setUint32(80, 0x4, true);
    view.setUint32(84, options.fourCC, true);
  } else if (options.rgb) {
    view.setUint32(80, 0x41, true);
    view.setUint32(88, options.rgb.bits, true);
    options.rgb.masks.forEach((mask, i) => view.setUint32(92 + i * 4, mask, true));
  }
  bytes.set(options.data, header);
  return bytes;
}

/** 半精度位：1.0 = 0x3c00、-2.0 = 0xc000、0.5 = 0x3800、65504 = 0x7bff、最小非规格化数 = 0x0001。 */
const halves = (...bits: number[]) => new Uint8Array(new Uint16Array(bits).buffer);
const RGBA8_MASKS: [number, number, number, number] = [0xff, 0xff00, 0xff0000, 0xff000000];

describe("parseDds（P7d 流体单步隔离读 RenderDoc 存的 RT）", () => {
  it("DX10 R16_FLOAT（54）：压力、散度、旋度", () => {
    const image = parseDds(dds({ width: 2, height: 1, dxgi: 54, data: halves(0x3c00, 0xc000) }));
    expect(image).toMatchObject({ width: 2, height: 1, format: "r16float", channels: 1, bytesPerTexel: 2 });
    expect([...ddsToFloat(image)]).toEqual([1, -2]);
  });

  it("DX10 R16G16_FLOAT（34）：速度", () => {
    const image = parseDds(dds({ width: 1, height: 2, dxgi: 34, data: halves(0x3800, 0x7bff, 0x0001, 0x8000) }));
    expect(image).toMatchObject({ width: 1, height: 2, format: "rg16float", channels: 2, bytesPerTexel: 4 });
    const values = [...ddsToFloat(image)];
    expect(values.slice(0, 2)).toEqual([0.5, 65504]);
    expect(values[2]).toBe(2 ** -24);
    expect(Object.is(values[3], -0)).toBe(true);
  });

  it("DX10 R16G16B16A16_FLOAT（10）：原有的泛光输入格式", () => {
    const image = parseDds(dds({ width: 1, height: 1, dxgi: 10, data: halves(0x3c00, 0x3800, 0, 0x3c00) }));
    expect(image.format).toBe("rgba16float");
    expect([...ddsToFloat(image)]).toEqual([1, 0.5, 0, 1]);
  });

  it("DX10 R8G8B8A8_UNORM（28）与老式 RGBA8 掩码头（RenderDoc 存染料与合成 RT 的写法）给出同样的结果", () => {
    const data = new Uint8Array([255, 0, 51, 128, 1, 2, 3, 4]);
    const a = parseDds(dds({ width: 2, height: 1, dxgi: 28, data }));
    const b = parseDds(dds({ width: 2, height: 1, rgb: { bits: 32, masks: RGBA8_MASKS }, data }));
    for (const image of [a, b]) {
      expect(image).toMatchObject({ width: 2, height: 1, format: "rgba8unorm", channels: 4, bytesPerTexel: 4 });
      expect([...image.data]).toEqual([...data]);
    }
    expect([...ddsToFloat(b)].slice(0, 4)).toEqual([1, 0, 0.2, 128 / 255].map(Math.fround));
  });

  it("D3DFMT 数字 fourCC 111 / 112 / 113", () => {
    expect(parseDds(dds({ width: 1, height: 1, fourCC: 111, data: halves(0) })).format).toBe("r16float");
    expect(parseDds(dds({ width: 1, height: 1, fourCC: 112, data: halves(0, 0) })).format).toBe("rg16float");
    expect(parseDds(dds({ width: 1, height: 1, fourCC: 113, data: halves(0, 0, 0, 0) })).format).toBe("rgba16float");
  });

  it("只取 mip 0：后面多出来的字节不要", () => {
    const image = parseDds(dds({ width: 1, height: 1, dxgi: 54, data: halves(0x3c00, 0x3800, 0x3800) }));
    expect(image.data.length).toBe(2);
    expect([...ddsToFloat(image)]).toEqual([1]);
  });

  it("不认识或损坏的文件抛错", () => {
    expect(() => parseDds(new Uint8Array(200), "x.dds")).toThrow("x.dds：不是 DDS");
    expect(() => parseDds(dds({ width: 1, height: 1, dxgi: 2, data: new Uint8Array(16) }))).toThrow("DXGI_FORMAT 2");
    expect(() => parseDds(dds({ width: 2, height: 2, dxgi: 34, data: halves(0, 0) }))).toThrow("数据不完整");
    expect(() =>
      parseDds(
        dds({
          width: 1,
          height: 1,
          rgb: { bits: 32, masks: [0xff0000, 0xff00, 0xff, 0xff000000] },
          data: new Uint8Array(4),
        }),
      ),
    ).toThrow("RGB 掩码");
    expect(() => parseDds(dds({ width: 1, height: 1, fourCC: 0x31545844, data: new Uint8Array(8) }))).toThrow("fourCC");
    expect(() => parseDds(new Uint8Array(10))).toThrow("太短");
  });

  it("halfBitsToFloat 的特殊值", () => {
    expect(halfBitsToFloat(0x7c00)).toBe(Infinity);
    expect(halfBitsToFloat(0xfc00)).toBe(-Infinity);
    expect(halfBitsToFloat(0x7e00)).toBeNaN();
    expect(halfBitsToFloat(0x0400)).toBe(2 ** -14);
  });
});
