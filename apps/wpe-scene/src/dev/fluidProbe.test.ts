import { describe, expect, it } from "vitest";
import { channelStats, decodeReadback, fboRoles, planFluidFrames } from "./fluidProbe";

describe("planFluidFrames（流体探针的逐帧输入）", () => {
  it("指针缺省沿用上一帧、pointerLast 缺省上一帧的指针，第 1 帧为自己", () => {
    const { frames, readAt } = planFluidFrames(
      [
        { frametime: 0.05, time: 6.1, pointer: [0.2, 0.3] },
        { frametime: 0.04, time: 6.14 },
        { frametime: 0.06, time: 6.2, pointer: [0.9, 0.1] },
        { frametime: 0.05, time: 6.25, pointer: [0.4, 0.4], pointerLast: [0.1, 0.1] },
      ],
      [256, 256],
    );
    expect(frames.map((f) => [f.pointer, f.pointerLast])).toEqual([
      [
        [0.2, 0.3],
        [0.2, 0.3],
      ],
      [
        [0.2, 0.3],
        [0.2, 0.3],
      ],
      [
        [0.9, 0.1],
        [0.2, 0.3],
      ],
      [
        [0.4, 0.4],
        [0.1, 0.1],
      ],
    ]);
    // 窗口没给：cursor 与 pointer 相同
    expect(frames.map((f) => f.cursor)).toEqual(frames.map((f) => f.pointer));
    expect([...readAt]).toEqual([4]);
  });

  it("全都不给指针时是 [0.5, 0.5]", () => {
    const { frames } = planFluidFrames([{ frametime: 0.05, time: 1 }], [256, 256]);
    expect(frames[0]).toEqual({
      frametime: 0.05,
      time: 1,
      pointer: [0.5, 0.5],
      pointerLast: [0.5, 0.5],
      cursor: [0.5, 0.5],
    });
  });

  it("窗口与场景比例不同：g_PointerPosition 是窗口坐标，cursor 按 fill 换到场景上（同 renderFrame）", () => {
    // 场景 256×128 铺满 512×512 的窗口：fill 按高缩放 4 倍，横向居中裁掉，窗口中心仍对着场景中心
    const { frames } = planFluidFrames([{ frametime: 0.05, time: 1, pointer: [0.5, 0.5] }], [256, 128], [512, 512]);
    expect(frames[0].pointer).toEqual([0.5, 0.5]);
    expect(frames[0].cursor[0]).toBeCloseTo(0.5, 9);
    expect(frames[0].cursor[1]).toBeCloseTo(0.5, 9);
    const edge = planFluidFrames([{ frametime: 0.05, time: 1, pointer: [0, 0.5] }], [256, 128], [512, 512]).frames[0];
    // 窗口左边缘对着场景 x = (256 − 128) / 2 = 64 像素处
    expect(edge.cursor[0]).toBeCloseTo(0.25, 9);
  });

  it("readAt 给了就按它，越界或不是整数抛错", () => {
    const frames = Array.from({ length: 5 }, (_, i) => ({ frametime: 0.05, time: i * 0.05 }));
    expect([...planFluidFrames(frames, [256, 256], undefined, [2, 5]).readAt]).toEqual([2, 5]);
    expect(() => planFluidFrames(frames, [256, 256], undefined, [0])).toThrow("readAt");
    expect(() => planFluidFrames(frames, [256, 256], undefined, [6])).toThrow("readAt");
    expect(() => planFluidFrames(frames, [256, 256], undefined, [1.5])).toThrow("readAt");
  });

  it("不合法的输入抛错", () => {
    expect(() => planFluidFrames([], [256, 256])).toThrow("至少要有一帧");
    expect(() => planFluidFrames([{ frametime: -1, time: 0 }], [256, 256])).toThrow("frametime");
    expect(() => planFluidFrames([{ frametime: 0.05, time: NaN }], [256, 256])).toThrow("time");
    expect(() =>
      planFluidFrames([{ frametime: 0.05, time: 0, pointer: [1] as unknown as [number, number] }], [256, 256]),
    ).toThrow("pointer");
  });
});

describe("fboRoles（swap 之后名字对应哪个初始实体）", () => {
  const initial = new Map([
    ["v1", "A"],
    ["v2", "B"],
    ["d", "C"],
  ]);

  it("偶数次 swap 后各自对应自己", () => {
    expect(fboRoles(new Map(initial), initial)).toEqual({ v1: "v1", v2: "v2", d: "d" });
  });

  it("奇数次后两两互换", () => {
    const swapped = new Map([
      ["v1", "B"],
      ["v2", "A"],
      ["d", "C"],
    ]);
    expect(fboRoles(swapped, initial)).toEqual({ v1: "v2", v2: "v1", d: "d" });
  });

  it("不认识的实体记作 ?", () => {
    expect(fboRoles(new Map([["x", "Z"]]), initial)).toEqual({ x: "?" });
  });
});

describe("decodeReadback（去掉 256 字节对齐的行尾、半精度转 float32）", () => {
  it("r16float：每行 2 个纹素、行距 256 字节", () => {
    const raw = new Uint8Array(512);
    const view = new DataView(raw.buffer);
    view.setUint16(0, 0x3c00, true); // 1
    view.setUint16(2, 0xc000, true); // -2
    view.setUint16(256, 0x3800, true); // 0.5
    view.setUint16(258, 0x0000, true);
    raw[100] = 0xff; // 行尾填充，不该出现在结果里
    const out = decodeReadback(raw, 2, 2, 256, "r16float");
    expect(out).toBeInstanceOf(Float32Array);
    expect([...out]).toEqual([1, -2, 0.5, 0]);
  });

  it("rg16float 两个通道交错", () => {
    const raw = new Uint8Array(256);
    const view = new DataView(raw.buffer);
    [0x3c00, 0x3800, 0xbc00, 0x4000].forEach((bits, i) => view.setUint16(i * 2, bits, true));
    expect([...decodeReadback(raw, 2, 1, 256, "rg16float")]).toEqual([1, 0.5, -1, 2]);
  });

  it("rgba8unorm 原样（字节），不转浮点", () => {
    const raw = new Uint8Array(512);
    raw.set([1, 2, 3, 4], 0);
    raw.set([5, 6, 7, 8], 256);
    const out = decodeReadback(raw, 1, 2, 256, "rgba8unorm");
    expect(out).toBeInstanceOf(Uint8Array);
    expect([...out]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("不支持的格式抛错", () => {
    expect(() => decodeReadback(new Uint8Array(256), 1, 1, 256, "bc3-rgba-unorm")).toThrow("不支持");
  });
});

describe("channelStats", () => {
  it("按通道求均值、最小、最大", () => {
    expect(channelStats([1, 10, 3, 20, -1, 30], 2)).toEqual({ mean: [1, 20], min: [-1, 10], max: [3, 30] });
  });
});
