import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import {
  DEFAULT_MAX_EDGE,
  PngError,
  decodePng,
  downscale,
  encodePng,
  fitSize,
  parseResizeSpec,
  pngSize,
  resizePng,
} from "./png.ts";
import type { RawImage } from "./png.ts";

/** 确定的伪随机像素（同一 seed 每次一样）。 */
function noise(width: number, height: number, channels: 3 | 4, seed = 1, opaque = false): RawImage {
  const data = new Uint8Array(width * height * channels);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < data.length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    data[i] = x & 0xff;
    if (opaque && channels === 4 && i % 4 === 3) data[i] = 255;
  }
  return { width, height, channels, data };
}

/** 平滑渐变：让编码器挑到 Sub / Up / Average / Paeth。 */
function gradient(width: number, height: number, channels: 3 | 4): RawImage {
  const data = new Uint8Array(width * height * channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * channels;
      data[o] = (x * 3) & 0xff;
      data[o + 1] = (y * 5) & 0xff;
      data[o + 2] = (x + y) & 0xff;
      if (channels === 4) data[o + 3] = 255 - ((x * y) & 0x7f);
    }
  }
  return { width, height, channels, data };
}

const mean = (image: RawImage, channel: number) => {
  let sum = 0;
  for (let i = channel; i < image.data.length; i += image.channels) sum += image.data[i];
  return sum / (image.width * image.height);
};

// ---- 手工拼 PNG（造不支持的格式用）
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc = (bytes: Uint8Array) => {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type: string, data: Uint8Array): Uint8Array {
  const body = new Uint8Array(4 + data.length);
  body.set(Uint8Array.from(type, (ch) => ch.charCodeAt(0)));
  body.set(data, 4);
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(body, 4);
  view.setUint32(8 + data.length, crc(body));
  return out;
}
function rawPng(
  header: { width: number; height: number; depth: number; color: number; interlace?: number },
  raw: Uint8Array,
  extra: Uint8Array[] = [],
) {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, header.width);
  view.setUint32(4, header.height);
  ihdr[8] = header.depth;
  ihdr[9] = header.color;
  ihdr[12] = header.interlace ?? 0;
  const parts = [
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    chunk("IHDR", ihdr),
    ...extra,
    chunk("IDAT", new Uint8Array(deflateSync(raw))),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// 1×1 RGBA（别的编码器产出的）
const ONE_PIXEL = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);

describe("PNG 编解码", () => {
  test("RGB 与 RGBA 编码再解码逐字节相同（噪声与渐变，各种过滤类型）", () => {
    for (const channels of [3, 4] as const) {
      for (const image of [noise(37, 23, channels, 7), gradient(64, 48, channels), noise(1, 1, channels, 3)]) {
        const png = encodePng(image);
        assert.deepEqual(pngSize(png), { width: image.width, height: image.height });
        const back = decodePng(png);
        assert.equal(back.channels, channels);
        assert.equal(back.width, image.width);
        assert.equal(back.height, image.height);
        assert.deepEqual(back.data, image.data);
      }
    }
  });

  test("渐变图的过滤类型不全是 None（编码器确实在挑）", () => {
    const png = encodePng(gradient(64, 48, 4));
    const plain = encodePng({ ...gradient(64, 48, 4) });
    assert.deepEqual(png, plain, "同输入同输出");
    // 不挑过滤时（全 None）压出来会大得多
    const raw = new Uint8Array(48 * (64 * 4 + 1));
    const g = gradient(64, 48, 4);
    for (let y = 0; y < 48; y++) raw.set(g.data.subarray(y * 256, (y + 1) * 256), y * 257 + 1);
    assert.ok(png.length < rawPng({ width: 64, height: 48, depth: 8, color: 6 }, raw).length);
  });

  test("能读别的编码器产出的 RGBA，以及自己拼的 RGB（带辅助块）", () => {
    const one = decodePng(ONE_PIXEL);
    assert.equal(one.channels, 4);
    assert.equal(one.width, 1);
    assert.equal(one.data.length, 4);
    // 每行过滤类型 0..4 都走一遍
    const width = 3;
    const rows = [0, 1, 2, 3, 4].map((filter, y) => [
      filter,
      ...Array.from({ length: width * 3 }, (_, i) => (y * 17 + i * 5) & 0xff),
    ]);
    const text = chunk(
      "tEXt",
      Uint8Array.from("k\0v", (ch) => ch.charCodeAt(0)),
    );
    const png = rawPng({ width, height: 5, depth: 8, color: 2 }, Uint8Array.from(rows.flat()), [text]);
    const decoded = decodePng(png);
    assert.equal(decoded.channels, 3);
    // 用同一套规则手算期望值
    const expected = new Uint8Array(5 * width * 3);
    const paeth = (a: number, b: number, c: number) => {
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    };
    for (let y = 0; y < 5; y++) {
      for (let i = 0; i < width * 3; i++) {
        const a = i >= 3 ? expected[y * 9 + i - 3] : 0;
        const b = y > 0 ? expected[(y - 1) * 9 + i] : 0;
        const c = i >= 3 && y > 0 ? expected[(y - 1) * 9 + i - 3] : 0;
        const pred = [0, a, b, (a + b) >> 1, paeth(a, b, c)][rows[y][0]];
        expected[y * 9 + i] = (rows[y][i + 1] + pred) & 0xff;
      }
    }
    assert.deepEqual(decoded.data, expected);
  });

  test("不支持的格式明确报错：调色板、灰度、灰度 + alpha、16 位、隔行", () => {
    const one = Uint8Array.of(0, 0);
    const cases: Array<[Parameters<typeof rawPng>[0], RegExp]> = [
      [{ width: 1, height: 1, depth: 8, color: 3 }, /颜色类型 3（调色板）/],
      [{ width: 1, height: 1, depth: 8, color: 0 }, /颜色类型 0（灰度）/],
      [{ width: 1, height: 1, depth: 8, color: 4 }, /颜色类型 4（灰度 \+ alpha）/],
      [{ width: 1, height: 1, depth: 16, color: 6 }, /16 位/],
      [{ width: 1, height: 1, depth: 8, color: 6, interlace: 1 }, /隔行/],
    ];
    for (const [header, pattern] of cases) {
      assert.throws(
        () => decodePng(rawPng(header, one)),
        (error: unknown) => error instanceof PngError && pattern.test(error.message),
      );
    }
  });

  test("坏数据报错：不是 PNG、CRC 不对、截断、像素不够", () => {
    assert.throws(() => decodePng(Uint8Array.of(1, 2, 3)), /签名/);
    const good = encodePng(noise(4, 4, 4));
    const crcBroken = good.slice();
    crcBroken[30] ^= 0xff; // IHDR 的 CRC
    assert.throws(() => decodePng(crcBroken), /CRC/);
    assert.throws(() => decodePng(good.subarray(0, good.length - 12)), /截断/);
    const short = rawPng({ width: 4, height: 4, depth: 8, color: 6 }, new Uint8Array(10));
    assert.throws(() => decodePng(short), /像素数据不够/);
    const badFilter = rawPng({ width: 1, height: 1, depth: 8, color: 2 }, Uint8Array.of(9, 1, 2, 3));
    assert.throws(() => decodePng(badFilter), /过滤类型 9/);
  });
});

describe("缩小", () => {
  test("整数倍：每个输出像素是 2×2 块的平均，均值不变（RGB 与 RGBA）", () => {
    for (const channels of [3, 4] as const) {
      const image = noise(8, 6, channels, 11, true);
      const small = downscale(image, 4, 3);
      assert.equal(small.channels, channels);
      assert.equal(small.data.length, 4 * 3 * channels);
      for (let y = 0; y < 3; y++) {
        for (let x = 0; x < 4; x++) {
          for (let c = 0; c < 3; c++) {
            const at = (xx: number, yy: number) => image.data[(yy * 8 + xx) * channels + c];
            const avg = (at(2 * x, 2 * y) + at(2 * x + 1, 2 * y) + at(2 * x, 2 * y + 1) + at(2 * x + 1, 2 * y + 1)) / 4;
            assert.ok(
              Math.abs(small.data[(y * 4 + x) * channels + c] - avg) <= 0.5,
              `${channels} 通道 (${x},${y}) c${c}`,
            );
          }
        }
      }
      for (let c = 0; c < 3; c++) assert.ok(Math.abs(mean(small, c) - mean(image, c)) < 0.5);
    }
  });

  test("非整数倍：尺寸对、均值近似不变", () => {
    for (const channels of [3, 4] as const) {
      const image = noise(101, 67, channels, 5, true);
      const small = downscale(image, 30, 17);
      assert.equal(small.width, 30);
      assert.equal(small.height, 17);
      for (let c = 0; c < channels; c++) assert.ok(Math.abs(mean(small, c) - mean(image, c)) < 1, `c${c}`);
    }
  });

  test("RGBA 先乘 alpha：透明像素的颜色不渗进来", () => {
    // 左边全透明红，右边不透明蓝 → 缩成 1×1：蓝色、alpha 一半
    const data = Uint8Array.of(255, 0, 0, 0, 0, 0, 255, 255);
    const small = downscale({ width: 2, height: 1, channels: 4, data }, 1, 1);
    assert.deepEqual([...small.data], [0, 0, 255, 128]);
  });

  test("只缩小不放大，目标等于原尺寸时原样回", () => {
    const image = noise(4, 4, 3);
    assert.throws(() => downscale(image, 5, 4), /不放大/);
    assert.equal(downscale(image, 4, 4), image);
  });
});

describe("尺寸约束", () => {
  test("缺省长边 1568 等比，不超过的原样", () => {
    assert.equal(DEFAULT_MAX_EDGE, 1568);
    assert.deepEqual(fitSize({ width: 3441, height: 2465 }), { width: 1568, height: 1123 });
    assert.deepEqual(fitSize({ width: 2465, height: 3441 }), { width: 1123, height: 1568 });
    assert.deepEqual(fitSize({ width: 1779, height: 1145 }, {}), { width: 1568, height: 1009 });
    assert.deepEqual(fitSize({ width: 1200, height: 800 }), { width: 1200, height: 800 });
  });

  test("scale / maxWidth / maxHeight 取最严的，不放大", () => {
    assert.deepEqual(fitSize({ width: 3441, height: 2465 }, { maxWidth: 400 }), { width: 400, height: 287 });
    assert.deepEqual(fitSize({ width: 3441, height: 2465 }, { maxHeight: 300 }), { width: 419, height: 300 });
    assert.deepEqual(fitSize({ width: 1000, height: 500 }, { scale: 0.5, maxWidth: 400 }), { width: 400, height: 200 });
    assert.deepEqual(fitSize({ width: 1000, height: 500 }, { scale: 2 }), { width: 1000, height: 500 });
    // 给了约束就不再套缺省的 1568
    assert.deepEqual(fitSize({ width: 3441, height: 2465 }, { scale: 1 }), { width: 3441, height: 2465 });
    assert.deepEqual(fitSize({ width: 10, height: 1000 }, { maxWidth: 1 }), { width: 1, height: 100 });
  });

  test("参数校验", () => {
    assert.equal(parseResizeSpec(undefined), undefined);
    assert.deepEqual(parseResizeSpec({ maxWidth: 400 }), { maxWidth: 400 });
    assert.throws(() => parseResizeSpec({ scale: 0 }), /scale/);
    assert.throws(() => parseResizeSpec({ maxWidth: 10.5 }), /maxWidth/);
    assert.throws(() => parseResizeSpec({ width: 10 }), /不认识 width/);
    assert.throws(() => parseResizeSpec([1]), /尺寸约束/);
  });

  test("resizePng：不需要缩小时原样回字节；需要时缩小并能再解码", () => {
    const png = encodePng(noise(40, 20, 4, 9, true));
    const same = resizePng(png);
    assert.equal(same.png, png);
    assert.equal(same.resized, false);
    assert.deepEqual(same.returned, { width: 40, height: 20 });
    const small = resizePng(png, { maxWidth: 10 });
    assert.equal(small.resized, true);
    assert.deepEqual(small.original, { width: 40, height: 20 });
    assert.deepEqual(small.returned, { width: 10, height: 5 });
    assert.deepEqual(pngSize(small.png), { width: 10, height: 5 });
    assert.equal(decodePng(small.png).channels, 4);
    // 需要缩小但格式不支持：报错，不回错图
    const palette = rawPng({ width: 40, height: 20, depth: 8, color: 3 }, new Uint8Array(20 * 41));
    assert.throws(() => resizePng(palette, { maxWidth: 10 }), /调色板/);
    assert.equal(resizePng(palette).resized, false, "不需要缩小时不解码，也就不报错");
  });
});
