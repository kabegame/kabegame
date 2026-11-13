import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { DrawTrace } from "../render/trace";
import { encodeRgbaPng, isTraceKey, traceArtifacts, traceOptionsOf } from "./drawTrace";

describe("traceOptionsOf", () => {
  it("没要轨迹（不给 / false）时 null：探针不建记录器、设备不包", () => {
    expect(traceOptionsOf(undefined)).toBeNull();
    expect(traceOptionsOf(false)).toBeNull();
  });

  it("true 与对象", () => {
    expect(traceOptionsOf(true)).toEqual({});
    expect(traceOptionsOf({})).toEqual({});
    expect(traceOptionsOf({ readback: [0, 7, "glyphs"], maxVertices: 4096 })).toEqual({
      readback: [0, 7, "glyphs"],
      maxVertices: 4096,
    });
  });

  it("形状不对时抛错", () => {
    for (const bad of [
      { readback: [-1] },
      { readback: [1.5] },
      { readback: [""] },
      { readback: "glyphs" },
      { maxVertices: 0 },
      { maxVertices: 4097 },
      { maxVertices: 2.5 },
      { frames: 1 },
      [1],
    ])
      expect(() => traceOptionsOf(bad as never), JSON.stringify(bad)).toThrow(/trace/);
  });
});

/** 解开 PNG（只认这里写的：一个 IDAT、每行过滤类型 0）。 */
function decode(png: Uint8Array): { width: number; height: number; rgba: Uint8Array; chunks: string[] } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  expect(Array.from(png.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let at = 8;
  let width = 0;
  let height = 0;
  let idat: Uint8Array = new Uint8Array(0);
  const chunks: string[] = [];
  while (at < png.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    chunks.push(type);
    const data = png.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      expect([data[8], data[9]]).toEqual([8, 6]);
    }
    if (type === "IDAT") idat = data;
    at += 12 + length;
  }
  const raw = new Uint8Array(inflateSync(idat));
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    expect(raw[y * (width * 4 + 1)]).toBe(0);
    rgba.set(raw.subarray(y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1)), y * width * 4);
  }
  return { width, height, rgba, chunks };
}

describe("encodeRgbaPng", () => {
  it("逐字节保真：alpha 原样、alpha 为 0 的颜色不丢", async () => {
    const rgba = new Uint8Array([
      10, 20, 30, 0, 255, 128, 1, 7, 0, 0, 0, 255, 200, 100, 50, 129, 1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    const png = await encodeRgbaPng(rgba, 3, 2);
    const decoded = decode(png);
    expect(decoded.chunks).toEqual(["IHDR", "IDAT", "IEND"]);
    expect([decoded.width, decoded.height]).toEqual([3, 2]);
    expect(Array.from(decoded.rgba)).toEqual(Array.from(rgba));
  });

  it("长度不符时抛错", async () => {
    await expect(encodeRgbaPng(new Uint8Array(7), 1, 2)).rejects.toThrow(/不符/);
  });
});

describe("traceArtifacts", () => {
  const trace = (): DrawTrace => ({
    version: 1,
    resources: { textures: {}, buffers: {}, samplers: {}, pipelines: {} },
    passes: [
      { index: 0, label: "scene", encoder: "probe frame", submit: 0, colorAttachments: [], draws: [] },
      {
        index: 1,
        label: "layer 179 text glyphs",
        encoder: "probe frame",
        submit: 0,
        colorAttachments: [],
        draws: [
          {
            index: 0,
            pipeline: null,
            call: { kind: "draw", count: 4, instances: 1, first: 0, firstInstance: 0 },
            bindings: [],
          },
          {
            index: 1,
            pipeline: null,
            call: { kind: "draw", count: 4, instances: 1, first: 0, firstInstance: 0 },
            bindings: [],
          },
        ],
      },
      {
        index: 2,
        label: "bloom 0",
        encoder: "probe frame",
        submit: 0,
        colorAttachments: [],
        draws: [],
        readbackError: "格式 r8unorm 不读回",
      },
    ],
    copies: [],
    errors: ["读回帧 WebGPU 校验出错：x"],
  });

  it("读回图编码、写进 pass 的 readback；轨迹存成 JSON；摘要给键、大小与计数", async () => {
    const floats = new Float32Array([1, 0.5, -2, 1]);
    const { files, summary } = await traceArtifacts("kbdev-h-1", {
      trace: trace(),
      readbacks: [
        {
          pass: 1,
          label: "layer 179 text glyphs",
          texture: "t3",
          width: 1,
          height: 1,
          format: "rgba8unorm",
          kind: "rgba8",
          data: new Uint8Array([1, 2, 3, 0]),
        },
        {
          pass: 0,
          label: "scene",
          texture: "t0",
          width: 1,
          height: 1,
          format: "rgba16float",
          kind: "f32",
          data: floats,
        },
      ],
    });
    expect(files.map((f) => f.key)).toEqual(["kbdev-h-1.pass1.png", "kbdev-h-1.pass0.f32", "kbdev-h-1.trace.json"]);
    expect(Array.from(decode(files[0].bytes).rgba)).toEqual([1, 2, 3, 0]);
    expect(new Float32Array(files[1].bytes.slice().buffer)).toEqual(floats);
    const json = JSON.parse(new TextDecoder().decode(files[2].bytes)) as DrawTrace;
    expect(json.passes.map((p) => p.readback ?? null)).toEqual(["kbdev-h-1.pass0.f32", "kbdev-h-1.pass1.png", null]);
    expect(summary).toEqual({
      key: "kbdev-h-1.trace.json",
      bytes: files[2].bytes.length,
      passes: 3,
      draws: 2,
      errors: 1,
      readbacks: [
        {
          pass: 1,
          key: "kbdev-h-1.pass1.png",
          width: 1,
          height: 1,
          format: "rgba8unorm",
          bytes: files[0].bytes.length,
        },
        { pass: 0, key: "kbdev-h-1.pass0.f32", width: 1, height: 1, format: "rgba16float", bytes: 16 },
      ],
      readbackErrors: [{ pass: 2, error: "格式 r8unorm 不读回" }],
    });
  });

  it("isTraceKey 只认同一个结果键的轨迹与读回图", () => {
    expect(isTraceKey("k", "k.trace.json")).toBe(true);
    expect(isTraceKey("k", "k.pass12.png")).toBe(true);
    expect(isTraceKey("k", "k.pass0.f32")).toBe(true);
    expect(isTraceKey("k", "k.png")).toBe(false);
    expect(isTraceKey("k", "k.rgba")).toBe(false);
    expect(isTraceKey("k", "k2.trace.json")).toBe(false);
    expect(isTraceKey("k", "kk.pass1.png")).toBe(false);
  });
});
