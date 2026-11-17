/**
 * 活的场景图 L2：Worker 的消息处理（`compile/workerHandler.ts`）。内存工程 + 假翻译器，`post` 用 `structuredClone(message, { transfer })`
 * 真转移缓冲（Node 里同样让发出方的缓冲变成已分离），读文件请求由测试按内存表异步回 `file-result`。
 * 覆盖：opened 与 `compileScene` 相同、转移后会话编同一个 mdl 的新对象不报已分离（不忘记缓冲时报，证明判据有效）、
 * 新增纹理的 mip 随片段转移、并发请求串行完成、片段编译抛错后会话变坏、close 与重复 open。
 */
import { describe, expect, it, vi } from "vitest";
import { compileScene } from "./bundle";
import type { FragmentDelta } from "./fragment";
import { mdlStride } from "./mdl";
import { encodeFileError, type OpenRequest, type WorkerRequest, type WorkerResponse } from "./protocol";
import { createWorkerHandler, deltaTransferables, findDetached, type WorkerHandlerOptions } from "./workerHandler";
import type { Wpesl2wgsl } from "../wpesl2wgsl";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

const ORTHO = { orthogonalprojection: { width: 1920, height: 1080 } };

// ———— 工程文件 ————

function mdl(): Uint8Array {
  const out: number[] = [];
  const u32 = (value: number) => out.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);
  const cstr = (text: string) => out.push(...new TextEncoder().encode(text), 0);
  const block = (bytes: Uint8Array) => {
    u32(bytes.length);
    out.push(...bytes);
  };
  cstr("MDLV0023");
  u32(0x9);
  u32(1);
  u32(1);
  cstr("materials/a.json");
  u32(0);
  out.push(...new Uint8Array(new Float32Array([-1, -1, 0, 1, 1, 0]).buffer));
  u32(0x9);
  // 顶点数据带可辨认的内容：转移后读回的视图要和原来逐字节相同
  block(Uint8Array.from({ length: 4 * mdlStride(0x9) }, (_, i) => (i * 7 + 3) & 255));
  block(new Uint8Array(new Uint16Array([0, 1, 2, 0, 2, 3]).buffer));
  out.push(0, 0);
  u32(0);
  out.push(0);
  return new Uint8Array(out);
}

const parts = (...buffers: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(buffers.reduce((sum, bytes) => sum + bytes.length, 0));
  let at = 0;
  for (const bytes of buffers) {
    out.set(bytes, at);
    at += bytes.length;
  }
  return out;
};
const u32 = (value: number): Uint8Array => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, true);
  return out;
};
const magic = (text: string) => parts(new TextEncoder().encode(text), new Uint8Array([0]));
/** RGBA8 单 mip 的 `.tex`（TEXB0002）：64×64，mip 数据按 `seed` 填花样，每张不同 */
function tex(seed: number): Uint8Array {
  const size = 64;
  const data = Uint8Array.from({ length: size * size * 4 }, (_, i) => (i + seed) & 255);
  return parts(
    magic("TEXV0005"),
    magic("TEXI0001"),
    u32(0),
    u32(0),
    u32(size),
    u32(size),
    u32(48),
    u32(40),
    u32(0),
    magic("TEXB0002"),
    u32(1),
    u32(1),
    u32(size),
    u32(size),
    u32(0),
    u32(data.length),
    u32(data.length),
    data,
  );
}

/** 场景对象：0 静态模型，1 带贴图 a 的图像层 */
const OBJECTS: Record<string, unknown>[] = [
  { id: 10, name: "model", model: "models/a.mdl", origin: "300 300 0" },
  { id: 11, name: "tex-a", image: "models/ta.json", origin: "100 100 0" },
];
const objectCount = OBJECTS.length;

const files: Record<string, unknown> = {
  "P:/p/project.json": { file: "scene.json", general: { properties: { p: { type: "slider", value: 1 } } } },
  "P:/p/scene.json": { general: ORTHO, objects: OBJECTS },
  "P:/p/models/a.mdl": mdl(),
  "P:/p/materials/a.json": { passes: [{ shader: "base" }] },
  "P:/p/models/ta.json": { material: "materials/ta.json", width: 4, height: 4 },
  "P:/p/materials/ta.json": { passes: [{ shader: "base", textures: ["ta"] }] },
  "P:/p/materials/ta.tex": tex(1),
  "P:/p/models/tb.json": { material: "materials/tb.json", width: 4, height: 4 },
  "P:/p/materials/tb.json": { passes: [{ shader: "base", textures: ["tb"] }] },
  "P:/p/materials/tb.tex": tex(2),
  "P:/p/shaders/base.vert": "// base",
  "P:/p/shaders/base.frag": "// base",
};

function bytesOf(path: string): Uint8Array {
  const value = files[path.replace(/\\/g, "/")];
  if (value === undefined) throw new TypeError("Failed to fetch");
  if (value instanceof Uint8Array) return value.slice();
  return new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
}
const memoryReader = {
  readWhole: async (path: string) => bytesOf(path),
  readRange: async (path: string, start: number, end: number) => bytesOf(path).slice(start, end),
};

/** 假翻译器：一律成功、没有接口；`memoryBytes` 固定，给统计用例看。 */
const translator = {
  memoryBytes: 123456,
  async translate() {
    return { ok: true, uniforms: [], textures: [], combos: [], attributes: [] };
  },
} as unknown as Wpesl2wgsl;

// force：夹具里有不支持项时纹理字节不读（`shouldDecode`），测试要看 mip 的转移
const OPEN: OpenRequest = {
  projectDir: "P:/p",
  sceneAssets: [],
  userProperties: {},
  scriptOverrides: {},
  structure: { destroyed: [], parents: [], created: [] },
  postprocess: "disabled",
  reflection: "disabled",
  shadows: "disabled",
  volumetrics: "disabled",
  force: true,
  exhaustive: true,
  module: null,
};

// ———— 测试台 ————

/** 一个 Worker：处理器 + 收到的（已克隆的）消息。读文件请求异步回复，故意让并发的编译交错。 */
/** `faults.throwOnce`：这类消息第一次发送时 post 抛错（模拟结构化克隆失败），之后照常。 */
function harness(options: WorkerHandlerOptions = {}, faults: { throwOnce?: WorkerResponse["type"] } = {}) {
  const events: WorkerResponse[] = [];
  let thrown = false;
  const closed = vi.fn();
  const handler = createWorkerHandler(
    (message, transfer) => {
      if (!thrown && faults.throwOnce === message.type) {
        thrown = true;
        throw new Error("DataCloneError（模拟）");
      }
      // 和真实 postMessage 一样转移：发出方的缓冲在这里变成已分离
      const cloned = structuredClone(message, { transfer });
      events.push(cloned);
      if (cloned.type === "file") {
        setTimeout(() => {
          try {
            const all = bytesOf(cloned.path);
            void handler({
              type: "file-result",
              id: cloned.id,
              bytes: cloned.operation === "whole" ? all : all.slice(cloned.start, cloned.end),
            });
          } catch (error) {
            void handler({ type: "file-result", id: cloned.id, error: encodeFileError(error) });
          }
        }, 0);
      }
    },
    { onClose: closed, loadTranslator: async () => translator, ...options },
  );
  const open = () => handler({ type: "open", ...OPEN });
  let nextId = 1;
  const fragment = (config: Record<string, unknown>, object: number) => {
    const id = nextId++;
    const done = handler({
      type: "fragment",
      id,
      request: { object, config: JSON.stringify(config), parent: null, bone: null, properties: {} },
    });
    return { id, done };
  };
  const find = <T extends WorkerResponse["type"]>(type: T, id?: number) =>
    events.filter(
      (event): event is Extract<WorkerResponse, { type: T }> =>
        event.type === type && (id === undefined || (event as { id?: number }).id === id),
    );
  return { events, handler, open, fragment, find, closed };
}

const wholeInput = {
  projectDir: OPEN.projectDir,
  sceneAssets: OPEN.sceneAssets,
  reader: memoryReader,
  translator,
  postprocess: "disabled" as const,
  reflection: "disabled" as const,
  force: true,
  exhaustive: true,
};

/** 类型化数组、Map、Set 规整成可比较的普通值。 */
function canon(value: unknown): unknown {
  if (typeof value === "function") return undefined;
  if (ArrayBuffer.isView(value))
    return { $view: value.constructor.name, $data: Array.from(value as unknown as number[]) };
  if (value instanceof Map) return { $map: [...value.entries()].map(([k, v]) => [canon(k), canon(v)]) };
  if (value instanceof Set) return { $set: [...value].map(canon) };
  if (Array.isArray(value)) return value.map(canon);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const item = canon((value as Record<string, unknown>)[key]);
      if (item !== undefined) out[key] = item;
    }
    return out;
  }
  return value;
}

const MODEL_CONFIG = (id: number) => ({ id, name: `m${id}`, model: "models/a.mdl", origin: "1 2 0" });
const TEX_A_CONFIG = (id: number) => ({ id, name: `a${id}`, image: "models/ta.json", origin: "5 5 0" });
const TEX_B_CONFIG = (id: number) => ({ id, name: `b${id}`, image: "models/tb.json", origin: "6 6 0" });

describe("open", () => {
  it("opened 的整场 bundle 与 compileScene 相同，带统计（wasm 内存来自翻译器）", async () => {
    const { open, find } = harness();
    await open();
    const opened = find("opened");
    expect(opened).toHaveLength(1);
    // 转移后原缓冲已分离，另编一份来比
    const whole = await compileScene(wholeInput);
    expect(canon(opened[0].bundle)).toEqual(canon(whole));
    expect(opened[0].stats.wasmBytes).toBe(123456);
    // 打开后清缓存（trimCaches）：解析过的 mdl 不常驻
    expect(opened[0].stats.mdls).toBe(0);
    expect(opened[0].stats.textures).toBeGreaterThan(0);
    expect(find("error")).toHaveLength(0);
  });

  it("opened 转移的缓冲里有 mdl 文件缓冲与纹理 mip", async () => {
    const { open, find } = harness();
    await open();
    const bundle = find("opened")[0].bundle;
    // 转移到主线程之后这些视图是有内容的
    expect(bundle.layers[0].model!.meshes[0].vertices.byteLength).toBeGreaterThan(0);
    expect(bundle.textures.some((texture) => texture.mips.some((mip) => (mip.bytes?.byteLength ?? 0) > 0))).toBe(true);
  });

  it("第二次 open 回 error，不影响已打开的会话", async () => {
    const { open, find, fragment } = harness();
    await open();
    await open();
    expect(find("error")).toHaveLength(1);
    expect(find("error")[0].message).toContain("只能 open 一次");
    const { id, done } = fragment(MODEL_CONFIG(90), objectCount);
    await done;
    expect(find("fragment-done", id)).toHaveLength(1);
  });

  it("open 失败（缺 project.json）回 error，之后的片段请求回 broken", async () => {
    const { handler, find, fragment, events } = harness();
    const saved = files["P:/p/project.json"];
    delete files["P:/p/project.json"];
    try {
      await handler({ type: "open", ...OPEN });
    } finally {
      files["P:/p/project.json"] = saved;
    }
    expect(find("error")).toHaveLength(1);
    const { id, done } = fragment(MODEL_CONFIG(90), objectCount);
    await done;
    expect(find("fragment-error", id)[0]).toMatchObject({ broken: true });
    expect(events.some((event) => event.type === "opened")).toBe(false);
  });
});

describe("转移之后的缓冲", () => {
  it("打开与片段之后都清缓存：opened 与 fragment-done 的统计里文件缓存与 mdl 为 0，模型片段照常（文件重读）", async () => {
    const { open, fragment, find } = harness();
    await open();
    const opened = find("opened")[0];
    expect(opened.stats).toMatchObject({ cachedBytes: 0, mdls: 0, files: 0 });
    const { id, done } = fragment(MODEL_CONFIG(90), objectCount);
    await done;
    const reply = find("fragment-done", id)[0];
    expect(findDetached(reply.delta)).toBeNull();
    // 片段编完同样清缓存：常驻的文件缓存仍为 0
    expect(reply.stats).toMatchObject({ cachedBytes: 0, mdls: 0, files: 0 });
  });

  // 两条用例：缺省（打开后清缓存）与只靠 forgetBuffers（不清缓存），转移之后的模型片段都不能带已分离的缓冲
  for (const trimCaches of [true, false])
    it(`转移后编同一个 mdl 的新对象（trimCaches ${trimCaches}）：片段正常、没有已分离缓冲，顶点数据与整场一致`, async () => {
      const { open, fragment, find } = harness({ trimCaches });
      await open();
      const whole = await compileScene(wholeInput);
      const expected = canon(whole.layers[0].model!.meshes[0].vertices);
      const first = fragment(MODEL_CONFIG(90), objectCount);
      await first.done;
      expect(find("fragment-error")).toHaveLength(0);
      const done = find("fragment-done", first.id)[0];
      expect(findDetached(done.delta)).toBeNull();
      expect(canon(done.delta.fragment.layer.model!.meshes[0].vertices)).toEqual(expected);
      // 再来一个：会话的缓存在第一个片段之后仍然可用
      const second = fragment(MODEL_CONFIG(91), objectCount + 1);
      await second.done;
      const again = find("fragment-done", second.id)[0];
      expect(findDetached(again.delta)).toBeNull();
      expect(canon(again.delta.fragment.layer.model!.meshes[0].vertices)).toEqual(expected);
      expect(again.delta.fragment.layer.object).toBe(objectCount + 1);
    });

  it("不调 forgetBuffers 时同一用例报 detached（证明判据有效）", async () => {
    const { open, fragment, find } = harness({ forgetAfterTransfer: false, trimCaches: false });
    await open();
    const { id, done } = fragment(MODEL_CONFIG(90), objectCount);
    await done;
    const error = find("fragment-error", id)[0];
    expect(error).toBeDefined();
    expect(error.message).toContain("detached");
    expect(error.broken).toBe(true);
    expect(find("fragment-done")).toHaveLength(0);
  });

  it("引用已有纹理的新对象不带新纹理；引用新纹理的对象带新 mip，转移到主线程后有内容", async () => {
    const { open, fragment, find } = harness();
    await open();
    const same = fragment(TEX_A_CONFIG(92), objectCount);
    await same.done;
    const sameDone = find("fragment-done", same.id)[0];
    expect(sameDone.delta.textures.list).toHaveLength(0);
    expect(findDetached(sameDone.delta)).toBeNull();
    const fresh = fragment(TEX_B_CONFIG(93), objectCount + 1);
    await fresh.done;
    const freshDone = find("fragment-done", fresh.id)[0];
    expect(freshDone.delta.textures.list).toHaveLength(1);
    const mip = freshDone.delta.textures.list[0].mips[0];
    expect(mip.bytes!.byteLength).toBe(64 * 64 * 4);
    expect(mip.bytes![0]).toBe(2 & 255);
    expect(findDetached(freshDone.delta)).toBeNull();
    // 同一个新纹理再被引用：纹理按路径缓存，只给下标，不再带 mip（会话里那份 mip 已转移走）
    const reuse = fragment(TEX_B_CONFIG(94), objectCount + 2);
    await reuse.done;
    const reuseDone = find("fragment-done", reuse.id)[0];
    expect(reuseDone.delta.textures.list).toHaveLength(0);
    expect(findDetached(reuseDone.delta)).toBeNull();
  });

  it("deltaTransferables 只含新增纹理的 mip 缓冲（去重）", () => {
    const buffer = new ArrayBuffer(8);
    const delta = {
      textures: {
        from: 3,
        list: [
          { mips: [{ bytes: new Uint8Array(buffer, 0, 4) }, { bytes: new Uint8Array(buffer, 4, 4) }, {}] },
          { mips: [{ bytes: new Uint8Array(4) }] },
        ],
      },
    } as unknown as FragmentDelta;
    const transfer = deltaTransferables(delta);
    expect(transfer).toHaveLength(2);
    expect(transfer[0]).toBe(buffer);
  });
});

describe("findDetached", () => {
  it("找到已分离缓冲上的视图，给出路径；没有返回 null", () => {
    const live = new Uint8Array(4);
    const gone = new Uint8Array(4);
    structuredClone(gone.buffer, { transfer: [gone.buffer] });
    expect(findDetached({ a: [live], b: new Map([["k", { c: live }]]) })).toBeNull();
    expect(findDetached({ a: [live], b: { c: gone } })).toBe(".b.c");
    expect(findDetached({ s: new Set([gone]) })).toBe(".s{0}");
  });
});

describe("串行与失败", () => {
  it("两个片段请求并发发出：按顺序完成，结果与串行相同（增量的 from 不互相污染）", async () => {
    const serial = harness();
    await serial.open();
    const a1 = serial.fragment(MODEL_CONFIG(90), objectCount);
    await a1.done;
    const a2 = serial.fragment(TEX_B_CONFIG(91), objectCount + 1);
    await a2.done;
    const expected = [a1, a2].map((item) => canon(serial.find("fragment-done", item.id)[0].delta));

    const parallel = harness();
    await parallel.open();
    const b1 = parallel.fragment(MODEL_CONFIG(90), objectCount);
    const b2 = parallel.fragment(TEX_B_CONFIG(91), objectCount + 1);
    await Promise.all([b1.done, b2.done]);
    const order = parallel.events.filter((event) => event.type === "fragment-done").map((event) => event.id);
    expect(order).toEqual([b1.id, b2.id]);
    expect([b1, b2].map((item) => canon(parallel.find("fragment-done", item.id)[0].delta))).toEqual(expected);
  });

  it("串行：第二个请求的读文件请求在第一个片段回复之后才发出", async () => {
    const { open, fragment, events } = harness();
    await open();
    const baseline = events.length;
    const first = fragment(TEX_B_CONFIG(91), objectCount);
    const second = fragment(MODEL_CONFIG(90), objectCount + 1);
    await Promise.all([first.done, second.done]);
    const tail = events.slice(baseline);
    const firstDone = tail.findIndex((event) => event.type === "fragment-done" && event.id === first.id);
    const secondFile = tail.findIndex(
      (event, index) => index < firstDone && event.type === "file" && event.path.endsWith("a.mdl"),
    );
    // 第一个片段（贴图 b）不读 a.mdl，第二个片段（模型）读；串行时 a.mdl 的读取一定在第一个回复之后
    expect(firstDone).toBeGreaterThanOrEqual(0);
    expect(secondFile).toBe(-1);
  });

  it("compileFragment 抛错后会话变坏：该请求与之后的请求都回 broken", async () => {
    const { open, fragment, find } = harness();
    await open();
    // 已有下标不带 overrides（单对象重编译要带，L6）抛错
    const bad = fragment(MODEL_CONFIG(90), 0);
    await bad.done;
    expect(find("fragment-error", bad.id)[0]).toMatchObject({ broken: true });
    expect(find("fragment-error", bad.id)[0].message).toContain("overrides");
    const next = fragment(MODEL_CONFIG(91), objectCount);
    await next.done;
    const error = find("fragment-error", next.id)[0];
    expect(error.broken).toBe(true);
    expect(error.message).toContain("broken");
    expect(find("fragment-done")).toHaveLength(0);
  });

  it("发回时意外抛错（结构化克隆失败）：这个请求回 broken，之后的请求照样有回复（队列不卡死）", async () => {
    const { open, fragment, find } = harness({}, { throwOnce: "fragment-done" });
    await open();
    const first = fragment(MODEL_CONFIG(90), objectCount);
    await first.done;
    expect(find("fragment-error", first.id)[0]).toMatchObject({ broken: true });
    expect(find("fragment-error", first.id)[0].message).toContain("DataCloneError");
    const second = fragment(MODEL_CONFIG(91), objectCount + 1);
    await second.done;
    expect(find("fragment-error", second.id)[0]).toMatchObject({ broken: true });
    expect(find("fragment-done")).toHaveLength(0);
  });

  it("没有 open 就发片段请求：回 broken", async () => {
    const { fragment, find } = harness();
    const { id, done } = fragment(MODEL_CONFIG(90), objectCount);
    await done;
    expect(find("fragment-error", id)[0]).toMatchObject({ broken: true });
  });
});

describe("close", () => {
  it("close 之后的片段请求与 open 都回错误，并通知 worker.ts 关闭", async () => {
    const { open, handler, fragment, find, closed } = harness();
    await open();
    await handler({ type: "close" } satisfies WorkerRequest);
    expect(closed).toHaveBeenCalledTimes(1);
    const { id, done } = fragment(MODEL_CONFIG(90), objectCount);
    await done;
    const error = find("fragment-error", id)[0];
    expect(error).toMatchObject({ broken: true });
    expect(error.message).toContain("关闭");
    await handler({ type: "open", ...OPEN });
    expect(find("error").at(-1)!.message).toContain("关闭");
  });
});
