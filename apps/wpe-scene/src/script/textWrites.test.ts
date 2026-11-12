/**
 * P6b 1e-1：脚本写回链上的字符串（计划「1e」点 1）。
 * - `ScriptRuntime.writeReturn`：文本目标的 `"string"` 不再丢掉，按 WPE 类型 5 的 `ToString` 交给宿主（`null` / `undefined` 不写）；
 *   别的目标初值猜成 `"string"` 的照旧丢；`update(value)` 收到的是读回的字符串（不是 `Vec2(NaN, NaN)`）；重放表存字符串，键与宿主
 *   `targetPath` 相同；
 * - `ScriptApi.write` 的 `"string"` 分支（步骤 2 的 `ITextLayer` 用）：同一条规则，只给文本目标。
 */
import { describe, expect, it } from "vitest";
import type { BindingTarget } from "../compile/bindings";
import { collectScripts, type SceneScript } from "../compile/scripts";
import type { SceneJson } from "../compile/model";
import { ScriptApi } from "./api";
import { ScriptRuntime, type ScriptRealm, type ScriptTarget, type ScriptValue } from "./runtime";

class Vec2 {
  constructor(
    public x: number,
    public y: number,
  ) {}
}
class Vec3 {
  constructor(
    public x: number,
    public y: number,
    public z: number,
  ) {}
}

function realmWith(modules: Map<string, Record<string, unknown>>): ScriptRealm {
  return {
    global: { Object, Array },
    prototypes: { Vec2: Vec2.prototype, Vec3: Vec3.prototype, Vec4: {}, Mat3: {}, Mat4: {} },
    internal: { updateScriptProperties() {}, convertUserProperties: (json: string) => JSON.parse(json) },
    async importModule(_source: string, label: string) {
      return modules.get(label) ?? {};
    },
    dispose() {},
  };
}

const TEXT: ScriptTarget = { kind: "text", object: 3, field: "text" };

function script(id: string, overrides: Partial<SceneScript> = {}): SceneScript {
  return {
    id,
    source: "",
    target: TEXT,
    valueType: "string",
    initial: "Song Title",
    owner: { kind: "layer", object: 3 },
    layer: 3,
    scriptProperties: null,
    imports: [],
    errors: [],
    ...overrides,
  };
}

/** 运行时 + 记录写入的宿主替身：`stored` 是宿主状态（`read` 读它），`writes` 是每次写入（含重放）。 */
function harness(update: (value: unknown) => unknown, overrides: Partial<SceneScript> = {}) {
  const writes: { key: string; value: ScriptValue; source: string }[] = [];
  const stored = new Map<string, ScriptValue>();
  const keyOf = (target: ScriptTarget) =>
    target.kind === "text" ? `objects/${target.object}/${target.field}` : target.kind;
  const args: unknown[] = [];
  const logs: string[] = [];
  const runtime = new ScriptRuntime(
    realmWith(
      new Map([
        [
          "s",
          {
            update: (value: unknown) => {
              args.push(value);
              return update(value);
            },
          },
        ],
      ]),
    ),
    {
      report: {
        ready() {},
        fallback() {},
        debug() {},
        info() {},
        warn: (message: string) => void logs.push(message),
        error() {},
      },
      write(target, value, source) {
        writes.push({ key: keyOf(target), value, source });
        stored.set(keyOf(target), value);
        return true;
      },
      read: (target) => stored.get(keyOf(target)) ?? null,
    },
  );
  return { runtime, writes, stored, args, logs, load: () => runtime.load({ list: [script("s", overrides)] }) };
}

describe("ScriptRuntime：文本目标的字符串写回（P6b 1e）", () => {
  it("返回值按 ToString 写回：字符串原样、数字 / 布尔 / 对象转字符串，null / undefined 不写", async () => {
    const results: unknown[] = ["F1", 12, true, {}, null, undefined, "", { toString: () => "x" }];
    let i = 0;
    const h = harness(() => results[i++]);
    await h.load();
    for (let n = 0; n < results.length; n++) h.runtime.frame(1 / 60);
    expect(h.writes.map((write) => write.value)).toEqual(["F1", "12", "true", "[object Object]", "", "x"]);
    expect(h.writes.every((write) => write.key === "objects/3/text" && write.source === "s")).toBe(true);
    expect(h.logs).toEqual([]);
  });

  it("ToString 抛错的返回值不写，不禁用 update", async () => {
    const results: unknown[] = [Symbol("s"), Object.create(null), "ok"];
    let i = 0;
    const h = harness(() => results[i++]);
    await h.load();
    for (let n = 0; n < results.length; n++) h.runtime.frame(1 / 60);
    expect(h.writes.map((write) => write.value)).toEqual(["ok"]);
    expect((h.runtime.diagnostics as { disabled: string[] }[])[0].disabled).toEqual([]);
  });

  it("update(value) 收到字符串：没有状态时是初值（两个词也不是 Vec2），之后是读回的当前文字", async () => {
    let n = 0;
    const h = harness((value) => (n++ < 1 ? `F${n}` : value));
    await h.load();
    h.runtime.frame(1 / 60);
    h.runtime.frame(1 / 60);
    expect(h.args).toEqual(["Song Title", "F1"]);
    // 第二帧原样返回收到的值：写回同一个字符串
    expect(h.writes.map((write) => write.value)).toEqual(["F1", "F1"]);
  });

  it("重放表存字符串，重编译后原样重放；键与宿主 targetPath 相同（objects/<i>/<字段>），forgetWrite 能删", async () => {
    let n = 0;
    const h = harness(() => `F${++n}`);
    await h.load();
    h.runtime.frame(1 / 60);
    h.runtime.frame(1 / 60);
    h.writes.length = 0;
    h.runtime.replayWrites();
    expect(h.writes).toEqual([{ key: "objects/3/text", value: "F2", source: "script-replay" }]);
    h.runtime.forgetWrite("objects/3/text");
    h.writes.length = 0;
    h.runtime.replayWrites();
    expect(h.writes).toEqual([]);
  });

  it("别的目标初值猜成 string 的：照旧丢掉（材质常量没有 value）", async () => {
    const constant: BindingTarget = {
      kind: "constant",
      pass: "objects/0/passes/0",
      material: "x",
      uniforms: ["g_X"],
      type: "float",
    };
    const h = harness(() => "abc", { target: constant, initial: null });
    await h.load();
    h.runtime.frame(1 / 60);
    expect(h.writes).toEqual([]);
  });

  it("数字键（maxwidth，float）按原规则铺成分量", async () => {
    const h = harness(() => 300, { target: { kind: "text", object: 3, field: "maxwidth" }, valueType: "float" });
    await h.load();
    h.runtime.frame(1 / 60);
    expect(h.writes.map((write) => write.value)).toEqual([[300]]);
  });

  it('collectScripts 的结果直接跑：`"Song Title"` 初值的 text 脚本收到字符串、写回字符串', async () => {
    const scene = {
      general: {},
      objects: [{ id: 1, text: { script: "x", value: "Song Title" } }],
    } as unknown as SceneJson;
    const { list } = await collectScripts(scene, {}, []);
    const args: unknown[] = [];
    const writes: ScriptValue[] = [];
    const runtime = new ScriptRuntime(
      realmWith(new Map([["objects/0/text", { update: (value: unknown) => (args.push(value), `${String(value)}!`) }]])),
      {
        report: { ready() {}, fallback() {}, debug() {}, info() {}, warn() {}, error() {} },
        write: (_target, value) => (writes.push(value), true),
        read: () => null,
      },
    );
    await runtime.load({ list });
    runtime.frame(1 / 60);
    expect(args).toEqual(["Song Title"]);
    expect(writes).toEqual(["Song Title!"]);
  });
});

describe("ScriptApi.write：string 只给文本目标（P6b 1e）", () => {
  function api() {
    const writes: { target: BindingTarget | { kind: "unsupported"; path: string }; value: ScriptValue }[] = [];
    const instance = new ScriptApi(realmWith(new Map()), {
      bundle: () => ({ layers: [], scripts: { list: [] } }) as never,
      state: () => ({}) as never,
      screenResolution: () => [800, 600],
      frametime: () => 0.016,
      runtime: () => 1,
      timeOfDay: () => 0.5,
      write: (target, value) => (writes.push({ target, value }), true),
    });
    // 私有方法：步骤 2 的 `ITextLayer` 字段会经它写
    const write = (target: BindingTarget, raw: unknown, type: "string" | "float") =>
      (instance as unknown as { write(t: BindingTarget, r: unknown, ty: string): void }).write(target, raw, type);
    return { writes, write };
  }

  it("文本目标：ToString 后交给宿主，null / undefined / 抛错的不写", () => {
    const h = api();
    for (const raw of ["abc", 12, true, null, undefined, Symbol("s")]) h.write(TEXT as BindingTarget, raw, "string");
    expect(h.writes.map((write) => write.value)).toEqual(["abc", "12", "true"]);
  });

  it("别的目标收到 string 类型：不写", () => {
    const h = api();
    h.write({ kind: "layer", object: 0, field: "alpha" }, "abc", "string");
    expect(h.writes).toEqual([]);
    h.write({ kind: "layer", object: 0, field: "alpha" }, 0.5, "float");
    expect(h.writes.map((write) => write.value)).toEqual([[0.5]]);
  });
});
