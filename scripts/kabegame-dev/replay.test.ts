import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { DevError } from "./errors.ts";
import {
  checkCornersRequest,
  checkRenderReplay,
  checkReplay,
  checkScripts,
  checkScriptValues,
  checkTrace,
  checkTrackRequest,
  MAX_SCRIPT_CLOCK,
  MAX_SCRIPT_SEED,
  MAX_SCRIPT_TEXT,
  MAX_TRACE_READBACKS,
  MAX_TRACE_VERTICES,
  TEXT_FIELDS,
} from "./replay.ts";

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

  test("audio（P11a）：和 dts 等长，每项 null 或一帧频谱，left / right 必给、32 / 64 段可选，段数与键都查", () => {
    const fill = (n: number, v: number) => Array<number>(n).fill(v);
    const frame = { left: fill(16, 0.5), right: fill(16, 0.25), left64: fill(64, 1.25), right64: fill(64, 0) };
    const full = {
      dts: [0.1, 0.1, 0.1],
      audio: [null, frame, { left: fill(16, 0), right: fill(16, 0), left32: fill(32, 2), right32: fill(32, 0) }],
    };
    assert.deepEqual(checkReplay(full), full);
    rejects400(() => checkReplay({ dts: [0.1, 0.1], audio: [frame] }), "particles.audio", /应和 dts 等长/);
    rejects400(() => checkReplay({ dts: [0.1], audio: frame }), "particles.audio", /要是数组/);
    rejects400(() => checkReplay({ dts: [0.1], audio: [1] }), "particles.audio[0]", /null 或/);
    rejects400(() => checkReplay({ dts: [0.1], audio: [{ right: fill(16, 0) }] }), "particles.audio[0].left", /要给/);
    rejects400(
      () => checkReplay({ dts: [0.1], audio: [{ ...frame, left64: fill(32, 0) }] }),
      "particles.audio[0].left64",
      /64 个有限数，收到 32 项/,
    );
    rejects400(
      () => checkReplay({ dts: [0.1], audio: [{ ...frame, right: [...fill(15, 0), Number.NaN] }] }),
      "particles.audio[0].right[15]",
      /有限数/,
    );
    rejects400(
      () => checkReplay({ dts: [0.1], audio: [{ ...frame, left16: fill(16, 0) }] }),
      "particles.audio[0].left16",
      /不认识/,
    );
    // 轨迹请求体本身也收（探针的 particleTrack 一直有 audio）
    const track = checkTrackRequest({ imageId: "7", dts: [0.1], frames: [1], passes: 1, audio: [frame] });
    assert.deepEqual(track.audio, [frame]);
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

  test("渲染的读回画布（第 5 批）：canvas 是两个正整数、各不超过 16384；和 window 都给时要相同", () => {
    assert.equal(checkRenderReplay({ canvas: [1920, 1080] }), undefined);
    assert.equal(checkRenderReplay({ canvas: [16384, 1] }), undefined);
    assert.deepEqual(checkRenderReplay({ particles: { dts: [0.1] }, canvas: [1080, 1080] }), { dts: [0.1] });
    // 和 window 相同：照收
    assert.equal(checkRenderReplay({ window: [1920, 1080], canvas: [1920, 1080] }), undefined);
    for (const bad of [
      [1920.5, 1080],
      [0, 1080],
      [1920, -720],
      [16385, 1080],
      [1920, 16385],
      [1920],
      "1920x1080",
      [1920, null],
    ]) {
      rejects400(() => checkRenderReplay({ canvas: bad }), "canvas", /两个正整数.*各不超过 16384/);
    }
    rejects400(
      () => checkRenderReplay({ window: [1920, 1080], canvas: [1280, 720] }),
      "canvas",
      /1280×720 和 window 1920×1080 不同/,
    );
    // window 本身不对时先报 window
    rejects400(() => checkRenderReplay({ window: [0, 1080], canvas: [1280, 720] }), "window", /两个正数/);
  });

  test("渲染的 style 与 renderMode（phase-render-size）：形状，以及和 canvas 的关系", () => {
    const canvas = [1920, 800];
    for (const style of ["fill", "fit", "stretch", "center"]) {
      assert.equal(checkRenderReplay({ canvas, style }), undefined, style);
    }
    assert.equal(checkRenderReplay({ canvas, renderMode: "target" }), undefined);
    assert.equal(checkRenderReplay({ canvas, renderMode: "scene" }), undefined);
    assert.equal(checkRenderReplay({ canvas, renderMode: "scene", style: "fill" }), undefined);
    // 不给 canvas 的 renderMode: scene 无害（探针读回场景目标），不拦
    assert.equal(checkRenderReplay({ renderMode: "scene" }), undefined);
    rejects400(() => checkRenderReplay({ canvas, style: "tile" }), "style", /不收 tile/);
    rejects400(() => checkRenderReplay({ canvas, style: "cover" }), "style", /fill \/ fit \/ stretch \/ center 之一/);
    rejects400(() => checkRenderReplay({ canvas, style: 1 }), "style");
    rejects400(() => checkRenderReplay({ style: "fit" }), "style", /要和 canvas 一起给/);
    rejects400(() => checkRenderReplay({ canvas, renderMode: "both" }), "renderMode", /target \/ scene 之一/);
    rejects400(() => checkRenderReplay({ renderMode: "target" }), "renderMode", /要和 canvas 一起给/);
    rejects400(
      () => checkRenderReplay({ canvas, renderMode: "scene", style: "center" }),
      "renderMode",
      /scene 读回固定按 fill 铺放/,
    );
  });

  test("渲染的脚本值（第 6 批）：数组、最多 64 项；object / field / value / optional 的形状，错在哪项报哪项", () => {
    const fr = { object: "FR", field: "color", value: [173 / 255, 3 / 255, 1], optional: true };
    assert.equal(checkRenderReplay({ scriptValues: [fr] }), undefined);
    assert.deepEqual(checkRenderReplay({ particles: { dts: [0.1] }, scriptValues: [fr] }), { dts: [0.1] });
    assert.deepEqual(checkScriptValues([]), []);
    // 下标、布尔、单分量、四分量、不带 optional 都收；不要求有 particles
    const ok = [
      { object: 0, field: "visible", value: false },
      { object: 3, field: "alpha", value: [0.5] },
      { object: "x", field: "parallaxDepth", value: [1, 2, 3, 4], optional: false },
    ];
    assert.deepEqual(checkScriptValues(ok), ok);
    assert.equal(checkScriptValues(Array.from({ length: 64 }, () => fr)).length, 64);

    rejects400(() => checkRenderReplay({ scriptValues: fr }), "scriptValues", /要是 \[\{ object, field, value/);
    rejects400(
      () => checkRenderReplay({ scriptValues: Array.from({ length: 65 }, () => fr) }),
      "scriptValues",
      /65 项，最多 64 项/,
    );
    rejects400(() => checkScriptValues([fr, "FR"]), "scriptValues[1]", /要是 \{ object/);
    rejects400(() => checkScriptValues([{ ...fr, frame: 3 }]), "scriptValues[0].frame", /不认识/);
    for (const object of [-1, 1.5, "", null, undefined]) {
      rejects400(() => checkScriptValues([{ ...fr, object }]), "scriptValues[0].object", /非负整数.*非空字符串/);
    }
    for (const field of ["size", "Color", 3, undefined]) {
      rejects400(() => checkScriptValues([{ ...fr, field }]), "scriptValues[0].field", /只能是 origin \/ scale/);
    }
    for (const value of [[], [1, 2, 3, 4, 5], "0 0 1", null, 1]) {
      rejects400(() => checkScriptValues([{ ...fr, value }]), "scriptValues[0].value", /1–4 个有限数，或布尔/);
    }
    rejects400(() => checkScriptValues([{ ...fr, value: [0.5, Number.NaN] }]), "scriptValues[0].value[1]", /有限数/);
    rejects400(() => checkScriptValues([{ ...fr, value: [0.5, "1"] }]), "scriptValues[0].value[1]");
    rejects400(() => checkScriptValues([{ ...fr, optional: "true" }]), "scriptValues[0].optional", /布尔/);
  });

  test("渲染的脚本值（P11a）：材质常量 constant + 可选 effect，值同图层字段；和 field 同给、effect 不跟 constant、形状不对报 400", () => {
    const ok = [
      { object: "M", constant: "chromaticAberration", value: [0.69] },
      { object: 0, constant: "amount", effect: 4, value: [1, 0], optional: true },
      { object: 0, constant: "on", value: true },
    ];
    assert.deepEqual(checkScriptValues(ok), ok);
    rejects400(
      () => checkScriptValues([{ object: 0, field: "alpha", constant: "amount", value: [1] }]),
      "scriptValues[0].field",
      /和 constant 只能给一个/,
    );
    rejects400(
      () => checkScriptValues([{ object: 0, constant: "", value: [1] }]),
      "scriptValues[0].constant",
      /非空字符串/,
    );
    rejects400(
      () => checkScriptValues([{ object: 0, constant: "amount", effect: 1.5, value: [1] }]),
      "scriptValues[0].effect",
      /effects 下标/,
    );
    rejects400(
      () => checkScriptValues([{ object: 0, field: "alpha", effect: 0, value: [1] }]),
      "scriptValues[0].effect",
      /只和 constant 一起给/,
    );
    rejects400(
      () => checkScriptValues([{ object: 0, constant: "amount", value: "1 0" }]),
      "scriptValues[0].value",
      /材质常量 amount，字符串只给文本字段/,
    );
    rejects400(() => checkScriptValues([{ object: 0, value: [1] }]), "scriptValues[0].field", /只能是/);
  });

  test("渲染的脚本值（P6b 1e-3）：文本字段收字符串（最长 4096）、数与布尔；图层字段给字符串 400，错误指到 value", () => {
    // 12 个运行中字段，同宿主 TEXT_RUNTIME_FIELDS
    assert.deepEqual(TEXT_FIELDS, [
      "text",
      "pointsize",
      "padding",
      "spacing",
      "maxwidth",
      "maxrows",
      "limitwidth",
      "limitrows",
      "limituseellipsis",
      "blockalign",
      "horizontalalign",
      "verticalalign",
    ]);
    assert.equal(MAX_SCRIPT_TEXT, 4096);
    const ok = [
      { object: "S1", field: "text", value: "F183" },
      { object: 0, field: "text", value: "" },
      { object: 0, field: "text", value: "x".repeat(MAX_SCRIPT_TEXT) },
      { object: 0, field: "pointsize", value: [48] },
      { object: 0, field: "padding", value: [4, 8] },
      { object: 0, field: "limitwidth", value: true },
      { object: 0, field: "verticalalign", value: "top", optional: true },
    ];
    assert.deepEqual(checkScriptValues(ok), ok);
    for (const field of TEXT_FIELDS) assert.equal(checkScriptValues([{ object: 0, field, value: "x" }]).length, 1);
    // 和图层字段、FR 一起给，不要求有 particles
    assert.equal(
      checkRenderReplay({ scriptValues: [ok[0], { object: "FR", field: "color", value: [1, 0, 1] }] }),
      undefined,
    );

    rejects400(
      () => checkScriptValues([{ object: 0, field: "color", value: "0 0 1" }]),
      "scriptValues[0].value",
      /要是 1–4 个有限数，或布尔（color 是图层字段，字符串只给文本字段）/,
    );
    rejects400(
      () => checkRenderReplay({ scriptValues: [ok[0], { object: 0, field: "visible", value: "true" }] }),
      "scriptValues[1].value",
      /visible 是图层字段/,
    );
    rejects400(
      () => checkScriptValues([{ object: 0, field: "text", value: "x".repeat(MAX_SCRIPT_TEXT + 1) }]),
      "scriptValues[0].value",
      /长 4097 个 UTF-16 单元，最长 4096/,
    );
    for (const value of [[], [1, 2, 3, 4, 5], null, 1, { text: "x" }]) {
      rejects400(
        () => checkScriptValues([{ object: 0, field: "text", value }]),
        "scriptValues[0].value",
        /要是 字符串（最长 4096 个 UTF-16 单元）、1–4 个有限数，或布尔/,
      );
    }
    rejects400(
      () => checkScriptValues([{ object: 0, field: "maxwidth", value: [1, Number.NaN] }]),
      "scriptValues[0].value[1]",
      /有限数/,
    );
    // 运行中改要重编译（font、opaquebackground）或没有写回目标的文本键、大小写不同的都不收；错误文案列出两组
    for (const field of ["font", "opaquebackground", "backgroundcolor", "Text"]) {
      rejects400(
        () => checkScriptValues([{ object: 0, field, value: "x" }]),
        "scriptValues[0].field",
        /只能是 origin \/ scale .*（图层字段），或 text \/ pointsize .* \/ verticalalign（文本字段）/,
      );
    }
  });

  test("渲染跑场景脚本（第 7 批）：scripts 是 true 或 { clock?, seed? }；不和 scriptValues 同给；错在哪项报哪项", () => {
    assert.equal(checkScripts(true), true);
    assert.deepEqual(checkScripts({}), {});
    const full = { clock: -MAX_SCRIPT_CLOCK, seed: MAX_SCRIPT_SEED };
    assert.deepEqual(checkScripts(full), full);
    // 不要求有 particles；和回放、画布一起给
    assert.equal(checkRenderReplay({ scripts: true }), undefined);
    assert.deepEqual(checkRenderReplay({ particles: { dts: [0.1] }, canvas: [1920, 1080], scripts: { seed: 2 } }), {
      dts: [0.1],
    });
    const fr = { object: "FR", field: "color", value: [1, 0, 1], optional: true };
    for (const scriptValues of [[fr], []]) {
      rejects400(() => checkRenderReplay({ scripts: true, scriptValues }), "scripts", /和 scriptValues 不能同时给/);
    }
    for (const bad of [false, null, 1, "true", [true]]) {
      rejects400(() => checkRenderReplay({ scripts: bad }), "scripts", /要是 true，或 \{ clock\?, seed\? \}/);
    }
    rejects400(() => checkScripts({ seed: 1, time: 2 }), "scripts.time", /不认识（scripts只收 clock \/ seed）/);
    for (const clock of [Number.NaN, Infinity, MAX_SCRIPT_CLOCK * 2, "0"]) {
      rejects400(() => checkScripts({ clock }), "scripts.clock", /毫秒时间戳/);
    }
    for (const seed of [-1, 0.5, MAX_SCRIPT_SEED + 1, "1", null]) {
      rejects400(() => checkScripts({ seed }), "scripts.seed", /0–4294967295 的整数/);
    }
  });

  test("渲染的逐 draw 轨迹：trace 是 true 或 { readback?, maxVertices? }；错在哪项报哪项，不认识的字段 400", () => {
    assert.equal(checkTrace(true), true);
    const full = { readback: [0, 12, "glyphs", "layer 179"], maxVertices: 4096 };
    assert.deepEqual(checkTrace(full), full);
    assert.deepEqual(checkTrace({}), {});
    assert.deepEqual(checkTrace({ maxVertices: 1 }), { maxVertices: 1 });
    const most = checkTrace({ readback: Array.from({ length: MAX_TRACE_READBACKS }, (_, i) => i) });
    assert.equal(most !== true && most.readback?.length, 64);
    assert.equal(MAX_TRACE_VERTICES, 4096);
    // 和回放、画布等一起给；不要求有 particles
    assert.deepEqual(checkRenderReplay({ particles: { dts: [0.1] }, trace: { readback: [3] } }), { dts: [0.1] });
    assert.equal(checkRenderReplay({ canvas: [1920, 1080], trace: true }), undefined);

    for (const bad of [false, 1, "all", null, [0]]) {
      rejects400(() => checkRenderReplay({ trace: bad }), "trace", /要是 true，或 \{ readback\?, maxVertices\? \}/);
    }
    rejects400(
      () => checkTrace({ readback: [0], save: "out" }),
      "trace.save",
      /不认识（trace只收 readback \/ maxVertices）/,
    );
    rejects400(() => checkTrace({ readback: 3 }), "trace.readback", /要是数组/);
    rejects400(
      () => checkTrace({ readback: Array.from({ length: MAX_TRACE_READBACKS + 1 }, () => 0) }),
      "trace.readback",
      /65 项，最多 64 项/,
    );
    for (const item of [-1, 1.5, "", null, true]) {
      rejects400(
        () => checkTrace({ readback: [0, item] }),
        "trace.readback[1]",
        /pass 下标（非负整数）或 pass \/ 目标纹理标签的子串（非空字符串）/,
      );
    }
    for (const maxVertices of [0, 4097, 2.5, "64", null]) {
      rejects400(() => checkTrace({ maxVertices }), "trace.maxVertices", /1–4096 的整数/);
    }
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
