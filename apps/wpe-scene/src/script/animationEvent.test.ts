/**
 * P10b 步骤 2：`ScriptRuntime.animationEvent`（关键帧动画的事件派发给脚本）。假 realm，同 `runtime.test.ts` 的写法。
 */
import { describe, expect, it } from "vitest";
import type { SceneScript } from "../compile/scripts";
import { ScriptRuntime, scriptObject, type ScriptRealm, type ScriptTarget } from "./runtime";

class Vec {
  constructor(..._values: number[]) {}
}

class FakeRealm implements ScriptRealm {
  /** `JSON.parse` 出的对象带 `realm` 标记，表示是 realm 里造的。 */
  global: Record<string, unknown> = {
    JSON: { parse: (text: string) => Object.assign(JSON.parse(text) as object, { realm: true }) },
  };
  prototypes = { Vec2: Vec.prototype, Vec3: Vec.prototype, Vec4: Vec.prototype, Mat3: {}, Mat4: {} };
  modules = new Map<string, Record<string, unknown> | Error>();
  internal = { updateScriptProperties() {}, convertUserProperties: () => ({}) };
  async importModule(_source: string, label: string): Promise<Record<string, unknown>> {
    const result = this.modules.get(label);
    if (result instanceof Error) throw result;
    return result ?? {};
  }
  dispose() {}
}

const script = (id: string, owner: SceneScript["owner"], field: string): SceneScript => ({
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
  const written: { source: string; value: unknown }[] = [];
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
    // 每段脚本的字段不同，读到的值也不同：`alpha` 0.25、`brightness` 0.5、`color` 0.75
    read: (target: ScriptTarget) => {
      const field = (target as { field?: string }).field;
      return field === "alpha" ? [0.25] : field === "brightness" ? [0.5] : [0.75];
    },
    write: (_target, value, source) => {
      written.push({ source, value });
      return true;
    },
  });
  return { realm, runtime, written, warnings };
}

const EVENT = JSON.stringify({ name: "beat", frame: 3 });

describe("ScriptRuntime.animationEvent（P10b）", () => {
  it("scriptObject：图层 / effect 取 object，材质取 layer，general 是 null", () => {
    expect(scriptObject({ kind: "layer", object: 3 })).toBe(3);
    expect(scriptObject({ kind: "effect", object: 4, effect: 1 })).toBe(4);
    expect(scriptObject({ kind: "material", pass: "objects/5/effects/0/passes/0", layer: 5 })).toBe(5);
    expect(scriptObject({ kind: "general" })).toBeNull();
  });

  it("只发给同一对象上的脚本（图层字段、effect、材质常量），按记录顺序；general 的事件发给 general 的脚本", async () => {
    const h = harness();
    const calls: string[] = [];
    const listener = (id: string) => ({ animationEvent: () => void calls.push(id) });
    for (const id of ["b", "a", "c", "d", "g"]) h.realm.modules.set(id, listener(id));
    await h.runtime.load({
      list: [
        script("b", { kind: "effect", object: 0, effect: 0 }, "alpha"),
        script("a", { kind: "layer", object: 0 }, "alpha"),
        script("c", { kind: "material", pass: "objects/0/effects/0/passes/0", layer: 0 }, "alpha"),
        script("d", { kind: "layer", object: 1 }, "alpha"),
        script("g", { kind: "general" }, "alpha"),
      ],
    });
    h.runtime.animationEvent(0, EVENT);
    expect(calls).toEqual(["b", "a", "c"]);
    calls.length = 0;
    h.runtime.animationEvent(1, EVENT);
    expect(calls).toEqual(["d"]);
    calls.length = 0;
    h.runtime.animationEvent(null, EVENT);
    expect(calls).toEqual(["g"]);
    calls.length = 0;
    h.runtime.animationEvent(7, EVENT);
    expect(calls).toEqual([]);
  });

  it("只发给 inited 且导出了函数的脚本：没导出、导出的不是函数、求值失败的都跳过", async () => {
    const h = harness();
    const calls: string[] = [];
    h.realm.modules.set("ok", { animationEvent: () => void calls.push("ok") });
    h.realm.modules.set("plain", { update: () => {} });
    h.realm.modules.set("notfn", { animationEvent: 5 });
    h.realm.modules.set("bad", new Error("求值失败"));
    const owner = { kind: "layer", object: 0 } as const;
    await h.runtime.load({
      list: ["bad", "plain", "notfn", "ok"].map((id) => script(id, owner, "alpha")),
    });
    h.runtime.animationEvent(0, EVENT);
    expect(calls).toEqual(["ok"]);
    // 加载前（没有记录）不抛
    expect(() => harness().runtime.animationEvent(0, EVENT)).not.toThrow();
  });

  it("参数是 realm 里解析的作者事件对象（每个接收者各一份）与接收者自己属性的当前值；返回值写回同 update", async () => {
    const h = harness();
    const seen: { id: string; event: unknown; value: unknown }[] = [];
    h.realm.modules.set("a", {
      animationEvent: (event: unknown, value: unknown) => {
        seen.push({ id: "a", event, value });
        (event as { frame: number }).frame = 99; // 改它不影响别的接收者
        return 0.75;
      },
    });
    h.realm.modules.set("c", {
      animationEvent: (event: unknown, value: unknown) => {
        seen.push({ id: "c", event, value });
        return undefined; // 没有返回值：不写
      },
    });
    const owner = { kind: "layer", object: 0 } as const;
    await h.runtime.load({ list: [script("a", owner, "alpha"), script("c", owner, "brightness")] });
    h.written.length = 0;
    h.runtime.animationEvent(0, EVENT);
    expect(seen.map((item) => item.id)).toEqual(["a", "c"]);
    expect(seen[0].event).toEqual({ name: "beat", frame: 99, realm: true });
    expect(seen[1].event).toEqual({ name: "beat", frame: 3, realm: true });
    expect(seen[0].event).not.toBe(seen[1].event);
    // 每个接收者收到的是自己属性的值（alpha 0.25、brightness 0.5）
    expect(seen.map((item) => item.value)).toEqual([0.25, 0.5]);
    expect(h.written).toEqual([{ source: "a", value: [0.75] }]);
  });

  it("抛错只禁用这一个回调：别的脚本照发，这段脚本的 update 仍然运行", async () => {
    const h = harness();
    const calls: string[] = [];
    h.realm.modules.set("a", {
      animationEvent: () => {
        calls.push("a:event");
        throw new Error("boom");
      },
      update: () => void calls.push("a:update"),
    });
    h.realm.modules.set("b", { animationEvent: () => void calls.push("b:event") });
    const owner = { kind: "layer", object: 0 } as const;
    await h.runtime.load({ list: [script("a", owner, "alpha"), script("b", owner, "brightness")] });
    h.runtime.animationEvent(0, EVENT);
    h.runtime.animationEvent(0, EVENT);
    expect(calls).toEqual(["a:event", "b:event", "b:event"]);
    expect(h.warnings.some((line) => line.includes("animationEvent") && line.includes("boom"))).toBe(true);
    h.runtime.frame(0.016);
    expect(calls.slice(3)).toEqual(["a:update"]);
    const a = h.runtime.diagnostics.find((item) => (item as { id: string }).id === "a") as {
      disabled: string[];
      errors: string[];
    };
    expect(a.disabled).toEqual(["animationEvent"]);
    expect(a.errors[0]).toContain("animationEvent: boom");
  });

  it("运行时停止（destroy）后不再发", async () => {
    const h = harness();
    const calls: string[] = [];
    h.realm.modules.set("a", {
      animationEvent: () => void calls.push("event"),
      destroy: () => void calls.push("destroy"),
    });
    await h.runtime.load({ list: [script("a", { kind: "layer", object: 0 }, "alpha")] });
    h.runtime.destroy();
    h.runtime.animationEvent(0, EVENT);
    expect(calls).toEqual(["destroy"]);
  });

  it("加载期间不发给还没跑完 init 的脚本（模块已求值也不发）：宿主在脚本加载期间照常跑帧", async () => {
    const h = harness();
    const calls: string[] = [];
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const importModule = h.realm.importModule.bind(h.realm);
    // 第二段的模块求值卡住：第一段这时是「已求值、init 还没跑」
    h.realm.importModule = async (source: string, label: string) => {
      if (label === "b") await gate;
      return importModule(source, label);
    };
    h.realm.modules.set("a", { animationEvent: () => void calls.push("a") });
    h.realm.modules.set("b", { animationEvent: () => void calls.push("b") });
    const owner = { kind: "layer", object: 0 } as const;
    const loading = h.runtime.load({ list: [script("a", owner, "alpha"), script("b", owner, "brightness")] });
    await new Promise((resolve) => setTimeout(resolve));
    h.runtime.animationEvent(0, EVENT);
    expect(calls).toEqual([]);
    open();
    await loading;
    h.runtime.animationEvent(0, EVENT);
    expect(calls).toEqual(["a", "b"]);
  });
});
