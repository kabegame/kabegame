/**
 * P5c 步骤 1 的 mdl 解析单测（`.claude/plans/wpe-import/3-scene/phase5/phase-5c-mesh.md`「步骤 1」点 2、点 5）。
 * P12a 步骤 1 点 3（`phase12/phase-12a-mesh-animation.md`）另加：`MDLS` v1–v4、`MDLA` v1 / v3 / v5 / v6、绘制组、v23 记录表、标志 bit1
 * 的 u32，逐字段核对；段没读到段末、段内截断、骨骼数 > 128 各一例；本机有 WPE 与 `ignore/p12/rea/mdl/corpus/` 时，语料 137 个 mdl 的统计
 * 和 `ignore/p12/rea/mdl/stats.txt`（`mdl12.py`）一致。段的编码器照 `ignore/p12/defs/puppet.py` 的 `encode`。
 * P5c 的部分：
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
import {
  attributeSemantic,
  MDL_ATTRIBUTES,
  mdlStride,
  meshAttributes,
  meshDrawOrder,
  meshSkin,
  parseMdl,
  type MdlFile,
} from "./mdl";

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
  u16(value: number): this {
    const out = new Uint8Array(2);
    new DataView(out.buffer).setUint16(0, value, true);
    return this.bytes(out);
  }
  u32(value: number): this {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, value >>> 0, true);
    return this.bytes(out);
  }
  i32(value: number): this {
    return this.u32(value | 0);
  }
  u64(value: number): this {
    return this.u32(value % 2 ** 32).u32(Math.floor(value / 2 ** 32));
  }
  floats(values: readonly number[]): this {
    return this.bytes(new Uint8Array(Float32Array.from(values).buffer));
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
  /** 可选块 2 的绘制组（给了就写可选块 2）：每项 [骨骼, 顺序偏移, 索引起点, 索引数]。 */
  groups?: [number, number, number, number][];
  /** v ≥ 23 的记录表（给了就代替 `records`）。 */
  recordList?: { id: number; name: string; flags: number; list1: number[]; list2: number[] }[];
  /** 标志 bit1 时多写的 u32（缺省 0x12345678）。 */
  blendRowCount?: number;
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
      if (flags & 2) out.u32(mesh.blendRowCount ?? 0x12345678);
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
      const [one, two] = mesh.optional ?? [false, !!mesh.groups];
      out.u8(one ? 1 : 0);
      if (one) out.u32(7).block(new Uint8Array(12));
      out.u8(two ? 1 : 0);
      if (two) {
        const groups = new Writer();
        for (const [bone, order, start, count] of mesh.groups ?? [
          [0, 0, 0, 0],
          [0, 0, 0, 0],
        ])
          groups.u32(bone).i32(order).u32(start).u32(count);
        out.block(groups.done());
      }
    }
    if (version >= 23) {
      if (mesh.recordList) {
        out.u32(mesh.recordList.length);
        for (const record of mesh.recordList) {
          out.u64(record.id).cstr(record.name).u32(record.flags);
          for (const list of [record.list1, record.list2]) {
            out.u32(list.length);
            for (const item of list) out.u32(item);
          }
        }
      } else {
        out.u32(mesh.records ?? 0);
        for (let r = 0; r < (mesh.records ?? 0); r++)
          out.bytes(new Uint8Array(8)).cstr(`masks/clipping_mask_${r}`).u32(0).u32(2).u32(0).u32(1).u32(1).u32(0);
      }
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

  it("骨骼、动画、变形段的标签照记（能力表报，W6）；内容不合格式只记进 sectionIssues，不算截断（P12a）", () => {
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
    // 40 个 0：骨骼数 0，v4 的附加数据只占 18 字节，没读到段末；3 个字节的 MDLA 读进了下一段、读出文件末尾
    expect(file.sectionIssues).toEqual(["MDLS0004", "MDLA0006"]);
    expect(file.skeleton).toMatchObject({ version: 4, count: 0, bones: [] });
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

// ———— P12a：MDLS / MDLA 的编码器（照 `ignore/p12/defs/puppet.py` 的 `_mdls` / `_mdla`） ————

const IDENTITY16 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

interface BoneSpec {
  name: string;
  flags?: number;
  /** 缺省 0xFFFFFFFF（根）。 */
  parent?: number;
  local?: number[];
  /** 局部矩阵的长度前缀（缺省 64，只写 min(它, 64) 个字节）。 */
  length?: number;
  json?: string;
}

interface SkeletonSpec {
  bones: BoneSpec[];
  /** 写进段里的骨骼数（缺省 `bones.length`）。 */
  count?: number;
  /** v ≥ 2：记录数（每项名字、id、类型、单位阵）。 */
  records?: number;
  /** v ≥ 2：可选骨骼矩阵（给了就写开关 1，记录的照写单位阵）。 */
  restMatrices?: number[][];
  /** v ≥ 2：每个约束的 flags（v ≥ 4 才写；bit1 再写两个 f32）。 */
  constraints?: number[];
  /** v ≥ 2：每张键表的项数。 */
  keyMaps?: number[];
  /** v ≥ 2：链数（每条 1 个记录下标、1 个子项、1 个孙项、1 个骨骼下标）。 */
  chains?: number;
  hitBoxes?: boolean;
  hitOrder?: boolean;
  /** v ≥ 3：每骨骼绘制顺序。 */
  drawOrder?: number[];
}

function encodeSkeleton(version: number, spec: SkeletonSpec): Uint8Array {
  const out = new Writer();
  const count = spec.count ?? spec.bones.length;
  out.u32(count);
  for (const bone of spec.bones) {
    const length = bone.length ?? 64;
    out
      .cstr(bone.name)
      .u32(bone.flags ?? 1)
      .u32(bone.parent ?? 0xffffffff)
      .u32(length);
    out.bytes(new Uint8Array(Float32Array.from(bone.local ?? IDENTITY16).buffer).subarray(0, Math.min(length, 64)));
    out.cstr(bone.json ?? "");
  }
  if (version >= 2) {
    const records = spec.records ?? 0;
    out.u16(records);
    for (let r = 0; r < records; r++)
      out
        .cstr(`rec${r}`)
        .u32(r)
        .u32(r % 2)
        .floats(IDENTITY16);
    out.u8(spec.restMatrices ? 1 : 0);
    if (spec.restMatrices) {
      for (const matrix of spec.restMatrices) out.floats(matrix);
      for (let r = 0; r < records; r++) out.floats(IDENTITY16);
    }
    const constraints = spec.constraints ?? [];
    out.u32(constraints.length);
    for (const flags of constraints) {
      out.u32(0).u32(1).u32(2);
      if (version >= 4) {
        out.u32(flags);
        if (flags & 2) out.floats([0.5, 0]);
      }
    }
    const keyMaps = spec.keyMaps ?? [];
    out.u16(keyMaps.length);
    keyMaps.forEach((_, k) => out.u32(100 + k));
    for (const n of keyMaps) {
      out.u16(n);
      for (let i = 0; i < n; i++) out.u32(i).floats([1, 2, 3]);
    }
    const chains = spec.chains ?? 0;
    out.u16(chains);
    for (let j = 0; j < chains; j++)
      out.u32(0).u32(1).u32(0).u16(1).u32(0).u16(1).u32(0).u32(4).floats([1, 2]).u16(1).u32(0);
    out.u8(spec.hitBoxes ? 1 : 0);
    if (spec.hitBoxes) for (let b = 0; b < count; b++) out.floats([1, 2, 3]).floats(IDENTITY16);
    out.u8(spec.hitOrder ? 1 : 0);
    if (spec.hitOrder) for (let b = 0; b < count; b++) out.u32(b);
  }
  if (version >= 3) {
    out.u8(spec.drawOrder ? 1 : 0);
    for (const value of spec.drawOrder ?? []) out.i32(value);
  }
  return out.done();
}

interface AnimSpec {
  id: number;
  name?: string;
  mode?: string;
  fps?: number;
  length: number;
  flags?: number;
  /** 每条 9 × (length + 1) 个数。 */
  tracks: { flags?: number; frames: number[] }[];
  /** v ≥ 3：纹理通道轨道数。 */
  channels?: number;
  /** v ≥ 3：骨骼透明度轨道。 */
  boneAlpha?: boolean;
  /** v ≥ 4：每网格一条变形权重（flags 1、一个目标）。 */
  morph?: boolean;
  /** v ≥ 5：六个 f32。 */
  bounds?: number[];
  /** v ≥ 6：绘制顺序轨道。 */
  drawOrder?: boolean;
  events?: [number, string][];
  /** 改写第一条轨道的字节数（造长度检查不过的例子）。 */
  badTrack?: boolean;
}

function encodeAnimations(
  version: number,
  anims: AnimSpec[],
  context: { records?: number; constraints?: number; meshes?: number } = {},
): Uint8Array {
  const out = new Writer().u32(anims.length);
  for (const anim of anims) {
    const frames = anim.length + 1;
    const scalar = () => out.u32(0).block(new Uint8Array(Float32Array.from({ length: frames }, (_, i) => i).buffer));
    out
      .u64(anim.id)
      .cstr(anim.name ?? `anim${anim.id}`)
      .cstr(anim.mode ?? "loop")
      .f32(anim.fps ?? 30)
      .u32(anim.length)
      .u32(anim.flags ?? 0)
      .u32(anim.tracks.length);
    anim.tracks.forEach((track, t) => {
      const values = anim.badTrack && t === 0 ? track.frames.slice(1) : track.frames;
      out.u32(track.flags ?? 0).block(new Uint8Array(Float32Array.from(values).buffer));
    });
    if (version >= 2) {
      for (let r = 0; r < (context.records ?? 0); r++) out.u32(0).block(new Uint8Array(36 * frames));
      for (let c = 0; c < (context.constraints ?? 0); c++) scalar();
    }
    if (version >= 3) {
      out.u32(anim.channels ?? 0);
      for (let c = 0; c < (anim.channels ?? 0); c++) scalar();
      out.u8(anim.boneAlpha ? 1 : 0);
      if (anim.boneAlpha) anim.tracks.forEach(scalar);
    }
    if (version >= 4) {
      out.u8(anim.morph ? 1 : 0);
      if (anim.morph)
        for (let m = 0; m < (context.meshes ?? 1); m++)
          out
            .u32(1)
            .f32(5.5)
            .u16(1)
            .u16(0)
            .block(new Uint8Array(4 * frames));
    }
    if (version >= 5) out.floats(anim.bounds ?? [0, 0, 0, 0, 0, 0]);
    if (version >= 6) {
      out.u8(anim.drawOrder ? 1 : 0);
      if (anim.drawOrder) anim.tracks.forEach(scalar);
    }
    if ((anim.flags ?? 0) & 1) out.u16(0).u32(0).u32(0).u32(0).u32(0);
    const events = anim.events ?? [];
    out.u32(events.length);
    for (const [time, json] of events) out.f32(time).cstr(json);
  }
  return out.done();
}

/** 一条轨道：第 k 帧 = [k, 2k, 0, 0, 0, 0.1k, 1, 1, 1]（加 `offset`）。 */
function track(length: number, offset = 0, flags = 0): { flags: number; frames: number[] } {
  const frames: number[] = [];
  for (let k = 0; k <= length; k++) frames.push(k + offset, 2 * k, 0, 0, 0, 0.1 * k, 1, 1, 1);
  return { flags, frames };
}

const f32s = (values: readonly number[]) => Array.from(Float32Array.from(values));

const ROT = f32s([0.8, 0.6, 0, 0, -0.6, 0.8, 0, 0, 0, 0, 1, 0, 24.92, -41.71, 0, 1]);

/** 一个 skinned 网格（格式 0x180000f）配给定的段。 */
function withSections(sections: [string, Uint8Array][], meshes = 1): MdlFile {
  const mesh = { ...quad(), format: 0x180000f, vertices: new Uint8Array(4 * mdlStride(0x180000f)) };
  return parseMdl(
    encodeMdl(
      23,
      Array.from({ length: meshes }, () => mesh),
      { sections },
    ),
  );
}

describe("parseMdl：MDLS（rea-p12-mdl 1.1–1.3，P12a）", () => {
  const bones: BoneSpec[] = [
    { name: "root", flags: 1, local: ROT, json: "" },
    { name: "arm", flags: 0, parent: 0, local: IDENTITY16, json: '{"a":"","r":true}' },
  ];
  const fields = (file: MdlFile) =>
    file.skeleton!.bones.map((bone) => [bone.name, bone.flags, bone.parent, Array.from(bone.local), bone.json]);
  const expectedBones = [
    ["root", 1, -1, ROT, ""],
    ["arm", 0, 0, IDENTITY16, '{"a":"","r":true}'],
  ];

  it("v1：骨骼的名字、文件 flags、父（0xFFFFFFFF → −1）、局部矩阵、JSON；没有附加数据", () => {
    const file = withSections([["MDLS0001", encodeSkeleton(1, { bones })]]);
    expect(file.sectionIssues).toEqual([]);
    expect(file.skeleton).toMatchObject({
      version: 1,
      count: 2,
      restMatrices: null,
      drawOrder: null,
      extras: { records: 0, constraints: 0, keyMaps: 0, chains: 0 },
    });
    expect(fields(file)).toEqual(expectedBones);
  });

  it("v2：记录、可选骨骼矩阵（静止姿势来源）、约束（没有 flags）、键表、链表、命中盒、命中顺序，读到段末", () => {
    const rest = [f32s([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 5, 6, 7, 1]), IDENTITY16];
    const file = withSections([
      [
        "MDLS0002",
        encodeSkeleton(2, {
          bones,
          records: 2,
          restMatrices: rest,
          constraints: [0],
          keyMaps: [1, 2],
          chains: 1,
          hitBoxes: true,
          hitOrder: true,
        }),
      ],
    ]);
    expect(file.sectionIssues).toEqual([]);
    expect(file.skeleton!.extras).toEqual({ records: 2, constraints: 1, keyMaps: 2, chains: 1 });
    expect(file.skeleton!.restMatrices!.map((matrix) => Array.from(matrix))).toEqual(rest);
    expect(file.skeleton!.drawOrder).toBeNull();
    expect(fields(file)).toEqual(expectedBones);
  });

  it("v3：每骨骼绘制顺序（按 i32，语料有 −900）", () => {
    const file = withSections([["MDLS0003", encodeSkeleton(3, { bones, drawOrder: [0, -900] })]]);
    expect(file.sectionIssues).toEqual([]);
    expect(file.skeleton!.drawOrder).toEqual([0, -900]);
  });

  it("v4：约束多一个 flags，flags bit1 再多两个 f32", () => {
    const file = withSections([
      ["MDLS0004", encodeSkeleton(4, { bones, constraints: [2, 0, 3], hitBoxes: true, drawOrder: [100, 200] })],
    ]);
    expect(file.sectionIssues).toEqual([]);
    expect(file.skeleton).toMatchObject({ version: 4, drawOrder: [100, 200] });
    expect(file.skeleton!.extras.constraints).toBe(3);
  });

  it("局部矩阵的长度前缀 < 64：只覆盖前 L 字节，其余保持单位阵（读之前要求文件还剩 64 + 4 字节，后面垫一段）", () => {
    const file = withSections([
      ["MDLS0004", encodeSkeleton(4, { bones: [{ name: "half", local: ROT.map((v) => v + 10), length: 32 }] })],
      ["ZZZZ0001", new Uint8Array(64)],
    ]);
    expect(file.sectionIssues).toEqual([]);
    expect(Array.from(file.skeleton!.bones[0].local)).toEqual([
      ...f32s(ROT.slice(0, 8).map((v) => v + 10)),
      ...IDENTITY16.slice(8),
    ]);
  });

  it("骨骼数 > 128：停在骨骼数之后、不读骨骼、不报段（WPE 直接终止进程，由 puppet 报 mdl:skeleton:bones）", () => {
    const file = withSections([["MDLS0004", encodeSkeleton(4, { bones: [], count: 129 })]]);
    expect(file.skeleton).toMatchObject({ count: 129, bones: [] });
    expect(file.sectionIssues).toEqual([]);
    expect(file.truncated).toBe(false);
  });

  it("段没读到段末（多出来的字节）→ sectionIssues；段内读出文件末尾 → sectionIssues，不算截断，后面的空标签照读", () => {
    const longer = new Uint8Array([...encodeSkeleton(4, { bones }), 0, 0, 0, 0]);
    const extra = withSections([["MDLS0004", longer]]);
    expect(extra.sectionIssues).toEqual(["MDLS0004"]);
    expect(extra.skeleton!.bones).toHaveLength(2);
    // 写 3 根、只给 2 根：第三根的名字读到结尾的空标签，之后的 u32 读出文件末尾
    const short = withSections([["MDLS0004", encodeSkeleton(4, { bones, count: 3 })]]);
    expect(short).toMatchObject({ truncated: false, sectionIssues: ["MDLS0004"], skeleton: null });
  });
});

describe("parseMdl：MDLA（rea-p12-mdl 4.2，P12a）", () => {
  const skeleton2 = (records = 0): [string, Uint8Array] => [
    records ? "MDLS0002" : "MDLS0004",
    encodeSkeleton(records ? 2 : 4, { bones: [{ name: "a" }, { name: "b", parent: 0 }], records }),
  ];

  it("v1：id、名字、模式、fps、长度、flags、轨道（flags + 9 × (length + 1) 个 f32）、事件（f32 秒 + JSON）", () => {
    const anim: AnimSpec = {
      id: 213,
      name: "动画 1",
      mode: "single",
      fps: 27.27,
      length: 3,
      tracks: [track(3), track(3, 100, 1)],
      events: [[1, '{"frame":30,"name":"事件1"}']],
    };
    const file = withSections([skeleton2(), ["MDLA0001", encodeAnimations(1, [anim])]]);
    expect(file.sectionIssues).toEqual([]);
    expect(file.animations).toHaveLength(1);
    const [parsed] = file.animations;
    expect(parsed).toMatchObject({
      id: 213,
      name: "动画 1",
      mode: "single",
      fps: Math.fround(27.27),
      length: 3,
      flags: 0,
      boneAlpha: false,
      drawOrderTrack: false,
      unsupported: false,
      events: [{ time: 1, json: '{"frame":30,"name":"事件1"}' }],
    });
    expect(parsed.tracks.map((item) => [item.flags, Array.from(item.frames)])).toEqual([
      [0, f32s(track(3).frames)],
      [1, f32s(track(3, 100).frames)],
    ]);
  });

  it("模式串：mirror / single，其它（含大小写不同）都是循环", () => {
    const modes = ["mirror", "single", "loop", "Mirror", ""].map((mode, i) => ({ id: i, mode, length: 1, tracks: [] }));
    const file = withSections([["MDLA0006", encodeAnimations(6, modes)]]);
    expect(file.animations.map((item) => item.mode)).toEqual(["mirror", "single", "loop", "loop", "loop"]);
  });

  it("v3 纹理通道与骨骼透明度、v4 变形权重、v5 包围盒、v6 绘制顺序：照读到段末，只记有没有", () => {
    const anims: AnimSpec[] = [
      { id: 1, length: 2, tracks: [track(2), track(2)], channels: 2, boneAlpha: true, morph: true, drawOrder: true },
      { id: 2, length: 4, tracks: [track(4), track(4)], bounds: [-1, -2, -3, 1, 2, 3] },
    ];
    for (const version of [3, 4, 5, 6]) {
      const file = withSections(
        [skeleton2(), [`MDLA000${version}`, encodeAnimations(version, anims, { meshes: 2 })]],
        2,
      );
      expect(file.sectionIssues, `v${version}`).toEqual([]);
      expect(file.animations.map((item) => [item.id, item.boneAlpha, item.drawOrderTrack])).toEqual([
        [1, true, version >= 6],
        [2, false, false],
      ]);
    }
  });

  it("flags bit0 的引用块、v2 的记录轨道 → unsupported", () => {
    const ref = withSections([
      skeleton2(),
      ["MDLA0006", encodeAnimations(6, [{ id: 1, flags: 1, length: 1, tracks: [track(1), track(1)] }])],
    ]);
    expect(ref.sectionIssues).toEqual([]);
    expect(ref.animations[0].unsupported).toBe(true);
    const records = withSections([
      skeleton2(1),
      ["MDLA0002", encodeAnimations(2, [{ id: 1, length: 1, tracks: [track(1), track(1)] }], { records: 1 })],
    ]);
    expect(records.sectionIssues).toEqual([]);
    expect(records.animations[0].unsupported).toBe(true);
  });

  it("id 是 u64：高 32 位照算进 number", () => {
    const file = withSections([["MDLA0006", encodeAnimations(6, [{ id: 2 ** 32 + 5, length: 1, tracks: [] }])]]);
    expect(file.animations[0].id).toBe(2 ** 32 + 5);
  });

  it("轨道字节数不等于 36 × (length + 1)（WPE int 0x29）→ sectionIssues，动画不留", () => {
    const file = withSections([
      skeleton2(),
      ["MDLA0006", encodeAnimations(6, [{ id: 1, length: 2, tracks: [track(2), track(2)], badTrack: true }])],
    ]);
    expect(file.sectionIssues).toEqual(["MDLA0006"]);
    expect(file.animations).toEqual([]);
    expect(file.truncated).toBe(false);
  });

  it("帧数据：4 字节对齐时是原文件缓冲上的视图，不对齐时拷一份（值相同）", () => {
    const shared: boolean[] = [];
    for (const name of ["a", "ab", "abc", "abcd"]) {
      const file = withSections([["MDLA0006", encodeAnimations(6, [{ id: 1, name, length: 2, tracks: [track(2)] }])]]);
      const frames = file.animations[0].tracks[0].frames;
      expect(Array.from(frames)).toEqual(f32s(track(2).frames));
      shared.push(frames.byteOffset % 4 === 0 && frames.buffer === file.meshes[0].vertices.buffer);
    }
    expect(shared.filter(Boolean)).toHaveLength(1);
  });
});

describe("parseMdl：网格的 puppet 数据（rea-p12-mdl 7.2、7.3、8，P12a）", () => {
  it("标志 bit1 多读的 u32 → blendRowCount；没有 bit1 时为 0", () => {
    expect(parseMdl(encodeMdl(23, [quad(undefined, { flags: 2, blendRowCount: 4 })])).meshes[0].blendRowCount).toBe(4);
    expect(parseMdl(encodeMdl(23, [quad()])).meshes[0].blendRowCount).toBe(0);
  });

  it("可选块 2 → 绘制组 {骨骼, 顺序偏移（i32）, 索引起点, 索引数}", () => {
    const file = parseMdl(
      encodeMdl(21, [
        quad(undefined, {
          groups: [
            [1, -50, 0, 3],
            [0, 100, 3, 3],
          ],
        }),
      ]),
    );
    expect(file.meshes[0]).toMatchObject({ puppet: true });
    expect(file.meshes[0].drawGroups).toEqual([
      { bone: 1, order: -50, start: 0, count: 3 },
      { bone: 0, order: 100, start: 3, count: 3 },
    ]);
  });

  it("v23 记录表 → {id, name, flags, list1, list2}", () => {
    const record = { id: 0x131, name: "masks/clipping_mask_ab", flags: 8, list1: [0], list2: [1, 2] };
    const file = parseMdl(encodeMdl(23, [quad(undefined, { recordList: [record] })]));
    expect(file.meshes[0]).toMatchObject({ puppet: true, records: [record] });
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

/** P12 步骤 0 读码代理缓存的语料 mdl（`ignore/p12/rea/mdl/collect.py`，只在本机有）。 */
const corpusDir = join(__dirname, "..", "..", "..", "..", "ignore", "p12", "rea", "mdl");
const corpusIndex = join(corpusDir, "corpus_index.json");

/** 同 `stats.py` 的 `bucket`，长度另分 129–512 与 > 512。 */
function bucket(n: number): string {
  for (const [lo, hi] of [
    [0, 0],
    [1, 8],
    [9, 16],
    [17, 32],
    [33, 64],
    [65, 128],
  ])
    if (n >= lo && n <= hi) return `${lo}-${hi}`;
  return n <= 512 ? "129-512" : ">512";
}

describe.skipIf(!root || !existsSync(corpusIndex))("本机语料：ignore/p12/rea/mdl/corpus 的 137 个 mdl（P12a）", () => {
  it("段全部读到段末、没有截断；统计和 stats.txt（mdl12.py）一致；buildPuppet 不报文件级的键", async () => {
    const { buildPuppet } = await import("./puppet");
    const index = JSON.parse(readFileSync(corpusIndex, "utf8")) as { file: string; kind: string }[];
    expect(index).toHaveLength(137);
    const count = (table: Record<string, number>, key: string | number) => {
      table[String(key)] = (table[String(key)] ?? 0) + 1;
    };
    const stats = {
      version: {} as Record<string, number>,
      meshFlags: {} as Record<string, number>,
      sections: {} as Record<string, number>,
      bones: {} as Record<string, number>,
      animations: {} as Record<string, number>,
      mode: {} as Record<string, number>,
      fps: {} as Record<string, number>,
      length: {} as Record<string, number>,
      blendRowCount: {} as Record<string, number>,
    };
    const totals: Record<string, number> = {};
    const add = (key: string, value: number) => (totals[key] = (totals[key] ?? 0) + value);
    const fileIssues = new Set<string>();
    for (const entry of index) {
      const file = parseMdl(new Uint8Array(readFileSync(join(corpusDir, "corpus", entry.file))));
      expect(file.truncated, entry.file).toBe(false);
      expect(file.sectionIssues, entry.file).toEqual([]);
      count(stats.version, file.version);
      for (const mesh of file.meshes) {
        count(stats.meshFlags, mesh.flags);
        if (mesh.drawGroups.length) {
          add("groupMeshes", 1);
          add("groups", mesh.drawGroups.length);
        }
        if (mesh.records.length) {
          add("recordMeshes", 1);
          add("records", mesh.records.length);
        }
        if (mesh.flags & 2) count(stats.blendRowCount, mesh.blendRowCount);
      }
      for (const tag of file.sections) count(stats.sections, tag);
      const skeleton = file.skeleton;
      if (skeleton) {
        count(stats.bones, bucket(skeleton.count));
        totals.maxBones = Math.max(totals.maxBones ?? 0, skeleton.count);
        add("bones", skeleton.count);
        add("json", skeleton.bones.filter((bone) => bone.json).length);
        add("boneFlags1", skeleton.bones.filter((bone) => bone.flags === 1).length);
        add("drawOrder", skeleton.drawOrder ? 1 : 0);
        const { records, constraints, keyMaps, chains } = skeleton.extras;
        add("extras", records + constraints + keyMaps + chains);
        add("restMatrices", skeleton.restMatrices ? 1 : 0);
      }
      if (file.sections.some((tag) => tag.startsWith("MDLA"))) count(stats.animations, file.animations.length);
      for (const animation of file.animations) {
        add("anims", 1);
        count(stats.mode, animation.mode);
        count(stats.fps, animation.fps);
        count(stats.length, bucket(animation.length));
        add("frames", animation.length + 1);
        add("tracks", animation.tracks.length);
        add("tracksMasked", animation.tracks.filter((item) => item.flags & 1).length);
        add("tracksNeBones", animation.tracks.length !== skeleton?.count ? 1 : 0);
        add("boneAlpha", animation.boneAlpha ? 1 : 0);
        add("drawOrderTrack", animation.drawOrderTrack ? 1 : 0);
        add("events", animation.events.length);
        add("unsupported", animation.unsupported ? 1 : 0);
        add("idHi", animation.id >= 2 ** 32 ? 1 : 0);
        for (const item of animation.tracks) expect(item.frames.length).toBe(9 * (animation.length + 1));
      }
      if (entry.kind === "puppets")
        for (const issue of buildPuppet(file, [], entry.file).issues)
          if (issue.startsWith("mdl:")) fileIssues.add(`${entry.file} ${issue}`);
    }
    expect(stats).toEqual({
      version: { 13: 1, 16: 10, 19: 26, 21: 9, 23: 91 },
      meshFlags: { 0: 168, 1: 2, 1024: 4, 2: 1, 4: 7, 4096: 5, 4108: 1 },
      sections: {
        MDAT0001: 22,
        MDLA0001: 1,
        MDLA0003: 10,
        MDLA0005: 26,
        MDLA0006: 87,
        MDLE0002: 35,
        MDLS0001: 1,
        MDLS0002: 36,
        MDLS0003: 8,
        MDLS0004: 87,
        MDMP0001: 7,
      },
      bones: { "1-8": 96, "9-16": 17, "17-32": 10, "33-64": 5, "65-128": 4 },
      animations: { 1: 81, 2: 24, 3: 10, 4: 6, 5: 1, 9: 1, 120: 1 },
      mode: { loop: 292, mirror: 3, single: 22 },
      fps: {
        "10": 1,
        "12": 1,
        "15": 2,
        "19.799999237060547": 1,
        "19.899999618530273": 1,
        "20": 1,
        "240": 5,
        "25": 120,
        "27.27272605895996": 1,
        "30": 158,
        "50": 2,
        "60": 20,
        "7.5": 1,
        "75": 3,
      },
      length: { "1-8": 41, "9-16": 21, "17-32": 27, "33-64": 74, "65-128": 42, "129-512": 97, ">512": 15 },
      blendRowCount: { 1: 1 },
    });
    expect(totals).toEqual({
      maxBones: 86,
      bones: 1245,
      json: 795,
      boneFlags1: 1168,
      drawOrder: 92,
      extras: 0,
      restMatrices: 0,
      anims: 317,
      frames: 58650,
      tracks: 12187,
      tracksMasked: 479,
      tracksNeBones: 0,
      boneAlpha: 15,
      drawOrderTrack: 2,
      events: 1,
      unsupported: 0,
      idHi: 0,
      groupMeshes: 92,
      groups: 926,
      recordMeshes: 5,
      records: 7,
    });
    expect([...fileIssues]).toEqual([]);
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
