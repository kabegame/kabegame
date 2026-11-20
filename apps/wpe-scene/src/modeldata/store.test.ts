// P14 步骤 1 点 1：数据仓。规则来源 rea-p14-exe 3.1 / 4.3 与缺陷表 D3–D9；错误文字逐字照 rea-p14-script 9.1。
import { describe, expect, it } from "vitest";
import { ModelDataError, ModelDataStore } from "./store";
import type { MaterialCheck, ModelDataShapeInput, ModelDataUpdate } from "./types";

const POSITION = 0x1;
const NORMAL = 0x2;
const UV = 0x8;
const COLOR = 0x8000;
const PUV = POSITION | UV | COLOR; // stride 36
const PUN = POSITION | NORMAL | UV | COLOR; // stride 48

const pass: MaterialCheck = () => 0;

const floats = (...values: number[]) => new Uint8Array(new Float32Array(values).buffer);
const u16 = (...values: number[]) => ({
  format: "uint16" as const,
  bytes: new Uint8Array(new Uint16Array(values).buffer),
});
const u32 = (...values: number[]) => ({
  format: "uint32" as const,
  bytes: new Uint8Array(new Uint32Array(values).buffer),
});
const zeros = (count: number) => floats(...new Array(count).fill(0));

function shape(overrides: Partial<ModelDataShapeInput> = {}): ModelDataShapeInput {
  return {
    vertices: zeros(9 * 3), // 3 个顶点，格式 PUV
    index: u16(0, 1, 2),
    format: PUV,
    material: "materials/a.json",
    dynamicVertex: true,
    dynamicIndex: true,
    ...overrides,
  };
}

function made(overrides: Partial<ModelDataShapeInput> = {}) {
  const store = new ModelDataStore();
  const token = store.create({ shapes: [shape(overrides)], bounds: null }, pass);
  return { store, token };
}

function failure(run: () => void): { code: number; message: string } {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ModelDataError);
    const { code, message } = error as ModelDataError;
    return { code, message };
  }
  throw new Error("没有抛错");
}

describe("创建", () => {
  it("token 从 1 起递增、只在成功时分配、不复用（E15）", () => {
    const store = new ModelDataStore();
    expect(store.create({ shapes: [shape()], bounds: null }, pass)).toBe(1);
    // 码 3 失败不占号
    expect(failure(() => store.create({ shapes: [shape({ vertices: zeros(10) })], bounds: null }, pass))).toEqual({
      code: 3,
      message: "Inconsistent vertex buffer size",
    });
    expect(store.create({ shapes: [shape()], bounds: null }, pass)).toBe(2);
    // 释放后也不复用
    store.releaseScript(2);
    expect(store.create({ shapes: [shape()], bounds: null }, pass)).toBe(3);
  });

  it("格式位的 stride（E1）：[P,N,U,C] 48 / [P,U,C] 36，顶点字节数不是 stride 的整数倍 → 码 3", () => {
    const { store, token } = made({ format: PUN, vertices: zeros(12 * 2) });
    expect(store.desc(token)?.shapes[0].vertexCount).toBe(2);
    expect(failure(() => made({ format: PUN, vertices: zeros(13) })).code).toBe(3);
  });

  it("材质检查：1 = Invalid material、2 = Shader expecting more vertex data.；处理完全部形状、留最后一个码再失败", () => {
    const store = new ModelDataStore();
    const calls: string[] = [];
    const check: MaterialCheck = (material) => {
      calls.push(material);
      return material === "bad1" ? 1 : material === "bad2" ? 2 : 0;
    };
    const run = (...materials: string[]) =>
      failure(() => store.create({ shapes: materials.map((material) => shape({ material })), bounds: null }, check));
    expect(run("bad1")).toEqual({ code: 1, message: "Invalid material" });
    expect(run("bad2")).toEqual({ code: 2, message: "Shader expecting more vertex data." });
    calls.length = 0;
    expect(run("bad1", "ok", "bad2").code).toBe(2);
    expect(calls).toEqual(["bad1", "ok", "bad2"]);
    expect(run("bad2", "bad1").code).toBe(1);
    // 码 3 之后的材质检查仍会覆盖它（exe 的写入顺序）
    expect(
      failure(() => store.create({ shapes: [shape({ vertices: zeros(10), material: "bad1" })], bounds: null }, check))
        .code,
    ).toBe(1);
  });

  it("没有形状 → Shapes missing.", () => {
    expect(failure(() => new ModelDataStore().create({ shapes: [], bounds: null }, pass))).toEqual({
      code: 0,
      message: "Shapes missing.",
    });
  });

  it("字节在调用时拷贝：之后改数组不影响数据仓（E3b）", () => {
    const vertices = floats(...new Array(27).fill(1));
    const { store, token } = made({ vertices });
    new Float32Array(vertices.buffer).fill(9);
    expect(Array.from(new Float32Array(store.shape(token, 0)!.vertices.buffer)).every((v) => v === 1)).toBe(true);
  });

  it("绘制数：有索引 = 索引个数（0 时取顶点数），无索引 = 顶点数（E2）", () => {
    expect(made().store.shape(1, 0)?.drawCount).toBe(3);
    expect(made({ index: u16(0, 1, 2, 2, 1, 0) }).store.shape(1, 0)?.drawCount).toBe(6);
    expect(made({ index: null }).store.shape(1, 0)?.drawCount).toBe(3);
    expect(made({ index: u16() }).store.shape(1, 0)?.drawCount).toBe(3);
  });

  it("描述：格式、顶点数、索引格式与个数、材质、包围盒", () => {
    const { store, token } = made({ index: u32(0, 1, 2) });
    expect(store.desc(token)).toEqual({
      token,
      shapes: [{ format: PUV, vertexCount: 3, indexFormat: "uint32", indexCount: 3, material: "materials/a.json" }],
      bounds: expect.any(Array),
    });
    expect(store.desc(99)).toBeNull();
    expect(store.shape(token, 3)).toBeNull();
  });
});

describe("包围盒（D6）", () => {
  it("给了用给的（建时定一次，apply / replace 不改）", () => {
    const store = new ModelDataStore();
    const token = store.create({ shapes: [shape()], bounds: [-1, -2, -3, 4, 5, 6] }, pass);
    store.apply(token, [{ vertices: floats(...new Array(27).fill(100)) }]);
    store.replace(token, [{ vertices: floats(...new Array(36).fill(500)) }], pass);
    expect(store.desc(token)?.bounds).toEqual([-1, -2, -3, 4, 5, 6]);
  });

  it("没给：只取位置分量，法线 / uv / 颜色不混进来", () => {
    // 格式 PUN，stride 48：位置 (10, 20, 30) 与 (-5, 0, 7)，其余分量填很大的值
    const row = (x: number, y: number, z: number) => [x, y, z, 999, 999, 999, 888, 888, 777, 777, 777, 777];
    const { store, token } = made({ format: PUN, vertices: floats(...row(10, 20, 30), ...row(-5, 0, 7)), index: null });
    expect(store.desc(token)?.bounds).toEqual([-5, 0, 7, 10, 20, 30]);
  });

  it("多个形状取并集；格式里没有位置 → ±131072", () => {
    const store = new ModelDataStore();
    const a = floats(0, 0, 0, 0, 0, 0, 0, 0, 0);
    const b = floats(3, 4, 5, 0, 0, 0, 0, 0, 0);
    const token = store.create(
      { shapes: [shape({ vertices: a, index: null }), shape({ vertices: b, index: null })], bounds: null },
      pass,
    );
    expect(store.desc(token)?.bounds).toEqual([0, 0, 0, 3, 4, 5]);
    const noPosition = new ModelDataStore().create(
      { shapes: [shape({ format: UV | COLOR, vertices: zeros(6 * 2), index: null })], bounds: null },
      pass,
    );
    expect(noPosition).toBe(1);
    const other = new ModelDataStore();
    const t = other.create(
      { shapes: [shape({ format: UV | COLOR, vertices: zeros(6 * 2), index: null })], bounds: null },
      pass,
    );
    expect(other.desc(t)?.bounds).toEqual([-131072, -131072, -131072, 131072, 131072, 131072]);
  });
});

describe("applyData", () => {
  it("token 不在 → 码 4；形状数多于现有 → 码 10", () => {
    const { store, token } = made();
    expect(failure(() => store.apply(99, [{}]))).toEqual({ code: 4, message: "Invalid model data token" });
    expect(failure(() => store.apply(token, [{}, {}]))).toEqual({
      code: 10,
      message: "Cannot add shapes in IModelData.update",
    });
  });

  it("删形状 / 删索引标志 → 码 11；换材质（不分大小写比较）→ 码 12；换格式 → 码 13", () => {
    const { store, token } = made();
    expect(failure(() => store.apply(token, [{ deleteShape: true }]))).toEqual({
      code: 11,
      message: "Cannot delete shape or buffers in IModelData.update",
    });
    expect(failure(() => store.apply(token, [{ dropIndex: true }])).code).toBe(11);
    expect(failure(() => store.apply(token, [{ material: "materials/b.json" }]))).toEqual({
      code: 12,
      message: "Material cannot be changed in IModelData.update",
    });
    // 同一个材质（大小写不同）不算换
    store.apply(token, [{ material: "MATERIALS/A.JSON" }]);
    expect(failure(() => store.apply(token, [{ format: PUN }]))).toEqual({
      code: 13,
      message: "Vertex format cannot be changed in IModelData.update",
    });
    store.apply(token, [{ format: PUV }]); // 同格式不算换
  });

  it("没给的字段不改：材质空串、格式 0、顶点 / 索引不给", () => {
    const { store, token } = made();
    const before = store.shape(token, 0)!.version;
    store.apply(token, [{ material: "", format: 0 }]);
    expect(store.shape(token, 0)!.version).toBe(before);
  });

  it("给了顶点而缓冲不是动态、或给了索引而索引不是动态 → 码 7", () => {
    const vertex = made({ dynamicVertex: false });
    expect(failure(() => vertex.store.apply(vertex.token, [{ vertices: zeros(27) }]))).toEqual({
      code: 7,
      message: "Model data not created as dynamic",
    });
    const index = made({ dynamicIndex: false });
    expect(failure(() => index.store.apply(index.token, [{ index: u16(0, 1, 2) }])).code).toBe(7);
    // 不给就不报
    vertex.store.apply(vertex.token, [{ index: u16(2, 1, 0) }]);
  });

  it("D3：顶点变长 → 码 5、索引变长 → 码 6（WPE 误报 7）", () => {
    const { store, token } = made();
    expect(failure(() => store.apply(token, [{ vertices: zeros(9 * 4) }]))).toEqual({
      code: 5,
      message: "Vertex buffer size cannot increase",
    });
    expect(failure(() => store.apply(token, [{ index: u16(0, 1, 2, 0) }]))).toEqual({
      code: 6,
      message: "Index buffer size cannot increase",
    });
    // 无索引的网格给索引：容量 0，变长 → 6
    const none = made({ index: null });
    expect(failure(() => none.store.apply(none.token, [{ index: u16(0, 1, 2) }])).code).toBe(6);
  });

  it("索引类型与网格不同 → 码 9；顶点仍照传", () => {
    const { store, token } = made();
    const result = failure(() =>
      store.apply(token, [{ vertices: floats(...new Array(27).fill(2)), index: u32(0, 1, 2) }]),
    );
    expect(result).toEqual({ code: 9, message: "Incorrect index buffer type" });
    expect(new Float32Array(store.shape(token, 0)!.vertices.buffer)[0]).toBe(2);
  });

  it("D4：只拷给出的长度，余下保持旧值；版本 +1；调用时拷贝", () => {
    const { store, token } = made({ vertices: floats(...new Array(27).fill(1)) });
    const v0 = store.shape(token, 0)!.version;
    const given = floats(...new Array(9).fill(5)); // 只给一个顶点
    store.apply(token, [{ vertices: given }]);
    new Float32Array(given.buffer).fill(0);
    const data = new Float32Array(store.shape(token, 0)!.vertices.buffer);
    expect(Array.from(data.slice(0, 9))).toEqual(new Array(9).fill(5));
    expect(Array.from(data.slice(9))).toEqual(new Array(18).fill(1));
    expect(store.shape(token, 0)!.version).toBe(v0 + 1);
  });

  it("D5：绘制数——有索引网格给了索引 = 这次的索引个数，只给顶点不变；无索引 = 这次的顶点数", () => {
    const indexed = made({ index: u16(0, 1, 2, 2, 1, 0) });
    indexed.store.apply(indexed.token, [{ index: u16(0, 1, 2) }]);
    expect(indexed.store.shape(indexed.token, 0)!.drawCount).toBe(3);
    indexed.store.apply(indexed.token, [{ vertices: zeros(9) }]);
    expect(indexed.store.shape(indexed.token, 0)!.drawCount).toBe(3);
    const plain = made({ index: null });
    plain.store.apply(plain.token, [{ vertices: zeros(9 * 2) }]);
    expect(plain.store.shape(plain.token, 0)!.drawCount).toBe(2);
    plain.store.apply(plain.token, [{ vertices: zeros(9 * 3) }]);
    expect(plain.store.shape(plain.token, 0)!.drawCount).toBe(3);
  });

  it("出错时前面已处理的形状不回滚", () => {
    const store = new ModelDataStore();
    const token = store.create({ shapes: [shape(), shape()], bounds: null }, pass);
    const second: ModelDataUpdate = { material: "other" };
    expect(failure(() => store.apply(token, [{ vertices: floats(...new Array(27).fill(7)) }, second])).code).toBe(12);
    expect(new Float32Array(store.shape(token, 0)!.vertices.buffer)[0]).toBe(7);
  });

  it("不调结构通知", () => {
    const { store, token } = made();
    let fired = 0;
    store.onStructure = () => fired++;
    store.apply(token, [{ vertices: zeros(27) }]);
    expect(fired).toBe(0);
  });
});

describe("replaceData", () => {
  it("可以加形状（按创建规则校验）、结构通知一次", () => {
    const { store, token } = made();
    const fired: number[] = [];
    store.onStructure = (t) => fired.push(t);
    store.replace(
      token,
      [{}, { vertices: zeros(12 * 2), format: PUN, material: "materials/b.json", index: u16(0, 1, 1) }],
      pass,
    );
    expect(fired).toEqual([token]);
    const desc = store.desc(token)!;
    expect(desc.shapes.map((item) => item.material)).toEqual(["materials/a.json", "materials/b.json"]);
    expect(desc.shapes[1]).toMatchObject({ format: PUN, vertexCount: 2, indexCount: 3 });
    // 缺顶点 / 格式 / 材质照 dll 的文字
    expect(failure(() => store.replace(token, [{}, {}, { format: PUV, material: "m" }], pass)).message).toBe(
      "Vertex buffer missing.",
    );
    expect(failure(() => store.replace(token, [{}, {}, { vertices: zeros(9), material: "m" }], pass)).message).toBe(
      "Vertex format missing.",
    );
    expect(failure(() => store.replace(token, [{}, {}, { vertices: zeros(9), format: PUV }], pass)).message).toBe(
      "Material missing.",
    );
  });

  it("可以删形状（null 形状）、删索引、换材质、换格式", () => {
    const store = new ModelDataStore();
    const token = store.create({ shapes: [shape(), shape({ material: "materials/c.json" })], bounds: null }, pass);
    const fired: number[] = [];
    store.onStructure = (t) => fired.push(t);
    store.replace(token, [{ deleteShape: true }], pass);
    expect(store.desc(token)!.shapes.map((item) => item.material)).toEqual(["materials/c.json"]);
    store.replace(token, [{ dropIndex: true }], pass);
    expect(store.desc(token)!.shapes[0]).toMatchObject({ indexFormat: null, indexCount: 0 });
    expect(store.shape(token, 0)!.drawCount).toBe(3); // 无索引 = 顶点数
    store.replace(token, [{ material: "materials/d.json" }], pass);
    expect(store.desc(token)!.shapes[0].material).toBe("materials/d.json");
    store.replace(token, [{ format: PUN, vertices: zeros(12 * 2) }], pass);
    expect(store.desc(token)!.shapes[0]).toMatchObject({ format: PUN, vertexCount: 2 });
    expect(fired).toHaveLength(4);
  });

  it("D8：没写格式的重建沿用原格式；换格式没给顶点时沿用旧字节、不是整数倍 → 码 3", () => {
    const { store, token } = made();
    // 变长（重建）但没写格式
    store.replace(token, [{ vertices: zeros(9 * 5) }], pass);
    expect(store.desc(token)!.shapes[0]).toMatchObject({ format: PUV, vertexCount: 5 });
    // 108 字节换成 48 字节的 stride：不是整数倍
    expect(failure(() => store.replace(token, [{ format: PUN }], pass)).code).toBe(3);
    expect(store.desc(token)!.shapes[0].format).toBe(PUV);
  });

  it("变长与改动态标志重建；不变长的动态缓冲就地覆盖（不通知）", () => {
    const { store, token } = made();
    const fired: number[] = [];
    store.onStructure = (t) => fired.push(t);
    store.replace(token, [{ vertices: floats(...new Array(27).fill(4)) }], pass);
    expect(fired).toEqual([]);
    expect(store.shape(token, 0)!.version).toBe(1);
    store.replace(token, [{ index: u16(0, 1, 2, 2, 1, 0) }], pass); // 索引变长
    expect(fired).toEqual([token]);
    expect(store.shape(token, 0)!.drawCount).toBe(6);
    store.replace(token, [{ dynamicVertex: false }], pass); // 动态 → 静态
    expect(fired).toEqual([token, token]);
    // 静态缓冲给顶点也走重建
    store.replace(token, [{ vertices: zeros(27) }], pass);
    expect(fired).toHaveLength(3);
  });

  it("不改包围盒；换材质或重建时调材质检查，失败码 1 / 2 仍通知结构变化", () => {
    const { store, token } = made();
    const bounds = store.desc(token)!.bounds;
    const fired: number[] = [];
    store.onStructure = (t) => fired.push(t);
    const check: MaterialCheck = (material) => (material === "bad" ? 2 : 0);
    expect(failure(() => store.replace(token, [{ material: "bad" }], check)).code).toBe(2);
    expect(fired).toEqual([token]);
    expect(store.desc(token)!.bounds).toEqual(bounds);
  });

  it("token 不在 → 码 4", () => {
    expect(failure(() => new ModelDataStore().replace(3, [{}], pass)).code).toBe(4);
  });
});

describe("引用计数（S15、D9）", () => {
  it("脚本一份 + 每个图层一份，减到 0 才删并通知", () => {
    const { store, token } = made();
    const released: number[] = [];
    store.onRelease = (t) => released.push(t);
    expect(store.retainLayer(token, 10)).toBe(true);
    expect(store.retainLayer(token, 11)).toBe(true);
    store.releaseScript(token);
    expect(released).toEqual([]);
    expect(store.desc(token)).not.toBeNull();
    // 脚本释放后资源还在，applyData 照常
    store.apply(token, [{ vertices: zeros(27) }]);
    store.releaseLayer(token, 10);
    expect(released).toEqual([]);
    store.releaseLayer(token, 11);
    expect(released).toEqual([token]);
    expect(store.desc(token)).toBeNull();
    expect(failure(() => store.apply(token, [{}])).code).toBe(4);
  });

  it("D9：同一个 token 的脚本释放只生效一次，不会把图层的引用也算掉", () => {
    const { store, token } = made();
    store.retainLayer(token, 10);
    store.releaseScript(token);
    store.releaseScript(token);
    store.releaseScript(token);
    expect(store.desc(token)).not.toBeNull();
    store.releaseLayer(token, 10);
    expect(store.desc(token)).toBeNull();
  });

  it("没有图层时脚本释放即删；查不到的 token：retainLayer 返回 false（图层照建、不画，S16），其余静默", () => {
    const { store, token } = made();
    const released: number[] = [];
    store.onRelease = (t) => released.push(t);
    store.releaseScript(token);
    expect(released).toEqual([token]);
    expect(store.retainLayer(token, 1)).toBe(false);
    expect(store.retainLayer(12345, 1)).toBe(false);
    store.releaseLayer(12345, 1);
    store.releaseScript(12345);
    expect(released).toEqual([token]);
  });

  it("同一个对象重复 retain 只记一份；重复 releaseLayer 无副作用", () => {
    const { store, token } = made();
    store.retainLayer(token, 10);
    store.retainLayer(token, 10);
    store.releaseScript(token);
    store.releaseLayer(token, 10);
    expect(store.desc(token)).toBeNull();
  });
});
