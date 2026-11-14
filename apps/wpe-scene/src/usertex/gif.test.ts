import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GifAnimation } from "./gif";
import {
  concat,
  frameBlock,
  headerBlock,
  interlaceRowOrder,
  lzwCodes,
  TRAILER,
  type FrameSpec,
  type Rgb,
} from "./gifTestUtil";

const RED: Rgb = [255, 0, 0];
const GREEN: Rgb = [0, 255, 0];
const BLUE: Rgb = [0, 0, 255];
const YELLOW: Rgb = [255, 255, 0];
const P4: Rgb[] = [RED, GREEN, BLUE, YELLOW];

const rgba = (c: Rgb): number[] => [c[0], c[1], c[2], 255];
/** 背景 / disposal 2 的填色：调色板项按 B、G、R、A 存、整拷进画布，R、B 互换。 */
const swapped = (c: Rgb, a = 255): number[] => [c[2], c[1], c[0], a];
const CLEAR = [0, 0, 0, 0];

function build(
  w: number,
  h: number,
  frames: FrameSpec[],
  opts: { palette?: readonly Rgb[]; bgindex?: number; version?: string; trailer?: boolean; before?: number[] } = {},
): Uint8Array {
  const parts: (number[] | Uint8Array)[] = [
    headerBlock(w, h, { palette: opts.palette, bgindex: opts.bgindex, version: opts.version }),
    opts.before ?? [],
  ];
  for (const f of frames) parts.push(frameBlock(f));
  if (opts.trailer !== false) parts.push(TRAILER);
  return concat(...parts);
}

const px = (g: GifAnimation, x: number, y = 0): number[] => {
  const o = (y * g.width + x) * 4;
  return Array.from(g.canvas.slice(o, o + 4));
};
const row = (g: GifAnimation, y = 0): number[][] => Array.from({ length: g.width }, (_, x) => px(g, x, y));
/** 每次走一个帧（延时都是 10 ms，dt = 1 s 必然够）。 */
const step = (g: GifAnimation): void => {
  expect(g.advance(1)).toBe(true);
};
/** 确定性伪随机。 */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s >>> 8;
  };
}

describe("头与签名", () => {
  it("GIF89a / GIF87a 都能解；画布是 RGBA 直通", () => {
    for (const version of ["89a", "87a"]) {
      const g = GifAnimation.open(build(3, 2, [{ w: 3, h: 2, indices: [0, 1, 2, 3, 0, 1] }], { palette: P4, version }));
      expect(g.width).toBe(3);
      expect(g.height).toBe(2);
      expect(g.canvas.length).toBe(24);
      expect(row(g, 0)).toEqual([rgba(RED), rgba(GREEN), rgba(BLUE)]);
      expect(row(g, 1)).toEqual([rgba(YELLOW), rgba(RED), rgba(GREEN)]);
    }
  });

  it("签名不对（GIF88a、PNG、过短）抛错", () => {
    const frames = [{ w: 1, h: 1, indices: [0] }];
    expect(() => GifAnimation.open(build(1, 1, frames, { palette: P4, version: "88a" }))).toThrow(/not GIF/);
    expect(() => GifAnimation.open(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toThrow(
      /not GIF/,
    );
    expect(() => GifAnimation.open(new Uint8Array([0x47, 0x49, 0x46]))).toThrow(/not GIF/);
    expect(() => GifAnimation.open(new Uint8Array(0))).toThrow(/not GIF/);
  });

  it("尺寸：w * h * 4 超过 int32 抛 too large（头字段只有 16 位，0x1000000 的上限本身够不到）", () => {
    expect(() => GifAnimation.open(build(0x8000, 0x8000, [{ w: 1, h: 1, indices: [0] }], { palette: P4 }))).toThrow(
      /too large/,
    );
    expect(() => GifAnimation.open(build(65535, 65535, [], { palette: P4 }))).toThrow(/too large/);
  });

  it("没有任何调色板（全局、局部都没有）抛 missing color table", () => {
    expect(() => GifAnimation.open(build(1, 1, [{ w: 1, h: 1, indices: [0] }]))).toThrow(/missing color table/);
    // 局部调色板就够了
    const g = GifAnimation.open(build(1, 1, [{ w: 1, h: 1, indices: [1], palette: P4 }]));
    expect(px(g, 0)).toEqual(rgba(GREEN));
  });

  it("图像描述超出逻辑屏幕抛 bad Image Descriptor", () => {
    expect(() => GifAnimation.open(build(2, 2, [{ x: 1, w: 2, h: 1, indices: [0, 0] }], { palette: P4 }))).toThrow(
      /bad Image Descriptor/,
    );
    expect(() => GifAnimation.open(build(2, 2, [{ y: 1, w: 1, h: 2, indices: [0, 0] }], { palette: P4 }))).toThrow(
      /bad Image Descriptor/,
    );
  });

  it("只有结束符的文件：第一次读到 `;` 回到开头再读到 `;`，反编译里算解出（返回的状态指针非空）、画布全 0", () => {
    const g = GifAnimation.open(build(2, 1, [], { palette: P4 }));
    expect(row(g)).toEqual([CLEAR, CLEAR]);
  });

  it("没有结束符、也没有图像的文件：读到末尾失败（unknown code）", () => {
    expect(() => GifAnimation.open(build(2, 1, [], { palette: P4, trailer: false }))).toThrow(/unknown code/);
  });
});

describe("bgindex 与首帧背景", () => {
  /** 2×1 画布，第一帧只盖左边一个像素。 */
  const left = (bg: number, extra: Partial<FrameSpec> = {}, palette: readonly Rgb[] | null = P4): GifAnimation =>
    GifAnimation.open(
      build(2, 1, [{ x: 0, w: 1, h: 1, indices: [0], ...extra }], { palette: palette ?? undefined, bgindex: bg }),
    );

  it("bgindex 有效（非 0、在全局调色板内）：没写到的像素填 pal[bgindex]，R、B 互换", () => {
    const g = left(3);
    expect(px(g, 0)).toEqual(rgba(RED));
    expect(px(g, 1)).toEqual(swapped(YELLOW));
    expect(swapped(YELLOW)).not.toEqual(rgba(YELLOW));
    expect(px(left(2), 1)).toEqual(swapped(BLUE));
  });

  it("bgindex = 0 不用（WPE 对 stb 的修改）", () => {
    expect(px(left(0), 1)).toEqual(CLEAR);
  });

  it("bgindex 越界（== 调色板项数、更大）不用", () => {
    expect(px(left(4), 1)).toEqual(CLEAR);
    expect(px(left(200), 1)).toEqual(CLEAR);
  });

  it("没有全局调色板时 bgindex 不用", () => {
    expect(px(left(3, { palette: P4 }, null), 1)).toEqual(CLEAR);
  });

  it("本帧 GCE 带透明位时不填背景", () => {
    expect(px(left(3, { gce: { transparent: 2, delay: 1 } }), 1)).toEqual(CLEAR);
    expect(px(left(3, { gce: { delay: 1 } }), 1)).toEqual(swapped(YELLOW));
  });

  it("w == 0 的描述：不写任何像素，「写过」表为空，所以首帧背景填满全画布", () => {
    const g = GifAnimation.open(build(2, 1, [{ w: 0, h: 1, indices: [0, 1] }], { palette: P4, bgindex: 3 }));
    expect(row(g)).toEqual([swapped(YELLOW), swapped(YELLOW)]);
  });
});

describe("写像素：alpha > 128 才写，写没写都记「写过」", () => {
  it("透明下标不写（保持原值），不透明的照写", () => {
    const g = GifAnimation.open(
      build(3, 1, [{ w: 3, h: 1, indices: [1, 2, 1], gce: { transparent: 1, delay: 1 } }], { palette: P4 }),
    );
    expect(row(g)).toEqual([CLEAR, rgba(BLUE), CLEAR]);
  });

  it("没写的透明像素也进「写过」表：下一帧的 disposal 2 会把它改成 pal[transparent]（alpha 0）", () => {
    const g = GifAnimation.open(
      build(
        2,
        1,
        [
          { w: 2, h: 1, indices: [1, 2], gce: { disposal: 2, transparent: 1, delay: 1 } },
          { x: 1, w: 1, h: 1, indices: [0], gce: { delay: 1 } },
        ],
        { palette: P4, bgindex: 3 },
      ),
    );
    expect(row(g)).toEqual([CLEAR, rgba(BLUE)]);
    step(g);
    // px0 在第一帧没写成，但被记过 → 第二帧开始时变成 pal[1] 的 4 字节、alpha 0；px1 先被同样处理再被第二帧写成红
    expect(px(g, 0)).toEqual(swapped(GREEN, 0));
    expect(px(g, 1)).toEqual(rgba(RED));
  });

  it("GCE 的透明位改全局调色板的 alpha：下一个 GCE 不带透明位时恢复", () => {
    const g = GifAnimation.open(
      build(
        2,
        1,
        [
          { w: 2, h: 1, indices: [0, 1], gce: { transparent: 1, delay: 1 } },
          { w: 2, h: 1, indices: [0, 1], gce: { delay: 1 } },
        ],
        { palette: P4 },
      ),
    );
    expect(row(g)).toEqual([rgba(RED), CLEAR]);
    step(g);
    expect(row(g)).toEqual([rgba(RED), rgba(GREEN)]);
  });
});

describe("disposal", () => {
  /** 3 像素宽：第一帧铺满红绿蓝；第二帧改中间；第三帧改左边。 */
  const dispose2 = (second: FrameSpec["gce"], bg: number): GifAnimation => {
    const g = GifAnimation.open(
      build(
        3,
        1,
        [
          { w: 3, h: 1, indices: [0, 1, 2], gce: { delay: 1 } },
          { x: 1, w: 1, h: 1, indices: [3], gce: second },
          { x: 0, w: 1, h: 1, indices: [1], gce: { delay: 1 } },
        ],
        { palette: P4, bgindex: bg },
      ),
    );
    step(g);
    expect(row(g)).toEqual([rgba(RED), rgba(YELLOW), rgba(BLUE)]);
    step(g);
    return g;
  };

  it("disposal 2，bgindex < 0：上一帧写过的像素清成 (0,0,0,0)，别的像素不动", () => {
    const g = dispose2({ disposal: 2, delay: 1 }, 0);
    expect(row(g)).toEqual([rgba(GREEN), CLEAR, rgba(BLUE)]);
  });

  it("disposal 2，bgindex 有效、上一帧不透明：改成 pal[bgindex] 的 4 字节（R、B 互换）", () => {
    const g = dispose2({ disposal: 2, delay: 1 }, 3);
    expect(row(g)).toEqual([rgba(GREEN), swapped(YELLOW), rgba(BLUE)]);
  });

  it("disposal 2，bgindex 有效、上一帧带透明：改成 pal[transparent] 的 4 字节、alpha 0（R、B 互换）", () => {
    const g = dispose2({ disposal: 2, transparent: 2, delay: 1 }, 3);
    expect(row(g)).toEqual([rgba(GREEN), swapped(BLUE, 0), rgba(BLUE)]);
  });

  it("disposal 0、1、4–7 都不动", () => {
    for (const disposal of [0, 1, 4, 5, 6, 7]) {
      const g = dispose2({ disposal, delay: 1 }, 3);
      expect(row(g)).toEqual([rgba(GREEN), rgba(YELLOW), rgba(BLUE)]);
    }
  });

  it("disposal 3 有 two_back：写过的像素恢复成 two_back", () => {
    const g = GifAnimation.open(
      build(
        3,
        1,
        [
          { w: 3, h: 1, indices: [0, 1, 2], gce: { disposal: 0, delay: 1 } },
          { x: 1, w: 1, h: 1, indices: [3], gce: { disposal: 3, delay: 1 } },
          { x: 2, w: 1, h: 1, indices: [3], gce: { delay: 1 } },
        ],
        { palette: P4 },
      ),
    );
    step(g);
    expect(row(g)).toEqual([rgba(RED), rgba(YELLOW), rgba(BLUE)]);
    step(g);
    expect(row(g)).toEqual([rgba(RED), rgba(GREEN), rgba(YELLOW)]);
  });

  it("disposal 3 没有 two_back：按 2 处理（disposal 3 的帧自己不建 two_back）", () => {
    const g = GifAnimation.open(
      build(
        3,
        1,
        [
          { x: 0, w: 1, h: 1, indices: [0], gce: { disposal: 3, delay: 1 } },
          { x: 2, w: 1, h: 1, indices: [2], gce: { delay: 1 } },
        ],
        { palette: P4, bgindex: 0 },
      ),
    );
    expect(px(g, 0)).toEqual(rgba(RED));
    step(g);
    expect(row(g)).toEqual([CLEAR, CLEAR, rgba(BLUE)]);
  });

  it("disposal 3 没有 two_back、bgindex 有效：按 2 → pal[bgindex] 的 4 字节", () => {
    const g = GifAnimation.open(
      build(
        2,
        1,
        [
          { x: 0, w: 1, h: 1, indices: [0], gce: { disposal: 3, delay: 1 } },
          { x: 1, w: 1, h: 1, indices: [2], gce: { delay: 1 } },
        ],
        { palette: P4, bgindex: 1 },
      ),
    );
    step(g);
    expect(row(g)).toEqual([swapped(GREEN), rgba(BLUE)]);
  });

  it("two_back 只在 disposal 0 / 1 的帧之后更新", () => {
    const g = GifAnimation.open(
      build(
        3,
        1,
        [
          { w: 3, h: 1, indices: [0, 1, 2], gce: { disposal: 1, delay: 1 } }, // two_back = [红, 绿, 蓝]
          { x: 1, w: 1, h: 1, indices: [3], gce: { disposal: 0, delay: 1 } }, // two_back = [红, 黄, 蓝]
          { x: 0, w: 1, h: 1, indices: [1], gce: { disposal: 3, delay: 1 } }, // 不更新 two_back
          { x: 2, w: 1, h: 1, indices: [0], gce: { delay: 1 } },
        ],
        { palette: P4 },
      ),
    );
    step(g);
    step(g);
    expect(row(g)).toEqual([rgba(GREEN), rgba(YELLOW), rgba(BLUE)]);
    step(g);
    // 第三帧的 disposal 3：左边恢复成「第二帧之后」的红（若 two_back 被第三帧更新就会是绿），右边写红
    expect(row(g)).toEqual([rgba(RED), rgba(YELLOW), rgba(RED)]);
  });
});

describe("交错、局部调色板", () => {
  it("交错四遍的行序（整画布）", () => {
    for (const h of [1, 2, 5, 8, 9, 16, 21]) {
      const palette: Rgb[] = Array.from({ length: 32 }, (_, i) => [i * 8, 0, 0]);
      const order = interlaceRowOrder(h);
      // 存储顺序里第 k 行的下标 = k
      const indices = order.flatMap((_, k) => [k, k]);
      const g = GifAnimation.open(build(2, h, [{ w: 2, h, indices, interlace: true, minCodeSize: 5 }], { palette }));
      for (let k = 0; k < h; k++) {
        expect(px(g, 0, order[k]!)).toEqual([k * 8, 0, 0, 255]);
        expect(px(g, 1, order[k]!)).toEqual([k * 8, 0, 0, 255]);
      }
    }
  });

  it("交错的子矩形（x、y 偏移）只写矩形内，行序按矩形高度", () => {
    const palette: Rgb[] = Array.from({ length: 16 }, (_, i) => [i * 16, 0, 0]);
    const order = interlaceRowOrder(8);
    const indices = order.flatMap((_, k) => [k, k]);
    const g = GifAnimation.open(
      build(4, 10, [{ x: 1, y: 2, w: 2, h: 8, indices, interlace: true, minCodeSize: 4 }], { palette }),
    );
    for (let k = 0; k < 8; k++) {
      expect(px(g, 1, 2 + order[k]!)).toEqual([k * 16, 0, 0, 255]);
      expect(px(g, 2, 2 + order[k]!)).toEqual([k * 16, 0, 0, 255]);
    }
    expect(px(g, 0, 2)).toEqual(CLEAR);
    expect(px(g, 3, 5)).toEqual(CLEAR);
    expect(px(g, 1, 0)).toEqual(CLEAR);
    expect(px(g, 1, 1)).toEqual(CLEAR);
  });

  it("局部调色板的颜色盖过全局", () => {
    const local: Rgb[] = [
      [10, 20, 30],
      [40, 50, 60],
    ];
    const g = GifAnimation.open(build(2, 1, [{ w: 2, h: 1, indices: [0, 1], palette: local }], { palette: P4 }));
    expect(row(g)).toEqual([
      [10, 20, 30, 255],
      [40, 50, 60, 255],
    ]);
  });

  it("局部调色板带 GCE 的透明下标：该项 alpha 0、不写", () => {
    const local: Rgb[] = [
      [10, 20, 30],
      [40, 50, 60],
    ];
    const g = GifAnimation.open(
      build(2, 1, [{ w: 2, h: 1, indices: [0, 1], palette: local, gce: { transparent: 1, delay: 1 } }], {
        palette: P4,
      }),
    );
    expect(row(g)).toEqual([[10, 20, 30, 255], CLEAR]);
  });

  it("没有新 GCE 的帧沿用上一个 GCE 的 eflags / transparent（局部调色板的透明下标也跟着）", () => {
    const local: Rgb[] = [
      [10, 20, 30],
      [40, 50, 60],
    ];
    const g = GifAnimation.open(
      build(
        2,
        1,
        [
          { w: 2, h: 1, indices: [0, 1], gce: { transparent: 1, delay: 1 } },
          { w: 2, h: 1, indices: [1, 0], palette: local, noGce: true },
        ],
        { palette: P4 },
      ),
    );
    step(g);
    expect(row(g)).toEqual([rgba(RED), [10, 20, 30, 255]]);
  });

  it("本帧 GCE 不带透明位时局部调色板没有透明项", () => {
    const local: Rgb[] = [
      [10, 20, 30],
      [40, 50, 60],
    ];
    const g = GifAnimation.open(
      build(
        2,
        1,
        [
          { w: 2, h: 1, indices: [0, 1], gce: { transparent: 1, delay: 1 } },
          { w: 2, h: 1, indices: [0, 1], palette: local, gce: { delay: 1 } },
        ],
        { palette: P4 },
      ),
    );
    step(g);
    expect(row(g)).toEqual([
      [10, 20, 30, 255],
      [40, 50, 60, 255],
    ]);
  });
});

describe("LZW", () => {
  const expectedRow = (indices: number[], palette: readonly Rgb[]): number[][] => indices.map((i) => rgba(palette[i]!));

  it("清除码、结束码；随机数据往返（4 色）", () => {
    const rnd = lcg(1);
    const indices = Array.from({ length: 50 * 50 }, () => rnd() & 3);
    const g = GifAnimation.open(build(50, 50, [{ w: 50, h: 50, indices }], { palette: P4 }));
    for (let y = 0; y < 50; y++) {
      expect(row(g, y)).toEqual(expectedRow(indices.slice(y * 50, y * 50 + 50), P4));
    }
  });

  it("码宽增长到 12 位、字典满后发清除码（256 色随机数据）", () => {
    const palette: Rgb[] = Array.from({ length: 256 }, (_, i) => [i, 255 - i, (i * 7) & 255]);
    const rnd = lcg(7);
    const w = 200;
    const h = 100;
    const indices = Array.from({ length: w * h }, () => rnd() & 255);
    const codes = lzwCodes(indices, 8);
    expect(Math.max(...codes)).toBeGreaterThanOrEqual(2048); // 用到了 12 位的码
    expect(codes.filter((c) => c === 256).length).toBeGreaterThan(1); // 中途发过清除码
    const g = GifAnimation.open(build(w, h, [{ w, h, indices, minCodeSize: 8 }], { palette }));
    for (let y = 0; y < h; y += 7) {
      expect(row(g, y)).toEqual(expectedRow(indices.slice(y * w, y * w + w), palette));
    }
    expect(px(g, w - 1, h - 1)).toEqual(rgba(palette[indices[w * h - 1]!]!));
  });

  it("低熵数据：码宽逐级增长 3→12 位、字典满清除多次（4 色、2 万像素）", () => {
    const rnd = lcg(99);
    const indices = Array.from({ length: 20000 }, () => (rnd() & 7 ? 0 : rnd() & 3));
    const g = GifAnimation.open(build(200, 100, [{ w: 200, h: 100, indices }], { palette: P4 }));
    for (let y = 0; y < 100; y += 9) {
      expect(row(g, y)).toEqual(expectedRow(indices.slice(y * 200, y * 200 + 200), P4));
    }
  });

  it("KwKwK（code == avail）：手造码流 清除、0、6、7、结束 → 6 个 0", () => {
    const g = GifAnimation.open(build(6, 1, [{ w: 6, h: 1, indices: [], codes: [4, 0, 6, 7, 5] }], { palette: P4 }));
    expect(row(g)).toEqual(Array.from({ length: 6 }, () => rgba(RED)));
  });

  it("KwKwK：标准编码器对全 0 数据产生的码流也能解", () => {
    const indices = new Array<number>(100).fill(1);
    const codes = lzwCodes(indices, 2);
    // 全相同数据的第三个码就是 KwKwK（clear=4, eoi=5, 第一个新项是 6）
    expect(codes.slice(0, 4)).toEqual([4, 1, 6, 7]);
    const g = GifAnimation.open(build(100, 1, [{ w: 100, h: 1, indices }], { palette: P4 }));
    expect(row(g)).toEqual(Array.from({ length: 100 }, () => rgba(GREEN)));
  });

  it("清除码之后可以继续（复位码宽与码表）", () => {
    const g = GifAnimation.open(
      build(4, 1, [{ w: 4, h: 1, indices: [], codes: [4, 0, 1, 4, 2, 3, 5] }], { palette: P4 }),
    );
    expect(row(g)).toEqual([rgba(RED), rgba(GREEN), rgba(BLUE), rgba(YELLOW)]);
  });

  it("没有先发清除码：no clear code", () => {
    expect(() =>
      GifAnimation.open(build(2, 1, [{ w: 2, h: 1, indices: [], codes: [0, 1, 5] }], { palette: P4 })),
    ).toThrow(/no clear code/);
  });

  it("code > avail：illegal code；刚清除后 code == avail 也是非法", () => {
    expect(() =>
      GifAnimation.open(build(2, 1, [{ w: 2, h: 1, indices: [], codes: [4, 0, 7, 5] }], { palette: P4 })),
    ).toThrow(/illegal code/);
    expect(() =>
      GifAnimation.open(build(2, 1, [{ w: 2, h: 1, indices: [], codes: [4, 6, 5] }], { palette: P4 })),
    ).toThrow(/illegal code/);
  });

  it("不发清除码地灌满码表：too many codes（avail > 0x2000）", () => {
    const codes = [4, ...new Array<number>(9000).fill(0), 5];
    expect(() => GifAnimation.open(build(1, 1, [{ w: 1, h: 1, indices: [], codes }], { palette: P4 }))).toThrow(
      /too many codes/,
    );
  });

  it("最小码宽 > 12 失败", () => {
    expect(() =>
      GifAnimation.open(build(1, 1, [{ w: 1, h: 1, indices: [], codes: [], minCodeSize: 13 }], { palette: P4 })),
    ).toThrow();
  });

  it("结束码后同一子块里的多余字节与之后的子块都被跳过，下一帧照常解", () => {
    const g = GifAnimation.open(
      build(
        2,
        1,
        [
          { w: 2, h: 1, indices: [0, 1], trailing: [0xaa, 0xbb, 0xcc], gce: { delay: 1 } },
          { w: 2, h: 1, indices: [2, 3], gce: { delay: 1 } },
        ],
        { palette: P4 },
      ),
    );
    expect(row(g)).toEqual([rgba(RED), rgba(GREEN)]);
    step(g);
    expect(row(g)).toEqual([rgba(BLUE), rgba(YELLOW)]);
  });

  it("码流跨多个小子块", () => {
    const rnd = lcg(5);
    const indices = Array.from({ length: 300 }, () => rnd() & 3);
    const g = GifAnimation.open(build(300, 1, [{ w: 300, h: 1, indices, blockSize: 3 }], { palette: P4 }));
    expect(row(g)).toEqual(expectedRow(indices, P4));
  });

  it("没有结束码、子块长度 0 直接收尾：光栅正常结束，已写像素保留", () => {
    const codes = lzwCodes([0, 1, 2, 3], 2).slice(0, -1);
    const g = GifAnimation.open(build(4, 1, [{ w: 4, h: 1, indices: [], codes }], { palette: P4 }));
    expect(row(g)).toEqual([rgba(RED), rgba(GREEN), rgba(BLUE), rgba(YELLOW)]);
  });

  it("像素比画布多：多出的丢弃；比画布少：剩下的保持原值", () => {
    const g = GifAnimation.open(build(2, 1, [{ w: 2, h: 1, indices: [0, 1, 2, 3, 0] }], { palette: P4 }));
    expect(row(g)).toEqual([rgba(RED), rgba(GREEN)]);
    const h = GifAnimation.open(build(3, 1, [{ w: 3, h: 1, indices: [2] }], { palette: P4 }));
    expect(row(h)).toEqual([rgba(BLUE), CLEAR, CLEAR]);
  });
});

describe("块循环：扩展与未知块", () => {
  const comment = [0x21, 0xfe, 3, 0x61, 0x62, 0x63, 2, 0x64, 0x65, 0];
  const netscape = [0x21, 0xff, 11, ...[..."NETSCAPE2.0"].map((c) => c.charCodeAt(0)), 3, 1, 0, 0, 0];
  const plainText = [0x21, 0x01, 12, 0, 0, 0, 0, 1, 0, 1, 0, 8, 8, 1, 0, 2, 0x41, 0x42, 0];

  it("注释、应用（NETSCAPE2.0）、纯文本扩展整段跳过", () => {
    const g = GifAnimation.open(
      build(2, 1, [{ w: 2, h: 1, indices: [1, 2] }], { palette: P4, before: [...netscape, ...comment, ...plainText] }),
    );
    expect(row(g)).toEqual([rgba(GREEN), rgba(BLUE)]);
  });

  it("GCE 长度 != 4：只跳过 len 字节就回块循环，eflags / delay 不变", () => {
    const g = GifAnimation.open(
      build(2, 1, [{ w: 2, h: 1, indices: [1, 2] }], { palette: P4, before: [0x21, 0xf9, 2, 0xaa, 0xbb] }),
    );
    expect(row(g)).toEqual([rgba(GREEN), rgba(BLUE)]);
    expect(g.frameDelayMs).toBe(0);
  });

  it("GCE 长度 != 4 且后面跟了结束子块的 0：这个 0 被当成块标签，unknown code", () => {
    expect(() =>
      GifAnimation.open(
        build(2, 1, [{ w: 2, h: 1, indices: [1, 2] }], { palette: P4, before: [0x21, 0xf9, 2, 0xaa, 0xbb, 0] }),
      ),
    ).toThrow(/unknown code/);
  });

  it("未知的块标签：unknown code", () => {
    expect(() =>
      GifAnimation.open(build(2, 1, [{ w: 2, h: 1, indices: [1, 2] }], { palette: P4, before: [0x99] })),
    ).toThrow(/unknown code/);
  });

  it("GCE 的延时读成毫秒（百分之一秒 × 10）", () => {
    const g = GifAnimation.open(build(1, 1, [{ w: 1, h: 1, indices: [0], gce: { delay: 37 } }], { palette: P4 }));
    expect(g.frameDelayMs).toBe(370);
    expect(g.remain).toBe(Math.fround(0.37));
  });
});

describe("advance：时序", () => {
  const three = (delays: [number, number, number], extra: Partial<FrameSpec> = {}): GifAnimation =>
    GifAnimation.open(
      build(
        1,
        1,
        [0, 1, 2].map((i) => ({ w: 1, h: 1, indices: [i], gce: { delay: delays[i]! }, ...extra })),
        { palette: P4 },
      ),
    );

  it("open 解出第 0 帧（不看时间），剩余时间 = 第 0 帧的延时（float32）", () => {
    const g = three([10, 20, 5]);
    expect(g.frameIndex).toBe(1);
    expect(px(g, 0)).toEqual(rgba(RED));
    expect(g.remain).toBe(Math.fround(0.1));
  });

  it("剩余时间没到：只扣时间、返回 false；到了才换帧并带上超出的部分", () => {
    const g = three([10, 20, 5]);
    expect(g.advance(0.0625)).toBe(false);
    expect(px(g, 0)).toEqual(rgba(RED));
    expect(g.remain).toBeCloseTo(0.1 - 0.0625, 6);
    expect(g.advance(0.0625)).toBe(true);
    expect(px(g, 0)).toEqual(rgba(GREEN));
    expect(g.frameIndex).toBe(2);
    expect(g.remain).toBeCloseTo(0.2 + (0.1 - 0.125), 6);
    expect(g.remain).toBe(Math.fround(g.remain));
  });

  it("dt 按 float32 取整后再扣", () => {
    const g = three([10, 20, 5]);
    // 0.1 的 float32 是 0.10000000149…；dt = 0.1（double）取 float32 后与剩余时间相等 → 正好 0 → 换帧
    expect(g.advance(0.1)).toBe(true);
    expect(g.remain).toBe(Math.fround(0.2));
  });

  it("一次最多一帧；落后的时间留成负数，之后每次调用都换一帧直到补完", () => {
    const g = three([10, 20, 5]);
    expect(g.advance(100)).toBe(true);
    expect(g.frameIndex).toBe(2);
    expect(px(g, 0)).toEqual(rgba(GREEN));
    expect(g.remain).toBeLessThan(-99);
    expect(g.advance(0)).toBe(true); // remain <= 0：不扣时间直接换
    expect(g.frameIndex).toBe(3);
    expect(px(g, 0)).toEqual(rgba(BLUE));
    expect(g.advance(0)).toBe(true); // 读到 `;` 回到开头
    expect(px(g, 0)).toEqual(rgba(RED));
  });

  it("延时 0 的帧不挡路：下一次调用（dt = 0）就换", () => {
    const g = three([0, 0, 0]);
    expect(g.remain).toBe(0);
    expect(g.advance(0)).toBe(true);
    expect(px(g, 0)).toEqual(rgba(GREEN));
    expect(g.advance(0)).toBe(true);
    expect(px(g, 0)).toEqual(rgba(BLUE));
  });

  it("读到 `;` 回到文件开头按首帧规则重来：画布清空、第 0 帧的背景重新填、disposal 不带过去", () => {
    const g = GifAnimation.open(
      build(
        2,
        1,
        [
          { x: 0, w: 1, h: 1, indices: [0], gce: { delay: 1 } },
          { x: 0, w: 1, h: 1, indices: [1], gce: { disposal: 2, delay: 1 } },
        ],
        { palette: P4, bgindex: 3 },
      ),
    );
    expect(row(g)).toEqual([rgba(RED), swapped(YELLOW)]);
    step(g);
    expect(row(g)).toEqual([rgba(GREEN), swapped(YELLOW)]);
    step(g); // `;` → 重来
    expect(row(g)).toEqual([rgba(RED), swapped(YELLOW)]);
    expect(g.frameIndex).toBe(3);
    step(g);
    expect(row(g)).toEqual([rgba(GREEN), swapped(YELLOW)]);
  });

  it("重来时重读头：全局调色板 alpha 恢复、transparent 重置", () => {
    const g = GifAnimation.open(
      build(
        1,
        1,
        [
          { w: 1, h: 1, indices: [1], gce: { transparent: 1, delay: 1 } },
          { w: 1, h: 1, indices: [0], gce: { delay: 1 } },
        ],
        { palette: P4 },
      ),
    );
    expect(px(g, 0)).toEqual(CLEAR);
    step(g);
    step(g); // 重来：第 0 帧的 GCE 又把 pal[1].a 置 0，画布是全 0
    expect(px(g, 0)).toEqual(CLEAR);
  });

  it("没有 `;` 的文件：读到末尾失败，advance 返回 false、画布保持（disposal 0 时）", () => {
    const g = GifAnimation.open(
      build(
        1,
        1,
        [
          { w: 1, h: 1, indices: [0], gce: { delay: 1 } },
          { w: 1, h: 1, indices: [1], gce: { delay: 1 } },
        ],
        { palette: P4, trailer: false },
      ),
    );
    step(g);
    expect(px(g, 0)).toEqual(rgba(GREEN));
    const before = g.frameIndex;
    expect(g.advance(1)).toBe(false);
    expect(g.advance(1)).toBe(false);
    expect(g.frameIndex).toBe(before);
    expect(px(g, 0)).toEqual(rgba(GREEN));
    expect(g.lastError).toBe("unknown code");
  });

  it("canvas 是同一个对象，换帧时原地改", () => {
    const g = three([1, 1, 1]);
    const canvas = g.canvas;
    step(g);
    expect(g.canvas).toBe(canvas);
    expect(Array.from(canvas)).toEqual(rgba(GREEN));
  });
});

describe("规模", () => {
  it("1000×1000、30 帧：逐帧解完（不断言时间）", () => {
    const w = 1000;
    const h = 1000;
    const palette: Rgb[] = Array.from({ length: 256 }, (_, i) => [i, (i * 3) & 255, 255 - i]);
    const rnd = lcg(3);
    // 渐变加噪声：既不是全同也不是纯随机
    const indices = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) indices[y * w + x] = ((x >> 2) + (y >> 2) + (rnd() & 3)) & 255;
    }
    const one = frameBlock({ w, h, indices, minCodeSize: 8, gce: { delay: 1 } });
    const frame = Uint8Array.from(one);
    const file = concat(headerBlock(w, h, { palette }), ...Array.from({ length: 30 }, () => frame), TRAILER);
    const g = GifAnimation.open(file);
    expect(g.canvas.length).toBe(w * h * 4);
    for (let i = 1; i < 30; i++) expect(g.advance(1)).toBe(true);
    expect(g.frameIndex).toBe(30);
    const last = indices[w * h - 1]!;
    expect(px(g, w - 1, h - 1)).toEqual(rgba(palette[last]!));
  });
});

describe("ut-anim2.gif 对照（四帧 300×200）", () => {
  const candidates = [
    fileURLToPath(new URL("../../../../texsrc/ut-anim2.gif", import.meta.url)),
    fileURLToPath(new URL("../../../../ignore/p11/texsrc/ut-anim2.gif", import.meta.url)),
    process.env.KABEGAME_P11_TEXSRC ? `${process.env.KABEGAME_P11_TEXSRC}/ut-anim2.gif` : "",
  ].filter((p) => p !== "");
  const file = candidates.find((p) => existsSync(p));
  const run = file ? it : it.skip;

  const colors = (g: GifAnimation): Set<string> => {
    const set = new Set<string>();
    for (let i = 0; i < g.canvas.length; i += 4) {
      set.add(`${g.canvas[i]},${g.canvas[i + 1]},${g.canvas[i + 2]},${g.canvas[i + 3]}`);
    }
    return set;
  };

  run("尺寸、四帧的延时、第 3 帧左半透明（上一帧 disposal 2 清空）、第 4 帧后回到第 0 帧", () => {
    const g = GifAnimation.open(new Uint8Array(readFileSync(file!)));
    expect([g.width, g.height]).toEqual([300, 200]);
    const first = Array.from(g.canvas);
    expect(colors(g).size).toBeGreaterThan(0);
    expect(g.remain).toBeCloseTo(0.1, 6);

    expect(g.advance(0.1)).toBe(true); // 第 1 帧：延时 200
    expect(g.remain).toBeCloseTo(0.2, 5);
    expect(g.advance(0.2)).toBe(true); // 第 2 帧：x = 150 起的右半，延时 50
    expect(g.remain).toBeCloseTo(0.05, 5);
    // 第 1 帧 disposal 2、bgindex 为 0 即不用（−1）：上一帧整幅写过 → 整幅先清成 0，右半再画第 2 帧
    expect(px(g, 10, 10)).toEqual(CLEAR);
    expect(px(g, 140, 100)).toEqual(CLEAR);
    expect(px(g, 160, 100)[3]).toBe(255);

    expect(g.advance(0.05)).toBe(true); // 第 3 帧：延时 300
    expect(g.remain).toBeCloseTo(0.3, 5);
    expect(g.advance(0.3)).toBe(true); // `;` → 重新开始 → 第 0 帧
    expect(Array.from(g.canvas)).toEqual(first);
    expect(g.frameIndex).toBe(5);
  });
});
