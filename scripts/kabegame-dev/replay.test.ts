import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { DevError } from "./errors.ts";
import { checkCornersRequest, checkRenderReplay, checkReplay, checkTrackRequest } from "./replay.ts";

/** 断言抛 400，`field` 与信息符合预期。 */
function rejects400(fn: () => unknown, field: string, message?: RegExp) {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof DevError, String(error));
    assert.equal(error.status, 400);
    assert.equal(error.layer, "rest");
    assert.equal(error.extra.field, field, error.message);
    if (message) assert.match(error.message, message);
    return true;
  });
}

describe("checkReplay", () => {
  test("合法的回放原样返回（只带给了的字段）", () => {
    assert.deepEqual(checkReplay({ dts: [0.016, 0.017] }), { dts: [0.016, 0.017] });
    const full = { dts: [0.1, 0.2], times: [0.1, 0.3], seed: -3, passes: 2, random: { "4": [0, 0.5, 0.999] } };
    assert.deepEqual(checkReplay(full), full);
  });

  test("dts：非空、都是有限正数，错在哪一项报哪一项", () => {
    rejects400(() => checkReplay({}), "particles.dts", /要是数组/);
    rejects400(() => checkReplay({ dts: [] }), "particles.dts", /不能为空/);
    rejects400(() => checkReplay({ dts: [0.1, 0] }), "particles.dts[1]", /有限正数/);
    rejects400(() => checkReplay({ dts: [0.1, -1] }), "particles.dts[1]");
    rejects400(() => checkReplay({ dts: [0.1, "0.2"] }), "particles.dts[1]");
    rejects400(() => checkReplay({ dts: [Number.POSITIVE_INFINITY] }), "particles.dts[0]");
  });

  test("times 与 dts 等长、都是有限数", () => {
    rejects400(() => checkReplay({ dts: [0.1, 0.1], times: [0.1] }), "particles.times", /应和 dts 等长/);
    rejects400(() => checkReplay({ dts: [0.1], times: [Number.NaN] }), "particles.times[0]");
    assert.deepEqual(checkReplay({ dts: [0.1], times: [-5] }).times, [-5]);
  });

  test("passes 只能 1 / 2；seed 是整数", () => {
    rejects400(() => checkReplay({ dts: [0.1], passes: 3 }), "particles.passes", /1 或 2/);
    rejects400(() => checkReplay({ dts: [0.1], passes: "2" }), "particles.passes");
    rejects400(() => checkReplay({ dts: [0.1], seed: 1.5 }), "particles.seed", /整数/);
  });

  test("random：键是 objects 下标、值是 [0, 1) 内的数", () => {
    rejects400(() => checkReplay({ dts: [0.1], random: [[0.5]] }), "particles.random");
    rejects400(() => checkReplay({ dts: [0.1], random: { a: [0.5] } }), "particles.random.a", /objects 下标/);
    rejects400(() => checkReplay({ dts: [0.1], random: { "3": [0.5, 1] } }), "particles.random.3[1]", /\[0, 1\)/);
    rejects400(() => checkReplay({ dts: [0.1], random: { "3": 0.5 } }), "particles.random.3");
  });

  test("不认识的字段拒绝（例如把逐帧光标放进 particles：逐帧光标是请求体的 pointers）", () => {
    rejects400(() => checkReplay({ dts: [0.1], cursors: [[0.5, 0.5]] }), "particles.cursors", /不认识/);
    rejects400(() => checkReplay([0.1]), "particles");
  });

  test("渲染：给了 particles 就不收 time", () => {
    assert.equal(checkRenderReplay({ time: 1.5 }), undefined);
    assert.deepEqual(checkRenderReplay({ particles: { dts: [0.1] } }), { dts: [0.1] });
    rejects400(() => checkRenderReplay({ particles: { dts: [0.1] }, time: 1 }), "time", /不能同时给/);
  });

  test("渲染的逐帧光标：pointers 要有 particles、和 dts 等长、不和 pointer 同给；pointer、window 的形状", () => {
    const particles = { dts: [0.1, 0.2] };
    const pointers = [
      [0.1, 0.2],
      [1.4, -0.3],
    ];
    assert.deepEqual(checkRenderReplay({ particles, pointers, window: [1920, 800] }), particles);
    assert.equal(checkRenderReplay({ pointer: [0.5, 0.5], window: [1920, 1080] }), undefined);
    rejects400(() => checkRenderReplay({ pointers }), "pointers", /要和 particles 一起给/);
    rejects400(
      () => checkRenderReplay({ particles, pointers: pointers.slice(1) }),
      "pointers",
      /应和 particles\.dts 等长/,
    );
    rejects400(() => checkRenderReplay({ particles, pointers: [[0.1, 0.2], [0.3]] }), "pointers[1]", /两个有限数/);
    rejects400(() => checkRenderReplay({ particles, pointers, pointer: [0.5, 0.5] }), "pointer", /不能同时给/);
    rejects400(() => checkRenderReplay({ pointer: [0.5] }), "pointer", /两个有限数/);
    rejects400(() => checkRenderReplay({ window: [1920, 0] }), "window", /两个正数/);
    rejects400(() => checkRenderReplay({ window: "1920x1080" }), "window");
  });
});

describe("轨迹请求", () => {
  const base = { imageId: "14176", dts: [0.1, 0.1, 0.1], frames: [2, 3], passes: 1 };

  test("合法：imageId 数字转字符串，可选字段原样带上", () => {
    assert.deepEqual(checkTrackRequest(base), base);
    const full = {
      ...base,
      imageId: 7,
      times: [0.1, 0.2, 0.3],
      seed: 2,
      random: { "0": [0.25] },
      cursors: [
        [0.5, 0.5],
        [1.6, -0.2],
        [0, 0],
      ],
      tag: "p4c-cp-fps60",
    };
    assert.deepEqual(checkTrackRequest(full), { ...full, imageId: "7" });
  });

  test("frames：非空、[1, dts.length] 内的整数", () => {
    rejects400(() => checkTrackRequest({ ...base, frames: [] }), "frames", /不能为空/);
    rejects400(() => checkTrackRequest({ ...base, frames: [0] }), "frames[0]", /\[1, 3\]/);
    rejects400(() => checkTrackRequest({ ...base, frames: [2, 4] }), "frames[1]");
    rejects400(() => checkTrackRequest({ ...base, frames: [1.5] }), "frames[0]");
    rejects400(() => checkTrackRequest({ ...base, frames: undefined }), "frames");
  });

  test("passes 必填；cursors 与 dts 等长、每项两个有限数", () => {
    rejects400(() => checkTrackRequest({ ...base, passes: undefined }), "passes", /必填/);
    rejects400(() => checkTrackRequest({ ...base, cursors: [[0.5, 0.5]] }), "cursors", /等长/);
    rejects400(
      () =>
        checkTrackRequest({
          ...base,
          cursors: [
            [0.5, 0.5],
            [0.5, Number.NaN],
            [0, 0],
          ],
        }),
      "cursors[1]",
    );
    rejects400(() => checkTrackRequest({ ...base, cursors: [[0.5], [0, 0], [0, 0]] }), "cursors[0]");
  });

  test("window：和 cursors 一起给，[宽, 高] 两个正数", () => {
    const cursors = [
      [0.5, 0.5],
      [1.6, -0.2],
      [0, 0],
    ];
    assert.deepEqual(checkTrackRequest({ ...base, cursors, window: [1920, 800] }), {
      ...base,
      cursors,
      window: [1920, 800],
    });
    rejects400(() => checkTrackRequest({ ...base, window: [1920, 800] }), "window", /要和 cursors 一起给/);
    rejects400(() => checkTrackRequest({ ...base, cursors, window: [1920, -1] }), "window", /两个正数/);
    rejects400(() => checkTrackRequest({ ...base, cursors, window: [1920] }), "window");
  });

  test("imageId、tag、不认识的字段、dts", () => {
    rejects400(() => checkTrackRequest({ ...base, imageId: "abc" }), "imageId");
    rejects400(() => checkTrackRequest({ ...base, tag: 3 }), "tag");
    rejects400(() => checkTrackRequest({ ...base, frame: 3 }), "frame", /不认识/);
    rejects400(() => checkTrackRequest({ ...base, dts: [0.1, 0] }), "dts[1]");
    rejects400(() => checkTrackRequest(null), "body");
  });
});

describe("四角请求", () => {
  test("合法：只有 imageId；全部字段", () => {
    assert.deepEqual(checkCornersRequest({ imageId: "9" }), { imageId: "9" });
    const full = {
      imageId: "9",
      particles: { dts: [1 / 60], seed: 1, passes: 1 as const },
      layer: "persp",
      limit: 0,
      postprocess: "ultra",
      userProperties: { a: 1 },
      wgsl: true,
    };
    assert.deepEqual(checkCornersRequest(full), full);
    assert.equal(checkCornersRequest({ imageId: "9", layer: 12 }).layer, 12);
  });

  test("各项不合法时报对应的 field", () => {
    rejects400(() => checkCornersRequest({ imageId: "9", layer: -1 }), "layer");
    rejects400(() => checkCornersRequest({ imageId: "9", layer: "" }), "layer");
    rejects400(() => checkCornersRequest({ imageId: "9", limit: 2.5 }), "limit");
    rejects400(() => checkCornersRequest({ imageId: "9", postprocess: "max" }), "postprocess", /disabled/);
    rejects400(() => checkCornersRequest({ imageId: "9", userProperties: [] }), "userProperties");
    rejects400(() => checkCornersRequest({ imageId: "9", wgsl: 1 }), "wgsl");
    rejects400(() => checkCornersRequest({ imageId: "9", particles: { dts: [0.1], passes: 0 } }), "particles.passes");
    rejects400(() => checkCornersRequest({ imageId: "9", pointer: [0.5, 0.5] }), "pointer", /不认识/);
  });

  test("逐帧光标：pointers 要有 particles、和 particles.dts 等长；window 的形状", () => {
    const particles = { dts: [0.1, 0.1] };
    const pointers = [
      [0.5, 0.5],
      [0.25, 0.75],
    ];
    assert.deepEqual(checkCornersRequest({ imageId: "9", particles, pointers, window: [1440, 1080] }), {
      imageId: "9",
      particles,
      pointers,
      window: [1440, 1080],
    });
    assert.deepEqual(checkCornersRequest({ imageId: "9", window: [1440, 1080] }).window, [1440, 1080]);
    rejects400(() => checkCornersRequest({ imageId: "9", pointers }), "pointers", /要和 particles 一起给/);
    rejects400(
      () => checkCornersRequest({ imageId: "9", particles: { dts: [0.1] }, pointers }),
      "pointers",
      /有 2 项，应和 particles\.dts 等长（1 项）/,
    );
    rejects400(
      () =>
        checkCornersRequest({
          imageId: "9",
          particles,
          pointers: [
            [0, 0],
            [0, null],
          ],
        }),
      "pointers[1]",
    );
    rejects400(() => checkCornersRequest({ imageId: "9", window: [0, 1080] }), "window", /两个正数/);
  });
});
