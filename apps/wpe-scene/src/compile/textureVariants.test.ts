/**
 * 纹理变体（P11e，rea-p11e）：条件 JSON、判定与命中表、每级 mip 的贴图计划，`parseTex` 读 TEXB0004 的条件表与每级变体块，编译期把
 * 条件属性登记成就地绑定、记下编译时的值。判定与贴法和 WPE 实测逐像素相同的参考实现在 `ignore/p11/e/ref_variants.py`（P11e 点 0）。
 */
import { describe, expect, it } from "vitest";
import { compileScene } from "./bundle";
import type { SceneFile } from "./fs";
import { parseTex } from "./tex";
import {
  parseVariantCondition,
  sameSelection,
  selectVariants,
  variantHolds,
  variantPlan,
  variantPropertyNames,
  type TexVariantCondition,
  type TexVariantPatch,
} from "./textureVariants";
import type { Wpesl2wgsl } from "../wpesl2wgsl";

const values = (entries: Record<string, unknown>) => new Map(Object.entries(entries));
const cond = (group: number, id: number, flags: number, text: string): TexVariantCondition => ({
  group,
  id,
  flags,
  test: parseVariantCondition(text)!,
});
const leg = (value: string) => `{"condition":{"condition":"${value}","name":"leg"}}`;

describe("条件 JSON 与判定（FUN_140174a60）", () => {
  it("对象形式要 name、condition 都是字符串；字符串形式是 bool 属性名；别的写法不进表", () => {
    expect(parseVariantCondition(leg("1"))).toEqual({ name: "leg", equals: "1" });
    expect(parseVariantCondition('{"condition":"flag"}')).toEqual({ name: "flag", bool: true });
    for (const text of [
      '{"condition":{"condition":1,"name":"leg"}}',
      '{"condition":{"name":"leg"}}',
      '{"condition":7}',
      '{"other":1}',
      "[]",
      "{bad",
    ])
      expect(parseVariantCondition(text)).toBeNull();
  });

  it('对象形式只认字符串值、逐字节相等（数字 2 不等于 "2"，P11e 点 0 实测）；bool 形式只认 true；属性不存在为假', () => {
    const eq = parseVariantCondition('{"condition":{"condition":"2","name":"num"}}')!;
    expect(variantHolds(eq, values({ num: "2" }))).toBe(true);
    expect(variantHolds(eq, values({ num: 2 }))).toBe(false);
    expect(variantHolds(eq, values({ num: "2 " }))).toBe(false);
    expect(variantHolds(eq, values({}))).toBe(false);
    const bool = parseVariantCondition('{"condition":"flag"}')!;
    expect(variantHolds(bool, values({ flag: true }))).toBe(true);
    for (const value of [false, 1, "true", null]) expect(variantHolds(bool, values({ flag: value }))).toBe(false);
  });

  it("命中表：按头里的顺序，同一组只认第一条命中的（P11e 点 0：id 3 和 id 1 同条件，不生效）", () => {
    const conditions = [
      cond(1, 1, 0, leg("1")),
      cond(1, 2, 0, leg("3")),
      cond(1, 3, 0, leg("1")),
      cond(2, 4, 0, '{"condition":"flag"}'),
      cond(5, 7, 2, '{"condition":{"condition":"r","name":"mode"}}'),
    ];
    expect([...selectVariants(conditions, values({ leg: "1", flag: true }))]).toEqual([
      [1, 0],
      [4, 0],
    ]);
    expect([...selectVariants(conditions, values({ leg: "3", mode: "r" }))]).toEqual([
      [2, 0],
      [7, 2],
    ]);
    expect(selectVariants(conditions, values({ leg: "2" })).size).toBe(0);
    expect(variantPropertyNames(conditions)).toEqual(["leg", "flag", "mode"]);
    expect(sameSelection(new Map([[1, 0]]), new Map([[1, 0]]))).toBe(true);
    expect(sameSelection(new Map([[1, 0]]), new Map([[1, 2]]))).toBe(false);
    expect(sameSelection(new Map([[1, 0]]), new Map())).toBe(false);
  });
});

describe("每级 mip 的贴图计划（FUN_14015c8d0 的 mip 循环）", () => {
  const patch = (id: number, x: number, y: number, width: number, height: number): TexVariantPatch => ({
    group: id,
    id,
    x,
    y,
    width,
    height,
    freeImageFormat: 13,
    start: 100 * id,
    end: 100 * id + 10,
  });

  it("文件顺序、只收命中的；最后一条整张替换之前的丢掉，它之后的不贴", () => {
    const patches = [patch(1, 0, 0, 8, 8), patch(4, 4, 4, 8, 8), patch(7, 0, 0, 16, 16), patch(8, 1, 1, 2, 2)];
    const ids = (selected: Map<number, number>) => variantPlan(patches, selected, 16, 16).map((e) => e.patch.id);
    expect(
      ids(
        new Map([
          [4, 0],
          [1, 0],
          [8, 0],
        ]),
      ),
    ).toEqual([1, 4, 8]);
    expect(
      ids(
        new Map([
          [1, 0],
          [7, 2],
          [8, 0],
        ]),
      ),
    ).toEqual([7]);
    expect(variantPlan(patches, new Map([[7, 2]]), 16, 16)[0].flags).toBe(2);
  });

  it("出界与零尺寸跳过（WPE 的检查：x ≤ 宽、w ≤ 宽 − x，y 同理）", () => {
    const patches = [
      patch(1, 8, 0, 8, 4),
      patch(2, 9, 0, 8, 4),
      patch(3, 0, 13, 4, 4),
      patch(4, 0, 0, 0, 4),
      patch(5, 16, 16, 0, 0),
    ];
    const all = new Map(patches.map((p) => [p.id, 0]));
    expect(variantPlan(patches, all, 16, 16).map((e) => e.patch.id)).toEqual([1]);
  });
});

// ———— parseTex：TEXB0004 的条件表与每级变体块 ————

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, true);
  return out;
}
const text = (value: string) => new TextEncoder().encode(value);
function parts(...buffers: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(buffers.reduce((sum, b) => sum + b.length, 0));
  let at = 0;
  for (const b of buffers) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}
const fill = (length: number, seed: number) => Uint8Array.from({ length }, (_, i) => (i * 7 + seed) & 255);

interface VariantSpec {
  conditions: { group: number; id: number; flags: number; json: string }[];
  /** 每级：底图字节与变体条目（按组排）。 */
  mips: {
    width: number;
    height: number;
    base: Uint8Array;
    groups: {
      group: number;
      id: number;
      x: number;
      y: number;
      width: number;
      height: number;
      format?: number;
      data: Uint8Array;
    }[][];
  }[];
  freeImage?: number;
  imageCount?: number;
}

/** 照资源编译器（rea-p11e 4 节）写带条件的 TEXB0004；`ignore/p11/defs/p11e.py` 的 `write_variant_tex` 同一个布局。 */
function variantTex(spec: VariantSpec): Uint8Array {
  const [w, h] = [spec.mips[0].width, spec.mips[0].height];
  const header = parts(
    text("TEXV0005\0TEXI0001\0"),
    ...[0, 2, w, h, w, h, 0xff000000].map(u32),
    text("TEXB0004\0"),
    u32(spec.imageCount ?? 1),
    u32(spec.freeImage ?? 13),
    u32(spec.conditions.length),
    ...spec.conditions.map((c) => parts(u32(c.group), u32(c.id), u32(c.flags), text(c.json + "\0"))),
  );
  const image = parts(
    u32(spec.mips.length),
    ...spec.mips.map((mip) =>
      parts(
        u32(mip.width),
        u32(mip.height),
        u32(0),
        u32(0),
        u32(mip.base.length),
        mip.base,
        ...(spec.conditions.length
          ? [
              u32(mip.groups.length),
              ...mip.groups.map((items) =>
                parts(
                  u32(items.length),
                  ...items.map((e) =>
                    parts(
                      ...[e.group, e.id, e.x, e.y, e.width, e.height, e.format ?? 13, e.data.length].map(u32),
                      e.data,
                    ),
                  ),
                ),
              ),
            ]
          : []),
      ),
    ),
  );
  return parts(header, ...Array.from({ length: spec.imageCount ?? 1 }, () => image));
}

function memoryFile(bytes: Uint8Array, offset = 0): SceneFile {
  return {
    source: "pkg",
    path: "materials/v.tex",
    size: bytes.length,
    location: { path: "P:/p/scene.pkg", offset },
    async readRange(start: number, end: number) {
      return bytes.slice(start, end);
    },
  };
}

const SPEC: VariantSpec = {
  conditions: [
    { group: 1, id: 1, flags: 0, json: leg("1") },
    // 不合规的条件不进表，但每级的变体块照样按条件数读（WPE 的 `local_2d0`）
    { group: 1, id: 2, flags: 0, json: '{"condition":{"name":"leg"}}' },
    { group: 2, id: 3, flags: 0, json: '{"condition":"flag"}' },
  ],
  mips: [
    {
      width: 8,
      height: 4,
      base: fill(37, 1),
      groups: [
        [
          { group: 1, id: 1, x: 1, y: 2, width: 3, height: 2, data: fill(11, 2) },
          { group: 1, id: 2, x: 0, y: 0, width: 8, height: 4, data: fill(5, 3) },
        ],
        [{ group: 2, id: 3, x: 4, y: 0, width: 4, height: 4, data: fill(9, 4) }],
      ],
    },
    {
      width: 4,
      height: 2,
      base: fill(21, 5),
      groups: [[{ group: 1, id: 1, x: 0, y: 1, width: 2, height: 1, data: fill(7, 6) }]],
    },
  ],
};

describe("parseTex：TEXB0004 的条件表与每级变体块（P11e 点 1）", () => {
  it("头里的条件、每级变体条目的矩形与数据区间（绝对位置，加 pkg 条目偏移），整份读完", async () => {
    const bytes = variantTex(SPEC);
    const result = await parseTex(memoryFile(bytes, 5000));
    expect(result.unsupported).toEqual([]);
    expect(result.variants!.conditions).toEqual([
      { group: 1, id: 1, flags: 0, test: { name: "leg", equals: "1" } },
      { group: 2, id: 3, flags: 0, test: { name: "flag", bool: true } },
    ]);
    const levels = result.variants!.mips;
    expect(
      levels.map((level) => level.map((p) => [p.group, p.id, p.x, p.y, p.width, p.height, p.freeImageFormat])),
    ).toEqual([
      [
        [1, 1, 1, 2, 3, 2, 13],
        [1, 2, 0, 0, 8, 4, 13],
        [2, 3, 4, 0, 4, 4, 13],
      ],
      [[1, 1, 0, 1, 2, 1, 13]],
    ]);
    // 每条变体的区间就是它的数据（按字节找回来）
    for (const [level, spec] of SPEC.mips.entries())
      spec.groups.flat().forEach((entry, k) => {
        const p = levels[level][k];
        expect(bytes.slice(p.start - 5000, p.end - 5000)).toEqual(entry.data);
      });
    // 底图的区间不受变体块影响（第 1 级接在第 0 级的变体块之后）
    const encoded = result.encoded!.mips;
    expect(encoded.map((m) => m.end - m.start)).toEqual([37, 21]);
    expect(bytes.slice(encoded[1].start - 5000, encoded[1].end - 5000)).toEqual(SPEC.mips[1].base);
  });

  it("没有条件（语料里 TEXB0004 的绝大多数）：没有 variants，布局同 TEXB0003", async () => {
    const result = await parseTex(memoryFile(variantTex({ ...SPEC, conditions: [] })));
    expect(result.variants).toBeUndefined();
    expect(result.encoded!.mips.map((m) => m.end - m.start)).toEqual([37, 21]);
  });

  it("条件数 1 也按 WPE 的布局读（以前照 LWE 当 isVideoMp4 = 1、每级 mip 前多读一段）", async () => {
    const result = await parseTex(memoryFile(variantTex({ ...SPEC, conditions: [SPEC.conditions[0]] })));
    expect(result.variants!.conditions).toHaveLength(1);
    expect(result.variants!.mips[0]).toHaveLength(3);
  });

  it("照报（2026-11-21 用户定）：原格式底图或变体 → tex:variant:raw；标志位 1 → tex:variant:alphablend；多图像 → tex:variant:multi-image", async () => {
    const raw = await parseTex(memoryFile(variantTex({ ...SPEC, freeImage: -1 })));
    expect(raw.unsupported).toContain("tex:variant:raw");
    const rawPatch = structuredClone(SPEC);
    rawPatch.mips[1].groups[0][0].format = -1;
    expect((await parseTex(memoryFile(variantTex(rawPatch)))).unsupported).toEqual(["tex:variant:raw"]);
    const blend = structuredClone(SPEC);
    blend.conditions[2].flags = 1;
    expect((await parseTex(memoryFile(variantTex(blend)))).unsupported).toEqual(["tex:variant:alphablend"]);
    expect((await parseTex(memoryFile(variantTex({ ...SPEC, imageCount: 2 })))).unsupported).toContain(
      "tex:variant:multi-image",
    );
  });
});

// ———— 编译期：条件属性登记成就地绑定、记下编译时的值 ————

function compileVariantScene(bytes: Uint8Array, properties: Record<string, unknown>, userProperties = {}) {
  const files: Record<string, Uint8Array | string> = {
    "P:/p/project.json": JSON.stringify({ file: "scene.json", general: { properties } }),
    "P:/p/scene.json": JSON.stringify({
      general: { orthogonalprojection: { width: 8, height: 4 } },
      objects: [
        { id: 1, name: "a", image: "models/v.json", origin: "4 2 0" },
        { id: 2, name: "b", image: "models/v.json", origin: "4 2 0" },
      ],
    }),
    "P:/p/models/v.json": JSON.stringify({ material: "materials/v.json" }),
    "P:/p/materials/v.json": JSON.stringify({ passes: [{ shader: "s", textures: ["v"] }] }),
    "P:/p/materials/v.tex": bytes,
    "P:/p/shaders/s.vert": "void main() {}",
    "P:/p/shaders/s.frag": "void main() {}",
  };
  const content = (path: string) => {
    const value = files[path.replace(/\\/g, "/")];
    if (value === undefined) throw new TypeError("Failed to fetch");
    return typeof value === "string" ? new TextEncoder().encode(value) : value;
  };
  return compileScene({
    projectDir: "P:/p",
    sceneAssets: ["A:/assets"],
    reader: {
      readWhole: async (path) => content(path),
      readRange: async (path, start, end) => content(path).slice(start, end),
    },
    translator: {
      translate: async () => ({ ok: true, uniforms: [], textures: [], combos: [] }),
    } as unknown as Wpesl2wgsl,
    postprocess: "disabled",
    exhaustive: true,
    userProperties,
  });
}

describe("编译期：纹理变体进 bundle 与绑定表（P11e 点 3）", () => {
  it("两个图层用同一张 .tex：一个下标；每个条件属性登记一条 texture-variant；values 记编译时的值（用户值优先），属性不存在的不记", async () => {
    const bundle = await compileVariantScene(
      variantTex(SPEC),
      { leg: { type: "combo", value: "2" } },
      { leg: { value: "1" } },
    );
    expect(bundle.unsupported).toEqual([]);
    const textures = bundle.textures.filter((t) => t.variants);
    expect(textures).toHaveLength(1);
    expect(textures[0].variants!.values).toEqual({ leg: "1" });
    expect(textures[0].variants!.mips[0].map((p) => p.mime)).toEqual(["image/png", "image/png", "image/png"]);
    expect(
      bundle.bindings.filter((b) => b.target.kind === "texture-variant").map((b) => [b.property, b.target]),
    ).toEqual([
      ["leg", { kind: "texture-variant", path: textures[0].path, name: "leg" }],
      ["flag", { kind: "texture-variant", path: textures[0].path, name: "flag" }],
    ]);
  });

  it("属性定义里没有 value 键：对象形式的条件照报 tex:variant:no-value（WPE 空指针崩溃），bool 形式不报", async () => {
    const bundle = await compileVariantScene(variantTex(SPEC), { leg: { type: "combo" }, flag: { type: "bool" } });
    expect(bundle.unsupported).toEqual(["tex:variant:no-value"]);
    const onlyBool = await compileVariantScene(variantTex({ ...SPEC, conditions: [SPEC.conditions[2]] }), {
      flag: { type: "bool" },
    });
    expect(onlyBool.unsupported).toEqual([]);
  });
});
