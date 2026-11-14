import { describe, expect, it } from "vitest";
import { applyGammaTable, gammaTable, pngGamma, pngGammaTable } from "./png";

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** 拼一个只有指定块的 PNG 字节流（CRC 不校验，填 0）。 */
function png(chunks: { type: string; data?: number[] }[]): Uint8Array {
  const out: number[] = [...SIGNATURE];
  for (const { type, data = [] } of chunks) {
    out.push((data.length >>> 24) & 255, (data.length >>> 16) & 255, (data.length >>> 8) & 255, data.length & 255);
    out.push(...[...type].map((c) => c.charCodeAt(0)), ...data, 0, 0, 0, 0);
  }
  return new Uint8Array(out);
}
/** `gAMA` 块的数据：gamma × 1e5 的 4 字节大端。 */
const gama = (g: number) => {
  const v = Math.round(g * 1e5);
  return { type: "gAMA", data: [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255] };
};
const IHDR = { type: "IHDR", data: new Array(13).fill(0) };
const IDAT = { type: "IDAT", data: [0] };

describe("gammaTable：libpng 的 8 位校正表（p11-REPORT M9，与 WPE 逐像素相同）", () => {
  it("g = 1.0：t[i] = floor(255·(i/255)^(1/2.2) + 0.5)", () => {
    const table = gammaTable(1.0)!;
    expect([...table.slice(0, 8)]).toEqual([0, 21, 28, 34, 39, 43, 46, 50]);
    expect(table[255]).toBe(255);
  });

  it("g = 0.6", () => {
    expect([...gammaTable(0.6)!.slice(0, 8)]).toEqual([0, 4, 6, 9, 11, 13, 15, 17]);
  });

  it("|2.2·g − 1| < 0.05 不校正：g = 1/2.2、0.45455（sRGB 的取值，M9）", () => {
    expect(gammaTable(1 / 2.2)).toBeNull();
    expect(gammaTable(0.45455)).toBeNull();
    expect(gammaTable(0)).toBeNull();
    // 临界之外就校正：2.2·0.5 = 1.1，差 0.1
    expect(gammaTable(0.5)).not.toBeNull();
  });
});

describe("pngGamma：读 gAMA 块", () => {
  it("IDAT 之前的 gAMA（4 字节大端 × 1e-5）", () => {
    expect(pngGamma(png([IHDR, gama(1.0), IDAT]))).toBeCloseTo(1.0, 6);
    expect(pngGamma(png([IHDR, gama(0.6), IDAT]))).toBeCloseTo(0.6, 6);
    expect(pngGamma(png([IHDR, gama(0.45455), IDAT]))).toBeCloseTo(0.45455, 6);
  });

  it("没有 gAMA、gAMA 在 IDAT 之后、不是 PNG、太短：null", () => {
    expect(pngGamma(png([IHDR, IDAT]))).toBeNull();
    expect(pngGamma(png([IHDR, IDAT, gama(1.0)]))).toBeNull();
    expect(pngGamma(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))).toBeNull();
    expect(pngGamma(new Uint8Array(3))).toBeNull();
  });

  it("有 sRGB 块时 libpng 取 0.45455，不校正（不管 gAMA 在前在后）", () => {
    expect(pngGamma(png([IHDR, { type: "sRGB", data: [0] }, gama(1.0), IDAT]))).toBeNull();
    expect(pngGamma(png([IHDR, gama(1.0), { type: "sRGB", data: [0] }, IDAT]))).toBeNull();
  });

  it("pngGammaTable 把两步合起来：g = 1.0 给表，没有 gAMA / g ≈ 1/2.2 给 null", () => {
    expect(pngGammaTable(png([IHDR, gama(1.0), IDAT]))![1]).toBe(21);
    expect(pngGammaTable(png([IHDR, gama(0.45455), IDAT]))).toBeNull();
    expect(pngGammaTable(png([IHDR, IDAT]))).toBeNull();
  });

  it("字节流带偏移的视图也读得对", () => {
    const inner = png([IHDR, gama(1.0), IDAT]);
    const padded = new Uint8Array(inner.length + 5);
    padded.set(inner, 5);
    expect(pngGamma(padded.subarray(5))).toBeCloseTo(1.0, 6);
  });
});

describe("applyGammaTable", () => {
  it("只改 RGB，alpha 不动", () => {
    const table = gammaTable(1.0)!;
    const pixels = new Uint8ClampedArray([1, 2, 3, 77, 4, 5, 6, 255]);
    applyGammaTable(pixels, table);
    expect([...pixels]).toEqual([21, 28, 34, 77, 39, 43, 46, 255]);
  });
});
