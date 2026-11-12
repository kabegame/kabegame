/**
 * P5c 步骤 1 的 mdl 解析单测（`.claude/plans/wpe-import/3-scene/phase5/phase-5c-mesh.md`「步骤 1」点 2、点 5）：
 * - `parseMdl`：各版本的门槛（v4 / v14 / v16 / v17 / v21 / v23）、u32 索引、标志 bit1、尾部段（不认识的跳过）、截断、木偶数据、
 *   包围盒并集；本机有 WPE 时读 retro 的 `bgfade.mdl` 与默认工程的全部 mdl。字节由下面的小编码器造（照 `ignore/p5/c0/mdl_enc.py`，
 *   它对语料 46 个静态 mdl 往返逐字节一致）；
 * - 属性表：`p5c-layout` 两种格式的偏移与 stride（p5-REPORT「P5c 语义的实测核对」第一行）；
 * - `meshDrawOrder`：`p5c-order` 的 5 个网格与 40 个网格逐个等于 WPE 的实测，不超过 32 个时等于稳定排序；
 * - `meshSkin`：`p5c-skin` 的 8 种写法。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { attributeSemantic, MDL_ATTRIBUTES, mdlStride, meshAttributes, meshDrawOrder, meshSkin, parseMdl } from "./mdl";

// ———— 编码器（照 mdl_enc.py：可选块、记录表按参数写；尾部段按给定的标签与数据写，最后补空标签） ————

class Writer {
  private readonly chunks: Uint8Array[] = [];
  length = 0;
  bytes(chunk: Uint8Array): this {
    this.chunks.push(chunk);
    this.length += chunk.length;
    return this;
  }
  u8(value: number): this {
    return this.bytes(new Uint8Array([value]));
  }
  u32(value: number): this {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, value >>> 0, true);
    return this.bytes(out);
  }
  f32(value: number): this {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setFloat32(0, value, true);
    return this.bytes(out);
  }
  cstr(text: string): this {
    return this.bytes(new TextEncoder().encode(text)).u8(0);
  }
  block(chunk: Uint8Array): this {
    return this.u32(chunk.length).bytes(chunk);
  }
  done(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  }
}

interface MeshSpec {
  materials: string[];
  format: number;
  /** 顶点块（原样写）。 */
  vertices: Uint8Array;
  indices: number[];
  flags?: number;
  bounds?: number[];
  /** v ≥ 21 的两个可选块写不写（木偶数据）。 */
  optional?: [boolean, boolean];
  /** v ≥ 23 的记录表项数。 */
  records?: number;
}

/** float 递增序列的字节：值是 start、start + 1……，用来核对视图取到的就是原字节。 */
function floats(count: number, start = 0): Uint8Array {
  return new Uint8Array(Float32Array.from({ length: count }, (_, i) => start + i).buffer);
}

/** 格式 0x9（位置 + uv，stride 20）的四边形：4 个顶点、6 个索引。 */
function quad(materials = ["materials/a.json"], extra: Partial<MeshSpec> = {}): MeshSpec {
  return { materials, format: 0x9, vertices: floats(20), indices: [0, 1, 2, 0, 2, 3], ...extra };
}

function encodeMdl(
  version: number,
  meshes: MeshSpec[],
  options: { headerFormat?: number; sections?: [string, Uint8Array][]; prefix?: string; final?: boolean } = {},
): Uint8Array {
  const out = new Writer();
  out.cstr(`${options.prefix ?? "MDLV"}${String(version).padStart(4, "0")}`);
  out
    .u32(options.headerFormat ?? meshes[0].format)
    .u32(meshes[0].materials.length)
    .u32(meshes.length);
  for (const mesh of meshes) {
    for (const path of mesh.materials) out.cstr(path);
    const flags = mesh.flags ?? 0;
    if (version >= 4) {
      out.u32(flags);
      if (flags & 2) out.u32(0x12345678);
    }
    if (version >= 17) for (const value of mesh.bounds ?? [-1, -1, 0, 1, 1, 0]) out.f32(value);
    if (version >= 15) out.u32(mesh.format);
    out.block(mesh.vertices);
    const indices = new Uint8Array(mesh.indices.length * (flags & 1 ? 4 : 2));
    const view = new DataView(indices.buffer);
    mesh.indices.forEach((value, i) =>
      flags & 1 ? view.setUint32(i * 4, value, true) : view.setUint16(i * 2, value, true),
    );
    out.block(indices);
    if (version >= 21) {
      const [one, two] = mesh.optional ?? [false, false];
      out.u8(one ? 1 : 0);
      if (one) out.u32(7).block(new Uint8Array(12));
      out.u8(two ? 1 : 0);
      if (two) out.block(new Uint8Array(32));
    }
    if (version >= 23) {
      out.u32(mesh.records ?? 0);
      for (let r = 0; r < (mesh.records ?? 0); r++)
        out.bytes(new Uint8Array(8)).cstr(`masks/clipping_mask_${r}`).u32(0).u32(2).u32(0).u32(1).u32(1).u32(0);
    }
  }
  if (version > 12) {
    for (const [tag, data] of options.sections ?? []) {
      const end = out.length + tag.length + 1 + 4 + data.length;
      out.cstr(tag).u32(end).bytes(data);
    }
    if (options.final !== false) out.u8(0);
  }
  return out.done();
}

// ———— parseMdl ————

describe("parseMdl：版本门槛（rea-p5-mesh 1.2、1.3，p5c-ver）", () => {
  it.each([4, 14, 16, 17, 21, 23])("v%i 的四边形：4 顶点、6 个 u16 索引，读到文件末尾", (version) => {
    const bytes = encodeMdl(version, [quad()]);
    const file = parseMdl(bytes);
    expect(file).toMatchObject({ version, skins: 1, sections: [], truncated: false });
    expect(file.meshes).toHaveLength(1);
    const [mesh] = file.meshes;
    expect(mesh).toMatchObject({
      materials: ["materials/a.json"],
      flags: 0,
      format: 0x9,
      stride: 20,
      vertexCount: 4,
      indexFormat: "uint16",
      indexCount: 6,
      puppet: false,
    });
    // 包围盒只在 v ≥ 17；没有时并集是 ±131072
    expect(mesh.bounds).toEqual(version >= 17 ? [-1, -1, 0, 1, 1, 0] : null);
    expect(file.bounds).toEqual(
      version >= 17 ? [-1, -1, 0, 1, 1, 0] : [-131072, -131072, -131072, 131072, 131072, 131072],
    );
    // 顶点 / 索引是原文件缓冲的视图，不拷贝
    expect(mesh.vertices.buffer).toBe(bytes.buffer);
    expect(Array.from(new Float32Array(mesh.vertices.slice().buffer))).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(Array.from(new Uint16Array(mesh.indices.slice().buffer))).toEqual([0, 1, 2, 0, 2, 3]);
  });

  it("v < 15 的网格格式取文件头的，v ≥ 15 取网格自己的（文件头的读了不用）", () => {
    const old = parseMdl(encodeMdl(14, [{ ...quad(), format: 0xb, vertices: floats(32) }], { headerFormat: 0xb }));
    expect(old.meshes[0]).toMatchObject({ format: 0xb, stride: 32, vertexCount: 4 });
    const fresh = parseMdl(encodeMdl(23, [quad()], { headerFormat: 0xf }));
    expect(fresh.meshes[0]).toMatchObject({ format: 0x9, stride: 20 });
  });

  it("版本 = atoi(魔数 + 4)：不比较前 4 个字符", () => {
    expect(parseMdl(encodeMdl(16, [quad()], { prefix: "XXXX" })).version).toBe(16);
  });

  it("多个皮肤：每个网格按皮肤数读材质路径", () => {
    const file = parseMdl(encodeMdl(4, [quad(["materials/red.json", "materials/blue.json"])]));
    expect(file.skins).toBe(2);
    expect(file.meshes[0].materials).toEqual(["materials/red.json", "materials/blue.json"]);
  });

  it("标志 bit0：u32 索引（p5c-ver 的 U32）；bit1：多读一个 u32（B1）", () => {
    const u32 = parseMdl(encodeMdl(23, [quad(undefined, { flags: 1, indices: [0, 1, 2, 0, 2, 70000] })]));
    expect(u32.meshes[0]).toMatchObject({ indexFormat: "uint32", indexCount: 6 });
    expect(new Uint32Array(u32.meshes[0].indices.slice().buffer)[5]).toBe(70000);
    const extra = parseMdl(encodeMdl(23, [quad(undefined, { flags: 2 })]));
    expect(extra.truncated).toBe(false);
    expect(extra.meshes[0]).toMatchObject({ flags: 2, format: 0x9, vertexCount: 4, indexCount: 6 });
  });

  it("多个网格：包围盒取并集", () => {
    const file = parseMdl(
      encodeMdl(23, [
        quad(undefined, { bounds: [-1, 0, -2, 1, 3, 0] }),
        quad(undefined, { bounds: [0, -5, 0, 4, 1, 6] }),
      ]),
    );
    expect(file.meshes).toHaveLength(2);
    expect(file.bounds).toEqual([-1, -5, -2, 4, 3, 6]);
  });

  it("并集不满足 max.x > min.x（全 0 的包围盒）时 ±131072（rea 1.6）", () => {
    const file = parseMdl(encodeMdl(23, [quad(undefined, { bounds: [0, 0, 0, 0, 0, 0] })]));
    expect(file.bounds).toEqual([-131072, -131072, -131072, 131072, 131072, 131072]);
  });
});

describe("parseMdl：尾部段（rea 1.7）", () => {
  it("不认识的段整段跳过（p5c-ver 的 S14、S23），标签按出现顺序留下", () => {
    const file = parseMdl(
      encodeMdl(23, [quad()], {
        sections: [
          ["MDLX0001", new Uint8Array(8)],
          ["ZZZZ0002", new TextEncoder().encode("abc")],
        ],
      }),
    );
    expect(file).toMatchObject({ truncated: false, sections: ["MDLX0001", "ZZZZ0002"] });
    expect(parseMdl(encodeMdl(14, [quad()], { sections: [["ZZZZ0001", floats(4)]] })).sections).toEqual(["ZZZZ0001"]);
  });

  it("骨骼、动画、变形段同样只记标签（能力表报，W6）", () => {
    const file = parseMdl(
      encodeMdl(23, [quad()], {
        sections: [
          ["MDLS0004", new Uint8Array(40)],
          ["MDLA0006", new Uint8Array(3)],
          ["MDMP0001", new Uint8Array(0)],
        ],
      }),
    );
    expect(file).toMatchObject({ truncated: false, sections: ["MDLS0004", "MDLA0006", "MDMP0001"] });
  });

  it("v ≤ 12 没有段区：网格读完就停，后面的字节不读", () => {
    const bytes = encodeMdl(4, [quad()]);
    const tail = new Uint8Array(bytes.length + 3);
    tail.set(bytes);
    tail.set([0x5a, 0x5a, 0x5a], bytes.length);
    expect(parseMdl(bytes)).toMatchObject({ truncated: false, sections: [] });
    expect(parseMdl(tail)).toMatchObject({ truncated: false, sections: [] });
  });
});

describe("parseMdl：截断（读越界，WPE 的原语返回 0，不猜）", () => {
  it("v ≥ 13 缺结尾的空标签", () => {
    const file = parseMdl(encodeMdl(23, [quad()], { final: false }));
    expect(file.truncated).toBe(true);
    // 已读出的网格照留
    expect(file.meshes).toHaveLength(1);
  });

  it("顶点块、索引块、文件头被截断", () => {
    const bytes = encodeMdl(14, [quad()]);
    for (const cut of [4, 12, 40, 60, bytes.length - 8]) expect(parseMdl(bytes.subarray(0, cut)).truncated).toBe(true);
    expect(parseMdl(bytes).truncated).toBe(false);
  });

  it("段末超出文件或倒退", () => {
    const valid = encodeMdl(23, [quad()], { sections: [["ZZZZ0001", new Uint8Array(4)]] });
    const at = valid.length - 1 - 4 - 4; // 段末偏移所在处
    const beyond = valid.slice();
    new DataView(beyond.buffer).setUint32(at, valid.length + 10, true);
    expect(parseMdl(beyond).truncated).toBe(true);
    const backwards = valid.slice();
    new DataView(backwards.buffer).setUint32(at, 3, true);
    expect(parseMdl(backwards).truncated).toBe(true);
  });
});

describe("parseMdl：木偶数据（v ≥ 21 的可选块、v ≥ 23 的记录表）", () => {
  it.each<[string, number, Partial<MeshSpec>]>([
    ["可选块 1", 21, { optional: [true, false] }],
    ["可选块 2", 21, { optional: [false, true] }],
    ["记录表", 23, { records: 2 }],
  ])("%s → puppet", (_name, version, extra) => {
    const file = parseMdl(encodeMdl(version, [quad(undefined, extra)]));
    expect(file.truncated).toBe(false);
    expect(file.meshes[0]).toMatchObject({ puppet: true, vertexCount: 4, indexCount: 6 });
  });

  it("两个可选块为空、记录表为空：不是木偶数据", () => {
    expect(parseMdl(encodeMdl(23, [quad()])).meshes[0].puppet).toBe(false);
  });
});

const root = process.env.KABEGAME_WPE_ROOT;
const defaults = root ? join(root, "projects", "defaultprojects") : "";
const bgfade = join(defaults, "retro", "models", "bgfade", "bgfade.mdl");

describe.skipIf(!root || !existsSync(bgfade))("本机语料", () => {
  it("retro 的 bgfade.mdl：155 字节、v14、格式 9、4 顶点 6 索引、没有段（rea 1.8）", () => {
    const bytes = new Uint8Array(readFileSync(bgfade));
    expect(bytes.length).toBe(155);
    const file = parseMdl(bytes);
    expect(file).toMatchObject({ version: 14, skins: 1, sections: [], truncated: false });
    expect(file.meshes).toHaveLength(1);
    expect(file.meshes[0]).toMatchObject({
      materials: ["materials/bgfade/bgfade.json"],
      flags: 0,
      format: 0x9,
      stride: 20,
      vertexCount: 4,
      indexFormat: "uint16",
      indexCount: 6,
      bounds: null,
      puppet: false,
    });
    expect(Array.from(new Uint16Array(file.meshes[0].indices.slice().buffer))).toEqual([0, 1, 2, 0, 2, 3]);
    expect(file.bounds).toEqual([-131072, -131072, -131072, 131072, 131072, 131072]);
  });

  it("默认工程的 mdl 全部恰好读到末尾，顶点 / 索引块按 stride、索引宽度整除", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (name.endsWith(".mdl")) files.push(path);
      }
    };
    walk(defaults);
    expect(files.length).toBeGreaterThan(0);
    for (const path of files) {
      const file = parseMdl(new Uint8Array(readFileSync(path)));
      expect(file.truncated, path).toBe(false);
      expect(file.sections, path).toEqual([]);
      for (const mesh of file.meshes) {
        expect(mesh.vertexCount * mesh.stride, path).toBe(mesh.vertices.length);
        expect(mesh.indexCount * (mesh.indexFormat === "uint32" ? 4 : 2), path).toBe(mesh.indices.length);
        expect(mesh.indexCount % 3, path).toBe(0);
      }
    }
  });
});

// ———— 属性表 ————

describe("属性表（rea 1.4，p5c-layout 实测）", () => {
  const layout = (format: number) => meshAttributes(format).map((item) => [item.name, item.offset, item.bytes]);

  it("格式 0x344988f：stride 156，偏移按表序", () => {
    expect(mdlStride(0x344988f)).toBe(156);
    expect(layout(0x344988f)).toEqual([
      ["a_Position", 0, 12],
      ["a_PositionC1", 12, 12],
      ["a_Normal", 24, 12],
      ["a_Tangent4", 36, 16],
      ["a_BlendWeights", 52, 16],
      ["a_TexCoord", 68, 8],
      ["a_TexCoordVec3C1", 76, 12],
      ["a_TexCoordVec4C2", 88, 16],
      ["a_TexCoordC3", 104, 8],
      ["a_TexCoordVec3C4", 112, 12],
      ["a_TexCoordVec4C5", 124, 16],
      ["a_Color", 140, 16],
    ]);
  });

  it("格式 0xa34460：stride 104，BlendIndices 是 uint", () => {
    expect(mdlStride(0xa34460)).toBe(104);
    expect(layout(0xa34460)).toEqual([
      ["a_PositionVec4", 0, 16],
      ["a_BlendIndices", 16, 16],
      ["a_TexCoordVec4", 32, 16],
      ["a_TexCoordC1", 48, 8],
      ["a_TexCoordVec3C2", 56, 12],
      ["a_TexCoordVec4C3", 68, 16],
      ["a_TexCoordC4", 84, 8],
      ["a_TexCoordVec3C5", 92, 12],
    ]);
    expect(meshAttributes(0xa34460).map((item) => item.type)).toEqual([
      "float",
      "uint",
      "float",
      "float",
      "float",
      "float",
      "float",
      "float",
    ]);
  });

  it("格式 0x8009（C 三角形）：位置 0、uv 12、颜色 20，stride 36；语料的 0x9 / 0xb / 0xf / 0x27", () => {
    expect(layout(0x8009)).toEqual([
      ["a_Position", 0, 12],
      ["a_TexCoord", 12, 8],
      ["a_Color", 20, 16],
    ]);
    expect([0x9, 0xb, 0xf, 0x27].map(mdlStride)).toEqual([20, 32, 48, 56]);
  });

  it("26 位各不相同；同语义不同宽度共用语义键", () => {
    expect(MDL_ATTRIBUTES).toHaveLength(26);
    expect(new Set(MDL_ATTRIBUTES.map((item) => item.mask)).size).toBe(26);
    expect(attributeSemantic("a_TexCoord")).toBe("TEXCOORD0");
    expect(attributeSemantic("a_TexCoordVec4")).toBe("TEXCOORD0");
    expect(attributeSemantic("a_TexCoordVec3C5")).toBe("TEXCOORD5");
    expect(attributeSemantic("a_PositionVec4")).toBe("POSITION0");
    expect(attributeSemantic("a_PositionC1")).toBe("POSITION1");
    expect(attributeSemantic("a_Custom")).toBeUndefined();
  });
});

// ———— 绘制顺序 ————

/** `ignore/p5/c0/sim_sort.py` 的 `WPE_MANY`：`p5c-order` 的 40 个网格（偶数 translucent、奇数 normal）在 WPE 里的绘制顺序。 */
const WPE_MANY = [
  39, 1, 11, 3, 19, 5, 13, 7, 17, 9, 15, 21, 23, 25, 27, 29, 31, 33, 35, 37, 0, 2, 22, 4, 24, 6, 26, 8, 28, 10, 30, 12,
  32, 14, 34, 16, 36, 18, 38, 20,
];

describe("meshDrawOrder：MSVC std::sort（p5c-order）", () => {
  it("5 个网格（translucent、normal、additive、normal、alphatocoverage）→ 1、3、4、0、2", () => {
    expect(meshDrawOrder([false, true, false, true, true])).toEqual([1, 3, 4, 0, 2]);
  });

  it("40 个网格交替：逐个等于 WPE 的实测（同类内部不是原顺序）", () => {
    expect(meshDrawOrder(Array.from({ length: 40 }, (_, i) => i % 2 === 1))).toEqual(WPE_MANY);
  });

  it("不超过 32 个时等于稳定排序", () => {
    let seed = 12345;
    const random = () => ((seed = (seed * 1103515245 + 12345) >>> 0) & 0x10000) !== 0;
    for (let n = 0; n <= 32; n++)
      for (let trial = 0; trial < 8; trial++) {
        const opaque = Array.from({ length: n }, random);
        const stable = opaque.map((_, i) => i).sort((a, b) => Number(opaque[b]) - Number(opaque[a]));
        expect(meshDrawOrder(opaque), JSON.stringify(opaque)).toEqual(stable);
      }
  });

  it("多于 32 个时也是不透明在前；全是同一类时顺序不变", () => {
    for (const n of [33, 41, 100, 257]) {
      const opaque = Array.from({ length: n }, (_, i) => (i * 7) % 3 === 0);
      const order = meshDrawOrder(opaque);
      expect([...order].sort((a, b) => a - b)).toEqual(opaque.map((_, i) => i));
      const firstTranslucent = order.findIndex((i) => !opaque[i]);
      expect(order.slice(firstTranslucent).every((i) => !opaque[i])).toBe(true);
      expect(meshDrawOrder(Array(n).fill(true))).toEqual(opaque.map((_, i) => i));
      expect(meshDrawOrder(Array(n).fill(false))).toEqual(opaque.map((_, i) => i));
    }
  });
});

// ———— 皮肤 ————

describe("meshSkin：非负整数取 min(skin, N − 1)，其余 0（p5c-skin）", () => {
  it.each<[string, unknown, number]>([
    ["缺省", undefined, 0],
    ["0", 0, 0],
    ["1", 1, 1],
    ["5", 5, 1],
    ["−1（推翻读码：不是最后一项）", -1, 0],
    ['"1"', "1", 0],
    ["1.0", 1.0, 1],
    ["true", true, 0],
    ["1.5", 1.5, 0],
    ["绑属性", { user: "s", value: 1 }, 0],
  ])("%s", (_name, skin, expected) => {
    expect(meshSkin(skin, 2)).toBe(expected);
  });
});
