/**
 * P6c 步骤 1：`ScriptRuntime.cursorEvent`（光标回调派发给脚本）。假 realm，同 `animationEvent.test.ts` 的写法。
 */
import { describe, expect, it } from "vitest";
import type { SceneScript } from "../compile/scripts";
import { RUNTIME_CALLBACKS, ScriptRuntime, type ScriptRealm, type ScriptTarget } from "./runtime";

class Vec3 {
  constructor(
    public x: number,
    public y: number,
    public z: number,
  ) {}
}

class FakeRealm implements ScriptRealm {
  global: Record<string, unknown> = { Object };
  prototypes = { Vec2: Vec3.prototype, Vec3: Vec3.prototype, Vec4: Vec3.prototype, Mat3: {}, Mat4: {} };
  modules = new Map<string, Record<string, unknown> | Error>();
  internal = { updateScriptProperties() {}, convertUserProperties: () => ({}) };
  async importModule(_source: string, label: string): Promise<Record<string, unknown>> {
    const result = this.modules.get(label);
    if (result instanceof Error) throw result;
    return result ?? {};
  }
  dispose() {}
}

const script = (id: string, owner: SceneScript["owner"], field = "alpha"): SceneScript => ({
  id,
  source: "",
  target: { kind: "layer", object: 0, field } as SceneScript["target"],
  valueType: "float",
  initial: 1,
  owner,
  layer: owner.kind === "general" ? null : owner.kind === "material" ? owner.layer : owner.object,
  scriptProperties: null,
  imports: [],
  errors: [],
});

function harness() {
  const realm = new FakeRealm();
  const written: unknown[] = [];
  const warnings: string[] = [];
  const runtime = new ScriptRuntime(realm, {
    report: {
      ready() {},
      fallback() {},
      debug() {},
      info() {},
      warn: (message: string) => void warnings.push(message),
      error: (message: string) => void warnings.push(message),
    },
    read: (_target: ScriptTarget) => [0.5],
    write: (_target, value) => {
      written.push(value);
      return true;
    },
  });
  return { realm, runtime, written, warnings };
}

const WORLD = [450, 799.5001220703125, 0];
const LOCAL = [100, 100.49987030029297, 0];

describe("ScriptRuntime.cursorEvent（P6c）", () => {
  it("光标回调进运行时的回调表（cursorHitTest 也登记，但从不派发）", () => {
    for (const name of [
      "cursorHitTest",
      "cursorEnter",
      "cursorLeave",
      "cursorMove",
      "cursorClick",
      "cursorDown",
      "cursorUp",
    ])
      expect((RUNTIME_CALLBACKS as readonly string[]).includes(name), name).toBe(true);
  });

  it("只发给同一对象上的脚本（图层字段、effect、材质常量），按记录顺序；别的对象和 general 的脚本收不到", async () => {
    const h = harness();
    const calls: string[] = [];
    const listener = (id: string) => ({ cursorMove: () => void calls.push(id) });
    for (const id of ["b", "a", "c", "d", "g"]) h.realm.modules.set(id, listener(id));
    await h.runtime.load({
      list: [
        script("b", { kind: "effect", object: 0, effect: 0 }),
        script("a", { kind: "layer", object: 0 }),
        script("c", { kind: "material", pass: "objects/0/effects/0/passes/0", layer: 0 }),
        script("d", { kind: "layer", object: 1 }),
        script("g", { kind: "general" }),
      ],
    });
    h.runtime.cursorEvent(0, "cursorMove", WORLD, LOCAL);
    expect(calls).toEqual(["b", "a", "c"]);
    calls.length = 0;
    h.runtime.cursorEvent(1, "cursorMove", WORLD, LOCAL);
    expect(calls).toEqual(["d"]);
    calls.length = 0;
    h.runtime.cursorEvent(9, "cursorMove", WORLD, LOCAL);
    expect(calls).toEqual([]);
  });

  it("只发给导出了这个回调、已 init 的脚本：没导出、导出的不是函数、求值失败的跳过；一个对象上每个字段各一段都调", async () => {
    const h = harness();
    const calls: string[] = [];
    h.realm.modules.set("origin", { cursorDown: () => void calls.push("origin") });
    h.realm.modules.set("scale", {
      cursorDown: () => void calls.push("scale"),
      cursorUp: () => void calls.push("scale-up"),
    });
    h.realm.modules.set("plain", { update: () => {} });
    h.realm.modules.set("notfn", { cursorDown: 5 });
    h.realm.modules.set("bad", new Error("求值失败"));
    const owner = { kind: "layer", object: 0 } as const;
    await h.runtime.load({
      list: ["bad", "plain", "notfn", "origin", "scale"].map((id) => script(id, owner)),
    });
    h.runtime.cursorEvent(0, "cursorDown", WORLD, LOCAL);
    expect(calls).toEqual(["origin", "scale"]);
    h.runtime.cursorEvent(0, "cursorUp", WORLD, LOCAL);
    expect(calls).toEqual(["origin", "scale", "scale-up"]);
    // 加载前（没有记录）不抛
    expect(() => harness().runtime.cursorEvent(0, "cursorDown", WORLD, LOCAL)).not.toThrow();
  });

  it("事件对象：每个接收者各建一个 { button: 0, worldPosition, localPosition }，向量是 realm 的 Vec3（float32），没有 hitBox / screenPosition", async () => {
    const h = harness();
    const seen: Record<string, unknown>[] = [];
    h.realm.modules.set("one", { cursorEnter: (event: Record<string, unknown>) => void seen.push(event) });
    h.realm.modules.set("two", {
      cursorEnter: (event: Record<string, unknown>) => {
        seen.push(event);
        // 改第一个接收者拿到的事件不影响自己这个
      },
    });
    const owner = { kind: "layer", object: 0 } as const;
    await h.runtime.load({ list: [script("one", owner), script("two", owner, "origin")] });
    h.runtime.cursorEvent(0, "cursorEnter", [100.1, 200.2, 0], [1.5, 2.5, 0]);
    expect(seen).toHaveLength(2);
    const [first, second] = seen;
    expect(Object.keys(first)).toEqual(["button", "worldPosition", "localPosition"]);
    expect(first.button).toBe(0);
    expect(first.worldPosition).toBeInstanceOf(Vec3);
    expect(first.localPosition).toBeInstanceOf(Vec3);
    expect(first.worldPosition).toEqual(new Vec3(Math.fround(100.1), Math.fround(200.2), 0));
    expect(first.localPosition).toEqual(new Vec3(1.5, 2.5, 0));
    expect("hitBox" in first).toBe(false);
    expect("screenPosition" in first).toBe(false);
    // 每个接收者各一个新对象
    expect(second).not.toBe(first);
    expect(second.worldPosition).not.toBe(first.worldPosition);
    (first.worldPosition as Vec3).x = 12345;
    expect((second.worldPosition as Vec3).x).toBe(Math.fround(100.1));
  });

  it("返回值丢弃（WPE 只写回 init / update / animationEvent）：回调返回数字也不写回字段", async () => {
    const h = harness();
    h.realm.modules.set("r", { cursorClick: () => 0.9 });
    await h.runtime.load({ list: [script("r", { kind: "layer", object: 0 })] });
    h.written.length = 0;
    h.runtime.cursorEvent(0, "cursorClick", WORLD, LOCAL);
    expect(h.written).toEqual([]);
  });

  it("回调抛错只禁用这个回调：同一脚本的别的回调、别的脚本的同名回调照常", async () => {
    const h = harness();
    const calls: string[] = [];
    h.realm.modules.set("bad", {
      cursorClick: () => {
        calls.push("bad-click");
        throw new Error("boom");
      },
      cursorMove: () => void calls.push("bad-move"),
    });
    h.realm.modules.set("good", { cursorClick: () => void calls.push("good-click") });
    const owner = { kind: "layer", object: 0 } as const;
    await h.runtime.load({ list: [script("bad", owner), script("good", owner, "origin")] });
    h.runtime.cursorEvent(0, "cursorClick", WORLD, LOCAL);
    h.runtime.cursorEvent(0, "cursorClick", WORLD, LOCAL);
    h.runtime.cursorEvent(0, "cursorMove", WORLD, LOCAL);
    expect(calls).toEqual(["bad-click", "good-click", "good-click", "bad-move"]);
    expect(h.warnings.some((line) => line.includes("cursorClick") && line.includes("boom"))).toBe(true);
  });

  it("hasCursorCallbacks：有脚本导出了任一光标回调（含 cursorHitTest）才为真；只导出 update 的、求值失败的不算", async () => {
    const plain = harness();
    plain.realm.modules.set("a", { update: () => {} });
    plain.realm.modules.set("bad", new Error("x"));
    await plain.runtime.load({
      list: [script("a", { kind: "layer", object: 0 }), script("bad", { kind: "layer", object: 0 }, "origin")],
    });
    expect(plain.runtime.hasCursorCallbacks).toBe(false);
    const hit = harness();
    // cursorHitTest 只打开拾取，从不派发
    let called = false;
    hit.realm.modules.set("a", { cursorHitTest: () => void (called = true) });
    await hit.runtime.load({ list: [script("a", { kind: "layer", object: 0 })] });
    expect(hit.runtime.hasCursorCallbacks).toBe(true);
    hit.runtime.cursorEvent(0, "cursorEnter", WORLD, LOCAL);
    expect(called).toBe(false);
  });
});
