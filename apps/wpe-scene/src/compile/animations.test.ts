/**
 * P10a 步骤 2 的编译侧单测：`collectAnimations`（目标、丢弃、`relative`、联动、事件、`writes`）、常量目标在编译 pass 后补齐、
 * 能力表的去留与 `resolveValue` 对关键帧取 `value`。依据 `.claude/plans/wpe-import/3-scene/phase10/phase-10a-curves.md`「步骤 2」与
 * `rea-p10-keyframes.md` 第 5、7、8、10 节；关键帧的写法照 `ignore/p10/defs/p10.py` 生成的测试工程。
 */
import { describe, expect, it, vi } from "vitest";
import { collectAnimations, eventJson, settleConstantAnimation } from "./animations";
import { compileScene } from "./bundle";
import { checkPassFeatures } from "./features";
import type { SceneReader } from "./fs";
import { materialSlots } from "./materialValues";
import { resolveValue, type JsonObject, type SceneJson, type SceneValue } from "./model";
import type { UniformLayout, Wpesl2wgsl } from "../wpesl2wgsl";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

const f = Math.fround;
const ORTHO = { orthogonalprojection: { width: 1920, height: 1080 } };

/** 两侧切线都关的关键帧（同 `p10.py` 的 `lin`）。 */
const lin = (frame: number, value: number) => ({
  frame,
  value,
  back: { enabled: false, x: -1, y: 0, magic: false },
  front: { enabled: false, x: -1, y: 0, magic: false },
  lockangle: true,
  locklength: true,
});
const CURVE = [lin(0, 0), lin(60, 1)];

/** 一个关键帧值：`channels` 依次是 `c0`、`c1`…，`options` 并进缺省（fps 30、length 60、loop）。 */
function kf(channels: unknown[], options: JsonObject = {}, value: unknown = 0, animation: JsonObject = {}): JsonObject {
  const out: JsonObject = { options: { fps: 30, length: 60, mode: "loop", wraploop: null, ...options }, ...animation };
  channels.forEach((channel, i) => (out[`c${i}`] = channel));
  return { animation: out, value };
}
const kf1 = (options: JsonObject = {}, value: unknown = 0) => kf([CURVE], options, value);
const kf3 = (options: JsonObject = {}, value: unknown = "0 0 0") => kf([CURVE, CURVE, CURVE], options, value);

const image = (extra: JsonObject = {}): JsonObject => ({ id: 1, image: "models/a.json", ...extra });
const collect = (objects: JsonObject[], general: JsonObject = ORTHO) =>
  collectAnimations({ general, objects } as SceneJson);
/** 每条的 `[id, target, valueType, writes]`。 */
const rows = (objects: JsonObject[], general: JsonObject = ORTHO) =>
  collect(objects, general).list.map((item) => [item.id, item.target, item.valueType, item.writes]);

describe("collectAnimations：目标与值类型", () => {
  it("图层字段：float / vec3 / angles / vec2 写，visible（布尔）不写", () => {
    const { list, unsupported } = collect([
      image({
        alpha: kf1(),
        origin: kf3(),
        angles: kf3(),
        color: kf3({}, "1 1 1"),
        visible: kf1({}, true),
        parallaxDepth: kf([CURVE, CURVE], {}, "1 1"),
      }),
    ]);
    expect(unsupported).toEqual([]);
    const layer = (field: string) => ({ kind: "layer", object: 0, field });
    expect(list.map((item) => [item.id, item.target, item.valueType, item.writes])).toEqual([
      ["objects/0/alpha", layer("alpha"), "float", true],
      ["objects/0/origin", layer("origin"), "vec3", true],
      ["objects/0/angles", layer("angles"), "angles", true],
      ["objects/0/color", layer("color"), "vec3", true],
      ["objects/0/visible", layer("visible"), "other", false],
      ["objects/0/parallaxDepth", layer("parallaxDepth"), "vec2", true],
    ]);
  });

  it("文本对象：图层字段照图层；排版字段按字段类型，maxrows（整数）、布尔、字符串不写", () => {
    expect(
      rows([
        {
          id: 1,
          text: "Hi",
          alpha: kf1(),
          origin: kf3(),
          pointsize: kf1({}, 32),
          padding: kf([CURVE, CURVE], {}, "32 32"),
          maxrows: kf1({}, 1),
          limitwidth: kf1({}, true),
          horizontalalign: kf1({}, "left"),
        },
      ]),
    ).toEqual([
      ["objects/0/alpha", { kind: "layer", object: 0, field: "alpha" }, "float", true],
      ["objects/0/origin", { kind: "layer", object: 0, field: "origin" }, "vec3", true],
      ["objects/0/pointsize", { kind: "text", object: 0, field: "pointsize" }, "float", true],
      ["objects/0/padding", { kind: "text", object: 0, field: "padding" }, "vec2", true],
      ["objects/0/maxrows", { kind: "text", object: 0, field: "maxrows" }, "other", false],
      ["objects/0/limitwidth", { kind: "text", object: 0, field: "limitwidth" }, "other", false],
      ["objects/0/horizontalalign", { kind: "text", object: 0, field: "horizontalalign" }, "other", false],
    ]);
    // 文本的 `text` 本身（字符串）：同样收集、不写
    expect(rows([{ id: 1, text: kf1({}, "Hi") }])).toEqual([
      ["objects/0/text", { kind: "text", object: 0, field: "text" }, "other", false],
    ]);
  });

  it("effect 实例常量：常量目标先空着 uniform、不写（编译 pass 后补）；effect 可见性不写", () => {
    expect(
      rows([
        image({
          effects: [
            { file: "effects/a/effect.json" },
            {
              file: "effects/tint/effect.json",
              visible: kf1({}, true),
              passes: [{}, { constantshadervalues: { multiply: kf1({}, 1), point: kf([CURVE, CURVE], {}, "0 0") } }],
            },
          ],
        }),
      ]),
    ).toEqual([
      ["objects/0/effects/1/visible", { kind: "effect", object: 0, effect: 1 }, "other", false],
      [
        "objects/0/effects/1/passes/1/constantshadervalues/multiply",
        { kind: "constant", pass: "objects/0/effects/1/passes/1", material: "multiply", uniforms: [], type: "float" },
        "float",
        false,
      ],
      [
        "objects/0/effects/1/passes/1/constantshadervalues/point",
        { kind: "constant", pass: "objects/0/effects/1/passes/1", material: "point", uniforms: [], type: "vec2" },
        "vec2",
        false,
      ],
    ]);
  });

  it("general：zoom、泛光参数写；bloomtint 是 vec3；bloomhdriterations（整数）、bloom、布尔字段不写", () => {
    expect(
      rows([], {
        ...ORTHO,
        zoom: kf1({}, 1),
        bloomstrength: kf1({}, 2),
        bloomtint: kf3({}, "1 1 1"),
        bloomhdriterations: kf1({}, 8),
        bloom: kf1({}, true),
        clearenabled: kf1({}, true),
        clearcolor: kf3({}, "0 0 0"),
      }),
    ).toEqual([
      ["general/zoom", { kind: "general", key: "zoom" }, "float", true],
      ["general/bloomstrength", { kind: "bloom", field: "strength" }, "float", true],
      ["general/bloomtint", { kind: "bloom", field: "tint" }, "vec3", true],
      ["general/bloomhdriterations", { kind: "bloom", field: "hdrIterations" }, "other", false],
      ["general/bloom", { kind: "bloom-enabled" }, "other", false],
      ["general/clearenabled", { kind: "general", key: "clearenabled" }, "other", false],
      ["general/clearcolor", { kind: "general", key: "clearcolor" }, "vec3", true],
    ]);
  });

  it("粒子对象的 instanceoverride：系数 float、colorn vec3；不在就地目标表里的键（color）报 other", () => {
    const { list, unsupported } = collect([
      image(),
      {
        id: 2,
        particle: "particles/p.json",
        angles: kf3(),
        instanceoverride: { alpha: kf1({}, 1), count: kf1({}, 1), colorn: kf3({}, "1 1 1"), color: kf3({}, "1 1 1") },
      },
    ]);
    expect(list.map((item) => [item.id, item.target, item.valueType, item.writes])).toEqual([
      ["objects/1/angles", { kind: "layer", object: 1, field: "angles" }, "angles", true],
      ["objects/1/instanceoverride/alpha", { kind: "particle-instance", object: 1, field: "alpha" }, "float", true],
      ["objects/1/instanceoverride/count", { kind: "particle-instance", object: 1, field: "count" }, "float", true],
      ["objects/1/instanceoverride/colorn", { kind: "particle-instance", object: 1, field: "colorn" }, "vec3", true],
    ]);
    expect(unsupported).toEqual(["value:animation:other"]);
  });

  it("声音的 volume 写；分组节点的变换照图层", () => {
    expect(
      rows([
        { id: 1, sound: ["sounds/a.mp3"], volume: kf1({}, 1) },
        { id: 2, origin: kf3() },
      ]),
    ).toEqual([
      ["objects/0/volume", { kind: "sound", object: 0, field: "volume" }, "float", true],
      ["objects/1/origin", { kind: "layer", object: 1, field: "origin" }, "vec3", true],
    ]);
  });

  it("灯、相机对象上的不进列表，报 light / camera（语料 3465215190、3554161528）", () => {
    const light = collect([image(), { id: 2, light: "lpoint", origin: kf3(), intensity: kf1({}, 1) }]);
    expect(light).toEqual({ list: [], unsupported: ["value:animation:light"] });
    const camera = collect([{ id: 3, camera: "camera", origin: kf3({ parent: { key: "zoom" } }), zoom: kf1({}, 1) }]);
    expect(camera).toEqual({ list: [], unsupported: ["value:animation:camera"] });
  });

  it("没有就地目标的报 other、不进列表：图层的 size、非粒子对象的 instanceoverride、脚本属性、其余顶层键", () => {
    for (const scene of [
      { general: ORTHO, objects: [image({ size: kf([CURVE, CURVE], {}, "10 10") })] },
      { general: ORTHO, objects: [image({ instanceoverride: { alpha: kf1() } })] },
      { general: { ...ORTHO, hdr: kf1({}, false) }, objects: [] },
      {
        general: ORTHO,
        objects: [
          image({
            origin: {
              script: "export function update(v) { return v; }",
              value: "0 0 0",
              scriptproperties: { s: kf1() },
            },
          }),
        ],
      },
      { general: ORTHO, camera: { eye: kf3() }, objects: [] },
    ] as SceneJson[])
      expect(collectAnimations(scene), JSON.stringify(scene).slice(0, 80)).toEqual({
        list: [],
        unsupported: ["value:animation:other"],
      });
  });
});

describe("collectAnimations：丢弃、通道与时钟参数", () => {
  it("丢弃（读码第 5 节第 1 条）：不进列表、不报键，灯对象上也不报", () => {
    const discarded: JsonObject[] = [
      { animation: { c0: CURVE }, value: 1 },
      { animation: { c0: CURVE, options: [] }, value: 1 },
      { animation: { c0: CURVE, options: null }, value: 1 },
      kf1({ fps: "30" }),
      kf1({ length: true }),
      kf1({ length: null }),
      kf1({ fps: 0 }),
      kf1({ fps: -30 }),
      kf1({ fps: 1e-50 }), // float32 下是 0
      kf1({ length: 0 }),
      kf1({ length: 0.9 }), // 截断成 0
      kf1({ length: -5 }),
    ];
    for (const value of discarded) {
      expect(collect([image({ alpha: value })]), JSON.stringify(value)).toEqual({ list: [], unsupported: [] });
      expect(collect([{ id: 2, light: "lpoint", intensity: value }])).toEqual({ list: [], unsupported: [] });
    }
  });

  it("时钟参数：length 截断、fps 原值；mode 只认 mirror / single；startpaused 只认 true", () => {
    const clock = (options: JsonObject) => collect([image({ alpha: kf1(options) })]).list[0].clock;
    expect(clock({ fps: 14.5, length: 29.9, mode: "single", startpaused: true })).toEqual({
      fps: 14.5,
      length: 29,
      mode: 2,
      startpaused: true,
    });
    expect(clock({ mode: "mirror", startpaused: 1 })).toEqual({ fps: 30, length: 60, mode: 1, startpaused: false });
    expect(clock({ mode: "random" }).mode).toBe(0);
    expect(clock({ mode: null }).mode).toBe(0);
  });

  it("通道：c0… 连续的数组，空数组也算一条，最多 c3；不是数组就停；wraploop 只认 true", () => {
    const channels = (animation: JsonObject) =>
      collect([image({ alpha: { animation: { options: { fps: 30, length: 60 }, ...animation }, value: 0 } })]).list[0];
    expect(channels({ c0: [] })).toMatchObject({ channels: [[]], writes: true });
    expect(channels({ c1: CURVE })).toMatchObject({ channels: [], writes: false });
    expect(channels({ c0: { 0: lin(0, 1) } })).toMatchObject({ channels: [], writes: false });
    expect(channels({ c0: CURVE, c1: CURVE }).writes).toBe(false);
    expect(channels({ c0: CURVE, c1: CURVE, c2: CURVE, c3: CURVE, c4: CURVE }).channels).toHaveLength(4);
    // 只给 c0 的 origin（实测 `onlyc0`）：通道数不等于分量数，不写
    expect(collect([image({ origin: kf([CURVE], {}, "50 0 0") })]).list[0].writes).toBe(false);
    // wraploop：末帧补到 length、值取首帧
    const tail = [lin(0, 100), lin(40, 700)];
    const wrapped = (wraploop: unknown) =>
      collect([image({ alpha: kf([tail], { wraploop }) })]).list[0].channels[0].map((key) => [key.frame, key.value]);
    expect(wrapped(true)).toEqual([
      [0, 100],
      [40, 700],
      [60, 100],
    ]);
    expect(wrapped(1)).toEqual([
      [0, 100],
      [40, 700],
    ]);
  });
});

describe("collectAnimations：relative（读码第 5 节第 3 条）", () => {
  const values = (raw: JsonObject) =>
    collect([image(raw)]).list[0].channels.map((channel) => channel.map((key) => key.value));
  const relative = (channels: unknown[], value: unknown, extra: JsonObject = { relative: true }) =>
    kf(channels, {}, value, extra);

  it("三段字符串：前三段按 float32 加到 c0–c2 每个关键帧", () => {
    expect(values({ origin: relative([CURVE, CURVE, CURVE], "300 10 -5") })).toEqual([
      [300, 301],
      [10, 11],
      [-5, -4],
    ]);
    const fine = [lin(0, 0.1)];
    expect(values({ origin: relative([fine, fine, fine], "0.7 0 0") })[0][0]).toBe(f(f(0.1) + f(0.7)));
  });

  it("标量与两段字符串不加；两段后跟空格时第三段按 0 加；c3 不加；只看键在不在", () => {
    expect(values({ alpha: relative([CURVE], 0.5) })).toEqual([[0, 1]]);
    expect(values({ parallaxDepth: relative([CURVE, CURVE], "10 20") })).toEqual([
      [0, 1],
      [0, 1],
    ]);
    expect(values({ origin: relative([CURVE, CURVE, CURVE], "10 20 ") })).toEqual([
      [10, 11],
      [20, 21],
      [0, 1],
    ]);
    const vec4 = {
      effects: [{ passes: [{ constantshadervalues: { c: relative([CURVE, CURVE, CURVE, CURVE], "1 2 3 4") } }] }],
    };
    expect(values(vec4)).toEqual([
      [1, 2],
      [2, 3],
      [3, 4],
      [0, 1],
    ]);
    // `relative: false` 也换算（汇编只查键在不在；语料都是 true）
    expect(values({ origin: relative([CURVE, CURVE, CURVE], "1 1 1", { relative: false }) })[0]).toEqual([1, 2]);
    expect(values({ origin: relative([CURVE, CURVE, CURVE], "1 1 1", {}) })[0]).toEqual([0, 1]);
  });

  it("先于 wraploop：补的末帧取换算后的首帧值", () => {
    const tail = [lin(0, 0), lin(40, 400)];
    expect(values({ origin: kf([tail, CURVE, CURVE], { wraploop: true }, "300 0 0", { relative: true }) })[0]).toEqual([
      300, 700, 300,
    ]);
  });
});

describe("collectAnimations：联动（读码第 7 节）", () => {
  it("父是同一属主、属性名等于 parent key、自己没有 parent key 的那条（子在父前面也找得到）", () => {
    const { list } = collect([
      image({ alpha: kf1({ parent: { key: "origin" } }), origin: kf3() }),
      // 不同属主：objects/1 没有 origin 动画
      image({ alpha: kf1({ parent: { key: "origin" } }) }),
      // 父自己有 parent key：不算
      image({ alpha: kf1({ parent: { key: "origin" } }), origin: kf3({ parent: { key: "scale" } }), scale: kf3() }),
    ]);
    expect(list.map((item) => [item.id, item.parent])).toEqual([
      ["objects/0/alpha", 1],
      ["objects/0/origin", null],
      ["objects/1/alpha", null],
      ["objects/2/alpha", null],
      ["objects/2/origin", 5],
      ["objects/2/scale", null],
    ]);
  });

  it("effect 常量在同一个 constantshadervalues 里找，实例覆盖在同一个 instanceoverride 里找；空串 key 当没有", () => {
    const { list } = collect([
      image({
        alpha: kf1(),
        effects: [
          {
            passes: [
              {
                constantshadervalues: {
                  Aperture: kf1({ parent: { key: "Opacity" } }),
                  Opacity: kf1(),
                  alpha: kf1({ parent: { key: "alpha" } }),
                },
              },
            ],
          },
        ],
      }),
      {
        id: 2,
        particle: "particles/p.json",
        alpha: kf1(),
        instanceoverride: { alpha: kf1({ parent: { key: "count" } }), count: kf1({ parent: { key: "" } }) },
      },
    ]);
    const parentOf = (id: string) => {
      const item = list.find((entry) => entry.id === id)!;
      return item.parent === null ? null : list[item.parent].id;
    };
    expect(parentOf("objects/0/effects/0/passes/0/constantshadervalues/Aperture")).toBe(
      "objects/0/effects/0/passes/0/constantshadervalues/Opacity",
    );
    // 常量 alpha 的父不会是图层的 alpha（属主不同），自己也不行
    expect(parentOf("objects/0/effects/0/passes/0/constantshadervalues/alpha")).toBeNull();
    expect(parentOf("objects/1/instanceoverride/alpha")).toBe("objects/1/instanceoverride/count");
    expect(parentOf("objects/1/instanceoverride/count")).toBeNull();
  });
});

describe("collectAnimations：事件（读码第 8 节）", () => {
  it("只收 name 是字符串、frame 是数的；time = f(f(frame) × f(1/fps))；json 照 jsoncpp（键排序、8 位有效数字）", () => {
    const events = collect([
      image({
        alpha: kf1({
          fps: 14.5,
          events: [
            { frame: 30, name: "x", extra: 1.23456789012 },
            { frame: 15.5, name: "half", $$hashKey: "object:1", nested: { b: 1, a: [0.123456789, { d: 1, c: 2 }] } },
            { frame: "15", name: "s" },
            { frame: 15, name: 3 },
            { frame: 15 },
            null,
            5,
            [{ frame: 1, name: "a" }],
          ],
        }),
      }),
    ]).list[0].events;
    const spf = f(1 / f(14.5));
    expect(events).toEqual([
      { time: f(f(30) * spf), json: '{"extra":1.2345679,"frame":30,"name":"x"}' },
      {
        time: f(f(15.5) * spf),
        json: '{"$$hashKey":"object:1","frame":15.5,"name":"half","nested":{"a":[0.12345679,{"c":2,"d":1}],"b":1}}',
      },
    ]);
    // 实测（p10-REPORT）：解析出的键序是 extra、frame、name，extra 为 1.2345679
    expect(Object.entries(JSON.parse(events[0].json))).toEqual([
      ["extra", 1.2345679],
      ["frame", 30],
      ["name", "x"],
    ]);
  });

  it("events 写成对象时按键序取；没有 events 时为空", () => {
    const events = (raw: unknown) => collect([image({ alpha: kf1({ events: raw }) })]).list[0].events;
    expect(events({ b: { frame: 2, name: "b" }, a: { frame: 1, name: "a" } }).map((event) => event.json)).toEqual([
      '{"frame":1,"name":"a"}',
      '{"frame":2,"name":"b"}',
    ]);
    expect(events(undefined)).toEqual([]);
    expect(events("x")).toEqual([]);
  });

  it("eventJson：大整数原样，超出 uint64 的按实数；__proto__ 键照常进串", () => {
    expect(eventJson({ name: "n", frame: 1, big: 123456789012, huge: 2 ** 70 })).toBe(
      '{"big":123456789012,"frame":1,"huge":1.1805916e+21,"name":"n"}',
    );
    expect(JSON.parse(eventJson(JSON.parse('{"__proto__":1,"name":"n","frame":0}')))).toEqual(
      JSON.parse('{"__proto__":1,"frame":0,"name":"n"}'),
    );
  });
});

describe("常量目标在编译 pass 后补齐（settleConstantAnimation）", () => {
  const constant = (channels: unknown[]) =>
    collect([image({ effects: [{ passes: [{ constantshadervalues: { m: kf(channels, {}, 1) } }] }] })]).list[0];
  const uniform = (name: string, declared: string, type: string, material: string): UniformLayout => ({
    name,
    type,
    declared,
    offset: 0,
    size: 16,
    meta: { material },
  });

  it("uniform 找到：整组名字与主格类型，通道数相等才写", () => {
    const [slot] = materialSlots([uniform("g_M", "vec2", "vec2<f32>", "m")]);
    const two = constant([CURVE, CURVE]);
    settleConstantAnimation(two, slot);
    expect(two).toMatchObject({
      target: { kind: "constant", uniforms: ["g_M"], type: "vec2" },
      valueType: "vec2",
      writes: true,
    });
    const one = constant([CURVE]);
    settleConstantAnimation(one, slot);
    expect(one).toMatchObject({ valueType: "vec2", writes: false });
  });

  it("uniform 不存在：WPE 没有描述符，不写", () => {
    const item = constant([CURVE]);
    settleConstantAnimation(item, undefined);
    expect(item).toMatchObject({ target: { kind: "constant", uniforms: [], type: "float" }, writes: false });
  });
});

describe("能力表与取值", () => {
  it("checkPassFeatures：材质 JSON 的关键帧照报 value:animation，从 scene.json 并进来的常量跳过", () => {
    const keys = (sceneConstants?: Record<string, unknown>) => {
      const set = new Set<string>();
      checkPassFeatures({ shader: "x", constantshadervalues: { a: kf1() as SceneValue, b: 1 } }, set, {
        sceneConstants,
      });
      return [...set];
    };
    expect(keys()).toEqual(["value:animation"]);
    expect(keys({ b: 1 })).toEqual(["value:animation"]);
    expect(keys({ a: kf1() })).toEqual([]);
  });

  it("resolveValue：关键帧取 value；同时绑了用户属性取属性值；缺 value 为 undefined；整数 animation 不算关键帧", () => {
    expect(resolveValue(kf1({}, 0.5) as SceneValue, {})).toBe(0.5);
    expect(resolveValue(kf3({}, "1 2 3") as SceneValue, {})).toBe("1 2 3");
    expect(resolveValue({ ...kf1({}, 0.5), user: "p" } as SceneValue, { p: 0.25 })).toBe(0.25);
    expect(resolveValue({ ...kf1({}, 0.5), script: "x" } as SceneValue, {})).toBe(0.5);
    expect(resolveValue({ animation: { c0: [] } } as never, {})).toBeUndefined();
    expect(resolveValue({ animation: 3, value: 1 } as never, {})).toBeUndefined();
  });
});

/** 内存文件：字符串原样，其它按 JSON（同 `p4f1.test.ts`）。 */
function memoryReader(files: Record<string, unknown>): SceneReader {
  const reader: SceneReader = {
    async readWhole(path) {
      const value = files[path.replace(/\\/g, "/")];
      if (value === undefined) throw new TypeError("Failed to fetch");
      return new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
    },
    async readRange(path, start, end) {
      return (await reader.readWhole(path)).slice(start, end);
    },
  };
  return reader;
}

describe("compileScene：bundle.animations 与能力键", () => {
  /** 假翻译器：effect 着色器 `fx` 有 float 常量 `multiply` → `g_Multiply`、vec2 常量 `point` → `g_Point`，基础着色器没有常量。 */
  const translator = {
    async translate(input: { fragment: string }) {
      const fx = input.fragment.startsWith("// fx");
      const uniforms: UniformLayout[] = fx
        ? [
            { name: "g_Multiply", type: "f32", declared: "float", offset: 0, size: 4, meta: { material: "multiply" } },
            { name: "g_Point", type: "vec2<f32>", declared: "vec2", offset: 8, size: 8, meta: { material: "point" } },
          ]
        : [];
      return { ok: true, uniforms, textures: [], combos: [] };
    },
  } as unknown as Wpesl2wgsl;

  const compile = (object: JsonObject, material: JsonObject = { passes: [{ shader: "fx" }] }) =>
    compileScene({
      projectDir: "P:/p",
      sceneAssets: ["A:/assets"],
      reader: memoryReader({
        "P:/p/project.json": { file: "scene.json" },
        "P:/p/scene.json": { general: ORTHO, objects: [{ id: 1, image: "models/a.json", ...object }] },
        "P:/p/models/a.json": { material: "materials/a.json", width: 4, height: 4 },
        "P:/p/materials/a.json": { passes: [{ shader: "base" }] },
        "P:/p/effects/x/effect.json": { passes: [{ material: "materials/fx.json" }] },
        "P:/p/materials/fx.json": material,
        "P:/p/shaders/base.vert": "// base",
        "P:/p/shaders/base.frag": "// base",
        "P:/p/shaders/fx.vert": "// fx",
        "P:/p/shaders/fx.frag": "// fx",
      }),
      translator,
      postprocess: "disabled",
      exhaustive: true,
    });
  const effect = (constants: JsonObject) => ({
    effects: [{ file: "effects/x/effect.json", passes: [{ constantshadervalues: constants }] }],
  });

  it("会写的常量动画：补上 uniform，不报能力键（过渡键 value:animation:pending 已在 P10a 步骤 3 删掉）；实例常量上的关键帧不再报 value:animation", async () => {
    const bundle = await compile(effect({ multiply: kf1({}, 1) }));
    expect(bundle.animations).toHaveLength(1);
    expect(bundle.animations![0]).toMatchObject({
      target: { kind: "constant", pass: "objects/0/effects/0/passes/0", uniforms: ["g_Multiply"], type: "float" },
      valueType: "float",
      writes: true,
    });
    expect(bundle.unsupported).toEqual([]);
  });

  it("常量动画都不写（通道数不对、uniform 不存在）：同样不报能力键", async () => {
    const bundle = await compile(effect({ point: kf1({}, "0 0"), missing: kf1({}, 1) }));
    expect(bundle.animations!.map((item) => [item.id.split("/").at(-1), item.writes, item.target])).toEqual([
      ["point", false, expect.objectContaining({ uniforms: ["g_Point"], type: "vec2" })],
      ["missing", false, expect.objectContaining({ uniforms: [] })],
    ]);
    expect(bundle.unsupported).toEqual([]);
  });

  it("图层字段的动画不报能力键、进 bundle 且会写；布尔的不写；材质 JSON 的关键帧照报 value:animation", async () => {
    const alpha = await compile({ alpha: kf1({}, 1) });
    expect(alpha.unsupported).toEqual([]);
    expect(alpha.animations!.map((item) => item.writes)).toEqual([true]);
    const visible = await compile({ visible: kf1({}, true) });
    expect(visible.unsupported).toEqual([]);
    expect(visible.animations!.map((item) => item.writes)).toEqual([false]);
    const material = await compile(effect({}), {
      passes: [{ shader: "fx", constantshadervalues: { multiply: kf1({}, 1) } }],
    });
    expect(material.unsupported).toEqual(["value:animation"]);
    expect(material.animations).toEqual([]);
  });

  it("灯对象上的动画：报 value:animation:light，不进 bundle", async () => {
    const bundle = await compileScene({
      projectDir: "P:/p",
      sceneAssets: ["A:/assets"],
      reader: memoryReader({
        "P:/p/project.json": { file: "scene.json" },
        "P:/p/scene.json": { general: ORTHO, objects: [{ id: 1, light: "lpoint", intensity: kf1({}, 1) }] },
      }),
      translator,
      postprocess: "disabled",
      exhaustive: true,
    });
    expect(bundle.animations).toEqual([]);
    expect(bundle.unsupported).toEqual(["value:animation:light"]);
  });
});
